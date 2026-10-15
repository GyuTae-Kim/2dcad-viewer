/**
 * NC 식 계산기 두 가지.
 *
 * - G-code(Fanuc 매크로 B·LinuxCNC 꼴): 대괄호 묶음 `[ ]`, 변수 `#1`·`#[식]`·`#<이름>`, 낱말 연산자
 *   (MOD, EQ NE GT GE LT LE, AND OR XOR), `**`, 함수 `SIN[..]`(각도는 도), `ATAN[a]/[b]`.
 *   글은 대문자로 바꾸고 공백을 뺀 뒤 넘긴다(주석 제외).
 * - MPR(woodWOP 변수 식): 소괄호, 이름 변수, `+ - * / ^`, 비교(`= <> < > <= >=`), AND OR NOT,
 *   `IF 조건 THEN 값 ELSE 값`, 함수 SIN·COS·TAN·ARCSIN·ARCCOS·ARCTAN·SQRT·ABS 등(각도는 도).
 *
 * 두 쪽 모두 값은 number, 참·거짓은 1·0이다. 모르는 변수는 undefined(빈 값)로 돌려 부르는 쪽이 정한다.
 */

const DEG = Math.PI / 180;

/** 도 단위 삼각·수 함수(두 문법 공용) */
const FUNCS: Record<string, (x: number) => number> = {
  SIN: (x) => Math.sin(x * DEG),
  COS: (x) => Math.cos(x * DEG),
  TAN: (x) => Math.tan(x * DEG),
  ASIN: (x) => Math.asin(x) / DEG,
  ACOS: (x) => Math.acos(x) / DEG,
  ATAN: (x) => Math.atan(x) / DEG,
  ARCSIN: (x) => Math.asin(x) / DEG,
  ARCCOS: (x) => Math.acos(x) / DEG,
  ARCTAN: (x) => Math.atan(x) / DEG,
  SQRT: Math.sqrt,
  SQR: Math.sqrt,
  ABS: Math.abs,
  EXP: Math.exp,
  LN: Math.log,
  LOG: Math.log10,
  LOG10: Math.log10,
  ROUND: (x) => Math.sign(x) * Math.round(Math.abs(x)),
  FIX: Math.floor,
  FUP: Math.ceil,
  INT: Math.trunc,
  TRUNC: Math.trunc,
  FLOOR: Math.floor,
  CEIL: Math.ceil,
  FRAC: (x) => x - Math.trunc(x),
  SGN: Math.sign,
  SIGN: Math.sign,
  SQ: (x) => x * x,
  NEG: (x) => -x,
};

export class ExprError extends Error {}

// ───────────────────────── G-code 식 ─────────────────────────

/** G-code 변수 참조: 번호 또는 이름(#<name>) */
export type GVarRef = number | string;

export interface GExprEnv {
  /** 변수 값(빈 변수는 undefined) */
  get(ref: GVarRef): number | undefined;
}

/**
 * G-code 식을 읽는다. s는 대문자·공백 없는 글, pos부터 읽어 [값, 다음 위치]를 돌려준다.
 * 빈 변수(#0·정의 안 된 변수)는 산술에서 0으로 본다. 단일 변수 값 그대로면 undefined를 돌려줄 수 있다(낱말 생략용).
 */
export class GExpr {
  constructor(
    private s: string,
    public pos: number,
    private env: GExprEnv,
  ) {}

  private eat(t: string): boolean {
    if (this.s.startsWith(t, this.pos)) {
      this.pos += t.length;
      return true;
    }
    return false;
  }

  /** 전체 식(논리 연산까지) */
  expr(): number {
    let v = this.compare();
    for (;;) {
      if (this.eat('AND')) v = v !== 0 && this.compare() !== 0 ? 1 : 0;
      else if (this.eat('OR')) {
        const b = this.compare();
        v = v !== 0 || b !== 0 ? 1 : 0;
      } else if (this.eat('XOR')) v = (v !== 0) !== (this.compare() !== 0) ? 1 : 0;
      else return v;
    }
  }

  private compare(): number {
    let v = this.additive();
    for (;;) {
      const op = this.s.slice(this.pos, this.pos + 2);
      if (op === 'EQ' || op === 'NE' || op === 'GT' || op === 'GE' || op === 'LT' || op === 'LE') {
        // GOTO·GE 낱말과 겹치지 않게: 뒤에 식이 와야 한다
        const c = this.s[this.pos + 2];
        if (c === undefined || c === ']') return v;
        this.pos += 2;
        const b = this.additive();
        const e = Math.abs(v - b) < 1e-9;
        v = (op === 'EQ' ? e : op === 'NE' ? !e : op === 'GT' ? v > b : op === 'GE' ? v >= b || e : op === 'LT' ? v < b : v <= b || e) ? 1 : 0;
      } else return v;
    }
  }

  private additive(): number {
    let v = this.multiplicative();
    for (;;) {
      if (this.eat('+')) v += this.multiplicative();
      else if (this.eat('-')) v -= this.multiplicative();
      else return v;
    }
  }

  private multiplicative(): number {
    let v = this.power();
    for (;;) {
      if (this.eat('*')) v *= this.power();
      else if (this.eat('/')) {
        const b = this.power();
        v = b === 0 ? NaN : v / b;
      } else if (this.eat('MOD')) {
        const b = this.power();
        v = b === 0 ? NaN : v - Math.floor(v / b) * b;
      } else return v;
    }
  }

  private power(): number {
    const v = this.unaryNum();
    if (this.eat('**')) return Math.pow(v, this.power());
    return v;
  }

  private unaryNum(): number {
    return this.unary() ?? 0;
  }

  /**
   * 낱말 값 하나(이항 연산 없이): 수, #변수, [식], 함수[식], 부호.
   * 빈 변수 하나면 undefined.
   */
  unary(): number | undefined {
    if (this.eat('-')) {
      const v = this.unary();
      return v === undefined ? undefined : -v;
    }
    if (this.eat('+')) return this.unary();
    const c = this.s[this.pos];
    if (c === undefined) throw new ExprError('식이 끝났다');
    if (c === '[') {
      this.pos++;
      const v = this.expr();
      if (!this.eat(']')) throw new ExprError('] 없음');
      return v;
    }
    if (c === '#') {
      this.pos++;
      return this.env.get(this.varRef());
    }
    if ((c >= '0' && c <= '9') || c === '.') return this.number();
    // 함수
    const m = /^[A-Z][A-Z0-9]*/.exec(this.s.slice(this.pos, this.pos + 8));
    if (m) {
      const name = m[0];
      for (let k = name.length; k >= 2; k--) {
        const f = name.slice(0, k);
        if (f === 'EXISTS' && this.s[this.pos + k] === '[') {
          this.pos += k + 1;
          let v = 0;
          if (this.eat('#')) v = this.env.get(this.varRef()) === undefined ? 0 : 1;
          if (!this.eat(']')) throw new ExprError('] 없음');
          return v;
        }
        const fn = FUNCS[f];
        if (fn && this.s[this.pos + k] === '[') {
          this.pos += k + 1;
          const a = this.expr();
          if (!this.eat(']')) throw new ExprError('] 없음');
          // ATAN[y]/[x]
          if ((f === 'ATAN' || f === 'ARCTAN') && this.s.startsWith('/[', this.pos)) {
            this.pos += 2;
            const b = this.expr();
            if (!this.eat(']')) throw new ExprError('] 없음');
            return Math.atan2(a, b) / DEG;
          }
          return fn(a);
        }
      }
    }
    throw new ExprError(`알 수 없는 식 '${this.s.slice(this.pos, this.pos + 8)}'`);
  }

  /** # 뒤의 변수 참조 */
  varRef(): GVarRef {
    const c = this.s[this.pos];
    if (c === '<') {
      const e = this.s.indexOf('>', this.pos);
      if (e < 0) throw new ExprError('> 없음');
      const name = this.s.slice(this.pos + 1, e).toLowerCase();
      this.pos = e + 1;
      return name;
    }
    if (c === '[') {
      this.pos++;
      const v = this.expr();
      if (!this.eat(']')) throw new ExprError('] 없음');
      return Math.round(v);
    }
    if (c === '#') {
      this.pos++;
      return Math.round(this.env.get(this.varRef()) ?? 0);
    }
    if (c !== undefined && c >= '0' && c <= '9') return Math.round(this.number());
    throw new ExprError('변수 번호 없음');
  }

  number(): number {
    const m = /^[0-9]*\.?[0-9]*/.exec(this.s.slice(this.pos, this.pos + 40));
    const t = m ? m[0] : '';
    if (!t || t === '.') throw new ExprError('수가 아님');
    this.pos += t.length;
    return parseFloat(t);
  }
}

// ───────────────────────── MPR(woodWOP) 식 ─────────────────────────

export interface MprExprEnv {
  /** 이름 변수 값(없으면 undefined) */
  get(name: string): number | undefined;
}

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenizeMpr(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(s.slice(i))!;
      out.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(s.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '==' || two === '!=' || two === '**') {
      out.push({ t: 'op', v: two === '**' ? '^' : two === '!=' ? '<>' : two === '==' ? '=' : two });
      i += 2;
      continue;
    }
    if ('+-*/^()=<>,%'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new ExprError(`알 수 없는 글자 '${c}'`);
  }
  return out;
}

const KW = new Set(['AND', 'OR', 'NOT', 'IF', 'THEN', 'ELSE', 'MOD', 'XOR']);

/** MPR 식을 계산한다. 계산할 수 없으면 ExprError */
export function evalMprExpr(src: string, env: MprExprEnv): number {
  const toks = tokenizeMpr(src);
  let p = 0;
  const peekKw = (k: string): boolean => {
    const t = toks[p];
    return !!t && t.t === 'id' && t.v.toUpperCase() === k;
  };
  const peekOp = (o: string): boolean => {
    const t = toks[p];
    return !!t && t.t === 'op' && t.v === o;
  };
  const expr = (): number => {
    if (peekKw('IF')) {
      p++;
      const c = orE();
      if (!peekKw('THEN')) throw new ExprError('THEN 없음');
      p++;
      const a = expr();
      let b = 0;
      if (peekKw('ELSE')) {
        p++;
        b = expr();
      }
      return c !== 0 ? a : b;
    }
    return orE();
  };
  const orE = (): number => {
    let v = andE();
    for (;;) {
      if (peekKw('OR')) {
        p++;
        const b = andE();
        v = v !== 0 || b !== 0 ? 1 : 0;
      } else if (peekKw('XOR')) {
        p++;
        const b = andE();
        v = (v !== 0) !== (b !== 0) ? 1 : 0;
      } else return v;
    }
  };
  const andE = (): number => {
    let v = notE();
    while (peekKw('AND')) {
      p++;
      const b = notE();
      v = v !== 0 && b !== 0 ? 1 : 0;
    }
    return v;
  };
  const notE = (): number => {
    if (peekKw('NOT')) {
      p++;
      return notE() === 0 ? 1 : 0;
    }
    return cmp();
  };
  const cmp = (): number => {
    const v = add();
    const t = toks[p];
    if (t && t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      p++;
      const b = add();
      const e = Math.abs(v - b) < 1e-9;
      switch (t.v) {
        case '=':
          return e ? 1 : 0;
        case '<>':
          return e ? 0 : 1;
        case '<':
          return v < b && !e ? 1 : 0;
        case '>':
          return v > b && !e ? 1 : 0;
        case '<=':
          return v <= b || e ? 1 : 0;
        default:
          return v >= b || e ? 1 : 0;
      }
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    for (;;) {
      if (peekOp('+')) {
        p++;
        v += mul();
      } else if (peekOp('-')) {
        p++;
        v -= mul();
      } else return v;
    }
  };
  const mul = (): number => {
    let v = pow();
    for (;;) {
      if (peekOp('*')) {
        p++;
        v *= pow();
      } else if (peekOp('/')) {
        p++;
        const b = pow();
        if (b === 0) throw new ExprError('0으로 나눔');
        v /= b;
      } else if (peekOp('%') || peekKw('MOD')) {
        p++;
        const b = pow();
        if (b === 0) throw new ExprError('0으로 나눔');
        v = v - Math.floor(v / b) * b;
      } else return v;
    }
  };
  const pow = (): number => {
    const v = unary();
    if (peekOp('^')) {
      p++;
      return Math.pow(v, pow());
    }
    return v;
  };
  const unary = (): number => {
    if (peekOp('-')) {
      p++;
      return -unary();
    }
    if (peekOp('+')) {
      p++;
      return unary();
    }
    return primary();
  };
  const primary = (): number => {
    const t = toks[p++];
    if (!t) throw new ExprError('식이 끝났다');
    if (t.t === 'num') return t.v;
    if (t.t === 'op') {
      if (t.v === '(') {
        const v = expr();
        if (!peekOp(')')) throw new ExprError(') 없음');
        p++;
        return v;
      }
      throw new ExprError(`'${t.v}' 자리가 아님`);
    }
    const name = t.v;
    const up = name.toUpperCase();
    if (peekOp('(')) {
      p++;
      const args: number[] = [];
      if (!peekOp(')')) {
        args.push(expr());
        while (peekOp(',')) {
          p++;
          args.push(expr());
        }
      }
      if (!peekOp(')')) throw new ExprError(') 없음');
      p++;
      if ((up === 'ATAN2' || up === 'ARCTAN2') && args.length === 2) return Math.atan2(args[0]!, args[1]!) / DEG;
      if ((up === 'ATAN' || up === 'ARCTAN') && args.length === 2) return Math.atan2(args[0]!, args[1]!) / DEG;
      if (up === 'MIN' && args.length) return Math.min(...args);
      if (up === 'MAX' && args.length) return Math.max(...args);
      if (up === 'POW' && args.length === 2) return Math.pow(args[0]!, args[1]!);
      if (up === 'MOD' && args.length === 2) return args[1] ? args[0]! - Math.floor(args[0]! / args[1]!) * args[1]! : NaN;
      if (up === 'IF' && args.length === 3) return args[0] !== 0 ? args[1]! : args[2]!;
      const f = FUNCS[up];
      if (f && args.length === 1) return f(args[0]!);
      throw new ExprError(`알 수 없는 함수 ${name}`);
    }
    if (KW.has(up)) throw new ExprError(`'${name}' 자리가 아님`);
    const v = env.get(name);
    if (v !== undefined) return v;
    if (up === 'PI') return Math.PI;
    if (up === 'TRUE') return 1;
    if (up === 'FALSE') return 0;
    throw new ExprError(`모르는 변수 ${name}`);
  };
  const v = expr();
  if (p < toks.length) throw new ExprError(`남은 글 '${toks.slice(p).map((t) => String(t.v)).join(' ')}'`);
  return v;
}
