/**
 * 객체 하나를 쓰는 틀(사양 20.1·20.2·20.4.1·20.4.2, 28장 EED, objects/reader.ts의 짝).
 * 자료·문자열·핸들 흐름을 따로 쓰고 finish()에서 크기·CRC와 함께 붙인다.
 */
import type { Vec3, XDataItem } from '../../../core/model';
import { crc8 } from '../crc';
import { R2000, R2004, R2007, R2010, R2013 } from '../version';
import { BitWriter, type WColor } from './bitwriter';
import type { TextEncoderCp } from './codepage';

/** 핸들 참조 종류(사양 2.13) */
export const SOFT_OWNER = 2;
export const HARD_OWNER = 3;
export const SOFT_PTR = 4;
export const HARD_PTR = 5;

export interface EedOut {
  app: number;
  items: XDataItem[];
}

/** 객체 공통 자료 */
export interface ObjCommon {
  owner: number;
  reactors: number[];
  xdict: number;
  /** R2013+ 자료 저장소 표지 */
  dataStore?: boolean;
}

/** 도형 공통 자료 */
export interface EntCommonOut extends ObjCommon {
  graphics?: Uint8Array;
  /** 0 블록 안(소유자 핸들 있음), 1 종이 공간, 2 모형 공간 */
  entmode: number;
  color: WColor;
  ltscale: number;
  /** 0 ByLayer, 1 ByBlock, 2 Continuous, 3 핸들 */
  ltypeFlags: number;
  ltype: number;
  /** 0 ByLayer, 1 ByBlock, 3 핸들 */
  plotFlags: number;
  plotStyle: number;
  invisible: boolean;
  /** 선가중치 번호(0~23, 29 ByLayer, 30 ByBlock, 31 기본값) */
  lineweight: number;
  layer: number;
  /** R2000: 앞·뒤 도형(0 = 없음) */
  prev: number;
  next: number;
  /** R2007+ 재질 핸들(0 = ByLayer) */
  material?: number;
}

export class ObjWriter {
  readonly ver: number;
  readonly enc: TextEncoderCp;
  /** EED 문자열에 쓰는 코드 페이지 번호 */
  readonly codepage: number;
  readonly dat: BitWriter;
  readonly str: BitWriter;
  readonly hdl: BitWriter;
  private readonly out: BitWriter;
  private readonly eedBuf: BitWriter;
  handle = 0;
  private rlPos = -1;

  constructor(ver: number, enc: TextEncoderCp, codepage: number) {
    this.ver = ver;
    this.enc = enc;
    this.codepage = codepage;
    this.dat = new BitWriter(ver, enc, 4096);
    this.str = new BitWriter(ver, enc, 1024);
    this.hdl = new BitWriter(ver, enc, 1024);
    this.out = new BitWriter(ver, enc, 4096);
    this.eedBuf = new BitWriter(ver, enc, 256);
    if (ver >= R2007) this.dat.strWriter = this.str;
  }

  /** 객체 시작: 종류 번호, 핸들, EED까지 쓴다 */
  begin(type: number, handle: number, eed: EedOut[] | null): void {
    const d = this.dat;
    d.reset();
    this.str.reset();
    this.hdl.reset();
    this.handle = handle;
    d.OT(type);
    this.rlPos = -1;
    if (this.ver >= R2000 && this.ver < R2010) {
      this.rlPos = d.pos;
      d.RL(0);
    }
    d.H(0, handle);
    this.writeEed(eed);
  }

  private writeEed(list: EedOut[] | null): void {
    const d = this.dat;
    if (list) {
      for (const x of list) {
        const b = this.eedBuf;
        b.reset();
        this.eedItems(b, x.items);
        const size = b.pos >>> 3;
        if (size <= 0 || size > 0x7fff) continue;
        d.BS(size);
        d.H(HARD_PTR, x.app);
        d.appendBits(b, b.pos);
      }
    }
    d.BS(0);
  }

  private eedItems(b: BitWriter, items: XDataItem[]): void {
    const ver = this.ver;
    for (const it of items) {
      const v = it.value;
      const code = it.code - 1000;
      switch (code) {
        case 0: {
          const s = typeof v === 'string' ? v : String(v);
          b.RC(0);
          if (ver >= R2007) {
            const n = Math.min(s.length, 0x7fff);
            b.RS(n);
            for (let i = 0; i < n; i++) b.RS(s.charCodeAt(i));
          } else {
            let bytes = this.enc.encode(s);
            if (bytes.length > 255) bytes = bytes.subarray(0, 255);
            b.RC(bytes.length);
            // 코드 페이지는 높은 바이트가 앞이다(AutoCAD 표본)
            b.RC(this.codepage >> 8);
            b.RC(this.codepage & 0xff);
            b.rawBytes(bytes);
          }
          break;
        }
        case 2:
          b.RC(2);
          b.RC(v === '}' ? 1 : 0);
          break;
        case 3:
        case 5: {
          b.RC(code);
          const h = typeof v === 'string' ? BigInt('0x' + (v.replace(/[^0-9a-fA-F]/g, '') || '0')) : BigInt(Math.max(0, Math.floor(Number(v) || 0)));
          for (let i = 7; i >= 0; i--) b.RC(Number((h >> BigInt(i * 8)) & 0xffn));
          break;
        }
        case 4: {
          let bytes = v instanceof Uint8Array ? v : hexBytes(String(v));
          if (bytes.length > 255) bytes = bytes.subarray(0, 255);
          b.RC(4);
          b.RC(bytes.length);
          b.rawBytes(bytes);
          break;
        }
        case 10:
        case 11:
        case 12:
        case 13:
        case 14:
        case 15: {
          b.RC(code);
          const p: Vec3 = typeof v === 'object' && !(v instanceof Uint8Array) ? (v as Vec3) : { x: Number(v) || 0, y: 0, z: 0 };
          b.RD(p.x);
          b.RD(p.y);
          b.RD(p.z ?? 0);
          break;
        }
        case 40:
        case 41:
        case 42:
          b.RC(code);
          b.RD(Number(v) || 0);
          break;
        case 70:
          b.RC(70);
          b.RS(Number(v) & 0xffff);
          break;
        case 71:
          b.RC(71);
          b.RL(Number(v) | 0);
          break;
        default:
          // DWG EED에 없는 코드(1001 등)는 쓰지 않는다
          break;
      }
    }
  }

  /** 도형이 아닌 객체의 공통 자료와 핸들 */
  commonObject(c: ObjCommon): void {
    const d = this.dat;
    const ver = this.ver;
    d.BL(c.reactors.length);
    if (ver >= R2004) d.B(c.xdict === 0);
    if (ver >= R2013) d.B(!!c.dataStore);
    const h = this.hdl;
    h.H(SOFT_PTR, c.owner);
    for (const r of c.reactors) h.H(SOFT_PTR, r);
    if (c.xdict || ver < R2004) h.H(HARD_OWNER, c.xdict);
  }

  /** 도형 공통 자료와 핸들 */
  commonEntity(c: EntCommonOut): void {
    const d = this.dat;
    const ver = this.ver;
    if (c.graphics && c.graphics.length) {
      d.B(1);
      if (ver >= R2010) d.BLL(c.graphics.length);
      else d.RL(c.graphics.length);
      d.rawBytes(c.graphics);
    } else d.B(0);
    d.BB(c.entmode);
    d.BL(c.reactors.length);
    if (ver >= R2004) d.B(c.xdict === 0);
    if (ver >= R2013) d.B(!!c.dataStore);
    const nolinks = ver >= R2004 || (c.prev === this.handle - 1 && c.next === this.handle + 1);
    if (ver < R2004) d.B(nolinks);
    d.ENC(c.color);
    d.BD(c.ltscale);
    d.BB(c.ltypeFlags);
    // R2007+: 재질 BB가 플롯 스타일 BB보다 앞이다(objects/reader.ts 참고)
    if (ver >= R2007) d.BB(c.material ? 3 : 0);
    d.BB(c.plotFlags);
    if (ver >= R2007) d.RC(0); // 그림자
    if (ver >= R2010) {
      d.B(0);
      d.B(0);
      d.B(0);
    }
    d.BS(c.invisible ? 1 : 0);
    d.RC(c.lineweight);

    const h = this.hdl;
    if (c.entmode === 0) h.H(SOFT_PTR, c.owner);
    for (const r of c.reactors) h.H(SOFT_PTR, r);
    if (c.xdict || ver < R2004) h.H(HARD_OWNER, c.xdict);
    if (ver < R2004 && !nolinks) {
      h.H(SOFT_PTR, c.prev);
      h.H(SOFT_PTR, c.next);
    }
    if (ver >= R2004 && c.color.dbColor) h.H(HARD_PTR, c.color.dbColor);
    h.H(HARD_PTR, c.layer);
    if (c.ltypeFlags === 3) h.H(HARD_PTR, c.ltype);
    if (ver >= R2007 && c.material) h.H(HARD_PTR, c.material);
    if (c.plotFlags === 3) h.H(HARD_PTR, c.plotStyle);
  }

  /** 원본 비트(같은 버전 원본 본문)를 자료·문자열·핸들 흐름에 붙인다 */
  appendRaw(data: Uint8Array, dataBits: number, strings: Uint8Array | undefined, stringBits: number, handles: Uint8Array, handleBits: number): void {
    if (dataBits) this.dat.appendRaw(data, dataBits);
    if (strings && stringBits) this.str.appendRaw(strings, stringBits);
    if (handleBits) this.hdl.appendRaw(handles, handleBits);
  }

  /** 크기·문자열 흐름 표지·핸들 흐름·CRC를 붙여 객체 바이트를 돌려준다 */
  finish(): Uint8Array {
    const ver = this.ver;
    const d = this.dat;
    if (ver >= R2007) {
      const sb = this.str.pos;
      if (sb > 0) {
        d.appendBits(this.str, sb);
        if (sb < 0x8000) d.RS(sb);
        else {
          d.RS(sb >>> 15);
          d.RS((sb & 0x7fff) | 0x8000);
        }
        d.B(1);
      } else d.B(0);
    }
    const dataBits = d.pos;
    if (this.rlPos >= 0) d.patchRL(this.rlPos, dataBits);
    d.appendBits(this.hdl, this.hdl.pos);
    const bodyBytes = (d.pos + 7) >>> 3;
    // 남은 비트를 0으로
    const rest = d.pos & 7;
    if (rest) d.bits(8 - rest, 0);
    const o = this.out;
    o.reset();
    o.MS(bodyBytes);
    if (ver >= R2010) o.UMC(bodyBytes * 8 - dataBits);
    o.rawBytes(d.buf.subarray(0, bodyBytes));
    const bytes = o.bytes();
    const crc = crc8(0xc0c1, bytes, 0, bytes.length);
    const res = new Uint8Array(bytes.length + 2);
    res.set(bytes);
    res[bytes.length] = crc & 0xff;
    res[bytes.length + 1] = crc >>> 8;
    return res;
  }
}

function hexBytes(s: string): Uint8Array {
  const t = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(t.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
  return out;
}
