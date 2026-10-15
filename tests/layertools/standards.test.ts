/** CAD 표준: 위반 판정(비표준 이름·특성), 권장 대체, 특성 수정, 이름 대체, 표준 파일 연결 기록 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, DimensionEntity, TextEntity } from '../../src/core/model';
import { readCadFile } from '../../src/io/index';
import { writeDxf } from '../../src/io/dxf/writer';
import type { DictionaryObject, XRecordObject } from '../../src/core/model';
import { normalizeHandle } from '../../src/core/model';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { rootDictionary } from '../../src/edit/layertools/clone';
import { ACST_STANDARD_KEY, STANDARDS_KEY, type StdSource, checkStandards, fixPropsOps, readStandardsLink, replacePlan, sameStdFile, standardsLinkOps, stdFileBase } from '../../src/edit/layertools/standards';
import { add, addLayer, addLinetype, addTextStyle, commit, dimension, line, newDoc, text } from './helpers';

/** 표준 파일: 도면층 S-WALL(빨강, DASHED), S-TEXT, 문자 스타일 STD-TXT, 선종류 DASHED */
function standard(): StdSource {
  const s = newDoc();
  addLinetype(s, 'DASHED', [6, -3], 'Dashed __ __');
  addLayer(s, 'S-WALL', { color: { aci: 1 }, linetype: 'DASHED', lineweight: 35 });
  addLayer(s, 'S-TEXT', { color: { aci: 3 } });
  addTextStyle(s, 'STD-TXT', 'romans.shx', { widthFactor: 0.8 });
  return { name: 'office.dws', doc: s.doc };
}

describe('표준 위반 판정', () => {
  it('비표준 이름·비표준 특성, 0·Continuous는 이름 검사에서 뺀다', () => {
    const t = newDoc();
    addLinetype(t, 'DASHED', [5, -2.5], 'Dashed __ __');
    addLayer(t, 'S-WALL', { color: { aci: 2 }, linetype: 'DASHED', lineweight: 35 });
    addLayer(t, 'wall-old', { color: { aci: 3 } });
    addTextStyle(t, 'STD-TXT', 'romans.shx', { widthFactor: 0.8 });
    const p = checkStandards(t.doc, [standard()]);
    const byId = new Map(p.map((x) => [x.id, x]));
    // 도면층
    const sw = byId.get('layer:S-WALL')!;
    expect(sw.type).toBe('props');
    expect(sw.diffs.map((d) => d.label)).toEqual(['색상']);
    expect(sw.diffs[0]!.current).toBe('노란색');
    expect(sw.diffs[0]!.standard).toBe('빨간색');
    const wo = byId.get('layer:WALL-OLD')!;
    expect(wo.type).toBe('name');
    // 특성이 같은 S-TEXT를 권장
    expect(wo.candidates[wo.recommended]!.name).toBe('S-TEXT');
    expect(byId.has('layer:0')).toBe(false);
    // 선종류 무늬 차이
    expect(byId.get('linetype:DASHED')!.diffs.map((d) => d.label)).toEqual(['무늬']);
    expect(byId.has('linetype:CONTINUOUS')).toBe(false);
    // 같은 문자 스타일은 문제 아님
    expect(byId.has('textStyle:STD-TXT')).toBe(false);
    // 무시한 문제
    expect(checkStandards(t.doc, [standard()], ['layer'], new Set(['layer:WALL-OLD'])).some((x) => x.id === 'layer:WALL-OLD')).toBe(false);
    // 종류를 고르면 그 종류만
    expect(checkStandards(t.doc, [standard()], ['textStyle']).every((x) => x.kind === 'textStyle')).toBe(true);
  });

  it('표준 파일이 없으면 문제도 없다', () => {
    expect(checkStandards(newDoc().doc, [])).toEqual([]);
  });
});

describe('표준 수정', () => {
  it('비표준 특성은 표준 값으로(필요한 선종류를 표준 파일에서 가져온다)', () => {
    const t = newDoc();
    addLayer(t, 'S-WALL', { color: { aci: 2 } });
    const std = standard();
    const p = checkStandards(t.doc, [std], ['layer']).find((x) => x.id === 'layer:S-WALL')!;
    expect(p.diffs.map((d) => d.label)).toEqual(['색상', '선종류', '선가중치']);
    commit(t, fixPropsOps(t.doc, p, [std], t.nh));
    const L = t.doc.layers.get('S-WALL')!;
    expect(L.color.aci).toBe(1);
    expect(L.linetype).toBe('DASHED');
    expect(L.lineweight).toBe(35);
    expect(t.doc.linetypes.get('DASHED')!.elements.map((e) => e.length)).toEqual([6, -3]);
    expect(checkStandards(t.doc, [std], ['layer']).some((x) => x.id === 'layer:S-WALL')).toBe(false);
  });

  it('비표준 도면층 이름은 표준 도면층으로 대체: 객체·현재 도면층이 따라가고 비표준 도면층은 지운다', () => {
    const t = newDoc();
    addLayer(t, 'wall-old', { color: { aci: 3 } });
    const l = add(t, line(0, 0, 1, 1, 'wall-old'));
    commit(t, [{ kind: 'header', name: '$CLAYER', before: t.doc.header.get('$CLAYER'), after: 'wall-old' }]);
    const std = standard();
    const p = checkStandards(t.doc, [std], ['layer']).find((x) => x.id === 'layer:WALL-OLD')!;
    const c = p.candidates.find((x) => x.name === 'S-WALL')!;
    const plan = replacePlan(t.doc, p, c, [std], t.nh)!;
    commit(t, plan.pre);
    commit(t, plan.entities.map((x) => ({ kind: 'modify' as const, block: x.block, before: x.before, after: x.after })));
    commit(t, plan.post);
    expect(t.doc.entityIndex.get(l.handle)!.layer).toBe('S-WALL');
    expect(t.doc.layers.has('WALL-OLD')).toBe(false);
    expect(t.doc.layers.get('S-WALL')!.color.aci).toBe(1);
    expect(t.doc.linetypes.has('DASHED')).toBe(true);
    expect(t.doc.header.get('$CLAYER')).toBe('S-WALL');
  });

  it('비표준 문자 스타일 대체: 문자와 치수 스타일의 DIMTXSTY가 따라간다', () => {
    const t = newDoc();
    addTextStyle(t, 'MYTXT', 'txt.shx');
    const tx = add(t, text(0, 0, 'A', 'MYTXT'));
    const ds = t.doc.dimStyles.get('STANDARD')!;
    commit(t, [{ kind: 'dimStyle', key: 'STANDARD', before: ds, after: { ...ds, vars: { ...ds.vars, DIMTXSTY: 'MYTXT' } } }]);
    const std = standard();
    const p = checkStandards(t.doc, [std], ['textStyle']).find((x) => x.id === 'textStyle:MYTXT')!;
    expect(p.type).toBe('name');
    const plan = replacePlan(t.doc, p, p.candidates.find((x) => x.name === 'STD-TXT')!, [std], t.nh)!;
    commit(t, [...plan.pre, ...plan.entities.map((x) => ({ kind: 'modify' as const, block: x.block, before: x.before, after: x.after })), ...plan.post]);
    expect((t.doc.entityIndex.get(tx.handle) as TextEntity).style).toBe('STD-TXT');
    expect(t.doc.dimStyles.get('STANDARD')!.vars.DIMTXSTY).toBe('STD-TXT');
    expect(t.doc.textStyles.has('MYTXT')).toBe(false);
    expect(t.doc.textStyles.get('STD-TXT')!.widthFactor).toBe(0.8);
  });

  it('비표준 치수 스타일 대체: 치수가 표준 스타일을 쓰고 Standard는 지우지 않는다', () => {
    const t = newDoc();
    const ds = t.doc.dimStyles.get('STANDARD')!;
    commit(t, [{ kind: 'dimStyle', key: 'MINE', before: null, after: { ...structuredClone(ds), name: 'MINE', handle: t.nh() } }]);
    const d = add(t, dimension('', 'MINE'));
    const s = newDoc();
    const sds = s.doc.dimStyles.get('STANDARD')!;
    commit(s, [{ kind: 'dimStyle', key: 'OFFICE', before: null, after: { ...structuredClone(sds), name: 'OFFICE', handle: s.nh() } }]);
    const std: StdSource = { name: 'o.dws', doc: s.doc };
    const p = checkStandards(t.doc, [std], ['dimStyle']).find((x) => x.id === 'dimStyle:MINE')!;
    const plan = replacePlan(t.doc, p, p.candidates.find((x) => x.name === 'OFFICE')!, [std], t.nh)!;
    commit(t, [...plan.pre, ...plan.entities.map((x) => ({ kind: 'modify' as const, block: x.block, before: x.before, after: x.after })), ...plan.post]);
    expect((t.doc.entityIndex.get(d.handle) as DimensionEntity).dimStyle).toBe('OFFICE');
    expect(t.doc.dimStyles.has('MINE')).toBe(false);
    expect(t.doc.dimStyles.has('OFFICE')).toBe(true);
  });
});

describe('표준 파일 연결 기록(AcStStandard)', () => {
  it('쓰고·바꾸고·지우며 DXF 왕복에서 남는다', () => {
    const t = newDoc();
    expect(readStandardsLink(t.doc)).toEqual([]);
    commit(t, standardsLinkOps(t.doc, ['office.dws', '사내 표준.dws'], t.nh)!);
    expect(readStandardsLink(t.doc)).toEqual(['office.dws', '사내 표준.dws']);
    expect(standardsLinkOps(t.doc, ['office.dws', '사내 표준.dws'], t.nh)).toEqual([]);
    const back = readCadFile(writeDxf(t.doc, { version: 'AC1032' as never }).data, 'rt.dxf');
    expect(readStandardsLink(back)).toEqual(['office.dws', '사내 표준.dws']);
    commit(t, standardsLinkOps(t.doc, ['b.dws'], t.nh)!);
    expect(readStandardsLink(t.doc)).toEqual(['b.dws']);
    commit(t, standardsLinkOps(t.doc, [], t.nh)!);
    expect(readStandardsLink(t.doc)).toEqual([]);
    expect([...t.doc.objects.values()].some((o) => o.type === 'XRECORD' && (o as { data: { value: unknown }[] }).data.some((d) => d.value === 'b.dws'))).toBe(false);
  });
});

/** 루트 사전 AcStStandard의 [항목 이름, XRECORD 자료] */
function acst(doc: CadDocument): [string, unknown[]][] {
  const root = rootDictionary(doc)!;
  const h = [...root.entries].find(([k]) => k === ACST_STANDARD_KEY)?.[1];
  if (!h) return [];
  const d = doc.objects.get(normalizeHandle(h)) as DictionaryObject;
  return [...d.entries].map(([k, x]) => [k, (doc.objects.get(normalizeHandle(x)) as XRecordObject).data.map((t) => [t.code, t.value])]);
}

describe('표준 파일 연결: AutoCAD 형식', () => {
  it('AcStStandard → "0"·"1"… XRECORD(1 = 파일), DWG 왕복', () => {
    const t = newDoc();
    commit(t, standardsLinkOps(t.doc, ['a.dws', 'b.dws'], t.nh)!);
    expect(acst(t.doc)).toEqual([
      ['0', [[1, 'a.dws']]],
      ['1', [[1, 'b.dws']]],
    ]);
    const d = t.doc.objects.get(normalizeHandle([...rootDictionary(t.doc)!.entries].find(([k]) => k === ACST_STANDARD_KEY)![1])) as DictionaryObject;
    expect([d.hardOwner, d.cloning, d.owner]).toEqual([false, 1, rootDictionary(t.doc)!.handle]);
    for (const back of [readCadFile(writeDwg(t.doc, { version: 'AC1032' as never }).data, 'rt.dwg'), readCadFile(writeDwg(t.doc, { version: 'AC1015' as never }).data, 'rt.dwg')]) {
      expect(readStandardsLink(back)).toEqual(['a.dws', 'b.dws']);
    }
    // 순서를 바꾸면 레코드를 다시 쓰고, 빼면 지운다(사전은 남긴다)
    commit(t, standardsLinkOps(t.doc, ['b.dws'], t.nh)!);
    expect(acst(t.doc)).toEqual([['0', [[1, 'b.dws']]]]);
    commit(t, standardsLinkOps(t.doc, [], t.nh)!);
    expect(acst(t.doc)).toEqual([]);
  });

  it('AutoCAD가 적은 전체 경로·다른 태그는 그대로 두고, 같은 파일은 파일 이름으로 맞춘다', () => {
    const t = newDoc();
    const root = rootDictionary(t.doc)!;
    const dh = t.nh();
    const xh = t.nh();
    const path = 'C:\\Std\\XYZ_Layers.dws';
    commit(t, [
      { kind: 'object', key: xh, before: null, after: { type: 'XRECORD', handle: xh, owner: dh, cloning: 1, data: [{ code: 1, value: path }, { code: 1071, value: 3 }] } },
      { kind: 'object', key: dh, before: null, after: { type: 'DICTIONARY', handle: dh, owner: root.handle, entries: new Map([['0', xh]]), hardOwner: false, cloning: 1 } },
      { kind: 'object', key: root.handle, before: root, after: { ...root, entries: new Map([...root.entries, [ACST_STANDARD_KEY, dh]]) } },
    ]);
    expect(readStandardsLink(t.doc)).toEqual([path]);
    expect(stdFileBase(path)).toBe('XYZ_Layers.dws');
    expect(sameStdFile(path, 'xyz_layers.DWS')).toBe(true);
    expect(standardsLinkOps(t.doc, [path], t.nh)).toEqual([]);
    commit(t, standardsLinkOps(t.doc, ['new.dws', path], t.nh)!);
    expect(acst(t.doc)).toEqual([
      ['0', [[1, 'new.dws']]],
      ['1', [[1, path], [1071, 3]]],
    ]);
    expect(t.doc.objects.get(xh)).toBeTruthy();
  });

  it('예전 이 앱 기록(OPENCAD_STANDARDS)을 읽고, 연결을 쓰면 AcStStandard로 옮긴다', () => {
    const t = newDoc();
    const root = rootDictionary(t.doc)!;
    const xh = t.nh();
    commit(t, [
      { kind: 'object', key: xh, before: null, after: { type: 'XRECORD', handle: xh, owner: root.handle, cloning: 1, data: [{ code: 90, value: 1 }, { code: 1, value: 'old.dws' }] } },
      { kind: 'object', key: root.handle, before: root, after: { ...root, entries: new Map([...root.entries, [STANDARDS_KEY, xh]]) } },
    ]);
    expect(readStandardsLink(t.doc)).toEqual(['old.dws']);
    commit(t, standardsLinkOps(t.doc, readStandardsLink(t.doc), t.nh)!);
    expect(acst(t.doc)).toEqual([['0', [[1, 'old.dws']]]]);
    expect(rootDictionary(t.doc)!.entries.has(STANDARDS_KEY)).toBe(false);
    expect(t.doc.objects.has(xh)).toBe(false);
    expect(readStandardsLink(t.doc)).toEqual(['old.dws']);
  });
});
