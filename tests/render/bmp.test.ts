/** BMP 내보내기: 머리말과 아래에서 위로, BGR, 줄 4바이트 맞춤 */
import { describe, expect, it } from 'vitest';
import { encodeBmp } from '../../src/app/export';

describe('BMP', () => {
  it('3×2 그림', () => {
    // 위 줄: 빨강 초록 파랑, 아래 줄: 흰 검정 회색
    const px = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255];
    const b = encodeBmp(3, 2, new Uint8ClampedArray(px));
    const dv = new DataView(b.buffer);
    expect(String.fromCharCode(b[0]!, b[1]!)).toBe('BM');
    expect(dv.getUint32(2, true)).toBe(54 + 12 * 2);
    expect(dv.getInt32(18, true)).toBe(3);
    expect(dv.getInt32(22, true)).toBe(2);
    expect(dv.getUint16(28, true)).toBe(24);
    // 첫 저장 줄 = 아래 줄(흰 검정 회색), BGR
    expect([...b.slice(54, 63)]).toEqual([255, 255, 255, 0, 0, 0, 128, 128, 128]);
    expect([...b.slice(66, 75)]).toEqual([0, 0, 255, 0, 255, 0, 255, 0, 0]);
  });
});
