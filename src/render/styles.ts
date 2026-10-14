/**
 * 표시 스타일 표. 정점마다 색·선가중치를 넣지 않고 스타일 번호만 넣는다.
 * 도면층 색·켜기/끄기·배경색이 바뀌면 다시 만들지 않고 이 표만 다시 계산한다.
 */
import type { CadDocument } from '../core/model';
import { aciToRgb, nearestAci } from '../core/color';
import { type CtbPen, type CtbTable, penColor } from './ctb';

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
  /** 이름 있는 플롯 스타일(대문자). 없으면 도면층의 플롯 스타일 */
  plotStyle?: string;
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
  /** 도면층의 이름 있는 플롯 스타일(대문자, STB 출력용) */
  plotStyleName?: string;
}

/** 이름 있는 플롯 스타일 핸들 → 이름(대문자): ACAD_PLOTSTYLENAME 사전의 항목 */
export function plotStyleNames(doc: CadDocument): Map<string, string> {
  const out = new Map<string, string>();
  const root = doc.rootDictionary ? doc.objects.get(doc.rootDictionary) : undefined;
  const dh = root && 'entries' in root ? (root as { entries: Map<string, string> }).entries.get('ACAD_PLOTSTYLENAME') : undefined;
  const d = dh ? doc.objects.get(dh) : undefined;
  if (d && 'entries' in d) for (const [n, h] of (d as { entries: Map<string, string> }).entries) out.set(h, n.toUpperCase());
  return out;
}

export class StyleTable {
  readonly specs: StyleSpec[] = [];
  private readonly index = new Map<string, number>();

  intern(s: StyleSpec): number {
    const key = `${s.colorKind}:${s.color}|${s.layer}|${s.freezeLayers.join(',')}|${s.widthKind}:${s.width}|${s.alpha}|${s.flags}|${s.plotStyle ?? ''}`;
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
  const psn = plotStyleNames(doc);
  for (const [key, l] of doc.layers) {
    indexOf.set(key, states.length);
    states.push({
      plotStyleName: l.plotStyle ? psn.get(l.plotStyle) : undefined,
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
  /** 출력(플롯): 플롯하지 않는 도면층과 Defpoints를 빼고, 플롯 스타일로 색을 바꾼다(CTB가 있으면 ACI별 펜) */
  plot?: { style: PlotStyle; ctb?: CtbTable };
}

/** 플롯 스타일: 색 그대로, 흑백(monochrome), 회색조(grayscale) */
export type PlotStyle = 'color' | 'mono' | 'gray';

/** 플롯 스타일을 적용한 색 */
export function plotColor(rgb: number, style: PlotStyle): number {
  if (style === 'color') return rgb;
  if (style === 'mono') return 0;
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  // 밝은 색도 흰 종이에서 보이도록 회색 값을 조금 어둡게
  const y = Math.round(Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b) * 0.85);
  return (y << 16) | (y << 8) | y;
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
    let pen: CtbPen | undefined;
    const named = opt.plot?.ctb?.named;
    if (named) {
      // STB: 객체의 플롯 스타일, 없으면 도면층의 것, 그것도 없으면 Normal
      const n = s.plotStyle ?? L?.plotStyleName ?? 'NORMAL';
      pen = named.find(([k]) => k === n)?.[1];
      if (pen) rgb = penColor(pen, rgb);
    } else if (opt.plot?.ctb) {
      // 객체의 ACI(도면층별이면 도면층 색, 트루컬러면 가장 가까운 ACI)로 펜을 고른다
      let aci = 7;
      if (s.colorKind === ColorKind.Aci) aci = s.color;
      else if (s.colorKind === ColorKind.Layer) {
        const cl = layers[s.color];
        aci = cl ? (cl.hasRgb ? nearestAci(cl.rgb) : cl.aci) : 7;
      } else if (s.colorKind === ColorKind.Rgb) aci = nearestAci(s.color);
      pen = opt.plot.ctb.pens[Math.max(1, Math.min(255, Math.abs(aci) || 7)) - 1];
      if (pen) rgb = penColor(pen, rgb);
    } else if (opt.plot) rgb = plotColor(rgb, opt.plot.style);
    let visible = L ? L.on && !L.frozen : true;
    if (opt.plot && L && (L.plot === false || L.name.toUpperCase() === 'DEFPOINTS')) visible = false;
    if (opt.plot && s.flags & STYLE_FLAG_NO_PLOT) visible = false;
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
    if (pen?.lineweight != null) lw = pen.lineweight * 100;
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
