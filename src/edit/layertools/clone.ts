/**
 * 다른 도면의 정의를 이 도면으로 복사하는 편집 작업(디자인센터·도면층 변환기·CAD 표준이 함께 쓴다).
 *
 * - 대상: 블록, 도면층, 선종류, 문자 스타일, 치수 스타일, 다중 지시선 스타일, 테이블 스타일, 배치.
 * - 이 도면에 같은 이름의 정의가 이미 있으면 이 도면의 것을 그대로 쓴다(AutoCAD 디자인센터·붙여넣기와 같다).
 * - 정의가 쓰는 도면층·선종류·문자 스타일·중첩 블록도 함께 온다. 익명 블록(*D·*T·*U…)은 이 도면에서 비어 있는 번호로 바꾼다.
 * - 원본 핸들은 새 핸들로 바꾼다. 원본 도면의 다른 객체를 가리키는 연결(확장 사전, 반응자, 이미지 정의 등)은 끊는다.
 *
 * 작업은 finish()로 받는다(사전 항목 갱신은 사전마다 하나로 모아 맨 끝에 둔다).
 */
import type {
  AttribEntity,
  BlockDef,
  BlockRecord,
  CadDocument,
  DictionaryObject,
  DimStyle,
  Entity,
  GenericObject,
  Layer,
  Layout,
  LayoutObject,
  Linetype,
  MLeaderStyleObject,
  RawTag,
  TextStyle,
  XData,
} from '../../core/model';
import { MODEL_SPACE, normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { isLayoutBlock } from '../session';
import { cloneTableStyle, docVersionNumber, listTableStyles, tableStyleDictionary, tableStyleRaw } from '../table/style';

export type DefKind = 'block' | 'layer' | 'linetype' | 'textStyle' | 'dimStyle' | 'mleaderStyle' | 'tableStyle' | 'layout';

export const DEF_KINDS: readonly DefKind[] = ['block', 'dimStyle', 'layer', 'layout', 'linetype', 'mleaderStyle', 'tableStyle', 'textStyle'];

export const DEF_KIND_LABEL: Record<DefKind, string> = {
  block: '블록',
  layer: '도면층',
  linetype: '선종류',
  textStyle: '문자 스타일',
  dimStyle: '치수 스타일',
  mleaderStyle: '다중 지시선 스타일',
  tableStyle: '테이블 스타일',
  layout: '배치',
};

const SPECIAL_LT = /^(BYLAYER|BYBLOCK|CONTINUOUS)$/i;

function isDict(o: unknown): o is DictionaryObject {
  const t = (o as { type?: string } | undefined)?.type;
  return t === 'DICTIONARY' || t === 'ACDBDICTIONARYWDFLT';
}

/** 루트 사전 */
export function rootDictionary(doc: CadDocument): DictionaryObject | null {
  const h = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
  const o = h ? doc.objects.get(h) : undefined;
  return isDict(o) ? o : null;
}

/** 루트 사전의 이름 있는 사전(ACAD_MLEADERSTYLE 등) */
export function namedDictionary(doc: CadDocument, name: string): DictionaryObject | null {
  const root = rootDictionary(doc);
  if (!root) return null;
  for (const [k, h] of root.entries) {
    if (k.toUpperCase() !== name.toUpperCase()) continue;
    const o = doc.objects.get(normalizeHandle(h));
    return isDict(o) ? o : null;
  }
  return null;
}

/** 사전 항목을 이름(대소문자 무시)으로 */
function dictEntry(d: DictionaryObject | null, name: string): [string, string] | null {
  if (!d) return null;
  for (const [k, h] of d.entries) if (k.toUpperCase() === name.toUpperCase()) return [k, h];
  return null;
}

/** 다중 지시선 스타일(사전 순서): 이름과 객체 */
export function mleaderStyles(doc: CadDocument): { name: string; obj: MLeaderStyleObject }[] {
  const out: { name: string; obj: MLeaderStyleObject }[] = [];
  const d = namedDictionary(doc, 'ACAD_MLEADERSTYLE');
  const seen = new Set<string>();
  if (d)
    for (const [k, h] of d.entries) {
      const o = doc.objects.get(normalizeHandle(h));
      if (o?.type !== 'MLEADERSTYLE') continue;
      seen.add(o.handle);
      out.push({ name: k, obj: o as MLeaderStyleObject });
    }
  for (const o of doc.objects.values()) if (o.type === 'MLEADERSTYLE' && !seen.has(o.handle)) out.push({ name: (o as MLeaderStyleObject).name || `MLeaderStyle_${o.handle}`, obj: o as MLeaderStyleObject });
  return out;
}

/** 배치 사전(ACAD_LAYOUT, 없으면 LAYOUT 객체를 가진 사전) */
export function layoutDictionary(doc: CadDocument): DictionaryObject | null {
  const d = namedDictionary(doc, 'ACAD_LAYOUT');
  if (d) return d;
  for (const o of doc.objects.values()) if (isDict(o) && [...o.entries.values()].some((h) => doc.objects.get(normalizeHandle(h))?.type === 'LAYOUT')) return o;
  return null;
}

/** AutoCAD 표준 화살촉 블록 이름(치수 스타일이 쓰는 시스템 블록 — 디자인센터 목록에서 뺀다) */
const ARROW_BLOCKS = new Set(
  ['_ARCHTICK', '_BOXBLANK', '_BOXFILLED', '_CLOSED', '_CLOSEDBLANK', '_CLOSEDFILLED', '_DATUMBLANK', '_DATUMFILLED', '_DOT', '_DOTBLANK', '_DOTSMALL', '_INTEGRAL', '_NONE', '_OBLIQUE', '_OPEN', '_OPEN30', '_OPEN90', '_ORIGIN', '_ORIGIN2', '_SMALL'],
);

/** 표준 화살촉 블록인지 */
export function isArrowBlock(name: string): boolean {
  return ARROW_BLOCKS.has(tableKey(name));
}

/** 사용자가 고를 수 있는 블록 이름(배치·익명·외부 참조·외부 의존·표준 화살촉 블록 빼고, 이름 순) */
export function userBlockNames(doc: CadDocument): string[] {
  return [...doc.blocks.values()]
    .filter((b) => !b.name.startsWith('*') && !(b.flags & 4) && !b.name.includes('|') && !isLayoutBlock(tableKey(b.name)) && !isArrowBlock(b.name))
    .map((b) => b.name)
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 정의 종류별 이름 목록(디자인센터 트리) */
export function listDefinitions(doc: CadDocument, kind: DefKind): string[] {
  const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y, 'ko'));
  switch (kind) {
    case 'block':
      return userBlockNames(doc);
    case 'layer':
      return sort([...doc.layers.values()].filter((l) => !l.name.includes('|')).map((l) => l.name));
    case 'linetype':
      return sort([...doc.linetypes.values()].filter((l) => !/^(BYLAYER|BYBLOCK)$/i.test(l.name) && !l.name.includes('|')).map((l) => l.name));
    case 'textStyle':
      return sort([...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1) && !s.name.includes('|')).map((s) => s.name));
    case 'dimStyle':
      return sort([...doc.dimStyles.values()].filter((s) => !s.name.includes('|')).map((s) => s.name));
    case 'mleaderStyle':
      return sort(mleaderStyles(doc).map((s) => s.name));
    case 'tableStyle':
      return sort(listTableStyles(doc).map((s) => s.name));
    case 'layout':
      return [...doc.layouts].filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder).map((l) => l.name);
  }
}

/** 이 도면에 그 이름의 정의가 있는지 */
export function hasDefinition(doc: CadDocument, kind: DefKind, name: string): boolean {
  const key = tableKey(name);
  switch (kind) {
    case 'block':
      return doc.blocks.has(key);
    case 'layer':
      return doc.layers.has(key);
    case 'linetype':
      return doc.linetypes.has(key);
    case 'textStyle':
      return doc.textStyles.has(key);
    case 'dimStyle':
      return doc.dimStyles.has(key);
    case 'mleaderStyle':
      return mleaderStyles(doc).some((s) => tableKey(s.name) === key);
    case 'tableStyle':
      return listTableStyles(doc).some((s) => tableKey(s.name) === key);
    case 'layout':
      return doc.layouts.some((l) => tableKey(l.name) === key);
  }
}

type SrcRef = { kind: 'layer' | 'linetype' | 'textStyle' | 'dimStyle' | 'block' | 'mleaderStyle' | 'tableStyle'; name: string };

/** 핸들을 가리키는 그룹 코드(320~369, 390~399, 480·481, 1005) */
function isHandleCode(code: number): boolean {
  return (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || code === 480 || code === 481 || code === 1005;
}

/**
 * 한 원본 도면 → 이 도면 복사기. 같은 복사기로 여러 정의를 가져오면 의존 정의를 한 번만 만든다.
 */
export class DefinitionCopier {
  private readonly ops: EditOp[] = [];
  /** 새로 만든 정의(의존 정의 포함, 만든 순서) */
  readonly added: { kind: DefKind; name: string }[] = [];
  /** 원본 핸들 → 새 핸들(객체·속성 정의·블록 레코드·스타일) */
  readonly handles = new Map<string, string>();
  /** 옮기지 못해 뺀 객체 종류 → 수 */
  readonly skipped = new Map<string, number>();
  /** `${종류}:${대문자 이름}` → 이 도면의 이름 */
  private readonly names = new Map<string, string>();
  /** `${종류}:${대문자 이름}` → 새로 만든 기록의 핸들 */
  private readonly newRecords = new Map<string, string>();
  /** 이 복사기가 만든 블록 이름(대문자) */
  private readonly newBlocks = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly dicts = new Map<string, { before: DictionaryObject; after: DictionaryObject }>();
  private srcIndex: Map<string, SrcRef> | null = null;
  private layoutBlocks = new Set<string>();
  private layoutNames = new Set<string>();
  private tabOrder = -1;

  constructor(
    readonly src: CadDocument,
    readonly dst: CadDocument,
    readonly newHandle: () => string,
  ) {}

  /** 지금까지의 작업(정의 추가 → 사전 갱신 순) */
  finish(): EditOp[] {
    const out = [...this.ops];
    for (const d of this.dicts.values()) out.push({ kind: 'object', key: d.before.handle, before: d.before, after: d.after });
    return out;
  }

  /** 아직 작업이 없는지 */
  get empty(): boolean {
    return this.ops.length === 0 && this.dicts.size === 0;
  }

  /** 정의 하나를 가져온다. 이 도면에 이미 있으면 'exists', 원본에 없으면 'missing' */
  copy(kind: DefKind, name: string): 'added' | 'exists' | 'missing' {
    if (hasDefinition(this.dst, kind, name)) return 'exists';
    let r: string | null;
    switch (kind) {
      case 'block':
        r = this.src.blocks.has(tableKey(name)) ? this.block(name) : null;
        break;
      case 'layer':
        r = this.src.layers.has(tableKey(name)) ? this.layer(name) : null;
        break;
      case 'linetype':
        r = this.src.linetypes.has(tableKey(name)) ? (this.linetype(name) ?? null) : null;
        break;
      case 'textStyle':
        r = this.src.textStyles.has(tableKey(name)) ? this.textStyle(name) : null;
        break;
      case 'dimStyle':
        r = this.src.dimStyles.has(tableKey(name)) ? this.dimStyle(name) : null;
        break;
      case 'mleaderStyle':
        r = this.mleaderStyle(name);
        break;
      case 'tableStyle':
        r = this.tableStyle(name);
        break;
      case 'layout':
        r = this.layout(name);
        break;
    }
    return r === null ? 'missing' : 'added';
  }

  // -------------------------------------------------------------------------
  // 표 기록
  // -------------------------------------------------------------------------

  private memo(kind: string, name: string): string | undefined {
    return this.names.get(`${kind}:${tableKey(name)}`);
  }

  private remember(kind: string, name: string, dstName: string, handle?: string): void {
    this.names.set(`${kind}:${tableKey(name)}`, dstName);
    if (handle) this.newRecords.set(`${kind}:${tableKey(dstName)}`, handle);
  }

  /** 이 도면에서 쓸 도면층 이름(없으면 원본에서 복사, 원본에도 없으면 기본 도면층을 만든다) */
  layer(name: string | undefined): string {
    if (!name) return '0';
    const m = this.memo('layer', name);
    if (m !== undefined) return m;
    const key = tableKey(name);
    const have = this.dst.layers.get(key);
    if (have) {
      this.remember('layer', name, have.name);
      return have.name;
    }
    // 외부 참조 종속 도면층은 0으로(AutoCAD 결합과 달리 이름을 바꾸지 않는다)
    if (key.includes('|')) {
      this.remember('layer', name, '0');
      return '0';
    }
    const L = this.src.layers.get(key);
    const after: Layer = L
      ? { ...structuredClone(L), handle: this.newHandle(), flags: L.flags & ~(16 | 32 | 64) }
      : { name, handle: this.newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
    delete after.xdict;
    if (L?.handle) this.handles.set(normalizeHandle(L.handle), after.handle);
    this.remember('layer', name, after.name, after.handle);
    after.linetype = this.linetype(after.linetype) ?? 'Continuous';
    after.plotStyle = this.plotStyle(L?.plotStyle);
    if (after.plotStyle === undefined) delete after.plotStyle;
    this.ops.push({ kind: 'layer', key, before: null, after });
    this.added.push({ kind: 'layer', name: after.name });
    return after.name;
  }

  /** 이름 있는 플롯 스타일 핸들(이 도면의 같은 이름) */
  private plotStyle(h: string | undefined): string | undefined {
    if (!h) return undefined;
    const sd = namedDictionary(this.src, 'ACAD_PLOTSTYLENAME');
    const dd = namedDictionary(this.dst, 'ACAD_PLOTSTYLENAME');
    if (!sd || !dd) return undefined;
    const name = [...sd.entries].find(([, x]) => normalizeHandle(x) === normalizeHandle(h))?.[0];
    return name ? dictEntry(dd, name)?.[1] : undefined;
  }

  /** 이 도면에서 쓸 선종류 이름(없으면 복사). ByLayer·ByBlock은 그대로 */
  linetype(name: string | undefined): string | undefined {
    if (!name) return undefined;
    const key = tableKey(name);
    if (key === 'BYLAYER' || key === 'BYBLOCK') return name;
    const m = this.memo('linetype', name);
    if (m !== undefined) return m;
    const have = this.dst.linetypes.get(key);
    if (have) {
      this.remember('linetype', name, have.name);
      return have.name;
    }
    const L = this.src.linetypes.get(key);
    if (!L || key.includes('|')) {
      const fallback = SPECIAL_LT.test(name) ? name : 'Continuous';
      this.remember('linetype', name, fallback);
      return fallback;
    }
    const after: Linetype = { ...structuredClone(L), handle: this.newHandle(), flags: L.flags & ~(16 | 32 | 64) };
    delete after.xdict;
    if (L.handle) this.handles.set(normalizeHandle(L.handle), after.handle);
    this.remember('linetype', name, after.name, after.handle);
    for (const el of after.elements) {
      if (!el.styleHandle) continue;
      const h = this.textStyleByHandle(el.styleHandle);
      if (h) el.styleHandle = h;
      else delete el.styleHandle;
    }
    this.ops.push({ kind: 'linetype', key, before: null, after });
    this.added.push({ kind: 'linetype', name: after.name });
    return after.name;
  }

  /** 이 도면에서 쓸 문자 스타일 이름(없으면 복사, 원본에도 없으면 Standard) */
  textStyle(name: string | undefined): string {
    if (!name) return 'Standard';
    const m = this.memo('textStyle', name);
    if (m !== undefined) return m;
    const key = tableKey(name);
    const have = this.dst.textStyles.get(key);
    if (have) {
      this.remember('textStyle', name, have.name || name);
      return have.name || name;
    }
    const S = this.src.textStyles.get(key);
    if (!S || key.includes('|')) {
      const std = this.dst.textStyles.get('STANDARD')?.name ?? 'Standard';
      this.remember('textStyle', name, std);
      return std;
    }
    const after = this.copyTextStyle(S, key);
    this.remember('textStyle', name, after.name, after.handle);
    return after.name;
  }

  private copyTextStyle(S: TextStyle, key: string): TextStyle {
    const after: TextStyle = { ...structuredClone(S), handle: this.newHandle(), flags: S.flags & ~(16 | 32 | 64) };
    delete after.xdict;
    if (S.handle) this.handles.set(normalizeHandle(S.handle), after.handle);
    this.ops.push({ kind: 'textStyle', key: S.name ? key : `*SHAPE:${after.handle}`, before: null, after });
    if (S.name) this.added.push({ kind: 'textStyle', name: S.name });
    return after;
  }

  /** 원본 문자 스타일 핸들 → 이 도면의 문자 스타일 핸들(쉐이프 파일 항목 포함) */
  textStyleByHandle(h: string | undefined): string | undefined {
    if (!h) return undefined;
    const nh = normalizeHandle(h);
    const done = this.handles.get(nh);
    if (done) return done;
    const S = [...this.src.textStyles.values()].find((s) => s.handle && normalizeHandle(s.handle) === nh);
    if (!S) return undefined;
    if (!S.name) {
      // 쉐이프 파일 항목: 같은 파일을 가리키는 항목을 찾고, 없으면 복사
      const same = [...this.dst.textStyles.values()].find((s) => !s.name && s.flags & 1 && s.font.toUpperCase() === S.font.toUpperCase());
      if (same) {
        this.handles.set(nh, same.handle);
        return same.handle;
      }
      return this.copyTextStyle(S, '').handle;
    }
    const name = this.textStyle(S.name);
    return this.recordHandle('textStyle', name);
  }

  /** 이 도면에서 쓸 치수 스타일 이름(없으면 복사 — 문자 스타일·화살표 블록·선종류도 함께) */
  dimStyle(name: string | undefined): string {
    if (!name) return 'Standard';
    const m = this.memo('dimStyle', name);
    if (m !== undefined) return m;
    const key = tableKey(name);
    const have = this.dst.dimStyles.get(key);
    if (have) {
      this.remember('dimStyle', name, have.name);
      return have.name;
    }
    const D = this.src.dimStyles.get(key);
    if (!D || key.includes('|')) {
      const std = this.dst.dimStyles.get('STANDARD')?.name ?? 'Standard';
      this.remember('dimStyle', name, std);
      return std;
    }
    const after: DimStyle = { ...structuredClone(D), handle: this.newHandle(), flags: D.flags & ~(16 | 32 | 64) };
    delete after.xdict;
    if (D.handle) this.handles.set(normalizeHandle(D.handle), after.handle);
    this.remember('dimStyle', name, after.name, after.handle);
    const v = after.vars;
    if (typeof v.DIMTXSTY === 'string' && v.DIMTXSTY) v.DIMTXSTY = this.textStyle(v.DIMTXSTY);
    for (const k of ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK']) {
      const b = v[k];
      if (typeof b === 'string' && b && this.src.blocks.has(tableKey(b))) v[k] = this.block(b) ?? b;
    }
    for (const k of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2']) {
      const l = v[k];
      if (typeof l === 'string' && l) v[k] = this.linetype(l) ?? l;
    }
    this.ops.push({ kind: 'dimStyle', key, before: null, after });
    this.added.push({ kind: 'dimStyle', name: after.name });
    return after.name;
  }

  /** 이 도면에서 그 기록의 핸들(있던 것 또는 이 복사기가 만든 것) */
  recordHandle(kind: 'layer' | 'linetype' | 'textStyle' | 'dimStyle' | 'block', name: string): string | undefined {
    const key = tableKey(name);
    const made = this.newRecords.get(`${kind}:${key}`);
    if (made) return made;
    switch (kind) {
      case 'layer':
        return this.dst.layers.get(key)?.handle;
      case 'linetype':
        return this.dst.linetypes.get(key)?.handle;
      case 'textStyle':
        return this.dst.textStyles.get(key)?.handle;
      case 'dimStyle':
        return this.dst.dimStyles.get(key)?.handle;
      case 'block':
        return this.dst.blockRecords.get(key)?.handle ?? this.dst.blocks.get(key)?.recordHandle;
    }
  }

  // -------------------------------------------------------------------------
  // 블록
  // -------------------------------------------------------------------------

  /** 익명 블록의 새 이름(*D1, *U3 …) */
  private anonName(name: string): string {
    const prefix = /^\*[A-Z]+/i.exec(name)?.[0]?.toUpperCase() ?? '*U';
    for (let n = 1; ; n++) {
      const k = `${prefix}${n}`;
      if (!this.dst.blocks.has(k) && !this.newBlocks.has(k)) return k;
    }
  }

  /**
   * 이 도면에서 쓸 블록 이름(없으면 복사). 익명 블록은 늘 새로 만든다(새 이름).
   * 원본에 없거나 외부 참조 블록이면 null.
   */
  block(name: string): string | null {
    const key = tableKey(name);
    const m = this.memo('block', name);
    if (m !== undefined) return m;
    const def = this.src.blocks.get(key);
    if (!def || isLayoutBlock(key)) {
      if (this.dst.blocks.has(key)) return this.dst.blocks.get(key)!.name;
      return null;
    }
    const anon = def.name.startsWith('*');
    if (!anon && this.dst.blocks.has(key)) {
      const have = this.dst.blocks.get(key)!;
      this.remember('block', name, have.name);
      const rec = this.src.blockRecords.get(key)?.handle ?? def.recordHandle;
      if (rec) this.handles.set(normalizeHandle(rec), this.recordHandle('block', have.name) ?? have.recordHandle);
      return have.name;
    }
    if (def.flags & 4) return null;
    if (this.busy.has(key)) return anon ? null : def.name;
    this.busy.add(key);
    const newName = anon ? this.anonName(def.name) : def.name;
    const nkey = tableKey(newName);
    this.newBlocks.add(nkey);
    const recH = this.newHandle();
    const srcRec = this.src.blockRecords.get(key);
    for (const h of [srcRec?.handle, def.recordHandle]) if (h) this.handles.set(normalizeHandle(h), recH);
    this.remember('block', name, newName, recH);
    const ents = this.entities(def.entities, recH, false);
    const record: BlockRecord = srcRec
      ? { ...structuredClone(srcRec), name: newName, handle: recH }
      : { name: newName, handle: recH, flags: def.flags & 1, insertUnits: 0, explodable: true, scalable: true };
    delete record.layout;
    delete record.xdict;
    const copy: BlockDef = {
      ...structuredClone({ ...def, entities: [] as Entity[] }),
      name: newName,
      handle: this.newHandle(),
      recordHandle: recH,
      endHandle: this.newHandle(),
      flags: def.flags & ~(4 | 8 | 16 | 32 | 64),
      entities: ents,
    };
    delete copy.xrefPath;
    if (copy.layer) copy.layer = this.layer(copy.layer);
    this.ops.push({ kind: 'blockRecord', key: nkey, before: null, after: record }, { kind: 'blockDef', key: nkey, before: null, after: copy });
    if (!anon) this.added.push({ kind: 'block', name: newName });
    this.busy.delete(key);
    return newName;
  }

  // -------------------------------------------------------------------------
  // 객체
  // -------------------------------------------------------------------------

  private skip(type: string): void {
    this.skipped.set(type, (this.skipped.get(type) ?? 0) + 1);
  }

  /** 객체 여러 개를 복사하고 서로 가리키는 연결(연관 해치 경계·지시선 주석)을 새 핸들로 맞춘다 */
  entities(list: readonly Entity[], owner: string, paperSpace: boolean): Entity[] {
    const out: Entity[] = [];
    for (const e of list) {
      const c = this.entity(e, owner);
      if (!c) continue;
      if (paperSpace) c.paperSpace = true;
      else delete c.paperSpace;
      out.push(c);
    }
    for (const c of out) this.relink(c);
    return out;
  }

  /** 객체 하나를 이 도면용으로 복사(새 핸들). 옮길 수 없는 객체(파일을 가리키는 이미지 등)는 null */
  entity(e: Entity, owner: string): Entity | null {
    if ((e.type === 'IMAGE' && e.imageDef) || ((e.type === 'PDFUNDERLAY' || e.type === 'DWFUNDERLAY' || e.type === 'DGNUNDERLAY') && e.definition)) {
      this.skip(e.type);
      return null;
    }
    if (e.type === 'INSERT') {
      const b = this.block(e.block);
      if (b === null) {
        this.skip('INSERT');
        return null;
      }
    }
    const c = structuredClone(e) as Entity;
    c.handle = this.newHandle();
    if (e.handle) this.handles.set(normalizeHandle(e.handle), c.handle);
    c.owner = owner;
    this.common(c);
    switch (c.type) {
      case 'TEXT':
      case 'MTEXT':
        c.style = this.textStyle(c.style);
        break;
      case 'ATTDEF':
      case 'ATTRIB':
        this.attribRefs(c as AttribEntity);
        break;
      case 'INSERT':
        c.block = this.block(c.block) ?? c.block;
        c.attribs = c.attribs.map((a, i) => {
          const x = structuredClone(a);
          x.handle = this.newHandle();
          const src = (e as typeof c).attribs[i];
          if (src?.handle) this.handles.set(normalizeHandle(src.handle), x.handle);
          x.owner = c.handle;
          this.common(x);
          this.attribRefs(x);
          return x;
        });
        break;
      case 'DIMENSION':
        c.dimStyle = this.dimStyle(c.dimStyle);
        if (c.block) c.block = this.block(c.block) ?? '';
        break;
      case 'LEADER':
      case 'TOLERANCE':
        c.dimStyle = this.dimStyle(c.dimStyle);
        break;
      case 'MULTILEADER': {
        c.styleHandle = this.mleaderStyleByHandle(c.styleHandle);
        c.textStyleHandle = this.mapRef(c.textStyleHandle);
        c.arrowHeadHandle = this.mapRef(c.arrowHeadHandle);
        c.blockHandle = this.mapRef(c.blockHandle);
        c.leaderLineTypeHandle = this.mapRef(c.leaderLineTypeHandle);
        if (c.context.text) c.context.text.styleHandle = this.mapRef(c.context.text.styleHandle);
        if (c.context.block) c.context.block.blockHandle = this.mapRef(c.context.block.blockHandle);
        break;
      }
      case 'VIEWPORT':
        delete c.clipBoundary;
        c.frozenLayers = c.frozenLayers.map((n) => this.layer(n));
        break;
      case 'SHAPE':
        c.styleHandle = this.textStyleByHandle(c.styleHandle);
        break;
      case 'MLINE': {
        const ms = [...this.dst.objects.values()].find((o) => o.type === 'MLINESTYLE' && tableKey((o as { name: string }).name) === tableKey(c.styleName));
        if (ms) c.styleHandle = ms.handle;
        else {
          const std = [...this.dst.objects.values()].find((o) => o.type === 'MLINESTYLE' && tableKey((o as { name: string }).name) === 'STANDARD');
          c.styleName = std ? (std as { name: string }).name : c.styleName;
          c.styleHandle = std?.handle;
        }
        break;
      }
      case 'ACAD_TABLE':
        c.block = this.block(c.block) ?? c.block;
        c.tableStyle = this.tableStyleByHandle(c.tableStyle);
        break;
      default:
        break;
    }
    return c;
  }

  /** 모든 객체에 공통: 도면층·선종류, 원본 도면을 가리키는 연결 끊기 */
  private common(c: Entity): void {
    delete c.xdict;
    delete c.reactors;
    delete c.dwgRaw;
    delete c.plotStyle;
    delete c.material;
    c.layer = this.layer(c.layer);
    c.linetype = this.linetype(c.linetype) ?? 'ByLayer';
    if (c.xdata) c.xdata = this.mapXData(c.xdata);
  }

  private attribRefs(a: AttribEntity): void {
    a.style = this.textStyle(a.style);
    if (a.mtext) {
      a.mtext.style = this.textStyle(a.mtext.style);
      a.mtext.handle = '';
      delete a.mtext.xdict;
      delete a.mtext.reactors;
      delete a.mtext.dwgRaw;
    }
  }

  /** 함께 복사한 객체끼리의 연결을 새 핸들로(못 찾으면 연결을 끊는다) */
  private relink(c: Entity): void {
    if (c.type === 'HATCH' || c.type === 'MPOLYGON') {
      let lost = false;
      for (const p of c.paths) {
        if (!p.sources?.length) continue;
        const next = p.sources.map((h) => this.handles.get(normalizeHandle(h))).filter((h): h is string => !!h);
        if (next.length !== p.sources.length) lost = true;
        if (next.length) p.sources = next;
        else delete p.sources;
      }
      if (lost) {
        c.associative = false;
        for (const p of c.paths) delete p.sources;
      }
    } else if (c.type === 'LEADER' && c.annotation) {
      const h = this.handles.get(normalizeHandle(c.annotation));
      if (h) c.annotation = h;
      else delete c.annotation;
    } else if (c.type === 'MULTILEADER' && c.blockAttributes) {
      c.blockAttributes = c.blockAttributes.map((a) => ({ ...a, attdefHandle: this.handles.get(normalizeHandle(a.attdefHandle)) ?? a.attdefHandle }));
    }
  }

  /** 확장 자료의 핸들(1005)을 새 핸들로(모르는 핸들은 그대로) */
  private mapXData(list: XData[]): XData[] {
    return list.map((x) => ({
      app: x.app,
      items: x.items.map((it) => (it.code === 1005 && typeof it.value === 'string' ? { code: it.code, value: this.mapRef(it.value) ?? it.value } : it)),
    }));
  }

  /** 원본 핸들 → 종류와 이름 */
  private index(): Map<string, SrcRef> {
    if (this.srcIndex) return this.srcIndex;
    const m = new Map<string, SrcRef>();
    const put = (h: string | undefined, r: SrcRef) => {
      if (h) m.set(normalizeHandle(h), r);
    };
    for (const l of this.src.layers.values()) put(l.handle, { kind: 'layer', name: l.name });
    for (const l of this.src.linetypes.values()) put(l.handle, { kind: 'linetype', name: l.name });
    for (const s of this.src.textStyles.values()) if (s.name) put(s.handle, { kind: 'textStyle', name: s.name });
    for (const s of this.src.dimStyles.values()) put(s.handle, { kind: 'dimStyle', name: s.name });
    for (const b of this.src.blocks.values()) put(b.recordHandle, { kind: 'block', name: b.name });
    for (const r of this.src.blockRecords.values()) put(r.handle, { kind: 'block', name: r.name });
    for (const s of mleaderStyles(this.src)) put(s.obj.handle, { kind: 'mleaderStyle', name: s.name });
    for (const s of listTableStyles(this.src)) put(s.handle, { kind: 'tableStyle', name: s.name });
    this.srcIndex = m;
    return m;
  }

  /** 원본 도면의 핸들 → 이 도면의 같은 정의 핸들(필요하면 복사). 모르면 undefined */
  mapRef(h: string | undefined): string | undefined {
    if (!h) return undefined;
    const nh = normalizeHandle(h);
    if (nh === '0') return undefined;
    const done = this.handles.get(nh);
    if (done) return done;
    const r = this.index().get(nh);
    if (!r) return undefined;
    switch (r.kind) {
      case 'layer':
        return this.recordHandle('layer', this.layer(r.name));
      case 'linetype': {
        const n = this.linetype(r.name);
        return n ? this.recordHandle('linetype', n) : undefined;
      }
      case 'textStyle':
        return this.textStyleByHandle(nh);
      case 'dimStyle':
        return this.recordHandle('dimStyle', this.dimStyle(r.name));
      case 'block': {
        const n = this.block(r.name);
        return n ? this.recordHandle('block', n) : undefined;
      }
      case 'mleaderStyle':
        return this.mleaderStyleByHandle(nh);
      case 'tableStyle':
        return this.tableStyleByHandle(nh);
    }
  }

  // -------------------------------------------------------------------------
  // 사전 객체(다중 지시선 스타일·테이블 스타일·배치)
  // -------------------------------------------------------------------------

  /** 사전에 항목 하나를 더하는 변경(사전마다 하나로 모은다) */
  private addDictEntry(d: DictionaryObject, name: string, handle: string): void {
    let x = this.dicts.get(d.handle);
    if (!x) {
      x = { before: d, after: { ...d, entries: new Map(d.entries) } };
      this.dicts.set(d.handle, x);
    }
    x.after.entries.set(name, handle);
  }

  private dictHas(d: DictionaryObject | null, name: string): boolean {
    if (!d) return false;
    const cur = this.dicts.get(d.handle)?.after ?? d;
    return !!dictEntry(cur, name);
  }

  /** 다중 지시선 스타일(이름). 이 도면에 이미 있으면 그 이름, 없으면 복사. 원본에 없거나 사전이 없으면 null */
  mleaderStyle(name: string): string | null {
    const m = this.memo('mleaderStyle', name);
    if (m !== undefined) return m;
    const s = mleaderStyles(this.src).find((x) => tableKey(x.name) === tableKey(name));
    if (!s) return null;
    const have = mleaderStyles(this.dst).find((x) => tableKey(x.name) === tableKey(name));
    if (have) {
      this.handles.set(normalizeHandle(s.obj.handle), have.obj.handle);
      this.remember('mleaderStyle', name, have.name);
      return have.name;
    }
    const dict = namedDictionary(this.dst, 'ACAD_MLEADERSTYLE');
    if (!dict || this.dictHas(dict, s.name)) return null;
    const c = structuredClone(s.obj);
    c.handle = this.newHandle();
    this.handles.set(normalizeHandle(s.obj.handle), c.handle);
    this.remember('mleaderStyle', name, s.name, c.handle);
    c.owner = dict.handle;
    c.reactors = [dict.handle];
    delete c.xdict;
    delete c.dwgRaw;
    c.textStyleHandle = this.mapRef(c.textStyleHandle);
    c.arrowHeadHandle = this.mapRef(c.arrowHeadHandle);
    c.blockHandle = this.mapRef(c.blockHandle);
    if (c.raw) {
      const raw = this.mapRaw(c.raw);
      if (raw) c.raw = raw;
      else delete c.raw;
    }
    if (c.xdata) c.xdata = this.mapXData(c.xdata);
    this.ops.push({ kind: 'object', key: c.handle, before: null, after: c });
    this.addDictEntry(dict, s.name, c.handle);
    this.added.push({ kind: 'mleaderStyle', name: s.name });
    return s.name;
  }

  private mleaderStyleByHandle(h: string | undefined): string | undefined {
    if (!h) return undefined;
    const nh = normalizeHandle(h);
    const done = this.handles.get(nh);
    if (done) return done;
    const s = mleaderStyles(this.src).find((x) => normalizeHandle(x.obj.handle) === nh);
    if (!s) return undefined;
    this.mleaderStyle(s.name);
    return this.handles.get(nh) ?? mleaderStyles(this.dst).find((x) => tableKey(x.name) === 'STANDARD')?.obj.handle;
  }

  /** 원본 태그의 핸들 값을 새 핸들로. 옮길 수 없는 핸들이 있으면 null(모델 값으로 다시 쓰게 한다) */
  private mapRaw(raw: readonly RawTag[]): RawTag[] | null {
    const out: RawTag[] = [];
    for (const t of raw) {
      if (!isHandleCode(t.code) || typeof t.value !== 'string') {
        out.push({ ...t });
        continue;
      }
      if (!t.value || normalizeHandle(t.value) === '0') {
        out.push({ ...t });
        continue;
      }
      const h = this.mapRef(t.value);
      if (!h) return null;
      out.push({ ...t, value: h });
    }
    return out;
  }

  /** 테이블 스타일(이름). 이 도면에 이미 있으면 그 이름, 없으면 복사. 원본에 없거나 사전이 없으면 null */
  tableStyle(name: string): string | null {
    const m = this.memo('tableStyle', name);
    if (m !== undefined) return m;
    const s = listTableStyles(this.src).find((x) => tableKey(x.name) === tableKey(name));
    if (!s) return null;
    const have = listTableStyles(this.dst).find((x) => tableKey(x.name) === tableKey(name));
    if (have) {
      this.handles.set(normalizeHandle(s.handle), have.handle);
      this.remember('tableStyle', name, have.name);
      return have.name;
    }
    const dict = tableStyleDictionary(this.dst);
    if (!dict || this.dictHas(dict, s.name)) return null;
    const style = cloneTableStyle(s.style);
    style.name = s.name;
    for (const k of ['title', 'header', 'data'] as const) style.cells[k].textStyle = this.textStyle(style.cells[k].textStyle);
    const h = this.newHandle();
    this.handles.set(normalizeHandle(s.handle), h);
    this.remember('tableStyle', name, s.name, h);
    const obj: GenericObject = { type: 'TABLESTYLE', handle: h, owner: dict.handle, reactors: [dict.handle], raw: tableStyleRaw(style, docVersionNumber(this.dst)) };
    this.ops.push({ kind: 'object', key: h, before: null, after: obj });
    this.addDictEntry(dict, s.name, h);
    this.added.push({ kind: 'tableStyle', name: s.name });
    return s.name;
  }

  private tableStyleByHandle(h: string | undefined): string | undefined {
    if (!h) return undefined;
    const nh = normalizeHandle(h);
    const done = this.handles.get(nh);
    if (done) return done;
    const s = listTableStyles(this.src).find((x) => normalizeHandle(x.handle) === nh);
    if (!s) return undefined;
    this.tableStyle(s.name);
    return this.handles.get(nh);
  }

  /** 배치(이름) 복사: 종이 공간 블록·객체·뷰포트·플롯 설정. 같은 이름의 배치가 있으면 null */
  layout(name: string): string | null {
    const l = this.src.layouts.find((x) => tableKey(x.name) === tableKey(name) && tableKey(x.blockName) !== MODEL_SPACE);
    if (!l) return null;
    if (this.dst.layouts.some((x) => tableKey(x.name) === tableKey(name)) || this.layoutNames.has(tableKey(name))) return null;
    const srcBlock = this.src.blocks.get(tableKey(l.blockName));
    const blockName = this.nextPaperBlock();
    const bkey = tableKey(blockName);
    this.layoutBlocks.add(bkey);
    this.layoutNames.add(tableKey(name));
    const recH = this.newHandle();
    const layoutH = this.newHandle();
    if (srcBlock?.recordHandle) this.handles.set(normalizeHandle(srcBlock.recordHandle), recH);
    if (l.handle) this.handles.set(normalizeHandle(l.handle), layoutH);
    const ents = srcBlock ? this.entities(srcBlock.entities, recH, true) : [];
    if (this.tabOrder < 0) this.tabOrder = Math.max(0, ...this.dst.layouts.map((x) => x.tabOrder));
    this.tabOrder++;
    const proto: Layout = { ...structuredClone(l), handle: layoutH, blockRecord: recH, blockName, tabOrder: this.tabOrder };
    const vp = l.viewport ? this.handles.get(normalizeHandle(l.viewport)) : undefined;
    if (vp) proto.viewport = vp;
    else delete proto.viewport;
    const srcRec = this.src.blockRecords.get(tableKey(l.blockName));
    const record: BlockRecord = { name: blockName, handle: recH, flags: 0, layout: layoutH, insertUnits: srcRec?.insertUnits ?? 0, explodable: srcRec?.explodable ?? true, scalable: srcRec?.scalable ?? true };
    const def: BlockDef = {
      name: blockName,
      handle: this.newHandle(),
      recordHandle: recH,
      basePoint: srcBlock ? { ...srcBlock.basePoint } : { x: 0, y: 0, z: 0 },
      flags: 0,
      entities: ents,
      endHandle: this.newHandle(),
    };
    const dict = layoutDictionary(this.dst);
    const lo: LayoutObject = { type: 'LAYOUT', handle: layoutH, owner: dict?.handle, reactors: dict ? [dict.handle] : undefined, layout: proto };
    this.ops.push(
      { kind: 'blockRecord', key: bkey, before: null, after: record },
      { kind: 'blockDef', key: bkey, before: null, after: def },
      { kind: 'object', key: layoutH, before: null, after: lo },
      { kind: 'layout', key: bkey, before: null, after: proto },
    );
    if (dict) this.addDictEntry(dict, l.name, layoutH);
    this.added.push({ kind: 'layout', name: l.name });
    return l.name;
  }

  private nextPaperBlock(): string {
    const taken = (k: string) => this.dst.blocks.has(k) || this.layoutBlocks.has(k);
    if (!taken('*PAPER_SPACE')) return '*Paper_Space';
    for (let n = 0; ; n++) if (!taken(`*PAPER_SPACE${n}`)) return `*Paper_Space${n}`;
  }
}
