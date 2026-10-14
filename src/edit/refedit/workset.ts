/**
 * 참조 편집의 작업 세트(UI 없음).
 *
 * 열기: 편집할 정의(블록 정의, 또는 외부 참조 도면의 모형 공간·블록)의 객체를 참조 변환으로 옮긴 사본을 현재 공간에 둔다.
 * 사본은 도면의 보통 객체라 모든 명령으로 고칠 수 있다. 사본 → 원래 객체 핸들(origin)과 연 때의 모양(snapshot)을 기억한다.
 *
 * 저장: 작업 세트(현재 공간의 객체 중 도면 객체가 아닌 것)를 역변환해 정의에 되돌린다.
 *  - 그대로인 사본: 원래 객체를 건드리지 않는다.
 *  - 바뀐 사본: 원래 객체를 바꾼다(핸들 유지).
 *  - 작업 세트를 떠난 사본(지움·REFSET 제거): 원래 객체를 정의에서 지운다(REFSET으로 뺀 사본은 도면에 남는다).
 *  - 원래 객체가 없는 작업 객체(세션 중 그림·REFSET 추가): 정의에 더한다.
 *  - 사본을 만들지 않은 정의 객체(숨긴 속성 정의, 옮길 수 없는 객체, 고르지 않은 내포 객체): 그대로 둔다.
 */
import type { BlockDef, BlockRecord, CadDocument, Entity, HatchEntity, HeaderValue } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import { maxHandle } from '../util/audit';
import { blockReaches } from '../util/blockutil';
import type { EditOp } from '../session';
import type { Importer } from './names';
import { canCrossDocs } from './names';
import { type RefXf, invertXf, xformEntity } from './xform';

/** 편집할 정의 */
export interface RefTarget {
  kind: 'block' | 'xref';
  /** 정의가 있는 도면(블록이면 현재 도면, 외부 참조면 참조 도면) */
  doc: CadDocument;
  /** 정의 블록 키(외부 참조 도면의 모형 공간이면 *MODEL_SPACE) */
  key: string;
  /** 정의 좌표 → 현재 공간 */
  xf: RefXf;
}

export interface OpenOptions {
  /** 현재 도면 */
  host: CadDocument;
  /** 작업 세트를 둘 공간(블록 키) */
  space: string;
  /** 편집을 위한 속성 정의 표시 */
  attdefs: boolean;
  /** 현재 도면의 새 핸들 */
  newHandle: () => string;
  /** 외부 참조: 참조 도면 → 현재 도면 이름 맞추기(src는 extendBlocks로 만든 보기여야 한다) */
  importer?: Importer;
}

export interface OpenResult {
  /** 현재 도면에 적용할 작업(표·블록, 그다음 사본 넣기) */
  ops: EditOp[];
  copies: Entity[];
  /** 사본 핸들 → 정의 객체 핸들 */
  origin: Map<string, string>;
  /** 연 때의 모양(바뀜 비교) */
  snapshot: Map<string, string>;
  /** 옮길 수 없어 정의에 그대로 둔 객체 수 */
  skipped: number;
  /** 보이지 않은 속성 정의 수 */
  hiddenAttdefs: number;
  /** 사본 때문에 현재 도면에 만든 블록(치수 블록 등, 대문자) */
  createdBlocks: string[];
}

/** 블록 맵을 넓힌 보기(편집 결과의 새 블록을 원래 도면을 바꾸지 않고 찾게) */
export function extendBlocks(doc: CadDocument): CadDocument {
  return { ...doc, blocks: new Map(doc.blocks) };
}

/** 편집 결과의 새 블록 정의(익명 *D·*T 등)를 doc에 넣는 작업. 이름이 겹치면 번호를 바꾼다 */
export function newBlockOps(doc: CadDocument, b: BlockDef, newHandle: () => string, reserved: Set<string>): { ops: EditOp[]; name: string } {
  let name = b.name;
  const prefix = /^\*[A-Za-z]+/.exec(name)?.[0];
  if (prefix && (doc.blocks.has(tableKey(name)) || reserved.has(tableKey(name)) || name === prefix)) {
    let n = 1;
    while (doc.blocks.has(tableKey(`${prefix}${n}`)) || reserved.has(tableKey(`${prefix}${n}`))) n++;
    name = `${prefix}${n}`;
  }
  const key = tableKey(name);
  reserved.add(key);
  const rec: BlockRecord = { name, handle: newHandle(), flags: b.flags & 1, insertUnits: 0, explodable: true, scalable: true };
  const def: BlockDef = { ...b, name, handle: newHandle(), recordHandle: rec.handle, endHandle: newHandle(), entities: b.entities.map((e) => ({ ...e })) };
  for (const e of def.entities) {
    e.handle = newHandle();
    e.owner = rec.handle;
    if (e.type === 'INSERT') e.attribs = e.attribs.map((a) => ({ ...a, handle: newHandle(), owner: e.handle }));
  }
  return { ops: [{ kind: 'blockRecord', key, before: null, after: rec }, { kind: 'blockDef', key, before: null, after: def }], name };
}

/** 객체(과 속성)에 새 핸들·소유자 */
function own(e: Entity, handle: string, owner: string | undefined, newHandle: () => string): void {
  e.handle = handle;
  if (owner) e.owner = owner;
  else delete e.owner;
  if (e.type === 'INSERT')
    for (const a of e.attribs) {
      a.handle = newHandle();
      a.owner = handle;
    }
}

function hatchSources(e: Entity, map: (h: string) => string | undefined): void {
  if (e.type !== 'HATCH' && e.type !== 'MPOLYGON') return;
  const h = e as HatchEntity;
  for (const p of h.paths) {
    if (!p.sources?.length) continue;
    const s = p.sources.map((x) => map(normalizeHandle(x))).filter((x): x is string => !!x);
    if (s.length) p.sources = s;
    else delete p.sources;
  }
}

/** 작업 세트 열기 */
export function openWorkingSet(target: RefTarget, opt: OpenOptions): OpenResult {
  const def = target.doc.blocks.get(target.key);
  if (!def) throw new Error(`정의가 없습니다: ${target.key}`);
  const host = opt.host;
  const ownerHandle = host.blocks.get(opt.space)?.recordHandle;
  const tableOps: EditOp[] = [];
  const addOps: EditOp[] = [];
  const copies: Entity[] = [];
  const origin = new Map<string, string>();
  const snapshot = new Map<string, string>();
  const createdBlocks: string[] = [];
  const reserved = new Set<string>();
  let skipped = 0;
  let hiddenAttdefs = 0;
  const workOf = new Map<string, string>();
  const imp = opt.importer;
  for (const e of def.entities) {
    if (e.type === 'ATTDEF' && !opt.attdefs) {
      hiddenAttdefs++;
      continue;
    }
    if (target.kind === 'xref' && !canCrossDocs(e)) {
      skipped++;
      continue;
    }
    const x = xformEntity(e, target.xf, target.doc);
    if (!x) {
      skipped++;
      continue;
    }
    let c = x.entity;
    if (imp) {
      // 결과 블록(치수 블록 등)은 보내는 도면의 보기에 더해 두면 가져오기가 함께 옮긴다
      for (const b of x.result.blocks ?? []) imp.src.blocks.set(tableKey(b.name), b);
      const ic = imp.entity(c);
      if (!ic) {
        skipped++;
        continue;
      }
      c = ic;
    } else {
      for (const b of x.result.blocks ?? []) {
        const r = newBlockOps(host, b, opt.newHandle, reserved);
        tableOps.push(...r.ops);
        createdBlocks.push(tableKey(r.name));
        if ((c.type === 'DIMENSION' || c.type === 'ACAD_TABLE') && c.block === b.name) c.block = r.name;
      }
    }
    own(c, opt.newHandle(), ownerHandle, opt.newHandle);
    delete c.paperSpace;
    copies.push(c);
    origin.set(c.handle, e.handle);
    workOf.set(normalizeHandle(e.handle), c.handle);
  }
  if (imp) {
    tableOps.unshift(...imp.ops);
    for (const k of imp.createdBlocks) if (/^\*/.test(k)) createdBlocks.push(k);
  }
  // 연관 해치의 경계는 사본끼리 잇는다
  for (const c of copies) hatchSources(c, (h) => workOf.get(h));
  for (const c of copies) {
    snapshot.set(c.handle, JSON.stringify(c));
    addOps.push({ kind: 'add', block: opt.space, entity: c });
  }
  return { ops: [...tableOps, ...addOps], copies, origin, snapshot, skipped, hiddenAttdefs, createdBlocks };
}

export interface SaveInput {
  target: RefTarget;
  host: CadDocument;
  /** 작업 세트가 있는 공간 */
  space: string;
  /** 지금 작업 세트(현재 공간 순서) */
  working: Entity[];
  origin: ReadonlyMap<string, string>;
  snapshot: ReadonlyMap<string, string>;
  /** 정의가 있는 도면의 새 핸들 */
  newHandle: () => string;
  /** 외부 참조: 현재 도면 → 참조 도면 이름 맞추기(src는 extendBlocks로 만든 현재 도면 보기) */
  exporter?: Importer;
}

export interface SavePlan {
  /** 정의가 있는 도면에 적용할 작업 */
  defOps: EditOp[];
  /** 현재 공간에서 작업 세트를 빼는 작업 */
  removeWorking: EditOp[];
  kept: number;
  changed: number;
  added: number;
  removed: number;
  /** 정의에 넣지 못해 현재 도면에 남긴 작업 객체 */
  left: string[];
  /** 속성 정의를 바꾸거나 더하거나 지웠는지(기존 참조의 속성은 그대로 — ATTSYNC 안내) */
  attdefsChanged: boolean;
  /** 저장할 수 없으면 그 까닭(정의는 그대로) */
  error?: string;
}

/** 작업 세트 저장 계획 */
export function planSave(inp: SaveInput): SavePlan {
  const { target, host } = inp;
  const tdoc = target.doc;
  const def = tdoc.blocks.get(target.key);
  const empty: SavePlan = { defOps: [], removeWorking: [], kept: 0, changed: 0, added: 0, removed: 0, left: [], attdefsChanged: false };
  if (!def) return { ...empty, error: '편집하던 정의가 없어졌습니다.' };
  const inv = invertXf(target.xf);
  if (!inv) return { ...empty, error: '참조 변환을 되돌릴 수 없습니다.' };
  const exp = inp.exporter;
  const reserved = new Set<string>();
  const blockOps: EditOp[] = [];
  const workingSet = new Set(inp.working.map((e) => e.handle));
  const defIndex = new Map<string, number>();
  def.entities.forEach((e, i) => defIndex.set(normalizeHandle(e.handle), i));
  // 1) 작업 객체마다 정의의 핸들을 정한다(그대로·바뀜 = 원래 핸들, 새 것 = 새 핸들)
  type Item = { work: Entity; orig: Entity | null; out: Entity | null };
  const items: Item[] = [];
  const defHandleOf = new Map<string, string>();
  const left: string[] = [];
  for (const w of inp.working) {
    const oh = inp.origin.get(w.handle);
    const orig = oh !== undefined ? (def.entities[defIndex.get(normalizeHandle(oh)) ?? -1] ?? null) : null;
    items.push({ work: w, orig, out: null });
  }
  let attdefsChanged = false;
  let kept = 0;
  let changed = 0;
  let added = 0;
  for (const it of items) {
    if (it.orig && inp.snapshot.get(it.work.handle) === JSON.stringify(it.work)) {
      it.out = it.orig;
      defHandleOf.set(normalizeHandle(it.work.handle), it.orig.handle);
      kept++;
      continue;
    }
    const x = xformEntity(it.work, inv, host);
    if (!x) {
      left.push(it.work.handle);
      continue;
    }
    let c = x.entity;
    if (exp) {
      for (const b of x.result.blocks ?? []) exp.src.blocks.set(tableKey(b.name), b);
      const ec = exp.entity(c);
      if (!ec) {
        left.push(it.work.handle);
        continue;
      }
      c = ec;
    } else {
      for (const b of x.result.blocks ?? []) {
        const r = newBlockOps(tdoc, b, inp.newHandle, reserved);
        blockOps.push(...r.ops);
        if ((c.type === 'DIMENSION' || c.type === 'ACAD_TABLE') && c.block === b.name) c.block = r.name;
      }
      // 블록 자신을 참조하면 저장할 수 없다
      if ((c.type === 'INSERT' || c.type === 'DIMENSION' || c.type === 'ACAD_TABLE') && c.block && blockReaches(tdoc, tableKey(c.block), target.key))
        return { ...empty, error: `블록 "${def.name}"이(가) 자신을 참조합니다.` };
    }
    delete c.paperSpace;
    delete c.dwgRaw;
    if (it.orig) {
      const o = it.orig;
      c.handle = o.handle;
      c.owner = o.owner ?? def.recordHandle;
      if (o.xdict) c.xdict = o.xdict;
      else delete c.xdict;
      if (o.reactors) c.reactors = o.reactors;
      else delete c.reactors;
      if (c.type === 'INSERT') {
        const oa = o.type === 'INSERT' ? o.attribs : [];
        c.attribs.forEach((a, i) => {
          a.handle = oa.length === c.attribs.length ? oa[i]!.handle : inp.newHandle();
          a.owner = c.handle;
          delete a.dwgRaw;
        });
      }
      changed++;
      if (c.type === 'ATTDEF' || o.type === 'ATTDEF') attdefsChanged = true;
    } else {
      own(c, inp.newHandle(), def.recordHandle, inp.newHandle);
      added++;
      if (c.type === 'ATTDEF') attdefsChanged = true;
    }
    it.out = c;
    defHandleOf.set(normalizeHandle(it.work.handle), c.handle);
  }
  // 2) 연관 해치의 경계를 정의 핸들로
  for (const it of items) if (it.out && it.out !== it.orig) hatchSources(it.out, (h) => defHandleOf.get(h));
  // 3) 정의 작업: 떠난 사본의 원래 객체 지우기(뒤에서부터), 바뀐 것 바꾸기, 새 것 더하기
  const defOps: EditOp[] = [];
  const stay = new Set<string>();
  for (const it of items) if (it.orig && it.out) stay.add(normalizeHandle(it.orig.handle));
  const gone: { e: Entity; i: number }[] = [];
  for (const [w, oh] of inp.origin) {
    const k = normalizeHandle(oh);
    if (stay.has(k)) continue;
    // 작업 세트에 있지만 되돌리지 못한 사본은 원래 객체를 그대로 둔다
    if (workingSet.has(w) && left.includes(w)) continue;
    const i = defIndex.get(k);
    if (i === undefined) continue;
    gone.push({ e: def.entities[i]!, i });
  }
  gone.sort((a, b) => b.i - a.i);
  for (const g of gone) {
    defOps.push({ kind: 'remove', block: target.key, entity: g.e, index: g.i });
    if (g.e.type === 'ATTDEF') attdefsChanged = true;
  }
  for (const it of items) if (it.orig && it.out && it.out !== it.orig) defOps.push({ kind: 'modify', block: target.key, before: it.orig, after: it.out });
  for (const it of items) if (!it.orig && it.out) defOps.push({ kind: 'add', block: target.key, entity: it.out });
  const remaining = def.entities.length - gone.length + added;
  if (target.kind === 'block' && remaining <= 0) return { ...empty, error: '작업 세트가 비어 있어 블록 정의를 저장할 수 없습니다.' };
  // 4) 현재 공간에서 작업 세트를 뺀다(정의에 넣지 못한 것은 남긴다)
  const sp = host.blocks.get(inp.space);
  const leftSet = new Set(left);
  const removeWorking: EditOp[] = [];
  if (sp) {
    const idx: { e: Entity; i: number }[] = [];
    sp.entities.forEach((e, i) => {
      if (workingSet.has(e.handle) && !leftSet.has(e.handle)) idx.push({ e, i });
    });
    idx.sort((a, b) => b.i - a.i);
    for (const x of idx) removeWorking.push({ kind: 'remove', block: inp.space, entity: x.e, index: x.i });
  }
  return {
    defOps: [...(exp ? exp.ops : []), ...blockOps, ...defOps],
    removeWorking,
    kept,
    changed,
    added,
    removed: gone.length,
    left,
    attdefsChanged,
  };
}

/** 지금 쓰이는 블록 이름(대문자). except의 객체는 빼고 센다 */
export function referencedBlocks(doc: CadDocument, except: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const b of doc.blocks.values())
    for (const e of b.entities) {
      if (except.has(e.handle)) continue;
      if ((e.type === 'INSERT' || e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') && e.block) out.add(tableKey(e.block));
    }
  return out;
}

/** 아무도 쓰지 않는 블록을 지우는 작업 */
export function dropBlocksOps(doc: CadDocument, keys: readonly string[], used: ReadonlySet<string>): EditOp[] {
  const ops: EditOp[] = [];
  for (const k of keys) {
    if (used.has(k)) continue;
    const def = doc.blocks.get(k);
    if (!def) continue;
    ops.push({ kind: 'blockDef', key: k, before: def, after: null });
    const rec = doc.blockRecords.get(k);
    if (rec) ops.push({ kind: 'blockRecord', key: k, before: rec, after: null });
  }
  return ops;
}

/** 다른 도면(외부 참조 도면 등)의 새 핸들. finish()는 $HANDSEED 작업(쓴 것이 있을 때) */
export function seedAllocator(doc: CadDocument): { newHandle: () => string; finish: () => EditOp[] } {
  const before = doc.header.get('$HANDSEED');
  let seed = maxHandle(doc) + 1n;
  try {
    const s = typeof before === 'string' && before ? BigInt('0x' + before) : 0n;
    if (s > seed) seed = s;
  } catch {
    /* 잘못된 씨앗은 무시 */
  }
  const start = seed;
  return {
    newHandle: () => normalizeHandle((seed++).toString(16)),
    finish: () => (seed === start ? [] : [{ kind: 'header', name: '$HANDSEED', before: before as HeaderValue | undefined, after: normalizeHandle(seed.toString(16)) }]),
  };
}
