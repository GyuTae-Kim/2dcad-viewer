/**
 * 도면층 필터(도면층 특성 관리자의 필터 트리) 모델: 특성 필터·그룹 필터, 필터 정의 열, 이름 규칙, 중첩 규칙.
 *
 * - 특성 필터: 필터 정의의 행들. 한 행 안의 조건은 모두 맞아야 하고(AND), 행끼리는 하나만 맞으면 된다(OR).
 *   빈 칸은 "상관없음"이다. 조건이 하나도 없으면 모든 도면층이 맞는다.
 * - 그룹 필터: 고른 도면층 목록(이름·특성과 상관없이).
 * - 중첩: 특성 필터 아래에는 특성 필터만, 그룹 필터 아래에는 특성·그룹 필터를 둘 수 있다(AutoCAD 도움말의 규칙).
 */

export type FilterKind = 'property' | 'group';

/** 필터 정의 열(파일에 적는 열쇠) */
export type FilterColumn = 'STATUS' | 'NAME' | 'ON' | 'FROZEN' | 'LOCKED' | 'COLOR' | 'LINETYPE' | 'LINEWEIGHT' | 'TRANSPARENCY' | 'PLOTSTYLE' | 'PLOT' | 'NEWVPFROZEN' | 'DESCRIPTION';

export interface ColumnChoice {
  /** 파일에 적는 값 */
  value: string;
  label: string;
}

export interface ColumnDef {
  key: FilterColumn;
  label: string;
  /** choice = 고르기, pattern = 와일드카드 글, color·lineweight·transparency = 값(또는 와일드카드) */
  kind: 'choice' | 'pattern' | 'color' | 'lineweight' | 'transparency';
  choices?: readonly ColumnChoice[];
}

/** 도면층 필터 특성 대화상자의 필터 정의 열(AutoCAD 순서) */
export const FILTER_COLUMNS: readonly ColumnDef[] = [
  {
    key: 'STATUS',
    label: '상태',
    kind: 'choice',
    choices: [
      { value: 'USED', label: '사용 중' },
      { value: 'UNUSED', label: '사용 안 함' },
    ],
  },
  { key: 'NAME', label: '이름', kind: 'pattern' },
  {
    key: 'ON',
    label: '켜기',
    kind: 'choice',
    choices: [
      { value: 'ON', label: '켜기' },
      { value: 'OFF', label: '끄기' },
    ],
  },
  {
    key: 'FROZEN',
    label: '동결',
    kind: 'choice',
    choices: [
      { value: 'FROZEN', label: '동결' },
      { value: 'THAWED', label: '동결 해제' },
    ],
  },
  {
    key: 'LOCKED',
    label: '잠금',
    kind: 'choice',
    choices: [
      { value: 'LOCKED', label: '잠금' },
      { value: 'UNLOCKED', label: '잠금 해제' },
    ],
  },
  { key: 'COLOR', label: '색상', kind: 'color' },
  { key: 'LINETYPE', label: '선종류', kind: 'pattern' },
  { key: 'LINEWEIGHT', label: '선가중치', kind: 'lineweight' },
  { key: 'TRANSPARENCY', label: '투명도', kind: 'transparency' },
  { key: 'PLOTSTYLE', label: '플롯 스타일', kind: 'pattern' },
  {
    key: 'PLOT',
    label: '플롯',
    kind: 'choice',
    choices: [
      { value: 'PLOT', label: '플롯' },
      { value: 'NOPLOT', label: '플롯 안 함' },
    ],
  },
  {
    key: 'NEWVPFROZEN',
    label: '새 VP 동결',
    kind: 'choice',
    choices: [
      { value: 'FROZEN', label: '동결' },
      { value: 'THAWED', label: '동결 해제' },
    ],
  },
  { key: 'DESCRIPTION', label: '설명', kind: 'pattern' },
];

export const COLUMN_BY_KEY: ReadonlyMap<string, ColumnDef> = new Map(FILTER_COLUMNS.map((c) => [c.key, c]));

/** 필터 정의 한 행: 열 → 조건(없거나 빈 글이면 상관없음). 모르는 열 열쇠도 그대로 둔다(다시 쓴다) */
export type FilterRow = Partial<Record<FilterColumn, string>> & Record<string, string | undefined>;

export interface LayerFilter {
  /** 필터 이름(원래 대소문자) */
  name: string;
  kind: FilterKind;
  /** 부모 필터 이름(맨 위면 null) */
  parent: string | null;
  /** 특성 필터의 정의 행 */
  rows: FilterRow[];
  /** 그룹 필터의 도면층 이름(원래 대소문자, 도면에 있는 것만) */
  layers: string[];
}

/** 조건이 있는 열만 남긴 행(빈 행이면 null) */
export function cleanRow(row: FilterRow): FilterRow | null {
  const out: FilterRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** 빈 행을 뺀 정의 */
export function cleanRows(rows: readonly FilterRow[]): FilterRow[] {
  const out: FilterRow[] = [];
  for (const r of rows) {
    const c = cleanRow(r);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 기본 필터와 이름
// ---------------------------------------------------------------------------

export const BUILTIN_LABEL = {
  all: '모두',
  used: '사용된 모든 도면층',
  xref: '외부 참조',
  nonxref: '모든 비외부 참조 도면층',
} as const;

/** 사용자 필터에 쓸 수 없는 이름(기본 필터 이름, 한국어판·영어판) */
const RESERVED = new Set(['모두', '사용된 모든 도면층', '외부 참조', '모든 비외부 참조 도면층', 'ALL', 'ALL USED LAYERS', 'XREF', 'ALL NON-XREF LAYERS']);

/** 쓸 수 없는 필터 이름 문자(도면층 이름과 같은 규칙) */
const BAD = /[<>/\\":;?*|,=`]/;

export const filterKey = (name: string): string => name.trim().toUpperCase();

/** 필터 이름 검사(문제가 없으면 null). others = 다른 필터 이름들(자기 자신 제외) */
export function filterNameProblem(name: string, others: Iterable<string> = []): string | null {
  const n = name.trim();
  if (!n) return '필터 이름이 비어 있습니다.';
  if (n.length > 255) return '필터 이름이 너무 깁니다.';
  if (BAD.test(n)) return '필터 이름에 < > / \\ " : ; ? * | , = ` 문자는 쓸 수 없습니다.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(n)) return '필터 이름에 제어 문자는 쓸 수 없습니다.';
  if (RESERVED.has(filterKey(n))) return `"${n}"은(는) 기본 필터 이름이라 쓸 수 없습니다.`;
  const k = filterKey(n);
  for (const o of others) if (filterKey(o) === k) return `필터 "${n}"이(가) 이미 있습니다.`;
  return null;
}

/** 새 필터 기본 이름(특성 필터1, 그룹 필터1 …) */
export function defaultFilterName(kind: FilterKind, existing: Iterable<string>): string {
  const used = new Set([...existing].map(filterKey));
  const base = kind === 'property' ? '특성 필터' : '그룹 필터';
  for (let i = 1; ; i++) {
    const n = `${base}${i}`;
    if (!used.has(filterKey(n))) return n;
  }
}

/** parentKind 아래에 childKind 필터를 둘 수 있는지 */
export function canNest(parentKind: FilterKind, childKind: FilterKind): boolean {
  return parentKind === 'group' || childKind === 'property';
}

/** 필터 하나를 찾는다(대소문자 무시) */
export function findFilter(filters: readonly LayerFilter[], name: string | null | undefined): LayerFilter | null {
  if (!name) return null;
  const k = filterKey(name);
  return filters.find((f) => filterKey(f.name) === k) ?? null;
}

/** 필터의 자손(자식·손자 …) 이름. 순환 자료는 한 번만 */
export function descendantsOf(filters: readonly LayerFilter[], name: string): LayerFilter[] {
  const out: LayerFilter[] = [];
  const seen = new Set<string>([filterKey(name)]);
  const walk = (k: string) => {
    for (const f of filters) {
      const fk = filterKey(f.name);
      if (f.parent && filterKey(f.parent) === k && !seen.has(fk)) {
        seen.add(fk);
        out.push(f);
        walk(fk);
      }
    }
  };
  walk(filterKey(name));
  return out;
}

/** 부모 줄(가까운 것부터). 순환이면 거기서 멈춘다 */
export function ancestorsOf(filters: readonly LayerFilter[], f: LayerFilter): LayerFilter[] {
  const out: LayerFilter[] = [];
  const seen = new Set<string>([filterKey(f.name)]);
  let cur = findFilter(filters, f.parent);
  while (cur && !seen.has(filterKey(cur.name))) {
    seen.add(filterKey(cur.name));
    out.push(cur);
    cur = findFilter(filters, cur.parent);
  }
  return out;
}

/** 특성 필터를 그룹 필터로 바꿀 수 있는지(특성 필터 아래의 특성 필터는 그룹 필터가 될 수 없다) */
export function canConvertToGroup(filters: readonly LayerFilter[], f: LayerFilter): boolean {
  if (f.kind !== 'property') return false;
  const p = findFilter(filters, f.parent);
  return !p || p.kind === 'group';
}
