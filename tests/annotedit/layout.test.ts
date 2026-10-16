/** 문자 배치 보강: 탭 정지(글머리 기호·번호 목록의 내어쓰기), 트루타입 굵게·기울임꼴 */
import { describe, expect, it } from 'vitest';
import { TextEngine } from '../../src/text/layout';
import { parseMText } from '../../src/text/mtext';
import type { TextStyle } from '../../src/core/model';

const eng = new TextEngine(null);
const base = { height: 2, width: 0, attachment: 1, lineSpacingStyle: 1, lineSpacingFactor: 1 };

describe('탭 정지', () => {
  it('내어쓰기 목록: 첫 줄 글자와 둘째 문단 글자가 같은 자리에서 시작', () => {
    const l = eng.layoutMText({ ...base, text: '\\pxi-3,l3,t3;•^Iabc\\P•^Idef' });
    // 글리프: • a b c • d e f
    const xs = l.glyphs.map((g) => g.m[4]);
    expect(xs[1]).toBeCloseTo(3, 6);
    expect(xs[5]).toBeCloseTo(3, 6);
    expect(xs[0]).toBeCloseTo(0, 6);
  });

  it('탭 정지가 없으면 지금처럼 높이의 4배', () => {
    const l = eng.layoutMText({ ...base, text: 'a^Ib' });
    const a = l.glyphs[0]!;
    const b = l.glyphs[1]!;
    expect(b.m[4] - a.m[4] - a.geom.advance * a.m[0]).toBeCloseTo(8, 6);
  });
});

describe('굵게·기울임꼴', () => {
  it('\\f의 |b1·|i1을 읽는다(SHX \\F는 없음)', () => {
    const p = parseMText('{\\fArial|b1|i1|c0|p34;A}{\\Fromans.shx|b1;B}C', { baseHeight: 1 });
    const runs = p[0]!.runs;
    expect(runs[0]!.style).toMatchObject({ bold: true, italic: true, ttf: true });
    expect(runs[1]!.style).toMatchObject({ bold: false, italic: false, ttf: false });
    expect(runs[2]!.style.bold).toBeUndefined();
  });

  it('단선 글꼴(SHX)에는 적용하지 않는다', () => {
    const plain = eng.layoutMText({ ...base, text: 'AB' });
    const marked = eng.layoutMText({ ...base, text: '{\\fArial|b1|i1;AB}' });
    // 글꼴 라이브러리가 없으면 단선 글꼴로 대체되어 기울기·겹쳐 그리기가 없다
    expect(marked.glyphs.length).toBe(plain.glyphs.length);
    expect(marked.glyphs[0]!.m[2]).toBeCloseTo(0, 9);
  });

  it('문자 스타일의 트루타입 굵게·기울임(1071 비트)도 TEXT에 쓰인다(단선 대체는 제외)', () => {
    const style = { name: 'B', handle: '1', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'arial.ttf', bigFont: '', fontFamily: 'Arial', fontFlags: 34 | 0x1000000 } as TextStyle;
    const t = eng.layoutText({ text: 'A', insert: { x: 0, y: 0 }, height: 2, rotation: 0, widthFactor: 1, oblique: 0, generation: 0, halign: 0, valign: 0, style });
    // TEXT는 글꼴 종류와 관계없이 기울기 행렬에 넣는다(라이브러리 없으면 단선으로 그려도 기울어짐)
    expect(t.glyphs[0]!.m[2]).toBeGreaterThan(0.3);
  });
});
