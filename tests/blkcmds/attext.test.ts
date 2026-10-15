/** ATTEXT: 템플릿 해석, CDF·SDF 출력(폭·소수·넘침·구분 기호), 중첩 블록 수준, DXF(DXX) */
import { describe, expect, it } from 'vitest';
import type { AttribEntity, Entity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { collectBlocks, formatDxx, formatRecords, parseTemplate, templateTags } from '../../src/edit/blkcmds/attext';
import { addBlock, attdef, insert, line, put, setup } from '../util2/helpers';

function attrib(h: string, owner: string, tag: string, value: string): AttribEntity {
  return { ...attdef(h, tag, value, 0, 0), type: 'ATTRIB', owner, prompt: undefined };
}

describe('템플릿 해석', () => {
  it('필드·형식·구분 기호', () => {
    const t = parseTemplate('BL:NAME C010000\r\nBL:X N008002\nprice  n006001\n\nC:QUOTE "\nC:DELIM |\n');
    expect(t.errors).toEqual([]);
    expect(t.fields).toEqual([
      { name: 'BL:NAME', kind: 'C', width: 10, decimals: 0 },
      { name: 'BL:X', kind: 'N', width: 8, decimals: 2 },
      { name: 'PRICE', kind: 'N', width: 6, decimals: 1 },
    ]);
    expect(t.quote).toBe('"');
    expect(t.delim).toBe('|');
    expect([...templateTags(t)]).toEqual(['PRICE']);
  });

  it('잘못된 줄은 오류', () => {
    const t = parseTemplate('BL:NAME N010000\nBL:FOO C010000\nTAG X10\nBL:X C010000\nNAME C000000');
    expect(t.errors).toHaveLength(5);
    expect(t.fields).toEqual([]);
  });
});

function drawing() {
  const t = setup();
  addBlock(t.doc, t.h, 'PART', [line(t.h(), 0, 0, 1, 0), attdef(t.h(), 'NO', '0', 0, 0), attdef(t.h(), 'PRICE', '0', 0, 1)]);
  // 속성을 가진 참조를 품은 블록(중첩 수준 2)
  const inner = insert('C1', 'PART', 5, 0, { attribs: [attrib('C2', 'C1', 'NO', 'N-9'), attrib('C3', 'C1', 'PRICE', '3.25')] });
  addBlock(t.doc, t.h, 'ASM', [inner], { x: 0, y: 0, z: 0 });
  const p1 = insert('A1', 'PART', 10, 20, { layer: '0', rotation: Math.PI / 2, attribs: [attrib('B1', 'A1', 'NO', 'P-1'), attrib('B2', 'A1', 'PRICE', '1200.5')] });
  const p2 = insert('A2', 'PART', -3.5, 0, { scale: { x: 2, y: 2, z: 1 }, attribs: [attrib('B3', 'A2', 'NO', 'P-2'), attrib('B4', 'A2', 'PRICE', '없음')] });
  const asm = insert('A3', 'ASM', 100, 0);
  put(t.doc, p1, p2, asm, line('L1', 0, 0, 1, 1));
  return t;
}

describe('추출', () => {
  const tpl = parseTemplate(['BL:LEVEL N001000', 'BL:NAME C006000', 'BL:X N008002', 'BL:Y N008002', 'BL:ORIENT N005001', 'BL:NUMBER N003000', 'NO C005000', 'PRICE N009002'].join('\n'));

  it('수준·번호·WCS 좌표(중첩 참조는 바깥 변환을 거친다)', () => {
    const { doc } = drawing();
    const blocks = collectBlocks(doc, doc.blocks.get(MODEL_SPACE)!.entities as Entity[], templateTags(tpl));
    expect(blocks.map((b) => [b.level, b.number, b.entity.handle])).toEqual([
      [1, 1, 'A1'],
      [1, 2, 'A2'],
      [2, 3, 'C1'],
    ]);
    expect(blocks[2]!.insert.x).toBeCloseTo(105);
  });

  it('CDF: 문자는 따옴표, 숫자는 소수 자리, 숫자가 아닌 값은 0과 알림, 넘침은 잘라 알림', () => {
    const { doc } = drawing();
    const blocks = collectBlocks(doc, doc.blocks.get(MODEL_SPACE)!.entities as Entity[], templateTags(tpl));
    const out = formatRecords(blocks, tpl, 'CDF');
    const lines = out.text.split('\r\n');
    expect(lines[0]).toBe("1,'PART',10.00,20.00,90.0,1,'P-1',1200.50");
    expect(lines[1]).toBe("1,'PART',-3.50,0.00,0.0,2,'P-2',0.00");
    expect(lines[2]).toBe("2,'PART',105.00,0.00,0.0,3,'N-9',3.25");
    expect(out.records).toBe(3);
    expect(out.warnings.some((w) => w.includes('숫자가 아니'))).toBe(true);
  });

  it('SDF: 고정 폭(문자 왼쪽, 숫자 오른쪽 맞춤), 넘치면 자른다', () => {
    const { doc } = drawing();
    const t = parseTemplate('BL:NAME C006000\nNO C002000\nBL:X N008002\n');
    const blocks = collectBlocks(doc, doc.blocks.get(MODEL_SPACE)!.entities as Entity[], new Set(['NO']));
    const out = formatRecords(blocks, t, 'SDF');
    const lines = out.text.split('\r\n');
    expect(lines[0]).toBe('PART  P-   10.00');
    expect(lines[1]).toBe('PART  P-   -3.50');
    expect(lines[0]!.length).toBe(16);
    expect(out.warnings.filter((w) => w.includes('넘침'))).toHaveLength(3);
  });

  it('C:QUOTE·C:DELIM', () => {
    const { doc } = drawing();
    const t = parseTemplate('BL:HANDLE C008000\nNO C008000\nC:QUOTE "\nC:DELIM ;');
    const blocks = collectBlocks(doc, [doc.entityIndex.get('A1')!], templateTags(t));
    expect(formatRecords(blocks, t, 'CDF').text).toBe('"A1";"P-1"\r\n');
  });

  it('템플릿 태그를 가진 블록만 레코드가 된다', () => {
    const { doc } = drawing();
    const blocks = collectBlocks(doc, doc.blocks.get(MODEL_SPACE)!.entities as Entity[], new Set(['MISSING']));
    expect(blocks).toHaveLength(0);
  });

  it('DXF(DXX): INSERT·ATTRIB·SEQEND만 담은 ENTITIES 구역', () => {
    const { doc } = drawing();
    const blocks = collectBlocks(doc, [doc.entityIndex.get('A1')!], null);
    const out = formatDxx(blocks).text.split('\r\n');
    const pairs: [string, string][] = [];
    for (let i = 0; i + 1 < out.length; i += 2) pairs.push([out[i]!.trim(), out[i + 1]!]);
    expect(pairs[0]).toEqual(['0', 'SECTION']);
    expect(pairs[1]).toEqual(['2', 'ENTITIES']);
    expect(pairs.filter(([c]) => c === '0').map(([, v]) => v)).toEqual(['SECTION', 'INSERT', 'ATTRIB', 'ATTRIB', 'SEQEND', 'ENDSEC', 'EOF']);
    expect(pairs).toContainEqual(['66', '1']);
    expect(pairs).toContainEqual(['50', '90']);
    expect(pairs).toContainEqual(['1', '1200.5']);
  });
});
