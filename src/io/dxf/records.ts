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

class AsciiTagReader implements TagReader {
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

class BinaryTagReader implements TagReader {
  code = 0;
  value: TagValue = '';
  private pos = 22;
  private readonly view: DataView;
  private twoByteCodes = true;
  private decoder: TextDecoder;

  constructor(
    private readonly data: Uint8Array,
    encoding: string,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.decoder = decoderFor(encoding);
    // R12 이진 DXF는 그룹 코드가 1바이트다. 첫 태그(0 SECTION)의 둘째 바이트로 구분한다.
    this.twoByteCodes = data[22] === 0 && data[23] === 0;
  }

  progress(): number {
    return this.data.length ? this.pos / this.data.length : 1;
  }

  private readString(): string {
    const d = this.data;
    let end = this.pos;
    while (end < d.length && d[end] !== 0) end++;
    const s = this.decoder.decode(d.subarray(this.pos, end));
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
    switch (binaryValueType(code)) {
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
  for (let i = 0; i < data.length; i++) if (data[i]! >= 0x80) return true;
  return false;
}

function isValidUtf8(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

export function openDxf(data: Uint8Array, codepageEncoding: (cp: string) => string): DxfSource {
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
  const text = decoderFor(encoding).decode(data);
  return { stream: new RecordStream(new AsciiTagReader(text)), binary: false, encoding, version, codepage };
}
