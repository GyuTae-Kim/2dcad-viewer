import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, LwPolylineEntity, PolylineEntity, SplineEntity, Vec2, XLineEntity } from '../../src/core/model';
import { offsetEntity } from '../../src/edit/geom/offset';
import { entityPath } from '../../src/edit/geom/path';
import { flattenPath, pathNearest, pathSize } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, arc, circle, deg, ellipse, fitSpline, line, lw, near, newDoc, poly2d, renders, spline, xline } from './helpers';
import { lwVertices } from '../../src/core/lwpoly';

const doc = newDoc();

/**
 * 간격띄우기 검사: 결과의 모든 점이 원본에서 d보다 가깝지 않고(고리 제거), 원본 조각의 운반 곡선(직선·원)이나
 * 꼭짓점에서 정확히 d만큼 떨어져 있다(OFFSETGAPTYPE 0의 연장 모서리 포함). 결과는 side 쪽에 있다.
 */
function offsetOk(orig: Entity, out: Entity, d: number, side: Vec2, tol = 1e-6): void {
  const po = entityPath(orig)!;
  const pr = entityPath(out)!;
  expect(pr).toBeTruthy();
  const t = tol * Math.max(1, d);
  const carrierDist = (q: Vec2): number => {
    let best = Infinity;
    for (const pc of po.pieces) {
      if (pc.k === 'line') {
        const dx = pc.b.x - pc.a.x;
        const dy = pc.b.y - pc.a.y;
        const l = Math.hypot(dx, dy);
        best = Math.min(best, Math.abs(Math.abs(((q.x - pc.a.x) * dy - (q.y - pc.a.y) * dx) / l) - d));
        best = Math.min(best, Math.abs(Math.hypot(q.x - pc.a.x, q.y - pc.a.y) - d), Math.abs(Math.hypot(q.x - pc.b.x, q.y - pc.b.y) - d));
      } else if (pc.k === 'arc') {
        best = Math.min(best, Math.abs(Math.abs(Math.hypot(q.x - pc.c.x, q.y - pc.c.y) - pc.r) - d));
        const a = { x: pc.c.x + pc.r * Math.cos(pc.a0), y: pc.c.y + pc.r * Math.sin(pc.a0) };
        const b = { x: pc.c.x + pc.r * Math.cos(pc.a0 + pc.sw), y: pc.c.y + pc.r * Math.sin(pc.a0 + pc.sw) };
        best = Math.min(best, Math.abs(Math.hypot(q.x - a.x, q.y - a.y) - d), Math.abs(Math.hypot(q.x - b.x, q.y - b.y) - d));
      } else best = Math.min(best, Math.abs(pathNearest(po, q).d - d));
    }
    return best;
  };
  let worstClose = 0;
  let worstCarrier = 0;
  for (const q of flattenPath(pr, pathSize(pr) * 1e-3)) {
    worstClose = Math.max(worstClose, d - pathNearest(po, q).d);
    worstCarrier = Math.max(worstCarrier, carrierDist(q));
  }
  expect(worstClose, '원본에 d보다 가까운 점').toBeLessThan(t);
  expect(worstCarrier, '운반 곡선에서 d가 아닌 점').toBeLessThan(t);
  // side 점에서 결과까지가 원본까지보다 멀지 않다(같은 쪽)
  const ns = pathNearest(po, side);
  const nr = pathNearest(pr, side);
  expect(nr.d).toBeLessThan(ns.d + d + 1e-9);
}

describe('offsetEntity — 선·구성선', () => {
  it('선은 side 쪽으로 평행 이동', () => {
    const l = line(0, 0, 10, 0);
    const a = offsetEntity(l, 2, V(5, 3)).add![0] as LineEntity;
    near(a.start, P(0, 2));
    near(a.end, P(10, 2));
    expect(a.handle).toBe('');
    const b = offsetEntity(l, 2, V(5, -1)).add![0] as LineEntity;
    near(b.start, P(0, -2));
    expect(offsetEntity(l, 0, V(0, 1)).message).toBeTruthy();
  });
  it('구성선·광선', () => {
    const x = offsetEntity(xline(0, 0, 1, 1), Math.SQRT2, V(0, 5)).add![0] as XLineEntity;
    expect(x.type).toBe('XLINE');
    near(x.base, P(-1, 1));
    const r = offsetEntity(xline(0, 0, 1, 0, true), 1, V(3, -2)).add![0] as XLineEntity;
    expect(r.type).toBe('RAY');
    near(r.base, P(0, -1));
  });
});

describe('offsetEntity — 원·호', () => {
  it('원: 바깥·안쪽, 너무 크면 안내', () => {
    const c = circle(0, 0, 5);
    expect((offsetEntity(c, 2, V(10, 0)).add![0] as CircleEntity).radius).toBeCloseTo(7);
    expect((offsetEntity(c, 2, V(1, 0)).add![0] as CircleEntity).radius).toBeCloseTo(3);
    expect(offsetEntity(c, 5, V(1, 0)).message).toBe('해당 거리로 간격띄우기할 수 없습니다.');
  });
  it('호와 −Z 호', () => {
    const a = arc(0, 0, 5, 0, 90) as ArcEntity;
    const o = offsetEntity(a, 1, V(10, 10)).add![0] as ArcEntity;
    expect(o.radius).toBeCloseTo(6);
    expect(o.startAngle).toBeCloseTo(0);
    expect(o.endAngle).toBeCloseTo(deg(90));
    const n = arc(0, 0, 5, 0, 90, NEG_Z);
    const on = offsetEntity(n, 1, V(-1, 1)).add![0] as ArcEntity;
    expect(on.extrusion).toBeUndefined();
    expect(on.radius).toBeCloseTo(4);
    expect(on.startAngle).toBeCloseTo(deg(90));
    expect(on.endAngle).toBeCloseTo(deg(180));
    offsetOk(n, on, 1, V(-1, 1));
  });
});

describe('offsetEntity — 폴리선', () => {
  it('열린 L자: 안쪽은 짧아지고 바깥쪽은 선을 늘여 만난다(OFFSETGAPTYPE 0)', () => {
    const p = lw([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const a = offsetEntity(p, 1, V(5, 5)).add![0] as LwPolylineEntity;
    expect(lwVertices(a).map((v) => [v.x, v.y])).toEqual([
      [0, 1],
      [9, 1],
      [9, 10],
    ].map(([x, y]) => [expect.closeTo(x!, 9), expect.closeTo(y!, 9)]));
    const b = offsetEntity(p, 1, V(5, -5)).add![0] as LwPolylineEntity;
    expect(lwVertices(b).map((v) => [v.x, v.y])).toEqual([
      [0, -1],
      [11, -1],
      [11, 10],
    ].map(([x, y]) => [expect.closeTo(x!, 9), expect.closeTo(y!, 9)]));
    offsetOk(p, a, 1, V(5, 5));
  });
  it('닫힌 사각형: 안쪽·바깥쪽(모서리는 날카롭게)', () => {
    const sq = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    );
    const inn = offsetEntity(sq, 1, V(5, 5)).add![0] as LwPolylineEntity;
    expect(inn.closed).toBe(true);
    expect(lwVertices(inn).length).toBe(4);
    for (const v of lwVertices(inn)) expect(Math.max(Math.abs(v.x - 5), Math.abs(v.y - 5))).toBeCloseTo(4);
    const out = offsetEntity(sq, 1, V(20, 5)).add![0] as LwPolylineEntity;
    for (const v of lwVertices(out)) expect(Math.max(Math.abs(v.x - 5), Math.abs(v.y - 5))).toBeCloseTo(6);
    // 너무 큰 안쪽 거리
    expect(offsetEntity(sq, 6, V(5, 5)).message).toBeTruthy();
  });
  it('볼록도(경기장 모양): 반원은 반지름이 바뀐 호', () => {
    const st = lw(
      [
        [0, 0],
        [10, 0, 1],
        [10, 10],
        [0, 10, 1],
      ],
      true,
    );
    const o = offsetEntity(st, 2, V(30, 5)).add![0] as LwPolylineEntity;
    expect(lwVertices(o).length).toBe(4);
    expect(lwVertices(o).filter((v) => Math.abs(Math.abs(v.bulge) - 1) < 1e-9).length).toBe(2);
    offsetOk(st, o, 2, V(30, 5));
    const i = offsetEntity(st, 2, V(5, 5)).add![0] as LwPolylineEntity;
    offsetOk(st, i, 2, V(5, 5));
    renders(doc, [o, i]);
  });
  it('작은 호가 사라지는 안쪽 간격띄우기', () => {
    // 꼭짓점 모깎기 반지름 0.5인 사각형을 안쪽으로 1: 모깎기 호가 사라지고 모서리가 날카로워진다
    const k = Math.tan(Math.PI / 8);
    const p = lw(
      [
        [0.5, 0],
        [9.5, 0, k],
        [10, 0.5],
        [10, 9.5, k],
        [9.5, 10],
        [0.5, 10, k],
        [0, 9.5],
        [0, 0.5, k],
      ],
      true,
    );
    const o = offsetEntity(p, 1, V(5, 5)).add![0] as LwPolylineEntity;
    expect(lwVertices(o).every((v) => Math.abs(v.bulge) < 1e-9)).toBe(true);
    offsetOk(p, o, 1, V(5, 5));
  });
  it('2D POLYLINE은 POLYLINE으로, −Z 폴리선은 자연스러운 결과', () => {
    const p = poly2d([[0, 0, 0.3], [5, 1], [8, 6, -0.4], [2, 9]]);
    const o = offsetEntity(p, 0.5, V(4, 3)).add![0] as PolylineEntity;
    expect(o.type).toBe('POLYLINE');
    offsetOk(p, o, 0.5, V(4, 3));
    const n = lw([[0, 0], [10, 0, 0.5], [10, 10], [5, 12]], false, NEG_Z);
    const on = offsetEntity(n, 1, V(-5, 5)).add![0] as LwPolylineEntity;
    expect(on.extrusion).toBeUndefined();
    offsetOk(n, on, 1, V(-5, 5));
    renders(doc, [o, on]);
  });
  it('폭 있는 폴리선은 폭을 잇는다', () => {
    const p = lw([[0, 0], [10, 0], [10, 10]], false, undefined, 0.4);
    const o = offsetEntity(p, 1, V(5, 5)).add![0] as LwPolylineEntity;
    expect(o.constantWidth).toBeCloseTo(0.4);
  });
  it('자기 교차 고리는 잘라 낸다(좁은 U자 안쪽)', () => {
    const u = lw([
      [0, 10],
      [0, 0],
      [3, 0],
      [3, 10],
    ]);
    const r = offsetEntity(u, 2, V(1.5, 5));
    // 폭 3인 U자 안쪽 2: 두 다리 사이가 겹쳐 고리가 없어진다 — 원본에서 거리 2 이상인 부분만 남는다
    for (const e of r.add ?? []) offsetOk(u, e, 2, V(1.5, 5));
  });
});

describe('offsetEntity — 타원·스플라인(SPLINE 근사)', () => {
  it('타원 바깥·안쪽, 타원호', () => {
    const el = ellipse(0, 0, 6, 0, 0.5);
    for (const side of [V(10, 0), V(0, 0)]) {
      const r = offsetEntity(el, 0.8, side);
      const s = r.add![0] as SplineEntity;
      expect(s.type).toBe('SPLINE');
      offsetOk(el, s, 0.8, side, 1e-4);
    }
    const ea = ellipse(0, 0, 6, 0, 0.5, 0.3, 2.5);
    const o = offsetEntity(ea, 0.5, V(0, 10)).add![0] as SplineEntity;
    offsetOk(ea, o, 0.5, V(0, 10), 1e-4);
    renders(doc, [o]);
  });
  it('스플라인(조정점·맞춤점)', () => {
    const s = spline([
      [0, 0],
      [3, 5],
      [7, -2],
      [10, 4],
      [14, 0],
    ]);
    const o = offsetEntity(s, 0.3, V(3, 5)).add![0] as SplineEntity;
    offsetOk(s, o, 0.3, V(3, 5), 1e-4);
    const f = fitSpline([
      [0, 0],
      [3, 4],
      [7, 1],
      [10, 6],
    ]);
    const of = offsetEntity(f, 0.5, V(5, 0)).add![0] as SplineEntity;
    offsetOk(f, of, 0.5, V(5, 0), 1e-4);
    renders(doc, [o, of]);
  });
  it('간격띄울 수 없는 객체', () => {
    expect(offsetEntity({ ...line(0, 0, 1, 1), type: 'POINT', position: P(0, 0), angle: 0 } as Entity, 1, V(1, 1)).message).toBe('해당 객체를 간격띄우기할 수 없습니다.');
  });
});

describe('offsetEntity — 속성 시험: 여러 모양 × 거리 × 쪽', () => {
  const shapes: [string, Entity][] = [
    ['선', line(0, 0, 7, 3)],
    ['호', arc(1, 1, 4, 20, 250)],
    ['−Z 원', circle(2, 2, 3, NEG_Z)],
    ['열린 폴리선', lw([[0, 0], [5, 0, 0.4], [8, 4], [3, 7, -0.6], [0, 5]])],
    ['닫힌 폴리선', lw([[0, 0], [6, 0, 0.3], [8, 5], [2, 7]], true)],
    ['2D 폴리선', poly2d([[0, 0], [4, 2, -0.5], [9, 1]])],
  ];
  for (const [name, e] of shapes)
    for (const d of [0.25, 0.7])
      for (const side of [V(20, 20), V(3, 2.5)])
        it(`${name} d=${d} side=(${side.x}, ${side.y})`, () => {
          const r = offsetEntity(e, d, side);
          if (r.message) return; // 안쪽이 사라지는 경우
          for (const o of r.add ?? []) offsetOk(e, o, d, side);
        });
});
