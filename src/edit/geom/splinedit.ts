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
import { domain, insertKnot, normalizeNurbs, periodicInterpolate } from './nurbs';
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

export function reverseSplineEntity(e: SplineEntity): SplineEntity {
  return reverseSpline(e);
}
