/**
 * 경계 찾기용 2D 곡선: 선분, 원뿔 곡선(원·호·타원), NURBS.
 * 객체(블록 참조 안 객체 포함)를 월드 XY 평면 곡선으로 바꾸고, 점·미분 계산과 꺾은선 나누기, 스플라인 자르기를 둔다.
 */
import type { CadDocument, Entity, Vec2, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { type Mat, identity, multiply, ocsMatrix, rotationZ, scaling, translation } from '../../geom/matrix';
import { bulgeArc, interpolateFitPoints } from '../../geom/curves';

export const TAU = Math.PI * 2;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface CurveBase {
  /** 최상위 후보 객체 핸들(틈 잇기 선분은 '') */
  src: string;
  /** 폴리선 조각(선·볼록도 호) */
  poly: boolean;
  /** 틈 잇기로 더한 선분 */
  bridge?: boolean;
  t0: number;
  t1: number;
  closed: boolean;
  /** 꺾은선 표본(매개변수·좌표) */
  ts: number[];
  xs: number[];
  ys: number[];
  box: Box;
}

export interface LineCurve extends CurveBase {
  kind: 'line';
  a: Vec2;
  b: Vec2;
}

/** c + u·cos t + v·sin t, v = rot90(u)·ratio (반시계) */
export interface ConicCurve extends CurveBase {
  kind: 'conic';
  c: Vec2;
  u: Vec2;
  ratio: number;
}

export interface SplineCurve extends CurveBase {
  kind: 'spline';
  deg: number;
  knots: number[];
  ctrl: Vec2[];
  w?: number[];
}

export type Curve = LineCurve | ConicCurve | SplineCurve;

const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

function base(src: string, t0: number, t1: number, closed: boolean, poly = false): CurveBase {
  return { src, poly, t0, t1, closed, ts: [], xs: [], ys: [], box: emptyBox() };
}

export function isCircle(c: Curve): boolean {
  return c.kind === 'conic' && Math.abs(c.ratio - 1) < 1e-9;
}

// ---------------------------------------------------------------------------
// 계산
// ---------------------------------------------------------------------------

/** 스플라인 매개변수를 정의역으로(닫힌 곡선은 감는다) */
function wrapT(c: Curve, t: number): number {
  if (c.kind !== 'spline') return t;
  const P = c.t1 - c.t0;
  if (c.closed && P > 0) {
    if (t > c.t1) t -= Math.ceil((t - c.t1) / P) * P;
    if (t < c.t0) t += Math.ceil((c.t0 - t) / P) * P;
  }
  return Math.min(c.t1, Math.max(c.t0, t));
}

export function pointAt(c: Curve, t: number): Vec2 {
  switch (c.kind) {
    case 'line':
      return { x: c.a.x + (c.b.x - c.a.x) * t, y: c.a.y + (c.b.y - c.a.y) * t };
    case 'conic': {
      const co = Math.cos(t);
      const si = Math.sin(t) * c.ratio;
      return { x: c.c.x + c.u.x * co - c.u.y * si, y: c.c.y + c.u.y * co + c.u.x * si };
    }
    case 'spline':
      return deBoor(c.deg, c.knots, c.ctrl, c.w, wrapT(c, t));
  }
}

export function derivAt(c: Curve, t: number): Vec2 {
  switch (c.kind) {
    case 'line':
      return { x: c.b.x - c.a.x, y: c.b.y - c.a.y };
    case 'conic': {
      const si = -Math.sin(t);
      const co = Math.cos(t) * c.ratio;
      return { x: c.u.x * si - c.u.y * co, y: c.u.y * si + c.u.x * co };
    }
    case 'spline': {
      const h = Math.max(1e-9, (c.t1 - c.t0) * 1e-7);
      let a = t - h;
      let b = t + h;
      if (!c.closed) {
        a = Math.max(c.t0, a);
        b = Math.min(c.t1, b);
      }
      const p = pointAt(c, a);
      const q = pointAt(c, b);
      return { x: (q.x - p.x) / (b - a), y: (q.y - p.y) / (b - a) };
    }
  }
}

function findSpan(n: number, p: number, u: number, U: readonly number[]): number {
  if (u >= U[n + 1]!) return n;
  if (u <= U[p]!) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

function deBoor(p: number, U: readonly number[], P: readonly Vec2[], W: readonly number[] | undefined, u: number): Vec2 {
  const n = P.length - 1;
  const k = findSpan(n, p, u, U);
  const dx: number[] = [];
  const dy: number[] = [];
  const dw: number[] = [];
  for (let j = 0; j <= p; j++) {
    const idx = Math.min(Math.max(k - p + j, 0), n);
    const w = W ? W[idx]! : 1;
    dx.push(P[idx]!.x * w);
    dy.push(P[idx]!.y * w);
    dw.push(w);
  }
  for (let r = 1; r <= p; r++)
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = U[i + p - r + 1]! - U[i]!;
      const a = den === 0 ? 0 : (u - U[i]!) / den;
      dx[j] = (1 - a) * dx[j - 1]! + a * dx[j]!;
      dy[j] = (1 - a) * dy[j - 1]! + a * dy[j]!;
      dw[j] = (1 - a) * dw[j - 1]! + a * dw[j]!;
    }
  const w = dw[p] || 1;
  return { x: dx[p]! / w, y: dy[p]! / w };
}

/** 곡선 크기(대략): 정밀도·허용 오차 계산용 */
export function roughBox(c: Curve): Box {
  const b = emptyBox();
  const add = (x: number, y: number) => {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  };
  if (c.kind === 'line') {
    add(c.a.x, c.a.y);
    add(c.b.x, c.b.y);
  } else if (c.kind === 'conic') {
    const r = Math.hypot(c.u.x, c.u.y);
    add(c.c.x - r, c.c.y - r);
    add(c.c.x + r, c.c.y + r);
  } else for (const q of c.ctrl) add(q.x, q.y);
  return b;
}

/** 꺾은선 표본 만들기(tol = 현 오차) */
export function sampleCurve(c: Curve, tol: number): void {
  const ts: number[] = [];
  if (c.kind === 'line') ts.push(0, 1);
  else if (c.kind === 'conic') {
    const r = Math.hypot(c.u.x, c.u.y);
    const sweep = c.t1 - c.t0;
    const step = tol >= r ? Math.PI / 4 : Math.max(2 * Math.acos(1 - tol / r), 1e-3);
    const n = Math.min(720, Math.max(Math.ceil((sweep / TAU) * 16), Math.ceil(sweep / step), 2));
    for (let i = 0; i <= n; i++) ts.push(c.t0 + (sweep * i) / n);
  } else {
    const p = c.deg;
    const U = c.knots;
    const n = c.ctrl.length;
    ts.push(c.t0);
    for (let s = p; s < n; s++) {
      const a = U[s]!;
      const b = U[s + 1]!;
      if (b <= a) continue;
      let len = 0;
      for (let j = s - p; j < s; j++) {
        const q0 = c.ctrl[Math.max(0, j)]!;
        const q1 = c.ctrl[Math.min(n - 1, j + 1)]!;
        len += Math.hypot(q1.x - q0.x, q1.y - q0.y);
      }
      const m = Math.min(96, Math.max(p === 1 ? 1 : 6, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-12)))));
      for (let i = 1; i <= m; i++) ts.push(a + ((b - a) * i) / m);
    }
  }
  c.ts = ts;
  c.xs = new Array(ts.length);
  c.ys = new Array(ts.length);
  const b = emptyBox();
  for (let i = 0; i < ts.length; i++) {
    const q = pointAt(c, ts[i]!);
    c.xs[i] = q.x;
    c.ys[i] = q.y;
    if (q.x < b.minX) b.minX = q.x;
    if (q.x > b.maxX) b.maxX = q.x;
    if (q.y < b.minY) b.minY = q.y;
    if (q.y > b.maxY) b.maxY = q.y;
  }
  c.box = b;
  // 닫힘 판정(스플라인은 끝점이 겹치면 닫힌 곡선)
  if (c.kind === 'spline' && !c.closed) {
    const n = ts.length - 1;
    const d = Math.hypot(c.xs[0]! - c.xs[n]!, c.ys[0]! - c.ys[n]!);
    if (d <= Math.max(1e-12, Math.hypot(b.maxX - b.minX, b.maxY - b.minY) * 1e-10)) c.closed = true;
  }
}

// ---------------------------------------------------------------------------
// 원뿔 곡선 만들기(켤레 지름 → 주축)
// ---------------------------------------------------------------------------

/**
 * c + p·cos t + q·sin t (t ∈ [ta, tb]) → 반시계 표준형 원뿔 곡선.
 * 주축 u와 매개변수 이동을 구하고, 좌우가 뒤집혔으면 매개변수 방향을 바꾼다.
 */
export function conicFromConjugate(src: string, c: Vec2, p: Vec2, q: Vec2, ta: number, tb: number, full: boolean, poly = false): ConicCurve | null {
  const pp = p.x * p.x + p.y * p.y;
  const qq = q.x * q.x + q.y * q.y;
  const pq = p.x * q.x + p.y * q.y;
  const ts = Math.abs(pq) < 1e-15 * (pp + qq) && Math.abs(pp - qq) < 1e-12 * (pp + qq) ? 0 : 0.5 * Math.atan2(2 * pq, pp - qq);
  const cs = Math.cos(ts);
  const sn = Math.sin(ts);
  const u = { x: p.x * cs + q.x * sn, y: p.y * cs + q.y * sn };
  const w = { x: -p.x * sn + q.x * cs, y: -p.y * sn + q.y * cs };
  const lu = Math.hypot(u.x, u.y);
  const lw = Math.hypot(w.x, w.y);
  if (!(lu > 1e-12) || !(lw > 1e-12 * lu)) return null;
  const ccw = u.x * w.y - u.y * w.x > 0;
  let s0: number;
  let s1: number;
  if (full) {
    s0 = 0;
    s1 = TAU;
  } else if (ccw) {
    s0 = ta - ts;
    s1 = tb - ts;
  } else {
    s0 = ts - tb;
    s1 = ts - ta;
  }
  let ratio = lw / lu;
  if (ratio > 1) ratio = 1;
  // 원은 u 방향을 시작 각에 맞춘다(호 각도가 그대로 보이게)
  if (Math.abs(ratio - 1) < 1e-9 && !full) {
    const a = Math.atan2(u.y, u.x) + s0;
    return {
      ...base(src, a, a + (s1 - s0), false, poly),
      kind: 'conic',
      c: { x: c.x, y: c.y },
      u: { x: lu, y: 0 },
      ratio: 1,
    };
  }
  return { ...base(src, s0, s1, full, poly), kind: 'conic', c: { x: c.x, y: c.y }, u, ratio };
}

// ---------------------------------------------------------------------------
// 객체 → 곡선
// ---------------------------------------------------------------------------

export interface XLineSpec {
  src: string;
  base: Vec2;
  dir: Vec2;
  ray: boolean;
}

interface Ctx {
  doc: CadDocument;
  out: Curve[];
  xlines: XLineSpec[];
}

const MAX_DEPTH = 16;

function apply(m: Mat, x: number, y: number, z: number): Vec3 {
  return { x: m[0]! * x + m[1]! * y + m[2]! * z + m[3]!, y: m[4]! * x + m[5]! * y + m[6]! * z + m[7]!, z: m[8]! * x + m[9]! * y + m[10]! * z + m[11]! };
}

function dir(m: Mat, x: number, y: number, z: number): Vec3 {
  return { x: m[0]! * x + m[1]! * y + m[2]! * z, y: m[4]! * x + m[5]! * y + m[6]! * z, z: m[8]! * x + m[9]! * y + m[10]! * z };
}

/** OCS 평면이 월드 XY와 나란한지(기운 평면 객체는 경계로 쓰지 않는다) */
function flat(m: Mat): boolean {
  const sx = Math.hypot(m[0]!, m[4]!, m[8]!);
  const sy = Math.hypot(m[1]!, m[5]!, m[9]!);
  return Math.abs(m[8]!) <= 1e-9 * (sx || 1) && Math.abs(m[9]!) <= 1e-9 * (sy || 1);
}

function withExt(m: Mat, ext: Vec3 | undefined): Mat {
  const o = ocsMatrix(ext);
  return o ? multiply(m, o) : m;
}

function lineCurve(src: string, a: Vec2, b: Vec2, poly = false): LineCurve | null {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-14 * (Math.abs(a.x) + Math.abs(a.y) + 1)) return null;
  return { ...base(src, 0, 1, false, poly), kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
}

function push(ctx: Ctx, c: Curve | null): void {
  if (c) ctx.out.push(c);
}

/** 원·호(OCS 중심, 반지름, 각도) → 원뿔 곡선 */
function circleCurve(src: string, m: Mat, cx: number, cy: number, z: number, r: number, a0: number, sweep: number, full: boolean, poly = false): ConicCurve | null {
  if (!(r > 0)) return null;
  const c = apply(m, cx, cy, z);
  const p = dir(m, r, 0, 0);
  const q = dir(m, 0, r, 0);
  return conicFromConjugate(src, c, p, q, a0, a0 + sweep, full, poly);
}

function bulgeVerts(src: string, m: Mat, vs: { x: number; y: number; bulge: number }[], closed: boolean, z: number, ctx: Ctx): void {
  const n = vs.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const arc = Math.abs(a.bulge) > 1e-12 ? bulgeArc(a.x, a.y, b.x, b.y, a.bulge) : null;
    if (arc) {
      const sweep = arc.sweep;
      if (sweep > 0) push(ctx, circleCurve(src, m, arc.cx, arc.cy, z, arc.r, arc.a0, sweep, false, true));
      else push(ctx, circleCurve(src, m, arc.cx, arc.cy, z, arc.r, arc.a0 + sweep, -sweep, false, true));
    } else {
      const p = apply(m, a.x, a.y, z);
      const q = apply(m, b.x, b.y, z);
      push(ctx, lineCurve(src, p, q, true));
    }
  }
}

function addEntity(ctx: Ctx, e: Entity, src: string, m: Mat, depth: number, chain: string[]): void {
  if (e.invisible) return;
  switch (e.type) {
    case 'LINE': {
      const a = apply(m, e.start.x, e.start.y, e.start.z);
      const b = apply(m, e.end.x, e.end.y, e.end.z);
      push(ctx, lineCurve(src, a, b));
      return;
    }
    case 'CIRCLE':
    case 'ARC': {
      const mm = withExt(m, e.extrusion);
      if (!flat(mm)) return;
      if (e.type === 'CIRCLE') push(ctx, circleCurve(src, mm, e.center.x, e.center.y, e.center.z, e.radius, 0, TAU, true));
      else {
        let sweep = e.endAngle - e.startAngle;
        sweep -= Math.floor(sweep / TAU) * TAU;
        if (sweep < 1e-12) sweep = TAU;
        push(ctx, circleCurve(src, mm, e.center.x, e.center.y, e.center.z, e.radius, e.startAngle, sweep, sweep >= TAU - 1e-12));
      }
      return;
    }
    case 'ELLIPSE': {
      const N = e.extrusion ?? { x: 0, y: 0, z: 1 };
      const nl = Math.hypot(N.x, N.y, N.z) || 1;
      const M = e.majorAxis;
      const minor = { x: ((N.y * M.z - N.z * M.y) / nl) * e.ratio, y: ((N.z * M.x - N.x * M.z) / nl) * e.ratio, z: ((N.x * M.y - N.y * M.x) / nl) * e.ratio };
      const c = apply(m, e.center.x, e.center.y, e.center.z);
      const p = dir(m, M.x, M.y, M.z);
      const q = dir(m, minor.x, minor.y, minor.z);
      const sz = Math.hypot(p.x, p.y, p.z);
      if (Math.abs(p.z) > 1e-9 * sz || Math.abs(q.z) > 1e-9 * sz) return;
      let sweep = e.endParam - e.startParam;
      sweep -= Math.floor(sweep / TAU) * TAU;
      if (sweep < 1e-12) sweep = TAU;
      const full = sweep >= TAU - 1e-9;
      push(ctx, conicFromConjugate(src, c, p, q, e.startParam, e.startParam + sweep, full));
      return;
    }
    case 'LWPOLYLINE': {
      const mm = withExt(m, e.extrusion);
      if (!flat(mm) || e.vertices.length < 2) return;
      bulgeVerts(src, mm, e.vertices, e.closed, e.elevation, ctx);
      return;
    }
    case 'POLYLINE': {
      if (e.kind === 'mesh' || e.kind === 'polyface') return;
      const vs = e.vertices.filter((v) => !(v.flags & 16));
      if (vs.length < 2) return;
      const closed = !!(e.flags & 1);
      if (e.kind === '3d') {
        const n = vs.length;
        for (let i = 0; i < (closed ? n : n - 1); i++) {
          const a = vs[i]!.location;
          const b = vs[(i + 1) % n]!.location;
          push(ctx, lineCurve(src, apply(m, a.x, a.y, a.z), apply(m, b.x, b.y, b.z), true));
        }
        return;
      }
      const mm = withExt(m, e.extrusion);
      if (!flat(mm)) return;
      const smooth = !!(e.flags & 4);
      bulgeVerts(
        src,
        mm,
        vs.map((v) => ({ x: v.location.x, y: v.location.y, bulge: smooth ? 0 : v.bulge })),
        closed,
        e.elevation,
        ctx,
      );
      return;
    }
    case 'SPLINE': {
      let ctrl = e.controlPoints;
      let knots = e.knots;
      let deg = e.degree;
      let w = e.weights && e.weights.length === ctrl.length && e.weights.some((x) => Math.abs(x - 1) > 1e-12) ? e.weights : undefined;
      if (ctrl.length < 2 && e.fitPoints.length >= 2) {
        const s = interpolateFitPoints(e.fitPoints, e.startTangent, e.endTangent);
        ctrl = s.ctrl;
        knots = s.knots;
        deg = s.degree;
        w = undefined;
      }
      if (ctrl.length < 2) return;
      deg = Math.max(1, Math.min(deg, ctrl.length - 1));
      if (knots.length !== ctrl.length + deg + 1) knots = clampedKnotsLocal(ctrl.length, deg);
      const pts = ctrl.map((q) => {
        const r = apply(m, q.x, q.y, q.z);
        return { x: r.x, y: r.y };
      });
      const t0 = knots[deg]!;
      const t1 = knots[ctrl.length]!;
      if (!(t1 > t0)) return;
      push(ctx, { ...base(src, t0, t1, false), kind: 'spline', deg, knots: [...knots], ctrl: pts, w: w ? [...w] : undefined });
      return;
    }
    case 'SOLID':
    case 'TRACE': {
      const mm = withExt(m, e.extrusion);
      if (!flat(mm)) return;
      const [p0, p1, p2, p3] = e.points;
      const order = [p0, p1, p3, p2];
      for (let i = 0; i < 4; i++) {
        const a = order[i]!;
        const b = order[(i + 1) % 4]!;
        push(ctx, lineCurve(src, apply(mm, a.x, a.y, p0.z), apply(mm, b.x, b.y, p0.z)));
      }
      return;
    }
    case 'XLINE':
    case 'RAY': {
      const b = apply(m, e.base.x, e.base.y, e.base.z);
      const d = dir(m, e.direction.x, e.direction.y, e.direction.z);
      const l = Math.hypot(d.x, d.y);
      if (l < 1e-12) return;
      ctx.xlines.push({ src, base: { x: b.x, y: b.y }, dir: { x: d.x / l, y: d.y / l }, ray: e.type === 'RAY' });
      return;
    }
    case 'INSERT': {
      if (depth >= MAX_DEPTH) return;
      const key = tableKey(e.block);
      if (chain.includes(key)) return;
      const blk = ctx.doc.blocks.get(key);
      if (!blk) return;
      const om = withExt(m, e.extrusion);
      const rows = Math.max(1, e.rowCount || 1);
      const cols = Math.max(1, e.columnCount || 1);
      const sx = e.scale.x || 1;
      const sy = e.scale.y || 1;
      const sz = e.scale.z || 1;
      for (let r = 0; r < rows; r++)
        for (let k = 0; k < cols; k++) {
          const local = multiply(
            translation(e.insert.x, e.insert.y, e.insert.z),
            multiply(rotationZ(e.rotation), multiply(translation(k * e.columnSpacing, r * e.rowSpacing, 0), scaling(sx, sy, sz))),
          );
          const mm = multiply(om, multiply(local, translation(-blk.basePoint.x, -blk.basePoint.y, -blk.basePoint.z)));
          for (const ch of blk.entities) {
            if (ch.type === 'ATTDEF') continue;
            const lay = ctx.doc.layers.get(tableKey(ch.layer));
            if (lay && (lay.off || lay.frozen)) continue;
            addEntity(ctx, ch, src, mm, depth + 1, [...chain, key]);
          }
        }
      return;
    }
    default:
      return;
  }
}

function clampedKnotsLocal(n: number, p: number): number[] {
  const U: number[] = [];
  for (let i = 0; i < n + p + 1; i++) U.push(i <= p ? 0 : i >= n ? n - p : i - p);
  return U;
}

/** 후보 객체들 → 곡선(무한선은 따로) */
export function entitiesToCurves(doc: CadDocument, list: readonly Entity[]): { curves: Curve[]; xlines: XLineSpec[] } {
  const ctx: Ctx = { doc, out: [], xlines: [] };
  const m = identity();
  for (const e of list) {
    if (e.type === 'HATCH' || e.type === 'MPOLYGON') continue;
    addEntity(ctx, e, e.handle, m, 0, []);
  }
  return { curves: ctx.out, xlines: ctx.xlines };
}

/** 무한선·반직선을 상자에 맞춰 선분으로 */
export function clipXLines(xl: readonly XLineSpec[], box: Box): LineCurve[] {
  const out: LineCurve[] = [];
  for (const x of xl) {
    let lo = x.ray ? 0 : -Infinity;
    let hi = Infinity;
    const clip = (p: number, d: number, mn: number, mx: number) => {
      if (Math.abs(d) < 1e-15) {
        if (p < mn || p > mx) hi = -Infinity;
        return;
      }
      let a = (mn - p) / d;
      let b = (mx - p) / d;
      if (a > b) [a, b] = [b, a];
      lo = Math.max(lo, a);
      hi = Math.min(hi, b);
    };
    clip(x.base.x, x.dir.x, box.minX, box.maxX);
    clip(x.base.y, x.dir.y, box.minY, box.maxY);
    if (!(hi > lo)) continue;
    const c = lineCurve(x.src, { x: x.base.x + x.dir.x * lo, y: x.base.y + x.dir.y * lo }, { x: x.base.x + x.dir.x * hi, y: x.base.y + x.dir.y * hi });
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// NURBS 자르기(매듭 넣기)
// ---------------------------------------------------------------------------

interface Hom {
  x: number;
  y: number;
  w: number;
}

function insertKnot(p: number, U: number[], P: Hom[], u: number): { U: number[]; P: Hom[] } {
  const n = P.length - 1;
  const k = findSpan(n, p, u, U);
  const Q: Hom[] = [];
  for (let i = 0; i <= n + 1; i++) {
    if (i <= k - p) Q.push(P[i]!);
    else if (i >= k + 1) Q.push(P[i - 1]!);
    else {
      const den = U[i + p]! - U[i]!;
      const a = den === 0 ? 0 : (u - U[i]!) / den;
      const A = P[i]!;
      const B = P[i - 1]!;
      Q.push({ x: a * A.x + (1 - a) * B.x, y: a * A.y + (1 - a) * B.y, w: a * A.w + (1 - a) * B.w });
    }
  }
  const V = [...U.slice(0, k + 1), u, ...U.slice(k + 1)];
  return { U: V, P: Q };
}

export interface NurbsPart {
  degree: number;
  knots: number[];
  ctrl: Vec2[];
  weights?: number[];
}

/** 스플라인의 [ua, ub] 부분 곡선(끝 매듭 겹침, ua < ub) */
export function splineSub(c: SplineCurve, ua: number, ub: number): NurbsPart {
  const p = c.deg;
  let U = [...c.knots];
  let P: Hom[] = c.ctrl.map((q, i) => {
    const w = c.w ? c.w[i]! : 1;
    return { x: q.x * w, y: q.y * w, w };
  });
  const span = c.t1 - c.t0;
  const snap = (u: number) => {
    for (const k of U) if (Math.abs(k - u) <= span * 1e-12) return k;
    return u;
  };
  ua = snap(Math.max(c.t0, Math.min(c.t1, ua)));
  ub = snap(Math.max(c.t0, Math.min(c.t1, ub)));
  const mult = (u: number) => U.filter((k) => k === u).length;
  for (const u of [ua, ub]) {
    let s = mult(u);
    while (s < p) {
      ({ U, P } = insertKnot(p, U, P, u));
      s++;
    }
  }
  const lastA = U.lastIndexOf(ua);
  const i0 = lastA - p + 1;
  const j0 = U.indexOf(ub);
  const ctrlH = P.slice(i0 - 1, j0);
  const knots = [...new Array(p + 1).fill(ua), ...U.slice(lastA + 1, j0), ...new Array(p + 1).fill(ub)];
  const rational = !!c.w;
  return {
    degree: p,
    knots,
    ctrl: ctrlH.map((h) => ({ x: h.x / h.w, y: h.y / h.w })),
    weights: rational ? ctrlH.map((h) => h.w) : undefined,
  };
}

/** 방향 뒤집기 */
export function reverseNurbs(s: NurbsPart): NurbsPart {
  const a = s.knots[0]!;
  const b = s.knots[s.knots.length - 1]!;
  return {
    degree: s.degree,
    knots: s.knots.map((k) => a + b - k).reverse(),
    ctrl: [...s.ctrl].reverse(),
    weights: s.weights ? [...s.weights].reverse() : undefined,
  };
}
