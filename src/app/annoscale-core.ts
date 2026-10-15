/**
 * 주석 축척의 앱 쪽 일: 지금 보이는 주석 축척(모형 = CANNOSCALE, 뷰포트 안 = 그 뷰포트, 도면 공간 = 1:1), CANNOSCALE
 * 전환(ANNOAUTOSCALE 포함), 뷰포트 주석 축척 쓰기, 편집 고리(새 주석 객체·복사본·다른 편집 따라가기), 표시 다시 그리기.
 * 계산은 src/edit/annoscale(순수 함수), 명령은 annoscale.ts, 대화상자는 annoscale-ui.ts, 상태 막대는 annoscale-status.ts.
 */
import type { Entity, ViewportEntity, XRecordObject } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { type EditOp, type Transaction, applyOps, isLayoutBlock } from '../edit/session';
import {
  type AnnoScale,
  type EditEnv,
  ScaleIndex,
  addScales,
  adoptRecords,
  allVisible,
  allVisibleOps,
  annoState,
  annotativeFlag,
  blockAnnotative,
  cannoscaleName,
  changed,
  cloneRecordsForCopy,
  currentScale,
  defaultScales,
  dictOf,
  dictVarOps,
  entryOf,
  findScale,
  ownRecord,
  followEdit,
  isMetric,
  makeAnnotative,
  readScaleList,
  scaleListOps,
  setDictEntries,
  switchScale,
  upgradeOwnRecords,
  unitScale,
  upper,
  viewportAnnoScale,
  viewportSynced,
  wantsAnnotative,
} from '../edit/annoscale';
import type { App } from './app';
import { addHook } from './hooks';
import type { DocState } from './docstate';
import { loadPref, savePref } from './util2-ui';

// ---------------------------------------------------------------------------
// 이 브라우저에 저장하는 설정(어느 실물에도 도면 안 저장 자리가 없다)
// ---------------------------------------------------------------------------

const PREF_AUTOSCALE = 'opencad.annoautoscale';
const PREF_HIDEXREF = 'opencad.hidexrefscales';
const PREF_PERCENT = 'opencad.annoscalepercent';

/** ANNOAUTOSCALE(-4…4, 기본 -4 = 끔): 1 꺼짐·동결·잠긴 도면층 제외, 2 꺼짐·동결 제외, 3 잠김 제외, 4 모두 */
export function annoAutoscale(): number {
  const v = loadPref<number>(PREF_AUTOSCALE, -4);
  return Number.isInteger(v) && v >= -4 && v <= 4 && v !== 0 ? v : -4;
}

export function setAnnoAutoscale(v: number): void {
  savePref(PREF_AUTOSCALE, v);
}

/** 외부 참조 축척 숨기기(HIDEXREFSCALES, 기본 1) */
export function hideXrefScales(): boolean {
  return loadPref<number>(PREF_HIDEXREF, 1) !== 0;
}

export function setHideXrefScales(on: boolean): void {
  savePref(PREF_HIDEXREF, on ? 1 : 0);
}

/** 비율 축척 백분율로 보이기 */
export function percentScales(): boolean {
  return loadPref<number>(PREF_PERCENT, 0) === 1;
}

export function setPercentScales(on: boolean): void {
  savePref(PREF_PERCENT, on ? 1 : 0);
}

/** 이름이 _XREF(+숫자)로 끝나는 축척 */
export function isXrefScale(s: AnnoScale): boolean {
  return /_XREF\d*$/i.test(s.name);
}

/** 목록에 보일 축척(외부 참조 축척 숨기기 반영) */
export function listedScales(list: readonly AnnoScale[]): AnnoScale[] {
  return hideXrefScales() ? list.filter((s) => !isXrefScale(s)) : [...list];
}

// ---------------------------------------------------------------------------
// 편집 도우미
// ---------------------------------------------------------------------------

/** 이 모듈이 만든 변경(편집 고리가 다시 다루지 않는다) */
const ownTx = new WeakSet<Transaction>();
let groupSerial = 1_000_000_000;

/** 명령 취소 한 단계로 묶을 새 번호(명령 밖 — 상태 막대·대화상자) */
export function newGroup(): number {
  return ++groupSerial;
}

export function commitOwn(st: DocState, label: string, ops: EditOp[], group?: number): void {
  if (!ops.length) return;
  const tx: Transaction = { label, ops, group };
  ownTx.add(tx);
  st.session.commit(tx);
}

export function envFor(st: DocState): EditEnv {
  return { doc: st.doc, alloc: () => st.session.newHandle(), idx: new ScaleIndex(st.doc) };
}

/** 리스트가 없는 도면(R12, 새 ezdxf 도면)에 기본 리스트를 만든다(같은 명령 취소 단계). 도면의 리스트를 돌려준다 */
export function ensureScaleList(st: DocState, label: string, group: number): AnnoScale[] {
  const have = readScaleList(st.doc);
  if (have.length) return have;
  const r = scaleListOps(st.doc, defaultScales(isMetric(st.doc)), () => st.session.newHandle());
  commitOwn(st, label, r.ops, group);
  return readScaleList(st.doc);
}

/** 모형 CANNOSCALE 이름(리스트의 대소문자) */
export function currentScaleName(st: DocState): string {
  return currentScale(st.doc)?.name ?? cannoscaleName(st.doc);
}

/** 모형 공간 블록 키(블록 편집기 등은 제외) */
const MODEL = tableKey(MODEL_SPACE);

// ---------------------------------------------------------------------------
// 지금 보이는 주석 축척
// ---------------------------------------------------------------------------

export interface Shown {
  /** model: 모형 탭(CANNOSCALE), viewport: 배치 뷰포트 안(MSPACE), paper: 도면 공간(1:1), none: 열린 도면 없음·블록 편집기 */
  where: 'model' | 'viewport' | 'paper' | 'none';
  scale: AnnoScale | undefined;
  list: AnnoScale[];
  vp?: ViewportEntity;
  locked?: boolean;
  /** 뷰포트 축척이 주석 축척과 같은지 */
  synced?: boolean;
}

export const VP_LOCKED = 0x4000;

export function shownScale(app: App): Shown {
  const st = app.active;
  if (!st || st.blockEdit) return { where: 'none', scale: undefined, list: [] };
  const idx = new ScaleIndex(st.doc);
  const list = idx.list;
  if (st.msVp) {
    const vp = st.doc.entityIndex.get(st.msVp.handle);
    if (vp?.type === 'VIEWPORT') {
      const s = viewportAnnoScale(st.doc, vp, list);
      return { where: 'viewport', scale: s, list, vp, locked: (vp.flags & VP_LOCKED) !== 0, synced: s ? viewportSynced(vp, s) : true };
    }
  }
  if (st.space === MODEL) return { where: 'model', scale: currentScale(st.doc, list), list };
  return { where: 'paper', scale: unitScale(list) ?? { name: '1:1', paper: 1, drawing: 1, unit: true }, list };
}

/** 새 주석 객체·AIOBJECTSCALEADD가 쓰는 "현재 주석 축척"(공간 키 기준) */
export function scaleForSpace(app: App, st: DocState, space: string): AnnoScale | undefined {
  const list = new ScaleIndex(st.doc).list;
  if (tableKey(space) === MODEL) {
    if (st.msVp) {
      const vp = st.doc.entityIndex.get(st.msVp.handle);
      if (vp?.type === 'VIEWPORT') return viewportAnnoScale(st.doc, vp, list);
    }
    return currentScale(st.doc, list);
  }
  void app;
  return unitScale(list);
}

// ---------------------------------------------------------------------------
// CANNOSCALE 전환
// ---------------------------------------------------------------------------

/** ANNOAUTOSCALE 도면층 규칙 */
function layerAllows(st: DocState, e: Entity, mode: number): boolean {
  const l = st.doc.layers.get(tableKey(e.layer));
  if (!l) return true;
  switch (mode) {
    case 1:
      return !l.off && !l.frozen && !l.locked;
    case 2:
      return !l.off && !l.frozen;
    case 3:
      return !l.locked;
    default:
      return true;
  }
}

/** ANNOAUTOSCALE: 바꾸기 전 축척을 지원하던 모형 공간 주석 객체에 새 축척을 더한다(같은 명령 취소 단계) */
function autoscaleOps(st: DocState, from: string, to: string, label: string, group: number): number {
  const mode = annoAutoscale();
  if (mode < 1) return 0;
  const env = envFor(st);
  const ops: EditOp[] = [];
  let n = 0;
  for (const e of st.doc.blocks.get(MODEL)?.entities ?? []) {
    const s = annoState(st.doc, e, env.idx);
    if (!s || s.foreign || !s.byScale.has(from.toUpperCase()) || s.byScale.has(to.toUpperCase()) || !layerAllows(st, e, mode)) continue;
    const r = addScales(env, e, [to]);
    ops.push(...r.ops);
    if (r.entity !== e) ops.push({ kind: 'modify', block: MODEL, before: e, after: r.entity });
    n++;
  }
  commitOwn(st, label, ops, group);
  return n;
}

/**
 * 모형 CANNOSCALE을 바꾼다: 변수(DICTIONARYVAR) + 그 축척을 가진 모형 공간 주석 객체는 그 표현을 보인다.
 * ANNOAUTOSCALE이 켜져 있으면 먼저 축척을 더한다. 한 번의 명령 취소.
 */
export function setCannoscale(app: App, st: DocState, name: string, group: number, label = 'CANNOSCALE'): AnnoScale | null {
  const list = ensureScaleList(st, label, group);
  const s = findScale(list, name);
  if (!s) return null;
  const before = currentScale(st.doc, list);
  if (before && before.name.toUpperCase() !== s.name.toUpperCase()) autoscaleOps(st, before.name, s.name, label, group);
  const env = envFor(st);
  const ops: EditOp[] = [];
  dictVarOps(st.doc, 'CANNOSCALE', s.name, env.alloc, ops);
  for (const e of st.doc.blocks.get(MODEL)?.entities ?? []) {
    if (!e.xdict && !e.xdata && e.type !== 'INSERT') continue;
    const r = switchScale(env, e, s.name);
    if (r.entity === e && !r.ops.length) continue;
    ops.push(...r.ops);
    if (r.entity !== e) ops.push({ kind: 'modify', block: MODEL, before: e, after: r.entity });
  }
  commitOwn(st, label, ops, group);
  void app;
  return s;
}

// ---------------------------------------------------------------------------
// 뷰포트 주석 축척
// ---------------------------------------------------------------------------

const VP_KEY = 'ASDK_XREC_ANNOTATION_SCALE_INFO';

/** 뷰포트의 주석 축척 레코드를 쓰고(없으면 확장 사전과 함께 만든다) 바뀐 뷰포트를 돌려준다 */
function viewportRecordOps(st: DocState, vp: ViewportEntity, scaleH: string, ops: EditOp[]): ViewportEntity {
  const doc = st.doc;
  let out = vp;
  let xd = dictOf(doc, vp.xdict);
  if (!xd) {
    const h = st.session.newHandle();
    xd = { type: 'DICTIONARY', handle: h, owner: upper(vp.handle), entries: new Map(), hardOwner: true, cloning: 1 };
    ops.push({ kind: 'object', key: h, before: null, after: xd });
    out = { ...vp, xdict: h };
  }
  const xh = entryOf(xd, VP_KEY);
  const x = xh ? doc.objects.get(xh) : undefined;
  if (x && x.type === 'XRECORD') {
    const rec = x as XRecordObject;
    const data = rec.data.some((t) => t.code === 340) ? rec.data.map((t) => (t.code === 340 ? { code: 340, value: scaleH } : t)) : [...rec.data, { code: 340, value: scaleH }];
    ops.push({ kind: 'object', key: upper(rec.handle), before: rec, after: changed(rec, { data }) });
  } else {
    const h = st.session.newHandle();
    const rec: XRecordObject = {
      type: 'XRECORD',
      handle: h,
      owner: upper(xd.handle),
      reactors: [upper(xd.handle)],
      cloning: 1,
      data: [
        { code: 90, value: 1 },
        { code: 340, value: scaleH },
      ],
    };
    ops.push({ kind: 'object', key: h, before: null, after: rec });
    setDictEntries(doc, ops, xd, [...xd.entries, [VP_KEY, h]]);
  }
  return out;
}

/** 뷰포트가 든 배치 블록 키 */
export function layoutKeyOf(st: DocState, vp: ViewportEntity): string | null {
  const owner = vp.owner?.toUpperCase();
  const lay = owner ? st.doc.layouts.find((l) => l.blockRecord.toUpperCase() === owner) : undefined;
  if (lay) return tableKey(lay.blockName);
  for (const l of st.doc.layouts) if (st.doc.blocks.get(tableKey(l.blockName))?.entities.some((e) => e.handle === vp.handle)) return tableKey(l.blockName);
  return null;
}

/**
 * 뷰포트의 주석 축척을 바꾼다. viewScale이면 뷰포트 축척도 그 축척으로(뷰 중심은 그대로).
 * ANNOAUTOSCALE은 주석 축척이 바뀔 때 바꾸기 전 축척을 가진 모형 공간 주석 객체에 새 축척을 더한다.
 */
export function setViewportAnnoScale(st: DocState, vp: ViewportEntity, name: string, viewScale: boolean, group: number, label = 'CANNOSCALE'): AnnoScale | null {
  const lay = layoutKeyOf(st, vp);
  if (!lay) return null;
  const list = ensureScaleList(st, label, group);
  const s = findScale(list, name);
  if (!s?.handle) return null;
  const before = viewportAnnoScale(st.doc, vp, list);
  if (before && before.name.toUpperCase() !== s.name.toUpperCase()) autoscaleOps(st, before.name, s.name, label, group);
  const cur = (st.doc.entityIndex.get(vp.handle) as ViewportEntity | undefined) ?? vp;
  const ops: EditOp[] = [];
  let after = viewportRecordOps(st, cur, upper(s.handle), ops);
  if (viewScale && !(cur.flags & VP_LOCKED)) after = { ...after, viewHeight: (cur.height * s.drawing) / s.paper };
  if (after !== cur) ops.push({ kind: 'modify', block: lay, before: cur, after });
  commitOwn(st, label, ops, group);
  return s;
}

/** 뷰포트 축척 = 주석 축척(동기화) */
export function syncViewportScale(st: DocState, vp: ViewportEntity, group: number): boolean {
  const lay = layoutKeyOf(st, vp);
  const s = viewportAnnoScale(st.doc, vp);
  if (!lay || !s || vp.flags & VP_LOCKED || viewportSynced(vp, s)) return false;
  commitOwn(st, 'VPSCALE', [{ kind: 'modify', block: lay, before: vp, after: { ...vp, viewHeight: (vp.height * s.drawing) / s.paper } }], group);
  return true;
}

/** 지금 보이는 곳의 주석 축척을 바꾼다(상태 막대·명령). 도면 공간이면 false */
export function chooseScale(app: App, name: string, group = newGroup()): boolean {
  const st = app.active;
  if (!st) return false;
  const sh = shownScale(app);
  if (sh.where === 'model') return !!setCannoscale(app, st, name, group);
  if (sh.where === 'viewport' && sh.vp) {
    if (sh.locked) {
      app.cmd.print('뷰포트가 잠겨 있어 축척을 바꿀 수 없습니다.', 'err');
      return false;
    }
    return !!setViewportAnnoScale(st, sh.vp, name, true, group);
  }
  return false;
}

/** 지금 탭의 ANNOALLVISIBLE */
export function tabKey(st: DocState): string {
  return st.msVp?.layout ?? (st.blockEdit ? MODEL : st.space);
}

export function setAllVisible(st: DocState, on: boolean, group = newGroup()): void {
  commitOwn(st, 'ANNOALLVISIBLE', allVisibleOps(st.doc, tabKey(st), on), group);
}

export function tabAllVisible(st: DocState): boolean {
  return allVisible(st.doc, tabKey(st));
}

// ---------------------------------------------------------------------------
// 편집 고리: 다른 명령이 만든 변경에 주석 처리를 붙인다(같은 명령 취소 단계)
// ---------------------------------------------------------------------------

/**
 * - 새 객체: 주석 문자 스타일의 TEXT·MTEXT, 주석 블록의 참조, 주석 치수 스타일의 치수, 주석 다중 지시선 스타일의
 *   다중 지시선은 그 공간의 현재 주석 축척(모형 = CANNOSCALE·활성 뷰포트, 배치 = 1:1)으로 주석 객체가 된다.
 * - 복사본(다른 객체의 확장 사전을 가리키는 새 객체): 자기 사전과 레코드를 얻는다.
 * - 바뀐 주석 객체: 레코드가 따라간다(이동·회전·축척은 모든 축척 표현이 같이 움직인다).
 */
export function annotateTransaction(app: App, st: DocState, tx: Transaction): Transaction {
  if (ownTx.has(tx) || !tx.ops.some((o) => (o.kind === 'add' || o.kind === 'modify') && isLayoutBlock(o.block))) return tx;
  const doc = st.doc;
  let env: EditEnv | null = null;
  const getEnv = (): EditEnv => {
    if (!env) {
      env = envFor(st);
      env.taken = new Set(tx.ops.filter((o) => o.kind === 'blockDef').map((o) => o.key));
    }
    return env;
  };
  const extra: EditOp[] = [];
  const dropBlocks = new Set<string>();
  let listMade = false;
  /** 레코드의 340이 가리킬 축척 리스트(없는 도면은 같은 변경에서 기본 리스트를 만든다) */
  const withList = (): EditEnv => {
    const en = getEnv();
    if (!listMade && !readScaleList(doc).length) {
      const r = scaleListOps(doc, defaultScales(isMetric(doc)), en.alloc);
      extra.unshift(...r.ops);
      en.idx.adopt(r.list);
    }
    listMade = true;
    return en;
  };
  const out: EditOp[] = [];
  for (const op of tx.ops) {
    try {
      if (op.kind === 'add' && isLayoutBlock(op.block)) {
        const e = op.entity;
        const xd = dictOf(doc, e.xdict);
        if (xd && upper(xd.owner) !== upper(e.handle)) {
          const r = cloneRecordsForCopy(getEnv(), e, undefined);
          extra.push(...r.ops);
          out.push({ ...op, entity: r.entity });
          continue;
        }
        // 복사 명령은 확장 사전을 떼어 낸다: 고른 객체에서 원본을 찾아 그 레코드를 복사본 자리로 옮겨 준다
        if (!e.xdict && looksAnnotative(doc, e)) {
          const src = findCopySource(app, st, op.block, e);
          if (src?.xdict) {
            const r = cloneRecordsForCopy(getEnv(), { ...e, xdict: src.xdict }, src);
            extra.push(...r.ops);
            out.push({ ...op, entity: r.entity });
            continue;
          }
          if (annotativeFlag(e.xdata) === true) {
            const s = scaleForSpace(app, st, op.block);
            const r = s ? adoptRecords(withList(), e, s.name) : null;
            if (r && r.entity !== e) {
              extra.push(...r.ops);
              out.push({ ...op, entity: r.entity });
              continue;
            }
          }
        }
        if (wantsAnnotative(doc, e)) {
          const en = withList();
          const s = scaleForSpace(app, st, op.block);
          const scale = s ? en.idx.name(s.name) : undefined;
          if (scale) {
            const r = makeAnnotative(en, e, scale.name, { creating: true });
            if (r.entity !== e) {
              // 치수: 다시 그린 그림을 쓰므로 명령이 만든 옛 블록은 넣지 않는다
              if (e.type === 'DIMENSION' && r.entity.type === 'DIMENSION' && r.entity.block !== e.block) dropBlocks.add(tableKey(e.block));
              extra.push(...r.ops);
              out.push({ ...op, entity: r.entity });
              continue;
            }
          }
        }
      } else if (op.kind === 'modify' && isLayoutBlock(op.block) && (op.before.xdict || op.before.xdata)) {
        if (!op.before.xdict && annotativeFlag(op.before.xdata) === undefined && !op.before.xdata?.some((x) => x.app.toUpperCase() === 'OPENCAD_ANNOSCALE')) {
          out.push(op);
          continue;
        }
        const st0 = annoState(doc, op.before, getEnv().idx);
        if (st0 && !st0.foreign) {
          const r = followEdit(getEnv(), op.before, op.after);
          extra.push(...r.ops);
          out.push(r.entity !== op.after ? { ...op, after: r.entity } : op);
          continue;
        }
      }
    } catch (err) {
      console.warn('주석 축척 처리 실패', err);
    }
    out.push(op);
  }
  if (!extra.length && !dropBlocks.size && out.every((o, i) => o === tx.ops[i])) return tx;
  const ops = out.filter((o) => !((o.kind === 'blockDef' || o.kind === 'blockRecord') && o.before === null && dropBlocks.has(o.key)));
  return { ...tx, ops: [...ops, ...extra] };
}

/** 주석 표지(또는 주석 블록)를 가진 객체 */
function looksAnnotative(doc: DocState['doc'], e: Entity): boolean {
  if (e.type === 'INSERT') return blockAnnotative(doc, e.block);
  return annotativeFlag(e.xdata) === true;
}

/** 복사본의 원본: 직전 선택(복사 명령이 고른 객체)에서 종류·내용이 같은 주석 객체 */
function findCopySource(app: App, st: DocState, block: string, e: Entity): Entity | null {
  const pool = new Set([...app.lastSelection, ...st.selection]);
  const same = (a: Entity): boolean => {
    if (a.type !== e.type || a.handle === e.handle || !a.xdict) return false;
    switch (e.type) {
      case 'TEXT':
      case 'MTEXT': {
        const b = a as typeof e;
        return b.text === e.text && b.style === e.style && Math.abs(b.height - e.height) <= 1e-9 * Math.max(1, Math.abs(e.height));
      }
      case 'INSERT':
        return tableKey((a as typeof e).block) === tableKey(e.block) && Math.abs(Math.abs((a as typeof e).scale.x) - Math.abs(e.scale.x)) <= 1e-9 * Math.max(1, Math.abs(e.scale.x));
      default:
        return true;
    }
  };
  for (const h of pool) {
    const a = st.doc.entityIndex.get(h);
    if (a && same(a) && st.session.ownerOf(a.handle) === tableKey(block)) {
      const s = annoState(st.doc, a);
      if (s && !s.foreign && s.records.length) return a;
    }
  }
  return null;
}

/** 편집 고리를 단다: App의 확정 고리(commitHooks)의 확정 직전(before) — App이 모든 문서의 편집 세션에 잇는다 */
export function installAnnoHooks(app: App): void {
  addHook(app.commitHooks, { name: 'annoscale', before: (st: DocState, tx: Transaction) => annotateTransaction(app, st, tx) });
}

// ---------------------------------------------------------------------------
// 표시: CANNOSCALE·ANNOALLVISIBLE·축척 리스트가 바뀌면(명령 취소 포함) 모든 공간을 다시 그린다
// ---------------------------------------------------------------------------

const sigs = new WeakMap<DocState, { gen: number; sig: string }>();

function signature(st: DocState): string {
  const doc = st.doc;
  const parts: string[] = [currentScale(doc)?.name ?? '', allVisible(doc, MODEL) ? '1' : '0'];
  for (const l of doc.layouts) parts.push(allVisible(doc, l.blockName) ? '1' : '0');
  for (const s of readScaleList(doc)) parts.push(`${s.name}:${s.paper}:${s.drawing}`);
  return parts.join('|');
}

/**
 * 연 도면 맞추기(AutoCAD가 CANNOSCALE을 기본 레코드와 다른 축척으로 두고 저장한 도면): 모형 공간 주석 객체가 CANNOSCALE의
 * 레코드를 가지면 객체 데이터를 그 표현으로 바꾸고 그 레코드를 기본으로 한다. 화면은 이미 그 표현이므로 그림은 같고,
 * 그립·스냅이 화면과 맞게 된다. 읽은 직후의 정리이므로 명령 취소 기록·수정 표시를 남기지 않는다(워커 문서에도 같이 적용).
 */
export function normalizeShown(app: App, st: DocState): number {
  const list = readScaleList(st.doc);
  const cur = currentScale(st.doc, list);
  if (!cur || !list.length) return 0;
  const env: EditEnv = {
    doc: st.doc,
    alloc: () => {
      throw new Error('새 핸들 없음');
    },
    idx: new ScaleIndex(st.doc),
  };
  const ops: EditOp[] = [];
  let n = 0;
  for (const e of st.doc.blocks.get(MODEL)?.entities ?? []) {
    if (!e.xdict) continue;
    try {
      const s = annoState(st.doc, e, env.idx);
      if (!s || s.foreign || s.current === cur.name.toUpperCase() || !s.byScale.get(cur.name.toUpperCase())) continue;
      const r = switchScale(env, e, cur.name);
      if (r.entity === e) continue;
      ops.push(...r.ops, { kind: 'modify', block: MODEL, before: e, after: r.entity });
      n++;
    } catch {
      /* 새 객체가 필요한 객체(그림이 없는 치수 등)는 그대로 둔다 */
    }
  }
  if (!ops.length) return 0;
  applyOps(st.doc, ops);
  app.engine.edit(st.docId, ops);
  return n;
}

/**
 * 연 도면 맞추기: 예전 빌드가 자체 기록(OPENCAD_ANNOSCALE)으로 저장한 주석 치수·해치·다중 지시선을 AutoCAD 레코드로 바꾼다
 * (다시 저장하면 AutoCAD에서도 축척 표현이 보인다). 읽은 직후의 정리이므로 명령 취소 기록·수정 표시를 남기지 않는다.
 */
export function upgradeOwnOnOpen(app: App, st: DocState): number {
  if (!readScaleList(st.doc).length) return 0;
  const env = envFor(st);
  const ops: EditOp[] = [];
  let n = 0;
  for (const [key, b] of st.doc.blocks) {
    for (const e of b.entities) {
      if (!e.xdata || !ownRecord(e.xdata)) continue;
      try {
        const r = upgradeOwnRecords(env, e);
        if (r.entity === e && !r.ops.length) continue;
        ops.push(...r.ops);
        if (r.entity !== e) ops.push({ kind: 'modify', block: key, before: e, after: r.entity });
        n++;
      } catch (err) {
        console.warn('주석 축척 자체 기록 바꾸기 실패', err);
      }
    }
  }
  if (!ops.length) return 0;
  applyOps(st.doc, ops);
  app.engine.edit(st.docId, ops);
  return n;
}

/** 상태가 바뀐 문서의 장면을 다시 그린다(상태 막대가 새로 그려질 때마다 부른다 — 편집·명령 취소 뒤 포함) */
export function watchAnnoDisplay(app: App): void {
  for (const st of app.docs) {
    const cur = sigs.get(st);
    if (cur && cur.gen === st.gen) continue;
    if (!cur) {
      try {
        upgradeOwnOnOpen(app, st);
        normalizeShown(app, st);
      } catch (e) {
        console.warn('주석 축척 맞추기 실패', e);
      }
    }
    const sig = signature(st);
    sigs.set(st, { gen: st.gen, sig });
    if (cur && cur.sig !== sig) {
      st.dropLtVariants(app.view.renderer);
      app.edits.rebuildEverything(st);
    }
  }
}
