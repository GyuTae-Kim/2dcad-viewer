/**
 * 그립: gripPoints(객체의 그립 목록, 평면도 WCS)와 gripMove(그립 신축, AutoCAD 규칙).
 * - 선: 끝(끝점만), 중간(선 이동). 호: 중심(이동), 끝(끝점·중간점·다른 끝을 지나는 세 점 호), 중간(두 끝과 새 점을 지나는 호,
 *   radius 모드는 반지름만). 원: 중심(이동), 사분점(반지름).
 * - 타원: 중심(이동), 축 끝(그 축 반지름, 단축이 길어지면 두 축을 맞바꾸고 매개변수 −π/2), 호 끝(중심에서 점으로 가는 반직선의 교점).
 * - 폴리선: 정점(이동), 세그먼트 중간(직선은 세그먼트 평행 이동, 호는 새 점을 지나는 호).
 * - 스플라인: 맞춤점(조정점을 다시 구한다) 또는 조정점. 문자·블록 참조·점 등: 삽입점(이동), 블록 속성(그 속성만).
 * - 치수: 정의점·문자(측정값을 다시 잰다). 문자 그립은 DIMTMOVE(재지정, 없으면 스타일)를 따른다 — 0이면 치수선도 문자를 따라간다.
 *   블록 그림은 regenDimension이 있으면 그것으로, 없으면 문자 그립만 근사한다.
 * - 가리기(WIPEOUT): 경계 꼭짓점(그 꼭짓점 신축). 자르지 않은 이미지(IMAGE): 네 구석(맞은편 구석을 두고 가로세로 비율을 지킨 축척).
 */
import type {
  ArcEntity,
  BlockDef,
  CadDocument,
  CircleEntity,
  DimensionEntity,
  EllipseEntity,
  Entity,
  HatchEntity,
  ImageEntity,
  InsertEntity,
  LwPolylineEntity,
  MTextEntity,
  PolylineEntity,
  SplineEntity,
  TextEntity,
  Vec2,
  Vec3,
} from '../../core/model';
import { tableKey } from '../../core/model';
import { bulgeVertices, lwVertices, numArray, setLwVertices, vertCount } from '../../core/lwpoly';
import { bulgeArc, interpolateFitPoints } from '../../geom/curves';
import { moveDimensionText } from '../dim/create';
import { type EllPiece, pieceAt } from './curve';
import { makeWipeout, wipeoutPolygon } from './markup';
import { type Affine, TAU, add, affApply, affInv, affLin, affScale, affTranslate, angleOf, ccwFrom, dist, dot, mid, normAngle, sub } from './math';
import { cloneEntity, entityPath, freshEntity, makeArc } from './path';
import { isNaturalExt, planProj } from './ocs';
import { insertionPoint } from './query';
import { dimPoints, moveDimPoint, recomputeMLine } from './stretch';
import { transformEntity } from './transform';
import { keepIdentity } from './trim';
import { type EditResult, type GripPoint, MSG, allocBlockName } from './types';
import { updateDimNumber } from './xannot';
import { mtextDir } from './xtext';

export interface GripOptions {
  /** 호 중간 그립: 'stretch'(기본, 세 점 호) 또는 'radius'(반지름만) */
  arcMid?: 'stretch' | 'radius';
  /** 치수 블록을 다시 만드는 함수(치수 생성기). 없으면 문자 그립만 근사한다 */
  regenDimension?: (d: DimensionEntity, doc: CadDocument) => BlockDef | null;
}

const g = (id: string, point: Vec2, kind: GripPoint['kind']): GripPoint => ({ id, point: { x: point.x, y: point.y }, kind });

/** 블록 참조에 다른 모듈이 더하는 그립(연관 배열 등 — id는 그 모듈의 접두어, 그 그립의 편집도 그 모듈이 한다) */
export const insertGripProviders: ((e: InsertEntity, doc: CadDocument) => GripPoint[])[] = [];

// ---------------------------------------------------------------------------
// 그립 목록
// ---------------------------------------------------------------------------

export function gripPoints(e: Entity, doc: CadDocument): GripPoint[] {
  switch (e.type) {
    case 'LINE':
      return [g('start', e.start, 'end'), g('mid', mid(e.start, e.end), 'mid'), g('end', e.end, 'end')];
    case 'ARC': {
      const pc = entityPath(e)!.pieces[0]!;
      const c = pc.k === 'arc' ? pc.c : affApply(planProj(e.extrusion, e.center.z), e.center);
      return [g('center', c, 'cen'), g('start', pieceAt(pc, 0), 'end'), g('mid', pieceAt(pc, 0.5), 'mid'), g('end', pieceAt(pc, 1), 'end')];
    }
    case 'CIRCLE': {
      const c = affApply(planProj(e.extrusion, e.center.z), e.center);
      return [
        g('center', c, 'cen'),
        g('q0', { x: c.x + e.radius, y: c.y }, 'qua'),
        g('q1', { x: c.x, y: c.y + e.radius }, 'qua'),
        g('q2', { x: c.x - e.radius, y: c.y }, 'qua'),
        g('q3', { x: c.x, y: c.y - e.radius }, 'qua'),
      ];
    }
    case 'ELLIPSE': {
      const pc = entityPath(e)!.pieces[0] as EllPiece;
      const out = [
        g('center', pc.c, 'cen'),
        g('maj+', add(pc.c, pc.u), 'qua'),
        g('min+', add(pc.c, pc.v), 'qua'),
        g('maj-', sub(pc.c, pc.u), 'qua'),
        g('min-', sub(pc.c, pc.v), 'qua'),
      ];
      if (!entityPath(e)!.closed) out.push(g('start', pieceAt(pc, 0), 'end'), g('end', pieceAt(pc, 1), 'end'));
      return out;
    }
    case 'LWPOLYLINE':
      return polyGrips(
        lwVertices(e),
        e.closed,
        planProj(e.extrusion, e.elevation),
      );
    case 'POLYLINE': {
      if (e.kind === '2d') {
        const idx = e.vertices.map((v, i) => (v.flags & 16 ? -1 : i)).filter((i) => i >= 0);
        const grips = polyGrips(
          idx.map((i) => ({ x: e.vertices[i]!.location.x, y: e.vertices[i]!.location.y, bulge: e.vertices[i]!.bulge })),
          (e.flags & 1) !== 0,
          planProj(e.extrusion, e.elevation),
        );
        // 그립 번호는 원래 정점 번호로
        return grips.map((q) => ({ ...q, id: q.id[0] + String(idx[Number(q.id.slice(1))]) }));
      }
      return e.vertices.map((v, i) => (e.kind === 'polyface' && v.faceIndices && !(v.flags & 64) ? null : g('v' + i, v.location, 'vertex'))).filter((x): x is GripPoint => !!x);
    }
    case 'SPLINE':
      if (e.fitPoints.length >= 2) return e.fitPoints.map((p, i) => g('f' + i, p, 'fit'));
      return e.controlPoints.map((p, i) => g('c' + i, p, 'ctrl'));
    case 'XLINE':
    case 'RAY':
      return [g('base', e.base, e.type === 'XLINE' ? 'mid' : 'end'), g('dir', add(e.base, e.direction), 'ctrl')];
    case 'POINT':
      return [g('pos', e.position, 'ins')];
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      const P = planProj(e.extrusion, e.insert.z);
      if ((e.halign === 3 || e.halign === 5) && e.alignPoint) return [g('ins', affApply(P, e.insert), 'text'), g('align', affApply(P, e.alignPoint), 'text')];
      return [g('ins', insertionPoint(e)!, 'text')];
    }
    case 'MTEXT': {
      const out = [g('ins', e.insert, 'text')];
      if (e.width > 0) out.push(g('width', mtextWidthGrip(e), 'ctrl'));
      return out;
    }
    case 'INSERT': {
      const out = [g('ins', insertionPoint(e)!, 'ins')];
      e.attribs.forEach((a, i) => {
        if (!(a.attFlags & 1) && !a.lockPosition) out.push(g('a' + i, insertionPoint(a)!, 'text'));
      });
      for (const f of insertGripProviders) out.push(...f(e, doc));
      return out;
    }
    case 'DIMENSION':
      return dimPoints(e).map((k) => g(k.key, k.p, k.key === 'textMid' ? 'text' : 'end'));
    case 'LEADER':
      return e.vertices.map((v, i) => g('v' + i, v, 'vertex'));
    case 'MULTILEADER': {
      const out = [g('content', e.context.contentBase, 'ins')];
      e.context.leaders.forEach((ld, li) => {
        if (ld.lastLeaderPoint) out.push(g(`land${li}`, ld.lastLeaderPoint, 'end'));
        ld.lines.forEach((ln, k) => ln.vertices.forEach((v, vi) => out.push(g(`l${li}.${k}.${vi}`, v, 'vertex'))));
      });
      return out;
    }
    case 'HATCH':
    case 'MPOLYGON':
      return hatchGrips(e, doc);
    case 'SOLID':
    case 'TRACE': {
      const P = planProj(e.extrusion, e.points[0].z);
      return e.points.map((p, i) => g('v' + i, affApply(P, p), 'vertex'));
    }
    case '3DFACE':
      return e.points.map((p, i) => g('v' + i, p, 'vertex'));
    case 'MLINE':
      return e.vertices.map((v, i) => g('v' + i, v.position, 'vertex'));
    case 'MESH':
      return e.vertices.map((v, i) => g('v' + i, v, 'vertex'));
    case 'VIEWPORT': {
      const c = e.center;
      const w = e.width / 2;
      const h = e.height / 2;
      return [
        g('center', c, 'cen'),
        g('v0', { x: c.x - w, y: c.y - h }, 'vertex'),
        g('v1', { x: c.x + w, y: c.y - h }, 'vertex'),
        g('v2', { x: c.x + w, y: c.y + h }, 'vertex'),
        g('v3', { x: c.x - w, y: c.y + h }, 'vertex'),
      ];
    }
    case 'WIPEOUT': {
      const poly = wipeoutPolygon(e);
      if (poly.length >= 3) return poly.map((p, i) => g('v' + i, p, 'vertex'));
      return [g('ins', insertionPoint(e)!, 'ins')];
    }
    case 'IMAGE':
      if (!e.clipping) return imageCorners(e).map((p, i) => g('v' + i, p, 'vertex'));
      return [g('ins', insertionPoint(e)!, 'ins')];
    case 'SHAPE':
    case 'TOLERANCE':
    case 'ACAD_TABLE':
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      return [g('ins', insertionPoint(e)!, 'ins')];
    case 'OLE2FRAME':
    case 'OLEFRAME':
      return [g('v0', e.upperLeft, 'vertex'), g('v1', e.lowerRight, 'vertex')];
    default:
      return [];
  }
}

function polyGrips(vs: { x: number; y: number; bulge: number }[], closed: boolean, P: Affine): GripPoint[] {
  const out: GripPoint[] = [];
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    out.push(g('v' + i, affApply(P, vs[i]!), 'vertex'));
    if (i < n - 1 || closed) {
      const a = vs[i]!;
      const b = vs[(i + 1) % n]!;
      out.push(g('m' + i, affApply(P, segMid(a, b, a.bulge)), 'mid'));
    }
  }
  return out;
}

function segMid(a: Vec2, b: Vec2, bulge: number): Vec2 {
  const arc = Math.abs(bulge) > 1e-12 ? bulgeArc(a.x, a.y, b.x, b.y, bulge) : null;
  if (!arc) return mid(a, b);
  const m = arc.a0 + arc.sweep / 2;
  return { x: arc.cx + arc.r * Math.cos(m), y: arc.cy + arc.r * Math.sin(m) };
}

/** 자르지 않은 이미지의 네 구석(WCS): 왼쪽 아래(삽입점) → 오른쪽 아래 → 오른쪽 위 → 왼쪽 위 */
function imageCorners(e: ImageEntity): Vec2[] {
  const o = { x: e.insert.x, y: e.insert.y };
  const u = { x: e.uVector.x * e.imageSize.x, y: e.uVector.y * e.imageSize.x };
  const v = { x: e.vVector.x * e.imageSize.y, y: e.vVector.y * e.imageSize.y };
  return [o, add(o, u), add(add(o, u), v), add(o, v)];
}

function mtextWidthGrip(e: MTextEntity): Vec2 {
  const u = mtextDir(e);
  const col = ((e.attachment >= 1 && e.attachment <= 9 ? e.attachment : 1) - 1) % 3;
  const k = col === 0 ? e.width : col === 1 ? e.width / 2 : -e.width;
  return { x: e.insert.x + u.x * k, y: e.insert.y + u.y * k };
}

function hatchGrips(e: HatchEntity, doc: CadDocument): GripPoint[] {
  const P = planProj(e.extrusion, e.elevation);
  const out: GripPoint[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  e.paths.forEach((p, k) => {
    const pts: Vec2[] = [];
    if (p.polyline) for (const v of bulgeVertices(p.polyline.verts)) pts.push(v);
    else for (const ed of p.edges ?? []) if (ed.type === 'line') pts.push(ed.start);
    pts.forEach((q, i) => {
      const w = affApply(P, q);
      minX = Math.min(minX, w.x);
      minY = Math.min(minY, w.y);
      maxX = Math.max(maxX, w.x);
      maxY = Math.max(maxY, w.y);
      if (!e.associative) out.push(g(`p${k}.${i}`, w, 'vertex'));
    });
  });
  void doc;
  if (Number.isFinite(minX)) out.unshift(g('center', { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, 'cen'));
  return out;
}

// ---------------------------------------------------------------------------
// 그립 신축
// ---------------------------------------------------------------------------

export function gripMove(e: Entity, id: string, to: Vec2, doc: CadDocument, opts: GripOptions = {}): EditResult {
  const grips = gripPoints(e, doc);
  const gp = grips.find((q) => q.id === id);
  if (!gp) return { message: '그립이 없습니다.' };
  const d = sub(to, gp.point);
  const move = (): EditResult => transformEntity(e, affTranslate(d.x, d.y), doc);
  switch (e.type) {
    case 'LINE': {
      if (id === 'mid') return move();
      const r = cloneEntity(e);
      if (id === 'start') r.start = { x: to.x, y: to.y, z: e.start.z };
      else r.end = { x: to.x, y: to.y, z: e.end.z };
      return { replace: [r] };
    }
    case 'ARC':
      return arcGrip(e, id, to, opts);
    case 'CIRCLE': {
      if (id === 'center') return move();
      const c = affApply(planProj(e.extrusion, e.center.z), e.center);
      const r = dist(c, to);
      if (!(r > 0)) return { message: MSG.tooShort };
      const out = cloneEntity(e) as CircleEntity;
      out.radius = r;
      return { replace: [out] };
    }
    case 'ELLIPSE':
      return id === 'center' ? move() : ellipseGrip(e, id, to);
    case 'LWPOLYLINE':
      return { replace: [lwGrip(e, id, to)] };
    case 'POLYLINE':
      return { replace: [polylineGrip(e, id, to)] };
    case 'SPLINE':
      return { replace: [splineGrip(e, id, to)] };
    case 'XLINE':
    case 'RAY': {
      if (id === 'base') return move();
      const dv = sub(to, e.base);
      const l = Math.hypot(dv.x, dv.y);
      if (!(l > 0)) return { message: MSG.tooShort };
      const r = cloneEntity(e);
      r.direction = { x: dv.x / l, y: dv.y / l, z: 0 };
      return { replace: [r] };
    }
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      if (id === 'ins' && !((e.halign === 3 || e.halign === 5) && e.alignPoint)) return move();
      const r = cloneEntity(e) as TextEntity;
      const P = planProj(e.extrusion, e.insert.z);
      const inv = affInv(P)!;
      const q = affApply(inv, to);
      if (id === 'ins') r.insert = { x: q.x, y: q.y, z: e.insert.z };
      else r.alignPoint = { x: q.x, y: q.y, z: e.alignPoint!.z };
      return { replace: [r] };
    }
    case 'MTEXT': {
      if (id === 'ins') return move();
      const u = mtextDir(e);
      const k = (to.x - e.insert.x) * u.x + (to.y - e.insert.y) * u.y;
      const col = ((e.attachment >= 1 && e.attachment <= 9 ? e.attachment : 1) - 1) % 3;
      const w = col === 0 ? k : col === 1 ? 2 * Math.abs(k) : -k;
      if (!(w > 0)) return { message: MSG.tooShort };
      const r = cloneEntity(e);
      r.width = w;
      return { replace: [r] };
    }
    case 'INSERT': {
      if (id === 'ins') return move();
      const i = Number(id.slice(1));
      const a = e.attribs[i];
      if (!a) return { message: '그립이 없습니다.' };
      const r = cloneEntity(e);
      const moved = transformEntity(a, affTranslate(d.x, d.y), doc).replace?.[0];
      if (moved && (moved.type === 'ATTRIB' || moved.type === 'ATTDEF')) r.attribs[i] = moved as typeof a;
      return { replace: [r] };
    }
    case 'DIMENSION':
      return dimGrip(e, id as Parameters<typeof moveDimPoint>[1], d, doc, opts);
    case 'LEADER': {
      const i = Number(id.slice(1));
      const r = cloneEntity(e);
      r.vertices[i] = { x: to.x, y: to.y, z: e.vertices[i]!.z };
      return { replace: [r] };
    }
    case 'MULTILEADER': {
      const r = cloneEntity(e);
      const c = r.context;
      const mv = (p: Vec3): Vec3 => ({ x: p.x + d.x, y: p.y + d.y, z: p.z });
      if (id === 'content') {
        c.contentBase = mv(c.contentBase);
        c.basePoint = mv(c.basePoint);
        if (c.text) c.text.location = mv(c.text.location);
        if (c.block) c.block.location = mv(c.block.location);
        for (const ld of c.leaders) if (ld.lastLeaderPoint) ld.lastLeaderPoint = mv(ld.lastLeaderPoint);
      } else if (id.startsWith('land')) {
        const ld = c.leaders[Number(id.slice(4))];
        if (ld?.lastLeaderPoint) ld.lastLeaderPoint = mv(ld.lastLeaderPoint);
      } else {
        const [li, k, vi] = id.slice(1).split('.').map(Number);
        const ln = c.leaders[li!]?.lines[k!];
        if (ln && ln.vertices[vi!]) ln.vertices[vi!] = mv(ln.vertices[vi!]!);
      }
      return { replace: [r] };
    }
    case 'HATCH':
    case 'MPOLYGON':
      return id === 'center' ? move() : { replace: [hatchGrip(e, id, d)] };
    case 'SOLID':
    case 'TRACE': {
      const i = Number(id.slice(1));
      const r = cloneEntity(e);
      const P = planProj(e.extrusion, e.points[0].z);
      const q = affApply(affInv(P)!, to);
      r.points[i] = { x: q.x, y: q.y, z: e.points[i]!.z };
      return { replace: [r] };
    }
    case '3DFACE': {
      const i = Number(id.slice(1));
      const r = cloneEntity(e);
      r.points[i] = { x: to.x, y: to.y, z: e.points[i]!.z };
      return { replace: [r] };
    }
    case 'MLINE': {
      const i = Number(id.slice(1));
      const r = cloneEntity(e);
      r.vertices[i]!.position = { x: to.x, y: to.y, z: e.vertices[i]!.position.z };
      if (i === 0) r.startPoint = { ...r.vertices[0]!.position };
      recomputeMLine(r);
      return { replace: [r] };
    }
    case 'MESH': {
      const i = Number(id.slice(1));
      const r = cloneEntity(e);
      r.vertices[i] = { x: to.x, y: to.y, z: e.vertices[i]!.z };
      return { replace: [r] };
    }
    case 'VIEWPORT': {
      if (id === 'center') return move();
      const i = Number(id.slice(1));
      const opp = grips.find((q) => q.id === 'v' + ((i + 2) % 4))!.point;
      const r = cloneEntity(e);
      r.center = { x: (opp.x + to.x) / 2, y: (opp.y + to.y) / 2, z: e.center.z };
      r.width = Math.abs(to.x - opp.x);
      r.height = Math.abs(to.y - opp.y);
      if (!(r.width > 0 && r.height > 0)) return { message: MSG.tooShort };
      return { replace: [r] };
    }
    case 'OLE2FRAME':
    case 'OLEFRAME': {
      const r = cloneEntity(e);
      if (id === 'v0') r.upperLeft = { x: to.x, y: to.y, z: e.upperLeft.z };
      else r.lowerRight = { x: to.x, y: to.y, z: e.lowerRight.z };
      return { replace: [r] };
    }
    case 'WIPEOUT': {
      if (id[0] !== 'v') return move();
      // 경계 꼭짓점 하나를 옮긴 다각형으로 다시 만든다(틀은 새 범위에 맞춘다, 표시·밝기 값은 그대로)
      const poly = wipeoutPolygon(e);
      const i = Number(id.slice(1));
      if (!poly[i]) return { message: '그립이 없습니다.' };
      poly[i] = { x: to.x, y: to.y };
      const w = makeWipeout(e, poly, e.insert.z);
      if (!w) return { message: MSG.tooShort };
      return { replace: [{ ...w, handle: e.handle, displayFlags: e.displayFlags, brightness: e.brightness, contrast: e.contrast, fade: e.fade }] };
    }
    case 'IMAGE': {
      if (id[0] !== 'v') return move();
      // 구석: 맞은편 구석을 두고 대각선 방향으로 잰 비율만큼 축척(가로세로 비율 유지)
      const i = Number(id.slice(1));
      const opp = grips.find((q) => q.id === 'v' + ((i + 2) % 4))?.point;
      if (!opp) return { message: '그립이 없습니다.' };
      const diag = sub(gp.point, opp);
      const dd = dot(diag, diag);
      const k = dd > 0 ? dot(sub(to, opp), diag) / dd : 0;
      if (!(k > 1e-9)) return { message: MSG.tooShort };
      return transformEntity(e, affScale(k, k, opp), doc);
    }
    default:
      return move();
  }
}

// ---------------------------------------------------------------------------
// 호·타원
// ---------------------------------------------------------------------------

/** 세 점을 지나는 호(a → m → b), 한 직선 위면 null */
export function arc3(a: Vec2, m: Vec2, b: Vec2): { c: Vec2; r: number; a0: number; sw: number } | null {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  const scale = Math.max(1, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y), Math.abs(m.x), Math.abs(m.y));
  if (Math.abs(d) < 1e-12 * scale * scale) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const m2 = m.x * m.x + m.y * m.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c = { x: (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d, y: (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d };
  const r = dist(c, a);
  const a0 = angleOf(sub(a, c));
  const am = ccwFrom(a0, angleOf(sub(m, c)));
  const ab = ccwFrom(a0, angleOf(sub(b, c)));
  const sw = am < ab ? ab : -(TAU - ab);
  return { c, r, a0, sw };
}

function arcGrip(e: ArcEntity, id: string, to: Vec2, opts: GripOptions): EditResult {
  const path = entityPath(e)!;
  const pc = path.pieces[0]!;
  if (pc.k !== 'arc') return { message: MSG.cannotTransform };
  if (id === 'center') {
    const d = sub(to, pc.c);
    return { replace: [keepIdentity(e, makeArc(e, { ...pc, c: add(pc.c, d) }, path.z))] };
  }
  const P0 = pieceAt(pc, 0);
  const Pm = pieceAt(pc, 0.5);
  const P1 = pieceAt(pc, 1);
  if (id === 'mid' && opts.arcMid === 'radius') {
    const r = dist(pc.c, to);
    if (!(r > 0)) return { message: MSG.tooShort };
    return { replace: [keepIdentity(e, makeArc(e, { ...pc, r }, path.z))] };
  }
  const a = id === 'start' ? to : P0;
  const m = id === 'mid' ? to : Pm;
  const b = id === 'end' ? to : P1;
  const arc = arc3(a, m, b);
  if (!arc || dist(a, b) < 1e-12) return { message: MSG.tooShort };
  return { replace: [keepIdentity(e, makeArc(e, { k: 'arc', c: arc.c, r: arc.r, a0: arc.a0, sw: arc.sw }, path.z))] };
}

function ellipseGrip(e: EllipseEntity, id: string, to: Vec2): EditResult {
  const path = entityPath(e)!;
  const pc = path.pieces[0] as EllPiece;
  const r = cloneEntity(e);
  const a = Math.hypot(e.majorAxis.x, e.majorAxis.y, e.majorAxis.z);
  const b = a * e.ratio;
  const L = dist(pc.c, to);
  if (!(L > 0)) return { message: MSG.tooShort };
  const full = path.closed;
  if (id.startsWith('maj') || id.startsWith('min')) {
    const isMajor = id.startsWith('maj');
    const na = isMajor ? L : a;
    const nb = isMajor ? b : L;
    const ua = { x: e.majorAxis.x / a, y: e.majorAxis.y / a, z: e.majorAxis.z / a };
    if (nb <= na) {
      r.majorAxis = { x: ua.x * na, y: ua.y * na, z: ua.z * na };
      r.ratio = nb / na;
    } else {
      // 단축이 길어졌다: 단축 방향이 새 장축, 매개변수 −π/2
      const vdir = { x: pc.v.x, y: pc.v.y };
      const vl = Math.hypot(vdir.x, vdir.y) || 1;
      r.majorAxis = { x: (vdir.x / vl) * nb, y: (vdir.y / vl) * nb, z: 0 };
      r.ratio = na / nb;
      if (!full) {
        r.startParam = normAngle(e.startParam - Math.PI / 2);
        r.endParam = r.startParam + normAngle(e.endParam - e.startParam);
      }
    }
    return { replace: [r] };
  }
  // 호 끝: 중심 → 점 반직선과 타원의 교점(조각 매개변수 = 객체 매개변수)
  const q = sub(to, pc.c);
  const det = pc.u.x * pc.v.y - pc.u.y * pc.v.x;
  const cs = (q.x * pc.v.y - q.y * pc.v.x) / det;
  const sn = (pc.u.x * q.y - pc.u.y * q.x) / det;
  const th = normAngle(Math.atan2(sn, cs));
  const s0 = id === 'start' ? th : normAngle(e.startParam);
  const s1 = id === 'end' ? th : normAngle(e.endParam);
  const sw = normAngle(s1 - s0);
  if (sw < 1e-9) return { message: MSG.tooShort };
  r.startParam = s0;
  r.endParam = s0 + sw;
  return { replace: [r] };
}

// ---------------------------------------------------------------------------
// 폴리선
// ---------------------------------------------------------------------------

/** 세그먼트 중간 그립: 직선은 평행 이동, 호는 새 점을 지나는 볼록도 */
function segmentGrip(vs: { x: number; y: number; bulge: number }[], i: number, closed: boolean, toOcs: Vec2, dOcs: Vec2): void {
  const n = vs.length;
  const a = vs[i]!;
  const b = vs[(i + 1) % n]!;
  if (Math.abs(a.bulge) < 1e-12) {
    a.x += dOcs.x;
    a.y += dOcs.y;
    b.x += dOcs.x;
    b.y += dOcs.y;
    return;
  }
  const arc = arc3(a, toOcs, b);
  a.bulge = arc ? Math.tan(arc.sw / 4) : 0;
  void closed;
}

function lwGrip(e: LwPolylineEntity, id: string, to: Vec2): LwPolylineEntity {
  const P = planProj(e.extrusion, e.elevation);
  const inv = affInv(P)!;
  const q = affApply(inv, to);
  const r = cloneEntity(e);
  const i = Number(id.slice(1));
  const vs = lwVertices(e);
  if (id[0] === 'v') {
    vs[i]!.x = q.x;
    vs[i]!.y = q.y;
  } else {
    const gp = segMid(vs[i]!, vs[(i + 1) % vs.length]!, vs[i]!.bulge);
    segmentGrip(vs, i, e.closed, q, sub(q, gp));
  }
  setLwVertices(r, vs);
  return r;
}

function polylineGrip(e: PolylineEntity, id: string, to: Vec2): PolylineEntity {
  const r = cloneEntity(e);
  const i = Number(id.slice(1));
  if (e.kind !== '2d') {
    const v = r.vertices[i]!;
    v.location = { x: to.x, y: to.y, z: v.location.z };
    return r;
  }
  const P = planProj(e.extrusion, e.elevation);
  const q = affApply(affInv(P)!, to);
  if (id[0] === 'v') {
    r.vertices[i]!.location = { x: q.x, y: q.y, z: e.vertices[i]!.location.z };
    return r;
  }
  // 세그먼트 i → 다음 그려지는 정점
  const idx = e.vertices.map((v, k) => (v.flags & 16 ? -1 : k)).filter((k) => k >= 0);
  const pos = idx.indexOf(i);
  const j = idx[(pos + 1) % idx.length]!;
  const vs = [i, j].map((k) => ({ x: e.vertices[k]!.location.x, y: e.vertices[k]!.location.y, bulge: e.vertices[k]!.bulge }));
  const gp = segMid(vs[0]!, vs[1]!, vs[0]!.bulge);
  segmentGrip(vs, 0, false, q, sub(q, gp));
  r.vertices[i]!.location = { ...r.vertices[i]!.location, x: vs[0]!.x, y: vs[0]!.y };
  r.vertices[i]!.bulge = vs[0]!.bulge;
  r.vertices[j]!.location = { ...r.vertices[j]!.location, x: vs[1]!.x, y: vs[1]!.y };
  return r;
}

function splineGrip(e: SplineEntity, id: string, to: Vec2): SplineEntity {
  const r = cloneEntity(e);
  const i = Number(id.slice(1));
  if (id[0] === 'f') {
    r.fitPoints[i] = { x: to.x, y: to.y, z: e.fitPoints[i]!.z };
    if (e.controlPoints.length >= 2) {
      const s = interpolateFitPoints(r.fitPoints, r.startTangent, r.endTangent);
      r.degree = s.degree;
      r.knots = s.knots;
      r.controlPoints = s.ctrl;
      r.weights = undefined;
    }
    return r;
  }
  r.controlPoints[i] = { x: to.x, y: to.y, z: e.controlPoints[i]!.z };
  r.fitPoints = [];
  r.startTangent = undefined;
  r.endTangent = undefined;
  return r;
}

function hatchGrip(e: HatchEntity, id: string, d: Vec2): HatchEntity {
  const r = cloneEntity(e);
  const [k, i] = id.slice(1).split('.').map(Number) as [number, number];
  const p = r.paths[k];
  if (!p) return r;
  const P = planProj(e.extrusion, e.elevation);
  const dl = affLin(affInv(P)!, d);
  if (p.polyline) {
    const vs = numArray(p.polyline.verts);
    if (Number.isInteger(i) && i >= 0 && i < vertCount(vs)) {
      vs[i * 3] = vs[i * 3]! + dl.x;
      vs[i * 3 + 1] = vs[i * 3 + 1]! + dl.y;
    }
    p.polyline.verts = vs;
  } else if (p.edges) {
    const lines = p.edges.map((ed, j) => (ed.type === 'line' ? j : -1)).filter((j) => j >= 0);
    const j = lines[i];
    if (j !== undefined) {
      const ed = p.edges[j]!;
      if (ed.type === 'line') ed.start = { x: ed.start.x + dl.x, y: ed.start.y + dl.y };
      const prev = p.edges[(j - 1 + p.edges.length) % p.edges.length]!;
      if (prev.type === 'line') prev.end = { x: prev.end.x + dl.x, y: prev.end.y + dl.y };
    }
  }
  for (const pp of r.paths) pp.sources = undefined;
  r.associative = false;
  return r;
}

// ---------------------------------------------------------------------------
// 치수
// ---------------------------------------------------------------------------

/** 문자 그립: DIMTMOVE(재지정, 없으면 스타일)에 따라 옮긴다 — 0이면 치수선(호·지시선)도 문자를 따라간다 */
function dimTextFollow(e: DimensionEntity, d: Vec2, doc: CadDocument): DimensionEntity {
  const r = moveDimPoint(e, 'textMid', d);
  try {
    const t = moveDimensionText(doc, e, r.textMid);
    if (!Number.isFinite(t.measurement) && Number.isFinite(r.measurement)) t.measurement = r.measurement;
    return t;
  } catch {
    return r;
  }
}

function dimGrip(e: DimensionEntity, key: Parameters<typeof moveDimPoint>[1], d: Vec2, doc: CadDocument, opts: GripOptions): EditResult {
  const r = key === 'textMid' ? dimTextFollow(e, d, doc) : moveDimPoint(e, key, d);
  if (opts.regenDimension) {
    const nb = opts.regenDimension(r, doc);
    if (nb) {
      r.block = nb.name;
      return { replace: [r], blocks: [nb] };
    }
  }
  const b = e.block ? doc.blocks.get(tableKey(e.block)) : undefined;
  if (!b || !b.entities.length || key !== 'textMid' || !isNaturalExt(e.extrusion)) return { replace: [r] };
  // 문자 그립 근사: 블록의 문자만 옮긴다
  const M = affTranslate(d.x, d.y);
  const ents: Entity[] = b.entities.map((c) => {
    const x = c.type === 'MTEXT' || c.type === 'TEXT' ? (transformEntity(c, M, doc).replace?.[0] ?? cloneEntity(c)) : cloneEntity(c);
    return freshEntity(x);
  });
  updateDimNumber(doc, e, r, ents);
  const name = allocBlockName(doc, '*D');
  r.block = name;
  return { replace: [r], blocks: [{ ...b, name, handle: '', recordHandle: '', endHandle: undefined, flags: b.flags | 1, entities: ents }] };
}

