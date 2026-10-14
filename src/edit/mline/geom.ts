/**
 * 여러 줄(MLINE) 형상: 정점 만들기, 요소 선의 보이는 구간(끊기), 끊기·용접, 정점 넣기·빼기.
 *
 * 정점 i의 방향(direction)은 i → i+1 선분 방향(열린 여러 줄의 마지막 정점은 앞 선분 방향), 마이터(miter)는 요소가
 * 정점에서 놓이는 방향이다. 요소 k의 매개변수 params = [m, a0, b0, a1, b1, …]:
 *  - m: 정점에서 마이터 방향으로 요소 선까지 거리(요소 간격 × 축척 / sin(방향, 마이터))
 *  - 그다음 값들은 요소 선 시작점(정점 + 마이터 × m)에서 선분 방향으로 잰 거리로, 보이는 구간의 시작·끝이
 *    번갈아 온다. 값 수가 홀수(m 다음 하나 이상)면 마지막 구간은 선분 끝까지 간다. [m]만 있으면 선분 전체.
 */
import type { MLineEntity, MLineStyleObject, MLineVertex, Vec2, Vec3 } from '../../core/model';

const EPS = 1e-9;

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l > EPS ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};
const rot = (a: Vec2, t: number): Vec2 => ({ x: a.x * Math.cos(t) - a.y * Math.sin(t), y: a.x * Math.sin(t) + a.y * Math.cos(t) });
const left = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
const xy = (p: Vec3 | Vec2): Vec2 => ({ x: p.x, y: p.y });
const p3 = (p: Vec2, z = 0): Vec3 => ({ x: p.x, y: p.y, z });

/** 스타일의 요소 간격(스타일이 없으면 Standard ±0.5) */
export function styleOffsets(style: Pick<MLineStyleObject, 'elements'> | undefined | null): number[] {
  const o = style?.elements.map((e) => e.offset) ?? [];
  return o.length ? o : [0.5, -0.5];
}

/** 자리맞추기(0 위, 1 0, 2 아래)에 따른 간격 이동 */
export function justShift(offsets: readonly number[], just: number): number {
  if (!offsets.length) return 0;
  if (just === 0) return -Math.max(...offsets);
  if (just === 2) return -Math.min(...offsets);
  return 0;
}

/** 요소 k의 기준선에서 왼쪽으로 잰 거리(축척·자리맞추기 반영) */
export function elementDistances(offsets: readonly number[], scale: number, just: number): number[] {
  const s = justShift(offsets, just);
  return offsets.map((o) => (o + s) * scale);
}

function directions(pts: readonly Vec2[], closed: boolean): Vec2[] {
  const n = pts.length;
  const d: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    if (i < n - 1) d.push(norm(sub(pts[i + 1]!, pts[i]!)));
    else d.push(closed ? norm(sub(pts[0]!, pts[i]!)) : (d[i - 1] ?? { x: 1, y: 0 }));
  }
  return d;
}

function bisectMiter(d1: Vec2, d2: Vec2): Vec2 {
  const s = add(d1, d2);
  return len(s) > EPS ? left(norm(s)) : left(d2);
}

/** 정점 마이터에서 요소 매개변수 m(거리 d를 마이터 방향 길이로) */
export function miterParam(dir: Vec2, miter: Vec2, d: number): number {
  const s = cross(dir, miter);
  return Math.abs(s) > 1e-9 ? d / s : d;
}

/** 점 목록으로 정점 자료를 만든다(끊기 없음) */
export function buildVertices(pts: readonly Vec2[], closed: boolean, dist: readonly number[], startAngle = Math.PI / 2, endAngle = Math.PI / 2, z = 0): MLineVertex[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [{ position: p3(pts[0]!, z), direction: { x: 1, y: 0, z: 0 }, miter: { x: 0, y: 1, z: 0 }, elements: dist.map((d) => ({ params: [d, 0], fillParams: [] })) }];
  const D = directions(pts, closed);
  const out: MLineVertex[] = [];
  for (let i = 0; i < n; i++) {
    let M: Vec2;
    if (closed) M = bisectMiter(D[(i - 1 + n) % n]!, D[i]!);
    else if (i === 0) M = rot(D[0]!, startAngle);
    else if (i === n - 1) M = rot(D[n - 1]!, endAngle);
    else M = bisectMiter(D[i - 1]!, D[i]!);
    const dir = D[i]!;
    out.push({
      position: p3(pts[i]!, z),
      direction: { x: dir.x, y: dir.y, z: 0 },
      miter: { x: M.x, y: M.y, z: 0 },
      elements: dist.map((d) => ({ params: [miterParam(dir, M, d), 0], fillParams: [] })),
    });
  }
  return out;
}

export interface NewMLine {
  points: Vec2[];
  closed: boolean;
  style: Pick<MLineStyleObject, 'elements' | 'startAngle' | 'endAngle' | 'name' | 'handle'> | null;
  scale: number;
  justification: number;
}

/** 새 여러 줄 객체의 형상 부분 */
export function mlineGeometry(o: NewMLine): Pick<MLineEntity, 'styleName' | 'styleHandle' | 'scale' | 'justification' | 'flags' | 'startPoint' | 'normal' | 'vertices' | 'elementCount'> {
  const offs = styleOffsets(o.style);
  const dist = elementDistances(offs, o.scale, o.justification);
  const vertices = buildVertices(o.points, o.closed, dist, o.style?.startAngle ?? Math.PI / 2, o.style?.endAngle ?? Math.PI / 2);
  return {
    styleName: o.style?.name ?? 'Standard',
    styleHandle: o.style?.handle || undefined,
    scale: o.scale,
    justification: o.justification,
    flags: (o.points.length ? 1 : 0) | (o.closed ? 2 : 0),
    startPoint: p3(o.points[0] ?? { x: 0, y: 0 }),
    normal: { x: 0, y: 0, z: 1 },
    vertices,
    elementCount: offs.length,
  };
}

// ---------------------------------------------------------------------------
// 요소 선과 끊기
// ---------------------------------------------------------------------------

export function isClosed(e: MLineEntity): boolean {
  return (e.flags & 2) !== 0;
}

export function elementCount(e: MLineEntity): number {
  return e.elementCount || e.vertices[0]?.elements.length || 0;
}

export function segmentCount(e: MLineEntity): number {
  const n = e.vertices.length;
  if (n < 2) return 0;
  return isClosed(e) ? n : n - 1;
}

/** 정점 i에서 요소 k의 점 */
export function elementPoint(e: MLineEntity, i: number, k: number): Vec2 {
  const v = e.vertices[i]!;
  const m = v.elements[k]?.params[0] ?? 0;
  return { x: v.position.x + v.miter.x * m, y: v.position.y + v.miter.y * m };
}

/** 요소 k의 기준선에서 왼쪽 거리(정점 0의 마이터로 구한다) */
export function elementDistance(e: MLineEntity, k: number, i = 0): number {
  const v = e.vertices[i];
  if (!v) return 0;
  const m = v.elements[k]?.params[0] ?? 0;
  return m * cross(xy(v.direction), xy(v.miter));
}

export function elementDistancesOf(e: MLineEntity): number[] {
  return Array.from({ length: elementCount(e) }, (_, k) => elementDistance(e, k));
}

export interface SegFrame {
  /** 요소 선 시작점 */
  s: Vec2;
  /** 선분 방향(단위) */
  d: Vec2;
  /** 요소 선 길이 */
  len: number;
}

/** 선분 i 위 요소 k 선 */
export function segmentFrame(e: MLineEntity, i: number, k: number): SegFrame {
  const n = e.vertices.length;
  const a = elementPoint(e, i, k);
  const b = elementPoint(e, (i + 1) % n, k);
  const v = e.vertices[i]!;
  let d = norm(xy(v.direction));
  // 방향이 비어 있거나 반대인 파일: 두 점으로
  const ab = sub(b, a);
  if (len(ab) > EPS && dot(ab, d) < 0) d = norm(ab);
  return { s: a, d, len: Math.max(0, dot(ab, d)) };
}

/** 매개변수 → 보이는 구간 [시작, 끝] 목록 */
export function runsOf(params: readonly number[], L: number): [number, number][] {
  if (params.length <= 1) return [[0, L]];
  const v = params.slice(1);
  const out: [number, number][] = [];
  for (let i = 0; i < v.length; i += 2) {
    const a = Math.max(0, v[i]!);
    const b = i + 1 < v.length ? Math.min(L, v[i + 1]!) : L;
    if (b > a + EPS) out.push([a, b]);
  }
  return out;
}

/** 보이는 구간 → 매개변수(마지막 구간이 끝까지 가면 끝 값을 뺀다) */
export function paramsFromRuns(m: number, runs: readonly [number, number][], L: number): number[] {
  const tol = Math.max(1e-9, L * 1e-9);
  const rs = normalizeRuns(runs, L);
  if (!rs.length) return [m, 0, 0];
  const out = [m];
  rs.forEach(([a, b], i) => {
    out.push(a);
    if (i < rs.length - 1 || b < L - tol) out.push(b);
  });
  return out;
}

function normalizeRuns(runs: readonly [number, number][], L: number): [number, number][] {
  const rs = runs
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(L, Math.max(a, b))] as [number, number])
    .filter(([a, b]) => b > a + 1e-12)
    .sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1e-12) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** 구간 빼기 */
export function cutRuns(runs: readonly [number, number][], t0: number, t1: number): [number, number][] {
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  const out: [number, number][] = [];
  for (const [s, e] of runs) {
    if (e <= a || s >= b) out.push([s, e]);
    else {
      if (s < a) out.push([s, a]);
      if (e > b) out.push([b, e]);
    }
  }
  return out;
}

/** 구간 더하기 */
export function weldRuns(runs: readonly [number, number][], t0: number, t1: number, L: number): [number, number][] {
  return normalizeRuns([...runs, [Math.min(t0, t1), Math.max(t0, t1)]], L);
}

/** 요소 k의 보이는 선(꺾은선 목록). 정점에서 이어지는 구간은 한 선으로 잇는다 */
export function elementPolylines(e: MLineEntity, k: number): Vec2[][] {
  const out: Vec2[][] = [];
  const ns = segmentCount(e);
  let cur: Vec2[] | null = null;
  for (let i = 0; i < ns; i++) {
    const f = segmentFrame(e, i, k);
    const runs = runsOf(e.vertices[i]!.elements[k]?.params ?? [], f.len);
    for (const [a, b] of runs) {
      const pa = add(f.s, mul(f.d, a));
      const pb = add(f.s, mul(f.d, b));
      if (cur && a <= 1e-9 * Math.max(1, f.len)) cur.push(pb);
      else {
        cur = [pa, pb];
        out.push(cur);
      }
      if (b < f.len - 1e-9 * Math.max(1, f.len)) cur = null;
    }
    if (!runs.length || runs[runs.length - 1]![1] < f.len - 1e-9 * Math.max(1, f.len)) cur = null;
  }
  // 닫힌 여러 줄: 끝 선이 시작 선과 이어지면 합친다
  if (isClosed(e) && out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    const a = last[last.length - 1]!;
    const b = first[0]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9 * Math.max(1, Math.abs(a.x) + Math.abs(a.y))) {
      out[0] = [...last, ...first.slice(1)];
      out.pop();
    }
  }
  return out;
}

/** 끊기가 하나라도 있는지 */
export function hasBreaks(e: MLineEntity): boolean {
  const ns = segmentCount(e);
  for (let i = 0; i < ns; i++)
    for (let k = 0; k < elementCount(e); k++) {
      const f = segmentFrame(e, i, k);
      const r = runsOf(e.vertices[i]!.elements[k]?.params ?? [], f.len);
      if (r.length !== 1 || r[0]![0] > 1e-9 || r[0]![1] < f.len - 1e-9 * Math.max(1, f.len)) return true;
    }
  return false;
}

function cloneML(e: MLineEntity): MLineEntity {
  return structuredClone(e);
}

/** 선분 i 위 요소 k에서 [t0, t1] 구간을 지운다 */
export function cutElement(e: MLineEntity, k: number, i: number, t0: number, t1: number): MLineEntity {
  const r = cloneML(e);
  applyCut(r, k, i, t0, t1);
  return r;
}

function applyCut(r: MLineEntity, k: number, i: number, t0: number, t1: number): void {
  const f = segmentFrame(r, i, k);
  const el = r.vertices[i]!.elements[k];
  if (!el) return;
  const runs = cutRuns(runsOf(el.params, f.len), t0, t1);
  el.params = paramsFromRuns(el.params[0] ?? 0, runs, f.len);
}

function applyWeld(r: MLineEntity, k: number, i: number, t0: number, t1: number): void {
  const f = segmentFrame(r, i, k);
  const el = r.vertices[i]!.elements[k];
  if (!el) return;
  const runs = weldRuns(runsOf(el.params, f.len), t0, t1, f.len);
  el.params = paramsFromRuns(el.params[0] ?? 0, runs, f.len);
}

export interface ElementPos {
  seg: number;
  t: number;
  dist: number;
  point: Vec2;
}

/** 점에서 가장 가까운 요소 k 위치 */
export function projectToElement(e: MLineEntity, k: number, p: Vec2): ElementPos | null {
  let best: ElementPos | null = null;
  const ns = segmentCount(e);
  for (let i = 0; i < ns; i++) {
    const f = segmentFrame(e, i, k);
    const t = Math.max(0, Math.min(f.len, dot(sub(p, f.s), f.d)));
    const q = add(f.s, mul(f.d, t));
    const dist = len(sub(p, q));
    if (!best || dist < best.dist) best = { seg: i, t, dist, point: q };
  }
  return best;
}

/** 점에서 가장 가까운 요소 */
export function nearestElement(e: MLineEntity, p: Vec2): (ElementPos & { k: number }) | null {
  let best: (ElementPos & { k: number }) | null = null;
  for (let k = 0; k < elementCount(e); k++) {
    const q = projectToElement(e, k, p);
    if (q && (!best || q.dist < best.dist)) best = { ...q, k };
  }
  return best;
}

/** 기준선(정점을 잇는 선) 위 가장 가까운 선분과 거리 */
export function nearestSegment(e: MLineEntity, p: Vec2): { seg: number; u: number; dist: number; point: Vec2 } | null {
  const n = e.vertices.length;
  let best: { seg: number; u: number; dist: number; point: Vec2 } | null = null;
  for (let i = 0; i < segmentCount(e); i++) {
    const a = xy(e.vertices[i]!.position);
    const b = xy(e.vertices[(i + 1) % n]!.position);
    const d = sub(b, a);
    const L = len(d);
    const u = L > EPS ? Math.max(0, Math.min(L, dot(sub(p, a), d) / L)) : 0;
    const q = L > EPS ? add(a, mul(d, u / L)) : a;
    const dist = len(sub(p, q));
    if (!best || dist < best.dist) best = { seg: i, u, dist, point: q };
  }
  return best;
}

/** 요소들의 두 위치 사이 구간마다 fn(선분, 시작, 끝) */
function forRange(e: MLineEntity, k: number, a: ElementPos, b: ElementPos, fn: (seg: number, t0: number, t1: number) => void): void {
  let p = a;
  let q = b;
  if (q.seg < p.seg || (q.seg === p.seg && q.t < p.t)) [p, q] = [q, p];
  for (let i = p.seg; i <= q.seg; i++) {
    const L = segmentFrame(e, i, k).len;
    fn(i, i === p.seg ? p.t : 0, i === q.seg ? q.t : L);
  }
}

/** 단일 자르기: 요소 k를 두 점 사이에서 자른다 */
export function cutSingle(e: MLineEntity, k: number, p1: Vec2, p2: Vec2): MLineEntity {
  const r = cloneML(e);
  const a = projectToElement(r, k, p1);
  const b = projectToElement(r, k, p2);
  if (a && b) forRange(r, k, a, b, (i, t0, t1) => applyCut(r, k, i, t0, t1));
  return r;
}

/** 전체 자르기: 모든 요소를 두 점 사이에서 자른다(요소마다 두 점을 그 요소에 투영) */
export function cutAll(e: MLineEntity, p1: Vec2, p2: Vec2): MLineEntity {
  const r = cloneML(e);
  for (let k = 0; k < elementCount(r); k++) {
    const a = projectToElement(r, k, p1);
    const b = projectToElement(r, k, p2);
    if (a && b) forRange(r, k, a, b, (i, t0, t1) => applyCut(r, k, i, t0, t1));
  }
  return r;
}

/** 전체 용접: 두 점 사이의 끊기를 모두 없앤다 */
export function weldAll(e: MLineEntity, p1: Vec2, p2: Vec2): MLineEntity {
  const r = cloneML(e);
  for (let k = 0; k < elementCount(r); k++) {
    const a = projectToElement(r, k, p1);
    const b = projectToElement(r, k, p2);
    if (a && b) forRange(r, k, a, b, (i, t0, t1) => applyWeld(r, k, i, t0, t1));
  }
  return r;
}

// ---------------------------------------------------------------------------
// 정점
// ---------------------------------------------------------------------------

/** 정점 추가: 가장 가까운 선분 위에 정점을 넣는다(끊기는 두 선분으로 나눈다) */
export function addVertex(e: MLineEntity, p: Vec2): MLineEntity | null {
  const ns = nearestSegment(e, p);
  if (!ns) return null;
  const i = ns.seg;
  const n = e.vertices.length;
  const a = xy(e.vertices[i]!.position);
  const b = xy(e.vertices[(i + 1) % n]!.position);
  const segLen = len(sub(b, a));
  if (ns.u < segLen * 1e-6 || ns.u > segLen * (1 - 1e-6)) return null;
  const r = cloneML(e);
  const v = r.vertices[i]!;
  const D = norm(sub(b, a));
  const M = left(D);
  const dist = elementDistancesOf(e);
  const nv: MLineVertex = { position: p3(ns.point, v.position.z), direction: { x: D.x, y: D.y, z: 0 }, miter: { x: M.x, y: M.y, z: 0 }, elements: [] };
  for (let k = 0; k < dist.length; k++) {
    const f = segmentFrame(e, i, k);
    const q = add(ns.point, mul(M, dist[k]!));
    const tk = Math.max(0, Math.min(f.len, dot(sub(q, f.s), f.d)));
    const el = v.elements[k]!;
    const runs = runsOf(el.params, f.len);
    const before = runs.map(([s, t]) => [s, Math.min(t, tk)] as [number, number]).filter(([s, t]) => t > s);
    const after = runs.map(([s, t]) => [Math.max(s, tk) - tk, t - tk] as [number, number]).filter(([s, t]) => t > s);
    el.params = paramsFromRuns(el.params[0] ?? 0, before, tk);
    nv.elements.push({ params: paramsFromRuns(dist[k]!, after, f.len - tk), fillParams: [] });
  }
  r.vertices.splice(i + 1, 0, nv);
  return r;
}

/** 정점 삭제: 점에서 가장 가까운 정점을 뺀다(정점이 두 개 남으면 안 된다). 합쳐진 선분의 끊기는 지운다 */
export function deleteVertex(e: MLineEntity, p: Vec2, startAngle = Math.PI / 2, endAngle = Math.PI / 2): MLineEntity | null {
  const n = e.vertices.length;
  const closed = isClosed(e);
  if (n <= (closed ? 3 : 2)) return null;
  let bi = 0;
  let bd = Infinity;
  e.vertices.forEach((v, i) => {
    const d = Math.hypot(v.position.x - p.x, v.position.y - p.y);
    if (d < bd) (bd = d), (bi = i);
  });
  const pts = e.vertices.filter((_, i) => i !== bi).map((v) => xy(v.position));
  const r = cloneML(e);
  const dist = elementDistancesOf(e);
  const fresh = buildVertices(pts, closed, dist, startAngle, endAngle, e.vertices[0]!.position.z);
  // 남은 선분의 끊기는 그대로 둔다(합쳐진 선분만 새로)
  const keep = e.vertices.filter((_, i) => i !== bi);
  const merged = (bi - 1 + n) % n;
  r.vertices = fresh.map((v, j) => {
    const oldIndex = e.vertices.indexOf(keep[j]!);
    if (oldIndex === merged || (!closed && j === fresh.length - 1)) return v;
    const old = keep[j]!;
    v.elements = v.elements.map((el, k) => ({ params: [el.params[0]!, ...(old.elements[k]?.params.slice(1) ?? [0])], fillParams: [] }));
    return v;
  });
  r.startPoint = { ...r.vertices[0]!.position };
  return r;
}

// ---------------------------------------------------------------------------
// 교차 편집(MLEDIT)
// ---------------------------------------------------------------------------

/** 두 직선 P + D t, Q + E s의 교점 매개변수 t(평행이면 null) */
export function lineParam(P: Vec2, D: Vec2, Q: Vec2, E: Vec2): number | null {
  const c = cross(D, E);
  if (Math.abs(c) < 1e-12) return null;
  return cross(sub(Q, P), E) / c;
}

/** 가장 왼쪽·오른쪽 요소 번호 */
export function outerElements(e: MLineEntity): { min: number; max: number } {
  const d = elementDistancesOf(e);
  let min = 0;
  let max = 0;
  d.forEach((v, k) => {
    if (v < d[min]!) min = k;
    if (v > d[max]!) max = k;
  });
  return { min, max };
}

/** 선분 seg에서 요소 k를 상대 여러 줄 선분의 바깥 두 요소 사이에서 자른다 */
function cutBetween(target: MLineEntity, k: number, seg: number, other: MLineEntity, oseg: number): boolean {
  const f = segmentFrame(target, seg, k);
  const o = outerElements(other);
  const a = segmentFrame(other, oseg, o.min);
  const b = segmentFrame(other, oseg, o.max);
  const t1 = lineParam(f.s, f.d, a.s, a.d);
  const t2 = lineParam(f.s, f.d, b.s, b.d);
  if (t1 === null || t2 === null) return false;
  applyCut(target, k, seg, t1, t2);
  return true;
}

export type CrossKind = 'closed' | 'open' | 'merged';

/**
 * 십자형: a(첫 번째, 선분 sa)와 b(두 번째, 선분 sb).
 * 닫힌 십자형 = a의 모든 요소를 b 폭만큼 자른다. 열린 십자형 = 그리고 b의 바깥 요소를 a 폭만큼.
 * 병합된 십자형 = a·b 모두 바깥 요소만 자른다(안쪽 요소는 이어진다).
 */
export function crossJoint(a: MLineEntity, sa: number, b: MLineEntity, sb: number, kind: CrossKind): { a: MLineEntity; b: MLineEntity } | null {
  const ra = cloneML(a);
  const rb = cloneML(b);
  const oa = outerElements(a);
  const ob = outerElements(b);
  const aEls = kind === 'merged' ? [...new Set([oa.min, oa.max])] : Array.from({ length: elementCount(a) }, (_, k) => k);
  for (const k of aEls) if (!cutBetween(ra, k, sa, b, sb)) return null;
  if (kind !== 'closed') for (const k of new Set([ob.min, ob.max])) if (!cutBetween(rb, k, sb, a, sa)) return null;
  return { a: ra, b: rb };
}

/** 여러 줄을 선분 seg에서 끊어 남길 쪽만 둔다: keepStart면 seg 끝 정점을 end로, 아니면 seg 시작 정점을 end로 옮긴다 */
function truncateAt(e: MLineEntity, seg: number, keepStart: boolean, end: Vec2, miter: Vec2): MLineEntity {
  const r = cloneML(e);
  const dist = elementDistancesOf(e);
  if (keepStart) {
    r.vertices = r.vertices.slice(0, seg + 2);
    const last = r.vertices[seg + 1]!;
    const dir = xy(r.vertices[seg]!.direction);
    last.position = p3(end, last.position.z);
    last.direction = { x: dir.x, y: dir.y, z: 0 };
    last.miter = { x: miter.x, y: miter.y, z: 0 };
    last.elements = dist.map((d) => ({ params: [miterParam(dir, miter, d), 0], fillParams: [] }));
    // 바뀐 선분의 끊기는 길이가 바뀌므로 지운다
    const prev = r.vertices[seg]!;
    prev.elements = prev.elements.map((el) => ({ params: [el.params[0]!, 0], fillParams: [] }));
  } else {
    r.vertices = r.vertices.slice(seg);
    const first = r.vertices[0]!;
    const dir = xy(first.direction);
    first.position = p3(end, first.position.z);
    first.miter = { x: miter.x, y: miter.y, z: 0 };
    first.elements = dist.map((d) => ({ params: [miterParam(dir, miter, d), 0], fillParams: [] }));
  }
  r.flags &= ~2;
  r.startPoint = { ...r.vertices[0]!.position };
  return r;
}

/** 기준선과 상대 요소 선의 교점과 남길 쪽 */
function stemCut(a: MLineEntity, sa: number, pickA: Vec2, line: SegFrame): { keepStart: boolean; point: Vec2 } | null {
  const n = a.vertices.length;
  const P = xy(a.vertices[sa]!.position);
  const Q = xy(a.vertices[(sa + 1) % n]!.position);
  const D = norm(sub(Q, P));
  const t = lineParam(P, D, line.s, line.d);
  if (t === null) return null;
  const tp = dot(sub(pickA, P), D);
  return { keepStart: tp < t, point: add(P, mul(D, t)) };
}

export type TeeKind = 'closed' | 'open' | 'merged';

/**
 * T자형: a(줄기, 고른 점 쪽을 남긴다)를 b(막대)의 가까운 바깥 요소까지 자르거나 늘인다.
 * 열린·병합된 T자형은 b의 가까운 바깥 요소를 a 폭만큼 자른다. 병합된 T자형은 a의 안쪽 요소를 b 가운데까지 늘인다.
 */
export function teeJoint(a: MLineEntity, sa: number, pickA: Vec2, b: MLineEntity, sb: number, kind: TeeKind): { a: MLineEntity; b: MLineEntity } | null {
  if (isClosed(a)) return null;
  const ob = outerElements(b);
  const bRef = xy(b.vertices[sb]!.position);
  const bDir = norm(xy(b.vertices[sb]!.direction));
  // 고른 점이 막대 가운데선의 어느 쪽인지로 가까운 바깥 요소를 고른다
  const side = cross(bDir, sub(pickA, bRef));
  const middle = (elementDistance(b, ob.min, sb) + elementDistance(b, ob.max, sb)) / 2;
  const nearK = side >= middle ? ob.max : ob.min;
  const near = segmentFrame(b, sb, nearK);
  const mid: SegFrame = (() => {
    const lo = segmentFrame(b, sb, ob.min);
    const hi = segmentFrame(b, sb, ob.max);
    return { s: mul(add(lo.s, hi.s), 0.5), d: near.d, len: near.len };
  })();
  const target = kind === 'merged' && elementCount(a) > 2 ? mid : near;
  const cut = stemCut(a, sa, pickA, target);
  if (!cut) return null;
  // 끝 마이터는 막대 방향(줄기 방향의 왼쪽을 향하게)
  const aDir = norm(xy(a.vertices[sa]!.direction));
  let M = bDir;
  if (cross(aDir, M) < 0) M = mul(M, -1);
  const ra = truncateAt(a, sa, cut.keepStart, cut.point, M);
  const rb = cloneML(b);
  const oa = outerElements(ra);
  if (kind === 'merged' && target === mid) {
    // 바깥 요소는 막대의 가까운 선에서 멈춘다
    const segA = cut.keepStart ? ra.vertices.length - 2 : 0;
    for (const k of new Set([oa.min, oa.max])) {
      const f = segmentFrame(ra, segA, k);
      const t = lineParam(f.s, f.d, near.s, near.d);
      if (t === null) continue;
      if (cut.keepStart) applyCut(ra, k, segA, t, f.len);
      else applyCut(ra, k, segA, 0, t);
    }
  }
  if (kind !== 'closed') {
    // 막대의 가까운 요소를 줄기 바깥 요소 사이에서 자른다
    const segA = cut.keepStart ? ra.vertices.length - 2 : 0;
    const fa = segmentFrame(ra, segA, oa.min);
    const fb = segmentFrame(ra, segA, oa.max);
    const t1 = lineParam(near.s, near.d, fa.s, fa.d);
    const t2 = lineParam(near.s, near.d, fb.s, fb.d);
    if (t1 !== null && t2 !== null) applyCut(rb, nearK, sb, t1, t2);
  }
  return { a: ra, b: rb };
}

/** 구석 접합: 두 여러 줄을 기준선 교점까지 자르거나 늘이고, 끝 마이터를 두 방향의 이등분선으로 맞춘다 */
export function cornerJoint(a: MLineEntity, sa: number, pickA: Vec2, b: MLineEntity, sb: number, pickB: Vec2): { a: MLineEntity; b: MLineEntity } | null {
  if (isClosed(a) || isClosed(b)) return null;
  const na = a.vertices.length;
  const nb = b.vertices.length;
  const Pa = xy(a.vertices[sa]!.position);
  const Da = norm(sub(xy(a.vertices[(sa + 1) % na]!.position), Pa));
  const Pb = xy(b.vertices[sb]!.position);
  const Db = norm(sub(xy(b.vertices[(sb + 1) % nb]!.position), Pb));
  const ta = lineParam(Pa, Da, Pb, Db);
  const tb = lineParam(Pb, Db, Pa, Da);
  if (ta === null || tb === null) return null;
  const X = add(Pa, mul(Da, ta));
  const keepA = dot(sub(pickA, Pa), Da) < ta;
  const keepB = dot(sub(pickB, Pb), Db) < tb;
  // 꺾인 길: a를 따라 X로 들어와 b를 따라 나간다
  const inA = keepA ? Da : mul(Da, -1);
  const outB = keepB ? mul(Db, -1) : Db;
  const M = bisectMiter(inA, outB);
  const fix = (dir: Vec2) => (cross(dir, M) < 0 ? mul(M, -1) : M);
  const ra = truncateAt(a, sa, keepA, X, fix(Da));
  const rb = truncateAt(b, sb, keepB, X, fix(Db));
  return { a: ra, b: rb };
}
