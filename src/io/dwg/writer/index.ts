/**
 * DWG 쓰기(ODA 공개 사양 기반의 독자 구현). 브라우저 작업자와 Node에서 모두 돈다.
 * 쓰는 버전: AC1015(R2000)·AC1018(R2004)·AC1024(R2010)·AC1027(R2013)·AC1032(R2018).
 * AC1021(R2007)을 달라고 하면 AC1018로, AC1012·AC1014는 AC1015로 쓰고 경고를 남긴다.
 */
import type { CadDocument, ReadWarning } from '../../../core/model';
import { R2000, R2004, R2007, R2010, R2013, R2018, versionNumber } from '../version';
import { ObjectWriter } from './objects';
import { ObjWriter } from './objwriter';
import { TableWriter } from './tables';
import { EntityWriter } from './entities';
import { WCtx } from './context';
import { writeHeader, type HeaderRefs } from './header';
import { writeClasses } from './classes';
import { ByteOut, type R2004Section, auxHeader, emptyPreview, objectMap, templateData, writeR2000, writeR2004 } from './container';
import { parseHandle } from './util';

export type DwgWriteVersion = 'AC1015' | 'AC1018' | 'AC1024' | 'AC1027' | 'AC1032';

export interface DwgWriteOptions {
  /** 기본 AC1032 */
  version?: DwgWriteVersion | 'AC1012' | 'AC1014' | 'AC1021';
  onProgress?: (fraction: number) => void;
  /** 원본 본문(dwgRaw) 되쓰기. 기본 참(거짓은 모델 값만으로 쓰는지 확인할 때) */
  raw?: boolean;
}

export interface DwgWriteResult {
  data: Uint8Array;
  warnings: ReadWarning[];
}

/** 파일 머리의 유지보수 버전(AutoCAD가 쓰는 값) */
const MAINT: Record<number, number> = { [R2000]: 15, [R2004]: 104, [R2010]: 226, [R2013]: 125, [R2018]: 0 };

function julianNow(): number {
  return Date.now() / 86400000 + 2440587.5;
}

export function writeDwg(doc: CadDocument, options: DwgWriteOptions = {}): DwgWriteResult {
  const warnings: ReadWarning[] = [];
  let ver = versionNumber(options.version ?? 'AC1032') || R2018;
  if (ver === R2007) {
    warnings.push({ code: 'dwg.write_version', message: 'AC1021(R2007) 쓰기는 지원하지 않아 AC1018(R2004)로 썼습니다.', count: 1 });
    ver = R2004;
  } else if (ver < R2000) {
    warnings.push({ code: 'dwg.write_version', message: `${options.version}은 쓸 수 없어 AC1015(R2000)로 썼습니다.`, count: 1 });
    ver = R2000;
  } else if (![R2000, R2004, R2010, R2013, R2018].includes(ver)) {
    warnings.push({ code: 'dwg.write_version', message: `${options.version}은 쓸 수 없어 AC1032(R2018)로 썼습니다.`, count: 1 });
    ver = R2018;
  }
  const progress = options.onProgress;
  progress?.(0);
  const maint = MAINT[ver] ?? 0;
  const ctx = new WCtx(doc, ver, warnings, options.raw !== false);
  ctx.plan();
  progress?.(0.1);

  const out = new Map<number, Uint8Array>();
  const put = (h: number, b: Uint8Array) => out.set(h, b);
  const ow = new ObjWriter(ver, ctx.enc, ctx.cpNum);
  // 클래스 번호를 먼저 정해 둔다(R2000은 배치·자리 표시자도 클래스)
  ctx.classes.declare('ACDBDICTIONARYWDFLT');
  ctx.classes.declare('ACDBPLACEHOLDER');
  ctx.classes.declare('LAYOUT');

  // 도형(블록마다). 실패한 도형은 빠진다
  const ew = new EntityWriter(ctx, ow, { put });
  const nb = ctx.blocks.length || 1;
  ctx.blocks.forEach((pb, i) => {
    ew.writeBlock(pb);
    progress?.(0.1 + 0.6 * ((i + 1) / nb));
  });
  // 표
  const tw = new TableWriter(ctx, ow, put);
  tw.writeAll();
  for (const pb of ctx.blocks) tw.blockHeader(pb);
  // 배치와 객체
  const objw = new ObjectWriter(ctx, ow, put);
  for (const pl of ctx.layouts) {
    const pb = ctx.blocks.find((b) => b.layoutH === pl.h);
    objw.layout(pl, pb ? pb.recH : 0);
  }
  for (const po of ctx.objects) {
    try {
      objw.write(po);
    } catch (err) {
      ctx.warn('dwg.write_object_failed', '객체를 쓰지 못해 뺐습니다.', { type: po.o.type, handle: po.o.handle, error: String(err) });
    }
  }
  progress?.(0.8);

  // 헤더
  const hv = doc.header;
  const refs: HeaderRefs = {
    blockControl: ctx.ctrl.get('BLOCK_RECORD')!,
    layerControl: ctx.ctrl.get('LAYER')!,
    styleControl: ctx.ctrl.get('STYLE')!,
    ltypeControl: ctx.ctrl.get('LTYPE')!,
    viewControl: ctx.ctrl.get('VIEW')!,
    ucsControl: ctx.ctrl.get('UCS')!,
    vportControl: ctx.ctrl.get('VPORT')!,
    appidControl: ctx.ctrl.get('APPID')!,
    dimstyleControl: ctx.ctrl.get('DIMSTYLE')!,
    vpentControl: ctx.ctrl.get('VPENT') ?? 0,
    groupDict: ctx.dicts.get('ACAD_GROUP') ?? 0,
    mlineStyleDict: ctx.dicts.get('ACAD_MLINESTYLE') ?? 0,
    namedObjDict: ctx.rootDict,
    layoutDict: ctx.dicts.get('ACAD_LAYOUT') ?? 0,
    plotSettingsDict: ctx.dicts.get('ACAD_PLOTSETTINGS') ?? 0,
    plotStyleDict: ctx.dicts.get('ACAD_PLOTSTYLENAME') ?? 0,
    materialDict: ctx.dicts.get('ACAD_MATERIAL') ?? 0,
    colorDict: ctx.dicts.get('ACAD_COLOR') ?? 0,
    visualStyleDict: ctx.dicts.get('ACAD_VISUALSTYLE') ?? 0,
    paperSpace: ctx.paperBlock.recH,
    modelSpace: ctx.modelBlock.recH,
    ltByLayer: ctx.ltByLayer,
    ltByBlock: ctx.ltByBlock,
    ltContinuous: ctx.ltContinuous,
  };
  const str = (k: string): string | undefined => {
    const v = hv.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  const handleVar = (k: string): number => {
    const v = str(k);
    switch (k) {
      case '$CLAYER':
        return ctx.layer(v ?? '0');
      case '$TEXTSTYLE':
      case '$DIMTXSTY':
        return ctx.style(v ?? 'Standard');
      case '$CELTYPE':
        return ctx.ltypeHandle(v ?? 'ByLayer') || ctx.ltByLayer;
      case '$DIMSTYLE':
        return ctx.dimstyle(v ?? 'Standard');
      case '$CMLSTYLE':
        return ctx.mlstyleH.get((v ?? 'Standard').toUpperCase()) ?? ctx.mlstyleH.get('STANDARD') ?? 0;
      case '$UCSNAME':
      case '$PUCSNAME':
      case '$UCSBASE':
      case '$PUCSBASE':
      case '$UCSORTHOREF':
      case '$PUCSORTHOREF':
        return v ? (ctx.ucsH.get(v.toUpperCase()) ?? 0) : 0;
      case '$DIMLDRBLK':
      case '$DIMBLK':
      case '$DIMBLK1':
      case '$DIMBLK2':
        return ctx.arrowBlock(v);
      case '$DIMLTYPE':
      case '$DIMLTEX1':
      case '$DIMLTEX2':
        return ctx.ltypeHandle(v);
      default:
        return ctx.ref(v);
    }
  };
  const handseed = ctx.handseed;
  // 헤더가 가리키는 16진 핸들 변수는 쓰는 객체일 때만
  const vars = new Map(hv);
  for (const k of ['$CMATERIAL', '$INTERFEREOBJVS', '$INTERFEREVPVS', '$DRAGVS']) {
    const v = vars.get(k);
    if (typeof v === 'string' && v && !ctx.live.has(parseHandle(v))) vars.set(k, '');
  }
  const cec = hv.get('$CECOLOR');
  const header = writeHeader(ver, maint, ctx.enc, {
    vars,
    refs,
    handseed,
    handleVar,
    cecolor: { index: typeof cec === 'number' ? cec : 256 },
  });
  const classes = writeClasses(ver, maint, ctx.enc, ctx.classes.list);
  const objects = [...out.entries()].filter(([h]) => ctx.live.has(h)).sort((a, b) => a[0] - b[0]);
  const num = (k: string, def: number): number => {
    const v = hv.get(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  const now = julianNow();
  const aux = auxHeader(ver, maint, num('$TDCREATE', now), num('$TDUPDATE', now), handseed);
  const measurement = num('$MEASUREMENT', 0) ? 1 : 0;
  progress?.(0.9);

  let data: Uint8Array;
  if (ver === R2000) {
    data = writeR2000({ ver, maint, codepage: ctx.cpNum, header, classes, objects, aux, measurement });
  } else {
    // AcDb:AcDbObjects: RL 0x0DCA 다음에 객체들, 지도 위치는 섹션 안 위치
    const ob = new ByteOut(1 << 20);
    ob.u32(0x0dca);
    const map: [number, number][] = [];
    for (const [h, b] of objects) {
      map.push([h, ob.n]);
      ob.bytes(b);
    }
    const sections: R2004Section[] = [
      { name: 'AcDb:SummaryInfo', data: summaryInfo(ver, ctx, num('$TDCREATE', now), num('$TDUPDATE', now)), compressed: false, pageSize: 0x100 },
      { name: 'AcDb:Preview', data: emptyPreview(), compressed: false, pageSize: 0x400 },
      { name: 'AcDb:RevHistory', data: new Uint8Array(12), compressed: true, pageSize: 0x7400 },
      { name: 'AcDb:AcDbObjects', data: ob.result(), compressed: true, pageSize: 0x7400 },
      { name: 'AcDb:ObjFreeSpace', data: objFreeSpace(objects.length, num('$TDUPDATE', now)), compressed: true, pageSize: 0x7400 },
      { name: 'AcDb:Template', data: templateData(measurement), compressed: true, pageSize: 0x7400 },
      { name: 'AcDb:Handles', data: objectMap(map), compressed: true, pageSize: 0x7400 },
      { name: 'AcDb:Classes', data: classes, compressed: true, pageSize: 0x7400 },
      { name: 'AcDb:AuxHeader', data: aux, compressed: true, pageSize: 0x7400 },
      { name: 'AcDb:Header', data: header, compressed: true, pageSize: 0x7400 },
    ];
    // 섹션 지도 순서
    const mapOrder = ['AcDb:Preview', 'AcDb:SummaryInfo', 'AcDb:RevHistory', 'AcDb:AcDbObjects', 'AcDb:ObjFreeSpace', 'AcDb:Template', 'AcDb:Handles', 'AcDb:Classes', 'AcDb:AuxHeader', 'AcDb:Header'];
    const ordered = mapOrder.map((n) => sections.find((s) => s.name === n)!);
    data = writeR2004(
      ver,
      maint,
      ctx.cpNum,
      ordered,
      sections.map((s) => s.name),
    );
  }
  progress?.(1);
  return { data, warnings };
}

/** AcDb:SummaryInfo(사양 13장) */
function summaryInfo(ver: number, ctx: WCtx, tdcreate: number, tdupdate: number): Uint8Array {
  const o = new ByteOut(256);
  const s = (v: string) => {
    if (ver >= R2007) {
      o.u16(v.length ? v.length + 1 : 0);
      for (let i = 0; i < v.length; i++) o.u16(v.charCodeAt(i));
      if (v.length) o.u16(0);
    } else {
      const b = ctx.enc.encode(v);
      o.u16(b.length ? b.length + 1 : 0);
      o.bytes(b);
      if (b.length) o.u8(0);
    }
  };
  const hv = ctx.doc.header;
  const get = (k: string) => {
    const v = hv.get(k);
    return typeof v === 'string' ? v : '';
  };
  s(get('$TITLE'));
  s(get('$SUBJECT'));
  s(get('$AUTHOR'));
  s(get('$KEYWORDS'));
  s(get('$COMMENTS'));
  s(get('$LASTSAVEDBY'));
  s(get('$REVISIONNUMBER'));
  s(get('$HYPERLINKBASE'));
  o.u32(0);
  o.u32(0);
  const jd = (x: number) => {
    const day = Math.floor(x);
    o.u32(day);
    o.u32(Math.min(86399999, Math.round((x - day) * 86400000)));
  };
  jd(tdcreate);
  jd(tdupdate);
  o.u16(0);
  o.u32(0);
  o.u32(0);
  return o.result();
}

/** AcDb:ObjFreeSpace(사양 21장, R18까지의 형식) */
function objFreeSpace(count: number, tdupdate: number): Uint8Array {
  const o = new ByteOut(64);
  o.u32(0);
  o.u32(count);
  const day = Math.floor(tdupdate);
  o.u32(day);
  o.u32(Math.min(86399999, Math.round((tdupdate - day) * 86400000)));
  o.u32(0);
  o.u8(4);
  for (const x of [0x32, 0, 0x64, 0, 0x200, 0, 0xffffffff, 0]) o.u32(x);
  return o.result();
}

