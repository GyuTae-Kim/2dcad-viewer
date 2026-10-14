/** 프록시 그림(ODA 명세 29장) 해석 */
import { describe, expect, it } from 'vitest';
import { parseProxyGraphics } from '../../src/render/proxy';

/** 묶음들로 프록시 그림 바이트를 만든다 */
function stream(chunks: { type: number; body: (dv: DataView, o: number) => number; size: number }[]): Uint8Array {
  const total = 8 + chunks.reduce((a, c) => a + 8 + c.size, 0);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, total, true);
  dv.setUint32(4, chunks.length, true);
  let p = 8;
  for (const c of chunks) {
    dv.setUint32(p, 8 + c.size, true);
    dv.setUint32(p + 4, c.type, true);
    c.body(dv, p + 8);
    p += 8 + c.size;
  }
  return new Uint8Array(buf);
}

describe('프록시 그림', () => {
  it('꺾은선·원·색·변환 묶음을 읽는다', () => {
    const data = stream([
      { type: 14, size: 4, body: (dv, o) => (dv.setInt32(o, 1, true), 0) },
      {
        type: 6,
        size: 4 + 2 * 24,
        body: (dv, o) => {
          dv.setInt32(o, 2, true);
          [0, 0, 0, 10, 5, 0].forEach((v, i) => dv.setFloat64(o + 4 + i * 8, v, true));
          return 0;
        },
      },
      {
        type: 2,
        size: 24 + 8 + 24,
        body: (dv, o) => {
          [1, 2, 0].forEach((v, i) => dv.setFloat64(o + i * 8, v, true));
          dv.setFloat64(o + 24, 3, true);
          [0, 0, 1].forEach((v, i) => dv.setFloat64(o + 32 + i * 8, v, true));
          return 0;
        },
      },
      { type: 31, size: 0, body: () => 0 },
      { type: 99, size: 4, body: () => 0 },
    ]);
    const r = parseProxyGraphics(data);
    expect(r.prims.map((p) => p.k)).toEqual(['color', 'poly', 'circle', 'pop']);
    const poly = r.prims[1] as { pts: number[] };
    expect(poly.pts).toEqual([0, 0, 0, 10, 5, 0]);
    expect((r.prims[2] as { r: number }).r).toBe(3);
    expect([...r.skipped]).toEqual([[99, 1]]);
  });

  it('잘린 자료는 읽은 데까지만', () => {
    const data = stream([{ type: 6, size: 4 + 24, body: (dv, o) => (dv.setInt32(o, 1, true), 0) }]);
    expect(() => parseProxyGraphics(data.subarray(0, 20))).not.toThrow();
  });
});
