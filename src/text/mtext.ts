/**
 * 문자 서식 해석.
 * - TEXT·ATTRIB: %%c %%d %%p %%u %%o %%k %%% %%nnn, \U+XXXX
 * - MTEXT: \P \N \~ \\ \{ \} 와 \f \F \H \W \Q \T \C \c \A \p \S \L \l \O \o \K \k \X, { } 묶음
 */
import type { CadColor } from '../core/model';
import { decoderFor, mifEncoding } from '../core/codepage';

export interface RunStyle {
  /** 글꼴 이름(\f 또는 \F). 빈 문자열이면 문자 스타일의 글꼴 */
  font: string;
  /** 트루타입 글꼴 이름(\f)이면 true, SHX(\F)면 false, 정하지 않음 = null */
  ttf: boolean | null;
  /** 문자 높이 배율(스타일 높이 기준) — \H값x 는 곱하고, \H값 은 절대값 */
  height: number;
  widthFactor: number;
  oblique: number;
  tracking: number;
  color: CadColor | null;
  underline: boolean;
  overline: boolean;
  strike: boolean;
  /** 0 아래, 1 가운데, 2 위(\A) */
  valign: number;
  /** 트루타입 굵게·기울임(\f의 |b1·|i1). 정하지 않으면 문자 스타일을 따른다 */
  bold?: boolean;
  italic?: boolean;
}

export interface Run {
  style: RunStyle;
  /** 코드 포인트 */
  text: number[];
  /** 쌓기(\S): 위·아래 문자와 종류('/' 분수선, '#' 사선, '^' 공차) */
  stack?: { top: number[]; bottom: number[]; type: '/' | '#' | '^' };
  /** 탭 */
  tab?: boolean;
}

export interface Paragraph {
  runs: Run[];
  /** 0 기본(부착점을 따름), 1 왼쪽, 2 가운데, 3 오른쪽, 4 양쪽 */
  align: number;
  indentFirst: number;
  indentLeft: number;
  indentRight: number;
  tabs: number[];
  /** 단 나누기(\N) 다음 문단 */
  columnBreak?: boolean;
}

export interface ParseOptions {
  /** 기본 문자 높이(절대값 \H 해석용) */
  baseHeight: number;
}

function defaultStyle(): RunStyle {
  return {
    font: '',
    ttf: null,
    height: 1,
    widthFactor: 1,
    oblique: 0,
    tracking: 1,
    color: null,
    underline: false,
    overline: false,
    strike: false,
    valign: 0,
  };
}

/** %%코드 풀기(TEXT·MTEXT 공통). 밑줄·윗줄 토글은 문자 대신 특수 표지로 둔다. */
export const TOGGLE_UNDERLINE = -1;
export const TOGGLE_OVERLINE = -2;
export const TOGGLE_STRIKE = -3;

export function decodePercent(s: string, out: number[] = []): number[] {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 37 && s.charCodeAt(i + 1) === 37 && i + 2 < s.length) {
      const c = s[i + 2]!.toLowerCase();
      if (c === 'c') {
        out.push(0x2205);
        i += 2;
        continue;
      }
      if (c === 'd') {
        out.push(0xb0);
        i += 2;
        continue;
      }
      if (c === 'p') {
        out.push(0xb1);
        i += 2;
        continue;
      }
      if (c === 'u') {
        out.push(TOGGLE_UNDERLINE);
        i += 2;
        continue;
      }
      if (c === 'o') {
        out.push(TOGGLE_OVERLINE);
        i += 2;
        continue;
      }
      if (c === 'k') {
        out.push(TOGGLE_STRIKE);
        i += 2;
        continue;
      }
      if (c === '%') {
        out.push(37);
        i += 2;
        continue;
      }
      const m = /^\d{3}/.exec(s.slice(i + 2, i + 5));
      if (m) {
        out.push(parseInt(m[0], 10));
        i += 4;
        continue;
      }
    }
    if (ch === 92 && s[i + 1] === 'U' && s[i + 2] === '+' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 3, i + 7))) {
      out.push(parseInt(s.slice(i + 3, i + 7), 16));
      i += 6;
      continue;
    }
    if (ch === 92 && s[i + 1] === 'M' && s[i + 2] === '+' && /^[1-5][0-9a-fA-F]{4}/.test(s.slice(i + 3, i + 8))) {
      const n = Number(s[i + 3]);
      const code = parseInt(s.slice(i + 4, i + 8), 16);
      const txt = decoderFor(mifEncoding(n)).decode(new Uint8Array([code >> 8, code & 255]));
      for (const c of txt) out.push(c.codePointAt(0)!);
      i += 7;
      continue;
    }
    const cp = s.codePointAt(i)!;
    out.push(cp);
    if (cp > 0xffff) i++;
  }
  return out;
}

/** TEXT 문자열 → 코드 포인트(토글 표지 포함) */
export function parseTextString(s: string): number[] {
  return decodePercent(s);
}

function readUntil(s: string, i: number, end: string): [string, number] {
  const j = s.indexOf(end, i);
  if (j < 0) return [s.slice(i), s.length];
  return [s.slice(i, j), j + 1];
}

/** MTEXT 서식 문자열 해석 */
export function parseMText(src: string, opt: ParseOptions): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const newPara = (prev?: Paragraph): Paragraph => ({
    runs: [],
    align: prev?.align ?? 0,
    indentFirst: prev?.indentFirst ?? 0,
    indentLeft: prev?.indentLeft ?? 0,
    indentRight: prev?.indentRight ?? 0,
    tabs: prev?.tabs ?? [],
  });
  let para = newPara();
  paragraphs.push(para);
  const stack: RunStyle[] = [];
  let st = defaultStyle();
  let run: Run | null = null;
  const pushChar = (cp: number) => {
    if (!run || run.style !== st || run.stack || run.tab) {
      run = { style: st, text: [] };
      para.runs.push(run);
    }
    run.text.push(cp);
  };
  const modify = (fn: (s: RunStyle) => void) => {
    st = { ...st };
    fn(st);
    run = null;
  };
  const s = src;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '{') {
      stack.push(st);
      continue;
    }
    if (ch === '}') {
      st = stack.pop() ?? st;
      run = null;
      continue;
    }
    if (ch === '^' && i + 1 < s.length) {
      const c = s[i + 1]!;
      if (c === 'I') {
        para.runs.push({ style: st, text: [], tab: true });
        run = null;
        i++;
        continue;
      }
      if (c === 'J' || c === 'M') {
        para = newPara(para);
        paragraphs.push(para);
        run = null;
        i++;
        continue;
      }
      if (c === ' ') {
        pushChar(94);
        i++;
        continue;
      }
    }
    if (ch === '\t') {
      para.runs.push({ style: st, text: [], tab: true });
      run = null;
      continue;
    }
    if (ch === '\n') {
      para = newPara(para);
      paragraphs.push(para);
      run = null;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '%' && s[i + 1] === '%') {
      const tmp = decodePercent(s.slice(i, i + 5));
      // 코드 하나만 쓴다
      const first = tmp[0]!;
      if (first === TOGGLE_UNDERLINE) modify((x) => (x.underline = !x.underline));
      else if (first === TOGGLE_OVERLINE) modify((x) => (x.overline = !x.overline));
      else if (first === TOGGLE_STRIKE) modify((x) => (x.strike = !x.strike));
      else pushChar(first);
      const m = /^%%(\d{3})/.exec(s.slice(i));
      i += m ? 4 : 2;
      continue;
    }
    if (ch !== '\\') {
      const cp = s.codePointAt(i)!;
      pushChar(cp);
      if (cp > 0xffff) i++;
      continue;
    }
    // 역슬래시 코드
    const c = s[i + 1];
    if (c === undefined) break;
    i++;
    switch (c) {
      case '\\':
      case '{':
      case '}':
        pushChar(c.charCodeAt(0));
        break;
      case 'P':
        para = newPara(para);
        paragraphs.push(para);
        run = null;
        break;
      case 'N':
        para = newPara(para);
        para.columnBreak = true;
        paragraphs.push(para);
        run = null;
        break;
      case 'X':
        // 치수 문자의 줄 나누기(치수선 아래 부분)
        para = newPara(para);
        paragraphs.push(para);
        run = null;
        break;
      case '~':
        pushChar(0xa0);
        break;
      case 'U': {
        if (s[i + 1] === '+') {
          const hex = s.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            pushChar(parseInt(hex, 16));
            i += 5;
            break;
          }
        }
        pushChar(85);
        break;
      }
      case 'M': {
        if (s[i + 1] === '+') {
          const tmp = decodePercent('\\' + s.slice(i, i + 7));
          for (const cp of tmp) pushChar(cp);
          i += 6;
          break;
        }
        pushChar(77);
        break;
      }
      case 'L':
        modify((x) => (x.underline = true));
        break;
      case 'l':
        modify((x) => (x.underline = false));
        break;
      case 'O':
        modify((x) => (x.overline = true));
        break;
      case 'o':
        modify((x) => (x.overline = false));
        break;
      case 'K':
        modify((x) => (x.strike = true));
        break;
      case 'k':
        modify((x) => (x.strike = false));
        break;
      case 'f':
      case 'F': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const name = arg.split('|')[0]!.trim();
        modify((x) => {
          x.font = name;
          x.ttf = c === 'f' && !/\.shx$/i.test(name);
          x.bold = !!x.ttf && /\|b1(\||$)/.test(arg);
          x.italic = !!x.ttf && /\|i1(\||$)/.test(arg);
        });
        break;
      }
      case 'H': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const rel = /x$/i.test(arg.trim());
        const v = parseFloat(arg);
        if (Number.isFinite(v) && v > 0) modify((x) => (x.height = rel ? x.height * v : v / (opt.baseHeight || 1)));
        break;
      }
      case 'W': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseFloat(arg);
        if (Number.isFinite(v) && v > 0) modify((x) => (x.widthFactor = /x$/i.test(arg.trim()) ? x.widthFactor * v : v));
        break;
      }
      case 'Q': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseFloat(arg);
        if (Number.isFinite(v)) modify((x) => (x.oblique = (v * Math.PI) / 180));
        break;
      }
      case 'T': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const v = parseFloat(arg);
        if (Number.isFinite(v) && v > 0) modify((x) => (x.tracking = /x$/i.test(arg.trim()) ? x.tracking * v : v));
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
        // \c 값은 BGR 순서다
        if (Number.isFinite(v)) {
          const rgb = ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff);
          modify((x) => (x.color = { aci: 256, rgb }));
        }
        break;
      }
      case 'p': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        applyParagraph(para, arg);
        break;
      }
      case 'S': {
        const [arg, j] = readUntil(s, i + 1, ';');
        i = j - 1;
        const m = /^(.*?)([/#^])(.*)$/s.exec(arg);
        const top = decodePercent((m ? m[1]! : arg).replace(/\\(.)/g, '$1'));
        const bottom = decodePercent((m ? m[3]! : '').replace(/\\(.)/g, '$1'));
        para.runs.push({ style: st, text: [], stack: { top, bottom, type: (m?.[2] as '/' | '#' | '^') ?? '^' } });
        run = null;
        break;
      }
      default:
        // 모르는 코드는 글자로
        pushChar(c.charCodeAt(0));
        break;
    }
  }
  return paragraphs;
}

/** \p 문단 서식: xi첫줄,l왼쪽,r오른쪽,q[lcrjd],t탭 */
function applyParagraph(p: Paragraph, arg: string): void {
  for (const part of arg.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('x')) {
      applyParagraph(p, t.slice(1));
      continue;
    }
    const k = t[0];
    const v = t.slice(1);
    if (k === 'i') p.indentFirst = parseFloat(v) || 0;
    else if (k === 'l') p.indentLeft = parseFloat(v) || 0;
    else if (k === 'r') p.indentRight = parseFloat(v) || 0;
    else if (k === 'q') p.align = { l: 1, c: 2, r: 3, j: 4, d: 4 }[v[0] as 'l'] ?? 0;
    else if (k === 't') p.tabs = v.split(/[,]/).map(Number).filter(Number.isFinite);
  }
}

/** 문자열에 쓰인 코드 포인트(글꼴 조각을 받을 때 쓴다) */
export function collectCodePoints(s: string, into: Set<number>): void {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp > 126) into.add(cp);
  }
  if (s.includes('\\U+')) {
    for (const m of s.matchAll(/\\U\+([0-9a-fA-F]{4})/g)) into.add(parseInt(m[1]!, 16));
  }
  if (s.includes('\\M+')) {
    for (const cp of decodePercent(s)) if (cp > 126) into.add(cp);
  }
}
