import { describe, expect, it } from 'vitest';
import { ScriptReader, decodeScript, parseCommandWord, parseScriptPoint, scriptCommandName, stripKeywordPrefix } from '../../src/edit/script/reader';
import { columns, insertUnitFactor, polarArrayAngles, polarCountFrom, rectArrayOffsets } from '../../src/edit/script/dash';

/** 공백을 받지 않는 프롬프트로만 끝까지 읽기 */
function all(text: string): string[] {
  const r = new ScriptReader(text);
  const out: string[] = [];
  for (let t = r.next(); t; t = r.next()) out.push(t.text);
  return out;
}

describe('스크립트 입력 나누기', () => {
  it('공백·탭·줄바꿈은 Enter, 공백 두 개는 빈 Enter 하나 더', () => {
    expect(all('LINE 0,0 10,0  \nCIRCLE\t5,5 2\n')).toEqual(['LINE', '0,0', '10,0', '', '', 'CIRCLE', '5,5', '2']);
  });

  it('빈 줄은 Enter, CR LF·BOM은 지운다, 마지막 줄은 줄바꿈 없어도 입력', () => {
    expect(all('\uFEFFA\r\n\r\nB')).toEqual(['A', '', 'B']);
  });

  it('줄 첫 글자 ;는 주석(Enter도 아니다), 줄 가운데 ;는 글자', () => {
    expect(all('; 주석\nA;B\n;끝\n')).toEqual(['A;B']);
    const r = new ScriptReader(';x\n;y\nLINE\n');
    expect(r.next()).toEqual({ text: 'LINE', line: 3 });
  });

  it('공백을 받는 프롬프트는 줄 끝까지 한 입력', () => {
    const r = new ScriptReader('TEXT 0,0 2.5 0 Hello  world\n\nNEXT');
    expect([r.next()!.text, r.next()!.text, r.next()!.text, r.next()!.text].join('|')).toBe('TEXT|0,0|2.5|0');
    expect(r.next(true)).toEqual({ text: 'Hello  world', line: 1 });
    expect(r.next(true)).toEqual({ text: '', line: 2 });
    expect(r.next()).toEqual({ text: 'NEXT', line: 3 });
    expect(r.next()).toBeNull();
    expect(r.done).toBe(true);
  });

  it('따옴표로 감싼 입력은 공백 포함 한 입력(따옴표는 뗀다)', () => {
    expect(all('-LAYER M "My Layer" \n')).toEqual(['-LAYER', 'M', 'My Layer', '']);
    expect(all('"C:\\a b\\x.dwg"\n')).toEqual(['C:\\a b\\x.dwg']);
  });

  it('줄 번호와 처음부터 다시(RSCRIPT)', () => {
    const r = new ScriptReader('A\nB C\n');
    expect(r.next()!.line).toBe(1);
    expect(r.next()).toEqual({ text: 'B', line: 2 });
    expect(r.next()).toEqual({ text: 'C', line: 2 });
    r.reset();
    expect(r.next()).toEqual({ text: 'A', line: 1 });
    expect(r.lineCount).toBe(2);
  });
});

describe('접두어와 명령 이름', () => {
  it('_ . \' 접두어를 떼고 -는 남긴다', () => {
    expect(parseCommandWord('._line')).toEqual({ name: 'LINE', transparent: false, international: true, builtin: true });
    expect(parseCommandWord("'_zoom")).toMatchObject({ name: 'ZOOM', transparent: true, international: true });
    expect(parseCommandWord('_-insert')).toMatchObject({ name: '-INSERT', international: true });
    expect(parseCommandWord('_.')).toBeNull();
  });

  it('국제 키워드 _C → C(좌표·숫자는 그대로)', () => {
    expect(stripKeywordPrefix('_C')).toBe('C');
    expect(stripKeywordPrefix('_-1,2')).toBe('_-1,2');
    expect(stripKeywordPrefix('C')).toBe('C');
  });

  it('스크립트에서는 대화상자 명령 대신 명령행 버전(-이름)', () => {
    const has = (n: string) => ['-INSERT', '-LAYER', '-ARRAY', '-HATCH', '-ATTEDIT'].includes(n);
    expect(scriptCommandName('INSERT', 'INSERT', has)).toBe('-INSERT');
    expect(scriptCommandName('I', 'INSERT', has)).toBe('-INSERT');
    expect(scriptCommandName('LA', 'LAYER', has)).toBe('-LAYER');
    expect(scriptCommandName('ATTEDIT', 'EATTEDIT', has)).toBe('-ATTEDIT');
    // AutoCAD에서 원래 명령행인 HATCH·ARRAY는 그대로
    expect(scriptCommandName('HATCH', 'HATCH', has)).toBe('HATCH');
    expect(scriptCommandName('AR', 'ARRAYRECT', has)).toBe('ARRAYRECT');
    expect(scriptCommandName('LINE', 'LINE', has)).toBe('LINE');
    expect(scriptCommandName('-INSERT', '-INSERT', has)).toBe('-INSERT');
  });

  it('선택 프롬프트 좌표', () => {
    expect(parseScriptPoint('10,20', null)).toEqual({ x: 10, y: 20 });
    expect(parseScriptPoint('@5,5', { x: 1, y: 1 })).toEqual({ x: 6, y: 6 });
    expect(parseScriptPoint('-1.5,.5,3', null)).toEqual({ x: -1.5, y: 0.5 });
    const p = parseScriptPoint('10<90', null)!;
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(10);
    expect(parseScriptPoint('W', null)).toBeNull();
  });
});

describe('인코딩 판별', () => {
  it('UTF-8(BOM)·UTF-16LE·CP949', () => {
    const utf8 = new TextEncoder().encode('\uFEFF문자 열');
    expect(decodeScript(utf8)).toEqual({ text: '문자 열', encoding: 'utf-8' });
    const u16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x00, 0xac]);
    expect(decodeScript(u16)).toEqual({ text: 'A가', encoding: 'utf-16le' });
    // "가나" in CP949
    expect(decodeScript(new Uint8Array([0xb0, 0xa1, 0xb3, 0xaa, 0x0a]))).toEqual({ text: '가나\n', encoding: 'cp949' });
  });
});

describe('명령행 명령의 계산', () => {
  it('블록 단위 변환', () => {
    expect(insertUnitFactor(6, 4)).toBe(1000);
    expect(insertUnitFactor(1, 4)).toBeCloseTo(25.4);
    expect(insertUnitFactor(0, 4)).toBe(1);
    expect(insertUnitFactor(4, 0)).toBe(1);
  });

  it('클래식 직사각형 배열 위치(첫 항목 빼고, 스냅 각도)', () => {
    expect(rectArrayOffsets(2, 3, 10, 20)).toEqual([
      { x: 20, y: 0 },
      { x: 40, y: 0 },
      { x: 0, y: 10 },
      { x: 20, y: 10 },
      { x: 40, y: 10 },
    ]);
    const r = rectArrayOffsets(1, 2, 0, 10, Math.PI / 2);
    expect(r[0]!.x).toBeCloseTo(0);
    expect(r[0]!.y).toBeCloseTo(10);
  });

  it('클래식 원형 배열 각도·항목 수', () => {
    expect(polarArrayAngles(4, 2 * Math.PI).map((a) => Math.round((a * 180) / Math.PI))).toEqual([90, 180, 270]);
    expect(polarArrayAngles(3, Math.PI).map((a) => Math.round((a * 180) / Math.PI))).toEqual([90, 180]);
    expect(polarArrayAngles(3, 0, -Math.PI / 6).map((a) => Math.round((a * 180) / Math.PI))).toEqual([-30, -60]);
    expect(polarCountFrom(Math.PI / 2, Math.PI / 6)).toBe(4);
    expect(polarCountFrom(2 * Math.PI, Math.PI / 6)).toBe(12);
  });

  it('? 목록 열 나누기', () => {
    expect(columns(['A', 'B', 'C'], 2)).toEqual(['A       B', 'C']);
  });
});
