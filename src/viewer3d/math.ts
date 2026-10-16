/**
 * 3D 뷰어용 작은 수학 도구: 벡터(길이 3 배열)와 4×4 행렬(Float64Array, 열 우선, GL 관례).
 * CPU에서는 double로 계산하고, 셰이더에 넘길 때만 float32로 바꾼다.
 */

export type V3 = [number, number, number];
export type Mat4 = Float64Array;

export const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const scale = (a: readonly number[], s: number): V3 => [a[0]! * s, a[1]! * s, a[2]! * s];
export const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const cross = (a: readonly number[], b: readonly number[]): V3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
export const length = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
export function normalize(a: readonly number[]): V3 {
  const l = length(a);
  return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 0];
}
/** a + (b − a)·t */
export const lerp3 = (a: readonly number[], b: readonly number[], t: number): V3 => [
  a[0]! + (b[0]! - a[0]!) * t,
  a[1]! + (b[1]! - a[1]!) * t,
  a[2]! + (b[2]! - a[2]!) * t,
];

export function mat4Identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a · b (열 우선) */
export function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}

/** 역행렬(특이하면 null) */
export function mat4Invert(m: ArrayLike<number>): Mat4 | null {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  const id = 1 / det;
  const o = new Float64Array(16);
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id;
  return o;
}

/** 원근 투영(세로 시야각 fovY, 라디안). 클립 z는 GL처럼 [−w, w] */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** 평행 투영 */
export function orthographic(l: number, r: number, b: number, t: number, near: number, far: number): Mat4 {
  const m = new Float64Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = -2 / (far - near);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = -(far + near) / (far - near);
  m[15] = 1;
  return m;
}

/** 점 변환(동차 나눗셈 포함) */
export function transformPoint(m: ArrayLike<number>, p: readonly number[]): V3 {
  const x = p[0]!, y = p[1]!, z = p[2]!;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const iw = w !== 0 ? 1 / w : 1;
  return [(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) * iw, (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) * iw, (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * iw];
}

/** 동차 좌표로 변환(나누지 않음): [x, y, z, w] */
export function transform4(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

/** 방향 변환(이동 없음) */
export function transformDir(m: ArrayLike<number>, d: readonly number[]): V3 {
  const x = d[0]!, y = d[1]!, z = d[2]!;
  return [m[0]! * x + m[4]! * y + m[8]! * z, m[1]! * x + m[5]! * y + m[9]! * z, m[2]! * x + m[6]! * y + m[10]! * z];
}

/** 법선 행렬(왼쪽 위 3×3의 역전치, 열 우선 3×3) */
export function normalMatrix(m: ArrayLike<number>): Float64Array {
  const a = m[0]!, b = m[1]!, c = m[2]!;
  const d = m[4]!, e = m[5]!, f = m[6]!;
  const g = m[8]!, h = m[9]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const o = new Float64Array(9);
  if (!det) {
    o[0] = o[4] = o[8] = 1;
    return o;
  }
  const id = 1 / det;
  // 역행렬의 전치 = 여인수 행렬 / det
  o[0] = A * id;
  o[1] = B * id;
  o[2] = C * id;
  o[3] = -(b * i - c * h) * id;
  o[4] = (a * i - c * g) * id;
  o[5] = -(a * h - b * g) * id;
  o[6] = (b * f - c * e) * id;
  o[7] = -(a * f - c * d) * id;
  o[8] = (a * e - b * d) * id;
  return o;
}

/** 이동·균등 배율·축 맞춤(로컬 +Z를 axis로) 행렬 */
export function placeMatrix(pos: readonly number[], axis: readonly number[], s: number): Mat4 {
  const z = normalize(axis);
  const ref: V3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = normalize(cross(ref, z));
  const y = cross(z, x);
  const m = new Float64Array(16);
  m[0] = x[0] * s;
  m[1] = x[1] * s;
  m[2] = x[2] * s;
  m[4] = y[0] * s;
  m[5] = y[1] * s;
  m[6] = y[2] * s;
  m[8] = z[0] * s;
  m[9] = z[1] * s;
  m[10] = z[2] * s;
  m[12] = pos[0]!;
  m[13] = pos[1]!;
  m[14] = pos[2]!;
  m[15] = 1;
  return m;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 1·2·5×10ⁿ 가운데 v 이상인 가장 작은 값 */
export function niceStep(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const e = Math.floor(Math.log10(v));
  const b = 10 ** e;
  const f = v / b;
  const n = f <= 1 + 1e-9 ? 1 : f <= 2 + 1e-9 ? 2 : f <= 5 + 1e-9 ? 5 : 10;
  return n * b;
}
