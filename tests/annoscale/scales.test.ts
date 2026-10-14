/** 축척 리스트(ACAD_SCALELIST)·CANNOSCALE(DICTIONARYVAR)·ANNOALLVISIBLE 자체 기록 */
import { describe, expect, it } from 'vitest';
import type { DictionaryObject, GenericObject } from '../../src/core/model';
import { createDocument } from '../../src/core/model';
import {
  allVisible,
  allVisibleOps,
  cannoscaleName,
  defaultScales,
  dictVarOps,
  findScale,
  listProblem,
  parseRatio,
  percentText,
  ratioText,
  readDictVar,
  readScaleList,
  rootEntry,
  scaleKey,
  scaleList,
  scaleListOps,
  usedScales,
} from '../../src/edit/annoscale';
import { applyOps } from '../../src/edit/session';
import { commit, newDoc } from './helpers';

describe('축척 리스트', () => {
  it('새 도면은 단위에 맞는 AutoCAD 기본 리스트를 사전 키 순서로 읽는다', () => {
    const m = newDoc('metric').doc;
    const i = newDoc('imperial').doc;
    expect(readScaleList(m).map((s) => s.name).slice(0, 4)).toEqual(['1:1', '1:2', '1:4', '1:5']);
    expect(readScaleList(m)).toHaveLength(17);
    expect(readScaleList(i)).toHaveLength(33);
    expect(readScaleList(m)[0]!.unit).toBe(true);
    expect(readScaleList(i).at(-1)!.name).toBe('1\'-0" = 1\'-0"');
    expect(readScaleList(i).at(-1)!.unit).toBe(false);
  });

  it('리스트가 없는 도면은 MEASUREMENT의 기본 리스트를 핸들 없이 쓴다', () => {
    const doc = createDocument('dxf');
    expect(readScaleList(doc)).toEqual([]);
    expect(scaleList(doc)).toHaveLength(33);
    doc.header.set('$MEASUREMENT', 1);
    expect(scaleList(doc)).toHaveLength(17);
    expect(scaleList(doc).every((s) => !s.handle)).toBe(true);
  });

  it('비율 입력·보이기', () => {
    expect(parseRatio('1:50')).toEqual({ paper: 1, drawing: 50 });
    expect(parseRatio('1=50')).toEqual({ paper: 1, drawing: 50 });
    expect(parseRatio('1/50')).toEqual({ paper: 1, drawing: 50 });
    expect(parseRatio('0.25')).toEqual({ paper: 0.25, drawing: 1 });
    expect(parseRatio('0:1')).toBeNull();
    expect(parseRatio('abc')).toBeNull();
    expect(ratioText({ paper: 1, drawing: 50 })).toBe('1 용지 단위 = 50 도면 단위');
    expect(percentText({ paper: 1, drawing: 2 })).toBe('50%');
    expect(scaleKey(0)).toBe('A0');
    expect(scaleKey(13)).toBe('B3');
  });

  it('검사: 이름 겹침, 단위, 개수', () => {
    const l = defaultScales(true);
    expect(listProblem(l)).toBeNull();
    expect(listProblem([...l, { name: '1:2', paper: 1, drawing: 3, unit: false }])).toMatch(/겹칩니다/);
    expect(listProblem([{ name: 'x', paper: 0, drawing: 1, unit: false }])).toMatch(/단위/);
    expect(listProblem([])).toMatch(/하나 이상/);
  });

  it('바꾸기: 이름 바꿈·추가·삭제·순서, 키를 다시 매긴다', () => {
    const { doc, session } = newDoc('metric');
    const list = readScaleList(doc);
    const h12 = list[1]!.handle!;
    const next = [list[0]!, { ...list[1]!, name: '반', drawing: 2 }, { name: '1:25', paper: 1, drawing: 25, unit: false }, ...list.slice(3)];
    const r = scaleListOps(doc, next, () => session.newHandle());
    expect(r.renamed.get('1:2')).toBe('반');
    commit(session, r.ops);
    const after = readScaleList(doc);
    expect(after.map((s) => s.name).slice(0, 4)).toEqual(['1:1', '반', '1:25', '1:5']);
    expect(after[1]!.handle).toBe(h12);
    // 1:4는 지워졌다
    expect(findScale(after, '1:4')).toBeUndefined();
    const dict = rootEntry(doc, 'ACAD_SCALELIST')!;
    expect([...dict.entries.keys()].slice(0, 4)).toEqual(['A0', 'A1', 'A2', 'A3']);
    // 명령 취소
    session.undo();
    expect(readScaleList(doc).map((s) => s.name).slice(0, 3)).toEqual(['1:1', '1:2', '1:4']);
  });

  it('쓰이는 축척은 지우지 않고 리스트 끝에 남긴다', () => {
    const { doc, session } = newDoc('metric');
    const list = readScaleList(doc);
    const h = list[2]!.handle!;
    const r = scaleListOps(doc, list.filter((_, i) => i !== 2), () => session.newHandle(), new Set([h]));
    expect(r.kept).toEqual(['1:4']);
    commit(session, r.ops);
    expect(readScaleList(doc).at(-1)!.name).toBe('1:4');
  });

  it('리스트가 없는 도면에 리스트를 만든다(루트 사전 항목과 함께)', () => {
    const { doc, session } = newDoc('metric');
    const root = doc.objects.get(doc.rootDictionary!) as DictionaryObject;
    // 리스트 사전을 떼어 낸다
    const without = new Map([...root.entries].filter(([k]) => k !== 'ACAD_SCALELIST'));
    applyOps(doc, [{ kind: 'object', key: root.handle, before: root, after: { ...root, entries: without } }]);
    expect(readScaleList(doc)).toEqual([]);
    const r = scaleListOps(doc, defaultScales(true), () => session.newHandle());
    commit(session, r.ops);
    expect(readScaleList(doc)).toHaveLength(17);
    expect(r.list.every((s) => !!s.handle)).toBe(true);
  });
});

describe('CANNOSCALE', () => {
  it('변수가 없으면 1:1, 쓰면 변수 사전과 DICTIONARYVAR를 만든다', () => {
    const { doc, session } = newDoc('metric');
    expect(cannoscaleName(doc)).toBe('1:1');
    commit(session, dictVarOps(doc, 'CANNOSCALE', '1:50', () => session.newHandle()));
    expect(readDictVar(doc, 'CANNOSCALE')).toBe('1:50');
    const v = [...doc.objects.values()].find((o) => o.type === 'DICTIONARYVAR') as GenericObject;
    expect(v.raw).toEqual([
      { code: 100, value: 'DictionaryVariables' },
      { code: 280, value: 0 },
      { code: 1, value: '1:50' },
    ]);
    expect(rootEntry(doc, 'AcDbVariableDictionary')!.entries.get('CANNOSCALE')).toBe(v.handle);
    // 이미 있는 변수는 1만 바꾼다(DWG처럼 100이 없어도)
    const dwgLike = { ...v, raw: [{ code: 280, value: 0 }, { code: 1, value: '1:50' }] };
    applyOps(doc, [{ kind: 'object', key: v.handle, before: v, after: dwgLike }]);
    commit(session, dictVarOps(doc, 'CANNOSCALE', '1:2', () => session.newHandle()));
    expect((doc.objects.get(v.handle) as GenericObject).raw).toEqual([
      { code: 280, value: 0 },
      { code: 1, value: '1:2' },
    ]);
    session.undo();
    expect(readDictVar(doc, 'CANNOSCALE')).toBe('1:50');
  });

  it('리스트 만들기와 변수 만들기를 한 변경에 해도 루트 사전 항목이 모두 남는다', () => {
    const { doc, session } = newDoc('metric');
    const root = doc.objects.get(doc.rootDictionary!) as DictionaryObject;
    applyOps(doc, [{ kind: 'object', key: root.handle, before: root, after: { ...root, entries: new Map([...root.entries].filter(([k]) => k !== 'ACAD_SCALELIST')) } }]);
    const alloc = () => session.newHandle();
    const r = scaleListOps(doc, defaultScales(true), alloc);
    const ops = [...r.ops];
    dictVarOps(doc, 'CANNOSCALE', '1:10', alloc, ops);
    commit(session, ops);
    expect(readScaleList(doc)).toHaveLength(17);
    expect(cannoscaleName(doc)).toBe('1:10');
  });
});

describe('ANNOALLVISIBLE(탭마다)', () => {
  it('0이면 LAYOUT 객체에 자체 기록, 1이면 지운다', () => {
    const { doc, session } = newDoc('metric');
    expect(allVisible(doc, '*Model_Space')).toBe(true);
    commit(session, allVisibleOps(doc, '*Model_Space', false));
    expect(allVisible(doc, '*Model_Space')).toBe(false);
    expect(allVisible(doc, '*Paper_Space')).toBe(true);
    commit(session, allVisibleOps(doc, '*Model_Space', true));
    expect(allVisible(doc, '*Model_Space')).toBe(true);
    const lay = doc.layouts.find((l) => l.name === 'Model')!;
    expect(doc.objects.get(lay.handle)!.xdata).toBeUndefined();
  });
});

describe('쓰이는 축척', () => {
  it('레코드·뷰포트 기록·자체 기록이 가리키는 축척', () => {
    const { doc } = newDoc('metric');
    const u = usedScales(doc);
    expect(u.handles.size).toBe(0);
  });
});
