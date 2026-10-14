/** 이미지·PDF 언더레이 자르기: 도면 좌표 ↔ 경계 좌표 */
import { describe, expect, it } from 'vitest';
import { entityDefaults, type ImageEntity, type UnderlayEntity } from '../../src/core/model';
import { imageWithClip, imageWithoutClip, underlayWithClip, underlayWithoutClip, worldToImagePixel, worldToUnderlay } from '../../src/edit/imageclip';
import { wipeoutPolygon } from '../../src/edit/geom/markup';

const img = (): ImageEntity => ({
  ...entityDefaults(),
  type: 'IMAGE',
  handle: '50',
  insert: { x: 10, y: 20, z: 0 },
  uVector: { x: 0.5, y: 0, z: 0 },
  vVector: { x: 0, y: 0.5, z: 0 },
  imageSize: { x: 200, y: 100 },
  displayFlags: 7,
  clipping: false,
  brightness: 50,
  contrast: 50,
  fade: 0,
  clipBoundaryType: 1,
  clipBoundary: [],
});

describe('이미지 자르기', () => {
  it('삽입점은 왼쪽 아래 픽셀 모서리, 위로 갈수록 픽셀 y가 줄어든다', () => {
    expect(worldToImagePixel(img(), { x: 10, y: 20 })).toEqual({ x: -0.5, y: 99.5 });
    expect(worldToImagePixel(img(), { x: 110, y: 70 })).toEqual({ x: 199.5, y: -0.5 });
  });

  it('사각형·폴리곤 경계를 넣으면 다각형이 같은 도면 좌표로 돌아온다', () => {
    const r = imageWithClip(img(), [{ x: 30, y: 30 }, { x: 60, y: 50 }], false)!;
    expect(r.clipping).toBe(true);
    expect(r.clipBoundaryType).toBe(1);
    const poly = wipeoutPolygon(r);
    expect(poly.map((p) => [+p.x.toFixed(9), +p.y.toFixed(9)])).toEqual([
      [30, 50],
      [60, 50],
      [60, 30],
      [30, 30],
    ]);
    const tri = imageWithClip(img(), [{ x: 20, y: 25 }, { x: 80, y: 25 }, { x: 50, y: 60 }], true)!;
    expect(tri.clipBoundaryType).toBe(2);
    expect(tri.clipBoundary).toHaveLength(4);
    expect(tri.clipInverted).toBe(true);
    expect(imageWithoutClip(tri)).toMatchObject({ clipping: false, clipBoundaryType: 1 });
    expect(imageWithoutClip(tri).clipInverted).toBeUndefined();
  });
});

describe('언더레이 자르기', () => {
  const u: UnderlayEntity = { ...entityDefaults(), type: 'PDFUNDERLAY', handle: '60', insert: { x: 100, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 1 }, rotation: Math.PI / 2, flags: 2, contrast: 20, fade: 0, clipBoundary: [] };
  it('삽입·회전·축척을 되돌린 지역 좌표', () => {
    const p = worldToUnderlay(u, { x: 100, y: 10 })!;
    expect(p.x).toBeCloseTo(5, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });
  it('켜기·반전 비트와 지우기', () => {
    const c = underlayWithClip(u, [{ x: 90, y: 0 }, { x: 100, y: 10 }], true)!;
    expect(c.flags & 1).toBe(1);
    expect(c.flags & 16).toBe(16);
    expect(c.clipBoundary).toHaveLength(2);
    expect(underlayWithoutClip(c)).toMatchObject({ flags: 2, clipBoundary: [] });
  });
});
