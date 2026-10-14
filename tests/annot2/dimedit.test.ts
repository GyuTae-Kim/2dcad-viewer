/** DIMEDIT·DIMTEDIT·DIMSPACE·DIMOVERRIDE 계산 */
import { describe, expect, it } from 'vitest';
import { createAngularDimension, createLinearDimension, generateDimensionGeometry, rawDimVars } from '../../src/edit/dim';
import { autoSpacing, dimHome, dimJustify, dimNewText, dimOblique, dimRotateText, linearFeetW, spaceDimensions } from '../../src/edit/annot/dimedit';
import { DIM_VAR_BY_NAME, applyOverrides, dstyleXData, formatVarValue, parseVarValue } from '../../src/edit/annot/override';
import { parseDimOverrides } from '../../src/io/dxf/tagutil';
import { makeDoc } from '../dim/doc';

const P = (x: number, y: number) => ({ x, y, z: 0 });

describe('DIMEDIT', () => {
  it('홈은 사용자 위치와 회전을 지우고, DIMTEDIT 홈은 회전을 남긴다', () => {
    const doc = makeDoc();
    const d = createLinearDimension(doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0 });
    d.dimType |= 128;
    d.textRotation = 0.5;
    expect(dimHome(d, true)).toMatchObject({ textRotation: 0 });
    expect(dimHome(d, true).dimType & 128).toBe(0);
    expect(dimHome(d, false).textRotation).toBe(0.5);
    expect(dimNewText(d, '<> 참고').text).toBe('<> 참고');
    expect(dimNewText(d, '<>').text).toBe('');
    expect(dimRotateText(d, 1).textRotation).toBe(1);
  });

  it('기울기: 치수선 자리는 그대로, 보조선이 그 각으로', () => {
    const doc = makeDoc();
    const d = createLinearDimension(doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0 });
    const o = dimOblique(d, (60 * Math.PI) / 180)!;
    expect(o.obliqueAngle).toBeCloseTo(Math.PI / 3, 12);
    const { d1, d2 } = linearFeetW(o);
    expect(d1.y).toBeCloseTo(20, 9);
    expect(d2.y).toBeCloseTo(20, 9);
    // 보조선 방향 60°
    expect(Math.atan2(d2.y - o.defPoint3.y, d2.x - o.defPoint3.x)).toBeCloseTo(Math.PI / 3, 9);
    expect(dimOblique(d, 0)!.obliqueAngle).toBe(0);
    // 치수선과 나란한 각은 안 된다
    expect(dimOblique(d, Math.PI)).toBeNull();
    const ang = createAngularDimension(doc, P(0, 0), P(10, 0), P(0, 10), P(5, 5));
    expect(dimOblique(ang, 1)).toBeNull();
  });
});

describe('DIMTEDIT 왼쪽·오른쪽·중심', () => {
  it('DIMJUST 재지정(읽는 방향으로 본 쪽)과 DSTYLE 확장 데이터', () => {
    const doc = makeDoc();
    const ltr = createLinearDimension(doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0 });
    const rtl = createLinearDimension(doc, P(100, 0), P(0, 0), P(50, 20), { rotation: 0 });
    expect(dimJustify(ltr, 'L')!.overrides).toEqual({ 280: 1 });
    expect(dimJustify(ltr, 'R')!.overrides).toEqual({ 280: 2 });
    expect(dimJustify(rtl, 'L')!.overrides).toEqual({ 280: 2 });
    expect(dimJustify(rtl, 'C')!.overrides).toEqual({ 280: 0 });
    const l = dimJustify(ltr, 'L')!;
    expect(parseDimOverrides(l.xdata)).toEqual({ 280: 1 });
    // 문자가 첫 보조선 쪽으로
    const g0 = generateDimensionGeometry(doc, ltr);
    const g1 = generateDimensionGeometry(doc, l);
    expect(g1.textMid.x).toBeLessThan(g0.textMid.x - 10);
  });
});

describe('DIMSPACE', () => {
  it('나란한 선형 치수를 기준에서 간격마다(쪽마다 가까운 것부터), 0이면 정렬', () => {
    const doc = makeDoc();
    const base = createLinearDimension(doc, P(0, 0), P(100, 0), P(50, 10), { rotation: 0 });
    base.handle = 'B';
    const a = createLinearDimension(doc, P(0, 0), P(50, 0), P(25, 31), { rotation: 0 });
    a.handle = 'A';
    const b = createLinearDimension(doc, P(0, 0), P(70, 0), P(35, 17), { rotation: 0 });
    b.handle = 'C';
    const c = createLinearDimension(doc, P(0, 0), P(70, 0), P(35, -12), { rotation: 0 });
    c.handle = 'D';
    const v = createLinearDimension(doc, P(0, 0), P(0, 70), P(-10, 35), { rotation: Math.PI / 2 });
    v.handle = 'V';
    const r = spaceDimensions(base, [a, b, c, v], 8);
    expect(r.skipped.map((x) => x.handle)).toEqual(['V']);
    const y = Object.fromEntries(r.changed.map((x) => [x.handle, x.defPoint.y]));
    expect(y.C).toBeCloseTo(18, 12);
    expect(y.A).toBeCloseTo(26, 12);
    expect(y.D).toBeCloseTo(2, 12);
    const z = spaceDimensions(base, [a, b], 0);
    expect(z.changed.every((x) => Math.abs(x.defPoint.y - 10) < 1e-12)).toBe(true);
    // 자동 = 문자 높이 × 2 (ISO-25: 2.5)
    expect(autoSpacing(doc, base)).toBeCloseTo(5, 12);
  });

  it('같은 꼭짓점의 각도 치수는 호 반지름을 맞춘다', () => {
    const doc = makeDoc();
    const base = createAngularDimension(doc, P(0, 0), P(10, 0), P(0, 10), P(7, 7));
    base.handle = 'B';
    const o = createAngularDimension(doc, P(0, 0), P(10, 0), P(10, 10), P(20, 3));
    o.handle = 'O';
    const other = createAngularDimension(doc, P(5, 5), P(10, 5), P(5, 10), P(8, 8));
    other.handle = 'X';
    const r = spaceDimensions(base, [o, other], 4);
    expect(r.skipped.map((x) => x.handle)).toEqual(['X']);
    const rb = Math.hypot(7, 7);
    expect(Math.hypot(r.changed[0]!.defPoint.x, r.changed[0]!.defPoint.y)).toBeCloseTo(rb + 4, 9);
  });
});

describe('DIMOVERRIDE', () => {
  it('이름 → 코드(블록·문자 스타일은 핸들 코드)', () => {
    expect(DIM_VAR_BY_NAME.get('DIMBLK')).toBe(342);
    expect(DIM_VAR_BY_NAME.get('DIMTXSTY')).toBe(340);
    expect(DIM_VAR_BY_NAME.get('DIMSCALE')).toBe(40);
    expect(DIM_VAR_BY_NAME.get('DIMJOGANG')).toBe(50);
  });

  it('값 검사', () => {
    const doc = makeDoc();
    expect(parseVarValue(doc, 40, '2')).toEqual({ value: 2 });
    expect(parseVarValue(doc, 40, '-1').error).toBeTruthy();
    expect(parseVarValue(doc, 77, '1')).toEqual({ value: 1 });
    expect(parseVarValue(doc, 77, '7').error).toBeTruthy();
    expect(parseVarValue(doc, 90, '3').error).toBeTruthy();
    expect(parseVarValue(doc, 50, '30').value).toBeCloseTo(Math.PI / 6, 12);
    expect(parseVarValue(doc, 50, '95').error).toBeTruthy();
    expect(parseVarValue(doc, 173, 'ON')).toEqual({ value: 1 });
    expect(parseVarValue(doc, 278, ',')).toEqual({ value: 44 });
    expect(parseVarValue(doc, 371, '25')).toEqual({ value: 25 });
    expect(parseVarValue(doc, 371, '26').error).toBeTruthy();
    expect(parseVarValue(doc, 340, 'Standard')).toEqual({ value: '11' });
    expect(parseVarValue(doc, 340, '없는스타일').error).toBeTruthy();
    expect(parseVarValue(doc, 342, '_Dot')).toEqual({ needBlock: '_Dot' });
    expect(parseVarValue(doc, 342, '.')).toEqual({ value: 0 });
    expect(parseVarValue(doc, 3, 'mm')).toEqual({ value: 'mm' });
    expect(formatVarValue(doc, 'DIMJOGANG', Math.PI / 4)).toBe('45');
    expect(formatVarValue(doc, 'DIMDSEP', 44)).toBe(',');
  });

  it('재지정과 DSTYLE 확장 데이터를 함께 고치고 지운다', () => {
    const doc = makeDoc();
    const d = createLinearDimension(doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0, style: 'ISO-25' });
    d.xdata = [{ app: 'ACAD', items: [{ code: 1000, value: 'OTHER' }] }, { app: 'X', items: [{ code: 1000, value: 'y' }] }];
    const o = applyOverrides(d, { 140: 5, 340: '11', 77: 0 });
    expect(o.overrides).toEqual({ 140: 5, 340: '11', 77: 0 });
    expect(parseDimOverrides(o.xdata)).toEqual({ 77: 0, 140: 5, 340: '11' });
    expect(o.xdata!.find((x) => x.app === 'ACAD')!.items.slice(0, 1)).toEqual([{ code: 1000, value: 'OTHER' }]);
    expect(o.xdata!.find((x) => x.app === 'ACAD')!.items).toContainEqual({ code: 1005, value: '11' });
    expect(rawDimVars(doc, o).DIMTXT).toBe(5);
    expect(rawDimVars(doc, o).DIMTXSTY).toBe('Standard');
    // 더하기
    const o2 = applyOverrides(o, { 140: 3.5 });
    expect(o2.overrides).toEqual({ 140: 3.5, 340: '11', 77: 0 });
    // 지우기
    const c = applyOverrides(o2, null);
    expect(c.overrides).toBeUndefined();
    expect(parseDimOverrides(c.xdata)).toBeUndefined();
    expect(c.xdata!.map((x) => x.app)).toEqual(['ACAD', 'X']);
    expect(dstyleXData(undefined, undefined)).toBeUndefined();
  });
});
