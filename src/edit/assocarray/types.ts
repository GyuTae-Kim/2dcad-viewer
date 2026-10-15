/**
 * 연관 배열(ARRAYRECT·ARRAYPOLAR·ARRAYPATH 연관 = 예, ARRAYEDIT)의 자료형.
 *
 * 구조는 AutoCAD 연관 배열과 같다(공개 DXF 표본으로 확인 — src/edit/assocarray/acad.ts 머리말):
 *  - 배열 = 익명 블록(배열 블록, *U…)의 참조(INSERT) 하나. 배열 블록에는 항목마다 원본 블록(*U…)의 참조가 있다.
 *  - 원본 블록 = 원본 객체를 기준점이 원점에 오게 옮긴 것(경로 배열에서 항목 정렬이면 접선이 +X가 되게 돌린 것).
 *  - 항목 행렬 = 원본 블록 좌표 → 배열 블록 좌표. 배열 참조의 변환이 배열 블록 좌표 → 도면 좌표.
 *  - 항목 열쇠 = "항목 번호,행,레벨"(AutoCAD AcDbAssocArrayItem의 i·j·k). 직사각형의 항목 번호는 열 번호다.
 */
import type { Vec2 } from '../../core/model';
import type { Affine } from '../geom/math';

export type ArrayKind = 'rect' | 'polar' | 'path';
export type PathMethod = 'divide' | 'measure';

/** AutoCAD MaxArray 기본값(배열 항목 수 상한) */
export const MAX_ITEMS = 100000;
/** 지운 항목·대체 항목 기록 상한(이 앱 기록의 확장 자료 크기) */
export const MAX_REMOVED = 1500;
export const MAX_REPLACED = 400;

export interface CommonParams {
  /** 원본 블록 좌표의 기준점(항목 자리에 놓이는 점). 보통 원점 */
  base: Vec2;
  rows: number;
  rowSpacing: number;
  /** 행마다 더하는 Z 높이 */
  rowElevation: number;
  levels: number;
  levelSpacing: number;
}

export interface RectParams extends CommonParams {
  kind: 'rect';
  /** 배열 블록 좌표에서 첫 항목(0,0)의 자리 */
  origin: Vec2;
  columns: number;
  columnSpacing: number;
  /** 열 축(+X)과 행 축 사이 각도(라디안, 기본 90°) */
  axesAngle: number;
}

export interface PolarParams extends CommonParams {
  kind: 'polar';
  /** 배열 블록 좌표의 중심 */
  center: Vec2;
  items: number;
  /** 항목 사이 각도(음수 = 시계 방향) */
  itemAngle: number;
  /** 채울 각도(음수 = 시계 방향) */
  fillAngle: number;
  /** 첫 항목 기준점의 중심 기준 각도·거리(배열 블록 좌표) */
  startAngle: number;
  radius: number;
  rotateItems: boolean;
}

export interface PathParams extends CommonParams {
  kind: 'path';
  method: PathMethod;
  items: number;
  /** 길이 분할의 항목 사이 거리(등분할이면 계산된 값) */
  spacing: number;
  align: boolean;
  /** Z 방향 유지(평면 경로에서는 결과가 같다) */
  zDir: boolean;
  /** 경로 곡선의 끝에서 시작(AutoCAD PathDirection 0) */
  reverse: boolean;
  /** 경로 곡선 핸들(연관이 끊겼으면 null) */
  path: string | null;
  /** 원본의 접선 기준 방향(라디안, 정렬 각도 = 경로 접선 − 이것). AutoCAD 기록 배열은 0(원본 블록이 +X 방향) */
  tangentRef?: number;
  /** 경로 곡선이 없을 때 쓰는 경로(AutoCAD가 남긴 곡선 캐시 — 선분·호, 도면 좌표, 경로 곡선 방향) */
  fallback?: CachedPiece[];
}

/** 곡선 캐시 조각(src/edit/geom/curve의 선·호·NURBS 조각으로 바꾼다) */
export type CachedPiece =
  | { k: 'line'; a: Vec2; b: Vec2 }
  | { k: 'arc'; c: Vec2; r: number; a0: number; sw: number }
  | { k: 'nurbs'; degree: number; knots: number[]; ctrl: Vec2[]; weights?: number[] };

export type ArrayParams = RectParams | PolarParams | PathParams;

export interface ArrayItem {
  key: string;
  /** 항목 번호(직사각형은 열) */
  index: number;
  row: number;
  level: number;
  /** 원본 블록 좌표 → 배열 블록 좌표 */
  matrix: Affine;
  /** 배열 블록 좌표의 Z(행 고도 + 레벨) */
  z: number;
}

/** 배열 하나의 상태(읽은 것·고칠 것) */
export interface ArrayState {
  params: ArrayParams;
  /** 원본 블록 이름 */
  source: string;
  /** 지운 항목 열쇠 */
  removed: Set<string>;
  /** 대체한 항목 열쇠 → 대체 블록 이름 */
  replaced: Map<string, string>;
}

export const itemKey = (i: number, row: number, level: number): string => `${i},${row},${level}`;

export function parseKey(k: string): { index: number; row: number; level: number } | null {
  const m = /^(\d+),(\d+),(\d+)$/.exec(k);
  return m ? { index: Number(m[1]), row: Number(m[2]), level: Number(m[3]) } : null;
}

export const KIND_LABEL: Record<ArrayKind, string> = { rect: '직사각형', polar: '원형', path: '경로' };

export function cloneParams<T extends ArrayParams>(p: T): T {
  return structuredClone(p);
}

export function cloneState(s: ArrayState): ArrayState {
  return { params: cloneParams(s.params), source: s.source, removed: new Set(s.removed), replaced: new Map(s.replaced) };
}
