/** 도면층 탐색(LAYWALK) 순수 함수와 COPYTOLAYER 도우미 */
import { describe, expect, it } from 'vitest';
import { moveCopyToLayer, targetLayerProblem } from '../../src/edit/layertools/copytolayer';
import { cannotPurgeLayer, filterLayerNames, layerObjectCounts, purgeLayersOps, unreferencedLayers, walkKeepPatches, walkVisibleKeys } from '../../src/edit/layertools/walk';
import { add, addBlock, addLayer, attdef, commit, insert, line, newDoc } from './helpers';

function drawing() {
  const t = newDoc();
  for (const n of ['A-WALL', 'A-DOOR', 'E-LITE', 'EMPTY', 'Defpoints']) addLayer(t, n);
  add(t, line(0, 0, 1, 0, 'A-WALL'));
  addBlock(t, 'B', [line(0, 0, 1, 1, 'E-LITE')]);
  const a = attdef('T', 'Standard', 'A-DOOR');
  add(t, insert('B', 0, 0, '0', [{ ...a, type: 'ATTRIB' }]));
  return t;
}

describe('도면층 탐색', () => {
  it('와일드카드 필터(쉼표, ~ 부정)', () => {
    const names = ['A-WALL', 'A-DOOR', 'E-LITE', 'EMPTY'];
    expect(filterLayerNames(names, 'A-*')).toEqual(['A-WALL', 'A-DOOR']);
    expect(filterLayerNames(names, 'a-w*,E-*')).toEqual(['A-WALL', 'E-LITE']);
    expect(filterLayerNames(names, '~A-*')).toEqual(['E-LITE', 'EMPTY']);
    expect(filterLayerNames(names, '')).toEqual(names);
  });

  it('객체 수는 블록 정의 안과 속성을 센다', () => {
    const c = layerObjectCounts(drawing().doc);
    expect(c.get('A-WALL')).toBe(1);
    expect(c.get('E-LITE')).toBe(1);
    expect(c.get('A-DOOR')).toBe(1);
    expect(c.get('EMPTY')).toBeUndefined();
  });

  it('참조되지 않은 도면층: 0·Defpoints·현재 도면층·객체가 있는 도면층은 빠진다', () => {
    const t = drawing();
    expect(unreferencedLayers(t.doc, '0')).toEqual(['EMPTY']);
    expect(unreferencedLayers(t.doc, 'EMPTY')).toEqual([]);
    expect(cannotPurgeLayer(t.doc, 'A-DOOR', '0')).toBe('객체가 있는 도면층은 소거할 수 없습니다.');
    expect(cannotPurgeLayer(t.doc, 'Defpoints', '0')).toBe('Defpoints 도면층은 소거할 수 없습니다.');
  });

  it('소거: 고른 것 가운데 지울 수 있는 것만', () => {
    const t = drawing();
    const r = purgeLayersOps(t.doc, ['EMPTY', 'A-WALL', '0', 'empty'], '0');
    expect(r.purged).toEqual(['EMPTY']);
    expect(r.refused.map((x) => x.name)).toEqual(['A-WALL', '0']);
    commit(t, r.ops);
    expect(t.doc.layers.has('EMPTY')).toBe(false);
  });

  it('보일 도면층과 "종료 시 복원" 끔의 패치', () => {
    const t = drawing();
    const vis = walkVisibleKeys(['a-wall'], ['E-LITE']);
    expect([...vis].sort()).toEqual(['A-WALL', 'E-LITE']);
    const L = t.doc.layers.get('E-LITE')!;
    commit(t, [{ kind: 'layer', key: 'E-LITE', before: L, after: { ...L, frozen: true } }]);
    const p = new Map(walkKeepPatches(t.doc, vis));
    expect(p.get('E-LITE')).toEqual({ off: false, frozen: false });
    expect(p.has('A-WALL')).toBe(false);
    expect(p.get('A-DOOR')).toEqual({ off: true });
    expect(p.get('0')).toEqual({ off: true });
  });
});

describe('COPYTOLAYER', () => {
  it('복사본과 같은 도면층에 있던 속성만 함께 옮긴다', () => {
    const a1 = { ...attdef('T1', 'Standard', 'X'), type: 'ATTRIB' as const };
    const a2 = { ...attdef('T2', 'Standard', 'OTHER'), type: 'ATTRIB' as const };
    const ins = insert('B', 0, 0, 'X', [a1, a2]);
    moveCopyToLayer(ins, 'NEW');
    expect(ins.layer).toBe('NEW');
    expect(ins.attribs.map((a) => a.layer)).toEqual(['NEW', 'OTHER']);
  });

  it('대상 도면층 이름 검사', () => {
    expect(targetLayerProblem('A-WALL')).toBeNull();
    expect(targetLayerProblem(' ')).toBe('도면층 이름이 비어 있습니다.');
    expect(targetLayerProblem('X|Y')).toBe('외부 참조 종속 도면층으로는 복사할 수 없습니다.');
    expect(targetLayerProblem('a*b')).not.toBeNull();
  });
});
