/**
 * 새 명령이 만드는 객체(가리기, 맞춤·스플라인 폴리선, 구름형 리비전, 주기 스플라인, 혼합 스플라인)가
 * DXF로 쓰고 다시 읽어도 같은지. M2_OUT 환경 변수가 있으면 쓴 파일을 그 경로에 남긴다(ezdxf 검사용).
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Entity, ImageEntity, LwPolylineEntity, PolylineEntity, SplineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { blendEntities } from '../../src/edit/geom/blend';
import { cloudPolyline, makeWipeout, wipeoutPolygon } from '../../src/edit/geom/markup';
import { makeSpline } from '../../src/edit/geom/path';
import { fitPolyline, splinePolyline } from '../../src/edit/geom/pedit';
import { closeSpline, refit } from '../../src/edit/geom/splinedit';
import { V, line, lw, near } from '../edit/helpers';

describe('DXF 왕복', () => {
  it('새 객체를 쓰고 읽으면 같다', () => {
    const doc = createNewDocument('metric');
    const ms = doc.blocks.get(MODEL_SPACE)!;
    let n = 0x900;
    const add = (e: Entity) => {
      e.handle = (n++).toString(16).toUpperCase();
      e.owner = ms.recordHandle;
      ms.entities.push(e);
      doc.entityIndex.set(e.handle, e);
      return e;
    };
    const base = { ...entityDefaults(), handle: '' };
    const w = add(makeWipeout(base, [V(0, 0), V(30, 0), V(10, 20)])!) as ImageEntity;
    const zig = lw([
      [0, 40],
      [10, 50],
      [20, 40],
      [30, 50],
    ]) as LwPolylineEntity;
    const fit = add(fitPolyline(zig)) as PolylineEntity;
    const spl = add(splinePolyline(zig, 6, 8)) as PolylineEntity;
    const cloud = add(cloudPolyline(base, [V(50, 0), V(90, 0), V(90, 30), V(50, 30)], true, { minArc: 5, maxArc: 8, calligraphy: true })!) as LwPolylineEntity;
    const fs: SplineEntity = refit({
      type: 'SPLINE',
      ...base,
      flags: 8,
      degree: 3,
      knots: [],
      controlPoints: [],
      fitPoints: [
        { x: 100, y: 0, z: 0 },
        { x: 110, y: 10, z: 0 },
        { x: 120, y: 0, z: 0 },
        { x: 130, y: 10, z: 0 },
      ],
      knotTolerance: 1e-10,
      controlTolerance: 1e-10,
      fitTolerance: 1e-10,
    });
    const closed = add(closeSpline(fs)!) as SplineEntity;
    const bl = blendEntities(line(0, -10, 10, -10), V(10, -10), line(20, 0, 20, 10), V(20, 0), 'smooth');
    if (typeof bl === 'string') throw new Error(bl);
    const blend = add(makeSpline({ ...line(0, 0, 1, 1), handle: '' }, bl)) as SplineEntity;
    const data = writeDxf(doc, { version: 'AC1032' }).data;
    if (process.env.M2_OUT) writeFileSync(process.env.M2_OUT, data);
    const back = readDxf(data);
    const get = <T extends Entity>(h: string) => back.entityIndex.get(h) as T;
    const w2 = get<ImageEntity>(w.handle);
    expect(w2.type).toBe('WIPEOUT');
    wipeoutPolygon(w2).forEach((p, i) => near(p, wipeoutPolygon(w)[i]!, 1e-9));
    const f2 = get<PolylineEntity>(fit.handle);
    expect(f2.flags & 2).toBe(2);
    expect(f2.vertices.map((v) => v.flags)).toEqual(fit.vertices.map((v) => v.flags));
    f2.vertices.forEach((v, i) => expect(v.bulge).toBeCloseTo(fit.vertices[i]!.bulge, 12));
    const s2 = get<PolylineEntity>(spl.handle);
    expect(s2.smoothType).toBe(6);
    expect(s2.vertices.filter((v) => v.flags & 16).length).toBe(4);
    const c2 = get<LwPolylineEntity>(cloud.handle);
    expect(c2.vertices.length).toBe(cloud.vertices.length);
    expect(c2.vertices[0]!.endWidth).toBeCloseTo(cloud.vertices[0]!.endWidth, 12);
    const p2 = get<SplineEntity>(closed.handle);
    expect(p2.flags & 3).toBe(3);
    expect(p2.controlPoints.length).toBe(closed.controlPoints.length);
    expect(p2.fitPoints.length).toBe(4);
    const b2 = get<SplineEntity>(blend.handle);
    expect(b2.degree).toBe(5);
  });
});
