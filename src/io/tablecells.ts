/**
 * 표(ACAD_TABLE) 셀 배치 — DXF 쓰기, DWG 쓰기, DWG 읽기(원본 태그 만들기)가 같이 쓴다.
 *
 * 모델의 ACAD_TABLE은 행·열 크기와 셀 문자만 가진다. 셀마다의 병합 범위와 재지정 서식(정렬·문자 높이·문자 색·
 * 채우기·문자 스타일)은 다음에서 정한다.
 * - 앱이 만든 표: 확장 자료 OPENCAD_TABLE(병합·정렬·행 종류) + 표 스타일(행 종류마다의 셀 스타일).
 * - AutoCAD가 쓴 표(DXF, 또는 DWG 리더가 만든 같은 꼴의 원본 태그): AcDbTable 셀 태그의 병합(173·175·176)과
 *   셀 재지정(플래그 R2007+ 91 / 그 전 177, 170 정렬, 63 배경색, 64 문자 색, 283 채우기 없음, 7 문자 스타일, 140 문자 높이).
 *
 * acdbTableTags()는 이 배치로 AcDbTable 태그(AutoCAD DXF 순서)를 만든다.
 */
import type { CadColor, CadDocument, RawTag, TableEntity, Vec3 } from '../core/model';
import { TABLE_APP, decodeTableXData, tableFromEntity } from '../edit/table/entity';
import type { CellKind, TableStyle } from '../edit/table/style';

export interface CellOut {
  text: string;
  /** 다른 셀(병합 기준 셀)에 덮인 셀 */
  covered: boolean;
  /** 병합 기준 셀의 열·행 수(아니면 1) */
  spanCols: number;
  spanRows: number;
  /** 셀 재지정 값(모르면 없음) */
  align?: number;
  height?: number;
  color?: CadColor;
  /** 채우기 색(채우지 않음이면 null, 모르면 없음) */
  fill?: CadColor | null;
  textStyle?: string;
  kind?: CellKind;
}

export interface TableOut {
  rows: number;
  cols: number;
  rowHeights: number[];
  colWidths: number[];
  cells: CellOut[];
  /** 셀 서식을 안다(앱 표, 또는 원본 태그의 셀 재지정) */
  formatted: boolean;
  /** 병합·정렬을 안다(앱 표 또는 원본 태그가 있는 표) */
  known: boolean;
  /** 표 스타일 값(앱 표에서만) */
  style?: TableStyle;
  rowKinds?: CellKind[];
}

const pick = (a: number[], n: number, d: number): number[] =>
  Array.from({ length: n }, (_, i) => {
    const v = a[i] ?? a[a.length - 1];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  });

const num = (v: string | number | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 원본 태그(AcDbTable)의 셀 재지정 값. 셀마다 하나(171 순서) */
export function rawCellOverrides(raw: readonly RawTag[] | undefined): Partial<CellOut>[] {
  const out: Partial<CellOut>[] = [];
  if (!raw) return out;
  const start = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbTable');
  if (start < 0) return out;
  let cur: Map<number, string | number> | null = null;
  let inValue = false;
  const flush = () => {
    if (!cur) return;
    const c: Partial<CellOut> = {};
    const flags = num(cur.get(177) ?? cur.get(91));
    if (flags & 0x01 && cur.has(170)) c.align = num(cur.get(170));
    if (flags & 0x20 && cur.has(140)) c.height = num(cur.get(140));
    if (flags & 0x08 && cur.has(64)) c.color = { aci: num(cur.get(64)) };
    if (flags & 0x10 && cur.has(7)) c.textStyle = String(cur.get(7));
    if (flags & 0x04 && cur.has(63) && !num(cur.get(283))) c.fill = { aci: num(cur.get(63)) };
    else if (flags & 0x02 && num(cur.get(283))) c.fill = null;
    out.push(c);
  };
  for (let k = start + 1; k < raw.length; k++) {
    const t = raw[k]!;
    if (t.code === 100) break;
    if (t.code === 171) {
      flush();
      cur = new Map();
      inValue = false;
      continue;
    }
    if (!cur) continue;
    if (t.code === 301) inValue = true;
    if (t.code === 304) inValue = false;
    if (inValue || cur.has(t.code)) continue;
    cur.set(t.code, t.value);
  }
  flush();
  return out;
}

/** 쓸 표의 셀 배치 */
export function tableCellsOut(e: TableEntity, doc: CadDocument): TableOut {
  const rows = Math.max(0, e.rows | 0);
  const cols = Math.max(0, e.columns | 0);
  const out: TableOut = {
    rows,
    cols,
    rowHeights: pick(e.rowHeights, rows, 1),
    colWidths: pick(e.columnWidths, cols, 1),
    cells: [],
    formatted: false,
    known: false,
  };
  const n = rows * cols;
  for (let i = 0; i < n; i++) out.cells.push({ text: e.cells?.[i]?.text ?? '', covered: false, spanCols: 1, spanRows: 1 });
  if (!n) return out;
  const x = decodeTableXData(e.xdata?.find((q) => q.app.toUpperCase() === TABLE_APP));
  const xok = !!x && x.rows === rows && x.cols === cols;
  const rawOvr = xok ? [] : rawCellOverrides(e.raw);
  const hasRawCells = rawOvr.length === n;
  let rt: ReturnType<typeof tableFromEntity> = null;
  try {
    rt = tableFromEntity(e, doc);
  } catch {
    rt = null;
  }
  if (!rt || (!xok && !hasRawCells)) return out;
  out.known = true;
  for (const m of rt.data.merges) {
    for (let r = m.row; r < m.row + m.rows; r++)
      for (let c = m.col; c < m.col + m.cols; c++) {
        const cell = out.cells[r * cols + c];
        if (!cell) continue;
        if (r === m.row && c === m.col) {
          cell.spanCols = m.cols;
          cell.spanRows = m.rows;
        } else {
          cell.covered = true;
          cell.text = '';
        }
      }
  }
  for (let i = 0; i < n; i++) {
    const a = rt.data.cells[i]?.align;
    if (a && a >= 1 && a <= 9) out.cells[i]!.align = a;
  }
  if (xok) {
    out.formatted = true;
    out.style = rt.style;
    out.rowKinds = rt.data.rowKinds;
    // 문자가 확장 자료에만 있는 경우(모델 셀 문자가 없을 때)
    if (!e.cells) for (let i = 0; i < n; i++) if (!out.cells[i]!.covered) out.cells[i]!.text = rt.data.cells[i]?.text ?? '';
    for (let r = 0; r < rows; r++) {
      const kind = rt.data.rowKinds[r] ?? 'data';
      const cs = rt.style.cells[kind];
      for (let c = 0; c < cols; c++) {
        const cell = out.cells[r * cols + c]!;
        cell.kind = kind;
        cell.align ??= cs.align;
        cell.height = cs.height;
        cell.color = { ...cs.color };
        cell.fill = cs.fill ? { ...cs.fill } : null;
        cell.textStyle = cs.textStyle || 'Standard';
      }
    }
  } else {
    // 원본 태그의 셀 재지정
    let any = false;
    rawOvr.forEach((o, i) => {
      const cell = out.cells[i]!;
      if (o.height !== undefined) cell.height = o.height;
      if (o.color) cell.color = o.color;
      if (o.fill !== undefined) cell.fill = o.fill;
      if (o.textStyle) cell.textStyle = o.textStyle;
      if (o.height !== undefined || o.color || o.fill !== undefined || o.textStyle) any = true;
    });
    out.formatted = any;
  }
  return out;
}

/** 255자 조각(2 … 2, 마지막 1)과 R2007 이전의 비ASCII 7바이트 세기 */
function textChunks(text: string, utf8: boolean): string[] {
  const out: string[] = [];
  let cur = '';
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ch = text[i]!;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      ch += text[i + 1]!;
      i++;
    }
    const n = utf8 ? ch.length : c < 0x80 ? 1 : 7 * ch.length;
    if (size + n > 250) {
      out.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out;
}

export interface TableTagOptions {
  /** 표 스타일 핸들(없으면 '0') */
  style: string;
  /** 그림 블록 레코드 핸들 */
  blockRec: string;
  direction: Vec3;
  /** 대상 DXF 버전 번호(1018 …) */
  ver: number;
  /** 쓸 수 있는 문자 스타일 이름인지(셀 재지정 7) */
  styleOk?: (name: string) => boolean;
  /** 0 위에서 아래로, 1 아래에서 위로 */
  flow?: number;
}

/**
 * 셀 배치 → AcDbTable 태그(100 AcDbTable부터, AutoCAD DXF 순서).
 * R2004: 셀마다 171…145, 문자(2 … 1), 재지정. R2007+: 171…145, 재지정, CELL_VALUE…ACVALUE_END.
 */
export function acdbTableTags(lay: TableOut, o: TableTagOptions): RawTag[] {
  const ver = o.ver;
  const out: RawTag[] = [];
  const t = (code: number, value: string | number) => out.push({ code, value });
  t(100, 'AcDbTable');
  if (ver >= 1024) t(280, 0);
  t(342, o.style || '0');
  t(343, o.blockRec || '0');
  t(11, o.direction.x);
  t(21, o.direction.y);
  t(31, o.direction.z);
  // 90: 0x02·0x04 블록 있음, 0x10 위에서 아래로(AutoCAD 기본 22)
  t(90, (o.flow ?? lay.style?.flow) === 1 ? 6 : 22);
  t(91, lay.rows);
  t(92, lay.cols);
  t(93, 0);
  t(94, 0);
  t(95, 0);
  t(96, 0);
  for (const h of lay.rowHeights) t(141, h);
  for (const c of lay.colWidths) t(142, c);
  const aci = (c: CadColor): number => (c.aci >= 0 && c.aci <= 257 ? c.aci : 7);
  for (const c of lay.cells) {
    const text = c.text;
    const styleName = c.textStyle && (!o.styleOk || o.styleOk(c.textStyle)) ? c.textStyle : undefined;
    // 셀 재지정 플래그(사양 20.4.96.1): 1 정렬, 2 채우기 없음 여부, 4 배경색, 8 문자 색, 0x10 문자 스타일, 0x20 문자 높이
    let flags = 0;
    if (c.align) flags |= 0x01;
    if (c.fill) flags |= 0x02 | 0x04;
    if (c.color) flags |= 0x08;
    if (styleName) flags |= 0x10;
    if (c.height && c.height > 0) flags |= 0x20;
    t(171, 1);
    t(172, 0);
    // 173: 다른 셀에 병합된 셀, 175·176: 병합 기준 셀이 덮는 열·행 수
    t(173, c.covered ? 1 : 0);
    t(174, 0);
    t(175, c.spanCols);
    t(176, c.spanRows);
    t(ver >= 1021 ? 91 : 177, flags);
    t(178, 0);
    t(145, 0);
    if (ver < 1021) {
      const parts = textChunks(text, false);
      for (let k = 0; k < parts.length - 1; k++) t(2, parts[k]!);
      t(1, parts[parts.length - 1]!);
    }
    // 재지정 값: AutoCAD DXF 순서(170, 63, 64, 283, 140). 셀의 283은 "채우기 없음"이라 채울 때 0이다(표본 DXF·*T 블록으로 확인)
    if (flags & 0x01) t(170, c.align!);
    if (flags & 0x04) t(63, aci(c.fill!));
    if (flags & 0x08) t(64, aci(c.color!));
    if (flags & 0x02) t(283, 0);
    if (flags & 0x10) t(7, styleName!);
    if (flags & 0x20) t(140, c.height!);
    if (ver >= 1021) {
      t(92, 0);
      t(301, 'CELL_VALUE');
      t(93, text ? 6 : 7);
      t(90, text ? 4 : 0);
      if (text) t(1, text);
      t(94, 0);
      t(300, '');
      t(302, text);
      t(304, 'ACVALUE_END');
    }
  }
  return out;
}
