/** 찾기·대치(FIND)의 순수 계산: 서식 코드를 보존하며 보이는 글자만 바꾼다 */
import { describe, expect, it } from 'vitest';
import { countMatches, replaceMatches } from '../../src/edit/annot/findreplace';
import { mtextMeaning } from '../../src/text/mtextedit';

const o = { matchCase: false, wholeWord: false };

describe('찾기', () => {
  it('대소문자·전체 단어', () => {
    expect(countMatches('Bolt bolt BOLTS', 'text', 'bolt', o)).toBe(3);
    expect(countMatches('Bolt bolt BOLTS', 'text', 'bolt', { matchCase: true, wholeWord: false })).toBe(1);
    expect(countMatches('Bolt bolt BOLTS', 'text', 'bolt', { matchCase: false, wholeWord: true })).toBe(2);
    expect(countMatches('볼트볼트 볼트', 'text', '볼트', { matchCase: false, wholeWord: true })).toBe(1);
  });

  it('서식 코드는 찾지 않고 보이는 글자만(기호 코드도 글자로)', () => {
    expect(countMatches('{\\fArial|b1;AB}C', 'mtext', 'ABC', o)).toBe(1);
    expect(countMatches('\\fArial;x', 'mtext', 'Arial', o)).toBe(0);
    expect(countMatches('%%c20', 'text', '∅20', o)).toBe(1);
    expect(countMatches('A\\PB', 'mtext', 'AB', o)).toBe(0);
  });
});

describe('대치', () => {
  it('TEXT: %% 코드와 밑줄 토글을 지킨다', () => {
    expect(replaceMatches('%%c20 볼트 %%u강조%%u', 'text', '볼트', '너트', o).text).toBe('%%c20 너트 %%u강조%%u');
  });

  it('MTEXT: 바꾼 글자는 첫 글자의 서식, 나머지 표기는 그대로', () => {
    const src = '\\pxqc;{\\C1;M10}\\U+AC00 볼트\\P둘째 볼트';
    const r = replaceMatches(src, 'mtext', '볼트', '너트', o);
    expect(r.count).toBe(2);
    expect(r.text).toBe('\\pxqc;{\\C1;M10}\\U+AC00 너트\\P둘째 너트');
    expect(mtextMeaning(r.text)).toEqual(mtextMeaning(src.replace(/볼트/g, '너트')));
  });

  it('서식이 바뀌는 자리를 가로지르는 일치', () => {
    const r = replaceMatches('{\\L가나}다라', 'mtext', '나다', 'XY', o);
    expect(r.text).toBe('{\\L가XY}라');
  });

  it('치수 문자: <>는 바꾸지 않는다', () => {
    const r = replaceMatches('<> TYP', 'dim', 'TYP', '전형', o);
    expect(r.text).toBe('<> 전형');
    expect(countMatches('<>', 'dim', '<>', o)).toBe(0);
  });

  it('일치가 없으면 원문 그대로', () => {
    const src = '\\fArial|b1;abc';
    expect(replaceMatches(src, 'mtext', 'zz', 'y', o)).toEqual({ text: src, count: 0 });
  });
});
