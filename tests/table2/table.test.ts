/** 표 정의·편집 연산·그림·스타일 원본 태그 */
import { describe, expect, it } from 'vitest';
import type { Entity, LineEntity, MTextEntity, TableEntity } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import {
  anchorOf,
  cellAt,
  cellRect,
  createTable,
  deleteCols,
  deleteRows,
  fitRowHeights,
  getText,
  insertCols,
  insertRows,
  mergeAt,
  mergeCells,
  setAlign,
  setText,
  tableHeight,
  tableWidth,
  unmergeCells,
  cellName,
} from '../../src/edit/table/model';
import { defaultTableStyle, listTableStyles, parseTableStyleRaw, rowHeightForLines, tableStyleRaw } from '../../src/edit/table/style';
import { tableBlockEntities } from '../../src/edit/table/geometry';
import { applyTableData, decodeTableXData, encodeTableXData, rawTableCells, tableFromEntity } from '../../src/edit/table/entity';
import { newTableEntity } from '../../src/edit/table/build';

const style = defaultTableStyle(true);

function sample() {
  return createTable({ cols: 3, colWidth: 60, dataRows: 3, rowLines: 1, first: 'title', second: 'header' }, style);
}

describe('표 정의', () => {
  it('새 표: 제목·머리글·데이터 행, 제목 병합, 행 높이', () => {
    const t = sample();
    expect(t.rows).toBe(5);
    expect(t.cols).toBe(3);
    expect(t.rowKinds).toEqual(['title', 'header', 'data', 'data', 'data']);
    expect(t.merges).toEqual([{ row: 0, col: 0, rows: 1, cols: 3 }]);
    expect(t.rowHeights[0]).toBeCloseTo(6 + 3);
    expect(t.rowHeights[2]).toBeCloseTo(4.5 + 3);
    expect(rowHeightForLines(2, 4.5, 1.5)).toBeCloseTo(4.5 + 7.5 + 3);
    expect(tableWidth(t)).toBe(180);
    expect(tableHeight(t)).toBeCloseTo(9 + 4 * 7.5);
  });

  it('첫 행이 데이터면 데이터 행만', () => {
    const t = createTable({ cols: 2, colWidth: 10, dataRows: 4, rowLines: 1, first: 'data', second: 'data' }, style);
    expect(t.rows).toBe(4);
    expect(t.merges).toEqual([]);
  });

  it('셀 위치·문자·병합 기준 셀', () => {
    let t = sample();
    expect(cellAt(t, 10, -1)).toEqual({ r: 0, c: 0 });
    expect(cellAt(t, 130, -12)).toEqual({ r: 1, c: 2 });
    expect(cellAt(t, -1, -1)).toBeNull();
    expect(cellAt(t, 10, 1)).toBeNull();
    expect(anchorOf(t, 0, 2)).toEqual({ r: 0, c: 0 });
    t = setText(t, 0, 2, '제목');
    expect(getText(t, 0, 0)).toBe('제목');
    expect(cellRect(t, 0, 1)).toEqual({ x0: 0, x1: 180, y0: -9, y1: -0 });
    expect(cellName(2, 27)).toBe('AB3');
  });

  it('행 넣기·빼기와 병합 이동', () => {
    let t = sample();
    t = mergeCells(t, 2, 0, 3, 0)!;
    expect(mergeAt(t, 3, 0)).toEqual({ row: 2, col: 0, rows: 2, cols: 1 });
    // 병합 가운데에 넣으면 병합이 늘어난다
    const a = insertRows(t, 3, 2);
    expect(a.rows).toBe(7);
    expect(mergeAt(a, 5, 0)).toEqual({ row: 2, col: 0, rows: 4, cols: 1 });
    // 위에 넣으면 밀린다
    const b = insertRows(t, 0, 1);
    expect(b.merges.find((m) => m.cols === 3)).toEqual({ row: 1, col: 0, rows: 1, cols: 3 });
    expect(b.rowKinds[1]).toBe('title');
    // 기준 행을 빼면 문자가 아래로 옮겨 간다
    let c = setText(t, 2, 0, '병합');
    c = deleteRows(c, 2, 2)!;
    expect(c.rows).toBe(4);
    expect(c.merges.some((m) => m.rows > 1)).toBe(false);
    expect(getText(c, 2, 0)).toBe('병합');
    // 병합 아래 행을 빼면 병합은 그대로, 제목 병합도 그대로
    const d = deleteRows(t, 4, 4)!;
    expect(mergeAt(d, 3, 0)).toEqual({ row: 2, col: 0, rows: 2, cols: 1 });
    // 병합 위 행을 빼면 위로 당겨진다
    const e = deleteRows(t, 1, 1)!;
    expect(mergeAt(e, 1, 0)).toEqual({ row: 1, col: 0, rows: 2, cols: 1 });
    expect(deleteRows(t, 0, 4)).toBeNull();
  });

  it('열 넣기·빼기', () => {
    let t = sample();
    t = setText(t, 1, 2, 'C');
    const a = insertCols(t, 1, 1, 25);
    expect(a.cols).toBe(4);
    expect(a.colWidths).toEqual([60, 25, 60, 60]);
    expect(getText(a, 1, 3)).toBe('C');
    expect(a.merges[0]).toEqual({ row: 0, col: 0, rows: 1, cols: 4 });
    const b = deleteCols(a, 0, 1)!;
    expect(b.cols).toBe(2);
    expect(getText(b, 1, 1)).toBe('C');
    expect(b.merges[0]).toEqual({ row: 0, col: 0, rows: 1, cols: 2 });
    expect(deleteCols(b, 0, 1)).toBeNull();
  });

  it('병합 방식(모두·행별·열별)과 해제', () => {
    let t = sample();
    t = setText(t, 2, 1, 'x');
    t = setText(t, 3, 2, 'y');
    const all = mergeCells(t, 2, 1, 3, 2, 'all')!;
    expect(all.merges).toContainEqual({ row: 2, col: 1, rows: 2, cols: 2 });
    expect(getText(all, 3, 2)).toBe('x');
    const rows = mergeCells(t, 2, 1, 3, 2, 'rows')!;
    expect(rows.merges.filter((m) => m.rows === 1 && m.cols === 2)).toHaveLength(2);
    expect(getText(rows, 3, 1)).toBe('y');
    const cols = mergeCells(t, 2, 1, 3, 2, 'cols')!;
    expect(cols.merges.filter((m) => m.rows === 2 && m.cols === 1)).toHaveLength(2);
    // 범위가 병합을 걸치면 넓힌다
    const wide = mergeCells(t, 0, 1, 1, 1, 'all')!;
    expect(wide.merges).toContainEqual({ row: 0, col: 0, rows: 2, cols: 3 });
    expect(unmergeCells(all, 3, 2)!.merges).toEqual(t.merges);
    expect(unmergeCells(t, 4, 2)).toBeNull();
    expect(mergeCells(t, 3, 1, 3, 1)).toBeNull();
  });

  it('문자에 맞춘 행 높이(늘었다 줄었다)', () => {
    let t = sample();
    const measure = (text: string, h: number) => text.split('\\P').length * h * (5 / 3) - h * (2 / 3);
    t = setText(t, 2, 0, '1\\P2\\P3');
    const f = fitRowHeights(t, style, measure);
    expect(f.rowHeights[2]).toBeCloseTo(4.5 * 5 - 3 + 3);
    const g = fitRowHeights(setText(f, 2, 0, ''), style, measure);
    expect(g.rowHeights[2]).toBeCloseTo(7.5);
  });
});

describe('표 그림', () => {
  it('격자선은 병합 안을 지나지 않고 문자는 정렬·여백대로', () => {
    let t = sample();
    t = setText(t, 0, 0, '제목');
    t = setText(t, 2, 1, '가');
    t = setAlign(t, 2, 1, 2, 1, 1);
    const ents = tableBlockEntities(t, style);
    const lines = ents.filter((e): e is LineEntity => e.type === 'LINE');
    // 첫 행 경계(제목 아래)는 한 줄, 제목 안 세로선은 없다
    const vInTitle = lines.filter((l) => l.start.x === l.end.x && l.start.x > 0 && l.start.x < 180 && Math.max(l.start.y, l.end.y) > -9 + 1e-9);
    expect(vInTitle).toHaveLength(0);
    const h0 = lines.filter((l) => l.start.y === l.end.y && Math.abs(l.start.y) < 1e-12);
    expect(h0).toHaveLength(1);
    expect(h0[0]!.end.x - h0[0]!.start.x).toBe(180);
    const texts = ents.filter((e): e is MTextEntity => e.type === 'MTEXT');
    expect(texts).toHaveLength(2);
    const title = texts.find((m) => m.text === '제목')!;
    expect(title.attachment).toBe(5);
    expect(title.insert.x).toBeCloseTo(90);
    expect(title.insert.y).toBeCloseTo(-4.5);
    expect(title.height).toBe(6);
    const ga = texts.find((m) => m.text === '가')!;
    expect(ga.attachment).toBe(1);
    expect(ga.insert.x).toBeCloseTo(60 + 1.5);
    expect(ga.insert.y).toBeCloseTo(-(9 + 7.5) - 1.5);
    expect(ga.width).toBeCloseTo(57);
    expect(ents.every((e) => e.layer === '0')).toBe(true);
  });

  it('위로 쌓는 표와 채우기', () => {
    const s = defaultTableStyle(true);
    s.flow = 1;
    s.cells.title.fill = { aci: 3 };
    const t = setText(sample(), 4, 0, '끝');
    const ents = tableBlockEntities(t, s);
    expect(ents[0]!.type).toBe('SOLID');
    const m = ents.find((e): e is MTextEntity => e.type === 'MTEXT')!;
    expect(m.insert.y).toBeGreaterThan(0);
    expect(cellAt(t, 1, 1, 1)).toEqual({ r: 0, c: 0 });
  });
});

describe('테이블 스타일 원본 태그', () => {
  it('쓰고 다시 읽으면 같은 값(R2004·R2018)', () => {
    const s = defaultTableStyle(false, 'Mine');
    s.flow = 1;
    s.hMargin = 0.1;
    s.cells.header.align = 7;
    s.cells.header.height = 0.3;
    s.cells.title.fill = { aci: 5 };
    s.cells.data.color = { aci: 1 };
    s.cells.data.textStyle = 'Notes';
    for (const ver of [1018, 1032]) {
      const back = parseTableStyleRaw(tableStyleRaw(s, ver), 'Mine', false);
      expect(back.flow).toBe(1);
      expect(back.hMargin).toBe(0.1);
      expect(back.cells.header.align).toBe(7);
      expect(back.cells.header.height).toBe(0.3);
      expect(back.cells.title.fill).toEqual({ aci: 5 });
      expect(back.cells.data.fill).toBeNull();
      expect(back.cells.data.color).toEqual({ aci: 1 });
      expect(back.cells.data.textStyle).toBe('Notes');
    }
  });

  it('새 도면의 Standard(원본 태그 없음)', () => {
    const doc = createNewDocument('metric');
    const list = listTableStyles(doc);
    expect(list.map((x) => x.name)).toEqual(['Standard']);
    expect(list[0]!.style.cells.title.height).toBe(6);
  });
});

describe('표 객체 ↔ 정의', () => {
  it('확장 자료로 병합·행 종류·정렬·문자가 돌아온다', () => {
    let t = sample();
    t = setText(t, 0, 0, '긴 제목 '.repeat(30));
    t = mergeCells(t, 2, 0, 2, 1)!;
    t = setAlign(t, 3, 2, 3, 2, 9);
    t = { ...t, baseRowHeights: t.baseRowHeights.map((h) => h - 1) };
    const x = encodeTableXData(t);
    const d = decodeTableXData(x)!;
    expect(d.rows).toBe(5);
    expect(d.merges).toEqual(t.merges);
    expect(d.rowKinds).toEqual(t.rowKinds);
    expect(d.aligns.get(3 * 3 + 2)).toBe(9);
    expect(d.texts!.get(0)).toBe(t.cells[0]!.text);
    expect(d.baseRowHeights).toEqual(t.baseRowHeights);
    for (const it of x.items) if (it.code === 1000) expect(String(it.value).length).toBeLessThanOrEqual(80);
  });

  it('표 객체에서 다시 읽기', () => {
    const doc = createNewDocument('metric');
    let t = sample();
    t = setText(t, 1, 1, 'B');
    t = mergeCells(t, 3, 0, 4, 0)!;
    const e = newTableEntity(t, { insert: { x: 5, y: 6, z: 0 }, blockName: '*T1' });
    expect(e.rows).toBe(5);
    expect(e.cells![4]!.text).toBe('B');
    const back = tableFromEntity(e, doc)!;
    expect(back.data).toEqual(t);
  });

  it('AutoCAD 원본 태그의 병합·정렬', () => {
    const raw = [
      { code: 100, value: 'AcDbTable' },
      { code: 91, value: 2 },
      { code: 92, value: 2 },
      { code: 171, value: 1 },
      { code: 172, value: 0 },
      { code: 173, value: 0 },
      { code: 175, value: 2 },
      { code: 176, value: 1 },
      { code: 170, value: 4 },
      { code: 171, value: 1 },
      { code: 173, value: 1 },
      { code: 175, value: 1 },
      { code: 176, value: 1 },
      { code: 171, value: 1 },
      { code: 175, value: 1 },
      { code: 176, value: 1 },
      { code: 171, value: 1 },
      { code: 175, value: 1 },
      { code: 176, value: 1 },
    ];
    const r = rawTableCells(raw);
    expect(r.count).toBe(4);
    expect(r.merges).toEqual([{ row: 0, col: 0, rows: 1, cols: 2 }]);
    expect(r.aligns.get(0)).toBe(4);
    const doc = createNewDocument('metric');
    const e = { ...newTableEntity(sample(), { insert: { x: 0, y: 0, z: 0 }, blockName: '*T1' }) } as TableEntity;
    e.rows = 2;
    e.columns = 2;
    e.rowHeights = [10, 10];
    e.columnWidths = [20, 20];
    e.cells = [{ text: 'a' }, { text: '' }, { text: 'c' }, { text: 'd' }];
    e.xdata = undefined;
    e.raw = raw;
    const back = tableFromEntity(e, doc)!;
    expect(back.data.merges).toEqual([{ row: 0, col: 0, rows: 1, cols: 2 }]);
    expect(back.data.rowKinds).toEqual(['title', 'data']);
    // 고치면 원본 태그를 버린다
    const w = applyTableData(e, back.data, undefined);
    expect(w.raw).toBeUndefined();
    expect((w as Entity).xdata?.[0]?.app).toBe('OPENCAD_TABLE');
  });
});
