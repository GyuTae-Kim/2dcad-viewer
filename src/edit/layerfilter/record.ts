/**
 * 도면층 필터 레코드: 이 앱의 XRECORD 태그와 필터 모델 사이의 변환.
 *
 * AutoCAD는 도면층 필터를 LAYER 표 확장 사전의 `ACLYDICTIONARY`(예전 판은 `ACAD_LAYERFILTERS`)에 두지만, 그 레코드
 * 형식을 확인할 실물(표본 도면의 ACLYDICTIONARY는 모두 비어 있다)도 공개 문서도 없어 이 앱의 기록으로 저장한다.
 * 같은 확장 사전 아래 `OPENCAD_LAYERFILTERS` 사전 → 필터 이름마다 XRECORD(AutoCAD는 읽지 않고 그대로 둔다):
 *   1 `OPENCAD_LAYERFILTER`(표지), 70 형식 번호(1), 90 종류(1 특성 필터, 2 그룹 필터), 300 필터 이름,
 *   340 부모 필터 XRECORD 핸들(중첩일 때만),
 *   특성 필터: 행마다 92 행 번호, 그 뒤 조건마다 301 열 열쇠(NAME·COLOR …) + 302 값,
 *   그룹 필터: 도면층마다 330 도면층 핸들(핸들이 없는 도면층이면 8 이름).
 * 모르는 태그는 뒤에 그대로 다시 쓴다.
 */
import type { RawTag } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';
import { FILTER_COLUMNS, type FilterKind, type FilterRow, type LayerFilter, cleanRows } from './model';

export const FILTER_MARK = 'OPENCAD_LAYERFILTER';
export const FILTER_FORMAT = 1;
export const KIND_PROPERTY = 1;
export const KIND_GROUP = 2;

const str = (v: string | number | undefined): string => (v === undefined ? '' : decodeCadEscapes(String(v)));
const num = (v: string | number | undefined): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};
const handleText = (v: string | number | undefined): string => str(v).trim().toUpperCase();

export interface FilterRecordResolver {
  /** 도면층 핸들 → 이름(없으면 null) */
  layer(handle: string): string | null;
}

export interface ParsedFilterRecord {
  filter: LayerFilter;
  /** 340 부모 XRECORD 핸들 */
  parentHandle: string | null;
  /** 이름으로 풀지 못한 도면층 핸들(지운 도면층) */
  unresolved: string[];
  /** 모르는 태그 */
  extra: RawTag[];
}

/** 이 앱의 필터 레코드인지(1 표지) */
export function isFilterRecord(tags: readonly RawTag[]): boolean {
  return tags.some((t) => t.code === 1 && str(t.value) === FILTER_MARK);
}

/** XRECORD 자료 → 필터. 이 앱 레코드가 아니면 null. 이름이 없으면 fallbackName */
export function parseFilterTags(tags: readonly RawTag[], fallbackName: string, r: FilterRecordResolver): ParsedFilterRecord | null {
  if (!isFilterRecord(tags)) return null;
  let kind: FilterKind = 'property';
  let name = '';
  let parentHandle: string | null = null;
  const rows: FilterRow[] = [];
  const layers: string[] = [];
  const unresolved: string[] = [];
  const extra: RawTag[] = [];
  let row: FilterRow | null = null;
  let col: string | null = null;
  let markSeen = false;
  for (const t of tags) {
    switch (t.code) {
      case 1:
        if (!markSeen && str(t.value) === FILTER_MARK) markSeen = true;
        else extra.push({ code: t.code, value: t.value });
        break;
      case 70:
        break;
      case 90:
        kind = num(t.value) === KIND_GROUP ? 'group' : 'property';
        break;
      case 300:
        name = str(t.value);
        break;
      case 340: {
        const h = handleText(t.value);
        parentHandle = h && h !== '0' ? h : null;
        break;
      }
      case 92:
        row = {};
        rows.push(row);
        col = null;
        break;
      case 301:
        col = str(t.value).trim().toUpperCase();
        break;
      case 302:
        if (col) {
          if (!row) {
            row = {};
            rows.push(row);
          }
          row[col] = str(t.value);
          col = null;
        }
        break;
      case 330: {
        const h = handleText(t.value);
        if (!h || h === '0') break;
        const n = r.layer(h);
        if (n) layers.push(n);
        else unresolved.push(h);
        break;
      }
      case 8: {
        const n = str(t.value);
        if (n) layers.push(n);
        break;
      }
      default:
        extra.push({ code: t.code, value: t.value });
    }
  }
  const seen = new Set<string>();
  const uniq = layers.filter((n) => {
    const k = n.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    filter: { name: name || fallbackName, kind, parent: null, rows: kind === 'property' ? cleanRows(rows) : [], layers: kind === 'group' ? uniq : [] },
    parentHandle,
    unresolved,
    extra,
  };
}

export interface FilterRecordNamer {
  /** 도면층 이름 → 핸들(없으면 null — 이름 8로 적는다. 도면에 없는 도면층이면 undefined로 빼게 한다) */
  layer(name: string): string | null | undefined;
}

/** 필터 → XRECORD 자료(280 복제 플래그 뒤) */
export function filterRecordTags(f: LayerFilter, parentHandle: string | null, n: FilterRecordNamer, extra: readonly RawTag[] = []): RawTag[] {
  const out: RawTag[] = [
    { code: 1, value: FILTER_MARK },
    { code: 70, value: FILTER_FORMAT },
    { code: 90, value: f.kind === 'group' ? KIND_GROUP : KIND_PROPERTY },
    { code: 300, value: f.name },
  ];
  if (parentHandle) out.push({ code: 340, value: parentHandle });
  if (f.kind === 'property') {
    const order = FILTER_COLUMNS.map((c) => c.key as string);
    cleanRows(f.rows).forEach((row, i) => {
      out.push({ code: 92, value: i });
      const keys = Object.keys(row).sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      for (const k of keys) {
        out.push({ code: 301, value: k });
        out.push({ code: 302, value: row[k]! });
      }
    });
  } else {
    const seen = new Set<string>();
    for (const name of f.layers) {
      const k = name.toUpperCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const h = n.layer(name);
      if (h === undefined) continue;
      out.push(h ? { code: 330, value: h } : { code: 8, value: name });
    }
  }
  out.push(...extra);
  return out;
}

/** 부모 핸들(340) */
export function parentHandleOf(tags: readonly RawTag[]): string | null {
  const t = tags.find((x) => x.code === 340);
  const h = t ? handleText(t.value) : '';
  return h && h !== '0' ? h : null;
}
