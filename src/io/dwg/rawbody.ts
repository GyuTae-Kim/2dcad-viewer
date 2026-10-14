/**
 * DWG 원본 본문 보관(읽기)과 지문(읽기·쓰기 공용).
 * 모델이 일부만 담는 객체는 형식별 본문 비트를 남겨 두었다가 같은 버전으로 쓸 때 그대로 되쓴다.
 */
import type { DwgRawBody } from '../../core/model';
import type { ObjectReader } from './objects/reader';
import { stringStreamRange } from './streams';
import { R2007 } from './version';

/** 공통 속성(쓸 때 모델에서 다시 만드는 값)은 지문에서 뺀다 */
const COMMON = new Set([
  'handle',
  'owner',
  'layer',
  'linetype',
  'color',
  'lineweight',
  'ltscale',
  'transparency',
  'invisible',
  'paperSpace',
  'xdata',
  'xdict',
  'reactors',
  'plotStyle',
  'material',
  'hyperlink',
  'dwgRaw',
  'graphics',
]);

/** 모델 값의 지문(FNV-1a 32비트 16진) */
export function fingerprint(o: object): string {
  const s = JSON.stringify(o, function (this: unknown, k: string, v: unknown) {
    if (this === o && COMMON.has(k)) return undefined;
    if (v instanceof Uint8Array) return Array.from(v);
    if (v instanceof Map) return [...v];
    return v;
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 비트 구간을 앞으로 당겨 새 바이트 배열로 */
function copyBits(buf: Uint8Array, start: number, nbits: number): Uint8Array {
  const out = new Uint8Array((nbits + 7) >>> 3);
  if (nbits <= 0) return out;
  const sh = start & 7;
  const s = start >>> 3;
  if (sh === 0) {
    out.set(buf.subarray(s, s + out.length));
  } else {
    const rs = 8 - sh;
    const n = out.length;
    const last = buf.length - 1;
    for (let i = 0; i < n; i++) {
      const k = s + i;
      out[i] = ((buf[k] << sh) | (k < last ? buf[k + 1] >>> rs : 0)) & 0xff;
    }
  }
  const rest = nbits & 7;
  if (rest) out[out.length - 1] &= 0xff << (8 - rest);
  return out;
}

/**
 * 지금 읽은 객체(공통 자료까지 읽은 상태)의 형식별 본문을 떼어 낸다.
 * CRC가 맞지 않는 객체(망가졌거나 객체 지도가 엉뚱한 곳을 가리킨 것)는 남기지 않는다.
 */
export function captureRaw(or: ObjectReader, model: object): DwgRawBody | undefined {
  const h = or.h;
  if (!h.crcOk || h.endBit <= h.bodyBit) return undefined;
  const ver = or.ver;
  let dataEnd = h.handleBit;
  let strings: Uint8Array | undefined;
  let stringBits = 0;
  if (ver >= R2007) {
    const rg = stringStreamRange(or.str, h.startBit, h.handleBit);
    if (rg) {
      dataEnd = rg.start;
      stringBits = rg.end - rg.start;
      strings = copyBits(or.buf, rg.start, stringBits);
    } else dataEnd = h.handleBit - 1;
  }
  const dataBits = Math.max(0, dataEnd - h.bodyBit);
  const handleBits = Math.max(0, h.endBit - h.bodyHandleBit);
  const raw: DwgRawBody = {
    version: `AC${ver}`,
    typeName: h.typeName,
    typeNum: h.cls ? 0 : h.typeNum,
    data: copyBits(or.buf, h.bodyBit, dataBits),
    dataBits,
    handles: copyBits(or.buf, h.bodyHandleBit, handleBits),
    handleBits,
    fingerprint: fingerprint(model),
  };
  if (strings) {
    raw.strings = strings;
    raw.stringBits = stringBits;
  }
  if (h.dataStore) raw.dataStore = true;
  if (h.isEntity && or.lastGraphics && or.lastGraphics.length) raw.graphics = or.lastGraphics;
  return raw;
}
