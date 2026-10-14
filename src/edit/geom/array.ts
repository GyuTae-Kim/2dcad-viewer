/**
 * 비연관 배열(ARRAYRECT·ARRAYPOLAR, 연관 = 아니오): 원본은 그대로 두고 복사본을 add로 돌려준다.
 * - 직사각형: 열은 +X, 행은 +Y 방향(angle만큼 돌린다). 간격이 음수면 반대쪽.
 * - 원형: fillAngle이 360°(±2π)면 간격 = 채울 각도 / 개수, 아니면 / (개수 − 1). 양수 = 반시계.
 *   rotateItems가 거짓이면 항목은 돌리지 않고 기준점(기본: 선택 범위의 중심)이 원을 따라 옮겨 간 만큼 이동한다.
 */
import type { CadDocument, Entity, Vec2 } from '../../core/model';
import { createDocument } from '../../core/model';
import { type Affine, TAU, affRotate, affTranslate } from './math';
import { boundsOf, copyEntity } from './query';
import { type EditResult, mergeResults } from './types';

function copies(list: readonly Entity[], mats: Affine[], doc: CadDocument): EditResult {
  const parts: EditResult[] = [];
  for (const m of mats) for (const e of list) parts.push(copyEntity(e, m, doc));
  return mergeResults(parts);
}

/** 직사각형 배열(첫 항목 = 원본은 빼고 복사본만) */
export function arrayRectangular(list: Entity[], rows: number, cols: number, rowSpacing: number, colSpacing: number, angle = 0, doc: CadDocument = createDocument()): EditResult {
  const R = Math.max(1, Math.floor(rows));
  const C = Math.max(1, Math.floor(cols));
  if (R * C > 100000) return { message: '배열 항목이 너무 많습니다.' };
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const mats: Affine[] = [];
  for (let i = 0; i < R; i++)
    for (let j = 0; j < C; j++) {
      if (i === 0 && j === 0) continue;
      const x = j * colSpacing;
      const y = i * rowSpacing;
      mats.push(affTranslate(c * x - s * y, s * x + c * y));
    }
  return copies(list, mats, doc);
}

/** 원형 배열(fillAngle 라디안, 양수 = 반시계). base는 회전하지 않는 항목의 기준점 */
export function arrayPolar(list: Entity[], center: Vec2, count: number, fillAngle: number, rotateItems: boolean, doc: CadDocument = createDocument(), base?: Vec2): EditResult {
  const n = Math.max(1, Math.floor(count));
  if (n > 100000) return { message: '배열 항목이 너무 많습니다.' };
  if (n < 2 || !(Math.abs(fillAngle) > 0)) return {};
  const full = Math.abs(Math.abs(fillAngle) - TAU) < 1e-9 || Math.abs(fillAngle) > TAU;
  const step = full ? (Math.sign(fillAngle) * TAU) / n : fillAngle / (n - 1);
  let b = base;
  if (!rotateItems && !b) {
    const bx = boundsOf(list, doc);
    b = bx ? { x: (bx.minX + bx.maxX) / 2, y: (bx.minY + bx.maxY) / 2 } : center;
  }
  const mats: Affine[] = [];
  for (let k = 1; k < n; k++) {
    const R = affRotate(step * k, center);
    if (rotateItems) mats.push(R);
    else {
      const ca = Math.cos(step * k);
      const sa = Math.sin(step * k);
      const dx = b!.x - center.x;
      const dy = b!.y - center.y;
      const nx = center.x + ca * dx - sa * dy;
      const ny = center.y + sa * dx + ca * dy;
      mats.push(affTranslate(nx - b!.x, ny - b!.y));
    }
  }
  return copies(list, mats, doc);
}
