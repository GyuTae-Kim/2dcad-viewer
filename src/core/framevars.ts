/**
 * 이미지·가리기 테두리 설정(IMAGEFRAME·WIPEOUTFRAME). 헤더가 아니라 이름 있는 객체 사전의
 * ACAD_IMAGE_VARS(RASTERVARIABLES)·ACAD_WIPEOUT_VARS(WIPEOUTVARIABLES) 객체의 그룹 70에 저장된다.
 * 값: 0 숨김, 1 표시·출력, 2 표시하지만 출력 안 함.
 */
import type { CadDocument, DictionaryObject, GenericObject, RawTag } from './model';
import { normalizeHandle } from './model';

export type FrameKind = 'image' | 'wipeout';

export const FRAME_DICT: Record<FrameKind, string> = { image: 'ACAD_IMAGE_VARS', wipeout: 'ACAD_WIPEOUT_VARS' };
export const FRAME_TYPE: Record<FrameKind, string> = { image: 'RASTERVARIABLES', wipeout: 'WIPEOUTVARIABLES' };
const SUBCLASS: Record<FrameKind, string> = { image: 'AcDbRasterVariables', wipeout: 'AcDbWipeoutVariables' };

function isDict(o: unknown): o is DictionaryObject {
  const t = (o as { type?: string } | undefined)?.type;
  return t === 'DICTIONARY' || t === 'ACDBDICTIONARYWDFLT';
}

export function rootDictionary(doc: CadDocument): DictionaryObject | null {
  const h = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
  const o = h ? doc.objects.get(h) : undefined;
  return isDict(o) ? o : null;
}

/** 테두리 변수 객체(없으면 null) */
export function frameVarObject(doc: CadDocument, kind: FrameKind): GenericObject | null {
  const root = rootDictionary(doc);
  if (root)
    for (const [k, h] of root.entries) {
      if (k.toUpperCase() !== FRAME_DICT[kind]) continue;
      const o = doc.objects.get(normalizeHandle(h));
      if (o?.type === FRAME_TYPE[kind]) return o as GenericObject;
    }
  // 사전에서 못 찾으면 종류로 찾는다
  for (const o of doc.objects.values()) if (o.type === FRAME_TYPE[kind]) return o as GenericObject;
  return null;
}

/** 테두리 설정 값(객체가 없으면 1) */
export function frameSetting(doc: CadDocument, kind: FrameKind): number {
  const v = frameVarObject(doc, kind)?.raw?.find((t) => t.code === 70)?.value;
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? 1 : n;
}

/** 새로 만들 변수 객체의 원시 태그 */
export function frameVarTags(kind: FrameKind, value: number): RawTag[] {
  return kind === 'image'
    ? [
        { code: 100, value: SUBCLASS.image },
        { code: 90, value: 0 },
        { code: 70, value },
        { code: 71, value: 1 },
        { code: 72, value: 0 },
      ]
    : [
        { code: 100, value: SUBCLASS.wipeout },
        { code: 70, value },
      ];
}

/** 원시 태그의 그룹 70을 바꾼 사본 */
export function withFrameValue(raw: RawTag[] | undefined, kind: FrameKind, value: number): RawTag[] {
  if (!raw?.some((t) => t.code === 70)) return frameVarTags(kind, value);
  return raw.map((t) => (t.code === 70 ? { code: 70, value } : t));
}
