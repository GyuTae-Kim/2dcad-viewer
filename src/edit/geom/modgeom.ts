/**
 * 수정 명령의 형상 계산(DOM 없음): LENGTHEN 동적(DY)의 새 길이, TRIM·EXTEND 투영(뷰 = 평면도),
 * REVCLOUD 수정(M)의 호 구간 만들기.
 * 좌표는 WCS 평면도다.
 */
import type { Entity, Vec2 } from '../../core/model';
import { type Piece, pathNearest, pathSub, pieceAt, pieceLength, pieceNearest, pieceTangent, pathLength, reversePiece } from './curve';
import { intersectPieces } from './intersect';
import { ccwFrom, dist } from './math';
import { entityPath, makePolyline } from './path';

// ---------------------------------------------------------------------------
// REVCLOUD 수정(M)
// ---------------------------------------------------------------------------

/**
 * 구름형 리비전 수정: 경로 위치 s0(시작)·s1(끝) 사이를 새 구간(newPieces, s0 쪽에서 s1 쪽으로)으로 바꾼다.
 * 닫힌 구름은 두 쪽 가운데 erasePick에 가까운 쪽을 지우고, 열린 구름은 두 점 사이를 바꾼다. 같은 종류의 폴리선(핸들은 호출한 쪽이 붙인다).
 */
export function revcloudModify(cloud: Entity, s0: number, s1: number, newPieces: readonly Piece[], erasePick: Vec2 | null): Entity | null {
  const path = entityPath(cloud);
  if (!path || !path.pieces.length || !newPieces.length || Math.abs(s0 - s1) < 1e-9) return null;
  const rev = (list: readonly Piece[]) => [...list].reverse().map((p) => reversePiece(p));
  const n = path.pieces.length;
  let pieces: Piece[];
  if (path.closed) {
    const a = pathSub(path, s0, s1);
    const b = pathSub(path, s1, s0);
    const near = (list: Piece[]) => (erasePick ? Math.min(...list.map((p) => pieceNearest(p, erasePick).d), Infinity) : Infinity);
    // 지울 쪽: 고른 점에 가까운 쪽(고르지 않았으면 짧은 쪽)
    const eraseA = erasePick ? near(a) <= near(b) : a.reduce((s, p) => s + pieceLength(p), 0) <= b.reduce((s, p) => s + pieceLength(p), 0);
    pieces = eraseA ? [...newPieces, ...b] : [...a, ...rev(newPieces)];
  } else {
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    const mid = s0 <= s1 ? [...newPieces] : rev(newPieces);
    pieces = [...pathSub(path, 0, lo), ...mid, ...pathSub(path, hi, n)];
  }
  return makePolyline(cloud, pieces, path.closed, path.z);
}

// ---------------------------------------------------------------------------
// TRIM·EXTEND 걸치기(C)·울타리(F): 객체마다 고른 점
// ---------------------------------------------------------------------------

/** 걸치기 창(직사각형)을 지나는 객체면 창 안(또는 창 모서리 위)의 점 하나, 아니면 null */
export function crossingPick(e: Entity, rect: [number, number, number, number]): Vec2 | null {
  const path = entityPath(e);
  if (!path || !path.pieces.length) return null;
  const [x0, y0, x1, y1] = rect;
  const inside = (p: Vec2) => p.x >= x0 - 1e-12 && p.x <= x1 + 1e-12 && p.y >= y0 - 1e-12 && p.y <= y1 + 1e-12;
  const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const near = pathNearest(path, c);
  if (inside(near.p)) return near.p;
  const edges: Piece[] = [
    { k: 'line', a: { x: x0, y: y0 }, b: { x: x1, y: y0 } },
    { k: 'line', a: { x: x1, y: y0 }, b: { x: x1, y: y1 } },
    { k: 'line', a: { x: x1, y: y1 }, b: { x: x0, y: y1 } },
    { k: 'line', a: { x: x0, y: y1 }, b: { x: x0, y: y0 } },
  ];
  for (const pc of path.pieces)
    for (const ed of edges) {
      const h = intersectPieces(pc, ed);
      if (h.length) return h[0]!.p;
    }
  return null;
}

/** 울타리(꺾은선)와 객체가 만나는 점들(울타리 순서) */
export function fencePicks(e: Entity, fence: readonly Vec2[]): Vec2[] {
  const path = entityPath(e);
  if (!path || !path.pieces.length) return [];
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < fence.length; i++) {
    const seg: Piece = { k: 'line', a: fence[i]!, b: fence[i + 1]! };
    const hits: { u: number; p: Vec2 }[] = [];
    for (const pc of path.pieces) for (const h of intersectPieces(pc, seg)) hits.push({ u: h.u, p: h.p });
    hits.sort((a, b) => a.u - b.u);
    for (const h of hits) out.push(h.p);
  }
  return out;
}

/**
 * LENGTHEN 동적(DY): 고른 끝(pickEnd에 가까운 끝)을 점 to로 끌었을 때의 새 전체 길이.
 * 끝 구간을 연장한 곡선(선 → 무한선, 호 → 원)에 to를 투영한 자리까지. 닫힌 곡선·줄어 없어지면 null.
 */
export function lengthenToPoint(e: Entity, pickEnd: Vec2, to: Vec2): number | null {
  const path = entityPath(e);
  if (!path || path.closed || !path.pieces.length) return null;
  const pcs = path.pieces;
  const L = pathLength(path);
  const s0 = pieceAt(pcs[0]!, 0);
  const s1 = pieceAt(pcs[pcs.length - 1]!, 1);
  const atEnd = dist(pickEnd, s1) <= dist(pickEnd, s0);
  // t = 1 쪽이 움직이는 끝이 되게
  const piece = atEnd ? pcs[pcs.length - 1]! : reversePiece(pcs[0]!);
  const pl = pieceLength(piece);
  let next: number;
  if (piece.k === 'line') {
    if ((piece.inf0 ?? false) || (piece.inf1 ?? false)) return null;
    const l = dist(piece.a, piece.b);
    if (!(l > 0)) return null;
    next = ((to.x - piece.a.x) * (piece.b.x - piece.a.x) + (to.y - piece.a.y) * (piece.b.y - piece.a.y)) / l;
  } else if (piece.k === 'arc') {
    const phi = Math.atan2(to.y - piece.c.y, to.x - piece.c.x);
    const sw = piece.sw > 0 ? ccwFrom(piece.a0, phi) : ccwFrom(phi, piece.a0);
    next = sw * piece.r;
  } else {
    const end = pieceAt(piece, 1);
    const t = pieceTangent(piece, 1);
    next = pl + (to.x - end.x) * t.x + (to.y - end.y) * t.y;
  }
  const Lnew = L - pl + next;
  return Lnew > 1e-10 * Math.max(1, L) ? Lnew : null;
}
