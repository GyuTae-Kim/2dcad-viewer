/**
 * CLASSES 구역에 넣을 표준 클래스 정의(AutoCAD가 저장한 DXF에서 확인한 값).
 * 문서에 클래스 정보가 없는 객체 종류를 쓸 때 이 표에서 채운다.
 */
import type { CadClass } from '../../core/model';

const OBJECTDBX = 'ObjectDBX Classes';
const ISM = 'ISM';

/** [DXF 이름, C++ 클래스, 응용 프로그램, 프록시 플래그, 도형 여부] */
const DEFS: readonly (readonly [string, string, string, number, boolean])[] = [
  ['ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', OBJECTDBX, 0, false],
  ['ACDBPLACEHOLDER', 'AcDbPlaceHolder', OBJECTDBX, 0, false],
  ['LAYOUT', 'AcDbLayout', OBJECTDBX, 0, false],
  ['DICTIONARYVAR', 'AcDbDictionaryVar', OBJECTDBX, 0, false],
  ['TABLESTYLE', 'AcDbTableStyle', OBJECTDBX, 4095, false],
  ['MATERIAL', 'AcDbMaterial', OBJECTDBX, 1153, false],
  ['VISUALSTYLE', 'AcDbVisualStyle', OBJECTDBX, 4095, false],
  ['SCALE', 'AcDbScale', OBJECTDBX, 1153, false],
  ['MLEADERSTYLE', 'AcDbMLeaderStyle', 'ACDB_MLEADERSTYLE_CLASS', 4095, false],
  ['CELLSTYLEMAP', 'AcDbCellStyleMap', OBJECTDBX, 1152, false],
  ['SORTENTSTABLE', 'AcDbSortentsTable', OBJECTDBX, 0, false],
  ['SPATIAL_FILTER', 'AcDbSpatialFilter', OBJECTDBX, 0, false],
  ['SPATIAL_INDEX', 'AcDbSpatialIndex', OBJECTDBX, 0, false],
  ['LAYER_INDEX', 'AcDbLayerIndex', OBJECTDBX, 0, false],
  ['IDBUFFER', 'AcDbIdBuffer', OBJECTDBX, 0, false],
  ['PLOTSETTINGS', 'AcDbPlotSettings', OBJECTDBX, 0, false],
  ['DBCOLOR', 'AcDbColor', OBJECTDBX, 0, false],
  ['IMAGEDEF', 'AcDbRasterImageDef', ISM, 0, false],
  ['IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', ISM, 1, false],
  ['RASTERVARIABLES', 'AcDbRasterVariables', ISM, 0, false],
  ['IMAGE', 'AcDbRasterImage', ISM, 2175, true],
  ['WIPEOUT', 'AcDbWipeout', 'WipeOut|Product Desc: Object Enabler for WipeOut entity | Company: Autodesk, Inc. | WEB Address: www.autodesk.com', 2175, true],
  ['WIPEOUTVARIABLES', 'AcDbWipeoutVariables', 'WipeOut|Product Desc: WipeOut Dbx Application|Company: Autodesk, Inc.|WEB Address: www.autodesk.com', 0, false],
  ['MULTILEADER', 'AcDbMLeader', 'ACDB_MLEADER_CLASS', 1025, true],
  ['ACAD_TABLE', 'AcDbTable', OBJECTDBX, 1025, true],
  ['FIELD', 'AcDbField', OBJECTDBX, 1152, false],
  ['FIELDLIST', 'AcDbFieldList', OBJECTDBX, 1152, false],
  ['DIMASSOC', 'AcDbDimAssoc', '"AcDbDimAssoc|Product Desc:     AcDim ARX App For Dimension|Company:          Autodesk, Inc.|WEB Address:      www.autodesk.com"', 0, false],
  ['ACDB_TEXTOBJECTCONTEXTDATA_CLASS', 'AcDbTextObjectContextData', OBJECTDBX, 1153, false],
  ['ACDB_MTEXTOBJECTCONTEXTDATA_CLASS', 'AcDbMTextObjectContextData', OBJECTDBX, 1153, false],
  ['ACDB_BLKREFOBJECTCONTEXTDATA_CLASS', 'AcDbBlkRefObjectContextData', OBJECTDBX, 1153, false],
  ['ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS', 'AcDbMTextAttributeObjectContextData', OBJECTDBX, 1153, false],
  ['ACDB_BLOCKREPRESENTATION_DATA', 'AcDbBlockRepresentationData', OBJECTDBX, 1153, false],
  ['TABLECONTENT', 'AcDbTableContent', OBJECTDBX, 1152, false],
  ['TABLEGEOMETRY', 'AcDbTableGeometry', OBJECTDBX, 1152, false],
  ['MESH', 'AcDbSubDMesh', OBJECTDBX, 0, true],
  ['HELIX', 'AcDbHelix', OBJECTDBX, 4095, true],
  ['ARC_DIMENSION', 'AcDbArcDimension', OBJECTDBX, 1025, true],
  ['LARGE_RADIAL_DIMENSION', 'AcDbRadialDimensionLarge', OBJECTDBX, 1025, true],
  ['PDFUNDERLAY', 'AcDbPdfReference', OBJECTDBX, 4095, true],
  ['PDFDEFINITION', 'AcDbPdfDefinition', OBJECTDBX, 1153, false],
  ['DWFUNDERLAY', 'AcDbDwfReference', OBJECTDBX, 4095, true],
  ['DWFDEFINITION', 'AcDbDwfDefinition', OBJECTDBX, 1153, false],
  ['DGNUNDERLAY', 'AcDbDgnReference', OBJECTDBX, 4095, true],
  ['DGNDEFINITION', 'AcDbDgnDefinition', OBJECTDBX, 1153, false],
  [
    'MPOLYGON',
    'AcDbMPolygon',
    'AcMPolygonObj15|Version(1.0.0.0) Product Desc: Object enabler for the AcDbMPolyon entity | Company: Autodesk, Inc. | WEB Address: www.autodesk.com',
    3071,
    true,
  ],
];

export const STANDARD_CLASSES: ReadonlyMap<string, CadClass> = new Map(
  DEFS.map(([dxfName, cppName, appName, proxyFlags, isEntity]) => [
    dxfName,
    { dxfName, cppName, appName, proxyFlags, instanceCount: 0, wasProxy: false, isEntity },
  ]),
);
