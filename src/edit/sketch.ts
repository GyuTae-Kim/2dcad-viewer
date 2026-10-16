/**
 * 스케치(SKETCH): 마우스로 그린 획(점 목록)을 선·폴리선·스플라인으로 만든다.
 * 점은 증분(SKETCHINC) 이상 떨어질 때만 기록하고, 스플라인은 공차(SKPOLY 2의 맞춤 공차)로 점을 줄여 맞춤점으로 쓴다.
 */
import type { Entity, EntityBase, Vec3 } from '../core/model';
import { interpolateFitPoints } from '../geom/curves';
import { packLwPoints } from '../core/lwpoly';

export type SketchType = 'line' | 'polyline' | 'spline';

export interface P2 {
  x: number;
  y: number;
}

/** 증분 이상 떨어지면 점을 더한다(더했으면 true) */
export function recordPoint(stroke: P2[], p: P2, increment: number): boolean {
  const last = stroke[stroke.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < Math.max(increment, 1e-12)) return false;
  stroke.push({ x: p.x, y: p.y });
  return true;
}

/** 더글러스-포이커 줄이기(끝점은 남긴다) */
export function simplify(pts: readonly P2[], tol: number): P2[] {
  if (pts.length <= 2 || !(tol > 0)) return [...pts];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i]!;
    const b = pts[j]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    let best = -1;
    let bi = -1;
    for (let k = i + 1; k < j; k++) {
      const q = pts[k]!;
      const d = L > 1e-12 ? Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / L : Math.hypot(q.x - a.x, q.y - a.y);
      if (d > best) {
        best = d;
        bi = k;
      }
    }
    if (best > tol && bi > 0) {
      keep[bi] = 1;
      stack.push([i, bi], [bi, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

const v3 = (p: P2): Vec3 => ({ x: p.x, y: p.y, z: 0 });

/** 획들을 객체로(handle은 ''). 점이 둘 미만인 획은 버린다 */
export function sketchEntities(strokes: readonly P2[][], type: SketchType, props: Omit<EntityBase, 'type' | 'handle'>, tolerance: number): Entity[] {
  const out: Entity[] = [];
  for (const s of strokes) {
    if (s.length < 2) continue;
    if (type === 'line') {
      for (let i = 1; i < s.length; i++) out.push({ ...props, type: 'LINE', handle: '', start: v3(s[i - 1]!), end: v3(s[i]!) } as Entity);
    } else if (type === 'polyline') {
      out.push({
        ...props,
        type: 'LWPOLYLINE',
        handle: '',
        closed: false,
        plinegen: false,
        constantWidth: 0,
        elevation: 0,
        ...packLwPoints(s),
      } as Entity);
    } else {
      const fit = simplify(s, tolerance).map(v3);
      if (fit.length < 2) continue;
      const sp = interpolateFitPoints(fit);
      out.push({
        ...props,
        type: 'SPLINE',
        handle: '',
        flags: 8,
        degree: sp.degree,
        knots: sp.knots,
        controlPoints: sp.ctrl,
        fitPoints: fit,
        knotTolerance: 1e-10,
        controlTolerance: 1e-10,
        fitTolerance: tolerance,
      } as Entity);
    }
  }
  return out;
}
