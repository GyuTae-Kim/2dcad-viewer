/**
 * PEDIT 계산: 폴리선(LWPOLYLINE, 2D·3D POLYLINE)의 닫기·열기·폭·맞춤·스플라인·비곡선화·선종류 생성·정점 편집,
 * 선·호·스플라인 → 폴리선 변환.
 *
 * - 맞춤(F): 정점마다 접선(이웃 두 정점과 지나는 원의 접선)을 정하고 세그먼트마다 두 호(이중 호)로 잇는다.
 *   2D POLYLINE(70 비트 2)이 되고, 더한 정점은 VERTEX 70 비트 1이다.
 * - 스플라인(S): 정점을 조정점으로 하는 2차(SPLINETYPE 5)·3차(6) 균일 B 스플라인을 SPLINESEGS로 나눈 꺾은선.
 *   2D·3D POLYLINE(70 비트 4, 75 = 5·6)이 되고, 틀 정점은 VERTEX 70 비트 16, 만든 정점은 8이다.
 * - 비곡선화(D): 맞춤·스플라인이 더한 정점을 지우고 틀을 되살린다. 모든 세그먼트를 직선으로.
 * 맞춤·스플라인 폴리선을 닫기·열기·폭·정점 편집·반전하면 틀을 고친 뒤 다시 맞춘다.
 */
import type { ArcEntity, Entity, LineEntity, LwPolylineEntity, LwVertex, PolyVertex, PolylineEntity, SplineEntity, Vec2, Vec3 } from '../../core/model';
import { clampedKnots } from '../../geom/curves';
import { lwPoints, lwVertices, packLw, packLwPoints } from '../../core/lwpoly';
import { type Affine, ccwSweep, cross, dist, dot, norm, rot90, sub, sweepToBulge } from './math';
import { domain, nurbsPoint } from './nurbs';
import { inherit, splineNurbs } from './path';
import { planProj } from './ocs';
import { affApply } from './math';

export type PolyEntity = LwPolylineEntity | PolylineEntity;

/** 편집용 정점(2D는 OCS, 3D는 WCS) */
export interface PV {
  x: number;
  y: number;
  z: number;
  bulge: number;
  sw: number;
  ew: number;
}

export type FitKind = 'none' | 'fit' | 'spline';

export function isPolyline(e: Entity): e is PolyEntity {
  return e.type === 'LWPOLYLINE' || (e.type === 'POLYLINE' && (e.kind === '2d' || e.kind === '3d'));
}

export function is3d(e: PolyEntity): boolean {
  return e.type === 'POLYLINE' && e.kind === '3d';
}

export function isClosed(e: PolyEntity): boolean {
  return e.type === 'LWPOLYLINE' ? e.closed : (e.flags & 1) !== 0;
}

export function fitKind(e: PolyEntity): FitKind {
  if (e.type !== 'POLYLINE') return 'none';
  if (e.flags & 4) return 'spline';
  if (e.flags & 2) return 'fit';
  return 'none';
}

/** 편집할 정점(맞춤·스플라인 폴리선은 틀 정점) */
export function frameVerts(e: PolyEntity): PV[] {
  if (e.type === 'LWPOLYLINE') return lwVertices(e).map((v) => ({ x: v.x, y: v.y, z: e.elevation, bulge: v.bulge, sw: v.startWidth, ew: v.endWidth }));
  const fk = fitKind(e);
  let vs: PolyVertex[];
  if (fk === 'spline') vs = e.vertices.filter((v) => v.flags & 16);
  else if (fk === 'fit') vs = e.vertices.filter((v) => !(v.flags & 1) && !(v.flags & 16));
  else vs = e.vertices.filter((v) => !(v.flags & 16));
  if (fk === 'spline' && vs.length < 2) vs = e.vertices.filter((v) => !(v.flags & 8));
  return vs.map((v) => ({ x: v.location.x, y: v.location.y, z: v.location.z, bulge: fk === 'none' ? v.bulge : 0, sw: v.startWidth, ew: v.endWidth }));
}

/** 정점으로 같은 종류의 폴리선을 다시 만든다(맞춤 정보는 지운다) */
export function withVerts(e: PolyEntity, verts: readonly PV[], closed: boolean): PolyEntity {
  if (e.type === 'LWPOLYLINE') {
    return {
      ...e,
      ...packLw(verts.map((v): LwVertex => ({ x: v.x, y: v.y, bulge: v.bulge, startWidth: v.sw, endWidth: v.ew }))),
      closed,
    };
  }
  const d3 = e.kind === '3d';
  return {
    ...e,
    flags: (e.flags & ~(1 | 2 | 4)) | (closed ? 1 : 0),
    smoothType: 0,
    vertices: verts.map((v): PolyVertex => ({ location: { x: v.x, y: v.y, z: d3 ? v.z : e.elevation }, bulge: d3 ? 0 : v.bulge, startWidth: v.sw, endWidth: v.ew, flags: d3 ? 32 : 0 })),
  };
}

/** 틀을 고친 뒤 원래 맞춤 종류대로 다시 맞춘다 */
export function editFrame(e: PolyEntity, verts: readonly PV[], closed: boolean, splinesegs = 8): PolyEntity {
  const fk = fitKind(e);
  const base = withVerts(e, verts, closed);
  if (fk === 'fit') return fitPolyline(base);
  if (fk === 'spline' && e.type === 'POLYLINE') return splinePolyline(base, e.smoothType === 5 ? 5 : 6, splinesegs);
  return base;
}

// ---------------------------------------------------------------------------
// 단순 편집
// ---------------------------------------------------------------------------

export function setClosed(e: PolyEntity, closed: boolean, splinesegs = 8): PolyEntity {
  return editFrame(e, frameVerts(e), closed, splinesegs);
}

/** 모든 세그먼트를 폭 w로(LWPOLYLINE은 전역 폭) */
export function setWidth(e: PolyEntity, w: number, splinesegs = 8): PolyEntity {
  const verts = frameVerts(e).map((v) => ({ ...v, sw: e.type === 'LWPOLYLINE' ? 0 : w, ew: e.type === 'LWPOLYLINE' ? 0 : w }));
  if (e.type === 'LWPOLYLINE') return { ...withVerts(e, verts, e.closed), constantWidth: w } as LwPolylineEntity;
  const out = editFrame(e, verts, isClosed(e), splinesegs) as PolylineEntity;
  out.defaultStartWidth = w;
  out.defaultEndWidth = w;
  for (const v of out.vertices) {
    v.startWidth = w;
    v.endWidth = w;
  }
  return out;
}

export function setLinetypeGen(e: PolyEntity, on: boolean): PolyEntity {
  if (e.type === 'LWPOLYLINE') return { ...e, plinegen: on };
  return { ...e, flags: on ? e.flags | 128 : e.flags & ~128 };
}

/** 비곡선화: 맞춤·스플라인 정점을 지우고 틀을 되살리며 모든 세그먼트를 직선으로 */
export function decurve(e: PolyEntity): PolyEntity {
  const verts = frameVerts(e).map((v) => ({ ...v, bulge: 0 }));
  return withVerts(e, verts, isClosed(e));
}

// ---------------------------------------------------------------------------
// 정점 편집
// ---------------------------------------------------------------------------

/** i 정점 다음에 점 p를 넣는다(나뉜 세그먼트는 직선, 폭은 길이 비율로) */
export function insertVertex(e: PolyEntity, i: number, p: Vec2, splinesegs = 8): PolyEntity | null {
  const vs = frameVerts(e);
  if (i < 0 || i >= vs.length) return null;
  const closed = isClosed(e);
  const a = vs[i]!;
  const b = vs[(i + 1) % vs.length];
  const out = vs.map((v) => ({ ...v }));
  let w = a.ew;
  if (b && (i + 1 < vs.length || closed)) {
    const L = dist(a, b);
    const t = L > 0 ? Math.min(1, dist(a, p) / L) : 0.5;
    w = a.sw + (a.ew - a.sw) * t;
  }
  out[i] = { ...a, bulge: 0, ew: w };
  out.splice(i + 1, 0, { x: p.x, y: p.y, z: a.z, bulge: 0, sw: w, ew: a.ew });
  return editFrame(e, out, closed, splinesegs);
}

export function moveVertex(e: PolyEntity, i: number, p: Vec2 | Vec3, splinesegs = 8): PolyEntity | null {
  const vs = frameVerts(e);
  if (i < 0 || i >= vs.length) return null;
  const out = vs.map((v) => ({ ...v }));
  out[i] = { ...out[i]!, x: p.x, y: p.y, z: 'z' in p && is3d(e) ? p.z : out[i]!.z };
  return editFrame(e, out, isClosed(e), splinesegs);
}

/** 정점 지우기(최소 2개). 앞 세그먼트의 시작 폭에서 뒤 세그먼트의 끝 폭으로, 이어진 세그먼트는 직선 */
export function removeVertex(e: PolyEntity, i: number, splinesegs = 8): PolyEntity | null {
  const vs = frameVerts(e);
  if (vs.length <= 2 || i < 0 || i >= vs.length) return null;
  const closed = isClosed(e);
  const out = vs.map((v) => ({ ...v }));
  const n = out.length;
  const prev = i > 0 ? i - 1 : closed ? n - 1 : -1;
  if (prev >= 0) out[prev] = { ...out[prev]!, bulge: 0, ew: out[i]!.ew };
  out.splice(i, 1);
  return editFrame(e, out, closed, splinesegs);
}

/** i 정점에서 나가는 세그먼트의 시작·끝 폭 */
export function setSegmentWidth(e: PolyEntity, i: number, sw: number, ew: number, splinesegs = 8): PolyEntity | null {
  const vs = frameVerts(e);
  if (i < 0 || i >= vs.length) return null;
  const out = vs.map((v) => ({ ...v }));
  if (e.type === 'LWPOLYLINE' && e.constantWidth > 0) for (const v of out) if (!v.sw && !v.ew) v.sw = v.ew = e.constantWidth;
  out[i] = { ...out[i]!, sw, ew };
  const r = editFrame(e, out, isClosed(e), splinesegs);
  if (r.type === 'LWPOLYLINE') r.constantWidth = 0;
  return r;
}

// ---------------------------------------------------------------------------
// 맞춤(이중 호)
// ---------------------------------------------------------------------------

/** 세 점을 지나는 원 위에서 점 x의 진행 방향 접선(a → b → c 순서). 일직선이면 null */
function circleTangent(a: Vec2, b: Vec2, c: Vec2, x: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const scale = Math.max(dist(a, b), dist(b, c), 1e-300);
  if (Math.abs(d) < 1e-12 * scale * scale) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const o = { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
  const ccw = cross(sub(b, a), sub(c, b)) > 0;
  const t = norm(rot90(sub(x, o)));
  return ccw ? t : { x: -t.x, y: -t.y };
}

/** 정점마다 맞춤 접선 */
export function fitTangents(pts: readonly Vec2[], closed: boolean): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    let a: Vec2;
    let b: Vec2;
    let c: Vec2;
    let at: Vec2;
    if (closed || (i > 0 && i < n - 1)) {
      a = pts[(i - 1 + n) % n]!;
      b = pts[i]!;
      c = pts[(i + 1) % n]!;
      at = b;
    } else if (i === 0) {
      a = pts[0]!;
      b = pts[1]!;
      c = pts[Math.min(2, n - 1)]!;
      at = a;
    } else {
      a = pts[Math.max(0, n - 3)]!;
      b = pts[n - 2]!;
      c = pts[n - 1]!;
      at = c;
    }
    const t = n >= 3 ? circleTangent(a, b, c, at) : null;
    out.push(t ?? norm(sub(c, a)));
  }
  return out;
}

/** 각 a → b의 부호 있는 각도 */
function signedAngle(a: Vec2, b: Vec2): number {
  return Math.atan2(cross(a, b), dot(a, b));
}

/**
 * P0(접선 t0) → P1(접선 t1) 이중 호: 이음점과 두 호의 볼록도.
 * 같은 길이 d로 접선을 따라 나간 두 점의 가운데가 이음점이다.
 */
export function biarc(p0: Vec2, t0: Vec2, p1: Vec2, t1: Vec2): { j: Vec2; b0: number; b1: number } {
  const v = sub(p1, p0);
  const vv = dot(v, v);
  const t = { x: t0.x + t1.x, y: t0.y + t1.y };
  const vt = dot(v, t);
  const denom = 2 * (1 - dot(t0, t1));
  let d: number;
  if (Math.abs(denom) < 1e-12) {
    const vt1 = dot(v, t1);
    d = Math.abs(vt1) > 1e-300 ? vv / (4 * vt1) : 0;
  } else d = (-vt + Math.sqrt(Math.max(0, vt * vt + denom * vv))) / denom;
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  if (!(d > 0) || !Number.isFinite(d)) return { j: mid, b0: 0, b1: 0 };
  const j = { x: (p0.x + p1.x + d * (t0.x - t1.x)) / 2, y: (p0.y + p1.y + d * (t0.y - t1.y)) / 2 };
  const c0 = sub(j, p0);
  const c1 = sub(p1, j);
  if (dot(c0, c0) < 1e-24 * vv || dot(c1, c1) < 1e-24 * vv) return { j: mid, b0: 0, b1: 0 };
  const s0 = 2 * signedAngle(t0, c0);
  const s1 = 2 * signedAngle(c1, t1);
  return { j, b0: sweepToBulge(s0), b1: sweepToBulge(s1) };
}

function toPolyline2d(e: PolyEntity): PolylineEntity {
  if (e.type === 'POLYLINE') return e;
  const cw = e.constantWidth || 0;
  return {
    type: 'POLYLINE',
    ...inherit(e),
    handle: e.handle,
    ...(e.xdict ? { xdict: e.xdict } : {}),
    ...(e.reactors ? { reactors: [...e.reactors] } : {}),
    ...(e.extrusion ? { extrusion: { ...e.extrusion } } : {}),
    kind: '2d',
    flags: (e.closed ? 1 : 0) | (e.plinegen ? 128 : 0),
    vertices: lwVertices(e).map((v) => ({ location: { x: v.x, y: v.y, z: e.elevation }, bulge: v.bulge, startWidth: v.startWidth || cw, endWidth: v.endWidth || cw, flags: 0 })),
    elevation: e.elevation,
    defaultStartWidth: cw,
    defaultEndWidth: cw,
    mCount: 0,
    nCount: 0,
    mDensity: 0,
    nDensity: 0,
    smoothType: 0,
  } as PolylineEntity;
}

/** 맞춤(이중 호) — 3D 폴리선은 그대로 돌려준다 */
export function fitPolyline(e0: PolyEntity): PolyEntity {
  if (is3d(e0)) return e0;
  const e = toPolyline2d(e0);
  const vs = frameVerts(e);
  const closed = isClosed(e);
  const n = vs.length;
  if (n < 2) return e;
  const pts = vs.map((v) => ({ x: v.x, y: v.y }));
  const tans = fitTangents(pts, closed);
  const out: PolyVertex[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const v = vs[i]!;
    if (i >= segs) {
      out.push({ location: { x: v.x, y: v.y, z: e.elevation }, bulge: 0, startWidth: v.sw, endWidth: v.ew, flags: 0 });
      continue;
    }
    const r = biarc(pts[i]!, tans[i]!, pts[(i + 1) % n]!, tans[(i + 1) % n]!);
    const wm = (v.sw + v.ew) / 2;
    out.push({ location: { x: v.x, y: v.y, z: e.elevation }, bulge: r.b0, startWidth: v.sw, endWidth: wm, flags: 0 });
    out.push({ location: { x: r.j.x, y: r.j.y, z: e.elevation }, bulge: r.b1, startWidth: wm, endWidth: v.ew, flags: 1 });
  }
  return { ...e, flags: (e.flags & ~4) | 2, smoothType: 0, vertices: out };
}

// ---------------------------------------------------------------------------
// 스플라인 맞춤
// ---------------------------------------------------------------------------

/** 틀 정점(조정점)의 균일 B 스플라인 위 점들. 닫힌 틀은 주기 곡선 */
export function splineFitPoints(ctrl: readonly Vec3[], degree: 2 | 3, closed: boolean, segs: number): Vec3[] {
  const n = ctrl.length;
  if (n < 2) return ctrl.map((p) => ({ ...p }));
  const p = Math.min(degree, closed ? n - 1 : n - 1);
  const s = Math.max(1, Math.min(1024, Math.round(Math.abs(segs) || 8)));
  let P: Vec3[];
  let U: number[];
  if (closed && n >= 3) {
    P = [...ctrl, ...ctrl.slice(0, p)];
    U = [];
    for (let i = 0; i < P.length + p + 1; i++) U.push(i);
  } else {
    P = [...ctrl];
    U = clampedKnots(n, p);
  }
  const c = { degree: p, knots: U, ctrl: P };
  const [a, b] = domain(c);
  const total = closed && n >= 3 ? n * s : (n - 1) * s;
  const out: Vec3[] = [];
  const last = closed && n >= 3 ? total - 1 : total;
  for (let i = 0; i <= last; i++) out.push(nurbsPoint(c, a + ((b - a) * i) / total));
  return out;
}

/** 스플라인 맞춤(type 5 = 2차, 6 = 3차) */
export function splinePolyline(e0: PolyEntity, type: 5 | 6, segs = 8): PolylineEntity {
  const e = toPolyline2d(e0);
  const vs = frameVerts(e);
  const closed = isClosed(e);
  const d3 = e.kind === '3d';
  const ctrl = vs.map((v) => ({ x: v.x, y: v.y, z: d3 ? v.z : e.elevation }));
  const pts = splineFitPoints(ctrl, type === 5 ? 2 : 3, closed, segs);
  // 폭: 첫 정점의 폭에서 마지막 정점의 폭으로 점점 변한다
  const w0 = vs[0]?.sw ?? 0;
  const w1 = closed ? w0 : (vs[vs.length - 1]?.ew ?? vs[vs.length - 2]?.ew ?? 0);
  const m = pts.length;
  const segCount = closed ? m : m - 1;
  const gen: PolyVertex[] = pts.map((q, i) => {
    const t0 = segCount > 0 ? Math.min(1, i / segCount) : 0;
    const t1 = segCount > 0 ? Math.min(1, (i + 1) / segCount) : 0;
    return { location: { x: q.x, y: q.y, z: d3 ? q.z : e.elevation }, bulge: 0, startWidth: d3 ? 0 : w0 + (w1 - w0) * t0, endWidth: d3 ? 0 : w0 + (w1 - w0) * t1, flags: d3 ? 8 | 32 : 8 };
  });
  const frame: PolyVertex[] = vs.map((v) => ({ location: { x: v.x, y: v.y, z: d3 ? v.z : e.elevation }, bulge: 0, startWidth: v.sw, endWidth: v.ew, flags: d3 ? 16 | 32 : 16 }));
  return { ...e, flags: (e.flags & ~2) | 4, smoothType: type, vertices: [...gen, ...frame] };
}

// ---------------------------------------------------------------------------
// 변환
// ---------------------------------------------------------------------------

/** 선·호 → LWPOLYLINE(같은 OCS). 다른 객체는 null */
export function toPolyline(e: Entity): LwPolylineEntity | null {
  if (e.type === 'LINE') return lineToPoly(e);
  if (e.type === 'ARC') return arcToPoly(e);
  return null;
}

function lineToPoly(e: LineEntity): LwPolylineEntity {
  return {
    type: 'LWPOLYLINE',
    ...inherit(e),
    ...packLw([
      { x: e.start.x, y: e.start.y, bulge: 0, startWidth: 0, endWidth: 0 },
      { x: e.end.x, y: e.end.y, bulge: 0, startWidth: 0, endWidth: 0 },
    ]),
    closed: false,
    plinegen: false,
    constantWidth: 0,
    elevation: e.start.z,
  };
}

function arcToPoly(e: ArcEntity): LwPolylineEntity {
  const sw = ccwSweep(e.startAngle, e.endAngle);
  const c = e.center;
  const a = { x: c.x + e.radius * Math.cos(e.startAngle), y: c.y + e.radius * Math.sin(e.startAngle) };
  const b = { x: c.x + e.radius * Math.cos(e.startAngle + sw), y: c.y + e.radius * Math.sin(e.startAngle + sw) };
  // 반원이 넘으면 두 세그먼트로(볼록도가 너무 커지지 않게)
  const verts: LwVertex[] =
    sw > Math.PI
      ? [
          { x: a.x, y: a.y, bulge: sweepToBulge(sw / 2), startWidth: 0, endWidth: 0 },
          { x: c.x + e.radius * Math.cos(e.startAngle + sw / 2), y: c.y + e.radius * Math.sin(e.startAngle + sw / 2), bulge: sweepToBulge(sw / 2), startWidth: 0, endWidth: 0 },
          { x: b.x, y: b.y, bulge: 0, startWidth: 0, endWidth: 0 },
        ]
      : [
          { x: a.x, y: a.y, bulge: sweepToBulge(sw), startWidth: 0, endWidth: 0 },
          { x: b.x, y: b.y, bulge: 0, startWidth: 0, endWidth: 0 },
        ];
  const out: LwPolylineEntity = { type: 'LWPOLYLINE', ...inherit(e), ...packLw(verts), closed: false, plinegen: false, constantWidth: 0, elevation: c.z };
  if (e.extrusion) out.extrusion = { ...e.extrusion };
  return out;
}

/**
 * 스플라인 → 폴리선: 매듭 구간마다 precision개(0이면 1개) 선분. 평면이면 LWPOLYLINE, 아니면 3D POLYLINE.
 */
export function splineToPolyline(e: SplineEntity, precision = 10): PolyEntity | null {
  const n = splineNurbs(e);
  if (!n) return null;
  const [a, b] = domain(n);
  const U = [...new Set(n.knots.filter((k) => k >= a && k <= b))].sort((x, y) => x - y);
  const per = Math.max(1, Math.min(99, Math.round(precision)) || 1);
  const pts: Vec3[] = [];
  for (let i = 0; i + 1 < U.length; i++) {
    const u0 = U[i]!;
    const u1 = U[i + 1]!;
    for (let k = i === 0 ? 0 : 1; k <= per; k++) pts.push(nurbsPoint(n, u0 + ((u1 - u0) * k) / per));
  }
  const closed = (e.flags & 1) !== 0 && pts.length > 2 && dist(pts[0]!, pts[pts.length - 1]!) <= 1e-9 * Math.max(1, Math.abs(pts[0]!.x), Math.abs(pts[0]!.y));
  if (closed) pts.pop();
  const planar = pts.every((q) => Math.abs(q.z - pts[0]!.z) < 1e-9);
  if (planar) {
    return {
      type: 'LWPOLYLINE',
      ...inherit(e),
      ...packLwPoints(pts),
      closed,
      plinegen: false,
      constantWidth: 0,
      elevation: pts[0]?.z ?? 0,
    };
  }
  return {
    type: 'POLYLINE',
    ...inherit(e),
    kind: '3d',
    flags: 8 | (closed ? 1 : 0),
    vertices: pts.map((q) => ({ location: { ...q }, bulge: 0, startWidth: 0, endWidth: 0, flags: 32 })),
    elevation: 0,
    defaultStartWidth: 0,
    defaultEndWidth: 0,
    mCount: 0,
    nCount: 0,
    mDensity: 0,
    nDensity: 0,
    smoothType: 0,
  };
}

/** 폴리선 끝점(평면도, WCS) — 결합 후보를 고를 때 */
export function polyEnds(e: PolyEntity): [Vec2, Vec2] | null {
  const vs = e.type === 'LWPOLYLINE' ? lwPoints(e) : e.vertices.filter((v) => !(v.flags & 16)).map((v) => ({ x: v.location.x, y: v.location.y }));
  if (vs.length < 2) return null;
  if (is3d(e)) return [vs[0]!, vs[vs.length - 1]!];
  const P: Affine = planProj(e.extrusion, e.elevation);
  return [affApply(P, vs[0]!), affApply(P, vs[vs.length - 1]!)];
}

/** 정점의 평면도 위치(WCS) — 정점 편집 표시 */
export function vertexPoint(e: PolyEntity, v: PV): Vec2 {
  if (is3d(e)) return { x: v.x, y: v.y };
  return affApply(planProj(e.extrusion, e.elevation), v);
}

/** 평면도 점(WCS) → 폴리선 OCS 점 */
export function toOcs(e: PolyEntity, p: Vec2): Vec2 {
  if (is3d(e)) return p;
  const P = planProj(e.extrusion, e.elevation);
  // P는 직교(축 뒤집기·이동)라 역은 전치
  const x = p.x - P[4];
  const y = p.y - P[5];
  return { x: P[0] * x + P[1] * y, y: P[2] * x + P[3] * y };
}
