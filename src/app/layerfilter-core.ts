/**
 * 도면층 필터의 앱 쪽 공통 부분: 지금 고른 필터(문서마다, 필터 반전 포함), 필터 저장·이름 바꾸기·삭제·그룹 필터로 변환,
 * 그룹 필터의 도면층 추가·대치·제거, 필터의 도면층에 가시성·잠금·뷰포트 동결 적용, 도면에서 객체를 골라 도면층 얻기.
 * 필터는 도면의 LAYER 표 확장 사전에 바로 쓴다 — AutoCAD 형식(ACLYDICTIONARY, AutoCAD 도면층 특성 관리자에 보인다)을 쓰고,
 * AutoCAD 형식으로 쓸 수 없는 조건의 필터만 이 앱 기록(OPENCAD_LAYERFILTERS)으로 쓴다(src/edit/layerfilter/store.ts).
 * 저장하면 DXF·DWG에 남고, 변경은 명령 취소할 수 있다.
 */
import type { Layer } from '../core/model';
import { tableKey } from '../core/model';
import { FilterEvaluator, REF_ALL, isUserRef, matchContext, resolveFilterRef, userRef, visibleLayerKeys } from '../edit/layerfilter/match';
import { type FilterKind, type LayerFilter, canConvertToGroup, canNest, cleanRows, descendantsOf, filterKey, filterNameProblem, findFilter } from '../edit/layerfilter/model';
import { FilterStoreError, LayerFilterWriter, layerFiltersDict, listLayerFilters, migrateLayerFiltersOps } from '../edit/layerfilter/store';
import type { EditOp, Transaction } from '../edit/session';
import type { App } from './app';
import type { DocState } from './docstate';
import { currentViewport } from './layerstate-core';
import { currentLayer, patchLayers } from './layers';

export type Print = (text: string, cls?: 'err' | 'res') => void;

// ---------------------------------------------------------------------------
// 지금 고른 필터(문서마다)
// ---------------------------------------------------------------------------

export interface FilterView {
  /** 트리 노드 열쇠(match.ts의 참조) */
  ref: string;
  /** 필터 반전 */
  invert: boolean;
}

const views = new WeakMap<DocState, FilterView>();

export function filterView(st: DocState): FilterView {
  let v = views.get(st);
  if (!v) {
    v = { ref: REF_ALL, invert: false };
    views.set(st, v);
  }
  return v;
}

export function setFilterView(st: DocState, p: Partial<FilterView>): void {
  Object.assign(filterView(st), p);
}

export interface FilterResult {
  ref: string;
  label: string;
  invert: boolean;
  /** 필터 결과(반전 전) */
  keys: Set<string>;
  /** 보일 도면층(반전 뒤) */
  visible: Set<string>;
  total: number;
}

/** 지금 필터의 결과. 고른 필터가 없어졌으면 "모두"로 돌아간다 */
export function currentFilterResult(st: DocState): FilterResult {
  const v = filterView(st);
  const filters = listLayerFilters(st.doc);
  const ctx = matchContext(st.doc);
  let r = resolveFilterRef(st.doc, filters, v.ref, ctx);
  if (!r) {
    v.ref = REF_ALL;
    r = resolveFilterRef(st.doc, filters, REF_ALL, ctx)!;
  }
  return { ref: v.ref, label: r.label, invert: v.invert, keys: r.keys, visible: visibleLayerKeys(st.doc, r.keys, v.invert), total: st.doc.layers.size };
}

/** 상태 줄 글: "모두: 12개 도면층 중 5개 표시" */
export function filterStatusText(label: string, total: number, shown: number, invert = false): string {
  return `${label}${invert ? '(반전)' : ''}: ${total}개 도면층 중 ${shown}개 표시`;
}

/** 필터 참조의 도면층(반전하지 않은 결과). 없으면 null */
export function filterLayerKeys(st: DocState, ref: string): Set<string> | null {
  return resolveFilterRef(st.doc, listLayerFilters(st.doc), ref)?.keys ?? null;
}

// ---------------------------------------------------------------------------
// 필터 고치기
// ---------------------------------------------------------------------------

function commit(app: App, label: string, ops: EditOp[], group?: number): boolean {
  const st = app.active;
  if (!st || !ops.length) return false;
  st.session.commit({ label, ops, group });
  return true;
}

function writer(app: App): LayerFilterWriter {
  const st = app.active!;
  return new LayerFilterWriter(st.doc, () => st.session.newHandle());
}

/** 새로 만들 필터의 부모(고른 노드가 사용자 필터이고 중첩할 수 있으면 그 필터) */
export function parentForNew(app: App, kind: FilterKind, ref: string): string | null {
  if (!isUserRef(ref)) return null;
  const f = listLayerFilters(app.active!.doc).find((x) => userRef(x.name) === ref);
  return f && canNest(f.kind, kind) ? f.name : null;
}

/**
 * 필터 저장(새로 만들기 또는 previousName 필터 고치기). 문제가 있으면 그 까닭, 저장했으면 null.
 * 이름은 다른 필터와 겹칠 수 없고, 부모와의 중첩 규칙(특성 필터 아래에는 특성 필터만)을 지킨다.
 */
export function saveLayerFilter(app: App, f: LayerFilter, previousName?: string, group?: number): string | null {
  const st = app.active!;
  const filters = listLayerFilters(st.doc);
  const prev = previousName ? findFilter(filters, previousName) : null;
  if (previousName && !prev) return `필터 "${previousName}"을(를) 찾을 수 없습니다.`;
  const others = filters.filter((x) => x !== prev).map((x) => x.name);
  const name = f.name.trim();
  const bad = filterNameProblem(name, others);
  if (bad) return bad;
  const parent = findFilter(filters, f.parent);
  if (f.parent && !parent) return `부모 필터 "${f.parent}"을(를) 찾을 수 없습니다.`;
  if (parent && !canNest(parent.kind, f.kind)) return '특성 필터 아래에는 그룹 필터를 둘 수 없습니다.';
  if (prev && parent && descendantsOf(filters, prev.name).some((d) => filterKey(d.name) === filterKey(parent.name))) return '필터를 자기 아래 필터 안에 둘 수 없습니다.';
  if (prev && f.kind === 'property' && filters.some((d) => d.kind === 'group' && filterKey(d.parent ?? '') === filterKey(prev.name))) return '그룹 필터가 들어 있는 필터는 특성 필터로 바꿀 수 없습니다.';
  const clean: LayerFilter = {
    name,
    kind: f.kind,
    parent: parent?.name ?? null,
    rows: f.kind === 'property' ? cleanRows(f.rows) : [],
    layers: f.kind === 'group' ? f.layers.filter((n) => st.doc.layers.has(tableKey(n))) : [],
  };
  // 이 앱 정의로 바꿀 수 없는 AutoCAD 식(읽기 전용)은 정의 행이 없을 때 그대로 둔다
  if (clean.kind === 'property' && !clean.rows.length && f.expression !== undefined) clean.expression = f.expression;
  const w = writer(app);
  const problem = w.problem(clean, prev?.name);
  if (problem) return problem;
  try {
    w.put(clean, prev?.name);
  } catch (e) {
    if (e instanceof FilterStoreError) return e.message;
    throw e;
  }
  commit(app, 'LAYER', w.finish(), group);
  // 이름이 바뀌었으면 지금 고른 필터도 따라간다
  const v = filterView(st);
  if (prev && v.ref === userRef(prev.name)) v.ref = userRef(name);
  return null;
}

/** 필터(와 그 아래 필터) 삭제. 지운 필터 이름 */
export function deleteLayerFilter(app: App, name: string, group?: number): string[] {
  const w = writer(app);
  const gone = w.remove(name);
  if (gone.length) commit(app, 'LAYER', w.finish(), group);
  const v = filterView(app.active!);
  if (gone.some((n) => userRef(n) === v.ref)) v.ref = REF_ALL;
  return gone;
}

/**
 * 여러 필터 삭제(FILTERS). 지우지 않는 필터가 지우는 필터 아래에 있으면 가장 가까운 남는 부모 아래(없으면 맨 위)로 옮긴다.
 * 지운 필터 수
 */
export function deleteLayerFilters(app: App, names: readonly string[], group?: number): number {
  const st = app.active!;
  const filters = listLayerFilters(st.doc);
  const gone = new Set(names.map(filterKey));
  const doomed = filters.filter((f) => gone.has(filterKey(f.name)));
  if (!doomed.length) return 0;
  const w = writer(app);
  for (const f of filters) {
    if (gone.has(filterKey(f.name)) || !f.parent || !gone.has(filterKey(f.parent))) continue;
    let p = findFilter(filters, f.parent);
    const seen = new Set<string>();
    while (p && gone.has(filterKey(p.name)) && !seen.has(filterKey(p.name))) {
      seen.add(filterKey(p.name));
      p = findFilter(filters, p.parent);
    }
    w.put({ ...f, parent: p && !gone.has(filterKey(p.name)) ? p.name : null }, f.name);
  }
  let n = 0;
  for (const f of doomed) n += w.remove(f.name).length;
  commit(app, 'FILTERS', w.finish(), group);
  const v = filterView(st);
  if (isUserRef(v.ref) && !listLayerFilters(st.doc).some((f) => userRef(f.name) === v.ref)) v.ref = REF_ALL;
  return n;
}

/** 이름 바꾸기(문제가 있으면 그 까닭) */
export function renameLayerFilter(app: App, oldName: string, newName: string, group?: number): string | null {
  const f = findFilter(listLayerFilters(app.active!.doc), oldName);
  if (!f) return `필터 "${oldName}"을(를) 찾을 수 없습니다.`;
  if (f.name === newName.trim()) return null;
  return saveLayerFilter(app, { ...f, name: newName }, f.name, group);
}

/** 특성 필터를 그룹 필터로(지금 그 필터에 드는 도면층으로). 문제가 있으면 그 까닭 */
export function convertToGroupFilter(app: App, name: string, group?: number): string | null {
  const st = app.active!;
  const filters = listLayerFilters(st.doc);
  const f = findFilter(filters, name);
  if (!f) return `필터 "${name}"을(를) 찾을 수 없습니다.`;
  if (f.kind !== 'property') return '이미 그룹 필터입니다.';
  if (!canConvertToGroup(filters, f)) return '특성 필터 아래의 특성 필터는 그룹 필터로 바꿀 수 없습니다.';
  const keys = new FilterEvaluator(st.doc, filters).of(f);
  const layers = [...keys].map((k) => st.doc.layers.get(k)!.name).sort((a, b) => a.localeCompare(b, 'ko'));
  return saveLayerFilter(app, { ...f, kind: 'group', rows: [], layers }, f.name, group);
}

/** 그룹 필터의 도면층 바꾸기: add 추가, replace 대치, remove 제거. 바뀐 도면층 수(필터가 없거나 그룹이 아니면 -1) */
export function editGroupLayers(app: App, name: string, layers: readonly string[], mode: 'add' | 'replace' | 'remove', group?: number): number {
  const st = app.active!;
  const f = findFilter(listLayerFilters(st.doc), name);
  if (!f || f.kind !== 'group') return -1;
  const has = new Map(f.layers.map((n) => [tableKey(n), n]));
  const given = new Map<string, string>();
  for (const n of layers) {
    const l = st.doc.layers.get(tableKey(n));
    if (l) given.set(tableKey(l.name), l.name);
  }
  let next: Map<string, string>;
  if (mode === 'replace') next = given;
  else if (mode === 'add') next = new Map([...has, ...[...given].filter(([k]) => !has.has(k))]);
  else next = new Map([...has].filter(([k]) => !given.has(k)));
  const changed = mode === 'replace' ? [...new Set([...has.keys(), ...next.keys()])].filter((k) => has.has(k) !== next.has(k)).length : Math.abs(next.size - has.size);
  if (!changed) return 0;
  const err = saveLayerFilter(app, { ...f, layers: [...next.values()] }, f.name, group);
  return err ? -1 : changed;
}

/**
 * 확정 고리(확정 직전): 예전 이 앱 기록(OPENCAD_LAYERFILTERS)이 남은 도면이면 AutoCAD 형식으로 옮기는 작업을 그 트랜잭션에 붙인다
 * — 도면을 고쳐 저장하면 AutoCAD에서도 필터가 보인다. 트랜잭션이 같은 객체나 표 머리를 고치면 다음 확정으로 미룬다.
 * 고치지 않고 저장한 도면은 그대로다(이 앱은 계속 읽는다).
 */
export function migrateFiltersOnCommit(st: DocState, tx: Transaction): Transaction {
  if (!layerFiltersDict(st.doc)?.entries.size || tx.ops.some((o) => o.kind === 'tableHead')) return tx;
  let ops: EditOp[];
  try {
    ops = migrateLayerFiltersOps(st.doc, () => st.session.newHandle());
  } catch (e) {
    console.warn('도면층 필터 옮기기 실패', e);
    return tx;
  }
  if (!ops.length) return tx;
  const keys = new Set(ops.map((o) => (o.kind === 'object' ? o.key : '')));
  if (ops.some((o) => o.kind === 'tableHead') || tx.ops.some((o) => o.kind === 'object' && keys.has(o.key))) return tx;
  return { ...tx, ops: [...tx.ops, ...ops] };
}

// ---------------------------------------------------------------------------
// 필터의 도면층에 적용
// ---------------------------------------------------------------------------

export type FilterAction = 'on' | 'off' | 'thaw' | 'freeze' | 'lock' | 'unlock' | 'vpfreeze' | 'vpthaw';

/** 필터(반전하지 않은 결과)의 도면층에 가시성·잠금·뷰포트 동결을 적용한다. 바뀐 도면층 수 */
export function applyFilterAction(app: App, ref: string, action: FilterAction, print: Print = (t, c) => app.cmd.print(t, c)): number {
  const st = app.active!;
  const keys = filterLayerKeys(st, ref);
  if (!keys) return 0;
  const layers = [...keys].map((k) => st.doc.layers.get(k)!).filter(Boolean) as Layer[];
  if (!layers.length) {
    print('필터에 도면층이 없습니다.');
    return 0;
  }
  switch (action) {
    case 'on':
      return patchLayers(app, 'LAYER', layers.map((l) => [l.name, { off: false }]));
    case 'off':
      return patchLayers(app, 'LAYER', layers.map((l) => [l.name, { off: true }]));
    case 'thaw':
      return patchLayers(app, 'LAYER', layers.map((l) => [l.name, { frozen: false }]));
    case 'lock':
      return patchLayers(app, 'LAYER', layers.map((l) => [l.name, { locked: true }]));
    case 'unlock':
      return patchLayers(app, 'LAYER', layers.map((l) => [l.name, { locked: false }]));
    case 'freeze': {
      const cl = tableKey(currentLayer(app));
      const list = layers.filter((l) => tableKey(l.name) !== cl);
      if (list.length < layers.length) print(`현재 도면층 "${currentLayer(app)}"은(는) 동결할 수 없어 동결하지 않았습니다.`);
      return patchLayers(app, 'LAYER', list.map((l) => [l.name, { frozen: true }]));
    }
    case 'vpfreeze':
    case 'vpthaw': {
      const cv = currentViewport(st);
      if (!cv) {
        print('뷰포트 동결은 배치 탭에서만 쓸 수 있습니다.', 'err');
        return 0;
      }
      const cur = new Map(cv.vp.frozenLayers.map((n) => [tableKey(n), n]));
      let n = 0;
      for (const l of layers) {
        const k = tableKey(l.name);
        if (action === 'vpfreeze' && !cur.has(k)) {
          cur.set(k, l.name);
          n++;
        } else if (action === 'vpthaw' && cur.has(k)) {
          cur.delete(k);
          n++;
        }
      }
      if (n) commit(app, 'VPLAYER', [{ kind: 'modify', block: cv.block, before: cv.vp, after: { ...cv.vp, frozenLayers: [...cur.values()] } }]);
      return n;
    }
  }
}

// ---------------------------------------------------------------------------
// 도면에서 객체 고르기
// ---------------------------------------------------------------------------

/** 객체들의 도면층 이름(겹침 없이, 도면에 있는 것만) */
export function layersOfEntities(st: DocState, handles: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    const l = e ? st.doc.layers.get(tableKey(e.layer)) : undefined;
    if (l) out.set(tableKey(l.name), l.name);
  }
  return [...out.values()];
}

/**
 * 도면에서 객체를 골라 그 도면층들을 얻는다(SELECT 명령으로 고른다 — 미리 고른 객체가 있으면 그것). 취소하거나 고른 것이 없으면 null.
 */
export async function pickLayersFromDrawing(app: App): Promise<string[] | null> {
  const st = app.active;
  if (!st) return null;
  let hs: string[] = [];
  if (app.findCommand('SELECT')) {
    const prev = app.lastSelection;
    app.lastSelection = [];
    await app.run('SELECT');
    hs = app.lastSelection;
    if (!hs.length) app.lastSelection = prev;
  } else hs = [...st.selection];
  if (!hs.length) return null;
  const names = layersOfEntities(st, hs);
  return names.length ? names : null;
}
