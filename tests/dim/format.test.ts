/** 치수 문자 서식(DIMLUNIT·DIMZIN·DIMPOST·공차·대체 단위·각도) */
import { describe, expect, it } from 'vitest';
import { DIM_VAR_DEFAULTS } from '../../src/core/dimvars';
import { dimensionText } from '../../src/edit/dim';
import { formatAngleValue, formatLinearValue } from '../../src/edit/dim/format';

const vars = (o: Record<string, number | string> = {}) => ({ ...DIM_VAR_DEFAULTS, ...o });
const T = (o: Record<string, number | string>, m: number, kind: Parameters<typeof dimensionText>[1] = 'linear', user = '') => dimensionText(vars(o), kind, m, user).mtext;

describe('길이 서식', () => {
  it('소수: 자리수·0 생략·소수점 기호', () => {
    expect(T({ DIMDEC: 4 }, 12.5)).toBe('12.5000');
    expect(T({ DIMDEC: 2, DIMZIN: 8 }, 12.5)).toBe('12.5');
    expect(T({ DIMDEC: 2, DIMZIN: 8 }, 12)).toBe('12');
    expect(T({ DIMDEC: 3, DIMZIN: 4 }, 0.5)).toBe('.500');
    expect(T({ DIMDEC: 3, DIMZIN: 12 }, 0.5)).toBe('.5');
    expect(T({ DIMDEC: 2, DIMDSEP: 44 }, 46.71561670814134)).toBe('46,72');
    expect(T({ DIMDEC: 2 }, 0.125)).toBe('0.13');
    expect(T({ DIMDEC: 0 }, 2.5)).toBe('3');
  });
  it('DIMRND·DIMLFAC·DIMPOST', () => {
    expect(T({ DIMDEC: 2, DIMRND: 0.25 }, 12.4)).toBe('12.50');
    expect(T({ DIMDEC: 1, DIMLFAC: 10 }, 1.23)).toBe('12.3');
    expect(T({ DIMDEC: 0, DIMPOST: '<> mm' }, 12)).toBe('12 mm');
    expect(T({ DIMDEC: 0, DIMPOST: 'L=<>' }, 12)).toBe('L=12');
    expect(T({ DIMDEC: 0, DIMPOST: 'mm' }, 12)).toBe('12mm');
  });
  it('반지름·지름 접두, DIMPOST 접두가 있으면 바꾼다', () => {
    expect(T({ DIMDEC: 1 }, 11.4, 'radius')).toBe('R11.4');
    expect(T({ DIMDEC: 1 }, 45.6, 'diameter')).toBe('\\U+220545.6');
    expect(T({ DIMDEC: 0, DIMPOST: 'RAD <>' }, 5, 'radius')).toBe('RAD 5');
  });
  it('건축·분수·공학·과학 단위', () => {
    // AutoCAD 예제 블록: 4'-0{\H1x;\S1#4;}"
    expect(T({ DIMLUNIT: 4, DIMDEC: 2, DIMFRAC: 1, DIMZIN: 8 }, 48.36356523110595)).toBe('4\'-0{\\H1x;\\S1#4;}"');
    expect(T({ DIMLUNIT: 4, DIMDEC: 3, DIMFRAC: 0 }, 30.5)).toBe('2\'-6{\\H1x;\\S1/2;}"');
    expect(T({ DIMLUNIT: 4, DIMDEC: 3, DIMFRAC: 2 }, 30.5)).toBe('2\'-6 1/2"');
    expect(T({ DIMLUNIT: 4, DIMDEC: 3, DIMZIN: 0 }, 48)).toBe("4'");
    expect(T({ DIMLUNIT: 4, DIMDEC: 3, DIMZIN: 0 }, 6)).toBe('6"');
    expect(T({ DIMLUNIT: 4, DIMDEC: 3, DIMZIN: 1 }, 48)).toBe('4\'-0"');
    expect(T({ DIMLUNIT: 5, DIMDEC: 2, DIMFRAC: 0, DIMTFAC: 0.7 }, 12.25)).toBe('12{\\H0.7x;\\S1/4;}');
    expect(T({ DIMLUNIT: 3, DIMDEC: 2 }, 48.36)).toBe('4\'-0.36"');
    expect(T({ DIMLUNIT: 1, DIMDEC: 2 }, 1234.5)).toBe('1.23E+03');
  });
  it('공차·한계·대체 단위', () => {
    expect(T({ DIMDEC: 2, DIMTOL: 1, DIMTP: 0.1, DIMTM: 0.1, DIMTDEC: 2 }, 10)).toBe('10.00\\U+00B10.10');
    expect(T({ DIMDEC: 2, DIMTOL: 1, DIMTP: 0.1, DIMTM: 0.05, DIMTDEC: 2, DIMTFAC: 0.7 }, 10)).toBe('10.00{\\H0.7x;\\S+0.10^-0.05;}');
    expect(T({ DIMDEC: 2, DIMLIM: 1, DIMTP: 0.1, DIMTM: 0.05 }, 10)).toBe('{\\H1x;\\S10.10^9.95;}');
    expect(T({ DIMDEC: 2, DIMALT: 1, DIMALTF: 25.4, DIMALTD: 1 }, 1)).toBe('1.00 [25.4]');
    expect(T({ DIMDEC: 2, DIMALT: 1, DIMALTF: 25.4, DIMALTD: 0, DIMAPOST: '[] mm' }, 1)).toBe('1.00 [25 mm]');
  });
  it('문자 재지정', () => {
    expect(T({ DIMDEC: 0 }, 12, 'linear', '<> TYP')).toBe('12 TYP');
    expect(T({ DIMDEC: 0 }, 12, 'linear', 'ABC')).toBe('ABC');
    expect(T({ DIMDEC: 0 }, 12, 'linear', ' ')).toBe('');
    expect(T({ DIMDEC: 0 }, 12, 'linear', '<>')).toBe('12');
  });
});

describe('각도 서식', () => {
  it('도(DIMADEC·DIMAZIN), 도분초, 그레이드, 라디안', () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(T({ DIMADEC: 0 }, 1.6475682180646782, 'angular')).toBe('94\\U+00B0');
    expect(T({ DIMADEC: 2, DIMAZIN: 2 }, deg(45.5), 'angular')).toBe('45.5\\U+00B0');
    expect(T({ DIMADEC: -1, DIMDEC: 1 }, deg(30), 'angular')).toBe('30.0\\U+00B0');
    expect(T({ DIMAUNIT: 1, DIMADEC: 4 }, deg(45.5042), 'angular')).toBe('45\\U+00B030\'15"');
    expect(T({ DIMAUNIT: 1, DIMADEC: 2 }, deg(45.5), 'angular')).toBe('45\\U+00B030\'');
    expect(T({ DIMAUNIT: 2, DIMADEC: 1 }, deg(90), 'angular')).toBe('100.0g');
    expect(T({ DIMAUNIT: 3, DIMADEC: 3 }, deg(90), 'angular')).toBe('1.571r');
    expect(formatAngleValue(deg(0.5), { unit: 0, dec: 2, zin: 1, dsep: 46 })).toBe('.50\\U+00B0');
  });
  it('호 길이 기호', () => {
    expect(T({ DIMDEC: 2 }, 20.944, 'arc')).toBe('\\U+222920.94');
    expect(T({ DIMDEC: 2, DIMARCSYM: 2 }, 20.944, 'arc')).toBe('20.94');
  });
  it('음수 길이 값', () => {
    expect(formatLinearValue(-1.5, { unit: 2, dec: 1, zin: 0, dsep: 46, frac: 0, tfac: 1 })).toBe('-1.5');
  });
});

describe('각도 공차', () => {
  it('DIMTP·DIMTM은 도 단위', () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(T({ DIMADEC: 0, DIMTOL: 1, DIMTP: 0.5, DIMTM: 0.5, DIMTDEC: 1 }, deg(30), 'angular')).toBe('30\\U+00B0\\U+00B10.5\\U+00B0');
  });
});
