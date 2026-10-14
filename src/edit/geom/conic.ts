/**
 * 원·타원 변환: 켤레 반지름 벡터(아핀 상)에서 장축·단축을 다시 구한다.
 * 타원 P(θ) = c + M cos θ + N sin θ 의 아핀 상은 같은 꼴(M' = L M, N' = L N)이므로
 * 장축 방향 τ(tan 2τ = 2 M·N / (|M|² − |N|²))를 찾아 매개변수를 φ = θ − τ로 옮긴다.
 */
import type { Vec2, Vec3 } from '../../core/model';
import { TAU, cross, cross3, dot, dot3, len, len3, normAngle } from './math';

export interface Ellipse2 {
  c: Vec2;
  major: Vec2;
  ratio: number;
  start: number;
  end: number;
  full: boolean;
  /** 입력 θ 진행 방향이 결과 매개변수에서 거꾸로인지(대칭) */
  reversed: boolean;
  /** 입력 θ → 결과 매개변수 */
  map: (theta: number) => number;
}

/** θ ∈ [t0, t0 + dt](dt 부호 = 방향) 구간의 타원(자연스러운 +Z 방향: 단축 = 장축을 90° 돌린 것) */
export function ellipseFromConjugate(c: Vec2, M0: Vec2, N0: Vec2, t0: number, dt: number): Ellipse2 {
  let M = M0;
  let N = N0;
  let reversed = false;
  if (cross(M, N) < 0) {
    N = { x: -N.x, y: -N.y };
    reversed = true;
  }
  const tau = 0.5 * Math.atan2(2 * dot(M, N), dot(M, M) - dot(N, N));
  const ct = Math.cos(tau);
  const st = Math.sin(tau);
  const major = { x: M.x * ct + N.x * st, y: M.y * ct + N.y * st };
  const minor = { x: -M.x * st + N.x * ct, y: -M.y * st + N.y * ct };
  const a = len(major);
  const b = len(minor);
  let ratio = a > 0 ? b / a : 1;
  let maj = major;
  let swap = 0;
  if (ratio > 1) {
    // 수치 오차로 단축이 길면 바꾼다(장축 = 단축 방향, 매개변수 −π/2)
    maj = minor;
    ratio = 1 / ratio;
    swap = Math.PI / 2;
  }
  const map = (th: number): number => (reversed ? -th : th) - tau - swap;
  const full = Math.abs(dt) >= TAU - 1e-9;
  let start: number;
  let end: number;
  if (full) {
    start = 0;
    end = TAU;
  } else {
    const p0 = map(t0);
    const p1 = map(t0 + dt);
    const ccw = (reversed ? -dt : dt) > 0;
    start = normAngle(ccw ? p0 : p1);
    end = normAngle(ccw ? p1 : p0);
    if (end <= start) end += TAU;
    if (end - start > TAU) end -= TAU;
  }
  return { c: { ...c }, major: maj, ratio: Math.min(1, ratio), start, end, full, reversed, map };
}

export interface Ellipse3 {
  center: Vec3;
  major: Vec3;
  ratio: number;
  start: number;
  end: number;
  full: boolean;
  /** 법선(자연스러운 +Z면 undefined) */
  normal: Vec3 | undefined;
  reversed: boolean;
}

/** 3D 켤레 반지름 벡터 → 타원(법선 = M × N, −Z면 +Z로 뒤집는다) */
export function ellipseFromConjugate3(c: Vec3, M0: Vec3, N0: Vec3, t0: number, dt: number): Ellipse3 {
  const M = M0;
  let N = N0;
  let reversed = false;
  let n = cross3(M, N);
  const nl = len3(n);
  if (nl > 0) n = { x: n.x / nl, y: n.y / nl, z: n.z / nl };
  else n = { x: 0, y: 0, z: 1 };
  if (Math.abs(n.x) < 1e-9 && Math.abs(n.y) < 1e-9 && n.z < 0) {
    N = { x: -N.x, y: -N.y, z: -N.z };
    n = { x: 0, y: 0, z: 1 };
    reversed = true;
  }
  const tau = 0.5 * Math.atan2(2 * dot3(M, N), dot3(M, M) - dot3(N, N));
  const ct = Math.cos(tau);
  const st = Math.sin(tau);
  let major = { x: M.x * ct + N.x * st, y: M.y * ct + N.y * st, z: M.z * ct + N.z * st };
  const minor = { x: -M.x * st + N.x * ct, y: -M.y * st + N.y * ct, z: -M.z * st + N.z * ct };
  let ratio = len3(major) > 0 ? len3(minor) / len3(major) : 1;
  let swap = 0;
  if (ratio > 1) {
    major = minor;
    ratio = 1 / ratio;
    swap = Math.PI / 2;
  }
  const map = (th: number): number => (reversed ? -th : th) - tau - swap;
  const full = Math.abs(dt) >= TAU - 1e-9;
  let start: number;
  let end: number;
  if (full) {
    start = 0;
    end = TAU;
  } else {
    const p0 = map(t0);
    const p1 = map(t0 + dt);
    const ccw = (reversed ? -dt : dt) > 0;
    start = normAngle(ccw ? p0 : p1);
    end = normAngle(ccw ? p1 : p0);
    if (end <= start) end += TAU;
  }
  const natural = Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0;
  return { center: { ...c }, major, ratio: Math.min(1, ratio), start, end, full, normal: natural ? undefined : n, reversed };
}

/** 해치 타원 경계: 기하 각도 ↔ 매개변수 */
export const geomToParam = (a: number, ratio: number): number => Math.atan2(Math.sin(a) / (ratio || 1), Math.cos(a));
export const paramToGeom = (t: number, ratio: number): number => Math.atan2(Math.sin(t) * ratio, Math.cos(t));
