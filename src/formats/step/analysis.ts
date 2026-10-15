/**
 * 그물 점검 도구: 물샐틈없음(삼각형 모서리 짝), 넓이, 경계 상자.
 */

export interface WatertightReport {
  /** 넓이 있는 삼각형 수 */
  triangles: number;
  /** 서로 다른 모서리 수(위치로 용접) */
  edges: number;
  /** 정확히 두 삼각형이 반대 방향으로 쓰는 모서리 */
  paired: number;
  /** 한 삼각형만 쓰는 모서리(틈) */
  open: number;
  /** 셋 이상이 쓰거나 같은 방향으로 두 번 쓰는 모서리 */
  bad: number;
  /** paired / edges */
  ratio: number;
}

/**
 * 정점을 위치로 용접한 뒤 모서리마다 쓰임을 센다. 닫힌 입체면 모든 모서리가 짝을 이뤄야 한다.
 * @param weld 용접 격자 크기(기본: 상자 대각선 × 1e-7)
 */
export function watertightness(positions: ArrayLike<number>, indices?: ArrayLike<number>, weld?: number): WatertightReport {
  const nv = positions.length / 3;
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++)
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k]!;
      if (v < lo[k]!) lo[k] = v;
      if (v > hi[k]!) hi[k] = v;
    }
  if (!Number.isFinite(lo[0]!)) {
    lo = [0, 0, 0];
    hi = [0, 0, 0];
  }
  const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) || 1;
  const q = weld ?? diag * 1e-7;
  const ids = new Int32Array(nv);
  const map = new Map<string, number>();
  for (let i = 0; i < nv; i++) {
    const key = `${Math.round(positions[i * 3]! / q)},${Math.round(positions[i * 3 + 1]! / q)},${Math.round(positions[i * 3 + 2]! / q)}`;
    let id = map.get(key);
    if (id === undefined) map.set(key, (id = map.size));
    ids[i] = id;
  }
  const idx = indices ?? Array.from({ length: nv }, (_, i) => i);
  const fwd = new Map<number, number>();
  const K = 2 ** 26;
  let tris = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = ids[idx[t]!]!;
    const b = ids[idx[t + 1]!]!;
    const c = ids[idx[t + 2]!]!;
    if (a === b || b === c || c === a) continue;
    tris++;
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = x * K + y;
      fwd.set(k, (fwd.get(k) ?? 0) + 1);
    }
  }
  let edges = 0;
  let paired = 0;
  let open = 0;
  let bad = 0;
  const seen = new Set<number>();
  for (const [k, n] of fwd) {
    const x = Math.floor(k / K);
    const y = k - x * K;
    const canon = x < y ? x * K + y : y * K + x;
    if (seen.has(canon)) continue;
    seen.add(canon);
    edges++;
    const r = fwd.get(y * K + x) ?? 0;
    if (n === 1 && r === 1) paired++;
    else if (n + r === 1) open++;
    else bad++;
  }
  return { triangles: tris, edges, paired, open, bad, ratio: edges ? paired / edges : 0 };
}

/** 삼각형 넓이 합 */
export function meshArea(positions: ArrayLike<number>, indices?: ArrayLike<number>): number {
  const n = indices ? indices.length : positions.length / 3;
  const at = (i: number) => (indices ? indices[i]! : i);
  let s = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = at(t) * 3;
    const b = at(t + 1) * 3;
    const c = at(t + 2) * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}

/** 부호 있는 부피(바깥 법선 닫힌 그물이면 양수) */
export function meshVolume(positions: ArrayLike<number>, indices?: ArrayLike<number>): number {
  const n = indices ? indices.length : positions.length / 3;
  const at = (i: number) => (indices ? indices[i]! : i);
  let s = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = at(t) * 3;
    const b = at(t + 1) * 3;
    const c = at(t + 2) * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    s += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return s / 6;
}
