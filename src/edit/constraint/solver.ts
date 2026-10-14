/**
 * 수치 풀이기: 잔차식 F(x) = 0을 가중 최소 변경 가우스-뉴턴(감쇠 포함)으로 푼다.
 *
 * 한 걸음: Δx = −W⁻¹Jᵀ(J W⁻¹ Jᵀ + μI)⁻¹ F  — 식을 만족하는 변화 가운데 가중 길이 ‖Δx‖_W가 가장 작은 것.
 * 가중치가 큰 변수(사용자가 방금 옮긴 점, 먼저 고른 객체)는 덜 움직인다. 잔차가 줄지 않으면 걸음을 줄이고 μ를 키운다.
 * 야코비안은 중심 차분(식마다 그 식이 기대는 변수만)이다.
 *
 * 과도한 구속 판정: 야코비안 행(열 척도를 맞춘 것)을 차례로 직교화해 앞 행들의 선형 결합이면 종속으로 본다.
 */
import type { Eq } from './equations';

type X = ArrayLike<number>;

export interface SolveOptions {
  /** 변수별 가중치(클수록 덜 움직인다, Infinity면 움직이지 않는다). 없으면 1 */
  weights?: ArrayLike<number>;
  /** 각도·비율 변수(척도 S로 길이처럼 다룬다) */
  ang: ArrayLike<boolean>;
  /** 길이 척도 */
  S: number;
  /** 잔차 공차(길이) */
  tol: number;
  maxIter?: number;
  /** 이 시각(performance.now 기준 ms)을 넘으면 멈춘다 */
  deadline?: number;
}

export interface SolveResult {
  x: number[];
  ok: boolean;
  /** 최대 잔차 */
  residual: number;
  iterations: number;
}

interface Row {
  idx: number[];
  val: number[];
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function evalF(eqs: readonly Eq[], x: X, out: Float64Array): void {
  for (let i = 0; i < eqs.length; i++) {
    const v = eqs[i]!.f(x);
    out[i] = Number.isFinite(v) ? v : 1e30;
  }
}

const maxAbs = (a: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
};

const norm2 = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return s;
};

/** 차분 간격 */
function stepOf(j: number, opt: Pick<SolveOptions, 'ang' | 'S'>): number {
  return opt.ang[j] ? 1e-6 : 1e-6 * opt.S;
}

/** 중심 차분 야코비안(행마다 그 식의 변수만) */
export function jacobian(eqs: readonly Eq[], x: number[], opt: Pick<SolveOptions, 'ang' | 'S'>): Row[] {
  const rows: Row[] = [];
  for (const e of eqs) {
    const idx: number[] = [];
    const val: number[] = [];
    for (const j of e.vars) {
      const h = stepOf(j, opt);
      const v = x[j]!;
      x[j] = v + h;
      const fp = e.f(x);
      x[j] = v - h;
      const fm = e.f(x);
      x[j] = v;
      const d = (fp - fm) / (2 * h);
      if (Number.isFinite(d) && d !== 0) {
        idx.push(j);
        val.push(d);
      }
    }
    rows.push({ idx, val });
  }
  return rows;
}

/** 촐레스키 분해(밀집, 제자리 — 아래 삼각). 양정치가 아니면 false */
function cholFactor(A: Float64Array, m: number): boolean {
  for (let j = 0; j < m; j++) {
    let d = A[j * m + j]!;
    for (let k = 0; k < j; k++) d -= A[j * m + k]! * A[j * m + k]!;
    if (!(d > 0)) return false;
    const l = Math.sqrt(d);
    A[j * m + j] = l;
    for (let i = j + 1; i < m; i++) {
      let s = A[i * m + j]!;
      for (let k = 0; k < j; k++) s -= A[i * m + k]! * A[j * m + k]!;
      A[i * m + j] = s / l;
    }
  }
  return true;
}

/** 분해한 L로 L Lᵀ y = b(b를 제자리에서 y로) */
function cholSolve(L: Float64Array, m: number, b: Float64Array): void {
  for (let i = 0; i < m; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * m + k]! * b[k]!;
    b[i] = s / L[i * m + i]!;
  }
  for (let i = m - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < m; k++) s -= L[k * m + i]! * b[k]!;
    b[i] = s / L[i * m + i]!;
  }
}

/** J W⁻¹ Jᵀ (밀집 m×m) */
function normalMatrix(rows: Row[], winv: Float64Array, n: number): Float64Array {
  const m = rows.length;
  const A = new Float64Array(m * m);
  // 변수마다 그 변수를 쓰는 행
  const cols: { r: number; v: number }[][] = Array.from({ length: n }, () => []);
  rows.forEach((row, r) => row.idx.forEach((j, k) => cols[j]!.push({ r, v: row.val[k]! })));
  for (let j = 0; j < n; j++) {
    const c = cols[j]!;
    const w = winv[j]!;
    for (let a = 0; a < c.length; a++) {
      const ra = c[a]!;
      for (let b = a; b < c.length; b++) {
        const rb = c[b]!;
        const v = ra.v * rb.v * w;
        A[ra.r * m + rb.r] += v;
        if (ra.r !== rb.r) A[rb.r * m + ra.r] += v;
      }
    }
  }
  return A;
}

/** 전처리 켤레 기울기법(행렬을 만들지 않고 J W⁻¹ Jᵀ + μI 곱) — 식이 많을 때 */
function cgSolve(rows: Row[], winv: Float64Array, n: number, mu: number, b: Float64Array, iters: number): Float64Array {
  const m = rows.length;
  const tmp = new Float64Array(n);
  const mul = (v: Float64Array, out: Float64Array) => {
    tmp.fill(0);
    rows.forEach((row, r) => row.idx.forEach((j, k) => (tmp[j] += row.val[k]! * v[r]!)));
    for (let j = 0; j < n; j++) tmp[j] *= winv[j]!;
    rows.forEach((row, r) => {
      let s = 0;
      row.idx.forEach((j, k) => (s += row.val[k]! * tmp[j]!));
      out[r] = s + mu * v[r]!;
    });
  };
  const diag = new Float64Array(m);
  rows.forEach((row, r) => {
    let s = mu;
    row.idx.forEach((j, k) => (s += row.val[k]! * row.val[k]! * winv[j]!));
    diag[r] = s > 0 ? s : 1;
  });
  const x = new Float64Array(m);
  const r = Float64Array.from(b);
  const z = new Float64Array(m);
  for (let i = 0; i < m; i++) z[i] = r[i]! / diag[i]!;
  const p = Float64Array.from(z);
  const Ap = new Float64Array(m);
  let rz = 0;
  for (let i = 0; i < m; i++) rz += r[i]! * z[i]!;
  const b2 = norm2(b);
  for (let it = 0; it < iters; it++) {
    mul(p, Ap);
    let pAp = 0;
    for (let i = 0; i < m; i++) pAp += p[i]! * Ap[i]!;
    if (!(pAp > 0)) break;
    const a = rz / pAp;
    for (let i = 0; i < m; i++) {
      x[i] += a * p[i]!;
      r[i] -= a * Ap[i]!;
    }
    if (norm2(r) <= 1e-24 * b2) break;
    for (let i = 0; i < m; i++) z[i] = r[i]! / diag[i]!;
    let rz2 = 0;
    for (let i = 0; i < m; i++) rz2 += r[i]! * z[i]!;
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < m; i++) p[i] = z[i]! + beta * p[i]!;
  }
  return x;
}

/**
 * 가중 최소 변경 풀기.
 * 걸음마다 두 후보를 본다: (1) 시작 값 x0을 지금 선형화한 구속 면에 투영한 점(시작 값에 가장 가까운 해로 끌어당긴다),
 * (2) 지금 값에서의 최소 변경 가우스-뉴턴 걸음. 걸음은 변수마다 척도의 절반으로 묶고 잔차가 줄 때까지 줄인다.
 * 잔차가 공차 안에 들면 투영 걸음으로 두 번 더 다듬는다(시작 값에 더 가깝게).
 */
export function solveEquations(eqs: readonly Eq[], x0: ArrayLike<number>, opt: SolveOptions): SolveResult {
  const n = x0.length;
  const m = eqs.length;
  const start = Array.from(x0);
  const x = Array.from(x0);
  const F = new Float64Array(m);
  evalF(eqs, x, F);
  let res = maxAbs(F);
  if (!m) return { x, ok: true, residual: res, iterations: 0 };
  const winv = new Float64Array(n);
  const wgt = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const w = opt.weights ? opt.weights[j]! : 1;
    const sc = opt.ang[j] ? opt.S * opt.S : 1;
    winv[j] = w === Infinity ? 0 : 1 / (Math.max(w, 1e-12) * sc);
    wgt[j] = w === Infinity ? 0 : Math.max(w, 1e-12) * sc;
  }
  const dist2 = (v: ArrayLike<number>) => {
    let d = 0;
    for (let j = 0; j < n; j++) {
      const e = v[j]! - start[j]!;
      d += wgt[j]! * e * e;
    }
    return d;
  };
  const cap = (j: number) => (opt.ang[j] ? 0.5 : 0.5 * opt.S);
  const maxIter = opt.maxIter ?? 80;
  const Fn = new Float64Array(m);
  let mu = 0;
  let it = 0;
  let polish = 0;
  for (; it < maxIter; it++) {
    if (opt.deadline !== undefined && now() > opt.deadline) break;
    const conv = res <= opt.tol;
    if (conv && polish >= 2) break;
    const rows = jacobian(eqs, x, opt);
    const f2 = norm2(F);
    const A0 = m <= 400 ? normalMatrix(rows, winv, n) : null;
    let tr = 0;
    if (A0) for (let i = 0; i < m; i++) tr += A0[i * m + i]!;
    else rows.forEach((row) => row.idx.forEach((j, k) => (tr += row.val[k]! * row.val[k]! * winv[j]!)));
    const base = tr / Math.max(1, m) || 1;
    if (mu === 0) mu = base * 1e-12;
    // 오른쪽 항: 투영 J(x − x0) − F, 가우스-뉴턴 −F
    const b1 = new Float64Array(m);
    rows.forEach((row, r) => {
      let s = 0;
      row.idx.forEach((j, k) => (s += row.val[k]! * (x[j]! - start[j]!)));
      b1[r] = s - F[r]!;
    });
    const b2 = Float64Array.from(F, (v) => -v);
    const d0 = dist2(x);
    let accepted = false;
    for (let tries = 0; tries < 10 && !accepted; tries++) {
      let y1: Float64Array | null = Float64Array.from(b1);
      let y2: Float64Array | null = Float64Array.from(b2);
      if (A0) {
        const A = Float64Array.from(A0);
        for (let i = 0; i < m; i++) A[i * m + i] += mu;
        if (cholFactor(A, m)) {
          cholSolve(A, m, y1);
          cholSolve(A, m, y2);
        } else y1 = y2 = null;
      } else {
        y1 = cgSolve(rows, winv, n, mu, y1, Math.min(4 * m, 2000));
        y2 = cgSolve(rows, winv, n, mu, y2, Math.min(4 * m, 2000));
      }
      if (!y1 || !y2) {
        mu = Math.max(mu * 100, base * 1e-10);
        continue;
      }
      const dir = (y: Float64Array, proj: boolean) => {
        const d = new Float64Array(n);
        rows.forEach((row, r) => row.idx.forEach((j, k) => (d[j] += winv[j]! * row.val[k]! * y[r]!)));
        if (proj) for (let j = 0; j < n; j++) d[j] = start[j]! + d[j]! - x[j]!;
        let k = 1;
        for (let j = 0; j < n; j++) if (Math.abs(d[j]!) * k > cap(j)) k = cap(j) / Math.abs(d[j]!);
        for (let j = 0; j < n; j++) d[j] *= k;
        return d;
      };
      for (const dx of conv ? [dir(y1, true)] : [dir(y1, true), dir(y2, false)]) {
        for (let alpha = 1; alpha >= 1 / 16 && !accepted; alpha /= 2) {
          const xn = x.map((v, j) => v + alpha * dx[j]!);
          evalF(eqs, xn, Fn);
          const ok = conv ? maxAbs(Fn) <= opt.tol && dist2(xn) < d0 * (1 - 1e-9) : norm2(Fn) < f2 * (1 - 1e-4 * alpha);
          if (ok) {
            for (let j = 0; j < n; j++) x[j] = xn[j]!;
            F.set(Fn);
            accepted = true;
          }
        }
        if (accepted) break;
      }
      if (accepted) mu = Math.max(mu / 10, base * 1e-14);
      else if (conv) break;
      else mu = Math.max(mu * 100, base * 1e-10);
    }
    res = maxAbs(F);
    if (conv) {
      if (!accepted) break;
      polish++;
      continue;
    }
    if (!accepted) break;
  }
  return { x, ok: res <= opt.tol, residual: res, iterations: it };
}

/**
 * 행 종속 판정용 직교 기저. 열 척도: 각도 변수는 1/S(길이 단위로 맞춘다).
 */
export class RowBasis {
  private readonly basis: Float64Array[] = [];
  constructor(
    private readonly n: number,
    private readonly ang: ArrayLike<boolean>,
    private readonly S: number,
    private readonly tol = 1e-6,
  ) {}

  private dense(row: Row): Float64Array {
    const v = new Float64Array(this.n);
    row.idx.forEach((j, k) => (v[j] = row.val[k]! / (this.ang[j] ? this.S : 1)));
    return v;
  }

  /** 행을 더해 보고 앞 행들과 독립이면 기저에 넣고 true */
  add(row: Row): boolean {
    const v = this.dense(row);
    const l0 = Math.sqrt(norm2(v));
    if (!(l0 > 0)) return false;
    for (let i = 0; i < v.length; i++) v[i] /= l0;
    // 두 번 직교화(수치 안정)
    for (let pass = 0; pass < 2; pass++)
      for (const b of this.basis) {
        let d = 0;
        for (let i = 0; i < v.length; i++) d += v[i]! * b[i]!;
        if (d) for (let i = 0; i < v.length; i++) v[i] -= d * b[i]!;
      }
    const l = Math.sqrt(norm2(v));
    if (l < this.tol) return false;
    for (let i = 0; i < v.length; i++) v[i] /= l;
    this.basis.push(v);
    return true;
  }

  /** 여러 행을 함께 시험: 모두 독립이어야 넣는다(하나라도 종속이면 아무것도 넣지 않고 false) */
  addAll(rows: Row[]): boolean {
    const saved = this.basis.length;
    for (const r of rows)
      if (!this.add(r)) {
        this.basis.length = saved;
        return false;
      }
    return true;
  }

  get rank(): number {
    return this.basis.length;
  }
}

export type { Row as JacobianRow };
