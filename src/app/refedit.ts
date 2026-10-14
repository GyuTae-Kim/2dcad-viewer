/**
 * 참조 편집: REFEDIT, REFSET, REFCLOSE, XFADECTL(AutoCAD 2026 한국어판 프롬프트).
 *
 * 블록 참조나 외부 참조를 놓인 자리에서 고친다. 편집할 정의의 객체를 참조 변환으로 옮긴 사본(작업 세트)을 현재 공간에 두고,
 * 나머지는 XFADECTL만큼 흐리게 그린다(블록 편집기처럼 편집 세션의 명령 취소 깊이를 기억해 취소하면 그대로 되돌린다).
 *  - 블록: REFCLOSE 저장하면 역변환해 블록 정의를 바꾼다(모든 참조가 바뀐다). 세션 전체가 명령 취소 한 단계다.
 *  - 외부 참조: 참조 도면 자신의 이름·좌표로 되돌려 그 도면에 적용하고, 원래 형식으로 저장해 같은 파일 이름으로 내려받게 한다.
 *    현재 도면의 외부 참조 표시도 고친 내용으로 다시 그린다(디스크의 원래 파일을 바꾸는 것은 사용자 — 브라우저 한계).
 *  - 세션 중 저장(QSAVE·SAVEAS·자동 저장·전송)은 작업 세트를 빼고 쓴다(참조는 편집 전 그대로).
 * 한계: 흐리게 보이기는 모형 공간에서만(배치에서는 그대로 보인다). 단일 객체 고르기(getEntity)는 잠금을 거치지 않는다.
 */
import type { BlockDef, CadDocument, Entity, InsertEntity } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { type EditOp, type Transaction, applyOps, inverseTransaction } from '../edit/session';
import { definitionName, isDynamicDefinition, isDynamicReference } from '../edit/dynblock';
import { type RefXf, chainXf, invertXf, xfScale } from '../edit/refedit/xform';
import { type Importer, bindMapper, createImporter, reverseMapper } from '../edit/refedit/names';
import { type RefTarget, dropBlocksOps, extendBlocks, openWorkingSet, planSave, referencedBlocks, seedAllocator } from '../edit/refedit/workset';
import { affApply } from '../edit/geom/math';
import { insertsOf } from '../edit/util/blockutil';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import type { OverlayGeom, Pt } from './view';
import { Picker } from './pick';
import { OverlayScene, SpaceScene } from './scene';
import { expandXrefBounds, xrefOfDoc } from './refs';
import { download } from './export';
import { SAVE_TYPES } from './save';
import { ask, toast } from './ui/dom';
import { type LevelView, RefEditBar, type RefEditSettings, refEditDialog } from './refedit-ui';
import { rememberFile } from './sessionfiles';

type XrefFile = NonNullable<ReturnType<typeof xrefOfDoc>>;

// ---------------------------------------------------------------------------
// 설정(이 브라우저에 남긴다)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'opencad.refedit';
const FADE_KEY = 'opencad.xfadectl';

function loadSettings(): { settings: RefEditSettings; mode: 'auto' | 'prompt' } {
  const def = { settings: { unique: true, attdefs: false, lock: true }, mode: 'auto' as const };
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as { settings?: Partial<RefEditSettings>; mode?: string } | null;
    if (!v) return def;
    return { settings: { ...def.settings, ...(v.settings ?? {}) }, mode: v.mode === 'prompt' ? 'prompt' : 'auto' };
  } catch {
    return def;
  }
}

function storeSettings(settings: RefEditSettings, mode: 'auto' | 'prompt'): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ settings, mode }));
  } catch {
    /* 저장소를 못 쓰면 이번만 */
  }
}

/** XFADECTL(0–90, 기본 50): 참조 편집 중 작업 세트에 없는 객체를 흐리게 하는 정도(%) */
export function xfadectl(): number {
  try {
    const v = Number(localStorage.getItem(FADE_KEY));
    if (localStorage.getItem(FADE_KEY) !== null && Number.isInteger(v) && v >= 0 && v <= 90) return v;
  } catch {
    /* 기본값 */
  }
  return 50;
}

function setXfadectl(v: number): void {
  try {
    localStorage.setItem(FADE_KEY, String(v));
  } catch {
    /* 이번만 */
  }
}

/** 도면 파일 형식 그대로 저장할 설정(DWG R2007은 R2004로, R13·R14는 R2000으로) */
export function docSaveFormat(doc: CadDocument): { format: 'dwg' | 'dxf'; version: string; binary: boolean } {
  if (doc.format === 'dxf') {
    const t = SAVE_TYPES.find((x) => x.format === 'dxf' && x.version === doc.version);
    return { format: 'dxf', version: t ? t.version : 'AC1032', binary: !!doc.binary };
  }
  const v = doc.version === 'AC1021' ? 'AC1018' : doc.version === 'AC1012' || doc.version === 'AC1014' ? 'AC1015' : doc.version;
  const t = SAVE_TYPES.find((x) => x.format === 'dwg' && x.version === v);
  return { format: 'dwg', version: t ? t.version : 'AC1032', binary: false };
}

// ---------------------------------------------------------------------------
// 고른 점 아래의 참조(대화상자의 트리)
// ---------------------------------------------------------------------------

interface Level {
  label: string;
  depth: number;
  kind: 'block' | 'xref';
  /** 바깥 참조부터: 그 참조와 참조하는 정의 */
  chain: { def: BlockDef; insert: InsertEntity }[];
  defDoc: CadDocument | null;
  defKey: string;
  xref?: XrefFile;
  /** 현재 도면의 외부 참조 블록 이름 */
  xrefName?: string;
  path?: string;
  problem?: string;
  xf?: RefXf;
}

const MAX_DEPTH = 8;

function geomNear(g: OverlayGeom, q: { x: number; y: number }, tol: number): boolean {
  const s = g.segs;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const ax = s[i]!;
    const ay = s[i + 1]!;
    const dx = s[i + 2]! - ax;
    const dy = s[i + 3]! - ay;
    const L = dx * dx + dy * dy;
    let t = L > 0 ? ((q.x - ax) * dx + (q.y - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(ax + dx * t - q.x, ay + dy * t - q.y) <= tol) return true;
  }
  const t = g.tris ?? [];
  for (let i = 0; i + 5 < t.length; i += 6) {
    const [x0, y0, x1, y1, x2, y2] = [t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!, t[i + 5]!];
    const d1 = (q.x - x1) * (y0 - y1) - (x0 - x1) * (q.y - y1);
    const d2 = (q.x - x2) * (y1 - y2) - (x1 - x2) * (q.y - y2);
    const d3 = (q.x - x0) * (y2 - y0) - (x2 - x0) * (q.y - y0);
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
  }
  return false;
}

function levelsAt(app: App, st: DocState, ins: InsertEntity, at: Pt, tol: number): Level[] {
  const out: Level[] = [];
  const pickers = new Map<CadDocument, Map<string, Picker>>();
  const pickerFor = (doc: CadDocument, key: string) => {
    let m = pickers.get(doc);
    if (!m) pickers.set(doc, (m = new Map()));
    let p = m.get(key);
    if (!p) m.set(key, (p = new Picker(doc, [], app.text, key)));
    return p;
  };
  const visit = (chain: Level['chain'], doc: CadDocument, insert: InsertEntity, depth: number, inXref: { file: XrefFile; name: string; path?: string } | null) => {
    const key = tableKey(insert.block);
    const blk = doc.blocks.get(key);
    if (!blk) {
      out.push({ label: insert.block, depth, kind: inXref ? 'xref' : 'block', chain, defDoc: null, defKey: key, problem: '블록 정의를 찾을 수 없습니다.' });
      return;
    }
    const next = [...chain, { def: blk, insert }];
    let lv: Level;
    if (blk.flags & 4) {
      const file = inXref ? null : xrefOfDoc(doc, key);
      lv = { label: blk.name, depth, kind: 'xref', chain: next, defDoc: file?.doc ?? null, defKey: MODEL_SPACE, xref: file ?? undefined, xrefName: blk.name, path: blk.xrefPath ?? '' };
      if (inXref) lv.problem = '외부 참조 안의 외부 참조(중첩된 외부 참조)는 이 웹 버전에서 참조 편집할 수 없습니다. 그 외부 참조 도면을 따로 열어 편집하십시오.';
      else if (!file) lv.problem = `외부 참조 "${blk.name}"의 파일이 로드되지 않았습니다. 외부 참조(XR)에서 파일을 고른 뒤 다시 실행하십시오.`;
      else if (file.doc.header.get('$XEDIT') === 0) lv.problem = `외부 참조 "${blk.name}"은(는) 다른 도면에서 참조 편집할 수 없도록 설정되어 있습니다(참조 도면의 XEDIT = 0).`;
    } else {
      lv = { label: inXref ? `${inXref.name}|${blk.name}` : blk.name, depth, kind: inXref ? 'xref' : 'block', chain: next, defDoc: doc, defKey: key, xref: inXref?.file, xrefName: inXref?.name, path: inXref?.path };
      if (isDynamicReference(doc, insert) || isDynamicDefinition(doc, key))
        lv.problem = `동적 블록 "${definitionName(doc, insert) ?? blk.name}"의 참조는 참조 편집할 수 없습니다(매개변수·동작이 사라집니다). 블록 편집기(BEDIT)에서 정의를 편집하십시오.`;
      else if (blk.name.startsWith('*')) lv.problem = `이름 없는 블록(${blk.name})은 참조 편집할 수 없습니다.`;
    }
    const xf = chainXf(next);
    if (typeof xf === 'string') lv.problem ??= xf;
    else lv.xf = xf;
    out.push(lv);
    // 정의 안의 블록 참조 중 고른 점 아래에 있는 것(내포된 참조)
    if (depth + 1 >= MAX_DEPTH || typeof xf === 'string' || !lv.defDoc || (blk.flags & 4 && (inXref || lv.problem))) return;
    const def = lv.defDoc.blocks.get(lv.defKey);
    const inv = invertXf(xf);
    if (!def || !inv) return;
    const q = affApply(inv.m, at);
    const t = tol / Math.max(1e-12, xfScale(xf));
    const pk = pickerFor(lv.defDoc, lv.defKey);
    const nextX = lv.kind === 'xref' && lv.xref ? { file: lv.xref, name: lv.xrefName!, path: lv.path } : null;
    let n = 0;
    for (const e of def.entities) {
      if (e.type !== 'INSERT') continue;
      if (++n > 400) break;
      if (geomNear(pk.geometryOf([e]), q, t)) visit(next, lv.defDoc, e, depth + 1, nextX);
    }
  };
  visit([], st.doc, ins, 0, null);
  return out.map((l) => ({ ...l }));
}

function previewOf(app: App, l: Level): OverlayGeom | null {
  if (!l.defDoc) return null;
  const def = l.defDoc.blocks.get(l.defKey);
  if (!def) return null;
  try {
    return new Picker(l.defDoc, [], app.text, l.defKey).geometryOf(def.entities.filter((e) => e.type !== 'ATTDEF').slice(0, 4000));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 세션
// ---------------------------------------------------------------------------

class RefEditSession {
  /** 연 때의 명령 취소 깊이(세션은 그다음 한 단계) */
  readonly depth: number;
  readonly origin: Map<string, string>;
  readonly snapshot: Map<string, string>;
  /** 도면 객체(연 때의 객체와 REFSET으로 뺀 것). 그 밖의 공간 객체가 작업 세트다 */
  readonly drawing: Set<string>;
  /** REFSET으로 작업 세트에 넣은 원래 도면 객체(세션 중 저장할 때 도면에 남긴다) */
  readonly fromDrawing = new Set<string>();
  complete = false;
  /** 숨긴 참조 */
  hid: string | null = null;
  /** 중첩 객체 선택 중(사본만 고른다) */
  picking = false;
  /** REFSET 추가 중(잠금 풀기) */
  adding = false;
  overlay: OverlayScene | null = null;
  overlayKey = '';
  savedNote = false;
  readonly createdBlocks: string[];

  constructor(
    readonly st: DocState,
    readonly level: Level,
    readonly target: RefTarget,
    readonly space: string,
    readonly settings: RefEditSettings,
    readonly importer: Importer | undefined,
    opened: { origin: Map<string, string>; snapshot: Map<string, string>; createdBlocks: string[] },
    drawing: Set<string>,
    depth: number,
  ) {
    this.depth = depth;
    this.origin = opened.origin;
    this.snapshot = opened.snapshot;
    this.createdBlocks = opened.createdBlocks;
    this.drawing = drawing;
  }

  get name(): string {
    return this.level.label;
  }

  get reference(): InsertEntity {
    return this.level.chain[0]!.insert;
  }

  /** 지금 작업 세트(현재 공간 순서) */
  working(): Entity[] {
    return (this.st.doc.blocks.get(this.space)?.entities ?? []).filter((e) => !this.drawing.has(e.handle));
  }
}

const sessions = new Map<DocState, RefEditSession>();
let bar: RefEditBar | null = null;
let timer = 0;
let hooked = false;

export function refEditSession(st: DocState | null): RefEditSession | null {
  return st ? (sessions.get(st) ?? null) : null;
}

/** 화면에 그리는 지금 공간의 세션(그 공간을 보고 있을 때만) */
function shownSession(s: DocState | null): RefEditSession | null {
  const x = refEditSession(s);
  return x && s && s.space === x.space && !s.msVp ? x : null;
}

const fadeCache = new WeakMap<Float32Array, { key: string; out: Float32Array }>();

function fadeStyles(data: Float32Array, f: number, bg: number): Float32Array {
  const key = `${f}|${bg}`;
  const hit = fadeCache.get(data);
  if (hit && hit.key === key) return hit.out;
  const out = new Float32Array(data);
  const br = ((bg >> 16) & 255) / 255;
  const bgG = ((bg >> 8) & 255) / 255;
  const bb = (bg & 255) / 255;
  for (let o = 0; o + 7 < out.length; o += 8) {
    out[o] = out[o]! + (br - out[o]!) * f;
    out[o + 1] = out[o + 1]! + (bgG - out[o + 1]!) * f;
    out[o + 2] = out[o + 2]! + (bb - out[o + 2]!) * f;
  }
  fadeCache.set(data, { key, out });
  return out;
}

/** 작업 세트를 흐리지 않게 덧그릴 장면(세대가 바뀌면 다시 만든다) */
function workingOverlay(app: App, sess: RefEditSession): OverlayScene | null {
  const st = sess.st;
  const key = `${st.gen}|${sess.drawing.size}|${sess.fromDrawing.size}|${st.hiddenObjects.size}`;
  if (sess.overlay && sess.overlayKey === key) return sess.overlay;
  sess.overlay?.dispose(app.view.renderer);
  sess.overlay = null;
  sess.overlayKey = key;
  const list = sess.working().filter((e) => !st.hiddenObjects.has(e.handle));
  if (!list.length || list.length > 20000) return null;
  try {
    sess.overlay = new OverlayScene(app.view.renderer, st.doc, list, app.text, sess.space, undefined, app.imageKeys, app.pdfPages);
  } catch {
    sess.overlay = null;
  }
  return sess.overlay;
}

function installHooks(app: App): void {
  if (hooked) return;
  hooked = true;
  const v = app.view;
  const prevOverride = v.modelStyleOverride;
  v.modelStyleOverride = (s) => {
    const inner = prevOverride?.(s) ?? null;
    const sess = shownSession(s);
    const f = xfadectl() / 100;
    if (!sess || f <= 0) return inner;
    return (d) => fadeStyles(inner ? inner(d) : d, f, v.modelBg);
  };
  const prevExtras = v.modelExtras;
  v.modelExtras = (s) => {
    const base = prevExtras?.(s) ?? [];
    const sess = shownSession(s);
    if (!sess || xfadectl() <= 0) return base;
    const ov = workingOverlay(app, sess);
    if (!ov) return base;
    return [...base, { gpu: ov.gpu, styles: (dark: boolean, bg: number, lw: boolean) => ov.styleData((k) => s.layers.get(k), dark, bg, lw) }];
  };
  const prevX = v.xrefPlacements;
  v.xrefPlacements = (s, list, visible, vpFrozen) => {
    const out = prevX ? prevX(s, list, visible, vpFrozen) : [];
    const sess = shownSession(s);
    const f = xfadectl() / 100;
    if (!sess || f <= 0) return out;
    return out.map((p) => ({ ...p, layers: p.layers.map((l) => ({ ...l, transparency: Math.round((l.transparency ?? 255) * (1 - f)) })), key: `${p.key}|fade${f}` }));
  };
  const prevRestore = v.onRestore;
  v.onRestore = () => {
    prevRestore?.();
    for (const s of sessions.values()) {
      s.overlay = null;
      s.overlayKey = '';
    }
  };
  const prevSel = app.selectionFilter;
  app.selectionFilter = (hs) => {
    const list = prevSel ? prevSel(hs) : hs;
    const st = app.active;
    const sess = refEditSession(st);
    if (!sess || !st || st.space !== sess.space) return list;
    if (sess.picking) return list.filter((h) => sess.origin.has(h));
    if (sess.settings.lock && !sess.adding) return list.filter((h) => !sess.drawing.has(h));
    return list;
  };
}

/** 원래 엔진 저장(세션 가드를 거치지 않는다) */
let rawSave: App['engine']['save'] | null = null;

/**
 * 도면을 잠시 고친 사본으로 저장한다(열린 도면·워커 문서는 그대로).
 * 작업을 메인 문서에 적용한 채 사본을 워커에 넘기고(postMessage가 그 자리에서 복사한다) 곧바로 되돌린 뒤, 그 사본을 쓰고 닫는다.
 * 워커는 저장 중 쓰기 모듈을 기다리는 동안 다음 메시지를 처리하므로, 열린 문서에 잠시 적용했다 되돌리는 방법은 쓰지 않는다.
 */
export async function saveDocCopy(app: App, doc: CadDocument, name: string, ops: readonly EditOp[], fmt: { format: 'dwg' | 'dxf'; version: string; binary: boolean }): Promise<{ data: Uint8Array; warnings: { code: string; message: string; count?: number }[] }> {
  let p: ReturnType<App['engine']['adopt']>;
  applyOps(doc, ops);
  try {
    p = app.engine.adopt(name, doc);
  } finally {
    applyOps(doc, inverseTransaction({ label: 'COPY', ops: [...ops] }).ops);
  }
  const res = await p;
  try {
    return await (rawSave ?? app.engine.save.bind(app.engine))(res.docId, fmt.format, fmt.version, fmt.binary);
  } finally {
    app.engine.closeDoc(res.docId);
  }
}

/** 참조 편집 중이면 작업 세트를 빼는 작업(REFSET으로 넣은 원래 도면 객체는 남긴다). 아니면 빈 배열 */
export function workingSetRemovalOps(st: DocState): EditOp[] {
  const sess = sessions.get(st);
  const sp = sess ? st.doc.blocks.get(sess.space) : undefined;
  if (!sess || !sp) return [];
  const idx: { e: Entity; i: number }[] = [];
  sp.entities.forEach((e, i) => {
    if (!sess.drawing.has(e.handle) && !sess.fromDrawing.has(e.handle)) idx.push({ e, i });
  });
  idx.sort((a, b) => b.i - a.i);
  return idx.map((x) => ({ kind: 'remove', block: sess.space, entity: x.e, index: x.i }) as EditOp);
}

/** 세션 중 저장(QSAVE·SAVEAS·자동 저장)은 작업 세트를 뺀 사본으로 쓴다 */
function installSaveGuard(app: App): void {
  const engine = app.engine;
  const orig = engine.save.bind(engine);
  rawSave = orig;
  engine.save = async (docId, format, version, binary) => {
    const sess = [...sessions.values()].find((s) => s.st.docId === docId);
    const ops = sess ? workingSetRemovalOps(sess.st) : [];
    if (!sess || !ops.length) return orig(docId, format, version, binary);
    const r = await saveDocCopy(app, sess.st.doc, sess.st.saveName, ops, { format, version, binary: !!binary });
    if (!sess.savedNote) {
      sess.savedNote = true;
      app.cmd.print('참고: 참조 편집 중이라 작업 세트는 저장하지 않았습니다(참조는 편집 전 그대로 저장).');
    }
    return { ...r, ms: 0 };
  };
}

let barKey = '';

function refreshBar(app: App): void {
  const sess = refEditSession(app.active);
  if (!sessions.size) {
    bar?.dispose();
    bar = null;
    barKey = '';
    return;
  }
  const key = sess ? `${sess.st.docId}|${sess.st.gen}|${sess.drawing.size}|${app.active?.space}` : 'none';
  if (bar && key === barKey) return;
  barKey = key;
  if (!bar)
    bar = new RefEditBar(app, {
      add: () => void app.run('REFSET', 'A'),
      remove: () => void app.run('REFSET', 'R'),
      save: () => void app.run('REFCLOSE', 'S'),
      discard: () => void app.run('REFCLOSE', 'D'),
    });
  bar.set(sess?.name ?? '', sess ? sess.working().length : 0, !!sess && app.active?.space === sess.space);
}

function tick(app: App): void {
  for (const s of [...sessions.values()]) {
    if (!app.docs.includes(s.st)) {
      endSession(app, s);
      continue;
    }
    // 명령 취소로 세션을 연 단계까지 되돌렸으면 세션이 끝난다
    if (s.st.session.depth <= s.depth) {
      endSession(app, s);
      app.cmd.print(`참조 "${s.name}"의 편집을 끝냈습니다(명령 취소).`);
    }
  }
  if (!sessions.size) {
    clearInterval(timer);
    timer = 0;
  }
  refreshBar(app);
}

function endSession(app: App, s: RefEditSession): void {
  sessions.delete(s.st);
  s.overlay?.dispose(app.view.renderer);
  s.overlay = null;
  const st = s.st;
  if (s.hid && st.hiddenObjects.has(s.hid) && app.docs.includes(st)) {
    const rest = [...st.hiddenObjects].filter((h) => h !== s.hid);
    if (app.active === st) app.setHiddenObjects(st, rest);
    else {
      st.hiddenObjects.delete(s.hid);
      app.engine.hide(st.docId, rest);
      app.edits.rebuildEverything(st);
    }
  }
  if (app.active === st) app.clearSelection();
  refreshBar(app);
  app.view.requestRender();
}

/** 연 단계까지 되돌린다(세션 안의 모든 편집). 되돌린 트랜잭션들(오래된 것부터) */
function rewind(st: DocState, depth: number): Transaction[] {
  const txs: Transaction[] = [];
  while (st.session.depth > depth) {
    const t = st.session.undo();
    if (!t) break;
    txs.unshift(t);
  }
  return txs;
}

/** 세션 전체를 한 번의 명령으로 다시 적용하고 끝내는 작업을 더한다(명령 취소 한 단계) */
function commitAsOne(st: DocState, depth: number, label: string, closeOps: EditOp[]): void {
  const txs = rewind(st, depth);
  const ops = [...txs.flatMap((t) => t.ops), ...closeOps];
  const hook = st.session.beforeCommit;
  st.session.beforeCommit = null;
  try {
    st.session.commit({ label, ops, rebuildNow: true });
  } finally {
    st.session.beforeCommit = hook;
  }
}

async function openSession(app: App, ctx: CommandContext, st: DocState, lv: Level, mode: 'auto' | 'prompt', settings: RefEditSettings): Promise<void> {
  const xf = lv.xf!;
  const defDoc = lv.defDoc!;
  const target: RefTarget = { kind: lv.kind, doc: defDoc, key: lv.defKey, xf };
  const newHandle = () => st.session.newHandle();
  let importer: Importer | undefined;
  if (lv.kind === 'xref') {
    const xname = lv.xrefName!;
    importer = createImporter(extendBlocks(defDoc), st.doc, settings.unique ? bindMapper(st.doc, xname) : (_k, n) => n, newHandle, {
      layerFrom: (s) => st.doc.layers.get(tableKey(`${xname}|${s}`)),
    });
  }
  const space = st.space;
  const sp = st.doc.blocks.get(space);
  if (!sp) return;
  const drawing = new Set(sp.entities.map((e) => e.handle));
  let res;
  try {
    res = openWorkingSet(target, { host: st.doc, space, attdefs: settings.attdefs, newHandle, importer });
  } catch (e) {
    ctx.print(`참조를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return;
  }
  if (!res.copies.length) {
    ctx.print(res.hiddenAttdefs ? '작업 세트로 가져올 객체가 없습니다(속성 정의만 있는 블록은 설정 탭의 "편집을 위한 속성 정의 표시"를 켜십시오).' : '참조에 작업 세트로 가져올 수 있는 객체가 없습니다.', 'err');
    return;
  }
  const depth = st.session.depth;
  app.clearSelection();
  st.session.commit({ label: 'REFEDIT', ops: res.ops, group: ctx.group, rebuildNow: true });
  const sess = new RefEditSession(st, lv, target, space, settings, importer, res, drawing, depth);
  sessions.set(st, sess);
  installHooks(app);
  if (!timer) timer = window.setInterval(() => tick(app), 250);
  let dropped = 0;
  if (mode === 'prompt') {
    sess.picking = true;
    let picked: string[];
    try {
      picked = await ctx.getSelection('중첩된 객체 선택:', { noPickfirst: true });
    } catch (e) {
      sess.picking = false;
      rewind(st, depth);
      endSession(app, sess);
      throw e;
    }
    sess.picking = false;
    const keep = new Set(picked.filter((h) => sess.origin.has(h)));
    if (!keep.size) {
      rewind(st, depth);
      endSession(app, sess);
      ctx.print('선택된 객체가 없습니다. 참조 편집을 시작하지 않았습니다.', 'err');
      return;
    }
    ctx.print(`${keep.size}개 선택됨`);
    const ops: EditOp[] = [];
    const idx: { e: Entity; i: number }[] = [];
    sp.entities.forEach((e, i) => {
      if (sess.origin.has(e.handle) && !keep.has(e.handle)) idx.push({ e, i });
    });
    idx.sort((a, b) => b.i - a.i);
    for (const x of idx) {
      ops.push({ kind: 'remove', block: space, entity: x.e, index: x.i });
      sess.origin.delete(x.e.handle);
      sess.snapshot.delete(x.e.handle);
    }
    dropped = idx.length;
    if (ops.length) st.session.commit({ label: 'REFEDIT', ops, group: ctx.group, rebuildNow: true });
    app.clearSelection();
  }
  const ref = sess.reference;
  sess.complete = lv.depth === 0 && res.skipped === 0 && dropped === 0 && (res.hiddenAttdefs === 0 || ref.attribs.length === 0);
  if (sess.complete && !st.hiddenObjects.has(ref.handle)) {
    sess.hid = ref.handle;
    app.setHiddenObjects(st, [...st.hiddenObjects, ref.handle]);
  }
  refreshBar(app);
  app.view.requestRender();
  const what = lv.kind === 'xref' ? (lv.depth && lv.xrefName ? `외부 참조 "${lv.xrefName}" 안의 블록 "${lv.label}"` : `외부 참조 "${lv.label}"`) : `블록 "${lv.label}"`;
  ctx.print(`${what}을(를) 내부 편집합니다. 작업 세트 ${sess.working().length}개(나머지는 XFADECTL ${xfadectl()}%로 흐리게). 끝내려면 REFCLOSE 또는 띠의 "변경 사항 저장"·"변경 사항 취소"를 쓰십시오.`);
  if (res.skipped) ctx.print(`${res.skipped}개 객체는 작업 세트로 가져올 수 없어 참조에 그대로 둡니다.`);
  if (res.hiddenAttdefs) ctx.print(`속성 정의 ${res.hiddenAttdefs}개는 작업 세트에 넣지 않았습니다(설정 탭의 "편집을 위한 속성 정의 표시"로 넣을 수 있습니다).`);
  if (lv.kind === 'xref') ctx.print('참고: 외부 참조를 저장하면 고친 참조 도면을 같은 파일 이름으로 내려받습니다(원래 파일은 사용자가 바꿉니다).');
}

/** REFCLOSE 저장. 저장했으면 true(세션 끝) */
async function saveSession(app: App, ctx: CommandContext, sess: RefEditSession): Promise<boolean> {
  const st = sess.st;
  await app.edits.flush(st);
  const working = sess.working();
  if (sess.level.kind === 'block') {
    const plan = planSave({ target: sess.target, host: st.doc, space: sess.space, working, origin: sess.origin, snapshot: sess.snapshot, newHandle: () => st.session.newHandle() });
    if (plan.error) {
      ctx.print(plan.error, 'err');
      return false;
    }
    const removed = new Set(plan.removeWorking.map((o) => (o.kind === 'remove' ? o.entity.handle : '')));
    const used = referencedBlocks(st.doc, removed);
    for (const o of plan.defOps) {
      const e = o.kind === 'add' ? o.entity : o.kind === 'modify' ? o.after : null;
      if (e && (e.type === 'INSERT' || e.type === 'DIMENSION' || e.type === 'ACAD_TABLE') && e.block) used.add(tableKey(e.block));
    }
    const ops = [...plan.removeWorking, ...plan.defOps, ...dropBlocksOps(st.doc, sess.createdBlocks, used)];
    commitAsOne(st, sess.depth, 'REFEDIT', ops);
    endSession(app, sess);
    const n = insertsOf(st.doc, sess.target.key).length;
    ctx.print(`블록 "${sess.name}"의 참조 편집을 저장했습니다(그대로 ${plan.kept}, 바뀜 ${plan.changed}, 새로 ${plan.added}, 지움 ${plan.removed} — 참조 ${n}개에 반영).`);
    if (plan.left.length) ctx.print(`${plan.left.length}개 객체는 참조에 넣을 수 없어 현재 도면에 남겼습니다.`);
    if (plan.attdefsChanged) ctx.print('속성 정의를 바꿨습니다. 기존 블록 참조의 속성은 그대로이니 ATTSYNC로 맞추십시오.');
    return true;
  }
  // 외부 참조
  const file = sess.level.xref!;
  const xname = sess.level.xrefName!;
  const xdoc = file.doc;
  const alloc = seedAllocator(xdoc);
  const exporter = createImporter(extendBlocks(st.doc), xdoc, reverseMapper(sess.importer?.origin ?? new Map(), xname), alloc.newHandle);
  const plan = planSave({ target: sess.target, host: st.doc, space: sess.space, working, origin: sess.origin, snapshot: sess.snapshot, newHandle: alloc.newHandle, exporter });
  if (plan.error) {
    ctx.print(plan.error, 'err');
    return false;
  }
  const xops = [...plan.defOps, ...alloc.finish()];
  const changedFile = plan.changed + plan.added + plan.removed > 0;
  if (changedFile) {
    applyOps(xdoc, xops);
    app.engine.edit(file.docId, xops);
    const fmt = docSaveFormat(xdoc);
    app.ui.setBusy(`${file.name} 저장하는 중…`, 0.5);
    try {
      const saved = await app.engine.save(file.docId, fmt.format, fmt.version, fmt.binary);
      const blob = new Blob([saved.data as BlobPart], { type: fmt.format === 'dxf' ? 'application/dxf' : 'application/acad' });
      download(blob, file.name);
      rememberFile(file.name, blob);
      const msg = await app.engine.build(file.docId, MODEL_SPACE);
      const old = file.scene;
      file.scene = new SpaceScene(app.view.renderer, msg, MODEL_SPACE);
      file.layers = msg.layers;
      old.dispose(app.view.renderer);
      if (fmt.version !== xdoc.version && xdoc.format === 'dwg') ctx.print(`참고: ${xdoc.version} 형식은 쓸 수 없어 ${fmt.version} 형식으로 저장했습니다.`);
    } catch (e) {
      ctx.print(`외부 참조 도면을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      app.ui.setBusy(null);
    }
  }
  const removed = new Set(plan.removeWorking.map((o) => (o.kind === 'remove' ? o.entity.handle : '')));
  const ops = [...plan.removeWorking, ...dropBlocksOps(st.doc, sess.createdBlocks, referencedBlocks(st.doc, removed))];
  commitAsOne(st, sess.depth, 'REFEDIT', ops);
  endSession(app, sess);
  for (const d of app.docs) expandXrefBounds(app, d);
  app.view.requestRender();
  if (changedFile) {
    ctx.print(`외부 참조 "${xname}"의 변경 사항(바뀜 ${plan.changed}, 새로 ${plan.added}, 지움 ${plan.removed})을 ${file.name}(으)로 저장해 내려받았습니다. 브라우저는 디스크의 원래 파일에 쓸 수 없으니 원래 파일을 내려받은 파일로 바꾸십시오.`);
    toast(`${file.name}을(를) 내려받았습니다. 원래 외부 참조 파일을 바꾸십시오.`, 'info', 6000);
  } else ctx.print(`외부 참조 "${xname}"에 바뀐 것이 없어 파일을 쓰지 않았습니다.`);
  if (plan.left.length) ctx.print(`${plan.left.length}개 객체는 참조에 넣을 수 없어 현재 도면에 남겼습니다.`);
  return true;
}

function discardSession(app: App, sess: RefEditSession): void {
  rewind(sess.st, sess.depth);
  endSession(app, sess);
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

export function registerRefEditCommands(app: App): void {
  installSaveGuard(app);

  app.register({
    name: 'REFEDIT',
    title: '참조 편집',
    async run(ctx, arg) {
      const st = app.active!;
      if (st.blockEdit) {
        ctx.print('블록 편집기에서는 참조 편집할 수 없습니다. 먼저 BCLOSE로 블록 편집기를 닫으십시오.', 'err');
        return;
      }
      if (sessions.has(st)) {
        ctx.print(`이미 참조 "${sessions.get(st)!.name}"을(를) 편집하고 있습니다. 먼저 REFCLOSE로 저장하거나 취소하십시오.`, 'err');
        return;
      }
      if (st.msVp) {
        ctx.print('뷰포트 안(모형 공간)에서는 참조 편집할 수 없습니다. 모형 탭이나 종이 공간에서 실행하십시오.', 'err');
        return;
      }
      let ins: InsertEntity | null = null;
      let at: Pt = { x: 0, y: 0 };
      // 두 번 누르기: "핸들@x,y"(누른 참조와 자리)
      const pre = /^([0-9A-F]+)@(-?[\d.eE+-]+),(-?[\d.eE+-]+)$/i.exec(arg ?? '');
      const preIns = pre ? st.doc.entityIndex.get(pre[1]!.toUpperCase()) : undefined;
      if (preIns?.type === 'INSERT') {
        ins = preIns;
        at = { x: Number(pre![2]), y: Number(pre![3]) };
      }
      while (!ins) {
        const r = await ctx.getEntity('참조 선택:');
        if (!('handle' in r)) return;
        let e = st.doc.entityIndex.get(r.handle);
        if (e && (e.type === 'ATTRIB' || e.type === 'ATTDEF') && e.owner) {
          const o = st.doc.entityIndex.get(e.owner);
          if (o?.type === 'INSERT') e = o;
        }
        if (e?.type === 'INSERT') {
          ins = e;
          at = r.point;
          break;
        }
        ctx.print('선택한 객체가 참조가 아닙니다.', 'err');
      }
      const tol = app.view.overlay.pickbox * app.view.pixelSize();
      const levels = levelsAt(app, st, ins, at, tol);
      const saved = loadSettings();
      const views: LevelView[] = levels.map((l) => ({ label: l.label, depth: l.depth, kind: l.kind, path: l.path, problem: l.problem, preview: () => previewOf(app, l) }));
      const choice = await refEditDialog(views, saved.settings, saved.mode);
      if (!choice) return;
      storeSettings(choice.settings, choice.mode);
      const lv = levels[choice.index]!;
      if (lv.problem || !lv.xf || !lv.defDoc) {
        ctx.print(lv.problem ?? '이 참조는 편집할 수 없습니다.', 'err');
        return;
      }
      await openSession(app, ctx, st, lv, choice.mode, choice.settings);
    },
  });

  app.register({
    name: 'REFSET',
    title: '참조 편집 작업 세트',
    async run(ctx, arg) {
      const st = app.active!;
      const sess = sessions.get(st);
      if (!sess) {
        ctx.print('참조 편집 중이 아닙니다. 먼저 REFEDIT로 참조를 여십시오.', 'err');
        return;
      }
      if (st.space !== sess.space) {
        ctx.print('참조를 편집하는 공간에서 실행하십시오.', 'err');
        return;
      }
      let k = arg?.trim().toUpperCase();
      if (k !== 'A' && k !== 'R') {
        const r = await ctx.getPoint('참조 편집 작업 세트에 객체 추가 또는 제거 [추가(A)/제거(R)] <추가>:', {
          keywords: [
            { key: 'A', label: '추가' },
            { key: 'R', label: '제거' },
          ],
        });
        if ('keyword' in r) k = r.keyword;
        else if ('enter' in r) k = 'A';
        else return;
      }
      app.clearSelection();
      if (k === 'A') {
        sess.adding = true;
        let hs: string[];
        try {
          hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
        } finally {
          sess.adding = false;
        }
        let n = 0;
        let refused = 0;
        for (const h of hs) {
          if (!sess.drawing.has(h)) continue;
          if (h === sess.reference.handle) {
            refused++;
            continue;
          }
          sess.drawing.delete(h);
          if (!sess.origin.has(h)) sess.fromDrawing.add(h);
          n++;
        }
        ctx.print(`${n}개 항목이 작업 세트에 추가되었습니다.`);
        if (refused) ctx.print('편집 중인 참조 자신은 작업 세트에 넣을 수 없습니다.', 'err');
      } else {
        const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
        let n = 0;
        for (const h of hs) {
          if (sess.drawing.has(h)) continue;
          if (!st.doc.blocks.get(sess.space)?.entities.some((e) => e.handle === h)) continue;
          sess.drawing.add(h);
          sess.fromDrawing.delete(h);
          n++;
        }
        ctx.print(`${n}개 항목이 작업 세트에서 제거되었습니다.`);
      }
      app.clearSelection();
      refreshBar(app);
      app.view.requestRender();
    },
  });

  app.register({
    name: 'REFCLOSE',
    title: '참조 편집 닫기',
    async run(ctx, arg) {
      const st = app.active!;
      const sess = sessions.get(st);
      if (!sess) {
        ctx.print('참조 편집 중이 아닙니다.', 'err');
        return;
      }
      let k = arg?.trim().toUpperCase();
      if (k !== 'S' && k !== 'D') {
        const r = await ctx.getPoint('참조에 대한 변경 사항 [저장(S)/취소(D)] <저장>:', {
          keywords: [
            { key: 'S', label: '저장' },
            { key: 'D', label: '취소' },
          ],
        });
        if ('keyword' in r) k = r.keyword;
        else if ('enter' in r) k = 'S';
        else return;
      }
      if (k === 'D') {
        const a = await ask('참조 편집 - 변경 사항 취소', `참조 "${sess.name}"에 대한 모든 변경 사항이 취소됩니다. 계속하시겠습니까?`, [
          { label: '확인', value: 'ok', primary: true },
          { label: '취소', value: 'cancel' },
        ]);
        if (a !== 'ok') return;
        discardSession(app, sess);
        ctx.print(`참조 "${sess.name}"의 변경 사항을 버렸습니다.`);
        return;
      }
      await saveSession(app, ctx, sess);
    },
  });

  app.register({
    name: 'XFADECTL',
    title: '참조 편집 흐림 정도',
    async run(ctx, arg) {
      let t = arg?.trim();
      if (!t) {
        const r = await ctx.getPoint(`XFADECTL에 대한 새 값 입력 <${xfadectl()}>:`, { preferNumber: true, allowText: true });
        if ('enter' in r) return;
        if (!('text' in r)) return;
        t = r.text.trim();
      }
      const v = Number(t);
      if (!Number.isInteger(v) || v < 0 || v > 90) {
        ctx.print('0과(와) 90 사이의 정수가 필요합니다.', 'err');
        return;
      }
      setXfadectl(v);
      app.view.requestRender();
    },
  });
}
