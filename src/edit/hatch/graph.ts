/**
 * 평면 배치(arrangement): 곡선을 교점에서 쪼개 꼭짓점·조각(모서리)으로 만들고,
 * 반모서리(half-edge)로 면을 따라 돈다. 면의 왼쪽을 보며 돌므로 유한한 면은 반시계, 바깥 면은 시계 방향이다.
 */
import { type ConicCurve, type Curve, type LineCurve, TAU, derivAt, isCircle, pointAt, sampleCurve } from './curves';

export interface Piece {
  curve: number;
  ta: number;
  /** ta < tb. 닫힌 곡선에서 이음매를 넘으면 tb > t1 */
  tb: number;
  va: number;
  vb: number;
  /** 꺾은선(양 끝 = 꼭짓점 좌표) */
  xs: number[];
  ys: number[];
  /** 꺾은선 점의 매개변수 */
  ts: number[];
  len: number;
  alive: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Split {
  t: number;
  v: number;
}

// ---------------------------------------------------------------------------
// 꼭짓점 모음(허용 오차 안의 점은 하나로)
// ---------------------------------------------------------------------------

class VertexPool {
  readonly x: number[] = [];
  readonly y: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly cell: number;

  constructor(
    readonly tol: number,
    private readonly ox: number,
    private readonly oy: number,
  ) {
    this.cell = tol * 4;
  }

  private key(i: number, j: number): number {
    return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) & 0x3fffffff;
  }

  add(x: number, y: number): number {
    const c = this.cell;
    const fx = (x - this.ox) / c;
    const fy = (y - this.oy) / c;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const t2 = this.tol * this.tol;
    // 칸 가장자리 가까이일 때만 이웃 칸을 본다(칸 = 허용 오차 4배)
    const ri = fx - i;
    const rj = fy - j;
    const i0 = ri < 0.25 ? -1 : 0;
    const i1 = ri > 0.75 ? 1 : 0;
    const j0 = rj < 0.25 ? -1 : 0;
    const j1 = rj > 0.75 ? 1 : 0;
    for (let di = i0; di <= i1; di++)
      for (let dj = j0; dj <= j1; dj++) {
        const b = this.cells.get(this.key(i + di, j + dj));
        if (!b) continue;
        for (let k = 0; k < b.length; k++) {
          const v = b[k]!;
          const dx = this.x[v]! - x;
          const dy = this.y[v]! - y;
          if (dx * dx + dy * dy <= t2) return v;
        }
      }
    const v = this.x.length;
    this.x.push(x);
    this.y.push(y);
    const k = this.key(i, j);
    const b = this.cells.get(k);
    if (b) b.push(v);
    else this.cells.set(k, [v]);
    return v;
  }
}

// ---------------------------------------------------------------------------
// 선분 격자(교점 찾기)
// ---------------------------------------------------------------------------

class SegGrid {
  readonly cells = new Map<number, number[]>();
  readonly cell: number;
  readonly nx: number;

  constructor(
    readonly ox: number,
    readonly oy: number,
    w: number,
    h: number,
    nSeg: number,
  ) {
    const size = Math.max(w, h, 1e-12);
    let cell = Math.sqrt((Math.max(w, size * 1e-3) * Math.max(h, size * 1e-3)) / Math.max(1, nSeg)) * 2;
    cell = Math.max(cell, size / 4096);
    this.cell = cell;
    this.nx = Math.floor(w / cell) + 3;
  }

  private key(i: number, j: number): number {
    return (j + 1) * this.nx + (i + 1);
  }

  /** 선분(eps 두께)이 지나는 칸마다 id 넣기 */
  insert(id: number, ax: number, ay: number, bx: number, by: number, eps: number): void {
    const c = this.cell;
    if (ax > bx) [ax, ay, bx, by] = [bx, by, ax, ay];
    const i0 = Math.floor((ax - eps - this.ox) / c);
    const i1 = Math.floor((bx + eps - this.ox) / c);
    const dx = bx - ax;
    for (let i = i0; i <= i1; i++) {
      let ya: number;
      let yb: number;
      if (dx < 1e-300) {
        ya = ay;
        yb = by;
      } else {
        // 이 칸 열에 걸친 x 범위(선분 밖으로 늘이지 않는다)
        const xa = Math.min(bx, Math.max(ax, this.ox + i * c));
        const xb = Math.min(bx, Math.max(ax, this.ox + (i + 1) * c));
        ya = ay + (by - ay) * Math.min(1, (xa - ax) / dx);
        yb = ay + (by - ay) * Math.min(1, (xb - ax) / dx);
      }
      if (ya > yb) [ya, yb] = [yb, ya];
      const j0 = Math.floor((ya - eps - this.oy) / c);
      const j1 = Math.floor((yb + eps - this.oy) / c);
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        const b = this.cells.get(k);
        if (b) b.push(id);
        else this.cells.set(k, [id]);
      }
    }
  }

  cellOf(x: number, y: number): [number, number] {
    return [Math.floor((x - this.ox) / this.cell), Math.floor((y - this.oy) / this.cell)];
  }

  get(i: number, j: number): number[] | undefined {
    return this.cells.get(this.key(i, j));
  }

  keyOf(x: number, y: number): number {
    const [i, j] = this.cellOf(x, y);
    return this.key(i, j);
  }
}

// ---------------------------------------------------------------------------
// 배치
// ---------------------------------------------------------------------------

export interface GraphOptions {
  /** 꼭짓점 합치기 허용 오차 */
  mergeTol: number;
  /** 꺾은선 현 오차 */
  sampleTol: number;
  /** 틈 허용(0 = 없음) */
  gapTol: number;
}

export class Graph {
  readonly vx: number[];
  readonly vy: number[];
  pieces: Piece[] = [];
  /** 꼭짓점 → 나가는 반모서리(반시계 정렬) */
  outs: number[][] = [];
  /** 반모서리 → outs[시작점] 안의 자리 */
  slot: Int32Array = new Int32Array(0);
  /** 꼭짓점 → 연결 성분 번호(-1 = 모서리 없음) */
  comp: Int32Array = new Int32Array(0);
  compCount = 0;

  constructor(
    readonly curves: Curve[],
    pool: VertexPool,
  ) {
    this.vx = pool.x;
    this.vy = pool.y;
  }

  start(h: number): number {
    const p = this.pieces[h >> 1]!;
    return h & 1 ? p.vb : p.va;
  }

  end(h: number): number {
    const p = this.pieces[h >> 1]!;
    return h & 1 ? p.va : p.vb;
  }

  /** 면을 왼쪽에 둔 채 다음 반모서리: 도착점에서 반대 반모서리의 바로 시계 방향 이웃 */
  next(h: number): number {
    const tw = h ^ 1;
    const v = this.start(tw);
    const list = this.outs[v]!;
    const i = this.slot[tw]!;
    return list[(i - 1 + list.length) % list.length]!;
  }

  /** 면 둘레 돌기 */
  walk(h0: number): number[] {
    const out: number[] = [];
    let h = h0;
    const limit = this.pieces.length * 2 + 2;
    do {
      out.push(h);
      h = this.next(h);
      if (out.length > limit) return [];
    } while (h !== h0);
    return out;
  }

  /** 반모서리 방향의 꺾은선 점(끝점 제외) */
  pushPoints(h: number, xs: number[], ys: number[]): void {
    const p = this.pieces[h >> 1]!;
    const n = p.xs.length;
    if (h & 1) for (let i = n - 1; i > 0; i--) (xs.push(p.xs[i]!), ys.push(p.ys[i]!));
    else for (let i = 0; i < n - 1; i++) (xs.push(p.xs[i]!), ys.push(p.ys[i]!));
  }

  ring(walk: readonly number[]): { xs: number[]; ys: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const h of walk) this.pushPoints(h, xs, ys);
    return { xs, ys };
  }
}

export function signedArea(xs: readonly number[], ys: readonly number[]): number {
  let a = 0;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) a += xs[j]! * ys[i]! - xs[i]! * ys[j]!;
  return a / 2;
}

export function pointInRing(x: number, y: number, xs: readonly number[], ys: readonly number[]): boolean {
  let inside = false;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xs[i]!;
    const yi = ys[i]!;
    const xj = xs[j]!;
    const yj = ys[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// 만들기
// ---------------------------------------------------------------------------

export function buildGraph(curves: Curve[], opt: GraphOptions): Graph {
  // 전체 범위
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of curves) {
    if (!c.ts.length) sampleCurve(c, opt.sampleTol);
    minX = Math.min(minX, c.box.minX);
    minY = Math.min(minY, c.box.minY);
    maxX = Math.max(maxX, c.box.maxX);
    maxY = Math.max(maxY, c.box.maxY);
  }
  const pool = new VertexPool(opt.mergeTol, minX, minY);
  const g = new Graph(curves, pool);
  if (!curves.length) return g;
  const splits: Split[][] = curves.map(() => []);
  const eps = opt.mergeTol;

  // 열린 곡선의 끝점
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i]!;
    if (c.closed) continue;
    const n = c.xs.length - 1;
    splits[i]!.push({ t: c.t0, v: pool.add(c.xs[0]!, c.ys[0]!) }, { t: c.t1, v: pool.add(c.xs[n]!, c.ys[n]!) });
  }

  findIntersections(curves, splits, pool, eps, opt.sampleTol, minX, minY, maxX - minX, maxY - minY);

  let pieces = makePieces(curves, splits, pool, eps);
  if (opt.gapTol > 0) {
    const added = bridgeGaps(curves, splits, pieces, pool, opt.gapTol, eps);
    if (added) pieces = makePieces(curves, splits, pool, eps);
  }
  g.pieces = dedupe(pieces, Math.max(eps * 50, opt.sampleTol * 2));
  prune(g);
  orderOutgoing(g);
  components(g);
  return g;
}

/** 교점: 꺾은선 선분끼리 찾고, 곡선 위에서 다듬는다 */
function findIntersections(curves: Curve[], splits: Split[][], pool: VertexPool, eps: number, sampleTol: number, ox: number, oy: number, w: number, h: number): void {
  // 선분 목록
  const segC: number[] = [];
  const segI: number[] = [];
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i]!;
    for (let k = 0; k + 1 < c.xs.length; k++) {
      segC.push(i);
      segI.push(k);
    }
  }
  const grid = new SegGrid(ox, oy, w, h, segC.length);
  for (let s = 0; s < segC.length; s++) {
    const c = curves[segC[s]!]!;
    const k = segI[s]!;
    // 곡선 선분은 현 오차만큼 두껍게(접점을 놓치지 않게)
    grid.insert(s, c.xs[k]!, c.ys[k]!, c.xs[k + 1]!, c.ys[k + 1]!, c.kind === 'line' ? eps : eps + sampleTol * 2);
  }
  const record = (ca: number, ta: number, cb: number, tb: number, x: number, y: number) => {
    const v = pool.add(x, y);
    splits[ca]!.push({ t: ta, v });
    splits[cb]!.push({ t: tb, v });
  };
  // 선·원뿔, 원·원은 식으로 푼다(접점 포함). 곡선 쌍을 모아 한 번씩
  const exact = new Set<number>();
  const N = curves.length;
  const exactPair = (A: Curve, B: Curve) =>
    (A.kind === 'line' && B.kind === 'conic') || (A.kind === 'conic' && B.kind === 'line') || (A.kind === 'conic' && B.kind === 'conic' && isCircle(A) && isCircle(B));
  for (const [key, list] of grid.cells) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      const sa = list[a]!;
      const ia = segC[sa]!;
      const A = curves[ia]!;
      const ka = segI[sa]!;
      const ax = A.xs[ka]!;
      const ay = A.ys[ka]!;
      const bx = A.xs[ka + 1]!;
      const by = A.ys[ka + 1]!;
      for (let b = a + 1; b < list.length; b++) {
        const sb = list[b]!;
        const ib = segC[sb]!;
        if (ib === ia) continue;
        const B = curves[ib]!;
        if (exactPair(A, B)) {
          exact.add(ia < ib ? ia * N + ib : ib * N + ia);
          continue;
        }
        const kb = segI[sb]!;
        const cx = B.xs[kb]!;
        const cy = B.ys[kb]!;
        const dx = B.xs[kb + 1]!;
        const dy = B.ys[kb + 1]!;
        // 상자 거르기
        if (Math.max(ax, bx) + eps < Math.min(cx, dx) || Math.max(cx, dx) + eps < Math.min(ax, bx)) continue;
        if (Math.max(ay, by) + eps < Math.min(cy, dy) || Math.max(cy, dy) + eps < Math.min(ay, by)) continue;
        const nHit = segSeg(ax, ay, bx, by, cx, cy, dx, dy, eps);
        for (let q = 0; q < nHit; q++) {
          const s = HIT[q * 4]!;
          const u = HIT[q * 4 + 1]!;
          const x = HIT[q * 4 + 2]!;
          const y = HIT[q * 4 + 3]!;
          // 같은 교점을 여러 칸에서 세지 않도록 점이 속한 칸에서만 기록
          if (grid.keyOf(x, y) !== key) continue;
          const ta = A.ts[ka]! + (A.ts[ka + 1]! - A.ts[ka]!) * s;
          const tb = B.ts[kb]! + (B.ts[kb + 1]! - B.ts[kb]!) * u;
          if (A.kind === 'line' && B.kind === 'line') record(ia, ta, ib, tb, x, y);
          else if (refine(A, ta, B, tb, eps)) record(ia, REF[0]!, ib, REF[1]!, REF[2]!, REF[3]!);
          else record(ia, ta, ib, tb, x, y);
        }
      }
    }
  }
  for (const k of exact) {
    const ia = Math.floor(k / N);
    const ib = k % N;
    const A = curves[ia]!;
    const B = curves[ib]!;
    if (A.kind === 'line' || B.kind === 'line') {
      const [li, ci] = A.kind === 'line' ? [ia, ib] : [ib, ia];
      lineConic(curves[li] as LineCurve, curves[ci] as ConicCurve, eps, (s, t, x, y) => record(li, s, ci, t, x, y));
    } else circleCircle(A as ConicCurve, B as ConicCurve, eps, (ta, tb, x, y) => record(ia, ta, ib, tb, x, y));
  }
  // 끝점이 다른 곡선 위에 닿는 경우(T자 이음)
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i]!;
    if (c.closed) continue;
    const n = c.xs.length - 1;
    for (let end = 0; end < 2; end++) {
      const px = end ? c.xs[n]! : c.xs[0]!;
      const py = end ? c.ys[n]! : c.ys[0]!;
      const t = end ? c.t1 : c.t0;
      const [ci, cj] = grid.cellOf(px, py);
      const list = grid.get(ci, cj);
      if (!list) continue;
      for (const s of list) {
        const j = segC[s]!;
        if (j === i) continue;
        const B = curves[j]!;
        const k = segI[s]!;
        const ax = B.xs[k]!;
        const ay = B.ys[k]!;
        const ex = B.xs[k + 1]! - ax;
        const ey = B.ys[k + 1]! - ay;
        const l2 = ex * ex + ey * ey;
        if (l2 < 1e-300) continue;
        let u = ((px - ax) * ex + (py - ay) * ey) / l2;
        u = Math.max(0, Math.min(1, u));
        const qx = ax + ex * u;
        const qy = ay + ey * u;
        // 꺾은선 오차만큼은 곡선 위로 투영해 본다
        if (Math.hypot(qx - px, qy - py) > eps + (B.kind === 'line' ? 0 : Math.sqrt(l2))) continue;
        let tb = B.ts[k]! + (B.ts[k + 1]! - B.ts[k]!) * u;
        tb = project(B, tb, px, py);
        const q = pointAt(B, tb);
        if (Math.hypot(q.x - px, q.y - py) > eps) continue;
        record(i, t, j, tb, px, py);
      }
    }
  }
}

/** 원뿔 곡선 위 점의 매개변수(정의역 밖이면 null) */
function conicParam(c: ConicCurve, x: number, y: number, eps: number): number | null {
  const a = Math.hypot(c.u.x, c.u.y);
  const b = a * c.ratio;
  const dx = x - c.c.x;
  const dy = y - c.c.y;
  const px = (dx * c.u.x + dy * c.u.y) / a / a;
  const py = (-dx * c.u.y + dy * c.u.x) / a / b;
  let t = Math.atan2(py, px);
  if (c.closed) return c.t0 + ((((t - c.t0) % TAU) + TAU) % TAU);
  const tol = eps / b;
  t = c.t0 + ((((t - c.t0) % TAU) + TAU) % TAU);
  if (t <= c.t1 + tol) return Math.min(t, c.t1);
  if (t - TAU >= c.t0 - tol) return c.t0;
  return null;
}

/** 선분과 원뿔 곡선(단위 원 좌표에서 풀기, 접점 허용) */
function lineConic(L: LineCurve, C: ConicCurve, eps: number, report: (s: number, t: number, x: number, y: number) => void): void {
  const a = Math.hypot(C.u.x, C.u.y);
  const b = a * C.ratio;
  const ux = C.u.x / a;
  const uy = C.u.y / a;
  const map = (x: number, y: number): [number, number] => {
    const dx = x - C.c.x;
    const dy = y - C.c.y;
    return [(dx * ux + dy * uy) / a, (-dx * uy + dy * ux) / b];
  };
  const [Ax, Ay] = map(L.a.x, L.a.y);
  const [Bx, By] = map(L.b.x, L.b.y);
  const Dx = Bx - Ax;
  const Dy = By - Ay;
  const qa = Dx * Dx + Dy * Dy;
  if (qa < 1e-300) return;
  const len = Math.hypot(L.b.x - L.a.x, L.b.y - L.a.y);
  const es = eps / len;
  const foot = -(Ax * Dx + Ay * Dy) / qa;
  const hx = Ax + Dx * foot;
  const hy = Ay + Dy * foot;
  const h = Math.hypot(hx, hy);
  const tolU = eps / b;
  const roots: number[] = [];
  if (Math.abs(h - 1) <= tolU) roots.push(foot);
  else if (h < 1) {
    const k = Math.sqrt((1 - h * h) / qa);
    roots.push(foot - k, foot + k);
  }
  for (let s of roots) {
    if (s < -es || s > 1 + es) continue;
    s = Math.max(0, Math.min(1, s));
    const px = L.a.x + (L.b.x - L.a.x) * s;
    const py = L.a.y + (L.b.y - L.a.y) * s;
    const t = conicParam(C, px, py, eps);
    if (t === null) continue;
    const q = pointAt(C, t);
    if (Math.hypot(q.x - px, q.y - py) > eps * 4 + tolU * b) continue;
    report(s, t, (q.x + px) / 2, (q.y + py) / 2);
  }
}

/** 원과 원(접점 허용) */
function circleCircle(A: ConicCurve, B: ConicCurve, eps: number, report: (ta: number, tb: number, x: number, y: number) => void): void {
  const r1 = Math.hypot(A.u.x, A.u.y);
  const r2 = Math.hypot(B.u.x, B.u.y);
  const dx = B.c.x - A.c.x;
  const dy = B.c.y - A.c.y;
  const d = Math.hypot(dx, dy);
  if (d < eps) return; // 같은 중심: 겹친 호는 끝점 단계에서
  const ex = dx / d;
  const ey = dy / d;
  const a = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  const tangent = Math.abs(d - (r1 + r2)) <= eps || Math.abs(d - Math.abs(r1 - r2)) <= eps;
  const pts: [number, number][] = [];
  if (tangent) pts.push([A.c.x + ex * a, A.c.y + ey * a]);
  else {
    const h2 = r1 * r1 - a * a;
    if (h2 <= 0) return;
    const h = Math.sqrt(h2);
    const mx = A.c.x + ex * a;
    const my = A.c.y + ey * a;
    pts.push([mx - ey * h, my + ex * h], [mx + ey * h, my - ex * h]);
  }
  for (const [x, y] of pts) {
    const ta = conicParam(A, x, y, eps);
    const tb = conicParam(B, x, y, eps);
    if (ta === null || tb === null) continue;
    report(ta, tb, x, y);
  }
}

/** 선분 교차 결과 버퍼: [s, u, x, y] × 최대 4 */
const HIT = new Float64Array(16);

/** 선분 교차(eps 허용). 평행이면 겹친 끝점들. 결과는 HIT, 개수를 돌려준다 */
function segSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, eps: number): number {
  let n = 0;
  const report = (s: number, u: number, x: number, y: number) => {
    HIT[n * 4] = s;
    HIT[n * 4 + 1] = u;
    HIT[n * 4 + 2] = x;
    HIT[n * 4 + 3] = y;
    n++;
  };
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const lr = Math.hypot(rx, ry);
  const ls = Math.hypot(sx, sy);
  if (lr < 1e-300 || ls < 1e-300) return 0;
  const qx = cx - ax;
  const qy = cy - ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) > 1e-9 * lr * ls) {
    const s = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    const es = eps / lr;
    const eu = eps / ls;
    if (s < -es || s > 1 + es || u < -eu || u > 1 + eu) return 0;
    const sc = Math.max(0, Math.min(1, s));
    const uc = Math.max(0, Math.min(1, u));
    const x1 = ax + rx * sc;
    const y1 = ay + ry * sc;
    const x2 = cx + sx * uc;
    const y2 = cy + sy * uc;
    if (Math.hypot(x1 - x2, y1 - y2) > eps * 2) return 0;
    report(sc, uc, (x1 + x2) / 2, (y1 + y2) / 2);
    return n;
  }
  // 평행: 같은 직선 위에서 겹칠 때만
  if (Math.abs(qx * ry - qy * rx) / lr > eps) return 0;
  const es = eps / lr;
  const eu = eps / ls;
  const s0 = (qx * rx + qy * ry) / (lr * lr);
  if (s0 >= -es && s0 <= 1 + es) report(Math.max(0, Math.min(1, s0)), 0, cx, cy);
  const s1 = ((dx - ax) * rx + (dy - ay) * ry) / (lr * lr);
  if (s1 >= -es && s1 <= 1 + es) report(Math.max(0, Math.min(1, s1)), 1, dx, dy);
  const u0 = (-qx * sx - qy * sy) / (ls * ls);
  if (u0 > eu && u0 < 1 - eu) report(0, u0, ax, ay);
  const u1 = ((bx - cx) * sx + (by - cy) * sy) / (ls * ls);
  if (u1 > eu && u1 < 1 - eu) report(1, u1, bx, by);
  return n;
}

function clampT(c: Curve, t: number): number {
  return c.closed ? t : Math.max(c.t0, Math.min(c.t1, t));
}

/** 곡선 위 가장 가까운 점의 매개변수(뉴턴) */
export function project(c: Curve, t: number, x: number, y: number): number {
  if (c.kind === 'line') {
    const ex = c.b.x - c.a.x;
    const ey = c.b.y - c.a.y;
    return Math.max(0, Math.min(1, ((x - c.a.x) * ex + (y - c.a.y) * ey) / (ex * ex + ey * ey)));
  }
  for (let it = 0; it < 12; it++) {
    const p = pointAt(c, t);
    const d = derivAt(c, t);
    const dd = d.x * d.x + d.y * d.y;
    if (dd < 1e-300) break;
    const step = ((x - p.x) * d.x + (y - p.y) * d.y) / dd;
    const nt = clampT(c, t + step);
    if (Math.abs(nt - t) < 1e-15 * (Math.abs(t) + 1)) {
      t = nt;
      break;
    }
    t = nt;
  }
  return t;
}

/** 다듬은 교점 버퍼: [ta, tb, x, y] */
const REF = new Float64Array(4);

/** 두 곡선 교점 다듬기(뉴턴). 결과는 REF, 실패하면 거짓 */
function refine(A: Curve, ta: number, B: Curve, tb: number, eps: number): boolean {
  let a = ta;
  let b = tb;
  for (let it = 0; it < 16; it++) {
    const p = pointAt(A, a);
    const q = pointAt(B, b);
    const fx = p.x - q.x;
    const fy = p.y - q.y;
    if (Math.hypot(fx, fy) < eps * 1e-6) break;
    const da = derivAt(A, a);
    const db = derivAt(B, b);
    const det = -da.x * db.y + da.y * db.x;
    if (Math.abs(det) < 1e-14 * Math.hypot(da.x, da.y) * Math.hypot(db.x, db.y)) return false;
    const dta = (-fx * -db.y - -db.x * -fy) / det;
    const dtb = (da.x * -fy - -fx * da.y) / det;
    a = clampT(A, a + dta);
    b = clampT(B, b + dtb);
  }
  const p = pointAt(A, a);
  const q = pointAt(B, b);
  if (Math.hypot(p.x - q.x, p.y - q.y) > eps) return false;
  // 다듬은 점이 처음 점에서 멀리 갔으면(다른 교점으로 수렴) 버린다
  const p0 = pointAt(A, ta);
  if (Math.hypot(p.x - p0.x, p.y - p0.y) > Math.max(eps * 1e3, spanOf(A) * 0.05)) return false;
  REF[0] = a;
  REF[1] = b;
  REF[2] = (p.x + q.x) / 2;
  REF[3] = (p.y + q.y) / 2;
  return true;
}

function spanOf(c: Curve): number {
  return Math.hypot(c.box.maxX - c.box.minX, c.box.maxY - c.box.minY);
}

// ---------------------------------------------------------------------------
// 조각
// ---------------------------------------------------------------------------

function makePieces(curves: Curve[], splits: Split[][], pool: VertexPool, eps: number): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i]!;
    const P = c.t1 - c.t0;
    let sp = splits[i]!.map((s) => ({ ...s }));
    if (c.closed) {
      for (const s of sp) {
        s.t = c.t0 + (((s.t - c.t0) % P) + P) % P;
        if (P - (s.t - c.t0) < P * 1e-12) s.t = c.t0;
      }
    }
    sp.sort((a, b) => a.t - b.t || a.v - b.v);
    // 같은 꼭짓점이 이어지면 하나로
    const uniq: Split[] = [];
    for (const s of sp) {
      const last = uniq[uniq.length - 1];
      if (last && last.v === s.v && chordLen(c, last.t, s.t) < eps * 4) continue;
      uniq.push(s);
    }
    sp = uniq;
    if (c.closed) {
      if (sp.length > 1 && sp[0]!.v === sp[sp.length - 1]!.v && chordLen(c, sp[sp.length - 1]!.t, sp[0]!.t + P) < eps * 4) sp.pop();
      if (sp.length === 0) {
        const p = pointAt(c, c.t0);
        sp.push({ t: c.t0, v: pool.add(p.x, p.y) });
      }
      if (sp.length === 1) {
        const t = sp[0]!.t + P / 2;
        const p = pointAt(c, t);
        sp.push({ t: t > c.t1 ? t - P : t, v: pool.add(p.x, p.y) });
        sp.sort((a, b) => a.t - b.t);
      }
    }
    const segs: [Split, Split, number][] = [];
    const n = sp.length;
    const m = c.closed ? n : n - 1;
    for (let k = 0; k < m; k++) {
      const a = sp[k]!;
      const b = sp[(k + 1) % n]!;
      const tb = k + 1 < n ? b.t : b.t + P;
      segs.push([a, b, tb]);
    }
    for (const [a, b, tb] of segs) {
      if (a.v === b.v) {
        if (!(tb > a.t)) continue;
        // 제자리로 돌아오는 조각은 가운데에 꼭짓점을 넣어 둘로
        if (chordLen(c, a.t, tb) < eps * 4) continue;
        const tm = (a.t + tb) / 2;
        const pm = pointAt(c, tm);
        const vm = pool.add(pm.x, pm.y);
        if (vm === a.v) continue;
        out.push(piece(c, i, a.t, tm, a.v, vm, pool));
        out.push(piece(c, i, tm, tb, vm, b.v, pool));
        continue;
      }
      out.push(piece(c, i, a.t, tb, a.v, b.v, pool));
    }
  }
  return out;
}

function chordLen(c: Curve, t0: number, t1: number): number {
  // 짧은 구간인지 대략 본다(세 점)
  const a = pointAt(c, t0);
  const m = pointAt(c, (t0 + t1) / 2);
  const b = pointAt(c, t1);
  return Math.hypot(m.x - a.x, m.y - a.y) + Math.hypot(b.x - m.x, b.y - m.y);
}

function piece(c: Curve, ci: number, ta: number, tb: number, va: number, vb: number, pool: VertexPool): Piece {
  const xs: number[] = [pool.x[va]!];
  const ys: number[] = [pool.y[va]!];
  const ts: number[] = [ta];
  const P = c.t1 - c.t0;
  const span = tb - ta;
  const gap = span * 1e-6;
  const addRange = (lo: number, hi: number, shift: number) => {
    // 곡선 표본 중 (lo, hi) 안쪽
    const T = c.ts;
    let k = lowerBound(T, lo + gap);
    for (; k < T.length && T[k]! < hi - gap; k++) {
      xs.push(c.xs[k]!);
      ys.push(c.ys[k]!);
      ts.push(T[k]! + shift);
    }
  };
  if (c.kind !== 'line') {
    if (tb <= c.t1 + 1e-15) addRange(ta, tb, 0);
    else {
      addRange(ta, c.t1, 0);
      addRange(c.t0, tb - P, P);
    }
  }
  xs.push(pool.x[vb]!);
  ys.push(pool.y[vb]!);
  ts.push(tb);
  let len = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < xs.length; k++) {
    if (k) len += Math.hypot(xs[k]! - xs[k - 1]!, ys[k]! - ys[k - 1]!);
    minX = Math.min(minX, xs[k]!);
    maxX = Math.max(maxX, xs[k]!);
    minY = Math.min(minY, ys[k]!);
    maxY = Math.max(maxY, ys[k]!);
  }
  return { curve: ci, ta, tb, va, vb, xs, ys, ts, len, alive: true, minX, minY, maxX, maxY };
}

function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** 같은 두 꼭짓점을 잇는 겹친 조각은 하나만 남긴다 */
function dedupe(pieces: Piece[], tol: number): Piece[] {
  const byKey = new Map<number, Piece[]>();
  const out: Piece[] = [];
  let nv = 0;
  for (const p of pieces) nv = Math.max(nv, p.va + 1, p.vb + 1);
  for (const p of pieces) {
    if (p.va === p.vb) continue;
    const k = p.va < p.vb ? p.va * nv + p.vb : p.vb * nv + p.va;
    const list = byKey.get(k);
    if (list) {
      const mid = midPoint(p);
      if (
        list.some((q) => {
          const m2 = midPoint(q);
          return Math.hypot(m2[0] - mid[0], m2[1] - mid[1]) <= tol && Math.abs(q.len - p.len) <= tol * 4 + p.len * 1e-3;
        })
      )
        continue;
      list.push(p);
    } else byKey.set(k, [p]);
    out.push(p);
  }
  return out;
}

function midPoint(p: Piece): [number, number] {
  const half = p.len / 2;
  let acc = 0;
  for (let k = 1; k < p.xs.length; k++) {
    const l = Math.hypot(p.xs[k]! - p.xs[k - 1]!, p.ys[k]! - p.ys[k - 1]!);
    if (acc + l >= half && l > 0) {
      const s = (half - acc) / l;
      return [p.xs[k - 1]! + (p.xs[k]! - p.xs[k - 1]!) * s, p.ys[k - 1]! + (p.ys[k]! - p.ys[k - 1]!) * s];
    }
    acc += l;
  }
  return [p.xs[0]!, p.ys[0]!];
}

/** 매달린 조각(한쪽 끝이 어디에도 이어지지 않음)을 반복해서 지운다 */
function prune(g: Graph): void {
  const nv = g.vx.length;
  const deg = new Int32Array(nv);
  const inc: number[][] = Array.from({ length: nv }, () => []);
  g.pieces.forEach((p, i) => {
    deg[p.va]!++;
    deg[p.vb]!++;
    inc[p.va]!.push(i);
    inc[p.vb]!.push(i);
  });
  const stack: number[] = [];
  for (let v = 0; v < nv; v++) if (deg[v] === 1) stack.push(v);
  while (stack.length) {
    const v = stack.pop()!;
    if (deg[v] !== 1) continue;
    for (const i of inc[v]!) {
      const p = g.pieces[i]!;
      if (!p.alive) continue;
      p.alive = false;
      deg[p.va]!--;
      deg[p.vb]!--;
      const o = p.va === v ? p.vb : p.va;
      if (deg[o] === 1) stack.push(o);
      break;
    }
  }
  g.pieces = g.pieces.filter((p) => p.alive);
}

/** 꼭짓점마다 나가는 반모서리를 각도순으로 */
function orderOutgoing(g: Graph): void {
  const nv = g.vx.length;
  const outs: number[][] = Array.from({ length: nv }, () => []);
  const minLen = new Float64Array(nv).fill(Infinity);
  g.pieces.forEach((p, i) => {
    outs[p.va]!.push(i * 2);
    outs[p.vb]!.push(i * 2 + 1);
    minLen[p.va] = Math.min(minLen[p.va]!, p.len);
    minLen[p.vb] = Math.min(minLen[p.vb]!, p.len);
  });
  const ang = new Float64Array(g.pieces.length * 2);
  for (let v = 0; v < nv; v++) {
    const list = outs[v]!;
    if (!list.length) continue;
    const delta = minLen[v]! * 1e-3;
    for (const h of list) ang[h] = leaveAngle(g, h, delta);
    list.sort((a, b) => ang[a]! - ang[b]!);
  }
  const slot = new Int32Array(g.pieces.length * 2);
  for (const list of outs) list.forEach((h, i) => (slot[h] = i));
  g.outs = outs;
  g.slot = slot;
}

/** 반모서리가 시작점을 떠나는 방향(호 길이 delta 지점) */
function leaveAngle(g: Graph, h: number, delta: number): number {
  const p = g.pieces[h >> 1]!;
  const c = g.curves[p.curve]!;
  if (c.kind === 'line') {
    // 꼭짓점 좌표 오차와 상관없이 선 방향 그대로
    const dx = c.b.x - c.a.x;
    const dy = c.b.y - c.a.y;
    return h & 1 ? Math.atan2(-dy, -dx) : Math.atan2(dy, dx);
  }
  const t = h & 1 ? p.tb : p.ta;
  const o = pointAt(c, t);
  const d = derivAt(c, t);
  const sp = Math.hypot(d.x, d.y);
  if (sp < 1e-300 || !(p.tb > p.ta)) {
    const v = h & 1 ? p.vb : p.va;
    const k = h & 1 ? p.xs.length - 2 : 1;
    return Math.atan2(p.ys[k]! - g.vy[v]!, p.xs[k]! - g.vx[v]!);
  }
  const dt = Math.min(delta / sp, (p.tb - p.ta) * 0.25);
  const q = pointAt(c, h & 1 ? t - dt : t + dt);
  return Math.atan2(q.y - o.y, q.x - o.x);
}

function components(g: Graph): void {
  const nv = g.vx.length;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (const p of g.pieces) {
    const a = find(p.va);
    const b = find(p.vb);
    if (a !== b) parent[a] = b;
  }
  const comp = new Int32Array(nv).fill(-1);
  const ids = new Map<number, number>();
  for (let v = 0; v < nv; v++) {
    if (!g.outs[v]!.length) continue;
    const r = find(v);
    let id = ids.get(r);
    if (id === undefined) {
      id = ids.size;
      ids.set(r, id);
    }
    comp[v] = id;
  }
  g.comp = comp;
  g.compCount = ids.size;
}

// ---------------------------------------------------------------------------
// 틈 잇기
// ---------------------------------------------------------------------------

/**
 * 매달린 끝점을 허용 거리 안의 다른 끝점(먼저) 또는 곡선 위 가장 가까운 점과 선분으로 잇는다.
 * 잇는 선분은 곡선 목록 끝에 붙고(src ''), 곡선 위 점은 쪼갤 점으로 더한다. 더한 것이 있으면 참.
 */
function bridgeGaps(curves: Curve[], splits: Split[][], pieces: Piece[], pool: VertexPool, gap: number, eps: number): boolean {
  const nv = pool.x.length;
  const deg = new Int32Array(nv);
  const inc: number[] = new Array(nv).fill(-1);
  pieces.forEach((p, i) => {
    deg[p.va]!++;
    deg[p.vb]!++;
    inc[p.va] = i;
    inc[p.vb] = i;
  });
  const dangling: number[] = [];
  for (let v = 0; v < nv; v++) if (deg[v] === 1) dangling.push(v);
  if (!dangling.length) return false;
  const bridges: [number, number][] = [];
  // 끝점끼리(가까운 순)
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < dangling.length; i++)
    for (let j = i + 1; j < dangling.length; j++) {
      const a = dangling[i]!;
      const b = dangling[j]!;
      const d = Math.hypot(pool.x[a]! - pool.x[b]!, pool.y[a]! - pool.y[b]!);
      if (d <= gap && d > 0) pairs.push([d, a, b]);
    }
  pairs.sort((p, q) => p[0] - q[0]);
  const used = new Set<number>();
  for (const [, a, b] of pairs) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    bridges.push([a, b]);
  }
  // 나머지는 곡선 위 가장 가까운 점으로
  for (const v of dangling) {
    if (used.has(v)) continue;
    const x = pool.x[v]!;
    const y = pool.y[v]!;
    let best: { d: number; c: number; t: number } | null = null;
    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi]!;
      if (pi === inc[v]) continue;
      if (x < p.minX - gap || x > p.maxX + gap || y < p.minY - gap || y > p.maxY + gap) continue;
      for (let k = 0; k + 1 < p.xs.length; k++) {
        const ax = p.xs[k]!;
        const ay = p.ys[k]!;
        const ex = p.xs[k + 1]! - ax;
        const ey = p.ys[k + 1]! - ay;
        const l2 = ex * ex + ey * ey;
        if (l2 < 1e-300) continue;
        const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
        const d = Math.hypot(ax + ex * u - x, ay + ey * u - y);
        if (d <= gap && (!best || d < best.d)) best = { d, c: p.curve, t: p.ts[k]! + (p.ts[k + 1]! - p.ts[k]!) * u };
      }
    }
    if (!best || best.d <= eps) continue;
    const c = curves[best.c]!;
    let t = project(c, best.t, x, y);
    if (c.closed) {
      const P = c.t1 - c.t0;
      t = c.t0 + (((t - c.t0) % P) + P) % P;
    }
    const q = pointAt(c, t);
    const w = pool.add(q.x, q.y);
    if (w === v) continue;
    splits[best.c]!.push({ t, v: w });
    bridges.push([v, w]);
  }
  for (const [a, b] of bridges) {
    const c: Curve = {
      kind: 'line',
      src: '',
      poly: false,
      bridge: true,
      t0: 0,
      t1: 1,
      closed: false,
      a: { x: pool.x[a]!, y: pool.y[a]! },
      b: { x: pool.x[b]!, y: pool.y[b]! },
      ts: [0, 1],
      xs: [pool.x[a]!, pool.x[b]!],
      ys: [pool.y[a]!, pool.y[b]!],
      box: { minX: Math.min(pool.x[a]!, pool.x[b]!), minY: Math.min(pool.y[a]!, pool.y[b]!), maxX: Math.max(pool.x[a]!, pool.x[b]!), maxY: Math.max(pool.y[a]!, pool.y[b]!) },
    };
    curves.push(c);
    splits.push([
      { t: 0, v: a },
      { t: 1, v: b },
    ]);
  }
  return bridges.length > 0;
}
