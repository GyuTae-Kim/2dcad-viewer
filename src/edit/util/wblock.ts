/**
 * WBLOCK(UI 없음): 블록·객체·전체 도면으로 새 도면 문서를 만든다.
 * - 블록·객체: 기준점이 새 도면의 원점이 되도록 옮겨 모형 공간에 넣는다. 배치는 첫 종이 배치 하나만(비워서) 남긴다.
 * - 전체 도면: 그대로 둔다.
 * - 어느 쪽이든 쓰이지 않는 명명된 객체(블록·도면층·선종류·문자 스타일·치수 스타일)는 빼고 넣는다(AutoCAD의 WBLOCK과 같다).
 * 원본 문서는 바꾸지 않는다(구조 복제 위에서 일한다).
 */
import type { BlockDef, BlockRecord, CadDocument, DictionaryObject, Entity, MLeaderStyleObject, MLineStyleObject } from '../../core/model';
import { MODEL_SPACE, normalizeHandle, tableKey } from '../../core/model';
import { isLayoutBlock } from '../session';
import { affTranslate } from '../geom/math';
import { transformEntity } from '../geom/transform';
import { boundsOf } from '../geom/query';
import { maxHandle } from './audit';
import { groupDictionary } from './groups';

export type WblockSource =
  | { kind: 'block'; name: string }
  | { kind: 'objects'; handles: readonly string[]; base: { x: number; y: number; z?: number } }
  | { kind: 'all' };

export interface WblockResult {
  doc: CadDocument;
  /** 새 도면 모형 공간의 객체 수 */
  entities: number;
  /** 옮기지 못해 뺀 객체 수 */
  skipped: number;
}

const KEEP_LT = new Set(['BYLAYER', 'BYBLOCK', 'CONTINUOUS']);

export function buildWblockDocument(src: CadDocument, source: WblockSource, opt: { insUnits?: number } = {}): WblockResult {
  const out: CadDocument = structuredClone(src);
  out.warnings = [];
  let seed = maxHandle(out) + 1n;
  const newHandle = () => normalizeHandle((seed++).toString(16));
  let skipped = 0;

  if (source.kind !== 'all') {
    const model = out.blocks.get(MODEL_SPACE);
    if (!model) throw new Error('모형 공간이 없습니다.');
    let list: Entity[] = [];
    let base = { x: 0, y: 0, z: 0 };
    if (source.kind === 'block') {
      const k = tableKey(source.name);
      const def = out.blocks.get(k);
      if (!def || isLayoutBlock(k)) throw new Error(`블록 "${source.name}"이(가) 없습니다.`);
      base = { ...def.basePoint };
      list = def.entities;
      out.blocks.delete(k);
      out.blockRecords.delete(k);
      if (opt.insUnits === undefined) opt = { ...opt, insUnits: src.blockRecords.get(k)?.insertUnits };
    } else {
      base = { x: source.base.x, y: source.base.y, z: source.base.z ?? 0 };
      const want = new Set(source.handles.map((h) => normalizeHandle(h)));
      // 그리기 순서를 지킨다(모형, 그다음 배치 순서)
      for (const l of out.layouts) {
        const b = out.blocks.get(tableKey(l.blockName));
        for (const e of b?.entities ?? []) {
          if (!want.has(normalizeHandle(e.handle))) continue;
          if (e.type === 'VIEWPORT') {
            skipped++;
            continue;
          }
          list.push(e);
        }
      }
    }
    // 기준점 → 원점
    const m = affTranslate(-base.x, -base.y);
    const moved: Entity[] = [];
    for (const e of list) {
      let r: Entity | undefined;
      if (base.x === 0 && base.y === 0 && base.z === 0) r = e;
      else {
        try {
          const res = transformEntity(e, m, out, { dz: -base.z });
          r = res.replace?.[0] ?? res.add?.[0];
          for (const nb of res.blocks ?? []) {
            const name = addBlock(out, nb, newHandle);
            if (r && (r.type === 'DIMENSION' || r.type === 'ACAD_TABLE') && r.block === nb.name) r.block = name;
          }
        } catch {
          r = undefined;
        }
      }
      if (!r) {
        skipped++;
        continue;
      }
      if (!r.handle) r.handle = e.handle || newHandle();
      r.owner = model.recordHandle;
      r.paperSpace = undefined;
      delete r.dwgRaw;
      if (r.type === 'INSERT') for (const a of r.attribs) a.owner = r.handle;
      moved.push(r);
    }
    model.entities = moved;
    // 배치: 첫 종이 배치만 비워 둔다
    const papers = out.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder);
    const keep = papers[0];
    for (const l of papers) {
      const k = tableKey(l.blockName);
      if (l === keep) {
        const b = out.blocks.get(k);
        if (b) b.entities = [];
        continue;
      }
      out.blocks.delete(k);
      out.blockRecords.delete(k);
      out.objects.delete(l.handle);
      for (const o of out.objects.values()) {
        if (o.type !== 'DICTIONARY' && o.type !== 'ACDBDICTIONARYWDFLT') continue;
        const d = o as DictionaryObject;
        for (const [name, h] of [...d.entries]) if (normalizeHandle(h) === normalizeHandle(l.handle)) d.entries.delete(name);
      }
    }
    out.layouts = out.layouts.filter((l) => tableKey(l.blockName) === MODEL_SPACE || l === keep);
    // 그룹은 옮기지 않는다
    const gd = groupDictionary(out);
    if (gd) {
      for (const h of gd.entries.values()) out.objects.delete(normalizeHandle(h));
      gd.entries.clear();
    }
    out.header.set('$INSBASE', { x: 0, y: 0, z: 0 });
  }
  if (opt.insUnits !== undefined) out.header.set('$INSUNITS', opt.insUnits);

  purgeUnused(out);
  rebuildIndex(out);
  // 없어진 객체를 가리키는 반응자는 뺀다
  for (const b of out.blocks.values())
    for (const e of b.entities) {
      if (e.reactors?.length) {
        const r = e.reactors.filter((h) => out.objects.has(normalizeHandle(h)) || out.entityIndex.has(normalizeHandle(h)));
        e.reactors = r.length ? r : undefined;
      }
    }
  const model = out.blocks.get(MODEL_SPACE)!;
  if (source.kind !== 'all') {
    const bb = boundsOf(model.entities, out);
    if (bb) {
      out.header.set('$EXTMIN', { x: bb.minX, y: bb.minY, z: 0 });
      out.header.set('$EXTMAX', { x: bb.maxX, y: bb.maxY, z: 0 });
    }
  }
  out.header.set('$HANDSEED', normalizeHandle(seed.toString(16)));
  return { doc: out, entities: model.entities.length, skipped };
}

/** 새 블록 정의를 넣는다(익명 *D·*T는 번호를 붙인다). 넣은 이름을 돌려준다 */
function addBlock(doc: CadDocument, b: BlockDef, newHandle: () => string): string {
  const def: BlockDef = { ...b };
  if (/^\*[A-Z]$/i.test(def.name)) {
    let n = 1;
    while (doc.blocks.has(tableKey(`${def.name}${n}`))) n++;
    def.name = `${def.name}${n}`;
  }
  const key = tableKey(def.name);
  const rec: BlockRecord = { name: def.name, handle: newHandle(), flags: def.flags & 1, insertUnits: 0, explodable: true, scalable: true };
  def.recordHandle = rec.handle;
  def.handle = newHandle();
  def.endHandle = newHandle();
  for (const e of def.entities) {
    if (!e.handle) e.handle = newHandle();
    e.owner = rec.handle;
  }
  doc.blocks.set(key, def);
  doc.blockRecords.set(key, rec);
  return def.name;
}

function eachEntity(b: BlockDef, f: (e: Entity) => void): void {
  for (const e of b.entities) {
    f(e);
    if (e.type === 'INSERT') for (const a of e.attribs) f(a);
  }
}

/** 쓰이지 않는 블록·도면층·선종류·문자 스타일·치수 스타일을 뺀다 */
export function purgeUnused(doc: CadDocument): void {
  const hs = (n: string) => {
    const v = doc.header.get(n);
    return typeof v === 'string' ? tableKey(v) : '';
  };
  // 블록: 배치 블록에서 닿는 것
  const byRecord = new Map<string, string>();
  for (const [k, b] of doc.blocks) if (b.recordHandle) byRecord.set(normalizeHandle(b.recordHandle), k);
  const reach = new Set<string>();
  const queue: string[] = [];
  const visit = (k: string | undefined) => {
    if (!k || reach.has(k) || !doc.blocks.has(k)) return;
    reach.add(k);
    queue.push(k);
  };
  const visitH = (h: string | undefined) => visit(h ? byRecord.get(normalizeHandle(h)) : undefined);
  for (const k of doc.blocks.keys()) if (isLayoutBlock(k)) visit(k);
  const usedDim = new Set<string>(['STANDARD', hs('$DIMSTYLE')]);
  const walkQueue = () => {
    while (queue.length) {
      const b = doc.blocks.get(queue.pop()!)!;
      for (const e of b.entities) {
        if ((e.type === 'INSERT' || e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') && e.block) visit(tableKey(e.block));
        if (e.type === 'MULTILEADER') {
          visitH(e.blockHandle);
          visitH(e.arrowHeadHandle);
          visitH(e.context.block?.blockHandle);
        }
        if (e.type === 'DIMENSION' || e.type === 'LEADER' || e.type === 'TOLERANCE') usedDim.add(tableKey(e.dimStyle));
      }
    }
  };
  for (const o of doc.objects.values())
    if (o.type === 'MLEADERSTYLE') {
      visitH((o as MLeaderStyleObject).blockHandle);
      visitH((o as MLeaderStyleObject).arrowHeadHandle);
    }
  for (const v of ['$DIMBLK', '$DIMBLK1', '$DIMBLK2', '$DIMLDRBLK']) visit(hs(v) || undefined);
  // 치수 스타일(하위 스타일 포함)과 그 화살촉 블록: 새로 닿은 블록이 없을 때까지
  for (let guard = 0; guard < 20; guard++) {
    walkQueue();
    for (const k of [...usedDim]) for (const d of doc.dimStyles.values()) if (tableKey(d.name).startsWith(`${k}$`)) usedDim.add(tableKey(d.name));
    for (const k of usedDim) {
      const d = doc.dimStyles.get(k);
      if (!d) continue;
      for (const v of ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK']) if (typeof d.vars[v] === 'string' && d.vars[v]) visit(tableKey(d.vars[v] as string));
    }
    if (!queue.length) break;
  }
  for (const k of [...doc.blocks.keys()])
    if (!reach.has(k)) {
      doc.blocks.delete(k);
      doc.blockRecords.delete(k);
    }
  for (const k of [...doc.blockRecords.keys()]) if (!doc.blocks.has(k)) doc.blockRecords.delete(k);
  for (const k of [...doc.dimStyles.keys()]) if (!usedDim.has(k)) doc.dimStyles.delete(k);

  // 도면층·선종류·문자 스타일
  const layers = new Set<string>(['0', 'DEFPOINTS', hs('$CLAYER')]);
  const lts = new Set<string>([...KEEP_LT, hs('$CELTYPE'), hs('$DIMLTYPE'), hs('$DIMLTEX1'), hs('$DIMLTEX2')]);
  const styles = new Set<string>(['STANDARD', hs('$TEXTSTYLE'), hs('$DIMTXSTY')]);
  const handles = new Set<string>();
  for (const b of doc.blocks.values())
    eachEntity(b, (e) => {
      layers.add(tableKey(e.layer));
      if (e.linetype) lts.add(tableKey(e.linetype));
      const st = (e as { style?: string }).style;
      if ((e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF') && st) styles.add(tableKey(st));
      const mt = (e as { mtext?: { style: string } }).mtext;
      if (mt?.style) styles.add(tableKey(mt.style));
      if (e.type === 'SHAPE' && e.styleHandle) handles.add(normalizeHandle(e.styleHandle));
      if (e.type === 'MULTILEADER') {
        for (const h of [e.textStyleHandle, e.context.text?.styleHandle, e.leaderLineTypeHandle]) if (h) handles.add(normalizeHandle(h));
      }
    });
  for (const d of doc.dimStyles.values()) {
    if (typeof d.vars.DIMTXSTY === 'string') styles.add(tableKey(d.vars.DIMTXSTY));
    for (const v of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2']) if (typeof d.vars[v] === 'string' && d.vars[v]) lts.add(tableKey(d.vars[v] as string));
  }
  for (const o of doc.objects.values()) {
    if (o.type === 'MLINESTYLE') for (const x of (o as MLineStyleObject).elements) lts.add(tableKey(x.linetype));
    if (o.type === 'MLEADERSTYLE' && (o as MLeaderStyleObject).textStyleHandle) handles.add(normalizeHandle((o as MLeaderStyleObject).textStyleHandle!));
  }
  for (const k of [...doc.layers.keys()]) if (!layers.has(k)) doc.layers.delete(k);
  for (const l of doc.layers.values()) lts.add(tableKey(l.linetype));
  for (const lt of doc.linetypes.values()) for (const el of lt.elements) if (el.styleHandle) handles.add(normalizeHandle(el.styleHandle));
  for (const [k, lt] of [...doc.linetypes]) if (!lts.has(k) && !handles.has(normalizeHandle(lt.handle))) doc.linetypes.delete(k);
  for (const [k, s] of [...doc.textStyles]) if (!styles.has(k) && !(s.flags & 1) && !handles.has(normalizeHandle(s.handle))) doc.textStyles.delete(k);
}

/** 핸들 색인을 다시 만든다 */
export function rebuildIndex(doc: CadDocument): void {
  doc.entityIndex.clear();
  for (const b of doc.blocks.values()) eachEntity(b, (e) => e.handle && doc.entityIndex.set(e.handle, e));
}
