/**
 * 바닥 격자(XY 면): 범위에 맞춘 간격(1·2·5×10ⁿ), 큰 칸·작은 칸, 원점을 지나는 X·Y축 선.
 */
import type { Box3 } from './types';
import { boxIsEmpty } from './bounds';
import { niceStep } from './math';

/** 격자를 놓을 높이: 'min' = 범위 바닥, 'zero' = Z 0, 수 = 그 높이 */
export type GridZ = 'min' | 'zero' | number;

export interface GridSpec {
  step: number;
  minorStep: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z: number;
}

export function gridSpec(box: Box3, zMode: GridZ = 'min', cells = 10): GridSpec {
  let x0 = -10, x1 = 10, y0 = -10, y1 = 10, zMin = 0;
  if (!boxIsEmpty(box)) {
    x0 = box.min[0];
    x1 = box.max[0];
    y0 = box.min[1];
    y1 = box.max[1];
    zMin = box.min[2];
  }
  let ext = Math.max(x1 - x0, y1 - y0);
  if (!(ext > 0)) ext = boxIsEmpty(box) ? 20 : Math.max(box.max[2] - box.min[2], 1);
  const step = niceStep(ext / cells);
  const e = Math.floor(Math.log10(step) + 1e-9);
  const mant = Math.round(step / 10 ** e);
  const minorStep = step / (mant === 2 ? 4 : 5);
  const pad = Math.max(ext * 0.15, step);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const half = Math.max(x1 - x0, y1 - y0, ext) / 2 + pad;
  const z = zMode === 'min' ? zMin : zMode === 'zero' ? 0 : zMode;
  return {
    step,
    minorStep,
    x0: Math.floor((cx - half) / step) * step,
    x1: Math.ceil((cx + half) / step) * step,
    y0: Math.floor((cy - half) / step) * step,
    y1: Math.ceil((cy + half) / step) * step,
    z,
  };
}

export interface GridLines {
  major: Float32Array;
  minor: Float32Array;
  /** X축(y = 0) 선분, 격자 밖이면 빈 배열 */
  axisX: Float32Array;
  /** Y축(x = 0) 선분 */
  axisY: Float32Array;
}

/** 격자 선분(xyz,xyz…) */
export function gridLines(g: GridSpec): GridLines {
  const major: number[] = [];
  const minor: number[] = [];
  const eps = g.minorStep * 1e-3;
  const hasX = g.y0 <= 0 && g.y1 >= 0;
  const hasY = g.x0 <= 0 && g.x1 >= 0;
  const nx = Math.round((g.x1 - g.x0) / g.minorStep);
  const ny = Math.round((g.y1 - g.y0) / g.minorStep);
  const ratio = Math.round(g.step / g.minorStep);
  for (let i = 0; i <= nx; i++) {
    const x = g.x0 + i * g.minorStep;
    if (hasY && Math.abs(x) < eps) continue;
    (i % ratio === 0 ? major : minor).push(x, g.y0, g.z, x, g.y1, g.z);
  }
  for (let j = 0; j <= ny; j++) {
    const y = g.y0 + j * g.minorStep;
    if (hasX && Math.abs(y) < eps) continue;
    (j % ratio === 0 ? major : minor).push(g.x0, y, g.z, g.x1, y, g.z);
  }
  return {
    major: new Float32Array(major),
    minor: new Float32Array(minor),
    axisX: new Float32Array(hasX ? [g.x0, 0, g.z, g.x1, 0, g.z] : []),
    axisY: new Float32Array(hasY ? [0, g.y0, g.z, 0, g.y1, g.z] : []),
  };
}
