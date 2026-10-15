/**
 * 등각투영 설정(SNAPSTYL 스냅 스타일·SNAPISOPAIR 등각평면)의 저장 자리.
 *  - DXF R2000+: VPORT 표 레코드의 77(스냅 스타일 0 표준·1 등각투영)·78(등각평면 0 왼쪽·1 위·2 오른쪽)
 *  - DXF R12: VPORT 표의 77·78과 머리말 $SNAPSTYLE·$SNAPISOPAIR(70)
 *  - DWG: VPORT 객체의 스냅 스타일(B)·등각평면(BS) — ODA 공개 명세의 VPORT 절(격자 간격 다음 스냅 켜기 B, 스냅 스타일 B,
 *    등각평면 BS, 스냅 회전 BD)
 * 모델은 VPortRecord.snapStyle·snapIsoPair(선택 필드, 없으면 0). 레코드에 값이 없으면 *Active 레코드는 머리말 값(R12 DXF에서 읽은 문서)을 쓴다.
 */
import type { CadDocument, VPortRecord } from '../core/model';

export interface VportSnap {
  style: 0 | 1;
  pair: 0 | 1 | 2;
}

const isActive = (v: VPortRecord) => v.name.toUpperCase() === '*ACTIVE';

/** 현재(첫) *Active 뷰포트 레코드 */
export function activeVport(doc: CadDocument): VPortRecord | undefined {
  return doc.vports.find(isActive);
}

const styleOf = (v: unknown): 0 | 1 | undefined => (v === undefined || v === null || v === '' ? undefined : Math.round(Number(v)) === 1 ? 1 : 0);
const pairOf = (v: unknown): 0 | 1 | 2 | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Math.round(Number(v));
  return n === 1 || n === 2 ? n : 0;
};

/** 레코드의 등각 설정(레코드에 없으면 *Active는 머리말 $SNAPSTYLE·$SNAPISOPAIR, 그 밖은 0) */
export function vportSnap(doc: CadDocument, v: VPortRecord | undefined): VportSnap {
  const fromHeader = !v || isActive(v);
  const style = styleOf(v?.snapStyle) ?? (fromHeader ? styleOf(doc.header.get('$SNAPSTYLE')) : undefined) ?? 0;
  const pair = pairOf(v?.snapIsoPair) ?? (fromHeader ? pairOf(doc.header.get('$SNAPISOPAIR')) : undefined) ?? 0;
  return { style, pair };
}
