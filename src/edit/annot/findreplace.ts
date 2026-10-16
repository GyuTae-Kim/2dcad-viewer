/**
 * 문자 찾기·대치(FIND)의 순수 계산: 서식 문자열을 편집 모델(src/text/mtextedit)로 읽어 보이는 글자에서 찾고,
 * 일치한 글자만 바꿔 다시 쓴다(고치지 않은 글자·서식 코드는 원래 표기 그대로).
 * 일치는 한 문단 안에서만 찾는다. 쌓기·필드·탭·치수 측정값(<>)은 일치를 끊는다. 서식이 바뀌는 자리를 가로지르는
 * 일치도 바꾸며, 바꾼 글자는 일치의 첫 글자 서식을 받는다.
 */
import { type Item, type RichDoc, insertText, parseRich, serializeRich, toOff, deleteRange } from '../../text/mtextedit';

export interface FindOptions {
  /** 대소문자 구분 */
  matchCase: boolean;
  /** 전체 단어만 */
  wholeWord: boolean;
}

/** 문자열 종류: MTEXT 서식, TEXT·속성 문자열, 치수 문자 재지정(MTEXT + <>) */
export type TextMode = 'mtext' | 'text' | 'dim';

export interface TextMatch {
  para: number;
  /** 문단 안 조각 번호 [start, end) */
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}_]/u;

function chars(items: readonly Item[], matchCase: boolean): (string | null)[] {
  return items.map((it) => (it.k === 'ch' ? (matchCase ? it.c : it.c.toLowerCase()) : null));
}

function queryChars(q: string, matchCase: boolean): string[] {
  return [...q].map((c) => (matchCase ? c : c.toLowerCase()));
}

/** 모델에서 일치 찾기(겹치지 않게 앞에서부터) */
export function findInDoc(doc: RichDoc, query: string, opt: FindOptions): TextMatch[] {
  const out: TextMatch[] = [];
  const q = queryChars(query, opt.matchCase);
  if (!q.length) return out;
  doc.paras.forEach((p, pi) => {
    const cs = chars(p.items, opt.matchCase);
    for (let i = 0; i + q.length <= cs.length; i++) {
      let ok = true;
      for (let j = 0; j < q.length; j++) {
        if (cs[i + j] !== q[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (opt.wholeWord) {
        const before = p.items[i - 1];
        const after = p.items[i + q.length];
        const isWord = (it: Item | undefined) => it?.k === 'ch' && WORD.test(it.c);
        if (isWord(before) || isWord(after)) continue;
      }
      out.push({ para: pi, start: i, end: i + q.length });
      i += q.length - 1;
    }
  });
  return out;
}

/** 모델의 일치를 모두 바꾼다(바꾼 수) */
export function replaceInDoc(doc: RichDoc, query: string, replacement: string, opt: FindOptions): number {
  const ms = findInDoc(doc, query, opt);
  // 뒤에서부터 바꿔 앞의 위치가 그대로 있게
  for (let k = ms.length - 1; k >= 0; k--) {
    const m = ms[k]!;
    const f = doc.paras[m.para]!.items[m.start]!.f;
    const a = toOff(doc, { p: m.para, i: m.start });
    deleteRange(doc, a, a + (m.end - m.start));
    insertText(doc, a, replacement.replace(/\r?\n/g, ' '), f);
  }
  return ms.length;
}

function parse(src: string, mode: TextMode): RichDoc {
  return parseRich(src, { mode: mode === 'text' ? 'text' : 'mtext', measure: mode === 'dim' });
}

/** 서식 문자열 안의 일치 수 */
export function countMatches(src: string, mode: TextMode, query: string, opt: FindOptions): number {
  if (!query || !src) return 0;
  return findInDoc(parse(src, mode), query, opt).length;
}

/** 서식 문자열의 일치를 바꾼다. 일치가 없으면 문자열 그대로 */
export function replaceMatches(src: string, mode: TextMode, query: string, replacement: string, opt: FindOptions): { text: string; count: number } {
  if (!query || !src) return { text: src, count: 0 };
  const doc = parse(src, mode);
  const n = replaceInDoc(doc, query, replacement, opt);
  if (!n) return { text: src, count: 0 };
  return { text: serializeRich(doc, { mode: mode === 'text' ? 'text' : 'mtext' }), count: n };
}
