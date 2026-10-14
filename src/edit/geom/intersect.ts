/**
 * 조각 사이 교점(평면도). 선·원호끼리와 선·타원은 해석적으로, 나머지(타원·NURBS)는
 * 꺾은선 교점을 뉴턴법으로 다듬는다.
 */
import type { Vec2 } from '../../core/model';
import { type ArcPiece, type EllPiece, type LinePiece, type Piece, flattenPiece, pieceAt, pieceBox, pieceD1, pieceSize } from './curve';
import { TAU, ccwFrom, cross, dist, dot, emptyBox, growBox, solve2, sub } from './math';

export interface Hit {
  /** 첫 조각 매개변수 */
  t: number;
  /** 둘째 조각 매개변수 */
  u: number;
  p: Vec2;
}

/** 각도 φ의 호 매개변수(정의역 앞이면 아주 작은 음수까지) */
export function arcParam(p: ArcPiece, phi: number): number {
  const sw = Math.abs(p.sw);
  if (!(sw > 0)) return 0;
  const d = p.sw > 0 ? ccwFrom(p.a0, phi) : ccwFrom(phi, p.a0);
  if (d > TAU - 1e-10) return (d - TAU) / sw;
  return d / sw;
}

export function ellParam(p: EllPiece, th: number): number {
  const dt = Math.abs(p.dt);
  if (!(dt > 0)) return 0;
  const d = p.dt > 0 ? ccwFrom(p.t0, th) : ccwFrom(th, p.t0);
  if (d > TAU - 1e-10) return (d - TAU) / dt;
  return d / dt;
}

function inDomain(p: Piece, t: number, ext: boolean, tolT: number): boolean {
  if (p.k === 'line') {
    if (ext) return true;
    if (!p.inf0 && t < -tolT) return false;
    if (!p.inf1 && t > 1 + tolT) return false;
    return true;
  }
  if (ext && (p.k === 'arc' || p.k === 'ell')) return true;
  return t >= -tolT && t <= 1 + tolT;
}

function tolT(p: Piece): number {
  if (p.k === 'line') {
    const l = dist(p.a, p.b);
    return l > 0 ? (1e-9 * Math.max(1, l, Math.abs(p.a.x), Math.abs(p.a.y))) / l : 0;
  }
  return 1e-9;
}

// ---------------------------------------------------------------------------
// 해석적
// ---------------------------------------------------------------------------

function lineLine(P: LinePiece, Q: LinePiece): { t: number; u: number }[] {
  const r = sub(P.b, P.a);
  const s = sub(Q.b, Q.a);
  const den = cross(r, s);
  const lr = Math.hypot(r.x, r.y);
  const ls = Math.hypot(s.x, s.y);
  if (Math.abs(den) <= 1e-12 * lr * ls) return [];
  const qp = sub(Q.a, P.a);
  return [{ t: cross(qp, s) / den, u: cross(qp, r) / den }];
}

/** 선(무한)과 원의 교점: 선 매개변수와 각도 */
function lineCircle(P: LinePiece, c: Vec2, R: number): { t: number; phi: number }[] {
  const d = sub(P.b, P.a);
  const f = sub(P.a, c);
  const A = dot(d, d);
  if (!(A > 0)) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - R * R;
  let disc = B * B - 4 * A * C;
  const scale = Math.max(B * B, Math.abs(4 * A * C), 1e-300);
  if (disc < 0) {
    if (disc > -1e-10 * scale) disc = 0;
    else return [];
  }
  const out: { t: number; phi: number }[] = [];
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  for (const t of ts) {
    const x = P.a.x + d.x * t - c.x;
    const y = P.a.y + d.y * t - c.y;
    out.push({ t, phi: Math.atan2(y, x) });
  }
  return out;
}

function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist(c1, c2);
  if (!(d > 1e-15 * Math.max(1, r1, r2))) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  let h2 = r1 * r1 - a * a;
  const scale = Math.max(r1 * r1, 1e-300);
  if (h2 < 0) {
    if (h2 > -1e-10 * scale) h2 = 0;
    else return [];
  }
  const h = Math.sqrt(h2);
  const ux = (c2.x - c1.x) / d;
  const uy = (c2.y - c1.y) / d;
  const px = c1.x + ux * a;
  const py = c1.y + uy * a;
  if (h === 0) return [{ x: px, y: py }];
  return [
    { x: px - uy * h, y: py + ux * h },
    { x: px + uy * h, y: py - ux * h },
  ];
}

function lineEll(P: LinePiece, E: EllPiece): { t: number; th: number }[] {
  // 타원 → 단위원 공간
  const det = E.u.x * E.v.y - E.u.y * E.v.x;
  if (Math.abs(det) < 1e-300) return [];
  const inv = (x: number, y: number) => ({ x: (E.v.y * x - E.v.x * y) / det, y: (-E.u.y * x + E.u.x * y) / det });
  const a = inv(P.a.x - E.c.x, P.a.y - E.c.y);
  const b = inv(P.b.x - E.c.x, P.b.y - E.c.y);
  const L: LinePiece = { k: 'line', a, b };
  return lineCircle(L, { x: 0, y: 0 }, 1).map((h) => ({ t: h.t, th: h.phi }));
}

// ---------------------------------------------------------------------------
// 수치
// ---------------------------------------------------------------------------

/** 연장한 운반 조각(호 → 원, 타원호 → 타원, 무한선 → 상자 안의 선분)과 원래 매개변수로 되돌리는 함수 */
function carrier(p: Piece, ext: boolean, clip: { minX: number; minY: number; maxX: number; maxY: number }): { c: Piece; back: (t: number) => number } {
  if (p.k === 'arc' && ext) {
    const sgn = p.sw >= 0 ? 1 : -1;
    const sw = Math.abs(p.sw) || 1;
    return { c: { ...p, sw: sgn * TAU }, back: (t) => (t * TAU) / sw };
  }
  if (p.k === 'ell' && ext) {
    const sgn = p.dt >= 0 ? 1 : -1;
    const dt = Math.abs(p.dt) || 1;
    return { c: { ...p, dt: sgn * TAU }, back: (t) => (t * TAU) / dt };
  }
  if (p.k === 'line' && (ext || p.inf0 || p.inf1)) {
    // 상자에 맞춰 자른다
    const d = sub(p.b, p.a);
    const l2 = dot(d, d) || 1;
    const corners = [
      { x: clip.minX, y: clip.minY },
      { x: clip.maxX, y: clip.minY },
      { x: clip.maxX, y: clip.maxY },
      { x: clip.minX, y: clip.maxY },
    ];
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of corners) {
      const t = ((q.x - p.a.x) * d.x + (q.y - p.a.y) * d.y) / l2;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    const pad = (hi - lo) * 0.1 + 1;
    lo -= pad;
    hi += pad;
    if (!ext) {
      if (!p.inf0) lo = Math.max(lo, 0);
      if (!p.inf1) hi = Math.min(hi, 1);
    }
    const a = pieceAt(p, lo);
    const b = pieceAt(p, hi);
    return { c: { k: 'line', a, b }, back: (t) => lo + (hi - lo) * t };
  }
  return { c: p, back: (t) => t };
}

function segHits(A: { t: number; x: number; y: number }[], B: { t: number; x: number; y: number }[]): { t: number; u: number }[] {
  const out: { t: number; u: number }[] = [];
  // 상자 미리 거르기
  const boxes = (S: typeof A) => {
    const r: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i]!;
      const b = S[i + 1]!;
      r.push({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });
    }
    return r;
  };
  const ba = boxes(A);
  const bb = boxes(B);
  for (let i = 0; i < ba.length; i++) {
    const x = ba[i]!;
    const a0 = A[i]!;
    const a1 = A[i + 1]!;
    const pad = Math.max(x.maxX - x.minX, x.maxY - x.minY) * 1e-6 + 1e-12;
    for (let j = 0; j < bb.length; j++) {
      const y = bb[j]!;
      if (y.minX > x.maxX + pad || y.maxX < x.minX - pad || y.minY > x.maxY + pad || y.maxY < x.minY - pad) continue;
      const b0 = B[j]!;
      const b1 = B[j + 1]!;
      const r = { x: a1.x - a0.x, y: a1.y - a0.y };
      const s = { x: b1.x - b0.x, y: b1.y - b0.y };
      const den = cross(r, s);
      if (Math.abs(den) < 1e-300) continue;
      const qp = { x: b0.x - a0.x, y: b0.y - a0.y };
      const tt = cross(qp, s) / den;
      const uu = cross(qp, r) / den;
      const e = 1e-6;
      if (tt < -e || tt > 1 + e || uu < -e || uu > 1 + e) continue;
      out.push({ t: a0.t + (a1.t - a0.t) * tt, u: b0.t + (b1.t - b0.t) * uu });
    }
  }
  return out;
}

function newton(P: Piece, Q: Piece, t0: number, u0: number): { t: number; u: number; ok: boolean } {
  let t = t0;
  let u = u0;
  const scale = Math.max(pieceSize(P), pieceSize(Q));
  for (let it = 0; it < 40; it++) {
    const p = pieceAt(P, t);
    const q = pieceAt(Q, u);
    const fx = p.x - q.x;
    const fy = p.y - q.y;
    if (Math.hypot(fx, fy) <= 1e-13 * Math.max(1, scale, Math.abs(p.x), Math.abs(p.y))) return { t, u, ok: true };
    const dp = pieceD1(P, t);
    const dq = pieceD1(Q, u);
    const s = solve2(dp.x, -dq.x, dp.y, -dq.y, -fx, -fy);
    if (!s) break;
    t += s[0];
    u += s[1];
    t = Math.min(1.5, Math.max(-0.5, t));
    u = Math.min(1.5, Math.max(-0.5, u));
  }
  const p = pieceAt(P, t);
  const q = pieceAt(Q, u);
  return { t, u, ok: dist(p, q) <= 1e-7 * Math.max(1, scale) };
}

function numeric(P: Piece, Q: Piece, extP: boolean, extQ: boolean): { t: number; u: number }[] {
  const bp = pieceBox(P.k === 'line' ? { ...P, inf0: false, inf1: false } : P);
  const bq = pieceBox(Q.k === 'line' ? { ...Q, inf0: false, inf1: false } : Q);
  const all = emptyBox();
  growBox(all, Math.min(bp.minX, bq.minX), Math.min(bp.minY, bq.minY));
  growBox(all, Math.max(bp.maxX, bq.maxX), Math.max(bp.maxY, bq.maxY));
  // 무한선은 상대 조각 범위로 자른다
  const cp = carrier(P, extP, P.k === 'line' ? bq : all);
  const cq = carrier(Q, extQ, Q.k === 'line' ? bp : all);
  const tol = Math.max(pieceSize(cp.c), pieceSize(cq.c)) * 2e-4;
  const A = flattenPiece(cp.c, tol);
  const B = flattenPiece(cq.c, tol);
  const raw = segHits(A, B);
  const out: { t: number; u: number }[] = [];
  for (const r of raw) {
    const n = newton(cp.c, cq.c, r.t, r.u);
    const t = n.ok ? n.t : r.t;
    const u = n.ok ? n.u : r.u;
    out.push({ t: cp.back(t), u: cq.back(u) });
  }
  return out;
}

// ---------------------------------------------------------------------------

/** 두 조각의 교점. ext는 연장한 곡선(선 → 무한선, 호 → 원, 타원호 → 타원)에서 찾는다 */
export function intersectPieces(P: Piece, Q: Piece, extP = false, extQ = false): Hit[] {
  let raw: { t: number; u: number }[] = [];
  if (P.k === 'line' && Q.k === 'line') raw = lineLine(P, Q);
  else if (P.k === 'line' && Q.k === 'arc') raw = lineCircle(P, Q.c, Q.r).map((h) => ({ t: h.t, u: arcParamExt(Q, h.phi, extQ) }));
  else if (P.k === 'arc' && Q.k === 'line') raw = lineCircle(Q, P.c, P.r).map((h) => ({ t: arcParamExt(P, h.phi, extP), u: h.t }));
  else if (P.k === 'arc' && Q.k === 'arc')
    raw = circleCircle(P.c, P.r, Q.c, Q.r).map((q) => ({ t: arcParamExt(P, Math.atan2(q.y - P.c.y, q.x - P.c.x), extP), u: arcParamExt(Q, Math.atan2(q.y - Q.c.y, q.x - Q.c.x), extQ) }));
  else if (P.k === 'line' && Q.k === 'ell') raw = lineEll(P, Q).map((h) => ({ t: h.t, u: ellParamExt(Q, h.th, extQ) }));
  else if (P.k === 'ell' && Q.k === 'line') raw = lineEll(Q, P).map((h) => ({ t: ellParamExt(P, h.th, extP), u: h.t }));
  else raw = numeric(P, Q, extP, extQ);
  const tp = tolT(P);
  const tq = tolT(Q);
  const out: Hit[] = [];
  const scale = Math.max(pieceSize(P.k === 'line' ? { ...P, inf0: false, inf1: false } : P), pieceSize(Q.k === 'line' ? { ...Q, inf0: false, inf1: false } : Q));
  for (const r of raw) {
    if (!inDomain(P, r.t, extP, tp) || !inDomain(Q, r.u, extQ, tq)) continue;
    const t = clampT(P, r.t, extP);
    const u = clampT(Q, r.u, extQ);
    const p = pieceAt(P, t);
    if (out.some((h) => dist(h.p, p) <= 1e-9 * Math.max(1, scale, Math.abs(p.x), Math.abs(p.y)))) continue;
    out.push({ t, u, p });
  }
  return out;
}

function clampT(p: Piece, t: number, ext: boolean): number {
  if (ext) return t;
  if (p.k === 'line') {
    if (!p.inf0 && t < 0) return 0;
    if (!p.inf1 && t > 1) return 1;
    return t;
  }
  return Math.min(1, Math.max(0, t));
}

function arcParamExt(p: ArcPiece, phi: number, ext: boolean): number {
  if (!ext) return arcParam(p, phi);
  const sw = Math.abs(p.sw) || 1;
  const d = p.sw > 0 ? ccwFrom(p.a0, phi) : ccwFrom(phi, p.a0);
  return d / sw;
}

function ellParamExt(p: EllPiece, th: number, ext: boolean): number {
  if (!ext) return ellParam(p, th);
  const dt = Math.abs(p.dt) || 1;
  const d = p.dt > 0 ? ccwFrom(p.t0, th) : ccwFrom(th, p.t0);
  return d / dt;
}

/** 조각 목록끼리 모든 교점(점만) */
export function intersectAll(A: readonly Piece[], B: readonly Piece[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of A)
    for (const q of B)
      for (const h of intersectPieces(p, q)) {
        if (!out.some((o) => dist(o, h.p) <= 1e-9 * Math.max(1, Math.abs(h.p.x), Math.abs(h.p.y)))) out.push(h.p);
      }
  return out;
}
