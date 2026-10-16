import { describe, expect, it } from 'vitest';
import type { DictionaryObject, Entity, HatchEntity, ImageEntity } from '../../src/core/model';
import { createHatch } from '../../src/edit/hatch';
import { hatchOrigin } from '../../src/edit/editcmds2/hatch';
import { createGroupOps, listGroups } from '../../src/edit/util/groups';
import { registerEditCmds2 } from '../../src/app/editcmds2';
import { addTableOps } from '../../src/edit/table/ops';
import { cellRect, createTable } from '../../src/edit/table/model';
import { defaultTableStyle } from '../../src/edit/table/style';
import { tableFromEntity } from '../../src/edit/table/entity';
import { entityDefaults, MODEL_SPACE, type TableEntity } from '../../src/core/model';
import { circle, line } from '../edit/make';
import { makeHarness, modelEntities } from '../cmds2/harness';
import { packBulge } from '../../src/core/lwpoly';

function harness() {
  const h = makeHarness((doc) => {
    // 그룹을 만들 수 있게 이름 있는 객체 사전을 둔다
    const root: DictionaryObject = { type: 'DICTIONARY', handle: 'A0', entries: new Map(), hardOwner: false, cloning: 1 };
    doc.objects.set('A0', root);
    doc.rootDictionary = 'A0';
  });
  registerEditCmds2(h.app);
  return h;
}

describe('editcmds2 명령 흐름', () => {
  it('이미 있는 이름은 건너뛰고 나머지를 등록한다', () => {
    const h = makeHarness();
    h.app.register({ name: 'PLAN', title: '다른 PLAN', run: () => {} });
    registerEditCmds2(h.app);
    expect(h.app.commands.get('PLAN')!.title).toBe('다른 PLAN');
    for (const n of ['HATCHGENERATEBOUNDARY', 'HATCHSETBOUNDARY', 'HATCHSETORIGIN', 'IMAGEADJUST', '-IMAGEADJUST', 'IMAGEQUALITY', 'TRANSPARENCY', 'PDFADJUST', 'PDFLAYERS', 'DIMCENTER', 'DIMHORIZONTAL', 'DIMVERTICAL', 'TABLEEXPORT', 'MATCHCELL', 'QUICKPROPERTIES', 'QPMODE', 'DBLIST', 'TRANSPARENCYDISPLAY', 'VIEWRES', 'ELEV', 'GROUPEDIT', 'LAYERCLOSE', 'CLASSICLAYER'])
      expect(h.app.commands.has(n), n).toBe(true);
  });

  it('DIMCENTER: DIMCEN 음수면 십자와 중심선(LINE 6개), 0이면 그리지 않는다', async () => {
    const h = harness();
    h.doc.header.set('$DIMCEN', -2);
    h.doc.header.set('$DIMSCALE', 1.5);
    const c = h.add(circle(10, 10, 20));
    await h.run('DIMCENTER', [{ pick: c.handle, at: [30, 10] }]);
    const ls = modelEntities(h.doc, 'LINE');
    expect(ls).toHaveLength(6);
    expect(h.prompts[0]).toBe('호 또는 원 선택:');
    // 반길이 3(=2×1.5), 오른쪽 중심선 16~33
    expect(ls[0]!.start.x).toBeCloseTo(7);
    expect(ls[2]!.start.x).toBeCloseTo(16);
    expect(ls[2]!.end.x).toBeCloseTo(33);
    h.doc.header.set('$DIMCEN', 0);
    await h.run('DIMCENTER', [{ pick: c.handle, at: [30, 10] }]);
    expect(modelEntities(h.doc, 'LINE')).toHaveLength(6);
  });

  it('HATCHSETORIGIN: 고른 해치의 원점을 옮기고 명령 취소로 되돌린다', async () => {
    const h = harness();
    const sq = { flags: 3, polyline: { closed: true, verts: packBulge([0, 1, 2, 3].map((i) => ({ x: i === 1 || i === 2 ? 10 : 0, y: i >= 2 ? 10 : 0, bulge: 0 }))) } };
    const hat = h.add(createHatch(h.doc, [sq], { pattern: 'ANSI37', scale: 1, origin: { x: 1, y: 1 } })) as HatchEntity;
    await h.run('HATCHSETORIGIN', [{ sel: [hat.handle] }, '5,6']);
    expect(h.prompts).toEqual(['해치 객체 선택:', '새 해치 원점 지정:']);
    const o = hatchOrigin(h.doc.entityIndex.get(hat.handle) as HatchEntity)!;
    expect(o.x).toBeCloseTo(5, 9);
    expect(o.y).toBeCloseTo(6, 9);
    h.st.session.undo();
    expect(hatchOrigin(h.doc.entityIndex.get(hat.handle) as HatchEntity)!.x).toBeCloseTo(1, 9);
  });

  it('HATCHGENERATEBOUNDARY: 해치 둘레에 닫힌 폴리선', async () => {
    const h = harness();
    const sq = { flags: 3, polyline: { closed: true, verts: packBulge([0, 1, 2, 3].map((i) => ({ x: i === 1 || i === 2 ? 10 : 0, y: i >= 2 ? 10 : 0, bulge: 0 }))) } };
    const hat = h.add(createHatch(h.doc, [sq], { pattern: 'SOLID' }));
    await h.run('HATCHGENERATEBOUNDARY', [{ sel: [hat.handle] }]);
    const pl = modelEntities(h.doc, 'LWPOLYLINE');
    expect(pl).toHaveLength(1);
    expect(pl[0]!.closed).toBe(true);
    expect(h.printed.pop()).toBe('경계 폴리선 1개를 만들었습니다.');
  });

  it('GROUPEDIT: 객체 추가·이름 바꾸기·분해', async () => {
    const h = harness();
    const a = h.add(line(0, 0, 10, 0));
    const b = h.add(line(0, 5, 10, 5));
    const g = createGroupOps(h.doc, '벽', '', [a.handle], () => h.st.session.newHandle())!;
    h.st.session.commit({ label: 'GROUP', ops: g.ops });
    await h.run('GROUPEDIT', [{ pick: a.handle, at: [5, 0] }, 'A', { sel: [b.handle] }]);
    expect(h.prompts).toEqual(['그룹 선택 또는 [이름(N)]:', '옵션 입력 [객체 추가(A)/객체 제거(R)/이름 바꾸기(REN)/분해(E)]:', '객체 선택:']);
    expect(listGroups(h.doc)[0]!.group.entities).toEqual([a.handle, b.handle]);
    await h.run('GROUPEDIT', ['N', '벽', 'REN', '외벽']);
    expect(listGroups(h.doc).map((x) => x.name)).toEqual(['외벽']);
    await h.run('GROUPEDIT', [{ pick: b.handle, at: [5, 5] }, 'R', { sel: [a.handle] }]);
    expect(listGroups(h.doc)[0]!.group.entities).toEqual([b.handle]);
    await h.run('GROUPEDIT', [{ pick: b.handle, at: [5, 5] }, 'E']);
    expect(listGroups(h.doc)).toEqual([]);
  });

  it('ELEV: 기본 고도·두께', async () => {
    const h = harness();
    await h.run('ELEV', ['12.5', '3']);
    expect(h.prompts[0]).toMatch(/^새 기본 고도 지정 <.*>:$/);
    expect(h.prompts[1]).toMatch(/^새 기본 두께 지정 <.*>:$/);
    expect(h.doc.header.get('$ELEVATION')).toBe(12.5);
    expect(h.doc.header.get('$THICKNESS')).toBe(3);
  });

  it('-IMAGEADJUST·TRANSPARENCY: 이미지 값과 바탕 투명 플래그', async () => {
    const h = harness();
    const img = h.add({ type: 'IMAGE', handle: '', layer: '0', linetype: 'ByLayer', color: { aci: 256 }, lineweight: -1, ltscale: 1, transparency: -1, insert: { x: 0, y: 0, z: 0 }, uVector: { x: 1, y: 0, z: 0 }, vVector: { x: 0, y: 1, z: 0 }, imageSize: { x: 10, y: 10 }, displayFlags: 7, clipping: false, brightness: 50, contrast: 50, fade: 0, clipBoundaryType: 1, clipBoundary: [] } as Entity) as ImageEntity;
    await h.run('-IMAGEADJUST', [{ sel: [img.handle] }, 'F', '120', '30']);
    expect(h.prompts).toEqual(['이미지 선택:', '이미지 옵션 입력 [대비(C)/흐리기(F)/밝기(B)] <밝기>:', '흐리기 값 입력 (0-100) <0>:', '흐리기 값 입력 (0-100) <0>:']);
    expect((h.doc.entityIndex.get(img.handle) as ImageEntity).fade).toBe(30);
    await h.run('TRANSPARENCY', [{ sel: [img.handle] }, 'ON']);
    expect((h.doc.entityIndex.get(img.handle) as ImageEntity).displayFlags).toBe(15);
  });

  it('MATCHCELL: 제목 셀의 정렬을 데이터 셀들에 옮긴다', async () => {
    const h = harness();
    const style = defaultTableStyle(true);
    const data = createTable({ cols: 2, colWidth: 20, dataRows: 2, rowLines: 1, first: 'title', second: 'header' }, style);
    const { ops, table } = addTableOps(h.doc, () => h.st.session.newHandle(), { space: MODEL_SPACE, data, style, insert: { x: 0, y: 0, z: 0 }, props: entityDefaults() });
    h.st.session.commit({ label: 'TABLE', ops });
    const at = (r: number, c: number): [number, number] => {
      const q = cellRect(data, r, c);
      return [(q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2];
    };
    await h.run('MATCHCELL', [{ pick: table.handle, at: at(0, 0) }, { pick: table.handle, at: at(2, 1) }, { pick: table.handle, at: at(3, 0) }, '']);
    expect(h.prompts).toEqual(['원본 셀 선택:', '대상 셀 선택:', '대상 셀 선택:', '대상 셀 선택:']);
    const t = tableFromEntity(h.doc.entityIndex.get(table.handle) as TableEntity, h.doc)!.data;
    expect(t.cells[2 * 2 + 1]!.align).toBe(5);
    expect(t.cells[3 * 2 + 0]!.align).toBe(5);
    expect(t.cells[2 * 2 + 0]!.align).toBeUndefined();
    expect(h.printed.pop()).toBe('셀 2개에 A1 셀의 특성을 적용했습니다.');
  });
});
