/**
 * 구속 → 잔차식. 모든 잔차는 길이 단위다(각도 잔차는 척도 S를 곱한다). 잔차가 0이면 구속을 만족한다.
 */
import type { Vec2 } from '../../core/model';
import { type Curve, type Prim, curveOf, fixVars, isCurvePart, isPointPart, partVars, pointOf } from './prims';
import type { Constraint, DimConstraint, GeoConstraint, GeoRef } from './types';

type X = ArrayLike<number>;

export interface Eq {
  /** 이 식이 기대는 변수 번호 */
  vars: number[];
  f: (x: X) => number;
  /** 구속 번호(진단용) */
  id: number;
}

export interface EqContext {
  prims: Map<string, Prim>;
  /** 길이 척도(각도 잔차에 곱한다) */
  S: number;
  /** 고정 구속의 기준 값(풀기 전 값) */
  x0: X;
  /** 치수 구속의 구동 값(길이 또는 도). 없으면 c.value */
  dimValue?: (c: DimConstraint) => number;
  /**
   * 두 객체가 일치 구속으로 끝점을 공유하면 그 부분(접선 식을 각도 꼴로 세운다 — 거리 꼴은 공유 끝점의 일치 식과 1차 종속이다)
   */
  shared?: (a: string, b: string) => { pa: string; pb: string } | null;
}

/** 일치 구속으로 끝점을 공유하는 객체 쌍을 찾는 함수 */
export function sharedEnds(cs: readonly Constraint[]): (a: string, b: string) => { pa: string; pb: string } | null {
  const map = new Map<string, { pa: string; pb: string }>();
  const isEnd = (part: string) => part === 'S' || part === 'E' || /^V\d+$/.test(part);
  for (const c of cs) {
    if (c.type !== 'COINCIDENT' || c.refs.length !== 2) continue;
    const [r0, r1] = c.refs as [GeoRef, GeoRef];
    if (!isEnd(r0.part) || !isEnd(r1.part) || r0.h === r1.h) continue;
    map.set(`${r0.h}|${r1.h}`, { pa: r0.part, pb: r1.part });
    map.set(`${r1.h}|${r0.h}`, { pa: r1.part, pb: r0.part });
  }
  return (a, b) => map.get(`${a}|${b}`) ?? null;
}

/** 곡선 부분(선·호·폴리선 세그먼트)의 끝점 부분인지 */
function isEndOf(pr: Prim, curvePart: string, pointPart: string): boolean {
  if (pr.k === 'poly') {
    const i = Number(curvePart.slice(1));
    const m = /^V(\d+)$/.exec(pointPart);
    if (!m) return false;
    const v = Number(m[1]);
    return v === i || v === (i + 1) % pr.v.length;
  }
  return (pr.k === 'line' || pr.k === 'arc') && (pointPart === 'S' || pointPart === 'E');
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const unit = (a: Vec2): Vec2 => {
  const l = len(a) || 1e-300;
  return { x: a.x / l, y: a.y / l };
};
const wrapPi = (a: number) => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
};
const DEG = Math.PI / 180;

/** 참조가 가리키는 점·곡선의 종류 */
export type RefShape = 'point' | 'line' | 'circle' | 'ellipse' | 'spline' | null;

export function refShape(prims: Map<string, Prim>, r: GeoRef, x: X): RefShape {
  const pr = prims.get(r.h);
  if (!pr) return null;
  if (isPointPart(pr, r.part)) return 'point';
  if (isCurvePart(pr, r.part)) return curveOf(pr, r.part, x)?.k ?? null;
  return null;
}

class Builder {
  readonly eqs: Eq[] = [];
  constructor(
    readonly ctx: EqContext,
    readonly id: number,
  ) {}

  prim(r: GeoRef): Prim {
    const p = this.ctx.prims.get(r.h);
    if (!p) throw new ConstraintBuildError('구속조건이 가리키는 객체가 없습니다.');
    return p;
  }

  vars(...refs: GeoRef[]): number[] {
    const s = new Set<number>();
    for (const r of refs) for (const v of partVars(this.prim(r), r.part)) s.add(v);
    return [...s];
  }

  pt(r: GeoRef): (x: X) => Vec2 {
    const pr = this.prim(r);
    if (!isPointPart(pr, r.part)) throw new ConstraintBuildError('점이 필요합니다.');
    return (x) => pointOf(pr, r.part, x)!;
  }

  curve(r: GeoRef): (x: X) => Curve {
    const pr = this.prim(r);
    if (!isCurvePart(pr, r.part)) throw new ConstraintBuildError('곡선이 필요합니다.');
    return (x) => curveOf(pr, r.part, x)!;
  }

  line(r: GeoRef): (x: X) => { a: Vec2; b: Vec2 } {
    const c = this.curve(r);
    if (c(this.ctx.x0).k !== 'line') throw new ConstraintBuildError('선이 필요합니다.');
    return (x) => c(x) as { a: Vec2; b: Vec2 };
  }

  circle(r: GeoRef): (x: X) => { c: Vec2; r: number } {
    const c = this.curve(r);
    if (c(this.ctx.x0).k !== 'circle') throw new ConstraintBuildError('원이나 호가 필요합니다.');
    return (x) => c(x) as { c: Vec2; r: number };
  }

  center(r: GeoRef): (x: X) => Vec2 {
    const pr = this.prim(r);
    const sh = refShape(this.ctx.prims, r, this.ctx.x0);
    if (sh === 'circle') {
      const c = this.curve(r);
      return (x) => (c(x) as { c: Vec2 }).c;
    }
    if (sh === 'ellipse') {
      const c = this.curve(r);
      return (x) => (c(x) as { c: Vec2 }).c;
    }
    if (sh === 'point' && r.part.startsWith('C')) return (x) => pointOf(pr, r.part, x)!;
    throw new ConstraintBuildError('원·호·타원이 필요합니다.');
  }

  add(vars: number[], f: (x: X) => number): void {
    this.eqs.push({ vars, f, id: this.id });
  }
}

export class ConstraintBuildError extends Error {}

/** 선의 단위 방향 */
const ldir = (l: { a: Vec2; b: Vec2 }) => unit(sub(l.b, l.a));

/** 점에서 무한 직선까지의 부호 있는 거리 */
const sideDist = (l: { a: Vec2; b: Vec2 }, p: Vec2) => cross(ldir(l), sub(p, l.a));

/** 타원의 법선 방향 지지 거리(중심에서 접선까지) */
function ellipseSupport(e: { u: Vec2; ratio: number }, n: Vec2): number {
  const a = len(e.u);
  const uh = unit(e.u);
  const vh = { x: -uh.y, y: uh.x };
  const b = a * e.ratio;
  return Math.hypot(a * dot(n, uh), b * dot(n, vh));
}

/** 점이 곡선 위에 있는 잔차 */
function onCurve(c: Curve, p: Vec2): number {
  switch (c.k) {
    case 'line':
      return sideDist(c, p);
    case 'circle':
      return len(sub(p, c.c)) - c.r;
    case 'ellipse': {
      const a = len(c.u);
      const uh = unit(c.u);
      const d = sub(p, c.c);
      const s = dot(d, uh) / a;
      const t = cross(uh, d) / (a * c.ratio);
      return (Math.hypot(s, t) - 1) * a * Math.sqrt(c.ratio);
    }
    case 'spline':
      return NaN;
  }
}

/** 곡선의 끝 접선(끝에서 바깥으로 나가는 방향). 'S'면 곡선 안쪽으로 들어가는 방향을 뒤집어 돌려준다 */
function endTangent(pr: Prim, part: string, x: X): Vec2 | null {
  switch (pr.k) {
    case 'line': {
      const a = { x: x[pr.a]!, y: x[pr.a + 1]! };
      const b = { x: x[pr.b]!, y: x[pr.b + 1]! };
      return part === 'E' ? sub(b, a) : part === 'S' ? sub(a, b) : null;
    }
    case 'arc': {
      const r = x[pr.r]!;
      if (part === 'E') {
        const t = x[pr.a1]!;
        return { x: -Math.sin(t) * r, y: Math.cos(t) * r };
      }
      if (part === 'S') {
        const t = x[pr.a0]!;
        return { x: Math.sin(t) * r, y: -Math.cos(t) * r };
      }
      return null;
    }
    case 'spline': {
      const n = pr.cp.length;
      const P = (i: number) => ({ x: x[pr.cp[i]!]!, y: x[pr.cp[i]! + 1]! });
      if (part === 'E') return sub(P(n - 1), P(n - 2));
      if (part === 'S') return sub(P(0), P(1));
      return null;
    }
    case 'poly': {
      const m = /^V(\d+)$/.exec(part);
      if (!m) return null;
      const i = Number(m[1]);
      const n = pr.v.length;
      const segs = pr.closed ? n : n - 1;
      const seg = (k: number) => {
        const a = { x: x[pr.v[k]!]!, y: x[pr.v[k]! + 1]! };
        const b = { x: x[pr.v[(k + 1) % n]!]!, y: x[pr.v[(k + 1) % n]! + 1]! };
        const bu = pr.b[k]! >= 0 ? x[pr.b[k]!]! : 0;
        return { a, b, bu };
      };
      // 마지막 정점: 들어오는 세그먼트의 끝 접선, 첫 정점: 나가는 세그먼트의 시작 접선(바깥으로)
      if (i === n - 1 && i - 1 >= 0 && i - 1 < segs) {
        const s = seg(i - 1);
        const ch = sub(s.b, s.a);
        const th = 4 * Math.atan(s.bu);
        const c = Math.cos(th / 2);
        const sn = Math.sin(th / 2);
        return { x: ch.x * c - ch.y * sn, y: ch.x * sn + ch.y * c };
      }
      if (i === 0 && segs > 0) {
        const s = seg(0);
        const ch = sub(s.b, s.a);
        const th = 4 * Math.atan(s.bu);
        const c = Math.cos(-th / 2);
        const sn = Math.sin(-th / 2);
        const t = { x: ch.x * c - ch.y * sn, y: ch.x * sn + ch.y * c };
        return { x: -t.x, y: -t.y };
      }
      return null;
    }
    default:
      return null;
  }
}

/** 구속 하나의 잔차식. 맞지 않는 참조면 ConstraintBuildError */
export function constraintEquations(c: Constraint, ctx: EqContext): Eq[] {
  const b = new Builder(ctx, c.id);
  if (c.kind === 'geo') geoEquations(c, b);
  else dimEquations(c, b);
  return b.eqs;
}

function geoEquations(c: GeoConstraint, B: Builder): void {
  const { S, x0, prims } = B.ctx;
  const R = c.refs;
  const shape = (r: GeoRef) => refShape(prims, r, x0);
  const axis = c.axis ?? 0;
  const ax = { x: Math.cos(axis), y: Math.sin(axis) };
  switch (c.type) {
    case 'COINCIDENT': {
      if (R.length !== 2) throw new ConstraintBuildError('일치 구속조건에는 두 참조가 필요합니다.');
      const s0 = shape(R[0]!);
      const s1 = shape(R[1]!);
      if (s0 === 'point' && s1 === 'point') {
        const p = B.pt(R[0]!);
        const q = B.pt(R[1]!);
        const v = B.vars(R[0]!, R[1]!);
        B.add(v, (x) => p(x).x - q(x).x);
        B.add(v, (x) => p(x).y - q(x).y);
        return;
      }
      const [pr, cr] = s0 === 'point' ? [R[0]!, R[1]!] : [R[1]!, R[0]!];
      if (shape(pr) !== 'point' || !shape(cr) || shape(cr) === 'point') throw new ConstraintBuildError('점과 점 또는 점과 객체가 필요합니다.');
      if (shape(cr) === 'spline') throw new ConstraintBuildError('스플라인 위의 점 구속조건은 지원하지 않습니다.');
      const p = B.pt(pr);
      const cv = B.curve(cr);
      B.add(B.vars(pr, cr), (x) => onCurve(cv(x), p(x)));
      return;
    }
    case 'COLLINEAR': {
      const l1 = B.line(R[0]!);
      const l2 = B.line(R[1]!);
      const v = B.vars(R[0]!, R[1]!);
      B.add(v, (x) => sideDist(l1(x), l2(x).a));
      B.add(v, (x) => sideDist(l1(x), l2(x).b));
      return;
    }
    case 'CONCENTRIC': {
      const c1 = B.center(R[0]!);
      const c2 = B.center(R[1]!);
      const v = B.vars(R[0]!, R[1]!);
      B.add(v, (x) => c1(x).x - c2(x).x);
      B.add(v, (x) => c1(x).y - c2(x).y);
      return;
    }
    case 'FIX': {
      for (const r of R) {
        const pr = B.prim(r);
        if (isPointPart(pr, r.part) && !fixVars(pr, r.part).length) {
          // 호 끝·선 중간 같은 파생 점: 그 점의 자리를 고정
          const p = B.pt(r);
          const p0 = p(x0);
          const v = B.vars(r);
          B.add(v, (x) => p(x).x - p0.x);
          B.add(v, (x) => p(x).y - p0.y);
          continue;
        }
        for (const i of fixVars(pr, r.part)) {
          const k = isAngleVar(pr, i) ? S : 1;
          const v0 = x0[i]!;
          B.add([i], (x) => (x[i]! - v0) * k);
        }
      }
      return;
    }
    case 'PARALLEL': {
      const l1 = B.line(R[0]!);
      const l2 = B.line(R[1]!);
      B.add(B.vars(R[0]!, R[1]!), (x) => S * cross(ldir(l1(x)), ldir(l2(x))));
      return;
    }
    case 'PERPENDICULAR': {
      const l1 = B.line(R[0]!);
      const l2 = B.line(R[1]!);
      B.add(B.vars(R[0]!, R[1]!), (x) => S * dot(ldir(l1(x)), ldir(l2(x))));
      return;
    }
    case 'HORIZONTAL':
    case 'VERTICAL': {
      const horiz = c.type === 'HORIZONTAL';
      let d: (x: X) => Vec2;
      let v: number[];
      if (R.length === 2) {
        const p = B.pt(R[0]!);
        const q = B.pt(R[1]!);
        d = (x) => sub(q(x), p(x));
        v = B.vars(R[0]!, R[1]!);
      } else {
        const l = B.line(R[0]!);
        d = (x) => {
          const ll = l(x);
          return sub(ll.b, ll.a);
        };
        v = B.vars(R[0]!);
      }
      B.add(v, horiz ? (x) => cross(ax, d(x)) : (x) => dot(ax, d(x)));
      return;
    }
    case 'TANGENT': {
      const s0 = shape(R[0]!);
      const s1 = shape(R[1]!);
      const v = B.vars(R[0]!, R[1]!);
      const side = c.aux?.[0] ?? 1;
      // 끝점을 공유하면(일치 구속 또는 같은 폴리선의 이웃 세그먼트) 그 점에서의 각도 꼴
      const shared = (): { pr: Prim; part: string } | null => {
        const a = R[0]!;
        const b = R[1]!;
        const pa = B.prim(a);
        const pb = B.prim(b);
        if (a.h === b.h && pa.k === 'poly') {
          const i = Number(a.part.slice(1));
          const j = Number(b.part.slice(1));
          const n = pa.v.length;
          if ((i + 1) % n === j) return { pr: pa, part: `V${j}` };
          if ((j + 1) % n === i) return { pr: pa, part: `V${i}` };
          return null;
        }
        const sh = B.ctx.shared?.(a.h, b.h);
        if (!sh || !isEndOf(pa, a.part, sh.pa) || !isEndOf(pb, b.part, sh.pb)) return null;
        return { pr: pb, part: sh.pb };
      };
      const sp = shared();
      if ((s0 === 'line' && s1 === 'circle') || (s0 === 'circle' && s1 === 'line')) {
        const [lr, cr] = s0 === 'line' ? [R[0]!, R[1]!] : [R[1]!, R[0]!];
        const l = B.line(lr);
        const ci = B.circle(cr);
        if (sp) {
          const vv = [...new Set([...v, ...partVars(sp.pr, sp.part)])];
          B.add(vv, (x) => S * dot(ldir(l(x)), unit(sub(pointOf(sp.pr, sp.part, x)!, ci(x).c))));
          return;
        }
        B.add(v, (x) => side * sideDist(l(x), ci(x).c) - ci(x).r);
        return;
      }
      if (s0 === 'circle' && s1 === 'circle') {
        const c1 = B.circle(R[0]!);
        const c2 = B.circle(R[1]!);
        if (sp) {
          const vv = [...new Set([...v, ...partVars(sp.pr, sp.part)])];
          B.add(vv, (x) => {
            const p = pointOf(sp.pr, sp.part, x)!;
            return S * cross(unit(sub(p, c1(x).c)), unit(sub(p, c2(x).c)));
          });
          return;
        }
        const mode = c.aux?.[0] ?? 0;
        B.add(v, (x) => {
          const a = c1(x);
          const bb = c2(x);
          const d = len(sub(a.c, bb.c));
          return mode === 0 ? d - (a.r + bb.r) : mode === 1 ? d - (a.r - bb.r) : d - (bb.r - a.r);
        });
        return;
      }
      if ((s0 === 'line' && s1 === 'ellipse') || (s0 === 'ellipse' && s1 === 'line')) {
        const [lr, er] = s0 === 'line' ? [R[0]!, R[1]!] : [R[1]!, R[0]!];
        const l = B.line(lr);
        const ec = B.curve(er);
        B.add(v, (x) => {
          const ll = l(x);
          const el = ec(x) as Extract<Curve, { k: 'ellipse' }>;
          const dn = ldir(ll);
          const n = { x: -dn.y, y: dn.x };
          return side * sideDist(ll, el.c) - ellipseSupport(el, n);
        });
        return;
      }
      throw new ConstraintBuildError('이 객체 조합에는 접선 구속조건을 적용할 수 없습니다.');
    }
    case 'SMOOTH': {
      // [스플라인 끝, 다른 곡선 끝]: 일치 + 접선 방향(G1) + 선과 이으면 곡률 0(G2 근사)
      const a = R[0]!;
      const o = R[1]!;
      const pa = B.prim(a);
      const po = B.prim(o);
      if (pa.k !== 'spline') throw new ConstraintBuildError('첫 번째는 스플라인이어야 합니다.');
      const p = B.pt(a);
      const q = B.pt(o);
      const v = B.vars(a, o);
      B.add(v, (x) => p(x).x - q(x).x);
      B.add(v, (x) => p(x).y - q(x).y);
      const sense = c.aux?.[0] ?? 1;
      B.add(v, (x) => {
        const t1 = endTangent(pa, a.part, x);
        const t2 = endTangent(po, o.part, x);
        if (!t1 || !t2) return 0;
        // 이어진 곡선은 한쪽 끝에서 나가는 방향과 다른 쪽 끝에서 나가는 방향이 반대다
        const u = unit(t1);
        const w = unit({ x: -t2.x * sense, y: -t2.y * sense });
        return S * Math.atan2(cross(u, w), dot(u, w));
      });
      if (po.k === 'line' && pa.cp.length >= 3) {
        const n = pa.cp.length;
        const ids = a.part === 'S' ? [0, 1, 2] : [n - 1, n - 2, n - 3];
        B.add(v, (x) => {
          const P0 = { x: x[pa.cp[ids[0]!]!]!, y: x[pa.cp[ids[0]!]! + 1]! };
          const P1 = { x: x[pa.cp[ids[1]!]!]!, y: x[pa.cp[ids[1]!]! + 1]! };
          const P2 = { x: x[pa.cp[ids[2]!]!]!, y: x[pa.cp[ids[2]!]! + 1]! };
          return S * cross(unit(sub(P1, P0)), unit(sub(P2, P1)));
        });
      }
      return;
    }
    case 'SYMMETRIC': {
      const lr = R[R.length - 1]!;
      const L = B.line(lr);
      const mir = (l: { a: Vec2; b: Vec2 }, p: Vec2): Vec2 => {
        const d = ldir(l);
        const w = sub(p, l.a);
        const t = dot(w, d);
        const f = { x: l.a.x + d.x * t, y: l.a.y + d.y * t };
        return { x: 2 * f.x - p.x, y: 2 * f.y - p.y };
      };
      const s0 = shape(R[0]!);
      const s1 = shape(R[1]!);
      const v = B.vars(...R);
      if (s0 === 'point' && s1 === 'point') {
        const p = B.pt(R[0]!);
        const q = B.pt(R[1]!);
        B.add(v, (x) => {
          const m = mir(L(x), p(x));
          return m.x - q(x).x;
        });
        B.add(v, (x) => {
          const m = mir(L(x), p(x));
          return m.y - q(x).y;
        });
        return;
      }
      if (s0 === 'line' && s1 === 'line') {
        const l1 = B.line(R[0]!);
        const l2 = B.line(R[1]!);
        const both = (x: X) => {
          const ll = L(x);
          const a = l1(x);
          return { a: mir(ll, a.a), b: mir(ll, a.b) };
        };
        B.add(v, (x) => sideDist(l2(x), both(x).a));
        B.add(v, (x) => sideDist(l2(x), both(x).b));
        return;
      }
      if (s0 === 'circle' && s1 === 'circle') {
        const c1 = B.circle(R[0]!);
        const c2 = B.circle(R[1]!);
        B.add(v, (x) => mir(L(x), c1(x).c).x - c2(x).c.x);
        B.add(v, (x) => mir(L(x), c1(x).c).y - c2(x).c.y);
        B.add(v, (x) => c1(x).r - c2(x).r);
        return;
      }
      throw new ConstraintBuildError('같은 종류의 두 객체(점·선·원·호)가 필요합니다.');
    }
    case 'EQUAL': {
      const s0 = shape(R[0]!);
      const s1 = shape(R[1]!);
      const v = B.vars(R[0]!, R[1]!);
      if (s0 === 'line' && s1 === 'line') {
        const l1 = B.line(R[0]!);
        const l2 = B.line(R[1]!);
        B.add(v, (x) => len(sub(l1(x).b, l1(x).a)) - len(sub(l2(x).b, l2(x).a)));
        return;
      }
      if (s0 === 'circle' && s1 === 'circle') {
        const c1 = B.circle(R[0]!);
        const c2 = B.circle(R[1]!);
        B.add(v, (x) => c1(x).r - c2(x).r);
        return;
      }
      throw new ConstraintBuildError('선 둘 또는 원·호 둘이 필요합니다.');
    }
  }
}

/** 변수가 각도·비율인지(척도를 곱해야 하는지) */
function isAngleVar(pr: Prim, i: number): boolean {
  switch (pr.k) {
    case 'arc':
      return i === pr.a0 || i === pr.a1;
    case 'ellipse':
      return i === pr.q || i === pr.t0 || i === pr.t1;
    case 'poly':
      return pr.b.includes(i);
    default:
      return false;
  }
}

function dimEquations(c: DimConstraint, B: Builder): void {
  if (c.reference) return;
  const { S, x0, prims } = B.ctx;
  const val = B.ctx.dimValue ? B.ctx.dimValue(c) : c.value;
  const R = c.refs;
  const shape = (r: GeoRef) => refShape(prims, r, x0);
  const sense = c.aux?.[0] ?? 1;
  const axis = c.axis ?? 0;
  const ax = { x: Math.cos(axis), y: Math.sin(axis) };
  switch (c.type) {
    case 'DIST':
    case 'HDIST':
    case 'VDIST': {
      const s0 = shape(R[0]!);
      const s1 = shape(R[1]!);
      const v = B.vars(...R);
      if (s0 === 'point' && s1 === 'point') {
        const p = B.pt(R[0]!);
        const q = B.pt(R[1]!);
        if (c.type === 'DIST') B.add(v, (x) => len(sub(q(x), p(x))) - val);
        else if (c.type === 'HDIST') B.add(v, (x) => sense * dot(ax, sub(q(x), p(x))) - val);
        else B.add(v, (x) => sense * cross(ax, sub(q(x), p(x))) - val);
        return;
      }
      if (c.type !== 'DIST') throw new ConstraintBuildError('수평·수직 거리에는 두 점이 필요합니다.');
      if (s0 === 'point' && s1 === 'line') {
        const p = B.pt(R[0]!);
        const l = B.line(R[1]!);
        B.add(v, (x) => sense * sideDist(l(x), p(x)) - val);
        return;
      }
      if (s0 === 'line' && s1 === 'line') {
        const l1 = B.line(R[0]!);
        const l2 = B.line(R[1]!);
        B.add(v, (x) => S * cross(ldir(l1(x)), ldir(l2(x))));
        B.add(v, (x) => {
          const a = l2(x);
          const m = { x: (a.a.x + a.b.x) / 2, y: (a.a.y + a.b.y) / 2 };
          return sense * sideDist(l1(x), m) - val;
        });
        return;
      }
      throw new ConstraintBuildError('두 점, 점과 선, 또는 두 선이 필요합니다.');
    }
    case 'ANGLE': {
      const th = val * DEG;
      if (R.length === 1) {
        const pr = B.prim(R[0]!);
        if (pr.k === 'arc') {
          B.add([pr.a0, pr.a1], (x) => S * (x[pr.a1]! - x[pr.a0]! - th));
          return;
        }
        if (pr.k === 'poly' && pr.b[Number(R[0]!.part.slice(1))]! >= 0) {
          const bi = pr.b[Number(R[0]!.part.slice(1))]!;
          B.add([bi], (x) => S * (4 * Math.atan(Math.abs(x[bi]!)) - th));
          return;
        }
        throw new ConstraintBuildError('호가 필요합니다.');
      }
      if (R.length === 3) {
        const o = B.pt(R[0]!);
        const p = B.pt(R[1]!);
        const q = B.pt(R[2]!);
        B.add(B.vars(...R), (x) => {
          const u = sub(p(x), o(x));
          const w = sub(q(x), o(x));
          return S * wrapPi(Math.atan2(cross(u, w), dot(u, w)) - th);
        });
        return;
      }
      const l1 = B.line(R[0]!);
      const l2 = B.line(R[1]!);
      const s1 = c.aux?.[0] ?? 1;
      const s2 = c.aux?.[1] ?? 1;
      B.add(B.vars(...R), (x) => {
        const a = l1(x);
        const bb = l2(x);
        const u = { x: (a.b.x - a.a.x) * s1, y: (a.b.y - a.a.y) * s1 };
        const w = { x: (bb.b.x - bb.a.x) * s2, y: (bb.b.y - bb.a.y) * s2 };
        return S * wrapPi(Math.atan2(cross(u, w), dot(u, w)) - th);
      });
      return;
    }
    case 'RADIUS':
    case 'DIAMETER': {
      const ci = B.circle(R[0]!);
      const k = c.type === 'DIAMETER' ? 2 : 1;
      B.add(B.vars(R[0]!), (x) => k * ci(x).r - val);
      return;
    }
  }
}

/** 치수 구속의 지금 측정값(길이 또는 도). 잴 수 없으면 NaN */
export function measureDim(c: DimConstraint, prims: Map<string, Prim>, x: X): number {
  const R = c.refs;
  const shape = (r: GeoRef) => refShape(prims, r, x);
  const P = (r: GeoRef) => pointOf(prims.get(r.h)!, r.part, x)!;
  const C = (r: GeoRef) => curveOf(prims.get(r.h)!, r.part, x)!;
  const sense = c.aux?.[0] ?? 1;
  const axis = c.axis ?? 0;
  const ax = { x: Math.cos(axis), y: Math.sin(axis) };
  try {
    switch (c.type) {
      case 'DIST':
      case 'HDIST':
      case 'VDIST': {
        const s0 = shape(R[0]!);
        const s1 = shape(R[1]!);
        if (s0 === 'point' && s1 === 'point') {
          const d = sub(P(R[1]!), P(R[0]!));
          return c.type === 'DIST' ? len(d) : c.type === 'HDIST' ? sense * dot(ax, d) : sense * cross(ax, d);
        }
        if (s0 === 'point' && s1 === 'line') return sense * sideDist(C(R[1]!) as { a: Vec2; b: Vec2 }, P(R[0]!));
        if (s0 === 'line' && s1 === 'line') {
          const a = C(R[1]!) as { a: Vec2; b: Vec2 };
          return sense * sideDist(C(R[0]!) as { a: Vec2; b: Vec2 }, { x: (a.a.x + a.b.x) / 2, y: (a.a.y + a.b.y) / 2 });
        }
        return NaN;
      }
      case 'ANGLE': {
        if (R.length === 1) {
          const cv = C(R[0]!);
          if (cv.k === 'circle' && cv.arc) return (cv.arc.a1 - cv.arc.a0) / DEG;
          return NaN;
        }
        let u: Vec2;
        let w: Vec2;
        if (R.length === 3) {
          const o = P(R[0]!);
          u = sub(P(R[1]!), o);
          w = sub(P(R[2]!), o);
        } else {
          const a = C(R[0]!) as { a: Vec2; b: Vec2 };
          const bb = C(R[1]!) as { a: Vec2; b: Vec2 };
          const s1 = c.aux?.[0] ?? 1;
          const s2 = c.aux?.[1] ?? 1;
          u = { x: (a.b.x - a.a.x) * s1, y: (a.b.y - a.a.y) * s1 };
          w = { x: (bb.b.x - bb.a.x) * s2, y: (bb.b.y - bb.a.y) * s2 };
        }
        let t = Math.atan2(cross(u, w), dot(u, w));
        if (t < 0) t += 2 * Math.PI;
        return t / DEG;
      }
      case 'RADIUS':
      case 'DIAMETER': {
        const cv = C(R[0]!);
        if (cv.k !== 'circle') return NaN;
        return c.type === 'DIAMETER' ? 2 * cv.r : cv.r;
      }
    }
  } catch {
    return NaN;
  }
}

/** 기하 구속의 지금 잔차가 공차 안인지(편집 뒤 깨진 구속 찾기) */
export function constraintSatisfied(c: Constraint, ctx: EqContext, x: X, tol: number): boolean {
  try {
    const eqs = constraintEquations(c, ctx);
    return eqs.every((e) => Math.abs(e.f(x)) <= tol);
  } catch {
    return false;
  }
}
