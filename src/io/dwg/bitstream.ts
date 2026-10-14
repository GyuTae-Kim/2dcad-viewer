/**
 * DWG 비트 단위 읽기(ODA 공개 사양 2장).
 * 정수 연산만 쓰고 비트마다 객체를 만들지 않는다. 같은 버퍼 위에 읽기 위치만 다른
 * 여러 리더(자료·문자열·핸들 흐름)를 둘 수 있다.
 */
import type { Vec2, Vec3 } from '../../core/model';
import { R2000, R2004, R2007, R2010 } from './version';

/** 읽는 도중 자료가 끝났거나 값이 말이 안 될 때 */
export class DwgFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DwgFormatError';
  }
}

const scratch = new DataView(new ArrayBuffer(8));

/** CMC/ENC 색 읽기 결과 */
export interface DwgColor {
  /** ACI(0 ByBlock, 256 ByLayer) */
  index: number;
  /** 0xC2RRGGBB 같은 원본 32비트 값(없으면 undefined) */
  rgb?: number;
  name?: string;
  book?: string;
  /** -1 ByLayer, -2 ByBlock, 0..255 */
  transparency?: number;
  /** DBCOLOR 핸들이 핸들 흐름에 있음 */
  hasColorHandle?: boolean;
}

export class BitReader {
  buf: Uint8Array;
  dv: DataView;
  /** 비트 위치 */
  pos = 0;
  /** 읽기 한계(비트) */
  end: number;
  ver: number;
  /** R2007 이전 문자열 해석기 */
  decoder: TextDecoder;
  /** 문자열을 읽을 리더(R2007+ 문자열 흐름). 기본은 자기 자신 */
  strReader: BitReader;

  constructor(buf: Uint8Array, ver: number, decoder: TextDecoder) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.end = buf.length * 8;
    this.ver = ver;
    this.decoder = decoder;
    this.strReader = this;
  }

  /** 같은 버퍼를 쓰는 새 리더 */
  fork(): BitReader {
    const r = new BitReader(this.buf, this.ver, this.decoder);
    r.pos = this.pos;
    r.end = this.end;
    return r;
  }

  get bytePos(): number {
    return this.pos >>> 3;
  }

  overflowed(): boolean {
    return this.pos > this.end;
  }

  remainingBits(): number {
    return this.end - this.pos;
  }

  /** 개수 값이 남은 비트로 가능한지 확인 */
  checkCount(n: number, minBitsEach = 1): number {
    if (!(n >= 0) || n * minBitsEach > this.end - this.pos + 64) {
      throw new DwgFormatError(`잘못된 개수 ${n}`);
    }
    return n;
  }

  alignByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }

  // -------------------------------------------------------------------------
  // 원시 값
  // -------------------------------------------------------------------------

  B(): number {
    const p = this.pos++;
    return (this.buf[p >>> 3] >> (7 - (p & 7))) & 1;
  }

  bool(): boolean {
    return this.B() === 1;
  }

  BB(): number {
    const p = this.pos;
    this.pos = p + 2;
    const i = p >>> 3;
    const bit = p & 7;
    if (bit < 7) return (this.buf[i] >> (6 - bit)) & 3;
    return ((this.buf[i] & 1) << 1) | (this.buf[i + 1] >> 7);
  }

  /** 1~3비트(3B) */
  B3(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.B();
      v = (v << 1) | b;
      if (b === 0) break;
    }
    return v;
  }

  /** n비트(최대 24) 부호 없는 값, 상위 비트 먼저 */
  bits(n: number): number {
    let v = 0;
    while (n > 0) {
      const p = this.pos;
      const i = p >>> 3;
      const bit = p & 7;
      const take = Math.min(8 - bit, n);
      const byte = this.buf[i];
      v = (v << take) | ((byte >> (8 - bit - take)) & ((1 << take) - 1));
      this.pos = p + take;
      n -= take;
    }
    return v;
  }

  RC(): number {
    const p = this.pos;
    this.pos = p + 8;
    const i = p >>> 3;
    const bit = p & 7;
    if (bit === 0) return this.buf[i] ?? 0;
    return ((this.buf[i] << bit) | ((this.buf[i + 1] ?? 0) >> (8 - bit))) & 0xff;
  }

  /** 부호 있는 16비트 */
  RS(): number {
    const lo = this.RC();
    const hi = this.RC();
    return (((hi << 8) | lo) << 16) >> 16;
  }

  /** 부호 없는 16비트 */
  RSu(): number {
    const lo = this.RC();
    return lo | (this.RC() << 8);
  }

  /** 부호 있는 32비트 */
  RL(): number {
    const p = this.pos;
    if ((p & 7) === 0 && (p >>> 3) + 4 <= this.buf.length) {
      this.pos = p + 32;
      return this.dv.getInt32(p >>> 3, true);
    }
    const a = this.RC();
    const b = this.RC();
    const c = this.RC();
    const d = this.RC();
    return a | (b << 8) | (c << 16) | (d << 24);
  }

  RLu(): number {
    return this.RL() >>> 0;
  }

  RD(): number {
    const p = this.pos;
    if ((p & 7) === 0 && (p >>> 3) + 8 <= this.buf.length) {
      this.pos = p + 64;
      return this.dv.getFloat64(p >>> 3, true);
    }
    for (let k = 0; k < 8; k++) scratch.setUint8(k, this.RC());
    return scratch.getFloat64(0, true);
  }

  // -------------------------------------------------------------------------
  // 압축 값
  // -------------------------------------------------------------------------

  BS(): number {
    switch (this.BB()) {
      case 0:
        return this.RS();
      case 1:
        return this.RC();
      case 2:
        return 0;
      default:
        return 256;
    }
  }

  BL(): number {
    switch (this.BB()) {
      case 0:
        return this.RL();
      case 1:
        return this.RC();
      default:
        return 0;
    }
  }

  BLu(): number {
    return this.BL() >>> 0;
  }

  /** BitLongLong: 3비트 바이트 수 + 바이트(사양 2.4는 3B라 하지만 실제는 고정 3비트) */
  BLL(): number {
    const n = this.bits(3);
    let v = 0;
    let mul = 1;
    for (let i = 0; i < n; i++) {
      v += this.RC() * mul;
      mul *= 256;
    }
    return v;
  }

  BD(): number {
    switch (this.BB()) {
      case 0:
        return this.RD();
      case 1:
        return 1;
      case 2:
        return 0;
      default:
        return 0;
    }
  }

  /** BitDouble With Default */
  DD(def: number): number {
    switch (this.BB()) {
      case 0:
        return def;
      case 1: {
        scratch.setFloat64(0, def, true);
        for (let k = 0; k < 4; k++) scratch.setUint8(k, this.RC());
        return scratch.getFloat64(0, true);
      }
      case 2: {
        scratch.setFloat64(0, def, true);
        scratch.setUint8(4, this.RC());
        scratch.setUint8(5, this.RC());
        for (let k = 0; k < 4; k++) scratch.setUint8(k, this.RC());
        return scratch.getFloat64(0, true);
      }
      default:
        return this.RD();
    }
  }

  /** 바이트 단위 Modular Char(부호 있음) */
  MC(): number {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.RC();
      if (b & 0x80) {
        v += (b & 0x7f) * mul;
        mul *= 128;
      } else {
        const neg = (b & 0x40) !== 0;
        v += (b & 0x3f) * mul;
        return neg ? -v : v;
      }
    }
    return v;
  }

  /** 부호 없는 Modular Char */
  UMC(): number {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.RC();
      v += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) break;
    }
    return v;
  }

  /** Modular Short */
  MS(): number {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 4; i++) {
      const w = this.RSu();
      v += (w & 0x7fff) * mul;
      mul *= 0x8000;
      if (!(w & 0x8000)) break;
    }
    return v;
  }

  /** 객체 종류(R2010+는 비트쌍 + 1~2바이트) */
  OT(): number {
    if (this.ver >= R2010) {
      switch (this.BB()) {
        case 0:
          return this.RC();
        case 1:
          return this.RC() + 0x1f0;
        default:
          return this.RSu();
      }
    }
    return this.BS();
  }

  // -------------------------------------------------------------------------
  // 핸들
  // -------------------------------------------------------------------------

  /** 마지막으로 읽은 핸들의 코드 */
  lastCode = 0;

  /** 핸들 참조. 상대 코드(6, 8, A, C)는 base 기준으로 푼다. */
  H(base = 0): number {
    const cc = this.RC();
    const code = cc >> 4;
    const n = cc & 15;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.RC();
    this.lastCode = code;
    switch (code) {
      case 6:
        return base + 1;
      case 8:
        return base - 1;
      case 10:
        return base + v;
      case 12:
        return base - v;
      default:
        return v;
    }
  }

  // -------------------------------------------------------------------------
  // 문자열
  // -------------------------------------------------------------------------

  /** 코드 페이지 문자열(T): BS 길이 + 바이트 */
  T(): string {
    const len = this.BS();
    if (len <= 0) return '';
    this.checkCount(len, 8);
    return this.bytesToString(len);
  }

  /** n바이트를 코드 페이지로 해석 */
  bytesToString(len: number): string {
    const p = this.pos;
    let bytes: Uint8Array;
    if ((p & 7) === 0) {
      const s = p >>> 3;
      bytes = this.buf.subarray(s, s + len);
      this.pos = p + len * 8;
    } else {
      bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = this.RC();
    }
    return decodeBytes(bytes, this.decoder);
  }

  /** 유니코드 문자열(TU): BS 글자 수 + UTF-16LE */
  TU(): string {
    if (this.pos >= this.end) return '';
    const len = this.BS();
    if (len <= 0) return '';
    this.checkCount(len, 16);
    const codes: number[] = new Array(len);
    let n = len;
    for (let i = 0; i < len; i++) codes[i] = this.RSu();
    while (n > 0 && codes[n - 1] === 0) n--;
    return codesToString(codes, n);
  }

  /** 버전에 따른 문자열(TV). R2007+는 문자열 흐름에서 읽는다. */
  TV(): string {
    if (this.ver >= R2007) return this.strReader.TU();
    return this.T();
  }

  // -------------------------------------------------------------------------
  // 점·벡터
  // -------------------------------------------------------------------------

  RD2(): Vec2 {
    const x = this.RD();
    return { x, y: this.RD() };
  }

  RD3(): Vec3 {
    const x = this.RD();
    const y = this.RD();
    return { x, y, z: this.RD() };
  }

  BD2(): Vec2 {
    const x = this.BD();
    return { x, y: this.BD() };
  }

  BD3(): Vec3 {
    const x = this.BD();
    const y = this.BD();
    return { x, y, z: this.BD() };
  }

  DD2(def: Vec2): Vec2 {
    const x = this.DD(def.x);
    return { x, y: this.DD(def.y) };
  }

  DD3(def: Vec3): Vec3 {
    const x = this.DD(def.x);
    const y = this.DD(def.y);
    return { x, y, z: this.DD(def.z) };
  }

  /** BitExtrusion */
  BE(): Vec3 {
    if (this.ver >= R2000) {
      if (this.B()) return { x: 0, y: 0, z: 1 };
    }
    return this.BD3();
  }

  /** BitThickness */
  BT(): number {
    if (this.ver >= R2000) {
      if (this.B()) return 0;
    }
    return this.BD();
  }

  // -------------------------------------------------------------------------
  // 색
  // -------------------------------------------------------------------------

  /** CMC: 표 레코드 등의 색 */
  CMC(): DwgColor {
    const index = this.BS();
    if (this.ver < R2004) return { index };
    const rgb = this.BLu();
    const flags = this.RC();
    const c: DwgColor = { index, rgb };
    if (flags & 1) c.name = this.TV();
    if (flags & 2) c.book = this.TV();
    return c;
  }

  /** ENC: 객체 색(R2004+는 플래그·RGB·투명도) */
  ENC(): DwgColor {
    if (this.ver < R2004) return { index: this.BS() };
    const v = this.BS();
    const flags = v & 0xff00;
    const c: DwgColor = { index: v & 0x0fff };
    // 0x4000(색상표 색 참조)이면 RGB는 자료에 없고 DBCOLOR 객체가 가진다
    if (flags & 0x4000) c.hasColorHandle = true;
    else if (flags & 0x8000) c.rgb = this.BLu();
    if (flags & 0x2000) {
      const t = this.BLu();
      const kind = t >>> 24;
      c.transparency = kind === 0 ? -1 : kind === 1 ? -2 : t & 0xff;
    }
    return c;
  }
}

const asciiOnly = (b: Uint8Array): boolean => {
  for (let i = 0; i < b.length; i++) if (b[i] >= 0x80) return false;
  return true;
};

/** 바이트 → 문자열. 끝의 0 바이트는 버린다. */
export function decodeBytes(bytes: Uint8Array, decoder: TextDecoder): string {
  let n = bytes.length;
  // 0 바이트에서 자른다(고정 길이 영역에 남은 쓰레기 제거)
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      n = i;
      break;
    }
  }
  if (n === 0) return '';
  const b = n === bytes.length ? bytes : bytes.subarray(0, n);
  if (asciiOnly(b)) {
    let s = '';
    for (let i = 0; i < b.length; i += 4096) {
      s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 4096)));
    }
    return s;
  }
  return decoder.decode(b);
}

export function codesToString(codes: number[], n: number): string {
  if (n <= 0) return '';
  let s = '';
  for (let i = 0; i < n; i += 4096) {
    s += String.fromCharCode.apply(null, codes.slice(i, Math.min(n, i + 4096)));
  }
  return s;
}
