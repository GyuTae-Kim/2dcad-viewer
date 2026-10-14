/**
 * 매개변수와 식: 치수 구속의 이름(d1, rad1 …)과 사용자 매개변수의 식을 의존 순서로 계산한다.
 * 식은 계산기(src/edit/util/calc.ts)의 자체 해석기로 읽는다(eval 없음). 각도 매개변수의 값은 도 단위다.
 */
import { CalcError, LENGTH_UNITS, PICK_FUNCS, evaluateCalc, parseCalc } from '../util/calc';
import type { CalcExpr, CalcValue } from '../util/calc';
import type { ConstraintStore, DimConstraint } from './types';
import { dimPrefix } from './types';

/** 이름으로 쓸 수 없는 낱말(상수·함수·점 고르기 함수) */
const RESERVED = new Set([
  'pi',
  'e',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sqrt',
  'sqr',
  'abs',
  'ln',
  'log',
  'exp',
  'exp10',
  'round',
  'trunc',
  'floor',
  'ceil',
  'min',
  'max',
  'r2d',
  'd2r',
  'dist',
  'ang',
  'cvunit',
  'getvar',
  'pow',
  ...PICK_FUNCS,
]);

/** 매개변수 이름 검사(쓸 수 없으면 까닭) */
export function paramNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return '이름을 입력하십시오.';
  if (n.length > 255) return '이름이 너무 깁니다.';
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(n)) return '이름은 글자나 _로 시작하고 글자·숫자·_만 쓸 수 있습니다.';
  const low = n.toLowerCase();
  if (RESERVED.has(low) || LENGTH_UNITS[low] !== undefined) return `"${n}"은(는) 함수·상수·단위 이름이라 쓸 수 없습니다.`;
  return null;
}

type Node = CalcExpr['root'];

/** 식을 읽고 쓰는 이름을 모은다(점 고르기 함수·잘못된 식이면 CalcError) */
export function parseParamExpr(src: string): { expr: CalcExpr; names: string[] } {
  const expr = parseCalc(src);
  if (expr.picks.length) throw new CalcError('식에는 점 고르기 함수를 쓸 수 없습니다.');
  const names = new Set<string>();
  const walk = (n: Node): void => {
    switch (n.k) {
      case 'var': {
        const low = n.name.toLowerCase();
        if (low !== 'pi' && low !== 'e') names.add(low);
        break;
      }
      case 'vec':
        n.items.forEach(walk);
        break;
      case 'un':
        walk(n.a);
        break;
      case 'bin':
        walk(n.a);
        walk(n.b);
        break;
      case 'call':
        if (n.name === 'getvar') throw new CalcError('식에는 getvar를 쓸 수 없습니다.');
        n.args.forEach(walk);
        break;
      default:
        break;
    }
  };
  walk(expr.root);
  return { expr, names: [...names] };
}

export interface ParamDef {
  name: string;
  expr: string;
  /** 참조 매개변수: 식 대신 측정값(measured) */
  reference: boolean;
  measured?: number;
}

export interface ParamEval {
  /** 소문자 이름 → 값 */
  values: Map<string, number>;
  /** 소문자 이름 → 오류 */
  errors: Map<string, string>;
  /** 계산 순서(소문자 이름) */
  order: string[];
}

/** 매개변수 표를 의존 순서로 계산한다 */
export function evaluateParams(defs: readonly ParamDef[], unitMm = 1): ParamEval {
  const byName = new Map<string, ParamDef>();
  const errors = new Map<string, string>();
  for (const d of defs) {
    const k = d.name.toLowerCase();
    if (byName.has(k)) errors.set(k, `이름 "${d.name}"이(가) 겹칩니다.`);
    else byName.set(k, d);
  }
  const parsed = new Map<string, { expr: CalcExpr; names: string[] } | null>();
  for (const [k, d] of byName) {
    if (d.reference) {
      parsed.set(k, null);
      continue;
    }
    try {
      parsed.set(k, parseParamExpr(d.expr));
    } catch (e) {
      errors.set(k, e instanceof Error ? e.message : String(e));
      parsed.set(k, null);
    }
  }
  const values = new Map<string, number>();
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (k: string, stack: string[]): void => {
    const s = state.get(k);
    if (s === 2) return;
    if (s === 1) {
      const cyc = stack.slice(stack.indexOf(k));
      for (const c of cyc) errors.set(c, `순환 참조입니다: ${[...cyc, k].map((x) => byName.get(x)?.name ?? x).join(' → ')}`);
      return;
    }
    state.set(k, 1);
    const d = byName.get(k)!;
    const p = parsed.get(k);
    if (p) for (const n of p.names) if (byName.has(n)) visit(n, [...stack, k]);
    state.set(k, 2);
    order.push(k);
    if (errors.has(k)) return;
    if (d.reference) {
      if (d.measured !== undefined && Number.isFinite(d.measured)) values.set(k, d.measured);
      else errors.set(k, '측정할 수 없습니다.');
      return;
    }
    if (!p) return;
    for (const n of p.names) {
      if (!byName.has(n)) {
        errors.set(k, `정의되지 않은 매개변수 "${n}"`);
        return;
      }
      if (!values.has(n)) {
        errors.set(k, `"${byName.get(n)!.name}"의 값을 구할 수 없습니다.`);
        return;
      }
    }
    try {
      const vars = new Map<string, CalcValue>();
      for (const n of p.names) vars.set(n, values.get(n)!);
      const v = evaluateCalc(p.expr, { vars, unitMm });
      if (typeof v !== 'number') throw new CalcError('식의 결과가 수가 아닙니다.');
      values.set(k, v);
    } catch (e) {
      errors.set(k, e instanceof Error ? e.message : String(e));
    }
  };
  for (const k of byName.keys()) visit(k, []);
  return { values, errors, order };
}

/** 저장된 구속 기록의 매개변수 정의(치수 구속 + 사용자 매개변수). measured는 참조 구속의 측정값 */
export function storeParamDefs(store: ConstraintStore, measured?: (c: DimConstraint) => number): ParamDef[] {
  const out: ParamDef[] = [];
  for (const c of store.constraints) {
    if (c.kind !== 'dim') continue;
    out.push({ name: c.name, expr: c.expr, reference: c.reference, measured: c.reference ? (measured ? measured(c) : c.value) : undefined });
  }
  for (const u of store.userParams) out.push({ name: u.name, expr: u.expr, reference: false });
  return out;
}

/** 식 안의 이름을 바꾼다(대소문자 무시, 수와 문자열은 그대로) */
export function replaceName(expr: string, from: string, to: string): string {
  const f = from.toLowerCase();
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const rest = expr.slice(i);
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (num && /[0-9]/.test(num[0])) {
      out += num[0];
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(rest);
    if (id) {
      out += id[0].toLowerCase() === f ? to : id[0];
      i += id[0].length;
      continue;
    }
    if (rest[0] === '"') {
      const end = expr.indexOf('"', i + 1);
      const j = end < 0 ? expr.length : end + 1;
      out += expr.slice(i, j);
      i = j;
      continue;
    }
    out += rest[0];
    i++;
  }
  return out;
}

/** 식에서 이름을 쓰는지 */
export function usesName(expr: string, name: string): boolean {
  try {
    return parseParamExpr(expr).names.includes(name.toLowerCase());
  } catch {
    return false;
  }
}

/** 값을 식에 넣을 글로(유효 숫자 12자리) */
export function numberText(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) < 1e-12) return '0';
  return String(Number(v.toPrecision(12)));
}

/** 식이 수 하나인지 */
export function isNumberExpr(expr: string): boolean {
  return /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(expr);
}

/** 다음 빈 이름(d1, d2 … / ang1 … / rad1 … / dia1 … / user1 …) */
export function nextParamName(store: ConstraintStore, prefix: string): string {
  const used = new Set<string>();
  for (const c of store.constraints) if (c.kind === 'dim') used.add(c.name.toLowerCase());
  for (const u of store.userParams) used.add(u.name.toLowerCase());
  let n = 1;
  while (used.has(`${prefix}${n}`.toLowerCase())) n++;
  return `${prefix}${n}`;
}

export function nextDimName(store: ConstraintStore, c: Pick<DimConstraint, 'type'>): string {
  return nextParamName(store, dimPrefix(c.type));
}

/** 모든 매개변수 이름(소문자) */
export function allParamNames(store: ConstraintStore): Set<string> {
  const s = new Set<string>();
  for (const c of store.constraints) if (c.kind === 'dim') s.add(c.name.toLowerCase());
  for (const u of store.userParams) s.add(u.name.toLowerCase());
  return s;
}
