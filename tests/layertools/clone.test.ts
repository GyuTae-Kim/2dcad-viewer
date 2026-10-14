/** 다른 도면의 정의 복사(디자인센터): 의존 정의, 이름 충돌, 익명 블록, 사전 객체, 배치, 왕복 */
import { describe, expect, it } from 'vitest';
import type { InsertEntity, MLeaderStyleObject } from '../../src/core/model';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import { readCadFile } from '../../src/io/index';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { DefinitionCopier, hasDefinition, listDefinitions, mleaderStyles } from '../../src/edit/layertools/clone';
import { defaultTableStyle, listTableStyles } from '../../src/edit/table/style';
import { saveTableStyleOps } from '../../src/edit/table/ops';
import { add, addBlock, addLayer, addLinetype, addTextStyle, attdef, commit, dimension, duplicateHandles, insert, line, newDoc, text, viewport } from './helpers';

/** 원본 도면: 도면층·선종류·문자 스타일·중첩 블록·속성·치수 블록 */
function source() {
  const s = newDoc();
  addLinetype(s, 'DASHED');
  addLayer(s, 'WALL', { color: { aci: 1 }, linetype: 'DASHED', lineweight: 35 });
  addLayer(s, 'TXT', { color: { aci: 3 } });
  addTextStyle(s, 'NOTE', 'simplex.shx');
  addBlock(s, 'INNER', [line(0, 0, 5, 0, 'WALL')]);
  addBlock(s, 'DOOR', [line(0, 0, 10, 10, 'WALL'), insert('INNER', 1, 1), text(0, 0, 'D', 'NOTE', 'TXT'), attdef('NO', 'NOTE', 'TXT')], { x: 2, y: 3, z: 0 });
  addBlock(s, '*D1', [line(0, 0, 10, 0)], undefined, 1);
  return s;
}

describe('정의 목록', () => {
  it('종류마다 사용자가 고를 수 있는 이름만', () => {
    const s = source();
    expect(listDefinitions(s.doc, 'block')).toEqual(['DOOR', 'INNER']);
    expect(listDefinitions(s.doc, 'layer')).toEqual(expect.arrayContaining(['0', 'WALL', 'TXT']));
    expect(listDefinitions(s.doc, 'linetype')).not.toContain('ByLayer');
    expect(listDefinitions(s.doc, 'linetype')).toContain('DASHED');
    expect(listDefinitions(s.doc, 'textStyle')).toEqual(expect.arrayContaining(['NOTE', 'Standard']));
    expect(listDefinitions(s.doc, 'mleaderStyle')).toEqual(['Standard']);
    expect(listDefinitions(s.doc, 'tableStyle')).toEqual(['Standard']);
    expect(listDefinitions(s.doc, 'layout').length).toBeGreaterThan(0);
  });
});

describe('정의 복사', () => {
  it('도면층은 선종류를 함께 가져온다', () => {
    const s = source();
    const d = newDoc();
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp.copy('layer', 'wall')).toBe('added');
    commit(d, cp.finish());
    const L = d.doc.layers.get('WALL')!;
    expect(L.color.aci).toBe(1);
    expect(L.lineweight).toBe(35);
    expect(L.linetype).toBe('DASHED');
    expect(d.doc.linetypes.has('DASHED')).toBe(true);
    expect(duplicateHandles(d.doc)).toEqual([]);
  });

  it('이름이 이미 있으면 이 도면의 정의를 둔다(중복 무시)', () => {
    const s = source();
    const d = newDoc();
    addLayer(d, 'WALL', { color: { aci: 5 } });
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp.copy('layer', 'WALL')).toBe('exists');
    expect(cp.copy('layer', 'NOPE')).toBe('missing');
    expect(cp.finish()).toEqual([]);
    expect(d.doc.layers.get('WALL')!.color.aci).toBe(5);
  });

  it('블록은 중첩 블록·도면층·문자 스타일·속성 정의와 함께, 새 핸들로', () => {
    const s = source();
    const d = newDoc();
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp.copy('block', 'DOOR')).toBe('added');
    commit(d, cp.finish());
    const door = d.doc.blocks.get('DOOR')!;
    expect(door.basePoint).toEqual({ x: 2, y: 3, z: 0 });
    expect(door.entities.map((e) => e.type)).toEqual(['LINE', 'INSERT', 'TEXT', 'ATTDEF']);
    expect(d.doc.blocks.has('INNER')).toBe(true);
    expect(d.doc.layers.has('WALL') && d.doc.layers.has('TXT')).toBe(true);
    expect(d.doc.textStyles.has('NOTE')).toBe(true);
    expect(d.doc.linetypes.has('DASHED')).toBe(true);
    // 블록 레코드·소유자
    const rec = d.doc.blockRecords.get('DOOR')!;
    expect(rec.handle).toBe(door.recordHandle);
    for (const e of door.entities) expect(e.owner).toBe(door.recordHandle);
    // 원본 핸들과 겹치지 않고, 이 도면 안에서도 겹치지 않는다
    for (const e of door.entities) expect(d.doc.entityIndex.get(e.handle)).toBe(e);
    expect(duplicateHandles(d.doc)).toEqual([]);
    // 모두 의존 정의로 기록
    expect(cp.added.map((a) => `${a.kind}:${a.name}`)).toEqual(expect.arrayContaining(['block:DOOR', 'block:INNER', 'layer:WALL', 'layer:TXT', 'textStyle:NOTE', 'linetype:DASHED']));
  });

  it('익명 블록(치수 블록)은 이 도면의 빈 번호로 바꾼다', () => {
    const s = source();
    add(s, dimension('*D1'));
    addBlock(s, 'WITHDIM', [dimension('*D1')]);
    const d = newDoc();
    addBlock(d, '*D1', [line(0, 0, 1, 1)], undefined, 1);
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    cp.copy('block', 'WITHDIM');
    commit(d, cp.finish());
    const dim = d.doc.blocks.get('WITHDIM')!.entities[0]!;
    expect(dim.type).toBe('DIMENSION');
    expect((dim as { block: string }).block).toBe('*D2');
    expect(d.doc.blocks.get('*D2')!.entities.length).toBe(1);
    expect(d.doc.blocks.get('*D1')!.entities[0]!.type).toBe('LINE');
  });

  it('치수 스타일은 문자 스타일과 화살표 블록을 함께 가져온다', () => {
    const s = source();
    addBlock(s, '_MyArrow', [line(0, 0, -1, 0.2)]);
    const std = s.doc.dimStyles.get('STANDARD')!;
    commit(s, [{ kind: 'dimStyle', key: 'ARCH', before: null, after: { ...structuredClone(std), name: 'ARCH', handle: s.nh(), vars: { ...std.vars, DIMTXSTY: 'NOTE', DIMBLK: '_MyArrow', DIMLTYPE: 'DASHED', DIMTXT: 3.5 } } }]);
    const d = newDoc();
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp.copy('dimStyle', 'Arch')).toBe('added');
    commit(d, cp.finish());
    const a = d.doc.dimStyles.get('ARCH')!;
    expect(a.vars.DIMTXT).toBe(3.5);
    expect(a.vars.DIMTXSTY).toBe('NOTE');
    expect(d.doc.textStyles.has('NOTE')).toBe(true);
    expect(d.doc.blocks.has('_MYARROW')).toBe(true);
    expect(d.doc.linetypes.has('DASHED')).toBe(true);
  });

  it('다중 지시선 스타일·테이블 스타일은 사전 항목과 함께(같은 사전에 여러 개)', () => {
    const s = source();
    // 다중 지시선 스타일 하나 더(문자 스타일 NOTE를 가리킨다)
    const base = mleaderStyles(s.doc)[0]!.obj;
    const mh = s.nh();
    const note = s.doc.textStyles.get('NOTE')!;
    const mls: MLeaderStyleObject = { ...structuredClone(base), handle: mh, name: 'Callout', textStyleHandle: note.handle, raw: [{ code: 3, value: 'Callout' }, { code: 342, value: note.handle }, { code: 44, value: 3 }] };
    delete mls.dwgRaw;
    const dict = s.doc.objects.get(base.owner!)! as { entries: Map<string, string> };
    commit(s, [
      { kind: 'object', key: mh, before: null, after: mls },
      { kind: 'object', key: base.owner!, before: dict as never, after: { ...(dict as object), entries: new Map([...dict.entries, ['Callout', mh]]) } as never },
    ]);
    // 테이블 스타일 둘
    for (const n of ['T1', 'T2']) {
      const ts = defaultTableStyle(true, n);
      ts.cells.data.textStyle = 'NOTE';
      commit(s, saveTableStyleOps(s.doc, s.nh, ts).ops);
    }
    const d = newDoc();
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp.copy('mleaderStyle', 'Callout')).toBe('added');
    expect(cp.copy('tableStyle', 'T1')).toBe('added');
    expect(cp.copy('tableStyle', 'T2')).toBe('added');
    expect(cp.copy('tableStyle', 'Standard')).toBe('exists');
    commit(d, cp.finish());
    const got = mleaderStyles(d.doc).find((x) => x.name === 'Callout')!;
    expect(got).toBeTruthy();
    const dn = d.doc.textStyles.get('NOTE')!;
    expect(got.obj.textStyleHandle).toBe(dn.handle);
    expect(got.obj.raw!.find((t) => t.code === 342)!.value).toBe(dn.handle);
    const names = listTableStyles(d.doc).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Standard', 'T1', 'T2']));
    expect(listTableStyles(d.doc).find((x) => x.name === 'T2')!.style.cells.data.textStyle).toBe('NOTE');
    expect(hasDefinition(d.doc, 'tableStyle', 't1')).toBe(true);
    expect(duplicateHandles(d.doc)).toEqual([]);
  });

  it('배치는 종이 공간 블록·뷰포트·객체와 함께, 같은 이름이면 건너뛴다', () => {
    const s = source();
    const lay = s.doc.layouts.find((l) => tableKey(l.blockName) !== MODEL_SPACE)!;
    const vp = add(s, viewport(['WALL']), lay.blockName);
    add(s, line(0, 0, 100, 0, 'TXT'), lay.blockName);
    commit(s, [{ kind: 'layout', key: tableKey(lay.blockName), before: lay, after: { ...lay, name: '평면도', viewport: vp.handle } }]);
    const d = newDoc();
    const before = d.doc.layouts.length;
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp.copy('layout', '평면도')).toBe('added');
    commit(d, cp.finish());
    expect(d.doc.layouts.length).toBe(before + 1);
    const nl = d.doc.layouts.find((l) => l.name === '평면도')!;
    const blk = d.doc.blocks.get(tableKey(nl.blockName))!;
    expect(blk.entities.map((e) => e.type)).toEqual(['VIEWPORT', 'LINE']);
    expect(blk.entities.every((e) => e.paperSpace)).toBe(true);
    expect(nl.viewport).toBe(blk.entities[0]!.handle);
    expect((blk.entities[0] as { frozenLayers: string[] }).frozenLayers).toEqual(['WALL']);
    expect(d.doc.layers.has('WALL') && d.doc.layers.has('TXT')).toBe(true);
    expect(d.doc.objects.get(nl.handle)?.type).toBe('LAYOUT');
    expect(d.doc.blockRecords.get(tableKey(nl.blockName))!.layout).toBe(nl.handle);
    // 같은 이름은 건너뛴다
    const cp2 = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp2.copy('layout', '평면도')).toBe('exists');
  });

  it('가져온 도면을 DXF·DWG로 저장하고 다시 읽는다', () => {
    const s = source();
    const d = newDoc();
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    cp.copy('block', 'DOOR');
    cp.copy('layer', 'TXT');
    cp.copy('textStyle', 'NOTE');
    commit(d, cp.finish());
    const ins = insert('DOOR', 50, 50);
    add(d, ins);
    for (const out of [writeDxf(d.doc, { version: 'AC1032' as never }).data, writeDwg(d.doc, { version: 'AC1032' }).data]) {
      const back = readCadFile(out, 'rt');
      expect(back.blocks.get('DOOR')!.entities.length).toBe(4);
      expect(back.blocks.has('INNER')).toBe(true);
      expect(back.layers.get('WALL')!.linetype.toUpperCase()).toBe('DASHED');
      expect(back.textStyles.get('NOTE')!.font.toLowerCase()).toContain('simplex');
      const placed = [...back.blocks.get(MODEL_SPACE)!.entities].find((e) => e.type === 'INSERT') as InsertEntity;
      expect(placed.block).toBe('DOOR');
    }
  });

  it('다중 지시선 스타일·테이블 스타일·배치를 가져온 도면도 DXF·DWG로 다시 읽힌다', () => {
    const s = source();
    const base = mleaderStyles(s.doc)[0]!.obj;
    const mh = s.nh();
    const note = s.doc.textStyles.get('NOTE')!;
    const mls: MLeaderStyleObject = { ...structuredClone(base), handle: mh, name: 'Callout', textStyleHandle: note.handle, textHeight: 3.5 };
    delete mls.dwgRaw;
    delete mls.raw;
    const dict = s.doc.objects.get(base.owner!)! as { entries: Map<string, string> };
    commit(s, [
      { kind: 'object', key: mh, before: null, after: mls },
      { kind: 'object', key: base.owner!, before: dict as never, after: { ...(dict as object), entries: new Map([...dict.entries, ['Callout', mh]]) } as never },
    ]);
    const ts = defaultTableStyle(true, 'T1');
    ts.cells.title.textStyle = 'NOTE';
    commit(s, saveTableStyleOps(s.doc, s.nh, ts).ops);
    const lay = s.doc.layouts.find((l) => tableKey(l.blockName) !== MODEL_SPACE)!;
    const vp = add(s, viewport(['WALL']), lay.blockName);
    add(s, line(0, 0, 100, 0, 'TXT'), lay.blockName);
    commit(s, [{ kind: 'layout', key: tableKey(lay.blockName), before: lay, after: { ...lay, name: '평면도', viewport: vp.handle } }]);
    const d = newDoc();
    const cp = new DefinitionCopier(s.doc, d.doc, d.nh);
    expect(cp.copy('mleaderStyle', 'Callout')).toBe('added');
    expect(cp.copy('tableStyle', 'T1')).toBe('added');
    expect(cp.copy('layout', '평면도')).toBe('added');
    commit(d, cp.finish());
    for (const [kind, out] of [
      ['dxf', writeDxf(d.doc, { version: 'AC1032' as never }).data],
      ['dwg', writeDwg(d.doc, { version: 'AC1032' }).data],
      ['dwg2000', writeDwg(d.doc, { version: 'AC1015' as never }).data],
    ] as const) {
      const back = readCadFile(out, `rt.${kind.slice(0, 3)}`);
      expect(back.layouts.map((l) => l.name), kind).toContain('평면도');
      const pl = back.layouts.find((l) => l.name === '평면도')!;
      expect(back.blocks.get(tableKey(pl.blockName))!.entities.some((e) => e.type === 'LINE'), kind).toBe(true);
      expect(mleaderStyles(back).map((x) => x.name), kind).toContain('Callout');
      const cm = mleaderStyles(back).find((x) => x.name === 'Callout')!.obj;
      expect(back.textStyles.get('NOTE')!.handle.toUpperCase(), kind).toBe(String(cm.textStyleHandle).toUpperCase());
      expect(listTableStyles(back).map((x) => x.name), kind).toContain('T1');
    }
  });
});
