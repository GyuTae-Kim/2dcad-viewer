/** 구속 시험용 문서·객체 */
import type { ArcEntity, CadDocument, CircleEntity, Entity, LineEntity, LwPolylineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { type EditOp, EditSession } from '../../src/edit/session';
import { readStore, storeOps } from '../../src/edit/constraint/store';
import { acadCommitOps } from '../../src/edit/assocnet/writeback';
import type { ConstraintStore } from '../../src/edit/constraint/types';

export function setup(): { doc: CadDocument; s: EditSession; h: () => string } {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  return { doc, s, h: () => s.newHandle() };
}

export function line(h: string, x0: number, y0: number, x1: number, y1: number): LineEntity {
  return { ...entityDefaults(), handle: h, type: 'LINE', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } };
}

export function circle(h: string, x: number, y: number, r: number): CircleEntity {
  return { ...entityDefaults(), handle: h, type: 'CIRCLE', center: { x, y, z: 0 }, radius: r };
}

export function arc(h: string, x: number, y: number, r: number, a0: number, a1: number): ArcEntity {
  return { ...entityDefaults(), handle: h, type: 'ARC', center: { x, y, z: 0 }, radius: r, startAngle: a0, endAngle: a1 };
}

export function lwpoly(h: string, pts: [number, number, number?][], closed = false): LwPolylineEntity {
  return {
    ...entityDefaults(),
    handle: h,
    type: 'LWPOLYLINE',
    vertices: pts.map(([x, y, b]) => ({ x, y, bulge: b ?? 0, startWidth: 0, endWidth: 0 })),
    closed,
    plinegen: false,
    constantWidth: 0,
    elevation: 0,
  };
}

export function put(doc: CadDocument, ...ents: Entity[]): void {
  const ms = doc.blocks.get(MODEL_SPACE)!;
  for (const e of ents) {
    e.owner = ms.recordHandle;
    ms.entities.push(e);
    doc.entityIndex.set(e.handle, e);
  }
}

/** 풀이 결과(바뀐 객체·새 기록)를 한 트랜잭션으로 적용한다(앱의 확정 고리처럼 AutoCAD 구속 그룹 갱신을 덧붙인다) */
export function apply(doc: CadDocument, s: EditSession, out: { entities: Map<string, Entity>; store: ConstraintStore | null }, label = 'TEST'): void {
  const ops: EditOp[] = [];
  if (out.store) ops.push(...storeOps(doc, out.store, () => s.newHandle())!);
  for (const [h, e] of out.entities) ops.push({ kind: 'modify', block: s.ownerOf(h)!, before: doc.entityIndex.get(h)!, after: e });
  s.commit({ label, ops: acadCommitOps(doc, ops) ?? ops });
}

export const L = (doc: CadDocument, h: string) => doc.entityIndex.get(h) as LineEntity;
export const store = (doc: CadDocument) => readStore(doc);
