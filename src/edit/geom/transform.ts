/**
 * transformEntity: 이동·복사·회전·축척·대칭·비균등 축척을 모든 객체 종류에 적용한다.
 * - OCS 객체는 새 평면을 구해(XY와 평행하면 늘 +Z) 평면 안의 2D 아핀으로 옮긴다.
 * - 비균등 축척의 원·호 → ELLIPSE, 호가 있는 폴리선 → SPLINE(유리 2차, 정확).
 * - 결과 종류가 바뀌면 remove + add, 아니면 replace(핸들 유지).
 *   복사(COPY)라면 호출한 쪽이 replace 항목을 새 객체로 쓰고 remove는 버리면 된다.
 */
import type {
  CadDocument,
  Entity,
  ImageEntity,
  InsertEntity,
  LwPolylineEntity,
  MLineEntity,
  PolylineEntity,
  SplineEntity,
  UnderlayEntity,
  Vec3,
  ViewportEntity,
} from '../../core/model';
import { interpolateFitPoints } from '../../geom/curves';
import { ellipseFromConjugate, ellipseFromConjugate3 } from './conic';
import { type ArcPiece, type EllPiece } from './curve';
import { arcUnder, bulgePieces, cloneEntity, inherit, lwVerts, piecesNurbs, polyVerts } from './path';
import {
  type Affine,
  TAU,
  affAngle,
  affApply,
  affApply3,
  affCof3,
  affDet,
  affLin,
  affLin3,
  affScaleOf,
  affSimilarity,
  ccwSweep,
  dot,
  emptyBox,
  growBox,
  len,
  len3,
  mul,
  norm3,
  normAngle,
  rot90,
} from './math';
import { mapNurbs } from './nurbs';
import { isNaturalExt, ocsToWcs, planeMap } from './ocs';
import { type EditResult, MSG, type TransformOptions } from './types';
import { xformMText, xformShape, xformText, xformTolerance } from './xtext';
import { xformHatch } from './xhatch';
import { xformDimension, xformLeader, xformMLeader, xformTable } from './xannot';

export function transformEntity(e: Entity, m: Affine, doc: CadDocument, opts: TransformOptions = {}): EditResult {
  return transformOne(e, m, doc, opts);
}

function same(_e: Entity, r: Entity): EditResult {
  return { replace: [r] };
}

function changed(e: Entity, r: Entity, extra?: Partial<EditResult>): EditResult {
  return { remove: e.handle ? [e.handle] : [], add: [r], ...extra };
}

const P3 = (m: Affine, p: Vec3, opt: TransformOptions): Vec3 => affApply3(m, p, opt.dz ?? 0);

/** 법선(extrusion·normal)을 옮긴다. ±Z에 가까우면 +Z(undefined) */
export function xformNormal(m: Affine, n: Vec3 | undefined): Vec3 | undefined {
  if (!n) return undefined;
  const c = affCof3(m, n);
  const l = len3(c);
  if (!(l > 0)) return n;
  const r = { x: c.x / l, y: c.y / l, z: c.z / l };
  if (Math.abs(r.x) < 1e-9 && Math.abs(r.y) < 1e-9) return undefined;
  return r;
}

function dir3(m: Affine, v: Vec3): Vec3 {
  const d = affLin3(m, v);
  const l = len3(d);
  return l > 0 ? { x: d.x / l, y: d.y / l, z: d.z / l } : { ...v };
}

/** 블록 참조 축척·회전 분해(AutoCAD처럼 음수는 X 축척에) */
export function decomposeBlock(A: Affine, rot: number, sx: number, sy: number): { rot: number; sx: number; sy: number; shear: boolean } {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const c1 = affLin(A, { x: sx * c, y: sx * s });
  const c2 = affLin(A, { x: -sy * s, y: sy * c });
  const det = c1.x * c2.y - c1.y * c2.x;
  const dA = affDet(A);
  let sgn: number;
  if (det < 0) sgn = sx > 0 && sy < 0 && dA > 0 ? 1 : -1;
  else sgn = sx < 0 && sy < 0 && dA > 0 ? -1 : 1;
  const l1 = len(c1);
  if (!(l1 > 0)) return { rot, sx, sy, shear: true };
  const dx = mul(c1, sgn / l1);
  const nsy = dot(c2, rot90(dx));
  const shear = Math.abs(dot(c1, c2)) > 1e-9 * l1 * len(c2);
  return { rot: normAngle(Math.atan2(dx.y, dx.x)), sx: sgn * l1, sy: nsy, shear };
}

function transformOne(e: Entity, m: Affine, doc: CadDocument, opt: TransformOptions): EditResult {
  const dz = opt.dz ?? 0;
  switch (e.type) {
    case 'LINE': {
      const r = cloneEntity(e);
      r.start = P3(m, e.start, opt);
      r.end = P3(m, e.end, opt);
      r.extrusion = xformNormal(m, e.extrusion);
      return same(e, r);
    }
    case 'POINT': {
      const r = cloneEntity(e);
      r.position = P3(m, e.position, opt);
      r.angle = normAngle(affAngle(m, e.angle));
      r.extrusion = xformNormal(m, e.extrusion);
      return same(e, r);
    }
    case 'CIRCLE':
    case 'ARC': {
      const pm = planeMap(e.extrusion, e.center.z, m, dz);
      const full = e.type === 'CIRCLE';
      const a0 = full ? 0 : e.startAngle;
      const sw = full ? TAU : ccwSweep(e.startAngle, e.endAngle);
      const pc = arcUnder(pm.A, e.center, e.radius, a0, sw);
      if (pc.k === 'arc') {
        const r = cloneEntity(e);
        r.center = { x: pc.c.x, y: pc.c.y, z: pm.z };
        r.radius = pc.r;
        r.extrusion = pm.ext;
        if (r.type === 'ARC') {
          const lo = pc.sw >= 0 ? pc.a0 : pc.a0 + pc.sw;
          r.startAngle = normAngle(lo);
          r.endAngle = normAngle(lo + Math.abs(pc.sw));
        }
        return same(e, r);
      }
      return changed(e, ellipseOfPiece(e, pc, pm.z, pm.ext));
    }
    case 'ELLIPSE': {
      const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
      const M = e.majorAxis;
      const N = { x: (n.y * M.z - n.z * M.y) * e.ratio, y: (n.z * M.x - n.x * M.z) * e.ratio, z: (n.x * M.y - n.y * M.x) * e.ratio };
      const full = Math.abs(e.endParam - e.startParam - TAU) < 1e-9 || Math.abs(e.endParam - e.startParam) < 1e-12;
      const t0 = full ? 0 : e.startParam;
      const dt = full ? TAU : ccwSweep(e.startParam, e.endParam);
      const el = ellipseFromConjugate3(P3(m, e.center, opt), affLin3(m, M), affLin3(m, N), t0, dt);
      const r = cloneEntity(e);
      r.center = el.center;
      r.majorAxis = el.major;
      r.ratio = el.ratio;
      r.startParam = full ? e.startParam : el.start;
      r.endParam = full ? e.endParam : el.end;
      r.extrusion = el.normal;
      return same(e, r);
    }
    case 'LWPOLYLINE':
      return xformLw(e, m, opt);
    case 'POLYLINE':
      return xformPolyline(e, m, opt);
    case 'SPLINE':
      return same(e, xformSpline(e, m, opt));
    case 'XLINE':
    case 'RAY': {
      const r = cloneEntity(e);
      r.base = P3(m, e.base, opt);
      r.direction = dir3(m, e.direction);
      return same(e, r);
    }
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF':
      return same(e, xformText(e, m, opt, doc));
    case 'MTEXT':
      return same(e, xformMText(e, m, opt, doc));
    case 'SHAPE':
      return same(e, xformShape(e, m, opt));
    case 'TOLERANCE':
      return same(e, xformTolerance(e, m, opt, doc));
    case 'INSERT':
      return xformInsert(e, m, opt, doc);
    case 'DIMENSION':
      return xformDimension(e, m, opt, doc);
    case 'LEADER':
      return same(e, xformLeader(e, m, opt));
    case 'MULTILEADER':
      return same(e, xformMLeader(e, m, opt, doc));
    case 'ACAD_TABLE':
      return xformTable(e, m, opt, doc);
    case 'HATCH':
    case 'MPOLYGON':
      return same(e, xformHatch(e, m, opt));
    case 'SOLID':
    case 'TRACE': {
      const pm = planeMap(e.extrusion, e.points[0].z, m, dz);
      const r = cloneEntity(e);
      r.points = e.points.map((p) => {
        const q = affApply(pm.A, p);
        return { x: q.x, y: q.y, z: pm.z };
      }) as typeof r.points;
      r.extrusion = pm.ext;
      return same(e, r);
    }
    case '3DFACE': {
      const r = cloneEntity(e);
      r.points = e.points.map((p) => P3(m, p, opt)) as typeof r.points;
      return same(e, r);
    }
    case 'IMAGE':
    case 'WIPEOUT':
      return same(e, xformImage(e, m, opt));
    case 'VIEWPORT':
      return same(e, xformViewport(e, m, opt));
    case 'MLINE':
      return same(e, xformMLine(e, m, opt));
    case 'MESH': {
      const r = cloneEntity(e);
      r.vertices = e.vertices.map((p) => P3(m, p, opt));
      return same(e, r);
    }
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      return xformUnderlay(e, m, opt);
    case 'OLE2FRAME':
    case 'OLEFRAME': {
      const r = cloneEntity(e);
      const a = e.upperLeft;
      const b = e.lowerRight;
      const bx = emptyBox();
      for (const p of [
        { x: a.x, y: a.y },
        { x: b.x, y: a.y },
        { x: b.x, y: b.y },
        { x: a.x, y: b.y },
      ]) {
        const q = affApply(m, p);
        growBox(bx, q.x, q.y);
      }
      r.upperLeft = { x: bx.minX, y: bx.maxY, z: a.z + dz };
      r.lowerRight = { x: bx.maxX, y: bx.minY, z: b.z + dz };
      return same(e, r);
    }
    case 'REGION':
    case '3DSOLID':
    case 'BODY':
    case 'SURFACE':
    case 'PLANESURFACE':
    case 'EXTRUDEDSURFACE':
    case 'LOFTEDSURFACE':
    case 'REVOLVEDSURFACE':
    case 'SWEPTSURFACE':
    case 'NURBSURFACE': {
      // ACIS 형상(원본 태그·DWG 본문)은 옮길 수 없다 — 저장하면 제자리로 돌아가므로 변환하지 않는다
      if ((e.raw && e.raw.length) || e.dwgRaw) return { message: MSG.acis };
      const r = cloneEntity(e);
      if (e.wires) r.wires = e.wires.map((w) => w.map((p) => P3(m, p, opt)));
      return same(e, r);
    }
    case 'UNKNOWN':
    default:
      return { message: MSG.cannotTransform };
  }
}

/** 타원호 조각(평면 OCS 안) → ELLIPSE */
function ellipseOfPiece(src: Entity, pc: EllPiece | ArcPiece, z: number, ext: Vec3 | undefined): Entity {
  const p: EllPiece = pc.k === 'ell' ? pc : { k: 'ell', c: pc.c, u: { x: pc.r, y: 0 }, v: { x: 0, y: pc.r }, t0: pc.a0, dt: pc.sw };
  const el = ellipseFromConjugate(p.c, p.u, p.v, p.t0, p.dt);
  const center = ext ? ocsToWcs({ x: el.c.x, y: el.c.y, z }, ext) : { x: el.c.x, y: el.c.y, z };
  const major = ext ? ocsToWcs({ x: el.major.x, y: el.major.y, z: 0 }, ext) : { x: el.major.x, y: el.major.y, z: 0 };
  return {
    type: 'ELLIPSE',
    ...inherit(src),
    center,
    majorAxis: major,
    ratio: el.ratio,
    startParam: el.start,
    endParam: el.end,
    extrusion: ext,
  };
}

function xformLw(e: LwPolylineEntity, m: Affine, opt: TransformOptions): EditResult {
  const pm = planeMap(e.extrusion, e.elevation, m, opt.dz ?? 0);
  const sim = affSimilarity(pm.A);
  const curved = e.vertices.some((v) => Math.abs(v.bulge) > 1e-12);
  if (!sim && curved) {
    const pieces = bulgePieces(lwVerts(e), e.closed, pm.A);
    const n = piecesNurbs(pieces, pm.z);
    if (!n) return { message: MSG.cannotTransform };
    return changed(e, splineIn(e, n, e.closed, pm.ext));
  }
  const s = sim ? sim.s : affScaleOf(pm.A);
  const flip = affDet(pm.A) < 0 ? -1 : 1;
  const r = cloneEntity(e);
  r.vertices = e.vertices.map((v) => {
    const q = affApply(pm.A, v);
    return { x: q.x, y: q.y, bulge: v.bulge * flip, startWidth: v.startWidth * s, endWidth: v.endWidth * s };
  });
  r.constantWidth = e.constantWidth * s;
  r.elevation = pm.z;
  r.extrusion = pm.ext;
  return same(e, r);
}

function splineIn(src: Entity, n: import('./nurbs').Nurbs, closed: boolean, ext: Vec3 | undefined): SplineEntity {
  const nn = ext ? mapNurbs(n, (p) => ocsToWcs(p, ext)) : n;
  const rational = !!nn.weights;
  return {
    type: 'SPLINE',
    ...inherit(src),
    flags: (closed ? 1 : 0) | (rational ? 4 : 0) | 8,
    degree: nn.degree,
    knots: nn.knots,
    controlPoints: nn.ctrl,
    weights: nn.weights,
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
    normal: ext,
  };
}

function xformPolyline(e: PolylineEntity, m: Affine, opt: TransformOptions): EditResult {
  if (e.kind !== '2d') {
    const r = cloneEntity(e);
    r.vertices = e.vertices.map((v) => ({ ...v, location: P3(m, v.location, opt) }));
    r.extrusion = xformNormal(m, e.extrusion);
    return same(e, r);
  }
  const pm = planeMap(e.extrusion, e.elevation, m, opt.dz ?? 0);
  const sim = affSimilarity(pm.A);
  const curved = e.vertices.some((v) => Math.abs(v.bulge) > 1e-12);
  if (!sim && curved) {
    const vs = polyVerts(e);
    const pieces = bulgePieces(
      vs.map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge, sw: v.startWidth, ew: v.endWidth })),
      (e.flags & 1) !== 0,
      pm.A,
    );
    const n = piecesNurbs(pieces, pm.z);
    if (!n) return { message: MSG.cannotTransform };
    return changed(e, splineIn(e, n, (e.flags & 1) !== 0, pm.ext));
  }
  const s = sim ? sim.s : affScaleOf(pm.A);
  const flip = affDet(pm.A) < 0 ? -1 : 1;
  const r = cloneEntity(e);
  r.vertices = e.vertices.map((v) => {
    const q = affApply(pm.A, v.location);
    const nv = { ...v, location: { x: q.x, y: q.y, z: v.location.z }, bulge: v.bulge * flip, startWidth: v.startWidth * s, endWidth: v.endWidth * s };
    if (v.tangent !== undefined) nv.tangent = normAngle(affAngle(pm.A, v.tangent));
    return nv;
  });
  r.defaultStartWidth = e.defaultStartWidth * s;
  r.defaultEndWidth = e.defaultEndWidth * s;
  r.elevation = pm.z;
  r.extrusion = pm.ext;
  return same(e, r);
}

export function xformSpline(e: SplineEntity, m: Affine, opt: TransformOptions): SplineEntity {
  const r = cloneEntity(e);
  const sim = affSimilarity(m);
  const P = (p: Vec3) => P3(m, p, opt);
  if (!sim && e.fitPoints.length >= 2) {
    // 맞춤 곡선은 닮음이 아닌 변환에서 유지되지 않는다 → 조정점 정의로
    if (e.controlPoints.length < 2) {
      const s = interpolateFitPoints(e.fitPoints, e.startTangent, e.endTangent);
      r.degree = s.degree;
      r.knots = s.knots;
      r.controlPoints = s.ctrl;
      r.weights = undefined;
    }
    r.fitPoints = [];
    r.startTangent = undefined;
    r.endTangent = undefined;
  }
  r.controlPoints = r.controlPoints.map(P);
  r.fitPoints = r.fitPoints.map(P);
  if (r.startTangent) r.startTangent = dir3(m, r.startTangent);
  if (r.endTangent) r.endTangent = dir3(m, r.endTangent);
  if (e.normal) r.normal = xformNormal(m, e.normal);
  if (e.extrusion) r.extrusion = xformNormal(m, e.extrusion);
  const s = sim ? sim.s : affScaleOf(m);
  if (e.fitTolerance > 1e-9) r.fitTolerance = e.fitTolerance * s;
  if (e.helix) {
    r.helix = {
      ...e.helix,
      axisBase: P(e.helix.axisBase),
      start: P(e.helix.start),
      axis: affLin3(m, e.helix.axis),
      radius: e.helix.radius * s,
      ccw: affDet(m) < 0 ? !e.helix.ccw : e.helix.ccw,
    };
  }
  return r;
}

function xformInsert(e: InsertEntity, m: Affine, opt: TransformOptions, doc: CadDocument): EditResult {
  const pm = planeMap(e.extrusion, e.insert.z, m, opt.dz ?? 0);
  const r = cloneEntity(e);
  const q = affApply(pm.A, e.insert);
  r.insert = { x: q.x, y: q.y, z: pm.z };
  const sx = e.scale.x || 1;
  const sy = e.scale.y || 1;
  const d = decomposeBlock(pm.A, e.rotation, sx, sy);
  r.rotation = d.rot;
  r.scale = { x: d.sx, y: d.sy, z: e.scale.z };
  // OCS가 뒤집혀 자연스러운 +Z가 되었으면 Z 축척도 뒤집는다
  const n0 = e.extrusion && !isNaturalExt(e.extrusion) ? norm3(e.extrusion) : { x: 0, y: 0, z: 1 };
  if (n0.z < 0 && !pm.ext && affDet(m) > 0) r.scale.z = -(e.scale.z || 1);
  r.extrusion = pm.ext;
  if (e.columnCount > 1 || e.rowCount > 1) {
    r.columnSpacing = e.columnSpacing * (d.sx / sx);
    r.rowSpacing = e.rowSpacing * (d.sy / sy);
  }
  r.attribs = e.attribs.map((a) => xformText(a, m, opt, doc));
  return d.shear ? { replace: [r], message: MSG.shear } : { replace: [r] };
}

function xformUnderlay(e: UnderlayEntity, m: Affine, opt: TransformOptions): EditResult {
  const pm = planeMap(e.extrusion, e.insert.z, m, opt.dz ?? 0);
  const r = cloneEntity(e);
  const q = affApply(pm.A, e.insert);
  r.insert = { x: q.x, y: q.y, z: pm.z };
  const d = decomposeBlock(pm.A, e.rotation, e.scale.x || 1, e.scale.y || 1);
  r.rotation = d.rot;
  r.scale = { x: d.sx, y: d.sy, z: e.scale.z };
  r.extrusion = pm.ext;
  return d.shear ? { replace: [r], message: MSG.shear } : { replace: [r] };
}

function xformImage(e: ImageEntity, m: Affine, opt: TransformOptions): ImageEntity {
  const r = cloneEntity(e);
  r.insert = P3(m, e.insert, opt);
  r.uVector = affLin3(m, e.uVector);
  r.vVector = affLin3(m, e.vVector);
  return r;
}

function xformViewport(e: ViewportEntity, m: Affine, opt: TransformOptions): ViewportEntity {
  const r = cloneEntity(e);
  r.center = P3(m, e.center, opt);
  const w = e.width / 2;
  const h = e.height / 2;
  const b = emptyBox();
  for (const p of [
    { x: -w, y: -h },
    { x: w, y: -h },
    { x: w, y: h },
    { x: -w, y: h },
  ]) {
    const q = affLin(m, p);
    growBox(b, q.x, q.y);
  }
  r.width = b.maxX - b.minX;
  r.height = b.maxY - b.minY;
  const sim = affSimilarity(m);
  if (sim && !sim.mirror && Math.abs(sim.rot) > 1e-12) r.twistAngle = normAngle(e.twistAngle + sim.rot);
  return r;
}

function xformMLine(e: MLineEntity, m: Affine, opt: TransformOptions): MLineEntity {
  const r = cloneEntity(e);
  const s = affScaleOf(m);
  r.startPoint = P3(m, e.startPoint, opt);
  r.normal = xformNormal(m, e.normal) ?? { x: 0, y: 0, z: 1 };
  r.scale = e.scale * s;
  r.vertices = e.vertices.map((v) => {
    const dm = affLin3(m, v.miter);
    const km = len3(dm) || 1;
    const dd = affLin3(m, v.direction);
    const kd = len3(dd) || 1;
    return {
      position: P3(m, v.position, opt),
      direction: { x: dd.x / kd, y: dd.y / kd, z: dd.z / kd },
      miter: { x: dm.x / km, y: dm.y / km, z: dm.z / km },
      elements: v.elements.map((el) => ({
        params: el.params.map((p, i) => (i === 0 ? p * km : p * kd)),
        fillParams: el.fillParams.map((p) => p * km),
      })),
    };
  });
  return r;
}

