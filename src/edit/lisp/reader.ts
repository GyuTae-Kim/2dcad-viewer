/**
 * AutoLISP 읽기: 글 → 값(화면·DOM 없음).
 * 정수(32비트를 넘으면 실수)·실수·문자열("\n" "\t" "\e" "\\" "\"" "\nnn" 8진)·기호(대소문자 무시)·목록·점 쌍·따옴표(').
 * 주석은 ;부터 줄 끝, ;| … |;는 여러 줄. nil은 빈 목록, T는 기호 T.
 */
import { Cons, LispError, MSG, Real, Sym, type Symbols, type Value } from './types';

/** 읽을 식이 더 없음 */
export const EOF: unique symbol = Symbol('eof');

const DELIM = /[\s()";']/;
const INT_RE = /^[+-]?\d+$/;
const REAL_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?$/i;

export class LispReader {
  pos = 0;
  /** 지금 줄 번호(1부터) */
  line = 1;
  private readonly quote: Sym;

  constructor(
    readonly text: string,
    private readonly syms: Symbols,
  ) {
    this.quote = syms.intern('QUOTE');
    if (text.charCodeAt(0) === 0xfeff) this.pos = 1;
  }

  /** 다음 식. 없으면 EOF */
  read(): Value | typeof EOF {
    this.skip();
    if (this.pos >= this.text.length) return EOF;
    return this.form();
  }

  /** 남은 글이 공백·주석뿐인가 */
  get done(): boolean {
    this.skip();
    return this.pos >= this.text.length;
  }

  private skip(): void {
    const s = this.text;
    while (this.pos < s.length) {
      const c = s[this.pos]!;
      if (c === '\n') {
        this.line++;
        this.pos++;
      } else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ') this.pos++;
      else if (c === ';') {
        if (s[this.pos + 1] === '|') {
          const end = s.indexOf('|;', this.pos + 2);
          const stop = end < 0 ? s.length : end + 2;
          for (let i = this.pos; i < stop; i++) if (s[i] === '\n') this.line++;
          this.pos = stop;
        } else {
          while (this.pos < s.length && s[this.pos] !== '\n') this.pos++;
        }
      } else break;
    }
  }

  private form(): Value {
    const s = this.text;
    const c = s[this.pos]!;
    if (c === '(') {
      this.pos++;
      return this.listBody();
    }
    if (c === ')') {
      this.pos++;
      throw new LispError(MSG.extraParen);
    }
    if (c === "'") {
      this.pos++;
      this.skip();
      if (this.pos >= s.length) throw new LispError(MSG.malformedList);
      return new Cons(this.quote, new Cons(this.form(), null));
    }
    if (c === '"') return this.string();
    return this.atom();
  }

  private listBody(): Value {
    const s = this.text;
    const items: Value[] = [];
    let tail: Value = null;
    for (;;) {
      this.skip();
      if (this.pos >= s.length) throw new LispError(MSG.malformedList);
      const c = s[this.pos]!;
      if (c === ')') {
        this.pos++;
        break;
      }
      // 점 쌍의 점: 앞뒤가 구분자인 "."
      if (c === '.' && (this.pos + 1 >= s.length || DELIM.test(s[this.pos + 1]!))) {
        if (!items.length) throw new LispError(MSG.dot);
        this.pos++;
        this.skip();
        if (this.pos >= s.length) throw new LispError(MSG.malformedList);
        if (s[this.pos] === ')') throw new LispError(MSG.dot);
        tail = this.form();
        this.skip();
        if (this.pos >= s.length) throw new LispError(MSG.malformedList);
        if (s[this.pos] !== ')') throw new LispError(MSG.dot);
        this.pos++;
        break;
      }
      items.push(this.form());
    }
    let r: Value = tail;
    for (let i = items.length - 1; i >= 0; i--) r = new Cons(items[i]!, r);
    return r;
  }

  private string(): string {
    const s = this.text;
    let i = this.pos + 1;
    let out = '';
    for (;;) {
      if (i >= s.length) throw new LispError(MSG.malformedString);
      const c = s[i]!;
      if (c === '"') {
        i++;
        break;
      }
      if (c === '\n') this.line++;
      if (c === '\\' && i + 1 < s.length) {
        const n = s[i + 1]!;
        i += 2;
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'e') out += '\x1b';
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && i < s.length && /[0-7]/.test(s[i]!)) oct += s[i++];
          out += String.fromCharCode(parseInt(oct, 8));
        } else out += n;
        continue;
      }
      out += c;
      i++;
    }
    this.pos = i;
    return out;
  }

  private atom(): Value {
    const s = this.text;
    const start = this.pos;
    while (this.pos < s.length && !DELIM.test(s[this.pos]!)) this.pos++;
    const tok = s.slice(start, this.pos);
    return parseAtom(tok, this.syms);
  }
}

/** 낱말 하나 → 수·nil·기호 */
export function parseAtom(tok: string, syms: Symbols): Value {
  if (INT_RE.test(tok)) {
    const n = Number(tok);
    return n >= -2147483648 && n <= 2147483647 ? n : new Real(n);
  }
  if (REAL_RE.test(tok)) return new Real(Number(tok));
  const up = tok.toUpperCase();
  if (up === 'NIL') return null;
  return syms.intern(up);
}

/** 글의 식을 모두 읽는다(시험·LOAD) */
export function readAll(text: string, syms: Symbols): Value[] {
  const r = new LispReader(text, syms);
  const out: Value[] = [];
  for (;;) {
    const v = r.read();
    if (v === EOF) return out;
    out.push(v);
  }
}

/**
 * start의 '('에서 시작하는 식의 끝(닫는 괄호 다음 자리). 닫히지 않았으면 -1.
 * 문자열과 주석 안의 괄호는 세지 않는다(스크립트·명령행이 식 하나를 통째로 넘길 때).
 */
export function lispExtent(text: string, start: number): number {
  let depth = 0;
  let i = start;
  const s = text;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      if (i >= s.length) return -1;
      i++;
      continue;
    }
    if (c === ';') {
      if (s[i + 1] === '|') {
        const e = s.indexOf('|;', i + 2);
        if (e < 0) return -1;
        i = e + 2;
      } else {
        const e = s.indexOf('\n', i);
        if (e < 0) return -1;
        i = e + 1;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth <= 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** 명령행 입력이 아직 닫히지 않은 AutoLISP 식인가(공백을 글자로 받을 때) */
export function lispUnclosed(text: string): boolean {
  const t = text.replace(/^\s+/, '');
  if (!t.startsWith('(')) return false;
  return lispExtent(t, 0) < 0;
}
