/**
 * 3D 뷰어(WebGL2): 형식 해석기가 만든 Scene3d를 그리고, 궤도·이동·확대, 표준 뷰, 고르기, 측정을 한다.
 *
 * 조작
 * - 마우스: 왼쪽 끌기 = 궤도 회전(커서 아래 점 둘레), 가운데·오른쪽 끌기 = 이동, Shift+가운데 끌기 = 회전,
 *   휠 = 커서 쪽으로 확대·축소, 가운데 두 번 누르기 = 전체 보기, 왼쪽 누르기 = 고르기(측정 모드면 점 찍기)
 * - 터치: 한 손가락 = 회전, 두 손가락 = 이동·핀치 확대
 * - 키(캔버스에 초점이 있을 때): F = 전체 보기, 1 앞 2 뒤 3 왼쪽 4 오른쪽 5 위 6 아래 7 남동 등각, Esc = 측정 지우기
 * - 오른쪽 위 뷰 큐브: 면·모서리·구석을 누르면 그 방향 표준 뷰, 끌면 회전
 *
 * 프레임은 상태가 바뀔 때만 requestAnimationFrame 한 번으로 그린다.
 */
import type { Box3, LineSet3d, Mesh3d, Pick3d, PointSet3d, Rgba, Scene3d } from './types';
import { boxIsEmpty, boxSphere, emptyBox, expandPoint, meshBounds, positionsBox, sceneBounds, unionBox } from './bounds';
import { type Bvh, type PrimKind, buildBvh, rayBoxEntry, safeInv } from './bvh';
import {
  type CameraState,
  type Projection,
  type ViewFrame,
  type ViewName,
  VIEW_DIRS,
  cameraBasis,
  computeFrame,
  defaultCamera,
  dirToAngles,
  fitCamera,
  lerpCamera,
  orbitCamera,
  panCamera,
  projectToScreen,
  rayAtDepth,
  screenRay,
  viewDepth,
  zoomCamera,
} from './camera';
import { type GridSpec, type GridZ, gridLines, gridSpec } from './grid';
import { MARKER_HEIGHT, type MarkerKind } from './marker';
import { type V3, dot, length, placeMatrix, sub } from './math';
import { chooseNearest, pickMeshRay, pickPointSet, pickSegments, snapToNearest } from './pick';
import { countIdsUpTo } from './playback';
import { type DrawRange, type RenderColors, type RenderMode, type RenderStats, Renderer3d } from './renderer';
import { DARK_THEME, LIGHT_THEME, THEME_CSS_VARS, type Viewer3dTheme, parseColor } from './theme';
import { cubeHit, cubeLayout, drawViewCube } from './viewcube';

export interface Viewer3dOptions {
  /** 'dark'(기본) | 'light' | 일부 색. 호스트의 CSS 변수(--v3d-*)가 있으면 그것이 이긴다 */
  theme?: 'dark' | 'light' | (Partial<Viewer3dTheme> & { base?: 'dark' | 'light' });
  /** 바닥 격자(기본 true) */
  grid?: boolean;
  /** 격자 높이(기본 'min' = 범위 바닥) */
  gridZ?: GridZ;
  /** 오른쪽 위 뷰 큐브(기본 true) */
  viewCube?: boolean;
  /** 왼쪽 아래 좌표축(기본 true) */
  axes?: boolean;
  /** 키 입력(기본 true, 캔버스에 초점이 있을 때만) */
  keyboard?: boolean;
  projection?: Projection;
  renderMode?: RenderMode;
  /** 표준 뷰·전체 보기를 부드럽게(기본 true) */
  animate?: boolean;
  /** 고르기 허용 거리(화면 화소, 기본 6) */
  pickTolerance?: number;
  /** 장치 화소 비율 상한(기본 2) */
  maxPixelRatio?: number;
}

export interface MeasureResult {
  a: V3;
  b: V3;
  distance: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface GroupInfo {
  name: string;
  visible: boolean;
  /** 이 묶음에 든 그물·선분 묶음·점 묶음 수 */
  count: number;
}

export interface MarkerOptions {
  /** 공구 축(끝 → 자루), 기본 +Z */
  axis?: readonly number[];
  /** 실제 공구 반지름(세계 단위). 없으면 화면에서 sizePx 높이로 일정하게 */
  radius?: number;
  /** 화면 높이(화소, 기본 44) */
  sizePx?: number;
  color?: Rgba;
}

export type Viewer3dStats = RenderStats & { frameMs: number; width: number; height: number; dpr: number };

type Item = { kind: 'mesh'; item: Mesh3d } | { kind: 'line'; item: LineSet3d } | { kind: 'point'; item: PointSet3d };

interface PickDetail {
  pick: Pick3d;
  /** 측정용 붙잡은 점(꼭짓점·끝점 가까우면 그 점) */
  snap: V3;
  vertex: boolean;
}

interface Drag {
  mode: 'orbit' | 'pan' | 'touch';
  button: number;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  moved: boolean;
  pivot: V3 | null;
  depth: number | null;
}

const FONT = "'Pretendard', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', system-ui, sans-serif";
const ROT_PER_PX = 0.0085;
const DRAG_START_PX = 4;
const CUBE_CSS = 112;
const KEY_VIEWS: Record<string, ViewName> = { '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '7': 'seIso' };
const UNIT_LABEL: Record<Scene3d['units'], string> = { mm: 'mm', inch: 'in', m: 'm', unknown: '' };

export class Viewer3d {
  readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private wrap: HTMLDivElement;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private cube: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  private gl: WebGL2RenderingContext;
  private renderer: Renderer3d;
  private opts: Required<Omit<Viewer3dOptions, 'theme' | 'projection' | 'renderMode'>>;
  private themeOpt: Viewer3dOptions['theme'];
  private theme: Viewer3dTheme = DARK_THEME;
  private colors!: RenderColors;

  private sceneRef: Scene3d | null = null;
  private items = new Map<string, Item>();
  private hiddenGroups = new Set<string>();
  private hiddenItems = new Set<string>();
  private hi = new Set<string>();
  private ranges = new Map<string, DrawRange>();
  private marker: { pos: V3; kind: MarkerKind; opts: MarkerOptions } | null = null;
  private mode: RenderMode;
  private cam: CameraState;
  private anim: { from: CameraState; to: CameraState; t0: number; dur: number } | null = null;
  private allBox: Box3 = emptyBox();
  private visBox: Box3 | null = null;
  private grid: GridSpec | null = null;
  private gridOn: boolean;
  private bvhs = new WeakMap<Float32Array, Map<Uint32Array | PrimKind, Bvh>>();
  private bvhGen = 0;
  private bvhTimer = 0;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private raf = 0;
  private lost = false;
  private disposed = false;
  private interacting = false;
  private wheelTimer = 0;
  private frameMs = 0;
  /** 크기를 아직 모를 때 올린 장면은 크기가 정해지면 다시 맞춘다 */
  private sizeKnown = false;
  private pendingFit = false;
  private wheelAnchor: { x: number; y: number; t: number; p: V3 } | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag | null = null;
  private touch: { dist: number; cx: number; cy: number } | null = null;
  private lastMiddle = { t: 0, x: 0, y: 0 };
  private cubeHover: V3 | null = null;
  private cubeDrag: { sx: number; sy: number; lx: number; ly: number; moved: boolean } | null = null;

  private measuring = false;
  private measurePts: V3[] = [];
  private measureHover: { p: V3; vertex: boolean } | null = null;
  private hoverAt: { x: number; y: number } | null = null;

  private pickCbs = new Set<(p: Pick3d | null) => void>();
  private measureCbs = new Set<(m: MeasureResult | null) => void>();
  private camCbs = new Set<(c: CameraState) => void>();
  private lastCamKey = '';

  private ro: ResizeObserver;
  private mql: MediaQueryList | null = null;
  private hostPos: string | null = null;
  private off: (() => void)[] = [];

  constructor(host: HTMLElement, opts: Viewer3dOptions = {}) {
    this.host = host;
    this.opts = {
      grid: opts.grid ?? true,
      gridZ: opts.gridZ ?? 'min',
      viewCube: opts.viewCube ?? true,
      axes: opts.axes ?? true,
      keyboard: opts.keyboard ?? true,
      animate: opts.animate ?? true,
      pickTolerance: opts.pickTolerance ?? 6,
      maxPixelRatio: opts.maxPixelRatio ?? 2,
    };
    this.themeOpt = opts.theme;
    this.gridOn = this.opts.grid;
    this.mode = opts.renderMode ?? 'shadedEdges';
    this.cam = { ...defaultCamera(), projection: opts.projection ?? 'perspective' };

    if (getComputedStyle(host).position === 'static') {
      this.hostPos = host.style.position;
      host.style.position = 'relative';
    }
    const wrap = document.createElement('div');
    wrap.className = 'v3d';
    wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;user-select:none;-webkit-user-select:none;';
    const canvas = document.createElement('canvas');
    canvas.className = 'v3d-gl';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '3D 보기');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;';
    const overlay = document.createElement('canvas');
    overlay.className = 'v3d-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    const cube = document.createElement('canvas');
    cube.className = 'v3d-cube';
    cube.title = '뷰 큐브: 면·모서리·구석을 누르면 그 방향으로 봅니다';
    cube.style.cssText = `position:absolute;top:8px;right:8px;width:${CUBE_CSS}px;height:${CUBE_CSS}px;cursor:pointer;touch-action:none;`;
    if (!this.opts.viewCube) cube.style.display = 'none';
    wrap.append(canvas, overlay, cube);
    host.append(wrap);
    this.wrap = wrap;
    this.canvas = canvas;
    this.overlay = overlay;
    this.cube = cube;
    this.octx = overlay.getContext('2d')!;
    this.cctx = cube.getContext('2d')!;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) {
      wrap.remove();
      throw new Error('이 브라우저는 WebGL2를 지원하지 않아 3D 보기를 열 수 없습니다');
    }
    this.gl = gl;
    this.renderer = new Renderer3d(gl);
    this.applyTheme();

    const r = host.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.sizeKnown = r.width > 0 && r.height > 0;
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width, h = e.contentRect.height;
        if (w > 0 && h > 0 && (w !== this.cssW || h !== this.cssH)) {
          this.cssW = w;
          this.cssH = h;
          this.sizeKnown = true;
          if (this.pendingFit) {
            this.pendingFit = false;
            this.fit(false);
          }
          this.invalidate();
        }
      }
    });
    this.ro.observe(wrap);
    this.watchDpr();
    this.bindInput();
    this.invalidate();
  }

  // ───────────────────────── 장면 ─────────────────────────

  get scene(): Scene3d | null {
    return this.sceneRef;
  }

  /** 장면 바꾸기. keepView면 카메라를 그대로 둔다(아니면 남동 등각 + 전체 보기) */
  setScene(scene: Scene3d, opts: { keepView?: boolean } = {}): void {
    this.sceneRef = scene;
    this.items.clear();
    for (const m of scene.meshes) this.items.set(m.id, { kind: 'mesh', item: m });
    for (const l of scene.lines) this.items.set(l.id, { kind: 'line', item: l });
    for (const p of scene.points ?? []) this.items.set(p.id, { kind: 'point', item: p });
    this.hiddenGroups.clear();
    this.hiddenItems.clear();
    this.hi.clear();
    this.ranges.clear();
    this.measurePts = [];
    this.measureHover = null;
    this.bvhs = new WeakMap();
    this.wheelAnchor = null;
    if (!this.lost) this.renderer.setScene(scene);
    this.allBox = scene.bounds && !boxIsEmpty(scene.bounds) ? scene.bounds : sceneBounds(scene);
    this.visBox = null;
    this.rebuildGrid();
    if (!opts.keepView) {
      const a = dirToAngles(VIEW_DIRS.seIso);
      this.anim = null;
      this.cam = fitCamera({ ...this.cam, yaw: a.yaw, pitch: a.pitch }, this.visibleBox(), this.cssW / this.cssH);
      this.pendingFit = !this.sizeKnown;
    }
    this.scheduleBvh();
    this.invalidate();
  }

  /** 장면 비우기 */
  clear(): void {
    this.sceneRef = null;
    this.items.clear();
    this.hi.clear();
    this.ranges.clear();
    this.measurePts = [];
    this.measureHover = null;
    this.marker = null;
    this.bvhs = new WeakMap();
    this.wheelAnchor = null;
    this.bvhGen++;
    if (!this.lost) this.renderer.clear();
    this.allBox = emptyBox();
    this.visBox = null;
    this.rebuildGrid();
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    clearTimeout(this.bvhTimer);
    clearTimeout(this.wheelTimer);
    this.bvhGen++;
    for (const f of this.off) f();
    this.off = [];
    this.ro.disconnect();
    this.pickCbs.clear();
    this.measureCbs.clear();
    this.camCbs.clear();
    if (!this.lost) this.renderer.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.wrap.remove();
    if (this.hostPos !== null) this.host.style.position = this.hostPos;
  }

  // ───────────────────────── 보기 ─────────────────────────

  getCamera(): CameraState {
    return { ...this.cam, target: [...this.cam.target] as V3 };
  }

  setCamera(c: CameraState): void {
    this.anim = null;
    this.wheelAnchor = null;
    this.cam = { ...c, target: [...c.target] as V3 };
    this.invalidate();
  }

  /** 보이는 것 전체 보기 */
  fit(animate = this.opts.animate): void {
    this.goto(fitCamera(this.cam, this.visibleBox(), this.cssW / this.cssH), animate);
  }

  /** 표준 뷰(위·아래·앞·뒤·왼쪽·오른쪽·남서/남동/북동/북서 등각)로 돌리고 전체 보기 */
  setView(name: ViewName, animate = this.opts.animate): void {
    this.setViewDir(VIEW_DIRS[name], animate);
  }

  /** 눈 방향(대상 → 눈)으로 돌리고 전체 보기 */
  setViewDir(dir: readonly number[], animate = this.opts.animate): void {
    const a = dirToAngles(dir, 0);
    this.goto(fitCamera({ ...this.cam, yaw: a.yaw, pitch: a.pitch }, this.visibleBox(), this.cssW / this.cssH), animate);
  }

  setProjection(p: Projection): void {
    if (this.cam.projection === p) return;
    this.finishAnim();
    this.cam = { ...this.cam, projection: p };
    this.invalidate();
  }

  getProjection(): Projection {
    return this.cam.projection;
  }

  setRenderMode(m: RenderMode): void {
    this.mode = m;
    this.invalidate();
  }

  getRenderMode(): RenderMode {
    return this.mode;
  }

  /** 대상점 둘레 회전(라디안) */
  orbitBy(dYaw: number, dPitch: number): void {
    this.finishAnim();
    this.wheelAnchor = null;
    this.cam = orbitCamera(this.cam, dYaw, dPitch);
    this.invalidate();
  }

  /** 대상점 쪽 확대·축소(factor < 1 이면 확대) */
  zoomBy(factor: number): void {
    this.finishAnim();
    this.cam = zoomCamera(this.cam, factor, this.cam.target, this.zoomLimits());
    this.invalidate();
  }

  setGridVisible(on: boolean): void {
    this.gridOn = on;
    this.invalidate();
  }

  setGridZ(z: GridZ): void {
    this.opts.gridZ = z;
    this.rebuildGrid();
    this.invalidate();
  }

  setViewCubeVisible(on: boolean): void {
    this.opts.viewCube = on;
    this.cube.style.display = on ? '' : 'none';
    this.invalidate();
  }

  setAxesVisible(on: boolean): void {
    this.opts.axes = on;
    this.invalidate();
  }

  /** 테마 바꾸기(인자 없이 부르면 CSS 변수만 다시 읽는다) */
  setTheme(theme?: Viewer3dOptions['theme']): void {
    if (theme !== undefined) this.themeOpt = theme;
    this.applyTheme();
    this.invalidate();
  }

  // ───────────────────────── 묶음·강조·범위 ─────────────────────────

  /** 묶음(group) 목록 — 처음 나온 순서 */
  groups(): GroupInfo[] {
    const out = new Map<string, GroupInfo>();
    for (const it of this.items.values()) {
      const g = it.item.group;
      if (g === undefined) continue;
      const e = out.get(g);
      if (e) e.count++;
      else out.set(g, { name: g, visible: !this.hiddenGroups.has(g), count: 1 });
    }
    return [...out.values()];
  }

  setGroupVisible(group: string, on: boolean): void {
    if (on) this.hiddenGroups.delete(group);
    else this.hiddenGroups.add(group);
    this.visBox = null;
    this.invalidate();
  }

  /** 항목 하나 켜고 끄기(id) */
  setItemVisible(id: string, on: boolean): void {
    if (on) this.hiddenItems.delete(id);
    else this.hiddenItems.add(id);
    this.visBox = null;
    this.invalidate();
  }

  isVisible(id: string): boolean {
    const it = this.items.get(id);
    return !!it && this.visible(id, it.item.group);
  }

  /** 강조할 항목 id(null이면 해제) */
  highlight(ids: readonly string[] | null): void {
    this.hi = new Set(ids ?? []);
    this.invalidate();
  }

  /**
   * 선분 묶음의 앞에서 count개만 그린다(NC 재생). null이면 전부.
   * ghost(0~1)를 주면 나머지를 그 불투명도로 흐리게 그린다.
   */
  setLineDrawRange(id: string, count: number | null, opts: { ghost?: number } = {}): void {
    if (count === null) this.ranges.delete(id);
    else this.ranges.set(id, { count: Math.max(0, Math.floor(count)), ghost: opts.ghost ?? 0 });
    this.invalidate();
  }

  /**
   * NC 재생: segmentIds가 있는 모든 선분 묶음에서 원본 번호가 limitId 이하인 앞쪽 선분만 그린다
   * (급속·공구별로 나뉜 묶음을 이동 번호 하나로 함께 돌린다. segmentIds는 오름차순이라고 본다).
   * null이면 모두 그린다. 돌려주는 값은 지금 공구 위치(그려진 선분 가운데 번호가 가장 큰 것의 끝점).
   */
  setDrawLimitBySegmentId(limitId: number | null, opts: { ghost?: number } = {}): V3 | null {
    let best: { id: number; p: V3 } | null = null;
    for (const it of this.items.values()) {
      if (it.kind !== 'line' || !it.item.segmentIds) continue;
      const l = it.item;
      if (limitId === null) {
        this.ranges.delete(l.id);
        continue;
      }
      const ids = l.segmentIds!;
      const n = countIdsUpTo(ids, Math.floor(l.positions.length / 6), limitId);
      this.ranges.set(l.id, { count: n, ghost: opts.ghost ?? 0 });
      if (n > 0 && (!best || ids[n - 1]! > best.id)) {
        const o = (n - 1) * 6 + 3;
        best = { id: ids[n - 1]!, p: [l.positions[o]!, l.positions[o + 1]!, l.positions[o + 2]!] };
      }
    }
    this.invalidate();
    return best ? best.p : null;
  }

  /** 공구 위치 표시(null이면 지움). kind: 'cone'(기본)·'cylinder'·'ball' */
  setMarker(pos: readonly number[] | null, kind: MarkerKind = 'cone', opts: MarkerOptions = {}): void {
    this.marker = pos ? { pos: [pos[0]!, pos[1]!, pos[2]!], kind, opts } : null;
    this.invalidate();
  }

  // ───────────────────────── 고르기·측정 ─────────────────────────

  /** 고르기 알림(빈 곳을 누르면 null). 돌려준 함수로 끊는다 */
  onPick(cb: (p: Pick3d | null) => void): () => void {
    this.pickCbs.add(cb);
    return () => this.pickCbs.delete(cb);
  }

  /** 측정 알림(두 번째 점을 찍을 때 결과, 지우면 null) */
  onMeasure(cb: (m: MeasureResult | null) => void): () => void {
    this.measureCbs.add(cb);
    return () => this.measureCbs.delete(cb);
  }

  /** 카메라가 바뀐 프레임마다 알림 */
  onCameraChange(cb: (c: CameraState) => void): () => void {
    this.camCbs.add(cb);
    return () => this.camCbs.delete(cb);
  }

  /** 화면 점(캔버스 기준 CSS 화소)에서 고르기 */
  pick(x: number, y: number): Pick3d | null {
    return this.pickDetail(x, y)?.pick ?? null;
  }

  /** 측정 모드(두 점 거리·dx dy dz). 끄면 측정도 지운다 */
  setMeasureMode(on: boolean): void {
    this.measuring = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    if (!on) this.clearMeasure();
    this.invalidate();
  }

  get measureMode(): boolean {
    return this.measuring;
  }

  clearMeasure(): void {
    const had = this.measurePts.length > 0;
    this.measurePts = [];
    this.measureHover = null;
    if (had) for (const cb of this.measureCbs) cb(null);
    this.invalidate();
  }

  /** 지금 측정 결과(두 점이 있을 때) */
  measurement(): MeasureResult | null {
    const [a, b] = this.measurePts;
    if (!a || !b) return null;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    return { a, b, distance: Math.hypot(dx, dy, dz), dx, dy, dz };
  }

  // ───────────────────────── 출력 ─────────────────────────

  /** 지금 화면(덧그림 포함, 뷰 큐브 제외)을 그림 파일로 */
  toBlob(type = 'image/png', quality?: number): Promise<Blob> {
    this.renderNow();
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.canvas, 0, 0);
    ctx.drawImage(this.overlay, 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했습니다'))), type, quality));
  }

  /** 기다리지 않고 바로 그린다 */
  renderNow(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.draw(performance.now());
  }

  get stats(): Viewer3dStats {
    return { ...this.renderer.stats, frameMs: this.frameMs, width: this.canvas.width, height: this.canvas.height, dpr: this.dpr };
  }

  // ───────────────────────── 내부: 상태 ─────────────────────────

  private visible(id: string, group: string | undefined): boolean {
    return !this.hiddenItems.has(id) && (group === undefined || !this.hiddenGroups.has(group));
  }

  private visibleBox(): Box3 {
    if (this.visBox) return this.visBox;
    const s = this.sceneRef;
    if (!s) return (this.visBox = emptyBox());
    if (!this.hiddenGroups.size && !this.hiddenItems.size) return (this.visBox = this.allBox);
    const b = sceneBounds(s, (it) => this.visible(it.id, it.group));
    return (this.visBox = boxIsEmpty(b) ? this.allBox : b);
  }

  private rebuildGrid(): void {
    this.grid = gridSpec(this.allBox, this.opts.gridZ);
    if (!this.lost) this.renderer.setGrid(gridLines(this.grid));
  }

  private zoomLimits(): { min: number; max: number } {
    const r = boxSphere(this.visibleBox()).radius;
    return { min: Math.max(r * 1e-6, 1e-9), max: r * 1e4 };
  }

  private goto(c: CameraState, animate: boolean): void {
    this.wheelAnchor = null;
    if (animate) {
      this.anim = { from: this.getCamera(), to: c, t0: performance.now(), dur: 320 };
    } else {
      this.anim = null;
      this.cam = c;
    }
    this.invalidate();
  }

  private finishAnim(): void {
    if (!this.anim) return;
    this.cam = this.anim.to;
    this.anim = null;
  }

  private applyTheme(): void {
    const t = this.themeOpt;
    const base = t === 'light' || (typeof t === 'object' && t.base === 'light') ? LIGHT_THEME : DARK_THEME;
    const theme: Viewer3dTheme = { ...base, ...(typeof t === 'object' ? t : {}) };
    delete (theme as { base?: unknown }).base;
    const cs = getComputedStyle(this.host);
    for (const k of Object.keys(THEME_CSS_VARS) as (keyof Viewer3dTheme)[]) {
      const v = cs.getPropertyValue(THEME_CSS_VARS[k]).trim();
      if (v) theme[k] = v;
    }
    this.theme = theme;
    const c = (s: string): Rgba => this.rgba(s);
    const line: Rgba = base === LIGHT_THEME ? [0.15, 0.2, 0.28, 1] : [0.85, 0.88, 0.92, 1];
    this.colors = {
      background: c(theme.background),
      edge: c(theme.edge),
      line,
      point: c(theme.measure),
      grid: c(theme.grid),
      gridMinor: c(theme.gridMinor),
      axisX: c(theme.axisX),
      axisY: c(theme.axisY),
      highlight: c(theme.highlight),
    };
  }

  /** CSS 색 → RGBA. 직접 못 읽으면 2D 캔버스로 정규화해서 읽는다 */
  private rgba(s: string): Rgba {
    const p = parseColor(s);
    if (p) return p;
    const ctx = this.octx;
    ctx.fillStyle = '#000';
    ctx.fillStyle = s;
    return parseColor(String(ctx.fillStyle)) ?? [0, 0, 0, 1];
  }

  private watchDpr(): void {
    const listen = (): void => {
      this.mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const on = (): void => {
        this.mql?.removeEventListener('change', on);
        if (this.disposed) return;
        listen();
        this.invalidate();
      };
      this.mql.addEventListener('change', on);
      this.off.push(() => this.mql?.removeEventListener('change', on));
    };
    listen();
  }

  // ───────────────────────── 내부: 고르기 ─────────────────────────

  private bvhFor(kind: PrimKind, positions: Float32Array, indices: Uint32Array | undefined, build: boolean): Bvh | null {
    let m = this.bvhs.get(positions);
    if (!m) {
      m = new Map();
      this.bvhs.set(positions, m);
    }
    const key = indices ?? kind;
    let b = m.get(key);
    if (b || !build) return b ?? null;
    b = buildBvh(kind, positions, indices);
    m.set(key, b);
    return b;
  }

  /** 장면을 올린 뒤 쉬는 틈에 BVH를 미리 만든다(작은 것부터, 한 틈에 약 10 ms씩) */
  private scheduleBvh(): void {
    clearTimeout(this.bvhTimer);
    const gen = ++this.bvhGen;
    const s = this.sceneRef;
    if (!s) return;
    const tasks: { n: number; run: () => void }[] = [];
    for (const m of s.meshes) tasks.push({ n: m.indices?.length ?? m.positions.length, run: () => this.bvhFor('triangle', m.positions, m.indices, true) });
    for (const l of s.lines) tasks.push({ n: l.positions.length, run: () => this.bvhFor('segment', l.positions, undefined, true) });
    for (const p of s.points ?? []) tasks.push({ n: p.positions.length, run: () => this.bvhFor('point', p.positions, undefined, true) });
    tasks.sort((a, b) => a.n - b.n);
    const step = (): void => {
      if (gen !== this.bvhGen || this.disposed) return;
      // 끄는 중이면 미룬다
      if (this.drag || this.interacting) {
        this.bvhTimer = window.setTimeout(step, 120);
        return;
      }
      // 한 틈에 약 10 ms어치(작은 것은 여러 개, 큰 것은 하나)
      const t0 = performance.now();
      while (tasks.length && performance.now() - t0 < 10) tasks.shift()!.run();
      if (tasks.length) this.bvhTimer = window.setTimeout(step, 16);
    };
    this.bvhTimer = window.setTimeout(step, 200);
  }

  private frame(): ViewFrame {
    let b = this.visibleBox();
    if (this.gridOn && this.grid) {
      const g = this.grid;
      b = unionBox(b, { min: [g.x0, g.y0, g.z], max: [g.x1, g.y1, g.z] });
    }
    if (this.marker) {
      const m = this.marker;
      const s = this.markerScale(null);
      const ax = m.opts.axis ?? [0, 0, 1];
      const tip = m.pos;
      b = unionBox(b, emptyBox());
      expandPoint(b, tip[0], tip[1], tip[2]);
      expandPoint(b, tip[0] + ax[0]! * s * MARKER_HEIGHT, tip[1] + ax[1]! * s * MARKER_HEIGHT, tip[2] + ax[2]! * s * MARKER_HEIGHT);
    }
    const sphere = boxIsEmpty(b) ? { center: this.cam.target, radius: this.cam.distance } : boxSphere(b);
    return computeFrame(this.cam, this.cssW, this.cssH, sphere);
  }

  /** 표시 그물 배율(반지름 1 → 세계) */
  private markerScale(f: ViewFrame | null): number {
    const m = this.marker!;
    if (m.opts.radius && m.opts.radius > 0) return m.opts.radius;
    const px = m.opts.sizePx ?? 44;
    let wpp: number;
    if (f) {
      const d = viewDepth(f, m.pos);
      wpp = f.projection === 'perspective' ? Math.max(d, f.near) * f.pixelPerDepth : f.pixelConst;
    } else wpp = (2 * this.cam.distance * Math.tan(this.cam.fovY / 2)) / this.cssH;
    return (px * wpp) / MARKER_HEIGHT;
  }

  private pickDetail(x: number, y: number, build = true): PickDetail | null {
    const s = this.sceneRef;
    if (!s) return null;
    const f = this.frame();
    const ray = screenRay(f, x, y);
    const tol = this.opts.pickTolerance;
    const ix = safeInv(ray.dir[0]), iy = safeInv(ray.dir[1]), iz = safeInv(ray.dir[2]);
    const boxHit = (b: Box3): boolean => {
      const pad = (Math.abs(b.max[0] - b.min[0]) + Math.abs(b.max[1] - b.min[1]) + Math.abs(b.max[2] - b.min[2])) * 1e-6 + 1e-9;
      const arr = new Float64Array([b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]]);
      return rayBoxEntry(arr, 0, ray.origin[0], ray.origin[1], ray.origin[2], ix, iy, iz, Infinity, pad) !== Infinity;
    };
    // 그물
    let mesh: { m: Mesh3d; h: NonNullable<ReturnType<typeof pickMeshRay>> } | null = null;
    // 선분·점을 가리는 깊이: 불투명 면(음영 모드)만 가린다
    let occl = Infinity;
    const shaded = this.mode === 'shaded' || this.mode === 'shadedEdges';
    for (const it of this.items.values()) {
      if (it.kind !== 'mesh' || !this.visible(it.item.id, it.item.group)) continue;
      const m = it.item;
      if (!boxHit(meshBounds(m))) continue;
      const bvh = this.bvhFor('triangle', m.positions, m.indices, build);
      if (!bvh) continue;
      const h = pickMeshRay(f, ray, m.positions, m.indices, bvh, m.matrix);
      if (!h) continue;
      if (!mesh || h.depth < mesh.h.depth) mesh = { m, h };
      if (shaded && m.color[3] >= 0.999) occl = Math.min(occl, h.depth * (1 + 1e-4) + 1e-9);
    }
    /** 아직 BVH가 없고(만들지 말라고 했고) 크면 건너뛴다 — 모두 훑기는 작은 묶음만 */
    const skip = (bvh: Bvh | null, n: number): boolean => !bvh && !build && n > 20_000;
    // 점
    const pts: { p: PointSet3d; i: number; point: V3; distPx: number; depth: number }[] = [];
    for (const it of this.items.values()) {
      if (it.kind !== 'point' || !this.visible(it.item.id, it.item.group)) continue;
      const p = it.item;
      const bvh = this.bvhFor('point', p.positions, undefined, build);
      if (skip(bvh, p.positions.length / 3)) continue;
      const h = pickPointSet(f, p.positions, bvh, x, y, tol + (p.size ?? 4) / 2, occl);
      if (h) pts.push({ p, i: h.index, point: h.point, distPx: h.distPx, depth: h.depth });
    }
    const pt = chooseNearest(pts);
    if (pt) {
      const id = pt.p.pointIds?.[pt.i] ?? pt.i;
      return { pick: { kind: 'point', id: pt.p.id, index: id, point: pt.point, raw: pt.i }, snap: pt.point, vertex: true };
    }
    // 선분
    const lns: { l: LineSet3d; i: number; point: V3; distPx: number; depth: number }[] = [];
    for (const it of this.items.values()) {
      if (it.kind !== 'line' || !this.visible(it.item.id, it.item.group)) continue;
      const l = it.item;
      const tl = tol + (l.width ?? 1) / 2;
      if (!boxHit(positionsBox(l.positions)) && !this.nearBox(f, positionsBox(l.positions), x, y, tl)) continue;
      const bvh = this.bvhFor('segment', l.positions, undefined, build);
      if (skip(bvh, l.positions.length / 6)) continue;
      const h = pickSegments(f, l.positions, bvh, x, y, tl, { limit: this.ranges.get(l.id)?.count, maxDepth: occl });
      if (h) lns.push({ l, i: h.index, point: h.point, distPx: h.distPx, depth: h.depth });
    }
    const ln = chooseNearest(lns);
    if (ln) {
      const P = ln.l.positions, o = ln.i * 6;
      const ends: V3[] = [
        [P[o]!, P[o + 1]!, P[o + 2]!],
        [P[o + 3]!, P[o + 4]!, P[o + 5]!],
      ];
      const v = snapToNearest(f, ends, x, y, 10);
      const id = ln.l.segmentIds?.[ln.i] ?? ln.i;
      return { pick: { kind: 'line', id: ln.l.id, index: id, point: ln.point, raw: ln.i }, snap: v ?? ln.point, vertex: !!v };
    }
    if (mesh) {
      const v = snapToNearest(f, mesh.h.corners, x, y, 10);
      return {
        pick: { kind: 'mesh', id: mesh.m.id, index: mesh.h.tri, point: mesh.h.point, raw: mesh.h.tri, normal: mesh.h.normal },
        snap: v ?? mesh.h.point,
        vertex: !!v,
      };
    }
    return null;
  }

  /** 상자를 화면에 투영했을 때 커서가 tol 안에 드는지(대략) */
  private nearBox(f: ViewFrame, b: Box3, x: number, y: number, tol: number): boolean {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = projectToScreen(f, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
      if (!p) return true;
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    return x >= x0 - tol && x <= x1 + tol && y >= y0 - tol && y <= y1 + tol;
  }

  /**
   * 확대 기준점: 커서 아래 점(이미 만든 BVH만), 없으면 대상점 깊이.
   * 같은 자리에서 잇달아 굴리면 앞의 점을 다시 쓴다(확대해도 그 점은 화면에서 제자리이므로).
   */
  private zoomAnchor(f: ViewFrame, x: number, y: number, pick = true): V3 {
    const now = performance.now();
    const w = this.wheelAnchor;
    if (pick && w && now - w.t < 400 && Math.hypot(w.x - x, w.y - y) < 2) {
      w.t = now;
      return w.p;
    }
    const d = pick ? this.pickDetail(x, y, false) : null;
    const p = d ? d.pick.point : rayAtDepth(f, screenRay(f, x, y), viewDepth(f, this.cam.target));
    if (pick) this.wheelAnchor = { x, y, t: now, p };
    return p;
  }

  private click(x: number, y: number): void {
    const d = this.pickDetail(x, y);
    if (this.measuring) {
      if (!d) return;
      if (this.measurePts.length >= 2) this.measurePts = [];
      this.measurePts.push(d.snap);
      this.measureHover = null;
      const m = this.measurement();
      if (m) for (const cb of this.measureCbs) cb(m);
      this.invalidate();
      return;
    }
    for (const cb of this.pickCbs) cb(d ? d.pick : null);
  }

  // ───────────────────────── 내부: 입력 ─────────────────────────

  private local(e: { clientX: number; clientY: number }, el: HTMLElement = this.canvas): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private on<E extends Event>(el: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.off.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private bindInput(): void {
    const cv = this.canvas;
    this.on<PointerEvent>(cv, 'pointerdown', (e) => this.onDown(e));
    this.on<PointerEvent>(cv, 'pointermove', (e) => this.onMove(e));
    this.on<PointerEvent>(cv, 'pointerup', (e) => this.onUp(e, false));
    this.on<PointerEvent>(cv, 'pointercancel', (e) => this.onUp(e, true));
    this.on(cv, 'pointerleave', () => {
      if (this.measureHover || this.hoverAt) {
        this.measureHover = null;
        this.hoverAt = null;
        this.invalidate();
      }
    });
    this.on<WheelEvent>(cv, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.on(cv, 'contextmenu', (e) => e.preventDefault());
    this.on<MouseEvent>(cv, 'auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.on<KeyboardEvent>(cv, 'keydown', (e) => this.onKey(e));
    this.on(cv, 'webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.renderer.forget();
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    });
    this.on(cv, 'webglcontextrestored', () => {
      this.lost = false;
      this.renderer.init();
      if (this.sceneRef) this.renderer.setScene(this.sceneRef);
      this.rebuildGrid();
      this.invalidate();
    });
    const cube = this.cube;
    this.on<PointerEvent>(cube, 'pointermove', (e) => {
      const p = this.local(e, cube);
      const cd = this.cubeDrag;
      if (cd) {
        if (!cd.moved && Math.hypot(p.x - cd.sx, p.y - cd.sy) < 3) return;
        cd.moved = true;
        this.finishAnim();
        this.wheelAnchor = null;
        this.cam = orbitCamera(this.cam, -(p.x - cd.lx) * ROT_PER_PX * 1.5, (p.y - cd.ly) * ROT_PER_PX * 1.5);
        cd.lx = p.x;
        cd.ly = p.y;
        this.invalidate();
        return;
      }
      const h = cubeHit(cameraBasis(this.cam), cubeLayout(CUBE_CSS), p.x, p.y);
      const d = h ? h.dir : null;
      if ((d === null) !== (this.cubeHover === null) || (d && this.cubeHover && dot(d, this.cubeHover) < 0.9999)) {
        this.cubeHover = d;
        this.invalidate();
      }
    });
    this.on(cube, 'pointerleave', () => {
      if (this.cubeHover) {
        this.cubeHover = null;
        this.invalidate();
      }
    });
    this.on<PointerEvent>(cube, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      cube.setPointerCapture(e.pointerId);
      const p = this.local(e, cube);
      this.cubeDrag = { sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
    });
    const cubeUp = (e: PointerEvent, cancel: boolean): void => {
      const cd = this.cubeDrag;
      this.cubeDrag = null;
      if (!cd || cd.moved || cancel) return;
      const p = this.local(e, cube);
      const h = cubeHit(cameraBasis(this.cam), cubeLayout(CUBE_CSS), p.x, p.y);
      if (h) this.setViewDir(h.dir);
    };
    this.on<PointerEvent>(cube, 'pointerup', (e) => cubeUp(e, false));
    this.on<PointerEvent>(cube, 'pointercancel', (e) => cubeUp(e, true));
    this.on(cube, 'contextmenu', (e) => e.preventDefault());
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    this.canvas.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 이미 놓친 포인터 */
    }
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.finishAnim();
    if (e.pointerType === 'touch') {
      if (this.pointers.size === 1) this.drag = { mode: 'orbit', button: 0, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false, pivot: null, depth: null };
      else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.drag = { mode: 'touch', button: 0, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: true, pivot: null, depth: null };
        this.touch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 };
        this.interacting = true;
      }
      return;
    }
    if (this.drag) return;
    if (e.button === 1) {
      e.preventDefault();
      const now = performance.now();
      if (now - this.lastMiddle.t < 420 && Math.hypot(p.x - this.lastMiddle.x, p.y - this.lastMiddle.y) < 8) {
        this.lastMiddle.t = 0;
        this.fit();
        return;
      }
      this.lastMiddle = { t: now, x: p.x, y: p.y };
    }
    const mode: Drag['mode'] = e.button === 0 ? 'orbit' : e.button === 1 && e.shiftKey ? 'orbit' : 'pan';
    this.drag = { mode, button: e.button, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false, pivot: null, depth: null };
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    const d = this.drag;
    if (!d || !this.pointers.has(e.pointerId)) {
      if (this.measuring && !d) {
        this.hoverAt = p;
        this.invalidate();
      }
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (d.mode === 'touch') {
      if (this.pointers.size < 2 || !this.touch) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const cx = (a!.x + b!.x) / 2, cy = (a!.y + b!.y) / 2;
      const t = this.touch;
      const f = this.frame();
      this.cam = panCamera(this.cam, f, cx - t.cx, cy - t.cy);
      if (dist > 1 && t.dist > 1) {
        const f2 = this.frame();
        this.cam = zoomCamera(this.cam, t.dist / dist, this.zoomAnchor(f2, cx, cy, false), this.zoomLimits());
      }
      this.touch = { dist, cx, cy };
      this.invalidate();
      return;
    }
    if (!d.moved) {
      if (Math.hypot(p.x - d.sx, p.y - d.sy) < DRAG_START_PX) return;
      d.moved = true;
      this.interacting = true;
      // 회전 중심·이동 깊이: 누른 곳 아래 점(이미 만든 BVH만 써서 끊김이 없게)
      const hit = this.pickDetail(d.sx, d.sy, false);
      const f = this.frame();
      if (hit) {
        d.pivot = hit.pick.point;
        d.depth = viewDepth(f, hit.pick.point);
      }
      if (this.measuring) this.measureHover = null;
    }
    const dx = p.x - d.lx, dy = p.y - d.ly;
    d.lx = p.x;
    d.ly = p.y;
    this.wheelAnchor = null;
    if (d.mode === 'orbit') this.cam = orbitCamera(this.cam, -dx * ROT_PER_PX, dy * ROT_PER_PX, d.pivot);
    else this.cam = panCamera(this.cam, this.frame(), dx, dy, d.depth ?? this.cam.distance);
    this.invalidate();
  }

  private onUp(e: PointerEvent, cancel: boolean): void {
    const had = this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!had || !d) return;
    if (d.mode === 'touch') {
      if (this.pointers.size === 1) {
        // 남은 손가락으로 회전을 이어 간다
        const [q] = [...this.pointers.values()];
        this.drag = { mode: 'orbit', button: 0, sx: q!.x, sy: q!.y, lx: q!.x, ly: q!.y, moved: true, pivot: null, depth: null };
        this.touch = null;
        return;
      }
    } else if (!cancel && !d.moved && (d.button === 0 || e.pointerType === 'touch')) {
      const p = this.local(e);
      this.click(p.x, p.y);
    }
    if (this.pointers.size === 0) {
      this.drag = null;
      this.touch = null;
      this.interacting = false;
      this.invalidate();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.drag) return;
    this.finishAnim();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cssH : 1;
    const delta = Math.max(-400, Math.min(400, e.deltaY * k));
    const factor = Math.exp(delta * (e.ctrlKey ? 0.006 : 0.0015));
    const p = this.local(e);
    const f = this.frame();
    this.cam = zoomCamera(this.cam, factor, this.zoomAnchor(f, p.x, p.y), this.zoomLimits());
    this.interacting = true;
    clearTimeout(this.wheelTimer);
    this.wheelTimer = window.setTimeout(() => {
      this.interacting = !!this.drag;
      this.invalidate();
    }, 160);
    this.invalidate();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.opts.keyboard || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') this.fit();
    else if (KEY_VIEWS[e.key]) this.setView(KEY_VIEWS[e.key]!);
    else if (e.key === 'Escape' && this.measurePts.length) this.clearMeasure();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ───────────────────────── 내부: 그리기 ─────────────────────────

  private invalidate(): void {
    if (this.raf || this.disposed || this.lost) return;
    this.raf = requestAnimationFrame((t) => {
      this.raf = 0;
      this.draw(t);
    });
  }

  private draw(now: number): void {
    if (this.disposed || this.lost) return;
    const t0 = performance.now();
    if (this.anim) {
      const a = this.anim;
      const t = Math.min(1, (now - a.t0) / a.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.cam = t >= 1 ? a.to : lerpCamera(a.from, a.to, e);
      if (t >= 1) this.anim = null;
      else this.invalidate();
    }
    // 크기·화소 비율
    const dpr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio));
    this.dpr = dpr;
    const w = Math.max(1, Math.round(this.cssW * dpr)), h = Math.max(1, Math.round(this.cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    const f = this.frame();
    // 측정 중 커서 아래 붙잡을 점
    if (this.measuring && this.hoverAt && !this.drag) {
      const d = this.pickDetail(this.hoverAt.x, this.hoverAt.y);
      this.measureHover = d ? { p: d.snap, vertex: d.vertex } : null;
      this.hoverAt = null;
    }
    let marker = null;
    if (this.marker) {
      const m = this.marker;
      const s = this.markerScale(f);
      marker = { kind: m.kind, matrix: placeMatrix(m.pos, m.opts.axis ?? [0, 0, 1], s), color: m.opts.color ?? this.rgba(this.theme.marker) };
    }
    this.renderer.render(f, w, h, {
      mode: this.mode,
      colors: this.colors,
      dpr,
      visible: (id, g) => this.visible(id, g),
      highlight: this.hi,
      ranges: this.ranges,
      grid: this.gridOn,
      marker,
      interacting: this.interacting,
    });
    this.drawOverlay(f);
    if (this.opts.viewCube) this.drawCube();
    this.frameMs = performance.now() - t0;
    const key = `${this.cam.target.join(',')}|${this.cam.distance}|${this.cam.yaw}|${this.cam.pitch}|${this.cam.projection}|${this.cssW}x${this.cssH}`;
    if (key !== this.lastCamKey) {
      this.lastCamKey = key;
      const c = this.getCamera();
      for (const cb of this.camCbs) cb(c);
    }
  }

  private drawCube(): void {
    const dpr = this.dpr;
    const n = Math.round(CUBE_CSS * dpr);
    if (this.cube.width !== n || this.cube.height !== n) {
      this.cube.width = n;
      this.cube.height = n;
    }
    const ctx = this.cctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, n, n);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = this.theme;
    drawViewCube(ctx, cameraBasis(this.cam), cubeLayout(CUBE_CSS), { face: th.cubeFace, edge: th.cubeEdge, text: th.cubeText, hover: th.cubeHover }, this.cubeHover, `600 27px ${FONT}`);
  }

  private drawOverlay(f: ViewFrame): void {
    const ctx = this.octx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.opts.axes) this.drawTriad(ctx, f);
    this.drawMeasure(ctx, f);
  }

  private drawTriad(ctx: CanvasRenderingContext2D, f: ViewFrame): void {
    const b = f.basis;
    const ox = 40, oy = this.cssH - 40, len = 28;
    const th = this.theme;
    const axes: { v: V3; c: string; l: string }[] = [
      { v: [1, 0, 0], c: th.axisX, l: 'X' },
      { v: [0, 1, 0], c: th.axisY, l: 'Y' },
      { v: [0, 0, 1], c: th.axisZ, l: 'Z' },
    ];
    axes.sort((p, q) => dot(p.v, b.back) - dot(q.v, b.back));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const a of axes) {
      const ex = dot(a.v, b.right) * len, ey = -dot(a.v, b.up) * len;
      ctx.strokeStyle = a.c;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + ex, oy + ey);
      ctx.stroke();
      if (Math.hypot(ex, ey) > 4) {
        ctx.fillStyle = a.c;
        ctx.fillText(a.l, ox + ex * 1.32, oy + ey * 1.32);
      }
    }
    ctx.restore();
  }

  private fmt(v: number): string {
    const diag = Math.max(length(sub(this.allBox.max, this.allBox.min)) || 1, 1e-9);
    const digits = Math.max(0, Math.min(6, 5 - Math.floor(Math.log10(diag))));
    const s = v.toFixed(digits);
    return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
  }

  private drawMeasure(ctx: CanvasRenderingContext2D, f: ViewFrame): void {
    const pts = this.measurePts;
    const hover = this.measuring ? this.measureHover : null;
    if (!pts.length && !hover) return;
    const th = this.theme;
    const unit = UNIT_LABEL[this.sceneRef?.units ?? 'unknown'];
    const P = (p: readonly number[]): V3 | null => projectToScreen(f, p);
    const line = (a: V3 | null, b: V3 | null, color: string, width: number, dash: number[]): void => {
      if (!a || !b) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const dotAt = (p: V3 | null, square: boolean): void => {
      if (!p) return;
      ctx.fillStyle = th.measure;
      ctx.strokeStyle = th.textBg;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (square) ctx.rect(p[0] - 4.5, p[1] - 4.5, 9, 9);
      else ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    const label = (at: V3 | null, lines: string[]): void => {
      if (!at) return;
      ctx.font = `12px ${FONT}`;
      const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 14;
      const h = lines.length * 16 + 8;
      let x = at[0] + 10, y = at[1] - h - 8;
      x = Math.min(Math.max(4, x), this.cssW - w - 4);
      y = Math.min(Math.max(4, y), this.cssH - h - 4);
      ctx.fillStyle = th.textBg;
      ctx.strokeStyle = th.measure;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = th.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((s, i) => ctx.fillText(s, x + 7, y + 5 + i * 16));
    };
    ctx.save();
    const a = pts[0], b = pts[1] ?? (hover ? hover.p : undefined);
    if (a && b) {
      const sa = P(a), sb = P(b);
      // 축 방향 다리: A → (Bx, Ay, Az) → (Bx, By, Az) → B
      const k1: V3 = [b[0], a[1], a[2]], k2: V3 = [b[0], b[1], a[2]];
      if (pts.length === 2) {
        line(sa, P(k1), th.axisX, 1.5, [5, 4]);
        line(P(k1), P(k2), th.axisY, 1.5, [5, 4]);
        line(P(k2), sb, th.axisZ, 1.5, [5, 4]);
      }
      line(sa, sb, th.measure, 2, pts.length === 2 ? [] : [6, 4]);
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const mid = sa && sb ? ([(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2, 0] as V3) : sb ?? sa;
      const u = unit ? ` ${unit}` : '';
      label(mid, [`거리 ${this.fmt(Math.hypot(dx, dy, dz))}${u}`, `ΔX ${this.fmt(dx)}  ΔY ${this.fmt(dy)}  ΔZ ${this.fmt(dz)}`]);
    }
    for (const p of pts) dotAt(P(p), false);
    if (hover) dotAt(P(hover.p), hover.vertex);
    ctx.restore();
  }
}
