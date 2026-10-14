/** 비트 읽기·압축 풀기 단위 시험(사양 2장의 예) */
import { describe, expect, it } from 'vitest';
import { BitReader } from '../../src/io/dwg/bitstream';
import { decompressR18 } from '../../src/io/dwg/lz77';
import { crc8, pageChecksum } from '../../src/io/dwg/crc';
import { R2000, R2004, R2010, R14 } from '../../src/io/dwg/version';

/** "0101…" 문자열 → 바이트 */
function bits(s: string): Uint8Array {
  const b = s.replace(/[^01]/g, '');
  const out = new Uint8Array(Math.ceil(b.length / 8) + 8);
  for (let i = 0; i < b.length; i++) if (b[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

const reader = (data: Uint8Array, ver = R2000) => new BitReader(data, ver, new TextDecoder('windows-1252'));

describe('BitReader', () => {
  it('BS(사양 2.2 예)', () => {
    const r = reader(bits('0000000001000000011011010000111110'));
    expect([r.BS(), r.BS(), r.BS(), r.BS(), r.BS()]).toEqual([257, 0, 256, 15, 0]);
  });

  it('BL(사양 2.3 예)', () => {
    const r = reader(bits('000000000100000001000000000000000010010000111110'));
    expect([r.BL(), r.BL(), r.BL(), r.BL()]).toEqual([257, 0, 15, 0]);
  });

  it('BD 기본값과 RD', () => {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, 3.25, true);
    let s = '01' + '10';
    s += '00';
    for (let i = 0; i < 8; i++) s += dv.getUint8(i).toString(2).padStart(8, '0');
    const r = reader(bits(s));
    expect([r.BD(), r.BD(), r.BD()]).toEqual([1, 0, 3.25]);
  });

  it('MC(사양 2.6 예)', () => {
    expect(reader(new Uint8Array([0b10000010, 0b00100100])).MC()).toBe(4610);
    expect(reader(new Uint8Array([0b11101001, 0b10010111, 0b11100110, 0b00110101])).MC()).toBe(112823273);
    expect(reader(new Uint8Array([0b10000101, 0b01001011])).MC()).toBe(-1413);
  });

  it('MS(사양 2.7 예)', () => {
    expect(reader(new Uint8Array([0b00110001, 0b11110100, 0b10001101, 0b00000000])).MS()).toBe(4650033);
  });

  it('핸들 참조와 상대 코드', () => {
    // 5.2.05E7(사양 2.13 예), 6.0(+1), 8.0(-1), A.1.10(+0x10), C.1.10(-0x10)
    const r = reader(new Uint8Array([0x52, 0x05, 0xe7, 0x60, 0x80, 0xa1, 0x10, 0xc1, 0x10]));
    expect(r.H(0x100)).toBe(0x5e7);
    expect(r.H(0x100)).toBe(0x101);
    expect(r.H(0x100)).toBe(0xff);
    expect(r.H(0x100)).toBe(0x110);
    expect(r.H(0x100)).toBe(0xf0);
  });

  it('BE·BT는 R2000부터 1비트 줄임 표기', () => {
    const r = reader(bits('1 1'), R2000);
    expect(r.BE()).toEqual({ x: 0, y: 0, z: 1 });
    expect(r.BT()).toBe(0);
    const r14 = reader(bits('10 10 01 10'), R14);
    expect(r14.BE()).toEqual({ x: 0, y: 0, z: 1 });
    expect(r14.BT()).toBe(0);
  });

  it('OT: R2010+ 비트쌍 + 1~2바이트', () => {
    const r = reader(bits('00 00010011' + '01 00000010' + '10 00010001 00000010'), R2010);
    expect([r.OT(), r.OT(), r.OT()]).toEqual([0x13, 0x1f2, 0x211]);
  });

  it('ENC: 트루컬러와 투명도', () => {
    // BS 00 + 0xA000|7 → 플래그 0x8000(RGB)·0x2000(투명도)
    const v = 0xa007;
    let s = '00' + (v & 0xff).toString(2).padStart(8, '0') + (v >> 8).toString(2).padStart(8, '0');
    const rgb = 0xc2112233;
    s += '00';
    for (let i = 0; i < 4; i++) s += ((rgb >>> (8 * i)) & 0xff).toString(2).padStart(8, '0');
    const t = 0x0300004c;
    s += '00';
    for (let i = 0; i < 4; i++) s += ((t >>> (8 * i)) & 0xff).toString(2).padStart(8, '0');
    const c = reader(bits(s), R2004).ENC();
    expect(c.index).toBe(7);
    expect(c.rgb! >>> 0).toBe(0xc2112233);
    expect(c.transparency).toBe(0x4c);
  });
});

describe('압축·CRC', () => {
  it('R2004 LZ77: 글자 그대로 + 되돌아 복사 + 끝', () => {
    // 글자 길이 0x01+3 = 4바이트 "ABCD", 명령 0x50 0x00: 길이 (5-1)=4, 거리 0+1 → "DDDD", 0x11 끝
    const src = new Uint8Array([0x01, 0x41, 0x42, 0x43, 0x44, 0x40 | 0x10 | 0x00, 0x00, 0x11]);
    const out = decompressR18(src, 0, src.length, 8);
    expect(new TextDecoder().decode(out)).toBe('ABCDDDDD');
  });

  it('CRC8 표와 페이지 체크섬', () => {
    const d = new TextEncoder().encode('123456789');
    // 표준 CRC-16/ARC(반사 0xA001) 값과 같다
    expect(crc8(0, d, 0, d.length)).toBe(0xbb3d);
    // sum1 = 바이트 합 477, sum2 = 누적합의 합 2325
    expect(pageChecksum(0, d, 0, d.length)).toBe(((2325 << 16) | 477) >>> 0);
  });
});
