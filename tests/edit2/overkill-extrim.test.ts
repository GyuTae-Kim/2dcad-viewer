import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, LwPolylineEntity } from '../../src/core/model';
import { detectBoundary } from '../../src/edit/hatch';
import { boundaryObjects } from '../../src/edit/geom/bpoly';
import { extrim } from '../../src/edit/geom/extrim';
import { overkill } from '../../src/edit/geom/overkill';
import { entityDefaults } from '../../src/core/model';
import { entityPath } from '../../src/edit/geom/path';
import { pathLength } from '../../src/edit/geom/curve';
import { P, V, arc, circle, deg, line, lw, near, newDoc, renders } from '../edit/helpers';
import { lwVertices } from '../../src/core/lwpoly';

const doc = newDoc();

describe('OVERKILL', () => {
  it('같은 선(방향이 반대여도)은 먼저 고른 것만 남는다', () => {
    const a = line(0, 0, 10, 0);
    const b = line(10, 0, 0, 0);
    const c = line(0, 0, 10, 0.0000001);
    const r = overkill([a, b, c]);
    expect(r.duplicates).toBe(2);
    expect(r.result.remove!.sort()).toEqual([b.handle, c.handle].sort());
  });
  it('특성이 다르면 중복이 아니다(무시하면 중복)', () => {
    const a = line(0, 0, 10, 0);
    const b = { ...line(0, 0, 10, 0), layer: 'A' };
    expect(overkill([a, b]).duplicates).toBe(0);
    expect(overkill([a, b], { ignore: ['layer'] }).duplicates).toBe(1);
  });
  it('같은 직선 위: 덮인 선은 지우고, 겹치거나 닿는 선은 먼저 고른 선으로 합친다', () => {
    const a = line(0, 0, 10, 0);
    const b = line(2, 0, 5, 0); // 덮임
    const c = line(8, 0, 15, 0); // 겹침
    const d = line(15, 0, 20, 0); // 끝과 끝
    const e = line(30, 0, 40, 0); // 떨어짐
    const r = overkill([a, b, c, d, e]);
    expect(r.overlaps).toBe(3);
    const ra = r.result.replace!.find((x) => x.handle === a.handle) as LineEntity;
    near(ra.start, V(0, 0));
    near(ra.end, V(20, 0));
    expect(r.result.remove!.sort()).toEqual([b.handle, c.handle, d.handle].sort());
    // 끝과 끝 결합을 끄면 d는 남는다
    const r2 = overkill([a, b, c, d], { combineEndToEnd: false });
    expect(r2.result.remove!.includes(d.handle)).toBe(false);
    // 겹침 결합도 끄면 덮인 것만
    const r3 = overkill([a, b, c, d], { combineEndToEnd: false, combineOverlap: false });
    expect(r3.result.remove).toEqual([b.handle]);
  });
  it('폴리선 직선 세그먼트 위의 선은 지운다', () => {
    const p = lw([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const a = line(2, 0, 6, 0);
    const r = overkill([p, a]);
    expect(r.result.remove).toEqual([a.handle]);
  });
  it('같은 원 위의 호: 합쳐서 한 바퀴면 원', () => {
    const a = arc(0, 0, 5, 0, 200);
    const b = arc(0, 0, 5, 180, 0);
    const r = overkill([a, b]);
    expect(r.result.remove!.sort()).toEqual([a.handle, b.handle].sort());
    const c = r.result.add![0] as CircleEntity;
    expect(c.type).toBe('CIRCLE');
    expect(c.radius).toBe(5);
    // 원 위의 호는 지운다
    const r2 = overkill([circle(0, 0, 5), arc(0, 0, 5, 10, 20)]);
    expect(r2.overlaps).toBe(1);
    // 부분 겹침은 늘인다
    const r3 = overkill([arc(0, 0, 5, 0, 90), arc(0, 0, 5, 60, 120)]);
    const x = r3.result.replace![0] as ArcEntity;
    expect(x.startAngle).toBeCloseTo(0);
    expect(x.endAngle).toBeCloseTo(deg(120));
  });
  it('폴리선 최적화: 일직선 정점, 길이 0 세그먼트, 같은 원의 연속 호', () => {
    const p = lw([
      [0, 0],
      [5, 0],
      [5, 0],
      [10, 0],
      [10, 10],
    ]);
    const r = overkill([p]);
    const o = r.result.replace![0] as LwPolylineEntity;
    expect(lwVertices(o).length).toBe(3);
    expect(r.overlaps).toBe(2);
    // 반원 둘(같은 원) → 정점 하나 제거
    const b = Math.tan(Math.PI / 8); // 90°
    const q = lw([
      [10, 0, b],
      [0, 10, b],
      [-10, 0],
    ]);
    const r2 = overkill([q]);
    const o2 = r2.result.replace![0] as LwPolylineEntity;
    expect(lwVertices(o2).length).toBe(2);
    expect(pathLength(entityPath(o2)!)).toBeCloseTo(Math.PI * 10, 9);
  });
});

describe('EXTRIM', () => {
  const box = () =>
    lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    );
  it('닫힌 경계 밖을 자른다', () => {
    const b = box();
    const a = line(-5, 5, 15, 5);
    const c = line(5, -5, 5, 3); // 한 번 교차
    const d = line(20, 20, 30, 30); // 교차 없음
    const r = extrim(b, V(-1, -1), [a, b, c, d], doc);
    const ra = r.replace!.find((x) => x.handle === a.handle) as LineEntity;
    near(ra.start, V(0, 5));
    near(ra.end, V(10, 5));
    const rc = r.replace!.find((x) => x.handle === c.handle) as LineEntity;
    near(rc.start, V(5, 0));
    near(rc.end, V(5, 3));
    expect(r.replace!.length).toBe(2);
  });
  it('닫힌 경계 안을 자른다(원은 호로)', () => {
    const b = box();
    const c = circle(10, 10, 4);
    const r = extrim(b, V(5, 5), [c], doc);
    expect(r.remove).toEqual([c.handle]);
    const a = r.add![0] as ArcEntity;
    expect(a.type).toBe('ARC');
    // 남은 호는 경계 밖(270° 짜리)
    expect(pathLength(entityPath(a)!)).toBeCloseTo((Math.PI * 2 * 4 * 3) / 4, 6);
  });
  it('열린 선 모서리의 한쪽', () => {
    const edge = line(0, 0, 10, 0);
    const a = line(5, -5, 5, 5);
    const r = extrim(edge, V(5, 3), [a], doc);
    const o = r.replace![0] as LineEntity;
    near(o.start, V(5, -5));
    near(o.end, V(5, 0));
  });
});

describe('BOUNDARY', () => {
  it('네 선으로 둘러싼 영역 → 닫힌 폴리선, 원 섬은 원 모양 폴리선', () => {
    const ents: Entity[] = [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0), circle(5, 5, 2)];
    const res = detectBoundary(doc, ents, V(1, 1))!;
    expect(res).toBeTruthy();
    const objs = boundaryObjects(res.paths, { ...entityDefaults(), handle: '' });
    expect(objs.length).toBe(2);
    const sq = objs.find((o) => o.type === 'LWPOLYLINE' && lwVertices(o).length === 4) as LwPolylineEntity;
    expect(sq).toBeTruthy();
    expect(sq.closed).toBe(true);
    expect(pathLength(entityPath(sq)!)).toBeCloseTo(40, 9);
    const ci = objs.find((o) => o !== sq)!;
    expect(pathLength(entityPath(ci)!)).toBeCloseTo(Math.PI * 4, 6);
    renders(doc, objs);
  });
  it('호가 섞인 영역', () => {
    const ents: Entity[] = [line(0, 0, 10, 0), arc(10, 5, 5, -90, 90), line(10, 10, 0, 10), line(0, 10, 0, 0)];
    const res = detectBoundary(doc, ents, V(2, 5))!;
    const objs = boundaryObjects(res.paths, { ...entityDefaults(), handle: '' });
    expect(objs.length).toBe(1);
    expect(pathLength(entityPath(objs[0]!)!)).toBeCloseTo(30 + Math.PI * 5, 6);
    void P;
  });
});
