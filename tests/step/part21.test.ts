import { describe, expect, it } from 'vitest';
import { decodeStepString, DERIVED, StepEnum, StepFile, StepRef, StepTyped } from '../../src/formats/step';

const enc = (s: string) => new TextEncoder().encode(s);

const SAMPLE = `ISO-10303-21;
HEADER;
/* 머리 주석 */
FILE_DESCRIPTION(('desc one','desc two'),'2;1');
FILE_NAME('part.stp','2026-01-01T00:00:00',('kim'),('org'),'pre 1.0','CAD X','');
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));
ENDSEC;
DATA;
#10=CARTESIAN_POINT('p',(1.,-2.5,3.E-3));
#11 = DIRECTION ( 'd' , ( 0. , 0. , 1. ) ) ;
#12=PRODUCT('id;1','it''s \\\\ a\\X\\E9 \\S\\i \\X2\\C81CD488\\X0\\ end','',(#13));
/* 데이터 주석; 세미콜론 포함 */
#13=PRODUCT_CONTEXT('',$,'mechanical');
#14=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));
#15=MEASURE_REPRESENTATION_ITEM('m',LENGTH_MEASURE(25.4),#14);
#16=B_SPLINE_CURVE_WITH_KNOTS('',1,(#10,#10),.UNSPECIFIED.,.F.,.U.,(2,2),(0.,1.),.UNSPECIFIED.);
#17=LIST_TEST(((1,2),(3,(4,5))),*,"0FF",-22.593750000000004,1.5E+2);
#1000000=CARTESIAN_POINT('far',(0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
`;

describe('Part 21 읽기', () => {
  const f = new StepFile(enc(SAMPLE));

  it('머리 정보', () => {
    expect(f.header.description).toEqual(['desc one', 'desc two']);
    expect(f.header.implementationLevel).toBe('2;1');
    expect(f.header.name).toBe('part.stp');
    expect(f.header.author).toEqual(['kim']);
    expect(f.header.originatingSystem).toBe('CAD X');
    expect(f.header.schemas[0]).toMatch(/^AP242/);
  });

  it('인스턴스 색인과 지연 해석', () => {
    expect(f.count).toBe(9);
    expect(f.skipped).toBe(0);
    expect(f.typeOf(10)).toBe('CARTESIAN_POINT');
    expect(f.typeOf(14)).toBe('COMPLEX');
    expect(f.has(1000000)).toBe(true);
    const p = f.get(10)!;
    expect(p.args[0]).toBe('p');
    expect(p.args[1]).toEqual([1, -2.5, 0.003]);
    const d = f.get(11)!;
    expect(d.type).toBe('DIRECTION');
    expect(d.args[1]).toEqual([0, 0, 1]);
    expect(f.get(999)).toBeUndefined();
  });

  it('문자열 인코딩(따옴표, 역빗금, \\X\\, \\S\\, \\X2\\)', () => {
    const prod = f.get(12)!;
    expect(prod.args[0]).toBe('id;1');
    expect(prod.args[1]).toBe("it's \\ aé é 제품 end");
    expect(prod.args[3]).toEqual([new StepRef(13)]);
    const x4 = enc('\\X4\\0001F600\\X0\\');
    expect(decodeStepString(x4, 0, x4.length)).toBe('😀');
    // 날 UTF-8 바이트도 읽는다
    const u = enc('한글');
    expect(decodeStepString(u, 0, u.length)).toBe('한글');
  });

  it('$, *, 열거, 형식 있는 값, 2진, 중첩 목록, 긴 유효 숫자', () => {
    const ctx = f.get(13)!;
    expect(ctx.args[1]).toBeNull();
    const m = f.get(15)!;
    expect(m.args[1]).toBeInstanceOf(StepTyped);
    expect((m.args[1] as StepTyped).type).toBe('LENGTH_MEASURE');
    expect((m.args[1] as StepTyped).value).toBe(25.4);
    const b = f.get(16)!;
    expect(b.args[3]).toEqual(new StepEnum('UNSPECIFIED'));
    expect((b.args[5] as StepEnum).value).toBe('U');
    const l = f.get(17)!;
    expect(l.args[0]).toEqual([
      [1, 2],
      [3, [4, 5]],
    ]);
    expect(l.args[1]).toBe(DERIVED);
    expect(l.args[3]).toBe(-22.593750000000004);
    expect(l.args[4]).toBe(150);
  });

  it('복합 인스턴스 부분과 형식별 찾기', () => {
    const u = f.get(14)!;
    expect(u.parts!.map((p) => p.type)).toEqual(['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
    expect(u.parts![1]!.args[0]).toBe(DERIVED);
    expect(f.idsOfType('SI_UNIT')).toEqual([14]);
    expect(f.idsOfType('CARTESIAN_POINT')).toEqual([10, 1000000]);
    expect(f.partNames(14)).toEqual(['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
  });

  it('문자열 속 줄바꿈은 무시한다(긴 문자열을 나눠 쓴 파일)', () => {
    const g = new StepFile(enc("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=PRODUCT('abc\r\ndef','',$,());\nENDSEC;\nEND-ISO-10303-21;\n"));
    expect(g.get(1)!.args[0]).toBe('abcdef');
  });

  it('깨진 문장은 건너뛰고 나머지를 읽는다', () => {
    const bad = new StepFile(enc("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2 GARBAGE;\n#3=DIRECTION('',(1.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n"));
    expect(bad.count).toBe(2);
    expect(bad.skipped).toBe(1);
    expect(bad.get(3)!.args[1]).toEqual([1, 0, 0]);
  });

  it('큰 파일 색인(5만 인스턴스)', () => {
    const parts = ['ISO-10303-21;HEADER;ENDSEC;DATA;'];
    for (let i = 1; i <= 50000; i++) parts.push(`#${i}=CARTESIAN_POINT('',(${i}.,${-i}.5,0.));`);
    parts.push('ENDSEC;END-ISO-10303-21;');
    const big = new StepFile(enc(parts.join('\n')));
    expect(big.count).toBe(50000);
    expect(big.get(43210)!.args[1]).toEqual([43210, -43210.5, 0]);
  });
});
