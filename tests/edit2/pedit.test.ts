import { describe, expect, it } from 'vitest';
import type { LwPolylineEntity, PolylineEntity, SplineEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { flattenPath, pathNearest, pieceTangent } from '../../src/edit/geom/curve';
import { entityPath } from '../../src/edit/geom/path';
import {
  biarc,
  decurve,
  fitPolyline,
  frameVerts,
  insertVertex,
  moveVertex,
  removeVertex,
  setClosed,
  setSegmentWidth,
  setWidth,
  splinePolyline,
  splineToPolyline,
  toPolyline,
} from '../../src/edit/geom/pedit';
import { V, arc, line, lw, near, newDoc, poly2d, renders } from '../edit/helpers';
import { lwVertices } from '../../src/core/lwpoly';

const doc = newDoc();
const zig = () =>
  lw([
    [0, 0],
    [10, 5],
    [20, 0],
    [30, 5],
  ]) as LwPolylineEntity;

describe('PEDIT 변환', () => {
  it('선 → LWPOLYLINE', () => {
    const p = toPolyline(line(0, 0, 5, 5))!;
    expect(lwVertices(p).length).toBe(2);
    near(lwVertices(p)[1]!, V(5, 5));
  });
  it('호 → 볼록도 폴리선(같은 곡선)', () => {
    const a = arc(1, 1, 5, 30, 300);
    const p = toPolyline(a)!;
    const pa = entityPath(a)!;
    const pp = entityPath(p)!;
    for (const q of flattenPath(pp, 1e-3)) expect(pathNearest(pa, q).d).toBeLessThan(1e-9);
    for (const q of flattenPath(pa, 1e-3)) expect(pathNearest(pp, q).d).toBeLessThan(1e-9);
  });
  it('스플라인 → 폴리선(정밀도)', () => {
    const s: SplineEntity = {
      type: 'SPLINE',
      ...entityDefaults(),
      handle: 'S',
      flags: 8,
      degree: 3,
      knots: [0, 0, 0, 0, 1, 2, 2, 2, 2],
      controlPoints: [
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 10, z: 0 },
        { x: 10, y: -5, z: 0 },
        { x: 15, y: 5, z: 0 },
        { x: 20, y: 0, z: 0 },
      ],
      fitPoints: [],
      knotTolerance: 1e-10,
      controlTolerance: 1e-10,
      fitTolerance: 1e-10,
    };
    const p = splineToPolyline(s, 4) as LwPolylineEntity;
    expect(p.type).toBe('LWPOLYLINE');
    expect(lwVertices(p).length).toBe(9);
    near(lwVertices(p)[0]!, V(0, 0));
    near(lwVertices(p)[8]!, V(20, 0));
  });
});

describe('PEDIT 맞춤(F)', () => {
  it('이중 호: 이음점에서 접선이 이어진다', () => {
    const r = biarc(V(0, 0), V(1, 0), V(10, 0), V(0, -1));
    expect(Math.abs(r.b0)).toBeGreaterThan(0);
    const p = lw([
      [0, 0, r.b0],
      [r.j.x, r.j.y, r.b1],
      [10, 0],
    ]);
    const path = entityPath(p)!;
    near(pieceTangent(path.pieces[0]!, 1), pieceTangent(path.pieces[1]!, 0), 1e-9);
    near(pieceTangent(path.pieces[0]!, 0), V(1, 0), 1e-9);
    near(pieceTangent(path.pieces[1]!, 1), V(0, -1), 1e-9);
  });
  it('맞춤 폴리선: 원래 정점을 지나고 모든 이음매가 매끄럽다', () => {
    const f = fitPolyline(zig()) as PolylineEntity;
    expect(f.type).toBe('POLYLINE');
    expect(f.flags & 2).toBe(2);
    expect(f.vertices.length).toBe(7);
    expect(f.vertices.filter((v) => v.flags & 1).length).toBe(3);
    const path = entityPath(f)!;
    for (let i = 0; i + 1 < path.pieces.length; i++) near(pieceTangent(path.pieces[i]!, 1), pieceTangent(path.pieces[i + 1]!, 0), 1e-6);
    for (const q of [V(0, 0), V(10, 5), V(20, 0), V(30, 5)]) expect(pathNearest(path, q).d).toBeLessThan(1e-9);
    // 비곡선화하면 처음 틀
    const d = decurve(f) as PolylineEntity;
    expect(d.flags & 2).toBe(0);
    expect(d.vertices.length).toBe(4);
    expect(d.vertices.every((v) => v.bulge === 0)).toBe(true);
  });
  it('닫힌 맞춤 폴리선', () => {
    const sq = lw(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    );
    const f = fitPolyline(sq as LwPolylineEntity) as PolylineEntity;
    expect(f.vertices.length).toBe(8);
    const path = entityPath(f)!;
    const n = path.pieces.length;
    for (let i = 0; i < n; i++) near(pieceTangent(path.pieces[i]!, 1), pieceTangent(path.pieces[(i + 1) % n]!, 0), 1e-6);
  });
});

describe('PEDIT 스플라인(S)', () => {
  it('3차 스플라인 맞춤: 틀 정점 16, 만든 정점 8, 끝점은 틀의 끝', () => {
    const s = splinePolyline(zig(), 6, 8);
    expect(s.flags & 4).toBe(4);
    expect(s.smoothType).toBe(6);
    const frame = s.vertices.filter((v) => v.flags & 16);
    const gen = s.vertices.filter((v) => v.flags & 8);
    expect(frame.length).toBe(4);
    expect(gen.length).toBe(25);
    near(gen[0]!.location, V(0, 0));
    near(gen[gen.length - 1]!.location, V(30, 5));
    renders(doc, [s]);
    // 틀 정점 편집 뒤 다시 맞춤
    const m = moveVertex(s, 1, V(10, 15)) as PolylineEntity;
    expect(m.flags & 4).toBe(4);
    expect(frameVerts(m)[1]!.y).toBe(15);
    const d = decurve(s) as PolylineEntity;
    expect(d.vertices.length).toBe(4);
    expect(d.smoothType).toBe(0);
  });
  it('3D 폴리선 스플라인', () => {
    const p: PolylineEntity = {
      ...(poly2d([
        [0, 0],
        [5, 5],
        [10, 0],
      ]) as PolylineEntity),
      kind: '3d',
      flags: 8,
    };
    p.vertices.forEach((v, i) => {
      v.location.z = i;
      v.flags = 32;
    });
    const s = splinePolyline(p, 5, 4);
    expect(s.kind).toBe('3d');
    expect(s.vertices.filter((v) => v.flags & 16).every((v) => v.flags & 32)).toBe(true);
    expect(s.vertices.find((v) => v.flags & 8)!.location.z).toBe(0);
  });
});

describe('PEDIT 단순 편집', () => {
  it('닫기·열기·폭', () => {
    const c = setClosed(zig(), true) as LwPolylineEntity;
    expect(c.closed).toBe(true);
    const w = setWidth(c, 2) as LwPolylineEntity;
    expect(w.constantWidth).toBe(2);
    const p2 = setWidth(poly2d([
      [0, 0],
      [1, 0],
    ]) as PolylineEntity, 3) as PolylineEntity;
    expect(p2.vertices.every((v) => v.startWidth === 3 && v.endWidth === 3)).toBe(true);
  });
  it('정점 삽입·이동·삭제·폭', () => {
    const p = zig();
    const a = insertVertex(p, 0, V(5, 10)) as LwPolylineEntity;
    expect(lwVertices(a).length).toBe(5);
    near(lwVertices(a)[1]!, V(5, 10));
    const m = moveVertex(a, 1, V(5, 20)) as LwPolylineEntity;
    near(lwVertices(m)[1]!, V(5, 20));
    const r = removeVertex(m, 1) as LwPolylineEntity;
    expect(lwVertices(r).length).toBe(4);
    expect(removeVertex(lw([[0, 0], [1, 1]]) as LwPolylineEntity, 0)).toBeNull();
    const w = setSegmentWidth(p, 1, 0.5, 2) as LwPolylineEntity;
    expect(lwVertices(w)[1]!.startWidth).toBe(0.5);
    expect(lwVertices(w)[1]!.endWidth).toBe(2);
    renders(doc, [a, m, r, w]);
  });
});
