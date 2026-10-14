/**
 * 도면 비교 세션: 현재 도면과 비교 도면의 비교 결과, 변경 세트·구름, 화면 덧그림과 편집 뒤 다시 비교.
 *
 * 그리기는 뷰의 고리를 쓴다(view.ts는 고치지 않는다).
 * - modelStyleOverride: 현재 도면의 기본 장면을 한 색으로. 보통은 "차이 없음" 색(COMPARECOLORCOMMON)이고 위에
 *   "현재 도면에서만" 객체(COMPARECOLOR1)를 덧그린다. 차이가 공통보다 많으면 거꾸로 기본 장면을 COMPARECOLOR1로,
 *   공통 객체를 회색으로 덧그린다(메인 스레드에서 만드는 장면을 작게 — 공통점 없는 5만 객체 두 도면도 빠르게).
 * - modelExtras: 위 덧그림, "비교 도면에서만" 객체(엔진 워커가 비교 도면의 나머지 객체를 숨기고 그린 장면 — 그 도면의
 *   블록·도면층·글꼴을 쓴다, COMPARECOLOR2), 구름형 리비전(주황 30, 현재 세트 노랑 2).
 * 비교 도면의 객체는 그리기만 한다(고르기·스냅·저장되지 않는다).
 */
import type { CadDocument, Entity, LwPolylineEntity, LwVertex } from '../core/model';
import { MODEL_SPACE, entityDefaults } from '../core/model';
import { aciToRgb } from '../core/color';
import type { EntityBox } from '../render/displaylist';
import { type LayerState, layerStates } from '../render/styles';
import type { GpuScene } from '../render/webgl';
import type { SceneMessage } from '../worker/protocol';
import { entityBounds } from '../edit/geom';
import { type Box, type ChangeSet, type CompareResult, type CompareSettings, boxValid, changeSets, cloudArc, cloudOf, compareDrawings, compareMargin, diagonal, parseCompareColor, setOutlines, unionBox } from '../edit/compare';
import type { App } from './app';
import type { DocState } from './docstate';
import { OverlayScene, SpaceScene } from './scene';
import { isDark } from './view';
import { compareSettings } from './compare-vars';

/** 비교할 도면 */
export interface CompareSource {
  /** 표시 이름(파일 이름) */
  name: string;
  doc: CadDocument;
  /** 모형 공간 범위(읽을 때 그린 장면에서) */
  bounds: Box | null;
  /** 모형 공간 객체 상자(읽을 때 그린 장면에서) */
  boxes: Map<string, Box>;
  /** 파일 크기(바이트, 모르면 0) */
  size: number;
  /** 워커 문서 번호(파일에서 읽었으면 이 세션이 가진다 — 끝나면 닫는다) */
  workerDocId: number;
  /** 열린 도면이면 그 상태(워커 문서는 그 도면의 것) */
  open?: DocState;
}

/** 구름 색(ACI): 다른 세트 주황, 현재 세트 노랑 */
export const CLOUD_ACI = 30;
export const CLOUD_CURRENT_ACI = 2;
/** 편집 뒤 다시 비교하기까지(ms) */
export const RECOMPARE_DELAY = 1500;
/** 편집할 때마다 다시 만들 덧그림의 크기 한도 */
const LIVE_LIMIT = 5000;

type Extra = { gpu: GpuScene; styles: (dark: boolean, bg: number, lwDisplay: boolean) => Float32Array };
/** "비교 도면에서만" 장면(워커가 그린 것 또는 메인 스레드에서 만든 것) */
interface CmpScene extends Extra {
  entities: EntityBox[];
  dispose(): void;
}
type Override = (s: DocState) => ((data: Float32Array) => Float32Array) | null;
type Extras = (s: DocState) => Extra[];

/** 비교 색상 글 → RGB(ACI 7은 배경에 따라) */
export function compareRgb(text: string, dark: boolean, fallbackAci: number): number {
  const c = parseCompareColor(text);
  if (!c) return aciToRgb(fallbackAci, dark);
  return 'aci' in c ? aciToRgb(c.aci, dark) : c.rgb;
}

/** 스타일 자료의 색을 한 색으로 바꾼 사본(보임 플래그는 그대로, hide면 모두 숨김) */
export function recolorStyles(data: Float32Array, rgb: number, hide = false): Float32Array {
  const out = new Float32Array(data);
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  for (let o = 0; o + 7 < out.length; o += 8) {
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    if (hide) out[o + 5] = 0;
  }
  return out;
}

/** 모형 공간 최상위 객체 */
function modelEntities(doc: CadDocument): Entity[] {
  return doc.blocks.get(MODEL_SPACE)?.entities ?? [];
}

export class CompareSession {
  result: CompareResult | null = null;
  settings: CompareSettings;
  /** 변경 세트와 그 차이 객체 상자(번호는 diff와 같다) */
  sets: ChangeSet[] = [];
  diff: { side: 'cur' | 'cmp'; handle: string }[] = [];
  diffBoxes: (Box | null)[] = [];
  /** 구름(세트 번호, 정점) */
  clouds: { set: number; verts: LwVertex[] }[] = [];
  /** 보고 있는 변경 세트(-1 = 없음) */
  current = -1;
  /** 마지막 비교에 걸린 시간(ms): 맞추기, 이 도면 덧그림, 변경 세트·구름, 비교 도면 장면(워커) */
  timing = { compare: 0, scenes: 0, sets: 0, worker: 0 };
  /** 비교 중(다시 비교 포함) */
  busy = false;
  closed = false;
  /** 결과가 바뀔 때(도구막대가 듣는다) */
  onUpdate: (() => void) | null = null;
  /** 다시 비교한 뒤 */
  onRecompared: (() => void) | null = null;
  /** 0.25초마다(도구막대 보이기 등) */
  onTick: (() => void) | null = null;

  /**
   * 이 도면 쪽 덧그림: inverted가 거짓이면 "현재 도면에서만" 객체(기본 장면은 회색),
   * 참이면 공통 객체(기본 장면은 COMPARECOLOR1)
   */
  private inverted = false;
  private curScene: OverlayScene | null = null;
  /** 비교한 뒤 고친 객체(다시 비교하기 전까지 COMPARECOLOR1) */
  private editScene: OverlayScene | null = null;
  /** 비교 도면에서만 있는 객체(워커가 그린 장면) */
  private cmpScene: CmpScene | null = null;
  private cmpSerial = 0;
  private cloudScene: OverlayScene | null = null;
  /** 비교할 때의 현재 도면 객체(편집으로 바뀐 것을 찾는다) */
  private snap = new Map<string, Entity>();
  private gen = -1;
  private seenGen = -1;
  private lastChange = 0;
  private timer = 0;
  private prevOverride: Override | null = null;
  private prevExtras: Extras | null = null;
  private prevRestore: (() => void) | null = null;
  private readonly override: Override;
  private readonly extras: Extras;
  private readonly restore: () => void;
  private recolorCache = new WeakMap<Float32Array, { key: string; out: Float32Array }>();
  private ver = 0;

  constructor(
    readonly app: App,
    readonly st: DocState,
    readonly src: CompareSource,
  ) {
    this.settings = compareSettings();
    this.override = (s) => (s === this.st && !this.closed ? (d) => this.recolorBase(d) : (this.prevOverride?.(s) ?? null));
    this.extras = (s) => (s === this.st && !this.closed ? this.extraScenes() : (this.prevExtras?.(s) ?? []));
    this.restore = () => {
      this.prevRestore?.();
      if (!this.closed) this.rebuildScenes();
    };
  }

  // -------------------------------------------------------------------------
  // 비교
  // -------------------------------------------------------------------------

  /** 비교한다. 이 도면 쪽 그림과 변경 세트는 바로, 비교 도면 쪽 장면은 워커가 그려 오면 바꾼다 */
  compare(): CompareResult {
    const st = this.st;
    const s = (this.settings = compareSettings());
    const t0 = performance.now();
    const r = compareDrawings(st.doc, this.src.doc, { tolerance: s.tolerance, text: s.text, hatch: s.hatch, props: s.props });
    this.result = r;
    this.gen = this.seenGen = st.gen;
    this.snap = new Map();
    for (const e of modelEntities(st.doc)) if (e.handle) this.snap.set(e.handle, e);
    const t1 = performance.now();
    this.disposeEdited();
    this.buildCurScene();
    const t2 = performance.now();
    this.computeSets();
    this.current = Math.min(this.current, this.sets.length - 1);
    this.buildCloudScene();
    this.timing = { compare: t1 - t0, scenes: t2 - t1, sets: performance.now() - t2, worker: this.timing.worker };
    this.ver++;
    this.app.view.requestRender();
    this.onUpdate?.();
    void this.buildCmpScene();
    return r;
  }

  /** 다시 비교(도구막대에 "비교 중…"을 먼저 보이고) */
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
      if (!this.closed) this.onRecompared?.();
    }
  }

  private overlayOf(list: Entity[]): OverlayScene | null {
    if (!list.length) return null;
    const app = this.app;
    return new OverlayScene(app.view.renderer, this.st.doc, list, app.text, MODEL_SPACE, undefined, app.imageKeys, app.pdfPages);
  }

  /** 이 도면 쪽 덧그림(차이와 공통 중 작은 쪽) */
  private buildCurScene(): void {
    const r = this.result!;
    this.curScene?.dispose(this.app.view.renderer);
    const only = new Set(r.onlyCurrent);
    this.inverted = r.onlyCurrent.length > r.common;
    const list = modelEntities(this.st.doc).filter((e) => e.type !== 'VIEWPORT' && only.has(e.handle) !== this.inverted);
    this.curScene = this.overlayOf(list);
  }

  /**
   * 비교 도면에서만 있는 객체의 장면: 워커가 비교 도면의 나머지 객체를 숨기고 그린다(메인 스레드를 막지 않는다).
   * 워커 문서가 없으면(비교하던 열린 도면을 닫았으면) 메인 스레드에서 만든다.
   */
  private async buildCmpScene(): Promise<void> {
    const r = this.result!;
    const serial = ++this.cmpSerial;
    const engine = this.app.engine;
    const id = this.src.workerDocId;
    const keep = new Set(r.onlyCompare);
    const t0 = performance.now();
    const renderer = this.app.view.renderer;
    let next: CmpScene | null = null;
    const workerAlive = !this.src.open || this.app.docs.includes(this.src.open);
    if (keep.size && workerAlive) {
      const hide = modelEntities(this.src.doc)
        .map((e) => e.handle)
        .filter((h) => h && !keep.has(h));
      // 숨기기·그리기·되돌리기를 잇달아 보낸다(워커는 차례로, 그리기는 기다림 없이 처리한다)
      engine.hide(id, hide);
      const p = engine.build(id, MODEL_SPACE);
      engine.hide(id, this.src.open ? [...this.src.open.hiddenObjects] : []);
      let msg: SceneMessage | null = null;
      try {
        msg = await p;
      } catch {
        msg = null;
      }
      if (this.closed || serial !== this.cmpSerial) return;
      if (msg) {
        const scene = new SpaceScene(renderer, msg, MODEL_SPACE);
        const layers: LayerState[] = msg.layers;
        next = { gpu: scene.gpu, entities: scene.entities, styles: (dark, bg, lw) => scene.styleData(layers, 'compare', dark, bg, lw), dispose: () => scene.dispose(renderer) };
      }
    }
    if (!next && keep.size) next = this.mainThreadCmpScene(keep);
    if (this.closed || serial !== this.cmpSerial) {
      next?.dispose();
      return;
    }
    this.cmpScene?.dispose();
    this.cmpScene = next;
    this.timing.worker = performance.now() - t0;
    this.app.view.requestRender();
  }

  /** 메인 스레드에서 만든 "비교 도면에서만" 장면(그 도면의 블록·도면층) */
  private mainThreadCmpScene(keep: Set<string>): CmpScene | null {
    const list = modelEntities(this.src.doc).filter((e) => keep.has(e.handle));
    if (!list.length) return null;
    const renderer = this.app.view.renderer;
    const ov = new OverlayScene(renderer, this.src.doc, list, this.app.text, MODEL_SPACE);
    const ls = layerStates(this.src.doc);
    const layers = new Map([...ls.indexOf].map(([k, i]) => [k, ls.states[i]!]));
    return { gpu: ov.gpu, entities: ov.entities, styles: (dark, bg, lw) => ov.styleData((k) => layers.get(k), dark, bg, lw), dispose: () => ov.dispose(renderer) };
  }

  /** 객체 상자: 이 도면은 기본 장면(편집한 것은 편집 덧그림), 비교 도면은 읽을 때의 장면, 없으면 기하 계산 */
  private boxesOf(side: 'cur' | 'cmp', handles: readonly string[]): (Box | null)[] {
    const doc = side === 'cur' ? this.st.doc : this.src.doc;
    let get: (h: string) => Box | undefined;
    if (side === 'cur') {
      const base = this.st.scenes.get(MODEL_SPACE);
      const ed = this.st.edits.get(MODEL_SPACE);
      const live = new Map<string, EntityBox>();
      for (const b of ed?.overlay?.entities ?? []) live.set(b.handle, b);
      get = (h) => (ed?.live.has(h) ? live.get(h) : ed?.hidden.has(h) ? undefined : base?.boxOf(h));
    } else get = (h) => this.src.boxes.get(h);
    return handles.map((h) => {
      const b = get(h);
      if (boxValid(b)) return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      const e = doc.entityIndex.get(h);
      if (!e) return null;
      try {
        return entityBounds(e, doc);
      } catch {
        return null;
      }
    });
  }

  /** 두 도면 범위와 대각선·여백·호 길이 */
  geometry(): { extent: Box | null; diag: number; margin: number; arc: number } {
    const extent = unionBox([this.st.scenes.get(MODEL_SPACE)?.bounds ?? null, this.src.bounds, ...this.diffBoxes]);
    const diag = diagonal(extent);
    const margin = compareMargin(diag, this.settings.rcMargin);
    return { extent, diag, margin, arc: cloudArc(diag, margin) };
  }

  /** 변경 세트와 구름(여백·쉐이프가 바뀌면 이것만 다시) */
  computeSets(): void {
    const r = this.result;
    if (!r) return;
    this.diff = [...r.onlyCurrent.map((h) => ({ side: 'cur' as const, handle: h })), ...r.onlyCompare.map((h) => ({ side: 'cmp' as const, handle: h }))];
    this.diffBoxes = [...this.boxesOf('cur', r.onlyCurrent), ...this.boxesOf('cmp', r.onlyCompare)];
    const g = this.geometry();
    this.sets = changeSets(this.diffBoxes, g.extent, g.margin);
    this.clouds = [];
    this.sets.forEach((set, i) => {
      for (const o of setOutlines(set, this.diffBoxes, g.margin, this.settings.rcShape)) {
        const verts = cloudOf(o, g.arc);
        if (verts.length >= 2) this.clouds.push({ set: i, verts });
      }
    });
  }

  private buildCloudScene(): void {
    const renderer = this.app.view.renderer;
    this.cloudScene?.dispose(renderer);
    this.cloudScene = null;
    if (!this.clouds.length) return;
    const list: LwPolylineEntity[] = this.clouds.map((c, i) => ({
      type: 'LWPOLYLINE',
      ...entityDefaults(),
      handle: `CMPRC${i + 1}`,
      layer: '0',
      color: { aci: c.set === this.current ? CLOUD_CURRENT_ACI : CLOUD_ACI },
      lineweight: 0,
      vertices: c.verts,
      closed: true,
      plinegen: false,
      constantWidth: 0,
      elevation: 0,
    }));
    this.cloudScene = this.overlayOf(list);
  }

  /** 그래픽 문맥을 되찾은 뒤(GPU 자원이 사라졌다) */
  rebuildScenes(): void {
    if (!this.result) return;
    this.buildCurScene();
    this.buildCloudScene();
    this.markEdited();
    void this.buildCmpScene();
    this.app.view.requestRender();
  }

  /** 설정이 바뀌었을 때 */
  applySettings(names: string[]): void {
    if (this.closed) return;
    const prev = this.settings;
    this.settings = compareSettings();
    this.ver++;
    if (names.some((n) => /^COMPARE(TEXT|HATCH|PROPS|TOLERANCE)$/.test(n))) {
      void this.recompare();
      return;
    }
    if (prev.rcMargin !== this.settings.rcMargin || prev.rcShape !== this.settings.rcShape) {
      this.computeSets();
      this.current = Math.min(this.current, this.sets.length - 1);
      this.buildCloudScene();
    }
    this.app.view.requestRender();
    this.onUpdate?.();
  }

  // -------------------------------------------------------------------------
  // 변경 세트 이동
  // -------------------------------------------------------------------------

  /** d만큼 다음 세트로(돌아간다) 옮기고 그 세트로 줌 */
  step(d: number): ChangeSet | null {
    const n = this.sets.length;
    if (!n) return null;
    this.current = this.current < 0 ? (d > 0 ? 0 : n - 1) : (((this.current + d) % n) + n) % n;
    this.buildCloudScene();
    const b = this.sets[this.current]!.box;
    this.app.view.zoomRect(b.minX, b.minY, b.maxX, b.maxY, true, 0.08);
    this.app.view.requestRender();
    this.onUpdate?.();
    return this.sets[this.current]!;
  }

  // -------------------------------------------------------------------------
  // 그리기
  // -------------------------------------------------------------------------

  install(): void {
    const v = this.app.view;
    this.prevOverride = v.modelStyleOverride;
    this.prevExtras = v.modelExtras;
    this.prevRestore = v.onRestore;
    v.modelStyleOverride = this.override;
    v.modelExtras = this.extras;
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
    if (v.onRestore === this.restore) v.onRestore = this.prevRestore;
    const renderer = v.renderer;
    this.curScene?.dispose(renderer);
    this.cmpScene?.dispose();
    this.cloudScene?.dispose(renderer);
    this.disposeEdited();
    this.curScene = this.cloudScene = null;
    this.cmpScene = null;
    // 파일에서 읽은 비교 도면은 워커에서도 닫는다
    if (!this.src.open) this.app.engine.closeDoc(this.src.workerDocId);
    v.requestRender();
    this.onUpdate?.();
  }

  /** 한 색으로 바꾼 스타일(같은 입력이면 다시 계산하지 않는다) */
  private recolored(data: Float32Array, rgb: number, hide: boolean): Float32Array {
    const key = `${this.ver}|${rgb}|${hide}`;
    const c = this.recolorCache.get(data);
    if (c && c.key === key) return c.out;
    const out = recolorStyles(data, rgb, hide);
    this.recolorCache.set(data, { key, out });
    return out;
  }

  private recolorBase(data: Float32Array): Float32Array {
    const s = this.settings;
    const dark = isDark(this.app.view.modelBg);
    return this.inverted ? this.recolored(data, compareRgb(s.color1, dark, 82), !s.show1) : this.recolored(data, compareRgb(s.colorCommon, dark, 253), !s.showCommon);
  }

  private extraScenes(): Extra[] {
    const s = this.settings;
    const st = this.st;
    const layerOf = (k: string) => st.layers.get(k);
    const out: Extra[] = [];
    const color1 = (dark: boolean) => compareRgb(s.color1, dark, 82);
    const cur = this.curScene;
    // 기본 장면 위의 덧그림: 감춘 쪽은 배경색으로 덮는다(기본 장면이 이미 같은 객체를 그렸다)
    const curItem: Extra | null = cur
      ? {
          gpu: cur.gpu,
          styles: (dark, bg, lw) => {
            const d = cur.styleData(layerOf, dark, bg, lw);
            if (this.inverted) return recolorStyles(d, s.showCommon ? compareRgb(s.colorCommon, dark, 253) : bg);
            return recolorStyles(d, s.show1 ? color1(dark) : bg);
          },
        }
      : null;
    const ed = this.editScene;
    const editItem: Extra | null = ed && s.show1 ? { gpu: ed.gpu, styles: (dark, bg, lw) => recolorStyles(ed.styleData(layerOf, dark, bg, lw), color1(dark)) } : null;
    const cmp = this.cmpScene;
    const cmpItem: Extra | null = cmp && s.show2 ? { gpu: cmp.gpu, styles: (dark, bg, lw) => this.recolored(cmp.styles(dark, bg, lw), compareRgb(s.color2, dark, 1), false) } : null;
    // COMPAREFRONT 1: 현재 도면 객체가 앞(나중에 그린다). 공통 객체 덧그림(inverted)은 늘 비교 도면 객체 아래
    const order = this.inverted ? (s.front === 2 ? [curItem, editItem, cmpItem] : [curItem, cmpItem, editItem]) : s.front === 2 ? [curItem, editItem, cmpItem] : [cmpItem, curItem, editItem];
    for (const x of order) if (x) out.push(x);
    const cl = this.cloudScene;
    if (cl && s.showRc) out.push({ gpu: cl.gpu, styles: (dark, bg, lw) => forceVisible(cl.styleData(layerOf, dark, bg, lw)) });
    return out;
  }

  // -------------------------------------------------------------------------
  // 편집 따라가기
  // -------------------------------------------------------------------------

  /** 현재 도면이 바뀌었으면: 바뀐 객체를 곧바로 "현재 도면에서만" 색으로, 멈추면 다시 비교 */
  private tick(): void {
    if (this.closed) return;
    const st = this.st;
    if (!this.app.docs.includes(st)) {
      this.close();
      return;
    }
    this.onTick?.();
    if (st.gen === this.gen) return;
    const now = performance.now();
    if (st.gen !== this.seenGen) {
      this.seenGen = st.gen;
      this.lastChange = now;
      this.markEdited();
      return;
    }
    if (now - this.lastChange >= RECOMPARE_DELAY && !this.app.busyCommand && !this.busy) void this.recompare();
  }

  /**
   * 비교한 뒤 바뀐(새로 생기거나 고친) 객체를 곧바로 "현재 도면에서만" 색으로 덧그린다.
   * 이 도면 쪽 덧그림이 크지 않으면 지금 도면으로 다시 만든다(지우거나 고친 객체의 옛 그림이 바로 사라지게).
   */
  markEdited(): void {
    const r = this.result;
    if (!r) return;
    const st = this.st;
    const renderer = this.app.view.renderer;
    const only = new Set(r.onlyCurrent);
    const edited: Entity[] = [];
    const still: Entity[] = [];
    for (const e of modelEntities(st.doc)) {
      if (e.type === 'VIEWPORT') continue;
      if (this.snap.get(e.handle) !== e) edited.push(e);
      else if (only.has(e.handle) !== this.inverted) still.push(e);
    }
    if ((this.inverted ? r.common : r.onlyCurrent.length) <= LIVE_LIMIT) {
      this.curScene?.dispose(renderer);
      this.curScene = this.overlayOf(still);
    }
    this.disposeEdited();
    if (edited.length <= LIVE_LIMIT) this.editScene = this.overlayOf(edited);
    this.app.view.requestRender();
  }

  private disposeEdited(): void {
    this.editScene?.dispose(this.app.view.renderer);
    this.editScene = null;
  }

  // -------------------------------------------------------------------------
  // 조회
  // -------------------------------------------------------------------------

  /** 비교 도면에서만 있는 객체의 상자(가져오기에서 고르는 데 쓴다) */
  compareBoxes(): EntityBox[] {
    const r = this.result;
    if (!r) return [];
    const scene = this.cmpScene;
    if (scene) return scene.entities.filter((b) => boxValid(b));
    const boxes = this.boxesOf('cmp', r.onlyCompare);
    const out: EntityBox[] = [];
    r.onlyCompare.forEach((h, i) => {
      const b = boxes[i];
      if (b) out.push({ handle: h, ...b });
    });
    return out;
  }

  /** 비교 결과가 지금 도면과 맞는지(편집 뒤 아직 다시 비교하지 않았으면 거짓) */
  get fresh(): boolean {
    return this.st.gen === this.gen;
  }
}

function forceVisible(d: Float32Array): Float32Array {
  for (let o = 5; o < d.length; o += 8) d[o] = 1;
  return d;
}
