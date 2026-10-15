/**
 * AutoLISP 값(화면·DOM 없음).
 * - nil(빈 목록) = null, 정수 = JS number(32비트), 실수 = Real, 문자열 = JS string, 기호 = Sym(이름은 대문자).
 * - 목록은 Cons 사슬(점 쌍은 cdr이 목록이 아닌 것), 함수는 Builtin·Special(내장)과 Lambda(사용자 정의).
 * - 객체 이름(Ename)과 선택 세트(PickSet)는 도면 핸들을 가리킨다.
 * AutoLISP는 동적 범위다: 기호마다 값 칸이 하나이고 함수 인수·지역 변수는 들어갈 때 묶고 나올 때 되돌린다.
 */
import type { Interp } from './interp';

export class Real {
  constructor(readonly v: number) {}
}

export class Sym {
  /** 묶인 값(null = nil, 묶이지 않음) */
  value: Value = null;
  constructor(readonly name: string) {}
}

export class Cons {
  constructor(
    public car: Value,
    public cdr: Value,
  ) {}
}

/** defun·lambda로 만든 함수 */
export class Lambda {
  constructor(
    readonly params: Sym[],
    readonly locals: Sym[],
    /** 본문 식 목록 */
    readonly body: Value,
    public name: string,
  ) {}
}

/** 평가기에 돌려주는 요청(제너레이터가 yield한다) */
export class Ev {
  constructor(readonly x: Value) {}
}
export class Call {
  constructor(
    readonly fn: Value,
    readonly args: Value[],
  ) {}
}
/** 오류를 잡으며 부르기(vl-catch-all-apply) */
export class CatchCall {
  constructor(
    readonly fn: Value,
    readonly args: Value[],
  ) {}
}
/** 제너레이터·내장 함수의 마지막: 그 자리에서 식을 평가(꼬리 위치) */
export class TailEval {
  constructor(readonly x: Value) {}
}
/** 마지막: 그 자리에서 함수를 부른다(apply) */
export class TailCall {
  constructor(
    readonly fn: Value,
    readonly args: Value[],
  ) {}
}

export type Req = Ev | Call | CatchCall | Promise<Value>;
export type Gen = Generator<Req, Value | TailEval | TailCall, Value>;
export type BuiltinResult = Value | Promise<Value> | Gen | TailCall | TailEval;

/** 내장 함수: 인수를 평가한 뒤 부른다 */
export class Builtin {
  constructor(
    readonly name: string,
    readonly fn: (args: Value[], it: Interp) => BuiltinResult,
    readonly min: number,
    /** -1 = 제한 없음 */
    readonly max: number,
  ) {}
}

/** 특수 형식: 식 그대로 받는다(setq·if·defun …) */
export class Special {
  constructor(
    readonly name: string,
    readonly fn: (form: Cons, it: Interp) => Gen | Value | TailEval,
  ) {}
}

/** 도면 객체 이름 */
export class Ename {
  constructor(readonly handle: string) {}
}

/** 선택 세트 */
export class PickSet {
  constructor(
    public handles: string[],
    readonly id: number,
  ) {}
}

/** vl-catch-all-apply가 잡은 오류 */
export class CatchAllError {
  constructor(readonly message: string) {}
}

export type Value = null | number | Real | string | Sym | Cons | Lambda | Builtin | Special | Ename | PickSet | CatchAllError;

/** AutoLISP 오류. message는 "; 오류: " 뒤의 글이고 *error*에 넘긴다 */
export class LispError extends Error {
  constructor(
    message: string,
    /** cancel: Esc(함수 취소), exit: (exit)·(quit) — vl-catch-all-apply도 잡지 않는다 */
    readonly kind: 'error' | 'cancel' | 'exit' = 'error',
  ) {
    super(message);
  }
}

export const MSG = {
  cancel: '함수 취소됨',
  exit: '종료 / 나가기 중단',
  tooFew: '인수가 너무 적음',
  tooMany: '인수가 너무 많음',
  divZero: '0으로 나누기',
  stack: '하드 오류 발생 *** 내부 스택 한계 도달(시뮬레이션)',
  malformedList: '입력에 잘못된 형식의 목록',
  malformedString: '입력에 잘못된 형식의 문자열',
  extraParen: '입력에 오른쪽 괄호가 남음',
  dot: '입력에 잘못 놓인 점',
  web: '이 웹 버전에서는 쓸 수 없습니다',
} as const;

/** 기호 표(이름은 대문자로 묶는다) */
export class Symbols {
  private readonly map = new Map<string, Sym>();
  intern(name: string): Sym {
    const k = name.toUpperCase();
    let s = this.map.get(k);
    if (!s) {
      s = new Sym(k);
      this.map.set(k, s);
    }
    return s;
  }
  find(name: string): Sym | undefined {
    return this.map.get(name.toUpperCase());
  }
  all(): IterableIterator<Sym> {
    return this.map.values();
  }
}

// --------------------------------------------------------------------------- 목록 도우미

export function list(...xs: Value[]): Value {
  let r: Value = null;
  for (let i = xs.length - 1; i >= 0; i--) r = new Cons(xs[i]!, r);
  return r;
}

export function fromArray(xs: readonly Value[], tail: Value = null): Value {
  let r: Value = tail;
  for (let i = xs.length - 1; i >= 0; i--) r = new Cons(xs[i]!, r);
  return r;
}

/** 진짜 목록이면 원소 배열, 아니면(점 쌍 등) null */
export function toArray(v: Value): Value[] | null {
  const out: Value[] = [];
  let c = v;
  while (c instanceof Cons) {
    out.push(c.car);
    c = c.cdr;
  }
  return c === null ? out : null;
}

export const isList = (v: Value): v is Cons | null => v === null || v instanceof Cons;
export const isNum = (v: Value): v is number | Real => typeof v === 'number' || v instanceof Real;
export const numOf = (v: number | Real): number => (typeof v === 'number' ? v : v.v);

export function isCallable(v: Value): boolean {
  return v instanceof Builtin || v instanceof Lambda || (v instanceof Cons && (lambdaHead(v) || v.car === null || v.car instanceof Cons));
}

function lambdaHead(c: Cons): boolean {
  return c.car instanceof Sym && c.car.name === 'LAMBDA';
}

/** 32비트 정수로 감기(AutoLISP 정수 넘침) */
export const wrap32 = (n: number): number => n | 0;
