import { describe, expect, it } from 'vitest';
import { isDoubleClickFollowUp } from '../../src/app/app';

describe('두 번 누르기와 그립', () => {
  const prev = { time: 1000, screen: { x: 100, y: 100 } };
  it('고른 직후 같은 자리를 다시 누르면 두 번 누르기(그립 편집을 시작하지 않는다)', () => {
    expect(isDoubleClickFollowUp(prev, 1300, { x: 102, y: 101 })).toBe(true);
    expect(isDoubleClickFollowUp(prev, 1500, { x: 100, y: 104 })).toBe(true);
  });
  it('간격이 지나거나 멀리 누르면 보통 클릭(그립 편집)', () => {
    expect(isDoubleClickFollowUp(prev, 1501, { x: 100, y: 100 })).toBe(false);
    expect(isDoubleClickFollowUp(prev, 1200, { x: 105, y: 100 })).toBe(false);
  });
});
