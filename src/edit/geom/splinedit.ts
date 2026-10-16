/**
 * SPLINEDIT 계산: 닫기·열기, 맞춤 데이터(추가·삭제·이동·공차·소거), 정점(추가·이동·가중치), 폴리선으로 변환, 반전.
 *
 * - 맞춤점 스플라인(fitPoints 2개 이상)은 맞춤점을 고칠 때마다 곡선(조정점·매듭)을 다시 만든다:
 *   열린 곡선은 현 길이 매개변수의 3차 보간(끝 접선 반영), 닫힌 곡선은 맞춤점을 지나는 주기 3차 곡선.
 * - 닫힌(주기) 조정점 스플라인: 조정점 n개 + 처음 차수 개 반복, 매듭 0 … n + 2·차수(고정되지 않음).
 * - 맞춤점 스플라인의 정점을 고치면 맞춤 데이터를 버리고 조정점 정의가 된다(AutoCAD와 같다).
 */
import type { SplineEntity, Vec2, Vec3 } from '../../core/model';
import { clampedKnots, interpolateFitPoints } from '../../geom/curves';
import { pieceNearest } from './curve';
import { dist } from './math';
import { domain, elevateBezier, insertKnot, joinBeziers, joinNurbs, normalizeNurbs, periodicInterpolate, toBezier } from './nurbs';
import { cloneEntity, splineNurbs } from './path';
import { reverseSpline } from './query';

export function isFitSpline(e: SplineEntity): boolean {
  return e.fitPoints.length >= 2;
}

export function isSplineClosed(e: SplineEntity): boolean {
  return (e.flags & 1) !== 0;
}

/** 주기(닫힌) 조정점 형태인지: 끝의 차수 개 조정점이 처음과 같다 */
export function isPeriodicForm(e: SplineEntity): boolean {
  const p = e.degree;
  const n = e.controlPoints.length;
  if (!(e.flags & 2) || n < 2 * p + 1) return false;
  for (let i = 0; i < p; i++) if (dist(e.controlPoints[i]!, e.controlPoints[n - p + i]!) > 1e-9 * Math.max(1, Math.abs(e.controlPoints[i]!.x), Math.abs(e.controlPoints[i]!.y))) return false;
  return true;
}

/** 맞춤점에서 곡선을 다시 만든다(닫힘·접선 반영) */
export function refit(e: SplineEntity): SplineEntity {
  const out = cloneEntity(e);
  const fit = e.fitPoints;
  if (fit.length < 2) return out;
  if (isSplineClosed(e) && fit.length >= 3) {
    const c = periodicInterpolate(fit);
    if (c) {
      out.degree = c.degree;
      out.knots = c.knots;
      out.controlPoints = c.ctrl;
      delete out.weights;
      out.flags = (out.flags & ~4) | 1 | 2;
      delete out.startTangent;
      delete out.endTangent;
      return out;
    }
  }
  const s = interpolateFitPoints(fit, e.startTangent, e.endTangent);
  out.degree = s.degree;
  out.knots = s.knots;
  out.controlPoints = s.ctrl;
  delete out.weights;
  out.flags = out.flags & ~(1 | 2 | 4);
  return out;
}

/** 조정점 정의로 바꾼다(맞춤 데이터 소거) */
export function purgeFit(e: SplineEntity): SplineEntity {
  const out = cloneEntity(e);
  if (out.controlPoints.length < 2 && e.fitPoints.length >= 2) {
    const n = splineNurbs(e);
    if (n) {
      out.degree = n.degree;
      out.knots = n.knots;
      out.controlPoints = n.ctrl;
      if (n.weights) out.weights = n.weights;
    }
  }
  out.fitPoints = [];
  delete out.startTangent;
  delete out.endTangent;
  return out;
}

// ---------------------------------------------------------------------------
// 닫기·열기
// ---------------------------------------------------------------------------

export function closeSpline(e: SplineEntity): SplineEntity | null {
  if (isSplineClosed(e)) return null;
  if (isFitSpline(e)) {
    if (e.fitPoints.length < 3) return null;
    const x = cloneEntity(e);
    // 마지막 맞춤점이 첫 점과 같으면(예전 방식) 뺀다
    if (dist(x.fitPoints[0]!, x.fitPoints[x.fitPoints.length - 1]!) <= 1e-9) x.fitPoints.pop();
    if (x.fitPoints.length < 3) return null;
    x.flags |= 1;
    delete x.startTangent;
    delete x.endTangent;
    return refit(x);
  }
  const n0 = splineNurbs(e);
  if (!n0 || n0.ctrl.length < 3) return null;
  const P = n0.ctrl.map((q) => ({ ...q }));
  // 끝 조정점이 첫 조정점과 같으면(끝이 닿은 곡선) 하나 뺀다
  if (P.length > 3 && dist(P[0]!, P[P.length - 1]!) <= 1e-9 * Math.max(1, Math.abs(P[0]!.x), Math.abs(P[0]!.y))) P.pop();
  const p = Math.min(n0.degree, P.length - 1);
  const out = cloneEntity(e);
  out.degree = p;
  out.controlPoints = [...P, ...P.slice(0, p).map((q) => ({ ...q }))];
  out.knots = [];
  for (let i = 0; i < out.controlPoints.length + p + 1; i++) out.knots.push(i);
  if (n0.weights) out.weights = [...n0.weights.slice(0, P.length), ...n0.weights.slice(0, p)];
  else delete out.weights;
  out.flags |= 1 | 2;
  out.fitPoints = [];
  return out;
}

export function openSpline(e: SplineEntity): SplineEntity | null {
  if (!isSplineClosed(e)) return null;
  if (isFitSpline(e)) {
    const x = cloneEntity(e);
    x.flags &= ~(1 | 2);
    return refit(x);
  }
  const out = cloneEntity(e);
  const p = e.degree;
  if (isPeriodicForm(e)) {
    const n = e.controlPoints.length - p;
    out.controlPoints = e.controlPoints.slice(0, n).map((q) => ({ ...q }));
    if (e.weights) out.weights = e.weights.slice(0, n);
    out.degree = Math.min(p, n - 1);
    out.knots = clampedKnots(n, out.degree);
  }
  out.flags &= ~(1 | 2);
  return out;
}

// ---------------------------------------------------------------------------
// 맞춤 데이터
// ---------------------------------------------------------------------------

function withFit(e: SplineEntity, fit: Vec3[]): SplineEntity {
  const x = cloneEntity(e);
  x.fitPoints = fit;
  return refit(x);
}

/** i 다음(before면 앞)에 맞춤점 추가 */
export function fitAdd(e: SplineEntity, i: number, p: Vec2, before = false): SplineEntity | null {
  if (!isFitSpline(e) || i < 0 || i >= e.fitPoints.length) return null;
  const fit = e.fitPoints.map((q) => ({ ...q }));
  fit.splice(before ? i : i + 1, 0, { x: p.x, y: p.y, z: fit[i]!.z });
  return withFit(e, fit);
}

export function fitDelete(e: SplineEntity, i: number): SplineEntity | null {
  const min = isSplineClosed(e) ? 3 : 2;
  if (!isFitSpline(e) || e.fitPoints.length <= min || i < 0 || i >= e.fitPoints.length) return null;
  const fit = e.fitPoints.map((q) => ({ ...q }));
  fit.splice(i, 1);
  return withFit(e, fit);
}

export function fitMove(e: SplineEntity, i: number, p: Vec2): SplineEntity | null {
  if (!isFitSpline(e) || i < 0 || i >= e.fitPoints.length) return null;
  const fit = e.fitPoints.map((q) => ({ ...q }));
  fit[i] = { x: p.x, y: p.y, z: fit[i]!.z };
  return withFit(e, fit);
}

/** 맞춤 공차(값만 바꾼다 — 곡선은 맞춤점을 지난다) */
export function fitTolerance(e: SplineEntity, tol: number): SplineEntity | null {
  if (!isFitSpline(e) || !(tol >= 0)) return null;
  const x = cloneEntity(e);
  x.fitTolerance = tol;
  return x;
}

/** 시작·끝 접선(단위 방향). null이면 지운다(시스템 기본값) */
export function fitTangents(e: SplineEntity, start: Vec2 | null | undefined, end: Vec2 | null | undefined): SplineEntity | null {
  if (!isFitSpline(e) || isSplineClosed(e)) return null;
  const x = cloneEntity(e);
  const unit = (v: Vec2): Vec3 => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l, z: 0 };
  };
  if (start !== undefined) {
    if (start) x.startTangent = unit(start);
    else delete x.startTangent;
  }
  if (end !== undefined) {
    if (end) x.endTangent = unit(end);
    else delete x.endTangent;
  }
  return refit(x);
}

// ---------------------------------------------------------------------------
// 정점(조정점)
// ---------------------------------------------------------------------------

/** 편집할 조정점 수(주기 형태의 반복은 세지 않는다) */
export function cvCount(e: SplineEntity): number {
  const n = e.controlPoints.length;
  return isPeriodicForm(e) ? n - e.degree : n;
}

function cvBase(e: SplineEntity): SplineEntity {
  return isFitSpline(e) || e.controlPoints.length < 2 ? purgeFit(e) : cloneEntity(e);
}

export function cvMove(e: SplineEntity, i: number, p: Vec2): SplineEntity | null {
  const x = cvBase(e);
  const n = x.controlPoints.length;
  if (i < 0 || i >= cvCount(x)) return null;
  const z = x.controlPoints[i]!.z;
  x.controlPoints[i] = { x: p.x, y: p.y, z };
  if (isPeriodicForm(e) && i < x.degree) x.controlPoints[n - x.degree + i] = { x: p.x, y: p.y, z };
  return x;
}

export function cvWeight(e: SplineEntity, i: number, w: number): SplineEntity | null {
  if (!(w > 0)) return null;
  const x = cvBase(e);
  const n = x.controlPoints.length;
  if (i < 0 || i >= cvCount(x)) return null;
  const ws = x.weights && x.weights.length === n ? [...x.weights] : new Array<number>(n).fill(1);
  ws[i] = w;
  if (isPeriodicForm(e) && i < x.degree) ws[n - x.degree + i] = w;
  x.weights = ws;
  if (ws.some((v) => Math.abs(v - 1) > 1e-12)) x.flags |= 4;
  else {
    x.flags &= ~4;
    delete x.weights;
  }
  return x;
}

/** 곡선 위 q에 가장 가까운 매개변수에 매듭을 넣어 조정점을 하나 더한다(모양 유지, 주기 형태는 제외) */
export function cvAdd(e: SplineEntity, q: Vec2): SplineEntity | null {
  if (isPeriodicForm(e)) return null;
  const x = cvBase(e);
  const n = splineNurbs(x);
  if (!n) return null;
  const [a, b] = domain(n);
  const r = pieceNearest({ k: 'nurbs', n, u0: a, u1: b }, q, true);
  const u = a + (b - a) * r.t;
  if (!(u > a) || !(u < b)) return null;
  const m = normalizeNurbs(insertKnot(n, u, 1));
  if (m.ctrl.length === n.ctrl.length) return null;
  x.degree = m.degree;
  x.knots = m.knots;
  x.controlPoints = m.ctrl;
  if (m.weights) x.weights = m.weights;
  else delete x.weights;
  return x;
}

/**
 * 정점 편집 삭제(D): 조정점 i를 지운다(모양이 바뀐다 — AutoCAD와 같다). 열린 곡선은 고정 균일 매듭으로 다시,
 * 주기 형태는 남은 조정점으로 다시 닫는다. 조정점이 너무 적어지면 null.
 */
export function cvDelete(e: SplineEntity, i: number): SplineEntity | null {
  const x = cvBase(e);
  const p = x.degree;
  const periodic = isPeriodicForm(x);
  const base = periodic ? x.controlPoints.slice(0, x.controlPoints.length - p) : x.controlPoints.slice();
  const w = x.weights && x.weights.length === x.controlPoints.length ? (periodic ? x.weights.slice(0, base.length) : x.weights.slice()) : null;
  if (i < 0 || i >= base.length) return null;
  if (base.length - 1 < (periodic ? 3 : 2)) return null;
  base.splice(i, 1);
  w?.splice(i, 1);
  const out = cloneEntity(x);
  if (periodic) {
    const q = Math.min(p, base.length - 1);
    out.degree = q;
    out.controlPoints = [...base, ...base.slice(0, q)].map((v) => ({ ...v }));
    out.knots = [];
    for (let k = 0; k < out.controlPoints.length + q + 1; k++) out.knots.push(k);
    if (w) out.weights = [...w, ...w.slice(0, q)];
    else delete out.weights;
    return out;
  }
  const q = Math.min(p, base.length - 1);
  out.degree = q;
  out.controlPoints = base.map((v) => ({ ...v }));
  out.knots = clampedKnots(base.length, q);
  if (w) out.weights = w;
  else delete out.weights;
  return out;
}

/** 정점 편집 순서 올리기(E): 순서(차수 + 1)를 order로(모양 그대로, 조정점이 늘어난다). 지금보다 낮거나 26을 넘으면 null */
export function elevateOrder(e: SplineEntity, order: number): SplineEntity | null {
  const x = cvBase(e);
  const n = splineNurbs(x);
  if (!n) return null;
  const target = Math.round(order) - 1;
  if (target <= n.degree || target > 25) return null;
  const segs = toBezier(n).map((sg) => elevateBezier(sg, target - (sg.length - 1)));
  const m = joinBeziers(segs);
  if (!m) return null;
  const out = cloneEntity(x);
  out.degree = m.degree;
  out.knots = m.knots;
  out.controlPoints = m.ctrl;
  if (m.weights) {
    out.weights = m.weights;
    out.flags |= 4;
  } else {
    delete out.weights;
    out.flags &= ~4;
  }
  // 고정 매듭 곡선이 되므로 주기 표시는 뗀다(닫힘은 그대로)
  out.flags &= ~2;
  return out;
}

/**
 * 맞춤 데이터 꼬임(K): 곡선 위 q에 맞춤점을 넣고 그 점에서 접선이 끊기게(뾰족하게) 한다.
 * 맞춤 데이터는 꼬임을 담을 수 없어 결과는 조정점 정의(두 보간 곡선을 이은 것). 닫힌 곡선·맞춤점 스플라인이 아니면 null.
 */
export function fitKink(e: SplineEntity, q: Vec2): SplineEntity | null {
  if (!isFitSpline(e) || isSplineClosed(e)) return null;
  const n = splineNurbs(e);
  if (!n) return null;
  const [a, b] = domain(n);
  const piece = { k: 'nurbs' as const, n, u0: a, u1: b };
  const at = (p: Vec2) => pieceNearest(piece, p, true).t;
  const t = at(q);
  if (!(t > 1e-9) || !(t < 1 - 1e-9)) return null;
  const Q = pieceNearest(piece, q, true).p;
  const fit = e.fitPoints;
  const ts = fit.map((f) => at(f));
  let i = ts.findIndex((v) => v > t);
  if (i < 0) i = fit.length;
  const z = fit[Math.max(0, i - 1)]!.z;
  const mid = { x: Q.x, y: Q.y, z };
  const left = [...fit.slice(0, i), mid];
  const right = [mid, ...fit.slice(i)];
  if (left.length < 2 || right.length < 2) return null;
  const L = interpolateFitPoints(left, e.startTangent, undefined);
  const R = interpolateFitPoints(right, undefined, e.endTangent);
  const j = joinNurbs([
    { degree: L.degree, knots: L.knots, ctrl: L.ctrl },
    { degree: R.degree, knots: R.knots, ctrl: R.ctrl },
  ]);
  if (!j) return null;
  const out = cloneEntity(e);
  out.degree = j.degree;
  out.knots = j.knots;
  out.controlPoints = j.ctrl;
  delete out.weights;
  out.flags &= ~(1 | 2 | 4);
  out.fitPoints = [];
  delete out.startTangent;
  delete out.endTangent;
  return out;
}

export function reverseSplineEntity(e: SplineEntity): SplineEntity {
  return reverseSpline(e);
}
