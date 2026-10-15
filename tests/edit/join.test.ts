import { describe, expect, it } from 'vitest';
import type { ArcEntity, EllipseEntity, Entity, LineEntity, LwPolylineEntity, PolylineEntity, SplineEntity } from '../../src/core/model';
import { joinEntities } from '../../src/edit/geom/join';
import { entityPath } from '../../src/edit/geom/path';
import { flattenPath, pathNearest } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, arc, circle, deg, ellipse, line, lw, near, newDoc, poly2d, renders, spline } from './helpers';
import { lwVertices } from '../../src/core/lwpoly';

const doc = newDoc();

/** 결과가 원본들 위를 지나고 원본들을 모두 덮는지 */
function covers(srcs: Entity[], out: Entity): void {
  const po = entityPath(out)!;
  for (const s of srcs) for (const q of flattenPath(entityPath(s)!, 1e-3)) expect(pathNearest(po, q).d).toBeLessThan(1e-7);
}

describe('joinEntities', () => {
  it('같은 직선 위의 선(틈이 있어도) → 첫 선', () => {
    const a = line(0, 0, 3, 0);
    const b = line(5, 0, 10, 0);
    const c = line(-4, 0, -2, 0);
    const r = joinEntities([a, b, c]);
    const o = r.replace![0] as LineEntity;
    expect(o.handle).toBe(a.handle);
    near(o.start, P(-4, 0));
    near(o.end, P(10, 0));
    expect(r.remove!.sort()).toEqual([b.handle, c.handle].sort());
    expect(r.message).toMatch(/3개 객체/);
  });
  it('같은 원 위의 호: 원본 호부터 반시계, 한 바퀴면 원', () => {
    const a = arc(0, 0, 5, 0, 30);
    const b = arc(0, 0, 5, 90, 120);
    const r = joinEntities([a, b]);
    const o = r.replace![0] as ArcEntity;
    expect(o.startAngle).toBeCloseTo(0);
    expect(o.endAngle).toBeCloseTo(deg(120));
    // 원본이 뒤의 호이면 반시계로 돌아 첫 호의 끝까지
    const r2 = joinEntities([b, a]);
    const o2 = r2.replace![0] as ArcEntity;
    expect(o2.startAngle).toBeCloseTo(deg(90));
    expect(o2.endAngle).toBeCloseTo(deg(30));
    const full = joinEntities([arc(0, 0, 5, 0, 180), arc(0, 0, 5, 180, 360)]);
    expect(full.add![0]!.type).toBe('CIRCLE');
    // −Z 호도 WCS에서 같은 원이면
    const n = joinEntities([arc(0, 0, 5, 0, 90), arc(0, 0, 5, 0, 90, NEG_Z)]);
    const on = n.replace![0] as ArcEntity;
    expect(on.startAngle).toBeCloseTo(0);
    expect(on.endAngle).toBeCloseTo(Math.PI);
  });
  it('같은 타원 위의 타원형 호', () => {
    const a = ellipse(0, 0, 4, 0, 0.5, 0, 1);
    const b = ellipse(0, 0, 4, 0, 0.5, 2, 3);
    const o = joinEntities([a, b]).replace![0] as EllipseEntity;
    expect(o.startParam).toBeCloseTo(0);
    expect(o.endParam).toBeCloseTo(3);
  });
  it('끝과 끝이 닿는 선·호 → LWPOLYLINE(닫히면 닫힌 폴리선)', () => {
    const a = line(0, 0, 10, 0);
    const b = arc(10, 5, 5, -90, 90);
    const c = line(10, 10, 0, 10);
    const d = line(0, 0, 0, 10);
    const r = joinEntities([a, b, c, d]);
    expect(r.add!.length).toBe(1);
    const o = r.add![0] as LwPolylineEntity;
    expect(o.type).toBe('LWPOLYLINE');
    expect(o.closed).toBe(true);
    expect(lwVertices(o).length).toBe(4);
    expect(lwVertices(o).filter((v) => Math.abs(Math.abs(v.bulge) - 1) < 1e-9).length).toBe(1);
    expect(r.remove!.length).toBe(4);
    covers([a, b, c, d], o);
    renders(doc, [o]);
  });
  it('뒤집힌 방향·폴리선 원본은 핸들 유지, 폭 하나인 폴리선은 그 폭', () => {
    const p = lw(
      [
        [0, 0],
        [5, 0],
      ],
      false,
      undefined,
      0.5,
    );
    const l1 = line(8, 3, 5, 0);
    const l2 = line(-3, 2, 0, 0);
    const r = joinEntities([p, l1, l2]);
    const o = r.replace![0] as LwPolylineEntity;
    expect(o.handle).toBe(p.handle);
    expect(lwVertices(o).length).toBe(4);
    expect(o.constantWidth).toBeCloseTo(0.5);
    covers([p, l1, l2], o);
  });
  it('2D POLYLINE 원본은 2D POLYLINE, 높이가 다르면 3D 폴리선', () => {
    const p = poly2d([
      [0, 0],
      [5, 0],
    ]);
    const r = joinEntities([p, line(5, 0, 5, 5)]);
    expect((r.replace![0] as PolylineEntity).kind).toBe('2d');
    const r3 = joinEntities([line(0, 0, 5, 0), { ...line(5, 0, 5, 5), start: P(5, 0, 0), end: P(5, 5, 3) } as Entity]);
    const p3 = r3.add![0] as PolylineEntity;
    expect(p3.kind).toBe('3d');
    expect(p3.vertices.at(-1)!.location.z).toBe(3);
  });
  it('스플라인이 끼면 SPLINE', () => {
    const s = spline([
      [0, 0],
      [2, 3],
      [4, 0],
    ]);
    const l = line(4, 0, 8, 0);
    const r = joinEntities([s, l]);
    const o = r.replace![0] as SplineEntity;
    expect(o.handle).toBe(s.handle);
    covers([s, l], o);
    renders(doc, [o]);
  });
  it('결합할 수 없으면 안내(원·떨어진 객체)', () => {
    expect(joinEntities([circle(0, 0, 1), line(0, 0, 1, 1)]).message).toBe('결합할 수 있는 객체가 없습니다.');
    expect(joinEntities([line(0, 0, 1, 1), line(5, 5, 6, 7)]).message).toBe('결합할 수 있는 객체가 없습니다.');
    expect(joinEntities([line(0, 0, 1, 0)]).message).toBeTruthy();
  });
  it('여러 사슬', () => {
    const r = joinEntities([line(0, 0, 1, 0), line(1, 0, 1, 1), line(10, 0, 11, 0), line(11, 0, 11, 1)]);
    expect(r.add!.length).toBe(2);
    expect(r.message).toMatch(/2개 객체로/);
  });
  it('폴리선 끝에 호 잇기', () => {
    const p = lw([
      [0, 0],
      [5, 0],
    ]);
    const a = arc(5, 2, 2, -90, 0);
    const r = joinEntities([p, a]);
    const o = r.replace![0] as LwPolylineEntity;
    expect(lwVertices(o)[1]!.bulge).toBeCloseTo(Math.tan(Math.PI / 8));
    near(lwVertices(o)[2]!, V(7, 2));
  });
});
