/**
 * PDF 가져오기(PDFIMPORT)의 변환: PDF 페이지에서 뽑은 경로·채우기·문자를 도면 객체로(UI 없음).
 * 직선만 이어진 부분은 LWPOLYLINE, 베지에 곡선이 이어진 부분은 그 곡선과 정확히 같은 3차 SPLINE,
 * 채우기는 SOLID 해치(흰색 채우기는 종이 바탕이라 뺀다), 문자는 TEXT. 검정·흰색은 배경에 따라 바뀌는 색 7로 둔다.
 */
import type { CadColor, Entity, HatchPath, Layer, Vec2 } from '../core/model';
import { entityDefaults } from '../core/model';
import type { CadDocument } from '../core/model';
import { createHatch } from './hatch';
import { nearestAci } from '../core/color';
import { packBulge, packLwPoints } from '../core/lwpoly';

export type PdfSeg = { k: 'L'; x: number; y: number } | { k: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number };

export interface PdfSubpath {
  x0: number;
  y0: number;
  segs: PdfSeg[];
  closed: boolean;
}

export interface PdfShape {
  stroke: boolean;
  fill: boolean;
  /** 0xRRGGBB */
  strokeRgb: number;
  fillRgb: number;
  /** 선 두께(PDF 단위) */
  width: number;
  subpaths: PdfSubpath[];
}

export interface PdfText {
  str: string;
  x: number;
  y: number;
  /** 글자 높이(PDF 단위) */
  height: number;
  /** 라디안 */
  rotation: number;
  rgb: number;
}

export interface PdfPageData {
  /** 페이지 왼쪽 아래(PDF 단위) */
  originX: number;
  originY: number;
  width: number;
  height: number;
  shapes: PdfShape[];
  texts: PdfText[];
}

export interface PdfImportOptions {
  /** 도면 단위 / PDF 단위 */
  scale: number;
  insert: Vec2;
  /** 라디안 */
  rotation: number;
  geometry: boolean;
  fills: boolean;
  text: boolean;
  lineweights: boolean;
  /** true면 PDF_Geometry·PDF_Solid Fills·PDF_Text 도면층, 아니면 currentLayer */
  pdfLayers: boolean;
  currentLayer: string;
  /** 도면 단위의 mm(선가중치 계산용, 인치 도면이면 25.4) */
  mmPerUnit: number;
}

export const PDF_LAYERS = { geometry: 'PDF_Geometry', fills: 'PDF_Solid Fills', text: 'PDF_Text' } as const;

const LWS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

function colorOf(rgb: number): CadColor {
  // 검정·흰색은 배경에 맞춰 보이는 색 7
  if (rgb === 0 || rgb === 0xffffff) return { aci: 7 };
  return { aci: nearestAci(rgb), rgb };
}

function lineweightOf(width: number, opt: PdfImportOptions): number {
  if (!opt.lineweights || !(width > 0)) return -1;
  const mm100 = width * opt.scale * opt.mmPerUnit * 100;
  let best = LWS[0]!;
  for (const w of LWS) if (Math.abs(w - mm100) < Math.abs(best - mm100)) best = w;
  return best;
}

/** 베지에 곡선을 점으로(채우기 경계용) */
function flattenCubic(out: number[], x0: number, y0: number, s: Extract<PdfSeg, { k: 'C' }>, n = 12): void {
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(u * u * u * x0 + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x, u * u * u * y0 + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y);
  }
}

export function pdfToEntities(doc: CadDocument, page: PdfPageData, opt: PdfImportOptions): { entities: Entity[]; layers: string[] } {
  const c = Math.cos(opt.rotation);
  const s = Math.sin(opt.rotation);
  const P = (x: number, y: number): Vec2 => {
    const lx = (x - page.originX) * opt.scale;
    const ly = (y - page.originY) * opt.scale;
    return { x: opt.insert.x + c * lx - s * ly, y: opt.insert.y + s * lx + c * ly };
  };
  const out: Entity[] = [];
  const used = new Set<string>();
  const layerFor = (k: keyof typeof PDF_LAYERS) => {
    const name = opt.pdfLayers ? PDF_LAYERS[k] : opt.currentLayer;
    used.add(name);
    return name;
  };
  const base = (layer: string, color: CadColor, lw = -1) => ({ ...entityDefaults(), handle: '', layer, color, lineweight: lw });

  for (const sh of page.shapes) {
    // 채우기(흰색 채우기는 종이 바탕이므로 건너뛴다)
    if (sh.fill && opt.fills && sh.fillRgb !== 0xffffff) {
      const paths: HatchPath[] = [];
      for (const sp of sh.subpaths) {
        const pts: number[] = [sp.x0, sp.y0];
        let lx = sp.x0;
        let ly = sp.y0;
        for (const g of sp.segs) {
          if (g.k === 'L') pts.push(g.x, g.y);
          else flattenCubic(pts, lx, ly, g);
          lx = g.x;
          ly = g.y;
        }
        if (pts.length < 6) continue;
        const vs = [];
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const q = P(pts[i]!, pts[i + 1]!);
          vs.push({ x: q.x, y: q.y, bulge: 0 });
        }
        paths.push({ flags: 1 | 2, polyline: { closed: true, verts: packBulge(vs) } });
      }
      if (paths.length) {
        try {
          const h = createHatch(doc, paths, { pattern: 'SOLID', associative: false, layer: layerFor('fills') });
          Object.assign(h, { color: colorOf(sh.fillRgb) });
          out.push(h);
        } catch {
          /* 넓이 없는 채우기는 건너뛴다 */
        }
      }
    }
    if (!sh.stroke || !opt.geometry) continue;
    const layer = layerFor('geometry');
    const color = colorOf(sh.strokeRgb);
    const lw = lineweightOf(sh.width, opt);
    for (const sp of sh.subpaths) {
      // 직선 묶음과 곡선 묶음으로 나눈다
      let cur: { kind: 'L' | 'C'; pts: Vec2[] } | null = null;
      const runs: { kind: 'L' | 'C'; pts: Vec2[] }[] = [];
      let last = P(sp.x0, sp.y0);
      for (const g of sp.segs) {
        const kind = g.k;
        if (!cur || cur.kind !== kind) {
          cur = { kind, pts: [last] };
          runs.push(cur);
        }
        if (g.k === 'L') cur.pts.push(P(g.x, g.y));
        else cur.pts.push(P(g.x1, g.y1), P(g.x2, g.y2), P(g.x, g.y));
        last = cur.pts[cur.pts.length - 1]!;
      }
      const closedLines = sp.closed && runs.length === 1 && runs[0]!.kind === 'L';
      if (sp.closed && !closedLines) {
        // 닫는 선분
        const first = P(sp.x0, sp.y0);
        if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-12) runs.push({ kind: 'L', pts: [last, first] });
      }
      for (const r of runs) {
        if (r.kind === 'L') {
          const pts = r.pts.filter((p, i) => i === 0 || Math.hypot(p.x - r.pts[i - 1]!.x, p.y - r.pts[i - 1]!.y) > 1e-12);
          if (closedLines && pts.length > 2 && Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y) <= 1e-12) pts.pop();
          if (pts.length < 2) continue;
          if (pts.length === 2 && !closedLines) {
            out.push({ type: 'LINE', ...base(layer, color, lw), start: { x: pts[0]!.x, y: pts[0]!.y, z: 0 }, end: { x: pts[1]!.x, y: pts[1]!.y, z: 0 } } as Entity);
            continue;
          }
          out.push({
            type: 'LWPOLYLINE',
            ...base(layer, color, lw),
            ...packLwPoints(pts),
            closed: closedLines,
            plinegen: false,
            constantWidth: 0,
            elevation: 0,
          } as Entity);
        } else {
          // 이어진 3차 베지에 n개 = 매듭 0,0,0,0,1,1,1,…,n,n,n,n의 3차 NURBS(정확히 같은 곡선)
          const n = (r.pts.length - 1) / 3;
          const knots = [0, 0, 0, 0];
          for (let i = 1; i < n; i++) knots.push(i, i, i);
          knots.push(n, n, n, n);
          out.push({
            type: 'SPLINE',
            ...base(layer, color, lw),
            degree: 3,
            flags: 8,
            knots,
            controlPoints: r.pts.map((p) => ({ x: p.x, y: p.y, z: 0 })),
            fitPoints: [],
            knotTolerance: 1e-10,
            controlTolerance: 1e-10,
            fitTolerance: 1e-10,
          } as Entity);
        }
      }
    }
  }

  if (opt.text)
    for (const t of page.texts) {
      if (!t.str.trim() || !(t.height > 0)) continue;
      const q = P(t.x, t.y);
      out.push({
        type: 'TEXT',
        ...base(layerFor('text'), colorOf(t.rgb)),
        insert: { x: q.x, y: q.y, z: 0 },
        height: t.height * opt.scale,
        text: t.str,
        rotation: t.rotation + opt.rotation,
        widthFactor: 1,
        oblique: 0,
        style: 'Standard',
        generation: 0,
        halign: 0,
        valign: 0,
      } as Entity);
    }
  return { entities: out, layers: [...used] };
}

/** 새 도면층(없는 것만) */
export function pdfLayerRecords(doc: CadDocument, names: string[], newHandle: () => string): Layer[] {
  const out: Layer[] = [];
  for (const n of names) {
    if (doc.layers.has(n.toUpperCase())) continue;
    out.push({ name: n, handle: newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 } as Layer);
  }
  return out;
}
