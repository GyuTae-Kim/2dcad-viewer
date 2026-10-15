/**
 * 고르기(순수 함수): 그물은 광선–삼각형(BVH), 선분·점은 화면 거리(몇 화소 안).
 * 화면 좌표는 ViewFrame의 화소(왼쪽 위 원점)다.
 */
import { type Bvh, queryCone, raycastTriangles } from './bvh';
import { type ViewFrame, projectToScreen, screenRay, viewDepth } from './camera';
import { type V3, cross, dot, mat4Invert, normalMatrix, normalize, transformDir, transformPoint } from './math';

/** 화면 점과 2D 선분 사이 거리와 선분 매개변수 s ∈ [0, 1] */
export function pointSegmentDistance2d(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; s: number } {
  const ex = bx - ax, ey = by - ay;
  const l2 = ex * ex + ey * ey;
  let s = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  return { d: Math.hypot(ax + ex * s - px, ay + ey * s - py), s };
}

export interface SegmentScreenHit {
  /** 커서와 화면 거리(화소) */
  distPx: number;
  /** 3D 선분 위 매개변수(0 = 시작, 1 = 끝) */
  t: number;
  point: V3;
  depth: number;
}

/**
 * 세계 선분 a–b를 화면에 그려 커서(cx, cy)와의 거리를 잰다.
 * 원근에서 눈 뒤로 넘어간 부분은 가까운 면에서 자른다. 전부 뒤면 null.
 */
export function segmentScreenPick(
  f: ViewFrame,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number,
): SegmentScreenHit | null {
  const m = f.viewProj;
  let x0 = m[0]! * ax + m[4]! * ay + m[8]! * az + m[12]!;
  let y0 = m[1]! * ax + m[5]! * ay + m[9]! * az + m[13]!;
  let z0 = m[2]! * ax + m[6]! * ay + m[10]! * az + m[14]!;
  let w0 = m[3]! * ax + m[7]! * ay + m[11]! * az + m[15]!;
  let x1 = m[0]! * bx + m[4]! * by + m[8]! * bz + m[12]!;
  let y1 = m[1]! * bx + m[5]! * by + m[9]! * bz + m[13]!;
  let z1 = m[2]! * bx + m[6]! * by + m[10]! * bz + m[14]!;
  let w1 = m[3]! * bx + m[7]! * by + m[11]! * bz + m[15]!;
  let t0 = 0, t1 = 1;
  if (f.projection === 'perspective') {
    const d0 = z0 + w0, d1 = z1 + w1;
    if (d0 < 0 && d1 < 0) return null;
    if (d0 < 0) {
      const k = d0 / (d0 - d1);
      x0 += (x1 - x0) * k;
      y0 += (y1 - y0) * k;
      z0 += (z1 - z0) * k;
      w0 += (w1 - w0) * k;
      t0 = k;
    } else if (d1 < 0) {
      const k = d1 / (d1 - d0);
      x1 += (x0 - x1) * k;
      y1 += (y0 - y1) * k;
      z1 += (z0 - z1) * k;
      w1 += (w0 - w1) * k;
      t1 = 1 - k;
    }
    if (w0 <= 1e-12 || w1 <= 1e-12) return null;
  }
  const W = f.width, H = f.height;
  const sx0 = ((x0 / w0 + 1) / 2) * W, sy0 = ((1 - y0 / w0) / 2) * H;
  const sx1 = ((x1 / w1 + 1) / 2) * W, sy1 = ((1 - y1 / w1) / 2) * H;
  const r = pointSegmentDistance2d(cx, cy, sx0, sy0, sx1, sy1);
  // 화면 매개변수 → 3D 매개변수(원근 보정)
  const s = r.s;
  const den = (1 - s) * w1 + s * w0;
  const tt = den !== 0 ? (s * w0) / den : s;
  const t = t0 + (t1 - t0) * tt;
  const point: V3 = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t];
  return { distPx: r.d, t, point, depth: viewDepth(f, point) };
}

/** 같은 거리(가장 가까운 것에서 이만큼 화소 안)면 앞에 있는 것을 고른다 */
export const TIE_PX = 0.75;

/**
 * 후보 가운데 고르기(차례와 무관): 화면 거리가 가장 짧은 것에서 TIE_PX 안에 드는 것들 중 가장 앞(깊이 작은) 것
 */
export function chooseNearest<T extends { distPx: number; depth: number }>(cands: readonly T[]): T | null {
  let dmin = Infinity;
  for (const c of cands) if (c.distPx < dmin) dmin = c.distPx;
  let best: T | null = null;
  for (const c of cands) if (c.distPx <= dmin + TIE_PX && (!best || c.depth < best.depth || (c.depth === best.depth && c.distPx < best.distPx))) best = c;
  return best;
}

/** 광선 둘레 원뿔(화면 tolPx 화소)을 세계 길이로: r(t) = r0 + k·t */
export function pickCone(f: ViewFrame, origin: V3, tolPx: number): { r0: number; k: number } {
  const slack = 1.3; // 화면 가장자리의 늘어남 등 보수적 여유
  if (f.projection === 'perspective') {
    const d0 = Math.max(viewDepth(f, origin), 0);
    return { r0: tolPx * f.pixelPerDepth * d0 * slack + 1e-12, k: tolPx * f.pixelPerDepth * slack };
  }
  return { r0: tolPx * f.pixelConst * slack + 1e-12, k: 0 };
}

export interface LinePick {
  /** 배열 안 선분 번호 */
  index: number;
  t: number;
  point: V3;
  distPx: number;
  depth: number;
}

export interface LinePickOpts {
  /** 이 개수 앞의 선분만(그리기 범위) */
  limit?: number;
  /** 이 깊이보다 뒤는 버린다(면에 가린 것) */
  maxDepth?: number;
}

/** 선분 묶음에서 커서에 가장 가까운 선분(tolPx 안). bvh가 없으면 모두 훑는다 */
export function pickSegments(f: ViewFrame, positions: Float32Array, bvh: Bvh | null, cx: number, cy: number, tolPx: number, opts: LinePickOpts = {}): LinePick | null {
  const n = Math.floor(positions.length / 6);
  const limit = Math.min(n, opts.limit ?? n);
  const maxDepth = opts.maxDepth ?? Infinity;
  const P = positions;
  const cands: LinePick[] = [];
  const test = (i: number): void => {
    if (i >= limit) return;
    const o = i * 6;
    const h = segmentScreenPick(f, P[o]!, P[o + 1]!, P[o + 2]!, P[o + 3]!, P[o + 4]!, P[o + 5]!, cx, cy);
    if (!h || !(h.distPx <= tolPx) || h.depth > maxDepth) return;
    if (f.projection === 'perspective' && h.depth < f.near * 0.999) return;
    cands.push({ index: i, t: h.t, point: h.point, distPx: h.distPx, depth: h.depth });
  };
  if (bvh) {
    const ray = screenRay(f, cx, cy);
    const c = pickCone(f, ray.origin, tolPx);
    queryCone(bvh, ray.origin, ray.dir, c.r0, c.k, Infinity, (i) => {
      test(i);
    });
  } else for (let i = 0; i < limit; i++) test(i);
  return chooseNearest(cands);
}

export interface PointPick {
  index: number;
  point: V3;
  distPx: number;
  depth: number;
}

/** 점 묶음에서 커서에 가장 가까운 점(tolPx 안) */
export function pickPointSet(f: ViewFrame, positions: Float32Array, bvh: Bvh | null, cx: number, cy: number, tolPx: number, maxDepth = Infinity): PointPick | null {
  const n = Math.floor(positions.length / 3);
  const P = positions;
  const cands: PointPick[] = [];
  const test = (i: number): void => {
    const p: V3 = [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
    const s = projectToScreen(f, p);
    if (!s) return;
    const d = Math.hypot(s[0] - cx, s[1] - cy);
    if (!(d <= tolPx) || s[2] > maxDepth) return;
    if (f.projection === 'perspective' && s[2] < f.near * 0.999) return;
    cands.push({ index: i, point: p, distPx: d, depth: s[2] });
  };
  if (bvh) {
    const ray = screenRay(f, cx, cy);
    const c = pickCone(f, ray.origin, tolPx);
    queryCone(bvh, ray.origin, ray.dir, c.r0, c.k, Infinity, (i) => {
      test(i);
    });
  } else for (let i = 0; i < n; i++) test(i);
  return chooseNearest(cands);
}

export interface MeshPick {
  tri: number;
  point: V3;
  normal: V3;
  depth: number;
  /** 맞은 삼각형의 세 꼭짓점(세계 좌표) — 꼭짓점 붙잡기에 쓴다 */
  corners: [V3, V3, V3];
}

/** 그물 하나에 광선 쏘기(행렬이 있으면 광선을 로컬로 옮긴다) */
export function pickMeshRay(
  f: ViewFrame,
  ray: { origin: V3; dir: V3 },
  positions: Float32Array,
  indices: Uint32Array | undefined,
  bvh: Bvh,
  matrix?: ArrayLike<number> | null,
): MeshPick | null {
  let lo: V3 = ray.origin, ld: V3 = ray.dir;
  if (matrix) {
    const inv = mat4Invert(matrix);
    if (!inv) return null;
    lo = transformPoint(inv, ray.origin);
    // 정규화하지 않는다: 그러면 로컬 t가 세계 t와 같다
    ld = transformDir(inv, ray.dir);
  }
  const h = raycastTriangles(bvh, positions, indices, lo, ld);
  if (!h) return null;
  const P = positions;
  const vi = (k: number): number => (indices ? indices[h.tri * 3 + k]! : h.tri * 3 + k) * 3;
  const corner = (k: number): V3 => {
    const o = vi(k);
    const p: V3 = [P[o]!, P[o + 1]!, P[o + 2]!];
    return matrix ? transformPoint(matrix, p) : p;
  };
  const a = corner(0), b = corner(1), c = corner(2);
  const point: V3 = [ray.origin[0] + ray.dir[0] * h.t, ray.origin[1] + ray.dir[1] * h.t, ray.origin[2] + ray.dir[2] * h.t];
  let normal = normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
  if (matrix && !(normal[0] || normal[1] || normal[2])) normal = normalize(transformDir(normalMatrix(matrix), [0, 0, 1]));
  if (dot(normal, ray.dir) > 0) normal = [-normal[0], -normal[1], -normal[2]];
  return { tri: h.tri, point, normal, depth: viewDepth(f, point), corners: [a, b, c] };
}

/** 후보 점 가운데 커서에서 tolPx 안에 있는 가장 가까운 점(꼭짓점 붙잡기) */
export function snapToNearest(f: ViewFrame, candidates: readonly V3[], cx: number, cy: number, tolPx: number): V3 | null {
  let best: V3 | null = null;
  let bd = tolPx;
  for (const p of candidates) {
    const s = projectToScreen(f, p);
    if (!s) continue;
    const d = Math.hypot(s[0] - cx, s[1] - cy);
    if (d <= bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
