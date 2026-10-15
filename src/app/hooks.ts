/**
 * App의 확장 지점: 기능 모듈은 App의 (비공개) 메서드나 편집 세션을 실행 중에 감싸지 않고, 아래 고리를 App의 목록에 단다.
 * 목록은 등록 순서대로 부른다(main.ts의 등록 순서). 같은 이름의 고리는 한 번만 단다(addHook).
 *
 *  - App.pointFilters       점 요청의 점 해석(객체 스냅이 잡히지 않았을 때 추적·격자 스냅·직교 대신) — 등각투영 제도
 *  - App.inputFilters       명령행 입력을 요청보다 먼저 본다 — 점 프롬프트의 DRAG
 *  - App.dragPreviewMode    끌기 미리보기 모드(DRAGMODE)와 App.dragPreviewNow() — DRAGMODE·DRAG
 *  - App.entityClickHandlers 명령 없이 Ctrl+클릭한 객체(하이퍼링크 linkClick보다 먼저) — 연관 배열 항목 고르기
 *  - App.commitHooks        편집 확정 직전(before)·직후(after) — 주석 축척(before), 도면층 이전·연관 배열 경로 따라가기(after)
 *
 * 이 모듈은 형식과 작은 도우미만 두고 app.ts를 값으로 가져오지 않는다(기능 모듈과 app.ts 사이의 순환을 만들지 않는다).
 */
import type { Transaction } from '../edit/session';
import type { DocState } from './docstate';
import type { Acquired, TrackResult } from './tracking';
import type { Pt, SnapKind } from './view';

/** 명령이 기다리는 입력(밖에서 보는 모양) */
export interface PendingInput {
  readonly kind: 'point' | 'entity' | 'select';
  readonly prompt: string;
  readonly remove?: boolean;
}

/** 스냅·추적·직교를 적용한 점 */
export interface ResolvedPoint {
  p: Pt;
  snap: { p: Pt; kind: SnapKind; handle?: string; handle2?: string } | null;
  track?: TrackResult;
}

/** 점 해석 고리(App.pointFilters) */
export interface PointFilter {
  readonly name: string;
  /**
   * 점 요청에서 객체 스냅이 잡히지 않은 커서 점 w를 해석한다(추적·격자 스냅·직교를 대신 — 등각투영 제도).
   * 맡지 않으면 null(다음 고리, 없으면 앱의 기본 처리)
   */
  resolve(w: Pt, req: { readonly base: Pt | null; readonly acquired: readonly Acquired[] }): ResolvedPoint | null;
}

/** 명령행 입력 고리(App.inputFilters) */
export interface InputFilter {
  readonly name: string;
  /** 명령행 입력을 기다리는 요청(없으면 null)보다 먼저 본다. 처리했으면 true(요청·명령으로 넘기지 않는다) */
  input(text: string, pending: PendingInput | null): boolean;
}

/** Ctrl+클릭 고리(App.entityClickHandlers) */
export interface EntityClickHandler {
  readonly name: string;
  /** 명령 없이 Ctrl(⌘)+클릭한 객체와 누른 점(도면 좌표). 처리했으면 true(선택·하이퍼링크로 넘기지 않는다) */
  click(handle: string, point: Pt): boolean;
}

/** 편집 확정 고리(App.commitHooks). 문서를 열 때 App이 편집 세션에 잇는다(bindCommitHooks) */
export interface CommitHook {
  readonly name: string;
  /** 확정 직전: 트랜잭션을 고쳐 돌려준다(새 주석 객체에 축척 레코드 붙이기 등). 앞 고리가 고친 것을 받는다 */
  before?(st: DocState, tx: Transaction): Transaction;
  /** 확정 뒤(문서·화면에 적용한 다음): 적용한 트랜잭션을 본다. 여기서 다시 확정해도 된다(그 확정도 모든 고리를 거친다) */
  after?(st: DocState, tx: Transaction): void;
}

/** 같은 이름의 고리가 없을 때만 목록에 더한다(등록 함수를 두 번 불러도 한 번만). 목록에 있는 고리를 돌려준다 */
export function addHook<T extends { readonly name: string }>(list: T[], hook: T): T {
  const had = list.find((h) => h.name === hook.name);
  if (had) return had;
  list.push(hook);
  return hook;
}

/**
 * 편집 세션을 확정 고리 목록에 잇는다(App.addDocument가 편집 세션을 만든 뒤 부른다).
 * 목록은 확정할 때마다 읽으므로 나중에 단 고리도 듣는다. 명령 취소·다시 실행은 확정이 아니라 고리를 부르지 않는다.
 */
export function bindCommitHooks(host: { readonly commitHooks: readonly CommitHook[] }, st: DocState): void {
  const s = st.session;
  s.beforeCommit = (tx) => {
    for (const h of host.commitHooks) if (h.before) tx = h.before(st, tx);
    return tx;
  };
  s.afterCommit = (tx) => {
    for (const h of host.commitHooks) h.after?.(st, tx);
  };
}
