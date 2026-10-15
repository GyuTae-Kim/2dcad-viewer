/**
 * 도면층 필터 저장: LAYER 표 확장 사전 → OPENCAD_LAYERFILTERS → XRECORD 쓰기·고치기·지우기, DXF·DWG 왕복,
 * AutoCAD 필터 원본(ACLYDICTIONARY·ACAD_LAYERFILTERS)과 도면층 상태 보존.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, DictionaryObject, XRecordObject } from '../../src/core/model';
import { normalizeHandle, tableKey } from '../../src/core/model';
import { FilterEvaluator } from '../../src/edit/layerfilter/match';
import type { LayerFilter } from '../../src/edit/layerfilter/model';
import { FILTER_MARK, filterRecordTags, parseFilterTags } from '../../src/edit/layerfilter/record';
import { FILTERS_KEY, LayerFilterWriter, autocadFilterEntries, dropLayerFromFiltersOps, layerFiltersDict, listLayerFilters, listStoredFilters } from '../../src/edit/layerfilter/store';
import { LayerStateWriter, captureLayerState, layerTableDict, layerTableXdict, listLayerStates } from '../../src/edit/layerstate/store';
import { type TestDoc, addLayer, commit, duplicateHandles, fixture, newDoc, readFixture, roundTrip } from '../layerstate/helpers';

const prop = (name: string, rows: LayerFilter['rows'], parent: string | null = null): LayerFilter => ({ name, kind: 'property', parent, rows, layers: [] });
const group = (name: string, layers: string[], parent: string | null = null): LayerFilter => ({ name, kind: 'group', parent, rows: [], layers });

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

describe('레코드', () => {
  it('태그 ↔ 필터(모르는 태그와 열은 그대로)', () => {
    const f = prop('F', [{ NAME: 'A*', COLOR: '1', VPCOLOR: '2' }, { ON: 'OFF' }]);
    const tags = filterRecordTags(f, '1F', { layer: () => null }, [{ code: 1071, value: 7 }]);
    expect(tags.slice(0, 5)).toEqual([
      { code: 1, value: FILTER_MARK },
      { code: 70, value: 1 },
      { code: 90, value: 1 },
      { code: 300, value: 'F' },
      { code: 340, value: '1F' },
    ]);
    // 열은 AutoCAD 대화상자 순서, 모르는 열은 뒤
    expect(tags.slice(5, 12).map((t) => t.value)).toEqual([0, 'NAME', 'A*', 'COLOR', '1', 'VPCOLOR', '2']);
    const back = parseFilterTags(tags, 'x', { layer: () => null })!;
    expect(back.parentHandle).toBe('1F');
    expect(back.filter.rows).toEqual(f.rows);
    expect(back.extra).toEqual([{ code: 1071, value: 7 }]);
    expect(parseFilterTags([{ code: 1, value: 'AcLyLayerFilter' }], 'x', { layer: () => null })).toBeNull();
  });

  it('그룹 필터는 도면층 핸들(330), 핸들이 없으면 이름(8), 도면에 없는 도면층은 뺀다', () => {
    const tags = filterRecordTags(group('G', ['A', 'B', 'a', 'C']), null, { layer: (n) => (n.toUpperCase() === 'A' ? '2A' : n === 'B' ? null : undefined) });
    expect(tags.filter((t) => t.code === 330 || t.code === 8)).toEqual([
      { code: 330, value: '2A' },
      { code: 8, value: 'B' },
    ]);
    const back = parseFilterTags(tags, 'G', { layer: (h) => (h === '2A' ? 'A' : null) })!;
    expect(back.filter.layers).toEqual(['A', 'B']);
  });
});

describe('쓰기·고치기·지우기', () => {
  it('확장 사전·필터 사전을 만들고, 부모는 핸들로 잇는다', () => {
    const t = build();
    const d = layerFiltersDict(t.doc)!;
    expect(d).not.toBeNull();
    expect(layerTableXdict(t.doc)!.entries.has(FILTERS_KEY)).toBe(true);
    expect([...d.entries.keys()]).toEqual(['건축', '건축 빨강', '내 그룹', '하위 그룹', '그룹 안 잠김']);
    const child = t.doc.objects.get(normalizeHandle(d.entries.get('건축 빨강')!)) as XRecordObject;
    expect(child.data.find((x) => x.code === 340)?.value).toBe(normalizeHandle(d.entries.get('건축')!));
    expect(child.owner).toBe(d.handle);
    const fs = listLayerFilters(t.doc);
    expect(fs.find((f) => f.name === '하위 그룹')!.parent).toBe('내 그룹');
    expect(fs.find((f) => f.name === '내 그룹')!.layers.sort()).toEqual(['A-DOOR', '설비-배관']);
    expect(duplicateHandles(t.doc)).toEqual([]);
  });

  it('이름 바꾸기는 자식을 그대로 두고, 삭제는 아래 필터까지 지운다. 명령 취소로 되돌린다', () => {
    const t = build();
    const w = new LayerFilterWriter(t.doc, t.nh);
    expect(w.rename('건축', '건축물')).toBe(true);
    expect(w.rename('건축물', '내 그룹')).toBe(false);
    commit(t, w.finish());
    const fs = listLayerFilters(t.doc);
    expect(fs.find((f) => f.name === '건축 빨강')!.parent).toBe('건축물');
    expect([...layerFiltersDict(t.doc)!.entries.keys()][0]).toBe('건축물');
    const w2 = new LayerFilterWriter(t.doc, t.nh);
    expect(w2.remove('내 그룹').sort()).toEqual(['그룹 안 잠김', '내 그룹', '하위 그룹']);
    commit(t, w2.finish());
    expect(listLayerFilters(t.doc).map((f) => f.name)).toEqual(['건축물', '건축 빨강']);
    t.session.undo();
    expect(listLayerFilters(t.doc).length).toBe(5);
    t.session.undo();
    expect(listLayerFilters(t.doc).map((f) => f.name)).toContain('건축');
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
      const back = roundTrip(t.doc, fmt, ver);
      sameFilters(t.doc, back);
      expect(listLayerFilters(back).find((f) => f.name === '하위 그룹')!.parent).toBe('내 그룹');
      // 다시 고치고 한 번 더
      const nh = (() => {
        let n = 0x7000;
        return () => (n++).toString(16).toUpperCase();
      })();
      const w = new LayerFilterWriter(back, nh);
      w.put({ ...listLayerFilters(back).find((f) => f.name === '건축')!, rows: [{ NAME: 'A-D*' }] }, '건축');
      const ops = w.finish();
      expect(ops.every((o) => o.kind === 'object')).toBe(true);
      for (const o of ops) if (o.kind === 'object' && o.after) back.objects.set(o.key, o.after);
      const again = roundTrip(back, fmt, ver);
      expect(listLayerFilters(again).find((f) => f.name === '건축')!.rows).toEqual([{ NAME: 'A-D*' }]);
    });
  }
});

/** AutoCAD 필터 원본을 흉내 낸 사전·레코드(형식은 모른다 — 태그를 그대로 두는지만 본다) */
function addFakeAcadFilters(t: TestDoc): { dict: string; rec: string } {
  // 상태 하나를 저장해 LAYER 표 확장 사전을 만든다
  const sw = new LayerStateWriter(t.doc, t.nh);
  sw.put(captureLayerState(t.doc, { name: '평면' }));
  commit(t, sw.finish());
  const xd = layerTableXdict(t.doc)!;
  const dict: DictionaryObject = { type: 'DICTIONARY', handle: t.nh(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1, xdata: [{ app: 'ACAD', items: [{ code: 1000, value: '<All' }] }] };
  const rec: XRecordObject = {
    type: 'XRECORD',
    handle: t.nh(),
    owner: dict.handle,
    reactors: [dict.handle],
    cloning: 1,
    data: [
      { code: 1, value: 'AcLyLayerFilter' },
      { code: 90, value: 1 },
      { code: 300, value: 'ACAD 필터' },
      { code: 301, value: 'NAME=="A*"' },
    ],
  };
  dict.entries.set('*A1', rec.handle);
  commit(t, [
    { kind: 'object', key: dict.handle, before: null, after: dict },
    { kind: 'object', key: rec.handle, before: null, after: rec },
    { kind: 'object', key: xd.handle, before: xd, after: { ...xd, entries: new Map([...xd.entries, ['ACLYDICTIONARY', dict.handle]]) } },
  ]);
  return { dict: dict.handle, rec: rec.handle };
}

describe('원본 보존', () => {
  for (const fmt of ['dxf', 'dwg'] as const) {
    it(`AutoCAD 필터 사전과 도면층 상태는 그대로(${fmt})`, () => {
      const t = newDoc();
      addLayer(t, 'A');
      const fake = addFakeAcadFilters(t);
      const w = new LayerFilterWriter(t.doc, t.nh);
      w.put(group('G', ['A']));
      commit(t, w.finish());
      const back = roundTrip(t.doc, fmt);
      const acly = layerTableDict(back, 'ACLYDICTIONARY')!;
      expect(acly.xdata?.[0]?.items[0]?.value).toBe('<All');
      const rec = back.objects.get(normalizeHandle(acly.entries.get('*A1')!)) as XRecordObject;
      // DXF 리더는 숫자 값을 글로 둘 수 있다 — 값 글로 비교
      expect(rec.data.map((x) => [x.code, String(x.value).trim()])).toEqual([
        [1, 'AcLyLayerFilter'],
        [90, '1'],
        [300, 'ACAD 필터'],
        [301, 'NAME=="A*"'],
      ]);
      expect(autocadFilterEntries(back)).toEqual([{ dict: 'ACLYDICTIONARY', count: 1 }]);
      expect(listLayerStates(back).map((s) => s.key)).toEqual(['평면']);
      expect(listLayerFilters(back).map((f) => f.name)).toEqual(['G']);
      expect(fake.rec).toBeTruthy();
    });
  }

  const samples = ['samples-dxf/sample_AC1032_ascii.dxf', 'samples/sample_AC1032.dwg', 'samples/sample_AC1018.dwg', 'templates/acad3D.dwg'];
  for (const rel of samples) {
    const p = fixture(rel);
    it.skipIf(!p)(`표본 ${rel}: 필터를 더해도 ACLYDICTIONARY·ACAD_LAYERSTATES는 그대로`, () => {
      const doc = readFixture(p!);
      const accBefore = autocadFilterEntries(doc);
      const acly = layerTableDict(doc, 'ACLYDICTIONARY');
      const statesBefore = listLayerStates(doc, { hidden: true }).map((s) => s.key);
      const xdKeys = [...(layerTableXdict(doc)?.entries.keys() ?? [])];
      let n = 0x7f000;
      const w = new LayerFilterWriter(doc, () => (n++).toString(16).toUpperCase());
      const first = [...doc.layers.values()][0]!;
      w.put(prop('표본 필터', [{ NAME: '*' }]));
      w.put(group('표본 그룹', [first.name]));
      const ops = w.finish();
      // 원래 확장 사전 외에는 아무 원본 객체도 고치지 않는다
      for (const o of ops) if (o.kind === 'object' && o.before) expect(o.before.handle).toBe(layerTableXdict(doc)!.handle);
      for (const o of ops) {
        if (o.kind === 'object') {
          if (o.after) doc.objects.set(o.key, o.after);
        } else if (o.kind === 'tableHead' && o.after) doc.tableHeads!.set('LAYER', o.after);
      }
      for (const fmt of ['dxf', 'dwg'] as const) {
        const back = roundTrip(doc, fmt);
        expect(autocadFilterEntries(back)).toEqual(accBefore);
        const acly2 = layerTableDict(back, 'ACLYDICTIONARY');
        expect(!!acly2).toBe(!!acly);
        if (acly) expect(acly2!.xdata).toEqual(acly.xdata);
        expect(listLayerStates(back, { hidden: true }).map((s) => s.key)).toEqual(statesBefore);
        expect([...layerTableXdict(back)!.entries.keys()]).toEqual([...xdKeys, FILTERS_KEY]);
        const fs = listLayerFilters(back);
        expect(fs.map((f) => f.name).sort()).toEqual(['표본 그룹', '표본 필터']);
        expect(fs.find((f) => f.name === '표본 그룹')!.layers).toEqual([first.name]);
      }
    });
  }
});
