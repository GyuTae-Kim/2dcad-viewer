/** 등각투영 제도: 평면 축, 등각 격자 스냅, 등각 직교, 등각원 축, 등각 격자선 */
import { describe, expect, it } from 'vitest';
import { isoAxes, isoCircle, isoCirclePoint, isoGridSegments, isoLattice, isoOrthoPoint, isoPolarAngles, isoSnapPoint, nextIsoPlane, toIsoPlane } from '../../src/edit/viewtools/iso';

const D = Math.PI / 180;
const deg = (a: number) => Math.round(((a / D) % 360 + 360) % 360 * 1e6) / 1e6;

describe('등각평면', () => {
  it('축: 왼쪽 90°·150°, 위 30°·150°, 오른쪽 30°·90°', () => {
    expect(isoAxes(0).map(deg)).toEqual([90, 150]);
    expect(isoAxes(1).map(deg)).toEqual([30, 150]);
    expect(isoAxes(2).map(deg)).toEqual([30, 90]);
  });
  it('F5 순환 왼쪽 → 위 → 오른쪽 → 왼쪽, 잘못된 값은 위', () => {
    expect([nextIsoPlane(0), nextIsoPlane(1), nextIsoPlane(2)]).toEqual([1, 2, 0]);
    expect(toIsoPlane(2)).toBe(2);
    expect(toIsoPlane('x')).toBe(1);
  });
  it('극좌표 추적 각도는 30°·90°·150°·210°·270°·330°', () => {
    expect(isoPolarAngles().map(deg)).toEqual([30, 90, 150, 210, 270, 330]);
  });
});

describe('등각 격자 스냅', () => {
  const s = 10;
  it('격자점은 30°·150° 방향 s 간격, 수직 s 간격', () => {
    const [a, b] = isoLattice(s);
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(10, 9);
    expect(deg(Math.atan2(a.y, a.x))).toBeCloseTo(30, 6);
    expect(deg(Math.atan2(b.y, b.x))).toBeCloseTo(150, 6);
    expect(a.y + b.y).toBeCloseTo(10, 9);
    expect(a.x + b.x).toBeCloseTo(0, 9);
  });
  it('가장 가까운 격자점으로', () => {
    const base = { x: 0, y: 0 };
    const c = (Math.sqrt(3) / 2) * s;
    expect(isoSnapPoint({ x: 0.4, y: 0.3 }, base, s)).toEqual({ x: 0, y: 0 });
    const p = isoSnapPoint({ x: c - 0.5, y: 5.6 }, base, s);
    expect(p.x).toBeCloseTo(c, 9);
    expect(p.y).toBeCloseTo(5, 9);
    const q = isoSnapPoint({ x: 0.2, y: 9.1 }, base, s);
    expect(q.x).toBeCloseTo(0, 9);
    expect(q.y).toBeCloseTo(10, 9);
    // 기준점을 옮기면 격자도 옮겨진다
    const r = isoSnapPoint({ x: 3.1, y: 2.2 }, { x: 3, y: 2 }, s);
    expect(r.x).toBeCloseTo(3, 9);
    expect(r.y).toBeCloseTo(2, 9);
  });
  it('어떤 점이든 결과는 격자점이고 가장 가깝다(무작위 대조)', () => {
    const [a, b] = isoLattice(s);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 200 - 100;
    for (let k = 0; k < 300; k++) {
      const p = { x: rnd(), y: rnd() };
      const q = isoSnapPoint(p, { x: 0, y: 0 }, s);
      let best = Infinity;
      for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) best = Math.min(best, Math.hypot(i * a.x + j * b.x - p.x, i * a.y + j * b.y - p.y));
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeCloseTo(best, 9);
    }
  });
  it('간격이 0이면 그대로', () => {
    expect(isoSnapPoint({ x: 1, y: 2 }, { x: 0, y: 0 }, 0)).toEqual({ x: 1, y: 2 });
  });
});

describe('등각 직교', () => {
  it('위 평면: 커서에 가까운 30° 또는 150° 축으로 투영', () => {
    const p = isoOrthoPoint({ x: 0, y: 0 }, { x: 10, y: 4 }, 1);
    expect(deg(Math.atan2(p.y, p.x))).toBeCloseTo(30, 6);
    const q = isoOrthoPoint({ x: 0, y: 0 }, { x: -10, y: 4 }, 1);
    expect(deg(Math.atan2(q.y, q.x))).toBeCloseTo(150, 6);
    // 투영 길이 = 커서 벡터 · 축 방향
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(10 * Math.cos(30 * D) + 4 * Math.sin(30 * D), 9);
  });
  it('왼쪽 평면은 수직·150°, 오른쪽 평면은 수직·30°', () => {
    const up = isoOrthoPoint({ x: 1, y: 1 }, { x: 1.5, y: 9 }, 0);
    expect(up.x).toBeCloseTo(1, 9);
    expect(up.y).toBeCloseTo(9, 9);
    const r = isoOrthoPoint({ x: 0, y: 0 }, { x: -8, y: -5 }, 2);
    expect(deg(Math.atan2(r.y, r.x))).toBeCloseTo(210, 6);
  });
});

describe('등각원(ELLIPSE 등각원 I)', () => {
  it('비율 1/√3, 장축 r·√(3/2): 위 0°, 왼쪽 120°, 오른쪽 60°', () => {
    for (const [plane, ang] of [
      [1, 0],
      [0, 120],
      [2, 60],
    ] as const) {
      const e = isoCircle(4, plane);
      expect(e.ratio).toBeCloseTo(1 / Math.sqrt(3), 12);
      expect(Math.hypot(e.majorAxis.x, e.majorAxis.y)).toBeCloseTo(4 * Math.sqrt(1.5), 12);
      expect(deg(Math.atan2(e.majorAxis.y, e.majorAxis.x)) % 180).toBeCloseTo(ang, 6);
    }
  });
  it('타원은 평면의 두 축 위 r 거리의 점을 지난다(등각 정사각형에 접한다)', () => {
    for (const plane of [0, 1, 2] as const) {
      const r = 5;
      const e = isoCircle(r, plane);
      const L = Math.hypot(e.majorAxis.x, e.majorAxis.y);
      const ux = e.majorAxis.x / L;
      const uy = e.majorAxis.y / L;
      const on = (p: { x: number; y: number }) => {
        const a = p.x * ux + p.y * uy;
        const b = -p.x * uy + p.y * ux;
        return (a / L) ** 2 + (b / (L * e.ratio)) ** 2;
      };
      for (const t of [0, 0.3, 1, Math.PI / 2, 2.5, Math.PI, 4, 5.5]) expect(on(isoCirclePoint({ x: 0, y: 0 }, r, plane, t))).toBeCloseTo(1, 9);
      for (const a of isoAxes(plane)) expect(on({ x: r * Math.cos(a), y: r * Math.sin(a) })).toBeCloseTo(1, 9);
    }
  });
});

describe('등각 격자선', () => {
  it('세 방향의 선, 주 격자선은 major마다', () => {
    const g = isoGridSegments([0, 0, 100, 100], { x: 0, y: 0 }, 10, 5);
    const all = [...g.minor, ...g.major];
    expect(all.length % 4).toBe(0);
    const dirs = new Set<number>();
    for (let i = 0; i < all.length; i += 4) {
      const a = deg(Math.atan2(all[i + 3]! - all[i + 1]!, all[i + 2]! - all[i]!)) % 180;
      dirs.add(Math.round(a));
      // 사각형 안
      for (const v of all.slice(i, i + 4)) expect(v).toBeGreaterThanOrEqual(-1e-6);
      for (const v of all.slice(i, i + 4)) expect(v).toBeLessThanOrEqual(100 + 1e-6);
    }
    expect([...dirs].sort((x, y) => x - y)).toEqual([30, 90, 150]);
    expect(g.major.length).toBeGreaterThan(0);
    expect(g.minor.length).toBeGreaterThan(g.major.length);
  });
  it('너무 촘촘하면 비운다', () => {
    const g = isoGridSegments([0, 0, 1e6, 1e6], { x: 0, y: 0 }, 1, 5);
    expect(g.minor.length + g.major.length).toBe(0);
  });
});
