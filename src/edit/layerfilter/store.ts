/**
 * 도면 안의 도면층 필터: LAYER 표 확장 사전 → `OPENCAD_LAYERFILTERS` 사전 → 필터 XRECORD를 찾고 고치는 순수 계산.
 *
 * 고치기는 편집 작업(EditOp) 목록으로 돌려준다(명령 취소 가능, 워커 문서와 같이 적용). 확장 사전·필터 사전이 없으면
 * 만든다 — LAYER 표 머리의 확장 사전은 `tableHead` 작업으로 붙인다(도면층 상태와 같은 방식).
 * AutoCAD의 필터 원본(`ACLYDICTIONARY`·`ACAD_LAYERFILTERS`)은 읽지도 고치지도 않는다 — 리더가 원본 태그로 두므로
 * 저장하면 그대로 남는다.
 */
import type { CadDocument, DictionaryObject, TableHead, XRecordObject } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { entryName, layerTableDict, layerTableXdict } from '../layerstate/store';
import { type LayerFilter, filterKey } from './model';
import { filterRecordTags, parentHandleOf, parseFilterTags } from './record';

export const FILTERS_KEY = 'OPENCAD_LAYERFILTERS';
/** AutoCAD의 필터 사전(읽지 않고 보존만) */
export const ACAD_FILTER_DICTS = ['ACLYDICTIONARY', 'ACAD_LAYERFILTERS'] as const;

export function layerFiltersDict(doc: CadDocument): DictionaryObject | null {
  return layerTableDict(doc, FILTERS_KEY);
}

export interface StoredFilter {
  /** 사전 항목 이름(파일에 적힌 대로) */
  key: string;
  /** XRECORD 핸들 */
  handle: string;
  filter: LayerFilter;
  /** 지운 도면층의 핸들(그룹 필터) */
  unresolved: string[];
}

function layerResolver(doc: CadDocument): (h: string) => string | null {
  const m = new Map<string, string>();
  for (const l of doc.layers.values()) if (l.handle) m.set(normalizeHandle(l.handle), l.name);
  return (h) => m.get(normalizeHandle(h)) ?? null;
}

/** 사전 항목들에서 필터를 읽는다(부모 핸들을 이름으로 푼다) */
function readEntries(doc: CadDocument, entries: Iterable<[string, string]>, record: (h: string) => XRecordObject | null): StoredFilter[] {
  const layer = layerResolver(doc);
  const parsed: { key: string; handle: string; p: NonNullable<ReturnType<typeof parseFilterTags>> }[] = [];
  for (const [raw, h0] of entries) {
    const h = normalizeHandle(h0);
    const x = record(h);
    if (!x) continue;
    const p = parseFilterTags(x.data, entryName(raw), { layer });
    if (p) parsed.push({ key: entryName(raw), handle: h, p });
  }
  const nameOf = new Map(parsed.map((x) => [x.handle, x.p.filter.name]));
  return parsed.map((x) => ({
    key: x.key,
    handle: x.handle,
    filter: { ...x.p.filter, parent: x.p.parentHandle ? (nameOf.get(normalizeHandle(x.p.parentHandle)) ?? null) : null },
    unresolved: x.p.unresolved,
  }));
}

function xrecordOf(doc: CadDocument, h: string): XRecordObject | null {
  const o = doc.objects.get(h);
  return o && o.type === 'XRECORD' ? (o as XRecordObject) : null;
}

/** 도면의 사용자 필터(사전 순서) */
export function listStoredFilters(doc: CadDocument): StoredFilter[] {
  const d = layerFiltersDict(doc);
  return d ? readEntries(doc, d.entries, (h) => xrecordOf(doc, h)) : [];
}

export function listLayerFilters(doc: CadDocument): LayerFilter[] {
  return listStoredFilters(doc).map((s) => s.filter);
}

export function findStoredFilter(doc: CadDocument, name: string): StoredFilter | null {
  const k = filterKey(name);
  return listStoredFilters(doc).find((s) => filterKey(s.filter.name) === k) ?? null;
}

/** AutoCAD 필터 원본의 항목 수(사전별). 이 앱은 읽지 않고 보존한다 */
export function autocadFilterEntries(doc: CadDocument): { dict: string; count: number }[] {
  const out: { dict: string; count: number }[] = [];
  for (const n of ACAD_FILTER_DICTS) {
    const d = layerTableDict(doc, n);
    if (d && d.entries.size) out.push({ dict: n, count: d.entries.size });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 고치기
// ---------------------------------------------------------------------------

function cloneDict(d: DictionaryObject): DictionaryObject {
  const c: DictionaryObject = { ...d, entries: new Map(d.entries) };
  delete c.dwgRaw;
  return c;
}

/**
 * 필터 사전을 고치는 작업을 모은다. 같은 사전·레코드를 여러 번 고쳐도 작업은 하나씩이다.
 * 부모는 이름으로 주고, 레코드에는 부모 XRECORD 핸들(340)로 적는다 — 부모 이름을 바꿔도 자식은 그대로다.
 */
export class LayerFilterWriter {
  private head: { before: TableHead | null; after: TableHead } | null = null;
  private xdict: { before: DictionaryObject | null; after: DictionaryObject } | null = null;
  private dict: { before: DictionaryObject | null; after: DictionaryObject } | null = null;
  private readonly records = new Map<string, { before: XRecordObject | null; after: XRecordObject | null }>();

  constructor(
    readonly doc: CadDocument,
    readonly newHandle: () => string,
  ) {}

  /** 필터 사전(없으면 만든다) */
  private filtersDict(): DictionaryObject {
    if (this.dict) return this.dict.after;
    const doc = this.doc;
    const found = layerFiltersDict(doc);
    if (found) {
      this.dict = { before: found, after: cloneDict(found) };
      return this.dict.after;
    }
    let xd = layerTableXdict(doc);
    if (!xd) {
      const head0 = doc.tableHeads?.get('LAYER') ?? null;
      const head: TableHead = head0 ? { ...head0 } : { handle: this.newHandle() };
      const nd: DictionaryObject = { type: 'DICTIONARY', handle: this.newHandle(), owner: head.handle, entries: new Map(), hardOwner: true, cloning: 1 };
      head.xdict = nd.handle;
      this.head = { before: head0, after: head };
      this.xdict = { before: null, after: nd };
      xd = nd;
    } else {
      this.xdict = { before: xd, after: cloneDict(xd) };
      xd = this.xdict.after;
    }
    const fd: DictionaryObject = { type: 'DICTIONARY', handle: this.newHandle(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    xd.entries.set(FILTERS_KEY, fd.handle);
    this.dict = { before: null, after: fd };
    return fd;
  }

  private record(handle: string): XRecordObject | null {
    const r = this.records.get(handle);
    if (r) return r.after;
    return xrecordOf(this.doc, handle);
  }

  private setRecord(handle: string, after: XRecordObject | null): void {
    const r = this.records.get(handle);
    if (r) r.after = after;
    else this.records.set(handle, { before: xrecordOf(this.doc, handle), after });
  }

  private entries(): [string, string][] {
    const d = this.dict?.after ?? layerFiltersDict(this.doc);
    return d ? [...d.entries].map(([k, h]) => [k, normalizeHandle(h)] as [string, string]) : [];
  }

  /** 지금(이 작업들을 적용한 뒤)의 필터 */
  current(): StoredFilter[] {
    return readEntries(this.doc, this.entries(), (h) => this.record(h));
  }

  private find(name: string): StoredFilter | null {
    const k = filterKey(name);
    return this.current().find((s) => filterKey(s.filter.name) === k) ?? null;
  }

  /**
   * 필터를 저장한다. previousName이 있으면 그 필터를 고친다(이름이 바뀌면 사전 항목 이름도). 저장한 XRECORD 핸들.
   * 부모(filter.parent)가 없는 이름이면 맨 위에 둔다.
   */
  put(filter: LayerFilter, previousName?: string): string {
    const old = this.find(previousName ?? filter.name);
    const parent = filter.parent ? this.find(filter.parent) : null;
    const layerHandle = (n: string): string | null | undefined => {
      const l = this.doc.layers.get(tableKey(n));
      if (!l) return undefined;
      return l.handle || null;
    };
    if (old) {
      const before = this.record(old.handle)!;
      const p = parseFilterTags(before.data, old.key, { layer: () => null });
      const data = filterRecordTags(filter, parent?.handle ?? null, { layer: layerHandle }, p?.extra ?? []);
      const after: XRecordObject = { ...before, data };
      delete after.dwgRaw;
      this.setRecord(old.handle, after);
      if (old.key !== filter.name) {
        const d = this.filtersDict();
        const list = [...d.entries].map(([k, h]) => (entryName(k) === old.key ? [filter.name, h] : [k, h]) as [string, string]);
        d.entries = new Map(list);
      }
      return old.handle;
    }
    const d = this.filtersDict();
    const h = this.newHandle();
    const data = filterRecordTags(filter, parent?.handle ?? null, { layer: layerHandle });
    const x: XRecordObject = { type: 'XRECORD', handle: h, owner: d.handle, reactors: [d.handle], cloning: 1, data };
    this.records.set(h, { before: null, after: x });
    d.entries.set(filter.name, h);
    return h;
  }

  /** 필터와 그 아래 필터들을 지운다. 지운 필터 이름(없으면 빈 배열) */
  remove(name: string): string[] {
    const all = this.current();
    const target = all.find((s) => filterKey(s.filter.name) === filterKey(name));
    if (!target) return [];
    const gone = new Set<string>([target.handle]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of all) {
        if (gone.has(s.handle)) continue;
        const ph = parentHandleOf(this.record(s.handle)?.data ?? []);
        if (ph && gone.has(normalizeHandle(ph))) {
          gone.add(s.handle);
          grew = true;
        }
      }
    }
    const d = this.filtersDict();
    for (const [k, h] of [...d.entries]) if (gone.has(normalizeHandle(h))) d.entries.delete(k);
    for (const h of gone) this.setRecord(h, null);
    return all.filter((s) => gone.has(s.handle)).map((s) => s.filter.name);
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

  /** 지운 도면층(핸들)을 그룹 필터에서 뺀다. 고친 필터 수 */
  dropLayerHandle(handle: string): number {
    const k = normalizeHandle(handle);
    let n = 0;
    for (const s of this.current()) {
      const x = this.record(s.handle);
      if (!x || !x.data.some((t) => t.code === 330 && normalizeHandle(String(t.value)) === k)) continue;
      const after: XRecordObject = { ...x, data: x.data.filter((t) => !(t.code === 330 && normalizeHandle(String(t.value)) === k)) };
      delete after.dwgRaw;
      this.setRecord(s.handle, after);
      n++;
    }
    return n;
  }

  get empty(): boolean {
    return !this.records.size && !this.head && !this.xdict && !this.dict;
  }

  /** 모은 작업(표 머리 → 확장 사전 → 필터 사전 → 레코드) */
  finish(): EditOp[] {
    const out: EditOp[] = [];
    if (this.head) out.push({ kind: 'tableHead', key: 'LAYER', before: this.head.before, after: this.head.after });
    if (this.xdict) out.push({ kind: 'object', key: this.xdict.after.handle, before: this.xdict.before, after: this.xdict.after });
    if (this.dict) out.push({ kind: 'object', key: this.dict.after.handle, before: this.dict.before, after: this.dict.after });
    for (const [h, r] of this.records) {
      if (!r.before && !r.after) continue;
      out.push({ kind: 'object', key: h, before: r.before, after: r.after });
    }
    return out;
  }
}

/** 도면층을 지울 때 그룹 필터에서 그 도면층을 빼는 작업(없으면 빈 배열) */
export function dropLayerFromFiltersOps(doc: CadDocument, layerHandle: string | undefined, newHandle: () => string): EditOp[] {
  if (!layerHandle || !layerFiltersDict(doc)) return [];
  const w = new LayerFilterWriter(doc, newHandle);
  return w.dropLayerHandle(layerHandle) ? w.finish() : [];
}
