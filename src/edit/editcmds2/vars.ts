/**
 * editcmds2의 변수 명령(머리말에 없어 SETVAR가 변수 이름 그대로 명령을 부르는 것)과 값 검사(화면·DOM 없음).
 * - QPMODE: 빠른 특성 표시(0 끔, 1 모든 객체, 2 형상 항목이 있는 객체만, 음수 = 끔·값 기억). 이 브라우저에 저장.
 * - TRANSPARENCYDISPLAY: 객체 투명도 표시(0·1). 이 브라우저에 저장, 화면 표시만 바꾼다.
 * - VIEWRES: 빠른 줌·원 줌 퍼센트(1~20000). 이 뷰어는 화면 배율에 맞춰 곡선을 나누므로 값만 기억한다.
 */

/** SETVAR가 변수 이름으로 부르는 명령 */
export const EDITCMDS2_VARS: ReadonlySet<string> = new Set(['QPMODE', 'TRANSPARENCYDISPLAY', 'VIEWRES']);

/** QPMODE 값 검사 */
export function qpModeProblem(v: number): string | null {
  return Number.isInteger(v) && v >= -2 && v <= 2 ? null : '-2에서 2 사이의 정수가 필요합니다.';
}

/** 원 줌 퍼센트 검사 */
export function viewresProblem(v: number): string | null {
  return Number.isInteger(v) && v >= 1 && v <= 20000 ? null : '1에서 20000 사이의 정수가 필요합니다.';
}

/** 0·1 검사 */
export function onOffProblem(v: number): string | null {
  return v === 0 || v === 1 ? null : '0 또는 1이 필요합니다.';
}
