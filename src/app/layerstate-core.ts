/**
 * 도면층 상태의 앱 쪽 공통 부분: 지금 도면층으로 저장, 복원(현재 뷰포트의 VP 동결 포함), 업데이트·이름 바꾸기·삭제,
 * .las 내보내기·가져오기(다른 도면 포함), 복원 옵션(이 브라우저에 기억).
 * 상태는 도면의 ACAD_LAYERSTATES XRECORD에 바로 쓴다(저장하면 DXF·DWG에 그대로 남는다). 변경은 모두 명령 취소할 수 있다.
 */
import type { CadDocument, Layer, ViewportEntity } from '../core/model';
import { tableKey } from '../core/model';
import { importLayerStatesOps } from '../edit/layerstate/import';
import { LasFormatError, lasFileName, readLas, writeLas } from '../edit/layerstate/las';
import { LSM_ALL, type LayerState, layerStateNameProblem } from '../edit/layerstate/record';
import { LayerStateWriter, type StoredState, captureLayerState, findLayerState, listLayerStates, planRestore } from '../edit/layerstate/store';
import type { EditOp } from '../edit/session';
import type { App } from './app';
import type { DocState } from './docstate';
import { readDrawingFile } from './drawingfiles';
import { pickFiles } from './drawingfiles';
import { download } from './export';
import { loadPref, savePref } from './util2-ui';

export type Print = (text: string, cls?: 'err' | 'res') => void;

// ---------------------------------------------------------------------------
// 복원 옵션(AutoCAD도 사용자 설정으로 기억한다)
// ---------------------------------------------------------------------------

const PREF = 'opencad.layerstate.options';

export interface LayerStateOptions {
  /** 상태에서 찾을 수 없는 도면층 끄기 */
  offMissing: boolean;
  /** 뷰포트 재지정으로 특성 적용 */
  asOverrides: boolean;
  /** 외부 참조에 도면층 상태 나열 안 함 */
  hideXref: boolean;
}

export function layerStateOptions(): LayerStateOptions {
  return { offMissing: false, asOverrides: false, hideXref: false, ...loadPref<Partial<LayerStateOptions>>(PREF, {}) };
}

export function setLayerStateOptions(p: Partial<LayerStateOptions>): void {
  savePref(PREF, { ...layerStateOptions(), ...p });
}

// ---------------------------------------------------------------------------
// 현재 뷰포트
// ---------------------------------------------------------------------------

/** 현재 뷰포트: MSPACE면 그 뷰포트, 배치의 도면 공간이면 그 배치의 도면 공간 뷰포트(id 1). 모형 탭이면 null */
export function currentViewport(st: DocState): { block: string; vp: ViewportEntity } | null {
  if (st.msVp) {
    const block = tableKey(st.msVp.layout);
    const e = st.doc.blocks.get(block)?.entities.find((x) => x.handle === st.msVp!.handle);
    return e && e.type === 'VIEWPORT' ? { block, vp: e as ViewportEntity } : null;
  }
  if (st.isModel) return null;
  const block = tableKey(st.space);
  const vp = st.doc.blocks.get(block)?.entities.find((x): x is ViewportEntity => x.type === 'VIEWPORT' && (x as ViewportEntity).id === 1);
  return vp ? { block, vp } : null;
}

// ---------------------------------------------------------------------------
// 목록·저장·복원
// ---------------------------------------------------------------------------

/** 관리자에 나오는 상태(숨은 상태 제외, hideXref면 외부 참조 상태도 제외) */
export function visibleStates(doc: CadDocument, hideXref = layerStateOptions().hideXref): StoredState[] {
  return listLayerStates(doc).filter((s) => !(hideXref && s.key.includes('|')));
}

/** 지금 도면층으로 상태를 만든다(배치 탭이면 배치 상태 + 현재 뷰포트의 VP 동결) */
export function captureNow(st: DocState, name: string, description = '', mask = LSM_ALL): LayerState {
  const cv = currentViewport(st);
  return captureLayerState(st.doc, {
    name,
    description,
    mask,
    paperSpace: st.onLayout,
    vpFrozen: cv ? new Set(cv.vp.frozenLayers.map(tableKey)) : undefined,
  });
}

function commit(app: App, label: string, ops: EditOp[], group?: number): boolean {
  const st = app.active;
  if (!st || !ops.length) return false;
  st.session.commit({ label, ops, group });
  return true;
}

/** 상태 저장(같은 이름이 있으면 덮어쓴다) */
export function putLayerState(app: App, state: LayerState, group?: number, label = 'LAYERSTATE'): boolean {
  const st = app.active!;
  const w = new LayerStateWriter(st.doc, () => st.session.newHandle());
  w.put(state);
  return commit(app, label, w.finish(), group);
}

/** 새 상태 저장(지금 도면층) */
export function saveLayerState(app: App, name: string, description = '', group?: number, mask = LSM_ALL): boolean {
  const st = app.active!;
  return putLayerState(app, captureNow(st, name.trim(), description, mask), group);
}

/** 업데이트: 지금 도면층으로 다시 저장(설명·복원할 특성은 그대로) */
export function updateLayerState(app: App, name: string, group?: number): boolean {
  const st = app.active!;
  const old = findLayerState(st.doc, name);
  if (!old) return false;
  const s = captureNow(st, old.key, old.state.description, old.state.mask);
  return putLayerState(app, s, group);
}

export function deleteLayerState(app: App, name: string, group?: number): boolean {
  const st = app.active!;
  const w = new LayerStateWriter(st.doc, () => st.session.newHandle());
  if (!w.remove(name)) return false;
  return commit(app, 'LAYERSTATE', w.finish(), group);
}

/** 이름 바꾸기(문제가 있으면 그 까닭) */
export function renameLayerState(app: App, oldName: string, newName: string, group?: number): string | null {
  const st = app.active!;
  const n = newName.trim();
  const bad = layerStateNameProblem(n);
  if (bad) return bad;
  const dup = findLayerState(st.doc, n);
  const cur = findLayerState(st.doc, oldName);
  if (!cur) return `도면층 상태 "${oldName}"을(를) 찾을 수 없습니다.`;
  if (dup && dup.handle !== cur.handle) return `도면층 상태 "${n}"이(가) 이미 있습니다.`;
  const w = new LayerStateWriter(st.doc, () => st.session.newHandle());
  w.rename(cur.key, n);
  commit(app, 'LAYERSTATE', w.finish(), group);
  return null;
}

/** 복원할 특성(상태의 마스크)만 바꾸기 */
export function setLayerStateMask(app: App, name: string, mask: number, group?: number): boolean {
  const st = app.active!;
  const s = findLayerState(st.doc, name);
  if (!s || s.state.mask === mask) return false;
  return putLayerState(app, { ...s.state, mask }, group);
}

/**
 * 상태 복원. 상태의 마스크(복원할 특성)와 옵션으로 도면층·현재 도면층·현재 뷰포트의 VP 동결을 바꾼다(명령 취소 한 단계).
 * 이 웹 버전에서 할 수 없는 것(뷰포트 재지정, 없는 선종류·플롯 스타일)은 알린다.
 */
export function restoreLayerState(app: App, print: Print, state: LayerState, o: Partial<LayerStateOptions> & { group?: number } = {}): boolean {
  const st = app.active!;
  const opt = { ...layerStateOptions(), ...o };
  const cv = currentViewport(st);
  // 뷰포트 재지정은 배치의 뷰포트 안(MSPACE)에서만 고를 수 있다
  const asOverrides = opt.asOverrides && !!st.msVp;
  const plan = planRestore(st.doc, state, { mask: state.mask, offMissing: opt.offMissing, viewportFrozen: cv ? cv.vp.frozenLayers : null, asOverrides });
  const ops: EditOp[] = [];
  for (const [k, p] of plan.patches) {
    const before = st.doc.layers.get(k)!;
    const after: Layer = { ...structuredClone(before), ...structuredClone(p) };
    ops.push({ kind: 'layer', key: k, before, after });
  }
  if (plan.currentLayer) ops.push({ kind: 'header', name: '$CLAYER', before: st.doc.header.get('$CLAYER'), after: plan.currentLayer });
  if (plan.viewportFrozen && cv) ops.push({ kind: 'modify', block: cv.block, before: cv.vp, after: { ...cv.vp, frozenLayers: plan.viewportFrozen } });
  commit(app, 'LAYERSTATE', ops, o.group);
  if (plan.skippedOverrides) print('뷰포트 재지정은 이 웹 버전에서 지원하지 않아 색상·선종류·선가중치·투명도·플롯 스타일은 복원하지 않았습니다.');
  if (plan.missingLinetypes.length) print(`모든 선종류를 복원할 수 없습니다. 이 도면에 없는 선종류: ${plan.missingLinetypes.join(', ')}`);
  if (plan.missingPlotStyles.length) print(`플롯 스타일을 찾을 수 없어 복원하지 않았습니다: ${plan.missingPlotStyles.join(', ')}`);
  if (plan.keptCurrent) print(`현재 도면층 "${plan.keptCurrent}"은(는) 동결할 수 없어 동결하지 않았습니다.`);
  if (state.paperSpace && !cv && state.mask & 512 && state.layers.some((l) => l.flags & 32)) print('배치에서 저장한 상태의 현재 VP 가시성은 배치 탭에서 복원할 때만 적용됩니다.');
  return true;
}

// ---------------------------------------------------------------------------
// 내보내기·가져오기
// ---------------------------------------------------------------------------

/** 상태 하나를 .las로 내려받는다. 내려받은 파일 이름 */
export function exportLayerState(app: App, name: string): string | null {
  const st = app.active!;
  const s = findLayerState(st.doc, name);
  if (!s) return null;
  const file = lasFileName(s.key);
  const bytes = writeLas([s.state]);
  download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), file);
  return file;
}

export const IMPORT_ACCEPT = '.las,.dwg,.dxf,.dws,.dwt,.LAS,.DWG,.DXF,.DWS,.DWT';

export interface ImportSource {
  file: string;
  /** 숨은 상태를 뺀 상태들 */
  states: LayerState[];
  /** 다른 도면에서 읽었으면 그 도면 */
  source: CadDocument | null;
}

/** 가져올 파일을 고르고 읽는다(취소하면 null). 읽지 못하면 알리고 null */
export async function pickImportSource(app: App, print: Print): Promise<ImportSource | null> {
  const [f] = await pickFiles(IMPORT_ACCEPT, false);
  if (!f) return null;
  try {
    if (/\.las$/i.test(f.name)) {
      const states = readLas(new Uint8Array(await f.arrayBuffer()));
      if (!states.length) throw new LasFormatError();
      return { file: f.name, states, source: null };
    }
    const d = await readDrawingFile(app, f);
    return { file: f.name, states: listLayerStates(d.doc).map((s) => s.state), source: d.doc };
  } catch (e) {
    print(e instanceof LasFormatError ? e.message : `${f.name}을(를) 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return null;
  } finally {
    app.ui.setBusy(null);
  }
}

/** 상태들을 이 도면에 넣는다. overwrite(이름)로 같은 이름을 덮어쓸지 정한다. 가져온 상태 이름 */
export function importLayerStates(app: App, print: Print, src: ImportSource, states: readonly LayerState[], overwrite: (name: string) => boolean, group?: number): string[] {
  const st = app.active!;
  const r = importLayerStatesOps(st.doc, () => st.session.newHandle(), states, { overwrite, source: src.source });
  commit(app, 'LAYERSTATE', r.ops, group);
  if (r.invalid.length) print(`이름이 올바르지 않은 도면층 상태는 가져오지 않았습니다: ${r.invalid.join(', ')}`, 'err');
  if (r.createdLayers.length) print(`도면층 ${r.createdLayers.length}개를 만들었습니다: ${r.createdLayers.slice(0, 20).join(', ')}${r.createdLayers.length > 20 ? ' …' : ''}`);
  if (r.loadedLinetypes.length) print(`선종류를 로드했습니다: ${r.loadedLinetypes.join(', ')}`);
  if (r.missingLinetypes.length) print(`선종류를 찾을 수 없어 Continuous로 두었습니다: ${r.missingLinetypes.join(', ')}`);
  if (r.droppedLayers) print(`이름이 올바르지 않거나 외부 참조인 도면층 ${r.droppedLayers}개는 상태에서 뺐습니다.`);
  return r.imported;
}

/** 이름 있는 상태 찾기(관리자·명령행이 함께 쓴다) */
export function stateByName(app: App, name: string): StoredState | null {
  return findLayerState(app.active!.doc, name, { hidden: false });
}
