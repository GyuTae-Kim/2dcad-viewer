import { describe, expect, it } from 'vitest';
import { decodePercent, parseMText } from '../../src/text/mtext';
import { TextEngine, isShxFont } from '../../src/text/layout';
import { latinFamilyOf, triangulateContours } from '../../src/text/fonts';

describe('문자 서식', () => {
  it('%% 코드와 \\U+ 이스케이프', () => {
    expect(decodePercent('%%c10%%d %%p0.1')).toEqual([0x2205, 49, 48, 0xb0, 32, 0xb1, 48, 46, 49]);
    expect(decodePercent('\\U+AC00')).toEqual([0xac00]);
    expect(decodePercent('%%065')).toEqual([65]);
  });

  it('MTEXT 문단·글꼴·높이·쌓기', () => {
    const ps = parseMText('{\\fArial|b0|i0;AB}\\P\\H2x;C\\S1/2;', { baseHeight: 2.5 });
    expect(ps.length).toBe(2);
    expect(ps[0]!.runs[0]!.style.font).toBe('Arial');
    expect(ps[0]!.runs[0]!.style.ttf).toBe(true);
    expect(String.fromCodePoint(...ps[0]!.runs[0]!.text)).toBe('AB');
    const second = ps[1]!.runs;
    expect(second[0]!.style.height).toBe(2);
    expect(second[1]!.stack?.type).toBe('/');
  });

  it('MTEXT 이스케이프된 중괄호와 역슬래시', () => {
    const ps = parseMText('a\\{b\\}c\\\\d', { baseHeight: 1 });
    expect(String.fromCodePoint(...ps[0]!.runs.flatMap((r) => r.text))).toBe('a{b}c\\d');
  });

  it('글꼴 이름 판별', () => {
    expect(isShxFont('txt')).toBe(true);
    expect(isShxFont('romans.shx')).toBe(true);
    expect(isShxFont('arial.ttf')).toBe(false);
    expect(isShxFont('맑은 고딕')).toBe(false);
    expect(latinFamilyOf('Arial')).toBe('sans');
    expect(latinFamilyOf('times.ttf')).toBe('serif');
    expect(latinFamilyOf('romans.shx')).toBe(null);
  });
});

describe('문자 배치', () => {
  const eng = new TextEngine(null);
  const base = { text: 'ABC', insert: { x: 10, y: 20 }, height: 2, rotation: 0, widthFactor: 1, oblique: 0, generation: 0, halign: 0, valign: 0 };

  it('왼쪽 기준선: 첫 글자가 삽입점에서 시작', () => {
    const l = eng.layoutText(base);
    expect(l.glyphs.length).toBe(3);
    expect(l.glyphs[0]!.m[4]).toBeCloseTo(10);
    expect(l.glyphs[0]!.m[5]).toBeCloseTo(20);
    expect(l.glyphs[0]!.m[3]).toBeCloseTo(2); // 높이 = 대문자 높이
  });

  it('가운데 정렬: 두 번째 정렬점이 가운데', () => {
    const l = eng.layoutText({ ...base, halign: 1, alignPoint: { x: 100, y: 0 } });
    const left = l.glyphs[0]!.m[4];
    const right = l.minX + l.maxX;
    expect(left).toBeLessThan(100);
    expect(right / 2).toBeCloseTo(100, 0);
  });

  it('맞춤(fit): 두 점 사이 길이에 맞게 폭 비율을 바꾼다', () => {
    const l = eng.layoutText({ ...base, halign: 5, insert: { x: 0, y: 0 }, alignPoint: { x: 30, y: 0 } });
    expect(l.maxX).toBeCloseTo(30, 0);
  });

  it('MTEXT 줄바꿈: 폭보다 긴 줄은 단어 단위로 나눈다', () => {
    const l = eng.layoutMText({ text: 'AAA BBB CCC', height: 1, width: 3.5, attachment: 1, lineSpacingStyle: 1, lineSpacingFactor: 1 });
    const ys = new Set(l.glyphs.map((g) => Math.round(g.m[5] * 1000)));
    expect(ys.size).toBeGreaterThanOrEqual(2);
  });
});

describe('글리프 삼각분할', () => {
  it('겹친 윤곽(0이 아닌 감김)은 둘 다 채운다', () => {
    const a = [0, 0, 10, 0, 10, 10, 0, 10];
    const b = [5, 5, 15, 5, 15, 15, 5, 15];
    const tris = triangulateContours([a, b]);
    // 두 사각형 = 삼각형 4개
    expect(tris.length / 6).toBe(4);
  });
  it('반대 방향 안쪽 윤곽은 구멍', () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const hole = [3, 3, 3, 7, 7, 7, 7, 3];
    const tris = triangulateContours([outer, hole]);
    let area = 0;
    for (let i = 0; i < tris.length; i += 6) area += Math.abs((tris[i + 2]! - tris[i]!) * (tris[i + 5]! - tris[i + 1]!) - (tris[i + 4]! - tris[i]!) * (tris[i + 3]! - tris[i + 1]!)) / 2;
    expect(area).toBeCloseTo(100 - 16);
  });
});
