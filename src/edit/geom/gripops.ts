/**
 * 다기능 그립 커널: 그립 메뉴의 동작(AutoCAD 2026)과 그립 신축 중 입력한 값(동적 치수)의 계산.
 * - 폴리선(LWPOLYLINE·2D POLYLINE): 정점 추가·제거, 세그먼트를 호로·선으로 변환. 폭은 나뉜 세그먼트의 길이 비율로 잇고,
 *   제거하면 앞 세그먼트의 시작 폭에서 뒤 세그먼트의 끝 폭으로 간다.
 * - 선·호·타원형 호 끝: 길이 조정(선은 선 방향으로만, 호는 끝 각도를 점 쪽으로, 타원형 호는 신축과 같다). 호 중간: 반지름.
 * - 스플라인: 맞춤점 추가·제거·끝 접선 방향, 정점(조정점) 추가·정련·제거.
 * - 치수 문자: DIMTMOVE 재지정(치수선과 함께·지시선과 함께·문자만)으로 옮기기, 치수선 위·수직 가운데(DIMTAD), 문자 위치 재설정.
 * - 신축 중 값 입력: 선분 길이(커서 방향), 호 끝은 호 길이, 호 중간은 두 끝을 지킨 반지름, 폴리선 정점은 앞 세그먼트 길이.
 * 좌표는 WCS 평면도다(grips.ts와 같다). 결과는 EditResult(바꾼 객체는 핸들을 지킨다).
 */
import type { ArcEntity, CadDocument, DimensionEntity, Entity, LwPolylineEntity, LwVertex, PolylineEntity, PolyVertex, SplineEntity, Vec2 } from '../../core/model';
import { lwVertices, setLwVertices } from '../../core/lwpoly';
import { clampedKnots } from '../../geom/curves';
import { moveDimensionText } from '../dim/create';
import { type ArcPiece, pieceAt } from './curve';
import { arc3, gripMove, gripPoints } from './grips';
import { type Affine, TAU, add, affApply, affInv, angleOf, ccwFrom, dist, dot, mid, mul, norm, rot90, sub } from './math';
import { domain, insertKnot, normalizeNurbs, type Nurbs } from './nurbs';
import { ocsToWcs, planProj, wcsToOcs } from './ocs';
import { cloneEntity, entityPath, makeArc } from './path';
import { fitAdd, fitDelete, fitTangents, isFitSpline, isPeriodicForm, isSplineClosed, purgeFit } from './splinedit';
import { keepIdentity, lengthenEntity } from './trim';
import { type EditResult, MSG } from './types';

const one = (e: Entity | null | undefined, msg: string = MSG.tooShort): EditResult => (e ? { replace: [e] } : { message: msg });
const gid = (id: string): number => Number(id.slice(1));

// ---------------------------------------------------------------------------
// 폴리선
// ---------------------------------------------------------------------------

interface PV extends LwVertex {
  /** 2D POLYLINE의 원래 정점(플래그·Z를 잇는다) */
  src?: PolyVertex;
}

interface PolyData {
  vs: PV[];
  closed: boolean;
  /** OCS → WCS 평면도 */
  P: Affine;
  inv: Affine;
  write(vs: PV[]): Entity;
}

/** 다기능 그립을 다루는 폴리선(경량, 맞춤·스플라인이 아닌 2D 구형 폴리선)의 정점 자료. 아니면 null */
function polyData(e: Entity): PolyData | null {
  if (e.type === 'LWPOLYLINE') {
    const P = planProj(e.extrusion, e.elevation);
    const inv = affInv(P);
    if (!inv) return null;
    return {
      vs: lwVertices(e),
      closed: e.closed,
      P,
      inv,
      write: (vs) => {
        const r = cloneEntity(e) as LwPolylineEntity;
        setLwVertices(
          r,
          vs.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge, startWidth: v.startWidth, endWidth: v.endWidth })),
        );
        return r;
      },
    };
  }
  if (e.type === 'POLYLINE' && isPlainPoly2d(e)) {
    const P = planProj(e.extrusion, e.elevation);
    const inv = affInv(P);
    if (!inv) return null;
    const z0 = e.vertices[0]?.location.z ?? 0;
    return {
      vs: e.vertices.map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge, startWidth: v.startWidth, endWidth: v.endWidth, src: v })),
      closed: (e.flags & 1) !== 0,
      P,
      inv,
      write: (vs) => {
        const r = cloneEntity(e) as PolylineEntity;
        r.vertices = vs.map((v): PolyVertex => ({ ...(v.src ? structuredClone(v.src) : { flags: 0 }), location: { x: v.x, y: v.y, z: v.src?.location.z ?? z0 }, bulge: v.bulge, startWidth: v.startWidth, endWidth: v.endWidth }));
        return r;
      },
    };
  }
  return null;
}

/** 맞춤·스플라인 곡선이 아닌 2D 폴리선(정점 그립이 정점 그대로) */
export function isPlainPoly2d(e: PolylineEntity): boolean {
  return e.kind === '2d' && !(e.flags & 6) && !e.vertices.some((v) => v.flags & (1 | 8 | 16));
}

/** 정점·세그먼트 그립을 다루는 폴리선인지 */
export function isGripPolyline(e: Entity): boolean {
  return e.type === 'LWPOLYLINE' || (e.type === 'POLYLINE' && isPlainPoly2d(e));
}

/** 세그먼트 i(정점 i → 다음)가 호인지 */
export function polySegmentIsArc(e: Entity, i: number): boolean {
  const pd = polyData(e);
  return !!pd && Math.abs(pd.vs[i]?.bulge ?? 0) > 1e-12;
}

const lerpW = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 세그먼트 a → b를 점 q에서 나눈다(직선은 두 직선, 호는 a·q·b를 지나는 원 위의 두 호). [앞 볼록, 뒤 볼록, 길이 비율] */
function splitSegment(a: PV, b: PV, q: Vec2): [number, number, number] {
  if (Math.abs(a.bulge) > 1e-12) {
    const arc = arc3(a, q, b);
    if (arc) {
      const aq = angleOf(sub(q, arc.c));
      const s1 = arc.sw > 0 ? ccwFrom(arc.a0, aq) : -ccwFrom(aq, arc.a0);
      const s2 = arc.sw - s1;
      return [Math.tan(s1 / 4), Math.tan(s2 / 4), Math.abs(arc.sw) > 0 ? s1 / arc.sw : 0.5];
    }
  }
  const l1 = dist(a, q);
  const l2 = dist(q, b);
  return [0, 0, l1 + l2 > 0 ? l1 / (l1 + l2) : 0.5];
}

/** 새 정점(구형 폴리선은 이웃 정점의 플래그·Z를 잇고 곡선 맞춤 표시·접선은 뺀다) */
function newVertex(q: Vec2, like: PV | undefined, w: number): PV {
  const v: PV = { x: q.x, y: q.y, bulge: 0, startWidth: w, endWidth: w };
  if (like?.src) {
    const { tangent: _t, faceIndices: _f, ...rest } = like.src;
    v.src = { ...rest, flags: rest.flags & ~(1 | 2 | 8 | 16), location: { ...rest.location } };
  }
  return v;
}

/**
 * 정점 추가. 정점 그립 v{i}: 정점과 다음 정점 사이(열린 폴리선의 첫 정점은 앞으로, 마지막 정점은 뒤로 연장).
 * 세그먼트 중간 그립 m{i}: 그 세그먼트를 나눈다. to는 새 정점(WCS)
 */
export function polyAddVertex(e: Entity, id: string, to: Vec2): EditResult {
  const pd = polyData(e);
  if (!pd) return { message: '정점을 추가할 수 없는 객체입니다.' };
  const vs = pd.vs.map((v) => ({ ...v }));
  const n = vs.length;
  const i = gid(id);
  if (!(i >= 0 && i < n)) return { message: '그립이 없습니다.' };
  const q = affApply(pd.inv, to);
  if (id[0] === 'v' && !pd.closed && (i === 0 || i === n - 1) && n >= 1) {
    if (i === 0 && n > 1) {
      // 첫 정점 앞으로 연장: 새 세그먼트는 직선, 폭은 첫 세그먼트의 시작 폭
      vs.unshift(newVertex(q, vs[0], vs[0]!.startWidth));
      return one(pd.write(vs));
    }
    // 마지막 정점 뒤로 연장: 앞 세그먼트의 끝 폭을 잇는다
    const last = vs[n - 1]!;
    const w = n > 1 ? vs[n - 2]!.endWidth : last.startWidth;
    last.bulge = 0;
    last.startWidth = w;
    last.endWidth = w;
    vs.push(newVertex(q, last, w));
    return one(pd.write(vs));
  }
  if (id[0] !== 'v' && id[0] !== 'm') return { message: '그립이 없습니다.' };
  if (!pd.closed && i >= n - 1) return { message: '그립이 없습니다.' };
  const a = vs[i]!;
  const b = vs[(i + 1) % n]!;
  if (dist(a, q) < 1e-12 || dist(b, q) < 1e-12) return { message: MSG.tooShort };
  const [b1, b2, t] = splitSegment(a, b, q);
  const wm = lerpW(a.startWidth, a.endWidth, t);
  const nv = newVertex(q, a, 0);
  nv.bulge = b2;
  nv.startWidth = wm;
  nv.endWidth = a.endWidth;
  a.bulge = b1;
  a.endWidth = wm;
  vs.splice(i + 1, 0, nv);
  return one(pd.write(vs));
}

/** 정점 제거(정점 2개는 남긴다). 앞뒤 두 세그먼트는 직선 하나가 된다 */
export function polyRemoveVertex(e: Entity, id: string): EditResult {
  const pd = polyData(e);
  if (!pd) return { message: '정점을 제거할 수 없는 객체입니다.' };
  const vs = pd.vs.map((v) => ({ ...v }));
  const n = vs.length;
  const i = gid(id);
  if (!(i >= 0 && i < n)) return { message: '그립이 없습니다.' };
  if (n <= 2) return { message: '폴리선에는 정점이 두 개 이상 있어야 합니다.' };
  if (!pd.closed && i === 0) {
    vs.shift();
    return one(pd.write(vs));
  }
  if (!pd.closed && i === n - 1) {
    vs.pop();
    const last = vs[vs.length - 1]!;
    last.bulge = 0;
    return one(pd.write(vs));
  }
  const prev = vs[(i - 1 + n) % n]!;
  const cur = vs[i]!;
  prev.bulge = 0;
  prev.endWidth = cur.endWidth;
  vs.splice(i, 1);
  return one(pd.write(vs));
}

/** 세그먼트 m{i}(또는 정점 v{i}에서 나가는 세그먼트)를 점 to를 지나는 호로 */
export function polySegmentToArc(e: Entity, id: string, to: Vec2): EditResult {
  const pd = polyData(e);
  if (!pd) return { message: MSG.cannotTransform };
  const vs = pd.vs.map((v) => ({ ...v }));
  const n = vs.length;
  const i = gid(id);
  if (!(i >= 0 && i < n) || (!pd.closed && i >= n - 1)) return { message: '그립이 없습니다.' };
  const a = vs[i]!;
  const b = vs[(i + 1) % n]!;
  const arc = arc3(a, affApply(pd.inv, to), b);
  if (!arc || dist(a, b) < 1e-12) return { message: '호를 만들 수 없습니다. 세 점이 한 직선 위에 있습니다.' };
  a.bulge = Math.tan(arc.sw / 4);
  return one(pd.write(vs));
}

/** 호 세그먼트를 직선으로 */
export function polySegmentToLine(e: Entity, id: string): EditResult {
  const pd = polyData(e);
  if (!pd) return { message: MSG.cannotTransform };
  const vs = pd.vs.map((v) => ({ ...v }));
  const i = gid(id);
  if (!vs[i]) return { message: '그립이 없습니다.' };
  vs[i]!.bulge = 0;
  return one(pd.write(vs));
}

/** 폴리선 정점 v{i}(WCS)와 동적 치수의 기준(앞 정점, 열린 폴리선의 첫 정점은 다음 정점) */
function polyAnchor(e: Entity, id: string): { anchor: Vec2; other: Vec2 | null; at: Vec2 } | null {
  const pd = polyData(e);
  if (!pd || id[0] !== 'v') return null;
  const n = pd.vs.length;
  const i = gid(id);
  if (!(i >= 0 && i < n) || n < 2) return null;
  const W = (k: number) => affApply(pd.P, pd.vs[k]!);
  const hasPrev = pd.closed || i > 0;
  const hasNext = pd.closed || i < n - 1;
  const prev = hasPrev ? W((i - 1 + n) % n) : null;
  const next = hasNext ? W((i + 1) % n) : null;
  const anchor = prev ?? next;
  if (!anchor) return null;
  return { anchor, other: prev && next && (n > 2 || !pd.closed) ? next : null, at: W(i) };
}

// ---------------------------------------------------------------------------
// 선·호·타원형 호: 길이 조정, 반지름
// ---------------------------------------------------------------------------

function arcPieceOf(e: ArcEntity): { pc: ArcPiece; z: number } | null {
  const path = entityPath(e);
  const pc = path?.pieces[0];
  return path && pc && pc.k === 'arc' ? { pc, z: path.z } : null;
}

/** 끝 그립의 길이 조정: 선은 선 방향으로만, 호는 끝 각도를 점 쪽으로, 타원형 호는 신축과 같다 */
export function lengthenGrip(e: Entity, id: string, to: Vec2, doc: CadDocument): EditResult {
  if (id !== 'start' && id !== 'end') return { message: '그립이 없습니다.' };
  if (e.type === 'LINE') {
    const fixed = id === 'start' ? e.end : e.start;
    const moving = id === 'start' ? e.start : e.end;
    const L = dist(fixed, moving);
    if (!(L > 0)) return { message: MSG.tooShort };
    const u = mul(sub(moving, fixed), 1 / L);
    const t = dot(sub(to, fixed), u);
    if (!(t > 1e-12)) return { message: MSG.tooShort };
    const r = cloneEntity(e);
    const p = add(fixed, mul(u, t));
    if (id === 'start') r.start = { x: p.x, y: p.y, z: e.start.z };
    else r.end = { x: p.x, y: p.y, z: e.end.z };
    return { replace: [r] };
  }
  if (e.type === 'ARC') {
    const a = arcPieceOf(e);
    if (!a) return { message: MSG.cannotLengthen };
    const { pc, z } = a;
    if (dist(to, pc.c) < 1e-12) return { message: MSG.tooShort };
    const th = angleOf(sub(to, pc.c));
    let a0 = pc.a0;
    let sw: number;
    if (id === 'end') sw = pc.sw > 0 ? ccwFrom(a0, th) : -ccwFrom(th, a0);
    else {
      const a1 = pc.a0 + pc.sw;
      a0 = th;
      sw = pc.sw > 0 ? ccwFrom(th, a1) : -ccwFrom(a1, th);
    }
    if (Math.abs(sw) < 1e-9) return { message: MSG.tooShort };
    return { replace: [keepIdentity(e, makeArc(e, { k: 'arc', c: pc.c, r: pc.r, a0, sw }, z))] };
  }
  if (e.type === 'ELLIPSE') return gripMove(e, id, to, doc);
  return { message: MSG.cannotLengthen };
}

/** 끝 그립의 길이 조정을 값으로: 그 끝에서 전체 길이를 total로(선·호·타원형 호, LENGTHEN 전체와 같다) */
export function lengthenGripTo(e: Entity, id: string, total: number, doc: CadDocument): EditResult {
  if (!(total > 0)) return { message: MSG.tooShort };
  const gp = gripPoints(e, doc).find((g) => g.id === id);
  if (!gp) return { message: '그립이 없습니다.' };
  return lengthenEntity(e, { total }, gp.point);
}

/** 호 중간 그립의 반지름: 중심·각도 유지, 반지름 = 중심~점 */
export function arcRadiusGrip(e: Entity, to: Vec2, doc: CadDocument): EditResult {
  if (e.type !== 'ARC') return { message: MSG.cannotTransform };
  return gripMove(e, 'mid', to, doc, { arcMid: 'radius' });
}

/** 호 반지름을 값으로(중심·각도 유지) */
export function arcRadiusTo(e: Entity, r: number): EditResult {
  if (e.type !== 'ARC') return { message: MSG.cannotTransform };
  if (!(r > 0)) return { message: MSG.tooShort };
  const a = arcPieceOf(e);
  if (!a) return { message: MSG.cannotTransform };
  return { replace: [keepIdentity(e, makeArc(e, { ...a.pc, r }, a.z))] };
}

/** 두 끝을 지킨 채 반지름을 r로(호 중간 그립 신축 중 값 입력). 큰 호·작은 호와 방향을 지킨다 */
export function arcRadiusKeepEnds(e: Entity, r: number): EditResult {
  if (e.type !== 'ARC') return { message: MSG.cannotTransform };
  const a = arcPieceOf(e);
  if (!a) return { message: MSG.cannotTransform };
  const { pc, z } = a;
  const p0 = pieceAt(pc, 0);
  const p1 = pieceAt(pc, 1);
  const c = dist(p0, p1);
  if (!(c > 1e-12) || !(r >= c / 2 - 1e-12)) return { message: '반지름이 두 끝 사이 거리의 절반보다 커야 합니다.' };
  const m = mid(p0, p1);
  const u = norm(sub(p1, p0));
  const nrm = rot90(u);
  let s = Math.sign(dot(sub(pc.c, m), nrm));
  if (Math.abs(dot(sub(pc.c, m), nrm)) < 1e-9 * Math.max(1, pc.r)) s = pc.sw > 0 ? 1 : -1;
  const h = Math.sqrt(Math.max(0, r * r - (c / 2) * (c / 2)));
  const cc = add(m, mul(nrm, s * h));
  const a0 = angleOf(sub(p0, cc));
  const a1 = angleOf(sub(p1, cc));
  let sw = pc.sw > 0 ? ccwFrom(a0, a1) : -ccwFrom(a1, a0);
  if (Math.abs(sw) < 1e-12) sw = pc.sw > 0 ? TAU - 1e-9 : -(TAU - 1e-9);
  return { replace: [keepIdentity(e, makeArc(e, { k: 'arc', c: cc, r, a0, sw }, z))] };
}

// ---------------------------------------------------------------------------
// 스플라인
// ---------------------------------------------------------------------------

function cvBase(e: SplineEntity): SplineEntity {
  return isFitSpline(e) || e.controlPoints.length < 2 ? purgeFit(e) : cloneEntity(e);
}

function nurbsOf(x: SplineEntity): Nurbs {
  return normalizeNurbs({ degree: x.degree, knots: x.knots, ctrl: x.controlPoints, weights: x.weights });
}

function writeNurbs(x: SplineEntity, m: Nurbs): SplineEntity {
  x.degree = m.degree;
  x.knots = [...m.knots];
  x.controlPoints = m.ctrl.map((q) => ({ ...q }));
  if (m.weights) {
    x.weights = [...m.weights];
    x.flags |= 4;
  } else {
    delete x.weights;
    x.flags &= ~4;
  }
  return x;
}

/** 조정점 j의 그레빌 매개변수(조정점이 곡선에 가장 영향을 주는 자리) */
function greville(c: Nurbs, j: number): number {
  let s = 0;
  for (let k = 1; k <= c.degree; k++) s += c.knots[j + k]!;
  return s / c.degree;
}

/** 맞춤점 추가: 맞춤점 i 다음에(마지막 맞춤점이면 뒤로 연장) */
export function splineFitAddGrip(e: SplineEntity, i: number, to: Vec2): EditResult {
  return one(fitAdd(e, i, to), '맞춤점을 추가할 수 없습니다.');
}

/** 맞춤점 제거(열린 스플라인 2개, 닫힌 스플라인 3개는 남긴다) */
export function splineFitDeleteGrip(e: SplineEntity, i: number): EditResult {
  return one(fitDelete(e, i), '맞춤점을 더 제거할 수 없습니다.');
}

/** 첫·마지막 맞춤점의 접선 방향: 맞춤점에서 점 to 쪽 */
export function splineFitTangentGrip(e: SplineEntity, i: number, to: Vec2): EditResult {
  const n = e.fitPoints.length;
  if (!isFitSpline(e) || isSplineClosed(e) || (i !== 0 && i !== n - 1)) return { message: '접선은 열린 스플라인의 첫·마지막 맞춤점에만 있습니다.' };
  const p = e.fitPoints[i]!;
  const d = sub(to, p);
  if (Math.hypot(d.x, d.y) < 1e-12) return { message: MSG.tooShort };
  return one(i === 0 ? fitTangents(e, d, undefined) : fitTangents(e, undefined, d), '접선을 바꿀 수 없습니다.');
}

/** 정점 추가: 정점 i와 다음 정점 사이(마지막 정점은 앞 정점과의 사이)에 매듭을 넣고 새 정점을 to에 둔다 */
export function splineCvInsertGrip(e: SplineEntity, i: number, to: Vec2): EditResult {
  const x = cvBase(e);
  if (isPeriodicForm(x) || x.controlPoints.length < 2) return { message: '닫힌 스플라인에는 이 그립으로 정점을 추가할 수 없습니다.' };
  const c = nurbsOf(x);
  const N = c.ctrl.length;
  if (!(i >= 0 && i < N)) return { message: '그립이 없습니다.' };
  const j = Math.min(i, N - 2);
  const [a, b] = domain(c);
  const u = (greville(c, j) + greville(c, j + 1)) / 2;
  if (!(u > a && u < b)) return { message: '정점을 추가할 수 없습니다.' };
  const m = normalizeNurbs(insertKnot(c, u, 1));
  if (m.ctrl.length !== N + 1) return { message: '정점을 추가할 수 없습니다.' };
  const k = j + 1;
  m.ctrl[k] = { x: to.x, y: to.y, z: m.ctrl[k]!.z };
  return { replace: [writeNurbs(x, m)] };
}

/** 정점 정련: 정점 i 자리에 매듭을 넣어 정점을 늘린다(모양 유지) */
export function splineCvRefineGrip(e: SplineEntity, i: number): EditResult {
  const x = cvBase(e);
  if (isPeriodicForm(x) || x.controlPoints.length < 2) return { message: '닫힌 스플라인에는 이 그립으로 정점을 정련할 수 없습니다.' };
  const c = nurbsOf(x);
  const N = c.ctrl.length;
  if (!(i >= 0 && i < N)) return { message: '그립이 없습니다.' };
  const [a, b] = domain(c);
  let u = greville(c, i);
  if (!(u > a + 1e-9 * (b - a) && u < b - 1e-9 * (b - a))) u = (greville(c, i) + greville(c, i === 0 ? 1 : i - 1)) / 2;
  if (!(u > a && u < b)) return { message: '정점을 정련할 수 없습니다.' };
  const m = normalizeNurbs(insertKnot(c, u, 1));
  if (m.ctrl.length !== N + 1) return { message: '정점을 정련할 수 없습니다.' };
  return { replace: [writeNurbs(x, m)] };
}

/** 정점 제거: 그 정점과 가장 가까운 안쪽 매듭 하나를 뺀다(안쪽 매듭이 없으면 차수를 하나 내린다). 정점 2개는 남긴다 */
export function splineCvDeleteGrip(e: SplineEntity, i: number): EditResult {
  const x = cvBase(e);
  if (isPeriodicForm(x)) return { message: '닫힌 스플라인에서는 이 그립으로 정점을 제거할 수 없습니다.' };
  const c = nurbsOf(x);
  const N = c.ctrl.length;
  if (!(i >= 0 && i < N)) return { message: '그립이 없습니다.' };
  if (N <= 2) return { message: '스플라인에는 정점이 두 개 이상 있어야 합니다.' };
  const ctrl = c.ctrl.filter((_, k) => k !== i);
  const weights = c.weights?.filter((_, k) => k !== i);
  let p = c.degree;
  let knots: number[];
  if (N - 1 >= p + 1) {
    const g = greville(c, i);
    let best = -1;
    for (let k = p + 1; k <= N - 1; k++) if (best < 0 || Math.abs(c.knots[k]! - g) < Math.abs(c.knots[best]! - g)) best = k;
    knots = c.knots.filter((_, k) => k !== best);
  } else {
    p = N - 2;
    knots = clampedKnots(N - 1, p);
  }
  return { replace: [writeNurbs(x, normalizeNurbs({ degree: p, knots, ctrl, weights }))] };
}

// ---------------------------------------------------------------------------
// 치수 문자
// ---------------------------------------------------------------------------

/** DIMTMOVE 재지정 값: 0 치수선과 함께, 1 지시선과 함께, 2 문자만 */
export type DimTextMove = 0 | 1 | 2;

/** 문자를 to(WCS)로 옮긴다. DIMTMOVE를 그 값으로 재지정한다(블록은 확정할 때 다시 만든다) */
export function dimTextMoveGrip(e: DimensionEntity, mode: DimTextMove, to: Vec2, doc: CadDocument): EditResult {
  const r = cloneEntity(e);
  r.overrides = { ...(e.overrides ?? {}), 279: mode };
  const w = ocsToWcs(e.textMid, e.extrusion);
  const q = wcsToOcs({ x: to.x, y: to.y, z: w.z }, e.extrusion);
  try {
    return { replace: [moveDimensionText(doc, r, { x: q.x, y: q.y, z: e.textMid.z })] };
  } catch {
    r.textMid = { x: q.x, y: q.y, z: e.textMid.z };
    r.dimType |= 128;
    return { replace: [r] };
  }
}

/** 문자 위치 재설정: 옮긴 문자 표시(70 비트 128)를 지운다 — 확정할 때 문자가 기본 자리로 간다 */
export function dimTextHome(e: DimensionEntity): EditResult {
  const r = cloneEntity(e);
  r.dimType &= ~128;
  return { replace: [r] };
}

/** 치수선 위(DIMTAD 1)·수직 가운데(0) 재지정. 문자는 치수선의 기본 자리로 돌아간다 */
export function dimTextVertical(e: DimensionEntity, tad: 0 | 1): EditResult {
  const r = cloneEntity(e);
  r.overrides = { ...(e.overrides ?? {}), 77: tad };
  r.dimType &= ~128;
  return { replace: [r] };
}

// ---------------------------------------------------------------------------
// 그립 신축 중 값 입력(동적 치수)
// ---------------------------------------------------------------------------

/** 동적 치수 한 개: 정렬 길이(a → b), 호 길이(동심 호), 반지름(중심 → 호 위 점) */
export type GripDim =
  | { kind: 'aligned'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; a0: number; sw: number }
  | { kind: 'radius'; c: Vec2; p: Vec2; r: number };

/** 신축 중 값을 받는 그립인지(선 끝, 호 끝·중간, 폴리선 정점) */
export function gripTakesValue(e: Entity, id: string): boolean {
  if (e.type === 'LINE') return id === 'start' || id === 'end';
  if (e.type === 'ARC') return id === 'start' || id === 'end' || id === 'mid';
  return isGripPolyline(e) && id[0] === 'v';
}

/**
 * 그립 신축 중 입력한 값으로 고친 결과(AutoCAD 동적 입력의 첫 칸): 선 끝 = 선분 길이(커서 방향, 커서가 없으면 지금 방향),
 * 호 끝 = 호 길이(중심·반지름 유지), 호 중간 = 두 끝을 지킨 반지름, 폴리선 정점 = 앞 세그먼트 길이(커서 방향). 다루지 않으면 null
 */
export function gripStretchValue(e: Entity, id: string, value: number, cursor: Vec2 | null, doc: CadDocument): EditResult | null {
  if (!gripTakesValue(e, id)) return null;
  if (!(value > 0)) return { message: MSG.tooShort };
  const towards = (anchor: Vec2, cur: Vec2): Vec2 => {
    const c = cursor && dist(cursor, anchor) > 1e-12 ? cursor : cur;
    const d = sub(c, anchor);
    const l = Math.hypot(d.x, d.y);
    return l > 0 ? add(anchor, mul(d, value / l)) : add(anchor, { x: value, y: 0 });
  };
  if (e.type === 'LINE') {
    const anchor = id === 'start' ? e.end : e.start;
    const cur = id === 'start' ? e.start : e.end;
    return gripMove(e, id, towards(anchor, cur), doc);
  }
  if (e.type === 'ARC') return id === 'mid' ? arcRadiusKeepEnds(e, value) : lengthenGripTo(e, id, value, doc);
  const pa = polyAnchor(e, id);
  if (!pa) return null;
  return gripMove(e, id, towards(pa.anchor, pa.at), doc);
}

/** 신축 결과(after)의 동적 치수: 선분 길이, 호 길이·반지름, 폴리선 정점의 앞뒤 세그먼트 길이 */
export function gripDims(before: Entity, id: string, after: Entity): GripDim[] {
  if (after.type === 'LINE' && before.type === 'LINE') {
    if (id === 'start') return [{ kind: 'aligned', a: after.end, b: after.start }];
    if (id === 'end') return [{ kind: 'aligned', a: after.start, b: after.end }];
    return [];
  }
  if (after.type === 'ARC' && before.type === 'ARC') {
    const a = arcPieceOf(after);
    if (!a) return [];
    if (id === 'mid') return [{ kind: 'radius', c: a.pc.c, p: pieceAt(a.pc, 0.5), r: a.pc.r }];
    if (id === 'start' || id === 'end') return [{ kind: 'arc', c: a.pc.c, r: a.pc.r, a0: a.pc.a0, sw: a.pc.sw }];
    return [];
  }
  if (isGripPolyline(after) && id[0] === 'v') {
    const pa = polyAnchor(after, id);
    if (!pa) return [];
    const out: GripDim[] = [{ kind: 'aligned', a: pa.anchor, b: pa.at }];
    if (pa.other) out.push({ kind: 'aligned', a: pa.at, b: pa.other });
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// 여러 핫 그립
// ---------------------------------------------------------------------------

/**
 * 한 객체의 여러 그립을 차례로 신축한다(같은 변위를 받은 각 그립의 목표점). 앞 그립의 결과에 다음 그립을 적용한다.
 * 결과가 객체 하나로 바뀌지 않으면(종류가 바뀜·안내) 거기서 멈추고 그때까지의 결과를 돌려준다
 */
export function gripMoveMany(e: Entity, moves: readonly { id: string; to: Vec2 }[], doc: CadDocument, opts?: Parameters<typeof gripMove>[4]): EditResult {
  let cur = e;
  let last: EditResult | null = null;
  for (const m of moves) {
    const r = gripMove(cur, m.id, m.to, doc, opts);
    if (r.message && !r.replace?.length && !r.add?.length) return last ?? r;
    last = r;
    const next = r.replace?.length === 1 && !r.add?.length && r.replace[0]!.handle === e.handle ? r.replace[0]! : null;
    if (!next) return r;
    cur = next;
  }
  return last ?? {};
}
