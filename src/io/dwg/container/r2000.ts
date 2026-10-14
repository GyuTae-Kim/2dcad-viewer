/** R13~R2000(AC1012·AC1014·AC1015) 파일 구조(사양 3장) */
import { CadReadError } from '../../../core/errors';
import { crc8 } from '../crc';
import { type DwgSections, warn } from './types';

const FILE_HEADER_SENTINEL = [0x95, 0xa0, 0x4e, 0x28, 0x99, 0x82, 0x1a, 0xe5, 0x5e, 0x41, 0xe0, 0x5f, 0x9d, 0x3a, 0x4d, 0x00];
const LOCATOR_CRC_XOR: Record<number, number> = { 3: 0xa598, 4: 0x8101, 5: 0x3cc4, 6: 0x8461 };

export function readR2000Container(data: Uint8Array, ver: number): DwgSections {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 0x40) throw new CadReadError('dwg.corrupt', { reason: 'file header too short' });
  const warnings: DwgSections['warnings'] = [];
  const maintVer = data[0x0b];
  const codepage = dv.getUint16(0x13, true);
  const count = dv.getInt32(0x15, true);
  if (count < 3 || count > 16) throw new CadReadError('dwg.corrupt', { reason: 'section locator count', count });
  const loc: { num: number; seeker: number; size: number }[] = [];
  let p = 0x19;
  for (let i = 0; i < count; i++) {
    loc.push({ num: data[p], seeker: dv.getInt32(p + 1, true), size: dv.getInt32(p + 5, true) });
    p += 9;
  }
  // CRC와 표지 확인(어긋나면 경고만)
  const crc = dv.getUint16(p, true);
  const calc = crc8(0, data, 0, p) ^ (LOCATOR_CRC_XOR[count] ?? 0);
  if (crc !== calc) warn(warnings, 'dwg.crc_mismatch', '파일 헤더 CRC가 맞지 않습니다.');
  for (let k = 0; k < 16; k++) {
    if (data[p + 2 + k] !== FILE_HEADER_SENTINEL[k]) {
      warn(warnings, 'dwg.sentinel_mismatch', '파일 헤더 끝 표지가 맞지 않습니다.');
      break;
    }
  }

  const section = (num: number): Uint8Array | null => {
    const l = loc.find((x) => x.num === num);
    if (!l || l.seeker <= 0 || l.size <= 0 || l.seeker + l.size > data.length) return null;
    return data.subarray(l.seeker, l.seeker + l.size);
  };
  const header = section(0);
  const handles = section(2);
  if (!header || !handles) throw new CadReadError('dwg.corrupt', { reason: 'missing header or object map' });
  let template: Uint8Array | null = null;
  if (count > 4) template = section(4);
  return {
    ver,
    codepage,
    maintVer,
    header,
    classes: section(1),
    handles,
    objects: data,
    template,
    warnings,
  };
}
