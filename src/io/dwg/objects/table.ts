/**
 * ACAD_TABLE 셀 자료.
 * R2010+는 표 내용(AcDbTableContent, 사양 20.4.97~20.4.101)이 도형 자료 안에 들어 있고,
 * R2007까지는 옛 셀 구조(사양 20.4.96.1)다. 행·열 크기와 셀 문자만 꺼낸다.
 */
import type { TableEntity } from '../../../core/model';
import { type BitReader, DwgFormatError } from '../bitstream';
import { R2007, R2010, R2013 } from '../version';
import type { ObjectReader } from './reader';

/** 값(20.4.99): 문자열이면 돌려준다 */
function readValue(or: ObjectReader): string | undefined {
  const r = or.dat;
  const ver = or.ver;
  let flags = 0;
  if (ver >= R2007) flags = r.BL();
  const type = r.BL();
  let out: string | undefined;
  if (!(flags & 1)) {
    switch (type) {
      case 0:
      case 1:
        r.BL();
        break;
      case 2:
        r.BD();
        break;
      case 4:
        if (ver < R2007) out = r.TV();
        else {
          // R2007+: 바이트 수(BL) + UTF-16LE 바이트가 자료 흐름에 있다(표본으로 확인)
          const n = r.checkCount(r.BL(), 8);
          const codes: number[] = [];
          for (let i = 0; i + 1 < n; i += 2) codes.push(r.RSu());
          if (n & 1) r.RC();
          let len = codes.length;
          while (len > 0 && codes[len - 1] === 0) len--;
          out = String.fromCharCode(...codes.slice(0, len));
        }
        break;
      case 8:
      case 16:
      case 32:
      case 512: {
        const n = r.checkCount(r.BL(), 8);
        r.pos += n * 8;
        break;
      }
      case 64:
        or.hdl.H(or.h.handle);
        break;
      default:
        throw new DwgFormatError(`표 값 종류 ${type}`);
    }
  }
  if (ver >= R2007) {
    r.BL(); // 단위
    r.TV(); // 형식
    const vs = r.TV(); // 값 문자열
    if (out === undefined && vs) out = vs;
  }
  return out;
}

function readCustomData(or: ObjectReader): void {
  const r = or.dat;
  const n = r.checkCount(r.BL(), 8);
  for (let i = 0; i < n; i++) {
    r.TV();
    readValue(or);
  }
}

/** 내용 형식(20.4.101.3) */
function readContentFormat(or: ObjectReader): void {
  const r = or.dat;
  r.BL(); // 재지정 플래그
  r.BL(); // 속성 플래그
  r.BL(); // 값 자료 종류
  r.BL(); // 값 단위
  r.TV(); // 값 형식
  r.BD(); // 회전
  r.BD(); // 블록 축척
  r.BL(); // 정렬
  r.CMC(); // 내용 색
  or.hdl.H(or.h.handle); // 문자 스타일
  r.BD(); // 문자 높이
}

/** 셀 스타일(20.4.101.4) */
function readCellStyle(or: ObjectReader): void {
  const r = or.dat;
  r.BL(); // 종류
  const data = r.BS();
  if (!data) return;
  r.BL();
  r.BL();
  r.CMC();
  r.BL();
  readContentFormat(or);
  if (r.BS() & 1) for (let i = 0; i < 6; i++) r.BD();
  const nb = r.checkCount(r.BL(), 2);
  for (let i = 0; i < nb; i++) {
    if (r.BL()) {
      r.BL();
      r.BL();
      r.CMC();
      r.BL();
      or.hdl.H(or.h.handle);
      r.BL();
      r.BD();
    }
  }
}

/** R2010+: INSERT 자료 다음의 표 내용 */
export function readTableContentR24(or: ObjectReader, e: TableEntity): void {
  const r = or.dat;
  const ver = or.ver;
  const hb = or.h.handle;
  r.RC();
  or.hdl.H(hb);
  r.BL();
  if (ver >= R2013) r.BL();
  else if (ver >= R2010) r.B();
  // AcDbLinkedData
  r.TV();
  r.TV();
  // AcDbLinkedTableData
  const nc = r.checkCount(r.BL(), 16);
  const widths: number[] = [];
  for (let i = 0; i < nc; i++) {
    r.TV();
    r.BL();
    readCustomData(or);
    readCellStyle(or);
    r.BL();
    widths.push(r.BD());
  }
  const nr = r.checkCount(r.BL(), 8);
  const heights: number[] = [];
  const cells: { text: string }[] = [];
  for (let row = 0; row < nr; row++) {
    const ncell = r.checkCount(r.BL(), 16);
    for (let c = 0; c < ncell; c++) {
      r.BL(); // 상태
      r.TV(); // 도움말
      r.BL();
      readCustomData(or);
      if (r.BL()) {
        or.hdl.H(hb);
        r.BL();
        r.BL();
        r.BL();
      }
      const ncontent = r.checkCount(r.BL(), 8);
      let text = '';
      for (let k = 0; k < ncontent; k++) {
        const ctype = r.BL();
        if (ctype === 1) {
          const v = readValue(or);
          if (v && !text) text = v;
        } else if (ctype === 2 || ctype === 4) {
          or.hdl.H(hb);
        }
        const na = r.checkCount(r.BL(), 8);
        for (let a = 0; a < na; a++) {
          or.hdl.H(hb);
          r.TV();
          r.BL();
        }
        const hasOv = r.BS();
        if (hasOv) readContentFormat(or);
      }
      readCellStyle(or);
      r.BL();
      if (r.BL()) {
        r.BL();
        r.BD();
        r.BD();
        const geom = r.BL();
        or.hdl.H(hb);
        if (geom) {
          r.BD3();
          r.BD3();
          r.BD();
          r.BD();
          r.BD();
          r.BD();
          r.BL();
        }
      }
      cells.push({ text });
    }
    r.BL();
    readCustomData(or);
    readCellStyle(or);
    r.BL();
    heights.push(r.BD());
  }
  e.columns = nc;
  e.rows = nr;
  e.columnWidths = widths;
  e.rowHeights = heights;
  if (cells.length === nc * nr) e.cells = cells;
  // 필드 참조, AcDbFormattedTableData(셀 스타일·병합 범위), 표 스타일 핸들
  const nf = r.checkCount(r.BL(), 2);
  for (let i = 0; i < nf; i++) or.hdl.H(hb);
  readCellStyle(or);
  const nm = r.checkCount(r.BL(), 8);
  for (let i = 0; i < nm; i++) {
    r.BL();
    r.BL();
    r.BL();
    r.BL();
  }
  const style = or.hdl.H(hb);
  if (style) e.tableStyle = style.toString(16).toUpperCase();
}

/** R2007까지: 옛 셀 구조에서 행·열과 셀 문자 */
export function readTableCellsOld(or: ObjectReader, e: TableEntity): void {
  const r: BitReader = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = or.h.handle;
  r.BS(); // 값 플래그
  e.direction = r.BD3();
  const nc = r.checkCount(r.BL(), 16);
  const nr = r.checkCount(r.BL(), 16);
  e.columns = nc;
  e.rows = nr;
  e.columnWidths = [];
  e.rowHeights = [];
  for (let i = 0; i < nc; i++) e.columnWidths.push(r.BD());
  for (let i = 0; i < nr; i++) e.rowHeights.push(r.BD());
  // 핸들 흐름: (블록 헤더·속성·SEQEND는 이미 읽음) 표 스타일, 그리고 셀마다의 핸들
  const style = hr.H(hb);
  if (style) e.tableStyle = style.toString(16).toUpperCase();
  const cells: { text: string }[] = [];
  for (let i = 0; i < nc * nr; i++) {
    const type = r.BS();
    r.RC(); // 모서리 플래그
    r.B(); // 병합
    r.B(); // 자동 맞춤
    r.BL(); // 병합 폭
    r.BL(); // 병합 높이
    r.BD(); // 회전
    const cellH = hr.H(hb);
    let text = '';
    if (type === 1) {
      if (!cellH) text = r.TV();
    } else if (type === 2) {
      r.BD();
      if (r.B()) {
        const n = r.BS();
        for (let k = 0; k < n; k++) {
          r.BS();
          r.TV();
          hr.H(hb);
        }
      }
    }
    if (r.B()) {
      const f = r.BL();
      r.RC();
      if (f & 0x01) r.RS();
      if (f & 0x02) r.B();
      if (f & 0x04) r.CMC();
      if (f & 0x08) r.CMC();
      if (f & 0x10) hr.H(hb);
      if (f & 0x20) r.BD();
      for (const [cBit, lwBit, vBit] of [
        [0x40, 0x400, 0x4000],
        [0x80, 0x800, 0x8000],
        [0x100, 0x1000, 0x10000],
        [0x200, 0x2000, 0x20000],
      ]) {
        if (f & cBit) r.CMC();
        if (f & lwBit) r.BS();
        if (f & vBit) r.BS();
      }
    }
    if (ver >= R2007) {
      r.BL();
      const v = readValue(or);
      if (!text && v) text = v;
    }
    cells.push({ text });
  }
  e.cells = cells;
}
