/**
 * 그리기 명령의 형상 계산(DOM 없음): RECTANG(회전·모따기·모깎기·영역), CIRCLE Ttr(접선 접선 반지름),
 * XLINE 이등분·간격띄우기, PLINE 호 옵션(중심·반지름·방향)의 볼록 값, ELLIPSE 호의 각도 ↔ 매개변수.
 * 좌표는 WCS 평면도다.
 */
import type { Entity, EntityBase, LwVertex, SplineEntity, Vec2, Vec3 } from '../../core/model';
import { clampedKnots, interpolateFitPoints } from '../../geom/curves';
import type { Piece } from './curve';
import { pieceNearest } from './curve';
import { ccwSweep, dist, wrapPi } from './math';
import { interpolate } from './nurbs';
import { inherit } from './path';
import { fitKind, frameVerts, isClosed, isPolyline } from './pedit';
import { closeSpline } from './splinedit';

// ---------------------------------------------------------------------------
// RECTANG
// ---------------------------------------------------------------------------

export interface RectOptions {
  /** 모따기 거리(첫 번째 = 회전한 X축 방향 변, 두 번째 = Y축 방향 변) */
  chamfer?: [number, number];
  /** 모깎기 반지름 */
  fillet?: number;
  /** 선 폭 */
  width?: number;
}

/** 첫 구석점 a와 다른 구석점 b, 회전 각도(라디안)로 네 구석(a에서 시작해 X축 방향 변 먼저) */
export function rectCorners(a: Vec2, b: Vec2, rot = 0): Vec2[] {
  const u = { x: Math.cos(rot), y: Math.sin(rot) };
  const v = { x: -u.y, y: u.x };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lx = dx * u.x + dy * u.y;
  const ly = dx * v.x + dy * v.y;
  return [a, { x: a.x + u.x * lx, y: a.y + u.y * lx }, { x: a.x + u.x * lx + v.x * ly, y: a.y + u.y * lx + v.y * ly }, { x: a.x + v.x * ly, y: a.y + v.y * ly }];
}

/** 길이(X)·폭(Y)과 방향 부호로 다른 구석점 */
export function rectOtherCorner(a: Vec2, length: number, width: number, rot = 0, sx = 1, sy = 1): Vec2 {
  const u = { x: Math.cos(rot), y: Math.sin(rot) };
  const v = { x: -u.y, y: u.x };
  return { x: a.x + u.x * length * sx + v.x * width * sy, y: a.y + u.y * length * sx + v.y * width * sy };
}

/** 모따기·모깎기가 이 크기의 직사각형에 들어가는지 */
export function rectCornersFit(length: number, width: number, opt: RectOptions): boolean {
  const L = Math.abs(length);
  const W = Math.abs(width);
  if (opt.fillet && opt.fillet > 0) return 2 * opt.fillet <= L + 1e-12 && 2 * opt.fillet <= W + 1e-12;
  if (opt.chamfer && (opt.chamfer[0] > 0 || opt.chamfer[1] > 0)) return 2 * opt.chamfer[0] <= L + 1e-12 && 2 * opt.chamfer[1] <= W + 1e-12;
  return true;
}

/**
 * 직사각형 폴리선 정점(닫힘). 모따기·모깎기는 구석마다 들어오는 변·나가는 변을 자르고,
 * 모깎기는 그 사이를 90° 호(볼록 = ±tan(π/8), 방향은 직사각형의 감김 방향)로 잇는다.
 * 들어가지 않으면 구석을 그대로 둔다.
 */
export function rectVertices(corners: readonly Vec2[], opt: RectOptions = {}): LwVertex[] {
  const w = opt.width ?? 0;
  const vx = (p: Vec2, bulge = 0): LwVertex => ({ x: p.x, y: p.y, bulge, startWidth: w, endWidth: w });
  const L = dist(corners[0]!, corners[1]!);
  const W = dist(corners[1]!, corners[2]!);
  const r = opt.fillet ?? 0;
  const ch = opt.chamfer ?? [0, 0];
  const useFillet = r > 0 && rectCornersFit(L, W, { fillet: r });
  const useChamfer = !useFillet && (ch[0] > 0 || ch[1] > 0) && rectCornersFit(L, W, { chamfer: ch });
  if (!useFillet && !useChamfer) return corners.map((p) => vx(p));
  // 감김 방향: 넓이 부호
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = corners[i]!;
    const q = corners[(i + 1) % 4]!;
    area += p.x * q.y - q.x * p.y;
  }
  const bulge = (area >= 0 ? 1 : -1) * Math.tan(Math.PI / 8);
  const out: LwVertex[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = corners[(i + 3) % 4]!;
    const P = corners[i]!;
    const next = corners[(i + 1) % 4]!;
    const lin = dist(prev, P);
    const lout = dist(P, next);
    // 변 0·2는 X축 방향, 변 1·3은 Y축 방향 → 구석 i로 들어오는 변은 (i + 3) % 4
    const inX = (i + 3) % 2 === 0;
    const cutIn = useFillet ? r : inX ? ch[0] : ch[1];
    const cutOut = useFillet ? r : inX ? ch[1] : ch[0];
    const p1 = lin > 0 ? { x: P.x + ((prev.x - P.x) * cutIn) / lin, y: P.y + ((prev.y - P.y) * cutIn) / lin } : P;
    const p2 = lout > 0 ? { x: P.x + ((next.x - P.x) * cutOut) / lout, y: P.y + ((next.y - P.y) * cutOut) / lout } : P;
    out.push(vx(p1, useFillet ? bulge : 0), vx(p2));
  }
  // 겹친 정점(자른 길이가 변의 절반)은 하나로: 뒤 정점의 볼록을 앞 정점이 잇는다
  const merged: LwVertex[] = [];
  for (const v of out) {
    const last = merged[merged.length - 1];
    if (last && Math.hypot(last.x - v.x, last.y - v.y) <= 1e-9 * Math.max(1, Math.abs(v.x), Math.abs(v.y))) last.bulge = v.bulge || last.bulge;
    else merged.push(v);
  }
  const first = merged[0]!;
  const last = merged[merged.length - 1]!;
  if (merged.length > 1 && Math.hypot(last.x - first.x, last.y - first.y) <= 1e-9 * Math.max(1, Math.abs(first.x), Math.abs(first.y))) {
    merged.pop();
    last.bulge = last.bulge || 0;
  }
  return merged;
}

/** 모따기·모깎기로 줄어드는 넓이(구석 네 곳) */
export function rectAreaLoss(opt: RectOptions): number {
  if (opt.fillet && opt.fillet > 0) return (4 - Math.PI) * opt.fillet * opt.fillet;
  if (opt.chamfer) return 2 * opt.chamfer[0] * opt.chamfer[1];
  return 0;
}

/** 영역(A): 넓이와 한 변(길이 또는 폭)으로 다른 변. 모따기·모깎기 넓이를 뺀 값이 넓이가 되게 */
export function rectOtherSide(area: number, side: number, opt: RectOptions): number | null {
  if (!(side > 0) || !(area > 0)) return null;
  const v = (area + rectAreaLoss(opt)) / side;
  return v > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// CIRCLE Ttr
// ---------------------------------------------------------------------------

type Locus = { k: 'line'; a: Vec2; d: Vec2 } | { k: 'circle'; c: Vec2; r: number };

/** 조각을 연장한 곡선(선 → 무한선, 호 → 원). 타원·스플라인은 null */
function carrier(p: Piece): { k: 'line'; a: Vec2; d: Vec2 } | { k: 'circle'; c: Vec2; r: number } | null {
  if (p.k === 'line') {
    const l = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    return l > 0 ? { k: 'line', a: p.a, d: { x: (p.b.x - p.a.x) / l, y: (p.b.y - p.a.y) / l } } : null;
  }
  if (p.k === 'arc') return { k: 'circle', c: p.c, r: p.r };
  return null;
}

/** 곡선에서 거리 r인 점의 자취(선 → 평행선 둘, 원 → 동심원) */
function loci(c: NonNullable<ReturnType<typeof carrier>>, r: number): Locus[] {
  if (c.k === 'line') {
    const n = { x: -c.d.y, y: c.d.x };
    return [
      { k: 'line', a: { x: c.a.x + n.x * r, y: c.a.y + n.y * r }, d: c.d },
      { k: 'line', a: { x: c.a.x - n.x * r, y: c.a.y - n.y * r }, d: c.d },
    ];
  }
  const out: Locus[] = [{ k: 'circle', c: c.c, r: c.r + r }];
  if (Math.abs(c.r - r) > 1e-12) out.push({ k: 'circle', c: c.c, r: Math.abs(c.r - r) });
  return out;
}

function meet(A: Locus, B: Locus): Vec2[] {
  if (A.k === 'line' && B.k === 'line') {
    const den = A.d.x * B.d.y - A.d.y * B.d.x;
    if (Math.abs(den) < 1e-12) return [];
    const t = ((B.a.x - A.a.x) * B.d.y - (B.a.y - A.a.y) * B.d.x) / den;
    return [{ x: A.a.x + A.d.x * t, y: A.a.y + A.d.y * t }];
  }
  if (A.k === 'circle' && B.k === 'line') return meet(B, A);
  if (A.k === 'line' && B.k === 'circle') {
    const fx = A.a.x - B.c.x;
    const fy = A.a.y - B.c.y;
    const b = fx * A.d.x + fy * A.d.y;
    const c = fx * fx + fy * fy - B.r * B.r;
    const disc = b * b - c;
    if (disc < -1e-12 * Math.max(1, B.r * B.r)) return [];
    const s = Math.sqrt(Math.max(0, disc));
    return [-b - s, -b + s].map((t) => ({ x: A.a.x + A.d.x * t, y: A.a.y + A.d.y * t }));
  }
  if (A.k === 'circle' && B.k === 'circle') {
    const d = dist(A.c, B.c);
    if (d < 1e-12 || d > A.r + B.r + 1e-9 || d < Math.abs(A.r - B.r) - 1e-9) return [];
    const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, A.r * A.r - a * a));
    const ux = (B.c.x - A.c.x) / d;
    const uy = (B.c.y - A.c.y) / d;
    const mx = A.c.x + ux * a;
    const my = A.c.y + uy * a;
    return [
      { x: mx - uy * h, y: my + ux * h },
      { x: mx + uy * h, y: my - ux * h },
    ];
  }
  return [];
}

/**
 * 두 곡선(선·호 조각, 연장해서 본다)에 접하는 반지름 r의 원. 해가 여럿이면 접점이 고른 점에 가장 가까운 것(AutoCAD와 같다).
 * 해가 없으면 null.
 */
export function circleTTR(p1: Piece, pick1: Vec2, p2: Piece, pick2: Vec2, r: number): { c: Vec2; r: number } | null {
  if (!(r > 0)) return null;
  const c1 = carrier(p1);
  const c2 = carrier(p2);
  if (!c1 || !c2) return null;
  let best: { c: Vec2; score: number } | null = null;
  for (const A of loci(c1, r))
    for (const B of loci(c2, r))
      for (const c of meet(A, B)) {
        const t1 = pieceNearest(p1, c, false).p;
        const t2 = pieceNearest(p2, c, false).p;
        const score = dist(t1, pick1) + dist(t2, pick2);
        if (!best || score < best.score - 1e-12) best = { c, score };
      }
  return best ? { c: best.c, r } : null;
}

// ---------------------------------------------------------------------------
// XLINE
// ---------------------------------------------------------------------------

/** 정점 v에서 시작점 a·끝점 b 사이 각도를 이등분하는 방향(라디안). 세 점이 겹치면 null */
export function bisectAngle(v: Vec2, a: Vec2, b: Vec2): number | null {
  if (dist(v, a) < 1e-12 || dist(v, b) < 1e-12) return null;
  const a0 = Math.atan2(a.y - v.y, a.x - v.x);
  const a1 = Math.atan2(b.y - v.y, b.x - v.x);
  return a0 + ccwSweep(a0, a1) / 2;
}

/** 선 조각(선·폴리선 직선 구간·구성선)을 거리 d만큼 side 쪽으로 옮긴 무한선의 기준점·방향 */
export function offsetLine(a: Vec2, b: Vec2, d: number, side: Vec2): { base: Vec2; dir: Vec2 } | null {
  const l = dist(a, b);
  if (!(l > 0)) return null;
  const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  const n = { x: -u.y, y: u.x };
  const s = (side.x - a.x) * n.x + (side.y - a.y) * n.y >= 0 ? 1 : -1;
  return { base: { x: a.x + n.x * d * s, y: a.y + n.y * d * s }, dir: u };
}

// ---------------------------------------------------------------------------
// PLINE 호 옵션: 볼록 값(시작점 → 끝점, 중심각 부호 = 방향)
// ---------------------------------------------------------------------------

export const bulgeOfSweep = (sw: number): number => Math.tan(sw / 4);

/** 중심과 끝점 방향으로 반시계(ccw = 거짓이면 시계) 호. 끝점은 반지름에 맞춘 점 */
export function arcByCenter(start: Vec2, c: Vec2, toward: Vec2, ccw = true): { end: Vec2; bulge: number } | null {
  const r = dist(start, c);
  if (!(r > 0)) return null;
  const a0 = Math.atan2(start.y - c.y, start.x - c.x);
  const a1 = Math.atan2(toward.y - c.y, toward.x - c.x);
  let sw = ccwSweep(a0, a1);
  if (!ccw) sw = sw - Math.PI * 2;
  if (Math.abs(sw) < 1e-12) return null;
  return { end: { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) }, bulge: bulgeOfSweep(sw) };
}

/** 중심과 중심각(부호 있는 라디안)으로 호 */
export function arcByCenterAngle(start: Vec2, c: Vec2, sw: number): { end: Vec2; bulge: number } | null {
  const r = dist(start, c);
  if (!(r > 0) || Math.abs(sw) < 1e-12) return null;
  const a1 = Math.atan2(start.y - c.y, start.x - c.x) + sw;
  return { end: { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) }, bulge: bulgeOfSweep(sw) };
}

/** 중심과 현의 길이(음수면 큰 호)로 호(반시계) */
export function arcByCenterChord(start: Vec2, c: Vec2, chord: number): { end: Vec2; bulge: number } | null {
  const r = dist(start, c);
  if (!(r > 0) || Math.abs(chord) > 2 * r + 1e-12 || chord === 0) return null;
  let sw = 2 * Math.asin(Math.min(1, Math.abs(chord) / (2 * r)));
  if (chord < 0) sw = Math.PI * 2 - sw;
  return arcByCenterAngle(start, c, sw);
}

/** 반지름·중심각·현 방향으로 호 */
export function arcByRadiusAngle(start: Vec2, r: number, sw: number, chordDir: number): { end: Vec2; bulge: number } | null {
  if (!(r > 0) || Math.abs(sw) < 1e-12) return null;
  const L = 2 * r * Math.sin(Math.abs(sw) / 2);
  return { end: { x: start.x + L * Math.cos(chordDir), y: start.y + L * Math.sin(chordDir) }, bulge: bulgeOfSweep(sw) };
}

/** 반지름과 끝점으로 호(작은 호, 반시계. 큰 호는 반지름을 음수로) */
export function arcByRadiusEnd(start: Vec2, r: number, end: Vec2): number | null {
  const L = dist(start, end);
  if (!(L > 0) || Math.abs(r) * 2 < L - 1e-12) return null;
  let sw = 2 * Math.asin(Math.min(1, L / (2 * Math.abs(r))));
  if (r < 0) sw = Math.PI * 2 - sw;
  return bulgeOfSweep(sw);
}

/** 시작 접선 방향(라디안)과 끝점으로 호의 볼록 */
export function arcByDirection(start: Vec2, dir: number, end: Vec2): number | null {
  if (!(dist(start, end) > 0)) return null;
  const chord = Math.atan2(end.y - start.y, end.x - start.x);
  const half = wrapPi(chord - dir);
  return Math.tan(half / 2);
}

// ---------------------------------------------------------------------------
// SPLINE
// ---------------------------------------------------------------------------

export type KnotParam = 'chord' | 'sqrt' | 'uniform';

/** 맞춤점 스플라인의 조정점·매듭(열린 곡선). 접선이 있으면 현 길이 매개변수(접선 조건이 있는 보간) */
export function fitSplineNurbs(fit: readonly Vec3[], knots: KnotParam = 'chord', startTangent?: Vec3, endTangent?: Vec3): { degree: number; knots: number[]; ctrl: Vec3[] } {
  if (knots !== 'chord' && !startTangent && !endTangent && fit.length >= 3) {
    const n = interpolate(fit, 3, knots);
    if (n) return { degree: n.degree, knots: n.knots, ctrl: n.ctrl };
  }
  return interpolateFitPoints(fit, startTangent, endTangent);
}

/** 맞춤점 스플라인 객체(닫기면 맞춤점을 지나는 주기 곡선 — SPLINEDIT 닫기와 같다) */
export function makeFitSpline(base: Omit<EntityBase, 'type' | 'handle'>, fit: readonly Vec3[], opt: { knots?: KnotParam; closed?: boolean; startTangent?: Vec3; endTangent?: Vec3; tolerance?: number } = {}): SplineEntity | null {
  if (fit.length < 2) return null;
  const s = fitSplineNurbs(fit, opt.knots, opt.closed ? undefined : opt.startTangent, opt.closed ? undefined : opt.endTangent);
  const e: SplineEntity = {
    ...base,
    type: 'SPLINE',
    handle: '',
    flags: 8,
    degree: s.degree,
    knots: s.knots,
    controlPoints: s.ctrl,
    fitPoints: fit.map((q) => ({ ...q })),
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: opt.tolerance && opt.tolerance > 0 ? opt.tolerance : 1e-10,
  };
  if (!opt.closed) {
    if (opt.startTangent) e.startTangent = { ...opt.startTangent };
    if (opt.endTangent) e.endTangent = { ...opt.endTangent };
    return e;
  }
  return closeSpline(e) ?? e;
}

/** 조정점(CV) 스플라인 객체(차수 degree, 고정 균일 매듭. 닫기면 주기 형태) */
export function makeCvSpline(base: Omit<EntityBase, 'type' | 'handle'>, ctrl: readonly Vec3[], degree: number, closed = false): SplineEntity | null {
  if (ctrl.length < 2) return null;
  const p = Math.max(1, Math.min(degree, ctrl.length - 1));
  const e: SplineEntity = {
    ...base,
    type: 'SPLINE',
    handle: '',
    flags: 8,
    degree: p,
    knots: clampedKnots(ctrl.length, p),
    controlPoints: ctrl.map((q) => ({ ...q })),
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
  };
  if (!closed) return e;
  return ctrl.length >= 3 ? (closeSpline(e) ?? e) : e;
}

/**
 * 스플라인 맞춤 폴리선(PEDIT 스플라인) → 같은 곡선의 SPLINE(SPLINE 객체(O)): 틀 정점 = 조정점,
 * 2차·3차 균일 B 스플라인(열린 틀은 끝을 고정, 닫힌 틀은 주기). 스플라인 맞춤이 아니면 null.
 */
export function splineFromFitPolyline(e: Entity): SplineEntity | null {
  if (e.type !== 'POLYLINE' || !isPolyline(e) || fitKind(e) !== 'spline') return null;
  const vs = frameVerts(e);
  if (vs.length < 2) return null;
  const d3 = e.kind === '3d';
  const ctrl = vs.map((v) => ({ x: v.x, y: v.y, z: d3 ? v.z : e.elevation }));
  const degree = e.smoothType === 5 ? 2 : 3;
  const s = makeCvSpline(inherit(e), ctrl, degree, isClosed(e));
  if (s && d3 && ctrl.some((q) => Math.abs(q.z - ctrl[0]!.z) > 1e-12)) s.flags &= ~8;
  return s;
}

// ---------------------------------------------------------------------------
// ELLIPSE 호
// ---------------------------------------------------------------------------

/** 장축에서 잰 각도(라디안) → 타원 매개변수 */
export function ellipseAngleToParam(angle: number, ratio: number): number {
  return Math.atan2(Math.sin(angle) / ratio, Math.cos(angle));
}

/** 타원 매개변수 → 장축에서 잰 각도 */
export function ellipseParamToAngle(param: number, ratio: number): number {
  return Math.atan2(Math.sin(param) * ratio, Math.cos(param));
}
