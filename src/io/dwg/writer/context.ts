/**
 * DWG 쓰기 준비: 무엇을 어떤 핸들로 쓸지 먼저 정한다(문서는 바꾸지 않는다).
 * - 문서의 핸들을 그대로 쓰고, 없거나 겹치는 것만 가장 큰 핸들 뒤에서 새로 준다.
 * - DWG에 꼭 있어야 하는데 모델에 없는 것(표 제어 객체, 블록 레코드·BLOCK·ENDBLK, 정점·SEQEND,
 *   필수 표 항목, 루트 사전과 필수 사전, 배치, 다중선 스타일 Standard, 플롯 스타일 Normal)을 만든다.
 * - 쓸 객체의 핸들을 live에 모은다. 다른 객체를 가리키는 핸들은 live에 있을 때만 쓴다.
 */
import type {
  BlockDef,
  BlockRecord,
  CadColor,
  CadDocument,
  CadObject,
  DictionaryObject,
  DimStyle,
  DwgRawBody,
  Entity,
  GenericObject,
  Layer,
  Layout,
  LayoutObject,
  Linetype,
  MLineStyleObject,
  ReadWarning,
  TableRecordBase,
  TextStyle,
  UcsRecord,
  ViewRecord,
  VPortRecord,
  XData,
  XRecordObject,
} from '../../../core/model';
import { MODEL_SPACE, PAPER_SPACE, tableKey } from '../../../core/model';
import { defaultLayout } from '../../../core/finalize';
import { DIM_VAR_DEFAULTS } from '../../../core/dimvars';
import { dwgCodepageName } from '../../../core/codepage';
import { fingerprint } from '../rawbody';
import { R2004, R2007, R2018 } from '../version';
import { ClassTable } from './classes';
import { type TextEncoderCp, encoderFor } from './codepage';
import { parseHandle, warnOnce } from './util';
import { DYN_TYPES } from '../dyncodec';
import { rawObjectOk } from './rawobjects';

export type TableName = 'BLOCK_RECORD' | 'LAYER' | 'STYLE' | 'LTYPE' | 'VIEW' | 'UCS' | 'VPORT' | 'APPID' | 'DIMSTYLE' | 'VPENT';

export interface PRec<T> {
  rec: T;
  h: number;
}

export interface PEnt {
  e: Entity;
  h: number;
  /** 원본 본문을 그대로 쓴다 */
  raw?: DwgRawBody;
  /** ACAD_TABLE을 블록 참조로 바꿔 쓴다(행·열이 없는 표) */
  asInsert?: boolean;
  /** ACAD_TABLE을 모델 값으로 쓴다(R2010+ 새 배치, 그 전 옛 배치) */
  table?: boolean;
  /** MPOLYGON을 HATCH로 쓴다 */
  asHatch?: boolean;
  /** POLYLINE 정점 핸들, INSERT 속성 핸들 */
  subs?: number[];
  seqend?: number;
}

export interface PBlock {
  key: string;
  name: string;
  def: BlockDef;
  rec: BlockRecord;
  recH: number;
  beginH: number;
  endH: number;
  /** 도형의 entmode: 2 모형, 1 활성 종이 공간, 0 그 밖의 블록 */
  mode: number;
  layoutH: number;
  ents: PEnt[];
}

export interface PObj {
  o: CadObject;
  h: number;
  raw?: DwgRawBody;
}

export interface PLayout {
  lay: Layout;
  h: number;
  /** 원래 LAYOUT 객체(확장 사전·반응자) */
  obj?: LayoutObject;
}

/** 원본 본문만 있으면 쓸 수 있는 도형 */
const RAW_ONLY_ENTITIES = new Set(['UNKNOWN', 'REGION', '3DSOLID', 'BODY', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSURFACE', 'OLE2FRAME', 'OLEFRAME']);

/** 모델 값으로 쓸 수 있는 객체 */
const NATIVE_OBJECTS = new Set([
  'DICTIONARY',
  'ACDBDICTIONARYWDFLT',
  'PLOTSETTINGS',
  'MLINESTYLE',
  'IMAGEDEF',
  'PDFDEFINITION',
  'DWFDEFINITION',
  'DGNDEFINITION',
  'SORTENTSTABLE',
  'GROUP',
  'XRECORD',
  'SPATIAL_FILTER',
  'MLEADERSTYLE',
  'SCALE',
  'DBCOLOR',
  'DICTIONARYVAR',
  'ACDBPLACEHOLDER',
  'IMAGEDEF_REACTOR',
  'RASTERVARIABLES',
  'WIPEOUTVARIABLES',
  'FIELD',
  'FIELDLIST',
  'DIMASSOC',
  'ACDB_TEXTOBJECTCONTEXTDATA_CLASS',
  'TABLESTYLE',
  ...DYN_TYPES,
]);

/** 원본 본문이 없으면 조용히 빼는 객체: 표 내용·형상·셀 스타일 지도는 DXF·옛 버전의 왕복 보조 자료이고
 *  표(ACAD_TABLE)와 테이블 스타일을 모델 값으로 쓰면 필요 없다(AutoCAD R2018 DWG도 표마다 두지 않는다) */
const SILENT_OBJECTS = new Set(['TABLECONTENT', 'TABLEGEOMETRY', 'CELLSTYLEMAP']);

/** 코드 페이지 이름 → DWG 번호 */
export function codepageNumber(name: string): number {
  const n = name.trim().toUpperCase().replace(/-/g, '_');
  for (let i = 0; i < 64; i++) if (dwgCodepageName(i) === n) return i;
  return 30;
}

const isPaperName = (k: string): boolean => /^\*PAPER_SPACE/.test(k);

/** 코드 페이지 후보(번호): 한·일·중·대만, 키릴, 중유럽, 그리스, 터키, 히브리, 아랍, 발트, 태국, 베트남 */
const CP_CANDIDATES = [40, 38, 39, 41, 29, 28, 32, 33, 34, 35, 36, 37, 44];

/** 문서 문자열을 가장 많이 담을 수 있는 코드 페이지 번호 */
function chooseCodepage(doc: CadDocument, cur: number): number {
  const chars = new Set<number>();
  let budget = 400000;
  const add = (s: unknown) => {
    if (typeof s !== 'string' || budget <= 0) return;
    budget -= s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x80) chars.add(c);
    }
  };
  for (const m of [doc.layers, doc.linetypes, doc.textStyles, doc.dimStyles, doc.views, doc.ucs, doc.appIds, doc.blockRecords]) for (const r of m.values()) add(r.name);
  for (const l of doc.layouts) add(l.name);
  for (const b of doc.blocks.values()) {
    add(b.name);
    for (const e of b.entities) {
      const x = e as { text?: unknown; tag?: unknown; prompt?: unknown; attribs?: { text: string; tag: string }[] };
      add(x.text);
      add(x.tag);
      add(x.prompt);
      if (x.attribs) for (const a of x.attribs) {
        add(a.text);
        add(a.tag);
      }
    }
  }
  // 동적 블록 객체의 이름·레이블·상태 이름(원본 태그)과 그 캐시(XRECORD)의 문자열
  for (const o of doc.objects.values()) {
    const tags = DYN_TYPES.has(o.type) ? (o as GenericObject).raw : o.type === 'XRECORD' ? (o as XRecordObject).data : undefined;
    if (tags) for (const t of tags) if ((t.code >= 1 && t.code <= 9) || (t.code >= 300 && t.code <= 309)) add(t.value);
  }
  if (!chars.size) return cur;
  const score = (n: number) => {
    const enc = encoderFor(dwgCodepageName(n));
    let k = 0;
    for (const c of chars) if (enc.canEncode(c)) k++;
    return k;
  };
  let best = cur;
  let bestScore = score(cur);
  if (bestScore === chars.size) return cur;
  for (const n of CP_CANDIDATES) {
    const sc = score(n);
    if (sc > bestScore) {
      best = n;
      bestScore = sc;
    }
  }
  return best;
}

export class WCtx {
  readonly ver: number;
  readonly verStr: string;
  readonly doc: CadDocument;
  readonly warnings: ReadWarning[];
  readonly enc: TextEncoderCp;
  readonly cpNum: number;
  readonly classes: ClassTable;

  private used = new Set<number>();
  private nextH = 1;
  /** 쓸 객체 핸들 */
  readonly live = new Set<number>();
  /** 경고 없이 뺀 빈 객체 */
  readonly silent = new Set<number>();

  // 표
  readonly ctrl = new Map<TableName, number>();
  readonly ltypes: PRec<Linetype>[] = [];
  ltByLayer = 0;
  ltByBlock = 0;
  ltContinuous = 0;
  readonly layers: PRec<Layer>[] = [];
  readonly styles: PRec<TextStyle>[] = [];
  readonly dimstyles: PRec<DimStyle>[] = [];
  readonly appids: PRec<TableRecordBase>[] = [];
  readonly vports: PRec<VPortRecord>[] = [];
  readonly views: PRec<ViewRecord>[] = [];
  readonly ucss: PRec<UcsRecord>[] = [];
  readonly blocks: PBlock[] = [];
  modelBlock!: PBlock;
  paperBlock!: PBlock;
  readonly layouts: PLayout[] = [];
  readonly objects: PObj[] = [];

  // 이름 → 핸들(대문자 키)
  readonly layerH = new Map<string, number>();
  readonly ltypeH = new Map<string, number>();
  readonly styleH = new Map<string, number>();
  readonly dimstyleH = new Map<string, number>();
  readonly appidH = new Map<string, number>();
  readonly blockH = new Map<string, number>();
  readonly ucsH = new Map<string, number>();
  readonly mlstyleH = new Map<string, number>();

  // 사전
  rootDict = 0;
  readonly dicts = new Map<string, number>();
  /** 색상표 이름(대문자) → DBCOLOR 핸들 */
  readonly dbColorH = new Map<string, number>();
  plotStyleNormal = 0;
  /** 모델 값으로 쓰는 표가 있는지 */
  hasTables = false;
  /** 스타일이 없는 표가 쓸 테이블 스타일(Standard) */
  tableStyleStd = 0;

  /** 원본 본문을 되쓸지 */
  readonly useRaw: boolean;

  constructor(doc: CadDocument, ver: number, warnings: ReadWarning[], useRaw = true) {
    this.useRaw = useRaw;
    this.doc = doc;
    this.ver = ver;
    this.verStr = `AC${ver}`;
    this.warnings = warnings;
    const cp = typeof doc.header.get('$DWGCODEPAGE') === 'string' ? (doc.header.get('$DWGCODEPAGE') as string) : doc.codepage;
    let cpNum = codepageNumber(cp || 'ANSI_1252');
    // R2007 이전은 문자열이 코드 페이지 바이트다: 도면 코드 페이지로 못 쓰는 글자가 있으면 더 맞는 코드 페이지를 고른다
    if (ver < R2007) {
      const better = chooseCodepage(doc, cpNum);
      if (better !== cpNum) {
        warnOnce(warnings, 'dwg.write_codepage', `도면 코드 페이지(${dwgCodepageName(cpNum)})로 쓸 수 없는 글자가 있어 ${dwgCodepageName(better)}로 썼습니다.`);
        cpNum = better;
      }
    }
    this.cpNum = cpNum;
    this.enc = encoderFor(dwgCodepageName(this.cpNum));
    this.classes = new ClassTable(doc.classes);
  }

  warn(code: string, message: string, detail?: Record<string, unknown>): void {
    warnOnce(this.warnings, code, message, detail);
  }

  // -------------------------------------------------------------------------
  // 핸들
  // -------------------------------------------------------------------------

  /** 문서 핸들을 쓰거나(처음 보는 값) 새로 준다 */
  take(s: string | undefined): number {
    const h = parseHandle(s);
    if (h > 0 && !this.used.has(h)) {
      this.used.add(h);
      return h;
    }
    return this.alloc();
  }

  alloc(): number {
    while (this.used.has(this.nextH)) this.nextH++;
    const h = this.nextH++;
    this.used.add(h);
    return h;
  }

  get handseed(): number {
    let m = this.nextH;
    for (const h of this.used) if (h >= m) m = h + 1;
    return m;
  }

  /** 다른 객체를 가리키는 핸들(쓰지 않는 객체면 0) */
  ref(s: string | undefined): number {
    const h = parseHandle(s);
    return h && this.live.has(h) ? h : 0;
  }

  refs(list: string[] | undefined): number[] {
    if (!list) return [];
    const out: number[] = [];
    for (const s of list) {
      const h = this.ref(s);
      if (h) out.push(h);
    }
    return out;
  }

  /** 원본 본문을 그대로 쓸 수 있는지(같은 버전, 같은 지문, 같은 핸들) */
  rawFor(x: { dwgRaw?: DwgRawBody; handle: string }, h: number): DwgRawBody | undefined {
    const r = x.dwgRaw;
    if (!r || !this.useRaw || r.version !== this.verStr || parseHandle(x.handle) !== h) return undefined;
    if (r.fingerprint !== fingerprint(x)) return undefined;
    return r;
  }

  // -------------------------------------------------------------------------
  // 이름 풀기
  // -------------------------------------------------------------------------

  layer(name: string | undefined): number {
    return this.layerH.get(tableKey(name || '0')) ?? this.layerH.get('0') ?? 0;
  }

  /** 도형 선종류: [플래그, 핸들] */
  linetype(name: string | undefined): [number, number] {
    const k = tableKey(name || 'ByLayer');
    if (k === 'BYLAYER') return [0, 0];
    if (k === 'BYBLOCK') return [1, 0];
    if (k === 'CONTINUOUS') return [2, 0];
    const h = this.ltypeH.get(k);
    if (h) return [3, h];
    this.warn('dwg.write_missing_linetype', '없는 선종류를 ByLayer로 썼습니다.');
    return [0, 0];
  }

  ltypeHandle(name: string | undefined): number {
    if (!name) return 0;
    return this.ltypeH.get(tableKey(name)) ?? 0;
  }

  style(name: string | undefined): number {
    return this.styleH.get(tableKey(name || 'Standard')) ?? this.styleH.get('STANDARD') ?? 0;
  }

  dimstyle(name: string | undefined): number {
    return this.dimstyleH.get(tableKey(name || 'Standard')) ?? this.dimstyleH.get('STANDARD') ?? this.dimstyles[0]?.h ?? 0;
  }

  block(name: string | undefined): number {
    if (!name) return 0;
    return this.blockH.get(tableKey(name)) ?? 0;
  }

  /** 화살촉 블록 이름(앞의 밑줄이 빠졌을 수 있다) */
  arrowBlock(name: string | number | undefined): number {
    if (typeof name !== 'string' || !name) return 0;
    return this.blockH.get(tableKey(name)) ?? this.blockH.get(tableKey('_' + name)) ?? 0;
  }

  appid(name: string): number {
    return this.appidH.get(tableKey(name)) ?? 0;
  }

  // -------------------------------------------------------------------------
  // 계획
  // -------------------------------------------------------------------------

  plan(): void {
    const doc = this.doc;
    // 1. 문서의 핸들 중 가장 큰 값 뒤에서 새 핸들을 준다
    let max = 0;
    const see = (s: string | undefined) => {
      const h = parseHandle(s);
      if (h > max) max = h;
    };
    for (const m of [doc.layers, doc.linetypes, doc.textStyles, doc.dimStyles, doc.views, doc.ucs, doc.appIds, doc.blockRecords]) for (const r of m.values()) see(r.handle);
    for (const v of doc.vports) see(v.handle);
    for (const b of doc.blocks.values()) {
      see(b.handle);
      see(b.recordHandle);
      see(b.endHandle);
      for (const e of b.entities) {
        see(e.handle);
        if (e.type === 'INSERT') for (const a of e.attribs) see(a.handle);
      }
    }
    for (const [k, o] of doc.objects) {
      see(k);
      see(o.handle);
    }
    for (const l of doc.layouts) see(l.handle);
    if (doc.tableHeads) for (const t of doc.tableHeads.values()) see(t.handle);
    see(doc.rootDictionary);
    this.nextH = max + 1;

    // 2. 표 제어 객체(DXF 표 머리 핸들을 이어 쓴다)
    const heads = doc.tableHeads;
    for (const t of ['BLOCK_RECORD', 'LAYER', 'STYLE', 'LTYPE', 'VIEW', 'UCS', 'VPORT', 'APPID', 'DIMSTYLE'] as TableName[]) {
      this.ctrl.set(t, this.take(heads?.get(t)?.handle));
    }
    if (this.ver <= 1015) this.ctrl.set('VPENT', this.alloc());

    // 3. 표 레코드
    this.planTables();
    // 4. 블록과 도형
    this.planBlocks();
    // 5. 비도형 객체
    this.planObjects();
    // 6. 확장 자료의 앱 이름(없으면 APPID를 만든다)
    this.planAppIds();

    for (const h of this.ctrl.values()) this.live.add(h);
  }

  private planTables(): void {
    const doc = this.doc;
    // 선종류: ByBlock·ByLayer는 따로(제어 객체의 끝 핸들)
    for (const lt of doc.linetypes.values()) {
      const k = tableKey(lt.name);
      if (k === 'BYLAYER' && !this.ltByLayer) {
        this.ltByLayer = this.take(lt.handle);
        this.ltypeH.set(k, this.ltByLayer);
        continue;
      }
      if (k === 'BYBLOCK' && !this.ltByBlock) {
        this.ltByBlock = this.take(lt.handle);
        this.ltypeH.set(k, this.ltByBlock);
        continue;
      }
      if (!k || this.ltypeH.has(k)) continue;
      const h = this.take(lt.handle);
      this.ltypes.push({ rec: lt, h });
      this.ltypeH.set(k, h);
    }
    if (!this.ltByLayer) this.ltypeH.set('BYLAYER', (this.ltByLayer = this.alloc()));
    if (!this.ltByBlock) this.ltypeH.set('BYBLOCK', (this.ltByBlock = this.alloc()));
    if (!this.ltypeH.has('CONTINUOUS')) {
      const rec: Linetype = { name: 'Continuous', handle: '', flags: 0, description: 'Solid line', patternLength: 0, elements: [] };
      const h = this.alloc();
      this.ltypes.unshift({ rec, h });
      this.ltypeH.set('CONTINUOUS', h);
    }
    this.ltContinuous = this.ltypeH.get('CONTINUOUS')!;

    const recs = <T extends TableRecordBase>(src: Iterable<T>, out: PRec<T>[], names: Map<string, number> | null, key: (r: T) => string = (r) => tableKey(r.name)): void => {
      for (const rec of src) {
        const k = key(rec);
        if (names) {
          if (names.has(k)) continue;
        }
        const h = this.take(rec.handle);
        out.push({ rec, h });
        if (names) names.set(k, h);
      }
    };
    recs(this.doc.layers.values(), this.layers, this.layerH);
    if (!this.layerH.has('0')) {
      const rec: Layer = { name: '0', handle: '', flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
      const h = this.alloc();
      this.layers.unshift({ rec, h });
      this.layerH.set('0', h);
    }
    // 도형이 가리키는데 표에 없는 도면층은 만든다(DXF를 읽는 AutoCAD처럼)
    {
      const missing = new Set<string>();
      const see = (n: string | undefined) => {
        if (n && !this.layerH.has(tableKey(n))) missing.add(n);
      };
      for (const b of doc.blocks.values()) {
        see(b.layer);
        for (const e of b.entities) {
          see(e.layer);
          if (e.type === 'INSERT') for (const a of e.attribs) see(a.layer);
        }
      }
      for (const name of missing) {
        if (this.layerH.has(tableKey(name))) continue;
        const rec: Layer = { name, handle: '', flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
        const h = this.alloc();
        this.layers.push({ rec, h });
        this.layerH.set(tableKey(name), h);
      }
    }
    // 문자 스타일: 이름 없는 쉐이프 파일 항목은 이름 표에 넣지 않는다
    for (const s of doc.textStyles.values()) {
      const k = tableKey(s.name);
      if (k && this.styleH.has(k)) continue;
      const h = this.take(s.handle);
      this.styles.push({ rec: s, h });
      if (k) this.styleH.set(k, h);
    }
    if (!this.styleH.has('STANDARD')) {
      const rec: TextStyle = { name: 'Standard', handle: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'txt', bigFont: '' };
      const h = this.alloc();
      this.styles.unshift({ rec, h });
      this.styleH.set('STANDARD', h);
    }
    recs(doc.dimStyles.values(), this.dimstyles, this.dimstyleH);
    if (!this.dimstyles.length) {
      const rec: DimStyle = { name: 'Standard', handle: '', flags: 0, vars: { ...DIM_VAR_DEFAULTS } };
      const h = this.alloc();
      this.dimstyles.unshift({ rec, h });
      this.dimstyleH.set('STANDARD', h);
    }
    recs(doc.appIds.values(), this.appids, this.appidH);
    if (!this.appidH.has('ACAD')) {
      const h = this.alloc();
      this.appids.unshift({ rec: { name: 'ACAD', handle: '', flags: 0 }, h });
      this.appidH.set('ACAD', h);
    }
    const vpNames = new Set<string>();
    for (const v of doc.vports) {
      const h = this.take(v.handle);
      this.vports.push({ rec: v, h });
      vpNames.add(tableKey(v.name));
    }
    if (!vpNames.has('*ACTIVE')) {
      const rec: VPortRecord = {
        name: '*Active',
        handle: '',
        flags: 0,
        lowerLeft: { x: 0, y: 0 },
        upperRight: { x: 1, y: 1 },
        center: { x: 0, y: 0 },
        snapBase: { x: 0, y: 0 },
        snapSpacing: { x: 0.5, y: 0.5 },
        gridSpacing: { x: 0.5, y: 0.5 },
        viewDirection: { x: 0, y: 0, z: 1 },
        viewTarget: { x: 0, y: 0, z: 0 },
        height: 9,
        aspect: 1.5,
        lensLength: 50,
        twist: 0,
      };
      this.vports.unshift({ rec, h: this.alloc() });
    }
    recs(doc.views.values(), this.views, null);
    recs(doc.ucs.values(), this.ucss, this.ucsH);
    for (const list of [this.ltypes, this.layers, this.styles, this.dimstyles, this.appids, this.vports, this.views, this.ucss] as PRec<TableRecordBase>[][]) for (const r of list) this.live.add(r.h);
    this.live.add(this.ltByLayer);
    this.live.add(this.ltByBlock);
  }

  private planBlocks(): void {
    const doc = this.doc;
    const seen = new Set<string>();
    const list: { key: string; def: BlockDef }[] = [];
    for (const [key, def] of doc.blocks) {
      const k = tableKey(def.name || key);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      list.push({ key: k, def });
    }
    if (!seen.has(MODEL_SPACE)) list.push({ key: MODEL_SPACE, def: { name: '*Model_Space', handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] } });
    if (!seen.has(PAPER_SPACE)) list.push({ key: PAPER_SPACE, def: { name: '*Paper_Space', handle: '', recordHandle: '', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] } });
    for (const { key, def } of list) {
      const rec = doc.blockRecords.get(key) ?? { name: def.name, handle: def.recordHandle, flags: 0, insertUnits: 0, explodable: true, scalable: true };
      const recH = this.take(def.recordHandle || rec.handle);
      const pb: PBlock = {
        key,
        name: key === MODEL_SPACE ? '*Model_Space' : key === PAPER_SPACE ? '*Paper_Space' : def.name,
        def,
        rec,
        recH,
        beginH: this.take(def.handle),
        endH: this.take(def.endHandle),
        mode: key === MODEL_SPACE ? 2 : key === PAPER_SPACE ? 1 : 0,
        layoutH: 0,
        ents: [],
      };
      this.blocks.push(pb);
      this.blockH.set(key, recH);
      this.live.add(recH);
      this.live.add(pb.beginH);
      this.live.add(pb.endH);
      if (key === MODEL_SPACE) this.modelBlock = pb;
      if (key === PAPER_SPACE) this.paperBlock = pb;
    }
    // 도형
    let dropped: Record<string, number> = {};
    for (const pb of this.blocks) {
      for (const e of pb.def.entities) {
        const pe = this.planEntity(e, dropped);
        if (pe) pb.ents.push(pe);
      }
    }
    // ACAD_TABLE을 바꿔 쓸 때 가리키는 블록이 있어야 한다
    for (const pb of this.blocks) {
      pb.ents = pb.ents.filter((pe) => {
        if ((pe.asInsert || pe.table) && !this.block((pe.e as { block?: string }).block)) {
          dropped.ACAD_TABLE = (dropped.ACAD_TABLE ?? 0) + 1;
          this.live.delete(pe.h);
          return false;
        }
        return true;
      });
    }
    const n = Object.values(dropped).reduce((a, b) => a + b, 0);
    if (n) this.warn('dwg.write_entity_dropped', `이 버전으로 쓸 수 없는 도형 ${n}개를 뺐습니다(원본 자료가 없거나 다른 버전).`, { types: dropped });
    dropped = {};

    // 배치
    this.planLayouts();
  }

  private planEntity(e: Entity, dropped: Record<string, number>): PEnt | null {
    const h = this.take(e.handle);
    const pe: PEnt = { e, h };
    const raw = this.rawFor(e, h);
    if (raw) pe.raw = raw;
    else if (RAW_ONLY_ENTITIES.has(e.type)) {
      const t = e.type === 'UNKNOWN' ? e.originalType : e.type;
      dropped[t] = (dropped[t] ?? 0) + 1;
      return null;
    } else if (e.type === 'ACAD_TABLE') {
      if (e.rows > 0 && e.columns > 0 && e.rows * e.columns <= 100000) {
        pe.table = true;
        this.hasTables = true;
      } else {
        pe.asInsert = true;
        this.warn('dwg.write_table_as_insert', '행·열이 없는 표(ACAD_TABLE)를 그림 블록의 블록 참조로 썼습니다.');
      }
    } else if (e.type === 'MPOLYGON') {
      pe.asHatch = true;
      this.warn('dwg.write_mpolygon', 'MPOLYGON을 HATCH로 썼습니다.');
    }
    if (!pe.raw && e.type === 'INSERT' && e.attribs.length) {
      pe.subs = e.attribs.map((a) => this.take(a.handle));
      pe.seqend = this.alloc();
    } else if (!pe.raw && e.type === 'POLYLINE') {
      pe.subs = e.vertices.map(() => this.alloc());
      pe.seqend = this.alloc();
    } else if (pe.raw && e.type === 'INSERT') {
      // 원본 본문으로 쓰는 INSERT는 없다(속성이 있으면 모델로 쓴다)
    }
    this.live.add(h);
    if (pe.subs) for (const s of pe.subs) this.live.add(s);
    if (pe.seqend) this.live.add(pe.seqend);
    return pe;
  }

  private planLayouts(): void {
    const doc = this.doc;
    const layoutObjs = new Map<string, LayoutObject>();
    for (const o of doc.objects.values()) if (o.type === 'LAYOUT') layoutObjs.set(o.handle, o as LayoutObject);
    const usedBlocks = new Set<string>();
    for (const lay of doc.layouts) {
      const bk = tableKey(lay.blockName);
      const pb = this.blocks.find((b) => b.key === bk);
      if (!pb) {
        this.warn('dwg.write_layout_dropped', '블록이 없는 배치를 뺐습니다.');
        continue;
      }
      if (usedBlocks.has(bk)) continue;
      usedBlocks.add(bk);
      const h = this.take(lay.handle);
      this.layouts.push({ lay, h, obj: layoutObjs.get(lay.handle) });
      pb.layoutH = h;
      this.live.add(h);
    }
    // 배치가 없는 모형·종이 공간 블록
    let n = this.layouts.length;
    for (const pb of this.blocks) {
      if (pb.layoutH || (pb.key !== MODEL_SPACE && !isPaperName(pb.key))) continue;
      const lay = pb.key === MODEL_SPACE ? defaultLayout('Model', '*Model_Space', 0) : defaultLayout(this.uniqueLayoutName(), pb.name, n);
      const h = this.alloc();
      this.layouts.push({ lay, h });
      pb.layoutH = h;
      this.live.add(h);
      n++;
    }
  }

  private uniqueLayoutName(): string {
    const names = new Set(this.layouts.map((l) => l.lay.name.toUpperCase()));
    for (let i = 1; ; i++) if (!names.has(`LAYOUT${i}`)) return `Layout${i}`;
  }

  private planObjects(): void {
    const doc = this.doc;
    const dropped: Record<string, number> = {};
    const layoutHandles = new Set(this.layouts.map((l) => l.lay.handle).filter(Boolean));
    for (const [key, o] of doc.objects) {
      if (o.type === 'LAYOUT') continue; // 배치는 따로
      if (layoutHandles.has(key)) continue;
      const h = this.take(o.handle || key);
      const po: PObj = { o: dbColorFromRaw(o), h };
      const raw = this.rawFor(o, h);
      if (raw) po.raw = raw;
      else if (SILENT_OBJECTS.has(o.type)) {
        this.silent.add(h);
        continue;
      } else if (!NATIVE_OBJECTS.has(o.type) || !this.nativeObjectOk(po.o)) {
        // 자료가 하나도 없는 객체(새 도면의 기본 TABLESTYLE 등)는 잃을 것이 없어 조용히 뺀다
        const g = o as GenericObject;
        if (!o.dwgRaw && !g.raw?.length && !g.xdata?.length && !g.color) {
          this.silent.add(h);
          continue;
        }
        dropped[o.type] = (dropped[o.type] ?? 0) + 1;
        continue;
      }
      this.objects.push(po);
      this.live.add(h);
    }
    // 동적 블록 평가 그래프는 노드를 하나라도 쓰지 못하면(다른 버전으로 쓸 수 없는 노드) 그래프와 그 노드를 모두 뺀다.
    // 빈 핸들을 가리키는 그래프보다 정의가 없는 보통 블록이 낫다(ACAD_ENHANCEDBLOCK 사전 항목도 빠진다).
    const deadGraphs = new Set<number>();
    for (const po of this.objects) {
      if (po.o.type !== 'ACAD_EVALUATION_GRAPH') continue;
      const nodes = ((po.o as GenericObject).raw ?? []).filter((t) => t.code === 360).map((t) => parseHandle(String(t.value)));
      if (!nodes.every((n) => n && this.live.has(n))) deadGraphs.add(po.h);
    }
    if (deadGraphs.size) {
      const keep = this.objects.filter((po) => {
        if (!deadGraphs.has(po.h) && !deadGraphs.has(parseHandle(po.o.owner))) return true;
        this.live.delete(po.h);
        dropped[po.o.type] = (dropped[po.o.type] ?? 0) + 1;
        return false;
      });
      this.objects.length = 0;
      this.objects.push(...keep);
    }
    for (const po of this.objects) {
      const c = po.o.type === 'DBCOLOR' ? (po.o as GenericObject).color : undefined;
      if (c?.name && !this.dbColorH.has(c.name.toUpperCase())) this.dbColorH.set(c.name.toUpperCase(), po.h);
    }
    const n = Object.values(dropped).reduce((a, b) => a + b, 0);
    if (n) this.warn('dwg.write_object_dropped', `이 버전으로 쓸 수 없는 객체 ${n}개를 뺐습니다(원본 자료가 없거나 다른 버전).`, { types: dropped });

    // 루트 사전
    const byH = new Map<number, PObj>();
    for (const po of this.objects) byH.set(po.h, po);
    const isDict = (po: PObj | undefined) => !!po && (po.o.type === 'DICTIONARY' || po.o.type === 'ACDBDICTIONARYWDFLT');
    let root = parseHandle(doc.rootDictionary);
    if (!isDict(byH.get(root))) root = 0;
    let rootObj: DictionaryObject;
    if (root) rootObj = byH.get(root)!.o as DictionaryObject;
    else {
      root = this.alloc();
      rootObj = { type: 'DICTIONARY', handle: root.toString(16).toUpperCase(), entries: new Map(), hardOwner: false, cloning: 1 };
      const po = { o: rootObj, h: root };
      this.objects.unshift(po);
      byH.set(root, po);
      this.live.add(root);
    }
    this.rootDict = root;
    // 루트 사전 항목을 고쳐 쓸 수 있게 복제
    const rootCopy: DictionaryObject = { ...rootObj, entries: new Map(rootObj.entries) };
    byH.get(root)!.o = rootCopy;

    const sub = (name: string, make: (h: number) => CadObject, wdflt = false): number => {
      const cur = parseHandle(rootCopy.entries.get(name));
      const po = byH.get(cur);
      if (cur && isDict(po) && (!wdflt || po!.o.type === 'ACDBDICTIONARYWDFLT' || po!.o.type === 'DICTIONARY')) {
        this.dicts.set(name, cur);
        return cur;
      }
      const h = this.alloc();
      const o = make(h);
      const npo = { o, h };
      this.objects.push(npo);
      byH.set(h, npo);
      this.live.add(h);
      rootCopy.entries.set(name, hexOf(h));
      this.dicts.set(name, h);
      return h;
    };
    const emptyDict = (h: number): DictionaryObject => ({ type: 'DICTIONARY', handle: hexOf(h), owner: hexOf(root), reactors: [hexOf(root)], entries: new Map(), hardOwner: false, cloning: 1 });
    sub('ACAD_GROUP', emptyDict);
    sub('ACAD_LAYOUT', emptyDict);
    sub('ACAD_PLOTSETTINGS', emptyDict);
    sub('ACAD_MLINESTYLE', emptyDict);
    sub('ACAD_PLOTSTYLENAME', (h) => ({ ...emptyDict(h), type: 'ACDBDICTIONARYWDFLT' }), true);
    if (this.ver >= R2004) {
      sub('ACAD_MATERIAL', emptyDict);
      sub('ACAD_COLOR', emptyDict);
    }
    if (this.ver >= R2007) sub('ACAD_VISUALSTYLE', emptyDict);

    // 색상표 색: 도형이 쓰는 이름의 DBCOLOR가 없으면 ACAD_COLOR 사전에 만든다(R2004+)
    if (this.ver >= R2004) {
      const dh = this.dicts.get('ACAD_COLOR')!;
      const dpo = byH.get(dh)!;
      let entries: Map<string, string> | null = null;
      const need = (c: CadColor | undefined) => {
        if (!c?.name || this.dbColorH.has(c.name.toUpperCase())) return;
        const h = this.alloc();
        const o: GenericObject = { type: 'DBCOLOR', handle: hexOf(h), owner: hexOf(dh), reactors: [hexOf(dh)], color: { ...c } };
        this.objects.push({ o, h });
        byH.set(h, { o, h });
        this.live.add(h);
        this.dbColorH.set(c.name.toUpperCase(), h);
        (entries ??= new Map((dpo.o as DictionaryObject).entries)).set(c.name, hexOf(h));
      };
      for (const b of doc.blocks.values()) {
        for (const e of b.entities) {
          need(e.color);
          if (e.type === 'INSERT') for (const a of e.attribs) need(a.color);
        }
      }
      if (entries) dpo.o = { ...(dpo.o as DictionaryObject), entries };
    }

    // 배치 사전: 쓸 배치로 다시 채운다
    {
      const h = this.dicts.get('ACAD_LAYOUT')!;
      const po = byH.get(h)!;
      const d = po.o as DictionaryObject;
      const entries = new Map<string, string>();
      for (const pl of [...this.layouts].sort((a, b) => a.lay.tabOrder - b.lay.tabOrder)) entries.set(pl.lay.name, hexOf(pl.h));
      po.o = { ...d, entries };
    }
    // 다중선 스타일 Standard
    {
      const h = this.dicts.get('ACAD_MLINESTYLE')!;
      const po = byH.get(h)!;
      const d = po.o as DictionaryObject;
      const entries = new Map(d.entries);
      for (const [name, hs] of entries) {
        const t = byH.get(parseHandle(hs));
        if (t && t.o.type === 'MLINESTYLE') this.mlstyleH.set(name.toUpperCase(), t.h);
      }
      if (!this.mlstyleH.has('STANDARD')) {
        const sh = this.alloc();
        const ms: MLineStyleObject = {
          type: 'MLINESTYLE',
          handle: hexOf(sh),
          owner: hexOf(h),
          reactors: [hexOf(h)],
          name: 'Standard',
          flags: 0,
          description: '',
          fillColor: { aci: 256 },
          startAngle: Math.PI / 2,
          endAngle: Math.PI / 2,
          elements: [
            { offset: 0.5, color: { aci: 256 }, linetype: 'ByLayer' },
            { offset: -0.5, color: { aci: 256 }, linetype: 'ByLayer' },
          ],
        };
        this.objects.push({ o: ms, h: sh });
        byH.set(sh, { o: ms, h: sh });
        this.live.add(sh);
        entries.set('Standard', hexOf(sh));
        this.mlstyleH.set('STANDARD', sh);
      }
      po.o = { ...d, entries };
    }
    // 플롯 스타일 Normal(ACDBPLACEHOLDER)
    {
      const h = this.dicts.get('ACAD_PLOTSTYLENAME')!;
      const po = byH.get(h)!;
      const d = po.o as DictionaryObject;
      let normal = parseHandle(d.entries.get('Normal'));
      if (!byH.has(normal)) {
        normal = this.alloc();
        const ph: GenericObject = { type: 'ACDBPLACEHOLDER', handle: hexOf(normal), owner: hexOf(h), reactors: [hexOf(h)] };
        this.objects.push({ o: ph, h: normal });
        byH.set(normal, { o: ph, h: normal });
        this.live.add(normal);
        const entries = new Map(d.entries);
        entries.set('Normal', hexOf(normal));
        po.o = { ...d, type: 'ACDBDICTIONARYWDFLT', entries, defaultHandle: hexOf(normal) };
      } else if (d.type !== 'ACDBDICTIONARYWDFLT') {
        po.o = { ...d, type: 'ACDBDICTIONARYWDFLT', defaultHandle: hexOf(normal) };
      }
      this.plotStyleNormal = normal;
    }
    // 테이블 스타일: 표가 있으면 ACAD_TABLESTYLE 사전과 Standard가 있어야 한다
    if (this.hasTables) {
      const h = sub('ACAD_TABLESTYLE', emptyDict);
      const po = byH.get(h)!;
      const d = po.o as DictionaryObject;
      let std = 0;
      let first = 0;
      for (const [name, hs] of d.entries) {
        const t = byH.get(parseHandle(hs));
        if (!t || t.o.type !== 'TABLESTYLE') continue;
        if (!first) first = t.h;
        if (name.toUpperCase() === 'STANDARD') std = t.h;
      }
      if (!std && !first) {
        std = this.alloc();
        const ts: GenericObject = { type: 'TABLESTYLE', handle: hexOf(std), owner: hexOf(h), reactors: [hexOf(h)] };
        this.objects.push({ o: ts, h: std });
        byH.set(std, { o: ts, h: std });
        this.live.add(std);
        po.o = { ...d, entries: new Map([...d.entries, ['Standard', hexOf(std)]]) };
      }
      this.tableStyleStd = std || first;
    }
  }

  /** 모델 값만으로 쓸 수 있는 객체인지 */
  private nativeObjectOk(o: CadObject): boolean {
    switch (o.type) {
      case 'DICTIONARYVAR':
        return !!(o as GenericObject).raw;
      case 'DBCOLOR':
        return !!(o as GenericObject).color;
      case 'RASTERVARIABLES':
      case 'WIPEOUTVARIABLES':
        return !!(o as GenericObject).raw;
      case 'FIELD':
      case 'FIELDLIST':
      case 'DIMASSOC':
      case 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS':
        return rawObjectOk(o as GenericObject, this.ver);
      case 'TABLESTYLE':
        // 원본 태그(DXF·DWG 리더·편집)가 없으면 Standard 기본값으로 쓴다
        return true;
      default:
        // 동적 블록 객체: 원본 태그(DXF·DWG 리더·편집)를 dyncodec 배치로 쓸 수 있을 때
        if (DYN_TYPES.has(o.type)) return rawObjectOk(o as GenericObject, this.ver, this.doc);
        return true;
    }
  }

  /** 확장 자료가 쓰는 앱 이름마다 APPID가 있어야 한다 */
  private planAppIds(): void {
    const need = new Set<string>();
    const add = (xd: XData[] | undefined) => {
      if (xd) for (const x of xd) if (x.app) need.add(x.app);
    };
    for (const list of [this.ltypes, this.layers, this.styles, this.dimstyles, this.appids, this.vports, this.views, this.ucss] as PRec<TableRecordBase>[][]) for (const r of list) add(r.rec.xdata);
    for (const pb of this.blocks) {
      add(pb.rec.xdata);
      for (const pe of pb.ents) {
        if (pe.raw) {
          add(pe.e.xdata);
          continue;
        }
        add(pe.e.xdata);
        if (pe.e.type === 'INSERT') for (const a of pe.e.attribs) add(a.xdata);
      }
    }
    for (const po of this.objects) add(po.o.xdata);
    // 도면층 투명도·문자 스타일 글꼴은 확장 자료로 쓴다
    for (const l of this.layers) if (l.rec.transparency !== undefined && l.rec.transparency !== 255 && !l.rec.xdata?.some((x) => x.app.toUpperCase() === 'ACCMTRANSPARENCY')) need.add('AcCmTransparency');
    for (const name of need) {
      const k = tableKey(name);
      if (this.appidH.has(k)) continue;
      const h = this.alloc();
      this.appids.push({ rec: { name, handle: '', flags: 0 }, h });
      this.appidH.set(k, h);
      this.live.add(h);
    }
  }

  /** 엔티티 모드 0인 도형의 소유자(블록 레코드) */
  blockOf(pb: PBlock): number {
    return pb.recH;
  }

  /** R2018 다중선 스타일 요소 선종류 */
  get r2018(): boolean {
    return this.ver >= R2018;
  }
}

export const hexOf = (h: number): string => (h > 0 ? h.toString(16).toUpperCase() : '');

/** DXF에서 읽은 DBCOLOR(원본 태그만 있음)에 색을 채운다: 62 ACI, 420 RGB, 430 이름 */
function dbColorFromRaw(o: CadObject): CadObject {
  const g = o as GenericObject;
  if (o.type !== 'DBCOLOR' || g.color || !g.raw) return o;
  const tag = (c: number) => g.raw!.find((t) => t.code === c)?.value;
  const aci = Number(tag(62) ?? 7);
  const color: CadColor = { aci: Number.isFinite(aci) ? aci : 7 };
  const rgb = tag(420);
  if (rgb !== undefined) color.rgb = Number(rgb) & 0xffffff;
  const name = tag(430);
  if (typeof name === 'string' && name) color.name = name;
  return { ...g, color };
}
