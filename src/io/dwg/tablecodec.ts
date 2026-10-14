/**
 * 표(ACAD_TABLE)·테이블 스타일(TABLESTYLE)의 DWG 본문 — 읽기와 쓰기가 같은 배치 함수 하나를 쓴다.
 *
 * 배치 함수는 `x.a = io.BL(x.a)`처럼 쓴다: 읽을 때 io는 값을 읽어 돌려주고(인자는 무시), 쓸 때는 인자를 써서 그대로
 * 돌려준다. 그래서 읽기·쓰기의 순서가 어긋날 수 없다. 핸들은 핸들 흐름에서 차례로 읽고 쓴다.
 *
 * - R2010+ 표(사양 20.4.96.2): INSERT 자료 다음 RC·H·BL·(R2010 B / R2013+ BL), 표 내용(20.4.97 AcDbLinkedData·
 *   AcDbLinkedTableData·AcDbFormattedTableData·AcDbTableContent), BS·3BD 방향·나눔 자료·행 범위.
 * - 값(20.4.99), 사용자 자료(20.4.100), 내용 형식(20.4.101.3), 셀 스타일(20.4.101.4).
 * - R2010+ 테이블 스타일(20.4.101.2), R2007 이전 테이블 스타일(20.4.101.1), R2007 이전 표 셀(20.4.96.1).
 *
 * 표본으로 확인한 점(사양과 다르거나 사양에 없음):
 * - 표 객체의 색(TC)은 모든 버전에서 R2004+ CMC 배치다(BS 번호 + BL RGB + RC 이름 플래그).
 * - 값 종류 4(문자열)는 R2007+에서 자료 흐름의 BL 바이트 수 + UTF-16LE다(끝 0 포함 여부는 strZ에 남긴다).
 */
import type { Vec3 } from '../../core/model';
import { type BitReader, DwgFormatError } from './bitstream';
import { R2007, R2010, R2013 } from './version';

export const SOFT_PTR = 4;
export const HARD_PTR = 5;
export const HARD_OWNER = 3;

/** 표 객체의 색(R2004+ CMC 배치) */
export interface TColor {
  index: number;
  /** 원시 32비트(상위 바이트 = 방식: 0xC0 ByLayer, 0xC1 ByBlock, 0xC2 RGB, 0xC3 ACI, 0xC8 없음) */
  rgb: number;
  name?: string;
  book?: string;
}

export interface TableIO {
  readonly reading: boolean;
  readonly ver: number;
  B(v: number): number;
  RC(v: number): number;
  BS(v: number): number;
  BL(v: number): number;
  BD(v: number): number;
  TV(v: string): string;
  P3(v: Vec3): Vec3;
  TC(v: TColor): TColor;
  H(code: number, v: number): number;
  /** 개수(BL). 읽을 때 남은 비트로 가능한지 본다 */
  N(v: number, minBits: number): number;
  /** R2007+ 자료 흐름 문자열(BL 바이트 수 + UTF-16LE) */
  WSTR(v: string, zeros: number): { s: string; zeros: number };
  RCs(v: number[], n: number): number[];
}

// ---------------------------------------------------------------------------
// io 구현

/** 읽기: 객체 리더의 자료·핸들 흐름 */
export function readIO(dat: BitReader, hdl: BitReader, base: number, ver: number): TableIO {
  return {
    reading: true,
    ver,
    B: () => dat.B(),
    RC: () => dat.RC(),
    BS: () => dat.BS(),
    BL: () => dat.BL(),
    BD: () => dat.BD(),
    TV: () => dat.TV(),
    P3: () => dat.BD3(),
    TC: () => {
      const index = dat.BS();
      const rgb = dat.BLu();
      const flags = dat.RC();
      const c: TColor = { index, rgb };
      if (flags & 1) c.name = dat.TV();
      if (flags & 2) c.book = dat.TV();
      return c;
    },
    H: () => hdl.H(base),
    N: (_v, minBits) => dat.checkCount(dat.BL(), minBits),
    WSTR: () => {
      const n = dat.checkCount(dat.BL(), 8);
      const codes: number[] = [];
      for (let i = 0; i + 1 < n; i += 2) codes.push(dat.RSu());
      if (n & 1) dat.RC();
      let len = codes.length;
      while (len > 0 && codes[len - 1] === 0) len--;
      return { s: String.fromCharCode(...codes.slice(0, len)), zeros: codes.length - len };
    },
    RCs: (_v, n) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(dat.RC());
      return out;
    },
  };
}

/** 쓰기에 필요한 비트 쓰기 함수(writer/bitwriter.ts의 BitWriter와 같은 모양) */
export interface BitSink {
  B(v: number | boolean): void;
  RC(v: number): void;
  RS(v: number): void;
  BS(v: number): void;
  BL(v: number): void;
  BD(v: number): void;
  TV(s: string): void;
  BD3(p: Vec3): void;
  H(code: number, value: number): void;
}

export function writeIO(dat: BitSink, hdl: BitSink, ver: number): TableIO {
  return {
    reading: false,
    ver,
    B: (v) => (dat.B(v ? 1 : 0), v ? 1 : 0),
    RC: (v) => (dat.RC(v & 0xff), v),
    BS: (v) => (dat.BS(v & 0xffff), v),
    BL: (v) => (dat.BL(v | 0), v),
    BD: (v) => (dat.BD(v), v),
    TV: (v) => (dat.TV(v), v),
    P3: (v) => (dat.BD3(v), v),
    TC: (c) => {
      dat.BS(c.index & 0xffff);
      dat.BL(c.rgb | 0);
      dat.RC((c.name ? 1 : 0) | (c.book ? 2 : 0));
      if (c.name) dat.TV(c.name);
      if (c.book) dat.TV(c.book);
      return c;
    },
    H: (code, v) => (hdl.H(code, v), v),
    N: (v) => (dat.BL(v), v),
    WSTR: (v, zeros) => {
      const n = v.length + zeros;
      dat.BL(n * 2);
      for (let i = 0; i < v.length; i++) dat.RS(v.charCodeAt(i));
      for (let i = 0; i < zeros; i++) dat.RS(0);
      return { s: v, zeros };
    },
    RCs: (v) => {
      for (const b of v) dat.RC(b);
      return v;
    },
  };
}

/** 배열: 개수를 읽거나 쓰고 항목마다 f */
function list<T>(io: TableIO, arr: T[] | undefined, minBits: number, f: (x: T | undefined) => T): T[] {
  const n = io.N(arr?.length ?? 0, minBits);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(f(io.reading ? undefined : arr![i]));
  return out;
}

export const tcByLayer = (): TColor => ({ index: 0, rgb: 0xc0000000 });
export const tcByBlock = (): TColor => ({ index: 0, rgb: 0xc1000000 });
export const tcAci = (n: number): TColor => (n === 256 ? tcByLayer() : n === 0 ? tcByBlock() : n === 257 ? { index: 0, rgb: 0xc8000000 } : { index: 0, rgb: (0xc3000000 | (n & 0xff)) >>> 0 });

// ---------------------------------------------------------------------------
// 값·사용자 자료·내용 형식·셀 스타일

export interface TValue {
  flags: number;
  type: number;
  num?: number;
  str?: string;
  /** R2007+ 문자열 끝의 0 글자 수 */
  strZ?: number;
  data?: number[];
  handle?: number;
  unit: number;
  format: string;
  text: string;
}

export const emptyValue = (): TValue => ({ flags: 0, type: 0, num: 0, unit: 0, format: '', text: '' });

export function value(io: TableIO, v?: TValue): TValue {
  const x = v ?? emptyValue();
  if (io.ver >= R2007) x.flags = io.BL(x.flags);
  x.type = io.BL(x.type);
  if (!(x.flags & 1)) {
    switch (x.type) {
      case 0:
      case 1:
        x.num = io.BL(x.num ?? 0);
        break;
      case 2:
        x.num = io.BD(x.num ?? 0);
        break;
      case 4:
        if (io.ver < R2007) x.str = io.TV(x.str ?? '');
        else {
          const w = io.WSTR(x.str ?? '', x.strZ ?? 1);
          x.str = w.s;
          x.strZ = w.zeros;
        }
        break;
      case 8:
      case 16:
      case 32:
      case 512: {
        const n = io.N(x.data?.length ?? 0, 8);
        x.data = io.RCs(x.data ?? [], n);
        break;
      }
      case 64:
        x.handle = io.H(SOFT_PTR, x.handle ?? 0);
        break;
      default:
        throw new DwgFormatError(`표 값 종류 ${x.type}`);
    }
  }
  if (io.ver >= R2007) {
    x.unit = io.BL(x.unit);
    x.format = io.TV(x.format);
    x.text = io.TV(x.text);
  }
  return x;
}

export interface TCustom {
  name: string;
  value: TValue;
}

function custom(io: TableIO, c?: TCustom[]): TCustom[] {
  return list(io, c, 8, (x) => {
    const name = io.TV(x?.name ?? '');
    return { name, value: value(io, x?.value) };
  });
}

export interface TContentFormat {
  ovr: number;
  prop: number;
  dataType: number;
  unitType: number;
  format: string;
  rotation: number;
  blockScale: number;
  align: number;
  color: TColor;
  textStyle: number;
  textHeight: number;
}

export const emptyContentFormat = (): TContentFormat => ({ ovr: 0, prop: 0, dataType: 0, unitType: 0, format: '', rotation: 0, blockScale: 1, align: 0, color: tcByBlock(), textStyle: 0, textHeight: 0 });

export function contentFormat(io: TableIO, f?: TContentFormat): TContentFormat {
  const x = f ?? emptyContentFormat();
  x.ovr = io.BL(x.ovr);
  x.prop = io.BL(x.prop);
  x.dataType = io.BL(x.dataType);
  x.unitType = io.BL(x.unitType);
  x.format = io.TV(x.format);
  x.rotation = io.BD(x.rotation);
  x.blockScale = io.BD(x.blockScale);
  x.align = io.BL(x.align);
  x.color = io.TC(x.color);
  x.textStyle = io.H(HARD_PTR, x.textStyle);
  x.textHeight = io.BD(x.textHeight);
  return x;
}

export interface TBorder {
  /** 1 위, 2 가로 안쪽, 4 아래, 8 왼쪽, 0x10 세로 안쪽, 0x20 오른쪽(옛 테두리 순서의 1 << 순번, 표본으로 확인) */
  edge: number;
  ovr: number;
  type: number;
  color: TColor;
  lineweight: number;
  linetype: number;
  invisible: number;
  spacing: number;
}

export interface TCellStyle {
  /** 1 셀, 2 행, 3 열, 4 서식 표 자료, 5 표 */
  type: number;
  data: number;
  ovr: number;
  merge: number;
  bg: TColor;
  layout: number;
  content: TContentFormat;
  marginFlag: number;
  margins: number[];
  borders: TBorder[];
}

export const emptyCellStyle = (type: number): TCellStyle => ({ type, data: 0, ovr: 0, merge: 0, bg: tcByBlock(), layout: 1, content: emptyContentFormat(), marginFlag: 0, margins: [], borders: [] });

export function cellStyle(io: TableIO, s?: TCellStyle): TCellStyle {
  const x = s ?? emptyCellStyle(0);
  x.type = io.BL(x.type);
  x.data = io.BS(x.data);
  if (!x.data) return x;
  x.ovr = io.BL(x.ovr);
  x.merge = io.BL(x.merge);
  x.bg = io.TC(x.bg);
  x.layout = io.BL(x.layout);
  x.content = contentFormat(io, io.reading ? undefined : x.content);
  x.marginFlag = io.BS(x.marginFlag);
  if (x.marginFlag & 1) {
    const m: number[] = [];
    for (let i = 0; i < 6; i++) m.push(io.BD(x.margins[i] ?? 0));
    x.margins = m;
  } else x.margins = [];
  x.borders = list(io, x.borders, 2, (b) => {
    const y: TBorder = b ?? { edge: 0, ovr: 0, type: 1, color: tcByBlock(), lineweight: -2, linetype: 0, invisible: 0, spacing: 0 };
    y.edge = io.BL(y.edge);
    if (y.edge) {
      y.ovr = io.BL(y.ovr);
      y.type = io.BL(y.type);
      y.color = io.TC(y.color);
      y.lineweight = io.BL(y.lineweight);
      y.linetype = io.H(HARD_PTR, y.linetype);
      y.invisible = io.BL(y.invisible);
      y.spacing = io.BD(y.spacing);
    }
    return y;
  });
  return x;
}

// ---------------------------------------------------------------------------
// 표 내용(20.4.97)

export interface TCellContent {
  /** 1 값, 2 필드, 4 블록 */
  type: number;
  value?: TValue;
  handle?: number;
  attrs: { handle: number; value: string; index: number }[];
  hasFormat: number;
  format?: TContentFormat;
}

export interface TCellGeom {
  u91: number;
  d40: number;
  d41: number;
  flags: number;
  handle: number;
  topLeft?: Vec3;
  center?: Vec3;
  contentWidth?: number;
  contentHeight?: number;
  width?: number;
  height?: number;
  unk?: number;
}

export interface TCell {
  state: number;
  tooltip: string;
  customInt: number;
  custom: TCustom[];
  linked: number;
  link?: { handle: number; rows: number; cols: number; unk: number };
  contents: TCellContent[];
  style: TCellStyle;
  styleId: number;
  geomFlag: number;
  geom?: TCellGeom;
}

export interface TColumn {
  name: string;
  customInt: number;
  custom: TCustom[];
  style: TCellStyle;
  styleId: number;
  width: number;
}

export interface TRow {
  cells: TCell[];
  customInt: number;
  custom: TCustom[];
  style: TCellStyle;
  styleId: number;
  height: number;
}

export interface TTableContent {
  name: string;
  description: string;
  columns: TColumn[];
  rows: TRow[];
  fields: number[];
  tableStyleOverride: TCellStyle;
  /** 병합 범위 [위 행, 왼쪽 열, 아래 행, 오른쪽 열] */
  merges: [number, number, number, number][];
  tableStyle: number;
}

function cellContent(io: TableIO, c?: TCellContent): TCellContent {
  const x: TCellContent = c ?? { type: 0, attrs: [], hasFormat: 0 };
  x.type = io.BL(x.type);
  if (x.type === 1) x.value = value(io, io.reading ? undefined : x.value);
  else if (x.type === 2 || x.type === 4) x.handle = io.H(HARD_PTR, x.handle ?? 0);
  x.attrs = list(io, x.attrs, 8, (a) => {
    const handle = io.H(SOFT_PTR, a?.handle ?? 0);
    const v = io.TV(a?.value ?? '');
    return { handle, value: v, index: io.BL(a?.index ?? 1) };
  });
  x.hasFormat = io.BS(x.hasFormat);
  if (x.hasFormat) x.format = contentFormat(io, io.reading ? undefined : x.format);
  return x;
}

function cell(io: TableIO, c?: TCell): TCell {
  const x: TCell = c ?? { state: 0, tooltip: '', customInt: 0, custom: [], linked: 0, contents: [], style: emptyCellStyle(1), styleId: 0, geomFlag: 0 };
  x.state = io.BL(x.state);
  x.tooltip = io.TV(x.tooltip);
  x.customInt = io.BL(x.customInt);
  x.custom = custom(io, x.custom);
  x.linked = io.BL(x.linked);
  if (x.linked) {
    const l = x.link ?? { handle: 0, rows: 0, cols: 0, unk: 0 };
    l.handle = io.H(HARD_PTR, l.handle);
    l.rows = io.BL(l.rows);
    l.cols = io.BL(l.cols);
    l.unk = io.BL(l.unk);
    x.link = l;
  }
  x.contents = list(io, x.contents, 8, (k) => cellContent(io, k));
  x.style = cellStyle(io, io.reading ? undefined : x.style);
  x.styleId = io.BL(x.styleId);
  x.geomFlag = io.BL(x.geomFlag);
  if (x.geomFlag) {
    const g: TCellGeom = x.geom ?? { u91: 0, d40: 0, d41: 0, flags: 0, handle: 0 };
    g.u91 = io.BL(g.u91);
    g.d40 = io.BD(g.d40);
    g.d41 = io.BD(g.d41);
    g.flags = io.BL(g.flags);
    g.handle = io.H(SOFT_PTR, g.handle);
    if (g.flags) {
      g.topLeft = io.P3(g.topLeft ?? { x: 0, y: 0, z: 0 });
      g.center = io.P3(g.center ?? { x: 0, y: 0, z: 0 });
      g.contentWidth = io.BD(g.contentWidth ?? 0);
      g.contentHeight = io.BD(g.contentHeight ?? 0);
      g.width = io.BD(g.width ?? 0);
      g.height = io.BD(g.height ?? 0);
      g.unk = io.BL(g.unk ?? 0);
    }
    x.geom = g;
  }
  return x;
}

export function tableContent(io: TableIO, t?: TTableContent): TTableContent {
  const x: TTableContent = t ?? { name: '', description: '', columns: [], rows: [], fields: [], tableStyleOverride: emptyCellStyle(4), merges: [], tableStyle: 0 };
  x.name = io.TV(x.name);
  x.description = io.TV(x.description);
  x.columns = list(io, x.columns, 16, (c) => {
    const y: TColumn = c ?? { name: '', customInt: 0, custom: [], style: emptyCellStyle(3), styleId: 0, width: 0 };
    y.name = io.TV(y.name);
    y.customInt = io.BL(y.customInt);
    y.custom = custom(io, y.custom);
    y.style = cellStyle(io, io.reading ? undefined : y.style);
    y.styleId = io.BL(y.styleId);
    y.width = io.BD(y.width);
    return y;
  });
  x.rows = list(io, x.rows, 8, (r) => {
    const y: TRow = r ?? { cells: [], customInt: 0, custom: [], style: emptyCellStyle(2), styleId: 0, height: 0 };
    y.cells = list(io, y.cells, 16, (c) => cell(io, c));
    y.customInt = io.BL(y.customInt);
    y.custom = custom(io, y.custom);
    y.style = cellStyle(io, io.reading ? undefined : y.style);
    y.styleId = io.BL(y.styleId);
    y.height = io.BD(y.height);
    return y;
  });
  x.fields = list(io, x.fields, 2, (h) => io.H(HARD_OWNER, h ?? 0));
  x.tableStyleOverride = cellStyle(io, io.reading ? undefined : x.tableStyleOverride);
  x.merges = list(io, x.merges, 8, (m) => {
    const a = m ?? [0, 0, 0, 0];
    return [io.BL(a[0]), io.BL(a[1]), io.BL(a[2]), io.BL(a[3])];
  });
  x.tableStyle = io.H(HARD_PTR, x.tableStyle);
  return x;
}

// ---------------------------------------------------------------------------
// R2010+ 표 도형(INSERT 자료 다음)

export interface TBreak {
  option: number;
  flow: number;
  spacing: number;
  u1: number;
  u2: number;
  manual: { pos: Vec3; height: number; flags: number }[];
}

export interface TTableR24 {
  rc: number;
  handle: number;
  bl: number;
  /** R2010 B / R2013+ BL */
  u4: number;
  content: TTableContent;
  bs: number;
  direction: Vec3;
  hasBreak: number;
  brk?: TBreak;
  ranges: { pos: Vec3; start: number; end: number }[];
}

export function tableR24(io: TableIO, t?: TTableR24): TTableR24 {
  const x: TTableR24 = t ?? { rc: 0, handle: 0, bl: 0, u4: 0, content: undefined as unknown as TTableContent, bs: 38, direction: { x: 1, y: 0, z: 0 }, hasBreak: 0, ranges: [] };
  x.rc = io.RC(x.rc);
  x.handle = io.H(SOFT_PTR, x.handle);
  x.bl = io.BL(x.bl);
  if (io.ver >= R2013) x.u4 = io.BL(x.u4);
  else if (io.ver >= R2010) x.u4 = io.B(x.u4);
  x.content = tableContent(io, io.reading ? undefined : x.content);
  x.bs = io.BS(x.bs);
  x.direction = io.P3(x.direction);
  x.hasBreak = io.BL(x.hasBreak);
  if (x.hasBreak) {
    const b: TBreak = x.brk ?? { option: 0, flow: 1, spacing: 0, u1: 0, u2: 0, manual: [] };
    b.option = io.BL(b.option);
    b.flow = io.BL(b.flow);
    b.spacing = io.BD(b.spacing);
    b.u1 = io.BL(b.u1);
    b.u2 = io.BL(b.u2);
    b.manual = list(io, b.manual, 8, (m) => {
      const pos = io.P3(m?.pos ?? { x: 0, y: 0, z: 0 });
      const height = io.BD(m?.height ?? 0);
      return { pos, height, flags: io.BL(m?.flags ?? 0) };
    });
    x.brk = b;
  }
  x.ranges = list(io, x.ranges, 8, (r) => {
    const pos = io.P3(r?.pos ?? { x: 0, y: 0, z: 0 });
    const start = io.BL(r?.start ?? 0);
    return { pos, start, end: io.BL(r?.end ?? 0) };
  });
  return x;
}

// ---------------------------------------------------------------------------
// 테이블 스타일

export interface TNamedCellStyle {
  /** 목록 항목 앞의 BL(표본: 셀 스타일 ID와 같은 값) */
  key?: number;
  style: TCellStyle;
  id: number;
  /** 표본: 1 레이블, 2 자료(사양과 반대) */
  cls: number;
  name: string;
}

/** R2010+ 테이블 스타일(20.4.101.2) */
export interface TTableStyleR24 {
  rc: number;
  description: string;
  u1: number;
  u2: number;
  handle: number;
  table: TNamedCellStyle;
  styles: TNamedCellStyle[];
}

function namedCellStyle(io: TableIO, s?: TNamedCellStyle): TNamedCellStyle {
  const style = cellStyle(io, io.reading ? undefined : s!.style);
  const id = io.BL(s?.id ?? 0);
  const cls = io.BL(s?.cls ?? 0);
  return { style, id, cls, name: io.TV(s?.name ?? '') };
}

export function tableStyleR24(io: TableIO, t?: TTableStyleR24): TTableStyleR24 {
  const x: TTableStyleR24 = t ?? { rc: 0, description: '', u1: 0, u2: 0, handle: 0, table: undefined as unknown as TNamedCellStyle, styles: [] };
  x.rc = io.RC(x.rc);
  x.description = io.TV(x.description);
  x.u1 = io.BL(x.u1);
  x.u2 = io.BL(x.u2);
  x.handle = io.H(HARD_OWNER, x.handle);
  x.table = namedCellStyle(io, io.reading ? undefined : x.table);
  // 목록 항목은 사양과 달리 BL 하나(키)가 셀 스타일 앞에 있다(표본)
  x.styles = list(io, x.styles, 8, (s) => {
    const key = io.BL(s?.key ?? s?.id ?? 0);
    return { key, ...namedCellStyle(io, s) };
  });
  return x;
}

/** R2007 이전 테이블 스타일의 행 스타일(데이터·제목·머리글 순) */
export interface TRowStyleOld {
  textStyle: number;
  height: number;
  align: number;
  color: TColor;
  fill: TColor;
  fillOn: number;
  borders: { lineweight: number; visible: number; color: TColor }[];
  dataType?: number;
  unitType?: number;
  format?: string;
}

export interface TTableStyleOld {
  description: string;
  flow: number;
  flags: number;
  hMargin: number;
  vMargin: number;
  titleSuppressed: number;
  headerSuppressed: number;
  rows: TRowStyleOld[];
}

export function tableStyleOld(io: TableIO, t?: TTableStyleOld): TTableStyleOld {
  const x: TTableStyleOld = t ?? { description: '', flow: 0, flags: 0, hMargin: 0, vMargin: 0, titleSuppressed: 0, headerSuppressed: 0, rows: [] };
  x.description = io.TV(x.description);
  x.flow = io.BS(x.flow);
  x.flags = io.BS(x.flags);
  x.hMargin = io.BD(x.hMargin);
  x.vMargin = io.BD(x.vMargin);
  x.titleSuppressed = io.B(x.titleSuppressed);
  x.headerSuppressed = io.B(x.headerSuppressed);
  const rows: TRowStyleOld[] = [];
  for (let i = 0; i < 3; i++) {
    const r: TRowStyleOld = io.reading ? { textStyle: 0, height: 0, align: 0, color: tcByBlock(), fill: tcAci(7), fillOn: 0, borders: [] } : x.rows[i]!;
    r.textStyle = io.H(HARD_PTR, r.textStyle);
    r.height = io.BD(r.height);
    r.align = io.BS(r.align);
    r.color = io.TC(r.color);
    r.fill = io.TC(r.fill);
    r.fillOn = io.B(r.fillOn);
    const bs: TRowStyleOld['borders'] = [];
    for (let k = 0; k < 6; k++) {
      const b = io.reading ? { lineweight: 0, visible: 1, color: tcByBlock() } : r.borders[k]!;
      b.lineweight = io.BS(b.lineweight);
      b.visible = io.B(b.visible);
      b.color = io.TC(b.color);
      bs.push(b);
    }
    r.borders = bs;
    if (io.ver >= R2007) {
      r.dataType = io.BL(r.dataType ?? 512);
      r.unitType = io.BL(r.unitType ?? 0);
      r.format = io.TV(r.format ?? '');
    }
    rows.push(r);
  }
  x.rows = rows;
  return x;
}

// ---------------------------------------------------------------------------
// R2007 이전 표 셀(20.4.96.1, R2007은 셀 끝에 값이 더 있다)

export interface TCellOld {
  type: number;
  edgeFlags: number;
  merged: number;
  autofit: number;
  mergeWidth: number;
  mergeHeight: number;
  rotation: number;
  /** 문자 셀: 필드(344) 핸들, 0이면 문자 */
  fieldHandle: number;
  text?: string;
  blockScale?: number;
  hasAttrs?: number;
  attrs?: { index: number; text: string; handle: number }[];
  /** 블록 셀: 블록 레코드 핸들 */
  hasOverride: number;
  ovr?: number;
  virtualEdge?: number;
  align?: number;
  fillNone?: number;
  bg?: TColor;
  color?: TColor;
  textStyle?: number;
  textHeight?: number;
  edges?: { color?: TColor; lineweight?: number; visible?: number }[];
  /** R2007: 알 수 없는 BL과 값 */
  u2007?: number;
  value?: TValue;
}

const EDGE_BITS: [number, number, number][] = [
  [0x40, 0x400, 0x4000],
  [0x80, 0x800, 0x8000],
  [0x100, 0x1000, 0x10000],
  [0x200, 0x2000, 0x20000],
];

/** 옛 셀 하나(R2007은 뒤에 BL + 값이 더 있다) */
export function cellOld(io: TableIO, c?: TCellOld): TCellOld {
  const x: TCellOld = c ?? { type: 1, edgeFlags: 0, merged: 0, autofit: 0, mergeWidth: 1, mergeHeight: 1, rotation: 0, fieldHandle: 0, hasOverride: 0 };
  x.type = io.BS(x.type);
  x.edgeFlags = io.RC(x.edgeFlags);
  x.merged = io.B(x.merged);
  x.autofit = io.B(x.autofit);
  x.mergeWidth = io.BL(x.mergeWidth);
  x.mergeHeight = io.BL(x.mergeHeight);
  x.rotation = io.BD(x.rotation);
  x.fieldHandle = io.H(HARD_PTR, x.fieldHandle);
  if (x.type === 1) {
    // R2007은 문자가 셀 끝의 값에 있고 TV가 없다(표본)
    if (!x.fieldHandle && io.ver < R2007) x.text = io.TV(x.text ?? '');
  } else if (x.type === 2) {
    x.blockScale = io.BD(x.blockScale ?? 1);
    x.hasAttrs = io.B(x.hasAttrs ?? 0);
    if (x.hasAttrs) {
      const n = io.BS(x.attrs?.length ?? 0);
      const out: NonNullable<TCellOld['attrs']> = [];
      for (let i = 0; i < n; i++) {
        const a = io.reading ? { index: 0, text: '', handle: 0 } : x.attrs![i]!;
        a.index = io.BS(a.index);
        a.text = io.TV(a.text);
        a.handle = io.H(SOFT_PTR, a.handle);
        out.push(a);
      }
      x.attrs = out;
    }
  }
  x.hasOverride = io.B(x.hasOverride);
  if (x.hasOverride) {
    const f = (x.ovr = io.BL(x.ovr ?? 0));
    x.virtualEdge = io.RC(x.virtualEdge ?? 0);
    if (f & 0x01) x.align = io.BS(x.align ?? 1);
    if (f & 0x02) x.fillNone = io.B(x.fillNone ?? 0);
    if (f & 0x04) x.bg = io.TC(x.bg ?? tcAci(7));
    if (f & 0x08) x.color = io.TC(x.color ?? tcByBlock());
    if (f & 0x10) x.textStyle = io.H(HARD_PTR, x.textStyle ?? 0);
    if (f & 0x20) x.textHeight = io.BD(x.textHeight ?? 0);
    const edges: NonNullable<TCellOld['edges']> = [];
    EDGE_BITS.forEach(([cb, lb, vb], i) => {
      const e = io.reading ? {} : (x.edges?.[i] ?? {});
      if (f & cb) e.color = io.TC(e.color ?? tcByBlock());
      if (f & lb) e.lineweight = io.BS(e.lineweight ?? -2);
      if (f & vb) e.visible = io.BS(e.visible ?? 0);
      edges.push(e);
    });
    x.edges = edges;
  }
  if (io.ver >= R2007) {
    x.u2007 = io.BL(x.u2007 ?? 0);
    x.value = value(io, io.reading ? undefined : x.value);
  }
  return x;
}

/** R2007 이전 표의 표 재지정·테두리 재지정(셀 뒤, 사양 20.4.96.1) */
export interface TTableOldTail {
  hasOvr: number;
  ovr: number;
  titleSuppressed?: number;
  flow?: number;
  hMargin?: number;
  vMargin?: number;
  /** 제목·머리글·데이터 순 */
  rowColor: (TColor | undefined)[];
  fillNone: (number | undefined)[];
  fillColor: (TColor | undefined)[];
  align: (number | undefined)[];
  textStyle: (number | undefined)[];
  textHeight: (number | undefined)[];
  hasBorderColor: number;
  borderColorFlags: number;
  borderColors: TColor[];
  hasBorderLw: number;
  borderLwFlags: number;
  borderLws: number[];
  hasBorderVis: number;
  borderVisFlags: number;
  borderVis: number[];
}

export const emptyOldTail = (): TTableOldTail => ({
  hasOvr: 0,
  ovr: 0,
  rowColor: [],
  fillNone: [],
  fillColor: [],
  align: [],
  textStyle: [],
  textHeight: [],
  hasBorderColor: 0,
  borderColorFlags: 0,
  borderColors: [],
  hasBorderLw: 0,
  borderLwFlags: 0,
  borderLws: [],
  hasBorderVis: 0,
  borderVisFlags: 0,
  borderVis: [],
});

function bitsList<T>(io: TableIO, flags: number, arr: T[], f: (v: T | undefined) => T): T[] {
  const out: T[] = [];
  let k = 0;
  for (let b = 0; b < 18; b++) if (flags & (1 << b)) out.push(f(io.reading ? undefined : arr[k++]));
  return out;
}

export function tableOldTail(io: TableIO, t?: TTableOldTail): TTableOldTail {
  const x = t ?? emptyOldTail();
  x.hasOvr = io.B(x.hasOvr);
  if (x.hasOvr) {
    const f = (x.ovr = io.BL(x.ovr));
    if (f & 0x1) x.titleSuppressed = io.B(x.titleSuppressed ?? 0);
    if (f & 0x4) x.flow = io.BS(x.flow ?? 0);
    if (f & 0x8) x.hMargin = io.BD(x.hMargin ?? 0);
    if (f & 0x10) x.vMargin = io.BD(x.vMargin ?? 0);
    for (let i = 0; i < 3; i++) if (f & (0x20 << i)) x.rowColor[i] = io.TC(x.rowColor[i] ?? tcByBlock());
    for (let i = 0; i < 3; i++) if (f & (0x100 << i)) x.fillNone[i] = io.B(x.fillNone[i] ?? 0);
    for (let i = 0; i < 3; i++) if (f & (0x800 << i)) x.fillColor[i] = io.TC(x.fillColor[i] ?? tcAci(7));
    for (let i = 0; i < 3; i++) if (f & (0x4000 << i)) x.align[i] = io.BS(x.align[i] ?? 1);
    for (let i = 0; i < 3; i++) if (f & (0x20000 << i)) x.textStyle[i] = io.H(HARD_PTR, x.textStyle[i] ?? 0);
    for (let i = 0; i < 3; i++) if (f & (0x100000 << i)) x.textHeight[i] = io.BD(x.textHeight[i] ?? 0);
  }
  x.hasBorderColor = io.B(x.hasBorderColor);
  if (x.hasBorderColor) {
    x.borderColorFlags = io.BL(x.borderColorFlags);
    x.borderColors = bitsList(io, x.borderColorFlags, x.borderColors, (c) => io.TC(c ?? tcByBlock()));
  }
  x.hasBorderLw = io.B(x.hasBorderLw);
  if (x.hasBorderLw) {
    x.borderLwFlags = io.BL(x.borderLwFlags);
    x.borderLws = bitsList(io, x.borderLwFlags, x.borderLws, (v) => io.BS(v ?? 0));
  }
  x.hasBorderVis = io.B(x.hasBorderVis);
  if (x.hasBorderVis) {
    x.borderVisFlags = io.BL(x.borderVisFlags);
    x.borderVis = bitsList(io, x.borderVisFlags, x.borderVis, (v) => io.BS(v ?? 0));
  }
  return x;
}

/** R2007 이전 표(INSERT 자료 다음) */
export interface TTableOld {
  flags: number;
  direction: Vec3;
  colWidths: number[];
  rowHeights: number[];
  tableStyle: number;
  cells: TCellOld[];
  tail: TTableOldTail;
}

export function tableOld(io: TableIO, t?: TTableOld): TTableOld {
  const x: TTableOld = t ?? { flags: 22, direction: { x: 1, y: 0, z: 0 }, colWidths: [], rowHeights: [], tableStyle: 0, cells: [], tail: emptyOldTail() };
  x.flags = io.BS(x.flags);
  x.direction = io.P3(x.direction);
  const nc = io.N(x.colWidths.length, 2);
  const nr = io.N(x.rowHeights.length, 2);
  const cw: number[] = [];
  for (let i = 0; i < nc; i++) cw.push(io.BD(x.colWidths[i] ?? 0));
  const rh: number[] = [];
  for (let i = 0; i < nr; i++) rh.push(io.BD(x.rowHeights[i] ?? 0));
  x.colWidths = cw;
  x.rowHeights = rh;
  x.tableStyle = io.H(HARD_PTR, x.tableStyle);
  if (io.reading && nc * nr > 100000) throw new DwgFormatError('표 셀이 너무 많습니다');
  const cells: TCellOld[] = [];
  for (let i = 0; i < nc * nr; i++) cells.push(cellOld(io, io.reading ? undefined : x.cells[i]));
  x.cells = cells;
  x.tail = tableOldTail(io, io.reading ? undefined : x.tail);
  return x;
}
