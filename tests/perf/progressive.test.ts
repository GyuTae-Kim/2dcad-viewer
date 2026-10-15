/**
 * 점진 빌드: 만드는 동안 보내는 미리 보기 조각이 최종 장면의 그림을 빠짐없이 한 번씩 담는지,
 * 조각을 보내도 최종 장면(지문)이 그대로인지, 첫 화면에 보이는 객체만 먼저 그리는 미리 보기.
 */
import { describe, expect, it } from 'vitest';
import { readDxf } from '../../src/io/dxf/reader';
import { type PartialScene, SceneBuilder, buildSpace } from '../../src/render/build';
import { type DisplayList, GLYPH_STRIDE, SEG_STRIDE, TRI_STRIDE, unpackBoxes } from '../../src/render/displaylist';
import { anchorOf, planPreview } from '../../src/render/preview';
import { TextEngine } from '../../src/text/layout';
import { OutlineLibrary } from '../../src/text/fonts';
import { collectTextUsage } from '../../src/text/collect';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CadDocument } from '../../src/core/model';
import { syntheticDxf } from './synthetic';

async function textEngine(doc: CadDocument): Promise<TextEngine> {
  const lib = new OutlineLibrary(resolve('public/fonts/noto-sans-kr') + '/', async (url) => {
    const b = readFileSync(url);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
  const usage = collectTextUsage(doc);
  if (usage.needsOutline) await Promise.all([lib.require(usage.codes), lib.requireLatin(usage.latin)]);
  return new TextEngine(lib);
}

/** 깊이(그리기 순서)별 선분 끝점 절대 좌표 합 — 조각과 최종 장면의 그림을 견준다 */
function segSums(list: DisplayList, out = new Map<number, number>()): Map<number, number> {
  for (const c of list.chunks)
    for (const [buf, n] of [
      [c.segs, c.segCount],
      [c.tsegs, c.tsegCount],
    ] as const) {
      const f = new Float32Array(buf);
      for (let i = 0; i < n; i++) {
        const o = i * SEG_STRIDE;
        const d = f[o + 4]!;
        out.set(d, (out.get(d) ?? 0) + f[o]! + c.ox + f[o + 1]! + c.oy + f[o + 2]! + c.ox + f[o + 3]! + c.oy);
      }
    }
  return out;
}

const counts = (l: DisplayList) => {
  const r = { segs: 0, tris: 0, tsegs: 0, ttris: 0, glyphs: l.glyphs.instanceCount };
  for (const c of l.chunks) {
    r.segs += c.segCount;
    r.tris += c.triCount;
    r.tsegs += c.tsegCount;
    r.ttris += c.ttriCount;
  }
  return r;
};

describe('점진 빌드', () => {
  it('조각들이 최종 장면의 그림을 빠짐없이 한 번씩 담고, 최종 장면은 그대로다', async () => {
    const doc = readDxf(syntheticDxf(4000));
    const text = await textEngine(doc);
    const plain = buildSpace(doc, '*Model_Space', { text, packBoxes: true }).list;
    const parts: PartialScene[] = [];
    const withParts = buildSpace(doc, '*Model_Space', { text, packBoxes: true, onPartial: (p) => parts.push(structuredClone(p)), partialView: { origin: [5000, 5000] }, partialInterval: 0 }).list;
    expect(parts.length).toBeGreaterThan(5);
    // 최종 장면은 조각을 보내지 않을 때와 바이트까지 같다
    expect(withParts.chunks.length).toBe(plain.chunks.length);
    withParts.chunks.forEach((c, i) => {
      const a = plain.chunks[i]!;
      expect(new Uint8Array(c.segs)).toEqual(new Uint8Array(a.segs));
      expect(new Uint8Array(c.tris)).toEqual(new Uint8Array(a.tris));
      expect(c.segCount).toBe(a.segCount);
    });
    expect(new Uint8Array(withParts.glyphs.instances)).toEqual(new Uint8Array(plain.glyphs.instances));
    expect(unpackBoxes(withParts.packed!)).toEqual(unpackBoxes(plain.packed!));
    // 조각을 모두 합치면 최종 장면과 같은 수
    const sum = { segs: 0, tris: 0, tsegs: 0, ttris: 0, glyphs: 0 };
    for (const p of parts) {
      const c = counts(p.list);
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += c[k];
      // 조각은 묶음 하나(원점은 준 값), 객체 상자 없음
      expect(p.list.chunks.length).toBeLessThanOrEqual(1);
      if (p.list.chunks[0]) expect([p.list.chunks[0].ox, p.list.chunks[0].oy]).toEqual([5000, 5000]);
      expect(p.list.entities).toEqual([]);
      // 스타일 표는 갈수록 길어진다(앞 조각의 번호가 그대로)
      expect(p.styles.length).toBeLessThanOrEqual(parts[parts.length - 1]!.styles.length);
    }
    expect(sum).toEqual(counts(plain));
    // 같은 그림(깊이별 선분 좌표 합)
    const a = segSums(plain);
    const b = new Map<number, number>();
    for (const p of parts) segSums(p.list, b);
    expect(b.size).toBe(a.size);
    for (const [d, v] of a) expect(Math.abs((b.get(d) ?? NaN) - v)).toBeLessThan(Math.max(1e-3, Math.abs(v) * 1e-6));
    // 글리프 인스턴스: 같은 변환(이동은 hi + lo)들
    const key = (f: Float32Array, o: number) => `${f[o + 8]}|${(f[o + 4]! + f[o + 5]!).toFixed(3)}|${(f[o + 6]! + f[o + 7]!).toFixed(3)}`;
    const want = new Map<string, number>();
    const fi = new Float32Array(plain.glyphs.instances);
    for (let i = 0; i < plain.glyphs.instanceCount; i++) want.set(key(fi, i * GLYPH_STRIDE), (want.get(key(fi, i * GLYPH_STRIDE)) ?? 0) + 1);
    for (const p of parts) {
      const f = new Float32Array(p.list.glyphs.instances);
      for (let i = 0; i < p.list.glyphs.instanceCount; i++) {
        const k = key(f, i * GLYPH_STRIDE);
        expect(want.get(k)).toBeGreaterThan(0);
        want.set(k, want.get(k)! - 1);
      }
      // 조각의 글리프 묶음(run)은 조각의 인스턴스를 덮고 조각 글리프 표를 가리킨다
      for (const r of p.list.glyphs.runs) expect(r.glyph).toBeLessThan(p.list.glyphs.glyphs.length);
      expect(p.list.glyphs.runs.reduce((n, r) => n + r.count, 0)).toBe(p.list.glyphs.instanceCount);
    }
    expect([...want.values()].every((v) => v === 0)).toBe(true);
    void TRI_STRIDE;
  });

  it('미리 보기 화면을 주면 화면 밖 묶음·반 픽셀보다 작은 객체의 나머지 선분·작은 글자를 뺀다(최종 장면은 그대로)', async () => {
    const doc = readDxf(syntheticDxf(4000));
    const text = await textEngine(doc);
    const plain = buildSpace(doc, '*Model_Space', { text }).list;
    const full = counts(plain);
    const run = (view: Parameters<typeof buildSpace>[2]['partialView']) => {
      const parts: PartialScene[] = [];
      const list = buildSpace(doc, '*Model_Space', { text, onPartial: (p) => parts.push(p), partialView: view, partialInterval: 0 }).list;
      expect(new Uint8Array(list.chunks[0]!.segs)).toEqual(new Uint8Array(plain.chunks[0]!.segs));
      const sum = { segs: 0, tris: 0, tsegs: 0, ttris: 0, glyphs: 0 };
      for (const p of parts) {
        const c = counts(p.list);
        for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += c[k];
      }
      return { parts, sum };
    };
    const ext: [number, number, number, number] = [plain.minX, plain.minY, plain.maxX, plain.maxY];
    const cx = (ext[0] + ext[2]) / 2;
    const cy = (ext[1] + ext[3]) / 2;
    // 전체가 100픽셀인 화면: 작은 객체는 선분 하나씩만, 작은 글자는 빠진다
    const far = run({ origin: [cx, cy], rect: ext, pxPerUnit: 100 / (ext[2] - ext[0]) });
    expect(far.sum.segs).toBeLessThan(full.segs * 0.95);
    expect(far.sum.glyphs).toBeLessThan(full.glyphs);
    // 그래도 그림이 있는 깊이(객체)는 모두 남는다
    const a = segSums(plain);
    const b = new Map<number, number>();
    for (const p of far.parts) segSums(p.list, b);
    expect(b.size).toBe(a.size);
    // 화면이 아주 크면(모두 반 픽셀보다 크다) 모두 그대로
    const near = run({ origin: [cx, cy], rect: ext, pxPerUnit: 1e6 });
    expect(near.sum).toEqual(full);
    // 화면이 도면 밖이면 조각이 비고, 최종 장면은 그대로
    const away = run({ origin: [cx, cy], rect: [ext[2] + 1e6, ext[3] + 1e6, ext[2] + 2e6, ext[3] + 2e6] });
    expect(away.sum).toEqual({ segs: 0, tris: 0, tsegs: 0, ttris: 0, glyphs: 0 });
  });

  it('미리 보기는 고른 객체만 그리고 깊이는 전체 순서 그대로다', async () => {
    const doc = readDxf(syntheticDxf(3000));
    const text = new TextEngine(null);
    const full = buildSpace(doc, '*Model_Space', { text }).list;
    const ents = doc.blocks.get('*MODEL_SPACE')!.entities;
    const pick = new Set(ents.filter((_, i) => i % 3 === 0).map((e) => e.handle));
    const pv = new SceneBuilder(doc, { text }).buildPreview('*Model_Space', (_i, e) => pick.has(e.handle), { origin: [0, 0] });
    // 고른 객체의 선분 수
    let want = 0;
    for (const b of full.entities) if (pick.has(b.handle)) want += (b.seg?.[1] ?? 0) + (b.tseg?.[1] ?? 0);
    expect(counts(pv.list).segs + counts(pv.list).tsegs).toBe(want);
    // 같은 깊이의 같은 좌표
    const a = segSums(full);
    for (const [d, v] of segSums(pv.list)) expect(Math.abs(a.get(d)! - v)).toBeLessThan(Math.max(1e-3, Math.abs(v) * 1e-6));
  });

  it('첫 화면: 전체가 보이면 먼저 그릴 것이 없고, 저장된 뷰가 일부만 보이면 그 안의 객체를 고른다', () => {
    const doc = readDxf(syntheticDxf(3000));
    const ents = doc.blocks.get('*MODEL_SPACE')!.entities;
    doc.vports = doc.vports.filter((v) => v.name.toUpperCase() !== '*ACTIVE');
    const all = planPreview(doc, '*Model_Space', 16 / 9)!;
    expect(all.only).toBeUndefined();
    expect(all.margin).toBe(0.04);
    // 대표점을 모두 덮는다
    for (const e of ents) {
      const a = anchorOf(e);
      if (a) expect(a[0] >= all.visible[0] && a[0] <= all.visible[2] && a[1] >= all.visible[1] && a[1] <= all.visible[3]).toBe(true);
    }
    // 가운데를 작게 본 *Active 뷰
    const w = all.rect[2] - all.rect[0];
    const cx = (all.rect[0] + all.rect[2]) / 2;
    const cy = (all.rect[1] + all.rect[3]) / 2;
    doc.vports.push({ name: '*Active', handle: '', flags: 0, lowerLeft: { x: 0, y: 0 }, upperRight: { x: 1, y: 1 }, center: { x: cx, y: cy }, snapBase: { x: 0, y: 0 }, snapSpacing: { x: 1, y: 1 }, gridSpacing: { x: 1, y: 1 }, viewDirection: { x: 0, y: 0, z: 1 }, viewTarget: { x: 0, y: 0, z: 0 }, height: w / 10, aspect: 1.5, lensLength: 50, twist: 0 } as CadDocument['vports'][number]);
    const sub = planPreview(doc, '*Model_Space', 16 / 9)!;
    expect(sub.only).toBeDefined();
    expect(sub.rect[3] - sub.rect[1]).toBeCloseTo(w / 10);
    const picked = ents.filter((e, i) => sub.only!(i, e));
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.length).toBeLessThan(ents.length / 5);
  });
});
