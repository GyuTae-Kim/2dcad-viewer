/**
 * DXF 쓰기 준비: 무엇을 어떤 핸들로 쓸지 먼저 정한다.
 * - 문서를 바꾸지 않는다. 핸들이 없거나 겹치는 객체는 새 핸들을 이 쓰기 동안만 붙인다.
 * - 쓸 객체의 핸들을 live에 모아 두고, 다른 객체를 가리키는 핸들(330·340·360 등)은 live에 있을 때만 쓴다.
 * - 필수 항목(도면층 0, 선종류 ByBlock·ByLayer·Continuous, 문자 스타일 Standard, 치수 스타일 Standard,
 *   APPID ACAD, *Active 뷰포트, *Model_Space·*Paper_Space와 배치, 루트 사전과 필수 사전)이 없으면 만든다.
 */
import type {
  BlockDef,
  BlockRecord,
  CadDocument,
  CadObject,
  DictionaryObject,
  DimStyle,
  Entity,
  GenericObject,
  GroupObject,
  ImageDefObject,
  ImageEntity,
  Layer,
  Layout,
  LayoutObject,
  Linetype,
  MLeaderStyleObject,
  MLineStyleObject,
  RawTag,
  ReadWarning,
  TableRecordBase,
  TextStyle,
  UcsRecord,
  ViewRecord,
  VPortRecord,
  XData,
  XRecordObject,
} from '../../core/model';
import { MODEL_SPACE, PAPER_SPACE, tableKey } from '../../core/model';
import { defaultLayout } from '../../core/finalize';
import { type DxfVersion, rawTagsValid, versionNum } from './tagwriter';
import { convertEntity } from './wconvert';

export interface DxfWriteOptions {
  /** 기본 AC1032(R2018) */
  version?: DxfVersion;
  /** 이진 DXF */
  binary?: boolean;
  /** R2007 이전 문자열을 이 코드 페이지 바이트로 쓴다(주지 않으면 비ASCII 문자를 모두 \U+XXXX로 쓴다) */
  codepage?: string;
  /** R2007 이전에 모든 비ASCII 문자를 \U+XXXX로 쓴다(파일 전체가 ASCII). 기본값: codepage를 주지 않으면 참 */
  escapeNonAscii?: boolean;
}

export interface PlannedBlock {
  key: string;
  name: string;
  def: BlockDef;
  rec: BlockRecord;
  recH: string;
  beginH: string;
  endH: string;
  /** model = *Model_Space, active = *Paper_Space, paper = 그 밖의 배치, block = 일반 블록 */
  kind: 'model' | 'active' | 'paper' | 'block';
  layout?: PlannedLayout;
  /** 실제로 쓸 객체(버전에 맞게 바꾼 것) */
  entities: Entity[];
}

export interface PlannedLayout {
  layout: Layout;
  h: string;
  block: PlannedBlock;
  /** 문서의 LAYOUT 객체(확장 사전·반응자·확장 자료) */
  obj?: LayoutObject;
}

export interface PlannedRecord<T extends TableRecordBase> {
  rec: T;
  h: string;
}

export interface PlannedObject {
  obj: CadObject;
  h: string;
  owner: string;
  /** 쓰기에서 만든 객체 */
  synthetic?: boolean;
}

export const TABLE_NAMES = ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD'] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** AutoCAD가 표 머리에 쓰는 핸들 */
const STD_TABLE_HANDLES: Record<TableName, string> = {
  BLOCK_RECORD: '1',
  LAYER: '2',
  STYLE: '3',
  LTYPE: '5',
  VIEW: '6',
  UCS: '7',
  VPORT: '8',
  APPID: '9',
  DIMSTYLE: 'A',
};

/** 이 버전부터 있는 객체 종류(그 전 버전으로 쓸 때는 뺀다) */
const OBJECT_MIN_VERSION: Record<string, number> = {
  MLEADERSTYLE: 1021,
  SCALE: 1021,
  VISUALSTYLE: 1021,
  MATERIAL: 1021,
  CELLSTYLEMAP: 1021,
  TABLESTYLE: 1018,
  TABLECONTENT: 1021,
  TABLEGEOMETRY: 1021,
  SUN: 1021,
  ACDBSECTIONVIEWSTYLE: 1027,
  ACDBDETAILVIEWSTYLE: 1027,
  PDFDEFINITION: 1024,
  DWFDEFINITION: 1021,
  DGNDEFINITION: 1021,
  GEODATA: 1021,
  ACDBASSOCPERSSUBENTMANAGER: 1024,
  DBCOLOR: 1018,
  ACDBPERSSUBENTMANAGER: 1024,
};

/** 원본 태그가 없어도 내용을 만들 수 있는 객체 */
const SYNTH_GENERIC = new Set(['ACDBPLACEHOLDER', 'TABLESTYLE']);

const HEX_RE = /^[0-9A-F]+$/;

/** 핸들 값을 갖는 그룹 코드 */
export function isHandleCode(code: number): boolean {
  return code === 5 || code === 105 || (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || code === 480 || code === 481 || code === 1005;
}

export class WriteContext {
  readonly doc: CadDocument;
  readonly version: DxfVersion;
  readonly ver: number;
  readonly options: DxfWriteOptions;
  private readonly warnMap = new Map<string, ReadWarning>();

  private next = 1n;
  private readonly taken = new Set<string>();
  private readonly given = new WeakMap<object, string>();
  /** 쓸 객체의 핸들 */
  readonly live = new Set<string>();

  readonly tableHeads = new Map<TableName, string>();
  vports: PlannedRecord<VPortRecord>[] = [];
  ltypes: PlannedRecord<Linetype>[] = [];
  layers: PlannedRecord<Layer>[] = [];
  styles: PlannedRecord<TextStyle>[] = [];
  views: PlannedRecord<ViewRecord>[] = [];
  ucs: PlannedRecord<UcsRecord>[] = [];
  appids: PlannedRecord<TableRecordBase>[] = [];
  dimstyles: PlannedRecord<DimStyle>[] = [];
  readonly ltypeH = new Map<string, string>();
  readonly layerH = new Map<string, string>();
  readonly styleH = new Map<string, string>();
  readonly dimstyleH = new Map<string, string>();
  readonly appidSet = new Set<string>();

  blocks: PlannedBlock[] = [];
  readonly blockByKey = new Map<string, PlannedBlock>();
  readonly blockByRecH = new Map<string, PlannedBlock>();
  model!: PlannedBlock;
  active!: PlannedBlock;
  layouts: PlannedLayout[] = [];

  objects: PlannedObject[] = [];
  readonly objByH = new Map<string, PlannedObject>();
  rootH = '';
  /** 사전 핸들 → 쓸 항목 */
  readonly dictEntries = new Map<string, [string, string][]>();
  readonly mlineStyleH = new Map<string, string>();
  mlineStandardH = '';
  mleaderStandardH = '';
  tableStyleStandardH = '';
  plotStyleNormalH = '';
  /** IMAGE 핸들 → IMAGEDEF_REACTOR 핸들 */
  readonly imageReactor = new Map<string, string>();
  /** IMAGEDEF 핸들 → 그것을 쓰는 반응자 핸들 */
  readonly imageDefReactors = new Map<string, string[]>();
  /** 객체 핸들 → 그것을 담은 GROUP 핸들(반응자로 쓴다) */
  readonly groupReactors = new Map<string, string[]>();
  /** 객체 종류별 쓴 개수(CLASSES 91) */
  readonly typeCounts = new Map<string, number>();

  /** 버전에 맞게 바꾼 객체: 문서 객체 → 실제로 쓸 객체들(부분 저장용) */
  readonly converted = new Map<Entity, Entity[]>();
  private refLtypes = new Set<string>();
  private refStyles = new Set<string>();
  private refBlocks = new Map<string, string>();
  private refApps = new Set<string>();

  constructor(doc: CadDocument, options: DxfWriteOptions = {}) {
    this.doc = doc;
    this.options = options;
    this.version = options.version ?? 'AC1032';
    this.ver = versionNum(this.version);
    this.scanMax();
    this.planBlocks();
    this.planTables();
    this.claimBlocks();
    this.planLayouts();
    this.claimEntities();
    if (this.ver >= 1015) this.planObjects();
  }

  // -------------------------------------------------------------------------
  // 경고·핸들

  warn(code: string, message: string, detail?: string): void {
    const w = this.warnMap.get(code);
    if (w) {
      w.count = (w.count ?? 1) + 1;
      if (detail) {
        const d = (w.detail ??= {}) as { items?: string[] };
        const items = (d.items ??= []);
        if (items.length < 20 && !items.includes(detail)) items.push(detail);
      }
      return;
    }
    this.warnMap.set(code, { code, message, count: 1, ...(detail ? { detail: { items: [detail] } } : {}) });
  }

  get warnings(): ReadWarning[] {
    return [...this.warnMap.values()];
  }

  private bump(h: string | undefined): void {
    if (!h) return;
    const t = h.trim().toUpperCase();
    if (!t || t.length > 16 || !HEX_RE.test(t)) return;
    const v = BigInt('0x' + t);
    if (v >= this.next) this.next = v + 1n;
  }

  private bumpRaw(raw: RawTag[] | undefined): void {
    if (!raw) return;
    for (const t of raw) if (isHandleCode(t.code) && typeof t.value === 'string') this.bump(t.value);
  }

  private bumpXData(x: XData[] | undefined): void {
    if (!x) return;
    for (const a of x) for (const it of a.items) if (it.code === 1005 && typeof it.value === 'string') this.bump(it.value);
  }

  /** 문서 안 객체·표 항목·블록이 가진 핸들(관례 핸들을 붙여도 되는지 볼 때 쓴다) */
  private readonly docHandles = new Set<string>();

  private scanMax(): void {
    const d = this.doc;
    const own = (h: string | undefined) => {
      if (h) this.docHandles.add(h.toUpperCase());
    };
    const ent = (e: Entity) => {
      own(e.handle);
      this.bump(e.handle);
      this.bump(e.owner);
      this.bump(e.xdict);
      if (e.reactors) for (const r of e.reactors) this.bump(r);
      this.bumpXData(e.xdata);
      const raw = (e as { raw?: RawTag[] }).raw;
      this.bumpRaw(raw);
      if (e.type === 'INSERT') for (const a of e.attribs) ent(a);
    };
    for (const b of d.blocks.values()) {
      own(b.handle);
      own(b.recordHandle);
      own(b.endHandle);
      this.bump(b.handle);
      this.bump(b.recordHandle);
      this.bump(b.endHandle);
      for (const e of b.entities) ent(e);
    }
    const recs: Iterable<TableRecordBase>[] = [
      d.layers.values(),
      d.linetypes.values(),
      d.textStyles.values(),
      d.dimStyles.values(),
      d.vports,
      d.views.values(),
      d.ucs.values(),
      d.appIds.values(),
      d.blockRecords.values(),
    ];
    for (const list of recs) {
      for (const r of list) {
        own(r.handle);
        this.bump(r.handle);
        this.bump(r.xdict);
      }
    }
    if (d.tableHeads) for (const t of d.tableHeads.values()) own(t.handle), this.bump(t.handle);
    for (const o of d.objects.values()) {
      own(o.handle);
      this.bump(o.handle);
      this.bump(o.owner);
      this.bump(o.xdict);
      this.bumpRaw((o as GenericObject).raw);
      if (o.type === 'XRECORD') this.bumpRaw((o as XRecordObject).data);
    }
    for (const l of d.layouts) {
      own(l.handle);
      this.bump(l.handle);
      this.bump(l.blockRecord);
    }
    if (d.rawSections) for (const s of d.rawSections) this.bumpRaw(s.tags);
    const seed = d.header.get('$HANDSEED');
    if (typeof seed === 'string') this.bump(seed);
    // 표 머리의 관례 핸들은 비워 둔다.
    if (this.next < 0x20n) this.next = 0x20n;
  }

  /** 새 핸들 */
  alloc(): string {
    let h = this.next.toString(16).toUpperCase();
    while (this.taken.has(h)) {
      this.next++;
      h = this.next.toString(16).toUpperCase();
    }
    this.next++;
    this.taken.add(h);
    return h;
  }

  /** 다음에 쓸 핸들(= $HANDSEED) */
  get handseed(): string {
    return this.next.toString(16).toUpperCase();
  }

  private validHandle(h: string | undefined): h is string {
    return !!h && h !== '0' && h.length <= 16 && HEX_RE.test(h);
  }

  /** 객체에 핸들을 정한다(원래 핸들을 쓸 수 있으면 그대로). */
  claim(obj: object, preferred: string | undefined): string {
    const g = this.given.get(obj);
    if (g) return g;
    let h: string;
    const p = preferred?.toUpperCase();
    if (this.validHandle(p) && !this.taken.has(p)) {
      this.taken.add(p);
      h = p;
    } else {
      if (this.validHandle(p)) this.warn('handle.duplicate', '핸들이 겹친 객체에 새 핸들을 붙였습니다.', p);
      h = this.alloc();
    }
    this.given.set(obj, h);
    return h;
  }

  /** 정해 둔 핸들(없으면 지금 정한다) */
  hOf(obj: object & { handle?: string }): string {
    return this.given.get(obj) ?? this.claim(obj, obj.handle);
  }

  isLive(h: string | undefined): h is string {
    return !!h && this.live.has(h.toUpperCase());
  }

  countType(type: string): void {
    this.typeCounts.set(type, (this.typeCounts.get(type) ?? 0) + 1);
  }

  // -------------------------------------------------------------------------
  // 블록·객체

  private planBlocks(): void {
    const d = this.doc;
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const k of d.blocks.keys()) if (!seen.has(k)) seen.add(k), keys.push(k);
    if (this.ver >= 1015) for (const k of d.blockRecords.keys()) if (!seen.has(k)) seen.add(k), keys.push(k);
    const make = (key: string, def: BlockDef | undefined, rec: BlockRecord | undefined): PlannedBlock => {
      const name = def?.name ?? rec?.name ?? key;
      const b: BlockDef = def ?? { name, handle: '', recordHandle: rec?.handle ?? '', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] };
      const r: BlockRecord = rec ?? { name, handle: b.recordHandle, flags: 0, insertUnits: 0, explodable: true, scalable: true };
      let kind: PlannedBlock['kind'] = 'block';
      if (key === MODEL_SPACE) kind = 'model';
      else if (key === PAPER_SPACE) kind = 'active';
      else if (key.startsWith(PAPER_SPACE)) kind = 'paper';
      return { key, name, def: b, rec: r, recH: '', beginH: '', endH: '', kind, entities: [] };
    };
    for (const key of keys) {
      const pb = make(key, d.blocks.get(key), d.blockRecords.get(key));
      if (this.ver <= 1009 && pb.kind === 'paper') {
        if (pb.def.entities.length) this.warn('r12.layout_dropped', 'R12에는 배치가 하나뿐이라 다른 배치를 쓰지 않았습니다.', pb.name);
        continue;
      }
      this.blocks.push(pb);
      this.blockByKey.set(key, pb);
    }
    if (!this.blockByKey.has(MODEL_SPACE)) {
      const pb = make(MODEL_SPACE, undefined, undefined);
      pb.name = '*Model_Space';
      pb.def.name = pb.rec.name = pb.name;
      this.blocks.unshift(pb);
      this.blockByKey.set(MODEL_SPACE, pb);
    }
    if (!this.blockByKey.has(PAPER_SPACE)) {
      const pb = make(PAPER_SPACE, undefined, undefined);
      pb.name = '*Paper_Space';
      pb.def.name = pb.rec.name = pb.name;
      this.blocks.splice(1, 0, pb);
      this.blockByKey.set(PAPER_SPACE, pb);
    }
    this.model = this.blockByKey.get(MODEL_SPACE)!;
    this.active = this.blockByKey.get(PAPER_SPACE)!;
    // 순서: 모형, 활성 배치, 다른 배치, 일반 블록
    const rank = (b: PlannedBlock) => (b.kind === 'model' ? 0 : b.kind === 'active' ? 1 : b.kind === 'paper' ? 2 : 3);
    this.blocks = this.blocks.map((b, i) => [b, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);

    // 객체를 버전에 맞게 바꾸고 참조를 모은다.
    for (const pb of this.blocks) {
      const out: Entity[] = [];
      for (const e of pb.def.entities) {
        const conv = convertEntity(e, this);
        let list = conv ?? [e];
        list = list.map((x) => this.nameDimBlock(x));
        if (list.length !== 1 || list[0] !== e) this.converted.set(e, list);
        for (const x of list) {
          out.push(x);
          this.collectRefs(x);
        }
      }
      pb.entities = out;
    }
    // 없는 블록을 가리키는 INSERT·DIMENSION·표 → 빈 블록 정의를 만든다.
    for (const [key, name] of this.refBlocks) {
      if (this.blockByKey.has(key)) continue;
      const pb = make(key, undefined, undefined);
      pb.name = pb.def.name = pb.rec.name = name;
      if (name.startsWith('*')) pb.def.flags |= 1;
      this.blocks.push(pb);
      this.blockByKey.set(key, pb);
      this.warn('block.missing', '없는 블록을 가리키는 객체가 있어 빈 블록 정의를 만들었습니다.', name);
    }
  }

  private collectRefs(e: Entity): void {
    const lt = e.linetype;
    if (lt) this.refLtypes.add(tableKey(lt));
    if (e.xdata) for (const x of e.xdata) this.refApps.add(x.app);
    switch (e.type) {
      case 'TEXT':
      case 'ATTDEF':
      case 'ATTRIB':
      case 'MTEXT':
        if (e.style) this.refStyles.add(tableKey(e.style));
        break;
      case 'INSERT':
        this.refBlock(e.block);
        for (const a of e.attribs) {
          if (a.style) this.refStyles.add(tableKey(a.style));
          if (a.linetype) this.refLtypes.add(tableKey(a.linetype));
          if (a.xdata) for (const x of a.xdata) this.refApps.add(x.app);
        }
        break;
      case 'DIMENSION':
        this.refBlock(e.block);
        break;
      case 'ACAD_TABLE':
        this.refBlock(e.block);
        break;
    }
  }

  /** 치수 그림 블록 이름이 없으면 익명 이름(*Dn)을 붙인 복사본(빈 블록은 refBlocks로 만든다) */
  private nameDimBlock(e: Entity): Entity {
    if (e.type !== 'DIMENSION' || e.block) return e;
    let n = 1;
    while (this.doc.blocks.has(`*D${n}`) || this.refBlocks.has(`*D${n}`)) n++;
    return { ...e, block: `*D${n}` };
  }

  private refBlock(name: string): void {
    if (!name) return;
    const key = tableKey(name);
    if (!this.refBlocks.has(key)) this.refBlocks.set(key, name);
  }

  private claimBlocks(): void {
    for (const pb of this.blocks) {
      pb.recH = this.claim(pb.rec, pb.rec.handle || pb.def.recordHandle);
      pb.beginH = this.claim(pb.def, pb.def.handle);
      pb.endH = this.claim({ end: pb.def }, pb.def.endHandle);
      this.live.add(pb.recH).add(pb.beginH).add(pb.endH);
      this.blockByRecH.set(pb.recH, pb);
    }
  }

  private planLayouts(): void {
    if (this.ver <= 1009) return;
    const used = new Set<PlannedBlock>();
    const names = new Set<string>();
    for (const l of this.doc.layouts) {
      let pb = this.blockByKey.get(tableKey(l.blockName));
      if (!pb && l.blockRecord) pb = this.blocks.find((b) => b.rec.handle === l.blockRecord);
      if (!pb && l.name.toUpperCase() === 'MODEL') pb = this.model;
      if (!pb || pb.kind === 'block') {
        this.warn('layout.no_block', '블록이 없는 배치를 쓰지 않았습니다.', l.name);
        continue;
      }
      if (used.has(pb)) {
        this.warn('layout.duplicate', '같은 블록을 쓰는 배치가 둘 이상이라 하나만 썼습니다.', l.name);
        continue;
      }
      used.add(pb);
      names.add(l.name.toUpperCase());
      const pl: PlannedLayout = { layout: l, h: '', block: pb };
      const lo = l.handle ? this.doc.objects.get(l.handle) : undefined;
      if (lo && lo.type === 'LAYOUT') pl.obj = lo as LayoutObject;
      pb.layout = pl;
      this.layouts.push(pl);
    }
    // 배치가 없는 모형·배치 블록
    let n = 1;
    for (const pb of this.blocks) {
      if (pb.kind === 'block' || pb.layout) continue;
      let name: string;
      if (pb.kind === 'model') name = 'Model';
      else {
        while (names.has(`LAYOUT${n}`)) n++;
        name = `Layout${n}`;
      }
      names.add(name.toUpperCase());
      const tab = pb.kind === 'model' ? 0 : Math.max(0, ...this.layouts.map((x) => x.layout.tabOrder)) + 1;
      const l = defaultLayout(name, pb.name, tab);
      l.flags = pb.kind === 'model' ? 1 : 1;
      const pl: PlannedLayout = { layout: l, h: '', block: pb };
      pb.layout = pl;
      this.layouts.push(pl);
    }
    this.layouts.sort((a, b) => (a.block.kind === 'model' ? -1 : b.block.kind === 'model' ? 1 : a.layout.tabOrder - b.layout.tabOrder));
    for (const pl of this.layouts) {
      // 문서의 LAYOUT 객체와 같은 핸들
      pl.h = this.claim(pl.layout, pl.layout.handle);
      this.live.add(pl.h);
    }
  }

  private claimEntities(): void {
    for (const pb of this.blocks) {
      for (const e of pb.entities) {
        const h = this.claim(e, e.handle);
        this.live.add(h);
        if (e.type === 'INSERT') for (const a of e.attribs) this.live.add(this.claim(a, a.handle));
      }
    }
  }

  /** 객체를 담은 블록(배치 블록이면 종이 공간) */
  blockOf(recH: string): PlannedBlock | undefined {
    return this.blockByRecH.get(recH);
  }

  // -------------------------------------------------------------------------
  // 표

  private planTables(): void {
    const d = this.doc;
    const r12 = this.ver <= 1009;
    // 선종류: ByBlock, ByLayer, Continuous가 먼저
    const lts = [...d.linetypes.values()];
    const first = ['BYBLOCK', 'BYLAYER', 'CONTINUOUS'];
    const ltList: Linetype[] = [];
    for (const k of first) {
      const found = lts.find((l) => tableKey(l.name) === k);
      ltList.push(found ?? { name: k === 'BYBLOCK' ? 'ByBlock' : k === 'BYLAYER' ? 'ByLayer' : 'Continuous', handle: '', flags: 0, description: k === 'CONTINUOUS' ? 'Solid line' : '', patternLength: 0, elements: [] });
    }
    for (const l of lts) if (!first.includes(tableKey(l.name))) ltList.push(l);
    // 도면층
    const layers = [...d.layers.values()];
    const l0 = layers.find((l) => l.name === '0');
    const layerList: Layer[] = [
      l0 ?? { name: '0', handle: '', flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 },
      ...layers.filter((l) => l !== l0),
    ];
    for (const l of layerList) this.refLtypes.add(tableKey(l.linetype || 'Continuous'));
    // 문자 스타일
    const styles = [...d.textStyles.values()];
    if (!styles.some((s) => tableKey(s.name) === 'STANDARD')) styles.unshift(placeholderStyle('Standard'));
    // 치수 스타일
    const dims = [...d.dimStyles.values()];
    if (!dims.some((s) => tableKey(s.name) === 'STANDARD')) dims.unshift({ name: 'Standard', handle: '', flags: 0, vars: {} });
    for (const s of dims) {
      const v = s.vars;
      if (typeof v.DIMTXSTY === 'string' && v.DIMTXSTY) this.refStyles.add(tableKey(v.DIMTXSTY));
      for (const k of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2']) if (typeof v[k] === 'string' && v[k]) this.refLtypes.add(tableKey(v[k] as string));
      if (s.xdata) for (const x of s.xdata) this.refApps.add(x.app);
    }
    // 다중선 스타일의 선종류
    for (const o of d.objects.values()) {
      if (o.type === 'MLINESTYLE') for (const el of (o as MLineStyleObject).elements) if (el.linetype) this.refLtypes.add(tableKey(el.linetype));
      if (o.xdata) for (const x of o.xdata) this.refApps.add(x.app);
    }
    // 없는 선종류·문자 스타일 → 자리 표시 항목
    const ltKeys = new Set(ltList.map((l) => tableKey(l.name)));
    for (const k of this.refLtypes) {
      if (k === 'BYLAYER' || k === 'BYBLOCK' || ltKeys.has(k)) continue;
      const nm = this.findName(k) ?? k;
      ltList.push({ name: nm, handle: '', flags: 0, description: '', patternLength: 0, elements: [] });
      ltKeys.add(k);
      this.warn('table.linetype_missing', '정의가 없는 선종류를 빈 선종류(실선)로 만들었습니다.', nm);
    }
    const stKeys = new Set(styles.map((s) => tableKey(s.name)));
    for (const k of this.refStyles) {
      if (stKeys.has(k)) continue;
      const nm = this.findName(k) ?? k;
      styles.push(placeholderStyle(nm));
      stKeys.add(k);
      this.warn('table.style_missing', '정의가 없는 문자 스타일을 기본 글꼴로 만들었습니다.', nm);
    }
    // APPID
    const apps = [...d.appIds.values()];
    for (const l of layerList) if (l.xdata) for (const x of l.xdata) this.refApps.add(x.app);
    for (const s of styles) if (s.xdata) for (const x of s.xdata) this.refApps.add(x.app);
    for (const s of d.vports) if (s.xdata) for (const x of s.xdata) this.refApps.add(x.app);
    for (const s of d.blockRecords.values()) if (s.xdata) for (const x of s.xdata) this.refApps.add(x.app);
    if (layerList.some((l) => l.transparency !== 255 && l.transparency >= 0)) this.refApps.add('AcCmTransparency');
    if (layerList.some((l) => l.description)) this.refApps.add('AcAecLayerStandard');
    this.refApps.add('ACAD');
    const appKeys = new Set(apps.map((a) => tableKey(a.name)));
    if (!appKeys.has('ACAD')) {
      apps.unshift({ name: 'ACAD', handle: '', flags: 0 });
      appKeys.add('ACAD');
    }
    for (const a of this.refApps) {
      const k = tableKey(a);
      if (appKeys.has(k)) continue;
      apps.push({ name: a, handle: '', flags: 0 });
      appKeys.add(k);
    }
    // 뷰포트
    const vports = d.vports.length ? [...d.vports] : [defaultVport()];
    if (!vports.some((v) => tableKey(v.name) === '*ACTIVE')) vports.unshift(defaultVport());

    // 표 머리 핸들
    for (const t of TABLE_NAMES) {
      if (r12 && t === 'BLOCK_RECORD') continue;
      const head = d.tableHeads?.get(t);
      // 관례 핸들(1~A)은 문서의 다른 객체가 쓰지 않을 때만 붙인다.
      const std = this.docHandles.has(STD_TABLE_HANDLES[t]) ? undefined : STD_TABLE_HANDLES[t];
      const h = this.claim({ table: t }, head?.handle || std);
      this.tableHeads.set(t, h);
      this.live.add(h);
    }
    const plan = <T extends TableRecordBase>(list: T[], map?: Map<string, string>): PlannedRecord<T>[] => {
      const out: PlannedRecord<T>[] = [];
      const seenNames = new Set<string>();
      for (const rec of list) {
        const key = rec.name ? tableKey(rec.name) : `*${rec.handle}`;
        if (rec.name && seenNames.has(key)) continue;
        seenNames.add(key);
        const h = this.claim(rec, rec.handle);
        this.live.add(h);
        if (map && rec.name) map.set(key, h);
        out.push({ rec, h });
      }
      return out;
    };
    this.vports = plan(vports);
    this.ltypes = plan(ltList, this.ltypeH);
    this.layers = plan(layerList, this.layerH);
    this.styles = plan(styles, this.styleH);
    this.views = plan([...d.views.values()]);
    this.ucs = plan([...d.ucs.values()]);
    this.appids = plan(apps);
    for (const a of this.appids) this.appidSet.add(tableKey(a.rec.name));
    this.dimstyles = plan(dims, this.dimstyleH);
  }

  /** 대문자 키 → 원래 이름(객체에서 찾는다) */
  private findName(key: string): string | undefined {
    for (const pb of this.blocks) {
      for (const e of pb.entities) {
        if (tableKey(e.linetype) === key) return e.linetype;
        const st = (e as { style?: string }).style;
        if (st && tableKey(st) === key) return st;
      }
    }
    return undefined;
  }

  /** 치수 스타일 이름(없으면 Standard) */
  dimStyleName(name: string | undefined): string {
    if (name && this.dimstyleH.has(tableKey(name))) return name;
    if (name) this.warn('dimstyle.missing', '정의가 없는 치수 스타일을 Standard로 바꿨습니다.', name);
    return this.dimstyles.find((d) => tableKey(d.rec.name) === 'STANDARD')?.rec.name ?? 'Standard';
  }

  // -------------------------------------------------------------------------
  // OBJECTS

  private planObjects(): void {
    const d = this.doc;
    const objs = d.objects;
    // 어떤 사전의 항목인 객체(소유자를 그 사전으로 고칠 수 있다)
    const dictRefs = new Set<string>();
    for (const o of objs.values()) {
      if (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') for (const h of (o as DictionaryObject).entries.values()) dictRefs.add(h.toUpperCase());
    }
    const state = new Map<string, boolean>();
    const decide = (o: CadObject): boolean => {
      const cached = state.get(o.handle);
      if (cached !== undefined) return cached;
      state.set(o.handle, false); // 순환 방지
      let ok = this.objectSupported(o);
      if (ok && o.owner && o.owner !== '0' && o.handle !== d.rootDictionary) {
        const owner = objs.get(o.owner);
        if (owner && (owner.type === 'LAYOUT' || owner.type === 'IMAGEDEF_REACTOR')) ok = this.live.has(o.owner);
        else if (owner) ok = decide(owner);
        else if (this.live.has(o.owner.toUpperCase())) ok = true;
        // 쓰지 않는 객체(뺀 도형 등)나 없는 객체가 소유한 객체는 뺀다. 사전 항목이면 그 사전으로 소유자를 고친다.
        else ok = dictRefs.has(o.handle.toUpperCase());
      }
      state.set(o.handle, ok);
      return ok;
    };
    const keep: CadObject[] = [];
    for (const o of objs.values()) {
      if (!o.handle) continue;
      if (o.type === 'LAYOUT' || o.type === 'IMAGEDEF_REACTOR') continue; // 배치·반응자는 따로 쓴다
      if (decide(o)) keep.push(o);
      else if (this.objectSupported(o)) this.warn('object.orphan_dropped', '소유 객체를 쓰지 않는 객체를 뺐습니다.', o.type);
    }
    // 루트 사전
    let root = d.rootDictionary ? objs.get(d.rootDictionary) : undefined;
    if (!root || root.type !== 'DICTIONARY' || !keep.includes(root)) {
      root = { type: 'DICTIONARY', handle: '', entries: new Map(), hardOwner: false, cloning: 1 } as DictionaryObject;
      keep.unshift(root);
      if (d.objects.size) this.warn('object.root_created', '루트 사전이 없어 새로 만들었습니다.');
    } else {
      keep.splice(keep.indexOf(root), 1);
      keep.unshift(root);
    }
    const planned = new Map<CadObject, PlannedObject>();
    const add = (o: CadObject, synthetic = false): PlannedObject => {
      const h = this.claim(o, o.handle);
      const p: PlannedObject = { obj: o, h, owner: '', synthetic };
      this.live.add(h);
      planned.set(o, p);
      this.objByH.set(h, p);
      this.objects.push(p);
      return p;
    };
    for (const o of keep) add(o);
    const rootP = planned.get(root)!;
    this.rootH = rootP.h;
    rootP.owner = '0';

    // 사전 항목(쓸 객체만)
    for (const p of this.objects) {
      const o = p.obj;
      if (o.type !== 'DICTIONARY' && o.type !== 'ACDBDICTIONARYWDFLT') continue;
      const list: [string, string][] = [];
      for (const [k, h] of (o as DictionaryObject).entries) {
        if (this.objByH.has(h) || this.live.has(h)) list.push([k, h]);
        else if (objs.get(h)?.type === 'LAYOUT') continue; // 배치 사전은 배치 목록으로 다시 만든다
        else this.warn('dictionary.entry_dropped', '쓰지 않는 객체를 가리키는 사전 항목을 뺐습니다.', k);
      }
      this.dictEntries.set(p.h, list);
    }
    const rootEntries = this.dictEntries.get(this.rootH)!;
    const findEntry = (list: [string, string][], name: string) => list.find(([k]) => k.toUpperCase() === name.toUpperCase());
    const ensureDict = (name: string, wdflt = false): PlannedObject => {
      const e = findEntry(rootEntries, name);
      if (e) {
        const p = this.objByH.get(e[1]);
        if (p && (p.obj.type === 'DICTIONARY' || p.obj.type === 'ACDBDICTIONARYWDFLT')) return p;
      }
      const o = { type: wdflt ? 'ACDBDICTIONARYWDFLT' : 'DICTIONARY', handle: '', entries: new Map(), hardOwner: false, cloning: 1 } as DictionaryObject;
      const p = add(o, true);
      p.owner = this.rootH;
      this.dictEntries.set(p.h, []);
      if (e) e[1] = p.h;
      else rootEntries.push([name, p.h]);
      return p;
    };
    const addTo = (dict: PlannedObject, name: string, o: CadObject): PlannedObject => {
      const p = add(o, true);
      p.owner = dict.h;
      this.dictEntries.get(dict.h)!.push([name, p.h]);
      return p;
    };

    ensureDict('ACAD_GROUP');
    // 배치 사전: 배치 목록으로 다시 만든다.
    const layoutDict = ensureDict('ACAD_LAYOUT');
    this.dictEntries.set(
      layoutDict.h,
      this.layouts.map((pl) => [pl.layout.name, pl.h]),
    );
    for (const pl of this.layouts) this.layoutOwner.set(pl.h, layoutDict.h);
    // 다중선 스타일
    const mlDict = ensureDict('ACAD_MLINESTYLE');
    for (const [k, h] of this.dictEntries.get(mlDict.h)!) {
      if (this.objByH.get(h)?.obj.type === 'MLINESTYLE') this.mlineStyleH.set(tableKey(k), h);
    }
    for (const p of this.objects) {
      if (p.obj.type === 'MLINESTYLE') {
        const k = tableKey((p.obj as MLineStyleObject).name);
        if (!this.mlineStyleH.has(k)) this.mlineStyleH.set(k, p.h);
      }
    }
    if (!this.mlineStyleH.has('STANDARD')) {
      const p = addTo(mlDict, 'Standard', standardMLineStyle());
      this.mlineStyleH.set('STANDARD', p.h);
    }
    this.mlineStandardH = this.mlineStyleH.get('STANDARD')!;
    ensureDict('ACAD_PLOTSETTINGS');
    // 플롯 스타일 이름 사전(기본값 Normal)
    const psDict = ensureDict('ACAD_PLOTSTYLENAME', true);
    const psEntries = this.dictEntries.get(psDict.h)!;
    let normal = findEntry(psEntries, 'Normal');
    if (!normal) {
      const p = addTo(psDict, 'Normal', { type: 'ACDBPLACEHOLDER', handle: '' } as GenericObject);
      normal = ['Normal', p.h];
    }
    this.plotStyleNormalH = normal[1];
    if (psDict.obj.type === 'ACDBDICTIONARYWDFLT') this.dictDefault.set(psDict.h, this.isLive((psDict.obj as DictionaryObject).defaultHandle) ? (psDict.obj as DictionaryObject).defaultHandle!.toUpperCase() : normal[1]);

    if (this.ver >= 1021) {
      const mlsDict = ensureDict('ACAD_MLEADERSTYLE');
      const std = findEntry(this.dictEntries.get(mlsDict.h)!, 'Standard');
      if (std && this.objByH.get(std[1])?.obj.type === 'MLEADERSTYLE') this.mleaderStandardH = std[1];
      else {
        const p = addTo(mlsDict, 'Standard', standardMLeaderStyle(this.styleH.get('STANDARD') ?? ''));
        this.mleaderStandardH = p.h;
      }
    }
    // 표 스타일: 표가 있거나 문서에 이미 있으면
    if (this.ver >= 1018) {
      const hasTable = this.blocks.some((b) => b.entities.some((e) => e.type === 'ACAD_TABLE'));
      const tsEntry = findEntry(rootEntries, 'ACAD_TABLESTYLE');
      if (hasTable || tsEntry) {
        const tsDict = ensureDict('ACAD_TABLESTYLE');
        const std = findEntry(this.dictEntries.get(tsDict.h)!, 'Standard');
        if (std && this.objByH.get(std[1])?.obj.type === 'TABLESTYLE') this.tableStyleStandardH = std[1];
        else if (hasTable) {
          const p = addTo(tsDict, 'Standard', standardTableStyle(this.ver, d.header.get('$MEASUREMENT') === 1));
          this.tableStyleStandardH = p.h;
        }
      }
    }

    // 소유자: 문서 값이 쓸 객체면 그대로, 아니면 그 객체를 담은 사전, 그것도 없으면 루트 사전
    const dictOf = new Map<string, string>();
    for (const [dh, list] of this.dictEntries) for (const [, h] of list) if (!dictOf.has(h)) dictOf.set(h, dh);
    for (const p of this.objects) {
      if (p.owner) continue;
      const o = p.obj.owner?.toUpperCase();
      if (o && this.live.has(o) && o !== p.h) p.owner = o;
      else p.owner = dictOf.get(p.h) ?? this.rootH;
    }

    // IMAGE ↔ IMAGEDEF_REACTOR
    for (const pb of this.blocks) {
      for (const e of pb.entities) {
        if (e.type !== 'IMAGE') continue;
        const img = e as ImageEntity;
        const eh = this.hOf(img);
        const def = img.imageDef ? this.objByH.get(img.imageDef.toUpperCase()) : undefined;
        if (!def || def.obj.type !== 'IMAGEDEF') continue;
        const r = { type: 'IMAGEDEF_REACTOR', handle: img.imageDefReactor ?? '' } as GenericObject;
        const p = add(r, true);
        p.owner = eh;
        this.imageReactor.set(eh, p.h);
        const list = this.imageDefReactors.get(def.h) ?? [];
        list.push(p.h);
        this.imageDefReactors.set(def.h, list);
      }
    }
    // 그룹: 쓸 객체만 남긴다(비면 뺀다).
    for (const p of [...this.objects]) {
      if (p.obj.type !== 'GROUP') continue;
      const g = p.obj as GroupObject;
      const members = g.entities.map((h) => h.toUpperCase()).filter((h) => this.live.has(h) && !this.objByH.has(h));
      if (!members.length) {
        this.dropObject(p);
        this.warn('group.empty_dropped', '쓸 객체가 없는 그룹을 뺐습니다.');
        continue;
      }
      this.groupMembers.set(p.h, members);
      for (const h of members) {
        const list = this.groupReactors.get(h) ?? [];
        list.push(p.h);
        this.groupReactors.set(h, list);
      }
    }
  }

  /** 사전 → 기본값 핸들(ACDBDICTIONARYWDFLT) */
  readonly dictDefault = new Map<string, string>();
  readonly groupMembers = new Map<string, string[]>();
  readonly layoutOwner = new Map<string, string>();

  private dropObject(p: PlannedObject): void {
    this.objects.splice(this.objects.indexOf(p), 1);
    this.objByH.delete(p.h);
    this.live.delete(p.h);
    for (const list of this.dictEntries.values()) {
      const i = list.findIndex(([, h]) => h === p.h);
      if (i >= 0) list.splice(i, 1);
    }
  }

  private readonly supported = new Map<CadObject, boolean>();

  /** 이 버전으로 쓸 수 있는 객체인지(경고는 한 번만) */
  private objectSupported(o: CadObject): boolean {
    let ok = this.supported.get(o);
    if (ok === undefined) {
      ok = this.checkObject(o);
      this.supported.set(o, ok);
    }
    return ok;
  }

  private checkObject(o: CadObject): boolean {
    const min = OBJECT_MIN_VERSION[o.type];
    if (min && this.ver < min) return false;
    switch (o.type) {
      case 'DICTIONARY':
      case 'ACDBDICTIONARYWDFLT':
      case 'MLINESTYLE':
      case 'IMAGEDEF':
      case 'PDFDEFINITION':
      case 'DWFDEFINITION':
      case 'DGNDEFINITION':
      case 'SORTENTSTABLE':
      case 'GROUP':
      case 'SPATIAL_FILTER':
      case 'MLEADERSTYLE':
      case 'SCALE':
      case 'PLOTSETTINGS':
        return true;
      case 'XRECORD':
        if (!rawTagsValid((o as XRecordObject).data)) {
          this.warn('object.corrupt_dropped', '값이 잘못된 원본 자료를 담은 객체를 쓰지 않았습니다.', o.type);
          return false;
        }
        return true;
      default: {
        if (SYNTH_GENERIC.has(o.type) && !(o as GenericObject).raw) return true;
        // DWG의 색상표 색(DBCOLOR)은 원본 태그 없이 색으로 쓴다.
        if (o.type === 'DBCOLOR' && !(o as GenericObject).raw && (o as GenericObject).color) return true;
        const raw = (o as GenericObject).raw;
        if (!raw) {
          this.warn('object.no_data', '내용을 알 수 없는 객체(DWG에서 해석하지 않은 종류)를 쓰지 않았습니다.', o.type);
          return false;
        }
        if (!rawTagsValid(raw)) {
          this.warn('object.corrupt_dropped', '값이 잘못된 원본 자료를 담은 객체를 쓰지 않았습니다.', o.type);
          return false;
        }
        return true;
      }
    }
  }

  /** 문서에 이미 있는 IMAGEDEF·밑그림 정의 */
  hasObjectOfType(h: string | undefined, types: string[]): boolean {
    if (!h) return false;
    const o = this.doc.objects.get(h.toUpperCase());
    return !!o && types.includes(o.type);
  }
}

function placeholderStyle(name: string): TextStyle {
  return { name, handle: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'txt', bigFont: '' };
}

export function defaultVport(): VPortRecord {
  return {
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
    height: 10,
    aspect: 1.5,
    lensLength: 50,
    twist: 0,
  };
}

export function standardMLineStyle(): MLineStyleObject {
  return {
    type: 'MLINESTYLE',
    handle: '',
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
}

export function standardMLeaderStyle(textStyle: string): MLeaderStyleObject {
  return {
    type: 'MLEADERSTYLE',
    handle: '',
    name: 'Standard',
    contentType: 2,
    leaderLineType: 1,
    leaderLineColor: { aci: 0 },
    leaderLineWeight: -2,
    landing: true,
    doglegLength: 0.36,
    arrowSize: 0.18,
    textStyleHandle: textStyle || undefined,
    textHeight: 0.18,
    textColor: { aci: 0 },
    landingGap: 0.09,
    scale: 1,
  };
}

/** Standard 표 스타일(옛 셀 형식: 제목·머리·자료 세 줄 종류) */
export function standardTableStyle(ver: number, metric = false): GenericObject {
  const h = metric ? 4.5 : 0.18;
  const titleH = metric ? 6 : 0.25;
  const margin = metric ? 1.5 : 0.06;
  const raw: RawTag[] = [{ code: 100, value: 'AcDbTableStyle' }];
  if (ver >= 1024) raw.push({ code: 280, value: 0 });
  raw.push(
    { code: 3, value: 'Standard' },
    { code: 70, value: 0 },
    { code: 71, value: 0 },
    { code: 40, value: margin },
    { code: 41, value: margin },
    { code: 280, value: 0 },
    { code: 281, value: 0 },
  );
  for (const [height, align] of [
    [h, 2],
    [titleH, 5],
    [h, 5],
  ] as const) {
    raw.push(
      { code: 7, value: 'Standard' },
      { code: 140, value: height },
      { code: 170, value: align },
      { code: 62, value: 0 },
      { code: 63, value: 7 },
      { code: 283, value: 0 },
    );
    if (ver >= 1021) raw.push({ code: 90, value: 512 }, { code: 91, value: 0 }, { code: 1, value: '' });
    for (let i = 0; i < 6; i++) raw.push({ code: 274 + i, value: -2 }, { code: 284 + i, value: 1 }, { code: 64 + i, value: 0 });
  }
  return { type: 'TABLESTYLE', handle: '', raw };
}

export function isLayoutObject(o: CadObject): o is LayoutObject {
  return o.type === 'LAYOUT';
}

export function isImageDef(o: CadObject): o is ImageDefObject {
  return o.type === 'IMAGEDEF';
}
