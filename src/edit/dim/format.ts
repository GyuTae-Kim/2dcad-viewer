/**
 * 치수 문자 만들기: 측정값을 DIMLUNIT·DIMDEC·DIMZIN·DIMPOST·공차·대체 단위 규칙으로 MTEXT 서식 문자열로 바꾼다.
 * 결과는 AutoCAD가 치수 블록 MTEXT에 쓰는 형식을 따른다(예: 4'-0{\H1x;\S1#4;}", 94\U+00B0, \U+220545,6).
 */
import type { DimensionEntity } from '../../core/model';
import type { RawVars } from './vars';

export const SYM_DEGREE = '\\U+00B0';
export const SYM_DIAMETER = '\\U+2205';
export const SYM_PLUSMINUS = '\\U+00B1';
export const SYM_ARC = '\\U+2229';

const num = (v: number | string | undefined, d: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

/** 반올림(0.5는 0에서 먼 쪽) */
export function roundTo(v: number, dec: number): number {
  const k = 10 ** Math.max(0, Math.min(10, dec));
  const a = Math.round(Math.abs(v) * k + 1e-7) / k;
  return v < 0 ? -a : a;
}

function fixed(v: number, dec: number): string {
  const d = Math.max(0, Math.min(10, Math.round(dec)));
  let s = roundTo(v, d).toFixed(d);
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
  return s;
}

/** 소수 0 생략: 4 앞의 0, 8 뒤의 0 */
function zeroSup(s: string, zin: number): string {
  let out = s;
  if (zin & 8 && out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  if (zin & 4) out = out.replace(/^(-?)0\.(?=\d)/, '$1.');
  if (out === '' || out === '-' || out === '.') out = '0';
  return out;
}

function sep(s: string, dsep: number): string {
  return dsep && dsep !== 46 ? s.replace('.', String.fromCharCode(dsep)) : s;
}

/** 쌓은 분수 */
function stackFrac(n: number, d: number, frac: number, tfac: number): string {
  if (frac === 2) return `${n}/${d}`;
  return `{\\H${trimNum(tfac)}x;\\S${n}${frac === 1 ? '#' : '/'}${d};}`;
}

function trimNum(v: number): string {
  return String(+v.toFixed(6));
}

/** 정수부와 분수(분모 2^prec) */
function splitFraction(a: number, prec: number): { whole: number; n: number; d: number } {
  const den = 2 ** Math.max(0, Math.min(8, Math.round(prec)));
  let whole = Math.floor(a + 1e-9);
  let n = Math.round((a - whole) * den);
  if (n >= den) {
    whole++;
    n = 0;
  }
  let d = den;
  while (n && n % 2 === 0 && d % 2 === 0) {
    n /= 2;
    d /= 2;
  }
  return { whole, n, d };
}

export interface UnitFmt {
  unit: number; // 1 과학, 2 소수, 3 공학, 4 건축, 5 분수, 6 Windows 바탕화면
  dec: number;
  zin: number;
  dsep: number;
  frac: number; // 0 가로, 1 사선, 2 쌓지 않음
  tfac: number;
}

/** 길이 값 → 문자(부호 포함) */
export function formatLinearValue(value: number, f: UnitFmt): string {
  const neg = value < 0;
  const a = Math.abs(value);
  let s: string;
  switch (f.unit) {
    case 1: {
      const e = roundTo(a, 12).toExponential(Math.max(0, Math.min(10, f.dec)));
      const m = /^([\d.]+)e([+-])(\d+)$/.exec(e);
      s = m ? `${sep(zeroSup(m[1]!, f.zin & 8), f.dsep)}E${m[2]}${m[3]!.padStart(2, '0')}` : e;
      break;
    }
    case 3: {
      // 공학: 피트-소수 인치
      let inch = roundTo(a, f.dec);
      let ft = Math.floor(inch / 12 + 1e-9);
      inch = roundTo(inch - ft * 12, f.dec);
      if (inch >= 12) {
        ft++;
        inch -= 12;
      }
      s = feetInches(ft, sep(zeroSup(fixed(inch, f.dec), f.zin & 12), f.dsep), inch === 0, f.zin);
      break;
    }
    case 4: {
      const total = splitFraction(a, f.dec);
      let ft = Math.floor(total.whole / 12);
      let wholeIn = total.whole - ft * 12;
      if (wholeIn >= 12) {
        ft++;
        wholeIn -= 12;
      }
      const inStr = total.n ? `${wholeIn}${f.frac === 2 ? ' ' : ''}${stackFrac(total.n, total.d, f.frac, f.tfac)}` : String(wholeIn);
      s = feetInches(ft, inStr, wholeIn === 0 && !total.n, f.zin);
      break;
    }
    case 5: {
      const fr = splitFraction(a, f.dec);
      if (!fr.n) s = String(fr.whole);
      else if (!fr.whole) s = stackFrac(fr.n, fr.d, f.frac, f.tfac);
      else s = `${fr.whole}${f.frac === 2 ? ' ' : ''}${stackFrac(fr.n, fr.d, f.frac, f.tfac)}`;
      break;
    }
    default:
      s = sep(zeroSup(fixed(a, f.dec), f.zin), f.dsep);
  }
  return neg && !/^0([.,]0*)?$/.test(s) ? '-' + s : s;
}

/** 피트·인치 0 생략: DIMZIN 0 둘 다 생략, 1 둘 다 표시, 2 피트 표시·인치 생략, 3 인치 표시·피트 생략 */
function feetInches(ft: number, inch: string, inchZero: boolean, zin: number): string {
  const z = zin & 3;
  const showFt = ft !== 0 || z === 1 || z === 2;
  const showIn = !inchZero || z === 1 || z === 3 || ft === 0;
  if (!showFt) return `${inch}"`;
  if (!showIn) return `${ft}'`;
  return `${ft}'-${inch}"`;
}

export interface AngleFmt {
  unit: number; // 0 도, 1 도분초, 2 그레이드, 3 라디안
  dec: number;
  zin: number;
  dsep: number;
}

/** 각도(라디안) → 문자 */
export function formatAngleValue(rad: number, f: AngleFmt): string {
  const deg = (Math.abs(rad) * 180) / Math.PI;
  const neg = rad < 0;
  const z = (s: string) => {
    let out = s;
    if (f.zin & 2 && out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
    if (f.zin & 1) out = out.replace(/^0\.(?=\d)/, '.');
    return sep(out || '0', f.dsep);
  };
  let s: string;
  switch (f.unit) {
    case 1: {
      // 도분초: 정밀도 0 → 도, 1·2 → 분, 3·4 → 초, 5 이상 → 초 소수
      const p = Math.round(f.dec);
      if (p <= 0) s = `${Math.round(deg + 1e-9)}${SYM_DEGREE}`;
      else if (p <= 2) {
        let d = Math.floor(deg + 1e-9);
        let m = Math.round((deg - d) * 60 + 1e-9);
        if (m >= 60) {
          d++;
          m -= 60;
        }
        s = `${d}${SYM_DEGREE}${m}'`;
      } else {
        const sp = Math.max(0, p - 4);
        let d = Math.floor(deg + 1e-9);
        let m = Math.floor((deg - d) * 60 + 1e-9);
        let sec = roundTo(((deg - d) * 60 - m) * 60, sp);
        if (sec >= 60) {
          sec -= 60;
          m++;
        }
        if (m >= 60) {
          m -= 60;
          d++;
        }
        s = `${d}${SYM_DEGREE}${m}'${z(fixed(sec, sp))}"`;
      }
      break;
    }
    case 2:
      s = z(fixed((Math.abs(rad) * 200) / Math.PI, f.dec)) + 'g';
      break;
    case 3:
      s = z(fixed(Math.abs(rad), f.dec)) + 'r';
      break;
    default:
      s = z(fixed(deg, f.dec)) + SYM_DEGREE;
  }
  return neg ? '-' + s : s;
}

/** DIMPOST·DIMAPOST: "<>"(또는 "[]") 앞뒤를 접두·접미로 */
function prePost(post: string, mark: string): { pre: string; suf: string } {
  const i = post.indexOf(mark);
  if (i >= 0) return { pre: post.slice(0, i), suf: post.slice(i + mark.length) };
  return { pre: '', suf: post };
}

const OLD_UNIT: Record<number, [number, number]> = { 1: [1, 0], 2: [2, 0], 3: [3, 0], 4: [4, 0], 5: [5, 0], 6: [4, 2], 7: [5, 2], 8: [2, 0] };

export type DimKindName = 'linear' | 'angular' | 'radius' | 'diameter' | 'ordinate' | 'arc';

export interface DimText {
  /** MTEXT 서식 문자열(\A1; 접두 포함). 빈 문자열이면 문자 없음 */
  mtext: string;
  /** 기본 측정 문자(재지정 전) */
  measured: string;
}

/** 치수 문자 만들기 */
export function dimensionText(r: RawVars, kind: DimKindName, measurement: number, userText: string): DimText {
  const lunit = num(r.DIMLUNIT, 2);
  const primary: UnitFmt = {
    unit: lunit,
    dec: num(r.DIMDEC, 4),
    zin: num(r.DIMZIN, 0),
    dsep: num(r.DIMDSEP, 46),
    frac: num(r.DIMFRAC, 0),
    tfac: num(r.DIMTFAC, 1) || 1,
  };
  const tolFmt: UnitFmt = { ...primary, dec: num(r.DIMTDEC, primary.dec), zin: num(r.DIMTZIN, 0) };
  const isAngle = kind === 'angular';
  let main: string;
  let value: number;
  const tolUp = num(r.DIMTP, 0);
  const tolDn = num(r.DIMTM, 0);
  const tfac = primary.tfac;
  if (isAngle) {
    value = measurement;
    let adec = num(r.DIMADEC, 0);
    if (adec < 0) adec = primary.dec;
    const af: AngleFmt = { unit: num(r.DIMAUNIT, 0), dec: adec, zin: num(r.DIMAZIN, 0), dsep: primary.dsep };
    main = formatAngleValue(value, af);
    const tf: AngleFmt = { ...af, dec: num(r.DIMTDEC, adec), zin: num(r.DIMTZIN, 0) };
    // 각도 치수의 공차 값(DIMTP·DIMTM)은 도 단위
    const rad = Math.PI / 180;
    const tol = tolerance(r, (x) => formatAngleValue(x * rad, tf), (x) => formatAngleValue(value + x * rad, af), tolUp, tolDn, tfac);
    if (tol.limits !== null) main = tol.limits;
    else main += tol.suffix;
  } else {
    value = Math.abs(measurement) * Math.abs(num(r.DIMLFAC, 1) || 1);
    const rnd = num(r.DIMRND, 0);
    if (rnd > 0) value = Math.round(value / rnd + 1e-9) * rnd;
    const post = prePost(String(r.DIMPOST ?? ''), '<>');
    let pre = post.pre;
    if (!pre && kind === 'radius') pre = 'R';
    if (!pre && kind === 'diameter') pre = SYM_DIAMETER;
    if (kind === 'arc' && num(r.DIMARCSYM, 0) === 0) pre = SYM_ARC + pre;
    const lin = (x: number) => formatLinearValue(x, primary);
    const tol = tolerance(r, (x) => formatLinearValue(x, tolFmt), (x) => lin(value + x), tolUp, tolDn, tfac);
    main = pre + (tol.limits ?? lin(value) + tol.suffix) + post.suf;
    if (num(r.DIMALT, 0)) {
      const au = OLD_UNIT[num(r.DIMALTU, 2)] ?? [2, 0];
      const alt: UnitFmt = { unit: au[0], dec: num(r.DIMALTD, 2), zin: num(r.DIMALTZ, 0), dsep: primary.dsep, frac: au[1], tfac };
      const altTol: UnitFmt = { ...alt, dec: num(r.DIMALTTD, alt.dec), zin: num(r.DIMALTTZ, 0) };
      const f = num(r.DIMALTF, 25.4);
      let av = value * f;
      const arnd = num(r.DIMALTRND, 0);
      if (arnd > 0) av = Math.round(av / arnd + 1e-9) * arnd;
      const ap = prePost(String(r.DIMAPOST ?? ''), '[]');
      const at = tolerance(r, (x) => formatLinearValue(x * f, altTol), (x) => formatLinearValue(av + x * f, alt), tolUp, tolDn, tfac);
      main += ` [${ap.pre}${at.limits ?? formatLinearValue(av, alt) + at.suffix}${ap.suf}]`;
    }
  }
  let text: string;
  if (!userText || userText === '<>') text = main;
  else if (userText === ' ') return { mtext: '', measured: main };
  else text = userText.replace('<>', main);
  return { mtext: text, measured: main };
}

/** 공차·한계: limits가 있으면 측정값 대신, 아니면 suffix를 측정값 뒤에 */
function tolerance(
  r: RawVars,
  fmtTol: (x: number) => string,
  fmtVal: (x: number) => string,
  tp: number,
  tm: number,
  tfac: number,
): { suffix: string; limits: string | null } {
  if (num(r.DIMLIM, 0)) {
    return { suffix: '', limits: `{\\H${trimNum(tfac)}x;\\S${fmtVal(tp)}^${fmtVal(-tm)};}` };
  }
  if (!num(r.DIMTOL, 0)) return { suffix: '', limits: null };
  if (Math.abs(tp - tm) < 1e-12) return { suffix: `${SYM_PLUSMINUS}${fmtTol(Math.abs(tp))}`, limits: null };
  const sg = (x: number, plus: boolean) => {
    const s = fmtTol(Math.abs(x));
    if (/^[0.,]+$/.test(s) && !/[1-9]/.test(s)) return ` ${s}`;
    return (plus ? (x >= 0 ? '+' : '-') : x >= 0 ? '-' : '+') + s;
  };
  return { suffix: `{\\H${trimNum(tfac)}x;\\S${sg(tp, true)}^${sg(tm, false)};}`, limits: null };
}

/** 치수 종류 이름 */
export function dimKindName(d: Pick<DimensionEntity, 'dimType' | 'subtype'>): DimKindName {
  if (d.subtype === 'ARC_DIMENSION') return 'arc';
  if (d.subtype === 'LARGE_RADIAL_DIMENSION') return 'radius';
  switch (d.dimType & 7) {
    case 2:
    case 5:
      return 'angular';
    case 3:
      return 'diameter';
    case 4:
      return 'radius';
    case 6:
      return 'ordinate';
    default:
      return 'linear';
  }
}
