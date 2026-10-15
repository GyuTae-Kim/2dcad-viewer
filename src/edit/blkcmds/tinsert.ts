/**
 * TINSERT(UI 없음): 표 셀 안에 블록을 놓을 자리·축척·회전을 계산한다.
 * 표 좌표(삽입점 원점, 표 회전·축척을 푼 좌표)의 셀 사각형에서 여백을 뺀 영역에, 셀 정렬(1 맨 위 왼쪽 … 9 맨 아래 오른쪽)대로
 * 블록의 (회전한) 범위를 맞춘다. 자동 맞춤이면 그 영역에 들어가는 가장 큰 축척을 쓴다.
 */
import type { Vec3 } from '../../core/model';

export interface CellPlacementInput {
  /** 셀 사각형(표 좌표) */
  cell: { x0: number; x1: number; y0: number; y1: number };
  /** 셀 여백(가로·세로) */
  hMargin: number;
  vMargin: number;
  /** 블록 범위(블록 좌표)와 기준점 */
  box: [number, number, number, number];
  base: { x: number; y: number };
  /** 자동 맞춤(아니면 scale을 쓴다) */
  autofit: boolean;
  scale: number;
  /** 표에 대한 블록 회전(라디안) */
  rotation: number;
  /** 셀 정렬 1~9 */
  align: number;
  /** 표 삽입점·회전·축척(X) */
  table: { insert: Vec3; angle: number; scale: number };
}

export interface CellPlacement {
  insert: Vec3;
  /** 블록 축척(표 축척을 곱한 값) */
  scale: number;
  /** 블록 회전(표 회전을 더한 값) */
  rotation: number;
}

export function cellPlacement(o: CellPlacementInput): CellPlacement {
  const c = Math.cos(o.rotation);
  const s = Math.sin(o.rotation);
  // 축척 1에서 회전한 블록 범위(기준점 원점)
  let rx0 = Infinity;
  let ry0 = Infinity;
  let rx1 = -Infinity;
  let ry1 = -Infinity;
  for (const [x, y] of [
    [o.box[0], o.box[1]],
    [o.box[2], o.box[1]],
    [o.box[2], o.box[3]],
    [o.box[0], o.box[3]],
  ] as const) {
    const dx = x - o.base.x;
    const dy = y - o.base.y;
    const X = dx * c - dy * s;
    const Y = dx * s + dy * c;
    rx0 = Math.min(rx0, X);
    ry0 = Math.min(ry0, Y);
    rx1 = Math.max(rx1, X);
    ry1 = Math.max(ry1, Y);
  }
  const ax0 = Math.min(o.cell.x0, o.cell.x1) + o.hMargin;
  const ax1 = Math.max(o.cell.x0, o.cell.x1) - o.hMargin;
  const ay0 = Math.min(o.cell.y0, o.cell.y1) + o.vMargin;
  const ay1 = Math.max(o.cell.y0, o.cell.y1) - o.vMargin;
  const bw = rx1 - rx0;
  const bh = ry1 - ry0;
  let k = o.scale;
  if (o.autofit) {
    const fx = bw > 1e-12 ? Math.max(0, ax1 - ax0) / bw : Infinity;
    const fy = bh > 1e-12 ? Math.max(0, ay1 - ay0) / bh : Infinity;
    k = Math.min(fx, fy);
    if (!Number.isFinite(k) || k <= 0) k = o.scale;
  }
  const a = Math.min(9, Math.max(1, Math.round(o.align) || 5));
  const col = (a - 1) % 3; // 0 왼쪽 1 중심 2 오른쪽
  const row = Math.floor((a - 1) / 3); // 0 위 1 중간 2 아래
  const lx = col === 0 ? ax0 - rx0 * k : col === 2 ? ax1 - rx1 * k : (ax0 + ax1) / 2 - ((rx0 + rx1) / 2) * k;
  const ly = row === 0 ? ay1 - ry1 * k : row === 2 ? ay0 - ry0 * k : (ay0 + ay1) / 2 - ((ry0 + ry1) / 2) * k;
  const t = o.table;
  const tc = Math.cos(t.angle);
  const ts = Math.sin(t.angle);
  const X = lx * t.scale;
  const Y = ly * t.scale;
  return {
    insert: { x: t.insert.x + X * tc - Y * ts, y: t.insert.y + X * ts + Y * tc, z: t.insert.z },
    scale: k * t.scale,
    rotation: t.angle + o.rotation,
  };
}
