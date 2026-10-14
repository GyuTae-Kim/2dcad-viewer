/**
 * R2007(AC1021) 파일 구조(사양 5장).
 * 파일 헤더·시스템 페이지·자료 페이지는 Reed–Solomon 부호로 감싸여 있다. 오류 정정은 하지 않고
 * 끼워 짠(interleave) 바이트를 풀어 자료 바이트만 꺼낸다(손상되지 않은 파일이면 그것으로 충분하다).
 */
import { CadReadError } from '../../../core/errors';
import { DwgFormatError } from '../bitstream';
import { decompressR21 } from '../lz77r21';
import { type DwgSections, warn } from './types';

const u64 = (dv: DataView, off: number): number => dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;
const i64 = (dv: DataView, off: number): number => dv.getUint32(off, true) + dv.getInt32(off + 4, true) * 0x100000000;

/** RS 부호 블록 풀기: 블록 i의 j번째 바이트가 raw[j * blocks + i](끼워 짬) 또는 raw[i * 255 + j] */
function rsDecode(raw: Uint8Array, start: number, blocks: number, k: number, interleaved: boolean): Uint8Array {
  const out = new Uint8Array(blocks * k);
  if (interleaved) {
    for (let i = 0; i < blocks; i++) {
      const o = i * k;
      for (let j = 0; j < k; j++) out[o + j] = raw[start + j * blocks + i];
    }
  } else {
    for (let i = 0; i < blocks; i++) out.set(raw.subarray(start + i * 255, start + i * 255 + k), i * k);
  }
  return out;
}

/** 시스템 페이지(페이지 지도·섹션 지도) 읽기 */
function readSystemPage(data: Uint8Array, offset: number, compSize: number, uncompSize: number, factor: number): Uint8Array {
  const aligned = (compSize + 7) & ~7;
  const pesize = aligned * Math.max(1, factor);
  const blocks = Math.ceil(pesize / 239);
  if (offset < 0 || offset + blocks * 255 > data.length) throw new DwgFormatError('R2007 시스템 페이지가 파일 밖에 있습니다');
  const dec = rsDecode(data, offset, blocks, 239, true);
  if (compSize < uncompSize) return decompressR21(dec, 0, compSize, uncompSize);
  return dec.slice(0, uncompSize);
}

interface R21Page {
  offset: number;
  size: number;
}

interface R21Section {
  name: string;
  dataSize: number;
  maxSize: number;
  encrypted: number;
  encoding: number;
  pages: { offset: number; size: number; id: number; uncomp: number; comp: number }[];
}

export function readR2007Container(data: Uint8Array, ver: number): DwgSections {
  const warnings: DwgSections['warnings'] = [];
  if (data.length < 0x480) throw new CadReadError('dwg.corrupt', { reason: 'file header too short' });
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const maintVer = data[0x0b];
  const codepage = dv.getUint16(0x13, true);
  const securityFlags = dv.getUint32(0x18, true);

  // 0x80부터 3블록(255,239) 끼워 짠 헤더
  const hdrRaw = rsDecode(data, 0x80, 3, 239, true);
  const hv = new DataView(hdrRaw.buffer);
  const comprLen = hv.getInt32(0x18, true);
  let fh: Uint8Array;
  if (comprLen < 0) fh = hdrRaw.slice(0x20, 0x20 - comprLen);
  else fh = decompressR21(hdrRaw, 0x20, comprLen, 0x110);
  const fv = new DataView(fh.buffer, fh.byteOffset, fh.byteLength);
  const pagesMapCorrection = u64(fv, 0x18);
  const pagesMapOffset = u64(fv, 0x38) + 0x480;
  const pagesMapSizeComp = u64(fv, 0x50);
  const pagesMapSizeUncomp = u64(fv, 0x58);
  const sectionsMapSizeComp = u64(fv, 0xb0);
  const sectionsMapId = u64(fv, 0xc0);
  const sectionsMapSizeUncomp = u64(fv, 0xc8);
  const sectionsMapCorrection = u64(fv, 0xd8);

  // 페이지 지도: (크기, 번호) 쌍
  const pm = readSystemPage(data, pagesMapOffset, pagesMapSizeComp, pagesMapSizeUncomp, pagesMapCorrection);
  const pmv = new DataView(pm.buffer, pm.byteOffset, pm.byteLength);
  const pages = new Map<number, R21Page>();
  let off = 0;
  for (let p = 0; p + 16 <= pm.length; p += 16) {
    const size = i64(pmv, p);
    const id = i64(pmv, p + 8);
    pages.set(Math.abs(id), { offset: off, size });
    off += size;
  }

  // 섹션 지도
  const smPage = pages.get(sectionsMapId);
  if (!smPage) throw new CadReadError('dwg.corrupt', { reason: 'section map page missing' });
  const sm = readSystemPage(data, smPage.offset + 0x480, sectionsMapSizeComp, sectionsMapSizeUncomp, sectionsMapCorrection);
  const smv = new DataView(sm.buffer, sm.byteOffset, sm.byteLength);
  const sections = new Map<string, R21Section>();
  let q = 0;
  while (q + 0x40 <= sm.length) {
    const dataSize = u64(smv, q);
    const maxSize = u64(smv, q + 8);
    const encrypted = u64(smv, q + 0x10);
    const nameLen = u64(smv, q + 0x20);
    const encoding = u64(smv, q + 0x30);
    const numPages = u64(smv, q + 0x38);
    q += 0x40;
    // 이름 길이는 끝의 0 두 바이트를 포함한 바이트 수다(사양은 글자 수라 한다)
    let name = '';
    for (let i = 0; i + 1 < nameLen && q + i + 1 < sm.length; i += 2) {
      const ch = sm[q + i] | (sm[q + i + 1] << 8);
      if (!ch) break;
      name += String.fromCharCode(ch);
    }
    q += nameLen;
    const sec: R21Section = { name, dataSize, maxSize, encrypted, encoding, pages: [] };
    for (let i = 0; i < numPages && q + 56 <= sm.length; i++) {
      sec.pages.push({
        offset: u64(smv, q),
        size: u64(smv, q + 8),
        id: i64(smv, q + 16),
        uncomp: u64(smv, q + 24),
        comp: u64(smv, q + 32),
      });
      q += 56;
    }
    if (name) sections.set(name, sec);
  }

  const readSection = (name: string): Uint8Array | null => {
    const sec = sections.get(name);
    if (!sec) return null;
    if (sec.encrypted === 1) throw new CadReadError('dwg.encrypted', { section: name });
    if (sec.dataSize > data.length * 32 + 0x100000) throw new CadReadError('dwg.corrupt', { reason: 'section size', section: name });
    const out = new Uint8Array(sec.dataSize);
    for (const pg of sec.pages) {
      const info = pages.get(Math.abs(pg.id));
      if (!info) {
        warn(warnings, 'dwg.page_missing', `${name} 섹션의 페이지를 찾지 못했습니다.`);
        continue;
      }
      try {
        const aligned = (pg.comp + 7) & ~7;
        const blocks = Math.ceil(aligned / 251);
        const start = info.offset + 0x480;
        if (start + blocks * 255 > data.length) throw new DwgFormatError('페이지가 파일 밖에 있습니다');
        const dec = rsDecode(data, start, blocks, 251, sec.encoding === 4);
        const n = Math.min(pg.uncomp, out.length - pg.offset);
        if (n <= 0) continue;
        if (pg.comp < pg.uncomp) {
          const u = decompressR21(dec, 0, pg.comp, pg.uncomp);
          out.set(u.subarray(0, n), pg.offset);
        } else {
          out.set(dec.subarray(0, n), pg.offset);
        }
      } catch (e) {
        warn(warnings, 'dwg.page_corrupt', `${name} 섹션 페이지를 풀지 못했습니다.`, { error: String(e) });
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
