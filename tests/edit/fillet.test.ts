import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, LwPolylineEntity, XLineEntity } from '../../src/core/model';
import { chamfer, chamferAngle, chamferPolyline, chamferPolylineAngle, fillet, filletPolyline } from '../../src/edit/geom/fillet';
import { entityPath } from '../../src/edit/geom/path';
import { pathNearest, pieceTangent } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, arc, circle, deg, ellipse, line, lw, near, newDoc, renders, spline, xline } from './helpers';

const doc = newDoc();

function byType(r: { add?: Entity[]; replace?: Entity[] }, type: string): Entity[] {
  return [...(r.replace ?? []), ...(r.add ?? [])].filter((e) => e.type === type);
}

/** 모깎기 호가 두 곡선에 접하는지: 접점에서 거리 0, 접선 평행 */
function tangentTo(a: ArcEntity, other: Entity, at: { x: number; y: number }): void {
  const po = entityPath(other)!;
  const pa = entityPath(a)!;
  const n1 = pathNearest(po, at);
  expect(n1.d).toBeLessThan(1e-7);
  const n2 = pathNearest(pa, at);
  expect(n2.d).toBeLessThan(1e-7);
  const t1 = pieceTangent(po.pieces[n1.i]!, n1.t);
  const t2 = pieceTangent(pa.pieces[n2.i]!, n2.t);
  expect(Math.abs(t1.x * t2.y - t1.y * t2.x)).toBeLessThan(1e-6);
}

const arcEnds = (a: ArcEntity) => [
  P(a.center.x + a.radius * Math.cos(a.startAngle), a.center.y + a.radius * Math.sin(a.startAngle)),
  P(a.center.x + a.radius * Math.cos(a.endAngle), a.center.y + a.radius * Math.sin(a.endAngle)),
];

describe('fillet — 선과 선', () => {
  it('직각 모서리: 반지름 2', () => {
    const a = line(0, 0, 10, 0);
    const b = line(0, 0, 0, 10);
    const r = fillet(a, V(5, 0), b, V(0, 5), 2);
    const lines = byType(r, 'LINE') as LineEntity[];
    expect(r.replace?.map((e) => e.handle).sort()).toEqual([a.handle, b.handle].sort());
    const la = lines.find((l) => l.handle === a.handle)!;
    const lb = lines.find((l) => l.handle === b.handle)!;
    near(la.start, P(2, 0));
    near(la.end, P(10, 0));
    near(lb.start, P(0, 2));
    near(lb.end, P(0, 10));
    const f = byType(r, 'ARC')[0] as ArcEntity;
    near(f.center, P(2, 2));
    expect(f.radius).toBeCloseTo(2);
    expect(f.startAngle).toBeCloseTo(deg(180));
    expect(f.endAngle).toBeCloseTo(deg(270));
    expect(f.handle).toBe('');
    expect(f.layer).toBe(a.layer);
    renders(doc, [la, lb, f]);
  });
  it('교차하는 선: 고른 점의 사분면', () => {
    const a = line(-10, 0, 10, 0);
    const b = line(0, -10, 0, 10);
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const r = fillet(a, V(5 * sx, 0), b, V(0, 5 * sy), 2);
      const f = byType(r, 'ARC')[0] as ArcEntity;
      near(f.center, P(2 * sx, 2 * sy));
      const la = (r.replace ?? []).find((e) => e.handle === a.handle) as LineEntity;
      const lb = (r.replace ?? []).find((e) => e.handle === b.handle) as LineEntity;
      // 고른 쪽이 남는다
      expect(Math.max(la.start.x * sx, la.end.x * sx)).toBeCloseTo(10);
      expect(Math.min(la.start.x * sx, la.end.x * sx)).toBeCloseTo(2);
      expect(Math.max(lb.start.y * sy, lb.end.y * sy)).toBeCloseTo(10);
      tangentTo(f, la, arcEnds(f).sort((p, q) => Math.abs(p.y) - Math.abs(q.y))[0]!);
    }
  });
  it('고른 점이 접점보다 교점 가까이 있어도 같은 사분면', () => {
    const a = line(0, 0, 10, 0);
    const b = line(0, 0, 0, 10);
    const r = fillet(a, V(0.5, 0), b, V(0, 0.5), 3);
    near((byType(r, 'ARC')[0] as ArcEntity).center, P(3, 3));
  });
  it('떨어진 선은 늘여서 모깎기', () => {
    const a = line(0, 0, 5, 0);
    const b = line(10, 3, 10, 10);
    const r = fillet(a, V(2, 0), b, V(10, 8), 2);
    const la = (r.replace ?? []).find((e) => e.handle === a.handle) as LineEntity;
    const lb = (r.replace ?? []).find((e) => e.handle === b.handle) as LineEntity;
    near(la.start, P(0, 0));
    near(la.end, P(8, 0));
    near(lb.start, P(10, 2));
    near(lb.end, P(10, 10));
    near((byType(r, 'ARC')[0] as ArcEntity).center, P(8, 2));
  });
  it('반지름 0: 모서리까지 늘이고 자른다(호 없음)', () => {
    const a = line(0, 0, 5, 0);
    const b = line(10, 3, 10, 10);
    const r = fillet(a, V(2, 0), b, V(10, 8), 0);
    expect(byType(r, 'ARC').length).toBe(0);
    const la = (r.replace ?? []).find((e) => e.handle === a.handle) as LineEntity;
    const lb = (r.replace ?? []).find((e) => e.handle === b.handle) as LineEntity;
    near(la.end, P(10, 0));
    near(lb.start, P(10, 0));
    // 교차하는 선: 고른 쪽만 남는다
    const c = line(-5, 0, 5, 0);
    const d = line(0, -5, 0, 5);
    const r2 = fillet(c, V(3, 0), d, V(0, -3), 0);
    const lc = (r2.replace ?? []).find((e) => e.handle === c.handle) as LineEntity;
    const ld = (r2.replace ?? []).find((e) => e.handle === d.handle) as LineEntity;
    near(lc.start, P(0, 0));
    near(lc.end, P(5, 0));
    near(ld.start, P(0, -5));
    near(ld.end, P(0, 0));
  });
  it('평행선: 반지름과 상관없이 반원', () => {
    const a = line(0, 0, 10, 0);
    const b = line(2, 4, 12, 4);
    const r = fillet(a, V(8, 0), b, V(8, 4), 7);
    const f = byType(r, 'ARC')[0] as ArcEntity;
    near(f.center, P(10, 2));
    expect(f.radius).toBeCloseTo(2);
    expect(f.startAngle).toBeCloseTo(deg(270));
    expect(f.endAngle).toBeCloseTo(deg(90));
    const lb = (r.replace ?? []).find((e) => e.handle === b.handle) as LineEntity;
    near(lb.start, P(2, 4));
    near(lb.end, P(10, 4));
    // 첫 선의 다른 끝
    const r2 = fillet(a, V(1, 0), b, V(8, 4), 1);
    near((byType(r2, 'ARC')[0] as ArcEntity).center, P(0, 2));
    const lb2 = (r2.replace ?? []).find((e) => e.handle === b.handle) as LineEntity;
    near(lb2.start, P(0, 4));
    near(lb2.end, P(12, 4));
  });
  it('반지름이 너무 크면 안내', () => {
    const r = fillet(line(0, 0, 3, 0), V(2, 0), line(0, 0, 0, 10), V(0, 5), 5);
    expect(r.message).toBe('반지름이 너무 큽니다.');
    expect(r.add).toBeUndefined();
  });
  it('TRIMMODE 0: 호만 더한다', () => {
    const r = fillet(line(0, 0, 10, 0), V(5, 0), line(0, 0, 0, 10), V(0, 5), 2, { trim: false });
    expect(r.replace).toBeUndefined();
    expect(r.add?.length).toBe(1);
    expect(r.add![0]!.type).toBe('ARC');
  });
  it('구성선·광선: 잘린 구성선은 광선, 광선의 시작 쪽을 남기면 선', () => {
    const x = xline(0, 0, 1, 0);
    const y = xline(0, 0, 0, 1, true);
    const r = fillet(x, V(5, 0), y, V(0, 5), 1);
    const rays = [...(r.add ?? [])].filter((e) => e.type === 'RAY') as XLineEntity[];
    expect(r.remove).toContain(x.handle);
    const rx = rays.find((e) => Math.abs(e.direction.x - 1) < 1e-9)!;
    near(rx.base, P(1, 0));
    const ry = (r.replace ?? []).find((e) => e.handle === y.handle) as XLineEntity;
    near(ry.base, P(0, 1));
    // 광선을 시작 쪽에서 자르면 LINE
    const ray = xline(0, -5, 0, 1, true);
    const r2 = fillet(line(-10, 0, 10, 0), V(5, 0), ray, V(0, -3), 1);
    const l2 = (r2.add ?? []).find((e) => e.type === 'LINE') as LineEntity;
    expect(r2.remove).toContain(ray.handle);
    near(l2.start, P(0, -5));
    near(l2.end, P(0, -1));
  });
});

describe('fillet — 호·원', () => {
  it('선과 원: 원은 그대로, 선만 자른다', () => {
    const l = line(-10, 0, 10, 0);
    const c = circle(0, 5, 3);
    const r = fillet(l, V(-6, 0), c, V(-2, 3), 2);
    const f = byType(r, 'ARC')[0] as ArcEntity;
    near(f.center, P(-4, 2));
    expect((r.replace ?? []).some((e) => e.handle === c.handle)).toBe(false);
    const ll = (r.replace ?? []).find((e) => e.handle === l.handle) as LineEntity;
    near(ll.start, P(-10, 0));
    near(ll.end, P(-4, 0));
    tangentTo(f, c, P(-2.4, 3.2));
    // 오른쪽
    const r2 = fillet(l, V(6, 0), c, V(2, 3), 2);
    near((byType(r2, 'ARC')[0] as ArcEntity).center, P(4, 2));
  });
  it('선과 호(교차): 교점 기준으로 고른 쪽', () => {
    // 호: 중심 (0, 0), 반지름 5, 0°..180° — 선 x = 3이 (3, 4)에서 만난다
    const a = arc(0, 0, 5, 0, 180) as ArcEntity;
    const l = line(3, -2, 3, 10);
    const r = fillet(a, V(-3, 4), l, V(3, 0), 1);
    const f = byType(r, 'ARC').find((e) => e.handle === '') as ArcEntity;
    expect(f.radius).toBeCloseTo(1);
    const na = (r.replace ?? []).find((e) => e.handle === a.handle) as ArcEntity;
    const nl = (r.replace ?? []).find((e) => e.handle === l.handle) as LineEntity;
    // 호의 왼쪽(180° 끝)과 선의 아래쪽이 남는다
    expect(na.endAngle).toBeCloseTo(Math.PI);
    expect(Math.min(nl.start.y, nl.end.y)).toBeCloseTo(-2);
    const ends = arcEnds(f);
    const onArc = ends.find((p) => Math.abs(Math.hypot(p.x, p.y) - 5) < 1e-6)!;
    const onLine = ends.find((p) => Math.abs(p.x - 3) < 1e-6)!;
    expect(onArc).toBeTruthy();
    expect(onLine).toBeTruthy();
    tangentTo(f, na, onArc);
    tangentTo(f, nl, onLine);
    // 모깎기 원 중심은 반지름 5 + 1 = 6 또는 5 − 1 = 4 거리
    const dc = Math.hypot(f.center.x, f.center.y);
    expect(Math.min(Math.abs(dc - 6), Math.abs(dc - 4))).toBeLessThan(1e-9);
    renders(doc, [na, nl, f]);
  });
  it('두 호(떨어짐): 위쪽을 고르면 위쪽이 남는다', () => {
    const a = arc(0, 0, 5, -90, 90) as ArcEntity;
    const b = arc(12, 0, 5, 90, 270) as ArcEntity;
    const r = fillet(a, V(0, 5), b, V(12, 5), 2);
    const f = byType(r, 'ARC').find((e) => e.handle === '') as ArcEntity;
    near(f.center, P(6, Math.sqrt(13)), 1e-9);
    const na = (r.replace ?? []).find((e) => e.handle === a.handle) as ArcEntity;
    const nb = (r.replace ?? []).find((e) => e.handle === b.handle) as ArcEntity;
    expect(na.startAngle).toBeCloseTo(Math.atan2(Math.sqrt(13), 6));
    expect(na.endAngle).toBeCloseTo(deg(90));
    expect(nb.startAngle).toBeCloseTo(deg(90));
    expect(nb.endAngle).toBeCloseTo(Math.PI - Math.atan2(Math.sqrt(13), 6));
  });
  it('−Z 호와 선', () => {
    // −Z 호 OCS 중심 (0, 0) 0°..180° = WCS 위쪽 반원(중심 (0, 0))
    const a = arc(0, 0, 5, 0, 180, NEG_Z);
    const l = line(3, -2, 3, 10);
    const r = fillet(a, V(-3, 4), l, V(3, 0), 1);
    const na = (r.replace ?? []).find((e) => e.handle === a.handle) as ArcEntity;
    expect(na.extrusion).toBeUndefined();
    expect(na.endAngle).toBeCloseTo(Math.PI);
    const f = byType(r, 'ARC').find((e) => e.handle === '') as ArcEntity;
    expect(f.radius).toBeCloseTo(1);
    renders(doc, [na, f]);
  });
  it('두 원: 원은 자르지 않고 호만', () => {
    const a = circle(0, 0, 5);
    const b = circle(12, 0, 5);
    const r = fillet(a, V(0, 5), b, V(12, 5), 2);
    expect(r.replace).toBeUndefined();
    const f = r.add![0] as ArcEntity;
    near(f.center, P(6, Math.sqrt(13)), 1e-9);
    const r2 = fillet(a, V(0, -5), b, V(12, -5), 2);
    near((r2.add![0] as ArcEntity).center, P(6, -Math.sqrt(13)), 1e-9);
  });
  it('타원과 선(수치 해)', () => {
    const el = ellipse(0, 0, 6, 0, 0.5, 0, Math.PI);
    const l = line(-10, -1, 10, -1);
    const r = fillet(el, V(5.5, 1), l, V(8, -1), 1);
    const f = byType(r, 'ARC').find((e) => e.handle === '') as ArcEntity;
    expect(f).toBeTruthy();
    expect(f.radius).toBeCloseTo(1);
    const ends = arcEnds(f);
    const ne = (r.replace ?? []).find((e) => e.handle === el.handle)!;
    const nl = (r.replace ?? []).find((e) => e.handle === l.handle)!;
    const onLine = ends.find((p) => Math.abs(p.y + 1) < 1e-6)!;
    const onEl = ends.find((p) => p !== onLine)!;
    tangentTo(f, nl, onLine);
    tangentTo(f, ne, onEl);
    renders(doc, [ne, nl, f]);
  });
  it('스플라인과 선(수치 해)', () => {
    const s = spline([
      [0, 5],
      [3, 6],
      [6, 4],
      [9, 6],
    ]);
    const l = line(7, -5, 7, 10);
    const r = fillet(s, V(2, 5.6), l, V(7, 0), 0.5);
    const f = byType(r, 'ARC').find((e) => e.handle === '') as ArcEntity;
    expect(f).toBeTruthy();
    const ns = (r.replace ?? []).find((e) => e.handle === s.handle)!;
    expect(ns.type).toBe('SPLINE');
    const nl = (r.replace ?? []).find((e) => e.handle === l.handle) as LineEntity;
    expect(Math.min(nl.start.y, nl.end.y)).toBeCloseTo(-5);
    const ends = arcEnds(f);
    const onLine = ends.find((p) => Math.abs(p.x - 7) < 1e-6)!;
    expect(onLine).toBeTruthy();
    expect(f.center.x).toBeLessThan(7);
    tangentTo(f, ns, ends.find((p) => p !== onLine)!);
    renders(doc, [ns, nl, f]);
  });
});

describe('fillet — 폴리선', () => {
  it('끝 세그먼트와 선', () => {
    const pl = lw([
      [0, 10],
      [0, 0],
      [10, 0],
    ]);
    const l = line(15, 2, 15, 10);
    const r = fillet(pl, V(5, 0), l, V(15, 8), 2);
    const np = (r.replace ?? []).find((e) => e.handle === pl.handle) as LwPolylineEntity;
    near(np.vertices[2]!, V(13, 0));
    const nl = (r.replace ?? []).find((e) => e.handle === l.handle) as LineEntity;
    near(nl.start, P(15, 2));
    near((byType(r, 'ARC')[0] as ArcEntity).center, P(13, 2));
  });
  it('가운데 세그먼트는 안내', () => {
    const pl = lw([
      [0, 10],
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const r = fillet(pl, V(5, 0), line(20, 0, 20, 5), V(20, 3), 1);
    expect(r.message).toBe('폴리선의 끝 세그먼트만 모깎기·모따기할 수 있습니다.');
  });
  it('같은 폴리선의 인접한 두 세그먼트 → 볼록도 호, 폭 테이퍼', () => {
    const pl = lw([
      [0, 10],
      [0, 0],
      [10, 0],
    ]) as LwPolylineEntity;
    const r = fillet(pl, V(0, 5), pl, V(5, 0), 2);
    const np = r.replace![0] as LwPolylineEntity;
    expect(np.handle).toBe(pl.handle);
    expect(np.vertices.length).toBe(4);
    near(np.vertices[1]!, V(0, 2));
    near(np.vertices[2]!, V(2, 0));
    expect(np.vertices[1]!.bulge).toBeCloseTo(Math.tan(Math.PI / 8));
    // 반대 순서로 골라도 같다
    const r2 = fillet(pl, V(5, 0), pl, V(0, 5), 2);
    expect((r2.replace![0] as LwPolylineEntity).vertices.length).toBe(4);
  });
  it('닫힌 폴리선의 마지막-첫 세그먼트 꼭짓점', () => {
    const pl = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    ) as LwPolylineEntity;
    const r = fillet(pl, V(0, 5), pl, V(5, 0), 1);
    const np = r.replace![0] as LwPolylineEntity;
    expect(np.closed).toBe(true);
    expect(np.vertices.length).toBe(5);
    const path = entityPath(np)!;
    expect(pathNearest(path, V(0, 0)).d).toBeCloseTo(Math.SQRT2 - 1, 6);
  });
  it('세그먼트 하나를 사이에 둔 두 직선: 사이 세그먼트를 바꾼다(평행이면 반원)', () => {
    const pl = lw([
      [0, 10],
      [0, 0],
      [4, 0],
      [4, 10],
    ]) as LwPolylineEntity;
    const r = fillet(pl, V(0, 5), pl, V(4, 5), 0);
    const np = r.replace![0] as LwPolylineEntity;
    expect(np.vertices.length).toBe(4);
    near(np.vertices[1]!, V(0, 0));
    expect(np.vertices[1]!.bulge).toBeCloseTo(1);
    near(np.vertices[2]!, V(4, 0));
    // 비스듬한 두 직선 사이 세그먼트를 모깎기 호로
    const pl2 = lw([
      [0, 10],
      [0, 0],
      [4, -1],
      [10, 0],
    ]) as LwPolylineEntity;
    const r2 = fillet(pl2, V(0, 5), pl2, V(8, -0.3), 1);
    const np2 = r2.replace![0] as LwPolylineEntity;
    expect(np2.vertices.length).toBe(4);
    const th = Math.acos(1 / Math.sqrt(37));
    near(np2.vertices[1]!, V(0, -5 / 3 + 1 / Math.tan(th / 2)), 1e-9);
    expect(np2.vertices[1]!.bulge).toBeGreaterThan(0);
  });
  it('filletPolyline: 모든 꼭짓점, 짧은 세그먼트는 건너뜀, 다시 하면 바꾼다', () => {
    const pl = lw(
      [
        [0, 0],
        [10, 0],
        [10, 1],
        [0, 1.5],
      ],
      true,
    ) as LwPolylineEntity;
    const r = filletPolyline(pl, 0.4);
    const np = r.replace![0] as LwPolylineEntity;
    expect(r.message).toMatch(/모깎기/);
    const arcs = np.vertices.filter((v) => Math.abs(v.bulge) > 1e-9).length;
    expect(arcs).toBeGreaterThanOrEqual(2);
    // 반지름 0으로 다시: 원래 모서리
    const back = filletPolyline(np, 0);
    const bp = back.replace![0] as LwPolylineEntity;
    expect(bp.vertices.length).toBe(4);
    for (const q of pl.vertices) expect(bp.vertices.some((v) => Math.hypot(v.x - q.x, v.y - q.y) < 1e-9)).toBe(true);
    // 큰 반지름: 너무 짧음
    const big = filletPolyline(pl, 5);
    expect(big.message).toMatch(/너무 짧습니다/);
    renders(doc, [np, bp]);
  });
  it('filletPolyline: 폭 있는 폴리선은 폭 유지', () => {
    const pl = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      false,
      undefined,
      0.5,
    );
    const np = filletPolyline(pl, 2).replace![0] as LwPolylineEntity;
    expect(np.constantWidth).toBeCloseTo(0.5);
  });
});

describe('chamfer', () => {
  it('직각 모서리: 거리 2, 3', () => {
    const a = line(0, 0, 10, 0);
    const b = line(0, 0, 0, 10);
    const r = chamfer(a, V(5, 0), b, V(0, 5), 2, 3);
    const la = (r.replace ?? []).find((e) => e.handle === a.handle) as LineEntity;
    const lb = (r.replace ?? []).find((e) => e.handle === b.handle) as LineEntity;
    near(la.start, P(2, 0));
    near(lb.start, P(0, 3));
    const c = (r.add ?? [])[0] as LineEntity;
    near(c.start, P(2, 0));
    near(c.end, P(0, 3));
  });
  it('떨어진 선을 늘인다, 거리가 너무 크면 안내, 평행이면 안내', () => {
    const a = line(0, 0, 5, 0);
    const b = line(10, 3, 10, 10);
    const r = chamfer(a, V(2, 0), b, V(10, 8), 1, 1);
    const la = (r.replace ?? []).find((e) => e.handle === a.handle) as LineEntity;
    near(la.end, P(9, 0));
    const lb = (r.replace ?? []).find((e) => e.handle === b.handle) as LineEntity;
    near(lb.start, P(10, 1));
    expect(chamfer(a, V(2, 0), b, V(10, 8), 20, 1).message).toBe('거리가 너무 큽니다.');
    expect(chamfer(line(0, 0, 1, 0), V(0.5, 0), line(0, 1, 1, 1), V(0.5, 1), 1, 1).message).toBe('선이 평행합니다.');
    expect(chamfer(arc(0, 0, 1, 0, 90), V(1, 0), line(0, 0, 1, 0), V(0.5, 0), 1, 1).message).toBe('이 객체는 모따기할 수 없습니다.');
  });
  it('길이·각도: 직각에서 45°는 두 거리가 같다', () => {
    const a = line(0, 0, 10, 0);
    const b = line(0, 0, 0, 10);
    const r = chamferAngle(a, V(5, 0), b, V(0, 5), 2, deg(45));
    const c = (r.add ?? [])[0] as LineEntity;
    near(c.start, P(2, 0));
    near(c.end, P(0, 2));
    const r2 = chamferAngle(a, V(5, 0), b, V(0, 5), 2, deg(60));
    const c2 = (r2.add ?? [])[0] as LineEntity;
    near(c2.end, P(0, 2 * Math.tan(deg(60))), 1e-9);
  });
  it('같은 폴리선의 인접 세그먼트, 폴리선 전체', () => {
    const pl = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    ) as LwPolylineEntity;
    const r = chamfer(pl, V(5, 0), pl, V(10, 5), 1, 2);
    const np = r.replace![0] as LwPolylineEntity;
    expect(np.vertices.length).toBe(5);
    expect(np.vertices.some((v) => Math.hypot(v.x - 9, v.y) < 1e-9)).toBe(true);
    expect(np.vertices.some((v) => Math.hypot(v.x - 10, v.y - 2) < 1e-9)).toBe(true);
    const all = chamferPolyline(pl, 1, 1);
    expect((all.replace![0] as LwPolylineEntity).vertices.length).toBe(8);
    const ang = chamferPolylineAngle(pl, 1, deg(45));
    expect((ang.replace![0] as LwPolylineEntity).vertices.length).toBe(8);
    renders(doc, [np, all.replace![0]!]);
  });
});

describe('fillet — 결과는 그려진다', () => {
  it('여러 조합', () => {
    const list: Entity[] = [];
    const pairs: [Entity, { x: number; y: number }, Entity, { x: number; y: number }, number][] = [
      [line(0, 0, 10, 0), V(5, 0), circle(5, 6, 2) as CircleEntity, V(4, 4), 3],
      [arc(0, 0, 4, 0, 180), V(-2, 3.4), arc(6, 0, 4, 0, 180), V(8, 3.4), 1],
      [lw([[0, 0], [5, 0, 0.3], [10, 3]]), V(9, 2.6), line(12, -5, 12, 10), V(12, 0), 1],
    ];
    for (const [a, pa, b, pb, rad] of pairs) {
      const r = fillet(a, pa, b, pb, rad);
      expect(r.message, JSON.stringify(r.message)).toBeUndefined();
      expect(fillet(line(0, 0, 10, 0), V(5, 0), circle(5, 6, 2), V(4, 4), 1).message).toBe('이 반지름으로는 모깎기할 수 없습니다.');
      list.push(...(r.replace ?? []), ...(r.add ?? []));
    }
    renders(doc, list);
  });
});
