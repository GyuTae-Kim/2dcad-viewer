/** 연관 치수 시험용 도면·편집 도우미(편집 세션으로 적용해 되돌리기·왕복까지 본다) */
import type { BlockDef, CadDocument, DimensionEntity, Entity, Vec3 } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { generateDimensionGeometry, nextDimBlockName } from '../../src/edit/dim';
import { type FollowResult, type PointRef, followAssociations, setDimAssocChanges } from '../../src/edit/dim/assoc';
import { type EditOp, EditSession } from '../../src/edit/session';

export const P = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

export interface Bench {
  doc: CadDocument;
  s: EditSession;
  add<T extends Entity>(e: T): T;
  addDim(d: DimensionEntity, refs: (PointRef | null)[]): DimensionEntity;
  /** 편집(핸들 → 편집 뒤, null = 지움)을 연관 따라가기와 함께 적용 */
  edit(changes: Map<string, Entity | null>, opt?: { transform?: (p: { x: number; y: number }) => { x: number; y: number } }): FollowResult;
  dim(h: string): DimensionEntity;
}

/** 치수 블록 작업(생성기 그림을 *D 블록으로) */
function blockOps(doc: CadDocument, s: EditSession, d: DimensionEntity, reuse: boolean): EditOp[] {
  const g = generateDimensionGeometry(doc, d);
  d.measurement = g.measurement;
  d.textMid = g.textMid;
  const before = reuse && d.block ? doc.blocks.get(tableKey(d.block)) : undefined;
  const name = before?.name ?? nextDimBlockName(doc);
  const key = tableKey(name);
  const rh = before?.recordHandle ?? s.newHandle();
  for (const e of g.entities) {
    e.handle = s.newHandle();
    e.owner = rh;
  }
  const def: BlockDef = { name, handle: before?.handle ?? s.newHandle(), recordHandle: rh, basePoint: P(0, 0), flags: 1, entities: g.entities, endHandle: before?.endHandle ?? s.newHandle() };
  const ops: EditOp[] = [];
  if (!before) ops.push({ kind: 'blockRecord', key, before: null, after: { name, handle: rh, flags: 1, insertUnits: 0, explodable: true, scalable: true } });
  ops.push({ kind: 'blockDef', key, before: before ?? null, after: def });
  d.block = name;
  return ops;
}

export function bench(): Bench {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const ms = doc.blocks.get(MODEL_SPACE)!;
  const alloc = () => s.newHandle();
  return {
    doc,
    s,
    add(e) {
      e.handle ||= s.newHandle();
      e.owner = ms.recordHandle;
      s.commit({ label: 'ADD', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
      return e;
    },
    addDim(d, refs) {
      const ops = blockOps(doc, s, d, false);
      d.handle = s.newHandle();
      d.owner = ms.recordHandle;
      const { dim, changes } = setDimAssocChanges(doc, d, refs, { alloc, current: (h) => doc.entityIndex.get(h) });
      ops.push({ kind: 'add', block: MODEL_SPACE, entity: dim });
      for (const [h, e] of changes.entities) if (h !== dim.handle) ops.push({ kind: 'modify', block: MODEL_SPACE, before: doc.entityIndex.get(h)!, after: e });
      for (const o of changes.objects) ops.push({ kind: 'object', key: o.key, before: o.before, after: o.after });
      s.commit({ label: 'DIM', ops });
      return dim;
    },
    edit(changes, opt = {}) {
      const f = followAssociations(doc, changes, alloc, opt);
      const after = new Map<string, Entity | null>(changes);
      for (const [h, e] of f.entities) after.set(h, e);
      for (const [h, d] of f.dims) after.set(h, d);
      const ops: EditOp[] = [];
      for (const [h, e] of after) {
        const before = doc.entityIndex.get(h)!;
        if (e === null) {
          ops.push({ kind: 'remove', block: MODEL_SPACE, entity: before, index: ms.entities.indexOf(before) });
          continue;
        }
        if (e.type === 'DIMENSION' && f.dims.has(h)) ops.push(...blockOps(doc, s, e, true));
        ops.push({ kind: 'modify', block: MODEL_SPACE, before, after: e });
      }
      for (const o of f.objects) ops.push({ kind: 'object', key: o.key, before: o.before, after: o.after });
      s.commit({ label: 'EDIT', ops });
      return f;
    },
    dim(h) {
      return doc.entityIndex.get(h) as DimensionEntity;
    },
  };
}

export const line = (a: Vec3, b: Vec3): Entity => ({ ...entityDefaults(), type: 'LINE', handle: '', start: a, end: b }) as Entity;
export const circle = (c: Vec3, r: number): Entity => ({ ...entityDefaults(), type: 'CIRCLE', handle: '', center: c, radius: r }) as Entity;
export const arc = (c: Vec3, r: number, a0: number, a1: number): Entity => ({ ...entityDefaults(), type: 'ARC', handle: '', center: c, radius: r, startAngle: a0, endAngle: a1 }) as Entity;
