/**
 * 스마트 치수(DIM)의 순수 계산: 고른(마우스를 올린) 객체에서 만들 치수 종류 추정, 선형/정렬 선택,
 * 정렬(G)·분산(D) 옵션의 치수 자리 계산.
 * - 선·폴리선 직선 세그먼트 → 선형(수평·수직) 또는 정렬. 원 → 지름, 호·폴리선 호 세그먼트 → 반지름.
 * - 선형/정렬: 커서가 두 점을 잇는 선분의 수직 띠 안이면 정렬(기울어진 선분일 때), 밖이면 DIMLINEAR와 같은 자동 수평·수직.
 *   수평·수직 선분은 늘 그 방향의 선형 치수다.
 */
import type { DimensionEntity, Entity, Vec3 } from '../../core/model';
import { bulgeArc } from '../../geom/curves';
import { angularVertex, extDir, isAngularDim, isLinearDim, linearDir } from '../annot/dimedit';

export interface P {
  x: number;
  y: number;
}

export type SmartTarget =
  | { kind: 'line'; a: P; b: P; /** 폴리선 세그먼트 번호(선이면 없음) */ segment?: number }
  | { kind: 'circle'; c: P; r: number }
  | { kind: 'arc'; c: P; r: number; /** 반시계 시작·끝 각 */ a0: number; a1: number; segment?: number };

export type SmartKind = 'linear' | 'aligned' | 'diameter' | 'radius';

const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });

/** 객체의 치수 대상(가까운 폴리선 세그먼트). 치수를 만들 수 없는 객체는 null */
export function smartTarget(e: Entity | undefined, pick: P): SmartTarget | null {
  if (!e) return null;
  if (e.type === 'LINE') {
    if (Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) < 1e-12) return null;
    return { kind: 'line', a: { x: e.start.x, y: e.start.y }, b: { x: e.end.x, y: e.end.y } };
  }
  if (e.type === 'CIRCLE') return planar(e.extrusion) ? { kind: 'circle', c: { x: e.center.x, y: e.center.y }, r: e.radius } : null;
  if (e.type === 'ARC') return planar(e.extrusion) ? { kind: 'arc', c: { x: e.center.x, y: e.center.y }, r: e.radius, a0: e.startAngle, a1: e.endAngle } : null;
  if (e.type === 'LWPOLYLINE' && e.vertices.length >= 2 && planar(e.extrusion)) {
    const vs = e.vertices;
    const n = e.closed ? vs.length : vs.length - 1;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      const d = segmentDistance(a, b, a.bulge, pick);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return null;
    const a = vs[best]!;
    const b = vs[(best + 1) % vs.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) return null;
    if (Math.abs(a.bulge) > 1e-12) {
      const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
      if (!arc) return null;
      const s = arc.a0;
      const e2 = arc.a0 + arc.sweep;
      // 반시계 호로(시계 방향 세그먼트는 끝과 시작을 바꾼다)
      return arc.sweep >= 0
        ? { kind: 'arc', c: { x: arc.cx, y: arc.cy }, r: arc.r, a0: s, a1: e2, segment: best }
        : { kind: 'arc', c: { x: arc.cx, y: arc.cy }, r: arc.r, a0: e2, a1: s, segment: best };
    }
    return { kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, segment: best };
  }
  return null;
}

const planar = (n: Vec3 | undefined) => !n || (Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0);

function segmentDistance(a: P, b: P, bulge: number, q: P): number {
  if (Math.abs(bulge) > 1e-12) {
    const arc = bulgeArc(a.x, a.y, b.x, b.y, bulge);
    if (arc) {
      // 호 위 가장 가까운 점(호 범위 밖이면 가까운 끝)
      const ang = Math.atan2(q.y - arc.cy, q.x - arc.cx);
      if (onSweep(ang, arc.a0, arc.sweep)) return Math.abs(Math.hypot(q.x - arc.cx, q.y - arc.cy) - arc.r);
      return Math.min(Math.hypot(q.x - a.x, q.y - a.y), Math.hypot(q.x - b.x, q.y - b.y));
    }
  }
  const d = sub(b, a);
  const L = dot(d, d) || 1;
  const t = Math.max(0, Math.min(1, dot(sub(q, a), d) / L));
  return Math.hypot(a.x + d.x * t - q.x, a.y + d.y * t - q.y);
}

function onSweep(ang: number, a0: number, sweep: number): boolean {
  const TAU = 2 * Math.PI;
  const rel = (((ang - a0) % TAU) + TAU) % TAU;
  return sweep >= 0 ? rel <= sweep + 1e-12 : TAU - rel <= -sweep + 1e-12 || rel < 1e-12;
}

/** 대상의 기본 치수 종류 */
export function defaultSmartKind(t: SmartTarget): SmartKind {
  return t.kind === 'circle' ? 'diameter' : t.kind === 'arc' ? 'radius' : 'linear';
}

/** 수평(0)·수직(π/2) 자동: 커서가 두 점의 X 범위 안이면 수평, Y 범위 안이면 수직, 그 밖은 더 멀리 벗어난 쪽 */
export function autoLinearRotation(p1: P, p2: P, q: P): number {
  const outX = Math.max(0, Math.min(p1.x, p2.x) - q.x, q.x - Math.max(p1.x, p2.x));
  const outY = Math.max(0, Math.min(p1.y, p2.y) - q.y, q.y - Math.max(p1.y, p2.y));
  if (outX === 0 && outY === 0) return Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y) ? 0 : Math.PI / 2;
  return outY >= outX ? 0 : Math.PI / 2;
}

/**
 * 두 점 치수의 종류: 정렬이면 { aligned: true }, 선형이면 회전(0 수평, π/2 수직).
 * 수평·수직 선분은 늘 그 방향, 기울어진 선분은 커서가 수직 띠 안이면 정렬.
 */
export function linearChoice(p1: P, p2: P, q: P, tol = 1e-9): { aligned: true } | { aligned: false; rotation: number } {
  const d = sub(p2, p1);
  const L = Math.hypot(d.x, d.y);
  if (!(L > 0)) return { aligned: false, rotation: 0 };
  if (Math.abs(d.y) <= tol * Math.max(1, L)) return { aligned: false, rotation: 0 };
  if (Math.abs(d.x) <= tol * Math.max(1, L)) return { aligned: false, rotation: Math.PI / 2 };
  const t = dot(sub(q, p1), d) / (L * L);
  if (t >= 0 && t <= 1) return { aligned: true };
  return { aligned: false, rotation: autoLinearRotation(p1, p2, q) };
}

/** 마우스를 올렸을 때의 미리보기 치수선 자리: 선분에서 커서 쪽(선 위면 왼쪽)으로 dist 떨어진 가운데 점 */
export function hoverDimLinePoint(a: P, b: P, cursor: P, dist: number): P {
  const d = sub(b, a);
  const L = Math.hypot(d.x, d.y) || 1;
  const n = { x: -d.y / L, y: d.x / L };
  const side = dot(sub(cursor, a), n) < 0 ? -1 : 1;
  return { x: (a.x + b.x) / 2 + n.x * dist * side, y: (a.y + b.y) / 2 + n.y * dist * side };
}

/** 원 위의 점(중심에서 p 방향) */
export function pointOnCircle(c: P, r: number, p: P): P {
  const a = Math.atan2(p.y - c.y, p.x - c.x);
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

/** 두 선이 거의 나란한지(각도 치수를 만들 수 없음) */
export function parallelLines(a1: P, a2: P, b1: P, b2: P): boolean {
  const u = sub(a2, a1);
  const v = sub(b2, b1);
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (!(lu > 0) || !(lv > 0)) return true;
  return Math.abs((u.x * v.y - u.y * v.x) / (lu * lv)) < 1e-9;
}

// ---------------------------------------------------------------------------
// 정렬(G)·분산(D)
// ---------------------------------------------------------------------------

const mv = (q: Vec3, d: P, k: number): Vec3 => ({ x: q.x + d.x * k, y: q.y + d.y * k, z: q.z });

/** 세로좌표 치수인지 */
export function isOrdinateDim(d: DimensionEntity): boolean {
  return !d.subtype && (d.dimType & 7) === 6;
}

/** 선형 치수의 치수선을 법선 위치 target(dot(점, n))으로 옮긴 사본 */
function moveLinearTo(d: DimensionEntity, n: P, target: number): DimensionEntity | null {
  const s = dot(d.defPoint, n);
  const delta = target - s;
  if (Math.abs(delta) < 1e-12) return null;
  const e = extDir(d);
  const k = delta / (dot(e, n) || 1);
  const c = structuredClone(d);
  c.defPoint = mv(c.defPoint, e, k);
  if (c.dimType & 128) c.textMid = mv(c.textMid, e, k);
  return c;
}

/** 각도 치수의 호 반지름을 r로 바꾼 사본 */
function setAngularRadius(d: DimensionEntity, r: number): DimensionEntity | null {
  const v = angularVertex(d);
  if (!v) return null;
  const cur = Math.hypot(v.arc.x - v.c.x, v.arc.y - v.c.y);
  if (!(cur > 0) || Math.abs(cur - r) < 1e-12) return null;
  const k = r / cur;
  const c = structuredClone(d);
  const q = c[v.key];
  c[v.key] = { x: v.c.x + (q.x - v.c.x) * k, y: v.c.y + (q.y - v.c.y) * k, z: q.z };
  if (c.dimType & 128) c.textMid = { x: v.c.x + (c.textMid.x - v.c.x) * k, y: v.c.y + (c.textMid.y - v.c.y) * k, z: c.textMid.z };
  return c;
}

/**
 * 정렬(G): 기준 치수에 맞춘다 — 나란한 선형·정렬 치수는 치수선을 같은 선으로, 같은 꼭짓점의 각도 치수는 같은 호 반지름으로,
 * 같은 데이텀 방향의 세로좌표 치수는 지시선 끝을 같은 높이(X 데이텀)·폭(Y 데이텀)으로. 맞지 않는 것은 skipped.
 */
export function alignDimensions(base: DimensionEntity, others: readonly DimensionEntity[]): { changed: DimensionEntity[]; skipped: DimensionEntity[] } {
  const changed: DimensionEntity[] = [];
  const skipped: DimensionEntity[] = [];
  const tol = 1e-6;
  for (const d of others) {
    if (d.handle === base.handle) continue;
    if (isLinearDim(base) && isLinearDim(d)) {
      const u = linearDir(base);
      if (Math.abs(u.x * linearDir(d).y - u.y * linearDir(d).x) > tol) {
        skipped.push(d);
        continue;
      }
      const n = { x: -u.y, y: u.x };
      const c = moveLinearTo(d, n, dot(base.defPoint, n));
      if (c) changed.push(c);
      continue;
    }
    if (isAngularDim(base) && isAngularDim(d)) {
      const bv = angularVertex(base);
      const v = angularVertex(d);
      if (!bv || !v || Math.hypot(v.c.x - bv.c.x, v.c.y - bv.c.y) > tol * Math.max(1, Math.hypot(bv.arc.x - bv.c.x, bv.arc.y - bv.c.y))) {
        skipped.push(d);
        continue;
      }
      const c = setAngularRadius(d, Math.hypot(bv.arc.x - bv.c.x, bv.arc.y - bv.c.y));
      if (c) changed.push(c);
      continue;
    }
    if (isOrdinateDim(base) && isOrdinateDim(d) && (base.dimType & 64) === (d.dimType & 64)) {
      const xType = (base.dimType & 64) !== 0;
      const c = structuredClone(d);
      if (xType) {
        if (Math.abs(c.defPoint3.y - base.defPoint3.y) < 1e-12) continue;
        c.defPoint3 = { ...c.defPoint3, y: base.defPoint3.y };
      } else {
        if (Math.abs(c.defPoint3.x - base.defPoint3.x) < 1e-12) continue;
        c.defPoint3 = { ...c.defPoint3, x: base.defPoint3.x };
      }
      c.dimType &= ~128;
      changed.push(c);
      continue;
    }
    skipped.push(d);
  }
  return { changed, skipped };
}

/**
 * 분산 › 동일(E): 나란한 선형·정렬 치수(첫 치수 방향) 3개 이상의 치수선을 양 끝 치수 사이에 고르게,
 * 또는 같은 꼭짓점의 각도 치수 3개 이상의 호 반지름을 고르게. 무리에 들지 않은 것은 skipped.
 */
export function distributeEqual(dims: readonly DimensionEntity[]): { changed: DimensionEntity[]; skipped: DimensionEntity[]; count: number } {
  const changed: DimensionEntity[] = [];
  const skipped: DimensionEntity[] = [];
  const first = dims.find((d) => isLinearDim(d) || isAngularDim(d));
  if (!first) return { changed, skipped: [...dims], count: 0 };
  const tol = 1e-6;
  if (isLinearDim(first)) {
    const u = linearDir(first);
    const n = { x: -u.y, y: u.x };
    const group: { d: DimensionEntity; s: number }[] = [];
    for (const d of dims) {
      if (isLinearDim(d) && Math.abs(u.x * linearDir(d).y - u.y * linearDir(d).x) <= tol) group.push({ d, s: dot(d.defPoint, n) });
      else skipped.push(d);
    }
    if (group.length < 3) return { changed, skipped: [...dims], count: group.length };
    group.sort((a, b) => a.s - b.s);
    const s0 = group[0]!.s;
    const s1 = group[group.length - 1]!.s;
    group.forEach((g, i) => {
      if (i === 0 || i === group.length - 1) return;
      const c = moveLinearTo(g.d, n, s0 + ((s1 - s0) * i) / (group.length - 1));
      if (c) changed.push(c);
    });
    return { changed, skipped, count: group.length };
  }
  const fv = angularVertex(first)!;
  const group: { d: DimensionEntity; r: number }[] = [];
  for (const d of dims) {
    const v = isAngularDim(d) ? angularVertex(d) : null;
    if (v && Math.hypot(v.c.x - fv.c.x, v.c.y - fv.c.y) <= tol * Math.max(1, Math.hypot(fv.arc.x - fv.c.x, fv.arc.y - fv.c.y))) group.push({ d, r: Math.hypot(v.arc.x - v.c.x, v.arc.y - v.c.y) });
    else skipped.push(d);
  }
  if (group.length < 3) return { changed, skipped: [...dims], count: group.length };
  group.sort((a, b) => a.r - b.r);
  const r0 = group[0]!.r;
  const r1 = group[group.length - 1]!.r;
  group.forEach((g, i) => {
    if (i === 0 || i === group.length - 1) return;
    const c = setAngularRadius(g.d, r0 + ((r1 - r0) * i) / (group.length - 1));
    if (c) changed.push(c);
  });
  return { changed, skipped, count: group.length };
}
