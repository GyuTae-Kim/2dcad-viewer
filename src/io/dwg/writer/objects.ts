/** 비도형 객체 쓰기(사양 20.4.44·45·72~104, objects/nonentities.ts의 짝) */
import type {
  DictionaryObject,
  GenericObject,
  GroupObject,
  ImageDefObject,
  Layout,
  MLeaderStyleObject,
  MLineStyleObject,
  PlotSettings,
  RawTag,
  ScaleObject,
  SortEntsTableObject,
  SpatialFilterObject,
  UnderlayDefObject,
  XRecordObject,
} from '../../../core/model';
import { R2000, R2004, R2007, R2010, R2013, R2018 } from '../version';
import { BitWriter } from './bitwriter';
import type { PLayout, PObj, WCtx } from './context';
import { eedOf, wcolor } from './common';
import { HARD_OWNER, HARD_PTR, SOFT_OWNER, SOFT_PTR, type ObjWriter } from './objwriter';
import { parseHandle } from './util';
import { writeRawObject } from './rawobjects';
import { tableKey } from '../../../core/model';
import { defaultIoTableStyle, parseTableStyleTags } from '../../tablestyle';
import { tableStyleOld, tableStyleR24, writeIO } from '../tablecodec';
import { styleToOld, styleToR24 } from '../tablemodel';

type Put = (h: number, b: Uint8Array) => void;

const DICTIONARY = 42;
const GROUP = 72;
const MLINESTYLE = 73;
const XRECORD = 79;
const PLACEHOLDER = 80;
const LAYOUT = 82;

export class ObjectWriter {
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

  private cls(name: string): number {
    return this.ctx.classes.number(name, false);
  }

  /** 객체 머리와 공통 자료 */
  private start(type: number, po: { o: { xdata?: GenericObject['xdata']; owner?: string; reactors?: string[]; xdict?: string }; h: number }, ownerOverride?: number, dataStore = false): void {
    const ctx = this.ctx;
    this.ow.begin(type, po.h, eedOf(ctx, po.o.xdata));
    this.ow.commonObject({ owner: ownerOverride ?? ctx.ref(po.o.owner), reactors: ctx.refs(po.o.reactors), xdict: ctx.ref(po.o.xdict), dataStore });
  }

  write(po: PObj): void {
    const ctx = this.ctx;
    const o = po.o;
    const h = po.h;
    if (po.raw) {
      const raw = po.raw;
      const type = raw.typeNum || this.cls(raw.typeName);
      this.start(type, po, undefined, !!raw.dataStore);
      this.ow.appendRaw(raw.data, raw.dataBits, raw.strings, raw.stringBits ?? 0, raw.handles, raw.handleBits);
      this.put(h, this.ow.finish());
      return;
    }
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    switch (o.type) {
      case 'DICTIONARY':
      case 'ACDBDICTIONARYWDFLT': {
        const dict = o as DictionaryObject;
        const wdflt = o.type === 'ACDBDICTIONARYWDFLT';
        this.start(wdflt ? this.cls('ACDBDICTIONARYWDFLT') : DICTIONARY, po, h === ctx.rootDict ? 0 : undefined);
        const entries: [string, number][] = [];
        let dropped = 0;
        for (const [name, hs] of dict.entries) {
          const x = ctx.ref(hs);
          if (x) entries.push([name, x]);
          else if (!ctx.silent.has(parseHandle(hs))) dropped++;
        }
        if (dropped) ctx.warn('dwg.write_dict_entry_dropped', '쓰지 않는 객체를 가리키는 사전 항목을 뺐습니다.', { count: dropped });
        d.BL(entries.length);
        if (this.ver >= R2000) {
          d.BS(dict.cloning ?? 1);
          d.RC(dict.hardOwner ? 1 : 0);
        }
        for (const [name] of entries) d.TV(name);
        for (const [, x] of entries) hd.H(dict.hardOwner ? HARD_OWNER : SOFT_OWNER, x);
        if (wdflt) hd.H(HARD_PTR, ctx.ref(dict.defaultHandle));
        break;
      }
      case 'PLOTSETTINGS': {
        this.start(this.cls('PLOTSETTINGS'), po);
        plotSettings(d, this.ver, (o as { plot: PlotSettings }).plot);
        // 플롯 뷰(R2004+)·시각 스타일(R2007+) 핸들(AutoCAD 표본)
        if (this.ver >= R2004) hd.H(HARD_PTR, 0);
        if (this.ver >= R2007) hd.H(SOFT_PTR, 0);
        break;
      }
      case 'MLINESTYLE': {
        const m = o as MLineStyleObject;
        this.start(MLINESTYLE, po);
        d.TV(m.name);
        d.TV(m.description ?? '');
        const map: [number, number][] = [
          [1, 2],
          [2, 1],
          [16, 16],
          [32, 64],
          [64, 32],
          [256, 256],
          [512, 1024],
          [1024, 512],
        ];
        let f = 0;
        for (const [a, b] of map) if (m.flags & b) f |= a;
        d.BS(f);
        d.CMC(wcolor(ctx, m.fillColor, undefined, true));
        d.BD(m.startAngle);
        d.BD(m.endAngle);
        d.RC(m.elements.length);
        // R2018 이전 선종류는 선종류 제어 목록의 순번(32767 ByLayer, 32766 ByBlock)
        const ltIndex = (name: string): number => {
          const k = name.toUpperCase();
          if (k === 'BYLAYER' || !k) return 32767;
          if (k === 'BYBLOCK') return 32766;
          const i = ctx.ltypes.findIndex((r) => r.rec.name.toUpperCase() === k);
          return i >= 0 ? i : 32767;
        };
        for (const el of m.elements) {
          d.BD(el.offset);
          d.CMC(wcolor(ctx, el.color, undefined, true));
          if (this.ver < R2018) d.BS(ltIndex(el.linetype ?? 'ByLayer'));
          else hd.H(HARD_PTR, ctx.ltypeHandle(el.linetype || 'ByLayer'));
        }
        break;
      }
      case 'IMAGEDEF': {
        const m = o as ImageDefObject;
        this.start(this.cls('IMAGEDEF'), po);
        d.BL(0);
        d.RD2(m.imageSize);
        d.TV(m.fileName);
        d.B(m.loaded);
        d.RC(m.resolutionUnits);
        d.RD2(m.pixelSize);
        break;
      }
      case 'PDFDEFINITION':
      case 'DWFDEFINITION':
      case 'DGNDEFINITION': {
        const m = o as UnderlayDefObject;
        this.start(this.cls(o.type), po);
        d.TV(m.fileName);
        d.TV(m.name);
        break;
      }
      case 'SORTENTSTABLE': {
        const m = o as SortEntsTableObject;
        this.start(this.cls('SORTENTSTABLE'), po);
        const list = m.entries.filter((x) => ctx.ref(x.entity));
        d.BL(list.length);
        for (const x of list) d.H(0, parseHandle(x.sort));
        hd.H(SOFT_PTR, ctx.ref(m.blockRecord));
        for (const x of list) hd.H(SOFT_PTR, ctx.ref(x.entity));
        break;
      }
      case 'GROUP': {
        const m = o as GroupObject;
        this.start(GROUP, po);
        const ents = ctx.refs(m.entities);
        d.TV(m.description ?? '');
        d.BS(m.unnamed ? 1 : 0);
        d.BS(m.selectable ? 1 : 0);
        d.BL(ents.length);
        for (const x of ents) hd.H(HARD_PTR, x);
        break;
      }
      case 'XRECORD': {
        const m = o as XRecordObject;
        this.start(XRECORD, po);
        const body = new BitWriter(this.ver, ctx.enc, 256);
        const handles: number[] = [];
        for (const t of mergePoints(m.data)) xrecordTag(body, this.ver, t, handles, ctx);
        const bytes = body.bytes();
        d.BL(bytes.length);
        d.rawBytes(bytes);
        if (this.ver >= R2000) d.BS(m.cloning ?? 1);
        for (const x of handles) hd.H(HARD_PTR, x);
        break;
      }
      case 'SPATIAL_FILTER': {
        const m = o as SpatialFilterObject;
        this.start(this.cls('SPATIAL_FILTER'), po);
        d.BS(m.boundary.length);
        for (const p of m.boundary) d.RD2(p);
        d.BD3(m.normal);
        d.BD3(m.origin);
        d.BS(m.displayBoundary ? 1 : 0);
        d.BS(m.frontClip !== undefined ? 1 : 0);
        if (m.frontClip !== undefined) d.BD(m.frontClip);
        d.BS(m.backClip !== undefined ? 1 : 0);
        if (m.backClip !== undefined) d.BD(m.backClip);
        for (let i = 0; i < 12; i++) d.BD(m.inverseBlockTransform[i] ?? (i % 4 === i / 4 ? 1 : 0));
        for (let i = 0; i < 12; i++) d.BD(m.clipTransform[i] ?? 0);
        break;
      }
      case 'SCALE': {
        const m = o as ScaleObject;
        this.start(this.cls('SCALE'), po);
        d.BS(0);
        d.TV(m.name);
        d.BD(m.paperUnits);
        d.BD(m.drawingUnits);
        d.B(m.unitScale);
        break;
      }
      case 'DBCOLOR': {
        const m = o as GenericObject;
        this.start(this.cls('DBCOLOR'), po);
        d.CMC(wcolor(ctx, m.color, undefined, true));
        break;
      }
      case 'DICTIONARYVAR': {
        const m = o as GenericObject;
        this.start(this.cls('DICTIONARYVAR'), po);
        d.RC(Number(tag(m.raw, 280) ?? 0));
        d.TV(String(tag(m.raw, 1) ?? ''));
        break;
      }
      case 'ACDBPLACEHOLDER':
        this.start(this.ver >= R2004 ? PLACEHOLDER : this.cls('ACDBPLACEHOLDER'), po);
        break;
      case 'IMAGEDEF_REACTOR':
        this.start(this.cls('IMAGEDEF_REACTOR'), po);
        d.BL(Number(tag((o as GenericObject).raw, 90) ?? 2));
        break;
      case 'RASTERVARIABLES': {
        const raw = (o as GenericObject).raw;
        this.start(this.cls('RASTERVARIABLES'), po);
        d.BL(Number(tag(raw, 90) ?? 0));
        d.BS(Number(tag(raw, 70) ?? 1));
        d.BS(Number(tag(raw, 71) ?? 1));
        d.BS(Number(tag(raw, 72) ?? 0));
        break;
      }
      case 'WIPEOUTVARIABLES': {
        const raw = (o as GenericObject).raw;
        this.start(this.cls('WIPEOUTVARIABLES'), po);
        d.BS(Number(tag(raw, 70) ?? 1));
        break;
      }
      case 'MLEADERSTYLE':
        this.mleaderStyle(o as MLeaderStyleObject, po);
        break;
      case 'TABLESTYLE': {
        // 원본 태그(DXF·DWG 리더·편집)의 값, 없으면 Standard 기본값(tablemodel.ts)
        this.start(this.cls('TABLESTYLE'), po);
        const ts = parseTableStyleTags((o as GenericObject).raw) ?? defaultIoTableStyle(ctx.doc.header.get('$MEASUREMENT') === 1);
        const styleH = (n: string) => ctx.styleH.get(tableKey(n)) ?? ctx.style('Standard');
        const io = writeIO(d, hd, this.ver);
        if (this.ver >= R2010) tableStyleR24(io, styleToR24(ts, styleH));
        else tableStyleOld(io, styleToOld(ts, styleH));
        break;
      }
      case 'FIELD':
      case 'FIELDLIST':
      case 'DIMASSOC':
      case 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS':
        this.start(this.cls(o.type), po);
        writeRawObject(d, hd, ctx, o as GenericObject);
        break;
      default:
        throw new Error(`쓸 수 없는 객체 ${o.type}`);
    }
    this.put(h, this.ow.finish());
  }

  private mleaderStyle(m: MLeaderStyleObject, po: PObj): void {
    const ctx = this.ctx;
    const ver = this.ver;
    this.start(this.cls('MLEADERSTYLE'), po);
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    const raw = m.raw;
    const n = (code: number, def: number): number => {
      const v = tag(raw, code);
      const x = Number(v);
      return v === undefined || !Number.isFinite(x) ? def : x;
    };
    const isNew = ver >= R2010 || !!m.xdata?.some((x) => x.app.toUpperCase() === 'ACAD_MLEADERVER');
    if (ver >= R2010) d.BS(n(179, 2));
    d.BS(m.contentType);
    d.BS(n(171, 1));
    d.BS(n(172, 0));
    d.BL(n(90, 2));
    d.BD(n(40, 0));
    d.BD(n(41, 0));
    d.BS(m.leaderLineType);
    d.CMC(wcolor(ctx, m.leaderLineColor, undefined, true));
    hd.H(HARD_PTR, ctx.ltypeHandle('ByBlock'));
    d.BL(m.leaderLineWeight);
    d.B(m.landing);
    d.BD(m.landingGap);
    d.B(n(291, 1) !== 0);
    d.BD(m.doglegLength);
    d.TV(m.name ?? '');
    hd.H(HARD_PTR, ctx.ref(m.arrowHeadHandle));
    d.BD(m.arrowSize);
    d.TV(String(tag(raw, 300) ?? ''));
    hd.H(HARD_PTR, ctx.ref(m.textStyleHandle) || ctx.style('Standard'));
    d.BS(n(174, 1));
    d.BS(n(178, 1));
    if (isNew) d.BS(n(175, 1));
    d.BS(n(176, 0));
    d.CMC(wcolor(ctx, m.textColor, undefined, true));
    d.BD(m.textHeight);
    d.B(n(292, 0) !== 0);
    if (isNew) d.B(n(297, 0) !== 0);
    d.BD(n(46, m.textHeight || 0.18));
    hd.H(HARD_PTR, ctx.ref(m.blockHandle));
    d.CMC({ index: 0, rgb: undefined });
    d.BD3({ x: n(47, 1), y: n(49, 1), z: n(140, 1) });
    d.B(n(293, 1) !== 0);
    d.BD(n(141, 0));
    d.B(n(294, 1) !== 0);
    d.BS(n(177, 0));
    d.BD(m.scale);
    d.B(n(295, 0) !== 0);
    d.B(n(296, 0) !== 0);
    d.BD(n(143, 0.125));
    if (ver >= R2010) {
      d.BS(n(271, 0));
      d.BS(n(273, 9));
      d.BS(n(272, 9));
    }
    // R2013+: 비트 하나가 더 있다(AutoCAD 표본, 값 0)
    if (ver >= R2013) d.B(n(298, 0) !== 0);
  }

  /** LAYOUT 객체 */
  layout(pl: PLayout, blockRecord: number): void {
    const ctx = this.ctx;
    const ver = this.ver;
    const lay: Layout = pl.lay;
    const o = pl.obj ?? { xdata: undefined, owner: undefined, reactors: undefined, xdict: undefined };
    const dict = ctx.dicts.get('ACAD_LAYOUT') ?? 0;
    this.ow.begin(ver >= R2004 ? LAYOUT : this.cls('LAYOUT'), pl.h, eedOf(ctx, o.xdata));
    const reactors = ctx.refs(o.reactors);
    if (!reactors.length && dict) reactors.push(dict);
    this.ow.commonObject({ owner: dict, reactors, xdict: ctx.ref(o.xdict) });
    const d = this.ow.dat;
    const hd = this.ow.hdl;
    plotSettings(d, ver, lay.plot);
    d.TV(lay.name);
    d.BL(lay.tabOrder);
    d.BS(lay.flags);
    d.BD3(lay.ucsOrigin);
    d.RD2(lay.limitsMin);
    d.RD2(lay.limitsMax);
    d.BD3(lay.insertionBase);
    d.BD3(lay.ucsXAxis);
    d.BD3(lay.ucsYAxis);
    d.BD(lay.elevation);
    d.BS(0);
    d.BD3(lay.extMin);
    d.BD3(lay.extMax);
    // 뷰포트 수: 사양은 RL이라 하지만 AutoCAD 표본은 BL이다
    if (ver >= R2004) d.BL(0);
    if (ver >= R2004) hd.H(HARD_PTR, 0);
    if (ver >= R2007) hd.H(SOFT_PTR, 0);
    hd.H(SOFT_PTR, blockRecord);
    hd.H(SOFT_PTR, ctx.ref(lay.viewport));
    hd.H(HARD_PTR, 0);
    hd.H(HARD_PTR, 0);
    this.put(pl.h, this.ow.finish());
  }
}

/** 플롯 설정(LAYOUT 앞부분, PLOTSETTINGS) */
function plotSettings(d: BitWriter, ver: number, p: PlotSettings): void {
  d.TV(p.pageSetupName ?? '');
  d.TV(p.printerName ?? '');
  d.BS(p.flags);
  for (let i = 0; i < 4; i++) d.BD(p.margins?.[i] ?? 0);
  d.BD(p.paperWidth);
  d.BD(p.paperHeight);
  d.TV(p.paperName ?? '');
  d.BD2(p.plotOrigin);
  d.BS(p.paperUnits);
  d.BS(p.rotation);
  d.BS(p.plotType);
  d.BD2(p.windowMin);
  d.BD2(p.windowMax);
  if (ver < R2004) d.T('');
  d.BD(p.scaleNumerator);
  d.BD(p.scaleDenominator);
  d.TV(p.styleSheet ?? '');
  d.BS(p.standardScaleType);
  d.BD(p.scaleDenominator ? p.scaleNumerator / p.scaleDenominator : 1);
  d.BD2({ x: 0, y: 0 });
  if (ver >= R2004) {
    d.BS(0);
    d.BS(2);
    d.BS(300);
  }
}

/** 점 X 코드(DWG XRECORD는 X 코드 하나에 3RD) */
const isPointX = (c: number): boolean => (c >= 10 && c <= 18) || (c >= 110 && c <= 112) || c === 210 || (c >= 1010 && c <= 1013);

/**
 * DXF에서 읽은 XRECORD는 점을 10·20·30처럼 나눠 담는다: DWG처럼 X 코드 하나("x,y,z")로 합친다.
 * DWG에서 읽은 것은 이미 "x,y,z"이다.
 */
function mergePoints(tags: RawTag[]): RawTag[] {
  const out: RawTag[] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (isPointX(t.code) && !String(t.value).includes(',')) {
      const y = tags[i + 1]?.code === t.code + 10 ? Number(tags[i + 1].value) : 0;
      if (tags[i + 1]?.code === t.code + 10) i++;
      const z = tags[i + 1]?.code === t.code + 20 ? Number(tags[i + 1].value) : 0;
      if (tags[i + 1]?.code === t.code + 20) i++;
      out.push({ code: t.code, value: `${Number(t.value) || 0},${y || 0},${z || 0}` });
      continue;
    }
    // 홀로 남은 Y·Z 코드는 DWG에 둘 곳이 없다
    if (isPointX(t.code - 10) || isPointX(t.code - 20)) continue;
    out.push(t);
  }
  return out;
}

function tag(raw: RawTag[] | undefined, code: number): string | number | undefined {
  return raw?.find((t) => t.code === code)?.value;
}

/** XRECORD 자료 하나(RS 그룹 코드 + 값). 핸들 값은 handles에도 모은다 */
function xrecordTag(b: BitWriter, ver: number, t: RawTag, handles: number[], ctx: WCtx): void {
  const code = t.code;
  const v = t.value;
  const strCode = (code >= 0 && code <= 9) || code === 100 || code === 102 || (code >= 300 && code <= 309) || (code >= 410 && code <= 419) || (code >= 430 && code <= 439) || (code >= 470 && code <= 479) || (code >= 999 && code <= 1009 && code !== 1004);
  const known =
    strCode ||
    (code >= 10 && code <= 59) ||
    (code >= 60 && code <= 79) ||
    (code >= 90 && code <= 99) ||
    (code >= 110 && code <= 149) ||
    (code >= 160 && code <= 179) ||
    (code >= 210 && code <= 239) ||
    (code >= 270 && code <= 299) ||
    (code >= 310 && code <= 319) ||
    (code >= 320 && code <= 369) ||
    (code >= 370 && code <= 389) ||
    (code >= 390 && code <= 399) ||
    (code >= 400 && code <= 409) ||
    (code >= 420 && code <= 429) ||
    (code >= 440 && code <= 459) ||
    (code >= 460 && code <= 469) ||
    (code >= 480 && code <= 481) ||
    (code >= 1004 && code <= 1071);
  if (!known) return;
  b.RS(code);
  if (strCode) {
    const s = String(v ?? '');
    if (ver >= R2007) {
      b.RS(s.length);
      for (let i = 0; i < s.length; i++) b.RS(s.charCodeAt(i));
    } else {
      const bytes = ctx.enc.encode(s);
      b.RS(bytes.length);
      b.RC(ctx.cpNum);
      b.rawBytes(bytes);
    }
    return;
  }
  if ((code >= 10 && code <= 39) || (code >= 110 && code <= 139) || (code >= 210 && code <= 239) || (code >= 1010 && code <= 1039)) {
    if ((code >= 10 && code <= 18) || (code >= 110 && code <= 112) || code === 210 || (code >= 1010 && code <= 1013)) {
      const parts = String(v).split(',').map(Number);
      b.RD(parts[0] || 0);
      b.RD(parts[1] || 0);
      b.RD(parts[2] || 0);
      return;
    }
    b.RD(Number(v) || 0);
    return;
  }
  if ((code >= 40 && code <= 59) || (code >= 140 && code <= 149) || (code >= 460 && code <= 469) || (code >= 1040 && code <= 1059)) {
    b.RD(Number(v) || 0);
    return;
  }
  if ((code >= 60 && code <= 79) || (code >= 170 && code <= 179) || (code >= 270 && code <= 279) || (code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 1060 && code <= 1070)) {
    b.RS(Number(v) & 0xffff);
    return;
  }
  if (code >= 280 && code <= 289) {
    b.RC(Number(v) & 0xff);
    return;
  }
  if ((code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459) || code === 1071) {
    b.RL(Number(v) | 0);
    return;
  }
  if (code >= 160 && code <= 169) {
    const x = Number(v) || 0;
    b.RL(x % 0x100000000);
    b.RL(Math.floor(x / 0x100000000));
    return;
  }
  if (code >= 290 && code <= 299) {
    b.RC(Number(v) & 0xff);
    return;
  }
  if ((code >= 320 && code <= 369) || (code >= 390 && code <= 399) || (code >= 480 && code <= 481)) {
    const h = ctx.ref(String(v));
    if (h) handles.push(h);
    let x = h;
    const bytes: number[] = [];
    for (let i = 0; i < 8; i++) {
      bytes.push(x % 256);
      x = Math.floor(x / 256);
    }
    for (const byte of bytes) b.RC(byte);
    return;
  }
  if ((code >= 310 && code <= 319) || code === 1004) {
    const s = String(v).replace(/[^0-9a-fA-F]/g, '');
    const n = Math.min(255, s.length >> 1);
    b.RC(n);
    for (let i = 0; i < n; i++) b.RC(parseInt(s.substr(i * 2, 2), 16));
    return;
  }
}

