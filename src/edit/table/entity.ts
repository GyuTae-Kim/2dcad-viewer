/**
 * 표 객체(ACAD_TABLE) ↔ 표 정의.
 *
 * 모델의 ACAD_TABLE은 행·열 크기와 셀 문자만 가진다. 병합·행 종류·셀 정렬·준 행 높이는 확장 자료
 * OPENCAD_TABLE에 남긴다(DXF·DWG 모두 그대로 저장된다). AutoCAD가 쓴 표는 원본 태그의 셀 병합(173·175·176)과
 * 셀 정렬(170)을 읽는다. 표를 블록 참조로 저장한 파일(DWG 쓰기)도 확장 자료가 있으면 다시 표로 읽을 수 있다.
 */
import type { CadDocument, Entity, InsertEntity, RawTag, TableEntity, XData, XDataItem } from '../../core/model';
import type { CellKind, TableStyle } from './style';
import { findTableStyle, isMetric, defaultTableStyle, type TableStyleEntry } from './style';
import type { CellData, Merge, TableData } from './model';
import { decodeCadEscapes } from '../../core/codepage';

export const TABLE_APP = 'OPENCAD_TABLE';

const KIND_CODE: Record<CellKind, number> = { data: 0, title: 1, header: 2 };
const CODE_KIND: CellKind[] = ['data', 'title', 'header'];

/** 확장 자료 문자열 한 조각의 최대 글자 수(DXF 1000 그룹 255바이트 제한 안쪽) */
const CHUNK = 80;
/** 셀 문자를 확장 자료에 담는 최대 글자 수(AutoCAD 확장 자료 16KB 제한 안쪽) */
const MAX_TEXT = 4000;

function chunks(s: string): string[] {
  const out: string[] = [];
  const cps = Array.from(s);
  for (let i = 0; i < cps.length; i += CHUNK) out.push(cps.slice(i, i + CHUNK).join(''));
  return out.length ? out : [''];
}

export function encodeTableXData(t: TableData): XData {
  const it: XDataItem[] = [];
  const s = (v: string) => it.push({ code: 1000, value: v });
  const i32 = (v: number) => it.push({ code: 1071, value: Math.round(v) });
  const r = (v: number) => it.push({ code: 1040, value: v });
  s('OPENCAD_TABLE 1');
  s('size');
  i32(t.rows);
  i32(t.cols);
  s('rowh');
  i32(t.rows);
  t.rowHeights.forEach(r);
  s('baseh');
  i32(t.rows);
  t.baseRowHeights.forEach(r);
  s('colw');
  i32(t.cols);
  t.colWidths.forEach(r);
  s('kinds');
  i32(t.rows);
  t.rowKinds.forEach((k) => i32(KIND_CODE[k]));
  s('merge');
  i32(t.merges.length);
  for (const m of t.merges) (i32(m.row), i32(m.col), i32(m.rows), i32(m.cols));
  const aligned = t.cells.map((c, i) => [i, c.align ?? 0] as const).filter(([, a]) => a >= 1 && a <= 9);
  s('align');
  i32(aligned.length);
  for (const [i, a] of aligned) (i32(i), i32(a));
  const texts = t.cells.map((c, i) => [i, c.text] as const).filter(([, x]) => x);
  const total = texts.reduce((a, [, x]) => a + x.length, 0);
  if (total <= MAX_TEXT) {
    s('text');
    i32(texts.length);
    for (const [i, x] of texts) {
      const parts = chunks(x);
      i32(i);
      i32(parts.length);
      parts.forEach(s);
    }
  }
  return { app: TABLE_APP, items: it };
}

export interface DecodedTable {
  rows: number;
  cols: number;
  rowHeights?: number[];
  baseRowHeights?: number[];
  colWidths?: number[];
  rowKinds?: CellKind[];
  merges: Merge[];
  aligns: Map<number, number>;
  texts?: Map<number, string>;
}

export function decodeTableXData(x: XData | undefined): DecodedTable | null {
  if (!x || x.app.toUpperCase() !== TABLE_APP) return null;
  const items = x.items;
  let i = 0;
  const next = (): XDataItem | undefined => items[i++];
  const int = (): number => {
    const v = next()?.value;
    return typeof v === 'number' ? Math.round(v) : Number(v) || 0;
  };
  const real = (): number => {
    const v = next()?.value;
    return typeof v === 'number' ? v : Number(v) || 0;
  };
  const first = next();
  if (!first || typeof first.value !== 'string' || !first.value.startsWith('OPENCAD_TABLE')) return null;
  const out: DecodedTable = { rows: 0, cols: 0, merges: [], aligns: new Map() };
  try {
    while (i < items.length) {
      const tag = next();
      if (!tag || tag.code !== 1000) break;
      switch (tag.value) {
        case 'size':
          out.rows = int();
          out.cols = int();
          break;
        case 'rowh': {
          const n = int();
          out.rowHeights = Array.from({ length: n }, real);
          break;
        }
        case 'baseh': {
          const n = int();
          out.baseRowHeights = Array.from({ length: n }, real);
          break;
        }
        case 'colw': {
          const n = int();
          out.colWidths = Array.from({ length: n }, real);
          break;
        }
        case 'kinds': {
          const n = int();
          out.rowKinds = Array.from({ length: n }, () => CODE_KIND[int()] ?? 'data');
          break;
        }
        case 'merge': {
          const n = int();
          for (let k = 0; k < n; k++) out.merges.push({ row: int(), col: int(), rows: int(), cols: int() });
          break;
        }
        case 'align': {
          const n = int();
          for (let k = 0; k < n; k++) {
            const idx = int();
            out.aligns.set(idx, int());
          }
          break;
        }
        case 'text': {
          const n = int();
          out.texts = new Map();
          for (let k = 0; k < n; k++) {
            const idx = int();
            const parts = int();
            let s = '';
            for (let p = 0; p < parts; p++) s += String(next()?.value ?? '');
            out.texts.set(idx, s);
          }
          break;
        }
        default:
          return out;
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** AutoCAD 원본 태그(AcDbTable)의 셀 병합과 셀 정렬 */
export function rawTableCells(raw: readonly RawTag[] | undefined): { merges: Merge[]; aligns: Map<number, number>; count: number } {
  const out = { merges: [] as Merge[], aligns: new Map<number, number>(), count: 0 };
  if (!raw) return out;
  const start = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbTable');
  if (start < 0) return out;
  let cols = 0;
  let cell = -1;
  let seen = new Set<number>();
  let span: { w: number; h: number } = { w: 1, h: 1 };
  const flush = () => {
    if (cell >= 0 && cols > 0 && (span.w > 1 || span.h > 1)) out.merges.push({ row: Math.floor(cell / cols), col: cell % cols, rows: Math.max(1, span.h), cols: Math.max(1, span.w) });
  };
  for (let k = start + 1; k < raw.length; k++) {
    const t = raw[k]!;
    if (t.code === 100) break;
    if (cell < 0 && t.code === 92 && !cols) cols = Number(t.value) || 0;
    if (t.code === 171) {
      flush();
      cell++;
      seen = new Set();
      span = { w: 1, h: 1 };
      continue;
    }
    if (cell < 0 || seen.has(t.code)) continue;
    if (t.code === 175) span.w = Number(t.value) || 1;
    else if (t.code === 176) span.h = Number(t.value) || 1;
    else if (t.code === 170) {
      const a = Number(t.value);
      if (a >= 1 && a <= 9) out.aligns.set(cell, a);
    } else continue;
    seen.add(t.code);
  }
  flush();
  out.count = cell + 1;
  // 겹치는 병합은 앞의 것만
  const taken = new Set<number>();
  out.merges = out.merges.filter((m) => {
    const keys: number[] = [];
    for (let r = m.row; r < m.row + m.rows; r++) for (let c = m.col; c < m.col + m.cols; c++) keys.push(r * cols + c);
    if (keys.some((x) => taken.has(x))) return false;
    keys.forEach((x) => taken.add(x));
    return true;
  });
  return out;
}

/** 표로 편집할 수 있는 객체인지(ACAD_TABLE, 또는 표 확장 자료가 있는 블록 참조) */
export function isEditableTable(e: Entity | undefined): e is TableEntity | InsertEntity {
  if (!e) return false;
  if (e.type === 'ACAD_TABLE') return true;
  if (e.type !== 'INSERT') return false;
  const d = decodeTableXData(e.xdata?.find((x) => x.app.toUpperCase() === TABLE_APP));
  return !!d && d.rows > 0 && d.cols > 0 && !!d.rowHeights && !!d.colWidths;
}

export interface ReadTable {
  data: TableData;
  style: TableStyle;
  styleEntry: TableStyleEntry | null;
}

/** 표 객체에서 표 정의를 읽는다 */
export function tableFromEntity(e: TableEntity | InsertEntity, doc: CadDocument): ReadTable | null {
  const x = decodeTableXData(e.xdata?.find((q) => q.app.toUpperCase() === TABLE_APP));
  const te = e.type === 'ACAD_TABLE' ? e : null;
  const rows = te ? te.rows : (x?.rows ?? 0);
  const cols = te ? te.columns : (x?.cols ?? 0);
  if (!(rows > 0 && cols > 0)) return null;
  const xok = !!x && x.rows === rows && x.cols === cols;
  const styleEntry = findTableStyle(doc, te?.tableStyle) ?? findTableStyle(doc, 'Standard');
  const style = styleEntry?.style ?? defaultTableStyle(isMetric(doc));
  const pick = (a: number[] | undefined, b: number[] | undefined, n: number, d: number): number[] =>
    Array.from({ length: n }, (_, i) => {
      const v = a?.[i] ?? b?.[i] ?? b?.[b.length - 1];
      return typeof v === 'number' && v > 0 ? v : d;
    });
  const rowHeights = pick(te?.rowHeights, xok ? x!.rowHeights : undefined, rows, 1);
  const colWidths = pick(te?.columnWidths, xok ? x!.colWidths : undefined, cols, 1);
  const baseRowHeights = xok && x!.baseRowHeights?.length === rows ? x!.baseRowHeights.map((v, i) => Math.min(v, rowHeights[i]!)) : [...rowHeights];
  const raw = te ? rawTableCells(te.raw) : { merges: [], aligns: new Map<number, number>(), count: 0 };
  const cells: CellData[] = Array.from({ length: rows * cols }, (_, i) => {
    // R2007 이전 DXF는 비ASCII 문자를 \U+XXXX로 쓰고 리더는 문자 내용을 그대로 둔다 → 편집할 수 있게 푼다
    const text = decodeCadEscapes(te?.cells?.[i]?.text ?? (xok ? (x!.texts?.get(i) ?? '') : ''));
    const c: CellData = { text };
    const a = xok ? x!.aligns.get(i) : raw.aligns.get(i);
    if (a) c.align = a;
    return c;
  });
  let rowKinds: CellKind[];
  if (xok && x!.rowKinds?.length === rows) rowKinds = x!.rowKinds;
  else {
    rowKinds = Array.from({ length: rows }, () => 'data' as CellKind);
    let r = 0;
    if (!style.titleSuppressed && rows > 1) rowKinds[r++] = 'title';
    if (!style.headerSuppressed && rows > r + 1) rowKinds[r] = 'header';
  }
  const merges = (xok ? x!.merges : raw.merges).filter((m) => m.row >= 0 && m.col >= 0 && m.row + m.rows <= rows && m.col + m.cols <= cols && m.rows * m.cols > 1);
  return { data: { rows, cols, rowHeights, baseRowHeights, colWidths, cells, rowKinds, merges }, style, styleEntry };
}

/** 표 정의를 표 객체 값에 옮긴다(원본 태그·DWG 원본은 맞지 않으므로 뺀다) */
export function applyTableData(e: TableEntity, t: TableData, styleHandle: string | undefined): TableEntity {
  const r: TableEntity = { ...e };
  r.rows = t.rows;
  r.columns = t.cols;
  r.rowHeights = [...t.rowHeights];
  r.columnWidths = [...t.colWidths];
  r.cells = t.cells.map((c) => ({ text: c.text }));
  if (styleHandle) r.tableStyle = styleHandle;
  else delete r.tableStyle;
  r.xdata = [...(e.xdata ?? []).filter((x) => x.app.toUpperCase() !== TABLE_APP), encodeTableXData(t)];
  delete r.raw;
  delete r.rawVersion;
  delete r.dwgRaw;
  return r;
}
