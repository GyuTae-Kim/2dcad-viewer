/**
 * BLEND: 두 열린 곡선의 끝 사이를 잇는 스플라인.
 * - 접선(G1): 3차 베지어(조정점 4). 끝점과 끝 접선 방향을 지킨다.
 * - 부드럽게(G2): 5차 베지어(조정점 6). 끝 접선과 끝 곡률까지 맞춘다.
 * 접선 핸들 길이는 현 × (2/3)·tan(θ/4)/sin(θ/2)(θ = 두 끝 접선 사이 각) — 두 끝이 대칭이면 원호와 같아진다.
 * 찍은 점에 가까운 끝끼리 잇는다.
 */
import type { Entity, Vec2 } from '../../core/model';
import { type Path, type Piece, pathEnd, pathStart, pieceD1, pieceTangent } from './curve';
import { cross, dist, dot, rot90 } from './math';
import type { Nurbs } from './nurbs';
import { entityPath } from './path';

export type Continuity = 'tangent' | 'smooth';

export interface CurveEnd {
  /** 끝점 */
  p: Vec2;
  /** 그 끝에서 곡선을 떠나는 방향(단위) */
  dir: Vec2;
  /** 끝으로 다가가며 잰 부호 있는 곡률(dir 진행 기준, 왼쪽으로 휘면 +) */
  k: number;
  /** 경로의 끝(참)인지 시작(거짓)인지 */
  atEnd: boolean;
  z: number;
}

/** 조각의 부호 있는 곡률(조각 진행 방향 기준) */
export function pieceCurvature(p: Piece, t: number): number {
  switch (p.k) {
    case 'line':
      return 0;
    case 'arc':
      return p.r > 0 ? Math.sign(p.sw) / p.r : 0;
    case 'ell': {
      const th = p.t0 + p.dt * t;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const d1 = { x: (-p.u.x * s + p.v.x * c) * p.dt, y: (-p.u.y * s + p.v.y * c) * p.dt };
      const d2 = { x: (-p.u.x * c - p.v.x * s) * p.dt * p.dt, y: (-p.u.y * c - p.v.y * s) * p.dt * p.dt };
      const l = Math.hypot(d1.x, d1.y);
      return l > 1e-300 ? cross(d1, d2) / (l * l * l) : 0;
    }
    case 'nurbs': {
      const h = 1e-5;
      const a = Math.max(0, t - h);
      const b = Math.min(1, t + h);
      const d1 = pieceD1(p, t);
      const da = pieceD1(p, a);
      const db = pieceD1(p, b);
      const d2 = { x: (db.x - da.x) / (b - a), y: (db.y - da.y) / (b - a) };
      const l = Math.hypot(d1.x, d1.y);
      return l > 1e-300 ? cross(d1, d2) / (l * l * l) : 0;
    }
  }
}

/** 열린 경로의 한쪽 끝 정보 */
export function curveEnd(path: Path, atEnd: boolean): CurveEnd {
  if (atEnd) {
    const last = path.pieces[path.pieces.length - 1]!;
    return { p: pathEnd(path), dir: pieceTangent(last, 1), k: pieceCurvature(last, 1), atEnd, z: path.z };
  }
  const first = path.pieces[0]!;
  const t = pieceTangent(first, 0);
  return { p: pathStart(path), dir: { x: -t.x, y: -t.y }, k: -pieceCurvature(first, 0), atEnd, z: path.z };
}

/** BLEND에 쓸 수 있는 객체의 경로(닫혔거나 곡선이 아니면 null) */
export function blendPath(e: Entity): Path | null {
  if (e.type === 'CIRCLE' || e.type === 'XLINE' || e.type === 'RAY') return null;
  const p = entityPath(e);
  if (!p || !p.pieces.length || p.closed) return null;
  return p;
}

/** 경로에서 q에 가까운 끝 */
export function nearestEnd(path: Path, q: Vec2): CurveEnd {
  const s = pathStart(path);
  const e = pathEnd(path);
  return curveEnd(path, dist(e, q) < dist(s, q));
}

/** 접선 핸들 길이(3차 베지어) */
export function handleLength(chord: number, t0: Vec2, t1: Vec2): number {
  const c = Math.max(-1, Math.min(1, dot(t0, t1)));
  const th = Math.acos(c);
  if (th < 1e-6) return chord / 3;
  return chord * (2 / 3) * (Math.tan(th / 4) / Math.sin(th / 2));
}

/**
 * 두 끝 사이의 혼합 곡선. a = 첫 곡선의 끝(곡선을 떠나는 쪽), b = 두 번째 곡선의 끝.
 * 결과 곡선은 a.p에서 a.dir 방향으로 떠나 b.p에 −b.dir 방향으로 들어간다.
 */
export function blendNurbs(a: CurveEnd, b: CurveEnd, continuity: Continuity): Nurbs | null {
  const chord = dist(a.p, b.p);
  if (!(chord > 1e-12 * Math.max(1, Math.abs(a.p.x), Math.abs(a.p.y)))) return null;
  const T0 = a.dir;
  const D1 = { x: -b.dir.x, y: -b.dir.y };
  const h3 = handleLength(chord, T0, D1);
  const z = a.z;
  const P = (p: Vec2) => ({ x: p.x, y: p.y, z });
  if (continuity === 'tangent') {
    const ctrl = [P(a.p), P({ x: a.p.x + T0.x * h3, y: a.p.y + T0.y * h3 }), P({ x: b.p.x - D1.x * h3, y: b.p.y - D1.y * h3 }), P(b.p)];
    return { degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], ctrl };
  }
  // 5차: 같은 속력(3·h3 = 5·h5)으로 떠나고, 두 번째 조정점의 법선 성분으로 곡률을 맞춘다
  const h = (3 / 5) * h3;
  const N0 = rot90(T0);
  const N1 = rot90(D1);
  const k0 = a.k;
  // 두 번째 곡선 안으로 들어가는 방향(D1) 기준 곡률 = 끝으로 다가가는 곡률의 반대 부호
  const k1 = -b.k;
  const h0 = 1.25 * k0 * h * h;
  const h1 = 1.25 * k1 * h * h;
  const ctrl = [
    P(a.p),
    P({ x: a.p.x + T0.x * h, y: a.p.y + T0.y * h }),
    P({ x: a.p.x + T0.x * 2 * h + N0.x * h0, y: a.p.y + T0.y * 2 * h + N0.y * h0 }),
    P({ x: b.p.x - D1.x * 2 * h + N1.x * h1, y: b.p.y - D1.y * 2 * h + N1.y * h1 }),
    P({ x: b.p.x - D1.x * h, y: b.p.y - D1.y * h }),
    P(b.p),
  ];
  return { degree: 5, knots: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], ctrl };
}

/** 두 객체와 찍은 점으로 혼합 곡선(실패하면 안내 문구) */
export function blendEntities(e1: Entity, pick1: Vec2, e2: Entity, pick2: Vec2, continuity: Continuity): Nurbs | string {
  const p1 = blendPath(e1);
  const p2 = blendPath(e2);
  if (!p1 || !p2) return '열린 곡선(선, 호, 타원형 호, 열린 폴리선, 열린 스플라인)만 선택할 수 있습니다.';
  const a = nearestEnd(p1, pick1);
  const b = nearestEnd(p2, pick2);
  if (e1 === e2 && a.atEnd === b.atEnd) return '같은 끝점을 두 번 선택했습니다.';
  const n = blendNurbs(a, b, continuity);
  return n ?? '두 끝점이 같습니다.';
}
