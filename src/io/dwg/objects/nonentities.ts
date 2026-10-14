/** 도형이 아닌 객체(사전, 배치, 각종 스타일 등) */
import type {
  CadObject,
  DictionaryObject,
  GroupObject,
  ImageDefObject,
  MLeaderStyleObject,
  MLineStyleObject,
  PlotSettings,
  RawTag,
  ScaleObject,
  SortEntsTableObject,
  SpatialFilterObject,
  UnderlayDefObject,
  Vec2,
  Vec3,
  XRecordObject,
} from '../../../core/model';
import { defaultPlotSettings } from '../../../core/finalize';
import { type BitReader, DwgFormatError, codesToString } from '../bitstream';
import { cmcToCad } from '../color';
import { R2000, R2004, R2007, R2010, R2018 } from '../version';
import type { ObjectReader } from './reader';

export const hex = (h: number): string => (h > 0 ? h.toString(16).toUpperCase() : '');

/** 배치 객체 원본(블록 레코드 이름은 나중에 푼다) */
export interface LayoutRaw {
  handle: number;
  name: string;
  tabOrder: number;
  flags: number;
  limitsMin: Vec2;
  limitsMax: Vec2;
  insertionBase: Vec3;
  extMin: Vec3;
  extMax: Vec3;
  elevation: number;
  ucsOrigin: Vec3;
  ucsXAxis: Vec3;
  ucsYAxis: Vec3;
  plot: PlotSettings;
  blockRecord: number;
  viewport: number;
  owner: number;
}

/** MLINESTYLE 원본(선종류 번호·핸들은 나중에 푼다) */
export interface MLineStyleRaw extends MLineStyleObject {
  ltRefs: { index: number; handle: number }[];
}

function base(or: ObjectReader, type: string) {
  const h = or.h;
  const o: { type: string; handle: string; owner?: string; xdict?: string; reactors?: string[] } = { type, handle: hex(h.handle) };
  if (h.owner) o.owner = hex(h.owner);
  if (h.xdict) o.xdict = hex(h.xdict);
  if (h.reactors.length) o.reactors = h.reactors.map(hex);
  return o;
}

export function readDictionary(or: ObjectReader, withDefault: boolean): DictionaryObject {
  or.commonObject();
  const r = or.dat;
  const ver = or.ver;
  const n = r.checkCount(r.BL(), 2);
  let cloning = 0;
  let hardOwner = false;
  if (ver === 1014) r.RC();
  if (ver >= R2000) {
    cloning = r.BS();
    hardOwner = r.RC() !== 0;
  }
  const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(r.TV());
  const hr = or.hdl;
  const entries = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const h = hr.H(or.h.handle);
    entries.set(names[i], hex(h));
  }
  const d: DictionaryObject = { ...base(or, withDefault ? 'ACDBDICTIONARYWDFLT' : 'DICTIONARY'), entries, hardOwner, cloning } as DictionaryObject;
  if (withDefault && hr.pos + 8 <= hr.end) d.defaultHandle = hex(hr.H(or.h.handle));
  return d;
}

/** 플롯 설정(LAYOUT 앞부분, PLOTSETTINGS) */
function readPlotSettings(r: BitReader, ver: number): PlotSettings {
  const p = defaultPlotSettings();
  p.pageSetupName = r.TV();
  p.printerName = r.TV();
  p.flags = r.BS();
  p.margins = [r.BD(), r.BD(), r.BD(), r.BD()];
  p.paperWidth = r.BD();
  p.paperHeight = r.BD();
  p.paperName = r.TV();
  p.plotOrigin = r.BD2();
  p.paperUnits = r.BS();
  p.rotation = r.BS();
  p.plotType = r.BS();
  p.windowMin = r.BD2();
  p.windowMax = r.BD2();
  if (ver < R2004) r.T(); // 플롯 뷰 이름
  p.scaleNumerator = r.BD();
  p.scaleDenominator = r.BD();
  p.styleSheet = r.TV();
  p.standardScaleType = r.BS();
  r.BD(); // 축척 계수
  r.BD2(); // 용지 이미지 원점
  if (ver >= R2004) {
    r.BS();
    r.BS();
    r.BS();
  }
  return p;
}

export function readLayout(or: ObjectReader): LayoutRaw {
  or.commonObject();
  const r = or.dat;
  const ver = or.ver;
  const plot = readPlotSettings(r, ver);
  const name = r.TV();
  const tabOrder = r.BL();
  const flags = r.BS();
  const ucsOrigin = r.BD3();
  const limitsMin = r.RD2();
  const limitsMax = r.RD2();
  const insertionBase = r.BD3();
  const ucsXAxis = r.BD3();
  const ucsYAxis = r.BD3();
  const elevation = r.BD();
  r.BS();
  const extMin = r.BD3();
  const extMax = r.BD3();
  if (ver >= R2004) r.RL();
  const hr = or.hdl;
  const hb = or.h.handle;
  if (ver >= R2004) hr.H(hb); // 플롯 뷰
  if (ver >= R2007) hr.H(hb); // 시각 스타일
  const blockRecord = hr.H(hb);
  const viewport = hr.H(hb);
  return {
    handle: hb,
    name,
    tabOrder,
    flags,
    limitsMin,
    limitsMax,
    insertionBase,
    extMin,
    extMax,
    elevation,
    ucsOrigin,
    ucsXAxis,
    ucsYAxis,
    plot,
    blockRecord,
    viewport,
    owner: or.h.owner,
  };
}

export function readPlotSettingsObject(or: ObjectReader): CadObject {
  or.commonObject();
  const plot = readPlotSettings(or.dat, or.ver);
  return { ...base(or, 'PLOTSETTINGS'), plot } as CadObject;
}

export function readMLineStyle(or: ObjectReader): MLineStyleRaw {
  or.commonObject();
  const r = or.dat;
  const ver = or.ver;
  const name = r.TV();
  const description = r.TV();
  const f = r.BS();
  // DWG 비트 → DXF 비트
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
  let flags = 0;
  for (const [a, b] of map) if (f & a) flags |= b;
  const fillColor = cmcToCad(r.CMC());
  const startAngle = r.BD();
  const endAngle = r.BD();
  const n = r.RC();
  const elements: MLineStyleObject['elements'] = [];
  const ltRefs: { index: number; handle: number }[] = [];
  for (let i = 0; i < n; i++) {
    const offset = r.BD();
    const color = cmcToCad(r.CMC());
    let index = -1;
    let handle = 0;
    if (ver < R2018) index = r.BS();
    else handle = or.hdl.H(or.h.handle);
    elements.push({ offset, color, linetype: 'ByLayer' });
    ltRefs.push({ index, handle });
  }
  return { ...base(or, 'MLINESTYLE'), name, flags, description, fillColor, startAngle, endAngle, elements, ltRefs } as MLineStyleRaw;
}

export function readImageDef(or: ObjectReader): ImageDefObject {
  or.commonObject();
  const r = or.dat;
  r.BL();
  const imageSize = r.RD2();
  const fileName = r.TV();
  const loaded = r.B() === 1;
  const resolutionUnits = r.RC();
  const pixelSize = r.RD2();
  return { ...base(or, 'IMAGEDEF'), fileName, imageSize, pixelSize, loaded, resolutionUnits } as ImageDefObject;
}

export function readUnderlayDef(or: ObjectReader, type: UnderlayDefObject['type']): UnderlayDefObject {
  or.commonObject();
  const r = or.dat;
  const fileName = r.TV();
  const name = r.TV();
  return { ...base(or, type), fileName, name } as UnderlayDefObject;
}

export function readSortEnts(or: ObjectReader): SortEntsTableObject {
  or.commonObject();
  const r = or.dat;
  const n = r.checkCount(r.BL(), 8);
  const sorts: number[] = [];
  for (let i = 0; i < n; i++) sorts.push(r.H());
  const hr = or.hdl;
  const blockRecord = hex(hr.H(or.h.handle));
  const entries: SortEntsTableObject['entries'] = [];
  for (let i = 0; i < n; i++) entries.push({ entity: hex(hr.H(or.h.handle)), sort: hex(sorts[i]) });
  return { ...base(or, 'SORTENTSTABLE'), blockRecord, entries } as SortEntsTableObject;
}

export function readGroup(or: ObjectReader): GroupObject {
  or.commonObject();
  const r = or.dat;
  const description = r.TV();
  const unnamed = r.BS() !== 0;
  const selectable = r.BS() !== 0;
  const n = r.checkCount(r.BL(), 0);
  const hr = or.hdl;
  hr.checkCount(n, 8);
  const entities: string[] = [];
  for (let i = 0; i < n; i++) entities.push(hex(hr.H(or.h.handle)));
  return { ...base(or, 'GROUP'), description, unnamed, selectable, entities } as GroupObject;
}

export function readScale(or: ObjectReader): ScaleObject {
  or.commonObject();
  const r = or.dat;
  r.BS();
  const name = r.TV();
  const paperUnits = r.BD();
  const drawingUnits = r.BD();
  const unitScale = r.B() === 1;
  return { ...base(or, 'SCALE'), name, paperUnits, drawingUnits, unitScale } as ScaleObject;
}

export function readSpatialFilter(or: ObjectReader): SpatialFilterObject {
  or.commonObject();
  const r = or.dat;
  const n = r.checkCount(r.BS(), 128);
  const boundary: Vec2[] = [];
  for (let i = 0; i < n; i++) boundary.push(r.RD2());
  const normal = r.BD3();
  const origin = r.BD3();
  const displayBoundary = r.BS() !== 0;
  const o: SpatialFilterObject = {
    ...base(or, 'SPATIAL_FILTER'),
    boundary,
    normal,
    origin,
    displayBoundary,
    inverseBlockTransform: [],
    clipTransform: [],
  } as SpatialFilterObject;
  if (r.BS()) o.frontClip = r.BD();
  if (r.BS()) o.backClip = r.BD();
  for (let i = 0; i < 12; i++) o.inverseBlockTransform.push(r.BD());
  for (let i = 0; i < 12; i++) o.clipTransform.push(r.BD());
  return o;
}

/** isNewFormat: R2010+ 또는 ACAD_MLEADERVER 확장 자료가 있을 때(사양 20.4.87) */
export function readMLeaderStyle(or: ObjectReader, isNewFormat: boolean): MLeaderStyleObject {
  or.commonObject();
  const r = or.dat;
  const ver = or.ver;
  const hr = or.hdl;
  const hb = or.h.handle;
  if (ver >= R2010) r.BS();
  const contentType = r.BS();
  r.BS();
  r.BS();
  r.BL();
  r.BD();
  r.BD();
  const leaderLineType = r.BS();
  const leaderLineColor = cmcToCad(r.CMC());
  hr.H(hb); // 선종류
  const leaderLineWeight = lwRaw(r.BL());
  const landing = r.B() === 1;
  const landingGap = r.BD();
  r.B();
  const doglegLength = r.BD();
  const name = r.TV(); // 설명
  const arrow = hr.H(hb);
  const arrowSize = r.BD();
  r.TV(); // 기본 문자
  const textStyle = hr.H(hb);
  r.BS();
  r.BS();
  if (isNewFormat) r.BS(); // 문자 각도 종류
  r.BS();
  const textColor = cmcToCad(r.CMC());
  const textHeight = r.BD();
  r.B();
  if (isNewFormat) r.B(); // 항상 왼쪽 정렬
  r.BD();
  const block = hr.H(hb);
  r.CMC();
  r.BD3();
  r.B();
  r.BD();
  r.B();
  r.BS();
  const scale = r.BD();
  const o: MLeaderStyleObject = {
    ...base(or, 'MLEADERSTYLE'),
    name,
    contentType,
    leaderLineType,
    leaderLineColor,
    leaderLineWeight,
    landing,
    doglegLength,
    arrowSize,
    textHeight,
    textColor,
    landingGap,
    scale,
  } as MLeaderStyleObject;
  if (arrow) o.arrowHeadHandle = hex(arrow);
  if (textStyle) o.textStyleHandle = hex(textStyle);
  if (block) o.blockHandle = hex(block);
  return o;
}

function lwRaw(v: number): number {
  if (v === 29 || v === -1) return -1;
  if (v === 30 || v === -2) return -2;
  if (v === 31 || v === -3) return -3;
  return v;
}

/** XRECORD 자료: (RS 그룹 코드, 값) 쌍 */
export function readXRecord(or: ObjectReader): XRecordObject {
  or.commonObject();
  const r = or.dat;
  const ver = or.ver;
  const nbytes = r.BL();
  if (nbytes < 0 || nbytes * 8 > r.end - r.pos + 64) throw new DwgFormatError('XRECORD 크기가 잘못되었습니다');
  const end = r.pos + nbytes * 8;
  const data: RawTag[] = [];
  try {
    while (r.pos < end) {
      const code = r.RS();
      data.push({ code, value: readTagValue(r, code, ver) });
    }
  } catch {
    // 모르는 값 종류: 남은 자료는 버린다
  }
  r.pos = end;
  let cloning = 0;
  if (ver >= R2000) cloning = r.BS();
  return { ...base(or, 'XRECORD'), cloning, data } as XRecordObject;
}

/** DXF 그룹 코드 종류에 따라 값 읽기(XRECORD) */
function readTagValue(r: BitReader, code: number, ver: number): string | number {
  const strCode = (code >= 0 && code <= 9) || code === 100 || code === 102 || (code >= 300 && code <= 309) || (code >= 410 && code <= 419) || (code >= 430 && code <= 439) || (code >= 470 && code <= 479) || (code >= 999 && code <= 1009);
  if (strCode) {
    if (ver >= R2007) {
      const len = r.RSu();
      const codes: number[] = new Array(len);
      for (let i = 0; i < len; i++) codes[i] = r.RSu();
      return codesToString(codes, len);
    }
    const len = r.RSu();
    r.RC(); // 코드 페이지
    return r.bytesToString(len);
  }
  if ((code >= 10 && code <= 39) || (code >= 110 && code <= 139) || (code >= 210 && code <= 239) || (code >= 1010 && code <= 1039)) {
    // 점: X(그리고 Y·Z) — DWG는 10~18에 3RD를 둔다
    if ((code >= 10 && code <= 18) || (code >= 110 && code <= 112) || code === 210 || (code >= 1010 && code <= 1013)) {
      const x = r.RD();
      const y = r.RD();
      const z = r.RD();
      return `${x},${y},${z}`;
    }
    return r.RD();
  }
  if ((code >= 40 && code <= 59) || (code >= 140 && code <= 149) || (code >= 460 && code <= 469) || (code >= 1040 && code <= 1059)) return r.RD();
  if ((code >= 60 && code <= 79) || (code >= 170 && code <= 179) || (code >= 270 && code <= 289) || (code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 1060 && code <= 1070)) return r.RS();
  if ((code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 449) || code === 1071) return r.RL();
  if (code >= 160 && code <= 169) return r.RL() + r.RL() * 0x100000000;
  if (code >= 290 && code <= 299) return r.RC();
  if ((code >= 320 && code <= 369) || (code >= 390 && code <= 399) || (code >= 480 && code <= 481)) {
    // 핸들: 8바이트
    let v = 0;
    const bytes: number[] = [];
    for (let i = 0; i < 8; i++) bytes.push(r.RC());
    for (let i = 7; i >= 0; i--) v = v * 256 + bytes[i];
    return hex(v);
  }
  if (code === 310 || (code >= 1004 && code <= 1004)) {
    const len = r.RC();
    let s = '';
    for (let i = 0; i < len; i++) s += r.RC().toString(16).padStart(2, '0');
    return s.toUpperCase();
  }
  throw new DwgFormatError(`XRECORD 그룹 코드 ${code}`);
}

/** 해석하지 않는 객체 */
export function readGenericObject(or: ObjectReader): CadObject {
  or.commonObject();
  return base(or, or.h.typeName) as CadObject;
}

