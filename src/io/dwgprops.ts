/**
 * 도면 특성(DWGPROPS): 제목·주제·작성자·키워드·주석·마지막 저장자·수정 번호·하이퍼링크 기준·사용자 정의 특성.
 *
 * 모델에서는 이름 있는 객체 사전의 "DWGPROPS" XRECORD가 기준이다(AutoCAD가 DXF에 쓰는 방식, R2000 DWG도 같다):
 *   1 "DWGPROPS COOKIE", 2 제목, 3 주제, 4 작성자, 6 주석, 7 키워드, 8 마지막 저장자, 9 수정 번호,
 *   300~309 사용자 정의 특성 "이름=값"(10개), 40 총 편집 시간(일), 41 만든 때, 42 고친 때(율리우스일), 1 하이퍼링크 기준.
 * R2004 이상 DWG는 같은 내용을 AcDb:SummaryInfo 구역(사양 "AcDb:SummaryInfo")에만 둔다 — 읽을 때 XRECORD로 옮기고
 * (dwg/build.ts), 쓸 때 XRECORD에서 구역을 만든다(dwg/writer). $HYPERLINKBASE는 머리말 변수이기도 하다.
 * XRECORD가 없으면 머리말의 $TITLE·$AUTHOR …(예전 방식) 값을 읽는다.
 */
import type { CadDocument, DictionaryObject, HeaderValue, RawTag, XRecordObject } from '../core/model';
import { normalizeHandle } from '../core/model';

export const DWGPROPS_KEY = 'DWGPROPS';
const COOKIE = 'DWGPROPS COOKIE';
/** XRECORD에 담을 수 있는 사용자 정의 특성 수(300~309) */
export const MAX_CUSTOM_PROPS = 10;

export interface DrawingProps {
  title: string;
  subject: string;
  author: string;
  keywords: string;
  comments: string;
  lastSavedBy: string;
  revisionNumber: string;
  hyperlinkBase: string;
  /** [이름, 값] */
  custom: [string, string][];
}

export function emptyDrawingProps(): DrawingProps {
  return { title: '', subject: '', author: '', keywords: '', comments: '', lastSavedBy: '', revisionNumber: '', hyperlinkBase: '', custom: [] };
}

/** 내용이 하나라도 있는가(마지막 저장자는 빼고) */
export function hasDrawingProps(p: DrawingProps): boolean {
  return !!(p.title || p.subject || p.author || p.keywords || p.comments || p.revisionNumber || p.hyperlinkBase || p.custom.length);
}

function isDict(o: unknown): o is DictionaryObject {
  const t = (o as { type?: string } | undefined)?.type;
  return t === 'DICTIONARY' || t === 'ACDBDICTIONARYWDFLT';
}

function rootDict(doc: CadDocument): DictionaryObject | null {
  const h = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
  const o = h ? doc.objects.get(h) : undefined;
  return isDict(o) ? o : null;
}

/** DWGPROPS XRECORD(없으면 null) */
export function dwgPropsObject(doc: CadDocument): XRecordObject | null {
  const root = rootDict(doc);
  if (!root) return null;
  for (const [k, h] of root.entries) {
    if (k.toUpperCase() !== DWGPROPS_KEY) continue;
    const o = doc.objects.get(normalizeHandle(h));
    return o?.type === 'XRECORD' ? (o as XRecordObject) : null;
  }
  return null;
}

/** XRECORD 태그 → 특성 */
export function propsFromTags(data: readonly RawTag[]): DrawingProps & { editTime?: number; created?: number; modified?: number } {
  const p: DrawingProps & { editTime?: number; created?: number; modified?: number } = emptyDrawingProps();
  let ones = 0;
  const str = (v: string | number) => String(v);
  for (const t of data) {
    switch (t.code) {
      case 1:
        // 첫째 1은 쿠키, 둘째는 하이퍼링크 기준
        if (ones++ > 0 || str(t.value) !== COOKIE) p.hyperlinkBase = str(t.value);
        break;
      case 2:
        p.title = str(t.value);
        break;
      case 3:
        p.subject = str(t.value);
        break;
      case 4:
        p.author = str(t.value);
        break;
      case 6:
        p.comments = str(t.value);
        break;
      case 7:
        p.keywords = str(t.value);
        break;
      case 8:
        p.lastSavedBy = str(t.value);
        break;
      case 9:
        p.revisionNumber = str(t.value);
        break;
      case 40:
        p.editTime = Number(t.value);
        break;
      case 41:
        p.created = Number(t.value);
        break;
      case 42:
        p.modified = Number(t.value);
        break;
      default:
        if (t.code >= 300 && t.code <= 309) {
          const s = str(t.value);
          const i = s.indexOf('=');
          const name = i >= 0 ? s.slice(0, i) : s;
          if (name) p.custom.push([name, i >= 0 ? s.slice(i + 1) : '']);
        }
    }
  }
  return p;
}

/** 줄바꿈은 공백으로(XRECORD 문자열·요약 정보는 한 줄) */
const oneLine = (s: string) => s.replace(/\r?\n/g, ' ');

/** 특성 → XRECORD 태그(시간 값은 머리말 $TDINDWG·$TDCREATE·$TDUPDATE, 없으면 0) */
export function tagsFromProps(p: DrawingProps, times: { editTime?: number; created?: number; modified?: number } = {}): RawTag[] {
  const tags: RawTag[] = [
    { code: 1, value: COOKIE },
    { code: 2, value: oneLine(p.title) },
    { code: 3, value: oneLine(p.subject) },
    { code: 4, value: oneLine(p.author) },
    { code: 6, value: oneLine(p.comments) },
    { code: 7, value: oneLine(p.keywords) },
    { code: 8, value: oneLine(p.lastSavedBy) },
    { code: 9, value: oneLine(p.revisionNumber) },
  ];
  for (let i = 0; i < MAX_CUSTOM_PROPS; i++) {
    const c = p.custom[i];
    tags.push({ code: 300 + i, value: c ? `${oneLine(c[0])}=${oneLine(c[1])}` : '=' });
  }
  tags.push({ code: 40, value: times.editTime ?? 0 }, { code: 41, value: times.created ?? 0 }, { code: 42, value: times.modified ?? 0 }, { code: 1, value: oneLine(p.hyperlinkBase) });
  return tags;
}

const hstr = (v: HeaderValue | undefined) => (typeof v === 'string' ? v : '');
const hnum = (v: HeaderValue | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 도면의 특성(XRECORD, 없으면 머리말의 예전 자리) */
export function drawingProps(doc: CadDocument): DrawingProps {
  const H = doc.header;
  const x = dwgPropsObject(doc);
  if (x) {
    const p = propsFromTags(x.data);
    if (!p.hyperlinkBase) p.hyperlinkBase = hstr(H.get('$HYPERLINKBASE'));
    if (!p.lastSavedBy) p.lastSavedBy = hstr(H.get('$LASTSAVEDBY'));
    return { title: p.title, subject: p.subject, author: p.author, keywords: p.keywords, comments: p.comments, lastSavedBy: p.lastSavedBy, revisionNumber: p.revisionNumber, hyperlinkBase: p.hyperlinkBase, custom: p.custom };
  }
  const custom: [string, string][] = [];
  const tag = hstr(H.get('$CUSTOMPROPERTYTAG'));
  if (tag) custom.push([tag, hstr(H.get('$CUSTOMPROPERTY'))]);
  return {
    title: hstr(H.get('$TITLE')),
    subject: hstr(H.get('$SUBJECT')),
    author: hstr(H.get('$AUTHOR')),
    keywords: hstr(H.get('$KEYWORDS')),
    comments: hstr(H.get('$COMMENTS')),
    lastSavedBy: hstr(H.get('$LASTSAVEDBY')),
    revisionNumber: hstr(H.get('$REVISIONNUMBER')),
    hyperlinkBase: hstr(H.get('$HYPERLINKBASE')),
    custom,
  };
}

/** XRECORD에 쓸 시간 값(머리말에서) */
export function propTimes(doc: CadDocument): { editTime?: number; created?: number; modified?: number } {
  const H = doc.header;
  return { editTime: hnum(H.get('$TDINDWG')), created: hnum(H.get('$TDCREATE')), modified: hnum(H.get('$TDUPDATE')) };
}

// ---------------------------------------------------------------------------
// AcDb:SummaryInfo(R2004+ DWG)
// ---------------------------------------------------------------------------

export interface SummaryInfo extends DrawingProps {
  /** 총 편집 시간(일) */
  editTime: number;
  created: number;
  modified: number;
}

/**
 * 구역 읽기: 문자열 8개(길이 u16 + 글자 — R2007+는 UTF-16 글자 수, 그 전은 바이트 수, 끝 0 포함), 총 편집 시간(일·밀리초 u32 둘),
 * 만든 때·고친 때(율리우스일·밀리초), 특성 수(u16)와 [이름, 값] 문자열 쌍, u32 둘. 잘린 구역은 읽은 데까지
 */
export function parseSummaryInfo(si: Uint8Array, wide: boolean, decode: (b: Uint8Array) => string): SummaryInfo {
  const out: SummaryInfo = { ...emptyDrawingProps(), editTime: 0, created: 0, modified: 0 };
  let p = 0;
  const need = (n: number) => {
    if (p + n > si.length) throw new RangeError('summary');
  };
  const u16 = () => {
    need(2);
    const v = si[p]! | (si[p + 1]! << 8);
    p += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = (si[p]! | (si[p + 1]! << 8) | (si[p + 2]! << 16) | (si[p + 3]! << 24)) >>> 0;
    p += 4;
    return v;
  };
  const str = (): string => {
    const n = u16();
    if (wide) {
      need(n * 2);
      let s = '';
      for (let i = 0; i < n; i++) {
        const c = si[p + i * 2]! | (si[p + i * 2 + 1]! << 8);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      p += n * 2;
      return s;
    }
    need(n);
    let e = p;
    while (e < p + n && si[e]) e++;
    const s = decode(si.subarray(p, e));
    p += n;
    return s;
  };
  const jd = () => {
    const day = u32();
    const ms = u32();
    return day + ms / 86400000;
  };
  try {
    out.title = str();
    out.subject = str();
    out.author = str();
    out.keywords = str();
    out.comments = str();
    out.lastSavedBy = str();
    out.revisionNumber = str();
    out.hyperlinkBase = str();
    out.editTime = jd();
    out.created = jd();
    out.modified = jd();
    const n = u16();
    for (let i = 0; i < n; i++) {
      const k = str();
      const v = str();
      if (k) out.custom.push([k, v]);
    }
  } catch {
    // 잘린 구역: 읽은 데까지
  }
  return out;
}

/** 구역 쓰기(parseSummaryInfo의 반대). encode는 R2004의 코드 페이지 바이트 */
export function encodeSummaryInfo(s: SummaryInfo, wide: boolean, encode: (t: string) => Uint8Array): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const str = (raw: string) => {
    const v = oneLine(raw);
    if (wide) {
      u16(v.length ? v.length + 1 : 0);
      for (let i = 0; i < v.length; i++) u16(v.charCodeAt(i));
      if (v.length) u16(0);
    } else {
      const b = encode(v);
      u16(b.length ? b.length + 1 : 0);
      for (const x of b) parts.push(x);
      if (b.length) parts.push(0);
    }
  };
  const jd = (x: number) => {
    const day = Math.floor(x);
    u32(day);
    u32(Math.min(86399999, Math.round((x - day) * 86400000)));
  };
  str(s.title);
  str(s.subject);
  str(s.author);
  str(s.keywords);
  str(s.comments);
  str(s.lastSavedBy);
  str(s.revisionNumber);
  str(s.hyperlinkBase);
  jd(Math.max(0, s.editTime));
  jd(s.created);
  jd(s.modified);
  u16(s.custom.length);
  for (const [k, v] of s.custom) {
    str(k);
    str(v);
  }
  u32(0);
  u32(0);
  return Uint8Array.from(parts);
}

/**
 * 읽은 요약 정보를 도면에 넣는다(DWG 리더): DWGPROPS XRECORD를 만들거나(새 핸들 = $HANDSEED, 그 뒤로 올린다) 고친다.
 * 내용이 없으면 아무것도 만들지 않는다. $LASTSAVEDBY는 늘 머리말에도 둔다
 */
export function adoptSummaryInfo(doc: CadDocument, s: SummaryInfo): void {
  if (s.lastSavedBy) doc.header.set('$LASTSAVEDBY', s.lastSavedBy);
  if (s.hyperlinkBase && !hstr(doc.header.get('$HYPERLINKBASE'))) doc.header.set('$HYPERLINKBASE', s.hyperlinkBase);
  if (!hasDrawingProps(s)) return;
  const tags = tagsFromProps(s, { editTime: s.editTime, created: s.created, modified: s.modified });
  const have = dwgPropsObject(doc);
  if (have) {
    have.data = tags;
    delete have.dwgRaw;
    return;
  }
  const root = rootDict(doc);
  if (!root) return;
  const seedRaw = doc.header.get('$HANDSEED');
  let seed = typeof seedRaw === 'string' ? parseInt(seedRaw, 16) : typeof seedRaw === 'number' ? seedRaw : NaN;
  if (!Number.isFinite(seed) || seed <= 0) {
    seed = 1;
    for (const k of doc.objects.keys()) seed = Math.max(seed, parseInt(k, 16) + 1 || 0);
    for (const k of doc.entityIndex.keys()) seed = Math.max(seed, parseInt(k, 16) + 1 || 0);
  }
  let h = seed.toString(16).toUpperCase();
  while (doc.objects.has(h) || doc.entityIndex.has(h)) h = (++seed).toString(16).toUpperCase();
  const x: XRecordObject = { type: 'XRECORD', handle: h, owner: root.handle, reactors: [root.handle], cloning: 1, data: tags };
  doc.objects.set(h, x);
  root.entries.set(DWGPROPS_KEY, h);
  delete root.dwgRaw;
  doc.header.set('$HANDSEED', (seed + 1).toString(16).toUpperCase());
}

/** 도면의 특성으로 요약 정보 구역 값(DWG 쓰기). 시간은 머리말 */
export function summaryFromDoc(doc: CadDocument, tdcreate: number, tdupdate: number): SummaryInfo {
  const p = drawingProps(doc);
  return { ...p, editTime: hnum(doc.header.get('$TDINDWG')) ?? 0, created: tdcreate, modified: tdupdate };
}
