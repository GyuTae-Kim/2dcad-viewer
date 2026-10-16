import { describe, expect, it } from 'vitest';
import { listHeight, listWindow, rowVisible, scrollTopForRow, topRowAt } from '../../src/app/view3d/vlist';

describe('가상 목록 범위 계산', () => {
  it('보통 크기: 스크롤 위치 → 보이는 줄 + 앞뒤 여유', () => {
    // 줄 18px, 화면 180px(10줄), 1000줄
    const w = listWindow(0, 180, 18, 1000, 4);
    expect(w).toEqual({ first: 0, last: 14, top: 0, height: 18000 });
    const w2 = listWindow(18 * 100 + 9, 180, 18, 1000, 4);
    expect(w2.first).toBe(96);
    expect(w2.last).toBe(115);
    // first 줄의 y는 first*18
    expect(w2.top).toBeCloseTo(96 * 18);
  });

  it('끝까지 내리면 마지막 줄까지, 넘치는 스크롤은 잘린다', () => {
    const w = listWindow(1e9, 180, 18, 1000, 4);
    expect(w.last).toBe(1000);
    expect(w.first).toBe(986);
    expect(w.top).toBeCloseTo(986 * 18);
    expect(listWindow(-50, 180, 18, 1000, 0).first).toBe(0);
  });

  it('빈 목록·화면보다 짧은 목록', () => {
    expect(listWindow(0, 180, 18, 0)).toEqual({ first: 0, last: 0, top: 0, height: 0 });
    const w = listWindow(0, 180, 18, 5, 8);
    expect([w.first, w.last, w.top, w.height]).toEqual([0, 5, 0, 90]);
    expect(scrollTopForRow(3, 180, 18, 5)).toBe(0);
  });

  it('아주 긴 목록은 높이를 maxPx로 줄이고 비율로 줄을 잇는다', () => {
    const count = 5_000_000;
    const maxPx = 8_000_000;
    expect(listHeight(count, 18, maxPx)).toBe(maxPx);
    const viewH = 400;
    // 맨 아래까지 내리면 마지막 줄이 보인다
    const end = listWindow(maxPx, viewH, 18, count, 2, maxPx);
    expect(end.last).toBe(count);
    // 가운데쯤
    const mid = listWindow((maxPx - viewH) / 2, viewH, 18, count, 0, maxPx);
    const span = count - viewH / 18;
    expect(mid.first).toBe(Math.floor(span / 2));
    // 줄 → 스크롤 → 줄이 되돌아온다(가운데 놓기)
    const row = 3_141_592;
    const st = scrollTopForRow(row, viewH, 18, count, maxPx);
    const top = topRowAt(st, viewH, 18, count, maxPx);
    expect(row).toBeGreaterThanOrEqual(Math.floor(top));
    expect(row).toBeLessThan(top + viewH / 18);
    expect(rowVisible(row, st, viewH, 18, count, maxPx)).toBe(true);
    expect(rowVisible(row + 1000, st, viewH, 18, count, maxPx)).toBe(false);
  });

  it('줄 보이기: 가운데로 놓는 스크롤 위치', () => {
    const st = scrollTopForRow(500, 180, 18, 1000);
    // 500번 줄이 화면 가운데(4.5줄 아래)에
    expect(st).toBeCloseTo((500 + 0.5 - 5) * 18);
    expect(rowVisible(500, st, 180, 18, 1000)).toBe(true);
    expect(rowVisible(0, st, 180, 18, 1000)).toBe(false);
    // 처음 줄은 0, 마지막 줄은 끝
    expect(scrollTopForRow(0, 180, 18, 1000)).toBe(0);
    expect(scrollTopForRow(999, 180, 18, 1000)).toBe(18000 - 180);
  });
});
