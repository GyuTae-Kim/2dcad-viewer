/**
 * woodWOP MPR(4.x 글 형식, Homag·Weeke 가구 CNC) 해석기.
 *
 * 파일 구조(한 줄에 한 항목, `!`로 끝):
 * - `[H` 머리(VERSION, INCH 단위, _BSX/_BSY/_BSZ 계산된 판 크기 등)
 * - `[0…` 변수표: `이름="식"` 다음 줄 `KM="설명"`. 식에는 앞서 나온 변수만 쓴다
 * - `[K` 좌표계(읽지 않음 — 경고)
 * - `]n` 윤곽 n: `$Em` 요소 머리 + 종류 줄(KP 점·KL 선·KA 호·KR 둥글리기·KF 모따기·KSL/KSA 나눔) + `X=…` 값.
 *   `.X=` 처럼 점으로 시작하는 값은 woodWOP가 계산해 둔 값(외부 프로그램이 쓴 파일은 틀릴 수 있어 검산에만 쓴다)
 * - `<번호 \이름\` 가공 매크로: 100 WerkStck(LA·BR·DI), 101 Kommentar, 102 BohrVert, 103 BohrHoriz,
 *   105 Konturfraesen, 109 Nuten, 112 Tasche …
 *
 * 좌표: 판 왼쪽 아래(앞) 모서리의 밑면이 원점, X = 길이(LA), Y = 폭(BR), Z = 두께 방향 위(윗면 Z = DI).
 * 구멍·홈 깊이(TI)는 윗면에서 잰다. 호 KA: DS=0 시계, DS=1 반시계, R 반지름(.I/.J = 계산된 중심).
 * 조건 `??`가 0이거나 EN=0인 가공은 꺼진 것으로 둔다.
 */
import { ExprError, evalMprExpr } from './expr';
import { NcWarnings, type PathPoint } from './model';
import { guessEncoding } from './text';

export interface MprContourElement extends PathPoint {
  /** KP, KL, KA, KR, KF, KSL, KSA */
  type: string;
  /** $E 번호 */
  index: number;
  /** 원본 줄(0부터, $E 줄) */
  line: number;
  radius?: number;
  dir?: 'cw' | 'ccw';
}

export interface MprContour {
  id: number;
  line: number;
  elements: MprContourElement[];
}

export interface MprHole {
  /** 들어가기 시작하는 점(판 겉면) */
  start: [number, number, number];
  /** 들어가는 방향(단위 벡터) */
  dir: [number, number, number];
  /** 그릴 깊이(판 안으로 자른 값) */
  depth: number;
}

interface OpBase {
  macroId: number;
  macro: string;
  /** 사람이 읽는 이름(MNM·KM 또는 매크로 이름) */
  label: string;
  /** `<` 머리 줄(0부터) */
  line: number;
  endLine: number;
  enabled: boolean;
  tool?: number;
  /** 원래 값(글) */
  params: Record<string, string>;
}

export interface MprDrillOp extends OpBase {
  kind: 'drillV' | 'drillH';
  holes: MprHole[];
  diameter: number;
  /** TI 깊이 */
  depth: number;
  through: boolean;
  /** BM 값(LS, XP 등) */
  mode?: string;
}

export interface MprContourOp extends OpBase {
  kind: 'contour';
  contour?: number;
  startElement?: number;
  endElement?: number;
  comp: 'left' | 'right' | 'none';
  feed?: number;
  /** 공구 경로(가공 깊이 반영) */
  path?: PathPoint[];
}

export interface MprBoxOp extends OpBase {
  kind: 'groove' | 'pocket';
  depth: number;
  width?: number;
  length?: number;
  /** 방향 있는 상자: 모서리 origin과 세 변 u·v·w */
  box?: { origin: number[]; u: number[]; v: number[]; w: number[] };
}

export interface MprOtherOp extends OpBase {
  kind: 'comment' | 'other';
}

export type MprOperation = MprDrillOp | MprContourOp | MprBoxOp | MprOtherOp;

export interface MprWorkpiece {
  length: number;
  width: number;
  thickness: number;
  line: number;
}

export interface MprVariable {
  name: string;
  expr: string;
  value?: number;
  comment?: string;
  line: number;
}

export interface MprPart {
  name: string;
  version?: string;
  units: 'mm' | 'inch';
  header: Record<string, string>;
  variables: MprVariable[];
  workpiece?: MprWorkpiece;
  contours: MprContour[];
  operations: MprOperation[];
  /** 원본 줄 */
  lines: string[];
  stats: { holes: number; drillOps: number; contourOps: number; grooves: number; pockets: number; disabled: number; other: number };
  warnings: string[];
}

export interface MprOptions {
  name?: string;
}

type Section = { kind: 'none' } | { kind: 'header' } | { kind: 'vars' } | { kind: 'coords' } | { kind: 'contour'; c: MprContour } | { kind: 'macro'; m: RawMacro };

interface RawMacro {
  id: number;
  name: string;
  line: number;
  endLine: number;
  params: Record<string, string>;
  comments: string[];
}

/** 한 줄 `KEY=VALUE` (따옴표 값이면 따옴표를 뗀다) */
function keyValue(line: string): [string, string] | null {
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z0-9_.?$@]+$/.test(key)) return null;
  let v = line.slice(eq + 1).trim();
  if (v.startsWith('"')) {
    const e = v.lastIndexOf('"');
    v = e > 0 ? v.slice(1, e) : v.slice(1);
  } else {
    // 따옴표 밖의 \ 뒤는 주석
    const c = v.indexOf('\\');
    if (c >= 0) v = v.slice(0, c).trim();
  }
  return [key, v];
}

const MACRO_KIND: Record<string, MprOperation['kind'] | 'workpiece'> = {
  werkstck: 'workpiece',
  kommentar: 'comment',
  bohrvert: 'drillV',
  bohrhoriz: 'drillH',
  konturfraesen: 'contour',
  nuten: 'groove',
  tasche: 'pocket',
};

/** MPR 글·바이트를 읽는다 */
export function parseMpr(input: Uint8Array | ArrayBuffer | string, opts: MprOptions = {}): MprPart {
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    text = new TextDecoder(guessEncoding(b)).decode(b);
  }
  const w = new NcWarnings();
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const header: Record<string, string> = {};
  const variables: MprVariable[] = [];
  const contours: MprContour[] = [];
  const macros: RawMacro[] = [];
  let sec: Section = { kind: 'none' };
  let curElem: { index: number; line: number; type: string; vals: Record<string, string> } | null = null;
  const elemRaw = new Map<MprContour, { index: number; line: number; type: string; vals: Record<string, string> }[]>();
  const closeElem = (): void => {
    if (curElem && sec.kind === 'contour') elemRaw.get(sec.c)!.push(curElem);
    curElem = null;
  };
  let ended = false;
  for (let i = 0; i < lines.length && !ended; i++) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('\\')) continue;
    if (t === '!' || t.startsWith('!')) {
      closeElem();
      ended = true;
      break;
    }
    if (t.startsWith('[')) {
      closeElem();
      const k = t.slice(1).trim();
      if (/^H/i.test(k)) sec = { kind: 'header' };
      else if (/^K/i.test(k)) {
        sec = { kind: 'coords' };
        w.add('좌표계 표([K)는 읽지 않음 — 기본 좌표계(위 면)로 봄', i);
      } else if (/^\d/.test(k)) sec = { kind: 'vars' };
      else sec = { kind: 'none' };
      continue;
    }
    if (t.startsWith(']')) {
      closeElem();
      const id = parseInt(t.slice(1), 10);
      const c: MprContour = { id: Number.isFinite(id) ? id : contours.length + 1, line: i, elements: [] };
      contours.push(c);
      elemRaw.set(c, []);
      sec = { kind: 'contour', c };
      continue;
    }
    if (t.startsWith('<')) {
      closeElem();
      if (sec.kind === 'macro') sec.m.endLine = i - 1;
      const m = /^<\s*(\d+)\s*\\([^\\]*)\\?/.exec(t);
      const mac: RawMacro = { id: m ? +m[1]! : -1, name: m ? m[2]!.trim() : t.slice(1).trim(), line: i, endLine: i, params: {}, comments: [] };
      macros.push(mac);
      sec = { kind: 'macro', m: mac };
      continue;
    }
    switch (sec.kind) {
      case 'header': {
        const kv = keyValue(t);
        if (kv) header[kv[0]] = kv[1];
        break;
      }
      case 'vars': {
        const kv = keyValue(t);
        if (!kv) break;
        if (kv[0] === 'KM') {
          const last = variables[variables.length - 1];
          if (last && last.comment === undefined) last.comment = kv[1];
        } else variables.push({ name: kv[0], expr: kv[1], line: i });
        break;
      }
      case 'contour': {
        if (t.startsWith('$E')) {
          closeElem();
          curElem = { index: parseInt(t.slice(2), 10), line: i, type: '', vals: {} };
          break;
        }
        if (!curElem) break;
        const kv = keyValue(t);
        if (kv) curElem.vals[kv[0]] = kv[1];
        else if (!curElem.type && /^[A-Z]+$/.test(t)) curElem.type = t;
        break;
      }
      case 'macro': {
        const kv = keyValue(t);
        if (!kv) break;
        if (kv[0] === 'KM') sec.m.comments.push(kv[1]);
        if (!(kv[0] in sec.m.params)) sec.m.params[kv[0]] = kv[1];
        sec.m.endLine = i;
        break;
      }
      default:
        break;
    }
  }
  closeElem();

  // 변수 계산
  const env = new Map<string, number>();
  const envLower = new Map<string, number>();
  const setEnv = (k: string, v: number): void => {
    env.set(k, v);
    envLower.set(k.toLowerCase(), v);
  };
  for (const [k, v] of Object.entries(header)) {
    const n = Number(v);
    if (k.startsWith('_') && v !== '' && Number.isFinite(n)) setEnv(k, n);
  }
  const lookup = { get: (name: string): number | undefined => env.get(name) ?? envLower.get(name.toLowerCase()) };
  const evalExpr = (expr: string, line: number, what: string): number | undefined => {
    const e = expr.trim();
    if (e === '') return undefined;
    const n = Number(e);
    if (Number.isFinite(n)) return n;
    try {
      const v = evalMprExpr(e, lookup);
      if (!Number.isFinite(v)) throw new ExprError('값이 수가 아님');
      return v;
    } catch (err) {
      if (!(err instanceof ExprError)) throw err;
      w.add(`${what} 식 "${e}"을 계산할 수 없음 — ${err.message}`, line);
      return undefined;
    }
  };
  for (const v of variables) {
    const val = evalExpr(v.expr, v.line, `변수 ${v.name}`);
    if (val !== undefined) {
      v.value = val;
      setEnv(v.name, val);
    }
  }

  const units: 'mm' | 'inch' = header.INCH === '1' ? 'inch' : 'mm';

  // 공작물
  let workpiece: MprWorkpiece | undefined;
  for (const m of macros)
    if (m.name.toLowerCase() === 'werkstck' || m.id === 100) {
      const L = evalExpr(m.params.LA ?? '', m.line, 'LA');
      const B = evalExpr(m.params.BR ?? '', m.line, 'BR');
      const D = evalExpr(m.params.DI ?? '', m.line, 'DI');
      if (L !== undefined && B !== undefined && D !== undefined) workpiece = { length: L, width: B, thickness: D, line: m.line };
      break;
    }
  if (!workpiece) {
    const L = Number(header._BSX);
    const B = Number(header._BSY);
    const D = Number(header._BSZ);
    if (L > 0 && B > 0 && D > 0) workpiece = { length: L, width: B, thickness: D, line: -1 };
    else w.add('공작물(WerkStck) 크기를 알 수 없음');
  }
  const thick = workpiece?.thickness ?? 0;
  if (workpiece) {
    // woodWOP 식에서 흔히 쓰는 판 크기 이름
    for (const [k, v] of [
      ['_BSX', workpiece.length],
      ['_BSY', workpiece.width],
      ['_BSZ', workpiece.thickness],
    ] as const)
      if (!env.has(k)) setEnv(k, v);
  }

  // 윤곽 요소 계산
  for (const c of contours) {
    let px = 0;
    let py = 0;
    let pz = 0;
    let first = true;
    for (const e of elemRaw.get(c) ?? []) {
      const num = (key: string, dflt: number): number => {
        // 값이 없으면 woodWOP가 계산해 둔 .값, 그것도 없으면 앞 값
        const v = e.vals[key] ?? e.vals['.' + key];
        if (v === undefined) return dflt;
        return evalExpr(v, e.line, `윤곽 ${c.id} 요소 ${e.index} ${key}`) ?? dflt;
      };
      const type = e.type.toUpperCase();
      const x = num('X', px);
      const y = num('Y', py);
      const z = num('Z', pz);
      const el: MprContourElement = { type, index: e.index, line: e.line, x, y, z };
      if (type === 'KP' || first) {
        if (type !== 'KP') w.add(`윤곽 ${c.id}이 시작점(KP) 없이 시작함`, e.line);
      } else if (type === 'KA' || type === 'KSA') {
        const ds = num('DS', 0);
        const ccw = ds === 1;
        el.dir = ccw ? 'ccw' : 'cw';
        const arc = arcFrom(px, py, x, y, ccw, e.vals, (k) => (e.vals[k] === undefined ? undefined : num(k, 0)));
        if (arc) {
          el.arc = { cx: arc.cx, cy: arc.cy, sweep: arc.sweep };
          el.radius = arc.r;
        } else w.add(`윤곽 ${c.id} 요소 ${e.index}: 호 중심을 정할 수 없어 직선으로 그림`, e.line);
      } else if (type === 'KR' || type === 'KF') {
        w.add(`윤곽 요소 ${type}(모서리 둥글리기·모따기)는 모서리 그대로 그림`, e.line);
        continue;
      } else if (type !== 'KL' && type !== 'KSL') w.add(`알 수 없는 윤곽 요소 ${type || '(종류 없음)'}`, e.line);
      c.elements.push(el);
      px = x;
      py = y;
      pz = z;
      first = false;
    }
  }

  // 가공
  const operations: MprOperation[] = [];
  const stats = { holes: 0, drillOps: 0, contourOps: 0, grooves: 0, pockets: 0, disabled: 0, other: 0 };
  for (const m of macros) {
    const kind = MACRO_KIND[m.name.toLowerCase()];
    if (kind === 'workpiece') continue;
    const p = m.params;
    const num = (key: string, dflt?: number): number | undefined => {
      const v = p[key];
      if (v === undefined || v === '') return dflt;
      return evalExpr(v, m.line, `${m.name} ${key}`) ?? dflt;
    };
    let enabled = true;
    if (p['??'] !== undefined && num('??', 1) === 0) enabled = false;
    if (p.EN !== undefined && num('EN', 1) === 0) enabled = false;
    const label = p.MNM || m.comments.join(' ') || m.name;
    const tno = num('TNO');
    const base: OpBase = { macroId: m.id, macro: m.name, label, line: m.line, endLine: m.endLine, enabled, params: p };
    if (tno !== undefined) base.tool = tno;
    if (!enabled) stats.disabled++;
    const ko = (p.KO ?? '00').trim();
    if (ko !== '' && ko !== '00' && ko !== '0' && (kind === 'drillV' || kind === 'drillH' || kind === 'groove' || kind === 'pocket'))
      w.add(`좌표계 KO=${ko}는 기본 좌표계(위 면)로 봄`, m.line);
    switch (kind) {
      case 'drillV': {
        const x0 = num('XA', 0)!;
        const y0 = num('YA', 0)!;
        const du = num('DU', 0)!;
        const ti = num('TI', 0)!;
        const an = Math.max(1, Math.round(num('AN', 1)!));
        const ab = num('AB', 32)!;
        const wi = (num('WI', 0)! * Math.PI) / 180;
        const mi = num('MI', 0)!;
        const holes: MprHole[] = [];
        const depth = thick > 0 ? Math.min(ti, thick) : ti;
        const shift = mi === 1 ? -((an - 1) * ab) / 2 : 0;
        for (let k = 0; k < an; k++) {
          const d = shift + k * ab;
          holes.push({ start: [x0 + d * Math.cos(wi), y0 + d * Math.sin(wi), thick], dir: [0, 0, -1], depth });
        }
        if (!(du > 0)) w.add('BohrVert 지름(DU)이 0', m.line);
        operations.push({ ...base, kind: 'drillV', holes, diameter: du, depth: ti, through: thick > 0 && ti >= thick - 1e-9, mode: p.BM });
        if (enabled) {
          stats.drillOps++;
          stats.holes += holes.length;
        }
        break;
      }
      case 'drillH': {
        const x0 = num('XA', 0)!;
        const y0 = num('YA', 0)!;
        const z0 = num('ZA', thick / 2)!;
        const du = num('DU', 0)!;
        const ti = num('TI', 0)!;
        const an = Math.max(1, Math.round(num('AN', 1)!));
        const ab = num('AB', 32)!;
        const bm = (p.BM ?? '').toUpperCase();
        let dir: [number, number, number];
        if (bm === 'XP') dir = [1, 0, 0];
        else if (bm === 'XM') dir = [-1, 0, 0];
        else if (bm === 'YP') dir = [0, 1, 0];
        else if (bm === 'YM') dir = [0, -1, 0];
        else {
          w.add(`BohrHoriz 방향 BM="${p.BM ?? ''}"을 몰라 X+로 봄`, m.line);
          dir = [1, 0, 0];
        }
        // 판 가장자리에서 바깥으로 향하면 뒤집는다(방향 뜻이 반대인 파일 대비)
        if (workpiece) {
          const out =
            (dir[0] > 0 && x0 >= workpiece.length - 1e-6) || (dir[0] < 0 && x0 <= 1e-6) || (dir[1] > 0 && y0 >= workpiece.width - 1e-6) || (dir[1] < 0 && y0 <= 1e-6);
          if (out) {
            dir = [dir[0] ? -dir[0] : 0, dir[1] ? -dir[1] : 0, 0];
            w.add('BohrHoriz 방향이 판 밖을 향해 반대로 뒤집어 그림', m.line);
          }
        }
        const step: [number, number] = dir[0] !== 0 ? [0, 1] : [1, 0];
        const holes: MprHole[] = [];
        const lim = workpiece ? (dir[0] !== 0 ? workpiece.length : workpiece.width) : Infinity;
        const depth = Math.min(ti, lim);
        for (let k = 0; k < an; k++) holes.push({ start: [x0 + step[0] * k * ab, y0 + step[1] * k * ab, z0], dir, depth });
        operations.push({ ...base, kind: 'drillH', holes, diameter: du, depth: ti, through: depth < ti, mode: p.BM });
        if (enabled) {
          stats.drillOps++;
          stats.holes += holes.length;
        }
        break;
      }
      case 'contour': {
        const op = contourOp(base, p, contours, thick, num, w);
        operations.push(op);
        if (enabled) stats.contourOps++;
        break;
      }
      case 'groove': {
        const xa = num('XA', 0)!;
        const ya = num('YA', 0)!;
        let xe = num('XE');
        let ye = num('YE');
        if (xe === undefined || ye === undefined) {
          const la = num('LA');
          const wi = (num('WI', 0)! * Math.PI) / 180;
          if (la !== undefined) {
            xe = xa + la * Math.cos(wi);
            ye = ya + la * Math.sin(wi);
          }
        }
        const nb = num('NB', 4)!;
        const ti = num('TI', num('ZA', 0))!;
        const op: MprBoxOp = { ...base, kind: 'groove', depth: ti, width: nb };
        if (xe !== undefined && ye !== undefined) {
          const len = Math.hypot(xe - xa, ye - ya);
          if (len > 0) {
            const dx = (xe - xa) / len;
            const dy = (ye - ya) / len;
            const rk = (p.RK ?? '').toUpperCase();
            const c = rk === 'WRKL' ? nb / 2 : rk === 'WRKR' ? -nb / 2 : 0;
            const depth = thick > 0 ? Math.min(ti, thick) : ti;
            const z0 = thick - depth;
            const off = c - nb / 2;
            op.length = len;
            op.box = { origin: [xa - dy * off, ya + dx * off, z0], u: [dx * len, dy * len, 0], v: [-dy * nb, dx * nb, 0], w: [0, 0, depth] };
          }
        } else w.add('Nuten 끝점(XE·YE 또는 LA)이 없음', m.line);
        operations.push(op);
        if (enabled) stats.grooves++;
        break;
      }
      case 'pocket': {
        const xa = num('XA', 0)!;
        const ya = num('YA', 0)!;
        const la = num('LA', 0)!;
        const br = num('BR', 0)!;
        const ti = num('TI', 0)!;
        const wi = (num('WI', 0)! * Math.PI) / 180;
        const op: MprBoxOp = { ...base, kind: 'pocket', depth: ti, width: br, length: la };
        if (la > 0 && br > 0) {
          const c = Math.cos(wi);
          const s = Math.sin(wi);
          const depth = thick > 0 ? Math.min(ti, thick) : ti;
          // XA·YA = 포켓 중심(추정)
          op.box = {
            origin: [xa - (c * la) / 2 + (s * br) / 2, ya - (s * la) / 2 - (c * br) / 2, thick - depth],
            u: [c * la, s * la, 0],
            v: [-s * br, c * br, 0],
            w: [0, 0, depth],
          };
        } else w.add('Tasche 크기(LA·BR)가 없음', m.line);
        operations.push(op);
        if (enabled) stats.pockets++;
        break;
      }
      case 'comment':
        operations.push({ ...base, kind: 'comment', label: m.comments.join(' ') || label });
        break;
      default:
        w.add(`지원하지 않는 매크로 <${m.id} \\${m.name}\\ — 목록에만 넣음`, m.line);
        operations.push({ ...base, kind: 'other' });
        stats.other++;
    }
  }
  if (!ended) w.add('파일 끝 표시(!)가 없음');
  const name = opts.name ?? (header.PARTID || header.ARTICLE || 'MPR');
  return {
    name,
    version: header.VERSION,
    units,
    header,
    variables,
    workpiece,
    contours,
    operations,
    lines,
    stats,
    warnings: w.list(),
  };
}

/**
 * 호 중심: I·J(절대 중심)가 있으면 그것, 아니면 R과 방향으로 두 후보를 구해 .I/.J(계산된 중심)에 가까운 것,
 * 그것도 없으면 짧은 호(R<0이면 긴 호).
 */
function arcFrom(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  ccw: boolean,
  vals: Record<string, string>,
  num: (k: string) => number | undefined,
): { cx: number; cy: number; sweep: number; r: number } | null {
  let cx: number | undefined;
  let cy: number | undefined;
  const ok = (x: number, y: number): boolean => {
    const r0 = Math.hypot(sx - x, sy - y);
    const r1 = Math.hypot(ex - x, ey - y);
    return r0 > 1e-9 && Math.abs(r0 - r1) <= Math.max(1e-3, r0 * 1e-3);
  };
  const I = num('I');
  const J = num('J');
  if (I !== undefined && J !== undefined && ok(I, J)) {
    cx = I;
    cy = J;
  }
  const R = num('R');
  const dI = vals['.I'] !== undefined ? Number(vals['.I']) : undefined;
  const dJ = vals['.J'] !== undefined ? Number(vals['.J']) : undefined;
  if (cx === undefined && R !== undefined && R !== 0) {
    const dx = ex - sx;
    const dy = ey - sy;
    const d = Math.hypot(dx, dy);
    if (d > 1e-9) {
      let r = Math.abs(R);
      if (d / 2 > r) r = d / 2;
      const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
      const cand = (side: number): [number, number] => [sx + dx / 2 - (side * h * dy) / d, sy + dy / 2 + (side * h * dx) / d];
      const minor = cand((ccw ? 1 : -1) * (R < 0 ? -1 : 1));
      const major = cand((ccw ? -1 : 1) * (R < 0 ? -1 : 1));
      let pick = minor;
      if (dI !== undefined && dJ !== undefined && Number.isFinite(dI) && Number.isFinite(dJ) && ok(dI, dJ)) {
        pick = Math.hypot(major[0] - dI, major[1] - dJ) < Math.hypot(minor[0] - dI, minor[1] - dJ) ? major : minor;
      }
      cx = pick[0];
      cy = pick[1];
    }
  }
  if (cx === undefined && dI !== undefined && dJ !== undefined && Number.isFinite(dI) && Number.isFinite(dJ) && ok(dI, dJ)) {
    cx = dI;
    cy = dJ;
  }
  if (cx === undefined || cy === undefined) return null;
  const TAU = Math.PI * 2;
  const same = Math.hypot(ex - sx, ey - sy) < 1e-9;
  let sweep = Math.atan2(ey - cy, ex - cx) - Math.atan2(sy - cy, sx - cx);
  if (ccw) {
    if (same) sweep = TAU;
    else while (sweep <= 0) sweep += TAU;
  } else if (same) sweep = -TAU;
  else while (sweep >= 0) sweep -= TAU;
  return { cx, cy, sweep, r: Math.hypot(sx - cx, sy - cy) };
}

/** "c:e" → [c, e] */
function contourRef(v: string | undefined): [number, number | undefined] | undefined {
  if (!v) return undefined;
  const m = /^\s*(\d+)\s*(?::\s*(\d+))?\s*$/.exec(v);
  if (!m) return undefined;
  return [+m[1]!, m[2] !== undefined ? +m[2] : undefined];
}

function contourOp(
  base: OpBase,
  p: Record<string, string>,
  contours: MprContour[],
  thick: number,
  num: (k: string, d?: number) => number | undefined,
  w: NcWarnings,
): MprContourOp {
  const rk = (p.RK ?? '').toUpperCase();
  const op: MprContourOp = { ...base, kind: 'contour', comp: rk === 'WRKL' ? 'left' : rk === 'WRKR' ? 'right' : 'none' };
  const f = num('F_');
  if (f !== undefined) op.feed = f;
  const ea = contourRef(p.EA);
  const ee = contourRef(p.EE);
  if (!ea) {
    w.add('Konturfraesen에 시작 요소(EA)가 없음', base.line);
    return op;
  }
  op.contour = ea[0];
  const c = contours.find((k) => k.id === ea[0]);
  if (!c || c.elements.length === 0) {
    w.add(`Konturfraesen: 윤곽 ${ea[0]}이 없음`, base.line);
    return op;
  }
  const idxOf = (e: number | undefined, dflt: number): number => {
    if (e === undefined) return dflt;
    const i = c.elements.findIndex((x) => x.index === e);
    return i < 0 ? dflt : i;
  };
  let i0 = idxOf(ea[1], 0);
  let i1 = ee && ee[0] === ea[0] ? idxOf(ee[1], c.elements.length - 1) : c.elements.length - 1;
  op.startElement = c.elements[i0]!.index;
  op.endElement = c.elements[i1]!.index;
  let path: PathPoint[] = [];
  if (i0 <= i1) {
    for (let i = i0; i <= i1; i++) {
      const e = c.elements[i]!;
      const pt: PathPoint = { x: e.x, y: e.y, z: e.z };
      if (i > i0 && e.arc) pt.arc = { ...e.arc };
      path.push(pt);
    }
  } else {
    // 거꾸로
    [i0, i1] = [i1, i0];
    const fwd: PathPoint[] = [];
    for (let i = i0; i <= i1; i++) {
      const e = c.elements[i]!;
      fwd.push({ x: e.x, y: e.y, z: e.z, arc: i > i0 && e.arc ? { ...e.arc } : undefined });
    }
    path = fwd.map((q) => ({ x: q.x, y: q.y, z: q.z }));
    path.reverse();
    // 호 정보는 반대 끝점으로, 각은 반대로
    for (let k = 1; k < fwd.length; k++) {
      const a = fwd[k]!.arc;
      if (a) path[fwd.length - k]!.arc = { cx: a.cx, cy: a.cy, sweep: -a.sweep };
    }
  }
  // 깊이: ZA="@d" → 윤곽 Z에서 d 더 깊게, ZA·TI 수 → 윗면에서 그만큼 아래(평면 윤곽)
  const za = (p.ZA ?? '').trim();
  if (za.startsWith('@')) {
    const d = Number(za.slice(1)) || 0;
    for (const q of path) q.z -= d;
  } else {
    const depth = za !== '' ? num('ZA') : num('TI');
    if (depth !== undefined) for (const q of path) q.z = thick - depth;
  }
  op.path = path;
  return op;
}

/** 글이 MPR처럼 보이는지 */
export function looksLikeMpr(head: string): boolean {
  return /^\s*\[H\s*$/m.test(head) && (/^\s*VERSION\s*=/m.test(head) || /^<\s*\d+\s*\\/m.test(head));
}
