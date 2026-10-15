/**
 * 도면층 필터 저장: AutoCAD 형식(LAYER 표 확장 사전 → ACLYDICTIONARY → AcLyLayerFilter·AcLyLayerGroup XRECORD, 중첩은
 * XRECORD 확장 사전의 ACLYDICTIONARY), AutoCAD 형식으로 쓸 수 없는 필터의 이 앱 기록(OPENCAD_LAYERFILTERS), 예전 이 앱 기록 옮기기,
 * 읽기 전용 식, 예전 AutoCAD 필터 사전(ACAD_LAYERFILTERS) 거울 정리, DXF·DWG 왕복, AutoCAD 표본 보존.
 * 레코드는 손으로 만든 최소 태그로 시험한다(공개 도면은 형식 확인에만 썼다).
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, DictionaryObject, RawTag, XRecordObject } from '../../src/core/model';
import { normalizeHandle, tableKey } from '../../src/core/model';
import { aclyTags, nextAnonymousKey, parseAclyTags } from '../../src/edit/layerfilter/acly';
import { FilterEvaluator } from '../../src/edit/layerfilter/match';
import type { LayerFilter } from '../../src/edit/layerfilter/model';
import { FILTER_MARK, filterRecordTags, parseFilterTags } from '../../src/edit/layerfilter/record';
import {
  ACLY_DICT,
  FILTERS_KEY,
  LayerFilterWriter,
  aclyDict,
  autocadFilterEntries,
  dropLayerFromFiltersOps,
  layerFiltersDict,
  listLayerFilters,
  listStoredFilters,
  migrateLayerFiltersOps,
} from '../../src/edit/layerfilter/store';
import { LayerStateWriter, captureLayerState, layerTableDict, layerTableXdict, listLayerStates } from '../../src/edit/layerstate/store';
import { type TestDoc, addLayer, commit, duplicateHandles, fixture, newDoc, readFixture, roundTrip } from '../layerstate/helpers';

const prop = (name: string, rows: LayerFilter['rows'], parent: string | null = null): LayerFilter => ({ name, kind: 'property', parent, rows, layers: [] });
const group = (name: string, layers: string[], parent: string | null = null): LayerFilter => ({ name, kind: 'group', parent, rows: [], layers });

const obj = (doc: CadDocument, h: string) => doc.objects.get(normalizeHandle(h));
const xrec = (doc: CadDocument, h: string) => obj(doc, h) as XRecordObject;
/** 태그 값 비교용(DXF 리더는 숫자를 글로 둘 수 있다): 숫자 글은 숫자로 */
const val = (tags: readonly RawTag[]) =>
  tags.map((t) => {
    const v = String(t.value).trim();
    return [t.code, /^-?\d+$/.test(v) ? Number(v) : v];
  });

/** 필터 XRECORD의 중첩 사전 */
function nestedDict(doc: CadDocument, recHandle: string): DictionaryObject | null {
  const x = xrec(doc, recHandle);
  const xd = x.xdict ? (obj(doc, x.xdict) as DictionaryObject) : null;
  const h = xd?.entries.get(ACLY_DICT);
  return h ? (obj(doc, h) as DictionaryObject) : null;
}

function build(): TestDoc {
  const t = newDoc();
  addLayer(t, 'A-WALL', { color: { aci: 1 } });
  addLayer(t, 'A-DOOR', { color: { aci: 3 } });
  addLayer(t, '설비-배관', { color: { aci: 5 }, locked: true });
  const w = new LayerFilterWriter(t.doc, t.nh);
  w.put(prop('건축', [{ NAME: 'A-*' }, { COLOR: '5', LOCKED: 'LOCKED' }]));
  w.put(prop('건축 빨강', [{ COLOR: '1' }], '건축'));
  w.put(group('내 그룹', ['A-DOOR', '설비-배관']));
  w.put(group('하위 그룹', ['A-WALL'], '내 그룹'));
  w.put(prop('그룹 안 잠김', [{ LOCKED: 'LOCKED' }], '내 그룹'));
  commit(t, w.finish());
  return t;
}

function sorted(fs: LayerFilter[]): LayerFilter[] {
  return [...fs].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ ...f, layers: [...f.layers].sort() }));
}

describe('AutoCAD 레코드(acly)', () => {
  it('태그 ↔ 레코드: 앞 태그(290)·모르는 태그·빈 핸들은 그대로', () => {
    const tags: RawTag[] = [
      { code: 290, value: 1 },
      { code: 1, value: 'AcLyLayerGroup' },
      { code: 90, value: 1 },
      { code: 300, value: '그룹' },
      { code: 330, value: '2a' },
      { code: 330, value: '' },
      { code: 1071, value: 5 },
    ];
    const r = parseAclyTags(tags)!;
    expect(r.kind).toBe('group');
    expect(r.name).toBe('그룹');
    expect(r.layerHandles).toEqual(['2A', '']);
    expect(r.lead).toEqual([{ code: 290, value: 1 }]);
    expect(r.tail).toEqual([{ code: 1071, value: 5 }]);
    expect(val(aclyTags(r))).toEqual([
      [290, 1],
      [1, 'AcLyLayerGroup'],
      [90, 1],
      [300, '그룹'],
      [330, '2A'],
      [330, ''],
      [1071, 5],
    ]);
    const p = parseAclyTags([
      { code: 1, value: 'AcLyLayerFilter' },
      { code: 90, value: '        1' },
      { code: 300, value: 'P' },
      { code: 301, value: 'NAME=="A*"' },
    ])!;
    expect([p.kind, p.name, p.expression, p.version]).toEqual(['property', 'P', 'NAME=="A*"', 1]);
    expect(parseAclyTags([{ code: 1, value: FILTER_MARK }])).toBeNull();
    expect(nextAnonymousKey(['*A1', '*A3', 'X'])).toBe('*A2');
    expect(nextAnonymousKey([])).toBe('*A1');
  });

  it('예전 이 앱 레코드 태그(record.ts)는 그대로 읽는다', () => {
    const f = prop('F', [{ NAME: 'A*', COLOR: '1', VPCOLOR: '2' }, { ON: 'OFF' }]);
    const tags = filterRecordTags(f, '1F', { layer: () => null }, [{ code: 1071, value: 7 }]);
    const back = parseFilterTags(tags, 'x', { layer: () => null })!;
    expect(back.parentHandle).toBe('1F');
    expect(back.filter.rows).toEqual(f.rows);
    expect(back.extra).toEqual([{ code: 1071, value: 7 }]);
  });
});

describe('쓰기·고치기·지우기(AutoCAD 형식)', () => {
  it('ACLYDICTIONARY에 *An 항목, 중첩은 부모 XRECORD의 확장 사전, 그룹은 도면층 핸들', () => {
    const t = build();
    const d = aclyDict(t.doc)!;
    expect(layerTableXdict(t.doc)!.entries.has(ACLY_DICT)).toBe(true);
    expect(layerFiltersDict(t.doc)).toBeNull();
    expect([...d.entries.keys()]).toEqual(['*A1', '*A2']);
    expect(d.hardOwner).toBe(false);
    const top = (n: string) => [...d.entries.values()].find((h) => parseAclyTags(xrec(t.doc, h).data)!.name === n)!;
    const arch = xrec(t.doc, top('건축'));
    expect(val(arch.data)).toEqual([
      [1, 'AcLyLayerFilter'],
      [90, 1],
      [300, '건축'],
      [301, 'NAME=="A-*" OR (LOCKED=="True" AND COLOR=="5")'],
    ]);
    expect(arch.owner).toBe(d.handle);
    const kids = nestedDict(t.doc, top('건축'))!;
    expect(obj(t.doc, kids.owner!)!.owner).toBe(arch.handle);
    expect([...kids.entries.keys()]).toEqual(['*A1']);
    expect(val(xrec(t.doc, kids.entries.get('*A1')!).data)).toEqual([
      [1, 'AcLyLayerFilter'],
      [90, 1],
      [300, '건축 빨강'],
      [301, 'COLOR=="1"'],
    ]);
    const grp = xrec(t.doc, top('내 그룹'));
    expect(grp.data.filter((x) => x.code === 330).map((x) => x.value)).toEqual([t.doc.layers.get('A-DOOR')!.handle, t.doc.layers.get(tableKey('설비-배관'))!.handle]);
    expect([...nestedDict(t.doc, top('내 그룹'))!.entries.keys()]).toEqual(['*A1', '*A2']);
    const fs = listLayerFilters(t.doc);
    expect(fs.find((f) => f.name === '하위 그룹')!.parent).toBe('내 그룹');
    expect(fs.find((f) => f.name === '건축 빨강')!.parent).toBe('건축');
    expect(fs.find((f) => f.name === '내 그룹')!.layers.sort()).toEqual(['A-DOOR', '설비-배관']);
    expect(listStoredFilters(t.doc).every((s) => s.format === 'acad' && !s.readOnly)).toBe(true);
    expect(duplicateHandles(t.doc)).toEqual([]);
  });

  it('이름 바꾸기는 자식을 그대로 두고, 삭제는 아래 필터(중첩 사전)까지 지운다. 명령 취소로 되돌린다', () => {
    const t = build();
    const before = t.doc.objects.size;
    const w = new LayerFilterWriter(t.doc, t.nh);
    expect(w.rename('건축', '건축물')).toBe(true);
    expect(w.rename('건축물', '내 그룹')).toBe(false);
    commit(t, w.finish());
    const fs = listLayerFilters(t.doc);
    expect(fs.find((f) => f.name === '건축 빨강')!.parent).toBe('건축물');
    const w2 = new LayerFilterWriter(t.doc, t.nh);
    expect(w2.remove('내 그룹').sort()).toEqual(['그룹 안 잠김', '내 그룹', '하위 그룹']);
    commit(t, w2.finish());
    expect(listLayerFilters(t.doc).map((f) => f.name)).toEqual(['건축물', '건축 빨강']);
    // 지운 필터의 레코드·확장 사전·중첩 사전이 남지 않는다
    expect(t.doc.objects.size).toBe(before - 5);
    t.session.undo();
    expect(listLayerFilters(t.doc).length).toBe(5);
    t.session.undo();
    expect(listLayerFilters(t.doc).map((f) => f.name)).toContain('건축');
  });

  it('마지막 자식을 지우거나 옮기면 부모 레코드의 빈 중첩 사전·확장 사전을 지운다', () => {
    const t = build();
    const arch = () => listStoredFilters(t.doc).find((s) => s.filter.name === '건축')!;
    expect(xrec(t.doc, arch().handle).xdict).toBeTruthy();
    const n = t.doc.objects.size;
    const w = new LayerFilterWriter(t.doc, t.nh);
    w.put(prop('건축 빨강', [{ COLOR: '1' }]), '건축 빨강');
    commit(t, w.finish());
    expect(listLayerFilters(t.doc).find((f) => f.name === '건축 빨강')!.parent).toBeNull();
    expect(xrec(t.doc, arch().handle).xdict).toBeUndefined();
    expect(t.doc.objects.size).toBe(n - 2);
    expect(duplicateHandles(t.doc)).toEqual([]);
  });

  it('도면층 이름을 바꿔도 그룹은 핸들로 따라가고, 지운 도면층은 뺀다', () => {
    const t = build();
    const before = t.doc.layers.get('A-DOOR')!;
    commit(t, [
      { kind: 'layer', key: 'A-DOOR', before, after: null },
      { kind: 'layer', key: 'A-DOOR2', before: null, after: { ...before, name: 'A-DOOR2' } },
    ]);
    expect(listLayerFilters(t.doc).find((f) => f.name === '내 그룹')!.layers.sort()).toEqual(['A-DOOR2', '설비-배관']);
    const pipe = t.doc.layers.get(tableKey('설비-배관'))!;
    const ops = dropLayerFromFiltersOps(t.doc, pipe.handle, t.nh);
    expect(ops.length).toBe(1);
    commit(t, [...ops, { kind: 'layer', key: tableKey('설비-배관'), before: pipe, after: null }]);
    const g = listStoredFilters(t.doc).find((s) => s.filter.name === '내 그룹')!;
    expect(g.filter.layers).toEqual(['A-DOOR2']);
    expect(g.unresolved).toEqual([]);
  });

  it('AutoCAD 형식으로 쓸 수 없는 조건(투명도)은 이 앱 기록 — 그 아래 필터도 따라가고, 조건을 빼면 다시 AutoCAD 형식으로', () => {
    const t = build();
    const w = new LayerFilterWriter(t.doc, t.nh);
    expect(w.problem(prop('건축', [{ TRANSPARENCY: '50' }]), '건축')).toBeNull();
    w.put(prop('건축', [{ TRANSPARENCY: '50' }]), '건축');
    commit(t, w.finish());
    const st = listStoredFilters(t.doc);
    const fmt = (n: string) => st.find((s) => s.filter.name === n)!.format;
    expect(fmt('건축')).toBe('app');
    expect(fmt('건축 빨강')).toBe('app');
    expect(fmt('내 그룹')).toBe('acad');
    expect(st.find((s) => s.filter.name === '건축 빨강')!.filter.parent).toBe('건축');
    expect([...aclyDict(t.doc)!.entries.keys()]).toHaveLength(1);
    expect([...layerFiltersDict(t.doc)!.entries.keys()].sort()).toEqual(['건축', '건축 빨강']);
    // 이 앱 기록 필터 아래에 AutoCAD 형식 부모를 가진 필터를 새로 만들면 이 앱 기록
    const w2 = new LayerFilterWriter(t.doc, t.nh);
    w2.put(prop('건축 문', [{ NAME: 'A-D*' }], '건축'));
    commit(t, w2.finish());
    expect(listStoredFilters(t.doc).find((s) => s.filter.name === '건축 문')!.format).toBe('app');
    // 되돌리기: 조건을 바꾸면 자식까지 다시 AutoCAD 형식, 이 앱 기록 사전은 지운다
    const w3 = new LayerFilterWriter(t.doc, t.nh);
    w3.put(prop('건축', [{ NAME: 'A-*' }]), '건축');
    commit(t, w3.finish());
    const st3 = listStoredFilters(t.doc);
    expect(st3.every((s) => s.format === 'acad')).toBe(true);
    expect(st3.find((s) => s.filter.name === '건축 문')!.filter.parent).toBe('건축');
    expect(layerFiltersDict(t.doc)).toBeNull();
    expect(layerTableXdict(t.doc)!.entries.has(FILTERS_KEY)).toBe(false);
    expect(duplicateHandles(t.doc)).toEqual([]);
    const ev = new FilterEvaluator(t.doc, listLayerFilters(t.doc));
    expect([...ev.layers('건축 문')!]).toEqual(['A-DOOR']);
  });

  it('그룹에 핸들 없는 도면층이 있으면 이 앱 기록(이름 8)', () => {
    const t = newDoc();
    commit(t, [{ kind: 'layer', key: 'NOH', before: null, after: { name: 'NOH', handle: '', flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 } }]);
    const w = new LayerFilterWriter(t.doc, t.nh);
    w.put(group('G', ['NOH']));
    commit(t, w.finish());
    const s = listStoredFilters(t.doc)[0]!;
    expect(s.format).toBe('app');
    expect(s.filter.layers).toEqual(['NOH']);
  });
});

/** AutoCAD가 쓴 것과 같은 꼴의 사전·레코드를 도면에 넣는다(손으로 만든 최소 태그) */
function addAcad(t: TestDoc, recs: { data: RawTag[]; nested?: RawTag[][] }[], legacy: string[] = [], xdata = '<All'): { dict: string; recs: string[] } {
  const sw = new LayerStateWriter(t.doc, t.nh);
  sw.put(captureLayerState(t.doc, { name: '평면' }));
  commit(t, sw.finish());
  const xd = layerTableXdict(t.doc)!;
  const dict: DictionaryObject = { type: 'DICTIONARY', handle: t.nh(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1, xdata: [{ app: 'ACAD', items: [{ code: 1000, value: xdata }] }] };
  const ops: Parameters<typeof commit>[1] = [];
  const handles: string[] = [];
  recs.forEach((r, i) => {
    const h = t.nh();
    handles.push(h);
    const x: XRecordObject = { type: 'XRECORD', handle: h, owner: dict.handle, reactors: [dict.handle], cloning: 1, data: r.data };
    dict.entries.set(`*A${i + 1}`, h);
    if (r.nested) {
      const xh = t.nh();
      const nh = t.nh();
      x.xdict = xh;
      const nd: DictionaryObject = { type: 'DICTIONARY', handle: nh, owner: xh, reactors: [xh], entries: new Map(), hardOwner: false, cloning: 1 };
      ops.push({ kind: 'object', key: xh, before: null, after: { type: 'DICTIONARY', handle: xh, owner: h, entries: new Map([[ACLY_DICT, nh]]), hardOwner: true, cloning: 1 } as DictionaryObject });
      r.nested.forEach((data, j) => {
        const ch = t.nh();
        nd.entries.set(`*A${j + 1}`, ch);
        ops.push({ kind: 'object', key: ch, before: null, after: { type: 'XRECORD', handle: ch, owner: nh, reactors: [nh], cloning: 1, data } as XRecordObject });
      });
      ops.push({ kind: 'object', key: nh, before: null, after: nd });
    }
    ops.push({ kind: 'object', key: h, before: null, after: x });
  });
  const entries = new Map([...xd.entries, [ACLY_DICT, dict.handle]]);
  if (legacy.length) {
    const lh = t.nh();
    const ld: DictionaryObject = { type: 'DICTIONARY', handle: lh, owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    for (const n of legacy) {
      const rh = t.nh();
      ld.entries.set(n, rh);
      ops.push({ kind: 'object', key: rh, before: null, after: { type: 'XRECORD', handle: rh, owner: lh, reactors: [lh], cloning: 1, data: [{ code: 1, value: n }, { code: 1, value: '*' }, { code: 70, value: 0 }] } as XRecordObject });
    }
    ops.push({ kind: 'object', key: lh, before: null, after: ld });
    entries.set('ACAD_LAYERFILTERS', lh);
  }
  ops.push({ kind: 'object', key: dict.handle, before: null, after: dict }, { kind: 'object', key: xd.handle, before: xd, after: { ...xd, entries } });
  commit(t, ops);
  return { dict: dict.handle, recs: handles };
}

const acadProp = (name: string, expr: string, lead: RawTag[] = []): RawTag[] => [...lead, { code: 1, value: 'AcLyLayerFilter' }, { code: 90, value: 1 }, { code: 300, value: name }, { code: 301, value: expr }];
const acadGroup = (name: string, handles: string[]): RawTag[] => [{ code: 1, value: 'AcLyLayerGroup' }, { code: 90, value: 1 }, { code: 300, value: name }, ...handles.map((h) => ({ code: 330, value: h }))];

describe('AutoCAD가 쓴 필터 읽기·고치기', () => {
  it('식은 정의 행으로, 그룹은 핸들로, 중첩은 확장 사전으로 읽는다', () => {
    const t = newDoc();
    const a = addLayer(t, 'A_ANNO-1');
    addLayer(t, 'Xref_1', { frozen: true });
    addAcad(t, [
      { data: acadProp('A_Area', '( NAME== "A_ANNO*" or NAME== "A_AREA*" )'), nested: [acadProp('안', 'COLOR=="1"')] },
      { data: acadProp('Xref Gelés', '( NAME== "Xref_*" ) and FROZEN == "FALSE"') },
      { data: acadGroup('G', [a.handle, '', 'FFFF']) },
      { data: acadProp('빈 필터', '""""') },
    ]);
    const st = listStoredFilters(t.doc);
    const f = (n: string) => st.find((s) => s.filter.name === n)!;
    expect(f('A_Area').filter.rows).toEqual([{ NAME: 'A_ANNO*' }, { NAME: 'A_AREA*' }]);
    expect(f('안').filter.parent).toBe('A_Area');
    expect(f('Xref Gelés').filter.rows).toEqual([{ NAME: 'Xref_*', FROZEN: 'THAWED' }]);
    expect(f('G').filter.layers).toEqual(['A_ANNO-1']);
    expect(f('G').unresolved).toEqual(['FFFF']);
    expect(f('빈 필터').filter.rows).toEqual([]);
    const ev = new FilterEvaluator(t.doc, st.map((s) => s.filter));
    expect([...ev.layers('A_Area')!]).toEqual(['A_ANNO-1']);
    expect([...ev.layers('Xref Gelés')!]).toEqual([]);
    expect(ev.layers('빈 필터')!.size).toBe(t.doc.layers.size);
  });

  it('바꿀 수 없는 식은 읽기 전용 — 이름을 바꾸거나 다른 필터를 고쳐도 식과 앞 태그(290)는 그대로', () => {
    const t = newDoc();
    addLayer(t, 'A1', { locked: true });
    const expr = 'USED=="TRUE" AND VPOVERRIDES=="FALSE" AND NAME=="A*"';
    const { recs } = addAcad(t, [{ data: acadProp('VP', expr, [{ code: 290, value: 1 }]) }, { data: acadProp('B', 'NAME=="B*"') }]);
    const s = listStoredFilters(t.doc).find((x) => x.filter.name === 'VP')!;
    expect(s.readOnly).toBe(true);
    expect(s.filter.expression).toBe(expr);
    const w = new LayerFilterWriter(t.doc, t.nh);
    w.put({ ...s.filter, name: 'VP2' }, 'VP');
    w.put(prop('B', [{ NAME: 'B*', LOCKED: 'LOCKED' }]), 'B');
    commit(t, w.finish());
    expect(val(xrec(t.doc, recs[0]!).data)).toEqual([
      [290, 1],
      [1, 'AcLyLayerFilter'],
      [90, 1],
      [300, 'VP2'],
      [301, expr],
    ]);
    expect(xrec(t.doc, recs[1]!).data.find((x) => x.code === 301)!.value).toBe('NAME=="B*" AND LOCKED=="True"');
    // 미리보기: 아는 열(USED·NAME)만 따진다 — A1은 객체가 없어 USED가 아니다
    expect(new FilterEvaluator(t.doc, listLayerFilters(t.doc)).layers('VP2')!.size).toBe(0);
  });

  it('정의가 같으면 원래 식 글을 그대로 둔다(이름만 바꿀 때)', () => {
    const t = newDoc();
    const expr = '( NAME== "A_ANNO*" or NAME== "A_AREA*" )';
    const { recs } = addAcad(t, [{ data: acadProp('A', expr) }]);
    const w = new LayerFilterWriter(t.doc, t.nh);
    w.rename('A', 'A2');
    commit(t, w.finish());
    expect(xrec(t.doc, recs[0]!).data.find((x) => x.code === 301)!.value).toBe(expr);
  });

  it('읽기 전용 필터가 아래에 있으면 부모를 AutoCAD에서 읽지 못하는 조건으로 바꿀 수 없다', () => {
    const t = newDoc();
    addAcad(t, [{ data: acadProp('P', 'NAME=="A*"'), nested: [acadProp('RO', 'VPOVERRIDES=="TRUE"')] }]);
    const w = new LayerFilterWriter(t.doc, t.nh);
    expect(w.problem(prop('P', [{ DESCRIPTION: '*벽*' }]), 'P')).toContain('RO');
    expect(w.problem(prop('P', [{ NAME: 'B*' }]), 'P')).toBeNull();
  });

  it('고치거나 지운 맨 위 필터와 이름이 같은 예전 AutoCAD 사전(ACAD_LAYERFILTERS) 항목만 지운다', () => {
    const t = newDoc();
    addAcad(t, [{ data: acadProp('A', 'NAME=="A*"') }, { data: acadProp('B', 'NAME=="B*"') }, { data: acadProp('C', 'NAME=="C*"') }], ['A', 'B', 'C']);
    const w = new LayerFilterWriter(t.doc, t.nh);
    w.remove('A');
    w.rename('B', 'B2');
    w.put(prop('C', [{ NAME: 'C*' }]), 'C');
    commit(t, w.finish());
    // C는 정의가 같아 그대로 — 거울도 남는다
    expect([...layerTableDict(t.doc, 'ACAD_LAYERFILTERS')!.entries.keys()]).toEqual(['C']);
    expect(autocadFilterEntries(t.doc)).toEqual([{ dict: 'ACAD_LAYERFILTERS', count: 1 }]);
    expect(listLayerFilters(t.doc).map((f) => f.name).sort()).toEqual(['B2', 'C']);
  });
});

/** 예전 빌드가 쓴 이 앱 기록(OPENCAD_LAYERFILTERS)을 만든다 */
function addLegacy(t: TestDoc, fs: LayerFilter[]): void {
  const sw = new LayerStateWriter(t.doc, t.nh);
  sw.put(captureLayerState(t.doc, { name: '평면' }));
  commit(t, sw.finish());
  const xd = layerTableXdict(t.doc)!;
  const dict: DictionaryObject = { type: 'DICTIONARY', handle: t.nh(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1 };
  const ops: Parameters<typeof commit>[1] = [];
  const hs = new Map<string, string>();
  for (const f of fs) {
    const h = t.nh();
    hs.set(f.name, h);
    const data = filterRecordTags(f, f.parent ? hs.get(f.parent)! : null, { layer: (n) => t.doc.layers.get(tableKey(n))?.handle ?? undefined });
    dict.entries.set(f.name, h);
    ops.push({ kind: 'object', key: h, before: null, after: { type: 'XRECORD', handle: h, owner: dict.handle, reactors: [dict.handle], cloning: 1, data } as XRecordObject });
  }
  ops.push({ kind: 'object', key: dict.handle, before: null, after: dict }, { kind: 'object', key: xd.handle, before: xd, after: { ...xd, entries: new Map([...xd.entries, [FILTERS_KEY, dict.handle]]) } });
  commit(t, ops);
}

describe('예전 이 앱 기록 옮기기', () => {
  it('읽고, 쓸 수 있는 것은 AutoCAD 형식으로 옮긴다(중첩 유지, 쓸 수 없는 것과 그 아래는 남긴다)', () => {
    const t = newDoc();
    addLayer(t, 'A');
    addLayer(t, 'B');
    addLegacy(t, [prop('P', [{ NAME: 'A*' }]), group('G', ['A', 'B']), prop('P안', [{ COLOR: '1' }], 'P'), prop('투명', [{ TRANSPARENCY: '30' }]), prop('투명안', [{ NAME: '*' }], '투명')]);
    const before = listLayerFilters(t.doc);
    expect(before.map((f) => f.name)).toEqual(['P', 'G', 'P안', '투명', '투명안']);
    expect(listStoredFilters(t.doc).every((s) => s.format === 'app')).toBe(true);
    const ops = migrateLayerFiltersOps(t.doc, t.nh);
    commit(t, ops);
    const st = listStoredFilters(t.doc);
    const fmt = (n: string) => st.find((s) => s.filter.name === n)!.format;
    expect([fmt('P'), fmt('G'), fmt('P안'), fmt('투명'), fmt('투명안')]).toEqual(['acad', 'acad', 'acad', 'app', 'app']);
    expect(sorted(listLayerFilters(t.doc))).toEqual(sorted(before));
    expect([...layerFiltersDict(t.doc)!.entries.keys()].sort()).toEqual(['투명', '투명안']);
    expect(migrateLayerFiltersOps(t.doc, t.nh)).toEqual([]);
    expect(duplicateHandles(t.doc)).toEqual([]);
    t.session.undo();
    expect(listStoredFilters(t.doc).every((s) => s.format === 'app')).toBe(true);
  });

  it('필터를 고치면 함께 옮기고, 다 옮기면 이 앱 기록 사전을 지운다', () => {
    const t = newDoc();
    addLayer(t, 'A');
    addLegacy(t, [prop('P', [{ NAME: 'A*' }]), group('G', ['A'])]);
    const w = new LayerFilterWriter(t.doc, t.nh);
    w.put(prop('새 필터', [{ ON: 'OFF' }]));
    commit(t, w.finish());
    expect(listStoredFilters(t.doc).map((s) => `${s.format}:${s.filter.name}`).sort()).toEqual(['acad:G', 'acad:P', 'acad:새 필터']);
    expect(layerFiltersDict(t.doc)).toBeNull();
  });
});

function sameFilters(a: CadDocument, b: CadDocument): void {
  expect(sorted(listLayerFilters(b))).toEqual(sorted(listLayerFilters(a)));
  const ea = new FilterEvaluator(a, listLayerFilters(a));
  const eb = new FilterEvaluator(b, listLayerFilters(b));
  for (const f of listLayerFilters(a)) expect([...eb.layers(f.name)!].sort()).toEqual([...ea.layers(f.name)!].sort());
}

describe('DXF·DWG 왕복', () => {
  for (const [fmt, ver] of [
    ['dxf', 'AC1032'],
    ['dxf', 'AC1015'],
    ['dwg', 'AC1032'],
    ['dwg', 'AC1018'],
    ['dwg', 'AC1015'],
  ] as const) {
    it(`${fmt} ${ver}`, () => {
      const t = build();
      const w0 = new LayerFilterWriter(t.doc, t.nh);
      w0.put(prop('투명', [{ TRANSPARENCY: '50' }], '건축'));
      commit(t, w0.finish());
      const back = roundTrip(t.doc, fmt, ver);
      sameFilters(t.doc, back);
      expect(listStoredFilters(back).map((s) => `${s.format}:${s.filter.name}`).sort()).toEqual(['acad:건축', 'acad:건축 빨강', 'acad:그룹 안 잠김', 'acad:내 그룹', 'acad:하위 그룹', 'app:투명']);
      expect(listLayerFilters(back).find((f) => f.name === '투명')!.parent).toBe('건축');
      // 다시 고치고 한 번 더
      const nh = (() => {
        let n = 0x7000;
        return () => (n++).toString(16).toUpperCase();
      })();
      const w = new LayerFilterWriter(back, nh);
      w.put({ ...listLayerFilters(back).find((f) => f.name === '건축')!, rows: [{ NAME: 'A-D*' }] }, '건축');
      const ops = w.finish();
      expect(ops.every((o) => o.kind === 'object')).toBe(true);
      for (const o of ops) if (o.kind === 'object') (o.after ? back.objects.set(o.key, o.after) : back.objects.delete(o.key));
      const again = roundTrip(back, fmt, ver);
      expect(listLayerFilters(again).find((f) => f.name === '건축')!.rows).toEqual([{ NAME: 'A-D*' }]);
      expect(listLayerFilters(again).find((f) => f.name === '건축 빨강')!.parent).toBe('건축');
    });
  }
});

describe('원본 보존', () => {
  for (const fmt of ['dxf', 'dwg'] as const) {
    it(`ACLYDICTIONARY 확장 자료·모르는 레코드·도면층 상태는 그대로(${fmt})`, () => {
      const t = newDoc();
      addLayer(t, 'A');
      const { dict } = addAcad(t, [{ data: acadProp('ACAD 필터', 'NAME=="A*"') }, { data: [{ code: 1, value: 'SomethingElse' }, { code: 90, value: 3 }] }]);
      const w = new LayerFilterWriter(t.doc, t.nh);
      w.put(group('G', ['A']));
      commit(t, w.finish());
      const back = roundTrip(t.doc, fmt);
      const acly = layerTableDict(back, 'ACLYDICTIONARY')!;
      expect(normalizeHandle(acly.handle)).toBe(normalizeHandle(dict));
      expect(acly.xdata?.[0]?.items[0]?.value).toBe('<All');
      expect([...acly.entries.keys()]).toEqual(['*A1', '*A2', '*A3']);
      const other = xrec(back, acly.entries.get('*A2')!);
      expect(val(other.data)).toEqual([
        [1, 'SomethingElse'],
        [90, 3],
      ]);
      expect(listLayerStates(back).map((s) => s.key)).toEqual(['평면']);
      expect(listLayerFilters(back).map((f) => f.name)).toEqual(['ACAD 필터', 'G']);
    });
  }

  const samples = ['samples-dxf/sample_AC1032_ascii.dxf', 'samples/sample_AC1032.dwg', 'samples/sample_AC1018.dwg', 'templates/acad3D.dwg'];
  for (const rel of samples) {
    const p = fixture(rel);
    it.skipIf(!p)(`표본 ${rel}: 필터를 더해도 ACLYDICTIONARY의 원래 확장 자료와 ACAD_LAYERSTATES는 그대로`, () => {
      const doc = readFixture(p!);
      const acly = layerTableDict(doc, 'ACLYDICTIONARY');
      const statesBefore = listLayerStates(doc, { hidden: true }).map((s) => s.key);
      const xdKeys = [...(layerTableXdict(doc)?.entries.keys() ?? [])];
      let n = 0x7f000;
      const w = new LayerFilterWriter(doc, () => (n++).toString(16).toUpperCase());
      const first = [...doc.layers.values()][0]!;
      w.put(prop('표본 필터', [{ NAME: '*' }]));
      w.put(group('표본 그룹', [first.name]));
      const ops = w.finish();
      // 원래 객체는 LAYER 확장 사전(필터 사전이 없을 때)과 ACLYDICTIONARY만 고친다
      const allowed = new Set([layerTableXdict(doc)?.handle, acly?.handle].filter(Boolean).map((h) => normalizeHandle(h!)));
      for (const o of ops) if (o.kind === 'object' && o.before) expect(allowed.has(normalizeHandle(o.before.handle))).toBe(true);
      for (const o of ops) {
        if (o.kind === 'object') {
          if (o.after) doc.objects.set(o.key, o.after);
        } else if (o.kind === 'tableHead' && o.after) doc.tableHeads!.set('LAYER', o.after);
      }
      for (const fmt of ['dxf', 'dwg'] as const) {
        const back = roundTrip(doc, fmt);
        const acly2 = layerTableDict(back, 'ACLYDICTIONARY')!;
        if (acly) expect(acly2.xdata).toEqual(acly.xdata);
        expect(listLayerStates(back, { hidden: true }).map((s) => s.key)).toEqual(statesBefore);
        const keys = [...layerTableXdict(back)!.entries.keys()];
        for (const k of xdKeys) expect(keys).toContain(k);
        expect(keys).not.toContain(FILTERS_KEY);
        const fs = listLayerFilters(back);
        expect(fs.map((f) => f.name).sort()).toEqual(['표본 그룹', '표본 필터']);
        expect(fs.find((f) => f.name === '표본 그룹')!.layers).toEqual([first.name]);
      }
    });
  }
});
