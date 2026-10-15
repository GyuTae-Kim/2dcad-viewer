/** STEP 형상 계산용 작은 벡터·행렬 도구(3D, 4×4 열 우선) */

export type V3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const dist2 = (a: V3, b: V3): number => {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
};
/** a + s·b */
export const addScaled = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function normalize(a: V3): V3 {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** 각도 차이를 (-π, π]로 */
export function wrapPi(a: number): number {
  const t = 2 * Math.PI;
  a = a % t;
  if (a > Math.PI) a -= t;
  else if (a <= -Math.PI) a += t;
  return a;
}

/** 직교 좌표계(원점·x·y·z 단위 벡터) */
export interface Frame {
  o: V3;
  x: V3;
  y: V3;
  z: V3;
}

/** z축과 x 참조 방향으로 오른손 좌표계를 만든다(ISO 10303-42 build_axes) */
export function makeFrame(o: V3, z: V3 | null, xRef: V3 | null): Frame {
  const zz = z ? normalize(z) : ([0, 0, 1] as V3);
  if (len(zz) === 0) zz[2] = 1;
  let xr = xRef ? normalize(xRef) : null;
  if (!xr || len(xr) === 0 || Math.abs(dot(xr, zz)) > 1 - 1e-12) {
    // 기본 방향: (1,0,0), z가 그와 나란하면 (0,0,1)(first_proj_axis)
    xr = Math.abs(zz[0]) > 1 - 1e-12 ? [0, 0, 1] : [1, 0, 0];
  }
  const x = normalize(sub(xr, scale(zz, dot(xr, zz))));
  const y = cross(zz, x);
  return { o, x, y, z: zz };
}

export function framePoint(f: Frame, a: number, b: number, c: number): V3 {
  return [
    f.o[0] + f.x[0] * a + f.y[0] * b + f.z[0] * c,
    f.o[1] + f.x[1] * a + f.y[1] * b + f.z[1] * c,
    f.o[2] + f.x[2] * a + f.y[2] * b + f.z[2] * c,
  ];
}

/** 4×4 열 우선 행렬 */
export type M4 = Float64Array;

export function identity(): M4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function isIdentity(m: M4, eps = 1e-12): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i]! - (i % 5 === 0 ? 1 : 0)) > eps) return false;
  return true;
}

/** 좌표계 → 행렬(국소 → 바깥) */
export function frameMatrix(f: Frame, s = 1): M4 {
  const m = new Float64Array(16);
  m[0] = f.x[0] * s;
  m[1] = f.x[1] * s;
  m[2] = f.x[2] * s;
  m[4] = f.y[0] * s;
  m[5] = f.y[1] * s;
  m[6] = f.y[2] * s;
  m[8] = f.z[0] * s;
  m[9] = f.z[1] * s;
  m[10] = f.z[2] * s;
  m[12] = f.o[0];
  m[13] = f.o[1];
  m[14] = f.o[2];
  m[15] = 1;
  return m;
}

export function mul(a: M4, b: M4): M4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let rr = 0; rr < 4; rr++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rr]! * b[c * 4 + k]!;
      r[c * 4 + rr] = s;
    }
  return r;
}

/** 일반 4×4 역행렬(특이하면 단위 행렬) */
export function invert(m: M4): M4 {
  const a = m;
  const r = new Float64Array(16);
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;
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
  if (!det) return identity();
  const id = 1 / det;
  r[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id;
  r[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id;
  r[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id;
  r[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id;
  r[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id;
  r[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id;
  r[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id;
  r[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id;
  r[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id;
  r[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id;
  r[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id;
  r[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id;
  r[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id;
  r[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id;
  r[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id;
  r[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id;
  return r;
}

export function transformPoint(m: M4, p: V3): V3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

export function transformDir(m: M4, p: V3): V3 {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2], m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2], m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2]];
}

/** 행렬의 이동 성분에 배율을 곱한다(단위 바꾸기) */
export function scaleTranslation(m: M4, s: number): M4 {
  const r = new Float64Array(m);
  r[12] = r[12]! * s;
  r[13] = r[13]! * s;
  r[14] = r[14]! * s;
  return r;
}
