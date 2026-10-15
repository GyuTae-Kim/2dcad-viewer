/**
 * 도면을 여는 동안의 미리 보기(점진 빌드): 워커가 장면을 만들며 보내는 조각을 받는 대로 올려 그린다.
 * 문서와 최종 장면이 다 오면 앱이 탭을 열고 이것을 버린다. 화면은 미리 보기 동안 조작할 수 없다(진행 상자가 덮는다).
 */
import type { PartialScene } from '../render/build';
import { type LayerState, StyleTable, resolveStyles } from '../render/styles';
import type { GLRenderer, GpuScene } from '../render/webgl';
import type { PreviewView } from '../worker/protocol';
import type { Camera } from './docstate';

interface Part {
  gpu: GpuScene;
  styles: StyleTable;
  layers: LayerState[];
  cache: { key: string; data: Float32Array } | null;
}

export class LoadPreview {
  private readonly parts: Part[] = [];
  /** 첫 화면(워커가 정한 사각형). 첫 조각과 함께 온다 */
  view: PreviewView | null = null;
  /** 지금 화면 크기로 맞춘 카메라(크기가 바뀌면 다시 맞춘다) */
  private fitted: { w: number; h: number; cam: Camera } | null = null;

  constructor(private readonly renderer: GLRenderer) {}

  get empty(): boolean {
    return this.parts.length === 0;
  }

  add(part: PartialScene, view: PreviewView | null): void {
    if (view && !this.view) this.view = view;
    const l = part.list;
    if (!l.chunks.length && !l.glyphs.instanceCount) return;
    // 대표점으로 첫 화면을 못 정했으면 첫 조각 범위로
    if (!this.view && l.minX <= l.maxX) this.view = { rect: [l.minX, l.minY, l.maxX, l.maxY], margin: 0.04 };
    const styles = new StyleTable();
    for (const s of part.styles) styles.intern(s);
    this.parts.push({ gpu: this.renderer.upload(part.list), styles, layers: part.layers, cache: null });
  }

  /** 화면 w×h(CSS 픽셀)에 첫 화면 사각형을 맞춘 카메라(View.zoomRect와 같은 셈) */
  camera(w: number, h: number): Camera | null {
    const v = this.view;
    if (!v) return null;
    if (this.fitted && this.fitted.w === w && this.fitted.h === h) return this.fitted.cam;
    const [x0, y0, x1, y1] = v.rect;
    const rw = Math.max(Math.abs(x1 - x0), 1e-9);
    const rh = Math.max(Math.abs(y1 - y0), 1e-9);
    let scale = Math.min((w * (1 - v.margin * 2)) / rw, (h * (1 - v.margin * 2)) / rh);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    const cam = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale };
    this.fitted = { w, h, cam };
    return cam;
  }

  /** 조각마다 (GPU 장면, 스타일 자료) */
  *drawables(dark: boolean, bg: number, lwDisplay: boolean): Generator<{ gpu: GpuScene; styles: Float32Array }> {
    const key = `${dark}|${bg}|${lwDisplay}`;
    for (const p of this.parts) {
      if (!p.cache || p.cache.key !== key) p.cache = { key, data: resolveStyles(p.styles, p.layers, { darkBackground: dark, backgroundRgb: bg, showLineweight: lwDisplay, defaultLineweight: 25 }) };
      yield { gpu: p.gpu, styles: p.cache.data };
    }
  }

  dispose(): void {
    for (const p of this.parts) this.renderer.dispose(p.gpu);
    this.parts.length = 0;
  }
}
