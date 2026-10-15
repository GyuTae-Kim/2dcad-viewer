/** WMFOUT: 고른 객체의 그림만 남긴 표시 목록 */
import { describe, expect, it } from 'vitest';
import { filterDisplayList } from '../../src/edit/filecmds/dlfilter';
import { DisplayListBuilder, type DisplayList } from '../../src/render/displaylist';

function build(): DisplayList {
  const b = new DisplayListBuilder(() => false);
  b.segment(0, 0, 10, 0, 1);
  b.segment(10, 0, 10, 10, 1);
  b.endEntity('A');
  b.triangle(0, 0, 5, 0, 0, 5, 2);
  b.endEntity('B');
  b.segment(20, 20, 30, 30, 3);
  b.triangle(20, 20, 25, 20, 20, 25, 3);
  b.endEntity('C');
  return b.finish();
}

const counts = (dl: DisplayList) => dl.chunks.reduce((a, c) => [a[0]! + c.segCount, a[1]! + c.triCount], [0, 0]);

describe('filterDisplayList', () => {
  const dl = build();

  it('고른 객체의 선분·삼각형만', () => {
    expect(counts(dl)).toEqual([3, 2]);
    expect(counts(filterDisplayList(dl, dl.entities, new Set(['A'])))).toEqual([2, 0]);
    expect(counts(filterDisplayList(dl, dl.entities, new Set(['B'])))).toEqual([0, 1]);
    const ac = filterDisplayList(dl, dl.entities, new Set(['A', 'C']));
    expect(counts(ac)).toEqual([3, 1]);
    expect(ac.entities.map((e) => e.handle)).toEqual(['A', 'C']);
    expect([ac.minX, ac.maxX]).toEqual([0, 30]);
  });

  it('스타일 번호를 그대로 둔다', () => {
    const c = filterDisplayList(dl, dl.entities, new Set(['C']));
    const ch = c.chunks[0]!;
    const segs = new Uint32Array(ch.segs);
    expect(segs[5]).toBe(3);
    const tris = new Uint32Array(ch.tris);
    expect(tris[3]).toBe(3);
  });

  it('아무것도 고르지 않으면 빈 목록', () => {
    const e = filterDisplayList(dl, dl.entities, new Set());
    expect(e.chunks).toEqual([]);
    expect(e.entities).toEqual([]);
  });
});
