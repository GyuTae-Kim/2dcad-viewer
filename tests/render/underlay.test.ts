/** PDF 언더레이: 지역 좌표(인치) → 도면, 페이지 UV, 자르기·반전, 파일이 없을 때 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, UnderlayDefObject, UnderlayEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { buildSpace, pdfPageNumber, pdfUnderlayKey } from '../../src/render/build';
import { TextEngine } from '../../src/text/layout';
import { add, newDoc } from '../hatch/helpers';

const KEY = 'pdf:sheet.pdf#2';

function doc1(over: Partial<UnderlayEntity> = {}): CadDocument {
  const doc = newDoc();
  const def: UnderlayDefObject = { type: 'PDFDEFINITION', handle: 'D1', fileName: 'C:\\work\\Sheet.PDF', name: '2' };
  doc.objects.set('D1', def);
  const e: UnderlayEntity = {
    ...entityDefaults(),
    handle: 'E1',
    type: 'PDFUNDERLAY',
    definition: 'D1',
    insert: { x: 100, y: 50, z: 0 },
    scale: { x: 2, y: 2, z: 2 },
    rotation: 0,
    flags: 2,
    contrast: 100,
    fade: 0,
    clipBoundary: [],
    ...over,
  };
  add(doc, e);
  return doc;
}

const build = (doc: CadDocument, pages?: Map<string, readonly [number, number]>) => buildSpace(doc, '*Model_Space', { text: new TextEngine(null), pdfPages: pages });
const pages = new Map([[KEY, [10, 5] as const]]);

/** 이미지 삼각형 넓이(도면 단위) */
function area(v: Float32Array): number {
  let a = 0;
  for (let i = 0; i + 11 < v.length; i += 12) a += Math.abs((v[i + 4]! - v[i]!) * (v[i + 9]! - v[i + 1]!) - (v[i + 8]! - v[i]!) * (v[i + 5]! - v[i + 1]!)) / 2;
  return a;
}

describe('PDF 언더레이', () => {
  it('열쇠는 파일 이름(소문자)과 페이지 번호', () => {
    expect(pdfUnderlayKey(doc1(), { definition: 'D1' })).toBe(KEY);
    expect(pdfPageNumber('')).toBe(1);
    expect(pdfPageNumber('3')).toBe(3);
  });

  it('페이지가 연결되면 페이지 전체를 축척대로 그린다', () => {
    const s = build(doc1(), pages);
    const im = s.list.images!;
    expect(im).toHaveLength(1);
    expect(im[0]!.key).toBe(KEY);
    expect(im[0]!.transparent).toBe(true);
    expect(area(im[0]!.verts)).toBeCloseTo(10 * 2 * 5 * 2, 6);
    // 범위: 삽입점 + 페이지 크기 × 축척
    expect(s.list.minX).toBeCloseTo(100);
    expect(s.list.maxX).toBeCloseTo(120);
    expect(s.list.maxY).toBeCloseTo(60);
    // 왼쪽 아래 꼭짓점의 UV = (0, 1)
    const v = im[0]!.verts;
    let found = false;
    for (let i = 0; i < v.length; i += 4) if (Math.abs(v[i]! + im[0]!.ox - 100) < 1e-9 && Math.abs(v[i + 1]! + im[0]!.oy - 50) < 1e-9) found = v[i + 2] === 0 && v[i + 3] === 1;
    expect(found).toBe(true);
  });

  it('자르기 경계(두 점 = 사각형)는 페이지 안쪽만, 반전이면 나머지', () => {
    const clip = [
      { x: 2, y: 1 },
      { x: 12, y: 4 }, // 페이지(10 × 5) 밖으로 나간다
    ];
    const a = build(doc1({ flags: 3, clipBoundary: clip }), pages).list.images!;
    expect(area(a[0]!.verts)).toBeCloseTo(8 * 3 * 4, 6);
    const b = build(doc1({ flags: 3 | 16, clipBoundary: [{ x: 2, y: 1 }, { x: 6, y: 4 }] }), pages).list.images!;
    expect(area(b[0]!.verts)).toBeCloseTo((50 - 4 * 3) * 4, 6);
  });

  it('표시를 끄면(플래그 2 없음) 그림 없이 테두리만, 파일이 없으면 경계만', () => {
    expect(build(doc1({ flags: 0 }), pages).list.images).toBeUndefined();
    const none = build(doc1({ flags: 3, clipBoundary: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }));
    expect(none.list.images).toBeUndefined();
    expect(none.list.chunks.reduce((n, c) => n + c.segCount, 0)).toBe(4);
  });

  it('단색·배경 맞춤·흐리기를 넘긴다', () => {
    const im = build(doc1({ flags: 2 | 4 | 8, fade: 40 }), pages).list.images![0]!;
    expect(im.mono).toBe(true);
    expect(im.adjust).toBe(true);
    expect(im.fade).toBe(40);
  });
});
