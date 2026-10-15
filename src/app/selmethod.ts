/**
 * 객체 선택 방식: 윈도우(W)·걸침(C)·상자(BOX)·윈도우 폴리곤(WP)·걸침 폴리곤(CP)·울타리(F).
 * - 기하(WP는 완전히 안, CP는 안이거나 변과 만남, F는 울타리 선과 만남)는 src/edit/geom/selpoly.ts.
 * - 대화(runSelectMethod): 명령의 "객체 선택:" 프롬프트에서 방식 키워드를 받으면 점을 차례로 묻고 미리보기 다각형·선을 그린다.
 *   Enter로 마치고 U로 마지막 점을 지운다. App·시험의 가짜 App이 같은 함수를 쓴다.
 * 스크립트 실행기(src/edit/script/runner.ts)와 AutoLISP ssget은 점 목록을 받아 Picker에 바로 넘긴다.
 */
import type { Keyword, PointResult } from './app';
import type { Pt } from './view';
import { SELF_CROSS, polygonWouldCross } from '../edit/geom/selpoly';

export type SelMethod = 'W' | 'C' | 'BOX' | 'WP' | 'CP' | 'F';

/** 선택 프롬프트에 더하는 방식 키워드(AutoCAD 2026 한국어판 이름) */
export const SELECT_METHODS: readonly Keyword[] = [
  { key: 'W', label: '윈도우' },
  { key: 'C', label: '걸침' },
  { key: 'BOX', label: '상자' },
  { key: 'WP', label: '윈도우 폴리곤' },
  { key: 'CP', label: '걸침 폴리곤' },
  { key: 'F', label: '울타리' },
];

const ALIASES: Record<string, SelMethod> = { W: 'W', WINDOW: 'W', C: 'C', CROSSING: 'C', BOX: 'BOX', WP: 'WP', WPOLYGON: 'WP', CP: 'CP', CPOLYGON: 'CP', F: 'F', FENCE: 'F' };

/** 입력이 선택 방식 키워드면 그 방식(국제 접두어 _ 허용) */
export function selectMethodOf(text: string): SelMethod | null {
  return ALIASES[text.trim().replace(/^_+/, '').toUpperCase()] ?? null;
}

/** 잘못된 선택 입력에 보이는 안내 */
export const SELECT_HELP = '점 또는 윈도우(W)/최종(L)/걸침(C)/상자(BOX)/모두(ALL)/울타리(F)/윈도우 폴리곤(WP)/걸침 폴리곤(CP)/추가(A)/제거(R)/이전(P)이(가) 필요함';

// --------------------------------------------------------------------------- 대화

/** 선택 방식이 점을 묻는 데 쓰는 것 */
export interface SelectMethodIO {
  getPoint(prompt: string, opt: { base?: Pt | null; keywords?: Keyword[]; rubber?: (p: Pt) => { pts: number[]; closed?: boolean; fill?: boolean; dashed?: boolean }[] }): Promise<PointResult>;
  print(text: string, cls?: 'err' | 'res'): void;
}

/** 선택 방식이 객체를 고르는 데 쓰는 것(App의 Picker) */
export interface SelectMethodPicker {
  select(r: [number, number, number, number], crossing: boolean): string[];
  selectPolygon(poly: Pt[], crossing: boolean): string[];
  selectFence(pts: Pt[]): string[];
}

const UNDO: Keyword = { key: 'U', label: '명령 취소' };
const flat = (ps: readonly Pt[]) => ps.flatMap((p) => [p.x, p.y]);

/** 점 하나 받기(글·키워드가 아닌 점이 올 때까지). Enter면 null, U면 'U' */
async function pointOrEnd(io: SelectMethodIO, prompt: string, opt: Parameters<SelectMethodIO['getPoint']>[1], undo: boolean): Promise<Pt | 'U' | null> {
  for (;;) {
    const r = await io.getPoint(prompt, opt);
    if ('point' in r) return r.point;
    if ('enter' in r) return null;
    const k = ('keyword' in r ? r.keyword : r.text).trim().toUpperCase();
    if (undo && (k === 'U' || k === '_U' || k === 'UNDO')) return 'U';
    io.print('점이 필요합니다.', 'err');
  }
}

/**
 * 선택 방식 하나를 실행해 고른 핸들을 돌려준다(Enter·취소로 아무것도 고르지 않으면 null).
 * 윈도우·걸침·상자는 두 구석, 폴리곤·울타리는 점을 차례로 받고 Enter로 마친다.
 */
export async function runSelectMethod(method: SelMethod, io: SelectMethodIO, pick: SelectMethodPicker): Promise<string[] | null> {
  if (method === 'W' || method === 'C' || method === 'BOX') {
    const a = await pointOrEnd(io, '첫 번째 구석 지정:', {}, false);
    if (!a || a === 'U') return null;
    const rect = (p: Pt) => {
      const crossing = method === 'C' || (method === 'BOX' && p.x < a.x);
      return [{ pts: [a.x, a.y, p.x, a.y, p.x, p.y, a.x, p.y], closed: true, fill: true, dashed: crossing }];
    };
    const b = await pointOrEnd(io, '반대 구석 지정:', { base: a, rubber: rect }, false);
    if (!b || b === 'U') return null;
    const crossing = method === 'C' || (method === 'BOX' && b.x < a.x);
    return pick.select([Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)], crossing);
  }
  const fence = method === 'F';
  const pts: Pt[] = [];
  for (;;) {
    const prompt = pts.length === 0 ? (fence ? '첫 번째 울타리 점 지정:' : '첫 번째 폴리곤 점:') : fence ? '다음 울타리 점 지정 또는 [명령 취소(U)]:' : '선의 끝점 지정 또는 [명령 취소(U)]:';
    const rubber = pts.length
      ? (p: Pt) => (fence ? [{ pts: flat([...pts, p]), dashed: true }] : [{ pts: flat([...pts, p]), closed: true, fill: true, dashed: method === 'CP' }])
      : undefined;
    const p = await pointOrEnd(io, prompt, { base: pts[pts.length - 1] ?? null, keywords: pts.length ? [UNDO] : [], rubber }, pts.length > 0);
    if (p === null) break;
    if (p === 'U') {
      pts.pop();
      continue;
    }
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) === 0) continue;
    if (!fence && pts.length >= 2 && polygonWouldCross(pts, p)) {
      io.print(SELF_CROSS, 'err');
      continue;
    }
    pts.push(p);
  }
  if (fence) return pts.length >= 2 ? pick.selectFence(pts) : [];
  return pts.length >= 3 ? pick.selectPolygon(pts, method === 'CP') : [];
}
