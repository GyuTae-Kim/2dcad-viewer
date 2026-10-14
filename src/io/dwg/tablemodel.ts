/**
 * DWG 표·테이블 스타일 구조(tablecodec.ts) ↔ 형식 중립 값(io/tablecells.ts의 셀 배치, io/tablestyle.ts의 스타일 값).
 * - 읽기: DWG 본문 → 셀 배치·스타일 값 → DXF와 같은 원본 태그(모델의 raw).
 * - 쓰기: 셀 배치·스타일 값 → DWG 본문(R2010+ 새 배치, R2007 이전 옛 배치).
 */
import type { CadColor, Vec3 } from '../../core/model';
import type { CellOut, TableOut } from '../tablecells';
import type { IoRowStyle, IoTableStyle } from '../tablestyle';
import { defaultRowStyle } from '../tablestyle';
import { cmcToCad } from './color';
import {
  type TCell,
  type TCellOld,
  type TCellStyle,
  type TColor,
  type TContentFormat,
  type TNamedCellStyle,
  type TTableOld,
  type TTableR24,
  type TTableStyleOld,
  type TTableStyleR24,
  emptyCellStyle,
  emptyContentFormat,
  emptyOldTail,
  tcAci,
  tcByBlock,
} from './tablecodec';

/** 표 색 → 모델 색 */
export function tcToCad(c: TColor): CadColor {
  return cmcToCad({ index: c.index, rgb: c.rgb, name: c.name, book: c.book });
}

/** 모델 색 → 표 색 */
export function cadToTc(c: CadColor | undefined): TColor {
  if (!c) return tcByBlock();
  if (c.rgb !== undefined) return { index: c.aci > 0 && c.aci < 256 ? c.aci : 0, rgb: (0xc2000000 | (c.rgb & 0xffffff)) >>> 0 };
  return tcAci(c.aci);
}

const NONE = 0xc8000000;
const isNone = (c: TColor): boolean => c.rgb >>> 24 === 0xc8;

// ---------------------------------------------------------------------------
// 읽기: 표 → 셀 배치

interface Props {
  align?: number;
  height?: number;
  color?: CadColor;
  textStyle?: number;
  fill?: CadColor | null;
}

/** 셀 스타일·내용 형식의 재지정 값(내용 형식 비트: 0x10 정렬, 0x20 색, 0x40 문자 스타일, 0x80 높이, 셀 스타일 0x200 배경) */
function propsOf(s: TCellStyle | undefined, f: TContentFormat | undefined, out: Props): void {
  const cf = (ovr: number, c: TContentFormat) => {
    if (ovr & 0x10 && out.align === undefined && c.align >= 1 && c.align <= 9) out.align = c.align;
    if (ovr & 0x20 && out.color === undefined) out.color = tcToCad(c.color);
    if (ovr & 0x40 && out.textStyle === undefined && c.textStyle) out.textStyle = c.textStyle;
    if (ovr & 0x80 && out.height === undefined && c.textHeight > 0) out.height = c.textHeight;
  };
  if (f) cf(f.ovr, f);
  if (s && s.data) {
    cf(s.ovr, s.content);
    if (s.ovr & 0x200 && out.fill === undefined) out.fill = isNone(s.bg) ? null : tcToCad(s.bg);
  }
}

function cellText(c: TCell): string {
  for (const k of c.contents) {
    if (k.type !== 1 || !k.value) continue;
    const v = k.value;
    if (v.type === 4 && v.str !== undefined) return v.str;
    if (v.text) return v.text;
  }
  return '';
}

/** R2010+ 표 → 셀 배치(문자 스타일 이름은 styleName이 푼다) */
export function layoutFromR24(t: TTableR24, styleName: (h: number) => string): TableOut {
  const c = t.content;
  const rows = c.rows.length;
  const cols = c.columns.length;
  const out: TableOut = { rows, cols, rowHeights: c.rows.map((r) => r.height), colWidths: c.columns.map((x) => x.width), cells: [], formatted: true, known: true };
  for (let r = 0; r < rows; r++) {
    const row = c.rows[r]!;
    for (let k = 0; k < cols; k++) {
      const cell = row.cells[k];
      const co: CellOut = { text: cell ? cellText(cell) : '', covered: false, spanCols: 1, spanRows: 1 };
      if (cell) {
        const p: Props = {};
        for (const x of cell.contents) if (x.hasFormat && x.format) propsOf(undefined, x.format, p);
        propsOf(cell.style, undefined, p);
        propsOf(row.style, undefined, p);
        propsOf(c.columns[k]?.style, undefined, p);
        if (p.align !== undefined) co.align = p.align;
        if (p.height !== undefined) co.height = p.height;
        if (p.color) co.color = p.color;
        if (p.fill !== undefined) co.fill = p.fill;
        if (p.textStyle) {
          const n = styleName(p.textStyle);
          if (n) co.textStyle = n;
        }
      }
      out.cells.push(co);
    }
  }
  for (const [top, left, bottom, right] of c.merges) {
    for (let r = top; r <= bottom; r++)
      for (let k = left; k <= right; k++) {
        const cell = out.cells[r * cols + k];
        if (!cell) continue;
        if (r === top && k === left) {
          cell.spanCols = right - left + 1;
          cell.spanRows = bottom - top + 1;
        } else {
          cell.covered = true;
          cell.text = '';
        }
      }
  }
  return out;
}

/** R2007 이전 표 → 셀 배치 */
export function layoutFromOld(t: TTableOld, styleName: (h: number) => string): TableOut {
  const rows = t.rowHeights.length;
  const cols = t.colWidths.length;
  const out: TableOut = { rows, cols, rowHeights: [...t.rowHeights], colWidths: [...t.colWidths], cells: [], formatted: true, known: true };
  for (const c of t.cells) {
    let text = c.text ?? '';
    if (!text && c.value) text = c.value.type === 4 && c.value.str !== undefined ? c.value.str : c.value.text;
    const co: CellOut = { text: c.merged ? '' : text, covered: !!c.merged, spanCols: c.merged ? 1 : Math.max(1, c.mergeWidth), spanRows: c.merged ? 1 : Math.max(1, c.mergeHeight) };
    if (c.hasOverride && c.ovr) {
      const f = c.ovr;
      if (f & 0x01 && c.align) co.align = c.align;
      if (f & 0x20 && c.textHeight) co.height = c.textHeight;
      if (f & 0x08 && c.color) co.color = tcToCad(c.color);
      if (f & 0x10 && c.textStyle) {
        const n = styleName(c.textStyle);
        if (n) co.textStyle = n;
      }
      if (f & 0x04 && c.bg && !(f & 0x02 && c.fillNone)) co.fill = tcToCad(c.bg);
      else if (f & 0x02 && c.fillNone) co.fill = null;
    }
    out.cells.push(co);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 쓰기: 셀 배치 → 표

export interface TableBuildOptions {
  tableStyle: number;
  /** 문자 스타일 이름 → 핸들(없으면 0) */
  textStyle: (name: string) => number;
  direction: Vec3;
  /** 0 위에서 아래로, 1 아래에서 위로 */
  flow: number;
}

/** 행 셀 스타일 ID(1 제목, 2 머리글, 3 데이터). 행 종류를 모르면 첫 행 제목·둘째 행 머리글 */
function rowStyleIds(lay: TableOut): number[] {
  const id = { title: 1, header: 2, data: 3 } as const;
  if (lay.rowKinds?.length === lay.rows) return lay.rowKinds.map((k) => id[k]);
  return Array.from({ length: lay.rows }, (_, r) => (r === 0 && lay.rows > 1 ? 1 : r === 1 && lay.rows > 2 ? 2 : 3));
}

function cellStyleFor(c: CellOut, o: TableBuildOptions): TCellStyle {
  const s = emptyCellStyle(1);
  let ovr = 0;
  const cf = emptyContentFormat();
  cf.dataType = 512;
  cf.align = 1;
  if (c.align) {
    ovr |= 0x10;
    cf.align = c.align;
  }
  if (c.color) {
    ovr |= 0x20;
    cf.color = cadToTc(c.color);
  }
  const ts = c.textStyle ? o.textStyle(c.textStyle) : 0;
  if (ts) {
    ovr |= 0x40;
    cf.textStyle = ts;
  }
  if (c.height && c.height > 0) {
    ovr |= 0x80;
    cf.textHeight = c.height;
  }
  if (c.fill !== undefined) {
    ovr |= 0x200;
    s.bg = c.fill ? cadToTc(c.fill) : { index: 0, rgb: NONE };
  } else s.bg = { index: 0, rgb: NONE };
  if (!ovr) return s;
  s.data = 1;
  s.ovr = ovr;
  s.content = cf;
  return s;
}

/** 셀 배치 → R2010+ 표 본문(INSERT 자료 다음) */
export function tableToR24(lay: TableOut, o: TableBuildOptions): TTableR24 {
  const ids = rowStyleIds(lay);
  const merges: [number, number, number, number][] = [];
  const rows = Array.from({ length: lay.rows }, (_, r) => {
    const cells: TCell[] = [];
    for (let k = 0; k < lay.cols; k++) {
      const c = lay.cells[r * lay.cols + k] ?? { text: '', covered: false, spanCols: 1, spanRows: 1 };
      if (!c.covered && (c.spanCols > 1 || c.spanRows > 1)) merges.push([r, k, r + c.spanRows - 1, k + c.spanCols - 1]);
      const contents: TCell['contents'] = [];
      if (c.text && !c.covered) contents.push({ type: 1, value: { flags: 6, type: 4, str: c.text, strZ: 1, unit: 0, format: '', text: c.text }, attrs: [], hasFormat: 0 });
      cells.push({ state: 0, tooltip: '', customInt: 0, custom: [], linked: 0, contents, style: cellStyleFor(c, o), styleId: 0, geomFlag: 0 });
    }
    return { cells, customInt: 0, custom: [], style: emptyCellStyle(2), styleId: ids[r]!, height: lay.rowHeights[r] ?? 1 };
  });
  const columns = lay.colWidths.map((w) => ({ name: '', customInt: 0, custom: [], style: emptyCellStyle(3), styleId: 0, width: w }));
  return {
    rc: 0,
    handle: 0,
    bl: 0,
    u4: 0,
    content: { name: '', description: '', columns, rows, fields: [], tableStyleOverride: emptyCellStyle(4), merges, tableStyle: o.tableStyle },
    bs: o.flow === 1 ? 6 : 22,
    direction: o.direction,
    hasBreak: 0,
    ranges: [{ pos: { x: 0, y: 0, z: 0 }, start: 0, end: Math.max(0, lay.rows - 1) }],
  };
}

/** 셀 배치 → R2007 이전 표 본문(R2000·R2004) */
export function tableToOld(lay: TableOut, o: TableBuildOptions): TTableOld {
  const cells: TCellOld[] = lay.cells.map((c) => {
    const x: TCellOld = { type: 1, edgeFlags: 0, merged: c.covered ? 1 : 0, autofit: 0, mergeWidth: c.spanCols, mergeHeight: c.spanRows, rotation: 0, fieldHandle: 0, text: c.text, hasOverride: 0 };
    let f = 0;
    if (c.align) {
      f |= 0x01;
      x.align = c.align;
    }
    if (c.fill) {
      f |= 0x02 | 0x04;
      x.fillNone = 0;
      x.bg = cadToTc(c.fill);
    } else if (c.fill === null) {
      f |= 0x02;
      x.fillNone = 1;
    }
    if (c.color) {
      f |= 0x08;
      x.color = cadToTc(c.color);
    }
    const ts = c.textStyle ? o.textStyle(c.textStyle) : 0;
    if (ts) {
      f |= 0x10;
      x.textStyle = ts;
    }
    if (c.height && c.height > 0) {
      f |= 0x20;
      x.textHeight = c.height;
    }
    if (f) {
      x.hasOverride = 1;
      x.ovr = f;
      x.virtualEdge = 0;
      x.edges = [{}, {}, {}, {}];
    }
    return x;
  });
  return { flags: o.flow === 1 ? 6 : 22, direction: o.direction, colWidths: [...lay.colWidths], rowHeights: [...lay.rowHeights], tableStyle: o.tableStyle, cells, tail: emptyOldTail() };
}

// ---------------------------------------------------------------------------
// 테이블 스타일

const TITLE = 1;
const HEADER = 2;
const DATA = 3;

function rowFromCellStyle(s: TCellStyle, styleName: (h: number) => string, height: number, align: number): IoRowStyle {
  const r = defaultRowStyle(height, align);
  if (!s.data) return r;
  r.textStyle = (s.content.textStyle && styleName(s.content.textStyle)) || 'Standard';
  if (s.content.textHeight > 0) r.height = s.content.textHeight;
  if (s.content.align >= 1 && s.content.align <= 9) r.align = s.content.align;
  r.color = tcToCad(s.content.color);
  if (!isNone(s.bg)) {
    r.fillOn = true;
    r.fill = tcToCad(s.bg);
  }
  r.dataType = s.content.dataType || 512;
  r.unitType = s.content.unitType;
  r.format = s.content.format;
  const EDGE = [1, 2, 4, 8, 16, 32];
  for (const b of s.borders) {
    const i = EDGE.indexOf(b.edge);
    if (i < 0) continue;
    r.borders[i] = { lineweight: b.lineweight, visible: !b.invisible, color: tcToCad(b.color) };
  }
  return r;
}

/** R2010+ 테이블 스타일 → 값 */
export function styleFromR24(t: TTableStyleR24, styleName: (h: number) => string): IoTableStyle {
  const find = (id: number, name: string): TNamedCellStyle | undefined => t.styles.find((s) => s.id === id) ?? t.styles.find((s) => s.name.toUpperCase() === name);
  const tbl = t.table.style;
  const metric = (tbl.margins[1] ?? 0.06) > 0.5;
  const h = metric ? 4.5 : 0.18;
  const data = find(DATA, '_DATA');
  const title = find(TITLE, '_TITLE');
  const header = find(HEADER, '_HEADER');
  return {
    description: t.description,
    flow: tbl.merge & 0x10000 ? 1 : 0,
    flags: 0,
    hMargin: tbl.margins[1] ?? (metric ? 1.5 : 0.06),
    vMargin: tbl.margins[0] ?? (metric ? 1.5 : 0.06),
    titleSuppressed: false,
    headerSuppressed: false,
    rows: [
      data ? rowFromCellStyle(data.style, styleName, h, 2) : defaultRowStyle(h, 2),
      title ? rowFromCellStyle(title.style, styleName, metric ? 6 : 0.25, 5) : defaultRowStyle(metric ? 6 : 0.25, 5),
      header ? rowFromCellStyle(header.style, styleName, h, 5) : defaultRowStyle(h, 5),
    ],
  };
}

/** R2007 이전 테이블 스타일 → 값 */
export function styleFromOld(t: TTableStyleOld, styleName: (h: number) => string): IoTableStyle {
  return {
    description: t.description,
    flow: t.flow,
    flags: t.flags,
    hMargin: t.hMargin,
    vMargin: t.vMargin,
    titleSuppressed: !!t.titleSuppressed,
    headerSuppressed: !!t.headerSuppressed,
    rows: t.rows.map((r) => ({
      textStyle: (r.textStyle && styleName(r.textStyle)) || 'Standard',
      height: r.height,
      align: r.align,
      color: tcToCad(r.color),
      fill: tcToCad(r.fill),
      fillOn: !!r.fillOn,
      dataType: r.dataType ?? 512,
      unitType: r.unitType ?? 0,
      format: r.format ?? '',
      borders: r.borders.map((b) => ({ lineweight: b.lineweight, visible: !!b.visible, color: tcToCad(b.color) })),
    })),
  };
}

/** 값 → R2007 이전 테이블 스타일 */
export function styleToOld(s: IoTableStyle, textStyle: (name: string) => number): TTableStyleOld {
  return {
    description: s.description,
    flow: s.flow,
    flags: s.flags,
    hMargin: s.hMargin,
    vMargin: s.vMargin,
    titleSuppressed: s.titleSuppressed ? 1 : 0,
    headerSuppressed: s.headerSuppressed ? 1 : 0,
    rows: s.rows.map((r) => ({
      textStyle: textStyle(r.textStyle),
      height: r.height,
      align: r.align,
      color: cadToTc(r.color),
      fill: cadToTc(r.fill),
      fillOn: r.fillOn ? 1 : 0,
      borders: r.borders.map((b) => ({ lineweight: b.lineweight, visible: b.visible ? 1 : 0, color: cadToTc(b.color) })),
      dataType: r.dataType,
      unitType: r.unitType,
      format: r.format,
    })),
  };
}

/** 값 → R2010+ 테이블 스타일(AutoCAD 서식과 같은 셀 스타일 넷: Table·_TITLE·_HEADER·_DATA) */
export function styleToR24(s: IoTableStyle, textStyle: (name: string) => number): TTableStyleR24 {
  const metric = s.hMargin > 0.5;
  const margins = (sp: number) => [s.vMargin, s.hMargin, s.vMargin, s.hMargin, sp, sp];
  const content = (align: number, color: TColor, ts: number, height: number, r?: IoRowStyle): TContentFormat => ({
    ovr: 0,
    prop: 0,
    dataType: r?.dataType || 512,
    unitType: r?.unitType ?? 0,
    format: r?.format ?? '',
    rotation: 0,
    blockScale: 1,
    align,
    color,
    textStyle: ts,
    textHeight: height,
  });
  const table: TNamedCellStyle = {
    style: { type: 5, data: 1, ovr: 0, merge: s.flow === 1 ? 0x10000 : 0, bg: { index: 0, rgb: NONE }, layout: 1, content: content(1, tcByBlock(), 0, 0.18), marginFlag: 1, margins: margins(0.18), borders: [] },
    id: 4,
    cls: 2,
    name: 'Table',
  };
  const row = (r: IoRowStyle, id: number, cls: number, name: string, merge: number): TNamedCellStyle => ({
    key: id,
    style: {
      type: 5,
      data: 1,
      ovr: 0,
      merge,
      bg: r.fillOn ? cadToTc(r.fill) : { index: 0, rgb: NONE },
      layout: 1,
      content: content(r.align, cadToTc(r.color), textStyle(r.textStyle), r.height, r),
      marginFlag: 1,
      margins: margins(3 * s.hMargin),
      borders: [1, 2, 4, 8, 16, 32].map((edge, i) => {
        const b = r.borders[i] ?? { lineweight: -2, visible: true, color: { aci: 0 } };
        return { edge, ovr: 0, type: 1, color: cadToTc(b.color), lineweight: b.lineweight, linetype: 0, invisible: b.visible ? 0 : 1, spacing: metric ? 1.125 : 0.045 };
      }),
    },
    id,
    cls,
    name,
  });
  const [data, title, header] = s.rows;
  return {
    rc: 0,
    description: s.description,
    u1: 0,
    u2: 101,
    handle: 0,
    table,
    styles: [row(title!, TITLE, 1, '_TITLE', 0x8000), row(header!, HEADER, 1, '_HEADER', 0), row(data!, DATA, 2, '_DATA', 0)],
  };
}
