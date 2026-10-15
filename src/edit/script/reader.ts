/**
 * 스크립트(.scr) 읽기: AutoCAD 규칙대로 글자를 명령행 입력으로 나눈다(화면·DOM 없음).
 * - 공백·탭·줄바꿈은 Enter다. 공백이 두 개면 그 사이에 빈 입력(Enter)이 하나 더 있다.
 * - 문자 입력처럼 공백을 받는 프롬프트에서는 줄 끝까지(공백 포함)가 한 입력이다.
 * - 공백을 받지 않는 프롬프트에서 `"…"`로 감싼 입력은 공백을 포함한 한 입력이다(따옴표는 뗀다. 파일 이름·도면층 이름 등).
 * - 줄의 첫 글자가 `;`인 줄은 주석이다(Enter도 아니다). 빈 줄은 Enter다.
 * - 마지막 줄은 줄바꿈이 없어도 입력한다.
 */

export interface ScriptToken {
  /** 넣을 글(빈 글 = Enter) */
  text: string;
  /** 시작한 줄 번호(1부터) */
  line: number;
}

export class ScriptReader {
  readonly text: string;
  private pos = 0;
  private line = 1;
  private lineStart = true;

  constructor(text: string) {
    // 바이트 순서 표시와 CR LF·CR 줄 끝
    this.text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  /** 처음부터 다시(RSCRIPT) */
  reset(): void {
    this.pos = 0;
    this.line = 1;
    this.lineStart = true;
  }

  /** 지금 줄 번호 */
  get currentLine(): number {
    return this.line;
  }

  /** 남은 입력이 없는가(주석 줄만 남아도 끝) */
  get done(): boolean {
    this.skipComments();
    return this.pos >= this.text.length;
  }

  /** 줄 수(마지막 빈 줄 빼고) */
  get lineCount(): number {
    const t = this.text.endsWith('\n') ? this.text.slice(0, -1) : this.text;
    return t ? t.split('\n').length : 0;
  }

  /** 다음 입력. spaces면 줄 끝까지(공백 포함)가 한 입력. 끝이면 null */
  next(spaces = false): ScriptToken | null {
    this.skipComments();
    const s = this.text;
    if (this.pos >= s.length) return null;
    const line = this.line;
    let i = this.pos;
    let text: string;
    if (spaces) {
      while (i < s.length && s[i] !== '\n') i++;
      text = s.slice(this.pos, i);
    } else if (s[i] === '"') {
      // 따옴표 안의 공백은 글자(닫는 따옴표가 줄 안에 없으면 줄 끝까지)
      const close = s.indexOf('"', i + 1);
      const eol = s.indexOf('\n', i + 1);
      const end = close >= 0 && (eol < 0 || close < eol) ? close : eol < 0 ? s.length : eol;
      text = s.slice(i + 1, end);
      i = end < s.length && s[end] === '"' ? end + 1 : end;
      // 닫는 따옴표 뒤에 붙은 글자도 같은 입력
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n') text += s[i++];
    } else {
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n') i++;
      text = s.slice(this.pos, i);
    }
    // 구분 글자(Enter) 먹기
    if (i < s.length) {
      if (s[i] === '\n') {
        this.line++;
        this.lineStart = true;
      } else this.lineStart = false;
      i++;
    } else this.lineStart = false;
    this.pos = i;
    return { text, line };
  }

  /** 줄 첫 글자가 ;인 줄 건너뛰기 */
  private skipComments(): void {
    const s = this.text;
    while (this.lineStart && this.pos < s.length && s[this.pos] === ';') {
      const eol = s.indexOf('\n', this.pos);
      if (eol < 0) {
        this.pos = s.length;
        return;
      }
      this.pos = eol + 1;
      this.line++;
    }
  }
}

/** 스크립트 파일 바이트 → 글. UTF-8(BOM 있거나 없거나)·UTF-16(BOM)을 먼저 보고, UTF-8로 읽을 수 없으면 CP949(한국어 Windows) */
export function decodeScript(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'cp949' } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    // WHATWG의 euc-kr은 CP949(통합형 한글 코드)다
    return { text: new TextDecoder('euc-kr').decode(body), encoding: 'cp949' };
  }
}

export interface CommandWord {
  /** 접두어를 뗀 명령 이름(대문자, 앞의 -는 남긴다) */
  name: string;
  /** ' 접두어(투명 명령) */
  transparent: boolean;
  /** _ 접두어(국제 명령 이름) */
  international: boolean;
  /** . 접두어(재정의 무시) */
  builtin: boolean;
}

/** 명령 자리의 입력에서 접두어(_ . ')를 뗀다. 이름이 없으면 null */
export function parseCommandWord(text: string): CommandWord | null {
  let s = text.trim();
  const w: CommandWord = { name: '', transparent: false, international: false, builtin: false };
  while (s && /^[_.']/.test(s)) {
    if (s[0] === "'") w.transparent = true;
    else if (s[0] === '_') w.international = true;
    else w.builtin = true;
    s = s.slice(1);
  }
  if (!s || /\s/.test(s)) return null;
  w.name = s.toUpperCase();
  return w;
}

/** 프롬프트 답의 국제 키워드 접두어(_C → C). 좌표·숫자·글은 그대로 */
export function stripKeywordPrefix(text: string): string {
  return /^_[A-Za-z?]/.test(text) ? text.slice(1) : text;
}

/**
 * 스크립트에서 명령행 버전(-이름)으로 바꾸지 않는 명령: AutoCAD에서 원래 명령행으로 동작하는 것.
 * HATCH는 명령행 프롬프트가 -HATCH와 다르고, ARRAY는 연관 배열(명령행)이다.
 */
export const KEEP_IN_SCRIPT = new Set(['HATCH', 'H', 'BHATCH', 'BH', 'GRADIENT', 'GD', 'ARRAY', 'AR', 'ARRAYRECT', 'ARRAYPOLAR', 'ARRAYPATH', 'SCRIPT', 'SCR']);

/**
 * 스크립트가 부를 명령 이름: 대화상자 명령에 명령행 버전(-이름)이 있으면 그것(FILEDIA·CMDDIA = 0처럼).
 * typed = 입력한 이름(별칭일 수 있다), canonical = 그 명령의 등록 이름. has = 정확히 그 이름으로 등록됐는가
 */
export function scriptCommandName(typed: string, canonical: string, has: (name: string) => boolean): string {
  const t = typed.toUpperCase();
  const c = canonical.toUpperCase();
  if (t.startsWith('-') || c.startsWith('-') || KEEP_IN_SCRIPT.has(t) || KEEP_IN_SCRIPT.has(c)) return canonical;
  if (has(`-${t}`)) return `-${t}`;
  if (has(`-${c}`)) return `-${c}`;
  return canonical;
}

/** 선택 프롬프트의 좌표 "x,y"(앞에 @면 last 기준). 아니면 null */
export function parseScriptPoint(text: string, last: { x: number; y: number } | null): { x: number; y: number } | null {
  const t = text.trim().replace(/\s+/g, '');
  const rel = t.startsWith('@');
  const body = rel ? t.slice(1) : t;
  const base = rel ? (last ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
  const num = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)';
  const xy = new RegExp(`^${num},${num}(?:,${num})?$`, 'i').exec(body);
  if (xy) return { x: base.x + parseFloat(xy[1]!), y: base.y + parseFloat(xy[2]!) };
  const polar = new RegExp(`^${num}<${num}$`, 'i').exec(body);
  if (polar) {
    const d = parseFloat(polar[1]!);
    const a = (parseFloat(polar[2]!) * Math.PI) / 180;
    return { x: base.x + d * Math.cos(a), y: base.y + d * Math.sin(a) };
  }
  return null;
}
