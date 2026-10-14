import { describe, expect, it } from 'vitest';
import { compareRgb, recolorStyles } from '../../src/app/compare-session';

describe('비교 색칠', () => {
  it('비교 색상 → RGB(ACI 7은 배경에 따라, 트루컬러 그대로)', () => {
    expect(compareRgb('1', true, 7)).toBe(0xff0000);
    expect(compareRgb('7', true, 1)).toBe(0xffffff);
    expect(compareRgb('7', false, 1)).toBe(0x000000);
    expect(compareRgb('RGB:41,165,0', true, 7)).toBe(0x29a500);
    expect(compareRgb('잘못', true, 1)).toBe(0xff0000);
  });

  it('스타일 자료의 색만 바꾼 사본(보임·선가중치는 그대로, 숨김이면 모두 숨김)', () => {
    const d = new Float32Array([0.1, 0.2, 0.3, 0.5, 0.25, 1, 0, 0, 0.9, 0.9, 0.9, 1, 0, 0, 0, 0]);
    const out = recolorStyles(d, 0xff8000);
    expect(out).not.toBe(d);
    expect([...out.slice(0, 8)]).toEqual([1, 128 / 255, 0, 0.5, 0.25, 1, 0, 0].map((v) => Math.fround(v)));
    expect(out[13]).toBe(0);
    expect(d[0]).toBeCloseTo(0.1);
    const hid = recolorStyles(d, 0, true);
    expect(hid[5]).toBe(0);
  });
});
