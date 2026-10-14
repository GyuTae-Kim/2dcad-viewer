/**
 * 객체 하나를 읽는 공통 틀(사양 20.1·20.2·20.4.1·20.4.2, 28장 EED).
 * 자료·문자열·핸들 흐름 세 리더를 객체마다 다시 맞춘다(새 객체를 만들지 않는다).
 */
import type { CadClass, XDataItem } from '../../../core/model';
import { BitReader, DwgFormatError, type DwgColor, codesToString } from '../bitstream';
import { crc8 } from '../crc';
import { attachStringStream } from '../streams';
import { R14, R2000, R2004, R2007, R2010, R2013 } from '../version';
import { FIXED_TYPES, isFixedEntityType } from './types';

export interface RawEed {
  app: number;
  items: XDataItem[];
}

/** 모든 객체 공통 머리 */
export interface ObjHeader {
  handle: number;
  /** 원래 종류 번호 */
  typeNum: number;
  /** 고정 이름 또는 클래스 DXF 이름 */
  typeName: string;
  isEntity: boolean;
  cls?: CadClass;
  /** 객체 시작(MS 뒤) 비트 */
  startBit: number;
  /** 핸들 흐름 시작 비트 */
  handleBit: number;
  /** 객체 끝 비트(CRC 앞) */
  endBit: number;
  eed: RawEed[] | null;
  numReactors: number;
  xdictMissing: boolean;
  owner: number;
  reactors: number[];
  xdict: number;
  crcOk: boolean;
  /** 공통 자료 뒤(형식별 자료 시작) 비트 */
  bodyBit: number;
  /** 공통 핸들 뒤 비트 */
  bodyHandleBit: number;
  /** R2013+ 자료 저장소 표지 */
  dataStore: boolean;
}

/** 도형 공통 자료 */
export interface EntCommon {
  graphics: Uint8Array | null;
  entmode: number;
  isByLayerLt: boolean;
  nolinks: boolean;
  color: DwgColor;
  ltscale: number;
  ltypeFlags: number;
  plotFlags: number;
  materialFlags: number;
  shadowFlags: number;
  fullVs: boolean;
  faceVs: boolean;
  edgeVs: boolean;
  invisible: number;
  lineweight: number;
  // 핸들
  layer: number;
  ltype: number;
  prev: number;
  next: number;
  colorHandle: number;
  plotStyle: number;
  material: number;
}

export class ObjectReader {
  readonly buf: Uint8Array;
  readonly ver: number;
  readonly dat: BitReader;
  readonly str: BitReader;
  readonly hdl: BitReader;
  readonly classByNum: Map<number, CadClass>;
  /** 객체 하나를 읽을 때 R2007 이전 문자열은 dat에서 읽는다 */
  h!: ObjHeader;
  /** 마지막으로 읽은 도형의 프록시 그림(원본 본문 보관용) */
  lastGraphics: Uint8Array | null = null;

  constructor(buf: Uint8Array, ver: number, decoder: TextDecoder, classes: CadClass[]) {
    this.buf = buf;
    this.ver = ver;
    this.dat = new BitReader(buf, ver, decoder);
    this.str = new BitReader(buf, ver, decoder);
    this.hdl = new BitReader(buf, ver, decoder);
    this.classByNum = new Map();
    classes.forEach((c, i) => this.classByNum.set(c.number ?? 500 + i, c));
  }

  /** 종류만 빠르게 본다 */
  peekType(offset: number): { typeNum: number; typeName: string; isEntity: boolean; cls?: CadClass } | null {
    const r = this.dat;
    if (offset < 0 || offset >= this.buf.length) return null;
    r.end = this.buf.length * 8;
    r.pos = offset * 8;
    r.MS();
    if (this.ver >= R2010) r.UMC();
    const t = r.OT();
    return this.typeInfo(t);
  }

  typeInfo(t: number): { typeNum: number; typeName: string; isEntity: boolean; cls?: CadClass } {
    const fixed = FIXED_TYPES[t];
    if (t < 500 || !this.classByNum.has(t)) {
      return { typeNum: t, typeName: fixed ?? `TYPE${t}`, isEntity: isFixedEntityType(t) };
    }
    const cls = this.classByNum.get(t)!;
    return { typeNum: t, typeName: cls.dxfName, isEntity: cls.isEntity, cls };
  }

  /** 객체 머리를 읽고 흐름을 맞춘다. 공통 자료(반응자 등) 직전까지 읽는다. */
  begin(offset: number, expectHandle: number): ObjHeader {
    const ver = this.ver;
    const r = this.dat;
    r.end = this.buf.length * 8;
    r.pos = offset * 8;
    const size = r.MS();
    let hsize = 0;
    // R2010+: 크기(MS)는 핸들 흐름 크기(MC) 뒤부터 센다
    if (ver >= R2010) hsize = r.UMC();
    const startBit = r.pos;
    const endBit = startBit + size * 8;
    if (size <= 0 || endBit > this.buf.length * 8) throw new DwgFormatError('객체 크기가 잘못되었습니다');
    let handleBit: number;
    const typeNum = r.OT();
    if (ver >= R2010) {
      handleBit = endBit - hsize;
    } else if (ver >= R2000) {
      handleBit = startBit + r.RLu();
    } else {
      handleBit = -1; // R13·R14는 뒤에서 읽는다
    }
    // CRC: MS 바이트부터 객체 끝까지
    const crcPos = endBit >>> 3;
    const crcOk = crcPos + 2 <= this.buf.length && crc8(0xc0c1, this.buf, offset, crcPos) === (this.buf[crcPos] | (this.buf[crcPos + 1] << 8));
    const info = this.typeInfo(typeNum);
    const handle = r.H();
    if (handle !== expectHandle && expectHandle >= 0) {
      // 지도와 다르면 지도 값을 믿는다
    }
    const eed = this.readEed();
    const h: ObjHeader = {
      handle: expectHandle >= 0 ? expectHandle : handle,
      typeNum,
      typeName: info.typeName,
      isEntity: info.isEntity,
      cls: info.cls,
      startBit,
      handleBit,
      endBit,
      eed,
      numReactors: 0,
      xdictMissing: false,
      owner: 0,
      reactors: [],
      xdict: 0,
      crcOk,
      bodyBit: 0,
      bodyHandleBit: 0,
      dataStore: false,
    };
    this.h = h;
    return h;
  }

  /** 핸들·문자열 흐름 위치 확정 */
  private setupStreams(): void {
    const h = this.h;
    const r = this.dat;
    r.end = h.handleBit;
    this.hdl.pos = h.handleBit;
    this.hdl.end = h.endBit;
    if (this.ver >= R2007) {
      attachStringStream(r, this.str, h.startBit, h.handleBit);
      // 자료 흐름은 문자열 흐름 앞에서 끝난다
      if (this.str.pos < h.handleBit) r.end = this.str.pos;
    } else {
      r.strReader = r;
    }
  }

  /** 도형이 아닌 객체의 공통 자료 */
  commonObject(): void {
    const r = this.dat;
    const h = this.h;
    if (this.ver <= R14) h.handleBit = h.startBit + r.RLu();
    this.setupStreams();
    h.numReactors = r.BL();
    if (this.ver >= R2004) h.xdictMissing = r.B() === 1;
    if (this.ver >= R2013) h.dataStore = r.B() === 1;
    h.bodyBit = r.pos;
    this.objectHandles();
    h.bodyHandleBit = this.hdl.pos;
  }

  private objectHandles(): void {
    const h = this.h;
    const hr = this.hdl;
    h.owner = hr.H(h.handle);
    const n = h.numReactors;
    if (n < 0 || n > 100000) throw new DwgFormatError('반응자 수가 잘못되었습니다');
    for (let i = 0; i < n; i++) h.reactors.push(hr.H(h.handle));
    if (!h.xdictMissing) h.xdict = hr.H(h.handle);
  }

  /** 도형 공통 자료와 공통 핸들 */
  commonEntity(): EntCommon {
    const ver = this.ver;
    const r = this.dat;
    const h = this.h;
    let graphics: Uint8Array | null = null;
    if (r.B()) {
      const gsize = ver >= R2010 ? r.BLL() : r.RLu();
      if (gsize > 0 && gsize < (h.endBit - r.pos) / 8 + 1) {
        if ((r.pos & 7) === 0) {
          const s = r.pos >>> 3;
          graphics = this.buf.slice(s, s + gsize);
          r.pos += gsize * 8;
        } else {
          graphics = new Uint8Array(gsize);
          for (let i = 0; i < gsize; i++) graphics[i] = r.RC();
        }
      } else if (gsize !== 0) {
        throw new DwgFormatError('그림 자료 크기가 잘못되었습니다');
      }
    }
    if (ver <= R14) h.handleBit = h.startBit + r.RLu();
    this.setupStreams();
    this.lastGraphics = graphics;
    const c: EntCommon = {
      graphics,
      entmode: r.BB(),
      isByLayerLt: false,
      nolinks: true,
      color: { index: 256 },
      ltscale: 1,
      ltypeFlags: 0,
      plotFlags: 0,
      materialFlags: 0,
      shadowFlags: 0,
      fullVs: false,
      faceVs: false,
      edgeVs: false,
      invisible: 0,
      lineweight: 29,
      layer: 0,
      ltype: 0,
      prev: 0,
      next: 0,
      colorHandle: 0,
      plotStyle: 0,
      material: 0,
    };
    h.numReactors = r.BL();
    if (ver >= R2004) h.xdictMissing = r.B() === 1;
    if (ver >= R2013) h.dataStore = r.B() === 1;
    if (ver <= R14) c.isByLayerLt = r.B() === 1;
    if (ver < R2004) c.nolinks = r.B() === 1;
    c.color = r.ENC();
    c.ltscale = r.BD();
    if (ver >= R2000) {
      c.ltypeFlags = r.BB();
      // R2007+: 선종류 다음 BB는 재질, 그다음이 플롯 스타일이다(사양 표와 다름, AutoCAD 표본의 핸들 종류로 확인)
      if (ver >= R2007) c.materialFlags = r.BB();
      c.plotFlags = r.BB();
    }
    if (ver >= R2007) c.shadowFlags = r.RC();
    if (ver >= R2010) {
      c.fullVs = r.B() === 1;
      c.faceVs = r.B() === 1;
      c.edgeVs = r.B() === 1;
    }
    c.invisible = r.BS();
    if (ver >= R2000) c.lineweight = r.RC();
    h.bodyBit = r.pos;

    // 핸들 흐름
    const hr = this.hdl;
    const base = h.handle;
    if (c.entmode === 0) h.owner = hr.H(base);
    const n = h.numReactors;
    if (n < 0 || n > 100000) throw new DwgFormatError('반응자 수가 잘못되었습니다');
    for (let i = 0; i < n; i++) h.reactors.push(hr.H(base));
    if (!h.xdictMissing) h.xdict = hr.H(base);
    if (ver <= R14) {
      c.layer = hr.H(base);
      if (!c.isByLayerLt) c.ltype = hr.H(base);
    }
    if (ver < R2004) {
      if (!c.nolinks) {
        c.prev = hr.H(base);
        c.next = hr.H(base);
      } else {
        c.prev = base - 1;
        c.next = base + 1;
      }
    }
    if (ver >= R2004 && c.color.hasColorHandle) c.colorHandle = hr.H(base);
    if (ver >= R2000) {
      c.layer = hr.H(base);
      if (c.ltypeFlags === 3) c.ltype = hr.H(base);
    }
    if (ver >= R2007 && c.materialFlags === 3) c.material = hr.H(base);
    if (ver >= R2000 && c.plotFlags === 3) c.plotStyle = hr.H(base);
    if (ver >= R2010) {
      if (c.fullVs) hr.H(base);
      if (c.faceVs) hr.H(base);
      if (c.edgeVs) hr.H(base);
    }
    h.bodyHandleBit = hr.pos;
    return c;
  }

  /**
   * 다른 객체 안에 끼워 넣은 도형(R2018 여러 줄 속성의 MTEXT)의 공통 자료.
   * 객체 머리 없이 entmode부터 시작하고, 핸들은 같은 핸들 흐름의 현재 위치에서 읽는다.
   */
  embeddedEntityCommon(): EntCommon {
    const ver = this.ver;
    const r = this.dat;
    const c: EntCommon = {
      graphics: null,
      entmode: r.BB(),
      isByLayerLt: false,
      nolinks: true,
      color: { index: 256 },
      ltscale: 1,
      ltypeFlags: 0,
      plotFlags: 0,
      materialFlags: 0,
      shadowFlags: 0,
      fullVs: false,
      faceVs: false,
      edgeVs: false,
      invisible: 0,
      lineweight: 29,
      layer: 0,
      ltype: 0,
      prev: 0,
      next: 0,
      colorHandle: 0,
      plotStyle: 0,
      material: 0,
    };
    const nr = r.BL();
    const xdm = ver >= R2004 ? r.B() === 1 : false;
    if (ver >= R2013) r.B();
    c.color = r.ENC();
    c.ltscale = r.BD();
    c.ltypeFlags = r.BB();
    if (ver >= R2007) c.materialFlags = r.BB();
    c.plotFlags = r.BB();
    if (ver >= R2007) c.shadowFlags = r.RC();
    if (ver >= R2010) {
      c.fullVs = r.B() === 1;
      c.faceVs = r.B() === 1;
      c.edgeVs = r.B() === 1;
    }
    c.invisible = r.BS();
    c.lineweight = r.RC();
    const hr = this.hdl;
    const base = this.h.handle;
    if (c.entmode === 0) hr.H(base);
    if (nr < 0 || nr > 100000) throw new DwgFormatError('반응자 수가 잘못되었습니다');
    for (let i = 0; i < nr; i++) hr.H(base);
    if (!xdm) hr.H(base);
    if (c.color.hasColorHandle) c.colorHandle = hr.H(base);
    c.layer = hr.H(base);
    if (c.ltypeFlags === 3) c.ltype = hr.H(base);
    if (ver >= R2007 && c.materialFlags === 3) c.material = hr.H(base);
    if (c.plotFlags === 3) c.plotStyle = hr.H(base);
    if (ver >= R2010) {
      if (c.fullVs) hr.H(base);
      if (c.faceVs) hr.H(base);
      if (c.edgeVs) hr.H(base);
    }
    return c;
  }

  /** 확장 자료(EED) */
  private readEed(): RawEed[] | null {
    const r = this.dat;
    let out: RawEed[] | null = null;
    for (let guard = 0; guard < 4096; guard++) {
      const size = r.BS();
      if (size === 0) break;
      if (size < 0 || r.pos + size * 8 > r.end) throw new DwgFormatError('확장 자료 크기가 잘못되었습니다');
      const app = r.H();
      const endPos = r.pos + size * 8;
      const items = this.readEedItems(size);
      r.pos = endPos;
      (out ??= []).push({ app, items });
    }
    return out;
  }

  private readEedItems(size: number): XDataItem[] {
    const r = this.dat;
    const end = r.pos + size * 8;
    const items: XDataItem[] = [];
    try {
      while (r.pos < end) {
        const code = r.RC();
        switch (code) {
          case 0: {
            if (this.ver >= R2007) {
              const len = r.RSu();
              const codes: number[] = new Array(len);
              for (let i = 0; i < len; i++) codes[i] = r.RSu();
              items.push({ code: 1000, value: codesToString(codes, len) });
            } else {
              const len = r.RC();
              r.RSu(); // 코드 페이지
              items.push({ code: 1000, value: r.bytesToString(len) });
            }
            break;
          }
          case 2:
            items.push({ code: 1002, value: r.RC() === 0 ? '{' : '}' });
            break;
          case 3:
          case 5: {
            let v = '';
            for (let i = 0; i < 8; i++) v += r.RC().toString(16).padStart(2, '0');
            // 8바이트를 높은 자리부터 쓴 16진(앞자리 0 제거)
            items.push({ code: 1000 + code, value: v.replace(/^0+(?=.)/, '').toUpperCase() });
            break;
          }
          case 4: {
            const len = r.RC();
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = r.RC();
            items.push({ code: 1004, value: bytes });
            break;
          }
          case 10:
          case 11:
          case 12:
          case 13:
          case 14:
          case 15:
            items.push({ code: 1000 + code, value: r.RD3() });
            break;
          case 40:
          case 41:
          case 42:
            items.push({ code: 1000 + code, value: r.RD() });
            break;
          case 70:
            items.push({ code: 1070, value: r.RS() });
            break;
          case 71:
            items.push({ code: 1071, value: r.RL() });
            break;
          default:
            // 모르는 코드: 나머지를 건너뛴다
            r.pos = end;
            break;
        }
      }
    } catch {
      r.pos = end;
    }
    return items;
  }

  /** 객체 자료가 핸들 흐름을 침범했는지 */
  dataOverflow(): boolean {
    return this.dat.pos > this.dat.end + 0;
  }
}

