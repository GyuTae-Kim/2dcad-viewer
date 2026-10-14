import { describe, expect, it } from 'vitest';
import { formatAngle, formatLength, parseAngle, parseLength } from '../../src/core/units';

describe('길이·각도 입력', () => {
  it('소수·분수·피트-인치를 읽는다', () => {
    expect(parseLength('12.5')).toBe(12.5);
    expect(parseLength('-3')).toBe(-3);
    expect(parseLength('1.25E+01')).toBe(12.5);
    expect(parseLength('12 1/2')).toBe(12.5);
    expect(parseLength('1/4')).toBe(0.25);
    expect(parseLength(`1'-2.5"`)).toBe(14.5);
    expect(parseLength(`1'2-1/2"`)).toBe(14.5);
    expect(parseLength(`3'`)).toBe(36);
    expect(parseLength(`4"`)).toBe(4);
    expect(parseLength(`-1'-0"`)).toBe(-12);
    expect(parseLength('abc')).toBeNull();
    expect(parseLength('')).toBeNull();
  });

  it('표시한 길이를 다시 읽으면 같은 값이다', () => {
    for (const lunits of [1, 2, 3, 4, 5]) {
      const v = 30.5;
      expect(parseLength(formatLength(v, { lunits, luprec: 4 }))).toBeCloseTo(v, 3);
    }
  });

  it('각도를 읽는다', () => {
    expect(parseAngle('90')).toBeCloseTo(Math.PI / 2);
    expect(parseAngle('45d30\'')).toBeCloseTo((45.5 * Math.PI) / 180);
    expect(parseAngle('100g')).toBeCloseTo(Math.PI / 2);
    expect(parseAngle('1.5r')).toBe(1.5);
    expect(parseAngle('1.5', 3)).toBe(1.5);
    expect(parseAngle('30°')).toBeCloseTo(Math.PI / 6);
    expect(parseAngle('x')).toBeNull();
    for (const aunits of [0, 1, 2, 3]) {
      const a = 0.6;
      expect(parseAngle(formatAngle(a, { aunits, auprec: 6 }), aunits)).toBeCloseTo(a, 3);
    }
  });
});
