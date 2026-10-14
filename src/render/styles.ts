/**
 * 표시 스타일 표. 정점마다 색·선가중치를 넣지 않고 스타일 번호만 넣는다.
 * 도면층 색·켜기/끄기·배경색이 바뀌면 다시 만들지 않고 이 표만 다시 계산한다.
 */
import type { CadDocument } from '../core/model';
import { aciToRgb } from '../core/color';

export const enum ColorKind {
  /** 고정 RGB */
  Rgb = 0,
  /** 고정 ACI(7은 배경에 따라 바뀜) */
  Aci = 1,
  /** 도면층 색 */
  Layer = 2,
  /** 배경색(WIPEOUT 등) */
  Background = 3,
}

export const enum WidthKind {
  Value = 0,
  Layer = 1,
  Default = 2,
}

export interface StyleSpec {
  colorKind: ColorKind;
  /** Rgb: 0xRRGGBB, Aci: 번호, Layer: 도면층 번호 */
  color: number;
  /** 보이기를 정하는 도면층(끄기·동결) */
  layer: number;
  /** 동결 여부만 보는 바깥 블록 참조의 도면층들 */
  freezeLayers: number[];
  widthKind: WidthKind;
  /** Value: 1/100 mm, Layer: 도면층 번호 */
  width: number;
  /** 0..255, -1 = 도면층 투명도 */
  alpha: number;
  /** 강조·선택 등 */
  flags: number;
}

export const STYLE_FLAG_NO_PLOT = 1;
export const STYLE_FLAG_TEXT = 2;
/** 숨김 스타일(편집으로 지운·바꾼 객체의 옛 그림). 스타일 표의 0번이다 */
export const STYLE_FLAG_HIDDEN = 4;
export const HIDDEN_STYLE = 0;

export function hiddenStyleSpec(): StyleSpec {
  return { colorKind: ColorKind.Rgb, color: 0, layer: -1, freezeLayers: [], widthKind: WidthKind.Value, width: 0, alpha: 255, flags: STYLE_FLAG_HIDDEN };
}

export interface LayerState {
  name: string;
  rgb: number;
  aci: number;
  hasRgb: boolean;
  on: boolean;
  frozen: boolean;
  lineweight: number;
  transparency: number;
  plot: boolean;
}

export class StyleTable {
  readonly specs: StyleSpec[] = [];
  private readonly index = new Map<string, number>();

  intern(s: StyleSpec): number {
    const key = `${s.colorKind}:${s.color}|${s.layer}|${s.freezeLayers.join(',')}|${s.widthKind}:${s.width}|${s.alpha}|${s.flags}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.specs.length;
      this.specs.push({ ...s, freezeLayers: [...s.freezeLayers] });
      this.index.set(key, i);
    }
    return i;
  }

  get size(): number {
    return this.specs.length;
  }

  /** 스타일이 불투명인지(만들 때 패스를 나눈다) */
  isTransparent(i: number, layers: readonly LayerState[]): boolean {
    const s = this.specs[i]!;
    const a = s.alpha < 0 ? (layers[s.layer]?.transparency ?? 255) : s.alpha;
    return a < 255;
  }
}

export function layerStates(doc: CadDocument): { states: LayerState[]; indexOf: Map<string, number> } {
  const states: LayerState[] = [];
  const indexOf = new Map<string, number>();
  for (const [key, l] of doc.layers) {
    indexOf.set(key, states.length);
    states.push({
      name: l.name,
      rgb: l.color.rgb ?? 0,
      aci: l.color.aci,
      hasRgb: l.color.rgb !== undefined,
      on: !l.off,
      frozen: l.frozen,
      lineweight: l.lineweight,
      transparency: l.transparency,
      plot: l.plot,
    });
  }
  return { states, indexOf };
}

export interface ResolveOptions {
  darkBackground: boolean;
  backgroundRgb: number;
  /** 선가중치 표시(LWDISPLAY) */
  showLineweight: boolean;
  /** 선가중치 기본값(1/100 mm) */
  defaultLineweight: number;
  /** 뷰포트별로 동결한 도면층 번호 */
  viewportFrozen?: Set<number>;
}

/**
 * 스타일 표 → GPU 표(스타일마다 RGBA 4개 + [선가중치 mm, 보이기, 0, 0] 4개)
 */
export function resolveStyles(table: StyleTable, layers: readonly LayerState[], opt: ResolveOptions): Float32Array {
  const out = new Float32Array(Math.max(1, table.size) * 8);
  for (let i = 0; i < table.size; i++) {
    const s = table.specs[i]!;
    const L = layers[s.layer];
    let rgb: number;
    switch (s.colorKind) {
      case ColorKind.Rgb:
        rgb = s.color;
        break;
      case ColorKind.Aci:
        rgb = aciToRgb(s.color, opt.darkBackground);
        break;
      case ColorKind.Layer: {
        const cl = layers[s.color];
        rgb = cl ? (cl.hasRgb ? cl.rgb : aciToRgb(cl.aci, opt.darkBackground)) : aciToRgb(7, opt.darkBackground);
        break;
      }
      default:
        rgb = opt.backgroundRgb;
    }
    let visible = L ? L.on && !L.frozen : true;
    if (visible && opt.viewportFrozen?.has(s.layer)) visible = false;
    if (visible)
      for (const f of s.freezeLayers) {
        if (layers[f]?.frozen || opt.viewportFrozen?.has(f)) {
          visible = false;
          break;
        }
      }
    let lw: number;
    if (s.widthKind === WidthKind.Value) lw = s.width;
    else if (s.widthKind === WidthKind.Layer) lw = layers[s.width]?.lineweight ?? -3;
    else lw = -3;
    if (lw < 0) lw = opt.defaultLineweight;
    if (s.flags & STYLE_FLAG_HIDDEN) visible = false;
    const alpha = s.alpha < 0 ? (L?.transparency ?? 255) : s.alpha;
    const o = i * 8;
    out[o] = ((rgb >> 16) & 255) / 255;
    out[o + 1] = ((rgb >> 8) & 255) / 255;
    out[o + 2] = (rgb & 255) / 255;
    out[o + 3] = alpha / 255;
    out[o + 4] = opt.showLineweight ? lw / 100 : 0;
    out[o + 5] = visible ? 1 : 0;
  }
  return out;
}
