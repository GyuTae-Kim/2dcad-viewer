/**
 * AutoLISP 기본 함수: 특수 형식(setq·defun·lambda·if·cond·while·repeat·foreach·progn·and·or·quote·function),
 * 산술·비교·목록·술어·기호·평가(eval·apply·mapcar·vl-catch-all-apply)·출력(princ·prin1·print·prompt·terpri)·기하(polar·distance·angle·inters).
 */
import type { Interp } from './interp';
import { badType, prin1, princ } from './printer';
import { EOF, LispReader } from './reader';
import { CatchAllError, CatchCall, Builtin, Call, Cons, Ename, Ev, type Gen, Lambda, LispError, MSG, PickSet, Real, Special, Sym, TailCall, TailEval, fromArray, isNum, numOf, toArray, type Value, wrap32 } from './types';

// --------------------------------------------------------------------------- 인수 검사

export function num(v: Value): number {
  if (typeof v === 'number') return v;
  if (v instanceof Real) return v.v;
  throw badType('numberp', v);
}

export function int(v: Value): number {
  if (typeof v === 'number') return v;
  throw badType('fixnump', v);
}

export function str(v: Value): string {
  if (typeof v === 'string') return v;
  throw badType('stringp', v);
}

export function sym(v: Value): Sym {
  if (v instanceof Sym) return v;
  throw badType('symbolp', v);
}

/** 진짜 목록 → 배열(아니면 listp 오류) */
export function arr(v: Value): Value[] {
  const a = toArray(v);
  if (!a) throw badType('listp', v);
  return a;
}

export interface Pt {
  x: number;
  y: number;
  z: number;
  dims: 2 | 3;
}

/** (x y [z]) → 점 */
export function point(v: Value): Pt {
  const a = toArray(v);
  if (!a || a.length < 2 || a.length > 3 || !a.every(isNum)) throw badType('2D/3D 점', v);
  return { x: numOf(a[0] as number | Real), y: numOf(a[1] as number | Real), z: a.length === 3 ? numOf(a[2] as number | Real) : 0, dims: a.length as 2 | 3 };
}

export function isPoint(v: Value): boolean {
  const a = toArray(v);
  return !!a && a.length >= 2 && a.length <= 3 && a.every(isNum);
}

/** 점 목록(실수) */
export function ptList(x: number, y: number, z?: number): Value {
  return z === undefined ? fromArray([new Real(x), new Real(y)]) : fromArray([new Real(x), new Real(y), new Real(z)]);
}

/** 수 결과: 정수끼리면 정수, 아니면 실수 */
const real = (x: number): Real => new Real(x);

/** 기호면 그 값(함수), 아니면 그대로 */
export function fnOf(v: Value): Value {
  if (v instanceof Sym) {
    const f = v.value;
    if (f instanceof Special) throw new LispError(`잘못된 함수: ${v.name}`);
    if (f === null) throw new LispError(`함수 정의 없음: ${v.name}`);
    return f;
  }
  return v;
}

// --------------------------------------------------------------------------- 같음

/** eq: 같은 객체(정수·문자열·기호·객체 이름은 값) */
export function eqv(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a instanceof Real && b instanceof Real) return a.v === b.v;
  return false;
}

/** equal: 구조가 같은가(수는 fuzz 안) */
export function equal(a: Value, b: Value, fuzz = 0): boolean {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return Math.abs(numOf(a) - numOf(b)) <= fuzz;
  if (a instanceof Cons && b instanceof Cons) {
    let x: Value = a;
    let y: Value = b;
    while (x instanceof Cons && y instanceof Cons) {
      if (!equal(x.car, y.car, fuzz)) return false;
      x = x.cdr;
      y = y.cdr;
    }
    return equal(x, y, fuzz);
  }
  if (a instanceof Real && b instanceof Real) return a.v === b.v;
  return false;
}

// --------------------------------------------------------------------------- 산술

function arith(args: Value[], op: '+' | '-' | '*'): Value {
  if (!args.length) return 0;
  let isInt = typeof args[0] === 'number';
  let acc = num(args[0]!);
  if (args.length === 1 && op === '-') return isInt ? wrap32(-acc) : real(-acc);
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    const b = num(a);
    if (isInt && typeof a === 'number') acc = op === '+' ? wrap32(acc + b) : op === '-' ? wrap32(acc - b) : Math.imul(acc, b);
    else {
      isInt = false;
      acc = op === '+' ? acc + b : op === '-' ? acc - b : acc * b;
    }
  }
  return isInt ? acc : real(acc);
}

function divide(args: Value[]): Value {
  if (!args.length) return 0;
  let isInt = typeof args[0] === 'number';
  let acc = num(args[0]!);
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    const b = num(a);
    if (b === 0) throw new LispError(MSG.divZero);
    if (isInt && typeof a === 'number') acc = wrap32(Math.trunc(acc / b));
    else {
      isInt = false;
      acc /= b;
    }
  }
  return isInt ? acc : real(acc);
}

function undefinedFor(v: Value): LispError {
  return new LispError(`인수에 대한 함수가 정의되지 않음: ${prin1(v)}`);
}

/** 비교: 수끼리·문자열끼리. 그 밖은 null */
function compare(a: Value, b: Value): number | null {
  if (isNum(a) && isNum(b)) return numOf(a) - numOf(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function ordered(args: Value[], test: (d: number) => boolean): boolean {
  for (let i = 0; i + 1 < args.length; i++) {
    const a = args[i]!;
    const b = args[i + 1]!;
    const d = compare(a, b);
    if (d === null) throw badType(typeof a === 'string' ? 'stringp' : 'numberp', typeof a === 'string' || isNum(a) ? b : a);
    if (!test(d)) return false;
  }
  return true;
}

function sameValue(a: Value, b: Value): boolean {
  const d = compare(a, b);
  return d === null ? eqv(a, b) : d === 0;
}

// --------------------------------------------------------------------------- 등록

export function installCore(it: Interp): void {
  const T = it.T;
  const B = (b: boolean): Value => (b ? T : null);
  const def = it.def.bind(it);

  it.sym('PI').value = real(Math.PI);
  it.sym('PAUSE').value = '\\';
  it.sym('*ERROR*').value = null;

  // ----------------------------------------------------------------- 특수 형식
  it.special('QUOTE', (f) => (f.cdr instanceof Cons ? f.cdr.car : null));
  it.special('FUNCTION', (f) => {
    const x = f.cdr instanceof Cons ? f.cdr.car : null;
    if (x instanceof Cons && x.car instanceof Sym && x.car.name === 'LAMBDA') return lambdaOf(it, x.cdr, '');
    if (x instanceof Sym && (x.value instanceof Builtin || x.value instanceof Lambda)) return x.value;
    return x;
  });
  it.special('SETQ', function* (f): Gen {
    let c = f.cdr;
    let v: Value = null;
    while (c instanceof Cons) {
      const s = sym(c.car);
      if (!(c.cdr instanceof Cons)) throw new LispError(MSG.tooFew);
      v = yield new Ev(c.cdr.car);
      s.value = v;
      c = c.cdr.cdr;
    }
    return v;
  });
  const defun = (f: Cons): Value => {
    const parts = arr(f.cdr);
    if (parts.length < 2) throw new LispError(MSG.tooFew);
    const name = sym(parts[0]!);
    const lam = it.makeLambda(parts[1]!, (f.cdr as Cons).cdr instanceof Cons ? ((f.cdr as Cons).cdr as Cons).cdr : null, name.name);
    name.value = lam;
    it.onDefun?.(name.name, lam);
    return name;
  };
  it.special('DEFUN', defun);
  it.special('DEFUN-Q', defun);
  it.special('LAMBDA', (f) => lambdaOf(it, f.cdr, ''));
  it.special('PROGN', function* (f): Gen {
    let c = f.cdr;
    if (!(c instanceof Cons)) return null;
    while (c.cdr instanceof Cons) {
      yield new Ev(c.car);
      c = c.cdr;
    }
    return new TailEval(c.car);
  });
  it.special('IF', function* (f): Gen {
    const a = arr(f.cdr);
    if (a.length < 2) throw new LispError(MSG.tooFew);
    if (a.length > 3) throw new LispError(MSG.tooMany);
    const t = yield new Ev(a[0]!);
    if (t !== null) return new TailEval(a[1]!);
    return a.length === 3 ? new TailEval(a[2]!) : null;
  });
  it.special('COND', function* (f): Gen {
    let c = f.cdr;
    while (c instanceof Cons) {
      const clause = c.car;
      if (!(clause instanceof Cons)) throw badType('listp', clause);
      const t = yield new Ev(clause.car);
      if (t !== null) {
        let b = clause.cdr;
        if (!(b instanceof Cons)) return t;
        while (b.cdr instanceof Cons) {
          yield new Ev(b.car);
          b = b.cdr;
        }
        return new TailEval(b.car);
      }
      c = c.cdr;
    }
    return null;
  });
  it.special('WHILE', function* (f): Gen {
    if (!(f.cdr instanceof Cons)) throw new LispError(MSG.tooFew);
    const test = f.cdr.car;
    const body = f.cdr.cdr;
    let v: Value = null;
    while ((yield new Ev(test)) !== null) {
      for (let b = body; b instanceof Cons; b = b.cdr) v = yield new Ev(b.car);
    }
    return v;
  });
  it.special('REPEAT', function* (f): Gen {
    if (!(f.cdr instanceof Cons)) throw new LispError(MSG.tooFew);
    const n = yield new Ev(f.cdr.car);
    if (typeof n !== 'number') throw badType('fixnump', n);
    let v: Value = null;
    for (let i = 0; i < n; i++) for (let b = f.cdr.cdr; b instanceof Cons; b = b.cdr) v = yield new Ev(b.car);
    return v;
  });
  it.special('FOREACH', function* (f): Gen {
    const a = toArray(f.cdr);
    if (!a || a.length < 2) throw new LispError(MSG.tooFew);
    const s = sym(a[0]!);
    const items = yield new Ev(a[1]!);
    const list = arr(items);
    const old = s.value;
    let v: Value = null;
    try {
      for (const x of list) {
        s.value = x;
        for (let b = ((f.cdr as Cons).cdr as Cons).cdr; b instanceof Cons; b = b.cdr) v = yield new Ev(b.car);
      }
    } finally {
      s.value = old;
    }
    return v;
  });
  it.special('AND', function* (f): Gen {
    for (let c = f.cdr; c instanceof Cons; c = c.cdr) if ((yield new Ev(c.car)) === null) return null;
    return T;
  });
  it.special('OR', function* (f): Gen {
    for (let c = f.cdr; c instanceof Cons; c = c.cdr) if ((yield new Ev(c.car)) !== null) return T;
    return null;
  });

  // ----------------------------------------------------------------- 산술
  def('+', 0, -1, (a) => arith(a, '+'));
  def('-', 0, -1, (a) => arith(a, '-'));
  def('*', 0, -1, (a) => arith(a, '*'));
  def('/', 0, -1, divide);
  def('REM', 0, -1, (a) => {
    if (!a.length) return 0;
    let isInt = typeof a[0] === 'number';
    let acc = num(a[0]!);
    for (let i = 1; i < a.length; i++) {
      const b = num(a[i]!);
      if (b === 0) throw new LispError(MSG.divZero);
      if (typeof a[i] !== 'number') isInt = false;
      acc = acc % b;
    }
    return isInt ? acc : real(acc);
  });
  def('1+', 1, 1, ([x]) => (typeof x === 'number' ? wrap32(x + 1) : real(num(x!) + 1)));
  def('1-', 1, 1, ([x]) => (typeof x === 'number' ? wrap32(x - 1) : real(num(x!) - 1)));
  def('ABS', 1, 1, ([x]) => (typeof x === 'number' ? wrap32(Math.abs(x)) : real(Math.abs(num(x!)))));
  const minmax = (a: Value[], pick: (p: number, q: number) => boolean): Value => {
    if (!a.length) return 0;
    let best = num(a[0]!);
    let isInt = typeof a[0] === 'number';
    for (let i = 1; i < a.length; i++) {
      const v = num(a[i]!);
      if (typeof a[i] !== 'number') isInt = false;
      if (pick(v, best)) best = v;
    }
    return isInt ? best : real(best);
  };
  def('MIN', 0, -1, (a) => minmax(a, (p, q) => p < q));
  def('MAX', 0, -1, (a) => minmax(a, (p, q) => p > q));
  def('FIX', 1, 1, ([x]) => {
    const t = Math.trunc(num(x!));
    return t >= -2147483648 && t <= 2147483647 ? t : real(t);
  });
  def('FLOAT', 1, 1, ([x]) => real(num(x!)));
  def('SQRT', 1, 1, ([x]) => {
    const v = num(x!);
    if (v < 0) throw undefinedFor(x!);
    return real(Math.sqrt(v));
  });
  def('EXPT', 2, 2, ([b, p]) => {
    const bv = num(b!);
    const pv = num(p!);
    if (typeof b === 'number' && typeof p === 'number') {
      if (pv < 0) return bv === 1 ? 1 : bv === -1 ? (pv % 2 ? -1 : 1) : 0;
      let r = 1;
      for (let i = 0; i < pv && i < 64; i++) r = Math.imul(r, bv);
      return r;
    }
    const r = Math.pow(bv, pv);
    if (Number.isNaN(r)) throw undefinedFor(b!);
    return real(r);
  });
  def('EXP', 1, 1, ([x]) => real(Math.exp(num(x!))));
  def('LOG', 1, 1, ([x]) => {
    const v = num(x!);
    if (v <= 0) throw undefinedFor(x!);
    return real(Math.log(v));
  });
  def('SIN', 1, 1, ([x]) => real(Math.sin(num(x!))));
  def('COS', 1, 1, ([x]) => real(Math.cos(num(x!))));
  def('ATAN', 1, 2, ([y, x]) => real(x === undefined ? Math.atan(num(y!)) : Math.atan2(num(y!), num(x))));
  def('GCD', 0, -1, (a) => {
    let g = 0;
    for (const v of a) {
      let n = Math.abs(int(v));
      let m = g;
      while (n) [m, n] = [n, m % n];
      g = m;
    }
    return g;
  });
  def('~', 1, 1, ([x]) => ~int(x!));
  def('LOGAND', 0, -1, (a) => (a.length ? a.reduce<number>((p, v) => p & int(v), -1) : 0));
  def('LOGIOR', 0, -1, (a) => a.reduce<number>((p, v) => p | int(v), 0));
  def('LSH', 0, 2, ([x, n]) => {
    const v = x === undefined ? 0 : int(x);
    const s = n === undefined ? 0 : int(n);
    return s >= 0 ? v << s : v >>> -s;
  });
  def('BOOLE', 1, -1, (a) => {
    const op = int(a[0]!);
    if (a.length < 2) return 0;
    let acc = int(a[1]!);
    for (let i = 2; i < a.length; i++) {
      const b = int(a[i]!);
      let r = 0;
      if (op & 8) r |= acc & b;
      if (op & 4) r |= acc & ~b;
      if (op & 2) r |= ~acc & b;
      if (op & 1) r |= ~acc & ~b;
      acc = r;
    }
    return acc;
  });

  // ----------------------------------------------------------------- 비교·술어
  def('=', 1, -1, (a) => B(a.every((x, i) => i === 0 || sameValue(a[i - 1]!, x))));
  def('/=', 1, -1, (a) => B(a.every((x, i) => i === 0 || !sameValue(a[i - 1]!, x))));
  def('<', 1, -1, (a) => B(ordered(a, (d) => d < 0)));
  def('>', 1, -1, (a) => B(ordered(a, (d) => d > 0)));
  def('<=', 1, -1, (a) => B(ordered(a, (d) => d <= 0)));
  def('>=', 1, -1, (a) => B(ordered(a, (d) => d >= 0)));
  def('EQ', 2, 2, ([a, b]) => B(eqv(a!, b!)));
  def('EQUAL', 2, 3, ([a, b, f]) => B(equal(a!, b!, f === undefined ? 0 : Math.abs(num(f)))));
  def('MINUSP', 1, 1, ([x]) => B(num(x!) < 0));
  def('ZEROP', 1, 1, ([x]) => B(num(x!) === 0));
  def('NUMBERP', 1, 1, ([x]) => B(isNum(x!)));
  def('NOT', 1, 1, ([x]) => B(x === null));
  def('NULL', 1, 1, ([x]) => B(x === null));
  def('ATOM', 1, 1, ([x]) => B(!(x instanceof Cons)));
  def('LISTP', 1, 1, ([x]) => B(x === null || x instanceof Cons));
  def('VL-CONSP', 1, 1, ([x]) => B(x instanceof Cons));
  def('VL-SYMBOLP', 1, 1, ([x]) => B(x instanceof Sym));
  def('BOUNDP', 1, 1, ([x]) => B(sym(x!).value !== null));
  def('TYPE', 1, 1, ([x]) => {
    const t = typeName(x!);
    return t ? it.sym(t) : null;
  });

  // ----------------------------------------------------------------- 목록
  def('LIST', 0, -1, (a) => fromArray(a));
  def('CONS', 2, 2, ([a, b]) => new Cons(a!, b!));
  def('VL-LIST*', 1, -1, (a) => fromArray(a.slice(0, -1), a[a.length - 1]!));
  def('CAR', 1, 1, ([x]) => car(x!));
  def('CDR', 1, 1, ([x]) => cdr(x!));
  for (const path of cxrNames()) {
    def(`C${path}R`, 1, 1, ([x]) => {
      let v: Value = x!;
      for (let i = path.length - 1; i >= 0; i--) v = path[i] === 'A' ? car(v) : cdr(v);
      return v;
    });
  }
  def('NTH', 2, 2, ([n, l]) => {
    let i = int(n!);
    if (i < 0) return null;
    let c: Value = l!;
    while (c instanceof Cons && i > 0) {
      c = c.cdr;
      i--;
    }
    if (c !== null && !(c instanceof Cons)) throw badType('consp', l!);
    return c instanceof Cons ? c.car : null;
  });
  def('LAST', 1, 1, ([l]) => {
    let c = l!;
    if (c === null) return null;
    if (!(c instanceof Cons)) throw badType('listp', c);
    while (c.cdr instanceof Cons) c = c.cdr;
    return c.car;
  });
  def('LENGTH', 1, 1, ([l]) => arr(l!).length);
  def('VL-LIST-LENGTH', 1, 1, ([l]) => {
    const a = toArray(l!);
    return a ? a.length : null;
  });
  def('REVERSE', 1, 1, ([l]) => fromArray(arr(l!).reverse()));
  def('APPEND', 0, -1, (a) => {
    if (!a.length) return null;
    let out: Value = a[a.length - 1]!;
    if (out !== null && !(out instanceof Cons)) throw badType('listp', out);
    for (let i = a.length - 2; i >= 0; i--) out = fromArray(arr(a[i]!), out);
    return out;
  });
  def('MEMBER', 2, 2, ([x, l]) => {
    for (let c: Value = l!; c instanceof Cons; c = c.cdr) if (equal(x!, c.car)) return c;
    if (l !== null && !(l instanceof Cons)) throw badType('listp', l!);
    return null;
  });
  def('ASSOC', 2, 2, ([k, l]) => {
    if (l !== null && !(l instanceof Cons)) throw badType('listp', l!);
    for (let c: Value = l!; c instanceof Cons; c = c.cdr) if (c.car instanceof Cons && equal(k!, c.car.car)) return c.car;
    return null;
  });
  def('SUBST', 3, 3, ([n, o, l]) => {
    if (!(l instanceof Cons)) return l!;
    const a = toArray(l);
    if (!a) return l;
    return fromArray(a.map((x) => (equal(x, o!) ? n! : x)));
  });
  def('VL-REMOVE', 2, 2, ([x, l]) => fromArray(arr(l!).filter((y) => !equal(x!, y))));
  def('VL-POSITION', 2, 2, ([x, l]) => {
    const i = arr(l!).findIndex((y) => equal(x!, y));
    return i < 0 ? null : i;
  });
  def('ACAD_STRLSORT', 1, 1, ([l]) => {
    const a = arr(l!).map(str);
    return fromArray(a.sort((p, q) => p.localeCompare(q, 'ko', { sensitivity: 'accent' })));
  });

  // ----------------------------------------------------------------- 함수 부르기
  def('APPLY', 2, 2, ([f, l]) => new TailCall(fnOf(f!), arr(l!)));
  def('EVAL', 1, 1, ([x]) => new TailEval(x!));
  def('MAPCAR', 2, -1, function* (a): Gen {
    const f = fnOf(a[0]!);
    const lists = a.slice(1).map(arr);
    const n = Math.min(...lists.map((l) => l.length));
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.push(yield new Call(f, lists.map((l) => l[i]!)));
    return fromArray(out);
  });
  const predicateList = (keepWhen: boolean) =>
    function* (a: Value[]): Gen {
      const f = fnOf(a[0]!);
      const out: Value[] = [];
      for (const x of arr(a[1]!)) if (((yield new Call(f, [x])) !== null) === keepWhen) out.push(x);
      return fromArray(out);
    };
  def('VL-REMOVE-IF', 2, 2, predicateList(false));
  def('VL-REMOVE-IF-NOT', 2, 2, predicateList(true));
  const memberIf = (want: boolean) =>
    function* (a: Value[]): Gen {
      const f = fnOf(a[0]!);
      for (let c: Value = a[1]!; c instanceof Cons; c = c.cdr) if (((yield new Call(f, [c.car])) !== null) === want) return c;
      return null;
    };
  def('VL-MEMBER-IF', 2, 2, memberIf(true));
  def('VL-MEMBER-IF-NOT', 2, 2, memberIf(false));
  def('VL-SOME', 2, -1, function* (a): Gen {
    const f = fnOf(a[0]!);
    const lists = a.slice(1).map(arr);
    const n = Math.min(...lists.map((l) => l.length));
    for (let i = 0; i < n; i++) {
      const r = yield new Call(f, lists.map((l) => l[i]!));
      if (r !== null) return r;
    }
    return null;
  });
  def('VL-EVERY', 2, -1, function* (a): Gen {
    const f = fnOf(a[0]!);
    const lists = a.slice(1).map(arr);
    const n = Math.min(...lists.map((l) => l.length));
    for (let i = 0; i < n; i++) if ((yield new Call(f, lists.map((l) => l[i]!))) === null) return null;
    return T;
  });
  const sortGen = function* (items: Value[], f: Value): Generator<Call, number[], Value> {
    // 안정 병합 정렬(비교마다 함수를 부른다)
    let idx = items.map((_, i) => i);
    for (let w = 1; w < idx.length; w *= 2) {
      const next: number[] = [];
      for (let s = 0; s < idx.length; s += 2 * w) {
        let i = s;
        let j = Math.min(s + w, idx.length);
        const iEnd = j;
        const jEnd = Math.min(s + 2 * w, idx.length);
        while (i < iEnd && j < jEnd) {
          // 오른쪽이 왼쪽보다 앞이어야 할 때만 바꾼다
          if ((yield new Call(f, [items[idx[j]!]!, items[idx[i]!]!])) !== null) next.push(idx[j++]!);
          else next.push(idx[i++]!);
        }
        while (i < iEnd) next.push(idx[i++]!);
        while (j < jEnd) next.push(idx[j++]!);
      }
      idx = next;
    }
    return idx;
  };
  def('VL-SORT', 2, 2, function* (a): Gen {
    const items = arr(a[0]!);
    const idx: number[] = yield* sortGen(items, fnOf(a[1]!));
    return fromArray(idx.map((i) => items[i]!));
  });
  def('VL-SORT-I', 2, 2, function* (a): Gen {
    const items = arr(a[0]!);
    const idx: number[] = yield* sortGen(items, fnOf(a[1]!));
    return fromArray(idx);
  });
  def('VL-CATCH-ALL-APPLY', 2, 2, function* (a): Gen {
    return yield new CatchCall(fnOf(a[0]!), arr(a[1]!));
  });
  def('VL-CATCH-ALL-ERROR-P', 1, 1, ([x]) => B(x instanceof CatchAllError));
  def('VL-CATCH-ALL-ERROR-MESSAGE', 1, 1, ([x]) => {
    if (!(x instanceof CatchAllError)) throw badType('vl-catch-all-apply-error', x!);
    return x.message;
  });
  def('EXIT', 0, 0, () => {
    throw new LispError(MSG.exit, 'exit');
  });
  def('QUIT', 0, 0, () => {
    throw new LispError(MSG.exit, 'exit');
  });

  // ----------------------------------------------------------------- 기호
  def('SET', 2, 2, ([s, v]) => {
    sym(s!).value = v!;
    return v!;
  });
  def('VL-SYMBOL-NAME', 1, 1, ([s]) => sym(s!).name);
  def('VL-SYMBOL-VALUE', 1, 1, ([s]) => sym(s!).value);
  def('ATOMS-FAMILY', 1, 2, ([fmt, names]) => {
    const asStr = int(fmt!) === 1;
    if (names !== undefined && names !== null) {
      return fromArray(
        arr(names).map((n) => {
          const s = it.syms.find(str(n));
          return s && s.value !== null ? (asStr ? s.name : s) : null;
        }),
      );
    }
    const out: Value[] = [];
    for (const s of it.syms.all()) if (s.value !== null) out.push(asStr ? s.name : s);
    return fromArray(out);
  });
  def('READ', 0, 1, ([s]) => {
    if (s === undefined) return null;
    const r = new LispReader(str(s), it.syms).read();
    return r === EOF ? null : r;
  });
  def('VL-PRINC-TO-STRING', 1, 1, ([x]) => princ(x!));
  def('VL-PRIN1-TO-STRING', 1, 1, ([x]) => prin1(x!));
  def('VER', 0, 0, () => 'Visual LISP 2026 (ko)');
  for (const n of ['VL-LOAD-COM', 'VL-LOAD-REACTORS', 'GC', 'MEM', 'TRACE', 'UNTRACE', 'VL-ACAD-DEFUN', 'VL-ACAD-UNDEFUN', 'SETFUNHELP', 'VL-ARX-IMPORT', 'VL-DOC-EXPORT']) def(n, 0, -1, () => null);

  // ----------------------------------------------------------------- 출력
  const fileArg = (f: Value | undefined) => {
    if (f !== undefined && f !== null) throw badType('filep', f);
  };
  def('PRINC', 0, 2, ([x, f]) => {
    fileArg(f);
    if (x === undefined) return it.EMPTY;
    it.write(princ(x));
    return x;
  });
  def('PRIN1', 0, 2, ([x, f]) => {
    fileArg(f);
    if (x === undefined) return it.EMPTY;
    it.write(prin1(x));
    return x;
  });
  def('PRINT', 0, 2, ([x, f]) => {
    fileArg(f);
    if (x === undefined) return it.EMPTY;
    it.write(`\n${prin1(x)} `);
    return x;
  });
  def('PROMPT', 1, 1, ([s]) => {
    it.write(str(s!));
    return null;
  });
  def('TERPRI', 0, 0, () => {
    it.write('\n');
    return null;
  });

  // ----------------------------------------------------------------- 기하
  def('POLAR', 3, 3, ([p, a, d]) => {
    const q = point(p!);
    const ang = num(a!);
    const dist = num(d!);
    const x = q.x + dist * Math.cos(ang);
    const y = q.y + dist * Math.sin(ang);
    return q.dims === 3 ? ptList(x, y, q.z) : ptList(x, y);
  });
  def('DISTANCE', 2, 2, ([a, b]) => {
    const p = point(a!);
    const q = point(b!);
    const dz = p.dims === 3 && q.dims === 3 ? q.z - p.z : 0;
    return real(Math.hypot(q.x - p.x, q.y - p.y, dz));
  });
  def('ANGLE', 2, 2, ([a, b]) => {
    const p = point(a!);
    const q = point(b!);
    let ang = Math.atan2(q.y - p.y, q.x - p.x);
    if (ang < 0) ang += 2 * Math.PI;
    return real(ang);
  });
  def('INTERS', 4, 5, ([a, b, c, d, onseg]) => {
    const p1 = point(a!);
    const p2 = point(b!);
    const p3 = point(c!);
    const p4 = point(d!);
    const rx = p2.x - p1.x;
    const ry = p2.y - p1.y;
    const sx = p4.x - p3.x;
    const sy = p4.y - p3.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12 * Math.max(1, Math.hypot(rx, ry) * Math.hypot(sx, sy))) return null;
    const t = ((p3.x - p1.x) * sy - (p3.y - p1.y) * sx) / den;
    const u = ((p3.x - p1.x) * ry - (p3.y - p1.y) * rx) / den;
    const seg = onseg === undefined || onseg !== null;
    const eps = 1e-10;
    if (seg && (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps)) return null;
    const x = p1.x + t * rx;
    const y = p1.y + t * ry;
    if ([p1, p2, p3, p4].every((p) => p.dims === 3)) return ptList(x, y, p1.z + t * (p2.z - p1.z));
    return ptList(x, y);
  });
}

function car(x: Value): Value {
  if (x === null) return null;
  if (x instanceof Cons) return x.car;
  throw badType('consp', x);
}

function cdr(x: Value): Value {
  if (x === null) return null;
  if (x instanceof Cons) return x.cdr;
  throw badType('consp', x);
}

/** CAAR … CDDDDR(2~4단계) */
function cxrNames(): string[] {
  const out: string[] = [];
  const grow = (s: string) => {
    if (s.length >= 2) out.push(s);
    if (s.length < 4) {
      grow(s + 'A');
      grow(s + 'D');
    }
  };
  grow('');
  return out;
}

function lambdaOf(it: Interp, rest: Value, name: string): Lambda {
  if (!(rest instanceof Cons)) throw new LispError(MSG.tooFew);
  return it.makeLambda(rest.car, rest.cdr, name);
}

/** (type x) 이름 */
export function typeName(x: Value): string | null {
  if (x === null) return null;
  if (typeof x === 'number') return 'INT';
  if (typeof x === 'string') return 'STR';
  if (x instanceof Real) return 'REAL';
  if (x instanceof Sym) return 'SYM';
  if (x instanceof Cons) return 'LIST';
  if (x instanceof Lambda) return 'USUBR';
  if (x instanceof Builtin || x instanceof Special) return 'SUBR';
  if (x instanceof Ename) return 'ENAME';
  if (x instanceof PickSet) return 'PICKSET';
  if (x instanceof CatchAllError) return 'VL-CATCH-ALL-APPLY-ERROR';
  return null;
}
