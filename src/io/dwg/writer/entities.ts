/**
 * 도형 쓰기(사양 20.4.3~20.4.50, 20.4.75~20.4.96, objects/entities.ts의 짝).
 * 읽기가 정규화한 값(지시선 걸이선 점, 이미지 경계 닫는 점, 폴리페이스 면 번호 등)은 되돌려 쓴다.
 */
import type {
  AttribEntity,
  CadColor,
  DimensionEntity,
  Entity,
  HatchEntity,
  ImageEntity,
  InsertEntity,
  LeaderEntity,
  MLeaderEntity,
  MTextEntity,
  PolylineEntity,
  PolyVertex,
  SplineEntity,
  TextEntity,
  Vec2,
  Vec3,
  ViewportEntity,
} from '../../../core/model';
import { R2000, R2004, R2007, R2010, R2013, R2018 } from '../version';
import type { PBlock, PEnt, WCtx } from './context';
import { HARD_OWNER, HARD_PTR, SOFT_PTR, type EntCommonOut, type ObjWriter } from './objwriter';
import { eedOf, wcolor } from './common';
import { lwIndex } from './util';

const Z: Vec3 = { x: 0, y: 0, z: 1 };
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const PI2 = Math.PI * 2;

/** 고정 종류 번호 */
export const T = {
  TEXT: 1,
  ATTRIB: 2,
  ATTDEF: 3,
  BLOCK: 4,
  ENDBLK: 5,
  SEQEND: 6,
  INSERT: 7,
  MINSERT: 8,
  VERTEX_2D: 10,
  VERTEX_3D: 11,
  VERTEX_MESH: 12,
  VERTEX_PFACE: 13,
  VERTEX_PFACE_FACE: 14,
  POLYLINE_2D: 15,
  POLYLINE_3D: 16,
  ARC: 17,
  CIRCLE: 18,
  LINE: 19,
  DIMENSION_ORDINATE: 20,
  DIMENSION_LINEAR: 21,
  DIMENSION_ALIGNED: 22,
  DIMENSION_ANG3PT: 23,
  DIMENSION_ANG2LN: 24,
  DIMENSION_RADIUS: 25,
  DIMENSION_DIAMETER: 26,
  POINT: 27,
  '3DFACE': 28,
  POLYLINE_PFACE: 29,
  POLYLINE_MESH: 30,
  SOLID: 31,
  TRACE: 32,
  SHAPE: 33,
  VIEWPORT: 34,
  ELLIPSE: 35,
  SPLINE: 36,
  REGION: 37,
  '3DSOLID': 38,
  BODY: 39,
  RAY: 40,
  XLINE: 41,
  OLEFRAME: 43,
  MTEXT: 44,
  LEADER: 45,
  TOLERANCE: 46,
  MLINE: 47,
  OLE2FRAME: 74,
  LWPOLYLINE: 77,
  HATCH: 78,
} as const;

const isZ = (v: Vec3 | undefined): boolean => !v || (Math.abs(v.x) < 1e-12 && Math.abs(v.y) < 1e-12 && Math.abs(v.z - 1) < 1e-12);

/** 임의 축 알고리즘(OCS X축) */
function ocsXAxis(n: Vec3): Vec3 {
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const z = { x: n.x / len, y: n.y / len, z: n.z / len };
  const lim = 1 / 64;
  let ax: Vec3 = Math.abs(z.x) < lim && Math.abs(z.y) < lim ? { x: z.z, y: 0, z: -z.x } : { x: -z.y, y: z.x, z: 0 };
  const l = Math.hypot(ax.x, ax.y, ax.z) || 1;
  ax = { x: ax.x / l, y: ax.y / l, z: ax.z / l };
  return ax;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** OCS 각도 → WCS 방향 */
export function ocsDirection(angle: number, n: Vec3 | undefined): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (isZ(n)) return { x: c, y: s, z: 0 };
  const ax = ocsXAxis(n!);
  const len = Math.hypot(n!.x, n!.y, n!.z) || 1;
  const nz = { x: n!.x / len, y: n!.y / len, z: n!.z / len };
  const ay = cross(nz, ax);
  return { x: ax.x * c + ay.x * s, y: ax.y * c + ay.y * s, z: ax.z * c + ay.z * s };
}

/** 쓰기 진행: 객체 하나를 다 쓰면 out에 넣는다 */
export interface EntSink {
  put(h: number, bytes: Uint8Array): void;
}

interface Links {
  owner: number;
  mode: number;
  prev: number;
  next: number;
}

export class EntityWriter {
  readonly ctx: WCtx;
  readonly ow: ObjWriter;
  sink: EntSink;
  readonly ver: number;
  /** LEADER 주석 MTEXT 핸들 → 글 상자 크기(R2010+에서 MTEXT 범위로 쓴다) */
  readonly leaderBox = new Map<number, { height: number; width: number }>();

  constructor(ctx: WCtx, ow: ObjWriter, sink: EntSink) {
    this.ctx = ctx;
    this.ow = ow;
    this.sink = sink;
    this.ver = ctx.ver;
    for (const pb of ctx.blocks) {
      for (const pe of pb.ents) {
        const e = pe.e;
        if (e.type === 'LEADER' && e.annotation && (e.textHeight || e.textWidth)) {
          this.leaderBox.set(ctx.ref(e.annotation), { height: e.textHeight, width: e.textWidth });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 공통
  // -------------------------------------------------------------------------

  /** 클래스 이름 → 종류 번호 */
  private cls(name: string): number {
    return this.ctx.classes.number(name, true);
  }

  private begin(type: number, h: number, e: { xdata?: Entity['xdata'] }): void {
    this.ow.begin(type, h, eedOf(this.ctx, e.xdata));
  }

  private common(e: Entity | MTextEntity, l: Links, dataStore = false, graphics?: Uint8Array): void {
    const ctx = this.ctx;
    const [ltFlags, lt] = ctx.linetype(e.linetype);
    const ps = ctx.ref(e.plotStyle);
    const c: EntCommonOut = {
      owner: l.mode === 0 ? l.owner : 0,
      reactors: ctx.refs(e.reactors),
      xdict: ctx.ref(e.xdict),
      graphics,
      entmode: l.mode,
      color: wcolor(ctx, e.color, e.transparency),
      ltscale: Number.isFinite(e.ltscale) ? e.ltscale : 1,
      ltypeFlags: ltFlags,
      ltype: lt,
      plotFlags: ps ? 3 : 0,
      plotStyle: ps,
      invisible: !!e.invisible,
      lineweight: lwIndex(e.lineweight ?? -1),
      layer: ctx.layer(e.layer),
      prev: l.prev,
      next: l.next,
      material: ctx.ref(e.material),
      dataStore,
    };
    this.ow.commonEntity(c);
  }

  private done(h: number): void {
    this.sink.put(h, this.ow.finish());
  }

  // -------------------------------------------------------------------------
  // 블록
  // -------------------------------------------------------------------------

  /** 블록 하나(BLOCK, 도형, ENDBLK). 쓰지 못한 도형은 pb.ents에서 뺀다 */
  writeBlock(pb: PBlock): void {
    const ctx = this.ctx;
    const ver = this.ver;
    const mode = pb.mode;
    const owner = pb.recH;
    const layer = pb.def.layer ?? '0';
    // 도형: R2000은 앞뒤 연결이 있으므로 실패한 도형을 빼고 다시 쓴다
    const real = this.sink;
    for (let attempt = 0; attempt < 8; attempt++) {
      const buf = new Map<number, Uint8Array>();
      this.sink = { put: (h, b) => buf.set(h, b) };
      const ents = pb.ents;
      const failed = new Set<PEnt>();
      for (let i = 0; i < ents.length; i++) {
        const pe = ents[i];
        const prev = ver < R2004 && i > 0 ? ents[i - 1].h : 0;
        const next = ver < R2004 && i + 1 < ents.length ? ents[i + 1].h : 0;
        try {
          this.writeEntity(pe, { owner, mode, prev, next });
        } catch (err) {
          ctx.warn('dwg.write_entity_failed', '도형을 쓰지 못해 뺐습니다.', { type: pe.e.type, handle: pe.e.handle, error: String(err) });
          failed.add(pe);
        }
      }
      this.sink = real;
      if (failed.size) {
        pb.ents = ents.filter((x) => !failed.has(x));
        for (const pe of failed) {
          ctx.live.delete(pe.h);
          if (pe.subs) for (const s of pe.subs) ctx.live.delete(s);
          if (pe.seqend) ctx.live.delete(pe.seqend);
        }
        if (ver < R2004) continue;
      }
      for (const [h, b] of buf) if (ctx.live.has(h)) real.put(h, b);
      break;
    }
    // BLOCK
    {
      const be = { layer, linetype: 'ByLayer', color: { aci: 256 }, lineweight: -1, ltscale: 1, transparency: -1, type: 'LINE', handle: '' } as unknown as Entity;
      this.ow.begin(T.BLOCK, pb.beginH, null);
      this.common(be, { owner, mode, prev: 0, next: 0 });
      this.ow.dat.TV(pb.name);
      this.done(pb.beginH);
    }
    // ENDBLK
    {
      const be = { layer, linetype: 'ByLayer', color: { aci: 256 }, lineweight: -1, ltscale: 1, transparency: -1, type: 'LINE', handle: '' } as unknown as Entity;
      this.ow.begin(T.ENDBLK, pb.endH, null);
      this.common(be, { owner, mode, prev: 0, next: 0 });
      this.done(pb.endH);
    }
  }

  private writeEntity(pe: PEnt, l: Links): void {
    const e = pe.e;
    const h = pe.h;
    if (pe.raw) {
      const raw = pe.raw;
      const type = raw.typeNum || this.cls(raw.typeName);
      this.begin(type, h, e);
      const g = raw.graphics ?? (e.type === 'UNKNOWN' ? e.graphics : (e as { graphics?: Uint8Array }).graphics);
      this.common(e, l, !!raw.dataStore, g);
      this.ow.appendRaw(raw.data, raw.dataBits, raw.strings, raw.stringBits ?? 0, raw.handles, raw.handleBits);
      this.done(h);
      return;
    }
    if (pe.asInsert) {
      const t = e as Extract<Entity, { type: 'ACAD_TABLE' }>;
      const ins: InsertEntity = { ...t, type: 'INSERT', block: t.block, insert: t.insert, scale: t.scale, rotation: t.rotation, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
      this.insert(ins, pe, l);
      return;
    }
    switch (e.type) {
      case 'LINE': {
        this.begin(T.LINE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        const zz = e.start.z === 0 && e.end.z === 0;
        d.B(zz);
        d.RD(e.start.x);
        d.DD(e.end.x, e.start.x);
        d.RD(e.start.y);
        d.DD(e.end.y, e.start.y);
        if (!zz) {
          d.RD(e.start.z);
          d.DD(e.end.z, e.start.z);
        }
        d.BT(e.thickness);
        d.BE(e.extrusion);
        break;
      }
      case 'POINT': {
        this.begin(T.POINT, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD3(e.position);
        d.BT(e.thickness);
        d.BE(e.extrusion);
        d.BD(e.angle || 0);
        break;
      }
      case 'CIRCLE': {
        this.begin(T.CIRCLE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD3(e.center);
        d.BD(e.radius);
        d.BT(e.thickness);
        d.BE(e.extrusion);
        break;
      }
      case 'ARC': {
        this.begin(T.ARC, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD3(e.center);
        d.BD(e.radius);
        d.BT(e.thickness);
        d.BE(e.extrusion);
        d.BD(e.startAngle);
        d.BD(e.endAngle);
        break;
      }
      case 'ELLIPSE': {
        this.begin(T.ELLIPSE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD3(e.center);
        d.BD3(e.majorAxis);
        d.BD3(e.extrusion ?? Z);
        d.BD(e.ratio);
        d.BD(e.startParam);
        d.BD(e.endParam);
        break;
      }
      case 'XLINE':
      case 'RAY': {
        this.begin(e.type === 'RAY' ? T.RAY : T.XLINE, h, e);
        this.common(e, l);
        this.ow.dat.BD3(e.base);
        this.ow.dat.BD3(e.direction);
        break;
      }
      case 'SOLID':
      case 'TRACE': {
        this.begin(e.type === 'SOLID' ? T.SOLID : T.TRACE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BT(e.thickness);
        d.BD(e.points[0].z);
        for (const p of e.points) d.RD2(p);
        d.BE(e.extrusion);
        break;
      }
      case '3DFACE': {
        this.begin(T['3DFACE'], h, e);
        this.common(e, l);
        const d = this.ow.dat;
        const [p1, p2, p3, p4] = e.points;
        const noFlags = !e.invisibleEdges;
        d.B(noFlags);
        d.B(p1.z === 0);
        d.RD(p1.x);
        d.RD(p1.y);
        if (p1.z !== 0) d.RD(p1.z);
        d.DD3(p2, p1);
        d.DD3(p3, p2);
        d.DD3(p4, p3);
        if (!noFlags) d.BS(e.invisibleEdges);
        break;
      }
      case 'SHAPE': {
        this.begin(T.SHAPE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD3(e.insert);
        d.BD(e.size);
        d.BD(e.rotation);
        d.BD(e.widthFactor);
        d.BD(e.oblique);
        d.BD(e.thickness ?? 0);
        d.BS(e.shapeNumber ?? 0);
        d.BD3(e.extrusion ?? Z);
        this.ow.hdl.H(HARD_PTR, this.ctx.ref(e.styleHandle) || this.shapeStyle(e.name));
        break;
      }
      case 'TEXT': {
        this.begin(T.TEXT, h, e);
        this.common(e, l);
        this.textData(e);
        this.ow.hdl.H(HARD_PTR, this.ctx.style(e.style));
        break;
      }
      case 'ATTRIB':
      case 'ATTDEF':
        this.attrib(e as AttribEntity, h, l);
        return;
      case 'MTEXT':
        this.begin(T.MTEXT, h, e);
        this.common(e, l);
        this.mtextBody(e, h);
        break;
      case 'INSERT':
        this.insert(e, pe, l);
        return;
      case 'POLYLINE':
        this.polyline(e, pe, l);
        return;
      case 'LWPOLYLINE': {
        this.begin(T.LWPOLYLINE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        const v = e.vertices;
        const hasBulge = v.some((x) => x.bulge !== 0);
        const hasWidth = v.some((x) => x.startWidth !== 0 || x.endWidth !== 0);
        let flag = 0;
        if (e.constantWidth) flag |= 4;
        if (e.elevation) flag |= 8;
        if (e.thickness) flag |= 2;
        if (!isZ(e.extrusion)) flag |= 1;
        if (hasBulge) flag |= 16;
        if (hasWidth) flag |= 32;
        if (e.closed) flag |= 512;
        if (e.plinegen) flag |= 256;
        d.BS(flag);
        if (flag & 4) d.BD(e.constantWidth);
        if (flag & 8) d.BD(e.elevation);
        if (flag & 2) d.BD(e.thickness!);
        if (flag & 1) d.BD3(e.extrusion!);
        d.BL(v.length);
        if (flag & 16) d.BL(v.length);
        if (flag & 32) d.BL(v.length);
        if (v.length) {
          d.RD(v[0].x);
          d.RD(v[0].y);
          for (let i = 1; i < v.length; i++) {
            d.DD(v[i].x, v[i - 1].x);
            d.DD(v[i].y, v[i - 1].y);
          }
        }
        if (flag & 16) for (const x of v) d.BD(x.bulge);
        if (flag & 32)
          for (const x of v) {
            d.BD(x.startWidth);
            d.BD(x.endWidth);
          }
        break;
      }
      case 'SPLINE':
        this.spline(e, h, l);
        break;
      case 'DIMENSION':
        this.dimension(e, h, l);
        break;
      case 'LEADER':
        this.leader(e, h, l);
        break;
      case 'TOLERANCE': {
        this.begin(T.TOLERANCE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD3(e.insert);
        d.BD3(e.direction);
        d.BD3(e.extrusion ?? Z);
        d.TV(e.text);
        this.ow.hdl.H(HARD_PTR, this.ctx.dimstyle(e.dimStyle));
        break;
      }
      case 'MLINE': {
        this.begin(T.MLINE, h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD(e.scale);
        d.RC(e.justification);
        d.BD3(e.startPoint);
        d.BD3(e.normal ?? Z);
        d.BS(e.flags);
        const lines = e.elementCount || (e.vertices[0]?.elements.length ?? 0);
        d.RC(lines);
        d.BS(e.vertices.length);
        for (const v of e.vertices) {
          d.BD3(v.position);
          d.BD3(v.direction);
          d.BD3(v.miter);
          for (let k = 0; k < lines; k++) {
            const el = v.elements[k] ?? { params: [], fillParams: [] };
            d.BS(el.params.length);
            for (const p of el.params) d.BD(p);
            d.BS(el.fillParams.length);
            for (const p of el.fillParams) d.BD(p);
          }
        }
        const sh = this.ctx.ref(e.styleHandle) || this.ctx.mlstyleH.get((e.styleName || 'Standard').toUpperCase()) || this.ctx.mlstyleH.get('STANDARD') || 0;
        this.ow.hdl.H(HARD_PTR, sh);
        break;
      }
      case 'HATCH':
      case 'MPOLYGON':
        this.hatch(e, h, l);
        break;
      case 'IMAGE':
      case 'WIPEOUT':
        this.image(e, h, l);
        break;
      case 'VIEWPORT':
        this.viewport(e, h, l);
        break;
      case 'PDFUNDERLAY':
      case 'DWFUNDERLAY':
      case 'DGNUNDERLAY': {
        this.begin(this.cls(e.type), h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BD3(e.extrusion ?? Z);
        d.BD3(e.insert);
        d.BD(e.rotation);
        d.BD3(e.scale);
        d.RC(e.flags);
        d.RC(e.contrast);
        d.RC(e.fade);
        d.BL(e.clipBoundary.length);
        for (const p of e.clipBoundary) d.RD2(p);
        this.ow.hdl.H(HARD_PTR, this.ctx.ref(e.definition));
        break;
      }
      case 'MESH': {
        this.begin(this.cls('MESH'), h, e);
        this.common(e, l);
        const d = this.ow.dat;
        d.BS(2);
        d.B(0);
        d.BL(e.subdivision);
        d.BL(e.vertices.length);
        for (const v of e.vertices) d.BD3(v);
        let nf = 0;
        for (const f of e.faces) nf += 1 + f.length;
        d.BL(nf);
        for (const f of e.faces) {
          d.BL(f.length);
          for (const i of f) d.BL(i);
        }
        d.BL(e.edges.length);
        for (const [a, b] of e.edges) {
          d.BL(a);
          d.BL(b);
        }
        // 주름 값: 모서리마다 0
        d.BL(e.edges.length);
        for (let i = 0; i < e.edges.length; i++) d.BD(0);
        d.BL(0); // 그 뒤 개수(AutoCAD 표본은 0)
        break;
      }
      case 'MULTILEADER':
        this.mleader(e, h, l);
        break;
      default:
        throw new Error(`쓸 수 없는 도형 ${e.type}`);
    }
    this.done(h);
  }

  /** 이름만 있는 SHAPE의 스타일(쉐이프 파일 항목 중 첫째) */
  private shapeStyle(_name: string): number {
    for (const s of this.ctx.styles) if (s.rec.flags & 1) return s.h;
    return 0;
  }

  // -------------------------------------------------------------------------
  // 문자
  // -------------------------------------------------------------------------

  private textData(e: TextEntity): void {
    const d = this.ow.dat;
    const elev = e.insert.z;
    let df = 0;
    if (elev === 0) df |= 1;
    if (!e.alignPoint) df |= 2;
    if (!e.oblique) df |= 4;
    if (!e.rotation) df |= 8;
    if (e.widthFactor === 1) df |= 0x10;
    if (!e.generation) df |= 0x20;
    if (!e.halign) df |= 0x40;
    if (!e.valign) df |= 0x80;
    d.RC(df);
    if (!(df & 1)) d.RD(elev);
    d.RD(e.insert.x);
    d.RD(e.insert.y);
    if (!(df & 2)) {
      d.DD(e.alignPoint!.x, e.insert.x);
      d.DD(e.alignPoint!.y, e.insert.y);
    }
    d.BE(e.extrusion);
    d.BT(e.thickness);
    if (!(df & 4)) d.RD(e.oblique);
    if (!(df & 8)) d.RD(e.rotation);
    d.RD(e.height);
    if (!(df & 0x10)) d.RD(e.widthFactor);
    d.TV(e.text ?? '');
    if (!(df & 0x20)) d.BS(e.generation);
    if (!(df & 0x40)) d.BS(e.halign);
    if (!(df & 0x80)) d.BS(e.valign);
  }

  private attrib(e: AttribEntity, h: number, l: Links): void {
    const ver = this.ver;
    const isDef = e.type === 'ATTDEF';
    this.begin(isDef ? T.ATTDEF : T.ATTRIB, h, e);
    this.common(e, l);
    this.textData(e as unknown as TextEntity);
    const d = this.ow.dat;
    // 문자 스타일 핸들이 끼워 넣은 MTEXT 핸들보다 앞이다
    this.ow.hdl.H(HARD_PTR, this.ctx.style(e.style));
    if (ver >= R2010) d.RC(0);
    const multi = ver >= R2018 && !!e.mtext;
    if (ver >= R2018) d.RC(multi ? (isDef ? 4 : 2) : 1);
    if (!multi) {
      d.TV(e.tag ?? '');
      d.BS(0);
      d.RC(e.attFlags ?? 0);
      if (ver >= R2007) d.B(!!e.lockPosition);
    } else {
      const m = e.mtext!;
      this.embeddedCommon(m);
      this.mtextBody(m, h);
      d.BS(0); // 주석 자료 없음
      d.TV(e.tag ?? '');
      d.BS(0);
      d.RC(e.attFlags ?? 0);
      d.B(!!e.lockPosition);
    }
    if (isDef) {
      if (ver >= R2010) d.RC(0);
      d.TV(e.prompt ?? '');
    }
    this.done(h);
  }

  /** 끼워 넣은 MTEXT 공통 자료(entmode부터, 반응자·확장 사전 없음) */
  private embeddedCommon(m: MTextEntity): void {
    const ctx = this.ctx;
    const ver = this.ver;
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    const [ltFlags, lt] = ctx.linetype(m.linetype);
    const col = wcolor(ctx, m.color, m.transparency);
    d.BB(2);
    d.BL(0);
    if (ver >= R2004) d.B(1);
    if (ver >= R2013) d.B(0);
    d.ENC(col);
    d.BD(Number.isFinite(m.ltscale) ? m.ltscale : 1);
    const mat = ver >= R2007 ? ctx.ref(m.material) : 0;
    const ps = ctx.ref(m.plotStyle);
    d.BB(ltFlags);
    if (ver >= R2007) d.BB(mat ? 3 : 0);
    d.BB(ps ? 3 : 0);
    if (ver >= R2007) d.RC(0);
    if (ver >= R2010) {
      d.B(0);
      d.B(0);
      d.B(0);
    }
    d.BS(m.invisible ? 1 : 0);
    d.RC(lwIndex(m.lineweight ?? -1));
    if (col.dbColor) hd.H(HARD_PTR, col.dbColor);
    hd.H(HARD_PTR, ctx.layer(m.layer));
    if (ltFlags === 3) hd.H(HARD_PTR, lt);
    if (mat) hd.H(HARD_PTR, mat);
    if (ps) hd.H(HARD_PTR, ps);
  }

  /** MTEXT 본문(삽입점부터) */
  private mtextBody(e: MTextEntity, h: number): void {
    const ver = this.ver;
    const d = this.ow.dat;
    const dir = e.direction ?? ocsDirection(e.rotation || 0, e.extrusion);
    d.BD3(e.insert);
    d.BD3(e.extrusion ?? Z);
    d.BD3(dir);
    d.BD(e.width);
    if (ver >= R2007) d.BD(e.rectHeight ?? 0);
    d.BD(e.height);
    d.BS(e.attachment || 1);
    d.BS(e.drawingDirection || 1);
    const box = this.leaderBox.get(h);
    const extH = box ? box.height : (e.rectHeight ?? e.height);
    const extW = box ? box.width : e.width;
    d.BD(extH);
    d.BD(extW);
    d.TV(e.text ?? '');
    this.ow.hdl.H(HARD_PTR, this.ctx.style(e.style));
    if (ver >= R2000) {
      d.BS(e.lineSpacingStyle || 1);
      d.BD(e.lineSpacingFactor || 1);
      d.B(0);
    }
    if (ver >= R2004) {
      let bg = e.backgroundFlags ?? 0;
      if (ver < R2018) bg &= ~0x10;
      d.BL(bg);
      if (bg & 1 || (ver >= R2018 && bg & 0x10)) {
        d.BD(e.backgroundScale ?? 1.5);
        d.CMC(wcolor(this.ctx, e.backgroundColor ?? { aci: 256 }, undefined, true));
        d.BL(0);
      }
    }
    if (ver >= R2018) {
      d.B(1); // 주석 축척 아님
      d.BS(0);
      d.B(1);
      this.ow.hdl.H(HARD_PTR, this.ctx.appid('ACAD'));
      d.BL(e.attachment || 1);
      d.BD3(dir);
      d.BD3(e.insert);
      d.BD(e.width);
      d.BD(e.rectHeight ?? 0);
      d.BD(extW);
      d.BD(extH);
      const col = e.columns;
      const ct = col ? col.type : 0;
      d.BS(ct);
      if (ct && col) {
        const heights = !col.autoHeight && ct === 2 ? col.heights : [];
        d.BL(ct === 2 && !col.autoHeight ? heights.length : col.count);
        d.BD(col.width);
        d.BD(col.gutter);
        d.B(col.autoHeight);
        d.B(col.flowReversed);
        for (const x of heights) d.BD(x);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 블록 참조·폴리선
  // -------------------------------------------------------------------------

  private insert(e: InsertEntity, pe: PEnt, l: Links): void {
    const ver = this.ver;
    const h = pe.h;
    const minsert = (e.columnCount ?? 1) > 1 || (e.rowCount ?? 1) > 1;
    const atts = pe.subs ?? [];
    this.begin(minsert ? T.MINSERT : T.INSERT, h, e);
    this.common(e, l);
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    d.BD3(e.insert);
    const s = e.scale ?? { x: 1, y: 1, z: 1 };
    if (s.x === 1 && s.y === 1 && s.z === 1) d.BB(3);
    else if (s.x === 1) {
      d.BB(1);
      d.DD(s.y, 1);
      d.DD(s.z, 1);
    } else if (s.y === s.x && s.z === s.x) {
      d.BB(2);
      d.RD(s.x);
    } else {
      d.BB(0);
      d.RD(s.x);
      d.DD(s.y, s.x);
      d.DD(s.z, s.x);
    }
    d.BD(e.rotation);
    d.BD3(e.extrusion ?? Z);
    d.B(atts.length > 0);
    if (ver >= R2004 && atts.length) d.BL(atts.length);
    if (minsert) {
      d.BS(e.columnCount);
      d.BS(e.rowCount);
      d.BD(e.columnSpacing);
      d.BD(e.rowSpacing);
    }
    const bh = this.ctx.block(e.block);
    if (!bh) this.ctx.warn('dwg.write_missing_block', '없는 블록을 가리키는 블록 참조가 있습니다.');
    hd.H(HARD_PTR, bh);
    if (atts.length) {
      if (ver < R2004) {
        hd.H(SOFT_PTR, atts[0]);
        hd.H(SOFT_PTR, atts[atts.length - 1]);
      } else for (const a of atts) hd.H(HARD_OWNER, a);
      hd.H(HARD_OWNER, pe.seqend!);
    }
    this.done(h);
    // 속성과 SEQEND
    for (let i = 0; i < atts.length; i++) {
      const a = e.attribs[i];
      const prev = ver < R2004 && i > 0 ? atts[i - 1] : 0;
      const next = ver < R2004 ? (i + 1 < atts.length ? atts[i + 1] : pe.seqend!) : 0;
      this.attrib({ ...a, type: 'ATTRIB' }, atts[i], { owner: h, mode: 0, prev, next });
    }
    if (atts.length) this.seqend(e, pe.seqend!, h, ver < R2004 ? atts[atts.length - 1] : 0);
  }

  private seqend(parent: Entity, h: number, owner: number, prev: number): void {
    this.ow.begin(T.SEQEND, h, null);
    this.common({ ...parent, xdata: undefined, xdict: undefined, reactors: undefined } as Entity, { owner, mode: 0, prev, next: 0 });
    this.done(h);
  }

  private polyline(e: PolylineEntity, pe: PEnt, l: Links): void {
    const ver = this.ver;
    const h = pe.h;
    const vs = pe.subs ?? [];
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    let type: number = T.POLYLINE_2D;
    if (e.kind === '3d') type = T.POLYLINE_3D;
    else if (e.kind === 'polyface') type = T.POLYLINE_PFACE;
    else if (e.kind === 'mesh') type = T.POLYLINE_MESH;
    this.begin(type, h, e);
    this.common(e, l);
    if (e.kind === '2d') {
      d.BS(e.flags & 0xffff);
      d.BS(e.smoothType);
      d.BD(e.defaultStartWidth);
      d.BD(e.defaultEndWidth);
      d.BT(e.thickness);
      d.BD(e.elevation);
      d.BE(e.extrusion);
    } else if (e.kind === '3d') {
      const f75 = e.smoothType === 5 ? 1 : e.smoothType === 6 ? 2 : 0;
      d.RC(f75);
      d.RC(e.flags & 1);
    } else if (e.kind === 'polyface') {
      let nv = 0;
      let nf = 0;
      for (const v of e.vertices) {
        if (v.faceIndices) nf++;
        else nv++;
      }
      d.BS(e.mCount || nv);
      d.BS(e.nCount || nf);
    } else {
      d.BS(e.flags & ~16 & 0xffff);
      d.BS(e.smoothType);
      d.BS(e.mCount);
      d.BS(e.nCount);
      d.BS(e.mDensity);
      d.BS(e.nDensity);
    }
    if (ver >= R2004) d.BL(vs.length);
    if (ver < R2004) {
      hd.H(SOFT_PTR, vs[0] ?? 0);
      hd.H(SOFT_PTR, vs[vs.length - 1] ?? 0);
    } else for (const v of vs) hd.H(HARD_OWNER, v);
    hd.H(HARD_OWNER, pe.seqend!);
    this.done(h);
    for (let i = 0; i < vs.length; i++) {
      const prev = ver < R2004 && i > 0 ? vs[i - 1] : 0;
      const next = ver < R2004 ? (i + 1 < vs.length ? vs[i + 1] : pe.seqend!) : 0;
      this.vertex(e, e.vertices[i], vs[i], { owner: h, mode: 0, prev, next });
    }
    this.seqend(e, pe.seqend!, h, ver < R2004 ? (vs[vs.length - 1] ?? 0) : 0);
  }

  private vertex(p: PolylineEntity, v: PolyVertex, h: number, l: Links): void {
    const d = this.ow.dat;
    const base = { ...p, xdata: undefined, xdict: undefined, reactors: undefined } as Entity;
    if (p.kind === '2d') {
      this.ow.begin(T.VERTEX_2D, h, null);
      this.common(base, l);
      d.RC(v.flags & 0xff);
      d.BD3(v.location);
      if (v.startWidth === v.endWidth && v.startWidth !== 0) d.BD(-v.startWidth);
      else {
        d.BD(v.startWidth);
        d.BD(v.endWidth);
      }
      d.BD(v.bulge);
      if (this.ver >= R2010) d.BL(0);
      d.BD(v.tangent ?? 0);
    } else if (p.kind === 'polyface' && v.faceIndices) {
      this.ow.begin(T.VERTEX_PFACE_FACE, h, null);
      this.common(base, l);
      for (let i = 0; i < 4; i++) d.BS(v.faceIndices[i] ?? 0);
    } else {
      this.ow.begin(p.kind === '3d' ? T.VERTEX_3D : p.kind === 'mesh' ? T.VERTEX_MESH : T.VERTEX_PFACE, h, null);
      this.common(base, l);
      d.RC(v.flags & 0xff);
      d.BD3(v.location);
    }
    this.done(h);
  }

  // -------------------------------------------------------------------------
  // 스플라인·치수·지시선
  // -------------------------------------------------------------------------

  private spline(e: SplineEntity, h: number, l: Links): void {
    const ver = this.ver;
    const helix = !!e.helix;
    this.begin(helix ? this.cls('HELIX') : T.SPLINE, h, e);
    this.common(e, l);
    const d = this.ow.dat;
    const scenario = e.controlPoints.length ? 1 : 2;
    if (ver >= R2013) {
      // R2013+: 첫 값은 늘 1이고 맞춤점 방식은 플래그 비트 1이 정한다(AutoCAD 표본)
      d.BL(1);
      let f1 = e.flags >= 128 ? e.flags >> 7 : e.flags & 1 ? 4 : 0;
      // 맞춤점 방식은 비트 1, AutoCAD는 매듭 매개변수 사용(8)도 함께 둔다
      if (scenario === 2) f1 |= e.flags >= 128 ? 1 : 9;
      else f1 &= ~1;
      d.BL(f1);
      d.BL(scenario === 1 ? 15 : 2);
    } else d.BL(scenario);
    d.BL(e.degree);
    if (scenario === 2) {
      d.BD(e.fitTolerance);
      d.BD3(e.startTangent ?? ORIGIN);
      d.BD3(e.endTangent ?? ORIGIN);
      d.BL(e.fitPoints.length);
      for (const p of e.fitPoints) d.BD3(p);
    } else {
      const weighted = !!e.weights && e.weights.length === e.controlPoints.length && e.weights.some((w) => w !== 1);
      d.B((e.flags & 4) !== 0 || weighted);
      d.B((e.flags & 1) !== 0);
      d.B((e.flags & 2) !== 0);
      d.BD(e.knotTolerance);
      d.BD(e.controlTolerance);
      d.BL(e.knots.length);
      d.BL(e.controlPoints.length);
      d.B(weighted);
      for (const k of e.knots) d.BD(k);
      e.controlPoints.forEach((p, i) => {
        d.BD3(p);
        if (weighted) d.BD(e.weights![i]);
      });
    }
    if (helix) {
      const x = e.helix!;
      d.BS(29);
      d.BS(0);
      d.BD3(x.axisBase);
      d.BD3(x.start);
      d.BD3(x.axis);
      d.BD(x.radius);
      d.BD(x.turns);
      d.BD(x.turnHeight);
      d.B(x.ccw);
      d.RC(x.constrain);
    }
  }

  private dimension(e: DimensionEntity, h: number, l: Links): void {
    const ver = this.ver;
    const dt = e.dimType;
    let type: number;
    if (e.subtype === 'ARC_DIMENSION') type = this.cls('ARC_DIMENSION');
    else if (e.subtype === 'LARGE_RADIAL_DIMENSION') type = this.cls('LARGE_RADIAL_DIMENSION');
    else {
      switch (dt & 7) {
        case 1:
          type = T.DIMENSION_ALIGNED;
          break;
        case 2:
          type = T.DIMENSION_ANG2LN;
          break;
        case 3:
          type = T.DIMENSION_DIAMETER;
          break;
        case 4:
          type = T.DIMENSION_RADIUS;
          break;
        case 5:
          type = T.DIMENSION_ANG3PT;
          break;
        case 6:
          type = T.DIMENSION_ORDINATE;
          break;
        default:
          type = T.DIMENSION_LINEAR;
          break;
      }
    }
    this.begin(type, h, e);
    this.common(e, l);
    const d = this.ow.dat;
    if (ver >= R2010) d.RC(0);
    d.BD3(e.extrusion ?? Z);
    d.RD(e.textMid.x);
    d.RD(e.textMid.y);
    d.BD(e.textMid.z);
    d.RC((dt & 128 ? 0 : 1) | (dt & 32 ? 2 : 0));
    d.TV(e.text ?? '');
    d.BD(e.textRotation);
    d.BD(e.horizontalDirection);
    d.BD3({ x: 1, y: 1, z: 1 });
    d.BD(0);
    if (ver >= R2000) {
      d.BS(e.attachment || 5);
      d.BS(e.lineSpacingStyle || 1);
      d.BD(e.lineSpacingFactor || 1);
      d.BD(e.measurement);
    }
    if (ver >= R2007) {
      d.B(0);
      d.B(0);
      d.B(0);
    }
    d.RD(e.insertPoint?.x ?? 0);
    d.RD(e.insertPoint?.y ?? 0);
    if (e.subtype === 'ARC_DIMENSION') {
      const a = e.arc;
      d.BD3(e.defPoint);
      d.BD3(e.defPoint2);
      d.BD3(e.defPoint3);
      d.BD3(a?.center ?? e.defPoint4);
      d.B(!!a?.partial);
      d.BD(a?.startAngle ?? 0);
      d.BD(a?.endAngle ?? 0);
      d.B(!!a?.leader1);
      d.BD3(a?.leader1 ?? ORIGIN);
      d.BD3(a?.leader2 ?? ORIGIN);
    } else if (e.subtype === 'LARGE_RADIAL_DIMENSION') {
      d.BD3(e.defPoint);
      d.BD3(e.defPoint4);
      d.BD(e.leaderLength);
      d.BD3(e.defPoint2);
      d.BD3(e.defPoint3);
    } else {
      switch (type) {
        case T.DIMENSION_ORDINATE:
          d.BD3(e.defPoint);
          d.BD3(e.defPoint2);
          d.BD3(e.defPoint3);
          d.RC(dt & 64 ? 1 : 0);
          break;
        case T.DIMENSION_LINEAR:
          d.BD3(e.defPoint2);
          d.BD3(e.defPoint3);
          d.BD3(e.defPoint);
          d.BD(e.obliqueAngle);
          d.BD(e.rotation);
          break;
        case T.DIMENSION_ALIGNED:
          d.BD3(e.defPoint2);
          d.BD3(e.defPoint3);
          d.BD3(e.defPoint);
          d.BD(e.obliqueAngle);
          break;
        case T.DIMENSION_ANG3PT:
          d.BD3(e.defPoint);
          d.BD3(e.defPoint2);
          d.BD3(e.defPoint3);
          d.BD3(e.defPoint4);
          break;
        case T.DIMENSION_ANG2LN:
          d.RD(e.defPoint5.x);
          d.RD(e.defPoint5.y);
          d.BD3(e.defPoint2);
          d.BD3(e.defPoint3);
          d.BD3(e.defPoint4);
          d.BD3(e.defPoint);
          break;
        case T.DIMENSION_RADIUS:
          d.BD3(e.defPoint);
          d.BD3(e.defPoint4);
          d.BD(e.leaderLength);
          break;
        case T.DIMENSION_DIAMETER:
          d.BD3(e.defPoint4);
          d.BD3(e.defPoint);
          d.BD(e.leaderLength);
          break;
      }
    }
    this.ow.hdl.H(HARD_PTR, this.ctx.dimstyle(e.dimStyle));
    this.ow.hdl.H(HARD_PTR, this.ctx.block(e.block));
  }

  private leader(e: LeaderEntity, h: number, l: Links): void {
    const ver = this.ver;
    this.begin(T.LEADER, h, e);
    this.common(e, l);
    const d = this.ow.dat;
    // 읽기가 덧붙인 걸이선 점(마지막 점 바로 앞)을 뺀다
    let verts = e.vertices;
    if (e.hookline && verts.length >= 3) verts = [...verts.slice(0, verts.length - 2), verts[verts.length - 1]];
    d.B(0);
    d.BS(e.creation);
    d.BS(e.pathType);
    d.BL(verts.length);
    for (const v of verts) d.BD3(v);
    d.BD3(verts[0] ?? ORIGIN);
    d.BD3(e.normal ?? e.extrusion ?? Z);
    d.BD3(e.horizontalDirection ?? { x: 1, y: 0, z: 0 });
    d.BD3(e.blockOffset ?? ORIGIN);
    d.BD3(e.annotationOffset ?? ORIGIN);
    if (ver < R2010) {
      d.BD(e.textHeight);
      d.BD(e.textWidth);
    }
    d.B(!!e.hooklineDirection);
    d.B(e.arrowHead);
    d.BS(0);
    d.B(0);
    d.B(0);
    this.ow.hdl.H(HARD_PTR, this.ctx.ref(e.annotation));
    this.ow.hdl.H(HARD_PTR, this.ctx.dimstyle(e.dimStyle));
  }

  // -------------------------------------------------------------------------
  // 해치
  // -------------------------------------------------------------------------

  private hatch(e: HatchEntity, h: number, l: Links): void {
    const ver = this.ver;
    this.begin(T.HATCH, h, e);
    this.common(e, l);
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    if (ver >= R2004) {
      const g = e.gradient;
      if (g && g.enabled) {
        d.BL(1);
        d.BL(0);
        d.BD(g.angle);
        d.BD(g.shift);
        d.BL(g.singleColor ? 1 : 0);
        d.BD(g.tint);
        const cols = [g.color1, g.color2];
        d.BL(cols.length);
        cols.forEach((c, i) => {
          d.BD(i);
          d.BS(c.aci > 0 && c.aci < 256 ? c.aci : 0);
          d.BL(rawCmc(c) | 0);
          d.RC(0);
        });
        d.TV(g.name);
      } else {
        d.BL(0);
        d.BL(0);
        d.BD(0);
        d.BD(0);
        d.BL(0);
        d.BD(0);
        d.BL(0);
        d.TV('');
      }
    }
    d.BD(e.elevation);
    d.BD3(e.extrusion ?? Z);
    d.TV(e.patternName ?? '');
    d.B(e.solid);
    d.B(e.associative);
    d.BL(e.paths.length);
    let anyDerived = false;
    const srcs: number[][] = [];
    for (const p of e.paths) {
      let flags = p.flags;
      if (p.polyline) flags |= 2;
      else flags &= ~2;
      if (flags & 4) anyDerived = true;
      d.BL(flags);
      if (!(flags & 2)) {
        const edges = p.edges ?? [];
        d.BL(edges.length);
        for (const ed of edges) {
          if (ed.type === 'line') {
            d.RC(1);
            d.RD2(ed.start);
            d.RD2(ed.end);
          } else if (ed.type === 'arc') {
            d.RC(2);
            d.RD2(ed.center);
            d.BD(ed.radius);
            const [s, en] = fileAngles(ed.startAngle, ed.endAngle, ed.ccw);
            d.BD(s);
            d.BD(en);
            d.B(ed.ccw);
          } else if (ed.type === 'ellipse') {
            d.RC(3);
            d.RD2(ed.center);
            d.RD2(ed.majorAxis);
            d.BD(ed.ratio);
            const [s, en] = fileAngles(ed.startAngle, ed.endAngle, ed.ccw);
            d.BD(s);
            d.BD(en);
            d.B(ed.ccw);
          } else {
            d.RC(4);
            d.BL(ed.degree);
            const rational = ed.rational || !!ed.weights;
            d.B(rational);
            d.B(ed.periodic);
            d.BL(ed.knots.length);
            d.BL(ed.controlPoints.length);
            for (const k of ed.knots) d.BD(k);
            ed.controlPoints.forEach((c, i) => {
              d.RD2(c);
              if (rational) d.BD(ed.weights?.[i] ?? 1);
            });
            if (ver >= R2010) {
              const fit = ed.fitPoints ?? [];
              d.BL(fit.length);
              if (fit.length) {
                for (const f of fit) d.RD2(f);
                d.RD2(ed.startTangent ?? { x: 0, y: 0 });
                d.RD2(ed.endTangent ?? { x: 0, y: 0 });
              }
            }
          }
        }
      } else {
        const pl = p.polyline!;
        const bulges = pl.vertices.some((v) => v.bulge !== 0);
        d.B(bulges);
        d.B(pl.closed);
        d.BL(pl.vertices.length);
        for (const v of pl.vertices) {
          d.RD(v.x);
          d.RD(v.y);
          if (bulges) d.BD(v.bulge);
        }
      }
      const s = this.ctx.refs(p.sources);
      srcs.push(s);
      d.BL(s.length);
    }
    d.BS(e.hatchStyle);
    d.BS(e.patternType);
    if (!e.solid) {
      d.BD(e.patternAngle);
      d.BD(e.patternScale);
      d.B(e.patternDouble);
      d.BS(e.patternLines.length);
      for (const pl of e.patternLines) {
        d.BD(pl.angle);
        d.BD2(pl.base);
        d.BD2(pl.offset);
        d.BS(pl.dashes.length);
        for (const x of pl.dashes) d.BD(x);
      }
    }
    if (anyDerived) d.BD(e.pixelSize);
    d.BL(e.seedPoints.length);
    for (const p of e.seedPoints) d.RD2(p);
    for (const s of srcs) for (const x of s) hd.H(SOFT_PTR, x);
  }

  // -------------------------------------------------------------------------
  // 이미지·뷰포트
  // -------------------------------------------------------------------------

  private image(e: ImageEntity, h: number, l: Links): void {
    const ver = this.ver;
    this.begin(this.cls(e.type), h, e);
    this.common(e, l);
    const d = this.ow.dat;
    d.BL(0);
    d.BD3(e.insert);
    d.BD3(e.uVector);
    d.BD3(e.vVector);
    d.RD2(e.imageSize);
    d.BS(e.displayFlags);
    d.B(e.clipping);
    d.RC(e.brightness);
    d.RC(e.contrast);
    d.RC(e.fade);
    if (ver >= R2010) d.B(!!e.clipInverted);
    let pts: Vec2[] = e.clipBoundary ?? [];
    let bt = e.clipBoundaryType || (pts.length > 2 ? 2 : 1);
    if (bt === 1 && pts.length !== 2) bt = 2;
    d.BS(bt);
    if (bt === 1) {
      d.RD2(pts[0]);
      d.RD2(pts[1]);
    } else {
      // 읽기가 닫는 점을 덧붙였다
      if (pts.length > 3) {
        const f = pts[0];
        const t = pts[pts.length - 1];
        if (f.x === t.x && f.y === t.y) pts = pts.slice(0, -1);
      }
      d.BL(pts.length);
      for (const p of pts) d.RD2(p);
    }
    this.ow.hdl.H(HARD_PTR, this.ctx.ref(e.imageDef));
    this.ow.hdl.H(HARD_OWNER, this.ctx.ref(e.imageDefReactor));
  }

  private viewport(e: ViewportEntity, h: number, l: Links): void {
    const ver = this.ver;
    const ctx = this.ctx;
    this.begin(T.VIEWPORT, h, e);
    this.common(e, l);
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    d.BD3(e.center);
    d.BD(e.width);
    d.BD(e.height);
    d.BD3(e.viewTarget);
    d.BD3(e.viewDirection);
    d.BD(e.twistAngle);
    d.BD(e.viewHeight);
    d.BD(e.lensLength);
    d.BD(e.frontClip);
    d.BD(e.backClip);
    d.BD(e.snapAngle);
    d.RD2(e.viewCenter);
    d.RD2(e.snapBase);
    d.RD2(e.snapSpacing);
    d.RD2(e.gridSpacing);
    d.BS(e.circleSides);
    if (ver >= R2007) d.BS(5);
    const frozen: number[] = [];
    for (const n of e.frozenLayers) {
      const lh = ctx.layerH.get(n.toUpperCase());
      if (lh) frozen.push(lh);
    }
    d.BL(frozen.length);
    d.BL(e.flags);
    d.TV(e.styleSheet ?? '');
    d.RC(e.renderMode);
    d.B(0);
    d.B(e.ucsPerViewport);
    d.BD3(e.ucsOrigin ?? ORIGIN);
    d.BD3(e.ucsXAxis ?? { x: 1, y: 0, z: 0 });
    d.BD3(e.ucsYAxis ?? { x: 0, y: 1, z: 0 });
    d.BD(0);
    d.BS(0);
    if (ver >= R2004) d.BS(0);
    if (ver >= R2007) {
      d.B(1);
      d.RC(1);
      d.BD(0);
      d.BD(0);
      d.CMC({ index: 0, rgb: 0x333333 });
    }
    for (const f of frozen) hd.H(ver >= R2004 ? SOFT_PTR : HARD_PTR, f);
    hd.H(SOFT_PTR, ctx.ref(e.clipBoundary));
    if (ver === R2000) hd.H(HARD_PTR, 0);
    hd.H(HARD_PTR, 0);
    hd.H(HARD_PTR, 0);
    if (ver >= R2007) {
      hd.H(SOFT_PTR, 0);
      hd.H(HARD_PTR, 0);
      hd.H(SOFT_PTR, 0);
      hd.H(HARD_OWNER, 0);
    }
  }

  // -------------------------------------------------------------------------
  // 다중 지시선
  // -------------------------------------------------------------------------

  private mleader(e: MLeaderEntity, h: number, l: Links): void {
    const ver = this.ver;
    const ctx = this.ctx;
    this.begin(this.cls('MULTILEADER'), h, e);
    this.common(e, l);
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    const c = e.context;
    const p = e.props ?? {};
    const cp = c.props ?? {};
    if (ver >= R2010) d.BS(p[270] ?? 2);
    d.BL(c.leaders.length);
    for (const r of c.leaders) {
      d.B(r.hasLastPoint);
      d.B(r.hasDogleg);
      d.BD3(r.lastLeaderPoint ?? ORIGIN);
      d.BD3(r.doglegVector ?? { x: 1, y: 0, z: 0 });
      d.BL(0);
      d.BL(r.index);
      d.BD(r.doglegLength);
      d.BL(r.lines.length);
      for (const line of r.lines) {
        d.BL(line.vertices.length);
        for (const v of line.vertices) d.BD3(v);
        const br = line.breaks ?? [];
        d.BL(br.length ? 1 : 0);
        if (br.length) {
          d.BL(0);
          d.BL(br.length);
          for (const b of br) {
            d.BD3(b.start);
            d.BD3(b.end);
          }
        }
        d.BL(line.index);
        if (ver >= R2010) {
          // 선마다의 재지정 값(재지정 플래그 0이면 쓰이지 않는다)
          d.BS(e.leaderLineType);
          d.CMC(wcolor(ctx, line.color ?? { aci: 0 }, undefined, true));
          hd.H(HARD_PTR, 0);
          d.BL(e.leaderLineWeight);
          d.BD(0);
          hd.H(HARD_PTR, 0);
          d.BL(0);
        }
      }
      if (ver >= R2010) d.BS(r.attachmentDirection);
    }
    d.BD(c.scale);
    d.BD3(c.contentBase);
    d.BD(c.textHeight);
    d.BD(c.arrowSize);
    d.BD(c.landingGap);
    d.BS(cp[174] ?? 1);
    d.BS(cp[175] ?? 1);
    const t = c.text;
    d.BS(cp[176] ?? (t ? Math.max(0, (t.attachment || 1) - 1) : 0));
    d.BS(cp[177] ?? 0);
    d.B(!!t);
    if (t) {
      const tp = t.props ?? {};
      d.TV(t.text ?? '');
      d.BD3(t.normal ?? Z);
      hd.H(HARD_PTR, ctx.ref(t.styleHandle) || ctx.style('Standard'));
      d.BD3(t.location);
      d.BD3(t.direction ?? { x: 1, y: 0, z: 0 });
      d.BD(t.rotation);
      d.BD(t.width);
      d.BD(t.height);
      d.BD(t.lineSpacingFactor || 1);
      d.BS(t.lineSpacingStyle || 1);
      d.CMC(wcolor(ctx, t.color, undefined, true));
      d.BS(t.attachment || 1);
      d.BS(t.flowDirection || 1);
      d.CMC(wcolor(ctx, t.backgroundColor ?? { aci: 7 }, undefined, true));
      d.BD(t.backgroundScale ?? 1.5);
      d.BL(tp[92] ?? 0);
      d.B(!!tp[291]);
      d.B(t.backgroundFill);
      d.BS(tp[173] ?? 0);
      d.B(!!tp[293]);
      d.BD(tp[142] ?? 0);
      d.BD(tp[143] ?? 0);
      d.B(!!tp[294]);
      d.BL(0);
      d.B(!!tp[295]);
      d.B(0);
    } else {
      const b = c.block;
      d.B(!!b);
      if (b) {
        hd.H(SOFT_PTR, ctx.ref(b.blockHandle));
        d.BD3(b.normal ?? Z);
        d.BD3(b.location);
        d.BD3(b.scale);
        d.BD(b.rotation);
        d.CMC(wcolor(ctx, b.color, undefined, true));
        const m = b.matrix && b.matrix.length === 16 ? b.matrix : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        for (const x of m) d.BD(x);
      }
    }
    d.BD3(c.basePoint);
    d.BD3(c.baseDirection);
    d.BD3(c.baseVertical);
    d.B(!!cp[297]);
    if (ver >= R2010) {
      d.BS(cp[273] ?? 9);
      d.BS(cp[272] ?? 9);
    }
    // 본체
    hd.H(HARD_PTR, ctx.ref(e.styleHandle));
    d.BL(p[90] ?? 0);
    d.BS(e.leaderLineType);
    d.CMC(wcolor(ctx, e.leaderLineColor, undefined, true));
    hd.H(HARD_PTR, ctx.ref(e.leaderLineTypeHandle));
    d.BL(e.leaderLineWeight);
    d.B(e.landing);
    d.B(e.dogleg);
    d.BD(e.doglegLength);
    hd.H(HARD_PTR, ctx.ref(e.arrowHeadHandle));
    d.BD(e.arrowSize);
    d.BS(e.contentType);
    hd.H(HARD_PTR, ctx.ref(e.textStyleHandle));
    d.BS(p[173] ?? 1);
    d.BS(p[95] ?? 1);
    d.BS(p[174] ?? 1);
    d.BS(p[175] ?? 0);
    d.CMC(wcolor(ctx, e.textColor, undefined, true));
    d.B(e.textFrame);
    hd.H(HARD_PTR, ctx.ref(e.blockHandle));
    d.CMC(wcolor(ctx, e.blockColor, undefined, true));
    d.BD3(e.blockScale);
    d.BD(e.blockRotation);
    d.BS(e.blockConnection);
    d.B(!!p[293]);
    if (ver <= R2007) d.BL(0);
    const labs = e.blockAttributes ?? [];
    d.BL(labs.length);
    for (const a of labs) {
      hd.H(SOFT_PTR, ctx.ref(a.attdefHandle));
      d.TV(a.text);
      d.BS(a.index);
      d.BD(a.width);
    }
    d.B(!!p[294]);
    d.BS(p[178] ?? 0);
    d.BS(p[179] ?? 1);
    d.BD(e.scale);
    if (ver >= R2010) {
      d.BS(p[271] ?? 0);
      d.BS(p[273] ?? 9);
      d.BS(p[272] ?? 9);
    }
    if (ver >= R2013) d.B(!!p[295]);
  }
}

/** 해치 호·타원 각도: 모델(반시계 순서) → 파일 */
function fileAngles(start: number, end: number, ccw: boolean): [number, number] {
  if (ccw) return [start, end];
  return [PI2 - end, PI2 - start];
}

/** 색 → CMC RGB 칸 값 */
function rawCmc(c: CadColor): number {
  if (c.rgb !== undefined) return (0xc2000000 | (c.rgb & 0xffffff)) >>> 0;
  if (c.aci === 256) return 0xc0000000;
  if (c.aci === 0) return 0xc1000000;
  return (0xc3000000 | (c.aci & 0xff)) >>> 0;
}

