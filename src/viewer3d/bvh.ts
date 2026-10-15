/**
 * 범위 나무(BVH): 삼각형·선분·점을 담는다. 고르기를 빠르게 하려고 쓴다.
 *
 * 만들기: 기본 도형 상자의 가운데로 모턴 부호(축마다 10비트)를 만들고, 기수 정렬로 늘어놓은 뒤
 * 위에서 아래로 "부호가 처음 달라지는 비트"에서 나눈다(부호가 같으면 가운데). O(n log n)에 가깝고
 * 형식 배열만 쓰므로 수백만 개도 한 번에 만든다. 자식 마디는 부모보다 뒤에 놓여 상자를 거꾸로 훑어 채운다.
 *
 * 마디 배열: box = 마디마다 [minx, miny, minz, maxx, maxy, maxz],
 * node = 마디마다 [a, n] — n > 0 이면 잎(order[a..a+n)), n = 0 이면 속마디(자식 a, a+1).
 */

export type PrimKind = 'triangle' | 'segment' | 'point';

export interface Bvh {
  kind: PrimKind;
  box: Float32Array;
  node: Uint32Array;
  nodeCount: number;
  /** 정렬된 기본 도형 번호 */
  order: Uint32Array;
  /** 기본 도형 수 */
  count: number;
}

/** 기본 도형 수 */
export function primCount(kind: PrimKind, positions: Float32Array, indices?: Uint32Array): number {
  if (kind === 'triangle') return indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
  if (kind === 'segment') return Math.floor(positions.length / 6);
  return Math.floor(positions.length / 3);
}

/** 기본 도형 i의 정점 번호(삼각형은 3개, 선분 2개, 점 1개)를 out에 쓰고 개수를 돌려준다 */
function primVerts(kind: PrimKind, indices: Uint32Array | undefined, i: number, out: Uint32Array): number {
  if (kind === 'triangle') {
    if (indices) {
      out[0] = indices[i * 3]!;
      out[1] = indices[i * 3 + 1]!;
      out[2] = indices[i * 3 + 2]!;
    } else {
      out[0] = i * 3;
      out[1] = i * 3 + 1;
      out[2] = i * 3 + 2;
    }
    return 3;
  }
  if (kind === 'segment') {
    out[0] = i * 2;
    out[1] = i * 2 + 1;
    return 2;
  }
  out[0] = i;
  return 1;
}

/** 10비트 정수의 비트 사이에 0 두 개씩 끼운다 */
function spread3(v: number): number {
  v &= 0x3ff;
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v >>> 0;
}

export function buildBvh(kind: PrimKind, positions: Float32Array, indices?: Uint32Array, leafSize = kind === 'triangle' ? 4 : 8): Bvh {
  const n = primCount(kind, positions, indices);
  const vs = new Uint32Array(3);
  const P = positions;
  // 1) 기본 도형 가운데의 범위
  let c0x = Infinity, c0y = Infinity, c0z = Infinity, c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
  const cen = (i: number, o: Float64Array): void => {
    const k = primVerts(kind, indices, i, vs);
    let ax = Infinity, ay = Infinity, az = Infinity, bx = -Infinity, by = -Infinity, bz = -Infinity;
    for (let j = 0; j < k; j++) {
      const v = vs[j]! * 3;
      const x = P[v]!, y = P[v + 1]!, z = P[v + 2]!;
      if (x < ax) ax = x;
      if (x > bx) bx = x;
      if (y < ay) ay = y;
      if (y > by) by = y;
      if (z < az) az = z;
      if (z > bz) bz = z;
    }
    o[0] = (ax + bx) / 2;
    o[1] = (ay + by) / 2;
    o[2] = (az + bz) / 2;
  };
  const c = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    cen(i, c);
    if (c[0]! < c0x) c0x = c[0]!;
    if (c[0]! > c1x) c1x = c[0]!;
    if (c[1]! < c0y) c0y = c[1]!;
    if (c[1]! > c1y) c1y = c[1]!;
    if (c[2]! < c0z) c0z = c[2]!;
    if (c[2]! > c1z) c1z = c[2]!;
  }
  const sx = c1x > c0x ? 1023.999 / (c1x - c0x) : 0;
  const sy = c1y > c0y ? 1023.999 / (c1y - c0y) : 0;
  const sz = c1z > c0z ? 1023.999 / (c1z - c0z) : 0;
  // 2) 모턴 부호
  let codes = new Uint32Array(n);
  let order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    cen(i, c);
    const qx = Math.min(1023, Math.max(0, ((c[0]! - c0x) * sx) | 0));
    const qy = Math.min(1023, Math.max(0, ((c[1]! - c0y) * sy) | 0));
    const qz = Math.min(1023, Math.max(0, ((c[2]! - c0z) * sz) | 0));
    codes[i] = (spread3(qx) | (spread3(qy) << 1) | (spread3(qz) << 2)) >>> 0;
    order[i] = i;
  }
  // 3) 기수 정렬(10비트씩 세 번)
  {
    let c2 = new Uint32Array(n);
    let o2 = new Uint32Array(n);
    const cnt = new Uint32Array(1024);
    for (let shift = 0; shift < 30; shift += 10) {
      cnt.fill(0);
      for (let i = 0; i < n; i++) cnt[(codes[i]! >>> shift) & 1023]!++;
      let sum = 0;
      for (let b = 0; b < 1024; b++) {
        const t = cnt[b]!;
        cnt[b] = sum;
        sum += t;
      }
      for (let i = 0; i < n; i++) {
        const code = codes[i]!;
        const d = cnt[(code >>> shift) & 1023]!++;
        c2[d] = code;
        o2[d] = order[i]!;
      }
      const tc = codes;
      codes = c2;
      c2 = tc;
      const to = order;
      order = o2;
      o2 = to;
    }
  }
  // 4) 위에서 아래로 나누기
  let cap = Math.max(1, Math.ceil((n / Math.max(1, leafSize)) * 2.5) + 1);
  let node = new Uint32Array(cap * 2);
  let nodeCount = 1;
  const grow = (): void => {
    cap *= 2;
    const nn = new Uint32Array(cap * 2);
    nn.set(node);
    node = nn;
  };
  const stack: number[] = [0, 0, n];
  while (stack.length) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    const ni = stack.pop()!;
    if (hi - lo <= leafSize) {
      // 빈 나무(n = 0)의 뿌리는 a = 0xffffffff, n = 0으로 표시한다
      node[ni * 2] = hi > lo ? lo : 0xffffffff;
      node[ni * 2 + 1] = hi - lo;
      continue;
    }
    const split = findSplit(codes, lo, hi);
    if (nodeCount + 2 > cap) grow();
    const li = nodeCount;
    nodeCount += 2;
    node[ni * 2] = li;
    node[ni * 2 + 1] = 0;
    stack.push(li, lo, split, li + 1, split, hi);
  }
  // 5) 상자: 자식이 부모보다 뒤에 있으므로 거꾸로 채운다
  const box = new Float32Array(nodeCount * 6);
  for (let ni = nodeCount - 1; ni >= 0; ni--) {
    const a = node[ni * 2]!, k = node[ni * 2 + 1]!;
    let ax = Infinity, ay = Infinity, az = Infinity, bx = -Infinity, by = -Infinity, bz = -Infinity;
    if (k > 0) {
      for (let j = a; j < a + k; j++) {
        const m = primVerts(kind, indices, order[j]!, vs);
        for (let q = 0; q < m; q++) {
          const v = vs[q]! * 3;
          const x = P[v]!, y = P[v + 1]!, z = P[v + 2]!;
          if (x < ax) ax = x;
          if (x > bx) bx = x;
          if (y < ay) ay = y;
          if (y > by) by = y;
          if (z < az) az = z;
          if (z > bz) bz = z;
        }
      }
    } else if (a !== 0xffffffff) {
      for (const ch of [a, a + 1]) {
        const o = ch * 6;
        if (box[o]! < ax) ax = box[o]!;
        if (box[o + 1]! < ay) ay = box[o + 1]!;
        if (box[o + 2]! < az) az = box[o + 2]!;
        if (box[o + 3]! > bx) bx = box[o + 3]!;
        if (box[o + 4]! > by) by = box[o + 4]!;
        if (box[o + 5]! > bz) bz = box[o + 5]!;
      }
    }
    const o = ni * 6;
    box[o] = ax;
    box[o + 1] = ay;
    box[o + 2] = az;
    box[o + 3] = bx;
    box[o + 4] = by;
    box[o + 5] = bz;
  }
  return { kind, box, node: node.subarray(0, nodeCount * 2), nodeCount, order, count: n };
}

/** 정렬된 부호 [lo, hi)를 처음 달라지는 비트에서 나눈다(반환: 오른쪽 시작) */
function findSplit(codes: Uint32Array, lo: number, hi: number): number {
  const first = codes[lo]!;
  const last = codes[hi - 1]!;
  if (first === last) return (lo + hi) >> 1;
  const prefix = Math.clz32(first ^ last);
  let split = lo;
  let step = hi - 1 - lo;
  do {
    step = (step + 1) >> 1;
    const ns = split + step;
    if (ns < hi - 1 && Math.clz32(first ^ codes[ns]!) > prefix) split = ns;
  } while (step > 1);
  return split + 1;
}

/**
 * 광선과 마디 상자(inflate만큼 키운)의 들어가는 t. 안 만나면 Infinity.
 * inv = 1/방향(0이면 ±Infinity)
 */
export function rayBoxEntry(box: Float32Array | Float64Array, ni: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tMax: number, inflate = 0): number {
  const o = ni * 6;
  let t0 = 0, t1 = tMax;
  let a = (box[o]! - inflate - ox) * ix, b = (box[o + 3]! + inflate - ox) * ix;
  if (a > b) [a, b] = [b, a];
  if (a > t0) t0 = a;
  if (b < t1) t1 = b;
  if (!(t0 <= t1)) return Infinity;
  a = (box[o + 1]! - inflate - oy) * iy;
  b = (box[o + 4]! + inflate - oy) * iy;
  if (a > b) [a, b] = [b, a];
  if (a > t0) t0 = a;
  if (b < t1) t1 = b;
  if (!(t0 <= t1)) return Infinity;
  a = (box[o + 2]! - inflate - oz) * iz;
  b = (box[o + 5]! + inflate - oz) * iz;
  if (a > b) [a, b] = [b, a];
  if (a > t0) t0 = a;
  if (b < t1) t1 = b;
  if (!(t0 <= t1)) return Infinity;
  return t0;
}

/** 0 나눗셈을 피한 역수(축에 나란한 광선에서 NaN이 생기지 않게) */
export const safeInv = (d: number): number => (d !== 0 ? 1 / d : Object.is(d, -0) ? -1e300 : 1e300);
const inv = safeInv;

/** 광선–삼각형(묄러–트럼보어, 양면). 맞으면 [t, u, v], 아니면 null */
export function rayTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] | null {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  const scaleRef = (Math.abs(e1x) + Math.abs(e1y) + Math.abs(e1z)) * (Math.abs(e2x) + Math.abs(e2y) + Math.abs(e2z));
  if (Math.abs(det) <= scaleRef * 1e-12 || !Number.isFinite(det)) return null;
  const id = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * id;
  if (u < -1e-7 || u > 1 + 1e-7) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * id;
  if (v < -1e-7 || u + v > 1 + 1e-7) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * id;
  return t >= 0 ? [t, u, v] : null;
}

export interface TriangleHit {
  t: number;
  /** 삼각형 번호 */
  tri: number;
  u: number;
  v: number;
}

/** 삼각형 BVH에서 가장 가까운 맞음 */
export function raycastTriangles(
  bvh: Bvh,
  positions: Float32Array,
  indices: Uint32Array | undefined,
  origin: readonly number[],
  dir: readonly number[],
  tMax = Infinity,
): TriangleHit | null {
  if (!bvh.count) return null;
  const ox = origin[0]!, oy = origin[1]!, oz = origin[2]!;
  const dx = dir[0]!, dy = dir[1]!, dz = dir[2]!;
  const ix = inv(dx), iy = inv(dy), iz = inv(dz);
  const { box, node, order } = bvh;
  const P = positions;
  let best: TriangleHit | null = null;
  let bestT = tMax;
  const stack = new Uint32Array(128);
  let sp = 0;
  if (rayBoxEntry(box, 0, ox, oy, oz, ix, iy, iz, bestT) === Infinity) return null;
  stack[sp++] = 0;
  while (sp > 0) {
    const ni = stack[--sp]!;
    const a = node[ni * 2]!, k = node[ni * 2 + 1]!;
    if (k > 0) {
      for (let j = a; j < a + k; j++) {
        const tri = order[j]!;
        let i0: number, i1: number, i2: number;
        if (indices) {
          i0 = indices[tri * 3]! * 3;
          i1 = indices[tri * 3 + 1]! * 3;
          i2 = indices[tri * 3 + 2]! * 3;
        } else {
          i0 = tri * 9;
          i1 = i0 + 3;
          i2 = i0 + 6;
        }
        const h = rayTriangle(ox, oy, oz, dx, dy, dz, P[i0]!, P[i0 + 1]!, P[i0 + 2]!, P[i1]!, P[i1 + 1]!, P[i1 + 2]!, P[i2]!, P[i2 + 1]!, P[i2 + 2]!);
        if (h && h[0] < bestT) {
          bestT = h[0];
          best = { t: h[0], tri, u: h[1], v: h[2] };
        }
      }
      continue;
    }
    if (a === 0xffffffff) continue;
    const tl = rayBoxEntry(box, a, ox, oy, oz, ix, iy, iz, bestT);
    const tr = rayBoxEntry(box, a + 1, ox, oy, oz, ix, iy, iz, bestT);
    // 가까운 쪽을 먼저(스택 위에) 놓는다
    if (sp + 2 > stack.length) continue;
    if (tl <= tr) {
      if (tr !== Infinity) stack[sp++] = a + 1;
      if (tl !== Infinity) stack[sp++] = a;
    } else {
      if (tl !== Infinity) stack[sp++] = a;
      if (tr !== Infinity) stack[sp++] = a + 1;
    }
  }
  return best;
}

/**
 * 원뿔 질의: 광선 둘레 반지름 r(t) = r0 + k·t 안에 들 수 있는 잎의 기본 도형을 모두 visit에 넘긴다.
 * (원근 투영에서 "화면 몇 화소 안"을 세계 길이로 보수적으로 바꾼 것. 정확한 판정은 visit이 한다)
 * visit이 false를 돌려주면 멈춘다.
 */
export function queryCone(
  bvh: Bvh,
  origin: readonly number[],
  dir: readonly number[],
  r0: number,
  k: number,
  tMax: number,
  visit: (prim: number) => boolean | void,
): void {
  if (!bvh.count) return;
  const ox = origin[0]!, oy = origin[1]!, oz = origin[2]!;
  const dx = dir[0]!, dy = dir[1]!, dz = dir[2]!;
  const ix = inv(dx), iy = inv(dy), iz = inv(dz);
  const adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
  const { box, node, order } = bvh;
  const stack: number[] = [0];
  while (stack.length) {
    const ni = stack.pop()!;
    const o = ni * 6;
    // 상자 안 t의 위쪽 한계(가운데 투영 + 반폭 투영)
    const hx = (box[o + 3]! - box[o]!) / 2, hy = (box[o + 4]! - box[o + 1]!) / 2, hz = (box[o + 5]! - box[o + 2]!) / 2;
    const cx = box[o]! + hx - ox, cy = box[o + 1]! + hy - oy, cz = box[o + 2]! + hz - oz;
    const tFar = cx * dx + cy * dy + cz * dz + hx * adx + hy * ady + hz * adz;
    if (tFar < 0) continue;
    const r = r0 + k * Math.min(tFar, tMax);
    if (rayBoxEntry(box, ni, ox, oy, oz, ix, iy, iz, tMax, r) === Infinity) continue;
    const a = node[ni * 2]!, n = node[ni * 2 + 1]!;
    if (n > 0) {
      for (let j = a; j < a + n; j++) if (visit(order[j]!) === false) return;
    } else if (a !== 0xffffffff) stack.push(a, a + 1);
  }
}
