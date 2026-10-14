/**
 * 자동 구속(AUTOCONSTRAIN): 고른 객체에서 공차 안에 있는 관계를 찾아 구속 후보를 만든다.
 * 우선순위대로 보고, 이미 있는 구속(과 앞서 받아들인 후보)에 종속인 후보는 버린다(야코비안 행 독립 검사).
 */
import type { CadDocument, Vec2 } from '../../core/model';
import { type Eq, constraintEquations, sharedEnds } from './equations';
import { type Curve, type Prim, curveOf, isPointPart, pointOf } from './prims';
import { RowBasis, jacobian, solveEquations } from './solver';
import { buildSystem, linkedComponent, shifted } from './system';
import type { Constraint, ConstraintStore, GeoConstraint, GeoRef, GeoType } from './types';

export interface AutoSettings {
  /** 적용할 종류(우선순위 순) */
  types: GeoType[];
  /** 거리 공차(도면 단위) */
  distTol: number;
  /** 각도 공차(도) */
  angleTol: number;
  /** 접선 객체는 공유 교차점이 있어야 함 */
  tangentNeedsPoint: boolean;
  /** 직교 객체는 공유 교차점이 있어야 함 */
  perpNeedsPoint: boolean;
}

/** AutoCAD 기본 설정 */
export const AUTO_DEFAULTS: AutoSettings = {
  types: ['COINCIDENT', 'COLLINEAR', 'PARALLEL', 'PERPENDICULAR', 'TANGENT', 'CONCENTRIC', 'HORIZONTAL', 'VERTICAL', 'EQUAL'],
  distTol: 0.05,
  angleTol: 1,
  tangentNeedsPoint: true,
  perpNeedsPoint: true,
};

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const DEG = Math.PI / 180;

type LineC = { a: Vec2; b: Vec2 };
type CircC = { c: Vec2; r: number; arc?: { a0: number; a1: number } };

/** 객체의 점 부분 목록 */
function pointParts(p: Prim): string[] {
  switch (p.k) {
    case 'point':
      return ['I'];
    case 'line':
      return ['S', 'E'];
    case 'circle':
      return [];
    case 'arc':
      return ['S', 'E'];
    case 'ellipse':
      return p.closed ? [] : ['S', 'E'];
    case 'spline':
      return ['S', 'E'];
    case 'poly':
      return p.closed ? [] : ['V0', `V${p.v.length - 1}`];
  }
}

/** 객체의 곡선 부분 목록 */
function curveParts(p: Prim): string[] {
  if (p.k === 'point' || p.k === 'spline') return [];
  if (p.k === 'poly') return p.b.map((_, i) => `G${i}`);
  return [''];
}

/** 선분 위(끝 포함, 공차) 매개변수 범위 안인지 */
function onSegment(l: LineC, p: Vec2, tol: number): boolean {
  const d = sub(l.b, l.a);
  const L = len(d);
  if (L < 1e-12) return false;
  const t = dot(sub(p, l.a), d) / L;
  return t >= -tol && t <= L + tol && Math.abs(cross(d, sub(p, l.a)) / L) <= tol;
}

function onArc(c: CircC, p: Vec2, tol: number): boolean {
  if (Math.abs(len(sub(p, c.c)) - c.r) > tol) return false;
  if (!c.arc) return true;
  let a = Math.atan2(p.y - c.c.y, p.x - c.c.x);
  const span = c.arc.a1 - c.arc.a0;
  let t = a - c.arc.a0;
  t = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  a = tol / Math.max(c.r, 1e-12);
  return t <= span + a || t >= 2 * Math.PI - a;
}

/** 두 선분의 교점이 두 선분 위에 있는지(공차) */
function segmentsMeet(a: LineC, b: LineC, tol: number): boolean {
  const d1 = sub(a.b, a.a);
  const d2 = sub(b.b, b.a);
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-15) return false;
  const t = cross(sub(b.a, a.a), d2) / den;
  const p = { x: a.a.x + d1.x * t, y: a.a.y + d1.y * t };
  return onSegment(a, p, tol) && onSegment(b, p, tol);
}

/**
 * 자동 구속 후보(받아들인 순서). axis는 수평·수직의 기준 축(UCS X 각도).
 * 돌려준 구속의 id는 0이다(addConstraints가 번호를 붙인다).
 */
export function autoConstrain(doc: CadDocument, store: ConstraintStore, handles: readonly string[], settings: AutoSettings = AUTO_DEFAULTS, axis = 0): Constraint[] {
  const comp = linkedComponent(store, handles);
  for (const h of handles) comp.handles.add(h);
  const sys = buildSystem((h) => doc.entityIndex.get(h), comp.constraints, comp.handles);
  const x = sys.vars.x;
  // 독립성 검사·풀기는 원점을 옮긴 값으로(먼 좌표의 정밀도)
  const x0s = shifted(sys, x);
  const S = sys.S;
  const sel = handles.filter((h) => sys.prims.has(h));
  const opt = { ang: sys.vars.ang, S };
  // 받아들인 일치 후보도 끝점 공유로 본다(접선 식을 각도 꼴로)
  const accepted: Constraint[] = [];
  const ctx = { prims: sys.prims, S, x0: x0s, shared: (a: string, b: string) => sharedEnds([...sys.constraints, ...accepted])(a, b) };
  const baseEqs: Eq[] = [];
  for (const c of sys.constraints) {
    try {
      baseEqs.push(...constraintEquations(c, ctx));
    } catch {
      /* 세울 수 없는 기존 구속은 건너뛴다 */
    }
  }
  // 후보는 공차 안에서만 맞으므로, 받아들일 때마다 지금까지의 구속으로 형상을 풀어 정확히 맞춘 자리에서 다음 후보의 독립성을 본다
  let xs = [...x0s];
  const accEqs: Eq[] = [];
  let basis = new RowBasis(x.length, sys.vars.ang, S);
  const rebuild = () => {
    basis = new RowBasis(x.length, sys.vars.ang, S);
    for (const r of jacobian([...baseEqs, ...accEqs], [...xs], opt)) basis.add(r);
  };
  rebuild();
  const tol = Math.max(1e-10 * S, 1e-12);
  const out: Constraint[] = [];
  const tryAdd = (c: GeoConstraint): boolean => {
    try {
      const eqs = constraintEquations(c, ctx);
      if (!basis.addAll(jacobian(eqs, [...xs], opt))) return false;
      const r = solveEquations([...baseEqs, ...accEqs, ...eqs], xs, { ang: sys.vars.ang, S, tol, deadline: (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 500 });
      if (!r.ok) {
        rebuild();
        return false;
      }
      xs = r.x;
      accEqs.push(...eqs);
      out.push(c);
      accepted.push(c);
      rebuild();
      return true;
    } catch {
      return false;
    }
  };
  const dt = settings.distTol;
  const at = settings.angleTol * DEG;
  // 요소 모으기
  const points: { r: GeoRef; p: Vec2 }[] = [];
  const lines: { r: GeoRef; l: LineC }[] = [];
  const circles: { r: GeoRef; c: CircC; ell?: boolean }[] = [];
  for (const h of sel) {
    const p = sys.prims.get(h)!;
    for (const part of pointParts(p)) if (isPointPart(p, part)) points.push({ r: { h, part }, p: pointOf(p, part, x)! });
    for (const part of curveParts(p)) {
      const cv: Curve | null = curveOf(p, part, x);
      if (!cv) continue;
      if (cv.k === 'line') lines.push({ r: { h, part }, l: cv });
      else if (cv.k === 'circle') circles.push({ r: { h, part }, c: cv });
      else if (cv.k === 'ellipse') circles.push({ r: { h, part }, c: { c: cv.c, r: NaN }, ell: true });
    }
  }
  const angOf = (l: LineC) => Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
  const angDiff = (a: number, b: number) => {
    let d = Math.abs(a - b) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d;
  };
  const geo = (type: GeoType, refs: GeoRef[], extra: Partial<GeoConstraint> = {}): GeoConstraint => ({ id: 0, kind: 'geo', type, refs, ...extra });
  for (const type of settings.types) {
    switch (type) {
      case 'COINCIDENT':
        for (let i = 0; i < points.length; i++)
          for (let j = i + 1; j < points.length; j++) {
            const a = points[i]!;
            const b = points[j]!;
            if (a.r.h === b.r.h) continue;
            if (len(sub(a.p, b.p)) <= dt) tryAdd(geo('COINCIDENT', [a.r, b.r]));
          }
        break;
      case 'COLLINEAR':
      case 'PARALLEL':
      case 'PERPENDICULAR':
      case 'EQUAL':
        for (let i = 0; i < lines.length; i++)
          for (let j = i + 1; j < lines.length; j++) {
            const a = lines[i]!;
            const b = lines[j]!;
            if (a.r.h === b.r.h && a.r.part === b.r.part) continue;
            const d = angDiff(angOf(a.l), angOf(b.l));
            const la = len(sub(a.l.b, a.l.a));
            const lb = len(sub(b.l.b, b.l.a));
            if (la < 1e-12 || lb < 1e-12) continue;
            const side = (p: Vec2) => Math.abs(cross(sub(a.l.b, a.l.a), sub(p, a.l.a))) / la;
            if (type === 'COLLINEAR' && d <= at && side(b.l.a) <= dt && side(b.l.b) <= dt) tryAdd(geo('COLLINEAR', [a.r, b.r]));
            else if (type === 'PARALLEL' && d <= at) tryAdd(geo('PARALLEL', [a.r, b.r]));
            else if (type === 'PERPENDICULAR' && Math.abs(d - Math.PI / 2) <= at && (!settings.perpNeedsPoint || segmentsMeet(a.l, b.l, dt))) tryAdd(geo('PERPENDICULAR', [a.r, b.r]));
            else if (type === 'EQUAL' && Math.abs(la - lb) <= dt) tryAdd(geo('EQUAL', [a.r, b.r]));
          }
        if (type === 'EQUAL')
          for (let i = 0; i < circles.length; i++)
            for (let j = i + 1; j < circles.length; j++) {
              const a = circles[i]!;
              const b = circles[j]!;
              if (a.ell || b.ell) continue;
              if (Math.abs(a.c.r - b.c.r) <= dt) tryAdd(geo('EQUAL', [a.r, b.r]));
            }
        break;
      case 'TANGENT':
        for (const l of lines)
          for (const c of circles) {
            if (c.ell || l.r.h === c.r.h) continue;
            const d = unitLine(l.l);
            const sd = cross(d, sub(c.c.c, l.l.a));
            if (Math.abs(Math.abs(sd) - c.c.r) > dt) continue;
            const t = dot(sub(c.c.c, l.l.a), d);
            const foot = { x: l.l.a.x + d.x * t, y: l.l.a.y + d.y * t };
            if (settings.tangentNeedsPoint && !(onSegment(l.l, foot, dt) && onArc(c.c, foot, dt))) continue;
            tryAdd(geo('TANGENT', [l.r, c.r], { aux: [sd < 0 ? -1 : 1] }));
          }
        for (let i = 0; i < circles.length; i++)
          for (let j = i + 1; j < circles.length; j++) {
            const a = circles[i]!;
            const b = circles[j]!;
            if (a.ell || b.ell || a.r.h === b.r.h) continue;
            const d = len(sub(a.c.c, b.c.c));
            if (d < 1e-12) continue;
            const ext = Math.abs(d - (a.c.r + b.c.r));
            const int = Math.abs(d - Math.abs(a.c.r - b.c.r));
            if (Math.min(ext, int) > dt) continue;
            const u = { x: (b.c.c.x - a.c.c.x) / d, y: (b.c.c.y - a.c.c.y) / d };
            const big = a.c.r >= b.c.r;
            const tp = ext <= int ? { x: a.c.c.x + u.x * a.c.r, y: a.c.c.y + u.y * a.c.r } : big ? { x: a.c.c.x + u.x * a.c.r, y: a.c.c.y + u.y * a.c.r } : { x: a.c.c.x - u.x * a.c.r, y: a.c.c.y - u.y * a.c.r };
            if (settings.tangentNeedsPoint && !(onArc(a.c, tp, dt) && onArc(b.c, tp, dt))) continue;
            tryAdd(geo('TANGENT', [a.r, b.r], { aux: [ext <= int ? 0 : big ? 1 : 2] }));
          }
        break;
      case 'CONCENTRIC':
        for (let i = 0; i < circles.length; i++)
          for (let j = i + 1; j < circles.length; j++) {
            const a = circles[i]!;
            const b = circles[j]!;
            if (a.r.h === b.r.h && a.r.part === b.r.part) continue;
            if (len(sub(a.c.c, b.c.c)) <= dt) tryAdd(geo('CONCENTRIC', [a.r, b.r]));
          }
        break;
      case 'HORIZONTAL':
      case 'VERTICAL':
        for (const l of lines) {
          const d = angDiff(angOf(l.l), axis);
          if (type === 'HORIZONTAL' ? d <= at : Math.abs(d - Math.PI / 2) <= at) tryAdd(geo(type, [l.r], axis ? { axis } : {}));
        }
        break;
      default:
        break;
    }
  }
  return out;
}

function unitLine(l: LineC): Vec2 {
  const d = sub(l.b, l.a);
  const L = len(d) || 1;
  return { x: d.x / L, y: d.y / L };
}
