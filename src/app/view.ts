/**
 * 도면 영역: 카메라(확대·이동), WebGL 그리기, 배치·뷰포트, 오버레이(커서·선택·스냅·고무줄).
 */
import { MODEL_SPACE, tableKey } from '../core/model';
import earcut from 'earcut';
import { GLRenderer, type ViewXf } from '../render/webgl';
import type { Camera, DocState } from './docstate';
import { type PaperInfo, type ViewportXf, layoutViewports, paperInfo, viewportXf } from './scene';

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
  marks: { p: Pt; text?: string }[];
  /** 커서 옆 동적 입력 문구 */
  tip: string | null;
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

  camera(): Camera {
    const s = this.state;
    if (!s) return { cx: 0, cy: 0, scale: 1 };
    let c = s.cameras.get(s.space);
    if (!c) {
      c = { cx: 0, cy: 0, scale: 1 };
      s.cameras.set(s.space, c);
      this.zoomExtents(false);
      c = s.cameras.get(s.space)!;
    }
    return c;
  }

  private setCamera(c: Camera, remember = true): void {
    const s = this.state;
    if (!s) return;
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
    return { x: c.cx + (x - this.w / 2) / c.scale, y: c.cy - (y - this.h / 2) / c.scale };
  }

  worldToScreen(x: number, y: number): Pt {
    const c = this.camera();
    return { x: (x - c.cx) * c.scale + this.w / 2, y: -(y - c.cy) * c.scale + this.h / 2 };
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
    const sx = (this.w * (1 - margin * 2)) / w;
    const sy = (this.h * (1 - margin * 2)) / h;
    let scale = Math.min(sx, sy);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    this.setCamera({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: clampScale(scale) }, remember);
  }

  zoomPrevious(): boolean {
    const s = this.state;
    if (!s) return false;
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
    const cx = w.x - (sx - this.w / 2) / scale;
    const cy = w.y + (sy - this.h / 2) / scale;
    this.setCamera({ cx, cy, scale }, remember);
  }

  zoomCenter(f: number): void {
    this.zoomAt(this.w / 2, this.h / 2, f, true);
  }

  panBy(dx: number, dy: number): void {
    const c = this.camera();
    this.setCamera({ cx: c.cx - dx / c.scale, cy: c.cy + dy / c.scale, scale: c.scale }, false);
  }

  centerOn(x: number, y: number, size?: number): void {
    const c = this.camera();
    let scale = c.scale;
    if (size && size > 0) scale = clampScale(Math.min(this.w, this.h) / (size * 4));
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

  private viewXf(): ViewXf {
    const c = this.camera();
    const s = c.scale * this.dpr;
    return { A: [s, 0, 0, -s], refX: c.cx, refY: c.cy, tx: (this.w * this.dpr) / 2, ty: (this.h * this.dpr) / 2 };
  }

  private visibleRect(): [number, number, number, number] {
    const a = this.screenToWorld(0, this.h);
    const b = this.screenToWorld(this.w, 0);
    return [a.x, a.y, b.x, b.y];
  }

  /** 지금 장면을 그린다(내보내기에서도 쓴다) */
  renderGL(): void {
    const r = this.renderer;
    const s = this.state;
    if (!s) {
      r.clear(rgbF(DARK_BG));
      return;
    }
    const scene = s.scenes.get(s.space);
    if (s.isModel) {
      const bg = this.modelBg;
      const dark = isDark(bg);
      r.clear(rgbF(bg));
      if (!scene) return;
      r.setStyles(scene.styleData(s.sceneLayers(s.space), 'model', dark, bg, this.lwDisplay));
      r.draw(scene.gpu, this.viewXf(), { lwScale: 3.78 * this.dpr, visible: this.visibleRect() });
      this.drawOverlayScene(s.space, this.viewXf(), 3.78 * this.dpr, dark, bg);
      return;
    }
    // 배치
    r.clear(rgbF(LAYOUT_BG));
    const lay = s.layoutFor(s.space);
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
    const model = s.scenes.get(MODEL_SPACE);
    if (model) {
      const vps = layoutViewports(s.doc, lay);
      const layerIdx = s.sceneLayerIndex(MODEL_SPACE);
      for (const vp of vps) {
        const vx = viewportXf(s.doc, vp);
        this.drawViewport(vx, model, layerIdx, lwScale);
      }
    }
    r.scissor(null);
    r.clearDepth();
    if (scene) {
      r.setStyles(scene.styleData(s.sceneLayers(s.space), 'paper', false, 0xffffff, this.lwDisplay));
      r.draw(scene.gpu, this.viewXf(), { lwScale, visible: this.visibleRect() });
    }
    this.drawOverlayScene(s.space, this.viewXf(), lwScale, false, 0xffffff);
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

  private drawViewport(vx: ViewportXf, model: NonNullable<ReturnType<DocState['scenes']['get']>>, layerIdx: Map<string, number>, lwScale: number): void {
    const s = this.state!;
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
    r.setStyles(model.styleData(s.sceneLayers(MODEL_SPACE), 'vp', false, 0xffffff, this.lwDisplay, frozen.size ? frozen : undefined));
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
    r.draw(model.gpu, xf, { lwScale, visible: vis });
    this.drawOverlayScene(MODEL_SPACE, xf, lwScale, false, 0xffffff, vx.frozen, vis);
    if (vx.clip) r.stencilClip(null);
  }

  private renderOverlay(): void {
    const g = this.ctx2d;
    const d = this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.ovCanvas.width, this.ovCanvas.height);
    g.setTransform(d, 0, 0, d, 0, 0);
    const s = this.state;
    const o = this.overlay;
    const dark = s ? (s.isModel ? isDark(this.modelBg) : true) : true;
    const W = (x: number, y: number) => this.worldToScreen(x, y);
    // 배치: 인쇄 가능 영역 점선
    if (s && !s.isModel) {
      const lay = s.layoutFor(s.space);
      const scene = s.scenes.get(s.space);
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
    if (o.tip && o.cursor) {
      g.save();
      g.font = '11.5px ui-monospace, Menlo, monospace';
      const tw = g.measureText(o.tip).width;
      const x = Math.min(o.cursor.x + 18, this.w - tw - 14);
      const y = Math.min(o.cursor.y + 22, this.h - 24);
      g.fillStyle = 'rgba(37,44,54,0.95)';
      g.strokeStyle = '#5b6a7e';
      g.fillRect(x, y, tw + 12, 20);
      g.strokeRect(x + 0.5, y + 0.5, tw + 11, 19);
      g.fillStyle = '#e8ebf0';
      g.fillText(o.tip, x + 6, y + 14);
      g.restore();
    }
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
    const cx = pz.world.x - (mid.x - this.w / 2) / scale;
    const cy = pz.world.y + (mid.y - this.h / 2) / scale;
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
  return { cursor: null, crosshair: true, pickbox: 5, windowRect: null, selection: [], hover: null, grips: [], snap: null, rubber: [], ghost: [], tracks: [], acquired: [], hotGrip: null, marks: [], tip: null };
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
