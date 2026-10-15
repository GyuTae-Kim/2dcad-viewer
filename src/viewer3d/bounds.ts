/**
 * 범위 계산: 그물·선분·점의 축 나란 상자. 같은 형식 배열은 한 번만 훑는다(WeakMap 캐시).
 * 행렬이 있는 그물은 로컬 상자의 꼭짓점 8개만 옮겨 넓힌다(충분히 보수적이고 빠르다).
 */
import type { Box3, LineSet3d, Mesh3d, PointSet3d, Scene3d } from './types';
import { type V3, transformPoint } from './math';

export function emptyBox(): Box3 {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function boxIsEmpty(b: Box3): boolean {
  return !(b.min[0] <= b.max[0] && b.min[1] <= b.max[1] && b.min[2] <= b.max[2]);
}

export function boxCenter(b: Box3): V3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function boxSize(b: Box3): V3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** 대각선 길이(빈 상자는 0) */
export function boxDiagonal(b: Box3): number {
  if (boxIsEmpty(b)) return 0;
  const s = boxSize(b);
  return Math.hypot(s[0], s[1], s[2]);
}

export function expandPoint(b: Box3, x: number, y: number, z: number): void {
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
}

export function unionBox(a: Box3, b: Box3): Box3 {
  const o = emptyBox();
  if (!boxIsEmpty(a)) {
    expandPoint(o, a.min[0], a.min[1], a.min[2]);
    expandPoint(o, a.max[0], a.max[1], a.max[2]);
  }
  if (!boxIsEmpty(b)) {
    expandPoint(o, b.min[0], b.min[1], b.min[2]);
    expandPoint(o, b.max[0], b.max[1], b.max[2]);
  }
  return o;
}

export function boxCorners(b: Box3): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < 8; i++) out.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
  return out;
}

/** 행렬로 옮긴 상자(꼭짓점 8개를 감싸는 상자) */
export function transformBox(b: Box3, m: ArrayLike<number>): Box3 {
  if (boxIsEmpty(b)) return emptyBox();
  const o = emptyBox();
  for (const c of boxCorners(b)) {
    const p = transformPoint(m, c);
    expandPoint(o, p[0], p[1], p[2]);
  }
  return o;
}

const cache = new WeakMap<Float32Array, Box3>();

/** xyz… 배열의 범위(같은 배열은 캐시) */
export function positionsBox(p: Float32Array): Box3 {
  const hit = cache.get(p);
  if (hit) return hit;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const n = p.length - (p.length % 3);
  for (let i = 0; i < n; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    // NaN·무한대는 건너뛴다(비교가 모두 거짓이 되도록 한 번에 거른다)
    if (!(x - x === 0 && y - y === 0 && z - z === 0)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const b: Box3 = { min: [x0, y0, z0], max: [x1, y1, z1] };
  cache.set(p, b);
  return b;
}

export function meshBounds(m: Mesh3d): Box3 {
  const b = positionsBox(m.positions);
  return m.matrix ? transformBox(b, m.matrix) : copyBox(b);
}

export function lineBounds(l: LineSet3d): Box3 {
  return copyBox(positionsBox(l.positions));
}

export function pointBounds(p: PointSet3d): Box3 {
  return copyBox(positionsBox(p.positions));
}

export function copyBox(b: Box3): Box3 {
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}

/** 장면 전체 범위. keep이 있으면 그 항목만 */
export function sceneBounds(scene: Scene3d, keep?: (item: Mesh3d | LineSet3d | PointSet3d) => boolean): Box3 {
  let b = emptyBox();
  for (const m of scene.meshes) if (!keep || keep(m)) b = unionBox(b, meshBounds(m));
  for (const l of scene.lines) if (!keep || keep(l)) b = unionBox(b, lineBounds(l));
  for (const p of scene.points ?? []) if (!keep || keep(p)) b = unionBox(b, pointBounds(p));
  return b;
}

/** 상자를 감싸는 구 */
export function boxSphere(b: Box3): { center: V3; radius: number } {
  if (boxIsEmpty(b)) return { center: [0, 0, 0], radius: 1 };
  return { center: boxCenter(b), radius: Math.max(boxDiagonal(b) / 2, 1e-9) };
}
