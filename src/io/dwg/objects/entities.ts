/** 도형 객체(사양 20.4.3~20.4.50, 20.4.75~20.4.96) → 문서 모델 */
import type {
  AcisEntity,
  ArcEntity,
  AttribEntity,
  CadColor,
  CircleEntity,
  DimensionEntity,
  EllipseEntity,
  Entity,
  EntityBase,
  FaceEntity,
  HatchEdge,
  HatchEntity,
  HatchPath,
  HatchPatternLine,
  ImageEntity,
  InsertEntity,
  LeaderEntity,
  LineEntity,
  LwPolylineEntity,
  LwVertex,
  MeshEntity,
  MLeaderEntity,
  MLeaderLeader,
  MLeaderLine,
  MLineEntity,
  MLineVertex,
  MTextEntity,
  Ole2FrameEntity,
  PointEntity,
  PolylineEntity,
  PolyVertex,
  ShapeEntity,
  SplineEntity,
  TableEntity,
  TextEntity,
  TextHAlign,
  TextVAlign,
  ToleranceEntity,
  UnderlayEntity,
  UnknownEntity,
  Vec2,
  Vec3,
  ViewportEntity,
  XData,
  XLineEntity,
} from '../../../core/model';
import { BYLAYER, SHARED_BYLAYER_COLOR } from '../../../core/model';
import { type BitReader, DwgFormatError } from '../bitstream';
import { cmcToCad, encToCad } from '../color';
import { lineweightFromIndex } from '../lineweight';
import { R14, R2000, R2004, R2007, R2010, R2013, R2018 } from '../version';
import { hex } from './nonentities';
import { readTableCellsOld, readTableContentR24 } from './table';
import { decodeTableBody } from './tableraw';
import type { EntCommon, ObjectReader, RawEed } from './reader';

/** 핸들 → 이름 */
export interface Names {
  layer(h: number): string;
  ltype(h: number): string;
  style(h: number): string;
  dimstyle(h: number): string;
  block(h: number): string;
  app(h: number): string;
  mlinestyle(h: number): string;
  /** DBCOLOR(색상표 색) */
  bookColor(h: number): CadColor | undefined;
}

export type ParsedKind = 'entity' | 'vertex' | 'seqend' | 'block' | 'endblk' | 'attrib';

export interface ParsedEntity {
  handle: number;
  owner: number;
  entmode: number;
  prev: number;
  next: number;
  kind: ParsedKind;
  entity: Entity | null;
  vertex?: PolyVertex;
  /** R2004+: 소유한 하위 객체(정점·속성) */
  children?: number[];
  firstChild?: number;
  lastChild?: number;
  seqend?: number;
  /** BLOCK 도형의 이름 */
  blockName?: string;
  /** BLOCK·ENDBLK 도형의 도면층 */
  layer?: string;
  /** MTEXT 실제 글자 범위 */
  extents?: { height: number; width: number };
}

const PI2 = Math.PI * 2;

export function xdataFromEed(eed: RawEed[] | null, names: Names): XData[] | undefined {
  if (!eed) return undefined;
  return eed.map((x) => ({ app: names.app(x.app), items: x.items }));
}

function linetypeName(or: ObjectReader, c: EntCommon, names: Names): string {
  if (or.ver <= R14) {
    if (c.isByLayerLt) return 'ByLayer';
    return names.ltype(c.ltype) || 'ByLayer';
  }
  switch (c.ltypeFlags) {
    case 0:
      return 'ByLayer';
    case 1:
      return 'ByBlock';
    case 2:
      return 'Continuous';
    default:
      return names.ltype(c.ltype) || 'ByLayer';
  }
}

/** ByLayer 색(대부분의 도형)은 얼려 둔 객체 하나를 함께 쓴다 */
function byLayerShared(c: CadColor): CadColor {
  return c.aci === BYLAYER && c.rgb === undefined && c.name === undefined ? SHARED_BYLAYER_COLOR : c;
}

/** 공통 도형 속성 */
function entBase(or: ObjectReader, c: EntCommon, names: Names): Omit<EntityBase, 'type'> {
  const h = or.h;
  const e: Omit<EntityBase, 'type'> = {
    handle: hex(h.handle),
    layer: names.layer(c.layer) || '0',
    linetype: linetypeName(or, c, names),
    color: byLayerShared(encToCad(c.color)),
    lineweight: or.ver >= R2000 ? lineweightFromIndex(c.lineweight) : -1,
    ltscale: c.ltscale,
    transparency: c.color.transparency ?? -1,
  };
  if (c.colorHandle) {
    // 색상표 색: RGB와 이름은 DBCOLOR 객체에 있다(ACI는 ENC 아래 비트 그대로)
    const bc = names.bookColor(c.colorHandle);
    if (bc) {
      const col: CadColor = { aci: e.color.aci };
      if (bc.rgb !== undefined) col.rgb = bc.rgb;
      if (bc.name) col.name = bc.name;
      e.color = col;
    }
  }
  if (h.owner) e.owner = hex(h.owner);
  if (c.invisible & 1) e.invisible = true;
  if (c.entmode === 1) e.paperSpace = true;
  const xd = xdataFromEed(h.eed, names);
  if (xd) {
    e.xdata = xd;
    // 하이퍼링크: PE_URL 확장 자료의 문자열(주소, 설명, 위치)
    const url = xd.find((x) => x.app.toUpperCase() === 'PE_URL');
    if (url) {
      const strs = url.items.filter((it) => it.code === 1000).map((it) => String(it.value));
      if (strs[0]) {
        e.hyperlink = { url: strs[0] };
        if (strs[1]) e.hyperlink.description = strs[1];
        if (strs[2]) e.hyperlink.location = strs[2];
      }
    }
  }
  if (h.xdict) e.xdict = hex(h.xdict);
  if (h.reactors.length) e.reactors = h.reactors.map(hex);
  if (c.plotStyle) e.plotStyle = hex(c.plotStyle);
  if (c.material) e.material = hex(c.material);
  return e;
}

const isZAxis = (v: Vec3): boolean => Math.abs(v.x) < 1e-12 && Math.abs(v.y) < 1e-12 && Math.abs(v.z - 1) < 1e-12;

function setExtrusion(e: { extrusion?: Vec3 }, v: Vec3): void {
  if (!isZAxis(v)) e.extrusion = v;
}

function setThickness(e: { thickness?: number }, t: number): void {
  if (t) e.thickness = t;
}

// ---------------------------------------------------------------------------
// 문자
// ---------------------------------------------------------------------------

interface TextData {
  insert: Vec3;
  alignPoint?: Vec3;
  extrusion: Vec3;
  thickness: number;
  oblique: number;
  rotation: number;
  height: number;
  widthFactor: number;
  text: string;
  generation: number;
  halign: number;
  valign: number;
}

function readTextData(r: BitReader, ver: number): TextData {
  if (ver <= R14) {
    const elev = r.BD();
    const ins = r.RD2();
    const al = r.RD2();
    const extrusion = r.BD3();
    const thickness = r.BD();
    const oblique = r.BD();
    const rotation = r.BD();
    const height = r.BD();
    const widthFactor = r.BD();
    const text = r.TV();
    const generation = r.BS();
    const halign = r.BS();
    const valign = r.BS();
    return {
      insert: { x: ins.x, y: ins.y, z: elev },
      alignPoint: { x: al.x, y: al.y, z: elev },
      extrusion,
      thickness,
      oblique,
      rotation,
      height,
      widthFactor,
      text,
      generation,
      halign,
      valign,
    };
  }
  const df = r.RC();
  const elev = df & 1 ? 0 : r.RD();
  const ins = r.RD2();
  let al: Vec2 | undefined;
  if (!(df & 2)) al = { x: r.DD(ins.x), y: r.DD(ins.y) };
  const extrusion = r.BE();
  const thickness = r.BT();
  const oblique = df & 4 ? 0 : r.RD();
  const rotation = df & 8 ? 0 : r.RD();
  const height = r.RD();
  const widthFactor = df & 0x10 ? 1 : r.RD();
  const text = r.TV();
  const generation = df & 0x20 ? 0 : r.BS();
  const halign = df & 0x40 ? 0 : r.BS();
  const valign = df & 0x80 ? 0 : r.BS();
  return {
    insert: { x: ins.x, y: ins.y, z: elev },
    alignPoint: al ? { x: al.x, y: al.y, z: elev } : undefined,
    extrusion,
    thickness,
    oblique,
    rotation,
    height,
    widthFactor,
    text,
    generation,
    halign,
    valign,
  };
}

function textEntity(type: 'TEXT' | 'ATTRIB' | 'ATTDEF', b: Omit<EntityBase, 'type'>, t: TextData, style: string): TextEntity {
  const e: TextEntity = {
    ...b,
    type,
    insert: t.insert,
    height: t.height,
    text: t.text,
    rotation: t.rotation,
    widthFactor: t.widthFactor,
    oblique: t.oblique,
    style,
    generation: t.generation,
    halign: (t.halign <= 5 ? t.halign : 0) as TextHAlign,
    valign: (t.valign <= 3 ? t.valign : 0) as TextVAlign,
  };
  if (t.alignPoint && (t.halign !== 0 || t.valign !== 0)) e.alignPoint = t.alignPoint;
  setExtrusion(e, t.extrusion);
  setThickness(e, t.thickness);
  return e;
}

interface AttribTail {
  tag: string;
  flags: number;
  lock: boolean;
  prompt?: string;
  mtext?: MTextEntity;
}

function readAttribTail(or: ObjectReader, isDef: boolean, names: Names): AttribTail {
  const r = or.dat;
  const ver = or.ver;
  if (ver >= R2010) r.RC(); // 버전
  let attType = 1;
  if (ver >= R2018) attType = r.RC();
  const out: AttribTail = { tag: '', flags: 0, lock: false };
  if (attType === 1) {
    out.tag = r.TV();
    r.BS(); // 필드 길이
    out.flags = r.RC();
    if (ver >= R2007) out.lock = r.B() === 1;
  } else {
    // 여러 줄 속성(R2018): 끼워 넣은 MTEXT(공통 자료는 entmode부터) 다음에 태그 등이 온다
    const c = or.embeddedEntityCommon();
    const mb = entBase(or, c, names);
    delete mb.owner;
    delete mb.xdata;
    delete mb.reactors;
    delete mb.xdict;
    mb.handle = hex(or.h.handle);
    out.mtext = readMText(or, mb, names);
    const annSize = r.BS();
    if (annSize > 0) {
      r.checkCount(annSize, 8);
      r.pos += annSize * 8;
      or.hdl.H(or.h.handle);
      r.BS();
    }
    out.tag = r.TV();
    r.BS();
    out.flags = r.RC();
    out.lock = r.B() === 1;
  }
  if (isDef) {
    if (ver >= R2010) r.RC();
    out.prompt = r.TV();
  }
  return out;
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export function readEntity(or: ObjectReader, names: Names): ParsedEntity {
  const h = or.h;
  const c = or.commonEntity();
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = h.handle;
  const out: ParsedEntity = { handle: hb, owner: h.owner, entmode: c.entmode, prev: c.prev, next: c.next, kind: 'entity', entity: null };
  const b = entBase(or, c, names);
  const type = h.typeName;

  switch (type) {
    case 'TEXT': {
      const t = readTextData(r, ver);
      const style = names.style(hr.H(hb));
      out.entity = textEntity('TEXT', b, t, style);
      break;
    }
    case 'ATTRIB':
    case 'ATTDEF': {
      const t = readTextData(r, ver);
      // 문자 스타일 핸들이 끼워 넣은 MTEXT의 핸들보다 앞에 있다
      const style = names.style(hr.H(hb));
      const tail = readAttribTail(or, type === 'ATTDEF', names);
      const te = textEntity(type, b, t, style) as unknown as AttribEntity;
      te.tag = tail.tag;
      te.attFlags = tail.flags;
      if (tail.lock) te.lockPosition = true;
      if (tail.prompt !== undefined) te.prompt = tail.prompt;
      if (tail.mtext) te.mtext = tail.mtext;
      out.entity = te;
      if (type === 'ATTRIB') out.kind = 'attrib';
      break;
    }
    case 'BLOCK':
      out.kind = 'block';
      out.blockName = r.TV();
      out.layer = b.layer;
      break;
    case 'ENDBLK':
      out.kind = 'endblk';
      out.layer = b.layer;
      break;
    case 'SEQEND':
      out.kind = 'seqend';
      break;
    case 'INSERT':
    case 'MINSERT':
      out.entity = readInsert(or, b, out, names, type === 'MINSERT');
      break;
    case 'VERTEX_2D': {
      out.kind = 'vertex';
      const flags = r.RC();
      const p = r.BD3();
      let sw = r.BD();
      let ew: number;
      if (sw < 0) {
        sw = -sw;
        ew = sw;
      } else ew = r.BD();
      const bulge = r.BD();
      if (ver >= R2010) r.BL();
      const tangent = r.BD();
      const v: PolyVertex = { location: p, bulge, startWidth: sw, endWidth: ew, flags };
      if (flags & 2) v.tangent = tangent;
      out.vertex = v;
      break;
    }
    case 'VERTEX_3D':
    case 'VERTEX_MESH':
    case 'VERTEX_PFACE': {
      out.kind = 'vertex';
      const flags = r.RC();
      const p = r.BD3();
      out.vertex = { location: p, bulge: 0, startWidth: 0, endWidth: 0, flags };
      break;
    }
    case 'VERTEX_PFACE_FACE': {
      out.kind = 'vertex';
      const idx = [r.BS(), r.BS(), r.BS(), r.BS()];
      while (idx.length > 3 && idx[idx.length - 1] === 0) idx.pop();
      out.vertex = { location: { x: 0, y: 0, z: 0 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 128, faceIndices: idx };
      break;
    }
    case 'POLYLINE_2D':
    case 'POLYLINE_3D':
    case 'POLYLINE_PFACE':
    case 'POLYLINE_MESH':
      out.entity = readPolyline(or, b, out, type);
      break;
    case 'ARC': {
      const center = r.BD3();
      const radius = r.BD();
      const thickness = r.BT();
      const extrusion = r.BE();
      const startAngle = r.BD();
      const endAngle = r.BD();
      const e: ArcEntity = { ...b, type: 'ARC', center, radius, startAngle, endAngle };
      setExtrusion(e, extrusion);
      setThickness(e, thickness);
      out.entity = e;
      break;
    }
    case 'CIRCLE': {
      const center = r.BD3();
      const radius = r.BD();
      const thickness = r.BT();
      const extrusion = r.BE();
      const e: CircleEntity = { ...b, type: 'CIRCLE', center, radius };
      setExtrusion(e, extrusion);
      setThickness(e, thickness);
      out.entity = e;
      break;
    }
    case 'LINE': {
      let start: Vec3;
      let end: Vec3;
      if (ver <= R14) {
        start = r.BD3();
        end = r.BD3();
      } else {
        const zz = r.B();
        const sx = r.RD();
        const ex = r.DD(sx);
        const sy = r.RD();
        const ey = r.DD(sy);
        let sz = 0;
        let ez = 0;
        if (!zz) {
          sz = r.RD();
          ez = r.DD(sz);
        }
        start = { x: sx, y: sy, z: sz };
        end = { x: ex, y: ey, z: ez };
      }
      const thickness = r.BT();
      const extrusion = r.BE();
      const e: LineEntity = { ...b, type: 'LINE', start, end };
      setExtrusion(e, extrusion);
      setThickness(e, thickness);
      out.entity = e;
      break;
    }
    case 'DIMENSION_ORDINATE':
    case 'DIMENSION_LINEAR':
    case 'DIMENSION_ALIGNED':
    case 'DIMENSION_ANG3PT':
    case 'DIMENSION_ANG2LN':
    case 'DIMENSION_RADIUS':
    case 'DIMENSION_DIAMETER':
    case 'ARC_DIMENSION':
    case 'LARGE_RADIAL_DIMENSION':
      out.entity = readDimension(or, b, names, type);
      break;
    case 'POINT': {
      const position = r.BD3();
      const thickness = r.BT();
      const extrusion = r.BE();
      const angle = r.BD();
      const e: PointEntity = { ...b, type: 'POINT', position, angle };
      setExtrusion(e, extrusion);
      setThickness(e, thickness);
      out.entity = e;
      break;
    }
    case '3DFACE': {
      let pts: [Vec3, Vec3, Vec3, Vec3];
      let invis = 0;
      if (ver <= R14) {
        pts = [r.BD3(), r.BD3(), r.BD3(), r.BD3()];
        invis = r.BS();
      } else {
        const noFlags = r.B();
        const zz = r.B();
        const x = r.RD();
        const y = r.RD();
        const z = zz ? 0 : r.RD();
        const p1 = { x, y, z };
        const p2 = r.DD3(p1);
        const p3 = r.DD3(p2);
        const p4 = r.DD3(p3);
        pts = [p1, p2, p3, p4];
        if (!noFlags) invis = r.BS();
      }
      out.entity = { ...b, type: '3DFACE', points: pts, invisibleEdges: invis } as FaceEntity;
      break;
    }
    case 'SOLID':
    case 'TRACE': {
      const thickness = r.BT();
      const elev = r.BD();
      const p: Vec3[] = [];
      for (let i = 0; i < 4; i++) {
        const q = r.RD2();
        p.push({ x: q.x, y: q.y, z: elev });
      }
      const extrusion = r.BE();
      const e: FaceEntity = { ...b, type, points: p as [Vec3, Vec3, Vec3, Vec3], invisibleEdges: 0 };
      setExtrusion(e, extrusion);
      setThickness(e, thickness);
      out.entity = e;
      break;
    }
    case 'SHAPE': {
      const insert = r.BD3();
      const size = r.BD();
      const rotation = r.BD();
      const widthFactor = r.BD();
      const oblique = r.BD();
      const thickness = r.BD();
      const shapeNumber = r.BS();
      const extrusion = r.BD3();
      const sh = hr.H(hb);
      const e: ShapeEntity = { ...b, type: 'SHAPE', insert, size, name: '', shapeNumber, rotation, widthFactor, oblique };
      if (sh) e.styleHandle = hex(sh);
      setExtrusion(e, extrusion);
      setThickness(e, thickness);
      out.entity = e;
      break;
    }
    case 'VIEWPORT':
      out.entity = readViewport(or, b, names);
      break;
    case 'ELLIPSE': {
      const center = r.BD3();
      const majorAxis = r.BD3();
      const extrusion = r.BD3();
      const ratio = r.BD();
      const startParam = r.BD();
      const endParam = r.BD();
      const e: EllipseEntity = { ...b, type: 'ELLIPSE', center, majorAxis, ratio, startParam, endParam };
      setExtrusion(e, extrusion);
      out.entity = e;
      break;
    }
    case 'SPLINE':
    case 'HELIX':
      out.entity = readSpline(or, b, type === 'HELIX');
      break;
    case 'REGION':
    case '3DSOLID':
    case 'BODY':
    case 'SURFACE':
    case 'PLANESURFACE':
    case 'EXTRUDEDSURFACE':
    case 'LOFTEDSURFACE':
    case 'REVOLVEDSURFACE':
    case 'SWEPTSURFACE':
    case 'NURBSURFACE': {
      const e: AcisEntity = { ...b, type };
      out.entity = e;
      break;
    }
    case 'RAY':
    case 'XLINE': {
      const base = r.BD3();
      const direction = r.BD3();
      out.entity = { ...b, type, base, direction } as XLineEntity;
      break;
    }
    case 'MTEXT': {
      const ext = { height: 0, width: 0 };
      out.entity = readMText(or, b, names, ext);
      out.extents = ext;
      break;
    }
    case 'LEADER':
      out.entity = readLeader(or, b, names);
      break;
    case 'TOLERANCE': {
      if (ver <= R14) {
        r.BS();
        r.BD();
        r.BD();
      }
      const insert = r.BD3();
      const direction = r.BD3();
      const extrusion = r.BD3();
      const text = r.TV();
      const dimStyle = names.dimstyle(hr.H(hb));
      const e: ToleranceEntity = { ...b, type: 'TOLERANCE', dimStyle, insert, text, direction };
      setExtrusion(e, extrusion);
      out.entity = e;
      break;
    }
    case 'MLINE':
      out.entity = readMLine(or, b, names);
      break;
    case 'LWPOLYLINE':
      out.entity = readLwPolyline(or, b);
      break;
    case 'HATCH':
      out.entity = readHatch(or, b, 'HATCH');
      break;
    case 'IMAGE':
    case 'WIPEOUT':
      out.entity = readImage(or, b, type);
      break;
    case 'OLE2FRAME':
    case 'OLEFRAME': {
      r.BS();
      if (ver >= R2000) r.BS();
      const e: Ole2FrameEntity = { ...b, type, upperLeft: { x: 0, y: 0, z: 0 }, lowerRight: { x: 0, y: 0, z: 0 } };
      out.entity = e;
      break;
    }
    case 'MULTILEADER':
      out.entity = readMLeader(or, b);
      break;
    case 'ACAD_TABLE':
      out.entity = readTable(or, b, names);
      break;
    case 'MESH':
      out.entity = readMesh(or, b);
      break;
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      out.entity = readUnderlay(or, b, type);
      break;
    default: {
      const e: UnknownEntity = { ...b, type: 'UNKNOWN', originalType: type };
      if (c.graphics) e.graphics = c.graphics;
      out.entity = e;
      break;
    }
  }
  if (out.entity && c.graphics && out.entity.type !== 'UNKNOWN') {
    // 프록시 그림이 있는 ACIS·기타 도형은 그림 바이트를 남긴다
    if (out.entity.type === 'REGION' || out.entity.type === '3DSOLID' || out.entity.type === 'BODY') {
      (out.entity as unknown as { graphics?: Uint8Array }).graphics = c.graphics;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 블록 참조
// ---------------------------------------------------------------------------

function readInsertScale(r: BitReader, ver: number): Vec3 {
  if (ver <= R14) return r.BD3();
  switch (r.BB()) {
    case 3:
      return { x: 1, y: 1, z: 1 };
    case 1: {
      const y = r.DD(1);
      return { x: 1, y, z: r.DD(1) };
    }
    case 2: {
      const x = r.RD();
      return { x, y: x, z: x };
    }
    default: {
      const x = r.RD();
      const y = r.DD(x);
      return { x, y, z: r.DD(x) };
    }
  }
}

function readInsert(or: ObjectReader, b: Omit<EntityBase, 'type'>, out: ParsedEntity, names: Names, minsert: boolean): InsertEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = or.h.handle;
  const insert = r.BD3();
  const scale = readInsertScale(r, ver);
  const rotation = r.BD();
  const extrusion = r.BD3();
  const hasAttribs = r.B() === 1;
  let owned = 0;
  // 소유 객체 수는 속성이 있을 때만 있다(사양은 늘 있다고 하지만 ACAD_TABLE 표본으로 확인)
  if (ver >= R2004 && hasAttribs) owned = r.BL();
  let columnCount = 1;
  let rowCount = 1;
  let columnSpacing = 0;
  let rowSpacing = 0;
  if (minsert) {
    columnCount = r.BS();
    rowCount = r.BS();
    columnSpacing = r.BD();
    rowSpacing = r.BD();
  }
  const block = names.block(hr.H(hb));
  if (hasAttribs) {
    if (ver < R2004) {
      out.firstChild = hr.H(hb);
      out.lastChild = hr.H(hb);
    } else {
      hr.checkCount(owned, 8);
      out.children = [];
      for (let i = 0; i < owned; i++) out.children.push(hr.H(hb));
    }
    out.seqend = hr.H(hb);
  }
  const e: InsertEntity = { ...b, type: 'INSERT', block, insert, scale, rotation, columnCount, rowCount, columnSpacing, rowSpacing, attribs: [] };
  setExtrusion(e, extrusion);
  return e;
}

// ---------------------------------------------------------------------------
// 폴리선
// ---------------------------------------------------------------------------

function readPolyChildren(or: ObjectReader, out: ParsedEntity, owned: number): void {
  const hr = or.hdl;
  const hb = or.h.handle;
  if (or.ver < R2004) {
    out.firstChild = hr.H(hb);
    out.lastChild = hr.H(hb);
  } else {
    hr.checkCount(owned, 8);
    out.children = [];
    for (let i = 0; i < owned; i++) out.children.push(hr.H(hb));
  }
  out.seqend = hr.H(hb);
}

function readPolyline(or: ObjectReader, b: Omit<EntityBase, 'type'>, out: ParsedEntity, type: string): PolylineEntity {
  const r = or.dat;
  const ver = or.ver;
  const e: PolylineEntity = {
    ...b,
    type: 'POLYLINE',
    kind: '2d',
    flags: 0,
    vertices: [],
    elevation: 0,
    defaultStartWidth: 0,
    defaultEndWidth: 0,
    mCount: 0,
    nCount: 0,
    mDensity: 0,
    nDensity: 0,
    smoothType: 0,
  };
  let owned = 0;
  if (type === 'POLYLINE_2D') {
    e.flags = r.BS();
    e.smoothType = r.BS();
    e.defaultStartWidth = r.BD();
    e.defaultEndWidth = r.BD();
    setThickness(e, r.BT());
    e.elevation = r.BD();
    setExtrusion(e, r.BE());
  } else if (type === 'POLYLINE_3D') {
    e.kind = '3d';
    const f75 = r.RC();
    const f70 = r.RC();
    e.flags = 8 | (f70 & 1 ? 1 : 0);
    if (f75 & 1) {
      e.smoothType = 5;
      e.flags |= 4;
    } else if (f75 & 2) {
      e.smoothType = 6;
      e.flags |= 4;
    }
  } else if (type === 'POLYLINE_PFACE') {
    e.kind = 'polyface';
    e.flags = 64;
    e.mCount = r.BS();
    e.nCount = r.BS();
  } else {
    e.kind = 'mesh';
    e.flags = r.BS() | 16;
    e.smoothType = r.BS();
    e.mCount = r.BS();
    e.nCount = r.BS();
    e.mDensity = r.BS();
    e.nDensity = r.BS();
  }
  if (ver >= R2004) owned = r.BL();
  readPolyChildren(or, out, owned);
  return e;
}

function readLwPolyline(or: ObjectReader, b: Omit<EntityBase, 'type'>): LwPolylineEntity {
  const r = or.dat;
  const ver = or.ver;
  const flag = r.BS();
  let constantWidth = 0;
  let elevation = 0;
  let thickness = 0;
  let normal: Vec3 = { x: 0, y: 0, z: 1 };
  if (flag & 4) constantWidth = r.BD();
  if (flag & 8) elevation = r.BD();
  if (flag & 2) thickness = r.BD();
  if (flag & 1) normal = r.BD3();
  const np = r.checkCount(r.BL(), 16);
  let nb = 0;
  let nid = 0;
  let nw = 0;
  if (flag & 16) nb = r.checkCount(r.BL(), 2);
  if (ver >= R2010 && flag & 1024) nid = r.checkCount(r.BL(), 2);
  if (flag & 32) nw = r.checkCount(r.BL(), 4);
  const verts: LwVertex[] = new Array(np);
  if (ver <= R14) {
    for (let i = 0; i < np; i++) {
      const x = r.RD();
      verts[i] = { x, y: r.RD(), bulge: 0, startWidth: 0, endWidth: 0 };
    }
  } else if (np > 0) {
    let x = r.RD();
    let y = r.RD();
    verts[0] = { x, y, bulge: 0, startWidth: 0, endWidth: 0 };
    for (let i = 1; i < np; i++) {
      x = r.DD(x);
      y = r.DD(y);
      verts[i] = { x, y, bulge: 0, startWidth: 0, endWidth: 0 };
    }
  }
  for (let i = 0; i < nb; i++) {
    const v = r.BD();
    if (i < np) verts[i].bulge = v;
  }
  for (let i = 0; i < nid; i++) r.BL();
  for (let i = 0; i < nw; i++) {
    const s = r.BD();
    const w = r.BD();
    if (i < np) {
      verts[i].startWidth = s;
      verts[i].endWidth = w;
    }
  }
  const e: LwPolylineEntity = { ...b, type: 'LWPOLYLINE', vertices: verts, closed: (flag & 512) !== 0, plinegen: (flag & 256) !== 0, constantWidth, elevation };
  setExtrusion(e, normal);
  setThickness(e, thickness);
  return e;
}

// ---------------------------------------------------------------------------
// 스플라인
// ---------------------------------------------------------------------------

function readSpline(or: ObjectReader, b: Omit<EntityBase, 'type'>, helix: boolean): SplineEntity {
  const r = or.dat;
  const ver = or.ver;
  let scenario = r.BL();
  let flags = 0;
  let f1 = 0;
  if (ver >= R2013) {
    // R2013+: 맞춤점 방식(비트 1)이면 맞춤 자료, 매듭 매개변수가 사용자 지정(15)이면 조정점 자료
    f1 = r.BL();
    const knotParam = r.BL();
    if (f1 & 1) scenario = 2;
    if (knotParam === 15) scenario = 1;
    if (f1 & 4) flags |= 1;
  }
  const degree = r.BL();
  const e: SplineEntity = {
    ...b,
    type: 'SPLINE',
    flags: 0,
    degree,
    knots: [],
    controlPoints: [],
    fitPoints: [],
    knotTolerance: 0,
    controlTolerance: 0,
    fitTolerance: 0,
  };
  let nknots = 0;
  let nctrl = 0;
  let nfit = 0;
  let weighted = false;
  if (scenario === 2) {
    e.fitTolerance = r.BD();
    const bt = r.BD3();
    const et = r.BD3();
    if (bt.x || bt.y || bt.z) e.startTangent = bt;
    if (et.x || et.y || et.z) e.endTangent = et;
    nfit = r.checkCount(r.BL(), 64);
  } else if (scenario === 1) {
    const rational = r.B();
    const closed = r.B();
    const periodic = r.B();
    if (rational) flags |= 4;
    if (closed) flags |= 1;
    if (periodic) flags |= 2;
    e.knotTolerance = r.BD();
    e.controlTolerance = r.BD();
    nknots = r.checkCount(r.BL(), 2);
    nctrl = r.checkCount(r.BL(), 64);
    weighted = r.B() === 1;
  } else {
    throw new DwgFormatError(`스플라인 종류 ${scenario}`);
  }
  for (let i = 0; i < nknots; i++) e.knots.push(r.BD());
  const weights: number[] = [];
  for (let i = 0; i < nctrl; i++) {
    e.controlPoints.push(r.BD3());
    if (weighted) weights.push(r.BD());
  }
  if (weighted) e.weights = weights;
  for (let i = 0; i < nfit; i++) e.fitPoints.push(r.BD3());
  // DWG에는 평면 여부가 없어 점들로 판단한다(DXF 70 비트 8)
  const n = planeNormal(e.controlPoints.length ? e.controlPoints : e.fitPoints);
  if (n) {
    flags |= 8;
    e.normal = n;
  }
  // AutoCAD는 R2013+ DXF 70에 스플라인 플래그 1을 7비트 올려 함께 쓴다(예: 1160)
  if (f1) flags |= f1 << 7;
  e.flags = flags;
  if (helix) {
    r.BS(); // 주 버전
    r.BS(); // 부 버전
    const axisBase = r.BD3();
    const start = r.BD3();
    const axis = r.BD3();
    const radius = r.BD();
    const turns = r.BD();
    const turnHeight = r.BD();
    const ccw = r.B() === 1;
    const constrain = r.RC();
    e.helix = { axisBase, start, axis, radius, turns, turnHeight, ccw, constrain };
  }
  return e;
}

/** 점들이 한 평면에 있으면 단위 법선(모두 한 직선 위면 Z축), 아니면 null */
function planeNormal(pts: Vec3[]): Vec3 | null {
  if (pts.length < 3) return { x: 0, y: 0, z: 1 };
  const p0 = pts[0];
  let ext = 0;
  for (const p of pts) ext = Math.max(ext, Math.abs(p.x - p0.x), Math.abs(p.y - p0.y), Math.abs(p.z - p0.z));
  if (ext === 0) return { x: 0, y: 0, z: 1 };
  const tol = ext * 1e-9;
  let n: Vec3 | null = null;
  let best = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = { x: pts[i].x - p0.x, y: pts[i].y - p0.y, z: pts[i].z - p0.z };
    for (let j = i + 1; j < pts.length; j++) {
      const b = { x: pts[j].x - p0.x, y: pts[j].y - p0.y, z: pts[j].z - p0.z };
      const c = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
      const len = Math.hypot(c.x, c.y, c.z);
      if (len > best) {
        best = len;
        n = { x: c.x / len, y: c.y / len, z: c.z / len };
      }
    }
    if (best > ext * ext * 1e-3) break;
  }
  if (!n || best <= ext * ext * 1e-12) return { x: 0, y: 0, z: 1 };
  for (const p of pts) {
    const d = (p.x - p0.x) * n.x + (p.y - p0.y) * n.y + (p.z - p0.z) * n.z;
    if (Math.abs(d) > tol) return null;
  }
  if (n.z < 0 || (n.z === 0 && (n.y < 0 || (n.y === 0 && n.x < 0)))) n = { x: -n.x, y: -n.y, z: -n.z };
  return n;
}

// ---------------------------------------------------------------------------
// 여러 줄 문자
// ---------------------------------------------------------------------------

function readMText(or: ObjectReader, b: Omit<EntityBase, 'type'>, names: Names, ext?: { height: number; width: number }): MTextEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const insert = r.BD3();
  const extrusion = r.BD3();
  const direction = r.BD3();
  const width = r.BD();
  let rectHeight: number | undefined;
  if (ver >= R2007) rectHeight = r.BD();
  const height = r.BD();
  const attachment = r.BS();
  const drawingDirection = r.BS();
  const extH = r.BD(); // 실제 글자 범위(DXF에는 없음)
  const extW = r.BD();
  if (ext) {
    ext.height = extH;
    ext.width = extW;
  }
  const text = r.TV();
  const style = names.style(hr.H(or.h.handle));
  let lineSpacingStyle = 1;
  let lineSpacingFactor = 1;
  if (ver >= R2000) {
    lineSpacingStyle = r.BS();
    lineSpacingFactor = r.BD();
    r.B();
  }
  let backgroundFlags = 0;
  let backgroundScale = 1.5;
  let backgroundColor: CadColor | undefined;
  if (ver >= R2004) {
    backgroundFlags = r.BL();
    if (backgroundFlags & 1 || (ver >= R2018 && backgroundFlags & 0x10)) {
      backgroundScale = r.BD();
      backgroundColor = cmcToCad(r.CMC());
      r.BL(); // 투명도
    }
  }
  const e: MTextEntity = {
    ...b,
    type: 'MTEXT',
    insert,
    height,
    width,
    attachment,
    drawingDirection,
    text,
    style,
    direction,
    rotation: 0,
    lineSpacingStyle,
    lineSpacingFactor,
    backgroundFlags,
    backgroundScale,
  };
  if (rectHeight !== undefined) e.rectHeight = rectHeight;
  if (backgroundColor) e.backgroundColor = backgroundColor;
  setExtrusion(e, extrusion);
  if (ver >= R2018) {
    try {
      const notAnnotative = r.B();
      if (notAnnotative) {
        r.BS();
        r.B();
        hr.H(or.h.handle); // 등록 앱
        r.BL();
        r.BD3();
        r.BD3();
        r.BD();
        r.BD();
        r.BD();
        r.BD();
        const ctype = r.BS();
        if (ctype !== 0) {
          const count = r.BL();
          const cw = r.BD();
          const gutter = r.BD();
          const autoHeight = r.B() === 1;
          const flowReversed = r.B() === 1;
          const heights: number[] = [];
          if (!autoHeight && ctype === 2) {
            r.checkCount(count, 2);
            // 음수 높이(내용 높이를 음수로 둔 값)는 DXF처럼 0(지정 안 함)으로 둔다
            for (let i = 0; i < count; i++) heights.push(Math.max(0, r.BD()));
          }
          e.columns = { type: ctype, count, width: cw, gutter, autoHeight, flowReversed, heights };
        }
      }
    } catch {
      // 단 정보는 선택 사항
    }
  }
  return e;
}

// ---------------------------------------------------------------------------
// 치수
// ---------------------------------------------------------------------------

function readDimension(or: ObjectReader, b: Omit<EntityBase, 'type'>, names: Names, type: string): DimensionEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = or.h.handle;
  if (ver >= R2010) r.RC();
  const extrusion = r.BD3();
  const tm = r.RD2();
  const elev = r.BD();
  const flags1 = r.RC();
  const text = r.TV();
  const textRotation = r.BD();
  const horizontalDirection = r.BD();
  r.BD3(); // 삽입 축척
  r.BD(); // 삽입 회전
  let attachment = 5;
  let lineSpacingStyle = 1;
  let lineSpacingFactor = 1;
  let measurement = 0;
  if (ver >= R2000) {
    attachment = r.BS();
    lineSpacingStyle = r.BS();
    lineSpacingFactor = r.BD();
    measurement = r.BD();
  }
  if (ver >= R2007) {
    r.B();
    r.B();
    r.B();
  }
  const p12 = r.RD2();
  const zero: Vec3 = { x: 0, y: 0, z: 0 };
  const e: DimensionEntity = {
    ...b,
    type: 'DIMENSION',
    block: '',
    dimStyle: '',
    dimType: 0,
    defPoint: zero,
    textMid: { x: tm.x, y: tm.y, z: elev },
    defPoint2: zero,
    defPoint3: zero,
    defPoint4: zero,
    defPoint5: zero,
    text,
    measurement,
    rotation: 0,
    obliqueAngle: 0,
    textRotation,
    horizontalDirection,
    attachment,
    leaderLength: 0,
    lineSpacingStyle,
    lineSpacingFactor,
  };
  if (p12.x || p12.y) e.insertPoint = { x: p12.x, y: p12.y, z: elev };
  setExtrusion(e, extrusion);
  let dt = 0;
  switch (type) {
    case 'DIMENSION_ORDINATE': {
      dt = 6;
      e.defPoint = r.BD3();
      e.defPoint2 = r.BD3();
      e.defPoint3 = r.BD3();
      if (r.RC() & 1) dt |= 64;
      break;
    }
    case 'DIMENSION_LINEAR':
      dt = 0;
      e.defPoint2 = r.BD3();
      e.defPoint3 = r.BD3();
      e.defPoint = r.BD3();
      e.obliqueAngle = r.BD();
      e.rotation = r.BD();
      break;
    case 'DIMENSION_ALIGNED':
      dt = 1;
      e.defPoint2 = r.BD3();
      e.defPoint3 = r.BD3();
      e.defPoint = r.BD3();
      e.obliqueAngle = r.BD();
      break;
    case 'DIMENSION_ANG3PT':
      dt = 5;
      e.defPoint = r.BD3();
      e.defPoint2 = r.BD3();
      e.defPoint3 = r.BD3();
      e.defPoint4 = r.BD3();
      break;
    case 'DIMENSION_ANG2LN': {
      dt = 2;
      const p16 = r.RD2();
      e.defPoint5 = { x: p16.x, y: p16.y, z: elev };
      e.defPoint2 = r.BD3();
      e.defPoint3 = r.BD3();
      e.defPoint4 = r.BD3();
      e.defPoint = r.BD3();
      break;
    }
    case 'DIMENSION_RADIUS':
      dt = 4;
      e.defPoint = r.BD3();
      e.defPoint4 = r.BD3();
      e.leaderLength = r.BD();
      break;
    case 'DIMENSION_DIAMETER':
      dt = 3;
      e.defPoint4 = r.BD3();
      e.defPoint = r.BD3();
      e.leaderLength = r.BD();
      break;
    case 'ARC_DIMENSION': {
      dt = 5;
      e.subtype = 'ARC_DIMENSION';
      e.defPoint = r.BD3();
      e.defPoint2 = r.BD3();
      e.defPoint3 = r.BD3();
      const center = r.BD3();
      e.defPoint4 = center;
      const partial = r.B() === 1;
      const startAngle = r.BD();
      const endAngle = r.BD();
      const hasLeader = r.B() === 1;
      const l1 = r.BD3();
      const l2 = r.BD3();
      e.arc = { center, start: e.defPoint2, end: e.defPoint3, startAngle, endAngle, partial };
      if (hasLeader) {
        e.arc.leader1 = l1;
        e.arc.leader2 = l2;
      }
      break;
    }
    case 'LARGE_RADIAL_DIMENSION': {
      dt = 4;
      e.subtype = 'LARGE_RADIAL_DIMENSION';
      e.defPoint = r.BD3();
      e.defPoint4 = r.BD3();
      r.BD();
      e.defPoint2 = r.BD3();
      e.defPoint3 = r.BD3();
      break;
    }
  }
  if (!(flags1 & 1)) dt |= 128;
  if (flags1 & 2) dt |= 32;
  e.dimType = dt;
  e.dimStyle = names.dimstyle(hr.H(hb));
  e.block = names.block(hr.H(hb));
  return e;
}

// ---------------------------------------------------------------------------
// 지시선
// ---------------------------------------------------------------------------

function readLeader(or: ObjectReader, b: Omit<EntityBase, 'type'>, names: Names): LeaderEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  r.B();
  const creation = r.BS();
  const pathType = r.BS();
  const n = r.checkCount(r.BL(), 64);
  const vertices: Vec3[] = [];
  for (let i = 0; i < n; i++) vertices.push(r.BD3());
  r.BD3(); // 원점
  const normal = r.BD3();
  const horizontalDirection = r.BD3();
  const blockOffset = r.BD3();
  let annotationOffset: Vec3 | undefined;
  if (ver >= R14) annotationOffset = r.BD3();
  if (ver <= R14) r.BD();
  // R2010+에는 글 상자 크기가 없다(표본으로 확인)
  let textHeight = 0;
  let textWidth = 0;
  if (ver < R2010) {
    textHeight = r.BD();
    textWidth = r.BD();
  }
  const hooklineOnX = r.B() === 1;
  const arrowHead = r.B() === 1;
  if (ver <= R14) {
    r.BS();
    r.BD();
    r.B();
    r.B();
    r.BS();
    r.BS();
    r.B();
    r.B();
  } else {
    r.BS();
    r.B();
    r.B();
  }
  const ann = hr.H(or.h.handle);
  const dimStyle = names.dimstyle(hr.H(or.h.handle));
  const e: LeaderEntity = {
    ...b,
    type: 'LEADER',
    dimStyle,
    vertices,
    arrowHead,
    pathType,
    creation,
    hooklineDirection: hooklineOnX ? 1 : 0,
    hookline: false,
    textHeight,
    textWidth,
    horizontalDirection,
    blockOffset,
  };
  if (annotationOffset) e.annotationOffset = annotationOffset;
  if (ann) e.annotation = hex(ann);
  if (!isZAxis(normal)) {
    e.normal = normal;
    e.extrusion = normal;
  }
  return e;
}

// ---------------------------------------------------------------------------
// 다중선
// ---------------------------------------------------------------------------

function readMLine(or: ObjectReader, b: Omit<EntityBase, 'type'>, names: Names): MLineEntity {
  const r = or.dat;
  const hr = or.hdl;
  const scale = r.BD();
  const justification = r.RC();
  const startPoint = r.BD3();
  const normal = r.BD3();
  const oc = r.BS();
  const lines = r.RC();
  const nv = r.checkCount(r.BS(), 64);
  const vertices: MLineVertex[] = [];
  for (let i = 0; i < nv; i++) {
    const position = r.BD3();
    const direction = r.BD3();
    const miter = r.BD3();
    const elements: MLineVertex['elements'] = [];
    for (let k = 0; k < lines; k++) {
      const np = r.checkCount(r.BS(), 2);
      const params: number[] = [];
      for (let j = 0; j < np; j++) params.push(r.BD());
      const nf = r.checkCount(r.BS(), 2);
      const fillParams: number[] = [];
      for (let j = 0; j < nf; j++) fillParams.push(r.BD());
      elements.push({ params, fillParams });
    }
    vertices.push({ position, direction, miter, elements });
  }
  const sh = hr.H(or.h.handle);
  // 71 플래그를 그대로 담는다(1 정점 있음, 2 닫힘, 4·8 마구리 생략)
  const flags = oc;
  const e: MLineEntity = {
    ...b,
    type: 'MLINE',
    styleName: names.mlinestyle(sh),
    scale,
    justification,
    flags,
    startPoint,
    normal,
    vertices,
    elementCount: lines,
  };
  if (sh) e.styleHandle = hex(sh);
  return e;
}

// ---------------------------------------------------------------------------
// 뷰포트
// ---------------------------------------------------------------------------

function readViewport(or: ObjectReader, b: Omit<EntityBase, 'type'>, names: Names): ViewportEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = or.h.handle;
  const center = r.BD3();
  const width = r.BD();
  const height = r.BD();
  const e: ViewportEntity = {
    ...b,
    type: 'VIEWPORT',
    center,
    width,
    height,
    status: 0,
    id: 0,
    viewCenter: { x: 0, y: 0 },
    snapBase: { x: 0, y: 0 },
    snapSpacing: { x: 0, y: 0 },
    gridSpacing: { x: 0, y: 0 },
    viewDirection: { x: 0, y: 0, z: 1 },
    viewTarget: { x: 0, y: 0, z: 0 },
    lensLength: 50,
    frontClip: 0,
    backClip: 0,
    viewHeight: 0,
    snapAngle: 0,
    twistAngle: 0,
    circleSides: 100,
    flags: 0,
    frozenLayers: [],
    renderMode: 0,
    ucsPerViewport: false,
  };
  if (ver <= R14) {
    // R13·R14는 보기 정보를 ACAD 확장 자료(MVIEW)에 둔다
    applyMviewXData(e, names);
    return e;
  }
  e.viewTarget = r.BD3();
  e.viewDirection = r.BD3();
  e.twistAngle = r.BD();
  e.viewHeight = r.BD();
  e.lensLength = r.BD();
  e.frontClip = r.BD();
  e.backClip = r.BD();
  e.snapAngle = r.BD();
  e.viewCenter = r.RD2();
  e.snapBase = r.RD2();
  e.snapSpacing = r.RD2();
  e.gridSpacing = r.RD2();
  e.circleSides = r.BS();
  if (ver >= R2007) r.BS();
  const nfrozen = r.checkCount(r.BL(), 0);
  e.flags = r.BL();
  e.styleSheet = r.TV();
  e.renderMode = r.RC();
  r.B();
  e.ucsPerViewport = r.B() === 1;
  e.ucsOrigin = r.BD3();
  e.ucsXAxis = r.BD3();
  e.ucsYAxis = r.BD3();
  r.BD();
  r.BS();
  if (ver >= R2004) r.BS();
  if (ver >= R2007) {
    r.B();
    r.RC();
    r.BD();
    r.BD();
    r.CMC();
  }
  hr.checkCount(nfrozen, 8);
  for (let i = 0; i < nfrozen; i++) {
    const n = names.layer(hr.H(hb));
    if (n) e.frozenLayers.push(n);
  }
  const clip = hr.H(hb);
  if (clip) e.clipBoundary = hex(clip);
  return e;
}

function applyMviewXData(e: ViewportEntity, names: Names): void {
  // ACAD 확장 자료 "MVIEW"(R12와 같은 순서): 버전, 대상점, 방향, 비틀기, 높이, 중심 x·y, 렌즈, 앞·뒤 자르기,
  // 보기 모드, 원 확대, 빠른 확대, UCS 아이콘, 스냅, 격자, 스냅 방식, 등각 쌍, 스냅 각도, 스냅 기준 x·y,
  // 스냅 간격 x·y, 격자 간격 x·y, 숨은선 출력, { 동결 도면층… }
  e.styleSheet = '';
  e.ucsOrigin = { x: 0, y: 0, z: 0 };
  e.ucsXAxis = { x: 1, y: 0, z: 0 };
  e.ucsYAxis = { x: 0, y: 1, z: 0 };
  const x = e.xdata?.find((d) => d.app.toUpperCase() === 'ACAD');
  if (!x) return;
  const it = x.items;
  const i0 = it.findIndex((t) => t.code === 1000 && t.value === 'MVIEW');
  if (i0 < 0) return;
  let i = i0 + 1;
  if (it[i]?.code === 1002) i++;
  const next = (): unknown => it[i++]?.value;
  const num = (): number => Number(next()) || 0;
  next(); // 버전
  const target = next() as Vec3 | undefined;
  const dir = next() as Vec3 | undefined;
  if (target && typeof target === 'object') e.viewTarget = target;
  if (dir && typeof dir === 'object') e.viewDirection = dir;
  e.twistAngle = num();
  e.viewHeight = num();
  e.viewCenter = { x: num(), y: num() };
  e.lensLength = num() || 50;
  e.frontClip = num();
  e.backClip = num();
  let flags = num() & 0x1f;
  e.circleSides = num() || 100;
  if (num()) flags |= 128;
  const icon = num();
  if (icon & 1) flags |= 32;
  if (icon & 2) flags |= 64;
  if (num()) flags |= 256;
  if (num()) flags |= 512;
  if (num()) flags |= 1024;
  const iso = num();
  if (iso === 1) flags |= 4096;
  else if (iso === 2) flags |= 8192;
  e.snapAngle = num();
  e.snapBase = { x: num(), y: num() };
  e.snapSpacing = { x: num(), y: num() };
  e.gridSpacing = { x: num(), y: num() };
  if (num()) flags |= 2048;
  e.flags = flags;
  // 동결 도면층(1003)
  for (; i < it.length; i++) {
    const v = it[i];
    if (v.code !== 1003 || typeof v.value !== 'string') continue;
    const n = names.layer(parseInt(v.value, 16));
    if (n) e.frozenLayers.push(n);
  }
}

// ---------------------------------------------------------------------------
// 해치
// ---------------------------------------------------------------------------

/** 시계 방향 경계 각도를 반시계 순서로 바꾼다(모델 규칙) */
function ccwAngles(start: number, end: number, ccw: boolean): [number, number] {
  if (ccw) return [start, end];
  return [PI2 - end, PI2 - start];
}

function readHatch(or: ObjectReader, b: Omit<EntityBase, 'type'>, type: 'HATCH'): HatchEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = or.h.handle;
  const e: HatchEntity = {
    ...b,
    type,
    patternName: '',
    solid: false,
    associative: false,
    hatchStyle: 0,
    patternType: 1,
    patternAngle: 0,
    patternScale: 1,
    patternDouble: false,
    elevation: 0,
    paths: [],
    patternLines: [],
    pixelSize: 0,
    seedPoints: [],
  };
  if (ver >= R2004) {
    const isGrad = r.BL();
    r.BL();
    const angle = r.BD();
    const shift = r.BD();
    const single = r.BL();
    const tint = r.BD();
    const nc = r.checkCount(r.BL(), 8);
    const colors: CadColor[] = [];
    for (let i = 0; i < nc; i++) {
      r.BD(); // 위치(463)
      const aci = r.BS(); // 사양은 '알 수 없음'이라 하지만 DXF 63(ACI)과 같다
      const rgb = r.BLu();
      r.RC();
      colors.push(cmcToCad({ index: aci, rgb }));
    }
    const name = r.TV();
    if (isGrad) {
      e.gradient = {
        enabled: true,
        name,
        color1: colors[0] ?? { aci: 5 },
        color2: colors[1] ?? colors[0] ?? { aci: 2 },
        singleColor: single !== 0,
        tint,
        angle,
        shift,
      };
    }
  }
  e.elevation = r.BD();
  setExtrusion(e, r.BD3());
  e.patternName = r.TV();
  e.solid = r.B() === 1;
  e.associative = r.B() === 1;
  const np = r.checkCount(r.BL(), 8);
  let anyDerived = false;
  const boundaryCounts: number[] = [];
  for (let p = 0; p < np; p++) {
    const flags = r.BL();
    const path: HatchPath = { flags };
    if (flags & 4) anyDerived = true;
    if (!(flags & 2)) {
      const ns = r.checkCount(r.BL(), 8);
      const edges: HatchEdge[] = [];
      for (let s = 0; s < ns; s++) {
        const et = r.RC();
        if (et === 1) {
          edges.push({ type: 'line', start: r.RD2(), end: r.RD2() });
        } else if (et === 2) {
          const center = r.RD2();
          const radius = r.BD();
          const sa = r.BD();
          const ea = r.BD();
          const ccw = r.B() === 1;
          const [s0, e0] = ccwAngles(sa, ea, ccw);
          edges.push({ type: 'arc', center, radius, startAngle: s0, endAngle: e0, ccw });
        } else if (et === 3) {
          const center = r.RD2();
          const majorAxis = r.RD2();
          const ratio = r.BD();
          const sa = r.BD();
          const ea = r.BD();
          const ccw = r.B() === 1;
          const [s0, e0] = ccwAngles(sa, ea, ccw);
          edges.push({ type: 'ellipse', center, majorAxis, ratio, startAngle: s0, endAngle: e0, ccw });
        } else if (et === 4) {
          const degree = r.BL();
          const rational = r.B() === 1;
          const periodic = r.B() === 1;
          const nk = r.checkCount(r.BL(), 2);
          const nc = r.checkCount(r.BL(), 128);
          const knots: number[] = [];
          for (let i = 0; i < nk; i++) knots.push(r.BD());
          const controlPoints: Vec2[] = [];
          const weights: number[] = [];
          for (let i = 0; i < nc; i++) {
            controlPoints.push(r.RD2());
            if (rational) weights.push(r.BD());
          }
          const edge: HatchEdge = { type: 'spline', degree, rational, periodic, knots, controlPoints };
          if (rational) edge.weights = weights;
          if (ver >= R2010) {
            const nf = r.checkCount(r.BL(), 128);
            if (nf > 0) {
              const fit: Vec2[] = [];
              for (let i = 0; i < nf; i++) fit.push(r.RD2());
              edge.fitPoints = fit;
              edge.startTangent = r.RD2();
              edge.endTangent = r.RD2();
            }
          }
          edges.push(edge);
        } else {
          throw new DwgFormatError(`해치 경계 종류 ${et}`);
        }
      }
      path.edges = edges;
    } else {
      const bulges = r.B() === 1;
      const closed = r.B() === 1;
      const nv = r.checkCount(r.BL(), 128);
      const vertices: { x: number; y: number; bulge: number }[] = [];
      for (let i = 0; i < nv; i++) {
        const p = r.RD2();
        vertices.push({ x: p.x, y: p.y, bulge: bulges ? r.BD() : 0 });
      }
      path.polyline = { closed, vertices };
    }
    boundaryCounts.push(r.BL());
    e.paths.push(path);
  }
  e.hatchStyle = r.BS();
  e.patternType = r.BS();
  if (!e.solid) {
    e.patternAngle = r.BD();
    e.patternScale = r.BD();
    e.patternDouble = r.B() === 1;
    const nl = r.checkCount(r.BS(), 8);
    for (let i = 0; i < nl; i++) {
      const angle = r.BD();
      const base = r.BD2();
      const offset = r.BD2();
      const nd = r.checkCount(r.BS(), 2);
      const dashes: number[] = [];
      for (let k = 0; k < nd; k++) dashes.push(r.BD());
      const pl: HatchPatternLine = { angle, base, offset, dashes };
      e.patternLines.push(pl);
    }
  }
  if (anyDerived) e.pixelSize = r.BD();
  const ns = r.checkCount(r.BL(), 128);
  for (let i = 0; i < ns; i++) e.seedPoints.push(r.RD2());
  // 연관 경계 핸들
  for (let p = 0; p < e.paths.length; p++) {
    const n = boundaryCounts[p];
    if (n > 0 && n < 100000) {
      const src: string[] = [];
      for (let i = 0; i < n; i++) src.push(hex(hr.H(hb)));
      e.paths[p].sources = src;
    }
  }
  return e;
}

// ---------------------------------------------------------------------------
// 이미지·가림막
// ---------------------------------------------------------------------------

function readImage(or: ObjectReader, b: Omit<EntityBase, 'type'>, type: 'IMAGE' | 'WIPEOUT'): ImageEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  r.BL();
  const insert = r.BD3();
  const uVector = r.BD3();
  const vVector = r.BD3();
  const imageSize = r.RD2();
  const displayFlags = r.BS();
  const clipping = r.B() === 1;
  const brightness = r.RC();
  const contrast = r.RC();
  const fade = r.RC();
  let clipInverted: boolean | undefined;
  if (ver >= R2010) clipInverted = r.B() === 1;
  const clipBoundaryType = r.BS();
  const clipBoundary: Vec2[] = [];
  if (clipBoundaryType === 1) {
    clipBoundary.push(r.RD2(), r.RD2());
  } else {
    const n = r.checkCount(r.BL(), 128);
    for (let i = 0; i < n; i++) clipBoundary.push(r.RD2());
    // DXF처럼 다각형 경계는 첫 점으로 닫아 둔다
    const f = clipBoundary[0];
    const l = clipBoundary[clipBoundary.length - 1];
    if (n > 2 && (f.x !== l.x || f.y !== l.y)) clipBoundary.push({ x: f.x, y: f.y });
  }
  const def = hr.H(or.h.handle);
  const e: ImageEntity = { ...b, type, insert, uVector, vVector, imageSize, displayFlags, clipping, brightness, contrast, fade, clipBoundaryType, clipBoundary };
  if (def) e.imageDef = hex(def);
  if (clipInverted) e.clipInverted = true;
  return e;
}

// ---------------------------------------------------------------------------
// 다중 지시선
// ---------------------------------------------------------------------------

function readMLeader(or: ObjectReader, b: Omit<EntityBase, 'type'>): MLeaderEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = or.h.handle;
  const H = () => hr.H(hb);
  // 모델에 자리가 없는 값은 DXF 그룹 코드로 props에 둔다(DXF·DWG 쓰기용)
  const props: Record<number, number> = {};
  if (ver >= R2010) props[270] = r.BS();
  // MLeaderAnnotContext
  const nroots = r.checkCount(r.BL(), 64);
  const leaders: MLeaderLeader[] = [];
  for (let k = 0; k < nroots; k++) {
    const hasLast = r.B() === 1;
    const hasDogleg = r.B() === 1;
    const lastLeaderPoint = r.BD3();
    const doglegVector = r.BD3();
    const nb = r.checkCount(r.BL(), 128);
    for (let i = 0; i < nb; i++) {
      r.BD3();
      r.BD3();
    }
    const index = r.BL();
    const doglegLength = r.BD();
    const nl = r.checkCount(r.BL(), 64);
    const lines: MLeaderLine[] = [];
    for (let i = 0; i < nl; i++) {
      const npts = r.checkCount(r.BL(), 64);
      const vertices: Vec3[] = [];
      for (let j = 0; j < npts; j++) vertices.push(r.BD3());
      const nbi = r.checkCount(r.BL(), 2);
      const breaks: { start: Vec3; end: Vec3 }[] = [];
      for (let j = 0; j < nbi; j++) {
        r.BL(); // 구간 번호
        const npairs = r.checkCount(r.BL(), 128);
        for (let q = 0; q < npairs; q++) breaks.push({ start: r.BD3(), end: r.BD3() });
      }
      const li = r.BL();
      const line: MLeaderLine = { vertices, index: li };
      if (breaks.length) line.breaks = breaks;
      if (ver >= R2010) {
        r.BS();
        line.color = cmcToCad(r.CMC());
        H();
        r.BL();
        r.BD();
        H();
        r.BL();
      }
      lines.push(line);
    }
    let attachmentDirection = 0;
    if (ver >= R2010) attachmentDirection = r.BS();
    leaders.push({ lastLeaderPoint, doglegVector, doglegLength, hasLastPoint: hasLast, hasDogleg, lines, index, attachmentDirection });
  }
  const scale = r.BD();
  const contentBase = r.BD3();
  const textHeight = r.BD();
  const arrowSize = r.BD();
  const landingGap = r.BD();
  const cprops: Record<number, number> = {};
  cprops[174] = r.BS();
  cprops[175] = r.BS();
  const textAlign = r.BS();
  cprops[176] = textAlign;
  cprops[177] = r.BS();
  const ctx: MLeaderEntity['context'] = {
    scale,
    contentBase,
    textHeight,
    arrowSize,
    landingGap,
    leaders,
    basePoint: { x: 0, y: 0, z: 0 },
    baseDirection: { x: 1, y: 0, z: 0 },
    baseVertical: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };
  if (r.B()) {
    const text = r.TV();
    const normal = r.BD3();
    const style = H();
    const location = r.BD3();
    const direction = r.BD3();
    const rotation = r.BD();
    const width = r.BD();
    const height = r.BD();
    const lineSpacingFactor = r.BD();
    const lineSpacingStyle = r.BS();
    const color = cmcToCad(r.CMC());
    const attachment = r.BS();
    const flowDirection = r.BS();
    const backgroundColor = cmcToCad(r.CMC());
    const backgroundScale = r.BD();
    const tprops: Record<number, number> = {};
    tprops[92] = r.BL();
    // 사양 순서: 배경색 켜짐(DXF 291), 배경 채우기 켜짐(DXF 292 = backgroundFill)
    tprops[291] = r.B();
    const backgroundFill = r.B() === 1;
    tprops[173] = r.BS();
    tprops[293] = r.B();
    tprops[142] = r.BD();
    tprops[143] = r.BD();
    tprops[294] = r.B();
    const ncs = r.checkCount(r.BL(), 2);
    for (let i = 0; i < ncs; i++) r.BD();
    tprops[295] = r.B();
    r.B();
    ctx.text = {
      text,
      location,
      direction,
      normal,
      rotation,
      width,
      height,
      lineSpacingFactor,
      lineSpacingStyle,
      color,
      attachment: attachment || textAlign + 1,
      flowDirection,
      backgroundFill,
      backgroundColor,
      backgroundScale,
      props: tprops,
    };
    if (style) ctx.text.styleHandle = hex(style);
  } else if (r.B()) {
    const blk = H();
    const normal = r.BD3();
    const location = r.BD3();
    const scaleV = r.BD3();
    const rotation = r.BD();
    const color = cmcToCad(r.CMC());
    const matrix: number[] = [];
    for (let i = 0; i < 16; i++) matrix.push(r.BD());
    ctx.block = { location, normal, scale: scaleV, rotation, color, matrix };
    if (blk) ctx.block.blockHandle = hex(blk);
  }
  ctx.basePoint = r.BD3();
  ctx.baseDirection = r.BD3();
  ctx.baseVertical = r.BD3();
  cprops[297] = r.B();
  if (ver >= R2010) {
    cprops[273] = r.BS();
    cprops[272] = r.BS();
  }
  ctx.props = cprops;
  // MLEADER 본체
  const style = H();
  props[90] = r.BL(); // 재지정 플래그
  const leaderLineType = r.BS();
  const leaderLineColor = cmcToCad(r.CMC());
  const ltype = H();
  const leaderLineWeight = r.BL();
  const landing = r.B() === 1;
  const dogleg = r.B() === 1;
  const doglegLength = r.BD();
  const arrow = H();
  const arrowSz = r.BD();
  const contentType = r.BS();
  const textStyle = H();
  props[173] = r.BS();
  props[95] = r.BS();
  props[174] = r.BS();
  props[175] = r.BS();
  const textColor = cmcToCad(r.CMC());
  const textFrame = r.B() === 1;
  const block = H();
  const blockColor = cmcToCad(r.CMC());
  const blockScale = r.BD3();
  const blockRotation = r.BD();
  const blockConnection = r.BS();
  props[293] = r.B();
  // 화살촉 목록은 R2007까지만 있다(사양의 "-R2007")
  if (ver <= R2007) {
    const na = r.checkCount(r.BL(), 2);
    for (let i = 0; i < na; i++) {
      r.B();
      H();
    }
  }
  const nlab = r.checkCount(r.BL(), 2);
  const blockAttributes: NonNullable<MLeaderEntity['blockAttributes']> = [];
  for (let i = 0; i < nlab; i++) {
    const ad = H();
    const text = r.TV();
    const index = r.BS();
    const width = r.BD();
    blockAttributes.push({ attdefHandle: hex(ad), index, width, text });
  }
  props[294] = r.B();
  props[178] = r.BS();
  props[179] = r.BS();
  const sc = r.BD();
  if (ver >= R2010) {
    props[271] = r.BS();
    props[273] = r.BS();
    props[272] = r.BS();
  }
  if (ver >= R2013) props[295] = r.B();
  const e: MLeaderEntity = {
    ...b,
    type: 'MULTILEADER',
    leaderLineType,
    leaderLineColor,
    leaderLineWeight: lwRaw(leaderLineWeight),
    landing,
    dogleg,
    doglegLength,
    arrowSize: arrowSz,
    contentType,
    textColor,
    textFrame,
    blockColor,
    blockScale,
    blockRotation,
    blockConnection,
    scale: sc,
    context: ctx,
  };
  if (style) e.styleHandle = hex(style);
  if (ltype) e.leaderLineTypeHandle = hex(ltype);
  if (arrow) e.arrowHeadHandle = hex(arrow);
  if (textStyle) e.textStyleHandle = hex(textStyle);
  if (block) e.blockHandle = hex(block);
  if (blockAttributes.length) e.blockAttributes = blockAttributes;
  e.props = props;
  return e;
}

function lwRaw(v: number): number {
  if (v === 29 || v === -1) return -1;
  if (v === 30 || v === -2) return -2;
  if (v === 31 || v === -3) return -3;
  return v;
}

// ---------------------------------------------------------------------------
// 표
// ---------------------------------------------------------------------------

function readTable(or: ObjectReader, b: Omit<EntityBase, 'type'>, names: Names): TableEntity {
  const r = or.dat;
  const hr = or.hdl;
  const ver = or.ver;
  const hb = or.h.handle;
  const insert = r.BD3();
  const scale = readInsertScale(r, ver);
  const rotation = r.BD();
  const extrusion = r.BD3();
  const hasAttribs = r.B() === 1;
  let owned = 0;
  if (ver >= R2004 && hasAttribs) owned = r.BL();
  const block = names.block(hr.H(hb));
  if (hasAttribs) {
    if (ver < R2004) {
      hr.H(hb);
      hr.H(hb);
    } else for (let i = 0; i < owned; i++) hr.H(hb);
    hr.H(hb); // SEQEND
  }
  const e: TableEntity = {
    ...b,
    type: 'ACAD_TABLE',
    block,
    insert,
    direction: { x: Math.cos(rotation), y: Math.sin(rotation), z: 0 },
    scale,
    rotation,
    rows: 0,
    columns: 0,
    rowHeights: [],
    columnWidths: [],
  };
  setExtrusion(e, extrusion);
  // 표 본문 전체를 풀면(tablecodec.ts, 표본 71개가 같은 비트로 다시 써진다) DXF와 같은 원본 태그(병합·셀 재지정)도 만든다.
  const save = { d: r.pos, h: hr.pos, s: or.str.pos };
  const full = decodeTableBody(or, e, (h) => names.style(h));
  if (full) {
    e.rows = full.rows;
    e.columns = full.columns;
    e.rowHeights = full.rowHeights;
    e.columnWidths = full.columnWidths;
    e.cells = full.cells;
    if (full.tableStyle) e.tableStyle = full.tableStyle;
    e.raw = full.raw;
    e.rawVersion = `AC${ver}`;
    return e;
  }
  r.pos = save.d;
  hr.pos = save.h;
  or.str.pos = save.s;
  // 셀 자료는 선택 사항: 읽다 실패해도 표 도형은 남긴다(그림은 익명 *T 블록).
  // 행·열 크기를 다 읽은 뒤 셀에서 멈추면 크기는 살리고 셀 문자만 버린다.
  try {
    if (ver >= R2010) readTableContentR24(or, e);
    else readTableCellsOld(or, e);
  } catch {
    delete e.cells;
    if (e.rowHeights.length !== e.rows || e.columnWidths.length !== e.columns) {
      e.rows = 0;
      e.columns = 0;
      e.rowHeights = [];
      e.columnWidths = [];
    }
  }
  return e;
}

// ---------------------------------------------------------------------------
// 메시·참조 밑그림
// ---------------------------------------------------------------------------

function readMesh(or: ObjectReader, b: Omit<EntityBase, 'type'>): MeshEntity {
  const r = or.dat;
  r.BS(); // 버전
  r.B(); // 접힘 혼합
  const subdivision = r.BL();
  const nv = r.checkCount(r.BL(), 64);
  const vertices: Vec3[] = [];
  for (let i = 0; i < nv; i++) vertices.push(r.BD3());
  const nf = r.checkCount(r.BL(), 2);
  const faces: number[][] = [];
  for (let i = 0; i < nf; ) {
    const n = r.BL();
    i++;
    if (n <= 0 || n > nf) break;
    const f: number[] = [];
    for (let k = 0; k < n; k++) f.push(r.BL());
    i += n;
    faces.push(f);
  }
  const ne = r.checkCount(r.BL(), 2);
  const edges: [number, number][] = [];
  for (let i = 0; i < ne; i++) edges.push([r.BL(), r.BL()]);
  return { ...b, type: 'MESH', vertices, faces, edges, subdivision };
}

function readUnderlay(or: ObjectReader, b: Omit<EntityBase, 'type'>, type: UnderlayEntity['type']): UnderlayEntity {
  const r = or.dat;
  const hr = or.hdl;
  // 실제 파일 순서: 돌출 방향, 삽입점, 회전, 축척(사양에 없는 객체라 표본으로 확인)
  const extrusion = r.BD3();
  const insert = r.BD3();
  const rotation = r.BD();
  const scale = r.BD3();
  const flags = r.RC();
  const contrast = r.RC();
  const fade = r.RC();
  const n = r.checkCount(r.BL(), 128);
  const clipBoundary: Vec2[] = [];
  for (let i = 0; i < n; i++) clipBoundary.push(r.RD2());
  const def = hr.H(or.h.handle);
  const e: UnderlayEntity = { ...b, type, insert, scale, rotation, flags, contrast, fade, clipBoundary };
  if (def) e.definition = hex(def);
  setExtrusion(e, extrusion);
  return e;
}

