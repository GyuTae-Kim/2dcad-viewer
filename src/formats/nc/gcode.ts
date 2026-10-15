/**
 * G-code(ISO 6983 / RS-274 계열) 해석기 — 블록을 읽고 모달 상태 기계로 실행해 이동 목록을 만든다.
 *
 * 블록 읽기: N 번호, 주석 `( )`·`;`, 블록 건너뛰기 `/`, `%`, 대소문자, 공백 없는 꼴(`G01X10Y5`).
 * 흔한 줄은 바이트에서 바로 읽고(빠른 길), `#`·`[`·`=`·낱말(IF·WHILE·GOTO·o-코드)이 있는 줄만 글로 바꿔 읽는다.
 *
 * 지원: G0 G1 G2 G3(IJK·R·나선·완전한 원·LinuxCNC P 바퀴 수) G4 G10(L2/L20 좌표계 값) G17 G18 G19 G20 G21
 * G28 G30 G40 G41 G42 G43 G44 G49 G52 G53 G54~G59(G54.1 P·G59.1~3) G61 G64 G73 G74 G76 G80~G89 G90 G91
 * G90.1 G91.1 G92(.1/.2) G93 G94 G95 G98 G99, T M6 M3 M4 M5 M7 M8 M9 M0 M1 M2 M30 M98 M99 M97 G65,
 * 변수(#n, #[식], #<이름>)·식, Fanuc IF/GOTO/WHILE/DO/END, LinuxCNC o-코드(sub/call/if/while/do/repeat).
 * 좌표계 오프셋 값은 프로그램 안 G10이나 선택 사항으로 주어진 것만 알고, 모르면 0으로 본다(경고).
 */
import { ExprError, GExpr, type GVarRef } from './expr';
import { NcEmitter } from './emitter';
import { FLAG_CYCLE, FLAG_MACHINE, MOVE_DRILL, MOVE_FEED, MOVE_RAPID, PLANE_AXES, type NcDialect, type NcPlane, type NcProgram } from './model';
import { decodeRange, lineRange, makeSource, sourceLine, type NcSource } from './text';

export interface GcodeOptions {
  /** 프로그램 이름(보통 파일 이름) */
  name?: string;
  /** 방언(기본 'auto' — 글에서 판별) */
  dialect?: NcDialect | 'auto';
  /** 단위 코드(G20/G21)가 없을 때의 단위(기본 mm) */
  units?: 'mm' | 'inch';
  /** 급속 속도(표시 단위/분, 기본 mm 10000 · inch 400) — 시간 계산용 */
  rapidFeed?: number;
  /** '/' 블록을 건너뛸지(기본 false: 블록 건너뛰기 스위치 꺼짐 = 실행) */
  blockDelete?: boolean;
  /** 이동 수 한도(기본 800만) */
  maxMoves?: number;
  /** 실행 블록 수 한도(기본 max(줄 수 × 20, 500만)) — 끝없는 반복 막기 */
  maxBlocks?: number;
  /** 시작 위치(주면 첫 이동부터 그린다. 없으면 처음 지정되는 좌표부터) */
  initialPosition?: [number, number, number];
  /** G28·G30 기준점(표시 좌표). 없으면 중간점에서 멈춘 것으로 본다 */
  homePosition?: [number, number, number];
  /** IJK를 절대값으로 볼지(G90.1 기본, 일부 Mach3 설정) */
  arcCenterAbsolute?: boolean;
  /** 작업 좌표계 오프셋(기계 좌표, 표시 단위). 키: 'G54'…'G59', 'G54.1P1'… */
  workOffsets?: Record<string, [number, number, number]>;
  /** G83 되돌아 들어갈 때 남기는 틈·G73 물러나는 양(표시 단위, 기본 mm 0.5 · inch 0.02) */
  peckClearance?: number;
}

// ───────────────────────── 블록 ─────────────────────────

const A = 65;
const LX = 23,
  LY = 24,
  LZ = 25,
  LI = 8,
  LJ = 9,
  LK = 10,
  LR = 17,
  LP = 15,
  LQ = 16,
  LL = 11,
  LF = 5,
  LS = 18,
  LT = 19,
  LO = 14,
  LN = 13;
const AXIS_LETTER = [LX, LY, LZ];
const OFFSET_LETTER = [LI, LJ, LK];

type Ctrl =
  | { k: 'goto'; n: number }
  | { k: 'while'; ok: boolean; m: number }
  | { k: 'end'; m: number }
  | { k: 'do'; m: number }
  | { k: 'o'; label: string; kw: string; val: number | undefined; args: number[] };

class Block {
  has = new Uint8Array(26);
  val = new Float64Array(26);
  dot = new Uint8Array(26);
  g = new Int32Array(24);
  gCount = 0;
  m = new Int32Array(12);
  mCount = 0;
  comments: string[] = [];
  blockDelete = false;
  percent = false;
  words = 0;
  assigns: [GVarRef, number | undefined][] = [];
  ctrl: Ctrl | null = null;
  /** 낱말이 아닌 것만 있는 줄(빈 줄·주석) */
  reset(): void {
    this.has.fill(0);
    this.gCount = 0;
    this.mCount = 0;
    if (this.comments.length) this.comments = [];
    this.blockDelete = false;
    this.percent = false;
    this.words = 0;
    if (this.assigns.length) this.assigns = [];
    this.ctrl = null;
  }
  set(letter: number, v: number, dot: boolean): void {
    if (letter === 6) {
      if (this.gCount < this.g.length) this.g[this.gCount++] = Math.round(v * 10);
    } else if (letter === 12) {
      if (this.mCount < this.m.length) this.m[this.mCount++] = Math.round(v);
    } else {
      this.has[letter] = 1;
      this.val[letter] = v;
      this.dot[letter] = dot ? 1 : 0;
    }
    this.words++;
  }
  hasG(code: number): boolean {
    for (let i = 0; i < this.gCount; i++) if (this.g[i] === code) return true;
    return false;
  }
  hasM(code: number): boolean {
    for (let i = 0; i < this.mCount; i++) if (this.m[i] === code) return true;
    return false;
  }
}

const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/**
 * 빠른 길: 바이트에서 바로 낱말을 읽는다. 식·변수·낱말 연산이 있으면 false(글로 다시 읽는다).
 * 주석 글은 cb로 돌려준다.
 */
function parseFast(b: Uint8Array, s: number, e: number, blk: Block, onComment: (cs: number, ce: number) => void): boolean {
  let i = s;
  while (i < e && (b[i] === 32 || b[i] === 9)) i++;
  if (i < e && b[i] === 47) {
    // 블록 건너뛰기 / (Fanuc /1~/9 스위치 번호 포함)
    blk.blockDelete = true;
    i++;
    if (i < e && b[i]! >= 49 && b[i]! <= 57) i++;
  }
  if (i < e && b[i] === 37) {
    // '%' 줄
    let j = i + 1;
    while (j < e && (b[j] === 32 || b[j] === 9)) j++;
    if (j >= e || b[j] === 40 || b[j] === 59) {
      blk.percent = true;
      return true;
    }
  }
  while (i < e) {
    let c = b[i]!;
    if (c === 32 || c === 9 || c === 13) {
      i++;
      continue;
    }
    if (c === 40) {
      // ( 주석 ) — 안에 괄호가 있어도 짝을 맞춘다
      let j = i + 1;
      let depth = 1;
      while (j < e) {
        if (b[j] === 40) depth++;
        else if (b[j] === 41 && --depth === 0) break;
        j++;
      }
      onComment(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === 59) {
      onComment(i + 1, e);
      return true;
    }
    if (c >= 97 && c <= 122) c -= 32;
    else if (c === 58) c = 79; // ':' 프로그램 번호 = O
    if (c < 65 || c > 90) {
      if (c === 37) return true; // 줄 끝의 %
      return false;
    }
    const letter = c - A;
    i++;
    while (i < e && (b[i] === 32 || b[i] === 9)) i++;
    // 수
    let neg = false;
    let d = b[i];
    if (d === 45 || d === 43) {
      neg = d === 45;
      i++;
      while (i < e && (b[i] === 32 || b[i] === 9)) i++;
      d = b[i];
    }
    const n0 = i;
    let mant = 0;
    let digits = 0;
    let dec = -1;
    while (i < e) {
      d = b[i]!;
      if (d >= 48 && d <= 57) {
        mant = mant * 10 + (d - 48);
        digits++;
        if (dec >= 0) dec++;
        i++;
      } else if (d === 46 && dec < 0) {
        dec = 0;
        i++;
      } else break;
    }
    if (digits === 0) return false; // 글자 뒤에 수가 없다(낱말·식)
    let v: number;
    if (digits > 15) v = parseFloat(String.fromCharCode(...b.subarray(n0, Math.min(i, n0 + 64))));
    else v = dec > 0 ? mant / POW10[dec]! : mant;
    blk.set(letter, neg ? -v : v, dec >= 0);
  }
  return true;
}

/** 느린 길에서 쓰는 변수 저장소 연결 */
interface SlowEnv {
  get(ref: GVarRef): number | undefined;
}

const O_KEYWORDS = ['ENDSUB', 'SUB', 'CALL', 'RETURN', 'ELSEIF', 'ELSE', 'ENDIF', 'IF', 'ENDWHILE', 'WHILE', 'DO', 'ENDREPEAT', 'REPEAT', 'BREAK', 'CONTINUE'];

/** 주석을 떼고 대문자·공백 없는 글로 */
function splitComments(text: string, comments: string[] | null): string {
  let code = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '(') {
      let j = i + 1;
      let depth = 1;
      while (j < n) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) break;
        j++;
      }
      if (comments) comments.push(text.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === ';') {
      if (comments) comments.push(text.slice(i + 1));
      break;
    }
    if (c !== ' ' && c !== '\t' && c !== '\r') code += c;
    i++;
  }
  return code.toUpperCase();
}

/**
 * 느린 길: 식·변수·제어 낱말이 있는 줄. 식은 읽을 때 바로 계산한다(반복마다 다시 읽는다).
 * 실패하면 ExprError.
 */
function parseSlow(text: string, blk: Block, env: SlowEnv): void {
  let code = splitComments(text, blk.comments);
  if (code.startsWith('/')) {
    blk.blockDelete = true;
    code = code.slice(/^\/[1-9]/.test(code) ? 2 : 1);
  }
  if (code.startsWith(':')) code = 'O' + code.slice(1);
  // GRBL 설정·명령($H, $X, $J=…)은 이동이 아니다
  if (code.startsWith('$')) return;
  if (code === '%' || code === '') {
    if (code === '%') blk.percent = true;
    return;
  }
  const ex = new GExpr(code, 0, env);
  const s = code;
  // N 번호
  if (s[0] === 'N' && /[0-9]/.test(s[1] ?? '')) {
    ex.pos = 1;
    blk.set(LN, ex.number(), false);
  }
  // o-코드(LinuxCNC)·프로그램 번호
  if (s[ex.pos] === 'O' && /[0-9<]/.test(s[ex.pos + 1] ?? '')) {
    const p0 = ex.pos + 1;
    let label: string;
    let p = p0;
    if (s[p] === '<') {
      const e = s.indexOf('>', p);
      if (e < 0) throw new ExprError('> 없음');
      label = s.slice(p + 1, e).toLowerCase();
      p = e + 1;
    } else {
      while (p < s.length && /[0-9]/.test(s[p]!)) p++;
      label = String(parseInt(s.slice(p0, p), 10));
    }
    const kw = O_KEYWORDS.find((k) => s.startsWith(k, p));
    if (!kw) {
      if (p >= s.length && /^[0-9]+$/.test(label)) {
        blk.set(LO, +label, false);
        return;
      }
      throw new ExprError(`알 수 없는 o-코드 '${s.slice(p, p + 10)}'`);
    }
    p += kw.length;
    ex.pos = p;
    let val: number | undefined;
    const args: number[] = [];
    if (kw === 'CALL') {
      while (s[ex.pos] === '[') {
        ex.pos++;
        args.push(ex.expr());
        if (s[ex.pos] !== ']') throw new ExprError('] 없음');
        ex.pos++;
      }
    } else if (s[ex.pos] === '[') {
      ex.pos++;
      val = ex.expr();
      if (s[ex.pos] !== ']') throw new ExprError('] 없음');
      ex.pos++;
    }
    blk.ctrl = { k: 'o', label, kw, val, args };
    return;
  }
  const assign = (): void => {
    // ex.pos는 '#' 다음
    const ref = ex.varRef();
    if (s[ex.pos] !== '=') throw new ExprError('= 없음');
    ex.pos++;
    let v: number | undefined;
    if (/^#0(?![0-9])/.test(s.slice(ex.pos, ex.pos + 3))) ex.pos += 2;
    else v = ex.expr();
    blk.assigns.push([ref, v]);
  };
  while (ex.pos < s.length) {
    const c = s[ex.pos]!;
    if (c === '#') {
      ex.pos++;
      assign();
      continue;
    }
    if (s.startsWith('IF', ex.pos) && s[ex.pos + 2] === '[') {
      ex.pos += 3;
      const cond = ex.expr();
      if (s[ex.pos] !== ']') throw new ExprError('] 없음');
      ex.pos++;
      if (s.startsWith('GOTO', ex.pos)) {
        ex.pos += 4;
        const n = ex.unary() ?? 0;
        if (cond !== 0) blk.ctrl = { k: 'goto', n: Math.round(n) };
        return;
      }
      if (s.startsWith('THEN', ex.pos)) {
        ex.pos += 4;
        const before = blk.assigns.length;
        while (s[ex.pos] === '#') {
          ex.pos++;
          assign();
        }
        if (cond === 0) blk.assigns.length = before;
        return;
      }
      throw new ExprError('IF 뒤에 GOTO·THEN 없음');
    }
    if (s.startsWith('WHILE', ex.pos) && s[ex.pos + 5] === '[') {
      ex.pos += 6;
      const cond = ex.expr();
      if (s[ex.pos] !== ']') throw new ExprError('] 없음');
      ex.pos++;
      if (!s.startsWith('DO', ex.pos)) throw new ExprError('WHILE 뒤에 DO 없음');
      ex.pos += 2;
      blk.ctrl = { k: 'while', ok: cond !== 0, m: Math.round(ex.number()) };
      return;
    }
    if (s.startsWith('GOTO', ex.pos)) {
      ex.pos += 4;
      blk.ctrl = { k: 'goto', n: Math.round(ex.unary() ?? 0) };
      return;
    }
    if (s.startsWith('END', ex.pos) && /[0-9]/.test(s[ex.pos + 3] ?? '')) {
      ex.pos += 3;
      blk.ctrl = { k: 'end', m: Math.round(ex.number()) };
      return;
    }
    if (s.startsWith('DO', ex.pos) && /[0-9]/.test(s[ex.pos + 2] ?? '')) {
      ex.pos += 2;
      blk.ctrl = { k: 'do', m: Math.round(ex.number()) };
      return;
    }
    if (c >= 'A' && c <= 'Z') {
      ex.pos++;
      // Siemens 꼴 X=식
      let v: number | undefined;
      if (s[ex.pos] === '=') {
        ex.pos++;
        v = ex.expr();
      } else v = ex.unary();
      if (v !== undefined) blk.set(c.charCodeAt(0) - A, v, true);
      continue;
    }
    if (c === '%') return;
    throw new ExprError(`알 수 없는 글자 '${c}'`);
  }
}

// ───────────────────────── 방언 판별 ─────────────────────────

/** 글 앞부분으로 방언을 판별한다 */
export function detectGcodeDialect(head: string): NcDialect {
  if (/^\s*\d*\s*BEGIN\s+PGM\b/im.test(head) || /^\s*\d+\s+(?:L|CC|CR|CT|LP|CP|TOOL\s+CALL|CYCL\s+DEF|BLK\s+FORM)\b[^\n]*$/m.test(head))
    return 'heidenhain';
  if (/^\s*o(?:\d+|<[^>]+>)\s*(?:sub|call|if|while|do|repeat)\b/im.test(head) || /#<[_a-z]/i.test(head) || /linuxcnc|\bemc2?\b/i.test(head))
    return 'linuxcnc';
  if (/\bgrbl\b/i.test(head) || /^\s*\$[A-Z0-9$#]/m.test(head)) return 'grbl';
  if (/\bmach\s*[34]\b/i.test(head)) return 'mach3';
  if (/^\s*[O:]\d{1,8}\b/m.test(head) || /\b(?:G65|WHILE\s*\[|IF\s*\[|GOTO\s*\d)/i.test(head) || /#[1-9]\d{2,3}\s*=/.test(head) || /\bfanuc\b/i.test(head))
    return 'fanuc';
  return 'iso';
}

// ───────────────────────── 실행 ─────────────────────────

interface Frame {
  kind: 'main' | 'm98' | 'g65' | 'ocall' | 'm97';
  ret: number;
  start: number;
  reps: number;
  locals: Map<number, number> | null;
  named: Map<string, number> | null;
  label?: string;
}

const MAX_CALL_DEPTH = 64;

/** 앞쪽 줄에서 처음 나오는 G20/G21로 표시 단위를 정한다(true = inch) */
function prescanUnits(src: NcSource): boolean | undefined {
  const b = new Block();
  const n = Math.min(src.lineCount, 5000);
  for (let i = 0; i < n; i++) {
    b.reset();
    const [s, e] = lineRange(src, i);
    if (!parseFast(src.bytes, s, e, b, () => {})) continue;
    for (let k = 0; k < b.gCount; k++) {
      const g = b.g[k];
      if (g === 200) return true;
      if (g === 210) return false;
    }
  }
  return undefined;
}

class Runner extends NcEmitter {
  private blk = new Block();
  private dialect: NcDialect;
  private o: GcodeOptions;

  // 상태
  private motion = 0; // ×10: 0, 10, 20, 30
  private cycle = 0; // ×10: 0 = 없음, 810…
  private cycleFresh = true;
  private initLevel = 0;
  private cz: number | undefined;
  private cr: number | undefined;
  private cq = 0;
  private cp = 0;
  private plane: NcPlane = 0;
  private blockInch = false;
  private scale = 1;
  private absolute = true;
  private arcAbs = false;
  private retractR = false;
  private selTool = -1;
  private seenM6 = false;
  private baseWcs = -1;
  private wcsOff = new Map<number, [number, number, number]>();
  private wcsKnown = new Set<number>();
  private g92 = [0, 0, 0];
  private g52 = [0, 0, 0];
  private off = [0, 0, 0];
  private stored28: [number, number, number] | null = null;
  private stored30: [number, number, number] | null = null;
  private peck: number;

  // 프로그램 흐름
  private pc = 0;
  private ended = false;
  private started = false;
  private stack: Frame[] = [];
  private globals = new Map<number, number>();
  private namedGlobals = new Map<string, number>();
  private loops: { m: number; line: number }[] = [];
  private oIndex: Map<number, number> | null = null;
  private nIndex: Map<number, number[]> | null = null;
  private oCodes: Map<string, { line: number; kw: string }[]> | null = null;
  private ifTaken = new Map<string, boolean>();
  private repeatLeft = new Map<string, number>();
  private blocks = 0;
  private maxBlocks: number;
  private maxMoves: number;
  private hitLimit = false;

  constructor(src: NcSource, opts: GcodeOptions, dialect: NcDialect) {
    super(src, opts.initialPosition);
    this.o = opts;
    this.dialect = dialect;
    const pre = prescanUnits(src);
    this.displayInch = pre ?? opts.units === 'inch';
    if (pre === undefined && src.lineCount > 0) this.w.add(`단위 코드(G20/G21)가 없어 ${this.displayInch ? 'inch' : 'mm'}로 봄`);
    this.blockInch = this.displayInch;
    this.tol = this.displayInch ? 0.0001 : 0.002;
    this.rapidFeed = opts.rapidFeed ?? (this.displayInch ? 400 : 10000);
    this.peck = opts.peckClearance ?? (this.displayInch ? 0.02 : 0.5);
    this.arcAbs = !!opts.arcCenterAbsolute;
    this.maxMoves = opts.maxMoves ?? 8_000_000;
    this.maxBlocks = opts.maxBlocks ?? Math.max(src.lineCount * 20, 5_000_000);
    if (opts.workOffsets)
      for (const [k, v] of Object.entries(opts.workOffsets)) {
        const idx = wcsIndexFromName(k);
        if (idx >= 0) {
          this.wcsOff.set(idx, [v[0], v[1], v[2]]);
          this.wcsKnown.add(idx);
        }
      }
    this.stack.push({ kind: 'main', ret: -1, start: 0, reps: 1, locals: new Map(), named: new Map() });
  }

  run(): void {
    const src = this.src;
    const blk = this.blk;
    const bytes = src.bytes;
    const cm: number[] = [];
    const onComment = (cs: number, ce: number): void => {
      cm.push(cs, ce);
    };
    while (!this.ended && this.pc < src.lineCount) {
      const line = this.pc++;
      if (++this.blocks > this.maxBlocks) {
        this.w.add(`실행 블록이 ${this.maxBlocks}개를 넘어 멈춤(끝없는 반복일 수 있음)`, line);
        this.hitLimit = true;
        break;
      }
      blk.reset();
      cm.length = 0;
      const [s, e] = lineRange(src, line);
      if (s === e) continue;
      let ok = parseFast(bytes, s, e, blk, onComment);
      if (ok) for (let k = 0; k < cm.length; k += 2) blk.comments.push(decodeRange(src, cm[k]!, cm[k + 1]!));
      if (!ok) {
        blk.reset();
        try {
          parseSlow(decodeRange(src, s, e), blk, this);
          ok = true;
        } catch (err) {
          if (!(err instanceof ExprError)) throw err;
          this.w.add(`읽을 수 없는 블록 — ${err.message}`, line);
          continue;
        }
      }
      if (blk.blockDelete && this.o.blockDelete) continue;
      this.exec(blk, line);
      if (this.mb.count >= this.maxMoves) {
        this.w.add(`이동이 ${this.maxMoves}개를 넘어 나머지는 읽지 않음`, line);
        this.hitLimit = true;
        break;
      }
    }
  }

  // ── 변수 ──
  get(ref: GVarRef): number | undefined {
    const f = this.stack[this.stack.length - 1]!;
    if (typeof ref === 'string') {
      if (ref.startsWith('_')) return this.namedGlobals.get(ref);
      return f.named?.get(ref) ?? this.namedGlobals.get(ref);
    }
    if (ref === 0) return undefined;
    if (ref >= 1 && ref <= 33) return f.locals?.get(ref);
    if (ref >= 5001 && ref <= 5003) return this.progCoord(ref - 5001);
    if (ref >= 5021 && ref <= 5023) return this.pos[ref - 5021];
    if (ref >= 5041 && ref <= 5043) return this.progCoord(ref - 5041);
    if (ref === 4001) return this.cycle ? this.cycle / 10 : this.motion / 10;
    if (ref === 4003) return this.absolute ? 90 : 91;
    if (ref === 4006) return this.blockInch ? 20 : 21;
    if (ref === 4120) return this.tool;
    if (ref === 5400 || ref === 4014) return 54 + this.wcs;
    return this.globals.get(ref);
  }
  private setVar(ref: GVarRef, v: number | undefined): void {
    const f = this.stack[this.stack.length - 1]!;
    if (typeof ref === 'string') {
      const m = ref.startsWith('_') ? this.namedGlobals : (f.named ??= new Map());
      if (v === undefined) m.delete(ref);
      else m.set(ref, v);
      return;
    }
    if (ref <= 0) return;
    const m = ref <= 33 ? (f.locals ??= new Map()) : this.globals;
    if (v === undefined) m.delete(ref);
    else m.set(ref, v);
  }

  private progCoord(a: number): number {
    return (this.pos[a]! - this.off[a]!) / this.scale;
  }

  // ── 좌표 ──
  private updateScale(): void {
    this.scale = this.blockInch === this.displayInch ? 1 : this.blockInch ? 25.4 : 1 / 25.4;
  }
  private updateOff(): void {
    const w = this.wcsOff.get(this.wcs) ?? [0, 0, 0];
    const b = this.wcsOff.get(this.baseWcs < 0 ? this.wcs : this.baseWcs) ?? [0, 0, 0];
    for (let a = 0; a < 3; a++) this.off[a] = w[a]! - b[a]! + this.g92[a]! + this.g52[a]!;
  }

  /** 낱말 값을 표시 좌표로(절대·증분, G53) */
  private target(blk: Block, a: number, machine: boolean, inc = !this.absolute): number {
    const L = AXIS_LETTER[a]!;
    if (!blk.has[L]) return this.pos[a]!;
    const v = blk.val[L]! * this.scale;
    if (machine) {
      const b = this.wcsOff.get(this.baseWcs < 0 ? this.wcs : this.baseWcs);
      return v - (b ? b[a]! : 0);
    }
    return inc ? this.pos[a]! + v : v + this.off[a]!;
  }

  /** P 낱말을 초로(Fanuc·ISO: 소수점 없는 P는 ms) */
  private dwellSeconds(blk: Block, letter: number): number {
    const v = blk.val[letter]!;
    if (letter === LX) return v;
    if ((this.dialect === 'fanuc' || this.dialect === 'iso') && !blk.dot[letter]) return v / 1000;
    return v;
  }

  // ── 블록 실행 ──
  private exec(blk: Block, line: number): void {
    if (blk.percent) {
      if (this.started) this.ended = true;
      return;
    }
    if (blk.comments.length) this.onComments(blk, line);
    if (blk.ctrl) {
      for (const [r, v] of blk.assigns) this.setVar(r, v);
      this.control(blk.ctrl, line);
      return;
    }
    if (blk.words === 0) {
      for (const [r, v] of blk.assigns) this.setVar(r, v);
      return;
    }
    // 프로그램 번호만 있는 줄
    if (blk.has[LO] && blk.words === 1) {
      if (!this.started && !this.name) this.name = `O${Math.round(blk.val[LO]!)}`;
      return;
    }
    this.started = true;
    if (blk.hasG(650)) {
      // G65 블록의 낱말은 모두 인수(이송·공구로 보지 않는다)
      this.endBlock(blk, line, true);
      return this.macroCall(blk, line);
    }

    let motionG = -1;
    let cycleG = -1;
    let nonModal = -1;
    let machine = false;
    for (let k = 0; k < blk.gCount; k++) {
      const g = blk.g[k]!;
      switch (g) {
        case 0:
        case 10:
        case 20:
        case 30:
          motionG = g;
          break;
        case 50:
        case 51:
        case 52:
          // 좌표가 있으면 LinuxCNC 스플라인(끝점까지 직선으로), 없으면 Fanuc 고속·AI 모드 켜기(무시)
          if (blk.has[LX] || blk.has[LY] || blk.has[LZ]) {
            this.w.add(`G${(g / 10).toFixed(g % 10 ? 1 : 0)} 스플라인은 끝점까지 직선으로 그림`, line);
            motionG = 10;
          }
          break;
        case 382:
        case 383:
        case 384:
        case 385:
        case 310:
          this.w.add('프로브(G38·G31) 이동은 끝점까지 직선으로 그림', line);
          motionG = 10;
          break;
        case 730:
        case 740:
        case 760:
        case 800:
        case 810:
        case 820:
        case 830:
        case 840:
        case 842:
        case 843:
        case 850:
        case 860:
        case 870:
        case 880:
        case 890:
          cycleG = g;
          break;
        case 40:
        case 100:
        case 280:
        case 281:
        case 300:
        case 301:
        case 520:
        case 920:
        case 921:
        case 922:
        case 923:
        case 110:
          nonModal = g;
          break;
        case 530:
          machine = true;
          break;
        case 170:
          this.plane = 0;
          break;
        case 180:
          this.plane = 1;
          break;
        case 190:
          this.plane = 2;
          break;
        case 200:
          this.blockInch = true;
          this.updateScale();
          break;
        case 210:
          this.blockInch = false;
          this.updateScale();
          break;
        case 400:
          this.comp = 0;
          break;
        case 410:
        case 411:
          this.comp = 1;
          break;
        case 420:
        case 421:
          this.comp = 2;
          break;
        case 430:
        case 431:
        case 440:
        case 434:
          this.tlc = true;
          if (g === 434) this.w.add('G43.4 공구 끝점 제어는 위치만 그림(회전축 무시)', line);
          break;
        case 490:
          this.tlc = false;
          break;
        case 540:
        case 550:
        case 560:
        case 570:
        case 580:
        case 590:
          this.selectWcs((g - 540) / 10, line);
          break;
        case 541: {
          const p = blk.has[LP] ? Math.round(blk.val[LP]!) : 1;
          blk.has[LP] = 0;
          this.selectWcs(5 + p, line);
          break;
        }
        case 591:
        case 592:
        case 593:
          this.selectWcs(6 + (g - 591), line);
          break;
        case 610:
        case 611:
        case 640:
        case 150:
        case 690:
        case 500:
        case 501:
        case 960:
        case 970:
        case 1030:
        case 1870:
        case 940:
          if (g === 940) this.feedMode = 94;
          break;
        case 930:
          this.feedMode = 93;
          break;
        case 950:
          this.feedMode = 95;
          break;
        case 900:
          this.absolute = true;
          break;
        case 910:
          this.absolute = false;
          break;
        case 901:
          this.arcAbs = true;
          break;
        case 911:
          this.arcAbs = false;
          break;
        case 980:
          this.retractR = false;
          break;
        case 990:
          this.retractR = true;
          break;
        case 160:
          this.w.add('G16 극좌표는 지원하지 않음(직교 좌표로 읽음)', line);
          break;
        case 510:
        case 511:
        case 680:
        case 682:
          this.w.add(`G${(g / 10).toFixed(g % 10 ? 1 : 0)} 배율·대칭·회전은 지원하지 않음(변환 없이 그림)`, line);
          break;
        case 70:
        case 80:
          // LinuxCNC 선반 지름·반지름 모드. Fanuc G08은 미리 읽기(무시)
          if (this.dialect === 'linuxcnc') this.w.add('G7/G8 선반 지름·반지름 모드는 지원하지 않음', line);
          break;
        case 330:
          this.w.add('나사 깎기(G33·G76)는 그리지 않음', line);
          break;
        default:
          this.w.add(`지원하지 않는 G${(g / 10).toFixed(g % 10 ? 1 : 0)}`, line);
      }
    }

    // 이송·주축·공구
    if (blk.has[LF]) this.feed = this.feedMode === 93 ? blk.val[LF]! : blk.val[LF]! * this.scale;
    if (blk.has[LS]) this.speed = Math.abs(blk.val[LS]!);
    let m6 = false;
    for (let k = 0; k < blk.mCount; k++) {
      const m = blk.m[k]!;
      if (m === 6) m6 = true;
      else if (m === 3 || m === 4) this.spindleDir = m;
      else if (m === 5) this.spindleDir = 0;
      else if (m === 7 || m === 8) this.coolant = true;
      else if (m === 9) this.coolant = false;
    }
    if (blk.has[LT]) {
      this.selTool = Math.round(blk.val[LT]!);
      const tInfo = blk.comments.length ? blk.comments.join(' ') : '';
      if (tInfo) this.addToolInfo(this.selTool, tInfo);
      if (!this.seenM6 && !m6) this.changeTool(this.selTool, line);
    }
    if (m6) {
      this.seenM6 = true;
      if (this.selTool >= 0) this.changeTool(this.selTool, line);
    }

    // 휴지
    if (nonModal === 40) {
      if (blk.has[LP]) this.dwell(this.dwellSeconds(blk, LP));
      else if (blk.has[LX]) this.dwell(blk.val[LX]!);
      else if (blk.has[20]) this.dwell(blk.val[20]!); // U
      return this.endBlock(blk, line);
    }

    const axisGiven = blk.has[LX] || blk.has[LY] || blk.has[LZ];
    if (blk.has[0] || blk.has[1] || blk.has[2]) this.w.add('회전축(A·B·C)은 무시함', line);
    if ((blk.has[20] || blk.has[21] || blk.has[22]) && nonModal !== 40) this.w.add('U·V·W 축은 무시함', line);

    // 비모달
    switch (nonModal) {
      case 100:
        this.g10(blk, line);
        return this.endBlock(blk, line);
      case 110:
        return this.endBlock(blk, line);
      case 920: {
        for (let a = 0; a < 3; a++) {
          const L = AXIS_LETTER[a]!;
          if (!blk.has[L]) continue;
          // 지금 위치의 프로그램 좌표가 주어진 값이 되게
          this.g92[a] = 0;
          this.updateOff();
          this.g92[a] = this.pos[a]! - blk.val[L]! * this.scale - this.off[a]!;
        }
        this.updateOff();
        return this.endBlock(blk, line);
      }
      case 921:
      case 922:
        this.g92 = [0, 0, 0];
        this.updateOff();
        return this.endBlock(blk, line);
      case 923:
        return this.endBlock(blk, line);
      case 520:
        for (let a = 0; a < 3; a++) {
          const L = AXIS_LETTER[a]!;
          if (blk.has[L]) this.g52[a] = blk.val[L]! * this.scale;
        }
        this.updateOff();
        return this.endBlock(blk, line);
      case 280:
      case 300: {
        // 중간점 → 기준점
        const mid = [this.target(blk, 0, false), this.target(blk, 1, false), this.target(blk, 2, false)];
        this.emit(MOVE_RAPID, mid[0]!, mid[1]!, mid[2]!, line);
        const home = (nonModal === 280 ? this.stored28 : this.stored30) ?? this.o.homePosition;
        if (home) {
          const all = !axisGiven;
          const t = [0, 1, 2].map((a) => (all || blk.has[AXIS_LETTER[a]!] ? home[a]! : this.pos[a]!));
          this.emit(MOVE_RAPID, t[0]!, t[1]!, t[2]!, line, FLAG_MACHINE);
        } else this.w.add(`G${nonModal / 10} 기준점 위치를 몰라 중간점에서 멈춘 것으로 그림`, line);
        return this.endBlock(blk, line);
      }
      case 281:
        this.stored28 = [this.pos[0]!, this.pos[1]!, this.pos[2]!];
        return this.endBlock(blk, line);
      case 301:
        this.stored30 = [this.pos[0]!, this.pos[1]!, this.pos[2]!];
        return this.endBlock(blk, line);
    }

    // 이동
    if (motionG >= 0) {
      this.motion = motionG;
      if (this.cycle) this.cancelCycle();
    }
    if (cycleG === 800) this.cancelCycle();
    else if (cycleG > 0) {
      if (this.cycle !== cycleG) {
        if (!this.cycle) this.cycleFresh = true;
        this.cycle = cycleG;
      }
    }
    if (this.cycle && motionG < 0) {
      if (axisGiven || blk.has[LR] || cycleG > 0) this.doCycle(blk, line);
    } else if (axisGiven) {
      if (machine && this.motion > 10) this.w.add('G53과 원호는 함께 쓸 수 없음', line);
      const x = this.target(blk, 0, machine);
      const y = this.target(blk, 1, machine);
      const z = this.target(blk, 2, machine);
      if (this.motion === 20 || this.motion === 30) this.arc(blk, line, x, y, z);
      else this.emit(this.motion === 0 ? MOVE_RAPID : MOVE_FEED, x, y, z, line, machine ? FLAG_MACHINE : 0);
      this.known |= (blk.has[LX] ? 1 : 0) | (blk.has[LY] ? 2 : 0) | (blk.has[LZ] ? 4 : 0);
    } else if ((motionG === 20 || motionG === 30) && (blk.has[LI] || blk.has[LJ] || blk.has[LK])) {
      // 끝점 없이 IJK만: 제자리 완전한 원
      this.arc(blk, line, this.pos[0]!, this.pos[1]!, this.pos[2]!);
    }
    this.endBlock(blk, line);
  }

  /** 블록 끝: 프로그램 흐름 M 코드와 변수 대입 */
  private endBlock(blk: Block, line: number, assignsOnly = false): void {
    for (const [r, v] of blk.assigns) this.setVar(r, v);
    if (assignsOnly) return;
    for (let k = 0; k < blk.mCount; k++) {
      const m = blk.m[k]!;
      if (m === 2 || m === 30) {
        this.ended = true;
        return;
      }
      if (m === 98) return this.m98(blk, line);
      if (m === 97) return this.m97(blk, line);
      if (m === 99) return this.m99(blk, line);
    }
  }

  private onComments(blk: Block, line: number): void {
    const text = blk.comments.join(' ').trim();
    if (!text) return;
    if (!this.started && !this.name && line < 5 && !/^\s*T\s*\d/i.test(text)) this.name = text.slice(0, 80);
    // 머리말의 공구 목록: (T1 D=6 ...) (TOOL 2 - ...)
    const m = /^\s*(?:T|TOOL)\s*#?\s*(\d+)\b/i.exec(text);
    if (m && !blk.has[LT]) this.addToolInfo(+m[1]!, text);
    this.lastComment = { text, line };
  }

  private selectWcs(idx: number, line: number): void {
    if (this.baseWcs < 0) this.baseWcs = idx;
    if (idx !== this.wcs || this.baseWcs === idx) {
      if (idx !== this.baseWcs && !this.wcsKnown.has(idx))
        this.w.add(`${wcsName(idx)} 오프셋 값을 몰라 ${wcsName(this.baseWcs)}와 같은 원점으로 그림`, line);
    }
    this.wcs = idx;
    this.updateOff();
  }

  private g10(blk: Block, line: number): void {
    const l = blk.has[LL] ? Math.round(blk.val[LL]!) : -1;
    if (l !== 2 && l !== 20) {
      if (l !== 1 && l !== 10 && l !== 11 && l !== 12 && l !== 13) this.w.add(`G10 L${l}은 무시함`, line);
      return;
    }
    let p = blk.has[LP] ? Math.round(blk.val[LP]!) : 0;
    if (p === 0) p = this.wcs + 1;
    const idx = p - 1;
    const cur = this.wcsOff.get(idx) ?? [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const L = AXIS_LETTER[a]!;
      if (!blk.has[L]) continue;
      const v = blk.val[L]! * this.scale;
      if (l === 2) cur[a] = this.absolute ? v : cur[a]! + v;
      else {
        // L20: 지금 위치가 v가 되게
        const machinePos = this.pos[a]! + (this.wcsOff.get(this.baseWcs < 0 ? this.wcs : this.baseWcs)?.[a] ?? 0) - this.g92[a]! - this.g52[a]!;
        cur[a] = machinePos - v;
      }
    }
    this.wcsOff.set(idx, cur);
    this.wcsKnown.add(idx);
    this.updateOff();
  }

  private cancelCycle(): void {
    this.cycle = 0;
    this.cycleFresh = true;
    this.cz = undefined;
    this.cr = undefined;
    this.cq = 0;
    this.cp = 0;
  }

  // ── 원호 ──
  private arc(blk: Block, line: number, x: number, y: number, z: number): void {
    const ccw = this.motion === 30;
    const [a0, a1, a2] = PLANE_AXES[this.plane]!;
    const s = [this.pos[0]!, this.pos[1]!, this.pos[2]!];
    const e = [x, y, z];
    let c0: number;
    let c1: number;
    if (blk.has[LR]) {
      const R = blk.val[LR]! * this.scale;
      const dx = e[a0]! - s[a0]!;
      const dy = e[a1]! - s[a1]!;
      const d = Math.hypot(dx, dy);
      if (d < 1e-9) {
        this.w.add('R 방식으로는 완전한 원을 만들 수 없음 — 직선으로 그림', line);
        this.emit(MOVE_FEED, x, y, z, line);
        return;
      }
      let r = Math.abs(R);
      if (d / 2 > r) {
        if (d / 2 - r > this.tol) this.w.add('호 반지름 R이 두 점 거리의 절반보다 작음 — 반원으로 그림', line);
        r = d / 2;
      }
      const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
      const side = (ccw ? 1 : -1) * (R < 0 ? -1 : 1);
      c0 = s[a0]! + dx / 2 - (side * h * dy) / d;
      c1 = s[a1]! + dy / 2 + (side * h * dx) / d;
    } else {
      const hasOff = blk.has[OFFSET_LETTER[a0]!] || blk.has[OFFSET_LETTER[a1]!];
      if (!hasOff) {
        this.w.add('원호에 I·J·K·R이 없음 — 직선으로 그림', line);
        this.emit(MOVE_FEED, x, y, z, line);
        return;
      }
      const o0 = blk.has[OFFSET_LETTER[a0]!] ? blk.val[OFFSET_LETTER[a0]!]! * this.scale : 0;
      const o1 = blk.has[OFFSET_LETTER[a1]!] ? blk.val[OFFSET_LETTER[a1]!]! * this.scale : 0;
      if (this.arcAbs) {
        c0 = blk.has[OFFSET_LETTER[a0]!] ? o0 + this.off[a0]! : s[a0]!;
        c1 = blk.has[OFFSET_LETTER[a1]!] ? o1 + this.off[a1]! : s[a1]!;
      } else {
        c0 = s[a0]! + o0;
        c1 = s[a1]! + o1;
      }
    }
    const u0 = s[a0]! - c0;
    const v0 = s[a1]! - c1;
    const u1 = e[a0]! - c0;
    const v1 = e[a1]! - c1;
    const r0 = Math.hypot(u0, v0);
    const r1 = Math.hypot(u1, v1);
    if (r0 < 1e-9) {
      this.w.add('원호 반지름이 0 — 직선으로 그림', line);
      this.emit(MOVE_FEED, x, y, z, line);
      return;
    }
    if (Math.abs(r0 - r1) > Math.max(this.tol, r0 * 1e-3)) this.w.add('원호 시작·끝 반지름이 다름(나선형으로 이어 그림)', line);
    const same = Math.hypot(e[a0]! - s[a0]!, e[a1]! - s[a1]!) <= Math.max(1e-7, r0 * 1e-9);
    let sweep = Math.atan2(v1, u1) - Math.atan2(v0, u0);
    const TAU = Math.PI * 2;
    if (ccw) {
      if (same) sweep = TAU;
      else while (sweep <= 0) sweep += TAU;
    } else {
      if (same) sweep = -TAU;
      else while (sweep >= 0) sweep -= TAU;
    }
    if (blk.has[LP] && !blk.has[LR]) {
      const turns = Math.round(blk.val[LP]!);
      if (turns > 1) sweep += (ccw ? 1 : -1) * TAU * (turns - 1);
    }
    const c = [0, 0, 0];
    c[a0] = c0;
    c[a1] = c1;
    c[a2] = s[a2]!;
    this.emitArc(this.plane, c, sweep, x, y, z, line);
  }

  // ── 고정 사이클 ──
  private doCycle(blk: Block, line: number): void {
    const [p0, p1, da] = PLANE_AXES[this.plane]!;
    const code = this.cycle;
    if (this.cycleFresh) {
      this.initLevel = this.pos[da]!;
      this.cycleFresh = false;
    }
    const sc = this.scale;
    const DL = AXIS_LETTER[da]!;
    if (blk.has[DL]) this.cz = blk.val[DL]! * sc;
    if (blk.has[LR]) this.cr = blk.val[LR]! * sc;
    if (blk.has[LQ]) this.cq = Math.abs(blk.val[LQ]!) * sc;
    if (blk.has[LP]) this.cp = this.dwellSeconds(blk, LP);
    let reps = 1;
    if (blk.has[LL]) reps = Math.round(blk.val[LL]!);
    else if (blk.has[LK] && this.plane === 0 && this.dialect !== 'linuxcnc') reps = Math.round(blk.val[LK]!);
    if (this.cr === undefined) this.cr = this.absolute ? this.pos[da]! - this.off[da]! : 0;
    if (this.cz === undefined) {
      this.w.add('고정 사이클에 깊이(Z)가 없음', line);
      return;
    }
    let rD: number;
    let zD: number;
    if (this.absolute) {
      rD = this.cr + this.off[da]!;
      zD = this.cz + this.off[da]!;
    } else {
      rD = this.initLevel + this.cr;
      zD = rD + this.cz;
    }
    if (reps <= 0) return;
    const L0 = AXIS_LETTER[p0]!;
    const L1 = AXIS_LETTER[p1]!;
    for (let k = 0; k < reps; k++) {
      let x = this.pos[p0]!;
      let y = this.pos[p1]!;
      if (this.absolute) {
        if (blk.has[L0]) x = blk.val[L0]! * sc + this.off[p0]!;
        if (blk.has[L1]) y = blk.val[L1]! * sc + this.off[p1]!;
      } else {
        if (blk.has[L0]) x += blk.val[L0]! * sc;
        if (blk.has[L1]) y += blk.val[L1]! * sc;
      }
      this.drillAt(code, p0, p1, da, x, y, rD, zD, line);
    }
    this.known = 7;
  }

  private drillAt(code: number, p0: number, p1: number, da: number, x: number, y: number, rD: number, zD: number, line: number): void {
    const up = rD >= zD ? 1 : -1;
    const clear = this.retractR ? rD : up * (this.initLevel - rD) > 0 ? this.initLevel : rD;
    const pt = [0, 0, 0];
    const go = (kind: number, depth: number, px = this.pos[p0]!, py = this.pos[p1]!): void => {
      pt[p0] = px;
      pt[p1] = py;
      pt[da] = depth;
      this.emit(kind, pt[0]!, pt[1]!, pt[2]!, line, FLAG_CYCLE);
    };
    if (up * (this.pos[da]! - rD) < 0) go(MOVE_RAPID, rD);
    go(MOVE_RAPID, this.pos[da]!, x, y);
    go(MOVE_RAPID, rD);
    const first = this.mb.count;
    const top = [0, 0, 0];
    top[p0] = x;
    top[p1] = y;
    top[da] = rD;
    const bottom = [top[0]!, top[1]!, top[2]!];
    bottom[da] = zD;
    const q = this.cq;
    switch (code) {
      case 830:
      case 730:
        if (q > 0) {
          let d = rD;
          let guard = 0;
          while (up * (d - zD) > 1e-9 && guard++ < 10000) {
            const next = up > 0 ? Math.max(zD, d - q) : Math.min(zD, d + q);
            if (code === 830 && d !== rD) go(MOVE_RAPID, d + up * this.peck);
            go(MOVE_DRILL, next);
            if (next !== zD) go(MOVE_RAPID, code === 830 ? rD : next + up * this.peck);
            d = next;
          }
          go(MOVE_RAPID, clear);
          break;
        }
        go(MOVE_DRILL, zD);
        go(MOVE_RAPID, clear);
        break;
      case 810:
        go(MOVE_DRILL, zD);
        go(MOVE_RAPID, clear);
        break;
      case 820:
        go(MOVE_DRILL, zD);
        this.dwell(this.cp);
        go(MOVE_RAPID, clear);
        break;
      case 840:
      case 842:
      case 843:
      case 740:
      case 850:
      case 890:
        go(MOVE_DRILL, zD);
        if (code === 890 || code === 840 || code === 740) this.dwell(this.cp);
        go(MOVE_FEED, rD);
        if (clear !== rD) go(MOVE_RAPID, clear);
        break;
      case 860:
      case 760:
      case 870:
      case 880:
        if (code !== 860) this.w.add(`G${code / 10} 사이클은 G86처럼(내려가서 급속 복귀) 그림`, line);
        go(MOVE_DRILL, zD);
        if (code === 880) this.dwell(this.cp);
        go(MOVE_RAPID, clear);
        break;
      default:
        go(MOVE_DRILL, zD);
        go(MOVE_RAPID, clear);
    }
    if (this.mb.count > first) this.mb.pushHole(top, bottom, line, this.tool, code / 10, first);
  }

  // ── 프로그램 흐름 ──
  private buildOIndex(): Map<number, number> {
    if (this.oIndex) return this.oIndex;
    const map = new Map<number, number>();
    const b = this.src.bytes;
    for (let i = 0; i < this.src.lineCount; i++) {
      const [s, e] = lineRange(this.src, i);
      let k = s;
      while (k < e && (b[k] === 32 || b[k] === 9)) k++;
      const c = b[k];
      if (c !== 79 && c !== 111 && c !== 58) continue;
      k++;
      const d0 = k;
      let n = 0;
      while (k < e && b[k]! >= 48 && b[k]! <= 57) n = n * 10 + (b[k++]! - 48);
      if (k === d0) continue;
      while (k < e && (b[k] === 32 || b[k] === 9)) k++;
      // 뒤에 낱말(sub·call…)이 오면 LinuxCNC o-코드
      const nx = b[k];
      if (k < e && nx !== 40 && nx !== 59 && ((nx! >= 65 && nx! <= 90) || (nx! >= 97 && nx! <= 122))) {
        if (c === 111 || c === 79) {
          const rest = decodeRange(this.src, k, Math.min(e, k + 10)).toUpperCase();
          if (O_KEYWORDS.some((w) => rest.startsWith(w))) continue;
        }
      }
      if (!map.has(n)) map.set(n, i);
    }
    return (this.oIndex = map);
  }

  private buildNIndex(): Map<number, number[]> {
    if (this.nIndex) return this.nIndex;
    const map = new Map<number, number[]>();
    const b = this.src.bytes;
    for (let i = 0; i < this.src.lineCount; i++) {
      const [s, e] = lineRange(this.src, i);
      let k = s;
      while (k < e && (b[k] === 32 || b[k] === 9 || b[k] === 47)) k++;
      if (b[k] !== 78 && b[k] !== 110) continue;
      k++;
      while (k < e && b[k] === 32) k++;
      const d0 = k;
      let n = 0;
      while (k < e && b[k]! >= 48 && b[k]! <= 57) n = n * 10 + (b[k++]! - 48);
      if (k === d0) continue;
      const list = map.get(n);
      if (list) list.push(i);
      else map.set(n, [i]);
    }
    return (this.nIndex = map);
  }

  private findN(n: number): number {
    const list = this.buildNIndex().get(n);
    if (!list) return -1;
    const start = this.stack[this.stack.length - 1]!.start;
    for (const l of list) if (l >= start) return l;
    return list[0]!;
  }

  private buildOCodes(): Map<string, { line: number; kw: string }[]> {
    if (this.oCodes) return this.oCodes;
    const map = new Map<string, { line: number; kw: string }[]>();
    const b = this.src.bytes;
    for (let i = 0; i < this.src.lineCount; i++) {
      const [s, e] = lineRange(this.src, i);
      let k = s;
      while (k < e && (b[k] === 32 || b[k] === 9)) k++;
      if (b[k] !== 79 && b[k] !== 111) continue;
      const code = splitComments(decodeRange(this.src, k, e), null);
      const m = /^O(\d+|<[^>]*>)([A-Z]+)/.exec(code);
      if (!m) continue;
      const kw = O_KEYWORDS.find((w) => m[2]!.startsWith(w));
      if (!kw) continue;
      const label = m[1]!.startsWith('<') ? m[1]!.slice(1, -1).toLowerCase() : String(parseInt(m[1]!, 10));
      const list = map.get(label);
      if (list) list.push({ line: i, kw });
      else map.set(label, [{ line: i, kw }]);
    }
    return (this.oCodes = map);
  }

  /** label의 kws 중 line 뒤에 처음 나오는 것 */
  private nextO(label: string, line: number, kws: string[]): { line: number; kw: string } | undefined {
    const list = this.buildOCodes().get(label);
    if (!list) return undefined;
    return list.find((x) => x.line > line && kws.includes(x.kw));
  }
  private prevO(label: string, line: number, kws: string[]): { line: number; kw: string } | undefined {
    const list = this.buildOCodes().get(label);
    if (!list) return undefined;
    let r: { line: number; kw: string } | undefined;
    for (const x of list) if (x.line < line && kws.includes(x.kw)) r = x;
    return r;
  }

  private control(c: Ctrl, line: number): void {
    switch (c.k) {
      case 'goto': {
        const t = this.findN(c.n);
        if (t < 0) {
          this.w.add(`GOTO ${c.n}: N${c.n} 블록이 없음 — 멈춤`, line);
          this.ended = true;
        } else this.pc = t;
        return;
      }
      case 'while': {
        if (c.ok) {
          const top = this.loops[this.loops.length - 1];
          if (!top || top.m !== c.m || top.line !== line) this.loops.push({ m: c.m, line });
          return;
        }
        while (this.loops.length && this.loops[this.loops.length - 1]!.m !== c.m) this.loops.pop();
        if (this.loops.length) this.loops.pop();
        const end = this.findEnd(c.m, line);
        if (end < 0) {
          this.w.add(`WHILE … DO${c.m}에 맞는 END${c.m}이 없음 — 멈춤`, line);
          this.ended = true;
        } else this.pc = end + 1;
        return;
      }
      case 'do':
        this.loops.push({ m: c.m, line: line + 1 });
        return;
      case 'end': {
        // WHILE은 조건 줄로, DO 단독(끝없는 반복)은 몸통 첫 줄로 돌아간다
        for (let i = this.loops.length - 1; i >= 0; i--)
          if (this.loops[i]!.m === c.m) {
            this.loops.length = i + 1;
            this.pc = this.loops[i]!.line;
            return;
          }
        this.w.add(`END${c.m}에 맞는 WHILE·DO가 없음`, line);
        return;
      }
      case 'o':
        return this.oControl(c, line);
    }
  }

  /** line 뒤에서 END m 줄을 찾는다 */
  private findEnd(m: number, line: number): number {
    const re = new RegExp(`(^|[^A-Z])END${m}(?![0-9])`);
    for (let i = line + 1; i < this.src.lineCount; i++) {
      const t = sourceLine(this.src, i);
      if (!/end/i.test(t)) continue;
      if (re.test(splitComments(t, null))) return i;
    }
    return -1;
  }

  private oControl(c: Extract<Ctrl, { k: 'o' }>, line: number): void {
    const { label, kw } = c;
    const jumpPast = (kws: string[]): void => {
      const t = this.nextO(label, line, kws);
      if (!t) {
        this.w.add(`o${label}: 짝이 되는 ${kws.join('/').toLowerCase()}이 없음 — 멈춤`, line);
        this.ended = true;
      } else this.pc = t.line + 1;
    };
    const jumpTo = (kws: string[]): void => {
      const t = this.nextO(label, line, kws);
      if (!t) {
        this.w.add(`o${label}: 짝이 되는 ${kws.join('/').toLowerCase()}이 없음 — 멈춤`, line);
        this.ended = true;
      } else this.pc = t.line;
    };
    switch (kw) {
      case 'SUB':
        // 정의는 건너뛴다(부를 때만 들어간다)
        return jumpPast(['ENDSUB']);
      case 'ENDSUB':
      case 'RETURN': {
        if (c.val !== undefined) this.namedGlobals.set('_value', c.val);
        const f = this.stack[this.stack.length - 1]!;
        if (f.kind === 'ocall') {
          this.stack.pop();
          this.pc = f.ret;
        }
        return;
      }
      case 'CALL': {
        const def = this.buildOCodes()
          .get(label)
          ?.find((x) => x.kw === 'SUB');
        if (!def) {
          this.w.add(`o${label} call: 같은 파일에 sub 정의가 없음(외부 파일 부프로그램은 읽지 않음)`, line);
          return;
        }
        if (this.stack.length >= MAX_CALL_DEPTH) {
          this.w.add('부프로그램 호출이 너무 깊음 — 멈춤', line);
          this.ended = true;
          return;
        }
        const locals = new Map<number, number>();
        c.args.forEach((v, i) => locals.set(i + 1, v));
        this.stack.push({ kind: 'ocall', ret: line + 1, start: def.line, reps: 1, locals, named: new Map(), label });
        this.pc = def.line + 1;
        return;
      }
      case 'IF':
        if (c.val) this.ifTaken.set(label, true);
        else {
          this.ifTaken.set(label, false);
          jumpTo(['ELSEIF', 'ELSE', 'ENDIF']);
        }
        return;
      case 'ELSEIF':
        if (this.ifTaken.get(label)) return jumpTo(['ENDIF']);
        if (c.val) this.ifTaken.set(label, true);
        else jumpTo(['ELSEIF', 'ELSE', 'ENDIF']);
        return;
      case 'ELSE':
        if (this.ifTaken.get(label)) return jumpTo(['ENDIF']);
        this.ifTaken.set(label, true);
        return;
      case 'ENDIF':
        this.ifTaken.delete(label);
        return;
      case 'DO':
        return;
      case 'WHILE': {
        // do … while(끝)인지 while … endwhile(처음)인지
        const doLine = this.prevO(label, line, ['DO']);
        const endW = this.nextO(label, line, ['ENDWHILE']);
        if (doLine && !endW) {
          if (c.val) this.pc = doLine.line + 1;
          return;
        }
        if (!c.val) jumpPast(['ENDWHILE']);
        return;
      }
      case 'ENDWHILE': {
        const w = this.prevO(label, line, ['WHILE']);
        if (w) this.pc = w.line;
        return;
      }
      case 'REPEAT': {
        const n = Math.round(c.val ?? 0);
        if (n <= 0) return jumpPast(['ENDREPEAT']);
        this.repeatLeft.set(label, n);
        return;
      }
      case 'ENDREPEAT': {
        const left = (this.repeatLeft.get(label) ?? 1) - 1;
        if (left > 0) {
          this.repeatLeft.set(label, left);
          const r = this.prevO(label, line, ['REPEAT']);
          if (r) this.pc = r.line + 1;
        } else this.repeatLeft.delete(label);
        return;
      }
      case 'BREAK': {
        const t = this.nextO(label, line, ['ENDWHILE', 'ENDREPEAT', 'WHILE']);
        if (t) this.pc = t.line + 1;
        this.repeatLeft.delete(label);
        return;
      }
      case 'CONTINUE': {
        // 반복 끝 줄(endwhile·endrepeat·do-while의 while)로 가서 다음 차례를 정한다
        const t = this.nextO(label, line, ['ENDWHILE', 'ENDREPEAT', 'WHILE']);
        if (t) this.pc = t.line;
        return;
      }
    }
  }

  private m98(blk: Block, line: number): void {
    if (!blk.has[LP]) {
      this.w.add('M98에 P(프로그램 번호)가 없음', line);
      return;
    }
    let prog = Math.round(blk.val[LP]!);
    let reps = blk.has[LL] ? Math.round(blk.val[LL]!) : blk.has[LK] ? Math.round(blk.val[LK]!) : 1;
    const idx = this.buildOIndex();
    if (!idx.has(prog) && prog > 9999 && !blk.has[LL] && !blk.has[LK]) {
      reps = Math.floor(prog / 10000);
      prog = prog % 10000;
    }
    const start = idx.get(prog);
    if (start === undefined) {
      this.w.add(`M98 P${prog}: 같은 파일에 O${prog}가 없음(다른 파일 부프로그램은 읽지 않음)`, line);
      return;
    }
    if (reps <= 0) return;
    if (this.stack.length >= MAX_CALL_DEPTH) {
      this.w.add('부프로그램 호출이 너무 깊음 — 멈춤', line);
      this.ended = true;
      return;
    }
    const f = this.stack[this.stack.length - 1]!;
    this.stack.push({ kind: 'm98', ret: line + 1, start: start + 1, reps, locals: f.locals, named: f.named });
    this.pc = start + 1;
  }

  private m97(blk: Block, line: number): void {
    const n = blk.has[LP] ? Math.round(blk.val[LP]!) : -1;
    const t = n >= 0 ? this.findN(n) : -1;
    if (t < 0) {
      this.w.add(`M97 P${n}: N${n} 블록이 없음`, line);
      return;
    }
    const f = this.stack[this.stack.length - 1]!;
    const reps = blk.has[LL] ? Math.round(blk.val[LL]!) : 1;
    this.stack.push({ kind: 'm97', ret: line + 1, start: t, reps, locals: f.locals, named: f.named });
    this.pc = t;
  }

  private m99(blk: Block, line: number): void {
    const f = this.stack[this.stack.length - 1]!;
    if (f.kind === 'main') {
      if (this.started) this.w.add('주 프로그램의 M99(처음부터 반복) — 한 번만 그림', line);
      this.ended = true;
      return;
    }
    if (f.reps > 1) {
      f.reps--;
      this.pc = f.start;
      return;
    }
    this.stack.pop();
    this.pc = f.ret;
    if (blk.has[LP]) {
      const t = this.findN(Math.round(blk.val[LP]!));
      if (t >= 0) this.pc = t;
    }
  }

  /** G65 P… A… B…: 매크로 호출(인수 → 지역 변수) */
  private macroCall(blk: Block, line: number): void {
    if (!blk.has[LP]) {
      this.w.add('G65에 P가 없음', line);
      return;
    }
    const prog = Math.round(blk.val[LP]!);
    const start = this.buildOIndex().get(prog);
    if (start === undefined) {
      this.w.add(`G65 P${prog}: 같은 파일에 O${prog}가 없음`, line);
      return;
    }
    if (this.stack.length >= MAX_CALL_DEPTH) {
      this.w.add('부프로그램 호출이 너무 깊음 — 멈춤', line);
      this.ended = true;
      return;
    }
    // 인수 지정 I: A=1 B=2 C=3 I=4 J=5 K=6 D=7 E=8 F=9 H=11 M=13 Q=17 R=18 S=19 T=20 U=21 V=22 W=23 X=24 Y=25 Z=26
    const map: Record<number, number> = { 0: 1, 1: 2, 2: 3, 8: 4, 9: 5, 10: 6, 3: 7, 4: 8, 5: 9, 7: 11, 12: 13, 16: 17, 17: 18, 18: 19, 19: 20, 20: 21, 21: 22, 22: 23, 23: 24, 24: 25, 25: 26 };
    const locals = new Map<number, number>();
    for (const [l, v] of Object.entries(map)) if (blk.has[+l] && +l !== LP && +l !== LL) locals.set(v, blk.val[+l]!);
    const reps = blk.has[LL] ? Math.round(blk.val[LL]!) : 1;
    this.stack.push({ kind: 'g65', ret: line + 1, start: start + 1, reps, locals, named: new Map() });
    this.pc = start + 1;
  }

  finish(opts: GcodeOptions): NcProgram {
    if (this.stack.length > 1 && !this.hitLimit && !this.ended) this.w.add('부프로그램 안에서 프로그램이 끝남(M99 없음)');
    return this.build({ name: opts.name ?? (this.name || 'G-code'), format: 'gcode', dialect: this.dialect, blocks: Math.min(this.blocks, this.maxBlocks) });
  }
}

function wcsName(idx: number): string {
  if (idx < 0) return 'G54';
  return idx <= 5 ? `G${54 + idx}` : `G54.1 P${idx - 5}`;
}

function wcsIndexFromName(k: string): number {
  const s = k.toUpperCase().replace(/\s+/g, '');
  let m = /^G5([4-9])$/.exec(s);
  if (m) return +m[1]! - 4;
  m = /^G54\.1P(\d+)$/.exec(s);
  if (m) return 5 + +m[1]!;
  return -1;
}

/** 원본 글 앞부분(판별용) */
function headText(src: NcSource): string {
  const n = Math.min(src.bytes.length, 256 * 1024);
  return decodeRange(src, 0, n);
}

/**
 * G-code를 해석한다. input은 바이트(권장 — 큰 파일)나 글.
 * Heidenhain 평문이면 parseHeidenhain을 쓴다(parseNc가 골라 준다).
 */
export function parseGcode(input: Uint8Array | ArrayBuffer | string | NcSource, opts: GcodeOptions = {}): NcProgram {
  const src = isSource(input) ? input : makeSource(input);
  let dialect = opts.dialect && opts.dialect !== 'auto' ? opts.dialect : detectGcodeDialect(headText(src));
  if (dialect === 'heidenhain') dialect = 'iso';
  const r = new Runner(src, opts, dialect);
  r.run();
  return r.finish(opts);
}

export function isSource(x: unknown): x is NcSource {
  return !!x && typeof x === 'object' && 'lineStart' in x && 'bytes' in x;
}

export { headText };
