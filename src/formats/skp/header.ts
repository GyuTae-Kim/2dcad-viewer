/**
 * SKP 파일 머리. 공개 표본의 바이트에서 확인한 것(docs/formats/skp.md):
 *   - 처음 두 문자열은 길이 앞붙이 UTF-16LE: 표지 FF FE FF + 길이(1바이트, FF면 뒤에 u16·u32) + 글자.
 *     첫째는 "SketchUp Model", 둘째는 "{주.부.빌드}" 꼴의 버전.
 *   - 버전 21 이후: 바로 뒤에 "VFF" + u16 길이(8) + 블록(u16 1, u16 하위 판, u32 검사값으로 보이는 값) → 이어서 ZIP.
 *   - 버전 20 이하: 16바이트(GUID로 보임)·빈 문자열·u32 시각 뒤에 MFC CArchive 꼴 객체 직렬화(CVersionMap부터).
 */

export type SkpContainer = 'zip' | 'mfc';

export interface SkpHeader {
  /** "SketchUp Model" */
  title: string;
  /** 중괄호를 뺀 버전 문자열, 예: "21.0.339" */
  version: string;
  major: number;
  minor: number;
  build: number;
  container: SkpContainer;
  /** 본문 시작(zip이면 ZIP 첫 지역 머리, mfc면 머리 문자열 바로 뒤) */
  bodyOffset: number;
  /** zip 판의 VFF 블록 하위 판(u16, 관찰: 21.0→8, 21.1→11, 22·23→13, 25·26→17) */
  subVersion?: number;
}

/** 머리 문자열 하나를 읽는다: [글자, 다음 위치] 또는 null */
export function readUtf16String(b: Uint8Array, o: number): [string, number] | null {
  if (o + 4 > b.length || b[o] !== 0xff || b[o + 1] !== 0xfe || b[o + 2] !== 0xff) return null;
  let p = o + 3;
  let n = b[p++]!;
  if (n === 0xff) {
    if (p + 2 > b.length) return null;
    n = b[p]! | (b[p + 1]! << 8);
    p += 2;
    if (n === 0xffff) {
      if (p + 4 > b.length) return null;
      n = (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
      p += 4;
    }
  }
  if (p + 2 * n > b.length) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + 2 * i]! | (b[p + 2 * i + 1]! << 8));
  return [s, p + 2 * n];
}

/** SKP 머리를 읽는다. SketchUp 파일이 아니면 null */
export function readSkpHeader(b: Uint8Array): SkpHeader | null {
  const t = readUtf16String(b, 0);
  if (!t || t[0] !== 'SketchUp Model') return null;
  const v = readUtf16String(b, t[1]);
  if (!v) return null;
  const m = /^\{(\d+)\.(\d+)\.(\d+)\}$/.exec(v[0]);
  const version = v[0].replace(/^\{|\}$/g, '');
  const major = m ? Number(m[1]) : NaN;
  const minor = m ? Number(m[2]) : NaN;
  const build = m ? Number(m[3]) : NaN;
  const o = v[1];
  if (b[o] === 0x56 && b[o + 1] === 0x46 && b[o + 2] === 0x46) {
    // "VFF" + u16 길이 + 블록
    const len = b[o + 3]! | (b[o + 4]! << 8);
    const sub = len >= 4 ? b[o + 7]! | (b[o + 8]! << 8) : undefined;
    const h: SkpHeader = { title: t[0], version, major, minor, build, container: 'zip', bodyOffset: o + 5 + len };
    if (sub !== undefined) h.subVersion = sub;
    return h;
  }
  return { title: t[0], version, major, minor, build, container: 'mfc', bodyOffset: o };
}
