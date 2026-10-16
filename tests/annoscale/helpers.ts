/** 주석 축척 시험 도우미: 새 도면, 객체, 편집 적용 */
import type { CadDocument, Entity, HatchEntity, InsertEntity, MTextEntity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession, type EditOp } from '../../src/edit/session';
import { ScaleIndex } from '../../src/edit/annoscale/represent';
import type { EditEnv } from '../../src/edit/annoscale/edit';
import { packBulge } from '../../src/core/lwpoly';

export function newDoc(units: 'metric' | 'imperial' = 'metric'): { doc: CadDocument; session: EditSession } {
  const doc = createNewDocument(units);
  const session = new EditSession(doc, () => {});
  return { doc, session };
}

export function envOf(doc: CadDocument, session: EditSession): EditEnv {
  return { doc, alloc: () => session.newHandle(), idx: new ScaleIndex(doc) };
}

export function commit(session: EditSession, ops: EditOp[], label = 'TEST'): void {
  session.commit({ label, ops });
}

/** 모형 공간에 객체를 넣는다(핸들을 붙여) */
export function addModel<T extends Entity>(doc: CadDocument, session: EditSession, e: T): T {
  e.handle = session.newHandle();
  const ms = doc.blocks.get(MODEL_SPACE)!;
  e.owner = ms.recordHandle;
  commit(session, [{ kind: 'add', block: MODEL_SPACE, entity: e }]);
  return doc.entityIndex.get(e.handle) as T;
}

/** 객체를 바꾼다(모형 공간) */
export function modify(doc: CadDocument, session: EditSession, after: Entity): void {
  const before = doc.entityIndex.get(after.handle)!;
  commit(session, [{ kind: 'modify', block: MODEL_SPACE, before, after }]);
}

export function text(x: number, y: number, h: number, style = 'Standard', s = 'ABC'): TextEntity {
  return { type: 'TEXT', ...entityDefaults(), insert: { x, y, z: 0 }, height: h, text: s, rotation: 0, widthFactor: 1, oblique: 0, style, generation: 0, halign: 0, valign: 0 };
}

export function mtext(x: number, y: number, h: number, w = 0): MTextEntity {
  return {
    type: 'MTEXT',
    ...entityDefaults(),
    insert: { x, y, z: 0 },
    height: h,
    width: w,
    attachment: 1,
    drawingDirection: 1,
    text: 'Hello',
    style: 'Standard',
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
  };
}

export function insert(block: string, x: number, y: number, s = 1): InsertEntity {
  return { type: 'INSERT', ...entityDefaults(), block, insert: { x, y, z: 0 }, scale: { x: s, y: s, z: s }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
}

export function hatch(): HatchEntity {
  return {
    type: 'HATCH',
    ...entityDefaults(),
    patternName: 'ANSI31',
    solid: false,
    associative: false,
    hatchStyle: 0,
    patternType: 1,
    patternAngle: 0,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: [
      {
        flags: 3,
        polyline: { closed: true, verts: packBulge([{ x: 0, y: 0, bulge: 0 }, { x: 100, y: 0, bulge: 0 }, { x: 100, y: 100, bulge: 0 }, { x: 0, y: 100, bulge: 0 }]) },
      },
    ],
    patternLines: [{ angle: Math.PI / 4, base: { x: 0, y: 0 }, offset: { x: -2.2450640303, y: 2.2450640303 }, dashes: [] }],
    pixelSize: 0,
    seedPoints: [],
  };
}
