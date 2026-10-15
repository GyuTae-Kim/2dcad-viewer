/**
 * 연관 배열을 만들고 다시 계산하는 편집 작업(문서에 적용하기 전의 EditOp 목록).
 *  - 만들기: 원본 객체를 원본 블록으로 옮기고(도면에서는 지운다), 배열 블록에 항목 참조를 넣고, 배열 참조를 더한다.
 *  - 다시 계산: 배열 블록의 내용을 바꾼다. 같은 블록을 다른 참조도 쓰면(복사본) 새 블록을 만든다(AutoCAD 기록 배열은
 *    종속이 블록 레코드를 가리키므로 블록은 그대로 두고 다른 참조를 복제 블록으로 옮긴다). 그대로 남는 항목은 핸들을 유지한다.
 *  - AutoCAD 기록 배열(DXF 원본 태그)은 값 매개변수·점 매개변수·항목 목록·끝 행렬을 함께 고친다.
 * 모든 배열에 이 앱의 기록(OPENCAD_ARRAY)을 남긴다.
 */
import type { BlockDef, BlockRecord, CadDocument, Entity, EntityBase, GenericObject, InsertEntity, RawTag, Vec3 } from '../../core/model';
import { LW_BYBLOCK, TRANSPARENCY_BYBLOCK, entityDefaults, normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity } from '../session';
import { insertAffine } from '../dynblock/build';
import { transformEntity } from '../geom/transform';
import { type Affine, affApply, affInv } from '../geom/math';
import { acadValuesOf, patchValues, patchVertex, rewriteBody } from './acad';
import { arrayPath, blockShared, expectedItems, itemMatrix, readArray, type ArrayInfo } from './read';
import { cachePath } from './layout';
import { decompose, itemCount, pathSpacingOf } from './layout';
import { encodeRecord, withRecord } from './record';
import { type ArrayItem, type ArrayParams, type ArrayState, MAX_ITEMS, MAX_REMOVED, MAX_REPLACED } from './types';

export interface BuildEnv {
  doc: CadDocument;
  newHandle: () => string;
  /** 새 익명 블록 이름(*U…) */
  newBlockName: () => string;
}

/** 새 블록 레코드·정의 작업(이름은 정해진 것) */
export function newBlockOps(env: BuildEnv, name: string, entities: Entity[]): { ops: EditOp[]; def: BlockDef } {
  const key = tableKey(name);
  const rec: BlockRecord = { name, handle: env.newHandle(), flags: 1, insertUnits: 0, explodable: true, scalable: true };
  const def: BlockDef = { name, handle: env.newHandle(), recordHandle: rec.handle, basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities, endHandle: env.newHandle() };
  for (const e of entities) {
    if (!e.handle) e.handle = env.newHandle();
    e.owner = rec.handle;
    if (e.type === 'INSERT') for (const a of e.attribs) a.owner = e.handle;
  }
  return { ops: [{ kind: 'blockRecord', key, before: null, after: rec }, { kind: 'blockDef', key, before: null, after: def }], def };
}

/** 객체를 변환해 블록에 넣을 새 객체로(새 핸들, 연결 끊기). 치수 블록 같은 딸린 블록도 돌려준다 */
export function blockCopies(env: BuildEnv, list: readonly Entity[], m: Affine): { entities: Entity[]; blocks: BlockDef[] } {
  const doc = env.doc;
  const mirrorText = Number(doc.header.get('$MIRRTEXT') ?? 0) === 1;
  const mirrorHatch = Number(doc.header.get('$MIRRHATCH') ?? 0) === 1;
  const out: Entity[] = [];
  const blocks: BlockDef[] = [];
  for (const e of list) {
    const r = transformEntity(e, m, doc, { mirrorText, mirrorHatch });
    for (const x of [...(r.replace ?? []), ...(r.add ?? [])]) {
      const c = x === e ? cloneEntity(e) : x;
      c.handle = env.newHandle();
      delete c.xdict;
      delete c.reactors;
      delete c.dwgRaw;
      delete c.paperSpace;
      if (c.type === 'INSERT')
        for (const a of c.attribs) {
          a.handle = env.newHandle();
          a.owner = c.handle;
          delete a.xdict;
          delete a.reactors;
          delete a.dwgRaw;
        }
      out.push(c);
    }
    for (const b of r.blocks ?? []) blocks.push(b);
  }
  return { entities: out, blocks };
}

/** 항목 참조(도면층 0, ByBlock 특성). bp = 그 블록의 기준점 */
export function itemInsert(block: string, bp: Vec3, m: Affine, z: number, handle: string): InsertEntity {
  const d = decompose(m);
  const p = affApply(m, bp);
  return {
    ...entityDefaults(),
    handle,
    type: 'INSERT',
    layer: '0',
    color: { aci: 0 },
    linetype: 'ByBlock',
    lineweight: LW_BYBLOCK,
    transparency: TRANSPARENCY_BYBLOCK,
    block,
    insert: { x: p.x, y: p.y, z: z + bp.z },
    scale: { x: d.sx, y: d.sy, z: 1 },
    rotation: d.rotation,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
}

/** 상태가 쓸 수 있는 값인지(오류 문구) */
export function validateState(s: ArrayState): string | null {
  const p = s.params;
  const ints = p.kind === 'rect' ? [p.columns, p.rows, p.levels] : [p.items, p.rows, p.levels];
  if (ints.some((v) => !Number.isFinite(v) || v < 1 || Math.round(v) !== v)) return '개수는 1 이상의 정수여야 합니다.';
  if (itemCount(p) > MAX_ITEMS) return `배열 항목이 너무 많습니다(최대 ${MAX_ITEMS}개).`;
  const nums = Object.values(p).filter((v): v is number => typeof v === 'number');
  if (nums.some((v) => !Number.isFinite(v))) return '값이 올바르지 않습니다.';
  if (p.kind === 'polar' && (p.fillAngle === 0 || Math.abs(p.fillAngle) > 2 * Math.PI + 1e-9)) return '채울 각도는 0이 아니고 360°를 넘지 않아야 합니다.';
  if (p.kind === 'path' && p.method === 'measure' && !(p.spacing > 0)) return '항목 사이의 거리는 0보다 커야 합니다.';
  if (s.removed.size > MAX_REMOVED) return `지운 항목이 너무 많습니다(최대 ${MAX_REMOVED}개).`;
  if (s.replaced.size > MAX_REPLACED) return `대체한 항목이 너무 많습니다(최대 ${MAX_REPLACED}개).`;
  return null;
}

// ---------------------------------------------------------------------------
// 만들기
// ---------------------------------------------------------------------------

export interface CreateInput {
  params: ArrayParams;
  /** 원본 객체(도면 좌표) */
  sources: Entity[];
  /** 도면 좌표 → 원본 블록 좌표 */
  normalize: Affine;
  /** 배열 참조의 자리·회전 */
  insert: Vec3;
  rotation: number;
  /** 배열 참조의 특성(도면층·색 …) */
  props: Omit<EntityBase, 'type' | 'handle'>;
  /** 배열 참조를 넣을 공간(블록 키) */
  space: string;
}

export interface Built {
  ops: EditOp[];
  insert: InsertEntity;
  items: number;
}

export function createArrayOps(env: BuildEnv, input: CreateInput): Built | { error: string } {
  const doc = env.doc;
  if (!input.sources.length) return { error: '원본 객체가 없습니다.' };
  const p = input.params;
  if (p.kind === 'path' && p.path && input.sources.some((e) => e.handle === p.path)) return { error: '이 객체는 경로로 사용할 수 없습니다. 원본 객체가 아닌 곡선을 고르십시오.' };
  const bad = validateState({ params: p, source: '', removed: new Set(), replaced: new Map() });
  if (bad) return { error: bad };
  const ops: EditOp[] = [];
  // 원본 블록
  const srcName = env.newBlockName();
  const copies = blockCopies(env, input.sources, input.normalize);
  for (const b of copies.blocks) {
    const key = tableKey(b.name);
    ops.push({ kind: 'blockDef', key, before: doc.blocks.get(key) ?? null, after: b });
  }
  const src = newBlockOps(env, srcName, copies.entities);
  ops.push(...src.ops);
  // 배열 참조(배열 블록 좌표 → 도면: 자리·회전)
  const ins: InsertEntity = {
    ...entityDefaults(),
    ...input.props,
    handle: env.newHandle(),
    type: 'INSERT',
    block: '',
    insert: { ...input.insert },
    scale: { x: 1, y: 1, z: 1 },
    rotation: input.rotation,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
  delete ins.xdata;
  const state: ArrayState = { params: p, source: srcName, removed: new Set(), replaced: new Map() };
  withPathCache(doc, ins, { basePoint: { x: 0, y: 0, z: 0 } }, state);
  // 원본 블록이 문서에 있어야 항목 참조를 만들 수 있다 → 항목은 블록 기준점(0)으로 직접 만든다
  const items = itemsFor(doc, ins, { basePoint: { x: 0, y: 0, z: 0 } }, p);
  if (!items.length) return { error: p.kind === 'path' ? '경로 곡선을 찾을 수 없습니다.' : '배열 항목이 없습니다.' };
  if (items.length < 2) return { error: '항목이 하나뿐이라 배열을 만들지 않았습니다.' };
  const arrName = env.newBlockName();
  const zero = { x: 0, y: 0, z: 0 };
  const entities = items.map((it) => itemInsert(srcName, zero, it.matrix, it.z, env.newHandle()));
  const arr = newBlockOps(env, arrName, entities);
  ops.push(...arr.ops);
  ins.block = arrName;
  // 기록은 원본 블록 레코드 핸들을 쓴다 → 레코드가 들어간 뒤의 문서가 필요 없게 직접 만든다
  const rec = encodeRecord({ ...doc, blockRecords: new Map([[tableKey(srcName), (src.ops[0] as { after: BlockRecord }).after]]) } as CadDocument, state);
  ins.xdata = withRecord(ins.xdata, rec);
  // 원본 지우기(블록마다 뒤에서부터)
  const rem: { block: string; entity: Entity; index: number }[] = [];
  for (const e of input.sources) {
    for (const [k, b] of doc.blocks) {
      const i = b.entities.indexOf(e);
      const j = i >= 0 ? i : b.entities.findIndex((x) => x.handle === e.handle);
      if (j >= 0) {
        rem.push({ block: k, entity: b.entities[j]!, index: j });
        break;
      }
    }
  }
  rem.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block < b.block ? -1 : 1));
  for (const r of rem) ops.push({ kind: 'remove', ...r });
  const space = doc.blocks.get(input.space);
  if (space) ins.owner = space.recordHandle;
  ops.push({ kind: 'add', block: input.space, entity: ins });
  return { ops, insert: ins, items: items.length };
}

/** 경로 곡선이 있으면 그 곡선 캐시(배열 블록 좌표)를 매개변수에 남긴다 — 경로 곡선을 지워도 다시 계산할 수 있게 */
function withPathCache(doc: CadDocument, ins: InsertEntity, def: Pick<BlockDef, 'basePoint'>, s: ArrayState): void {
  const p = s.params;
  if (p.kind !== 'path') return;
  const ap = arrayPath(doc, p);
  if (!ap?.world || !ap.raw) return;
  const inv = affInv(insertAffine(def as BlockDef, ins));
  const cache = inv ? cachePath(ap.raw, inv) : null;
  if (cache) s.params = { ...p, fallback: cache };
  else {
    const { fallback: _f, ...rest } = p;
    void _f;
    s.params = rest;
  }
}

function itemsFor(doc: CadDocument, ins: InsertEntity, def: Pick<BlockDef, 'basePoint'>, p: ArrayParams) {
  return expectedItems(doc, ins, def, p);
}

// ---------------------------------------------------------------------------
// 다시 계산
// ---------------------------------------------------------------------------

export interface RegenOptions {
  /** 배열 참조를 이렇게 바꾼다(기준점 옮김 등) */
  insert?: InsertEntity;
  /** 있는 블록(원본·대체 블록)의 새 내용(블록 좌표, 핸들 있음) */
  contents?: { name: string; entities: Entity[]; blocks?: BlockDef[] }[];
  /** 대체 블록을 새로 만든다(이름 → 내용) */
  newBlocks?: { name: string; entities: Entity[] }[];
}

export function regenerateOps(env: BuildEnv, info: ArrayInfo, next: ArrayState, opt: RegenOptions = {}): Built | { error: string } {
  const doc = env.doc;
  const bad = validateState(next);
  if (bad) return { error: bad };
  const ops: EditOp[] = [];
  // 새 대체 블록(항목 참조가 블록을 찾을 수 있게 먼저)
  const extraDefs = new Map<string, BlockDef>();
  for (const nb of opt.newBlocks ?? []) {
    const b = newBlockOps(env, nb.name, nb.entities);
    ops.push(...b.ops);
    extraDefs.set(tableKey(nb.name), b.def);
  }
  const ins = opt.insert ?? info.ins;
  withPathCache(doc, ins, info.def, next);
  const items = expectedItems(doc, ins, info.def, next.params);
  if (!items.length) return { error: next.params.kind === 'path' ? '경로 곡선을 찾을 수 없어 배열을 다시 계산할 수 없습니다.' : '배열 항목이 없습니다.' };
  const live = items.filter((it) => !next.removed.has(it.key));
  if (!live.length) return { error: '항목이 하나도 남지 않습니다.' };
  // 원본·대체 블록 내용
  for (const c of opt.contents ?? []) {
    for (const b of c.blocks ?? []) {
      const bk = tableKey(b.name);
      ops.push({ kind: 'blockDef', key: bk, before: doc.blocks.get(bk) ?? null, after: b });
    }
    const key = tableKey(c.name);
    const before = doc.blocks.get(key);
    if (!before) return { error: '원본 블록이 없습니다.' };
    const rec = doc.blockRecords.get(key);
    const ents = c.entities.map((e) => ({ ...e, owner: rec?.handle ?? before.recordHandle }) as Entity);
    ops.push({ kind: 'blockDef', key, before, after: { ...before, entities: ents } });
  }
  // 배열 블록: 같은 블록을 쓰는 다른 참조가 있으면
  const shared = blockShared(doc, info.def.name, info.ins.handle);
  const inPlace = !shared || info.origin === 'acad';
  if (shared && info.origin === 'acad') {
    // 다른 참조는 지금 모양 그대로의 복제 블록으로
    const dupName = env.newBlockName();
    const dup = newBlockOps(
      env,
      dupName,
      info.def.entities.map((e) => {
        const c = cloneEntity(e);
        c.handle = env.newHandle();
        delete c.reactors;
        delete c.xdict;
        delete c.dwgRaw;
        return c;
      }),
    );
    ops.push(...dup.ops);
    const k = tableKey(info.def.name);
    for (const e of doc.entityIndex.values()) {
      if (e.type !== 'INSERT' || e.handle === info.ins.handle || tableKey(e.block) !== k) continue;
      const owner = ownerKey(doc, e.handle);
      if (!owner) continue;
      ops.push({ kind: 'modify', block: owner, before: e, after: { ...cloneEntity(e), block: dupName } });
    }
  }
  const reuse = inPlace ? info.items : new Map<string, string>();
  const base = next.params.base;
  const withHandles = live.map((it) => ({ ...it, handle: reuse.get(it.key) ?? env.newHandle() }));
  const blockDefOf = (name: string): Pick<BlockDef, 'basePoint' | 'name'> | undefined => extraDefs.get(tableKey(name)) ?? doc.blocks.get(tableKey(name));
  const entities: Entity[] = withHandles.map((it) => {
    const rep = next.replaced.get(it.key);
    const block = rep ?? next.source;
    const bd = blockDefOf(block);
    return itemInsert(bd?.name ?? block, bd?.basePoint ?? { x: 0, y: 0, z: 0 }, itemMatrix(it, !!rep, base), it.z, it.handle);
  });
  let arrName = info.def.name;
  if (inPlace) {
    const key = tableKey(arrName);
    const before = doc.blocks.get(key)!;
    for (const e of entities) e.owner = before.recordHandle;
    ops.push({ kind: 'blockDef', key, before, after: { ...before, entities } });
  } else {
    arrName = env.newBlockName();
    ops.push(...newBlockOps(env, arrName, entities).ops);
  }
  // 배열 참조: 블록 이름·이 앱 기록
  const after = cloneEntity(ins);
  after.block = arrName;
  const recDoc = { ...doc, blockRecords: new Map(doc.blockRecords) } as CadDocument;
  for (const [k, d] of extraDefs) recDoc.blockRecords.set(k, { name: d.name, handle: d.recordHandle, flags: 1, insertUnits: 0, explodable: true, scalable: true });
  after.xdata = withRecord(after.xdata, encodeRecord(recDoc, next));
  const owner = ownerKey(doc, info.ins.handle);
  if (!owner) return { error: '배열 참조를 찾을 수 없습니다.' };
  ops.push({ kind: 'modify', block: owner, before: info.ins, after });
  // AutoCAD 기록(원본 태그) 고쳐 쓰기
  if (info.origin === 'acad' && info.acad?.raw && inPlace) ops.push(...acadOps(doc, info, next, withHandles, after));
  return { ops, insert: after, items: live.length };
}

function ownerKey(doc: CadDocument, handle: string): string | null {
  for (const [k, b] of doc.blocks) if (b.entities.some((e) => e.handle === handle)) return k;
  return null;
}

/** AutoCAD 연관 배열 기록의 원본 태그를 새 상태로 고치는 작업 */
function acadOps(doc: CadDocument, info: ArrayInfo, next: ArrayState, items: readonly (ArrayItem & { handle: string })[], ins: InsertEntity): EditOp[] {
  const a = info.acad!;
  const ops: EditOp[] = [];
  const p = next.params;
  const spacing = p.kind === 'path' ? (() => {
    const ap = arrayPath(doc, p);
    return ap ? pathSpacingOf(p, ap.path) : p.spacing;
  })() : undefined;
  const values = acadValuesOf(p, spacing);
  const patched = new Map<string, RawTag[]>();
  const objOf = (h: string) => doc.objects.get(normalizeHandle(h)) as GenericObject | undefined;
  for (const holder of [a.action, a.body]) {
    const o = objOf(holder);
    if (!o?.raw) continue;
    const r = patchValues(a, holder, o.raw, values);
    if (r) patched.set(holder, r);
  }
  // 몸체의 항목 목록·끝 행렬
  const body = objOf(a.body);
  if (body?.raw) {
    const W = insertAffine(info.def, ins);
    const r = rewriteBody(patched.get(a.body) ?? body.raw, items, W, ins.insert.z);
    if (r) patched.set(a.body, r);
  }
  // 점 매개변수: 원형 중심(Origin), 직사각형 첫 항목 자리(Origin), 기준점(basePoint), 레벨 법선(BaseNormal = 법선 × 레벨 간격일 때)
  const setVertex = (name: string, pt: Vec3) => {
    const v = a.vertex.get(name);
    const o = v ? objOf(v.handle) : undefined;
    if (!o?.raw) return;
    const r = patchVertex(patched.get(o.handle) ?? o.raw, pt);
    if (r) patched.set(o.handle, r);
  };
  if (p.kind === 'polar') setVertex('Origin', { x: p.center.x, y: p.center.y, z: a.vertex.get('Origin')?.point.z ?? 0 });
  if (p.kind === 'rect') setVertex('Origin', { x: p.origin.x, y: p.origin.y, z: a.vertex.get('Origin')?.point.z ?? 0 });
  setVertex('basePoint', { x: p.base.x, y: p.base.y, z: a.vertex.get('basePoint')?.point.z ?? 0 });
  const bn = a.vertex.get('BaseNormal')?.point;
  const oldLevel = info.state.params.levelSpacing;
  if (bn && Math.abs(bn.x) < 1e-12 && Math.abs(bn.y) < 1e-12 && Math.abs(bn.z - oldLevel) < 1e-9 && p.levelSpacing > 0) setVertex('BaseNormal', { x: 0, y: 0, z: p.levelSpacing });
  for (const [h, raw] of patched) {
    const before = objOf(h);
    if (!before) continue;
    const after = { ...before, raw } as GenericObject;
    delete after.dwgRaw;
    ops.push({ kind: 'object', key: normalizeHandle(h), before, after });
  }
  return ops;
}

/**
 * 경로 곡선이 바뀐 경로 배열을 새 경로로 다시 계산하는 작업(AutoCAD 연관 배열이 경로를 따라가는 것).
 * changed = 바뀐 객체 핸들. 배열 참조도 같은 변환으로 함께 옮겨졌으면(항목이 이미 맞으면) 그대로 둔다.
 */
export function followPathOps(env: BuildEnv, changed: ReadonlySet<string>): EditOp[] {
  const doc = env.doc;
  if (!changed.size) return [];
  const ops: EditOp[] = [];
  const seen = new Set<string>();
  const consider = (e: Entity | undefined) => {
    if (!e || e.type !== 'INSERT' || seen.has(e.handle) || changed.has(e.handle)) return;
    seen.add(e.handle);
    const info = readArray(doc, e);
    if (!info?.stale || info.state.params.kind !== 'path' || !info.state.params.path || !changed.has(info.state.params.path)) return;
    const r = regenerateOps(env, info, info.state);
    if (!('error' in r)) ops.push(...r.ops);
  };
  // 이 앱 기록: 확장 자료의 경로 핸들(둘째 1005)
  for (const e of doc.entityIndex.values()) {
    if (e.type !== 'INSERT' || !e.xdata) continue;
    const rec = e.xdata.find((x) => x.app.toUpperCase() === 'OPENCAD_ARRAY');
    const hs = rec?.items.filter((i) => i.code === 1005).map((i) => normalizeHandle(String(i.value)));
    if (hs && hs[1] && changed.has(hs[1])) consider(e);
  }
  // AutoCAD 기록: 경로 곡선의 반응자(종속) → 동작 → 배열 참조(읽기·쓰기 종속)
  for (const h of changed) {
    const path = doc.entityIndex.get(h);
    for (const r of path?.reactors ?? []) {
      const dep = doc.objects.get(normalizeHandle(r)) as GenericObject | undefined;
      if (dep?.type !== 'ACDBASSOCDEPENDENCY' || !dep.owner) continue;
      for (const o of doc.objects.values()) {
        if (o.type !== 'ACDBASSOCDEPENDENCY' || !o.owner || normalizeHandle(o.owner) !== normalizeHandle(dep.owner)) continue;
        const t = (o as GenericObject).raw?.find((x) => x.code === 330);
        const target = t ? normalizeHandle(String(t.value)) : '';
        consider(target ? doc.entityIndex.get(target) : undefined);
      }
    }
  }
  return ops;
}
