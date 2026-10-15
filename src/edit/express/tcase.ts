/**
 * TCASE(Express Tools 문자 대소문자 바꾸기) 계산(UI 없음).
 *
 * 글자만 바꾸고 서식은 그대로 둔다:
 * - MTEXT: `\P` 줄바꿈, `\~` 줄 바꿈 없는 공백, `\f…;` `\H…;` `\C…;` 같은 서식 코드, `{ }` 묶음, `\\ \{ \}` 탈출 글자,
 *   `\U+XXXX`·`\M+NXXXX` 글자 코드, `^I` 같은 캐럿 제어 글자, `%%c` 같은 특수 글자 코드, `%<…>%` 필드.
 *   스택(`\S위^아래;`)의 위·아래 글자는 바꾼다(구분 기호는 글자가 아니라 그대로다).
 * - TEXT·속성: `%%c` `%%d` `%%p` `%%u` `%%o` `%%nnn`, `\U+XXXX`, `\M+NXXXX`, `%<…>%` 필드만 서식이다(역슬래시는 글자).
 *
 * 문장 대소문자: 문자열 처음, 단락이 바뀐 뒤, 마침표·느낌표·물음표 다음에 공백이 오면 새 문장이다.
 *   문장의 첫 글자(글자나 숫자)만 대문자로, 나머지 글자는 소문자로.
 * 제목: 단어(글자·숫자·작은따옴표가 이어진 것)의 첫 글자를 대문자로, 나머지를 소문자로.
 * 대소문자 전환: 대문자는 소문자로, 소문자는 대문자로.
 */
import type { AttribEntity, Entity, InsertEntity, MLeaderEntity, MTextEntity } from '../../core/model';
import { cloneEntity } from '../geom/path';

export type CaseMode = 'sentence' | 'lower' | 'upper' | 'title' | 'toggle';

export const CASE_LABEL: Record<CaseMode, string> = {
  sentence: '문장 대소문자',
  lower: '소문자',
  upper: '대문자',
  title: '제목',
  toggle: '대소문자 전환',
};

/** 문자열 조각: 바꿀 수 있는 글자(lit)이거나 서식(그대로 둔다) */
export interface CaseToken {
  lit: boolean;
  s: string;
  /** 서식이 문장·단어 경계에 주는 뜻: para 단락(새 문장), space 공백, punct 글자가 아닌 기호, word 단어 안 글자(필드) */
  brk?: 'para' | 'space' | 'punct' | 'word';
}

const SEMI_CODES = new Set(['A', 'C', 'c', 'F', 'f', 'H', 'Q', 'T', 'W', 'p']);
const TOGGLES = new Set(['L', 'l', 'O', 'o', 'K', 'k']);

/** %<…>% 필드의 끝(내포된 필드도 센다). 짝이 없으면 -1 */
function fieldEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length - 1; j++) {
    if (s[j] === '%' && s[j + 1] === '<') {
      depth++;
      j++;
    } else if (s[j] === '>' && s[j + 1] === '%') {
      depth--;
      j++;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/** %% 특수 글자 코드의 길이(아니면 0) */
function percentLen(s: string, i: number): number {
  if (s[i] !== '%' || s[i + 1] !== '%') return 0;
  const c = s[i + 2];
  if (c === undefined) return 0;
  if (/\d/.test(c)) {
    let j = i + 2;
    while (j < s.length && j < i + 5 && /\d/.test(s[j]!)) j++;
    return j - i;
  }
  if (/[cdpuokCDPUOK%]/.test(c)) return 3;
  return 0;
}

/** %% 코드가 경계에 주는 뜻: 밑줄·윗줄·취소선 켜고 끄기는 보이지 않는다 */
function percentBreak(code: string): CaseToken['brk'] {
  return /^%%[uokUOK]$/.test(code) ? undefined : 'punct';
}

/** \U+XXXX(4자리 16진)·\M+NXXXX(1 + 4자리) 길이(아니면 0) */
function unicodeLen(s: string, i: number): number {
  if (s[i] !== '\\') return 0;
  const k = s[i + 1];
  if ((k === 'U' || k === 'u') && s[i + 2] === '+' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 3, i + 7))) return 7;
  if ((k === 'M' || k === 'm') && s[i + 2] === '+' && /^[0-9a-fA-F]{5}$/.test(s.slice(i + 3, i + 8))) return 8;
  return 0;
}

function pushLit(out: CaseToken[], s: string, from: number): number {
  const cp = s.codePointAt(from)!;
  const ch = String.fromCodePoint(cp);
  out.push({ lit: true, s: ch });
  return from + ch.length;
}

/** 한 줄 문자(TEXT·속성) 조각 */
export function tokenizeText(s: string): CaseToken[] {
  const out: CaseToken[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '%' && s[i + 1] === '<') {
      const e = fieldEnd(s, i);
      if (e > 0) {
        out.push({ lit: false, s: s.slice(i, e), brk: 'word' });
        i = e;
        continue;
      }
    }
    const p = percentLen(s, i);
    if (p) {
      const code = s.slice(i, i + p);
      out.push({ lit: false, s: code, brk: percentBreak(code) });
      i += p;
      continue;
    }
    const u = unicodeLen(s, i);
    if (u) {
      out.push({ lit: false, s: s.slice(i, i + u), brk: 'punct' });
      i += u;
      continue;
    }
    i = pushLit(out, s, i);
  }
  return out;
}

/** 여러 줄 문자(MTEXT·치수 문자 재지정·다중 지시선 문자) 조각 */
export function tokenizeMText(s: string): CaseToken[] {
  const out: CaseToken[] = [];
  let i = 0;
  let inStack = false;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '%' && s[i + 1] === '<') {
      const e = fieldEnd(s, i);
      if (e > 0) {
        out.push({ lit: false, s: s.slice(i, e), brk: 'word' });
        i = e;
        continue;
      }
    }
    const p = percentLen(s, i);
    if (p) {
      const code = s.slice(i, i + p);
      out.push({ lit: false, s: code, brk: percentBreak(code) });
      i += p;
      continue;
    }
    if (inStack && c === ';') {
      out.push({ lit: false, s: ';' });
      inStack = false;
      i++;
      continue;
    }
    if (c === '{' || c === '}') {
      out.push({ lit: false, s: c });
      i++;
      continue;
    }
    if (inStack && (c === '^' || c === '/' || c === '#')) {
      out.push({ lit: false, s: c, brk: 'punct' });
      i++;
      continue;
    }
    if (c === '^' && i + 1 < s.length) {
      // 캐럿 제어 글자(^I 탭, ^J 줄바꿈 …)
      const ctl = s[i + 1]!;
      out.push({ lit: false, s: s.slice(i, i + 2), brk: ctl === 'J' || ctl === 'M' ? 'para' : 'space' });
      i += 2;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      const k = s[i + 1]!;
      const u = unicodeLen(s, i);
      if (u) {
        out.push({ lit: false, s: s.slice(i, i + u), brk: 'punct' });
        i += u;
        continue;
      }
      if (k === 'P' || k === 'X' || k === 'N') {
        out.push({ lit: false, s: s.slice(i, i + 2), brk: 'para' });
        i += 2;
        continue;
      }
      if (k === '~') {
        out.push({ lit: false, s: '\\~', brk: 'space' });
        i += 2;
        continue;
      }
      if (k === '\\' || k === '{' || k === '}' || (inStack && (k === ';' || k === '^' || k === '/' || k === '#'))) {
        out.push({ lit: false, s: s.slice(i, i + 2), brk: 'punct' });
        i += 2;
        continue;
      }
      if (TOGGLES.has(k)) {
        out.push({ lit: false, s: s.slice(i, i + 2) });
        i += 2;
        continue;
      }
      if (k === 'S') {
        out.push({ lit: false, s: '\\S' });
        inStack = true;
        i += 2;
        continue;
      }
      if (SEMI_CODES.has(k)) {
        const e = s.indexOf(';', i + 2);
        const end = e < 0 ? s.length : e + 1;
        out.push({ lit: false, s: s.slice(i, end) });
        i = end;
        continue;
      }
      // 모르는 탈출: 두 글자 그대로
      out.push({ lit: false, s: s.slice(i, i + 2), brk: 'punct' });
      i += 2;
      continue;
    }
    i = pushLit(out, s, i);
  }
  return out;
}

const isLetter = (ch: string) => /\p{L}/u.test(ch);
const isWordChar = (ch: string) => /[\p{L}\p{N}'’]/u.test(ch);
const isSpace = (ch: string) => /\s/u.test(ch) || ch === '　';
const isTerminator = (ch: string) => ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？';

function toggleChar(ch: string): string {
  const up = ch.toUpperCase();
  const lo = ch.toLowerCase();
  if (up === lo) return ch;
  return ch === up ? lo : up;
}

/** 조각에 대소문자 방식을 적용해 다시 문자열로 */
export function applyCaseTokens(tokens: readonly CaseToken[], mode: CaseMode): string {
  let out = '';
  let sentenceStart = true;
  let pendingEnd = false;
  let prevWord = false;
  for (const t of tokens) {
    if (!t.lit) {
      out += t.s;
      switch (t.brk) {
        case 'para':
          sentenceStart = true;
          pendingEnd = false;
          prevWord = false;
          break;
        case 'space':
          if (pendingEnd) sentenceStart = true;
          pendingEnd = false;
          prevWord = false;
          break;
        case 'punct':
          pendingEnd = false;
          prevWord = false;
          break;
        case 'word':
          pendingEnd = false;
          sentenceStart = false;
          prevWord = true;
          break;
        default:
          break;
      }
      continue;
    }
    const ch = t.s;
    let next = ch;
    switch (mode) {
      case 'upper':
        next = ch.toUpperCase();
        break;
      case 'lower':
        next = ch.toLowerCase();
        break;
      case 'toggle':
        next = toggleChar(ch);
        break;
      case 'title':
        if (isLetter(ch)) next = prevWord ? ch.toLowerCase() : ch.toUpperCase();
        break;
      case 'sentence':
        if (isLetter(ch)) next = sentenceStart ? ch.toUpperCase() : ch.toLowerCase();
        break;
    }
    out += next;
    // 다음 글자를 위한 상태
    if (isSpace(ch)) {
      if (pendingEnd) sentenceStart = true;
      pendingEnd = false;
      prevWord = false;
    } else if (isTerminator(ch)) {
      pendingEnd = true;
      prevWord = false;
    } else {
      if (/[\p{L}\p{N}]/u.test(ch)) sentenceStart = false;
      pendingEnd = false;
      prevWord = isWordChar(ch);
    }
  }
  return out;
}

/** 한 줄 문자 문자열의 대소문자 */
export function caseText(s: string, mode: CaseMode): string {
  return applyCaseTokens(tokenizeText(s), mode);
}

/** 여러 줄 문자 서식 문자열의 대소문자(서식 코드 보존) */
export function caseMText(s: string, mode: CaseMode): string {
  return applyCaseTokens(tokenizeMText(s), mode);
}

/** 치수 문자 재지정: "<>"(측정값 자리)·"[]"(대체 단위 자리)는 그대로 */
export function caseDimText(s: string, mode: CaseMode): string {
  if (!s || s === ' ') return s;
  return caseMText(s, mode);
}

function caseAttrib(a: AttribEntity, mode: CaseMode): AttribEntity {
  const next = structuredClone(a);
  next.text = caseText(a.text, mode);
  if (next.mtext) next.mtext.text = caseMText(next.mtext.text, mode);
  return next;
}

/** TCASE를 받는 객체 종류 */
export function isCaseTarget(e: Entity): boolean {
  switch (e.type) {
    case 'TEXT':
    case 'MTEXT':
    case 'ATTDEF':
    case 'ATTRIB':
    case 'DIMENSION':
    case 'MULTILEADER':
    case 'ARCALIGNEDTEXT':
      return true;
    case 'INSERT':
      return e.attribs.length > 0;
    default:
      return false;
  }
}

/** 객체 하나의 대소문자를 바꾼다. 바뀌지 않으면 null */
export function caseEntity(e: Entity, mode: CaseMode): Entity | null {
  let out: Entity | null = null;
  switch (e.type) {
    case 'TEXT': {
      const t = caseText(e.text, mode);
      if (t !== e.text) out = { ...cloneEntity(e), text: t };
      break;
    }
    case 'ATTDEF':
    case 'ATTRIB': {
      const a = e as AttribEntity;
      const n = caseAttrib(a, mode);
      if (n.text !== a.text || n.mtext?.text !== a.mtext?.text) {
        const c = cloneEntity(a as Entity) as AttribEntity;
        c.text = n.text;
        if (c.mtext && n.mtext) c.mtext.text = n.mtext.text;
        out = c as Entity;
      }
      break;
    }
    case 'MTEXT': {
      const t = caseMText(e.text, mode);
      if (t !== e.text) out = { ...cloneEntity(e as MTextEntity), text: t };
      break;
    }
    case 'DIMENSION': {
      const t = caseDimText(e.text, mode);
      if (t !== e.text) out = { ...cloneEntity(e), text: t };
      break;
    }
    case 'MULTILEADER': {
      const ml = e as MLeaderEntity;
      const src = ml.context.text?.text;
      if (src === undefined) break;
      const t = caseMText(src, mode);
      if (t !== src) {
        const c = cloneEntity(ml);
        c.context.text!.text = t;
        out = c;
      }
      break;
    }
    case 'ARCALIGNEDTEXT': {
      const t = caseText(e.text, mode);
      if (t !== e.text) out = { ...cloneEntity(e), text: t };
      break;
    }
    case 'INSERT': {
      const ins = e as InsertEntity;
      let changed = false;
      const attribs = ins.attribs.map((a) => {
        const n = caseAttrib(a, mode);
        if (n.text !== a.text || n.mtext?.text !== a.mtext?.text) {
          changed = true;
          return n;
        }
        return structuredClone(a);
      });
      if (changed) out = { ...cloneEntity(ins), attribs };
      break;
    }
    default:
      break;
  }
  return out;
}
