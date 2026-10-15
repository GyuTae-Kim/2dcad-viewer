/** CONVERTPSTYLES·PLOTSTYLE: 색상 종속 ↔ 이름 있는 플롯 스타일 도면, 객체의 플롯 스타일 지정 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, Entity, Layer, LineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { assignPlotStyleOps, colorPlotStyleName, convertToColorOps, convertToNamedOps, isNamedPlotStyleDoc, plotStyleNameList, plotStyleNameOf } from '../../src/edit/filecmds/pstyles';
import { applyOps } from '../../src/edit/session';

function setup(): { doc: CadDocument; nh: () => string; red: LineEntity; byLayer: LineEntity; tc: LineEntity } {
  const doc = createNewDocument('metric');
  let n = 0x900;
  const nh = () => (n++).toString(16).toUpperCase();
  const layer: Layer = { name: 'WALL', handle: nh(), flags: 0, color: { aci: 3 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
  applyOps(doc, [{ kind: 'layer', key: 'WALL', before: null, after: layer }]);
  const line = (over: Partial<LineEntity>): LineEntity => ({ ...entityDefaults(), handle: nh(), type: 'LINE', start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }, ...over });
  const red = line({ color: { aci: 1 }, layer: 'WALL' });
  const byLayer = line({ layer: 'WALL' });
  const tc = line({ color: { aci: 256, rgb: 0x0000fe } });
  applyOps(
    doc,
    [red, byLayer, tc].map((entity) => ({ kind: 'add' as const, block: MODEL_SPACE, entity })),
  );
  return { doc, nh, red, byLayer, tc };
}

const ent = (doc: CadDocument, h: string) => doc.entityIndex.get(h) as Entity;

describe('CONVERTPSTYLES', () => {
  it('색 → 플롯 스타일 이름(트루컬러는 가까운 ACI)', () => {
    expect(colorPlotStyleName(1)).toBe('Color_1');
    expect(colorPlotStyleName(256, 0xff0000)).toBe('Color_1');
    expect(colorPlotStyleName(0)).toBe('Color_7');
  });

  it('색상 종속 → 이름 있는: 도면층·색 지정 객체에 Color_n, ByLayer 색 객체는 ByLayer, 배치에 STB', () => {
    const { doc, nh, red, byLayer, tc } = setup();
    expect(isNamedPlotStyleDoc(doc)).toBe(false);
    const r = convertToNamedOps(doc, nh, 'test.stb')!;
    applyOps(doc, r.ops);
    expect(isNamedPlotStyleDoc(doc)).toBe(true);
    expect(plotStyleNameList(doc)).toEqual(expect.arrayContaining(['Normal', 'Color_1', 'Color_3', 'Color_5', 'Color_7']));
    expect(plotStyleNameOf(doc, doc.layers.get('WALL')!.plotStyle)).toBe('Color_3');
    expect(plotStyleNameOf(doc, doc.layers.get('0')!.plotStyle)).toBe('Color_7');
    expect(plotStyleNameOf(doc, ent(doc, red.handle).plotStyle)).toBe('Color_1');
    expect(ent(doc, byLayer.handle).plotStyle).toBeUndefined();
    expect(plotStyleNameOf(doc, ent(doc, tc.handle).plotStyle)).toBe('Color_5');
    expect(r.entities).toBe(2);
    for (const l of doc.layouts) expect(l.plot.styleSheet).toBe('test.stb');
    // 새 이름은 ACDBPLACEHOLDER 객체
    const h = [...doc.objects.values()].find((o) => o.type === 'ACDBPLACEHOLDER' && plotStyleNameOf(doc, o.handle) === 'Color_1');
    expect(h).toBeTruthy();
  });

  it('이름 있는 → 색상 종속: 이름을 지우고 사전에는 Normal만, .stb는 .ctb로', () => {
    const { doc, nh, red } = setup();
    applyOps(doc, convertToNamedOps(doc, nh)!.ops);
    for (const l of doc.layouts) applyOps(doc, [{ kind: 'layout', key: tableKey(l.blockName), before: l, after: { ...l, plot: { ...l.plot, styleSheet: 'my.stb' } } }]);
    const r = convertToColorOps(doc);
    applyOps(doc, r.ops);
    expect(isNamedPlotStyleDoc(doc)).toBe(false);
    expect(plotStyleNameList(doc)).toEqual(['Normal']);
    expect(ent(doc, red.handle).plotStyle).toBeUndefined();
    expect(plotStyleNameOf(doc, doc.layers.get('WALL')!.plotStyle)).toBe('Normal');
    for (const l of doc.layouts) expect(l.plot.styleSheet).toBe('my.ctb');
    expect([...doc.objects.values()].filter((o) => o.type === 'ACDBPLACEHOLDER')).toHaveLength(1);
  });

  it('PLOTSTYLE: 이름을 지정하면(없으면 사전에 더하고) ByLayer로 되돌릴 수 있다', () => {
    const { doc, nh, red, byLayer } = setup();
    const owner = () => MODEL_SPACE;
    const r = assignPlotStyleOps(doc, [red.handle, byLayer.handle], 'Thick', nh, owner)!;
    expect(r.changed).toBe(2);
    applyOps(doc, r.ops);
    expect(plotStyleNameOf(doc, ent(doc, red.handle).plotStyle)).toBe('Thick');
    // 이미 같은 이름이면 바꾸지 않는다
    expect(assignPlotStyleOps(doc, [red.handle], 'thick', nh, owner)!.changed).toBe(0);
    const back = assignPlotStyleOps(doc, [red.handle], 'ByLayer', nh, owner)!;
    applyOps(doc, back.ops);
    expect(ent(doc, red.handle).plotStyle).toBeUndefined();
    expect(plotStyleNameOf(doc, ent(doc, byLayer.handle).plotStyle)).toBe('Thick');
  });
});
