/**
 * 도면에 저장되는 변수: AcDbVariableDictionary의 DICTIONARYVAR(CANNOSCALE 등)와
 * 이 프로그램의 자체 기록(탭마다 ANNOALLVISIBLE).
 *
 * DICTIONARYVAR 원시 태그: DXF는 `100 DictionaryVariables`, `280 0`, `1 값`. DWG 리더는 `280`·`1`만 남긴다.
 * 어느 쪽이든 1의 값만 바꾸고 나머지 태그는 그대로 둔다.
 */
import type { CadDocument, DictionaryObject, GenericObject, LayoutObject, RawTag, XData } from '../../core/model';
import type { EditOp } from '../session';
import { type AnnoScale, changed, dictOf, ensureRootDict, entryOf, findScale, pendingObject, rootEntry, scaleList, setDictEntries, unitScale, upper } from './scales';

export const VAR_DICT = 'AcDbVariableDictionary';

/** 변수 사전의 DICTIONARYVAR */
export function dictVarObject(doc: CadDocument, name: string): GenericObject | null {
  const h = entryOf(rootEntry(doc, VAR_DICT), name);
  const o = h ? doc.objects.get(h) : undefined;
  return o && o.type === 'DICTIONARYVAR' ? (o as GenericObject) : null;
}

/** DICTIONARYVAR 값(1). 없으면 undefined */
export function readDictVar(doc: CadDocument, name: string): string | undefined {
  const o = dictVarObject(doc, name);
  const t = o?.raw?.find((r) => r.code === 1);
  return t === undefined ? undefined : String(t.value);
}

/**
 * DICTIONARYVAR를 이 값으로 바꾸는 편집. 변수가 없으면(사전도 없으면 사전부터) 만든다.
 * 이미 같은 값이면 빈 배열.
 */
export function dictVarOps(doc: CadDocument, name: string, value: string, alloc: () => string, ops: EditOp[] = []): EditOp[] {
  const cur = dictVarObject(doc, name);
  if (cur) {
    const raw: RawTag[] = (cur.raw ?? []).map((t) => (t.code === 1 ? { code: 1, value } : t));
    if (!raw.some((t) => t.code === 1)) raw.push({ code: 1, value });
    if (readDictVar(doc, name) === value) return ops;
    ops.push({ kind: 'object', key: upper(cur.handle), before: cur, after: changed(cur, { raw }) });
    return ops;
  }
  const dict = ensureRootDict(doc, VAR_DICT, alloc, ops);
  if (!dict) return ops;
  const h = alloc();
  const v: GenericObject = {
    type: 'DICTIONARYVAR',
    handle: h,
    owner: dict.handle,
    reactors: [dict.handle],
    raw: [
      { code: 100, value: 'DictionaryVariables' },
      { code: 280, value: 0 },
      { code: 1, value },
    ],
  };
  ops.push({ kind: 'object', key: h, before: null, after: v });
  const base = pendingObject<DictionaryObject>(doc, ops, dict.handle) ?? dict;
  setDictEntries(doc, ops, base, [...base.entries, [name, h]]);
  return ops;
}

/** CANNOSCALE 이름(변수가 없으면 1:1) */
export function cannoscaleName(doc: CadDocument): string {
  return readDictVar(doc, 'CANNOSCALE') ?? '1:1';
}

/** 현재 주석 축척(리스트에서 찾고, 없으면 1:1, 그것도 없으면 첫 축척) */
export function currentScale(doc: CadDocument, list: readonly AnnoScale[] = scaleList(doc)): AnnoScale | undefined {
  return findScale(list, cannoscaleName(doc)) ?? unitScale(list) ?? list[0];
}

// ---------------------------------------------------------------------------
// ANNOALLVISIBLE(탭마다, 자체 기록): LAYOUT 객체 XDATA `1001 OPENCAD_ANNOALLVISIBLE`, `1070 1`(판), `1070 0`.
// AutoCAD가 이 값을 도면 어디에 두는지 실물이 없어 0일 때만 쓰고 1이면 기록을 지운다.
// ---------------------------------------------------------------------------

export const ALLVIS_APP = 'OPENCAD_ANNOALLVISIBLE';

/** 배치 블록 이름(대문자 키)의 LAYOUT 객체 */
export function layoutObjectOf(doc: CadDocument, space: string): LayoutObject | null {
  const key = space.toUpperCase();
  const lay = doc.layouts.find((l) => l.blockName.toUpperCase() === key);
  if (!lay) return null;
  const o = doc.objects.get(upper(lay.handle));
  return o && o.type === 'LAYOUT' ? (o as LayoutObject) : null;
}

/** 탭의 ANNOALLVISIBLE(기본 1) */
export function allVisible(doc: CadDocument, space: string): boolean {
  const o = layoutObjectOf(doc, space);
  const x = o?.xdata?.find((d) => d.app.toUpperCase() === ALLVIS_APP);
  if (!x) return true;
  const ints = x.items.filter((i) => i.code === 1070).map((i) => Number(i.value));
  return ints[1] !== 0;
}

/** 탭의 ANNOALLVISIBLE을 바꾸는 편집(LAYOUT 객체가 없으면 빈 배열) */
export function allVisibleOps(doc: CadDocument, space: string, on: boolean): EditOp[] {
  const o = layoutObjectOf(doc, space);
  if (!o || allVisible(doc, space) === on) return [];
  const rest: XData[] = (o.xdata ?? []).filter((d) => d.app.toUpperCase() !== ALLVIS_APP);
  if (!on)
    rest.push({
      app: ALLVIS_APP,
      items: [
        { code: 1070, value: 1 },
        { code: 1070, value: 0 },
      ],
    });
  const after = changed(o, { xdata: rest.length ? rest : undefined });
  return [{ kind: 'object', key: upper(o.handle), before: o, after }];
}

/** 변수 사전이 이 핸들의 DICTIONARYVAR를 가지는지(편집 판별용) */
export function isVarObject(doc: CadDocument, handle: string): boolean {
  const d = dictOf(doc, entryOf(dictOf(doc, doc.rootDictionary), VAR_DICT));
  if (!d) return false;
  const h = upper(handle);
  for (const v of d.entries.values()) if (upper(v) === h) return true;
  return false;
}
