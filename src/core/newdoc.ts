/**
 * 새 도면 서식. AutoCAD 기본 서식(acadiso.dwt = 미터, acad.dwt = 인치)과 같은 뼈대를 만든다.
 * - 도면층 0, 선종류 ByBlock·ByLayer·Continuous, 문자 스타일 Standard(Arial)
 * - 치수 스타일: 미터 ISO-25(현재) + Standard, 인치 Standard
 * - 다중선 스타일·다중 지시선 스타일·표 스타일 Standard, 축척 목록, 플롯 스타일 이름 사전(Normal)
 * - 모형 + Layout1 배치(블록 레코드·LAYOUT 객체·페이지 설정), *Active 뷰포트
 * 모든 표 항목·블록·객체에 핸들과 소유자를 붙이므로 DXF·DWG 쓰기가 그대로 쓸 수 있다.
 */
import type {
  BlockDef,
  BlockRecord,
  CadClass,
  CadDocument,
  CadObject,
  DictionaryObject,
  DimStyle,
  GenericObject,
  HeaderValue,
  Layer,
  Layout,
  LayoutObject,
  Linetype,
  MLeaderStyleObject,
  MLineStyleObject,
  PlotSettings,
  ScaleObject,
  TextStyle,
  VPortRecord,
} from './model';
import { createDocument, tableKey, v2, v3 } from './model';
import { finalizeDocument } from './finalize';
import { DEFAULT_HEADER, METRIC_HEADER } from '../io/dxf/headervars';
import { STANDARD_CLASSES } from '../io/dxf/classes';

export type NewDocumentUnits = 'metric' | 'imperial';

/** acad.dwt의 Standard 치수 스타일(인치) */
const STANDARD_DIM_IMPERIAL: Record<string, number | string> = {
  DIMPOST: '',
  DIMAPOST: '',
  DIMSCALE: 1,
  DIMASZ: 0.18,
  DIMEXO: 0.0625,
  DIMDLI: 0.38,
  DIMEXE: 0.18,
  DIMRND: 0,
  DIMDLE: 0,
  DIMTP: 0,
  DIMTM: 0,
  DIMFXL: 1,
  DIMJOGANG: Math.PI / 4,
  DIMTFILL: 0,
  DIMTFILLCLR: 0,
  DIMTOL: 0,
  DIMLIM: 0,
  DIMTIH: 1,
  DIMTOH: 1,
  DIMSE1: 0,
  DIMSE2: 0,
  DIMTAD: 0,
  DIMZIN: 0,
  DIMAZIN: 0,
  DIMARCSYM: 0,
  DIMTXT: 0.18,
  DIMCEN: 0.09,
  DIMTSZ: 0,
  DIMALTF: 25.4,
  DIMLFAC: 1,
  DIMTVP: 0,
  DIMTFAC: 1,
  DIMGAP: 0.09,
  DIMALTRND: 0,
  DIMALT: 0,
  DIMALTD: 2,
  DIMTOFL: 0,
  DIMSAH: 0,
  DIMTIX: 0,
  DIMSOXD: 0,
  DIMCLRD: 0,
  DIMCLRE: 0,
  DIMCLRT: 0,
  DIMADEC: 0,
  DIMDEC: 4,
  DIMTDEC: 4,
  DIMALTU: 2,
  DIMALTTD: 2,
  DIMAUNIT: 0,
  DIMFRAC: 0,
  DIMLUNIT: 2,
  DIMDSEP: 46,
  DIMTMOVE: 0,
  DIMJUST: 0,
  DIMSD1: 0,
  DIMSD2: 0,
  DIMTOLJ: 1,
  DIMTZIN: 0,
  DIMALTZ: 0,
  DIMALTTZ: 0,
  DIMUPT: 0,
  DIMATFIT: 3,
  DIMFXLON: 0,
  DIMTXTDIRECTION: 0,
  DIMALTMZF: 100,
  DIMALTMZS: '',
  DIMMZF: 100,
  DIMMZS: '',
  DIMLWD: -2,
  DIMLWE: -2,
  DIMTXSTY: 'Standard',
};

/** acadiso.dwt의 ISO-25(미터): Standard와 다른 값 */
const ISO25_DIM: Record<string, number | string> = {
  ...STANDARD_DIM_IMPERIAL,
  DIMASZ: 2.5,
  DIMEXO: 0.625,
  DIMDLI: 3.75,
  DIMEXE: 1.25,
  DIMTIH: 0,
  DIMTOH: 0,
  DIMTAD: 1,
  DIMZIN: 8,
  DIMTXT: 2.5,
  DIMCEN: 2.5,
  DIMALTF: 0.03937007874016,
  DIMGAP: 0.625,
  DIMALTD: 3,
  DIMTOFL: 1,
  DIMDEC: 2,
  DIMTDEC: 2,
  DIMALTTD: 3,
  DIMDSEP: 44,
  DIMTOLJ: 0,
  DIMTZIN: 8,
};

/** 축척 목록(ACAD_SCALELIST): [이름, 종이 단위, 도면 단위] */
const METRIC_SCALES: [string, number, number][] = [
  ['1:1', 1, 1],
  ['1:2', 1, 2],
  ['1:4', 1, 4],
  ['1:5', 1, 5],
  ['1:8', 1, 8],
  ['1:10', 1, 10],
  ['1:16', 1, 16],
  ['1:20', 1, 20],
  ['1:30', 1, 30],
  ['1:40', 1, 40],
  ['1:50', 1, 50],
  ['1:100', 1, 100],
  ['2:1', 2, 1],
  ['4:1', 4, 1],
  ['8:1', 8, 1],
  ['10:1', 10, 1],
  ['100:1', 100, 1],
];

const IMPERIAL_SCALES: [string, number, number][] = [
  ...METRIC_SCALES,
  ['1/128" = 1\'-0"', 0.0078125, 12],
  ['1/64" = 1\'-0"', 0.015625, 12],
  ['1/32" = 1\'-0"', 0.03125, 12],
  ['1/16" = 1\'-0"', 0.0625, 12],
  ['3/32" = 1\'-0"', 0.09375, 12],
  ['1/8" = 1\'-0"', 0.125, 12],
  ['3/16" = 1\'-0"', 0.1875, 12],
  ['1/4" = 1\'-0"', 0.25, 12],
  ['3/8" = 1\'-0"', 0.375, 12],
  ['1/2" = 1\'-0"', 0.5, 12],
  ['3/4" = 1\'-0"', 0.75, 12],
  ['1" = 1\'-0"', 1, 12],
  ['1-1/2" = 1\'-0"', 1.5, 12],
  ['3" = 1\'-0"', 3, 12],
  ['6" = 1\'-0"', 6, 12],
  ['1\'-0" = 1\'-0"', 12, 12],
];

/** 1970-01-01 기준 율리우스일 */
function julianNow(): number {
  return Date.now() / 86400000 + 2440587.5;
}

function plotSettings(metric: boolean, model: boolean): PlotSettings {
  // 미터: ISO A3(420 × 297 mm), 인치: ANSI A(11 × 8.5 in). 여백 없는 용지, 1:1.
  return {
    pageSetupName: '',
    printerName: 'none_device',
    paperName: metric ? 'ISO_full_bleed_A3_(420.00_x_297.00_MM)' : 'ANSI_full_bleed_A_(11.00_x_8.50_Inches)',
    paperWidth: metric ? 420 : 279.4,
    paperHeight: metric ? 297 : 215.9,
    margins: [0, 0, 0, 0],
    plotOrigin: v2(),
    windowMin: v2(),
    windowMax: v2(),
    scaleNumerator: 1,
    scaleDenominator: 1,
    // 16 표준 축척, 32 플롯 스타일, 128 선가중치 인쇄, 512 뷰포트 먼저, 1024 모형
    flags: model ? 1712 : 688,
    paperUnits: metric ? 1 : 0,
    rotation: 0,
    plotType: model ? 0 : 5,
    styleSheet: '',
    standardScaleType: model ? 0 : 16,
  };
}

/**
 * 빈 새 도면. 단위(metric = 밀리미터 acadiso.dwt, imperial = 인치 acad.dwt)에 맞는 기본값을 쓴다.
 * 반환한 문서는 finalizeDocument를 거쳤다.
 */
export function createNewDocument(units: NewDocumentUnits): CadDocument {
  const metric = units === 'metric';
  const doc = createDocument('new');
  doc.version = 'AC1032';
  doc.codepage = 'ANSI_1252';

  let seq = 0x10;
  const next = () => (seq++).toString(16).toUpperCase();

  // 표 머리: AutoCAD가 쓰는 관례 핸들
  const TH = { BLOCK_RECORD: '1', LAYER: '2', STYLE: '3', LTYPE: '5', VIEW: '6', UCS: '7', VPORT: '8', APPID: '9', DIMSTYLE: 'A' };
  doc.tableHeads = new Map(Object.entries(TH).map(([k, h]) => [k, { handle: h }]));
  const ROOT = 'C';
  doc.rootDictionary = ROOT;

  const objects: CadObject[] = [];
  const dict = (handle: string, owner: string, entries: [string, string][] = [], hardOwner = false): DictionaryObject => {
    const d: DictionaryObject = { type: 'DICTIONARY', handle, owner, entries: new Map(entries), hardOwner, cloning: 1 };
    if (owner !== '0') d.reactors = [owner];
    objects.push(d);
    return d;
  };

  // --- 표
  const placeholderH = next();
  const ltBlock: Linetype = { name: 'ByBlock', handle: next(), flags: 0, description: '', patternLength: 0, elements: [] };
  const ltLayer: Linetype = { name: 'ByLayer', handle: next(), flags: 0, description: '', patternLength: 0, elements: [] };
  const ltCont: Linetype = { name: 'Continuous', handle: next(), flags: 0, description: 'Solid line', patternLength: 0, elements: [] };
  for (const l of [ltBlock, ltLayer, ltCont]) doc.linetypes.set(tableKey(l.name), l);

  const layer0: Layer = {
    name: '0',
    handle: next(),
    flags: 0,
    color: { aci: 7 },
    off: false,
    frozen: false,
    locked: false,
    linetype: 'Continuous',
    lineweight: -3,
    plot: true,
    transparency: 255,
    plotStyle: placeholderH,
  };
  doc.layers.set('0', layer0);

  const standard: TextStyle = {
    name: 'Standard',
    handle: next(),
    flags: 0,
    height: 0,
    widthFactor: 1,
    oblique: 0,
    generation: 0,
    lastHeight: metric ? 2.5 : 0.2,
    font: 'arial.ttf',
    bigFont: '',
    fontFamily: 'Arial',
    fontFlags: 34,
    xdata: [
      {
        app: 'ACAD',
        items: [
          { code: 1000, value: 'Arial' },
          { code: 1071, value: 34 },
        ],
      },
    ],
  };
  doc.textStyles.set('STANDARD', standard);

  doc.appIds.set('ACAD', { name: 'ACAD', handle: next(), flags: 0 });

  const dimStandard: DimStyle = { name: 'Standard', handle: next(), flags: 0, vars: { ...STANDARD_DIM_IMPERIAL } };
  doc.dimStyles.set('STANDARD', dimStandard);
  if (metric) {
    const iso: DimStyle = { name: 'ISO-25', handle: next(), flags: 0, vars: { ...ISO25_DIM } };
    doc.dimStyles.set('ISO-25', iso);
  }

  const vport: VPortRecord = {
    name: '*Active',
    handle: next(),
    flags: 0,
    lowerLeft: v2(0, 0),
    upperRight: v2(1, 1),
    center: metric ? v2(210, 148.5) : v2(6, 4.5),
    snapBase: v2(),
    snapSpacing: metric ? v2(10, 10) : v2(0.5, 0.5),
    gridSpacing: metric ? v2(10, 10) : v2(0.5, 0.5),
    viewDirection: v3(0, 0, 1),
    viewTarget: v3(),
    height: metric ? 297 : 9,
    aspect: 1.7654784240150094,
    lensLength: 50,
    twist: 0,
  };
  doc.vports.push(vport);

  // --- 블록·배치
  const layoutDictH = next();
  const mkSpace = (name: string): { rec: BlockRecord; def: BlockDef } => {
    const rec: BlockRecord = { name, handle: next(), flags: 0, insertUnits: 0, explodable: true, scalable: false };
    const def: BlockDef = { name, handle: next(), recordHandle: rec.handle, basePoint: v3(), flags: 0, layer: '0', entities: [], endHandle: next() };
    doc.blockRecords.set(tableKey(name), rec);
    doc.blocks.set(tableKey(name), def);
    return { rec, def };
  };
  const model = mkSpace('*Model_Space');
  const paper = mkSpace('*Paper_Space');
  const mkLayout = (name: string, space: { rec: BlockRecord }, tabOrder: number): LayoutObject => {
    const isModel = tabOrder === 0;
    const l: Layout = {
      name,
      handle: next(),
      tabOrder,
      blockRecord: space.rec.handle,
      blockName: space.rec.name,
      flags: 1,
      limitsMin: v2(),
      limitsMax: isModel ? (metric ? v2(420, 297) : v2(12, 9)) : metric ? v2(420, 297) : v2(11, 8.5),
      insertionBase: v3(),
      extMin: v3(1e20, 1e20, 1e20),
      extMax: v3(-1e20, -1e20, -1e20),
      elevation: 0,
      ucsOrigin: v3(),
      ucsXAxis: v3(1, 0, 0),
      ucsYAxis: v3(0, 1, 0),
      plot: plotSettings(metric, isModel),
    };
    if (isModel) l.viewport = vport.handle;
    space.rec.layout = l.handle;
    doc.layouts.push(l);
    const o: LayoutObject = { type: 'LAYOUT', handle: l.handle, owner: layoutDictH, reactors: [layoutDictH], layout: l };
    return o;
  };
  const modelLayout = mkLayout('Model', model, 0);
  const paperLayout = mkLayout('Layout1', paper, 1);

  // --- 객체
  const groupH = next();
  const mlineDictH = next();
  const mlineStdH = next();
  const plotSetH = next();
  const plotStyleH = next();
  const mleaderDictH = next();
  const mleaderStdH = next();
  const tableDictH = next();
  const tableStdH = next();
  const scaleDictH = next();
  const scales = (metric ? METRIC_SCALES : IMPERIAL_SCALES).map((s, i) => ({ s, h: next(), key: `A${i}` }));

  dict(ROOT, '0', [
    ['ACAD_GROUP', groupH],
    ['ACAD_LAYOUT', layoutDictH],
    ['ACAD_MLEADERSTYLE', mleaderDictH],
    ['ACAD_MLINESTYLE', mlineDictH],
    ['ACAD_PLOTSETTINGS', plotSetH],
    ['ACAD_PLOTSTYLENAME', plotStyleH],
    ['ACAD_SCALELIST', scaleDictH],
    ['ACAD_TABLESTYLE', tableDictH],
  ]);
  dict(groupH, ROOT);
  dict(layoutDictH, ROOT, [
    ['Model', modelLayout.handle],
    ['Layout1', paperLayout.handle],
  ]);
  objects.push(modelLayout, paperLayout);
  dict(mlineDictH, ROOT, [['Standard', mlineStdH]]);
  const mlStyle: MLineStyleObject = {
    type: 'MLINESTYLE',
    handle: mlineStdH,
    owner: mlineDictH,
    reactors: [mlineDictH],
    name: 'Standard',
    flags: 0,
    description: '',
    fillColor: { aci: 256 },
    startAngle: Math.PI / 2,
    endAngle: Math.PI / 2,
    elements: [
      { offset: 0.5, color: { aci: 256 }, linetype: 'BYLAYER' },
      { offset: -0.5, color: { aci: 256 }, linetype: 'BYLAYER' },
    ],
  };
  objects.push(mlStyle);
  dict(plotSetH, ROOT);
  const psDict: DictionaryObject = {
    type: 'ACDBDICTIONARYWDFLT',
    handle: plotStyleH,
    owner: ROOT,
    reactors: [ROOT],
    entries: new Map([['Normal', placeholderH]]),
    hardOwner: false,
    cloning: 1,
    defaultHandle: placeholderH,
  };
  objects.push(psDict);
  objects.push({ type: 'ACDBPLACEHOLDER', handle: placeholderH, owner: plotStyleH, reactors: [plotStyleH] } as GenericObject);
  dict(mleaderDictH, ROOT, [['Standard', mleaderStdH]]);
  const mlead: MLeaderStyleObject = {
    type: 'MLEADERSTYLE',
    handle: mleaderStdH,
    owner: mleaderDictH,
    reactors: [mleaderDictH],
    name: 'Standard',
    contentType: 2,
    leaderLineType: 1,
    leaderLineColor: { aci: 0 },
    leaderLineWeight: -2,
    landing: true,
    doglegLength: metric ? 8 : 0.36,
    arrowSize: metric ? 4 : 0.18,
    textStyleHandle: standard.handle,
    textHeight: metric ? 4 : 0.18,
    textColor: { aci: 0 },
    landingGap: metric ? 2 : 0.09,
    scale: 1,
  };
  objects.push(mlead);
  dict(tableDictH, ROOT, [['Standard', tableStdH]]);
  // 표 스타일 내용은 쓰기가 버전에 맞게 만든다(원본 태그 없음).
  objects.push({ type: 'TABLESTYLE', handle: tableStdH, owner: tableDictH, reactors: [tableDictH] } as GenericObject);
  dict(
    scaleDictH,
    ROOT,
    scales.map((x) => [x.key, x.h]),
  );
  for (const { s, h } of scales) {
    const so: ScaleObject = { type: 'SCALE', handle: h, owner: scaleDictH, reactors: [scaleDictH], name: s[0], paperUnits: s[1], drawingUnits: s[2], unitScale: s[0] === '1:1' };
    objects.push(so);
  }
  for (const o of objects) doc.objects.set(o.handle, o);

  // --- 클래스(쓰는 객체 종류)
  const classes: CadClass[] = [];
  for (const name of ['ACDBDICTIONARYWDFLT', 'ACDBPLACEHOLDER', 'LAYOUT', 'TABLESTYLE', 'SCALE', 'MLEADERSTYLE']) {
    const c = STANDARD_CLASSES.get(name);
    if (c) classes.push({ ...c, instanceCount: [...doc.objects.values()].filter((o) => o.type === name).length });
  }
  doc.classes = classes;

  // --- 헤더
  const H = doc.header;
  for (const [k, v] of Object.entries(DEFAULT_HEADER)) H.set(k, cloneValue(v));
  if (metric) for (const [k, v] of Object.entries(METRIC_HEADER)) H.set(k, cloneValue(v));
  const now = julianNow();
  const set = (k: string, v: HeaderValue) => H.set(k, v);
  set('$ACADVER', 'AC1032');
  set('$DWGCODEPAGE', 'ANSI_1252');
  set('$INSUNITS', metric ? 4 : 1);
  set('$MEASUREMENT', metric ? 1 : 0);
  set('$LUNITS', 2);
  set('$LUPREC', 4);
  set('$LTSCALE', 1);
  set('$CELTSCALE', 1);
  set('$DIMSCALE', 1);
  set('$TEXTSIZE', metric ? 2.5 : 0.2);
  set('$TEXTSTYLE', 'Standard');
  set('$CLAYER', '0');
  set('$CELTYPE', 'ByLayer');
  set('$CECOLOR', 256);
  set('$CELWEIGHT', -1);
  set('$CMLSTYLE', 'Standard');
  set('$DIMSTYLE', metric ? 'ISO-25' : 'Standard');
  set('$DIMTXSTY', 'Standard');
  set('$LIMMIN', v2());
  set('$LIMMAX', metric ? v2(420, 297) : v2(12, 9));
  set('$PLIMMIN', v2());
  set('$PLIMMAX', metric ? v2(420, 297) : v2(11, 8.5));
  set('$EXTMIN', v3(1e20, 1e20, 1e20));
  set('$EXTMAX', v3(-1e20, -1e20, -1e20));
  set('$TDCREATE', now);
  set('$TDUCREATE', now);
  set('$TDUPDATE', now);
  set('$TDUUPDATE', now);
  set('$TDINDWG', 0);
  set('$TDUSRTIMER', 0);
  set('$HANDSEED', next());
  return finalizeDocument(doc);
}

function cloneValue(v: HeaderValue): HeaderValue {
  return typeof v === 'object' ? { ...v } : v;
}
