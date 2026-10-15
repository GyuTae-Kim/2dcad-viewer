/** AcDb:Classes 쓰기(사양 10장, classes.ts의 짝)와 클래스 번호 정하기 */
import type { CadClass } from '../../../core/model';
import { R2004, R2007 } from '../version';
import { BitWriter } from './bitwriter';
import type { TextEncoderCp } from './codepage';
import { wrapSection } from './header';

export const CLASSES_SENTINEL = [0x8d, 0xa1, 0xc4, 0xb8, 0xc4, 0xa9, 0xf8, 0xc5, 0xc0, 0xdc, 0xf4, 0x5f, 0xe7, 0xcf, 0xb6, 0x8a];
export const CLASSES_END_SENTINEL = [0x72, 0x5e, 0x3b, 0x47, 0x3b, 0x56, 0x07, 0x3a, 0x3f, 0x23, 0x0b, 0xa0, 0x18, 0x30, 0x49, 0x75];

/** 이름 → [C++ 이름, 앱 이름, 프록시 플래그, 도형인지, 만든 버전, 유지보수 버전] (AutoCAD 표본 값) */
const KNOWN: Record<string, [string, string, number, boolean, number, number]> = {
  ACDBDICTIONARYWDFLT: ['AcDbDictionaryWithDefault', 'ObjectDBX Classes', 0, false, 22, 42],
  ACDBPLACEHOLDER: ['AcDbPlaceHolder', 'ObjectDBX Classes', 0, false, 22, 42],
  LAYOUT: ['AcDbLayout', 'ObjectDBX Classes', 0, false, 22, 42],
  DICTIONARYVAR: ['AcDbDictionaryVar', 'ObjectDBX Classes', 0, false, 20, 0],
  TABLESTYLE: ['AcDbTableStyle', 'ObjectDBX Classes', 4095, false, 25, 20],
  MATERIAL: ['AcDbMaterial', 'ObjectDBX Classes', 1153, false, 23, 14],
  VISUALSTYLE: ['AcDbVisualStyle', 'ObjectDBX Classes', 4095, false, 26, 0],
  SCALE: ['AcDbScale', 'ObjectDBX Classes', 1153, false, 27, 1],
  MLEADERSTYLE: ['AcDbMLeaderStyle', 'ACDB_MLEADERSTYLE_CLASS', 4095, false, 33, 329],
  CELLSTYLEMAP: ['AcDbCellStyleMap', 'ObjectDBX Classes', 1152, false, 27, 1],
  MESH: ['AcDbSubDMesh', 'ObjectDBX Classes', 0, true, 29, 0],
  SORTENTSTABLE: ['AcDbSortentsTable', 'ObjectDBX Classes', 0, false, 20, 0],
  WIPEOUT: ['AcDbWipeout', 'WipeOut|Product Desc: Object Enabler for WipeOut entity | Company: Autodesk, Inc. | WEB Address: www.autodesk.com', 2175, true, 33, 329],
  WIPEOUTVARIABLES: ['AcDbWipeoutVariables', '"WipeOut|Product Desc:     WipeOut Dbx Application|Company:          Autodesk, Inc.|WEB Address:      www.autodesk.com"', 0, false, 25, 0],
  DIMASSOC: ['AcDbDimAssoc', '"AcDbDimAssoc|Product Desc:     AcDim ARX App For Dimension|Company:          Autodesk, Inc.|WEB Address:      www.autodesk.com"', 0, false, 23, 12],
  ACAD_TABLE: ['AcDbTable', 'ObjectDBX Classes', 1025, true, 25, 20],
  FIELD: ['AcDbField', 'ObjectDBX Classes', 1152, false, 25, 0],
  FIELDLIST: ['AcDbFieldList', 'ObjectDBX Classes', 1152, false, 25, 0],
  // 주석 축척 컨텍스트 데이터(표본: TEXT·BLKREF·MTEXTATTRIBUTE·ALDIM 모두 1153, 27/0 — 나머지도 같은 값으로)
  ACDB_TEXTOBJECTCONTEXTDATA_CLASS: ['AcDbTextObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_MTEXTOBJECTCONTEXTDATA_CLASS: ['AcDbMTextObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS: ['AcDbMTextAttributeObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_BLKREFOBJECTCONTEXTDATA_CLASS: ['AcDbBlkRefObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_ALDIMOBJECTCONTEXTDATA_CLASS: ['AcDbAlignedDimensionObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_ANGDIMOBJECTCONTEXTDATA_CLASS: ['AcDbAngularDimensionObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_RADIMOBJECTCONTEXTDATA_CLASS: ['AcDbRadialDimensionObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_DMDIMOBJECTCONTEXTDATA_CLASS: ['AcDbDiametricDimensionObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_ORDDIMOBJECTCONTEXTDATA_CLASS: ['AcDbOrdinateDimensionObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_RADIMLRGOBJECTCONTEXTDATA_CLASS: ['AcDbRadialDimensionLargeObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_HATCHSCALECONTEXTDATA_CLASS: ['AcDbHatchScaleContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_HATCHVIEWCONTEXTDATA_CLASS: ['AcDbHatchViewContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_MLEADEROBJECTCONTEXTDATA_CLASS: ['AcDbMLeaderObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  ACDB_LEADEROBJECTCONTEXTDATA_CLASS: ['AcDbLeaderObjectContextData', 'ObjectDBX Classes', 1153, false, 27, 0],
  TABLECONTENT: ['AcDbTableContent', 'ObjectDBX Classes', 1152, false, 25, 21],
  TABLEGEOMETRY: ['AcDbTableGeometry', 'ObjectDBX Classes', 1152, false, 27, 1],
  MULTILEADER: ['AcDbMLeader', 'ACDB_MLEADER_CLASS', 1025, true, 33, 329],
  RASTERVARIABLES: ['AcDbRasterVariables', 'ISM', 0, false, 20, 0],
  IMAGEDEF: ['AcDbRasterImageDef', 'ISM', 0, false, 20, 0],
  IMAGEDEF_REACTOR: ['AcDbRasterImageDefReactor', 'ISM', 1, false, 20, 0],
  IMAGE: ['AcDbRasterImage', 'ISM', 2175, true, 20, 0],
  DBCOLOR: ['AcDbColor', 'ObjectDBX Classes', 0, false, 23, 14],
  PDFDEFINITION: ['AcDbPdfDefinition', 'ObjectDBX Classes', 1153, false, 26, 0],
  PDFUNDERLAY: ['AcDbPdfReference', 'ObjectDBX Classes', 4095, true, 26, 0],
  DWFDEFINITION: ['AcDbDwfDefinition', 'ObjectDBX Classes', 1153, false, 25, 0],
  DWFUNDERLAY: ['AcDbDwfReference', 'ObjectDBX Classes', 4095, true, 25, 0],
  DGNDEFINITION: ['AcDbDgnDefinition', 'ObjectDBX Classes', 1153, false, 26, 0],
  DGNUNDERLAY: ['AcDbDgnReference', 'ObjectDBX Classes', 4095, true, 26, 0],
  SPATIAL_FILTER: ['AcDbSpatialFilter', 'ObjectDBX Classes', 0, false, 20, 0],
  PLOTSETTINGS: ['AcDbPlotSettings', 'ObjectDBX Classes', 0, false, 22, 42],
  ARC_DIMENSION: ['AcDbArcDimension', 'ObjectDBX Classes', 1025, true, 25, 0],
  LARGE_RADIAL_DIMENSION: ['AcDbRadialDimensionLarge', 'ObjectDBX Classes', 1025, true, 25, 0],
  HELIX: ['AcDbHelix', 'ObjectDBX Classes', 4095, true, 27, 0],
  PLANESURFACE: ['AcDbPlaneSurface', 'ObjectDBX Classes', 4095, true, 26, 0],
  EXTRUDEDSURFACE: ['AcDbExtrudedSurface', 'ObjectDBX Classes', 4095, true, 26, 0],
  LOFTEDSURFACE: ['AcDbLoftedSurface', 'ObjectDBX Classes', 0, true, 26, 0],
  REVOLVEDSURFACE: ['AcDbRevolvedSurface', 'ObjectDBX Classes', 0, true, 26, 0],
  SWEPTSURFACE: ['AcDbSweptSurface', 'ObjectDBX Classes', 0, true, 26, 0],
  NURBSURFACE: ['AcDbNurbSurface', 'ObjectDBX Classes', 4095, true, 27, 0],
  // 동적 블록 객체(AutoCAD 표본 sample_AC1018·AC1032와 서식 도면의 클래스 목록 값)
  ACAD_EVALUATION_GRAPH: ['AcDbEvalGraph', 'ObjectDBX Classes', 1153, false, 25, 55],
  ACDB_BLOCKREPRESENTATION_DATA: ['AcDbBlockRepresentationData', 'ObjectDBX Classes', 1153, false, 25, 58],
  ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION: ['AcDbDynamicBlockPurgePreventer', 'ObjectDBX Classes', 1153, false, 25, 61],
  BLOCKGRIPLOCATIONCOMPONENT: ['AcDbBlockGripExpr', 'ObjectDBX Classes', 1153, false, 25, 20],
  BLOCKVISIBILITYPARAMETER: ['AcDbBlockVisibilityParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKVISIBILITYGRIP: ['AcDbBlockVisibilityGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKLINEARPARAMETER: ['AcDbBlockLinearParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKLINEARGRIP: ['AcDbBlockLinearGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKSCALEACTION: ['AcDbBlockScaleAction', 'ObjectDBX Classes', 1153, false, 25, 55],
  // (AutoCAD 예제 도면·공개 짝 도면의 클래스 목록 값: 모두 1153, 25/55)
  BLOCKFLIPPARAMETER: ['AcDbBlockFlipParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKROTATIONPARAMETER: ['AcDbBlockRotationParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKXYPARAMETER: ['AcDbBlockXYParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKPOLARPARAMETER: ['AcDbBlockPolarParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKPOINTPARAMETER: ['AcDbBlockPointParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKLOOKUPPARAMETER: ['AcDbBlockLookupParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKBASEPOINTPARAMETER: ['AcDbBlockBasepointParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKALIGNMENTPARAMETER: ['AcDbBlockAlignmentParameter', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKFLIPGRIP: ['AcDbBlockFlipGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKROTATIONGRIP: ['AcDbBlockRotationGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKXYGRIP: ['AcDbBlockXYGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKPOLARGRIP: ['AcDbBlockPolarGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKLOOKUPGRIP: ['AcDbBlockLookupGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKALIGNMENTGRIP: ['AcDbBlockAlignmentGrip', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKMOVEACTION: ['AcDbBlockMoveAction', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKSTRETCHACTION: ['AcDbBlockStretchAction', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKROTATEACTION: ['AcDbBlockRotateAction', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKFLIPACTION: ['AcDbBlockFlipAction', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKARRAYACTION: ['AcDbBlockArrayAction', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKLOOKUPACTION: ['AcDbBlockLookupAction', 'ObjectDBX Classes', 1153, false, 25, 55],
  BLOCKPOLARSTRETCHACTION: ['AcDbBlockPolarStretchAction', 'ObjectDBX Classes', 1153, false, 25, 55],
};

export interface WClass {
  number: number;
  dxfName: string;
  cppName: string;
  appName: string;
  proxyFlags: number;
  wasProxy: boolean;
  isEntity: boolean;
  instanceCount: number;
  dwgVer: number;
  maintVer: number;
}

/** 쓸 클래스 목록. 요청한 순서대로 500부터 번호를 준다. */
export class ClassTable {
  readonly list: WClass[] = [];
  private readonly byName = new Map<string, WClass>();
  private readonly docClasses = new Map<string, CadClass>();

  constructor(docClasses: CadClass[]) {
    for (const c of docClasses) if (c.dxfName && !this.docClasses.has(c.dxfName.toUpperCase())) this.docClasses.set(c.dxfName.toUpperCase(), c);
    // 문서의 클래스 순서(번호)를 그대로 둔다
    const sorted = [...this.docClasses.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    for (const c of sorted) this.declare(c.dxfName);
  }

  /** 문서나 내장 표에서 정의를 찾을 수 있는지 */
  known(dxfName: string): boolean {
    const k = dxfName.toUpperCase();
    return this.docClasses.has(k) || k in KNOWN;
  }

  /** 클래스 번호(없으면 만든다). isEntity는 정의를 모를 때만 쓴다 */
  number(dxfName: string, isEntity = false): number {
    const k = dxfName.toUpperCase();
    let c = this.byName.get(k);
    if (!c) {
      const d = this.docClasses.get(k);
      const kn = KNOWN[k];
      c = {
        number: 500 + this.list.length,
        dxfName: d?.dxfName ?? dxfName,
        cppName: d?.cppName || kn?.[0] || `AcDb${dxfName}`,
        appName: d?.appName || kn?.[1] || 'ObjectDBX Classes',
        proxyFlags: d?.proxyFlags ?? kn?.[2] ?? 0,
        wasProxy: d?.wasProxy ?? false,
        isEntity: d?.isEntity ?? kn?.[3] ?? isEntity,
        instanceCount: 0,
        dwgVer: kn?.[4] ?? 0,
        maintVer: kn?.[5] ?? 0,
      };
      this.list.push(c);
      this.byName.set(k, c);
    }
    c.instanceCount++;
    return c.number;
  }

  /** 개수를 세지 않고 클래스를 목록에만 넣는다 */
  declare(dxfName: string): void {
    const k = dxfName.toUpperCase();
    if (this.byName.has(k)) return;
    this.number(dxfName);
    this.byName.get(k)!.instanceCount--;
  }
}

export function writeClasses(ver: number, maintVer: number, enc: TextEncoderCp, classes: WClass[]): Uint8Array {
  const dat = new BitWriter(ver, enc, 4096);
  const str = new BitWriter(ver, enc, 2048);
  if (ver >= R2007) dat.strWriter = str;
  let rlPos = -1;
  if (ver >= R2007) {
    rlPos = dat.pos;
    dat.RL(0);
  }
  if (ver >= R2004) {
    dat.BS(classes.length ? 500 + classes.length - 1 : 499);
    dat.RC(0);
    dat.RC(0);
    dat.B(1);
  }
  for (const c of classes) {
    dat.BS(c.number);
    dat.BS(c.proxyFlags & 0xffff);
    dat.TV(c.appName);
    dat.TV(c.cppName);
    dat.TV(c.dxfName);
    dat.B(c.wasProxy);
    dat.BS(c.isEntity ? 0x1f2 : 0x1f3);
    if (ver >= R2004) {
      dat.BL(Math.max(0, c.instanceCount));
      dat.BL(c.dwgVer);
      dat.BL(c.maintVer);
      dat.BL(0);
      dat.BL(0);
    }
  }
  if (ver >= R2007) {
    const sb = str.pos;
    if (sb > 0) {
      dat.appendBits(str, sb);
      if (sb < 0x8000) dat.RS(sb);
      else {
        dat.RS(sb >>> 15);
        dat.RS((sb & 0x7fff) | 0x8000);
      }
      dat.B(1);
    } else dat.B(0);
    dat.patchRL(rlPos, dat.pos);
  }
  return wrapSection(ver, maintVer, dat.bytes(), CLASSES_SENTINEL, CLASSES_END_SENTINEL);
}
