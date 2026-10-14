/**
 * 개발용: 도면 → 장면 빌더 → SVG(→ PNG). 브라우저 없이 그림을 확인한다.
 * 사용법: npx vite-node scripts/dev/render.ts 입력.dxf 출력.svg [공간 블록 이름]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDxf } from '../../src/io/dxf/reader';
import { buildSpace } from '../../src/render/build';
import { resolveStyles } from '../../src/render/styles';
import { OutlineLibrary } from '../../src/text/fonts';
import { TextEngine } from '../../src/text/layout';
import { collectTextUsage } from '../../src/text/collect';
import { SEG_STRIDE, TRI_STRIDE } from '../../src/render/displaylist';

async function main() {
  const [, , input, output, space] = process.argv;
  if (!input || !output) throw new Error('입력과 출력 경로가 필요합니다');
  const data = new Uint8Array(readFileSync(input));
  let doc;
  if (input.toLowerCase().endsWith('.dwg')) {
    const mod = await import('../../src/io/dwg/index');
    doc = mod.readDwg(data);
  } else doc = readDxf(data);
  const fontDir = resolve('public/fonts/noto-sans-kr') + '/';
  const lib = new OutlineLibrary(fontDir, async (url) => {
    const b = readFileSync(url);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
  const usage = collectTextUsage(doc);
  if (usage.needsOutline) await lib.require(usage.codes);
  const t0 = performance.now();
  const scene = buildSpace(doc, space ?? '*Model_Space', { text: new TextEngine(lib) });
  const ms = performance.now() - t0;
  const dl = scene.list;
  const styles = resolveStyles(scene.styles, scene.layers, { darkBackground: false, backgroundRgb: 0xffffff, showLineweight: false, defaultLineweight: 25 });
  const col = (s: number) => {
    const r = Math.round(styles[s * 8]! * 255);
    const g = Math.round(styles[s * 8 + 1]! * 255);
    const b = Math.round(styles[s * 8 + 2]! * 255);
    return `rgb(${r},${g},${b})`;
  };
  const visible = (s: number) => styles[s * 8 + 5]! > 0;
  // CROP=x0,y0,x1,y1 이면 그 영역만
  const crop = process.env.CROP?.split(',').map(Number);
  if (crop && crop.length === 4) {
    dl.minX = crop[0]!;
    dl.minY = crop[1]!;
    dl.maxX = crop[2]!;
    dl.maxY = crop[3]!;
  }
  const W = dl.maxX - dl.minX || 1;
  const H = dl.maxY - dl.minY || 1;
  const pad = Math.max(W, H) * 0.02;
  const parts: string[] = [];
  let segs = 0;
  let tris = 0;
  // 깊이(그리기 순서)대로 그린다: 큰 depth 먼저
  const items: { d: number; svg: string }[] = [];
  for (const c of dl.chunks) {
    for (const [buf, count] of [
      [c.tris, c.triCount],
      [c.ttris, c.ttriCount],
    ] as const) {
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      for (let i = 0; i < count; i++) {
        const o = i * 3 * TRI_STRIDE;
        const s = u[o + 3]!;
        if (!visible(s)) continue;
        const pts = [0, 1, 2].map((k) => `${(f[o + k * TRI_STRIDE]! + c.ox).toFixed(4)},${(-(f[o + k * TRI_STRIDE + 1]! + c.oy)).toFixed(4)}`).join(' ');
        items.push({ d: f[o + 2]!, svg: `<polygon points="${pts}" fill="${col(s)}" stroke="${col(s)}" stroke-width="0.25" vector-effect="non-scaling-stroke"/>` });
        tris++;
      }
    }
    for (const [buf, count] of [
      [c.segs, c.segCount],
      [c.tsegs, c.tsegCount],
    ] as const) {
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      for (let i = 0; i < count; i++) {
        const o = i * SEG_STRIDE;
        const s = u[o + 5]!;
        if (!visible(s)) continue;
        const x0 = f[o]! + c.ox;
        const y0 = f[o + 1]! + c.oy;
        const x1 = f[o + 2]! + c.ox;
        const y1 = f[o + 3]! + c.oy;
        items.push({ d: f[o + 4]! - 1e-9, svg: `<line x1="${x0.toFixed(4)}" y1="${(-y0).toFixed(4)}" x2="${x1.toFixed(4)}" y2="${(-y1).toFixed(4)}" stroke="${col(s)}"/>` });
        segs++;
      }
    }
  }
  // 글리프 인스턴스 펼치기
  const gs = dl.glyphs;
  const inst = new Float32Array(gs.instances);
  for (const run of gs.runs) {
    const g = gs.glyphs[run.glyph]!;
    for (let k = run.start; k < run.start + run.count; k++) {
      const o = k * 12;
      const a = inst[o]!, b = inst[o + 1]!, c = inst[o + 2]!, d = inst[o + 3]!;
      const e = inst[o + 4]! + inst[o + 5]!;
      const f = inst[o + 6]! + inst[o + 7]!;
      const depth = inst[o + 8]!;
      const s = inst[o + 9]!;
      if (!visible(s)) continue;
      const X = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
      if (g.kind === 0) {
        const v = gs.fillVerts;
        let path = '';
        for (let i = g.first; i < g.first + g.count; i += 3) {
          const p = [0, 1, 2].map((q) => X(v[(i + q) * 2]!, v[(i + q) * 2 + 1]!));
          path += `M${p[0]![0]!.toFixed(4)} ${(-p[0]![1]!).toFixed(4)}L${p[1]![0]!.toFixed(4)} ${(-p[1]![1]!).toFixed(4)}L${p[2]![0]!.toFixed(4)} ${(-p[2]![1]!).toFixed(4)}Z`;
        }
        items.push({ d: depth, svg: `<path d="${path}" fill="${col(s)}"/>` });
        tris += g.count / 3;
      } else {
        const v = gs.strokeSegs;
        let path = '';
        for (let i = g.first; i < g.first + g.count; i++) {
          const p0 = X(v[i * 4]!, v[i * 4 + 1]!);
          const p1 = X(v[i * 4 + 2]!, v[i * 4 + 3]!);
          path += `M${p0[0]!.toFixed(4)} ${(-p0[1]!).toFixed(4)}L${p1[0]!.toFixed(4)} ${(-p1[1]!).toFixed(4)}`;
        }
        items.push({ d: depth - 1e-9, svg: `<path d="${path}" fill="none" stroke="${col(s)}" vector-effect="non-scaling-stroke"/>` });
        segs += g.count;
      }
    }
  }
  items.sort((a, b) => b.d - a.d);
  for (const it of items) parts.push(it.svg);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${dl.minX - pad} ${-dl.maxY - pad} ${W + pad * 2} ${H + pad * 2}" width="1600" height="${Math.round((1600 * (H + pad * 2)) / (W + pad * 2))}">
<rect x="${dl.minX - pad}" y="${-dl.maxY - pad}" width="${W + pad * 2}" height="${H + pad * 2}" fill="white"/>
<g stroke-width="0.6" vector-effect="non-scaling-stroke" stroke-linecap="round" style="vector-effect:non-scaling-stroke">
${parts.map((p) => p.replace('<line ', '<line vector-effect="non-scaling-stroke" ')).join('\n')}
</g></svg>`;
  writeFileSync(output, svg);
  console.log(JSON.stringify({ ms: Math.round(ms), chunks: dl.chunks.length, segs, tris, glyphDefs: gs.glyphs.length, glyphInstances: gs.instanceCount, styles: scene.styles.size, entities: dl.entities.length, warnings: scene.warnings, docWarnings: doc.warnings.map((w) => w.code) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
