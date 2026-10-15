/**
 * 외부 참조 부착·결합·변환(UI 없음): XATTACH, XBIND·-XBIND, BLOCKTOXREF.
 *
 * - 부착: 외부 참조 블록(플래그 4, 중첩이면 8, 확인됨 32, 객체 없음)과 블록 레코드를 만들고, 참조 도면의 이름 있는 객체를
 *   AutoCAD처럼 `참조|이름` 의존 기호(플래그 16·32)로 이 도면에 둔다(도면층 상태 재지정·XBIND가 쓴다).
 * - 결합(XBIND): 의존 기호 하나씩을 `참조$n$이름`의 보통 기호로 바꾼다(n은 이 도면에 없는 가장 작은 수).
 *   도면층을 결합하면 그 선종류도, 블록을 결합하면 블록이 쓰는 도면층·선종류·문자 스타일도 함께 결합한다.
 *   결합한 기호의 `참조|이름` 레코드는 지운다(AutoCAD처럼 다음에 참조를 다시 로드할 때 되살아난다).
 * - BLOCKTOXREF: 블록의 모든 참조를 고른 도면의 외부 참조로 바꾼다(속성은 빠진다).
 */
import type { BlockDef, BlockRecord, CadDocument, DimStyle, Entity, EntityBase, InsertEntity, Layer, Linetype, TextStyle, Vec3 } from '../../core/model';
import { createDocument, entityDefaults, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity, isLayoutBlock } from '../session';
import { bindMapper, createImporter, isFixedName, type NameKind } from '../refedit/names';
import { blockNamedElsewhere, insertsOf } from '../util/blockutil';

export type SymKind = NameKind;
export const SYM_KINDS: SymKind[] = ['block', 'dimStyle', 'layer', 'linetype', 'textStyle'];
export const SYM_LABEL: Record<SymKind, string> = { block: '블록', dimStyle: '치수 스타일', layer: '도면층', linetype: '선종류', textStyle: '문자 스타일' };

const DEP = 16 | 32;
const DIM_NAME_VARS = ['DIMTXSTY', 'DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2'] as const;

/** 참조 도면에서 이름으로 옮길 수 있는 블록(배치·익명·외부 참조·의존 블록 빼고) */
export function userBlockNames(doc: CadDocument): string[] {
  return [...doc.blocks.values()].filter((b) => !b.name.startsWith('*') && !(b.flags & (4 | 16)) && !b.name.includes('|') && !isLayoutBlock(tableKey(b.name))).map((b) => b.name);
}

function tableOf(doc: CadDocument, kind: SymKind): Map<string, { name: string }> {
  switch (kind) {
    case 'layer':
      return doc.layers;
    case 'linetype':
      return doc.linetypes;
    case 'textStyle':
      return doc.textStyles;
    case 'dimStyle':
      return doc.dimStyles;
    case 'block':
      return doc.blocks;
  }
}

// ---------------------------------------------------------------------------
// 부착
// ---------------------------------------------------------------------------

export interface XrefDefOptions {
  /** 블록 이름(보통 파일 이름에서 확장자를 뺀 것) */
  name: string;
  /** 도면에 적을 경로(파일 이름) */
  path: string;
  /** 중첩(오버레이) */
  overlay: boolean;
  /** 참조 도면(읽었으면). 기준점·단위·의존 기호를 여기서 가져온다 */
  xdoc: CadDocument | null;
}

/** 외부 참조 블록·레코드와 의존 기호를 만드는 작업. 같은 이름의 외부 참조가 이미 있으면 빈 작업 */
export function xrefDefinitionOps(host: CadDocument, o: XrefDefOptions, newHandle: () => string): { ops: EditOp[]; created: boolean } {
  const key = tableKey(o.name);
  const old = host.blocks.get(key);
  if (old) {
    if (!(old.flags & 4)) throw new Error(`"${old.name}"은(는) 이미 이 도면의 블록 이름입니다.`);
    return { ops: [], created: false };
  }
  const x = o.xdoc;
  const ib = x?.header.get('$INSBASE');
  const base: Vec3 = ib && typeof ib === 'object' ? { x: ib.x, y: ib.y, z: 'z' in ib ? ib.z : 0 } : { x: 0, y: 0, z: 0 };
  const rec: BlockRecord = { name: o.name, handle: newHandle(), flags: 0, insertUnits: Number(x?.header.get('$INSUNITS') ?? 0) || 0, explodable: true, scalable: true };
  const def: BlockDef = { name: o.name, handle: newHandle(), recordHandle: rec.handle, basePoint: base, flags: 4 | 32 | (o.overlay ? 8 : 0), xrefPath: o.path, entities: [], endHandle: newHandle() };
  const ops: EditOp[] = [
    { kind: 'blockRecord', key, before: null, after: rec },
    { kind: 'blockDef', key, before: null, after: def },
  ];
  if (x) ops.push(...dependentRecordOps(host, o.name, x, newHandle));
  return { ops, created: true };
}

/** 참조 도면의 도면층·선종류·문자 스타일·치수 스타일을 `참조|이름` 의존 기호로(이 도면에 없는 것만) */
export function dependentRecordOps(host: CadDocument, xname: string, x: CadDocument, newHandle: () => string): EditOp[] {
  const ops: EditOp[] = [];
  const dep = (n: string) => `${xname}|${n}`;
  const lt = (n: string) => (isFixedName('linetype', n) ? n : dep(n));
  for (const s of x.textStyles.values()) {
    const k = tableKey(dep(s.name));
    if (host.textStyles.has(k)) continue;
    const after: TextStyle = { ...structuredClone(s), name: dep(s.name), handle: newHandle(), flags: s.flags | DEP, xdict: undefined };
    ops.push({ kind: 'textStyle', key: k, before: null, after });
  }
  const styleName = new Map([...x.textStyles.values()].filter((s) => s.handle).map((s) => [s.handle.toUpperCase(), dep(s.name)]));
  const newStyleHandle = new Map<string, string>();
  for (const op of ops) if (op.kind === 'textStyle' && op.after) newStyleHandle.set(tableKey(op.after.name), op.after.handle);
  for (const l of x.linetypes.values()) {
    if (isFixedName('linetype', l.name)) continue;
    const k = tableKey(dep(l.name));
    if (host.linetypes.has(k)) continue;
    const after: Linetype = { ...structuredClone(l), name: dep(l.name), handle: newHandle(), flags: l.flags | DEP, xdict: undefined };
    for (const el of after.elements) {
      if (!el.styleHandle) continue;
      const n = styleName.get(el.styleHandle.toUpperCase());
      const h = n ? (host.textStyles.get(tableKey(n))?.handle ?? newStyleHandle.get(tableKey(n))) : undefined;
      if (h) el.styleHandle = h;
      else delete el.styleHandle;
    }
    ops.push({ kind: 'linetype', key: k, before: null, after });
  }
  for (const l of x.layers.values()) {
    if (isFixedName('layer', l.name)) continue;
    const k = tableKey(dep(l.name));
    if (host.layers.has(k)) continue;
    const after: Layer = { ...structuredClone(l), name: dep(l.name), handle: newHandle(), flags: l.flags | DEP, linetype: lt(l.linetype || 'Continuous'), xdict: undefined, plotStyle: undefined };
    ops.push({ kind: 'layer', key: k, before: null, after });
  }
  for (const d of x.dimStyles.values()) {
    const k = tableKey(dep(d.name));
    if (host.dimStyles.has(k)) continue;
    const after: DimStyle = { ...structuredClone(d), name: dep(d.name), handle: newHandle(), flags: d.flags | DEP, xdict: undefined };
    const v = after.vars;
    if (typeof v.DIMTXSTY === 'string' && v.DIMTXSTY) v.DIMTXSTY = dep(v.DIMTXSTY);
    for (const n of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2'])
      if (typeof v[n] === 'string' && v[n] && !isFixedName('linetype', v[n] as string)) v[n] = dep(v[n] as string);
    ops.push({ kind: 'dimStyle', key: k, before: null, after });
  }
  return ops;
}

export interface XrefInsertOptions {
  /** 공간 블록 키 */
  space: string;
  insert: Vec3;
  scale: Vec3;
  rotation: number;
  /** 새 객체 특성(도면층·색 …) */
  props: Omit<EntityBase, 'type' | 'handle'>;
}

/** 외부 참조 블록의 참조(INSERT) */
export function xrefInsert(host: CadDocument, name: string, o: XrefInsertOptions, newHandle: () => string, recordHandle?: string): InsertEntity {
  const ins: InsertEntity = {
    ...entityDefaults(),
    ...o.props,
    type: 'INSERT',
    handle: newHandle(),
    owner: recordHandle ?? host.blocks.get(o.space)?.recordHandle,
    block: name,
    insert: { ...o.insert },
    scale: { ...o.scale },
    rotation: o.rotation,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
  if (/^\*PAPER_SPACE/i.test(o.space)) ins.paperSpace = true;
  return ins;
}

/** XATTACH 한 번: 정의(없으면)와 참조 */
export function xrefAttachOps(host: CadDocument, def: XrefDefOptions, at: XrefInsertOptions, newHandle: () => string): { ops: EditOp[]; insert: InsertEntity; created: boolean } {
  const d = xrefDefinitionOps(host, def, newHandle);
  const name = host.blocks.get(tableKey(def.name))?.name ?? def.name;
  const insert = xrefInsert(host, name, at, newHandle);
  return { ops: [...d.ops, { kind: 'add', block: at.space, entity: insert }], insert, created: d.created };
}

/** 파일 이름 → 외부 참조 이름(확장자·경로를 뺀다. 블록 이름에 쓸 수 없는 문자는 _) */
export function xrefNameFromFile(file: string): string {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.(dwg|dxf|dws|dwt)$/i, '');
  return base.replace(/[<>/\\":;?*|,=`]/g, '_') || 'XREF';
}

// ---------------------------------------------------------------------------
// 결합(XBIND)
// ---------------------------------------------------------------------------

/** 외부 참조 하나의 의존 기호 이름(접두사 없이, 종류별 정렬). 호스트의 `참조|이름` 레코드와 참조 도면(있으면)의 이름 */
export function dependentSymbols(host: CadDocument, xname: string, xdoc: CadDocument | null): Record<SymKind, string[]> {
  const out = {} as Record<SymKind, string[]>;
  const pre = `${tableKey(xname)}|`;
  for (const kind of SYM_KINDS) {
    const names = new Map<string, string>();
    for (const [k, r] of tableOf(host, kind)) if (k.startsWith(pre) && !(kind === 'block' && (host.blocks.get(k)?.flags ?? 0) & 4)) names.set(k.slice(pre.length), r.name.slice(r.name.indexOf('|') + 1));
    if (xdoc) {
      const list = kind === 'block' ? userBlockNames(xdoc) : [...tableOf(xdoc, kind).values()].map((r) => r.name).filter((n) => !isFixedName(kind, n) && !n.includes('|'));
      for (const n of list) if (!names.has(tableKey(n))) names.set(tableKey(n), n);
    }
    out[kind] = [...names.values()].sort((a, b) => a.localeCompare(b, 'ko'));
  }
  return out;
}

/** 호스트의 `참조|이름` 레코드에서 접두사를 뗀 원본 보기(참조 도면을 읽지 않았을 때 결합의 원본) */
function hostSource(host: CadDocument, xname: string): CadDocument {
  const d = createDocument('new');
  const pre = `${tableKey(xname)}|`;
  const strip = (n: string) => (tableKey(n).startsWith(pre) ? n.slice(pre.length) : n);
  for (const [k, l] of host.layers) if (k.startsWith(pre)) d.layers.set(k.slice(pre.length), { ...l, name: strip(l.name), linetype: strip(l.linetype), flags: l.flags & ~DEP });
  for (const [k, l] of host.linetypes) if (k.startsWith(pre)) d.linetypes.set(k.slice(pre.length), { ...l, name: strip(l.name), flags: l.flags & ~DEP });
  for (const [k, s] of host.textStyles) if (k.startsWith(pre)) d.textStyles.set(k.slice(pre.length), { ...s, name: strip(s.name), flags: s.flags & ~DEP });
  for (const [k, s] of host.dimStyles)
    if (k.startsWith(pre)) {
      const vars = { ...s.vars };
      for (const n of DIM_NAME_VARS) if (typeof vars[n] === 'string') vars[n] = strip(vars[n] as string);
      d.dimStyles.set(k.slice(pre.length), { ...s, name: strip(s.name), flags: s.flags & ~DEP, vars });
    }
  for (const [k, b] of host.blocks) if (k.startsWith(pre) && !(b.flags & 4)) d.blocks.set(k.slice(pre.length), { ...b, name: strip(b.name), flags: b.flags & ~DEP });
  return d;
}

export interface XbindResult {
  ops: EditOp[];
  /** 결합한 기호: `참조|이름` → 새 이름 */
  bound: { kind: SymKind; from: string; to: string }[];
  /** 결합할 수 없던 이름 */
  failed: { kind: SymKind; name: string }[];
}

/**
 * 의존 기호를 결합하는 작업. names는 접두사 없는 이름(또는 `참조|이름`).
 * xdoc(참조 도면)이 없으면 호스트에 저장된 의존 기호만 결합할 수 있다(블록은 참조 도면이 있어야 한다).
 */
export function xbindOps(host: CadDocument, xname: string, items: readonly { kind: SymKind; name: string }[], xdoc: CadDocument | null, newHandle: () => string): XbindResult {
  const pre = `${tableKey(xname)}|`;
  const own = hostSource(host, xname);
  // 참조 도면이 있으면 그 정의가 이긴다(도면층 상태는 호스트의 재지정)
  const src: CadDocument = xdoc
    ? {
        ...xdoc,
        layers: new Map([...own.layers, ...xdoc.layers]),
        linetypes: new Map([...own.linetypes, ...xdoc.linetypes]),
        textStyles: new Map([...own.textStyles, ...xdoc.textStyles]),
        dimStyles: new Map([...own.dimStyles, ...xdoc.dimStyles]),
        blocks: new Map([...own.blocks, ...xdoc.blocks]),
      }
    : own;
  const imp = createImporter(src, host, bindMapper(host, xname), newHandle, {
    layerFrom: (s) => {
      const h = host.layers.get(tableKey(`${xname}|${s}`));
      return h ? { ...h, name: s } : undefined;
    },
  });
  const res: XbindResult = { ops: [], bound: [], failed: [] };
  const want: { kind: SymKind; name: string }[] = [];
  for (const it of items) {
    const n = tableKey(it.name).startsWith(pre) ? it.name.slice(pre.length) : it.name;
    if (!n || isFixedName(it.kind, n) || !tableOf(src, it.kind).has(tableKey(n))) {
      res.failed.push({ kind: it.kind, name: it.name });
      continue;
    }
    if (want.some((w) => w.kind === it.kind && tableKey(w.name) === tableKey(n))) continue;
    want.push({ kind: it.kind, name: n });
  }
  const done: { kind: SymKind; name: string; to: string }[] = [];
  for (const w of want) {
    const to = imp.name(w.kind, w.name);
    if (!to) res.failed.push({ kind: w.kind, name: `${xname}|${w.name}` });
    else done.push({ ...w, to });
  }
  res.ops.push(...imp.ops);
  // 결합한 `참조|이름` 레코드를 지우고, 이 도면의 객체가 그 이름을 쓰면 새 이름으로 바꾼다
  const removed = new Map<string, string>();
  const keepLt = new Set<string>();
  const keepStyle = new Set<string>();
  const boundLayers = new Set(done.filter((d) => d.kind === 'layer').map((d) => tableKey(`${xname}|${d.name}`)));
  const boundDims = new Set(done.filter((d) => d.kind === 'dimStyle').map((d) => tableKey(`${xname}|${d.name}`)));
  for (const [k, l] of host.layers) if (k.startsWith(pre) && !boundLayers.has(k)) keepLt.add(tableKey(l.linetype));
  for (const [k, s] of host.dimStyles) if (k.startsWith(pre) && !boundDims.has(k) && typeof s.vars.DIMTXSTY === 'string') keepStyle.add(tableKey(s.vars.DIMTXSTY));
  for (const d of done) {
    const dk = tableKey(`${xname}|${d.name}`);
    res.bound.push({ kind: d.kind, from: `${xname}|${d.name}`, to: d.to });
    if (d.kind === 'layer') {
      const l = host.layers.get(dk);
      if (l) res.ops.push({ kind: 'layer', key: dk, before: l, after: null });
    } else if (d.kind === 'linetype') {
      const l = host.linetypes.get(dk);
      if (l && !keepLt.has(dk)) res.ops.push({ kind: 'linetype', key: dk, before: l, after: null });
    } else if (d.kind === 'textStyle') {
      const s = host.textStyles.get(dk);
      if (s && !keepStyle.has(dk)) res.ops.push({ kind: 'textStyle', key: dk, before: s, after: null });
    } else if (d.kind === 'dimStyle') {
      const s = host.dimStyles.get(dk);
      if (s) res.ops.push({ kind: 'dimStyle', key: dk, before: s, after: null });
    } else continue;
    removed.set(`${d.kind}:${dk}`, d.to);
  }
  if (removed.size) res.ops.push(...remapOps(host, removed));
  return res;
}

/** 이 도면의 객체가 지운 이름(종류:대문자)을 쓰면 새 이름으로 바꾸는 작업 */
function remapOps(doc: CadDocument, map: ReadonlyMap<string, string>): EditOp[] {
  const ops: EditOp[] = [];
  const get = (kind: string, n: string | undefined) => (n ? map.get(`${kind}:${tableKey(n)}`) : undefined);
  for (const [bk, b] of doc.blocks) {
    if (b.flags & 4) continue;
    for (const e of b.entities) {
      const r = e as Entity & { style?: string; dimStyle?: string };
      const nl = get('layer', e.layer);
      const nt = get('linetype', e.linetype);
      const ns = 'style' in r ? get('textStyle', r.style) : undefined;
      const nd = 'dimStyle' in r ? get('dimStyle', r.dimStyle) : undefined;
      if (!nl && !nt && !ns && !nd) continue;
      const after = cloneEntity(e) as Entity & { style?: string; dimStyle?: string };
      if (nl) after.layer = nl;
      if (nt) after.linetype = nt;
      if (ns) after.style = ns;
      if (nd) after.dimStyle = nd;
      delete after.dwgRaw;
      ops.push({ kind: 'modify', block: bk, before: e, after });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// BLOCKTOXREF
// ---------------------------------------------------------------------------

export interface BlockToXrefResult {
  ops: EditOp[];
  /** 바꾼 블록 참조 수 */
  count: number;
  /** 속성을 잃은 참조 수 */
  droppedAttribs: number;
  /** 블록 정의를 소거했는지 */
  purged: boolean;
}

/**
 * block의 모든 참조(블록 안 참조 포함)를 외부 참조 def.name의 참조로 바꾼다.
 * 외부 참조 이름이 그 블록 이름과 같으면 블록 정의 자리에 외부 참조 정의를 둔다(소거와 같다).
 */
export function blockToXrefOps(doc: CadDocument, block: string, def: XrefDefOptions, purge: boolean, newHandle: () => string): BlockToXrefResult {
  const bk = tableKey(block);
  const old = doc.blocks.get(bk);
  if (!old) throw new Error(`블록 "${block}"이(가) 없습니다.`);
  if (old.flags & 4) throw new Error(`"${old.name}"은(는) 이미 외부 참조입니다.`);
  const xk = tableKey(def.name);
  const ops: EditOp[] = [];
  let purged = false;
  if (xk === bk) {
    // 같은 이름: 정의를 외부 참조로 바꾼다(블록 레코드 핸들은 지킨다)
    const tmp = { ...doc, blocks: new Map(doc.blocks), blockRecords: new Map(doc.blockRecords) };
    tmp.blocks.delete(bk);
    tmp.blockRecords.delete(bk);
    const made = xrefDefinitionOps(tmp, def, newHandle);
    for (const op of made.ops) {
      if (op.kind === 'blockDef' && op.key === bk && op.after) ops.push({ kind: 'blockDef', key: bk, before: old, after: { ...op.after, handle: old.handle, recordHandle: old.recordHandle, endHandle: old.endHandle } });
      else if (op.kind === 'blockRecord' && op.key === bk && op.after) {
        const rec = doc.blockRecords.get(bk);
        ops.push({ kind: 'blockRecord', key: bk, before: rec ?? null, after: { ...op.after, handle: old.recordHandle, xdata: undefined } });
      } else ops.push(op);
    }
    purged = true;
  } else ops.push(...xrefDefinitionOps(doc, def, newHandle).ops);
  const name = doc.blocks.get(xk)?.name ?? def.name;
  let count = 0;
  let dropped = 0;
  for (const { block: sp, entity } of insertsOf(doc, block)) {
    const after = cloneEntity(entity);
    after.block = name;
    if (after.attribs.length) dropped++;
    after.attribs = [];
    delete after.dwgRaw;
    ops.push({ kind: 'modify', block: sp, before: entity, after });
    count++;
  }
  if (purge && !purged && !blockNamedElsewhere(doc, old.name)) {
    let used = false;
    for (const b of doc.blocks.values()) for (const e of b.entities) if ((e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') && e.block && tableKey(e.block) === bk) used = true;
    if (!used) {
      ops.push({ kind: 'blockDef', key: bk, before: old, after: null });
      const rec = doc.blockRecords.get(bk);
      if (rec) ops.push({ kind: 'blockRecord', key: bk, before: rec, after: null });
      purged = true;
    }
  }
  return { ops, count, droppedAttribs: dropped, purged };
}
