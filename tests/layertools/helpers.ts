/** 도면층 도구·디자인센터·CAD 표준 시험 도우미: 새 도면, 표 기록, 객체, 블록 */
import type { AttribEntity, BlockDef, CadDocument, DimensionEntity, Entity, InsertEntity, Layer, LineEntity, Linetype, TextEntity, TextStyle, ViewportEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession, type EditOp } from '../../src/edit/session';

export interface TestDoc {
  doc: CadDocument;
  session: EditSession;
  nh: () => string;
}

export function newDoc(units: 'metric' | 'imperial' = 'metric'): TestDoc {
  const doc = createNewDocument(units);
  const session = new EditSession(doc, () => {});
  return { doc, session, nh: () => session.newHandle() };
}

export function commit(t: TestDoc, ops: EditOp[], label = 'TEST'): void {
  t.session.commit({ label, ops });
}

export function layer(name: string, props: Partial<Layer> = {}): Layer {
  return { name, handle: '', flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255, ...props };
}

export function addLayer(t: TestDoc, name: string, props: Partial<Layer> = {}): Layer {
  const l = layer(name, props);
  l.handle = t.nh();
  commit(t, [{ kind: 'layer', key: tableKey(name), before: null, after: l }]);
  return l;
}

export function addLinetype(t: TestDoc, name: string, dashes: number[] = [5, -2.5], description = ''): Linetype {
  const lt: Linetype = {
    name,
    handle: t.nh(),
    flags: 0,
    description: description || `${name} __ __`,
    patternLength: dashes.reduce((s, d) => s + Math.abs(d), 0),
    elements: dashes.map((length) => ({ length, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } })),
  };
  commit(t, [{ kind: 'linetype', key: tableKey(name), before: null, after: lt }]);
  return lt;
}

export function addTextStyle(t: TestDoc, name: string, font = 'romans.shx', props: Partial<TextStyle> = {}): TextStyle {
  const s: TextStyle = { name, handle: t.nh(), flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font, bigFont: '', ...props };
  commit(t, [{ kind: 'textStyle', key: tableKey(name), before: null, after: s }]);
  return s;
}

export function line(x0: number, y0: number, x1: number, y1: number, layerName = '0'): LineEntity {
  return { type: 'LINE', ...entityDefaults(), layer: layerName, start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } };
}

export function text(x: number, y: number, s = 'ABC', style = 'Standard', layerName = '0'): TextEntity {
  return { type: 'TEXT', ...entityDefaults(), layer: layerName, insert: { x, y, z: 0 }, height: 2.5, text: s, rotation: 0, widthFactor: 1, oblique: 0, style, generation: 0, halign: 0, valign: 0 };
}

export function attdef(tag: string, style = 'Standard', layerName = '0'): AttribEntity {
  return { ...(text(0, -5, tag, style, layerName) as unknown as AttribEntity), type: 'ATTDEF', tag, prompt: tag, attFlags: 0 };
}

export function insert(block: string, x: number, y: number, layerName = '0', attribs: AttribEntity[] = []): InsertEntity {
  return { type: 'INSERT', ...entityDefaults(), layer: layerName, block, insert: { x, y, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs };
}

export function dimension(block: string, dimStyle = 'Standard', layerName = '0'): DimensionEntity {
  return {
    type: 'DIMENSION',
    ...entityDefaults(),
    layer: layerName,
    block,
    dimStyle,
    dimType: 32,
    defPoint: { x: 10, y: 0, z: 0 },
    defPoint2: { x: 0, y: 0, z: 0 },
    defPoint3: { x: 10, y: 0, z: 0 },
    defPoint4: { x: 0, y: 0, z: 0 },
    defPoint5: { x: 0, y: 0, z: 0 },
    textMid: { x: 5, y: 2, z: 0 },
    text: '',
    measurement: 10,
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

export function viewport(frozen: string[] = []): ViewportEntity {
  return {
    type: 'VIEWPORT',
    ...entityDefaults(),
    paperSpace: true,
    center: { x: 100, y: 100, z: 0 },
    width: 100,
    height: 80,
    status: 2,
    id: 2,
    viewCenter: { x: 0, y: 0 },
    snapBase: { x: 0, y: 0 },
    snapSpacing: { x: 10, y: 10 },
    gridSpacing: { x: 10, y: 10 },
    viewDirection: { x: 0, y: 0, z: 1 },
    viewTarget: { x: 0, y: 0, z: 0 },
    lensLength: 50,
    frontClip: 0,
    backClip: 0,
    viewHeight: 80,
    snapAngle: 0,
    twistAngle: 0,
    circleSides: 1000,
    flags: 0,
    frozenLayers: frozen,
    renderMode: 0,
    ucsPerViewport: true,
  };
}

/** 공간·블록에 객체를 넣는다(핸들·소유자를 붙여) */
export function add<T extends Entity>(t: TestDoc, e: T, block = MODEL_SPACE): T {
  e.handle = t.nh();
  const b = t.doc.blocks.get(tableKey(block))!;
  e.owner = b.recordHandle;
  if (e.type === 'INSERT') for (const a of e.attribs) a.handle = t.nh();
  commit(t, [{ kind: 'add', block: tableKey(block), entity: e }]);
  return t.doc.entityIndex.get(e.handle) as T;
}

/** 블록 정의를 만든다 */
export function addBlock(t: TestDoc, name: string, entities: Entity[], basePoint = { x: 0, y: 0, z: 0 }, flags = 0): BlockDef {
  const recordHandle = t.nh();
  const ents = entities.map((e) => {
    e.handle = t.nh();
    e.owner = recordHandle;
    return e;
  });
  const def: BlockDef = { name, handle: t.nh(), recordHandle, basePoint, flags: flags | (ents.some((e) => e.type === 'ATTDEF') ? 2 : 0), layer: '0', entities: ents, endHandle: t.nh() };
  commit(t, [
    { kind: 'blockRecord', key: tableKey(name), before: null, after: { name, handle: recordHandle, flags: flags & 1, insertUnits: 0, explodable: true, scalable: true } },
    { kind: 'blockDef', key: tableKey(name), before: null, after: def },
  ]);
  return t.doc.blocks.get(tableKey(name))!;
}

/** 문서의 모든 핸들(표 기록·블록·객체·사전)이 겹치지 않는지 */
export function duplicateHandles(doc: CadDocument): string[] {
  const seen = new Map<string, number>();
  const put = (h: string | undefined) => {
    if (!h) return;
    seen.set(h, (seen.get(h) ?? 0) + 1);
  };
  for (const m of [doc.layers, doc.linetypes, doc.textStyles, doc.dimStyles, doc.blockRecords]) for (const r of m.values()) put(r.handle);
  for (const b of doc.blocks.values()) {
    put(b.handle);
    put(b.endHandle);
    for (const e of b.entities) {
      put(e.handle);
      if (e.type === 'INSERT') for (const a of e.attribs) put(a.handle);
    }
  }
  for (const o of doc.objects.values()) if (o.type !== 'LAYOUT') put(o.handle);
  return [...seen].filter(([, n]) => n > 1).map(([h]) => h);
}
