/**
 * 비교 도면의 객체를 현재 도면(또는 스냅샷 도면)으로 옮기는 계획과 스냅샷 도면 만들기(DOM 없음).
 *
 * 붙여넣기와 같은 규칙: 없는 도면층·선종류·문자 스타일·치수 스타일·블록을 함께 가져오고, 같은 이름의 블록
 * 정의는 받는 도면의 것이 이긴다. 익명 블록(*U, *D, *T …)은 이름이 겹치면 새 번호로 바꿔 가져온다
 * (치수 그림처럼 이름이 파일마다 우연히 같기 때문이다).
 */
import type { BlockDef, BlockRecord, CadDocument, CadColor, DimStyle, Entity, Layer, Linetype, LwPolylineEntity, LwVertex, TextStyle } from '../../core/model';
import { MODEL_SPACE, entityDefaults, normalizeHandle, tableKey } from '../../core/model';
import { nearestAci } from '../../core/color';
import { finalizeDocument } from '../../core/finalize';
import { parseCompareColor } from './settings';
import { packLw } from '../../core/lwpoly';

export interface ImportPlan {
  layers: Layer[];
  linetypes: Linetype[];
  textStyles: TextStyle[];
  dimStyles: DimStyle[];
  /** 넣을 블록(안쪽 블록이 먼저) */
  blocks: { record: BlockRecord; def: BlockDef }[];
  /** 가져오며 이름을 바꾼 블록: 원래 이름(대문자) → 새 이름 */
  rename: Map<string, string>;
}

/** 객체를 새로 넣을 수 있게: 핸들·확장 사전·반응자·원본 바이트를 지운다(속성 포함) */
export function stripEntity<T extends Entity>(e: T): T {
  e.handle = '';
  delete e.xdict;
  delete e.reactors;
  delete e.dwgRaw;
  delete e.owner;
  if (e.type === 'INSERT') for (const a of e.attribs) stripEntity(a as Entity);
  return e;
}

/** 블록 이름을 쓰는 객체의 이름을 바꾼다 */
export function renameBlocks(e: Entity, rename: ReadonlyMap<string, string>): void {
  if (!rename.size) return;
  if (e.type === 'INSERT' || e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') {
    const n = rename.get(tableKey(e.block ?? ''));
    if (n) e.block = n;
  }
}

/**
 * src 객체 list를 dst로 옮길 때 함께 가져올 것. list는 이미 복사한 객체여야 한다(블록 이름을 바꾼다).
 * newHandle은 dst의 새 핸들을 하나씩 준다.
 */
export function planImport(src: CadDocument, dst: CadDocument, list: Entity[], newHandle: () => string): ImportPlan {
  const plan: ImportPlan = { layers: [], linetypes: [], textStyles: [], dimStyles: [], blocks: [], rename: new Map() };
  if (src === dst) return plan;
  const done = new Set<string>();
  const first = (kind: string, name: string | undefined) => {
    if (!name) return false;
    const k = `${kind}:${tableKey(name)}`;
    if (done.has(k)) return false;
    done.add(k);
    return true;
  };
  const linetype = (name: string | undefined) => {
    if (!name || /^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(name) || !first('lt', name)) return;
    const key = tableKey(name);
    const lt = src.linetypes.get(key);
    if (lt && !dst.linetypes.has(key)) plan.linetypes.push({ ...structuredClone(lt), handle: newHandle() });
  };
  const layer = (name: string | undefined) => {
    if (!name || !first('la', name)) return;
    const key = tableKey(name);
    const la = src.layers.get(key);
    if (la && !dst.layers.has(key)) {
      linetype(la.linetype);
      plan.layers.push({ ...structuredClone(la), handle: newHandle() });
    }
  };
  const textStyle = (name: string | undefined) => {
    if (!name || !first('st', name)) return;
    const key = tableKey(name);
    const ts = src.textStyles.get(key);
    if (ts && !dst.textStyles.has(key)) plan.textStyles.push({ ...structuredClone(ts), handle: newHandle() });
  };
  const dimStyle = (name: string | undefined) => {
    if (!name || !first('ds', name)) return;
    const key = tableKey(name);
    const ds = src.dimStyles.get(key);
    if (ds && !dst.dimStyles.has(key)) plan.dimStyles.push({ ...structuredClone(ds), handle: newHandle() });
  };
  const taken = new Set<string>();
  const freshName = (name: string): string => {
    const m = /^(\*[A-Z]*)/i.exec(name);
    const prefix = (m?.[1] ?? '*U').toUpperCase();
    let n = 1;
    for (const k of dst.blocks.keys()) {
      const mm = new RegExp(`^\\${prefix}(\\d+)$`).exec(k);
      if (mm) n = Math.max(n, Number(mm[1]) + 1);
    }
    while (dst.blocks.has(`${prefix}${n}`) || taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  const block = (name: string) => {
    const key = tableKey(name);
    if (!first('bl', key)) return;
    const def = src.blocks.get(key);
    if (!def) return;
    let newName = def.name;
    if (dst.blocks.has(key) || taken.has(key)) {
      // 이름 있는 블록은 받는 도면의 것이 이긴다
      if (!key.startsWith('*')) return;
      newName = freshName(key);
      plan.rename.set(key, newName);
    }
    taken.add(tableKey(newName));
    const ents = def.entities.map((e) => stripEntity(structuredClone(e)));
    for (const e of ents) visit(e);
    for (const e of ents) renameBlocks(e, plan.rename);
    const rec0 = src.blockRecords.get(key);
    const record: BlockRecord = rec0
      ? { ...structuredClone(rec0), name: newName, handle: newHandle() }
      : { name: newName, handle: newHandle(), flags: def.flags & 1, insertUnits: 0, explodable: true, scalable: true };
    delete record.layout;
    delete record.xdict;
    for (const e of ents) {
      e.handle = newHandle();
      e.owner = record.handle;
      if (e.type === 'INSERT')
        for (const a of e.attribs) {
          a.handle = newHandle();
          a.owner = e.handle;
        }
    }
    const copy: BlockDef = { ...structuredClone({ ...def, entities: [] }), name: newName, handle: newHandle(), recordHandle: record.handle, endHandle: newHandle(), entities: ents };
    plan.blocks.push({ record, def: copy });
  };
  const visit = (e: Entity) => {
    layer(e.layer);
    linetype(e.linetype);
    const x = e as unknown as { style?: string; dimStyle?: string; block?: string; tableStyle?: string };
    if (typeof x.style === 'string') textStyle(x.style);
    if (typeof x.dimStyle === 'string') dimStyle(x.dimStyle);
    if ((e.type === 'INSERT' || e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') && typeof x.block === 'string' && x.block) block(x.block);
    if (e.type === 'INSERT') for (const a of e.attribs) visit(a);
  };
  for (const e of list) visit(e);
  for (const e of list) renameBlocks(e, plan.rename);
  return plan;
}

/** 문서에서 쓰인 가장 큰 핸들 다음부터 새 핸들을 주는 함수(끝나면 $HANDSEED를 맞춘다) */
export function handleAllocator(doc: CadDocument): { next: () => string; commit: () => void } {
  let max = 0n;
  const see = (h: string | undefined) => {
    if (!h) return;
    try {
      const v = BigInt('0x' + h);
      if (v > max) max = v;
    } catch {
      /* 핸들이 아닌 값 */
    }
  };
  for (const h of doc.entityIndex.keys()) see(h);
  for (const h of doc.objects.keys()) see(h);
  for (const b of doc.blocks.values()) {
    see(b.handle);
    see(b.recordHandle);
    see(b.endHandle);
    for (const e of b.entities) see(e.handle);
  }
  for (const t of [doc.layers, doc.linetypes, doc.textStyles, doc.dimStyles, doc.views, doc.ucs, doc.appIds, doc.blockRecords] as Map<string, { handle: string }>[]) for (const r of t.values()) see(r.handle);
  for (const v of doc.vports) see(v.handle);
  for (const t of doc.tableHeads?.values() ?? []) see(t.handle);
  const seed = doc.header.get('$HANDSEED');
  if (typeof seed === 'string') {
    try {
      const v = BigInt('0x' + seed) - 1n;
      if (v > max) max = v;
    } catch {
      /* 무시 */
    }
  }
  let n = max;
  return {
    next: () => {
      n += 1n;
      return normalizeHandle(n.toString(16));
    },
    commit: () => {
      doc.header.set('$HANDSEED', normalizeHandle((n + 1n).toString(16)));
    },
  };
}

/** 비교 색상 글 → 도면층 색 */
export function layerColor(text: string, fallbackAci: number): CadColor {
  const c = parseCompareColor(text);
  if (!c) return { aci: fallbackAci };
  if ('aci' in c) return { aci: c.aci };
  return { aci: nearestAci(c.rgb), rgb: c.rgb };
}

export const SNAPSHOT_LAYERS = {
  current: '비교-현재 도면에서만',
  common: '비교-차이 없음',
  compare: '비교-비교 도면에서만',
  cloud: '비교-구름형 리비전',
} as const;

export interface SnapshotInput {
  current: CadDocument;
  compare: CadDocument;
  /** 현재 도면에서만 있는 객체 핸들 */
  onlyCurrent: Iterable<string>;
  /** 비교 도면에서만 있는 객체 핸들 */
  onlyCompare: Iterable<string>;
  /** 구름 정점 목록 */
  clouds: LwVertex[][];
  colors: { current: string; compare: string; common: string; cloud: number };
}

/**
 * 스냅샷 도면: 현재 도면의 사본에서 모형 공간 객체를 "현재 도면에서만"·"차이 없음" 도면층으로, 비교 도면에만 있는
 * 객체를 붙여넣기처럼 가져와 "비교 도면에서만" 도면층으로, 구름을 "구름형 리비전" 도면층으로 옮긴다.
 * 객체 색은 ByLayer(도면층 색 = 비교 색상). 블록 안 객체는 원래 색을 지킨다.
 */
export function buildSnapshot(inp: SnapshotInput): { doc: CadDocument; counts: { current: number; common: number; compare: number; clouds: number } } {
  const doc = structuredClone(inp.current);
  const alloc = handleAllocator(doc);
  const ms = doc.blocks.get(MODEL_SPACE);
  if (!ms) throw new Error('모형 공간이 없습니다');
  const addLayer = (name: string, color: CadColor) => {
    const key = tableKey(name);
    const cur = doc.layers.get(key);
    if (cur) {
      cur.color = color;
      cur.off = false;
      cur.frozen = false;
      return;
    }
    doc.layers.set(key, { name, handle: alloc.next(), flags: 0, color, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 });
  };
  addLayer(SNAPSHOT_LAYERS.current, layerColor(inp.colors.current, 82));
  addLayer(SNAPSHOT_LAYERS.common, layerColor(inp.colors.common, 253));
  addLayer(SNAPSHOT_LAYERS.compare, layerColor(inp.colors.compare, 1));
  addLayer(SNAPSHOT_LAYERS.cloud, { aci: inp.colors.cloud });
  const onlyCur = new Set(inp.onlyCurrent);
  const counts = { current: 0, common: 0, compare: 0, clouds: 0 };
  const byLayer = (e: Entity, layer: string) => {
    e.layer = layer;
    e.color = { aci: 256 };
    delete e.dwgRaw;
  };
  for (const e of ms.entities) {
    if (e.type === 'VIEWPORT') continue;
    const cur = onlyCur.has(e.handle);
    byLayer(e, cur ? SNAPSHOT_LAYERS.current : SNAPSHOT_LAYERS.common);
    if (cur) counts.current++;
    else counts.common++;
  }
  // 비교 도면에만 있는 객체(붙여넣기처럼)
  const want = new Set(inp.onlyCompare);
  const src = inp.compare.blocks.get(MODEL_SPACE)?.entities ?? [];
  const list = src.filter((e) => want.has(e.handle)).map((e) => stripEntity(structuredClone(e)));
  const plan = planImport(inp.compare, doc, list, alloc.next);
  applyPlan(doc, plan);
  for (const e of list) {
    e.handle = alloc.next();
    e.owner = ms.recordHandle;
    if (e.type === 'INSERT')
      for (const a of e.attribs) {
        a.handle = alloc.next();
        a.owner = e.handle;
      }
    byLayer(e, SNAPSHOT_LAYERS.compare);
    e.paperSpace = undefined;
    ms.entities.push(e);
    counts.compare++;
  }
  for (const vs of inp.clouds) {
    if (vs.length < 2) continue;
    const c: LwPolylineEntity = {
      type: 'LWPOLYLINE',
      ...entityDefaults(),
      handle: alloc.next(),
      owner: ms.recordHandle,
      layer: SNAPSHOT_LAYERS.cloud,
      ...packLw(vs),
      closed: true,
      plinegen: false,
      constantWidth: 0,
      elevation: 0,
    };
    ms.entities.push(c);
    counts.clouds++;
  }
  alloc.commit();
  finalizeDocument(doc);
  return { doc, counts };
}

/** 계획을 문서에 바로 넣는다(스냅샷용. 열린 도면은 편집 작업으로 넣는다) */
export function applyPlan(doc: CadDocument, plan: ImportPlan): void {
  for (const l of plan.linetypes) doc.linetypes.set(tableKey(l.name), l);
  for (const l of plan.layers) doc.layers.set(tableKey(l.name), l);
  for (const s of plan.textStyles) doc.textStyles.set(tableKey(s.name), s);
  for (const s of plan.dimStyles) doc.dimStyles.set(tableKey(s.name), s);
  for (const b of plan.blocks) {
    const key = tableKey(b.def.name);
    doc.blockRecords.set(key, b.record);
    doc.blocks.set(key, b.def);
  }
}
