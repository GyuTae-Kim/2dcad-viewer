/**
 * 수정 명령(2) 공통 도우미: 명령 기본값 기억, 예·아니오, 숫자 입력, 미리보기, 명령 안 단계 되돌리기.
 */
import type { CadDocument, Entity, LineEntity } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import { type EditResult, copyEntity, transformEntity } from '../edit/geom';
import type { Affine } from '../edit/geom/math';
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import { currentProps } from './draw';
import { unlockedOnly } from './layers';
import type { OverlayGeom, Pt } from './view';

/** 문서마다 기억하는 명령 기본값 */
const memo = new WeakMap<DocState, Record<string, unknown>>();
export function memOf(st: DocState): Record<string, unknown> {
  let m = memo.get(st);
  if (!m) memo.set(st, (m = {}));
  return m;
}

export function hnum(doc: CadDocument, name: string, def: number): number {
  const v = doc.header.get(name);
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

export const fmtLen = (app: App, v: number): string => formatLength(v, app.active!.units);

export async function yesNo(ctx: CommandContext, prompt: string, def: boolean): Promise<boolean> {
  const r = await ctx.getPoint(`${prompt} [예(Y)/아니오(N)] <${def ? '예' : '아니오'}>:`, { keywords: [{ key: 'Y', label: '예' }, { key: 'N', label: '아니오' }] });
  if ('keyword' in r) return r.keyword === 'Y';
  return def;
}

/** 키워드 하나를 고르게 한다(Enter = 기본값) */
export async function choose(ctx: CommandContext, prompt: string, keywords: Keyword[], def: string): Promise<string> {
  const r = await ctx.getPoint(prompt, { keywords });
  if ('keyword' in r) return r.keyword;
  return def;
}

/**
 * 숫자 입력. 점을 찍으면 base에서의 거리(base가 없으면 두 점 사이 거리).
 * 키워드를 고르면 {keyword}, 조건에 맞지 않으면 다시 묻는다.
 */
export async function askNumber(
  ctx: CommandContext,
  prompt: string,
  def: number | null,
  opt: { min?: number; positive?: boolean; int?: boolean; max?: number; base?: Pt | null; keywords?: Keyword[]; distance?: boolean; text?: (v: number) => string } = {},
): Promise<number | { keyword: string }> {
  const show = (v: number) => (opt.text ? opt.text(v) : opt.int ? String(v) : formatLength(v, ctx.app.active!.units));
  for (;;) {
    const r = await ctx.getPoint(def !== null ? `${prompt} <${show(def)}>:` : `${prompt}:`, { preferNumber: true, base: opt.base ?? null, keywords: opt.keywords });
    let v: number | null = null;
    if ('enter' in r) {
      if (def !== null) return def;
    } else if ('keyword' in r) return { keyword: r.keyword };
    else if ('text' in r) {
      const x = parseFloat(r.text);
      if (Number.isFinite(x)) v = x;
    } else if ('point' in r && opt.distance !== false) {
      if (opt.base) v = Math.hypot(r.point.x - opt.base.x, r.point.y - opt.base.y);
      else {
        const r2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
        if ('point' in r2) v = Math.hypot(r2.point.x - r.point.x, r2.point.y - r.point.y);
      }
    }
    if (v !== null) {
      if (opt.int) v = Math.round(v);
      const okMin = opt.min === undefined || v >= opt.min;
      const okMax = opt.max === undefined || v <= opt.max;
      const okPos = !opt.positive || v > 0;
      if (okMin && okMax && okPos) return v;
    }
    if (opt.int) ctx.print(`${opt.min ?? 0}에서 ${opt.max ?? 32767} 사이의 정수를 입력하십시오.`, 'err');
    else if (opt.positive) ctx.print('0보다 큰 값을 입력하십시오.', 'err');
    else ctx.print('숫자를 입력하십시오.', 'err');
  }
}

/** 편집할 수 있는(잠기지 않은) 객체 고르기 */
export async function selectEditable(app: App, ctx: CommandContext, prompt?: string): Promise<string[]> {
  const hs = unlockedOnly(app, await ctx.getSelection(prompt));
  return hs.filter((h) => app.active!.doc.entityIndex.has(h));
}

/** 문서에 아직 없는 객체의 미리보기 형상 */
export function previewOf(app: App, list: (Entity | null | undefined)[]): OverlayGeom[] {
  const pk = app.picker();
  const ents = list.filter((e): e is Entity => !!e);
  if (!pk || !ents.length) return [];
  try {
    return [pk.geometryOf(ents)];
  } catch {
    return [];
  }
}

export function resultPreview(app: App, r: EditResult | null | undefined): OverlayGeom[] {
  if (!r) return [];
  return previewOf(app, [...(r.replace ?? []), ...(r.add ?? [])]);
}

/** 현재 특성의 틀 객체(새 객체의 특성을 이을 때) */
export function propsTemplate(app: App): LineEntity {
  return { type: 'LINE', ...currentProps(app), handle: '', start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } };
}

/** 변환(MIRRTEXT·MIRRHATCH 반영) */
export function transformList(st: DocState, hs: readonly string[], m: Affine, copy: boolean): EditResult[] {
  const doc = st.doc;
  const mirrorText = hnum(doc, '$MIRRTEXT', 0) === 1;
  const mirrorHatch = hnum(doc, '$MIRRHATCH', 0) === 1;
  const out: EditResult[] = [];
  for (const h of hs) {
    const e = doc.entityIndex.get(h);
    if (!e) continue;
    out.push(copy ? copyEntity(e, m, doc, { mirrorText, mirrorHatch }) : transformEntity(e, m, doc, { mirrorText, mirrorHatch }));
  }
  return out;
}

/** 명령 안에서 직전 단계 하나를 되돌린다 */
export function undoStep(app: App, ctx: CommandContext, steps: number[]): boolean {
  const n = steps.pop();
  if (n === undefined) {
    ctx.print('명령 취소할 것이 없습니다.');
    return false;
  }
  app.active!.session.undoLastStep(ctx.group, n);
  return true;
}

/** 지금 공간에서 보이는 객체(경계 찾기 후보) */
export function visibleEntities(st: DocState): Entity[] {
  const block = st.doc.blocks.get(st.space);
  if (!block) return [];
  return block.entities.filter((e) => {
    const L = st.doc.layers.get(tableKey(e.layer));
    return !e.invisible && !(L && (L.off || L.frozen));
  });
}
