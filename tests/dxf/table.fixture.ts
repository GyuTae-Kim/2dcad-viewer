/**
 * 표 쓰기 시험 도면: 새 도면에 테이블 스타일(머리글 채우기·데이터 정렬·문자 색)과 병합·정렬 재지정이 있는 표를
 * 편집 작업으로 넣는다(DXF·DWG 쓰기 시험이 같이 쓴다).
 */
import type { CadDocument, TableEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';
import { type TableData, createTable, mergeCells, setAlign, setText } from '../../src/edit/table/model';
import { type CellKind, type TableStyle, defaultTableStyle } from '../../src/edit/table/style';
import { addTableOps, saveTableStyleOps } from '../../src/edit/table/ops';

export interface TableFixture {
  doc: CadDocument;
  session: EditSession;
  data: TableData;
  style: TableStyle;
  styleHandle: string;
  table: TableEntity;
}

export function tableFixture(units: 'metric' | 'imperial' = 'metric'): TableFixture {
  const doc = createNewDocument(units);
  const s = new EditSession(doc, () => {});
  const nh = () => s.newHandle();
  const ts = defaultTableStyle(units === 'metric', '공정표');
  ts.cells.header.fill = { aci: 8 };
  ts.cells.header.color = { aci: 1 };
  ts.cells.title.height = 7;
  ts.cells.data.align = 4;
  ts.hMargin = 1;
  const saved = saveTableStyleOps(doc, nh, ts);
  s.commit({ label: 'TABLESTYLE', ops: saved.ops });
  let t = createTable({ cols: 4, colWidth: 30, dataRows: 4, rowLines: 1, first: 'title', second: 'header' }, ts);
  t = setText(t, 0, 0, '공정 일정');
  t = setText(t, 1, 0, '항목');
  t = setText(t, 1, 1, '기간');
  t = setText(t, 2, 1, '가나다');
  t = mergeCells(t, 3, 1, 4, 2)!;
  t = setText(t, 3, 1, '병합된 셀');
  t = mergeCells(t, 2, 3, 5, 3)!;
  t = setText(t, 2, 3, '세로 병합');
  t = setAlign(t, 2, 2, 2, 2, 9);
  t = setAlign(t, 5, 0, 5, 0, 1);
  const added = addTableOps(doc, nh, { space: MODEL_SPACE, data: t, style: ts, styleHandle: saved.handle, insert: { x: 10, y: 100, z: 0 }, props: { ...entityDefaults() } });
  s.commit({ label: 'TABLE', ops: added.ops });
  return { doc, session: s, data: t, style: ts, styleHandle: saved.handle, table: added.table };
}

/** 셀마다 기대하는 정렬(셀 재지정, 없으면 행 종류의 셀 스타일) */
export function expectedAligns(f: TableFixture): number[] {
  return f.data.cells.map((c, i) => c.align ?? f.style.cells[f.data.rowKinds[Math.floor(i / f.data.cols)] as CellKind].align);
}
