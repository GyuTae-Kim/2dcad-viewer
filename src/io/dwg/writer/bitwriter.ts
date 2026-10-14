/**
 * DWG 비트 단위 쓰기(사양 2장, bitstream.ts의 짝).
 * 버퍼는 필요할 때 두 배로 늘린다. 값마다 가장 짧은 압축 형식을 고른다.
 */
import type { Vec2, Vec3 } from '../../../core/model';
import { R2000, R2004, R2007, R2010 } from '../version';
import type { TextEncoderCp } from './codepage';

const scratch = new DataView(new ArrayBuffer(8));

/** 쓸 색(CMC·ENC) */
export interface WColor {
  /** ACI 번호(0 ByBlock, 256 ByLayer, 257 없음) */
  index: number;
  /** 0xRRGGBB(트루컬러) */
  rgb?: number;
  /** "책$이름"이면 색상표 색 */
  name?: string;
  book?: string;
  /** -1 ByLayer, -2 ByBlock, 0..255 */
  transparency?: number;
  /** DBCOLOR 핸들(ENC 0x4000) */
  dbColor?: number;
}

export class BitWriter {
  buf: Uint8Array;
  /** 비트 위치 */
  pos = 0;
  readonly ver: number;
  readonly enc: TextEncoderCp;
  /** R2007+ 문자열을 쓸 곳(없으면 자기 자신) */
  strWriter: BitWriter;

  constructor(ver: number, enc: TextEncoderCp, initial = 256) {
    this.buf = new Uint8Array(initial);
    this.ver = ver;
    this.enc = enc;
    this.strWriter = this;
  }

  private ensure(bits: number): void {
    const need = (this.pos + bits + 7) >>> 3;
    if (need <= this.buf.length) return;
    let n = this.buf.length * 2;
    while (n < need) n *= 2;
    const b = new Uint8Array(n);
    b.set(this.buf);
    this.buf = b;
  }

  /** 쓴 바이트(마지막 바이트의 남은 비트는 0) */
  bytes(): Uint8Array {
    const out = this.buf.slice(0, (this.pos + 7) >>> 3);
    const rest = this.pos & 7;
    if (rest) out[out.length - 1] &= 0xff << (8 - rest);
    return out;
  }

  /** 다시 쓰기(버퍼는 그대로 둔다) */
  reset(): void {
    this.pos = 0;
  }

  /** 이미 쓴 자리의 n비트 값을 바꾼다(위치는 그대로) */
  patchBits(at: number, n: number, v: number): void {
    const save = this.pos;
    this.pos = at;
    this.bits(n, v);
    this.pos = save;
  }

  /** 이미 쓴 자리의 RL을 바꾼다 */
  patchRL(at: number, v: number): void {
    const save = this.pos;
    this.pos = at;
    this.RL(v);
    this.pos = save;
  }

  byteLength(): number {
    return (this.pos + 7) >>> 3;
  }

  alignByte(): void {
    this.pos = (this.pos + 7) & ~7;
    this.ensure(0);
  }

  // -------------------------------------------------------------------------
  // 원시 값
  // -------------------------------------------------------------------------

  B(v: number | boolean): void {
    this.ensure(1);
    const p = this.pos++;
    if (v) this.buf[p >>> 3] |= 0x80 >> (p & 7);
    else this.buf[p >>> 3] &= ~(0x80 >> (p & 7));
  }

  /** n비트 값(상위 비트 먼저, n ≤ 32) */
  bits(n: number, v: number): void {
    for (let i = n - 1; i >= 0; i--) this.B((v >>> i) & 1);
  }

  BB(v: number): void {
    this.B((v >> 1) & 1);
    this.B(v & 1);
  }

  RC(v: number): void {
    this.ensure(8);
    const p = this.pos;
    const i = p >>> 3;
    const bit = p & 7;
    v &= 0xff;
    if (bit === 0) this.buf[i] = v;
    else {
      this.buf[i] = (this.buf[i] & (0xff << (8 - bit))) | (v >> bit);
      this.buf[i + 1] = (v << (8 - bit)) & 0xff;
    }
    this.pos = p + 8;
  }

  RS(v: number): void {
    this.RC(v & 0xff);
    this.RC((v >> 8) & 0xff);
  }

  RL(v: number): void {
    this.RC(v & 0xff);
    this.RC((v >>> 8) & 0xff);
    this.RC((v >>> 16) & 0xff);
    this.RC((v >>> 24) & 0xff);
  }

  RD(v: number): void {
    scratch.setFloat64(0, v, true);
    for (let k = 0; k < 8; k++) this.RC(scratch.getUint8(k));
  }

  /** 바이트 배열 그대로 */
  rawBytes(b: Uint8Array): void {
    if ((this.pos & 7) === 0) {
      this.ensure(b.length * 8);
      this.buf.set(b, this.pos >>> 3);
      this.pos += b.length * 8;
    } else for (let i = 0; i < b.length; i++) this.RC(b[i]);
  }

  /** 다른 BitWriter의 비트를 이어 붙인다 */
  appendBits(src: BitWriter, nbits = src.pos): void {
    this.appendRaw(src.buf, nbits);
  }

  /** 바이트 배열 앞쪽 nbits 비트를 이어 붙인다 */
  appendRaw(buf: Uint8Array, nbits: number): void {
    if ((this.pos & 7) === 0 && (nbits & 7) === 0) {
      this.rawBytes(buf.subarray(0, nbits >>> 3));
      return;
    }
    const full = nbits >>> 3;
    for (let i = 0; i < full; i++) this.RC(buf[i]);
    const rest = nbits & 7;
    if (rest) this.bits(rest, buf[full] >> (8 - rest));
  }

  // -------------------------------------------------------------------------
  // 압축 값
  // -------------------------------------------------------------------------

  BS(v: number): void {
    v = v | 0;
    if (v === 0) this.BB(2);
    else if (v === 256) this.BB(3);
    else if (v > 0 && v < 256) {
      this.BB(1);
      this.RC(v);
    } else {
      this.BB(0);
      this.RS(v & 0xffff);
    }
  }

  BL(v: number): void {
    v = v | 0;
    if (v === 0) this.BB(2);
    else if (v > 0 && v < 256) {
      this.BB(1);
      this.RC(v);
    } else {
      this.BB(0);
      this.RL(v);
    }
  }

  BLL(v: number): void {
    let n = 0;
    let x = v;
    while (x > 0 && n < 7) {
      n++;
      x = Math.floor(x / 256);
    }
    this.bits(3, n);
    x = v;
    for (let i = 0; i < n; i++) {
      this.RC(x % 256);
      x = Math.floor(x / 256);
    }
  }

  BD(v: number): void {
    if (v === 1) this.BB(1);
    else if (v === 0 && !Object.is(v, -0)) this.BB(2);
    else {
      this.BB(0);
      this.RD(v);
    }
  }

  /** BitDouble With Default */
  DD(v: number, def: number): void {
    if (v === def || (Number.isNaN(v) && Number.isNaN(def))) {
      this.BB(0);
      return;
    }
    scratch.setFloat64(0, v, true);
    const vb = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => scratch.getUint8(k));
    scratch.setFloat64(0, def, true);
    const db = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => scratch.getUint8(k));
    if (vb[4] === db[4] && vb[5] === db[5] && vb[6] === db[6] && vb[7] === db[7]) {
      this.BB(1);
      for (let k = 0; k < 4; k++) this.RC(vb[k]);
    } else if (vb[6] === db[6] && vb[7] === db[7]) {
      this.BB(2);
      this.RC(vb[4]);
      this.RC(vb[5]);
      for (let k = 0; k < 4; k++) this.RC(vb[k]);
    } else {
      this.BB(3);
      this.RD(v);
    }
  }

  /** 바이트 단위 Modular Char(부호 있음) */
  MC(v: number): void {
    const neg = v < 0;
    let x = Math.abs(v);
    for (;;) {
      if (x < 0x40) {
        this.RC(x | (neg ? 0x40 : 0));
        return;
      }
      this.RC((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
  }

  /** 부호 없는 Modular Char */
  UMC(v: number): void {
    let x = v;
    for (;;) {
      if (x < 0x80) {
        this.RC(x);
        return;
      }
      this.RC((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
  }

  /** Modular Short */
  MS(v: number): void {
    let x = v;
    for (;;) {
      if (x < 0x8000) {
        this.RS(x);
        return;
      }
      this.RS((x & 0x7fff) | 0x8000);
      x = Math.floor(x / 0x8000);
    }
  }

  /** 객체 종류 */
  OT(t: number): void {
    if (this.ver >= R2010) {
      if (t < 256) {
        this.BB(0);
        this.RC(t);
      } else if (t >= 0x1f0 && t < 0x1f0 + 256) {
        this.BB(1);
        this.RC(t - 0x1f0);
      } else {
        this.BB(2);
        this.RS(t);
      }
      return;
    }
    this.BS(t);
  }

  // -------------------------------------------------------------------------
  // 핸들
  // -------------------------------------------------------------------------

  /** 핸들 참조(절대 값). code: 2 소프트 소유, 3 하드 소유, 4 소프트 포인터, 5 하드 포인터, 0 핸들 자체 */
  H(code: number, value: number): void {
    const bytes: number[] = [];
    let x = value;
    while (x > 0) {
      bytes.unshift(x % 256);
      x = Math.floor(x / 256);
    }
    this.RC(((code & 15) << 4) | bytes.length);
    for (const b of bytes) this.RC(b);
  }

  // -------------------------------------------------------------------------
  // 문자열
  // -------------------------------------------------------------------------

  /** 코드 페이지 문자열(T): BS 길이(끝 0 포함) + 바이트 */
  T(s: string): void {
    if (!s) {
      this.BS(0);
      return;
    }
    const b = this.enc.encode(s);
    this.BS(b.length + 1);
    this.rawBytes(b);
    this.RC(0);
  }

  /** 유니코드 문자열(TU): BS 글자 수 + UTF-16LE(끝 0 없음) */
  TU(s: string): void {
    this.BS(s.length);
    for (let i = 0; i < s.length; i++) this.RS(s.charCodeAt(i));
  }

  /** 버전에 따른 문자열(TV). R2007+는 문자열 흐름에 쓴다 */
  TV(s: string): void {
    if (this.ver >= R2007) this.strWriter.TU(s);
    else this.T(s);
  }

  // -------------------------------------------------------------------------
  // 점·벡터
  // -------------------------------------------------------------------------

  RD2(p: Vec2): void {
    this.RD(p.x);
    this.RD(p.y);
  }

  RD3(p: Vec3): void {
    this.RD(p.x);
    this.RD(p.y);
    this.RD(p.z);
  }

  BD2(p: Vec2): void {
    this.BD(p.x);
    this.BD(p.y);
  }

  BD3(p: Vec3): void {
    this.BD(p.x);
    this.BD(p.y);
    this.BD(p.z);
  }

  DD2(p: Vec2, def: Vec2): void {
    this.DD(p.x, def.x);
    this.DD(p.y, def.y);
  }

  DD3(p: Vec3, def: Vec3): void {
    this.DD(p.x, def.x);
    this.DD(p.y, def.y);
    this.DD(p.z, def.z);
  }

  /** BitExtrusion */
  BE(v: Vec3 | undefined): void {
    const z = !v || (v.x === 0 && v.y === 0 && v.z === 1);
    if (this.ver >= R2000) {
      this.B(z);
      if (!z) this.BD3(v!);
      return;
    }
    this.BD3(v ?? { x: 0, y: 0, z: 1 });
  }

  /** BitThickness */
  BT(t: number | undefined): void {
    const v = t ?? 0;
    if (this.ver >= R2000) {
      this.B(v === 0);
      if (v !== 0) this.BD(v);
      return;
    }
    this.BD(v);
  }

  // -------------------------------------------------------------------------
  // 색
  // -------------------------------------------------------------------------

  /** CMC(표 레코드 색). R2004+: BS 0 + BL 방식·RGB + RC 이름 플래그 */
  CMC(c: WColor): void {
    if (this.ver < R2004) {
      this.BS(c.index);
      return;
    }
    this.BS(0);
    this.BL(rawColor(c) | 0);
    let flags = 0;
    if (c.name) flags |= 1;
    if (c.book) flags |= 2;
    this.RC(flags);
    if (c.name) this.TV(c.name);
    if (c.book) this.TV(c.book);
  }

  /** ENC(도형 색) */
  ENC(c: WColor): void {
    if (this.ver < R2004) {
      this.BS(c.index);
      return;
    }
    let flags = 0;
    const hasRgb = c.rgb !== undefined;
    if (c.dbColor) flags |= 0xc000;
    else if (hasRgb) flags |= 0x8000;
    const t = c.transparency;
    const hasT = t !== undefined && t !== -1;
    if (hasT) flags |= 0x2000;
    this.BS(flags | (c.index & 0x0fff));
    if (!c.dbColor && hasRgb) this.BL((0xc2000000 | (c.rgb! & 0xffffff)) | 0);
    if (hasT) {
      const raw = t === -2 ? 0x01000000 : (0x02000000 | (t! & 0xff)) >>> 0;
      this.BL(raw | 0);
    }
  }
}

/** CMC RGB 칸 값(상위 바이트 = 방식) */
export function rawColor(c: WColor): number {
  if (c.rgb !== undefined) return (0xc2000000 | (c.rgb & 0xffffff)) >>> 0;
  if (c.index === 256) return 0xc0000000;
  if (c.index === 0) return 0xc1000000;
  if (c.index === 257) return 0xc8000000;
  return (0xc3000000 | (c.index & 0xff)) >>> 0;
}
