import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, PROP_COLOR, PROP_LAYER, PROP_LTSCALE, entitySignature, isCompared, nearAngle, nearSignature, normDeg, normText } from '../../src/edit/compare/signature';
import type { Entity } from '../../src/core/model';
import { arc, circle, hatch, insert, line, text } from './make';

const opt = DEFAULT_OPTIONS;
const sig = (e: Entity, o = opt) => entitySignature(e, o);
const same = (a: Entity, b: Entity, o = opt) => {
  const x = sig(a, o);
  const y = sig(b, o);
  return x.key === y.key && nearSignature(x, y, 10 ** -o.tolerance);
};

describe('객체 서명', () => {
  it('거꾸로 그린 선은 같은 선', () => {
    expect(same(line(0, 0, 10, 5), line(10, 5, 0, 0))).toBe(true);
    expect(same(line(0, 0, 10, 5), line(0, 0, 10, 6))).toBe(false);
  });

  it('허용 오차 10^-6 안이면 같고 밖이면 다르다', () => {
    expect(same(circle(1, 1, 5), circle(1 + 4e-7, 1, 5))).toBe(true);
    expect(same(circle(1, 1, 5), circle(1 + 3e-6, 1, 5))).toBe(false);
    // 자릿수를 줄이면(허용 오차 10^-3) 같아진다
    expect(same(circle(1, 1, 5), circle(1 + 3e-6, 1, 5), { ...opt, tolerance: 3 })).toBe(true);
    // 큰 좌표에서도
    expect(same(line(1e6, 2e6, 1e6 + 1, 2e6), line(1e6 + 5e-7, 2e6, 1e6 + 1, 2e6))).toBe(true);
  });

  it('각도는 원 위에서 비교한다(360 = 0)', () => {
    expect(normDeg(Math.PI * 2)).toBe(0);
    expect(nearAngle(359.9999999, 0, 1e-6)).toBe(true);
    expect(same(arc(0, 0, 5, 0, 90), arc(0, 0, 5, 360, 90))).toBe(true);
    expect(same(arc(0, 0, 5, 0, 90), arc(0, 0, 5, 1, 90))).toBe(false);
  });

  it('특성은 COMPAREPROPS 비트가 켜졌을 때만', () => {
    const a = line(0, 0, 1, 1, 'A');
    const b = line(0, 0, 1, 1, 'B');
    expect(same(a, b)).toBe(true);
    expect(same(a, b, { ...opt, props: PROP_LAYER })).toBe(false);
    expect(same(a, b, { ...opt, props: PROP_COLOR })).toBe(true);
    const c = { ...line(0, 0, 1, 1), color: { aci: 1 } } as Entity;
    expect(same(line(0, 0, 1, 1), c, { ...opt, props: PROP_COLOR })).toBe(false);
    const d = { ...line(0, 0, 1, 1), ltscale: 2 } as Entity;
    expect(same(line(0, 0, 1, 1), d, { ...opt, props: 127 & ~PROP_LTSCALE })).toBe(true);
    expect(same(line(0, 0, 1, 1), d, { ...opt, props: PROP_LTSCALE })).toBe(false);
  });

  it('문자·해치 필터와 문자 내용', () => {
    expect(isCompared(text(0, 0, 'A'), opt)).toBe(true);
    expect(isCompared(text(0, 0, 'A'), { ...opt, text: false })).toBe(false);
    expect(isCompared(hatch(0, 0, 1, 1), opt)).toBe(false);
    expect(isCompared(hatch(0, 0, 1, 1), { ...opt, hatch: true })).toBe(true);
    expect(same(text(0, 0, 'A'), text(0, 0, 'B'))).toBe(false);
    expect(same(hatch(0, 0, 2, 2), hatch(0, 0, 2, 2))).toBe(true);
    expect(same(hatch(0, 0, 2, 2), hatch(0, 0, 2, 3))).toBe(false);
    expect(same(hatch(0, 0, 2, 2), hatch(0, 0, 2, 2, 'ANSI32'))).toBe(false);
  });

  it('옛 DXF의 \\U+ 글자 이스케이프는 그 글자와 같다', () => {
    expect(normText('\\U+B3C4\\U+BA74 A')).toBe('도면 A');
    expect(normText('a^Jb^ c')).toBe('a\nb^c');
    expect(same(text(0, 0, '도면'), text(0, 0, '\\U+B3C4\\U+BA74'))).toBe(true);
  });

  it('블록 참조는 이름과 블록 정의를 함께 본다(익명 블록은 이름 앞머리만)', () => {
    const a = sig(insert('PART', 1, 2));
    expect(a.block).toBe('PART');
    expect(sig(insert('*U12', 0, 0)).key).toBe(sig(insert('*U3', 0, 0)).key);
    expect(sig(insert('PART', 0, 0)).key).not.toBe(sig(insert('OTHER', 0, 0)).key);
    expect(same(insert('PART', 0, 0, 30), insert('PART', 0, 0, 390))).toBe(true);
  });
});
