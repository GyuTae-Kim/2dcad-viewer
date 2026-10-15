/**
 * 도면층 필터 계산: 조건 해석(열마다), 한 행 AND·행끼리 OR, 와일드카드, 중첩, 그룹 필터, 기본 필터, 트리, 이름 규칙.
 */
import { describe, expect, it } from 'vitest';
import type { LayerFilter } from '../../src/edit/layerfilter/model';
import { canConvertToGroup, canNest, cleanRows, defaultFilterName, descendantsOf, filterNameProblem } from '../../src/edit/layerfilter/model';
import { FilterEvaluator, filterTree, matchContext, resolveFilterRef, rowsMatch, userRef, visibleLayerKeys } from '../../src/edit/layerfilter/match';
import { addLayer, add, line, newDoc } from '../layerstate/helpers';

function sample() {
  const t = newDoc();
  addLayer(t, 'A-WALL', { color: { aci: 1 }, linetype: 'DASHED', lineweight: 35 });
  addLayer(t, 'A-DOOR', { color: { aci: 3 }, off: true });
  addLayer(t, 'A-GLASS', { color: { aci: 150, rgb: 0x1192ee }, transparency: 128, plot: false });
  addLayer(t, 'M-PIPE1', { color: { aci: 1 }, frozen: true, description: '배관 1층' });
  addLayer(t, 'M-PIPE2', { color: { aci: 5 }, locked: true, flags: 2 });
  addLayer(t, 'E-LITE', { color: { aci: 2 } });
  add(t, line(0, 0, 1, 1, 'A-WALL'));
  add(t, line(0, 0, 1, 1, 'M-PIPE1'));
  return t;
}

const prop = (name: string, rows: LayerFilter['rows'], parent: string | null = null): LayerFilter => ({ name, kind: 'property', parent, rows, layers: [] });
const group = (name: string, layers: string[], parent: string | null = null): LayerFilter => ({ name, kind: 'group', parent, rows: [], layers });

function keysOf(t: ReturnType<typeof sample>, filters: LayerFilter[], name: string): string[] {
  return [...(new FilterEvaluator(t.doc, filters).layers(name) ?? [])].sort();
}

describe('조건 해석', () => {
  it('열마다의 조건', () => {
    const t = sample();
    const ctx = matchContext(t.doc);
    const L = (n: string) => t.doc.layers.get(n)!;
    const m = (row: Record<string, string>, n: string) => rowsMatch([row], L(n), ctx);
    // 이름 와일드카드
    expect(m({ NAME: 'A-*' }, 'A-WALL')).toBe(true);
    expect(m({ NAME: 'a-w*' }, 'A-WALL')).toBe(true);
    expect(m({ NAME: 'M-PIPE#' }, 'M-PIPE2')).toBe(true);
    expect(m({ NAME: 'M-PIPE?' }, 'M-PIPE1')).toBe(true);
    expect(m({ NAME: '~A-*' }, 'A-WALL')).toBe(false);
    expect(m({ NAME: '~A-*' }, 'E-LITE')).toBe(true);
    expect(m({ NAME: 'E-*,M-*' }, 'E-LITE')).toBe(true);
    expect(m({ NAME: '[AE]-*' }, 'M-PIPE1')).toBe(false);
    // 켜기·동결·잠금·플롯·새 VP 동결
    expect(m({ ON: 'OFF' }, 'A-DOOR')).toBe(true);
    expect(m({ ON: 'ON' }, 'A-DOOR')).toBe(false);
    expect(m({ FROZEN: 'FROZEN' }, 'M-PIPE1')).toBe(true);
    expect(m({ FROZEN: 'THAWED' }, 'M-PIPE1')).toBe(false);
    expect(m({ LOCKED: 'LOCKED' }, 'M-PIPE2')).toBe(true);
    expect(m({ PLOT: 'NOPLOT' }, 'A-GLASS')).toBe(true);
    expect(m({ PLOT: 'PLOT' }, 'A-GLASS')).toBe(false);
    expect(m({ NEWVPFROZEN: 'FROZEN' }, 'M-PIPE2')).toBe(true);
    expect(m({ NEWVPFROZEN: 'THAWED' }, 'M-PIPE2')).toBe(false);
    // 색상: 번호, 이름, 트루컬러, 와일드카드
    expect(m({ COLOR: '1' }, 'A-WALL')).toBe(true);
    expect(m({ COLOR: '빨간색' }, 'A-WALL')).toBe(true);
    expect(m({ COLOR: 'red' }, 'M-PIPE1')).toBe(true);
    expect(m({ COLOR: '17,146,238' }, 'A-GLASS')).toBe(true);
    expect(m({ COLOR: '150' }, 'A-GLASS')).toBe(false);
    expect(m({ COLOR: '[12]' }, 'E-LITE')).toBe(true);
    // 선종류·선가중치·투명도·설명·플롯 스타일
    expect(m({ LINETYPE: 'DASH*' }, 'A-WALL')).toBe(true);
    expect(m({ LINETYPE: 'Continuous' }, 'E-LITE')).toBe(true);
    expect(m({ LINEWEIGHT: '35' }, 'A-WALL')).toBe(true);
    expect(m({ LINEWEIGHT: '-3' }, 'E-LITE')).toBe(true);
    expect(m({ TRANSPARENCY: '50' }, 'A-GLASS')).toBe(true);
    expect(m({ TRANSPARENCY: '0' }, 'E-LITE')).toBe(true);
    expect(m({ DESCRIPTION: '배관*' }, 'M-PIPE1')).toBe(true);
    expect(m({ DESCRIPTION: '?*' }, 'E-LITE')).toBe(false);
    expect(m({ PLOTSTYLE: 'Color_1' }, 'A-WALL')).toBe(true);
    expect(m({ PLOTSTYLE: 'Color_#' }, 'E-LITE')).toBe(true);
    // 상태(사용 중 = 객체가 있음)
    expect(m({ STATUS: 'USED' }, 'A-WALL')).toBe(true);
    expect(m({ STATUS: 'UNUSED' }, 'A-WALL')).toBe(false);
    expect(m({ STATUS: 'UNUSED' }, 'E-LITE')).toBe(true);
    // 모르는 열은 따지지 않는다
    expect(m({ VPCOLOR: '3' }, 'E-LITE')).toBe(true);
  });

  it('한 행 안은 AND, 행끼리는 OR, 빈 행은 버린다', () => {
    const t = sample();
    // 이름이 A-로 시작하고 빨간색, 또는 잠긴 도면층
    const f = prop('F', [{ NAME: 'A-*', COLOR: '1' }, { LOCKED: 'LOCKED' }, { NAME: '  ' }]);
    expect(keysOf(t, [f], 'F')).toEqual(['A-WALL', 'M-PIPE2']);
    expect(cleanRows(f.rows).length).toBe(2);
    // 조건이 없으면 모든 도면층
    expect(keysOf(t, [prop('E', [{}])], 'E').length).toBe(t.doc.layers.size);
  });
});

describe('중첩·그룹 필터', () => {
  it('특성 필터 아래의 특성 필터는 부모 결과 안에서 고른다', () => {
    const t = sample();
    const filters = [prop('빨강', [{ COLOR: '1' }]), prop('빨간 배관', [{ NAME: 'M-*' }], '빨강'), prop('그 안 동결', [{ FROZEN: 'FROZEN' }], '빨간 배관')];
    expect(keysOf(t, filters, '빨강')).toEqual(['A-WALL', 'M-PIPE1']);
    expect(keysOf(t, filters, '빨간 배관')).toEqual(['M-PIPE1']);
    expect(keysOf(t, filters, '그 안 동결')).toEqual(['M-PIPE1']);
    expect(descendantsOf(filters, '빨강').map((f) => f.name)).toEqual(['빨간 배관', '그 안 동결']);
  });

  it('그룹 필터는 고른 도면층 + 자식 그룹, 그 안의 특성 필터는 그 안에서', () => {
    const t = sample();
    const filters = [group('설비', ['M-PIPE1', 'm-pipe2', '없는 도면층']), group('전기', ['E-LITE'], '설비'), prop('잠김', [{ LOCKED: 'LOCKED' }], '설비')];
    expect(keysOf(t, filters, '설비')).toEqual(['E-LITE', 'M-PIPE1', 'M-PIPE2']);
    expect(keysOf(t, filters, '전기')).toEqual(['E-LITE']);
    expect(keysOf(t, filters, '잠김')).toEqual(['M-PIPE2']);
  });

  it('순환하는 부모 자료도 멈추지 않는다', () => {
    const t = sample();
    const filters = [prop('X', [{ NAME: 'A*' }], 'Y'), prop('Y', [{ NAME: '*' }], 'X')];
    expect(() => keysOf(t, filters, 'X')).not.toThrow();
    const tree = filterTree(t.doc, filters);
    const names = JSON.stringify(tree);
    expect(names).toContain('"X"');
    expect(names).toContain('"Y"');
  });

  it('중첩 규칙과 그룹 필터로 바꾸기', () => {
    expect(canNest('property', 'property')).toBe(true);
    expect(canNest('property', 'group')).toBe(false);
    expect(canNest('group', 'group')).toBe(true);
    expect(canNest('group', 'property')).toBe(true);
    const filters = [prop('P', []), prop('PP', [], 'P'), group('G', []), prop('GP', [], 'G')];
    expect(canConvertToGroup(filters, filters[0]!)).toBe(true);
    expect(canConvertToGroup(filters, filters[1]!)).toBe(false);
    expect(canConvertToGroup(filters, filters[3]!)).toBe(true);
    expect(canConvertToGroup(filters, filters[2]!)).toBe(false);
  });
});

describe('기본 필터·트리·반전', () => {
  it('모두, 사용된 모든 도면층, 외부 참조(참조마다), 비외부 참조', () => {
    const t = sample();
    addLayer(t, 'SITE|ROAD', { flags: 16 | 32 });
    addLayer(t, 'SITE|TREE', { flags: 16 | 32 });
    addLayer(t, 'GRID|AXIS', { flags: 16 | 32 });
    const r = (ref: string) => [...(resolveFilterRef(t.doc, [], ref)?.keys ?? [])].sort();
    expect(r('ALL').length).toBe(t.doc.layers.size);
    expect(r('USED')).toEqual(['A-WALL', 'M-PIPE1']);
    expect(r('XREF')).toEqual(['GRID|AXIS', 'SITE|ROAD', 'SITE|TREE']);
    expect(r('XREF:site')).toEqual(['SITE|ROAD', 'SITE|TREE']);
    expect(r('NONXREF')).not.toContain('SITE|ROAD');
    expect(resolveFilterRef(t.doc, [], 'U:없음')).toBeNull();
    const tree = filterTree(t.doc, [prop('B', []), group('A', []), prop('A1', [], 'A')]);
    expect(tree.label).toBe('모두');
    expect(tree.children.map((c) => c.label)).toEqual(['모든 비외부 참조 도면층', '사용된 모든 도면층', '외부 참조', 'A', 'B']);
    expect(tree.children[2]!.children.map((c) => c.label)).toEqual(['GRID', 'SITE']);
    expect(tree.children[3]!.children.map((c) => c.ref)).toEqual([userRef('A1')]);
  });

  it('외부 참조가 없으면 외부 참조 노드도 없다. 반전은 결과 밖의 도면층', () => {
    const t = sample();
    expect(filterTree(t.doc, []).children.map((c) => c.label)).toEqual(['사용된 모든 도면층']);
    const used = resolveFilterRef(t.doc, [], 'USED')!.keys;
    const inv = visibleLayerKeys(t.doc, used, true);
    expect(inv.has('A-WALL')).toBe(false);
    expect(inv.size).toBe(t.doc.layers.size - 2);
  });
});

describe('이름', () => {
  it('비었거나, 쓸 수 없는 문자, 기본 필터 이름, 겹치는 이름', () => {
    expect(filterNameProblem('')).toContain('비어');
    expect(filterNameProblem('a*b')).toContain('문자는 쓸 수 없습니다');
    expect(filterNameProblem('모두')).toContain('기본 필터');
    expect(filterNameProblem('All Used Layers')).toContain('기본 필터');
    expect(filterNameProblem('벽', ['벽'])).toContain('이미 있습니다');
    expect(filterNameProblem('wall', ['WALL'])).toContain('이미 있습니다');
    expect(filterNameProblem('벽 필터', ['벽'])).toBeNull();
    expect(defaultFilterName('property', ['특성 필터1'])).toBe('특성 필터2');
    expect(defaultFilterName('group', [])).toBe('그룹 필터1');
  });
});
