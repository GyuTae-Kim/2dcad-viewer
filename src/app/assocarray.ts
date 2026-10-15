/**
 * 연관 배열: ARRAYRECT·ARRAYPOLAR·ARRAYPATH의 연관(AS) = 예, ARRAYEDIT, ARRAYCLOSE, ARRAYASSOCIATIVITY,
 * Ctrl+클릭(⌘+클릭)으로 항목 하나 고르기 + Delete로 그 항목 지우기.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 저장 형식과 계산은 src/edit/assocarray(머리말).
 */
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import { type CreateInput, blockCopies, createArrayOps, followPathOps, regenerateOps } from '../edit/assocarray/build';
import { isFullCircle, itemCount, pathMaxItems, pathSpacingOf, polarWithAngle, polarWithFill, polarWithItems } from '../edit/assocarray/layout';
import { type ArrayInfo, arrayPath, expectedItems, looksLikeArray } from '../edit/assocarray/read';
import { type ArrayKind, type ArrayParams, type ArrayState, KIND_LABEL, MAX_ITEMS, cloneState, parseKey } from '../edit/assocarray/types';
import { type PathArraySpec, startTangentAngle } from '../edit/arraypath';
import { boundsOf } from '../edit/geom/query';
import { type Path, pathStart } from '../edit/geom/curve';
import { entityPath } from '../edit/geom/path';
import { type Affine, affApply, affInv, affMul, affRotate, affTranslate } from '../edit/geom/math';
import type { EditOp, EditSession, Transaction } from '../edit/session';
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import { unlockedOnly } from './layers';
import { currentProps } from './draw';
import { applyArrayState, arrayAssociativity, arrayOf, arrayPreview, arrayToWorld, askNumber, askYesNo, buildEnv, degText, itemAt, setArrayAssociativity } from './assocarray-core';
import type { Pt } from './view';
import { installArrayGrips } from './assocarray-grips';

export { arrayAssociativity, setArrayAssociativity } from './assocarray-core';

// ---------------------------------------------------------------------------
// 만들기(ARRAYRECT·ARRAYPOLAR·ARRAYPATH에서 부른다)
// ---------------------------------------------------------------------------

export interface RectRequest {
  kind: 'rect';
  handles: string[];
  rows: number;
  columns: number;
  rowSpacing: number;
  columnSpacing: number;
  /** 행 축 각도(라디안) */
  angle: number;
}

export interface PolarRequest {
  kind: 'polar';
  handles: string[];
  center: Pt;
  items: number;
  /** 채울 각도(라디안, 음수 = 시계) */
  fill: number;
  rotate: boolean;
}

export interface PathRequest {
  kind: 'path';
  handles: string[];
  pathHandle: string;
  /** 고른 점 쪽에서 시작하게 방향을 맞춘 경로(도면 좌표) */
  path: Path;
  spec: PathArraySpec;
  levels: number;
  levelSpacing: number;
  zDir: boolean;
}

export type AssocRequest = RectRequest | PolarRequest | PathRequest;

/** 객체들의 범위 중심(화면 고르기 상자, 없으면 형상 범위) */
function extentsCenter(app: App, handles: readonly string[], list: readonly Entity[]): Pt | null {
  const pk = app.picker();
  let r: [number, number, number, number] | null = null;
  for (const h of handles) {
    const b = pk?.box(h);
    if (!b) continue;
    r = r ? [Math.min(r[0], b.minX), Math.min(r[1], b.minY), Math.max(r[2], b.maxX), Math.max(r[3], b.maxY)] : [b.minX, b.minY, b.maxX, b.maxY];
  }
  if (!r) {
    const b = boundsOf(list, app.active!.doc);
    if (b && Number.isFinite(b.minX)) r = [b.minX, b.minY, b.maxX, b.maxY];
  }
  return r ? { x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 } : null;
}

/** 연관 배열을 만든다. 만들었으면 true */
export function createAssocArray(app: App, ctx: CommandContext, req: AssocRequest, label: string): boolean {
  const st = app.active!;
  const doc = st.doc;
  const sources = req.handles.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
  if (!sources.length) return false;
  const c = extentsCenter(app, req.handles, sources) ?? { x: 0, y: 0 };
  const props = { ...currentProps(app), paperSpace: /^\*PAPER_SPACE/i.test(st.space) ? true : undefined };
  let input: CreateInput;
  if (req.kind === 'rect') {
    input = {
      params: {
        kind: 'rect',
        base: { x: 0, y: 0 },
        origin: { x: 0, y: 0 },
        columns: req.columns,
        columnSpacing: req.columnSpacing,
        rows: req.rows,
        rowSpacing: req.rowSpacing,
        rowElevation: 0,
        levels: 1,
        levelSpacing: Math.abs(req.rowSpacing) || 1,
        axesAngle: Math.PI / 2,
      },
      sources,
      normalize: affMul(affRotate(-req.angle), affTranslate(-c.x, -c.y)),
      insert: { x: c.x, y: c.y, z: 0 },
      rotation: req.angle,
      props,
      space: st.space,
    };
  } else if (req.kind === 'polar') {
    const dx = c.x - req.center.x;
    const dy = c.y - req.center.y;
    const n = Math.max(1, Math.round(req.items));
    const step = isFullCircle(req.fill) ? req.fill / n : n > 1 ? req.fill / (n - 1) : req.fill;
    input = {
      params: {
        kind: 'polar',
        base: { x: 0, y: 0 },
        center: { x: 0, y: 0 },
        items: n,
        itemAngle: step,
        fillAngle: req.fill,
        startAngle: Math.atan2(dy, dx),
        radius: Math.hypot(dx, dy),
        rotateItems: req.rotate,
        rows: 1,
        rowSpacing: Math.hypot(dx, dy) || 1,
        rowElevation: 0,
        levels: 1,
        levelSpacing: 1,
      },
      sources,
      normalize: affTranslate(-c.x, -c.y),
      insert: { x: req.center.x, y: req.center.y, z: 0 },
      rotation: 0,
      props,
      space: st.space,
    };
  } else {
    const pe = doc.entityIndex.get(req.pathHandle);
    const natural = pe ? entityPath(pe) : null;
    const s0 = pathStart(req.path);
    const n0 = natural ? pathStart(natural) : s0;
    const reverse = !req.path.closed && Math.hypot(s0.x - n0.x, s0.y - n0.y) > 1e-9 * Math.max(1, Math.abs(s0.x), Math.abs(s0.y));
    const spec = req.spec;
    const ref = spec.tangent ?? startTangentAngle(req.path);
    input = {
      params: {
        kind: 'path',
        base: { x: 0, y: 0 },
        method: spec.method,
        items: spec.count,
        spacing: spec.spacing,
        align: spec.align,
        zDir: req.zDir,
        reverse,
        path: req.pathHandle,
        tangentRef: ref,
        rows: spec.rows,
        rowSpacing: spec.rowSpacing,
        rowElevation: 0,
        levels: req.levels,
        levelSpacing: req.levelSpacing,
      },
      sources,
      normalize: affTranslate(-spec.base.x, -spec.base.y),
      insert: { x: 0, y: 0, z: 0 },
      rotation: 0,
      props,
      space: st.space,
    };
    // 원본 블록 좌표에서 접선 기준 방향은 그대로(이동만) → 정렬 각도 = 경로 접선 − 기준 방향
  }
  const r = createArrayOps(buildEnv(st), input);
  if ('error' in r) {
    ctx.print(r.error, 'err');
    return false;
  }
  st.selection.clear();
  st.session.commit({ label, ops: r.ops, group: ctx.group, rebuildNow: true });
  app.refreshSelectionOverlay();
  ctx.print(`항목 ${r.items.toLocaleString()}개의 연관 배열(${KIND_LABEL[req.kind]})을 만들었습니다.`);
  return true;
}

// ---------------------------------------------------------------------------
// 원본 편집 상태(ARRAYEDIT 소스(S) → ARRAYCLOSE)
// ---------------------------------------------------------------------------

interface SourceEdit {
  array: string;
  key: string;
  /** 고치는 블록(원본 또는 대체 블록) */
  block: string;
  /** 그 블록 좌표 → 도면 좌표 */
  toWorld: Affine;
  temps: string[];
  space: string;
  /** 편집 상태를 시작할 때 그 공간에 있던 객체 */
  before: Set<string>;
}

const editing = new WeakMap<DocState, SourceEdit>();

/** 배열 편집 상태인지(AutoCAD ARRAYEDITSTATE) */
export function arrayEditState(app: App): boolean {
  return !!(app.active && editing.has(app.active));
}

function itemLabel(kind: ArrayKind, key: string): string {
  const k = parseKey(key);
  if (!k) return key;
  const lv = k.level ? `, 레벨 ${k.level + 1}` : '';
  return kind === 'rect' ? `열 ${k.index + 1}, 행 ${k.row + 1}${lv}` : `항목 ${k.index + 1}, 행 ${k.row + 1}${lv}`;
}

/** 지우기 작업(블록마다 뒤에서부터) */
function removeOps(st: DocState, handles: readonly string[]): EditOp[] {
  const rem: { block: string; entity: Entity; index: number }[] = [];
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    const block = st.session.ownerOf(h);
    if (!e || !block) continue;
    rem.push({ block, entity: e, index: st.doc.blocks.get(block)!.entities.indexOf(e) });
  }
  rem.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block < b.block ? -1 : 1));
  return rem.map((r) => ({ kind: 'remove', ...r }));
}

async function enterSourceEdit(app: App, ctx: CommandContext, info: ArrayInfo): Promise<boolean> {
  const st = app.active!;
  const doc = st.doc;
  if (editing.has(st)) {
    ctx.print('이미 배열 편집 상태입니다. 먼저 ARRAYCLOSE로 저장하거나 취소하십시오.', 'err');
    return false;
  }
  for (;;) {
    const r = await ctx.getPoint('배열에서 항목 선택:');
    if (!('point' in r)) return false;
    const hit = itemAt(doc, info, r.point, 4 * app.view.pixelSize());
    if (!hit) {
      ctx.print('배열의 항목이 아닙니다.', 'err');
      continue;
    }
    const def = doc.blocks.get(tableKey(hit.block));
    if (!def) return false;
    const env = buildEnv(st);
    const copies = blockCopies(env, def.entities, hit.toWorld);
    const space = doc.blocks.get(st.space);
    const before = new Set((space?.entities ?? []).map((e) => e.handle));
    const ops: EditOp[] = [];
    for (const b of copies.blocks) ops.push({ kind: 'blockDef', key: tableKey(b.name), before: doc.blocks.get(tableKey(b.name)) ?? null, after: b });
    for (const e of copies.entities) {
      e.owner = space?.recordHandle;
      e.paperSpace = /^\*PAPER_SPACE/i.test(st.space) ? true : undefined;
      ops.push({ kind: 'add', block: st.space, entity: e });
    }
    st.session.commit({ label: 'ARRAYEDIT', ops, group: ctx.group });
    editing.set(st, { array: info.ins.handle, key: hit.key, block: hit.block, toWorld: hit.toWorld, temps: copies.entities.map((e) => e.handle), space: st.space, before });
    app.setSelection([]);
    ctx.print(`배열 편집 상태입니다(${itemLabel(info.state.params.kind, hit.key)}). 원본 객체를 고친 뒤 ARRAYCLOSE로 변경 내용을 저장하거나 취소하십시오. 새로 그린 객체도 원본에 들어갑니다.`);
    return true;
  }
}

async function closeSourceEdit(app: App, ctx: CommandContext, save: boolean | null): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const ed = editing.get(st);
  if (!ed) {
    ctx.print('배열 편집 상태가 아닙니다. ARRAYEDIT의 소스(S) 옵션으로 시작하십시오.');
    return;
  }
  if (save === null) {
    const r = await ctx.getPoint('배열 편집 상태에 대한 변경 내용을 저장하시겠습니까? [저장(S)/취소(D)] <저장>:', {
      keywords: [
        { key: 'S', label: '저장' },
        { key: 'D', label: '취소' },
      ],
    });
    if ('keyword' in r) save = r.keyword === 'S';
    else if ('enter' in r) save = true;
    else return;
  }
  const space = doc.blocks.get(ed.space);
  const tempSet = new Set(ed.temps);
  const added = (space?.entities ?? []).filter((e) => !ed.before.has(e.handle) && !tempSet.has(e.handle)).map((e) => e.handle);
  const list = [...ed.temps.filter((h) => doc.entityIndex.has(h)), ...added];
  if (!save) {
    const ops = removeOps(st, list);
    if (ops.length) st.session.commit({ label: 'ARRAYCLOSE', ops, group: ctx.group });
    editing.delete(st);
    ctx.print('배열 편집 상태의 변경 내용을 버렸습니다.');
    return;
  }
  const info = arrayOf(st, ed.array);
  if (!info) {
    ctx.print('편집하던 배열을 찾을 수 없습니다. 변경 내용을 버립니다.', 'err');
    const ops = removeOps(st, list);
    if (ops.length) st.session.commit({ label: 'ARRAYCLOSE', ops, group: ctx.group });
    editing.delete(st);
    return;
  }
  const ents = list.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
  if (!ents.length) {
    ctx.print('원본 객체가 하나도 남지 않아 저장할 수 없습니다. ARRAYCLOSE의 취소(D)로 끝내십시오.', 'err');
    return;
  }
  const inv = affInv(ed.toWorld);
  if (!inv) return;
  const env = buildEnv(st);
  const copies = blockCopies(env, ents, inv);
  const next = cloneState(info.state);
  const label = 'ARRAYCLOSE';
  const r = regenerateOps(env, info, next, { contents: [{ name: ed.block, entities: copies.entities, blocks: copies.blocks }] });
  if ('error' in r) {
    ctx.print(r.error, 'err');
    return;
  }
  st.session.commit({ label, ops: [...r.ops, ...removeOps(st, list)], group: ctx.group, rebuildNow: true });
  editing.delete(st);
  app.refreshSelectionOverlay();
  ctx.print('배열 편집 상태의 변경 내용을 저장했습니다.');
}

// ---------------------------------------------------------------------------
// ARRAYEDIT 옵션
// ---------------------------------------------------------------------------

const KW: Record<ArrayKind, Keyword[]> = {
  rect: [
    { key: 'S', label: '소스' },
    { key: 'REP', label: '대체' },
    { key: 'B', label: '기준점' },
    { key: 'R', label: '행' },
    { key: 'COL', label: '열' },
    { key: 'L', label: '레벨' },
    { key: 'RES', label: '재설정' },
    { key: 'X', label: '종료' },
  ],
  polar: [
    { key: 'S', label: '소스' },
    { key: 'REP', label: '대체' },
    { key: 'B', label: '기준점' },
    { key: 'I', label: '항목' },
    { key: 'A', label: '사이 각도' },
    { key: 'F', label: '채울 각도' },
    { key: 'ROW', label: '행' },
    { key: 'L', label: '레벨' },
    { key: 'ROT', label: '항목 회전' },
    { key: 'RES', label: '재설정' },
    { key: 'X', label: '종료' },
  ],
  path: [
    { key: 'S', label: '소스' },
    { key: 'REP', label: '대체' },
    { key: 'M', label: '방법' },
    { key: 'B', label: '기준점' },
    { key: 'I', label: '항목' },
    { key: 'R', label: '행' },
    { key: 'L', label: '레벨' },
    { key: 'A', label: '항목 정렬' },
    { key: 'Z', label: 'Z 방향' },
    { key: 'RES', label: '재설정' },
    { key: 'X', label: '종료' },
  ],
};

const tooMany = `배열 항목이 너무 많습니다(최대 ${MAX_ITEMS.toLocaleString()}개).`;

/** 행(수·간격·증분 고도). 바뀐 매개변수 또는 null */
async function askRows(ctx: CommandContext, p: ArrayParams, fmt: (v: number) => string): Promise<ArrayParams | null> {
  const n = await askNumber(ctx, `행 수 입력 또는 [표현식(E)] <${p.rows}>:`, p.rows, {
    integer: true,
    check: (v) => (v < 1 ? '1 이상의 정수를 입력하십시오.' : itemCount({ ...p, rows: v }) > MAX_ITEMS ? tooMany : null),
  });
  if (typeof n !== 'number') return null;
  let spacing = p.rowSpacing;
  const d = await askNumber(ctx, `행 사이의 거리 지정 또는 [전체(T)/표현식(E)] <${fmt(p.rowSpacing)}>:`, p.rowSpacing, { keywords: [{ key: 'T', label: '전체' }] });
  if (typeof d === 'number') spacing = d;
  else if (d && d.keyword === 'T') {
    const tot = await askNumber(ctx, `시작 행과 끝 행 사이의 전체 거리 지정 또는 [표현식(E)] <${fmt(p.rowSpacing * Math.max(1, n - 1))}>:`, p.rowSpacing * Math.max(1, n - 1));
    if (typeof tot === 'number') spacing = n > 1 ? tot / (n - 1) : tot;
  }
  const z = await askNumber(ctx, `행 사이의 증분 고도 지정 또는 [표현식(E)] <${fmt(p.rowElevation)}>:`, p.rowElevation);
  return { ...p, rows: n, rowSpacing: spacing, rowElevation: typeof z === 'number' ? z : p.rowElevation };
}

async function askLevels(ctx: CommandContext, p: ArrayParams, fmt: (v: number) => string): Promise<ArrayParams | null> {
  const n = await askNumber(ctx, `레벨 수 입력 또는 [표현식(E)] <${p.levels}>:`, p.levels, {
    integer: true,
    check: (v) => (v < 1 ? '1 이상의 정수를 입력하십시오.' : itemCount({ ...p, levels: v }) > MAX_ITEMS ? tooMany : null),
  });
  if (typeof n !== 'number') return null;
  let spacing = p.levelSpacing;
  const d = await askNumber(ctx, `레벨 사이의 거리 지정 또는 [전체(T)/표현식(E)] <${fmt(p.levelSpacing)}>:`, p.levelSpacing, { keywords: [{ key: 'T', label: '전체' }] });
  if (typeof d === 'number') spacing = d;
  else if (d && d.keyword === 'T') {
    const tot = await askNumber(ctx, `시작 레벨과 끝 레벨 사이의 전체 거리 지정 또는 [표현식(E)] <${fmt(p.levelSpacing * Math.max(1, n - 1))}>:`, p.levelSpacing * Math.max(1, n - 1));
    if (typeof tot === 'number') spacing = n > 1 ? tot / (n - 1) : tot;
  }
  if (n > 1) ctx.print('레벨은 Z 방향으로 쌓이므로 평면도에서는 같은 자리에 겹쳐 보입니다.');
  return { ...p, levels: n, levelSpacing: spacing };
}

/** 기준점(B): 첫 항목에서 고른 점을 원본 블록 좌표로. 직사각형은 항목이 그대로이고 첫 항목 자리만 옮긴다 */
async function askBase(app: App, ctx: CommandContext, info: ArrayInfo): Promise<ArrayParams | null> {
  const st = app.active!;
  const p = info.state.params;
  const r = await ctx.getPoint('기준점 지정 또는 [키 점(K)] <중심>:', { keywords: [{ key: 'K', label: '키 점' }] });
  let srcPt: Pt | null = null;
  const first = expectedItems(st.doc, info.ins, info.def, p)[0];
  if (!first) return null;
  const toWorld = affMul(arrayToWorld(info), first.matrix);
  const inv = affInv(toWorld);
  if (!inv) return null;
  if ('enter' in r) {
    const def = st.doc.blocks.get(tableKey(info.state.source));
    const b = def ? boundsOf(def.entities, st.doc) : null;
    if (b && Number.isFinite(b.minX)) srcPt = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  } else if ('point' in r) srcPt = affApply(inv, r.point);
  else if ('keyword' in r) {
    const k = await ctx.getPoint('원본 객체의 키 점 지정:');
    if ('point' in k) srcPt = affApply(inv, k.point);
  }
  if (!srcPt) return null;
  // 지금 기준점 기준의 원본 좌표 → 새 기준점(원본 블록 좌표) = 지금 기준점 + 차이
  const nb = { x: p.base.x + srcPt.x, y: p.base.y + srcPt.y };
  if (p.kind === 'rect') return { ...p, base: nb, origin: { x: p.origin.x + srcPt.x, y: p.origin.y + srcPt.y } };
  return { ...p, base: nb };
}

/** 대체(REP) */
async function replaceItems(app: App, ctx: CommandContext, handle: string): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const hs = unlockedOnly(app, await ctx.getSelection('대체 객체 선택:', { noPickfirst: true })).filter((h) => h !== handle && doc.entityIndex.has(h));
  if (!hs.length) return;
  const ents = hs.map((h) => doc.entityIndex.get(h)!).filter(Boolean);
  const r = await ctx.getPoint('대체 객체의 기준점 선택 또는 [키 점(K)] <중심>:', { keywords: [{ key: 'K', label: '키 점' }] });
  let bp: Pt | null = null;
  if ('point' in r) bp = r.point;
  else if ('enter' in r) bp = extentsCenter(app, hs, ents);
  else if ('keyword' in r) {
    const k = await ctx.getPoint('대체 객체의 키 점 지정:');
    if ('point' in k) bp = k.point;
  }
  if (!bp) return;
  const env = buildEnv(st);
  const repName = env.newBlockName();
  const copies = blockCopies(env, ents, affTranslate(-bp.x, -bp.y));
  let created = false;
  for (;;) {
    const info = arrayOf(st, handle);
    if (!info) return;
    const q = await ctx.getPoint('배열에서 대체할 항목 선택 또는 [원본 객체(S)]:', { keywords: [{ key: 'S', label: '원본 객체' }] });
    if (!('point' in q) && !('keyword' in q)) return;
    const next = cloneState(info.state);
    const keys: string[] = [];
    if ('keyword' in q) {
      for (const it of expectedItems(doc, info.ins, info.def, info.state.params)) if (!next.removed.has(it.key) && !next.replaced.has(it.key)) keys.push(it.key);
    } else {
      const hit = itemAt(doc, info, q.point, 4 * app.view.pixelSize());
      if (!hit) {
        ctx.print('배열의 항목이 아닙니다.', 'err');
        continue;
      }
      keys.push(hit.key);
    }
    if (!keys.length) continue;
    for (const k of keys) next.replaced.set(k, repName);
    const opt = created ? {} : { newBlocks: [{ name: repName, entities: copies.entities }] };
    if (!created && copies.blocks.length) {
      // 딸린 블록(치수 블록 등)은 대체 블록보다 먼저
      for (const b of copies.blocks) st.session.commit({ label: 'ARRAYEDIT', ops: [{ kind: 'blockDef', key: tableKey(b.name), before: doc.blocks.get(tableKey(b.name)) ?? null, after: b }], group: ctx.group });
    }
    if (applyArrayState(app, ctx, info, next, 'ARRAYEDIT', opt)) {
      created = true;
      ctx.print(`항목 ${keys.length.toLocaleString()}개를 대체했습니다.`);
    }
    if ('keyword' in q) return;
  }
}

async function editOption(app: App, ctx: CommandContext, handle: string, info: ArrayInfo, k: string): Promise<'exit' | void> {
  const st = app.active!;
  const fmt = (v: number) => formatLength(v, st.units);
  const p = info.state.params;
  const apply = (params: ArrayParams | null, extra: Partial<ArrayState> = {}) => {
    if (!params) return;
    applyArrayState(app, ctx, info, { ...cloneState(info.state), ...extra, params }, 'ARRAYEDIT');
  };
  if (k === 'S') return (await enterSourceEdit(app, ctx, info)) ? 'exit' : undefined;
  if (k === 'REP') return replaceItems(app, ctx, handle);
  if (k === 'RES') {
    if (!info.state.removed.size && !info.state.replaced.size) {
      ctx.print('지우거나 대체한 항목이 없습니다.');
      return;
    }
    apply(p, { removed: new Set(), replaced: new Map() });
    return;
  }
  if (k === 'B') return apply(await askBase(app, ctx, info));
  if (k === 'L') return apply(await askLevels(ctx, p, fmt));
  if (p.kind === 'rect') {
    if (k === 'R') return apply(await askRows(ctx, p, fmt));
    if (k === 'COL') {
      const n = await askNumber(ctx, `열 수 입력 또는 [표현식(E)] <${p.columns}>:`, p.columns, {
        integer: true,
        check: (v) => (v < 1 ? '1 이상의 정수를 입력하십시오.' : itemCount({ ...p, columns: v }) > MAX_ITEMS ? tooMany : null),
      });
      if (typeof n !== 'number') return;
      let spacing = p.columnSpacing;
      const d = await askNumber(ctx, `열 사이의 거리 지정 또는 [전체(T)/표현식(E)] <${fmt(p.columnSpacing)}>:`, p.columnSpacing, { keywords: [{ key: 'T', label: '전체' }] });
      if (typeof d === 'number') spacing = d;
      else if (d && d.keyword === 'T') {
        const tot = await askNumber(ctx, `시작 열과 끝 열 사이의 전체 거리 지정 또는 [표현식(E)] <${fmt(p.columnSpacing * Math.max(1, n - 1))}>:`, p.columnSpacing * Math.max(1, n - 1));
        if (typeof tot === 'number') spacing = n > 1 ? tot / (n - 1) : tot;
      }
      return apply({ ...p, columns: n, columnSpacing: spacing });
    }
    return;
  }
  if (p.kind === 'polar') {
    if (k === 'ROW') return apply(await askRows(ctx, p, fmt));
    if (k === 'I') {
      const n = await askNumber(ctx, `배열의 항목 수 입력 또는 [표현식(E)] <${p.items}>:`, p.items, {
        integer: true,
        check: (v) => (v < 1 ? '1 이상의 정수를 입력하십시오.' : itemCount({ ...p, items: v }) > MAX_ITEMS ? tooMany : null),
      });
      if (typeof n === 'number') apply(polarWithItems(p, n));
      return;
    }
    if (k === 'A') {
      const a = await askNumber(ctx, `항목 사이의 각도 지정 또는 [표현식(EX)] <${degText(p.itemAngle)}>:`, p.itemAngle, {
        angle: true,
        exprKey: 'EX',
        check: (v) => (v === 0 || Math.abs(v * (p.items - 1)) > 2 * Math.PI + 1e-9 ? '항목 사이의 각도가 너무 크거나 0입니다(채울 각도는 360°를 넘을 수 없습니다).' : null),
      });
      if (typeof a === 'number') apply(polarWithAngle(p, a));
      return;
    }
    if (k === 'F') {
      const f = await askNumber(ctx, `채울 각도 지정(+=ccw, -=cw) 또는 [표현식(EX)] <${degText(p.fillAngle)}>:`, p.fillAngle, {
        angle: true,
        exprKey: 'EX',
        check: (v) => (v === 0 || Math.abs(v) > 2 * Math.PI + 1e-9 ? '채울 각도는 0이 아니고 360°를 넘지 않아야 합니다.' : null),
      });
      if (typeof f === 'number') apply(polarWithFill(p, f));
      return;
    }
    if (k === 'ROT') {
      const v = await askYesNo(ctx, '배열된 항목을 회전하시겠습니까?', p.rotateItems);
      apply({ ...p, rotateItems: v });
      return;
    }
    return;
  }
  // 경로
  const ap = arrayPath(st.doc, p);
  if (k === 'R') return apply(await askRows(ctx, p, fmt));
  if (k === 'M') {
    const m = await ctx.getPoint(`경로 방법 입력 [등분할(D)/길이 분할(M)] <${p.method === 'divide' ? '등분할' : '길이 분할'}>:`, {
      keywords: [
        { key: 'D', label: '등분할' },
        { key: 'M', label: '길이 분할' },
      ],
    });
    if (!('keyword' in m)) return;
    const method = m.keyword === 'D' ? 'divide' : 'measure';
    if (method === p.method) return;
    if (method === 'measure' && ap) {
      const spacing = pathSpacingOf(p, ap.path);
      const q = { ...p, method, spacing } as typeof p;
      return apply({ ...q, items: Math.min(p.items, pathMaxItems(q, ap.path)) });
    }
    return apply({ ...p, method });
  }
  if (k === 'I') {
    if (!ap) {
      ctx.print('경로 곡선을 찾을 수 없어 항목을 다시 계산할 수 없습니다.', 'err');
      return;
    }
    if (p.method === 'measure') {
      const d = await askNumber(ctx, `경로를 따라 항목 사이의 거리 지정 또는 [표현식(E)] <${fmt(p.spacing)}>:`, p.spacing, {
        check: (v) => (v > 0 && pathMaxItems({ ...p, spacing: v }, ap.path) < MAX_ITEMS ? null : '0보다 큰 거리를 입력하십시오(항목이 너무 많아지지 않게).'),
      });
      if (typeof d !== 'number') return;
      const max = pathMaxItems({ ...p, spacing: d }, ap.path);
      ctx.print(`최대 항목 수 = ${max}`);
      const n = await askNumber(ctx, `항목 수 지정 또는 [전체 경로 채우기(F)/표현식(E)] <${max}>:`, max, {
        keywords: [{ key: 'F', label: '전체 경로 채우기' }],
        integer: true,
        check: (v) => (v >= 1 && v <= max ? null : `1에서 ${max} 사이의 정수를 입력하십시오.`),
      });
      return apply({ ...p, spacing: d, items: typeof n === 'number' ? n : max });
    }
    const n = await askNumber(ctx, `경로를 따라 항목 수 지정 또는 [표현식(E)] <${p.items}>:`, p.items, {
      integer: true,
      check: (v) => (v >= 2 && itemCount({ ...p, items: v }) <= MAX_ITEMS ? null : `2에서 ${MAX_ITEMS} 사이의 정수를 입력하십시오.`),
    });
    if (typeof n === 'number') apply({ ...p, items: n, spacing: pathSpacingOf({ ...p, items: n }, ap.path) });
    return;
  }
  if (k === 'A') return apply({ ...p, align: await askYesNo(ctx, '경로를 따라 배열된 항목을 정렬하시겠습니까?', p.align) });
  if (k === 'Z') {
    const z = await askYesNo(ctx, '항목의 Z 방향을 유지하시겠습니까?', p.zDir);
    if (z !== p.zDir) ctx.print('평면 경로에서는 Z 방향 유지와 관계없이 항목이 같은 자리에 놓입니다(값만 바꿉니다).');
    return apply({ ...p, zDir: z });
  }
}

// ---------------------------------------------------------------------------
// Ctrl+클릭 항목 고르기 + Delete
// ---------------------------------------------------------------------------

const pending = new WeakMap<DocState, { array: string; key: string }>();

/** Ctrl+클릭한 점의 배열 항목을 고른다(배열이 아니면 false) */
export function pickArrayItem(app: App, handle: string, p: Pt): boolean {
  const st = app.active;
  if (!st) return false;
  const info = arrayOf(st, handle);
  if (!info) return false;
  const hit = itemAt(st.doc, info, p, 4 * app.view.pixelSize());
  if (!hit) return false;
  pending.set(st, { array: handle, key: hit.key });
  app.refreshSelectionOverlay();
  const pk = app.picker();
  if (pk) {
    const g = arrayPreview(app, info, { ...info.state, removed: new Set(expectedItems(st.doc, info.ins, info.def, info.state.params).map((x) => x.key).filter((k) => k !== hit.key)) });
    app.view.overlay.selection.push(...g);
    app.view.requestOverlay();
  }
  app.cmd.print(`배열 항목(${itemLabel(info.state.params.kind, hit.key)})을 골랐습니다. Delete 키를 누르면 이 항목만 지웁니다.`);
  return true;
}

/** 고른 배열 항목을 지운다 */
export function erasePickedItem(app: App): boolean {
  const st = app.active;
  const pk = st ? pending.get(st) : undefined;
  if (!st || !pk) return false;
  pending.delete(st);
  const info = arrayOf(st, pk.array);
  if (!info || !unlockedOnly(app, [pk.array]).length) return false;
  const next = cloneState(info.state);
  next.removed.add(pk.key);
  if (applyArrayState(app, null, info, next, 'ERASE')) app.cmd.print('배열 항목 1개를 지웠습니다. ARRAYEDIT의 재설정(RES)으로 되돌릴 수 있습니다.');
  return true;
}

function installCtrlClick(app: App): void {
  if (typeof window === 'undefined' || !app.view?.el) return;
  let last: { p: Pt; ctrl: boolean } | null = null;
  app.view.el.addEventListener(
    'pointerup',
    (ev) => {
      const r = app.view.el.getBoundingClientRect();
      last = { p: app.view.screenToWorld(ev.clientX - r.left, ev.clientY - r.top), ctrl: ev.ctrlKey || ev.metaKey };
    },
    { capture: true },
  );
  type Hook = ((h: string) => boolean) & { __assocArray?: boolean };
  const wrap = () => {
    const prev = app.linkClick as Hook | null;
    if (prev?.__assocArray) return;
    const fn: Hook = (h) => {
      if (last?.ctrl && pickArrayItem(app, h, last.p)) return true;
      return prev ? prev(h) : false;
    };
    fn.__assocArray = true;
    app.linkClick = fn;
  };
  wrap();
  // 다른 모듈(하이퍼링크)이 나중에 고리를 달면 그 위에 다시 단다
  window.setTimeout(wrap, 0);
  window.addEventListener(
    'keydown',
    (ev) => {
      const st = app.active;
      if (!st || !pending.has(st)) return;
      if (ev.key === 'Escape') {
        pending.delete(st);
        return;
      }
      if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
      const t = ev.target as HTMLElement | null;
      if (app.busyCommand || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      erasePickedItem(app);
    },
    { capture: true },
  );
}

// ---------------------------------------------------------------------------
// 경로 따라가기: 경로 곡선을 고치면(같은 명령 취소 묶음) 경로 배열을 새 경로로 다시 계산한다
// ---------------------------------------------------------------------------

const followHooked = new WeakSet<EditSession>();

/** 편집 세션의 commit을 감싼다(주석 축척의 beforeCommit 고리와 겹치지 않게 commit 뒤에 따로 커밋) */
function hookFollow(st: DocState): void {
  const s = st.session;
  if (!s || followHooked.has(s)) return;
  followHooked.add(s);
  const commit = s.commit.bind(s);
  let busy = false;
  s.commit = (tx: Transaction) => {
    commit(tx);
    if (busy) return;
    const changed = new Set<string>();
    for (const op of tx.ops) if (op.kind === 'modify' && op.after.type !== 'INSERT') changed.add(op.after.handle);
    if (!changed.size) return;
    busy = true;
    try {
      const ops = followPathOps(buildEnv(st), changed);
      if (ops.length) commit({ label: tx.label, ops, group: tx.group, rebuildNow: true });
    } catch {
      /* 따라가지 못하면 배열은 그대로(ARRAYEDIT에서 다시 계산) */
    } finally {
      busy = false;
    }
  };
}

function installArrayFollow(app: App): void {
  const ed = app.edits as (typeof app.edits & { __arrayFollow?: boolean }) | undefined;
  if (!ed || ed.__arrayFollow) return;
  ed.__arrayFollow = true;
  const attach = ed.attach.bind(ed);
  ed.attach = (st: DocState) => {
    attach(st);
    hookFollow(st);
  };
  for (const st of app.docs) hookFollow(st);
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

export function registerAssocArrayCommands(app: App): void {
  installCtrlClick(app);
  installArrayGrips(app);
  installArrayFollow(app);

  app.register({
    name: 'ARRAYEDIT',
    title: '배열 편집',
    async run(ctx) {
      const st = app.active!;
      let handle: string | null = null;
      const sel = [...st.selection];
      if (sel.length === 1 && arrayOf(st, sel[0]!)) handle = sel[0]!;
      while (!handle) {
        const r = await ctx.getEntity('배열 선택:');
        if (!('handle' in r)) return;
        if (arrayOf(st, r.handle)) handle = r.handle;
        else {
          const e = st.doc.entityIndex.get(r.handle);
          ctx.print(looksLikeArray(st.doc, e) ? '이 배열의 매개변수를 해석할 수 없어 편집할 수 없습니다(항목이 기록과 맞지 않습니다).' : '선택한 객체는 연관 배열이 아닙니다.', 'err');
        }
      }
      if (!unlockedOnly(app, [handle]).length) return;
      app.setSelection([]);
      let noted = false;
      for (;;) {
        const info = arrayOf(st, handle);
        if (!info) {
          ctx.print('배열을 다시 읽을 수 없습니다.', 'err');
          return;
        }
        if (!noted) {
          noted = true;
          const p = info.state.params;
          ctx.print(`유형 = ${KIND_LABEL[p.kind]}  연관 = 예`);
          if (info.origin === 'infer') ctx.print('이 배열은 DWG의 AutoCAD 연관 배열입니다. 매개변수는 항목 배치에서 짐작했고, 고치면 이 앱 기록으로 저장합니다(DWG의 AutoCAD 배열 기록은 고쳐 쓰지 못합니다).');
          if (info.stale) {
            ctx.print('경로 곡선이 바뀌어 배열을 새 경로로 다시 계산합니다.');
            applyArrayState(app, ctx, info, info.state, 'ARRAYEDIT');
            continue;
          }
        }
        const kws = KW[info.state.params.kind];
        const r = await ctx.getPoint(`옵션 입력 [${kws.map((x) => `${x.label}(${x.key})`).join('/')}] <종료>:`, { keywords: kws });
        if ('enter' in r || ('keyword' in r && r.keyword === 'X')) break;
        if (!('keyword' in r)) continue;
        if ((await editOption(app, ctx, handle, info, r.keyword)) === 'exit') return;
      }
      app.refreshSelectionOverlay();
    },
  });

  app.register({
    name: 'ARRAYCLOSE',
    title: '배열 편집 닫기',
    async run(ctx, arg) {
      const a = arg?.trim().toUpperCase();
      await closeSourceEdit(app, ctx, a === 'S' ? true : a === 'D' ? false : null);
    },
  });

  app.register({
    name: 'ARRAYASSOCIATIVITY',
    title: '연관 배열 기본값',
    async run(ctx, arg) {
      let t = arg?.trim();
      if (!t) {
        const r = await ctx.getPoint(`ARRAYASSOCIATIVITY에 대한 새 값 입력 <${arrayAssociativity() ? 1 : 0}>:`, { preferNumber: true, allowText: true });
        if (!('text' in r)) return;
        t = r.text.trim();
      }
      if (t !== '0' && t !== '1') {
        ctx.print('0 또는 1이 필요합니다.', 'err');
        return;
      }
      setArrayAssociativity(t === '1');
    },
  });
}
