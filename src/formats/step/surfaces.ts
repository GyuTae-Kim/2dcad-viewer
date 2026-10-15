/**
 * 곡면(ISO 10303-42 매개변수화): 점·편도함수·법선·점에서 (u,v) 되짚기·주기·극점.
 * 해석 곡면은 닫힌 식으로 되짚고, 그 밖의 곡면은 격자 추정 + 가우스-뉴턴으로 되짚는다.
 */
import type { Curve } from './curves';
import { BSplineCurve } from './curves';
import { add, addScaled, cross, dist, dist2, dot, type Frame, framePoint, len, normalize, scale, sub, type V3 } from './math';
import type { NurbsSurface } from './nurbs';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** 극선: fixed 차원이 value일 때 다른 매개변수가 무엇이든 한 점 */
export interface Pole {
  fixed: 0 | 1;
  value: number;
}

export abstract class Surface {
  abstract readonly kind: string;
  periodU = 0;
  periodV = 0;
  u0 = -Infinity;
  u1 = Infinity;
  v0 = -Infinity;
  v1 = Infinity;
  planar = false;
  poles: Pole[] = [];
  /** 안쪽 나눔에서 한 모서리가 넘지 말아야 할 매개변수 간격 */
  maxStepU = Infinity;
  maxStepV = Infinity;
  /** 되짚기 결과를 받아들이는 거리(이보다 멀면 격자에서 다시 찾는다) */
  projTol = 1e-6;

  abstract point(u: number, v: number): V3;

  /** [점, ∂u, ∂v] (기본: 중심 차분) */
  derivs(u: number, v: number): [V3, V3, V3] {
    const hu = this.fd(u, this.u0, this.u1);
    const hv = this.fd(v, this.v0, this.v1);
    const p = this.point(u, v);
    const du = scale(sub(this.point(u + hu, v), this.point(u - hu, v)), 1 / (2 * hu));
    const dv = scale(sub(this.point(u, v + hv), this.point(u, v - hv)), 1 / (2 * hv));
    return [p, du, dv];
  }
  private fd(t: number, a: number, b: number): number {
    const span = Number.isFinite(b - a) ? b - a : 1;
    return Math.max(1e-9, Math.abs(t) * 1e-9, span * 1e-6);
  }

  /** 단위 법선(∂u×∂v 방향). 특이점이면 안쪽으로 조금 옮겨서 */
  normal(u: number, v: number): V3 {
    const [, du, dv] = this.derivs(u, v);
    const n = cross(du, dv);
    const l = len(n);
    if (l > 1e-14 * (len(du) * len(dv) + 1e-300) && l > 1e-300) return scale(n, 1 / l);
    const su = Number.isFinite(this.u1 - this.u0) ? this.u1 - this.u0 : 1;
    const sv = Number.isFinite(this.v1 - this.v0) ? this.v1 - this.v0 : 1;
    const cu = Number.isFinite(this.u0 + this.u1) ? (this.u0 + this.u1) / 2 : u;
    const cv = Number.isFinite(this.v0 + this.v1) ? (this.v0 + this.v1) / 2 : v;
    for (const k of [1e-6, 1e-4, 1e-2]) {
      const uu = u + Math.sign(cu - u || 1) * su * k;
      const vv = v + Math.sign(cv - v || 1) * sv * k;
      for (const [a, b] of [
        [u, vv],
        [uu, v],
        [uu, vv],
      ] as const) {
        const [, du2, dv2] = this.derivs(a, b);
        const m = cross(du2, dv2);
        const lm = len(m);
        if (lm > 1e-300) return scale(m, 1 / lm);
      }
    }
    return [0, 0, 1];
  }

  /** 점에 가장 가까운 (u, v) */
  abstract project(p: V3, hint?: readonly [number, number] | null): [number, number];

  /** 대략의 크기(꼭짓점이 없는 닫힌 면의 허용 오차용). 정의역이 무한하면 0 */
  size(): number {
    if (![this.u0, this.u1, this.v0, this.v1].every(Number.isFinite)) return 0;
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i <= 4; i++)
      for (let j = 0; j <= 4; j++) {
        const p = this.point(this.u0 + ((this.u1 - this.u0) * i) / 4, this.v0 + ((this.v1 - this.v0) * j) / 4);
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k]!, p[k]!);
          hi[k] = Math.max(hi[k]!, p[k]!);
        }
      }
    return dist(lo, hi);
  }

  /** 극점 위치 */
  polePoint(k: number): V3 {
    const pl = this.poles[k]!;
    if (pl.fixed === 1) {
      const u = Number.isFinite(this.u0) ? (Number.isFinite(this.u1) ? (this.u0 + this.u1) / 2 : this.u0) : 0;
      return this.point(u, pl.value);
    }
    const v = Number.isFinite(this.v0) ? (Number.isFinite(this.v1) ? (this.v0 + this.v1) / 2 : this.v0) : 0;
    return this.point(pl.value, v);
  }

  /** p가 극점이면 그 번호, 아니면 -1 */
  poleAt(p: V3, eps: number): number {
    for (let k = 0; k < this.poles.length; k++) if (dist(p, this.polePoint(k)) <= eps) return k;
    return -1;
  }

  /** 가우스-뉴턴으로 (u,v)를 다듬는다 */
  protected refineUV(p: V3, u: number, v: number, iters = 40): [number, number, number] {
    let [S, Su, Sv] = this.derivs(u, v);
    let d2 = dist2(S, p);
    for (let it = 0; it < iters; it++) {
      const r = sub(p, S);
      const a = dot(Su, Su);
      const b = dot(Su, Sv);
      const c = dot(Sv, Sv);
      const ru = dot(Su, r);
      const rv = dot(Sv, r);
      const det = a * c - b * b;
      let du: number;
      let dv: number;
      if (det > 1e-14 * a * c && det > 1e-300) {
        du = (c * ru - b * rv) / det;
        dv = (a * rv - b * ru) / det;
      } else {
        du = a > 1e-300 ? ru / a : 0;
        dv = c > 1e-300 ? rv / c : 0;
      }
      // 한 걸음 제한(정의역의 절반)
      const lu = Number.isFinite(this.u1 - this.u0) ? (this.u1 - this.u0) / 2 : Infinity;
      const lv = Number.isFinite(this.v1 - this.v0) ? (this.v1 - this.v0) / 2 : Infinity;
      if (Math.abs(du) > lu) du = Math.sign(du) * lu;
      if (Math.abs(dv) > lv) dv = Math.sign(dv) * lv;
      let improved = false;
      let nu = u;
      let nv = v;
      let nd: [V3, V3, V3] | null = null;
      for (let k = 0; k < 8; k++) {
        nu = this.clampU(u + du);
        nv = this.clampV(v + dv);
        nd = this.derivs(nu, nv);
        const nd2 = dist2(nd[0], p);
        if (nd2 <= d2) {
          improved = true;
          d2 = nd2;
          break;
        }
        du *= 0.5;
        dv *= 0.5;
      }
      if (!improved || !nd) break;
      const moved = Math.abs(nu - u) + Math.abs(nv - v);
      u = nu;
      v = nv;
      [S, Su, Sv] = nd;
      if (moved < 1e-15 * (1 + Math.abs(u) + Math.abs(v))) break;
    }
    return [u, v, Math.sqrt(d2)];
  }

  protected clampU(u: number): number {
    return this.periodU > 0 ? u : Math.min(Math.max(u, this.u0), this.u1);
  }
  protected clampV(v: number): number {
    return this.periodV > 0 ? v : Math.min(Math.max(v, this.v0), this.v1);
  }

  /** 주기 차원을 정의역 안으로 */
  canon(u: number, v: number): [number, number] {
    if (this.periodU > 0) {
      const r = (u - this.u0) % this.periodU;
      u = this.u0 + (r < 0 ? r + this.periodU : r);
    }
    if (this.periodV > 0) {
      const r = (v - this.v0) % this.periodV;
      v = this.v0 + (r < 0 ? r + this.periodV : r);
    }
    return [u, v];
  }
}

export class PlaneSurface extends Surface {
  readonly kind = 'plane';
  override planar = true;
  constructor(readonly f: Frame) {
    super();
  }
  point(u: number, v: number): V3 {
    return framePoint(this.f, u, v, 0);
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    return [this.point(u, v), this.f.x, this.f.y];
  }
  override normal(): V3 {
    return this.f.z;
  }
  project(p: V3): [number, number] {
    const d = sub(p, this.f.o);
    return [dot(d, this.f.x), dot(d, this.f.y)];
  }
}

function angleOf(d: V3, f: Frame): number {
  const a = Math.atan2(dot(d, f.y), dot(d, f.x));
  return a < 0 ? a + TWO_PI : a;
}

export class CylinderSurface extends Surface {
  readonly kind = 'cylinder';
  constructor(
    readonly f: Frame,
    readonly r: number,
  ) {
    super();
    this.periodU = TWO_PI;
    this.u0 = 0;
    this.u1 = TWO_PI;
  }
  point(u: number, v: number): V3 {
    return framePoint(this.f, this.r * Math.cos(u), this.r * Math.sin(u), v);
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    const c = Math.cos(u);
    const s = Math.sin(u);
    return [framePoint(this.f, this.r * c, this.r * s, v), add(scale(this.f.x, -this.r * s), scale(this.f.y, this.r * c)), this.f.z];
  }
  override normal(u: number): V3 {
    return add(scale(this.f.x, Math.cos(u)), scale(this.f.y, Math.sin(u)));
  }
  project(p: V3): [number, number] {
    const d = sub(p, this.f.o);
    return [angleOf(d, this.f), dot(d, this.f.z)];
  }
  override size(): number {
    return Math.abs(this.r) * 2;
  }
}

export class ConeSurface extends Surface {
  readonly kind = 'cone';
  readonly t: number;
  constructor(
    readonly f: Frame,
    readonly r: number,
    semiAngle: number,
  ) {
    super();
    this.periodU = TWO_PI;
    this.u0 = 0;
    this.u1 = TWO_PI;
    this.t = Math.tan(semiAngle);
    if (Math.abs(this.t) > 1e-12) {
      const apex = -r / this.t;
      if (this.t > 0) this.v0 = apex;
      else this.v1 = apex;
      this.poles = [{ fixed: 1, value: apex }];
    }
  }
  point(u: number, v: number): V3 {
    const rr = this.r + v * this.t;
    return framePoint(this.f, rr * Math.cos(u), rr * Math.sin(u), v);
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    const c = Math.cos(u);
    const s = Math.sin(u);
    const rr = this.r + v * this.t;
    return [
      framePoint(this.f, rr * c, rr * s, v),
      add(scale(this.f.x, -rr * s), scale(this.f.y, rr * c)),
      add(add(scale(this.f.x, this.t * c), scale(this.f.y, this.t * s)), this.f.z),
    ];
  }
  override normal(u: number, v: number): V3 {
    // ∂u×∂v ∝ (r+vt)·(radial − t·z): 꼭짓점에서도 방향은 정해진다
    const sgn = this.r + v * this.t < 0 ? -1 : 1;
    const radial = add(scale(this.f.x, Math.cos(u)), scale(this.f.y, Math.sin(u)));
    return scale(normalize(sub(radial, scale(this.f.z, this.t))), sgn);
  }
  project(p: V3): [number, number] {
    const d = sub(p, this.f.o);
    const h = dot(d, this.f.z);
    const x = dot(d, this.f.x);
    const y = dot(d, this.f.y);
    const rho = Math.hypot(x, y);
    let u = Math.atan2(y, x);
    if (u < 0) u += TWO_PI;
    const v = (h + this.t * (rho - this.r)) / (1 + this.t * this.t);
    return [u, v];
  }
  override size(): number {
    return Math.abs(this.r) * 2;
  }
}

export class SphereSurface extends Surface {
  readonly kind = 'sphere';
  constructor(
    readonly f: Frame,
    readonly r: number,
  ) {
    super();
    this.periodU = TWO_PI;
    this.u0 = 0;
    this.u1 = TWO_PI;
    this.v0 = -HALF_PI;
    this.v1 = HALF_PI;
    this.poles = [
      { fixed: 1, value: -HALF_PI },
      { fixed: 1, value: HALF_PI },
    ];
  }
  point(u: number, v: number): V3 {
    const cv = Math.cos(v);
    return framePoint(this.f, this.r * cv * Math.cos(u), this.r * cv * Math.sin(u), this.r * Math.sin(v));
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    const R = this.r;
    return [
      framePoint(this.f, R * cv * cu, R * cv * su, R * sv),
      add(scale(this.f.x, -R * cv * su), scale(this.f.y, R * cv * cu)),
      add(add(scale(this.f.x, -R * sv * cu), scale(this.f.y, -R * sv * su)), scale(this.f.z, R * cv)),
    ];
  }
  override normal(u: number, v: number): V3 {
    const n = normalize(sub(this.point(u, v), this.f.o));
    return this.r < 0 ? scale(n, -1) : n;
  }
  project(p: V3): [number, number] {
    const d = sub(p, this.f.o);
    const x = dot(d, this.f.x);
    const y = dot(d, this.f.y);
    const z = dot(d, this.f.z);
    let u = Math.atan2(y, x);
    if (u < 0) u += TWO_PI;
    return [u, Math.atan2(z, Math.hypot(x, y))];
  }
}

export class TorusSurface extends Surface {
  readonly kind = 'torus';
  constructor(
    readonly f: Frame,
    readonly R: number,
    readonly r: number,
  ) {
    super();
    this.periodU = TWO_PI;
    this.periodV = TWO_PI;
    this.u0 = 0;
    this.u1 = TWO_PI;
    this.v0 = 0;
    this.v1 = TWO_PI;
  }
  point(u: number, v: number): V3 {
    const rr = this.R + this.r * Math.cos(v);
    return framePoint(this.f, rr * Math.cos(u), rr * Math.sin(u), this.r * Math.sin(v));
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const cv = Math.cos(v);
    const sv = Math.sin(v);
    const rr = this.R + this.r * cv;
    return [
      framePoint(this.f, rr * cu, rr * su, this.r * sv),
      add(scale(this.f.x, -rr * su), scale(this.f.y, rr * cu)),
      add(add(scale(this.f.x, -this.r * sv * cu), scale(this.f.y, -this.r * sv * su)), scale(this.f.z, this.r * cv)),
    ];
  }
  override normal(u: number, v: number): V3 {
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const radial = add(scale(this.f.x, cu), scale(this.f.y, su));
    const n = add(scale(radial, Math.cos(v)), scale(this.f.z, Math.sin(v)));
    const rr = this.R + this.r * Math.cos(v);
    return rr * this.r < 0 ? scale(n, -1) : n;
  }
  project(p: V3): [number, number] {
    const d = sub(p, this.f.o);
    const x = dot(d, this.f.x);
    const y = dot(d, this.f.y);
    const z = dot(d, this.f.z);
    let u = Math.atan2(y, x);
    if (u < 0) u += TWO_PI;
    let v = Math.atan2(z, Math.hypot(x, y) - this.R);
    if (v < 0) v += TWO_PI;
    return [u, v];
  }
}

/** 곡선을 축 둘레로 돌린 곡면: u = 회전각, v = 곡선 매개변수 */
export class RevolutionSurface extends Surface {
  readonly kind = 'revolution';
  private eRef: V3;
  constructor(
    readonly c: Curve,
    readonly a0: V3,
    readonly ax: V3,
    eps: number,
  ) {
    super();
    this.periodU = TWO_PI;
    this.u0 = 0;
    this.u1 = TWO_PI;
    this.v0 = c.t0;
    this.v1 = c.t1;
    this.periodV = c.period;
    if (c instanceof BSplineCurve) this.maxStepV = (c.t1 - c.t0) / Math.max(2, c.bp.length - 1);
    // 곡선이 놓인 반평면의 지름 방향
    let best: V3 = [0, 0, 0];
    let bestR = -1;
    const a = Number.isFinite(c.t0) ? c.t0 : -1;
    const b = Number.isFinite(c.t1) ? c.t1 : 1;
    for (let i = 0; i <= 16; i++) {
      const q = sub(c.point(a + ((b - a) * i) / 16), a0);
      const radial = sub(q, scale(ax, dot(q, ax)));
      const r = len(radial);
      if (r > bestR) {
        bestR = r;
        best = radial;
      }
    }
    this.eRef = bestR > 0 ? scale(best, 1 / bestR) : perpendicular(ax);
    // 축에 닿는 곡선 끝은 극점
    for (const t of [c.t0, c.t1]) {
      if (!Number.isFinite(t)) continue;
      const q = sub(c.point(t), a0);
      if (len(sub(q, scale(ax, dot(q, ax)))) <= eps) this.poles.push({ fixed: 1, value: t });
    }
  }
  private rot(q: V3, u: number): V3 {
    const par = scale(this.ax, dot(q, this.ax));
    const perp = sub(q, par);
    return add(add(par, scale(perp, Math.cos(u))), scale(cross(this.ax, perp), Math.sin(u)));
  }
  point(u: number, v: number): V3 {
    return add(this.a0, this.rot(sub(this.c.point(v), this.a0), u));
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    const q = sub(this.c.point(v), this.a0);
    const par = scale(this.ax, dot(q, this.ax));
    const perp = sub(q, par);
    const axp = cross(this.ax, perp);
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const p = add(this.a0, add(add(par, scale(perp, cu)), scale(axp, su)));
    const du = add(scale(perp, -su), scale(axp, cu));
    const dv = this.rot(this.c.d1(v), u);
    return [p, du, dv];
  }
  project(p: V3, hint?: readonly [number, number] | null): [number, number] {
    const d = sub(p, this.a0);
    const h = dot(d, this.ax);
    const radial = sub(d, scale(this.ax, h));
    const rho = len(radial);
    const q = add(add(this.a0, scale(this.ax, h)), scale(this.eRef, rho));
    const v = this.c.project(q, hint ? hint[1] : undefined);
    const cq = sub(this.c.point(v), this.a0);
    const cr = sub(cq, scale(this.ax, dot(cq, this.ax)));
    let u = 0;
    if (len(cr) > 0 && rho > 0) {
      u = Math.atan2(dot(cross(cr, radial), this.ax), dot(cr, radial));
      if (u < 0) u += TWO_PI;
    }
    let best = this.refineUV(p, u, v, 12);
    if (hint && best[2] > this.projTol) {
      const r = this.refineUV(p, hint[0], hint[1], 12);
      if (r[2] < best[2]) best = r;
    }
    if (best[2] > this.projTol && Number.isFinite(this.v0) && Number.isFinite(this.v1)) {
      // 곡선이 축과 한 평면에 있지 않으면: v를 훑어 다시
      let bd = Infinity;
      let bv = best[1];
      let buu = best[0];
      for (let i = 0; i <= 64; i++) {
        const vv = this.v0 + ((this.v1 - this.v0) * i) / 64;
        const cq = sub(this.c.point(vv), this.a0);
        const cr = sub(cq, scale(this.ax, dot(cq, this.ax)));
        let uu = 0;
        if (len(cr) > 0 && rho > 0) uu = Math.atan2(dot(cross(cr, radial), this.ax), dot(cr, radial));
        const d = dist2(this.point(uu, vv), p);
        if (d < bd) {
          bd = d;
          bv = vv;
          buu = uu;
        }
      }
      const r = this.refineUV(p, buu, bv, 20);
      if (r[2] < best[2]) best = r;
    }
    return this.canon(best[0], best[1]);
  }
}

function perpendicular(a: V3): V3 {
  const t: V3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(sub(t, scale(a, dot(t, a))));
}

/** 곡선을 한 방향으로 민 곡면: u = 곡선 매개변수, v = 민 길이(벡터 배수) */
export class ExtrusionSurface extends Surface {
  readonly kind = 'extrusion';
  private dn: V3;
  constructor(
    readonly c: Curve,
    readonly d: V3,
  ) {
    super();
    this.u0 = c.t0;
    this.u1 = c.t1;
    this.periodU = c.period;
    this.dn = normalize(d);
    if (c.linear) this.planar = true;
    if (c instanceof BSplineCurve) this.maxStepU = (c.t1 - c.t0) / Math.max(2, c.bp.length - 1);
  }
  point(u: number, v: number): V3 {
    return addScaled(this.c.point(u), this.d, v);
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    return [this.point(u, v), this.c.d1(u), this.d];
  }
  project(p: V3, hint?: readonly [number, number] | null): [number, number] {
    const l2 = dot(this.d, this.d) || 1;
    const vAt = (u: number) => dot(sub(p, this.c.point(u)), this.d) / l2;
    // 곡선이 민 방향에 수직인 평면에 있다고 보고 첫 추정
    const ref = this.c.point(Number.isFinite(this.c.t0) ? this.c.t0 : 0);
    const q = sub(p, scale(this.dn, dot(sub(p, ref), this.dn)));
    const u0 = this.c.project(q, hint ? hint[0] : undefined);
    let best = this.refineUV(p, u0, vAt(u0), 12);
    if (hint && best[2] > this.projTol) {
      const r = this.refineUV(p, hint[0], hint[1], 12);
      if (r[2] < best[2]) best = r;
    }
    if (best[2] > this.projTol && Number.isFinite(this.u0) && Number.isFinite(this.u1)) {
      // 곡선이 비스듬하면: u를 훑어 가장 가까운 곳에서 다시
      let bu = best[0];
      let bd = Infinity;
      for (let i = 0; i <= 64; i++) {
        const u = this.u0 + ((this.u1 - this.u0) * i) / 64;
        const d = dist2(this.point(u, vAt(u)), p);
        if (d < bd) {
          bd = d;
          bu = u;
        }
      }
      const r = this.refineUV(p, bu, vAt(bu), 20);
      if (r[2] < best[2]) best = r;
    }
    return this.canon(best[0], best[1]);
  }
}

/** NURBS 곡면 */
export class BSplineSurface extends Surface {
  readonly kind = 'bspline';
  private grid: Float64Array | null = null;
  private gu = 0;
  private gv = 0;
  constructor(
    readonly ns: NurbsSurface,
    eps: number,
  ) {
    super();
    this.u0 = ns.u0;
    this.u1 = ns.u1;
    this.v0 = ns.v0;
    this.v1 = ns.v1;
    const spansU = distinctCount(ns.bu.U, ns.bu.p, ns.bu.n) - 1;
    const spansV = distinctCount(ns.bv.U, ns.bv.p, ns.bv.n) - 1;
    // 매듭 구간이 많아도 굽음은 현 높이·각 검사가 잡는다: 간격 제한은 거칠게(놓친 굴곡 막기용)
    this.maxStepU = (this.u1 - this.u0) / Math.max(2, Math.min(Math.ceil(spansU / 2), 12));
    this.maxStepV = (this.v1 - this.v0) / Math.max(2, Math.min(Math.ceil(spansV / 2), 12));
    // 닫힘(주기)과 극점 찾기
    const K = 9;
    let closedU = true;
    let closedV = true;
    for (let k = 0; k < K; k++) {
      const v = this.v0 + ((this.v1 - this.v0) * k) / (K - 1);
      if (dist(this.point(this.u0, v), this.point(this.u1, v)) > eps) closedU = false;
      const u = this.u0 + ((this.u1 - this.u0) * k) / (K - 1);
      if (dist(this.point(u, this.v0), this.point(u, this.v1)) > eps) closedV = false;
    }
    if (closedU) this.periodU = this.u1 - this.u0;
    if (closedV) this.periodV = this.v1 - this.v0;
    const collapsed = (fixed: 0 | 1, value: number) => {
      const a = fixed === 0 ? this.v0 : this.u0;
      const b = fixed === 0 ? this.v1 : this.u1;
      const p0 = fixed === 0 ? this.point(value, a) : this.point(a, value);
      for (let k = 1; k < K; k++) {
        const t = a + ((b - a) * k) / (K - 1);
        const q = fixed === 0 ? this.point(value, t) : this.point(t, value);
        if (dist(p0, q) > eps) return false;
      }
      return true;
    };
    if (!closedU) {
      if (collapsed(0, this.u0)) this.poles.push({ fixed: 0, value: this.u0 });
      if (collapsed(0, this.u1)) this.poles.push({ fixed: 0, value: this.u1 });
    }
    if (!closedV) {
      if (collapsed(1, this.v0)) this.poles.push({ fixed: 1, value: this.v0 });
      if (collapsed(1, this.v1)) this.poles.push({ fixed: 1, value: this.v1 });
    }
  }
  point(u: number, v: number): V3 {
    if (this.periodU > 0 || this.periodV > 0) [u, v] = this.wrapPeriodic(u, v);
    return this.ns.eval(u, v, false)[0]!;
  }
  override derivs(u: number, v: number): [V3, V3, V3] {
    if (this.periodU > 0 || this.periodV > 0) [u, v] = this.wrapPeriodic(u, v);
    const r = this.ns.eval(u, v, true);
    return [r[0]!, r[1]!, r[2]!];
  }
  private wrapPeriodic(u: number, v: number): [number, number] {
    if (this.periodU > 0 && (u < this.u0 || u > this.u1)) {
      const r = (u - this.u0) % this.periodU;
      u = this.u0 + (r < 0 ? r + this.periodU : r);
    }
    if (this.periodV > 0 && (v < this.v0 || v > this.v1)) {
      const r = (v - this.v0) % this.periodV;
      v = this.v0 + (r < 0 ? r + this.periodV : r);
    }
    return [u, v];
  }
  private buildGrid(): void {
    const ns = this.ns;
    this.gu = Math.min(48, Math.max(9, ns.nu * 2 + 1));
    this.gv = Math.min(48, Math.max(9, ns.nv * 2 + 1));
    const g = new Float64Array(this.gu * this.gv * 3);
    for (let i = 0; i < this.gu; i++)
      for (let j = 0; j < this.gv; j++) {
        const u = this.u0 + ((this.u1 - this.u0) * i) / (this.gu - 1);
        const v = this.v0 + ((this.v1 - this.v0) * j) / (this.gv - 1);
        const p = ns.eval(u, v, false)[0]!;
        const q = (i * this.gv + j) * 3;
        g[q] = p[0];
        g[q + 1] = p[1];
        g[q + 2] = p[2];
      }
    this.grid = g;
  }
  private gridGuess(p: V3): [number, number] {
    if (!this.grid) this.buildGrid();
    const g = this.grid!;
    let best = 0;
    let bestD = Infinity;
    for (let q = 0; q < g.length; q += 3) {
      const x = g[q]! - p[0];
      const y = g[q + 1]! - p[1];
      const z = g[q + 2]! - p[2];
      const d = x * x + y * y + z * z;
      if (d < bestD) {
        bestD = d;
        best = q / 3;
      }
    }
    const i = Math.floor(best / this.gv);
    const j = best % this.gv;
    return [this.u0 + ((this.u1 - this.u0) * i) / (this.gu - 1), this.v0 + ((this.v1 - this.v0) * j) / (this.gv - 1)];
  }
  project(p: V3, hint?: readonly [number, number] | null): [number, number] {
    let res: [number, number, number] | null = null;
    if (hint) res = this.refineUV(p, hint[0], hint[1]);
    if (!res || res[2] > this.projTol) {
      const g = this.gridGuess(p);
      const r2 = this.refineUV(p, g[0], g[1]);
      if (!res || r2[2] < res[2]) res = r2;
    }
    return this.canon(res[0], res[1]);
  }
}

function distinctCount(U: Float64Array, p: number, n: number): number {
  let c = 0;
  let last = NaN;
  for (let i = p; i <= n + 1; i++) {
    if (U[i] !== last) c++;
    last = U[i]!;
  }
  return c;
}

/** 바탕 곡면을 법선 방향으로 띄운 곡면 */
export class OffsetSurface extends Surface {
  readonly kind = 'offset';
  constructor(
    readonly base: Surface,
    readonly d: number,
  ) {
    super();
    this.periodU = base.periodU;
    this.periodV = base.periodV;
    this.u0 = base.u0;
    this.u1 = base.u1;
    this.v0 = base.v0;
    this.v1 = base.v1;
    this.poles = base.poles;
    this.planar = base.planar;
    this.maxStepU = base.maxStepU;
    this.maxStepV = base.maxStepV;
  }
  point(u: number, v: number): V3 {
    return addScaled(this.base.point(u, v), this.base.normal(u, v), this.d);
  }
  override normal(u: number, v: number): V3 {
    return this.base.normal(u, v);
  }
  project(p: V3, hint?: readonly [number, number] | null): [number, number] {
    this.base.projTol = this.projTol;
    return this.base.project(p, hint);
  }
}
