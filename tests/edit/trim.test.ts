import { describe, expect, it } from 'vitest';
import type { ArcEntity, EllipseEntity, Entity, LineEntity, LwPolylineEntity, SplineEntity, XLineEntity } from '../../src/core/model';
import { breakEntity, extendEntity, lengthenEntity, trimEntity } from '../../src/edit/geom/trim';
import { entityPath } from '../../src/edit/geom/path';
import { pathLength, pathNearest, pathSize, flattenPath } from '../../src/edit/geom/curve';
import { edgePieces } from '../../src/edit/geom/edges';
import { pieceNearest } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, arc, circle, deg, ellipse, line, lw, near, newDoc, poly2d, renders, samePath, spline, xline } from './helpers';
import { lwVertices, setLwVertex } from '../../src/core/lwpoly';

const doc = newDoc();

function all(r: { add?: Entity[]; replace?: Entity[] }): Entity[] {
  return [...(r.replace ?? []), ...(r.add ?? [])];
}

/** 결과 객체의 끝점(원본 끝점이 아닌 것)이 절단 모서리 위에 있는지 */
function endsOnCutters(orig: Entity, out: Entity[], cutters: Entity[], tol = 1e-7): void {
  const po = entityPath(orig)!;
  const s0 = flattenPath(po, 1)[0]!;
  const ends = new Set<string>([`${s0.x.toFixed(6)},${s0.y.toFixed(6)}`]);
  const last = flattenPath(po, 1).at(-1)!;
  ends.add(`${last.x.toFixed(6)},${last.y.toFixed(6)}`);
  const edges = cutters.flatMap((c) => edgePieces(c));
  for (const o of out) {
    const p = entityPath(o)!;
    if (p.closed) continue;
    const f = flattenPath(p, 1);
    for (const q of [f[0]!, f.at(-1)!]) {
      if (ends.has(`${q.x.toFixed(6)},${q.y.toFixed(6)}`)) continue;
      const d = Math.min(...edges.map((pc) => pieceNearest(pc, q).d));
      expect(d, `끝점 (${q.x}, ${q.y})`).toBeLessThan(tol);
    }
    // 결과는 원본 위에 있다
    for (const q of flattenPath(p, pathSize(p) * 1e-2)) expect(pathNearest(po, q).d).toBeLessThan(1e-6);
  }
}

describe('trimEntity', () => {
  const v3 = line(3, -5, 3, 5);
  const v7 = line(7, -5, 7, 5);
  it('선: 두 절단선 사이를 고르면 둘로', () => {
    const l = line(0, 0, 10, 0);
    const r = trimEntity(l, [v3, v7], V(5, 0));
    const a = r.replace![0] as LineEntity;
    const b = r.add![0] as LineEntity;
    expect(a.handle).toBe(l.handle);
    near(a.start, P(0, 0));
    near(a.end, P(3, 0));
    near(b.start, P(7, 0));
    near(b.end, P(10, 0));
    expect(b.handle).toBe('');
    endsOnCutters(l, all(r), [v3, v7]);
  });
  it('선: 끝 쪽을 고르면 짧아진다', () => {
    const l = line(0, 0, 10, 0);
    const r = trimEntity(l, [v3, v7], V(1, 0));
    expect(all(r).length).toBe(1);
    near((r.replace![0] as LineEntity).start, P(3, 0));
    near((r.replace![0] as LineEntity).end, P(10, 0));
  });
  it('교차하지 않으면 안내, 빠른 모드는 지운다', () => {
    const l = line(0, 10, 10, 10);
    expect(trimEntity(l, [v3], V(5, 10)).message).toBe('객체가 모서리와 교차하지 않습니다.');
    expect(trimEntity(l, [v3], V(5, 10), { quick: true }).remove).toEqual([l.handle]);
  });
  it('모서리 연장(EDGEMODE 1)', () => {
    const l = line(0, 10, 10, 10);
    const r = trimEntity(l, [v3], V(1, 10), { extendEdges: true });
    near((r.replace![0] as LineEntity).start, P(3, 10));
  });
  it("'all': 목록의 다른 모든 객체가 절단 모서리", () => {
    const l = line(0, 0, 10, 0);
    const r = trimEntity(l, 'all', V(5, 0), { all: [l, v3, v7] });
    expect(all(r).length).toBe(2);
  });
  it('원 → 호(지운 부분은 고른 쪽)', () => {
    const c = circle(0, 0, 5);
    const cut = line(-10, 0, 10, 0);
    const r = trimEntity(c, [cut], V(0, 5));
    expect(r.remove).toEqual([c.handle]);
    const a = r.add![0] as ArcEntity;
    expect(a.type).toBe('ARC');
    expect(a.startAngle).toBeCloseTo(Math.PI);
    expect(a.endAngle).toBeCloseTo(0);
    endsOnCutters(c, [a], [cut]);
    // 한 점에서만 만나면 자를 수 없다
    expect(trimEntity(c, [line(5, -5, 5, 5)], V(0, 5)).message).toBeTruthy();
  });
  it('호와 −Z 호', () => {
    const a = arc(0, 0, 5, 0, 180) as ArcEntity;
    const cut = line(0, 0, 0, 10);
    const r = trimEntity(a, [cut], V(4, 3));
    const o = r.replace![0] as ArcEntity;
    expect(o.startAngle).toBeCloseTo(deg(90));
    expect(o.endAngle).toBeCloseTo(deg(180));
    const n = arc(0, 0, 5, 0, 180, NEG_Z);
    const rn = trimEntity(n, [cut], V(-4, 3));
    const on = rn.replace![0] as ArcEntity;
    expect(on.extrusion).toBeUndefined();
    // −Z 호는 WCS로 같은 위쪽 반원 → 왼쪽(−4, 3)을 지우면 0°..90°가 남는다
    expect(on.startAngle).toBeCloseTo(0);
    expect(on.endAngle).toBeCloseTo(deg(90));
    renders(doc, [o, on]);
  });
  it('타원 → 타원형 호, 스플라인 → 스플라인', () => {
    const el = ellipse(0, 0, 6, 0, 0.5);
    const cut = line(0, -5, 0, 5);
    const r = trimEntity(el, [cut, line(-10, 0, 10, 0)], V(3, 2.5));
    const o = all(r)[0] as EllipseEntity;
    expect(o.type).toBe('ELLIPSE');
    endsOnCutters(el, [o], [cut, line(-10, 0, 10, 0)]);
    const s = spline([
      [0, 0],
      [3, 5],
      [7, -2],
      [10, 4],
    ]);
    const rs = trimEntity(s, [line(5, -5, 5, 5)], V(9, 3.5));
    const so = all(rs)[0] as SplineEntity;
    expect(so.type).toBe('SPLINE');
    endsOnCutters(s, [so], [line(5, -5, 5, 5)]);
    renders(doc, [o, so]);
  });
  it('열린 폴리선(볼록도)', () => {
    const p = lw([
      [0, 0],
      [5, 0, 0.5],
      [10, 0],
      [10, 10],
    ]);
    const cut = line(-1, 5, 12, 5);
    const r = trimEntity(p, [cut], V(10, 8));
    const o = r.replace![0] as LwPolylineEntity;
    endsOnCutters(p, [o], [cut]);
    expect(pathLength(entityPath(o)!)).toBeLessThan(pathLength(entityPath(p)!));
  });
  it('닫힌 폴리선: 두 교점 사이를 지우면 열린 폴리선', () => {
    const sq = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    );
    const cut = line(5, -5, 5, 15);
    const r = trimEntity(sq, [cut], V(0, 5));
    const o = r.replace![0] as LwPolylineEntity;
    expect(o.closed).toBe(false);
    expect(lwVertices(o).map((v) => [v.x, v.y])).toEqual(
      [
        [5, 0],
        [10, 0],
        [10, 10],
        [5, 10],
      ].map(([x, y]) => [expect.closeTo(x!, 9), expect.closeTo(y!, 9)]),
    );
    endsOnCutters(sq, [o], [cut]);
  });
  it('구성선·광선', () => {
    const x = xline(0, 0, 1, 0);
    const r = trimEntity(x, [line(5, -1, 5, 1)], V(10, 0));
    const ray = all(r)[0] as XLineEntity;
    expect(ray.type).toBe('RAY');
    near(ray.base, P(5, 0));
    expect(ray.direction.x).toBeCloseTo(-1);
    const r2 = trimEntity(x, [line(5, -1, 5, 1), line(8, -1, 8, 1)], V(6, 0));
    expect(all(r2).filter((e) => e.type === 'RAY').length).toBe(2);
    const ray0 = xline(0, 0, 1, 0, true);
    const r3 = trimEntity(ray0, [line(5, -1, 5, 1)], V(10, 0));
    const l3 = all(r3)[0] as LineEntity;
    expect(l3.type).toBe('LINE');
    near(l3.end, P(5, 0));
  });
  it('자기 자신이 경계에 있으면 자기 교점도 절단점', () => {
    const p = lw([
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ]);
    const r = trimEntity(p, [p], V(1, 1));
    const o = r.replace![0] as LwPolylineEntity;
    near(lwVertices(o)[0]!, V(5, 5));
  });
  it('속성 시험: 결과 끝점은 절단 모서리 위', () => {
    const cutters = [circle(4, 2, 3), line(-5, 6, 15, -2), arc(8, 0, 4, 90, 270), ellipse(2, -1, 4, 1, 0.4)];
    const targets: Entity[] = [line(-5, 1, 15, 1), lw([[-5, -2], [5, 4, 0.4], [14, -1]]), arc(3, 0, 6, 10, 170), spline([[-4, 3], [0, -4], [6, 6], [12, -3]]), poly2d([[-3, -3], [12, 5, -0.3], [12, -4]])];
    for (const t of targets)
      for (const pick of [V(0, 1), V(6, 1), V(10, 0)]) {
        const near0 = pathNearest(entityPath(t)!, pick).p;
        const r = trimEntity(t, cutters, near0);
        if (r.message) continue;
        endsOnCutters(t, all(r), cutters);
        renders(doc, all(r));
      }
  });
});

describe('extendEntity', () => {
  const wall = line(10, -10, 10, 10);
  it('선의 가까운 끝을 경계까지', () => {
    const l = line(0, 0, 5, 0);
    const r = extendEntity(l, [wall], V(4, 0));
    near((r.replace![0] as LineEntity).end, P(10, 0));
    expect(extendEntity(l, [wall], V(1, 0)).message).toBe('객체가 모서리와 교차하지 않습니다.');
  });
  it('모서리 연장(EDGEMODE 1)', () => {
    const l = line(0, 0, 5, 0);
    const short = line(10, 2, 10, 5);
    expect(extendEntity(l, [short], V(4, 0)).message).toBeTruthy();
    near((extendEntity(l, [short], V(4, 0), { extendEdges: true }).replace![0] as LineEntity).end, P(10, 0));
  });
  it('호는 원을 따라 늘어난다(−Z 포함)', () => {
    const a = arc(0, 0, 5, 0, 45);
    // 끝(45°)에서 반시계로 늘이면 y = 3 선과 143.13°에서 만난다
    const r = extendEntity(a, [line(-10, 3, 10, 3)], V(4, 3.5));
    const o = r.replace![0] as ArcEntity;
    expect(o.endAngle).toBeCloseTo(Math.PI - Math.atan2(3, 4));
    // 시작(0°)에서 시계로 늘이면 y = −3 선
    const r2 = extendEntity(a, [line(-10, -3, 10, -3)], V(5, 0.1));
    expect((r2.replace![0] as ArcEntity).startAngle).toBeCloseTo(2 * Math.PI - Math.atan2(3, 4));
    expect(extendEntity(a, [line(20, -3, 30, -3)], V(5, 0.1)).message).toBeTruthy();
    const n = arc(0, 0, 5, 0, 45, NEG_Z);
    // WCS 135°..180°, 위쪽 끝(135°)을 늘이면 y = 4.5 선과 만난다 — 반시계 반대 방향(오른쪽 위로)
    const r3 = extendEntity(n, [line(-10, 4.5, 10, 4.5)], V(-3.6, 3.6));
    const o3 = r3.replace![0] as ArcEntity;
    expect(o3.extrusion).toBeUndefined();
    const hit = Math.PI - Math.asin(4.5 / 5);
    expect(o3.startAngle).toBeCloseTo(hit);
    renders(doc, [o, o3]);
  });
  it('폴리선 끝 세그먼트(폭 테이퍼를 잇는다)', () => {
    const p = lw([
      [0, 0],
      [5, 0],
    ]) as LwPolylineEntity;
    setLwVertex(p, 0, { startWidth: 1, endWidth: 0.5 });
    const r = extendEntity(p, [wall], V(4, 0));
    const o = r.replace![0] as LwPolylineEntity;
    near(lwVertices(o)[1]!, V(10, 0));
    expect(lwVertices(o)[0]!.endWidth).toBeCloseTo(0);
  });
  it('타원형 호·스플라인(끝 접선 방향 직선 부분)', () => {
    const ea = ellipse(0, 0, 6, 0, 0.5, 0, Math.PI / 4);
    const r = extendEntity(ea, [line(-10, 2.5, 10, 2.5)], V(4.3, 2));
    const o = r.replace![0] as EllipseEntity;
    const end = { x: 6 * Math.cos(o.endParam), y: 3 * Math.sin(o.endParam) };
    near(end, V(end.x, 2.5), 1e-7);
    const s = spline([
      [0, 0],
      [3, 5],
      [6, 0],
    ]);
    const rs = extendEntity(s, [wall], V(5.8, 0.5));
    const so = rs.replace![0] as SplineEntity;
    const ps = entityPath(so)!;
    expect(pathNearest(ps, V(10, -8 / 1.5 * 0)).d).toBeGreaterThanOrEqual(0);
    const f = flattenPath(ps, 1e-3);
    expect(f.at(-1)!.x).toBeCloseTo(10);
    renders(doc, [o, so]);
  });
  it('원·닫힌 객체는 늘일 수 없다', () => {
    expect(extendEntity(circle(0, 0, 1), [wall], V(1, 0)).message).toBe('이 객체는 연장할 수 없습니다.');
  });
});

describe('breakEntity', () => {
  it('선: 두 점 사이를 지운다, 한 점이면 둘로', () => {
    const l = line(0, 0, 10, 0);
    const r = breakEntity(l, V(3, 1), V(6, -1));
    near((r.replace![0] as LineEntity).end, P(3, 0));
    near((r.add![0] as LineEntity).start, P(6, 0));
    const r2 = breakEntity(l, V(4, 0), V(4, 0));
    expect(all(r2).length).toBe(2);
    near((r2.replace![0] as LineEntity).end, P(4, 0));
    near((r2.add![0] as LineEntity).start, P(4, 0));
    // 끝 너머를 고르면 그 쪽은 다 지운다
    const r3 = breakEntity(l, V(6, 0), V(20, 0));
    expect(all(r3).length).toBe(1);
    near((r3.replace![0] as LineEntity).end, P(6, 0));
  });
  it('원: 첫 점에서 둘째 점까지 반시계를 지운다', () => {
    const c = circle(0, 0, 5);
    const r = breakEntity(c, V(5, 0), V(0, 5));
    const a = r.add![0] as ArcEntity;
    expect(r.remove).toEqual([c.handle]);
    expect(a.startAngle).toBeCloseTo(deg(90));
    expect(a.endAngle).toBeCloseTo(0);
    expect(breakEntity(c, V(5, 0), V(5, 0)).message).toBe('호는 360도가 될 수 없습니다.');
    // −Z 원도 WCS 반시계
    const n = circle(0, 0, 5, NEG_Z);
    const an = breakEntity(n, V(5, 0), V(0, 5)).add![0] as ArcEntity;
    expect(an.extrusion).toBeUndefined();
    expect(an.startAngle).toBeCloseTo(deg(90));
    renders(doc, [a, an]);
  });
  it('호·타원', () => {
    const a = arc(0, 0, 5, 0, 180);
    const r = breakEntity(a, V(5 * Math.cos(deg(60)), 5 * Math.sin(deg(60))), V(5 * Math.cos(deg(120)), 5 * Math.sin(deg(120))));
    expect(all(r).length).toBe(2);
    expect((r.replace![0] as ArcEntity).endAngle).toBeCloseTo(deg(60));
    expect((r.add![0] as ArcEntity).startAngle).toBeCloseTo(deg(120));
    const el = ellipse(0, 0, 6, 0, 0.5);
    const re = breakEntity(el, V(6, 0), V(0, 3));
    const eo = all(re)[0] as EllipseEntity;
    expect(eo.startParam).toBeCloseTo(Math.PI / 2);
    expect(eo.endParam).toBeCloseTo(2 * Math.PI);
  });
  it('닫힌 폴리선: 한 점에서 열기, 두 점 사이 지우기', () => {
    const sq = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    );
    const r = breakEntity(sq, V(5, 0), V(5, 0));
    const o = r.replace![0] as LwPolylineEntity;
    expect(o.closed).toBe(false);
    near(lwVertices(o)[0]!, V(5, 0));
    near(lwVertices(o).at(-1)!, V(5, 0));
    samePath(sq, o);
    const r2 = breakEntity(sq, V(5, 0), V(10, 5));
    const o2 = r2.replace![0] as LwPolylineEntity;
    expect(pathLength(entityPath(o2)!)).toBeCloseTo(30);
  });
  it('구성선은 두 광선', () => {
    const r = breakEntity(xline(0, 0, 1, 0), V(-2, 0), V(3, 0));
    const rays = all(r) as XLineEntity[];
    expect(rays.length).toBe(2);
    expect(rays.every((x) => x.type === 'RAY')).toBe(true);
  });
});

describe('lengthenEntity', () => {
  it('선: 증분·전체·백분율, 고른 쪽 끝', () => {
    const l = line(0, 0, 10, 0);
    near((lengthenEntity(l, { delta: 2 }, V(9, 0)).replace![0] as LineEntity).end, P(12, 0));
    near((lengthenEntity(l, { delta: 2 }, V(1, 0)).replace![0] as LineEntity).start, P(-2, 0));
    near((lengthenEntity(l, { delta: -3 }, V(9, 0)).replace![0] as LineEntity).end, P(7, 0));
    near((lengthenEntity(l, { total: 4 }, V(9, 0)).replace![0] as LineEntity).end, P(4, 0));
    near((lengthenEntity(l, { percent: 150 }, V(9, 0)).replace![0] as LineEntity).end, P(15, 0));
    expect(lengthenEntity(l, { delta: -10 }, V(9, 0)).message).toBe('길이가 너무 짧습니다.');
  });
  it('호: 각도 증분·전체 각도, 너무 길면 안내', () => {
    const a = arc(0, 0, 5, 0, 90);
    const o = lengthenEntity(a, { angleDelta: deg(30) }, V(0, 5)).replace![0] as ArcEntity;
    expect(o.endAngle).toBeCloseTo(deg(120));
    const o2 = lengthenEntity(a, { delta: (5 * Math.PI) / 2 }, V(5, 0)).replace![0] as ArcEntity;
    expect(o2.startAngle).toBeCloseTo(deg(270));
    expect(lengthenEntity(a, { angleDelta: deg(300) }, V(0, 5)).message).toBe('호의 길이가 원 둘레보다 길 수 없습니다.');
    const n = arc(0, 0, 5, 0, 90, NEG_Z);
    const on = lengthenEntity(n, { angleDelta: deg(30) }, V(0, 5)).replace![0] as ArcEntity;
    // WCS 90°..180°의 90° 쪽 끝을 늘이면 60°
    expect(on.startAngle).toBeCloseTo(deg(60));
    expect(on.extrusion).toBeUndefined();
  });
  it('폴리선 끝 세그먼트·타원형 호·스플라인', () => {
    const p = lw([
      [0, 0],
      [5, 0],
      [5, 5],
    ]);
    const o = lengthenEntity(p, { delta: 2 }, V(5, 4)).replace![0] as LwPolylineEntity;
    near(lwVertices(o)[2]!, V(5, 7));
    const os = lengthenEntity(p, { delta: -7 }, V(5, 4)).replace![0] as LwPolylineEntity;
    expect(lwVertices(os).length).toBe(2);
    near(lwVertices(os)[1]!, V(3, 0));
    const ea = ellipse(0, 0, 6, 0, 0.5, 0, Math.PI / 2);
    const L0 = pathLength(entityPath(ea)!);
    const oe = lengthenEntity(ea, { delta: 1 }, V(0, 3)).replace![0] as EllipseEntity;
    expect(pathLength(entityPath(oe)!)).toBeCloseTo(L0 + 1, 6);
    const s = spline([
      [0, 0],
      [3, 5],
      [6, 0],
    ]);
    const Ls = pathLength(entityPath(s)!);
    const so = all(lengthenEntity(s, { delta: 2 }, V(6, 0)))[0]!;
    expect(pathLength(entityPath(so)!)).toBeCloseTo(Ls + 2, 4);
    const sh = all(lengthenEntity(s, { delta: -2 }, V(6, 0)))[0]!;
    expect(pathLength(entityPath(sh)!)).toBeCloseTo(Ls - 2, 4);
    renders(doc, [o, os, oe, so, sh]);
  });
});
