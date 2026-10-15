/**
 * DXF 태그 읽기. ASCII와 이진 DXF를 같은 "레코드" 흐름으로 바꾼다.
 * 레코드 = 그룹 코드 0 하나와 다음 0 전까지의 태그 묶음.
 */
import { CadReadError } from '../../core/errors';
import { decoderFor } from '../../core/codepage';

export type TagValue = string | number;

export interface DxfRecord {
  /** 그룹 코드 0의 값(SECTION, LINE …) */
  type: string;
  /** 0 다음의 태그(0 자신은 빼고) */
  codes: number[];
  values: TagValue[];
}

interface TagReader {
  code: number;
  value: TagValue;
  next(): boolean;
  progress(): number;
}

export const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';

export function isBinaryDxf(data: Uint8Array): boolean {
  if (data.length < 22) return false;
  for (let i = 0; i < 22; i++) if (data[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

/**
 * 예전 ASCII 태그 읽기: 파일 전체를 문자열 하나로 풀고 줄마다 잘라 낸다.
 * 바이트 읽기(AsciiByteTagReader)가 ASCII와 호환되지 않는 인코딩(UTF-16)일 때와 시험의 비교 기준으로만 쓴다.
 * 한계: V8 문자열 최대 길이(약 5억 3천만 자)를 넘는 파일은 풀지 못하고, 잘라 낸 문자열이 파일 문자열 전체를 붙잡는다.
 */
class StringTagReader implements TagReader {
  code = 0;
  value: TagValue = '';
  private pos = 0;
  private readonly len: number;
  line = 0;

  constructor(private readonly text: string) {
    this.len = text.length;
    if (text.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  progress(): number {
    return this.len ? this.pos / this.len : 1;
  }

  private readLine(): string | null {
    const t = this.text;
    if (this.pos >= this.len) return null;
    let nl = t.indexOf('\n', this.pos);
    if (nl < 0) nl = this.len;
    let end = nl;
    if (end > this.pos && t.charCodeAt(end - 1) === 13) end--;
    const s = t.slice(this.pos, end);
    this.pos = nl + 1;
    this.line++;
    return s;
  }

  next(): boolean {
    let codeLine = this.readLine();
    // 파일 끝의 빈 줄은 무시한다.
    while (codeLine !== null && codeLine.trim() === '' && this.pos >= this.len) codeLine = null;
    if (codeLine === null) return false;
    const code = parseInt(codeLine, 10);
    if (Number.isNaN(code)) {
      if (codeLine.trim() === '') return false;
      throw new CadReadError('dxf.invalid', { line: this.line, reason: 'group_code' });
    }
    const v = this.readLine();
    if (v === null) return false;
    this.code = code;
    this.value = v;
    return true;
  }
}

/** 이진 DXF 값의 형식 */
const enum VT {
  Str,
  Double,
  I16,
  I32,
  I64,
  Bool,
  Binary,
}

function binaryValueType(code: number): VT {
  if (code >= 0 && code <= 9) return VT.Str;
  if (code >= 10 && code <= 59) return VT.Double;
  if (code >= 60 && code <= 79) return VT.I16;
  if (code >= 90 && code <= 99) return VT.I32;
  if (code === 100 || code === 101 || code === 102 || code === 105) return VT.Str;
  if (code >= 110 && code <= 149) return VT.Double;
  if (code >= 160 && code <= 169) return VT.I64;
  if (code >= 170 && code <= 179) return VT.I16;
  if (code >= 210 && code <= 239) return VT.Double;
  if (code >= 270 && code <= 289) return VT.I16;
  if (code >= 290 && code <= 299) return VT.Bool;
  if (code >= 300 && code <= 309) return VT.Str;
  if (code >= 310 && code <= 319) return VT.Binary;
  if (code >= 320 && code <= 369) return VT.Str;
  if (code >= 370 && code <= 389) return VT.I16;
  if (code >= 390 && code <= 399) return VT.Str;
  if (code >= 400 && code <= 409) return VT.I16;
  if (code >= 410 && code <= 419) return VT.Str;
  if (code >= 420 && code <= 429) return VT.I32;
  if (code >= 430 && code <= 439) return VT.Str;
  if (code >= 440 && code <= 449) return VT.I32;
  if (code >= 450 && code <= 459) return VT.I32;
  if (code >= 460 && code <= 469) return VT.Double;
  if (code >= 470 && code <= 481) return VT.Str;
  if (code === 999) return VT.Str;
  if (code >= 1000 && code <= 1003) return VT.Str;
  if (code === 1004) return VT.Binary;
  if (code >= 1005 && code <= 1009) return VT.Str;
  if (code >= 1010 && code <= 1059) return VT.Double;
  if (code >= 1060 && code <= 1070) return VT.I16;
  if (code === 1071) return VT.I32;
  return VT.Str;
}

/** 그룹 코드 값이 실수인지(이진 DXF 표 기준) — ASCII에서도 실수 값은 바로 숫자로 푼다 */
const DOUBLE_CODE = new Uint8Array(1072);
for (let c = 0; c < DOUBLE_CODE.length; c++) DOUBLE_CODE[c] = binaryValueType(c) === VT.Double ? 1 : 0;

/** 10^k (k ≤ 22는 double로 정확하다) */
const POW10: number[] = [];
for (let k = 0, p = 1; k <= 22; k++, p *= 10) POW10.push(p);

/** 숫자로 풀지 못함 */
const NOT_FAST = Number.NaN;

/**
 * 바이트 [s, e)의 십진 실수를 빠르게 푼다. parseFloat와 같은 값이 보장되는 꼴만 받는다:
 * 앞뒤 공백·탭, 부호, 숫자와 소수점 하나(지수 없음), 유효 정수부 ≤ 2^53, 소수 자릿수 ≤ 22.
 * 이때 M / 10^k는 두 수가 모두 정확하므로 한 번 반올림한 값 = 정확히 반올림한 십진 변환이다(Clinger 빠른 길).
 * 그 밖의 꼴(지수, 쉼표, 긴 자릿수, 빈 값)은 NOT_FAST를 돌려주고 호출한 쪽이 문자열을 그대로 둔다.
 */
export function parseDecimalBytes(d: Uint8Array, s: number, e: number): number {
  while (s < e && (d[s] === 32 || d[s] === 9)) s++;
  while (e > s && (d[e - 1] === 32 || d[e - 1] === 9)) e--;
  if (s >= e) return NOT_FAST;
  let neg = false;
  const c0 = d[s]!;
  if (c0 === 45) {
    neg = true;
    s++;
  } else if (c0 === 43) s++;
  let m = 0;
  let digits = 0;
  let frac = -1;
  for (let i = s; i < e; i++) {
    const c = d[i]!;
    if (c >= 48 && c <= 57) {
      m = m * 10 + (c - 48);
      digits++;
      if (frac >= 0) frac++;
    } else if (c === 46 && frac < 0) frac = 0;
    else return NOT_FAST;
  }
  if (!digits || m > 9007199254740992) return NOT_FAST;
  if (frac > 22) return NOT_FAST;
  const v = frac > 0 ? m / POW10[frac]! : m;
  return neg ? -v : v;
}

/**
 * 바이트 구간 → 문자열. ASCII 바이트만이면 직접 만들고(짧은 것은 캐시로 같은 문자열을 함께 쓴다),
 * 그 밖에는 문서 인코딩의 TextDecoder로 푼다(파일 전체를 한 번에 푼 것과 같은 결과).
 */
class ByteStrings {
  /** 짧은 문자열 캐시(직접 사상): 도면층 이름·소유 핸들·하위 클래스 표지처럼 되풀이되는 값을 한 문자열로 */
  private readonly cache: (string | undefined)[] = new Array(8192);

  constructor(
    private readonly data: Uint8Array,
    private readonly decoder: TextDecoder,
  ) {}

  get(s: number, e: number): string {
    const d = this.data;
    const n = e - s;
    if (n <= 0) return '';
    if (n <= 24) {
      let h = 0x811c9dc5 ^ n;
      for (let i = s; i < e; i++) {
        const b = d[i]!;
        if (b >= 0x80) return this.decoder.decode(d.subarray(s, e));
        h = Math.imul(h ^ b, 0x01000193);
      }
      const slot = (h ^ (h >>> 13)) & 8191;
      const c = this.cache[slot];
      if (c !== undefined && c.length === n) {
        let same = true;
        for (let i = 0; i < n; i++)
          if (c.charCodeAt(i) !== d[s + i]) {
            same = false;
            break;
          }
        if (same) return c;
      }
      let r: string;
      if (n <= 12) {
        // 짧은 이어 붙이기는 V8이 곧바로 평평한 문자열로 만든다
        r = '';
        for (let i = s; i < e; i++) r += String.fromCharCode(d[i]!);
      } else r = String.fromCharCode.apply(null, d.subarray(s, e) as unknown as number[]);
      this.cache[slot] = r;
      return r;
    }
    for (let i = s; i < e; i++) if (d[i]! >= 0x80) return this.decoder.decode(d.subarray(s, e));
    // 긴 ASCII: 조각으로 나눠 만든다(인자 수 한계)
    if (n <= 8192) return String.fromCharCode.apply(null, d.subarray(s, e) as unknown as number[]);
    return this.decoder.decode(d.subarray(s, e));
  }
}

/** 인코딩이 ASCII 바이트(0x00~0x7F)를 그대로 푸는지(UTF-16 같은 것은 아니다) */
function asciiCompatible(decoder: TextDecoder): boolean {
  const b = new Uint8Array(128);
  for (let i = 0; i < 128; i++) b[i] = i;
  const s = decoder.decode(b);
  if (s.length !== 128) return false;
  for (let i = 0; i < 128; i++) if (s.charCodeAt(i) !== i) return false;
  return true;
}

const isSpaceByte = (b: number) => b === 32 || b === 9 || b === 11 || b === 12 || b === 13;

/**
 * ASCII DXF 태그를 바이트에서 바로 읽는다(파일 전체 문자열을 만들지 않는다).
 * - 줄 = '\n' 바이트까지(끝의 '\r' 하나는 뺀다). 0x0A는 UTF-8·단일 바이트·DBCS 코드 페이지에서 언제나 줄바꿈이다.
 * - 그룹 코드는 바이트에서 정수로 푼다(parseInt와 같게, 낯선 꼴은 문자열로 풀어 예전 규칙대로).
 * - 실수 그룹 코드(10~59 …)의 값은 parseDecimalBytes로 숫자로 둔다(이진 DXF처럼). 정확히 같게 풀 수 없는 꼴은 문자열 그대로.
 * - 다른 값은 예전과 같은 문자열(줄 그대로, 앞뒤 공백 유지).
 */
class AsciiByteTagReader implements TagReader {
  code = 0;
  value: TagValue = '';
  line = 0;
  private pos = 0;
  private readonly len: number;
  private readonly strings: ByteStrings;
  // 지금 읽은 줄 [ls, le)
  private ls = 0;
  private le = 0;

  constructor(
    private readonly data: Uint8Array,
    decoder: TextDecoder,
  ) {
    this.len = data.length;
    this.strings = new ByteStrings(data, decoder);
    // UTF-8 TextDecoder는 BOM을 떼어 낸다(파일 전체를 풀던 때와 같게)
    if (decoder.encoding === 'utf-8' && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) this.pos = 3;
  }

  progress(): number {
    return this.len ? this.pos / this.len : 1;
  }

  private readLine(): boolean {
    const d = this.data;
    const len = this.len;
    if (this.pos >= len) return false;
    // DXF 줄은 대개 짧다: 앞 64바이트는 직접 훑고(indexOf 호출보다 빠르다), 긴 줄만 indexOf로
    let nl = this.pos;
    const lim = Math.min(len, nl + 64);
    while (nl < lim && d[nl] !== 10) nl++;
    if (nl === lim && nl < len) {
      nl = d.indexOf(10, nl);
      if (nl < 0) nl = len;
    }
    let end = nl;
    if (end > this.pos && d[end - 1] === 13) end--;
    this.ls = this.pos;
    this.le = end;
    this.pos = nl + 1;
    this.line++;
    return true;
  }

  /** 줄이 공백뿐인지(String.trim 기준, 낯선 바이트가 있으면 문자열로 본다) */
  private blankLine(): boolean {
    const d = this.data;
    for (let i = this.ls; i < this.le; i++) {
      const b = d[i]!;
      if (isSpaceByte(b)) continue;
      if (b < 0x80) return false;
      return this.strings.get(this.ls, this.le).trim() === '';
    }
    return true;
  }

  /** 그룹 코드 줄 → 정수(parseInt(줄, 10)과 같다). 숫자가 없으면 NaN */
  private codeValue(): number {
    const d = this.data;
    let i = this.ls;
    const e = this.le;
    while (i < e && isSpaceByte(d[i]!)) i++;
    let neg = false;
    if (i < e && (d[i] === 45 || d[i] === 43)) {
      neg = d[i] === 45;
      i++;
    }
    let v = 0;
    let n = 0;
    for (; i < e && n < 10; i++, n++) {
      const c = d[i]!;
      if (c < 48 || c > 57) break;
      v = v * 10 + (c - 48);
    }
    // 숫자가 없거나 앞에 ASCII 밖 바이트(예: NBSP)가 있거나 너무 길면 예전처럼 문자열로
    if (n === 0 || n >= 10) return parseInt(this.strings.get(this.ls, this.le), 10);
    return neg ? -v : v;
  }

  next(): boolean {
    if (!this.readLine()) return false;
    // 파일 끝의 빈 줄은 무시한다.
    if (this.pos >= this.len && this.blankLine()) return false;
    const code = this.codeValue();
    if (Number.isNaN(code)) {
      if (this.blankLine()) return false;
      throw new CadReadError('dxf.invalid', { line: this.line, reason: 'group_code' });
    }
    if (!this.readLine()) return false;
    this.code = code;
    if (code >= 10 && code < 1072 && DOUBLE_CODE[code]) {
      const v = parseDecimalBytes(this.data, this.ls, this.le);
      this.value = v === v ? v : this.strings.get(this.ls, this.le);
    } else this.value = this.strings.get(this.ls, this.le);
    return true;
  }
}

export type ValueKind = 'str' | 'dbl' | 'i16' | 'i32' | 'i64' | 'bool' | 'bin';

const KIND_NAMES: ValueKind[] = ['str', 'dbl', 'i16', 'i32', 'i64', 'bool', 'bin'];

/** 그룹 코드의 값 형식(이진 DXF 기준, ASCII 쓰기에서도 숫자 표기를 정할 때 쓴다) */
export function valueKind(code: number): ValueKind {
  return KIND_NAMES[binaryValueType(code)]!;
}

/** 문자열 값을 갖는 그룹 코드인지(헤더 변수 해석용) */
export function isStringCode(code: number): boolean {
  const t = binaryValueType(code);
  return t === VT.Str || t === VT.Binary;
}

const HEX = '0123456789ABCDEF';

/** 그룹 코드 → 이진 값 형식(0~1071은 표, 그 밖은 계산) */
const VT_TABLE = new Uint8Array(1072);
for (let c = 0; c < VT_TABLE.length; c++) VT_TABLE[c] = binaryValueType(c);
const vtOf = (code: number): VT => (code < 1072 ? (VT_TABLE[code]! as VT) : binaryValueType(code));

class BinaryTagReader implements TagReader {
  code = 0;
  value: TagValue = '';
  private pos = 22;
  private readonly view: DataView;
  private twoByteCodes = true;
  private decoder: TextDecoder;
  /** ASCII와 호환되는 인코딩이면 짧은 문자열을 바이트에서 바로 만든다 */
  private readonly strings: ByteStrings | null;

  constructor(
    private readonly data: Uint8Array,
    encoding: string,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.decoder = decoderFor(encoding);
    this.strings = asciiCompatible(this.decoder) ? new ByteStrings(data, this.decoder) : null;
    // R12 이진 DXF는 그룹 코드가 1바이트다. 첫 태그(0 SECTION)의 둘째 바이트로 구분한다.
    this.twoByteCodes = data[22] === 0 && data[23] === 0;
  }

  progress(): number {
    return this.data.length ? this.pos / this.data.length : 1;
  }

  private readString(): string {
    const d = this.data;
    let end = d.indexOf(0, this.pos);
    if (end < 0) end = d.length;
    const s = this.strings ? this.strings.get(this.pos, end) : this.decoder.decode(d.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }

  next(): boolean {
    const v = this.view;
    if (this.pos >= this.data.length) return false;
    let code: number;
    if (this.twoByteCodes) {
      if (this.pos + 2 > this.data.length) return false;
      code = v.getUint16(this.pos, true);
      this.pos += 2;
    } else {
      code = this.data[this.pos++]!;
      if (code === 255) {
        code = v.getUint16(this.pos, true);
        this.pos += 2;
      }
    }
    this.code = code;
    switch (vtOf(code)) {
      case VT.Str:
        this.value = this.readString();
        break;
      case VT.Double:
        this.value = v.getFloat64(this.pos, true);
        this.pos += 8;
        break;
      case VT.I16:
        this.value = v.getInt16(this.pos, true);
        this.pos += 2;
        break;
      case VT.I32:
        this.value = v.getInt32(this.pos, true);
        this.pos += 4;
        break;
      case VT.I64:
        this.value = Number(v.getBigInt64(this.pos, true));
        this.pos += 8;
        break;
      case VT.Bool:
        this.value = this.data[this.pos++]!;
        break;
      case VT.Binary: {
        const n = this.data[this.pos++]!;
        let s = '';
        for (let i = 0; i < n; i++) {
          const b = this.data[this.pos + i]!;
          s += HEX[b >> 4]! + HEX[b & 15]!;
        }
        this.pos += n;
        this.value = s;
        break;
      }
    }
    return true;
  }
}

export class RecordStream {
  private pending: DxfRecord | null = null;
  private done = false;
  private readonly reader: TagReader;
  private hasTag = false;

  constructor(reader: TagReader) {
    this.reader = reader;
    this.hasTag = reader.next();
    // 첫 태그가 0이 아니면(999 주석 등) 0이 나올 때까지 건너뛴다.
    while (this.hasTag && reader.code !== 0) this.hasTag = reader.next();
  }

  private read(): DxfRecord | null {
    if (!this.hasTag) return null;
    const r = this.reader;
    const type = String(r.value).trim();
    const codes: number[] = [];
    const values: TagValue[] = [];
    while ((this.hasTag = r.next())) {
      if (r.code === 0) break;
      if (r.code === 999) continue;
      codes.push(r.code);
      values.push(r.value);
    }
    return { type, codes, values };
  }

  progress(): number {
    return this.reader.progress();
  }

  peek(): DxfRecord | null {
    if (this.pending === null && !this.done) {
      this.pending = this.read();
      if (this.pending === null) this.done = true;
    }
    return this.pending;
  }

  next(): DxfRecord | null {
    const r = this.peek();
    this.pending = null;
    return r;
  }
}

/** 파일 앞부분에서 헤더 변수 값을 찾는다(인코딩을 정하기 전에 쓴다). */
function sniffHeaderValue(head: string, name: string): string | null {
  const i = head.indexOf(name);
  if (i < 0) return null;
  // $NAME 다음 줄의 그룹 코드, 그다음 줄이 값
  const lines = head.slice(i, i + 200).split(/\r?\n/);
  return lines.length >= 3 ? lines[2]!.trim() : null;
}

export interface DxfSource {
  stream: RecordStream;
  binary: boolean;
  encoding: string;
  version: string;
  codepage: string;
}

function hasHighBytes(data: Uint8Array): boolean {
  let i = 0;
  // 4바이트씩(정렬된 부분)
  const a = (4 - (data.byteOffset & 3)) & 3;
  for (; i < a && i < data.length; i++) if (data[i]! >= 0x80) return true;
  const words = (data.length - i) >> 2;
  if (words > 0) {
    const w = new Uint32Array(data.buffer, data.byteOffset + i, words);
    for (let k = 0; k < words; k++) if (w[k]! & 0x80808080) return true;
    i += words * 4;
  }
  for (; i < data.length; i++) if (data[i]! >= 0x80) return true;
  return false;
}

/**
 * 파일 전체가 올바른 UTF-8인지. '\n' 바이트 뒤에서 나눈 조각마다 엄격 해독한다
 * (UTF-8 다중 바이트 문자에는 0x0A가 들어갈 수 없으므로 통째로 푼 것과 같은 판정이고, 큰 파일도 문자열 길이 한계에 걸리지 않는다).
 */
function isValidUtf8(data: Uint8Array): boolean {
  const dec = new TextDecoder('utf-8', { fatal: true });
  const CHUNK = 1 << 22;
  try {
    for (let s = 0; s < data.length; ) {
      let e = Math.min(data.length, s + CHUNK);
      if (e < data.length) {
        const nl = data.indexOf(10, e);
        e = nl < 0 ? data.length : nl + 1;
      }
      dec.decode(data.subarray(s, e));
      s = e;
    }
    return true;
  } catch {
    return false;
  }
}

export interface OpenDxfOptions {
  /** 시험용: 예전 문자열 토큰화기(파일 전체를 문자열로 푼다)를 쓴다 */
  legacyText?: boolean;
}

export function openDxf(data: Uint8Array, codepageEncoding: (cp: string) => string, options: OpenDxfOptions = {}): DxfSource {
  if (isBinaryDxf(data)) {
    // 이진 DXF: 헤더에서 버전·코드 페이지를 먼저 찾는다.
    const head = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 1 << 16)));
    const verIdx = head.indexOf('$ACADVER');
    let version = 'AC1009';
    if (verIdx >= 0) {
      const m = /AC10\d\d/.exec(head.slice(verIdx, verIdx + 40));
      if (m) version = m[0];
    }
    const cpIdx = head.indexOf('$DWGCODEPAGE');
    let codepage = 'ANSI_1252';
    if (cpIdx >= 0) {
      const m = /(ANSI_\d+|DOS\d+|ISO[_-]?8859[_-]?\d+|UTF8|BIG5|GB2312|KSC5601|JOHAB|MACINTOSH)/i.exec(head.slice(cpIdx, cpIdx + 60));
      if (m) codepage = m[1]!.toUpperCase();
    }
    const encoding = version >= 'AC1021' ? 'utf-8' : codepageEncoding(codepage);
    return { stream: new RecordStream(new BinaryTagReader(data, encoding)), binary: true, encoding, version, codepage };
  }

  const head = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 1 << 16)));
  const version = sniffHeaderValue(head, '$ACADVER') ?? 'AC1009';
  const codepage = (sniffHeaderValue(head, '$DWGCODEPAGE') ?? 'ANSI_1252').toUpperCase();
  let encoding: string;
  if (version >= 'AC1021') encoding = 'utf-8';
  else if (hasHighBytes(data) && isValidUtf8(data)) encoding = 'utf-8';
  else encoding = codepageEncoding(codepage);
  const decoder = decoderFor(encoding);
  // ASCII와 호환되는 인코딩은 바이트에서 바로 읽는다(큰 파일도 문자열 길이 한계 없이, 잘라 낸 문자열이 파일 전체를 붙잡지 않게).
  const reader = !options.legacyText && asciiCompatible(decoder) ? new AsciiByteTagReader(data, decoder) : new StringTagReader(decoder.decode(data));
  return { stream: new RecordStream(reader), binary: false, encoding, version, codepage };
}
