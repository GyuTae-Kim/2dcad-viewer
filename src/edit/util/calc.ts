/**
 * 계산식(QUICKCALC·CAL): eval 없이 직접 읽고 계산한다.
 * - 수: 12, 1.5, .5, 1e-3, 단위 붙은 수(25mm, 3ft, 2in, 1m …)는 도면 단위로 바꾼다
 * - 연산: + − × ÷ ^(거듭제곱), 괄호, 단항 −, 백분율 없음
 * - 점(벡터): [x,y] 또는 [x,y,z]. 점 ± 점, 수 × 점, 점 ÷ 수, 점 * 점(내적), 점 & 점(외적)
 * - 함수: sin cos tan asin acos atan(도 단위) sqrt sqr abs ln log exp exp10 round trunc floor ceil min max r2d d2r
 *   dist(p1,p2) ang(p1[,p2]) cvunit(값,단위,단위) getvar(이름)
 * - 상수: pi, e. 변수는 env.vars로 넘긴다
 * - 점 고르기 함수(cur, end, mid, cen, int, nea, qua, per, ins, nod, tan)는 pointRequests로 먼저 물어 env.points에 넣는다
 */

export type CalcValue = number | { x: number; y: number; z: number };

type Node =
  | { k: 'num'; v: number }
  | { k: 'vec'; items: Node[] }
  | { k: 'var'; name: string }
  | { k: 'unit'; name: string }
  | { k: 'pick'; kind: string; index: number }
  | { k: 'un'; op: '-' | '+'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

export class CalcError extends Error {}

/** 길이 단위 → 밀리미터 */
export const LENGTH_UNITS: Record<string, number> = {
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  밀리미터: 1,
  cm: 10,
  centimeter: 10,
  센티미터: 10,
  m: 1000,
  meter: 1000,
  meters: 1000,
  미터: 1000,
  km: 1_000_000,
  kilometer: 1_000_000,
  킬로미터: 1_000_000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  '"': 25.4,
  인치: 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8,
  "'": 304.8,
  피트: 304.8,
  yd: 914.4,
  yard: 914.4,
  yards: 914.4,
  야드: 914.4,
  mi: 1_609_344,
  mile: 1_609_344,
  miles: 1_609_344,
  마일: 1_609_344,
};

/** INSUNITS 값 → 밀리미터(0 = 단위 없음은 1로 본다) */
export const INSUNITS_MM: Record<number, number> = {
  1: 25.4,
  2: 304.8,
  3: 1_609_344,
  4: 1,
  5: 10,
  6: 1000,
  7: 1_000_000,
  8: 25.4e-6,
  9: 25.4e-3,
  10: 914.4,
  11: 1e-7,
  12: 1e-6,
  13: 1e-3,
  14: 100,
  15: 10_000,
  16: 100_000,
  17: 1e12,
  18: 1.495978707e14,
  19: 9.46073e18,
  20: 3.08567758e19,
};

export const PICK_FUNCS = new Set(['cur', 'end', 'mid', 'cen', 'int', 'nea', 'qua', 'per', 'ins', 'nod', 'tan', 'app']);

const FUNCS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'sqr', 'abs', 'ln', 'log', 'exp', 'exp10', 'round', 'trunc', 'floor', 'ceil', 'min', 'max', 'r2d', 'd2r', 'dist', 'ang', 'cvunit', 'getvar', 'pow']);

interface Tok {
  t: 'num' | 'id' | 'op' | 'str';
  v: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c) && /[0-9]/.test(src.slice(i, i + 2).replace('.', ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      const m = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' && out.length && out[out.length - 1]!.t === 'num') {
      out.push({ t: 'id', v: '"', pos: i });
      i++;
      continue;
    }
    if (c === "'" && out.length && out[out.length - 1]!.t === 'num') {
      out.push({ t: 'id', v: "'", pos: i });
      i++;
      continue;
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new CalcError('따옴표가 닫히지 않았습니다.');
      out.push({ t: 'str', v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '**') {
      out.push({ t: 'op', v: '^', pos: i });
      i += 2;
      continue;
    }
    if ('+-*/^()[],&×÷'.includes(c)) {
      out.push({ t: 'op', v: c === '×' ? '*' : c === '÷' ? '/' : c, pos: i });
      i++;
      continue;
    }
    throw new CalcError(`알 수 없는 글자 "${c}"`);
  }
  return out;
}

class Parser {
  private i = 0;
  private picks = 0;
  constructor(private readonly toks: Tok[]) {}

  parse(): Node {
    if (!this.toks.length) throw new CalcError('식이 비어 있습니다.');
    const n = this.expr();
    if (this.i < this.toks.length) throw new CalcError(`"${this.toks[this.i]!.v}" 앞에서 식이 끝나야 합니다.`);
    return n;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && t.v === v;
  }

  private expect(v: string): void {
    if (!this.isOp(v)) throw new CalcError(`"${v}"이(가) 필요합니다.`);
    this.i++;
  }

  private expr(): Node {
    let a = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.toks[this.i++]!.v;
      a = { k: 'bin', op, a, b: this.term() };
    }
    return a;
  }

  private term(): Node {
    let a = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('&')) {
        const op = this.toks[this.i++]!.v;
        a = { k: 'bin', op, a, b: this.unary() };
        continue;
      }
      // 곱셈 생략: 2pi, 3(4+1), 2[1,0]
      const t = this.peek();
      if (t && (t.t === 'id' || (t.t === 'op' && (t.v === '(' || t.v === '[')))) {
        a = { k: 'bin', op: '*', a, b: this.unary() };
        continue;
      }
      return a;
    }
  }

  private unary(): Node {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.toks[this.i++]!.v as '-' | '+';
      return { k: 'un', op, a: this.unary() };
    }
    return this.power();
  }

  private power(): Node {
    const a = this.atom();
    if (this.isOp('^')) {
      this.i++;
      return { k: 'bin', op: '^', a, b: this.unary() };
    }
    return a;
  }

  private atom(): Node {
    const t = this.peek();
    if (!t) throw new CalcError('식이 덜 끝났습니다.');
    if (t.t === 'num') {
      this.i++;
      const n: Node = { k: 'num', v: Number(t.v) };
      // 단위 붙은 수
      const u = this.peek();
      if (u && u.t === 'id' && LENGTH_UNITS[u.v.toLowerCase()] !== undefined && !this.isCall()) {
        this.i++;
        return { k: 'bin', op: 'unit', a: n, b: { k: 'unit', name: u.v.toLowerCase() } };
      }
      return n;
    }
    if (t.t === 'str') {
      this.i++;
      return { k: 'unit', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const n = this.expr();
      this.expect(')');
      return n;
    }
    if (t.t === 'op' && t.v === '[') {
      this.i++;
      const items: Node[] = [];
      if (!this.isOp(']')) {
        // 빈 자리는 0([,5] = [0,5])
        for (;;) {
          if (this.isOp(',') || this.isOp(']')) items.push({ k: 'num', v: 0 });
          else items.push(this.expr());
          if (this.isOp(',')) {
            this.i++;
            continue;
          }
          break;
        }
      }
      this.expect(']');
      if (items.length < 2 || items.length > 3) throw new CalcError('점은 [x,y] 또는 [x,y,z]로 씁니다.');
      return { k: 'vec', items };
    }
    if (t.t === 'id') {
      this.i++;
      const name = t.v;
      const low = name.toLowerCase();
      if (this.isOp('(')) {
        this.i++;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          for (;;) {
            const a = this.peek();
            // cvunit·getvar의 이름 인수는 따옴표 없이도 쓴다
            if (a && a.t === 'id' && (low === 'cvunit' || low === 'getvar') && this.toks[this.i + 1]?.t === 'op' && /[,)]/.test(this.toks[this.i + 1]!.v)) {
              this.i++;
              args.push({ k: 'unit', name: a.v });
            } else args.push(this.expr());
            if (this.isOp(',')) {
              this.i++;
              continue;
            }
            break;
          }
        }
        this.expect(')');
        if (!FUNCS.has(low)) throw new CalcError(`알 수 없는 함수 "${name}"`);
        return { k: 'call', name: low, args };
      }
      if (PICK_FUNCS.has(low)) return { k: 'pick', kind: low, index: this.picks++ };
      return { k: 'var', name };
    }
    throw new CalcError(`"${t.v}"이(가) 올바르지 않은 자리에 있습니다.`);
  }

  private isCall(): boolean {
    const nx = this.toks[this.i + 1];
    return !!nx && nx.t === 'op' && nx.v === '(';
  }
}

export interface CalcExpr {
  root: Node;
  /** 계산 전에 물어야 할 점(순서대로) */
  picks: string[];
}

export function parseCalc(src: string): CalcExpr {
  const root = new Parser(tokenize(src)).parse();
  const picks: string[] = [];
  const walk = (n: Node) => {
    switch (n.k) {
      case 'pick':
        picks[n.index] = n.kind;
        break;
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
        n.args.forEach(walk);
        break;
    }
  };
  walk(root);
  return { root, picks };
}

export interface CalcEnv {
  /** 도면 단위의 밀리미터 값(INSUNITS_MM). 단위 붙은 수를 이 단위로 바꾼다 */
  unitMm?: number;
  vars?: Map<string, CalcValue>;
  /** 고른 점(pick 순서) */
  points?: { x: number; y: number; z?: number }[];
  getvar?: (name: string) => CalcValue | undefined;
}

const DEG = Math.PI / 180;

function isVec(v: CalcValue): v is { x: number; y: number; z: number } {
  return typeof v === 'object';
}

function num(v: CalcValue, what: string): number {
  if (isVec(v)) throw new CalcError(`${what}에는 점이 아니라 수가 필요합니다.`);
  return v;
}

function vec(v: CalcValue, what: string): { x: number; y: number; z: number } {
  if (!isVec(v)) throw new CalcError(`${what}에는 점이 필요합니다.`);
  return v;
}

function unitFactor(name: string): number {
  const f = LENGTH_UNITS[name.toLowerCase()];
  if (f === undefined) throw new CalcError(`알 수 없는 단위 "${name}"`);
  return f;
}

export function evaluateCalc(expr: CalcExpr, env: CalcEnv = {}): CalcValue {
  const unitMm = env.unitMm && env.unitMm > 0 ? env.unitMm : 1;
  const ev = (n: Node): CalcValue => {
    switch (n.k) {
      case 'num':
        return n.v;
      case 'unit':
        throw new CalcError(`"${n.name}"은(는) 여기에 쓸 수 없습니다.`);
      case 'vec': {
        const v = n.items.map((x) => num(ev(x), '점의 좌표'));
        return { x: v[0]!, y: v[1]!, z: v[2] ?? 0 };
      }
      case 'var': {
        const low = n.name.toLowerCase();
        if (low === 'pi') return Math.PI;
        if (low === 'e') return Math.E;
        const v = env.vars?.get(n.name) ?? env.vars?.get(low) ?? env.vars?.get(n.name.toUpperCase());
        if (v === undefined) throw new CalcError(`정의되지 않은 변수 "${n.name}"`);
        return v;
      }
      case 'pick': {
        const p = env.points?.[n.index];
        if (!p) throw new CalcError(`점(${n.kind})을 고르지 않았습니다.`);
        return { x: p.x, y: p.y, z: p.z ?? 0 };
      }
      case 'un': {
        const a = ev(n.a);
        if (n.op === '+') return a;
        return isVec(a) ? { x: -a.x, y: -a.y, z: -a.z } : -a;
      }
      case 'bin': {
        if (n.op === 'unit') {
          const f = unitFactor((n.b as { name: string }).name);
          return (num(ev(n.a), '단위') * f) / unitMm;
        }
        return binary(n.op, ev(n.a), ev(n.b));
      }
      case 'call':
        return call(n.name, n.args, ev);
    }
  };
  const r = ev(expr.root);
  if (isVec(r) ? ![r.x, r.y, r.z].every(Number.isFinite) : !Number.isFinite(r)) throw new CalcError('결과가 수가 아닙니다(0으로 나누기 등).');
  return r;
}

function binary(op: string, a: CalcValue, b: CalcValue): CalcValue {
  switch (op) {
    case '+':
    case '-': {
      const s = op === '+' ? 1 : -1;
      if (isVec(a) && isVec(b)) return { x: a.x + s * b.x, y: a.y + s * b.y, z: a.z + s * b.z };
      if (isVec(a) || isVec(b)) throw new CalcError('점과 수는 더하거나 뺄 수 없습니다.');
      return a + s * b;
    }
    case '*':
      if (isVec(a) && isVec(b)) return a.x * b.x + a.y * b.y + a.z * b.z;
      if (isVec(a)) return { x: a.x * (b as number), y: a.y * (b as number), z: a.z * (b as number) };
      if (isVec(b)) return { x: b.x * a, y: b.y * a, z: b.z * a };
      return a * b;
    case '/': {
      const d = num(b, '나누는 값');
      if (d === 0) throw new CalcError('0으로 나눌 수 없습니다.');
      if (isVec(a)) return { x: a.x / d, y: a.y / d, z: a.z / d };
      return a / d;
    }
    case '&': {
      const p = vec(a, '외적(&)');
      const q = vec(b, '외적(&)');
      return { x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x };
    }
    case '^':
      return Math.pow(num(a, '거듭제곱'), num(b, '거듭제곱'));
  }
  throw new CalcError(`알 수 없는 연산 "${op}"`);
}

function call(name: string, args: Node[], ev: (n: Node) => CalcValue): CalcValue {
  const need = (n: number) => {
    if (args.length !== n) throw new CalcError(`${name} 함수에는 인수 ${n}개가 필요합니다.`);
  };
  const N = (i: number) => num(ev(args[i]!), `${name}의 인수`);
  switch (name) {
    case 'sin':
    case 'cos':
    case 'tan':
      need(1);
      return Math[name](N(0) * DEG);
    case 'asin':
    case 'acos':
    case 'atan': {
      need(1);
      const v = Math[name](N(0));
      return v / DEG;
    }
    case 'sqrt':
      need(1);
      if (N(0) < 0) throw new CalcError('음수의 제곱근은 구할 수 없습니다.');
      return Math.sqrt(N(0));
    case 'sqr':
      need(1);
      return N(0) * N(0);
    case 'abs': {
      need(1);
      const v = ev(args[0]!);
      return isVec(v) ? Math.hypot(v.x, v.y, v.z) : Math.abs(v);
    }
    case 'ln':
      need(1);
      return Math.log(N(0));
    case 'log':
      need(1);
      return Math.log10(N(0));
    case 'exp':
      need(1);
      return Math.exp(N(0));
    case 'exp10':
      need(1);
      return Math.pow(10, N(0));
    case 'pow':
      need(2);
      return Math.pow(N(0), N(1));
    case 'round':
      need(1);
      return Math.round(N(0));
    case 'trunc':
      need(1);
      return Math.trunc(N(0));
    case 'floor':
      need(1);
      return Math.floor(N(0));
    case 'ceil':
      need(1);
      return Math.ceil(N(0));
    case 'min':
    case 'max':
      if (!args.length) throw new CalcError(`${name} 함수에는 인수가 필요합니다.`);
      return Math[name](...args.map((_, i) => N(i)));
    case 'r2d':
      need(1);
      return N(0) / DEG;
    case 'd2r':
      need(1);
      return N(0) * DEG;
    case 'dist': {
      need(2);
      const p = vec(ev(args[0]!), 'dist');
      const q = vec(ev(args[1]!), 'dist');
      return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    }
    case 'ang': {
      if (args.length !== 1 && args.length !== 2) throw new CalcError('ang 함수에는 점 1개 또는 2개가 필요합니다.');
      const p = vec(ev(args[0]!), 'ang');
      const d = args.length === 2 ? (() => {
        const q = vec(ev(args[1]!), 'ang');
        return { x: q.x - p.x, y: q.y - p.y };
      })() : p;
      let a = Math.atan2(d.y, d.x) / DEG;
      if (a < 0) a += 360;
      return a;
    }
    case 'cvunit': {
      need(3);
      const v = N(0);
      const from = args[1]!;
      const to = args[2]!;
      if (from.k !== 'unit' || to.k !== 'unit') throw new CalcError('cvunit(값, 단위, 단위) 꼴로 씁니다.');
      return (v * unitFactor(from.name)) / unitFactor(to.name);
    }
    case 'getvar':
      throw new CalcError('getvar는 계산 환경에서 처리합니다.');
  }
  throw new CalcError(`알 수 없는 함수 "${name}"`);
}

/** 식을 읽고 getvar(이름)를 그 값으로 바꿔 둔다(점 고르기는 picks로 남는다) */
export function prepareCalc(src: string, getvar?: (name: string) => CalcValue | undefined): CalcExpr {
  const expr = parseCalc(src);
  const fix = (n: Node): Node => {
    switch (n.k) {
      case 'call':
        if (n.name === 'getvar') {
          if (n.args.length !== 1 || n.args[0]!.k !== 'unit') throw new CalcError('getvar(변수 이름) 꼴로 씁니다.');
          const name = (n.args[0] as { name: string }).name;
          const v = getvar?.(name);
          if (v === undefined) throw new CalcError(`변수 "${name}"을(를) 읽을 수 없습니다.`);
          return isVec(v) ? { k: 'vec', items: [{ k: 'num', v: v.x }, { k: 'num', v: v.y }, { k: 'num', v: v.z }] } : { k: 'num', v };
        }
        return { ...n, args: n.args.map(fix) };
      case 'vec':
        return { ...n, items: n.items.map(fix) };
      case 'un':
        return { ...n, a: fix(n.a) };
      case 'bin':
        return { ...n, a: fix(n.a), b: fix(n.b) };
      default:
        return n;
    }
  };
  return { root: fix(expr.root), picks: expr.picks };
}

/** 식을 계산한다(점 고르기 함수는 env.points) */
export function calculate(src: string, env: CalcEnv = {}): CalcValue {
  return evaluateCalc(prepareCalc(src, env.getvar), env);
}

/** 결과를 글로(수는 유효 숫자 12자리, 점은 [x,y,z]) */
export function formatCalc(v: CalcValue, digits = 12): string {
  const f = (x: number) => {
    if (Object.is(x, -0) || Math.abs(x) < 1e-14) return '0';
    const s = Number(x.toPrecision(digits));
    return String(s);
  };
  return isVec(v) ? `[${f(v.x)},${f(v.y)},${f(v.z)}]` : f(v);
}

/** 멈춘 프롬프트의 답으로 넣을 글(점은 x,y[,z]) */
export function calcAnswer(v: CalcValue): string {
  if (!isVec(v)) return formatCalc(v);
  const f = (x: number) => formatCalc(x);
  return Math.abs(v.z) > 1e-12 ? `${f(v.x)},${f(v.y)},${f(v.z)}` : `${f(v.x)},${f(v.y)}`;
}
