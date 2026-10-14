/**
 * DWG 표·테이블 스타일 본문을 DXF와 같은 원본 태그로(io/tablecells.ts·io/tablestyle.ts의 태그 배치).
 * 모델의 raw로 두면 DXF 쓰기·표 편집(rawTableCells)·DWG 다른 버전 쓰기가 DXF에서 읽은 표와 같은 길을 쓴다.
 */
import type { RawTag, TableEntity } from '../../../core/model';
import { acdbTableTags } from '../../tablecells';
import { tableStyleTags } from '../../tablestyle';
import { type TTableOld, type TTableR24, readIO, tableOld, tableR24, tableStyleOld, tableStyleR24 } from '../tablecodec';
import { layoutFromOld, layoutFromR24, styleFromOld, styleFromR24 } from '../tablemodel';
import { R2010 } from '../version';
import { hex } from './nonentities';
import type { ObjectReader } from './reader';

export interface DecodedTable {
  raw: RawTag[];
  rows: number;
  columns: number;
  rowHeights: number[];
  columnWidths: number[];
  cells: { text: string }[];
  tableStyle: string;
}

/**
 * 표 본문(INSERT 자료·핸들 다음 위치)을 풀어 원본 태그와 크기·셀 문자를 돌려준다.
 * 자료 흐름을 끝까지 맞게 읽지 못하면 null.
 */
export function decodeTableBody(or: ObjectReader, e: TableEntity, styleName: (h: number) => string): DecodedTable | null {
  const r = or.dat;
  const ver = or.ver;
  const io = readIO(r, or.hdl, or.h.handle, ver);
  let t: TTableR24 | TTableOld;
  try {
    t = ver >= R2010 ? tableR24(io) : tableOld(io);
  } catch {
    return null;
  }
  const end = r.end;
  if (r.overflowed() || !(r.pos === end || r.pos === end - 1)) return null;
  const lay = ver >= R2010 ? layoutFromR24(t as TTableR24, styleName) : layoutFromOld(t as TTableOld, styleName);
  const tableStyle = hex(ver >= R2010 ? (t as TTableR24).content.tableStyle : (t as TTableOld).tableStyle);
  const flow = ver >= R2010 ? ((t as TTableR24).bs & 0x10 ? 0 : 1) : (t as TTableOld).flags & 0x10 ? 0 : 1;
  const raw = acdbTableTags(lay, { style: tableStyle || '0', blockRec: '0', direction: ver >= R2010 ? (t as TTableR24).direction : (t as TTableOld).direction, ver: Math.max(ver, 1018), flow });
  void e;
  return {
    raw,
    rows: lay.rows,
    columns: lay.cols,
    rowHeights: lay.rowHeights,
    columnWidths: lay.colWidths,
    cells: lay.cells.map((c) => ({ text: c.text })),
    tableStyle,
  };
}

/** TABLESTYLE 본문(공통 자료 다음) → DXF 태그(문서 버전의 배치). 풀지 못하면 null */
export function decodeTableStyleBody(or: ObjectReader, styleName: (h: number) => string): RawTag[] | null {
  const r = or.dat;
  const ver = or.ver;
  const io = readIO(r, or.hdl, or.h.handle, ver);
  try {
    const s = ver >= R2010 ? styleFromR24(tableStyleR24(io), styleName) : styleFromOld(tableStyleOld(io), styleName);
    const end = r.end;
    if (r.overflowed() || !(r.pos === end || r.pos === end - 1)) return null;
    return tableStyleTags(s, Math.max(ver, 1018));
  } catch {
    return null;
  }
}
