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
import { listLayerFilters } from '../../src/edit/layerfilter/store';
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
