/**
 * 도면 안의 도면층 상태: LAYER 표 확장 사전 → `ACAD_LAYERSTATES` 사전 → 상태 XRECORD를 찾고 고치는 순수 계산.
 *
 * 고치기는 편집 작업(EditOp) 목록으로 돌려준다(명령 취소 가능, 워커 문서와 같이 적용). 확장 사전·상태 사전이 없으면
 * 만든다 — LAYER 표 머리의 확장 사전은 `tableHead` 작업으로 붙인다.
 * 상태를 고치면 XRECORD 핸들과 그 확장 사전(AutoCAD의 `AcadLayerStateAnnoScale`)은 그대로 두고 자료만 바꾼다.
 */
import type { CadDocument, DictionaryObject, Layer, TableHead, XRecordObject } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';
import type { EditOp } from '../session';
import {
  LSF_FROZEN,
  LSF_LOCKED,
  LSF_NEWVP,
  LSF_OFF,
  LSF_PLOT,
  LSF_VPFROZEN,
  LSM_ALL,
  LSM_COLOR,
  LSM_CURVP,
  LSM_FROZEN,
  LSM_HIDDEN,
  LSM_LINETYPE,
  LSM_LINEWEIGHT,
  LSM_LOCKED,
  LSM_NEWVP,
  LSM_ON,
  LSM_PLOT,
  LSM_PLOTSTYLE,
  LSM_TRANSPARENCY,
  type LayerState,
  type LayerStateLayer,
  type TagNamer,
  type TagResolver,
  parseStateTags,
  stateRecordTags,
} from './record';

export const LAYERSTATES_KEY = 'ACAD_LAYERSTATES';

const isDict = (o: unknown): o is DictionaryObject => !!o && typeof o === 'object' && ((o as DictionaryObject).type === 'DICTIONARY' || (o as DictionaryObject).type === 'ACDBDICTIONARYWDFLT');

/** 사전 항목 이름(R2007 이전 DXF의 \\U+XXXX를 푼 이름) */
export const entryName = (raw: string): string => decodeCadEscapes(raw);

/** 사전 항목을 이름(대소문자 무시)으로: [파일에 적힌 항목 이름, 핸들] */
function entry(d: DictionaryObject | null | undefined, name: string): [string, string] | null {
  if (!d) return null;
  const k = name.toUpperCase();
  for (const [n, h] of d.entries) if (entryName(n).toUpperCase() === k) return [n, normalizeHandle(h)];
  return null;
}

/** LAYER 표 머리의 확장 사전 */
export function layerTableXdict(doc: CadDocument): DictionaryObject | null {
  const h = doc.tableHeads?.get('LAYER')?.xdict;
  const o = h ? doc.objects.get(normalizeHandle(h)) : undefined;
  return isDict(o) ? o : null;
}

/** LAYER 표 확장 사전의 이름 있는 사전(ACAD_LAYERSTATES, ACAD_LAYERFILTERS, ACLYDICTIONARY) */
export function layerTableDict(doc: CadDocument, name: string): DictionaryObject | null {
  const e = entry(layerTableXdict(doc), name);
  const o = e ? doc.objects.get(e[1]) : undefined;
  return isDict(o) ? o : null;
}

export function layerStatesDict(doc: CadDocument): DictionaryObject | null {
  return layerTableDict(doc, LAYERSTATES_KEY);
}

/** 핸들 → 이름 풀기 */
export function resolverFor(doc: CadDocument): TagResolver {
  const layers = new Map<string, string>();
  for (const l of doc.layers.values()) if (l.handle) layers.set(normalizeHandle(l.handle), l.name);
  const lts = new Map<string, string>();
  for (const l of doc.linetypes.values()) if (l.handle) lts.set(normalizeHandle(l.handle), l.name);
  return { layer: (h) => layers.get(normalizeHandle(h)) ?? null, linetype: (h) => lts.get(normalizeHandle(h)) ?? null };
}

/** 이름 → 핸들 */
export function namerFor(doc: CadDocument): TagNamer {
  return {
    layer: (n) => doc.layers.get(tableKey(n))?.handle || null,
    linetype: (n) => {
      const lt = doc.linetypes.get(tableKey(n));
      if (lt?.handle) return lt.handle;
      return null;
    },
  };
}

export interface StoredState {
  /** 사전 항목 이름(파일에 적힌 대로) */
  key: string;
  /** XRECORD 핸들 */
  handle: string;
  state: LayerState;
  hidden: boolean;
}

/** 도면의 상태(사전 순서). hidden이면 숨은 상태(명명된 뷰의 스냅샷 등)도 */
export function listLayerStates(doc: CadDocument, opt: { hidden?: boolean } = {}): StoredState[] {
  const d = layerStatesDict(doc);
  if (!d) return [];
  const r = resolverFor(doc);
  const out: StoredState[] = [];
  for (const [raw, h0] of d.entries) {
    const h = normalizeHandle(h0);
    const x = doc.objects.get(h);
    if (!x || x.type !== 'XRECORD') continue;
    const key = entryName(raw);
    const state = parseStateTags(key, (x as XRecordObject).data, r);
    const hidden = (state.mask & LSM_HIDDEN) !== 0;
    if (hidden && !opt.hidden) continue;
    out.push({ key, handle: h, state, hidden });
  }
  return out;
}

export function findLayerState(doc: CadDocument, name: string, opt: { hidden?: boolean } = { hidden: true }): StoredState | null {
  const k = name.trim().toUpperCase();
  return listLayerStates(doc, opt).find((s) => s.key.toUpperCase() === k) ?? null;
}

/** 외부 참조 상태(이름에 `참조|`가 붙은 것)의 참조 이름 */
export function xrefOfState(name: string): string | null {
  const i = name.indexOf('|');
  return i > 0 ? name.slice(0, i) : null;
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
 * 상태 사전을 고치는 작업을 모은다. 같은 사전을 여러 번 고쳐도 작업은 사전마다 하나다.
 */
export class LayerStateWriter {
  private readonly ops: EditOp[] = [];
  private head: { before: TableHead | null; after: TableHead } | null = null;
  private xdict: { before: DictionaryObject | null; after: DictionaryObject } | null = null;
  private states: { before: DictionaryObject | null; after: DictionaryObject } | null = null;
  private readonly records = new Map<string, { before: XRecordObject | null; after: XRecordObject | null }>();
  private readonly extraRemoved: EditOp[] = [];
  /** 같은 트랜잭션에서 새로 만드는 도면층·선종류(이름 대문자 → 핸들) */
  private readonly newLayers = new Map<string, string>();
  private readonly newLinetypes = new Map<string, string>();

  constructor(
    readonly doc: CadDocument,
    readonly newHandle: () => string,
  ) {}

  /** 상태 사전(없으면 만든다) */
  private statesDict(): DictionaryObject {
    if (this.states) return this.states.after;
    const doc = this.doc;
    const found = layerStatesDict(doc);
    if (found) {
      this.states = { before: found, after: cloneDict(found) };
      return this.states.after;
    }
    // LAYER 표 머리와 확장 사전
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
    const sd: DictionaryObject = { type: 'DICTIONARY', handle: this.newHandle(), owner: xd.handle, reactors: [xd.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    xd.entries.set(LAYERSTATES_KEY, sd.handle);
    this.states = { before: null, after: sd };
    return sd;
  }

  private current(handle: string): XRecordObject | null {
    const r = this.records.get(handle);
    if (r) return r.after;
    const o = this.doc.objects.get(handle);
    return o && o.type === 'XRECORD' ? (o as XRecordObject) : null;
  }

  private setRecord(handle: string, after: XRecordObject | null): void {
    const r = this.records.get(handle);
    if (r) r.after = after;
    else {
      const o = this.doc.objects.get(handle);
      this.records.set(handle, { before: o && o.type === 'XRECORD' ? (o as XRecordObject) : null, after });
    }
  }

  /** 지금(이 작업들을 적용한 뒤)의 항목 이름 → 핸들 */
  private find(name: string): [string, string] | null {
    const d = this.states?.after ?? layerStatesDict(this.doc);
    return entry(d, name);
  }

  /** 같은 트랜잭션에서 만드는 도면층(아직 문서에 없다) */
  knowLayer(name: string, handle: string): void {
    this.newLayers.set(tableKey(name), handle);
  }

  knowLinetype(name: string, handle: string): void {
    this.newLinetypes.set(tableKey(name), handle);
  }

  private namer(): TagNamer {
    const base = namerFor(this.doc);
    return {
      layer: (n) => this.newLayers.get(tableKey(n)) ?? base.layer(n),
      linetype: (n) => this.newLinetypes.get(tableKey(n)) ?? base.linetype(n),
    };
  }

  /** 상태를 저장한다(같은 이름이 있으면 그 레코드의 자료를 바꾼다). 저장한 XRECORD 핸들 */
  put(state: LayerState): string {
    const data = stateRecordTags(state, this.namer());
    const e = this.find(state.name);
    if (e) {
      const before = this.current(e[1]);
      if (before) {
        const after: XRecordObject = { ...before, data };
        delete after.dwgRaw;
        this.setRecord(e[1], after);
        // 사전 항목 이름의 대소문자가 다르면 새 이름으로
        if (entryName(e[0]) !== state.name) {
          const d = this.statesDict();
          const list = [...d.entries].map(([k, h]) => (k === e[0] ? [state.name, h] : [k, h]) as [string, string]);
          d.entries = new Map(list);
        }
        return e[1];
      }
    }
    const d = this.statesDict();
    const h = this.newHandle();
    const x: XRecordObject = { type: 'XRECORD', handle: h, owner: d.handle, reactors: [d.handle], cloning: 1, data };
    this.records.set(h, { before: null, after: x });
    if (e) d.entries.delete(e[0]);
    d.entries.set(state.name, h);
    return h;
  }

  /** 상태를 지운다(레코드와 그 확장 사전까지). 없으면 false */
  remove(name: string): boolean {
    const e = this.find(name);
    if (!e) return false;
    const d = this.statesDict();
    d.entries.delete(e[0]);
    const x = this.current(e[1]);
    this.setRecord(e[1], null);
    // 레코드의 확장 사전(주석 축척 레코드)
    if (x?.xdict) {
      const xd = this.doc.objects.get(normalizeHandle(x.xdict));
      if (isDict(xd)) {
        for (const h of xd.entries.values()) {
          const c = this.doc.objects.get(normalizeHandle(h));
          if (c) this.extraRemoved.push({ kind: 'object', key: c.handle, before: c, after: null });
        }
        this.extraRemoved.push({ kind: 'object', key: xd.handle, before: xd, after: null });
      }
    }
    return true;
  }

  /** 이름 바꾸기(사전 항목 이름만). 새 이름이 다른 상태와 겹치면 false */
  rename(oldName: string, newName: string): boolean {
    const e = this.find(oldName);
    if (!e) return false;
    const dup = this.find(newName);
    if (dup && dup[1] !== e[1]) return false;
    const d = this.statesDict();
    const list = [...d.entries].map(([k, h]) => (k === e[0] ? [newName, h] : [k, h]) as [string, string]);
    d.entries = new Map(list);
    return true;
  }

  get empty(): boolean {
    return !this.records.size && !this.head && !this.xdict && !this.states && !this.extraRemoved.length;
  }

  /** 모은 작업(표 머리 → 사전 → 레코드 순, 지우기는 뒤) */
  finish(): EditOp[] {
    const out: EditOp[] = [...this.ops];
    if (this.head) out.push({ kind: 'tableHead', key: 'LAYER', before: this.head.before, after: this.head.after });
    if (this.xdict) out.push({ kind: 'object', key: this.xdict.after.handle, before: this.xdict.before, after: this.xdict.after });
    if (this.states) out.push({ kind: 'object', key: this.states.after.handle, before: this.states.before, after: this.states.after });
    for (const [h, r] of this.records) {
      if (!r.before && !r.after) continue;
      out.push({ kind: 'object', key: h, before: r.before, after: r.after });
    }
    out.push(...this.extraRemoved);
    return out;
  }
}

// ---------------------------------------------------------------------------
// 저장(지금 도면층 → 상태)
// ---------------------------------------------------------------------------

/** 명명된 플롯 스타일 도면인지($PSTYLEMODE 0) */
export function namedPlotStyles(doc: CadDocument): boolean {
  return Number(doc.header.get('$PSTYLEMODE') ?? 1) === 0;
}

/** 명명된 플롯 스타일 사전(ACAD_PLOTSTYLENAME): 핸들 → 이름(원래 대소문자) */
export function plotStyleNameMap(doc: CadDocument): Map<string, string> {
  const out = new Map<string, string>();
  const root = doc.rootDictionary ? doc.objects.get(normalizeHandle(doc.rootDictionary)) : undefined;
  if (!isDict(root)) return out;
  const e = entry(root, 'ACAD_PLOTSTYLENAME');
  const d = e ? doc.objects.get(e[1]) : undefined;
  if (isDict(d)) for (const [n, h] of d.entries) out.set(normalizeHandle(h), n);
  return out;
}

/** 도면층의 플롯 스타일 이름(색상 종속 도면은 Color_n) */
export function layerPlotStyleName(doc: CadDocument, l: Layer, names = plotStyleNameMap(doc)): string {
  if (!namedPlotStyles(doc)) return `Color_${Math.abs(l.color.aci) || 7}`;
  return (l.plotStyle && names.get(normalizeHandle(l.plotStyle))) || 'Normal';
}

/** 도면층 → 상태 항목 플래그 */
export function layerStateFlags(l: Layer, vpFrozen = false): number {
  return (l.off ? LSF_OFF : 0) | (l.frozen ? LSF_FROZEN : 0) | (l.locked ? LSF_LOCKED : 0) | (l.plot !== false ? LSF_PLOT : 0) | (l.flags & 2 ? LSF_NEWVP : 0) | (vpFrozen ? LSF_VPFROZEN : 0);
}

export function layerStateEntry(doc: CadDocument, l: Layer, vpFrozen = false, names?: Map<string, string>): LayerStateLayer {
  const color = { aci: Math.abs(l.color.aci) || 7 } as LayerStateLayer['color'];
  if (l.color.rgb !== undefined) color.rgb = l.color.rgb;
  if (l.color.name) color.name = l.color.name;
  return {
    name: l.name,
    handle: l.handle || undefined,
    flags: layerStateFlags(l, vpFrozen),
    color,
    lineweight: l.lineweight,
    linetype: l.linetype || 'Continuous',
    plotStyle: layerPlotStyleName(doc, l, names),
    transparency: l.transparency >= 0 && l.transparency <= 255 ? l.transparency : 255,
  };
}

export interface CaptureOptions {
  name: string;
  description?: string;
  mask?: number;
  /** 배치(또는 배치의 뷰포트 안)에서 저장 */
  paperSpace?: boolean;
  /** 현재 뷰포트에서 동결된 도면층(대문자 이름) */
  vpFrozen?: ReadonlySet<string>;
}

/** 지금 도면층으로 상태를 만든다(모든 도면층) */
export function captureLayerState(doc: CadDocument, o: CaptureOptions): LayerState {
  const names = plotStyleNameMap(doc);
  const cl = doc.header.get('$CLAYER');
  return {
    name: o.name.trim(),
    mask: o.mask ?? LSM_ALL,
    description: o.description ?? '',
    paperSpace: !!o.paperSpace,
    currentLayer: typeof cl === 'string' && cl ? cl : '0',
    layers: [...doc.layers.values()].map((l) => layerStateEntry(doc, l, !!o.vpFrozen?.has(tableKey(l.name)), names)),
  };
}

// ---------------------------------------------------------------------------
// 복원(상태 → 도면층)
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** 복원할 특성(상태의 마스크) */
  mask: number;
  /** 상태에 없는 도면층 끄기 */
  offMissing?: boolean;
  /** 현재 뷰포트의 동결 목록(배치에서 복원할 때). 없으면 현재 VP 가시성은 복원하지 않는다 */
  viewportFrozen?: readonly string[] | null;
  /** 색상·선종류·선가중치·투명도·플롯 스타일을 뷰포트 재지정으로(이 웹 버전에 없어 건너뛴다) */
  asOverrides?: boolean;
}

export interface RestorePlan {
  /** 도면층 키 → 바꿀 값(바뀌는 것만) */
  patches: Map<string, Partial<Layer>>;
  /** 새 현재 도면층(바뀔 때만) */
  currentLayer?: string;
  /** 현재 뷰포트의 새 동결 목록(바뀔 때만) */
  viewportFrozen?: string[];
  /** 이 도면에 없는 선종류 */
  missingLinetypes: string[];
  /** 이 도면에 없는 플롯 스타일 */
  missingPlotStyles: string[];
  /** 동결하지 못한 현재 도면층 */
  keptCurrent?: string;
  /** 상태에는 있지만 이 도면에 없는 도면층 수 */
  missingLayers: number;
  /** 뷰포트 재지정으로 적용하지 못한 특성이 있었는지 */
  skippedOverrides: boolean;
}

/** 상태를 복원하는 변경 계획 */
export function planRestore(doc: CadDocument, s: LayerState, o: RestoreOptions): RestorePlan {
  const mask = o.mask;
  const plan: RestorePlan = { patches: new Map(), missingLinetypes: [], missingPlotStyles: [], missingLayers: 0, skippedOverrides: false };
  const named = namedPlotStyles(doc);
  const psByName = new Map<string, string>();
  for (const [h, n] of plotStyleNameMap(doc)) psByName.set(n.toUpperCase(), h);
  const overrideBits = LSM_COLOR | LSM_LINETYPE | LSM_LINEWEIGHT | LSM_TRANSPARENCY | LSM_PLOTSTYLE;
  if (o.asOverrides && mask & overrideBits) plan.skippedOverrides = true;
  const effective = o.asOverrides ? mask & ~overrideBits : mask;

  // 새 현재 도면층: 상태의 현재 도면층이 있고 복원 뒤 동결되지 않으면
  const inState = new Map<string, LayerStateLayer>();
  for (const e of s.layers) {
    const L = e.name ? doc.layers.get(tableKey(e.name)) : undefined;
    if (!L) {
      plan.missingLayers++;
      continue;
    }
    inState.set(tableKey(L.name), e);
  }
  const clNow = String(doc.header.get('$CLAYER') ?? '0');
  let cl = clNow;
  const want = s.currentLayer ? doc.layers.get(tableKey(s.currentLayer)) : undefined;
  if (want) {
    const e = inState.get(tableKey(want.name));
    const willFreeze = effective & LSM_FROZEN && e ? (e.flags & LSF_FROZEN) !== 0 : want.frozen;
    if (!willFreeze && !(want.flags & 16) && tableKey(want.name) !== tableKey(clNow)) {
      cl = want.name;
      plan.currentLayer = want.name;
    }
  }

  const missingLt = new Set<string>();
  const missingPs = new Set<string>();
  for (const [k, L] of doc.layers) {
    const e = inState.get(k);
    const p: Partial<Layer> = {};
    if (!e) {
      if (o.offMissing && !L.off) p.off = true;
    } else {
      if (effective & LSM_ON) p.off = (e.flags & LSF_OFF) !== 0;
      if (effective & LSM_FROZEN) {
        let f = (e.flags & LSF_FROZEN) !== 0;
        if (f && k === tableKey(cl)) {
          f = false;
          plan.keptCurrent = L.name;
        }
        p.frozen = f;
      }
      if (effective & LSM_LOCKED) p.locked = (e.flags & LSF_LOCKED) !== 0;
      if (effective & LSM_PLOT) p.plot = (e.flags & LSF_PLOT) !== 0;
      if (effective & LSM_NEWVP) p.flags = (L.flags & ~2) | (e.flags & LSF_NEWVP ? 2 : 0);
      if (effective & LSM_COLOR) {
        const c = { aci: Math.abs(e.color.aci) || 7 } as Layer['color'];
        if (e.color.rgb !== undefined) c.rgb = e.color.rgb;
        if (e.color.name) c.name = e.color.name;
        p.color = c;
      }
      if (effective & LSM_LINETYPE) {
        const lt = doc.linetypes.get(tableKey(e.linetype));
        if (lt) p.linetype = lt.name;
        else if (tableKey(e.linetype) === 'CONTINUOUS') p.linetype = 'Continuous';
        else missingLt.add(e.linetype);
      }
      if (effective & LSM_LINEWEIGHT) p.lineweight = e.lineweight;
      if (effective & LSM_TRANSPARENCY) p.transparency = e.transparency;
      if (effective & LSM_PLOTSTYLE && named && e.plotStyle) {
        const h = psByName.get(e.plotStyle.toUpperCase());
        if (h) p.plotStyle = h;
        else missingPs.add(e.plotStyle);
      }
    }
    // 바뀌는 것만
    const diff: Partial<Layer> = {};
    for (const [key, v] of Object.entries(p) as [keyof Layer, unknown][]) {
      if (JSON.stringify(L[key]) !== JSON.stringify(v)) (diff as Record<string, unknown>)[key] = v;
    }
    if (Object.keys(diff).length) plan.patches.set(k, diff);
  }
  plan.missingLinetypes = [...missingLt];
  plan.missingPlotStyles = [...missingPs];

  // 현재 뷰포트의 가시성
  if (effective & LSM_CURVP && o.viewportFrozen && s.paperSpace) {
    const cur = new Map(o.viewportFrozen.map((n) => [tableKey(n), n]));
    for (const [k, e] of inState) {
      const L = doc.layers.get(k)!;
      if (e.flags & LSF_VPFROZEN) cur.set(k, L.name);
      else cur.delete(k);
    }
    const next = [...cur.values()];
    if (next.length !== o.viewportFrozen.length || next.some((n, i) => n !== o.viewportFrozen![i])) plan.viewportFrozen = next;
  }
  return plan;
}

/** 지금 도면층이 상태와 같은지(마스크의 특성만, 도면에 있는 도면층만) */
export function stateMatches(doc: CadDocument, s: LayerState, viewportFrozen?: readonly string[] | null): boolean {
  const plan = planRestore(doc, s, { mask: s.mask & ~LSM_HIDDEN, viewportFrozen: viewportFrozen ?? null });
  return plan.patches.size === 0 && !plan.viewportFrozen;
}

/** 상태가 쓰는 선종류 이름(대문자, Continuous 제외) */
export function linetypesOf(s: LayerState): string[] {
  const out = new Set<string>();
  for (const l of s.layers) if (l.linetype && tableKey(l.linetype) !== 'CONTINUOUS') out.add(l.linetype);
  return [...out];
}

/** 상태 항목 → 새 도면층(가져올 때 이 도면에 없는 도면층을 만든다) */
export function layerFromEntry(e: LayerStateLayer, handle: string, linetypeExists: (n: string) => string | null): Layer {
  const color = { aci: Math.abs(e.color.aci) || 7 } as Layer['color'];
  if (e.color.rgb !== undefined) color.rgb = e.color.rgb;
  if (e.color.name) color.name = e.color.name;
  return {
    name: e.name,
    handle,
    flags: e.flags & LSF_NEWVP ? 2 : 0,
    color,
    off: (e.flags & LSF_OFF) !== 0,
    frozen: (e.flags & LSF_FROZEN) !== 0,
    locked: (e.flags & LSF_LOCKED) !== 0,
    linetype: linetypeExists(e.linetype) ?? 'Continuous',
    lineweight: e.lineweight,
    plot: (e.flags & LSF_PLOT) !== 0,
    transparency: e.transparency,
  };
}

export { LSM_ON, LSM_FROZEN, LSM_LOCKED, LSM_PLOT, LSM_NEWVP, LSM_COLOR, LSM_LINETYPE, LSM_LINEWEIGHT, LSM_PLOTSTYLE, LSM_CURVP, LSM_TRANSPARENCY };
