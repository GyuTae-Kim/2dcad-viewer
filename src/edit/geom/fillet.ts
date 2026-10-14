/**
 * FILLET·CHAMFER.
 * - 두 객체: 고른 점(pick)이 어느 모서리(사분면)를 둥글릴지 정한다. 선은 두 선(연장)의 교점에서 고른 점 쪽을 남기고,
 *   호·원·타원·스플라인은 모깎기 원의 접점에서 고른 점 쪽을 남긴다. 원·완전한 타원은 자르지 않는다(AutoCAD와 같다).
 * - 반지름 0: 두 객체를 교점까지 늘이거나 잘라 모서리를 만든다. 평행선은 반지름과 상관없이 반원으로 잇는다.
 * - 폴리선: 끝 세그먼트는 다른 객체와 모깎기할 수 있고, 같은 폴리선의 인접한 두 세그먼트(또는 세그먼트 하나를 사이에 둔
 *   두 직선 세그먼트 — 사이 세그먼트를 바꾼다)는 폴리선 안에 호·선을 넣는다. 폭은 잘린 자리의 테이퍼를 잇는다.
 * - 두 객체 사이에 만든 모깎기 호·모따기 선은 첫 객체의 특성을 잇는 ARC·LINE이다.
 */
import type { Entity, Vec2 } from '../../core/model';
import { type ArcPiece, type LinePiece, type Path, type Piece, pathNearest, pieceAt, pieceLength, pieceNearest, pieceSize, pieceTangent, subPiece } from './curve';
import { intersectPieces } from './intersect';
import { TAU, add, angleOf, cross, dist, dot, len, mid, mul, norm, rot90, solve2, sub } from './math';
import { entityPath, makeArc, makeLine, makePolyline, makeRay, makeSpline, pieceNurbs, rebuildFrom } from './path';
import { keepIdentity, resultFrom } from './trim';
import { type EditResult, MSG, mergeResults } from './types';

export interface FilletOptions {
  /** TRIMMODE = 0이면 거짓: 원본은 그대로 두고 호·선만 더한다 */
  trim?: boolean;
}

const EXTRA_MSG = {
  noFillet: '이 반지름으로는 모깎기할 수 없습니다.',
  sameObject: '같은 객체의 같은 세그먼트는 모깎기·모따기할 수 없습니다.',
  collinear: '선이 같은 직선 위에 있습니다.',
} as const;

type Keep = 'after' | 'before';

/** 고른 객체 하나: 경로, 고른 조각과 그 순번 */
interface Sel {
  e: Entity;
  pick: Vec2;
  path: Path;
  idx: number;
  piece: Piece;
  /** 자르지 않는 닫힌 곡선(원·완전한 타원·닫힌 스플라인) */
  closedCurve: boolean;
}

function select(e: Entity, pick: Vec2): Sel | null {
  const path = entityPath(e);
  if (!path || !path.pieces.length) return null;
  const nr = pathNearest(path, pick);
  const piece = path.pieces[nr.i]!;
  const single = path.pieces.length === 1;
  const closedCurve = single && path.closed;
  return { e, pick, path, idx: nr.i, piece, closedCurve };
}

function isPolyline(e: Entity): boolean {
  return e.type === 'LWPOLYLINE' || (e.type === 'POLYLINE' && e.kind === '2d');
}

/** 다른 객체와 짝지을 수 있는 폴리선 끝 세그먼트인지 */
function endSegmentOk(s: Sel): boolean {
  if (!isPolyline(s.e) && !(s.e.type === 'POLYLINE' && s.e.kind === '3d')) return true;
  if (s.path.closed) return false;
  return s.idx === 0 || s.idx === s.path.pieces.length - 1;
}

// ---------------------------------------------------------------------------
// 매개변수 도우미
// ---------------------------------------------------------------------------

/** 호·타원호의 주기(t 단위) */
function period(p: Piece): number {
  if (p.k === 'arc') return TAU / Math.abs(p.sw || 1);
  if (p.k === 'ell') return TAU / Math.abs(p.dt || 1);
  return Infinity;
}

/** 주기 있는 매개변수를 [0, 1]에 가장 가까운 값으로 */
function normT(p: Piece, t: number): number {
  const T = period(p);
  if (!Number.isFinite(T)) return t;
  let x = t - Math.floor(t / T) * T; // [0, T)
  const gapAfter = x - 1;
  const gapBefore = T - x;
  if (x > 1 && gapBefore < gapAfter) x -= T;
  return x;
}

/** 점의 매개변수(연장 곡선에서) */
function paramOf(p: Piece, q: Vec2): number {
  if (p.k === 'nurbs') return pieceNearest(p, q, true).t;
  return normT(p, pieceNearest(p, q, false).t);
}

/** 남길 부분(t에서 시작해 keep 방향) */
function keptPiece(p: Piece, t: number, keep: Keep): Piece {
  const q = keep === 'after' ? subPiece(p, t, 1) : subPiece(p, 0, t);
  if (q.w0 !== undefined) q.w0 = Math.max(0, q.w0);
  if (q.w1 !== undefined) q.w1 = Math.max(0, q.w1);
  return q;
}

function widthAt(p: Piece, t: number): number | undefined {
  if (p.w0 === undefined && p.w1 === undefined) return undefined;
  const w0 = p.w0 ?? 0;
  const w1 = p.w1 ?? w0;
  return Math.max(0, w0 + (w1 - w0) * t);
}

// ---------------------------------------------------------------------------
// 모깎기 원 후보
// ---------------------------------------------------------------------------

interface Cand {
  c: Vec2;
  t1: number;
  t2: number;
  T1: Vec2;
  T2: Vec2;
}

function offsetsOf(p: Piece, r: number): Piece[] {
  if (p.k === 'line') {
    const n = mul(rot90(norm(sub(p.b, p.a))), r);
    return [
      { k: 'line', a: add(p.a, n), b: add(p.b, n) },
      { k: 'line', a: sub(p.a, n), b: sub(p.b, n) },
    ];
  }
  if (p.k === 'arc') {
    const out: Piece[] = [{ k: 'arc', c: p.c, r: p.r + r, a0: 0, sw: TAU }];
    const ri = Math.abs(p.r - r);
    if (ri > 1e-12 * Math.max(1, p.r)) out.push({ k: 'arc', c: p.c, r: ri, a0: 0, sw: TAU });
    return out;
  }
  return [];
}

/** 원 중심 C에서 r 거리인 운반 곡선 위 접점 */
function footOn(p: Piece, C: Vec2, r: number): Vec2 {
  if (p.k === 'line') {
    const d = sub(p.b, p.a);
    const t = dot(sub(C, p.a), d) / dot(d, d);
    return pieceAt(p, t);
  }
  if (p.k === 'arc') {
    const u = norm(sub(C, p.c));
    const a = add(p.c, mul(u, p.r));
    const b = sub(p.c, mul(u, p.r));
    return Math.abs(dist(a, C) - r) <= Math.abs(dist(b, C) - r) ? a : b;
  }
  return pieceNearest(p, C, false).p;
}

function analyticCands(p1: Piece, p2: Piece, r: number): Cand[] {
  const out: Cand[] = [];
  const scale = Math.max(pieceSize(p1), pieceSize(p2), r);
  for (const o1 of offsetsOf(p1, r))
    for (const o2 of offsetsOf(p2, r))
      for (const h of intersectPieces(o1, o2, true, true)) {
        const C = h.p;
        if (out.some((q) => dist(q.c, C) <= 1e-9 * scale)) continue;
        const T1 = footOn(p1, C, r);
        const T2 = footOn(p2, C, r);
        if (Math.abs(dist(T1, C) - r) > 1e-7 * scale || Math.abs(dist(T2, C) - r) > 1e-7 * scale) continue;
        out.push({ c: C, T1, T2, t1: paramOf(p1, T1), t2: paramOf(p2, T2) });
      }
  return out;
}

function searchRange(p: Piece): [number, number] {
  if (p.k === 'line') return p.inf0 || p.inf1 ? [-3, 4] : [-1, 2];
  if (p.k === 'nurbs') return [0, 1];
  const T = period(p);
  const extra = (T - 1) / 2;
  return [-extra, 1 + extra];
}

/** 타원·스플라인이 낀 경우: 두 곡선에서 r만큼 떨어진 점이 만나는 곳을 뉴턴법으로 */
function numericCands(p1: Piece, p2: Piece, r: number): Cand[] {
  const out: Cand[] = [];
  const scale = Math.max(pieceSize(p1), pieceSize(p2), r);
  const [a1, b1] = searchRange(p1);
  const [a2, b2] = searchRange(p2);
  const clampT = (p: Piece, t: number, a: number, b: number) => (p.k === 'nurbs' ? Math.min(1, Math.max(0, t)) : Math.min(b + 1, Math.max(a - 1, t)));
  const N = 24;
  for (const s1 of [1, -1])
    for (const s2 of [1, -1]) {
      const F = (t1: number, t2: number): Vec2 => {
        const q1 = add(pieceAt(p1, t1), mul(rot90(pieceTangent(p1, t1)), s1 * r));
        const q2 = add(pieceAt(p2, t2), mul(rot90(pieceTangent(p2, t2)), s2 * r));
        return sub(q1, q2);
      };
      const starts: { t1: number; t2: number; f: number }[] = [];
      for (let i = 0; i <= N; i++)
        for (let j = 0; j <= N; j++) {
          const t1 = a1 + ((b1 - a1) * i) / N;
          const t2 = a2 + ((b2 - a2) * j) / N;
          starts.push({ t1, t2, f: len(F(t1, t2)) });
        }
      starts.sort((x, y) => x.f - y.f);
      for (const st of starts.slice(0, 12)) {
        let t1 = st.t1;
        let t2 = st.t2;
        let ok = false;
        for (let it = 0; it < 50; it++) {
          const f = F(t1, t2);
          if (len(f) <= 1e-11 * scale) {
            ok = true;
            break;
          }
          const h1 = 1e-7 * (b1 - a1);
          const h2 = 1e-7 * (b2 - a2);
          const f1 = F(t1 + h1, t2);
          const f2 = F(t1, t2 + h2);
          const s = solve2((f1.x - f.x) / h1, (f2.x - f.x) / h2, (f1.y - f.y) / h1, (f2.y - f.y) / h2, -f.x, -f.y);
          if (!s) break;
          t1 = clampT(p1, t1 + s[0], a1, b1);
          t2 = clampT(p2, t2 + s[1], a2, b2);
        }
        if (!ok && len(F(t1, t2)) > 1e-8 * scale) continue;
        const T1 = pieceAt(p1, t1);
        const C = add(T1, mul(rot90(pieceTangent(p1, t1)), s1 * r));
        if (out.some((q) => dist(q.c, C) <= 1e-7 * scale)) continue;
        out.push({ c: C, T1, T2: pieceAt(p2, t2), t1: p1.k === 'nurbs' ? t1 : normT(p1, t1), t2: p2.k === 'nurbs' ? t2 : normT(p2, t2) });
      }
    }
  return out;
}

function candidates(p1: Piece, p2: Piece, r: number): Cand[] {
  if ((p1.k === 'line' || p1.k === 'arc') && (p2.k === 'line' || p2.k === 'arc')) return analyticCands(p1, p2, r);
  return numericCands(p1, p2, r);
}

/** 후보 원에서 T1 → T2 짧은 호와 남길 방향 */
interface Fillet {
  cand: Cand;
  arc: ArcPiece;
  keep1: Keep;
  keep2: Keep;
}

function filletOf(p1: Piece, p2: Piece, cd: Cand, r: number): Fillet | null {
  const v1 = sub(cd.T1, cd.c);
  const v2 = sub(cd.T2, cd.c);
  const a0 = angleOf(v1);
  let sw = angleOf(v2) - a0;
  while (sw > Math.PI) sw -= TAU;
  while (sw <= -Math.PI) sw += TAU;
  if (Math.abs(sw) < 1e-12) return null;
  const sg = sw > 0 ? 1 : -1;
  const dir1 = mul(rot90(norm(v1)), sg); // 호가 T1을 떠나는 방향
  const dir2 = mul(rot90(norm(v2)), sg); // 호가 T2에 닿는 방향
  const tg1 = pieceTangent(p1, cd.t1);
  const tg2 = pieceTangent(p2, cd.t2);
  // 곡선 1은 T1으로 들어와(dir1 방향) 호로 이어지므로 남는 쪽은 −dir1, 곡선 2는 +dir2
  const keep1: Keep = dot(mul(dir1, -1), tg1) >= 0 ? 'after' : 'before';
  const keep2: Keep = dot(dir2, tg2) >= 0 ? 'after' : 'before';
  return { cand: cd, arc: { k: 'arc', c: cd.c, r, a0, sw }, keep1, keep2 };
}

/** 운반 곡선 교점 중 점 q에 가장 가까운 것의 매개변수(없으면 null) */
function refParams(p1: Piece, p2: Piece): { t: number; u: number; p: Vec2 }[] {
  return intersectPieces(p1, p2, p1.k !== 'nurbs', p2.k !== 'nurbs').map((h) => ({ t: normT(p1, h.t), u: normT(p2, h.u), p: h.p }));
}

function nearestRef(refs: { t: number; u: number; p: Vec2 }[], q: Vec2): { t: number; u: number; p: Vec2 } | null {
  let best: { t: number; u: number; p: Vec2 } | null = null;
  for (const r of refs) if (!best || dist(r.p, q) < dist(best.p, q)) best = r;
  return best;
}

function keepValid(p: Piece, t: number, keep: Keep, closedCurve: boolean): boolean {
  if (closedCurve) return true;
  const eps = 1e-9;
  if (p.k === 'line') {
    if (keep === 'after') return !!p.inf1 || t < 1 - eps;
    return !!p.inf0 || t > eps;
  }
  if (p.k === 'nurbs' && (t < -eps || t > 1 + eps)) return false;
  return keep === 'after' ? t < 1 - eps : t > eps;
}

interface Solved {
  t1: number;
  t2: number;
  keep1: Keep;
  keep2: Keep;
  arc?: ArcPiece;
  /** 반원(평행선)일 때 둘째 선의 접점 */
  T1: Vec2;
  T2: Vec2;
}

/** 두 조각의 모깎기(고른 점으로 고른다) */
function solveFillet(s1: Sel, s2: Sel, r: number): Solved | string {
  const p1 = s1.piece;
  const p2 = s2.piece;
  const pick1 = pieceNearest(p1, s1.pick, true).t;
  const pick2 = pieceNearest(p2, s2.pick, true).t;
  const refs = refParams(p1, p2);
  if (r <= 0) {
    if (!refs.length) return MSG.cannotFillet;
    let best: Solved | null = null;
    let bs = Infinity;
    for (const x of refs) {
      const keep1: Keep = pick1 >= x.t ? 'after' : 'before';
      const keep2: Keep = pick2 >= x.u ? 'after' : 'before';
      if (!keepValid(p1, x.t, keep1, s1.closedCurve) || !keepValid(p2, x.u, keep2, s2.closedCurve)) continue;
      const sc = dist(x.p, s1.pick) + dist(x.p, s2.pick);
      if (sc < bs) {
        bs = sc;
        best = { t1: x.t, t2: x.u, keep1, keep2, T1: x.p, T2: x.p };
      }
    }
    return best ?? MSG.cannotFillet;
  }
  const fl: Fillet[] = [];
  for (const cd of candidates(p1, p2, r)) {
    const f = filletOf(p1, p2, cd, r);
    if (f) fl.push(f);
  }
  if (!fl.length) return EXTRA_MSG.noFillet;
  const tol = 1e-9;
  const consistent = (f: Fillet): boolean => {
    const ref = nearestRef(refs, mid(f.cand.T1, f.cand.T2));
    const rho1 = ref ? ref.t : f.cand.t1;
    const rho2 = ref ? ref.u : f.cand.t2;
    const ok1 = s1.closedCurve || (f.keep1 === 'after' ? pick1 >= rho1 - tol : pick1 <= rho1 + tol);
    const ok2 = s2.closedCurve || (f.keep2 === 'after' ? pick2 >= rho2 - tol : pick2 <= rho2 + tol);
    return ok1 && ok2;
  };
  const valid = (f: Fillet) => keepValid(p1, f.cand.t1, f.keep1, s1.closedCurve) && keepValid(p2, f.cand.t2, f.keep2, s2.closedCurve);
  const score = (f: Fillet) => dist(f.cand.T1, s1.pick) + dist(f.cand.T2, s2.pick);
  const cons = fl.filter(consistent);
  const pool = cons.length ? cons : fl;
  const good = pool.filter(valid).sort((a, b) => score(a) - score(b));
  if (!good.length) return MSG.radiusTooLarge;
  const f = good[0]!;
  return { t1: f.cand.t1, t2: f.cand.t2, keep1: f.keep1, keep2: f.keep2, arc: f.arc, T1: f.cand.T1, T2: f.cand.T2 };
}

// ---------------------------------------------------------------------------
// 평행선: 반원
// ---------------------------------------------------------------------------

function parallelLines(p1: Piece, p2: Piece): boolean {
  if (p1.k !== 'line' || p2.k !== 'line') return false;
  const d1 = norm(sub(p1.b, p1.a));
  const d2 = norm(sub(p2.b, p2.a));
  return Math.abs(cross(d1, d2)) < 1e-10;
}

function solveParallel(s1: Sel, s2: Sel): Solved | string {
  const p1 = s1.piece as LinePiece;
  const p2 = s2.piece as LinePiece;
  if (p1.inf0 && p1.inf1) return MSG.parallel; // 첫 객체는 선·광선이어야 한다
  const d = norm(sub(p1.b, p1.a));
  const gap = Math.abs(cross(d, sub(p2.a, p1.a)));
  if (gap <= 1e-10 * Math.max(1, pieceSize(p1))) return EXTRA_MSG.collinear;
  // 첫 선의 끝(고른 점에 가까운 끝, 광선은 시작점)
  let t1: number;
  if (p1.inf1) t1 = 0;
  else if (p1.inf0) t1 = 1;
  else t1 = pieceNearest(p1, s1.pick, true).t < 0.5 ? 0 : 1;
  const E1 = pieceAt(p1, t1);
  const out = t1 === 0 ? mul(d, -1) : d; // 반원이 나가는 쪽
  const keep1: Keep = t1 === 0 ? 'after' : 'before';
  const d2v = sub(p2.b, p2.a);
  const t2 = dot(sub(E1, p2.a), d2v) / dot(d2v, d2v);
  const T2 = pieceAt(p2, t2);
  const keep2: Keep = dot(d2v, out) > 0 ? 'before' : 'after';
  if (!keepValid(p2, t2, keep2, false)) return MSG.radiusTooLarge;
  const c = mid(E1, T2);
  const a0 = angleOf(sub(E1, c));
  // E1 → T2, 바깥(out) 쪽으로 도는 반원
  const sg = cross(sub(E1, c), out) > 0 ? 1 : -1;
  return { t1, t2, keep1, keep2, arc: { k: 'arc', c, r: gap / 2, a0, sw: sg * Math.PI }, T1: E1, T2 };
}

// ---------------------------------------------------------------------------
// 결과 객체
// ---------------------------------------------------------------------------

/** 고른 조각을 t에서 잘라(늘여) keep 쪽을 남긴 객체. 닫힌 곡선은 null(그대로) */
function applyKeep(s: Sel, t: number, keep: Keep): Entity | null {
  if (s.closedCurve) return null;
  const e = s.e;
  const p = s.piece;
  if (e.type === 'XLINE' || e.type === 'RAY') {
    const lp = p as LinePiece;
    const T = pieceAt(lp, t);
    const dir = sub(lp.b, lp.a);
    if (keep === 'after') return makeRay(e, T, dir, s.path.z);
    if (e.type === 'XLINE') return makeRay(e, T, mul(dir, -1), s.path.z);
    return makeLine(e, lp.a, T, s.path.z);
  }
  const np = keptPiece(p, t, keep);
  if (s.path.pieces.length === 1) {
    if (e.type === 'SPLINE') {
      const n = pieceNurbs(np, s.path.z);
      return n ? makeSpline(e, n, false) : null;
    }
    return rebuildFrom(e, [np], s.path.z);
  }
  const pcs = [...s.path.pieces];
  pcs[s.idx] = np;
  return rebuildFrom(e, pcs, s.path.z);
}

function arcEntity(src: Entity, a: ArcPiece, z: number): Entity {
  return makeArc(src, a, z);
}

/** 두 객체 결과 합치기(같은 객체는 하나로) */
function twoResults(s1: Sel, n1: Entity | null, s2: Sel, n2: Entity | null, extra: Entity[]): EditResult {
  const parts: EditResult[] = [];
  if (n1) parts.push(resultFrom(s1.e, [n1]));
  if (n2) parts.push(resultFrom(s2.e, [n2]));
  const out = mergeResults(parts);
  if (extra.length) (out.add ??= []).push(...extra);
  return out;
}

// ---------------------------------------------------------------------------
// FILLET
// ---------------------------------------------------------------------------

/** 두 객체 모깎기 */
export function fillet(e1: Entity, pick1: Vec2, e2: Entity, pick2: Vec2, radius: number, opts: FilletOptions = {}): EditResult {
  const trim = opts.trim !== false;
  const r = Math.max(0, radius);
  const s1 = select(e1, pick1);
  const s2 = select(e2, pick2);
  if (!s1 || !s2) return { message: MSG.cannotFillet };
  if (e1 === e2 || (e1.handle && e1.handle === e2.handle)) return sameEntityCorner(s1, s2, r, 'fillet');
  if (!endSegmentOk(s1) || !endSegmentOk(s2)) return { message: MSG.notEndSegment };
  let sol: Solved | string;
  if (parallelLines(s1.piece, s2.piece)) sol = solveParallel(s1, s2);
  else sol = solveFillet(s1, s2, r);
  if (typeof sol === 'string') return { message: sol };
  const z = s1.path.z;
  const extra: Entity[] = sol.arc ? [arcEntity(e1, sol.arc, z)] : [];
  if (!trim) return extra.length ? { add: extra } : { message: MSG.cannotFillet };
  return twoResults(s1, applyKeep(s1, sol.t1, sol.keep1), s2, applyKeep(s2, sol.t2, sol.keep2), extra);
}

// ---------------------------------------------------------------------------
// CHAMFER
// ---------------------------------------------------------------------------

function lineFrame(s: Sel, X: Vec2): { u: Vec2; tX: number; keep: Keep } | null {
  const p = s.piece as LinePiece;
  const d = sub(p.b, p.a);
  const dl = len(d);
  if (!(dl > 0)) return null;
  const tX = dot(sub(X, p.a), d) / (dl * dl);
  const tp = pieceNearest(p, s.pick, true).t;
  const keep: Keep = tp >= tX ? 'after' : 'before';
  const u = keep === 'after' ? mul(d, 1 / dl) : mul(d, -1 / dl);
  return { u, tX, keep };
}

/** 두 선의 모따기(거리 d1, d2) */
export function chamfer(e1: Entity, pick1: Vec2, e2: Entity, pick2: Vec2, d1: number, d2: number, opts: FilletOptions = {}): EditResult {
  return chamferImpl(e1, pick1, e2, pick2, { d1, d2 }, opts);
}

/** 두 선의 모따기(첫 선의 길이와 첫 선에서 잰 각도, 라디안) */
export function chamferAngle(e1: Entity, pick1: Vec2, e2: Entity, pick2: Vec2, length: number, angle: number, opts: FilletOptions = {}): EditResult {
  return chamferImpl(e1, pick1, e2, pick2, { len: length, angle }, opts);
}

type ChamferSpec = { d1: number; d2: number } | { len: number; angle: number };

function chamferDistances(spec: ChamferSpec, theta: number): [number, number] | null {
  if ('d1' in spec) return [Math.max(0, spec.d1), Math.max(0, spec.d2)];
  const a = spec.angle;
  if (!(spec.len >= 0) || !(a > 0) || theta + a >= Math.PI - 1e-12) return null;
  return [spec.len, (spec.len * Math.sin(a)) / Math.sin(theta + a)];
}

function chamferImpl(e1: Entity, pick1: Vec2, e2: Entity, pick2: Vec2, spec: ChamferSpec, opts: FilletOptions): EditResult {
  const trim = opts.trim !== false;
  const s1 = select(e1, pick1);
  const s2 = select(e2, pick2);
  if (!s1 || !s2) return { message: MSG.cannotChamfer };
  if (e1 === e2 || (e1.handle && e1.handle === e2.handle)) return sameEntityCorner(s1, s2, 0, 'chamfer', spec);
  if (s1.piece.k !== 'line' || s2.piece.k !== 'line') return { message: MSG.cannotChamfer };
  if (!endSegmentOk(s1) || !endSegmentOk(s2)) return { message: MSG.notEndSegment };
  if (parallelLines(s1.piece, s2.piece)) return { message: MSG.parallel };
  const hits = intersectPieces(s1.piece, s2.piece, true, true);
  if (!hits.length) return { message: MSG.parallel };
  const X = hits[0]!.p;
  const f1 = lineFrame(s1, X);
  const f2 = lineFrame(s2, X);
  if (!f1 || !f2) return { message: MSG.cannotChamfer };
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(f1.u, f2.u))));
  const ds = chamferDistances(spec, theta);
  if (!ds) return { message: MSG.distanceTooLarge };
  const [d1, d2] = ds;
  const p1 = s1.piece as LinePiece;
  const p2 = s2.piece as LinePiece;
  const T1 = add(X, mul(f1.u, d1));
  const T2 = add(X, mul(f2.u, d2));
  const t1 = paramOf(p1, T1);
  const t2 = paramOf(p2, T2);
  if (!keepValid(p1, t1, f1.keep, false) || !keepValid(p2, t2, f2.keep, false)) return { message: MSG.distanceTooLarge };
  const z = s1.path.z;
  const extra: Entity[] = dist(T1, T2) > 1e-12 * Math.max(1, Math.abs(X.x), Math.abs(X.y)) ? [makeLine(e1, T1, T2, z)] : [];
  if (!trim) return extra.length ? { add: extra } : { message: MSG.cannotChamfer };
  return twoResults(s1, applyKeep(s1, t1, f1.keep), s2, applyKeep(s2, t2, f2.keep), extra);
}

// ---------------------------------------------------------------------------
// 같은 폴리선 안의 두 세그먼트
// ---------------------------------------------------------------------------

/** 꼭짓점(들어오는 조각 A의 끝, 나가는 조각 B의 시작)의 모깎기: A는 앞쪽, B는 뒤쪽을 남긴다 */
function cornerFillet(A: Piece, B: Piece, r: number, allowExtend: boolean): { t1: number; t2: number; arc?: ArcPiece } | string {
  if (parallelLines(A, B)) {
    // 사이 세그먼트를 반원으로(세그먼트 하나를 사이에 둔 평행선)
    if (!allowExtend) return MSG.parallel;
    const a = A as LinePiece;
    const b = B as LinePiece;
    const d = norm(sub(a.b, a.a));
    const gap = Math.abs(cross(d, sub(b.a, a.a)));
    if (gap <= 1e-10 * Math.max(1, pieceSize(a))) return EXTRA_MSG.collinear;
    const E1 = a.b;
    const bv = sub(b.b, b.a);
    const t2 = dot(sub(E1, b.a), bv) / dot(bv, bv);
    if (t2 >= 1 - 1e-9 || dot(bv, d) > 0) return MSG.radiusTooLarge;
    const T2 = pieceAt(b, t2);
    const c = mid(E1, T2);
    const sg = cross(sub(E1, c), d) > 0 ? 1 : -1;
    return { t1: 1, t2, arc: { k: 'arc', c, r: gap / 2, a0: angleOf(sub(E1, c)), sw: sg * Math.PI } };
  }
  if (r <= 0) {
    const hits = intersectPieces(A, B, true, true);
    if (!hits.length) return MSG.cannotFillet;
    let best = hits[0]!;
    const V = pieceAt(A, 1);
    for (const h of hits) if (dist(h.p, V) < dist(best.p, V)) best = h;
    const t1 = normT(A, best.t);
    const t2 = normT(B, best.u);
    if (t1 <= 1e-9 || t2 >= 1 - 1e-9) return MSG.radiusTooLarge;
    if (!allowExtend && (t1 > 1 + 1e-9 || t2 < -1e-9)) return MSG.radiusTooLarge;
    return { t1, t2 };
  }
  const V = mid(pieceAt(A, 1), pieceAt(B, 0));
  let best: Fillet | null = null;
  let bs = Infinity;
  for (const cd of candidates(A, B, r)) {
    const f = filletOf(A, B, cd, r);
    if (!f || f.keep1 !== 'before' || f.keep2 !== 'after') continue;
    if (!(f.cand.t1 > 1e-9) || !(f.cand.t2 < 1 - 1e-9)) continue;
    if (!allowExtend && (f.cand.t1 > 1 + 1e-9 || f.cand.t2 < -1e-9)) continue;
    const sc = dist(f.cand.T1, V) + dist(f.cand.T2, V);
    if (sc < bs) {
      bs = sc;
      best = f;
    }
  }
  if (!best) return MSG.radiusTooLarge;
  return { t1: best.cand.t1, t2: best.cand.t2, arc: best.arc };
}

function cornerChamfer(A: Piece, B: Piece, spec: ChamferSpec, allowExtend: boolean): { t1: number; t2: number; line?: LinePiece } | string {
  if (A.k !== 'line' || B.k !== 'line') return MSG.cannotChamfer;
  if (parallelLines(A, B)) return MSG.parallel;
  const hits = intersectPieces(A, B, true, true);
  if (!hits.length) return MSG.parallel;
  const X = hits[0]!.p;
  const uA = norm(sub(A.a, A.b)); // 꼭짓점에서 A 쪽으로
  const uB = norm(sub(B.b, B.a));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(uA, uB))));
  const ds = chamferDistances(spec, theta);
  if (!ds) return MSG.distanceTooLarge;
  const T1 = add(X, mul(uA, ds[0]));
  const T2 = add(X, mul(uB, ds[1]));
  const t1 = paramOf(A, T1);
  const t2 = paramOf(B, T2);
  if (t1 <= 1e-9 || t2 >= 1 - 1e-9) return MSG.distanceTooLarge;
  if (!allowExtend && (t1 > 1 + 1e-9 || t2 < -1e-9)) return MSG.distanceTooLarge;
  return dist(T1, T2) > 1e-12 ? { t1, t2, line: { k: 'line', a: T1, b: T2 } } : { t1, t2 };
}

/** 폴리선 꼭짓점 사이에 넣을 조각(폭: 들어오는 다리의 잘린 자리 폭 → 나가는 다리의 잘린 자리 폭) */
function bridge(p: Piece, A: Piece, t1: number, B: Piece, t2: number): Piece {
  const w0 = widthAt(A, t1);
  const w1 = widthAt(B, t2);
  const q = { ...p };
  if (w0 !== undefined || w1 !== undefined) {
    q.w0 = w0 ?? 0;
    q.w1 = w1 ?? 0;
  }
  return q;
}

function sameEntityCorner(s1: Sel, s2: Sel, r: number, kind: 'fillet' | 'chamfer', spec?: ChamferSpec): EditResult {
  const e = s1.e;
  if (!isPolyline(e)) return { message: EXTRA_MSG.sameObject };
  const pcs = s1.path.pieces;
  const n = pcs.length;
  const closed = s1.path.closed;
  let i = s1.idx;
  let j = s2.idx;
  if (i === j) return { message: EXTRA_MSG.sameObject };
  // i가 앞, j가 뒤(닫힌 폴리선은 감싸는 쪽도)
  const fwd = (a: number, b: number) => (closed ? (b - a + n) % n : b - a);
  let gap: number;
  if (fwd(i, j) === 1 || fwd(i, j) === 2) gap = fwd(i, j);
  else if (fwd(j, i) === 1 || fwd(j, i) === 2) {
    [i, j] = [j, i];
    gap = fwd(i, j);
  } else return { message: MSG.differentPlines };
  if (gap === 2 && (pcs[i]!.k !== 'line' || pcs[j]!.k !== 'line')) return { message: MSG.differentPlines };
  const A = pcs[i]!;
  const B = pcs[j]!;
  const res = kind === 'fillet' ? cornerFillet(A, B, r, gap === 2) : cornerChamfer(A, B, spec!, gap === 2);
  if (typeof res === 'string') return { message: res };
  const mid1 = 'arc' in res ? res.arc : 'line' in res ? res.line : undefined;
  const out: Piece[] = [];
  for (let k = 0; k < n; k++) {
    if (k === i) {
      out.push(keptPiece(A, res.t1, 'before'));
      if (mid1) out.push(bridge(mid1, A, res.t1, B, res.t2));
      continue;
    }
    if (k === j) {
      out.push(keptPiece(B, res.t2, 'after'));
      continue;
    }
    if (gap === 2 && k === (i + 1) % n) continue;
    out.push(pcs[k]!);
  }
  // 닫힌 폴리선에서 j < i(감싸기)이면 j 조각이 맨 앞에 있어 순서가 맞다
  const built = makePolyline(e, out.filter((p) => pieceLength(p) > 1e-12), closed, s1.path.z);
  if (!built) return { message: kind === 'fillet' ? MSG.cannotFillet : MSG.cannotChamfer };
  return { replace: [keepIdentity(e, built)] };
}

// ---------------------------------------------------------------------------
// 폴리선 전체(FILLET 폴리선 P, CHAMFER 폴리선 P)
// ---------------------------------------------------------------------------

/** 꼭짓점에서 수렴하는 두 직선 사이의 호 세그먼트(이전 모깎기)인지 */
function isFilletArc(prev: Piece, arc: Piece, next: Piece): boolean {
  if (arc.k !== 'arc' || prev.k !== 'line' || next.k !== 'line') return false;
  const t0 = pieceTangent(arc, 0);
  const t1 = pieceTangent(arc, 1);
  const tp = pieceTangent(prev, 1);
  const tn = pieceTangent(next, 0);
  if (dot(t0, tp) < 1 - 1e-6 || dot(t1, tn) < 1 - 1e-6) return false;
  // 두 직선이 호 쪽으로 다가가며 만나는지
  const hits = intersectPieces(prev, next, true, true);
  if (!hits.length) return false;
  return hits[0]!.t > 1 - 1e-9 && hits[0]!.u < 1e-9;
}

/** 이전 모깎기 호를 지우고 모서리로 되돌린 조각 목록 */
function sharpen(pcs: Piece[], closed: boolean): Piece[] {
  let cur = [...pcs];
  for (let guard = 0; guard < pcs.length; guard++) {
    const n = cur.length;
    let changed = false;
    for (let k = 0; k < n; k++) {
      const pi = k - 1;
      const ni = k + 1;
      if (!closed && (pi < 0 || ni >= n)) continue;
      if (n < 3) break;
      const prev = cur[(pi + n) % n]!;
      const next = cur[ni % n]!;
      const arc = cur[k]!;
      if (!isFilletArc(prev, arc, next)) continue;
      const h = intersectPieces(prev, next, true, true)[0]!;
      const X = h.p;
      const np: LinePiece = { ...(prev as LinePiece), b: X };
      const nn: LinePiece = { ...(next as LinePiece), a: X };
      // 늘인 다리는 테이퍼를 이어 원래 폭으로
      if (prev.w0 !== undefined || prev.w1 !== undefined) {
        const tp = h.t;
        np.w1 = Math.max(0, (prev.w0 ?? 0) + ((prev.w1 ?? 0) - (prev.w0 ?? 0)) * tp);
        const tn = h.u;
        nn.w0 = Math.max(0, (next.w0 ?? 0) + ((next.w1 ?? 0) - (next.w0 ?? 0)) * tn);
      }
      const out: Piece[] = [];
      for (let q = 0; q < n; q++) {
        if (q === k) continue;
        if (q === (pi + n) % n) out.push(np);
        else if (q === ni % n) out.push(nn);
        else out.push(cur[q]!);
      }
      cur = out;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return cur;
}

type CornerFn = (A: Piece, B: Piece) => { t1: number; t2: number; mid?: Piece } | string | null;

function polylineCorners(pl: Entity, fn: CornerFn, verb: string, resharpen: boolean): EditResult {
  const path = entityPath(pl);
  if (!path || !isPolyline(pl)) return { message: verb === '모깎기' ? MSG.cannotFillet : MSG.cannotChamfer };
  const closed = path.closed;
  let pcs = path.pieces.map((p) => ({ ...p }));
  if (resharpen) pcs = sharpen(pcs, closed);
  const n = pcs.length;
  // 조각마다 앞·뒤에서 쓴 매개변수
  const startT = new Array<number>(n).fill(0);
  const endT = new Array<number>(n).fill(1);
  const mids: (Piece | null)[] = new Array(n).fill(null);
  let done = 0;
  let short = 0;
  const corners = closed ? n : n - 1;
  for (let k = 0; k < corners; k++) {
    const ia = k;
    const ib = (k + 1) % n;
    const A = pcs[ia]!;
    const B = pcs[ib]!;
    if (A.k !== 'line' || B.k !== 'line') continue;
    const da = norm(sub(A.b, A.a));
    const db = norm(sub(B.b, B.a));
    if (Math.abs(cross(da, db)) < 1e-10) continue; // 일직선·되돌아감
    const res = fn(A, B);
    if (res === null) continue;
    if (typeof res === 'string' || res.t1 <= startT[ia]! + 1e-9 || res.t2 >= endT[ib]! - 1e-9 || res.t1 > 1 + 1e-9 || res.t2 < -1e-9) {
      short++;
      continue;
    }
    endT[ia] = res.t1;
    startT[ib] = res.t2;
    if (res.mid) mids[ia] = bridge(res.mid, A, res.t1, B, res.t2);
    done++;
  }
  const out: Piece[] = [];
  for (let k = 0; k < n; k++) {
    const p = pcs[k]!;
    const t0 = startT[k]!;
    const t1 = endT[k]!;
    const q = t0 <= 0 && t1 >= 1 ? p : subPiece(p, t0, t1);
    if (pieceLength(q) > 1e-12) out.push(q);
    const m = mids[k];
    if (m) out.push(m);
  }
  const built = makePolyline(pl, out, closed, path.z);
  if (!built) return { message: verb === '모깎기' ? MSG.cannotFillet : MSG.cannotChamfer };
  const msg = `${done}개 선이 ${verb}되었습니다.` + (short ? ` ${short}개는 너무 짧습니다.` : '');
  const changed = done > 0 || pcs.length !== path.pieces.length;
  return changed ? { replace: [keepIdentity(pl, built)], message: msg } : { message: msg };
}

/** 폴리선의 모든 직선-직선 꼭짓점 모깎기(이전 모깎기 호는 새 반지름으로 바꾼다, 반지름 0은 모서리로) */
export function filletPolyline(pl: Entity, radius: number): EditResult {
  const r = Math.max(0, radius);
  return polylineCorners(
    pl,
    (A, B) => {
      if (r <= 0) return null;
      const res = cornerFillet(A, B, r, false);
      if (typeof res === 'string') return res;
      return { t1: res.t1, t2: res.t2, mid: res.arc };
    },
    '모깎기',
    true,
  );
}

/** 폴리선의 모든 직선-직선 꼭짓점 모따기(d1: 꼭짓점으로 들어오는 세그먼트, d2: 나가는 세그먼트) */
export function chamferPolyline(pl: Entity, d1: number, d2: number): EditResult {
  return polylineCorners(
    pl,
    (A, B) => {
      const res = cornerChamfer(A, B, { d1, d2 }, false);
      if (typeof res === 'string') return res;
      return { t1: res.t1, t2: res.t2, mid: res.line };
    },
    '모따기',
    false,
  );
}

/** 폴리선 모따기(길이·각도) */
export function chamferPolylineAngle(pl: Entity, length: number, angle: number): EditResult {
  return polylineCorners(
    pl,
    (A, B) => {
      const res = cornerChamfer(A, B, { len: length, angle }, false);
      if (typeof res === 'string') return res;
      return { t1: res.t1, t2: res.t2, mid: res.line };
    },
    '모따기',
    false,
  );
}

