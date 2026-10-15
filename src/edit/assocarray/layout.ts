/**
 * 연관 배열의 항목 자리(원본 블록 좌표 → 배열 블록 좌표 행렬).
 *  - 직사각형: 점 = 첫 항목 자리 + 열·열 간격·(1,0) + 행·행 간격·(cos 축 각도, sin 축 각도). 항목은 돌지 않는다.
 *  - 원형: 행 r의 반지름 = 반지름 + r·행 간격, 항목 i의 각도 = 시작 각도 + i·항목 사이 각도.
 *    항목 회전이면 원본을 i·항목 사이 각도만큼 돌린다(첫 항목은 원본 그대로).
 *  - 경로: src/edit/arraypath의 자리 계산(등분할·길이 분할, 행은 진행 방향 왼쪽)을 도면 좌표에서 하고, 배열 참조의 역변환으로
 *    배열 블록 좌표에 옮긴다. 원본 블록은 접선이 +X인 모양이라 정렬 각도 = 경로 접선 각도.
 *  - 모든 항목: 행렬 = 자리 ∘ (회전) ∘ 기준점을 원점으로. Z = 행·행 고도 + 레벨·레벨 간격.
 * 순서는 AutoCAD 항목 목록과 같다(항목 번호, 그 안에서 행, 그 안에서 레벨).
 */
import type { Vec2 } from '../../core/model';
import { type Path, type Piece, pathEnd, pathLength, pathStart, pieceAt } from '../geom/curve';
import { type Affine, affApply, affLin, affMul, affRotate, affTranslate } from '../geom/math';
import { type PathArraySpec, maxPathItems, pathArrayItems, reversePath } from '../arraypath';
import { type ArrayItem, type ArrayParams, type CachedPiece, MAX_ITEMS, type PathParams, type PolarParams, itemKey } from './types';

const TAU = Math.PI * 2;

/** 채울 각도가 한 바퀴인지 */
export function isFullCircle(fill: number): boolean {
  return Math.abs(Math.abs(fill) - TAU) < 1e-9;
}

/** 항목 수·채울 각도 → 항목 사이 각도 */
export function polarStep(fill: number, items: number): number {
  const n = Math.max(1, Math.round(items));
  if (isFullCircle(fill)) return fill / n;
  return n > 1 ? fill / (n - 1) : fill;
}

/** 항목 수를 바꾼다(채울 각도 유지) */
export function polarWithItems(p: PolarParams, items: number): PolarParams {
  return { ...p, items, itemAngle: polarStep(p.fillAngle, items) };
}

/** 채울 각도를 바꾼다(항목 수 유지) */
export function polarWithFill(p: PolarParams, fill: number): PolarParams {
  return { ...p, fillAngle: fill, itemAngle: polarStep(fill, p.items) };
}

/** 항목 사이 각도를 바꾼다(항목 수 유지, 채울 각도는 다시 계산 — 한 바퀴가 되면 360°) */
export function polarWithAngle(p: PolarParams, a: number): PolarParams {
  const n = Math.max(1, Math.round(p.items));
  let fill = a * (n - 1);
  if (Math.abs(Math.abs(a * n) - TAU) < 1e-9) fill = Math.sign(a) * TAU;
  return { ...p, itemAngle: a, fillAngle: fill };
}

/** 원본 → 배열 블록 행렬: 점 ∘ 회전 ∘ (−기준점) */
function place(point: Vec2, angle: number, base: Vec2): Affine {
  const t = affTranslate(-base.x, -base.y);
  return affMul(affTranslate(point.x, point.y), angle ? affMul(affRotate(angle), t) : t);
}

/** 항목 수 상한을 넘는지(행·레벨 포함) */
export function itemCount(p: ArrayParams): number {
  const per = p.kind === 'rect' ? p.columns : p.items;
  return Math.max(1, Math.round(per)) * Math.max(1, Math.round(p.rows)) * Math.max(1, Math.round(p.levels));
}

/** 경로 배열의 경로(경로 곡선 방향 반영, 도면 좌표) */
export function orientedPath(p: PathParams, raw: Path | null): Path | null {
  let path = raw;
  if (!path && p.fallback?.length) {
    const pieces: Piece[] = p.fallback.map((c): Piece => {
      if (c.k === 'line') return { k: 'line', a: { ...c.a }, b: { ...c.b } };
      if (c.k === 'arc') return { k: 'arc', c: { ...c.c }, r: c.r, a0: c.a0, sw: c.sw };
      return { k: 'nurbs', n: { degree: c.degree, knots: [...c.knots], ctrl: c.ctrl.map((q) => ({ x: q.x, y: q.y, z: 0 })), ...(c.weights ? { weights: [...c.weights] } : {}) }, u0: c.knots[c.degree]!, u1: c.knots[c.knots.length - 1 - c.degree]! };
    });
    const s0 = pieceAt(pieces[0]!, 0);
    const s1 = pieceAt(pieces[pieces.length - 1]!, 1);
    path = { pieces, closed: pieces.length > 1 && Math.hypot(s1.x - s0.x, s1.y - s0.y) <= 1e-9 * Math.max(1, Math.abs(s0.x), Math.abs(s0.y)), z: 0 };
  }
  if (!path || !path.pieces.length) return null;
  return p.reverse && !path.closed ? reversePath(path) : path;
}

/** 길이 분할에서 경로에 들어가는 최대 항목 수 */
export function pathMaxItems(p: PathParams, path: Path): number {
  return maxPathItems(pathLength(path), path.closed, p.spacing);
}

/** 등분할이면 항목 사이 거리를 경로 길이로 다시 구한다 */
export function pathSpacingOf(p: PathParams, path: Path): number {
  if (p.method !== 'divide') return p.spacing;
  const L = pathLength(path);
  const n = Math.max(1, Math.round(p.items));
  return path.closed ? L / n : n > 1 ? L / (n - 1) : L;
}

/**
 * 모든 항목(지운 항목 포함). 경로 배열은 path(경로 곡선 방향을 반영한 도면 좌표 경로)와 toBlock(도면 → 배열 블록 좌표)이 있어야 한다.
 */
export function arrayItems(p: ArrayParams, path: Path | null = null, toBlock: Affine | null = null): ArrayItem[] {
  if (itemCount(p) > MAX_ITEMS) return [];
  const rows = Math.max(1, Math.round(p.rows));
  const levels = Math.max(1, Math.round(p.levels));
  const out: ArrayItem[] = [];
  const zOf = (r: number, l: number) => r * p.rowElevation + l * p.levelSpacing;
  if (p.kind === 'rect') {
    const cols = Math.max(1, Math.round(p.columns));
    const v = { x: Math.cos(p.axesAngle), y: Math.sin(p.axesAngle) };
    for (let i = 0; i < cols; i++)
      for (let r = 0; r < rows; r++) {
        const pt = { x: p.origin.x + i * p.columnSpacing + r * p.rowSpacing * v.x, y: p.origin.y + r * p.rowSpacing * v.y };
        const m = place(pt, 0, p.base);
        for (let l = 0; l < levels; l++) out.push({ key: itemKey(i, r, l), index: i, row: r, level: l, matrix: m, z: zOf(r, l) });
      }
    return out;
  }
  if (p.kind === 'polar') {
    const n = Math.max(1, Math.round(p.items));
    for (let i = 0; i < n; i++)
      for (let r = 0; r < rows; r++) {
        const a = p.startAngle + i * p.itemAngle;
        const rad = p.radius + r * p.rowSpacing;
        const pt = { x: p.center.x + rad * Math.cos(a), y: p.center.y + rad * Math.sin(a) };
        const m = place(pt, p.rotateItems ? i * p.itemAngle : 0, p.base);
        for (let l = 0; l < levels; l++) out.push({ key: itemKey(i, r, l), index: i, row: r, level: l, matrix: m, z: zOf(r, l) });
      }
    return out;
  }
  if (!path) return [];
  const spec: PathArraySpec = {
    method: p.method,
    count: Math.max(1, Math.round(p.items)),
    spacing: p.spacing,
    rows,
    rowSpacing: p.rowSpacing,
    align: p.align,
    base: p.base,
    tangent: p.tangentRef ?? 0,
  };
  const items = pathArrayItems(path, spec);
  // pathArrayItems는 행 0의 경로 순서, 그다음 행 1 … → 항목 번호, 행 순서로 바꾼다
  items.sort((a, b) => a.index - b.index || a.row - b.row);
  for (const it of items) {
    const m = toBlock ? affMul(toBlock, it.matrix) : it.matrix;
    for (let l = 0; l < levels; l++) out.push({ key: itemKey(it.index, it.row, l), index: it.index, row: it.row, level: l, matrix: m, z: zOf(it.row, l) });
  }
  return out;
}

/** 경로 배열의 첫·끝 점(그립용) */
export function pathEnds(path: Path): { start: Vec2; end: Vec2 } {
  return { start: pathStart(path), end: pathEnd(path) };
}

/** 행렬 → 참조의 삽입점·회전·축척(대칭이면 X 축척이 음수) */
export function decompose(m: Affine): { x: number; y: number; rotation: number; sx: number; sy: number } {
  const sx0 = Math.hypot(m[0], m[1]);
  const det = m[0] * m[3] - m[1] * m[2];
  if (det >= 0) {
    const rot = Math.atan2(m[1], m[0]);
    return { x: m[4], y: m[5], rotation: rot, sx: sx0, sy: sx0 > 0 ? det / sx0 : 1 };
  }
  // 대칭: X를 뒤집은 뒤 돌린 것으로 본다(회전 = 열 벡터 (−a, −b)의 각도)
  const rot = Math.atan2(-m[1], -m[0]);
  return { x: m[4], y: m[5], rotation: rot, sx: -sx0, sy: sx0 > 0 ? -det / sx0 : 1 };
}

/** 같은 행렬인지(공차는 좌표 크기에 맞춘다) */
export function sameMatrix(a: Affine, b: Affine, tol = 1e-6): boolean {
  const s = Math.max(1, Math.abs(a[4]), Math.abs(a[5]), Math.abs(b[4]), Math.abs(b[5]));
  for (let i = 0; i < 4; i++) if (Math.abs(a[i]! - b[i]!) > 1e-6) return false;
  return Math.abs(a[4] - b[4]) <= tol * s && Math.abs(a[5] - b[5]) <= tol * s;
}

/**
 * 경로 곡선을 배열 블록 좌표의 곡선 캐시로(경로 곡선을 지워도 배열을 다시 계산할 수 있게 이 앱 기록에 남긴다).
 * 선·호·NURBS만, 조각 60개·조정점 200개까지. 타원 조각이 있거나 너무 크면 null. 경로 곡선 방향(뒤집기 전) 그대로 넣는다.
 */
export function cachePath(path: Path, toBlock: Affine): CachedPiece[] | null {
  if (path.pieces.length > 60) return null;
  const det = toBlock[0] * toBlock[3] - toBlock[1] * toBlock[2];
  const sc = Math.sqrt(Math.abs(det));
  const out: CachedPiece[] = [];
  let ctrl = 0;
  for (const pc of path.pieces) {
    if (pc.k === 'line') {
      if (pc.inf0 || pc.inf1) return null;
      out.push({ k: 'line', a: affApply(toBlock, pc.a), b: affApply(toBlock, pc.b) });
    } else if (pc.k === 'arc') {
      const d = affLin(toBlock, { x: Math.cos(pc.a0), y: Math.sin(pc.a0) });
      out.push({ k: 'arc', c: affApply(toBlock, pc.c), r: pc.r * sc, a0: Math.atan2(d.y, d.x), sw: det < 0 ? -pc.sw : pc.sw });
    } else if (pc.k === 'nurbs') {
      ctrl += pc.n.ctrl.length;
      if (ctrl > 200 || Math.abs(pc.u0 - pc.n.knots[pc.n.degree]!) > 1e-12 || Math.abs(pc.u1 - pc.n.knots[pc.n.knots.length - 1 - pc.n.degree]!) > 1e-12) return null;
      out.push({ k: 'nurbs', degree: pc.n.degree, knots: [...pc.n.knots], ctrl: pc.n.ctrl.map((q) => affApply(toBlock, q)), ...(pc.n.weights ? { weights: [...pc.n.weights] } : {}) });
    } else return null;
  }
  return out;
}
