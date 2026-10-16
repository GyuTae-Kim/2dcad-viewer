import { describe, expect, it } from 'vitest';
import type { Entity, InsertEntity, LineEntity, LwPolylineEntity, PolylineEntity, SplineEntity, Vec2 } from '../../src/core/model';
import { boundsOf, copyEntity, entityBounds, intersections, nearestPointOn, reverseEntity } from '../../src/edit/geom/query';
import { entityPath } from '../../src/edit/geom/path';
import { flattenPath, pathNearest } from '../../src/edit/geom/curve';
import { affRotate, affTranslate } from '../../src/edit/geom/math';
import { NEG_Z, P, V, arc, circle, deg, ellipse, fitSpline, line, lw, mtext, near, newDoc, poly2d, samePath, spline, text, xline } from './helpers';
import { lwVertices, setLwVertex } from '../../src/core/lwpoly';

const doc = newDoc();

function sortPts(ps: Vec2[]): Vec2[] {
  return [...ps].sort((a, b) => a.x - b.x || a.y - b.y);
}

function expectPts(got: Vec2[], want: Vec2[], tol = 1e-9): void {
  expect(got.length, JSON.stringify(got)).toBe(want.length);
  const g = sortPts(got);
  const w = sortPts(want);
  g.forEach((p, i) => near(p, w[i]!, tol));
}

/** 촘촘한 꺾은선끼리의 교점(검산용) */
function bruteHits(a: Entity, b: Entity): Vec2[] {
  const A = flattenPath(entityPath(a)!, 1e-5);
  const B = flattenPath(entityPath(b)!, 1e-5);
  const out: Vec2[] = [];
  for (let i = 1; i < A.length; i++)
    for (let j = 1; j < B.length; j++) {
      const p = A[i - 1]!;
      const r = { x: A[i]!.x - p.x, y: A[i]!.y - p.y };
      const q = B[j - 1]!;
      const s = { x: B[j]!.x - q.x, y: B[j]!.y - q.y };
      const den = r.x * s.y - r.y * s.x;
      if (Math.abs(den) < 1e-300) continue;
      const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / den;
      const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const h = { x: p.x + r.x * t, y: p.y + r.y * t };
      if (!out.some((o) => Math.hypot(o.x - h.x, o.y - h.y) < 1e-4)) out.push(h);
    }
  return out;
}

/** 교점이 두 객체 위에 있는지 */
function onBoth(a: Entity, b: Entity, ps: Vec2[], tol = 1e-7): void {
  for (const p of ps) {
    expect(pathNearest(entityPath(a)!, p).d).toBeLessThan(tol);
    expect(pathNearest(entityPath(b)!, p).d).toBeLessThan(tol);
  }
}

describe('intersections — 알려진 답', () => {
  it('선 × 선', () => {
    expectPts(intersections(line(0, 0, 10, 10), line(0, 10, 10, 0)), [V(5, 5)]);
    expectPts(intersections(line(0, 0, 4, 4), line(0, 10, 10, 0)), []);
    expectPts(intersections(line(0, 0, 10, 0), line(0, 1, 10, 1)), []);
    // 끝점에서 닿음
    expectPts(intersections(line(0, 0, 5, 0), line(5, 0, 5, 5)), [V(5, 0)]);
  });
  it('선 × 원·호(−Z 포함)', () => {
    expectPts(intersections(line(-10, 0, 10, 0), circle(0, 0, 5)), [V(-5, 0), V(5, 0)]);
    expectPts(intersections(line(-10, 3, 10, 3), circle(0, 0, 5)), [V(-4, 3), V(4, 3)]);
    expectPts(intersections(line(-10, 5, 10, 5), circle(0, 0, 5)), [V(0, 5)], 1e-6);
    expectPts(intersections(line(-10, 3, 10, 3), arc(0, 0, 5, 0, 90)), [V(4, 3)]);
    // −Z 호: OCS 0°..90° = WCS 90°..180°(왼쪽 위)
    expectPts(intersections(line(-10, 3, 10, 3), arc(0, 0, 5, 0, 90, NEG_Z)), [V(-4, 3)]);
    // −Z 원: OCS 중심 (3, 0) = WCS (−3, 0)
    expectPts(intersections(line(-3, -10, -3, 10), circle(3, 0, 2, NEG_Z)), [V(-3, -2), V(-3, 2)]);
  });
  it('원 × 원, 호 × 호', () => {
    expectPts(intersections(circle(0, 0, 5), circle(8, 0, 5)), [V(4, 3), V(4, -3)]);
    expectPts(intersections(circle(0, 0, 5), circle(10, 0, 5)), [V(5, 0)], 1e-6);
    expectPts(intersections(circle(0, 0, 5), circle(20, 0, 5)), []);
    expectPts(intersections(arc(0, 0, 5, 0, 90), arc(8, 0, 5, 90, 180)), [V(4, 3)]);
  });
  it('선 × 타원', () => {
    const el = ellipse(0, 0, 4, 0, 0.5);
    expectPts(intersections(line(-10, 0, 10, 0), el), [V(-4, 0), V(4, 0)]);
    expectPts(intersections(line(0, -10, 0, 10), el), [V(0, -2), V(0, 2)]);
    // 회전한 타원(장축 45°)
    const r = ellipse(0, 0, 3, 3, 0.5);
    const hits = intersections(line(-10, -10, 10, 10), r);
    expectPts(hits, [V(-3, -3), V(3, 3)]);
  });
  it('폴리선(볼록도) × 선', () => {
    // 반원 볼록도 1: (0,0) → (10,0), 오른쪽 위로 볼록(반시계): 중심 (5, 0), 아래쪽 반원
    const p = lw([
      [0, 0, 1],
      [10, 0],
    ]);
    expectPts(intersections(p, line(5, -10, 5, 10)), [V(5, -5)]);
    const q = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    );
    expectPts(intersections(q, line(-5, 5, 15, 5)), [V(0, 5), V(10, 5)]);
    expectPts(intersections(poly2d([[0, 0], [10, 0, -1], [10, 10]]), line(5, -5, 5, 15)), [V(5, 5), V(5, 0)]);
  });
  it('구성선·광선', () => {
    expectPts(intersections(xline(0, 0, 1, 1), line(10, 0, 0, 10)), [V(5, 5)]);
    expectPts(intersections(xline(100, 100, 1, 0), circle(0, 100, 1)), [V(-1, 100), V(1, 100)]);
    expectPts(intersections(xline(0, 0, 1, 0, true), circle(0, 0, 1)), [V(1, 0)]);
    expectPts(intersections(xline(0, 0, 1, 0), xline(5, -5, 0, 1, true)), [V(5, 0)]);
  });
  it('스플라인·타원·폴리선 수치 교점은 두 곡선 위에 있다', () => {
    const s = spline([
      [0, 0],
      [3, 5],
      [7, -2],
      [10, 4],
      [14, 0],
    ]);
    const pairs: [Entity, Entity, number][] = [
      [s, line(0, 1, 14, 1), 2],
      [s, circle(7, 1, 3), 2],
      [s, ellipse(7, 0, 6, 0, 0.3), -1],
      [ellipse(0, 0, 5, 0, 0.5), ellipse(0, 0, 2, 3, 0.8), 4],
      [fitSpline([[0, 0], [3, 4], [7, 1], [10, 6]]), lw([[0, 2], [10, 2, 0.4], [10, 5]]), -1],
    ];
    for (const [a, b, n] of pairs) {
      const ps = intersections(a, b);
      const brute = bruteHits(a, b);
      expect(ps.length, `${a.type}×${b.type}`).toBe(brute.length);
      if (n >= 0) expect(ps.length).toBe(n);
      onBoth(a, b, ps);
      // 꺾은선 교점과 같은 자리
      for (const q of brute) expect(Math.min(...ps.map((p) => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThan(1e-3);
    }
  });
  it('자기 교점(같은 객체)', () => {
    const p = lw([
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ]);
    expectPts(intersections(p, p), [V(5, 5)]);
  });
  it('블록 참조(문서가 있으면 분해한 그림)', () => {
    const d = newDoc();
    d.blocks.set('B', { name: 'B', handle: 'B1', recordHandle: 'B2', basePoint: P(0, 0), flags: 0, entities: [line(-1, 0, 1, 0)] });
    const ins: InsertEntity = {
      type: 'INSERT',
      handle: 'I1',
      layer: '0',
      linetype: 'ByLayer',
      color: { aci: 256 },
      lineweight: -1,
      ltscale: 1,
      transparency: -1,
      block: 'B',
      insert: P(5, 5),
      scale: P(2, 2, 1),
      rotation: deg(90),
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
    };
    expectPts(intersections(ins, line(0, 6, 10, 6), d), [V(5, 6)]);
  });
});

describe('nearestPointOn', () => {
  it('선·원·−Z 호·폴리선·스플라인', () => {
    near(nearestPointOn(line(0, 0, 10, 0), V(3, 4))!, V(3, 0));
    near(nearestPointOn(line(0, 0, 10, 0), V(-3, 4))!, V(0, 0));
    near(nearestPointOn(circle(0, 0, 5), V(10, 0))!, V(5, 0));
    near(nearestPointOn(arc(0, 0, 5, 0, 90, NEG_Z), V(-10, 0.0001))!, V(-5, 0), 1e-3);
    near(nearestPointOn(lw([[0, 0], [10, 0], [10, 10]]), V(12, 5))!, V(10, 5));
    const s = spline([
      [0, 0],
      [5, 5],
      [10, 0],
    ]);
    const q = nearestPointOn(s, V(5, 10))!;
    expect(pathNearest(entityPath(s)!, q).d).toBeLessThan(1e-9);
    near(q, V(5, 2.5), 1e-6);
    near(nearestPointOn(text(3, 4, 'A'), V(0, 0))!, V(3, 4));
  });
});

describe('entityBounds', () => {
  it('곡선', () => {
    const b = entityBounds(circle(1, 2, 3), doc)!;
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([-2, -1, 4, 5].map((x) => expect.closeTo(x, 9)));
    const a = entityBounds(arc(0, 0, 5, 0, 90), doc)!;
    expect(a.minX).toBeCloseTo(0);
    expect(a.maxX).toBeCloseTo(5);
    expect(a.maxY).toBeCloseTo(5);
    const n = entityBounds(arc(0, 0, 5, 0, 90, NEG_Z), doc)!;
    expect(n.minX).toBeCloseTo(-5);
    expect(n.maxX).toBeCloseTo(0);
    const e = entityBounds(ellipse(0, 0, 4, 0, 0.5), doc)!;
    expect(e.maxY).toBeCloseTo(2, 3);
    expect(e.maxX).toBeCloseTo(4, 3);
    const p = entityBounds(lw([[0, 0, 1], [10, 0]]), doc)!;
    expect(p.minY).toBeCloseTo(-5);
  });
  it('문자·여러 줄 문자·블록 참조', () => {
    const t = entityBounds(text(0, 0, 'ABC', 2), doc)!;
    expect(t.minX).toBeCloseTo(0, 1);
    expect(t.maxX).toBeGreaterThan(2);
    expect(t.maxY).toBeCloseTo(2, 1);
    const m = entityBounds(mtext(0, 0, 'Hello', 2.5), doc)!;
    expect(m.maxY).toBeLessThanOrEqual(1e-9);
    expect(m.maxX).toBeGreaterThan(5);
    const d = newDoc();
    d.blocks.set('B', { name: 'B', handle: 'B1', recordHandle: 'B2', basePoint: P(0, 0), flags: 0, entities: [circle(0, 0, 1)] });
    const ins = {
      type: 'INSERT',
      handle: 'I1',
      layer: '0',
      linetype: 'ByLayer',
      color: { aci: 256 },
      lineweight: -1,
      ltscale: 1,
      transparency: -1,
      block: 'B',
      insert: P(10, 0),
      scale: P(2, 2, 1),
      rotation: 0,
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
      attribs: [],
    } as InsertEntity;
    const ib = entityBounds(ins, d)!;
    expect([ib.minX, ib.minY, ib.maxX, ib.maxY]).toEqual([8, -2, 12, 2].map((x) => expect.closeTo(x, 9)));
    const all = boundsOf([circle(0, 0, 1), line(5, 5, 6, 7)], doc)!;
    expect([all.minX, all.minY, all.maxX, all.maxY]).toEqual([-1, -1, 6, 7].map((x) => expect.closeTo(x, 9)));
  });
});

describe('reverseEntity', () => {
  it('선·폴리선(볼록도·폭)·스플라인: 모양은 같고 방향만 반대', () => {
    const l = line(0, 0, 5, 5);
    const rl = reverseEntity(l).replace![0] as LineEntity;
    near(rl.start, P(5, 5));
    const p = lw([
      [0, 0, 0.5],
      [10, 0, -0.3],
      [10, 10],
    ]) as LwPolylineEntity;
    setLwVertex(p, 0, { startWidth: 1, endWidth: 2 });
    const rp = reverseEntity(p).replace![0] as LwPolylineEntity;
    near(lwVertices(rp)[0]!, V(10, 10));
    expect(lwVertices(rp)[0]!.bulge).toBeCloseTo(0.3);
    expect(lwVertices(rp)[1]!.bulge).toBeCloseTo(-0.5);
    expect(lwVertices(rp)[2]!.bulge).toBeCloseTo(0);
    expect(lwVertices(rp)[1]!.startWidth).toBeCloseTo(2);
    expect(lwVertices(rp)[1]!.endWidth).toBeCloseTo(1);
    samePath(p, rp);
    const closed = lw([[0, 0, 0.4], [10, 0], [10, 10, -0.2]], true) as LwPolylineEntity;
    samePath(closed, reverseEntity(closed).replace![0]!);
    const pp = poly2d([[0, 0, 0.3], [5, 1], [8, 6, -0.7], [2, 9]]) as PolylineEntity;
    samePath(pp, reverseEntity(pp).replace![0]!);
    const s = spline([
      [0, 0],
      [3, 5],
      [7, -2],
      [10, 4],
    ]) as SplineEntity;
    const rs = reverseEntity(s).replace![0] as SplineEntity;
    near(rs.controlPoints[0]!, P(10, 4));
    samePath(s, rs);
    expect(reverseEntity(circle(0, 0, 1)).message).toBeTruthy();
  });
});

describe('copyEntity', () => {
  it('복사본은 핸들이 비고 원본은 그대로', () => {
    const l = line(0, 0, 1, 0);
    const r = copyEntity(l, affTranslate(5, 0), doc);
    expect(r.replace).toBeUndefined();
    expect(r.remove).toBeUndefined();
    expect(r.add![0]!.handle).toBe('');
    near((r.add![0] as LineEntity).start, P(5, 0));
    expect((l as LineEntity).start.x).toBe(0);
    const c = copyEntity(circle(0, 0, 1), affRotate(1), doc);
    expect(c.add![0]!.type).toBe('CIRCLE');
  });
});
