/** 표 제어 객체와 표 레코드(사양 20.4.51~20.4.70) */
import type { CadColor, LinetypeElement, Vec2, Vec3 } from '../../../core/model';
import type { BitReader, DwgColor } from '../bitstream';
import { cmcToCad } from '../color';
import { lineweightFromIndex } from '../lineweight';
import { R14, R2000, R2004, R2007, R2010 } from '../version';
import type { ObjectReader } from './reader';

export interface ControlObject {
  handle: number;
  typeName: string;
  entries: number[];
  /** BLOCK_CONTROL: 모형·배치 공간, LTYPE_CONTROL: ByLayer·ByBlock */
  extra: number[];
}

export interface RecordCommon {
  handle: number;
  typeName: string;
  name: string;
  /** 70 플래그(64·16 비트 포함) */
  flags: number;
  xrefIndex: number;
  owner: number;
  xdict: number;
  xrefBlock: number;
}

export interface LayerRec extends RecordCommon {
  color: CadColor;
  off: boolean;
  frozen: boolean;
  locked: boolean;
  plot: boolean;
  lineweight: number;
  ltype: number;
  plotStyle: number;
  transparency: number;
}

export interface StyleRec extends RecordCommon {
  height: number;
  widthFactor: number;
  oblique: number;
  generation: number;
  lastHeight: number;
  font: string;
  bigFont: string;
}

export interface LtypeRec extends RecordCommon {
  description: string;
  patternLength: number;
  elements: (LinetypeElement & { shapeFile: number })[];
}

export interface DimStyleRec extends RecordCommon {
  vars: Record<string, number | string>;
  /** 변수 이름 → 핸들(이름으로 풀 것) */
  handleVars: Record<string, number>;
}

export interface BlockHeaderRec extends RecordCommon {
  anonymous: boolean;
  hasAttribs: boolean;
  isXref: boolean;
  isOverlaid: boolean;
  basePoint: Vec3;
  xrefPath: string;
  description: string;
  insertUnits: number;
  explodable: boolean;
  scalable: boolean;
  blockEntity: number;
  endBlk: number;
  firstEntity: number;
  lastEntity: number;
  owned: number[] | null;
  layout: number;
}

export interface VportRec extends RecordCommon {
  height: number;
  aspect: number;
  center: Vec2;
  target: Vec3;
  direction: Vec3;
  twist: number;
  lens: number;
  lowerLeft: Vec2;
  upperRight: Vec2;
  snapBase: Vec2;
  snapSpacing: Vec2;
  gridSpacing: Vec2;
  /** 스냅 스타일(0 표준, 1 등각투영)·등각평면(0 왼쪽, 1 위, 2 오른쪽) */
  snapStyle: number;
  snapIsoPair: number;
}

export interface ViewRec extends RecordCommon {
  height: number;
  width: number;
  center: Vec2;
  target: Vec3;
  direction: Vec3;
  twist: number;
}

export interface UcsRec extends RecordCommon {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
}

export type TableRecord = LayerRec | StyleRec | LtypeRec | DimStyleRec | BlockHeaderRec | VportRec | ViewRec | UcsRec | RecordCommon;

export function readControl(or: ObjectReader): ControlObject {
  or.commonObject();
  const h = or.h;
  const r = or.dat;
  const n = r.BL();
  const hr = or.hdl;
  const entries: number[] = [];
  const count = n >= 0 && n < 1000000 ? n : 0;
  for (let i = 0; i < count; i++) entries.push(hr.H(h.handle));
  const extra: number[] = [];
  if (h.typeName === 'BLOCK_CONTROL' || h.typeName === 'LTYPE_CONTROL') {
    for (let i = 0; i < 2 && hr.pos < hr.end - 7; i++) extra.push(hr.H(h.handle));
  }
  return { handle: h.handle, typeName: h.typeName, entries, extra };
}

/** 표 레코드 공통: 이름, 플래그, 외부 참조 */
function recordCommon(or: ObjectReader): RecordCommon {
  or.commonObject();
  const h = or.h;
  const r = or.dat;
  const name = r.TV();
  let flags = 0;
  // 64(참조됨) 비트는 DXF가 쓰지 않으므로 담지 않는다
  r.B();
  // R2007+에는 외부 참조 번호(BS)가 없다(실제 파일 기준)
  const xrefIndex = or.ver >= R2007 ? -1 : r.BS() - 1;
  if (r.B()) flags |= 16;
  return { handle: h.handle, typeName: h.typeName, name, flags, xrefIndex, owner: h.owner, xdict: h.xdict, xrefBlock: 0 };
}

export function readLayer(or: ObjectReader): LayerRec {
  const rc = recordCommon(or);
  const r = or.dat;
  const ver = or.ver;
  let frozen = false;
  let on = true;
  let locked = false;
  let plot = true;
  let lw = -3;
  if (ver <= R14) {
    frozen = r.B() === 1;
    on = r.B() === 0; // 사양은 '켜짐'이라 하지만 실제로는 1이 꺼짐
    if (r.B()) rc.flags |= 2;
    locked = r.B() === 1;
  } else {
    const v = r.BS();
    frozen = (v & 1) !== 0;
    on = (v & 2) === 0;
    if (v & 4) rc.flags |= 2;
    locked = (v & 8) !== 0;
    plot = (v & 16) !== 0;
    lw = lineweightFromIndex((v & 0x3e0) >> 5);
  }
  if (frozen) rc.flags |= 1;
  if (locked) rc.flags |= 4;
  const c: DwgColor = r.CMC();
  let color = cmcToCad(c);
  if (color.aci < 0) {
    on = false;
    color = { ...color, aci: -color.aci };
  }
  const hr = or.hdl;
  rc.xrefBlock = hr.H(rc.handle);
  let plotStyle = 0;
  if (ver >= R2000) plotStyle = hr.H(rc.handle);
  if (ver >= R2007) hr.H(rc.handle); // 재질
  const ltype = hr.H(rc.handle);
  return { ...rc, color, off: !on, frozen, locked, plot, lineweight: lw, ltype, plotStyle, transparency: 255 };
}

export function readStyle(or: ObjectReader): StyleRec {
  const rc = recordCommon(or);
  const r = or.dat;
  // 사양 표의 설명과 달리 첫 비트가 쉐이프 파일(70 비트 1), 둘째가 세로 쓰기(비트 4)다
  if (r.B()) rc.flags |= 1;
  if (r.B()) rc.flags |= 4;
  const height = r.BD();
  const widthFactor = r.BD();
  const oblique = r.BD();
  const generation = r.RC();
  const lastHeight = r.BD();
  const font = r.TV();
  const bigFont = r.TV();
  rc.xrefBlock = or.hdl.H(rc.handle);
  return { ...rc, height, widthFactor, oblique, generation, lastHeight, font, bigFont };
}

export function readLtype(or: ObjectReader): LtypeRec {
  const rc = recordCommon(or);
  const r = or.dat;
  const ver = or.ver;
  const description = r.TV();
  const patternLength = r.BD();
  r.RC(); // 정렬 'A'
  const n = r.RC();
  const elements: LtypeRec['elements'] = [];
  let anyText = false;
  for (let i = 0; i < n; i++) {
    const length = r.BD();
    const code = r.BS();
    const ox = r.RD();
    const oy = r.RD();
    const scale = r.BD();
    const rotation = r.BD();
    const flags = r.BS();
    if (flags & 2) anyText = true;
    const el: LinetypeElement & { shapeFile: number; textOffset?: number } = {
      length,
      // 74(1 절대 회전, 2 문자, 4 쉐이프, 8은 R2010+ DXF도 그대로 쓴다)
      flags,
      scale,
      rotation,
      offset: { x: ox, y: oy },
      shapeFile: 0,
    };
    if (flags & 4) el.shapeNumber = code;
    if (flags & 2) el.textOffset = code;
    elements.push(el);
  }
  // 문자열 영역
  let area: Uint8Array | null = null;
  let unicode = false;
  if (ver <= R2004) {
    area = new Uint8Array(256);
    for (let i = 0; i < 256; i++) area[i] = r.RC();
  } else if (anyText) {
    area = new Uint8Array(512);
    for (let i = 0; i < 512; i++) area[i] = r.RC();
    unicode = true;
  }
  if (area) {
    for (const el of elements as (LinetypeElement & { textOffset?: number })[]) {
      if (el.textOffset === undefined) continue;
      el.text = areaString(area, el.textOffset, unicode, r.decoder);
      delete el.textOffset;
    }
  }
  const hr = or.hdl;
  rc.xrefBlock = hr.H(rc.handle);
  for (const el of elements) {
    if (hr.pos + 8 > hr.end) break;
    el.shapeFile = hr.H(rc.handle);
  }
  return { ...rc, description, patternLength, elements };
}

function areaString(area: Uint8Array, off: number, unicode: boolean, decoder: TextDecoder): string {
  if (unicode) {
    let s = '';
    for (let i = off; i + 1 < area.length; i += 2) {
      const c = area[i] | (area[i + 1] << 8);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  let e = off;
  while (e < area.length && area[e] !== 0) e++;
  return decoder.decode(area.subarray(off, e));
}

export function readBlockHeader(or: ObjectReader): BlockHeaderRec {
  const rc = recordCommon(or);
  const r = or.dat;
  const ver = or.ver;
  const anonymous = r.B() === 1;
  const hasAttribs = r.B() === 1;
  const isXref = r.B() === 1;
  const isOverlaid = r.B() === 1;
  if (anonymous) rc.flags |= 1;
  if (hasAttribs) rc.flags |= 2;
  if (isXref) rc.flags |= 4;
  if (isOverlaid) rc.flags |= 8;
  if (ver >= R2000 && r.B() === 1) rc.flags |= 32; // 불러오지 않은 외부 참조
  let ownedCount = 0;
  if (ver >= R2004) ownedCount = r.BL();
  const basePoint = r.BD3();
  const xrefPath = r.TV();
  let insertCount = 0;
  let description = '';
  let insertUnits = 0;
  let explodable = true;
  let scalable = true;
  if (ver >= R2000) {
    for (let guard = 0; guard < 1000000; guard++) {
      if (r.RC() === 0) break;
      insertCount++;
    }
    description = r.TV();
    const preview = r.BL();
    if (preview > 0) {
      r.checkCount(preview, 8);
      r.pos += preview * 8;
    }
  }
  if (ver >= R2007) {
    insertUnits = r.BS();
    explodable = r.B() === 1;
    scalable = r.RC() !== 0;
  }
  const hr = or.hdl;
  const base = rc.handle;
  hr.H(base); // NULL
  const blockEntity = hr.H(base);
  let firstEntity = 0;
  let lastEntity = 0;
  let owned: number[] | null = null;
  if (ver < R2004) {
    if (!isXref && !isOverlaid) {
      firstEntity = hr.H(base);
      lastEntity = hr.H(base);
    }
  } else {
    owned = [];
    if (ownedCount < 0 || ownedCount > 10000000) ownedCount = 0;
    hr.checkCount(ownedCount, 8);
    for (let i = 0; i < ownedCount; i++) owned.push(hr.H(base));
  }
  const endBlk = hr.H(base);
  let layout = 0;
  if (ver >= R2000) {
    for (let i = 0; i < insertCount && hr.pos < hr.end; i++) hr.H(base);
    if (hr.pos + 8 <= hr.end) layout = hr.H(base);
  }
  return {
    ...rc,
    anonymous,
    hasAttribs,
    isXref,
    isOverlaid,
    basePoint,
    xrefPath,
    description,
    insertUnits,
    explodable,
    scalable,
    blockEntity,
    endBlk,
    firstEntity,
    lastEntity,
    owned,
    layout,
  };
}

/** VIEW·VPORT의 보기 모드(4비트) */
function viewMode(r: BitReader): number {
  let m = 0;
  if (r.B()) m |= 1;
  if (r.B()) m |= 2;
  if (r.B()) m |= 4;
  if (!r.B()) m |= 16;
  return m;
}

export function readVport(or: ObjectReader): VportRec {
  const rc = recordCommon(or);
  const r = or.dat;
  const ver = or.ver;
  const height = r.BD();
  const aspect = r.BD();
  const center = r.RD2();
  const target = r.BD3();
  const direction = r.BD3();
  const twist = r.BD();
  const lens = r.BD();
  r.BD();
  r.BD();
  viewMode(r);
  if (ver >= R2000) r.RC();
  if (ver >= R2007) {
    r.B();
    r.RC();
    r.BD();
    r.BD();
    r.CMC();
  }
  const lowerLeft = r.RD2();
  const upperRight = r.RD2();
  r.B(); // UCSFOLLOW
  r.BS();
  r.B();
  r.B();
  r.B();
  r.B();
  const gridSpacing = r.RD2();
  r.B(); // 스냅 켜기
  const snapStyle = r.B();
  const snapIsoPair = r.BS();
  r.BD(); // 스냅 회전
  const snapBase = r.RD2();
  const snapSpacing = r.RD2();
  return {
    ...rc,
    height,
    aspect: height !== 0 ? aspect / height : aspect,
    center,
    target,
    direction,
    twist,
    lens,
    lowerLeft,
    upperRight,
    snapBase,
    snapSpacing,
    gridSpacing,
    snapStyle,
    snapIsoPair,
  };
}

export function readView(or: ObjectReader): ViewRec {
  const rc = recordCommon(or);
  const r = or.dat;
  const height = r.BD();
  const width = r.BD();
  const center = r.RD2();
  const target = r.BD3();
  const direction = r.BD3();
  const twist = r.BD();
  return { ...rc, height, width, center, target, direction, twist };
}

export function readUcs(or: ObjectReader): UcsRec {
  const rc = recordCommon(or);
  const r = or.dat;
  const origin = r.BD3();
  const xAxis = r.BD3();
  const yAxis = r.BD3();
  return { ...rc, origin, xAxis, yAxis };
}

export function readSimpleRecord(or: ObjectReader): RecordCommon {
  const rc = recordCommon(or);
  if (rc.typeName === 'VPENT_HEADER') {
    if (or.dat.B()) rc.flags |= 1;
  }
  return rc;
}

/** DIMSTYLE: 변수를 DXF 이름으로 */
export function readDimStyle(or: ObjectReader): DimStyleRec {
  const rc = recordCommon(or);
  const r = or.dat;
  const ver = or.ver;
  const v: Record<string, number | string> = {};
  const B = (n: string) => (v[n] = r.B());
  const BS = (n: string) => (v[n] = r.BS());
  const BD = (n: string) => (v[n] = r.BD());
  const RC = (n: string) => (v[n] = r.RC());
  const CMC = (n: string) => (v[n] = cmcToCad(r.CMC()).aci);
  if (ver <= R14) {
    for (const n of ['DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1', 'DIMSE2', 'DIMALT', 'DIMTOFL', 'DIMSAH', 'DIMTIX', 'DIMSOXD']) B(n);
    RC('DIMALTD');
    RC('DIMZIN');
    B('DIMSD1');
    B('DIMSD2');
    RC('DIMTOLJ');
    RC('DIMJUST');
    RC('DIMFIT');
    B('DIMUPT');
    RC('DIMTZIN');
    RC('DIMALTZ');
    RC('DIMALTTZ');
    RC('DIMTAD');
    BS('DIMUNIT');
    BS('DIMAUNIT');
    BS('DIMDEC');
    BS('DIMTDEC');
    BS('DIMALTU');
    BS('DIMALTTD');
    for (const n of ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE', 'DIMRND', 'DIMDLE', 'DIMTP', 'DIMTM', 'DIMTXT', 'DIMCEN', 'DIMTSZ', 'DIMALTF', 'DIMLFAC', 'DIMTVP', 'DIMTFAC', 'DIMGAP']) BD(n);
    v.DIMPOST = r.T();
    v.DIMAPOST = r.T();
    v.DIMBLK = r.T();
    v.DIMBLK1 = r.T();
    v.DIMBLK2 = r.T();
    BS('DIMCLRD');
    BS('DIMCLRE');
    BS('DIMCLRT');
  } else {
    v.DIMPOST = r.TV();
    v.DIMAPOST = r.TV();
    for (const n of ['DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE', 'DIMRND', 'DIMDLE', 'DIMTP', 'DIMTM']) BD(n);
    if (ver >= R2007) {
      BD('DIMFXL');
      BD('DIMJOGANG');
      BS('DIMTFILL');
      CMC('DIMTFILLCLR');
    }
    for (const n of ['DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1', 'DIMSE2']) B(n);
    BS('DIMTAD');
    BS('DIMZIN');
    BS('DIMAZIN');
    if (ver >= R2007) BS('DIMARCSYM');
    for (const n of ['DIMTXT', 'DIMCEN', 'DIMTSZ', 'DIMALTF', 'DIMLFAC', 'DIMTVP', 'DIMTFAC', 'DIMGAP', 'DIMALTRND']) BD(n);
    B('DIMALT');
    BS('DIMALTD');
    B('DIMTOFL');
    B('DIMSAH');
    B('DIMTIX');
    B('DIMSOXD');
    CMC('DIMCLRD');
    CMC('DIMCLRE');
    CMC('DIMCLRT');
    for (const n of ['DIMADEC', 'DIMDEC', 'DIMTDEC', 'DIMALTU', 'DIMALTTD', 'DIMAUNIT', 'DIMFRAC', 'DIMLUNIT', 'DIMDSEP', 'DIMTMOVE', 'DIMJUST']) BS(n);
    B('DIMSD1');
    B('DIMSD2');
    BS('DIMTOLJ');
    BS('DIMTZIN');
    BS('DIMALTZ');
    BS('DIMALTTZ');
    B('DIMUPT');
    BS('DIMATFIT');
    if (ver >= R2007) B('DIMFXLON');
    if (ver >= R2010) {
      B('DIMTXTDIRECTION');
      BD('DIMALTMZF');
      v.DIMALTMZS = r.TV();
      BD('DIMMZF');
      v.DIMMZS = r.TV();
    }
    v.DIMLWD = lwDim(r.BS());
    v.DIMLWE = lwDim(r.BS());
  }
  if (r.B()) rc.flags |= 1;
  const hr = or.hdl;
  const base = rc.handle;
  rc.xrefBlock = hr.H(base);
  const handleVars: Record<string, number> = {};
  handleVars.DIMTXSTY = hr.H(base);
  if (ver >= R2000) {
    handleVars.DIMLDRBLK = hr.H(base);
    handleVars.DIMBLK = hr.H(base);
    handleVars.DIMBLK1 = hr.H(base);
    handleVars.DIMBLK2 = hr.H(base);
  }
  if (ver >= R2007) {
    handleVars.DIMLTYPE = hr.H(base);
    handleVars.DIMLTEX1 = hr.H(base);
    handleVars.DIMLTEX2 = hr.H(base);
  }
  return { ...rc, vars: v, handleVars };
}

function lwDim(v: number): number {
  if (v === 29) return -1;
  if (v === 30) return -2;
  if (v === 31) return -3;
  return v;
}
