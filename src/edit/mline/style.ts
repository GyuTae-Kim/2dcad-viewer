/**
 * 여러 줄 스타일(MLINESTYLE): 찾기, 현재 스타일, 쓰는 곳, 새 스타일 값 검사.
 * 플래그(70): 1 채우기, 2 연결부(조인) 표시, 16 시작 선, 32 시작 내부 호, 64 시작 외부 호, 256 끝 선, 512 끝 내부 호, 1024 끝 외부 호.
 */
import type { CadDocument, DictionaryObject, MLineStyleElement, MLineStyleObject } from '../../core/model';
import { tableKey } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';

export const ML_FILL = 1;
export const ML_JOINTS = 2;
export const ML_START_LINE = 16;
export const ML_START_INNER = 32;
export const ML_START_OUTER = 64;
export const ML_END_LINE = 256;
export const ML_END_INNER = 512;
export const ML_END_OUTER = 1024;

export const MAX_ELEMENTS = 16;

/** 루트 사전의 ACAD_MLINESTYLE 사전 */
export function mlineStyleDictionary(doc: CadDocument): DictionaryObject | null {
  const root = doc.rootDictionary ? doc.objects.get(doc.rootDictionary) : undefined;
  let h: string | undefined;
  if (root && (root.type === 'DICTIONARY' || root.type === 'ACDBDICTIONARYWDFLT')) for (const [k, v] of (root as DictionaryObject).entries) if (k.toUpperCase() === 'ACAD_MLINESTYLE') h = v;
  if (!h) {
    for (const o of doc.objects.values()) {
      if (o.type !== 'DICTIONARY') continue;
      const d = o as DictionaryObject;
      for (const v of d.entries.values()) if (doc.objects.get(v)?.type === 'MLINESTYLE') return d;
    }
    return null;
  }
  const d = doc.objects.get(h);
  return d && (d.type === 'DICTIONARY' || d.type === 'ACDBDICTIONARYWDFLT') ? (d as DictionaryObject) : null;
}

export interface MLineStyleEntry {
  /** 사전 항목 이름(없으면 객체 이름) */
  name: string;
  style: MLineStyleObject;
}

export function listMLineStyles(doc: CadDocument): MLineStyleEntry[] {
  const out: MLineStyleEntry[] = [];
  const seen = new Set<string>();
  const dict = mlineStyleDictionary(doc);
  if (dict)
    for (const [name, h] of dict.entries) {
      const o = doc.objects.get(h);
      if (o?.type !== 'MLINESTYLE') continue;
      seen.add(h);
      out.push({ name: decodeCadEscapes(name), style: o as MLineStyleObject });
    }
  for (const o of doc.objects.values()) if (o.type === 'MLINESTYLE' && !seen.has(o.handle)) out.push({ name: (o as MLineStyleObject).name, style: o as MLineStyleObject });
  return out;
}

export function findMLineStyle(doc: CadDocument, nameOrHandle: string | undefined): MLineStyleEntry | null {
  if (!nameOrHandle) return null;
  const list = listMLineStyles(doc);
  const k = tableKey(nameOrHandle);
  return list.find((s) => s.style.handle === k) ?? list.find((s) => tableKey(s.name) === k || tableKey(s.style.name) === k) ?? null;
}

/** 지금 여러 줄 스타일($CMLSTYLE, 없으면 Standard) */
export function currentMLineStyle(doc: CadDocument): MLineStyleEntry | null {
  const cur = doc.header.get('$CMLSTYLE');
  return findMLineStyle(doc, typeof cur === 'string' ? cur : 'Standard') ?? findMLineStyle(doc, 'Standard') ?? listMLineStyles(doc)[0] ?? null;
}

/** 이 스타일을 쓰는 여러 줄 수 */
export function mlineStyleUseCount(doc: CadDocument, s: MLineStyleEntry): number {
  let n = 0;
  for (const b of doc.blocks.values())
    for (const e of b.entities)
      if (e.type === 'MLINE' && ((e.styleHandle && e.styleHandle.toUpperCase() === s.style.handle) || (!e.styleHandle && tableKey(e.styleName) === tableKey(s.name)))) n++;
  return n;
}

/** 요소를 간격이 큰 것부터 정렬한다(AutoCAD와 같다) */
export function sortElements(els: readonly MLineStyleElement[]): MLineStyleElement[] {
  return [...els].sort((a, b) => b.offset - a.offset);
}

/** 스타일 값 검사(문제가 있으면 문구) */
export function validateMLineStyle(s: Pick<MLineStyleObject, 'name' | 'elements' | 'startAngle' | 'endAngle'>): string | null {
  const n = s.name.trim();
  if (!n || /[<>/\\":;?*|,=`\s]/.test(n)) return '이름이 올바르지 않습니다(빈칸·특수 문자 없이).';
  if (!s.elements.length) return '요소가 하나 이상 있어야 합니다.';
  if (s.elements.length > MAX_ELEMENTS) return `요소는 ${MAX_ELEMENTS}개까지입니다.`;
  for (const a of [s.startAngle, s.endAngle]) {
    const d = (a * 180) / Math.PI;
    if (!(d >= 10 - 1e-9 && d <= 170 + 1e-9)) return '마구리 각도는 10°에서 170° 사이여야 합니다.';
  }
  return null;
}

/** 새 스타일(핸들·소유자는 부르는 쪽이 붙인다) */
export function newMLineStyle(name: string, from?: MLineStyleObject): MLineStyleObject {
  return {
    type: 'MLINESTYLE',
    handle: '',
    name,
    flags: from?.flags ?? 0,
    description: from?.description ?? '',
    fillColor: { ...(from?.fillColor ?? { aci: 256 }) },
    startAngle: from?.startAngle ?? Math.PI / 2,
    endAngle: from?.endAngle ?? Math.PI / 2,
    elements: (from?.elements ?? [
      { offset: 0.5, color: { aci: 256 }, linetype: 'BYLAYER' },
      { offset: -0.5, color: { aci: 256 }, linetype: 'BYLAYER' },
    ]).map((e) => ({ offset: e.offset, color: { ...e.color }, linetype: e.linetype })),
  };
}
