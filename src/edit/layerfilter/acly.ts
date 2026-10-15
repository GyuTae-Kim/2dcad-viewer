/**
 * AutoCAD 도면층 필터 레코드(ACLYDICTIONARY의 XRECORD) 읽기·쓰기.
 *
 * 실물(공개 DWG·DXF 여러 벌, AutoCAD 2013~2025 저장본)로 확인한 배치:
 *   LAYER 표 머리 확장 사전 → `ACLYDICTIONARY`(DICTIONARY, 280 0·281 1, 항목 이름 `*A1`·`*A2`…)
 *     → XRECORD(280 1): [290 1] 1 `AcLyLayerFilter` 90 1 300 이름 301 필터 식
 *                     또는 [290 1] 1 `AcLyLayerGroup` 90 1 300 이름 330 도면층 핸들…
 *   - 290 1은 필터 하나에만 붙는다(지금 고른 필터로 보인다). ACLYDICTIONARY의 확장 자료 ACAD 1000 `<All`·`<AllUsed`·
 *     `<AllXrefOverrides`는 기본 필터 이름으로 보인다. 둘 다 뜻을 확정하지 못해 읽기만 하고 그대로 둔다.
 *   - 그룹의 330에는 빈 핸들이 섞일 수 있다(실물) — 그대로 둔다.
 * 중첩 필터: 부모 XRECORD의 확장 사전 → `ACLYDICTIONARY` → 자식 XRECORD들(같은 꼴). 공개 토론 글의 설명을 따른 것으로,
 *   중첩이 든 실물은 찾지 못했다.
 * 예전 AutoCAD 필터 사전(`ACAD_LAYERFILTERS`, 2005 이전 형식)은 AutoCAD가 단순한 특성 필터를 거울처럼 함께 쓴다 —
 *   이 앱은 읽지 않고, 고치거나 지운 필터와 이름이 같은 항목만 지운다(store.ts).
 */
import type { RawTag } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';

export const ACLY_DICT = 'ACLYDICTIONARY';
export const ACLY_FILTER_CLASS = 'AcLyLayerFilter';
export const ACLY_GROUP_CLASS = 'AcLyLayerGroup';
/** 예전 AutoCAD 필터 사전 */
export const ACAD_LEGACY_FILTERS = 'ACAD_LAYERFILTERS';

export interface AclyRecord {
  kind: 'property' | 'group';
  name: string;
  /** 특성 필터의 식(301). 그룹이면 null */
  expression: string | null;
  /** 그룹의 도면층 핸들(330, 파일에 적힌 대로 — 빈 핸들 포함) */
  layerHandles: string[];
  /** 90 값 */
  version: number;
  /** 종류 표지 앞의 태그(290 등) */
  lead: RawTag[];
  /** 모르는 태그(뒤에 다시 쓴다) */
  tail: RawTag[];
}

const str = (v: string | number | undefined): string => (v === undefined ? '' : decodeCadEscapes(String(v)));
const num = (v: string | number | undefined): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** AutoCAD 필터 레코드인지(1 AcLyLayerFilter·AcLyLayerGroup) */
export function aclyClassOf(tags: readonly RawTag[]): 'property' | 'group' | null {
  for (const t of tags) {
    if (t.code !== 1) continue;
    const v = str(t.value).trim();
    if (v === ACLY_FILTER_CLASS) return 'property';
    if (v === ACLY_GROUP_CLASS) return 'group';
    return null;
  }
  return null;
}

/** XRECORD 자료 → 필터 레코드(AutoCAD 필터가 아니면 null) */
export function parseAclyTags(tags: readonly RawTag[]): AclyRecord | null {
  const kind = aclyClassOf(tags);
  if (!kind) return null;
  const r: AclyRecord = { kind, name: '', expression: null, layerHandles: [], version: 1, lead: [], tail: [] };
  let seenClass = false;
  let seenName = false;
  let seenVersion = false;
  for (const t of tags) {
    const tag = { code: t.code, value: t.value };
    if (!seenClass) {
      if (t.code === 1) seenClass = true;
      else r.lead.push(tag);
      continue;
    }
    if (t.code === 90 && !seenVersion) {
      seenVersion = true;
      r.version = num(t.value) || 1;
    } else if (t.code === 300 && !seenName) {
      seenName = true;
      r.name = str(t.value);
    } else if (t.code === 301 && kind === 'property' && r.expression === null) {
      r.expression = str(t.value);
    } else if (t.code === 330 && kind === 'group') {
      r.layerHandles.push(str(t.value).trim().toUpperCase());
    } else r.tail.push(tag);
  }
  if (kind === 'property' && r.expression === null) r.expression = '';
  return r;
}

/** 필터 레코드 → XRECORD 자료(280 복제 플래그 뒤) */
export function aclyTags(r: AclyRecord): RawTag[] {
  const out: RawTag[] = [...r.lead.map((t) => ({ ...t })), { code: 1, value: r.kind === 'group' ? ACLY_GROUP_CLASS : ACLY_FILTER_CLASS }, { code: 90, value: r.version || 1 }, { code: 300, value: r.name }];
  if (r.kind === 'property') out.push({ code: 301, value: r.expression ?? '' });
  else for (const h of r.layerHandles) out.push({ code: 330, value: h });
  out.push(...r.tail.map((t) => ({ ...t })));
  return out;
}

/** 새 항목 이름: 사전에서 쓰지 않은 가장 작은 `*An` */
export function nextAnonymousKey(keys: Iterable<string>): string {
  const used = new Set<number>();
  for (const k of keys) {
    const m = /^\*A(\d+)$/i.exec(k);
    if (m) used.add(Number(m[1]));
  }
  for (let i = 1; ; i++) if (!used.has(i)) return `*A${i}`;
}
