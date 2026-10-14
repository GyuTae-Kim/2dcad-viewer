/**
 * 왕복: 새 도면에 표·테이블 스타일·여러 줄(끊기 포함)·여러 줄 스타일·필드 문자를 편집 작업으로 넣고
 * DXF(R2018·R2004)로 써서 다시 읽으면 같은지 본다. DWG(R2018·R2000)도 표가 ACAD_TABLE로 남는지 본다.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, Entity, InsertEntity, MLineEntity, MLineStyleObject, MTextEntity, TableEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { readCadFile } from '../../src/io/index';
import { decodeCadEscapes } from '../../src/core/codepage';
import { createTable, mergeCells, setAlign, setText } from '../../src/edit/table/model';
import { defaultTableStyle, listTableStyles } from '../../src/edit/table/style';
import { addTableOps, saveTableStyleOps, updateTableOps } from '../../src/edit/table/ops';
import { isEditableTable, tableFromEntity } from '../../src/edit/table/entity';
import { addMLineStyleOps } from '../../src/edit/mline/ops';
import { newMLineStyle, findMLineStyle } from '../../src/edit/mline/style';
import { cutAll, elementPolylines, mlineGeometry } from '../../src/edit/mline/geom';
import { varField } from '../../src/edit/field/code';
import { applyTemplate, fieldTemplate } from '../../src/edit/field/store';

function build() {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const nh = () => s.newHandle();
  const props = { ...entityDefaults() };
  // 테이블 스타일
  const ts = defaultTableStyle(true, '공정표');
  ts.cells.header.fill = { aci: 8 };
  ts.cells.data.align = 4;
  ts.hMargin = 1;
  const savedStyle = saveTableStyleOps(doc, nh, ts);
  s.commit({ label: 'TABLESTYLE', ops: savedStyle.ops });
  // 표
  let t = createTable({ cols: 3, colWidth: 40, dataRows: 3, rowLines: 1, first: 'title', second: 'header' }, ts);
  t = setText(t, 0, 0, '공정 일정');
  t = setText(t, 1, 0, '항목');
  t = setText(t, 2, 1, '가나다');
  t = mergeCells(t, 3, 1, 4, 2)!;
  t = setText(t, 3, 1, '병합된 셀');
  t = setAlign(t, 2, 2, 2, 2, 9);
  const added = addTableOps(doc, nh, { space: MODEL_SPACE, data: t, style: ts, styleHandle: savedStyle.handle, insert: { x: 10, y: 100, z: 0 }, props });
  s.commit({ label: 'TABLE', ops: added.ops });
  // 여러 줄 스타일과 끊긴 여러 줄
  const ms = newMLineStyle('벽체');
  ms.elements = [
    { offset: 1, color: { aci: 1 }, linetype: 'BYLAYER' },
    { offset: 0, color: { aci: 3 }, linetype: 'BYLAYER' },
    { offset: -1, color: { aci: 1 }, linetype: 'BYLAYER' },
  ];
  ms.flags = 16 | 256;
  const am = addMLineStyleOps(doc, nh, ms);
  s.commit({ label: 'MLSTYLE', ops: am.ops });
  let ml: MLineEntity = {
    ...entityDefaults(),
    type: 'MLINE',
    handle: nh(),
    ...mlineGeometry({
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 30 },
      ],
      closed: false,
      style: am.style,
      scale: 2,
      justification: 0,
    }),
  };
  ml = cutAll(ml, { x: 20, y: 0 }, { x: 25, y: 0 });
  s.commit({ label: 'MLINE', ops: [{ kind: 'add', block: MODEL_SPACE, entity: ml }] });
  // 필드 문자
  const base: MTextEntity = { ...entityDefaults(), type: 'MTEXT', handle: nh(), insert: { x: 0, y: -20, z: 0 }, height: 2.5, width: 0, attachment: 1, drawingDirection: 1, text: '', style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 };
  const tpl = `파일: ${varField('Filename', '%fn2')} 날짜: ${varField('Date', 'yyyy-MM-dd')}`;
  const mt = applyTemplate(base, tpl, { doc, fileName: 'a/plan.dwg', now: new Date(2026, 0, 2) });
  s.commit({ label: 'FIELD', ops: [{ kind: 'add', block: MODEL_SPACE, entity: mt }] });
  return { doc, session: s, t, ts, table: added.table, styleHandle: savedStyle.handle, ml, tpl, mt };
}

function find<T extends Entity>(doc: CadDocument, type: T['type']): T[] {
  return (doc.blocks.get(MODEL_SPACE)?.entities.filter((e) => e.type === type) ?? []) as T[];
}

describe('표·여러 줄·필드 DXF 왕복', () => {
  for (const version of ['AC1032', 'AC1018'] as const) {
    it(version, () => {
      const b = build();
      const res = writeDxf(b.doc, { version });
      const back = readCadFile(res.data, 'x.dxf');
      // 표
      const tables = find<TableEntity>(back, 'ACAD_TABLE');
      expect(tables).toHaveLength(1);
      const te = tables[0]!;
      expect(te.rows).toBe(5);
      expect(te.columns).toBe(3);
      expect(te.cells?.map((c) => decodeCadEscapes(c.text))).toEqual(b.t.cells.map((c) => c.text));
      const rt = tableFromEntity(te, back)!;
      expect(rt.data).toEqual(b.t);
      expect(rt.styleEntry?.name).toBe('공정표');
      expect(rt.style.cells.header.fill).toEqual({ aci: 8 });
      expect(rt.style.cells.data.align).toBe(4);
      expect(rt.style.hMargin).toBe(1);
      const blk = back.blocks.get(te.block.toUpperCase())!;
      const srcBlk = b.doc.blocks.get(b.table.block.toUpperCase())!;
      expect(blk.entities.map((e) => e.type).sort()).toEqual(srcBlk.entities.map((e) => e.type).sort());
      expect(listTableStyles(back).map((x) => x.name).sort()).toEqual(['Standard', '공정표']);
      // 여러 줄(끊기 포함)
      const mls = find<MLineEntity>(back, 'MLINE');
      expect(mls).toHaveLength(1);
      const m = mls[0]!;
      expect(m.vertices.map((v) => v.elements.map((el) => el.params.map((p) => +p.toFixed(9))))).toEqual(b.ml.vertices.map((v) => v.elements.map((el) => el.params.map((p) => +p.toFixed(9)))));
      expect(elementPolylines(m, 0)).toHaveLength(2);
      const st = findMLineStyle(back, m.styleHandle ?? m.styleName)!;
      expect(st.name).toBe('벽체');
      expect(st.style.elements.map((e) => e.offset)).toEqual([1, 0, -1]);
      expect((st.style as MLineStyleObject).flags).toBe(16 | 256);
      // 필드
      const mt = find<MTextEntity>(back, 'MTEXT');
      expect(mt).toHaveLength(1);
      expect(fieldTemplate(mt[0]!)).toBe(b.tpl);
      expect(decodeCadEscapes(mt[0]!.text)).toBe(b.mt.text);
    });
  }

  it('편집한 표를 다시 쓰고 읽기(블록을 고쳐 쓴다)', () => {
    const b = build();
    const nh = () => b.session.newHandle();
    const t2 = setText(b.t, 4, 0, '추가');
    const up = updateTableOps(b.doc, nh, b.table, MODEL_SPACE, t2, b.ts, b.styleHandle);
    expect(up.table.block).toBe(b.table.block);
    b.session.commit({ label: 'TABLEDIT', ops: up.ops });
    const back = readCadFile(writeDxf(b.doc, { version: 'AC1032' }).data, 'x.dxf');
    const te = find<TableEntity>(back, 'ACAD_TABLE')[0]!;
    expect(tableFromEntity(te, back)!.data.cells[12]!.text).toBe('추가');
  });

  for (const version of ['AC1032', 'AC1015'] as const) {
    it(`DWG ${version}: 표가 ACAD_TABLE로 남고 다시 고칠 수 있다`, () => {
      const b = build();
      const res = writeDwg(b.doc, { version });
      const back = readCadFile(res.data, 'x.dwg');
      expect(find<InsertEntity>(back, 'INSERT')).toHaveLength(0);
      const tabs = find<TableEntity>(back, 'ACAD_TABLE');
      expect(tabs).toHaveLength(1);
      expect(isEditableTable(tabs[0]!)).toBe(true);
      const rt = tableFromEntity(tabs[0]!, back)!;
      expect(rt.data).toEqual(b.t);
      const s2 = new EditSession(back, () => {});
      const up = updateTableOps(back, () => s2.newHandle(), tabs[0]!, MODEL_SPACE, setText(rt.data, 4, 0, '고침'), rt.style, rt.styleEntry?.handle);
      s2.commit({ label: 'TABLEDIT', ops: up.ops });
      const te = back.entityIndex.get(tabs[0]!.handle) as TableEntity;
      expect(te.type).toBe('ACAD_TABLE');
      expect(te.cells?.[12]?.text).toBe('고침');
      expect(te.rotation).toBe(0);
      const m = find<MLineEntity>(back, 'MLINE')[0]!;
      expect(elementPolylines(m, 0)).toHaveLength(2);
      expect(fieldTemplate(find<MTextEntity>(back, 'MTEXT')[0]!)).toBe(b.tpl);
    });
  }
});
