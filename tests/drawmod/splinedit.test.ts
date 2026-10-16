/**
 * SPLINEDIT: 정점 삭제(D)·순서 올리기(E), 맞춤 데이터 꼬임(K).
 */
import { describe, expect, it } from 'vitest';
import type { SplineEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { cvDelete, elevateOrder, fitKink } from '../../src/edit/geom/splinedit';
import { makeFitSpline } from '../../src/edit/geom/drawgeom';
import { domain, nurbsPoint } from '../../src/edit/geom/nurbs';
import { splineNurbs } from '../../src/edit/geom/path';
import { spline } from '../edit/make';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('SPLINEDIT 정점·맞춤 데이터', () => {
  it('정점 삭제: 조정점 하나를 빼고 고정 균일 매듭으로', () => {
    const s = spline([[0, 0], [2, 3], [4, 0], [6, 3], [8, 0]]) as SplineEntity;
    const r = cvDelete(s, 2)!;
    expect(r.controlPoints.length).toBe(4);
    expect(r.knots.length).toBe(4 + r.degree + 1);
    expect(cvDelete(spline([[0, 0], [1, 1]]) as SplineEntity, 0)).toBeNull();
  });

  it('순서 올리기: 모양은 그대로, 차수가 오른다', () => {
    const s = spline([[0, 0], [2, 3], [4, 0], [6, 3], [8, 0]]) as SplineEntity;
    const r = elevateOrder(s, 5)!;
    expect(r.degree).toBe(4);
    const a = splineNurbs(s)!;
    const b = splineNurbs(r)!;
    const [a0, a1] = domain(a);
    const [b0, b1] = domain(b);
    for (const t of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
      const p = nurbsPoint(a, a0 + (a1 - a0) * t);
      const q = nurbsPoint(b, b0 + (b1 - b0) * t);
      close(p.x, q.x, 1e-6);
      close(p.y, q.y, 1e-6);
    }
    expect(elevateOrder(s, 3)).toBeNull();
  });

  it('꼬임: 그 점을 지나고 접선이 끊긴다(안쪽 매듭 다중도 = 차수)', () => {
    const { handle: _h, ...base } = entityDefaults();
    void _h;
    const s = makeFitSpline(base, [
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 5, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 15, y: 5, z: 0 },
    ])!;
    const r = fitKink(s, { x: 7.5, y: 3 })!;
    expect(r).toBeTruthy();
    expect(r.fitPoints.length).toBe(0);
    const inner = r.knots.filter((k) => k > r.knots[0]! && k < r.knots[r.knots.length - 1]!);
    const counts = new Map<number, number>();
    for (const k of inner) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(r.degree);
  });
});
