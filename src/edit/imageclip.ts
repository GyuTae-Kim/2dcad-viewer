/**
 * 이미지·PDF 언더레이 자르기(IMAGECLIP·PDFCLIP): 도면 좌표의 경계를 각 객체의 경계 좌표로 바꿔 기록한다.
 * - 이미지: 픽셀 좌표(원점 왼쪽 위, y 아래로, 모서리 -0.5). 71 = 1 사각형(두 점), 2 다각형(닫는 점 포함), 290 반전.
 * - 언더레이: 지역 좌표(삽입·회전·축척 전). 플래그 1 자르기 켬, 16 반전.
 */
import type { ImageEntity, UnderlayEntity, Vec2 } from '../core/model';

/** 도면(평면) 점 → 이미지 픽셀 좌표 */
export function worldToImagePixel(e: ImageEntity, p: Vec2): Vec2 | null {
  const u = e.uVector;
  const v = e.vVector;
  const det = u.x * v.y - u.y * v.x;
  if (Math.abs(det) < 1e-300) return null;
  const dx = p.x - e.insert.x;
  const dy = p.y - e.insert.y;
  const x = (dx * v.y - dy * v.x) / det;
  const y = (u.x * dy - u.y * dx) / det;
  return { x: x - 0.5, y: e.imageSize.y - 0.5 - y };
}

/** 이미지에 새 경계(도면 좌표, 둘이면 사각형 구석점) */
export function imageWithClip(e: ImageEntity, world: readonly Vec2[], inverted: boolean): ImageEntity | null {
  const px = world.map((p) => worldToImagePixel(e, p));
  if (px.some((q) => !q) || px.length < 2) return null;
  const pts = px as Vec2[];
  if (pts.length === 2) {
    const [a, b] = pts as [Vec2, Vec2];
    return { ...e, clipping: true, clipBoundaryType: 1, clipBoundary: [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }], clipInverted: inverted || undefined, displayFlags: e.displayFlags | 4 };
  }
  return { ...e, clipping: true, clipBoundaryType: 2, clipBoundary: [...pts, { ...pts[0]! }], clipInverted: inverted || undefined, displayFlags: e.displayFlags | 4 };
}

/** 이미지 경계 지우기(전체 이미지 경계로) */
export function imageWithoutClip(e: ImageEntity): ImageEntity {
  const W = e.imageSize.x;
  const H = e.imageSize.y;
  const out: ImageEntity = { ...e, clipping: false, clipBoundaryType: 1, clipBoundary: [{ x: -0.5, y: -0.5 }, { x: W - 0.5, y: H - 0.5 }] };
  delete out.clipInverted;
  return out;
}

/** 도면(평면) 점 → 언더레이 지역 좌표 */
export function worldToUnderlay(e: UnderlayEntity, p: Vec2): Vec2 | null {
  const sx = e.scale.x || 1;
  const sy = e.scale.y || 1;
  const c = Math.cos(-e.rotation);
  const s = Math.sin(-e.rotation);
  const dx = p.x - e.insert.x;
  const dy = p.y - e.insert.y;
  return { x: (c * dx - s * dy) / sx, y: (s * dx + c * dy) / sy };
}

export function underlayWithClip(e: UnderlayEntity, world: readonly Vec2[], inverted: boolean): UnderlayEntity | null {
  const loc = world.map((p) => worldToUnderlay(e, p)) as Vec2[];
  if (loc.length < 2) return null;
  let pts = loc;
  if (loc.length === 2) {
    const [a, b] = loc as [Vec2, Vec2];
    pts = [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }];
  }
  return { ...e, clipBoundary: pts, flags: (e.flags | 1) & ~16 | (inverted ? 16 : 0) };
}

export function underlayWithoutClip(e: UnderlayEntity): UnderlayEntity {
  return { ...e, clipBoundary: [], flags: e.flags & ~(1 | 16) };
}
