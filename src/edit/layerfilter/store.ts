/**
 * 도면 안의 도면층 필터: 찾고 고치는 순수 계산.
 *
 * 읽기: AutoCAD 형식(LAYER 표 확장 사전 → `ACLYDICTIONARY` → `AcLyLayerFilter`·`AcLyLayerGroup` XRECORD, 중첩은 XRECORD
 * 확장 사전의 `ACLYDICTIONARY` — acly.ts)과 예전 이 앱 기록(→ `OPENCAD_LAYERFILTERS`, record.ts)을 함께 읽는다.
 * 같은 이름이면 AutoCAD 필터를 쓴다. 이 앱 필터 정의로 바꿀 수 없는 식은 원본 식을 그대로 둔 읽기 전용 필터(filter.expression)가 된다.
 *
 * 쓰기(LayerFilterWriter): 편집 작업(EditOp) 목록으로 돌려준다(명령 취소 가능). 필터마다 저장 형식을 고른다 —
 *  - AutoCAD 형식: 그룹 필터(도면층에 핸들이 있으면), 식으로 쓸 수 있는 특성 필터(expr.ts의 확인한 열), 읽기 전용 AutoCAD 필터.
 *    부모가 AutoCAD 형식이어야 한다(자식은 부모 XRECORD의 확장 사전에 들어간다).
 *  - 이 앱 기록: 그 밖(투명도·플롯 스타일·설명·트루컬러 조건 등)과 그 아래 필터. 부모는 340 핸들로 잇는다.
 *  고치지 않은 AutoCAD 필터는 그대로 두고(원본 태그 그대로), 고친 필터도 모르는 태그(290 등)는 다시 쓴다. 쓸 때마다 예전 이 앱
 *  기록 가운데 AutoCAD 형식으로 쓸 수 있는 필터를 옮긴다(다 옮기면 OPENCAD_LAYERFILTERS 사전을 지운다).
 *  AutoCAD가 거울로 두는 예전 필터 사전(ACAD_LAYERFILTERS)은 읽지 않고, 이 앱이 고치거나 지운 맨 위 필터와 이름이 같은 항목만 지운다
 *  (그대로 두면 예전 이름·정의가 되살아날 수 있다).
 */
import type { CadDocument, CadObject, DictionaryObject, RawTag, TableHead, XRecordObject } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { entryName } from '../layerstate/store';
import { ACAD_LEGACY_FILTERS, ACLY_DICT, type AclyRecord, aclyTags, nextAnonymousKey, parseAclyTags } from './acly';
import { expressionToRows, rowsToExpression } from './expr';
import { type FilterRow, type LayerFilter, cleanRows, filterKey } from './model';
import { filterRecordTags, parentHandleOf, parseFilterTags } from './record';

/** 예전 이 앱 기록의 사전 이름 */
export const FILTERS_KEY = 'OPENCAD_LAYERFILTERS';
export { ACLY_DICT };

export type FilterFormat = 'acad' | 'app';

export interface StoredFilter {
  /** 사전 항목 이름(파일에 적힌 대로 — AutoCAD 형식은 `*An`) */
  key: string;
  /** XRECORD 핸들 */
  handle: string;
  /** 항목이 든 사전 핸들 */
  dict: string;
  format: FilterFormat;
  filter: LayerFilter;
  /** 도면층으로 풀리지 않는 핸들(지운 도면층 등, 그룹 필터) */
  unresolved: string[];
  /** 이 앱 필터 정의로 바꿀 수 없는 AutoCAD 식(filter.expression을 그대로 둔다) */
  readOnly: boolean;
}

type Getter = (h: string) => CadObject | undefined;

interface Source {
  get: Getter;
  head: TableHead | null;
}

const isDict = (o: CadObject | undefined | null): o is DictionaryObject => !!o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT');
const isXrec = (o: CadObject | undefined | null): o is XRecordObject => !!o && o.type === 'XRECORD';

function entryOf(d: DictionaryObject | null | undefined, name: string): [string, string] | null {
  if (!d) return null;
  const k = name.toUpperCase();
  for (const [n, h] of d.entries) if (entryName(n).toUpperCase() === k) return [n, normalizeHandle(h)];
  return null;
}

function dictAt(get: Getter, h: string | undefined | null): DictionaryObject | null {
  if (!h) return null;
  const o = get(normalizeHandle(h));
  return isDict(o) ? o : null;
}

function xrecAt(get: Getter, h: string): XRecordObject | null {
  const o = get(normalizeHandle(h));
  return isXrec(o) ? o : null;
}

function layerXdictOf(src: Source): DictionaryObject | null {
  return dictAt(src.get, src.head?.xdict);
}

function namedIn(get: Getter, d: DictionaryObject | null, name: string): DictionaryObject | null {
  const e = entryOf(d, name);
  return e ? dictAt(get, e[1]) : null;
}

/** 필터 XRECORD 아래의 중첩 필터 사전(확장 사전의 ACLYDICTIONARY) */
function nestedOf(get: Getter, x: XRecordObject): DictionaryObject | null {
  return namedIn(get, dictAt(get, x.xdict), ACLY_DICT);
}

function docSource(doc: CadDocument): Source {
  return { get: (h) => doc.objects.get(normalizeHandle(h)), head: doc.tableHeads?.get('LAYER') ?? null };
}

function layerNames(doc: CadDocument): (h: string) => string | null {
  const m = new Map<string, string>();
  for (const l of doc.layers.values()) if (l.handle) m.set(normalizeHandle(l.handle), l.name);
  return (h) => (h ? (m.get(normalizeHandle(h)) ?? null) : null);
}

function uniqNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function readAll(doc: CadDocument, src: Source): StoredFilter[] {
  const layer = layerNames(doc);
  const out: StoredFilter[] = [];
  const records = new Set<string>();
  const names = new Set<string>();
  const walk = (d: DictionaryObject, parent: string | null, depth: number) => {
    for (const [raw, h0] of d.entries) {
      const h = normalizeHandle(h0);
      if (records.has(h)) continue;
      const x = xrecAt(src.get, h);
      const rec = x ? parseAclyTags(x.data) : null;
      if (!x || !rec) continue;
      records.add(h);
      const name = rec.name || entryName(raw);
      if (names.has(filterKey(name))) continue;
      names.add(filterKey(name));
      let filter: LayerFilter;
      let readOnly = false;
      const unresolved: string[] = [];
      if (rec.kind === 'property') {
        const rows = expressionToRows(rec.expression ?? '');
        if (rows) filter = { name, kind: 'property', parent, rows, layers: [] };
        else {
          filter = { name, kind: 'property', parent, rows: [], layers: [], expression: rec.expression ?? '' };
          readOnly = true;
        }
      } else {
        const ls: string[] = [];
        for (const lh of rec.layerHandles) {
          const n = layer(lh);
          if (n) ls.push(n);
          else if (lh && lh !== '0') unresolved.push(lh);
        }
        filter = { name, kind: 'group', parent, rows: [], layers: uniqNames(ls) };
      }
      out.push({ key: entryName(raw), handle: h, dict: normalizeHandle(d.handle), format: 'acad', filter, unresolved, readOnly });
      const nested = depth < 32 ? nestedOf(src.get, x) : null;
      if (nested) walk(nested, name, depth + 1);
    }
  };
  const xd = layerXdictOf(src);
  const root = namedIn(src.get, xd, ACLY_DICT);
  if (root) walk(root, null, 0);

  // 예전 이 앱 기록
  const app = namedIn(src.get, xd, FILTERS_KEY);
  if (app) {
    const parsed: { key: string; handle: string; p: NonNullable<ReturnType<typeof parseFilterTags>> }[] = [];
    for (const [raw, h0] of app.entries) {
      const h = normalizeHandle(h0);
      const x = xrecAt(src.get, h);
      if (!x) continue;
      const p = parseFilterTags(x.data, entryName(raw), { layer });
      if (!p || names.has(filterKey(p.filter.name))) continue;
      names.add(filterKey(p.filter.name));
      parsed.push({ key: entryName(raw), handle: h, p });
    }
    const nameOf = new Map<string, string>([...out.map((s) => [s.handle, s.filter.name] as [string, string]), ...parsed.map((x) => [x.handle, x.p.filter.name] as [string, string])]);
    for (const x of parsed) {
      const ph = x.p.parentHandle ? normalizeHandle(x.p.parentHandle) : null;
      out.push({
        key: x.key,
        handle: x.handle,
        dict: normalizeHandle(app.handle),
        format: 'app',
        filter: { ...x.p.filter, parent: ph ? (nameOf.get(ph) ?? null) : null },
        unresolved: x.p.unresolved,
        readOnly: false,
      });
    }
  }
  return out;
}

/** 예전 이 앱 기록의 필터 사전(없으면 null) */
export function layerFiltersDict(doc: CadDocument): DictionaryObject | null {
  return namedIn(docSource(doc).get, layerXdictOf(docSource(doc)), FILTERS_KEY);
}

/** AutoCAD 필터 사전(ACLYDICTIONARY, 없으면 null) */
export function aclyDict(doc: CadDocument): DictionaryObject | null {
  return namedIn(docSource(doc).get, layerXdictOf(docSource(doc)), ACLY_DICT);
}

/** 도면의 필터(AutoCAD 필터 → 예전 이 앱 기록, 사전 순서) */
export function listStoredFilters(doc: CadDocument): StoredFilter[] {
  return readAll(doc, docSource(doc));
}

export function listLayerFilters(doc: CadDocument): LayerFilter[] {
  return listStoredFilters(doc).map((s) => s.filter);
}

export function findStoredFilter(doc: CadDocument, name: string): StoredFilter | null {
  const k = filterKey(name);
  return listStoredFilters(doc).find((s) => filterKey(s.filter.name) === k) ?? null;
}

/** 예전 AutoCAD 필터 사전(ACAD_LAYERFILTERS)의 항목 수. 이 앱은 읽지 않는다(AutoCAD가 ACLYDICTIONARY와 함께 거울로 둔다) */
export function autocadFilterEntries(doc: CadDocument): { dict: string; count: number }[] {
  const d = namedIn(docSource(doc).get, layerXdictOf(docSource(doc)), ACAD_LEGACY_FILTERS);
  return d && d.entries.size ? [{ dict: ACAD_LEGACY_FILTERS, count: d.entries.size }] : [];
}

// ---------------------------------------------------------------------------
// 고치기
// ---------------------------------------------------------------------------

function sameRows(a: readonly FilterRow[], b: readonly FilterRow[]): boolean {
  const norm = (rows: readonly FilterRow[]) =>
    JSON.stringify(
      cleanRows(rows).map((r) =>
        Object.keys(r)
          .sort()
          .map((k) => [k, String(r[k]).toUpperCase()]),
      ),
    );
  return norm(a) === norm(b);
}

const tagValue = (v: unknown): string => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? '').trim());

function sameTags(a: readonly RawTag[], b: readonly RawTag[]): boolean {
  return a.length === b.length && a.every((t, i) => t.code === b[i]!.code && tagValue(t.value) === tagValue(b[i]!.value));
}

function cloneDict(d: DictionaryObject): DictionaryObject {
  const c: DictionaryObject = { ...d, entries: new Map(d.entries) };
  delete c.dwgRaw;
  return c;
}

interface Spec {
  f: LayerFilter;
  old: StoredFilter | null;
  touched: boolean;
}

interface Placed {
  format: FilterFormat;
  handle: string;
}

/** 저장 중 풀 수 없는 충돌(대화상자에서 먼저 막는다) */
export class FilterStoreError extends Error {}

/**
 * 필터를 고치는 작업을 모은다. 같은 사전·레코드를 여러 번 고쳐도 작업은 하나씩이다.
 * 부모는 이름으로 준다. 레코드에는 AutoCAD 형식이면 부모 레코드의 중첩 사전으로, 이 앱 기록이면 부모 핸들(340)로 적는다.
 */
export class LayerFilterWriter {
  private head: { before: TableHead | null; after: TableHead } | null = null;
  private readonly objs = new Map<string, { before: CadObject | null; after: CadObject | null }>();
  /** 이번에 지운 도면층 핸들(그룹 필터에서 뺀다) */
  private readonly dropped = new Set<string>();

  constructor(
    readonly doc: CadDocument,
    readonly newHandle: () => string,
  ) {}

  private readonly get: Getter = (h) => {
    const k = normalizeHandle(h);
    const r = this.objs.get(k);
    return r ? (r.after ?? undefined) : this.doc.objects.get(k);
  };

  private set(h: string, after: CadObject | null): void {
    const k = normalizeHandle(h);
    const r = this.objs.get(k);
    if (r) r.after = after;
    else this.objs.set(k, { before: this.doc.objects.get(k) ?? null, after });
  }

  /** 이 작업에서 고칠 사전(처음이면 사본을 만든다) */
  private mutDict(h: string): DictionaryObject {
    const k = normalizeHandle(h);
    const r = this.objs.get(k);
    if (r?.after && r.after !== r.before && isDict(r.after)) return r.after;
    const c = cloneDict(this.get(k) as DictionaryObject);
    this.set(k, c);
    return c;
  }

  private setRecord(h: string, patch: Partial<XRecordObject>): void {
    const x = this.get(h) as XRecordObject;
    const after: XRecordObject = { ...x, ...patch };
    delete after.dwgRaw;
    this.set(h, after);
  }

  private headNow(): TableHead | null {
    return this.head ? this.head.after : (this.doc.tableHeads?.get('LAYER') ?? null);
  }

  private src(): Source {
    return { get: this.get, head: this.headNow() };
  }

  /** 지금(이 작업들을 적용한 뒤)의 필터 */
  current(): StoredFilter[] {
    return readAll(this.doc, this.src());
  }

  private find(name: string | null | undefined, list = this.current()): StoredFilter | null {
    if (!name) return null;
    const k = filterKey(name);
    return list.find((s) => filterKey(s.filter.name) === k) ?? null;
  }

  // --- 사전 만들기 ---

  private layerXdict(): DictionaryObject {
    const xd = layerXdictOf(this.src());
    if (xd) return this.mutDict(xd.handle);
    const head0 = this.doc.tableHeads?.get('LAYER') ?? null;
    const head: TableHead = { ...(this.headNow() ?? head0 ?? { handle: this.newHandle() }) };
    const nd: DictionaryObject = { type: 'DICTIONARY', handle: this.newHandle(), owner: head.handle, entries: new Map(), hardOwner: true, cloning: 1 };
    head.xdict = nd.handle;
    this.head = { before: head0, after: head };
    this.set(nd.handle, nd);
    return nd;
  }

  /** LAYER 표 확장 사전의 이름 있는 사전(없으면 만든다) */
  private tableDict(name: string): string {
    const found = namedIn(this.get, layerXdictOf(this.src()), name);
    if (found) return normalizeHandle(found.handle);
    const xd = this.layerXdict();
    const d: DictionaryObject = { type: 'DICTIONARY', handle: this.newHandle(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    this.set(d.handle, d);
    xd.entries.set(name, d.handle);
    return d.handle;
  }

  /** 필터 레코드의 중첩 사전(없으면 레코드에 확장 사전과 함께 만든다) */
  private nestedDict(recordHandle: string, create: boolean): string | null {
    const x = xrecAt(this.get, recordHandle);
    if (!x) return null;
    const found = nestedOf(this.get, x);
    if (found) return normalizeHandle(found.handle);
    if (!create) return null;
    let xd = dictAt(this.get, x.xdict);
    if (xd) xd = this.mutDict(xd.handle);
    else {
      xd = { type: 'DICTIONARY', handle: this.newHandle(), owner: x.handle, entries: new Map(), hardOwner: true, cloning: 1 };
      this.set(xd.handle, xd);
      this.setRecord(x.handle, { xdict: xd.handle });
    }
    const d: DictionaryObject = { type: 'DICTIONARY', handle: this.newHandle(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    this.set(d.handle, d);
    xd.entries.set(ACLY_DICT, d.handle);
    return d.handle;
  }

  private container(format: FilterFormat, parent: Placed | null, create: boolean): string | null {
    if (format === 'app') {
      if (!create) return namedIn(this.get, layerXdictOf(this.src()), FILTERS_KEY)?.handle ?? null;
      return this.tableDict(FILTERS_KEY);
    }
    if (parent) return this.nestedDict(parent.handle, create);
    if (!create) {
      const d = namedIn(this.get, layerXdictOf(this.src()), ACLY_DICT);
      return d ? normalizeHandle(d.handle) : null;
    }
    return this.tableDict(ACLY_DICT);
  }

  // --- 형식 고르기 ---

  /** AutoCAD 형식으로 쓸 식(그대로 둘 원본 식, 정의가 같으면 원래 식, 아니면 새로 만든 식). 쓸 수 없으면 null */
  private expressionFor(f: LayerFilter, old: StoredFilter | null): string | null {
    if (f.expression !== undefined) return f.expression;
    if (old?.format === 'acad' && old.filter.kind === 'property' && sameRows(old.filter.rows, f.rows)) {
      const rec = this.oldAcly(old);
      if (rec?.expression !== null && rec?.expression !== undefined) return rec.expression;
    }
    return rowsToExpression(f.rows);
  }

  private encodable(f: LayerFilter, old: StoredFilter | null): boolean {
    if (f.kind === 'group') return f.layers.every((n) => !!this.doc.layers.get(tableKey(n))?.handle);
    return this.expressionFor(f, old) !== null;
  }

  private oldAcly(old: StoredFilter): AclyRecord | null {
    const x = xrecAt(this.get, old.handle);
    return x ? parseAclyTags(x.data) : null;
  }

  /**
   * 저장할 수 없는 까닭(없으면 null): AutoCAD 형식으로 쓸 수 없게 된 필터 아래에 읽기 전용 AutoCAD 필터가 있거나,
   * 읽기 전용 AutoCAD 필터를 이 앱 기록 필터 아래로 옮길 때.
   */
  problem(f: LayerFilter, previousName?: string): string | null {
    const cur = this.current();
    const old = this.find(previousName ?? f.name, cur);
    const parent = this.find(f.parent, cur);
    if (f.kind === 'property' && f.expression !== undefined && parent?.format === 'app') return `AutoCAD 필터 "${f.name}"은(는) AutoCAD 형식으로 저장하지 않는 필터 "${parent.filter.name}" 아래에 둘 수 없습니다.`;
    const willApp = parent?.format === 'app' || !this.encodable(f, old);
    if (willApp && old) {
      const kids = descendantsIn(cur, old.filter.name).filter((s) => s.readOnly);
      if (kids.length) return `필터 "${kids[0]!.filter.name}"(AutoCAD 필터 식을 그대로 둔 필터)이 아래에 있어, 이 필터를 AutoCAD에서 읽지 못하는 조건(투명도·플롯 스타일·설명·트루컬러 등)으로 저장할 수 없습니다.`;
    }
    return null;
  }

  // --- 동기화 ---

  /** 원하는 필터 목록(specs)대로 레코드를 놓는다. removed는 지울 필터 */
  private sync(specs: Spec[], removed: StoredFilter[]): Map<string, Placed> {
    const byKey = new Map(specs.map((s) => [filterKey(s.f.name), s]));
    // 부모 먼저(순환·없는 부모는 맨 위)
    const order: Spec[] = [];
    const state = new Map<string, 1 | 2>();
    const visit = (s: Spec) => {
      const k = filterKey(s.f.name);
      if (state.get(k)) return;
      state.set(k, 1);
      const p = s.f.parent ? byKey.get(filterKey(s.f.parent)) : undefined;
      if (p && !state.get(filterKey(p.f.name))) visit(p);
      state.set(k, 2);
      order.push(s);
    };
    for (const s of specs) visit(s);

    const placed = new Map<string, Placed>();
    const stale: StoredFilter[] = [...removed];
    const legacyDrop = new Set<string>();
    for (const s of removed) if (s.format === 'acad' && !s.filter.parent) legacyDrop.add(filterKey(s.filter.name));

    for (const s of order) {
      const k = filterKey(s.f.name);
      const pSpec = s.f.parent ? byKey.get(filterKey(s.f.parent)) : undefined;
      const p = pSpec && pSpec !== s ? (placed.get(filterKey(pSpec.f.name)) ?? null) : null;
      const f: LayerFilter = { ...s.f, parent: p ? pSpec!.f.name : null };
      const old = s.old;
      // 형식
      let format: FilterFormat;
      if (f.kind === 'property' && f.expression !== undefined) {
        if (p && p.format === 'app') throw new FilterStoreError(`AutoCAD 필터 "${f.name}"을(를) 이 앱 기록 필터 아래에 둘 수 없습니다.`);
        format = 'acad';
      } else if (!s.touched && old?.format === 'acad' && (!p || p.format === 'acad')) format = 'acad';
      else format = (!p || p.format === 'acad') && this.encodable(f, old) ? 'acad' : 'app';

      const where = this.container(format, p, false);
      const reuse = !!old && old.format === format && !!where && normalizeHandle(old.dict) === normalizeHandle(where);
      const data = (): RawTag[] => this.recordData(f, format, old, p);
      if (reuse) {
        const x = xrecAt(this.get, old.handle)!;
        let changed = false;
        if (s.touched) {
          const d = data();
          if (!sameTags(d, x.data)) {
            this.setRecord(old.handle, { data: d });
            changed = true;
          }
        } else if (format === 'app') {
          const ph = parentHandleOf(x.data);
          if ((ph ? normalizeHandle(ph) : null) !== (p ? normalizeHandle(p.handle) : null)) {
            const d = data();
            this.setRecord(old.handle, { data: d });
          }
        }
        if (format === 'app' && old.key !== f.name) {
          const d = this.mutDict(old.dict);
          d.entries = new Map([...d.entries].map(([kk, h]) => (normalizeHandle(h) === old.handle ? [f.name, h] : [kk, h]) as [string, string]));
        }
        if (changed && format === 'acad' && !old.filter.parent) legacyDrop.add(filterKey(old.filter.name));
        if (format === 'acad' && !f.parent && old.filter.name !== f.name) legacyDrop.add(filterKey(old.filter.name));
        placed.set(k, { format, handle: old.handle });
        continue;
      }
      // 새로 놓기(새 필터, 형식이 바뀐 필터, 부모가 옮겨진 필터)
      const box = this.container(format, p, true)!;
      const d = this.mutDict(box);
      const h = this.newHandle();
      const tags = !s.touched && old && old.format === format ? [...(xrecAt(this.get, old.handle)?.data ?? [])].map((t) => ({ ...t })) : data();
      const fixed = format === 'app' ? this.withParent(tags, p) : tags;
      const x: XRecordObject = { type: 'XRECORD', handle: h, owner: d.handle, reactors: [d.handle], cloning: 1, data: fixed };
      this.set(h, x);
      d.entries.set(format === 'acad' ? nextAnonymousKey(d.entries.keys()) : f.name, h);
      if (old) {
        stale.push(old);
        if (old.format === 'acad' && !old.filter.parent && (s.touched || format !== 'acad')) legacyDrop.add(filterKey(old.filter.name));
      }
      placed.set(k, { format, handle: h });
    }
    for (const s of stale) this.dropRecord(s);
    this.dropLegacyMirror(legacyDrop);
    this.cleanup();
    return placed;
  }

  /** 이 앱 기록의 부모 핸들(340)을 맞춘다 */
  private withParent(tags: RawTag[], p: Placed | null): RawTag[] {
    const out = tags.filter((t) => t.code !== 340);
    if (p) {
      const i = out.findIndex((t) => t.code === 300);
      out.splice(i < 0 ? out.length : i + 1, 0, { code: 340, value: p.handle });
    }
    return out;
  }

  private recordData(f: LayerFilter, format: FilterFormat, old: StoredFilter | null, p: Placed | null): RawTag[] {
    const layerHandle = (n: string): string | null | undefined => {
      const l = this.doc.layers.get(tableKey(n));
      if (!l) return undefined;
      return l.handle ? normalizeHandle(l.handle) : null;
    };
    if (format === 'app') {
      let extra: RawTag[] = [];
      if (old?.format === 'app') {
        const x = xrecAt(this.get, old.handle);
        extra = (x && parseFilterTags(x.data, old.key, { layer: () => null })?.extra) ?? [];
      }
      return filterRecordTags({ ...f, rows: f.kind === 'property' ? f.rows : [] }, p?.handle ?? null, { layer: layerHandle }, extra);
    }
    const rec = old?.format === 'acad' ? this.oldAcly(old) : null;
    const r: AclyRecord = { kind: f.kind, name: f.name, expression: null, layerHandles: [], version: rec?.version ?? 1, lead: rec?.lead ?? [], tail: rec?.tail ?? [] };
    if (rec && rec.kind !== f.kind) r.tail = [];
    if (f.kind === 'property') r.expression = this.expressionFor(f, old) ?? '';
    else {
      const seen = new Set<string>();
      for (const n of f.layers) {
        const h = layerHandle(n);
        if (!h || seen.has(h)) continue;
        seen.add(h);
        r.layerHandles.push(h);
      }
      // 도면층으로 풀리지 않는 원래 핸들(빈 핸들 포함)은 그대로 둔다 — 이번에 지운 도면층만 뺀다
      if (rec?.kind === 'group') {
        const known = new Set([...this.doc.layers.values()].filter((l) => l.handle).map((l) => normalizeHandle(l.handle!)));
        for (const h of rec.layerHandles) if (!(h && known.has(normalizeHandle(h))) && !(h && this.dropped.has(normalizeHandle(h)))) r.layerHandles.push(h);
      }
    }
    return aclyTags(r);
  }

  /** 레코드와 그 확장 사전(중첩 사전 포함)을 지우고 사전 항목을 뺀다 */
  private dropRecord(s: StoredFilter): void {
    const x = xrecAt(this.get, s.handle);
    if (!x) return;
    const d = dictAt(this.get, s.dict);
    if (d) {
      const m = this.mutDict(d.handle);
      for (const [kk, h] of [...m.entries]) if (normalizeHandle(h) === s.handle) m.entries.delete(kk);
    }
    this.dropTree(x.xdict);
    this.set(s.handle, null);
  }

  /** 사전과 그 아래(사전·레코드)를 지운다 */
  private dropTree(h: string | undefined): void {
    const d = dictAt(this.get, h);
    if (!d) return;
    for (const [, ch] of d.entries) {
      const o = this.get(ch);
      if (isDict(o)) this.dropTree(o.handle);
      else if (o) {
        if (o.xdict) this.dropTree(o.xdict);
        this.set(o.handle, null);
      }
    }
    this.set(d.handle, null);
  }

  /** 예전 AutoCAD 필터 사전(ACAD_LAYERFILTERS)에서 이름이 같은 항목을 지운다 */
  private dropLegacyMirror(names: Set<string>): void {
    if (!names.size) return;
    const lf = namedIn(this.get, layerXdictOf(this.src()), ACAD_LEGACY_FILTERS);
    if (!lf) return;
    const hit = [...lf.entries].filter(([kk]) => names.has(filterKey(entryName(kk))));
    if (!hit.length) return;
    const m = this.mutDict(lf.handle);
    for (const [kk, h] of hit) {
      m.entries.delete(kk);
      const o = this.get(h);
      if (o?.xdict) this.dropTree(o.xdict);
      this.set(h, null);
    }
  }

  /** 빈 이 앱 기록 사전과 빈 중첩 사전을 지운다 */
  private cleanup(): void {
    const src = this.src();
    const xd = layerXdictOf(src);
    const app = namedIn(this.get, xd, FILTERS_KEY);
    if (xd && app && !app.entries.size) {
      const m = this.mutDict(xd.handle);
      for (const [kk, h] of [...m.entries]) if (normalizeHandle(h) === normalizeHandle(app.handle)) m.entries.delete(kk);
      this.set(app.handle, null);
    }
    // 이번에 고친 레코드의 빈 중첩 사전
    for (const [h, r] of [...this.objs]) {
      const x = r.after;
      if (!isXrec(x) || !x.xdict) continue;
      const xdict = dictAt(this.get, x.xdict);
      const nested = namedIn(this.get, xdict, ACLY_DICT);
      if (!xdict || !nested || nested.entries.size) continue;
      const m = this.mutDict(xdict.handle);
      for (const [kk, ch] of [...m.entries]) if (normalizeHandle(ch) === normalizeHandle(nested.handle)) m.entries.delete(kk);
      this.set(nested.handle, null);
      if (!m.entries.size) {
        this.set(m.handle, null);
        const rest: XRecordObject = { ...x };
        delete rest.xdict;
        this.set(h, rest);
      }
    }
    // 중첩 사전이 비어 버린 원래 레코드(자식을 지웠거나 옮긴 부모)
    for (const s of readAll(this.doc, this.src())) {
      if (s.format !== 'acad') continue;
      const x = xrecAt(this.get, s.handle);
      if (!x?.xdict || this.objs.get(s.handle)) continue;
      const xdict = dictAt(this.get, x.xdict);
      const nested = namedIn(this.get, xdict, ACLY_DICT);
      if (!xdict || !nested || nested.entries.size || !this.objs.has(normalizeHandle(nested.handle))) continue;
      const m = this.mutDict(xdict.handle);
      for (const [kk, ch] of [...m.entries]) if (normalizeHandle(ch) === normalizeHandle(nested.handle)) m.entries.delete(kk);
      this.set(nested.handle, null);
      if (!m.entries.size) {
        this.set(m.handle, null);
        this.setRecord(s.handle, {});
        const rest = this.get(s.handle) as XRecordObject;
        delete rest.xdict;
      }
    }
  }

  private specs(cur: StoredFilter[]): Spec[] {
    return cur.map((s) => ({ f: s.filter, old: s, touched: false }));
  }

  /**
   * 필터를 저장한다. previousName이 있으면 그 필터를 고친다(이름이 바뀌면 자식도 따라간다). 저장한 XRECORD 핸들.
   * 부모(filter.parent)가 없는 이름이면 맨 위에 둔다. 저장 형식은 위 규칙대로 고른다(problem()으로 먼저 검사한다).
   */
  put(filter: LayerFilter, previousName?: string): string {
    const cur = this.current();
    const old = this.find(previousName ?? filter.name, cur);
    const specs = this.specs(cur);
    const f: LayerFilter = { ...filter, rows: filter.kind === 'property' ? filter.rows : [], layers: filter.kind === 'group' ? filter.layers : [] };
    // 원본 식은 정의 행이 없는 특성 필터에만(읽기 전용 AutoCAD 필터를 이름만 바꾸거나 옮길 때)
    if (f.kind !== 'property' || f.rows.length) delete f.expression;
    if (old) {
      const i = specs.findIndex((s) => s.old === old);
      specs[i] = { f, old, touched: true };
      if (old.filter.name !== f.name) {
        for (const s of specs) if (s.f.parent && filterKey(s.f.parent) === filterKey(old.filter.name) && s.old !== old) s.f = { ...s.f, parent: f.name };
      }
    } else specs.push({ f, old: null, touched: true });
    const placed = this.sync(specs, []);
    return placed.get(filterKey(f.name))!.handle;
  }

  /** 필터와 그 아래 필터들을 지운다. 지운 필터 이름(없으면 빈 배열) */
  remove(name: string): string[] {
    const cur = this.current();
    const target = this.find(name, cur);
    if (!target) return [];
    const gone = [target, ...descendantsIn(cur, target.filter.name)];
    const goneSet = new Set(gone);
    this.sync(
      this.specs(cur).filter((s) => !goneSet.has(s.old!)),
      gone,
    );
    return gone.map((s) => s.filter.name);
  }

  /** 이름 바꾸기. 없거나 새 이름이 다른 필터와 겹치면 false */
  rename(oldName: string, newName: string): boolean {
    const cur = this.find(oldName);
    if (!cur) return false;
    const dup = this.find(newName);
    if (dup && dup.handle !== cur.handle) return false;
    this.put({ ...cur.filter, name: newName.trim() }, cur.filter.name);
    return true;
  }

  /** 예전 이 앱 기록을 AutoCAD 형식으로 옮긴다(쓸 수 있는 것만). 옮긴 필터 수 */
  migrate(): number {
    const cur = this.current();
    const before = cur.filter((s) => s.format === 'app').length;
    if (!before) return 0;
    this.sync(this.specs(cur), []);
    return before - this.current().filter((s) => s.format === 'app').length;
  }

  /** 지운 도면층(핸들)을 그룹 필터에서 뺀다. 고친 필터 수 */
  dropLayerHandle(handle: string): number {
    const k = normalizeHandle(handle);
    this.dropped.add(k);
    let n = 0;
    for (const s of this.current()) {
      if (s.filter.kind !== 'group') continue;
      const x = xrecAt(this.get, s.handle);
      if (!x || !x.data.some((t) => t.code === 330 && normalizeHandle(String(t.value)) === k)) continue;
      this.setRecord(s.handle, { data: x.data.filter((t) => !(t.code === 330 && normalizeHandle(String(t.value)) === k)) });
      n++;
    }
    return n;
  }

  get empty(): boolean {
    return !this.head && ![...this.objs.values()].some((r) => r.before !== r.after);
  }

  /** 모은 작업(표 머리 → 사전·레코드, 만든 순서) */
  finish(): EditOp[] {
    const out: EditOp[] = [];
    if (this.head) out.push({ kind: 'tableHead', key: 'LAYER', before: this.head.before, after: this.head.after });
    for (const [h, r] of this.objs) {
      if (!r.before && !r.after) continue;
      if (r.before === r.after) continue;
      out.push({ kind: 'object', key: h, before: r.before, after: r.after });
    }
    return out;
  }
}

/** 필터의 자손(이름으로 잇는다, 순환은 한 번만) */
function descendantsIn(list: readonly StoredFilter[], name: string): StoredFilter[] {
  const out: StoredFilter[] = [];
  const seen = new Set<string>([filterKey(name)]);
  const walk = (k: string) => {
    for (const s of list) {
      const sk = filterKey(s.filter.name);
      if (s.filter.parent && filterKey(s.filter.parent) === k && !seen.has(sk)) {
        seen.add(sk);
        out.push(s);
        walk(sk);
      }
    }
  };
  walk(filterKey(name));
  return out;
}

/** 도면층을 지울 때 그룹 필터에서 그 도면층을 빼는 작업(없으면 빈 배열) */
export function dropLayerFromFiltersOps(doc: CadDocument, layerHandle: string | undefined, newHandle: () => string): EditOp[] {
  if (!layerHandle) return [];
  const w = new LayerFilterWriter(doc, newHandle);
  return w.dropLayerHandle(layerHandle) ? w.finish() : [];
}

/** 예전 이 앱 기록을 AutoCAD 형식으로 옮기는 작업(옮길 것이 없으면 빈 배열) */
export function migrateLayerFiltersOps(doc: CadDocument, newHandle: () => string): EditOp[] {
  if (!layerFiltersDict(doc)?.entries.size) return [];
  const w = new LayerFilterWriter(doc, newHandle);
  return w.migrate() ? w.finish() : [];
}
