/** MVSETUP·LAYOUTWIZARD: 뷰포트 배열·축척·정렬, ISO 도면 틀과 제목 블록 */
import { describe, expect, it } from 'vitest';
import type { AttribEntity } from '../../src/core/model';
import { alignedViewCenter, isoSheet, modelBorder, modelToPaper, newViewport, paperToModel, parseScale, scaledViewHeight, titleBlockEntities, viewportAtPaper, viewportGrid } from '../../src/edit/filecmds/layoutgeom';

describe('뷰포트 배열', () => {
  it('2×2, 간격 10: 위 줄 왼쪽부터', () => {
    const r = viewportGrid([0, 0, 210, 110], 2, 2, 10, 10);
    expect(r).toEqual([
      [0, 60, 100, 110],
      [110, 60, 210, 110],
      [0, 0, 100, 50],
      [110, 0, 210, 50],
    ]);
  });

  it('간격이 너무 크면 빈 목록', () => {
    expect(viewportGrid([0, 0, 10, 10], 3, 1, 10, 0)).toEqual([]);
  });

  it('3열 1행', () => {
    const r = viewportGrid([0, 0, 90, 30], 3, 1);
    expect(r.map((x) => x[0])).toEqual([0, 30, 60]);
  });
});

describe('뷰포트 만들기·축척·정렬', () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 500 };

  it('맞춤: 모형 범위가 다 보이게(5% 여유)', () => {
    const v = newViewport([0, 0, 200, 100], { handle: 'A', id: 2, bounds });
    expect(v.viewCenter).toEqual({ x: 500, y: 250 });
    expect(v.viewHeight).toBeCloseTo(525);
    expect(v.paperSpace).toBe(true);
  });

  it('축척 1:10(용지/모형 0.1)', () => {
    const v = newViewport([0, 0, 200, 100], { handle: 'A', id: 2, bounds, scale: 0.1 });
    expect(v.viewHeight).toBeCloseTo(1000);
    expect(parseScale('1:10')).toBeCloseTo(0.1);
    expect(parseScale('2:1')).toBe(2);
    expect(parseScale('맞춤')).toBeNull();
    expect(scaledViewHeight(100, 1, 50)).toBe(5000);
  });

  it('수평·수직 정렬: 두 번째 뷰포트의 점이 기준점과 같은 높이·같은 x로', () => {
    const v1 = newViewport([0, 0, 100, 100], { handle: 'A', id: 2, bounds, scale: 0.1 });
    const v2 = newViewport([150, 10, 250, 90], { handle: 'B', id: 3, bounds, scale: 0.2 });
    const base = { x: 50, y: 37 };
    const target = { x: 200, y: 61 };
    const m = paperToModel(v2, target);
    const h = alignedViewCenter(v2, m, base, 'H')!;
    const moved = modelToPaper({ ...v2, viewCenter: h }, m);
    expect(moved.y).toBeCloseTo(base.y);
    expect(moved.x).toBeCloseTo(target.x);
    const vv = alignedViewCenter(v2, m, { x: 170, y: 0 }, 'V')!;
    expect(modelToPaper({ ...v2, viewCenter: vv }, m).x).toBeCloseTo(170);
    expect(viewportAtPaper([v1, v2], { x: 200, y: 50 })?.handle).toBe('B');
    expect(viewportAtPaper([v1, v2], { x: 120, y: 50 })).toBeNull();
    expect(alignedViewCenter({ ...v2, twistAngle: 0.3 }, m, base, 'H')).toBeNull();
  });
});

describe('ISO 도면 틀과 제목 블록', () => {
  it('A3 가로: 왼쪽 20, 나머지 10 mm 테두리, 오른쪽 아래 180 mm 제목 블록', () => {
    const s = isoSheet('A3', true)!;
    expect([s.w, s.h]).toEqual([420, 297]);
    expect(s.frame).toEqual([20, 10, 410, 287]);
    expect(s.title).toEqual([230, 10, 410, 46]);
    expect(s.area[1]).toBeGreaterThan(s.title[3]);
    expect(isoSheet('A4', false)!.title[0]).toBe(20);
    expect(isoSheet('B5', false)).toBeNull();
  });

  it('제목 블록 객체: 틀·중심 표시·칸 선, 칸마다 이름표와 속성 정의', () => {
    const s = isoSheet('A1', true)!;
    const ents = titleBlockEntities(s, { title: '평면도', drawn: '', number: 'A-101', scale: '1:100', date: '2026-10-15', sheet: 'ISO A1' }, { layer: 'TB' });
    const atts = ents.filter((e): e is AttribEntity => e.type === 'ATTDEF');
    expect(atts.map((a) => a.tag)).toEqual(['TITLE', 'DRAWN', 'DWGNO', 'SCALE', 'DATE', 'SHEET']);
    expect(atts.find((a) => a.tag === 'TITLE')!.text).toBe('평면도');
    expect(ents.every((e) => e.layer === 'TB')).toBe(true);
    const frame = ents[0]!;
    expect(frame.type).toBe('LWPOLYLINE');
    // 모든 객체가 용지 안
    for (const e of ents) {
      if (e.type === 'LINE') for (const p of [e.start, e.end]) expect(p.x >= 0 && p.x <= s.w && p.y >= 0 && p.y <= s.h).toBe(true);
      if (e.type === 'TEXT' || e.type === 'ATTDEF') expect(e.insert.x > s.title[0] && e.insert.y > s.title[1]).toBe(true);
    }
  });

  it('모형 공간 테두리: 용지 × 축척', () => {
    expect(modelBorder(420, 297, 100)).toEqual([0, 0, 42000, 0, 42000, 29700, 0, 29700]);
  });
});
