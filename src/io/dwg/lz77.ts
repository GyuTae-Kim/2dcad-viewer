/** R2004 계열 압축 풀기(사양 4.7, LZ77 변형) */
import { DwgFormatError } from './bitstream';

/**
 * src[start..end)를 풀어 정확히 outSize 바이트를 돌려준다(남는 칸은 0).
 * out을 주면 그 버퍼의 outOffset부터 쓴다.
 */
export function decompressR18(
  src: Uint8Array,
  start: number,
  end: number,
  outSize: number,
  out?: Uint8Array,
  outOffset = 0,
): Uint8Array {
  const dst = out ?? new Uint8Array(outSize);
  const dstEnd = outOffset + outSize;
  let o = outOffset;
  let i = start;

  const literalLength = (): number => {
    const b = src[i];
    if (b === 0) {
      i++;
      let total = 0x0f;
      let c: number;
      while ((c = src[i++]) === 0) {
        total += 0xff;
        if (i >= end) break;
      }
      return total + c + 3;
    }
    if (b < 0x10) {
      i++;
      return b + 3;
    }
    return 0;
  };

  const longOffset = (): number => {
    let b = src[i++];
    if (b !== 0) return b;
    let total = 0xff;
    while ((b = src[i++]) === 0) {
      total += 0xff;
      if (i >= end) break;
    }
    return total + b;
  };

  const copyLiteral = (n: number): void => {
    let m = n;
    if (o + m > dstEnd) m = dstEnd - o;
    if (i + m > end) m = end - i;
    if (m > 0) {
      dst.set(src.subarray(i, i + m), o);
      o += m;
    }
    i += n;
  };

  copyLiteral(literalLength());
  while (i < end) {
    const op1 = src[i++];
    if (op1 === 0x11) break;
    let compBytes: number;
    let compOffset: number;
    let lit: number;
    if (op1 >= 0x40) {
      compBytes = (op1 >> 4) - 1;
      const op2 = src[i++];
      compOffset = (op2 << 2) | ((op1 & 0x0c) >> 2);
      lit = op1 & 3;
    } else if (op1 >= 0x21) {
      compBytes = op1 - 0x1e;
      const a = src[i++];
      const b = src[i++];
      compOffset = (a >> 2) | (b << 6);
      lit = a & 3;
    } else if (op1 === 0x20) {
      compBytes = longOffset() + 0x21;
      const a = src[i++];
      const b = src[i++];
      compOffset = (a >> 2) | (b << 6);
      lit = a & 3;
    } else if (op1 >= 0x12) {
      compBytes = (op1 & 0x0f) + 2;
      const a = src[i++];
      const b = src[i++];
      compOffset = ((a >> 2) | (b << 6)) + 0x3fff;
      lit = a & 3;
    } else if (op1 === 0x10) {
      compBytes = longOffset() + 9;
      const a = src[i++];
      const b = src[i++];
      compOffset = ((a >> 2) | (b << 6)) + 0x3fff;
      lit = a & 3;
    } else {
      throw new DwgFormatError(`압축 자료의 잘못된 명령 0x${op1.toString(16)}`);
    }
    // 앞서 풀린 자료에서 복사(거리 = compOffset + 1, 길이가 거리보다 길 수 있다)
    let from = o - compOffset - 1;
    if (from < outOffset) throw new DwgFormatError('압축 자료의 잘못된 거리');
    if (o + compBytes > dstEnd) compBytes = dstEnd - o;
    for (let k = 0; k < compBytes; k++) dst[o++] = dst[from++];
    if (lit === 0) lit = literalLength();
    copyLiteral(lit);
  }
  return dst;
}
