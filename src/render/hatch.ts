/**
 * 해치: 경계 고리 만들기, 채우기 삼각분할, 무늬 선 자르기.
 * 좌표는 해치 OCS(2D)다. 호출한 쪽이 월드로 옮긴다.
 */
import earcut from 'earcut';
import type { HatchEntity, HatchPath, HatchPatternLine } from '../core/model';
import { arcPoints, bulgeFlatPoints, ccwSweep, ellipsePoints, interpolateFitPoints, nurbsPoints } from '../geom/curves';
import { dashInterval } from './linetype';

/** 경로 하나 → 닫힌 고리 [x, y, …] */
export function pathLoop(p: HatchPath, tol: number): number[] {
  if (p.polyline) return bulgeFlatPoints(p.polyline.verts, true, tol);
  const out: number[] = [];
  const push = (x: number, y: number) => {
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2]! - x) < 1e-12 && Math.abs(out[n - 1]! - y) < 1e-12) return;
    out.push(x, y);
  };
  for (const e of p.edges ?? []) {
    switch (e.type) {
      case 'line':
        push(e.start.x, e.start.y);
        push(e.end.x, e.end.y);
        break;
      case 'arc': {
        const sweep = ccwSweep(e.startAngle, e.endAngle);
        const pts = arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, sweep, tol);
        if (!e.ccw) reversePairs(pts);
        for (let i = 0; i < pts.length; i += 2) push(pts[i]!, pts[i + 1]!);
        break;
      }
      case 'ellipse': {
        // 해치 타원 경계의 각도는 기하 각도 → 매개변수로
        const toParam = (a: number) => Math.atan2(Math.sin(a) / (e.ratio || 1), Math.cos(a));
        const p0 = toParam(e.startAngle);
        let p1 = toParam(e.endAngle);
        const full = Math.abs(ccwSweep(e.startAngle, e.endAngle) - Math.PI * 2) < 1e-9;
        if (full) p1 = p0 + Math.PI * 2;
        const pts = ellipsePoints(e.center.x, e.center.y, e.majorAxis.x, e.majorAxis.y, e.ratio, p0, p1, tol);
        if (!e.ccw) reversePairs(pts);
        for (let i = 0; i < pts.length; i += 2) push(pts[i]!, pts[i + 1]!);
        break;
      }
      case 'spline': {
        let ctrl = e.controlPoints.map((q) => ({ x: q.x, y: q.y, z: 0 }));
        let knots = e.knots;
        let degree = e.degree;
        if (ctrl.length < 2 && e.fitPoints && e.fitPoints.length >= 2) {
          const s = interpolateFitPoints(
            e.fitPoints.map((q) => ({ x: q.x, y: q.y, z: 0 })),
            e.startTangent ? { x: e.startTangent.x, y: e.startTangent.y, z: 0 } : undefined,
            e.endTangent ? { x: e.endTangent.x, y: e.endTangent.y, z: 0 } : undefined,
          );
          ctrl = s.ctrl;
          knots = s.knots;
          degree = s.degree;
        }
        const pts = nurbsPoints(degree, knots, ctrl, e.rational ? e.weights : undefined, tol);
        for (let i = 0; i < pts.length; i += 3) push(pts[i]!, pts[i + 1]!);
        break;
      }
    }
  }
  // 닫힘점 제거
  const n = out.length;
  if (n >= 4 && Math.abs(out[0]! - out[n - 2]!) < 1e-9 && Math.abs(out[1]! - out[n - 1]!) < 1e-9) out.length = n - 2;
  return out;
}

function reversePairs(a: number[]): void {
  for (let i = 0, j = a.length - 2; i < j; i += 2, j -= 2) {
    const x = a[i]!;
    const y = a[i + 1]!;
    a[i] = a[j]!;
    a[i + 1] = a[j + 1]!;
    a[j] = x;
    a[j + 1] = y;
  }
}

function pointInRing(x: number, y: number, c: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, n = c.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = c[i]!;
    const yi = c[i + 1]!;
    const xj = c[j]!;
    const yj = c[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 해치 스타일에 따라 쓸 고리를 고른다(2 = 가장 바깥만). */
export function hatchLoops(h: HatchEntity, tol: number): number[][] {
  let loops = h.paths.map((p) => ({ p, ring: pathLoop(p, tol) })).filter((l) => l.ring.length >= 6);
  if (h.hatchStyle === 2) {
    const outer = loops.filter((l) => l.p.flags & 1 || l.p.flags & 16);
    if (outer.length) loops = outer;
  }
  return loops.map((l) => l.ring);
}

/** 고리들을 홀짝 규칙으로 삼각분할 */
export function triangulateLoops(loops: number[][]): number[] {
  const depth = loops.map((c, i) => {
    let d = 0;
    // 고리 안쪽 점: 첫 변의 중점을 조금 안으로
    const x = (c[0]! + c[2]!) / 2;
    const y = (c[1]! + c[3]!) / 2;
    for (let j = 0; j < loops.length; j++) if (j !== i && pointInRing(x, y, loops[j]!)) d++;
    return d;
  });
  const out: number[] = [];
  for (let i = 0; i < loops.length; i++) {
    if (depth[i]! % 2 !== 0) continue;
    const outer = loops[i]!;
    const flat = [...outer];
    const holes: number[] = [];
    for (let j = 0; j < loops.length; j++) {
      if (j === i || depth[j] !== depth[i]! + 1) continue;
      const h = loops[j]!;
      if (!pointInRing((h[0]! + h[2]!) / 2, (h[1]! + h[3]!) / 2, outer)) continue;
      holes.push(flat.length / 2);
      flat.push(...h);
    }
    const idx = earcut(flat, holes, 2);
    for (const k of idx) out.push(flat[k * 2]!, flat[k * 2 + 1]!);
  }
  return out;
}

/** 무늬 선이 너무 많으면 그리지 않는다 */
export const HATCH_LINE_LIMIT = 40000;

/**
 * 무늬 선을 경계로 자른다. 결과: 선분 [x0, y0, x1, y1, …], 너무 많으면 null
 */
export function patternSegments(lines: readonly HatchPatternLine[], loops: number[][], limit = HATCH_LINE_LIMIT): number[] | null {
  const out: number[] = [];
  if (!loops.length) return out;
  // 경계 상자
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of loops)
    for (let i = 0; i < l.length; i += 2) {
      minX = Math.min(minX, l[i]!);
      maxX = Math.max(maxX, l[i]!);
      minY = Math.min(minY, l[i + 1]!);
      maxY = Math.max(maxY, l[i + 1]!);
    }
  const corners = [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
  let count = 0;
  for (const pl of lines) {
    const ux = Math.cos(pl.angle);
    const uy = Math.sin(pl.angle);
    // 선 사이 간격 = 오프셋의 법선 성분
    const nx = -uy;
    const ny = ux;
    const spacing = pl.offset.x * nx + pl.offset.y * ny;
    if (Math.abs(spacing) < 1e-12) continue;
    // 상자 꼭짓점의 법선 방향 거리로 k 범위
    let dMin = Infinity;
    let dMax = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      const d = (corners[i]! - pl.base.x) * nx + (corners[i + 1]! - pl.base.y) * ny;
      dMin = Math.min(dMin, d);
      dMax = Math.max(dMax, d);
    }
    let k0 = Math.ceil(dMin / spacing);
    let k1 = Math.floor(dMax / spacing);
    if (k0 > k1) [k0, k1] = [k1, k0];
    if (k1 - k0 > limit) return null;
    const dashes = pl.dashes;
    const period = dashes.reduce((a, b) => a + Math.abs(b), 0);
    for (let k = k0; k <= k1; k++) {
      // 선 k의 원점(무늬 시작)
      const ox = pl.base.x + pl.offset.x * k;
      const oy = pl.base.y + pl.offset.y * k;
      // 모든 경계 변과 교차
      const ts: number[] = [];
      for (const l of loops) {
        const n = l.length;
        for (let i = 0; i < n; i += 2) {
          const j = (i + 2) % n;
          const ax = l[i]!;
          const ay = l[i + 1]!;
          const bx = l[j]!;
          const by = l[j + 1]!;
          const da = (ax - ox) * nx + (ay - oy) * ny;
          const db = (bx - ox) * nx + (by - oy) * ny;
          if ((da > 0) === (db > 0)) continue;
          if (da === db) continue;
          const s = da / (da - db);
          const px = ax + (bx - ax) * s;
          const py = ay + (by - ay) * s;
          ts.push((px - ox) * ux + (py - oy) * uy);
        }
      }
      if (ts.length < 2) continue;
      ts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const t0 = ts[i]!;
        const t1 = ts[i + 1]!;
        if (t1 - t0 < 1e-12) continue;
        dashInterval(t0, t1, dashes, period, (a, b) => {
          out.push(ox + ux * a, oy + uy * a, ox + ux * b, oy + uy * b);
          count++;
        });
        if (count > limit * 8) return null;
      }
    }
  }
  return out;
}

/** 사용자 정의 무늬(_USER 등)가 선 정의 없이 왔을 때 각도·간격으로 만든다. */
export function userPattern(h: HatchEntity): HatchPatternLine[] {
  const a = h.patternAngle;
  const s = h.patternScale || 1;
  const off = { x: -Math.sin(a) * s, y: Math.cos(a) * s };
  const lines: HatchPatternLine[] = [{ angle: a, base: { x: 0, y: 0 }, offset: off, dashes: [] }];
  if (h.patternDouble) lines.push({ angle: a + Math.PI / 2, base: { x: 0, y: 0 }, offset: { x: -Math.cos(a) * s, y: -Math.sin(a) * s }, dashes: [] });
  return lines;
}
