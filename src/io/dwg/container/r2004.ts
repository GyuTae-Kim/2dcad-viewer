/** R2004·R2010·R2013·R2018(AC1018·AC1024·AC1027·AC1032) 파일 구조(사양 4장) */
import { CadReadError } from '../../../core/errors';
import { crc32, pageChecksum } from '../crc';
import { decompressR18 } from '../lz77';
import { type DwgSections, warn } from './types';

/** 0x6C 바이트 헤더 복호화 수열(사양 4.1의 생성식) */
function magicSequence(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 0x343fd) + 0x269ec3) | 0;
    out[i] = (seed >> 16) & 0xff;
  }
  return out;
}

interface PageInfo {
  num: number;
  size: number;
  address: number;
}

interface SectionDesc {
  name: string;
  size: number;
  pageCount: number;
  maxSize: number;
  compressed: number;
  id: number;
  encrypted: number;
  pages: { num: number; dataSize: number; start: number }[];
}

const u64 = (dv: DataView, off: number): number => dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;

export interface R2004File {
  sections: Map<string, SectionDesc>;
  read(name: string): Uint8Array | null;
}

function readSystemPage(data: Uint8Array, dv: DataView, address: number, expectType: number, what: string): Uint8Array {
  if (address <= 0 || address + 0x14 > data.length) throw new CadReadError('dwg.corrupt', { reason: `${what} address` });
  const type = dv.getUint32(address, true);
  if (type !== expectType) throw new CadReadError('dwg.corrupt', { reason: `${what} page type`, type });
  const decompSize = dv.getUint32(address + 4, true);
  const compSize = dv.getUint32(address + 8, true);
  const compType = dv.getUint32(address + 12, true);
  const start = address + 0x14;
  if (start + compSize > data.length || decompSize > 0x4000000) throw new CadReadError('dwg.corrupt', { reason: `${what} size` });
  if (compType === 2) return decompressR18(data, start, start + compSize, decompSize);
  return data.slice(start, start + decompSize);
}

export function readR2004Container(data: Uint8Array, ver: number): DwgSections {
  const warnings: DwgSections['warnings'] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 0x100) throw new CadReadError('dwg.corrupt', { reason: 'file header too short' });
  const maintVer = data[0x0b];
  const codepage = dv.getUint16(0x13, true);
  const securityFlags = dv.getUint32(0x18, true);

  // 0x80부터 0x6C 바이트를 XOR로 푼다.
  const magic = magicSequence(0x6c);
  const hdr = new Uint8Array(0x6c);
  for (let i = 0; i < 0x6c; i++) hdr[i] = data[0x80 + i] ^ magic[i];
  const hv = new DataView(hdr.buffer);
  const id = String.fromCharCode(...hdr.subarray(0, 11));
  if (id !== 'AcFssFcAJMB') throw new CadReadError('dwg.corrupt', { reason: 'file header id' });
  {
    const stored = hv.getUint32(0x68, true);
    const tmp = hdr.slice();
    tmp[0x68] = tmp[0x69] = tmp[0x6a] = tmp[0x6b] = 0;
    if (crc32(tmp, 0, 0x6c, 0) !== stored) warn(warnings, 'dwg.crc_mismatch', '파일 헤더 CRC가 맞지 않습니다.');
  }
  const pageMapAddress = u64(hv, 0x54) + 0x100;
  const sectionMapId = hv.getUint32(0x5c, true);

  // 섹션 페이지 지도
  const pageMap = readSystemPage(data, dv, pageMapAddress, 0x41630e3b, 'page map');
  const pmv = new DataView(pageMap.buffer, pageMap.byteOffset, pageMap.byteLength);
  const pages = new Map<number, PageInfo>();
  let address = 0x100;
  for (let p = 0; p + 8 <= pageMap.length; ) {
    const num = pmv.getInt32(p, true);
    const size = pmv.getUint32(p + 4, true);
    p += 8;
    if (num >= 0) pages.set(num, { num, size, address });
    else p += 16; // 빈 칸(부모·왼쪽·오른쪽·0)
    address += size;
  }

  // 섹션 지도
  const smPage = pages.get(sectionMapId);
  if (!smPage) throw new CadReadError('dwg.corrupt', { reason: 'section map page missing' });
  const secMap = readSystemPage(data, dv, smPage.address, 0x4163003b, 'section map');
  const sv = new DataView(secMap.buffer, secMap.byteOffset, secMap.byteLength);
  const numDesc = sv.getInt32(0, true);
  const sections = new Map<string, SectionDesc>();
  let q = 0x14;
  for (let k = 0; k < numDesc && q + 0x60 <= secMap.length; k++) {
    const size = u64(sv, q);
    const pageCount = sv.getUint32(q + 8, true);
    const maxSize = sv.getUint32(q + 0x0c, true);
    const compressed = sv.getUint32(q + 0x14, true);
    const sid = sv.getUint32(q + 0x18, true);
    const encrypted = sv.getUint32(q + 0x1c, true);
    let name = '';
    for (let c = 0; c < 64; c++) {
      const ch = secMap[q + 0x20 + c];
      if (!ch) break;
      name += String.fromCharCode(ch);
    }
    q += 0x60;
    const desc: SectionDesc = { name, size, pageCount, maxSize, compressed, id: sid, encrypted, pages: [] };
    for (let i = 0; i < pageCount && q + 16 <= secMap.length; i++) {
      desc.pages.push({ num: sv.getInt32(q, true), dataSize: sv.getUint32(q + 4, true), start: u64(sv, q + 8) });
      q += 16;
    }
    if (name) sections.set(name, desc);
  }

  const readSection = (name: string): Uint8Array | null => {
    const desc = sections.get(name);
    if (!desc) return null;
    if (desc.encrypted === 1) throw new CadReadError('dwg.encrypted', { section: name });
    // 압축을 풀어도 파일 크기의 수십 배를 넘지 않는다(망가진 크기로 큰 메모리를 잡지 않게)
    if (desc.size > data.length * 32 + 0x100000) throw new CadReadError('dwg.corrupt', { reason: 'section size', section: name });
    const out = new Uint8Array(desc.size);
    // 마지막 페이지도 압축은 페이지 전체 크기로 되어 있으므로 임시 버퍼에 풀고 앞부분만 옮긴다.
    const temp = desc.compressed === 2 ? new Uint8Array(desc.maxSize) : null;
    for (const pg of desc.pages) {
      const info = pages.get(pg.num);
      if (!info) {
        warn(warnings, 'dwg.page_missing', `${name} 섹션의 페이지를 찾지 못했습니다.`);
        continue;
      }
      const a = info.address;
      if (a + 32 > data.length) {
        warn(warnings, 'dwg.page_missing', `${name} 섹션의 페이지가 파일 밖에 있습니다.`);
        continue;
      }
      // 32바이트 페이지 헤더 마스크 풀기
      const mask = (0x4164536b ^ a) >>> 0;
      const h0 = (dv.getUint32(a, true) ^ mask) >>> 0;
      const dataSize = (dv.getUint32(a + 8, true) ^ mask) >>> 0;
      const start = ((dv.getUint32(a + 16, true) ^ mask) >>> 0) + ((dv.getUint32(a + 20, true) ^ mask) >>> 0) * 0x100000000;
      const dataChecksum = (dv.getUint32(a + 28, true) ^ mask) >>> 0;
      if (h0 !== 0x4163043b) {
        warn(warnings, 'dwg.page_corrupt', `${name} 섹션 페이지 헤더가 맞지 않습니다.`);
        continue;
      }
      const ds = a + 32;
      if (ds + dataSize > data.length) {
        warn(warnings, 'dwg.page_corrupt', `${name} 섹션 페이지가 파일 끝을 넘습니다.`);
        continue;
      }
      if (pageChecksum(0, data, ds, dataSize) !== dataChecksum) {
        warn(warnings, 'dwg.checksum_mismatch', `${name} 섹션 페이지 체크섬이 맞지 않습니다.`);
      }
      const logical = Math.min(desc.maxSize, desc.size - start);
      if (logical <= 0) continue;
      try {
        if (temp) {
          temp.fill(0);
          decompressR18(data, ds, ds + dataSize, desc.maxSize, temp, 0);
          out.set(temp.subarray(0, logical), start);
        } else {
          out.set(data.subarray(ds, ds + Math.min(logical, dataSize)), start);
        }
      } catch (e) {
        warn(warnings, 'dwg.page_corrupt', `${name} 섹션 페이지 압축을 풀지 못했습니다.`, { error: String(e) });
      }
    }
    return out;
  };

  // 선택 섹션: 속성만 암호화된 파일(보안 플래그 2)도 도면은 읽는다
  const optional = (f: () => Uint8Array | null): Uint8Array | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  const header = readSection('AcDb:Header');
  const handles = readSection('AcDb:Handles');
  const objects = readSection('AcDb:AcDbObjects');
  if (!header || !handles || !objects) throw new CadReadError('dwg.corrupt', { reason: 'missing section' });
  return {
    ver,
    codepage,
    maintVer,
    header,
    classes: readSection('AcDb:Classes'),
    handles,
    objects,
    template: optional(() => readSection('AcDb:Template')),
    summaryInfo: optional(() => readSection('AcDb:SummaryInfo')),
    securityFlags,
    warnings,
  };
}
