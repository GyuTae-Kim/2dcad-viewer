import { describe, expect, it } from 'vitest';
import { EOF, LispReader, lispExtent, lispUnclosed, readAll } from '../../src/edit/lisp/reader';
import { formatReal, prin1, princ } from '../../src/edit/lisp/printer';
import { Cons, LispError, Real, Sym, Symbols } from '../../src/edit/lisp/types';

const read1 = (s: string) => {
  const r = new LispReader(s, new Symbols()).read();
  if (r === EOF) throw new Error('EOF');
  return r;
};
const show = (s: string) => readAll(s, new Symbols()).map(prin1).join(' | ');

describe('AutoLISP 읽기', () => {
  it('정수·실수·문자열·기호', () => {
    expect(read1('42')).toBe(42);
    expect(read1('-7')).toBe(-7);
    expect(read1('2147483648')).toBeInstanceOf(Real);
    expect((read1('1.5') as Real).v).toBe(1.5);
    expect((read1('1.') as Real).v).toBe(1);
    expect((read1('.5') as Real).v).toBe(0.5);
    expect((read1('1e3') as Real).v).toBe(1000);
    expect(read1('"a\\"b\\\\c\\nd"')).toBe('a"b\\c\nd');
    expect(read1('"\\101\\e"')).toBe('A\x1b');
    const s = read1('setQ');
    expect(s).toBeInstanceOf(Sym);
    expect((s as Sym).name).toBe('SETQ');
    expect(read1('nil')).toBeNull();
    expect((read1('t') as Sym).name).toBe('T');
    expect((read1('c:foo') as Sym).name).toBe('C:FOO');
    expect((read1('1+') as Sym).name).toBe('1+');
  });

  it('기호는 대소문자를 가리지 않는다(같은 기호)', () => {
    const syms = new Symbols();
    const [a, b] = readAll('Foo FOO', syms);
    expect(a).toBe(b);
  });

  it('목록·점 쌍·따옴표·중첩', () => {
    expect(show("(1 2 (3 4) . 5)")).toBe('(1 2 (3 4) . 5)');
    expect(show("'(a . b)")).toBe('(QUOTE (A . B))');
    expect(show("(8 . \"0\")")).toBe('(8 . "0")');
    expect(show('(10 1.0 2.0 0.0)')).toBe('(10 1.0 2.0 0.0)');
    expect(show('()')).toBe('nil');
    expect(show('(a.b)')).toBe('(A.B)');
  });

  it('주석: ; 줄 끝, ;| 여러 줄 |;', () => {
    expect(show('1 ; 주석 (\n2 ;| (여러\n줄) |; 3')).toBe('1 | 2 | 3');
  });

  it('형식 오류', () => {
    expect(() => readAll('(1 2', new Symbols())).toThrow(LispError);
    expect(() => readAll('(1 2', new Symbols())).toThrow('잘못된 형식의 목록');
    expect(() => readAll(')', new Symbols())).toThrow('오른쪽 괄호');
    expect(() => readAll('"abc', new Symbols())).toThrow('문자열');
    expect(() => readAll('( . 1)', new Symbols())).toThrow('점');
  });

  it('줄 번호를 센다', () => {
    const r = new LispReader('(a\n b)\n\n(c)', new Symbols());
    r.read();
    expect(r.line).toBe(2);
    r.read();
    expect(r.line).toBe(4);
  });

  it('식의 끝·닫히지 않은 식(명령행·스크립트)', () => {
    expect(lispExtent('(a (b) ")" c) d', 0)).toBe(13);
    expect(lispExtent('(a ; )\n b)', 0)).toBe(10);
    expect(lispExtent('(a "(" ', 0)).toBe(-1);
    expect(lispUnclosed('(setq a ')).toBe(true);
    expect(lispUnclosed('(setq a 1)')).toBe(false);
    expect(lispUnclosed('LINE')).toBe(false);
    expect(lispUnclosed('(princ "a b')).toBe(true);
  });
});

describe('AutoLISP 찍기', () => {
  it('실수는 유효 숫자 6자리', () => {
    expect(formatReal(1)).toBe('1.0');
    expect(formatReal(1 / 3)).toBe('0.333333');
    expect(formatReal(3.14159265)).toBe('3.14159');
    expect(formatReal(123456.789)).toBe('123457.0');
    expect(formatReal(1234567)).toBe('1.23457e+06');
    expect(formatReal(0.0001)).toBe('0.0001');
    expect(formatReal(0.00001)).toBe('1.0e-05');
    expect(formatReal(-2.5)).toBe('-2.5');
    expect(formatReal(0)).toBe('0.0');
  });

  it('prin1과 princ', () => {
    expect(prin1('a"b\n')).toBe('"a\\"b\\n"');
    expect(princ('a"b')).toBe('a"b');
    expect(prin1(new Cons(1, new Cons('x', null)))).toBe('(1 "x")');
    expect(princ(new Cons(1, new Cons('x', null)))).toBe('(1 x)');
    expect(prin1(null)).toBe('nil');
  });
});
