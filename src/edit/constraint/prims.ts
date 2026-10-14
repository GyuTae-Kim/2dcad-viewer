/**
 * 객체 ↔ 풀이 변수. 객체의 정의 값(끝점·중심·반지름·각도·정점·벌지·조정점)을 변수 배열에 두고,
 * 부분(점·곡선)을 변수에서 계산하며, 푼 값을 객체로 되돌린다. 좌표는 모두 WCS 평면도(x, y)다.
 *
 * 지원: LINE, CIRCLE, ARC, ELLIPSE(자연 법선), LWPOLYLINE·2D POLYLINE(곡선 맞춤 없는 것),
 * SPLINE(끝이 고정된 비주기), POINT·TEXT·MTEXT·INSERT(삽입점). OCS가 ±Z인 객체는 되쓸 때 자연 OCS로 바꾼다.
 */
import type { ArcEntity, CadDocument, CircleEntity, EllipseEntity, Entity, LineEntity, LwPolylineEntity, PolylineEntity, SplineEntity, Vec2 } from '../../core/model';
import { affApply, affDet, affLin, affTranslate } from '../geom/math';
import { isNaturalExt, isPlanarExt, planProj, planZ } from '../geom/ocs';
import { insertionPoint } from '../geom/query';
import { transformEntity } from '../geom/transform';
import { partIndex } from './types';

const TAU = Math.PI * 2;

/** 변수 배열 */
export interface Vars {
  x: number[];
  /** 각도·비율처럼 길이가 아닌 변수 */
  ang: boolean[];
  /** 위치 좌표 변수(1 = x, 2 = y, 0 = 위치 아님 — 반지름·방향 벡터 등). 풀 때 원점을 옮겨 정밀도를 지킨다 */
  pos: number[];
}

export function newVars(): Vars {
  return { x: [], ang: [], pos: [] };
}

export type Prim =
  | { k: 'point'; h: string; e: Entity; p: number }
  | { k: 'line'; h: string; e: LineEntity; a: number; b: number }
  | { k: 'circle'; h: string; e: CircleEntity; c: number; r: number }
  | { k: 'arc'; h: string; e: ArcEntity; c: number; r: number; a0: number; a1: number }
  | { k: 'ellipse'; h: string; e: EllipseEntity; c: number; u: number; q: number; t0: number; t1: number; closed: boolean }
  | { k: 'poly'; h: string; e: LwPolylineEntity | PolylineEntity; v: number[]; b: number[]; closed: boolean; idx: number[] }
  | { k: 'spline'; h: string; e: SplineEntity; cp: number[] };

/** 부분을 곡선으로 본 것 */
export type Curve =
  | { k: 'line'; a: Vec2; b: Vec2 }
  | { k: 'circle'; c: Vec2; r: number; arc?: { a0: number; a1: number } }
  | { k: 'ellipse'; c: Vec2; u: Vec2; ratio: number }
  | { k: 'spline' };

type X = ArrayLike<number>;

const P = (x: X, i: number): Vec2 => ({ x: x[i]!, y: x[i + 1]! });

function addVar(vs: Vars, v: number, ang = false, pos = 0): number {
  vs.x.push(v);
  vs.ang.push(ang);
  vs.pos.push(pos);
  return vs.x.length - 1;
}

/** 점(위치) 변수 둘. position이 거짓이면 방향 벡터 */
function addPt(vs: Vars, p: Vec2, position = true): number {
  const i = addVar(vs, p.x, false, position ? 1 : 0);
  addVar(vs, p.y, false, position ? 2 : 0);
  return i;
}

/** 2D 폴리선의 쓸 수 있는 정점 번호(곡선·스플라인 맞춤 정점 빼고). 맞춤 폴리선이면 null */
function polyIndices(e: PolylineEntity): number[] | null {
  if (e.kind !== '2d' || e.flags & 6) return null;
  const out: number[] = [];
  for (let i = 0; i < e.vertices.length; i++) {
    const f = e.vertices[i]!.flags;
    if (f & (1 | 8 | 16)) return null;
    out.push(i);
  }
  return out;
}

/** 끝이 고정된(clamped) 비주기 스플라인인지 */
function clampedSpline(e: SplineEntity): boolean {
  const n = e.controlPoints.length;
  const p = e.degree;
  if (n < 2 || p < 1 || e.flags & 2 || e.knots.length !== n + p + 1) return false;
  const k = e.knots;
  for (let i = 1; i <= p; i++) if (Math.abs(k[i]! - k[0]!) > 1e-9 || Math.abs(k[k.length - 1 - i]! - k[k.length - 1]!) > 1e-9) return false;
  return true;
}

/** 구속을 걸 수 있는 객체인지(아니면 까닭) */
export function unsupportedReason(e: Entity): string | null {
  switch (e.type) {
    case 'LINE':
    case 'POINT':
    case 'TEXT':
    case 'MTEXT':
    case 'INSERT':
      return null;
    case 'CIRCLE':
    case 'ARC':
    case 'LWPOLYLINE':
      return isPlanarExt(e.extrusion) ? null : '평면도(XY)에 있지 않은 객체에는 구속조건을 적용할 수 없습니다.';
    case 'ELLIPSE':
      return isNaturalExt(e.extrusion) ? null : '평면도(XY)에 있지 않은 객체에는 구속조건을 적용할 수 없습니다.';
    case 'POLYLINE':
      if (!isPlanarExt(e.extrusion)) return '평면도(XY)에 있지 않은 객체에는 구속조건을 적용할 수 없습니다.';
      return polyIndices(e) ? null : '곡선·스플라인 맞춤 폴리선과 3D 폴리선에는 구속조건을 적용할 수 없습니다.';
    case 'SPLINE':
      return clampedSpline(e) ? null : '닫힌 스플라인이나 주기 스플라인에는 구속조건을 적용할 수 없습니다.';
    default:
      return '이 객체에는 구속조건을 적용할 수 없습니다.';
  }
}

/** 객체를 변수로 올린다(지원하지 않으면 null) */
export function makePrim(e: Entity, vs: Vars): Prim | null {
  if (unsupportedReason(e)) return null;
  const h = e.handle;
  switch (e.type) {
    case 'LINE':
      return { k: 'line', h, e, a: addPt(vs, e.start), b: addPt(vs, e.end) };
    case 'CIRCLE': {
      const c = affApply(planProj(e.extrusion, e.center.z), e.center);
      return { k: 'circle', h, e, c: addPt(vs, c), r: addVar(vs, e.radius) };
    }
    case 'ARC': {
      const m = planProj(e.extrusion, e.center.z);
      const c = affApply(m, e.center);
      const dir = (a: number) => {
        const d = affLin(m, { x: Math.cos(a), y: Math.sin(a) });
        return Math.atan2(d.y, d.x);
      };
      let a0 = dir(e.startAngle);
      let a1 = dir(e.endAngle);
      if (affDet(m) < 0) [a0, a1] = [a1, a0];
      let sw = a1 - a0;
      while (sw <= 1e-12) sw += TAU;
      while (sw > TAU + 1e-12) sw -= TAU;
      return { k: 'arc', h, e, c: addPt(vs, c), r: addVar(vs, e.radius), a0: addVar(vs, a0, true), a1: addVar(vs, a0 + sw, true) };
    }
    case 'ELLIPSE': {
      let sw = e.endParam - e.startParam;
      while (sw <= 1e-12) sw += TAU;
      const closed = Math.abs(sw - TAU) < 1e-9;
      return {
        k: 'ellipse',
        h,
        e,
        c: addPt(vs, e.center),
        u: addPt(vs, e.majorAxis, false),
        q: addVar(vs, e.ratio, true),
        t0: addVar(vs, e.startParam, true),
        t1: addVar(vs, e.startParam + sw, true),
        closed,
      };
    }
    case 'LWPOLYLINE': {
      const m = planProj(e.extrusion, e.elevation);
      const flip = affDet(m) < 0 ? -1 : 1;
      const v = e.vertices.map((p) => addPt(vs, affApply(m, p)));
      const n = e.vertices.length;
      const segs = e.closed ? n : n - 1;
      const b: number[] = [];
      for (let i = 0; i < segs; i++) {
        const bu = (e.vertices[i]!.bulge || 0) * flip;
        b.push(Math.abs(bu) > 1e-12 ? addVar(vs, bu, true) : -1);
      }
      return { k: 'poly', h, e, v, b, closed: e.closed, idx: e.vertices.map((_, i) => i) };
    }
    case 'POLYLINE': {
      const idx = polyIndices(e)!;
      const m = planProj(e.extrusion, e.elevation);
      const flip = affDet(m) < 0 ? -1 : 1;
      const closed = (e.flags & 1) !== 0;
      const v = idx.map((i) => addPt(vs, affApply(m, e.vertices[i]!.location)));
      const segs = closed ? idx.length : idx.length - 1;
      const b: number[] = [];
      for (let i = 0; i < segs; i++) {
        const bu = (e.vertices[idx[i]!]!.bulge || 0) * flip;
        b.push(Math.abs(bu) > 1e-12 ? addVar(vs, bu, true) : -1);
      }
      return { k: 'poly', h, e, v, b, closed, idx };
    }
    case 'SPLINE':
      return { k: 'spline', h, e, cp: e.controlPoints.map((p) => addPt(vs, p)) };
    default: {
      const p = insertionPoint(e);
      if (!p) return null;
      return { k: 'point', h, e, p: addPt(vs, p) };
    }
  }
}

// ---------------------------------------------------------------------------
// 폴리선 세그먼트
// ---------------------------------------------------------------------------

function segCount(pr: Extract<Prim, { k: 'poly' }>): number {
  return pr.closed ? pr.v.length : pr.v.length - 1;
}

/** 호 세그먼트: 벌지에서 중심·반지름·시작각·사잇각 */
export function bulgeCircle(p0: Vec2, p1: Vec2, bulge: number): { c: Vec2; r: number; a0: number; sweep: number } | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-14 || Math.abs(bulge) < 1e-14) return null;
  const th = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(th) / 2));
  const hh = r * Math.cos(Math.abs(th) / 2);
  const s = bulge > 0 ? 1 : -1;
  const c = { x: (p0.x + p1.x) / 2 - (dy / chord) * hh * s, y: (p0.y + p1.y) / 2 + (dx / chord) * hh * s };
  return { c, r, a0: Math.atan2(p0.y - c.y, p0.x - c.x), sweep: th };
}

function polySeg(pr: Extract<Prim, { k: 'poly' }>, i: number, x: X): { a: Vec2; b: Vec2; bulge: number } | null {
  const n = pr.v.length;
  if (i < 0 || i >= segCount(pr)) return null;
  const bi = pr.b[i]!;
  return { a: P(x, pr.v[i]!), b: P(x, pr.v[(i + 1) % n]!), bulge: bi >= 0 ? x[bi]! : 0 };
}

// ---------------------------------------------------------------------------
// 부분 계산
// ---------------------------------------------------------------------------

/** 점 부분인지 */
export function isPointPart(pr: Prim, part: string): boolean {
  switch (pr.k) {
    case 'point':
      return part === 'I';
    case 'line':
      return part === 'S' || part === 'E' || part === 'M';
    case 'circle':
      return part === 'C';
    case 'arc':
      return part === 'C' || part === 'S' || part === 'E' || part === 'M';
    case 'ellipse':
      return part === 'C' || (!pr.closed && (part === 'S' || part === 'E'));
    case 'spline':
      return part === 'S' || part === 'E';
    case 'poly': {
      const i = partIndex(part);
      if (part[0] === 'V') return i >= 0 && i < pr.v.length;
      if (part[0] === 'M') return i >= 0 && i < segCount(pr);
      if (part[0] === 'C') return i >= 0 && i < segCount(pr) && pr.b[i]! >= 0;
      return false;
    }
  }
}

/** 점 부분의 좌표 */
export function pointOf(pr: Prim, part: string, x: X): Vec2 | null {
  switch (pr.k) {
    case 'point':
      return part === 'I' ? P(x, pr.p) : null;
    case 'line': {
      const a = P(x, pr.a);
      const b = P(x, pr.b);
      return part === 'S' ? a : part === 'E' ? b : part === 'M' ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
    }
    case 'circle':
      return part === 'C' ? P(x, pr.c) : null;
    case 'arc': {
      const c = P(x, pr.c);
      if (part === 'C') return c;
      const r = x[pr.r]!;
      const a = part === 'S' ? x[pr.a0]! : part === 'E' ? x[pr.a1]! : part === 'M' ? (x[pr.a0]! + x[pr.a1]!) / 2 : NaN;
      if (Number.isNaN(a)) return null;
      return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
    }
    case 'ellipse': {
      const c = P(x, pr.c);
      if (part === 'C') return c;
      if (pr.closed || (part !== 'S' && part !== 'E')) return null;
      const u = P(x, pr.u);
      const q = x[pr.q]!;
      const t = part === 'S' ? x[pr.t0]! : x[pr.t1]!;
      return { x: c.x + u.x * Math.cos(t) - q * u.y * Math.sin(t), y: c.y + u.y * Math.cos(t) + q * u.x * Math.sin(t) };
    }
    case 'spline':
      return part === 'S' ? P(x, pr.cp[0]!) : part === 'E' ? P(x, pr.cp[pr.cp.length - 1]!) : null;
    case 'poly': {
      const i = partIndex(part);
      if (part[0] === 'V') return i >= 0 && i < pr.v.length ? P(x, pr.v[i]!) : null;
      const s = polySeg(pr, i, x);
      if (!s) return null;
      if (part[0] === 'M') {
        const arc = bulgeCircle(s.a, s.b, s.bulge);
        if (!arc) return { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
        const a = arc.a0 + arc.sweep / 2;
        return { x: arc.c.x + arc.r * Math.cos(a), y: arc.c.y + arc.r * Math.sin(a) };
      }
      if (part[0] === 'C') return bulgeCircle(s.a, s.b, s.bulge)?.c ?? null;
      return null;
    }
  }
}

/** 곡선 부분인지(선·원·호·타원·스플라인 전체 또는 폴리선 세그먼트) */
export function isCurvePart(pr: Prim, part: string): boolean {
  if (pr.k === 'point') return false;
  if (pr.k === 'poly') return part[0] === 'G' && partIndex(part) >= 0 && partIndex(part) < segCount(pr);
  return part === '';
}

/** 곡선 부분 */
export function curveOf(pr: Prim, part: string, x: X): Curve | null {
  switch (pr.k) {
    case 'line':
      return part === '' ? { k: 'line', a: P(x, pr.a), b: P(x, pr.b) } : null;
    case 'circle':
      return part === '' ? { k: 'circle', c: P(x, pr.c), r: x[pr.r]! } : null;
    case 'arc':
      return part === '' ? { k: 'circle', c: P(x, pr.c), r: x[pr.r]!, arc: { a0: x[pr.a0]!, a1: x[pr.a1]! } } : null;
    case 'ellipse':
      return part === '' ? { k: 'ellipse', c: P(x, pr.c), u: P(x, pr.u), ratio: x[pr.q]! } : null;
    case 'spline':
      return part === '' ? { k: 'spline' } : null;
    case 'poly': {
      if (part[0] !== 'G') return null;
      const s = polySeg(pr, partIndex(part), x);
      if (!s) return null;
      const arc = bulgeCircle(s.a, s.b, s.bulge);
      if (!arc) return { k: 'line', a: s.a, b: s.b };
      const a0 = arc.sweep > 0 ? arc.a0 : arc.a0 + arc.sweep;
      return { k: 'circle', c: arc.c, r: arc.r, arc: { a0, a1: a0 + Math.abs(arc.sweep) } };
    }
    case 'point':
      return null;
  }
}

/** 곡선 부분의 종류(변수 값과 상관없이): 'line' | 'circle' | 'ellipse' | 'spline' */
export function curveKind(pr: Prim, part: string, x: X): Curve['k'] | null {
  return curveOf(pr, part, x)?.k ?? null;
}

/** 부분이 기대는 변수 번호 */
export function partVars(pr: Prim, part: string): number[] {
  const pt = (i: number) => [i, i + 1];
  switch (pr.k) {
    case 'point':
      return pt(pr.p);
    case 'line':
      return part === 'S' ? pt(pr.a) : part === 'E' ? pt(pr.b) : [...pt(pr.a), ...pt(pr.b)];
    case 'circle':
      return part === 'C' ? pt(pr.c) : [...pt(pr.c), pr.r];
    case 'arc':
      if (part === 'C') return pt(pr.c);
      if (part === 'S') return [...pt(pr.c), pr.r, pr.a0];
      if (part === 'E') return [...pt(pr.c), pr.r, pr.a1];
      return [...pt(pr.c), pr.r, pr.a0, pr.a1];
    case 'ellipse':
      if (part === 'C') return pt(pr.c);
      if (part === 'S') return [...pt(pr.c), ...pt(pr.u), pr.q, pr.t0];
      if (part === 'E') return [...pt(pr.c), ...pt(pr.u), pr.q, pr.t1];
      return [...pt(pr.c), ...pt(pr.u), pr.q, ...(pr.closed ? [] : [pr.t0, pr.t1])];
    case 'spline': {
      const n = pr.cp.length;
      if (part === 'S') return [...pt(pr.cp[0]!), ...(n > 1 ? pt(pr.cp[1]!) : []), ...(n > 2 ? pt(pr.cp[2]!) : [])];
      if (part === 'E') return [...pt(pr.cp[n - 1]!), ...(n > 1 ? pt(pr.cp[n - 2]!) : []), ...(n > 2 ? pt(pr.cp[n - 3]!) : [])];
      return pr.cp.flatMap(pt);
    }
    case 'poly': {
      const i = partIndex(part);
      if (part[0] === 'V') return i >= 0 && i < pr.v.length ? pt(pr.v[i]!) : [];
      if (i < 0 || i >= segCount(pr)) return [];
      const out = [...pt(pr.v[i]!), ...pt(pr.v[(i + 1) % pr.v.length]!)];
      if (pr.b[i]! >= 0) out.push(pr.b[i]!);
      return out;
    }
  }
}

/** 객체 전체의 변수 번호 */
export function primVars(pr: Prim): number[] {
  const pt = (i: number) => [i, i + 1];
  switch (pr.k) {
    case 'point':
      return pt(pr.p);
    case 'line':
      return [...pt(pr.a), ...pt(pr.b)];
    case 'circle':
      return [...pt(pr.c), pr.r];
    case 'arc':
      return [...pt(pr.c), pr.r, pr.a0, pr.a1];
    case 'ellipse':
      return [...pt(pr.c), ...pt(pr.u), pr.q, ...(pr.closed ? [] : [pr.t0, pr.t1])];
    case 'spline':
      return pr.cp.flatMap(pt);
    case 'poly':
      return [...pr.v.flatMap(pt), ...pr.b.filter((b) => b >= 0)];
  }
}

/**
 * 고정할 때 묶는 변수. 점 부분은 그 점이 변수 둘이면 그 둘(호 끝·선 중간처럼 계산되는 점이면 빈 배열 —
 * 호출한 쪽이 점의 자리를 고정하는 식을 따로 세운다). 곡선이면 객체 전체(폴리선 세그먼트는 그 세그먼트).
 */
export function fixVars(pr: Prim, part: string): number[] {
  const pt = (i: number) => [i, i + 1];
  if (isPointPart(pr, part)) {
    switch (pr.k) {
      case 'point':
        return pt(pr.p);
      case 'line':
        return part === 'S' ? pt(pr.a) : part === 'E' ? pt(pr.b) : [];
      case 'circle':
      case 'arc':
      case 'ellipse':
        return part === 'C' ? pt(pr.c) : [];
      case 'spline':
        return part === 'S' ? pt(pr.cp[0]!) : pt(pr.cp[pr.cp.length - 1]!);
      case 'poly':
        return part[0] === 'V' ? pt(pr.v[partIndex(part)]!) : [];
    }
  }
  if (pr.k === 'poly' && part) return partVars(pr, part);
  return primVars(pr);
}

/** 객체의 크기(척도 계산용) */
export function primSize(pr: Prim, x: X): number {
  switch (pr.k) {
    case 'line':
      return Math.hypot(x[pr.b]! - x[pr.a]!, x[pr.b + 1]! - x[pr.a + 1]!);
    case 'circle':
    case 'arc':
      return 2 * Math.abs(x[pr.r]!);
    case 'ellipse':
      return 2 * Math.hypot(x[pr.u]!, x[pr.u + 1]!);
    case 'poly':
    case 'spline': {
      const pts = pr.k === 'poly' ? pr.v : pr.cp;
      let s = 0;
      for (let i = 1; i < pts.length; i++) s += Math.hypot(x[pts[i]!]! - x[pts[i - 1]!]!, x[pts[i]! + 1]! - x[pts[i - 1]! + 1]!);
      return s / Math.max(1, pts.length - 1);
    }
    case 'point':
      return 0;
  }
}

/** 객체가 망가졌는지(길이 0 선, 반지름 0 이하 등) */
export function primDegenerate(pr: Prim, x: X, tiny: number): boolean {
  switch (pr.k) {
    case 'line':
      return primSize(pr, x) <= tiny;
    case 'circle':
      return !(x[pr.r]! > tiny);
    case 'arc':
      return !(x[pr.r]! > tiny) || !(x[pr.a1]! - x[pr.a0]! > 1e-9) || x[pr.a1]! - x[pr.a0]! > TAU + 1e-9;
    case 'ellipse':
      return !(Math.hypot(x[pr.u]!, x[pr.u + 1]!) > tiny) || !(x[pr.q]! > 1e-9) || x[pr.q]! > 1 + 1e-6;
    case 'poly':
      for (let i = 0; i < segCount(pr); i++) {
        const s = polySeg(pr, i, x)!;
        if (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) <= tiny && s.bulge !== 0) return true;
      }
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 되쓰기
// ---------------------------------------------------------------------------

const changed = (x: X, x0: X, idx: number[], tol: number) => idx.some((i) => Math.abs(x[i]! - x0[i]!) > tol);

/** 푼 값이 원래 값과 다른지 */
export function primChanged(pr: Prim, x: X, x0: X, tol: number): boolean {
  return changed(x, x0, primVars(pr), tol);
}

const normA = (a: number) => ((a % TAU) + TAU) % TAU;

/** 푼 값으로 바꾼 객체(핸들 그대로) */
export function writePrim(pr: Prim, x: X, doc: CadDocument): Entity {
  switch (pr.k) {
    case 'line': {
      const e = pr.e;
      return { ...e, start: { ...e.start, x: x[pr.a]!, y: x[pr.a + 1]! }, end: { ...e.end, x: x[pr.b]!, y: x[pr.b + 1]! } };
    }
    case 'circle': {
      const e = pr.e;
      const z = planZ(e.extrusion, e.center.z);
      const out: CircleEntity = { ...e, center: { x: x[pr.c]!, y: x[pr.c + 1]!, z }, radius: Math.abs(x[pr.r]!) };
      delete out.extrusion;
      return out;
    }
    case 'arc': {
      const e = pr.e;
      const z = planZ(e.extrusion, e.center.z);
      const a0 = x[pr.a0]!;
      const sw = x[pr.a1]! - a0;
      const out: ArcEntity = { ...e, center: { x: x[pr.c]!, y: x[pr.c + 1]!, z }, radius: Math.abs(x[pr.r]!), startAngle: normA(a0), endAngle: normA(a0 + sw) };
      delete out.extrusion;
      return out;
    }
    case 'ellipse': {
      const e = pr.e;
      const out: EllipseEntity = { ...e, center: { ...e.center, x: x[pr.c]!, y: x[pr.c + 1]! }, majorAxis: { ...e.majorAxis, x: x[pr.u]!, y: x[pr.u + 1]! }, ratio: Math.min(1, Math.max(1e-6, x[pr.q]!)) };
      if (!pr.closed) {
        out.startParam = normA(x[pr.t0]!);
        out.endParam = normA(x[pr.t1]!);
      }
      return out;
    }
    case 'poly': {
      const e = pr.e;
      if (e.type === 'LWPOLYLINE') {
        const z = planZ(e.extrusion, e.elevation);
        const out: LwPolylineEntity = {
          ...e,
          elevation: z,
          vertices: e.vertices.map((v, i) => ({ ...v, x: x[pr.v[i]!]!, y: x[pr.v[i]! + 1]!, bulge: i < pr.b.length && pr.b[i]! >= 0 ? x[pr.b[i]!]! : 0 })),
        };
        delete out.extrusion;
        return out;
      }
      const z = planZ(e.extrusion, e.elevation);
      const vertices = e.vertices.map((v) => ({ ...v, location: { ...v.location } }));
      pr.idx.forEach((vi, k) => {
        const v = vertices[vi]!;
        v.location = { x: x[pr.v[k]!]!, y: x[pr.v[k]! + 1]!, z };
        v.bulge = k < pr.b.length && pr.b[k]! >= 0 ? x[pr.b[k]!]! : 0;
      });
      const out: PolylineEntity = { ...e, elevation: z, vertices };
      delete out.extrusion;
      return out;
    }
    case 'spline': {
      const e = pr.e;
      const out: SplineEntity = { ...e, controlPoints: e.controlPoints.map((p, i) => ({ ...p, x: x[pr.cp[i]!]!, y: x[pr.cp[i]! + 1]! })) };
      // 조정점을 직접 바꿨으므로 맞춤점 정의는 버린다(AutoCAD에서 조정점을 편집한 스플라인과 같다)
      if (out.fitPoints.length) {
        out.fitPoints = [];
        delete out.startTangent;
        delete out.endTangent;
      }
      return out;
    }
    case 'point': {
      const p0 = insertionPoint(pr.e)!;
      const dx = x[pr.p]! - p0.x;
      const dy = x[pr.p + 1]! - p0.y;
      const r = transformEntity(pr.e, affTranslate(dx, dy), doc);
      return r.replace?.[0] ?? r.add?.[0] ?? pr.e;
    }
  }
}
