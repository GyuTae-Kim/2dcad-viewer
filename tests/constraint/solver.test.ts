import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, EllipseEntity, LwPolylineEntity, SplineEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { prepareGeo } from '../../src/edit/constraint/make';
import { addConstraints } from '../../src/edit/constraint/system';
import type { GeoConstraint, GeoType } from '../../src/edit/constraint/types';
import { L, apply, arc, circle, line, lwpoly, put, setup, store } from './helpers';

const geo = (type: GeoType, refs: [string, string][], extra: Partial<GeoConstraint> = {}): GeoConstraint => ({ id: 0, kind: 'geo', type, refs: refs.map(([h, part]) => ({ h, part })), ...extra });

/** 구속을 하나 더하고 적용한다(성공해야 한다) */
function addOk(doc: ReturnType<typeof setup>['doc'], s: ReturnType<typeof setup>['s'], c: GeoConstraint, order?: string[]) {
  const r = addConstraints(doc, store(doc), [prepareGeo(doc, c)], { order });
  expect(r.message ?? 'ok').toBe('ok');
  expect(r.ok).toBe(true);
  apply(doc, s, r);
  return r;
}

const ang = (l: { start: { x: number; y: number }; end: { x: number; y: number } }) => Math.atan2(l.end.y - l.start.y, l.end.x - l.start.x);
const llen = (l: { start: { x: number; y: number }; end: { x: number; y: number } }) => Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y);

describe('기하 구속 풀기', () => {
  it('평행: 두 번째 선이 첫 번째 선에 맞춰 돌고, 첫 번째 선은 그대로', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 0, 50, 80, 90);
    put(doc, a, b);
    addOk(doc, s, geo('PARALLEL', [[a.handle, ''], [b.handle, '']]), [a.handle, b.handle]);
    const A = L(doc, a.handle);
    const B = L(doc, b.handle);
    expect(A.end.y).toBe(0);
    expect(A.start.y).toBe(0);
    expect(B.end.y - B.start.y).toBeCloseTo(0, 7);
    expect(llen(B)).toBeGreaterThan(10);
    expect(store(doc).constraints).toHaveLength(1);
  });

  it('직교·수평·수직(UCS 축 포함)', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 3);
    const b = line(h(), 100, 3, 104, 60);
    const c = line(h(), 0, 0, 30, 31);
    put(doc, a, b, c);
    addOk(doc, s, geo('HORIZONTAL', [[a.handle, '']]));
    expect(ang(L(doc, a.handle))).toBeCloseTo(0, 8);
    addOk(doc, s, geo('PERPENDICULAR', [[a.handle, ''], [b.handle, '']]), [a.handle, b.handle]);
    expect(Math.abs(ang(L(doc, b.handle)))).toBeCloseTo(Math.PI / 2, 8);
    // 30° 돌린 UCS의 수평
    addOk(doc, s, geo('HORIZONTAL', [[c.handle, '']], { axis: Math.PI / 6 }));
    expect(ang(L(doc, c.handle))).toBeCloseTo(Math.PI / 6, 8);
  });

  it('수평 둘에 평행을 더하면 과도한 구속', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 5);
    const b = line(h(), 0, 50, 80, 60);
    put(doc, a, b);
    const r = addConstraints(doc, store(doc), [geo('HORIZONTAL', [[a.handle, '']]), geo('HORIZONTAL', [[b.handle, '']])]);
    expect(r.ok).toBe(true);
    apply(doc, s, r);
    const r2 = addConstraints(doc, store(doc), [geo('PARALLEL', [[a.handle, ''], [b.handle, '']])]);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('overconstrained');
    // 같은 구속을 두 번 걸어도 과도한 구속
    expect(addConstraints(doc, store(doc), [geo('HORIZONTAL', [[a.handle, '']])]).reason).toBe('overconstrained');
  });

  it('일치: 점과 점, 점과 선(연장), 점과 원', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 103, 4, 150, 40);
    const c = line(h(), 30, 7, 40, 30);
    const k = circle(h(), 200, 0, 20);
    const d = line(h(), 230, 5, 260, 40);
    put(doc, a, b, c, k, d);
    addOk(doc, s, geo('COINCIDENT', [[a.handle, 'E'], [b.handle, 'S']]), [a.handle, b.handle]);
    expect(L(doc, b.handle).start.x).toBeCloseTo(100, 8);
    expect(L(doc, b.handle).start.y).toBeCloseTo(0, 8);
    addOk(doc, s, geo('COINCIDENT', [[c.handle, 'S'], [a.handle, '']]), [a.handle, c.handle]);
    expect(L(doc, c.handle).start.y).toBeCloseTo(0, 8);
    addOk(doc, s, geo('COINCIDENT', [[d.handle, 'S'], [k.handle, '']]), [k.handle, d.handle]);
    const D = L(doc, d.handle);
    expect(Math.hypot(D.start.x - 200, D.start.y)).toBeCloseTo(20, 8);
  });

  it('동일선상·동심·같음', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 120, 5, 180, 9);
    const c1 = circle(h(), 0, 100, 10);
    const c2 = arc(h(), 3, 104, 25, 0, Math.PI);
    const c3 = circle(h(), 100, 100, 5);
    put(doc, a, b, c1, c2, c3);
    addOk(doc, s, geo('COLLINEAR', [[a.handle, ''], [b.handle, '']]), [a.handle, b.handle]);
    const B = L(doc, b.handle);
    expect(B.start.y).toBeCloseTo(0, 8);
    expect(B.end.y).toBeCloseTo(0, 8);
    addOk(doc, s, geo('CONCENTRIC', [[c1.handle, ''], [c2.handle, '']]), [c1.handle, c2.handle]);
    const C2 = doc.entityIndex.get(c2.handle) as ArcEntity;
    expect(C2.center.x).toBeCloseTo(0, 8);
    expect(C2.center.y).toBeCloseTo(100, 8);
    addOk(doc, s, geo('EQUAL', [[c1.handle, ''], [c3.handle, '']]), [c1.handle, c3.handle]);
    expect((doc.entityIndex.get(c3.handle) as CircleEntity).radius).toBeCloseTo(10, 8);
    addOk(doc, s, geo('EQUAL', [[a.handle, ''], [b.handle, '']]), [a.handle, b.handle]);
    expect(llen(L(doc, b.handle))).toBeCloseTo(100, 7);
  });

  it('접선: 선–원(쪽 유지), 원–원 외접·내접, 선–타원', () => {
    const { doc, s, h } = setup();
    const c = circle(h(), 0, 0, 10);
    const a = line(h(), -20, 12, 20, 13);
    const k1 = circle(h(), 100, 0, 10);
    const k2 = circle(h(), 125, 3, 12);
    const k3 = circle(h(), 200, 0, 30);
    const k4 = circle(h(), 205, 0, 20);
    const el: EllipseEntity = { ...entityDefaults(), handle: h(), type: 'ELLIPSE', center: { x: 0, y: 200, z: 0 }, majorAxis: { x: 40, y: 0, z: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI * 2 };
    const t = line(h(), -50, 223, 50, 225);
    put(doc, c, a, k1, k2, k3, k4, el, t);
    addOk(doc, s, geo('TANGENT', [[c.handle, ''], [a.handle, '']]), [c.handle, a.handle]);
    const A = L(doc, a.handle);
    const C = doc.entityIndex.get(c.handle) as CircleEntity;
    expect(C.center.x).toBe(0);
    const dist = ((A.end.x - A.start.x) * (C.center.y - A.start.y) - (A.end.y - A.start.y) * (C.center.x - A.start.x)) / llen(A);
    expect(Math.abs(dist)).toBeCloseTo(10, 7);
    expect(A.start.y).toBeGreaterThan(5); // 위쪽에 머문다
    addOk(doc, s, geo('TANGENT', [[k1.handle, ''], [k2.handle, '']]), [k1.handle, k2.handle]);
    const K2 = doc.entityIndex.get(k2.handle) as CircleEntity;
    expect(Math.hypot(K2.center.x - 100, K2.center.y)).toBeCloseTo(10 + K2.radius, 7);
    addOk(doc, s, geo('TANGENT', [[k3.handle, ''], [k4.handle, '']]), [k3.handle, k4.handle]);
    const K4 = doc.entityIndex.get(k4.handle) as CircleEntity;
    expect(Math.hypot(K4.center.x - 200, K4.center.y)).toBeCloseTo(30 - K4.radius, 7);
    addOk(doc, s, geo('TANGENT', [[el.handle, ''], [t.handle, '']]), [el.handle, t.handle]);
    const T = L(doc, t.handle);
    // 수평이 아니어도: 타원 지지 거리와 같다
    const dn = { x: (T.end.x - T.start.x) / llen(T), y: (T.end.y - T.start.y) / llen(T) };
    const n = { x: -dn.y, y: dn.x };
    const sd = n.x * (0 - T.start.x) + n.y * (200 - T.start.y);
    expect(Math.abs(sd)).toBeCloseTo(Math.hypot(40 * n.x, 20 * n.y), 6);
  });

  it('고정: 고정한 점은 움직이지 않고 다른 객체가 맞춘다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 10);
    const b = line(h(), 110, 5, 150, 50);
    put(doc, a, b);
    addOk(doc, s, geo('FIX', [[a.handle, 'E']]));
    // 두 번째로 고른 a의 끝점이 움직여야 하지만 고정이라 b가 움직인다
    addOk(doc, s, geo('COINCIDENT', [[b.handle, 'S'], [a.handle, 'E']]), [b.handle, a.handle]);
    expect(L(doc, a.handle).end.x).toBeCloseTo(100, 9);
    expect(L(doc, a.handle).end.y).toBeCloseTo(10, 9);
    expect(L(doc, b.handle).start.x).toBeCloseTo(100, 8);
    // 두 끝을 모두 고정한 선에 수평은 과도한 구속, 이미 고정한 끝을 또 고정해도 과도한 구속
    expect(addConstraints(doc, store(doc), [geo('FIX', [[a.handle, '']])]).reason).toBe('overconstrained');
    addOk(doc, s, geo('FIX', [[a.handle, 'S']]));
    expect(addConstraints(doc, store(doc), [geo('HORIZONTAL', [[a.handle, '']])]).reason).toBe('overconstrained');
  });

  it('대칭: 점, 선, 원', () => {
    const { doc, s, h } = setup();
    const ax = line(h(), 0, -100, 0, 100);
    const p = line(h(), -30, 10, -10, 40);
    const q = line(h(), 25, 12, 15, 30);
    const c1 = circle(h(), -50, -50, 8);
    const c2 = circle(h(), 47, -55, 11);
    put(doc, ax, p, q, c1, c2);
    addOk(doc, s, geo('SYMMETRIC', [[p.handle, 'S'], [q.handle, 'S'], [ax.handle, '']]), [p.handle, ax.handle, q.handle]);
    expect(L(doc, q.handle).start.x).toBeCloseTo(30, 7);
    expect(L(doc, q.handle).start.y).toBeCloseTo(10, 7);
    addOk(doc, s, geo('SYMMETRIC', [[c1.handle, ''], [c2.handle, ''], [ax.handle, '']]), [c1.handle, ax.handle, c2.handle]);
    const C2 = doc.entityIndex.get(c2.handle) as CircleEntity;
    expect(C2.center.x).toBeCloseTo(50, 7);
    expect(C2.center.y).toBeCloseTo(-50, 7);
    expect(C2.radius).toBeCloseTo(8, 7);
    const l1 = line(h(), -60, 0, -20, 30);
    const l2 = line(h(), 70, 5, 25, 25);
    put(doc, l1, l2);
    addOk(doc, s, geo('SYMMETRIC', [[l1.handle, ''], [l2.handle, ''], [ax.handle, '']]), [l1.handle, ax.handle, l2.handle]);
    const L2 = L(doc, l2.handle);
    // l2는 l1의 거울상 직선 위
    const m = (x: number, y: number) => ({ x: -x, y });
    const a1 = m(-60, 0);
    const b1 = m(-20, 30);
    const cr = (px: number, py: number) => ((b1.x - a1.x) * (py - a1.y) - (b1.y - a1.y) * (px - a1.x)) / Math.hypot(b1.x - a1.x, b1.y - a1.y);
    expect(cr(L2.start.x, L2.start.y)).toBeCloseTo(0, 6);
    expect(cr(L2.end.x, L2.end.y)).toBeCloseTo(0, 6);
  });

  it('폴리선 세그먼트·정점과 호 세그먼트', () => {
    const { doc, s, h } = setup();
    const pl = lwpoly(h(), [
      [0, 0],
      [100, 2],
      [100, 50, 0.4],
      [0, 50],
    ]);
    const a = line(h(), 0, 80, 60, 95);
    put(doc, pl, a);
    addOk(doc, s, geo('HORIZONTAL', [[pl.handle, 'G0']]));
    addOk(doc, s, geo('PARALLEL', [[pl.handle, 'G0'], [a.handle, '']]), [pl.handle, a.handle]);
    expect(L(doc, a.handle).end.y - L(doc, a.handle).start.y).toBeCloseTo(0, 7);
    const P = doc.entityIndex.get(pl.handle) as LwPolylineEntity;
    expect(P.vertices[1]!.y - P.vertices[0]!.y).toBeCloseTo(0, 8);
    expect(P.vertices[2]!.bulge).toBeCloseTo(0.4, 9);
    // 정점과 선 끝 일치
    addOk(doc, s, geo('COINCIDENT', [[pl.handle, 'V3'], [a.handle, 'S']]), [pl.handle, a.handle]);
    expect(L(doc, a.handle).start.y).toBeCloseTo(50, 7);
  });

  it('부드럽게: 스플라인 끝이 선 끝에 G1·곡률 0으로 이어진다', () => {
    const { doc, s, h } = setup();
    const sp: SplineEntity = {
      ...entityDefaults(),
      handle: h(),
      type: 'SPLINE',
      flags: 8,
      degree: 3,
      knots: [0, 0, 0, 0, 1, 1, 1, 1],
      controlPoints: [
        { x: 102, y: 5, z: 0 },
        { x: 130, y: 30, z: 0 },
        { x: 160, y: -10, z: 0 },
        { x: 190, y: 20, z: 0 },
      ],
      fitPoints: [],
      knotTolerance: 1e-10,
      controlTolerance: 1e-10,
      fitTolerance: 1e-10,
    };
    const a = line(h(), 0, 0, 100, 0);
    put(doc, sp, a);
    addOk(doc, s, geo('SMOOTH', [[sp.handle, 'S'], [a.handle, 'E']]), [a.handle, sp.handle]);
    expect(L(doc, a.handle).end.x).toBe(100);
    const S = doc.entityIndex.get(sp.handle) as SplineEntity;
    const A = L(doc, a.handle);
    expect(S.controlPoints[0]!.x).toBeCloseTo(A.end.x, 7);
    expect(S.controlPoints[0]!.y).toBeCloseTo(A.end.y, 7);
    // 접선이 같은 방향, 셋째 조정점도 선 방향 위
    const t1 = Math.atan2(S.controlPoints[1]!.y - S.controlPoints[0]!.y, S.controlPoints[1]!.x - S.controlPoints[0]!.x);
    expect(t1).toBeCloseTo(ang(A), 6);
    const t2 = Math.atan2(S.controlPoints[2]!.y - S.controlPoints[1]!.y, S.controlPoints[2]!.x - S.controlPoints[1]!.x);
    expect(t2).toBeCloseTo(ang(A), 6);
  });

  it('지원하지 않는 객체·조합은 까닭을 알린다', () => {
    const { doc, h } = setup();
    const c = circle(h(), 0, 0, 5);
    const k = circle(h(), 20, 0, 5);
    put(doc, c, k);
    const r = addConstraints(doc, store(doc), [geo('PARALLEL', [[c.handle, ''], [k.handle, '']])]);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('선이 필요합니다.');
  });
});
