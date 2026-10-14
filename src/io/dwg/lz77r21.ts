/** R2007 압축 풀기(사양 5.10). R2004와 다른 LZ77 변형이고 글자 그대로 복사할 때 바이트 순서가 바뀐다. */
import { DwgFormatError } from './bitstream';

/**
 * 1~32바이트 글자 복사 순서(사양 5.10.1 표). [크기, 원본 위치] 쌍의 나열이고,
 * 크기 2·3은 거꾸로, 4·8은 그대로, 16은 앞뒤 8바이트를 바꿔 복사한다.
 */
const LITERAL_PLAN: [number, number][][] = [
  [],
  [[1, 0]],
  [[2, 0]],
  [[3, 0]],
  [[4, 0]],
  [[1, 4], [4, 0]],
  [[1, 5], [4, 1], [1, 0]],
  [[2, 5], [4, 1], [1, 0]],
  [[8, 0]],
  [[1, 8], [8, 0]],
  [[1, 9], [8, 1], [1, 0]],
  [[2, 9], [8, 1], [1, 0]],
  [[4, 8], [8, 0]],
  [[1, 12], [4, 8], [8, 0]],
  [[1, 13], [4, 9], [8, 1], [1, 0]],
  [[2, 13], [4, 9], [8, 1], [1, 0]],
  [[16, 0]],
  [[8, 9], [1, 8], [8, 0]],
  [[1, 17], [16, 1], [1, 0]],
  [[3, 16], [16, 0]],
  [[4, 16], [16, 0]],
  [[1, 20], [4, 16], [16, 0]],
  [[2, 20], [4, 16], [16, 0]],
  [[3, 20], [4, 16], [16, 0]],
  [[8, 16], [16, 0]],
  [[8, 17], [1, 16], [16, 0]],
  [[1, 25], [8, 17], [1, 16], [16, 0]],
  [[2, 25], [8, 17], [1, 16], [16, 0]],
  [[4, 24], [8, 16], [16, 0]],
  [[1, 28], [4, 24], [8, 16], [16, 0]],
  [[2, 28], [4, 24], [8, 16], [16, 0]],
  [[1, 30], [4, 26], [8, 18], [16, 2], [2, 0]],
  [[16, 16], [16, 0]],
];

/** 기본 복사 단위 */
function copyUnit(n: number, src: Uint8Array, s: number, dst: Uint8Array, d: number): number {
  switch (n) {
    case 1:
      dst[d] = src[s];
      return 1;
    case 2:
      dst[d] = src[s + 1];
      dst[d + 1] = src[s];
      return 2;
    case 3:
      dst[d] = src[s + 2];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s];
      return 3;
    case 4:
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
      return 4;
    case 8:
      for (let k = 0; k < 8; k++) dst[d + k] = src[s + k];
      return 8;
    case 16:
      for (let k = 0; k < 8; k++) dst[d + k] = src[s + 8 + k];
      for (let k = 0; k < 8; k++) dst[d + 8 + k] = src[s + k];
      return 16;
    default:
      throw new DwgFormatError(`복사 단위 ${n}`);
  }
}

function copyLiteral(src: Uint8Array, s: number, dst: Uint8Array, d: number, len: number): void {
  while (len >= 32) {
    copyPlan(32, src, s, dst, d);
    s += 32;
    d += 32;
    len -= 32;
  }
  if (len > 0) copyPlan(len, src, s, dst, d);
}

function copyPlan(n: number, src: Uint8Array, s: number, dst: Uint8Array, d: number): void {
  for (const [size, off] of LITERAL_PLAN[n]) d += copyUnit(size, src, s + off, dst, d);
}

/** src[start..start+size)를 풀어 outSize 바이트를 돌려준다 */
export function decompressR21(src: Uint8Array, start: number, size: number, outSize: number): Uint8Array {
  const dst = new Uint8Array(outSize);
  const end = start + size;
  let si = start;
  let di = 0;
  let length = 0;
  let opCode = src[si++];
  if (opCode >> 4 === 2) {
    si += 2;
    length = src[si++] & 7;
  }

  const literalLength = (): number => {
    let len = opCode + 8;
    if (len === 0x17) {
      let n = src[si++];
      len += n;
      if (n === 0xff) {
        do {
          n = src[si] | (src[si + 1] << 8);
          si += 2;
          len += n;
        } while (n === 0xffff && si < end);
      }
    }
    return len;
  };

  let srcOff = 0;
  const readInstructions = (): void => {
    switch (opCode >> 4) {
      case 0: {
        length = (opCode & 0xf) + 0x13;
        srcOff = src[si++];
        opCode = src[si++];
        length = ((opCode >> 3) & 0x10) + length;
        srcOff = ((opCode & 0x78) << 5) + 1 + srcOff;
        break;
      }
      case 1: {
        length = (opCode & 0xf) + 3;
        srcOff = src[si++];
        opCode = src[si++];
        srcOff = ((opCode & 0xf8) << 5) + 1 + srcOff;
        break;
      }
      case 2: {
        srcOff = src[si++];
        srcOff = ((src[si++] << 8) & 0xff00) | srcOff;
        length = opCode & 7;
        if ((opCode & 8) === 0) {
          opCode = src[si++];
          length = (opCode & 0xf8) + length;
        } else {
          srcOff++;
          length = (src[si++] << 3) + length;
          opCode = src[si++];
          length = ((opCode & 0xf8) << 8) + length + 0x100;
        }
        break;
      }
      default: {
        length = opCode >> 4;
        srcOff = opCode & 15;
        opCode = src[si++];
        srcOff = ((opCode & 0xf8) << 1) + srcOff + 1;
        break;
      }
    }
  };

  const copyBack = (): void => {
    let from = di - srcOff;
    if (from < 0) throw new DwgFormatError('R2007 압축 자료의 잘못된 거리');
    let n = length;
    if (di + n > outSize) n = outSize - di;
    for (let k = 0; k < n; k++) dst[di++] = dst[from++];
  };

  while (si < end) {
    if (length === 0) length = literalLength();
    if (di + length > outSize || si + length > end) {
      const n = Math.min(outSize - di, end - si, length);
      if (n > 0) copyLiteral(src, si, dst, di, n);
      break;
    }
    copyLiteral(src, si, dst, di, length);
    si += length;
    di += length;
    if (si >= end) break;
    // 압축된 조각들
    length = 0;
    opCode = src[si++];
    readInstructions();
    for (;;) {
      copyBack();
      length = opCode & 7;
      if (length !== 0 || si >= end) break;
      opCode = src[si++];
      if (opCode >> 4 === 0) break;
      if (opCode >> 4 === 15) opCode &= 15;
      readInstructions();
    }
  }
  return dst;
}
