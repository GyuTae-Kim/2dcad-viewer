/** DIMEX·DIMIM: .dim(DXF 조각) 쓰기·읽기 왕복, 핸들 변수(문자 스타일·선종류·화살촉) 풀기, 덮어쓰기·건너뛰기 */
import { describe, expect, it } from 'vitest';
import { tableKey } from '../../src/core/model';
import { importDimStylesOps, parseDimFile, writeDimFile } from '../../src/edit/blkcmds/dimfile';
import { applyOps } from '../../src/edit/session';
import { writeDxf } from '../../src/io/dxf/writer';
import { addBlock, line, setup } from '../util2/helpers';

function source() {
  const t = setup();
  const d = t.doc;
  d.textStyles.set('ROMANS', { name: 'RomanS', handle: t.h(), flags: 0, height: 0, widthFactor: 0.8, oblique: (15 * Math.PI) / 180, generation: 0, lastHeight: 3.5, font: 'romans.shx', bigFont: 'whgtxt.shx' });
  d.linetypes.set('CENTER', { name: 'CENTER', handle: t.h(), flags: 0, description: '____ _ ____', patternLength: 2, elements: [{ length: 1.25, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }, { length: -0.25, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }, { length: 0.25, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }, { length: -0.25, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }] });
  const iso = d.dimStyles.get('ISO-25')!;
  d.dimStyles.set('ARCH', { name: 'Arch', handle: t.h(), flags: 0, vars: { ...iso.vars, DIMTXSTY: 'RomanS', DIMTXT: 3.5, DIMASZ: 2, DIMBLK: '_ArchTick', DIMLDRBLK: '_Dot', DIMLTYPE: 'CENTER', DIMLTEX1: 'ByBlock', DIMPOST: '<> mm', DIMDEC: 1, DIMJOGANG: Math.PI / 3, DIMTFILL: 2 } });
  return t;
}

describe('DIMEX', () => {
  it('DXF 조각: TABLES 하나, 핸들 변수는 조각 안 레코드를 가리킨다', () => {
    const { doc } = source();
    const out = writeDimFile(doc, ['arch', 'NOPE']);
    expect(out.styles).toEqual(['Arch']);
    const lines = out.text.split('\r\n');
    expect(lines.slice(0, 6)).toEqual(['999', 'OpenCAD DIMEX', '  0', 'SECTION', '  2', 'TABLES']);
    expect(lines.slice(-4)).toEqual(['ENDSEC', '  0', 'EOF', '']);
    // 340이 STYLE 레코드 핸들
    const i340 = lines.indexOf('340');
    const h = lines[i340 + 1];
    const iStyle = lines.findIndex((l, i) => l === 'STYLE' && lines[i - 1] === '  0');
    expect(lines[iStyle + 2]).toBe(h);
    expect(out.text).toContain('\r\n  2\r\nRomanS\r\n');
    expect(out.text).toContain('_ArchTick');
  });
});

describe('DIMIM', () => {
  it('왕복: 다른 도면에 변수·문자 스타일·선종류가 함께 들어간다', () => {
    const src = source();
    const text = writeDimFile(src.doc, ['Arch', 'ISO-25']).text;
    const c = parseDimFile(text);
    expect(c.errors).toEqual([]);
    expect(c.styles.map((s) => s.name)).toEqual(['Arch', 'ISO-25']);
    const dst = setup();
    const r = importDimStylesOps(dst.doc, c, true, dst.h);
    expect(r.added).toEqual(['Arch']);
    expect(r.replaced).toEqual(['ISO-25']);
    expect(r.created.sort()).toEqual(['문자 스타일 RomanS', '선종류 CENTER', '화살촉 블록 _ArchTick', '화살촉 블록 _Dot']);
    applyOps(dst.doc, r.ops);
    const got = dst.doc.dimStyles.get('ARCH')!.vars;
    const want = src.doc.dimStyles.get('ARCH')!.vars;
    for (const k of ['DIMTXT', 'DIMASZ', 'DIMDEC', 'DIMJOGANG', 'DIMTFILL', 'DIMPOST', 'DIMBLK', 'DIMLDRBLK', 'DIMLTYPE', 'DIMLTEX1', 'DIMTXSTY', 'DIMSCALE', 'DIMGAP', 'DIMLUNIT']) {
      if (typeof want[k] === 'number') expect(got[k], k).toBeCloseTo(want[k] as number, 10);
      else expect(got[k], k).toBe(want[k]);
    }
    const ts = dst.doc.textStyles.get('ROMANS')!;
    expect(ts.font).toBe('romans.shx');
    expect(ts.bigFont).toBe('whgtxt.shx');
    expect(ts.widthFactor).toBeCloseTo(0.8);
    expect(ts.oblique).toBeCloseTo((15 * Math.PI) / 180);
    expect(dst.doc.linetypes.get('CENTER')!.elements).toHaveLength(4);
    expect(dst.doc.blocks.get('_ARCHTICK')!.entities.length).toBeGreaterThan(0);
    // 덮어쓴 스타일은 핸들을 지킨다
    expect(dst.doc.dimStyles.get('ISO-25')!.handle).toBe(setup().doc.dimStyles.get('ISO-25')!.handle);
  });

  it('덮어쓰지 않기: 있는 이름은 건너뛴다', () => {
    const src = source();
    const c = parseDimFile(writeDimFile(src.doc, ['Arch', 'ISO-25']).text);
    const dst = setup();
    const r = importDimStylesOps(dst.doc, c, false, dst.h);
    expect(r.skipped).toEqual(['ISO-25']);
    expect(r.added).toEqual(['Arch']);
  });

  it('문자 스타일 이름만: 이 도면에 없으면 Standard로 바꾸고 알린다', () => {
    const src = source();
    const c = parseDimFile(writeDimFile(src.doc, ['Arch'], { fullTextStyle: false }).text);
    expect(c.textStyles.get('ROMANS')!.nameOnly).toBe(true);
    const dst = setup();
    const r = importDimStylesOps(dst.doc, c, true, dst.h);
    applyOps(dst.doc, r.ops);
    expect(dst.doc.dimStyles.get('ARCH')!.vars.DIMTXSTY).toBe('Standard');
    expect(r.notes[0]).toMatch(/RomanS/);
  });

  it('온전한 DXF 파일의 치수 스타일도 읽는다', () => {
    const src = source();
    // DXF 쓰기는 도면에 있는 화살촉 블록만 가리킨다
    addBlock(src.doc, src.h, '_ArchTick', [line(src.h(), -0.5, -0.5, 0.5, 0.5)]);
    const dxf = new TextDecoder().decode(writeDxf(src.doc).data);
    const c = parseDimFile(dxf);
    const arch = c.styles.find((s) => tableKey(s.name) === 'ARCH')!;
    expect(arch.vars.DIMTXSTY).toBe('RomanS');
    expect(arch.vars.DIMBLK).toBe('_ArchTick');
    expect(arch.vars.DIMLTYPE).toBe('CENTER');
    expect(arch.vars.DIMTXT).toBeCloseTo(3.5);
  });

  it('치수 스타일이 없거나 깨진 파일', () => {
    expect(parseDimFile('  0\nSECTION\n  2\nTABLES\n  0\nENDSEC\n  0\nEOF\n').errors[0]).toMatch(/없습니다/);
    expect(parseDimFile('hello\nworld\n').errors.length).toBeGreaterThan(0);
  });
});
