/**
 * 내보내기: PNG(화면 그대로), SVG·PDF(벡터, 표시 목록에서).
 * PDF는 직접 쓴다(선·채움만, 문자는 모양 그대로 그린다).
 */
import { MODEL_SPACE } from '../core/model';
import type { DisplayList } from '../render/displaylist';
import { GLYPH_STRIDE, SEG_STRIDE, TRI_STRIDE } from '../render/displaylist';
import type { App } from './app';
import type { SpaceScene } from './scene';
import { layoutViewports, paperInfo, viewportXf } from './scene';

type Affine = [number, number, number, number, number, number];

interface Sink {
  seg(x0: number, y0: number, x1: number, y1: number, style: number): void;
  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, style: number): void;
}

/** 표시 목록을 그리기 순서(깊이)대로 내보낸다. m: 도면 → 출력 좌표 */
function walk(dl: DisplayList, m: Affine, visible: (s: number) => boolean, sink: Sink, clip?: [number, number, number, number]): void {
  type Item = { d: number; f: () => void };
  const items: Item[] = [];
  const X = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  for (const c of dl.chunks) {
    if (clip && (c.maxX < clip[0] || c.minX > clip[2] || c.maxY < clip[1] || c.minY > clip[3])) continue;
    for (const [buf, n] of [
      [c.tris, c.triCount],
      [c.ttris, c.ttriCount],
    ] as const) {
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      for (let i = 0; i < n; i++) {
        const o = i * 3 * TRI_STRIDE;
        const s = u[o + 3]!;
        if (!visible(s)) continue;
        const a = X(f[o]! + c.ox, f[o + 1]! + c.oy);
        const b = X(f[o + TRI_STRIDE]! + c.ox, f[o + TRI_STRIDE + 1]! + c.oy);
        const d = X(f[o + 2 * TRI_STRIDE]! + c.ox, f[o + 2 * TRI_STRIDE + 1]! + c.oy);
        items.push({ d: f[o + 2]!, f: () => sink.tri(a[0], a[1], b[0], b[1], d[0], d[1], s) });
      }
    }
    for (const [buf, n] of [
      [c.segs, c.segCount],
      [c.tsegs, c.tsegCount],
    ] as const) {
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      for (let i = 0; i < n; i++) {
        const o = i * SEG_STRIDE;
        const s = u[o + 5]!;
        if (!visible(s)) continue;
        const a = X(f[o]! + c.ox, f[o + 1]! + c.oy);
        const b = X(f[o + 2]! + c.ox, f[o + 3]! + c.oy);
        items.push({ d: f[o + 4]! - 1e-9, f: () => sink.seg(a[0], a[1], b[0], b[1], s) });
      }
    }
  }
  const gs = dl.glyphs;
  const inst = new Float32Array(gs.instances);
  for (const r of gs.runs) {
    const g = gs.glyphs[r.glyph]!;
    for (let k = r.start; k < r.start + r.count; k++) {
      const o = k * GLYPH_STRIDE;
      const s = inst[o + 9]!;
      if (!visible(s)) continue;
      const a = inst[o]!;
      const b = inst[o + 1]!;
      const c = inst[o + 2]!;
      const d = inst[o + 3]!;
      const e = inst[o + 4]! + inst[o + 5]!;
      const ff = inst[o + 6]! + inst[o + 7]!;
      if (clip && (e < clip[0] || e > clip[2] || ff < clip[1] || ff > clip[3])) continue;
      const G = (x: number, y: number) => X(a * x + c * y + e, b * x + d * y + ff);
      const depth = inst[o + 8]!;
      if (g.kind === 0) {
        const v = gs.fillVerts;
        const first = g.first;
        const count = g.count;
        items.push({
          d: depth,
          f: () => {
            for (let i = first; i + 2 < first + count; i += 3) {
              const p0 = G(v[i * 2]!, v[i * 2 + 1]!);
              const p1 = G(v[i * 2 + 2]!, v[i * 2 + 3]!);
              const p2 = G(v[i * 2 + 4]!, v[i * 2 + 5]!);
              sink.tri(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], s);
            }
          },
        });
      } else {
        const v = gs.strokeSegs;
        const first = g.first;
        const count = g.count;
        items.push({
          d: depth - 1e-9,
          f: () => {
            for (let i = first; i < first + count; i++) {
              const p0 = G(v[i * 4]!, v[i * 4 + 1]!);
              const p1 = G(v[i * 4 + 2]!, v[i * 4 + 3]!);
              sink.seg(p0[0], p0[1], p1[0], p1[1], s);
            }
          },
        });
      }
    }
  }
  items.sort((p, q) => q.d - p.d);
  for (const it of items) it.f();
}

interface Page {
  /** 출력 크기(포인트 또는 픽셀) */
  width: number;
  height: number;
  /** 그릴 장면들(순서대로), 출력 좌표 변환, 스타일 표, 자르기 */
  layers: { scene: SpaceScene; m: Affine; styles: Float32Array; clipPx?: [number, number, number, number]; clipWorld?: [number, number, number, number] }[];
  background: number;
  /** 선가중치 mm → 출력 단위 */
  lwScale: number;
}

/** 지금 공간을 출력 페이지로(배치는 용지, 모형은 지금 화면) */
function pageFor(app: App, unitsPerMm: number, fitWidth?: number): Page | null {
  const st = app.active;
  if (!st) return null;
  const scene = st.scenes.get(st.space);
  const v = app.view;
  if (st.isModel) {
    if (!scene) return null;
    const a = v.screenToWorld(0, v.height);
    const b = v.screenToWorld(v.width, 0);
    const ww = b.x - a.x;
    const wh = b.y - a.y;
    const W = fitWidth ?? v.width;
    const k = W / ww;
    const H = wh * k;
    // 흰 바탕에 출력한다(ACI 7 = 검정)
    const styles = scene.styleData(st.sceneLayers(st.space), 'export', false, 0xffffff, app.view.lwDisplay);
    return { width: W, height: H, background: 0xffffff, lwScale: unitsPerMm, layers: [{ scene, m: [k, 0, 0, -k, -a.x * k, b.y * k], styles }] };
  }
  const lay = st.layoutFor(st.space)!;
  const paper = paperInfo(lay, scene?.bounds ?? null);
  const pw = paper.maxX - paper.minX;
  const ph = paper.maxY - paper.minY;
  // 용지 1단위 = mmPerUnit mm
  const k = paper.mmPerUnit * unitsPerMm;
  const page: Page = { width: pw * k, height: ph * k, background: 0xffffff, lwScale: unitsPerMm, layers: [] };
  const model = st.scenes.get(MODEL_SPACE);
  if (model) {
    const idx = st.sceneLayerIndex(MODEL_SPACE);
    for (const vp of layoutViewports(st.doc, lay)) {
      const vx = viewportXf(st.doc, vp);
      const frozen = new Set<number>();
      for (const n of vx.frozen) {
        const i = idx.get(n);
        if (i !== undefined) frozen.add(i);
      }
      const kk = vx.k * k;
      const c = Math.cos(-vx.twist);
      const s = Math.sin(-vx.twist);
      const cx = (vp.center.x - paper.minX) * k;
      const cy = (paper.maxY - vp.center.y) * k;
      const m: Affine = [kk * c, -kk * s, -kk * s, -kk * c, 0, 0];
      m[4] = cx - (m[0] * vx.refX + m[2] * vx.refY);
      m[5] = cy - (m[1] * vx.refX + m[3] * vx.refY);
      const hw = vp.width / 2;
      const hh = vp.height / 2;
      const rad = Math.hypot(hw, hh) / vx.k;
      page.layers.push({
        scene: model,
        m,
        styles: model.styleData(st.sceneLayers(MODEL_SPACE), 'vp', false, 0xffffff, app.view.lwDisplay, frozen.size ? frozen : undefined),
        clipPx: [cx - hw * k, cy - hh * k, cx + hw * k, cy + hh * k],
        clipWorld: [vx.refX - rad, vx.refY - rad, vx.refX + rad, vx.refY + rad],
      });
    }
  }
  if (scene) page.layers.push({ scene, m: [k, 0, 0, -k, -paper.minX * k, paper.maxY * k], styles: scene.styleData(st.sceneLayers(st.space), 'paper', false, 0xffffff, app.view.lwDisplay) });
  return page;
}

function css(styles: Float32Array, s: number): string {
  const r = Math.round(styles[s * 8]! * 255);
  const g = Math.round(styles[s * 8 + 1]! * 255);
  const b = Math.round(styles[s * 8 + 2]! * 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function exportSvg(app: App): Blob | null {
  // SVG 단위 = mm(배치) 또는 화면 픽셀(모형)
  const st = app.active;
  if (!st) return null;
  const page = pageFor(app, 1);
  if (!page) return null;
  const out: string[] = [];
  const unit = st.isModel ? 'px' : 'mm';
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${page.width.toFixed(2)}${unit}" height="${page.height.toFixed(2)}${unit}" viewBox="0 0 ${page.width.toFixed(3)} ${page.height.toFixed(3)}">`);
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  let clipId = 0;
  for (const L of page.layers) {
    const styles = L.styles;
    const visible = (s: number) => styles[s * 8 + 5]! > 0;
    if (L.clipPx) {
      const [x0, y0, x1, y1] = L.clipPx;
      out.push(`<clipPath id="c${clipId}"><rect x="${x0.toFixed(3)}" y="${y0.toFixed(3)}" width="${(x1 - x0).toFixed(3)}" height="${(y1 - y0).toFixed(3)}"/></clipPath><g clip-path="url(#c${clipId})">`);
      clipId++;
    } else out.push('<g>');
    // 같은 스타일의 선분은 한 경로로 모은다
    let curStyle = -1;
    let path = '';
    let curKind: 'seg' | 'tri' | '' = '';
    const flush = () => {
      if (!path) return;
      if (curKind === 'seg') {
        const w = Math.max(0.1, styles[curStyle * 8 + 4]! * page.lwScale) || 0.25 * page.lwScale;
        out.push(`<path d="${path}" fill="none" stroke="${css(styles, curStyle)}" stroke-width="${(st.isModel ? 1 : w).toFixed(3)}" stroke-linecap="round"/>`);
      } else out.push(`<path d="${path}" fill="${css(styles, curStyle)}"/>`);
      path = '';
    };
    walk(
      L.scene.source,
      L.m,
      visible,
      {
        seg(x0, y0, x1, y1, s) {
          if (s !== curStyle || curKind !== 'seg') {
            flush();
            curStyle = s;
            curKind = 'seg';
          }
          path += `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`;
        },
        tri(x0, y0, x1, y1, x2, y2, s) {
          if (s !== curStyle || curKind !== 'tri') {
            flush();
            curStyle = s;
            curKind = 'tri';
          }
          path += `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}Z`;
        },
      },
      L.clipWorld,
    );
    flush();
    out.push('</g>');
  }
  out.push('</svg>');
  return new Blob([out.join('\n')], { type: 'image/svg+xml' });
}

export async function exportPdf(app: App): Promise<Blob | null> {
  const st = app.active;
  if (!st) return null;
  const PT_PER_MM = 72 / 25.4;
  // 모형: 지금 화면을 A3 가로(420 mm) 폭에 맞춘다
  const page = pageFor(app, PT_PER_MM, st.isModel ? 420 * PT_PER_MM : undefined);
  if (!page) return null;
  const ops: string[] = [];
  const H = page.height;
  ops.push('1 1 1 rg', `0 0 ${page.width.toFixed(2)} ${H.toFixed(2)} re f`, '1 J 1 j');
  for (const L of page.layers) {
    const styles = L.styles;
    const visible = (s: number) => styles[s * 8 + 5]! > 0;
    ops.push('q');
    if (L.clipPx) {
      const [x0, y0, x1, y1] = L.clipPx;
      ops.push(`${x0.toFixed(2)} ${(H - y1).toFixed(2)} ${(x1 - x0).toFixed(2)} ${(y1 - y0).toFixed(2)} re W n`);
    }
    let cur = -1;
    let kind = '';
    let buf: string[] = [];
    const color = (s: number) => `${styles[s * 8]!.toFixed(3)} ${styles[s * 8 + 1]!.toFixed(3)} ${styles[s * 8 + 2]!.toFixed(3)}`;
    const flush = () => {
      if (!buf.length) return;
      if (kind === 'seg') {
        const w = styles[cur * 8 + 4]! > 0 ? styles[cur * 8 + 4]! * page.lwScale : 0.25 * page.lwScale * 0.5;
        ops.push(`${color(cur)} RG ${w.toFixed(3)} w`, ...buf, 'S');
      } else ops.push(`${color(cur)} rg`, ...buf, 'f');
      buf = [];
    };
    walk(
      L.scene.source,
      L.m,
      visible,
      {
        seg(x0, y0, x1, y1, s) {
          if (s !== cur || kind !== 'seg' || buf.length > 4000) {
            flush();
            cur = s;
            kind = 'seg';
          }
          buf.push(`${x0.toFixed(2)} ${(H - y0).toFixed(2)} m ${x1.toFixed(2)} ${(H - y1).toFixed(2)} l`);
        },
        tri(x0, y0, x1, y1, x2, y2, s) {
          if (s !== cur || kind !== 'tri' || buf.length > 4000) {
            flush();
            cur = s;
            kind = 'tri';
          }
          buf.push(`${x0.toFixed(2)} ${(H - y0).toFixed(2)} m ${x1.toFixed(2)} ${(H - y1).toFixed(2)} l ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l h`);
        },
      },
      L.clipWorld,
    );
    flush();
    ops.push('Q');
  }
  const content = new TextEncoder().encode(ops.join('\n'));
  const compressed = await deflate(content);
  return buildPdf(page.width, page.height, compressed ?? content, !!compressed, st.name);
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function buildPdf(w: number, h: number, content: Uint8Array, flate: boolean, title: string): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const add = (b: Uint8Array | string) => {
    const u = typeof b === 'string' ? enc.encode(b) : b;
    parts.push(u);
    pos += u.length;
  };
  const obj = (n: number, body: string | (() => void)) => {
    offsets[n] = pos;
    add(`${n} 0 obj\n`);
    if (typeof body === 'string') add(body);
    else body();
    add('\nendobj\n');
  };
  const t = title.replace(/[()\\]/g, '');
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Contents 4 0 R /Resources << >> >>`);
  obj(4, () => {
    add(`<< /Length ${content.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
    add(content);
    add('\nendstream');
  });
  obj(5, `<< /Producer (OpenCAD 2D Viewer) /Title (${/^[\x20-\x7e]*$/.test(t) ? t : 'drawing'}) >>`);
  const xref = pos;
  add(`xref\n0 6\n0000000000 65535 f \n`);
  for (let i = 1; i <= 5; i++) add(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

export async function exportPng(app: App, scale = 2): Promise<Blob | null> {
  const v = app.view;
  if (!app.active) return null;
  // 지금 화면을 장치 픽셀 그대로 다시 그려 저장한다(오버레이 제외)
  void scale;
  v.renderGL();
  return new Promise((resolve) => v.glCanvas.toBlob((b) => resolve(b), 'image/png'));
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function baseName(name: string): string {
  return name.replace(/\.(dxf|dwg)$/i, '');
}
