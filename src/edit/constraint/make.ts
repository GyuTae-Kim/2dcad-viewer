/**
 * 새 구속 만들기 도우미: 지금 형상에서 방향(쪽·내접/외접·측정 방향)과 치수선 자리를 정한다.
 */
import type { CadDocument, Vec2 } from '../../core/model';
import { refShape } from './equations';
import { type Curve, curveOf, pointOf } from './prims';
import { buildSystem } from './system';
import type { Constraint, DimConstraint, GeoConstraint, GeoRef } from './types';
import { constraintHandles } from './types';

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const unit = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const sgn = (v: number) => (v < 0 ? -1 : 1);

export class MakeError extends Error {}

interface Geo {
  shape(r: GeoRef): ReturnType<typeof refShape>;
  pt(r: GeoRef): Vec2;
  curve(r: GeoRef): Curve;
}

function geoOf(doc: CadDocument, c: Constraint): Geo {
  const sys = buildSystem((h) => doc.entityIndex.get(h), [], constraintHandles(c));
  const x = sys.vars.x;
  const prim = (r: GeoRef) => {
    const p = sys.prims.get(r.h);
    if (!p) throw new MakeError('이 객체에는 구속조건을 적용할 수 없습니다.');
    return p;
  };
  return {
    shape: (r) => refShape(sys.prims, r, x),
    pt: (r) => {
      const p = pointOf(prim(r), r.part, x);
      if (!p) throw new MakeError('점이 필요합니다.');
      return p;
    },
    curve: (r) => {
      const cv = curveOf(prim(r), r.part, x);
      if (!cv) throw new MakeError('곡선이 필요합니다.');
      return cv;
    },
  };
}

/** 두 무한 직선의 교점(평행이면 null) */
export function lineIntersection(a: { a: Vec2; b: Vec2 }, b: { a: Vec2; b: Vec2 }): Vec2 | null {
  const d1 = sub(a.b, a.a);
  const d2 = sub(b.b, b.a);
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-12 * len(d1) * len(d2)) return null;
  const t = cross(sub(b.a, a.a), d2) / den;
  return { x: a.a.x + d1.x * t, y: a.a.y + d1.y * t };
}

/** 기하 구속의 방향 값(aux)을 지금 형상에서 정한다 */
export function prepareGeo(doc: CadDocument, c: GeoConstraint): GeoConstraint {
  const g = geoOf(doc, c);
  const R = c.refs;
  if (c.type === 'TANGENT') {
    const s0 = g.shape(R[0]!);
    const s1 = g.shape(R[1]!);
    if ((s0 === 'line' && (s1 === 'circle' || s1 === 'ellipse')) || ((s0 === 'circle' || s0 === 'ellipse') && s1 === 'line')) {
      const [lr, cr] = s0 === 'line' ? [R[0]!, R[1]!] : [R[1]!, R[0]!];
      const l = g.curve(lr) as { a: Vec2; b: Vec2 };
      const cc = (g.curve(cr) as { c: Vec2 }).c;
      return { ...c, aux: [sgn(cross(unit(sub(l.b, l.a)), sub(cc, l.a)))] };
    }
    if (s0 === 'circle' && s1 === 'circle') {
      const a = g.curve(R[0]!) as { c: Vec2; r: number };
      const b = g.curve(R[1]!) as { c: Vec2; r: number };
      const d = len(sub(a.c, b.c));
      const ext = Math.abs(d - (a.r + b.r));
      const int = Math.abs(d - Math.abs(a.r - b.r));
      return { ...c, aux: [ext <= int ? 0 : a.r >= b.r ? 1 : 2] };
    }
    throw new MakeError('이 객체 조합에는 접선 구속조건을 적용할 수 없습니다.');
  }
  if (c.type === 'SMOOTH') return { ...c, aux: [1] };
  return c;
}

/**
 * 치수 구속의 방향(aux)·치수선 자리(offset)를 정한다. at은 치수선 위치(없으면 기본 자리).
 * ANGLE 선 둘은 at이 있는 사분면의 각을 재도록 방향과 순서를 정한다(반시계 양수).
 */
export function prepareDim(doc: CadDocument, c: DimConstraint, at?: Vec2 | null): DimConstraint {
  const g = geoOf(doc, c);
  const R = c.refs;
  const axis = c.axis ?? 0;
  const ax = { x: Math.cos(axis), y: Math.sin(axis) };
  const ay = { x: -ax.y, y: ax.x };
  switch (c.type) {
    case 'DIST':
    case 'HDIST':
    case 'VDIST': {
      const s0 = g.shape(R[0]!);
      const s1 = g.shape(R[1]!);
      if (s0 === 'point' && s1 === 'point') {
        const p = g.pt(R[0]!);
        const q = g.pt(R[1]!);
        const m = mid(p, q);
        if (c.type === 'DIST') {
          const d = unit(sub(q, p));
          return { ...c, aux: [1], offset: at ? cross(d, sub(at, p)) : 0 };
        }
        if (c.type === 'HDIST') return { ...c, aux: [sgn(dot(ax, sub(q, p)))], offset: at ? dot(ay, sub(at, m)) : 0 };
        return { ...c, aux: [sgn(cross(ax, sub(q, p)))], offset: at ? dot(ax, sub(at, m)) : 0 };
      }
      if (c.type !== 'DIST') throw new MakeError('수평·수직 거리에는 두 점이 필요합니다.');
      if (s0 === 'point' && s1 === 'line') {
        const p = g.pt(R[0]!);
        const l = g.curve(R[1]!) as { a: Vec2; b: Vec2 };
        const d = unit(sub(l.b, l.a));
        const f = { x: l.a.x + d.x * dot(sub(p, l.a), d), y: l.a.y + d.y * dot(sub(p, l.a), d) };
        return { ...c, aux: [sgn(cross(d, sub(p, l.a)))], offset: at ? dot(d, sub(at, f)) : 0 };
      }
      if (s0 === 'line' && s1 === 'line') {
        const l1 = g.curve(R[0]!) as { a: Vec2; b: Vec2 };
        const l2 = g.curve(R[1]!) as { a: Vec2; b: Vec2 };
        const d = unit(sub(l1.b, l1.a));
        const m2 = mid(l2.a, l2.b);
        return { ...c, aux: [sgn(cross(d, sub(m2, l1.a)))], offset: at ? dot(d, sub(at, m2)) : 0 };
      }
      throw new MakeError('두 점, 점과 선, 또는 두 선이 필요합니다.');
    }
    case 'RADIUS':
    case 'DIAMETER': {
      const cv = g.curve(R[0]!);
      if (cv.k !== 'circle') throw new MakeError('호 또는 원을 선택해야 합니다.');
      let a = at ? Math.atan2(at.y - cv.c.y, at.x - cv.c.x) : Math.PI / 4;
      if (!at && cv.arc) a = (cv.arc.a0 + cv.arc.a1) / 2;
      return { ...c, offset: a };
    }
    case 'ANGLE': {
      if (R.length === 1) {
        const cv = g.curve(R[0]!);
        if (cv.k !== 'circle' || !cv.arc) throw new MakeError('호가 필요합니다.');
        return { ...c, offset: at ? Math.max(len(sub(at, cv.c)), cv.r * 0.2) : cv.r * 1.2 };
      }
      if (R.length === 3) {
        const o = g.pt(R[0]!);
        const u = sub(g.pt(R[1]!), o);
        const w = sub(g.pt(R[2]!), o);
        const ccw = (a: Vec2, b: Vec2) => {
          let t = Math.atan2(cross(a, b), dot(a, b));
          if (t < 0) t += 2 * Math.PI;
          return t;
        };
        let refs = R;
        if (at && ccw(u, sub(at, o)) > ccw(u, w)) refs = [R[0]!, R[2]!, R[1]!];
        return { ...c, refs, offset: at ? len(sub(at, o)) : Math.min(len(u), len(w)) * 0.6 };
      }
      const l1 = g.curve(R[0]!) as { a: Vec2; b: Vec2 };
      const l2 = g.curve(R[1]!) as { a: Vec2; b: Vec2 };
      if (l1.a === undefined || l2.a === undefined) throw new MakeError('선이 필요합니다.');
      const o = lineIntersection(l1, l2);
      if (!o) throw new MakeError('선이 평행합니다.');
      const d1 = unit(sub(l1.b, l1.a));
      const d2 = unit(sub(l2.b, l2.a));
      let s1 = 1;
      let s2 = 1;
      if (at) {
        // at - o = α·d1 + β·d2 → 그 사분면을 이루는 두 반직선
        const w = sub(at, o);
        const den = cross(d1, d2);
        const al = cross(w, d2) / den;
        const be = cross(d1, w) / den;
        s1 = sgn(al);
        s2 = sgn(be);
      } else {
        // 기본: 선분 쪽(교점에서 각 선의 먼 끝을 향하는 방향)
        const far = (l: { a: Vec2; b: Vec2 }, d: Vec2) => sgn(dot(sub(mid(l.a, l.b), o), d));
        s1 = far(l1, d1);
        s2 = far(l2, d2);
      }
      const u1 = { x: d1.x * s1, y: d1.y * s1 };
      const u2 = { x: d2.x * s2, y: d2.y * s2 };
      const r = at ? len(sub(at, o)) : Math.min(len(sub(l1.b, l1.a)), len(sub(l2.b, l2.a))) * 0.5;
      if (cross(u1, u2) < 0) return { ...c, refs: [R[1]!, R[0]!], aux: [s2, s1], offset: r };
      return { ...c, aux: [s1, s2], offset: r };
    }
  }
}
