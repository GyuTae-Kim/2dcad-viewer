/** 이름 있는 플롯 스타일 표(STB): 이름별 펜, 객체·도면층 플롯 스타일로 고르기 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCtbText, readCtb } from '../../src/render/ctb';
import { ColorKind, type LayerState, StyleTable, WidthKind, resolveStyles } from '../../src/render/styles';

const BODY = `description="
plot_style{
 0{
  name="Normal
  color=-1
  color_policy=1
  screen=100
  lineweight=0
 }
 1{
  name="Thick Red
  color=-65536
  color_policy=5
  screen=100
  lineweight=3
 }
 2{
  name="Half
  color=-1
  color_policy=1
  screen=50
  lineweight=0
 }
}
custom_lineweight_table{
 0=0.0
 3=0.7
}
`;

const layer = (over: Partial<LayerState> = {}): LayerState => ({ name: 'A', rgb: 0, aci: 5, hasRgb: false, on: true, frozen: false, lineweight: -3, transparency: 255, plot: true, ...over });

describe('STB', () => {
  const t = parseCtbText(BODY, 'test.stb', true)!;

  it('이름별 펜을 읽는다', () => {
    expect(t.named?.map(([n]) => n)).toEqual(['NORMAL', 'THICK RED', 'HALF']);
    const red = t.named!.find(([n]) => n === 'THICK RED')![1];
    expect(red.color).toBe(0xff0000);
    expect(red.lineweight).toBe(0.7);
  });

  it('객체 플롯 스타일이 먼저, 없으면 도면층, 그것도 없으면 Normal', () => {
    const tbl = new StyleTable();
    const base = { colorKind: ColorKind.Aci, color: 3, layer: 0, freezeLayers: [], widthKind: WidthKind.Default, width: 0, alpha: 255, flags: 0 };
    tbl.intern({ ...base, plotStyle: 'THICK RED' });
    tbl.intern({ ...base });
    const run = (L: LayerState) => resolveStyles(tbl, [L], { darkBackground: false, backgroundRgb: 0xffffff, showLineweight: true, defaultLineweight: 25, plot: { style: 'color', ctb: t } });
    const a = run(layer({ plotStyleName: 'HALF' }));
    // 0번: 객체의 Thick Red → 빨강, 0.7 mm
    expect([a[0], a[1], a[2]]).toEqual([1, 0, 0]);
    expect(a[4]).toBeCloseTo(0.7);
    // 1번: 도면층의 Half → 초록(ACI 3)을 50% 스크린
    expect(a[8 + 0]).toBeCloseTo(0.5, 2);
    expect(a[8 + 1]).toBeCloseTo(1, 2);
    // 도면층 스타일이 없으면 Normal(색 그대로)
    const b = run(layer());
    expect([b[8], b[9], b[10]]).toEqual([0, 1, 0]);
  });
});

// 이 컴퓨터에 AutoCAD 플롯 스타일이 있을 때만(저장소에는 넣지 않는다)

const LOCAL = join(homedir(), 'Library/Application Support/Autodesk/AutoCAD 2026/R25.1/roaming/@en@/Plotters/Plot Styles/monochrome.stb');

describe.skipIf(!existsSync(LOCAL))('로컬 monochrome.stb', () => {
  it('Normal과 사용자 스타일을 읽는다', async () => {
    const t = await readCtb(new Uint8Array(readFileSync(LOCAL)), 'monochrome.stb');
    expect(t?.named?.some(([n]) => n === 'NORMAL')).toBe(true);
    expect(t!.named!.length).toBeGreaterThan(1);
  });
});
