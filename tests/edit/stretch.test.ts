import { describe, expect, it } from 'vitest';
import type {
  ArcEntity,
  CircleEntity,
  DimensionEntity,
  Entity,
  HatchEntity,
  InsertEntity,
  LeaderEntity,
  LineEntity,
  LwPolylineEntity,
  SplineEntity,
  TextEntity,
} from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { stretch } from '../../src/edit/geom/stretch';
import { arrayPolar, arrayRectangular } from '../../src/edit/geom/array';
import { entityPath } from '../../src/edit/geom/path';
import { pathNearest } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, arc, circle, deg, fitSpline, line, lw, mtext, near, newDoc, renders, spline, text } from './helpers';
import { lwVertices } from '../../src/core/lwpoly';

const doc = newDoc();
const win = [V(4, -1), V(20, 20)]; // x ≥ 4 쪽을 덮는 걸침 창
const D = V(3, 1);

function linearDim(): DimensionEntity {
  return {
    type: 'DIMENSION',
    ...entityDefaults(),
    handle: 'DM1',
    block: '*D9',
    dimStyle: 'Standard',
    dimType: 32,
    defPoint: P(5, 3),
    textMid: P(2.5, 3.5),
    defPoint2: P(0, 0),
    defPoint3: P(5, 0),
    defPoint4: P(0, 0),
    defPoint5: P(0, 0),
    text: '',
    measurement: 5,
    rotation: 0,
    obliqueAngle: 0,
    textRotation: 0,
    horizontalDirection: 0,
    attachment: 5,
    leaderLength: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
  };
}

describe('stretch', () => {
  it('선: 안의 끝점만 옮긴다, 전부 안이면 이동', () => {
    const l = line(0, 0, 5, 0);
    const r = stretch([l], win, D, doc);
    const o = r.replace![0] as LineEntity;
    near(o.start, P(0, 0));
    near(o.end, P(8, 1));
    const m = stretch([line(5, 0, 6, 0)], win, D, doc).replace![0] as LineEntity;
    near(m.start, P(8, 1));
    near(m.end, P(9, 1));
    expect(stretch([line(0, 0, 1, 0)], win, D, doc).replace).toBeUndefined();
  });
  it('다각형 걸침 영역', () => {
    const tri = [V(4, -1), V(10, -1), V(10, 10)];
    const r = stretch([line(0, 0, 9, 0)], tri, D, doc);
    near((r.replace![0] as LineEntity).end, P(12, 1));
  });
  it('호: 현의 높이를 지킨다(−Z 포함)', () => {
    const a = arc(0, 0, 5, 0, 180) as ArcEntity; // (5,0) → (−5,0), 높이 5
    const r = stretch([a], win, V(3, 0), doc);
    const o = r.replace![0] as ArcEntity;
    expect(o.handle).toBe(a.handle);
    const p = entityPath(o)!;
    const ends = [p.pieces[0]!, p.pieces[0]!];
    void ends;
    // 새 끝점 (8, 0)과 (−5, 0), 현 13, 높이 5
    expect(pathNearest(p, V(8, 0)).d).toBeLessThan(1e-9);
    expect(pathNearest(p, V(-5, 0)).d).toBeLessThan(1e-9);
    expect(pathNearest(p, V(1.5, 5)).d).toBeLessThan(1e-9);
    const n = arc(0, 0, 5, 0, 180, NEG_Z); // WCS: (−5,0) → (5,0) 위쪽
    const on = stretch([n], win, V(3, 0), doc).replace![0] as ArcEntity;
    expect(on.extrusion).toBeUndefined();
    expect(pathNearest(entityPath(on)!, V(1.5, 5)).d).toBeLessThan(1e-9);
    renders(doc, [o, on]);
  });
  it('원·문자·블록 참조: 중심·삽입점이 안이면 이동', () => {
    const c = circle(5, 0, 2);
    expect((stretch([c], win, D, doc).replace![0] as CircleEntity).center.x).toBeCloseTo(8);
    expect(stretch([circle(0, 0, 5)], win, D, doc).replace).toBeUndefined();
    const t = text(5, 5, 'A');
    near((stretch([t], win, D, doc).replace![0] as TextEntity).insert, P(8, 6));
    const m = mtext(5, 5, 'A');
    expect(stretch([m], win, D, doc).replace!.length).toBe(1);
  });
  it('폴리선: 안의 정점만', () => {
    const p = lw([
      [0, 0],
      [5, 0, 0.3],
      [5, 5],
      [0, 5],
    ]);
    const o = stretch([p], win, D, doc).replace![0] as LwPolylineEntity;
    near(lwVertices(o)[0]!, V(0, 0));
    near(lwVertices(o)[1]!, V(8, 1));
    near(lwVertices(o)[2]!, V(8, 6));
    expect(lwVertices(o)[1]!.bulge).toBeCloseTo(0.3);
    const n = lw([[0, 0], [-5, 0]], false, NEG_Z); // WCS (0,0) → (5,0)
    const on = stretch([n], win, D, doc).replace![0] as LwPolylineEntity;
    expect(entityPath(on)!.pieces[0]!.k).toBe('line');
    expect(pathNearest(entityPath(on)!, V(8, 1)).d).toBeLessThan(1e-9);
  });
  it('스플라인: 조정점(맞춤 데이터는 버림)·맞춤점(조정점을 다시 구함)', () => {
    const s = spline([
      [0, 0],
      [3, 5],
      [6, 0],
    ]) as SplineEntity;
    const o = stretch([s], win, D, doc).replace![0] as SplineEntity;
    near(o.controlPoints[2]!, P(9, 1));
    near(o.controlPoints[0]!, P(0, 0));
    const f = fitSpline([
      [0, 0],
      [3, 4],
      [7, 1],
    ]) as SplineEntity;
    const of = stretch([f], win, D, doc).replace![0] as SplineEntity;
    near(of.fitPoints[2]!, P(10, 2));
    renders(doc, [o, of]);
  });
  it('치수: 정의점을 옮기고 측정값을 다시 잰다', () => {
    const d = newDoc();
    d.blocks.set('*D9', { name: '*D9', handle: 'X1', recordHandle: 'X2', basePoint: P(0, 0), flags: 1, entities: [line(0, 3, 5, 3), line(5, 0.6, 5, 4), mtext(2.5, 3.5, '5', 2.5, { attachment: 8 })] });
    const dm = linearDim();
    const r = stretch([dm], [V(4, -1), V(10, 10)], V(3, 0), d);
    const o = r.replace![0] as DimensionEntity;
    near(o.defPoint3, P(8, 0));
    near(o.defPoint, P(8, 3));
    expect(o.measurement).toBeCloseTo(8);
    expect(o.block).not.toBe('*D9');
    expect(r.blocks!.length).toBe(1);
    d.blocks.set(r.blocks![0]!.name.toUpperCase(), r.blocks![0]!);
    renders(d, [o]);
  });
  it('지시선·해치', () => {
    const ld: LeaderEntity = { type: 'LEADER', ...entityDefaults(), handle: 'LD', dimStyle: 'Standard', vertices: [P(0, 0), P(5, 5)], arrowHead: true, pathType: 0, creation: 3, hooklineDirection: 0, hookline: false, textHeight: 0, textWidth: 0 };
    const o = stretch([ld], win, D, doc).replace![0] as LeaderEntity;
    near(o.vertices[1]!, P(8, 6));
    const h: HatchEntity = {
      type: 'HATCH',
      ...entityDefaults(),
      handle: 'H',
      patternName: 'SOLID',
      solid: true,
      associative: true,
      hatchStyle: 0,
      patternType: 1,
      patternAngle: 0,
      patternScale: 1,
      patternDouble: false,
      elevation: 0,
      paths: [{ flags: 3, polyline: { closed: true, vertices: [V(0, 0), V(5, 0), V(5, 5), V(0, 5)].map((p) => ({ ...p, bulge: 0 })) }, sources: ['X'] }],
      patternLines: [],
      pixelSize: 0,
      seedPoints: [],
    };
    const oh = stretch([h], win, D, doc).replace![0] as HatchEntity;
    near(oh.paths[0]!.polyline!.vertices[1]!, V(8, 1));
    expect(oh.associative).toBe(false);
    renders(doc, [o, oh]);
  });
});

describe('arrayRectangular·arrayPolar', () => {
  it('직사각형: 행 × 열 − 1개 복사본', () => {
    const r = arrayRectangular([circle(0, 0, 1)], 3, 4, 10, 5, 0, doc);
    expect(r.add!.length).toBe(11);
    const cs = r.add!.map((e) => (e as CircleEntity).center);
    expect(cs.some((c) => Math.abs(c.x - 15) < 1e-9 && Math.abs(c.y - 20) < 1e-9)).toBe(true);
    expect(r.add!.every((e) => e.handle === '')).toBe(true);
    // 각도
    const a = arrayRectangular([circle(0, 0, 1)], 1, 2, 0, 10, deg(90), doc);
    near((a.add![0] as CircleEntity).center, P(0, 10));
  });
  it('원형: 360°는 개수로 나누고, 회전하지 않으면 기준점만 따라 돈다', () => {
    const r = arrayPolar([line(10, 0, 12, 0)], V(0, 0), 4, 2 * Math.PI, true, doc);
    expect(r.add!.length).toBe(3);
    const l1 = r.add![0] as LineEntity;
    near(l1.start, P(0, 10));
    near(l1.end, P(0, 12));
    const n = arrayPolar([line(10, 0, 12, 0)], V(0, 0), 4, 2 * Math.PI, false, doc);
    const n1 = n.add![0] as LineEntity;
    // 기준점 = 범위 중심 (11, 0) → (0, 11): 선은 돌지 않는다
    near(n1.start, P(-1, 11));
    near(n1.end, P(1, 11));
    // 채울 각도 180°, 개수 3: 90° 간격
    const h = arrayPolar([circle(10, 0, 1)], V(0, 0), 3, Math.PI, true, doc);
    near((h.add![1] as CircleEntity).center, P(-10, 0));
    const cw = arrayPolar([circle(10, 0, 1)], V(0, 0), 2, -Math.PI / 2, true, doc);
    near((cw.add![0] as CircleEntity).center, P(0, -10));
  });
  it('블록 참조·문자도 복사', () => {
    const ins = { type: 'INSERT', ...entityDefaults(), handle: 'I', block: 'X', insert: P(1, 0), scale: P(1, 1, 1), rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as InsertEntity;
    const r = arrayPolar([ins, text(1, 0, 'A') as Entity], V(0, 0), 4, 2 * Math.PI, true, doc);
    expect(r.add!.length).toBe(6);
    expect((r.add![0] as InsertEntity).rotation).toBeCloseTo(deg(90));
  });
});
