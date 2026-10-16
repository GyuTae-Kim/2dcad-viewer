/**
 * OFFSET: 선·호·원·폴리선(볼록도, OFFSETGAPTYPE = 0 — 세그먼트를 연장해 만나게, 만나지 않으면 꼭짓점 둘레 호.
 * 1이면 바깥 꼭짓점의 틈을 꼭짓점 중심 호로, 2면 거리만큼 떨어진 모따기 선으로),
 * 타원·스플라인(간격띄운 곡선 위의 점을 지나는 3차 스플라인), 구성선·광선.
 * 원본에서 거리보다 가까워진 부분(자기 교차로 생긴 고리)은 잘라 낸다.
 */
import type { Entity, Vec2 } from '../../core/model';
import { type ArcPiece, type LinePiece, type Path, type Piece, flattenPath, pathNearest, pathSize, pieceAt, pieceBox, pieceLength, pieceTangent, subPiece } from './curve';
import { intersectPieces } from './intersect';
import { TAU, add, angleOf, cross, dist, mul, norm, pointInPolygon, rot90, sub, wrapPi } from './math';
import { type Nurbs, interpolate, joinNurbs, nurbsPoint, periodicInterpolate } from './nurbs';
import { entityPath, inherit, makeArc, makePolyline, makeSpline, tinyPiece } from './path';
import { type EditResult, MSG } from './types';

/** OFFSET 옵션. gapType = OFFSETGAPTYPE(0 연장해 만나게, 1 모깎기 호, 2 모따기 선 — 닫히거나 꺾인 폴리선의 바깥 꼭짓점 틈) */
export interface OffsetOptions {
  gapType?: 0 | 1 | 2;
}

export function offsetEntity(e: Entity, distance: number, side: Vec2, opts: OffsetOptions = {}): EditResult {
  const d = Math.abs(distance);
  if (!(d > 0) || !Number.isFinite(d)) return { message: MSG.offsetDistance };
  switch (e.type) {
    case 'LINE':
    case 'XLINE':
    case 'RAY': {
      const a = e.type === 'LINE' ? e.start : e.base;
      const dir = e.type === 'LINE' ? { x: e.end.x - e.start.x, y: e.end.y - e.start.y } : { x: e.direction.x, y: e.direction.y };
      if (!(Math.hypot(dir.x, dir.y) > 0)) return { message: MSG.cannotOffset };
      const sgn = cross(dir, sub(side, a)) >= 0 ? 1 : -1;
      const n = mul(rot90(norm(dir)), sgn * d);
      if (e.type === 'LINE') {
        return { add: [{ type: 'LINE', ...inherit(e), start: { x: e.start.x + n.x, y: e.start.y + n.y, z: e.start.z }, end: { x: e.end.x + n.x, y: e.end.y + n.y, z: e.end.z } }] };
      }
      return { add: [{ type: e.type, ...inherit(e), base: { x: e.base.x + n.x, y: e.base.y + n.y, z: e.base.z }, direction: { ...e.direction } }] };
    }
    case 'CIRCLE':
    case 'ARC': {
      const path = entityPath(e)!;
      const pc = path.pieces[0]!;
      if (pc.k !== 'arc') return offsetGeneric(e, path, d, side);
      const inside = dist(side, pc.c) < pc.r;
      const r = inside ? pc.r - d : pc.r + d;
      if (!(r > 1e-10 * Math.max(1, pc.r))) return { message: MSG.offsetDistance };
      return { add: [makeArc(e, { ...pc, r }, path.z)] };
    }
    case 'ELLIPSE':
    case 'SPLINE': {
      const path = entityPath(e);
      if (!path) return { message: MSG.cannotOffset };
      return offsetGeneric(e, path, d, side);
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      if (e.type === 'POLYLINE' && e.kind !== '2d') return { message: MSG.cannotOffset };
      const path = entityPath(e);
      if (!path) return { message: MSG.cannotOffset };
      if (path.pieces.some((p) => p.k !== 'line' && p.k !== 'arc')) return offsetGeneric(e, path, d, side);
      return offsetPolyline(e, path, d, side, opts.gapType ?? 0);
    }
    default:
      return { message: MSG.cannotOffset };
  }
}

/** side가 경로 진행 방향의 왼쪽이면 +1 */
export function sideOf(path: Path, side: Vec2): number {
  if (path.closed) {
    const ring = flattenPath(path, pathSize(path) * 1e-4).map((q) => ({ x: q.x, y: q.y }));
    let area = 0;
    for (let i = 0; i < ring.length; i++) area += cross(ring[i]!, ring[(i + 1) % ring.length]!);
    const inside = pointInPolygon(side, ring);
    // 반시계(면적 > 0)면 안쪽 = 왼쪽
    return inside === area > 0 ? 1 : -1;
  }
  const nr = pathNearest(path, side);
  const pcs = path.pieces;
  const v = sub(side, nr.p);
  const eps = 1e-9;
  if (nr.t >= 1 - eps && nr.i + 1 < pcs.length) {
    const n = add(rot90(pieceTangent(pcs[nr.i]!, 1)), rot90(pieceTangent(pcs[nr.i + 1]!, 0)));
    return v.x * n.x + v.y * n.y >= 0 ? 1 : -1;
  }
  if (nr.t <= eps && nr.i > 0) {
    const n = add(rot90(pieceTangent(pcs[nr.i - 1]!, 1)), rot90(pieceTangent(pcs[nr.i]!, 0)));
    return v.x * n.x + v.y * n.y >= 0 ? 1 : -1;
  }
  return cross(pieceTangent(pcs[nr.i]!, nr.t), v) >= 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// 폴리선
// ---------------------------------------------------------------------------

interface Raw {
  p: Piece;
  /** 원본 세그먼트 순번 */
  src: number;
}

function offsetPiece(p: Piece, o: number): Piece | null {
  if (p.k === 'line') {
    const n = mul(rot90(norm(sub(p.b, p.a))), o);
    return { ...p, a: add(p.a, n), b: add(p.b, n) };
  }
  if (p.k === 'arc') {
    const r = p.sw > 0 ? p.r - o : p.r + o;
    if (!(r > 1e-10 * Math.max(1, p.r))) return null;
    return { ...p, r };
  }
  return null;
}

/** 원래 방향을 지키며 끝점을 옮긴 호 */
function arcBetween(p: ArcPiece, s: Vec2, e: Vec2): ArcPiece {
  const a0 = angleOf(sub(s, p.c));
  const a1 = angleOf(sub(e, p.c));
  let d = a1 - a0;
  // 원래 중심각과 가장 가까운 값
  const cands = [d, d + TAU, d - TAU, d + 2 * TAU, d - 2 * TAU];
  let best = cands[0]!;
  for (const c of cands) if (Math.abs(c - p.sw) < Math.abs(best - p.sw)) best = c;
  d = best;
  return { ...p, a0, sw: d };
}

function withEnds(p: Piece, s: Vec2, e: Vec2): Piece {
  if (p.k === 'line') return { ...p, a: s, b: e };
  if (p.k === 'arc') return arcBetween(p, s, e);
  return p;
}

/** 이어지는 두 간격띄운 조각의 만나는 점(없으면 null → 호로 잇기) */
function joinPoint(P: Piece, Q: Piece, corner: Vec2, o: number): Vec2 | null {
  const pe = pieceAt(P, 1);
  const qs = pieceAt(Q, 0);
  const tol = 1e-9 * Math.max(1, Math.abs(o), Math.abs(pe.x), Math.abs(pe.y));
  if (dist(pe, qs) <= tol) return pe;
  const hits = intersectPieces(P, Q, true, true);
  if (!hits.length) return null;
  const ref = { x: (pe.x + qs.x) / 2, y: (pe.y + qs.y) / 2 };
  let best = hits[0]!.p;
  for (const h of hits) if (dist(h.p, ref) < dist(best, ref)) best = h.p;
  // 너무 멀리서 만나면(거의 맞선 방향) 호로 잇는다
  if (dist(best, corner) > 1e3 * Math.abs(o)) return null;
  return best;
}

/** 꼭짓점이 바깥쪽(간격띄운 두 조각 사이가 벌어지는 쪽)인지: 꺾이는 방향과 간격띄우는 쪽이 반대 */
function outerCorner(P: Piece, Q: Piece, o: number): boolean {
  const c = cross(pieceTangent(P, 1), pieceTangent(Q, 0));
  return Math.abs(c) > 1e-9 && c * o < 0;
}

/** 모따기 틈(OFFSETGAPTYPE 2): 꼭짓점에서 거리 d인 선(이등분선에 수직)까지 두 조각을 접선으로 늘인 점 */
function chamferGap(a: Vec2, ta: Vec2, b: Vec2, tb: Vec2, corner: Vec2, d: number): [Vec2, Vec2] | null {
  const u = norm(add(sub(a, corner), sub(b, corner)));
  if (!(Math.hypot(u.x, u.y) > 0)) return null;
  const da = ta.x * u.x + ta.y * u.y;
  const db = tb.x * u.x + tb.y * u.y;
  if (Math.abs(da) < 1e-12 || Math.abs(db) < 1e-12) return null;
  const t = (d - ((a.x - corner.x) * u.x + (a.y - corner.y) * u.y)) / da;
  const s = ((b.x - corner.x) * u.x + (b.y - corner.y) * u.y - d) / db;
  if (t < -1e-12 || s < -1e-12) return null;
  return [add(a, mul(ta, t)), sub(b, mul(tb, s))];
}

export function offsetPolyline(e: Entity, path: Path, d: number, side: Vec2, gapType: 0 | 1 | 2 = 0): EditResult {
  const o = sideOf(path, side) * d;
  const src = path.pieces;
  const raw: Raw[] = [];
  src.forEach((p, i) => {
    const q = offsetPiece(p, o);
    if (q) raw.push({ p: q, src: i });
  });
  if (!raw.length) return { message: MSG.offsetDistance };
  const n = raw.length;
  const closed = path.closed;
  // 이음: 각 이음 k(raw[k] 끝 – raw[k+1] 시작)
  const joined: Raw[] = [];
  const starts: Vec2[] = raw.map((r) => pieceAt(r.p, 0));
  const ends: Vec2[] = raw.map((r) => pieceAt(r.p, 1));
  const bridges: (Piece | Piece[] | null)[] = new Array(n).fill(null);
  const joins = closed ? n : n - 1;
  for (let k = 0; k < joins; k++) {
    const P = raw[k]!;
    const Q = raw[(k + 1) % n]!;
    // 원래 꼭짓점: Q 원본 세그먼트의 시작
    const corner = pieceAt(src[Q.src]!, 0);
    const pe = pieceAt(P.p, 1);
    const qs = pieceAt(Q.p, 0);
    // OFFSETGAPTYPE 1·2: 바깥 꼭짓점의 틈을 호(꼭짓점 중심, 반지름 = 거리)나 모따기 선으로 잇는다
    if (gapType !== 0 && dist(pe, qs) > 1e-9 * Math.max(1, d) && outerCorner(src[P.src]!, src[Q.src]!, o)) {
      if (gapType === 1) {
        const a0 = angleOf(sub(pe, corner));
        const sw = wrapPi(angleOf(sub(qs, corner)) - a0);
        const br: ArcPiece = { k: 'arc', c: corner, r: dist(pe, corner), a0, sw };
        if (P.p.w1 !== undefined || Q.p.w0 !== undefined) {
          br.w0 = P.p.w1 ?? 0;
          br.w1 = Q.p.w0 ?? 0;
        }
        bridges[k] = br;
        continue;
      }
      const cg = chamferGap(pe, pieceTangent(P.p, 1), qs, pieceTangent(Q.p, 0), corner, d);
      if (cg) {
        const [A, B] = cg;
        const wide = P.p.w1 !== undefined || Q.p.w0 !== undefined ? { w0: P.p.w1 ?? 0, w1: Q.p.w0 ?? 0 } : {};
        // 선은 그대로 늘이고, 호는 접선 방향 선을 덧붙인다
        const list: Piece[] = [];
        if (P.p.k === 'line') ends[k] = A;
        else list.push({ k: 'line', a: pe, b: A, ...wide });
        list.push({ k: 'line', a: A, b: B, ...wide });
        if (Q.p.k === 'line') starts[(k + 1) % n] = B;
        else list.push({ k: 'line', a: B, b: qs, ...wide });
        bridges[k] = list;
        continue;
      }
    }
    const x = joinPoint(P.p, Q.p, corner, o);
    if (x) {
      ends[k] = x;
      starts[(k + 1) % n] = x;
    } else {
      // 꼭짓점 둘레 호
      const a = pieceAt(P.p, 1);
      const b = pieceAt(Q.p, 0);
      const a0 = angleOf(sub(a, corner));
      const sw = wrapPi(angleOf(sub(b, corner)) - a0);
      const br: ArcPiece = { k: 'arc', c: corner, r: dist(a, corner), a0, sw };
      if (P.p.w1 !== undefined || Q.p.w0 !== undefined) {
        br.w0 = P.p.w1 ?? 0;
        br.w1 = Q.p.w0 ?? 0;
      }
      bridges[k] = br;
    }
  }
  for (let k = 0; k < n; k++) {
    const r = raw[k]!;
    joined.push({ p: withEnds(r.p, starts[k]!, ends[k]!), src: r.src });
    const br = bridges[k];
    if (Array.isArray(br)) for (const b of br) joined.push({ p: b, src: -1 });
    else if (br) joined.push({ p: br, src: -1 });
  }
  const pieces = joined.map((r) => r.p).filter((p) => !tinyPiece(p));
  const chains = pruneOffset(pieces, closed, path, d);
  if (!chains.length) return { message: MSG.offsetDistance };
  const add: Entity[] = [];
  for (const ch of chains) {
    const flat = ch.runs.flat();
    const ent = makePolyline(e, flat, ch.closed, path.z);
    if (ent) add.push(ent);
  }
  return add.length ? { add } : { message: MSG.offsetDistance };
}

// ---------------------------------------------------------------------------
// 고리 잘라 내기
// ---------------------------------------------------------------------------

export interface Chain {
  /** 연속으로 이어지는 조각 묶음(묶음 사이는 꺾임) */
  runs: Piece[][];
  closed: boolean;
}

/**
 * 간격띄운 조각들에서 원본까지 거리가 d보다 가까운 부분(자기 교차 고리, 열린 끝 둘레)을 잘라 낸다.
 * 자기 교점·끝 원 교점에서 나눈 "구간"마다 가운데 점의 거리로 남길지 정한다.
 * sagTol: 꺾은선 근사(현)일 때 허용할 거리 부족분.
 */
export function pruneOffset(raw: Piece[], closed: boolean, original: Path, d: number, sagTol = 0): Chain[] {
  const n = raw.length;
  if (!n) return [];
  const size = Math.max(pathSize(original), d);
  const ptol = 1e-9 * Math.max(size, 1);
  const cuts: number[][] = raw.map(() => []);
  // 자기 교차(상자 쓸기로 후보를 줄인다)
  const boxes = raw.map((p) => pieceBox(p));
  const order = raw.map((_, i) => i).sort((a, b) => boxes[a]!.minX - boxes[b]!.minX);
  const pad = ptol * 10;
  for (let oi = 0; oi < n; oi++) {
    const i0 = order[oi]!;
    const bi = boxes[i0]!;
    for (let oj = oi + 1; oj < n; oj++) {
      const j0 = order[oj]!;
      const bj = boxes[j0]!;
      if (bj.minX > bi.maxX + pad) break;
      if (bj.minY > bi.maxY + pad || bj.maxY < bi.minY - pad) continue;
      const i = Math.min(i0, j0);
      const j = Math.max(i0, j0);
      const adj = j === i + 1 || (closed && i === 0 && j === n - 1);
      for (const h of intersectPieces(raw[i]!, raw[j]!)) {
        const ti = i0 === i ? h.t : h.u;
        const tj = i0 === i ? h.u : h.t;
        if (adj) {
          // 공유 끝점은 빼고
          const shared = j === i + 1 ? ti > 1 - 1e-7 && tj < 1e-7 : ti < 1e-7 && tj > 1 - 1e-7;
          if (shared) continue;
        }
        cuts[i]!.push(ti);
        cuts[j]!.push(tj);
      }
    }
  }
  // 열린 원본: 끝점 둘레 원
  if (!closed && original.pieces.length) {
    const s = pieceAt(original.pieces[0]!, 0);
    const e = pieceAt(original.pieces[original.pieces.length - 1]!, 1);
    for (const c of [s, e]) {
      const circ: ArcPiece = { k: 'arc', c, r: d, a0: 0, sw: TAU };
      for (let i = 0; i < n; i++) {
        const b = boxes[i]!;
        if (b.minX > c.x + d + pad || b.maxX < c.x - d - pad || b.minY > c.y + d + pad || b.maxY < c.y - d - pad) continue;
        for (const h of intersectPieces(raw[i]!, circ)) cuts[i]!.push(h.t);
      }
    }
  }
  // 나누기: 교점마다 새 구간
  interface Sub {
    p: Piece;
    region: number;
    len: number;
  }
  const subs: Sub[] = [];
  let region = 0;
  for (let i = 0; i < n; i++) {
    const ts = [...new Set(cuts[i]!.filter((t) => t > 1e-9 && t < 1 - 1e-9))].sort((a, b) => a - b);
    // 조각 끝에 교점이 있으면 다음 조각부터 새 구간
    const atStart = cuts[i]!.some((t) => t <= 1e-9);
    if (atStart && subs.length) region++;
    const bounds = [0, ...ts, 1];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const t0 = bounds[k]!;
      const t1 = bounds[k + 1]!;
      if (k > 0) region++;
      if (t1 - t0 < 1e-12) continue;
      const p = t0 === 0 && t1 === 1 ? raw[i]! : subPiece(raw[i]!, t0, t1);
      const L = pieceLength(p);
      if (L <= ptol) continue;
      subs.push({ p, region, len: L });
    }
    if (cuts[i]!.some((t) => t >= 1 - 1e-9)) region++;
  }
  // 닫힌 경로: 마지막 구간이 첫 구간으로 이어진다(사이에 교점이 없으면)
  const regionOf = (r: number) => (closed && r === region && subs.length && subs[0]!.region === 0 && region > 0 && !cuts[0]!.some((t) => t <= 1e-9) && !cuts[n - 1]!.some((t) => t >= 1 - 1e-9) ? 0 : r);
  const groups = new Map<number, Sub[]>();
  for (const sb of subs) {
    const r = regionOf(sb.region);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(sb);
  }
  const keepRegion = new Map<number, boolean>();
  for (const [r, list] of groups) {
    // 길이로 가운데 조각(닫힌 경로의 이어진 구간은 순서가 끝 → 처음이므로 길이 누적은 순서대로)
    const ordered = r === 0 && closed ? [...list.filter((x) => x.region !== 0), ...list.filter((x) => x.region === 0)] : list;
    const total = ordered.reduce((a, x) => a + x.len, 0);
    let acc = 0;
    let midSub = ordered[0]!;
    let midT = 0.5;
    for (const x of ordered) {
      if (acc + x.len >= total / 2) {
        midSub = x;
        midT = x.len > 0 ? (total / 2 - acc) / x.len : 0.5;
        break;
      }
      acc += x.len;
    }
    const m = pieceAt(midSub.p, Math.min(1, Math.max(0, midT)));
    const dd = pathNearest(original, m).d;
    keepRegion.set(r, dd >= d * (1 - 1e-6) - ptol - sagTol);
  }
  const keepOf = (sb: Sub) => keepRegion.get(regionOf(sb.region)) ?? false;
  // 이어진 묶음(run)
  const runs: Piece[][] = [];
  let cur: Piece[] = [];
  for (const sb of subs) {
    if (keepOf(sb)) {
      if (cur.length && dist(pieceAt(cur[cur.length - 1]!, 1), pieceAt(sb.p, 0)) > ptol * 10) {
        runs.push(cur);
        cur = [];
      }
      cur.push(sb.p);
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  // 닫힌 경로: 마지막 묶음이 첫 묶음으로 이어지면 합친다
  if (closed && runs.length > 1 && subs.length && keepOf(subs[0]!) && keepOf(subs[subs.length - 1]!)) {
    const last = runs[runs.length - 1]!;
    const first = runs[0]!;
    if (dist(pieceAt(last[last.length - 1]!, 1), pieceAt(first[0]!, 0)) <= ptol * 10) {
      runs[0] = [...last, ...first];
      runs.pop();
    }
  }
  // 묶음 잇기(끝 = 다음 시작)
  const used = new Array(runs.length).fill(false);
  const chains: Chain[] = [];
  const close = (a: Vec2, b: Vec2) => dist(a, b) <= Math.max(ptol * 1e3, size * 1e-9);
  for (let i = 0; i < runs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const ch: Piece[][] = [runs[i]!];
    for (;;) {
      const lastRun = ch[ch.length - 1]!;
      const end = pieceAt(lastRun[lastRun.length - 1]!, 1);
      const start = pieceAt(ch[0]![0]!, 0);
      if (ch.length > 1 || runs.length === 1) if (close(end, start)) break;
      let found = -1;
      for (let k = 0; k < runs.length; k++) {
        const j = (i + 1 + k) % runs.length;
        if (used[j]) continue;
        if (close(pieceAt(runs[j]![0]!, 0), end)) {
          found = j;
          break;
        }
      }
      if (found < 0) break;
      used[found] = true;
      ch.push(runs[found]!);
    }
    const first = pieceAt(ch[0]![0]!, 0);
    const lr = ch[ch.length - 1]!;
    const last = pieceAt(lr[lr.length - 1]!, 1);
    chains.push({ runs: ch, closed: closed && close(first, last) });
  }
  return chains;
}

// ---------------------------------------------------------------------------
// 타원·스플라인: 점을 지나는 3차 스플라인
// ---------------------------------------------------------------------------

function offsetPoints(path: Path, o: number, tol: number): Piece[] {
  // 원본을 촘촘히 나눈 점마다 법선 방향으로
  const raw: Piece[] = [];
  let prev: Vec2 | null = null;
  path.pieces.forEach((pc) => {
    const n = Math.max(16, Math.min(2048, Math.ceil(pieceLength(pc) / Math.max(tol, 1e-12))));
    const steps = Math.min(n, 2048);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = pieceAt(pc, t);
      const q = add(p, mul(rot90(pieceTangent(pc, t)), o));
      if (prev && dist(prev, q) > 1e-14) raw.push({ k: 'line', a: prev, b: q } as LinePiece);
      prev = q;
    }
  });
  return raw;
}

function runPoints(run: Piece[]): Vec2[] {
  const pts: Vec2[] = [pieceAt(run[0]!, 0)];
  for (const p of run) pts.push(pieceAt(p, 1));
  return pts;
}

/** 호 길이로 고르게 maxN개(닫힌 고리는 이음매도 같은 간격) */
function thin(pts: Vec2[], maxN: number, closed = false): Vec2[] {
  if (pts.length <= maxN) return pts;
  const ring = closed ? [...pts, pts[0]!] : pts;
  const acc: number[] = [0];
  for (let i = 1; i < ring.length; i++) acc.push(acc[i - 1]! + dist(ring[i]!, ring[i - 1]!));
  const total = acc[acc.length - 1]!;
  const count = closed ? maxN : maxN - 1;
  const out: Vec2[] = [ring[0]!];
  let j = 0;
  for (let k = 1; k < (closed ? maxN : maxN - 1); k++) {
    const L = (total * k) / count;
    while (j + 1 < acc.length - 1 && acc[j + 1]! < L) j++;
    const seg = acc[j + 1]! - acc[j]!;
    const t = seg > 0 ? (L - acc[j]!) / seg : 0;
    out.push({ x: ring[j]!.x + (ring[j + 1]!.x - ring[j]!.x) * t, y: ring[j]!.y + (ring[j + 1]!.y - ring[j]!.y) * t });
  }
  if (!closed) out.push(ring[ring.length - 1]!);
  return out;
}

export function offsetGeneric(e: Entity, path: Path, d: number, side: Vec2, maxFit = 240): EditResult {
  const o = sideOf(path, side) * d;
  const size = pathSize(path);
  const errTol = Math.max(size, d) * 1e-5;
  let tol = Math.max(size, d) / 400;
  let best: { ents: Entity[]; err: number } | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = offsetPoints(path, o, tol);
    const chains = pruneOffset(raw, path.closed, path, d, Math.max(d * 1e-4, tol * 0.05));
    if (!chains.length) return { message: MSG.offsetDistance };
    const ents: Entity[] = [];
    let err = 0;
    for (const ch of chains) {
      const parts: Nurbs[] = [];
      const single = ch.runs.length === 1 && ch.closed;
      for (const run of ch.runs) {
        let pts = runPoints(run);
        if (single) {
          pts = pts.slice(0, -1);
          pts = thin(pts, maxFit, true);
          const n = periodicInterpolate(pts.map((q) => ({ x: q.x, y: q.y, z: path.z })));
          if (n) parts.push(n);
        } else {
          pts = thin(pts, maxFit);
          const n = interpolate(pts.map((q) => ({ x: q.x, y: q.y, z: path.z })), 3);
          if (n) parts.push(n);
        }
      }
      if (!parts.length) continue;
      const nb = parts.length === 1 ? parts[0]! : joinNurbs(parts);
      if (!nb) continue;
      // 오차: 결과 곡선 위 점에서 원본까지 거리
      const U = nb.knots;
      const a = U[nb.degree]!;
      const b = U[nb.ctrl.length]!;
      for (let i = 0; i <= 200; i++) {
        const q = nurbsPoint(nb, a + ((b - a) * (i + 0.5)) / 201);
        const dd = pathNearest(path, q).d;
        err = Math.max(err, Math.abs(dd - d));
      }
      const sp = makeSpline(e, nb, ch.closed);
      if (single) sp.flags |= 2;
      ents.push(sp);
    }
    if (!best || err < best.err) best = { ents, err };
    if (err <= errTol) break;
    tol /= 3;
    maxFit = Math.min(maxFit * 2, 960);
  }
  if (!best || !best.ents.length) return { message: MSG.offsetDistance };
  return { add: best.ents };
}

/** 내부: 조각 하나를 거리 o만큼(왼쪽 +) — 모깎기에서 씀 */
export function offsetOne(p: Piece, o: number): Piece | null {
  return offsetPiece(p, o);
}

