/**
 * 2D 편집 기하 커널 공개 API(DOM 없음).
 *
 * 모든 연산은 EditResult를 돌려준다:
 * - add: 새 객체(핸들 '' — 호출한 쪽이 붙인다. 특성은 원본에서 잇는다)
 * - replace: 핸들을 지킨 채 바뀐 객체(원본과 같은 종류)
 * - remove: 지울 핸들(종류가 바뀌면 remove + add)
 * - blocks: 새 익명 블록(치수 *D, 표 *T) — 문서에 넣고 핸들을 붙인다
 * - message: 결과가 없거나 근사했을 때의 AutoCAD식 안내(한국어)
 *
 * 좌표는 WCS 평면도다. OCS 객체(extrusion (0, 0, −1) 등)는 읽을 때 바르게 풀고, 결과는 되도록 자연스러운(+Z) 객체로 쓴다.
 * 아핀 [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export type { EditResult, GripKind, GripPoint, TransformOptions } from './types';
export { MSG, mergeResults } from './types';
export type { Affine, Box } from './math';
export { affApply, affIdentity, affInv, affMirror, affMul, affRotate, affScale, affTranslate } from './math';

export { transformEntity } from './transform';
export { boundsOf, copyEntity, entityBounds, insertionPoint, intersections, nearestPointOn, reverseEntity } from './query';
export { offsetEntity } from './offset';
export { breakEntity, extendEntity, lengthenEntity, trimEntity } from './trim';
export type { LengthenMode, TrimOptions } from './trim';
export { chamfer, chamferAngle, chamferPolyline, chamferPolylineAngle, fillet, filletPolyline } from './fillet';
export type { FilletOptions } from './fillet';
export { explodeEntity, mtextToTexts } from './explode';
export { joinEntities } from './join';
export { stretch } from './stretch';
export type { StretchOptions } from './stretch';
export { gripMove, gripPoints } from './grips';
export type { GripOptions } from './grips';
export { arrayPolar, arrayRectangular } from './array';
