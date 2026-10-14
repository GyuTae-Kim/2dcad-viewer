/**
 * 경로 배열(ARRAYPATH, 연관 = 아니오)의 항목 자리.
 * - 방법: 등분할(경로 전체에 항목 수만큼 고르게, 닫힌 경로는 끝이 시작과 겹치지 않게) / 길이 분할(항목 사이 거리마다).
 * - 항목 변환 = 기준점을 경로 위 점으로 옮긴다. 항목 정렬이면 그 점의 접선이 기준 방향(접선 방향 옵션, 없으면 경로 시작
 *   접선)과 같아지도록 그 점을 중심으로 돌린다.
 * - 행: 경로 진행 방향의 왼쪽 법선으로 행 간격만큼 띄운 줄(행마다 같은 경로 위치).
 * 경로는 평면도(WCS XY) 경로(src/edit/geom/curve)다. 길이 계산은 그 모듈의 조각 길이를 쓴다.
 */
import type { Vec2 } from '../core/model';
import { type Path, pathAt, pathEnd, pathLength, pathSAtLength, pathStart, pathTangent, reversePiece } from './geom/curve';
import type { Affine } from './geom/math';

export type PathMethod = 'divide' | 'measure';

/** AutoCAD MaxArray 기본값(배열 항목 수 상한) */
export const MAX_ARRAY_ITEMS = 100000;

export interface PathArraySpec {
  method: PathMethod;
  /** 경로를 따라 놓는 항목 수 */
  count: number;
  /** 길이 분할의 항목 사이 거리 */
  spacing: number;
  /** 행 수(1 = 경로 위 한 줄) */
  rows: number;
  /** 행 사이 거리(양수 = 경로 진행 방향의 왼쪽) */
  rowSpacing: number;
  /** 항목을 경로 접선에 맞춰 돌린다 */
  align: boolean;
  /** 원본에서 경로 위 점에 놓일 점(기준점) */
  base: Vec2;
  /** 원본의 접선 기준 방향(라디안). 없으면 경로 시작 접선(일반) */
  tangent?: number;
}

export interface PathArrayItem {
  /** 경로를 따라 몇 번째(0부터) */
  index: number;
  /** 몇 번째 행(0 = 경로 위) */
  row: number;
  /** 기준점이 놓이는 점 */
  point: Vec2;
  /** 항목 회전(라디안, 정렬하지 않으면 0) */
  angle: number;
  /** 원본 → 항목 변환(x' = a·x + c·y + e, y' = b·x + d·y + f) */
  matrix: Affine;
}

const EPS = 1e-9;

/** 경로 시작에서의 거리들(항목마다) */
export function pathStations(length: number, closed: boolean, method: PathMethod, count: number, spacing: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (!(length > 0)) return [0];
  const out: number[] = [];
  if (method === 'divide') {
    if (n === 1) return [0];
    const step = closed ? length / n : length / (n - 1);
    for (let i = 0; i < n; i++) out.push(Math.min(length, step * i));
    return out;
  }
  const m = Math.min(n, maxPathItems(length, closed, spacing));
  for (let i = 0; i < m; i++) out.push(Math.min(length, spacing * i));
  return out;
}

/** 길이 분할에서 경로에 들어가는 최대 항목 수(닫힌 경로는 시작점과 겹치는 마지막 항목을 뺀다) */
export function maxPathItems(length: number, closed: boolean, spacing: number): number {
  if (!(spacing > 0) || !(length > 0)) return 1;
  const tol = EPS * Math.max(1, length);
  const n = closed ? Math.floor((length - tol) / spacing) + 1 : Math.floor((length + tol) / spacing) + 1;
  return Math.max(1, Math.min(MAX_ARRAY_ITEMS, n));
}

/** 경로 곡선을 고른 점에 가까운 끝에서 시작하게 한다(열린 경로만 뒤집는다) */
export function orientPath(path: Path, pick: Vec2): Path {
  if (path.closed || !path.pieces.length) return path;
  const s = pathStart(path);
  const e = pathEnd(path);
  if (Math.hypot(pick.x - e.x, pick.y - e.y) < Math.hypot(pick.x - s.x, pick.y - s.y) - EPS) return reversePath(path);
  return path;
}

export function reversePath(path: Path): Path {
  return { ...path, pieces: path.pieces.map((p) => reversePiece(p)).reverse() };
}

/** 원본을 기준점 → 점 p로 옮기고 p를 중심으로 angle만큼 돌리는 변환 */
export function placeMatrix(base: Vec2, p: Vec2, angle: number): Affine {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, -s, c, p.x - (c * base.x - s * base.y), p.y - (s * base.x + c * base.y)];
}

export function isIdentity(m: Affine, tol = 1e-12): boolean {
  return Math.abs(m[0] - 1) <= tol && Math.abs(m[1]) <= tol && Math.abs(m[2]) <= tol && Math.abs(m[3] - 1) <= tol && Math.abs(m[4]) <= tol && Math.abs(m[5]) <= tol;
}

/** 경로 시작 접선의 각도 */
export function startTangentAngle(path: Path): number {
  const t = pathTangent(path, 0);
  return Math.atan2(t.y, t.x);
}

/** 항목 자리와 변환(행 0의 경로 순서, 그다음 행 1 …) */
export function pathArrayItems(path: Path, spec: PathArraySpec): PathArrayItem[] {
  if (!path.pieces.length) return [];
  const L = pathLength(path);
  const stations = pathStations(L, path.closed, spec.method, spec.count, spec.spacing);
  const ref = spec.tangent ?? startTangentAngle(path);
  const rows = Math.max(1, Math.floor(spec.rows));
  const out: PathArrayItem[] = [];
  const at = stations.map((d) => {
    const s = d <= 0 ? 0 : d >= L ? path.pieces.length : pathSAtLength(path, d);
    const p = pathAt(path, s);
    const t = pathTangent(path, s);
    return { p, t, theta: Math.atan2(t.y, t.x) };
  });
  for (let r = 0; r < rows; r++)
    at.forEach((q, i) => {
      const off = r * spec.rowSpacing;
      const point = { x: q.p.x - q.t.y * off, y: q.p.y + q.t.x * off };
      const angle = spec.align ? normalizeAngle(q.theta - ref) : 0;
      out.push({ index: i, row: r, point, angle, matrix: placeMatrix(spec.base, point, angle) });
    });
  return out;
}

/** (−π, π] */
export function normalizeAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/** 길이 분할의 처음 항목 사이 거리: 원본 범위의 1.5배(경로 길이보다 길면 경로 길이를 나눈 값) */
export function defaultPathSpacing(width: number, height: number, length: number): number {
  const s = 1.5 * Math.max(width, height);
  if (s > 0 && (!(length > 0) || s <= length)) return s;
  return length > 0 ? length / 4 : 1;
}
