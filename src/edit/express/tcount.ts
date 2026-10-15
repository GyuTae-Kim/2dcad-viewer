/**
 * TCOUNT(Express Tools 문자에 일련번호 넣기) 계산(UI 없음).
 * 정렬: X(왼쪽 → 오른쪽), Y(위 → 아래), 선택 순서. 같은 줄·같은 열이면 다른 축으로 정한다.
 * 번호: 시작 번호와 증분(소수 가능 — 입력의 소수 자리 수를 따른다).
 * 넣는 자리: 덮어쓰기(문자 전체를 번호로), 접두어("번호 문자"), 접미어("문자 번호"), 찾아 바꾸기(찾는 문자열을 번호로).
 */
import type { CadDocument, Entity, MTextEntity, TextEntity, Vec2 } from '../../core/model';
import { cloneEntity } from '../geom/path';
import { textBox } from './textbox';

export type CountSort = 'X' | 'Y' | 'S';
export type CountPlace = 'O' | 'P' | 'S' | 'F';

export const SORT_LABEL: Record<CountSort, string> = { X: 'X', Y: 'Y', S: '선택 순서' };
export const PLACE_LABEL: Record<CountPlace, string> = { O: '덮어쓰기', P: '접두어', S: '접미어', F: '찾아서 바꾸기' };

/** TCOUNT를 받는 객체 */
export function isCountTarget(e: Entity): e is TextEntity | MTextEntity {
  return e.type === 'TEXT' || e.type === 'MTEXT';
}

/** 정렬에 쓰는 자리(문자 상자 가운데) */
export function countPoint(e: Entity, doc: CadDocument): Vec2 {
  const b = textBox(e, doc);
  if (b) return b.c;
  const ins = (e as { insert?: Vec2 }).insert;
  return ins ? { x: ins.x, y: ins.y } : { x: 0, y: 0 };
}

/**
 * 정렬한 순서(핸들). items는 선택 순서다.
 * X: X가 작은 것부터(같으면 위에 있는 것부터). Y: Y가 큰 것(위)부터(같으면 왼쪽부터). S: 선택 순서 그대로.
 * 같다고 보는 차이: tol(기본 = 좌표 크기의 1e-9).
 */
export function sortForCount(items: readonly { handle: string; p: Vec2 }[], sort: CountSort, tol?: number): string[] {
  if (sort === 'S') return items.map((i) => i.handle);
  const t = tol ?? Math.max(1e-9, ...items.map((i) => Math.max(Math.abs(i.p.x), Math.abs(i.p.y)) * 1e-9));
  const cmp = (a: number, b: number) => (Math.abs(a - b) <= t ? 0 : a < b ? -1 : 1);
  const order = items.map((it, i) => ({ ...it, i }));
  order.sort((a, b) => {
    if (sort === 'X') return cmp(a.p.x, b.p.x) || -cmp(a.p.y, b.p.y) || a.i - b.i;
    return -cmp(a.p.y, b.p.y) || cmp(a.p.x, b.p.x) || a.i - b.i;
  });
  return order.map((o) => o.handle);
}

/** "시작,증분" 입력 읽기. 틀리면 null */
export function parseStartIncrement(text: string): { start: number; inc: number; decimals: number } | null {
  const m = /^\s*(-?\d+(?:\.\d*)?|-?\.\d+)\s*(?:,\s*(-?\d+(?:\.\d*)?|-?\.\d+)\s*)?$/.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  const inc = m[2] !== undefined ? Number(m[2]) : 1;
  if (!Number.isFinite(start) || !Number.isFinite(inc)) return null;
  return { start, inc, decimals: Math.max(decimalsOf(m[1]!), m[2] !== undefined ? decimalsOf(m[2]) : 0) };
}

function decimalsOf(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** i번째(0부터) 번호 문자열 */
export function countNumber(start: number, inc: number, i: number, decimals = 0): string {
  const v = start + inc * i;
  const r = decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
  return r === '-0' ? '0' : r;
}

/** 찾는 문자열을 모두 번호로 바꾼다(대소문자 구분). 없으면 null */
function replaceAllLiteral(s: string, find: string, rep: string): string | null {
  if (!find || !s.includes(find)) return null;
  return s.split(find).join(rep);
}

/** 여러 줄 문자의 첫 글자 앞(맨 앞 서식 묶음 `{\f…;` 뒤)에 넣을 자리 */
function mtextBodyStart(s: string): number {
  let i = 0;
  for (;;) {
    if (s[i] === '{') {
      i++;
      continue;
    }
    const m = /^\\[ACcFfHQTWp][^;]*;/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      continue;
    }
    break;
  }
  return i;
}

/** 번호를 넣은 새 문자열. 바꿀 것이 없으면 null(찾아 바꾸기에서 찾는 문자열이 없을 때) */
export function placeNumber(text: string, mtext: boolean, num: string, place: CountPlace, find = ''): string | null {
  switch (place) {
    case 'O':
      return num;
    case 'P': {
      if (!mtext) return `${num} ${text}`;
      const k = mtextBodyStart(text);
      return `${text.slice(0, k)}${num} ${text.slice(k)}`;
    }
    case 'S':
      return `${text} ${num}`;
    case 'F':
      return replaceAllLiteral(text, find, num);
  }
}

export interface CountPlan {
  handle: string;
  after: Entity;
  number: string;
}

/**
 * 고른 문자(선택 순서)에 번호를 넣는다. 찾아 바꾸기에서 찾는 문자열이 없는 문자는 건너뛰고 번호도 쓰지 않는다.
 */
export function planCount(
  list: readonly Entity[],
  doc: CadDocument,
  opt: { sort: CountSort; start: number; inc: number; decimals?: number; place: CountPlace; find?: string },
): CountPlan[] {
  const texts = list.filter(isCountTarget);
  const order = sortForCount(
    texts.map((e) => ({ handle: e.handle, p: countPoint(e, doc) })),
    opt.sort,
  );
  const byHandle = new Map(texts.map((e) => [e.handle, e] as const));
  const out: CountPlan[] = [];
  let i = 0;
  for (const h of order) {
    const e = byHandle.get(h)!;
    const num = countNumber(opt.start, opt.inc, i, opt.decimals ?? 0);
    const next = placeNumber(e.text, e.type === 'MTEXT', num, opt.place, opt.find);
    if (next === null) continue;
    i++;
    if (next === e.text) continue;
    const after = cloneEntity(e);
    after.text = next;
    out.push({ handle: h, after, number: num });
  }
  return out;
}
