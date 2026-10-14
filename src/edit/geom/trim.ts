/**
 * TRIM·EXTEND·BREAK·LENGTHEN.
 * 고른 점(pick)이 어느 부분을 지우거나 어느 끝을 늘일지 정한다(AutoCAD와 같다).
 * 결과가 원본과 같은 종류면 replace(핸들 유지), 둘로 나뉘면 나머지는 add, 종류가 바뀌면 remove + add.
 */
import type { CadDocument, Entity, Vec2 } from '../../core/model';
import { type ArcPiece, type EllPiece, type LinePiece, type Path, type Piece, pathBox, pathLength, pathNearest, pathSAtLength, pathSub, pieceAt, pieceBox, pieceLength, pieceTAtLength, pieceTangent, subPiece } from './curve';
import { boxesOverlap, edgeBox, edgeSet } from './edges';
import { intersectPieces } from './intersect';
import { type Box, TAU, add, dist, mul, sub } from './math';
import { joinNurbs, lineBezier, beziersToNurbs } from './nurbs';
import { entityPath, makeLine, makeRay, makeSpline, pieceNurbs, rebuildFrom, tinyPiece } from './path';
import { type EditResult, MSG } from './types';
import { complement } from './edges';

export interface TrimOptions {
  /** EDGEMODE = 1: 모서리를 가상으로 연장 */
  extendEdges?: boolean;
  /** cutters가 'all'일 때 쓸 객체 목록 */
  all?: Entity[];
  /** 블록 참조·치수 모서리를 풀 때 쓴다 */
  doc?: CadDocument;
  /** 빠른 모드: 교차가 없으면 객체를 지운다(AutoCAD 2021+ TRIM 빠른 작업) */
  quick?: boolean;
}

/** 결과 객체들을 원본 교체·추가로 */
export function resultFrom(src: Entity, built: (Entity | null)[]): EditResult {
  const list = built.filter((x): x is Entity => !!x);
  if (!list.length) return { remove: src.handle ? [src.handle] : [] };
  const [first, ...rest] = list;
  if (first!.type === src.type) {
    const r = keepIdentity(src, first!);
    return rest.length ? { replace: [r], add: rest } : { replace: [r] };
  }
  return { remove: src.handle ? [src.handle] : [], add: list };
}

/** 원본의 핸들·사전·반응자·하이퍼링크를 결과에 잇는다 */
export function keepIdentity<T extends Entity>(src: Entity, out: T): T {
  const r = { ...out, handle: src.handle } as T;
  if (src.xdict) r.xdict = src.xdict;
  if (src.reactors) r.reactors = [...src.reactors];
  if (src.hyperlink) r.hyperlink = { ...src.hyperlink };
  return r;
}

function cutterPieces(e: Entity, cutters: Entity[] | 'all', opts: TrimOptions, target?: Path): { edges: Piece[]; self: boolean } {
  const list = cutters === 'all' ? (opts.all ?? []) : cutters;
  const edges: Piece[] = [];
  let self = false;
  // 모서리를 늘이지 않으면 대상 범위와 겹치지 않는 객체는 미리 거른다(빠른 모드는 도면 전체를 넘길 수 있다)
  const tb = target && !opts.extendEdges && !isInfinite(target) ? pathBox(target) : null;
  const pad = tb ? 1e-9 * Math.max(1, tb.maxX - tb.minX, tb.maxY - tb.minY, Math.abs(tb.minX), Math.abs(tb.maxY)) : 0;
  for (const c of list) {
    if (c === e || (c.handle && c.handle === e.handle)) {
      self = true;
      continue;
    }
    if (tb) {
      const cb = edgeBox(c, opts.doc);
      if (!cb || (cb !== 'inf' && !boxesOverlap(cb, tb, pad))) continue;
    }
    edges.push(...edgeSet(c, opts.doc, !!opts.extendEdges));
  }
  return { edges, self };
}

/** 경로 위 교차 매개변수(전역 s) */
function cutParams(path: Path, edges: Piece[], self: boolean): number[] {
  const out: number[] = [];
  const pcs = path.pieces;
  const finite = (q: Piece) => !(q.k === 'line' && (q.inf0 || q.inf1));
  const eb = edges.map((q) => (finite(q) ? pieceBox(q) : null));
  pcs.forEach((p, i) => {
    const pb = finite(p) ? pieceBox(p) : null;
    const pad = pb ? 1e-9 * Math.max(1, pb.maxX - pb.minX, pb.maxY - pb.minY, Math.abs(pb.minX), Math.abs(pb.maxY)) : 0;
    edges.forEach((q, k) => {
      const qb = eb[k];
      if (pb && qb && !boxesOverlap(pb, qb, pad)) return;
      for (const h of intersectPieces(p, q)) out.push(i + h.t);
    });
  });
  if (self) {
    const n = pcs.length;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const adj = j === i + 1 || (path.closed && i === 0 && j === n - 1);
        for (const h of intersectPieces(pcs[i]!, pcs[j]!)) {
          if (adj) {
            const shared = j === i + 1 ? h.t > 1 - 1e-9 && h.u < 1e-9 : h.t < 1e-9 && h.u > 1 - 1e-9;
            if (shared) continue;
          }
          out.push(i + h.t, j + h.u);
        }
      }
  }
  out.sort((a, b) => a - b);
  const ded: number[] = [];
  for (const s of out) if (!ded.length || s - ded[ded.length - 1]! > 1e-9) ded.push(s);
  return ded;
}

function isInfinite(path: Path): boolean {
  const p = path.pieces[0]!;
  return path.pieces.length === 1 && p.k === 'line' && !!(p.inf0 || p.inf1);
}

export function trimEntity(e: Entity, cutters: Entity[] | 'all', pick: Vec2, opts: TrimOptions = {}): EditResult {
  const path = entityPath(e);
  if (!path) return { message: MSG.cannotTrim };
  const { edges, self } = cutterPieces(e, cutters, opts, path);
  const params = cutParams(path, edges, self);
  const sp = pathNearest(path, pick);
  if (isInfinite(path)) return trimInfinite(e, path, params, sp.s, opts);
  const n = path.pieces.length;
  const eps = 1e-9;
  const none = (): EditResult => (opts.quick ? { remove: e.handle ? [e.handle] : [] } : { message: MSG.noIntersect });
  if (!path.closed) {
    const inner = params.filter((s) => s > eps && s < n - eps);
    if (!inner.length) return none();
    let lo = 0;
    let hi = n;
    for (const s of inner) {
      if (s <= sp.s) lo = s;
      else if (hi === n) hi = s;
    }
    const keep1 = lo > eps ? pathSub(path, 0, lo) : [];
    const keep2 = hi < n - eps ? pathSub(path, hi, n) : [];
    return resultFrom(e, [keep1.length ? rebuildFrom(e, keep1, path.z) : null, keep2.length ? rebuildFrom(e, keep2, path.z) : null]);
  }
  // 닫힌 경로: 둘 이상의 교점 사이
  const ps = params.map((s) => (s >= n - eps ? 0 : s)).filter((s, i, a) => a.indexOf(s) === i);
  if (ps.length < 2) return none();
  let lo = -1;
  let hi = -1;
  for (const s of ps) if (s <= sp.s) lo = s;
  for (const s of ps)
    if (s > sp.s) {
      hi = s;
      break;
    }
  if (lo < 0) lo = ps[ps.length - 1]!;
  if (hi < 0) hi = ps[0]!;
  const keep = pathSub(path, hi, lo);
  if (!keep.length) return { remove: e.handle ? [e.handle] : [] };
  return resultFrom(e, [rebuildFrom(e, keep, path.z, false)]);
}

function trimInfinite(e: Entity, path: Path, params: number[], tp: number, opts: TrimOptions): EditResult {
  const p = path.pieces[0] as LinePiece;
  const isRay = e.type === 'RAY';
  const ts = isRay ? params.filter((t) => t > 1e-9) : params;
  if (!ts.length) return opts.quick ? { remove: [e.handle] } : { message: MSG.noIntersect };
  let lo = -Infinity;
  let hi = Infinity;
  for (const t of ts) {
    if (t <= tp) lo = t;
    else if (hi === Infinity) hi = t;
  }
  const dir = sub(p.b, p.a);
  const out: Entity[] = [];
  if (isRay) {
    if (lo > 0) out.push(rebuildLine(e, pieceAt(p, 0), pieceAt(p, lo), path.z));
    if (hi < Infinity) out.push(makeRay(e, pieceAt(p, hi), dir, path.z));
  } else {
    if (lo > -Infinity) out.push(makeRay(e, pieceAt(p, lo), mul(dir, -1), path.z));
    if (hi < Infinity) out.push(makeRay(e, pieceAt(p, hi), dir, path.z));
  }
  return resultFrom(e, out);
}

function rebuildLine(src: Entity, a: Vec2, b: Vec2, z: number): Entity {
  return makeLine(src, a, b, z, z);
}

// ---------------------------------------------------------------------------
// EXTEND
// ---------------------------------------------------------------------------

/** 반직선 p + t·d(t ≥ 0)이 상자와 만나는지(여유 포함) */
function rayHitsBox(p: Vec2, d: Vec2, b: Box): boolean {
  const pad = 1e-9 * Math.max(1, b.maxX - b.minX, b.maxY - b.minY, Math.abs(b.minX), Math.abs(b.maxY));
  let t0 = 0;
  let t1 = Infinity;
  for (const [o, v, lo, hi] of [
    [p.x, d.x, b.minX - pad, b.maxX + pad],
    [p.y, d.y, b.minY - pad, b.maxY + pad],
  ] as const) {
    if (Math.abs(v) < 1e-300) {
      if (o < lo || o > hi) return false;
      continue;
    }
    let a = (lo - o) / v;
    let c = (hi - o) / v;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return false;
  }
  return true;
}

/** 끝에서 바깥으로 나가는 연장 조각(t = 0이 끝점) */
function outward(p: Piece, atEnd: boolean): Piece {
  const q = atEnd ? p : subPiece(p, 1, 0);
  if (q.k === 'line') {
    const d = sub(q.b, q.a);
    return { k: 'line', a: q.b, b: add(q.b, d), inf1: true };
  }
  if (q.k === 'arc' || q.k === 'ell') return complement(q as ArcPiece | EllPiece);
  const pt = pieceAt(q, 1);
  const tg = pieceTangent(q, 1);
  return { k: 'line', a: pt, b: add(pt, tg), inf1: true };
}

function whichEnd(path: Path, pick: Vec2): 'start' | 'end' {
  const sp = pathNearest(path, pick);
  const L = pathLength(path);
  const at = pathLength(path, 0, sp.s);
  return at < L / 2 ? 'start' : 'end';
}

export function extendEntity(e: Entity, boundaries: Entity[], pick: Vec2, opts: TrimOptions = {}): EditResult {
  const path = entityPath(e);
  if (!path || path.closed || isInfinite(path) || e.type === 'CIRCLE') return { message: MSG.cannotExtend };
  if (e.type === 'POLYLINE' && e.kind !== '2d' && e.kind !== '3d') return { message: MSG.cannotExtend };
  const end = whichEnd(path, pick);
  const atEnd = end === 'end';
  const pcs = path.pieces;
  const endPiece = atEnd ? pcs[pcs.length - 1]! : pcs[0]!;
  const ext = outward(endPiece, atEnd);
  const edges: Piece[] = [];
  // 연장 조각(반직선·원·타원)과 범위가 겹치지 않는 경계는 미리 거른다
  const reach = (b: Box): boolean => {
    if (ext.k === 'line') return rayHitsBox(ext.a, sub(ext.b, ext.a), b);
    const eb = pieceBox(ext);
    return boxesOverlap(eb, b, 1e-9 * Math.max(1, eb.maxX - eb.minX, eb.maxY - eb.minY));
  };
  for (const b of boundaries) {
    if (b === e || (b.handle && b.handle === e.handle)) continue;
    if (!opts.extendEdges) {
      const bb = edgeBox(b, opts.doc);
      if (!bb || (bb !== 'inf' && !reach(bb))) continue;
    }
    edges.push(...edgeSet(b, opts.doc, !!opts.extendEdges));
  }
  let best = Infinity;
  const tolT = ext.k === 'line' ? 1e-9 / Math.max(1e-300, dist(ext.a, ext.b)) * Math.max(1, Math.abs(ext.a.x), Math.abs(ext.a.y)) : 1e-9;
  for (const q of edges) for (const h of intersectPieces(ext, q)) if (h.t > tolT && h.t < best) best = h.t;
  if (!Number.isFinite(best)) return { message: MSG.noIntersect };
  const built = extendBy(e, path, atEnd, ext, best);
  return built ? resultFrom(e, [built]) : { message: MSG.cannotExtend };
}

/** 끝 조각을 연장 조각의 t까지 늘인 객체 */
function extendBy(e: Entity, path: Path, atEnd: boolean, ext: Piece, t: number): Entity | null {
  const pcs = [...path.pieces];
  const idx = atEnd ? pcs.length - 1 : 0;
  const p = pcs[idx]!;
  let np: Piece;
  if (p.k === 'line') {
    const X = pieceAt(ext, t);
    const L0 = pieceLength(p);
    const L1 = dist(atEnd ? p.a : p.b, X);
    np = atEnd ? { ...p, b: X } : { ...p, a: X };
    // 폭·Z 테이퍼 잇기
    const k = L0 > 0 ? L1 / L0 : 1;
    if (p.w0 !== undefined || p.w1 !== undefined) {
      const w0 = p.w0 ?? 0;
      const w1 = p.w1 ?? 0;
      if (atEnd) np.w1 = Math.max(0, w0 + (w1 - w0) * k);
      else np.w0 = Math.max(0, w1 + (w0 - w1) * k);
    }
    if (p.za !== undefined) {
      const za = p.za ?? 0;
      const zb = p.zb ?? za;
      if (atEnd) np.zb = za + (zb - za) * k;
      else np.za = zb + (za - zb) * k;
    }
  } else if (p.k === 'arc') {
    const extra = (ext as ArcPiece).sw * t;
    const sg = p.sw >= 0 ? 1 : -1;
    const k = (Math.abs(p.sw) + Math.abs(extra)) / Math.abs(p.sw);
    if (atEnd) np = { ...p, sw: p.sw + sg * Math.abs(extra) };
    else np = { ...p, a0: p.a0 - sg * Math.abs(extra), sw: p.sw + sg * Math.abs(extra) };
    if (p.w0 !== undefined || p.w1 !== undefined) {
      const w0 = p.w0 ?? 0;
      const w1 = p.w1 ?? 0;
      if (atEnd) np.w1 = Math.max(0, w0 + (w1 - w0) * k);
      else np.w0 = Math.max(0, w1 + (w0 - w1) * k);
    }
  } else if (p.k === 'ell') {
    const extra = Math.abs((ext as EllPiece).dt * t);
    const sg = p.dt >= 0 ? 1 : -1;
    if (atEnd) np = { ...p, dt: p.dt + sg * extra };
    else np = { ...p, t0: p.t0 - sg * extra, dt: p.dt + sg * extra };
  } else {
    // 스플라인: 끝 접선 방향 직선 부분을 붙인다(C1)
    const X = pieceAt(ext, t);
    const z = path.z;
    const base = pieceNurbs(p, z)!;
    const P0 = pieceAt(p, atEnd ? 1 : 0);
    const lineN = beziersToNurbs([atEnd ? lineBezier({ x: P0.x, y: P0.y, z }, { x: X.x, y: X.y, z }) : lineBezier({ x: X.x, y: X.y, z }, { x: P0.x, y: P0.y, z })])!;
    const joined = atEnd ? joinNurbs([base, lineN]) : joinNurbs([lineN, base]);
    if (!joined) return null;
    return makeSpline(e, joined, false);
  }
  pcs[idx] = np;
  return rebuildFrom(e, pcs, path.z);
}

// ---------------------------------------------------------------------------
// BREAK
// ---------------------------------------------------------------------------

export function breakEntity(e: Entity, p1: Vec2, p2: Vec2): EditResult {
  const path = entityPath(e);
  if (!path) return { message: MSG.cannotBreak };
  const n = path.pieces.length;
  const a = pathNearest(path, p1);
  const b = pathNearest(path, p2);
  const tolS = 1e-9;
  const samePt = dist(a.p, b.p) <= 1e-9 * Math.max(1, Math.abs(a.p.x), Math.abs(a.p.y)) || Math.abs(a.s - b.s) < tolS;
  if (isInfinite(path)) {
    const p = path.pieces[0] as LinePiece;
    const dir = sub(p.b, p.a);
    const lo = Math.min(a.t, b.t);
    const hi = Math.max(a.t, b.t);
    const out: Entity[] = [];
    if (e.type === 'XLINE') {
      out.push(makeRay(e, pieceAt(p, lo), mul(dir, -1), path.z));
      out.push(makeRay(e, pieceAt(p, hi), dir, path.z));
    } else {
      if (lo > 1e-9) out.push(rebuildLine(e, pieceAt(p, 0), pieceAt(p, lo), path.z));
      out.push(makeRay(e, pieceAt(p, hi), dir, path.z));
    }
    return resultFrom(e, out);
  }
  if (path.closed) {
    if (samePt) {
      if (e.type === 'CIRCLE' || e.type === 'ELLIPSE') return { message: MSG.fullCircle };
      // 닫힌 폴리선·스플라인: 그 점에서 연다
      const all = [...pathSub(path, a.s, n), ...pathSub(path, 0, a.s)];
      return resultFrom(e, [rebuildFrom(e, all, path.z, false)]);
    }
    // 원: 첫 점에서 둘째 점까지 반시계(경로 방향)를 지운다
    const keep = pathSub(path, b.s, a.s);
    return resultFrom(e, [rebuildFrom(e, keep, path.z, false)]);
  }
  if (samePt) {
    if (a.s <= tolS || a.s >= n - tolS) return { message: MSG.cannotBreak };
    return resultFrom(e, [rebuildFrom(e, pathSub(path, 0, a.s), path.z), rebuildFrom(e, pathSub(path, a.s, n), path.z)]);
  }
  const lo = Math.min(a.s, b.s);
  const hi = Math.max(a.s, b.s);
  const k1 = lo > tolS ? pathSub(path, 0, lo) : [];
  const k2 = hi < n - tolS ? pathSub(path, hi, n) : [];
  return resultFrom(e, [k1.length ? rebuildFrom(e, k1, path.z) : null, k2.length ? rebuildFrom(e, k2, path.z) : null]);
}

// ---------------------------------------------------------------------------
// LENGTHEN
// ---------------------------------------------------------------------------

export type LengthenMode = { delta: number } | { total: number } | { percent: number } | { angleDelta: number } | { totalAngle: number };

export function lengthenEntity(e: Entity, mode: LengthenMode, pickEnd: Vec2): EditResult {
  const path = entityPath(e);
  if (!path || path.closed || isInfinite(path)) return { message: MSG.cannotLengthen };
  const pcs = path.pieces;
  const L = pathLength(path);
  const s0 = pieceAt(pcs[0]!, 0);
  const s1 = pieceAt(pcs[pcs.length - 1]!, 1);
  const atEnd = dist(pickEnd, s1) <= dist(pickEnd, s0);
  const endPiece = atEnd ? pcs[pcs.length - 1]! : pcs[0]!;
  let Lnew: number;
  if ('delta' in mode) Lnew = L + mode.delta;
  else if ('total' in mode) Lnew = mode.total;
  else if ('percent' in mode) Lnew = (L * mode.percent) / 100;
  else {
    // 각도: 호(또는 끝 세그먼트가 호)만
    if (endPiece.k !== 'arc') return { message: MSG.cannotLengthen };
    const sw = Math.abs(endPiece.sw);
    const target = 'angleDelta' in mode ? sw + mode.angleDelta : mode.totalAngle;
    if (target >= TAU - 1e-12) return { message: MSG.arcTooLong };
    Lnew = L + (target - sw) * endPiece.r;
  }
  if (!(Lnew > 1e-10 * Math.max(1, L))) return { message: MSG.tooShort };
  if (Math.abs(Lnew - L) <= 1e-12 * Math.max(1, L)) return { replace: [e] };
  if (Lnew < L) {
    const keep = atEnd ? pathSub(path, 0, pathSAtLength(path, Lnew)) : pathSub(path, pathSAtLength(path, L - Lnew), pcs.length);
    const built = rebuildFrom(e, keep.filter((p) => !tinyPiece(p)), path.z);
    return built ? resultFrom(e, [built]) : { message: MSG.tooShort };
  }
  const dL = Lnew - L;
  const ext = outward(endPiece, atEnd);
  let t: number;
  if (ext.k === 'line') t = pieceTAtLength(ext, dL);
  else if (ext.k === 'arc') {
    const room = Math.abs(ext.sw) * ext.r;
    if (dL >= room - 1e-12) return { message: MSG.arcTooLong };
    t = dL / room;
  } else if (ext.k === 'ell') {
    const room = pieceLength(ext);
    if (dL >= room - 1e-12) return { message: MSG.ellipseTooLong };
    t = pieceTAtLength(ext, dL);
  } else return { message: MSG.cannotLengthen };
  const built = extendBy(e, path, atEnd, ext, t);
  return built ? resultFrom(e, [built]) : { message: MSG.cannotLengthen };
}
