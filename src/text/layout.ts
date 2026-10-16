/**
 * 문자 배치: TEXT·ATTRIB 한 줄 문자와 MTEXT 여러 줄 문자를 글리프 위치로 바꾼다.
 * 결과 좌표는 문자 로컬 좌표(TEXT: 정렬점 기준 OCS, MTEXT: 삽입점 기준·문자 방향 X축)이다.
 */
import type { CadColor, TextStyle } from '../core/model';
import type { FontFace, GlyphGeom, OutlineLibrary } from './fonts';
import { latinFamilyOf, strokeFace } from './fonts';
import type { ShxLibrary } from './shx';
import { type Paragraph, type RunStyle, TOGGLE_OVERLINE, TOGGLE_STRIKE, TOGGLE_UNDERLINE, parseMText, parseTextString } from './mtext';

/** 트루타입 기울임꼴을 기울기로 그릴 때의 각도(원호 정렬 문자와 같다) */
const ITALIC_SLANT = (15 * Math.PI) / 180;
/** 트루타입 굵게: 글리프를 이만큼(글자 크기 비율) 옆으로 한 번 더 그린다 */
const BOLD_SHIFT = 0.035;

/** 문자 스타일의 트루타입 굵게·기울임(확장 데이터 1071 비트, SHX 스타일은 없음) */
function styleWeight(style: TextStyle | undefined): { bold: boolean; italic: boolean } {
  const f = style?.fontFlags ?? 0;
  const ttf = !!style && (!!style.fontFamily || !isShxFont(style.font || 'txt'));
  return { bold: ttf && (f & 0x2000000) !== 0, italic: ttf && (f & 0x1000000) !== 0 };
}

/** 2D 아핀 [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f */
export type Affine = [number, number, number, number, number, number];

export function affMul(p: Affine, q: Affine): Affine {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

export function affApply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface PlacedGlyph {
  geom: GlyphGeom;
  kind: 'stroke' | 'outline';
  /** 글리프 좌표 → 문자 로컬 좌표 */
  m: Affine;
  color: CadColor | null;
}

export interface TextLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: CadColor | null;
}

export interface TextLayout {
  glyphs: PlacedGlyph[];
  lines: TextLine[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** MTEXT 배경 가리기 사각형 [x0, y0, x1, y1] */
  background?: [number, number, number, number];
  /** MTEXT 테두리 */
  frame?: boolean;
}

/** 글자를 찾을 글꼴 순서 */
interface Faces {
  chain: FontFace[];
  primary: FontFace;
}

const SHX_FONT = /\.shx$/i;

/** 글꼴 이름이 SHX(단선)인지. 확장자가 없는 txt·simplex 같은 이름도 SHX다. */
export function isShxFont(font: string): boolean {
  const f = font.trim().toLowerCase();
  if (!f) return true;
  if (SHX_FONT.test(f)) return true;
  if (/\.(ttf|ttc|otf)$/.test(f)) return false;
  // 확장자 없는 이름: 알려진 SHX 이름이면 SHX, 아니면 트루타입 글꼴 이름
  return /^(txt|simplex|romans|romand|romanc|romant|italic|italicc|italict|scripts|scriptc|greeks|greekc|gothice|gothicg|gothici|isocp|isocp2|isocp3|isoct|isoct2|isoct3|monotxt|syastro|symap|symath|symeteo|symusic|complex|gdt|amgdt|whgtxt|whgdtxt|whtgtxt|whtmtxt|hgtxt|ghs|bigfont|chineset|extfont|extfont2|.+\.shx)$/.test(f);
}

export class TextEngine {
  /** 사용자가 불러온 SHX 글꼴(있으면 단선 대체 글꼴보다 먼저 쓴다) */
  shx: ShxLibrary | null = null;

  constructor(private readonly lib: OutlineLibrary | null) {}

  private facesFor(font: string, ttfHint: boolean | null, bigFont = ''): Faces {
    const shx = ttfHint === null ? isShxFont(font) : !ttfHint;
    const lib = this.lib;
    const real = shx && this.shx?.size ? this.shx.face(font, bigFont) : null;
    if (real) {
      const chain: FontFace[] = [real, strokeFace];
      if (lib) chain.push(lib.capFace, lib.cjkFace);
      return { chain, primary: real.font ? real : strokeFace };
    }
    if (!lib) return { chain: [strokeFace], primary: strokeFace };
    if (shx) return { chain: [strokeFace, lib.capFace, lib.cjkFace], primary: strokeFace };
    const fam = latinFamilyOf(font);
    const latin = fam ? lib.latinFace(fam) : null;
    const chain = latin ? [latin, lib.capFace, lib.cjkFace] : [lib.capFace, lib.cjkFace];
    return { chain, primary: chain[0]! };
  }

  styleFont(style: TextStyle | undefined): string {
    if (!style) return 'txt';
    if (style.fontFamily) return style.fontFamily;
    return style.font || 'txt';
  }

  private pick(code: number, f: Faces): { geom: GlyphGeom; kind: 'stroke' | 'outline' } {
    if (code === 0xa0 || code === 9) code = 32;
    const cjk = code >= 0x1100;
    for (const face of f.chain) {
      // 한글·한자는 큰 글꼴 크기(cjk)로, 라틴 보충 글자는 대문자 높이 크기(cap)로 찾는다
      if (this.lib && ((cjk && face === this.lib.capFace) || (!cjk && face === this.lib.cjkFace && f.chain.includes(this.lib.capFace)))) continue;
      const g = face.glyph(code);
      if (g) return { geom: g, kind: face.kind };
    }
    if (code === 0x2205 || code === 0x2300) {
      const g = strokeFace.glyph(0xd8);
      if (g) return { geom: g, kind: 'stroke' };
    }
    return { geom: strokeFace.glyph(code) ?? strokeFace.glyph(63)!, kind: 'stroke' };
  }

  /** 단선 글꼴의 기준선 아래 깊이 */
  descentOf(font: string): number {
    return this.facesFor(font, null).primary.descent;
  }

  /**
   * TEXT·ATTRIB 한 줄. 결과 로컬 좌표는 OCS(정렬점 = 삽입점 또는 두 번째 정렬점)다.
   */
  layoutText(p: {
    text: string;
    insert: { x: number; y: number };
    alignPoint?: { x: number; y: number };
    height: number;
    rotation: number;
    widthFactor: number;
    oblique: number;
    generation: number;
    halign: number;
    valign: number;
    style?: TextStyle;
  }): TextLayout {
    const font = this.styleFont(p.style);
    const faces = this.facesFor(font, null, p.style?.bigFont);
    const codes = parseTextString(p.text);
    type G = { geom: GlyphGeom; kind: 'stroke' | 'outline'; x: number };
    const gl: G[] = [];
    const deco: { kind: number; x0: number; x1: number }[] = [];
    let x = 0;
    const open = new Map<number, number>();
    for (const code of codes) {
      if (code === TOGGLE_UNDERLINE || code === TOGGLE_OVERLINE || code === TOGGLE_STRIKE) {
        const start = open.get(code);
        if (start === undefined) open.set(code, x);
        else {
          deco.push({ kind: code, x0: start, x1: x });
          open.delete(code);
        }
        continue;
      }
      const g = this.pick(code, faces);
      gl.push({ ...g, x });
      x += g.geom.advance;
    }
    for (const [kind, start] of open) deco.push({ kind, x0: start, x1: x });
    const width = x; // 문자 높이 단위
    let h = p.height;
    if (!(h > 0)) h = p.style?.height || p.style?.lastHeight || 2.5;
    let wf = p.widthFactor > 0 ? p.widthFactor : 1;
    let rot = p.rotation;
    let ax = p.insert.x;
    let ay = p.insert.y;
    let dx = 0;
    let dy = 0;
    const descent = faces.primary.descent;
    const ha = p.halign;
    const va = p.valign;
    const second = p.alignPoint ?? p.insert;
    if (ha === 3 || ha === 5) {
      // 정렬(aligned)·맞춤(fit): 두 점 사이에 맞춘다.
      const vx = second.x - p.insert.x;
      const vy = second.y - p.insert.y;
      const len = Math.hypot(vx, vy);
      if (len > 1e-12 && width > 1e-12) {
        rot = Math.atan2(vy, vx);
        if (ha === 3) h = len / (width * wf);
        else wf = len / (width * h);
      }
      ax = p.insert.x;
      ay = p.insert.y;
    } else if (ha !== 0 || va !== 0) {
      ax = second.x;
      ay = second.y;
      if (ha === 1 || ha === 4) dx = -width / 2;
      else if (ha === 2) dx = -width;
      if (ha === 4) dy = -0.5;
      else if (va === 1) dy = descent;
      else if (va === 2) dy = -0.5;
      else if (va === 3) dy = -1;
    }
    const mx = p.generation & 2 ? -1 : 1;
    const my = p.generation & 4 ? -1 : 1;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const sw = styleWeight(p.style);
    const sh = Math.tan((p.oblique || 0) + (sw.italic ? ITALIC_SLANT : 0));
    // (u, v)[높이 단위] → OCS
    const sx = h * wf;
    const sy = h;
    const base: Affine = affMul([c, s, -s, c, ax, ay], affMul([mx, 0, 0, my, 0, 0], [sx, 0, sh * sy, sy, sx * dx + sh * sy * dy, sy * dy]));
    const out: TextLayout = { glyphs: [], lines: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const g of gl) {
      const m = affMul(base, [1, 0, 0, 1, g.x, 0]);
      out.glyphs.push({ geom: g.geom, kind: g.kind, m, color: null });
      if (sw.bold && g.kind === 'outline') out.glyphs.push({ geom: g.geom, kind: g.kind, m: affMul(base, [1, 0, 0, 1, g.x + BOLD_SHIFT, 0]), color: null });
    }
    for (const d of deco) {
      const yy = d.kind === TOGGLE_UNDERLINE ? -0.2 : d.kind === TOGGLE_OVERLINE ? 1.2 : 0.5;
      const [x0, y0] = affApply(base, d.x0, yy);
      const [x1, y1] = affApply(base, d.x1, yy);
      out.lines.push({ x0, y0, x1, y1, color: null });
    }
    // 범위(근사)
    for (const [u, v] of [
      [0, -descent],
      [width, -descent],
      [width, 1],
      [0, 1],
    ] as const) {
      const [qx, qy] = affApply(base, u, v);
      grow(out, qx, qy);
    }
    return out;
  }

  /**
   * MTEXT. 결과 로컬 좌표: 삽입점이 원점, X축 = 문자 방향(도면 단위).
   */
  layoutMText(p: {
    text: string;
    height: number;
    width: number;
    attachment: number;
    lineSpacingStyle: number;
    lineSpacingFactor: number;
    style?: TextStyle;
    columns?: { count: number; width: number; gutter: number; heights: number[] };
    rectHeight?: number;
    background?: { scale: number };
    frame?: boolean;
    /** 문단 기본 정렬(1 왼쪽, 2 가운데, 3 오른쪽). 없으면 부착점을 따른다 */
    align?: number;
  }): TextLayout {
    let h = p.height;
    if (!(h > 0)) h = p.style?.height || p.style?.lastHeight || 2.5;
    const styleFont = this.styleFont(p.style);
    const baseOblique = p.style?.oblique ?? 0;
    const sw = styleWeight(p.style);
    const baseWidth = p.style?.widthFactor && p.style.widthFactor > 0 ? p.style.widthFactor : 1;
    const paras = parseMText(p.text, { baseHeight: h });
    const W = p.columns && p.columns.count > 1 ? p.columns.width : p.width;

    type Item = {
      kind: 'g' | 'space' | 'stack' | 'tab';
      width: number;
      height: number;
      geom?: GlyphGeom;
      gkind?: 'stroke' | 'outline';
      style: RunStyle;
      sx: number;
      sy: number;
      stack?: { top: Item[]; bottom: Item[]; type: string; tw: number; bw: number };
      breakAfter: boolean;
    };
    const facesCache = new Map<string, Faces>();
    const facesOf = (st: RunStyle): Faces => {
      const key = `${st.font}|${st.ttf}`;
      let f = facesCache.get(key);
      if (!f) {
        f = st.font ? this.facesFor(st.font, st.ttf) : this.facesFor(styleFont, null, p.style?.bigFont);
        facesCache.set(key, f);
      }
      return f;
    };
    const glyphItem = (code: number, st: RunStyle, scale = 1): Item => {
      const f = facesOf(st);
      const { geom, kind } = this.pick(code, f);
      const sy = h * st.height * scale;
      const sx = sy * st.widthFactor * baseWidth;
      const isCjk = code >= 0x1100;
      return {
        kind: code === 32 || code === 0xa0 ? 'space' : 'g',
        width: geom.advance * sx * st.tracking,
        height: sy,
        geom,
        gkind: kind,
        style: st,
        sx,
        sy,
        breakAfter: code === 32 || isCjk,
      };
    };
    // 문단 → 항목
    const paraItems: { para: Paragraph; items: Item[] }[] = paras.map((para) => {
      const items: Item[] = [];
      for (const run of para.runs) {
        if (run.tab) {
          items.push({ kind: 'tab', width: h * 4, height: h * run.style.height, style: run.style, sx: 0, sy: 0, breakAfter: true });
          continue;
        }
        if (run.stack) {
          const top = run.stack.top.map((c) => glyphItem(c, run.style, 0.7));
          const bottom = run.stack.bottom.map((c) => glyphItem(c, run.style, 0.7));
          const tw = top.reduce((a, b) => a + b.width, 0);
          const bw = bottom.reduce((a, b) => a + b.width, 0);
          const width = run.stack.type === '#' ? tw + bw + h * 0.3 : Math.max(tw, bw) + h * 0.1;
          items.push({ kind: 'stack', width, height: h * run.style.height, style: run.style, sx: 0, sy: 0, stack: { top, bottom, type: run.stack.type, tw, bw }, breakAfter: false });
          continue;
        }
        for (const code of run.text) items.push(glyphItem(code, run.style));
      }
      return { para, items };
    });

    // 줄 나누기
    type Line = { items: Item[]; width: number; height: number; para: Paragraph; first: boolean };
    const lines: Line[] = [];
    for (const { para, items } of paraItems) {
      let cur: Line = { items: [], width: 0, height: 0, para, first: true };
      const limit = W > 0 ? W - para.indentLeft - para.indentRight : Infinity;
      const flush = () => {
        // 줄 끝 공백 제거
        while (cur.items.length && cur.items[cur.items.length - 1]!.kind === 'space') cur.width -= cur.items.pop()!.width;
        lines.push(cur);
        cur = { items: [], width: 0, height: 0, para, first: false };
      };
      let i = 0;
      while (i < items.length) {
        // 단어 = 다음 줄바꿈 기회까지
        let j = i;
        let ww = 0;
        while (j < items.length) {
          ww += items[j]!.width;
          if (items[j]!.breakAfter) {
            j++;
            break;
          }
          j++;
        }
        const indent = cur.first ? para.indentFirst : 0;
        if (cur.items.length && cur.width + ww + indent > limit) {
          flush();
          // 줄 처음의 공백은 버린다
          while (i < j && items[i]!.kind === 'space') {
            ww -= items[i]!.width;
            i++;
          }
        }
        // 한 단어가 폭보다 길어도 자르지 않는다(AutoCAD MTEXT와 같다). 한글·한자는 글자마다 끊을 수 있다.
        for (let k = i; k < j; k++) {
          const it = items[k]!;
          // 탭 정지(\pt)가 있는 문단: 탭은 다음 정지까지(글머리 기호·번호 목록의 내어쓰기). 정지가 없으면 지금처럼 높이의 4배
          if (it.kind === 'tab' && para.tabs.length) {
            const pos = (cur.first ? para.indentFirst : 0) + para.indentLeft + cur.width;
            const stop = para.tabs.find((t) => t > pos + 1e-9);
            it.width = stop !== undefined ? stop - pos : Math.max(h * 0.25, Math.ceil((pos + 1e-9) / (h * 4)) * h * 4 - pos);
          }
          cur.items.push(it);
          cur.width += it.width;
          cur.height = Math.max(cur.height, it.height);
        }
        i = j;
      }
      if (!cur.height) cur.height = h;
      flush();
    }

    const att = p.attachment >= 1 && p.attachment <= 9 ? p.attachment : 1;
    const col = (att - 1) % 3; // 0 왼, 1 가운데, 2 오른
    const row = Math.floor((att - 1) / 3); // 0 위, 1 가운데, 2 아래
    const maxLine = lines.reduce((a, l) => Math.max(a, l.width + (l.first ? l.para.indentFirst : 0) + l.para.indentLeft), 0);
    const boxW = W > 0 ? W : maxLine;
    const factor = p.lineSpacingFactor > 0 ? p.lineSpacingFactor : 1;
    // 기준선 위치
    const baselines: number[] = [];
    let y = 0;
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k]!;
      if (k === 0) y = -l.height;
      else {
        const prevH = p.lineSpacingStyle === 2 ? h : Math.max(h, l.height);
        y -= 1.667 * factor * prevH;
      }
      baselines.push(y);
    }
    // 단(R2018 열)
    const colCount = p.columns && p.columns.count > 1 ? p.columns.count : 1;
    const colHeight = colCount > 1 ? p.columns!.heights[0] || p.rectHeight || 0 : 0;
    const colOffsets: { dx: number; dy: number }[] = lines.map(() => ({ dx: 0, dy: 0 }));
    if (colCount > 1 && colHeight > 0) {
      let c = 0;
      let shift = 0;
      for (let k = 0; k < lines.length; k++) {
        const base = baselines[k]! + shift;
        if (base < -colHeight && c < colCount - 1 && k > 0) {
          c++;
          shift = -baselines[k]! - lines[k]!.height;
        }
        colOffsets[k] = { dx: c * (p.columns!.width + p.columns!.gutter), dy: shift };
      }
    }
    const lastBase = lines.length ? baselines[lines.length - 1]! + colOffsets[lines.length - 1]!.dy : -h;
    const totalH = colCount > 1 && colHeight > 0 ? colHeight : -lastBase;
    const offX = col === 0 ? 0 : col === 1 ? -boxW / 2 : -boxW;
    const offY = row === 0 ? 0 : row === 1 ? totalH / 2 : totalH;

    const out: TextLayout = { glyphs: [], lines: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const emitItem = (it: Item, x: number, base: number) => {
      if (!it.geom || it.kind === 'space') return;
      const st = it.style;
      // 트루타입 굵게·기울임: \f의 |b1·|i1, 정하지 않았으면 문자 스타일
      const italic = (st.italic ?? (st.font ? false : sw.italic)) && it.gkind === 'outline';
      const bold = (st.bold ?? (st.font ? false : sw.bold)) && it.gkind === 'outline';
      const sh = Math.tan((st.oblique || 0) + baseOblique + (italic ? ITALIC_SLANT : 0));
      // \A 세로 정렬: 줄 높이 안에서
      const m: Affine = [it.sx, 0, sh * it.sy, it.sy, x, base];
      out.glyphs.push({ geom: it.geom, kind: it.gkind!, m, color: st.color });
      if (bold) out.glyphs.push({ geom: it.geom, kind: it.gkind!, m: [it.sx, 0, sh * it.sy, it.sy, x + it.sx * BOLD_SHIFT, base], color: st.color });
    };
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k]!;
      const indent = l.para.indentLeft + (l.first ? l.para.indentFirst : 0);
      const align = l.para.align || p.align || col + 1;
      let x = indent;
      if (align === 2) x = indent + (boxW - indent - l.para.indentRight - l.width) / 2;
      else if (align === 3) x = boxW - l.para.indentRight - l.width;
      x += offX + colOffsets[k]!.dx;
      const base = baselines[k]! + offY + colOffsets[k]!.dy;
      let deco: { st: RunStyle; x0: number; x1: number }[] = [];
      for (const it of l.items) {
        let yb = base;
        if (it.style.valign === 1 && it.height < l.height) yb = base + (l.height - it.height) / 2;
        else if (it.style.valign === 2 && it.height < l.height) yb = base + (l.height - it.height);
        if (it.kind === 'stack' && it.stack) {
          const sk = it.stack;
          const hh = it.height;
          if (sk.type === '#') {
            let cx = x;
            for (const t of sk.top) {
              emitItem(t, cx, yb + hh * 0.45);
              cx += t.width;
            }
            out.lines.push({ x0: cx + hh * 0.05, y0: yb - hh * 0.05, x1: cx + hh * 0.25, y1: yb + hh * 1.05, color: it.style.color });
            cx += hh * 0.3;
            for (const b of sk.bottom) {
              emitItem(b, cx, yb - hh * 0.05);
              cx += b.width;
            }
          } else {
            let cx = x + (it.width - sk.tw) / 2;
            for (const t of sk.top) {
              emitItem(t, cx, yb + hh * 0.55);
              cx += t.width;
            }
            cx = x + (it.width - sk.bw) / 2;
            for (const b of sk.bottom) {
              emitItem(b, cx, yb - hh * 0.4);
              cx += b.width;
            }
            if (sk.type === '/') out.lines.push({ x0: x, y0: yb + hh * 0.42, x1: x + it.width, y1: yb + hh * 0.42, color: it.style.color });
          }
        } else {
          emitItem(it, x, yb);
        }
        if (it.style.underline || it.style.overline || it.style.strike) deco.push({ st: it.style, x0: x, x1: x + it.width });
        x += it.width;
      }
      for (const d of deco) {
        if (d.st.underline) out.lines.push({ x0: d.x0, y0: base - h * 0.2, x1: d.x1, y1: base - h * 0.2, color: d.st.color });
        if (d.st.overline) out.lines.push({ x0: d.x0, y0: base + l.height * 1.2, x1: d.x1, y1: base + l.height * 1.2, color: d.st.color });
        if (d.st.strike) out.lines.push({ x0: d.x0, y0: base + l.height * 0.5, x1: d.x1, y1: base + l.height * 0.5, color: d.st.color });
      }
      deco = [];
      grow(out, x, base - h * 0.34);
      grow(out, offX + indent + colOffsets[k]!.dx, base + l.height);
    }
    if (!lines.length) {
      grow(out, 0, 0);
    }
    const boxLeft = offX;
    const boxRight = offX + boxW * (colCount > 1 ? colCount : 1) + (colCount > 1 ? p.columns!.gutter * (colCount - 1) : 0);
    const boxTop = offY;
    const boxBottom = offY - totalH;
    if (p.background) {
      const mgn = Math.max(0, (p.background.scale - 1) * h * 0.5);
      out.background = [boxLeft - mgn, boxBottom - mgn, (W > 0 ? boxRight : Math.max(boxRight, out.maxX)) + mgn, boxTop + mgn];
    }
    if (p.frame) out.frame = true;
    grow(out, boxLeft, boxTop);
    grow(out, boxRight, boxBottom);
    return out;
  }
}

function grow(o: TextLayout, x: number, y: number): void {
  if (x < o.minX) o.minX = x;
  if (x > o.maxX) o.maxX = x;
  if (y < o.minY) o.minY = y;
  if (y > o.maxY) o.maxY = y;
}

/** 문자 배치를 꺾은선·삼각형으로 내보낸다(로컬 → 월드 변환을 받는다). */
export interface GlyphSink {
  stroke(pts: number[]): void;
  fill(tris: number[]): void;
}
