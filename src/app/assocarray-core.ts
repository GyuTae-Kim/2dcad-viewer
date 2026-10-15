/**
 * 연관 배열 명령의 공용 도우미(앱 쪽): 읽기, 다시 계산해 적용하기, 항목 고르기, 미리보기, 값 묻기.
 * 순수 계산은 src/edit/assocarray.
 */
import type { CadDocument, InsertEntity } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { insertAffine } from '../edit/dynblock/build';
import { allocBlockName } from '../edit/geom/types';
import { boundsOf } from '../edit/geom/query';
import { type Affine, affApply, affMul } from '../edit/geom/math';
import { calculate } from '../edit/util/calc';
import { type BuildEnv, type RegenOptions, regenerateOps } from '../edit/assocarray/build';
import { type ArrayInfo, expectedItems, itemMatrix, readArray } from '../edit/assocarray/read';
import type { ArrayItem, ArrayState } from '../edit/assocarray/types';
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import { Ghost } from './modify';
import type { OverlayGeom, Pt } from './view';

/** ARRAYASSOCIATIVITY(이 브라우저에 남긴다, AutoCAD는 레지스트리). 기본 1 */
const ASSOC_KEY = 'opencad.arrayassociativity';
/** 저장소를 못 쓸 때(시험·개인 창)의 값 */
let assocMemo: boolean | null = null;

export function arrayAssociativity(): boolean {
  if (assocMemo !== null) return assocMemo;
  try {
    return (globalThis.localStorage?.getItem(ASSOC_KEY) ?? '1') !== '0';
  } catch {
    return true;
  }
}

export function setArrayAssociativity(on: boolean): void {
  assocMemo = on;
  try {
    globalThis.localStorage?.setItem(ASSOC_KEY, on ? '1' : '0');
  } catch {
    /* 저장소를 못 쓰면 이번만 */
  }
}

export function buildEnv(st: DocState): BuildEnv {
  return { doc: st.doc, newHandle: () => st.session.newHandle(), newBlockName: () => allocBlockName(st.doc, '*U') };
}

/** 핸들의 연관 배열(아니면 null) */
export function arrayOf(st: DocState, handle: string): ArrayInfo | null {
  return readArray(st.doc, st.doc.entityIndex.get(handle));
}

/** 배열 블록 좌표 → 도면 좌표 */
export function arrayToWorld(info: ArrayInfo): Affine {
  return insertAffine(info.def, info.ins);
}

/** 새 상태로 배열을 다시 계산해 적용한다(같은 명령 묶음). 오류면 문구를 찍고 false */
export function applyArrayState(app: App, ctx: CommandContext | null, info: ArrayInfo, next: ArrayState, label: string, opt: RegenOptions = {}): InsertEntity | null {
  const st = app.active!;
  const r = regenerateOps(buildEnv(st), info, next, opt);
  if ('error' in r) {
    (ctx ? ctx.print.bind(ctx) : app.cmd.print.bind(app.cmd))(r.error, 'err');
    return null;
  }
  st.session.commit({ label, ops: r.ops, group: ctx?.group, rebuildNow: true });
  app.refreshSelectionOverlay();
  return r.insert;
}

/** 블록 내용의 범위(블록 좌표) */
function blockBox(doc: CadDocument, name: string, cache: Map<string, [number, number, number, number] | null>): [number, number, number, number] | null {
  const k = tableKey(name);
  if (cache.has(k)) return cache.get(k)!;
  const def = doc.blocks.get(k);
  let r: [number, number, number, number] | null = null;
  if (def) {
    const b = boundsOf(def.entities, doc);
    if (b && Number.isFinite(b.minX)) r = [b.minX, b.minY, b.maxX, b.maxY];
  }
  cache.set(k, r);
  return r;
}

export interface ItemHit {
  key: string;
  item: ArrayItem;
  /** 원본 블록 좌표 → 도면 좌표(대체 항목이면 대체 블록 좌표 → 도면) */
  toWorld: Affine;
  /** 이 항목을 그리는 블록 이름 */
  block: string;
}

/** 도면 점이 가리키는 항목(범위 상자 안, 여럿이면 가운데가 가장 가까운 것) */
export function itemAt(doc: CadDocument, info: ArrayInfo, p: Pt, tol = 0): ItemHit | null {
  const W = arrayToWorld(info);
  const cache = new Map<string, [number, number, number, number] | null>();
  let best: ItemHit | null = null;
  let bd = Infinity;
  for (const it of expectedItems(doc, info.ins, info.def, info.state.params)) {
    if (info.state.removed.has(it.key)) continue;
    const rep = info.state.replaced.get(it.key);
    const block = rep ?? info.state.source;
    const box = blockBox(doc, block, cache);
    const M = affMul(W, itemMatrix(it, !!rep, info.state.params.base));
    const corners = box
      ? [affApply(M, { x: box[0], y: box[1] }), affApply(M, { x: box[2], y: box[1] }), affApply(M, { x: box[2], y: box[3] }), affApply(M, { x: box[0], y: box[3] })]
      : [affApply(M, info.state.params.base)];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const minX = Math.min(...xs) - tol;
    const maxX = Math.max(...xs) + tol;
    const minY = Math.min(...ys) - tol;
    const maxY = Math.max(...ys) + tol;
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
    const d = Math.hypot(p.x - (minX + maxX) / 2, p.y - (minY + maxY) / 2);
    if (d < bd) {
      bd = d;
      best = { key: it.key, item: it, toWorld: M, block };
    }
  }
  return best;
}

/** 블록 하나의 형상(블록 좌표) — 미리보기용 */
function blockGhost(app: App, doc: CadDocument, name: string, cache: Map<string, Ghost>): Ghost | null {
  const k = tableKey(name);
  const have = cache.get(k);
  if (have) return have;
  const pk = app.picker();
  const def = doc.blocks.get(k);
  if (!pk || !def) return null;
  const probe: InsertEntity = {
    ...entityDefaults(),
    type: 'INSERT',
    handle: '',
    block: def.name,
    insert: { ...def.basePoint },
    scale: { x: 1, y: 1, z: 1 },
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
  const g = Ghost.of(pk.geometryOf([probe]));
  cache.set(k, g);
  return g;
}

/** 상태대로 그린 배열의 미리보기(항목 400개까지) */
export function arrayPreview(app: App, info: ArrayInfo, next: ArrayState, ins: InsertEntity = info.ins, cache = new Map<string, Ghost>()): OverlayGeom[] {
  const st = app.active!;
  const doc = st.doc;
  const W = insertAffine(info.def, ins);
  const out: OverlayGeom[] = [];
  let n = 0;
  for (const it of expectedItems(doc, ins, info.def, next.params)) {
    if (next.removed.has(it.key)) continue;
    if (++n > 400) break;
    const rep = next.replaced.get(it.key);
    const g = blockGhost(app, doc, rep ?? next.source, cache);
    if (g) out.push(...g.at(affMul(W, itemMatrix(it, !!rep, next.params.base))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 값 묻기(숫자·표현식·두 점 거리)
// ---------------------------------------------------------------------------

const KW_E: Keyword = { key: 'E', label: '표현식' };

/** 숫자 또는 CAL 식 */
export function evalNumber(ctx: CommandContext, text: string): number | null {
  const t = text.trim();
  const n = Number(t);
  if (t && Number.isFinite(n)) return n;
  try {
    const v = calculate(t);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    ctx.print('식의 결과가 숫자가 아닙니다.', 'err');
  } catch (e) {
    ctx.print(`잘못된 식입니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
  return null;
}

/**
 * 값 하나 묻기. Enter = def(null이면 그대로 null), 점 = base(없으면 두 번째 점)까지 거리, E = 표현식.
 * 다른 키워드는 { keyword } 로 돌려준다. angle이면 도 단위로 입력받아 라디안으로 돌려준다.
 */
export async function askNumber(
  ctx: CommandContext,
  prompt: string,
  def: number,
  opt: { keywords?: Keyword[]; base?: Pt | null; check?: (v: number) => string | null; integer?: boolean; angle?: boolean; exprKey?: string } = {},
): Promise<number | { keyword: string } | null> {
  const ek: Keyword = opt.exprKey ? { key: opt.exprKey, label: '표현식' } : KW_E;
  const keywords = [...(opt.keywords ?? []), ek];
  for (;;) {
    const r = await ctx.getPoint(prompt, { preferNumber: true, keywords, base: opt.base ?? null });
    let v: number | null = null;
    if ('enter' in r) return def;
    if ('keyword' in r && r.keyword !== ek.key) return { keyword: r.keyword };
    if ('keyword' in r) {
      const e = await ctx.getPoint('표현식 입력:', { allowText: true });
      if (!('text' in e)) continue;
      v = evalNumber(ctx, e.text);
      if (v !== null && opt.angle) v = (v * Math.PI) / 180;
    } else if ('text' in r) {
      v = evalNumber(ctx, r.text);
      if (v !== null && opt.angle) v = (v * Math.PI) / 180;
    } else if ('point' in r) {
      let from = opt.base ?? null;
      if (!from) {
        const r2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
        if (!('point' in r2)) continue;
        from = r2.point;
      }
      v = opt.angle ? Math.atan2(r.point.y - from.y, r.point.x - from.x) : Math.hypot(r.point.x - from.x, r.point.y - from.y);
    }
    if (v === null) continue;
    if (opt.integer) v = Math.round(v);
    const bad = opt.check?.(v) ?? null;
    if (bad) {
      ctx.print(bad, 'err');
      continue;
    }
    return v;
  }
}

export async function askYesNo(ctx: CommandContext, prompt: string, def: boolean): Promise<boolean> {
  const r = await ctx.getPoint(`${prompt} [예(Y)/아니오(N)] <${def ? '예' : '아니오'}>:`, {
    keywords: [
      { key: 'Y', label: '예' },
      { key: 'N', label: '아니오' },
    ],
  });
  if ('keyword' in r) return r.keyword === 'Y';
  return def;
}

/** 각도(라디안) → 도 문자열 */
export const degText = (a: number): string => {
  const d = (a * 180) / Math.PI;
  return String(+d.toFixed(4));
};
