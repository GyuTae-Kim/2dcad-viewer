/**
 * 3D 아핀 변환(3×4, 행 우선). 블록 참조·OCS 변환을 겹쳐 쓰고, 화면에는 X·Y만 쓴다.
 * m = [m00 m01 m02 m03, m10 m11 m12 m13, m20 m21 m22 m23]
 * p' = (m00 x + m01 y + m02 z + m03, …)
 */
import type { Vec2, Vec3 } from '../core/model';

export type Mat = Float64Array;

export function identity(): Mat {
  const m = new Float64Array(12);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  return m;
}

export function mat(
  m00: number,
  m01: number,
  m02: number,
  m03: number,
  m10: number,
  m11: number,
  m12: number,
  m13: number,
  m20: number,
  m21: number,
  m22: number,
  m23: number,
): Mat {
  return Float64Array.of(m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23);
}

/** a · b (b를 먼저 적용) */
export function multiply(a: Mat, b: Mat): Mat {
  const r = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    const a0 = a[i * 4]!;
    const a1 = a[i * 4 + 1]!;
    const a2 = a[i * 4 + 2]!;
    const a3 = a[i * 4 + 3]!;
    r[i * 4] = a0 * b[0]! + a1 * b[4]! + a2 * b[8]!;
    r[i * 4 + 1] = a0 * b[1]! + a1 * b[5]! + a2 * b[9]!;
    r[i * 4 + 2] = a0 * b[2]! + a1 * b[6]! + a2 * b[10]!;
    r[i * 4 + 3] = a0 * b[3]! + a1 * b[7]! + a2 * b[11]! + a3;
  }
  return r;
}

export function translation(x: number, y: number, z = 0): Mat {
  return mat(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z);
}

export function scaling(sx: number, sy: number, sz = 1): Mat {
  return mat(sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0);
}

export function rotationZ(a: number): Mat {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return mat(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0);
}

export function apply(m: Mat, x: number, y: number, z = 0): Vec3 {
  return {
    x: m[0]! * x + m[1]! * y + m[2]! * z + m[3]!,
    y: m[4]! * x + m[5]! * y + m[6]! * z + m[7]!,
    z: m[8]! * x + m[9]! * y + m[10]! * z + m[11]!,
  };
}

export function applyXY(m: Mat, x: number, y: number, z = 0): Vec2 {
  return { x: m[0]! * x + m[1]! * y + m[2]! * z + m[3]!, y: m[4]! * x + m[5]! * y + m[6]! * z + m[7]! };
}

/** 방향 벡터(이동 없이) */
export function applyDir(m: Mat, x: number, y: number, z = 0): Vec3 {
  return {
    x: m[0]! * x + m[1]! * y + m[2]! * z,
    y: m[4]! * x + m[5]! * y + m[6]! * z,
    z: m[8]! * x + m[9]! * y + m[10]! * z,
  };
}

export function invert(m: Mat): Mat | null {
  const a = m[0]!,
    b = m[1]!,
    c = m[2]!,
    d = m[4]!,
    e = m[5]!,
    f = m[6]!,
    g = m[8]!,
    h = m[9]!,
    i = m[10]!;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) return null;
  const inv = 1 / det;
  const r = new Float64Array(12);
  r[0] = A * inv;
  r[1] = -(b * i - c * h) * inv;
  r[2] = (b * f - c * e) * inv;
  r[4] = B * inv;
  r[5] = (a * i - c * g) * inv;
  r[6] = -(a * f - c * d) * inv;
  r[8] = C * inv;
  r[9] = -(a * h - b * g) * inv;
  r[10] = (a * e - b * d) * inv;
  const tx = m[3]!,
    ty = m[7]!,
    tz = m[11]!;
  r[3] = -(r[0] * tx + r[1] * ty + r[2] * tz);
  r[7] = -(r[4] * tx + r[5] * ty + r[6] * tz);
  r[11] = -(r[8] * tx + r[9] * ty + r[10] * tz);
  return r;
}

/** XY 평면에서의 평균 축척(선종류 길이·곡선 정밀도에 쓴다) */
export function planarScale(m: Mat): number {
  const det = m[0]! * m[5]! - m[1]! * m[4]!;
  return Math.sqrt(Math.abs(det)) || Math.hypot(m[0]!, m[4]!) || 1;
}

/** XY 평면에서 좌우가 뒤집히는지 */
export function isMirrored(m: Mat): boolean {
  return m[0]! * m[5]! - m[1]! * m[4]! < 0;
}

// ---------------------------------------------------------------------------
// OCS(임의 축 알고리즘)
// ---------------------------------------------------------------------------

const ARBITRARY = 1 / 64;

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** OCS → WCS 변환(extrusion = OCS Z축). Z축이 (0,0,1)이면 null(항등). */
export function ocsMatrix(extrusion: Vec3 | undefined): Mat | null {
  if (!extrusion) return null;
  const n = normalize(extrusion);
  if (Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0) return null;
  const ax = Math.abs(n.x) < ARBITRARY && Math.abs(n.y) < ARBITRARY ? normalize(cross({ x: 0, y: 1, z: 0 }, n)) : normalize(cross({ x: 0, y: 0, z: 1 }, n));
  const ay = normalize(cross(n, ax));
  return mat(ax.x, ay.x, n.x, 0, ax.y, ay.y, n.y, 0, ax.z, ay.z, n.z, 0);
}

/** 기존 변환에 OCS를 붙인다. */
export function withOcs(m: Mat, extrusion: Vec3 | undefined): Mat {
  const o = ocsMatrix(extrusion);
  return o ? multiply(m, o) : m;
}
