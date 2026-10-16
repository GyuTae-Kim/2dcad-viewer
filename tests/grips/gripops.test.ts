/** 다기능 그립 커널(src/edit/geom/gripops.ts)과 그립 목록·신축의 새 종류(가리기·이미지·치수 문자 DIMTMOVE) */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, DimensionEntity, Entity, ImageEntity, LineEntity, LwPolylineEntity, PolylineEntity, SplineEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { lwVertices } from '../../src/core/lwpoly';
import { createLinearDimension } from '../../src/edit/dim';
import { arc3, gripMove, gripPoints } from '../../src/edit/geom/grips';
import {
  arcRadiusGrip,
  arcRadiusKeepEnds,
  dimTextHome,
  dimTextMoveGrip,
  dimTextVertical,
  gripDims,
  gripMoveMany,
  gripStretchValue,
  gripTakesValue,
  lengthenGrip,
  lengthenGripTo,
  polyAddVertex,
  polyRemoveVertex,
  polySegmentIsArc,
  polySegmentToArc,
  polySegmentToLine,
  splineCvDeleteGrip,
  splineCvInsertGrip,
  splineCvRefineGrip,
  splineFitAddGrip,
  splineFitDeleteGrip,
  splineFitTangentGrip,
} from '../../src/edit/geom/gripops';
import { makeWipeout, wipeoutPolygon } from '../../src/edit/geom/markup';
import { entityPath, splineNurbs } from '../../src/edit/geom/path';
import { pieceAt } from '../../src/edit/geom/curve';
import { nurbsPoint } from '../../src/edit/geom/nurbs';
import { P, V, arc, ellipse, fitSpline, line, lw, near, newDoc, poly2d, renders, spline } from '../edit/helpers';

const doc = newDoc();
const one = (r: { replace?: Entity[]; add?: Entity[]; message?: string }): Entity => {
  if (!r.replace?.length && !r.add?.length) throw new Error(r.message ?? '결과 없음');
  return (r.replace ?? r.add)![0]!;
};
const verts = (e: Entity) => lwVertices(e as LwPolylineEntity);
const xy = (e: Entity) => verts(e).map((v) => [v.x, v.y]);

describe('폴리선 정점 추가·제거', () => {
  it('정점 그립: 다음 정점과의 사이, 열린 폴리선의 첫·마지막 정점은 연장', () => {
    const pl = lw([[0, 0], [10, 0], [10, 10]]);
    expect(xy(one(polyAddVertex(pl, 'v1', V(12, 5))))).toEqual([[0, 0], [10, 0], [12, 5], [10, 10]]);
    expect(xy(one(polyAddVertex(pl, 'v2', V(0, 10))))).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(xy(one(polyAddVertex(pl, 'v0', V(-5, 0))))).toEqual([[-5, 0], [0, 0], [10, 0], [10, 10]]);
    // 닫힌 폴리선의 마지막 정점: 닫는 세그먼트를 나눈다
    const cl = lw([[0, 0], [10, 0], [10, 10]], true);
    expect(xy(one(polyAddVertex(cl, 'v2', V(3, 8))))).toEqual([[0, 0], [10, 0], [10, 10], [3, 8]]);
  });
  it('세그먼트 중간 그립: 직선은 두 직선, 호는 세 점을 지나는 원 위의 두 호', () => {
    const pl = lw([[0, 0], [10, 0], [10, 10]]);
    expect(xy(one(polyAddVertex(pl, 'm0', V(5, 2))))).toEqual([[0, 0], [5, 2], [10, 0], [10, 10]]);
    // 반원 호 세그먼트(볼록 1)를 원 위의 점에서 나누면 같은 원의 두 사분원
    const ar = lw([[0, 0, 1], [10, 0]]);
    const r = verts(one(polyAddVertex(ar, 'm0', V(5, -5))));
    expect(r.length).toBe(3);
    expect(r[0]!.bulge).toBeCloseTo(Math.tan(Math.PI / 8));
    expect(r[1]!.bulge).toBeCloseTo(Math.tan(Math.PI / 8));
    // 원 밖의 점: a·q·b를 지나는 원
    const r2 = verts(one(polyAddVertex(ar, 'm0', V(5, -8))));
    const c = arc3(r2[0]!, r2[1]!, r2[2]!)!;
    expect(Math.sign(c.sw)).toBe(1);
    renders(doc, [one(polyAddVertex(ar, 'm0', V(5, -8)))]);
  });
  it('폭: 나뉜 세그먼트는 길이 비율로, 제거하면 앞 시작 폭에서 뒤 끝 폭으로', () => {
    const pl = lw([[0, 0], [10, 0], [20, 0]]) as LwPolylineEntity;
    pl.widths = [0, 2, 4, 6, 0, 0];
    const a = verts(one(polyAddVertex(pl, 'm0', V(2.5, 0))));
    expect(a.map((v) => [v.startWidth, v.endWidth])).toEqual([[0, 0.5], [0.5, 2], [4, 6], [0, 0]]);
    const b = verts(one(polyRemoveVertex(pl, 'v1')));
    expect(b.map((v) => [v.x, v.startWidth, v.endWidth])).toEqual([[0, 0, 6], [20, 0, 0]]);
  });
  it('정점 제거: 두 세그먼트는 직선 하나, 끝 정점, 최소 2개', () => {
    const pl = lw([[0, 0, 0.5], [10, 0, 0.3], [10, 10], [0, 10]]);
    const r = verts(one(polyRemoveVertex(pl, 'v1')));
    expect(r.map((v) => [v.x, v.y, v.bulge])).toEqual([[0, 0, 0], [10, 10, 0], [0, 10, 0]]);
    expect(xy(one(polyRemoveVertex(pl, 'v0')))).toEqual([[10, 0], [10, 10], [0, 10]]);
    expect(xy(one(polyRemoveVertex(pl, 'v3')))).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(polyRemoveVertex(lw([[0, 0], [1, 0]]), 'v0').message).toBeTruthy();
  });
  it('호로·선으로 변환', () => {
    const pl = lw([[0, 0], [10, 0], [10, 10]]);
    const a = one(polySegmentToArc(pl, 'm0', V(5, 5)));
    expect(verts(a)[0]!.bulge).toBeCloseTo(-1);
    expect(polySegmentIsArc(a, 0)).toBe(true);
    expect(polySegmentIsArc(a, 1)).toBe(false);
    expect(verts(one(polySegmentToLine(a, 'm0')))[0]!.bulge).toBe(0);
    expect(polySegmentToArc(pl, 'm0', V(5, 0)).message).toBeTruthy();
  });
  it('구형 2D 폴리선도 같다(정점 플래그·Z를 잇는다)', () => {
    const p = poly2d([[0, 0], [10, 0], [10, 10]]) as PolylineEntity;
    p.vertices.forEach((v) => (v.location.z = 3));
    const r = one(polyAddVertex(p, 'm1', V(12, 5))) as PolylineEntity;
    expect(r.vertices.map((v) => [v.location.x, v.location.y, v.location.z])).toEqual([[0, 0, 3], [10, 0, 3], [12, 5, 3], [10, 10, 3]]);
    expect((one(polyRemoveVertex(p, 'v1')) as PolylineEntity).vertices.length).toBe(2);
  });
});

describe('선·호 길이 조정, 반지름', () => {
  it('선: 선 방향으로만', () => {
    const l = line(0, 0, 10, 0);
    near((one(lengthenGrip(l, 'end', V(15, 7), doc)) as LineEntity).end, P(15, 0));
    near((one(lengthenGrip(l, 'start', V(-3, 4), doc)) as LineEntity).start, P(-3, 0));
    expect(lengthenGrip(l, 'end', V(-1, 0), doc).message).toBeTruthy();
    near((one(lengthenGripTo(l, 'end', 25, doc)) as LineEntity).end, P(25, 0));
  });
  it('호: 끝 각도를 점 쪽으로(중심·반지름 유지)', () => {
    const a = arc(0, 0, 5, 0, 90) as ArcEntity;
    const r = one(lengthenGrip(a, 'end', V(-3, 3), doc)) as ArcEntity;
    expect(r.radius).toBeCloseTo(5);
    expect(r.startAngle).toBeCloseTo(0);
    expect(r.endAngle).toBeCloseTo((135 * Math.PI) / 180);
    const s = one(lengthenGrip(a, 'start', V(3, -3), doc)) as ArcEntity;
    expect(s.startAngle).toBeCloseTo((315 * Math.PI) / 180);
    expect(s.endAngle).toBeCloseTo(Math.PI / 2);
    const t = one(lengthenGripTo(a, 'end', 5 * Math.PI, doc)) as ArcEntity;
    expect(t.endAngle).toBeCloseTo(Math.PI);
  });
  it('타원형 호 끝: 신축과 같다', () => {
    const el = ellipse(0, 0, 4, 0, 0.5, 0, Math.PI / 2);
    expect(one(lengthenGrip(el, 'end', V(-4, 0.5), doc))).toEqual(one(gripMove(el, 'end', V(-4, 0.5), doc)));
  });
  it('호 반지름: 중심·각도 유지 / 두 끝 유지', () => {
    const a = arc(0, 0, 5, 0, 90) as ArcEntity;
    const r = one(arcRadiusGrip(a, V(8, 8), doc)) as ArcEntity;
    expect(r.radius).toBeCloseTo(Math.hypot(8, 8));
    near(r.center, P(0, 0));
    const k = one(arcRadiusKeepEnds(a, 10)) as ArcEntity;
    expect(k.radius).toBeCloseTo(10);
    const pc = entityPath(k)!.pieces[0]!;
    near(pieceAt(pc, 0), V(5, 0), 1e-9);
    near(pieceAt(pc, 1), V(0, 5), 1e-9);
    expect(arcRadiusKeepEnds(a, 3).message).toBeTruthy();
  });
});

describe('스플라인 그립', () => {
  it('맞춤점 추가·제거·끝 접선', () => {
    const s = fitSpline([[0, 0], [5, 5], [10, 0]]) as SplineEntity;
    const a = one(splineFitAddGrip(s, 0, V(2, 4))) as SplineEntity;
    expect(a.fitPoints.map((p) => [p.x, p.y])).toEqual([[0, 0], [2, 4], [5, 5], [10, 0]]);
    expect((one(splineFitDeleteGrip(s, 1)) as SplineEntity).fitPoints.length).toBe(2);
    const t = one(splineFitTangentGrip(s, 0, V(0, 10))) as SplineEntity;
    near(t.startTangent!, P(0, 1));
    const e = one(splineFitTangentGrip(s, 2, V(20, 0))) as SplineEntity;
    near(e.endTangent!, P(1, 0));
    expect(splineFitTangentGrip(s, 1, V(0, 0)).message).toBeTruthy();
  });
  it('정점 추가(새 정점이 그 점), 정련(모양 유지), 제거', () => {
    const s = spline([[0, 0], [3, 5], [7, 5], [10, 0]]) as SplineEntity;
    const a = one(splineCvInsertGrip(s, 1, V(5, 9))) as SplineEntity;
    expect(a.controlPoints.length).toBe(5);
    near(a.controlPoints[2]!, P(5, 9));
    const r = one(splineCvRefineGrip(s, 1)) as SplineEntity;
    expect(r.controlPoints.length).toBe(5);
    const n0 = splineNurbs(s)!;
    const n1 = splineNurbs(r)!;
    for (const u of [0.1, 0.35, 0.5, 0.8]) near(nurbsPoint(n1, u), nurbsPoint(n0, u), 1e-9);
    const d = one(splineCvDeleteGrip(a, 2)) as SplineEntity;
    expect(d.controlPoints.length).toBe(4);
    expect(d.knots.length).toBe(4 + d.degree + 1);
    // 안쪽 매듭이 없으면 차수를 내린다
    const b = one(splineCvDeleteGrip(s, 1)) as SplineEntity;
    expect(b.controlPoints.length).toBe(3);
    expect(b.degree).toBe(2);
    renders(doc, [a, r, d, b]);
  });
});

describe('치수 문자', () => {
  const dd = newDoc();
  const dim = () => createLinearDimension(dd, P(0, 0), P(10, 0), P(5, 5));
  it('DIMTMOVE 재지정으로 옮긴다: 0이면 치수선이 따라오고, 2면 문자만', () => {
    const d = dim();
    const a = one(dimTextMoveGrip(d, 0, V(5, 9), dd)) as DimensionEntity;
    expect(a.overrides?.[279]).toBe(0);
    expect(a.dimType & 128).toBe(128);
    expect(a.defPoint.y).toBeGreaterThan(d.defPoint.y + 2);
    const b = one(dimTextMoveGrip(d, 2, V(5, 9), dd)) as DimensionEntity;
    expect(b.overrides?.[279]).toBe(2);
    expect(b.defPoint.y).toBeCloseTo(d.defPoint.y);
    near(b.textMid, P(5, 9), 1e-6);
  });
  it('신축(문자 그립)도 DIMTMOVE를 따른다', () => {
    const d = dim();
    const r = one(gripMove(d, 'textMid', V(5, 9), dd)) as DimensionEntity;
    expect(r.defPoint.y).toBeGreaterThan(d.defPoint.y + 2);
    const t = { ...d, overrides: { 279: 2 } } as DimensionEntity;
    expect((one(gripMove(t, 'textMid', V(5, 9), dd)) as DimensionEntity).defPoint.y).toBeCloseTo(d.defPoint.y);
  });
  it('문자 위치 재설정·치수선 위·수직 가운데', () => {
    const d = { ...dim(), dimType: dim().dimType | 128 } as DimensionEntity;
    expect((one(dimTextHome(d)) as DimensionEntity).dimType & 128).toBe(0);
    const v = one(dimTextVertical(d, 1)) as DimensionEntity;
    expect(v.overrides?.[77]).toBe(1);
    expect(v.dimType & 128).toBe(0);
    expect((one(dimTextVertical(d, 0)) as DimensionEntity).overrides?.[77]).toBe(0);
  });
});

describe('신축 중 값 입력(동적 치수)', () => {
  it('선분 길이: 커서 방향(없으면 지금 방향)', () => {
    const l = line(0, 0, 10, 0);
    expect(gripTakesValue(l, 'end')).toBe(true);
    expect(gripTakesValue(l, 'mid')).toBe(false);
    near((one(gripStretchValue(l, 'end', 7, null, doc)!) as LineEntity).end, P(7, 0));
    near((one(gripStretchValue(l, 'end', 5, V(3, 4), doc)!) as LineEntity).end, P(3, 4));
    near((one(gripStretchValue(l, 'start', 4, V(10, 8), doc)!) as LineEntity).start, P(10, 4));
    expect(gripStretchValue(l, 'mid', 4, null, doc)).toBeNull();
  });
  it('호 끝 = 호 길이, 호 중간 = 두 끝을 지킨 반지름', () => {
    const a = arc(0, 0, 5, 0, 90) as ArcEntity;
    const e = one(gripStretchValue(a, 'end', 5 * Math.PI, null, doc)!) as ArcEntity;
    expect(e.endAngle).toBeCloseTo(Math.PI);
    expect((one(gripStretchValue(a, 'mid', 12, null, doc)!) as ArcEntity).radius).toBeCloseTo(12);
  });
  it('폴리선 정점 = 앞 세그먼트 길이(첫 정점은 다음 세그먼트)', () => {
    const pl = lw([[0, 0], [10, 0], [10, 10]]);
    expect(xy(one(gripStretchValue(pl, 'v2', 4, null, doc)!))).toEqual([[0, 0], [10, 0], [10, 4]]);
    expect(xy(one(gripStretchValue(pl, 'v0', 3, null, doc)!))).toEqual([[7, 0], [10, 0], [10, 10]]);
  });
  it('동적 치수 형상', () => {
    const l = line(0, 0, 10, 0);
    const after = one(gripMove(l, 'end', V(6, 8), doc));
    const d = gripDims(l, 'end', after);
    expect(d).toEqual([{ kind: 'aligned', a: P(0, 0), b: P(6, 8) }]);
    const a = arc(0, 0, 5, 0, 90);
    expect(gripDims(a, 'mid', a)[0]!.kind).toBe('radius');
    expect(gripDims(a, 'end', a)[0]!.kind).toBe('arc');
    const pl = lw([[0, 0], [10, 0], [10, 10]]);
    expect(gripDims(pl, 'v1', pl).length).toBe(2);
    expect(gripDims(pl, 'm0', pl).length).toBe(0);
  });
});

describe('여러 핫 그립, 가리기·이미지 그립', () => {
  it('한 객체의 여러 그립을 같은 변위로', () => {
    const pl = lw([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const r = gripMoveMany(pl, [{ id: 'v1', to: V(12, 1) }, { id: 'v2', to: V(12, 11) }], doc);
    expect(xy(one(r))).toEqual([[0, 0], [12, 1], [12, 11], [0, 10]]);
    const l = line(0, 0, 10, 0);
    const m = one(gripMoveMany(l, [{ id: 'start', to: V(1, 2) }, { id: 'end', to: V(11, 2) }], doc)) as LineEntity;
    near(m.start, P(1, 2));
    near(m.end, P(11, 2));
  });
  it('가리기: 경계 꼭짓점 그립으로 그 꼭짓점을 신축', () => {
    const w = makeWipeout({ ...entityDefaults(), handle: 'W1' }, [V(0, 0), V(10, 0), V(10, 5), V(0, 5)])!;
    const g = gripPoints(w, doc);
    expect(g.map((x) => x.id)).toEqual(['v0', 'v1', 'v2', 'v3']);
    near(g[2]!.point, V(10, 5), 1e-9);
    const r = one(gripMove(w, 'v2', V(14, 8), doc)) as ImageEntity;
    expect(r.handle).toBe('W1');
    const poly = wipeoutPolygon(r);
    expect(poly.length).toBe(4);
    near(poly[2]!, V(14, 8), 1e-9);
    near(poly[0]!, V(0, 0), 1e-9);
  });
  it('자르지 않은 이미지: 구석 그립은 맞은편 구석을 두고 비율을 지킨 축척', () => {
    const im: ImageEntity = {
      type: 'IMAGE',
      ...entityDefaults(),
      handle: 'IM',
      insert: P(0, 0),
      uVector: P(0.1, 0),
      vVector: P(0, 0.1),
      imageSize: V(100, 50),
      displayFlags: 7,
      clipping: false,
      brightness: 50,
      contrast: 50,
      fade: 0,
      clipBoundaryType: 1,
      clipBoundary: [V(-0.5, -0.5), V(99.5, 49.5)],
    };
    const g = gripPoints(im, doc);
    expect(g.map((x) => x.id)).toEqual(['v0', 'v1', 'v2', 'v3']);
    near(g[2]!.point, V(10, 5), 1e-9);
    const r = one(gripMove(im, 'v2', V(20, 7), doc)) as ImageEntity;
    near(r.insert, P(0, 0), 1e-9);
    const k = (20 * 10 + 7 * 5) / (10 * 10 + 5 * 5);
    expect(r.uVector.x).toBeCloseTo(0.1 * k);
    expect(r.vVector.y).toBeCloseTo(0.1 * k);
    // 자른 이미지는 삽입점 그립 하나
    expect(gripPoints({ ...im, clipping: true }, doc).map((x) => x.id)).toEqual(['ins']);
  });
});
