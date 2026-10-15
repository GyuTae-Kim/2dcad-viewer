/**
 * 도면층 필터의 앱 쪽 흐름(가짜 App): 저장 검사(이름·중첩), 그룹 필터로 변환, 그룹 도면층 추가·대치·제거, 필터에 가시성·잠금·
 * 뷰포트 동결 적용, 여러 필터 삭제(남는 필터 옮기기), 도면층 지우기와 그룹 필터, 지금 고른 필터·반전·상태 줄, FILTERS 등록.
 */
import { describe, expect, it } from 'vitest';
import type { Layer, ViewportEntity } from '../../src/core/model';
import { PAPER_SPACE, tableKey } from '../../src/core/model';
import { registerLayerFilterCommands } from '../../src/app/layerfilter';
import { registerUtil2SelectCommands } from '../../src/app/util2-select';
import {
  applyFilterAction,
  convertToGroupFilter,
  currentFilterResult,
  deleteLayerFilter,
  deleteLayerFilters,
  editGroupLayers,
  filterStatusText,
  layersOfEntities,
  parentForNew,
  renameLayerFilter,
  saveLayerFilter,
  setFilterView,
} from '../../src/app/layerfilter-core';
import { deleteLayer } from '../../src/app/layers';
import { userRef } from '../../src/edit/layerfilter/match';
import { filterRecordTags } from '../../src/edit/layerfilter/record';
import { FILTERS_KEY, layerFiltersDict, listLayerFilters, listStoredFilters } from '../../src/edit/layerfilter/store';
import type { DictionaryObject, XRecordObject } from '../../src/core/model';
import type { EditOp } from '../../src/edit/session';
import { line, viewport } from '../layertools/helpers';
import { makeHarness } from '../cmds2/harness';

function layerOf(base: Layer, name: string, handle: string, p: Partial<Layer> = {}): Layer {
  return { ...structuredClone(base), name, handle, ...p };
}

function harness() {
  const h = makeHarness((doc) => {
    const zero = doc.layers.get('0')!;
    doc.layers.set('A-WALL', layerOf(zero, 'A-WALL', 'A0', { color: { aci: 1 } }));
    doc.layers.set('A-DOOR', layerOf(zero, 'A-DOOR', 'A1', { color: { aci: 2 } }));
    doc.layers.set('M-PIPE', layerOf(zero, 'M-PIPE', 'A2', { color: { aci: 1 } }));
    doc.layers.set('E-LITE', layerOf(zero, 'E-LITE', 'A3', { color: { aci: 3 } }));
    doc.blocks.set(PAPER_SPACE, { name: '*Paper_Space', handle: 'B0', recordHandle: 'B1', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] });
  });
  return h;
}

const names = (h: ReturnType<typeof harness>) => listLayerFilters(h.doc).map((f) => f.name).sort();

/** LAYER 표 확장 사전 아래에 사전 하나(name)와 XRECORD들을 넣는 작업(확장 사전이 없으면 만든다) */
function tableDictOps(h: ReturnType<typeof harness>, name: string, recs: [string, XRecordObject['data']][]): EditOp[] {
  const nh = () => h.st.session.newHandle();
  const ops: EditOp[] = [];
  const head0 = h.doc.tableHeads?.get('LAYER') ?? null;
  const xdBefore = head0?.xdict ? ((h.doc.objects.get(head0.xdict) as DictionaryObject | undefined) ?? null) : null;
  let xd: DictionaryObject;
  if (xdBefore) xd = { ...xdBefore, entries: new Map(xdBefore.entries) };
  else {
    const head = { ...(head0 ?? { handle: nh() }) };
    xd = { type: 'DICTIONARY', handle: nh(), owner: head.handle, entries: new Map(), hardOwner: true, cloning: 1 };
    head.xdict = xd.handle;
    ops.push({ kind: 'tableHead', key: 'LAYER', before: head0, after: head });
  }
  const d: DictionaryObject = { type: 'DICTIONARY', handle: nh(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1 };
  for (const [k, data] of recs) {
    const rh = nh();
    d.entries.set(k, rh);
    ops.push({ kind: 'object', key: rh, before: null, after: { type: 'XRECORD', handle: rh, owner: d.handle, reactors: [d.handle], cloning: 1, data } });
  }
  ops.push({ kind: 'object', key: d.handle, before: null, after: d });
  xd.entries.set(name, d.handle);
  ops.push({ kind: 'object', key: xd.handle, before: xdBefore, after: xd });
  return ops;
}

describe('저장 검사', () => {
  it('이름 겹침·기본 필터 이름·중첩 규칙·자기 아래로 옮기기', () => {
    const h = harness();
    expect(saveLayerFilter(h.app, { name: '건축', kind: 'property', parent: null, rows: [{ NAME: 'A-*' }], layers: [] })).toBeNull();
    expect(saveLayerFilter(h.app, { name: '건축', kind: 'group', parent: null, rows: [], layers: [] })).toContain('이미 있습니다');
    expect(saveLayerFilter(h.app, { name: '사용된 모든 도면층', kind: 'group', parent: null, rows: [], layers: [] })).toContain('기본 필터');
    expect(saveLayerFilter(h.app, { name: 'G', kind: 'group', parent: '건축', rows: [], layers: [] })).toContain('그룹 필터를 둘 수 없습니다');
    expect(saveLayerFilter(h.app, { name: '건축 안', kind: 'property', parent: '건축', rows: [{ COLOR: '1' }], layers: [] })).toBeNull();
    expect(saveLayerFilter(h.app, { name: '건축', kind: 'property', parent: '건축 안', rows: [], layers: [] }, '건축')).toContain('자기 아래');
    expect(saveLayerFilter(h.app, { name: 'X', kind: 'property', parent: '없음', rows: [], layers: [] })).toContain('찾을 수 없습니다');
    // 새 필터의 부모: 고른 사용자 필터에 둘 수 있으면 그 아래
    expect(parentForNew(h.app, 'property', userRef('건축'))).toBe('건축');
    expect(parentForNew(h.app, 'group', userRef('건축'))).toBeNull();
    expect(parentForNew(h.app, 'property', 'USED')).toBeNull();
    expect(names(h)).toEqual(['건축', '건축 안']);
  });

  it('이름 바꾸기는 지금 고른 필터를 따라가고, 삭제하면 모두로 돌아간다', () => {
    const h = harness();
    saveLayerFilter(h.app, { name: 'P', kind: 'property', parent: null, rows: [{ NAME: 'A*' }], layers: [] });
    setFilterView(h.st, { ref: userRef('P') });
    expect(renameLayerFilter(h.app, 'P', 'Q')).toBeNull();
    expect(currentFilterResult(h.st).ref).toBe(userRef('Q'));
    expect(currentFilterResult(h.st).label).toBe('Q');
    expect(deleteLayerFilter(h.app, 'Q')).toEqual(['Q']);
    expect(currentFilterResult(h.st).ref).toBe('ALL');
  });
});

describe('그룹 필터', () => {
  it('특성 필터를 그룹 필터로 변환(지금 맞는 도면층으로)', () => {
    const h = harness();
    saveLayerFilter(h.app, { name: '빨강', kind: 'property', parent: null, rows: [{ COLOR: '1' }], layers: [] });
    saveLayerFilter(h.app, { name: '빨강 안 A', kind: 'property', parent: '빨강', rows: [{ NAME: 'A*' }], layers: [] });
    expect(convertToGroupFilter(h.app, '빨강 안 A')).toContain('바꿀 수 없습니다');
    expect(convertToGroupFilter(h.app, '빨강')).toBeNull();
    const g = listLayerFilters(h.doc).find((f) => f.name === '빨강')!;
    expect(g.kind).toBe('group');
    expect(g.layers).toEqual(['A-WALL', 'M-PIPE']);
    // 색이 바뀌어도 그룹은 그대로
    const w = h.doc.layers.get('A-WALL')!;
    h.st.session.commit({ label: 'T', ops: [{ kind: 'layer', key: 'A-WALL', before: w, after: { ...w, color: { aci: 5 } } }] });
    setFilterView(h.st, { ref: userRef('빨강') });
    expect([...currentFilterResult(h.st).keys].sort()).toEqual(['A-WALL', 'M-PIPE']);
    // 자식 특성 필터는 그룹 아래에 남는다
    expect(listLayerFilters(h.doc).find((f) => f.name === '빨강 안 A')!.parent).toBe('빨강');
    expect([...currentFilterResult(h.st).visible].length).toBe(2);
  });

  it('도면층 추가·대치·제거, 도면에서 고른 객체의 도면층', () => {
    const h = harness();
    saveLayerFilter(h.app, { name: 'G', kind: 'group', parent: null, rows: [], layers: ['A-DOOR'] });
    expect(editGroupLayers(h.app, 'G', ['E-LITE', 'a-door', '없음'], 'add')).toBe(1);
    expect(listLayerFilters(h.doc)[0]!.layers.sort()).toEqual(['A-DOOR', 'E-LITE']);
    expect(editGroupLayers(h.app, 'G', ['A-DOOR'], 'remove')).toBe(1);
    expect(editGroupLayers(h.app, 'G', ['M-PIPE', 'A-WALL'], 'replace')).toBe(3);
    expect(listLayerFilters(h.doc)[0]!.layers.sort()).toEqual(['A-WALL', 'M-PIPE']);
    expect(editGroupLayers(h.app, 'G', ['M-PIPE'], 'add')).toBe(0);
    expect(editGroupLayers(h.app, '없음', ['M-PIPE'], 'add')).toBe(-1);
    const a = h.add(line(0, 0, 1, 1, 'E-LITE'));
    const b = h.add(line(0, 0, 2, 2, 'A-WALL'));
    expect(layersOfEntities(h.st, [a.handle, b.handle, a.handle]).sort()).toEqual(['A-WALL', 'E-LITE']);
    // 도면층을 지우면 그룹에서도 빠진다(명령 취소하면 돌아온다)
    expect(deleteLayer(h.app, 'M-PIPE')).toBe(true);
    expect(listLayerFilters(h.doc)[0]!.layers).toEqual(['A-WALL']);
    h.st.session.undo();
    expect(listLayerFilters(h.doc)[0]!.layers.sort()).toEqual(['A-WALL', 'M-PIPE']);
  });
});

describe('필터에 적용', () => {
  it('켜기·끄기·동결(현재 도면층 제외)·잠금', () => {
    const h = harness();
    h.doc.header.set('$CLAYER', 'A-WALL');
    saveLayerFilter(h.app, { name: 'A', kind: 'property', parent: null, rows: [{ NAME: 'A-*' }], layers: [] });
    const ref = userRef('A');
    expect(applyFilterAction(h.app, ref, 'off')).toBe(2);
    expect(h.doc.layers.get('A-DOOR')!.off).toBe(true);
    expect(h.doc.layers.get('M-PIPE')!.off).toBe(false);
    expect(applyFilterAction(h.app, ref, 'on')).toBe(2);
    expect(applyFilterAction(h.app, ref, 'freeze')).toBe(1);
    expect(h.doc.layers.get('A-WALL')!.frozen).toBe(false);
    expect(h.doc.layers.get('A-DOOR')!.frozen).toBe(true);
    expect(h.printed.some((t) => t.includes('동결할 수 없어'))).toBe(true);
    expect(applyFilterAction(h.app, 'USED', 'lock')).toBe(0);
    expect(applyFilterAction(h.app, ref, 'lock')).toBe(2);
    expect(applyFilterAction(h.app, ref, 'vpfreeze')).toBe(0);
    expect(h.printed).toContain('뷰포트 동결은 배치 탭에서만 쓸 수 있습니다.');
  });

  it('배치의 뷰포트 안에서 뷰포트 동결·동결 해제', () => {
    const h = harness();
    const vp = viewport(['E-LITE']) as ViewportEntity;
    vp.handle = h.st.session.newHandle();
    h.st.session.commit({ label: 'T', ops: [{ kind: 'add', block: PAPER_SPACE, entity: vp }] });
    h.st.msVp = { layout: PAPER_SPACE, handle: vp.handle };
    saveLayerFilter(h.app, { name: 'G', kind: 'group', parent: null, rows: [], layers: ['A-WALL', 'E-LITE'] });
    expect(applyFilterAction(h.app, userRef('G'), 'vpfreeze')).toBe(1);
    const cur = () => (h.doc.blocks.get(PAPER_SPACE)!.entities.find((e) => e.handle === vp.handle) as ViewportEntity).frozenLayers.map(tableKey).sort();
    expect(cur()).toEqual(['A-WALL', 'E-LITE']);
    expect(applyFilterAction(h.app, userRef('G'), 'vpthaw')).toBe(2);
    expect(cur()).toEqual([]);
  });
});

describe('FILTERS·상태 줄', () => {
  it('여러 필터 삭제: 남기는 필터는 가장 가까운 남는 부모 아래로', () => {
    const h = harness();
    saveLayerFilter(h.app, { name: 'G1', kind: 'group', parent: null, rows: [], layers: ['A-WALL'] });
    saveLayerFilter(h.app, { name: 'G2', kind: 'group', parent: 'G1', rows: [], layers: [] });
    saveLayerFilter(h.app, { name: 'G3', kind: 'group', parent: 'G2', rows: [], layers: [] });
    saveLayerFilter(h.app, { name: 'P', kind: 'property', parent: 'G3', rows: [], layers: [] });
    expect(deleteLayerFilters(h.app, ['G2', 'G3'])).toBe(2);
    expect(names(h)).toEqual(['G1', 'P']);
    expect(listLayerFilters(h.doc).find((f) => f.name === 'P')!.parent).toBe('G1');
    expect(deleteLayerFilters(h.app, ['G1'])).toBe(1);
    expect(listLayerFilters(h.doc).find((f) => f.name === 'P')!.parent).toBeNull();
    h.st.session.undo();
    h.st.session.undo();
    expect(names(h)).toEqual(['G1', 'G2', 'G3', 'P']);
  });

  it('상태 줄·반전·FILTERS 명령 이름', () => {
    const h = harness();
    h.add(line(0, 0, 1, 1, 'A-WALL'));
    setFilterView(h.st, { ref: 'USED' });
    const r = currentFilterResult(h.st);
    expect([...r.keys]).toEqual(['A-WALL']);
    expect(filterStatusText(r.label, r.total, r.visible.size)).toBe(`사용된 모든 도면층: ${h.doc.layers.size}개 도면층 중 1개 표시`);
    setFilterView(h.st, { invert: true });
    const r2 = currentFilterResult(h.st);
    expect(r2.visible.size).toBe(h.doc.layers.size - 1);
    expect(filterStatusText('모두', 5, 5)).toBe('모두: 5개 도면층 중 5개 표시');
    // FILTERS(도면층 필터 삭제)는 FILTER(객체 선택 필터, 별칭 FI)와 겹치지 않는다
    registerUtil2SelectCommands(h.app);
    const filter = h.app.commands.get('FILTER')!;
    registerLayerFilterCommands(h.app);
    expect(h.app.commands.get('FILTERS')!.title).toBe('도면층 필터 삭제');
    expect(h.app.commands.get('FILTER')).toBe(filter);
    expect(filter.aliases ?? []).not.toContain('FILTERS');
  });
});

describe('저장 형식(AutoCAD·이 앱 기록)', () => {
  it('AutoCAD 형식으로 쓸 수 없는 조건은 이 앱 기록, 읽기 전용 AutoCAD 필터는 이름만 바꾸고 식은 그대로', () => {
    const h = harness();
    expect(saveLayerFilter(h.app, { name: '투명', kind: 'property', parent: null, rows: [{ TRANSPARENCY: '0' }], layers: [] })).toBeNull();
    expect(saveLayerFilter(h.app, { name: '빨강', kind: 'property', parent: null, rows: [{ COLOR: '1' }], layers: [] })).toBeNull();
    const fmt = () => Object.fromEntries(listStoredFilters(h.doc).map((s) => [s.filter.name, s.format]));
    expect(fmt()).toEqual({ 빨강: 'acad', 투명: 'app' });
    // AutoCAD가 쓴 바꿀 수 없는 식을 빨강 아래에 둔 것처럼
    const red = listStoredFilters(h.doc).find((s) => s.filter.name === '빨강')!;
    const expr = 'VPOVERRIDES=="TRUE" AND NAME=="A*"';
    h.st.session.commit({ label: 'T', ops: (() => {
      const x = h.doc.objects.get(red.handle) as XRecordObject;
      const xh = h.st.session.newHandle();
      const nd = h.st.session.newHandle();
      const rh = h.st.session.newHandle();
      return [
        { kind: 'object', key: rh, before: null, after: { type: 'XRECORD', handle: rh, owner: nd, reactors: [nd], cloning: 1, data: [{ code: 1, value: 'AcLyLayerFilter' }, { code: 90, value: 1 }, { code: 300, value: 'VP' }, { code: 301, value: expr }] } },
        { kind: 'object', key: nd, before: null, after: { type: 'DICTIONARY', handle: nd, owner: xh, reactors: [xh], entries: new Map([['*A1', rh]]), hardOwner: false, cloning: 1 } },
        { kind: 'object', key: xh, before: null, after: { type: 'DICTIONARY', handle: xh, owner: x.handle, entries: new Map([['ACLYDICTIONARY', nd]]), hardOwner: true, cloning: 1 } },
        { kind: 'object', key: x.handle, before: x, after: { ...x, xdict: xh } },
      ] as EditOp[];
    })() });
    const vp = listLayerFilters(h.doc).find((f) => f.name === 'VP')!;
    expect(vp.expression).toBe(expr);
    expect(vp.parent).toBe('빨강');
    expect(renameLayerFilter(h.app, 'VP', 'VP2')).toBeNull();
    expect(listLayerFilters(h.doc).find((f) => f.name === 'VP2')!.expression).toBe(expr);
    // 부모를 AutoCAD에서 읽지 못하는 조건으로 바꿀 수 없다
    expect(saveLayerFilter(h.app, { name: '빨강', kind: 'property', parent: null, rows: [{ COLOR: '1', DESCRIPTION: '*' }], layers: [] }, '빨강')).toContain('VP2');
    // 지우면 식도 함께 지운다
    expect(deleteLayerFilter(h.app, 'VP2')).toEqual(['VP2']);
    expect(saveLayerFilter(h.app, { name: '빨강', kind: 'property', parent: null, rows: [{ COLOR: '1', DESCRIPTION: '*' }], layers: [] }, '빨강')).toBeNull();
    expect(fmt()).toEqual({ 빨강: 'app', 투명: 'app' });
  });

  it('확정 고리: 예전 이 앱 기록이 남은 도면은 다른 편집을 확정할 때 AutoCAD 형식으로 옮긴다', () => {
    const h = harness();
    registerLayerFilterCommands(h.app);
    const recs: [string, XRecordObject['data']][] = [
      ['P', filterRecordTags({ name: 'P', kind: 'property', parent: null, rows: [{ NAME: 'A-*' }], layers: [] }, null, { layer: () => null })],
      ['G', filterRecordTags({ name: 'G', kind: 'group', parent: null, rows: [], layers: ['A-WALL'] }, null, { layer: (n) => h.doc.layers.get(tableKey(n))?.handle })],
      ['T', filterRecordTags({ name: 'T', kind: 'property', parent: null, rows: [{ TRANSPARENCY: '10' }], layers: [] }, null, { layer: () => null })],
    ];
    h.st.session.commit({ label: 'OLD', ops: tableDictOps(h, FILTERS_KEY, recs) });
    expect(listStoredFilters(h.doc).map((s) => s.format)).toEqual(['app', 'app', 'app']);
    h.add(line(0, 0, 1, 1, 'A-WALL'));
    const st = listStoredFilters(h.doc);
    expect(Object.fromEntries(st.map((s) => [s.filter.name, s.format]))).toEqual({ P: 'acad', G: 'acad', T: 'app' });
    expect(st.find((s) => s.filter.name === 'G')!.filter.layers).toEqual(['A-WALL']);
    expect([...layerFiltersDict(h.doc)!.entries.keys()]).toEqual(['T']);
    // 남은 것은 옮길 수 없는 것뿐 — 다음 확정은 그대로
    const n = h.doc.objects.size;
    h.add(line(0, 0, 2, 2, 'A-WALL'));
    expect(h.doc.objects.size).toBe(n);
  });
});
