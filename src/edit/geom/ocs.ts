/**
 * OCS(객체 좌표계) 도우미. 편집은 WCS 평면도에서 하고, OCS 객체는 extrusion으로 WCS를 구한다.
 * (0, 0, -1)이면 OCS X = WCS −X, Y = WCS Y, Z = WCS −Z다(임의 축 알고리즘).
 */
import type { Vec3 } from '../../core/model';
import { ocsMatrix } from '../../geom/matrix';
import { type Affine, add3, cross3, dot3, len3, mul3, norm3 } from './math';

export interface Frame {
  ax: Vec3;
  ay: Vec3;
  n: Vec3;
}

const WORLD: Frame = Object.freeze({ ax: { x: 1, y: 0, z: 0 }, ay: { x: 0, y: 1, z: 0 }, n: { x: 0, y: 0, z: 1 } }) as Frame;

/** extrusion이 없거나 (0, 0, +1)에 가까우면 참 */
export function isNaturalExt(ext: Vec3 | undefined): boolean {
  if (!ext) return true;
  const l = len3(ext);
  if (!(l > 0)) return true;
  return Math.abs(ext.x / l) < 1e-12 && Math.abs(ext.y / l) < 1e-12 && ext.z > 0;
}

/** Z축과 평행(±Z)인지 */
export function isPlanarExt(ext: Vec3 | undefined): boolean {
  if (!ext) return true;
  const l = len3(ext);
  if (!(l > 0)) return true;
  return Math.abs(ext.x / l) < 1e-9 && Math.abs(ext.y / l) < 1e-9;
}

/** OCS 축(WCS 단위 벡터) */
export function frameOf(ext: Vec3 | undefined): Frame {
  const m = ocsMatrix(ext);
  if (!m) return WORLD;
  return {
    ax: { x: m[0]!, y: m[4]!, z: m[8]! },
    ay: { x: m[1]!, y: m[5]!, z: m[9]! },
    n: { x: m[2]!, y: m[6]!, z: m[10]! },
  };
}

export function ocsToWcs(p: Vec3, ext: Vec3 | undefined): Vec3 {
  const f = frameOf(ext);
  return add3(add3(mul3(f.ax, p.x), mul3(f.ay, p.y)), mul3(f.n, p.z));
}

export function wcsToOcs(p: Vec3, ext: Vec3 | undefined): Vec3 {
  const f = frameOf(ext);
  return { x: dot3(p, f.ax), y: dot3(p, f.ay), z: dot3(p, f.n) };
}

/** OCS 방향 벡터 → WCS */
export function ocsDirToWcs(v: Vec3, ext: Vec3 | undefined): Vec3 {
  return ocsToWcs(v, ext);
}

/** 고도 z인 OCS 평면의 (x, y) → WCS 평면도 (x, y) */
export function planProj(ext: Vec3 | undefined, z = 0): Affine {
  const f = frameOf(ext);
  return [f.ax.x, f.ax.y, f.ay.x, f.ay.y, f.n.x * z, f.n.y * z];
}

/** 고도 z인 OCS 평면의 WCS Z(평면이 XY와 평행할 때의 높이) */
export function planZ(ext: Vec3 | undefined, z = 0): number {
  const f = frameOf(ext);
  return f.n.z * z;
}

export interface PlaneMap {
  /** 원래 OCS 평면 좌표 → 새 OCS 평면 좌표 */
  A: Affine;
  /** 새 extrusion(자연스러운 +Z면 undefined) */
  ext: Vec3 | undefined;
  /** 새 고도 */
  z: number;
}

/**
 * 평면 객체(OCS)에 평면도 아핀 m(Z는 dz만 이동)을 적용할 때, 새 OCS와 평면 안의 2D 아핀을 구한다.
 * 결과 평면이 XY와 평행하면 늘 +Z(자연스러운 객체)로 쓰고, 그 대신 A가 뒤집힐 수 있다(det < 0).
 */
export function planeMap(ext: Vec3 | undefined, z: number, m: Affine, dz = 0): PlaneMap {
  const f = frameOf(ext);
  const L = (v: Vec3): Vec3 => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y, z: v.z });
  const lax = L(f.ax);
  const lay = L(f.ay);
  let nn = cross3(lax, lay);
  const nl = len3(nn);
  if (!(nl > 1e-300)) nn = f.n;
  else nn = mul3(nn, 1 / nl);
  if (Math.abs(nn.x) < 1e-9 && Math.abs(nn.y) < 1e-9) nn = { x: 0, y: 0, z: 1 };
  const nf = frameOf(nn);
  const o = add3(L(mul3(f.n, z)), { x: m[4], y: m[5], z: dz });
  const A: Affine = [dot3(nf.ax, lax), dot3(nf.ay, lax), dot3(nf.ax, lay), dot3(nf.ay, lay), dot3(nf.ax, o), dot3(nf.ay, o)];
  const newExt = isNaturalExt(nn) ? undefined : norm3(nn);
  return { A, ext: newExt, z: dot3(nf.n, o) };
}

/** extrusion 값을 원래 객체의 길이(보통 1)로 정리 */
export function cleanExt(ext: Vec3 | undefined): Vec3 | undefined {
  if (!ext || isNaturalExt(ext)) return undefined;
  return norm3(ext);
}
