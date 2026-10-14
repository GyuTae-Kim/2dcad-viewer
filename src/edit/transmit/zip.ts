/**
 * ZIP 쓰기(의존성 없음): 저장(STORE) 또는 DEFLATE(브라우저·Node의 CompressionStream('deflate-raw')), CRC-32,
 * UTF-8 파일 이름(일반 목적 플래그 비트 11 = 0x0800), DOS 날짜·시각. ZIP64는 없다(4GB·항목 65,535개까지).
 */

export interface ZipEntry {
  /** 패키지 안 경로('/'로 나눈다) */
  name: string;
  data: Uint8Array;
  modified?: Date;
}

export const MSG_ZIP_TOO_LARGE = '전송 패키지가 4GB를 넘어 만들 수 없습니다. 이 웹 버전은 ZIP64 없이 4GB까지 만듭니다.';

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32(ZIP·PNG와 같은 다항식). crc는 이어서 셀 때의 앞 값 */
export function crc32(data: Uint8Array, crc = 0): number {
  const t = crcTable();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DEFLATE 원시 스트림(CompressionStream이 없으면 null) */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31),
    date: (((y - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

const enc = new TextEncoder();

/** 패키지 안 경로 정리: 역슬래시 → '/', 앞의 '/'·'./' 없애기 */
export function zipName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
    .join('/');
}

/**
 * ZIP 바이트를 만든다. compress가 거짓이면 모두 저장, 참이면 줄어들 때만 DEFLATE.
 * 4GB(32비트 크기·위치)나 항목 65,535개를 넘으면 MSG_ZIP_TOO_LARGE 오류.
 */
export async function buildZip(entries: readonly ZipEntry[], opt: { compress?: boolean } = {}): Promise<Uint8Array> {
  if (entries.length > 0xffff) throw new Error(MSG_ZIP_TOO_LARGE);
  const compress = opt.compress ?? true;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const LIMIT = 0xffffffff;
  for (const e of entries) {
    const name = enc.encode(zipName(e.name));
    if (e.data.length >= LIMIT) throw new Error(MSG_ZIP_TOO_LARGE);
    const crc = crc32(e.data);
    let method = 0;
    let body = e.data;
    if (compress && e.data.length > 0) {
      const d = await deflateRaw(e.data);
      if (d && d.length < e.data.length) {
        method = 8;
        body = d;
      }
    }
    const { time, date } = dosTime(e.modified ?? new Date());
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    if (offset + local.length + body.length >= LIMIT) throw new Error(MSG_ZIP_TOO_LARGE);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    parts.push(local, body);
    central.push(cen);
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  if (offset + cdSize + 22 >= LIMIT) throw new Error(MSG_ZIP_TOO_LARGE);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const x of [...parts, ...central, end]) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}
