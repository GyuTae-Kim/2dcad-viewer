/**
 * 치수 문자 상자 크기(잉크 범위). AutoCAD는 치수 문자 위치를 글자 잉크 상자로 정한다
 * (치수선과 문자 사이 = DIMGAP, MTEXT 가운데 부착점 = 상자 가운데).
 * 트루타입은 Liberation 글꼴 표(Arial·Times·Courier와 폭이 같다), SHX는 단선 글꼴로 잰다.
 */
import type { TextStyle } from '../../core/model';
import { latinFamilyOf, strokeFace } from '../../text/fonts';
import { isShxFont } from '../../text/layout';
import { parseMText, type Run } from '../../text/mtext';
import { type GlyphTable, MONO, SANS, SERIF } from './glyphs';

export interface TextBox {
  /** 잉크 폭 */
  w: number;
  /** 잉크 높이 */
  h: number;
}

export type MeasureText = (mtext: string, height: number, style: TextStyle | undefined) => TextBox;

interface Metric {
  adv: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** 글자 위쪽 한계(대문자 높이 배율): AutoCAD 상자는 숫자 윗부분(1472/1466)보다 높이 잡지 않는다 */
const TOP_LIMIT = 1472 / 1466;

const tables = new Map<GlyphTable, Map<number, Metric>>();

function tableOf(t: GlyphTable): Map<number, Metric> {
  let m = tables.get(t);
  if (!m) {
    m = new Map();
    const k = 1 / t.cap;
    const d = t.data;
    for (let i = 0; i + 5 < d.length; i += 6) m.set(d[i]!, { adv: d[i + 1]! * k, x1: d[i + 2]! * k, x2: d[i + 3]! * k, y1: d[i + 4]! * k, y2: d[i + 5]! * k });
    if (t === SANS) {
      // AutoCAD 치수 블록(Arial)에서 거꾸로 잰 보정: Liberation과 모양이 다른 글자
      const fix = (c: number, f: Partial<Record<'x1' | 'x2' | 'y1' | 'y2', number>>) => {
        const g = m!.get(c);
        if (g) for (const [kk, val] of Object.entries(f)) g[kk as 'x1'] = val / 1466;
      };
      fix(0x31, { x1: 216, x2: 771, y2: 1472 }); // '1'(Liberation은 아래 받침이 있다)
      fix(0x34, { x2: 1047 });
      fix(0x2c, { y1: -290 });
      for (const c of [0x30, 0x33, 0x35, 0x36, 0x38, 0x39]) fix(c, { y1: -25 });
    }
    // 지름 기호(⌀·∅): 표에 없어 AutoCAD 결과에서 잰 크기(Arial 대문자 높이 1466 기준)를 쓴다
    const dia: Metric = { adv: 1560 / 1466, x1: 50 / 1466, x2: 1510 / 1466, y1: -338 / 1466, y2: 1520 / 1466 };
    m.set(0x2205, dia);
    m.set(0x2300, dia);
    tables.set(t, m);
  }
  return m;
}

function strokeMetric(code: number): Metric | null {
  const g = strokeFace.glyph(code) ?? (code === 0x2205 || code === 0x2300 ? strokeFace.glyph(0xd8) : null);
  if (!g) return null;
  return { adv: g.advance, x1: g.minX, x2: g.maxX, y1: g.minY, y2: g.maxY };
}

/** 글자 하나의 크기(대문자 높이 = 1) */
function metricOf(code: number, table: Map<number, Metric> | null): Metric {
  if (code === 0xa0 || code === 9) code = 32;
  const m = table ? (table.get(code) ?? strokeMetric(code)) : strokeMetric(code);
  if (m) return m;
  // 표에 없는 글자: 한글·한자는 전각, 그 밖은 0.7
  const wide = code >= 0x1100;
  const adv = wide ? 1.0 : 0.7;
  return { adv, x1: 0, x2: adv * 0.95, y1: wide ? -0.12 : 0, y2: 1 };
}

function familyTable(style: TextStyle | undefined): Map<number, Metric> | null {
  const font = style ? style.fontFamily || style.font || 'txt' : 'txt';
  if (isShxFont(font)) return null;
  const fam = latinFamilyOf(font) ?? 'sans';
  return tableOf(fam === 'serif' ? SERIF : fam === 'mono' ? MONO : SANS);
}

class Box {
  minX = Infinity;
  maxX = -Infinity;
  minY = Infinity;
  maxY = -Infinity;
  ink(x0: number, x1: number, y0: number, y1: number): void {
    if (x0 < this.minX) this.minX = x0;
    if (x1 > this.maxX) this.maxX = x1;
    if (y0 < this.minY) this.minY = y0;
    if (y1 > this.maxY) this.maxY = y1;
  }
}

/** 글자들을 x에서 시작해 기준선 y에 놓는다. 끝 x를 돌려준다 */
function placeCodes(codes: number[], x: number, y: number, hs: number, wf: number, table: Map<number, Metric> | null, box: Box): number {
  for (const c of codes) {
    if (c < 0) continue;
    const m = metricOf(c, table);
    if (m.x2 > m.x1 || m.y2 > m.y1) box.ink(x + m.x1 * hs * wf, x + m.x2 * hs * wf, y + m.y1 * hs, y + Math.min(m.y2, TOP_LIMIT) * hs);
    x += m.adv * hs * wf;
  }
  return x;
}

function advanceOf(codes: number[], hs: number, wf: number, table: Map<number, Metric> | null): number {
  let x = 0;
  for (const c of codes) if (c >= 0) x += metricOf(c, table).adv * hs * wf;
  return x;
}

/** 쌓기: '#' 사선(분자 기준선 = 문자 높이), '/' 가로 분수, '^' 공차 */
function placeStack(run: Run, x: number, y: number, h: number, hs: number, wf: number, table: Map<number, Metric> | null, box: Box): number {
  const st = run.stack!;
  const top = st.top;
  const bottom = st.bottom;
  const wt = advanceOf(top, hs, wf, table);
  const wb = advanceOf(bottom, hs, wf, table);
  if (st.type === '#') {
    placeCodes(top, x, y + h, hs, wf, table, box);
    const xb = x + wt + hs * 0.25 * wf;
    placeCodes(bottom, xb, y, hs, wf, table, box);
    return xb + wb;
  }
  const w = Math.max(wt, wb);
  const gapV = st.type === '/' ? hs * 0.2 : hs * 0.15;
  const centre = y + h / 2;
  placeCodes(top, x + (w - wt) / 2, centre + gapV / 2, hs, wf, table, box);
  placeCodes(bottom, x + (w - wb) / 2, centre - gapV / 2 - hs, hs, wf, table, box);
  return x + w;
}

/** MTEXT 서식 문자열의 잉크 상자 */
export const measureText: MeasureText = (mtext, height, style) => {
  if (!mtext) return { w: 0, h: 0 };
  const table = familyTable(style);
  const wf0 = style && style.widthFactor > 0 ? style.widthFactor : 1;
  const paras = parseMText(mtext, { baseHeight: height });
  const box = new Box();
  let y = 0;
  for (const para of paras) {
    let x = 0;
    for (const run of para.runs) {
      const hs = height * (run.style.height || 1);
      const wf = wf0 * (run.style.widthFactor || 1);
      if (run.tab) {
        x += height * 2;
        continue;
      }
      if (run.stack) x = placeStack(run, x, y, height, hs, wf, table, box);
      else x = placeCodes(run.text, x, y, hs, wf, table, box);
    }
    y -= height * (5 / 3);
  }
  if (!(box.maxX >= box.minX)) return { w: 0, h: 0 };
  return { w: box.maxX - box.minX, h: box.maxY - box.minY };
};
