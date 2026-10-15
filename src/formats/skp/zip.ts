/**
 * ZIP 읽기(동기, 의존성 없음) — SketchUp 2021 이후 파일 안의 꾸러미용.
 * 공개된 ZIP 구조(끝 레코드 EOCD → 중앙 목록 → 지역 머리)만 쓴다. ZIP64·암호·분할 꾸러미는 다루지 않는다.
 * SKP는 ZIP 앞에 머리(UTF-16 표지·버전·VFF 블록)가 붙고 ZIP 안의 위치는 ZIP 시작 기준이라,
 * 끝 레코드 위치에서 중앙 목록 크기·위치를 빼서 앞붙이 길이(base)를 구한다.
 */

import { inflateRaw } from './inflate';

export interface ZipItem {
  /** 꾸러미 안 경로(UTF-8로 읽는다 — SketchUp은 비트 11 없이 UTF-8 이름을 쓴다) */
  name: string;
  /** 0 저장, 8 DEFLATE */
  method: number;
  compressedSize: number;
  size: number;
  /** 파일 전체 기준 지역 머리 위치 */
  localOffset: number;
}

const utf8 = new TextDecoder('utf-8');

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** 중앙 목록을 읽는다. ZIP이 아니면 null */
export function readZipDirectory(b: Uint8Array): ZipItem[] | null {
  // EOCD: 'PK\5\6' + 18바이트 + 설명(최대 65535)
  const min = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let p = b.length - 22; p >= min; p--) {
    if (b[p] === 0x50 && b[p + 1] === 0x4b && b[p + 2] === 0x05 && b[p + 3] === 0x06) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 꾸러미는 아직 읽지 못합니다');
  const base = eocd - cdSize - cdOffset;
  if (base < 0) return null;
  const items: ZipItem[] = [];
  let p = base + cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('ZIP 중앙 목록이 깨졌습니다');
    const method = u16(b, p + 10);
    const compressedSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = utf8.decode(b.subarray(p + 46, p + 46 + nameLen));
    items.push({ name, method, compressedSize, size, localOffset: base + local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return items;
}

/** 항목 내용을 꺼낸다(저장·DEFLATE만) */
export function readZipItem(b: Uint8Array, item: ZipItem): Uint8Array {
  const p = item.localOffset;
  if (p + 30 > b.length || u32(b, p) !== 0x04034b50) throw new Error(`ZIP 지역 머리가 깨졌습니다: ${item.name}`);
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const end = start + item.compressedSize;
  if (end > b.length) throw new Error(`ZIP 항목이 잘렸습니다: ${item.name}`);
  const data = b.subarray(start, end);
  if (item.method === 0) return data.slice();
  if (item.method === 8) return inflateRaw(data, item.size);
  throw new Error(`지원하지 않는 ZIP 압축 방식 ${item.method}: ${item.name}`);
}
