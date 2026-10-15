/**
 * AutoCAD 도면층 필터 식(AcLyLayerFilter의 filterExpression, XRECORD 301)과 이 앱의 필터 정의 행 사이의 변환.
 *
 * 실물(공개 DWG·DXF)과 Autodesk 공개 문서로 확인한 꼴:
 * - 대화상자가 만든 식: `NAME=="A-*"`, `COLOR=="1"`, 여러 열이면 `A=="x" AND B=="y"`(ADN 블로그의 대화상자 예:
 *   `USED=="TRUE" AND VPOVERRIDES=="FALSE" AND NAME=="A*" AND OFF=="False" AND FROZEN=="True" AND LOCKED=="True"
 *   AND COLOR=="10" AND LINETYPE=="DASHED" AND LINEWEIGHT=="0.18" AND PLOTTABLE=="True" AND NEWVPFROZEN=="True"`).
 * - 예전 필터(ACAD_LAYERFILTERS)를 옮긴 식: `( NAME== "A_ANNO*" or NAME== "A_AREA*" )`, `( NAME== "Xref_*" ) and FROZEN == "FALSE"`.
 * - 조건이 없는 특성 필터: `""""`.
 * - ObjectARX 문법: or·and, `==`·`!=`, 값은 와일드카드(`*`·`?`·`~`·`@`·`.`·`,`·`-`).
 * 이 모듈은 키워드(and·or·not)와 참·거짓 값을 대소문자 구분 없이 읽고, 괄호·따옴표 없는 값도 받는다(NOT은 문법에 없지만 받아 둔다).
 *
 * 행 ↔ 식: 행끼리 OR, 행 안 AND(이 앱 필터 정의와 같다). 식은 OR·AND 정규형으로 펼쳐 행으로 바꾼다.
 * 쓸 때 열 이름은 확인한 것만 쓴다: USED(상태)·NAME·OFF(켜기)·FROZEN·LOCKED·COLOR(ACI 번호)·LINETYPE·LINEWEIGHT(mm)·
 * PLOTTABLE(플롯)·NEWVPFROZEN. 투명도·플롯 스타일·설명·트루컬러·기본 선가중치는 AutoCAD가 쓰는 이름·값을 확인하지 못해
 * 식으로 쓰지 않는다(rowsToExpression → null — 그 필터는 이 앱 기록으로 남긴다). 읽을 때는 TRANSPARENCY·PLOTSTYLENAME(PLOTSTYLE)·
 * DESCRIPTION을 추측한 이름으로 받아 들인다.
 */
import { cleanRows, type FilterRow } from './model';

export type ExprNode =
  | { t: 'or'; items: ExprNode[] }
  | { t: 'and'; items: ExprNode[] }
  | { t: 'not'; item: ExprNode }
  | { t: 'rel'; name: string; op: '==' | '!='; value: string };

/** 조건이 없는 특성 필터의 식(AutoCAD가 쓴 그대로) */
export const EMPTY_EXPRESSION = '""""';

/** 조건이 없는 식인지(빈 글이거나 따옴표만) */
export function isEmptyExpression(text: string): boolean {
  return text.replace(/["\s]/g, '') === '';
}

type Tok = { k: 'lp' | 'rp' | 'op' | 'str' | 'word'; v: string };

function tokenize(text: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      out.push({ k: c === '(' ? 'lp' : 'rp', v: c });
      i++;
    } else if ((c === '=' || c === '!') && text[i + 1] === '=') {
      out.push({ k: 'op', v: c === '=' ? '==' : '!=' });
      i += 2;
    } else if (c === '"') {
      const j = text.indexOf('"', i + 1);
      if (j < 0) return null;
      out.push({ k: 'str', v: text.slice(i + 1, j) });
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s()"]/.test(text[j]!) && !((text[j] === '=' || text[j] === '!') && text[j + 1] === '=')) j++;
      if (j === i) return null;
      out.push({ k: 'word', v: text.slice(i, j) });
      i = j;
    }
  }
  return out;
}

const kw = (t: Tok | undefined, w: string) => !!t && t.k === 'word' && t.v.toUpperCase() === w;

/** 식 → 구문 나무. 조건이 없는 식이면 'empty', 읽을 수 없으면 null */
export function parseFilterExpression(text: string): ExprNode | 'empty' | null {
  if (isEmptyExpression(text)) return 'empty';
  const toks = tokenize(text);
  if (!toks) return null;
  let p = 0;
  const or = (): ExprNode | null => {
    const items: ExprNode[] = [];
    for (;;) {
      const a = and();
      if (!a) return null;
      items.push(a);
      if (!kw(toks[p], 'OR')) break;
      p++;
    }
    return items.length === 1 ? items[0]! : { t: 'or', items };
  };
  const and = (): ExprNode | null => {
    const items: ExprNode[] = [];
    for (;;) {
      const a = unary();
      if (!a) return null;
      items.push(a);
      if (!kw(toks[p], 'AND')) break;
      p++;
    }
    return items.length === 1 ? items[0]! : { t: 'and', items };
  };
  const unary = (): ExprNode | null => {
    if (kw(toks[p], 'NOT')) {
      p++;
      const a = unary();
      return a ? { t: 'not', item: a } : null;
    }
    const t = toks[p];
    if (!t) return null;
    if (t.k === 'lp') {
      p++;
      const a = or();
      if (!a || toks[p]?.k !== 'rp') return null;
      p++;
      return a;
    }
    if (t.k !== 'word' || kw(t, 'AND') || kw(t, 'OR')) return null;
    const op = toks[p + 1];
    const val = toks[p + 2];
    if (op?.k !== 'op' || !val || (val.k !== 'str' && val.k !== 'word')) return null;
    p += 3;
    return { t: 'rel', name: t.v.replace(/^#/, '').toUpperCase(), op: op.v as '==' | '!=', value: val.v };
  };
  const n = or();
  return n && p === toks.length ? n : null;
}

// ---------------------------------------------------------------------------
// 식 → 행
// ---------------------------------------------------------------------------

interface Lit {
  name: string;
  op: '==' | '!=';
  value: string;
}

const MAX_ROWS = 64;

/** OR·AND 정규형(행마다 조건 목록). 너무 크면 null */
function dnf(n: ExprNode, neg: boolean): Lit[][] | null {
  switch (n.t) {
    case 'rel':
      return [[{ name: n.name, op: neg ? (n.op === '==' ? '!=' : '==') : n.op, value: n.value }]];
    case 'not':
      return dnf(n.item, !neg);
    case 'or':
    case 'and': {
      const parts: Lit[][][] = [];
      for (const c of n.items) {
        const d = dnf(c, neg);
        if (!d) return null;
        parts.push(d);
      }
      const isOr = (n.t === 'or') !== neg;
      if (isOr) {
        const out = parts.flat();
        return out.length > MAX_ROWS ? null : out;
      }
      let acc: Lit[][] = [[]];
      for (const d of parts) {
        const next: Lit[][] = [];
        for (const a of acc) for (const b of d) next.push([...a, ...b]);
        if (next.length > MAX_ROWS) return null;
        acc = next;
      }
      return acc;
    }
  }
}

/** 참·거짓 열: 식 이름 → [이 앱 열, 참일 때 값, 거짓일 때 값] */
const BOOL_VARS: Record<string, [string, string, string]> = {
  USED: ['STATUS', 'USED', 'UNUSED'],
  OFF: ['ON', 'OFF', 'ON'],
  FROZEN: ['FROZEN', 'FROZEN', 'THAWED'],
  LOCKED: ['LOCKED', 'LOCKED', 'UNLOCKED'],
  PLOTTABLE: ['PLOT', 'PLOT', 'NOPLOT'],
  NEWVPFROZEN: ['NEWVPFROZEN', 'FROZEN', 'THAWED'],
};

/** 무늬 열: 식 이름 → 이 앱 열 */
const PATTERN_VARS: Record<string, string> = {
  NAME: 'NAME',
  LINETYPE: 'LINETYPE',
  COLOR: 'COLOR',
  PLOTSTYLENAME: 'PLOTSTYLE',
  PLOTSTYLE: 'PLOTSTYLE',
  DESCRIPTION: 'DESCRIPTION',
};

function boolOf(v: string): boolean | null {
  const u = v.trim().toUpperCase();
  return u === 'TRUE' ? true : u === 'FALSE' ? false : null;
}

/** 조건 하나 → [이 앱 열, 값]. 바꿀 수 없으면 null */
export function literalToCell(name: string, op: '==' | '!=', value: string): [string, string] | null {
  const b = BOOL_VARS[name];
  if (b) {
    const v = boolOf(value);
    if (v === null) return null;
    return [b[0], v !== (op === '!=') ? b[1] : b[2]];
  }
  const col = PATTERN_VARS[name];
  if (col) {
    if (op === '==') return [col, value];
    // 같지 않음 → 부정 무늬(쉼표 나열이나 이미 부정인 무늬는 뜻이 달라져 바꾸지 않는다)
    if (!value || value.includes(',') || value.startsWith('~')) return null;
    return [col, `~${value}`];
  }
  if (op !== '==') return null;
  if (name === 'LINEWEIGHT') {
    const v = value.trim();
    if (/^default$/i.test(v)) return ['LINEWEIGHT', '-3'];
    if (!/^\d+(\.\d+)?$/.test(v)) return null;
    return ['LINEWEIGHT', String(Math.round(Number(v) * 100))];
  }
  if (name === 'TRANSPARENCY') {
    const v = value.trim();
    return /^\d+$/.test(v) ? ['TRANSPARENCY', String(Number(v))] : null;
  }
  return null;
}

/** 식 → 필터 정의 행. 조건이 없으면 빈 배열, 바꿀 수 없으면 null */
export function expressionToRows(text: string): FilterRow[] | null {
  const n = parseFilterExpression(text);
  if (n === 'empty') return [];
  if (!n) return null;
  const d = dnf(n, false);
  if (!d) return null;
  const rows: FilterRow[] = [];
  for (const lits of d) {
    const row: FilterRow = {};
    for (const l of lits) {
      const c = literalToCell(l.name, l.op, l.value);
      if (!c) return null;
      const had = row[c[0]];
      if (had !== undefined && had.toUpperCase() !== c[1].toUpperCase()) return null;
      row[c[0]] = c[1];
    }
    rows.push(row);
  }
  // 값이 빈 조건은 이 앱 행에서 "상관없음"이 되어 뜻이 바뀐다
  if (rows.some((r) => Object.values(r).some((v) => typeof v === 'string' && !v.trim()))) return null;
  return rows;
}

// ---------------------------------------------------------------------------
// 행 → 식
// ---------------------------------------------------------------------------

const q = (name: string, v: string) => `${name}=="${v}"`;

/** 열 하나 → 식 조건. AutoCAD 형식으로 쓸 수 없으면(확인하지 못한 열·값) null */
export function cellToLiteral(col: string, value: string): string | null {
  const v = value.trim();
  if (!v || v.includes('"')) return null;
  const up = v.toUpperCase();
  const tf = (b: boolean, upper = false) => (upper ? (b ? 'TRUE' : 'FALSE') : b ? 'True' : 'False');
  switch (col) {
    case 'STATUS':
      return up === 'USED' ? q('USED', tf(true, true)) : up === 'UNUSED' ? q('USED', tf(false, true)) : null;
    case 'NAME':
      return q('NAME', v);
    case 'LINETYPE':
      return q('LINETYPE', v);
    case 'ON':
      return up === 'ON' ? q('OFF', tf(false)) : up === 'OFF' ? q('OFF', tf(true)) : null;
    case 'FROZEN':
      return up === 'FROZEN' ? q('FROZEN', tf(true)) : up === 'THAWED' ? q('FROZEN', tf(false)) : null;
    case 'LOCKED':
      return up === 'LOCKED' ? q('LOCKED', tf(true)) : up === 'UNLOCKED' ? q('LOCKED', tf(false)) : null;
    case 'COLOR': {
      if (!/^\d+$/.test(v)) return null;
      const n = Number(v);
      return n >= 1 && n <= 255 ? q('COLOR', String(n)) : null;
    }
    case 'LINEWEIGHT': {
      if (!/^\d+$/.test(v)) return null;
      return q('LINEWEIGHT', (Number(v) / 100).toFixed(2));
    }
    case 'PLOT':
      return up === 'PLOT' ? q('PLOTTABLE', tf(true)) : up === 'NOPLOT' ? q('PLOTTABLE', tf(false)) : null;
    case 'NEWVPFROZEN':
      return up === 'FROZEN' ? q('NEWVPFROZEN', tf(true)) : up === 'THAWED' ? q('NEWVPFROZEN', tf(false)) : null;
    default:
      return null;
  }
}

/** AutoCAD 형식으로 쓸 수 있는 열(필터 정의 열 열쇠) */
export const ACAD_WRITABLE_COLUMNS: readonly string[] = ['STATUS', 'NAME', 'ON', 'FROZEN', 'LOCKED', 'COLOR', 'LINETYPE', 'LINEWEIGHT', 'PLOT', 'NEWVPFROZEN'];

/** 필터 정의 행 → 식. 조건이 없으면 `""""`, AutoCAD 형식으로 쓸 수 없는 조건이 있으면 null */
export function rowsToExpression(rows: readonly FilterRow[]): string | null {
  const list = cleanRows(rows);
  if (!list.length) return EMPTY_EXPRESSION;
  const order = ACAD_WRITABLE_COLUMNS;
  const parts: string[][] = [];
  for (const row of list) {
    const lits: string[] = [];
    const keys = Object.keys(row).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const k of keys) {
      const l = cellToLiteral(k, row[k]!);
      if (!l) return null;
      lits.push(l);
    }
    parts.push(lits);
  }
  if (parts.length === 1) return parts[0]!.join(' AND ');
  return parts.map((p) => (p.length > 1 ? `(${p.join(' AND ')})` : p[0]!)).join(' OR ');
}

/** 행 가운데 AutoCAD 형식으로 쓸 수 없는 열 이름(대화상자 안내용, 열 열쇠) */
export function unwritableColumns(rows: readonly FilterRow[]): string[] {
  const out = new Set<string>();
  for (const row of cleanRows(rows)) for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && !cellToLiteral(k, v)) out.add(k);
  return [...out];
}
