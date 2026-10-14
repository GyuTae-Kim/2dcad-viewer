import { describe, expect, it } from 'vitest';
import { hasWildcard, wcmatch, wildRename } from '../../src/edit/util/wildcard';
import { CalcError, calcAnswer, calculate, formatCalc, parseCalc, evaluateCalc } from '../../src/edit/util/calc';

describe('wcmatch', () => {
  it('* ? # @ . 와 쉼표 목록, 부정, 괄호', () => {
    expect(wcmatch('WALL-01', 'WALL*')).toBe(true);
    expect(wcmatch('wall-01', 'WALL*')).toBe(true);
    expect(wcmatch('WALL-01', 'WALL*', false)).toBe(true);
    expect(wcmatch('wall-01', 'WALL*', false)).toBe(false);
    expect(wcmatch('A1', '@#')).toBe(true);
    expect(wcmatch('AB', '@#')).toBe(false);
    expect(wcmatch('A-B', 'A.B')).toBe(true);
    expect(wcmatch('AXB', 'A.B')).toBe(false);
    expect(wcmatch('DOOR', 'WIN*,DOOR')).toBe(true);
    expect(wcmatch('DOOR', '~DOOR')).toBe(false);
    expect(wcmatch('WINDOW', '~DOOR')).toBe(true);
    expect(wcmatch('B2', '[AB]#')).toBe(true);
    expect(wcmatch('C2', '[~AB]#')).toBe(true);
    expect(wcmatch('A2', '[~AB]#')).toBe(false);
    expect(wcmatch('A*B', 'A`*B')).toBe(true);
    expect(wcmatch('AXB', 'A`*B')).toBe(false);
    expect(wcmatch('벽체', '벽*')).toBe(true);
    expect(wcmatch('a?c', 'a?c')).toBe(true);
  });

  it('와일드카드 글자가 있는지', () => {
    expect(hasWildcard('WALL')).toBe(false);
    expect(hasWildcard('WALL*')).toBe(true);
  });

  it('이름 바꾸기 치환은 * ? 자리를 순서대로 옮긴다', () => {
    expect(wildRename('STAIR$12', 'STAIR$*', 'S_*')).toBe('S_12');
    expect(wildRename('A1B', '?1?', '?-?')).toBe('A-B');
    expect(wildRename('DOOR', 'STAIR*', 'S*')).toBeNull();
    expect(wildRename('stair-x', 'STAIR*', 'S*')).toBe('S-x');
  });
});

describe('calculate', () => {
  it('사칙·괄호·거듭제곱·단항', () => {
    expect(calculate('1+2*3')).toBe(7);
    expect(calculate('(1+2)*3')).toBe(9);
    expect(calculate('2^3^2')).toBe(512);
    expect(calculate('-2^2')).toBe(-4);
    expect(calculate('2^-1')).toBe(0.5);
    expect(calculate('10/4')).toBe(2.5);
    expect(calculate('.5 + 1e2')).toBe(100.5);
    expect(calculate('2pi')).toBeCloseTo(Math.PI * 2);
    expect(calculate('3(4+1)')).toBe(15);
    expect(calculate('6 × 7 ÷ 2')).toBe(21);
  });

  it('함수는 도 단위', () => {
    expect(calculate('sin(30)')).toBeCloseTo(0.5);
    expect(calculate('cos(60)+tan(45)')).toBeCloseTo(1.5);
    expect(calculate('atan(1)')).toBeCloseTo(45);
    expect(calculate('sqrt(16)+sqr(3)+abs(-2)')).toBe(15);
    expect(calculate('max(1,5,3)-min(4,2)')).toBe(3);
    expect(calculate('round(2.5)+trunc(-1.7)+floor(1.9)+ceil(1.1)')).toBe(3 - 1 + 1 + 2);
    expect(calculate('r2d(pi)')).toBeCloseTo(180);
    expect(calculate('d2r(180)')).toBeCloseTo(Math.PI);
    expect(calculate('log(1000)+ln(e)')).toBeCloseTo(4);
  });

  it('단위 붙은 수는 도면 단위로', () => {
    expect(calculate('1in')).toBeCloseTo(25.4);
    expect(calculate('2ft + 6in', { unitMm: 25.4 })).toBeCloseTo(30);
    expect(calculate('1m + 5cm')).toBeCloseTo(1050);
    expect(calculate('cvunit(1,inch,mm)')).toBeCloseTo(25.4);
    expect(calculate('cvunit(1000,"mm","m")')).toBeCloseTo(1);
    expect(calculate('3\'', { unitMm: 25.4 })).toBeCloseTo(36);
  });

  it('점(벡터) 연산', () => {
    expect(calculate('[1,2]+[3,4,5]')).toEqual({ x: 4, y: 6, z: 5 });
    expect(calculate('2*[1,2]')).toEqual({ x: 2, y: 4, z: 0 });
    expect(calculate('[2,4]/2')).toEqual({ x: 1, y: 2, z: 0 });
    expect(calculate('[1,0]*[0,1]')).toBe(0);
    expect(calculate('[1,0,0]&[0,1,0]')).toEqual({ x: 0, y: 0, z: 1 });
    expect(calculate('dist([0,0],[3,4])')).toBe(5);
    expect(calculate('ang([0,0],[0,5])')).toBeCloseTo(90);
    expect(calculate('abs([3,4])')).toBe(5);
    expect(calculate('[,5]')).toEqual({ x: 0, y: 5, z: 0 });
  });

  it('점 고르기 함수는 먼저 묻는다', () => {
    const e = parseCalc('(end+end)/2');
    expect(e.picks).toEqual(['end', 'end']);
    expect(evaluateCalc(e, { points: [{ x: 0, y: 0 }, { x: 10, y: 4 }] })).toEqual({ x: 5, y: 2, z: 0 });
  });

  it('변수와 getvar', () => {
    expect(calculate('a*2', { vars: new Map([['a', 21]]) })).toBe(42);
    expect(calculate('getvar(ltscale)*10', { getvar: (n) => (n.toUpperCase() === 'LTSCALE' ? 2 : undefined) })).toBe(20);
  });

  it('잘못된 식은 CalcError', () => {
    for (const s of ['', '1+', '(1', 'foo(1)', '1/0', 'sqrt(-1)', 'x', '[1]', '1 $ 2', '[1,2]+3', 'sin([1,2])']) expect(() => calculate(s), s).toThrow(CalcError);
  });

  it('결과 글과 프롬프트 답', () => {
    expect(formatCalc(0.1 + 0.2)).toBe('0.3');
    expect(formatCalc({ x: 1, y: 2, z: 0 })).toBe('[1,2,0]');
    expect(calcAnswer({ x: 1.5, y: -2, z: 0 })).toBe('1.5,-2');
    expect(calcAnswer(12)).toBe('12');
  });
});
