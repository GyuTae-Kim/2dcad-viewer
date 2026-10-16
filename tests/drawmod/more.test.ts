/**
 * MOCORO, 3DPOLY·3DFACE·TRACE, REVCLOUD 수정(M), 새 객체의 고도·두께(ELEVATION·THICKNESS).
 */
import { describe, expect, it } from 'vitest';
import type { Entity, FaceEntity, LineEntity, PolylineEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { lwVertices } from '../../src/core/lwpoly';
import { registerDrawCommands } from '../../src/app/draw';
import { registerModifyCommands } from '../../src/app/modify';
import { registerModify2Commands } from '../../src/app/modify2';
import { boundsOf } from '../../src/edit/geom/query';
import { lw as lw0 } from '../edit/make';
import { makeHarness, modelEntities } from '../cmds2/harness';
import { perCommandGroups } from './groups';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const square = (x: number, y: number, s = 1): Entity => ({ ...lw0([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], true), handle: '' });

function harness() {
  const h = perCommandGroups(makeHarness());
  registerDrawCommands(h.app);
  registerModifyCommands(h.app);
  registerModify2Commands(h.app);
  return h;
}

const ofType = <T extends Entity>(h: ReturnType<typeof harness>, t: string) => h.doc.blocks.get(MODEL_SPACE)!.entities.filter((e) => e.type === t) as T[];

describe('MOCORO', () => {
  it('이동 → 복사 켜고 회전 → 명령 취소 한 번이면 원래대로', async () => {
    const h = harness();
    const s = h.add(square(0, 0));
    await h.run('MOCORO', [{ sel: [s.handle] }, '0,0', '5,0', 'C', 'R', '90', '']);
    const pls = modelEntities(h.doc, 'LWPOLYLINE');
    expect(pls.length).toBe(2);
    const moved = boundsOf([h.doc.entityIndex.get(s.handle)!], h.doc)!;
    close(moved.minX, 5);
    const copy = pls.find((p) => p.handle !== s.handle)!;
    const b = boundsOf([copy], h.doc)!;
    close(b.minX, 4);
    close(b.maxX, 5);
    close(b.maxY, 1);
    h.st.session.undo();
    expect(modelEntities(h.doc, 'LWPOLYLINE').length).toBe(1);
    close(boundsOf([h.doc.entityIndex.get(s.handle)!], h.doc)!.minX, 0);
  });
});

describe('3DPOLY·3DFACE·TRACE', () => {
  it('3DPOLY: 닫힌 3D 폴리선, 고도를 Z로', async () => {
    const h = harness();
    h.doc.header.set('$ELEVATION', 2);
    await h.run('3DPOLY', ['0,0', '1,0', '1,1', 'C']);
    const [p] = ofType<PolylineEntity>(h, 'POLYLINE');
    expect(p!.kind).toBe('3d');
    expect(p!.flags & 9).toBe(9);
    expect(p!.vertices.length).toBe(3);
    expect(p!.vertices.every((v) => v.location.z === 2 && v.flags === 32)).toBe(true);
  });

  it('3DFACE: 보이지 않음(I)은 그 점에서 시작하는 모서리를 숨긴다, 다음 면은 3·4번째 점에서', async () => {
    const h = harness();
    await h.run('3DFACE', ['I', '0,0', '1,0', '1,1', '0,1', '0,2', '1,2', '']);
    const fs = ofType<FaceEntity>(h, '3DFACE');
    expect(fs.length).toBe(2);
    expect(fs[0]!.invisibleEdges).toBe(1);
    expect(fs[1]!.points[0]).toMatchObject({ x: 1, y: 1 });
    expect(fs[1]!.points[1]).toMatchObject({ x: 0, y: 1 });
  });

  it('TRACE: 폭과 이음(바깥 선이 만나는 자리)', async () => {
    const h = harness();
    await h.run('TRACE', ['1', '0,0', '10,0', '10,10', '']);
    const ts = ofType<FaceEntity>(h, 'TRACE');
    expect(ts.length).toBe(2);
    const [l0, r0, l1, r1] = ts[0]!.points;
    close(l0.y, 0.5);
    close(r0.y, -0.5);
    close(l1.x, 9.5);
    close(l1.y, 0.5);
    close(r1.x, 10.5);
    close(r1.y, -0.5);
    expect(h.doc.header.get('$TRACEWID')).toBe(1);
  });
});

describe('REVCLOUD 수정(M)', () => {
  it('고른 점에서 새 점들을 그려 구름 위로 돌아오면, 지울 쪽을 새 구간으로 바꾼다', async () => {
    const h = harness();
    const c = h.add(square(0, 0, 10));
    await h.run('REVCLOUD', ['M', { pick: c.handle, at: [5, 0] }, '5,-3', '8,-3', '8,0', '6.5,0.5', '']);
    const e = h.doc.entityIndex.get(c.handle)!;
    expect(e.type).toBe('LWPOLYLINE');
    const vs = lwVertices(e as never);
    expect((e as { closed: boolean }).closed).toBe(true);
    expect(vs.some((v) => Math.abs(v.bulge) > 0)).toBe(true);
    // 아래 변의 5 < x < 8 구간은 지워졌다
    expect(vs.some((v) => Math.abs(v.y) < 1e-9 && v.x > 5 + 1e-6 && v.x < 8 - 1e-6)).toBe(false);
    // 새 구간이 아래로 내려간다
    expect(Math.min(...vs.map((v) => v.y))).toBeLessThan(-2);
  });
});

describe('새 객체의 고도·두께', () => {
  it('ELEVATION은 Z, THICKNESS는 두께', async () => {
    const h = harness();
    h.doc.header.set('$ELEVATION', 5);
    h.doc.header.set('$THICKNESS', 2);
    await h.run('LINE', ['0,0', '1,0', '']);
    await h.run('CIRCLE', ['0,0', '3']);
    await h.run('RECTANG', ['0,0', '2,2']);
    const [l] = modelEntities(h.doc, 'LINE') as LineEntity[];
    expect(l!.start.z).toBe(5);
    expect(l!.thickness).toBe(2);
    expect(modelEntities(h.doc, 'CIRCLE')[0]!.center.z).toBe(5);
    const r = modelEntities(h.doc, 'LWPOLYLINE')[0]!;
    expect(r.elevation).toBe(5);
    expect(r.thickness).toBe(2);
  });
});
