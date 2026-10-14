/** util2 시험용 문서·객체 만들기 */
import type { AttribEntity, BlockDef, CadDocument, CircleEntity, Entity, InsertEntity, LineEntity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';

export function setup(): { doc: CadDocument; s: EditSession; ms: BlockDef; h: () => string } {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const ms = doc.blocks.get(MODEL_SPACE)!;
  return { doc, s, ms, h: () => s.newHandle() };
}

export function line(h: string, x0: number, y0: number, x1: number, y1: number, props: Partial<Entity> = {}): LineEntity {
  return { ...entityDefaults(), handle: h, type: 'LINE', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 }, ...props } as LineEntity;
}

export function circle(h: string, x: number, y: number, r: number, props: Partial<Entity> = {}): CircleEntity {
  return { ...entityDefaults(), handle: h, type: 'CIRCLE', center: { x, y, z: 0 }, radius: r, ...props } as CircleEntity;
}

export function text(h: string, x: number, y: number, s: string, props: Partial<TextEntity> = {}): TextEntity {
  return {
    ...entityDefaults(),
    handle: h,
    type: 'TEXT',
    insert: { x, y, z: 0 },
    height: 2.5,
    text: s,
    rotation: 0,
    widthFactor: 1,
    oblique: 0,
    style: 'Standard',
    generation: 0,
    halign: 0,
    valign: 0,
    ...props,
  };
}

export function attdef(h: string, tag: string, value: string, x: number, y: number, flags = 0): AttribEntity {
  return { ...text(h, x, y, value), type: 'ATTDEF', tag, prompt: `${tag}?`, attFlags: flags };
}

/** 블록 정의를 문서에 넣는다(세션 없이) */
export function addBlock(doc: CadDocument, h: () => string, name: string, ents: Entity[], base = { x: 0, y: 0, z: 0 }): BlockDef {
  const rec = h();
  for (const e of ents) e.owner = rec;
  const def: BlockDef = { name, handle: h(), recordHandle: rec, basePoint: base, flags: ents.some((e) => e.type === 'ATTDEF') ? 2 : 0, entities: ents, endHandle: h() };
  doc.blocks.set(tableKey(name), def);
  doc.blockRecords.set(tableKey(name), { name, handle: rec, flags: 0, insertUnits: 0, explodable: true, scalable: true });
  for (const e of ents) doc.entityIndex.set(e.handle, e);
  return def;
}

export function insert(h: string, block: string, x: number, y: number, props: Partial<InsertEntity> = {}): InsertEntity {
  return {
    ...entityDefaults(),
    handle: h,
    type: 'INSERT',
    block,
    insert: { x, y, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
    ...props,
  };
}

/** 모형 공간에 바로 넣는다(세션 없이) */
export function put(doc: CadDocument, ...ents: Entity[]): void {
  const ms = doc.blocks.get(MODEL_SPACE)!;
  for (const e of ents) {
    e.owner = ms.recordHandle;
    ms.entities.push(e);
    doc.entityIndex.set(e.handle, e);
    if (e.type === 'INSERT') for (const a of e.attribs) doc.entityIndex.set(a.handle, a);
  }
}
