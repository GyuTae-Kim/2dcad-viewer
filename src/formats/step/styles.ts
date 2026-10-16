/**
 * 색: STYLED_ITEM·OVER_RIDING_STYLED_ITEM → PRESENTATION_STYLE_ASSIGNMENT → SURFACE_STYLE_USAGE → SURFACE_SIDE_STYLE
 * → SURFACE_STYLE_FILL_AREA → FILL_AREA_STYLE → FILL_AREA_STYLE_COLOUR → COLOUR_RGB·DRAUGHTING_PRE_DEFINED_COLOUR,
 * 투명도는 SURFACE_STYLE_RENDERING_WITH_PROPERTIES → SURFACE_STYLE_TRANSPARENT.
 * 면 색이 없을 때 CURVE_STYLE 색은 쓰지 않는다(선 색).
 */
import type { Rgba } from '../../viewer3d/types';
import { num, refId, refList, text, type StepFile } from './part21';

const PREDEFINED: Record<string, [number, number, number]> = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  yellow: [1, 1, 0],
  magenta: [1, 0, 1],
  cyan: [0, 1, 1],
  black: [0, 0, 0],
  white: [1, 1, 1],
};

export interface StyleInfo {
  /** 대상 개체(면·껍질·입체·사상 항목 등) → 색 */
  colors: Map<number, Rgba>;
  /** 숨김(INVISIBILITY) 대상 */
  hidden: Set<number>;
}

export function readStyles(f: StepFile): StyleInfo {
  const colors = new Map<number, Rgba>();
  const hidden = new Set<number>();
  const colourCache = new Map<number, [number, number, number] | null>();
  const colour = (id: number): [number, number, number] | null => {
    const hit = colourCache.get(id);
    if (hit !== undefined) return hit;
    const e = f.get(id);
    let c: [number, number, number] | null = null;
    if (e) {
      if (e.type === 'COLOUR_RGB') {
        let r = num(e.args[1], 0);
        let g = num(e.args[2], 0);
        let b = num(e.args[3], 0);
        if (r > 1 || g > 1 || b > 1) {
          r /= 255;
          g /= 255;
          b /= 255;
        }
        c = [clamp01(r), clamp01(g), clamp01(b)];
      } else if (e.type === 'DRAUGHTING_PRE_DEFINED_COLOUR' || e.type === 'PRE_DEFINED_COLOUR') {
        c = PREDEFINED[text(e.args[0]).toLowerCase()] ?? null;
      }
    }
    colourCache.set(id, c);
    return c;
  };
  // 표현 양식 하나에서 면 색·투명도
  const surfaceStyle = (id: number, depth = 0): { rgb: [number, number, number] | null; alpha: number } => {
    const out = { rgb: null as [number, number, number] | null, alpha: 1 };
    if (depth > 8) return out;
    const e = f.get(id);
    if (!e) return out;
    const merge = (o: { rgb: [number, number, number] | null; alpha: number }) => {
      if (o.rgb && !out.rgb) out.rgb = o.rgb;
      if (o.alpha < 1) out.alpha = Math.min(out.alpha, o.alpha);
    };
    switch (e.type) {
      case 'PRESENTATION_STYLE_ASSIGNMENT':
      case 'PRESENTATION_STYLE_BY_CONTEXT':
        for (const s of refList(e.args[0])) merge(surfaceStyle(s, depth + 1));
        break;
      case 'SURFACE_STYLE_USAGE':
        merge(surfaceStyle(refId(e.args[1]), depth + 1));
        break;
      case 'SURFACE_SIDE_STYLE':
        for (const s of refList(e.args[1])) merge(surfaceStyle(s, depth + 1));
        break;
      case 'SURFACE_STYLE_FILL_AREA':
        merge(surfaceStyle(refId(e.args[0]), depth + 1));
        break;
      case 'FILL_AREA_STYLE':
        for (const s of refList(e.args[1])) merge(surfaceStyle(s, depth + 1));
        break;
      case 'FILL_AREA_STYLE_COLOUR':
        out.rgb = colour(refId(e.args[1]));
        break;
      case 'SURFACE_STYLE_RENDERING':
      case 'SURFACE_STYLE_RENDERING_WITH_PROPERTIES': {
        const c = colour(refId(e.args[1]));
        if (c) out.rgb = c;
        for (const pid of refList(e.args[2])) {
          const p = f.get(pid);
          if (p && p.type === 'SURFACE_STYLE_TRANSPARENT') out.alpha = clamp01(1 - num(p.args[0], 0));
        }
        break;
      }
      default:
        break;
    }
    return out;
  };
  const apply = (type: string) => {
    for (const id of f.idsOfType(type)) {
      const e = f.get(id);
      if (!e || e.parts) continue;
      const item = refId(e.args[2]);
      if (!item) continue;
      let rgb: [number, number, number] | null = null;
      let alpha = 1;
      for (const s of refList(e.args[1])) {
        const st = surfaceStyle(s);
        if (st.rgb && !rgb) rgb = st.rgb;
        alpha = Math.min(alpha, st.alpha);
      }
      if (rgb) colors.set(item, [rgb[0], rgb[1], rgb[2], alpha]);
      else if (alpha < 1) {
        const prev = colors.get(item);
        if (prev) colors.set(item, [prev[0], prev[1], prev[2], alpha]);
      }
    }
  };
  apply('STYLED_ITEM');
  apply('OVER_RIDING_STYLED_ITEM');
  apply('CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM');
  for (const id of f.idsOfType('INVISIBILITY')) {
    const e = f.get(id);
    if (!e) continue;
    for (const r of refList(e.args[0])) {
      // 숨긴 것이 양식 항목이면 그 대상
      const t = f.get(r);
      if (t && (t.type === 'STYLED_ITEM' || t.type === 'OVER_RIDING_STYLED_ITEM')) hidden.add(refId(t.args[2]));
      else hidden.add(r);
    }
  }
  return { colors, hidden };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
