/**
 * NURBS 편집 도구: 점·도함수, 매듭 삽입(Boehm), 나누기·부분 곡선, 베지어 분해·차수 올리기·잇기,
 * 원호·타원호의 유리 2차 표현, 닫힌(주기) 3차 보간.
 * 조정점은 3D(Z 유지), 가중치가 없으면 모두 1이다.
 */
import type { Vec2, Vec3 } from '../../core/model';
import { clampedKnots } from '../../geom/curves';

export interface Nurbs {
  degree: number;
  knots: number[];
  ctrl: Vec3[];
  weights?: number[];
}

type H = [number, number, number, number];

const KEPS = 1e-12;

function homog(c: Nurbs): H[] {
  return c.ctrl.map((p, i) => {
    const w = c.weights ? (c.weights[i] ?? 1) : 1;
    return [p.x * w, p.y * w, p.z * w, w];
  });
}

function fromHomog(degree: number, knots: number[], Pw: H[], rational: boolean): Nurbs {
  const ctrl: Vec3[] = [];
  const weights: number[] = [];
  for (const h of Pw) {
    const w = h[3] || 1;
    ctrl.push({ x: h[0] / w, y: h[1] / w, z: h[2] / w });
    weights.push(h[3]);
  }
  const out: Nurbs = { degree, knots, ctrl };
  if (rational && weights.some((w) => Math.abs(w - 1) > 1e-12)) out.weights = weights;
  return out;
}

/** 매듭 개수가 맞지 않으면 균일 고정 매듭으로 고친다 */
export function normalizeNurbs(c: Nurbs): Nurbs {
  const n = c.ctrl.length;
  const p = Math.max(1, Math.min(c.degree, n - 1));
  let knots = c.knots;
  if (knots.length !== n + p + 1) knots = clampedKnots(n, p);
  let weights = c.weights;
  if (weights && (weights.length !== n || weights.every((w) => w === 1) || weights.some((w) => !(w > 0)))) weights = undefined;
  return { degree: p, knots: [...knots], ctrl: c.ctrl.map((q) => ({ ...q })), weights: weights ? [...weights] : undefined };
}

export function domain(c: Nurbs): [number, number] {
  const n = c.ctrl.length - 1;
  return [c.knots[c.degree]!, c.knots[n + 1]!];
}

function findSpan(n: number, p: number, u: number, U: readonly number[]): number {
  if (u >= U[n + 1]!) {
    // 끝: 길이가 있는 마지막 구간
    let k = n;
    while (k > p && U[k]! >= U[n + 1]!) k--;
    return k;
  }
  if (u <= U[p]!) {
    let k = p;
    while (k < n && U[k + 1]! <= U[p]!) k++;
    return k;
  }
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

function deBoorH(p: number, U: readonly number[], Pw: readonly H[], u: number): H {
  const n = Pw.length - 1;
  const k = findSpan(n, p, u, U);
  const d: H[] = [];
  for (let j = 0; j <= p; j++) {
    const q = Pw[Math.min(Math.max(k - p + j, 0), n)]!;
    d.push([q[0], q[1], q[2], q[3]]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = U[i + p - r + 1]! - U[i]!;
      const a = den === 0 ? 0 : (u - U[i]!) / den;
      const dj = d[j]!;
      const dm = d[j - 1]!;
      d[j] = [(1 - a) * dm[0] + a * dj[0], (1 - a) * dm[1] + a * dj[1], (1 - a) * dm[2] + a * dj[2], (1 - a) * dm[3] + a * dj[3]];
    }
  }
  return d[p]!;
}

interface Prepared {
  Pw: H[];
  dPw: H[];
  dU: number[];
}

const prepCache = new WeakMap<Nurbs, Prepared>();

function prep(c: Nurbs): Prepared {
  let pr = prepCache.get(c);
  if (pr) return pr;
  const Pw = homog(c);
  const p = c.degree;
  const U = c.knots;
  const dPw: H[] = [];
  for (let i = 0; i + 1 < Pw.length; i++) {
    const den = U[i + p + 1]! - U[i + 1]!;
    const f = den > 0 ? p / den : 0;
    const a = Pw[i]!;
    const b = Pw[i + 1]!;
    dPw.push([(b[0] - a[0]) * f, (b[1] - a[1]) * f, (b[2] - a[2]) * f, (b[3] - a[3]) * f]);
  }
  pr = { Pw, dPw, dU: U.slice(1, U.length - 1) };
  prepCache.set(c, pr);
  return pr;
}

export function nurbsPoint(c: Nurbs, u: number): Vec3 {
  const h = deBoorH(c.degree, c.knots, prep(c).Pw, u);
  const w = h[3] || 1;
  return { x: h[0] / w, y: h[1] / w, z: h[2] / w };
}

/** 1차 도함수 dC/du */
export function nurbsDeriv(c: Nurbs, u: number): Vec3 {
  const pr = prep(c);
  if (c.degree < 1 || pr.dPw.length === 0) return { x: 0, y: 0, z: 0 };
  const h = deBoorH(c.degree, c.knots, pr.Pw, u);
  const w = h[3] || 1;
  const d = deBoorH(c.degree - 1, pr.dU, pr.dPw, u);
  const cx = h[0] / w;
  const cy = h[1] / w;
  const cz = h[2] / w;
  return { x: (d[0] - d[3] * cx) / w, y: (d[1] - d[3] * cy) / w, z: (d[2] - d[3] * cz) / w };
}

function multiplicity(U: readonly number[], u: number): number {
  let s = 0;
  for (const k of U) if (Math.abs(k - u) <= KEPS * Math.max(1, Math.abs(u))) s++;
  return s;
}

function snapKnot(U: readonly number[], u: number): number {
  for (const k of U) if (Math.abs(k - u) <= KEPS * Math.max(1, Math.abs(u))) return k;
  return u;
}

/** 매듭 u를 times번 넣는다(모양 유지). 정의역 끝(마지막 매듭)에는 쓰지 않는다. */
export function insertKnot(c: Nurbs, u0: number, times: number): Nurbs {
  const p = c.degree;
  const U = c.knots;
  const n = c.ctrl.length - 1;
  const u = snapKnot(U, u0);
  const s = multiplicity(U, u);
  const r = Math.min(times, p - s);
  if (r <= 0) return c;
  // u가 든 구간: U[k] <= u < U[k+1]
  let k = -1;
  for (let i = 0; i + 1 < U.length; i++) if (U[i]! <= u && u < U[i + 1]!) k = i;
  if (k < p || k > n) return c;
  const Pw = homog(c);
  const mp = U.length;
  const UQ: number[] = new Array(mp + r);
  for (let i = 0; i <= k; i++) UQ[i] = U[i]!;
  for (let i = 1; i <= r; i++) UQ[k + i] = u;
  for (let i = k + 1; i < mp; i++) UQ[i + r] = U[i]!;
  const Qw: H[] = new Array(n + 1 + r);
  for (let i = 0; i <= k - p; i++) Qw[i] = Pw[i]!;
  for (let i = k - s; i <= n; i++) Qw[i + r] = Pw[i]!;
  const Rw: H[] = [];
  for (let i = 0; i <= p - s; i++) Rw[i] = [...Pw[k - p + i]!] as H;
  let L = 0;
  for (let j = 1; j <= r; j++) {
    L = k - p + j;
    for (let i = 0; i <= p - j - s; i++) {
      const alpha = (u - U[L + i]!) / (U[i + k + 1]! - U[L + i]!);
      const a = Rw[i + 1]!;
      const b = Rw[i]!;
      Rw[i] = [alpha * a[0] + (1 - alpha) * b[0], alpha * a[1] + (1 - alpha) * b[1], alpha * a[2] + (1 - alpha) * b[2], alpha * a[3] + (1 - alpha) * b[3]];
    }
    Qw[L] = Rw[0]!;
    Qw[k + r - j - s] = Rw[p - j - s]!;
  }
  for (let i = L + 1; i < k - s; i++) Qw[i] = Rw[i - L]!;
  return fromHomog(p, UQ, Qw, !!c.weights);
}

export function reverseNurbs(c: Nurbs): Nurbs {
  const U = c.knots;
  const a = U[0]!;
  const b = U[U.length - 1]!;
  const knots = U.map((_, i) => a + b - U[U.length - 1 - i]!);
  return { degree: c.degree, knots, ctrl: [...c.ctrl].reverse().map((q) => ({ ...q })), weights: c.weights ? [...c.weights].reverse() : undefined };
}

function isClampedStart(c: Nurbs): boolean {
  const U = c.knots;
  for (let i = 1; i <= c.degree; i++) if (Math.abs(U[i]! - U[0]!) > KEPS * Math.max(1, Math.abs(U[0]!))) return false;
  return true;
}

/** 시작을 고정 매듭으로(정의역 시작 U[p]에서 자른다) */
function clampStart(c: Nurbs): Nurbs {
  if (isClampedStart(c)) return c;
  const u = c.knots[c.degree]!;
  const q = insertKnot(c, u, c.degree);
  const UQ = q.knots;
  let i0 = 0;
  while (i0 < UQ.length && UQ[i0]! < u) i0++;
  const Pw = homog(q).slice(i0 - 1);
  return fromHomog(q.degree, [u, ...UQ.slice(i0)], Pw, !!c.weights);
}

function clampEnd(c: Nurbs): Nurbs {
  return reverseNurbs(clampStart(reverseNurbs(c)));
}

export function clampNurbs(c: Nurbs): Nurbs {
  return clampEnd(clampStart(c));
}

/** u에서 둘로 나눈다(둘 다 고정 매듭). u가 끝이면 한쪽이 null */
export function splitNurbs(c0: Nurbs, u0: number): [Nurbs | null, Nurbs | null] {
  const c = clampNurbs(c0);
  const [a, b] = domain(c);
  const tol = KEPS * Math.max(1, Math.abs(a), Math.abs(b)) * 1e3;
  if (u0 <= a + tol) return [null, c];
  if (u0 >= b - tol) return [c, null];
  const p = c.degree;
  const u = snapKnot(c.knots, u0);
  const q = insertKnot(c, u, p);
  const UQ = q.knots;
  let i0 = 0;
  while (i0 < UQ.length && UQ[i0]! < u) i0++;
  const Pw = homog(q);
  const left = fromHomog(p, [...UQ.slice(0, i0 + p), u], Pw.slice(0, i0), !!c.weights);
  const right = fromHomog(p, [u, ...UQ.slice(i0)], Pw.slice(i0 - 1), !!c.weights);
  return [left, right];
}

/** 정의역의 [u0, u1] 부분(u0 < u1) */
export function subNurbs(c: Nurbs, u0: number, u1: number): Nurbs {
  const [, r] = splitNurbs(c, u0);
  const base = r ?? clampNurbs(c);
  const [l] = splitNurbs(base, u1);
  return l ?? base;
}

// ---------------------------------------------------------------------------
// 베지어 분해·차수 올리기·잇기
// ---------------------------------------------------------------------------

/** 고정 매듭 곡선을 베지어 조각(동차 좌표)으로 */
export function toBezier(c0: Nurbs): H[][] {
  let c = clampNurbs(c0);
  const p = c.degree;
  const [a, b] = domain(c);
  const inner = [...new Set(c.knots.filter((k) => k > a && k < b))];
  for (const u of inner) c = insertKnot(c, u, p);
  const Pw = homog(c);
  const segs: H[][] = [];
  for (let i = 0; i + p < Pw.length; i += p) segs.push(Pw.slice(i, i + p + 1));
  return segs;
}

/** 베지어 차수를 t만큼 올린다 */
export function elevateBezier(P: H[], t: number): H[] {
  let cur = P;
  for (let k = 0; k < t; k++) {
    const p = cur.length - 1;
    const out: H[] = [];
    for (let i = 0; i <= p + 1; i++) {
      const a = i / (p + 1);
      const prev = cur[i - 1];
      const here = cur[i];
      if (!prev) out.push([...here!] as H);
      else if (!here) out.push([...prev] as H);
      else out.push([a * prev[0] + (1 - a) * here[0], a * prev[1] + (1 - a) * here[1], a * prev[2] + (1 - a) * here[2], a * prev[3] + (1 - a) * here[3]]);
    }
    cur = out;
  }
  return cur;
}

/** 같은 차수의 베지어 조각들을 이어 고정 매듭 곡선 하나로(이음매는 C0, 매듭 다중도 = 차수) */
export function joinBeziers(segs: H[][]): Nurbs | null {
  if (!segs.length) return null;
  const p = segs[0]!.length - 1;
  const Pw: H[] = [];
  const knots: number[] = [];
  let u = 0;
  for (let i = 0; i <= p; i++) knots.push(0);
  let scale = 1;
  for (let s = 0; s < segs.length; s++) {
    let seg = segs[s]!;
    if (s > 0) {
      // 이음매의 동차 좌표를 맞춘다(가중치 비율로 조각 전체를 곱한다)
      const prevW = Pw[Pw.length - 1]![3];
      const w0 = seg[0]![3];
      scale = w0 !== 0 ? prevW / w0 : 1;
      seg = seg.map((h) => [h[0] * scale, h[1] * scale, h[2] * scale, h[3] * scale] as H);
    }
    const start = s === 0 ? 0 : 1;
    for (let i = start; i <= p; i++) Pw.push(seg[i]!);
    // 매듭 간격: 조정 다각형 길이
    let L = 0;
    for (let i = 1; i <= p; i++) {
      const a = seg[i - 1]!;
      const b = seg[i]!;
      L += Math.hypot(b[0] / b[3] - a[0] / a[3], b[1] / b[3] - a[1] / a[3], b[2] / b[3] - a[2] / a[3]);
    }
    u += L > 0 ? L : 1;
    const mult = s === segs.length - 1 ? p + 1 : p;
    for (let i = 0; i < mult; i++) knots.push(u);
  }
  // 매듭을 [0, 1]로
  const total = u || 1;
  const kn = knots.map((k) => k / total);
  const rational = Pw.some((h) => Math.abs(h[3] - 1) > 1e-12);
  return fromHomog(p, kn, Pw, rational);
}

/** 여러 곡선을 차수를 맞춰 잇는다(끝점이 같아야 한다) */
export function joinNurbs(list: Nurbs[]): Nurbs | null {
  if (!list.length) return null;
  const p = Math.max(...list.map((c) => c.degree));
  const segs: H[][] = [];
  for (const c of list) for (const s of toBezier(c)) segs.push(elevateBezier(s, p - (s.length - 1)));
  return joinBeziers(segs);
}

// ---------------------------------------------------------------------------
// 원호·타원호·선분
// ---------------------------------------------------------------------------

/** 원호(signed sweep)를 유리 2차 베지어(동차)로 */
export function arcBeziers(c: Vec2, r: number, a0: number, sweep: number, z = 0): H[][] {
  return ellBeziers(c, { x: r, y: 0 }, { x: 0, y: r }, a0, sweep, z);
}

/** 타원호 c + u cos θ + v sin θ, θ = t0 … t0 + dt 를 유리 2차 베지어로 */
export function ellBeziers(c: Vec2, u: Vec2, v: Vec2, t0: number, dt: number, z = 0): H[][] {
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const P = (t: number, k = 1): Vec2 => ({ x: c.x + (u.x * Math.cos(t) + v.x * Math.sin(t)) * k, y: c.y + (u.y * Math.cos(t) + v.y * Math.sin(t)) * k });
  const segs: H[][] = [];
  const w = Math.cos(step / 2);
  for (let i = 0; i < n; i++) {
    const ta = t0 + step * i;
    const tb = ta + step;
    const pa = P(ta);
    const pb = P(tb);
    const pm = P((ta + tb) / 2, 1 / w);
    segs.push([
      [pa.x, pa.y, z, 1],
      [pm.x * w, pm.y * w, z * w, w],
      [pb.x, pb.y, z, 1],
    ]);
  }
  return segs;
}

export function lineBezier(a: Vec3, b: Vec3): H[] {
  return [
    [a.x, a.y, a.z, 1],
    [b.x, b.y, b.z, 1],
  ];
}

export function beziersToNurbs(segs: H[][]): Nurbs | null {
  if (!segs.length) return null;
  const p = Math.max(...segs.map((s) => s.length - 1));
  return joinBeziers(segs.map((s) => elevateBezier(s, p - (s.length - 1))));
}

// ---------------------------------------------------------------------------
// 나누기(매개변수 포함)
// ---------------------------------------------------------------------------

export interface Sample {
  u: number;
  x: number;
  y: number;
}

/** 곡선을 점으로 나눈다(매개변수와 함께). tol = 현과 곡선 사이 대략의 거리 */
export function sampleNurbs(c: Nurbs, tol: number, u0?: number, u1?: number): Sample[] {
  const p = c.degree;
  const U = c.knots;
  const n = c.ctrl.length;
  const [da, db] = domain(c);
  const a0 = u0 ?? da;
  const b0 = u1 ?? db;
  const out: Sample[] = [];
  const push = (u: number) => {
    const q = nurbsPoint(c, u);
    out.push({ u, x: q.x, y: q.y });
  };
  push(a0);
  for (let s = p; s < n; s++) {
    const a = Math.max(U[s]!, a0);
    const b = Math.min(U[s + 1]!, b0);
    if (!(b > a)) continue;
    let L = 0;
    for (let j = Math.max(0, s - p); j < Math.min(n - 1, s); j++) {
      const q0 = c.ctrl[j]!;
      const q1 = c.ctrl[j + 1]!;
      L += Math.hypot(q1.x - q0.x, q1.y - q0.y);
    }
    const frac = (b - a) / Math.max(U[s + 1]! - U[s]!, 1e-300);
    const m = Math.min(256, Math.max(p === 1 ? 1 : 8, Math.ceil(Math.sqrt((L * frac) / Math.max(tol, 1e-12)) * 1.2)));
    for (let i = 1; i <= m; i++) push(a + ((b - a) * i) / m);
  }
  if (out.length === 1) push(b0);
  return out;
}

// ---------------------------------------------------------------------------
// 닫힌 3차 보간(균일 주기 B 스플라인)
// ---------------------------------------------------------------------------

/** 점 Q0…Q(n−1)을 지나는 닫힌 균일 3차 B 스플라인(주기 형태: 조정점 n + 3, 매듭 0 … n + 6) */
export function periodicInterpolate(Q: readonly Vec3[]): Nurbs | null {
  const n = Q.length;
  if (n < 3) return null;
  // (P[i-1] + 4 P[i] + P[i+1]) / 6 = Q[i] (순환 삼중대각)
  const solveAxis = (rhs: number[]): number[] => cyclicTridiag(n, 1 / 6, 4 / 6, 1 / 6, rhs);
  const xs = solveAxis(Q.map((q) => q.x));
  const ys = solveAxis(Q.map((q) => q.y));
  const zs = solveAxis(Q.map((q) => q.z));
  const P: Vec3[] = [];
  for (let i = 0; i < n; i++) P.push({ x: xs[i]!, y: ys[i]!, z: zs[i]! });
  // 곡선이 u = 3 + j 에서 P[j], P[j+1], P[j+2]의 평균 = Q[j+1]을 지나도록 한 칸 당긴다
  const ctrl: Vec3[] = [];
  for (let i = 0; i < n + 3; i++) ctrl.push({ ...P[(i + n - 1) % n]! });
  const knots: number[] = [];
  for (let i = 0; i < n + 7; i++) knots.push(i);
  return { degree: 3, knots, ctrl };
}

/** 순환 삼중대각(a 아래, b 대각, c 위 — 모두 상수) */
function cyclicTridiag(n: number, a: number, b: number, c: number, r: number[]): number[] {
  // Sherman–Morrison
  const gamma = -b;
  const bb: number[] = new Array(n).fill(b);
  bb[0] = b - gamma;
  bb[n - 1] = b - (a * c) / gamma;
  const x = thomas(n, a, bb, c, r);
  const u = new Array(n).fill(0);
  u[0] = gamma;
  u[n - 1] = c;
  const z = thomas(n, a, bb, c, u);
  const fact = (x[0]! + (a * x[n - 1]!) / gamma) / (1 + z[0]! + (a * z[n - 1]!) / gamma);
  return x.map((xi, i) => xi - fact * z[i]!);
}

function thomas(n: number, a: number, b: number[], c: number, r: number[]): number[] {
  const cp = new Array(n).fill(0);
  const dp = new Array(n).fill(0);
  cp[0] = c / b[0]!;
  dp[0] = r[0]! / b[0]!;
  for (let i = 1; i < n; i++) {
    const m = b[i]! - a * cp[i - 1];
    cp[i] = c / m;
    dp[i] = (r[i]! - a * dp[i - 1]) / m;
  }
  const x = new Array(n).fill(0);
  x[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
  return x;
}

/**
 * 점들을 지나는 p차 B 스플라인(현 길이 매개변수, 평균 매듭 — NURBS Book 9.2.1).
 * 행렬이 띠 모양이라 피벗 없이 띠 안에서만 소거한다(점 수에 비례).
 */
export function interpolate(Q: readonly Vec3[], degree = 3): Nurbs | null {
  const n = Q.length;
  if (n < 2) return null;
  const p = Math.max(1, Math.min(degree, n - 1));
  const t: number[] = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(Q[i]!.x - Q[i - 1]!.x, Q[i]!.y - Q[i - 1]!.y, Q[i]!.z - Q[i - 1]!.z);
    t.push(total);
  }
  if (!(total > 0)) return null;
  for (let i = 0; i < n; i++) t[i] = t[i]! / total;
  t[n - 1] = 1;
  const U: number[] = new Array(n + p + 1).fill(0);
  for (let i = 0; i <= p; i++) U[n + i] = 1;
  for (let j = 1; j < n - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += t[i]!;
    U[j + p] = s / p;
  }
  if (p === 1) return { degree: 1, knots: U, ctrl: Q.map((q) => ({ ...q })) };
  const w = 2 * p + 1;
  const band: Float64Array[] = [];
  const rx = new Float64Array(n);
  const ry = new Float64Array(n);
  const rz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(w);
    const u = t[i]!;
    const span = Math.min(Math.max(spanOf(U, n - 1, p, u), p), n - 1);
    const N = basis(span, u, p, U);
    for (let j = 0; j <= p; j++) {
      const col = span - p + j;
      const k = col - i + p;
      if (k >= 0 && k < w) row[k] = N[j]!;
    }
    band.push(row);
    rx[i] = Q[i]!.x;
    ry[i] = Q[i]!.y;
    rz[i] = Q[i]!.z;
  }
  const at = (i: number, j: number) => band[i]![j - i + p]!;
  for (let c = 0; c < n; c++) {
    const piv = at(c, c);
    if (Math.abs(piv) < 1e-300) return null;
    for (let r = c + 1; r <= Math.min(n - 1, c + p); r++) {
      const f = at(r, c) / piv;
      if (f === 0) continue;
      for (let k = c; k <= Math.min(n - 1, c + p); k++) band[r]![k - r + p] = at(r, k) - f * at(c, k);
      rx[r] = rx[r]! - f * rx[c]!;
      ry[r] = ry[r]! - f * ry[c]!;
      rz[r] = rz[r]! - f * rz[c]!;
    }
  }
  const ctrl: Vec3[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sx = rx[i]!;
    let sy = ry[i]!;
    let sz = rz[i]!;
    for (let k = i + 1; k <= Math.min(n - 1, i + p); k++) {
      const a = at(i, k);
      sx -= a * ctrl[k]!.x;
      sy -= a * ctrl[k]!.y;
      sz -= a * ctrl[k]!.z;
    }
    const d = at(i, i);
    ctrl[i] = { x: sx / d, y: sy / d, z: sz / d };
  }
  return { degree: p, knots: U, ctrl };
}

function spanOf(U: readonly number[], n: number, p: number, u: number): number {
  if (u >= U[n + 1]!) return n;
  if (u <= U[p]!) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

function basis(i: number, u: number, p: number, U: readonly number[]): number[] {
  const N = new Array(p + 1).fill(0);
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[i + 1 - j]!;
    right[j] = U[i + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const temp = den === 0 ? 0 : N[r] / den;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** 아핀 상(조정점만 옮긴다 — 정확) */
export function mapNurbs(c: Nurbs, f: (p: Vec3) => Vec3): Nurbs {
  return { degree: c.degree, knots: [...c.knots], ctrl: c.ctrl.map(f), weights: c.weights ? [...c.weights] : undefined };
}
