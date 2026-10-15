/**
 * STRETCH: 걸침 다각형 안의 정의점만 옮긴다. 정의점이 모두 안에 있으면 객체 전체를 옮긴다.
 * - 선·폴리선·스플라인·지시선·여러 줄·면: 안의 끝점·정점(조정점·맞춤점)
 * - 호: 안의 끝점, 현의 높이(sagitta)는 그대로(AutoCAD와 같다)
 * - 원·타원·문자·블록 참조·점·이미지 등: 중심·삽입점이 안에 있으면 이동
 * - 치수: 안의 정의점(측정값을 다시 잰다). 블록 그림은 같은 다각형으로 늘려 근사한다
 *   (정확한 모양은 치수 생성기로 다시 만든다)
 * - 해치: 경계 정점(폴리선 경계·선 모서리)과 씨앗점
 */
import type { BlockDef, CadDocument, DimensionEntity, Entity, HatchEntity, MLineEntity, SplineEntity, Vec2, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { lwPoints, lwVertices, setLwVertices } from '../../core/lwpoly';
import { bulgeArc, interpolateFitPoints } from '../../geom/curves';
import { type Affine, add, affApply, affInv, affTranslate, ccwSweep, dist, norm, normAngle, pointInPolygon, rot90, sub } from './math';
import { cloneEntity, freshEntity, makeArc } from './path';
import { frameOf, isNaturalExt, ocsToWcs, planProj, wcsToOcs } from './ocs';
import { transformEntity } from './transform';
import { keepIdentity } from './trim';
import { type EditResult, allocBlockName, mergeResults } from './types';
import { dimMeasure, updateDimNumber } from './xannot';
import { layoutArcText } from '../../text/arctext';

/** 걸침 영역: 두 점이면 사각형 */
function polygonOf(crossing: readonly Vec2[]): Vec2[] {
  if (crossing.length === 2) {
    const [a, b] = crossing as [Vec2, Vec2];
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }
  return [...crossing];
}

function makeInside(poly: Vec2[]): (p: { x: number; y: number }) => boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const tol = 1e-9 * Math.max(1, maxX - minX, maxY - minY, Math.abs(minX), Math.abs(maxY));
  const rect =
    poly.length === 4 &&
    poly.every((p) => (Math.abs(p.x - minX) <= tol || Math.abs(p.x - maxX) <= tol) && (Math.abs(p.y - minY) <= tol || Math.abs(p.y - maxY) <= tol));
  if (rect) return (p) => p.x >= minX - tol && p.x <= maxX + tol && p.y >= minY - tol && p.y <= maxY + tol;
  return (p) => pointInPolygon(p, poly);
}

export interface StretchOptions {
  /** 치수 블록을 다시 만드는 함수(치수 생성기). 없으면 블록 내용을 같은 영역으로 늘여 근사한다 */
  regenDimension?: (d: DimensionEntity, doc: CadDocument) => BlockDef | null;
}

export function stretch(entities: Entity[], crossing: Vec2[], displacement: Vec2, doc: CadDocument, opts: StretchOptions = {}): EditResult {
  const poly = polygonOf(crossing);
  if (poly.length < 3) return {};
  const inside = makeInside(poly);
  const parts: EditResult[] = [];
  const M = affTranslate(displacement.x, displacement.y);
  for (const e of entities) {
    const r = stretchOne(e, inside, displacement, M, doc, opts);
    if (r) parts.push(r);
  }
  return mergeResults(parts);
}

/** 정의점(평면도 WCS)들 */
function keyPoints(e: Entity): Vec2[] {
  const P = (p: Vec3, ext?: Vec3) => {
    const q = ext && !isNaturalExt(ext) ? ocsToWcs(p, ext) : p;
    return { x: q.x, y: q.y };
  };
  switch (e.type) {
    case 'LINE':
      return [P(e.start), P(e.end)];
    case 'ARC': {
      const pr = planProj(e.extrusion, e.center.z);
      return [e.startAngle, e.endAngle].map((a) => affApply(pr, { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) }));
    }
    case 'CIRCLE':
      return [affApply(planProj(e.extrusion, e.center.z), e.center)];
    case 'ELLIPSE':
      return [P(e.center)];
    case 'LWPOLYLINE': {
      const pr = planProj(e.extrusion, e.elevation);
      return lwPoints(e).map((v) => affApply(pr, v));
    }
    case 'POLYLINE': {
      if (e.kind === '2d') {
        const pr = planProj(e.extrusion, e.elevation);
        return e.vertices.map((v) => affApply(pr, v.location));
      }
      return e.vertices.filter((v) => !v.faceIndices || v.flags & 64).map((v) => P(v.location));
    }
    case 'SPLINE':
      return [...e.controlPoints, ...e.fitPoints].map((p) => P(p));
    case 'XLINE':
    case 'RAY':
      return [P(e.base)];
    case 'POINT':
      return [P(e.position, e.extrusion)];
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      const q = (e.halign !== 0 || e.valign !== 0) && e.alignPoint && e.halign !== 3 && e.halign !== 5 ? e.alignPoint : e.insert;
      return [affApply(planProj(e.extrusion, q.z), q)];
    }
    case 'INSERT':
    case 'SHAPE':
      return [affApply(planProj(e.extrusion, e.insert.z), e.insert)];
    case 'MTEXT':
    case 'TOLERANCE':
    case 'ACAD_TABLE':
    case 'IMAGE':
    case 'WIPEOUT':
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      return [P(e.insert)];
    case 'OLE2FRAME':
    case 'OLEFRAME':
      return [P(e.upperLeft), P(e.lowerRight)];
    case 'ARCALIGNEDTEXT':
      return layoutArcText(e)?.glyphs.map((g) => ({ x: g.x, y: g.y })) ?? [];
    case 'VIEWPORT':
      return [P(e.center)];
    case 'DIMENSION':
      return dimPoints(e).map((k) => k.p);
    case 'LEADER':
      return e.vertices.map((v) => P(v));
    case 'MULTILEADER': {
      const out: Vec2[] = [P(e.context.contentBase)];
      for (const ld of e.context.leaders) {
        if (ld.lastLeaderPoint) out.push(P(ld.lastLeaderPoint));
        for (const ln of ld.lines) for (const v of ln.vertices) out.push(P(v));
      }
      return out;
    }
    case 'HATCH':
    case 'MPOLYGON':
      return hatchPoints(e);
    case 'SOLID':
    case 'TRACE': {
      const pr = planProj(e.extrusion, e.points[0].z);
      return e.points.map((p) => affApply(pr, p));
    }
    case '3DFACE':
      return e.points.map((p) => P(p));
    case 'MLINE':
      return e.vertices.map((v) => P(v.position));
    case 'MESH':
      return e.vertices.map((v) => P(v));
    case 'REGION':
    case '3DSOLID':
    case 'BODY':
      return (e.wires ?? []).flat().map((p) => P(p));
    default:
      return [];
  }
}

function stretchOne(e: Entity, inside: (p: Vec2) => boolean, d: Vec2, M: Affine, doc: CadDocument, opts: StretchOptions = {}): EditResult | null {
  const kp = keyPoints(e);
  if (!kp.length) return null;
  const flags = kp.map(inside);
  if (!flags.some(Boolean)) return null;
  if (flags.every(Boolean)) return transformEntity(e, M, doc);
  const out = partial(e, inside, d, doc, opts);
  if (!out) return null;
  return out;
}

const mv = (p: Vec3, d: Vec2): Vec3 => ({ x: p.x + d.x, y: p.y + d.y, z: p.z });

/** OCS 점을 WCS 이동량만큼(평면 OCS) */
function mvOcs(p: Vec3, d: Vec2, ext: Vec3 | undefined): Vec3 {
  if (!ext || isNaturalExt(ext)) return mv(p, d);
  const f = frameOf(ext);
  const dw = { x: d.x, y: d.y, z: 0 };
  return { x: p.x + dw.x * f.ax.x + dw.y * f.ax.y, y: p.y + dw.x * f.ay.x + dw.y * f.ay.y, z: p.z };
}

function partial(e: Entity, inside: (p: Vec2) => boolean, d: Vec2, doc: CadDocument, opts: StretchOptions): EditResult | null {
  const In = (p: { x: number; y: number }) => inside({ x: p.x, y: p.y });
  switch (e.type) {
    case 'LINE': {
      const r = cloneEntity(e);
      if (In(e.start)) r.start = mv(e.start, d);
      if (In(e.end)) r.end = mv(e.end, d);
      return { replace: [r] };
    }
    case 'ARC': {
      const pr = planProj(e.extrusion, e.center.z);
      const sw = ccwSweep(e.startAngle, e.endAngle);
      const s0 = affApply(pr, { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) });
      const s1 = affApply(pr, { x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle) });
      // 평면도에서의 방향(−Z면 시계)
      const mirrored = pr[0] * pr[3] - pr[1] * pr[2] < 0;
      const b0 = Math.tan(sw / 4) * (mirrored ? -1 : 1);
      const c0 = dist(s0, s1);
      const n0 = inside(s0) ? add(s0, d) : s0;
      const n1 = inside(s1) ? add(s1, d) : s1;
      const c1 = dist(n0, n1);
      if (!(c1 > 1e-12 * Math.max(1, e.radius))) return null;
      // 현의 높이 h = b·c/2를 지킨다: b' = b·c/c'
      const sag = (b0 * c0) / 2;
      const b1 = (2 * sag) / c1;
      const arc = bulgeArc(n0.x, n0.y, n1.x, n1.y, b1);
      if (!arc) return null;
      const out = makeArc(e, { k: 'arc', c: { x: arc.cx, y: arc.cy }, r: arc.r, a0: arc.a0, sw: arc.sweep }, affApply3z(pr, e.center.z, e.extrusion));
      return { replace: [keepIdentity(e, out)] };
    }
    case 'LWPOLYLINE': {
      const pr = planProj(e.extrusion, e.elevation);
      const inv = affInv(pr)!;
      const r = cloneEntity(e);
      setLwVertices(
        r,
        lwVertices(e).map((v) => {
          const w = affApply(pr, v);
          if (!inside(w)) return v;
          const q = affApply(inv, add(w, d));
          return { ...v, x: q.x, y: q.y };
        }),
      );
      return { replace: [r] };
    }
    case 'POLYLINE': {
      const r = cloneEntity(e);
      if (e.kind === '2d') {
        const pr = planProj(e.extrusion, e.elevation);
        const inv = affInv(pr)!;
        r.vertices = e.vertices.map((v) => {
          const w = affApply(pr, v.location);
          if (!inside(w)) return { ...v, location: { ...v.location } };
          const q = affApply(inv, add(w, d));
          return { ...v, location: { x: q.x, y: q.y, z: v.location.z } };
        });
      } else r.vertices = e.vertices.map((v) => ((!v.faceIndices || v.flags & 64) && In(v.location) ? { ...v, location: mv(v.location, d) } : { ...v, location: { ...v.location } }));
      return { replace: [r] };
    }
    case 'SPLINE':
      return { replace: [stretchSpline(e, In, d)] };
    case 'DIMENSION':
      return stretchDimension(e, inside, d, doc, opts);
    case 'LEADER': {
      const r = cloneEntity(e);
      r.vertices = e.vertices.map((v) => (In(v) ? mv(v, d) : { ...v }));
      return { replace: [r] };
    }
    case 'MULTILEADER': {
      const r = cloneEntity(e);
      const c = r.context;
      const contentIn = In(e.context.contentBase);
      if (contentIn) {
        c.contentBase = mv(c.contentBase, d);
        c.basePoint = mv(c.basePoint, d);
        if (c.text) c.text.location = mv(c.text.location, d);
        if (c.block) c.block.location = mv(c.block.location, d);
      }
      for (const ld of c.leaders) {
        if (ld.lastLeaderPoint && In(ld.lastLeaderPoint)) ld.lastLeaderPoint = mv(ld.lastLeaderPoint, d);
        for (const ln of ld.lines) ln.vertices = ln.vertices.map((v) => (In(v) ? mv(v, d) : v));
      }
      return { replace: [r] };
    }
    case 'HATCH':
    case 'MPOLYGON':
      return { replace: [stretchHatch(e, inside, d)] };
    case 'SOLID':
    case 'TRACE': {
      const pr = planProj(e.extrusion, e.points[0].z);
      const r = cloneEntity(e);
      r.points = e.points.map((p) => (inside(affApply(pr, p)) ? mvOcs(p, d, e.extrusion) : { ...p })) as typeof r.points;
      return { replace: [r] };
    }
    case '3DFACE': {
      const r = cloneEntity(e);
      r.points = e.points.map((p) => (In(p) ? mv(p, d) : { ...p })) as typeof r.points;
      return { replace: [r] };
    }
    case 'MLINE':
      return { replace: [stretchMLine(e, In, d)] };
    case 'MESH': {
      const r = cloneEntity(e);
      r.vertices = e.vertices.map((v) => (In(v) ? mv(v, d) : { ...v }));
      return { replace: [r] };
    }
    case 'OLE2FRAME':
    case 'OLEFRAME': {
      const r = cloneEntity(e);
      if (In(e.upperLeft)) r.upperLeft = mv(e.upperLeft, d);
      if (In(e.lowerRight)) r.lowerRight = mv(e.lowerRight, d);
      return { replace: [r] };
    }
    case 'REGION':
    case '3DSOLID':
    case 'BODY': {
      const r = cloneEntity(e);
      if (e.wires) r.wires = e.wires.map((w) => w.map((p) => (In(p) ? mv(p, d) : { ...p })));
      return { replace: [r] };
    }
    default:
      return null;
  }
}

function affApply3z(_pr: Affine, z: number, ext: Vec3 | undefined): number {
  if (!ext || isNaturalExt(ext)) return z;
  return frameOf(ext).n.z * z;
}

function stretchSpline(e: SplineEntity, In: (p: Vec3) => boolean, d: Vec2): SplineEntity {
  const r = cloneEntity(e);
  const fitMoved = e.fitPoints.some(In);
  r.fitPoints = e.fitPoints.map((p) => (In(p) ? mv(p, d) : { ...p }));
  if (fitMoved && e.fitPoints.length >= 2) {
    // 맞춤점을 옮겼으면 조정점을 맞춤점에서 다시 구한다(그리는 쪽과 같은 보간)
    if (e.controlPoints.length >= 2) {
      const s = interpolateFitPoints(r.fitPoints, r.startTangent, r.endTangent);
      r.degree = s.degree;
      r.knots = s.knots;
      r.controlPoints = s.ctrl;
      r.weights = undefined;
    }
    return r;
  }
  r.controlPoints = e.controlPoints.map((p) => (In(p) ? mv(p, d) : { ...p }));
  if (e.controlPoints.some(In)) {
    // 조정점을 옮기면 맞춤 데이터는 더 이상 맞지 않는다
    r.fitPoints = [];
    r.startTangent = undefined;
    r.endTangent = undefined;
  }
  return r;
}

function stretchMLine(e: MLineEntity, In: (p: Vec3) => boolean, d: Vec2): MLineEntity {
  const r = cloneEntity(e);
  r.vertices = e.vertices.map((v) => ({ ...v, position: In(v.position) ? mv(v.position, d) : { ...v.position } }));
  if (r.vertices.length) r.startPoint = { ...r.vertices[0]!.position };
  recomputeMLine(r);
  return r;
}

/** 정점 위치에서 방향·마이터를 다시 구한다(요소 간격은 그대로) */
export function recomputeMLine(r: MLineEntity): void {
  const n = r.vertices.length;
  const closed = (r.flags & 2) !== 0;
  const dirs: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = r.vertices[i]!.position;
    const b = r.vertices[closed ? (i + 1) % n : Math.min(i + 1, n - 1)]!.position;
    let dv = norm({ x: b.x - a.x, y: b.y - a.y });
    if (i === n - 1 && !closed) dv = dirs[i - 1] ?? dv;
    dirs.push(dv);
  }
  for (let i = 0; i < n; i++) {
    const v = r.vertices[i]!;
    const dIn = i > 0 ? dirs[i - 1]! : closed ? dirs[n - 1]! : dirs[0]!;
    const dOut = dirs[i]!;
    const nIn = rot90(dIn);
    const nOut = rot90(dOut);
    let m = norm(add(nIn, nOut));
    if (!(Math.hypot(m.x, m.y) > 0)) m = nOut;
    // 마이터 길이 보정: 요소 간격은 법선 거리이므로 마이터 방향 길이 = 간격 / cos
    const cosA = m.x * nOut.x + m.y * nOut.y;
    const k = Math.abs(cosA) > 1e-9 ? 1 / cosA : 1;
    const old = Math.hypot(v.miter.x, v.miter.y) > 0 ? v.miter : { x: m.x, y: m.y, z: 0 };
    const oldN = rot90({ x: v.direction.x, y: v.direction.y });
    const oldCos = old.x * oldN.x + old.y * oldN.y;
    const oldK = Math.abs(oldCos) > 1e-9 ? 1 / oldCos : 1;
    v.direction = { x: dOut.x, y: dOut.y, z: 0 };
    v.miter = { x: m.x, y: m.y, z: 0 };
    v.elements = v.elements.map((el) => ({ params: el.params.map((p, j) => (j === 0 ? (p / oldK) * k : p)), fillParams: [...el.fillParams] }));
  }
}

// ---------------------------------------------------------------------------
// 치수
// ---------------------------------------------------------------------------

type DimKey = 'defPoint' | 'defPoint2' | 'defPoint3' | 'defPoint4' | 'defPoint5' | 'textMid';

/** 치수의 정의점(평면도 WCS) */
export function dimPoints(e: DimensionEntity): { key: DimKey; p: Vec2 }[] {
  const ocs = (p: Vec3) => {
    const q = ocsToWcs(p, e.extrusion);
    return { x: q.x, y: q.y };
  };
  const w = (p: Vec3) => ({ x: p.x, y: p.y });
  const k = e.dimType & 7;
  const out: { key: DimKey; p: Vec2 }[] = [{ key: 'textMid', p: ocs(e.textMid) }];
  if (e.subtype === 'ARC_DIMENSION') out.push({ key: 'defPoint', p: w(e.defPoint) }, { key: 'defPoint2', p: w(e.defPoint2) }, { key: 'defPoint3', p: w(e.defPoint3) }, { key: 'defPoint4', p: w(e.defPoint4) });
  else if (k === 0 || k === 1) out.push({ key: 'defPoint2', p: w(e.defPoint2) }, { key: 'defPoint3', p: w(e.defPoint3) }, { key: 'defPoint', p: w(e.defPoint) });
  else if (k === 3 || k === 4) out.push({ key: 'defPoint', p: w(e.defPoint) }, { key: 'defPoint4', p: w(e.defPoint4) });
  else if (k === 2) out.push({ key: 'defPoint2', p: w(e.defPoint2) }, { key: 'defPoint3', p: w(e.defPoint3) }, { key: 'defPoint4', p: w(e.defPoint4) }, { key: 'defPoint', p: w(e.defPoint) }, { key: 'defPoint5', p: ocs(e.defPoint5) });
  else if (k === 5) out.push({ key: 'defPoint2', p: w(e.defPoint2) }, { key: 'defPoint3', p: w(e.defPoint3) }, { key: 'defPoint4', p: w(e.defPoint4) }, { key: 'defPoint', p: w(e.defPoint) });
  else if (k === 6) out.push({ key: 'defPoint', p: w(e.defPoint) }, { key: 'defPoint2', p: w(e.defPoint2) }, { key: 'defPoint3', p: w(e.defPoint3) });
  return out;
}

/** 치수 정의점 하나를 옮긴 새 치수(측정값을 다시 잰다) */
export function moveDimPoint(e: DimensionEntity, key: DimKey, d: Vec2): DimensionEntity {
  const r = cloneEntity(e);
  if (key === 'textMid' || key === 'defPoint5') {
    const p = e[key];
    const w = ocsToWcs(p, e.extrusion);
    const q = wcsToOcs({ x: w.x + d.x, y: w.y + d.y, z: w.z }, e.extrusion);
    r[key] = { x: q.x, y: q.y, z: p.z };
    if (key === 'textMid') r.dimType = e.dimType | 128;
  } else r[key] = mv(e[key], d);
  const k = e.dimType & 7;
  if (Number.isFinite(e.measurement)) {
    if (e.subtype === 'ARC_DIMENSION' || k === 0 || k === 1 || k === 3 || k === 4) r.measurement = dimMeasure(r);
    else if (k === 2 || k === 5) r.measurement = angularMeasure(r);
    else if (k === 6) r.measurement = Math.abs((e.dimType & 64 ? r.defPoint2.x - r.defPoint.x : r.defPoint2.y - r.defPoint.y));
  }
  if (e.subtype === 'ARC_DIMENSION' && e.arc) {
    // 호 정의(중심·끝) 갱신
    r.arc = { ...e.arc, center: { ...r.defPoint4 }, start: { ...r.defPoint2 }, end: { ...r.defPoint3 } };
  }
  return r;
}

function angularMeasure(d: DimensionEntity): number {
  if ((d.dimType & 7) === 5) {
    const c = d.defPoint4;
    const a1 = Math.atan2(d.defPoint2.y - c.y, d.defPoint2.x - c.x);
    const a2 = Math.atan2(d.defPoint3.y - c.y, d.defPoint3.x - c.x);
    let s = normAngle(a2 - a1);
    if (s > Math.PI) s = 2 * Math.PI - s;
    return s;
  }
  // 두 선 각도: (13→14)와 (15→10)
  const u = sub(d.defPoint3, d.defPoint2);
  const v = sub(d.defPoint, d.defPoint4);
  let s = Math.abs(normAngle(Math.atan2(v.y, v.x) - Math.atan2(u.y, u.x)));
  if (s > Math.PI) s = 2 * Math.PI - s;
  return s;
}

function stretchDimension(e: DimensionEntity, inside: (p: Vec2) => boolean, d: Vec2, doc: CadDocument, opts: StretchOptions): EditResult | null {
  let r = e;
  let moved = false;
  for (const k of dimPoints(e))
    if (inside(k.p)) {
      r = moveDimPoint(r, k.key, d);
      moved = true;
    }
  if (!moved) return null;
  if (!(e.dimType & 128)) r.dimType = r.dimType & ~128;
  if (inside(dimPoints(e)[0]!.p)) r.dimType |= 128;
  if (opts.regenDimension) {
    const nb = opts.regenDimension(r, doc);
    if (nb) {
      r.block = nb.name;
      return { replace: [r], blocks: [nb] };
    }
  }
  const b = e.block ? doc.blocks.get(tableKey(e.block)) : undefined;
  if (!b || !b.entities.length || !isNaturalExt(e.extrusion) || (e.insertPoint && (e.insertPoint.x || e.insertPoint.y))) return { replace: [r] };
  // 블록 그림 근사: 같은 영역으로 늘인다
  const ents: Entity[] = [];
  for (const c of b.entities) {
    const one = stretchOne(c, inside, d, affTranslate(d.x, d.y), doc);
    const got = one ? [...(one.replace ?? []), ...(one.add ?? [])] : [cloneEntity(c)];
    for (const x of got) ents.push(freshEntity(x));
  }
  updateDimNumber(doc, e, r, ents);
  const name = allocBlockName(doc, '*D');
  const nb = { ...b, name, handle: '', recordHandle: '', endHandle: undefined, entities: ents, flags: b.flags | 1 };
  r.block = name;
  return { replace: [r], blocks: [nb] };
}

// ---------------------------------------------------------------------------
// 해치
// ---------------------------------------------------------------------------

function hatchPoints(e: HatchEntity): Vec2[] {
  const pr = planProj(e.extrusion, e.elevation);
  const out: Vec2[] = [];
  for (const p of e.paths) {
    if (p.polyline) for (const v of p.polyline.vertices) out.push(affApply(pr, v));
    for (const ed of p.edges ?? []) {
      if (ed.type === 'line') out.push(affApply(pr, ed.start), affApply(pr, ed.end));
      else if (ed.type === 'arc' || ed.type === 'ellipse') out.push(affApply(pr, ed.center));
      else for (const q of ed.fitPoints?.length ? ed.fitPoints : ed.controlPoints) out.push(affApply(pr, q));
    }
  }
  return out;
}

function stretchHatch(e: HatchEntity, inside: (p: Vec2) => boolean, d: Vec2): HatchEntity {
  const pr = planProj(e.extrusion, e.elevation);
  const inv = affInv(pr)!;
  const r = cloneEntity(e);
  const mvp = (q: Vec2): Vec2 => {
    const w = affApply(pr, q);
    return inside(w) ? affApply(inv, add(w, d)) : { ...q };
  };
  for (const p of r.paths) {
    if (p.polyline) p.polyline.vertices = p.polyline.vertices.map((v) => ({ ...v, ...mvp(v) }));
    if (p.edges)
      p.edges = p.edges.map((ed) => {
        if (ed.type === 'line') return { ...ed, start: mvp(ed.start), end: mvp(ed.end) };
        if (ed.type === 'arc' || ed.type === 'ellipse') return { ...ed, center: mvp(ed.center) };
        return { ...ed, controlPoints: ed.controlPoints.map(mvp), fitPoints: ed.fitPoints?.map(mvp) };
      });
    p.sources = undefined;
  }
  r.associative = false;
  r.seedPoints = e.seedPoints.map(mvp);
  return r;
}

