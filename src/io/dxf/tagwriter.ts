/**
 * DXF 태그 쓰기. 같은 태그 흐름을 ASCII와 이진 DXF로 직렬화한다.
 * - 값의 표기(정수·실수·문자열·이진)는 그룹 코드로 정한다(이진 DXF 형식 표와 같다).
 * - R2007(AC1021)부터 문자열은 UTF-8, 그 전은 $DWGCODEPAGE 코드 페이지로 쓰고
 *   코드 페이지에 없는 문자는 AutoCAD처럼 \U+XXXX로 쓴다(escapeNonAscii면 모든 비ASCII 문자를 \U+XXXX로).
 * - 제어 문자(0x00~0x1F)는 AutoCAD처럼 ^ 표기(^J, ^I …)로 바꾼다.
 */
import type { RawTag } from '../../core/model';
import { codepageToEncoding, decoderFor } from '../../core/codepage';
import { BINARY_SENTINEL, valueKind, type ValueKind } from './records';

export type DxfVersion = 'AC1009' | 'AC1015' | 'AC1018' | 'AC1021' | 'AC1024' | 'AC1027' | 'AC1032';

export const DXF_VERSIONS: readonly DxfVersion[] = ['AC1009', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'];

/** "AC1015" → 1015 */
export function versionNum(v: string): number {
  const n = Number(v.slice(2));
  return Number.isFinite(n) ? n : 1032;
}

/** 태그를 받는 곳 */
export interface TagSink {
  tag(code: number, value: string | number): void;
}

/** 태그를 배열에 모은다(객체 하나의 태그를 꺼낼 때). */
export class CollectSink implements TagSink {
  readonly tags: RawTag[] = [];
  tag(code: number, value: string | number): void {
    this.tags.push({ code, value });
  }
}

const KIND_CACHE: ValueKind[] = [];
export function kindOf(code: number): ValueKind {
  if (code >= 0 && code < 1100) {
    let k = KIND_CACHE[code];
    if (k === undefined) k = KIND_CACHE[code] = valueKind(code);
    return k;
  }
  return valueKind(code);
}

/** 그룹 코드로 쓸 수 있는 값인지(원본 태그 검사: 구조를 깨는 0번 코드, 범위를 넘는 정수 등) */
export function rawTagValid(code: number, value: string | number): boolean {
  if (!Number.isInteger(code) || code <= 0 || code > 1071) return false;
  const k = kindOf(code);
  if (k === 'str' || k === 'bin') return true;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return typeof value === 'string' && k === 'dbl' && value.includes(',');
  if (k === 'dbl') return true;
  if (!Number.isInteger(n)) return false;
  if (k === 'bool') return n >= -128 && n <= 255;
  // 280~289는 8비트 정수다.
  if (code >= 280 && code <= 289) return n >= -128 && n <= 255;
  if (k === 'i16') return n >= -32768 && n <= 65535;
  if (k === 'i32') return n >= -2147483648 && n <= 4294967295;
  return true;
}

/** 원본 태그 목록이 모두 쓸 수 있는 값인지 */
export function rawTagsValid(tags: readonly RawTag[]): boolean {
  for (const t of tags) if (!rawTagValid(t.code, t.value)) return false;
  return true;
}

/** 실수 표기: 가장 짧은 왕복 표기에 소수점을 붙인다(1 → "1.0"). */
export function formatDouble(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  if (v === 0) return '0.0';
  const s = String(v);
  if (s.indexOf('.') < 0 && s.indexOf('e') < 0) return s + '.0';
  return s;
}

function toNumber(v: string | number): number {
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v: string | number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  const t = v.trim();
  const n = /^[-+]?0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// 코드 페이지 인코딩(TextDecoder로 역표를 만든다)

type CharMap = Map<number, number>;
const charMaps = new Map<string, CharMap | null>();

const DBCS = new Set(['shift_jis', 'gbk', 'big5', 'euc-kr']);

/** 코드 페이지의 문자 → 바이트(1바이트는 0~255, 2바이트는 lead << 8 | trail). 만들 수 없으면 null */
function charMapFor(encoding: string): CharMap | null {
  if (charMaps.has(encoding)) return charMaps.get(encoding)!;
  let map: CharMap | null = null;
  if (encoding !== 'utf-8' && encoding !== 'utf-16le') {
    try {
      const dec = decoderFor(encoding);
      map = new Map();
      const one = new Uint8Array(1);
      for (let b = 0x80; b <= 0xff; b++) {
        one[0] = b;
        const s = dec.decode(one);
        if (s.length === 1 && s !== '�' && !map.has(s.charCodeAt(0))) map.set(s.charCodeAt(0), b);
      }
      if (DBCS.has(encoding)) {
        const two = new Uint8Array(2);
        for (let lead = 0x81; lead <= 0xfe; lead++) {
          for (let trail = 0x40; trail <= 0xfe; trail++) {
            if (trail === 0x7f) continue;
            two[0] = lead;
            two[1] = trail;
            const s = dec.decode(two);
            if (s.length !== 1 || s === '�') continue;
            const cu = s.charCodeAt(0);
            if (cu < 0x80 || map.has(cu)) continue;
            map.set(cu, (lead << 8) | trail);
          }
        }
      }
    } catch {
      map = null;
    }
  }
  charMaps.set(encoding, map);
  return map;
}

/** 코드 페이지가 문자를 담을 수 있는지 */
export function codepageCanEncode(codepage: string, cu: number): boolean {
  if (cu < 0x80) return true;
  const m = charMapFor(codepageToEncoding(codepage));
  return !!m && m.has(cu);
}

const HEXU = '0123456789ABCDEF';

function uEscape(cu: number): string {
  return '\\U+' + HEXU[(cu >> 12) & 15]! + HEXU[(cu >> 8) & 15]! + HEXU[(cu >> 4) & 15]! + HEXU[cu & 15]!;
}

/** 제어 문자 → ^ 표기 */
function caret(s: string): string {
  // 빠른 길: 제어 문자가 없으면 그대로
  let need = false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) {
      need = true;
      break;
    }
  }
  if (!need) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x20 ? '^' + String.fromCharCode(c + 64) : s[i];
  }
  return out;
}

export interface SerializerOptions {
  version: DxfVersion;
  binary: boolean;
  codepage: string;
  escapeNonAscii?: boolean;
}

/**
 * 태그 → 바이트. 문자열은 R2007+ UTF-8, 그 전은 "바이트 문자열"(문자 하나 = 바이트 하나)로 모아 둔다.
 * unencodable에는 코드 페이지에 없어 \U+로 쓴 문자를 모은다(경고용).
 */
export class DxfSerializer implements TagSink {
  readonly utf8: boolean;
  readonly binary: boolean;
  private readonly r12: boolean;
  private readonly map: CharMap | null;
  readonly unencodable = new Set<number>();
  private chunks: Uint8Array[] = [];
  private parts: string[] = [];
  private partLen = 0;
  // 이진
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;
  private readonly enc = new TextEncoder();

  constructor(opts: SerializerOptions) {
    this.utf8 = versionNum(opts.version) >= 1021;
    this.binary = opts.binary;
    this.r12 = versionNum(opts.version) <= 1009;
    this.map = this.utf8 || opts.escapeNonAscii ? null : charMapFor(codepageToEncoding(opts.codepage));
    this.buf = new Uint8Array(this.binary ? 1 << 16 : 0);
    this.view = new DataView(this.buf.buffer);
  }

  /** 이진 DXF 머리 */
  writeSentinel(): void {
    if (!this.binary) return;
    for (let i = 0; i < BINARY_SENTINEL.length; i++) this.byte(BINARY_SENTINEL.charCodeAt(i));
  }

  /** 문자열 값 → 출력 문자열(UTF-8 모드) 또는 바이트 문자열 */
  private text(s: string): string {
    s = caret(s);
    if (this.utf8) return s;
    let ascii = true;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x7e) {
        ascii = false;
        break;
      }
    }
    if (ascii) return s;
    let out = '';
    const map = this.map;
    for (let i = 0; i < s.length; i++) {
      const cu = s.charCodeAt(i);
      if (cu <= 0x7e) {
        out += s[i];
        continue;
      }
      const b = map?.get(cu);
      if (b === undefined) {
        this.unencodable.add(cu);
        out += uEscape(cu);
      } else if (b > 0xff) out += String.fromCharCode(b >> 8, b & 0xff);
      else out += String.fromCharCode(b);
    }
    return out;
  }

  tag(code: number, value: string | number): void {
    const kind = kindOf(code);
    if (this.binary) {
      this.binTag(code, kind, value);
      return;
    }
    let v: string;
    switch (kind) {
      case 'dbl':
        v = formatDouble(toNumber(value));
        break;
      case 'i16':
      case 'i32':
      case 'i64':
      case 'bool':
        v = String(toInt(value));
        break;
      case 'bin':
        v = typeof value === 'string' ? value.trim().toUpperCase() : String(value);
        break;
      default:
        v = this.text(typeof value === 'string' ? value : String(value));
    }
    const cs = code < 10 ? '  ' + code : code < 100 ? ' ' + code : String(code);
    this.push(cs + '\r\n' + v + '\r\n');
  }

  private push(s: string): void {
    this.parts.push(s);
    this.partLen += s.length;
    if (this.partLen > 1 << 20) this.flushText();
  }

  private flushText(): void {
    if (!this.parts.length) return;
    const s = this.parts.join('');
    this.parts = [];
    this.partLen = 0;
    if (this.utf8) this.chunks.push(this.enc.encode(s));
    else {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      this.chunks.push(b);
    }
  }

  // --- 이진

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }

  private byte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  private binTag(code: number, kind: ValueKind, value: string | number): void {
    if (this.r12) {
      // R12 이진 DXF: 그룹 코드 1바이트(255 이상은 255 + int16)
      if (code < 255) this.byte(code);
      else {
        this.byte(255);
        this.ensure(2);
        this.view.setInt16(this.pos, code, true);
        this.pos += 2;
      }
    } else {
      this.ensure(2);
      this.view.setUint16(this.pos, code, true);
      this.pos += 2;
    }
    switch (kind) {
      case 'dbl':
        this.ensure(8);
        this.view.setFloat64(this.pos, toNumber(value), true);
        this.pos += 8;
        return;
      case 'i16':
        this.ensure(2);
        this.view.setInt16(this.pos, toInt(value), true);
        this.pos += 2;
        return;
      case 'i32':
        this.ensure(4);
        this.view.setInt32(this.pos, toInt(value) | 0, true);
        this.pos += 4;
        return;
      case 'i64':
        this.ensure(8);
        this.view.setBigInt64(this.pos, BigInt(toInt(value)), true);
        this.pos += 8;
        return;
      case 'bool':
        this.byte(toInt(value) ? 1 : 0);
        return;
      case 'bin': {
        const hex = typeof value === 'string' ? value.trim() : '';
        const n = Math.min(255, hex.length >> 1);
        this.byte(n);
        this.ensure(n);
        for (let i = 0; i < n; i++) this.buf[this.pos++] = parseInt(hex.substr(i * 2, 2), 16) || 0;
        return;
      }
      default: {
        const s = this.text(typeof value === 'string' ? value : String(value));
        if (this.utf8) {
          const b = this.enc.encode(s);
          this.ensure(b.length + 1);
          this.buf.set(b, this.pos);
          this.pos += b.length;
        } else {
          this.ensure(s.length + 1);
          for (let i = 0; i < s.length; i++) this.buf[this.pos++] = s.charCodeAt(i) & 0xff;
        }
        this.buf[this.pos++] = 0;
      }
    }
  }

  /** 지금까지 쓴 바이트 */
  finish(): Uint8Array[] {
    if (this.binary) {
      const out = this.buf.slice(0, this.pos);
      this.pos = 0;
      return [out];
    }
    this.flushText();
    const c = this.chunks;
    this.chunks = [];
    return c;
  }
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
