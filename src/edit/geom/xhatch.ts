/**
 * 해치 변환: 경계(폴리선·선·호·타원·스플라인), 무늬 선(기준점·간격·각도·대시), 씨앗점.
 * 대칭이고 MIRRHATCH가 0이면(기본) 무늬는 방향 그대로 경계 첫 꼭짓점이 옮겨 간 만큼만 옮긴다.
 */
import type { HatchEdge, HatchEntity, HatchPath, HatchPatternLine, Vec2 } from '../../core/model';
import { bulgeArc, interpolateFitPoints } from '../../geom/curves';
import { ellipseFromConjugate, geomToParam, paramToGeom } from './conic';
import { cloneEntity } from './path';
import { type Affine, TAU, affAngle, affApply, affDet, affInv, affLin, affMul, affScaleOf, affSimilarity, ccwSweep, len, normAngle, rot90 } from './math';
import { planProj, planeMap } from './ocs';
import type { TransformOptions } from './types';

export function xformHatch(e: HatchEntity, m: Affine, opt: TransformOptions): HatchEntity {
  const pm = planeMap(e.extrusion, e.elevation, m, opt.dz ?? 0);
  const A = pm.A;
  const r = cloneEntity(e);
  r.paths = e.paths.map((p) => xformPath(p, A));
  const keep = affDet(m) < 0 && !opt.mirrorHatch;
  let G = A;
  if (keep) {
    // 월드에서 방향을 지킨 닮음: 첫 꼭짓점 기준 축척 + 이동
    const Wold = planProj(e.extrusion, e.elevation);
    const Wnew = planProj(pm.ext, pm.z);
    const v0 = firstVertex(e);
    const v0w = affApply(Wold, v0);
    const v1w = affApply(m, v0w);
    const s = affScaleOf(m);
    const S: Affine = [s, 0, 0, s, v1w.x - s * v0w.x, v1w.y - s * v0w.y];
    const inv = affInv(Wnew) ?? [1, 0, 0, 1, 0, 0];
    G = affMul(inv, affMul(S, Wold));
  }
  r.patternLines = e.patternLines.map((pl) => xformPatternLine(pl, G));
  r.patternAngle = normAngle(affAngle(G, e.patternAngle));
  const sim = affSimilarity(A);
  r.patternScale = e.patternScale * (sim ? sim.s : affScaleOf(A));
  r.seedPoints = e.seedPoints.map((p) => affApply(A, p));
  if (e.gradient) r.gradient = { ...e.gradient, angle: normAngle(affAngle(G, e.gradient.angle)) };
  r.elevation = pm.z;
  r.extrusion = pm.ext;
  return r;
}

function firstVertex(e: HatchEntity): Vec2 {
  for (const p of e.paths) {
    if (p.polyline && p.polyline.vertices.length) return { x: p.polyline.vertices[0]!.x, y: p.polyline.vertices[0]!.y };
    const ed = p.edges?.[0];
    if (ed) {
      if (ed.type === 'line') return { ...ed.start };
      if (ed.type === 'arc') return { x: ed.center.x + ed.radius * Math.cos(ed.startAngle), y: ed.center.y + ed.radius * Math.sin(ed.startAngle) };
      if (ed.type === 'ellipse') return { ...ed.center };
      if (ed.type === 'spline' && ed.controlPoints.length) return { ...ed.controlPoints[0]! };
      if (ed.type === 'spline' && ed.fitPoints?.length) return { ...ed.fitPoints[0]! };
    }
  }
  return { x: 0, y: 0 };
}

export function xformPatternLine(pl: HatchPatternLine, A: Affine): HatchPatternLine {
  const du = affLin(A, { x: Math.cos(pl.angle), y: Math.sin(pl.angle) });
  const k = len(du);
  return {
    angle: normAngle(Math.atan2(du.y, du.x)),
    base: affApply(A, pl.base),
    offset: affLin(A, pl.offset),
    dashes: pl.dashes.map((d) => d * k),
  };
}

export function xformPath(p: HatchPath, A: Affine): HatchPath {
  const sim = affSimilarity(A);
  const flip = affDet(A) < 0;
  const out: HatchPath = { flags: p.flags };
  if (p.sources) out.sources = [...p.sources];
  if (p.polyline) {
    const curved = p.polyline.vertices.some((v) => Math.abs(v.bulge) > 1e-12);
    if (sim || !curved) {
      out.polyline = {
        closed: p.polyline.closed,
        vertices: p.polyline.vertices.map((v) => {
          const q = affApply(A, v);
          return { x: q.x, y: q.y, bulge: flip ? -v.bulge : v.bulge };
        }),
      };
      return out;
    }
    // 비균등 축척: 호 → 타원 경계
    const vs = p.polyline.vertices;
    const edges: HatchEdge[] = [];
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      const arc = Math.abs(a.bulge) > 1e-12 ? bulgeArc(a.x, a.y, b.x, b.y, a.bulge) : null;
      if (!arc) {
        if (Math.hypot(b.x - a.x, b.y - a.y) > 0) edges.push({ type: 'line', start: affApply(A, a), end: affApply(A, b) });
        continue;
      }
      const ccw = arc.sweep > 0;
      const lo = ccw ? arc.a0 : arc.a0 + arc.sweep;
      edges.push(arcEdgeUnder(A, { x: arc.cx, y: arc.cy }, arc.r, lo, Math.abs(arc.sweep), ccw));
    }
    out.edges = edges;
    return out;
  }
  out.edges = (p.edges ?? []).map((ed) => xformEdge(ed, A));
  return out;
}

/** CCW 각도 구간 [lo, lo + sweep]의 호(경로 방향 ccw)를 A로 옮긴 경계 */
function arcEdgeUnder(A: Affine, c: Vec2, r: number, lo: number, sweep: number, ccw: boolean): HatchEdge {
  const sim = affSimilarity(A);
  const cc = affApply(A, c);
  if (sim) {
    if (!sim.mirror) return { type: 'arc', center: cc, radius: r * sim.s, startAngle: normAngle(lo + sim.rot), endAngle: normAngle(lo + sweep + sim.rot), ccw };
    return { type: 'arc', center: cc, radius: r * sim.s, startAngle: normAngle(sim.rot - lo - sweep), endAngle: normAngle(sim.rot - lo), ccw: !ccw };
  }
  const el = ellipseFromConjugate(cc, affLin(A, { x: r, y: 0 }), affLin(A, { x: 0, y: r }), lo, sweep);
  return ellEdge(el, ccw);
}

function ellEdge(el: ReturnType<typeof ellipseFromConjugate>, ccw: boolean): HatchEdge {
  const start = el.full ? 0 : normAngle(paramToGeom(el.start, el.ratio));
  const end = el.full ? TAU : normAngle(paramToGeom(el.end, el.ratio));
  return { type: 'ellipse', center: el.c, majorAxis: el.major, ratio: el.ratio, startAngle: start, endAngle: end, ccw: el.reversed ? !ccw : ccw };
}

export function xformEdge(ed: HatchEdge, A: Affine): HatchEdge {
  switch (ed.type) {
    case 'line':
      return { type: 'line', start: affApply(A, ed.start), end: affApply(A, ed.end) };
    case 'arc': {
      return arcEdgeUnder(A, ed.center, ed.radius, ed.startAngle, ccwSweep(ed.startAngle, ed.endAngle), ed.ccw);
    }
    case 'ellipse': {
      const ratio = ed.ratio || 1;
      const p0 = geomToParam(ed.startAngle, ratio);
      const full = Math.abs(ccwSweep(ed.startAngle, ed.endAngle) - TAU) < 1e-9;
      const sweep = full ? TAU : ccwSweep(p0, geomToParam(ed.endAngle, ratio));
      const M = ed.majorAxis;
      const N = { x: rot90(M).x * ratio, y: rot90(M).y * ratio };
      const el = ellipseFromConjugate(affApply(A, ed.center), affLin(A, M), affLin(A, N), p0, sweep);
      return ellEdge(el, ed.ccw);
    }
    case 'spline': {
      const sim = affSimilarity(A);
      let ctrl = ed.controlPoints;
      let knots = ed.knots;
      let degree = ed.degree;
      let weights = ed.weights;
      let fit = ed.fitPoints;
      let st = ed.startTangent;
      let et = ed.endTangent;
      if (!sim && fit && fit.length >= 2) {
        if (ctrl.length < 2) {
          const s = interpolateFitPoints(
            fit.map((q) => ({ x: q.x, y: q.y, z: 0 })),
            st ? { x: st.x, y: st.y, z: 0 } : undefined,
            et ? { x: et.x, y: et.y, z: 0 } : undefined,
          );
          ctrl = s.ctrl.map((q) => ({ x: q.x, y: q.y }));
          knots = s.knots;
          degree = s.degree;
          weights = undefined;
        }
        fit = undefined;
        st = undefined;
        et = undefined;
      }
      const out: HatchEdge = {
        type: 'spline',
        degree,
        rational: ed.rational && !!weights,
        periodic: ed.periodic,
        knots: [...knots],
        controlPoints: ctrl.map((q) => affApply(A, q)),
      };
      if (weights) out.weights = [...weights];
      if (fit) out.fitPoints = fit.map((q) => affApply(A, q));
      if (st) out.startTangent = affLin(A, st);
      if (et) out.endTangent = affLin(A, et);
      return out;
    }
  }
}
