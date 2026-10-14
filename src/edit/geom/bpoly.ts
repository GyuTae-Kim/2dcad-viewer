/**
 * BOUNDARY: 해치 경계 경로(HatchPath, 평면도)를 닫힌 객체로.
 * 선·호뿐이면 닫힌 LWPOLYLINE(볼록도), 타원·스플라인 모서리가 있으면 같은 곡선의 닫힌 SPLINE.
 */
import type { Entity, EntityBase, HatchEdge, HatchPath, LineEntity } from '../../core/model';
import { type Piece, pieceAt, pieceLength, reversePiece } from './curve';
import { ccwSweep, dist, rot90 } from './math';
import { domain, normalizeNurbs } from './nurbs';
import { bulgePieces, makePolyline } from './path';

/** 해치 모서리 → 조각 */
export function hatchEdgePiece(ed: HatchEdge): Piece | null {
  switch (ed.type) {
    case 'line':
      return { k: 'line', a: { x: ed.start.x, y: ed.start.y }, b: { x: ed.end.x, y: ed.end.y } };
    case 'arc': {
      const sw = ccwSweep(ed.startAngle, ed.endAngle);
      return ed.ccw ? { k: 'arc', c: { ...ed.center }, r: ed.radius, a0: ed.startAngle, sw } : { k: 'arc', c: { ...ed.center }, r: ed.radius, a0: ed.endAngle, sw: -sw };
    }
    case 'ellipse': {
      // 기하 각도 → 매개변수
      const par = (th: number) => Math.atan2(Math.sin(th), ed.ratio * Math.cos(th));
      const u = { ...ed.majorAxis };
      const v = { x: rot90(u).x * ed.ratio, y: rot90(u).y * ed.ratio };
      const t0 = par(ed.startAngle);
      const t1 = par(ed.endAngle);
      const dt = ccwSweep(t0, t1);
      return ed.ccw ? { k: 'ell', c: { ...ed.center }, u, v, t0, dt } : { k: 'ell', c: { ...ed.center }, u, v, t0: t1, dt: -dt };
    }
    case 'spline': {
      if (ed.controlPoints.length < 2) return null;
      const n = normalizeNurbs({
        degree: ed.degree,
        knots: ed.knots,
        ctrl: ed.controlPoints.map((p) => ({ x: p.x, y: p.y, z: 0 })),
        weights: ed.rational ? ed.weights : undefined,
      });
      const [u0, u1] = domain(n);
      return { k: 'nurbs', n, u0, u1 };
    }
  }
}

/** 경로의 조각들(끝과 끝이 이어지게 방향을 맞춘다) */
export function hatchPathPieces(path: HatchPath): Piece[] {
  if (path.polyline) {
    const vs = path.polyline.vertices.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge, sw: 0, ew: 0 }));
    return bulgePieces(vs, true, [1, 0, 0, 1, 0, 0]);
  }
  const raw = (path.edges ?? []).map(hatchEdgePiece).filter((p): p is Piece => !!p && pieceLength(p) > 0);
  const out: Piece[] = [];
  for (const p of raw) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(p);
      continue;
    }
    const e = pieceAt(prev, 1);
    const fwd = dist(pieceAt(p, 0), e);
    const rev = dist(pieceAt(p, 1), e);
    out.push(rev < fwd ? reversePiece(p) : p);
  }
  // 첫 조각이 거꾸로였으면(둘째 조각과 이어지지 않으면) 뒤집는다
  if (out.length >= 2) {
    const a = out[0]!;
    const b = out[1]!;
    if (dist(pieceAt(a, 1), pieceAt(b, 0)) > dist(pieceAt(a, 0), pieceAt(b, 0)) * 1.000001) out[0] = reversePiece(a);
  }
  return out;
}

/** 경계 경로들 → 닫힌 객체들(특성은 base) */
export function boundaryObjects(paths: readonly HatchPath[], base: Omit<EntityBase, 'type'>, z = 0): Entity[] {
  const tmpl: LineEntity = { type: 'LINE', ...base, start: { x: 0, y: 0, z }, end: { x: 0, y: 0, z } };
  const out: Entity[] = [];
  for (const p of paths) {
    const pcs = hatchPathPieces(p);
    if (!pcs.length) continue;
    const e = makePolyline(tmpl, pcs, true, z);
    if (e) out.push(e);
  }
  return out;
}
