/**
 * EXPORTLAYOUT: 배치에 보이는 모든 것을 새 도면의 모형 공간으로(UI 없음).
 * 종이 공간 객체는 그 자리 그대로 모형으로 옮기고, 뷰포트마다 모형을 담은 블록을 뷰포트 축척·비틀기로 넣은 뒤
 * 뷰포트 경계로 XCLIP한다. 뷰포트에서 동결한 도면층의 객체는 그 뷰포트의 블록에서 뺀다(블록 안 중첩 객체는 그대로).
 */
import type { BlockDef, BlockRecord, CadDocument, Entity, InsertEntity, Vec2, ViewportEntity } from '../core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../core/model';
import { applyOps } from './session';
import { setXclipOps } from './xclip';

export interface ExportViewport {
  vp: ViewportEntity;
  /** 종이 단위 / 모형 단위 */
  k: number;
  twist: number;
  /** 뷰포트 중심에 오는 모형 점 */
  refX: number;
  refY: number;
  /** 다각형·원 뷰포트의 종이 좌표 윤곽 [x, y, …] */
  clip?: number[];
  /** 이 뷰포트에서 동결한 도면층(대문자) */
  frozen: ReadonlySet<string>;
}

function uniqueName(doc: CadDocument, base: string): string {
  let name = base;
  for (let i = 2; doc.blocks.has(tableKey(name)); i++) name = `${base}${i}`;
  return name;
}

function addBlock(doc: CadDocument, name: string, entities: Entity[], newHandle: () => string): string {
  const rec: BlockRecord = { name, handle: newHandle(), flags: 0, insertUnits: 0, explodable: true, scalable: true };
  const def: BlockDef = { name, handle: newHandle(), recordHandle: rec.handle, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities, endHandle: newHandle() } as BlockDef;
  for (const e of entities) e.owner = rec.handle;
  doc.blocks.set(tableKey(name), def);
  doc.blockRecords.set(tableKey(name), rec);
  return name;
}

/** 새 핸들을 줄 때 원본 문서와 겹치지 않게(HANDSEED부터) */
function handleMaker(doc: CadDocument): () => string {
  let n = 0n;
  const seed = doc.header.get('$HANDSEED');
  if (typeof seed === 'string' && /^[0-9A-F]+$/i.test(seed)) n = BigInt(`0x${seed}`);
  for (const k of doc.entityIndex.keys()) {
    if (/^[0-9A-F]+$/i.test(k)) {
      const v = BigInt(`0x${k}`);
      if (v >= n) n = v + 1n;
    }
  }
  for (const k of doc.objects.keys())
    if (/^[0-9A-F]+$/i.test(k)) {
      const v = BigInt(`0x${k}`);
      if (v >= n) n = v + 1n;
    }
  return () => {
    const h = n.toString(16).toUpperCase();
    n++;
    doc.header.set('$HANDSEED', n.toString(16).toUpperCase());
    return h;
  };
}

/** 깊이 복사한 새 도면(원본은 그대로) */
export function exportLayoutDocument(src: CadDocument, layoutKey: string, viewports: readonly ExportViewport[]): CadDocument {
  const doc = structuredClone(src);
  const nh = handleMaker(doc);
  const ms = doc.blocks.get(MODEL_SPACE)!;
  const paper = doc.blocks.get(tableKey(layoutKey));
  if (!ms || !paper) throw new Error('배치를 찾을 수 없습니다.');
  const modelEntities = ms.entities;
  // 동결 도면층이 같은 뷰포트끼리 블록 하나를 쓴다
  const blocks = new Map<string, string>();
  const blockFor = (frozen: ReadonlySet<string>): string => {
    const key = [...frozen].sort().join('\u0001');
    let name = blocks.get(key);
    if (name) return name;
    const list = frozen.size ? modelEntities.filter((e) => !frozen.has(tableKey(e.layer))) : modelEntities;
    // 첫 블록은 원래 객체를 옮기고, 다음 블록부터는 새 핸들의 사본
    const ents = blocks.size === 0 && !frozen.size ? list : list.map((e) => ({ ...structuredClone(e), handle: nh() }) as Entity);
    name = addBlock(doc, uniqueName(doc, blocks.size ? `_LAYOUT_MODEL_${blocks.size + 1}` : '_LAYOUT_MODEL'), ents, nh);
    blocks.set(key, name);
    return name;
  };
  // 종이 공간 객체 → 모형(뷰포트 객체는 뺀다)
  const moved = paper.entities.filter((e) => e.type !== 'VIEWPORT');
  for (const e of moved) {
    e.owner = ms.recordHandle;
    delete e.paperSpace;
  }
  ms.entities = moved;
  const inserts: { e: InsertEntity; boundary: Vec2[] }[] = [];
  for (const v of viewports) {
    const name = blockFor(v.frozen);
    const rot = -v.twist;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const ins: InsertEntity = {
      type: 'INSERT',
      ...entityDefaults(),
      handle: nh(),
      owner: ms.recordHandle,
      layer: v.vp.layer,
      block: name,
      insert: { x: v.vp.center.x - v.k * (c * v.refX - s * v.refY), y: v.vp.center.y - v.k * (s * v.refX + c * v.refY), z: 0 },
      scale: { x: v.k, y: v.k, z: v.k },
      rotation: rot,
      attribs: [],
      columnCount: 1,
      rowCount: 1,
      columnSpacing: 0,
      rowSpacing: 0,
    } as InsertEntity;
    ms.entities.push(ins);
    const hw = v.vp.width / 2;
    const hh = v.vp.height / 2;
    const boundary: Vec2[] = [];
    if (v.clip && v.clip.length >= 6) for (let i = 0; i + 1 < v.clip.length; i += 2) boundary.push({ x: v.clip[i]!, y: v.clip[i + 1]! });
    else
      boundary.push(
        { x: v.vp.center.x - hw, y: v.vp.center.y - hh },
        { x: v.vp.center.x + hw, y: v.vp.center.y - hh },
        { x: v.vp.center.x + hw, y: v.vp.center.y + hh },
        { x: v.vp.center.x - hw, y: v.vp.center.y + hh },
      );
    inserts.push({ e: ins, boundary });
  }
  // 종이 공간에는 배치 전체 뷰포트만 남긴다(배치 객체가 가리킴)
  for (const [k, b] of doc.blocks) if (/^\*PAPER_SPACE/i.test(k)) b.entities = b.entities.filter((e) => e.type === 'VIEWPORT' && (e as ViewportEntity).id === 1);
  doc.entityIndex.clear();
  for (const b of doc.blocks.values())
    for (const e of b.entities) {
      if (e.handle) doc.entityIndex.set(e.handle, e);
      if (e.type === 'INSERT') for (const a of e.attribs) if (a.handle) doc.entityIndex.set(a.handle, a);
    }
  for (const { e, boundary } of inserts) applyOps(doc, setXclipOps(doc, e, MODEL_SPACE, boundary, nh));
  doc.header.set('$TILEMODE', 1);
  // 뷰포트 경계 대신인 자르기 틀은 숨긴다(배치처럼 보이게)
  doc.header.set('$XCLIPFRAME', 0);
  return doc;
}
