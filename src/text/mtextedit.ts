/**
 * 문자 편집 모델: MTEXT 서식 문자열(또는 TEXT 문자열) ↔ 문단·글자 목록.
 *
 * 제자리 문자 편집기(src/app/textedit)가 이 모델 위에서 서식을 바꾸고 다시 서식 문자열로 쓴다.
 * - 해석은 parseMText(src/text/mtext.ts)와 같은 규칙이다: 같은 문자열을 두 해석기가 같은 글자·서식으로 읽는다.
 * - 글자마다 원래 표기(raw: `%%d`, `\U+00B0`, `\~` …)를 지녀 고치지 않은 글자는 같은 표기로 돌아간다.
 * - 문단 서식(\p)은 원래 코드를 지니고, 바뀐 값만 덧붙인다(모르는 \p 항목도 남는다).
 * - 글자 서식은 같은 서식끼리 `{…}` 묶음으로 쓴다(뜻은 같고 표기는 정리된다). 아무것도 고치지 않았으면
 *   편집기가 원래 문자열을 그대로 돌려준다(serializeRich를 쓰지 않는다).
 * - 필드 템플릿(%<\…>%)과 치수 측정값 자리(<>)는 한 글자 같은 조각으로 다룬다.
 */
import { decodePercent, parseMText } from './mtext';

// ---------------------------------------------------------------------------
// 형식
// ---------------------------------------------------------------------------

/** 글자 서식(정하지 않은 값 = 객체의 기본값) */
export interface Fmt {
  /** \f(트루타입)·\F(SHX) 글꼴 지정 원문(예: 'Arial|b1|i0|c0|p34', 'romans.shx') */
  font?: { code: 'f' | 'F'; spec: string };
  /** \H: rel이면 객체 높이에 대한 배율, 아니면 절대 높이 */
  height?: { v: number; rel: boolean };
  /** \W 폭 비율 */
  width?: number;
  /** \Q 기울기 각도(도) */
  oblique?: number;
  /** \T 자간 */
  tracking?: number;
  /** \C 색 번호(0 블록별, 256 도면층별) 또는 \c 트루컬러(BGR 정수) */
  color?: { aci: number } | { bgr: number };
  /** \A 세로 정렬: 0 아래, 1 가운데, 2 위 */
  valign?: number;
  underline?: boolean;
  overline?: boolean;
  strike?: boolean;
}

export type StackSep = '/' | '#' | '^';

export type Item =
  /** 글자 하나(코드 포인트 하나). raw는 원래 표기 */
  | { k: 'ch'; c: string; f: Fmt; raw?: string }
  /** 쌓기(\S): top·bot은 원래 표기(\로 이스케이프된 상태) */
  | { k: 'stack'; top: string; bot: string; sep: StackSep; f: Fmt }
  /** 필드 코드 %<\…>% */
  | { k: 'field'; code: string; f: Fmt }
  /** 탭(^I) */
  | { k: 'tab'; f: Fmt }
  /** 치수 문자의 측정값 자리(<>) */
  | { k: 'measure'; f: Fmt };

export type ParaAlign = '' | 'l' | 'c' | 'r' | 'j' | 'd';

/** 문단 서식(\p). 단위는 도면 단위 */
export interface ParaFmt {
  align: ParaAlign;
  indentFirst: number;
  indentLeft: number;
  indentRight: number;
  tabs: number[];
}

export interface Para {
  items: Item[];
  /** 이 문단의 서식(앞 문단에서 이어받은 값 + 이 문단의 \p) */
  pf: ParaFmt;
  /** 이 문단 안에 있던 \p 코드의 인수(원래 표기) */
  praw: string[];
  /** 이 문단 앞의 나누기: P 문단, N 열 나누기, X 치수 문자 줄(첫 문단은 P) */
  brk: 'P' | 'N' | 'X';
}

export interface RichDoc {
  paras: Para[];
}

export interface ParseOpt {
  /** 'text'면 TEXT·속성 문자열(%%u 밑줄 토글, 문단 없음) */
  mode?: 'mtext' | 'text';
  /** %<\…>% 필드 코드를 조각으로(필드 템플릿을 고칠 때) */
  fields?: boolean;
  /** <>를 측정값 자리로(치수 문자) */
  measure?: boolean;
}

export interface SerializeOpt {
  mode?: 'mtext' | 'text';
  /** 문단 정렬을 기본(부착점을 따름)으로 되돌릴 때 쓸 MTEXT 부착점(1~9) */
  attachment?: number;
}

export const defaultParaFmt = (): ParaFmt => ({ align: '', indentFirst: 0, indentLeft: 0, indentRight: 0, tabs: [] });

const copyPf = (p: ParaFmt): ParaFmt => ({ ...p, tabs: [...p.tabs] });

export function emptyDoc(): RichDoc {
  return { paras: [{ items: [], pf: defaultParaFmt(), praw: [], brk: 'P' }] };
}

// ---------------------------------------------------------------------------
// 해석
// ---------------------------------------------------------------------------

/** i에서 시작하는 %<의 짝 >% 다음 위치(중첩 허용, 짝이 없으면 -1). src/edit/field/code와 같은 규칙 */
function fieldEnd(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length - 1; k++) {
    if (s[k] === '%' && s[k + 1] === '<') {
      depth++;
      k++;
    } else if (s[k] === '>' && s[k + 1] === '%') {
      depth--;
      k++;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

function readUntil(s: string, i: number, end: string): [string, number] {
  const j = s.indexOf(end, i);
  if (j < 0) return [s.slice(i), s.length];
  return [s.slice(i, j), j + 1];
}

/** \p 인수 하나를 문단 서식에 적용한다(parseMText의 applyParagraph와 같은 규칙) */
export function applyParaCode(p: ParaFmt, arg: string): void {
  for (const part of arg.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('x')) {
      applyParaCode(p, t.slice(1));
      continue;
    }
    const k = t[0];
    const v = t.slice(1);
    if (k === 'i') p.indentFirst = parseFloat(v) || 0;
    else if (k === 'l') p.indentLeft = parseFloat(v) || 0;
    else if (k === 'r') p.indentRight = parseFloat(v) || 0;
    else if (k === 'q') p.align = (['l', 'c', 'r', 'j', 'd'].includes(v[0] ?? '') ? v[0] : '') as ParaAlign;
    else if (k === 't') p.tabs = v.split(/[,]/).map(Number).filter(Number.isFinite);
  }
}

/** 서식 문자열 → 편집 모델 */
export function parseRich(src: string, opt: ParseOpt = {}): RichDoc {
  return opt.mode === 'text' ? parseText(src, opt) : parseMTextRich(src, opt);
}

function parseMTextRich(s: string, opt: ParseOpt): RichDoc {
  const doc = emptyDoc();
  let para = doc.paras[0]!;
  const newPara = (brk: Para['brk']) => {
    para = { items: [], pf: copyPf(para.pf), praw: [], brk };
    doc.paras.push(para);
  };
  let f: Fmt = {};
  const stack: Fmt[] = [];
  const modify = (fn: (x: Fmt) => void) => {
    f = { ...f };
    fn(f);
  };
  const ch = (c: string, raw?: string) => para.items.push(raw === undefined ? { k: 'ch', c, f } : { k: 'ch', c, f, raw });
  for (let i = 0; i < s.length; i++) {
    const c0 = s[i]!;
    if (opt.fields && c0 === '%' && s[i + 1] === '<' && s[i + 2] === '\\') {
      const end = fieldEnd(s, i);
      if (end > 0) {
        para.items.push({ k: 'field', code: s.slice(i, end), f });
        i = end - 1;
        continue;
      }
    }
    if (opt.measure && c0 === '<' && s[i + 1] === '>') {
      para.items.push({ k: 'measure', f });
      i++;
      continue;
    }
    if (c0 === '{') {
      stack.push(f);
      continue;
    }
    if (c0 === '}') {
      f = stack.pop() ?? f;
      continue;
    }
    if (c0 === '^' && i + 1 < s.length) {
      const c = s[i + 1]!;
      if (c === 'I') {
        para.items.push({ k: 'tab', f });
        i++;
        continue;
      }
      if (c === 'J' || c === 'M') {
        newPara('P');
        i++;
        continue;
      }
      if (c === ' ') {
        ch('^', '^ ');
        i++;
        continue;
      }
    }
    if (c0 === '\t') {
      para.items.push({ k: 'tab', f });
      continue;
    }
    if (c0 === '\n') {
      newPara('P');
      continue;
    }
    if (c0 === '\r') continue;
    if (c0 === '%' && s[i + 1] === '%') {
      const first = decodePercent(s.slice(i, i + 5))[0]!;
      const m = /^%%(\d{3})/.exec(s.slice(i));
      const n = m ? 5 : 3;
      // 문자열 끝의 %%는 % 하나다(원래 표기를 지니면 뒤에 글자가 붙을 때 뜻이 바뀐다)
      const raw = i + n <= s.length ? s.slice(i, i + n) : undefined;
      if (first === -1) modify((x) => (x.underline = !x.underline || undefined));
      else if (first === -2) modify((x) => (x.overline = !x.overline || undefined));
      else if (first === -3) modify((x) => (x.strike = !x.strike || undefined));
      else ch(String.fromCodePoint(first), raw);
      i += n - 1;
      continue;
    }
    if (c0 !== '\\') {
      const cp = s.codePointAt(i)!;
      ch(String.fromCodePoint(cp));
      if (cp > 0xffff) i++;
      continue;
    }
    const c = s[i + 1];
    if (c === undefined) break;
    i++;
    switch (c) {
      case '\\':
      case '{':
      case '}':
        ch(c, '\\' + c);
        break;
      case 'P':
        newPara('P');
        break;
      case 'N':
        newPara('N');
        break;
      case 'X':
        newPara('X');
        break;
      case '~':
        ch(' ', '\\~');
        break;
      case 'U': {
        const hex = s.slice(i + 2, i + 6);
        if (s[i + 1] === '+' && /^[0-9a-fA-F]{4}$/.test(hex)) {
          ch(String.fromCodePoint(parseInt(hex, 16)), s.slice(i - 1, i + 6));
          i += 5;
          break;
        }
        ch('U', '\\U');
        break;
      }
      case 'M': {
        if (s[i + 1] === '+') {
          const raw = '\\' + s.slice(i, i + 7);
          const cps = decodePercent(raw);
          if (cps.length === 1) ch(String.fromCodePoint(cps[0]!), raw);
          else for (const cp of cps) ch(String.fromCodePoint(cp));
          i += 6;
          break;
        }
        ch('M', '\\M');
        break;
      }
      case 'L':
        modify((x) => (x.underline = true));
        break;
      case 'l':
        modify((x) => delete x.underline);
        break;
      case 'O':
        modify((x) => (x.overline = true));
        break;
      case 'o':
        modify((x) => delete x.overline);
        break;
      case 'K':
        modify((x) => (x.strike = true));
        break;
      case 'k':
        modify((x) => delete x.strike);
        break;
      case 'f':
      case 'F': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        modify((x) => (x.font = { code: c, spec: arg }));
        break;
      }
      case 'H': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const rel = /x$/i.test(arg.trim());
        const v = parseFloat(arg);
        if (Number.isFinite(v) && v > 0) modify((x) => (x.height = rel ? { v: (x.height?.v ?? 1) * v, rel: x.height ? x.height.rel : true } : { v, rel: false }));
        break;
      }
      case 'W':
      case 'T': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseFloat(arg);
        const key = c === 'W' ? 'width' : 'tracking';
        if (Number.isFinite(v) && v > 0) modify((x) => (x[key] = /x$/i.test(arg.trim()) ? (x[key] ?? 1) * v : v));
        break;
      }
      case 'Q': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseFloat(arg);
        if (Number.isFinite(v)) modify((x) => (x.oblique = v));
        break;
      }
      case 'A': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseInt(arg, 10);
        if (v >= 0 && v <= 2) modify((x) => (x.valign = v));
        break;
      }
      case 'C': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseInt(arg, 10);
        if (Number.isFinite(v)) modify((x) => (x.color = { aci: v }));
        break;
      }
      case 'c': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseInt(arg, 10);
        if (Number.isFinite(v)) modify((x) => (x.color = { bgr: v }));
        break;
      }
      case 'p': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        applyParaCode(para.pf, arg);
        para.praw.push(arg);
        break;
      }
      case 'S': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const m = /^(.*?)([/#^])(.*)$/s.exec(arg);
        para.items.push({ k: 'stack', top: m ? m[1]! : arg, bot: m ? m[3]! : '', sep: (m?.[2] as StackSep) ?? '^', f });
        break;
      }
      default:
        ch(c, '\\' + c);
        break;
    }
  }
  return doc;
}

function parseText(s: string, opt: ParseOpt): RichDoc {
  const doc = emptyDoc();
  const para = doc.paras[0]!;
  let f: Fmt = {};
  const modify = (fn: (x: Fmt) => void) => {
    f = { ...f };
    fn(f);
  };
  for (let i = 0; i < s.length; i++) {
    const c0 = s[i]!;
    if (opt.fields && c0 === '%' && s[i + 1] === '<' && s[i + 2] === '\\') {
      const end = fieldEnd(s, i);
      if (end > 0) {
        para.items.push({ k: 'field', code: s.slice(i, end), f });
        i = end - 1;
        continue;
      }
    }
    if (c0 === '%' && s[i + 1] === '%' && i + 2 < s.length) {
      const c = s[i + 2]!.toLowerCase();
      const raw3 = s.slice(i, i + 3);
      if (c === 'u' || c === 'o' || c === 'k') {
        const key = c === 'u' ? 'underline' : c === 'o' ? 'overline' : 'strike';
        modify((x) => (x[key] ? delete x[key] : (x[key] = true)));
        i += 2;
        continue;
      }
      const sym = c === 'c' ? '∅' : c === 'd' ? '°' : c === 'p' ? '±' : c === '%' ? '%' : null;
      if (sym) {
        para.items.push({ k: 'ch', c: sym, f, raw: raw3 });
        i += 2;
        continue;
      }
      const m = /^\d{3}/.exec(s.slice(i + 2, i + 5));
      if (m) {
        para.items.push({ k: 'ch', c: String.fromCodePoint(parseInt(m[0], 10)), f, raw: s.slice(i, i + 5) });
        i += 4;
        continue;
      }
    }
    if (c0 === '\\' && s[i + 1] === 'U' && s[i + 2] === '+' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 3, i + 7))) {
      para.items.push({ k: 'ch', c: String.fromCodePoint(parseInt(s.slice(i + 3, i + 7), 16)), f, raw: s.slice(i, i + 7) });
      i += 6;
      continue;
    }
    if (c0 === '\\' && s[i + 1] === 'M' && s[i + 2] === '+' && /^[1-5][0-9a-fA-F]{4}/.test(s.slice(i + 3, i + 8))) {
      const raw = s.slice(i, i + 8);
      const cps = decodePercent(raw);
      if (cps.length === 1) para.items.push({ k: 'ch', c: String.fromCodePoint(cps[0]!), f, raw });
      else for (const cp of cps) para.items.push({ k: 'ch', c: String.fromCodePoint(cp), f });
      i += 7;
      continue;
    }
    const cp = s.codePointAt(i)!;
    para.items.push({ k: 'ch', c: String.fromCodePoint(cp), f });
    if (cp > 0xffff) i++;
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------

/** 숫자를 짧게(소수 6자리까지, 끝의 0 없음) */
export function num(v: number): string {
  const r = +v.toFixed(6);
  return Object.is(r, -0) ? '0' : String(r);
}

/** 서식이 같은지 판단할 열쇠 */
export function fmtKey(f: Fmt): string {
  const parts: string[] = [];
  if (f.font) parts.push(`f${f.font.code}${f.font.spec}`);
  if (f.height) parts.push(`h${f.height.rel ? 'x' : ''}${num(f.height.v)}`);
  if (f.width !== undefined) parts.push(`w${num(f.width)}`);
  if (f.oblique !== undefined) parts.push(`q${num(f.oblique)}`);
  if (f.tracking !== undefined) parts.push(`t${num(f.tracking)}`);
  if (f.color) parts.push('aci' in f.color ? `C${f.color.aci}` : `c${f.color.bgr}`);
  if (f.valign !== undefined) parts.push(`a${f.valign}`);
  if (f.underline) parts.push('L');
  if (f.overline) parts.push('O');
  if (f.strike) parts.push('K');
  return parts.join('|');
}

/** 글자 서식 코드(묶음 안에 쓸 것) */
export function fmtCodes(f: Fmt): string {
  let o = '';
  if (f.font) o += `\\${f.font.code}${f.font.spec};`;
  if (f.height) o += `\\H${num(f.height.v)}${f.height.rel ? 'x' : ''};`;
  if (f.width !== undefined) o += `\\W${num(f.width)};`;
  if (f.oblique !== undefined) o += `\\Q${num(f.oblique)};`;
  if (f.tracking !== undefined) o += `\\T${num(f.tracking)};`;
  if (f.color) o += 'aci' in f.color ? `\\C${f.color.aci};` : `\\c${f.color.bgr};`;
  if (f.valign !== undefined) o += `\\A${f.valign};`;
  if (f.underline) o += '\\L';
  if (f.overline) o += '\\O';
  if (f.strike) o += '\\K';
  return o;
}

/** 기호 문자 → 서식 코드(AutoCAD 기호 메뉴가 넣는 것과 같다) */
const SYMBOL_CODES: Record<string, string> = { '°': '%%d', '±': '%%p', '∅': '%%c' };

/** 다음 조각이 %로 시작하는지(앞의 % 하나를 %%%로 써야 하는지) */
function startsWithPercent(next: Item | undefined, mode: 'mtext' | 'text'): boolean {
  if (!next) return false;
  if (next.k === 'field') return true;
  if (next.k !== 'ch') return false;
  const out = encodeChar(next, undefined, mode);
  return out.startsWith('%');
}

function encodeChar(it: Extract<Item, { k: 'ch' }>, next: Item | undefined, mode: 'mtext' | 'text'): string {
  if (it.raw !== undefined) return it.raw;
  const c = it.c;
  const sym = SYMBOL_CODES[c];
  if (sym) return sym;
  if (c === '%') return startsWithPercent(next, mode) ? '%%%' : '%';
  if (mode === 'text') return c;
  if (c === '\\' || c === '{' || c === '}') return '\\' + c;
  if (c === ' ') return '\\~';
  if (c === '^' && next?.k === 'ch' && next.raw === undefined && /^[IJM ]$/.test(next.c)) return '^ ';
  if (c === '\n' || c === '\r') return '\\P';
  if (c === '\t') return '^I';
  return c;
}

function paraEqual(a: ParaFmt, b: ParaFmt): boolean {
  return a.align === b.align && a.indentFirst === b.indentFirst && a.indentLeft === b.indentLeft && a.indentRight === b.indentRight && a.tabs.length === b.tabs.length && a.tabs.every((t, i) => t === b.tabs[i]);
}

/** 앞 문단에서 이어받은 서식 from을 to로 만드는 \p 코드 */
function paraDiff(from: ParaFmt, to: ParaFmt, attachment: number): string {
  const parts: string[] = [];
  if (from.indentFirst !== to.indentFirst) parts.push(`i${num(to.indentFirst)}`);
  if (from.indentLeft !== to.indentLeft) parts.push(`l${num(to.indentLeft)}`);
  if (from.indentRight !== to.indentRight) parts.push(`r${num(to.indentRight)}`);
  if (from.align !== to.align) parts.push(`q${to.align || (['l', 'c', 'r'][(Math.max(1, Math.min(9, attachment)) - 1) % 3] ?? 'l')}`);
  if (!(from.tabs.length === to.tabs.length && from.tabs.every((t, i) => t === to.tabs[i])) && to.tabs.length) parts.push(`t${to.tabs.map(num).join(',')}`);
  return parts.length ? `\\px${parts.join(',')};` : '';
}

/** 편집 모델 → 서식 문자열 */
export function serializeRich(doc: RichDoc, opt: SerializeOpt = {}): string {
  const mode = opt.mode ?? 'mtext';
  if (mode === 'text') return serializeText(doc);
  const att = opt.attachment ?? 1;
  let out = '';
  let inherited = defaultParaFmt();
  doc.paras.forEach((p, k) => {
    if (k > 0) out += p.brk === 'N' ? '\\N' : p.brk === 'X' ? '\\X' : '\\P';
    // 문단 서식: 원래 코드 + 아직 맞지 않는 값
    const got = copyPf(inherited);
    for (const r of p.praw) {
      applyParaCode(got, r);
      out += `\\p${r};`;
    }
    if (!paraEqual(got, p.pf)) out += paraDiff(got, p.pf, att);
    inherited = copyPf(p.pf);
    // 글자: 같은 서식끼리 묶는다
    let i = 0;
    const items = p.items;
    while (i < items.length) {
      const key = fmtKey(items[i]!.f);
      let j = i;
      let body = '';
      while (j < items.length && fmtKey(items[j]!.f) === key) {
        body += encodeItem(items[j]!, items[j + 1], 'mtext');
        j++;
      }
      const codes = fmtCodes(items[i]!.f);
      out += codes ? `{${codes}${body}}` : body;
      i = j;
    }
  });
  return out;
}

function encodeItem(it: Item, next: Item | undefined, mode: 'mtext' | 'text'): string {
  switch (it.k) {
    case 'ch':
      return encodeChar(it, next, mode);
    case 'stack':
      return `\\S${it.top}${it.sep}${it.bot};`;
    case 'field':
      return it.code;
    case 'tab':
      return mode === 'text' ? ' ' : '^I';
    case 'measure':
      return '<>';
  }
}

function serializeText(doc: RichDoc): string {
  let out = '';
  const on = { underline: false, overline: false, strike: false };
  const codes = { underline: '%%u', overline: '%%o', strike: '%%k' } as const;
  const all: Item[] = [];
  doc.paras.forEach((p, k) => {
    if (k > 0) all.push({ k: 'ch', c: ' ', f: p.items[0]?.f ?? {} });
    all.push(...p.items);
  });
  all.forEach((it, i) => {
    for (const key of ['underline', 'overline', 'strike'] as const) {
      const want = !!it.f[key];
      if (want !== on[key]) {
        out += codes[key];
        on[key] = want;
      }
    }
    if (it.k === 'stack') out += decodeStack(it.top) + (it.sep === '#' ? '/' : it.sep) + decodeStack(it.bot);
    else out += encodeItem(it, all[i + 1], 'text');
  });
  // 켜 둔 토글은 끝에서 닫는다(그리는 모양은 같다)
  for (const key of ['underline', 'overline', 'strike'] as const) if (on[key]) out += codes[key];
  return out;
}

// ---------------------------------------------------------------------------
// 쌓기 문자
// ---------------------------------------------------------------------------

/** 쌓기 원문(\로 이스케이프) → 보이는 글자 */
export function decodeStack(raw: string): string {
  return String.fromCodePoint(...decodePercent(raw.replace(/\\(.)/g, '$1')).filter((c) => c >= 0));
}

/** 보이는 글자 → 쌓기 원문(/ # ^ ; \ 는 \로) */
export function encodeStack(text: string): string {
  return text.replace(/[\\/#^;]/g, (c) => '\\' + c);
}

// ---------------------------------------------------------------------------
// 위치와 편집 연산(편집기가 쓴다). 위치는 문서 처음부터의 오프셋: 문단 사이는 1칸
// ---------------------------------------------------------------------------

export interface Pos {
  p: number;
  i: number;
}

export function docLength(doc: RichDoc): number {
  return doc.paras.reduce((a, p) => a + p.items.length, 0) + doc.paras.length - 1;
}

export function toPos(doc: RichDoc, off: number): Pos {
  let o = Math.max(0, off);
  for (let p = 0; p < doc.paras.length; p++) {
    const n = doc.paras[p]!.items.length;
    if (o <= n) return { p, i: o };
    o -= n + 1;
  }
  const last = doc.paras.length - 1;
  return { p: last, i: doc.paras[last]!.items.length };
}

export function toOff(doc: RichDoc, pos: Pos): number {
  let o = 0;
  for (let p = 0; p < pos.p && p < doc.paras.length; p++) o += doc.paras[p]!.items.length + 1;
  return o + pos.i;
}

/** 원래 표기를 뗀 사본(편집기 DOM에서 다시 읽은 모델과 같은 꼴: 고쳤는지 비교할 때) */
export function stripRaw(doc: RichDoc): RichDoc {
  return { paras: doc.paras.map((p) => ({ ...p, items: p.items.map((it) => (it.k === 'ch' && it.raw !== undefined ? { k: 'ch', c: it.c, f: it.f } : it)) })) };
}

export function cloneDoc(doc: RichDoc): RichDoc {
  return { paras: doc.paras.map((p) => ({ items: p.items.map((it) => ({ ...it })), pf: copyPf(p.pf), praw: [...p.praw], brk: p.brk })) };
}

/** a~b 사이(정렬해서) 조각들을 지운다. 문단 경계를 지우면 뒤 문단이 앞 문단에 붙는다 */
export function deleteRange(doc: RichDoc, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) return lo;
  const s = toPos(doc, lo);
  const e = toPos(doc, hi);
  const first = doc.paras[s.p]!;
  const last = doc.paras[e.p]!;
  const tail = last.items.slice(e.i);
  first.items = first.items.slice(0, s.i).concat(tail);
  doc.paras.splice(s.p + 1, e.p - s.p);
  return lo;
}

/** 조각들을 off에 넣고 그 뒤 위치를 돌려준다 */
export function insertItems(doc: RichDoc, off: number, items: Item[]): number {
  const at = toPos(doc, off);
  doc.paras[at.p]!.items.splice(at.i, 0, ...items);
  return off + items.length;
}

/** 문단을 나눈다(새 문단은 앞 문단의 서식을 이어받는다) */
export function splitPara(doc: RichDoc, off: number, brk: Para['brk'] = 'P'): number {
  const at = toPos(doc, off);
  const p = doc.paras[at.p]!;
  const rest = p.items.splice(at.i);
  doc.paras.splice(at.p + 1, 0, { items: rest, pf: copyPf(p.pf), praw: [], brk });
  return off + 1;
}

/** 글자들을 넣는다(\n은 문단 나누기, \t는 탭) */
export function insertText(doc: RichDoc, off: number, text: string, f: Fmt): number {
  let o = off;
  let buf: Item[] = [];
  const flush = () => {
    if (buf.length) o = insertItems(doc, o, buf);
    buf = [];
  };
  for (const c of text.replace(/\r\n?/g, '\n')) {
    if (c === '\n') {
      flush();
      o = splitPara(doc, o);
    } else if (c === '\t') buf.push({ k: 'tab', f });
    else if (c !== '​') buf.push({ k: 'ch', c, f });
  }
  flush();
  return o;
}

/** a~b 사이 조각 목록 */
export function itemsIn(doc: RichDoc, a: number, b: number): Item[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: Item[] = [];
  const s = toPos(doc, lo);
  const e = toPos(doc, hi);
  for (let p = s.p; p <= e.p; p++) {
    const items = doc.paras[p]!.items;
    out.push(...items.slice(p === s.p ? s.i : 0, p === e.p ? e.i : items.length));
  }
  return out;
}

/** a~b 사이 조각의 서식을 바꾼다 */
export function applyFmt(doc: RichDoc, a: number, b: number, fn: (f: Fmt) => Fmt): void {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const s = toPos(doc, lo);
  const e = toPos(doc, hi);
  for (let p = s.p; p <= e.p; p++) {
    const items = doc.paras[p]!.items;
    const i0 = p === s.p ? s.i : 0;
    const i1 = p === e.p ? e.i : items.length;
    for (let i = i0; i < i1; i++) items[i] = { ...items[i]!, f: cleanFmt(fn({ ...items[i]!.f })) } as Item;
  }
}

/** 정하지 않은 값(undefined·false)을 뺀다 */
export function cleanFmt(f: Fmt): Fmt {
  const o: Fmt = {};
  if (f.font) o.font = f.font;
  if (f.height) o.height = f.height;
  if (f.width !== undefined) o.width = f.width;
  if (f.oblique !== undefined) o.oblique = f.oblique;
  if (f.tracking !== undefined) o.tracking = f.tracking;
  if (f.color) o.color = f.color;
  if (f.valign !== undefined) o.valign = f.valign;
  if (f.underline) o.underline = true;
  if (f.overline) o.overline = true;
  if (f.strike) o.strike = true;
  return o;
}

/** off에서 입력할 글자의 서식(앞 글자, 문단 처음이면 뒤 글자) */
export function fmtAt(doc: RichDoc, off: number): Fmt {
  const at = toPos(doc, off);
  const items = doc.paras[at.p]!.items;
  const it = items[at.i - 1] ?? items[at.i];
  if (it) return it.f;
  // 빈 문단: 앞 문단의 마지막 글자
  for (let p = at.p - 1; p >= 0; p--) {
    const l = doc.paras[p]!.items;
    if (l.length) return l[l.length - 1]!.f;
  }
  return {};
}

/** 범위가 닿는 문단 번호들 */
export function parasIn(doc: RichDoc, a: number, b: number): number[] {
  const s = toPos(doc, Math.min(a, b)).p;
  const e = toPos(doc, Math.max(a, b)).p;
  const out: number[] = [];
  for (let p = s; p <= e; p++) out.push(p);
  return out;
}

/** 문단 서식을 바꾼다 */
export function setParaFmt(doc: RichDoc, a: number, b: number, patch: Partial<ParaFmt>): void {
  for (const p of parasIn(doc, a, b)) {
    const para = doc.paras[p]!;
    para.pf = { ...para.pf, ...patch, tabs: patch.tabs ? [...patch.tabs] : [...para.pf.tabs] };
  }
}

/** 보이는 글자(필드는 code 대신 value 함수가 준 값, 측정값은 <>) */
export function plainText(doc: RichDoc, fieldValue: (code: string) => string = () => '', measure = '<>'): string {
  return doc.paras
    .map((p) =>
      p.items
        .map((it) => {
          switch (it.k) {
            case 'ch':
              return it.c;
            case 'stack':
              return `${decodeStack(it.top)}/${decodeStack(it.bot)}`;
            case 'field':
              return fieldValue(it.code);
            case 'tab':
              return '\t';
            case 'measure':
              return measure;
          }
        })
        .join(''),
    )
    .join('\n');
}

export function hasFields(doc: RichDoc): boolean {
  return doc.paras.some((p) => p.items.some((it) => it.k === 'field'));
}

// ---------------------------------------------------------------------------
// 글머리 기호·번호 목록(AutoCAD처럼 표지 글자 + 탭 + 내어쓰기)
// ---------------------------------------------------------------------------

export type ListKind = 'off' | 'bullet' | 'number' | 'lower' | 'upper';

const LIST_MARK = /^(?:•|\d{1,3}\.|[a-zA-Z]\.)$/;

/** 문단 처음의 목록 표지(글자들 + 탭) 길이. 없으면 0 */
export function listMarkLength(p: Para): number {
  const tab = p.items.findIndex((it) => it.k === 'tab');
  if (tab < 1 || tab > 4) return 0;
  const mark = p.items
    .slice(0, tab)
    .map((it) => (it.k === 'ch' ? it.c : '\u0000'))
    .join('');
  return LIST_MARK.test(mark) ? tab + 1 : 0;
}

/** 목록 종류(표지가 없으면 off) */
export function listKindOf(p: Para): ListKind {
  const n = listMarkLength(p);
  if (!n) return 'off';
  const c = (p.items[0] as { c?: string }).c ?? '';
  if (c === '•') return 'bullet';
  if (/\d/.test(c)) return 'number';
  return c === c.toLowerCase() ? 'lower' : 'upper';
}

/** 범위의 문단을 목록으로(또는 목록 해제). indent는 내어쓰기 폭(도면 단위) */
export function setList(doc: RichDoc, a: number, b: number, kind: ListKind, indent: number): void {
  let n = 0;
  for (const pi of parasIn(doc, a, b)) {
    const p = doc.paras[pi]!;
    const had = listMarkLength(p);
    const f = p.items[had]?.f ?? p.items[0]?.f ?? {};
    if (had) p.items.splice(0, had);
    if (kind === 'off') {
      p.pf = { ...p.pf, indentFirst: 0, indentLeft: 0, tabs: [] };
      continue;
    }
    const mark = kind === 'bullet' ? '•' : kind === 'number' ? `${n + 1}.` : `${String.fromCharCode((kind === 'lower' ? 97 : 65) + (n % 26))}.`;
    n++;
    const items: Item[] = [...mark].map((c) => ({ k: 'ch', c, f }) as Item);
    items.push({ k: 'tab', f });
    p.items.unshift(...items);
    p.pf = { ...p.pf, indentFirst: -indent, indentLeft: indent, tabs: [indent] };
  }
}

// ---------------------------------------------------------------------------
// 글꼴 지정(\f 인수) 읽기·쓰기
// ---------------------------------------------------------------------------

export interface FontSpec {
  family: string;
  bold: boolean;
  italic: boolean;
  /** 나머지 항목(c·p 등) 원문 */
  rest: string[];
}

export function parseFontSpec(spec: string): FontSpec {
  const [family, ...parts] = spec.split('|');
  let bold = false;
  let italic = false;
  const rest: string[] = [];
  for (const p of parts) {
    if (/^b[01]$/.test(p)) bold = p === 'b1';
    else if (/^i[01]$/.test(p)) italic = p === 'i1';
    else if (p) rest.push(p);
  }
  return { family: (family ?? '').trim(), bold, italic, rest };
}

/** 트루타입 글꼴 지정(AutoCAD가 쓰는 꼴: 이름|b0|i0|c0|p34) */
export function buildFontSpec(s: FontSpec): string {
  const rest = s.rest.length ? s.rest : ['c0', 'p34'];
  return [s.family, `b${s.bold ? 1 : 0}`, `i${s.italic ? 1 : 0}`, ...rest].join('|');
}

// ---------------------------------------------------------------------------
// 뜻 비교: 서식 문자열을 화면 해석기(parseMText)로 읽은 결과를 표기와 무관한 꼴로
// ---------------------------------------------------------------------------

/** 문단·글자·서식(같은 서식의 이웃 글자는 합친다). 두 문자열의 이 값이 같으면 화면에 같게 그려진다 */
export function mtextMeaning(src: string, baseHeight = 1, attachment = 1): unknown[] {
  const r6 = (v: number) => +v.toFixed(6);
  return parseMText(src, { baseHeight }).map((p) => {
    const runs: { kind: string; style: string; text: string }[] = [];
    for (const run of p.runs) {
      const s = run.style;
      const style = JSON.stringify([s.font, s.font ? s.ttf : null, r6(s.height), r6(s.widthFactor), r6(s.oblique), r6(s.tracking), s.color, s.underline, s.overline, s.strike, s.valign]);
      if (run.stack) runs.push({ kind: 'stack', style, text: `${String.fromCodePoint(...run.stack.top)}${run.stack.type}${String.fromCodePoint(...run.stack.bottom)}` });
      else if (run.tab) runs.push({ kind: 'tab', style, text: '' });
      else {
        const text = String.fromCodePoint(...run.text);
        const prev = runs[runs.length - 1];
        if (prev && prev.kind === 'text' && prev.style === style) prev.text += text;
        else if (text) runs.push({ kind: 'text', style, text });
      }
    }
    return { align: p.align || ((Math.max(1, Math.min(9, attachment)) - 1) % 3) + 1, i: r6(p.indentFirst), l: r6(p.indentLeft), r: r6(p.indentRight), col: !!p.columnBreak, runs };
  });
}
