/**
 * B-스플라인·NURBS 계산(교과서 식: 매듭 구간 찾기, Cox–de Boor 기저와 도함수, 동차 좌표 유리 곡선·곡면).
 */
import type { V3 } from './math';

/** 매듭 배수·값에서 전체 매듭 벡터를 만든다. 개수가 맞지 않으면 양 끝을 늘이거나 줄여 맞춘다 */
export function expandKnots(mults: number[], knots: number[], degree: number, nCtrl: number): Float64Array {
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const m = Math.max(0, Math.round(mults[i] ?? 1));
    for (let k = 0; k < m; k++) out.push(knots[i]!);
  }
  const need = nCtrl + degree + 1;
  while (out.length < need && out.length > 0) {
    // 끝 매듭이 하나 모자란 파일(clamped인데 배수 p): 양 끝을 번갈아 늘인다
    if (out.length % 2 === 0) out.push(out[out.length - 1]!);
    else out.unshift(out[0]!);
  }
  while (out.length > need) {
    if (out.length % 2 === 0) out.pop();
    else out.shift();
  }
  return Float64Array.from(out);
}

/** 균일 매듭(UNIFORM_*): -p … n */
export function uniformKnots(degree: number, nCtrl: number): Float64Array {
  const k = new Float64Array(nCtrl + degree + 1);
  for (let i = 0; i < k.length; i++) k[i] = i - degree;
  return k;
}

/** 준균일 매듭(QUASI_UNIFORM_*): 양 끝 p+1겹, 안은 균일 */
export function quasiUniformKnots(degree: number, nCtrl: number): Float64Array {
  const k = new Float64Array(nCtrl + degree + 1);
  const inner = nCtrl - degree;
  for (let i = 0; i < k.length; i++) k[i] = Math.min(Math.max(i - degree, 0), inner);
  return k;
}

/** 조각 베지어 매듭(BEZIER_*): 끝 p+1겹, 안쪽 p겹 */
export function bezierKnots(degree: number, nCtrl: number): Float64Array {
  const k: number[] = [];
  const segs = Math.max(1, Math.round((nCtrl - 1) / Math.max(1, degree)));
  for (let i = 0; i <= degree; i++) k.push(0);
  for (let s = 1; s < segs; s++) for (let i = 0; i < degree; i++) k.push(s);
  for (let i = 0; i <= degree; i++) k.push(segs);
  return expandKnots(
    k.map(() => 1),
    k,
    degree,
    nCtrl,
  );
}

/** 한 방향 기저 함수 계산기 */
export class Basis {
  readonly p: number;
  readonly U: Float64Array;
  /** 조절점 수 - 1 */
  readonly n: number;
  readonly lo: number;
  readonly hi: number;
  private left: Float64Array;
  private right: Float64Array;
  private ndu: Float64Array;
  private a: Float64Array;
  /** ders[k*(p+1)+j]: k차 도함수, j번째 기저 */
  readonly ders: Float64Array;

  constructor(degree: number, knots: Float64Array) {
    this.p = Math.max(1, degree);
    this.U = knots;
    this.n = knots.length - this.p - 2;
    this.lo = knots[this.p]!;
    this.hi = knots[this.n + 1]!;
    const p1 = this.p + 1;
    this.left = new Float64Array(p1);
    this.right = new Float64Array(p1);
    this.ndu = new Float64Array(p1 * p1);
    this.a = new Float64Array(2 * p1);
    this.ders = new Float64Array(3 * p1);
  }

  /** 매듭 구간 번호(U[s] ≤ u < U[s+1], 끝은 마지막 유효 구간) */
  span(u: number): number {
    const U = this.U;
    const n = this.n;
    const p = this.p;
    if (Number.isNaN(u)) return p;
    if (u >= U[n + 1]!) {
      let s = n;
      while (s > p && U[s]! >= U[s + 1]!) s--;
      return s;
    }
    if (u <= U[p]!) {
      let s = p;
      while (s < n && U[s]! >= U[s + 1]!) s++;
      return s;
    }
    let low = p;
    let high = n + 1;
    let mid = (low + high) >> 1;
    while (u < U[mid]! || u >= U[mid + 1]!) {
      if (u < U[mid]!) high = mid;
      else low = mid;
      mid = (low + high) >> 1;
    }
    return mid;
  }

  /** 구간 s에서 기저 함수와 nd차까지 도함수를 ders에 채운다 */
  eval(s: number, u: number, nd: number): void {
    const p = this.p;
    const p1 = p + 1;
    const U = this.U;
    const left = this.left;
    const right = this.right;
    const ndu = this.ndu;
    ndu[0] = 1;
    for (let j = 1; j <= p; j++) {
      left[j] = u - U[s + 1 - j]!;
      right[j] = U[s + j]! - u;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        // 아래 삼각: 매듭 차이, 위 삼각: 기저 값
        const den = right[r + 1]! + left[j - r]!;
        ndu[j * p1 + r] = den;
        const temp = den !== 0 ? ndu[r * p1 + j - 1]! / den : 0;
        ndu[r * p1 + j] = saved + right[r + 1]! * temp;
        saved = left[j - r]! * temp;
      }
      ndu[j * p1 + j] = saved;
    }
    const ders = this.ders;
    for (let j = 0; j <= p; j++) ders[j] = ndu[j * p1 + p]!;
    if (nd <= 0) return;
    nd = Math.min(nd, 2, p);
    const a = this.a;
    for (let r = 0; r <= p; r++) {
      let s1 = 0;
      let s2 = 1;
      a[0] = 1;
      for (let k = 1; k <= nd; k++) {
        let d = 0;
        const rk = r - k;
        const pk = p - k;
        if (r >= k) {
          const den = ndu[(pk + 1) * p1 + rk]!;
          a[s2 * p1] = den !== 0 ? a[s1 * p1]! / den : 0;
          d = a[s2 * p1]! * ndu[rk * p1 + pk]!;
        }
        const j1 = rk >= -1 ? 1 : -rk;
        const j2 = r - 1 <= pk ? k - 1 : p - r;
        for (let j = j1; j <= j2; j++) {
          const den = ndu[(pk + 1) * p1 + rk + j]!;
          a[s2 * p1 + j] = den !== 0 ? (a[s1 * p1 + j]! - a[s1 * p1 + j - 1]!) / den : 0;
          d += a[s2 * p1 + j]! * ndu[(rk + j) * p1 + pk]!;
        }
        if (r <= pk) {
          const den = ndu[(pk + 1) * p1 + r]!;
          a[s2 * p1 + k] = den !== 0 ? -a[s1 * p1 + k - 1]! / den : 0;
          d += a[s2 * p1 + k]! * ndu[r * p1 + pk]!;
        }
        ders[k * p1 + r] = d;
        const t = s1;
        s1 = s2;
        s2 = t;
      }
    }
    let f = p;
    for (let k = 1; k <= nd; k++) {
      for (let j = 0; j <= p; j++) ders[k * p1 + j] = ders[k * p1 + j]! * f;
      f *= p - k;
    }
  }
}

/** NURBS 곡선(동차 조절점 xw,yw,zw,w) */
export class NurbsCurve {
  readonly basis: Basis;
  /** 동차 조절점 4개씩 */
  readonly cw: Float64Array;
  readonly rational: boolean;
  readonly t0: number;
  readonly t1: number;

  constructor(degree: number, knots: Float64Array, ctrl: V3[], weights: number[] | null) {
    this.basis = new Basis(degree, knots);
    const n = ctrl.length;
    this.cw = new Float64Array(n * 4);
    this.rational = !!weights && weights.some((w) => Math.abs(w - 1) > 1e-12);
    for (let i = 0; i < n; i++) {
      const w = weights ? (weights[i] ?? 1) : 1;
      const c = ctrl[i]!;
      this.cw[i * 4] = c[0] * w;
      this.cw[i * 4 + 1] = c[1] * w;
      this.cw[i * 4 + 2] = c[2] * w;
      this.cw[i * 4 + 3] = w;
    }
    this.t0 = this.basis.lo;
    this.t1 = this.basis.hi;
  }

  /** 점과 nd차(≤2) 도함수: out[0]=점, out[1]=1차, out[2]=2차 */
  evalDerivs(t: number, nd: number): V3[] {
    const b = this.basis;
    const p = b.p;
    const p1 = p + 1;
    t = Math.min(Math.max(t, this.t0), this.t1);
    const s = b.span(t);
    b.eval(s, t, nd);
    const D = b.ders;
    const cw = this.cw;
    const A: number[][] = [];
    for (let k = 0; k <= nd; k++) {
      let x = 0, y = 0, z = 0, w = 0;
      if (k <= p) {
        for (let j = 0; j <= p; j++) {
          const N = D[k * p1 + j]!;
          if (N === 0) continue;
          const q = (s - p + j) * 4;
          x += N * cw[q]!;
          y += N * cw[q + 1]!;
          z += N * cw[q + 2]!;
          w += N * cw[q + 3]!;
        }
      }
      A.push([x, y, z, w]);
    }
    const w0 = A[0]![3]! || 1;
    const C0: V3 = [A[0]![0]! / w0, A[0]![1]! / w0, A[0]![2]! / w0];
    const out: V3[] = [C0];
    if (nd >= 1) {
      const w1 = A[1]![3]!;
      const C1: V3 = [(A[1]![0]! - w1 * C0[0]) / w0, (A[1]![1]! - w1 * C0[1]) / w0, (A[1]![2]! - w1 * C0[2]) / w0];
      out.push(C1);
      if (nd >= 2) {
        const w2 = A[2]![3]!;
        out.push([
          (A[2]![0]! - 2 * w1 * C1[0] - w2 * C0[0]) / w0,
          (A[2]![1]! - 2 * w1 * C1[1] - w2 * C0[1]) / w0,
          (A[2]![2]! - 2 * w1 * C1[2] - w2 * C0[2]) / w0,
        ]);
      }
    }
    return out;
  }

  point(t: number): V3 {
    return this.evalDerivs(t, 0)[0]!;
  }

  /** 서로 다른 매듭 값(구간 안) */
  breakpoints(): number[] {
    const U = this.basis.U;
    const out: number[] = [];
    for (let i = this.basis.p; i <= this.basis.n + 1; i++) {
      const u = U[i]!;
      if (!out.length || u > out[out.length - 1]!) out.push(u);
    }
    return out;
  }
}

/** NURBS 곡면. 조절점 [i][j]: i는 u 방향, j는 v 방향 */
export class NurbsSurface {
  readonly bu: Basis;
  readonly bv: Basis;
  readonly nu: number;
  readonly nv: number;
  readonly cw: Float64Array;
  readonly rational: boolean;
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  private tmp: Float64Array;

  constructor(du: number, dv: number, ku: Float64Array, kv: Float64Array, ctrl: V3[][], weights: number[][] | null) {
    this.bu = new Basis(du, ku);
    this.bv = new Basis(dv, kv);
    this.nu = ctrl.length;
    this.nv = ctrl[0]?.length ?? 0;
    this.cw = new Float64Array(this.nu * this.nv * 4);
    let rational = false;
    for (let i = 0; i < this.nu; i++)
      for (let j = 0; j < this.nv; j++) {
        const w = weights ? (weights[i]?.[j] ?? 1) : 1;
        if (Math.abs(w - 1) > 1e-12) rational = true;
        const c = ctrl[i]![j] ?? [0, 0, 0];
        const q = (i * this.nv + j) * 4;
        this.cw[q] = c[0] * w;
        this.cw[q + 1] = c[1] * w;
        this.cw[q + 2] = c[2] * w;
        this.cw[q + 3] = w;
      }
    this.rational = rational;
    this.u0 = this.bu.lo;
    this.u1 = this.bu.hi;
    this.v0 = this.bv.lo;
    this.v1 = this.bv.hi;
    this.tmp = new Float64Array(12);
  }

  /** 점(와 1차 편도함수): out = [S, Su, Sv] */
  eval(u: number, v: number, derivs: boolean): V3[] {
    u = Math.min(Math.max(u, this.u0), this.u1);
    v = Math.min(Math.max(v, this.v0), this.v1);
    const bu = this.bu;
    const bv = this.bv;
    const p = bu.p;
    const q = bv.p;
    const su = bu.span(u);
    const sv = bv.span(v);
    const nd = derivs ? 1 : 0;
    bu.eval(su, u, nd);
    bv.eval(sv, v, nd);
    const Nu = bu.ders;
    const Nv = bv.ders;
    const cw = this.cw;
    const nv = this.nv;
    const t = this.tmp.fill(0);
    // t[0..3]=A, t[4..7]=A_u, t[8..11]=A_v
    for (let a = 0; a <= p; a++) {
      const iu = su - p + a;
      const n0 = Nu[a]!;
      const n1 = derivs ? Nu[p + 1 + a]! : 0;
      for (let b = 0; b <= q; b++) {
        const m0 = Nv[b]!;
        const idx = (iu * nv + sv - q + b) * 4;
        const x = cw[idx]!, y = cw[idx + 1]!, z = cw[idx + 2]!, w = cw[idx + 3]!;
        const f = n0 * m0;
        t[0] += f * x;
        t[1] += f * y;
        t[2] += f * z;
        t[3] += f * w;
        if (derivs) {
          const fu = n1 * m0;
          const fv = n0 * Nv[q + 1 + b]!;
          t[4] += fu * x;
          t[5] += fu * y;
          t[6] += fu * z;
          t[7] += fu * w;
          t[8] += fv * x;
          t[9] += fv * y;
          t[10] += fv * z;
          t[11] += fv * w;
        }
      }
    }
    const w0 = t[3]! || 1;
    const S: V3 = [t[0]! / w0, t[1]! / w0, t[2]! / w0];
    if (!derivs) return [S];
    const wu = t[7]!;
    const wv = t[11]!;
    return [
      S,
      [(t[4]! - wu * S[0]) / w0, (t[5]! - wu * S[1]) / w0, (t[6]! - wu * S[2]) / w0],
      [(t[8]! - wv * S[0]) / w0, (t[9]! - wv * S[1]) / w0, (t[10]! - wv * S[2]) / w0],
    ];
  }

  /** 조절점(직교 좌표) */
  ctrl(i: number, j: number): V3 {
    const q = (i * this.nv + j) * 4;
    const w = this.cw[q + 3]! || 1;
    return [this.cw[q]! / w, this.cw[q + 1]! / w, this.cw[q + 2]! / w];
  }
}
