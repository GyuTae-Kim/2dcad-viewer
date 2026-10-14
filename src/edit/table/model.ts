/**
 * 표 정의(행·열·셀 문자·병합·행 종류)와 순수 편집 연산.
 *
 * 표 좌표: 삽입점이 원점, X는 오른쪽, 행은 표 방향(아래로 = −Y, 위로 = +Y)으로 쌓인다.
 * 셀은 행 우선(행 r, 열 c → r × cols + c). 병합된 셀은 왼쪽 위 셀(기준 셀)만 문자를 가진다.
 */
import type { CellKind, TableStyle } from './style';
import { rowHeightForLines } from './style';

export interface CellData {
  text: string;
  /** 셀 정렬 재지정(1~9). 없으면 행 종류의 셀 스타일 */
  align?: number;
}

export interface Merge {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface TableData {
  rows: number;
  cols: number;
  /** 실제 행 높이(문자에 맞춰 늘어난 값) */
  rowHeights: number[];
  /** 준 행 높이(문자를 지우면 여기까지 돌아온다) */
  baseRowHeights: number[];
  colWidths: number[];
  cells: CellData[];
  /** 행마다 셀 스타일 종류 */
  rowKinds: CellKind[];
  merges: Merge[];
}

export interface NewTableOptions {
  cols: number;
  colWidth: number;
  dataRows: number;
  /** 행 높이(줄 수) */
  rowLines: number;
  /** 첫 번째·두 번째 행의 셀 스타일 */
  first: CellKind;
  second: CellKind;
}

/** 새 표: 제목 행은 모든 열을 병합한다(AutoCAD 기본 표 스타일의 "행/열 작성 시 셀 병합") */
export function createTable(o: NewTableOptions, style: TableStyle): TableData {
  const cols = Math.max(1, Math.floor(o.cols));
  const kinds: CellKind[] = [];
  if (o.first !== 'data') kinds.push(o.first);
  if (o.second !== 'data') kinds.push(o.second);
  for (let i = 0; i < Math.max(1, Math.floor(o.dataRows)); i++) kinds.push('data');
  const rows = kinds.length;
  const rowHeights = kinds.map((k) => rowHeightForLines(o.rowLines, style.cells[k].height, style.vMargin));
  const t: TableData = {
    rows,
    cols,
    rowHeights,
    baseRowHeights: [...rowHeights],
    colWidths: Array.from({ length: cols }, () => o.colWidth),
    cells: Array.from({ length: rows * cols }, () => ({ text: '' })),
    rowKinds: kinds,
    merges: [],
  };
  kinds.forEach((k, r) => {
    if (k === 'title' && cols > 1) t.merges.push({ row: r, col: 0, rows: 1, cols });
  });
  return t;
}

export function cloneTable(t: TableData): TableData {
  return structuredClone(t);
}

export function cellIndex(t: TableData, r: number, c: number): number {
  return r * t.cols + c;
}

/** 셀을 덮는 병합(없으면 null) */
export function mergeAt(t: TableData, r: number, c: number): Merge | null {
  for (const m of t.merges) if (r >= m.row && r < m.row + m.rows && c >= m.col && c < m.col + m.cols) return m;
  return null;
}

/** 셀의 기준 셀(병합된 셀이면 왼쪽 위) */
export function anchorOf(t: TableData, r: number, c: number): { r: number; c: number } {
  const m = mergeAt(t, r, c);
  return m ? { r: m.row, c: m.col } : { r, c };
}

export function getText(t: TableData, r: number, c: number): string {
  const a = anchorOf(t, r, c);
  return t.cells[cellIndex(t, a.r, a.c)]?.text ?? '';
}

export function setText(t: TableData, r: number, c: number, text: string): TableData {
  const out = cloneTable(t);
  const a = anchorOf(out, r, c);
  out.cells[cellIndex(out, a.r, a.c)]!.text = text;
  return out;
}

/** 셀 정렬 재지정(범위, 0이면 지운다) */
export function setAlign(t: TableData, r0: number, c0: number, r1: number, c1: number, align: number): TableData {
  const out = cloneTable(t);
  const rr = order(r0, r1);
  const cc = order(c0, c1);
  for (let r = rr[0]; r <= rr[1]; r++)
    for (let c = cc[0]; c <= cc[1]; c++) {
      const cell = out.cells[cellIndex(out, r, c)]!;
      if (align >= 1 && align <= 9) cell.align = align;
      else delete cell.align;
    }
  return out;
}

function order(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/** 행 종류 바꾸기 */
export function setRowKind(t: TableData, r0: number, r1: number, kind: CellKind): TableData {
  const out = cloneTable(t);
  const [a, b] = order(r0, r1);
  for (let r = a; r <= b; r++) out.rowKinds[r] = kind;
  return out;
}

// ---------------------------------------------------------------------------
// 행·열 넣기·빼기
// ---------------------------------------------------------------------------

/** at 행 앞에 count개 행을 넣는다(at = rows이면 끝). 새 행은 이웃 행의 종류·준 높이를 받는다 */
export function insertRows(t: TableData, at: number, count = 1, opt: { kind?: CellKind; height?: number } = {}): TableData {
  const n = Math.max(1, Math.floor(count));
  const pos = Math.max(0, Math.min(t.rows, at));
  const ref = pos > 0 ? pos - 1 : 0;
  const kind = opt.kind ?? (t.rowKinds[pos] === 'data' || pos >= t.rows ? 'data' : (t.rowKinds[ref] ?? 'data'));
  const h = opt.height ?? t.baseRowHeights[pos < t.rows ? pos : ref] ?? t.rowHeights[ref] ?? 1;
  const out = cloneTable(t);
  const blank = (): CellData[] => Array.from({ length: t.cols }, () => ({ text: '' }));
  const newCells: CellData[] = [];
  for (let r = 0; r <= t.rows; r++) {
    if (r === pos) for (let k = 0; k < n; k++) newCells.push(...blank());
    if (r < t.rows) newCells.push(...out.cells.slice(r * t.cols, (r + 1) * t.cols));
  }
  out.cells = newCells;
  out.rows = t.rows + n;
  out.rowHeights.splice(pos, 0, ...Array.from({ length: n }, () => h));
  out.baseRowHeights.splice(pos, 0, ...Array.from({ length: n }, () => h));
  out.rowKinds.splice(pos, 0, ...Array.from({ length: n }, () => kind));
  out.merges = out.merges.map((m) => {
    if (m.row >= pos) return { ...m, row: m.row + n };
    if (m.row + m.rows > pos) return { ...m, rows: m.rows + n };
    return m;
  });
  return out;
}

/** r0~r1 행을 뺀다(모든 행은 뺄 수 없다) */
export function deleteRows(t: TableData, r0: number, r1: number): TableData | null {
  const [a, b] = order(Math.max(0, r0), Math.min(t.rows - 1, r1));
  const n = b - a + 1;
  if (n <= 0 || n >= t.rows) return null;
  const out = cloneTable(t);
  const merges: Merge[] = [];
  for (const m of t.merges) {
    const top = m.row;
    const bot = m.row + m.rows - 1;
    if (top >= a && bot <= b) continue;
    // 남는 맨 위 행(옛 번호): 빼는 범위 안에서 시작하면 범위 바로 아래 행
    const keepTop = top < a || top > b ? top : b + 1;
    // 기준 셀이 빠지면 문자를 새 기준 셀로 옮긴다
    if (top >= a && top <= b) out.cells[cellIndex(out, b + 1, m.col)]!.text ||= out.cells[cellIndex(out, top, m.col)]!.text;
    const removedInside = Math.max(0, Math.min(bot, b) - Math.max(top, a) + 1);
    const rows = m.rows - removedInside;
    const row = keepTop > b ? keepTop - n : keepTop;
    if (rows * m.cols > 1) merges.push({ ...m, row, rows });
  }
  out.cells.splice(a * t.cols, n * t.cols);
  out.rows = t.rows - n;
  out.rowHeights.splice(a, n);
  out.baseRowHeights.splice(a, n);
  out.rowKinds.splice(a, n);
  out.merges = merges;
  return out;
}

/** at 열 앞에 count개 열을 넣는다 */
export function insertCols(t: TableData, at: number, count = 1, width?: number): TableData {
  const n = Math.max(1, Math.floor(count));
  const pos = Math.max(0, Math.min(t.cols, at));
  const ref = pos > 0 ? pos - 1 : 0;
  const w = width ?? t.colWidths[pos < t.cols ? pos : ref] ?? 1;
  const out = cloneTable(t);
  const cols = t.cols + n;
  const cells: CellData[] = [];
  for (let r = 0; r < t.rows; r++)
    for (let c = 0; c <= t.cols; c++) {
      if (c === pos) for (let k = 0; k < n; k++) cells.push({ text: '' });
      if (c < t.cols) cells.push(out.cells[r * t.cols + c]!);
    }
  out.cells = cells;
  out.cols = cols;
  out.colWidths.splice(pos, 0, ...Array.from({ length: n }, () => w));
  out.merges = out.merges.map((m) => {
    if (m.col >= pos) return { ...m, col: m.col + n };
    if (m.col + m.cols > pos) return { ...m, cols: m.cols + n };
    return m;
  });
  return out;
}

export function deleteCols(t: TableData, c0: number, c1: number): TableData | null {
  const [a, b] = order(Math.max(0, c0), Math.min(t.cols - 1, c1));
  const n = b - a + 1;
  if (n <= 0 || n >= t.cols) return null;
  const out = cloneTable(t);
  const merges: Merge[] = [];
  for (const m of t.merges) {
    const left = m.col;
    const right = m.col + m.cols - 1;
    if (left >= a && right <= b) continue;
    if (left >= a && left <= b) out.cells[cellIndex(out, m.row, b + 1)]!.text ||= out.cells[cellIndex(out, m.row, left)]!.text;
    const removedInside = Math.max(0, Math.min(right, b) - Math.max(left, a) + 1);
    const cols = m.cols - removedInside;
    const keepLeft = left < a || left > b ? left : b + 1;
    const col = keepLeft > b ? keepLeft - n : keepLeft;
    if (cols * m.rows > 1) merges.push({ ...m, col, cols });
  }
  const cells: CellData[] = [];
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) if (c < a || c > b) cells.push(out.cells[r * t.cols + c]!);
  out.cells = cells;
  out.cols = t.cols - n;
  out.colWidths.splice(a, n);
  out.merges = merges;
  return out;
}

// ---------------------------------------------------------------------------
// 병합
// ---------------------------------------------------------------------------

export type MergeMode = 'all' | 'rows' | 'cols';

/** 범위를 걸치는 병합을 모두 담도록 넓힌다 */
export function expandRange(t: TableData, r0: number, c0: number, r1: number, c1: number): { r0: number; c0: number; r1: number; c1: number } {
  let [a, b] = order(r0, r1);
  let [c, d] = order(c0, c1);
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of t.merges) {
      const hit = m.row <= b && m.row + m.rows - 1 >= a && m.col <= d && m.col + m.cols - 1 >= c;
      if (!hit) continue;
      if (m.row < a) (a = m.row), (changed = true);
      if (m.row + m.rows - 1 > b) (b = m.row + m.rows - 1), (changed = true);
      if (m.col < c) (c = m.col), (changed = true);
      if (m.col + m.cols - 1 > d) (d = m.col + m.cols - 1), (changed = true);
    }
  }
  return { r0: a, c0: c, r1: b, c1: d };
}

/** 셀 병합: 모두(한 셀로)·행별(행마다 한 셀)·열별(열마다 한 셀). 문자는 각 묶음의 첫 문자를 남긴다 */
export function mergeCells(t: TableData, r0: number, c0: number, r1: number, c1: number, mode: MergeMode = 'all'): TableData | null {
  const g = expandRange(t, r0, c0, r1, c1);
  if (g.r0 === g.r1 && g.c0 === g.c1) return null;
  const out = cloneTable(t);
  out.merges = out.merges.filter((m) => !(m.row >= g.r0 && m.row + m.rows - 1 <= g.r1 && m.col >= g.c0 && m.col + m.cols - 1 <= g.c1));
  const groups: Merge[] = [];
  if (mode === 'all') groups.push({ row: g.r0, col: g.c0, rows: g.r1 - g.r0 + 1, cols: g.c1 - g.c0 + 1 });
  else if (mode === 'rows') for (let r = g.r0; r <= g.r1; r++) groups.push({ row: r, col: g.c0, rows: 1, cols: g.c1 - g.c0 + 1 });
  else for (let c = g.c0; c <= g.c1; c++) groups.push({ row: g.r0, col: c, rows: g.r1 - g.r0 + 1, cols: 1 });
  for (const m of groups) {
    const texts: string[] = [];
    for (let r = m.row; r < m.row + m.rows; r++)
      for (let c = m.col; c < m.col + m.cols; c++) {
        const cell = out.cells[cellIndex(out, r, c)]!;
        if (cell.text) texts.push(cell.text);
        if (r !== m.row || c !== m.col) cell.text = '';
      }
    out.cells[cellIndex(out, m.row, m.col)]!.text = texts[0] ?? '';
    if (m.rows * m.cols > 1) out.merges.push(m);
  }
  return out;
}

/** 셀 병합 해제(그 셀을 덮는 병합, 범위면 범위 안의 모든 병합) */
export function unmergeCells(t: TableData, r0: number, c0: number, r1 = r0, c1 = c0): TableData | null {
  const [a, b] = order(r0, r1);
  const [c, d] = order(c0, c1);
  const keep = t.merges.filter((m) => !(m.row <= b && m.row + m.rows - 1 >= a && m.col <= d && m.col + m.cols - 1 >= c));
  if (keep.length === t.merges.length) return null;
  const out = cloneTable(t);
  out.merges = keep;
  return out;
}

// ---------------------------------------------------------------------------
// 위치
// ---------------------------------------------------------------------------

export function tableWidth(t: TableData): number {
  return t.colWidths.reduce((a, b) => a + b, 0);
}

export function tableHeight(t: TableData): number {
  return t.rowHeights.reduce((a, b) => a + b, 0);
}

/** 행 r 위쪽(표 방향 기준 시작) 경계까지의 거리 */
export function rowOffset(t: TableData, r: number): number {
  let s = 0;
  for (let i = 0; i < r; i++) s += t.rowHeights[i] ?? 0;
  return s;
}

export function colOffset(t: TableData, c: number): number {
  let s = 0;
  for (let i = 0; i < c; i++) s += t.colWidths[i] ?? 0;
  return s;
}

/** 셀(병합이면 병합 범위)의 표 좌표 사각형 */
export function cellRect(t: TableData, r: number, c: number, flow: 0 | 1 = 0): { x0: number; x1: number; y0: number; y1: number } {
  const m = mergeAt(t, r, c) ?? { row: r, col: c, rows: 1, cols: 1 };
  const x0 = colOffset(t, m.col);
  const x1 = colOffset(t, m.col + m.cols);
  const d0 = rowOffset(t, m.row);
  const d1 = rowOffset(t, m.row + m.rows);
  return flow === 1 ? { x0, x1, y0: d0, y1: d1 } : { x0, x1, y0: -d1, y1: -d0 };
}

/** 표 좌표 점이 든 셀(밖이면 null) */
export function cellAt(t: TableData, x: number, y: number, flow: 0 | 1 = 0): { r: number; c: number } | null {
  const d = flow === 1 ? y : -y;
  if (x < 0 || d < 0) return null;
  let c = -1;
  for (let i = 0, s = 0; i < t.cols; i++) {
    s += t.colWidths[i]!;
    if (x <= s) {
      c = i;
      break;
    }
  }
  let r = -1;
  for (let i = 0, s = 0; i < t.rows; i++) {
    s += t.rowHeights[i]!;
    if (d <= s) {
      r = i;
      break;
    }
  }
  return r >= 0 && c >= 0 ? { r, c } : null;
}

/** 열 이름(A, B, … Z, AA …) */
export function columnName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 셀 이름(A1 …) */
export function cellName(r: number, c: number): string {
  return `${columnName(c)}${r + 1}`;
}

/**
 * 행 높이를 문자에 맞춘다: 준 높이보다 낮아지지 않고, 문자가 필요한 만큼 늘어난다.
 * measure(text, height, width, textStyle)는 여러 줄 문자의 높이를 돌려준다.
 */
export function fitRowHeights(t: TableData, style: TableStyle, measure: (text: string, height: number, width: number, textStyle: string) => number): TableData {
  const out = cloneTable(t);
  for (let r = 0; r < t.rows; r++) out.rowHeights[r] = out.baseRowHeights[r] ?? out.rowHeights[r]!;
  // 한 행짜리 셀이 먼저, 여러 행 병합은 마지막 행을 늘린다
  const needs: { r0: number; r1: number; h: number }[] = [];
  for (let r = 0; r < t.rows; r++)
    for (let c = 0; c < t.cols; c++) {
      const m = mergeAt(t, r, c);
      if (m && (m.row !== r || m.col !== c)) continue;
      const text = t.cells[cellIndex(t, r, c)]!.text;
      if (!text) continue;
      const cs = style.cells[t.rowKinds[r] ?? 'data'];
      const w = colOffset(t, c + (m?.cols ?? 1)) - colOffset(t, c) - 2 * style.hMargin;
      const h = measure(text, cs.height, Math.max(w, cs.height), cs.textStyle) + 2 * style.vMargin;
      needs.push({ r0: r, r1: r + (m?.rows ?? 1) - 1, h });
    }
  needs.sort((a, b) => a.r1 - a.r0 - (b.r1 - b.r0));
  for (const n of needs) {
    let have = 0;
    for (let r = n.r0; r <= n.r1; r++) have += out.rowHeights[r]!;
    if (n.h > have + 1e-9) out.rowHeights[n.r1]! += n.h - have;
  }
  return out;
}
