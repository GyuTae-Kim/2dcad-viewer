/** 표 제어 객체와 표 레코드 쓰기(사양 20.4.51~20.4.70, objects/tables.ts의 짝) */
import type { DimStyle, Layer, Linetype, TableRecordBase, TextStyle, UcsRecord, ViewRecord, VPortRecord, XData } from '../../../core/model';
import { DIM_VAR_DEFAULTS } from '../../../core/dimvars';
import { R2000, R2004, R2007, R2010 } from '../version';
import type { PBlock, PRec, TableName, WCtx } from './context';
import { eedOf, wcolor } from './common';
import { HARD_OWNER, HARD_PTR, SOFT_OWNER, SOFT_PTR, type ObjWriter } from './objwriter';
import { lwIndex } from './util';

const TYPE: Record<string, number> = {
  BLOCK_CONTROL: 48,
  BLOCK_HEADER: 49,
  LAYER_CONTROL: 50,
  LAYER: 51,
  STYLE_CONTROL: 52,
  STYLE: 53,
  LTYPE_CONTROL: 56,
  LTYPE: 57,
  VIEW_CONTROL: 60,
  VIEW: 61,
  UCS_CONTROL: 62,
  UCS: 63,
  VPORT_CONTROL: 64,
  VPORT: 65,
  APPID_CONTROL: 66,
  APPID: 67,
  DIMSTYLE_CONTROL: 68,
  DIMSTYLE: 69,
  VPENT_CONTROL: 70,
};

const CONTROL_OF: Record<TableName, string> = {
  BLOCK_RECORD: 'BLOCK_CONTROL',
  LAYER: 'LAYER_CONTROL',
  STYLE: 'STYLE_CONTROL',
  LTYPE: 'LTYPE_CONTROL',
  VIEW: 'VIEW_CONTROL',
  UCS: 'UCS_CONTROL',
  VPORT: 'VPORT_CONTROL',
  APPID: 'APPID_CONTROL',
  DIMSTYLE: 'DIMSTYLE_CONTROL',
  VPENT: 'VPENT_CONTROL',
};

type Put = (h: number, b: Uint8Array) => void;

export class TableWriter {
  readonly ctx: WCtx;
  readonly ow: ObjWriter;
  readonly put: Put;
  readonly ver: number;

  constructor(ctx: WCtx, ow: ObjWriter, put: Put) {
    this.ctx = ctx;
    this.ow = ow;
    this.put = put;
    this.ver = ctx.ver;
  }

  writeAll(): void {
    const ctx = this.ctx;
    const heads = ctx.doc.tableHeads;
    const ctl = (t: TableName, entries: number[], extra: number[] = []) => {
      const h = ctx.ctrl.get(t)!;
      const head = heads?.get(t);
      this.ow.begin(TYPE[CONTROL_OF[t]], h, eedOf(ctx, head?.xdata));
      this.ow.commonObject({ owner: 0, reactors: ctx.refs(head?.reactors), xdict: ctx.ref(head?.xdict) });
      this.ow.dat.BL(entries.length);
      // DIMSTYLE_CONTROL은 R2000+에서 추가 핸들 수(RC)가 더 있다(AutoCAD 표본)
      if (t === 'DIMSTYLE' && this.ver >= R2000) this.ow.dat.RC(0);
      for (const x of entries) this.ow.hdl.H(SOFT_OWNER, x);
      for (const x of extra) this.ow.hdl.H(HARD_OWNER, x);
      this.put(h, this.ow.finish());
    };
    const hs = <T>(l: PRec<T>[]) => l.map((r) => r.h);
    ctl('LTYPE', hs(ctx.ltypes), [ctx.ltByLayer, ctx.ltByBlock]);
    ctl('LAYER', hs(ctx.layers));
    ctl('STYLE', hs(ctx.styles));
    ctl('VIEW', hs(ctx.views));
    ctl('UCS', hs(ctx.ucss));
    ctl('VPORT', hs(ctx.vports));
    ctl('APPID', hs(ctx.appids));
    ctl('DIMSTYLE', hs(ctx.dimstyles));
    if (ctx.ctrl.has('VPENT')) ctl('VPENT', []);
    const blocks = ctx.blocks.filter((b) => b !== ctx.modelBlock && b !== ctx.paperBlock).map((b) => b.recH);
    ctl('BLOCK_RECORD', blocks, [ctx.modelBlock.recH, ctx.paperBlock.recH]);

    const byName = (n: string): Linetype | undefined => {
      for (const lt of ctx.doc.linetypes.values()) if (lt.name.toUpperCase() === n) return lt;
      return undefined;
    };
    this.ltype({ rec: byName('BYLAYER') ?? { name: 'ByLayer', handle: '', flags: 0, description: '', patternLength: 0, elements: [] }, h: ctx.ltByLayer });
    this.ltype({ rec: byName('BYBLOCK') ?? { name: 'ByBlock', handle: '', flags: 0, description: '', patternLength: 0, elements: [] }, h: ctx.ltByBlock });
    for (const r of ctx.ltypes) this.safe('LTYPE', r, () => this.ltype(r));
    for (const r of ctx.layers) this.safe('LAYER', r, () => this.layer(r));
    for (const r of ctx.styles) this.safe('STYLE', r, () => this.style(r));
    for (const r of ctx.dimstyles) this.safe('DIMSTYLE', r, () => this.dimstyle(r));
    for (const r of ctx.appids) this.safe('APPID', r, () => this.appid(r));
    for (const r of ctx.vports) this.safe('VPORT', r, () => this.vport(r));
    for (const r of ctx.views) this.safe('VIEW', r, () => this.view(r));
    for (const r of ctx.ucss) this.safe('UCS', r, () => this.ucs(r));
  }

  private safe<T extends TableRecordBase>(t: string, r: PRec<T>, f: () => void): void {
    try {
      f();
    } catch (err) {
      this.ctx.warn('dwg.write_record_failed', '표 항목을 쓰지 못해 뺐습니다.', { table: t, name: r.rec.name, error: String(err) });
    }
  }

  /** 표 레코드 머리: 이름, 64 플래그, (R2007 이전) 외부 참조 번호, 외부 의존 */
  private head(type: string, r: PRec<TableRecordBase>, table: TableName, xdata?: XData[]): void {
    const ctx = this.ctx;
    this.ow.begin(TYPE[type], r.h, eedOf(ctx, xdata ?? r.rec.xdata));
    this.ow.commonObject({ owner: ctx.ctrl.get(table)!, reactors: [], xdict: ctx.ref(r.rec.xdict) });
    const d = this.ow.dat;
    d.TV(r.rec.name ?? '');
    // 64(참조됨) 비트: AutoCAD는 늘 1을 쓴다. R2007+에서 0이면 다른 리더가 외부 참조 번호를 더 읽는다
    d.B(1);
    if (this.ver < R2007) d.BS(0);
    d.B((r.rec.flags & 16) !== 0);
  }

  private finish(h: number): void {
    this.put(h, this.ow.finish());
  }

  private ltype(r: PRec<Linetype>): void {
    const ver = this.ver;
    // ByLayer·ByBlock·Continuous는 R2000+ 표기로(R14·R12에서 온 문서는 대문자다)
    const canon: Record<string, string> = { BYLAYER: 'ByLayer', BYBLOCK: 'ByBlock', CONTINUOUS: 'Continuous' };
    const cn = canon[(r.rec.name ?? '').toUpperCase()];
    const lt = cn && cn !== r.rec.name ? { ...r.rec, name: cn } : r.rec;
    r = { rec: lt, h: r.h };
    this.head('LTYPE', r, 'LTYPE');
    const d = this.ow.dat;
    const els = lt.elements ?? [];
    d.TV(lt.description ?? '');
    d.BD(lt.patternLength || els.reduce((a, e) => a + Math.abs(e.length), 0));
    d.RC(0x41);
    d.RC(els.length);
    // 문자열 영역: 문자 요소의 글자를 차례로 넣는다
    const unicode = ver >= R2007;
    const areaSize = unicode ? 512 : 256;
    const area = new Uint8Array(areaSize);
    let pos = 0;
    const offs: number[] = [];
    let anyText = false;
    for (const el of els) {
      if (!(el.flags & 2) || !el.text) {
        offs.push(0);
        continue;
      }
      anyText = true;
      const bytes = unicode ? utf16(el.text) : this.ctx.enc.encode(el.text);
      const need = bytes.length + (unicode ? 2 : 1);
      if (pos + need > areaSize) {
        this.ctx.warn('dwg.write_ltype_text', '선종류 문자열 영역이 넘쳐 일부 글자를 뺐습니다.');
        offs.push(0);
        continue;
      }
      offs.push(pos);
      area.set(bytes, pos);
      pos += need;
    }
    els.forEach((el, i) => {
      d.BD(el.length);
      d.BS(el.flags & 2 ? offs[i] : (el.shapeNumber ?? 0));
      d.RD(el.offset?.x ?? 0);
      d.RD(el.offset?.y ?? 0);
      d.BD(el.scale ?? 1);
      d.BD(el.rotation ?? 0);
      d.BS(el.flags);
    });
    if (ver < R2007 || anyText) d.rawBytes(area);
    const hd = this.ow.hdl;
    hd.H(HARD_PTR, 0);
    for (const el of els) hd.H(HARD_PTR, this.ctx.ref(el.styleHandle));
    this.finish(r.h);
  }

  private layer(r: PRec<Layer>): void {
    const ctx = this.ctx;
    const l = r.rec;
    let xdata = l.xdata;
    // 도면층 투명도는 AcCmTransparency 확장 자료다
    if (l.transparency !== undefined && l.transparency !== 255 && !xdata?.some((x) => x.app.toUpperCase() === 'ACCMTRANSPARENCY')) {
      xdata = [...(xdata ?? []), { app: 'AcCmTransparency', items: [{ code: 1071, value: (0x02000000 | (l.transparency & 0xff)) >>> 0 }] }];
    }
    this.head('LAYER', r, 'LAYER', xdata);
    const d = this.ow.dat;
    let v = 0;
    if (l.frozen) v |= 1;
    if (l.off) v |= 2;
    if (l.flags & 2) v |= 4;
    if (l.locked) v |= 8;
    if (l.plot !== false) v |= 16;
    v |= (lwIndex(l.lineweight ?? -3) & 0x1f) << 5;
    d.BS(v);
    d.CMC(wcolor(ctx, { ...l.color, aci: Math.abs(l.color.aci) || 7 }, undefined, true));
    const hd = this.ow.hdl;
    hd.H(HARD_PTR, 0);
    if (this.ver >= R2000) hd.H(HARD_PTR, ctx.ref(l.plotStyle) || ctx.plotStyleNormal);
    if (this.ver >= R2007) hd.H(HARD_PTR, 0);
    hd.H(HARD_PTR, ctx.ltypeHandle(l.linetype) || ctx.ltContinuous);
    hd.H(HARD_PTR, 0);
    this.finish(r.h);
  }

  private style(r: PRec<TextStyle>): void {
    const s = r.rec;
    let xdata = s.xdata;
    if (s.fontFamily && !xdata?.some((x) => x.app.toUpperCase() === 'ACAD')) {
      xdata = [...(xdata ?? []), { app: 'ACAD', items: [{ code: 1000, value: s.fontFamily }, { code: 1071, value: s.fontFlags ?? 0 }] }];
    }
    this.head('STYLE', r, 'STYLE', xdata);
    const d = this.ow.dat;
    // 이름 없는 항목은 쉐이프 파일이다(DXF에서 읽은 것은 70 비트 1이 빠져 있기도 하다)
    d.B((s.flags & 1) !== 0 || !s.name);
    d.B((s.flags & 4) !== 0);
    d.BD(s.height);
    d.BD(s.widthFactor);
    d.BD(s.oblique);
    d.RC(s.generation);
    d.BD(s.lastHeight);
    d.TV(s.font ?? '');
    d.TV(s.bigFont ?? '');
    this.ow.hdl.H(HARD_PTR, 0);
    this.finish(r.h);
  }

  private dimstyle(r: PRec<DimStyle>): void {
    const ctx = this.ctx;
    const ver = this.ver;
    this.head('DIMSTYLE', r, 'DIMSTYLE');
    const d = this.ow.dat;
    const vars = r.rec.vars ?? {};
    const num = (n: string): number => {
      const v = vars[n] ?? DIM_VAR_DEFAULTS[n];
      const x = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(x) ? x : 0;
    };
    const str = (n: string): string => {
      const v = vars[n] ?? DIM_VAR_DEFAULTS[n];
      return v === undefined || v === null ? '' : String(v);
    };
    const B = (n: string) => d.B(num(n) ? 1 : 0);
    const BS = (n: string) => d.BS(num(n));
    const BD = (n: string) => d.BD(num(n));
    const CMC = (n: string) => d.CMC({ index: num(n) });
    d.TV(str('DIMPOST'));
    d.TV(str('DIMAPOST'));
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
      d.TV(str('DIMALTMZS'));
      BD('DIMMZF');
      d.TV(str('DIMMZS'));
    }
    d.BS(lwDim(num('DIMLWD')));
    d.BS(lwDim(num('DIMLWE')));
    d.B((r.rec.flags & 1) !== 0);
    const hd = this.ow.hdl;
    hd.H(HARD_PTR, 0);
    hd.H(HARD_PTR, ctx.style(str('DIMTXSTY') || 'Standard'));
    hd.H(HARD_PTR, ctx.arrowBlock(vars.DIMLDRBLK));
    hd.H(HARD_PTR, ctx.arrowBlock(vars.DIMBLK));
    hd.H(HARD_PTR, ctx.arrowBlock(vars.DIMBLK1));
    hd.H(HARD_PTR, ctx.arrowBlock(vars.DIMBLK2));
    if (ver >= R2007) {
      hd.H(HARD_PTR, ctx.ltypeHandle(str('DIMLTYPE')));
      hd.H(HARD_PTR, ctx.ltypeHandle(str('DIMLTEX1')));
      hd.H(HARD_PTR, ctx.ltypeHandle(str('DIMLTEX2')));
    }
    this.finish(r.h);
  }

  private appid(r: PRec<TableRecordBase>): void {
    this.head('APPID', r, 'APPID');
    this.ow.dat.RC(0);
    this.ow.hdl.H(HARD_PTR, 0);
    this.finish(r.h);
  }

  private vport(r: PRec<VPortRecord>): void {
    const ver = this.ver;
    const v = r.rec;
    this.head('VPORT', r, 'VPORT');
    const d = this.ow.dat;
    d.BD(v.height);
    d.BD(v.height !== 0 ? v.aspect * v.height : v.aspect);
    d.RD2(v.center);
    d.BD3(v.viewTarget);
    d.BD3(v.viewDirection);
    d.BD(v.twist);
    d.BD(v.lensLength || 50);
    d.BD(0);
    d.BD(0);
    viewMode(d, 0);
    if (ver >= R2000) d.RC(0);
    if (ver >= R2007) {
      d.B(1);
      d.RC(1);
      d.BD(0);
      d.BD(0);
      d.CMC({ index: 0, rgb: 0x333333 });
    }
    d.RD2(v.lowerLeft);
    d.RD2(v.upperRight);
    d.B(0);
    d.BS(1000);
    d.B(1);
    d.B(1);
    d.B(1);
    d.B(0);
    d.RD2(v.gridSpacing);
    d.B(0);
    d.B(0);
    d.BS(0);
    d.BD(0);
    d.RD2(v.snapBase);
    d.RD2(v.snapSpacing);
    if (ver >= R2000) {
      d.B(0);
      d.B(1);
      d.BD3({ x: 0, y: 0, z: 0 });
      d.BD3({ x: 1, y: 0, z: 0 });
      d.BD3({ x: 0, y: 1, z: 0 });
      d.BD(0);
      d.BS(0);
    }
    if (ver >= R2007) {
      d.BS(3);
      d.BS(5);
    }
    const hd = this.ow.hdl;
    hd.H(HARD_PTR, 0);
    if (ver >= R2007) {
      hd.H(SOFT_PTR, 0);
      hd.H(HARD_PTR, 0);
      hd.H(HARD_OWNER, 0);
    }
    if (ver >= R2000) {
      hd.H(HARD_PTR, 0);
      hd.H(HARD_PTR, 0);
    }
    this.finish(r.h);
  }

  private view(r: PRec<ViewRecord>): void {
    const ver = this.ver;
    const v = r.rec;
    this.head('VIEW', r, 'VIEW');
    const d = this.ow.dat;
    d.BD(v.height);
    d.BD(v.width);
    d.RD2(v.center);
    d.BD3(v.viewTarget);
    d.BD3(v.viewDirection);
    d.BD(v.twist);
    d.BD(50);
    d.BD(0);
    d.BD(0);
    viewMode(d, 0);
    if (ver >= R2000) d.RC(0);
    if (ver >= R2007) {
      d.B(1);
      d.RC(1);
      d.BD(0);
      d.BD(0);
      d.CMC({ index: 0, rgb: 0x333333 });
    }
    d.B((v.flags & 1) !== 0);
    if (ver >= R2000) {
      // AutoCAD처럼 연결된 UCS(세계 좌표계)를 둔다
      d.B(1);
      d.BD3({ x: 0, y: 0, z: 0 });
      d.BD3({ x: 1, y: 0, z: 0 });
      d.BD3({ x: 0, y: 1, z: 0 });
      d.BD(0);
      d.BS(0);
    }
    if (ver >= R2007) d.B(0);
    const hd = this.ow.hdl;
    hd.H(HARD_PTR, 0);
    if (ver >= R2007) {
      hd.H(SOFT_PTR, 0);
      hd.H(HARD_PTR, 0);
      hd.H(HARD_OWNER, 0);
    }
    if (ver >= R2000) {
      hd.H(HARD_PTR, 0);
      hd.H(HARD_PTR, 0);
    }
    if (ver >= R2007) hd.H(SOFT_PTR, 0);
    this.finish(r.h);
  }

  private ucs(r: PRec<UcsRecord>): void {
    const ver = this.ver;
    const u = r.rec;
    this.head('UCS', r, 'UCS');
    const d = this.ow.dat;
    d.BD3(u.origin);
    d.BD3(u.xAxis);
    d.BD3(u.yAxis);
    if (ver >= R2000) {
      d.BD(0);
      d.BS(0);
      d.BS(0);
    }
    const hd = this.ow.hdl;
    hd.H(HARD_PTR, 0);
    if (ver >= R2000) {
      hd.H(HARD_PTR, 0);
      hd.H(HARD_PTR, 0);
    }
    this.finish(r.h);
  }

  /** 블록 레코드(도형을 다 쓴 뒤: R2004+는 소유 도형 목록이 필요하다) */
  blockHeader(pb: PBlock): void {
    const ctx = this.ctx;
    const ver = this.ver;
    const def = pb.def;
    const rec = pb.rec;
    this.ow.begin(TYPE.BLOCK_HEADER, pb.recH, eedOf(ctx, rec.xdata));
    this.ow.commonObject({ owner: ctx.ctrl.get('BLOCK_RECORD')!, reactors: [], xdict: ctx.ref(rec.xdict) });
    const d = this.ow.dat;
    const space = pb === ctx.modelBlock || pb === ctx.paperBlock || /^\*PAPER_SPACE/.test(pb.key);
    const flags = space ? 0 : def.flags;
    const hasAtt = (flags & 2) !== 0 || def.entities.some((e) => e.type === 'ATTDEF');
    const isXref = (flags & 4) !== 0;
    const isOverlaid = (flags & 8) !== 0;
    d.TV(pb.name);
    d.B(1);
    if (ver < R2007) d.BS(0);
    d.B((flags & 16) !== 0);
    d.B((flags & 1) !== 0 || (!space && pb.name.startsWith('*')));
    d.B(hasAtt);
    d.B(isXref);
    d.B(isOverlaid);
    if (ver >= R2000) d.B((flags & 32) !== 0);
    if (ver >= R2004) d.BL(pb.ents.length);
    d.BD3(def.basePoint ?? { x: 0, y: 0, z: 0 });
    d.TV(def.xrefPath ?? '');
    if (ver >= R2000) {
      d.RC(0); // 블록 참조 수 목록 끝
      d.TV(def.description ?? '');
      d.BL(0); // 미리 보기 없음
    }
    if (ver >= R2007) {
      d.BS(rec.insertUnits ?? 0);
      d.B(rec.explodable !== false);
      d.RC(rec.scalable === false ? 0 : 1);
    }
    const hd = this.ow.hdl;
    hd.H(HARD_PTR, 0);
    hd.H(HARD_OWNER, pb.beginH);
    if (ver < R2004) {
      if (!isXref && !isOverlaid) {
        hd.H(SOFT_PTR, pb.ents[0]?.h ?? 0);
        hd.H(SOFT_PTR, pb.ents[pb.ents.length - 1]?.h ?? 0);
      }
    } else for (const pe of pb.ents) hd.H(HARD_OWNER, pe.h);
    hd.H(HARD_OWNER, pb.endH);
    if (ver >= R2000) hd.H(HARD_PTR, ctx.live.has(pb.layoutH) ? pb.layoutH : 0);
    this.finish(pb.recH);
  }
}

function viewMode(d: ObjWriter['dat'], m: number): void {
  d.B(m & 1);
  d.B(m & 2);
  d.B(m & 4);
  d.B(!(m & 16));
}

function utf16(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

/** 치수 선가중치: 모델은 -1·-2·-3, DWG도 같은 값을 BS로 둔다 */
function lwDim(v: number): number {
  return v;
}
