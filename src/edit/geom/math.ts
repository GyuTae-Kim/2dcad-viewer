/**
 * 편집 기하 공통 수학: 2D·3D 벡터, 2D 아핀 변환, 각도.
 * 아핀 [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (src/text/layout.ts와 같다).
 */
import type { Vec2, Vec3 } from '../../core/model';

export type Affine = [number, number, number, number, number, number];

export const TAU = Math.PI * 2;
/** 길이 비교 기본 공차(도면 단위) */
export const EPS = 1e-9;

// ---------------------------------------------------------------------------
// 2D 벡터
// ---------------------------------------------------------------------------

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
/** 반시계 90° 회전 */
export const rot90 = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const polar = (c: Vec2, r: number, a: number): Vec2 => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const xy = (p: { x: number; y: number }): Vec2 => ({ x: p.x, y: p.y });

export function norm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

export function near(a: Vec2, b: Vec2, tol = 1e-9): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

/** 점 크기에 맞춘 공차(큰 좌표에서도 의미 있게) */
export function tolAt(...ps: Vec2[]): number {
  let m = 1;
  for (const p of ps) m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
  return m * 1e-9;
}

// ---------------------------------------------------------------------------
// 3D 벡터
// ---------------------------------------------------------------------------

export const v3 = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const len3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export function norm3(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

export const clone3 = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

// ---------------------------------------------------------------------------
// 각도
// ---------------------------------------------------------------------------

/** [0, 2π) */
export function normAngle(a: number): number {
  let r = a % TAU;
  if (r < 0) r += TAU;
  // 2π에 아주 가까우면 0(−0과 반올림 오차)
  if (r >= TAU - 1e-12) r = 0;
  return r;
}

/** 반시계 a0 → a1의 각도(0 < s ≤ 2π) */
export function ccwSweep(a0: number, a1: number): number {
  let s = normAngle(a1) - normAngle(a0);
  if (s <= 1e-12) s += TAU;
  return s;
}

/** a를 a0부터 반시계로 잰 각도 [0, 2π) */
export function ccwFrom(a0: number, a: number): number {
  return normAngle(a - a0);
}

/** (-π, π] */
export function wrapPi(a: number): number {
  let r = normAngle(a);
  if (r > Math.PI) r -= TAU;
  return r;
}

/** 볼록도 → 중심각(부호 = 방향) */
export const bulgeToSweep = (b: number): number => 4 * Math.atan(b);
export const sweepToBulge = (s: number): number => Math.tan(s / 4);

// ---------------------------------------------------------------------------
// 2D 아핀
// ---------------------------------------------------------------------------

export const affIdentity = (): Affine => [1, 0, 0, 1, 0, 0];

/** p ∘ q (q를 먼저 적용) */
export function affMul(p: Affine, q: Affine): Affine {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

export function affApply(m: Affine, p: { x: number; y: number }): Vec2 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** 선형 부분만(방향 벡터) */
export function affLin(m: Affine, v: { x: number; y: number }): Vec2 {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

export const affDet = (m: Affine): number => m[0] * m[3] - m[1] * m[2];

export function affInv(m: Affine): Affine | null {
  const det = affDet(m);
  if (!(Math.abs(det) > 1e-300)) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const affTranslate = (dx: number, dy: number): Affine => [1, 0, 0, 1, dx, dy];

export function affRotate(angle: number, center: Vec2 = { x: 0, y: 0 }): Affine {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, -s, c, center.x - c * center.x + s * center.y, center.y - s * center.x - c * center.y];
}

export function affScale(sx: number, sy: number = sx, center: Vec2 = { x: 0, y: 0 }): Affine {
  return [sx, 0, 0, sy, center.x * (1 - sx), center.y * (1 - sy)];
}

/** p1–p2 직선에 대한 대칭 */
export function affMirror(p1: Vec2, p2: Vec2): Affine {
  const a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const c = Math.cos(2 * a);
  const s = Math.sin(2 * a);
  // 원점을 지나는 대칭 [c s; s -c] + 이동
  return [c, s, s, -c, p1.x - (c * p1.x + s * p1.y), p1.y - (s * p1.x - c * p1.y)];
}

/** 축척(넓이 비의 제곱근) */
export const affScaleOf = (m: Affine): number => Math.sqrt(Math.abs(affDet(m)));

/** 닮음 변환이면 {s, rot, mirror}. rot = 첫 열(1, 0)의 상의 각도 */
export function affSimilarity(m: Affine, tol = 1e-9): { s: number; rot: number; mirror: boolean } | null {
  const s = affScaleOf(m);
  if (!(s > 0)) return null;
  const t = tol * Math.max(1, Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
  const mirror = affDet(m) < 0;
  const ok = mirror ? Math.abs(m[0] + m[3]) <= t && Math.abs(m[1] - m[2]) <= t : Math.abs(m[0] - m[3]) <= t && Math.abs(m[1] + m[2]) <= t;
  if (!ok) return null;
  return { s, rot: Math.atan2(m[1], m[0]), mirror };
}

export function affIsIdentity(m: Affine, tol = 1e-12): boolean {
  return Math.abs(m[0] - 1) <= tol && Math.abs(m[1]) <= tol && Math.abs(m[2]) <= tol && Math.abs(m[3] - 1) <= tol && Math.abs(m[4]) <= tol && Math.abs(m[5]) <= tol;
}

/** 아핀으로 방향 각도를 옮긴다 */
export function affAngle(m: Affine, a: number): number {
  const d = affLin(m, { x: Math.cos(a), y: Math.sin(a) });
  return Math.atan2(d.y, d.x);
}

/** 3D 점에 평면 아핀 적용(Z는 dz만큼) */
export function affApply3(m: Affine, p: Vec3, dz = 0): Vec3 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5], z: p.z + dz };
}

/** 3D 방향 벡터에 평면 아핀의 선형 부분 적용 */
export function affLin3(m: Affine, v: Vec3): Vec3 {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y, z: v.z };
}

/** 평면 아핀 선형 부분의 여인수 행렬(법선 변환: (L a) × (L b) = cof(L)(a × b)) */
export function affCof3(m: Affine, n: Vec3): Vec3 {
  // L = [[a c 0][b d 0][0 0 1]], cof(L) = det(L)·L^{-T}
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[3];
  return { x: d * n.x - b * n.y, y: -c * n.x + a * n.y, z: (a * d - b * c) * n.z };
}

/** 넓은 의미의 같음(상대 공차) */
export function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

/** 2×2 연립방정식 [a b; c d][x y] = [e f] */
export function solve2(a: number, b: number, c: number, d: number, e: number, f: number): [number, number] | null {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-300) return null;
  return [(e * d - b * f) / det, (a * f - e * c) / det];
}

/** 점이 다각형 안인지(짝홀) */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 경계 상자 */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBox(): Box {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function growBox(b: Box, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  if (y > b.maxY) b.maxY = y;
}

export function boxValid(b: Box): boolean {
  return b.minX <= b.maxX && b.minY <= b.maxY;
}
