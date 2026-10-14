/** 나선(HELIX): 베지어 조각 조정점·매듭, 나선 정의, DXF 왕복 */
import { describe, expect, it } from 'vitest';
import type { SplineEntity } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { entityDefaults } from '../../src/core/model';
import { EditSession } from '../../src/edit/session';
import { helixControlPoints, helixEntity } from '../../src/edit/helix';
import { nurbsPoints } from '../../src/geom/curves';
import { writeDxf } from '../../src/io/dxf/writer';
import { readCadFile } from '../../src/io/index';

const spec = { center: { x: 0, y: 0, z: 0 }, baseRadius: 10, topRadius: 10, startAngle: 0, turns: 3, height: 15, ccw: true };

describe('나선', () => {
  it('4분의 1 바퀴마다 베지어 조각, 원호 근사 계수 0.5523', () => {
    const { ctrl, knots } = helixControlPoints(spec);
    expect(ctrl).toHaveLength(37);
    expect(knots.slice(0, 10)).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(knots.slice(-4)).toEqual([12, 12, 12, 12]);
    expect(ctrl[1]!.x).toBeCloseTo(10, 9);
    expect(ctrl[1]!.y).toBeCloseTo(5.5228, 3);
    expect(ctrl[3]).toMatchObject({ x: expect.closeTo(0, 9), y: expect.closeTo(10, 9), z: expect.closeTo(1.25, 9) });
    expect(ctrl[36]).toMatchObject({ x: expect.closeTo(10, 9), y: expect.closeTo(0, 9), z: expect.closeTo(15, 9) });
  });

  it('곡선 위 점의 반지름 오차가 작고, 시계 방향·테이퍼·끝수 회전을 다룬다', () => {
    const e = helixEntity({ ...spec, height: 0 }, entityDefaults());
    const pts = nurbsPoints(e.degree, e.knots, e.controlPoints, undefined, 0.001);
    for (let i = 0; i < pts.length; i += 3) expect(Math.abs(Math.hypot(pts[i]!, pts[i + 1]!) - 10)).toBeLessThan(0.003);
    expect(e.flags & 8).toBe(8);
    const cw = helixControlPoints({ ...spec, ccw: false, turns: 0.25 });
    expect(cw.ctrl[3]).toMatchObject({ x: expect.closeTo(0, 9), y: expect.closeTo(-10, 9) });
    const taper = helixControlPoints({ ...spec, topRadius: 5, turns: 1.1, startAngle: Math.PI / 2 });
    // 1.1바퀴 = 조각 5개(마지막 0.1바퀴)
    expect(taper.ctrl).toHaveLength(16);
    const end = taper.ctrl[15]!;
    const a = Math.PI / 2 + 2 * Math.PI * 1.1;
    expect(end.x).toBeCloseTo(5 * Math.cos(a), 9);
    expect(end.y).toBeCloseTo(5 * Math.sin(a), 9);
  });

  it('DXF R2018에 HELIX로, R2000에는 스플라인으로 남는다', () => {
    const doc = createNewDocument('metric');
    const s = new EditSession(doc, () => {});
    const e = helixEntity({ ...spec, center: { x: 5, y: 6, z: 0 }, startAngle: 1 }, entityDefaults());
    e.handle = s.newHandle();
    s.commit({ label: 'HELIX', ops: [{ kind: 'add', block: '*MODEL_SPACE', entity: e }] });
    const back = readCadFile(writeDxf(doc, { version: 'AC1032' }).data, 'x.dxf');
    const h = [...back.entityIndex.values()].find((x) => x.type === 'SPLINE') as SplineEntity;
    expect(h.helix).toMatchObject({ radius: 10, turns: 3, turnHeight: 5, ccw: true, constrain: 1 });
    expect(h.helix!.axisBase).toMatchObject({ x: 5, y: 6 });
    expect(h.controlPoints).toHaveLength(37);
    const old = readCadFile(writeDxf(doc, { version: 'AC1015' }).data, 'x.dxf');
    const sp = [...old.entityIndex.values()].find((x) => x.type === 'SPLINE') as SplineEntity;
    expect(sp.helix).toBeUndefined();
    expect(sp.controlPoints).toHaveLength(37);
  });
});
