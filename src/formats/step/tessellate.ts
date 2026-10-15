/**
 * 면 삼각화.
 *
 * 1. 면 경계 고리(모서리 다각선을 이은 3D 점, 면끼리 같은 점을 쓴다)를 곡면의 매개변수 공간 (u,v)로 되짚는다.
 * 2. 주기 매개변수는 이어지게 펴고(unwrap), 극점(구·원뿔 꼭짓점 등)은 극선 위 여러 점으로 펼친다.
 *    한 바퀴 도는 고리 둘은 이음선(cut)으로 이어 띠 다각형 하나로, 한 바퀴 도는 고리 하나는 정의역 끝(극선)까지 닫는다.
 * 3. earcut으로 (구멍 포함) 다각형을 삼각화하고, 곡면에서 벗어나는(현 높이·법선 각·매개변수 간격) 안쪽 모서리를
 *    반으로 나누기를 되풀이하며 Lawson 뒤집기로 모양을 다듬는다. 경계 모서리는 나누지 않으므로 이웃 면과 틈이 없다.
 * 4. 정점은 곡면 위 점(경계는 원래 3D 점), 법선은 곡면에서 구하고 면 방향(same_sense)에 맞춰 감는다.
 */
import earcut, { deviation, refine as lawson } from 'earcut';
import type { Tol } from './curves';
import { cross, dist, dot, len, normalize, scale, sub, type V3 } from './math';
import type { Surface } from './surfaces';

/** 면 하나의 삼각형 그물(정점은 면마다 따로) */
export interface MeshOut {
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface FaceResult {
  triangles: number;
  /** 실패 이유(성공이면 없음) */
  error?: string;
}

export interface UV {
  u: number;
  v: number;
  /** 3D 위치(경계 점은 원래 모서리 점) */
  p: V3;
  /** 극점이면 극 번호 */
  pole: number;
}

const coord = (q: UV, d: number) => (d === 0 ? q.u : q.v);
const withCoord = (q: UV, d: number, val: number): UV => (d === 0 ? { ...q, u: val } : { ...q, v: val });

function wrapHalf(x: number, P: number): number {
  return x - Math.round(x / P) * P;
}

function signedArea(pts: UV[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]!.u - pts[i]!.u) * (pts[j]!.v + pts[i]!.v);
  return a / 2;
}

function isSlit(pts: UV[], area: number): boolean {
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const q of pts) {
    umin = Math.min(umin, q.u);
    umax = Math.max(umax, q.u);
    vmin = Math.min(vmin, q.v);
    vmax = Math.max(vmax, q.v);
  }
  const d2 = (umax - umin) ** 2 + (vmax - vmin) ** 2;
  return Math.abs(area) <= 1e-9 * d2;
}

/** 두 선분이 끝점이 아닌 곳에서 엇갈리는지 */
function segmentsCross(p: { u: number; v: number }, q: { u: number; v: number }, a: { u: number; v: number }, b: { u: number; v: number }): boolean {
  const o = (x: { u: number; v: number }, y: { u: number; v: number }, z: { u: number; v: number }) => (y.u - x.u) * (z.v - x.v) - (y.v - x.v) * (z.u - x.u);
  const d1 = o(p, q, a);
  const d2 = o(p, q, b);
  const d3 = o(a, b, p);
  const d4 = o(a, b, q);
  const scale = Math.max(Math.abs(q.u - p.u) + Math.abs(q.v - p.v), Math.abs(b.u - a.u) + Math.abs(b.v - a.v)) ** 2 * 1e-12;
  return ((d1 > scale && d2 < -scale) || (d1 < -scale && d2 > scale)) && ((d3 > scale && d4 < -scale) || (d3 < -scale && d4 > scale));
}

function pointInPoly(u: number, v: number, poly: UV[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.v > v !== b.v > v && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

export interface Polygon {
  outer: UV[];
  holes: UV[][];
}

interface LoopInfo {
  pts: UV[];
  /** 한 바퀴 도는 차원(-1이면 닫힌 고리)과 방향 */
  wrapDim: number;
  wrapSign: number;
  area: number;
}

/** 면 삼각화 맥락 */
class FaceDomain {
  readonly P: [number, number];
  readonly notes: string[] = [];
  constructor(
    readonly s: Surface,
    readonly tol: Tol,
    readonly eps: number,
  ) {
    this.P = [s.periodU, s.periodV];
  }

  private bound(d: number, hi: boolean): number {
    if (d === 0) return hi ? this.s.u1 : this.s.u0;
    return hi ? this.s.v1 : this.s.v0;
  }

  private poleOnLine(d: number, value: number): number {
    // 차원 d가 value로 고정된 극선이 있으면 번호
    for (let k = 0; k < this.s.poles.length; k++) {
      const pl = this.s.poles[k]!;
      if (pl.fixed === d && Math.abs(pl.value - value) < 1e-12 * (1 + Math.abs(value))) return k;
    }
    return -1;
  }

  /** 고리 3D 점 → (u,v), 주기 펴기·극점 펼치기까지 */
  mapLoop(pts3: V3[]): UV[] | null {
    const s = this.s;
    const raw: UV[] = [];
    let hint: [number, number] | null = null;
    for (const p of pts3) {
      const k = s.poleAt(p, this.eps);
      if (k >= 0) {
        const pl = s.poles[k]!;
        raw.push({ u: pl.fixed === 0 ? pl.value : NaN, v: pl.fixed === 1 ? pl.value : NaN, p, pole: k });
        continue;
      }
      const [u, v] = s.project(p, hint);
      hint = [u, v];
      raw.push({ u, v, p, pole: -1 });
    }
    // 극점을 스쳐 지나는 경계 토막(표본이 극점에 떨어지지 않은 경우): 가장 가까운 점에 가상 극점을 넣는다
    if (s.poles.length) {
      const poleP = s.poles.map((_, k) => s.polePoint(k));
      const lim = Math.max(this.eps, this.tol.chord);
      for (let i = raw.length - 1; i >= 0; i--) {
        const a = raw[i]!;
        const b = raw[(i + 1) % raw.length]!;
        if (a.pole >= 0 || b.pole >= 0 || raw.length < 2) continue;
        const d = sub(b.p, a.p);
        const l2 = dot(d, d);
        if (!(l2 > 0)) continue;
        for (let k = 0; k < poleP.length; k++) {
          const t = dot(sub(poleP[k]!, a.p), d) / l2;
          if (t <= 0 || t >= 1) continue;
          const m: V3 = [a.p[0] + d[0] * t, a.p[1] + d[1] * t, a.p[2] + d[2] * t];
          if (dist(m, poleP[k]!) > lim) continue;
          const pl = s.poles[k]!;
          raw.splice(i + 1, 0, { u: pl.fixed === 0 ? pl.value : NaN, v: pl.fixed === 1 ? pl.value : NaN, p: m, pole: k });
          break;
        }
      }
    }
    // 극점끼리 이어진 것 합치기, 같은 점이 이어진 것 지우기
    const pts: UV[] = [];
    for (const q of raw) {
      const last = pts[pts.length - 1];
      if (last && dist(last.p, q.p) <= this.eps * 1e-3) {
        if (q.pole >= 0 && last.pole < 0) pts[pts.length - 1] = q;
        continue;
      }
      pts.push(q);
    }
    while (pts.length > 1 && dist(pts[0]!.p, pts[pts.length - 1]!.p) <= this.eps * 1e-3) {
      const last = pts.pop()!;
      if (last.pole >= 0 && pts[0]!.pole < 0) pts[0] = last;
    }
    const regular = pts.filter((q) => q.pole < 0);
    if (regular.length < 2) return null;
    const n = pts.length;
    const free = (q: UV) => (q.pole >= 0 ? 1 - s.poles[q.pole]!.fixed : -1);

    // 주기 차원 펴기: 자유 차원이 그 차원인 극점 뒤에서 새 '토막'이 시작된다
    const runsByDim: number[][][] = [[], []];
    for (const d of [0, 1]) {
      const P = this.P[d]!;
      if (!(P > 0)) continue;
      let start = 0;
      const breaks: number[] = [];
      for (let i = 0; i < n; i++) if (free(pts[i]!) === d) breaks.push(i);
      if (breaks.length) start = (breaks[0]! + 1) % n;
      let ref = NaN;
      let run: number[] = [];
      const runs: number[][] = [];
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        const q = pts[i]!;
        if (free(q) === d) {
          if (run.length) runs.push(run);
          run = [];
          continue;
        }
        if (q.pole >= 0) continue; // 다른 차원이 자유인 극점(이 차원은 고정)
        let val = coord(q, d);
        if (!Number.isNaN(ref)) val += Math.round((ref - val) / P) * P;
        pts[i] = withCoord(q, d, val);
        ref = val;
        run.push(i);
      }
      if (run.length) runs.push(run);
      runsByDim[d] = runs;
    }
    // 여러 토막: 토막마다 주기 배수를 골라 넓이가 양수이면서 정의역을 넘지 않게
    for (const d of [0, 1]) {
      const runs = runsByDim[d]!;
      const P = this.P[d]!;
      if (runs.length < 2 || runs.length > 6) continue;
      const base = runs.map((r) => r.map((i) => coord(pts[i]!, d)));
      const full = this.fullArea();
      let bestK: number[] | null = null;
      let bestA = -Infinity;
      const ks = new Array<number>(runs.length).fill(0);
      const total = 3 ** (runs.length - 1);
      for (let c = 0; c < total; c++) {
        let x = c;
        for (let r = 1; r < runs.length; r++) {
          ks[r] = (x % 3) - 1;
          x = Math.floor(x / 3);
        }
        for (let r = 0; r < runs.length; r++)
          runs[r]!.forEach((i, j) => {
            pts[i] = withCoord(pts[i]!, d, base[r]![j]! + ks[r]! * P);
          });
        const a = signedArea(this.expandPoles(pts));
        if (a <= full * (1 + 1e-6) + 1e-12 && a > bestA) {
          bestA = a;
          bestK = ks.slice();
        }
      }
      const kk = bestK ?? ks.fill(0);
      for (let r = 0; r < runs.length; r++)
        runs[r]!.forEach((i, j) => {
          pts[i] = withCoord(pts[i]!, d, base[r]![j]! + kk[r]! * P);
        });
    }
    return this.expandPoles(pts);
  }

  private fullArea(): number {
    const s = this.s;
    const a = (s.u1 - s.u0) * (s.v1 - s.v0);
    return Number.isFinite(a) ? Math.abs(a) : Infinity;
  }

  /** 극점 하나를 앞뒤 점의 자유 좌표 사이 극선 위 점들로 펼친다 */
  private expandPoles(pts: UV[]): UV[] {
    const n = pts.length;
    if (!pts.some((q) => q.pole >= 0)) return pts;
    const out: UV[] = [];
    for (let i = 0; i < n; i++) {
      const q = pts[i]!;
      if (q.pole < 0) {
        out.push(q);
        continue;
      }
      const fixed = this.s.poles[q.pole]!.fixed;
      const fd = 1 - fixed;
      let prev: UV | null = null;
      let next: UV | null = null;
      for (let k = 1; k < n && !prev; k++) {
        const c = pts[(i - k + n) % n]!;
        if (c.pole < 0) prev = c;
      }
      for (let k = 1; k < n && !next; k++) {
        const c = pts[(i + k) % n]!;
        if (c.pole < 0) next = c;
      }
      if (!prev || !next) continue;
      const a = coord(prev, fd);
      const b = coord(next, fd);
      const steps = Math.max(1, Math.min(64, Math.ceil(Math.abs(b - a) / Math.max(this.tol.angle, 1e-3))));
      for (let k = 0; k <= steps; k++) {
        const t = a + ((b - a) * k) / steps;
        out.push(fd === 0 ? { u: t, v: q.v, p: q.p, pole: q.pole } : { u: q.u, v: t, p: q.p, pole: q.pole });
        if (a === b) break;
      }
    }
    return out;
  }

  classify(pts: UV[]): LoopInfo {
    for (const d of [0, 1]) {
      const P = this.P[d]!;
      if (!(P > 0)) continue;
      const first = coord(pts[0]!, d);
      const last = coord(pts[pts.length - 1]!, d);
      const travel = last - first + wrapHalf(first - last, P);
      const k = Math.round(travel / P);
      if (k !== 0) return { pts, wrapDim: d, wrapSign: Math.sign(k), area: 0 };
    }
    return { pts, wrapDim: -1, wrapSign: 0, area: signedArea(pts) };
  }

  /** uv 선분 a→b 사이 안쪽 점(곡면 위)을 허용 오차에 맞춰 */
  private cutSamples(a: UV, b: UV): UV[] {
    const out: UV[] = [];
    const s = this.s;
    const cosLim = Math.cos(this.tol.angle);
    const rec = (ua: number, va: number, pa: V3, na: V3, ub: number, vb: number, pb: V3, nb: V3, depth: number) => {
      const um = (ua + ub) / 2;
      const vm = (va + vb) / 2;
      const pm = s.point(um, vm);
      const mid: V3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const err = dist(pm, mid);
      const bend = dot(na, nb) < cosLim && dist(pa, pb) > this.tol.chord;
      if (depth < 12 && (err > this.tol.chord || bend)) {
        const nm = s.normal(um, vm);
        rec(ua, va, pa, na, um, vm, pm, nm, depth + 1);
        out.push({ u: um, v: vm, p: pm, pole: -1 });
        rec(um, vm, pm, nm, ub, vb, pb, nb, depth + 1);
      }
    };
    const pa = this.surfPoint(a);
    const pb = this.surfPoint(b);
    rec(a.u, a.v, pa, s.normal(a.u, a.v), b.u, b.v, pb, s.normal(b.u, b.v), 0);
    // 극선 위 점은 극점 하나로
    for (const q of out) {
      const k = this.s.poleAt(q.p, this.eps);
      if (k >= 0) {
        q.p = this.s.polePoint(k);
        q.pole = k;
      }
    }
    return out;
  }

  private surfPoint(q: UV): V3 {
    return q.p;
  }

  /** 고리 a를 i에서 돌려 세우고 한 주기 옮긴 첫 점을 끝에 붙인다 */
  private rotateWrap(L: LoopInfo, i: number): UV[] {
    const d = L.wrapDim;
    const P = this.P[d]! * L.wrapSign;
    const n = L.pts.length;
    const out: UV[] = [];
    for (let k = 0; k < n; k++) {
      const j = (i + k) % n;
      const q = L.pts[j]!;
      out.push(j < i ? withCoord(q, d, coord(q, d) + P) : q);
    }
    out.push(withCoord(out[0]!, d, coord(out[0]!, d) + P));
    return out;
  }

  /** uv 선분 p→q가 고리들(주기만큼 옮긴 것 포함)의 변과 엇갈리는지 */
  private cutCrosses(p: UV, q: UV, loops: UV[][], d: number): boolean {
    const P = this.P[d]!;
    const shifts = P > 0 ? [-P, 0, P] : [0];
    for (const l of loops)
      for (const sh of shifts)
        for (let i = 0; i < l.length; i++) {
          const a = l[i]!;
          const b = l[(i + 1) % l.length]!;
          const ax = coord(a, d) + sh;
          const bx = coord(b, d) + sh;
          const A = d === 0 ? { u: ax, v: a.v } : { u: a.u, v: ax };
          const B = d === 0 ? { u: bx, v: b.v } : { u: b.u, v: bx };
          if (segmentsCross(p, q, A, B)) return true;
        }
    return false;
  }

  /** 띠 이음선: 아래 고리의 꼭대기 쪽 점에서 위 고리의 가까운 점으로, 고리·구멍과 엇갈리지 않는 것 */
  private pickBandCut(A: LoopInfo, B: LoopInfo, d: number, o: number, holes: LoopInfo[], c: number): [number, number] {
    const P = this.P[d]!;
    const order = A.pts.map((_, i) => i).filter((i) => A.pts[i]!.pole < 0);
    // 구멍을 피한 위치에 가까운 것 먼저, 그다음 높은 것
    order.sort((x, y) => {
      const dx = Math.abs(wrapHalf(coord(A.pts[x]!, d) - c, P));
      const dy = Math.abs(wrapHalf(coord(A.pts[y]!, d) - c, P));
      return dx - dy || coord(A.pts[y]!, o) - coord(A.pts[x]!, o);
    });
    const loops = [A.pts, B.pts, ...holes.map((h) => h.pts)];
    for (const ia of order.slice(0, 96)) {
      const a = A.pts[ia]!;
      const ib = this.nearestIndex(B.pts, d, coord(a, d));
      let bq = B.pts[ib]!;
      bq = withCoord(bq, d, coord(bq, d) + Math.round((coord(a, d) - coord(bq, d)) / P) * P);
      if (!this.cutCrosses(a, bq, loops, d)) return [ia, ib];
    }
    return [this.nearestIndex(A.pts, d, c), this.nearestIndex(B.pts, d, coord(A.pts[this.nearestIndex(A.pts, d, c)]!, d))];
  }

  /** 극선(정의역 끝)까지 닫는 이음선: 고리·구멍과 엇갈리지 않는 점(끝 쪽으로 가장 나온 점 우선) */
  private pickCapCut(A: LoopInfo, d: number, o: number, bound: number, holes: LoopInfo[], c: number): number {
    const P = this.P[d]!;
    const order = A.pts.map((_, i) => i).filter((i) => A.pts[i]!.pole < 0);
    order.sort((x, y) => {
      const ox = Math.abs(coord(A.pts[x]!, o) - bound);
      const oy = Math.abs(coord(A.pts[y]!, o) - bound);
      return ox - oy || Math.abs(wrapHalf(coord(A.pts[x]!, d) - c, P)) - Math.abs(wrapHalf(coord(A.pts[y]!, d) - c, P));
    });
    const loops = [A.pts, ...holes.map((h) => h.pts)];
    for (const ia of order.slice(0, 96)) {
      const a = A.pts[ia]!;
      if (!this.cutCrosses(a, withCoord(a, o, bound), loops, d)) return ia;
    }
    return this.nearestIndex(A.pts, d, c);
  }

  private nearestIndex(pts: UV[], d: number, c: number): number {
    const P = this.P[d]!;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i]!.pole >= 0) continue;
      const dd = Math.abs(wrapHalf(coord(pts[i]!, d) - c, P));
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    return best;
  }

  /** 구멍들이 차지하지 않는 이음선 위치(주기 차원 d) */
  private cutValue(d: number, holes: LoopInfo[], dflt: number): number {
    const P = this.P[d]!;
    const iv: [number, number][] = [];
    for (const h of holes) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of h.pts) {
        lo = Math.min(lo, coord(q, d));
        hi = Math.max(hi, coord(q, d));
      }
      if (hi - lo >= P) return dflt;
      const a = ((lo % P) + P) % P;
      iv.push([a, a + (hi - lo)]);
    }
    if (!iv.length) return dflt;
    // 겹친 구간 합치고 가장 넓은 틈 가운데
    iv.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of iv) {
      const m = merged[merged.length - 1];
      if (m && a <= m[1]) m[1] = Math.max(m[1], b);
      else merged.push([a, b]);
    }
    let bestGap = -1;
    let best = dflt;
    for (let i = 0; i < merged.length; i++) {
      const end = merged[i]![1];
      const nextStart = i + 1 < merged.length ? merged[i + 1]![0] : merged[0]![0] + P;
      const gap = nextStart - end;
      if (gap > bestGap) {
        bestGap = gap;
        best = end + gap / 2;
      }
    }
    return best;
  }

  /** 고리들 → 다각형(바깥 + 구멍) 목록 */
  build(loops: LoopInfo[]): Polygon[] | string {
    // 넓이 없는 '틈' 고리(같은 모서리를 갔다 오는 고리)는 영역을 정하지 않는다
    loops = loops.filter((l) => l.wrapDim >= 0 || !isSlit(l.pts, l.area));
    if (!loops.length) return this.fullDomain();
    const closed = loops.filter((l) => l.wrapDim < 0);
    const wrapping = loops.filter((l) => l.wrapDim >= 0);
    let outers = closed.filter((l) => l.area > 0);
    let holes = closed.filter((l) => l.area <= 0);
    const polys: Polygon[] = [];

    if (wrapping.length) {
      const d = wrapping[0]!.wrapDim;
      const o = 1 - d;
      const P = this.P[d]!;
      const ws = wrapping.filter((l) => l.wrapDim === d);
      // 다른 차원 평균으로 정렬
      const avg = (l: LoopInfo) => l.pts.reduce((s, q) => s + coord(q, o), 0) / l.pts.length;
      ws.sort((a, b) => avg(a) - avg(b));
      // d=0(u로 돈다): +방향 고리는 위(v 큰 쪽)가 면, d=1: +방향 고리는 u 작은 쪽이 면
      const lowSign = d === 0 ? 1 : -1;
      if (ws.length > 2) this.notes.push('한 면에 한 바퀴 도는 고리가 셋 이상(앞의 둘만 씀)');
      let main: UV[];
      if (ws.length >= 2) {
        // 방향이 맞는 짝(아래 고리는 lowSign, 위 고리는 반대)이면 방향을 믿고, 다른 차원이 주기면 위 고리를 아래 고리 위로 옮긴다
        const Po = this.P[o]!;
        const lows = ws.filter((l) => l.wrapSign === lowSign);
        const highs = ws.filter((l) => l.wrapSign === -lowSign);
        let A: LoopInfo;
        let B: LoopInfo;
        if (lows.length && highs.length && (Po > 0 || avg(highs[0]!) > avg(lows[0]!))) {
          A = lows[0]!;
          B = highs[0]!;
          if (Po > 0) {
            const k = Math.floor((avg(B) - avg(A)) / Po);
            if (k) B = { ...B, pts: B.pts.map((q) => withCoord(q, o, coord(q, o) - k * Po)) };
          }
        } else {
          A = ws[0]!;
          B = ws[1]!;
          if (A.wrapSign !== lowSign) A = this.reverseInfo(A);
          if (B.wrapSign !== -lowSign) B = this.reverseInfo(B);
        }
        const c = this.cutValue(d, holes, coord(A.pts[0]!, d));
        const [ia, ib] = this.pickBandCut(A, B, d, o, holes, c);
        const Ar = this.rotateWrap(A, ia);
        let Br = this.rotateWrap(B, ib);
        // B 첫 점이 A 끝 점(한 주기 옮긴 첫 점) 근처에 오게
        const shift = Math.round((coord(Ar[Ar.length - 1]!, d) - coord(Br[0]!, d)) / P) * P;
        if (shift) Br = Br.map((q) => withCoord(q, d, coord(q, d) + shift));
        // 이음선: A 첫 점 → B 끝 점(같은 3D 곡선을 한 주기 옮겨 반대쪽에도 쓴다)
        const cut = this.cutSamples(Ar[0]!, Br[Br.length - 1]!);
        const sh = coord(Ar[Ar.length - 1]!, d) - coord(Ar[0]!, d);
        main = [...Ar, ...cut.map((q) => withCoord(q, d, coord(q, d) + sh)), ...Br, ...cut.slice().reverse()];
      } else {
        const A = ws[0]!;
        const hiSide = (d === 0) === A.wrapSign > 0;
        const b = this.bound(o, hiSide);
        if (!Number.isFinite(b)) return '한 바퀴 도는 경계 하나로는 닫을 수 없는 면';
        const c = this.cutValue(d, holes, coord(A.pts[0]!, d));
        const Ar = this.rotateWrap(A, this.pickCapCut(A, d, o, b, holes, c));
        const first = Ar[0]!;
        const lastQ = Ar[Ar.length - 1]!;
        const sh = coord(lastQ, d) - coord(first, d);
        const poleK = this.poleOnLine(o, b);
        const corner = (q: UV): UV => {
          const r = withCoord(q, o, b);
          const p = poleK >= 0 ? this.s.polePoint(poleK) : this.s.point(r.u, r.v);
          return { ...r, p, pole: poleK };
        };
        const c0 = corner(first);
        const c1 = { ...withCoord(c0, d, coord(c0, d) + sh), p: c0.p };
        const cut = this.cutSamples(first, c0);
        // 극선(또는 정의역 끝) 위: lastQ 쪽에서 first 쪽으로
        const line: UV[] = [];
        const steps = Math.max(1, Math.min(256, Math.ceil(Math.abs(sh) / Math.max(this.tol.angle, 1e-3))));
        for (let k = 1; k < steps; k++) {
          const r = withCoord(c1, d, coord(c1, d) - (sh * k) / steps);
          line.push(poleK >= 0 ? { ...r, p: c1.p } : { ...r, p: this.s.point(r.u, r.v) });
        }
        const lineFine = poleK >= 0 ? line : this.refineLine(c1, line, c0);
        main = [...Ar, ...cut.map((q) => withCoord(q, d, coord(q, d) + sh)), c1, ...lineFine, c0, ...cut.slice().reverse()];
      }
      polys.push({ outer: main, holes: [] });
      // 구멍을 주 다각형 범위로 옮긴다(닫힌 바깥 고리가 따로 있으면 별도 다각형)
      for (const h of holes) polys[0]!.holes.push(this.shiftInto(h.pts, main));
      for (const l of outers) polys.push({ outer: this.shiftInto(l.pts, main), holes: [] });
      return polys;
    }

    if (!outers.length && holes.length) {
      // 닫힌 곡면(구·원환 등)에 구멍만 있으면 정의역 전체가 바깥
      const s = this.s;
      if ((s.periodU > 0 || s.periodV > 0) && [s.u0, s.u1, s.v0, s.v1].every(Number.isFinite)) return this.fullDomain(holes);
      // 아니면 방향이 뒤집힌 파일: 가장 큰 것을 바깥으로
      holes.sort((a, b) => a.area - b.area);
      const big = this.reverseInfo(holes[0]!);
      outers = [big];
      holes = holes.slice(1);
    }
    if (!outers.length) return '경계 고리 없음';
    outers.sort((a, b) => b.area - a.area);
    for (const o of outers) polys.push({ outer: o.pts, holes: [] });
    for (const h of holes) {
      let target = polys[0]!;
      let pts = this.shiftInto(h.pts, target.outer);
      if (polys.length > 1) {
        for (const pg of polys) {
          const cand = this.shiftInto(h.pts, pg.outer);
          const q = cand[0]!;
          if (pointInPoly(q.u, q.v, pg.outer)) {
            target = pg;
            pts = cand;
            break;
          }
        }
      }
      target.holes.push(pts);
    }
    return polys;
  }

  private refineLine(a: UV, line: UV[], b: UV): UV[] {
    // 정의역 끝(극이 아닌) 선: 곡면 위 점 그대로 쓰되 충분히 촘촘하게
    const all = [a, ...line, b];
    const out: UV[] = [];
    for (let i = 0; i + 1 < all.length; i++) {
      if (i > 0) out.push(all[i]!);
      out.push(...this.cutSamples(all[i]!, all[i + 1]!));
    }
    return out;
  }

  private reverseInfo(l: LoopInfo): LoopInfo {
    const pts = l.pts.slice().reverse();
    return { pts, wrapDim: l.wrapDim, wrapSign: -l.wrapSign, area: -l.area };
  }

  /** 고리를 주기만큼 옮겨 기준 다각형의 범위 안으로 */
  private shiftInto(pts: UV[], ref: UV[]): UV[] {
    let out = pts;
    for (const d of [0, 1]) {
      const P = this.P[d]!;
      if (!(P > 0)) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of ref) {
        lo = Math.min(lo, coord(q, d));
        hi = Math.max(hi, coord(q, d));
      }
      const c = out.reduce((s, q) => s + coord(q, d), 0) / out.length;
      let k = 0;
      if (c < lo || c > hi) k = Math.round(((lo + hi) / 2 - c) / P);
      if (k) out = out.map((q) => withCoord(q, d, coord(q, d) + k * P));
    }
    return out;
  }

  /** 정의역 전체(경계 없는 닫힌 곡면: 구 전체, 원환 전체) */
  fullDomain(holes: LoopInfo[] = []): Polygon[] | string {
    const s = this.s;
    if (![s.u0, s.u1, s.v0, s.v1].every(Number.isFinite)) return '경계 없는 면(정의역이 무한)';
    // 주기 차원은 구멍을 피해 이음선 위치를 고른다
    const U0 = s.periodU > 0 ? this.cutValue(0, holes, s.u0) : s.u0;
    const V0 = s.periodV > 0 ? this.cutValue(1, holes, s.v0) : s.v0;
    const U1 = U0 + (s.u1 - s.u0);
    const V1 = V0 + (s.v1 - s.v0);
    const mk = (u: number, v: number): UV => {
      let pole = -1;
      for (let k = 0; k < s.poles.length; k++) {
        const pl = s.poles[k]!;
        if ((pl.fixed === 0 ? u : v) === pl.value) pole = k;
      }
      return { u, v, p: pole >= 0 ? s.polePoint(pole) : s.point(u, v), pole };
    };
    const c00 = mk(U0, V0);
    const c10 = { ...mk(U1, V0), p: s.periodU > 0 ? c00.p : s.point(U1, V0) };
    const c01 = { ...mk(U0, V1), p: s.periodV > 0 ? c00.p : s.point(U0, V1) };
    const c11 = { ...mk(U1, V1), p: s.periodU > 0 ? c01.p : s.periodV > 0 ? c10.p : s.point(U1, V1) };
    if (c00.pole >= 0) c10.p = c00.p;
    if (c01.pole >= 0) c11.p = c01.p;
    // 이음선(주기 차원의 양 끝) 점은 같은 3D를 쓰게 한 번만 구한다
    const right = this.edgeSamples(c10, c11);
    const bottom = this.edgeSamples(c00, c10);
    const top = s.periodV > 0 ? bottom.map((q) => ({ ...q, v: V1 })).reverse() : this.edgeSamples(c11, c01);
    const left = s.periodU > 0 ? right.map((q) => ({ ...q, u: U0 })).reverse() : this.edgeSamples(c01, c00);
    const outer: UV[] = [c00, ...bottom, c10, ...right, c11, ...top, c01, ...left];
    return [{ outer, holes: holes.map((h) => this.shiftInto(h.pts, outer)) }];
  }

  private edgeSamples(a: UV, b: UV): UV[] {
    if (a.pole >= 0 && a.pole === b.pole) {
      const out: UV[] = [];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.u - a.u), Math.abs(b.v - a.v)) / Math.max(this.tol.angle, 1e-3)));
      for (let k = 1; k < steps; k++) out.push({ u: a.u + ((b.u - a.u) * k) / steps, v: a.v + ((b.v - a.v) * k) / steps, p: a.p, pole: a.pole });
      return out;
    }
    return this.cutSamples(a, b);
  }
}

/** 삼각화 결과를 다듬는 데 쓰는 정점 저장소 */
class Verts {
  u: number[] = [];
  v: number[] = [];
  xy: number[] = [];
  p: number[] = [];
  n: number[] = [];
  constructor(
    readonly s: Surface,
    readonly su: number,
    readonly sv: number,
  ) {}
  add(u: number, v: number, p: V3, nrm?: V3): number {
    const i = this.u.length;
    this.u.push(u);
    this.v.push(v);
    this.xy.push(u * this.su, v * this.sv);
    this.p.push(p[0], p[1], p[2]);
    const nn = nrm ?? this.s.normal(u, v);
    this.n.push(nn[0], nn[1], nn[2]);
    return i;
  }
  P(i: number): V3 {
    return [this.p[i * 3]!, this.p[i * 3 + 1]!, this.p[i * 3 + 2]!];
  }
  N(i: number): V3 {
    return [this.n[i * 3]!, this.n[i * 3 + 1]!, this.n[i * 3 + 2]!];
  }
}

const KEY = 67108864; // 2^26

/** 곡면 오차·법선 각·매개변수 간격으로 안쪽 모서리를 나누는 되풀이 */
function refineMesh(vs: Verts, tris: number[], tol: Tol, maxTris: number): number[] {
  const s = vs.s;
  const cosLim = Math.cos(tol.angle);
  for (let round = 0; round < 14; round++) {
    const ntri = tris.length / 3;
    // 모서리 → 삼각형 수
    const count = new Map<number, number>();
    for (let t = 0; t < ntri; t++)
      for (let e = 0; e < 3; e++) {
        const a = tris[t * 3 + e]!;
        const b = tris[t * 3 + ((e + 1) % 3)]!;
        const k = a < b ? a * KEY + b : b * KEY + a;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    const split = new Map<number, number>();
    const want = (a: number, b: number): boolean => {
      const Pa = vs.P(a);
      const Pb = vs.P(b);
      const l = dist(Pa, Pb);
      const du = Math.abs(vs.u[a]! - vs.u[b]!);
      const dv = Math.abs(vs.v[a]! - vs.v[b]!);
      if (du > s.maxStepU || dv > s.maxStepV) return l > tol.chord * 0.5;
      if (l <= tol.chord * 0.25) return false;
      const um = (vs.u[a]! + vs.u[b]!) / 2;
      const vm = (vs.v[a]! + vs.v[b]!) / 2;
      const pm = s.point(um, vm);
      const err = dist(pm, [(Pa[0] + Pb[0]) / 2, (Pa[1] + Pb[1]) / 2, (Pa[2] + Pb[2]) / 2]);
      if (err > tol.chord) return true;
      return dot(vs.N(a), vs.N(b)) < cosLim && l > tol.chord;
    };
    const mark = (a: number, b: number) => {
      const k = a < b ? a * KEY + b : b * KEY + a;
      if (split.has(k) || count.get(k) !== 2) return;
      split.set(k, -1);
    };
    for (const [k, c] of count) {
      if (c !== 2) continue;
      const a = Math.floor(k / KEY);
      const b = k - a * KEY;
      if (want(a, b)) split.set(k, -1);
    }
    // 삼각형 가운데가 곡면에서 멀면 가장 긴 안쪽 모서리를 나눈다
    for (let t = 0; t < ntri; t++) {
      const a = tris[t * 3]!;
      const b = tris[t * 3 + 1]!;
      const c = tris[t * 3 + 2]!;
      const uc = (vs.u[a]! + vs.u[b]! + vs.u[c]!) / 3;
      const vc = (vs.v[a]! + vs.v[b]! + vs.v[c]!) / 3;
      const Pa = vs.P(a);
      const Pb = vs.P(b);
      const Pc = vs.P(c);
      const flat: V3 = [(Pa[0] + Pb[0] + Pc[0]) / 3, (Pa[1] + Pb[1] + Pc[1]) / 3, (Pa[2] + Pb[2] + Pc[2]) / 3];
      if (dist(s.point(uc, vc), flat) <= tol.chord) continue;
      const es: [number, number, number][] = [
        [a, b, dist(Pa, Pb)],
        [b, c, dist(Pb, Pc)],
        [c, a, dist(Pc, Pa)],
      ];
      es.sort((x, y) => y[2] - x[2]);
      for (const [x, y] of es) {
        const k = x < y ? x * KEY + y : y * KEY + x;
        if (count.get(k) === 2) {
          mark(x, y);
          break;
        }
      }
    }
    if (!split.size) break;
    if (ntri + split.size * 2 > maxTris) break;
    for (const k of split.keys()) {
      const a = Math.floor(k / KEY);
      const b = k - a * KEY;
      const um = (vs.u[a]! + vs.u[b]!) / 2;
      const vm = (vs.v[a]! + vs.v[b]!) / 2;
      split.set(k, vs.add(um, vm, s.point(um, vm)));
    }
    const mid = (a: number, b: number) => split.get(a < b ? a * KEY + b : b * KEY + a) ?? -1;
    const nt: number[] = [];
    for (let t = 0; t < ntri; t++) {
      const a = tris[t * 3]!;
      const b = tris[t * 3 + 1]!;
      const c = tris[t * 3 + 2]!;
      const m0 = mid(a, b);
      const m1 = mid(b, c);
      const m2 = mid(c, a);
      const code = (m0 >= 0 ? 1 : 0) | (m1 >= 0 ? 2 : 0) | (m2 >= 0 ? 4 : 0);
      switch (code) {
        case 0:
          nt.push(a, b, c);
          break;
        case 1:
          nt.push(a, m0, c, m0, b, c);
          break;
        case 2:
          nt.push(a, b, m1, a, m1, c);
          break;
        case 4:
          nt.push(a, b, m2, m2, b, c);
          break;
        case 3:
          nt.push(m0, b, m1, a, m0, m1, a, m1, c);
          break;
        case 6:
          nt.push(m2, m1, c, a, b, m1, a, m1, m2);
          break;
        case 5:
          nt.push(a, m0, m2, m0, b, c, m0, c, m2);
          break;
        default:
          nt.push(a, m0, m2, m0, b, m1, m2, m1, c, m0, m1, m2);
      }
    }
    tris = nt;
    lawson(tris, vs.xy, 2);
  }
  return tris;
}

/** 매개변수 공간 다각형(바깥 + 구멍) — 고리 3D 점과 그 (u,v), 극점 번호 */
export type FacePolygon = Polygon;

/**
 * 면 경계 고리 → 곡면 매개변수 공간 다각형들(실패하면 이유 문자열).
 * 고리는 면 경계 방향(면 법선 쪽에서 볼 때 면이 왼쪽)이 반영된 3D 점이다.
 */
export function faceDomain(s: Surface, loops: V3[][], sameSense: boolean, tol: Tol, eps: number): FacePolygon[] | string {
  const dom = new FaceDomain(s, tol, eps);
  s.projTol = Math.max(eps, tol.chord * 0.05);
  const infos: LoopInfo[] = [];
  for (const l of loops) {
    if (l.length < 2) continue;
    const pts3 = sameSense ? l : l.slice().reverse();
    const uv = dom.mapLoop(pts3);
    if (!uv || uv.length < 3) continue;
    infos.push(dom.classify(uv));
  }
  return infos.length ? dom.build(infos) : dom.fullDomain();
}

/**
 * 면 하나를 삼각화해 out에 붙인다.
 * @param loops 면 경계 고리(3D, 면 경계 방향 반영, 처음 점 반복 없음)
 * @param sameSense 면 법선이 곡면 법선과 같은 방향인지
 * @param eps 같은 점으로 볼 거리
 */
export function tessellateFace(s: Surface, loops: V3[][], sameSense: boolean, tol: Tol, eps: number, out: MeshOut, maxTris = 400_000): FaceResult {
  const polys = faceDomain(s, loops, sameSense, tol, eps);
  if (typeof polys === 'string') return { triangles: 0, error: polys };

  // 매개변수 배율: 곡률에 맞춘 비등방 거리(굽은 방향은 허용 걸음 1, 곧은 방향은 면 크기 1)
  const [su, sv] = faceMetric(s, polys, tol);

  let total = 0;
  for (const pg of polys) {
    const vs = new Verts(s, su, sv);
    const holeIdx: number[] = [];
    const ring = (r: UV[]) => {
      for (const q of r) vs.add(q.u, q.v, q.p);
    };
    ring(pg.outer);
    for (const h of pg.holes) {
      holeIdx.push(vs.u.length);
      ring(h);
    }
    let tris = triangulateRobust(vs.xy, holeIdx, vs.u.length);
    if (!tris.length) continue;
    // 반시계(uv)로 맞추기: earcut 결과는 한 방향으로 감기므로 넓이 합의 부호로 한꺼번에(거의 평평한 삼각형의 반올림 부호에 휘둘리지 않게)
    let signed = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!;
      const b = tris[t + 1]!;
      const c = tris[t + 2]!;
      signed += (vs.xy[b * 2]! - vs.xy[a * 2]!) * (vs.xy[c * 2 + 1]! - vs.xy[a * 2 + 1]!) - (vs.xy[c * 2]! - vs.xy[a * 2]!) * (vs.xy[b * 2 + 1]! - vs.xy[a * 2 + 1]!);
    }
    if (signed < 0)
      for (let t = 0; t < tris.length; t += 3) {
        const b = tris[t + 1]!;
        tris[t + 1] = tris[t + 2]!;
        tris[t + 2] = b;
      }
    if (!s.planar) {
      lawson(tris, vs.xy, 2);
      tris = refineMesh(vs, tris, tol, maxTris);
    }
    total += emit(vs, tris, sameSense, out);
  }
  return { triangles: total };
}

/**
 * 넓이 0 삼각형(세 점이 일직선, earcut이 드물게 만든다)을 없앤다: 가운데 점으로 긴 모서리 건너편 삼각형을 둘로 나눈다.
 * (곡면 위에서는 일직선 매개변수가 3D 지느러미가 되므로)
 */
function fixFlatTriangles(tris: number[], xy: number[]): number[] {
  const area2 = (a: number, b: number, c: number) =>
    (xy[b * 2]! - xy[a * 2]!) * (xy[c * 2 + 1]! - xy[a * 2 + 1]!) - (xy[c * 2]! - xy[a * 2]!) * (xy[b * 2 + 1]! - xy[a * 2 + 1]!);
  const d2 = (a: number, b: number) => (xy[b * 2]! - xy[a * 2]!) ** 2 + (xy[b * 2 + 1]! - xy[a * 2 + 1]!) ** 2;
  const flat = (t: number) => {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    if (a < 0) return false;
    const m = Math.max(d2(a, b), d2(b, c), d2(c, a));
    return Math.abs(area2(a, b, c)) <= 1e-12 * m;
  };
  let any = false;
  for (let t = 0; t < tris.length; t += 3) if (flat(t)) any = true;
  if (!any) return tris;
  tris = tris.slice();
  const dir = new Map<number, number>();
  const reg = (t: number) => {
    for (let e = 0; e < 3; e++) dir.set(tris[t + e]! * KEY + tris[t + ((e + 1) % 3)]!, t);
  };
  for (let t = 0; t < tris.length; t += 3) reg(t);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let t = 0; t < tris.length; t += 3) {
      if (!flat(t)) continue;
      // 가장 긴 모서리 a→b와 가운데 점 c
      let best = 0;
      let bl = -1;
      for (let e = 0; e < 3; e++) {
        const l = d2(tris[t + e]!, tris[t + ((e + 1) % 3)]!);
        if (l > bl) {
          bl = l;
          best = e;
        }
      }
      const a = tris[t + best]!;
      const b = tris[t + ((best + 1) % 3)]!;
      const c = tris[t + ((best + 2) % 3)]!;
      const n = dir.get(b * KEY + a);
      tris[t] = tris[t + 1] = tris[t + 2] = -1;
      changed = true;
      if (n === undefined || tris[n]! < 0) continue;
      const tri = [tris[n]!, tris[n + 1]!, tris[n + 2]!];
      const r = tri.indexOf(b);
      if (r < 0 || tri[(r + 1) % 3] !== a) continue;
      const d = tri[(r + 2) % 3]!;
      tris[n] = b;
      tris[n + 1] = c;
      tris[n + 2] = d;
      reg(n);
      tris.push(c, a, d);
      reg(tris.length - 3);
    }
    if (!changed) break;
  }
  return tris.filter((_, i) => tris[i - (i % 3)]! >= 0);
}

/**
 * earcut을 좌표를 돌려 가며 몇 번 시도해, 넓이 0 삼각형이 없고 넓이 합이 다각형 넓이와 맞는 결과를 고른다.
 * (축에 나란한 일직선 경계가 earcut의 수평 다리 광선과 겹치거나, 돌린 좌표의 반올림으로 일직선 점이 볼록 귀로 보이는 경우를 피한다)
 */
export function triangulateRobust(xy: number[], holeIdx: number[], nv: number): number[] {
  const rings: [number, number][] = [];
  const starts = [0, ...holeIdx, nv];
  for (let i = 0; i + 1 < starts.length; i++) rings.push([starts[i]!, starts[i + 1]!]);
  let best: number[] = [];
  let bestScore = Infinity;
  for (const [ang, simplify] of [
    [0, true],
    [0.3719, true],
    [1.1173, true],
    [2.0021, true],
    [0, false],
    [0.3719, false],
  ] as const) {
    let data = xy;
    if (ang) {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      data = new Array<number>(xy.length);
      for (let i = 0; i < xy.length; i += 2) {
        data[i] = xy[i]! * c - xy[i + 1]! * s;
        data[i + 1] = xy[i]! * s + xy[i + 1]! * c;
      }
    }
    let t = simplify ? earcutSimplified(data, holeIdx, nv) : earcut(data, holeIdx.length ? holeIdx : null, 2);
    if (!t.length) continue;
    t = restoreRingVertices(t, rings, nv);
    t = fixFlatTriangles(t, xy);
    const dev = deviation(xy, holeIdx.length ? holeIdx : null, 2, t);
    const flats = countFlat(t, xy);
    const stray = strayBoundaryEdges(t, rings);
    const score = (flats + stray) * 1e3 + (Number.isFinite(dev) ? dev : 1e6);
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
    if (!flats && !stray && dev < 1e-9) break;
  }
  return best;
}

/** 삼각형 하나만 쓰는 모서리 가운데 고리의 이웃 점 쌍이 아닌 것(T자 이음·겹침) */
function strayBoundaryEdges(tris: number[], rings: [number, number][]): number {
  const cnt = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e]!;
      const b = tris[t + ((e + 1) % 3)]!;
      const k = a < b ? a * KEY + b : b * KEY + a;
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
  const ringEdge = new Set<number>();
  for (const [s0, s1] of rings)
    for (let i = s0; i < s1; i++) {
      const a = i;
      const b = i + 1 < s1 ? i + 1 : s0;
      ringEdge.add(a < b ? a * KEY + b : b * KEY + a);
    }
  let n = 0;
  for (const [k, c] of cnt) if ((c === 1 && !ringEdge.has(k)) || c > 2) n++;
  return n;
}

function countFlat(tris: number[], xy: number[]): number {
  let n = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const ux = xy[b * 2]! - xy[a * 2]!;
    const uy = xy[b * 2 + 1]! - xy[a * 2 + 1]!;
    const vx = xy[c * 2]! - xy[a * 2]!;
    const vy = xy[c * 2 + 1]! - xy[a * 2 + 1]!;
    const m = Math.max(ux * ux + uy * uy, vx * vx + vy * vy, (vx - ux) ** 2 + (vy - uy) ** 2);
    if (Math.abs(ux * vy - uy * vx) <= 1e-12 * m) n++;
  }
  return n;
}

/**
 * 고리마다 일직선 위 점(앞뒤와 같은 방향으로 이어지는 점)을 빼고 earcut에 넘긴다.
 * earcut은 일직선 점이 많으면 넓이 0 삼각형이나 겹친 다리를 만들 수 있어서, 뺀 점은 뒤에 restoreRingVertices가 부채꼴로 되살린다.
 */
export function earcutSimplified(xy: number[], holeIdx: number[], nv: number): number[] {
  const starts = [0, ...holeIdx, nv];
  const keep: number[] = [];
  const holes: number[] = [];
  for (let r = 0; r + 1 < starts.length; r++) {
    const s0 = starts[r]!;
    const s1 = starts[r + 1]!;
    const n = s1 - s0;
    const ring: number[] = [];
    // 일직선 판정 거리: 고리 크기의 1e-8(매개변수 되짚기 반올림 흔들림은 넘는다)
    let xmin = Infinity;
    let xmax = -Infinity;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let k = s0; k < s1; k++) {
      xmin = Math.min(xmin, xy[k * 2]!);
      xmax = Math.max(xmax, xy[k * 2]!);
      ymin = Math.min(ymin, xy[k * 2 + 1]!);
      ymax = Math.max(ymax, xy[k * 2 + 1]!);
    }
    const lineTol = 1e-8 * Math.hypot(xmax - xmin, ymax - ymin);
    for (let k = 0; k < n; k++) {
      const i = s0 + k;
      const prev = ring.length ? ring[ring.length - 1]! : s0 + ((k - 1 + n) % n);
      const next = s0 + ((k + 1) % n);
      const ax = xy[i * 2]! - xy[prev * 2]!;
      const ay = xy[i * 2 + 1]! - xy[prev * 2 + 1]!;
      const bx = xy[next * 2]! - xy[i * 2]!;
      const by = xy[next * 2 + 1]! - xy[i * 2 + 1]!;
      const cr = ax * by - ay * bx;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      // 앞 점→다음 점 직선에서 이 점까지 거리
      const cx = ax + bx;
      const cy = ay + by;
      const lc = Math.hypot(cx, cy);
      const off = lc > 0 ? Math.abs(ax * cy - ay * cx) / lc : la;
      if (la > 0 && lb > 0 && (off <= lineTol || Math.abs(cr) <= 1e-10 * la * lb) && ax * bx + ay * by > 0) continue;
      ring.push(i);
    }
    if (ring.length < 3) {
      if (r === 0) return [];
      continue;
    }
    if (r > 0) holes.push(keep.length);
    keep.push(...ring);
  }
  const data: number[] = [];
  for (const i of keep) data.push(xy[i * 2]!, xy[i * 2 + 1]!);
  const t = earcut(data, holes.length ? holes : null, 2);
  return t.map((k) => keep[k]!);
}

/**
 * 삼각형에 쓰이지 않은 고리 점(earcut이 일직선이라 걸러 낸 점)을 그 점을 지나는 경계 모서리의 삼각형을 쪼개 다시 넣는다.
 */
function restoreRingVertices(tris: number[], rings: [number, number][], nv: number): number[] {
  const used = new Uint8Array(nv);
  for (const i of tris) used[i] = 1;
  let missing = false;
  for (const [a, b] of rings) for (let i = a; i < b; i++) if (!used[i]) missing = true;
  if (!missing) return tris;
  const dir = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3)
    for (let e = 0; e < 3; e++) dir.set(tris[t + e]! * KEY + tris[t + ((e + 1) % 3)]!, t);
  const out = tris.slice();
  // 쪼갠 삼각형의 모서리를 다시 적어 둔다(한 삼각형에 빠진 점 무리가 둘 이상일 때)
  const reg = (t: number) => {
    for (let e = 0; e < 3; e++) dir.set(out[t + e]! * KEY + out[t + ((e + 1) % 3)]!, t);
  };
  for (const [s0, s1] of rings) {
    const n = s1 - s0;
    let first = -1;
    for (let i = 0; i < n; i++) if (used[s0 + i]) {
      first = i;
      break;
    }
    if (first < 0) continue;
    for (let k = 0; k < n; ) {
      const ia = s0 + ((first + k) % n);
      let j = 1;
      const run: number[] = [];
      while (j < n && !used[s0 + ((first + k + j) % n)]) {
        run.push(s0 + ((first + k + j) % n));
        j++;
      }
      const ib = s0 + ((first + k + j) % n);
      k += j;
      if (!run.length) continue;
      let t = dir.get(ia * KEY + ib);
      let fwd = true;
      if (t === undefined) {
        t = dir.get(ib * KEY + ia);
        fwd = false;
      }
      if (t === undefined) continue;
      // 삼각형을 (x, y, c) — x→y가 그 모서리 — 로 돌려 세운다
      const tri = [out[t]!, out[t + 1]!, out[t + 2]!];
      const x = fwd ? ia : ib;
      const r = tri.indexOf(x);
      const c = tri[(r + 2) % 3]!;
      const chain = fwd ? [ia, ...run, ib] : [ib, ...run.slice().reverse(), ia];
      out[t] = chain[0]!;
      out[t + 1] = chain[1]!;
      out[t + 2] = c;
      reg(t);
      for (let q = 1; q + 1 < chain.length; q++) {
        out.push(chain[q]!, chain[q + 1]!, c);
        reg(out.length - 3);
      }
      for (const v of run) used[v] = 1;
    }
  }
  return out;
}

/**
 * 면의 비등방 배율 [u배율, v배율]: 매개변수 1 걸음이 허용 오차(현 높이·각) 안에서 갈 수 있는 거리의 몇 배인지.
 * 법선이 도는 빠르기(유한 차분)로 방향별 곡률을 재고, 곧은 방향은 면의 3D 크기로 나눈다.
 * 이 공간에서 Delaunay 다듬기를 하면 원기둥은 길쭉한 삼각형, 구는 고른 삼각형이 된다.
 */
export function faceMetric(s: Surface, polys: Polygon[], tol: Tol): [number, number] {
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const pg of polys)
    for (const q of pg.outer) {
      umin = Math.min(umin, q.u);
      umax = Math.max(umax, q.u);
      vmin = Math.min(vmin, q.v);
      vmax = Math.max(vmax, q.v);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, q.p[k]!);
        hi[k] = Math.max(hi[k]!, q.p[k]!);
      }
    }
  const diag = Math.max(dist(lo, hi), tol.chord);
  const hu = Math.max((umax - umin) * 1e-4, 1e-9);
  const hv = Math.max((vmax - vmin) * 1e-4, 1e-9);
  let rateU = 0; // 매개변수당 법선 회전(라디안)
  let rateV = 0;
  let lenU = 0; // 매개변수당 3D 길이
  let lenV = 0;
  let cnt = 0;
  const N = 5;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const u = umin + ((umax - umin) * (i + 0.5)) / N;
      const v = vmin + ((vmax - vmin) * (j + 0.5)) / N;
      const [, du, dv] = s.derivs(u, v);
      const a = len(du);
      const b = len(dv);
      if (!(a > 1e-12 * diag) || !(b > 1e-12 * diag)) continue;
      const ru = angleBetween(s.normal(u - hu, v), s.normal(u + hu, v)) / (2 * hu);
      const rv = angleBetween(s.normal(u, v - hv), s.normal(u, v + hv)) / (2 * hv);
      rateU = Math.max(rateU, ru);
      rateV = Math.max(rateV, rv);
      lenU += a;
      lenV += b;
      cnt++;
    }
  if (!cnt) return [1, 1];
  lenU /= cnt;
  lenV /= cnt;
  // 방향별 허용 걸음(매개변수)
  const stepOf = (rate: number, l: number): number => {
    if (!(rate > 1e-9 * (l / diag))) return Infinity;
    const rho = l / rate; // 곡률 반지름
    let ang = tol.angle;
    if (rho > tol.chord) ang = Math.min(ang, 2 * Math.acos(1 - tol.chord / rho));
    return ang / rate;
  };
  const stU = stepOf(rateU, lenU);
  const stV = stepOf(rateV, lenV);
  const ku = Number.isFinite(stU) ? 1 / stU : lenU / diag;
  const kv = Number.isFinite(stV) ? 1 / stV : lenV / diag;
  // 한쪽만 굽었으면 곧은 쪽도 너무 작아지지 않게(길쭉함 제한 1:50)
  const mx = Math.max(ku, kv);
  return [Math.max(ku, mx / 50), Math.max(kv, mx / 50)];
}

function angleBetween(a: V3, b: V3): number {
  const c = dot(a, b);
  const x = len(cross(a, b));
  return Math.atan2(x, c);
}

function emit(vs: Verts, tris: number[], sameSense: boolean, out: MeshOut): number {
  const base = out.positions.length / 3;
  const sign = sameSense ? 1 : -1;
  const nv = vs.u.length;
  const used = new Int32Array(nv).fill(-1);
  let count = 0;
  let next = base;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    const b = tris[t + 1]!;
    const c = tris[t + 2]!;
    const Pa = vs.P(a);
    const Pb = vs.P(b);
    const Pc = vs.P(c);
    // 3D에서 넓이 없는 삼각형(극선 위)은 버린다
    if (samePt(Pa, Pb) || samePt(Pb, Pc) || samePt(Pc, Pa)) continue;
    const ids = sameSense ? [a, b, c] : [a, c, b];
    for (const i of ids) {
      if (used[i]! < 0) {
        used[i] = next++;
        out.positions.push(vs.p[i * 3]!, vs.p[i * 3 + 1]!, vs.p[i * 3 + 2]!);
        out.normals.push(vs.n[i * 3]! * sign, vs.n[i * 3 + 1]! * sign, vs.n[i * 3 + 2]! * sign);
      }
      out.indices.push(used[i]!);
    }
    count++;
  }
  return count;
}

function samePt(a: V3, b: V3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** 평면 다각형(구멍 포함)을 뉴얼 법선 평면에 투영해 삼각화(FACE·POLY_LOOP, 곡면을 모를 때) */
export function tessellatePlanarLoops(loops: V3[][], normalHint: V3 | null, out: MeshOut): number {
  const rings = loops.filter((l) => l.length >= 3);
  if (!rings.length) return 0;
  // 뉴얼 법선(가장 큰 고리)
  let n: V3 = [0, 0, 0];
  let best = -1;
  for (const r of rings) {
    const m = newell(r);
    const l = len(m);
    if (l > best) {
      best = l;
      n = m;
    }
  }
  if (normalHint && len(normalHint) > 0) {
    if (best <= 0) n = normalHint;
    else if (dot(n, normalHint) < 0) n = scale(n, -1);
  }
  if (len(n) === 0) return 0;
  n = normalize(n);
  const ax: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize(sub(ax, scale(n, dot(ax, n))));
  const y = cross(n, x);
  // 가장 큰 고리를 바깥으로
  const areas = rings.map((r) => {
    const m = newell(r);
    return dot(m, n) / 2;
  });
  let oi = 0;
  for (let i = 1; i < rings.length; i++) if (Math.abs(areas[i]!) > Math.abs(areas[oi]!)) oi = i;
  const order = [oi, ...rings.map((_, i) => i).filter((i) => i !== oi)];
  const xy: number[] = [];
  const pts: V3[] = [];
  const holes: number[] = [];
  for (const i of order) {
    if (i !== oi) holes.push(pts.length);
    for (const p of rings[i]!) {
      xy.push(dot(p, x), dot(p, y));
      pts.push(p);
    }
  }
  const tris = earcut(xy, holes.length ? holes : null, 2);
  const base = out.positions.length / 3;
  for (const p of pts) {
    out.positions.push(p[0], p[1], p[2]);
    out.normals.push(n[0], n[1], n[2]);
  }
  let c = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!;
    let b = tris[t + 1]!;
    let cc = tris[t + 2]!;
    const ar = (xy[b * 2]! - xy[a * 2]!) * (xy[cc * 2 + 1]! - xy[a * 2 + 1]!) - (xy[cc * 2]! - xy[a * 2]!) * (xy[b * 2 + 1]! - xy[a * 2 + 1]!);
    if (ar < 0) [b, cc] = [cc, b];
    out.indices.push(base + a, base + b, base + cc);
    c++;
  }
  return c;
}

export function newell(r: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}
