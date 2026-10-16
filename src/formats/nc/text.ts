/**
 * NC 원본 글을 바이트 그대로 다룬다: 줄 나누기(LF·CRLF·CR), 줄 글 꺼내기, 글자 인코딩 추정.
 * 수십 MB 파일도 한 덩어리 문자열로 바꾸지 않고 줄 시작 위치만 둔다(줄 글은 필요할 때 꺼낸다).
 * DOM에 기대지 않는다(워커에서도 돈다).
 */

/** 원본 글: 바이트와 줄 시작 위치 */
export interface NcSource {
  bytes: Uint8Array;
  /** 줄 i의 시작 바이트 위치. 길이 lineCount+1이고 마지막 값은 끝 위치 */
  lineStart: Uint32Array;
  lineCount: number;
  /** 줄 글을 꺼낼 때 쓸 인코딩(UTF-8로 맞지 않으면 windows-1252) */
  encoding: 'utf-8' | 'windows-1252';
}

const enc = new TextEncoder();

/** 문자열·바이트를 받아 원본 글로 만든다 */
export function makeSource(input: Uint8Array | ArrayBuffer | string): NcSource {
  const bytes = typeof input === 'string' ? enc.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const lineStart = splitLines(bytes);
  return { bytes, lineStart, lineCount: lineStart.length - 1, encoding: guessEncoding(bytes) };
}

/**
 * 줄 시작 위치. LF가 하나라도 있으면 LF로 나누고(줄 끝 CR은 꺼낼 때 뺀다), LF 없이 CR만 있으면 CR로 나눈다.
 * 돌려주는 배열의 길이는 줄 수 + 1(마지막은 바이트 길이).
 */
export function splitLines(bytes: Uint8Array): Uint32Array {
  let sep = 10;
  if (bytes.indexOf(10) < 0 && bytes.indexOf(13) >= 0) sep = 13;
  let n = 0;
  for (let i = bytes.indexOf(sep); i >= 0; i = bytes.indexOf(sep, i + 1)) n++;
  const len = bytes.length;
  // 마지막 줄이 줄바꿈으로 끝나면 빈 줄을 하나 더 만들지 않는다
  const tail = len > 0 && bytes[len - 1] !== sep ? 1 : 0;
  const out = new Uint32Array(n + tail + 1);
  let k = 0;
  // UTF-8 BOM은 첫 줄에서 뺀다
  out[k++] = len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (let i = bytes.indexOf(sep); i >= 0; i = bytes.indexOf(sep, i + 1)) out[k++] = i + 1;
  if (!tail) out[k - 1] = len;
  else out[k] = len;
  return out;
}

/** 줄 i의 내용 범위 [s, e) — 줄 끝 CR·LF는 뺀다 */
export function lineRange(src: NcSource, i: number): [number, number] {
  const s = src.lineStart[i]!;
  let e = src.lineStart[i + 1]!;
  const b = src.bytes;
  while (e > s && (b[e - 1] === 10 || b[e - 1] === 13)) e--;
  return [s, e];
}

const decoders: Partial<Record<NcSource['encoding'], TextDecoder>> = {};
function decoder(e: NcSource['encoding']): TextDecoder {
  return (decoders[e] ??= new TextDecoder(e));
}

/** 바이트 구간을 글로 */
export function decodeRange(src: NcSource, s: number, e: number): string {
  const b = src.bytes;
  // ASCII면 빠른 길
  if (e - s < 256) {
    let ascii = true;
    for (let i = s; i < e; i++)
      if (b[i]! >= 0x80) {
        ascii = false;
        break;
      }
    if (ascii) return String.fromCharCode(...b.subarray(s, e));
  }
  return decoder(src.encoding).decode(b.subarray(s, e));
}

/** 줄 i의 글(0부터 센다) */
export function sourceLine(src: NcSource, i: number): string {
  if (i < 0 || i >= src.lineCount) return '';
  const [s, e] = lineRange(src, i);
  return decodeRange(src, s, e);
}

/** 전체 글(작은 파일용) */
export function sourceText(src: NcSource): string {
  return decoder(src.encoding).decode(src.bytes);
}

/** 바이트가 올바른 UTF-8인지 본다(문자열을 만들지 않는다). 0x80 이상이 없으면 UTF-8로 본다 */
export function guessEncoding(b: Uint8Array): 'utf-8' | 'windows-1252' {
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i]!;
    if (c < 0x80) {
      i++;
      continue;
    }
    let k = 0;
    if (c >= 0xc2 && c <= 0xdf) k = 1;
    else if (c >= 0xe0 && c <= 0xef) k = 2;
    else if (c >= 0xf0 && c <= 0xf4) k = 3;
    else return 'windows-1252';
    for (let j = 1; j <= k; j++) {
      const d = b[i + j];
      if (d === undefined || (d & 0xc0) !== 0x80) return 'windows-1252';
    }
    i += k + 1;
  }
  return 'utf-8';
}
