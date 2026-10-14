/**
 * 파일 구조 쓰기: 객체 지도(사양 23장), R2000 파일(3장), R2004+ 섹션·페이지(4장).
 */
import { crc32, crc8, pageChecksum } from '../crc';
import { R2018 } from '../version';
import { compressR18 } from './lz77enc';

/** 바이트 묶음 쓰기 */
export class ByteOut {
  buf: Uint8Array;
  n = 0;
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
  }
  private ensure(k: number): void {
    if (this.n + k <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.n + k) s *= 2;
    const b = new Uint8Array(s);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.n++] = v & 0xff;
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number): void {
    this.ensure(4);
    const x = v >>> 0;
    this.buf[this.n++] = x & 0xff;
    this.buf[this.n++] = (x >>> 8) & 0xff;
    this.buf[this.n++] = (x >>> 16) & 0xff;
    this.buf[this.n++] = (x >>> 24) & 0xff;
  }
  u64(v: number): void {
    this.u32(v % 0x100000000);
    this.u32(Math.floor(v / 0x100000000));
  }
  bytes(b: ArrayLike<number>): void {
    this.ensure(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  zeros(k: number): void {
    this.ensure(k);
    this.buf.fill(0, this.n, this.n + k);
    this.n += k;
  }
  align(a: number): void {
    const r = this.n % a;
    if (r) this.zeros(a - r);
  }
  patch32(at: number, v: number): void {
    const x = v >>> 0;
    this.buf[at] = x & 0xff;
    this.buf[at + 1] = (x >>> 8) & 0xff;
    this.buf[at + 2] = (x >>> 16) & 0xff;
    this.buf[at + 3] = (x >>> 24) & 0xff;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

function mcU(out: number[], v: number): void {
  let x = v;
  for (;;) {
    if (x < 0x80) {
      out.push(x);
      return;
    }
    out.push((x & 0x7f) | 0x80);
    x = Math.floor(x / 128);
  }
}

function mcS(out: number[], v: number): void {
  const neg = v < 0;
  let x = Math.abs(v);
  for (;;) {
    if (x < 0x40) {
      out.push(x | (neg ? 0x40 : 0));
      return;
    }
    out.push((x & 0x7f) | 0x80);
    x = Math.floor(x / 128);
  }
}

/** 객체 지도: (핸들, 위치)를 핸들 순으로. 구역은 2032바이트 이하, 구역마다 기준 0 */
export function objectMap(entries: [number, number][]): Uint8Array {
  const out = new ByteOut(entries.length * 6 + 64);
  let i = 0;
  while (i < entries.length) {
    const start = out.n;
    out.u16(0);
    let lastH = 0;
    let lastL = 0;
    while (i < entries.length) {
      const [h, loc] = entries[i];
      const pair: number[] = [];
      mcU(pair, h - lastH);
      mcS(pair, loc - lastL);
      if (out.n - start + pair.length > 2030) break;
      out.bytes(pair);
      lastH = h;
      lastL = loc;
      i++;
    }
    const size = out.n - start;
    out.buf[start] = size >>> 8;
    out.buf[start + 1] = size & 0xff;
    const crc = crc8(0xc0c1, out.buf, start, out.n);
    out.u8(crc >>> 8);
    out.u8(crc & 0xff);
  }
  // 빈 마지막 구역
  const s = out.n;
  out.u8(0);
  out.u8(2);
  const crc = crc8(0xc0c1, out.buf, s, out.n);
  out.u8(crc >>> 8);
  out.u8(crc & 0xff);
  return out.result();
}

/** AutoCAD 버전 번호(보조 헤더) */
function auxVersion(ver: number): number {
  switch (ver) {
    case 1015:
      return 23;
    case 1018:
      return 25;
    case 1021:
      return 27;
    case 1024:
      return 29;
    case 1027:
      return 31;
    default:
      return 33;
  }
}

/** 율리우스일 → (일, 밀리초) */
function td(out: ByteOut, jd: number): void {
  const day = Math.floor(jd);
  out.u32(day);
  out.u32(Math.min(86399999, Math.round((jd - day) * 86400000)));
}

/** AcDb:AuxHeader(사양 27장) */
export function auxHeader(ver: number, maint: number, tdcreate: number, tdupdate: number, handseed: number): Uint8Array {
  const o = new ByteOut(160);
  const v = auxVersion(ver);
  o.bytes([0xff, 0x77, 0x01]);
  o.u16(v);
  o.u16(maint);
  o.u32(1);
  o.u32(0xffffffff);
  o.u16(1);
  o.u16(0);
  o.u32(0);
  o.u16(v);
  o.u16(maint);
  o.u16(v);
  o.u16(maint);
  for (const x of [5, 0x893, 5, 0x893, 0, 1]) o.u16(x);
  for (let i = 0; i < 5; i++) o.u32(0);
  td(o, tdcreate);
  td(o, tdupdate);
  o.u32(handseed < 0x7fffffff ? handseed : 0xffffffff);
  o.u32(0);
  o.u16(0);
  o.u16(1);
  o.u32(0);
  o.u32(0);
  o.u32(0);
  o.u32(1);
  for (let i = 0; i < 4; i++) o.u32(0);
  if (ver >= R2018) {
    o.u16(0);
    o.u16(0);
    o.u16(0);
  }
  return o.result();
}

const IMAGE_SENTINEL = [0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b];
const IMAGE_END_SENTINEL = [0xe0, 0xda, 0x92, 0xf8, 0x2b, 0xc9, 0xd7, 0xd7, 0x62, 0xa8, 0x35, 0xc0, 0x62, 0xbb, 0xef, 0xd4];

/** 미리 보기 그림 없음 */
export function emptyPreview(): Uint8Array {
  const o = new ByteOut(64);
  o.bytes(IMAGE_SENTINEL);
  o.u32(1);
  o.u8(0);
  o.bytes(IMAGE_END_SENTINEL);
  return o.result();
}

/** MEASUREMENT(AcDb:Template, R2000 다섯째 위치 자료) */
export function templateData(measurement: number): Uint8Array {
  return new Uint8Array([0, 0, measurement & 0xff, 0]);
}

// ---------------------------------------------------------------------------
// R2000
// ---------------------------------------------------------------------------

const FILE_HEADER_SENTINEL = [0x95, 0xa0, 0x4e, 0x28, 0x99, 0x82, 0x1a, 0xe5, 0x5e, 0x41, 0xe0, 0x5f, 0x9d, 0x3a, 0x4d, 0x00];

export interface R2000Parts {
  ver: number;
  maint: number;
  codepage: number;
  header: Uint8Array;
  classes: Uint8Array;
  /** 핸들과 객체 바이트(핸들 순) */
  objects: [number, Uint8Array][];
  aux: Uint8Array;
  measurement: number;
}

export function writeR2000(p: R2000Parts): Uint8Array {
  const o = new ByteOut(1 << 20);
  o.bytes([0x41, 0x43, 0x31, 0x30, 0x31, 0x35]);
  o.zeros(5);
  o.u8(p.maint);
  o.u8(1);
  const imageSeekerAt = o.n;
  o.u32(0);
  o.u8(0x21);
  o.u8(0);
  o.u16(p.codepage);
  const nloc = 6;
  o.u32(nloc);
  const locAt = o.n;
  o.zeros(nloc * 9);
  const crcAt = o.n;
  o.zeros(2);
  o.bytes(FILE_HEADER_SENTINEL);
  const loc: [number, number][] = [];
  // 5: 보조 헤더
  const auxAt = o.n;
  o.bytes(p.aux);
  loc[5] = [auxAt, p.aux.length];
  // 그림
  const imgAt = o.n;
  o.bytes(emptyPreview());
  o.patch32(imageSeekerAt, imgAt);
  // 0: 헤더
  loc[0] = [o.n, p.header.length];
  o.bytes(p.header);
  // 1: 클래스
  loc[1] = [o.n, p.classes.length];
  o.bytes(p.classes);
  // 객체
  o.u32(0x0dca);
  const map: [number, number][] = [];
  for (const [h, b] of p.objects) {
    map.push([h, o.n]);
    o.bytes(b);
  }
  // 2: 객체 지도
  const om = objectMap(map);
  loc[2] = [o.n, om.length];
  o.bytes(om);
  loc[3] = [0, 0];
  // 4: MEASUREMENT
  const t = templateData(p.measurement);
  loc[4] = [o.n, t.length];
  o.bytes(t);
  // 위치 표와 CRC
  for (let i = 0; i < nloc; i++) {
    const a = locAt + i * 9;
    o.buf[a] = i;
    o.patch32(a + 1, loc[i][0]);
    o.patch32(a + 5, loc[i][1]);
  }
  const crc = crc8(0, o.buf, 0, crcAt) ^ 0x8461;
  o.buf[crcAt] = crc & 0xff;
  o.buf[crcAt + 1] = crc >>> 8;
  return o.result();
}

// ---------------------------------------------------------------------------
// R2004+
// ---------------------------------------------------------------------------

export interface R2004Section {
  name: string;
  data: Uint8Array;
  compressed: boolean;
  /** 페이지 최대 크기 */
  pageSize: number;
}

function magic(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 0x343fd) + 0x269ec3) | 0;
    out[i] = (seed >> 16) & 0xff;
  }
  return out;
}

interface Page {
  num: number;
  address: number;
  size: number;
}

/**
 * R2004 형식 파일. sections는 섹션 지도 순서(빈 섹션 ""은 자동으로 앞에 둔다)이고,
 * 파일 안 순서는 streamOrder 이름 순서다.
 */
export function writeR2004(ver: number, maint: number, codepage: number, sections: R2004Section[], streamOrder: string[]): Uint8Array {
  const o = new ByteOut(1 << 20);
  o.zeros(0x100);
  const pages: Page[] = [];
  const secPages = new Map<string, { num: number; dataSize: number; start: number }[]>();
  let pageNum = 0;
  const byName = new Map(sections.map((s) => [s.name, s]));
  // 섹션 번호: "" = 0, 나머지는 지도 순서의 뒤에서부터 내려온다
  const ids = new Map<string, number>();
  ids.set('', 0);
  sections.forEach((s, i) => ids.set(s.name, sections.length - i));
  let previewAddr = 0;
  let summaryAddr = 0;
  for (const name of streamOrder) {
    const s = byName.get(name);
    if (!s) continue;
    const list: { num: number; dataSize: number; start: number }[] = [];
    secPages.set(name, list);
    const ps = s.pageSize;
    for (let start = 0; start < s.data.length; start += ps) {
      const chunk = new Uint8Array(ps);
      chunk.set(s.data.subarray(start, Math.min(s.data.length, start + ps)));
      // 0만 있는 페이지는 쓰지 않는다
      let allZero = true;
      for (let k = 0; k < chunk.length; k++) {
        if (chunk[k]) {
          allZero = false;
          break;
        }
      }
      if (allZero && s.compressed) continue;
      const payload = s.compressed ? compressR18(chunk) : chunk;
      const address = o.n;
      const num = ++pageNum;
      const total = Math.ceil((32 + payload.length) / 0x20) * 0x20;
      const dc = pageChecksum(0, payload, 0, payload.length);
      const hdr = new ByteOut(32);
      hdr.u32(0x4163043b);
      hdr.u32(ids.get(name)!);
      hdr.u32(payload.length);
      hdr.u32(total);
      hdr.u64(start);
      hdr.u32(0);
      hdr.u32(dc);
      const hb = hdr.result();
      const hc = pageChecksum(dc, hb, 0, 32);
      new DataView(hb.buffer).setUint32(0x18, hc, true);
      const mask = (0x4164536b ^ address) >>> 0;
      const dv = new DataView(hb.buffer);
      for (let k = 0; k < 8; k++) dv.setUint32(k * 4, (dv.getUint32(k * 4, true) ^ mask) >>> 0, true);
      o.bytes(hb);
      o.bytes(payload);
      o.zeros(total - 32 - payload.length);
      pages.push({ num, address, size: total });
      list.push({ num, dataSize: payload.length, start });
      if (name === 'AcDb:Preview' && !previewAddr) previewAddr = address + 0x20;
      if (name === 'AcDb:SummaryInfo' && !summaryAddr) summaryAddr = address + 0x20;
    }
  }

  // 섹션 지도
  const sm = new ByteOut(4096);
  const all = [{ name: '', data: new Uint8Array(0), compressed: true, pageSize: 0x7400 }, ...sections];
  sm.u32(all.length);
  sm.u32(2);
  sm.u32(0x7400);
  sm.u32(0);
  sm.u32(all.length);
  for (const s of all) {
    const list = secPages.get(s.name) ?? [];
    sm.u64(s.data.length);
    sm.u32(list.length);
    sm.u32(s.pageSize);
    sm.u32(1);
    sm.u32(s.compressed ? 2 : 1);
    sm.u32(ids.get(s.name)!);
    sm.u32(0);
    const nm = new Uint8Array(64);
    for (let i = 0; i < s.name.length && i < 63; i++) nm[i] = s.name.charCodeAt(i);
    sm.bytes(nm);
    for (const p of list) {
      sm.u32(p.num);
      sm.u32(p.dataSize);
      sm.u64(p.start);
    }
  }
  const systemPage = (type: number, data: Uint8Array, minSize = 0): { bytes: Uint8Array; size: number } => {
    const comp = compressR18(data);
    const h = new ByteOut(0x14);
    h.u32(type);
    h.u32(data.length);
    h.u32(comp.length);
    h.u32(2);
    h.u32(0);
    const hb = h.result();
    const c0 = pageChecksum(0, hb, 0, 0x14);
    const cs = pageChecksum(c0, comp, 0, comp.length);
    new DataView(hb.buffer).setUint32(0x10, cs, true);
    const size = Math.max(minSize, Math.ceil((0x14 + comp.length) / 0x20) * 0x20);
    const bytes = new Uint8Array(size);
    bytes.set(hb, 0);
    bytes.set(comp, 0x14);
    return { bytes, size };
  };
  const smNum = ++pageNum;
  const smAddr = o.n;
  const smPage = systemPage(0x4163003b, sm.result());
  o.bytes(smPage.bytes);
  pages.push({ num: smNum, address: smAddr, size: smPage.size });

  // 페이지 지도(자기 크기도 담으므로 크기를 넉넉히 잡고 맞춘다)
  const pmNum = ++pageNum;
  const pmAddr = o.n;
  let pmSize = Math.ceil((0x14 + (pages.length + 1) * 8 * 1.2 + 64) / 0x20) * 0x20;
  let pmPage: { bytes: Uint8Array; size: number };
  for (;;) {
    const pm = new ByteOut((pages.length + 1) * 8);
    for (const p of pages) {
      pm.u32(p.num);
      pm.u32(p.size);
    }
    pm.u32(pmNum);
    pm.u32(pmSize);
    pmPage = systemPage(0x41630e3b, pm.result(), pmSize);
    if (pmPage.size <= pmSize) break;
    pmSize = pmPage.size;
  }
  o.bytes(pmPage.bytes);
  const secondAddr = o.n;

  // 파일 헤더
  const hd = new ByteOut(0x6c);
  const id = 'AcFssFcAJMB';
  for (let i = 0; i < id.length; i++) hd.u8(id.charCodeAt(i));
  hd.u8(0);
  hd.u32(0);
  hd.u32(0x6c);
  hd.u32(4);
  hd.u32(0);
  hd.u32(0);
  hd.u32(0);
  hd.u32(1);
  hd.u32(pmNum);
  hd.u64(pmAddr + pmSize - 0x100);
  hd.u64(secondAddr);
  hd.u32(0);
  hd.u32(pages.length + 1);
  hd.u32(0x20);
  hd.u32(0x80);
  hd.u32(0x40);
  hd.u32(pmNum);
  hd.u64(pmAddr - 0x100);
  hd.u32(smNum);
  hd.u32(pmNum);
  hd.u32(0);
  hd.u32(0);
  const hbuf = hd.result();
  new DataView(hbuf.buffer).setUint32(0x68, crc32(hbuf, 0, 0x6c, 0), true);
  const mg = magic(0x6c);
  const enc = new Uint8Array(0x6c);
  for (let i = 0; i < 0x6c; i++) enc[i] = hbuf[i] ^ mg[i];
  o.bytes(enc);

  const f = o.buf;
  const vs = `AC${ver}`;
  for (let i = 0; i < 6; i++) f[i] = vs.charCodeAt(i);
  f[0x0b] = maint;
  f[0x0c] = 3;
  const dv = new DataView(f.buffer);
  dv.setUint32(0x0d, previewAddr, true);
  f[0x11] = auxVersion(ver);
  f[0x12] = 0;
  dv.setUint16(0x13, codepage, true);
  dv.setUint32(0x18, 0, true);
  dv.setUint32(0x20, summaryAddr, true);
  dv.setUint32(0x28, 0x80, true);
  f.set(enc, 0x80);
  // 0xEC~0x100: 같은 수열의 0xEC번째부터(파일 위치와 같은 번호)
  f.set(magic(0x100).subarray(0xec, 0x100), 0xec);
  return o.result();
}

