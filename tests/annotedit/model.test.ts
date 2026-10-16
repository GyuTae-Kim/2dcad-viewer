/** 문자 편집 모델(src/text/mtextedit): MTEXT·TEXT 서식 문자열 왕복과 편집 연산 */
import { describe, expect, it } from 'vitest';
import {
  applyFmt,
  buildFontSpec,
  decodeStack,
  deleteRange,
  docLength,
  encodeStack,
  fmtAt,
  insertItems,
  insertText,
  listKindOf,
  mtextMeaning,
  parseFontSpec,
  parseRich,
  plainText,
  serializeRich,
  setList,
  setParaFmt,
  splitPara,
  toOff,
  toPos,
} from '../../src/text/mtextedit';

/** AutoCAD·이 앱이 쓰는 여러 꼴의 MTEXT 서식 문자열 */
const SAMPLES = [
  'Hello',
  'A\\PB\\PC',
  '{\\fArial|b1|i0|c0|p34;굵게}보통',
  '\\fArial|b0|i1|c0|p34;기울임 끝까지',
  '{\\H2x;큰}{\\H0.5x;작은}',
  '\\H5;절대{\\H2x;두배}',
  '{\\C1;빨강}{\\c255;BGR}',
  '{\\L밑줄\\l끝}{\\O윗줄}{\\K취소}',
  '%%u토글%%u 일반 %%o위%%o',
  '%%c10 %%d %%p0.1 %%%',
  '\\U+AC00\\U+B098 \\~공백',
  'a\\{b\\}c\\\\d',
  '분수 \\S1/2; 대각 \\S3#4; 공차 \\S+0.1^-0.2;',
  '{\\W0.8;좁게}{\\T1.5;자간}{\\Q15;기울기}{\\A1;가운데}',
  '\\pxqc;가운데\\P이어받음\\P\\pql;왼쪽',
  '\\pxi-3,l3,t3;•^I첫째\\P•^I둘째',
  '열1\\N열2',
  '탭^I다음^J줄',
  '^ 꺾쇠',
  '{\\fromans.shx|c0;SHX}',
  '{\\H1.5x;{\\C3;초록 큰}큰만}',
  '\\pxi1.5,l2,r0.5,qj;양쪽',
  '\\A2;{\\H0.7x;\\S1/2;}',
  'trailing%%',
];

describe('MTEXT 왕복', () => {
  for (const s of SAMPLES) {
    it(`뜻이 같다: ${s}`, () => {
      const out = serializeRich(parseRich(s));
      expect(mtextMeaning(out, 2.5)).toEqual(mtextMeaning(s, 2.5));
    });
  }

  it('두 번 쓰면 같은 문자열(정리된 표기는 안정)', () => {
    for (const s of SAMPLES) {
      const once = serializeRich(parseRich(s));
      expect(serializeRich(parseRich(once))).toBe(once);
    }
  });

  it('원래 표기를 지닌다(기호·유니코드·이스케이프)', () => {
    expect(serializeRich(parseRich('%%c10 \\U+AC00 \\~ a\\{b'))).toBe('%%c10 \\U+AC00 \\~ a\\{b');
    expect(serializeRich(parseRich('\\pxi-3,l3,t3;•^I첫째'))).toBe('\\pxi-3,l3,t3;•^I첫째');
  });

  it('문단 서식은 다음 문단이 이어받고, 바꾼 문단만 코드를 더한다', () => {
    const d = parseRich('\\pxqc;A\\PB');
    expect(d.paras[1]!.pf.align).toBe('c');
    setParaFmt(d, 0, 0, { align: 'r' });
    const out = serializeRich(d);
    // 둘째 문단은 여전히 가운데
    const m = mtextMeaning(out) as { align: number }[];
    expect(m.map((p) => p.align)).toEqual([3, 2]);
  });

  it('서식 없는 글자는 묶음 없이, 같은 서식의 이웃 글자는 한 묶음으로', () => {
    const d = parseRich('abc');
    applyFmt(d, 1, 2, (f) => ({ ...f, underline: true }));
    expect(serializeRich(d)).toBe('a{\\Lb}c');
    applyFmt(d, 0, 3, (f) => ({ ...f, color: { aci: 1 } }));
    expect(serializeRich(d)).toBe('{\\C1;a}{\\C1;\\Lb}{\\C1;c}');
  });

  it('새로 넣은 기호는 %%d·%%p·%%c, 특수 문자는 이스케이프', () => {
    const d = parseRich('');
    insertText(d, 0, '°±\u2205 {x}\\ ^I %', {});
    expect(serializeRich(d)).toBe('%%d%%p%%c \\{x\\}\\\\ ^ I %');
    expect(mtextMeaning(serializeRich(d))).toEqual(mtextMeaning('%%d%%p%%c \\{x\\}\\\\ ^ I %'));
  });

  it('% 뒤에 %로 시작하는 것이 오면 %%%', () => {
    const d = parseRich('');
    insertText(d, 0, '%%d', {});
    const s = serializeRich(d);
    expect(s).toBe('%%%%d');
    expect((mtextMeaning(s) as { runs: { text: string }[] }[])[0]!.runs[0]!.text).toBe('%%d');
  });

  it('필드 템플릿과 측정값 자리는 한 조각', () => {
    const t = '날짜: %<\\AcVar Date \\f "yyyy-MM-dd">% 끝';
    const d = parseRich(t, { fields: true });
    expect(d.paras[0]!.items.filter((x) => x.k === 'field').length).toBe(1);
    expect(serializeRich(d)).toBe(t);
    const dm = parseRich('R<>{\\H0.7x;\\S+0.1^-0.1;}', { measure: true });
    expect(dm.paras[0]!.items[1]!.k).toBe('measure');
    expect(serializeRich(dm)).toBe('R<>{\\H0.7x;\\S+0.1^-0.1;}');
  });
});

describe('TEXT 왕복', () => {
  const T = ['abc', '%%c20 %%d %%p', '%%u밑줄%%u 보통', '100%%%', '\\U+AC00가', '%%065B'];
  for (const s of T) {
    it(s, () => {
      expect(serializeRich(parseRich(s, { mode: 'text' }), { mode: 'text' })).toBe(s);
    });
  }
  it('밑줄 서식 → %%u 토글', () => {
    const d = parseRich('abc', { mode: 'text' });
    applyFmt(d, 1, 3, (f) => ({ ...f, underline: true }));
    expect(serializeRich(d, { mode: 'text' })).toBe('a%%ubc%%u');
  });
  it('새 기호는 %% 코드', () => {
    const d = parseRich('', { mode: 'text' });
    insertText(d, 0, '⌀°', {});
    expect(serializeRich(d, { mode: 'text' })).toBe('\u2300%%d');
  });
});

describe('편집 연산', () => {
  it('위치 ↔ 오프셋(문단 사이 1칸)', () => {
    const d = parseRich('ab\\Pcd');
    expect(docLength(d)).toBe(5);
    expect(toPos(d, 3)).toEqual({ p: 1, i: 0 });
    expect(toOff(d, { p: 1, i: 2 })).toBe(5);
  });

  it('문단 나누기·지우기(문단 붙이기)', () => {
    const d = parseRich('\\pxqc;abcd');
    const o = splitPara(d, 2);
    expect(o).toBe(3);
    expect(d.paras.length).toBe(2);
    expect(d.paras[1]!.pf.align).toBe('c');
    deleteRange(d, 1, 4);
    expect(plainText(d)).toBe('ad');
    expect(d.paras.length).toBe(1);
  });

  it('입력 서식은 앞 글자를 따른다', () => {
    const d = parseRich('{\\C1;red}x');
    expect(fmtAt(d, 2)).toEqual({ color: { aci: 1 } });
    expect(fmtAt(d, 4)).toEqual({});
    insertItems(d, 0, [{ k: 'tab', f: {} }]);
    expect(serializeRich(d)).toBe('^I{\\C1;red}x');
  });

  it('글머리 기호·번호 목록', () => {
    const d = parseRich('하나\\P둘\\P셋');
    setList(d, 0, docLength(d), 'number', 3);
    expect(plainText(d)).toBe('1.\t하나\n2.\t둘\n3.\t셋');
    expect(d.paras.map(listKindOf)).toEqual(['number', 'number', 'number']);
    expect(d.paras[0]!.pf).toMatchObject({ indentFirst: -3, indentLeft: 3, tabs: [3] });
    const s = serializeRich(d);
    expect(s.startsWith('\\pxi-3,l3,t3;1.^I하나')).toBe(true);
    setList(d, 0, docLength(d), 'bullet', 3);
    expect(plainText(d).split('\n')[1]).toBe('•\t둘');
    setList(d, 0, docLength(d), 'off', 3);
    expect(plainText(d)).toBe('하나\n둘\n셋');
  });

  it('쌓기 표기', () => {
    expect(encodeStack('1/2')).toBe('1\\/2');
    expect(decodeStack('%%c5')).toBe('\u22055');
  });

  it('글꼴 지정 읽기·쓰기', () => {
    const s = parseFontSpec('Arial|b0|i1|c0|p34');
    expect(s).toEqual({ family: 'Arial', bold: false, italic: true, rest: ['c0', 'p34'] });
    expect(buildFontSpec({ ...s, bold: true })).toBe('Arial|b1|i1|c0|p34');
    expect(buildFontSpec({ family: '맑은 고딕', bold: false, italic: false, rest: [] })).toBe('맑은 고딕|b0|i0|c0|p34');
  });
});
