/**
 * 묶음 무리(단계별 묶음): 작은 묶음(chunk)을 큰 격자 칸마다 하나로 합친 그리기 단위.
 *
 * 표시 목록의 묶음은 객체 크기 × 256 칸이라 큰 도면의 작은 객체는 수천~수만 묶음이 된다(100만 객체 합성 도면 9,010개).
 * 묶음마다 그리기 호출을 하면 전체 보기 한 장면이 수만 번의 호출이 된다. 그래서 묶음을 도면 크기의 1/8 정도 격자 칸으로 모아
 * 그 칸 중심 기준 좌표로 다시 적은 버퍼를 따로 만든다.
 * - 전체 보기처럼 무리가 화면에 다 들어오거나 작게 보일 때는 무리 하나를 한 번에 그린다.
 * - 크게 확대해 무리의 일부만 보이면(또는 무리 좌표의 float32 오차가 보일 만큼 확대하면) 원래 묶음을 골라 그린다.
 * 원래 묶음의 자료(표시 목록)는 그대로 두므로 장면 지문·편집 숨기기 범위는 바뀌지 않는다.
 */
import { type ChunkData, SEG_STRIDE, TRI_STRIDE } from './displaylist';

/** 묶음이 이보다 적으면 무리를 만들지 않는다(편집 덧그림·작은 도면) */
export const GROUP_MIN_CHUNKS = 64;

export interface ChunkGroup {
  /** 무리 좌표 원점(격자 칸 중심) */
  ox: number;
  oy: number;
  /** 들어 있는 묶음 범위의 합 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 들어 있는 묶음 번호(표시 목록 순서) */
  members: number[];
}

export interface ChunkGroupPlan {
  /** 격자 칸 크기(도면 단위, 2의 거듭제곱) */
  size: number;
  groups: ChunkGroup[];
  /** 묶음 → 무리 번호(-1: 무리에 넣지 않은 큰 묶음) */
  groupOf: Int32Array;
}

type Bounds = Pick<ChunkData, 'minX' | 'minY' | 'maxX' | 'maxY'>;

/**
 * 묶음 무리 나누기. 칸 크기는 묶음들이 덮는 범위의 1/8 이상인 가장 작은 2의 거듭제곱이고,
 * 묶음 범위가 칸보다 큰 묶음은 무리에 넣지 않는다(그런 묶음은 몇 개뿐이다).
 */
export function planChunkGroups(chunks: readonly Bounds[], min = GROUP_MIN_CHUNKS): ChunkGroupPlan | null {
  const n = chunks.length;
  if (n < min) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of chunks) {
    if (!(c.minX <= c.maxX && c.minY <= c.maxY)) continue;
    if (c.minX < minX) minX = c.minX;
    if (c.minY < minY) minY = c.minY;
    if (c.maxX > maxX) maxX = c.maxX;
    if (c.maxY > maxY) maxY = c.maxY;
  }
  const ext = Math.max(maxX - minX, maxY - minY);
  if (!(ext > 0 && Number.isFinite(ext))) return null;
  const size = Math.pow(2, Math.ceil(Math.log2(ext / 8)));
  const groupOf = new Int32Array(n).fill(-1);
  const groups: ChunkGroup[] = [];
  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const c = chunks[i]!;
    if (!(c.minX <= c.maxX && c.minY <= c.maxY)) continue;
    if (Math.max(c.maxX - c.minX, c.maxY - c.minY) > size) continue;
    const gx = Math.floor((c.minX + c.maxX) / 2 / size);
    const gy = Math.floor((c.minY + c.maxY) / 2 / size);
    const k = `${gx}:${gy}`;
    let g = at.get(k);
    if (g === undefined) {
      g = groups.length;
      at.set(k, g);
      groups.push({ ox: (gx + 0.5) * size, oy: (gy + 0.5) * size, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, members: [] });
    }
    const G = groups[g]!;
    G.members.push(i);
    if (c.minX < G.minX) G.minX = c.minX;
    if (c.minY < G.minY) G.minY = c.minY;
    if (c.maxX > G.maxX) G.maxX = c.maxX;
    if (c.maxY > G.maxY) G.maxY = c.maxY;
    groupOf[i] = g;
  }
  return { size, groups, groupOf };
}

export type ChunkKind = 'segs' | 'tris' | 'tsegs' | 'ttris';

/** 요소 하나의 4바이트 칸 수와 그중 좌표(x, y) 쌍의 자리 */
const LAYOUT: Record<ChunkKind, { stride: number; xy: number[]; count: (c: ChunkData) => number }> = {
  segs: { stride: SEG_STRIDE, xy: [0, 2], count: (c) => c.segCount },
  tsegs: { stride: SEG_STRIDE, xy: [0, 2], count: (c) => c.tsegCount },
  tris: { stride: TRI_STRIDE * 3, xy: [0, TRI_STRIDE, TRI_STRIDE * 2], count: (c) => c.triCount },
  ttris: { stride: TRI_STRIDE * 3, xy: [0, TRI_STRIDE, TRI_STRIDE * 2], count: (c) => c.ttriCount },
};

/**
 * 무리 하나의 버퍼(한 종류): 묶음 자료를 이어 붙이고 좌표를 무리 원점 기준으로 옮긴다(깊이·스타일은 그대로).
 * at[k] = members[k] 묶음이 시작하는 요소 번호(선분 또는 삼각형).
 */
export function mergeGroup(chunks: readonly ChunkData[], g: ChunkGroup, kind: ChunkKind): { data: ArrayBuffer; count: number; at: Int32Array } {
  const L = LAYOUT[kind];
  let total = 0;
  for (const m of g.members) total += L.count(chunks[m]!);
  const data = new ArrayBuffer(total * L.stride * 4);
  const at = new Int32Array(g.members.length);
  let n = 0;
  for (let k = 0; k < g.members.length; k++) {
    const c = chunks[g.members[k]!]!;
    const cn = L.count(c);
    at[k] = n;
    if (cn) rebaseInto(data, n, c, kind, 0, cn, g);
    n += cn;
  }
  return { data, count: total, at };
}

/** 묶음 c의 요소 [first, first + count)를 무리 g 원점 기준으로 옮겨 out의 요소 자리 at부터 쓴다 */
export function rebaseInto(out: ArrayBuffer, at: number, c: ChunkData, kind: ChunkKind, first: number, count: number, g: { ox: number; oy: number }): void {
  const L = LAYOUT[kind];
  const words = count * L.stride;
  const o = at * L.stride;
  const so = first * L.stride;
  // 깊이·스타일까지 그대로 옮긴 뒤 좌표만 고친다
  new Uint32Array(out, o * 4, words).set(new Uint32Array(c[kind], so * 4, words));
  const dst = new Float32Array(out, o * 4, words);
  const src = new Float32Array(c[kind], so * 4, words);
  const dx = c.ox - g.ox;
  const dy = c.oy - g.oy;
  for (let e = 0; e < words; e += L.stride)
    for (const p of L.xy) {
      dst[e + p] = src[e + p]! + dx;
      dst[e + p + 1] = src[e + p + 1]! + dy;
    }
}

/** 요소 하나의 바이트 수 */
export function elementBytes(kind: ChunkKind): number {
  return LAYOUT[kind].stride * 4;
}

/**
 * 이번 그림에서 무리를 통째로 그릴지: float32 오차(칸 크기 × 2^-24)가 1/16 픽셀 아래이고,
 * 화면 범위가 없거나 무리가 화면 안에 다 들어오거나 무리 범위가 화면 넓이의 4배 이하일 때.
 */
export function drawWhole(g: ChunkGroup, size: number, pxPerUnit: number, vis: readonly [number, number, number, number] | undefined): boolean {
  if (size * pxPerUnit > 1 << 20) return false;
  if (!vis) return true;
  if (g.minX >= vis[0] && g.maxX <= vis[2] && g.minY >= vis[1] && g.maxY <= vis[3]) return true;
  const area = (g.maxX - g.minX) * (g.maxY - g.minY);
  return area <= 4 * (vis[2] - vis[0]) * (vis[3] - vis[1]);
}
