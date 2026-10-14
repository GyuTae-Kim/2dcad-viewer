/**
 * 평면도(WCS XY) 곡선 조각과 경로.
 * 조각의 매개변수 t는 [0, 1]이다(선: a→b, 호: a0 + t·sw, 타원호: t0 + t·dt, NURBS: u0 + t·(u1 − u0)).
 * 경로의 전역 매개변수 s는 조각 i에서 i + t다.
 */
import type { Vec2 } from '../../core/model';
import { type Box, TAU, ccwFrom, dist, emptyBox, growBox } from './math';
import { type Nurbs, nurbsDeriv, nurbsPoint, sampleNurbs } from './nurbs';

export interface PieceExtra {
  /** 폴리선 폭(시작·끝) */
  w0?: number;
  w1?: number;
  /** 3D 선분의 양 끝 Z */
  za?: number;
  zb?: number;
}

export interface LinePiece extends PieceExtra {
  k: 'line';
  a: Vec2;
  b: Vec2;
  /** 무한(XLINE·RAY): a 쪽·b 쪽으로 끝이 없음 */
  inf0?: boolean;
  inf1?: boolean;
}

export interface ArcPiece extends PieceExtra {
  k: 'arc';
  c: Vec2;
  r: number;
  a0: number;
  /** 부호 있는 중심각(+ 반시계) */
  sw: number;
}

export interface EllPiece extends PieceExtra {
  k: 'ell';
  c: Vec2;
  /** 켤레 반지름 벡터(θ = 0, θ = π/2의 점) */
  u: Vec2;
  v: Vec2;
  t0: number;
  dt: number;
}

export interface NurbsPiece extends PieceExtra {
  k: 'nurbs';
  n: Nurbs;
  u0: number;
  u1: number;
}

export type Piece = LinePiece | ArcPiece | EllPiece | NurbsPiece;

export interface Path {
  pieces: Piece[];
  closed: boolean;
  /** 평면 객체의 WCS Z(고도) */
  z: number;
}

// ---------------------------------------------------------------------------
// 조각
// ---------------------------------------------------------------------------

export function pieceAt(p: Piece, t: number): Vec2 {
  switch (p.k) {
    case 'line':
      return { x: p.a.x + (p.b.x - p.a.x) * t, y: p.a.y + (p.b.y - p.a.y) * t };
    case 'arc': {
      const a = p.a0 + p.sw * t;
      return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) };
    }
    case 'ell': {
      const th = p.t0 + p.dt * t;
      const c = Math.cos(th);
      const s = Math.sin(th);
      return { x: p.c.x + p.u.x * c + p.v.x * s, y: p.c.y + p.u.y * c + p.v.y * s };
    }
    case 'nurbs': {
      const q = nurbsPoint(p.n, p.u0 + (p.u1 - p.u0) * t);
      return { x: q.x, y: q.y };
    }
  }
}

/** dP/dt */
export function pieceD1(p: Piece, t: number): Vec2 {
  switch (p.k) {
    case 'line':
      return { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
    case 'arc': {
      const a = p.a0 + p.sw * t;
      return { x: -p.r * Math.sin(a) * p.sw, y: p.r * Math.cos(a) * p.sw };
    }
    case 'ell': {
      const th = p.t0 + p.dt * t;
      const c = Math.cos(th);
      const s = Math.sin(th);
      return { x: (-p.u.x * s + p.v.x * c) * p.dt, y: (-p.u.y * s + p.v.y * c) * p.dt };
    }
    case 'nurbs': {
      const d = nurbsDeriv(p.n, p.u0 + (p.u1 - p.u0) * t);
      const k = p.u1 - p.u0;
      return { x: d.x * k, y: d.y * k };
    }
  }
}

/** 단위 접선(진행 방향) */
export function pieceTangent(p: Piece, t: number): Vec2 {
  let d = pieceD1(p, t);
  let l = Math.hypot(d.x, d.y);
  if (!(l > 1e-300)) {
    // 끝에서 도함수가 0이면 조금 안쪽
    const tt = t < 0.5 ? t + 1e-6 : t - 1e-6;
    d = pieceD1(p, tt);
    l = Math.hypot(d.x, d.y);
    if (!(l > 1e-300)) return { x: 1, y: 0 };
  }
  return { x: d.x / l, y: d.y / l };
}

const GL5 = [
  [-0.906179845938664, 0.236926885056189],
  [-0.538469310105683, 0.478628670499366],
  [0, 0.568888888888889],
  [0.538469310105683, 0.478628670499366],
  [0.906179845938664, 0.236926885056189],
] as const;

function gaussLen(p: Piece, t0: number, t1: number, m: number): number {
  let L = 0;
  const h = (t1 - t0) / m;
  for (let i = 0; i < m; i++) {
    const a = t0 + h * i;
    const mid = a + h / 2;
    for (const [x, w] of GL5) {
      const d = pieceD1(p, mid + (x * h) / 2);
      L += w * Math.hypot(d.x, d.y) * (h / 2);
    }
  }
  return Math.abs(L);
}

/** t0 → t1 길이(t0 > t1이면 양수 그대로) */
export function pieceLength(p: Piece, t0 = 0, t1 = 1): number {
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  switch (p.k) {
    case 'line':
      return dist(p.a, p.b) * (hi - lo);
    case 'arc':
      return p.r * Math.abs(p.sw) * (hi - lo);
    case 'ell':
      return gaussLen(p, lo, hi, Math.max(2, Math.ceil((Math.abs(p.dt) * (hi - lo)) / (Math.PI / 16))));
    case 'nurbs': {
      // 매듭 구간마다 나눠 적분
      const U = p.n.knots;
      const ua = p.u0 + (p.u1 - p.u0) * lo;
      const ub = p.u0 + (p.u1 - p.u0) * hi;
      const a = Math.min(ua, ub);
      const b = Math.max(ua, ub);
      const cuts = [a, ...U.filter((k) => k > a && k < b), b];
      let L = 0;
      for (let i = 0; i + 1 < cuts.length; i++) {
        const x0 = cuts[i]!;
        const x1 = cuts[i + 1]!;
        if (!(x1 > x0)) continue;
        const tt0 = (x0 - p.u0) / (p.u1 - p.u0);
        const tt1 = (x1 - p.u0) / (p.u1 - p.u0);
        L += gaussLen(p, Math.min(tt0, tt1), Math.max(tt0, tt1), 6);
      }
      return L;
    }
  }
}

/** 시작(t = 0)에서 길이 L인 곳의 t(L이 전체보다 길면 1을 넘긴다 — 선·호만) */
export function pieceTAtLength(p: Piece, L: number): number {
  if (p.k === 'line') {
    const l = dist(p.a, p.b);
    return l > 0 ? L / l : 0;
  }
  if (p.k === 'arc') {
    const l = p.r * Math.abs(p.sw);
    return l > 0 ? L / l : 0;
  }
  const total = pieceLength(p);
  if (!(total > 0)) return 0;
  if (L >= total) return 1;
  if (L <= 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (pieceLength(p, 0, m) < L) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

export interface FlatPt {
  t: number;
  x: number;
  y: number;
}

/** 조각을 꺾은선으로(매개변수 포함) */
export function flattenPiece(p: Piece, tol: number): FlatPt[] {
  const out: FlatPt[] = [];
  switch (p.k) {
    case 'line':
      out.push({ t: 0, ...p.a }, { t: 1, ...p.b });
      return out;
    case 'arc':
    case 'ell': {
      const r = p.k === 'arc' ? p.r : Math.max(Math.hypot(p.u.x, p.u.y), Math.hypot(p.v.x, p.v.y));
      const sweep = Math.abs(p.k === 'arc' ? p.sw : p.dt);
      let step = tol >= r ? Math.PI / 4 : 2 * Math.acos(1 - tol / r);
      if (!(step > 0)) step = Math.PI / 64;
      const n = Math.min(4096, Math.max(Math.ceil(sweep / step), Math.ceil((sweep / TAU) * 16), 1));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        out.push({ t, ...pieceAt(p, t) });
      }
      return out;
    }
    case 'nurbs': {
      const a = Math.min(p.u0, p.u1);
      const b = Math.max(p.u0, p.u1);
      const s = sampleNurbs(p.n, tol, a, b);
      for (const q of s) out.push({ t: (q.u - p.u0) / (p.u1 - p.u0), x: q.x, y: q.y });
      if (p.u0 > p.u1) out.reverse();
      return out;
    }
  }
}

export function pieceBox(p: Piece, b: Box = emptyBox()): Box {
  if (p.k === 'line') {
    growBox(b, p.a.x, p.a.y);
    growBox(b, p.b.x, p.b.y);
    return b;
  }
  if (p.k === 'arc') {
    const s = pieceAt(p, 0);
    const e = pieceAt(p, 1);
    growBox(b, s.x, s.y);
    growBox(b, e.x, e.y);
    const lo = p.sw >= 0 ? p.a0 : p.a0 + p.sw;
    const sw = Math.abs(p.sw);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      if (sw >= TAU - 1e-12 || ccwFrom(lo, a) <= sw) growBox(b, p.c.x + p.r * Math.cos(a), p.c.y + p.r * Math.sin(a));
    }
    return b;
  }
  for (const q of flattenPiece(p, pieceSize(p) * 1e-4)) growBox(b, q.x, q.y);
  return b;
}

/** 조각 크기(공차 계산용) */
export function pieceSize(p: Piece): number {
  switch (p.k) {
    case 'line':
      return Math.max(dist(p.a, p.b), 1e-9);
    case 'arc':
      return Math.max(p.r, 1e-9);
    case 'ell':
      return Math.max(Math.hypot(p.u.x, p.u.y), Math.hypot(p.v.x, p.v.y), 1e-9);
    case 'nurbs': {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const q of p.n.ctrl) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x);
        maxY = Math.max(maxY, q.y);
      }
      return Math.max(Math.hypot(maxX - minX, maxY - minY), 1e-9);
    }
  }
}

/** 조각의 [t0, t1] 부분(t0 > t1이면 거꾸로). 폭·Z는 비율로 잇는다 */
export function subPiece(p: Piece, t0: number, t1: number): Piece {
  const extra: PieceExtra = {};
  if (p.w0 !== undefined || p.w1 !== undefined) {
    const w0 = p.w0 ?? 0;
    const w1 = p.w1 ?? w0;
    extra.w0 = w0 + (w1 - w0) * t0;
    extra.w1 = w0 + (w1 - w0) * t1;
  }
  if (p.za !== undefined || p.zb !== undefined) {
    const za = p.za ?? 0;
    const zb = p.zb ?? za;
    extra.za = za + (zb - za) * t0;
    extra.zb = za + (zb - za) * t1;
  }
  switch (p.k) {
    case 'line':
      return { k: 'line', a: pieceAt(p, t0), b: pieceAt(p, t1), ...extra };
    case 'arc':
      return { k: 'arc', c: { ...p.c }, r: p.r, a0: p.a0 + p.sw * t0, sw: p.sw * (t1 - t0), ...extra };
    case 'ell':
      return { k: 'ell', c: { ...p.c }, u: { ...p.u }, v: { ...p.v }, t0: p.t0 + p.dt * t0, dt: p.dt * (t1 - t0), ...extra };
    case 'nurbs':
      return { k: 'nurbs', n: p.n, u0: p.u0 + (p.u1 - p.u0) * t0, u1: p.u0 + (p.u1 - p.u0) * t1, ...extra };
  }
}

export function reversePiece(p: Piece): Piece {
  return subPiece(p, 1, 0);
}

export interface Nearest {
  t: number;
  p: Vec2;
  d: number;
}

function golden(f: (t: number) => number, lo: number, hi: number, iters = 60): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

/**
 * q에 가장 가까운 점. clamp가 거짓이면 연장한 곡선(선 → 무한선, 호 → 원, 타원호 → 타원)에서 찾는다
 * (호·타원호는 정의역 [0, 1]에 가까운 쪽 매개변수: 음수 또는 1보다 큼).
 */
export function pieceNearest(p: Piece, q: Vec2, clamp = true): Nearest {
  switch (p.k) {
    case 'line': {
      const dx = p.b.x - p.a.x;
      const dy = p.b.y - p.a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((q.x - p.a.x) * dx + (q.y - p.a.y) * dy) / l2 : 0;
      if (clamp) {
        if (!p.inf0 && t < 0) t = 0;
        if (!p.inf1 && t > 1) t = 1;
      }
      const pt = pieceAt(p, t);
      return { t, p: pt, d: dist(pt, q) };
    }
    case 'arc': {
      const phi = Math.atan2(q.y - p.c.y, q.x - p.c.x);
      const sw = Math.abs(p.sw);
      if (!(sw > 0)) return { t: 0, p: pieceAt(p, 0), d: dist(pieceAt(p, 0), q) };
      const dd = p.sw > 0 ? ccwFrom(p.a0, phi) : ccwFrom(phi, p.a0);
      let t: number;
      if (dd <= sw + 1e-15) t = dd / sw;
      else if (clamp) {
        const p0 = pieceAt(p, 0);
        const p1 = pieceAt(p, 1);
        t = dist(p0, q) <= dist(p1, q) ? 0 : 1;
      } else t = dd - sw < TAU - dd ? dd / sw : -(TAU - dd) / sw;
      const pt = pieceAt(p, t);
      return { t, p: pt, d: dist(pt, q) };
    }
    case 'ell': {
      // 타원 전체 또는 정의역에서 표본 → 황금 분할
      const full = !clamp;
      const span = full ? TAU / Math.abs(p.dt || 1) : 1;
      const N = 128;
      const lo = full ? -span / 2 + 0.5 : 0;
      let best = lo;
      let bd = Infinity;
      for (let i = 0; i <= N; i++) {
        const t = lo + (span * i) / N;
        const d = dist(pieceAt(p, t), q);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      const h = span / N;
      let a = best - h;
      let b = best + h;
      // 완전한 타원은 이음매를 넘어 찾는다(주기)
      const periodic = full || Math.abs(p.dt) >= TAU - 1e-9;
      if (!periodic) {
        a = Math.max(0, a);
        b = Math.min(1, b);
      }
      let t = golden((tt) => dist(pieceAt(p, tt), q), a, b);
      if (periodic && !full) t = ((t % 1) + 1) % 1;
      const pt = pieceAt(p, t);
      return { t, p: pt, d: dist(pt, q) };
    }
    case 'nurbs': {
      const s = flattenPiece(p, pieceSize(p) * 1e-3);
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < s.length; i++) {
        const d = Math.hypot(s[i]!.x - q.x, s[i]!.y - q.y);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const a = s[Math.max(0, bi - 1)]!.t;
      const b = s[Math.min(s.length - 1, bi + 1)]!.t;
      const t = golden((tt) => dist(pieceAt(p, tt), q), Math.min(a, b), Math.max(a, b));
      const pt = pieceAt(p, t);
      return { t, p: pt, d: dist(pt, q) };
    }
  }
}

// ---------------------------------------------------------------------------
// 경로
// ---------------------------------------------------------------------------

export function pathStart(path: Path): Vec2 {
  return pieceAt(path.pieces[0]!, 0);
}

export function pathEnd(path: Path): Vec2 {
  return pieceAt(path.pieces[path.pieces.length - 1]!, 1);
}

export function pathAt(path: Path, s: number): Vec2 {
  const n = path.pieces.length;
  let i = Math.floor(s);
  if (i >= n) i = n - 1;
  if (i < 0) i = 0;
  return pieceAt(path.pieces[i]!, s - i);
}

export function pathTangent(path: Path, s: number): Vec2 {
  const n = path.pieces.length;
  let i = Math.floor(s);
  if (i >= n) i = n - 1;
  if (i < 0) i = 0;
  return pieceTangent(path.pieces[i]!, s - i);
}

export interface PathNearest extends Nearest {
  s: number;
  i: number;
}

export function pathNearest(path: Path, q: Vec2): PathNearest {
  let best: PathNearest = { s: 0, i: 0, t: 0, p: pathStart(path), d: Infinity };
  path.pieces.forEach((pc, i) => {
    const r = pieceNearest(pc, q, true);
    if (r.d < best.d - 1e-12) best = { ...r, s: i + r.t, i };
  });
  return best;
}

export function pathLength(path: Path, s0 = 0, s1 = path.pieces.length): number {
  let L = 0;
  const n = path.pieces.length;
  for (let i = Math.max(0, Math.floor(s0)); i < Math.min(n, Math.ceil(s1)); i++) {
    const a = Math.max(0, s0 - i);
    const b = Math.min(1, s1 - i);
    if (b > a) L += pieceLength(path.pieces[i]!, a, b);
  }
  return L;
}

/** 경로 시작에서 길이 L인 곳의 s */
export function pathSAtLength(path: Path, L: number): number {
  let acc = 0;
  const n = path.pieces.length;
  for (let i = 0; i < n; i++) {
    const l = pieceLength(path.pieces[i]!);
    if (acc + l >= L || i === n - 1) return i + Math.min(1, pieceTAtLength(path.pieces[i]!, L - acc));
    acc += l;
  }
  return n;
}

/** [s0, s1] 부분 조각들(s0 < s1). 닫힌 경로에서 s0 > s1이면 끝을 넘어 돈다 */
export function pathSub(path: Path, s0: number, s1: number): Piece[] {
  const n = path.pieces.length;
  if (s0 > s1) {
    if (!path.closed) return pathSub(path, s1, s0);
    return [...pathSub(path, s0, n), ...pathSub(path, 0, s1)];
  }
  const out: Piece[] = [];
  const tiny = 1e-12;
  for (let i = Math.max(0, Math.floor(s0)); i < Math.min(n, Math.ceil(s1)); i++) {
    const a = Math.max(0, s0 - i);
    const b = Math.min(1, s1 - i);
    if (b - a <= tiny) continue;
    const pc = path.pieces[i]!;
    out.push(a <= 0 && b >= 1 ? pc : subPiece(pc, a, b));
  }
  return out.filter((pc) => pieceLength(pc) > 1e-12 * Math.max(1, pieceSize(pc)));
}

export function pathBox(path: Path): Box {
  const b = emptyBox();
  for (const p of path.pieces) pieceBox(p, b);
  return b;
}

export function pathSize(path: Path): number {
  const b = pathBox(path);
  return Math.max(Math.hypot(b.maxX - b.minX, b.maxY - b.minY), 1e-9);
}

/** 경로를 꺾은선으로 */
export function flattenPath(path: Path, tol: number): FlatPt[] {
  const out: FlatPt[] = [];
  path.pieces.forEach((p, i) => {
    const f = flattenPiece(p, tol);
    for (let k = out.length ? 1 : 0; k < f.length; k++) out.push({ t: i + f[k]!.t, x: f[k]!.x, y: f[k]!.y });
  });
  return out;
}
