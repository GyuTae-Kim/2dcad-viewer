import { constants, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflateRaw } from '../../src/formats/skp/inflate';

function sample(n: number): Uint8Array {
  // 되풀이와 잡음이 섞인 자료(동적·고정 허프만, 긴 거리 복사가 모두 나오게)
  const b = new Uint8Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    b[i] = i % 97 < 60 ? 'SketchUp Model '.charCodeAt(i % 15) : (s >>> 16) & 0xff;
  }
  return b;
}

describe('inflateRaw(RFC 1951)', () => {
  it('동적 허프만 블록을 푼다', () => {
    const data = sample(200_000);
    const z = new Uint8Array(deflateRawSync(data, { level: 9 }));
    expect(inflateRaw(z, data.length)).toEqual(data);
  });

  it('원래 크기를 몰라도 늘려 가며 푼다', () => {
    const data = sample(50_000);
    const z = new Uint8Array(deflateRawSync(data));
    expect(inflateRaw(z)).toEqual(data);
  });

  it('고정 허프만 블록을 푼다', () => {
    const data = sample(30_000);
    const z = new Uint8Array(deflateRawSync(data, { strategy: constants.Z_FIXED }));
    expect(inflateRaw(z, data.length)).toEqual(data);
  });

  it('저장(무압축) 블록을 푼다', () => {
    const data = sample(70_000);
    const z = new Uint8Array(deflateRawSync(data, { level: 0 }));
    expect(inflateRaw(z, data.length)).toEqual(data);
  });

  it('압축 블록 뒤에 오는 저장 블록(압축이 안 되는 구간)', () => {
    const text = sample(100_000);
    const noise = new Uint8Array(150_000);
    let s = 99;
    for (let i = 0; i < noise.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      noise[i] = s >>> 24;
    }
    const data = new Uint8Array(text.length * 2 + noise.length);
    data.set(text, 0);
    data.set(noise, text.length);
    data.set(text, text.length + noise.length);
    const z = new Uint8Array(deflateRawSync(data));
    expect(inflateRaw(z, data.length)).toEqual(data);
  });

  it('손으로 짠 스트림: 고정 허프만 블록("A") 다음 저장 블록("BC")', () => {
    // 비트(낮은 쪽부터): 0 | 1 0 | 0111 0001('A') | 000 0000(끝) | 1 | 0 0 | 채움 → 72 04 04, LEN 2, NLEN, "BC"
    const z = new Uint8Array([0x72, 0x04, 0x04, 0x02, 0x00, 0xfd, 0xff, 0x42, 0x43]);
    expect(new TextDecoder().decode(inflateRaw(z))).toBe('ABC');
  });

  it('터무니없는 원래 크기는 무시하고 늘려 가며 푼다', () => {
    const data = sample(5_000);
    const z = new Uint8Array(deflateRawSync(data));
    expect(inflateRaw(z, 0xffffffff)).toEqual(data);
  });

  it('빈 자료', () => {
    const z = new Uint8Array(deflateRawSync(new Uint8Array(0)));
    expect(inflateRaw(z).length).toBe(0);
  });

  it('깨진 스트림이면 오류를 던진다', () => {
    expect(() => inflateRaw(new Uint8Array([0x07, 0xff, 0xff]))).toThrow();
    // 저장 블록 길이 검사(LEN/NLEN 불일치)
    expect(() => inflateRaw(new Uint8Array([0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]))).toThrow();
  });
});
