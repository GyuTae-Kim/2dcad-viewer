/**
 * 이 영역의 시스템 변수 이름(SETVAR가 그 변수 명령으로 넘긴다 — 값 검사와 저장은 변수 명령이 한다).
 * FILLMODE·QTEXTMODE·DRAGMODE는 도면 머리말, SNAPSTYL·SNAPISOPAIR는 도면별 등각투영 설정.
 * XCOMPAREBAKPATH·XCOMPAREBAKSIZE는 이 웹 버전에 없다(명령이 안내한다).
 */
export const VIEWTOOL_VARS: ReadonlySet<string> = new Set(['FILLMODE', 'QTEXTMODE', 'DRAGMODE', 'SNAPSTYL', 'SNAPISOPAIR', 'XCOMPAREBAKPATH', 'XCOMPAREBAKSIZE']);

/** 머리말 변수 이름 → 허용 값(정수) */
export const HEADER_VAR_RANGE: Readonly<Record<string, readonly number[]>> = {
  FILLMODE: [0, 1],
  QTEXTMODE: [0, 1],
  DRAGMODE: [0, 1, 2],
};

/** 머리말 변수의 초기값(도면에 없을 때) */
export const HEADER_VAR_DEFAULT: Readonly<Record<string, number>> = { FILLMODE: 1, QTEXTMODE: 0, DRAGMODE: 2 };
