import { describe, expect, it } from 'vitest';
import type { SplineEntity, Vec3 } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { flattenPath, pathNearest } from '../../src/edit/geom/curve';
import { entityPath } from '../../src/edit/geom/path';
import { closeSpline, cvAdd, cvCount, cvMove, cvWeight, fitAdd, fitDelete, fitMove, isPeriodicForm, openSpline, purgeFit, refit } from '../../src/edit/geom/splinedit';
import { V, near, newDoc, renders } from '../edit/helpers';

const doc = newDoc();
const P3 = (x: number, y: number): Vec3 => ({ x, y, z: 0 });

function fitSpline(pts: [number, number][]): SplineEntity {
  return refit({
    type: 'SPLINE',
    ...entityDefaults(),
    handle: 'S1',
    flags: 8,
    degree: 3,
    knots: [],
    controlPoints: [],
    fitPoints: pts.map(([x, y]) => P3(x, y)),
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
  });
}

function cvSpline(): SplineEntity {
  return {
    type: 'SPLINE',
    ...entityDefaults(),
    handle: 'S2',
    flags: 8,
    degree: 3,
    knots: [0, 0, 0, 0, 1, 2, 2, 2, 2],
    controlPoints: [P3(0, 0), P3(5, 10), P3(10, -5), P3(15, 5), P3(20, 0)],
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
  };
}

function passes(e: SplineEntity, pts: Vec3[], tol = 1e-7) {
  const p = entityPath(e)!;
  for (const q of pts) expect(pathNearest(p, q).d).toBeLessThan(tol);
}

describe('SPLINEDIT 맞춤 데이터', () => {
  const pts: [number, number][] = [
    [0, 0],
    [10, 8],
    [20, 0],
    [30, 6],
  ];
  it('추가·이동·삭제하면 곡선이 새 맞춤점을 지난다', () => {
    const s = fitSpline(pts);
    passes(s, s.fitPoints);
    const a = fitAdd(s, 1, V(15, 10))!;
    expect(a.fitPoints.length).toBe(5);
    passes(a, a.fitPoints);
    const m = fitMove(a, 2, V(15, 20))!;
    passes(m, m.fitPoints);
    const d = fitDelete(m, 2)!;
    expect(d.fitPoints.length).toBe(4);
    passes(d, d.fitPoints);
    expect(fitDelete(fitSpline([[0, 0], [1, 1]]), 0)).toBeNull();
  });
  it('닫기: 맞춤점을 지나는 주기 곡선, 열기: 열린 곡선', () => {
    const s = fitSpline(pts);
    const c = closeSpline(s)!;
    expect(c.flags & 3).toBe(3);
    const path = entityPath(c)!;
    expect(path.closed).toBe(true);
    passes(c, c.fitPoints);
    renders(doc, [c]);
    const o = openSpline(c)!;
    expect(o.flags & 1).toBe(0);
    passes(o, o.fitPoints);
  });
  it('소거: 같은 곡선의 조정점 정의', () => {
    const s = fitSpline(pts);
    const p = purgeFit(s);
    expect(p.fitPoints.length).toBe(0);
    passes(p, s.fitPoints);
  });
});

describe('SPLINEDIT 정점', () => {
  it('닫기: 주기 형태(정점 + 차수 개 반복, 매듭 0…n+2p)', () => {
    const c = closeSpline(cvSpline())!;
    expect(isPeriodicForm(c)).toBe(true);
    expect(c.controlPoints.length).toBe(8);
    expect(c.knots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(cvCount(c)).toBe(5);
    expect(entityPath(c)!.closed).toBe(true);
    renders(doc, [c]);
    // 주기 정점 이동은 반복도 함께
    const m = cvMove(c, 0, V(-5, -5))!;
    near(m.controlPoints[5]!, V(-5, -5));
    const o = openSpline(c)!;
    expect(o.controlPoints.length).toBe(5);
    expect(o.flags & 3).toBe(0);
  });
  it('이동·가중치', () => {
    const s = cvSpline();
    const m = cvMove(s, 2, V(10, 20))!;
    near(m.controlPoints[2]!, V(10, 20));
    const w = cvWeight(s, 1, 3)!;
    expect(w.flags & 4).toBe(4);
    expect(w.weights).toEqual([1, 3, 1, 1, 1]);
    // 맞춤점 스플라인의 정점을 고치면 조정점 정의
    const f = cvMove(fitSpline([[0, 0], [5, 5], [10, 0]]), 1, V(5, 9))!;
    expect(f.fitPoints.length).toBe(0);
  });
  it('추가: 모양은 그대로, 정점 +1', () => {
    const s = cvSpline();
    const a = cvAdd(s, V(10, 2))!;
    expect(a.controlPoints.length).toBe(6);
    const pa = entityPath(a)!;
    for (const q of flattenPath(entityPath(s)!, 1e-3)) expect(pathNearest(pa, q).d).toBeLessThan(1e-6);
  });
});
