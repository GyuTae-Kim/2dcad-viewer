/**
 * 묶음 무리(단계별 묶음): 작은 묶음을 큰 칸마다 합친 버퍼가 원래 묶음과 같은 그림(좌표·깊이·스타일)인지,
 * 전체 보기에서 그리기 단위가 크게 주는지, 확대하면 원래 묶음으로 돌아가는지.
 */
import { describe, expect, it } from 'vitest';
import { readCadFile } from '../../src/io/index';
import { buildSpace } from '../../src/render/build';
import { type ChunkData, SEG_STRIDE, TRI_STRIDE } from '../../src/render/displaylist';
import { type ChunkKind, drawWhole, elementBytes, mergeGroup, planChunkGroups, rebaseInto } from '../../src/render/chunkgroups';
import { TextEngine } from '../../src/text/layout';
import { syntheticDxf } from './synthetic';

const KINDS: ChunkKind[] = ['segs', 'tris', 'tsegs', 'ttris'];
const count = (c: ChunkData, k: ChunkKind) => (k === 'segs' ? c.segCount : k === 'tris' ? c.triCount : k === 'tsegs' ? c.tsegCount : c.ttriCount);

function scene() {
  const doc = readCadFile(syntheticDxf(20000), 'syn.dxf');
  return buildSpace(doc, '*Model_Space', { text: new TextEngine(null) }).list;
}

describe('묶음 무리', () => {
  const list = scene();

  it('작은 묶음은 모두 무리에 들고, 무리 수는 묶음 수보다 훨씬 적다', () => {
    const plan = planChunkGroups(list.chunks)!;
    expect(plan).not.toBeNull();
    expect(list.chunks.length).toBeGreaterThan(150);
    const grouped = [...plan.groupOf].filter((g) => g >= 0).length;
    // 무리에 들지 않는 큰 묶음은 몇 개뿐
    expect(list.chunks.length - grouped).toBeLessThan(list.chunks.length * 0.15);
    expect(plan.groups.length).toBeLessThan(list.chunks.length / 3);
    expect(plan.groups.length).toBeLessThanOrEqual(81);
    // 묶음 하나는 한 무리에만
    const seen = new Set<number>();
    for (const g of plan.groups)
      for (const m of g.members) {
        expect(seen.has(m)).toBe(false);
        seen.add(m);
        expect(plan.groupOf[m]).toBe(plan.groups.indexOf(g));
        const c = list.chunks[m]!;
        expect(c.minX >= g.minX && c.maxX <= g.maxX && c.minY >= g.minY && c.maxY <= g.maxY).toBe(true);
      }
    // 묶음이 적으면 무리를 만들지 않는다
    expect(planChunkGroups(list.chunks.slice(0, 10))).toBeNull();
  });

  it('무리 버퍼는 원래 묶음 그림을 같은 자리(무리 원점 기준)·같은 깊이·스타일로 이어 붙인다', () => {
    const plan = planChunkGroups(list.chunks)!;
    let checked = 0;
    for (const g of plan.groups) {
      for (const kind of KINDS) {
        const m = mergeGroup(list.chunks, g, kind);
        const f = new Float32Array(m.data);
        const u = new Uint32Array(m.data);
        const stride = kind === 'segs' || kind === 'tsegs' ? SEG_STRIDE : TRI_STRIDE * 3;
        const xy = kind === 'segs' || kind === 'tsegs' ? [0, 2] : [0, TRI_STRIDE, TRI_STRIDE * 2];
        const style = kind === 'segs' || kind === 'tsegs' ? [5] : [3, 3 + TRI_STRIDE, 3 + TRI_STRIDE * 2];
        let total = 0;
        g.members.forEach((ci, k) => {
          const c = list.chunks[ci]!;
          const n = count(c, kind);
          expect(m.at[k]).toBe(total);
          const sf = new Float32Array(c[kind]);
          const su = new Uint32Array(c[kind]);
          for (let e = 0; e < n; e++) {
            const a = (total + e) * stride;
            const b = e * stride;
            for (const p of xy) {
              // 절대 좌표가 같다(float32 반올림 안)
              expect(Math.abs(f[a + p]! + g.ox - (sf[b + p]! + c.ox))).toBeLessThan(1e-3);
              expect(Math.abs(f[a + p + 1]! + g.oy - (sf[b + p + 1]! + c.oy))).toBeLessThan(1e-3);
            }
            for (const p of style) expect(u[a + p]).toBe(su[b + p]);
            checked++;
          }
          total += n;
        });
        expect(m.count).toBe(total);
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('부분 다시 쓰기(편집 숨기기)는 합친 버퍼의 같은 자리와 같다', () => {
    const plan = planChunkGroups(list.chunks)!;
    const g = plan.groups.find((x) => x.members.some((m) => list.chunks[m]!.segCount > 4))!;
    const k = g.members.findIndex((m) => list.chunks[m]!.segCount > 4);
    const c = list.chunks[g.members[k]!]!;
    const whole = mergeGroup(list.chunks, g, 'segs');
    const part = new ArrayBuffer(3 * elementBytes('segs'));
    rebaseInto(part, 0, c, 'segs', 1, 3, g);
    const off = (whole.at[k]! + 1) * elementBytes('segs');
    expect(new Uint8Array(part)).toEqual(new Uint8Array(whole.data, off, part.byteLength));
  });

  it('전체 보기는 무리를 통째로, 크게 확대하면 묶음으로 그린다', () => {
    const plan = planChunkGroups(list.chunks)!;
    const all: [number, number, number, number] = [list.minX, list.minY, list.maxX, list.maxY];
    const px = 1000 / (list.maxX - list.minX);
    for (const g of plan.groups) expect(drawWhole(g, plan.size, px, all)).toBe(true);
    // 화면 범위가 없으면(내보내기 등) 통째로
    expect(drawWhole(plan.groups[0]!, plan.size, px, undefined)).toBe(true);
    // 무리 하나보다 훨씬 작은 화면
    const g = plan.groups.reduce((a, b) => (b.members.length > a.members.length ? b : a));
    const cx = (g.minX + g.maxX) / 2;
    const cy = (g.minY + g.maxY) / 2;
    const w = (g.maxX - g.minX) / 10;
    expect(drawWhole(g, plan.size, 1000 / w, [cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2])).toBe(false);
    // float32 오차가 보일 만큼 확대하면(화면 범위가 없어도) 묶음으로
    expect(drawWhole(g, plan.size, (1 << 21) / plan.size, undefined)).toBe(false);
  });
});
