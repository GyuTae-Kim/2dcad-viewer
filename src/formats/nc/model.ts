/**
 * NC 프로그램 모델(G-code·Heidenhain 공용).
 *
 * 이동은 객체 배열이 아니라 형식 배열(구조 배열)로 담는다 — 줄 수백만 개 파일도 메모리를 아끼고,
 * 워커에서 만든 뒤 버퍼를 그대로 옮길 수 있다. 위치는 "표시 좌표"다: 첫 작업 좌표계를 원점으로 보고
 * G92·G52·알려진 좌표계 오프셋을 더한 값(단위는 NcProgram.units).
 *
 * 이동 i는 points[i]에서 points[i+1]로 간다(점 xyz를 이어 붙인 배열, 길이 3*(count+1)).
 */
import type { Box3 } from '../../viewer3d/types';
import type { NcSource } from './text';

/** 급속 이송(G0) */
export const MOVE_RAPID = 0;
/** 직선 이송(G1) */
export const MOVE_FEED = 1;
/** 원호·나선 이송(G2/G3) */
export const MOVE_ARC = 2;
/** 드릴 사이클의 내려가는 이송 */
export const MOVE_DRILL = 3;

export type NcMoveKindName = 'rapid' | 'feed' | 'arc' | 'drill';
export const MOVE_KIND_NAMES: readonly NcMoveKindName[] = ['rapid', 'feed', 'arc', 'drill'];

/** flags 비트 */
export const FLAG_COMP_LEFT = 1; // G41
export const FLAG_COMP_RIGHT = 2; // G42
export const FLAG_TOOL_LENGTH = 4; // G43/G44 켜짐
export const FLAG_MACHINE = 8; // G53 기계 좌표 이동
export const FLAG_CYCLE = 16; // 고정 사이클이 만든 이동
export const FLAG_INVERSE_TIME = 32; // G93
export const FLAG_PER_REV = 64; // G95
export const FLAG_COOLANT = 128; // M7/M8 켜짐

/** 평면: 0 XY(G17), 1 ZX(G18), 2 YZ(G19) */
export type NcPlane = 0 | 1 | 2;

export type NcDialect = 'iso' | 'fanuc' | 'linuxcnc' | 'grbl' | 'mach3' | 'heidenhain';
export const NC_DIALECT_NAMES: Record<NcDialect, string> = {
  iso: '일반 ISO',
  fanuc: 'Fanuc',
  linuxcnc: 'LinuxCNC',
  grbl: 'GRBL',
  mach3: 'Mach3/Mach4',
  heidenhain: 'Heidenhain 평문',
};

/** 이동 목록(구조 배열) */
export interface NcMoves {
  count: number;
  /** 종류 MOVE_* */
  kind: Uint8Array;
  /** 점 xyz(길이 3*(count+1)) — 이동 i는 점 i → 점 i+1 */
  points: Float64Array;
  /** 원본 줄 번호(0부터) */
  line: Uint32Array;
  /** 공구 번호(-1 = 모름) */
  tool: Int32Array;
  /** 이송 F(표시 단위/분, G93·G95면 원래 값) */
  feed: Float32Array;
  /** 주축 S(rpm, 부호: M4면 음수, M5면 0) */
  spindle: Float32Array;
  /** 호 표 번호(호가 아니면 -1) */
  arc: Int32Array;
  /** FLAG_* 비트 */
  flags: Uint8Array;
  /** 작업 좌표계(0 = G54 … 5 = G59, 6~ = G54.1 P1~ 또는 G59.1~, 255 = 기계 좌표) */
  wcs: Uint8Array;
  /** 걸린 시간(초, 이동 뒤 휴지 포함) */
  time: Float32Array;
}

/** 호 표(호 이동만) */
export interface NcArcs {
  count: number;
  /** 중심 xyz(직선 축 값은 시작점과 같다) */
  center: Float64Array;
  /** 평면 NcPlane */
  plane: Uint8Array;
  /** 부호 있는 중심각(라디안). 평면 법선(+Z, +Y, +X) 기준 반시계가 + — 여러 바퀴면 2π 넘음 */
  sweep: Float64Array;
}

/** 드릴 구멍(고정 사이클 한 번 = 구멍 하나) */
export interface NcHoles {
  count: number;
  /** 구멍 위 시작점 xyz(R 점) */
  top: Float64Array;
  /** 구멍 바닥 xyz */
  bottom: Float64Array;
  line: Uint32Array;
  tool: Int32Array;
  /** 사이클 G 코드(81, 83, 73…) */
  cycle: Uint16Array;
  /** 첫 내려가기 이동 번호 */
  move: Uint32Array;
}

export interface NcTool {
  number: number;
  /** 주석·공구 정의에서 읽은 지름(표시 단위) */
  diameter?: number;
  /** 주석에서 읽은 이름 */
  name?: string;
  /** 처음 나온 줄(0부터) */
  firstLine: number;
  moveCount: number;
  /** 이송 길이(호·드릴 포함) */
  feedLength: number;
  rapidLength: number;
  /** 예상 시간(초) */
  time: number;
}

export interface NcStats {
  moveCount: number;
  rapidLength: number;
  /** 이송 길이(직선+호+드릴) */
  feedLength: number;
  arcCount: number;
  holeCount: number;
  toolChanges: number;
  /** 예상 시간(초) — 급속은 rapidFeed로, 이송은 F로 */
  time: number;
  rapidTime: number;
  feedTime: number;
  dwellTime: number;
  /** 실행한 블록 수(반복·부프로그램 포함) */
  blocks: number;
  /** 계산에 쓴 급속 속도(표시 단위/분) */
  rapidFeed: number;
}

/** 해석 결과 */
export interface NcProgram {
  name: string;
  /** 'gcode' | 'heidenhain' */
  format: 'gcode' | 'heidenhain';
  dialect: NcDialect;
  units: 'mm' | 'inch';
  /** 원본 글(줄 글은 sourceLine(program.source, i)) */
  source: NcSource;
  moves: NcMoves;
  arcs: NcArcs;
  holes: NcHoles;
  tools: NcTool[];
  stats: NcStats;
  /** 모든 이동의 범위(이동이 없으면 undefined) */
  bounds?: Box3;
  /** 이송(절삭) 이동만의 범위 */
  feedBounds?: Box3;
  /** 공작물(프로그램에 정의가 있으면 — Heidenhain BLK FORM 등) */
  stock?: Box3;
  warnings: string[];
}

/** 평면(XY) 윤곽 점열의 점 — MPR 윤곽·공구 경로 */
export interface PathPoint {
  x: number;
  y: number;
  z: number;
  /** 앞 점에서 이 점까지 호로 왔으면 호 중심과 중심각(XY 평면, 반시계 +, 라디안) */
  arc?: { cx: number; cy: number; sweep: number };
}

// ───────────────────────── 경고 모음 ─────────────────────────

/** 같은 경고를 묶어 첫 줄 번호와 횟수만 남긴다 */
export class NcWarnings {
  private map = new Map<string, { line: number; count: number }>();
  constructor(private max = 300) {}
  add(msg: string, line = -1): void {
    const w = this.map.get(msg);
    if (w) w.count++;
    else if (this.map.size < this.max) this.map.set(msg, { line, count: 1 });
  }
  list(): string[] {
    const out: string[] = [];
    for (const [msg, w] of this.map) {
      const at = w.line >= 0 ? `${w.line + 1}번 줄: ` : '';
      out.push(w.count > 1 ? `${at}${msg} (모두 ${w.count}번)` : at + msg);
    }
    return out;
  }
}

// ───────────────────────── 이동 쌓기 ─────────────────────────

function grow<T extends Float64Array | Float32Array | Uint32Array | Int32Array | Uint8Array | Uint16Array>(a: T, n: number): T {
  const b = new (a.constructor as new (n: number) => T)(n);
  b.set(a);
  return b;
}

/** 이동·호·구멍을 형식 배열에 쌓는다(두 배씩 늘린다) */
export class MoveBuilder {
  count = 0;
  private cap: number;
  kind: Uint8Array;
  points: Float64Array;
  line: Uint32Array;
  tool: Int32Array;
  feed: Float32Array;
  spindle: Float32Array;
  arc: Int32Array;
  flags: Uint8Array;
  wcs: Uint8Array;
  time: Float32Array;

  arcCount = 0;
  private arcCap = 64;
  arcCenter = new Float64Array(64 * 3);
  arcPlane = new Uint8Array(64);
  arcSweep = new Float64Array(64);

  holeCount = 0;
  private holeCap = 64;
  holeTop = new Float64Array(64 * 3);
  holeBottom = new Float64Array(64 * 3);
  holeLine = new Uint32Array(64);
  holeTool = new Int32Array(64);
  holeCycle = new Uint16Array(64);
  holeMove = new Uint32Array(64);

  constructor(start: ArrayLike<number> = [0, 0, 0], cap = 1024) {
    this.cap = cap;
    this.kind = new Uint8Array(cap);
    this.points = new Float64Array((cap + 1) * 3);
    this.line = new Uint32Array(cap);
    this.tool = new Int32Array(cap);
    this.feed = new Float32Array(cap);
    this.spindle = new Float32Array(cap);
    this.arc = new Int32Array(cap);
    this.flags = new Uint8Array(cap);
    this.wcs = new Uint8Array(cap);
    this.time = new Float32Array(cap);
    this.points[0] = start[0]!;
    this.points[1] = start[1]!;
    this.points[2] = start[2]!;
  }

  /** 마지막 점 */
  lastX(): number {
    return this.points[this.count * 3]!;
  }
  lastY(): number {
    return this.points[this.count * 3 + 1]!;
  }
  lastZ(): number {
    return this.points[this.count * 3 + 2]!;
  }

  /** 첫 이동 전 시작점을 바꾼다(위치를 모르다가 알게 됐을 때) */
  setLast(x: number, y: number, z: number): void {
    const k = this.count * 3;
    this.points[k] = x;
    this.points[k + 1] = y;
    this.points[k + 2] = z;
  }

  private ensure(): void {
    if (this.count < this.cap) return;
    const n = this.cap * 2;
    this.kind = grow(this.kind, n);
    this.points = grow(this.points, (n + 1) * 3);
    this.line = grow(this.line, n);
    this.tool = grow(this.tool, n);
    this.feed = grow(this.feed, n);
    this.spindle = grow(this.spindle, n);
    this.arc = grow(this.arc, n);
    this.flags = grow(this.flags, n);
    this.wcs = grow(this.wcs, n);
    this.time = grow(this.time, n);
    this.cap = n;
  }

  /** 이동 하나를 더한다(시작점은 마지막 점). 이동 번호를 돌려준다 */
  push(kind: number, x: number, y: number, z: number, line: number, tool: number, feed: number, spindle: number, flags: number, wcs: number, arc = -1): number {
    this.ensure();
    const i = this.count;
    this.kind[i] = kind;
    this.line[i] = line;
    this.tool[i] = tool;
    this.feed[i] = feed;
    this.spindle[i] = spindle;
    this.arc[i] = arc;
    this.flags[i] = flags;
    this.wcs[i] = wcs;
    const k = (i + 1) * 3;
    this.points[k] = x;
    this.points[k + 1] = y;
    this.points[k + 2] = z;
    this.count = i + 1;
    return i;
  }

  /** 호를 표에 더하고 번호를 돌려준다 */
  pushArc(cx: number, cy: number, cz: number, plane: number, sweep: number): number {
    if (this.arcCount >= this.arcCap) {
      const n = this.arcCap * 2;
      this.arcCenter = grow(this.arcCenter, n * 3);
      this.arcPlane = grow(this.arcPlane, n);
      this.arcSweep = grow(this.arcSweep, n);
      this.arcCap = n;
    }
    const i = this.arcCount++;
    this.arcCenter[i * 3] = cx;
    this.arcCenter[i * 3 + 1] = cy;
    this.arcCenter[i * 3 + 2] = cz;
    this.arcPlane[i] = plane;
    this.arcSweep[i] = sweep;
    return i;
  }

  pushHole(top: ArrayLike<number>, bottom: ArrayLike<number>, line: number, tool: number, cycle: number, move: number): void {
    if (this.holeCount >= this.holeCap) {
      const n = this.holeCap * 2;
      this.holeTop = grow(this.holeTop, n * 3);
      this.holeBottom = grow(this.holeBottom, n * 3);
      this.holeLine = grow(this.holeLine, n);
      this.holeTool = grow(this.holeTool, n);
      this.holeCycle = grow(this.holeCycle, n);
      this.holeMove = grow(this.holeMove, n);
      this.holeCap = n;
    }
    const i = this.holeCount++;
    for (let a = 0; a < 3; a++) {
      this.holeTop[i * 3 + a] = top[a]!;
      this.holeBottom[i * 3 + a] = bottom[a]!;
    }
    this.holeLine[i] = line;
    this.holeTool[i] = tool;
    this.holeCycle[i] = cycle;
    this.holeMove[i] = move;
  }

  /** 꼭 맞는 크기로 잘라 모델 배열로 */
  finish(): { moves: NcMoves; arcs: NcArcs; holes: NcHoles } {
    const n = this.count;
    const a = this.arcCount;
    const h = this.holeCount;
    return {
      moves: {
        count: n,
        kind: this.kind.slice(0, n),
        points: this.points.slice(0, (n + 1) * 3),
        line: this.line.slice(0, n),
        tool: this.tool.slice(0, n),
        feed: this.feed.slice(0, n),
        spindle: this.spindle.slice(0, n),
        arc: this.arc.slice(0, n),
        flags: this.flags.slice(0, n),
        wcs: this.wcs.slice(0, n),
        time: this.time.slice(0, n),
      },
      arcs: { count: a, center: this.arcCenter.slice(0, a * 3), plane: this.arcPlane.slice(0, a), sweep: this.arcSweep.slice(0, a) },
      holes: {
        count: h,
        top: this.holeTop.slice(0, h * 3),
        bottom: this.holeBottom.slice(0, h * 3),
        line: this.holeLine.slice(0, h),
        tool: this.holeTool.slice(0, h),
        cycle: this.holeCycle.slice(0, h),
        move: this.holeMove.slice(0, h),
      },
    };
  }
}

// ───────────────────────── 화면 패널 도움 ─────────────────────────

/**
 * 줄 → 이동 목록(CSR): 줄 i의 이동 번호는 moves[offsets[i]..offsets[i+1]).
 * 부프로그램·반복으로 한 줄이 여러 이동을 만들 수 있다. 코드 보기에서 줄을 고르면 이동을 강조할 때 쓴다.
 */
export function ncLineMoves(p: NcProgram): { offsets: Uint32Array; moves: Uint32Array } {
  const lc = p.source.lineCount;
  const m = p.moves;
  const offsets = new Uint32Array(lc + 1);
  for (let i = 0; i < m.count; i++) offsets[m.line[i]! + 1]!++;
  for (let i = 0; i < lc; i++) offsets[i + 1]! += offsets[i]!;
  const fill = offsets.slice(0, lc);
  const moves = new Uint32Array(m.count);
  for (let i = 0; i < m.count; i++) moves[fill[m.line[i]!]!++] = i;
  return { offsets, moves };
}

/** 이동마다 끝난 시각(초, 누적) — 재생 막대·남은 시간에 */
export function ncTimeline(p: NcProgram): Float64Array {
  const t = new Float64Array(p.moves.count);
  let acc = 0;
  for (let i = 0; i < p.moves.count; i++) {
    acc += p.moves.time[i]!;
    t[i] = acc;
  }
  return t;
}

/** 시각(초)에 하고 있는 이동 번호(재생용, 이분 탐색) */
export function ncMoveAtTime(timeline: Float64Array, sec: number): number {
  let lo = 0;
  let hi = timeline.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid]! < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ───────────────────────── 기하 도움 ─────────────────────────

/** 평면의 두 축과 직선 축 번호(0 x, 1 y, 2 z) */
export const PLANE_AXES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], // G17 XY, 법선 Z
  [2, 0, 1], // G18 ZX, 법선 Y
  [1, 2, 0], // G19 YZ, 법선 X
];

/** 이동 i의 시작·끝 */
export function moveStart(m: NcMoves, i: number): [number, number, number] {
  const k = i * 3;
  return [m.points[k]!, m.points[k + 1]!, m.points[k + 2]!];
}
export function moveEnd(m: NcMoves, i: number): [number, number, number] {
  const k = (i + 1) * 3;
  return [m.points[k]!, m.points[k + 1]!, m.points[k + 2]!];
}

/**
 * 호 이동 위의 점을 out에 쌓는다(시작점 제외, 끝점 포함). 각도 허용치 maxAngle(라디안)로 나눈다.
 * 반지름이 시작·끝에서 조금 다르면 그 사이를 고르게 바꾼다(나선·오차 흡수).
 */
export function arcPoints(
  s: ArrayLike<number>,
  e: ArrayLike<number>,
  center: ArrayLike<number>,
  plane: number,
  sweep: number,
  maxAngle: number,
  out: number[],
  maxSegments = 4096,
): number {
  const [a0, a1, a2] = PLANE_AXES[plane] ?? PLANE_AXES[0]!;
  const u0 = s[a0]! - center[a0]!;
  const v0 = s[a1]! - center[a1]!;
  const u1 = e[a0]! - center[a0]!;
  const v1 = e[a1]! - center[a1]!;
  const r0 = Math.hypot(u0, v0);
  const r1 = Math.hypot(u1, v1);
  const t0 = Math.atan2(v0, u0);
  const n = Math.max(1, Math.min(maxSegments, Math.ceil(Math.abs(sweep) / Math.max(1e-4, maxAngle) - 1e-9)));
  const l0 = s[a2]!;
  const dl = e[a2]! - l0;
  const p = [0, 0, 0];
  for (let k = 1; k <= n; k++) {
    if (k === n) {
      out.push(e[0]!, e[1]!, e[2]!);
      break;
    }
    const f = k / n;
    const t = t0 + sweep * f;
    const r = r0 + (r1 - r0) * f;
    p[a0] = center[a0]! + r * Math.cos(t);
    p[a1] = center[a1]! + r * Math.sin(t);
    p[a2] = l0 + dl * f;
    out.push(p[0]!, p[1]!, p[2]!);
  }
  return n;
}

/** 호 길이(나선 포함) */
export function arcLength(s: ArrayLike<number>, e: ArrayLike<number>, center: ArrayLike<number>, plane: number, sweep: number): number {
  const [a0, a1, a2] = PLANE_AXES[plane] ?? PLANE_AXES[0]!;
  const r0 = Math.hypot(s[a0]! - center[a0]!, s[a1]! - center[a1]!);
  const r1 = Math.hypot(e[a0]! - center[a0]!, e[a1]! - center[a1]!);
  const planar = ((r0 + r1) / 2) * Math.abs(sweep);
  return Math.hypot(planar, e[a2]! - s[a2]!);
}

/** 호가 지나는 범위를 box(min xyz, max xyz 6개)에 넓힌다 */
export function arcExtend(s: ArrayLike<number>, e: ArrayLike<number>, center: ArrayLike<number>, plane: number, sweep: number, box: Float64Array): void {
  const [a0, a1] = PLANE_AXES[plane] ?? PLANE_AXES[0]!;
  extendBox(box, s[0]!, s[1]!, s[2]!);
  extendBox(box, e[0]!, e[1]!, e[2]!);
  const u0 = s[a0]! - center[a0]!;
  const v0 = s[a1]! - center[a1]!;
  const r = Math.max(Math.hypot(u0, v0), Math.hypot(e[a0]! - center[a0]!, e[a1]! - center[a1]!));
  const t0 = Math.atan2(v0, u0);
  const lo = Math.min(t0, t0 + sweep);
  const hi = Math.max(t0, t0 + sweep);
  const H = Math.PI / 2;
  // 사분점(0, 90, 180, 270도)이 범위 안이면 넣는다
  for (let k = Math.ceil(lo / H); k * H <= hi && k - Math.ceil(lo / H) < 8; k++) {
    const t = k * H;
    const c = Math.round(Math.cos(t));
    const sn = Math.round(Math.sin(t));
    const p0 = center[a0]! + r * c;
    const p1 = center[a1]! + r * sn;
    const q = [s[0]!, s[1]!, s[2]!];
    q[a0] = p0;
    q[a1] = p1;
    extendBox(box, q[0]!, q[1]!, q[2]!);
  }
}

export function emptyBox(): Float64Array {
  return new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
}
export function extendBox(b: Float64Array, x: number, y: number, z: number): void {
  if (x < b[0]!) b[0] = x;
  if (y < b[1]!) b[1] = y;
  if (z < b[2]!) b[2] = z;
  if (x > b[3]!) b[3] = x;
  if (y > b[4]!) b[4] = y;
  if (z > b[5]!) b[5] = z;
}
export function boxOf(b: Float64Array): Box3 | undefined {
  if (!(b[0]! <= b[3]!)) return undefined;
  return { min: [b[0]!, b[1]!, b[2]!], max: [b[3]!, b[4]!, b[5]!] };
}

/** 주석에서 공구 지름·이름을 읽는다(예: "T1 D=6. CR=0. - FLAT END MILL", "6mm endmill", "1/4\" DRILL") */
export function toolInfoFromComment(text: string, units: 'mm' | 'inch'): { diameter?: number; name?: string } {
  const t = text.trim();
  if (!t) return {};
  let diameter: number | undefined;
  const conv = (v: number, u: string | undefined): number => {
    const uu = (u ?? '').toLowerCase();
    if (uu === 'mm' && units === 'inch') return v / 25.4;
    if ((uu === '"' || uu === 'in' || uu === 'inch') && units === 'mm') return v * 25.4;
    return v;
  };
  let m = /(?:^|[^A-Z])(?:D|DIA|DIAM|DIAMETER|Ø|⌀)\s*[=:]?\s*(\d+(?:\.\d*)?|\.\d+)\s*(mm|in|inch|")?/i.exec(t);
  if (m) diameter = conv(parseFloat(m[1]!), m[2]);
  if (diameter === undefined) {
    m = /(\d+)\s*\/\s*(\d+)\s*("|in\b|inch)/i.exec(t);
    if (m && +m[2]! !== 0) diameter = conv(+m[1]! / +m[2]!, m[3]);
  }
  if (diameter === undefined) {
    m = /(\d+(?:\.\d*)?|\.\d+)\s*(mm|"|in\b|inch)/i.exec(t);
    if (m) diameter = conv(parseFloat(m[1]!), m[2]);
  }
  // 이름: 공구 번호·'키=값' 표기(D=6. CR=0. ZMIN=-5.)를 빼고 남은 글
  let name = t
    .replace(/^\s*(?:T|TOOL)\s*#?\s*\d+\s*[:=\-|]?\s*/i, '')
    .replace(/\b[A-Z][A-Z0-9]{0,7}\s*=\s*[-+]?(?:\d+\.?\d*|\.\d+)\S*/gi, ' ')
    .replace(/(?:^|\s)[-|:,;]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length > 80) name = name.slice(0, 80);
  // "T13 : 3.0"(CamBam)처럼 수만 남으면 지름으로 본다
  if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(name)) {
    if (diameter === undefined) diameter = parseFloat(name);
    name = '';
  }
  const out: { diameter?: number; name?: string } = {};
  if (diameter !== undefined && diameter > 0 && diameter < 1e4) out.diameter = diameter;
  if (name) out.name = name;
  return out;
}
