/**
 * AutoLISP 문자열·변환 함수: strcat strlen substr strcase atoi atof itoa rtos angtos distof angtof ascii chr wcmatch
 * vl-string-subst vl-string-search vl-string-position vl-string-trim(left·right) vl-string->list vl-list->string vl-string-translate vl-string-elt snvalid.
 * rtos·angtos의 기본 단위·정밀도는 도면 변수(LUNITS·LUPREC·AUNITS·AUPREC), 끝 0 생략은 DIMZIN(8)을 따른다.
 */
import { formatAngle, formatLength, parseAngle, parseLength } from '../../core/units';
import type { Interp } from './interp';
import { badValue } from './printer';
import { int, num, str, arr } from './core';
import { Real, fromArray, type Value, wrap32 } from './types';

const TAU = Math.PI * 2;

/** DIMZIN: 8 = 끝 0 생략, 4 = 앞 0 생략 */
function zeros(s: string, dimzin: number): string {
  let t = s;
  if (dimzin & 8 && t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  if (dimzin & 4) t = t.replace(/^(-?)0\./, '$1.');
  return t;
}

export function rtos(v: number, mode: number, prec: number, dimzin: number): string {
  const p = Math.max(0, Math.min(16, prec));
  switch (mode) {
    case 1: {
      const e = v.toExponential(p);
      const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(e)!;
      return `${m[1]}E${m[2]}${m[3]!.padStart(2, '0')}`;
    }
    case 2:
      return zeros(v.toFixed(p), dimzin);
    case 3:
    case 4:
    case 5:
      return formatLength(v, { lunits: mode, luprec: p });
    default:
      throw badValue('모드', mode);
  }
}

export function angtos(a: number, mode: number, prec: number, dimzin: number): string {
  let r = a % TAU;
  if (r < 0) r += TAU;
  if (Math.abs(r - TAU) < 1e-12) r = 0;
  const p = Math.max(0, Math.min(16, prec));
  switch (mode) {
    case 0:
      return zeros(((r * 180) / Math.PI).toFixed(p), dimzin);
    case 1:
      return formatAngle(r, { aunits: 1, auprec: p });
    case 2:
      return `${zeros(((r * 200) / Math.PI).toFixed(p), dimzin)}g`;
    case 3:
      return `${zeros(r.toFixed(p), dimzin)}r`;
    case 4: {
      // 측량 단위: 북·남에서 동·서로 잰 각도(도분초)
      const deg = (r * 180) / Math.PI;
      const b = deg <= 90 ? 90 - deg : deg <= 180 ? deg - 90 : deg <= 270 ? 270 - deg : deg - 270;
      const ns = deg > 180 && deg < 360 ? 'S' : 'N';
      const ew = deg > 90 && deg < 270 ? 'W' : 'E';
      if (Math.abs(deg) < 1e-9 || Math.abs(deg - 180) < 1e-9) return deg < 90 ? 'E' : 'W';
      if (Math.abs(deg - 90) < 1e-9) return 'N';
      if (Math.abs(deg - 270) < 1e-9) return 'S';
      return `${ns} ${formatAngle((b * Math.PI) / 180, { aunits: 1, auprec: p })} ${ew}`;
    }
    default:
      throw badValue('모드', mode);
  }
}

/** 글 → 길이(모드와 상관없이 소수·분수·피트-인치·지수 모두 읽는다). 못 읽으면 null */
export function distof(s: string): number | null {
  const t = s.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)E[-+]?\d+$/i.test(t)) return Number(t);
  return parseLength(t);
}

/** 글 → 각도(라디안). units: 0 도, 1 도분초, 2 그라드, 3 라디안, 4 측량 */
export function angtof(s: string, units: number): number | null {
  const t = s.trim();
  const sv = /^([NS])\s*(.*?)\s*([EW])$/i.exec(t);
  let r: number | null;
  if (sv) {
    const b = sv[2] ? parseAngle(sv[2], 0) : 0;
    if (b === null) return null;
    const n = sv[1]!.toUpperCase() === 'N';
    const e = sv[3]!.toUpperCase() === 'E';
    const deg90 = Math.PI / 2;
    r = n ? (e ? deg90 - b : deg90 + b) : e ? 3 * deg90 + b : 3 * deg90 - b;
  } else if (/^[NSEW]$/i.test(t)) r = { N: Math.PI / 2, S: (3 * Math.PI) / 2, E: 0, W: Math.PI }[t.toUpperCase() as 'N']!;
  else r = parseAngle(t, units === 1 || units === 4 ? 0 : units);
  if (r === null || !Number.isFinite(r)) return null;
  r %= TAU;
  return r < 0 ? r + TAU : r;
}

/** AutoCAD 와일드카드(# @ . * ? ~ [...] [~...] ` 와 쉼표로 여러 패턴) */
export function wcmatch(text: string, pattern: string, ignoreCase = false): boolean {
  const pats: string[] = [];
  let cur = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '`' && i + 1 < pattern.length) {
      cur += c + pattern[++i];
      continue;
    }
    if (c === ',') {
      pats.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  pats.push(cur);
  return pats.some((p) => {
    let neg = false;
    let body = p;
    if (body.startsWith('~')) {
      neg = true;
      body = body.slice(1);
    }
    const re = new RegExp(`^${wildToRegex(body)}$`, ignoreCase ? 'iu' : 'u');
    return re.test(text) !== neg;
  });
}

function esc(c: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(c) ? '\\' + c : c;
}

function wildToRegex(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '`' && i + 1 < p.length) out += esc(p[++i]!);
    else if (c === '#') out += '\\d';
    else if (c === '@') out += '\\p{L}';
    else if (c === '.') out += '[^\\p{L}\\d]';
    else if (c === '*') out += '[\\s\\S]*';
    else if (c === '?') out += '[\\s\\S]';
    else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      let inner = p.slice(i + 1, end);
      let negate = false;
      if (inner.startsWith('~') && inner.length > 1) {
        negate = true;
        inner = inner.slice(1);
      }
      let cls = '';
      for (let j = 0; j < inner.length; j++) {
        const ch = inner[j]!;
        if (ch === '-' && j > 0 && j < inner.length - 1) cls += '-';
        else if (ch === '`' && j + 1 < inner.length) cls += esc(inner[++j]!);
        else cls += esc(ch);
      }
      out += `[${negate ? '^' : ''}${cls}]`;
      i = end;
    } else out += esc(c);
  }
  return out;
}

export function installText(it: Interp, vars: (name: string) => number | undefined): void {
  const def = it.def.bind(it);
  const T = it.T;
  const v = (n: string, d: number) => vars(n) ?? d;

  def('STRCAT', 0, -1, (a) => a.map(str).join(''));
  def('STRLEN', 0, -1, (a) => a.reduce<number>((n, s) => n + str(s).length, 0));
  def('SUBSTR', 2, 3, ([s, start, len]) => {
    const t = str(s!);
    const i = int(start!);
    if (i < 1) throw badValue('양수', i);
    if (len === undefined || len === null) return t.slice(i - 1);
    const n = int(len);
    if (n < 0) throw badValue('양수', n);
    return t.slice(i - 1, i - 1 + n);
  });
  def('STRCASE', 1, 2, ([s, which]) => (which !== undefined && which !== null ? str(s!).toLowerCase() : str(s!).toUpperCase()));
  def('ATOI', 1, 1, ([s]) => {
    const m = /^\s*[+-]?\d+/.exec(str(s!));
    return m ? wrap32(Number(m[0])) : 0;
  });
  def('ATOF', 1, 1, ([s]) => {
    const m = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(str(s!));
    return new Real(m ? Number(m[0]) : 0);
  });
  def('ITOA', 1, 1, ([n]) => String(int(n!)));
  def('RTOS', 1, 3, ([x, mode, prec]) => {
    const m = mode === undefined || mode === null ? v('LUNITS', 2) : int(mode);
    const p = prec === undefined || prec === null ? v('LUPREC', 4) : int(prec);
    return rtos(num(x!), m, p, v('DIMZIN', 0));
  });
  def('ANGTOS', 1, 3, ([x, mode, prec]) => {
    const m = mode === undefined || mode === null ? v('AUNITS', 0) : int(mode);
    const p = prec === undefined || prec === null ? v('AUPREC', 0) : int(prec);
    return angtos(num(x!), m, p, v('DIMZIN', 0));
  });
  def('DISTOF', 1, 2, ([s]) => {
    const r = distof(str(s!));
    return r === null ? null : new Real(r);
  });
  def('ANGTOF', 1, 2, ([s, units]) => {
    const u = units === undefined || units === null ? v('AUNITS', 0) : int(units);
    const r = angtof(str(s!), u);
    return r === null ? null : new Real(r);
  });
  def('ASCII', 1, 1, ([s]) => {
    const t = str(s!);
    return t ? t.charCodeAt(0) : 0;
  });
  def('CHR', 1, 1, ([n]) => String.fromCharCode(int(n!) & 0xffff));
  def('WCMATCH', 2, 2, ([s, p]) => (wcmatch(str(s!), str(p!)) ? T : null));
  def('VL-STRING-SUBST', 3, 4, ([nw, pat, s, start]) => {
    const t = str(s!);
    const p = str(pat!);
    const from = start === undefined || start === null ? 0 : int(start);
    const i = t.indexOf(p, from);
    return i < 0 ? t : t.slice(0, i) + str(nw!) + t.slice(i + p.length);
  });
  def('VL-STRING-SEARCH', 2, 3, ([pat, s, start]) => {
    const i = str(s!).indexOf(str(pat!), start === undefined || start === null ? 0 : int(start));
    return i < 0 ? null : i;
  });
  def('VL-STRING-POSITION', 2, 4, ([code, s, start, fromEnd]) => {
    const t = str(s!);
    const ch = String.fromCharCode(int(code!));
    const from = start === undefined || start === null ? undefined : int(start);
    const i = fromEnd !== undefined && fromEnd !== null ? t.lastIndexOf(ch, from) : t.indexOf(ch, from ?? 0);
    return i < 0 ? null : i;
  });
  const trim = (left: boolean, right: boolean) => (a: Value[]) => {
    const set = str(a[0]!);
    let t = str(a[1]!);
    if (left) while (t && set.includes(t[0]!)) t = t.slice(1);
    if (right) while (t && set.includes(t[t.length - 1]!)) t = t.slice(0, -1);
    return t;
  };
  def('VL-STRING-TRIM', 2, 2, trim(true, true));
  def('VL-STRING-LEFT-TRIM', 2, 2, trim(true, false));
  def('VL-STRING-RIGHT-TRIM', 2, 2, trim(false, true));
  def('VL-STRING->LIST', 1, 1, ([s]) => fromArray([...str(s!)].map((c) => c.charCodeAt(0))));
  def('VL-LIST->STRING', 1, 1, ([l]) => arr(l!).map((c) => String.fromCharCode(int(c))).join(''));
  def('VL-STRING-ELT', 2, 2, ([s, i]) => {
    const t = str(s!);
    const k = int(i!);
    if (k < 0 || k >= t.length) throw badValue('범위', k);
    return t.charCodeAt(k);
  });
  def('VL-STRING-TRANSLATE', 3, 3, ([src, dst, s]) => {
    const a = str(src!);
    const b = str(dst!);
    return [...str(s!)].map((c) => {
      const i = a.indexOf(c);
      return i < 0 ? c : (b[Math.min(i, b.length - 1)] ?? c);
    }).join('');
  });
  def('SNVALID', 1, 2, ([s]) => {
    const t = str(s!);
    return t.length > 0 && t.length <= 255 && !/[<>/\\":;?*|,=`]/.test(t) && t.trim() === t ? T : null;
  });
}
