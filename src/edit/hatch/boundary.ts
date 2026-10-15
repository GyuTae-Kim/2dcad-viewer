/**
 * 해치 경계 만들기.
 * - detectBoundary: 점을 둘러싼 가장 작은 닫힌 영역(AutoCAD BHATCH "점 선택")과 섬
 * - boundaryFromEntities: 닫힌 객체에서 바로 경계(객체 선택)
 * - rebuildAssociative: 경계 객체가 바뀐 뒤 연관 해치 경계 다시 만들기
 */
import type { CadDocument, Entity, HatchEdge, HatchEntity, HatchPath, Vec2, Vec3 } from '../../core/model';
import { ocsMatrix } from '../../geom/matrix';
import { pathLoop } from '../../render/hatch';
import { type Box, type Curve, TAU, clipXLines, entitiesToCurves, isCircle, pointAt, reverseNurbs, roughBox, splineSub } from './curves';
import { Graph, buildGraph, pointInRing, signedArea } from './graph';
import { lwCount, lwVertices } from '../../core/lwpoly';

export type IslandStyle = 'normal' | 'outer' | 'ignore';

export interface DetectOptions {
  /** 섬 처리: normal 홀짝(기본), outer 가장 바깥 섬만, ignore 섬 무시 */
  islands?: IslandStyle;
  /** 이 거리 이하로 벌어진 틈은 이어 붙인다(0 = 없음) */
  gapTolerance?: number;
  /**
   * 문자 상자(문자·여러 줄 문자·속성의 테두리 꼭짓점, 월드 좌표). 영역 안에 통째로 든 상자는 섬(플래그 8|16)이 된다.
   * 문자 크기는 글꼴을 알아야 하므로 호출한 쪽이 문자 엔진으로 구해 넘긴다.
   */
  textBoxes?: { handle: string; points: Vec2[] }[];
}

export interface DetectResult {
  paths: HatchPath[];
  /** 경계에 쓰인 객체 핸들(블록 참조 안 객체는 그 블록 참조 핸들) */
  boundaryHandles: string[];
  /** 틈 허용으로 이어 붙인 곳이 경계에 들어갔으면 참(이때는 연관 해치로 만들지 않는 편이 맞다) */
  bridged: boolean;
}

// 경로 플래그(DXF 92)
const F_EXTERNAL = 1;
const F_POLYLINE = 2;
const F_DERIVED = 4;
const F_TEXTBOX = 8;
const F_OUTERMOST = 16;

// ---------------------------------------------------------------------------
// 준비
// ---------------------------------------------------------------------------

interface Prepared {
  g: Graph;
  size: number;
  eps: number;
}

function unionBox(curves: readonly Curve[], extra?: Vec2): Box {
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const c of curves) {
    const r = roughBox(c);
    b.minX = Math.min(b.minX, r.minX);
    b.minY = Math.min(b.minY, r.minY);
    b.maxX = Math.max(b.maxX, r.maxX);
    b.maxY = Math.max(b.maxY, r.maxY);
  }
  if (extra) {
    b.minX = Math.min(b.minX, extra.x);
    b.minY = Math.min(b.minY, extra.y);
    b.maxX = Math.max(b.maxX, extra.x);
    b.maxY = Math.max(b.maxY, extra.y);
  }
  return b;
}

interface Collected {
  curves: Curve[];
  boxes: Box[];
  box: Box;
  size: number;
  eps: number;
}

/** 후보 객체 → 곡선(무한선은 범위에 맞춰 자른다), 허용 오차 */
function collect(doc: CadDocument, list: readonly Entity[], pick: Vec2 | undefined): Collected | null {
  const { curves, xlines } = entitiesToCurves(doc, list);
  if (!curves.length && !xlines.length) return null;
  let box = unionBox(curves, pick);
  if (xlines.length) {
    for (const x of xlines) {
      box.minX = Math.min(box.minX, x.base.x);
      box.minY = Math.min(box.minY, x.base.y);
      box.maxX = Math.max(box.maxX, x.base.x);
      box.maxY = Math.max(box.maxY, x.base.y);
    }
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    const pad = Math.max(w, h, 1) * 0.5;
    const clip = { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad };
    curves.push(...clipXLines(xlines, clip));
    box = unionBox(curves, pick);
  }
  const size = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) || 1;
  const mag = Math.max(Math.abs(box.minX), Math.abs(box.maxX), Math.abs(box.minY), Math.abs(box.maxY));
  const eps = Math.max(size * 1e-9, mag * 1e-13, 1e-12);
  return { curves, boxes: curves.map(roughBox), box, size, eps };
}

function graphOf(col: Collected, curves: Curve[], gap: number): Prepared {
  const g = buildGraph([...curves], { mergeTol: col.eps, sampleTol: col.size * 1e-4, gapTol: gap > col.eps ? gap : 0 });
  return { g, size: col.size, eps: col.eps };
}

function prepare(doc: CadDocument, list: readonly Entity[], pick: Vec2 | undefined, gap: number): Prepared | null {
  const col = collect(doc, list, pick);
  return col ? graphOf(col, col.curves, gap) : null;
}

// ---------------------------------------------------------------------------
// 반직선
// ---------------------------------------------------------------------------

interface Hit {
  s: number;
  piece: number;
  /** cross(ray, 선분 방향) > 0 이면 점이 정방향 반모서리의 왼쪽 */
  left: boolean;
}

const RAY_DIRS = [0.1234, 1.9017, 3.7311, 5.1029, 0.7731, 2.6517, 4.3301, 5.8813];

/**
 * 점에서 반직선을 쏴 만나는 조각들(가까운 순). 점이 경계 위면 'on'.
 * 꼭짓점을 지나거나 스치면 다른 방향으로 다시 쏜다.
 */
function castRay(g: Graph, x: number, y: number, eps: number, only?: readonly number[]): Hit[] | 'on' | null {
  const count = only ? only.length : g.pieces.length;
  for (const a of RAY_DIRS) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const hits: Hit[] = [];
    let bad = false;
    for (let q = 0; q < count && !bad; q++) {
      const pi = only ? only[q]! : q;
      const p = g.pieces[pi]!;
      // 상자 거르기(반직선 쪽에 있는지)
      if (!rayHitsBox(x, y, dx, dy, p.minX - eps, p.minY - eps, p.maxX + eps, p.maxY + eps)) continue;
      const n = p.xs.length - 1;
      for (let k = 0; k < n; k++) {
        const ax = p.xs[k]!;
        const ay = p.ys[k]!;
        const ex = p.xs[k + 1]! - ax;
        const ey = p.ys[k + 1]! - ay;
        const le = Math.hypot(ex, ey);
        if (le < 1e-300) continue;
        // 점이 선분 위?
        const qx = x - ax;
        const qy = y - ay;
        const u0 = (qx * ex + qy * ey) / (le * le);
        if (u0 >= 0 && u0 <= 1 && Math.abs(qx * ey - qy * ex) / le <= eps) return 'on';
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9 * le) {
          // 나란함: 반직선 위에 놓였으면 다시
          if (Math.abs(qx * dy - qy * dx) <= eps && (ax - x) * dx + (ay - y) * dy > 0) bad = true;
          continue;
        }
        const s = (-qx * ey + qy * ex) / den;
        const u = (-qx * dy + qy * dx) / den;
        if (s <= 0 || u < -1e-12 || u > 1 + 1e-12) continue;
        const ut = 1e-7;
        if ((k === 0 && u < ut) || (k === n - 1 && u > 1 - ut)) {
          bad = true; // 꼭짓점을 지남
          break;
        }
        if (u >= 1 && k < n - 1) continue; // 다음 선분의 u = 0에서 센다
        if (Math.abs(den) < 1e-6 * le) {
          bad = true;
          break;
        }
        hits.push({ s, piece: pi, left: den > 0 });
      }
    }
    if (bad) continue;
    hits.sort((p, q) => p.s - q.s);
    return hits;
  }
  return null;
}

function rayHitsBox(x: number, y: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let lo = 0;
  let hi = Infinity;
  for (const [p, d, mn, mx] of [
    [x, dx, x0, x1],
    [y, dy, y0, y1],
  ] as const) {
    if (Math.abs(d) < 1e-300) {
      if (p < mn || p > mx) return false;
      continue;
    }
    let a = (mn - p) / d;
    let b = (mx - p) / d;
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
    if (lo > hi) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 면·고리
// ---------------------------------------------------------------------------

interface Loop {
  walk: number[];
  xs: number[];
  ys: number[];
  area: number;
}

/** 다리(같은 모서리를 양쪽으로 지나는 곳)를 빼서 면 둘레를 단순 고리들로 나눈다 */
function splitWalk(g: Graph, walk: readonly number[]): Loop[] {
  const inWalk = new Set(walk);
  const stack: number[] = [];
  const pos = new Map<number, number>();
  const loops: number[][] = [];
  for (const h of walk) {
    const tw = h ^ 1;
    if (inWalk.has(tw) && pos.has(tw)) {
      const at = pos.get(tw)!;
      const sub = stack.splice(at);
      sub.shift();
      for (const x of sub) pos.delete(x);
      pos.delete(tw);
      if (sub.length) loops.push(sub);
      continue;
    }
    pos.set(h, stack.length);
    stack.push(h);
  }
  if (stack.length) loops.push(stack);
  return loops.map((w) => {
    const r = g.ring(w);
    return { walk: w, xs: r.xs, ys: r.ys, area: signedArea(r.xs, r.ys) };
  });
}

interface CompInfo {
  box: Box;
  piece: number;
  pieces: number[];
}

function compInfo(g: Graph): CompInfo[] {
  const info: CompInfo[] = [];
  g.pieces.forEach((p, i) => {
    const c = g.comp[p.va]!;
    let r = info[c];
    if (!r) {
      r = { box: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, piece: i, pieces: [] };
      info[c] = r;
    }
    r.pieces.push(i);
    r.box.minX = Math.min(r.box.minX, p.minX);
    r.box.minY = Math.min(r.box.minY, p.minY);
    r.box.maxX = Math.max(r.box.maxX, p.maxX);
    r.box.maxY = Math.max(r.box.maxY, p.maxY);
  });
  return info;
}

/** 성분의 바깥 둘레(무한 면 쪽)를 시계 방향 고리들로 */
function contourOf(g: Graph, info: CompInfo, eps: number): Loop[] {
  const b = info.box;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  for (const f of [0.5137, 0.3711, 0.6829, 0.2203, 0.8117]) {
    const x = b.minX - Math.max(w, h, eps * 1e3) * 0.25;
    const y = b.minY + h * f;
    const hits = castRay(g, x, y, eps, info.pieces);
    if (!hits || hits === 'on' || !hits.length) continue;
    const hit = hits[0]!;
    const walk = g.walk(hit.left ? hit.piece * 2 : hit.piece * 2 + 1);
    if (!walk.length) continue;
    return splitWalk(g, walk).filter((l) => l.area < 0);
  }
  return [];
}

interface Ringish {
  xs: number[];
  ys: number[];
  area: number;
  box: Box;
}

/** 고리마다 자기를 품은 (더 큰) 고리 수. 상자 격자로 후보를 줄인다 */
function nestDepths(rings: readonly Ringish[]): number[] {
  const n = rings.length;
  if (n < 2) return new Array(n).fill(0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    minX = Math.min(minX, r.box.minX);
    minY = Math.min(minY, r.box.minY);
    maxX = Math.max(maxX, r.box.maxX);
    maxY = Math.max(maxY, r.box.maxY);
  }
  const k = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(n))));
  const cw = (maxX - minX) / k || 1;
  const ch = (maxY - minY) / k || 1;
  const cell = (x: number, y: number) => {
    const i = Math.min(k - 1, Math.max(0, Math.floor((x - minX) / cw)));
    const j = Math.min(k - 1, Math.max(0, Math.floor((y - minY) / ch)));
    return j * k + i;
  };
  const grid: number[][] = Array.from({ length: k * k }, () => []);
  rings.forEach((r, idx) => {
    const i0 = Math.min(k - 1, Math.max(0, Math.floor((r.box.minX - minX) / cw)));
    const i1 = Math.min(k - 1, Math.max(0, Math.floor((r.box.maxX - minX) / cw)));
    const j0 = Math.min(k - 1, Math.max(0, Math.floor((r.box.minY - minY) / ch)));
    const j1 = Math.min(k - 1, Math.max(0, Math.floor((r.box.maxY - minY) / ch)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * k + i]!.push(idx);
  });
  return rings.map((r, idx) => {
    let d = 0;
    for (const o of grid[cell(r.xs[0]!, r.ys[0]!)]!) {
      if (o === idx) continue;
      const q = rings[o]!;
      if (q.area > r.area && within(r.box, q.box) && firstVertexInside(r, q.xs, q.ys)) d++;
    }
    return d;
  });
}

function within(a: Box, b: Box): boolean {
  return a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY;
}

function firstVertexInside(l: { xs: number[]; ys: number[] }, xs: readonly number[], ys: readonly number[]): boolean {
  // 고리 위 여러 점 중 다수결(경계를 공유할 때 대비)
  let yes = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(l.xs.length / 5));
  for (let i = 0; i < l.xs.length && n < 5; i += step, n++) if (pointInRing(l.xs[i]!, l.ys[i]!, xs, ys)) yes++;
  return yes * 2 > n;
}

// ---------------------------------------------------------------------------
// 고리 → HATCH 경로
// ---------------------------------------------------------------------------

interface Run {
  curve: number;
  fwd: boolean;
  /** 지나는 순서와 상관없이 ta < tb */
  ta: number;
  tb: number;
  vFrom: number;
  vTo: number;
}

function runs(g: Graph, walk: readonly number[]): Run[] {
  const out: Run[] = [];
  for (const h of walk) {
    const p = g.pieces[h >> 1]!;
    const fwd = (h & 1) === 0;
    const r: Run = { curve: p.curve, fwd, ta: p.ta, tb: p.tb, vFrom: fwd ? p.va : p.vb, vTo: fwd ? p.vb : p.va };
    const last = out[out.length - 1];
    if (last && joinRun(g, last, r)) continue;
    out.push(r);
  }
  if (out.length > 1 && joinRun(g, out[out.length - 1]!, out[0]!)) {
    const last = out.pop()!;
    out[0] = last;
  }
  return out;
}

/** 같은 곡선의 이어진 조각이면 a에 b를 붙인다 */
function joinRun(g: Graph, a: Run, b: Run): boolean {
  if (a.curve !== b.curve || a.fwd !== b.fwd) return false;
  const c = g.curves[a.curve]!;
  const P = c.t1 - c.t0;
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-12 * (Math.abs(x) + Math.abs(P) + 1);
  if (a.fwd) {
    if (near(a.tb, b.ta)) a.tb = b.tb;
    else if (c.closed && near(a.tb, b.ta + P)) a.tb = b.tb + P;
    else if (c.closed && near(a.tb - P, b.ta)) a.tb = b.tb + P;
    else return false;
  } else {
    if (near(a.ta, b.tb)) a.ta = b.ta;
    else if (c.closed && near(a.ta, b.tb - P)) a.ta = b.ta - P;
    else if (c.closed && near(a.ta + P, b.tb)) a.ta = b.ta - P;
    else return false;
  }
  a.vTo = b.vTo;
  return true;
}

function norm(a: number): number {
  let r = a % TAU;
  if (r < 0) r += TAU;
  if (TAU - r < 1e-12) r = 0;
  return r;
}

function vtx(g: Graph, v: number): Vec2 {
  return { x: g.vx[v]!, y: g.vy[v]! };
}

/** 고리를 경로로. preferPoly면 선·원호만 있을 때 폴리선 경로 */
function loopToPath(g: Graph, walk: readonly number[], flags: number, preferPoly: boolean): HatchPath {
  const rs = runs(g, walk);
  const sources: string[] = [];
  for (const r of rs) {
    const s = g.curves[r.curve]!.src;
    if (s && !sources.includes(s)) sources.push(s);
  }
  const allArcs = rs.every((r) => {
    const c = g.curves[r.curve]!;
    return c.kind === 'line' || isCircle(c);
  });
  if (preferPoly && allArcs) {
    const vertices: { x: number; y: number; bulge: number }[] = [];
    for (const r of rs) {
      const c = g.curves[r.curve]!;
      const p0 = vtx(g, r.vFrom);
      if (c.kind === 'line') {
        vertices.push({ x: p0.x, y: p0.y, bulge: 0 });
        continue;
      }
      const sweep = r.tb - r.ta;
      const k = Math.max(1, Math.ceil(sweep / Math.PI - 1e-9));
      const part = sweep / k;
      const bulge = Math.tan(part / 4) * (r.fwd ? 1 : -1);
      for (let i = 0; i < k; i++) {
        const t = r.fwd ? r.ta + part * i : r.tb - part * i;
        const p = i === 0 ? p0 : pointAt(c, t);
        vertices.push({ x: p.x, y: p.y, bulge });
      }
    }
    return { flags: flags | F_POLYLINE, polyline: { closed: true, vertices }, sources };
  }
  const edges: HatchEdge[] = [];
  for (const r of rs) {
    const c = g.curves[r.curve]!;
    const a = vtx(g, r.vFrom);
    const b = vtx(g, r.vTo);
    const full = c.closed && r.tb - r.ta >= c.t1 - c.t0 - 1e-9;
    if (c.kind === 'line') edges.push({ type: 'line', start: a, end: b });
    else if (c.kind === 'conic') {
      if (isCircle(c)) {
        const phi = Math.atan2(c.u.y, c.u.x);
        const radius = Math.hypot(c.u.x, c.u.y);
        edges.push({
          type: 'arc',
          center: { ...c.c },
          radius,
          startAngle: full ? 0 : norm(r.ta + phi),
          endAngle: full ? TAU : norm(r.tb + phi),
          ccw: r.fwd,
        });
      } else {
        const ga = (t: number) => norm(Math.atan2(c.ratio * Math.sin(t), Math.cos(t)));
        edges.push({
          type: 'ellipse',
          center: { ...c.c },
          majorAxis: { ...c.u },
          ratio: c.ratio,
          startAngle: full ? 0 : ga(r.ta),
          endAngle: full ? TAU : ga(r.tb),
          ccw: r.fwd,
        });
      }
    } else {
      // 이음매를 넘으면 두 토막
      const parts: [number, number][] = [];
      if (r.tb <= c.t1 + 1e-12 && r.ta >= c.t0 - 1e-12) parts.push([r.ta, r.tb]);
      else if (r.tb > c.t1) parts.push([r.ta, c.t1], [c.t0, r.tb - (c.t1 - c.t0)]);
      else parts.push([r.ta + (c.t1 - c.t0), c.t1], [c.t0, r.tb]);
      if (!r.fwd) parts.reverse();
      for (const [u0, u1] of parts) {
        if (!(u1 > u0)) continue;
        let s = splineSub(c, u0, u1);
        if (!r.fwd) s = reverseNurbs(s);
        edges.push({ type: 'spline', degree: s.degree, rational: !!s.weights, periodic: false, knots: s.knots, controlPoints: s.ctrl, weights: s.weights });
      }
    }
  }
  return { flags: flags & ~F_POLYLINE, edges, sources };
}

/** 반모서리 고리를 거꾸로(방향 바꾸기) */
function reversed(walk: readonly number[]): number[] {
  return walk.map((h) => h ^ 1).reverse();
}

function loopFlags(depth: number, poly: boolean, derived: boolean): number {
  return (depth === 0 ? F_EXTERNAL : depth === 1 ? F_OUTERMOST : 0) | (derived ? F_DERIVED : 0) | (poly ? F_POLYLINE : 0);
}

function collectHandles(paths: readonly HatchPath[]): string[] {
  const out: string[] = [];
  for (const p of paths) for (const s of p.sources ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

// ---------------------------------------------------------------------------
// 점 선택
// ---------------------------------------------------------------------------

/**
 * 점을 둘러싼 닫힌 영역 찾기(AutoCAD BHATCH의 "점 선택"). 열린 영역이거나 경계 위면 null.
 * 선택점 둘레 창 안의 곡선만으로 먼저 찾고, 찾은 영역이 창 안에 다 들지 않으면 창을 넓힌다.
 * (창 밖 곡선은 창 안의 면에 닿지 않으므로 결과는 전체로 찾은 것과 같다.)
 */
export function detectBoundary(doc: CadDocument, candidates: Entity[], pick: Vec2, opt: DetectOptions = {}): DetectResult | null {
  const col = collect(doc, candidates, pick);
  if (!col) return null;
  const gap = Math.max(0, opt.gapTolerance ?? 0);
  const style = opt.islands ?? 'normal';
  if (escapes(col, pick, gap)) return null;
  const B = col.box;
  let half = Math.max(B.maxX - B.minX, B.maxY - B.minY) / 48;
  for (;;) {
    const W: Box = { minX: pick.x - half, minY: pick.y - half, maxX: pick.x + half, maxY: pick.y + half };
    const covers = W.minX <= B.minX && W.minY <= B.minY && W.maxX >= B.maxX && W.maxY >= B.maxY;
    const sub = covers ? col.curves : col.curves.filter((_, i) => overlaps(col.boxes[i]!, W));
    const prep = graphOf(col, sub, gap);
    const found = findRegion(prep, pick, style);
    if (found === 'on') return null;
    if (found) {
      const fb = loopBox(found.outer);
      const m = gap + col.eps * 100;
      if (covers || (fb.minX - m > W.minX && fb.minY - m > W.minY && fb.maxX + m < W.maxX && fb.maxY + m < W.maxY)) {
        const r = toResult(prep.g, found);
        if (style !== 'ignore' && opt.textBoxes?.length) addTextIslands(r, found, opt.textBoxes, pick);
        return r;
      }
      half = Math.max(half * 2, (Math.max(fb.maxX - pick.x, pick.x - fb.minX, fb.maxY - pick.y, pick.y - fb.minY) + m) * 1.25);
    } else {
      if (covers) return null;
      half *= 4;
    }
  }
}

/** 네 축 방향 중 어느 쪽으로든 곡선 상자에 막히지 않으면 열린 영역 */
function escapes(col: Collected, p: Vec2, gap: number): boolean {
  let px = true;
  let nx = true;
  let py = true;
  let ny = true;
  const m = gap + col.eps;
  for (const b of col.boxes) {
    const inY = b.minY - m <= p.y && b.maxY + m >= p.y;
    const inX = b.minX - m <= p.x && b.maxX + m >= p.x;
    if (inY && b.maxX + m >= p.x) px = false;
    if (inY && b.minX - m <= p.x) nx = false;
    if (inX && b.maxY + m >= p.y) py = false;
    if (inX && b.minY - m <= p.y) ny = false;
    if (!px && !nx && !py && !ny) return false;
  }
  return true;
}

/** 영역 안에 통째로 든 문자 상자를 섬으로 더한다(다른 섬 안이거나 경계에 걸치면 뺀다) */
function addTextIslands(r: DetectResult, found: Region, boxes: { handle: string; points: Vec2[] }[], pick: Vec2): void {
  const islands = found.islands.map((i) => i.loop);
  for (const b of boxes) {
    const pts = b.points;
    if (pts.length < 3) continue;
    if (!pts.every((q) => pointInRing(q.x, q.y, found.outer.xs, found.outer.ys))) continue;
    if (islands.some((l) => pts.some((q) => pointInRing(q.x, q.y, l.xs, l.ys)) || l.xs.some((x, i) => pointInRing(x, l.ys[i]!, pts.map((q) => q.x), pts.map((q) => q.y))))) continue;
    if (crossesRing(pts, found.outer) || islands.some((l) => crossesRing(pts, l))) continue;
    // 선택점이 문자 위면 섬으로 만들지 않는다
    if (pointInRing(pick.x, pick.y, pts.map((q) => q.x), pts.map((q) => q.y))) continue;
    // 시계 방향으로
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j]!.x * pts[i]!.y - pts[i]!.x * pts[j]!.y;
    const ring = a > 0 ? [...pts].reverse() : pts;
    const edges: HatchEdge[] = ring.map((q, i) => ({ type: 'line', start: { x: q.x, y: q.y }, end: { x: ring[(i + 1) % ring.length]!.x, y: ring[(i + 1) % ring.length]!.y } }));
    r.paths.push({ flags: F_TEXTBOX | F_OUTERMOST, edges, sources: b.handle ? [b.handle] : [] });
    if (b.handle && !r.boundaryHandles.includes(b.handle)) r.boundaryHandles.push(b.handle);
  }
}

function crossesRing(pts: Vec2[], l: Loop): boolean {
  const n = pts.length;
  const m = l.xs.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    for (let k = 0, j = m - 1; k < m; j = k++) {
      const cx = l.xs[j]!;
      const cy = l.ys[j]!;
      const dx = l.xs[k]!;
      const dy = l.ys[k]!;
      const d1 = (b.x - a.x) * (cy - a.y) - (b.y - a.y) * (cx - a.x);
      const d2 = (b.x - a.x) * (dy - a.y) - (b.y - a.y) * (dx - a.x);
      const d3 = (dx - cx) * (a.y - cy) - (dy - cy) * (a.x - cx);
      const d4 = (dx - cx) * (b.y - cy) - (dy - cy) * (b.x - cx);
      if (d1 * d2 <= 0 && d3 * d4 <= 0) return true;
    }
  }
  return false;
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function loopBox(l: Loop): Box {
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < l.xs.length; i++) {
    b.minX = Math.min(b.minX, l.xs[i]!);
    b.maxX = Math.max(b.maxX, l.xs[i]!);
    b.minY = Math.min(b.minY, l.ys[i]!);
    b.maxY = Math.max(b.maxY, l.ys[i]!);
  }
  return b;
}

function toResult(g: Graph, found: Region): DetectResult {
  const paths: HatchPath[] = [];
  paths.push(loopToPath(g, found.outer.walk, loopFlags(0, false, true), true));
  for (const isl of found.islands) paths.push(loopToPath(g, isl.loop.walk, loopFlags(isl.depth, false, true), true));
  const walks = [found.outer.walk, ...found.islands.map((i) => i.loop.walk)];
  const bridged = walks.some((w) => w.some((h) => g.curves[g.pieces[h >> 1]!.curve]!.bridge));
  return { paths, boundaryHandles: collectHandles(paths), bridged };
}

interface Region {
  outer: Loop;
  islands: { loop: Loop; depth: number }[];
}

function findRegion(prep: Prepared, pick: Vec2, style: IslandStyle): Region | 'on' | null {
  const { g, eps } = prep;
  const hits = castRay(g, pick.x, pick.y, eps);
  if (hits === 'on') return 'on';
  if (!hits || !hits.length) return null;
  const seen = new Set<number>();
  let outer: Loop | null = null;
  let outerComp = -1;
  for (const hit of hits) {
    const comp = g.comp[g.pieces[hit.piece]!.va]!;
    if (seen.has(comp)) continue;
    seen.add(comp);
    const walk = g.walk(hit.left ? hit.piece * 2 : hit.piece * 2 + 1);
    if (!walk.length) continue;
    const ring = g.ring(walk);
    if (signedArea(ring.xs, ring.ys) <= 0) continue; // 이 성분의 바깥 면 → 섬 후보
    // 둘레에서 다리를 떼면 바깥 고리 하나와 붙은 섬 고리들
    const parts = splitWalk(g, walk);
    const main = parts.filter((l) => l.area > 0 && pointInRing(pick.x, pick.y, l.xs, l.ys)).sort((a, b) => a.area - b.area)[0];
    if (!main) continue;
    outer = main;
    outerComp = comp;
    const attached = parts.filter((l) => l !== main && l.area < 0);
    return finishRegion(prep, outer, outerComp, attached, style);
  }
  return null;
}

function finishRegion(prep: Prepared, outer: Loop, outerComp: number, attached: Loop[], style: IslandStyle): Region {
  const { g, eps } = prep;
  if (style === 'ignore') return { outer, islands: [] };
  const ob = loopBox(outer);
  const info = compInfo(g);
  const loops: Loop[] = [...attached];
  for (let c = 0; c < info.length; c++) {
    if (c === outerComp || !info[c]) continue;
    const b = info[c]!.box;
    if (b.minX < ob.minX || b.maxX > ob.maxX || b.minY < ob.minY || b.maxY > ob.maxY) continue;
    const p = g.pieces[info[c]!.piece]!;
    const mx = p.xs[p.xs.length >> 1]!;
    const my = p.ys[p.ys.length >> 1]!;
    if (!pointInRing(mx, my, outer.xs, outer.ys)) continue;
    loops.push(...contourOf(g, info[c]!, eps));
  }
  // 깊이: 다른 섬 고리 안에 몇 겹 들어 있는가
  const depths = nestDepths(loops.map((l) => ({ xs: l.xs, ys: l.ys, area: Math.abs(l.area), box: loopBox(l) })));
  const withDepth = loops.map((l, i) => ({ loop: l, depth: depths[i]! + 1 }));
  const islands = style === 'outer' ? withDepth.filter((x) => x.depth === 1) : withDepth;
  islands.sort((a, b) => a.depth - b.depth);
  return { outer, islands };
}

// ---------------------------------------------------------------------------
// 객체 선택
// ---------------------------------------------------------------------------

function isClosedEntity(e: Entity): boolean {
  switch (e.type) {
    case 'CIRCLE':
      return true;
    case 'ELLIPSE': {
      const s = e.endParam - e.startParam;
      return Math.abs(Math.abs(s) - TAU) < 1e-9 || Math.abs(s) < 1e-12;
    }
    case 'LWPOLYLINE': {
      if (e.closed) return true;
      const n = lwCount(e);
      const v = e.verts;
      return n > 2 && Math.hypot(v[0]! - v[n * 3 - 3]!, v[1]! - v[n * 3 - 2]!) < 1e-9;
    }
    case 'POLYLINE':
      return (e.kind === '2d' || e.kind === '3d') && !!(e.flags & 1);
    case 'SPLINE':
      return !!(e.flags & 1);
    case 'SOLID':
    case 'TRACE':
      return true;
    default:
      return false;
  }
}

interface PathCand {
  path: HatchPath;
  xs: number[];
  ys: number[];
  area: number;
  box: Box;
}

/** 경로 방향 바꾸기 */
function reversePath(p: HatchPath): HatchPath {
  if (p.polyline) {
    const v = p.polyline.vertices;
    const n = v.length;
    const out = v.map((_, k) => {
      const i = (n - k) % n; // 새 k번째 = 옛 i번째 점
      const prev = v[(i - 1 + n) % n]!; // 옛 i−1 → i 마디의 볼록도를 뒤집어 쓴다
      return { x: v[i]!.x, y: v[i]!.y, bulge: -prev.bulge };
    });
    return { ...p, polyline: { closed: p.polyline.closed, vertices: out } };
  }
  const edges: HatchEdge[] = (p.edges ?? []).map((e): HatchEdge => {
    switch (e.type) {
      case 'line':
        return { type: 'line', start: { ...e.end }, end: { ...e.start } };
      case 'arc':
      case 'ellipse':
        return { ...e, ccw: !e.ccw };
      case 'spline': {
        const r = reverseNurbs({ degree: e.degree, knots: e.knots, ctrl: e.controlPoints, weights: e.weights });
        return { type: 'spline', degree: r.degree, rational: e.rational, periodic: e.periodic, knots: r.knots, controlPoints: r.ctrl, weights: r.weights };
      }
    }
  });
  return { ...p, edges: edges.reverse() };
}

/** 닫힌 폴리선·2D 면 → 월드 꼭짓점(볼록도 포함). 기운 평면이면 null */
function polyVertices(e: Entity): { x: number; y: number; bulge: number }[] | null {
  let ext: Vec3 | undefined;
  let z = 0;
  let pts: { x: number; y: number; bulge: number }[];
  let world = false;
  switch (e.type) {
    case 'LWPOLYLINE':
      ext = e.extrusion;
      z = e.elevation;
      pts = lwVertices(e);
      break;
    case 'POLYLINE': {
      const smooth = !!(e.flags & 4);
      const vs = e.vertices.filter((v) => !(v.flags & 16));
      world = e.kind === '3d';
      ext = world ? undefined : e.extrusion;
      z = e.elevation;
      pts = vs.map((v) => ({ x: v.location.x, y: v.location.y, bulge: smooth || world ? 0 : v.bulge }));
      break;
    }
    case 'SOLID':
    case 'TRACE': {
      ext = e.extrusion;
      z = e.points[0].z;
      const [a, b, c, d] = e.points;
      pts = [a, b, d, c].map((q) => ({ x: q.x, y: q.y, bulge: 0 }));
      break;
    }
    default:
      return null;
  }
  const m = world ? null : ocsMatrix(ext);
  if (m && (Math.abs(m[8]!) > 1e-9 || Math.abs(m[9]!) > 1e-9)) return null;
  const mirror = m ? m[0]! * m[5]! - m[1]! * m[4]! < 0 : false;
  const out: { x: number; y: number; bulge: number }[] = [];
  for (const q of pts) {
    const x = m ? m[0]! * q.x + m[1]! * q.y + m[2]! * z + m[3]! : q.x;
    const y = m ? m[4]! * q.x + m[5]! * q.y + m[6]! * z + m[7]! : q.y;
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 1e-12 * (Math.abs(x) + Math.abs(y) + 1)) {
      last.bulge = mirror ? -q.bulge : q.bulge;
      continue;
    }
    out.push({ x, y, bulge: mirror ? -q.bulge : q.bulge });
  }
  if (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-12 * (Math.abs(a.x) + Math.abs(a.y) + 1)) out.pop();
  }
  return out.length >= 2 ? out : null;
}

/** 닫힌 객체 하나 → 경로(그래프 없이 바로) */
function directPath(doc: CadDocument, e: Entity): HatchPath | null {
  const sources = e.handle ? [e.handle] : [];
  if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE' || e.type === 'SOLID' || e.type === 'TRACE') {
    const vertices = polyVertices(e);
    return vertices ? { flags: F_EXTERNAL | F_POLYLINE, polyline: { closed: true, vertices }, sources } : null;
  }
  const { curves } = entitiesToCurves(doc, [e]);
  if (curves.length !== 1) return null;
  const c = curves[0]!;
  if (c.kind === 'conic') {
    if (!c.closed) return null;
    const edge: HatchEdge = isCircle(c)
      ? { type: 'arc', center: { ...c.c }, radius: Math.hypot(c.u.x, c.u.y), startAngle: 0, endAngle: TAU, ccw: true }
      : { type: 'ellipse', center: { ...c.c }, majorAxis: { ...c.u }, ratio: c.ratio, startAngle: 0, endAngle: TAU, ccw: true };
    return { flags: F_EXTERNAL, edges: [edge], sources };
  }
  if (c.kind === 'spline') {
    const sp = splineSub(c, c.t0, c.t1);
    return { flags: F_EXTERNAL, edges: [{ type: 'spline', degree: sp.degree, rational: !!sp.weights, periodic: false, knots: sp.knots, controlPoints: sp.ctrl, weights: sp.weights }], sources };
  }
  return null;
}

function pathCand(path: HatchPath): PathCand | null {
  const r = ringOf(path);
  if (r.xs.length < 3) return null;
  let area = signedArea(r.xs, r.ys);
  if (Math.abs(area) < 1e-300) return null;
  let xs = r.xs;
  let ys = r.ys;
  if (area < 0) {
    path = reversePath(path);
    xs = [...xs].reverse();
    ys = [...ys].reverse();
    area = -area;
  }
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < xs.length; i++) {
    box.minX = Math.min(box.minX, xs[i]!);
    box.maxX = Math.max(box.maxX, xs[i]!);
    box.minY = Math.min(box.minY, ys[i]!);
    box.maxY = Math.max(box.maxY, ys[i]!);
  }
  return { path, xs, ys, area, box };
}

/**
 * 객체 선택 방식: 닫힌 객체(원, 닫힌 폴리선, 타원, 닫힌 스플라인, 2D 면)에서 바로 경계 만들기.
 * 열린 객체들은 서로 이어 닫힌 고리(바깥 둘레)를 만든다. 겹 깊이로 바깥(1)·첫 섬(16) 플래그를 붙인다.
 */
export function boundaryFromEntities(doc: CadDocument, entities: Entity[]): HatchPath[] {
  const cands: PathCand[] = [];
  const open: Entity[] = [];
  for (const e of entities) {
    if (e.type === 'HATCH' || e.type === 'MPOLYGON') continue;
    if (isClosedEntity(e)) {
      const p = directPath(doc, e);
      const c = p && pathCand(p);
      if (c) cands.push(c);
    } else open.push(e);
  }
  if (open.length) {
    const prep = prepare(doc, open, undefined, 0);
    if (prep) {
      const poly = open.every((e) => e.type === 'LWPOLYLINE' || e.type === 'POLYLINE');
      const info = compInfo(prep.g);
      for (let c = 0; c < info.length; c++) {
        if (!info[c]) continue;
        for (const l of contourOf(prep.g, info[c]!, prep.eps)) {
          const pc = pathCand(loopToPath(prep.g, reversed(l.walk), 0, poly));
          if (pc) cands.push(pc);
        }
      }
    }
  }
  // 겹 깊이(큰 고리 안에 든 정도)
  const depth = nestDepths(cands);
  return cands
    .map((c, i) => ({ c, d: depth[i]! }))
    .sort((a, b) => a.d - b.d)
    .map(({ c, d }) => {
      const p = d % 2 === 0 ? c.path : reversePath(c.path);
      return { ...p, flags: loopFlags(d, !!p.polyline, false) };
    });
}

// ---------------------------------------------------------------------------
// 연관 해치 다시 만들기
// ---------------------------------------------------------------------------

function ringOf(p: HatchPath): { xs: number[]; ys: number[] } {
  const r = pathLoop(p, 0);
  const tol = ringTol(r);
  const f = tol > 0 ? pathLoop(p, tol) : r;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) {
    xs.push(f[i]!);
    ys.push(f[i + 1]!);
  }
  return { xs, ys };
}

function ringTol(flat: number[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    minX = Math.min(minX, flat[i]!);
    maxX = Math.max(maxX, flat[i]!);
    minY = Math.min(minY, flat[i + 1]!);
    maxY = Math.max(maxY, flat[i + 1]!);
  }
  const s = Math.hypot(maxX - minX, maxY - minY);
  return Number.isFinite(s) && s > 0 ? s * 1e-3 : 0;
}

function centroid(xs: readonly number[], ys: readonly number[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = xs[j]! * ys[i]! - xs[i]! * ys[j]!;
    a += f;
    cx += (xs[j]! + xs[i]!) * f;
    cy += (ys[j]! + ys[i]!) * f;
  }
  if (Math.abs(a) < 1e-300) return { x: xs[0] ?? 0, y: ys[0] ?? 0 };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** 고리 안쪽 점(무게중심이 안에 없으면 가로 현의 가운데) */
export function interiorPoint(xs: readonly number[], ys: readonly number[]): Vec2 | null {
  const c = centroid(xs, ys);
  if (pointInRing(c.x, c.y, xs, ys)) return c;
  return fillPoint([{ xs, ys }]);
}

/**
 * 홀짝 규칙으로 칠해지는 곳의 점(섬 밖). 몇 높이에서 가로로 잘라 가장 넓은 칠 구간의 가운데.
 * 경로 목록의 씨앗점 기본값 등에 쓴다.
 */
export function fillPoint(rings: readonly { xs: readonly number[]; ys: readonly number[] }[]): Vec2 | null {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings)
    for (const y of r.ys) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  if (!(maxY > minY)) return null;
  let best = -1;
  let bp: Vec2 | null = null;
  for (const f of [0.5, 0.31, 0.69, 0.17, 0.83, 0.43, 0.57]) {
    const y = minY + (maxY - minY) * f;
    const cut: number[] = [];
    for (const { xs, ys } of rings)
      for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
        const yi = ys[i]!;
        const yj = ys[j]!;
        if (yi > y !== yj > y) cut.push(xs[i]! + ((xs[j]! - xs[i]!) * (y - yi)) / (yj - yi));
      }
    cut.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cut.length; k += 2)
      if (cut[k + 1]! - cut[k]! > best) {
        best = cut[k + 1]! - cut[k]!;
        bp = { x: (cut[k]! + cut[k + 1]!) / 2, y };
      }
  }
  return best > 0 ? bp : null;
}

/** 경로들의 칠해지는 곳 한 점 */
export function pathsFillPoint(paths: readonly HatchPath[]): Vec2 | null {
  return fillPoint(paths.map(ringOf).filter((r) => r.xs.length >= 3));
}

/** 배치의 유한한 면 모두 */
function boundedFaces(g: Graph): Loop[] {
  const seen = new Uint8Array(g.pieces.length * 2);
  const out: Loop[] = [];
  for (let h = 0; h < g.pieces.length * 2; h++) {
    if (seen[h]) continue;
    const walk = g.walk(h);
    for (const x of walk) seen[x] = 1;
    if (!walk.length) continue;
    const r = g.ring(walk);
    const area = signedArea(r.xs, r.ys);
    if (area > 0) out.push(...splitWalk(g, walk).filter((l) => l.area > 0));
  }
  return out;
}

/**
 * 경계 객체가 바뀐 뒤 연관 해치의 경로를 다시 만든다(무늬 줄·원점은 그대로).
 * 경로마다 그 경로의 원본 객체만으로 배치를 만들고, 예전 고리와 가장 가까운 고리를 고른다.
 * 경계가 깨졌으면 null(호출한 쪽에서 연관을 끊는다).
 */
export function rebuildAssociative(doc: CadDocument, hatch: HatchEntity, boundaryEntities: Entity[]): HatchEntity | null {
  const byHandle = new Map<string, Entity>();
  for (const e of boundaryEntities) if (e.handle) byHandle.set(e.handle.toUpperCase(), e);
  const paths: HatchPath[] = [];
  for (const p of hatch.paths) {
    const src = (p.sources ?? []).map((h) => h.toUpperCase());
    if (!src.length) {
      paths.push(p);
      continue;
    }
    const ents = src.map((h) => byHandle.get(h) ?? doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
    if (!ents.length) return null;
    const old = ringOf(p);
    if (old.xs.length < 3) return null;
    const oldC = centroid(old.xs, old.ys);
    const island = !(p.flags & F_EXTERNAL);
    const derived = !!(p.flags & F_DERIVED);
    const poly = !!p.polyline;
    let next: HatchPath | null = null;
    if (!derived && ents.length === 1 && isClosedEntity(ents[0]!)) {
      const got = boundaryFromEntities(doc, ents);
      if (got.length) {
        const best = nearestPath(got, oldC);
        next = { ...best, flags: (p.flags & ~F_POLYLINE) | (best.polyline ? F_POLYLINE : 0) };
      }
    } else {
      const prep = prepare(doc, ents, undefined, 0);
      if (!prep) return null;
      const { g, eps } = prep;
      let pick: Loop | null = null;
      if (island) {
        const info = compInfo(g);
        const all: Loop[] = [];
        for (let c = 0; c < info.length; c++) if (info[c]) all.push(...contourOf(g, info[c]!, eps));
        pick = nearestLoop(all, oldC);
      } else {
        const q = (hatch.seedPoints.find((s) => pointInRing(s.x, s.y, old.xs, old.ys)) ?? interiorPoint(old.xs, old.ys)) as Vec2 | null;
        const faces = boundedFaces(g);
        if (q) {
          const inside = faces.filter((f) => pointInRing(q.x, q.y, f.xs, f.ys)).sort((a, b) => a.area - b.area);
          pick = inside[0] ?? null;
        }
        pick ??= nearestLoop(faces, oldC);
      }
      if (pick) next = loopToPath(g, pick.walk, p.flags & ~F_POLYLINE, poly || derived);
    }
    if (!next) return null;
    paths.push({ ...next, sources: p.sources ? [...p.sources] : next.sources });
  }
  // 씨앗점이 새 바깥 고리 밖이면 칠해지는 곳의 점으로 옮긴다
  const outerRings = paths.filter((p) => p.flags & F_EXTERNAL).map(ringOf);
  const seeds = hatch.seedPoints.map((s) => {
    if (!outerRings.length || outerRings.some((r) => pointInRing(s.x, s.y, r.xs, r.ys))) return { ...s };
    return pathsFillPoint(paths) ?? { ...s };
  });
  return { ...hatch, paths, seedPoints: seeds };
}

function nearestLoop(list: Loop[], c: Vec2): Loop | null {
  let best: Loop | null = null;
  let bd = Infinity;
  for (const l of list) {
    const m = centroid(l.xs, l.ys);
    const d = Math.hypot(m.x - c.x, m.y - c.y);
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}

function nearestPath(list: HatchPath[], c: Vec2): HatchPath {
  let best = list[0]!;
  let bd = Infinity;
  for (const p of list) {
    const r = ringOf(p);
    const m = centroid(r.xs, r.ys);
    const d = Math.hypot(m.x - c.x, m.y - c.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

export { pointInRing };
