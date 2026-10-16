/**
 * 객체 ↔ 평면도 경로. OCS 객체(호·원·폴리선)는 WCS로 옮겨 자연스러운(+Z) 조각으로 만든다.
 * 결과 객체를 만들 때는 원본의 도면층·색·선종류·선가중치·축척·투명도·확장 데이터를 잇는다.
 */
import type {
  ArcEntity,
  CircleEntity,
  EllipseEntity,
  Entity,
  EntityBase,
  LineEntity,
  LwPolylineEntity,
  LwVertex,
  PolyVertex,
  PolylineEntity,
  SplineEntity,
  Vec2,
  Vec3,
  XLineEntity,
} from '../../core/model';
import { lwCount, packLw, unboxLw } from '../../core/lwpoly';
import { bulgeArc, interpolateFitPoints } from '../../geom/curves';
import { ellipseFromConjugate } from './conic';
import { type ArcPiece, type EllPiece, type LinePiece, type NurbsPiece, type Path, type Piece, pieceAt, pieceLength, pieceSize, reversePiece } from './curve';
import { type Affine, TAU, affApply, affLin, affSimilarity, dist, normAngle, sweepToBulge } from './math';
import { type Nurbs, arcBeziers, beziersToNurbs, domain, ellBeziers, lineBezier, normalizeNurbs, reverseNurbs, subNurbs, toBezier } from './nurbs';
import { planProj, planZ } from './ocs';

// ---------------------------------------------------------------------------
// 특성 잇기
// ---------------------------------------------------------------------------

/** 새 객체의 공통 특성(핸들은 빈 문자열 — 호출한 쪽이 붙인다) */
export function inherit(src: Entity): Omit<EntityBase, 'type'> {
  const out: Omit<EntityBase, 'type'> = {
    handle: '',
    layer: src.layer,
    linetype: src.linetype,
    color: { ...src.color },
    lineweight: src.lineweight,
    ltscale: src.ltscale,
    transparency: src.transparency,
  };
  if (src.owner !== undefined) out.owner = src.owner;
  if (src.xdata) out.xdata = structuredClone(src.xdata);
  if (src.paperSpace) out.paperSpace = true;
  if (src.invisible) out.invisible = true;
  if (src.thickness) out.thickness = src.thickness;
  if (src.plotStyle) out.plotStyle = src.plotStyle;
  return out;
}

/** 새 객체로 쓸 수 있게 핸들·확장 사전·반응자·DWG 원본 본문을 지운다(블록 속성도) */
export function freshEntity<T extends Entity>(x: T, keepOwner = true): T {
  x.handle = '';
  delete x.xdict;
  delete x.reactors;
  delete x.dwgRaw;
  if (!keepOwner) delete x.owner;
  if (x.type === 'INSERT') for (const a of x.attribs) freshEntity(a as Entity, keepOwner);
  return x;
}

/** 객체 깊은 복사 */
export function cloneEntity<T extends Entity>(e: T): T {
  const c = structuredClone(e);
  // 구조화 복제는 수 배열의 수를 하나씩 상자에 담는다 — 평탄 좌표는 빈칸 없는 실수 배열로 다시 담는다
  if (c.type === 'LWPOLYLINE') unboxLw(c, e as LwPolylineEntity);
  return c;
}

// ---------------------------------------------------------------------------
// 원호 → 평면도 조각
// ---------------------------------------------------------------------------

/** OCS 원호(signed sweep)를 평면도 아핀 P로 옮긴 조각(닮음이면 호, 아니면 타원호) */
export function arcUnder(P: Affine, c: Vec2, r: number, a0: number, sw: number): ArcPiece | EllPiece {
  const sim = affSimilarity(P, 1e-9);
  const cc = affApply(P, c);
  if (sim) {
    if (!sim.mirror) return { k: 'arc', c: cc, r: r * sim.s, a0: a0 + sim.rot, sw };
    return { k: 'arc', c: cc, r: r * sim.s, a0: sim.rot - a0, sw: -sw };
  }
  return { k: 'ell', c: cc, u: affLin(P, { x: r, y: 0 }), v: affLin(P, { x: 0, y: r }), t0: a0, dt: sw };
}

interface BV {
  x: number;
  y: number;
  bulge: number;
  sw: number;
  ew: number;
}

/** 볼록도 정점 → 조각(P로 평면도에) */
export function bulgePieces(vs: readonly BV[], closed: boolean, P: Affine): Piece[] {
  const out: Piece[] = [];
  const n = vs.length;
  const segs = closed ? n : n - 1;
  const wide = vs.some((v) => v.sw > 0 || v.ew > 0);
  for (let i = 0; i < segs; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const pa = affApply(P, a);
    const pb = affApply(P, b);
    let pc: Piece;
    const arc = Math.abs(a.bulge) > 1e-12 ? bulgeArc(a.x, a.y, b.x, b.y, a.bulge) : null;
    if (arc) {
      pc = arcUnder(P, { x: arc.cx, y: arc.cy }, arc.r, arc.a0, arc.sweep);
    } else {
      if (dist(pa, pb) <= 1e-12 * Math.max(1, Math.abs(pa.x), Math.abs(pa.y))) continue;
      pc = { k: 'line', a: pa, b: pb };
    }
    (pc as Piece & { seg?: number }).seg = i;
    if (wide) {
      pc.w0 = a.sw;
      pc.w1 = a.ew;
    }
    out.push(pc);
  }
  return out;
}

/** 조각의 원래 세그먼트 번호(폴리선) */
export function segOf(p: Piece): number | undefined {
  return (p as Piece & { seg?: number }).seg;
}

// ---------------------------------------------------------------------------
// 객체 → 경로
// ---------------------------------------------------------------------------

export function lwVerts(e: LwPolylineEntity): BV[] {
  const n = lwCount(e);
  const v = e.verts;
  const w = e.widths;
  const cw = e.constantWidth;
  const out = new Array<BV>(n);
  for (let i = 0; i < n; i++)
    out[i] = { x: v[i * 3]!, y: v[i * 3 + 1]!, bulge: v[i * 3 + 2]!, sw: (w ? w[i * 2]! : 0) || cw || 0, ew: (w ? w[i * 2 + 1]! : 0) || cw || 0 };
  return out;
}

/** 2D·3D POLYLINE의 그려지는 정점(스플라인 틀 정점 제외) */
export function polyVerts(e: PolylineEntity): PolyVertex[] {
  return e.vertices.filter((v) => !(v.flags & 16));
}

export function splineNurbs(e: SplineEntity): Nurbs | null {
  if (e.controlPoints.length >= 2) {
    return normalizeNurbs({ degree: e.degree, knots: e.knots, ctrl: e.controlPoints, weights: e.weights });
  }
  if (e.fitPoints.length >= 2) {
    const s = interpolateFitPoints(e.fitPoints, e.startTangent, e.endTangent);
    return normalizeNurbs({ degree: s.degree, knots: s.knots, ctrl: s.ctrl });
  }
  return null;
}

/** 곡선 객체의 평면도 경로(곡선이 아니면 null) */
export function entityPath(e: Entity): Path | null {
  switch (e.type) {
    case 'LINE':
      return {
        pieces: [{ k: 'line', a: { x: e.start.x, y: e.start.y }, b: { x: e.end.x, y: e.end.y }, za: e.start.z, zb: e.end.z }],
        closed: false,
        z: e.start.z,
      };
    case 'ARC':
    case 'CIRCLE': {
      const P = planProj(e.extrusion, e.center.z);
      const full = e.type === 'CIRCLE';
      const a0 = full ? 0 : e.startAngle;
      const sw = full ? TAU : ccw(e.startAngle, e.endAngle);
      let pc: Piece = arcUnder(P, e.center, e.radius, a0, sw);
      if ((pc.k === 'arc' && pc.sw < 0) || (pc.k === 'ell' && crossUV(pc) * pc.dt < 0)) pc = reversePiece(pc);
      if (full && pc.k === 'arc') pc = { ...pc, a0: 0 };
      return { pieces: [pc], closed: full, z: planZ(e.extrusion, e.center.z) };
    }
    case 'ELLIPSE': {
      const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
      const M = e.majorAxis;
      const N = { x: (n.y * M.z - n.z * M.y) * e.ratio, y: (n.z * M.x - n.x * M.z) * e.ratio };
      const full = Math.abs(e.endParam - e.startParam - TAU) < 1e-9 || Math.abs(e.endParam - e.startParam) < 1e-12;
      const dt = full ? TAU : ccw(e.startParam, e.endParam);
      const pc: EllPiece = { k: 'ell', c: { x: e.center.x, y: e.center.y }, u: { x: M.x, y: M.y }, v: N, t0: full ? 0 : e.startParam, dt };
      return { pieces: [pc], closed: full, z: e.center.z };
    }
    case 'LWPOLYLINE': {
      if (!lwCount(e)) return null;
      const P = planProj(e.extrusion, e.elevation);
      const pieces = bulgePieces(lwVerts(e), e.closed, P);
      if (!pieces.length) return null;
      return { pieces, closed: e.closed, z: planZ(e.extrusion, e.elevation) };
    }
    case 'POLYLINE': {
      const vs = polyVerts(e);
      if (vs.length < 2) return null;
      const closed = (e.flags & 1) !== 0;
      if (e.kind === '2d') {
        const P = planProj(e.extrusion, e.elevation);
        const pieces = bulgePieces(
          vs.map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge, sw: v.startWidth || 0, ew: v.endWidth || 0 })),
          closed,
          P,
        );
        if (!pieces.length) return null;
        return { pieces, closed, z: planZ(e.extrusion, e.elevation) };
      }
      if (e.kind === '3d') {
        const pieces: Piece[] = [];
        const n = vs.length;
        for (let i = 0; i < (closed ? n : n - 1); i++) {
          const a = vs[i]!.location;
          const b = vs[(i + 1) % n]!.location;
          if (Math.hypot(b.x - a.x, b.y - a.y) <= 1e-12) continue;
          const pc: LinePiece = { k: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, za: a.z, zb: b.z };
          (pc as Piece & { seg?: number }).seg = i;
          pieces.push(pc);
        }
        if (!pieces.length) return null;
        return { pieces, closed, z: vs[0]!.location.z };
      }
      return null;
    }
    case 'SPLINE': {
      const n = splineNurbs(e);
      if (!n) return null;
      const [u0, u1] = domain(n);
      const pc: NurbsPiece = { k: 'nurbs', n, u0, u1 };
      const closed = (e.flags & 1) !== 0 && dist(pieceAt(pc, 0), pieceAt(pc, 1)) <= 1e-6 * Math.max(1, pieceSize(pc));
      return { pieces: [pc], closed, z: n.ctrl[0]!.z };
    }
    case 'XLINE':
    case 'RAY': {
      const d = Math.hypot(e.direction.x, e.direction.y);
      if (!(d > 0)) return null;
      const a = { x: e.base.x, y: e.base.y };
      const b = { x: e.base.x + e.direction.x / d, y: e.base.y + e.direction.y / d };
      return { pieces: [{ k: 'line', a, b, inf0: e.type === 'XLINE', inf1: true }], closed: false, z: e.base.z };
    }
    default:
      return null;
  }
}

function ccw(a0: number, a1: number): number {
  let s = normAngle(a1) - normAngle(a0);
  if (s <= 1e-12) s += TAU;
  return s;
}

function crossUV(p: EllPiece): number {
  return p.u.x * p.v.y - p.u.y * p.v.x;
}

// ---------------------------------------------------------------------------
// 조각 → 객체
// ---------------------------------------------------------------------------

export function makeLine(src: Entity, a: Vec2, b: Vec2, za = 0, zb = za): LineEntity {
  return { type: 'LINE', ...inherit(src), start: { x: a.x, y: a.y, z: za }, end: { x: b.x, y: b.y, z: zb } };
}

/** 호 조각 → ARC(한 바퀴면 CIRCLE) */
export function makeArc(src: Entity, p: ArcPiece, z: number): ArcEntity | CircleEntity {
  const sw = Math.abs(p.sw);
  if (sw >= TAU - 1e-9) return { type: 'CIRCLE', ...inherit(src), center: { x: p.c.x, y: p.c.y, z }, radius: p.r };
  const lo = p.sw >= 0 ? p.a0 : p.a0 + p.sw;
  return {
    type: 'ARC',
    ...inherit(src),
    center: { x: p.c.x, y: p.c.y, z },
    radius: p.r,
    startAngle: normAngle(lo),
    endAngle: normAngle(lo + sw),
  };
}

/** 타원호 조각 → ELLIPSE */
export function makeEllipse(src: Entity, p: EllPiece, z: number): EllipseEntity {
  const el = ellipseFromConjugate(p.c, p.u, p.v, p.t0, p.dt);
  return {
    type: 'ELLIPSE',
    ...inherit(src),
    center: { x: el.c.x, y: el.c.y, z },
    majorAxis: { x: el.major.x, y: el.major.y, z: 0 },
    ratio: el.ratio,
    startParam: el.start,
    endParam: el.end,
  };
}

/** NURBS → SPLINE(조정점 정의) */
export function makeSpline(src: Entity, n: Nurbs, closed = false): SplineEntity {
  const rational = !!n.weights && n.weights.some((w) => Math.abs(w - 1) > 1e-12);
  const planar = n.ctrl.every((q) => Math.abs(q.z - n.ctrl[0]!.z) < 1e-12);
  const base = src.type === 'SPLINE' ? src : null;
  return {
    type: 'SPLINE',
    ...inherit(src),
    flags: (closed ? 1 : 0) | (rational ? 4 : 0) | (planar ? 8 : 0),
    degree: n.degree,
    knots: [...n.knots],
    controlPoints: n.ctrl.map((q) => ({ ...q })),
    weights: rational ? [...n.weights!] : undefined,
    fitPoints: [],
    knotTolerance: base?.knotTolerance ?? 1e-10,
    controlTolerance: base?.controlTolerance ?? 1e-10,
    fitTolerance: base?.fitTolerance ?? 1e-10,
    normal: base?.normal ? { ...base.normal } : undefined,
  };
}

/** 조각 하나의 NURBS(정확: 호·타원호는 유리 2차) */
export function pieceNurbs(p: Piece, z = 0): Nurbs | null {
  switch (p.k) {
    case 'line':
      return beziersToNurbs([lineBezier({ x: p.a.x, y: p.a.y, z: p.za ?? z }, { x: p.b.x, y: p.b.y, z: p.zb ?? p.za ?? z })]);
    case 'arc':
      return beziersToNurbs(arcBeziers(p.c, p.r, p.a0, p.sw, z));
    case 'ell':
      return beziersToNurbs(ellBeziers(p.c, p.u, p.v, p.t0, p.dt, z));
    case 'nurbs': {
      const a = Math.min(p.u0, p.u1);
      const b = Math.max(p.u0, p.u1);
      const [d0, d1] = domain(p.n);
      let n = a <= d0 + 1e-12 && b >= d1 - 1e-12 ? p.n : subNurbs(p.n, a, b);
      if (p.u0 > p.u1) n = reverseNurbs(n);
      return n;
    }
  }
}

/** 이어진 조각들 → NURBS 하나 */
export function piecesNurbs(pieces: readonly Piece[], z = 0): Nurbs | null {
  const segs = [];
  for (const p of pieces) {
    const n = pieceNurbs(p, z);
    if (n) segs.push(...toBezier(n));
  }
  return beziersToNurbs(segs);
}

/** 원본이 POLYLINE이면 POLYLINE, 아니면 LWPOLYLINE. 선·호가 아닌 조각이 있으면 SPLINE */
export function makePolyline(src: Entity, pieces: readonly Piece[], closed: boolean, z: number): Entity | null {
  if (!pieces.length) return null;
  if (pieces.some((p) => p.k !== 'line' && p.k !== 'arc')) {
    const n = piecesNurbs(pieces, z);
    return n ? makeSpline(src, n, closed) : null;
  }
  if (src.type === 'POLYLINE' && src.kind === '3d') return make3dPolyline(src, pieces, closed);
  const verts: LwVertex[] = [];
  const wide = pieces.some((p) => (p.w0 ?? 0) > 0 || (p.w1 ?? 0) > 0);
  for (const p of pieces) {
    const a = pieceAt(p, 0);
    verts.push({ x: a.x, y: a.y, bulge: p.k === 'arc' ? sweepToBulge(p.sw) : 0, startWidth: wide ? (p.w0 ?? 0) : 0, endWidth: wide ? (p.w1 ?? 0) : 0 });
  }
  const last = pieces[pieces.length - 1]!;
  if (!closed) {
    const e = pieceAt(last, 1);
    verts.push({ x: e.x, y: e.y, bulge: 0, startWidth: 0, endWidth: 0 });
  }
  // 폭이 모두 같으면 전역 폭
  let constantWidth = 0;
  if (wide) {
    const w = pieces[0]!.w0 ?? 0;
    if (pieces.every((p) => Math.abs((p.w0 ?? 0) - w) < 1e-12 && Math.abs((p.w1 ?? 0) - w) < 1e-12)) {
      constantWidth = w;
      for (const v of verts) {
        v.startWidth = 0;
        v.endWidth = 0;
      }
    }
  }
  if (src.type === 'POLYLINE') {
    const vs: PolyVertex[] = verts.map((v) => ({ location: { x: v.x, y: v.y, z }, bulge: v.bulge, startWidth: v.startWidth || constantWidth, endWidth: v.endWidth || constantWidth, flags: 0 }));
    return {
      type: 'POLYLINE',
      ...inherit(src),
      kind: '2d',
      flags: (closed ? 1 : 0) | (src.flags & 128),
      vertices: vs,
      elevation: z,
      defaultStartWidth: constantWidth,
      defaultEndWidth: constantWidth,
      mCount: 0,
      nCount: 0,
      mDensity: 0,
      nDensity: 0,
      smoothType: 0,
    };
  }
  return {
    type: 'LWPOLYLINE',
    ...inherit(src),
    ...packLw(verts),
    closed,
    plinegen: src.type === 'LWPOLYLINE' ? src.plinegen : false,
    constantWidth,
    elevation: z,
  };
}

export function make3dPolyline(src: Entity, pieces: readonly Piece[], closed: boolean): PolylineEntity {
  const vs: PolyVertex[] = [];
  for (const p of pieces) {
    const a = pieceAt(p, 0);
    vs.push({ location: { x: a.x, y: a.y, z: p.za ?? 0 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 32 });
  }
  if (!closed && pieces.length) {
    const p = pieces[pieces.length - 1]!;
    const e = pieceAt(p, 1);
    vs.push({ location: { x: e.x, y: e.y, z: p.zb ?? p.za ?? 0 }, bulge: 0, startWidth: 0, endWidth: 0, flags: 32 });
  }
  return {
    type: 'POLYLINE',
    ...inherit(src),
    kind: '3d',
    flags: 8 | (closed ? 1 : 0),
    vertices: vs,
    elevation: 0,
    defaultStartWidth: 0,
    defaultEndWidth: 0,
    mCount: 0,
    nCount: 0,
    mDensity: 0,
    nDensity: 0,
    smoothType: 0,
  };
}

/**
 * 원본과 같은 종류로 경로 일부를 다시 만든다(선 → 선, 호 → 호, 타원 → 타원, 폴리선 → 폴리선, 스플라인 → 스플라인).
 * 닫힌 원본에서 잘라 낸 부분은 열린 객체가 된다.
 */
export function rebuildFrom(src: Entity, pieces0: readonly Piece[], z: number, closed = false): Entity | null {
  if (!pieces0.length) return null;
  const pieces = src.type === 'ARC' || src.type === 'CIRCLE' || src.type === 'ELLIPSE' ? mergeConic(pieces0) : pieces0;
  switch (src.type) {
    case 'LINE': {
      const p = pieces[0]!;
      const a = pieceAt(p, 0);
      const b = pieceAt(pieces[pieces.length - 1]!, 1);
      return makeLine(src, a, b, p.za ?? src.start.z, pieces[pieces.length - 1]!.zb ?? src.end.z);
    }
    case 'ARC':
    case 'CIRCLE':
      if (pieces.length === 1 && pieces[0]!.k === 'arc') return makeArc(src, pieces[0] as ArcPiece, z);
      if (pieces.length === 1 && pieces[0]!.k === 'ell') return makeEllipse(src, pieces[0] as EllPiece, z);
      return makePolyline(src, pieces, closed, z);
    case 'ELLIPSE':
      if (pieces.length === 1 && pieces[0]!.k === 'ell') return makeEllipse(src, pieces[0] as EllPiece, z);
      break;
    case 'SPLINE': {
      const n = piecesNurbs(pieces, z);
      return n ? makeSpline(src, n, closed) : null;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return makePolyline(src, pieces, closed, z);
    default:
      break;
  }
  return makePolyline(src, pieces, closed, z);
}

/** 같은 원(타원) 위에서 이어지는 호 조각을 하나로 */
export function mergeConic(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const q = out[out.length - 1];
    if (q && q.k === 'arc' && p.k === 'arc' && dist(q.c, p.c) <= 1e-9 * Math.max(1, q.r) && Math.abs(q.r - p.r) <= 1e-9 * Math.max(1, q.r) && Math.sign(q.sw) === Math.sign(p.sw)) {
      const end = q.a0 + q.sw;
      const gap = Math.atan2(Math.sin(p.a0 - end), Math.cos(p.a0 - end));
      if (Math.abs(gap) < 1e-9) {
        out[out.length - 1] = { ...q, sw: q.sw + p.sw };
        continue;
      }
    }
    if (q && q.k === 'ell' && p.k === 'ell' && dist(q.c, p.c) <= 1e-12 && dist(q.u, p.u) <= 1e-12 && dist(q.v, p.v) <= 1e-12 && Math.sign(q.dt) === Math.sign(p.dt)) {
      const end = q.t0 + q.dt;
      const gap = Math.atan2(Math.sin(p.t0 - end), Math.cos(p.t0 - end));
      if (Math.abs(gap) < 1e-9) {
        out[out.length - 1] = { ...q, dt: q.dt + p.dt };
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** XLINE·RAY 결과 */
export function makeRay(src: Entity, base: Vec2, dir: Vec2, z: number, type: 'RAY' | 'XLINE' = 'RAY'): XLineEntity {
  const l = Math.hypot(dir.x, dir.y) || 1;
  return { type, ...inherit(src), base: { x: base.x, y: base.y, z }, direction: { x: dir.x / l, y: dir.y / l, z: 0 } };
}

/** 조각 길이가 거의 0인지 */
export function tinyPiece(p: Piece): boolean {
  return pieceLength(p) <= 1e-10 * Math.max(1, pieceSize(p), Math.abs(pieceAt(p, 0).x), Math.abs(pieceAt(p, 0).y));
}

export function v3of(p: Vec2, z = 0): Vec3 {
  return { x: p.x, y: p.y, z };
}
