/**
 * UNDO: 명령 취소할 작업의 수, 자동(A)·조정(C)·시작(BE)·끝(E)·표식(M)·뒤(B). U·REDO는 그대로(src/app/draw.ts).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 *  - 표식·그룹은 명령 취소 목록의 항목(트랜잭션)을 그대로 기억한다 — 500개 상한으로 밀려나거나 합쳐져도 자리를 잃지 않게.
 *  - 시작(BE) … 끝(E) 사이에 확정한 명령은 끝(E)에서 명령 취소 한 단계로 합친다.
 *  - 조정 하나(O)·없음(N)은 편집 세션이 마지막 명령만 남긴다(src/edit/session.ts undoControl).
 */
import type { EditSession, Transaction } from '../edit/session';
import type { App, CommandContext } from './app';

interface UndoState {
  /** 표식 자리(그때의 맨 위 항목, 목록이 비었으면 null) */
  marks: (Transaction | null)[];
  /** 시작(BE)한 그룹: 그때의 맨 위 항목과 깊이 */
  group: { top: Transaction | null; depth: number } | null;
  auto: boolean;
  combineZoom: boolean;
  combineLayer: boolean;
}

const states = new WeakMap<EditSession, UndoState>();

function stateOf(s: EditSession): UndoState {
  let x = states.get(s);
  if (!x) {
    x = { marks: [], group: null, auto: true, combineZoom: true, combineLayer: true };
    states.set(s, x);
  }
  return x;
}

/** 기억한 자리(그 항목 바로 위)의 깊이. 항목이 사라졌으면 fallback 이하로 */
function depthAfter(s: EditSession, top: Transaction | null, fallback: number): number {
  if (!top) return 0;
  const i = s.undoIndex(top);
  return i >= 0 ? i + 1 : Math.min(fallback, s.depth);
}

const CONTROL_LABEL = { all: '전체', one: '하나', none: '없음' } as const;

/** 그룹을 닫는다: 시작 뒤에 쌓인 항목을 하나로 합친다 */
function endGroup(s: EditSession, st: UndoState): number {
  const g = st.group;
  st.group = null;
  if (!g) return 0;
  const from = depthAfter(s, g.top, g.depth);
  const n = s.depth - from;
  if (n >= 2) s.squashUndo(from, '그룹');
  return n;
}

/** n번 명령 취소(그룹이 열려 있어도 하나씩). 취소한 항목의 이름 */
function undoTimes(s: EditSession, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const tx = s.undo();
    if (!tx) break;
    out.push(tx.label);
  }
  return out;
}

export function registerUndoCommand(app: App): void {
  app.register({
    name: 'UNDO',
    title: '명령 취소(옵션)',
    async run(ctx: CommandContext, arg?: string) {
      const s = app.active!.session;
      const st = stateOf(s);
      ctx.print(`현재 설정: 자동 = ${st.auto ? '켜기' : '끄기'}, 조정 = ${CONTROL_LABEL[s.undoControl]}, 결합 = ${st.combineZoom ? '예' : '아니오'}, 도면층 = ${st.combineLayer ? '예' : '아니오'}`);
      let answer: string | null = arg?.trim() ? arg.trim() : null;
      for (;;) {
        let key: string | null = null;
        let count = 1;
        if (answer !== null) {
          const up = answer.toUpperCase();
          if (/^\d+$/.test(up)) count = parseInt(up, 10);
          else key = up;
          answer = null;
        } else {
          const r = await ctx.getPoint('명령 취소할 작업의 수 또는 [자동(A)/조정(C)/시작(BE)/끝(E)/표식(M)/뒤(B)] 입력 <1>:', {
            preferNumber: true,
            keywords: [
              { key: 'A', label: '자동' },
              { key: 'C', label: '조정' },
              { key: 'BE', label: '시작' },
              { key: 'E', label: '끝' },
              { key: 'M', label: '표식' },
              { key: 'B', label: '뒤' },
            ],
          });
          if ('keyword' in r) key = r.keyword;
          else if ('text' in r) {
            const v = Number(r.text);
            if (!Number.isInteger(v) || v < 1) {
              ctx.print('1 이상의 정수를 입력하십시오.', 'err');
              continue;
            }
            count = v;
          } else if (!('enter' in r)) continue;
        }
        if (!key) {
          if (s.undoControl === 'none') {
            ctx.print('명령 취소가 해제되어 있습니다. UNDO의 조정(C) 옵션으로 켜십시오.', 'err');
            return;
          }
          // 열린 그룹이 있으면 먼저 닫아 그룹 전체를 한 단계로 되돌린다(AutoCAD와 같다)
          if (st.group) endGroup(s, st);
          const done = undoTimes(s, count);
          ctx.print(done.length ? `명령 취소: ${done.join(', ')}` : '되돌릴 것이 없습니다.');
          if (done.length && s.depth === 0) ctx.print('모든 것이 명령 취소되었습니다.');
          return;
        }
        switch (key) {
          case 'A': {
            const r = await ctx.getPoint(`UNDO 자동 모드 입력 [켜기(ON)/끄기(OFF)] <${st.auto ? '켜기' : '끄기'}>:`, {
              keywords: [
                { key: 'ON', label: '켜기' },
                { key: 'OFF', label: '끄기' },
              ],
            });
            if ('keyword' in r) st.auto = r.keyword === 'ON';
            return;
          }
          case 'C': {
            const r = await ctx.getPoint(`명령 취소 조정 옵션 입력 [전체(A)/없음(N)/하나(O)/결합(C)/도면층(L)] <${CONTROL_LABEL[s.undoControl]}>:`, {
              keywords: [
                { key: 'A', label: '전체' },
                { key: 'N', label: '없음' },
                { key: 'O', label: '하나' },
                { key: 'C', label: '결합' },
                { key: 'L', label: '도면층' },
              ],
            });
            if (!('keyword' in r)) return;
            const yn = async (prompt: string, def: boolean) => {
              const q = await ctx.getPoint(`${prompt} [예(Y)/아니오(N)] <${def ? '예' : '아니오'}>:`, {
                keywords: [
                  { key: 'Y', label: '예' },
                  { key: 'N', label: '아니오' },
                ],
              });
              return 'keyword' in q ? q.keyword === 'Y' : def;
            };
            if (r.keyword === 'A') s.undoControl = 'all';
            else if (r.keyword === 'N') {
              s.undoControl = 'none';
              st.marks = [];
              st.group = null;
            } else if (r.keyword === 'O') {
              s.undoControl = 'one';
              st.marks = [];
              st.group = null;
            } else if (r.keyword === 'C') st.combineZoom = await yn('확대/축소 및 초점이동 명령을 결합하시겠습니까?', st.combineZoom);
            else if (r.keyword === 'L') st.combineLayer = await yn('도면층 특성 변경사항을 결합하시겠습니까?', st.combineLayer);
            return;
          }
          case 'BE': {
            if (s.undoControl !== 'all') {
              ctx.print('명령 취소 조정이 전체일 때만 쓸 수 있습니다.', 'err');
              return;
            }
            // 열린 그룹이 있으면 그것을 닫고 새로 시작한다
            if (st.group) endGroup(s, st);
            st.group = { top: s.undoTop(), depth: s.depth };
            return;
          }
          case 'E': {
            if (!st.group) {
              ctx.print('시작(BE)한 그룹이 없습니다.');
              return;
            }
            endGroup(s, st);
            return;
          }
          case 'M': {
            if (s.undoControl !== 'all') {
              ctx.print('명령 취소 조정이 전체일 때만 쓸 수 있습니다.', 'err');
              return;
            }
            if (st.group) endGroup(s, st);
            st.marks.push(s.undoTop());
            return;
          }
          case 'B': {
            if (s.undoControl === 'none') {
              ctx.print('명령 취소가 해제되어 있습니다. UNDO의 조정(C) 옵션으로 켜십시오.', 'err');
              return;
            }
            if (st.group) endGroup(s, st);
            // 살아 있는 가장 최근 표식(그 항목이 아직 목록에 있거나 빈 목록 표식)
            while (st.marks.length) {
              const m = st.marks[st.marks.length - 1]!;
              if (m === null || s.undoIndex(m) >= 0) break;
              st.marks.pop();
            }
            if (!st.marks.length) {
              const r = await ctx.getPoint('이것은 모든 것을 명령 취소합니다. 확인? <Y>:', {
                keywords: [
                  { key: 'Y', label: '예' },
                  { key: 'N', label: '아니오' },
                ],
              });
              if ('keyword' in r && r.keyword === 'N') return;
              const done = undoTimes(s, s.depth);
              ctx.print(done.length ? `명령 취소: ${done.join(', ')}` : '되돌릴 것이 없습니다.');
              if (done.length) ctx.print('모든 것이 명령 취소되었습니다.');
              return;
            }
            const mark = st.marks.pop()!;
            const target = mark === null ? 0 : s.undoIndex(mark) + 1;
            const done = undoTimes(s, Math.max(0, s.depth - target));
            if (done.length) ctx.print(`명령 취소: ${done.join(', ')}`);
            ctx.print('표식에 도달했습니다.');
            return;
          }
          default:
            ctx.print('옵션 키워드나 정수를 입력하십시오.', 'err');
            return;
        }
      }
    },
  });
}

/** 시험·다른 모듈용: 열린 UNDO 그룹이 있는지 */
export function undoGroupOpen(s: EditSession): boolean {
  return !!states.get(s)?.group;
}
