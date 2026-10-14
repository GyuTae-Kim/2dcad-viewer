/**
 * 자료·문자열·핸들 흐름 묶음.
 * R2007 이전에는 문자열이 자료 흐름 안에 있고, 핸들은 자료 뒤(비트 크기 위치)부터 따로 읽는다.
 * R2007+는 문자열 흐름이 자료 끝 앞쪽에 따로 있다(사양 20.1).
 */
import { BitReader } from './bitstream';
import { R2007 } from './version';

export interface Streams {
  dat: BitReader;
  str: BitReader;
  hdl: BitReader;
}

/**
 * R2007+ 문자열 흐름 위치를 찾는다. endBit는 자료 흐름 끝(문자열 흐름 존재 비트 바로 뒤).
 * 문자열 흐름이 있으면 그 시작 비트를, 없으면 -1을 돌려준다.
 */
export function locateStringStream(r: BitReader, startBit: number, endBit: number): number {
  if (endBit - 1 < startBit) return -1;
  r.pos = endBit - 1;
  if (!r.B()) return -1;
  let p = endBit - 1 - 16;
  if (p < startBit) return -1;
  r.pos = p;
  let size = r.RSu();
  if (size & 0x8000) {
    p -= 16;
    if (p < startBit) return -1;
    r.pos = p;
    const hi = r.RSu();
    size = (size & 0x7fff) | (hi << 15);
  }
  const start = p - size;
  if (start < startBit) return -1;
  return start;
}

/** R2007+ 문자열 흐름 내용의 [시작, 끝) 비트(끝 = 크기 필드 앞). 없으면 null */
export function stringStreamRange(r: BitReader, startBit: number, endBit: number): { start: number; end: number } | null {
  if (endBit - 1 < startBit) return null;
  r.pos = endBit - 1;
  if (!r.B()) return null;
  let p = endBit - 1 - 16;
  if (p < startBit) return null;
  r.pos = p;
  let size = r.RSu();
  if (size & 0x8000) {
    p -= 16;
    if (p < startBit) return null;
    r.pos = p;
    const hi = r.RSu();
    size = (size & 0x7fff) | (hi << 15);
  }
  const start = p - size;
  if (start < startBit) return null;
  return { start, end: p };
}

/** 자료 흐름 dat에 맞춰 문자열 흐름 리더를 붙인다(R2007+). */
export function attachStringStream(dat: BitReader, str: BitReader, startBit: number, endBit: number): void {
  if (dat.ver < R2007) {
    dat.strReader = dat;
    return;
  }
  const s = locateStringStream(str, startBit, endBit);
  if (s >= 0) {
    str.pos = s;
    str.end = endBit;
  } else {
    // 문자열 흐름 없음: 어떤 문자열도 길이 0으로 읽히도록 끝을 막는다.
    str.pos = endBit;
    str.end = endBit;
  }
  dat.strReader = str;
}
