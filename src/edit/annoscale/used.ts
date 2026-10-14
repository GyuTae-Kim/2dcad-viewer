/**
 * 쓰이는 축척: 지울 수 없는 축척을 가린다.
 * - 컨텍스트 레코드의 340, 뷰포트 `ASDK_XREC_ANNOTATION_SCALE_INFO`의 340, 도면층 상태 `AcadLayerStateAnnoScale`의 330
 * - 이 프로그램의 자체 기록(OPENCAD_ANNOSCALE)이 이름으로 가리키는 축척
 */
import type { CadDocument, DictionaryObject, GenericObject, XRecordObject } from '../../core/model';
import { recordKind } from './context';
import { type AnnoScale, upper } from './scales';
import { ownRecord } from './xdata';

/** 쓰이는 SCALE 핸들(대문자)과 자체 기록의 이름(대문자) */
export function usedScales(doc: CadDocument): { handles: Set<string>; names: Set<string> } {
  const handles = new Set<string>();
  const names = new Set<string>();
  const xrecKeys = new Map<string, string>();
  for (const o of doc.objects.values()) {
    if (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') {
      for (const [k, h] of (o as DictionaryObject).entries) {
        const ku = k.toUpperCase();
        if (ku === 'ASDK_XREC_ANNOTATION_SCALE_INFO' || ku === 'ACADLAYERSTATEANNOSCALE') xrecKeys.set(upper(h), ku);
      }
      continue;
    }
    if (recordKind(o.type)) {
      const t = (o as GenericObject).raw?.find((r) => r.code === 340);
      if (t) handles.add(upper(String(t.value)));
    }
  }
  for (const [h, k] of xrecKeys) {
    const x = doc.objects.get(h);
    if (!x || x.type !== 'XRECORD') continue;
    const code = k === 'ASDK_XREC_ANNOTATION_SCALE_INFO' ? 340 : 330;
    const t = (x as XRecordObject).data.find((r) => r.code === code);
    if (t) handles.add(upper(String(t.value)));
  }
  for (const e of doc.entityIndex.values()) {
    const own = e.xdata ? ownRecord(e.xdata) : null;
    if (own) for (const n of own.scales) names.add(n.toUpperCase());
  }
  return { handles, names };
}

/** 축척이 쓰이는지 */
export function isUsed(used: ReturnType<typeof usedScales>, s: AnnoScale): boolean {
  return (!!s.handle && used.handles.has(upper(s.handle))) || used.names.has(s.name.toUpperCase());
}
