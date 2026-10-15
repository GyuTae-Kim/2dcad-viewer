/**
 * 큰 도면용 장면 빌더 경로 검사(합성 도면).
 * - 표시 목록 빌더(형식 배열 임시 그림·글리프 셈 정렬·빈 범위 생략)가 만든 색인이 서로 맞는지
 * - 워커 → 메인 전송용 상자 묶기(packBoxes/unpackBoxes)가 상자를 그대로 되살리는지
 * - 장면 만들기 진행률
 * - PERF=1이면: 고치기 전 코드로 만든 장면 지문과 같은지(10k 합성 도면), 큰 도면 측정
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readDxf } from '../../src/io/dxf/reader';
import { readCadFile } from '../../src/io/index';
import { buildSpace } from '../../src/render/build';
import { type DisplayList, SEG_STRIDE, TRI_STRIDE, packBoxes, unpackBoxes } from '../../src/render/displaylist';
import { TextEngine } from '../../src/text/layout';
import { OutlineLibrary } from '../../src/text/fonts';
import { collectTextUsage } from '../../src/text/collect';
import type { CadDocument } from '../../src/core/model';
import { syntheticDxf } from './synthetic';

const PERF = !!process.env.PERF;

async function textEngine(doc: CadDocument): Promise<TextEngine> {
  const lib = new OutlineLibrary(resolve('public/fonts/noto-sans-kr') + '/', async (url) => {
    const b = readFileSync(url);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
  const usage = collectTextUsage(doc);
  if (usage.needsOutline) await Promise.all([lib.require(usage.codes), lib.requireLatin(usage.latin)]);
  return new TextEngine(lib);
}

/** scripts/perf/measure.ts와 같은 장면 지문(빈 범위는 없는 것과 같게 본다) */
function sceneHash(dl: DisplayList): string {
  const h = createHash('sha1');
  const rng = (r: [number, number] | undefined) => (r && r[1] ? `${r[0]}+${r[1]}` : '');
  for (const c of dl.chunks) {
    h.update(`${c.key}|${c.ox}|${c.oy}|${c.minX}|${c.minY}|${c.maxX}|${c.maxY}|${c.segCount}|${c.triCount}|${c.tsegCount}|${c.ttriCount}`);
    h.update(new Uint8Array(c.segs));
    h.update(new Uint8Array(c.tris));
    h.update(new Uint8Array(c.tsegs));
    h.update(new Uint8Array(c.ttris));
  }
  h.update(new Uint8Array(dl.glyphs.instances));
  h.update(new Uint8Array(dl.glyphs.fillVerts.buffer, dl.glyphs.fillVerts.byteOffset, dl.glyphs.fillVerts.byteLength));
  h.update(new Uint8Array(dl.glyphs.strokeSegs.buffer, dl.glyphs.strokeSegs.byteOffset, dl.glyphs.strokeSegs.byteLength));
  h.update(JSON.stringify(dl.glyphs.runs));
  h.update(JSON.stringify(dl.glyphs.glyphs));
  for (const b of dl.entities) h.update(`${b.handle},${b.minX},${b.minY},${b.maxX},${b.maxY},${b.chunk},${rng(b.seg)},${rng(b.tseg)},${rng(b.tri)},${rng(b.ttri)},${b.glyphs ?? ''};`);
  h.update(JSON.stringify([dl.minX, dl.minY, dl.maxX, dl.maxY, dl.xlines, dl.xlineHandles, dl.dashed ?? false]));
  return h.digest('hex').slice(0, 16);
}

/** 범위들이 [0, total)을 겹치지 않고 빠짐없이 덮는지 */
function coversExactly(ranges: [number, number][], total: number): boolean {
  const sorted = ranges.filter((r) => r[1] > 0).sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [s, n] of sorted) {
    if (s !== at) return false;
    at = s + n;
  }
  return at === total;
}

describe('큰 도면 장면 경로', () => {
  it('상자 범위·묶음·글리프 인스턴스 색인이 서로 맞다', async () => {
    const doc = readDxf(syntheticDxf(4000));
    const dl = buildSpace(doc, '*Model_Space', { text: await textEngine(doc) }).list;
    expect(dl.entities.length).toBeGreaterThan(3500);
    expect(dl.glyphs.instanceCount).toBeGreaterThan(1000);
    // 묶음마다 상자 범위가 선분·삼각형을 정확히 덮는다
    for (let ci = 0; ci < dl.chunks.length; ci++) {
      const c = dl.chunks[ci]!;
      const mine = dl.entities.filter((b) => b.chunk === ci);
      expect(coversExactly(mine.map((b) => b.seg ?? [0, 0]), c.segCount)).toBe(true);
      expect(coversExactly(mine.map((b) => b.tseg ?? [0, 0]), c.tsegCount)).toBe(true);
      expect(coversExactly(mine.map((b) => b.tri ?? [0, 0]), c.triCount)).toBe(true);
      expect(coversExactly(mine.map((b) => b.ttri ?? [0, 0]), c.ttriCount)).toBe(true);
      expect(c.segs.byteLength).toBe(c.segCount * SEG_STRIDE * 4);
      expect(c.tris.byteLength).toBe(c.triCount * TRI_STRIDE * 4 * 3);
    }
    // 빈 범위는 두지 않는다
    for (const b of dl.entities) for (const r of [b.seg, b.tseg, b.tri, b.ttri]) if (r) expect(r[1]).toBeGreaterThan(0);
    // 글리프 묶음(run)은 이어지고 인스턴스를 모두 덮으며, 상자의 글리프 번호는 한 번씩만 나온다
    const runs = dl.glyphs.runs;
    expect(coversExactly(runs.map((r) => [r.start, r.count]), dl.glyphs.instanceCount)).toBe(true);
    const seen = new Uint8Array(dl.glyphs.instanceCount);
    for (const b of dl.entities)
      for (const k of b.glyphs ?? []) {
        expect(seen[k]).toBe(0);
        seen[k] = 1;
      }
    // 불투명 묶음이 투명 묶음보다 앞
    const firstT = runs.findIndex((r) => r.transparent);
    if (firstT >= 0) expect(runs.slice(firstT).every((r) => r.transparent)).toBe(true);
  });

  it('상자 묶기·풀기(전송)는 상자를 그대로 되살린다', async () => {
    const doc = readDxf(syntheticDxf(2000));
    const dl = buildSpace(doc, '*Model_Space', { text: await textEngine(doc) }).list;
    const packed = packBoxes(dl.entities);
    const copy = structuredClone(packed, { transfer: [packed.bounds.buffer as ArrayBuffer, packed.ranges.buffer as ArrayBuffer, packed.glyphs.buffer as ArrayBuffer] });
    expect(unpackBoxes(copy)).toEqual(dl.entities);
    // 핸들에 줄바꿈이 있어도
    const odd = [{ handle: 'A\nB', minX: 0, minY: 0, maxX: 1, maxY: 1 }, { handle: 'C', minX: 1, minY: 1, maxX: 2, maxY: 2, chunk: 0, seg: [3, 2] as [number, number], glyphs: [1, 2] }];
    expect(unpackBoxes(packBoxes(odd))).toEqual(odd);
    expect(unpackBoxes(packBoxes([]))).toEqual([]);
  });

  it('상자를 형식 배열로만 만든 장면(packBoxes, 워커 경로)은 상자 객체 장면과 같다', async () => {
    const doc = readDxf(syntheticDxf(2000));
    const text = await textEngine(doc);
    const a = buildSpace(doc, '*Model_Space', { text }).list;
    const b = buildSpace(doc, '*Model_Space', { text, packBoxes: true }).list;
    expect(b.entities).toEqual([]);
    expect(a.packed).toBeUndefined();
    const boxes = unpackBoxes(b.packed!);
    expect(boxes).toEqual(a.entities);
    expect(sceneHash({ ...b, entities: boxes })).toBe(sceneHash(a));
  });

  it('장면 만들기 진행률은 0에서 1 쪽으로 늘어난다', async () => {
    const doc = readDxf(syntheticDxf(1500));
    const seen: number[] = [];
    buildSpace(doc, '*Model_Space', { text: new TextEngine(null), onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(10);
    expect(seen[0]).toBe(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(seen[seen.length - 1]!).toBeLessThan(1);
  });

  it.skipIf(!PERF)('PERF: 10k 합성 도면 장면 지문이 고치기 전 코드와 같다', async () => {
    const doc = readDxf(syntheticDxf(10000, 300));
    const dl = buildSpace(doc, '*Model_Space', { text: await textEngine(doc) }).list;
    // scripts/perf/measure.ts --hash로 고치기 전(2026-10-15) 코드에서 얻은 값
    expect(sceneHash(dl)).toBe('bdf43a0598033f54');
  });

  it.skipIf(!PERF)('PERF: 큰 합성 도면 읽기·장면 시간과 힙', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    const heap = () => {
      gc?.();
      return Math.round(process.memoryUsage().heapUsed / 1048576);
    };
    const rows: Record<string, number | string>[] = [];
    for (const n of [50_000, 200_000]) {
      const data = syntheticDxf(n, 300);
      const h0 = heap();
      let t = performance.now();
      const doc = readCadFile(data, 'big.dxf');
      const readMs = performance.now() - t;
      const h1 = heap();
      const text = await textEngine(doc);
      t = performance.now();
      const s = buildSpace(doc, '*Model_Space', { text });
      const sceneMs = performance.now() - t;
      rows.push({ n, MB: +(data.length / 1048576).toFixed(1), readMs: Math.round(readMs), sceneMs: Math.round(sceneMs), docHeapMB: h1 - h0, sceneHeapMB: heap() - h1, chunks: s.list.chunks.length });
      expect(s.list.entities.length).toBeGreaterThan(n * 0.9);
    }
    console.table(rows);
  });
});
