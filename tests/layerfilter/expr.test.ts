/**
 * AutoCAD 도면층 필터 식 ↔ 이 앱 필터 정의 행: 실물에서 본 꼴(대화상자 식, 예전 필터를 옮긴 식, 빈 식)을 읽고,
 * 행을 확인한 열 이름으로만 쓰며, 바꿀 수 없는 식은 null(읽기 전용)이고, 그런 식도 아는 열로 따진다.
 */
import { describe, expect, it } from 'vitest';
import type { Layer } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EMPTY_EXPRESSION, expressionToRows, parseFilterExpression, rowsToExpression, unwritableColumns } from '../../src/edit/layerfilter/expr';
import { expressionMatcher, matchContext, rowsMatch } from '../../src/edit/layerfilter/match';

describe('식 읽기', () => {
  it('대화상자 꼴·예전 필터를 옮긴 꼴·빈 식', () => {
    expect(expressionToRows('NAME=="A-*"')).toEqual([{ NAME: 'A-*' }]);
    expect(expressionToRows('COLOR=="1"')).toEqual([{ COLOR: '1' }]);
    expect(expressionToRows('( NAME== "A_ANNO*" or NAME== "A_AREA*" )')).toEqual([{ NAME: 'A_ANNO*' }, { NAME: 'A_AREA*' }]);
    expect(expressionToRows('( NAME== "Xref_*" ) and FROZEN == "FALSE"')).toEqual([{ NAME: 'Xref_*', FROZEN: 'THAWED' }]);
    expect(expressionToRows('""""')).toEqual([]);
    expect(expressionToRows('')).toEqual([]);
    // ADN 블로그의 대화상자 식에서 VPOVERRIDES만 뺀 것
    expect(expressionToRows('USED=="TRUE" AND NAME=="A*" AND OFF=="False" AND FROZEN=="True" AND LOCKED=="True" AND COLOR=="10" AND LINETYPE=="DASHED" AND LINEWEIGHT=="0.18" AND PLOTTABLE=="True" AND NEWVPFROZEN=="True"')).toEqual([
      { STATUS: 'USED', NAME: 'A*', ON: 'ON', FROZEN: 'FROZEN', LOCKED: 'LOCKED', COLOR: '10', LINETYPE: 'DASHED', LINEWEIGHT: '18', PLOT: 'PLOT', NEWVPFROZEN: 'FROZEN' },
    ]);
  });

  it('AND·OR 우선순위, NOT·!=는 부정 무늬나 반대 값으로 펼친다', () => {
    expect(expressionToRows('NAME=="A*" AND COLOR=="1" OR LOCKED=="TRUE"')).toEqual([{ NAME: 'A*', COLOR: '1' }, { LOCKED: 'LOCKED' }]);
    expect(expressionToRows('(NAME=="A*" or NAME=="B*") and OFF=="false"')).toEqual([
      { NAME: 'A*', ON: 'ON' },
      { NAME: 'B*', ON: 'ON' },
    ]);
    expect(expressionToRows('NAME!="A*" AND OFF!="TRUE"')).toEqual([{ NAME: '~A*', ON: 'ON' }]);
    expect(expressionToRows('NOT (NAME=="A*" OR LOCKED=="True")')).toEqual([{ NAME: '~A*', LOCKED: 'UNLOCKED' }]);
    expect(expressionToRows('NAME==A*')).toEqual([{ NAME: 'A*' }]);
  });

  it('바꿀 수 없는 식은 null: 모르는 열, 같은 열 두 값, 쉼표 무늬의 부정, 읽을 수 없는 글, 빈 값', () => {
    expect(expressionToRows('VPOVERRIDES=="FALSE"')).toBeNull();
    expect(expressionToRows('NAME=="A*" AND NAME=="*B"')).toBeNull();
    expect(expressionToRows('NAME!="A*,B*"')).toBeNull();
    expect(expressionToRows('NAME=="A*" AND')).toBeNull();
    expect(expressionToRows('NAME=="')).toBeNull();
    expect(expressionToRows('NAME==""')).toBeNull();
    expect(expressionToRows('FROZEN=="maybe"')).toBeNull();
    expect(parseFilterExpression('(NAME=="A*"')).toBeNull();
  });
});

describe('식 쓰기', () => {
  it('확인한 열 이름·값 꼴로, 행끼리 OR(조건이 여럿인 행은 괄호)', () => {
    expect(rowsToExpression([{ NAME: 'A-*' }])).toBe('NAME=="A-*"');
    expect(rowsToExpression([{ COLOR: '5', LOCKED: 'LOCKED', NAME: 'A*' }])).toBe('NAME=="A*" AND LOCKED=="True" AND COLOR=="5"');
    expect(rowsToExpression([{ NAME: 'A*', COLOR: '1' }, { ON: 'OFF' }])).toBe('(NAME=="A*" AND COLOR=="1") OR OFF=="True"');
    expect(rowsToExpression([{ STATUS: 'UNUSED', LINEWEIGHT: '25', PLOT: 'NOPLOT', NEWVPFROZEN: 'THAWED', FROZEN: 'THAWED' }])).toBe('USED=="FALSE" AND FROZEN=="False" AND LINEWEIGHT=="0.25" AND PLOTTABLE=="False" AND NEWVPFROZEN=="False"');
    expect(rowsToExpression([])).toBe(EMPTY_EXPRESSION);
    expect(rowsToExpression([{ NAME: '  ' }])).toBe(EMPTY_EXPRESSION);
  });

  it('확인하지 못한 열·값은 null(이 앱 기록으로 남긴다)', () => {
    for (const row of [{ TRANSPARENCY: '50' }, { PLOTSTYLE: 'Style1' }, { DESCRIPTION: '*벽*' }, { COLOR: '255,0,0' }, { COLOR: '1*' }, { LINEWEIGHT: '-3' }, { VPCOLOR: '1' }, { NAME: 'A"B' }]) {
      expect(rowsToExpression([row])).toBeNull();
    }
    expect(unwritableColumns([{ NAME: 'A*', TRANSPARENCY: '50' }, { DESCRIPTION: 'x', COLOR: '1' }])).toEqual(['TRANSPARENCY', 'DESCRIPTION']);
  });

  it('행 → 식 → 행 왕복', () => {
    const rows = [{ NAME: 'A-*', COLOR: '3', LOCKED: 'UNLOCKED' }, { STATUS: 'USED', LINETYPE: 'DASH*' }, { ON: 'ON', FROZEN: 'FROZEN', LINEWEIGHT: '0', PLOT: 'PLOT' }];
    expect(expressionToRows(rowsToExpression(rows)!)).toEqual(rows);
  });
});

describe('바꿀 수 없는 식 따지기', () => {
  const doc = createNewDocument('metric');
  const ctx = matchContext(doc, new Set(['A1']));
  const L = (name: string, p: Partial<Layer> = {}): Layer => ({ name, handle: '1', flags: 0, color: { aci: 1 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255, ...p });

  it('아는 열은 행 조건처럼, 모르는 열은 참, 읽을 수 없는 식은 거짓', () => {
    const m = expressionMatcher('USED=="TRUE" AND VPOVERRIDES=="FALSE" AND NAME=="A*"');
    expect(m(L('A1'), ctx)).toBe(true);
    expect(m(L('A2'), ctx)).toBe(false);
    expect(m(L('B1'), ctx)).toBe(false);
    expect(expressionMatcher('NAME!="A*" OR LOCKED=="True"')(L('A1', { locked: true }), ctx)).toBe(true);
    expect(expressionMatcher('NAME!="A*" OR LOCKED=="True"')(L('A1'), ctx)).toBe(false);
    expect(expressionMatcher('NAME==')(L('A1'), ctx)).toBe(false);
    expect(expressionMatcher('""""')(L('A1'), ctx)).toBe(true);
    // 바꿀 수 있는 식과 행의 결과가 같다
    const expr = '(NAME=="A*" AND COLOR=="1") OR OFF=="True"';
    for (const l of [L('A1'), L('A2', { color: { aci: 2 } }), L('B', { off: true }), L('B')]) expect(expressionMatcher(expr)(l, ctx)).toBe(rowsMatch(expressionToRows(expr)!, l, ctx));
  });
});
