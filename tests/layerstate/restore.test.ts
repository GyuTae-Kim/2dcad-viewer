/** 도면층 상태 복원 계획: 마스크, 상태에 없는 도면층 끄기, 현재 도면층, 현재 뷰포트 VP 동결, 없는 선종류, 뷰포트 재지정 */
import { describe, expect, it } from 'vitest';
import type { Layer } from '../../src/core/model';
import { LSF_VPFROZEN, LSM_ALL, LSM_COLOR, LSM_CURVP, LSM_FROZEN, LSM_ON } from '../../src/edit/layerstate/record';
import { captureLayerState, planRestore, stateMatches } from '../../src/edit/layerstate/store';
import { addLayer, addLinetype, commit, newDoc } from './helpers';

function setup() {
  const t = newDoc();
  addLinetype(t, 'DASHED');
  addLayer(t, 'A', { color: { aci: 1 }, linetype: 'DASHED' });
  addLayer(t, 'B', { color: { aci: 2 } });
  return t;
}

function patch(t: ReturnType<typeof setup>, name: string, p: Partial<Layer>) {
  const before = t.doc.layers.get(name)!;
  commit(t, [{ kind: 'layer', key: name, before, after: { ...before, ...p } }]);
}

function apply(t: ReturnType<typeof setup>, plan: ReturnType<typeof planRestore>) {
  for (const [k, p] of plan.patches) patch(t, k, p);
  if (plan.currentLayer) commit(t, [{ kind: 'header', name: '$CLAYER', before: t.doc.header.get('$CLAYER'), after: plan.currentLayer }]);
}

describe('복원 계획', () => {
  it('저장한 뒤 바꾼 값을 되돌리고, 같아지면 "동일"', () => {
    const t = setup();
    const s = captureLayerState(t.doc, { name: 'S' });
    expect(stateMatches(t.doc, s)).toBe(true);
    patch(t, 'A', { off: true, color: { aci: 5 }, linetype: 'Continuous', lineweight: 50, transparency: 100, locked: true });
    patch(t, 'B', { frozen: true, plot: false, flags: 3 });
    expect(stateMatches(t.doc, s)).toBe(false);
    const plan = planRestore(t.doc, s, { mask: LSM_ALL });
    apply(t, plan);
    const A = t.doc.layers.get('A')!;
    expect([A.off, A.color.aci, A.linetype, A.lineweight, A.transparency, A.locked]).toEqual([false, 1, 'DASHED', -3, 255, false]);
    const B = t.doc.layers.get('B')!;
    expect([B.frozen, B.plot, B.flags & 2]).toEqual([false, true, 0]);
    expect(stateMatches(t.doc, s)).toBe(true);
  });

  it('마스크에 없는 특성은 그대로', () => {
    const t = setup();
    const s = captureLayerState(t.doc, { name: 'S', mask: LSM_ON });
    patch(t, 'A', { off: true, color: { aci: 5 } });
    apply(t, planRestore(t.doc, s, { mask: s.mask }));
    expect(t.doc.layers.get('A')!.off).toBe(false);
    expect(t.doc.layers.get('A')!.color.aci).toBe(5);
    expect(stateMatches(t.doc, s)).toBe(true);
  });

  it('상태에서 찾을 수 없는 도면층 끄기', () => {
    const t = setup();
    const s = captureLayerState(t.doc, { name: 'S' });
    addLayer(t, 'NEW');
    const plan = planRestore(t.doc, s, { mask: LSM_ALL, offMissing: true });
    expect(plan.patches.get('NEW')).toEqual({ off: true });
    expect(planRestore(t.doc, s, { mask: LSM_ALL }).patches.has('NEW')).toBe(false);
  });

  it('현재 도면층을 저장한 것으로 바꾸고, 현재 도면층은 동결하지 않는다', () => {
    const t = setup();
    commit(t, [{ kind: 'header', name: '$CLAYER', before: t.doc.header.get('$CLAYER'), after: 'A' }]);
    const s = captureLayerState(t.doc, { name: 'S' });
    expect(s.currentLayer).toBe('A');
    commit(t, [{ kind: 'header', name: '$CLAYER', before: 'A', after: 'B' }]);
    expect(planRestore(t.doc, s, { mask: LSM_ALL }).currentLayer).toBe('A');
    // 상태가 지금 현재 도면층(B)을 동결로 저장했고 상태의 현재 도면층(A)도 동결이면: 현재 도면층을 바꾸지 않고 B는 동결하지 않는다
    const s2 = structuredClone(s);
    for (const l of s2.layers) if (l.name === 'A' || l.name === 'B') l.flags |= 2;
    const p2 = planRestore(t.doc, s2, { mask: LSM_FROZEN });
    expect(p2.currentLayer).toBeUndefined();
    expect(p2.keptCurrent).toBe('B');
    expect(p2.patches.get('A')).toEqual({ frozen: true });
    expect(p2.patches.has('B')).toBe(false);
  });

  it('배치 상태의 현재 VP 가시성(플래그 32)을 현재 뷰포트 동결 목록으로', () => {
    const t = setup();
    const s = captureLayerState(t.doc, { name: 'S', paperSpace: true, vpFrozen: new Set(['A']) });
    expect(s.layers.find((l) => l.name === 'A')!.flags & LSF_VPFROZEN).toBe(LSF_VPFROZEN);
    const p = planRestore(t.doc, s, { mask: LSM_ALL, viewportFrozen: ['B'] });
    expect(p.viewportFrozen).toEqual(['A']);
    // 마스크에 현재 VP가 없거나 모형 상태면 그대로
    expect(planRestore(t.doc, s, { mask: LSM_ALL & ~LSM_CURVP, viewportFrozen: ['B'] }).viewportFrozen).toBeUndefined();
    expect(planRestore(t.doc, { ...s, paperSpace: false }, { mask: LSM_ALL, viewportFrozen: ['B'] }).viewportFrozen).toBeUndefined();
    expect(stateMatches(t.doc, s, ['A'])).toBe(true);
  });

  it('없는 선종류는 알리고, 뷰포트 재지정이면 색 등은 건너뛴다', () => {
    const t = setup();
    const s = captureLayerState(t.doc, { name: 'S' });
    s.layers.find((l) => l.name === 'B')!.linetype = 'NOPE';
    s.layers.find((l) => l.name === 'B')!.color = { aci: 9 };
    const p = planRestore(t.doc, s, { mask: LSM_ALL });
    expect(p.missingLinetypes).toEqual(['NOPE']);
    expect(p.patches.get('B')).toEqual({ color: { aci: 9 } });
    const q = planRestore(t.doc, s, { mask: LSM_ALL, asOverrides: true });
    expect(q.skippedOverrides).toBe(true);
    expect(q.patches.has('B')).toBe(false);
    expect(planRestore(t.doc, s, { mask: LSM_ON, asOverrides: true }).skippedOverrides).toBe(false);
    expect(planRestore(t.doc, s, { mask: LSM_COLOR }).patches.get('B')).toEqual({ color: { aci: 9 } });
  });
});
