/**
 * 컨텍스트 데이터(객체별 축척 표현) 읽기·만들기.
 *
 * 구조(AutoCAD 실물): 객체의 확장 사전(280 = 1, 281 = 1) → `AcDbContextDataManager`(360) → DICTIONARY(281 = 1)
 * → `ACDB_ANNOTATIONSCALES`(350) → DICTIONARY(281 = 1) → 키 `*A1`, `*A2` …(350) → 컨텍스트 데이터 객체
 * (소유자·반응자 = 그 사전).
 *
 * 레코드 원시 태그(DXF 그룹 = DWG 비트 순서): `100 AcDbObjectContextData`, `70 판`(AC1024+ 4, 그 전 3), `290 기본`,
 * `100 AcDbAnnotScaleObjectContextData`, `340 축척`, 그 뒤 종류별 필드.
 * - TEXT: 70 수평 정렬, 50 회전(도), 10·20 첫 점, 11·21 정렬점
 * - MTEXTATTRIBUTE(속성): TEXT의 필드 + 290 여러 줄(1이면 `101 Embedded Object`와 포함 MTEXT 레코드가 따른다 — 읽기만)
 * - BLKREF(블록 참조): 50 회전(도), 10·20·30 삽입점, 41·42·43 축척(예전 빌드의 42·43·44는 읽기만)
 * - MTEXT: 70 부착점, 10 X축 방향, 11 위치, 40 폭, 41 정의 높이, 42·43 문자 범위, 71 열 종류(열이 있으면 72·44·45·73·74,
 *   동적 열이고 자동 높이가 아니면 열마다 46 높이). AutoCAD는 정의 높이가 없는 MTEXT에도 71 = 2(동적), 72 = 1을 쓴다.
 * - 치수(ALDIM 등): `100 AcDbDimensionObjectContextData`, 2 그 축척의 익명 블록 이름, 293, 10·20 문자 위치, 294 기본 자리,
 *   140 문자 회전(라디안), 298·291·70·292·71·280·295(뜻을 모르는 값 — 다시 쓸 때 이어받는다), 296·297 화살표 뒤집기,
 *   종류 표지 뒤 종류별 점 11(·12·13)
 * - HATCHSCALE: `100 AcDbHatchObjectContextData`, 78 패턴 선 수, 선마다 53·43·44·45·46·79·49…, 40 배율, 10 패턴 방향,
 *   90 루프 수, 루프마다 90 종류·290 1
 * - HATCHVIEW(관리자의 ACDB_ANNOTATIONSCALE_VIEW_COLLECTION, 축척 레코드마다 하나): HATCHSCALE의 필드(40 = 1, 10 = 0 벡터),
 *   `100 AcDbHatchViewContextData`, 330 뷰포트(0), 10 시선(0, 0, 1), 51 비틀림 0, 290 0
 * - MLEADER: 다중 지시선 컨텍스트 자료(mlctx.ts)
 * DWG 비트 배치는 src/io/dwg/ctxcodec.ts.
 * 객체 자체 데이터는 기본 레코드(290 = 1)의 축척 표현이다(TEXT 레코드에는 높이가 없다: 높이 = 용지 높이 × 배율).
 */
import type { CadDocument, DictionaryObject, DimensionEntity, Entity, GenericObject, HatchPatternLine, MLeaderEntity, RawTag, Vec2, Vec3 } from '../../core/model';
import { mleaderContextFromTags, mleaderContextTags } from './mlctx';
import type { EditOp } from '../session';
import { changed, dictOf, entryOf, newDict, pendingObject, setDictEntries, upper } from './scales';

export const MANAGER_KEY = 'AcDbContextDataManager';
export const SCALES_KEY = 'ACDB_ANNOTATIONSCALES';

export type RecordKind = 'text' | 'attrib' | 'blkref' | 'mtext' | 'dim' | 'hatch' | 'mleader' | 'leader' | 'other';

export const CLASS_TEXT = 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS';
export const CLASS_ATTRIB = 'ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS';
export const CLASS_BLKREF = 'ACDB_BLKREFOBJECTCONTEXTDATA_CLASS';
export const CLASS_MTEXT = 'ACDB_MTEXTOBJECTCONTEXTDATA_CLASS';
export const CLASS_HATCH = 'ACDB_HATCHSCALECONTEXTDATA_CLASS';
export const CLASS_HATCHVIEW = 'ACDB_HATCHVIEWCONTEXTDATA_CLASS';
export const CLASS_MLEADER = 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS';
/** 해치의 뷰포트별 표현 모음(관리자 사전의 둘째 항목) */
export const VIEWS_KEY = 'ACDB_ANNOTATIONSCALE_VIEW_COLLECTION';

/** 치수 레코드 클래스 → DXF 종류 표지와 점 코드 */
export const DIM_CLASSES: Readonly<Record<string, { marker: string; points: number[] }>> = {
  ACDB_ALDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbAlignedDimensionObjectContextData', points: [11] },
  ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbAngularDimensionObjectContextData', points: [11] },
  ACDB_RADIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbRadialDimensionObjectContextData', points: [11] },
  ACDB_DMDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbDiametricDimensionObjectContextData', points: [11, 12] },
  ACDB_ORDDIMOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbOrdinateDimensionObjectContextData', points: [11, 12] },
  ACDB_RADIMLRGOBJECTCONTEXTDATA_CLASS: { marker: 'AcDbRadialDimensionLargeObjectContextData', points: [11, 12, 13] },
};

/** 컨텍스트 데이터 클래스(DXF 이름) → 종류 */
export function recordKind(type: string): RecordKind | null {
  const t = type.toUpperCase();
  if (!/CONTEXTDATA_CLASS$/.test(t)) return null;
  if (t === CLASS_TEXT) return 'text';
  if (t === CLASS_ATTRIB) return 'attrib';
  if (t === CLASS_BLKREF) return 'blkref';
  if (t === CLASS_MTEXT) return 'mtext';
  if (/^ACDB_(ALDIM|ANGDIM|RADIM|DMDIM|ORDDIM|RADIMLRG)OBJECTCONTEXTDATA_CLASS$/.test(t)) return 'dim';
  if (t === 'ACDB_HATCHSCALECONTEXTDATA_CLASS') return 'hatch';
  if (t === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS') return 'mleader';
  if (t === 'ACDB_LEADEROBJECTCONTEXTDATA_CLASS') return 'leader';
  return 'other';
}

/** C++ 클래스 이름(CLASSES 구역) */
export const CLASS_CPP: Readonly<Record<string, string>> = {
  [CLASS_TEXT]: 'AcDbTextObjectContextData',
  [CLASS_ATTRIB]: 'AcDbMTextAttributeObjectContextData',
  [CLASS_BLKREF]: 'AcDbBlkRefObjectContextData',
  [CLASS_MTEXT]: 'AcDbMTextObjectContextData',
  ACDB_ALDIMOBJECTCONTEXTDATA_CLASS: 'AcDbAlignedDimensionObjectContextData',
  ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS: 'AcDbAngularDimensionObjectContextData',
  ACDB_RADIMOBJECTCONTEXTDATA_CLASS: 'AcDbRadialDimensionObjectContextData',
  ACDB_DMDIMOBJECTCONTEXTDATA_CLASS: 'AcDbDiametricDimensionObjectContextData',
  ACDB_ORDDIMOBJECTCONTEXTDATA_CLASS: 'AcDbOrdinateDimensionObjectContextData',
  ACDB_RADIMLRGOBJECTCONTEXTDATA_CLASS: 'AcDbRadialDimensionLargeObjectContextData',
  [CLASS_HATCH]: 'AcDbHatchScaleContextData',
  [CLASS_HATCHVIEW]: 'AcDbHatchViewContextData',
  [CLASS_MLEADER]: 'AcDbMLeaderObjectContextData',
};

export interface ContextRecord {
  handle: string;
  /** 사전 키(*A1 …) */
  key: string;
  type: string;
  kind: RecordKind;
  /** 축척 핸들(대문자) */
  scale: string;
  isDefault: boolean;
  raw: RawTag[];
  /** 340 뒤의 태그 */
  body: RawTag[];
  obj: GenericObject;
}

export interface ContextChain {
  xdict: DictionaryObject | null;
  manager: DictionaryObject | null;
  scales: DictionaryObject | null;
}

/** 객체의 확장 사전 → 관리자 → 축척 사전 */
export function contextChain(doc: CadDocument, e: { xdict?: string }): ContextChain {
  const xdict = dictOf(doc, e.xdict);
  const manager = dictOf(doc, entryOf(xdict, MANAGER_KEY));
  const scales = dictOf(doc, entryOf(manager, SCALES_KEY));
  return { xdict, manager, scales };
}

const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

/** 레코드 원시 태그 풀기(축척 340이 없으면 null) */
export function parseRecord(o: GenericObject, key = ''): ContextRecord | null {
  const kind = recordKind(o.type);
  if (!kind || !o.raw?.length) return null;
  const raw = o.raw;
  let i340 = -1;
  let isDefault = false;
  let marks = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (t.code === 100) marks++;
    if (t.code === 290 && marks <= 1) isDefault = num(t.value) === 1;
    if (t.code === 340) {
      i340 = i;
      break;
    }
  }
  if (i340 < 0) return null;
  const scale = upper(String(raw[i340]!.value));
  if (!scale) return null;
  return { handle: upper(o.handle), key, type: o.type.toUpperCase(), kind, scale, isDefault, raw, body: raw.slice(i340 + 1), obj: o };
}

/** 객체의 컨텍스트 레코드(축척 사전 순서). 원시 태그가 없는 레코드(DWG 리더가 아직 풀지 않은 것)는 뺀다 */
export function contextRecords(doc: CadDocument, e: { xdict?: string }): ContextRecord[] {
  const { scales } = contextChain(doc, e);
  if (!scales) return [];
  const out: ContextRecord[] = [];
  for (const [k, h] of scales.entries) {
    const o = doc.objects.get(upper(h));
    if (!o) continue;
    const r = parseRecord(o as GenericObject, k);
    if (r) out.push(r);
  }
  return out;
}

/** 축척 사전에 항목이 있는지(원시 태그가 없는 레코드 포함) */
export function hasRecordEntries(doc: CadDocument, e: { xdict?: string }): boolean {
  const { scales } = contextChain(doc, e);
  return !!scales && scales.entries.size > 0;
}

// ---------------------------------------------------------------------------
// 종류별 필드
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** body에서 그룹 코드 c의 첫 값 */
function first(body: readonly RawTag[], c: number): string | number | undefined {
  return body.find((t) => t.code === c)?.value;
}

export interface TextFields {
  halign: number;
  /** 라디안 */
  rotation: number;
  insert: Vec2;
  align: Vec2;
  /** 속성: 여러 줄(1이면 이 모듈은 다루지 않는다) */
  multiline?: boolean;
}

export function textFields(r: ContextRecord): TextFields | null {
  const b = r.body;
  if (!b.some((t) => t.code === 10)) return null;
  const mlTag = r.kind === 'attrib' ? b.find((t, i) => t.code === 290 && i > 0) : undefined;
  return {
    halign: num(first(b, 70)),
    rotation: num(first(b, 50)) * DEG,
    insert: { x: num(first(b, 10)), y: num(first(b, 20)) },
    align: { x: num(first(b, 11)), y: num(first(b, 21)) },
    multiline: mlTag ? num(mlTag.value) === 1 : undefined,
  };
}

export interface BlkFields {
  rotation: number;
  insert: Vec3;
  scale: Vec3;
}

export function blkFields(r: ContextRecord): BlkFields | null {
  const b = r.body;
  if (!b.some((t) => t.code === 10)) return null;
  // 실물 꼴은 41·42·43, 예전 빌드가 쓰던 꼴은 42·43·44
  const legacy = !b.some((t) => t.code === 41) && b.some((t) => t.code === 44);
  const [cx, cy, cz] = legacy ? [42, 43, 44] : [41, 42, 43];
  return {
    rotation: num(first(b, 50)) * DEG,
    insert: { x: num(first(b, 10)), y: num(first(b, 20)), z: num(first(b, 30)) },
    scale: { x: num(first(b, cx), 1) || 1, y: num(first(b, cy), 1) || 1, z: num(first(b, cz), 1) || 1 },
  };
}

export interface MTextFields {
  attachment: number;
  direction: Vec3;
  insert: Vec3;
  width: number;
  rectHeight: number;
  extWidth: number;
  extHeight: number;
  columnType: number;
  columnCount?: number;
  columnWidth?: number;
  gutter?: number;
  autoHeight?: boolean;
  flowReversed?: boolean;
  /** 동적 열(2)이고 자동 높이가 아닐 때 열마다 높이(46) */
  columnHeights?: number[];
}

export function mtextFields(r: ContextRecord): MTextFields | null {
  const b = r.body;
  if (!b.some((t) => t.code === 11)) return null;
  const f: MTextFields = {
    attachment: num(first(b, 70), 1) || 1,
    direction: { x: num(first(b, 10), 1), y: num(first(b, 20)), z: num(first(b, 30)) },
    insert: { x: num(first(b, 11)), y: num(first(b, 21)), z: num(first(b, 31)) },
    width: num(first(b, 40)),
    rectHeight: num(first(b, 41)),
    extWidth: num(first(b, 42)),
    extHeight: num(first(b, 43)),
    columnType: num(first(b, 71)),
  };
  if (f.columnType) {
    f.columnCount = num(first(b, 72));
    f.columnWidth = num(first(b, 44));
    f.gutter = num(first(b, 45));
    f.autoHeight = num(first(b, 73)) === 1;
    f.flowReversed = num(first(b, 74)) === 1;
    // 포함 MTEXT 레코드(여러 줄 속성)가 없는 꼴이므로 74 다음의 46만 높이다
    const i74 = b.findIndex((t) => t.code === 74);
    if (i74 >= 0) {
      const hs: number[] = [];
      for (let i = i74 + 1; i < b.length && b[i]!.code === 46; i++) hs.push(num(b[i]!.value));
      if (hs.length) f.columnHeights = hs;
    }
  }
  return f;
}

export interface DimFields {
  textPos: Vec2;
  textRotation: number;
  block: string;
  textDefault: boolean;
  /** 296·297 화살표 뒤집기 */
  flip1?: boolean;
  flip2?: boolean;
  /** 뜻을 모르는 값(DIM_FLAG_CODES 순서) */
  flags?: number[];
  /** 종류 표지 뒤의 점(11·12·13 순서) */
  points?: Vec3[];
}

/**
 * 치수 레코드의 뜻을 모르는 값(DXF 그룹 순서 — DWG에서는 B 여섯, RC 280, B 295의 15비트). 공개 도면의 AutoCAD 레코드에는
 * 71 = 1·280 = 16인 것이 있다. 새 레코드는 0(AutoCAD가 만든 치수 레코드 대부분과 같다), 다시 쓰는 레코드는 그 값을 이어받는다.
 */
export const DIM_FLAG_CODES = [293, 298, 291, 70, 292, 71, 280, 295] as const;

export function dimFields(r: ContextRecord): DimFields | null {
  const b = r.body;
  const block = first(b, 2);
  const out: DimFields = {
    textPos: { x: num(first(b, 10)), y: num(first(b, 20)) },
    textRotation: num(first(b, 140)),
    block: block === undefined ? '' : String(block).trim(),
    textDefault: num(first(b, 294)) === 1,
    flip1: num(first(b, 296)) === 1,
    flip2: num(first(b, 297)) === 1,
  };
  // 표지(AcDbDimensionObjectContextData) 다음 태그의 값(70은 앞 머리의 판과 겹치므로 표지 뒤에서 찾는다)
  const im0 = b.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbDimensionObjectContextData');
  if (im0 >= 0) {
    const tail = b.slice(im0 + 1);
    const end = tail.findIndex((t) => t.code === 100);
    const part = end >= 0 ? tail.slice(0, end) : tail;
    out.flags = DIM_FLAG_CODES.map((c) => num(first(part, c)));
  }
  const spec = DIM_CLASSES[r.type];
  const im = spec ? b.findIndex((t) => t.code === 100 && String(t.value).trim() === spec.marker) : -1;
  if (spec && im >= 0) {
    const rest = b.slice(im + 1);
    out.points = spec.points.map((c) => ({ x: num(first(rest, c)), y: num(first(rest, c + 10)), z: num(first(rest, c + 20)) }));
  }
  return out;
}

/** 치수 종류 → 레코드 클래스 */
export function dimClassOf(d: DimensionEntity): string {
  if (d.subtype === 'ARC_DIMENSION') return 'ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS';
  if (d.subtype === 'LARGE_RADIAL_DIMENSION') return 'ACDB_RADIMLRGOBJECTCONTEXTDATA_CLASS';
  switch (d.dimType & 7) {
    case 2:
    case 5:
      return 'ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS';
    case 3:
      return 'ACDB_DMDIMOBJECTCONTEXTDATA_CLASS';
    case 4:
      return 'ACDB_RADIMOBJECTCONTEXTDATA_CLASS';
    case 6:
      return 'ACDB_ORDDIMOBJECTCONTEXTDATA_CLASS';
    default:
      return 'ACDB_ALDIMOBJECTCONTEXTDATA_CLASS';
  }
}

/**
 * 레코드의 종류별 점 ↔ 치수의 정의점(기능 명세 annotation-scale.md 6.1): ALDIM 11 = 10(치수선 점), ANGDIM 11 = 2선 각도 16·
 * 3점 각도·호 길이 10, RADIM 11 = 15, DMDIM 11·12 = 15·10, ORDDIM 11·12 = 10·14, RADIMLRG 11·12·13 = 15·13·14.
 */
type DimPointKey = 'defPoint' | 'defPoint2' | 'defPoint3' | 'defPoint4' | 'defPoint5';
function dimPointKeys(d: DimensionEntity, cls: string): DimPointKey[] {
  switch (cls) {
    case 'ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS':
      return [!d.subtype && (d.dimType & 7) === 2 ? 'defPoint5' : 'defPoint'];
    case 'ACDB_RADIMOBJECTCONTEXTDATA_CLASS':
      return ['defPoint4'];
    case 'ACDB_DMDIMOBJECTCONTEXTDATA_CLASS':
      return ['defPoint4', 'defPoint'];
    case 'ACDB_ORDDIMOBJECTCONTEXTDATA_CLASS':
      return ['defPoint', 'defPoint3'];
    case 'ACDB_RADIMLRGOBJECTCONTEXTDATA_CLASS':
      return ['defPoint4', 'defPoint2', 'defPoint3'];
    default:
      return ['defPoint'];
  }
}

/** 치수의 레코드 점 */
export function dimPointsOf(d: DimensionEntity, cls = dimClassOf(d)): Vec3[] {
  return dimPointKeys(d, cls).map((k) => ({ ...d[k] }));
}

/** 레코드의 점을 치수에 넣은 것 */
export function withDimPoints(d: DimensionEntity, cls: string, pts: readonly Vec3[]): DimensionEntity {
  const out = { ...d };
  dimPointKeys(d, cls).forEach((k, i) => {
    if (pts[i]) out[k] = { ...pts[i]! };
  });
  return out;
}

/** 다중 지시선 레코드의 컨텍스트 자료 */
export function mleaderFields(r: ContextRecord): MLeaderEntity['context'] | null {
  return mleaderContextFromTags(r.body);
}

export interface HatchFields {
  lines: HatchPatternLine[];
  factor: number;
}

/** 해치 레코드의 패턴 선(53·43·44·45·46·79·49…) */
export function hatchFields(r: ContextRecord): HatchFields | null {
  const b = r.body;
  const i78 = b.findIndex((t) => t.code === 78);
  if (i78 < 0) return null;
  const n = num(b[i78]!.value);
  const lines: HatchPatternLine[] = [];
  let i = i78 + 1;
  for (let k = 0; k < n && i < b.length; k++) {
    const take = (c: number): number => {
      while (i < b.length && b[i]!.code !== c) i++;
      return i < b.length ? num(b[i++]!.value) : 0;
    };
    const angle = take(53) * DEG;
    const bx = take(43);
    const by = take(44);
    const ox = take(45);
    const oy = take(46);
    const nd = take(79);
    const dashes: number[] = [];
    for (let d = 0; d < nd; d++) dashes.push(take(49));
    lines.push({ angle, base: { x: bx, y: by }, offset: { x: ox, y: oy }, dashes });
  }
  const f40 = b.slice(i).find((t) => t.code === 40);
  return { lines, factor: num(f40?.value, 1) || 1 };
}

// ---------------------------------------------------------------------------
// 레코드 만들기
// ---------------------------------------------------------------------------

/** 클래스 판(70): AC1024 이상 4, 그 전 3 */
export function classVersion(doc: CadDocument): number {
  return doc.version >= 'AC1024' ? 4 : 3;
}

function head(ver: number, isDefault: boolean, scale: string): RawTag[] {
  return [
    { code: 100, value: 'AcDbObjectContextData' },
    { code: 70, value: ver },
    { code: 290, value: isDefault ? 1 : 0 },
    { code: 100, value: 'AcDbAnnotScaleObjectContextData' },
    { code: 340, value: scale },
  ];
}

const deg = (r: number): number => {
  let d = (r / DEG) % 360;
  if (d < 0) d += 360;
  return Math.abs(d) < 1e-12 ? 0 : d;
};

export function textRecordRaw(ver: number, isDefault: boolean, scale: string, f: TextFields, attrib = false): RawTag[] {
  const out = [
    ...head(ver, isDefault, scale),
    { code: 70, value: f.halign },
    { code: 50, value: deg(f.rotation) },
    { code: 10, value: f.insert.x },
    { code: 20, value: f.insert.y },
    { code: 11, value: f.align.x },
    { code: 21, value: f.align.y },
  ];
  if (attrib) out.push({ code: 290, value: 0 });
  return out;
}

export function blkRecordRaw(ver: number, isDefault: boolean, scale: string, f: BlkFields): RawTag[] {
  return [
    ...head(ver, isDefault, scale),
    { code: 50, value: deg(f.rotation) },
    { code: 10, value: f.insert.x },
    { code: 20, value: f.insert.y },
    { code: 30, value: f.insert.z },
    { code: 41, value: f.scale.x },
    { code: 42, value: f.scale.y },
    { code: 43, value: f.scale.z },
  ];
}

export function mtextRecordRaw(ver: number, isDefault: boolean, scale: string, f: MTextFields): RawTag[] {
  const out: RawTag[] = [
    ...head(ver, isDefault, scale),
    { code: 70, value: f.attachment },
    { code: 10, value: f.direction.x },
    { code: 20, value: f.direction.y },
    { code: 30, value: f.direction.z },
    { code: 11, value: f.insert.x },
    { code: 21, value: f.insert.y },
    { code: 31, value: f.insert.z },
    { code: 40, value: f.width },
    { code: 41, value: f.rectHeight },
    { code: 42, value: f.extWidth },
    { code: 43, value: f.extHeight },
    { code: 71, value: f.columnType },
  ];
  if (f.columnType) {
    const n = f.columnCount ?? 0;
    out.push({ code: 72, value: n }, { code: 44, value: f.columnWidth ?? 0 }, { code: 45, value: f.gutter ?? 0 }, { code: 73, value: f.autoHeight ? 1 : 0 }, { code: 74, value: f.flowReversed ? 1 : 0 });
    if (f.columnType === 2 && !f.autoHeight) for (let k = 0; k < n; k++) out.push({ code: 46, value: f.columnHeights?.[k] ?? 0 });
  }
  return out;
}

export interface DimRecord {
  block: string;
  textPos: Vec2;
  textDefault: boolean;
  textRotation: number;
  flip1?: boolean;
  flip2?: boolean;
  /** 뜻을 모르는 값(DIM_FLAG_CODES 순서, 없으면 0) */
  flags?: readonly number[];
  points: Vec3[];
}

export function dimRecordRaw(ver: number, isDefault: boolean, scale: string, cls: string, f: DimRecord): RawTag[] {
  const spec = DIM_CLASSES[cls] ?? DIM_CLASSES.ACDB_ALDIMOBJECTCONTEXTDATA_CLASS!;
  const flag = (k: number): number => f.flags?.[k] ?? 0;
  const out: RawTag[] = [
    ...head(ver, isDefault, scale),
    { code: 100, value: 'AcDbDimensionObjectContextData' },
    { code: 2, value: f.block },
    { code: 293, value: flag(0) },
    { code: 10, value: f.textPos.x },
    { code: 20, value: f.textPos.y },
    { code: 294, value: f.textDefault ? 1 : 0 },
    { code: 140, value: f.textRotation },
    ...DIM_FLAG_CODES.slice(1).map((code, k) => ({ code, value: flag(k + 1) })),
    { code: 296, value: f.flip1 ? 1 : 0 },
    { code: 297, value: f.flip2 ? 1 : 0 },
    { code: 100, value: spec.marker },
  ];
  spec.points.forEach((c, i) => {
    const p = f.points[i] ?? { x: 0, y: 0, z: 0 };
    out.push({ code: c, value: p.x }, { code: c + 10, value: p.y }, { code: c + 20, value: p.z });
  });
  return out;
}

export interface HatchRecord {
  lines: readonly HatchPatternLine[];
  /** 그 축척의 배율(도면 단위 ÷ 용지 단위) */
  factor: number;
  /** 패턴 각도(라디안) — 레코드의 10은 이 각도의 단위 벡터 */
  angle: number;
  /** 루프마다 종류(경계 플래그에서 폴리선 비트 2를 뺀 것) */
  loops: number[];
}

/** 해치 루프 종류: AutoCAD는 폴리선 비트(2)를 쓰지 않는다 */
export function hatchLoopKind(flags: number): number {
  return flags & ~2;
}

export function hatchRecordRaw(ver: number, isDefault: boolean, scale: string, f: HatchRecord): RawTag[] {
  const out: RawTag[] = [...head(ver, isDefault, scale), { code: 100, value: 'AcDbHatchObjectContextData' }, { code: 78, value: f.lines.length }];
  for (const l of f.lines) {
    out.push({ code: 53, value: deg(l.angle) }, { code: 43, value: l.base.x }, { code: 44, value: l.base.y }, { code: 45, value: l.offset.x }, { code: 46, value: l.offset.y }, { code: 79, value: l.dashes.length });
    for (const d of l.dashes) out.push({ code: 49, value: d });
  }
  const c = Math.cos(f.angle);
  const n = Math.sin(f.angle);
  out.push({ code: 40, value: f.factor }, { code: 10, value: Math.abs(c) < 1e-15 ? 0 : c }, { code: 20, value: Math.abs(n) < 1e-15 ? 0 : n }, { code: 30, value: 0 }, { code: 90, value: f.loops.length });
  for (const k of f.loops) out.push({ code: 90, value: k }, { code: 290, value: 1 });
  return out;
}

export function mleaderRecordRaw(ver: number, isDefault: boolean, scale: string, ctx: MLeaderEntity['context']): RawTag[] {
  return [...head(ver, isDefault, scale), ...mleaderContextTags(ctx)];
}

/** 레코드의 기본 표지(290)·축척(340)을 바꾼 원시 태그 */
export function retagRecord(raw: readonly RawTag[], isDefault: boolean): RawTag[] {
  let marks = 0;
  let done = false;
  return raw.map((t) => {
    if (t.code === 100) marks++;
    if (!done && t.code === 290 && marks <= 1) {
      done = true;
      return { code: 290, value: isDefault ? 1 : 0 };
    }
    return t;
  });
}

/** 해치 레코드의 패턴 선을 바꾼 원시 태그(78부터 선 끝까지를 바꾼다) */
export function hatchRecordWithLines(raw: readonly RawTag[], lines: readonly HatchPatternLine[]): RawTag[] {
  const i340 = raw.findIndex((t) => t.code === 340);
  const i78 = raw.findIndex((t, i) => i > i340 && t.code === 78);
  if (i78 < 0) return [...raw];
  const n = num(raw[i78]!.value);
  // 옛 선 영역의 끝: n개 선의 태그를 건너뛴다
  let i = i78 + 1;
  for (let k = 0; k < n && i < raw.length; k++) {
    const skip = (c: number) => {
      while (i < raw.length && raw[i]!.code !== c) i++;
      if (i < raw.length) i++;
    };
    for (const c of [53, 43, 44, 45, 46]) skip(c);
    while (i < raw.length && raw[i]!.code !== 79) i++;
    const nd = i < raw.length ? num(raw[i]!.value) : 0;
    if (i < raw.length) i++;
    for (let d = 0; d < nd; d++) skip(49);
  }
  const lineTags: RawTag[] = [{ code: 78, value: lines.length }];
  for (const l of lines) {
    lineTags.push({ code: 53, value: deg(l.angle) }, { code: 43, value: l.base.x }, { code: 44, value: l.base.y }, { code: 45, value: l.offset.x }, { code: 46, value: l.offset.y }, { code: 79, value: l.dashes.length });
    for (const d of l.dashes) lineTags.push({ code: 49, value: d });
  }
  return [...raw.slice(0, i78), ...lineTags, ...raw.slice(i)];
}

/** 치수 레코드의 문자 위치(10·20)·회전(140)을 바꾼 원시 태그 */
export function dimRecordWith(raw: readonly RawTag[], textPos: Vec2, textRotation?: number): RawTag[] {
  const i340 = raw.findIndex((t) => t.code === 340);
  let did10 = false;
  let did20 = false;
  let did140 = false;
  return raw.map((t, i) => {
    if (i <= i340) return t;
    if (t.code === 10 && !did10) {
      did10 = true;
      return { code: 10, value: textPos.x };
    }
    if (t.code === 20 && !did20) {
      did20 = true;
      return { code: 20, value: textPos.y };
    }
    if (t.code === 140 && !did140 && textRotation !== undefined) {
      did140 = true;
      return { code: 140, value: textRotation };
    }
    return t;
  });
}

// ---------------------------------------------------------------------------
// 사전 사슬과 레코드를 만드는 편집
// ---------------------------------------------------------------------------

export interface ChainOps {
  /** 객체에 새로 붙여야 하는 확장 사전 핸들(이미 있으면 undefined) */
  newXdict?: string;
  scales: DictionaryObject;
}

/**
 * 객체에 확장 사전 → 관리자 → 축척 사전을 마련한다(없는 것만 만든다).
 * 확장 사전이 없으면 새 핸들을 newXdict로 돌려준다(객체에 붙이는 편집은 부르는 쪽이 한다).
 */
export function ensureChain(doc: CadDocument, e: Entity, alloc: () => string, ops: EditOp[]): ChainOps {
  let xdictH = e.xdict ? upper(e.xdict) : '';
  let newXdict: string | undefined;
  let xdict = xdictH ? pendingObject<DictionaryObject>(doc, ops, xdictH) : null;
  if (!xdict) {
    xdictH = alloc();
    newXdict = xdictH;
    xdict = { type: 'DICTIONARY', handle: xdictH, owner: upper(e.handle), entries: new Map(), hardOwner: true, cloning: 1 };
    ops.push({ kind: 'object', key: xdictH, before: null, after: xdict });
  }
  let mgrH = entryOf(xdict, MANAGER_KEY);
  let mgr = mgrH ? pendingObject<DictionaryObject>(doc, ops, mgrH) : null;
  if (!mgr) {
    mgrH = alloc();
    mgr = newDict(mgrH, xdictH);
    ops.push({ kind: 'object', key: mgrH, before: null, after: mgr });
    setDictEntries(doc, ops, xdict, [...xdict.entries, [MANAGER_KEY, mgrH]]);
  }
  let scH = entryOf(mgr, SCALES_KEY);
  let sc = scH ? pendingObject<DictionaryObject>(doc, ops, scH) : null;
  if (!sc) {
    scH = alloc();
    sc = newDict(scH, mgrH!);
    ops.push({ kind: 'object', key: scH, before: null, after: sc });
    setDictEntries(doc, ops, mgr, [...mgr.entries, [SCALES_KEY, scH]]);
  }
  return { newXdict, scales: sc };
}

/** 다음 레코드 키(*A1 …, 지운 번호는 다시 쓰지 않는다) */
export function nextRecordKey(d: DictionaryObject): string {
  let max = 0;
  for (const k of d.entries.keys()) {
    const m = /^\*A(\d+)$/i.exec(k);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `*A${max + 1}`;
}

/** 축척 사전에 레코드를 더한다 */
export function addRecordOps(doc: CadDocument, scales: DictionaryObject, type: string, raw: RawTag[], alloc: () => string, ops: EditOp[]): GenericObject {
  const cur = pendingObject<DictionaryObject>(doc, ops, scales.handle) ?? scales;
  const h = alloc();
  const o: GenericObject = { type, handle: h, owner: upper(cur.handle), reactors: [upper(cur.handle)], raw };
  ops.push({ kind: 'object', key: h, before: null, after: o });
  setDictEntries(doc, ops, cur, [...cur.entries, [nextRecordKey(cur), h]]);
  return o;
}

/** 레코드를 지운다(축척 사전 항목도) */
export function removeRecordOps(doc: CadDocument, scales: DictionaryObject, rec: ContextRecord, ops: EditOp[]): void {
  const cur = pendingObject<DictionaryObject>(doc, ops, scales.handle) ?? scales;
  ops.push({ kind: 'object', key: rec.handle, before: rec.obj, after: null });
  setDictEntries(
    doc,
    ops,
    cur,
    [...cur.entries].filter(([, h]) => upper(h) !== rec.handle),
  );
}

/** 레코드의 원시 태그를 바꾼다 */
export function rewriteRecordOps(doc: CadDocument, rec: ContextRecord, raw: RawTag[], ops: EditOp[]): void {
  const cur = pendingObject<GenericObject>(doc, ops, rec.handle) ?? rec.obj;
  ops.push({ kind: 'object', key: rec.handle, before: cur, after: changed(cur, { raw }) });
}

/** 같은 변경(ops) 뒤의 사전(사전이 아니거나 없으면 null) */
function pendingDict(doc: CadDocument, ops: readonly EditOp[], h: string | undefined): DictionaryObject | null {
  const o = h ? pendingObject<DictionaryObject>(doc, ops, h) : null;
  return o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') ? o : null;
}

/**
 * 해치 축척 레코드 → 그 축척의 뷰포트별 표현(HATCHVIEW) 원시 태그. AutoCAD가 주석 해치마다 만드는 꼴(공개 도면 DWG의 레코드,
 * 기능 명세 annotation-scale.md 6.1): 축척·기본 표지·패턴 선·루프는 축척 레코드와 같고 40 = 1, 10 = 0 벡터, 그 뒤
 * `100 AcDbHatchViewContextData`, 330 뷰포트 0, 10 시선 (0, 0, 1), 51 비틀림 0, 290 0. 해치 레코드가 아니면 null.
 */
export function hatchViewRaw(scaleRaw: readonly RawTag[]): RawTag[] | null {
  const im = scaleRaw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbHatchObjectContextData');
  const i78 = scaleRaw.findIndex((t, i) => i > im && t.code === 78);
  if (im < 0 || i78 < 0) return null;
  // 패턴 선 뒤(40·10·20·30)를 찾는다
  const n = num(scaleRaw[i78]!.value);
  let i = i78 + 1;
  for (let k = 0; k < n && i < scaleRaw.length; k++) {
    for (const c of [53, 43, 44, 45, 46]) if (scaleRaw[i]?.code === c) i++;
    const nd = scaleRaw[i]?.code === 79 ? num(scaleRaw[i++]!.value) : 0;
    for (let d = 0; d < nd && scaleRaw[i]?.code === 49; d++) i++;
  }
  if (scaleRaw[i]?.code !== 40) return null;
  const out = scaleRaw.map((t) => ({ ...t }));
  out[i] = { code: 40, value: 1 };
  for (let j = i + 1; j < i + 4 && j < out.length; j++) if ([10, 20, 30].includes(out[j]!.code)) out[j] = { code: out[j]!.code, value: 0 };
  out.push(
    { code: 100, value: 'AcDbHatchViewContextData' },
    { code: 330, value: '0' },
    { code: 10, value: 0 },
    { code: 20, value: 0 },
    { code: 30, value: 1 },
    { code: 51, value: 0 },
    { code: 290, value: 0 },
  );
  return out;
}

/**
 * 해치의 뷰포트별 표현 모음(ACDB_ANNOTATIONSCALE_VIEW_COLLECTION)을 지금(같은 변경 ops 뒤) 축척 레코드에 맞춰 다시 만든다:
 * 옛 모음과 그 레코드를 지우고, 축척 레코드마다 HATCHVIEW 하나(hatchViewRaw)를 키 *A1…로 둔 새 모음을 관리자 사전의
 * ACDB_ANNOTATIONSCALES 앞에 둔다(AutoCAD의 사전 순서 — 대소문자를 무시하면 `_`가 `S`보다 앞이다). 축척 레코드가 없으면 지우기만.
 * 한 변경에서 객체마다 한 번만 부른다.
 */
export function syncHatchViewsOps(doc: CadDocument, e: { xdict?: string }, alloc: () => string, ops: EditOp[]): void {
  if (!e.xdict) return;
  removeViewCollectionOps(doc, e, ops);
  const xdict = pendingDict(doc, ops, e.xdict);
  const mgrH = entryOf(xdict, MANAGER_KEY);
  const mgr = pendingDict(doc, ops, mgrH);
  const sc = pendingDict(doc, ops, entryOf(mgr, SCALES_KEY));
  if (!mgr || !sc) return;
  const views: RawTag[][] = [];
  for (const h of sc.entries.values()) {
    const o = pendingObject<GenericObject>(doc, ops, h);
    if (!o || o.type.toUpperCase() !== CLASS_HATCH || !o.raw) continue;
    const v = hatchViewRaw(o.raw);
    if (v) views.push(v);
  }
  if (!views.length) return;
  const vh = alloc();
  const entries: [string, string][] = views.map((raw, k) => {
    const rh = alloc();
    ops.push({ kind: 'object', key: rh, before: null, after: { type: CLASS_HATCHVIEW, handle: rh, owner: vh, reactors: [vh], raw } as GenericObject });
    return [`*A${k + 1}`, rh];
  });
  ops.push({ kind: 'object', key: vh, before: null, after: newDict(vh, upper(mgr.handle), entries) });
  const rest = [...mgr.entries].filter(([k]) => k.toUpperCase() !== VIEWS_KEY);
  const at = rest.findIndex(([k]) => k.toUpperCase() === SCALES_KEY);
  rest.splice(at < 0 ? rest.length : at, 0, [VIEWS_KEY, vh]);
  setDictEntries(doc, ops, mgr, rest);
}

/**
 * 해치의 뷰포트별 표현 모음(ACDB_ANNOTATIONSCALE_VIEW_COLLECTION)을 지운다(주석 아님으로 바꿀 때, 그리고 다시 만들기 전에).
 */
export function removeViewCollectionOps(doc: CadDocument, e: { xdict?: string }, ops: EditOp[]): void {
  const mgr = pendingDict(doc, ops, entryOf(pendingDict(doc, ops, e.xdict), MANAGER_KEY));
  const vh = entryOf(mgr, VIEWS_KEY);
  if (!mgr || !vh) return;
  const views = pendingDict(doc, ops, vh);
  if (views) {
    for (const h of views.entries.values()) {
      const o = pendingObject(doc, ops, h);
      if (o) ops.push({ kind: 'object', key: upper(h), before: o, after: null });
    }
    ops.push({ kind: 'object', key: upper(vh), before: views, after: null });
  }
  setDictEntries(
    doc,
    ops,
    mgr,
    [...mgr.entries].filter(([k]) => k.toUpperCase() !== VIEWS_KEY),
  );
}
