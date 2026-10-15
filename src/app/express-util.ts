/**
 * Express Tools 명령 공통 도우미: 문자열·각도 입력, 보이는 객체, 대화상자가 닫힐 때까지 기다리기.
 */
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import type { Pt } from './view';

/** 문자열 입력(Enter = def, 키워드면 {keyword}). 좌표처럼 생긴 입력도 그대로 문자열로 돌려준다 */
export async function askString(ctx: CommandContext, prompt: string, def = '', keywords: Keyword[] = []): Promise<string | { keyword: string }> {
  const r = await ctx.getPoint(prompt, { allowText: true, keywords });
  if ('enter' in r) return def;
  if ('keyword' in r) return { keyword: r.keyword };
  if ('text' in r) return r.text;
  // 점으로 읽힌 입력(예: "1,2")은 좌표 글로 되돌린다
  return `${+r.point.x.toFixed(10)},${+r.point.y.toFixed(10)}`;
}

/** 각도 입력(도, 숫자 또는 두 점). Enter = null(기본값을 쓰라는 뜻) */
export async function askAngle(ctx: CommandContext, prompt: string, keywords: Keyword[] = []): Promise<number | null | { keyword: string }> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { preferNumber: true, allowText: true, keywords });
    if ('enter' in r) return null;
    if ('keyword' in r) return { keyword: r.keyword };
    if ('text' in r) {
      const v = Number(r.text);
      if (Number.isFinite(v)) return (v * Math.PI) / 180;
      ctx.print('각도(도)를 입력하거나 두 점을 지정하십시오.', 'err');
      continue;
    }
    const p = r.point;
    const q = await ctx.getPoint('두 번째 점 지정:', { base: p });
    if (!('point' in q)) return null;
    return Math.atan2(q.point.y - p.y, q.point.x - p.x);
  }
}

/** 도면층이 보이는 객체인지(켜짐·동결 안 됨·객체 숨김 아님) */
export function isVisible(st: DocState, e: Entity): boolean {
  if (e.invisible) return false;
  const l = st.layers.get(tableKey(e.layer));
  return !l || (l.on && !l.frozen);
}

/** 지금 공간의 보이는 객체 */
export function visibleInSpace(st: DocState): Entity[] {
  return (st.doc.blocks.get(st.space)?.entities ?? []).filter((e) => isVisible(st, e));
}

/** 점에서 고르는 허용 거리(도면 단위) */
export function pickTolerance(app: App): number {
  const px = app.view.pixelSize?.() ?? 0;
  return Math.max((app.view.overlay.pickbox || 5) * px * 1.5, 1e-9);
}

/** 대화상자 뒤판이 문서에서 빠지면(닫히면) 끝나는 약속 */
export function whenClosed(back: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    if (!document.body.contains(back)) return resolve();
    const obs = new MutationObserver(() => {
      if (!document.body.contains(back)) {
        obs.disconnect();
        resolve();
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

/** 각도(라디안) → 도 표기 */
export function degText(a: number): string {
  let d = (a * 180) / Math.PI;
  d = ((d % 360) + 360) % 360;
  if (360 - d < 1e-9) d = 0;
  return String(+d.toFixed(4));
}

/** 숫자 표기(불필요한 0 없이) */
export function numText(v: number, digits = 4): string {
  return String(+v.toFixed(digits));
}

export type { Pt };
