import { describe, expect, it } from 'vitest';
import { bulgeArc, bulgePoints, interpolateFitPoints, nurbsPoints } from '../../src/geom/curves';

describe('곡선 나누기', () => {
  it('볼록도 1은 반원, 중심은 현의 중점', () => {
    const a = bulgeArc(0, 0, 10, 0, 1)!;
    expect(a.cx).toBeCloseTo(5);
    expect(a.cy).toBeCloseTo(0);
    expect(a.r).toBeCloseTo(5);
    const out: number[] = [];
    bulgePoints(0, 0, 10, 0, 1, 0.01, out);
    // 반시계(왼쪽으로 볼록): 0→10 진행에서 중간점은 y < 0 (오른쪽 아래 반원)
    const mid = out[Math.floor(out.length / 4) * 2 + 1]!;
    expect(mid).toBeLessThan(0);
  });
  it('작은 볼록도와 큰 볼록도의 중심 방향', () => {
    const small = bulgeArc(0, 0, 10, 0, 0.5)!; // 중심각 < π
    const big = bulgeArc(0, 0, 10, 0, 2)!; // 중심각 > π
    expect(small.cy).toBeGreaterThan(0);
    expect(big.cy).toBeLessThan(0);
    for (const a of [small, big]) {
      expect(Math.hypot(0 - a.cx, 0 - a.cy)).toBeCloseTo(a.r);
      expect(Math.hypot(10 - a.cx, 0 - a.cy)).toBeCloseTo(a.r);
    }
  });
  it('NURBS 끝점과 맞춤점 보간', () => {
    const ctrl = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 3, y: 2, z: 0 },
      { x: 4, y: 0, z: 0 },
    ];
    const pts = nurbsPoints(3, [0, 0, 0, 0, 1, 1, 1, 1], ctrl, undefined, 0.001);
    expect(pts[0]).toBeCloseTo(0);
    expect(pts[pts.length - 3]).toBeCloseTo(4);
    const fit = [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 3, z: 0 },
      { x: 5, y: 1, z: 0 },
      { x: 7, y: 4, z: 0 },
    ];
    const s = interpolateFitPoints(fit);
    const q = nurbsPoints(s.degree, s.knots, s.ctrl, undefined, 0.0001);
    // 각 맞춤점 근처를 지나는지
    for (const f of fit) {
      let best = Infinity;
      for (let i = 0; i < q.length; i += 3) best = Math.min(best, Math.hypot(q[i]! - f.x, q[i + 1]! - f.y));
      expect(best).toBeLessThan(0.05);
    }
  });
});
