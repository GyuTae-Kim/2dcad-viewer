/**
 * DXF에서 읽은 AutoCAD 연관 배열을 DWG로 쓸 때 배열 참조에 이 앱의 배열 기록(확장 자료 OPENCAD_ARRAY —
 * src/edit/assocarray/record.ts)도 붙여 쓴다. 연관 객체(ACDBASSOCNETWORK·ACDBASSOCACTION·ACDBASSOCARRAYACTIONBODY …)는
 * 이제 DWG로 쓰지만(../assoccodec.ts), 동작 하나에 쓸 수 없는 부분이 있으면 그 동작이 통째로 빠진다(곡선 캐시에 호·NURBS·복합 곡선이
 * 든 경로 배열 등). 그때도 DWG를 다시 열면 이 앱의 연관 배열로 남게 하는 대비책이다.
 * 문서는 고치지 않는다(DXF로 저장하면 AutoCAD 기록만 그대로 쓴다). 이미 이 앱 기록이 있으면(고친 배열) 그대로 둔다.
 */
import type { CadDocument, InsertEntity, XData } from '../../../core/model';
import { readArray } from '../../../edit/assocarray/read';
import { encodeRecord, recordOf, withRecord } from '../../../edit/assocarray/record';

/** 문서에 DXF 원본 태그의 AutoCAD 배열 몸체가 있는지(없으면 배열 참조를 하나하나 보지 않는다) */
export function hasAcadArrays(doc: CadDocument): boolean {
  for (const o of doc.objects.values()) if (o.type === 'ACDBASSOCARRAYACTIONBODY' && (o as { raw?: unknown[] }).raw?.length) return true;
  return false;
}

/** DWG에 쓸 배열 참조의 확장 자료(이 앱 기록을 붙인 것). 붙일 것이 없으면 null */
export function arrayRecordXData(doc: CadDocument, e: InsertEntity): XData[] | null {
  if (!e.reactors?.length || recordOf(e.xdata)) return null;
  let info;
  try {
    info = readArray(doc, e);
  } catch {
    return null;
  }
  // 원본 태그로 읽은 AutoCAD 배열만(DWG에서 읽은 배열의 연관 객체는 원본 비트로 그대로 쓴다)
  if (!info || info.origin !== 'acad' || !info.acad?.raw) return null;
  return withRecord(e.xdata, encodeRecord(doc, info.state)) ?? null;
}
