/**
 * AutoLISP 평가기(화면·DOM 없음).
 * 재귀를 JS 스택이 아니라 명시적 프레임 스택으로 돌려 깊은 재귀에서도 터지지 않고, 꼬리 위치의 사용자 함수 호출은
 * 묶음 되돌리기 프레임을 합쳐 스택이 자라지 않는다. 내장 함수가 Promise를 돌려주면(입력·명령) 기다렸다가 잇는다.
 * 특수 형식과 고차 함수는 제너레이터로 쓴다: Ev(식 평가)·Call(함수 호출)을 yield하면 결과를 돌려받는다.
 * 오류는 "; 오류: …"로 알리고 그 식만 멈춘다. *error* 사용자 함수가 있으면 스택을 풀기 전에 부른다(지역 변수가 살아 있다).
 */
import { badType, prin1, princ } from './printer';
import { EOF, LispReader } from './reader';
import {
  Builtin,
  Call,
  CatchAllError,
  CatchCall,
  Cons,
  Ename,
  Ev,
  type Gen,
  Lambda,
  LispError,
  MSG,
  PickSet,
  Special,
  Sym,
  Symbols,
  TailCall,
  TailEval,
  type BuiltinResult,
  type Value,
} from './types';

const CALL = 0;
const BODY = 1;
const RESTORE = 2;
const GEN = 3;
const CATCH = 4;

interface CallFrame {
  k: typeof CALL;
  /** undefined = 머리(lambda 식)를 평가하는 중 */
  fn: Value | undefined;
  args: Value[];
  rest: Value;
}
interface BodyFrame {
  k: typeof BODY;
  rest: Value;
}
interface RestoreFrame {
  k: typeof RESTORE;
  syms: Sym[];
  olds: Value[];
}
interface GenFrame {
  k: typeof GEN;
  gen: Gen;
}
interface CatchFrame {
  k: typeof CATCH;
}
type Frame = CallFrame | BodyFrame | RestoreFrame | GenFrame | CatchFrame;

const EVAL = 0;
const APPLY = 1;
const RET = 2;

export type Outcome = { ok: true; value: Value } | { ok: false; error: LispError };

/** 이 웹 버전에서 만들지 않는 함수 이름(파일 쓰기·외부 실행·ActiveX·반응자) */
export const WEB_ONLY = /^(VLA|VLAX|VLR|VL-FILE|VL-REGISTRY|VL-VBA|VL-VLX|DOS_|ACET-FILE|ACET-REG)/;

function isGen(r: unknown): r is Gen {
  return typeof r === 'object' && r !== null && typeof (r as Gen).next === 'function' && typeof (r as Gen).throw === 'function';
}

export interface InterpOptions {
  /** 명령행 한 줄 출력 */
  print(text: string, cls?: 'err' | 'res'): void;
  /** 화면이 멈추지 않게 잠깐 쉬기(없으면 쉬지 않는다) */
  pause?(): Promise<void>;
}

export class Interp {
  readonly syms = new Symbols();
  readonly T: Sym;
  /** (princ)가 돌려주는 빈 기호(아무것도 찍지 않는다) */
  readonly EMPTY: Sym;
  /** 프레임 수 한도(넘으면 내부 스택 한계 오류) */
  maxStack = 200_000;
  /** 평가 단계 한도(끝없는 반복을 멈춘다) */
  maxSteps = 200_000_000;
  /** 쉬는 간격(ms) */
  sliceMs = 30;
  private stack: Frame[] = [];
  private steps = 0;
  private nextCheck = 4096;
  private sliceStart = 0;
  private cancelled = false;
  private inError = false;
  private lineBuf = '';
  private readonly enames = new Map<string, Ename>();
  private pickSerial = 0;
  private readonly listLambdas = new WeakMap<Cons, Lambda>();
  /** 최상위 평가 깊이(0이면 쉬는 중) */
  active = 0;
  /** defun이 함수를 정의할 때(C: 명령 등록) */
  onDefun: ((name: string, fn: Lambda) => void) | null = null;

  constructor(readonly opts: InterpOptions) {
    this.T = this.syms.intern('T');
    this.T.value = this.T;
    this.EMPTY = new Sym('');
  }

  // ------------------------------------------------------------------ 등록

  def(name: string, min: number, max: number, fn: (args: Value[], it: Interp) => BuiltinResult): void {
    this.syms.intern(name).value = new Builtin(name.toUpperCase(), fn, min, max);
  }

  special(name: string, fn: (form: Cons, it: Interp) => Gen | Value | TailEval): void {
    this.syms.intern(name).value = new Special(name.toUpperCase(), fn);
  }

  sym(name: string): Sym {
    return this.syms.intern(name);
  }

  bool(b: boolean): Value {
    return b ? this.T : null;
  }

  ename(handle: string): Ename {
    let e = this.enames.get(handle);
    if (!e) {
      e = new Ename(handle);
      this.enames.set(handle, e);
    }
    return e;
  }

  pickSet(handles: string[]): PickSet {
    return new PickSet(handles, ++this.pickSerial);
  }

  // ------------------------------------------------------------------ 출력

  /** 출력 흐름에 글을 붙인다(줄바꿈마다 명령행 한 줄) */
  write(text: string): void {
    let s = this.lineBuf + text;
    let i: number;
    while ((i = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, i).replace(/\r/g, '');
      if (line) this.opts.print(line);
      s = s.slice(i + 1);
    }
    this.lineBuf = s;
  }

  /** 줄 끝이 아직 안 온 출력을 내보낸다 */
  flush(): void {
    if (this.lineBuf) this.opts.print(this.lineBuf.replace(/\r/g, ''));
    this.lineBuf = '';
  }

  /** 줄 끝이 아직 안 온 출력을 가져간다(프롬프트로 쓴다) */
  takeLine(): string {
    const s = this.lineBuf;
    this.lineBuf = '';
    return s;
  }

  // ------------------------------------------------------------------ 멈춤

  /** Esc: 지금 평가를 멈춘다 */
  cancel(): void {
    if (this.active) this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** 멈추라고 했으면 오류를 던진다(오래 기다리는 내장 함수가 부른다) */
  checkCancel(): void {
    if (this.cancelled) throw new LispError(MSG.cancel, 'cancel');
  }

  private async checkpoint(): Promise<void> {
    this.nextCheck = this.steps + 4096;
    if (this.steps > this.maxSteps) throw new LispError(`반복 한도(${this.maxSteps.toLocaleString()}단계)를 넘었습니다`);
    const now = performance.now();
    if (now - this.sliceStart > this.sliceMs && this.opts.pause) {
      await this.opts.pause();
      this.sliceStart = performance.now();
    }
    this.checkCancel();
  }

  // ------------------------------------------------------------------ 함수 꼴

  /** 부를 수 있는 값 → Lambda(목록 꼴 lambda 포함). 내장이면 그대로 */
  private callable(v: Value): Builtin | Lambda | null {
    if (v instanceof Builtin || v instanceof Lambda) return v;
    if (v instanceof Cons) {
      let l = this.listLambdas.get(v);
      if (!l) {
        // (lambda (인수) 본문…) 또는 defun-q 꼴 ((인수) 본문…)
        const isLam = v.car instanceof Sym && v.car.name === 'LAMBDA';
        const params = isLam ? (v.cdr instanceof Cons ? v.cdr.car : null) : v.car;
        const body = isLam ? (v.cdr instanceof Cons ? v.cdr.cdr : null) : v.cdr;
        if (!isLam && params !== null && !(params instanceof Cons)) return null;
        l = this.makeLambda(params, body, '');
        this.listLambdas.set(v, l);
      }
      return l;
    }
    return null;
  }

  /** 인수 목록 (a b / c d) → Lambda */
  makeLambda(params: Value, body: Value, name: string): Lambda {
    const ps: Sym[] = [];
    const ls: Sym[] = [];
    let local = false;
    let c = params;
    while (c instanceof Cons) {
      const s = c.car;
      if (!(s instanceof Sym)) throw badType('symbolp', s);
      if (s.name === '/') local = true;
      else (local ? ls : ps).push(s);
      c = c.cdr;
    }
    if (c !== null) throw badType('listp', params);
    return new Lambda(ps, ls, body, name);
  }

  private noFunction(head: Value, v: Value): LispError {
    if (head instanceof Sym && v === null) {
      if (WEB_ONLY.test(head.name)) return new LispError(`${head.name}: ${MSG.web}`);
      return new LispError(`함수 정의 없음: ${head.name}`);
    }
    return new LispError(`잘못된 함수: ${prin1(v ?? head)}`);
  }

  // ------------------------------------------------------------------ 기계

  /** 스택 base 위에서 식을 평가하거나(fn 없음) 함수를 부른다. 잡지 않은 오류는 스택을 남긴 채 던진다 */
  private async exec(start: Value, fn0: Value | undefined, args0: Value[]): Promise<Value> {
    const st = this.stack;
    const base = st.length;
    let mode = fn0 === undefined ? EVAL : APPLY;
    let x: Value = start;
    let v: Value = null;
    let fn: Value = fn0 ?? null;
    let args: Value[] = args0;
    for (;;) {
      try {
        for (;;) {
          if (++this.steps >= this.nextCheck) await this.checkpoint();
          if (mode === EVAL) {
            if (x instanceof Sym) {
              v = x.value;
              mode = RET;
              continue;
            }
            if (!(x instanceof Cons)) {
              v = x;
              mode = RET;
              continue;
            }
            const h: Value = x.car;
            if (h instanceof Sym) {
              const f = h.value;
              if (f instanceof Special) {
                const r = f.fn(x, this);
                if (isGen(r)) {
                  st.push({ k: GEN, gen: r });
                  v = null;
                  mode = RET;
                } else if (r instanceof TailEval) x = r.x;
                else {
                  v = r as Value;
                  mode = RET;
                }
                continue;
              }
              if (!(f instanceof Builtin || f instanceof Lambda || (f instanceof Cons && this.callable(f)))) throw this.noFunction(h, f);
              const rest = x.cdr;
              if (!(rest instanceof Cons)) {
                fn = f;
                args = [];
                mode = APPLY;
                continue;
              }
              st.push({ k: CALL, fn: f, args: [], rest: rest.cdr });
              x = rest.car;
              continue;
            }
            if (h instanceof Cons) {
              st.push({ k: CALL, fn: undefined, args: [], rest: x.cdr });
              x = h;
              continue;
            }
            throw new LispError(`잘못된 함수: ${prin1(h)}`);
          }
          if (mode === APPLY) {
            if (st.length - base > this.maxStack) throw new LispError(MSG.stack);
            if (fn instanceof Builtin) {
              if (args.length < fn.min) throw new LispError(MSG.tooFew);
              if (fn.max >= 0 && args.length > fn.max) throw new LispError(MSG.tooMany);
              const r = fn.fn(args, this);
              if (r instanceof Promise) {
                v = await r;
                this.checkCancel();
                mode = RET;
              } else if (isGen(r)) {
                st.push({ k: GEN, gen: r });
                v = null;
                mode = RET;
              } else if (r instanceof TailCall) {
                fn = r.fn;
                args = r.args;
              } else if (r instanceof TailEval) {
                x = r.x;
                mode = EVAL;
              } else {
                v = r;
                mode = RET;
              }
              continue;
            }
            const lam = this.callable(fn);
            if (!lam) throw new LispError(`잘못된 함수: ${prin1(fn)}`);
            if (lam instanceof Builtin) {
              fn = lam;
              continue;
            }
            const ps = lam.params;
            if (args.length < ps.length) throw new LispError(MSG.tooFew);
            if (args.length > ps.length) throw new LispError(MSG.tooMany);
            const top = st.length > base ? st[st.length - 1]! : null;
            if (top && top.k === RESTORE) {
              // 꼬리 호출: 바깥 함수의 되돌리기 프레임에 합친다(같은 기호는 바깥의 원래 값이 이긴다)
              for (const s of ps) if (!top.syms.includes(s)) (top.syms.push(s), top.olds.push(s.value));
              for (const s of lam.locals) if (!top.syms.includes(s)) (top.syms.push(s), top.olds.push(s.value));
            } else {
              const syms = ps.length || lam.locals.length ? [...ps, ...lam.locals] : [];
              st.push({ k: RESTORE, syms, olds: syms.map((s) => s.value) });
            }
            for (let i = 0; i < ps.length; i++) ps[i]!.value = args[i]!;
            for (const s of lam.locals) s.value = null;
            const body = lam.body;
            if (!(body instanceof Cons)) {
              v = null;
              mode = RET;
              continue;
            }
            if (body.cdr instanceof Cons) st.push({ k: BODY, rest: body.cdr });
            x = body.car;
            mode = EVAL;
            continue;
          }
          // RET: 값을 위 프레임에 돌려준다
          if (st.length === base) return v;
          const fr = st[st.length - 1]!;
          switch (fr.k) {
            case CALL: {
              if (fr.fn === undefined) {
                if (!this.callable(v)) throw new LispError(`잘못된 함수: ${prin1(v)}`);
                fr.fn = v;
              } else fr.args.push(v);
              const rest = fr.rest;
              if (rest instanceof Cons) {
                x = rest.car;
                fr.rest = rest.cdr;
                mode = EVAL;
              } else {
                st.pop();
                fn = fr.fn;
                args = fr.args;
                mode = APPLY;
              }
              continue;
            }
            case BODY: {
              const c = fr.rest as Cons;
              x = c.car;
              fr.rest = c.cdr;
              if (!(fr.rest instanceof Cons)) st.pop();
              mode = EVAL;
              continue;
            }
            case RESTORE:
              st.pop();
              for (let i = fr.syms.length - 1; i >= 0; i--) fr.syms[i]!.value = fr.olds[i]!;
              continue;
            case CATCH:
              st.pop();
              continue;
            case GEN: {
              const r = fr.gen.next(v);
              if (r.done) {
                st.pop();
                const rv = r.value;
                if (rv instanceof TailEval) {
                  x = rv.x;
                  mode = EVAL;
                } else if (rv instanceof TailCall) {
                  fn = rv.fn;
                  args = rv.args;
                  mode = APPLY;
                } else v = rv;
                continue;
              }
              const q = r.value;
              if (q instanceof Ev) {
                x = q.x;
                mode = EVAL;
              } else if (q instanceof Call) {
                fn = q.fn;
                args = q.args;
                mode = APPLY;
              } else if (q instanceof CatchCall) {
                st.push({ k: CATCH });
                fn = q.fn;
                args = q.args;
                mode = APPLY;
              } else {
                v = await q;
                this.checkCancel();
              }
              continue;
            }
          }
        }
      } catch (e) {
        const err = toLispError(e);
        if (err.kind === 'error') {
          let i = st.length - 1;
          while (i >= base && st[i]!.k !== CATCH) i--;
          if (i >= base) {
            this.unwind(i + 1);
            st.pop();
            v = new CatchAllError(err.message);
            mode = RET;
            continue;
          }
        }
        throw err;
      }
    }
  }

  /** 스택을 n개까지 풀며 묶음을 되돌린다 */
  private unwind(n: number): void {
    const st = this.stack;
    while (st.length > n) {
      const fr = st.pop()!;
      if (fr.k === RESTORE) for (let i = fr.syms.length - 1; i >= 0; i--) fr.syms[i]!.value = fr.olds[i]!;
      else if (fr.k === GEN) {
        try {
          fr.gen.return(null);
        } catch {
          /* 정리 중 오류는 무시 */
        }
      }
    }
  }

  // ------------------------------------------------------------------ 최상위

  /** 최상위 평가(오류는 알리고 Outcome으로) */
  private async top(run: () => Promise<Value>, report: boolean): Promise<Outcome> {
    const base = this.stack.length;
    if (this.active === 0) {
      this.cancelled = false;
      this.steps = 0;
      this.nextCheck = 4096;
      this.sliceStart = performance.now();
    }
    this.active++;
    try {
      const value = await run();
      return { ok: true, value };
    } catch (e) {
      const error = toLispError(e);
      const handled = await this.callErrorHandler(error);
      this.unwind(base);
      this.flush();
      if (!handled && report) this.opts.print(`; 오류: ${error.message}`, 'err');
      return { ok: false, error };
    } finally {
      this.active--;
      if (this.active === 0) this.cancelled = false;
    }
  }

  /** *error* 사용자 함수가 있으면 부른다(스택을 풀기 전). 불렀으면 true */
  private async callErrorHandler(error: LispError): Promise<boolean> {
    const h = this.syms.find('*ERROR*')?.value ?? null;
    if (this.inError || !this.callable(h)) return false;
    this.inError = true;
    const wasCancelled = this.cancelled;
    this.cancelled = false;
    try {
      await this.exec(null, h, [error.message]);
    } catch (e) {
      this.flush();
      this.opts.print(`; 오류: *error* 함수 안에서 오류가 발생했습니다: ${toLispError(e).message}`, 'err');
    } finally {
      this.inError = false;
      this.cancelled = wasCancelled;
    }
    return true;
  }

  /** 식 하나를 평가한다 */
  evaluate(form: Value, report = true): Promise<Outcome> {
    return this.top(() => this.exec(form, undefined, []), report);
  }

  /** 함수를 부른다(C: 명령 등) */
  callFunction(fn: Value, args: Value[], report = true): Promise<Outcome> {
    return this.top(() => this.exec(null, fn, args), report);
  }

  /** 글의 식을 차례로 평가한다(읽기 오류·평가 오류에서 멈춘다). 마지막 값 */
  evalText(text: string, report = true): Promise<Outcome> {
    const reader = new LispReader(text, this.syms);
    return this.top(async () => {
      let v: Value = null;
      for (;;) {
        const f = reader.read();
        if (f === EOF) return v;
        v = await this.exec(f, undefined, []);
      }
    }, report);
  }

  /** 평가 중(제너레이터 안)에서 함수를 부를 때 */
  call(fn: Value, args: Value[]): Call {
    return new Call(fn, args);
  }

  /** 값을 명령행 결과처럼 찍는다(REPL) */
  echo(v: Value): void {
    this.write(prin1(v));
    this.flush();
  }

  /** 평가 중에 기호 값을 읽는다 */
  valueOf(name: string): Value {
    return this.syms.find(name)?.value ?? null;
  }

  princText(v: Value): string {
    return princ(v);
  }
}

/** 던져진 것 → LispError */
export function toLispError(e: unknown): LispError {
  if (e instanceof LispError) return e;
  if (e instanceof RangeError && /call stack/i.test(e.message)) return new LispError(MSG.stack);
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'CancelError') return new LispError(MSG.cancel, 'cancel');
  if (e instanceof Error && e.message === '취소') return new LispError(MSG.cancel, 'cancel');
  return new LispError(e instanceof Error ? e.message : String(e));
}
