/**
 * 표시 목록에서 고른 객체의 그림만 남긴 사본(WMFOUT이 고른 객체만 내보낼 때).
 * 객체 상자(EntityBox)의 묶음 번호·범위(선분·삼각형)와 글리프 인스턴스 번호로 골라 낸다.
 */
import type { ChunkData, DisplayList, EntityBox } from '../../render/displaylist';
import { GLYPH_STRIDE, SEG_STRIDE, TRI_STRIDE } from '../../render/displaylist';

type Range = [number, number];

function copyRanges(buf: ArrayBuffer, stride: number, ranges: Range[]): { buf: ArrayBuffer; count: number } {
  const src = new Uint32Array(buf);
  let count = 0;
  for (const [, n] of ranges) count += n;
  const out = new Uint32Array(count * stride);
  let o = 0;
  for (const [s, n] of ranges) {
    out.set(src.subarray(s * stride, (s + n) * stride), o);
    o += n * stride;
  }
  return { buf: out.buffer, count };
}

/** handles에 든 객체의 그림만 남긴 표시 목록(무한선·이미지·외부 참조는 뺀다) */
export function filterDisplayList(dl: DisplayList, boxes: readonly EntityBox[], handles: ReadonlySet<string>): DisplayList {
  const per = new Map<number, { seg: Range[]; tseg: Range[]; tri: Range[]; ttri: Range[] }>();
  const inst = new Set<number>();
  const kept: EntityBox[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    if (!handles.has(b.handle)) continue;
    kept.push(b);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
    for (const g of b.glyphs ?? []) inst.add(g);
    if (b.chunk === undefined || b.chunk < 0) continue;
    let r = per.get(b.chunk);
    if (!r) per.set(b.chunk, (r = { seg: [], tseg: [], tri: [], ttri: [] }));
    if (b.seg) r.seg.push(b.seg);
    if (b.tseg) r.tseg.push(b.tseg);
    if (b.tri) r.tri.push(b.tri);
    if (b.ttri) r.ttri.push(b.ttri);
  }
  const chunks: ChunkData[] = [];
  for (const [ci, r] of [...per].sort((a, b) => a[0] - b[0])) {
    const c = dl.chunks[ci];
    if (!c) continue;
    const segs = copyRanges(c.segs, SEG_STRIDE, r.seg);
    const tsegs = copyRanges(c.tsegs, SEG_STRIDE, r.tseg);
    // 삼각형 하나 = 정점 셋
    const tris = copyRanges(c.tris, TRI_STRIDE * 3, r.tri);
    const ttris = copyRanges(c.ttris, TRI_STRIDE * 3, r.ttri);
    chunks.push({ ...c, segs: segs.buf, segCount: segs.count, tsegs: tsegs.buf, tsegCount: tsegs.count, tris: tris.buf, triCount: tris.count, ttris: ttris.buf, ttriCount: ttris.count });
  }
  // 글리프 인스턴스: 묶음(run)마다 고른 것만
  const gs = dl.glyphs;
  const src = new Float32Array(gs.instances);
  const keep: number[] = [];
  const runs: DisplayList['glyphs']['runs'] = [];
  for (const run of gs.runs) {
    const start = keep.length;
    for (let k = run.start; k < run.start + run.count; k++) if (inst.has(k)) keep.push(k);
    if (keep.length > start) runs.push({ glyph: run.glyph, start, count: keep.length - start, transparent: run.transparent });
  }
  const out = new Float32Array(keep.length * GLYPH_STRIDE);
  keep.forEach((k, i) => out.set(src.subarray(k * GLYPH_STRIDE, (k + 1) * GLYPH_STRIDE), i * GLYPH_STRIDE));
  return {
    chunks,
    glyphs: { ...gs, instances: out.buffer, runs, instanceCount: keep.length },
    entities: kept,
    minX,
    minY,
    maxX,
    maxY,
    xlines: [],
    xlineHandles: [],
  };
}
