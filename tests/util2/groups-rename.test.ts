import { describe, expect, it } from 'vitest';
import type { DictionaryObject, InsertEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { createGroupOps, deleteGroupOps, expandByGroups, groupDictionary, groupNameProblem, groupsContaining, listGroups, nextUnnamedName, updateGroupOps } from '../../src/edit/util/groups';
import { lockedReason, renamableNames, renameOps, renameProblem } from '../../src/edit/util/rename';
import { writeDxf } from '../../src/io/dxf/writer';
import { readDxf } from '../../src/io/dxf/reader';
import { addBlock, circle, insert, line, put, setup, text } from './helpers';

describe('그룹', () => {
  it('이름 있는·없는 그룹을 만들고 지우고 되돌린다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 1, 0);
    const b = line(h(), 0, 0, 0, 1);
    const c = circle(h(), 5, 5, 1);
    put(doc, a, b, c);
    const g = createGroupOps(doc, '창문', '설명', [a.handle, b.handle], h)!;
    s.commit({ label: 'GROUP', ops: g.ops });
    expect(listGroups(doc).map((x) => [x.name, x.group.entities])).toEqual([['창문', [a.handle, b.handle]]]);
    expect(groupNameProblem(doc, '창문')).toMatch(/이미/);
    expect(groupNameProblem(doc, 'a*b')).toMatch(/문자/);
    expect(nextUnnamedName(doc)).toBe('*A1');
    const u = createGroupOps(doc, null, '', [c.handle], h)!;
    s.commit({ label: 'GROUP', ops: u.ops });
    expect(u.name).toBe('*A1');
    expect(listGroups(doc)[1]!.group.unnamed).toBe(true);
    expect(groupsContaining(doc, c.handle).map((x) => x.name)).toEqual(['*A1']);
    // PICKSTYLE 1
    expect(expandByGroups(doc, [b.handle])).toEqual([b.handle, a.handle]);
    s.commit({ label: 'GROUPEDIT', ops: updateGroupOps(doc, g.handle, { selectable: false }) });
    expect(expandByGroups(doc, [b.handle])).toEqual([b.handle]);
    s.commit({ label: 'UNGROUP', ops: deleteGroupOps(doc, g.handle) });
    expect(listGroups(doc).map((x) => x.name)).toEqual(['*A1']);
    expect(doc.objects.has(g.handle)).toBe(false);
    s.undo();
    s.undo();
    expect(listGroups(doc).map((x) => x.name)).toEqual(['창문', '*A1']);
  });

  it('ACAD_GROUP 사전이 없으면 만들어 루트 사전에 넣는다', () => {
    const { doc, s, h } = setup();
    const root = doc.objects.get(doc.rootDictionary!) as DictionaryObject;
    const gh = root.entries.get('ACAD_GROUP')!;
    root.entries.delete('ACAD_GROUP');
    doc.objects.delete(gh);
    expect(groupDictionary(doc)).toBeNull();
    const a = line(h(), 0, 0, 1, 0);
    put(doc, a);
    const g = createGroupOps(doc, 'G', '', [a.handle], h)!;
    s.commit({ label: 'GROUP', ops: g.ops });
    expect(groupDictionary(doc)!.entries.get('G')).toBe(g.handle);
    s.undo();
    expect(groupDictionary(doc)).toBeNull();
  });

  it('DXF로 쓰고 읽어도 그룹이 남는다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 1, 0);
    const b = circle(h(), 3, 3, 1);
    put(doc, a, b);
    s.commit({ label: 'GROUP', ops: createGroupOps(doc, 'PAIR', '둘', [a.handle, b.handle], h)!.ops });
    const back = readDxf(writeDxf(doc, { version: 'AC1032' as never }).data);
    const gs = listGroups(back);
    expect(gs.map((g) => [g.name, g.group.description, g.group.entities.length])).toEqual([['PAIR', '둘', 2]]);
  });
});

describe('RENAME', () => {
  it('도면층: 객체·속성·현재 도면층·뷰포트를 함께 바꾸고 되돌린다', () => {
    const { doc, s, h } = setup();
    doc.layers.set('WALL', { ...doc.layers.get('0')!, name: 'WALL', handle: h() });
    const a = line(h(), 0, 0, 1, 0, { layer: 'WALL' });
    put(doc, a);
    doc.header.set('$CLAYER', 'Wall');
    expect(renameProblem(doc, 'layer', 'WALL', '0')).toMatch(/이미/);
    expect(renameProblem(doc, 'layer', '0', 'X')).toMatch(/바꿀 수 없/);
    s.commit({ label: 'RENAME', ops: renameOps(doc, 'layer', 'WALL', '벽') });
    expect(doc.layers.has('WALL')).toBe(false);
    expect(doc.layers.get('벽')!.name).toBe('벽');
    expect(doc.entityIndex.get(a.handle)!.layer).toBe('벽');
    expect(doc.header.get('$CLAYER')).toBe('벽');
    s.undo();
    expect(doc.layers.get('WALL')!.name).toBe('WALL');
    expect(doc.entityIndex.get(a.handle)!.layer).toBe('WALL');
    expect(doc.header.get('$CLAYER')).toBe('Wall');
  });

  it('대소문자만 바꾸기', () => {
    const { doc, s, h } = setup();
    doc.layers.set('WALL', { ...doc.layers.get('0')!, name: 'WALL', handle: h() });
    expect(renameProblem(doc, 'layer', 'WALL', 'Wall')).toBeNull();
    s.commit({ label: 'RENAME', ops: renameOps(doc, 'layer', 'WALL', 'Wall') });
    expect(doc.layers.get('WALL')!.name).toBe('Wall');
  });

  it('블록: 참조·블록 안 참조·치수 화살촉 이름을 바꾼다', () => {
    const { doc, s, h } = setup();
    addBlock(doc, h, 'DOT', [circle(h(), 0, 0, 1)]);
    addBlock(doc, h, 'OUTER', [insert(h(), 'DOT', 1, 1)]);
    const i = insert(h(), 'DOT', 0, 0);
    put(doc, i);
    const ds = [...doc.dimStyles.values()][0]!;
    ds.vars.DIMBLK = 'DOT';
    s.commit({ label: 'RENAME', ops: renameOps(doc, 'block', 'DOT', '점') });
    expect(doc.blocks.has('DOT')).toBe(false);
    expect(doc.blocks.get('점')!.name).toBe('점');
    expect(doc.blockRecords.get('점')!.name).toBe('점');
    expect((doc.entityIndex.get(i.handle) as InsertEntity).block).toBe('점');
    expect((doc.blocks.get('OUTER')!.entities[0] as InsertEntity).block).toBe('점');
    expect(doc.dimStyles.get(ds.name.toUpperCase())!.vars.DIMBLK).toBe('점');
    expect(doc.entityIndex.get(doc.blocks.get('점')!.entities[0]!.handle)).toBeTruthy();
    s.undo();
    expect(doc.blocks.get('DOT')!.name).toBe('DOT');
    expect((doc.entityIndex.get(i.handle) as InsertEntity).block).toBe('DOT');
  });

  it('문자 스타일·선종류·배치', () => {
    const { doc, s, h } = setup();
    doc.textStyles.set('NOTE', { ...doc.textStyles.get('STANDARD')!, name: 'NOTE', handle: h() });
    doc.linetypes.set('DASHED', { name: 'DASHED', handle: h(), flags: 0, description: '', patternLength: 1, elements: [] });
    doc.layers.set('L1', { ...doc.layers.get('0')!, name: 'L1', handle: h(), linetype: 'DASHED' });
    const t = text(h(), 0, 0, 'x', { style: 'NOTE', linetype: 'DASHED' });
    put(doc, t);
    s.commit({ label: 'RENAME', ops: renameOps(doc, 'textStyle', 'NOTE', '주석') });
    s.commit({ label: 'RENAME', ops: renameOps(doc, 'linetype', 'DASHED', '점선') });
    const e = doc.entityIndex.get(t.handle) as typeof t;
    expect([e.style, e.linetype, doc.layers.get('L1')!.linetype]).toEqual(['주석', '점선', '점선']);
    expect(lockedReason(doc, 'linetype', 'Continuous')).toMatch(/바꿀 수 없/);
    const lay = doc.layouts.find((l) => l.name === 'Layout1')!;
    s.commit({ label: 'RENAME', ops: renameOps(doc, 'layout', 'Layout1', '평면도') });
    expect(doc.layouts.map((l) => l.name)).toContain('평면도');
    const dict = [...doc.objects.values()].find((o) => o.type === 'DICTIONARY' && (o as DictionaryObject).entries.get('평면도') === lay.handle);
    expect(dict).toBeTruthy();
    expect(renamableNames(doc, 'layout')).toEqual(['평면도']);
    expect(lockedReason(doc, 'layout', 'Model')).toMatch(/모형/);
  });

  it('바꾼 이름이 DXF에 그대로 남는다', () => {
    const { doc, s, h } = setup();
    addBlock(doc, h, 'OLD', [circle(h(), 0, 0, 1)]);
    put(doc, insert(h(), 'OLD', 0, 0));
    s.commit({ label: 'RENAME', ops: renameOps(doc, 'block', 'OLD', 'NEW') });
    const back = readDxf(writeDxf(doc, { version: 'AC1032' as never }).data);
    expect(back.blocks.has('NEW')).toBe(true);
    expect(back.blocks.has('OLD')).toBe(false);
    expect((back.blocks.get(MODEL_SPACE)!.entities[0] as InsertEntity).block).toBe('NEW');
  });
});
