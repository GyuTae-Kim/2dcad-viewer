/**
 * 주석 편집 명령(annot2*) 공통 도우미: 치수 미리보기, 각도 입력, 바뀐 객체 적용.
 */
import type { DimensionEntity, Entity } from '../core/model';
import { generateDimensionGeometry } from '../edit/dim';
import type { App, CommandContext } from './app';
import { commitResults } from './modify';
import type { OverlayGeom, Pt } from './view';

const RAD = Math.PI / 180;

/** 치수 그림 미리보기 */
export function dimGhost(app: App, make: (p: Pt) => DimensionEntity | DimensionEntity[] | null): (p: Pt) => OverlayGeom[] {
  return (p) => {
    const pk = app.picker();
    if (!pk) return [];
    try {
      const d = make(p);
      if (!d) return [];
      const list = Array.isArray(d) ? d : [d];
      const ents: Entity[] = [];
      for (const x of list) ents.push(...generateDimensionGeometry(app.active!.doc, x).entities);
      return [pk.geometryOf(ents)];
    } catch {
      return [];
    }
  };
}

/** 각도 입력(도). 숫자 또는 두 점. Enter면 def(없으면 null) */
export async function askAngle(ctx: CommandContext, prompt: string, def: number | null = null, base: Pt | null = null): Promise<number | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { preferNumber: true, base });
    if ('enter' in r) return def;
    if ('text' in r) {
      const n = Number(r.text);
      if (Number.isFinite(n)) return n * RAD;
      ctx.print('각도를 입력하십시오.', 'err');
      continue;
    }
    if ('point' in r) {
      const from = base ?? r.point;
      if (base) return Math.atan2(r.point.y - from.y, r.point.x - from.x);
      const r2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
      if ('point' in r2) return Math.atan2(r2.point.y - r.point.y, r2.point.x - r.point.x);
      return def;
    }
    return def;
  }
}

/** 바뀐 치수(지시선 등)를 한 번에 적용한다(치수 블록은 다시 만든다) */
export function commitChanged(app: App, ctx: CommandContext, list: Entity[], label: string): number {
  if (!list.length) return 0;
  commitResults(app, ctx, [{ replace: list }], label, { quiet: true });
  return list.length;
}
