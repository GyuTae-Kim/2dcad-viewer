/**
 * 표 내보내기(TABLEEXPORT)와 셀 특성 일치(MATCHCELL)의 순수 계산(화면·DOM 없음).
 * - CSV: 쉼표로 나누고, 쉼표·큰따옴표·줄바꿈·앞뒤 공백이 있는 칸은 큰따옴표로 감싸며 안의 큰따옴표는 두 번 쓴다(RFC 4180).
 *   셀 문자는 여러 줄 문자 서식을 걷어 내고 문단(\P)은 칸 안의 줄바꿈으로 둔다. 병합된 셀은 기준 셀에만 문자가 있다.
 * - MATCHCELL: 원본 셀의 정렬(셀 재지정이 없으면 그 행 셀 스타일의 정렬)을 대상 셀에 옮긴다.
 *   대상 행 스타일의 정렬과 같으면 재지정을 지운다(이 표 모델의 셀 특성은 정렬 재지정뿐이다).
 */
import { mtextPlainLines } from '../../io/dxf/wconvert';
import { type TableData, anchorOf, cellIndex, getText, setAlign } from '../table/model';
import type { TableStyle } from '../table/style';

/** CSV 칸 하나 */
export function csvField(s: string): string {
  if (s === '') return '';
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 셀 문자 → 평문(여러 줄 문자 서식 제거, 문단은 줄바꿈) */
export function cellPlainText(raw: string): string {
  if (!raw) return '';
  return mtextPlainLines(raw).join('\n');
}

/** 표 → CSV 글(줄 끝 CRLF, 마지막 줄 뒤에도 CRLF) */
export function tableToCsv(t: TableData, plain: (raw: string) => string = cellPlainText): string {
  const lines: string[] = [];
  for (let r = 0; r < t.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < t.cols; c++) {
      const a = anchorOf(t, r, c);
      row.push(a.r === r && a.c === c ? csvField(plain(getText(t, r, c))) : '');
    }
    lines.push(row.join(','));
  }
  return lines.map((l) => `${l}\r\n`).join('');
}

/** CSV 파일 내용(엑셀이 한글을 바로 읽게 UTF-8 BOM을 붙인다) */
export function csvFileText(t: TableData): string {
  return `﻿${tableToCsv(t)}`;
}

/** 셀의 실제 정렬(재지정 또는 행 셀 스타일) */
export function effectiveAlign(t: TableData, style: TableStyle, r: number, c: number): number {
  const a = anchorOf(t, r, c);
  const own = t.cells[cellIndex(t, a.r, a.c)]?.align;
  if (own && own >= 1 && own <= 9) return own;
  return style.cells[t.rowKinds[a.r] ?? 'data'].align;
}

/**
 * 원본 셀의 특성(정렬)을 대상 셀에 옮긴 표. 바뀐 것이 없으면 null.
 * 원본·대상은 같은 표 스타일의 같은 표이거나, 원본 표의 정렬 값을 받아 대상 표에 적용한다(srcAlign).
 */
export function matchCellAlign(t: TableData, style: TableStyle, dst: { r: number; c: number }, srcAlign: number): TableData | null {
  const a = anchorOf(t, dst.r, dst.c);
  const idx = cellIndex(t, a.r, a.c);
  const cur = t.cells[idx]?.align;
  const rowDefault = style.cells[t.rowKinds[a.r] ?? 'data'].align;
  const want = srcAlign === rowDefault ? undefined : srcAlign;
  if (cur === want || (!cur && want === undefined)) return null;
  return setAlign(t, a.r, a.c, a.r, a.c, want ?? 0);
}
