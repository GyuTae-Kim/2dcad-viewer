/**
 * AutoLISP 값 → 글(prin1·princ). 실수는 유효 숫자 6자리(%g)에 소수점을 붙인다(AutoCAD 명령행과 같다).
 */
import { Builtin, CatchAllError, Cons, Ename, Lambda, LispError, PickSet, Real, Special, Sym, type Value } from './types';

/** 실수 표시: 1.0, 0.333333, 123457.0, 1.23457e+06 */
export function formatReal(x: number): string {
  if (Number.isNaN(x)) return '-1.#IND';
  if (!Number.isFinite(x)) return x > 0 ? '1.#INF' : '-1.#INF';
  if (x === 0) return '0.0';
  const e = x.toExponential(5);
  const m = /^(-?[\d.]+)e([+-]\d+)$/.exec(e)!;
  const exp = parseInt(m[2]!, 10);
  if (exp < -4 || exp >= 6) {
    let mant = m[1]!.replace(/0+$/, '');
    if (mant.endsWith('.')) mant += '0';
    const ae = Math.abs(exp);
    return `${mant}e${exp < 0 ? '-' : '+'}${ae < 10 ? '0' : ''}${ae}`;
  }
  let s = x.toFixed(Math.max(0, 5 - exp));
  if (s.includes('.')) s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  if (!s.includes('.')) s += '.0';
  return s;
}

/** prin1 형식 문자열(따옴표·탈출 문자) */
export function quoteString(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '\\r';
    else if (c === '\x1b') out += '\\e';
    else out += c;
  }
  return out + '"';
}

const addresses = new WeakMap<object, number>();
let nextAddress = 0x1d4a0;
function address(o: object): string {
  let a = addresses.get(o);
  if (a === undefined) {
    a = nextAddress;
    nextAddress += 0x28;
    addresses.set(o, a);
  }
  return a.toString(16).padStart(8, '0');
}

/** 값을 글로(princ = 문자열을 따옴표 없이) */
export function toText(v: Value, princ = false, depth = 0): string {
  if (v === null) return 'nil';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return princ ? v : quoteString(v);
  if (v instanceof Real) return formatReal(v.v);
  if (v instanceof Sym) return v.name;
  if (v instanceof Cons) {
    if (depth > 200) return '(...)';
    const parts: string[] = [];
    let c: Value = v;
    let n = 0;
    while (c instanceof Cons) {
      if (++n > 100000) {
        parts.push('...');
        c = null;
        break;
      }
      parts.push(toText(c.car, princ, depth + 1));
      c = c.cdr;
    }
    return c === null ? `(${parts.join(' ')})` : `(${parts.join(' ')} . ${toText(c, princ, depth + 1)})`;
  }
  if (v instanceof Lambda) return `#<USUBR @${address(v)} ${v.name || '-lambda-'}>`;
  if (v instanceof Builtin || v instanceof Special) return `#<SUBR @${address(v)} ${v.name}>`;
  if (v instanceof Ename) return `<엔티티 이름: ${v.handle.toLowerCase()}>`;
  if (v instanceof PickSet) return `<선택 세트: ${v.id}>`;
  if (v instanceof CatchAllError) return '#<%catch-all-apply-error%>';
  return String(v);
}

export const prin1 = (v: Value): string => toText(v, false);
export const princ = (v: Value): string => toText(v, true);

/** 잘못된 인수 유형 오류 */
export function badType(pred: string, v: Value): LispError {
  return new LispError(`잘못된 인수 유형: ${pred}: ${prin1(v)}`);
}

/** 잘못된 인수 값 오류 */
export function badValue(what: string, v: Value): LispError {
  return new LispError(`잘못된 인수 값: ${what}: ${prin1(v)}`);
}
