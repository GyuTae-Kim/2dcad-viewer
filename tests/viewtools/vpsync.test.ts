/** 배치 뷰포트: VPSCALE 축척, VPSYNC 축척·중심, VPMAX 모형 범위 */
import { describe, expect, it } from 'vitest';
import { insideViewport, paperToModel, syncViewport, vpModelWindow, vpRef, vpScale, vpScaleLines, type VpView } from '../../src/edit/viewtools/vpsync';

const vp = (cx: number, cy: number, w: number, h: number, vcx: number, vcy: number, vh: number, twist = 0, target = { x: 0, y: 0 }): VpView => ({
  center: { x: cx, y: cy },
  width: w,
  height: h,
  viewCenter: { x: vcx, y: vcy },
  viewHeight: vh,
  viewTarget: target,
  twistAngle: twist,
});

describe('VPSCALE', () => {
  it('축척 = 높이 / 뷰 높이, 표시 PS:MS', () => {
    const a = vp(100, 100, 200, 100, 0, 0, 2000);
    expect(vpScale(a)).toBeCloseTo(0.05, 12);
    expect(vpScaleLines(a)).toEqual(['PS:MS == 1:20', '뷰포트 축척 비율: 0.05xp']);
    expect(vpScaleLines(vp(0, 0, 100, 100, 0, 0, 50))).toEqual(['PS:MS == 2:1', '뷰포트 축척 비율: 2xp']);
    expect(vpScaleLines(vp(0, 0, 100, 100, 0, 0, 0))[0]).toContain('알 수 없습니다');
  });
});

describe('VPSYNC', () => {
  it('대상은 마스터와 같은 축척, 종이에서 이어지는 모형 중심', () => {
    const master = vp(100, 100, 100, 100, 500, 300, 1000); // k = 0.1
    const target = vp(250, 100, 100, 50, 0, 0, 77);
    const p = syncViewport(master, target)!;
    expect(target.height / p.viewHeight).toBeCloseTo(0.1, 12);
    // 종이 오른쪽 150 → 모형 오른쪽 1500
    expect(p.viewCenter.x).toBeCloseTo(2000, 9);
    expect(p.viewCenter.y).toBeCloseTo(300, 9);
    // 맞춘 뒤 두 뷰포트에서 같은 종이 점이 같은 모형 점
    const t2 = { ...target, viewHeight: p.viewHeight, viewCenter: p.viewCenter };
    const pt = { x: 200, y: 120 };
    const m1 = paperToModel(master, pt);
    const m2 = paperToModel(t2, pt);
    expect(m2.x).toBeCloseTo(m1.x, 9);
    expect(m2.y).toBeCloseTo(m1.y, 9);
  });
  it('대상점(target)과 같은 비틀기도 맞춘다', () => {
    const tw = 0.3;
    const master = vp(0, 0, 100, 100, 10, 20, 200, tw, { x: 5, y: 5 });
    const target = vp(80, -30, 60, 60, 0, 0, 10, tw, { x: -7, y: 3 });
    const p = syncViewport(master, target)!;
    const t2 = { ...target, viewHeight: p.viewHeight, viewCenter: p.viewCenter };
    for (const pt of [
      { x: 70, y: -20 },
      { x: 90, y: -40 },
    ]) {
      const a = paperToModel(master, pt);
      const b = paperToModel(t2, pt);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
  });
  it('비틀기가 다르면 맞출 수 없다', () => {
    expect(syncViewport(vp(0, 0, 10, 10, 0, 0, 10, 0), vp(20, 0, 10, 10, 0, 0, 10, 0.5))).toBeNull();
  });
});

describe('VPMAX 모형 범위', () => {
  it('뷰포트가 보이는 모형 사각형', () => {
    const w = vpModelWindow(vp(50, 50, 200, 100, 30, 40, 1000, 0, { x: 1, y: 2 }))!;
    expect(w).toEqual({ cx: 31, cy: 42, w: 2000, h: 1000 });
    expect(vpRef(vp(0, 0, 1, 1, 3, 4, 1, 0, { x: 1, y: 1 }))).toEqual({ x: 4, y: 5 });
    expect(vpModelWindow(vp(0, 0, 10, 10, 0, 0, 0))).toBeNull();
  });
  it('종이 점이 뷰포트 안인지', () => {
    const a = vp(10, 10, 20, 10, 0, 0, 1);
    expect(insideViewport(a, { x: 0, y: 5 })).toBe(true);
    expect(insideViewport(a, { x: 21, y: 10 })).toBe(false);
  });
});
