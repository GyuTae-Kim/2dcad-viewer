/**
 * 도면 영역: 카메라(확대·이동), WebGL 그리기, 배치·뷰포트, 오버레이(커서·선택·스냅·고무줄).
 */
import { type Ucs, currentUcs, isWorld, toUcs, toWcs } from './ucs';
import type { XrefPlacement } from './refs';
import type { ViewportModel } from './psltscale';
import { MODEL_SPACE, type ViewportEntity, tableKey } from '../core/model';
import earcut from 'earcut';
import { GLRenderer, type GpuScene, type ViewXf } from '../render/webgl';
import type { Camera, DocState, Tile } from './docstate';
import { type OverlayScene, type PaperInfo, type ViewportXf, layoutViewports, paperInfo, viewportXf } from './scene';
import type { DisplayList } from '../render/displaylist';

export interface Pt {
  x: number;
  y: number;
}

export type SnapKind = 'end' | 'mid' | 'cen' | 'qua' | 'int' | 'nea' | 'ins' | 'nod' | 'per' | 'tan' | 'ext' | 'app' | 'gcen';

export interface OverlayGeom {
  /** 월드 좌표 선분 [x0, y0, x1, y1, …] */
  segs: number[];
  /** 월드 좌표 삼각형 [x0, y0, x1, y1, x2, y2, …] (채움 강조) */
  tris?: number[];
}

export interface OverlayState {
  cursor: Pt | null;
  crosshair: boolean;
  pickbox: number;
  windowRect: { a: Pt; b: Pt } | null;
  selection: OverlayGeom[];
  hover: OverlayGeom | null;
  grips: Pt[];
  snap: { p: Pt; kind: SnapKind } | null;
  rubber: { pts: number[]; closed?: boolean; fill?: boolean; dashed?: boolean }[];
  /** 끌고 있는 객체 미리보기(이동·복사·회전 등) */
  ghost: OverlayGeom[];
  /** 추적 정렬선(극좌표·객체 스냅 추적): 시작점과 단위 방향 */
  tracks: { from: Pt; dir: Pt }[];
  /** 객체 스냅 추적 획득점 */
  acquired: Pt[];
  /** 누른 그립(빨강) */
  hotGrip: Pt | null;
  /** 동적 입력: 커서 옆에 보이는 입력 중인 글자 */
  dynInput: string | null;
  marks: { p: Pt; text?: string }[];
  /** 커서 옆 동적 입력 문구 */
  tip: string | null;
}

export interface GridInfo {
  x: number;
  y: number;
  major: number;
  baseX: number;
  baseY: number;
  limits?: [number, number, number, number];
  /** UCS에 맞춘 격자 */
  ucs: Ucs;
}

export interface ViewEvents {
  move(world: Pt, screen: Pt, ev: PointerEvent): void;
  down(world: Pt, screen: Pt, ev: PointerEvent): void;
  click(world: Pt, screen: Pt, ev: PointerEvent): void;
  drag(a: Pt, b: Pt, done: boolean, ev: PointerEvent): void;
  context(world: Pt, screen: Pt, ev: MouseEvent): void;
  dblclick(world: Pt, screen: Pt, ev: MouseEvent): void;
  leave(): void;
  viewChanged(): void;
  /** MSPACE에서 확대·이동이 뷰포트의 뷰를 바꿀 때 */
  viewportView?(vp: ViewportEntity, patch: Pick<ViewportEntity, 'viewHeight' | 'viewCenter'>): void;
}

const DARK_BG = 0x212830;
const LAYOUT_BG = 0x3b414b;

function rgbF(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

export class CadView {
  readonly el: HTMLDivElement;
  readonly glCanvas: HTMLCanvasElement;
  readonly ovCanvas: HTMLCanvasElement;
  readonly renderer: GLRenderer;
  private readonly ctx2d: CanvasRenderingContext2D;
  state: DocState | null = null;
  overlay: OverlayState = emptyOverlay();
  lwDisplay = false;
  modelBg = DARK_BG;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private dirty = true;
  private raf = 0;
  private events: ViewEvents | null = null;
  // 입력 상태
  private panning: { x: number; y: number; cam: Camera } | null = null;
  private leftDown: { x: number; y: number; dragging: boolean } | null = null;
  private lastMiddle = 0;
  private touches = new Map<number, Pt>();
  private pinch: { d: number; mid: Pt; cam: Camera; world: Pt } | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'drawing';
    this.glCanvas = document.createElement('canvas');
    this.ovCanvas = document.createElement('canvas');
    this.ovCanvas.className = 'overlay';
    this.el.append(this.glCanvas, this.ovCanvas);
    parent.append(this.el);
    this.renderer = new GLRenderer(this.glCanvas);
    this.ctx2d = this.ovCanvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    // 그래픽 장치가 초기화되면(드라이버 재시작 등) 셰이더와 장면을 다시 올린다
    this.glCanvas.addEventListener('webglcontextlost', (ev) => ev.preventDefault());
    this.glCanvas.addEventListener('webglcontextrestored', () => {
      this.renderer.init();
      this.onRestore?.();
      this.requestRender();
    });
    this.resize();
    this.bindInput();
  }

  /** 문맥 복구 뒤 장면을 다시 올리는 함수(앱이 넣는다) */
  onRestore: (() => void) | null = null;
  /** 외부 참조 장면(앱이 연결한 참조 파일). 문서 번호·참조 블록 이름(대문자)으로 찾는다 */
  xrefPlacements: ((st: DocState, list: DisplayList, visible: (style: number) => boolean, vpFrozen?: ReadonlySet<string>) => XrefPlacement[]) | null = null;
  /** 뷰포트에서 쓸 모형 장면(PSLTSCALE 변형 포함) */
  viewportModel: ((st: DocState, vx: ViewportXf) => ViewportModel | null) | null = null;

  /**
   * 표시 목록의 외부 참조 인스턴스를 그린다(참조 장면을 인스턴스 변환으로).
   * hostStyles는 호스트 장면의 스타일 표(블록 참조의 도면층이 꺼져 있으면 건너뛴다)
   */
  private drawXrefs(list: DisplayList | undefined, xf: ViewXf, lwScale: number, dark: boolean, bg: number, hostStyles: Float32Array | null, toScreen: (x: number, y: number) => [number, number], vpFrozen?: ReadonlySet<string>, noClip = false): boolean {
    const s = this.state;
    if (!s || !list?.xrefs?.length || !this.xrefPlacements) return false;
    const r = this.renderer;
    let drew = false;
    for (const p of this.xrefPlacements(s, list, hostStyles ? (st) => hostStyles[st * 8 + 5]! > 0 : () => true, vpFrozen)) {
      const [a, b, c, d, ex, fy] = p.m;
      const A = xf.A;
      const dx = ex - xf.refX;
      const dy = fy - xf.refY;
      const xxf: ViewXf = {
        A: [A[0] * a + A[2] * b, A[1] * a + A[3] * b, A[0] * c + A[2] * d, A[1] * c + A[3] * d],
        refX: 0,
        refY: 0,
        tx: A[0] * dx + A[2] * dy + xf.tx,
        ty: A[1] * dx + A[3] * dy + xf.ty,
      };
      const clip = !noClip && p.clip ? p.clip : null;
      if (clip) {
        const px: number[] = [];
        for (let i = 0; i + 1 < clip.length; i += 2) px.push(...toScreen(clip[i]!, clip[i + 1]!));
        const idx = earcut(px);
        const tris: number[] = [];
        for (const i of idx) tris.push(px[i * 2]!, px[i * 2 + 1]!);
        r.stencilClip(tris.length ? tris : null);
      }
      r.clearDepth();
      r.setStyles(p.file.scene.styleData(p.layers, p.key, dark, bg, this.lwDisplay));
      r.draw(p.file.scene.gpu, xxf, { lwScale, bg: rgbF(bg) });
      if (clip) r.stencilClip(null);
      drew = true;
    }
    if (drew) r.clearDepth();
    return drew;
  }

  /** 깊이 확대용 세부 장면(앱이 만들고 버린다). region 안이고 편집 세대가 같을 때만 기본 장면 대신 그린다 */
  detail: { docId: number; space: string; gen: number; region: [number, number, number, number]; scale: number; scene: OverlayScene } | null = null;

  on(events: ViewEvents): void {
    this.events = events;
  }

  resize(): void {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.renderer.resize(this.w, this.h, this.dpr);
    this.ovCanvas.width = Math.round(this.w * this.dpr);
    this.ovCanvas.height = Math.round(this.h * this.dpr);
    // 크기가 바뀌면 캔버스가 지워지므로 화면에 나가기 전에 바로 다시 그린다(깜박임 방지)
    this.dirty = false;
    this.renderGL();
    this.renderOverlay();
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  setState(s: DocState | null): void {
    this.state = s;
    // 도면이 열려 있으면 시스템 커서 대신 십자선을 그린다
    this.el.classList.toggle('cursor-none', !!s);
    this.overlay = emptyOverlay();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // 카메라
  // -------------------------------------------------------------------------

  /** 배치 그리기 중: MSPACE여도 종이 카메라를 쓴다 */
  private paperCam = false;

  camera(): Camera {
    const s = this.state;
    if (!s) return { cx: 0, cy: 0, scale: 1 };
    if (s.msVp && !this.paperCam) {
      const m = this.msInfo(s);
      if (m) {
        // 모형 → 종이(뷰포트 변환) → 화면(종이 카메라). 비틀림 없는 뷰포트만 들어온다
        const { vp, vx, paper } = m;
        return { cx: vx.refX + (paper.cx - vp.center.x) / vx.k, cy: vx.refY + (paper.cy - vp.center.y) / vx.k, scale: paper.scale * vx.k };
      }
    }
    const space = s.msVp ? s.msVp.layout : s.space;
    let c = s.cameras.get(space);
    if (!c) {
      c = { cx: 0, cy: 0, scale: 1 };
      s.cameras.set(space, c);
      if (!s.msVp) {
        this.zoomExtents(false);
        c = s.cameras.get(space)!;
      }
    }
    return c;
  }

  /** MSPACE의 활성 뷰포트와 그 변환, 종이 카메라 */
  msInfo(s: DocState): { vp: ViewportEntity; vx: ViewportXf; paper: Camera } | null {
    const e = s.msVp ? s.doc.entityIndex.get(s.msVp.handle) : undefined;
    if (!e || e.type !== 'VIEWPORT') return null;
    const paper = s.cameras.get(s.msVp!.layout);
    if (!paper) return null;
    return { vp: e, vx: viewportXf(s.doc, e), paper };
  }

  /** 화면 점 → 종이 좌표(MSPACE에서도 배치 좌표) */
  paperPoint(x: number, y: number): Pt {
    this.paperCam = true;
    try {
      return this.screenToWorld(x, y);
    } finally {
      this.paperCam = false;
    }
  }

  private setCamera(c: Camera, remember = true): void {
    const s = this.state;
    if (!s) return;
    if (s.msVp && !this.paperCam) {
      const m = this.msInfo(s);
      if (m) {
        const { vp, vx, paper } = m;
        if (vp.flags & 0x4000) {
          // 잠긴 뷰포트: 뷰는 그대로 두고 종이 공간을 확대·이동한다
          s.cameras.set(s.msVp.layout, { cx: vp.center.x + (c.cx - vx.refX) * vx.k, cy: vp.center.y + (c.cy - vx.refY) * vx.k, scale: clampScale(c.scale / vx.k) });
        } else {
          const k = c.scale / paper.scale;
          const refX = c.cx - (paper.cx - vp.center.x) / k;
          const refY = c.cy - (paper.cy - vp.center.y) / k;
          this.events?.viewportView?.(vp, { viewHeight: vp.height / k, viewCenter: { x: refX - vp.viewTarget.x, y: refY - vp.viewTarget.y } });
        }
        this.requestRender();
        this.events?.viewChanged();
        return;
      }
    }
    if (remember) {
      const prev = s.cameras.get(s.space);
      if (prev) {
        const list = s.prevCameras.get(s.space) ?? [];
        list.push({ ...prev });
        if (list.length > 30) list.shift();
        s.prevCameras.set(s.space, list);
      }
    }
    s.cameras.set(s.space, c);
    this.requestRender();
    this.events?.viewChanged();
  }

  screenToWorld(x: number, y: number): Pt {
    const c = this.camera();
    const a = this.area();
    return { x: c.cx + (x - a.x - a.w / 2) / c.scale, y: c.cy - (y - a.y - a.h / 2) / c.scale };
  }

  worldToScreen(x: number, y: number): Pt {
    const c = this.camera();
    const a = this.area();
    return { x: (x - c.cx) * c.scale + a.x + a.w / 2, y: -(y - c.cy) * c.scale + a.y + a.h / 2 };
  }

  // -------------------------------------------------------------------------
  // 모형 타일 뷰포트(VPORTS)
  // -------------------------------------------------------------------------

  /** 타일 뷰포트를 쓰는 중(모형, 배치·블록 편집기 아님) */
  private tiled(): DocState['tiles'] {
    const s = this.state;
    return s?.tiles && s.space === MODEL_SPACE && !s.msVp && !s.blockEdit && !this.paperCam ? s.tiles : null;
  }

  /** 타일의 화면 사각형(CSS 픽셀, 왼쪽 위 원점) */
  tileRect(t: Tile): { x: number; y: number; w: number; h: number } {
    return { x: t.ll.x * this.w, y: (1 - t.ur.y) * this.h, w: Math.max(1, (t.ur.x - t.ll.x) * this.w), h: Math.max(1, (t.ur.y - t.ll.y) * this.h) };
  }

  /** 지금 카메라가 그리는 화면 영역(타일이면 활성 타일) */
  private area(): { x: number; y: number; w: number; h: number } {
    const t = this.tiled();
    return t ? this.tileRect(t.list[t.active]!) : { x: 0, y: 0, w: this.w, h: this.h };
  }

  /** 화면 점이 든 타일 번호(타일이 없으면 -1) */
  tileAt(p: Pt): number {
    const t = this.tiled();
    if (!t) return -1;
    return t.list.findIndex((tl) => {
      const r = this.tileRect(tl);
      return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
    });
  }

  /** 타일 고르기(-VPORTS 결합): 있으면 타일을 눌러도 활성으로 바꾸지 않고 번호를 넘긴다 */
  tilePick: ((index: number) => void) | null = null;

  /** 지금 카메라가 보는 도면 범위(타일이면 활성 타일) [x0, y0, x1, y1] */
  visibleWorld(): [number, number, number, number] {
    return this.visibleRect();
  }

  /** 다른 타일을 활성으로(카메라를 바꿔 낀다) */
  activateTile(i: number): void {
    const s = this.state;
    const t = this.tiled();
    if (!s || !t || i === t.active || !t.list[i]) return;
    const cur = t.list[t.active]!;
    cur.cam = { ...this.camera() };
    cur.prev = s.prevCameras.get(MODEL_SPACE) ?? [];
    t.active = i;
    const next = t.list[i]!;
    s.prevCameras.set(MODEL_SPACE, next.prev);
    if (next.cam) s.cameras.set(MODEL_SPACE, { ...next.cam });
    else {
      s.cameras.set(MODEL_SPACE, { ...cur.cam });
      this.zoomExtents(false);
    }
    this.requestRender();
    this.events?.viewChanged();
  }

  /** CSS 픽셀 1개의 도면 길이 */
  pixelSize(): number {
    return 1 / this.camera().scale;
  }

  /** 현재 공간의 범위(배치는 용지 포함) */
  spaceBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const s = this.state;
    if (!s) return null;
    const scene = s.scenes.get(s.space);
    let b = scene?.bounds ?? null;
    if (!s.isModel) {
      const lay = s.layoutFor(s.space);
      if (lay) {
        const p = paperInfo(lay, b);
        b = b
          ? { minX: Math.min(b.minX, p.minX), minY: Math.min(b.minY, p.minY), maxX: Math.max(b.maxX, p.maxX), maxY: Math.max(b.maxY, p.maxY) }
          : { minX: p.minX, minY: p.minY, maxX: p.maxX, maxY: p.maxY };
      }
    }
    return b;
  }

  zoomExtents(remember = true): void {
    const b = this.spaceBounds();
    if (!b) {
      this.setCamera({ cx: 0, cy: 0, scale: 1 }, remember);
      return;
    }
    this.zoomRect(b.minX, b.minY, b.maxX, b.maxY, remember, 0.04);
  }

  zoomRect(x0: number, y0: number, x1: number, y1: number, remember = true, margin = 0.02): void {
    const w = Math.max(Math.abs(x1 - x0), 1e-9);
    const h = Math.max(Math.abs(y1 - y0), 1e-9);
    // MSPACE: 뷰포트 크기에 맞춘다
    const m = this.state?.msVp && !this.paperCam ? this.msInfo(this.state) : null;
    const ar = this.area();
    const W = m ? m.vp.width * m.paper.scale : ar.w;
    const H = m ? m.vp.height * m.paper.scale : ar.h;
    const sx = (W * (1 - margin * 2)) / w;
    const sy = (H * (1 - margin * 2)) / h;
    let scale = Math.min(sx, sy);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    this.setCamera({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: clampScale(scale) }, remember);
  }

  zoomPrevious(): boolean {
    const s = this.state;
    if (!s || s.msVp) return false;
    const list = s.prevCameras.get(s.space);
    const c = list?.pop();
    if (!c) return false;
    s.cameras.set(s.space, c);
    this.requestRender();
    this.events?.viewChanged();
    return true;
  }

  /** 화면 점(sx, sy)을 고정하고 배율을 f배 */
  zoomAt(sx: number, sy: number, f: number, remember = false): void {
    const c = this.camera();
    const w = this.screenToWorld(sx, sy);
    const scale = clampScale(c.scale * f);
    const a = this.area();
    const cx = w.x - (sx - a.x - a.w / 2) / scale;
    const cy = w.y + (sy - a.y - a.h / 2) / scale;
    this.setCamera({ cx, cy, scale }, remember);
  }

  zoomCenter(f: number): void {
    const a = this.area();
    this.zoomAt(a.x + a.w / 2, a.y + a.h / 2, f, true);
  }

  panBy(dx: number, dy: number): void {
    const c = this.camera();
    this.setCamera({ cx: c.cx - dx / c.scale, cy: c.cy + dy / c.scale, scale: c.scale }, false);
  }

  centerOn(x: number, y: number, size?: number): void {
    const c = this.camera();
    let scale = c.scale;
    const a = this.area();
    if (size && size > 0) scale = clampScale(Math.min(a.w, a.h) / (size * 4));
    this.setCamera({ cx: x, cy: y, scale }, true);
  }

  // -------------------------------------------------------------------------
  // 그리기
  // -------------------------------------------------------------------------

  requestRender(): void {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = 0;
    if (!this.dirty) return;
    this.dirty = false;
    this.renderGL();
    this.renderOverlay();
  }

  /** 오버레이만 다시 그린다(커서 움직임) */
  requestOverlay(): void {
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.dirty) {
          this.dirty = false;
          this.renderGL();
        }
        this.renderOverlay();
      });
  }

  private viewXf(c: Camera = this.camera(), a = this.area()): ViewXf {
    const s = c.scale * this.dpr;
    return { A: [s, 0, 0, -s], refX: c.cx, refY: c.cy, tx: (a.x + a.w / 2) * this.dpr, ty: (a.y + a.h / 2) * this.dpr };
  }

  private visibleRect(c: Camera = this.camera(), a = this.area()): [number, number, number, number] {
    const hw = a.w / 2 / c.scale;
    const hh = a.h / 2 / c.scale;
    return [c.cx - hw, c.cy - hh, c.cx + hw, c.cy + hh];
  }

  /** 지금 장면을 그린다(내보내기에서도 쓴다) */
  renderGL(): void {
    const r = this.renderer;
    const s = this.state;
    if (!s) {
      r.clear(rgbF(DARK_BG));
      return;
    }
    if (s.isModel && !s.msVp) this.renderModel(s);
    else {
      this.paperCam = true;
      try {
        this.renderLayout(s);
      } finally {
        this.paperCam = false;
      }
    }
  }

  private renderModel(s: DocState): void {
    const r = this.renderer;
    const scene = s.scenes.get(s.space);
    r.clear(rgbF(this.modelBg));
    if (!scene) return;
    const t = this.tiled();
    if (!t) {
      this.drawModelArea(s, this.camera(), this.area(), true);
      return;
    }
    // 타일 뷰포트: 타일마다 잘라 그 카메라로
    const activeCam = this.camera();
    t.list.forEach((tl, i) => {
      const a = this.tileRect(tl);
      const cam = i === t.active ? activeCam : (tl.cam ?? activeCam);
      r.scissor([a.x * this.dpr, a.y * this.dpr, a.w * this.dpr, a.h * this.dpr]);
      r.clearDepth();
      this.drawModelArea(s, cam, a, i === t.active);
    });
    r.scissor(null);
  }

  /** 모형 장면을 화면 영역 a에 카메라 cam으로(외부 참조·세부 장면·편집 덧그림 포함) */
  private drawModelArea(s: DocState, cam: Camera, a: { x: number; y: number; w: number; h: number }, active: boolean): void {
    const r = this.renderer;
    const scene = s.scenes.get(s.space)!;
    const bg = this.modelBg;
    const dark = isDark(bg);
    const xf = this.viewXf(cam, a);
    const vis = this.visibleRect(cam, a);
    const d = this.detail;
    const useDetail = active && !!d && d.docId === s.docId && d.space === s.space && d.gen === s.gen && d.region[0] <= vis[0] && d.region[1] <= vis[1] && d.region[2] >= vis[2] && d.region[3] >= vis[3];
    // 외부 참조(밑그림)
    const toScreenM = (x: number, y: number): [number, number] => [((x - cam.cx) * cam.scale + a.x + a.w / 2) * this.dpr, (-(y - cam.cy) * cam.scale + a.y + a.h / 2) * this.dpr];
    this.drawXrefs(useDetail ? d!.scene.source : scene.source, xf, 3.78 * this.dpr, dark, bg, scene.styleData(s.sceneLayers(s.space), 'model', dark, bg, this.lwDisplay), toScreenM);
    const recolor = this.modelStyleOverride?.(s) ?? null;
    if (useDetail && d) {
      // 깊이 확대: 보이는 영역을 지금 확대에 맞게 다시 나눈 세부 장면
      const sd = d.scene.styleData((k) => s.layers.get(k), dark, bg, this.lwDisplay);
      r.setStyles(recolor ? recolor(sd) : sd);
      r.draw(d.scene.gpu, xf, { lwScale: 3.78 * this.dpr, visible: vis, bg: rgbF(bg) });
    } else {
      const sd = scene.styleData(s.sceneLayers(s.space), 'model', dark, bg, this.lwDisplay);
      r.setStyles(recolor ? recolor(sd) : sd);
      r.draw(scene.gpu, xf, { lwScale: 3.78 * this.dpr, visible: vis, bg: rgbF(bg) });
    }
    this.drawOverlayScene(s.space, xf, 3.78 * this.dpr, dark, bg, undefined, vis);
    // 덧그릴 장면(도면 비교 등)
    if (this.modelExtras) {
      for (const x of this.modelExtras(s)) {
        r.clearDepth();
        r.setStyles(x.styles(dark, bg, this.lwDisplay));
        r.draw(x.gpu, xf, { lwScale: 3.78 * this.dpr, visible: vis, bg: rgbF(bg) });
      }
    }
  }

  /**
   * 모형 공간 기본 장면의 스타일 자료를 바꾸는 함수(도면 비교의 회색 등). null이면 그대로.
   * 받은 배열(항목마다 8칸: r, g, b, a, 선가중치, 보임, …)을 바꿔 돌려준다(사본을 만들어 바꿀 것).
   */
  modelStyleOverride: ((s: DocState) => ((data: Float32Array) => Float32Array) | null) | null = null;
  /** 모형 공간 위에 덧그릴 장면들(도면 비교의 "비교 도면에서만" 객체 등) */
  modelExtras: ((s: DocState) => { gpu: GpuScene; styles: (dark: boolean, bg: number, lwDisplay: boolean) => Float32Array }[]) | null = null;
  /** 선택·그립 위에 덧그릴 화면 표식(파라메트릭 구속 막대·치수 구속 등) */
  extraOverlay: ((g: CanvasRenderingContext2D, W: (x: number, y: number) => Pt, dark: boolean) => void) | null = null;

  /** 배치(용지, 뷰포트, 종이 공간 객체). MSPACE여도 배치를 그린다 */
  private renderLayout(s: DocState): void {
    const r = this.renderer;
    const space = s.displaySpace;
    const scene = s.scenes.get(space);
    r.clear(rgbF(LAYOUT_BG));
    const lay = s.layoutFor(space);
    if (!lay) return;
    const paper = paperInfo(lay, scene?.bounds ?? null);
    const toPx = (x: number, y: number) => {
      const p = this.worldToScreen(x, y);
      return [p.x * this.dpr, p.y * this.dpr] as const;
    };
    const [ax, ay] = toPx(paper.minX, paper.maxY);
    const [bx, by] = toPx(paper.maxX, paper.minY);
    const sh = 5 * this.dpr;
    const quad = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1];
    r.screenFill(quad(ax + sh, ay + sh, bx + sh, by + sh), [0, 0, 0, 0.45]);
    r.screenFill(quad(ax, ay, bx, by), [1, 1, 1, 1]);
    const lwScale = (this.camera().scale * this.dpr) / paper.mmPerUnit;
    if (s.scenes.has(MODEL_SPACE)) {
      for (const vp of layoutViewports(s.doc, lay)) {
        const vx = viewportXf(s.doc, vp);
        const vm = this.viewportModel ? this.viewportModel(s, vx) : null;
        if (vm) this.drawViewport(vx, vm, lwScale);
      }
    }
    r.scissor(null);
    r.clearDepth();
    if (scene) {
      const paperStyles = scene.styleData(s.sceneLayers(space), 'paper', false, 0xffffff, this.lwDisplay);
      // 종이 공간의 외부 참조(도곽 등)
      this.drawXrefs(scene.source, this.viewXf(), lwScale, false, 0xffffff, paperStyles, (x, y) => [...toPx(x, y)] as [number, number]);
      r.setStyles(paperStyles);
      r.draw(scene.gpu, this.viewXf(), { lwScale, visible: this.visibleRect() });
    }
    this.drawOverlayScene(space, this.viewXf(), lwScale, false, 0xffffff);
  }

  /** 편집 덧그림(기본 장면 위) */
  private drawOverlayScene(space: string, xf: ViewXf, lwScale: number, dark: boolean, bg: number, vpFrozen?: Set<string>, visible?: [number, number, number, number]): void {
    const s = this.state!;
    const ov = s.edits.get(space)?.overlay;
    if (!ov || !ov.entities.length) return;
    const r = this.renderer;
    r.clearDepth();
    r.setStyles(ov.styleData((k) => s.layers.get(k), dark, bg, this.lwDisplay, vpFrozen));
    r.draw(ov.gpu, xf, { lwScale, visible: visible ?? undefined });
  }

  private drawViewport(vx: ViewportXf, vm: ViewportModel, lwScale: number): void {
    const model = vm.scene;
    const layerIdx = vm.index;
    const r = this.renderer;
    const vp = vx.vp;
    const hw = vp.width / 2;
    const hh = vp.height / 2;
    const a = this.worldToScreen(vp.center.x - hw, vp.center.y + hh);
    const b = this.worldToScreen(vp.center.x + hw, vp.center.y - hh);
    const x0 = Math.max(0, a.x * this.dpr);
    const y0 = Math.max(0, a.y * this.dpr);
    const x1 = Math.min(this.w * this.dpr, b.x * this.dpr);
    const y1 = Math.min(this.h * this.dpr, b.y * this.dpr);
    if (x1 <= x0 || y1 <= y0) return;
    r.scissor([x0, y0, x1 - x0, y1 - y0]);
    r.clearDepth();
    // 다각형·원 뷰포트: 경계 안만(스텐실)
    if (vx.clip) {
      const px: number[] = [];
      for (let i = 0; i + 1 < vx.clip.length; i += 2) {
        const q = this.worldToScreen(vx.clip[i]!, vx.clip[i + 1]!);
        px.push(q.x * this.dpr, q.y * this.dpr);
      }
      const idx = earcut(px);
      const tris: number[] = [];
      for (const i of idx) tris.push(px[i * 2]!, px[i * 2 + 1]!);
      r.stencilClip(tris.length ? tris : null);
    }
    const frozen = new Set<number>();
    for (const n of vx.frozen) {
      const i = layerIdx.get(n);
      if (i !== undefined) frozen.add(i);
    }
    r.setStyles(model.styleData(vm.layers, 'vp', false, 0xffffff, this.lwDisplay, frozen.size ? frozen : undefined));
    const cam = this.camera();
    const ps = cam.scale * this.dpr; // 종이 단위 → 장치 픽셀
    const k = ps * vx.k;
    const c = Math.cos(-vx.twist);
    const sn = Math.sin(-vx.twist);
    // 모형 (dx, dy) → 종이 회전 → 화면(y 아래)
    const A: [number, number, number, number] = [k * c, -k * sn, -k * sn, -k * c];
    const center = this.worldToScreen(vp.center.x, vp.center.y);
    // 보이는 모형 범위(대략): 뷰포트 사각형을 모형으로
    const rad = Math.hypot(hw, hh) / vx.k;
    const xf: ViewXf = { A, refX: vx.refX, refY: vx.refY, tx: center.x * this.dpr, ty: center.y * this.dpr };
    const vis: [number, number, number, number] = [vx.refX - rad, vx.refY - rad, vx.refX + rad, vx.refY + rad];
    // 모형의 외부 참조(뷰포트 안). 다각형 뷰포트의 스텐실과 겹치지 않게 XCLIP 없는 것만 자르기 없이
    if (model.source.xrefs?.length) {
      const styles = model.styleData(vm.layers, 'vp', false, 0xffffff, this.lwDisplay, frozen.size ? frozen : undefined);
      const toS = (x: number, y: number): [number, number] => [A[0] * (x - xf.refX) + A[2] * (y - xf.refY) + xf.tx, A[1] * (x - xf.refX) + A[3] * (y - xf.refY) + xf.ty];
      if (this.drawXrefs(model.source, xf, lwScale, false, 0xffffff, styles, toS, vx.frozen, !!vx.clip)) {
        r.setStyles(styles);
      }
    }
    r.draw(model.gpu, xf, { lwScale, visible: vis });
    this.drawOverlayScene(MODEL_SPACE, xf, lwScale, false, 0xffffff, vx.frozen, vis);
    if (vx.clip) r.stencilClip(null);
  }

  /** 격자선: 너무 촘촘하면 주 격자 배수로 넓힌다(적응 격자) */
  /** 격자(F7)를 켰으면 그 간격(앱이 준다) */
  gridInfo: (() => GridInfo | null) | null = null;

  private drawGrid(g: CanvasRenderingContext2D, grid: GridInfo, dark: boolean): void {
    // 보이는 영역(과 한계)을 UCS 좌표로 바꿔 그 범위의 격자선을 긋는다
    const u = grid.ucs;
    const ar = this.area();
    const corners = [this.screenToWorld(ar.x, ar.y), this.screenToWorld(ar.x + ar.w, ar.y), this.screenToWorld(ar.x + ar.w, ar.y + ar.h), this.screenToWorld(ar.x, ar.y + ar.h)].map((p) => toUcs(u, p));
    let x0 = Math.min(...corners.map((p) => p.x));
    let x1 = Math.max(...corners.map((p) => p.x));
    let y0 = Math.min(...corners.map((p) => p.y));
    let y1 = Math.max(...corners.map((p) => p.y));
    if (grid.limits && isWorld(u)) {
      x0 = Math.max(x0, grid.limits[0]);
      y0 = Math.max(y0, grid.limits[1]);
      x1 = Math.min(x1, grid.limits[2]);
      y1 = Math.min(y1, grid.limits[3]);
      if (x1 <= x0 || y1 <= y0) return;
    }
    const px = this.camera().scale;
    const major = Math.max(1, Math.round(grid.major));
    let sx = grid.x;
    let sy = grid.y;
    for (let i = 0; i < 12 && Math.min(sx, sy) * px < 8; i++) {
      sx *= major > 1 ? major : 2;
      sy *= major > 1 ? major : 2;
    }
    if (Math.min(sx, sy) * px < 4 || (x1 - x0) / sx > 2000 || (y1 - y0) / sy > 2000) return;
    const S = (x: number, y: number) => {
      const w = toWcs(u, { x, y });
      return this.worldToScreen(w.x, w.y);
    };
    const axisAligned = Math.abs(Math.sin(u.angle * 2)) < 1e-9;
    const line = (minor: boolean, horiz: boolean) => {
      g.beginPath();
      const step = horiz ? sy : sx;
      const base = horiz ? grid.baseY : grid.baseX;
      const lo = horiz ? y0 : x0;
      const hi = horiz ? y1 : x1;
      const k0 = Math.ceil((lo - base) / step);
      const k1 = Math.floor((hi - base) / step);
      for (let k = k0; k <= k1; k++) {
        if ((k % major === 0) === minor && major > 1) continue;
        const v = base + k * step;
        const p = horiz ? S(x0, v) : S(v, y0);
        const q = horiz ? S(x1, v) : S(v, y1);
        if (axisAligned) {
          // 화면 화소에 맞춰 선명하게
          if (Math.abs(p.y - q.y) < 0.5) {
            p.y = q.y = Math.round(p.y) + 0.5;
          } else {
            p.x = q.x = Math.round(p.x) + 0.5;
          }
        }
        g.moveTo(p.x, p.y);
        g.lineTo(q.x, q.y);
      }
      g.stroke();
    };
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
    line(true, false);
    line(true, true);
    g.strokeStyle = dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.15)';
    line(false, false);
    line(false, true);
    g.restore();
  }

  /** UCS 아이콘 표시(UCSICON) */
  readonly ucsIcon = { on: true, origin: true };

  /** UCS 아이콘: 원점이 화면 안이면 원점에, 아니면 왼쪽 아래 */
  private drawUcsIcon(g: CanvasRenderingContext2D, s: DocState, dark: boolean): void {
    const u = currentUcs(s);
    let o = this.worldToScreen(u.ox, u.oy);
    const pad = 36;
    const ar = this.area();
    if (!this.ucsIcon.origin || o.x < ar.x + pad || o.y < ar.y + pad || o.x > ar.x + ar.w - pad || o.y > ar.y + ar.h - pad) o = { x: ar.x + 28, y: ar.y + ar.h - 28 };
    const c = Math.cos(u.angle);
    const sn = Math.sin(u.angle);
    const L = 30;
    const ax = (dx: number, dy: number) => ({ x: o.x + dx, y: o.y - dy });
    const xe = ax(L * c, L * sn);
    const ye = ax(-L * sn, L * c);
    g.save();
    g.lineWidth = 1.6;
    g.font = '10px var(--font, sans-serif)';
    g.strokeStyle = g.fillStyle = dark ? 'rgba(240,90,90,0.95)' : 'rgba(190,30,30,0.95)';
    g.beginPath();
    g.moveTo(o.x, o.y);
    g.lineTo(xe.x, xe.y);
    g.stroke();
    g.fillText('X', xe.x + 3 * c - 3, xe.y - 3 * sn + 4);
    g.strokeStyle = g.fillStyle = dark ? 'rgba(90,220,120,0.95)' : 'rgba(20,140,60,0.95)';
    g.beginPath();
    g.moveTo(o.x, o.y);
    g.lineTo(ye.x, ye.y);
    g.stroke();
    g.fillText('Y', ye.x - 3 * sn - 3, ye.y - 3 * c);
    // 표준 좌표계면 원점에 네모
    if (isWorld(u)) {
      g.strokeStyle = dark ? 'rgba(200,200,200,0.8)' : 'rgba(60,60,60,0.8)';
      g.lineWidth = 1;
      g.strokeRect(o.x - 3.5, o.y - 3.5, 7, 7);
    }
    g.restore();
  }

  private renderOverlay(): void {
    const g = this.ctx2d;
    const d = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.ovCanvas.width, this.ovCanvas.height);
    g.setTransform(d, 0, 0, d, 0, 0);
    const s = this.state;
    const o = this.overlay;
    const dark = s ? (s.isModel && !s.msVp ? isDark(this.modelBg) : true) : true;
    const W = (x: number, y: number) => this.worldToScreen(x, y);
    // 배치: 인쇄 가능 영역 점선, MSPACE의 활성 뷰포트 굵은 테두리
    let vpRect: [number, number, number, number] | null = null;
    if (s && s.onLayout) {
      this.paperCam = true;
      const lay = s.layoutFor(s.displaySpace);
      const scene = s.scenes.get(s.displaySpace);
      const m = s.msVp ? this.msInfo(s) : null;
      if (m) {
        const a = W(m.vp.center.x - m.vp.width / 2, m.vp.center.y + m.vp.height / 2);
        const b = W(m.vp.center.x + m.vp.width / 2, m.vp.center.y - m.vp.height / 2);
        g.save();
        g.strokeStyle = 'rgba(40,120,220,0.95)';
        g.lineWidth = 2.5;
        g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        g.restore();
        vpRect = [a.x, a.y, b.x - a.x, b.y - a.y];
      }
      if (lay) {
        const p: PaperInfo = paperInfo(lay, scene?.bounds ?? null);
        if (p.printable) {
          const a = W(p.printable[0], p.printable[3]);
          const b = W(p.printable[2], p.printable[1]);
          g.save();
          g.setLineDash([4, 3]);
          g.strokeStyle = 'rgba(80,80,80,0.6)';
          g.lineWidth = 1;
          g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, b.x - a.x, b.y - a.y);
          g.restore();
        }
      }
      this.paperCam = false;
    }
    const drawGeom = (geom: OverlayGeom, color: string, width: number, dash: number[] | null, fill?: string) => {
      g.save();
      if (geom.tris && fill) {
        g.fillStyle = fill;
        g.beginPath();
        const t = geom.tris;
        for (let i = 0; i + 5 < t.length; i += 6) {
          const p0 = W(t[i]!, t[i + 1]!);
          const p1 = W(t[i + 2]!, t[i + 3]!);
          const p2 = W(t[i + 4]!, t[i + 5]!);
          g.moveTo(p0.x, p0.y);
          g.lineTo(p1.x, p1.y);
          g.lineTo(p2.x, p2.y);
          g.closePath();
        }
        g.fill();
      }
      g.strokeStyle = color;
      g.lineWidth = width;
      if (dash) g.setLineDash(dash);
      g.beginPath();
      const sg = geom.segs;
      for (let i = 0; i + 3 < sg.length; i += 4) {
        const p0 = W(sg[i]!, sg[i + 1]!);
        const p1 = W(sg[i + 2]!, sg[i + 3]!);
        g.moveTo(p0.x, p0.y);
        g.lineTo(p1.x === p0.x && p1.y === p0.y ? p1.x + 0.5 : p1.x, p1.y);
      }
      g.stroke();
      g.restore();
    };
    // 타일 뷰포트: 테두리(활성은 굵게)와, 이후 그림은 활성 타일 안만
    const tiles = this.tiled();
    if (tiles) {
      g.save();
      tiles.list.forEach((t, i) => {
        if (i === tiles.active) return;
        const r = this.tileRect(t);
        g.strokeStyle = dark ? 'rgba(160,170,185,0.55)' : 'rgba(90,90,90,0.55)';
        g.lineWidth = 1;
        g.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
      });
      const ar = this.area();
      g.strokeStyle = 'rgba(40,120,220,0.95)';
      g.lineWidth = 2;
      g.strokeRect(ar.x + 1, ar.y + 1, ar.w - 2, ar.h - 2);
      g.restore();
      g.save();
      g.beginPath();
      g.rect(ar.x, ar.y, ar.w, ar.h);
      g.clip();
    }
    // 격자
    const gi = s && !s.msVp ? this.gridInfo?.() : null;
    if (gi) this.drawGrid(g, gi, dark);
    if (s && this.ucsIcon.on && !s.blockEdit) this.drawUcsIcon(g, s, dark);
    // MSPACE: 강조·선택·그립은 활성 뷰포트 안만
    if (vpRect) {
      g.save();
      g.beginPath();
      g.rect(...vpRect);
      g.clip();
    }
    if (o.hover) drawGeom(o.hover, dark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)', 2.2, null, 'rgba(120,170,255,0.25)');
    for (const sel of o.selection) drawGeom(sel, '#3d8dff', 1.6, [6, 4], 'rgba(61,141,255,0.25)');
    // 그립
    g.save();
    for (const p of o.grips) {
      const q = W(p.x, p.y);
      g.fillStyle = '#2f6fe0';
      g.strokeStyle = '#d8e6ff';
      g.lineWidth = 1;
      g.fillRect(q.x - 4, q.y - 4, 8, 8);
      g.strokeRect(q.x - 4.5, q.y - 4.5, 9, 9);
    }
    if (o.hotGrip) {
      const q = W(o.hotGrip.x, o.hotGrip.y);
      g.fillStyle = '#e8453c';
      g.fillRect(q.x - 4.5, q.y - 4.5, 9, 9);
    }
    g.restore();
    if (vpRect) g.restore();
    this.extraOverlay?.(g, W, dark);
    // 블록 편집기: 블록 기준점
    const be = s?.blockEdit ? s.doc.blocks.get(s.blockEdit.key) : null;
    if (be) {
      const q = W(be.basePoint.x, be.basePoint.y);
      g.save();
      g.strokeStyle = dark ? 'rgba(255,120,120,0.95)' : 'rgba(200,40,40,0.95)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(q.x, q.y);
      g.lineTo(q.x + 28, q.y);
      g.moveTo(q.x, q.y);
      g.lineTo(q.x, q.y - 28);
      g.stroke();
      g.fillStyle = g.strokeStyle;
      g.font = '11px var(--font, sans-serif)';
      g.fillText('기준점', q.x + 4, q.y + 13);
      g.restore();
    }
    // 추적 정렬선과 획득점
    if (o.tracks.length || o.acquired.length) {
      g.save();
      g.strokeStyle = dark ? 'rgba(90,220,140,0.9)' : 'rgba(20,140,70,0.9)';
      g.lineWidth = 1;
      g.setLineDash([3, 4]);
      // 화면 밖까지 이어지게 충분히 먼 점
      const far = (this.width + this.height) * 2 * this.pixelSize();
      for (const t of o.tracks) {
        const a = W(t.from.x, t.from.y);
        const b = W(t.from.x + t.dir.x * far, t.from.y + t.dir.y * far);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }
      g.setLineDash([]);
      for (const p of o.acquired) {
        const q = W(p.x, p.y);
        g.beginPath();
        g.moveTo(q.x - 5, q.y);
        g.lineTo(q.x + 5, q.y);
        g.moveTo(q.x, q.y - 5);
        g.lineTo(q.x, q.y + 5);
        g.stroke();
      }
      g.restore();
    }
    // 끌고 있는 객체
    for (const gh of o.ghost) drawGeom(gh, dark ? 'rgba(255,209,102,0.85)' : 'rgba(194,124,0,0.85)', 1, null, dark ? 'rgba(255,209,102,0.18)' : 'rgba(194,124,0,0.15)');
    // 고무줄·임시 형상
    for (const rb of o.rubber) {
      if (rb.pts.length < 2) continue;
      g.save();
      g.beginPath();
      const p0 = W(rb.pts[0]!, rb.pts[1]!);
      g.moveTo(p0.x, p0.y);
      for (let i = 2; i + 1 < rb.pts.length; i += 2) {
        const p = W(rb.pts[i]!, rb.pts[i + 1]!);
        g.lineTo(p.x, p.y);
      }
      if (rb.closed) g.closePath();
      if (rb.fill) {
        g.fillStyle = 'rgba(80,160,255,0.22)';
        g.fill();
      }
      g.strokeStyle = dark ? '#ffd166' : '#c27c00';
      g.lineWidth = 1.2;
      if (rb.dashed) g.setLineDash([5, 4]);
      g.stroke();
      g.restore();
    }
    for (const m of o.marks) {
      const q = W(m.p.x, m.p.y);
      g.save();
      g.strokeStyle = '#ffd166';
      g.beginPath();
      g.moveTo(q.x - 4, q.y - 4);
      g.lineTo(q.x + 4, q.y + 4);
      g.moveTo(q.x - 4, q.y + 4);
      g.lineTo(q.x + 4, q.y - 4);
      g.stroke();
      if (m.text) {
        g.font = '12px ui-monospace, Menlo, monospace';
        g.fillStyle = dark ? '#ffe6a3' : '#7a4c00';
        g.fillText(m.text, q.x + 7, q.y - 6);
      }
      g.restore();
    }
    // 선택 창
    if (o.windowRect) {
      const { a, b } = o.windowRect;
      const crossing = b.x < a.x;
      g.save();
      g.fillStyle = crossing ? 'rgba(80,200,120,0.16)' : 'rgba(70,130,255,0.16)';
      g.strokeStyle = crossing ? '#57d68d' : '#5b9bff';
      g.lineWidth = 1;
      if (crossing) g.setLineDash([5, 4]);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      g.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      g.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      g.restore();
    }
    // 스냅 표지
    if (o.snap) drawSnap(g, W(o.snap.p.x, o.snap.p.y), o.snap.kind);
    // 십자선
    if (o.cursor && o.crosshair) {
      const c = o.cursor;
      g.save();
      g.strokeStyle = dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
      g.lineWidth = 1;
      const x = Math.round(c.x) + 0.5;
      const y = Math.round(c.y) + 0.5;
      const L = Math.max(this.w, this.h) * 0.05 + 20;
      g.beginPath();
      g.moveTo(x - L, y);
      g.lineTo(x - o.pickbox, y);
      g.moveTo(x + o.pickbox, y);
      g.lineTo(x + L, y);
      g.moveTo(x, y - L);
      g.lineTo(x, y - o.pickbox);
      g.moveTo(x, y + o.pickbox);
      g.lineTo(x, y + L);
      g.stroke();
      g.strokeRect(x - o.pickbox, y - o.pickbox, o.pickbox * 2, o.pickbox * 2);
      g.restore();
    }
    if ((o.tip || o.dynInput) && o.cursor) {
      g.save();
      g.font = '11.5px ui-monospace, Menlo, monospace';
      const tip = o.tip ?? '';
      const typed = o.dynInput ? `${o.dynInput}▏` : '';
      const tw = Math.max(tip ? g.measureText(tip).width : 0, typed ? g.measureText(typed).width + 8 : 0);
      const hgt = (tip ? 20 : 0) + (typed ? 22 : 0);
      const x = Math.min(o.cursor.x + 18, this.w - tw - 14);
      const y = Math.min(o.cursor.y + 22, this.h - hgt - 4);
      if (tip) {
        g.fillStyle = 'rgba(37,44,54,0.95)';
        g.strokeStyle = '#5b6a7e';
        g.fillRect(x, y, tw + 12, 20);
        g.strokeRect(x + 0.5, y + 0.5, tw + 11, 19);
        g.fillStyle = '#e8ebf0';
        g.fillText(tip, x + 6, y + 14);
      }
      if (typed) {
        // 입력 칸(동적 입력)
        const yy = y + (tip ? 22 : 0);
        g.fillStyle = 'rgba(20,24,30,0.96)';
        g.strokeStyle = '#4c9bff';
        g.fillRect(x, yy, tw + 12, 20);
        g.strokeRect(x + 0.5, yy + 0.5, tw + 11, 19);
        g.fillStyle = '#ffffff';
        g.fillText(typed, x + 6, yy + 14);
      }
      g.restore();
    }
    if (tiles) g.restore();
  }

  // -------------------------------------------------------------------------
  // 입력
  // -------------------------------------------------------------------------

  private local(ev: { clientX: number; clientY: number }): Pt {
    const r = this.el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private bindInput(): void {
    const el = this.el;
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const p = this.local(ev);
      this.events?.context(this.screenToWorld(p.x, p.y), p, ev);
    });
    el.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        if (!this.state) return;
        const p = this.local(ev);
        let dy = ev.deltaY;
        if (ev.deltaMode === 1) dy *= 32;
        else if (ev.deltaMode === 2) dy *= 300;
        // 트랙패드 핀치(ctrlKey)는 세밀하게, 마우스 휠은 한 칸에 1.25배
        const f = ev.ctrlKey ? Math.exp(-dy * 0.01) : Math.exp(-dy * 0.0022);
        // 타일 뷰포트: 커서 아래 타일을 활성으로
        const ti = this.tileAt(p);
        if (ti >= 0) this.activateTile(ti);
        this.zoomAt(p.x, p.y, f);
      },
      { passive: false },
    );
    el.addEventListener('pointerdown', (ev) => {
      if (!this.state) return;
      const p = this.local(ev);
      if (ev.pointerType === 'touch') {
        this.touches.set(ev.pointerId, p);
        el.setPointerCapture(ev.pointerId);
        if (this.touches.size === 2) {
          this.leftDown = null;
          this.startPinch();
        } else if (this.touches.size === 1) {
          this.leftDown = { x: p.x, y: p.y, dragging: false };
        }
        return;
      }
      // 타일 뷰포트: 다른 타일을 누르면 그 타일을 활성으로만(왼쪽 클릭은 고르기 없이 끝)
      const ti = this.tileAt(p);
      const tl = this.tiled();
      if (tl && this.tilePick && ev.button === 0) {
        this.tilePick(ti);
        return;
      }
      if (tl && ti >= 0 && ti !== tl.active) {
        this.activateTile(ti);
        this.el.classList.add('cursor-none');
        if (ev.button === 0 && !ev.altKey && !this.spaceHeld) return;
      }
      if (ev.button === 1 || (ev.button === 0 && ev.altKey) || (ev.button === 0 && this.spaceHeld)) {
        ev.preventDefault();
        const now = performance.now();
        if (ev.button === 1 && now - this.lastMiddle < 350) {
          this.zoomExtents();
          this.lastMiddle = 0;
          return;
        }
        if (ev.button === 1) this.lastMiddle = now;
        this.panning = { x: p.x, y: p.y, cam: { ...this.camera() } };
        el.setPointerCapture(ev.pointerId);
        el.classList.add('cursor-grab');
        return;
      }
      if (ev.button === 0) {
        this.leftDown = { x: p.x, y: p.y, dragging: false };
        el.setPointerCapture(ev.pointerId);
        this.events?.down(this.screenToWorld(p.x, p.y), p, ev);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (!this.state) return;
      const p = this.local(ev);
      if (ev.pointerType === 'touch') {
        if (this.touches.has(ev.pointerId)) this.touches.set(ev.pointerId, p);
        if (this.pinch && this.touches.size >= 2) {
          this.movePinch();
          return;
        }
        if (this.leftDown && this.touches.size === 1) {
          const dx = p.x - this.leftDown.x;
          const dy = p.y - this.leftDown.y;
          if (this.leftDown.dragging || Math.hypot(dx, dy) > 8) {
            // 한 손가락 끌기 = 화면 이동
            if (!this.leftDown.dragging) this.panning = { x: this.leftDown.x, y: this.leftDown.y, cam: { ...this.camera() } };
            this.leftDown.dragging = true;
          }
        }
      }
      if (this.panning) {
        const c = this.panning.cam;
        this.setCamera({ cx: c.cx - (p.x - this.panning.x) / c.scale, cy: c.cy + (p.y - this.panning.y) / c.scale, scale: c.scale }, false);
        return;
      }
      // 타일 뷰포트: 활성이 아닌 타일 위에서는 보통 화살표 커서
      const tl = this.tiled();
      if (tl) this.el.classList.toggle('cursor-none', this.tileAt(p) === tl.active);
      const world = this.screenToWorld(p.x, p.y);
      if (this.leftDown && ev.pointerType !== 'touch') {
        const dx = p.x - this.leftDown.x;
        const dy = p.y - this.leftDown.y;
        if (!this.leftDown.dragging && Math.hypot(dx, dy) > 5) this.leftDown.dragging = true;
        if (this.leftDown.dragging) {
          this.events?.drag(this.leftDown, p, false, ev);
        }
      }
      this.events?.move(world, p, ev);
    });
    const up = (ev: PointerEvent) => {
      const p = this.local(ev);
      if (ev.pointerType === 'touch') {
        this.touches.delete(ev.pointerId);
        if (this.touches.size < 2) this.pinch = null;
        if (this.panning && this.touches.size === 0) {
          this.panning = null;
          this.leftDown = null;
          this.events?.viewChanged();
          return;
        }
        if (this.leftDown && !this.leftDown.dragging && this.touches.size === 0) {
          this.leftDown = null;
          this.events?.click(this.screenToWorld(p.x, p.y), p, ev);
        }
        if (this.touches.size === 0) this.leftDown = null;
        return;
      }
      if (this.panning) {
        this.panning = null;
        this.el.classList.remove('cursor-grab');
        this.events?.viewChanged();
        return;
      }
      if (this.leftDown && ev.button === 0) {
        const ld = this.leftDown;
        this.leftDown = null;
        if (ld.dragging) this.events?.drag(ld, p, true, ev);
        else this.events?.click(this.screenToWorld(p.x, p.y), p, ev);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('dblclick', (ev) => {
      const p = this.local(ev);
      const tl = this.tiled();
      if (tl && this.tileAt(p) !== tl.active) return;
      this.events?.dblclick(this.screenToWorld(p.x, p.y), p, ev);
    });
    el.addEventListener('pointerleave', () => {
      this.overlay.cursor = null;
      this.events?.leave();
      this.requestOverlay();
    });
    el.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) ev.preventDefault();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.code === 'Space' && !isTyping(ev)) this.spaceHeld = true;
    });
    window.addEventListener('keyup', (ev) => {
      if (ev.code === 'Space') this.spaceHeld = false;
    });
  }

  private spaceHeld = false;

  private startPinch(): void {
    const [a, b] = [...this.touches.values()] as [Pt, Pt];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid, cam: { ...this.camera() }, world: this.screenToWorld(mid.x, mid.y) };
    this.panning = null;
  }

  private movePinch(): void {
    const pz = this.pinch!;
    const [a, b] = [...this.touches.values()] as [Pt, Pt];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const scale = clampScale(pz.cam.scale * (d / pz.d));
    const ar = this.area();
    const cx = pz.world.x - (mid.x - ar.x - ar.w / 2) / scale;
    const cy = pz.world.y + (mid.y - ar.y - ar.h / 2) / scale;
    this.setCamera({ cx, cy, scale }, false);
  }
}

function clampScale(s: number): number {
  return Math.min(Math.max(s, 1e-12), 1e12);
}

export function isDark(rgb: number): boolean {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  return r * 0.299 + g * 0.587 + b * 0.114 < 128;
}

function isTyping(ev: KeyboardEvent): boolean {
  const t = ev.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export function emptyOverlay(): OverlayState {
  return { cursor: null, crosshair: true, pickbox: 5, windowRect: null, selection: [], hover: null, grips: [], snap: null, rubber: [], ghost: [], tracks: [], acquired: [], hotGrip: null, dynInput: null, marks: [], tip: null };
}

/** AutoCAD 스냅 표지 모양 */
function drawSnap(g: CanvasRenderingContext2D, p: Pt, kind: SnapKind): void {
  const r = 6;
  g.save();
  g.strokeStyle = '#2fd16b';
  g.lineWidth = 2;
  g.beginPath();
  switch (kind) {
    case 'end':
      g.rect(p.x - r, p.y - r, r * 2, r * 2);
      break;
    case 'mid':
      g.moveTo(p.x, p.y - r);
      g.lineTo(p.x + r, p.y + r * 0.8);
      g.lineTo(p.x - r, p.y + r * 0.8);
      g.closePath();
      break;
    case 'cen':
    case 'gcen':
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      break;
    case 'qua':
      g.moveTo(p.x, p.y - r);
      g.lineTo(p.x + r, p.y);
      g.lineTo(p.x, p.y + r);
      g.lineTo(p.x - r, p.y);
      g.closePath();
      break;
    case 'int':
      g.moveTo(p.x - r, p.y - r);
      g.lineTo(p.x + r, p.y + r);
      g.moveTo(p.x - r, p.y + r);
      g.lineTo(p.x + r, p.y - r);
      break;
    case 'nea':
      g.moveTo(p.x - r, p.y - r);
      g.lineTo(p.x + r, p.y - r);
      g.lineTo(p.x - r, p.y + r);
      g.lineTo(p.x + r, p.y + r);
      g.closePath();
      break;
    case 'ins':
      g.moveTo(p.x - r, p.y - r);
      g.lineTo(p.x, p.y - r);
      g.lineTo(p.x, p.y);
      g.lineTo(p.x + r, p.y);
      g.lineTo(p.x + r, p.y + r);
      g.lineTo(p.x - r, p.y + r);
      g.closePath();
      break;
    case 'nod':
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.moveTo(p.x - r, p.y - r);
      g.lineTo(p.x + r, p.y + r);
      g.moveTo(p.x - r, p.y + r);
      g.lineTo(p.x + r, p.y - r);
      break;
    case 'per':
      g.moveTo(p.x - r, p.y - r);
      g.lineTo(p.x - r, p.y + r);
      g.lineTo(p.x + r, p.y + r);
      g.moveTo(p.x - r, p.y);
      g.lineTo(p.x, p.y);
      g.lineTo(p.x, p.y + r);
      break;
    case 'tan':
      g.arc(p.x, p.y, r * 0.8, 0, Math.PI * 2);
      g.moveTo(p.x - r, p.y - r);
      g.lineTo(p.x + r, p.y - r);
      break;
    default:
      g.rect(p.x - r, p.y - r, r * 2, r * 2);
  }
  g.stroke();
  g.restore();
}

export { tableKey };
