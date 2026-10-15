/**
 * 외부 참조 비교: XCOMPARE, XCOMPARECLOSE, XCOMPARERCNEXT, XCOMPARERCPREV(변수 XCOMPAREENABLE·XCOMPARECOLORMODE —
 * 색·표시·구름·필터는 도면 비교 변수 COMPARECOLOR1 … 를 함께 쓴다). 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 *
 * 비교하는 것: 외부 참조 파일의 이전 버전과 지금 불러온 버전(도면 비교 엔진 compareDrawings).
 * - 외부 참조 창(XR)에서 같은 이름의 파일을 다시 고르면(다시 로드) XCOMPAREENABLE 1일 때 이전 버전을 이 페이지 메모리에
 *   남기고, 내용이 바뀌었으면 명령행·알림으로 XCOMPARE를 권한다(AutoCAD의 풍선 알림 대신).
 * - 이전 버전이 없으면 XCOMPARE가 바뀐 파일을 고르게 한다: 그 파일로 외부 참조를 다시 로드하고 지금 내용과 비교한다.
 *
 * 화면(모형 공간): 그 외부 참조가 놓인 자리마다 지금 버전에만 있는 객체 COMPARECOLOR1, 이전 버전에만 있는 객체
 * COMPARECOLOR2, 차이 없는 객체 COMPARECOLORCOMMON, 변경 세트마다 구름형 리비전. 호스트 객체는 XCOMPARECOLORMODE 1이면
 * 회색으로 흐리게. 상단 비교 막대(변경 개수·이전/다음 변경 세트·설정·닫기). 비교 중 겹친 객체는 그리기만 한다.
 */
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import type { CadDocument, Entity, InsertEntity, LwPolylineEntity, LwVertex } from '../core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../core/model';
import { OverlayScene } from './scene';
import type { GpuScene } from '../render/webgl';
import { type LayerState, layerStates } from '../render/styles';
import { CLOUD_ACI, CLOUD_CURRENT_ACI, compareRgb, recolorStyles } from './compare-session';
import { CompareToolbar, pickDrawingFile } from './compare-ui';
import { compareSettings, getCompareVar, onCompareVarsChange, setCompareVars } from './compare-vars';
import { beforeCompare, closeCompare } from './compare';
import { linkXrefFiles, refHooks, xrefFileKey, xrefOfDoc } from './refs';
import { type Box, type ChangeSet, type CompareOptions, type CompareSettings, changeSets, cloudArc, cloudOf, compareMargin, diagonal, setOutlines, unionBox } from '../edit/compare';
import { type Affine, type XrefDiff, diffXrefVersions, fadeStyles, placeBox, placedDiffBoxes, placementMatrix, xcompareSummary, xrefBlockKeys, xrefChanged, xrefInserts } from '../edit/viewtools/xcompare';
import { h, toast } from './ui/dom';

/** 참조 파일 한 버전 */
interface Version {
  name: string;
  doc: CadDocument;
}

/** 다시 로드할 때 남긴 이전 버전(열쇠 = 참조 파일 이름 소문자). 이 페이지 메모리에만 */
const previous = new Map<string, Version>();

type Extra = { gpu: GpuScene; styles: (dark: boolean, bg: number, lwDisplay: boolean) => Float32Array };
type View = App['view'];

const optionsOf = (s: CompareSettings): CompareOptions => ({ tolerance: s.tolerance, text: s.text, hatch: s.hatch, props: s.props });

function forceVisible(d: Float32Array): Float32Array {
  for (let o = 5; o < d.length; o += 8) d[o] = 1;
  return d;
}

/** 이 파일을 참조하는 호스트 블록 이름들(열린 도면 전체) */
function hostBlockNames(app: App, key: string): string[] {
  const out = new Set<string>();
  for (const d of app.docs) for (const b of d.doc.blocks.values()) if (b.flags & 4 && xrefFileKey(b) === key) out.add(b.name);
  return [...out];
}

export class XCompareSession {
  closed = false;
  busy = false;
  current = -1;
  sets: ChangeSet[] = [];
  clouds: { set: number; verts: LwVertex[] }[] = [];
  diff: XrefDiff | null = null;
  /** 도구막대용(현재 = 지금 버전, 비교 = 이전 버전) */
  result: { onlyCurrent: string[]; onlyCompare: string[]; common: number } | null = null;
  settings: CompareSettings;
  /** 차이 상자(호스트 좌표, 자리마다) */
  diffBoxes: (Box | null)[] = [];
  onUpdate: (() => void) | null = null;
  onTick: (() => void) | null = null;

  private placements: Affine[] = [];
  private newScene: OverlayScene | null = null;
  private commonScene: OverlayScene | null = null;
  private oldScene: OverlayScene | null = null;
  private cloudScene: OverlayScene | null = null;
  private layersNew: (k: string) => LayerState | undefined = () => undefined;
  private layersOld: (k: string) => LayerState | undefined = () => undefined;
  private gen = -1;
  private genSeen = -1;
  private genAt = 0;
  private timer = 0;
  private fadeCache = new WeakMap<Float32Array, { key: string; out: Float32Array }>();
  private prevOverride: View['modelStyleOverride'] = null;
  private prevExtras: View['modelExtras'] = null;
  private prevPlacements: View['xrefPlacements'] = null;
  private prevRestore: View['onRestore'] = null;
  private readonly override: NonNullable<View['modelStyleOverride']>;
  private readonly extras: NonNullable<View['modelExtras']>;
  private readonly placementsHook: NonNullable<View['xrefPlacements']>;
  private readonly restore: () => void;

  constructor(
    readonly app: App,
    readonly st: DocState,
    /** 외부 참조 블록(대문자 키) */
    readonly blockKey: string,
    /** 참조 파일 열쇠 */
    readonly fileKey: string,
    public prev: Version,
    public cur: Version,
  ) {
    this.settings = compareSettings();
    this.override = (s) => {
      if (s !== this.st || this.closed || Number(getCompareVar('XCOMPARECOLORMODE')) !== 1) return this.prevOverride?.(s) ?? null;
      return (d) => this.faded(d);
    };
    this.extras = (s) => (s === this.st && !this.closed ? this.extraScenes() : (this.prevExtras?.(s) ?? []));
    this.placementsHook = (s, list, visible, vpFrozen) => {
      const out = this.prevPlacements?.(s, list, visible, vpFrozen) ?? [];
      // 모형 탭에서는 비교하는 참조의 보통 그림을 빼고 비교 색으로 겹쳐 그린다
      if (this.closed || s !== this.st || !s.isModel || s.msVp || s.blockEdit) return out;
      const f = xrefOfDoc(s.doc, this.blockKey);
      return f ? out.filter((p) => p.file !== f) : out;
    };
    this.restore = () => {
      this.prevRestore?.();
      if (!this.closed) this.rebuild();
    };
  }

  get blockName(): string {
    return this.st.doc.blocks.get(this.blockKey)?.name ?? this.blockKey;
  }

  // -------------------------------------------------------------------------
  // 비교
  // -------------------------------------------------------------------------

  compare(): XrefDiff {
    this.settings = compareSettings();
    const d = diffXrefVersions(this.prev.doc, this.cur.doc, optionsOf(this.settings));
    this.diff = d;
    this.result = { onlyCurrent: d.onlyNew, onlyCompare: d.onlyOld, common: d.commonNew.length };
    this.rebuild();
    return d;
  }

  async recompare(): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    this.onUpdate?.();
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (!this.closed) this.compare();
    } finally {
      this.busy = false;
      this.onUpdate?.();
    }
  }

  /** 비교 중에 그 참조를 다시 로드했을 때: 그 전 버전과 새 버전으로 다시 비교 */
  reloaded(prev: Version, next: Version): void {
    this.prev = prev;
    this.cur = next;
    void this.recompare().then(() => {
      if (!this.closed) this.app.cmd.print(`다시 비교했습니다: ${xcompareSummary(this.diff!, this.sets.length)}`);
    });
  }

  /** 도면층 상태: 호스트의 `참조|도면층` 재지정 → 참조 파일의 도면층 → 호스트 도면층(블록 참조의 도면층) */
  private layerLookup(doc: CadDocument): (k: string) => LayerState | undefined {
    const ls = layerStates(doc);
    const own = new Map([...ls.indexOf].map(([k, i]) => [k, ls.states[i]!]));
    const st = this.st;
    const prefix = this.blockName;
    return (k) => st.layers.get(tableKey(`${prefix}|${k}`)) ?? own.get(k) ?? st.layers.get(k);
  }

  /** 자리(호스트의 외부 참조 블록 참조)와 겹쳐 그릴 장면·변경 세트를 다시 만든다(편집으로 참조를 옮겨도) */
  rebuild(): void {
    const st = this.st;
    const d = this.diff;
    this.gen = this.genSeen = st.gen;
    this.disposeScenes();
    const blk = st.doc.blocks.get(this.blockKey);
    if (!d || !blk) {
      this.app.view.requestRender();
      this.onUpdate?.();
      return;
    }
    const inserts = xrefInserts(st.doc, this.blockKey).filter((ins) => {
      if (st.hiddenObjects.has(ins.handle)) return false;
      const l = st.layers.get(tableKey(ins.layer));
      return !l || (l.on && !l.frozen);
    });
    this.placements = inserts.map((ins) => placementMatrix(blk.basePoint, ins));
    this.layersNew = this.layerLookup(this.cur.doc);
    this.layersOld = this.layerLookup(this.prev.doc);
    this.newScene = this.sceneOf(this.cur.doc, d.onlyNew, inserts, 'N');
    this.commonScene = this.sceneOf(this.cur.doc, d.commonNew, inserts, 'C');
    this.oldScene = this.sceneOf(this.prev.doc, d.onlyOld, inserts, 'O');
    this.computeSets();
    this.current = Math.min(this.current, this.sets.length - 1);
    this.buildClouds();
    this.app.view.requestRender();
    this.onUpdate?.();
  }

  /**
   * 참조 파일의 객체 묶음을 호스트의 자리마다 그린 장면: 참조 파일 문서의 얕은 사본에 그 객체들의 임시 블록을 두고
   * 호스트 블록 참조와 같은 삽입점·축척·회전의 블록 참조로 그린다(참조 파일의 블록·도면층·문자 스타일을 그대로 쓴다).
   */
  private sceneOf(doc: CadDocument, handles: readonly string[], inserts: readonly InsertEntity[], tag: string): OverlayScene | null {
    if (!handles.length || !inserts.length) return null;
    const keep = new Set(handles);
    const ents = (doc.blocks.get(MODEL_SPACE)?.entities ?? []).filter((e) => e.type !== 'VIEWPORT' && keep.has(e.handle));
    if (!ents.length) return null;
    const host = this.st.doc.blocks.get(this.blockKey)!;
    const name = `XCOMPARE$${tag}`;
    const vdoc: CadDocument = { ...doc, blocks: new Map(doc.blocks) };
    vdoc.blocks.set(tableKey(name), { name, handle: '', recordHandle: '', basePoint: host.basePoint, flags: 0, entities: ents });
    const refs: Entity[] = inserts.map((ins, i) => ({ ...ins, block: name, attribs: [], columnCount: 1, rowCount: 1, handle: `XCMP${tag}${i}` }));
    try {
      return new OverlayScene(this.app.view.renderer, vdoc, refs, this.app.text, MODEL_SPACE, undefined, this.app.imageKeys, this.app.pdfPages);
    } catch {
      return null;
    }
  }

  /** 변경 세트와 구름(호스트 좌표) */
  computeSets(): void {
    const d = this.diff;
    if (!d) return;
    this.diffBoxes = placedDiffBoxes(d, this.cur.doc, this.prev.doc, this.placements);
    const xb = xrefOfDoc(this.st.doc, this.blockKey)?.scene.bounds ?? null;
    const extent = unionBox([...(xb ? this.placements.map((m) => placeBox(xb, m)) : []), ...this.diffBoxes]);
    const diag = diagonal(extent);
    const margin = compareMargin(diag, this.settings.rcMargin);
    const arc = cloudArc(diag, margin);
    this.sets = changeSets(this.diffBoxes, extent, margin);
    this.clouds = [];
    this.sets.forEach((set, i) => {
      for (const o of setOutlines(set, this.diffBoxes, margin, this.settings.rcShape)) {
        const verts = cloudOf(o, arc);
        if (verts.length >= 2) this.clouds.push({ set: i, verts });
      }
    });
  }

  private buildClouds(): void {
    const renderer = this.app.view.renderer;
    this.cloudScene?.dispose(renderer);
    this.cloudScene = null;
    if (!this.clouds.length) return;
    const list: LwPolylineEntity[] = this.clouds.map((c, i) => ({
      type: 'LWPOLYLINE',
      ...entityDefaults(),
      handle: `XCMPRC${i + 1}`,
      layer: '0',
      color: { aci: c.set === this.current ? CLOUD_CURRENT_ACI : CLOUD_ACI },
      lineweight: 0,
      vertices: c.verts,
      closed: true,
      plinegen: false,
      constantWidth: 0,
      elevation: 0,
    }));
    try {
      this.cloudScene = new OverlayScene(renderer, this.st.doc, list, this.app.text, MODEL_SPACE);
    } catch {
      this.cloudScene = null;
    }
  }

  /** 설정이 바뀌었을 때 */
  applySettings(names: string[]): void {
    if (this.closed) return;
    const prev = this.settings;
    this.settings = compareSettings();
    if (names.some((n) => /^COMPARE(TEXT|HATCH|PROPS|TOLERANCE)$/.test(n))) {
      void this.recompare();
      return;
    }
    if (prev.rcMargin !== this.settings.rcMargin || prev.rcShape !== this.settings.rcShape) {
      this.computeSets();
      this.current = Math.min(this.current, this.sets.length - 1);
      this.buildClouds();
    }
    this.app.view.requestRender();
    this.onUpdate?.();
  }

  /** d만큼 다음 변경 세트로(돌아간다) 옮기고 그 세트로 줌 */
  step(d: number): ChangeSet | null {
    const n = this.sets.length;
    if (!n) return null;
    this.current = this.current < 0 ? (d > 0 ? 0 : n - 1) : (((this.current + d) % n) + n) % n;
    this.buildClouds();
    const b = this.sets[this.current]!.box;
    this.app.view.zoomRect(b.minX, b.minY, b.maxX, b.maxY, true, 0.08);
    this.app.view.requestRender();
    this.onUpdate?.();
    return this.sets[this.current]!;
  }

  // -------------------------------------------------------------------------
  // 그리기 고리
  // -------------------------------------------------------------------------

  install(): void {
    const v = this.app.view;
    this.prevOverride = v.modelStyleOverride;
    this.prevExtras = v.modelExtras;
    this.prevPlacements = v.xrefPlacements;
    this.prevRestore = v.onRestore;
    v.modelStyleOverride = this.override;
    v.modelExtras = this.extras;
    v.xrefPlacements = this.placementsHook;
    v.onRestore = this.restore;
    this.timer = window.setInterval(() => this.tick(), 250);
    v.requestRender();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    const v = this.app.view;
    if (v.modelStyleOverride === this.override) v.modelStyleOverride = this.prevOverride;
    if (v.modelExtras === this.extras) v.modelExtras = this.prevExtras;
    if (v.xrefPlacements === this.placementsHook) v.xrefPlacements = this.prevPlacements;
    if (v.onRestore === this.restore) v.onRestore = this.prevRestore;
    this.disposeScenes();
    v.requestRender();
    this.onUpdate?.();
  }

  private disposeScenes(): void {
    const r = this.app.view.renderer;
    for (const s of [this.newScene, this.commonScene, this.oldScene, this.cloudScene]) s?.dispose(r);
    this.newScene = this.commonScene = this.oldScene = this.cloudScene = null;
  }

  /** 호스트 객체를 회색조로 흐리게(같은 입력·배경이면 다시 계산하지 않는다) */
  private faded(d: Float32Array): Float32Array {
    const bg = this.app.view.modelBg;
    const key = String(bg);
    const c = this.fadeCache.get(d);
    if (c && c.key === key) return c.out;
    const out = fadeStyles(d, bg, 0.55, true);
    this.fadeCache.set(d, { key, out });
    return out;
  }

  private extraScenes(): Extra[] {
    const s = this.settings;
    const item = (sc: OverlayScene | null, lo: (k: string) => LayerState | undefined, color: string, fallback: number, show: boolean): Extra | null =>
      sc && show ? { gpu: sc.gpu, styles: (dark, bg, lw) => recolorStyles(sc.styleData(lo, dark, bg, lw), compareRgb(color, dark, fallback)) } : null;
    const common = item(this.commonScene, this.layersNew, s.colorCommon, 253, s.showCommon);
    const nw = item(this.newScene, this.layersNew, s.color1, 82, s.show1);
    const old = item(this.oldScene, this.layersOld, s.color2, 1, s.show2);
    // COMPAREFRONT 1: 지금 버전의 객체가 앞
    const order = s.front === 2 ? [common, nw, old] : [common, old, nw];
    const out: Extra[] = [];
    for (const x of order) if (x) out.push(x);
    const cl = this.cloudScene;
    if (cl && s.showRc) out.push({ gpu: cl.gpu, styles: (dark, bg, lw) => forceVisible(cl.styleData((k) => this.st.layers.get(k), dark, bg, lw)) });
    return out;
  }

  private tick(): void {
    if (this.closed) return;
    const st = this.st;
    if (!this.app.docs.includes(st) || !st.doc.blocks.has(this.blockKey)) {
      this.close();
      return;
    }
    this.onTick?.();
    // 호스트를 고치면(참조를 옮기거나 지우면) 잠시 뒤 자리를 다시 만든다(비교는 그대로)
    if (st.gen === this.gen) return;
    const now = performance.now();
    if (st.gen !== this.genSeen) {
      this.genSeen = st.gen;
      this.genAt = now;
      return;
    }
    if (now - this.genAt >= 300 && !this.busy) this.rebuild();
  }
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

let session: XCompareSession | null = null;
let toolbar: CompareToolbar | null = null;
let unlisten: (() => void) | null = null;
/** XCOMPARE가 고른 파일로 다시 로드하는 중인 참조(알림을 띄우지 않는다) */
let pendingKey: string | null = null;

/** 지금 외부 참조 비교(없으면 null) */
export function activeXCompare(): XCompareSession | null {
  return session && !session.closed ? session : null;
}

/** 외부 참조 비교를 끝낸다(열려 있었으면 true) */
export function closeXCompare(): boolean {
  const s = session;
  session = null;
  toolbar?.dispose();
  toolbar = null;
  unlisten?.();
  unlisten = null;
  if (!s || s.closed) return false;
  s.close();
  return true;
}

async function start(app: App, ctx: CommandContext, st: DocState, blockKey: string, fileKey: string, prev: Version, cur: Version): Promise<void> {
  closeXCompare();
  closeCompare();
  const s = new XCompareSession(app, st, blockKey, fileKey, prev, cur);
  app.ui.setBusy('외부 참조 비교 중…', 0.5);
  await new Promise((r) => setTimeout(r, 30));
  try {
    s.compare();
  } finally {
    app.ui.setBusy(null);
  }
  s.install();
  session = s;
  const tb = new CompareToolbar(
    app,
    s,
    {
      prev: () => void app.run('XCOMPARERCPREV'),
      next: () => void app.run('XCOMPARERCNEXT'),
      close: () => void app.run('XCOMPARECLOSE'),
    },
    {
      title: '외부 참조 비교',
      labels: ['현재 외부 참조에서만', '현재 외부 참조에 없음', '차이 없음'],
      extraSettings: () => {
        const cb = h('input', { type: 'checkbox', 'aria-label': '호스트 객체 회색' }) as HTMLInputElement;
        cb.checked = Number(getCompareVar('XCOMPARECOLORMODE')) === 1;
        cb.addEventListener('change', () => setCompareVars({ XCOMPARECOLORMODE: cb.checked ? 1 : 0 }));
        return [h('h4', {}, '외부 참조 비교'), h('div', { class: 'row' }, h('label', { title: 'XCOMPARECOLORMODE' }, cb, '호스트 도면 객체를 회색으로'))];
      },
    },
  );
  toolbar = tb;
  s.onUpdate = () => {
    if (s.closed) {
      if (session === s) closeXCompare();
      return;
    }
    tb.update();
  };
  s.onTick = () => tb.setVisible(app.active === st && st.isModel && !st.msVp && !st.blockEdit);
  unlisten = onCompareVarsChange((names) => {
    if (names.includes('XCOMPARECOLORMODE')) app.view.requestRender();
    s.applySettings(names);
  });
  const d = s.diff!;
  ctx.print(`외부 참조 "${s.blockName}"을(를) 비교했습니다: 이전 "${prev.name}", 현재 "${cur.name}"${d.sameLineage ? '(같은 계보 — 핸들로 맞춤)' : ''}.`);
  ctx.print(xcompareSummary(d, s.sets.length), 'res');
  if (!d.onlyNew.length && !d.onlyOld.length) ctx.print('두 버전에 차이가 없습니다.');
}

/** XCOMPARE */
async function xcompare(app: App, ctx: CommandContext, arg?: string): Promise<void> {
  const st = app.active!;
  if (st.blockEdit) {
    ctx.print('블록 편집기에서는 외부 참조를 비교할 수 없습니다.', 'err');
    return;
  }
  const keys = xrefBlockKeys(st.doc).filter((k) => xrefInserts(st.doc, k).length > 0);
  if (!keys.length) {
    const onPaper = st.doc.layouts.some((l) => tableKey(l.blockName) !== MODEL_SPACE && xrefBlockKeys(st.doc).some((k) => xrefInserts(st.doc, k, l.blockName).length > 0));
    ctx.print(onPaper ? '모형 공간에 부착된 외부 참조가 없습니다. 배치(도면 공간)에 부착한 외부 참조의 비교는 이 웹 버전에서 아직 지원하지 않습니다.' : '모형 공간에 부착된 외부 참조가 없습니다.', 'err');
    return;
  }
  if (st.space !== MODEL_SPACE || st.msVp) await app.setSpace(MODEL_SPACE);
  let key: string | null = null;
  if (arg?.trim()) {
    key = keys.find((k) => k === tableKey(arg.trim())) ?? null;
    if (!key) {
      ctx.print(`"${arg.trim()}"은(는) 모형 공간에 부착된 외부 참조가 아닙니다.`, 'err');
      return;
    }
  } else if (keys.length === 1) key = keys[0]!;
  else {
    for (;;) {
      const r = await ctx.getEntity('비교할 외부 참조 선택:');
      if (!('handle' in r)) return;
      const e = st.doc.entityIndex.get(r.handle);
      if (e?.type === 'INSERT' && keys.includes(tableKey(e.block))) {
        key = tableKey(e.block);
        break;
      }
      ctx.print('선택한 객체가 외부 참조가 아닙니다.', 'err');
    }
  }
  const blk = st.doc.blocks.get(key)!;
  const fileKey = xrefFileKey(blk);
  const file = xrefOfDoc(st.doc, key);
  if (!file) {
    ctx.print(`외부 참조 "${blk.name}"의 파일이 로드되지 않았습니다. 외부 참조 창(XR)에서 파일을 연결한 뒤 비교하십시오.`, 'err');
    return;
  }
  let prev = previous.get(fileKey) ?? null;
  if (!prev) {
    ctx.print(`외부 참조 "${blk.name}"의 이전 버전이 없습니다(이 세션에서 다른 내용으로 다시 로드하지 않았습니다). 바뀐 파일을 고르면 그 파일로 다시 로드하고 지금 내용과 비교합니다.`);
    const f = await pickDrawingFile();
    if (!f) return;
    const before: Version = { name: file.name, doc: file.doc };
    pendingKey = fileKey;
    try {
      const linked = await linkXrefFiles(app, [f], fileKey);
      if (!linked.length) return;
    } finally {
      pendingKey = null;
    }
    previous.set(fileKey, before);
    prev = before;
  }
  const now = xrefOfDoc(st.doc, key);
  if (!now || !app.docs.includes(st)) return;
  if (app.active !== st) app.activate(st);
  await start(app, ctx, st, key, fileKey, prev, { name: now.name, doc: now.doc });
}

async function stepSet(app: App, ctx: CommandContext, d: number): Promise<void> {
  const s = activeXCompare();
  if (!s || s.st !== app.active) {
    ctx.print('외부 참조를 비교하고 있지 않습니다. 먼저 XCOMPARE를 실행하십시오.', 'err');
    return;
  }
  if (!s.sets.length) {
    ctx.print('변경 세트가 없습니다.');
    return;
  }
  if (s.st.space !== MODEL_SPACE || s.st.msVp) await app.setSpace(MODEL_SPACE);
  s.step(d);
  ctx.print(`변경 세트 ${s.current + 1}/${s.sets.length}`);
}

export function registerXCompareCommands(app: App): void {
  // 도면 비교를 시작하면 외부 참조 비교를 닫는다
  beforeCompare.add(() => void closeXCompare());

  // 다시 로드: 이전 버전을 남기고 바뀌었으면 비교를 권한다
  const prevReload = refHooks.onXrefReload;
  refHooks.onXrefReload = (key, prev, next) => {
    prevReload?.(key, prev, next);
    const enabled = Number(getCompareVar('XCOMPAREENABLE')) === 1;
    if (enabled || pendingKey === key) previous.set(key, prev);
    const s = activeXCompare();
    if (s && s.fileKey === key) {
      s.reloaded(prev, next);
      return;
    }
    if (!enabled || pendingKey === key) return;
    let d: XrefDiff;
    try {
      d = diffXrefVersions(prev.doc, next.doc, optionsOf(compareSettings()));
    } catch {
      return;
    }
    if (!xrefChanged(d)) return;
    const names = hostBlockNames(app, key);
    const label = names.length ? names.join(', ') : next.name;
    app.cmd.print(`외부 참조 "${label}"이(가) 바뀌었습니다(현재 외부 참조에서만 ${d.onlyNew.length}개, 현재 외부 참조에 없음 ${d.onlyOld.length}개). XCOMPARE로 바뀐 내용을 비교할 수 있습니다.`);
    toast(`외부 참조 "${label}"이(가) 바뀌었습니다. XCOMPARE로 비교할 수 있습니다.`, 'info', 6000);
  };

  // 외부 참조 창의 행 메뉴
  const prevMenu = refHooks.rowMenu;
  refHooks.rowMenu = (item, closeDialog) => [
    ...(prevMenu?.(item, closeDialog) ?? []),
    ...(item.kind === 'xref'
      ? [
          {
            label: '외부 참조 비교',
            disabled: !item.found,
            run: () => {
              closeDialog();
              void app.run('XCOMPARE', item.name);
            },
          },
        ]
      : []),
  ];

  app.register({ name: 'XCOMPARE', title: '외부 참조 비교', run: (ctx, arg) => xcompare(app, ctx, arg) });
  app.register({
    name: 'XCOMPARECLOSE',
    title: '외부 참조 비교 닫기',
    noDoc: true,
    run(ctx) {
      if (closeXCompare()) ctx.print('외부 참조 비교를 닫았습니다.');
      else ctx.print('외부 참조를 비교하고 있지 않습니다.');
    },
  });
  // 이전 버전을 둘 폴더·크기: 웹 페이지에는 폴더가 없다
  for (const name of ['XCOMPAREBAKPATH', 'XCOMPAREBAKSIZE']) {
    app.register({
      name,
      title: `외부 참조 비교: ${name}(이 웹 버전에는 없음)`,
      transparent: true,
      noDoc: true,
      run(ctx) {
        ctx.print(`${name}: 이 웹 버전에는 이전 버전을 둘 폴더가 없습니다. 외부 참조를 다시 로드할 때 이전 버전은 이 페이지 메모리에만 남고(XCOMPAREENABLE 1), 새로 고치면 사라집니다.`);
      },
    });
  }
  app.register({ name: 'XCOMPARERCNEXT', title: '외부 참조 비교: 다음 변경 세트', run: (ctx) => stepSet(app, ctx, 1) });
  app.register({ name: 'XCOMPARERCPREV', title: '외부 참조 비교: 이전 변경 세트', run: (ctx) => stepSet(app, ctx, -1) });
}

/** 시험용: 남긴 이전 버전 지우기 */
export function clearXrefHistory(): void {
  previous.clear();
}
