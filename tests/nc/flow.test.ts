import { describe, expect, it } from 'vitest';
import { GExpr, evalMprExpr, type GVarRef } from '../../src/formats/nc/expr';
import { detectGcodeDialect, parseGcode } from '../../src/formats/nc/gcode';
import { moveEnd, type NcProgram } from '../../src/formats/nc/model';

const xs = (p: NcProgram): number[] => {
  const out: number[] = [];
  for (let i = 0; i < p.moves.count; i++) out.push(Math.round(moveEnd(p.moves, i)[0] * 1000) / 1000);
  return out;
};
const run = (text: string, opts = {}): NcProgram => parseGcode(text, { initialPosition: [0, 0, 0], ...opts });

describe('식 계산', () => {
  const vars = new Map<GVarRef, number>([
    [1, 3],
    [2, 4],
    ['_x', 7],
  ]);
  const g = (s: string): number | undefined => new GExpr(s, 0, { get: (r) => vars.get(r) }).expr();
  it('G-code 식: 대괄호·변수·함수·낱말 연산', () => {
    expect(g('[#1+#2]*2')).toBe(14);
    expect(g('#1+#2*2')).toBe(11);
    expect(g('SQRT[#1*#1+#2*#2]')).toBe(5);
    expect(g('SIN[30]')).toBeCloseTo(0.5);
    expect(g('ATAN[1]/[1]')).toBeCloseTo(45);
    expect(g('10MOD3')).toBe(1);
    expect(g('2**3')).toBe(8);
    expect(g('#1GT2')).toBe(1);
    expect(g('#1EQ3AND#2LT4')).toBe(0);
    expect(g('#[#1-2]')).toBe(3);
    expect(g('#<_x>+1')).toBe(8);
    expect(g('#99+1')).toBe(1); // 빈 변수는 0
    expect(g('-[#1]')).toBe(-3);
    expect(g('ROUND[2.5]+FIX[-1.5]+FUP[1.2]')).toBe(3 - 2 + 2);
  });
  it('MPR 식: 이름·괄호·함수·비교·IF', () => {
    const env = new Map<string, number>([
      ['L', 600],
      ['B', 400],
      ['dicke', 19],
    ]);
    const m = (s: string): number => evalMprExpr(s, { get: (n) => env.get(n) });
    expect(m('L/2')).toBe(300);
    expect(m('(L-B)*2+dicke')).toBe(419);
    expect(m('2^3^2')).toBe(512);
    expect(m('SIN(30)*2')).toBeCloseTo(1);
    expect(m('ARCTAN(1)')).toBeCloseTo(45);
    expect(m('SQRT(16)+ABS(-2)')).toBe(6);
    expect(m('L>B')).toBe(1);
    expect(m('L<>600')).toBe(0);
    expect(m('IF L>500 THEN 32 ELSE 16')).toBe(32);
    expect(m('IF L<500 AND B>0 THEN 1 ELSE 2')).toBe(2);
    expect(m('MAX(L,B,1000)')).toBe(1000);
    expect(() => m('L+Q')).toThrow();
    expect(() => m('L+')).toThrow();
  });
});

describe('변수·제어(Fanuc 매크로)', () => {
  it('#변수 대입과 낱말 값', () => {
    const p = run(`#1=10
#2=[#1+5]*2
#3=#1+#2/2
G1 X#1 F100
X#2
X-#1
X[#3-0.5]`);
    expect(xs(p)).toEqual([10, 30, -10, 24.5]);
  });

  it('빈 변수 낱말은 생략한다', () => {
    const p = run(`G1 X5 Y5 F100
G1 X#7 Y10`);
    expect(moveEnd(p.moves, 1)).toEqual([5, 10, 0]);
  });

  it('WHILE DO END 반복', () => {
    const p = run(`#1=1
WHILE [#1 LE 3] DO1
G1 X#1 F100
#1=#1+1
END1
G1 X100`);
    expect(xs(p)).toEqual([1, 2, 3, 100]);
  });

  it('IF GOTO와 IF THEN', () => {
    const p = run(`#1=0
N10 #1=#1+1
G1 X#1 F100
IF [#1 LT 3] GOTO10
IF [#1 EQ 3] THEN #2=50
G1 X#2
GOTO 99
G1 X999
N99 G1 X7`);
    expect(xs(p)).toEqual([1, 2, 3, 50, 7]);
  });

  it('끝없는 반복은 블록 한도에서 멈춘다', () => {
    const p = run(`N1 G91 G1 X1 F100
GOTO1`, { maxBlocks: 1000 });
    expect(p.moves.count).toBe(500);
    expect(p.warnings.some((w) => w.includes('끝없는 반복'))).toBe(true);
  });

  it('M98/M99 부프로그램과 L 반복, P 앞자리 반복 수', () => {
    const p = run(`O0001
G90 G1 X0 F100
M98 P1000 L2
M98 P31000
G1 X100
M30
O1000
G91 X1
G90
M99`);
    expect(xs(p)).toEqual([1, 2, 3, 4, 5, 100]);
    expect(Array.from(p.moves.line).slice(0, 2)).toEqual([7, 7]);
  });

  it('없는 부프로그램은 경고', () => {
    const p = run(`M98 P5555
G1 X1 F100`);
    expect(xs(p)).toEqual([1]);
    expect(p.warnings.some((w) => w.includes('O5555'))).toBe(true);
  });

  it('G65 매크로 호출: 인수 → 지역 변수, 호출이 끝나면 원래 지역 변수', () => {
    const p = run(`#1=1
G65 P9000 A10 B20
G1 X#1 F100
M30
O9000
G1 X#1 F100
G1 X#2
M99`);
    expect(xs(p)).toEqual([10, 20, 1]);
  });

  it('M97 같은 프로그램 안 N 부르기(Haas)', () => {
    const p = run(`G1 X1 F100
M97 P100
G1 X3
M30
N100 G1 X2
M99`);
    expect(xs(p)).toEqual([1, 2, 3]);
  });
});

describe('LinuxCNC o-코드', () => {
  it('sub/call과 인수, 이름 변수', () => {
    const p = run(`o100 sub
  G1 X#1 Y#2 F100
  #<_last> = #1
o100 endsub
o100 call [5] [6]
o100 call [7] [8]
G1 X#<_last>`, { dialect: 'linuxcnc' });
    expect(xs(p)).toEqual([5, 7]);
    expect(moveEnd(p.moves, 1)).toEqual([7, 8, 0]);
    // 마지막 G1 X7은 제자리라 이동이 없다
    expect(p.moves.count).toBe(2);
  });

  it('if/elseif/else/endif', () => {
    const text = (v: number): string => `#1 = ${v}
o1 if [#1 LT 1]
  G1 X10 F100
o1 elseif [#1 LT 2]
  G1 X20 F100
o1 else
  G1 X30 F100
o1 endif
G1 Y1`;
    expect(xs(run(text(0)))[0]).toBe(10);
    expect(xs(run(text(1)))[0]).toBe(20);
    expect(xs(run(text(5)))[0]).toBe(30);
  });

  it('while/endwhile, do/while, repeat/endrepeat, break', () => {
    const p = run(`#1 = 0
o2 while [#1 LT 3]
  #1 = [#1 + 1]
  G1 X#1 F100
o2 endwhile
o3 do
  #1 = [#1 + 1]
  G1 X#1
o3 while [#1 LT 5]
o4 repeat [2]
  G91 G1 X10
o4 endrepeat
G90
o5 while [1]
  G1 X0
  o5 break
o5 endwhile
G1 Y1`, { dialect: 'linuxcnc' });
    expect(xs(p)).toEqual([1, 2, 3, 4, 5, 15, 25, 0, 0]);
  });

  it('방언 판별', () => {
    expect(detectGcodeDialect('o100 sub\nG1 X1\no100 endsub')).toBe('linuxcnc');
    expect(detectGcodeDialect('%\nO1234\nG0 X0\n#100=5\n%')).toBe('fanuc');
    expect(detectGcodeDialect('; Generated for GRBL\nG21\nG0 X1')).toBe('grbl');
    expect(detectGcodeDialect('(Mach3 post)\nG0 X1')).toBe('mach3');
    expect(detectGcodeDialect('0 BEGIN PGM A MM\n1 L X+1 R0 FMAX\n2 END PGM A MM')).toBe('heidenhain');
    expect(detectGcodeDialect('G0 X1 Y2\nG1 Z-1 F100')).toBe('iso');
  });
});
