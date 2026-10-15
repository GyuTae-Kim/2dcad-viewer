/**
 * 도면층 필터 계산: 특성 필터 조건 비교(행 안 AND, 행끼리 OR, 와일드카드), 그룹 필터 목록, 중첩, 기본 필터, 필터 트리.
 *
 * 중첩 규칙(이 앱의 해석):
 * - 특성 필터의 결과 = 부모 필터 결과(맨 위면 모든 도면층) 가운데 조건에 맞는 도면층.
 * - 그룹 필터의 결과 = 그 그룹의 도면층 + 그 아래 그룹 필터들의 결과(자식 그룹은 늘 부모 안에 든다).
 * 와일드카드는 -LAYER와 같은 AutoCAD 규칙(src/edit/util/wildcard): `*`·`?`·`#`·`@`·`.`·`[...]`·`~`·`` ` ``·쉼표 나열.
 */
import type { CadDocument, Layer } from '../../core/model';
import { tableKey } from '../../core/model';
import { wcmatch } from '../util/wildcard';
import { parseLayerColor, parseTrueColor, percentFromOpacity } from '../layercmd';
import { layerPlotStyleName, plotStyleNameMap } from '../layerstate/store';
import { BUILTIN_LABEL, type FilterRow, type LayerFilter, cleanRows, filterKey, findFilter } from './model';
import { type ExprNode, literalToCell, parseFilterExpression } from './expr';

export interface MatchContext {
  /** 객체가 있는 도면층(대문자 키) */
  used: ReadonlySet<string>;
  /** 도면층의 플롯 스타일 이름(색상 종속 도면은 Color_n) */
  plotStyle(l: Layer): string;
}

/** 객체가 있는 도면층(모든 블록 정의·배치, 블록 참조의 속성 포함) */
export function usedLayerKeys(doc: CadDocument): Set<string> {
  const out = new Set<string>();
  for (const b of doc.blocks.values()) {
    for (const e of b.entities) {
      out.add(tableKey(e.layer));
      if (e.type === 'INSERT') for (const a of e.attribs) out.add(tableKey(a.layer));
    }
  }
  return out;
}

/** 비교 문맥. 사용 중인 도면층은 처음 물을 때 센다(상태 조건이나 "사용된 모든 도면층"이 없으면 객체를 돌지 않는다) */
export function matchContext(doc: CadDocument, used?: ReadonlySet<string>): MatchContext {
  const names = plotStyleNameMap(doc);
  let u: ReadonlySet<string> | null = used ?? null;
  return {
    get used() {
      return (u ??= usedLayerKeys(doc));
    },
    plotStyle: (l) => layerPlotStyleName(doc, l, names),
  };
}

// ---------------------------------------------------------------------------
// 조건 비교
// ---------------------------------------------------------------------------

/** 색 값 글(트루컬러면 r,g,b, 아니면 번호) */
export function colorValueText(c: Layer['color']): string {
  if (c.rgb !== undefined) return `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}`;
  return String(Math.abs(c.aci) || 7);
}

function colorMatches(l: Layer, v: string): boolean {
  const tc = parseTrueColor(v);
  if (tc) return l.color.rgb !== undefined && (l.color.rgb & 0xffffff) === tc.rgb;
  if (!v.startsWith('-')) {
    const named = parseLayerColor(v);
    if (named) return l.color.rgb === undefined && (Math.abs(l.color.aci) || 7) === named.color.aci;
  }
  return wcmatch(colorValueText(l.color), v);
}

function numberOr(v: string): number | null {
  return /^-?\d+$/.test(v) ? Number(v) : null;
}

/** 조건 하나(열, 값)가 도면층과 맞는지. 모르는 열은 따지지 않는다(참) */
export function conditionMatches(column: string, value: string, l: Layer, ctx: MatchContext): boolean {
  const v = value.trim();
  if (!v) return true;
  const up = v.toUpperCase();
  switch (column) {
    case 'STATUS':
      return up === 'USED' ? ctx.used.has(tableKey(l.name)) : up === 'UNUSED' ? !ctx.used.has(tableKey(l.name)) : false;
    case 'NAME':
      return wcmatch(l.name, v);
    case 'ON':
      return up === 'ON' ? !l.off : up === 'OFF' ? l.off : false;
    case 'FROZEN':
      return up === 'FROZEN' ? l.frozen : up === 'THAWED' ? !l.frozen : false;
    case 'LOCKED':
      return up === 'LOCKED' ? l.locked : up === 'UNLOCKED' ? !l.locked : false;
    case 'COLOR':
      return colorMatches(l, v);
    case 'LINETYPE':
      return wcmatch(l.linetype || 'Continuous', v);
    case 'LINEWEIGHT': {
      const n = numberOr(v);
      return n !== null ? l.lineweight === n : wcmatch(String(l.lineweight), v);
    }
    case 'TRANSPARENCY': {
      const pct = percentFromOpacity(l.transparency);
      const n = numberOr(v);
      return n !== null ? pct === n : wcmatch(String(pct), v);
    }
    case 'PLOTSTYLE':
      return wcmatch(ctx.plotStyle(l), v);
    case 'PLOT':
      return up === 'PLOT' ? l.plot !== false : up === 'NOPLOT' ? l.plot === false : false;
    case 'NEWVPFROZEN':
      return up === 'FROZEN' ? (l.flags & 2) !== 0 : up === 'THAWED' ? (l.flags & 2) === 0 : false;
    case 'DESCRIPTION':
      return wcmatch(l.description ?? '', v);
    default:
      return true;
  }
}

/** 한 행의 조건이 모두 맞는지(AND) */
export function rowMatches(row: FilterRow, l: Layer, ctx: MatchContext): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && v.trim() && !conditionMatches(k, v, l, ctx)) return false;
  }
  return true;
}

/** 정의가 도면층과 맞는지: 행 가운데 하나라도 맞으면(OR). 조건이 없으면 참 */
export function rowsMatch(rows: readonly FilterRow[], l: Layer, ctx: MatchContext): boolean {
  const list = cleanRows(rows);
  return !list.length || list.some((r) => rowMatches(r, l, ctx));
}

/**
 * AutoCAD 필터 식을 그대로 따진다(이 앱 필터 정의로 바꿀 수 없는 식 — 읽기 전용 필터).
 * 아는 열은 행 조건과 같게 비교하고, 모르는 열(VPOVERRIDES 등)은 따지지 않는다(참). 읽을 수 없는 식은 아무 도면층과도 맞지 않는다.
 */
export function expressionMatcher(text: string): (l: Layer, ctx: MatchContext) => boolean {
  const n = parseFilterExpression(text);
  if (n === 'empty') return () => true;
  if (!n) return () => false;
  const ev = (x: ExprNode, l: Layer, ctx: MatchContext): boolean => {
    switch (x.t) {
      case 'or':
        return x.items.some((i) => ev(i, l, ctx));
      case 'and':
        return x.items.every((i) => ev(i, l, ctx));
      case 'not':
        return !ev(x.item, l, ctx);
      case 'rel': {
        const c = literalToCell(x.name, '==', x.value);
        if (!c) return true;
        const hit = conditionMatches(c[0], c[1], l, ctx);
        return x.op === '==' ? hit : !hit;
      }
    }
  };
  return (l, ctx) => ev(n, l, ctx);
}

// ---------------------------------------------------------------------------
// 필터 결과
// ---------------------------------------------------------------------------

/**
 * 사용자 필터들의 결과를 구한다(대문자 도면층 키). 모르는 이름이면 null.
 * extra는 아직 저장하지 않은 필터(대화상자의 미리보기) — 같은 이름이 있으면 그것을 쓴다.
 */
export class FilterEvaluator {
  private readonly memo = new Map<string, Set<string>>();
  private readonly busy = new Set<string>();
  readonly filters: LayerFilter[];

  constructor(
    readonly doc: CadDocument,
    filters: readonly LayerFilter[],
    readonly ctx: MatchContext = matchContext(doc),
    extra?: LayerFilter,
  ) {
    this.filters = extra ? [...filters.filter((f) => filterKey(f.name) !== filterKey(extra.name)), extra] : [...filters];
  }

  layers(name: string): Set<string> | null {
    const f = findFilter(this.filters, name);
    return f ? this.of(f) : null;
  }

  of(f: LayerFilter): Set<string> {
    const k = filterKey(f.name);
    const m = this.memo.get(k);
    if (m) return m;
    if (this.busy.has(k)) return new Set();
    this.busy.add(k);
    const out = new Set<string>();
    if (f.kind === 'property') {
      const p = findFilter(this.filters, f.parent);
      const base = p ? this.of(p) : null;
      const m = f.expression !== undefined ? expressionMatcher(f.expression) : (l: Layer, ctx: MatchContext) => rowsMatch(f.rows, l, ctx);
      for (const [lk, l] of this.doc.layers) {
        if (base && !base.has(lk)) continue;
        if (m(l, this.ctx)) out.add(lk);
      }
    } else {
      for (const n of f.layers) {
        const lk = tableKey(n);
        if (this.doc.layers.has(lk)) out.add(lk);
      }
      for (const c of this.filters) {
        if (c.kind === 'group' && c.parent && filterKey(c.parent) === k) for (const x of this.of(c)) out.add(x);
      }
    }
    this.busy.delete(k);
    this.memo.set(k, out);
    return out;
  }
}

/** 외부 참조 도면층인지(외부 참조 종속 플래그 또는 이름의 `|`) */
export function isXrefLayer(l: Layer): boolean {
  return (l.flags & 16) !== 0 || l.name.includes('|');
}

/** 외부 참조 도면층의 참조 이름 */
export function xrefNameOf(l: Layer): string {
  const i = l.name.indexOf('|');
  return i > 0 ? l.name.slice(0, i) : l.name;
}

/** 외부 참조 이름들(처음 나온 대소문자, 이름 순) */
export function xrefNames(doc: CadDocument): string[] {
  const m = new Map<string, string>();
  for (const l of doc.layers.values()) {
    if (!isXrefLayer(l)) continue;
    const n = xrefNameOf(l);
    if (!m.has(n.toUpperCase())) m.set(n.toUpperCase(), n);
  }
  return [...m.values()].sort((a, b) => a.localeCompare(b, 'ko'));
}

/**
 * 필터 참조(트리 노드 열쇠): `ALL` 모두, `USED` 사용된 모든 도면층, `XREF` 외부 참조, `XREF:이름` 한 외부 참조,
 * `NONXREF` 모든 비외부 참조 도면층, `U:이름` 사용자 필터.
 */
export const REF_ALL = 'ALL';
export const userRef = (name: string): string => `U:${filterKey(name)}`;
export const isUserRef = (ref: string): boolean => ref.startsWith('U:');

/** 참조의 결과와 이름. 없는 필터면 null */
export function resolveFilterRef(doc: CadDocument, filters: readonly LayerFilter[], ref: string, ctx: MatchContext = matchContext(doc)): { keys: Set<string>; label: string } | null {
  const all = () => new Set(doc.layers.keys());
  const pick = (fn: (l: Layer, k: string) => boolean) => {
    const out = new Set<string>();
    for (const [k, l] of doc.layers) if (fn(l, k)) out.add(k);
    return out;
  };
  if (ref === REF_ALL) return { keys: all(), label: BUILTIN_LABEL.all };
  if (ref === 'USED') return { keys: pick((_l, k) => ctx.used.has(k)), label: BUILTIN_LABEL.used };
  if (ref === 'XREF') return { keys: pick(isXrefLayer), label: BUILTIN_LABEL.xref };
  if (ref === 'NONXREF') return { keys: pick((l) => !isXrefLayer(l)), label: BUILTIN_LABEL.nonxref };
  if (ref.startsWith('XREF:')) {
    const x = ref.slice(5).toUpperCase();
    const keys = pick((l) => isXrefLayer(l) && xrefNameOf(l).toUpperCase() === x);
    if (!keys.size) return null;
    const first = doc.layers.get([...keys][0]!)!;
    return { keys, label: xrefNameOf(first) };
  }
  if (isUserRef(ref)) {
    const f = filters.find((x) => filterKey(x.name) === ref.slice(2));
    if (!f) return null;
    return { keys: new FilterEvaluator(doc, filters, ctx).of(f), label: f.name };
  }
  return null;
}

/** 보일 도면층(반전이면 결과 밖의 도면층) */
export function visibleLayerKeys(doc: CadDocument, keys: ReadonlySet<string>, invert: boolean): Set<string> {
  if (!invert) return new Set(keys);
  const out = new Set<string>();
  for (const k of doc.layers.keys()) if (!keys.has(k)) out.add(k);
  return out;
}

// ---------------------------------------------------------------------------
// 트리
// ---------------------------------------------------------------------------

export type NodeKind = 'all' | 'used' | 'xref' | 'xrefItem' | 'nonxref' | 'property' | 'group';

export interface FilterNode {
  ref: string;
  label: string;
  kind: NodeKind;
  children: FilterNode[];
}

/**
 * 필터 트리: 모두 → [모든 비외부 참조 도면층], 사용된 모든 도면층, [외부 참조 → 참조마다], 사용자 필터(이름 순, 중첩).
 * 부모를 찾을 수 없거나 순환하는 필터는 맨 위에 둔다.
 */
export function filterTree(doc: CadDocument, filters: readonly LayerFilter[]): FilterNode {
  const root: FilterNode = { ref: REF_ALL, label: BUILTIN_LABEL.all, kind: 'all', children: [] };
  const xrefs = xrefNames(doc);
  if (xrefs.length) root.children.push({ ref: 'NONXREF', label: BUILTIN_LABEL.nonxref, kind: 'nonxref', children: [] });
  root.children.push({ ref: 'USED', label: BUILTIN_LABEL.used, kind: 'used', children: [] });
  if (xrefs.length) root.children.push({ ref: 'XREF', label: BUILTIN_LABEL.xref, kind: 'xref', children: xrefs.map((x) => ({ ref: `XREF:${x}`, label: x, kind: 'xrefItem' as const, children: [] })) });
  const placed = new Set<string>();
  const byName = (a: LayerFilter, b: LayerFilter) => a.name.localeCompare(b.name, 'ko');
  const node = (f: LayerFilter, chain: Set<string>): FilterNode => {
    const k = filterKey(f.name);
    placed.add(k);
    const next = new Set(chain).add(k);
    const kids = filters.filter((c) => c.parent && filterKey(c.parent) === k && !next.has(filterKey(c.name)) && !placed.has(filterKey(c.name))).sort(byName);
    return { ref: userRef(f.name), label: f.name, kind: f.kind, children: kids.map((c) => node(c, next)) };
  };
  const tops = filters.filter((f) => !findFilter(filters, f.parent)).sort(byName);
  for (const f of tops) root.children.push(node(f, new Set()));
  // 순환해서 맨 위에 닿지 못한 필터
  for (const f of [...filters].sort(byName)) if (!placed.has(filterKey(f.name))) root.children.push(node(f, new Set()));
  return root;
}

/** 트리에서 노드 찾기 */
export function findNode(root: FilterNode, ref: string): FilterNode | null {
  if (root.ref === ref) return root;
  for (const c of root.children) {
    const r = findNode(c, ref);
    if (r) return r;
  }
  return null;
}
