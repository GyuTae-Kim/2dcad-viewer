/**
 * 배열 참조 → 연관 배열 상태. 근거의 순서:
 *  1. AutoCAD 기록의 원본 태그(DXF에서 읽은 AutoCAD 배열 — AutoCAD가 마지막으로 고쳤을 수 있어 가장 먼저)
 *  2. 이 앱의 기록(확장 자료 OPENCAD_ARRAY)
 *  3. 항목 참조에서 짐작(AutoCAD 기록은 있지만 원본 태그가 없는 DWG의 배열)
 * 어느 것이든 그 매개변수로 계산한 항목이 배열 블록의 항목 참조와 맞아야 받아들인다(맞추면서 지운 항목·대체 항목도 정한다).
 */
import type { BlockDef, CadDocument, Entity, InsertEntity, Vec2 } from '../../core/model';
import { tableKey } from '../../core/model';
import { insertAffine } from '../dynblock/build';
import { entityPath } from '../geom/path';
import type { Path } from '../geom/curve';
import { type Affine, affInv, affMul, affTranslate } from '../geom/math';
import { type AcadArray, findAcadArray, paramsFromAcad } from './acad';
import { type ItemRef, commonBlock, inferParams, itemRefs } from './infer';
import { arrayItems, orientedPath } from './layout';
import { blockNameOfRecord, decodeRecord, recordOf } from './record';
import type { ArrayItem, ArrayParams, ArrayState, PathParams } from './types';

export type ArrayOrigin = 'acad' | 'app' | 'infer';

export interface ArrayInfo {
  ins: InsertEntity;
  /** 배열 블록 */
  def: BlockDef;
  state: ArrayState;
  origin: ArrayOrigin;
  acad: AcadArray | null;
  /** 항목 열쇠 → 배열 블록 안 항목 참조 핸들 */
  items: Map<string, string>;
  /** 경로 배열의 경로가 바뀌어 항목이 아직 옛 자리에 있다(다시 계산하면 새 경로를 따른다) */
  stale?: boolean;
}

/**
 * 경로 배열의 경로(방향 반영). 경로 곡선이 있으면 도면 좌표(world), 없으면 AutoCAD가 남긴 곡선 캐시 —
 * 배열 블록 좌표(block, 배열을 옮기거나 대칭해도 항목과 함께 간다). 둘 다 없으면 null.
 */
export function arrayPath(doc: CadDocument, p: PathParams): { path: Path; world: boolean; raw?: Path } | null {
  const e = p.path ? doc.entityIndex.get(p.path) : undefined;
  const ep = e ? entityPath(e) : null;
  if (ep) {
    const path = orientedPath(p, ep);
    return path ? { path, world: true, raw: ep } : null;
  }
  const path = orientedPath({ ...p }, null);
  return path ? { path, world: false } : null;
}

/** 배열 블록 좌표의 모든 항목(지운 항목 포함). 경로 배열인데 경로가 없으면 빈 배열 */
export function expectedItems(doc: CadDocument, ins: InsertEntity, def: Pick<BlockDef, 'basePoint'>, p: ArrayParams): ArrayItem[] {
  if (p.kind !== 'path') return arrayItems(p);
  const ap = arrayPath(doc, p);
  if (!ap) return [];
  if (!ap.world) return arrayItems(p, ap.path, null);
  const toBlock = affInv(insertAffine(def as BlockDef, ins));
  return toBlock ? arrayItems(p, ap.path, toBlock) : [];
}

/** 항목 참조의 행렬: 원본은 항목 행렬, 대체 블록은 원점이 원본 기준점에 오게 */
export function itemMatrix(it: ArrayItem, replaced: boolean, base: Vec2): Affine {
  return replaced ? affMul(it.matrix, affTranslate(base.x, base.y)) : it.matrix;
}

function tolFor(refs: readonly ItemRef[], items: readonly ArrayItem[]): number {
  let m = 1;
  for (const r of refs) m = Math.max(m, Math.abs(r.matrix[4]), Math.abs(r.matrix[5]));
  for (const it of items) m = Math.max(m, Math.abs(it.matrix[4]), Math.abs(it.matrix[5]));
  return m * 1e-6;
}

function same(a: Affine, b: Affine, tol: number): boolean {
  for (let i = 0; i < 4; i++) if (Math.abs(a[i]! - b[i]!) > 1e-5) return false;
  return Math.abs(a[4] - b[4]) <= tol && Math.abs(a[5] - b[5]) <= tol;
}

/**
 * 계산한 항목과 배열 블록의 항목 참조를 맞춘다.
 *  - derive: 지운 항목(맞는 참조가 없음)·대체 항목(원본이 아닌 블록)을 정한다.
 *  - 그렇지 않으면 state의 지운·대체 항목대로인지 본다.
 * 남는 참조가 있거나(derive 아님) 빠진 항목이 있으면 null.
 */
export function matchItems(refs: readonly ItemRef[], items: readonly ArrayItem[], state: ArrayState, derive: boolean): { items: Map<string, string>; removed: Set<string>; replaced: Map<string, string> } | null {
  if (!items.length) return null;
  const tol = tolFor(refs, items);
  const cell = tol * 8;
  const grid = new Map<string, number[]>();
  const cellKey = (x: number, y: number) => `${Math.round(x / cell)},${Math.round(y / cell)}`;
  refs.forEach((r, i) => {
    const k = cellKey(r.matrix[4], r.matrix[5]);
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  });
  const used = new Uint8Array(refs.length);
  const find = (m: Affine, z: number, block: string | null): number => {
    const cx = Math.round(m[4] / cell);
    const cy = Math.round(m[5] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (used[i]) continue;
          const r = refs[i]!;
          if (block !== null && tableKey(r.block) !== tableKey(block)) continue;
          if (Math.abs(r.z - z) > tol) continue;
          if (same(r.matrix, m, tol)) return i;
        }
    return -1;
  };
  const out = new Map<string, string>();
  const removed = new Set<string>();
  const replaced = new Map<string, string>();
  const base = state.params.base;
  for (const it of items) {
    if (!derive) {
      if (state.removed.has(it.key)) continue;
      const rep = state.replaced.get(it.key);
      const i = find(itemMatrix(it, !!rep, base), it.z, rep ?? state.source);
      if (i < 0) return null;
      used[i] = 1;
      out.set(it.key, refs[i]!.handle);
      continue;
    }
    let i = find(it.matrix, it.z, state.source);
    if (i < 0) {
      i = find(itemMatrix(it, true, base), it.z, null);
      if (i >= 0 && tableKey(refs[i]!.block) === tableKey(state.source)) i = -1;
    }
    if (i < 0) {
      removed.add(it.key);
      continue;
    }
    used[i] = 1;
    out.set(it.key, refs[i]!.handle);
    if (tableKey(refs[i]!.block) !== tableKey(state.source)) replaced.set(it.key, refs[i]!.block);
  }
  if (used.some((u) => !u)) return null;
  if (derive && !out.size) return null;
  return { items: out, removed: derive ? removed : new Set(state.removed), replaced: derive ? replaced : new Map(state.replaced) };
}

/** 배열 참조인지(이 앱 기록이나 AutoCAD 연관 배열 기록이 있다). 해석할 수 있는지는 readArray */
export function looksLikeArray(doc: CadDocument, e: Entity | undefined): boolean {
  if (!e || e.type !== 'INSERT') return false;
  if (recordOf(e.xdata)) return true;
  return !!findAcadArray(doc, e);
}

/** 연관 배열을 읽는다(배열이 아니거나 항목이 매개변수와 맞지 않으면 null) */
export function readArray(doc: CadDocument, e: Entity | undefined): ArrayInfo | null {
  if (!e || e.type !== 'INSERT') return null;
  const ins = e;
  const def = doc.blocks.get(tableKey(ins.block));
  if (!def) return null;
  const rec = recordOf(ins.xdata);
  const acad = findAcadArray(doc, ins);
  if (!rec && !acad) return null;
  const refs = itemRefs(doc, def);
  if (!refs || !refs.length) return null;
  const tryState = (state: ArrayState | null, derive: boolean, origin: ArrayOrigin): ArrayInfo | null => {
    if (!state || !doc.blocks.has(tableKey(state.source))) return null;
    const items = expectedItems(doc, ins, def, state.params);
    const m = matchItems(refs, items, state, derive);
    if (!m) return null;
    return { ins, def, origin, acad, items: m.items, state: { ...state, removed: m.removed, replaced: m.replaced } };
  };
  // 1. AutoCAD 원본 태그
  if (acad?.raw) {
    const params = paramsFromAcad(acad, acad.items);
    const source = (acad.sourceRecord && blockNameOfRecord(doc, acad.sourceRecord)) || commonBlock(refs);
    if (params && source) {
      const got = tryState({ params, source, removed: new Set(), replaced: new Map() }, true, 'acad');
      if (got) return got;
    }
  }
  // 2. 이 앱의 기록
  if (rec) {
    const got = tryState(decodeRecord(doc, rec), false, acad ? 'acad' : 'app');
    if (got) return { ...got, origin: acad?.raw ? 'acad' : acad ? 'infer' : 'app' };
  }
  // 3. 짐작(AutoCAD 기록이 있을 때만)
  if (acad) {
    const source = (acad.sourceRecord && blockNameOfRecord(doc, acad.sourceRecord)) || commonBlock(refs);
    const params = source ? inferParams(doc, ins, def, refs, { kind: acad.kind, path: acad.pathEntity ?? null }) : null;
    if (params && source) {
      const got = tryState({ params, source, removed: new Set(), replaced: new Map() }, true, 'infer');
      if (got) return got;
    }
  }
  // 4. 경로가 바뀐 경로 배열: 항목은 옛 경로에 있지만 기록을 믿는다(다시 계산하면 새 경로로 간다)
  const live = new Set(refs.map((r) => r.handle));
  if (acad?.raw) {
    const params = paramsFromAcad(acad, acad.items);
    const source = (acad.sourceRecord && blockNameOfRecord(doc, acad.sourceRecord)) || commonBlock(refs);
    if (params?.kind === 'path' && source && doc.blocks.has(tableKey(source))) {
      const items = new Map<string, string>();
      const replaced = new Map<string, string>();
      for (const it of acad.items) {
        if (!live.has(it.handle)) continue;
        const k = `${it.index},${it.row},${it.level}`;
        items.set(k, it.handle);
        const r = refs.find((x) => x.handle === it.handle);
        if (r && tableKey(r.block) !== tableKey(source)) replaced.set(k, r.block);
      }
      if (items.size === refs.length) return { ins, def, origin: 'acad', acad, items, stale: true, state: { params, source, removed: new Set(), replaced } };
    }
  }
  if (rec) {
    const state = decodeRecord(doc, rec);
    if (state?.params.kind === 'path' && doc.blocks.has(tableKey(state.source))) {
      const allowed = new Set([tableKey(state.source), ...[...state.replaced.values()].map(tableKey)]);
      if (refs.every((r) => allowed.has(tableKey(r.block)))) {
        // 이 앱이 만든 블록은 항목 열쇠 순서다 → 같은 수면 순서대로 맞춘다(핸들 재사용용)
        const keys = expectedItems(doc, ins, def, state.params).filter((it) => !state.removed.has(it.key)).map((it) => it.key);
        const items = new Map<string, string>();
        if (keys.length === refs.length) keys.forEach((k, i) => items.set(k, refs[i]!.handle));
        return { ins, def, origin: acad?.raw ? 'acad' : acad ? 'infer' : 'app', acad, items, stale: true, state };
      }
    }
  }
  return null;
}

/** 이 블록을 참조하는 다른 참조가 있는지 */
export function blockShared(doc: CadDocument, block: string, except: string): boolean {
  const k = tableKey(block);
  for (const e of doc.entityIndex.values()) if (e.type === 'INSERT' && e.handle !== except && tableKey(e.block) === k) return true;
  return false;
}
