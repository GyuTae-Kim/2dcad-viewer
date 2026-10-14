/**
 * 블록 도우미(UI 없음): 속성 동기화(ATTSYNC·BATTMAN), 블록 개수(BCOUNT), 속성 값을 남기는 분해(BURST),
 * 블록 대치(BLOCKREPLACE), 블록 안 참조 관계.
 */
import type { AttribEntity, BlockDef, CadColor, CadDocument, Entity, InsertEntity, Vec3 } from '../../core/model';
import { BYBLOCK, BYLAYER, LW_BYBLOCK, LW_BYLAYER, TRANSPARENCY_BYBLOCK, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity, isLayoutBlock } from '../session';
import { explodeEntity } from '../geom/explode';
import type { EditResult } from '../geom/types';

/** 블록 좌표 → 도면 좌표(축척·회전만, 2D) */
export function insertTransform(def: BlockDef, ins: Pick<InsertEntity, 'insert' | 'scale' | 'rotation'>): (p: Vec3) => Vec3 {
  const c = Math.cos(ins.rotation);
  const s = Math.sin(ins.rotation);
  return (p) => {
    const x = (p.x - def.basePoint.x) * ins.scale.x;
    const y = (p.y - def.basePoint.y) * ins.scale.y;
    return { x: ins.insert.x + x * c - y * s, y: ins.insert.y + x * s + y * c, z: ins.insert.z + (p.z - def.basePoint.z) * ins.scale.z };
  };
}

/** 블록 정의의 상수가 아닌 속성 정의(그리기 순서 = 속성 순서) */
export function attdefsOf(def: BlockDef): AttribEntity[] {
  return def.entities.filter((e): e is AttribEntity => e.type === 'ATTDEF' && !((e as AttribEntity).attFlags & 2));
}

/** 블록 정의의 모든 속성 정의(상수 포함) */
export function allAttdefs(def: BlockDef): AttribEntity[] {
  return def.entities.filter((e): e is AttribEntity => e.type === 'ATTDEF');
}

/**
 * 정의의 속성 정의로 참조의 속성을 만든다.
 * values: 태그(대문자) → 값. reuse: 태그(대문자) → 지킬 핸들(동기화할 때 같은 속성은 핸들을 유지한다)
 */
export function buildAttribs(
  def: BlockDef,
  ins: Pick<InsertEntity, 'insert' | 'scale' | 'rotation' | 'handle'>,
  values: Map<string, string>,
  newHandle: () => string,
  reuse: Map<string, string> = new Map(),
): AttribEntity[] {
  const tf = insertTransform(def, ins);
  const out: AttribEntity[] = [];
  const used = new Set<string>();
  for (const d of attdefsOf(def)) {
    const tag = d.tag.toUpperCase();
    const a = cloneEntity(d);
    a.type = 'ATTRIB';
    const keep = reuse.get(tag);
    a.handle = keep && !used.has(keep) ? keep : newHandle();
    used.add(a.handle);
    a.owner = ins.handle;
    a.insert = tf(d.insert);
    if (d.alignPoint) a.alignPoint = tf(d.alignPoint);
    a.height = d.height * Math.abs(ins.scale.y);
    a.rotation = d.rotation + ins.rotation;
    a.text = values.get(tag) ?? d.text;
    a.prompt = undefined;
    delete a.dwgRaw;
    if (a.mtext) {
      a.mtext.insert = tf(a.mtext.insert);
      a.mtext.height *= Math.abs(ins.scale.y);
      a.mtext.rotation += ins.rotation;
      a.mtext.direction = undefined;
      a.mtext.text = values.get(tag) ?? a.mtext.text;
      a.mtext.handle = '';
    }
    out.push(a);
  }
  return out;
}

/** 참조의 속성 값(태그 대문자 → 값, 같은 태그는 처음 것) */
export function attribValues(ins: InsertEntity): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of ins.attribs) {
    const t = a.tag.toUpperCase();
    if (!m.has(t)) m.set(t, a.mtext ? a.mtext.text : a.text);
  }
  return m;
}

/** ATTSYNC: 정의대로 속성을 다시 만들고 값(태그로)과 핸들은 지킨다. 바뀐 것이 없으면 null */
export function syncedInsert(def: BlockDef, ins: InsertEntity, newHandle: () => string): InsertEntity | null {
  const reuse = new Map<string, string>();
  for (const a of ins.attribs) if (!reuse.has(a.tag.toUpperCase()) && a.handle) reuse.set(a.tag.toUpperCase(), a.handle);
  const out = cloneEntity(ins);
  out.attribs = buildAttribs(def, ins, attribValues(ins), newHandle, reuse);
  delete out.dwgRaw;
  return JSON.stringify(stripRaw(out.attribs)) === JSON.stringify(stripRaw(ins.attribs)) ? null : out;
}

function stripRaw(list: AttribEntity[]): unknown[] {
  return list.map((a) => ({ ...a, dwgRaw: undefined }));
}

/** 블록 이름(대문자 키) → 그 블록을 참조하는 INSERT(어느 블록에 있는지와 함께) */
export function insertsOf(doc: CadDocument, name: string): { block: string; entity: InsertEntity }[] {
  const k = tableKey(name);
  const out: { block: string; entity: InsertEntity }[] = [];
  for (const [bk, b] of doc.blocks)
    for (const e of b.entities) if (e.type === 'INSERT' && tableKey(e.block) === k) out.push({ block: bk, entity: e });
  return out;
}

/** 블록 from 안에(중첩 포함) target 참조가 있는지. from === target이면 참 */
export function blockReaches(doc: CadDocument, from: string, target: string): boolean {
  const t = tableKey(target);
  const seen = new Set<string>();
  const walk = (k: string): boolean => {
    if (k === t) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    const b = doc.blocks.get(k);
    if (!b) return false;
    for (const e of b.entities) if ((e.type === 'INSERT' || e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') && e.block && walk(tableKey(e.block))) return true;
    return false;
  };
  return walk(tableKey(from));
}

/**
 * BCOUNT: 블록 이름별 참조 수. nested면 블록 안의 참조도 (바깥 참조 수만큼) 센다.
 * 값은 { 표시 이름, 개수 }, 개수가 많은 순.
 */
export function countBlocks(doc: CadDocument, entities: readonly Entity[], nested = true): { name: string; count: number }[] {
  const counts = new Map<string, { name: string; count: number }>();
  const inner = new Map<string, Map<string, number>>();
  const stack = new Set<string>();
  const add = (name: string, n: number) => {
    const k = tableKey(name);
    const c = counts.get(k);
    if (c) c.count += n;
    else counts.set(k, { name: doc.blocks.get(k)?.name ?? name, count: n });
  };
  /** 블록 하나에 들어 있는 (중첩 포함) 참조 수 */
  const innerOf = (k: string): Map<string, number> => {
    const hit = inner.get(k);
    if (hit) return hit;
    const m = new Map<string, number>();
    if (stack.has(k)) return m;
    stack.add(k);
    for (const e of doc.blocks.get(k)?.entities ?? []) {
      if (e.type !== 'INSERT') continue;
      const ck = tableKey(e.block);
      m.set(ck, (m.get(ck) ?? 0) + 1);
      for (const [nk, n] of innerOf(ck)) m.set(nk, (m.get(nk) ?? 0) + n);
    }
    stack.delete(k);
    inner.set(k, m);
    return m;
  };
  for (const e of entities) {
    if (e.type !== 'INSERT') continue;
    add(e.block, 1);
    if (nested) for (const [k, n] of innerOf(tableKey(e.block))) add(doc.blocks.get(k)?.name ?? k, n);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
}

/** 도면층의 색·선종류·선가중치(ByLayer를 풀 때) */
function layerOf(doc: CadDocument, name: string) {
  return doc.layers.get(tableKey(name));
}

/**
 * BURST: 한 단계 분해하되 속성은 값 문자로 남기고(숨김 속성은 버림), 도면층 0과 ByBlock 특성은 참조의 특성으로 바꾼다.
 */
export function burstInsert(ins: InsertEntity, doc: CadDocument): EditResult {
  const r = explodeEntity(ins, doc);
  if (!r.add?.length) return r;
  const insLayer = layerOf(doc, ins.layer);
  // 참조가 ByLayer면 참조 도면층의 값을 쓴다(조각이 다른 도면층에 있어도 모양이 같게)
  const effColor = (): CadColor => (ins.color.aci === BYLAYER && !ins.color.rgb && insLayer ? { ...insLayer.color } : { ...ins.color });
  const effLinetype = (): string => (/^bylayer$/i.test(ins.linetype) && insLayer ? insLayer.linetype : ins.linetype);
  const effLw = (): number => (ins.lineweight === LW_BYLAYER && insLayer ? insLayer.lineweight : ins.lineweight);
  for (const e of r.add) {
    const was0 = e.layer === '0';
    if (was0) e.layer = ins.layer;
    const onInsLayer = tableKey(e.layer) === tableKey(ins.layer);
    if (e.color.aci === BYBLOCK && !e.color.rgb) e.color = onInsLayer ? { ...ins.color } : effColor();
    if (/^byblock$/i.test(e.linetype)) e.linetype = onInsLayer ? ins.linetype : effLinetype();
    if (e.lineweight === LW_BYBLOCK) e.lineweight = onInsLayer ? ins.lineweight : effLw();
    if (e.transparency === TRANSPARENCY_BYBLOCK) e.transparency = ins.transparency;
  }
  return r;
}

/**
 * BLOCKREPLACE: from 블록의 모든 참조(블록 안 참조 포함)를 to 블록으로 바꾼다. 속성은 to 정의로 다시 만들고 같은 태그의 값은 지킨다.
 * 자기 참조가 되는 자리(to 안에 든 블록 정의 속의 참조)는 건너뛴다.
 */
export function replaceBlockOps(doc: CadDocument, from: string, to: string, newHandle: () => string): { ops: EditOp[]; count: number; skipped: number } {
  const toDef = doc.blocks.get(tableKey(to));
  const ops: EditOp[] = [];
  let count = 0;
  let skipped = 0;
  if (!toDef || tableKey(from) === tableKey(to)) return { ops, count, skipped };
  for (const { block, entity } of insertsOf(doc, from)) {
    if (!isLayoutBlock(block) && blockReaches(doc, to, block)) {
      skipped++;
      continue;
    }
    const after = cloneEntity(entity);
    after.block = toDef.name;
    delete after.dwgRaw;
    const reuse = new Map<string, string>();
    for (const a of entity.attribs) if (a.handle && !reuse.has(a.tag.toUpperCase())) reuse.set(a.tag.toUpperCase(), a.handle);
    after.attribs = buildAttribs(toDef, entity, attribValues(entity), newHandle, reuse);
    ops.push({ kind: 'modify', block, before: entity, after });
    count++;
  }
  return { ops, count, skipped };
}

/** 이름으로 블록을 가리키는 치수 스타일·헤더 변수가 있는지(소거 판단) */
export function blockNamedElsewhere(doc: CadDocument, name: string): boolean {
  const k = tableKey(name);
  for (const d of doc.dimStyles.values()) for (const v of ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK']) if (typeof d.vars[v] === 'string' && tableKey(d.vars[v] as string) === k) return true;
  for (const v of ['$DIMBLK', '$DIMBLK1', '$DIMBLK2', '$DIMLDRBLK']) {
    const x = doc.header.get(v);
    if (typeof x === 'string' && tableKey(x) === k) return true;
  }
  const rec = doc.blockRecords.get(k);
  if (rec?.handle) {
    for (const b of doc.blocks.values())
      for (const e of b.entities)
        if (e.type === 'MULTILEADER' && (e.blockHandle === rec.handle || e.arrowHeadHandle === rec.handle || e.context.block?.blockHandle === rec.handle)) return true;
  }
  return false;
}

/** 블록이 어디서도 참조되지 않으면 정의를 지우는 작업(소거) */
export function purgeBlockOps(doc: CadDocument, name: string): EditOp[] {
  const k = tableKey(name);
  const def = doc.blocks.get(k);
  if (!def || isLayoutBlock(k) || insertsOf(doc, name).length || blockNamedElsewhere(doc, name)) return [];
  for (const b of doc.blocks.values()) for (const e of b.entities) if ((e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') && e.block && tableKey(e.block) === k) return [];
  const ops: EditOp[] = [{ kind: 'blockDef', key: k, before: def, after: null }];
  const rec = doc.blockRecords.get(k);
  if (rec) ops.push({ kind: 'blockRecord', key: k, before: rec, after: null });
  return ops;
}

/** BATTMAN: 속성 정의 목록(순서·내용)을 정의에 넣는다. 속성 정의가 있던 자리를 새 순서로 채우고 남으면 끝에 붙인다 */
export function withAttdefs(def: BlockDef, list: readonly AttribEntity[]): BlockDef {
  const out: Entity[] = [];
  let i = 0;
  for (const e of def.entities) {
    if (e.type === 'ATTDEF') {
      if (i < list.length) out.push(list[i++]!);
      continue;
    }
    out.push(e);
  }
  while (i < list.length) out.push(list[i++]!);
  return { ...def, entities: out, flags: list.length ? def.flags | 2 : def.flags & ~2 };
}

/**
 * 블록의 모든 참조를 정의(def — 아직 문서에 넣지 않은 새 정의일 수 있다)와 맞추는 작업.
 * 잠긴 도면층의 참조는 건너뛴다.
 */
export function syncAllOps(doc: CadDocument, name: string, newHandle: () => string, def: BlockDef | undefined = doc.blocks.get(tableKey(name))): { ops: EditOp[]; count: number; locked: number } {
  const ops: EditOp[] = [];
  let count = 0;
  let locked = 0;
  if (!def) return { ops, count, locked };
  for (const { block, entity } of insertsOf(doc, name)) {
    if (doc.layers.get(tableKey(entity.layer))?.locked) {
      locked++;
      continue;
    }
    count++;
    const after = syncedInsert(def, entity, newHandle);
    if (after) ops.push({ kind: 'modify', block, before: entity, after });
  }
  return { ops, count, locked };
}
