/** 도면층 변환기(LAYTRANS): 같은 이름 매핑, 객체 옮기기, ByLayer 강제, 블록, 원본 삭제, 이어지지 않는 매핑 */
import { describe, expect, it } from 'vitest';
import type { InsertEntity, ViewportEntity } from '../../src/core/model';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import { DEFAULT_TRANSLATE_SETTINGS, sameNameMappings, translateLayersOps, translateLog } from '../../src/edit/layertools/translate';
import { add, addBlock, addLayer, attdef, commit, insert, layer, line, newDoc, viewport } from './helpers';

function drawing() {
  const t = newDoc();
  addLayer(t, 'A-WALL', { color: { aci: 1 } });
  addLayer(t, 'old-text', { color: { aci: 2 } });
  addLayer(t, 'B');
  const l1 = add(t, { ...line(0, 0, 10, 0, 'A-WALL'), color: { aci: 5 }, linetype: 'Continuous', transparency: 0x02000040 });
  const l2 = add(t, line(0, 5, 10, 5, 'B'));
  addBlock(t, 'BLK', [line(0, 0, 1, 1, 'A-WALL'), attdef('TAG', 'Standard', 'old-text')]);
  const a = attdef('TAG', 'Standard', 'old-text');
  const ins = add(t, insert('BLK', 20, 0, '0', [{ ...a, type: 'ATTRIB' }]));
  return { t, l1, l2, ins };
}

const S = { ...DEFAULT_TRANSLATE_SETTINGS };

describe('도면층 변환 매핑', () => {
  it('이름이 같은 도면층끼리(대소문자 무시)', () => {
    const m = sameNameMappings(['A-WALL', 'Old-Text', 'X'], [layer('a-wall'), layer('OLD-TEXT'), layer('Y')]);
    expect(m.map((x) => `${x.from}>${x.to.name}`)).toEqual(['A-WALL>a-wall', 'Old-Text>OLD-TEXT']);
  });
});

describe('변환', () => {
  it('객체·속성·블록 안 객체를 옮기고 대상 도면층을 만들고 원본 도면층을 지운다', () => {
    const { t, l1, ins } = drawing();
    const r = translateLayersOps(t.doc, [{ from: 'A-WALL', to: layer('S-WALL', { color: { aci: 4 }, lineweight: 50 }) }, { from: 'OLD-TEXT', to: layer('S-TEXT', { color: { aci: 3 } }) }], S, t.nh);
    commit(t, r.ops);
    expect(r.created.sort()).toEqual(['S-TEXT', 'S-WALL']);
    expect(r.removed.sort()).toEqual(['A-WALL', 'old-text']);
    expect(t.doc.layers.get('S-WALL')!.color.aci).toBe(4);
    expect(t.doc.layers.get('S-WALL')!.lineweight).toBe(50);
    expect(t.doc.layers.has('A-WALL')).toBe(false);
    const moved = t.doc.entityIndex.get(l1.handle)!;
    expect(moved.layer).toBe('S-WALL');
    // 색상·선종류는 ByLayer로 강제, 투명도는 기본 설정에서 그대로
    expect(moved.color.aci).toBe(256);
    expect(moved.linetype).toBe('ByLayer');
    expect(moved.transparency).toBe(0x02000040);
    const i2 = t.doc.entityIndex.get(ins.handle) as InsertEntity;
    expect(i2.layer).toBe('0');
    expect(i2.attribs[0]!.layer).toBe('S-TEXT');
    const blk = t.doc.blocks.get('BLK')!;
    expect(blk.entities.map((e) => e.layer)).toEqual(['S-WALL', 'S-TEXT']);
    expect(r.moved).toBe(3);
    expect(r.counts.get('A-WALL')).toBe(2);
  });

  it('블록의 객체 변환을 끄면 블록 안 객체가 남아 원본 도면층을 지우지 않는다', () => {
    const { t } = drawing();
    const r = translateLayersOps(t.doc, [{ from: 'A-WALL', to: layer('S-WALL') }], { ...S, blocks: false }, t.nh);
    commit(t, r.ops);
    expect(t.doc.blocks.get('BLK')!.entities[0]!.layer).toBe('A-WALL');
    expect(r.kept).toEqual(['A-WALL']);
    expect(t.doc.layers.has('A-WALL')).toBe(true);
  });

  it('있는 대상 도면층은 특성을 대상 정의로 바꾸고, 매핑은 이어지지 않는다(A→B, B→C)', () => {
    const { t, l1, l2 } = drawing();
    addLayer(t, 'C');
    const r = translateLayersOps(t.doc, [{ from: 'A-WALL', to: layer('B', { color: { aci: 6 } }) }, { from: 'B', to: layer('C', { color: { aci: 2 }, plot: false }) }], { ...S, forceColor: false }, t.nh);
    commit(t, r.ops);
    expect(t.doc.entityIndex.get(l1.handle)!.layer).toBe('B');
    expect(t.doc.entityIndex.get(l1.handle)!.color.aci).toBe(5);
    expect(t.doc.entityIndex.get(l2.handle)!.layer).toBe('C');
    expect(t.doc.layers.get('B')!.color.aci).toBe(6);
    expect(t.doc.layers.get('C')!.plot).toBe(false);
    expect(r.updated.sort()).toEqual(['B', 'C']);
    // B는 대상이라 지우지 않는다
    expect(t.doc.layers.has('B')).toBe(true);
    expect(r.removed).toEqual(['A-WALL']);
  });

  it('현재 도면층과 뷰포트 동결 목록이 따라가고, 투명도 강제', () => {
    const { t, l1 } = drawing();
    commit(t, [{ kind: 'header', name: '$CLAYER', before: t.doc.header.get('$CLAYER'), after: 'A-WALL' }]);
    const lay = t.doc.layouts.find((l) => tableKey(l.blockName) !== MODEL_SPACE)!;
    const vp = add(t, viewport(['A-WALL', 'S-WALL']), lay.blockName);
    const r = translateLayersOps(t.doc, [{ from: 'A-WALL', to: layer('S-WALL') }], { ...S, forceTransparency: true }, t.nh);
    commit(t, r.ops);
    expect(t.doc.header.get('$CLAYER')).toBe('S-WALL');
    expect((t.doc.entityIndex.get(vp.handle) as ViewportEntity).frozenLayers).toEqual(['S-WALL']);
    expect(t.doc.entityIndex.get(l1.handle)!.transparency).toBe(-1);
  });

  it('0·Defpoints·외부 참조 도면층은 지우지 않거나 변환하지 않는다', () => {
    const t = newDoc();
    addLayer(t, 'X|REF');
    add(t, line(0, 0, 1, 0, '0'));
    const r = translateLayersOps(t.doc, [{ from: '0', to: layer('S-0') }, { from: 'X|REF', to: layer('S-X') }], S, t.nh);
    commit(t, r.ops);
    expect(r.removed).toEqual([]);
    expect(t.doc.layers.has('0')).toBe(true);
    expect(r.created).toEqual(['S-0']);
  });

  it('변환 로그', () => {
    const { t } = drawing();
    const m = [{ from: 'A-WALL', to: layer('S-WALL') }];
    const r = translateLayersOps(t.doc, m, S, t.nh);
    const log = translateLog('a.dwg', m, S, r, new Date(0));
    expect(log).toContain('A-WALL → S-WALL: 객체 2개');
    expect(log).toContain('삭제한 도면층: A-WALL');
    expect(log.endsWith('\r\n')).toBe(true);
  });
});
