/**
 * 코드 페이지 문자열 쓰기(R2007 이전 DWG).
 * 브라우저 TextEncoder는 UTF-8만 지원하므로 TextDecoder로 바이트 → 글자 표를 만들어 거꾸로 쓴다.
 * 코드 페이지에 없는 글자는 AutoCAD처럼 \U+XXXX로 쓴다.
 */
import { codepageToEncoding, decoderFor } from '../../../core/codepage';

export interface TextEncoderCp {
  encode(s: string): Uint8Array;
  /** 이 코드 페이지로 쓸 수 있는 글자인지 */
  canEncode(c: number): boolean;
}

const cache = new Map<string, TextEncoderCp>();

const MULTI = new Set(['shift_jis', 'gbk', 'euc-kr', 'big5']);

function build(encoding: string): TextEncoderCp {
  if (encoding === 'utf-8') {
    const te = new TextEncoder();
    return { encode: (s) => te.encode(s), canEncode: () => true };
  }
  const dec = decoderFor(encoding);
  const map = new Map<number, number[]>();
  // 한 바이트 글자
  for (let b = 0; b < 256; b++) {
    if (MULTI.has(encoding) && b >= 0x80) continue;
    const s = dec.decode(new Uint8Array([b]));
    if (s.length === 1 && s !== '�' && !map.has(s.charCodeAt(0))) map.set(s.charCodeAt(0), [b]);
  }
  if (MULTI.has(encoding)) {
    // 두 바이트 글자(앞 0x81~0xFE, 뒤 0x40~0xFE)
    const two = new Uint8Array(2);
    for (let a = 0x81; a <= 0xfe; a++) {
      for (let b = 0x40; b <= 0xfe; b++) {
        two[0] = a;
        two[1] = b;
        const s = dec.decode(two);
        if (s.length === 1 && s !== '�') {
          const c = s.charCodeAt(0);
          if (!map.has(c)) map.set(c, [a, b]);
        }
      }
    }
    // 반각 가타카나 등 0xA1~0xDF 한 바이트(shift_jis)
    if (encoding === 'shift_jis') {
      for (let b = 0xa1; b <= 0xdf; b++) {
        const s = dec.decode(new Uint8Array([b]));
        if (s.length === 1 && s !== '�' && !map.has(s.charCodeAt(0))) map.set(s.charCodeAt(0), [b]);
      }
    }
  }
  return {
    canEncode: (c: number) => c < 0x80 || map.has(c),
    encode(s: string): Uint8Array {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) {
          out.push(c);
          continue;
        }
        const m = map.get(c);
        if (m) out.push(...m);
        else {
          const esc = `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
          for (let k = 0; k < esc.length; k++) out.push(esc.charCodeAt(k));
        }
      }
      return new Uint8Array(out);
    },
  };
}

/** DXF 코드 페이지 이름(ANSI_1252 등) → 쓰기 도구 */
export function encoderFor(codepage: string): TextEncoderCp {
  const enc = codepageToEncoding(codepage);
  let e = cache.get(enc);
  if (!e) {
    e = build(enc);
    cache.set(enc, e);
  }
  return e;
}
