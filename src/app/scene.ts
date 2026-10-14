/** 메인 스레드가 가진 공간 장면(GPU 자원 + 스타일 해석 정보) */
import type { CadDocument, Entity, Layout, ViewportEntity } from '../core/model';
import { tableKey } from '../core/model';
import type { DisplayList, EntityBox } from '../render/displaylist';
import { SceneBuilder } from '../render/build';
import type { TextEngine } from '../text/layout';
import type { LayerState, PlotStyle, StyleSpec } from '../render/styles';
import { HIDDEN_STYLE, StyleTable, resolveStyles } from '../render/styles';
import type { GLRenderer, GpuScene } from '../render/webgl';
import type { SceneMessage } from '../worker/protocol';
import { bulgePolylinePoints, circlePoints, ellipsePoints, nurbsPoints } from '../geom/curves';

export class SpaceScene {
  gpu: GpuScene;
  /** 원본 표시 목록(내보내기·문맥 복구용) */
  readonly source: DisplayList;
  readonly styles: StyleTable;
  readonly entities: EntityBox[];
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  private styleCache = new Map<string, Float32Array>();

  constructor(
    renderer: GLRenderer,
    msg: SceneMessage,
    readonly space: string,
  ) {
    this.gpu = renderer.upload(msg.list);
    this.source = msg.list;
    this.styles = new StyleTable();
    for (const s of msg.styles) this.styles.intern(s as StyleSpec);
    this.entities = msg.list.entities;
    const l: DisplayList = msg.list;
    this.bounds = Number.isFinite(l.minX) && l.minX <= l.maxX ? { minX: l.minX, minY: l.minY, maxX: l.maxX, maxY: l.maxY } : null;
  }

  /** 스타일 표(도면층 상태·배경·뷰포트 동결 기준). 같은 조건이면 캐시를 쓴다. */
  styleData(layers: LayerState[], key: string, dark: boolean, bg: number, lwDisplay: boolean, vpFrozen?: Set<number>, plot?: PlotStyle): Float32Array {
    const k = `${key}|${dark}|${bg}|${lwDisplay}|${vpFrozen ? [...vpFrozen].join(',') : ''}|${plot ?? ''}`;
    let d = this.styleCache.get(k);
    if (!d) {
      d = resolveStyles(this.styles, layers, { darkBackground: dark, backgroundRgb: bg, showLineweight: lwDisplay, defaultLineweight: 25, viewportFrozen: vpFrozen, plot: plot ? { style: plot } : undefined });
      this.styleCache.set(k, d);
    }
    return d;
  }

  invalidateStyles(): void {
    this.styleCache.clear();
  }

  private boxMap: Map<string, EntityBox> | null = null;

  boxOf(handle: string): EntityBox | undefined {
    if (!this.boxMap) this.boxMap = new Map(this.entities.map((b) => [b.handle, b]));
    return this.boxMap.get(handle);
  }

  /** 편집으로 지우거나 바꾼 객체의 옛 그림을 숨긴다 */
  hide(renderer: GLRenderer, handle: string): void {
    renderer.hideEntity(this.gpu, this.source, this.boxOf(handle) ?? { handle, minX: 0, minY: 0, maxX: 0, maxY: 0 }, HIDDEN_STYLE);
  }

  /** 그래픽 문맥을 되찾은 뒤 다시 올린다 */
  reupload(renderer: GLRenderer): void {
    this.gpu = renderer.upload(this.source);
  }

  dispose(renderer: GLRenderer): void {
    renderer.dispose(this.gpu);
  }
}

/**
 * 편집 덧그림: 기본 장면을 다시 만들기 전까지 바뀐 객체만 따로 그린다(기본 장면 위에).
 */
export class OverlayScene {
  readonly gpu: GpuScene;
  readonly source: DisplayList;
  readonly styles: StyleTable;
  readonly layerNames: string[];
  readonly entities: EntityBox[];

  constructor(renderer: GLRenderer, doc: CadDocument, list: readonly Entity[], text: TextEngine, space: string) {
    const b = new SceneBuilder(doc, { text });
    b.prepare(space);
    this.source = b.buildEntities(list);
    this.styles = b.styles;
    this.layerNames = b.layers.map((l) => tableKey(l.name));
    this.entities = this.source.entities;
    this.gpu = renderer.upload(this.source);
  }

  styleData(layerOf: (key: string) => LayerState | undefined, dark: boolean, bg: number, lwDisplay: boolean, vpFrozen?: Set<string>, plot?: PlotStyle): Float32Array {
    const layers = this.layerNames.map((n) => layerOf(n) ?? { name: n, rgb: 0, aci: 7, hasRgb: false, on: true, frozen: false, lineweight: -3, transparency: 255, plot: true });
    const frozen = vpFrozen ? new Set(this.layerNames.map((n, i) => (vpFrozen.has(n) ? i : -1)).filter((i) => i >= 0)) : undefined;
    return resolveStyles(this.styles, layers, { darkBackground: dark, backgroundRgb: bg, showLineweight: lwDisplay, defaultLineweight: 25, viewportFrozen: frozen, plot: plot ? { style: plot } : undefined });
  }

  dispose(renderer: GLRenderer): void {
    renderer.dispose(this.gpu);
  }
}

/** 배치의 용지 사각형(배치 공간 좌표)과 단위 */
export interface PaperInfo {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 용지 단위 1이 몇 mm인지 */
  mmPerUnit: number;
  /** 인쇄 가능 영역 */
  printable?: [number, number, number, number];
}

export function paperInfo(layout: Layout, fallback: { minX: number; minY: number; maxX: number; maxY: number } | null): PaperInfo {
  const p = layout.plot;
  const inch = p.paperUnits === 0;
  const mmPerUnit = inch ? 25.4 : 1;
  let w = p.paperWidth / mmPerUnit;
  let h = p.paperHeight / mmPerUnit;
  if (p.rotation === 1 || p.rotation === 3) [w, h] = [h, w];
  const lm = layout.limitsMin;
  const lx = layout.limitsMax;
  // 여백(용지 매체 기준 mm) → 배치 방향
  const m = p.margins.map((v) => v / mmPerUnit);
  const r = p.rotation & 3;
  const side = (i: number) => m[(((i - r) % 4) + 4) % 4] ?? 0;
  let minX: number;
  let minY: number;
  if (w > 0 && h > 0) {
    minX = -side(0);
    minY = -side(1);
    // 한계가 용지와 같은 크기면 한계를 쓴다(AutoCAD가 저장한 배치)
    if (lx.x - lm.x > 0 && lx.y - lm.y > 0 && Math.abs(lx.x - lm.x - w) < w * 0.02 && Math.abs(lx.y - lm.y - h) < h * 0.02) {
      minX = lm.x;
      minY = lm.y;
    }
  } else if (lx.x - lm.x > 0 && lx.y - lm.y > 0) {
    minX = lm.x;
    minY = lm.y;
    w = lx.x - lm.x;
    h = lx.y - lm.y;
  } else if (fallback) {
    const pad = Math.max(fallback.maxX - fallback.minX, fallback.maxY - fallback.minY) * 0.05;
    minX = fallback.minX - pad;
    minY = fallback.minY - pad;
    w = fallback.maxX - fallback.minX + pad * 2;
    h = fallback.maxY - fallback.minY + pad * 2;
  } else {
    minX = 0;
    minY = 0;
    w = 420;
    h = 297;
  }
  const info: PaperInfo = { minX, minY, maxX: minX + w, maxY: minY + h, mmPerUnit };
  const pl = side(0);
  const pb = side(1);
  const pr = side(2);
  const pt = side(3);
  if (pl || pb || pr || pt) info.printable = [minX + pl, minY + pb, minX + w - pr, minY + h - pt];
  return info;
}

/** 배치의 뷰포트(전체 용지 뷰포트 제외, 꺼진 것 제외) */
export function layoutViewports(doc: CadDocument, layout: Layout): ViewportEntity[] {
  const b = doc.blocks.get(tableKey(layout.blockName));
  if (!b) return [];
  const vps = b.entities.filter((e): e is ViewportEntity => e.type === 'VIEWPORT');
  if (!vps.length) return [];
  // 전체 용지 뷰포트: 배치의 viewport 핸들 또는 id 1(없으면 가장 앞)
  let overall = vps.find((v) => v.id === 1);
  if (!overall && layout.viewport) overall = vps.find((v) => v.handle === layout.viewport);
  if (!overall) overall = vps[0];
  return vps.filter((v) => v !== overall && v.status !== 0 && !(v.flags & 0x20000) && v.width > 0 && v.height > 0 && v.viewHeight > 0);
}

/** 뷰포트: 모형 → 종이 변환 정보 */
export interface ViewportXf {
  vp: ViewportEntity;
  /** 종이 단위 / 모형 단위 */
  k: number;
  twist: number;
  /** 뷰포트 중심에 오는 모형 점 */
  refX: number;
  refY: number;
  /** 동결 도면층 이름(대문자) */
  frozen: Set<string>;
  clip?: number[];
}

export function viewportXf(doc: CadDocument, vp: ViewportEntity): ViewportXf {
  const k = vp.height / vp.viewHeight;
  const tw = vp.twistAngle || 0;
  // DCS 중심(viewCenter)을 WCS로: target + R(twist)·viewCenter
  const c = Math.cos(tw);
  const s = Math.sin(tw);
  const refX = vp.viewTarget.x + c * vp.viewCenter.x - s * vp.viewCenter.y;
  const refY = vp.viewTarget.y + s * vp.viewCenter.x + c * vp.viewCenter.y;
  const out: ViewportXf = { vp, k, twist: tw, refX, refY, frozen: new Set(vp.frozenLayers.map(tableKey)) };
  if (vp.clipBoundary) {
    const e = doc.entityIndex.get(vp.clipBoundary);
    const pts = e ? outlineOf(e) : null;
    if (pts && pts.length >= 6) out.clip = pts;
  }
  return out;
}

/** 뷰포트 자르기 경계 객체의 윤곽(종이 좌표, [x, y, …]) */
function outlineOf(e: Entity): number[] | null {
  const tol = 0;
  switch (e.type) {
    case 'LWPOLYLINE': {
      const pts = bulgePolylinePoints(e.vertices.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge ?? 0 })), true, tol || polySize(e.vertices.map((v) => [v.x, v.y])) * 1e-3);
      return pts;
    }
    case 'POLYLINE': {
      const vs = e.vertices.map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge ?? 0 }));
      return bulgePolylinePoints(vs, true, polySize(vs.map((v) => [v.x, v.y])) * 1e-3);
    }
    case 'CIRCLE':
      return circlePoints(e.center.x, e.center.y, e.radius, e.radius * 1e-3);
    case 'ELLIPSE': {
      const r = Math.hypot(e.majorAxis.x, e.majorAxis.y);
      return ellipsePoints(e.center.x, e.center.y, e.majorAxis.x, e.majorAxis.y, e.ratio, e.startParam, e.endParam, r * 1e-3);
    }
    case 'SPLINE': {
      if (e.controlPoints.length >= 2) {
        const pts3 = nurbsPoints(e.degree, e.knots, e.controlPoints, e.weights, 1e-3 * polySize(e.controlPoints.map((p) => [p.x, p.y])));
        const out: number[] = [];
        for (let i = 0; i + 2 < pts3.length; i += 3) out.push(pts3[i]!, pts3[i + 1]!);
        return out;
      }
      return e.fitPoints.flatMap((p) => [p.x, p.y]);
    }
  }
  return null;
}

function polySize(pts: number[][]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x!);
    maxX = Math.max(maxX, x!);
    minY = Math.min(minY, y!);
    maxY = Math.max(maxY, y!);
  }
  return Math.max(maxX - minX, maxY - minY, 1e-9);
}
