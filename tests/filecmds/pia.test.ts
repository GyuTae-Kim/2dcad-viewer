/** CONVERTCTB: CTB → STB 본문 변환, 파일 묶기(서명·Adler-32·크기·zlib)와 다시 읽기 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adler32, ctbTextFromPens, ctbToStb, lineweightIndex, packPia, parsePia, serializePia, standardCtbPens, unpackPia } from '../../src/edit/filecmds/pia';
import { parseCtbText, readCtb } from '../../src/render/ctb';

describe('PIA 본문', () => {
  it('읽고 다시 쓰면 같은 본문(깊이마다 빈칸 하나)', () => {
    const text = ['description="', 'aci_table_available=TRUE', 'plot_style{', ' 0{', '  name="Color_1', '  color=-1', ' }', '}', 'custom_lineweight_table{', ' 0=0.0', '}', ''].join('\n');
    expect(serializePia(parsePia(text))).toBe(text);
  });

  it('Adler-32', () => {
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398);
    expect(adler32(new Uint8Array(0))).toBe(1);
  });

  it('선가중치 mm → 표 번호(없으면 0)', () => {
    expect(lineweightIndex(null)).toBe(0);
    expect(lineweightIndex(0.25)).toBe(8);
    expect(lineweightIndex(0.7)).toBe(17);
  });
});

describe('CTB → STB', () => {
  const pens = standardCtbPens('monochrome.ctb')!;
  pens[0] = { color: 0xff0000, gray: false, screen: 50, lineweight: 0.7 };
  pens[2] = { color: null, gray: true, screen: 100, lineweight: null };
  const ctb = ctbTextFromPens(pens, 'test');

  it('펜 표로 만든 CTB 본문을 CTB로 다시 읽으면 같은 펜', () => {
    const t = parseCtbText(ctb, 'x.ctb')!;
    expect(t.pens).toHaveLength(255);
    expect(t.pens[0]).toEqual({ color: 0xff0000, gray: false, screen: 50, lineweight: 0.7 });
    expect(t.pens[1]).toEqual({ color: 0, gray: false, screen: 100, lineweight: null });
    expect(t.pens[2]).toEqual({ color: null, gray: true, screen: 100, lineweight: null });
  });

  it('STB: aci_table을 빼고 Normal + Color_1~Color_255, 펜 설정은 그대로', () => {
    const stb = ctbToStb(ctb);
    expect(stb).toContain('aci_table_available=FALSE');
    expect(stb).not.toContain('aci_table{');
    const t = parseCtbText(stb, 'x.stb', true)!;
    expect(t.named).toHaveLength(256);
    expect(t.named![0]![0]).toBe('NORMAL');
    expect(t.named![0]![1]).toEqual({ color: null, gray: false, screen: 100, lineweight: null });
    expect(t.named![1]).toEqual(['COLOR_1', { color: 0xff0000, gray: false, screen: 50, lineweight: 0.7 }]);
    expect(t.named![3]).toEqual(['COLOR_3', { color: null, gray: true, screen: 100, lineweight: null }]);
    expect(t.named![255]![0]).toBe('COLOR_255');
    // 선가중치 표는 그대로
    expect(stb).toMatch(/custom_lineweight_table\{\n 0=0\.0\n 1=0\.05\n/);
  });

  it('파일로 묶고 다시 풀기: 48바이트 서명, 압축 자료의 Adler-32, 크기', async () => {
    const stb = ctbToStb(ctb);
    const data = await packPia(stb, 'STB');
    const head = String.fromCharCode(...data.subarray(0, 48));
    expect(head).toBe('PIAFILEVERSION_2.0,STBVER1,compress\r\npmzlibcodec');
    const dv = new DataView(data.buffer);
    const z = data.subarray(60);
    expect(dv.getUint32(48, true)).toBe(adler32(z));
    expect(dv.getUint32(52, true)).toBe(stb.length);
    expect(dv.getUint32(56, true)).toBe(z.length);
    const back = await unpackPia(data);
    expect(back).toEqual({ kind: 'STB', text: stb });
    // 플롯에서 쓰는 리더도 읽는다
    const t = await readCtb(data, 'x.stb');
    expect(t?.named?.find(([n]) => n === 'COLOR_1')?.[1].color).toBe(0xff0000);
  });

  it('CTB가 아니면 풀지 않는다', async () => {
    expect(await unpackPia(new Uint8Array(100))).toBeNull();
  });

  // AutoCAD가 설치된 컴퓨터의 플롯 스타일 폴더(읽기만 한다, 저장소에 넣지 않는다). CAD_PLOT_STYLES로 바꿀 수 있다
  const LOCAL = process.env.CAD_PLOT_STYLES ?? join(homedir(), 'Library/Application Support/Autodesk/AutoCAD 2026/R25.1/roaming/@es@/Plotters/Plot Styles');
  it.skipIf(!existsSync(join(LOCAL, 'Grayscale.ctb')))('AutoCAD CTB 파일 변환(이 컴퓨터에 있을 때)', async () => {
    const r = await unpackPia(new Uint8Array(readFileSync(join(LOCAL, 'Grayscale.ctb'))));
    expect(r?.kind).toBe('CTB');
    const stb = ctbToStb(r!.text);
    const t = parseCtbText(stb, 'Grayscale.stb', true)!;
    expect(t.named).toHaveLength(256);
    expect(t.named!.slice(1).every(([, p]) => p.gray && p.color === null)).toBe(true);
    // AutoCAD STB와 같은 머리 항목
    const ref = await unpackPia(new Uint8Array(readFileSync(join(LOCAL, 'acad.stb'))));
    const keys = (s: string) => parsePia(s).map(([k]) => k);
    expect(keys(stb)).toEqual(keys(ref!.text));
  });
});
