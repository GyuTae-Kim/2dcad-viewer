import { describe, expect, it } from 'vitest';
import { COMPARE_VARS, compareVar, defaultSettings, formatCompareColor, normalizeStored, parseCompareColor, parseInput } from '../../src/edit/compare/settings';

describe('비교 시스템 변수', () => {
  it('초기값', () => {
    const s = defaultSettings();
    expect(s).toEqual({
      color1: '82',
      color2: '1',
      colorCommon: '253',
      front: 1,
      hatch: false,
      text: true,
      props: 0,
      tolerance: 6,
      rcShape: 0,
      rcMargin: 5,
      show1: true,
      show2: true,
      showCommon: true,
      showRc: true,
    });
    expect(COMPARE_VARS.length).toBe(14);
  });

  it('저장된 값: 범위 밖은 가장 가까운 값, 숫자가 아니면 초기값', () => {
    expect(normalizeStored(compareVar('COMPARERCMARGIN')!, '40')).toBe(25);
    expect(normalizeStored(compareVar('comparercmargin')!, '0')).toBe(1);
    expect(normalizeStored(compareVar('COMPAREPROPS')!, '1')).toBe(1);
    expect(normalizeStored(compareVar('COMPARETOLERANCE')!, 'abc')).toBe(6);
    expect(normalizeStored(compareVar('COMPARECOLOR1')!, 'xyz')).toBe('82');
    expect(normalizeStored(compareVar('COMPARECOLOR1')!, '#29a500')).toBe('RGB:41,165,0');
  });

  it('색상 입력', () => {
    expect(parseCompareColor('82')).toEqual({ aci: 82 });
    expect(parseCompareColor('0')).toBeNull();
    expect(parseCompareColor('256')).toBeNull();
    expect(parseCompareColor('RGB:255,0,10')).toEqual({ rgb: 0xff000a });
    expect(parseCompareColor('255,0,10')).toEqual({ rgb: 0xff000a });
    expect(parseCompareColor('#00ff00')).toEqual({ rgb: 0x00ff00 });
    expect(parseCompareColor('RGB:300,0,0')).toBeNull();
    expect(formatCompareColor({ rgb: 0x29a500 })).toBe('RGB:41,165,0');
  });

  it('명령행 입력 검사', () => {
    expect(parseInput(compareVar('COMPAREFRONT')!, '2')).toEqual({ value: 2 });
    expect('error' in parseInput(compareVar('COMPAREFRONT')!, '3')).toBe(true);
    expect('error' in parseInput(compareVar('COMPARERCMARGIN')!, '2.5')).toBe(true);
    expect(parseInput(compareVar('COMPARECOLOR2')!, 'rgb:1,2,3')).toEqual({ value: 'RGB:1,2,3' });
  });
});
