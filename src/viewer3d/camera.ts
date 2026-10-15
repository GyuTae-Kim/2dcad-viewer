/**
 * 카메라: 대상점 둘레 턴테이블(방위각 yaw = Z축 둘레, 앙각 pitch ∈ [−90°, 90°]).
 * Z가 위인 CAD 습관(AutoCAD 3DORBIT 제한 궤도)에 맞춘다. 굴림(roll)은 없다.
 *
 * yaw = 0, pitch = 0 이면 앞(−Y 쪽)에서 +Y를 본다(화면 오른쪽 = +X, 위 = +Z).
 * 눈 방향(대상 → 눈) = (sin yaw·cos pitch, −cos yaw·cos pitch, sin pitch)
 * 화면 오른쪽 = (cos yaw, sin yaw, 0), 화면 위 = 눈 방향 × 오른쪽
 *
 * 모든 함수는 DOM·WebGL 없이 돈다(시험 대상).
 */
import type { Box3 } from './types';
import { boxCenter, boxCorners, boxIsEmpty } from './bounds';
import { type Mat4, type V3, add, clamp, cross, dot, lerp3, mat4Invert, mat4Mul, normalize, orthographic, perspective, scale, sub, transform4 } from './math';

export type Projection = 'perspective' | 'orthographic';
export type ViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'swIso' | 'seIso' | 'neIso' | 'nwIso';

export interface CameraState {
  target: V3;
  /** 눈과 대상점 사이 거리(평행 투영에서는 화면 높이를 정한다: 반높이 = distance·tan(fovY/2)) */
  distance: number;
  /** 라디안 */
  yaw: number;
  /** 라디안, [−π/2, π/2] */
  pitch: number;
  projection: Projection;
  /** 세로 시야각(라디안) */
  fovY: number;
}

export interface CameraBasis {
  right: V3;
  up: V3;
  /** 대상 → 눈(화면 밖을 향함) */
  back: V3;
}

export const DEFAULT_FOV = (40 * Math.PI) / 180;
const HALF_PI = Math.PI / 2;

/** 표준 뷰의 눈 방향(대상 → 눈). AutoCAD 뷰 점과 같은 뜻 */
export const VIEW_DIRS: Record<ViewName, V3> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  swIso: [-1, -1, 1],
  seIso: [1, -1, 1],
  neIso: [1, 1, 1],
  nwIso: [-1, 1, 1],
};

export const VIEW_LABELS: Record<ViewName, string> = {
  top: '위',
  bottom: '아래',
  front: '앞',
  back: '뒤',
  left: '왼쪽',
  right: '오른쪽',
  swIso: '남서 등각',
  seIso: '남동 등각',
  neIso: '북동 등각',
  nwIso: '북서 등각',
};

export function defaultCamera(): CameraState {
  const a = dirToAngles(VIEW_DIRS.seIso);
  return { target: [0, 0, 0], distance: 10, yaw: a.yaw, pitch: a.pitch, projection: 'perspective', fovY: DEFAULT_FOV };
}

export function basisFromAngles(yaw: number, pitch: number): CameraBasis {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const back: V3 = [sy * cp, -cy * cp, sp];
  const right: V3 = [cy, sy, 0];
  const up = cross(back, right);
  return { right, up, back };
}

export const cameraBasis = (c: CameraState): CameraBasis => basisFromAngles(c.yaw, c.pitch);

export function cameraEye(c: CameraState): V3 {
  return add(c.target, scale(cameraBasis(c).back, c.distance));
}

/** 각도를 (−π, π]로 */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r <= -Math.PI) r += t;
  else if (r > Math.PI) r -= t;
  return r;
}

/** 눈 방향 → yaw·pitch. 수직(위·아래)이면 yaw는 fallbackYaw */
export function dirToAngles(dir: readonly number[], fallbackYaw = 0): { yaw: number; pitch: number } {
  const n = normalize(dir);
  const pitch = Math.asin(clamp(n[2], -1, 1));
  const h = Math.hypot(n[0], n[1]);
  const yaw = h < 1e-9 ? fallbackYaw : Math.atan2(n[0], -n[1]);
  return { yaw: wrapAngle(yaw), pitch };
}

/** 한 프레임의 보기 정보(화면 좌표는 왼쪽 위 원점, 화소) */
export interface ViewFrame {
  width: number;
  height: number;
  projection: Projection;
  eye: V3;
  basis: CameraBasis;
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  invViewProj: Mat4;
  near: number;
  far: number;
  /** 원근: 깊이 1에서 한 화소의 세계 길이 */
  pixelPerDepth: number;
  /** 평행: 한 화소의 세계 길이 */
  pixelConst: number;
}

export function viewMatrix(eye: V3, b: CameraBasis): Mat4 {
  const m = new Float64Array(16);
  m[0] = b.right[0];
  m[4] = b.right[1];
  m[8] = b.right[2];
  m[1] = b.up[0];
  m[5] = b.up[1];
  m[9] = b.up[2];
  m[2] = b.back[0];
  m[6] = b.back[1];
  m[10] = b.back[2];
  m[12] = -dot(b.right, eye);
  m[13] = -dot(b.up, eye);
  m[14] = -dot(b.back, eye);
  m[15] = 1;
  return m;
}

/**
 * 프레임 계산. sphere는 그릴 것 전체를 감싸는 구(가까운·먼 자르기 면을 정한다).
 */
export function computeFrame(c: CameraState, width: number, height: number, sphere: { center: readonly number[]; radius: number }): ViewFrame {
  const w = Math.max(1, width), h = Math.max(1, height);
  const aspect = w / h;
  const basis = cameraBasis(c);
  const eye = add(c.target, scale(basis.back, c.distance));
  const view = viewMatrix(eye, basis);
  const r = Math.max(sphere.radius, 1e-9);
  const dc = -dot(sub(sphere.center, eye), basis.back);
  const pad = r * 0.02 + 1e-9;
  const tanV = Math.tan(c.fovY / 2);
  let near: number, far: number, proj: Mat4;
  if (c.projection === 'perspective') {
    far = Math.max(dc + r + pad, c.distance * 1.01, 1e-6);
    const minNear = Math.min(far * 1e-4, c.distance * 0.05);
    near = Math.max(dc - r - pad, minNear, 1e-9);
    if (near >= far) near = far * 1e-3;
    proj = perspective(c.fovY, aspect, near, far);
  } else {
    near = dc - r - pad;
    far = dc + r + pad;
    if (!(far > near)) {
      near = -1;
      far = 1;
    }
    const hh = c.distance * tanV;
    proj = orthographic(-hh * aspect, hh * aspect, -hh, hh, near, far);
  }
  const viewProj = mat4Mul(proj, view);
  const invViewProj = mat4Invert(viewProj) ?? new Float64Array(16);
  const pixelPerDepth = (2 * tanV) / h;
  const pixelConst = (2 * c.distance * tanV) / h;
  return { width: w, height: h, projection: c.projection, eye, basis, view, proj, viewProj, invViewProj, near, far, pixelPerDepth, pixelConst };
}

/** 눈에서 본 깊이(앞쪽이 양수) */
export function viewDepth(f: ViewFrame, p: readonly number[]): number {
  return -dot(sub(p, f.eye), f.basis.back);
}

/** 깊이 depth에서 한 화소의 세계 길이 */
export function worldPerPixel(f: ViewFrame, depth: number): number {
  return f.projection === 'perspective' ? Math.max(depth, 0) * f.pixelPerDepth : f.pixelConst;
}

/** 세계 점 → 화면 [x, y, 깊이]. 눈 뒤(원근)면 null */
export function projectToScreen(f: ViewFrame, p: readonly number[]): V3 | null {
  const c = transform4(f.viewProj, p[0]!, p[1]!, p[2]!);
  if (f.projection === 'perspective' && c[3] <= 1e-12) return null;
  const iw = 1 / c[3];
  return [((c[0] * iw + 1) / 2) * f.width, ((1 - c[1] * iw) / 2) * f.height, viewDepth(f, p)];
}

/** 화면 점(화소) → 세계 광선(원점은 가까운 면 위, 방향은 단위) */
export function screenRay(f: ViewFrame, x: number, y: number): { origin: V3; dir: V3 } {
  const nx = (x / f.width) * 2 - 1;
  const ny = 1 - (y / f.height) * 2;
  const a = unproject(f.invViewProj, nx, ny, -1);
  const b = unproject(f.invViewProj, nx, ny, 1);
  return { origin: a, dir: normalize(sub(b, a)) };
}

function unproject(m: Mat4, x: number, y: number, z: number): V3 {
  const c = transform4(m, x, y, z);
  const iw = c[3] !== 0 ? 1 / c[3] : 1;
  return [c[0] * iw, c[1] * iw, c[2] * iw];
}

/** 광선이 대상점 깊이(화면과 나란한 면)와 만나는 점 */
export function rayAtDepth(f: ViewFrame, ray: { origin: V3; dir: V3 }, depth: number): V3 {
  const fwd = scale(f.basis.back, -1);
  const d0 = dot(sub(ray.origin, f.eye), fwd);
  const k = dot(ray.dir, fwd);
  const t = Math.abs(k) > 1e-12 ? (depth - d0) / k : 0;
  return add(ray.origin, scale(ray.dir, t));
}

/**
 * 상자 전체가 화면에 들어오게 대상점·거리를 맞춘다(방향은 그대로).
 * margin > 1 이면 둘레에 여유를 둔다.
 */
export function fitCamera(c: CameraState, box: Box3, aspect: number, margin = 1.08): CameraState {
  if (boxIsEmpty(box)) return { ...c, target: [...c.target] as V3 };
  let b = box;
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  if (!(size > 0)) {
    // 점 하나: 한 단위 상자로 본다
    const e = Math.max(1, Math.abs(b.min[0]), Math.abs(b.min[1]), Math.abs(b.min[2])) * 1e-3 + 0.5;
    b = { min: [b.min[0] - e, b.min[1] - e, b.min[2] - e], max: [b.max[0] + e, b.max[1] + e, b.max[2] + e] };
  }
  const center = boxCenter(b);
  const basis = cameraBasis(c);
  const tanV = Math.tan(c.fovY / 2);
  const a = Math.max(aspect, 1e-6);
  let d = 0;
  let hh = 0;
  for (const p of boxCorners(b)) {
    const rel = sub(p, center);
    const cx = Math.abs(dot(rel, basis.right));
    const cy = Math.abs(dot(rel, basis.up));
    const cz = dot(rel, basis.back);
    if (c.projection === 'perspective') {
      const tv = tanV / margin;
      const th = tv * a;
      d = Math.max(d, cz + cx / th, cz + cy / tv);
    } else hh = Math.max(hh, cy, cx / a);
  }
  if (c.projection === 'orthographic') d = (hh * margin) / tanV;
  return { ...c, target: center, distance: Math.max(d, size * 1e-6, 1e-9) };
}

/** 표준 뷰로 돌리고 전체 보기 */
export function viewCamera(c: CameraState, view: ViewName | readonly number[], box: Box3, aspect: number): CameraState {
  const dir = typeof view === 'string' ? VIEW_DIRS[view] : view;
  const a = dirToAngles(dir, 0);
  return fitCamera({ ...c, yaw: a.yaw, pitch: a.pitch }, box, aspect);
}

/** 궤도 회전. pivot이 있으면 그 점이 화면에서 제자리에 남는다 */
export function orbitCamera(c: CameraState, dYaw: number, dPitch: number, pivot?: readonly number[] | null): CameraState {
  const pitch = clamp(c.pitch + dPitch, -HALF_PI, HALF_PI);
  const yaw = wrapAngle(c.yaw + dYaw);
  let target: V3 = [...c.target] as V3;
  if (pivot) {
    // R = B'·Bᵀ: 옛 카메라 틀에서의 좌표를 새 틀에서 그대로 쓴다
    const b0 = basisFromAngles(c.yaw, c.pitch);
    const b1 = basisFromAngles(yaw, pitch);
    const rel = sub(c.target, pivot);
    const x = dot(rel, b0.right), y = dot(rel, b0.up), z = dot(rel, b0.back);
    target = add(pivot, add(add(scale(b1.right, x), scale(b1.up, y)), scale(b1.back, z)));
  }
  return { ...c, yaw, pitch, target };
}

/** 화면 이동(끌기 화소). depth는 손으로 잡은 점의 깊이(없으면 대상점) */
export function panCamera(c: CameraState, f: ViewFrame, dxPx: number, dyPx: number, depth = c.distance): CameraState {
  const wpp = worldPerPixel(f, depth);
  const b = f.basis;
  const target = add(c.target, add(scale(b.right, -dxPx * wpp), scale(b.up, dyPx * wpp)));
  return { ...c, target };
}

/**
 * anchor를 중심으로 확대·축소(factor < 1 이면 확대). anchor는 화면에서 제자리에 남는다.
 * limits로 거리를 묶는다.
 */
export function zoomCamera(c: CameraState, factor: number, anchor: readonly number[], limits?: { min: number; max: number }): CameraState {
  let d = c.distance * factor;
  if (limits) d = clamp(d, limits.min, limits.max);
  const k = d / c.distance;
  if (!(k > 0) || !Number.isFinite(k)) return c;
  const target = add(anchor, scale(sub(c.target, anchor), k));
  return { ...c, target, distance: d };
}

/** 두 카메라 사이 보간(t ∈ [0, 1]). yaw는 짧은 쪽으로 돈다 */
export function lerpCamera(a: CameraState, b: CameraState, t: number): CameraState {
  const dy = wrapAngle(b.yaw - a.yaw);
  return {
    target: lerp3(a.target, b.target, t),
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * t),
    yaw: wrapAngle(a.yaw + dy * t),
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    projection: b.projection,
    fovY: a.fovY + (b.fovY - a.fovY) * t,
  };
}
