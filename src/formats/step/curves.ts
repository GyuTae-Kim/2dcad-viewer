/**
 * 3D 곡선(ISO 10303-42 매개변수화): 점·도함수·가장 가까운 매개변수·허용 오차에 맞춘 나눔.
 * 2D 곡선(PCURVE 안)은 z=0인 3D 곡선으로 다룬다.
 */
import { add, addScaled, cross, dist, dot, type Frame, framePoint, len, lerp, scale, sub, type V3 } from './math';
import { NurbsCurve } from './nurbs';

/** 나눔 허용 오차: 현 높이(모형 단위)와 이웃 접선 사이 최대 각(라디안) */
export interface Tol {
  chord: number;
  angle: number;
}

const TWO_PI = Math.PI * 2;

export abstract class Curve {
  /** 매개변수 구간(무한일 수 있다) */
  t0 = -Infinity;
  t1 = Infinity;
  /** 닫힌 주기 곡선의 주기(아니면 0) */
  period = 0;
  /** 곧은 선이면 true(가운데 점이 필요 없다) */
  linear = false;

  abstract point(t: number): V3;
  /** 1차 도함수(기본: 중심 차분) */
  d1(t: number): V3 {
    const h = this.fdStep(t);
    return scale(sub(this.point(t + h), this.point(t - h)), 1 / (2 * h));
  }
  protected fdStep(t: number): number {
    const span = Number.isFinite(this.t1 - this.t0) ? this.t1 - this.t0 : 1;
    return Math.max(1e-9, Math.abs(t) * 1e-9, span * 1e-7);
  }

  /** 주기 곡선이면 t를 [t0, t0+주기)로 */
  wrap(t: number): number {
    if (this.period > 0) {
      const r = (t - this.t0) % this.period;
      return this.t0 + (r < 0 ? r + this.period : r);
    }
    return t;
  }

  /** 초기 추정용 표본 매개변수 */
  protected seeds(): number[] {
    const a = Number.isFinite(this.t0) ? this.t0 : -1;
    const b = Number.isFinite(this.t1) ? this.t1 : 1;
    const out: number[] = [];
    const n = 32;
    for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
    return out;
  }

  /** p에 가장 가까운 곡선 매개변수(가우스-뉴턴 다듬기) */
  project(p: V3, hint?: number): number {
    let best = hint ?? NaN;
    let bestD = Number.isNaN(best) ? Infinity : dist(this.point(best), p);
    if (Number.isNaN(best) || bestD > 0) {
      for (const t of this.seeds()) {
        const d = dist(this.point(t), p);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
    }
    return this.refine(p, best);
  }

  protected refine(p: V3, t: number): number {
    let d = dist(this.point(t), p);
    for (let it = 0; it < 30; it++) {
      const c = this.point(t);
      const dc = this.d1(t);
      const l2 = dot(dc, dc);
      if (!(l2 > 0)) break;
      let step = dot(dc, sub(p, c)) / l2;
      let nt = t;
      let nd = d;
      for (let k = 0; k < 6; k++) {
        nt = this.clampT(t + step);
        nd = dist(this.point(nt), p);
        if (nd <= d) break;
        step *= 0.5;
      }
      if (nd > d) break;
      const moved = Math.abs(nt - t);
      t = nt;
      d = nd;
      if (moved < 1e-14 * (1 + Math.abs(t))) break;
    }
    return this.wrap(t);
  }

  protected clampT(t: number): number {
    if (this.period > 0) return t;
    return Math.min(Math.max(t, this.t0), this.t1);
  }

  /** ta→tb 사이 안쪽 매개변수를 차례로 out에 넣는다(끝점 제외) */
  sample(ta: number, tb: number, tol: Tol, out: number[]): void {
    adaptive(this, ta, tb, tol, this.breaks(ta, tb), out);
  }

  /** 적응 나눔의 처음 경계(구간 안쪽) */
  protected breaks(ta: number, tb: number): number[] {
    const n = 4;
    const out: number[] = [];
    for (let i = 1; i < n; i++) out.push(ta + ((tb - ta) * i) / n);
    return out;
  }
}

/** 적응 나눔: 중간점이 현에서 벗어나거나 접선이 많이 꺾이면 반으로 나눈다 */
export function adaptive(c: Curve, ta: number, tb: number, tol: Tol, seeds: number[], out: number[]): void {
  const ts = [ta, ...seeds, tb];
  let pa = c.point(ta);
  let da = c.d1(ta);
  const cosLim = Math.cos(tol.angle);
  const rec = (a: number, Pa: V3, Da: V3, b: number, Pb: V3, Db: V3, depth: number) => {
    const m = (a + b) / 2;
    const Pm = c.point(m);
    const chord = sub(Pb, Pa);
    const cl = len(chord);
    let dev: number;
    if (cl > 0) {
      const w = sub(Pm, Pa);
      dev = len(cross(w, chord)) / cl;
    } else dev = dist(Pm, Pa);
    const la = len(Da);
    const lb = len(Db);
    const bend = la > 0 && lb > 0 ? dot(Da, Db) / (la * lb) < cosLim : false;
    if (depth < 16 && (dev > tol.chord || (bend && cl > tol.chord * 0.05))) {
      const Dm = c.d1(m);
      rec(a, Pa, Da, m, Pm, Dm, depth + 1);
      out.push(m);
      rec(m, Pm, Dm, b, Pb, Db, depth + 1);
    }
  };
  for (let i = 1; i < ts.length; i++) {
    const b = ts[i]!;
    const pb = c.point(b);
    const db = c.d1(b);
    rec(ts[i - 1]!, pa, da, b, pb, db, 0);
    if (i < ts.length - 1) out.push(b);
    pa = pb;
    da = db;
  }
}

export class LineCurve extends Curve {
  override linear = true;
  constructor(
    readonly o: V3,
    readonly d: V3,
  ) {
    super();
  }
  point(t: number): V3 {
    return addScaled(this.o, this.d, t);
  }
  override d1(): V3 {
    return this.d;
  }
  override project(p: V3): number {
    const l2 = dot(this.d, this.d);
    return l2 > 0 ? dot(sub(p, this.o), this.d) / l2 : 0;
  }
  override sample(): void {}
}

export class CircleCurve extends Curve {
  constructor(
    readonly f: Frame,
    readonly r: number,
  ) {
    super();
    this.t0 = 0;
    this.t1 = TWO_PI;
    this.period = TWO_PI;
  }
  point(t: number): V3 {
    return framePoint(this.f, this.r * Math.cos(t), this.r * Math.sin(t), 0);
  }
  override d1(t: number): V3 {
    return framePoint({ o: [0, 0, 0], x: this.f.x, y: this.f.y, z: this.f.z }, -this.r * Math.sin(t), this.r * Math.cos(t), 0);
  }
  override project(p: V3): number {
    const d = sub(p, this.f.o);
    const a = Math.atan2(dot(d, this.f.y), dot(d, this.f.x));
    return a < 0 ? a + TWO_PI : a;
  }
  override sample(ta: number, tb: number, tol: Tol, out: number[]): void {
    const n = arcSegments(this.r, Math.abs(tb - ta), tol);
    for (let i = 1; i < n; i++) out.push(ta + ((tb - ta) * i) / n);
  }
}

/** 반지름 r 호(중심각 sweep)를 나눌 토막 수 */
export function arcSegments(r: number, sweep: number, tol: Tol): number {
  let step = tol.angle;
  if (r > tol.chord) step = Math.min(step, 2 * Math.acos(1 - tol.chord / r));
  return Math.max(1, Math.min(4096, Math.ceil(sweep / Math.max(step, 1e-4) - 1e-9)));
}

export class EllipseCurve extends Curve {
  constructor(
    readonly f: Frame,
    readonly a: number,
    readonly b: number,
  ) {
    super();
    this.t0 = 0;
    this.t1 = TWO_PI;
    this.period = TWO_PI;
  }
  point(t: number): V3 {
    return framePoint(this.f, this.a * Math.cos(t), this.b * Math.sin(t), 0);
  }
  override d1(t: number): V3 {
    return add(scale(this.f.x, -this.a * Math.sin(t)), scale(this.f.y, this.b * Math.cos(t)));
  }
  override project(p: V3): number {
    const d = sub(p, this.f.o);
    const t = Math.atan2(dot(d, this.f.y) / (this.b || 1), dot(d, this.f.x) / (this.a || 1));
    return this.refine(p, t < 0 ? t + TWO_PI : t);
  }
  protected override breaks(ta: number, tb: number): number[] {
    const n = Math.max(2, Math.ceil(Math.abs(tb - ta) / (Math.PI / 4)));
    const out: number[] = [];
    for (let i = 1; i < n; i++) out.push(ta + ((tb - ta) * i) / n);
    return out;
  }
}

export class ParabolaCurve extends Curve {
  constructor(
    readonly f: Frame,
    readonly focal: number,
  ) {
    super();
  }
  point(t: number): V3 {
    return framePoint(this.f, this.focal * t * t, 2 * this.focal * t, 0);
  }
  override project(p: V3, hint?: number): number {
    const t = hint ?? dot(sub(p, this.f.o), this.f.y) / (2 * this.focal || 1);
    return this.refine(p, t);
  }
}

export class HyperbolaCurve extends Curve {
  constructor(
    readonly f: Frame,
    readonly a: number,
    readonly b: number,
  ) {
    super();
  }
  point(t: number): V3 {
    return framePoint(this.f, this.a * Math.cosh(t), this.b * Math.sinh(t), 0);
  }
  override project(p: V3, hint?: number): number {
    const t = hint ?? Math.asinh(dot(sub(p, this.f.o), this.f.y) / (this.b || 1));
    return this.refine(p, t);
  }
}

export class PolylineCurve extends Curve {
  override linear = false;
  constructor(readonly pts: V3[]) {
    super();
    this.t0 = 0;
    this.t1 = Math.max(0, pts.length - 1);
  }
  point(t: number): V3 {
    const n = this.pts.length;
    if (n === 0) return [0, 0, 0];
    if (n === 1) return this.pts[0]!;
    const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
    return lerp(this.pts[i]!, this.pts[i + 1]!, t - i);
  }
  override d1(t: number): V3 {
    const n = this.pts.length;
    if (n < 2) return [0, 0, 0];
    const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
    return sub(this.pts[i + 1]!, this.pts[i]!);
  }
  override project(p: V3): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i + 1 < this.pts.length; i++) {
      const a = this.pts[i]!;
      const d = sub(this.pts[i + 1]!, a);
      const l2 = dot(d, d);
      const s = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), d) / l2)) : 0;
      const q = addScaled(a, d, s);
      const dd = dist(q, p);
      if (dd < bestD) {
        bestD = dd;
        best = i + s;
      }
    }
    return best;
  }
  override sample(ta: number, tb: number, _tol: Tol, out: number[]): void {
    if (tb > ta) for (let k = Math.floor(ta) + 1; k < tb; k++) out.push(k);
    else for (let k = Math.ceil(ta) - 1; k > tb; k--) out.push(k);
  }
}

export class BSplineCurve extends Curve {
  readonly bp: number[];
  private seedCache: number[] | null = null;
  constructor(readonly nc: NurbsCurve) {
    super();
    this.t0 = nc.t0;
    this.t1 = nc.t1;
    this.bp = nc.breakpoints();
    // 닫힌 곡선(시작점 = 끝점)은 주기로 다룬다
    const a = nc.point(this.t0);
    const b = nc.point(this.t1);
    const size = this.size();
    if (dist(a, b) <= Math.max(1e-9, size * 1e-9)) this.period = this.t1 - this.t0;
    // 조절점이 한 직선 위면 곧은 선(B-스플라인으로 쓴 직선 모서리)
    if (!this.period && collinear(nc, size)) this.linear = true;
  }
  private size(): number {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    const cw = this.nc.cw;
    for (let i = 0; i < cw.length; i += 4) {
      const w = cw[i + 3]! || 1;
      for (let k = 0; k < 3; k++) {
        const v = cw[i + k]! / w;
        mn[k] = Math.min(mn[k]!, v);
        mx[k] = Math.max(mx[k]!, v);
      }
    }
    return Math.hypot(mx[0]! - mn[0]!, mx[1]! - mn[1]!, mx[2]! - mn[2]!);
  }
  point(t: number): V3 {
    return this.nc.point(this.wrap(t));
  }
  override d1(t: number): V3 {
    return this.nc.evalDerivs(this.wrap(t), 1)[1]!;
  }
  protected override seeds(): number[] {
    if (this.seedCache) return this.seedCache;
    const out: number[] = [];
    const per = Math.max(2, Math.min(8, this.nc.basis.p * 2));
    for (let i = 0; i + 1 < this.bp.length; i++) {
      const a = this.bp[i]!;
      const b = this.bp[i + 1]!;
      for (let k = 0; k < per; k++) out.push(a + ((b - a) * k) / per);
    }
    out.push(this.t1);
    return (this.seedCache = out);
  }
  protected override breaks(ta: number, tb: number): number[] {
    const out: number[] = [];
    const lo = Math.min(ta, tb);
    const hi = Math.max(ta, tb);
    const P = this.period;
    const shifts = P > 0 ? [-P, 0, P, 2 * P] : [0];
    const per = Math.max(1, Math.min(4, this.nc.basis.p));
    const bps: number[] = [];
    for (const s of shifts) for (const k of this.bp) bps.push(k + s);
    bps.sort((x, y) => x - y);
    for (let i = 0; i + 1 < bps.length; i++) {
      const a = bps[i]!;
      const b = bps[i + 1]!;
      if (b <= a) continue;
      for (let k = 0; k < per; k++) {
        const t = a + ((b - a) * k) / per;
        if (t > lo + 1e-12 * (hi - lo + 1) && t < hi - 1e-12 * (hi - lo + 1)) out.push(t);
      }
    }
    const uniq = [...new Set(out)].sort((x, y) => x - y);
    return tb >= ta ? uniq : uniq.reverse();
  }
}

function collinear(nc: NurbsCurve, size: number): boolean {
  const cw = nc.cw;
  const n = cw.length / 4;
  if (n < 2) return false;
  const P = (i: number): V3 => {
    const w = cw[i * 4 + 3]! || 1;
    return [cw[i * 4]! / w, cw[i * 4 + 1]! / w, cw[i * 4 + 2]! / w];
  };
  const a = P(0);
  const b = P(n - 1);
  const d = sub(b, a);
  const l = len(d);
  if (!(l > 0)) return false;
  const eps = Math.max(1e-12, size * 1e-9);
  for (let i = 1; i < n - 1; i++) {
    const q = sub(P(i), a);
    if (len(cross(q, d)) / l > eps) return false;
    // 끝점 밖으로 되돌아가지 않아야 한다
    const t = dot(q, d) / (l * l);
    if (t < -1e-9 || t > 1 + 1e-9) return false;
  }
  return true;
}

/** 2D 곡선을 곡면 위에 올린 곡선(PCURVE) */
export class SurfaceMappedCurve extends Curve {
  constructor(
    readonly c2: Curve,
    readonly surf: { point(u: number, v: number): V3 },
  ) {
    super();
    this.t0 = c2.t0;
    this.t1 = c2.t1;
    this.period = c2.period;
  }
  point(t: number): V3 {
    const q = this.c2.point(t);
    return this.surf.point(q[0], q[1]);
  }
  protected override seeds(): number[] {
    const a = Number.isFinite(this.t0) ? this.t0 : -1;
    const b = Number.isFinite(this.t1) ? this.t1 : 1;
    const out: number[] = [];
    for (let i = 0; i <= 64; i++) out.push(a + ((b - a) * i) / 64);
    return out;
  }
  protected override breaks(ta: number, tb: number): number[] {
    const out: number[] = [];
    for (let i = 1; i < 8; i++) out.push(ta + ((tb - ta) * i) / 8);
    return out;
  }
}

/** 매개변수 구간을 [0,1]로 다시 매긴 곡선 조각(잘린 곡선·복합 곡선 토막) */
export class TrimmedCurve extends Curve {
  constructor(
    readonly basis: Curve,
    readonly ta: number,
    readonly tb: number,
  ) {
    super();
    this.t0 = 0;
    this.t1 = 1;
    this.linear = basis.linear;
  }
  point(s: number): V3 {
    return this.basis.point(this.ta + (this.tb - this.ta) * s);
  }
  override d1(s: number): V3 {
    return scale(this.basis.d1(this.ta + (this.tb - this.ta) * s), this.tb - this.ta);
  }
  override sample(sa: number, sb: number, tol: Tol, out: number[]): void {
    const tmp: number[] = [];
    const k = this.tb - this.ta;
    if (k === 0) return;
    this.basis.sample(this.ta + k * sa, this.ta + k * sb, tol, tmp);
    for (const t of tmp) out.push((t - this.ta) / k);
  }
  override project(p: V3, hint?: number): number {
    const k = this.tb - this.ta;
    if (k === 0) return 0;
    const t = this.basis.project(p, hint === undefined ? undefined : this.ta + k * hint);
    let s = (t - this.ta) / k;
    if (this.basis.period > 0) {
      // 주기 곡선: [0,1]에 가장 가까운 대표값
      const P = this.basis.period / Math.abs(k);
      s -= Math.floor(s / P) * P;
      if (s > 1 && P - s < s - 1) s -= P;
    }
    return s;
  }
}

/** 복합 곡선: 토막 k가 매개변수 [k, k+1] */
export class CompositeCurve extends Curve {
  constructor(readonly segs: Curve[]) {
    super();
    this.t0 = 0;
    this.t1 = segs.length;
    if (segs.length && dist(segs[0]!.point(0), segs[segs.length - 1]!.point(1)) < 1e-9) this.period = segs.length;
  }
  private at(t: number): [Curve, number] {
    const n = this.segs.length;
    const k = Math.min(n - 1, Math.max(0, Math.floor(t)));
    return [this.segs[k]!, t - k];
  }
  point(t: number): V3 {
    const [c, s] = this.at(this.period > 0 && t > this.t1 ? t - this.period : t);
    return c.point(s);
  }
  override d1(t: number): V3 {
    const [c, s] = this.at(this.period > 0 && t > this.t1 ? t - this.period : t);
    return c.d1(s);
  }
  override project(p: V3): number {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < this.segs.length; k++) {
      const s = Math.min(1, Math.max(0, this.segs[k]!.project(p)));
      const d = dist(this.segs[k]!.point(s), p);
      if (d < bestD) {
        bestD = d;
        best = k + s;
      }
    }
    return best;
  }
  override sample(ta: number, tb: number, tol: Tol, out: number[]): void {
    const dir = tb >= ta ? 1 : -1;
    const lo = Math.min(ta, tb);
    const hi = Math.max(ta, tb);
    const ks: number[] = [];
    for (let k = Math.floor(lo); k < Math.ceil(hi); k++) ks.push(k);
    if (dir < 0) ks.reverse();
    for (const k of ks) {
      const a = Math.max(lo, k) - k;
      const b = Math.min(hi, k + 1) - k;
      const tmp: number[] = [];
      const seg = this.segs[((k % this.segs.length) + this.segs.length) % this.segs.length]!;
      if (dir > 0) seg.sample(a, b, tol, tmp);
      else seg.sample(b, a, tol, tmp);
      for (const s of tmp) out.push(k + s);
      const end = dir > 0 ? k + 1 : k;
      if (end > lo && end < hi) out.push(end);
    }
  }
}

/** 3D 꺾은선 길이 */
export function polylineLength(pts: V3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1]!, pts[i]!);
  return s;
}
