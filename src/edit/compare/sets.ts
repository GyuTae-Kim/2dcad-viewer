/**
 * 도면 비교의 변경 세트와 구름형 리비전 윤곽.
 *
 * 변경 세트: 차이 객체의 상자를 여백만큼 키워 두 도면 범위를 덮는 격자(기본 256×256)에 칠하고, 칠한 칸의
 * 연결 성분(상하좌우)마다 하나. 칠하기는 2차원 차분 배열이라 상자 수 + 칸 수에 비례한다.
 * 구름: 직사각형(세트 범위) 또는 폴리곤(상자 64개 이하인 세트의 합집합 윤곽, 넘으면 직사각형).
 * 호는 REVCLOUD와 같은 110° 호(src/edit/geom/markup.ts의 cloudVertices).
 */
import type { LwVertex, Vec2 } from '../../core/model';
import { cloudVertices, signedArea } from '../geom/markup';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ChangeSet {
  /** 세트 범위(여백만큼 키운 상자들의 합) */
  box: Box;
  /** 입력 상자 번호 */
  items: number[];
}

export function boxValid(b: Box | null | undefined): b is Box {
  return !!b && Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY) && b.minX <= b.maxX && b.minY <= b.maxY;
}

export function unionBox(list: Iterable<Box | null | undefined>): Box | null {
  let out: Box | null = null;
  for (const b of list) {
    if (!boxValid(b)) continue;
    if (!out) out = { ...b };
    else {
      out.minX = Math.min(out.minX, b.minX);
      out.minY = Math.min(out.minY, b.minY);
      out.maxX = Math.max(out.maxX, b.maxX);
      out.maxY = Math.max(out.maxY, b.maxY);
    }
  }
  return out;
}

export function diagonal(b: Box | null): number {
  return b ? Math.hypot(b.maxX - b.minX, b.maxY - b.minY) : 0;
}

/** 여백 = COMPARERCMARGIN/1000 × 두 도면 범위의 대각선 */
export function compareMargin(diag: number, rcMargin: number): number {
  return (Math.max(1, Math.min(25, rcMargin)) / 1000) * (diag > 0 ? diag : 1);
}

/** 구름 호 길이 = 대각선/100(여백보다 짧지 않게) */
export function cloudArc(diag: number, margin: number): number {
  return Math.max((diag > 0 ? diag : 1) / 100, margin);
}

const grow = (b: Box, m: number): Box => ({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m });

/**
 * 변경 세트. boxes = 차이 객체의 상자(범위가 없는 객체는 null), extent = 두 도면 범위.
 * 세트는 위에서 아래, 왼쪽에서 오른쪽 순서다.
 */
export function changeSets(boxes: readonly (Box | null)[], extent: Box | null, margin: number, grid = 256): ChangeSet[] {
  const valid: number[] = [];
  const grown: (Box | null)[] = boxes.map((b, i) => {
    if (!boxValid(b)) return null;
    valid.push(i);
    return grow(b, margin);
  });
  if (!valid.length) return [];
  const ext = unionBox([extent ? grow(extent, margin) : null, ...grown])!;
  const N = Math.max(1, Math.floor(grid));
  const w = Math.max(ext.maxX - ext.minX, 1e-300);
  const h = Math.max(ext.maxY - ext.minY, 1e-300);
  const cx = (x: number) => Math.max(0, Math.min(N - 1, Math.floor(((x - ext.minX) / w) * N)));
  const cy = (y: number) => Math.max(0, Math.min(N - 1, Math.floor(((y - ext.minY) / h) * N)));
  // 2차원 차분 배열로 칠한다
  const W = N + 1;
  const diff = new Int32Array(W * W);
  const cells: [number, number, number, number][] = [];
  for (const i of valid) {
    const b = grown[i]!;
    const x0 = cx(b.minX);
    const x1 = cx(b.maxX);
    const y0 = cy(b.minY);
    const y1 = cy(b.maxY);
    cells[i] = [x0, y0, x1, y1];
    diff[y0 * W + x0]! += 1;
    diff[y0 * W + x1 + 1]! -= 1;
    diff[(y1 + 1) * W + x0]! -= 1;
    diff[(y1 + 1) * W + x1 + 1]! += 1;
  }
  const filled = new Uint8Array(N * N);
  const row = new Int32Array(W);
  for (let y = 0; y < N; y++) {
    let run = 0;
    for (let x = 0; x < N; x++) {
      run += diff[y * W + x]!;
      row[x] = row[x]! + run;
      if (row[x]! > 0) filled[y * N + x] = 1;
    }
  }
  // 연결 성분(상하좌우)
  const label = new Int32Array(N * N).fill(-1);
  let nLabels = 0;
  const stack: number[] = [];
  for (let s = 0; s < N * N; s++) {
    if (!filled[s] || label[s]! >= 0) continue;
    const id = nLabels++;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % N;
      const y = (c - x) / N;
      const nb = [x > 0 ? c - 1 : -1, x < N - 1 ? c + 1 : -1, y > 0 ? c - N : -1, y < N - 1 ? c + N : -1];
      for (const n of nb) {
        if (n < 0 || !filled[n] || label[n]! >= 0) continue;
        label[n] = id;
        stack.push(n);
      }
    }
  }
  const sets: (ChangeSet | null)[] = new Array(nLabels).fill(null);
  for (const i of valid) {
    const [x0, y0] = cells[i]!;
    const id = label[y0 * N + x0]!;
    const g = grown[i]!;
    let s = sets[id];
    if (!s) sets[id] = s = { box: { ...g }, items: [] };
    else {
      s.box.minX = Math.min(s.box.minX, g.minX);
      s.box.minY = Math.min(s.box.minY, g.minY);
      s.box.maxX = Math.max(s.box.maxX, g.maxX);
      s.box.maxY = Math.max(s.box.maxY, g.maxY);
    }
    s.items.push(i);
  }
  const out = sets.filter((s): s is ChangeSet => !!s);
  const tolY = h / N;
  out.sort((a, b) => {
    const dy = b.box.maxY - a.box.maxY;
    if (Math.abs(dy) > tolY) return dy;
    return a.box.minX - b.box.minX;
  });
  return out;
}

/**
 * 직사각형들의 합집합 윤곽(반시계, 바깥 경계만 — 구멍은 뺀다).
 * 좌표 압축 격자에 칠한 뒤 칸 경계를 이어 고리를 만든다.
 */
export function unionOutlines(boxes: readonly Box[]): Vec2[][] {
  const list = boxes.filter((b) => boxValid(b) && b.maxX > b.minX && b.maxY > b.minY);
  if (!list.length) return [];
  const xs = [...new Set(list.flatMap((b) => [b.minX, b.maxX]))].sort((a, b) => a - b);
  const ys = [...new Set(list.flatMap((b) => [b.minY, b.maxY]))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const cov = new Uint8Array(nx * ny);
  for (const b of list) {
    const x0 = xi.get(b.minX)!;
    const x1 = xi.get(b.maxX)!;
    const y0 = yi.get(b.minY)!;
    const y1 = yi.get(b.maxY)!;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cov[y * nx + x] = 1;
  }
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && cov[y * nx + x] === 1;
  // 칸 경계의 방향 있는 변(안쪽이 왼쪽): 꼭짓점 번호 = y * (nx + 1) + x
  const V = nx + 1;
  const out = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const l = out.get(a);
    if (l) l.push(b);
    else out.set(a, [b]);
  };
  let edges = 0;
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) (add(y * V + x, y * V + x + 1), edges++);
      if (!at(x + 1, y)) (add(y * V + x + 1, (y + 1) * V + x + 1), edges++);
      if (!at(x, y + 1)) (add((y + 1) * V + x + 1, (y + 1) * V + x), edges++);
      if (!at(x - 1, y)) (add((y + 1) * V + x, y * V + x), edges++);
    }
  const pt = (v: number): Vec2 => ({ x: xs[v % V]!, y: ys[Math.floor(v / V)]! });
  const dir = (a: number, b: number) => {
    const ax = a % V;
    const ay = Math.floor(a / V);
    return [(b % V) - ax, Math.floor(b / V) - ay] as const;
  };
  const loops: Vec2[][] = [];
  let guard = edges + 4;
  while (out.size && guard-- > 0) {
    const start = out.keys().next().value as number;
    const loop: number[] = [start];
    let prev = -1;
    let cur = start;
    for (let n = 0; n <= edges; n++) {
      const nexts = out.get(cur);
      if (!nexts || !nexts.length) break;
      let k = 0;
      if (nexts.length > 1 && prev >= 0) {
        // 꼭짓점에서 두 고리가 만나면 왼쪽으로 꺾는 변을 고른다(고리가 섞이지 않게)
        const [dx, dy] = dir(prev, cur);
        let best = -Infinity;
        nexts.forEach((nb, i) => {
          const [ex, ey] = dir(cur, nb);
          const turn = dx * ey - dy * ex;
          if (turn > best) {
            best = turn;
            k = i;
          }
        });
      }
      const next = nexts.splice(k, 1)[0]!;
      if (!nexts.length) out.delete(cur);
      prev = cur;
      cur = next;
      if (cur === start) break;
      loop.push(cur);
    }
    // 곧은 점(같은 방향으로 이어지는 꼭짓점)을 뺀다
    const pts = loop.map(pt);
    const simple: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) > 0) simple.push(b);
    }
    if (simple.length >= 3 && signedArea(simple) > 0) loops.push(simple);
  }
  return loops;
}

/** 세트의 구름 윤곽: shape 0 직사각형, 1 폴리곤(상자 maxPoly개 이하일 때) */
export function setOutlines(set: ChangeSet, boxes: readonly (Box | null)[], margin: number, shape: number, maxPoly = 64): Vec2[][] {
  const rect = (b: Box): Vec2[] => [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
  if (shape !== 1 || set.items.length > maxPoly) return [rect(set.box)];
  const grown = set.items.map((i) => boxes[i]).filter(boxValid).map((b) => grow(b, margin));
  const loops = unionOutlines(grown);
  return loops.length ? loops : [rect(set.box)];
}

/** 윤곽 → 구름 정점(볼록도 있는 폴리선 정점, 바깥으로 볼록한 110° 호) */
export function cloudOf(outline: readonly Vec2[], arc: number): LwVertex[] {
  return cloudVertices(outline, true, { minArc: arc, maxArc: arc });
}
