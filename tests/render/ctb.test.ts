/** 플롯 스타일 표(CTB) 읽기와 펜 색 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseCtbText, penColor, readCtb } from '../../src/render/ctb';

const pen = (i: number, body: string) => ` ${i}{\n  name="Color_${i + 1}\n${body}\n }`;
const text = [
  'description="',
  'aci_table_available=TRUE',
  'plot_style{',
  pen(0, '  color=-16777216\n  color_policy=5\n  screen=100\n  lineweight=8'),
  pen(1, '  color=-1\n  color_policy=3\n  screen=50\n  lineweight=0'),
  '}',
  'custom_lineweight_table{',
  ' 0=0.0',
  ' 8=0.25',
  '}',
].join('\n');

describe('CTB', () => {
  it('펜: 지정 색·회색조·스크린·선가중치 번호', () => {
    const t = parseCtbText(text, 'test.ctb')!;
    expect(t.pens).toHaveLength(255);
    expect(t.pens[0]).toEqual({ color: 0, gray: false, screen: 100, lineweight: 0.25 });
    expect(t.pens[1]).toEqual({ color: null, gray: true, screen: 50, lineweight: null });
    // 빨강(객체 색) → 회색조 → 50% 스크린
    const c = penColor(t.pens[1]!, 0xff0000);
    const y = Math.round(0.299 * 255);
    const s = Math.round(255 - (255 - y) * 0.5);
    expect(c).toBe((s << 16) | (s << 8) | s);
    expect(penColor(t.pens[0]!, 0x00ff00)).toBe(0);
  });

  const D = join(homedir(), 'Library/Application Support/Autodesk/AutoCAD 2024/R24.3/roaming/@en@/Plotters/Plot Styles');
  it.skipIf(!existsSync(join(D, 'monochrome.ctb')))('AutoCAD CTB 파일(이 컴퓨터에 있을 때)', async () => {
    const mono = (await readCtb(new Uint8Array(readFileSync(join(D, 'monochrome.ctb'))), 'monochrome.ctb'))!;
    expect(mono.pens.every((p) => p.color === 0)).toBe(true);
    const gray = (await readCtb(new Uint8Array(readFileSync(join(D, 'Grayscale.ctb'))), 'Grayscale.ctb'))!;
    expect(gray.pens.every((p) => p.gray && p.color === null)).toBe(true);
    const scr = (await readCtb(new Uint8Array(readFileSync(join(D, 'Screening 25%.ctb'))), 'Screening 25%.ctb'))!;
    expect(scr.pens.every((p) => p.screen === 25)).toBe(true);
  });
});
