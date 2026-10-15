/**
 * Heidenhain 평문(Klartext, .h) 해석기 — 자주 쓰는 것만.
 *
 * 지원: BEGIN/END PGM(단위), BLK FORM 0.1/0.2(공작물 상자), TOOL DEF(반지름 → 지름), TOOL CALL(번호·이름, 축, S, F),
 * L(FMAX·F·R0/RL/RR·M), CC(극), C(DR±), CR(R±), CT(접선 호), LP·CP(극좌표, IPA 나선), Q 변수(Qn = 식, FN 0~8),
 * CYCL DEF 200·201·202·203·205·240·206·207·209·1(드릴 계열)과 CYCL CALL·M99·M89, CYCL DEF 7(원점 이동),
 * LBL·CALL LBL REP(구간 반복·부프로그램), FN 9~12 조건 점프.
 * 근사: RND·CHF는 모서리 그대로, APPR·DEP는 끝점까지 직선(경고).
 * 지원하지 않음: PLANE·회전·대칭·배율 사이클, 포켓·윤곽 사이클, PATTERN DEF, CALL PGM(경고).
 */
import { NcEmitter } from './emitter';
import { ExprError, evalMprExpr } from './expr';
import { FLAG_CYCLE, FLAG_MACHINE, MOVE_DRILL, MOVE_FEED, MOVE_RAPID, PLANE_AXES, type NcPlane, type NcProgram } from './model';
import type { Box3 } from '../../viewer3d/types';
import { makeSource, sourceLine, type NcSource } from './text';
import { isSource } from './gcode';

export interface HeidenhainOptions {
  name?: string;
  /** 급속 속도(표시 단위/분, 기본 mm 10000 · inch 400) */
  rapidFeed?: number;
  /** 시작 위치 */
  initialPosition?: [number, number, number];
  /** 실행 블록 수 한도 */
  maxBlocks?: number;
  maxMoves?: number;
}

const AXES = 'XYZ';

/** 한 블록: 원본 첫 줄 번호와 낱말들 */
interface HBlock {
  line: number;
  /** 다음 블록이 시작하는 줄 */
  next: number;
  toks: string[];
  text: string;
}

class HRunner extends NcEmitter {
  private o: HeidenhainOptions;
  private plane: NcPlane = 0;
  private cc: [number, number] | null = null;
  private lastDir: [number, number] | null = null;
  private dr = 1;
  private q = new Map<string, number>();
  private shift = [0, 0, 0];
  private blkMin: number[] | null = null;
  private blkMax: number[] | null = null;
  private stock: Box3 | undefined;
  private autoFeed = 0;
  private cycle: { n: number; ok: boolean } | null = null;
  private modalCall = false;
  private labels: Map<string, number> | null = null;
  private stack: { ret: number; reps: number; start: number }[] = [];
  private sectionReps = new Map<number, number>();
  private pc = 0;
  private ended = false;
  private blocks = 0;
  private toolNames = new Map<string, number>();
  private maxBlocks: number;
  private maxMoves: number;

  constructor(src: NcSource, opts: HeidenhainOptions) {
    super(src, opts.initialPosition);
    this.o = opts;
    this.maxBlocks = opts.maxBlocks ?? Math.max(src.lineCount * 20, 2_000_000);
    this.maxMoves = opts.maxMoves ?? 8_000_000;
    // 단위: BEGIN PGM … MM|INCH
    for (let i = 0; i < Math.min(src.lineCount, 50); i++) {
      const m = /BEGIN\s+PGM\s+(\S+)\s+(MM|INCH)/i.exec(sourceLine(src, i));
      if (m) {
        this.name = m[1]!;
        this.displayInch = m[2]!.toUpperCase() === 'INCH';
        break;
      }
    }
    this.tol = this.displayInch ? 0.0001 : 0.002;
    this.rapidFeed = opts.rapidFeed ?? (this.displayInch ? 400 : 10000);
    this.feedMode = 94;
  }

  /** 줄 i부터 블록 하나(~ 이어 쓰기 포함) */
  private readBlock(i: number): HBlock {
    let text = '';
    let j = i;
    for (;;) {
      // 이어 쓰기 표시 ~는 주석(;) 뒤 줄 끝에 온다 — 주석을 떼기 전에 본다
      let t = sourceLine(this.src, j).trimEnd();
      const cont = t.endsWith('~');
      if (cont) t = t.slice(0, -1);
      const sc = indexOutsideQuotes(t, ';');
      if (sc >= 0) t = t.slice(0, sc);
      t = t.trim();
      text += (text ? ' ' : '') + t;
      j++;
      if (!cont || j >= this.src.lineCount) break;
    }
    // 블록 번호 떼기
    text = text.replace(/^\s*N?\d+(?:\s+|$)/, '').trim();
    return { line: i, next: j, toks: tokenize(text), text };
  }

  run(): void {
    while (!this.ended && this.pc < this.src.lineCount) {
      if (++this.blocks > this.maxBlocks) {
        this.w.add(`실행 블록이 ${this.maxBlocks}개를 넘어 멈춤(끝없는 반복일 수 있음)`, this.pc);
        break;
      }
      const b = this.readBlock(this.pc);
      this.pc = b.next;
      if (!b.toks.length) continue;
      try {
        this.exec(b);
      } catch (err) {
        if (!(err instanceof ExprError)) throw err;
        this.w.add(`읽을 수 없는 블록 — ${err.message}`, b.line);
      }
      if (this.mb.count >= this.maxMoves) {
        this.w.add(`이동이 ${this.maxMoves}개를 넘어 나머지는 읽지 않음`, b.line);
        break;
      }
    }
  }

  // ── 값 ──
  private value(s: string): number {
    const t = s.trim();
    if (t === '') throw new ExprError('값 없음');
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    return this.expr(t);
  }
  private expr(e: string): number {
    const v = evalMprExpr(e.replace(/\bDIV\b/gi, '/'), {
      get: (name) => {
        const k = name.toUpperCase();
        if (/^Q[LRS]?\d+$/.test(k)) return this.q.get(k) ?? 0;
        return undefined;
      },
    });
    return v;
  }

  // ── 실행 ──
  private exec(b: HBlock): void {
    const T = b.toks;
    const t0 = T[0]!.toUpperCase();
    const t1 = (T[1] ?? '').toUpperCase();
    const line = b.line;
    if (t0 === '*' || t0.startsWith('*')) return; // 구조 주석
    if (t0 === 'BEGIN') return;
    if (t0 === 'END' && t1 === 'PGM') {
      this.ended = true;
      return;
    }
    if (t0 === 'BLK' && t1 === 'FORM') return this.blkForm(T, line);
    if (t0 === 'TOOL' && t1 === 'DEF') {
      const n = parseInt(T[2] ?? '', 10);
      const r = findWord(T, 'R');
      if (Number.isFinite(n) && r !== undefined) this.setToolInfo(n, { diameter: 2 * this.value(r) });
      return;
    }
    if (t0 === 'TOOL' && t1 === 'CALL') return this.toolCall(T, line);
    if (t0 === 'CYCL' && t1 === 'DEF') return this.cyclDef(T, line);
    if (t0 === 'CYCL' && t1 === 'CALL') {
      if ((T[2] ?? '').toUpperCase() === 'PAT') {
        this.w.add('CYCL CALL PAT(점 패턴)은 지원하지 않음', line);
        return;
      }
      const f = findWord(T, 'F');
      if (f !== undefined) this.feed = this.value(f);
      this.mWords(T, line, true);
      return this.cycleCall(line);
    }
    if (t0 === 'LBL') {
      // LBL 0 = 부프로그램 끝(부른 곳으로 돌아간다). 다른 LBL은 표지일 뿐
      const f = this.stack[this.stack.length - 1];
      if ((T[1] === '0' || T[1] === '"0"') && f) {
        if (f.reps > 1) {
          f.reps--;
          this.pc = f.start;
        } else {
          this.stack.pop();
          this.pc = f.ret;
        }
      }
      return;
    }
    if (t0 === 'CALL' && t1 === 'LBL') return this.callLbl(T, line);
    if (t0 === 'CALL' && t1 === 'PGM') {
      this.w.add('CALL PGM(다른 프로그램 부르기)은 읽지 않음', line);
      return;
    }
    if (t0 === 'FN') return this.fn(b, line);
    if (/^Q[LRS]?\d+$/.test(t0) || /^Q[LRS]?\d+=/.test(t0)) return this.qAssign(b.text);
    if (t0 === 'L') return this.linear(T, line);
    // 'L' 없이 좌표로 시작하는 블록(예: "8 A+180 R0 FMAX")도 직선으로
    if (/^I?[XYZABCUVW][+-]/.test(t0)) return this.linear(['L', ...T], line);
    if (t0 === 'CC') return this.pole(T);
    if (t0 === 'C') return this.circle(T, line);
    if (t0 === 'CR') return this.circleR(T, line);
    if (t0 === 'CT') return this.circleT(T, line);
    if (t0 === 'LP') return this.linearPolar(T, line);
    if (t0 === 'CP') return this.circlePolar(T, line);
    if (t0 === 'RND' || t0 === 'CHF') {
      this.w.add(`${t0}(모서리 둥글리기·모따기)는 모서리 그대로 그림`, line);
      return;
    }
    if (t0.startsWith('APPR') || t0.startsWith('DEP')) {
      this.w.add('APPR·DEP(접근·이탈)는 끝점까지 직선으로 그림', line);
      return this.linear(T, line);
    }
    if (t0 === 'STOP' || t0 === 'FUNCTION' || t0 === 'TCH' || t0 === 'PATTERN' || t0 === 'PLANE' || t0 === 'SEL' || t0 === 'DECLARE') {
      if (t0 !== 'STOP') this.w.add(`${t0} 블록은 지원하지 않음`, line);
      this.mWords(T, line, false);
      return;
    }
    if (/^M\d+$/.test(t0)) {
      this.mWords(T, line, false);
      return;
    }
    this.w.add(`알 수 없는 블록 '${t0}'`, line);
  }

  private blkForm(T: string[], line: number): void {
    const kind = T[2] ?? '';
    const pt = (): number[] => {
      const p = [NaN, NaN, NaN];
      for (const w of T.slice(3)) {
        const m = /^(I?)([XYZ])(.+)$/i.exec(w);
        if (!m) continue;
        const a = AXES.indexOf(m[2]!.toUpperCase());
        const v = this.value(m[3]!);
        p[a] = m[1] ? (this.blkMin?.[a] ?? 0) + v : v;
      }
      return p;
    };
    if (kind === '0.1') {
      this.blkMin = pt();
      const ax = (T[3] ?? 'Z').toUpperCase();
      this.plane = ax === 'Y' ? 1 : ax === 'X' ? 2 : 0;
    } else if (kind === '0.2' && this.blkMin) {
      this.blkMax = pt();
      const a = this.blkMin;
      const b = this.blkMax;
      if ([0, 1, 2].every((k) => Number.isFinite(a[k]!) && Number.isFinite(b[k]!)))
        this.stock = {
          min: [Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.min(a[2]!, b[2]!)],
          max: [Math.max(a[0]!, b[0]!), Math.max(a[1]!, b[1]!), Math.max(a[2]!, b[2]!)],
        };
    } else if (kind.toUpperCase() === 'CYLINDER') {
      // BLK FORM CYLINDER 축 R(또는 D) L — 축 방향으로 0에서 -L까지(추정), 둘레 상자로 그린다
      const r = findWord(T, 'R');
      const d = findWord(T, 'D');
      const l = findWord(T, 'L');
      const R = r !== undefined ? this.value(r) : d !== undefined ? this.value(d) / 2 : undefined;
      if (R !== undefined && l !== undefined) {
        const L = this.value(l);
        const ax = AXES.indexOf((T[3] ?? 'Z').toUpperCase());
        const min: [number, number, number] = [-R, -R, -R];
        const max: [number, number, number] = [R, R, R];
        const a = ax < 0 ? 2 : ax;
        min[a] = -L;
        max[a] = 0;
        this.stock = { min, max };
        this.w.add('BLK FORM CYLINDER는 둘레 상자로 그림', line);
      }
    }
  }

  private toolCall(T: string[], line: number): void {
    const id = T[2] ?? '';
    let n: number;
    if (/^\d+$/.test(id)) n = +id;
    else if (/^".*"$/.test(id)) {
      const name = id.slice(1, -1);
      n = this.toolNames.get(name) ?? 100000 + this.toolNames.size;
      this.toolNames.set(name, n);
      this.setToolInfo(n, { name });
    } else n = this.tool >= 0 ? this.tool : 0;
    const ax = (T[3] ?? '').toUpperCase();
    if (ax === 'Z') this.plane = 0;
    else if (ax === 'Y') this.plane = 1;
    else if (ax === 'X') this.plane = 2;
    const s = findWord(T, 'S');
    if (s !== undefined) this.speed = Math.abs(this.value(s));
    const f = findWord(T, 'F');
    if (f !== undefined && /^[+-]?[\d.Q]/i.test(f)) this.autoFeed = this.value(f);
    this.changeTool(n, line);
  }

  private cyclDef(T: string[], line: number): void {
    const num = T[2] ?? '';
    // Q 값 대입(새 꼴: 한 블록 안에 Q200=… 가 이어짐)
    for (const w of T.slice(3)) {
      const m = /^(Q[LR]?\d+)=(.+)$/i.exec(w);
      if (m && !m[2]!.startsWith('"')) this.q.set(m[1]!.toUpperCase(), this.value(m[2]!));
    }
    const major = parseInt(num, 10);
    // 예전 꼴: CYCL DEF 1.0 PECKING / 1.1 SET UP 2 / 1.2 DEPTH -20 / 1.3 PECKG 5 / 1.4 DWELL 0 / 1.5 F100
    if (/^\d+\.\d+$/.test(num)) {
      const sub = Math.round((parseFloat(num) - major) * 10);
      const last = T[T.length - 1] ?? '';
      const val = (): number | undefined => {
        const m = /^F?([+-]?[\d.]+)$/i.exec(last);
        return m ? parseFloat(m[1]!) : undefined;
      };
      if (major === 7) {
        // 원점 이동: 7.1 X+10 / 7.2 Y+5 / 7.3 Z…
        for (const w of T.slice(3)) {
          const m = /^(I?)([XYZ])(.+)$/i.exec(w);
          if (!m) continue;
          const a = AXES.indexOf(m[2]!.toUpperCase());
          const v = this.value(m[3]!);
          this.shift[a] = m[1] ? this.shift[a]! + v : v;
        }
        return;
      }
      if (major === 1 || major === 2 || major === 17) {
        if (sub === 0) this.cycle = { n: major, ok: true };
        const v = val();
        if (v !== undefined) {
          const key = ['', 'O1', 'O2', 'O3', 'O4', 'O5'][sub];
          if (key) this.q.set('OLD' + key, v);
        }
        return;
      }
      if (major === 8 || major === 10 || major === 11 || major === 26 || major === 19) {
        if (sub === 0) this.w.add(`CYCL DEF ${major}(대칭·회전·배율·기울인 평면)은 지원하지 않음`, line);
        return;
      }
      if (sub === 0) this.w.add(`CYCL DEF ${major}은 지원하지 않음`, line);
      return;
    }
    if ([200, 201, 202, 203, 205, 240, 206, 207, 209, 204, 208].includes(major)) {
      this.cycle = { n: major, ok: true };
      if (major === 204 || major === 208) this.w.add(`CYCL DEF ${major}은 드릴처럼(내려가서 올라옴) 그림`, line);
      return;
    }
    // 점 패턴(정의하면 바로 앞 가공 사이클을 점마다 부른다)
    if (major === 220 || major === 221) return this.patternCycle(major, line);
    this.cycle = { n: major, ok: false };
    this.w.add(`CYCL DEF ${num}은 지원하지 않음(호출해도 그리지 않음)`, line);
  }

  /** 지금 위치에서 드릴 사이클 실행 */
  private cycleCall(line: number): void {
    const c = this.cycle;
    if (!c) {
      this.w.add('정의된 드릴 사이클 없이 CYCL CALL', line);
      return;
    }
    if (!c.ok) return;
    const [p0, p1, da] = PLANE_AXES[this.plane]!;
    const Q = (k: string, d: number): number => this.q.get(k) ?? d;
    let setup: number;
    let depth: number;
    let peck: number;
    let surface: number;
    let second: number;
    let feed: number;
    let dwellBottom = 0;
    if (c.n === 1 || c.n === 2 || c.n === 17) {
      // 예전 꼴: 지금 위치가 안전 거리 위
      setup = Math.abs(Q('OLDO1', 2));
      depth = Q('OLDO2', 0);
      peck = c.n === 1 ? Math.abs(Q('OLDO3', 0)) : 0;
      dwellBottom = Q('OLDO4', 0);
      feed = Q('OLDO5', this.feed);
      surface = this.pos[da]! - setup;
      second = setup;
    } else {
      setup = Math.abs(Q('Q200', 2));
      depth = Q('Q201', 0);
      peck = c.n === 200 || c.n === 203 || c.n === 205 ? Math.abs(Q('Q202', 0)) : 0;
      surface = Q('Q203', 0) + this.shift[da]!;
      second = Math.abs(Q('Q204', 0));
      feed = Q('Q206', this.feed || this.autoFeed);
      dwellBottom = Q('Q211', 0);
      if (c.n === 240) depth = Q('Q201', depth);
    }
    if (depth === 0) {
      this.w.add('드릴 사이클 깊이(Q201)가 0', line);
      return;
    }
    const up = depth < 0 ? 1 : -1;
    const rD = surface + up * setup;
    const zD = surface + depth;
    const clear = surface + up * Math.max(setup, second);
    const saveFeed = this.feed;
    const pt = [0, 0, 0];
    const go = (kind: number, d: number): void => {
      pt[p0] = this.pos[p0]!;
      pt[p1] = this.pos[p1]!;
      pt[da] = d;
      this.emit(kind, pt[0]!, pt[1]!, pt[2]!, line, FLAG_CYCLE);
    };
    go(MOVE_RAPID, rD);
    this.feed = feed;
    const first = this.mb.count;
    if (peck > 0) {
      // 절입 깊이는 공작물 윗면(Q203)부터 잰다
      let d = surface;
      let first = true;
      let guard = 0;
      while (up * (d - zD) > 1e-9 && guard++ < 10000) {
        const next = up > 0 ? Math.max(zD, d - peck) : Math.min(zD, d + peck);
        if (!first) go(MOVE_RAPID, d + up * Math.min(setup, 0.5));
        go(MOVE_DRILL, next);
        if (next !== zD) go(MOVE_RAPID, rD);
        d = next;
        first = false;
      }
    } else go(MOVE_DRILL, zD);
    this.dwell(dwellBottom);
    if (c.n === 201 || c.n === 206 || c.n === 207 || c.n === 209 || c.n === 2 || c.n === 17) go(MOVE_FEED, rD);
    go(MOVE_RAPID, clear);
    if (this.mb.count > first) {
      const top = [0, 0, 0];
      top[p0] = this.pos[p0]!;
      top[p1] = this.pos[p1]!;
      top[da] = rD;
      const bottom = [top[0]!, top[1]!, top[2]!];
      bottom[da] = zD;
      this.mb.pushHole(top, bottom, line, this.tool, c.n, first);
    }
    this.feed = saveFeed;
  }

  /** CYCL DEF 220(원 패턴)·221(격자 패턴): 점마다 두 번째 안전 높이로 옮겨 앞 사이클을 부른다 */
  private patternCycle(n: number, line: number): void {
    if (!this.cycle || !this.cycle.ok) {
      this.w.add(`CYCL DEF ${n}: 부를 드릴 사이클이 없음`, line);
      return;
    }
    const Q = (k: string, d = 0): number => this.q.get(k) ?? d;
    const pts: [number, number][] = [];
    if (n === 221) {
      const cols = Math.max(1, Math.round(Q('Q242', 1)));
      const rows = Math.max(1, Math.round(Q('Q243', 1)));
      const rot = (Q('Q224') * Math.PI) / 180;
      const x0 = Q('Q225');
      const y0 = Q('Q226');
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const dx = i * Q('Q237');
          const dy = j * Q('Q238');
          pts.push([x0 + dx * Math.cos(rot) - dy * Math.sin(rot), y0 + dx * Math.sin(rot) + dy * Math.cos(rot)]);
        }
    } else {
      const cx = Q('Q216');
      const cy = Q('Q217');
      const r = Q('Q244') / 2;
      const a0 = Q('Q245');
      const a1 = Q('Q246', 360);
      const cnt = Math.max(1, Math.round(Q('Q241', 1)));
      let step = Q('Q247');
      const full = Math.abs(Math.abs(a1 - a0) - 360) < 1e-9;
      if (!step) step = cnt > 1 ? (a1 - a0) / (full ? cnt : cnt - 1) : 0;
      for (let k = 0; k < cnt; k++) {
        const a = ((a0 + k * step) * Math.PI) / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    const [p0, p1, da] = PLANE_AXES[this.plane]!;
    const clear = Q('Q203') + this.shift[da]! + Math.max(Math.abs(Q('Q200', 2)), Math.abs(Q('Q204')));
    const t = [0, 0, 0];
    for (const [u, v] of pts) {
      t[p0] = this.pos[p0]!;
      t[p1] = this.pos[p1]!;
      t[da] = Math.max(this.pos[da]!, clear);
      this.emit(MOVE_RAPID, t[0]!, t[1]!, t[2]!, line, FLAG_CYCLE);
      t[p0] = u + this.shift[p0]!;
      t[p1] = v + this.shift[p1]!;
      this.emit(MOVE_RAPID, t[0]!, t[1]!, t[2]!, line, FLAG_CYCLE);
      this.known = 7;
      this.cycleCall(line);
    }
  }

  private findLabel(name: string): number {
    if (!this.labels) {
      this.labels = new Map();
      for (let i = 0; i < this.src.lineCount; i++) {
        const m = /^\s*(?:N?\d+\s+)?LBL\s+("?[^"\s;]+"?)/i.exec(sourceLine(this.src, i));
        if (m && !this.labels.has(m[1]!.toUpperCase())) this.labels.set(m[1]!.toUpperCase(), i);
      }
    }
    return this.labels.get(name.toUpperCase()) ?? -1;
  }

  private callLbl(T: string[], line: number): void {
    const name = T[2] ?? '';
    const target = this.findLabel(name);
    if (target < 0) {
      this.w.add(`CALL LBL ${name}: 표지가 없음`, line);
      return;
    }
    const repTok = T.findIndex((x) => /^REP/i.test(x));
    let rep = 0;
    if (repTok >= 0) {
      const v = /^REP(\d+)?/i.exec(T[repTok]!)![1] ?? T[repTok + 1];
      rep = parseInt(v ?? '0', 10) || 0;
    }
    if (target < line) {
      // 구간 반복: LBL과 CALL 사이를 rep번 더
      const left = this.sectionReps.get(line) ?? rep;
      if (left > 0) {
        this.sectionReps.set(line, left - 1);
        this.pc = target + 1;
      } else this.sectionReps.delete(line);
      return;
    }
    if (this.stack.length > 64) {
      this.w.add('부프로그램 호출이 너무 깊음 — 멈춤', line);
      this.ended = true;
      return;
    }
    this.stack.push({ ret: this.pc, reps: Math.max(1, rep + (rep > 0 ? 1 : 0)), start: target + 1 });
    this.pc = target + 1;
  }

  private fn(b: HBlock, line: number): void {
    const m = /^FN\s*(\d+)\s*:\s*(.*)$/i.exec(b.text);
    if (!m) return;
    const k = +m[1]!;
    const body = m[2]!.trim();
    if (k <= 8 || k === 13) {
      const a = /^(Q[LRS]?\d+)\s*=\s*(.+)$/i.exec(body);
      if (!a) return;
      let e = a[2]!;
      if (k === 4) e = e.replace(/\bDIV\b/gi, '/');
      if (k === 5) e = `SQRT(${e.replace(/^SQRT\s*/i, '')})`;
      if (k === 6) e = `SIN(${e.replace(/^SIN\s*/i, '')})`;
      if (k === 7) e = `COS(${e.replace(/^COS\s*/i, '')})`;
      if (k === 8) {
        const [x, y] = e.split(/\bLEN\b/i);
        e = `SQRT((${x})^2+(${y ?? 0})^2)`;
      }
      if (k === 13) {
        const [x, y] = e.split(/\bANG\b/i);
        e = `ATAN2(${y ?? 0},${x})`;
      }
      this.q.set(a[1]!.toUpperCase(), this.expr(e));
      return;
    }
    if (k >= 9 && k <= 12) {
      const c = /^IF\s+(.+?)\s+(EQU|NE|GT|LT)\s+(.+?)\s+GOTO\s+LBL\s+(\S+)/i.exec(body);
      if (!c) return;
      const x = this.value(c[1]!);
      const y = this.value(c[3]!);
      const op = c[2]!.toUpperCase();
      const ok = op === 'EQU' ? Math.abs(x - y) < 1e-9 : op === 'NE' ? Math.abs(x - y) >= 1e-9 : op === 'GT' ? x > y : x < y;
      if (ok) {
        const t = this.findLabel(c[4]!);
        if (t >= 0) this.pc = t + 1;
        else this.w.add(`FN ${k}: LBL ${c[4]}이 없음`, line);
      }
      return;
    }
    if (k === 14) {
      this.w.add('FN 14 오류 신호 — 멈춤', line);
      this.ended = true;
      return;
    }
    this.w.add(`FN ${k}은 지원하지 않음`, line);
  }

  private qAssign(text: string): void {
    const a = /^(Q[LRS]?\d+)\s*=\s*(.+)$/i.exec(text);
    // QS(글 변수)는 좌표에 쓰이지 않는다
    if (!a || /^QS/i.test(a[1]!) || a[2]!.trim().startsWith('"')) return;
    this.q.set(a[1]!.toUpperCase(), this.value(a[2]!));
  }

  /** M 낱말 처리. 블록 끝에서 할 일(M99 사이클 호출)은 afterMove로 */
  private mWords(T: string[], line: number, inCycleCall: boolean): { m99: boolean } {
    let m99 = false;
    for (const w of T) {
      const m = /^M(\d+)$/i.exec(w);
      if (!m) continue;
      const n = +m[1]!;
      if (n === 3 || n === 13) this.spindleDir = 3;
      else if (n === 4 || n === 14) this.spindleDir = 4;
      else if (n === 5 || n === 0) this.spindleDir = 0;
      if (n === 7 || n === 8 || n === 13 || n === 14) this.coolant = true;
      else if (n === 9) this.coolant = false;
      else if (n === 99) m99 = !inCycleCall;
      else if (n === 89) this.modalCall = true;
      else if (n === 2 || n === 30) {
        // 부프로그램(LBL)이 M30 뒤에 오는 것이 흔하다 — 끝
        this.ended = true;
      } else if (n === 140) this.w.add('M140(공구 축 방향 물러나기)은 그리지 않음', line);
    }
    return { m99 };
  }

  /** 낱말에서 좌표 읽기(I 증분, Q 변수, 원점 이동 반영). 주어지지 않은 축은 undefined */
  private coords(T: string[]): (number | undefined)[] {
    const out: (number | undefined)[] = [undefined, undefined, undefined];
    for (const w of T.slice(1)) {
      const m = /^(I?)([XYZ])([+-]?[\d.]*Q?[LRS]?\d*[\d.]*)$/i.exec(w);
      if (!m || m[3] === '') continue;
      const a = AXES.indexOf(m[2]!.toUpperCase());
      const v = this.value(m[3]!);
      out[a] = m[1] ? this.pos[a]! + v : v + this.shift[a]!;
    }
    return out;
  }

  /** 반경 보정·이송·M 낱말 */
  private modal(T: string[], line: number): { rapid: boolean; m99: boolean; machine: boolean } {
    let rapid = false;
    let machine = false;
    for (let i = 1; i < T.length; i++) {
      const w = T[i]!.toUpperCase();
      if (w === 'R0') this.comp = 0;
      else if (w === 'RL') this.comp = 1;
      else if (w === 'RR') this.comp = 2;
      else if (w === 'FMAX') rapid = true;
      else if (w === 'FAUTO' || (w === 'F' && (T[i + 1] ?? '').toUpperCase() === 'AUTO')) this.feed = this.autoFeed;
      else if (/^F[+-]?[\d.]+$/.test(w) || /^F[+-]?Q/.test(w)) this.feed = this.value(w.slice(1));
      else if (w === 'M91' || w === 'M92') machine = true;
    }
    const { m99 } = this.mWords(T, line, false);
    return { rapid, m99, machine };
  }

  private afterMove(m99: boolean, line: number): void {
    if (m99 || this.modalCall) this.cycleCall(line);
  }

  private setDir(x0: number, y0: number, x1: number, y1: number): void {
    const l = Math.hypot(x1 - x0, y1 - y0);
    if (l > 1e-12) this.lastDir = [(x1 - x0) / l, (y1 - y0) / l];
  }

  private linear(T: string[], line: number): void {
    const c = this.coords(T);
    const { rapid, m99, machine } = this.modal(T, line);
    const [a0, a1] = PLANE_AXES[this.plane]!;
    const s0 = this.pos[a0]!;
    const s1 = this.pos[a1]!;
    const x = c[0] ?? this.pos[0]!;
    const y = c[1] ?? this.pos[1]!;
    const z = c[2] ?? this.pos[2]!;
    if (c.some((v) => v !== undefined)) {
      this.emit(rapid ? MOVE_RAPID : MOVE_FEED, x, y, z, line, machine ? FLAG_MACHINE : 0);
      this.known |= (c[0] !== undefined ? 1 : 0) | (c[1] !== undefined ? 2 : 0) | (c[2] !== undefined ? 4 : 0);
      this.setDir(s0, s1, this.pos[a0]!, this.pos[a1]!);
    }
    this.afterMove(m99, line);
  }

  private pole(T: string[]): void {
    const [a0, a1] = PLANE_AXES[this.plane]!;
    let u = this.pos[a0]!;
    let v = this.pos[a1]!;
    for (const w of T.slice(1)) {
      const m = /^(I?)([XYZ])(.+)$/i.exec(w);
      if (!m) continue;
      const a = AXES.indexOf(m[2]!.toUpperCase());
      const val = this.value(m[3]!);
      const abs = m[1] ? this.pos[a]! + val : val + this.shift[a]!;
      if (a === a0) u = abs;
      else if (a === a1) v = abs;
    }
    this.cc = [u, v];
  }

  private drWord(T: string[]): number {
    for (const w of T) {
      const u = w.toUpperCase();
      if (u === 'DR+') return 1;
      if (u === 'DR-') return -1;
    }
    return this.dr;
  }

  private arcTo(cu: number, cv: number, ccw: boolean, x: number, y: number, z: number, line: number, extraTurns = 0): void {
    const [a0, a1, a2] = PLANE_AXES[this.plane]!;
    const s = [this.pos[0]!, this.pos[1]!, this.pos[2]!];
    const e = [x, y, z];
    const u0 = s[a0]! - cu;
    const v0 = s[a1]! - cv;
    const u1 = e[a0]! - cu;
    const v1 = e[a1]! - cv;
    const r0 = Math.hypot(u0, v0);
    if (r0 < 1e-9) {
      this.w.add('원호 반지름이 0 — 직선으로 그림', line);
      this.emit(MOVE_FEED, x, y, z, line);
      return;
    }
    if (Math.abs(r0 - Math.hypot(u1, v1)) > Math.max(this.tol, r0 * 1e-3)) this.w.add('원호 시작·끝 반지름이 다름(나선형으로 이어 그림)', line);
    const TAU = Math.PI * 2;
    const same = Math.hypot(u1 - u0, v1 - v0) <= Math.max(1e-7, r0 * 1e-9);
    let sweep = Math.atan2(v1, u1) - Math.atan2(v0, u0);
    if (ccw) {
      if (same) sweep = TAU;
      else while (sweep <= 0) sweep += TAU;
    } else if (same) sweep = -TAU;
    else while (sweep >= 0) sweep -= TAU;
    sweep += (ccw ? 1 : -1) * TAU * extraTurns;
    const c = [0, 0, 0];
    c[a0] = cu;
    c[a1] = cv;
    c[a2] = s[a2]!;
    this.emitArc(this.plane, c, sweep, x, y, z, line);
    // 끝 접선
    const t = Math.atan2(v1, u1) + (ccw ? Math.PI / 2 : -Math.PI / 2);
    this.lastDir = [Math.cos(t), Math.sin(t)];
  }

  private circle(T: string[], line: number): void {
    const c = this.coords(T);
    const { m99 } = this.modal(T, line);
    this.dr = this.drWord(T);
    if (!this.cc) {
      this.w.add('C(원호)에 극(CC)이 없음 — 직선으로 그림', line);
      this.emit(MOVE_FEED, c[0] ?? this.pos[0]!, c[1] ?? this.pos[1]!, c[2] ?? this.pos[2]!, line);
    } else this.arcTo(this.cc[0], this.cc[1], this.dr > 0, c[0] ?? this.pos[0]!, c[1] ?? this.pos[1]!, c[2] ?? this.pos[2]!, line);
    this.afterMove(m99, line);
  }

  private circleR(T: string[], line: number): void {
    const c = this.coords(T);
    const { m99 } = this.modal(T, line);
    this.dr = this.drWord(T);
    const rTok = T.slice(1).find((w) => /^R[+-]?[\d.Q]/i.test(w) && !/^R[LR0]$/i.test(w));
    const x = c[0] ?? this.pos[0]!;
    const y = c[1] ?? this.pos[1]!;
    const z = c[2] ?? this.pos[2]!;
    if (!rTok) {
      this.w.add('CR에 반지름 R이 없음 — 직선으로 그림', line);
      this.emit(MOVE_FEED, x, y, z, line);
      return this.afterMove(m99, line);
    }
    const R = this.value(rTok.slice(1));
    const [a0, a1] = PLANE_AXES[this.plane]!;
    const e = [x, y, z];
    const su = this.pos[a0]!;
    const sv = this.pos[a1]!;
    const du = e[a0]! - su;
    const dv = e[a1]! - sv;
    const d = Math.hypot(du, dv);
    if (d < 1e-9) {
      this.w.add('CR로는 완전한 원을 만들 수 없음', line);
      return this.afterMove(m99, line);
    }
    let r = Math.abs(R);
    if (d / 2 > r) r = d / 2;
    const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
    const ccw = this.dr > 0;
    const side = (ccw ? 1 : -1) * (R < 0 ? -1 : 1);
    const cu = su + du / 2 - (side * h * dv) / d;
    const cv = sv + dv / 2 + (side * h * du) / d;
    this.arcTo(cu, cv, ccw, x, y, z, line);
    this.afterMove(m99, line);
  }

  private circleT(T: string[], line: number): void {
    const c = this.coords(T);
    const { m99 } = this.modal(T, line);
    const x = c[0] ?? this.pos[0]!;
    const y = c[1] ?? this.pos[1]!;
    const z = c[2] ?? this.pos[2]!;
    const [a0, a1] = PLANE_AXES[this.plane]!;
    const t = this.lastDir;
    const e = [x, y, z];
    const su = this.pos[a0]!;
    const sv = this.pos[a1]!;
    const wu = su - e[a0]!;
    const wv = sv - e[a1]!;
    if (!t) {
      this.w.add('CT 앞에 방향을 정할 요소가 없음 — 직선으로 그림', line);
      this.emit(MOVE_FEED, x, y, z, line);
      return this.afterMove(m99, line);
    }
    // 중심 = 시작 + n·k (n = 접선의 왼쪽 법선), |중심 - 끝| = |k|
    const nu = -t[1];
    const nv = t[0];
    const dot = nu * wu + nv * wv;
    if (Math.abs(dot) < 1e-12) {
      this.emit(MOVE_FEED, x, y, z, line);
      this.setDir(su, sv, e[a0]!, e[a1]!);
      return this.afterMove(m99, line);
    }
    const k = -(wu * wu + wv * wv) / (2 * dot);
    this.arcTo(su + nu * k, sv + nv * k, k > 0, x, y, z, line);
    this.afterMove(m99, line);
  }

  private polarParams(T: string[]): { pr?: number; ipr?: number; pa?: number; ipa?: number } {
    const o: { pr?: number; ipr?: number; pa?: number; ipa?: number } = {};
    for (const w of T.slice(1)) {
      const m = /^(I?)(PR|PA)(.+)$/i.exec(w);
      if (!m) continue;
      const v = this.value(m[3]!);
      const key = ((m[1] ? 'i' : '') + m[2]!.toLowerCase()) as 'pr' | 'ipr' | 'pa' | 'ipa';
      o[key] = v;
    }
    return o;
  }

  private linearPolar(T: string[], line: number): void {
    const { rapid, m99 } = this.modal(T, line);
    if (!this.cc) {
      this.w.add('LP에 극(CC)이 없음', line);
      return this.afterMove(m99, line);
    }
    const [a0, a1, a2] = PLANE_AXES[this.plane]!;
    const p = this.polarParams(T);
    const cu = this.cc[0];
    const cv = this.cc[1];
    const r0 = Math.hypot(this.pos[a0]! - cu, this.pos[a1]! - cv);
    const t0 = (Math.atan2(this.pos[a1]! - cv, this.pos[a0]! - cu) * 180) / Math.PI;
    const r = p.pr ?? r0 + (p.ipr ?? 0);
    const a = ((p.pa ?? t0 + (p.ipa ?? 0)) * Math.PI) / 180;
    const c = this.coords(T);
    const e = [this.pos[0]!, this.pos[1]!, this.pos[2]!];
    e[a0] = cu + r * Math.cos(a);
    e[a1] = cv + r * Math.sin(a);
    if (c[a2] !== undefined) e[a2] = c[a2]!;
    const su = this.pos[a0]!;
    const sv = this.pos[a1]!;
    this.emit(rapid ? MOVE_RAPID : MOVE_FEED, e[0]!, e[1]!, e[2]!, line);
    this.known = 7;
    this.setDir(su, sv, e[a0]!, e[a1]!);
    this.afterMove(m99, line);
  }

  private circlePolar(T: string[], line: number): void {
    const { m99 } = this.modal(T, line);
    this.dr = this.drWord(T);
    if (!this.cc) {
      this.w.add('CP에 극(CC)이 없음', line);
      return this.afterMove(m99, line);
    }
    const [a0, a1, a2] = PLANE_AXES[this.plane]!;
    const p = this.polarParams(T);
    const cu = this.cc[0];
    const cv = this.cc[1];
    const r = Math.hypot(this.pos[a0]! - cu, this.pos[a1]! - cv);
    const t0 = Math.atan2(this.pos[a1]! - cv, this.pos[a0]! - cu);
    const c = this.coords(T);
    const e = [this.pos[0]!, this.pos[1]!, this.pos[2]!];
    if (c[a2] !== undefined) e[a2] = c[a2]!;
    if (p.ipa !== undefined) {
      // 증분 각: 여러 바퀴(나선) 가능
      const sweep = (p.ipa * Math.PI) / 180;
      const t1 = t0 + sweep;
      e[a0] = cu + r * Math.cos(t1);
      e[a1] = cv + r * Math.sin(t1);
      const cc = [0, 0, 0];
      cc[a0] = cu;
      cc[a1] = cv;
      cc[a2] = this.pos[a2]!;
      this.emitArc(this.plane, cc, sweep, e[0]!, e[1]!, e[2]!, line);
      const tt = t1 + (sweep > 0 ? Math.PI / 2 : -Math.PI / 2);
      this.lastDir = [Math.cos(tt), Math.sin(tt)];
    } else {
      const a = p.pa !== undefined ? (p.pa * Math.PI) / 180 : t0;
      e[a0] = cu + r * Math.cos(a);
      e[a1] = cv + r * Math.sin(a);
      this.arcTo(cu, cv, this.dr > 0, e[0]!, e[1]!, e[2]!, line);
    }
    this.afterMove(m99, line);
  }

  finish(): NcProgram {
    return this.build({ name: this.o.name ?? (this.name || 'Heidenhain'), format: 'heidenhain', dialect: 'heidenhain', blocks: this.blocks, stock: this.stock });
  }

}

function indexOutsideQuotes(s: string, ch: string): number {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') q = !q;
    else if (c === ch && !q) return i;
  }
  return -1;
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[0]);
  // "Q1 = 5" 꼴을 한 낱말로 붙이지는 않는다(qAssign은 글 전체를 본다)
  return out;
}

/** 'R+5', 'S3000' 꼴에서 글자 뒤 값 */
function findWord(T: string[], letter: string): string | undefined {
  const re = new RegExp(`^${letter}([+-]?(?:[\\d.]+|Q[LRS]?\\d+))$`, 'i');
  for (const w of T) {
    const m = re.exec(w);
    if (m) return m[1];
  }
  return undefined;
}

/** Heidenhain 평문을 해석한다 */
export function parseHeidenhain(input: Uint8Array | ArrayBuffer | string | NcSource, opts: HeidenhainOptions = {}): NcProgram {
  const src = isSource(input) ? input : makeSource(input);
  const r = new HRunner(src, opts);
  r.run();
  return r.finish();
}
