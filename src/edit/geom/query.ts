/**
 * 조회 도우미: 교점, 가장 가까운 점, 범위, 방향 바꾸기, 복사본 만들기.
 * 모두 WCS 평면도(XY) 기준이다.
 */
import type { CadDocument, Entity, PolyVertex, SplineEntity, Vec2, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { pathLoop } from '../../render/hatch';
import { type Piece, pathBox, pieceBox, pieceNearest } from './curve';
import { edgePieces } from './edges';
import { explodeEntity } from './explode';
import { intersectAll, intersectPieces } from './intersect';
import { type Affine, type Box, affApply, boxValid, dist, emptyBox, growBox } from './math';
import { cloneEntity, entityPath, freshEntity } from './path';
import { planProj } from './ocs';
import { transformEntity } from './transform';
import { type EditResult, MSG, type TransformOptions } from './types';
import { metrics, mtextDir, mtextLocalBox } from './xtext';

// ---------------------------------------------------------------------------
// 교점
// ---------------------------------------------------------------------------

/**
 * 두 객체의 평면도 교점(WCS). 곡선 객체는 정확히(선·호·원끼리는 해석적, 나머지는 꺾은선 + 뉴턴법),
 * 블록 참조·치수 등은 doc이 있으면 분해한 그림의 모서리로 찾는다. 같은 객체를 두 번 주면 자기 교점이다.
 */
export function intersections(a: Entity, b: Entity, doc?: CadDocument): Vec2[] {
  const A = edgePieces(a, doc);
  if (a === b) return selfIntersections(A, entityPath(a)?.closed ?? false);
  const B = edgePieces(b, doc);
  return intersectAll(A, B);
}

function selfIntersections(pcs: readonly Piece[], closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  const n = pcs.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const adj = j === i + 1 || (closed && i === 0 && j === n - 1);
      for (const h of intersectPieces(pcs[i]!, pcs[j]!)) {
        if (adj) {
          const shared = j === i + 1 ? h.t > 1 - 1e-9 && h.u < 1e-9 : h.t < 1e-9 && h.u > 1 - 1e-9;
          if (shared) continue;
        }
        if (!out.some((o) => dist(o, h.p) <= 1e-9 * Math.max(1, Math.abs(h.p.x), Math.abs(h.p.y)))) out.push(h.p);
      }
    }
  return out;
}

// ---------------------------------------------------------------------------
// 가장 가까운 점
// ---------------------------------------------------------------------------

/** 객체 위에서 p에 가장 가까운 점(평면도). 모서리가 없는 객체(문자·점·블록 참조)는 삽입점 */
export function nearestPointOn(e: Entity, p: Vec2, doc?: CadDocument): Vec2 | null {
  const pcs = edgePieces(e, doc);
  if (pcs.length) {
    let best: Vec2 | null = null;
    let bd = Infinity;
    for (const pc of pcs) {
      const r = pieceNearest(pc, p, true);
      if (r.d < bd) {
        bd = r.d;
        best = r.p;
      }
    }
    return best;
  }
  const ip = insertionPoint(e);
  return ip ? { x: ip.x, y: ip.y } : null;
}

/** 삽입점(WCS 평면도)이 있는 객체의 삽입점 */
export function insertionPoint(e: Entity): Vec2 | null {
  switch (e.type) {
    case 'POINT':
      return { x: e.position.x, y: e.position.y };
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF':
    case 'INSERT':
    case 'SHAPE': {
      const q = e.type !== 'INSERT' && e.type !== 'SHAPE' && (e.halign !== 0 || e.valign !== 0) && e.alignPoint && e.halign !== 3 && e.halign !== 5 ? e.alignPoint : e.insert;
      return affApply(planProj(e.extrusion, q.z), q);
    }
    case 'MTEXT':
    case 'TOLERANCE':
    case 'ACAD_TABLE':
    case 'IMAGE':
    case 'WIPEOUT':
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY':
      return { x: e.insert.x, y: e.insert.y };
    case 'DIMENSION':
      return { x: e.defPoint.x, y: e.defPoint.y };
    case 'VIEWPORT':
      return { x: e.center.x, y: e.center.y };
    case 'XLINE':
    case 'RAY':
      return { x: e.base.x, y: e.base.y };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 범위
// ---------------------------------------------------------------------------

/** 평면도 범위(WCS). 무한선은 기준점, 계산할 수 없으면 null */
export function entityBounds(e: Entity, doc: CadDocument, depth = 0): Box | null {
  const b = emptyBox();
  const path = entityPath(e);
  if (path) {
    if (e.type === 'XLINE' || e.type === 'RAY') growBox(b, e.base.x, e.base.y);
    else {
      const pb = pathBox(path);
      growBox(b, pb.minX, pb.minY);
      growBox(b, pb.maxX, pb.maxY);
    }
    return boxValid(b) ? b : null;
  }
  const union = (list: readonly Entity[]) => {
    for (const c of list) {
      const cb = entityBounds(c, doc, depth + 1);
      if (cb) {
        growBox(b, cb.minX, cb.minY);
        growBox(b, cb.maxX, cb.maxY);
      }
    }
  };
  const pieces = (pcs: readonly Piece[]) => {
    for (const pc of pcs) {
      const pb = pieceBox(pc);
      if (boxValid(pb)) {
        growBox(b, pb.minX, pb.minY);
        growBox(b, pb.maxX, pb.maxY);
      }
    }
  };
  switch (e.type) {
    case 'POINT':
      growBox(b, e.position.x, e.position.y);
      break;
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      const style = doc.textStyles.get(tableKey(e.style));
      const lay = metrics().layoutText({
        text: e.text || ('tag' in e ? (e as { tag: string }).tag : ''),
        insert: e.insert,
        alignPoint: e.alignPoint,
        height: e.height,
        rotation: e.rotation,
        widthFactor: e.widthFactor,
        oblique: e.oblique,
        generation: e.generation,
        halign: e.halign,
        valign: e.valign,
        style,
      });
      const P = planProj(e.extrusion, e.insert.z);
      if (Number.isFinite(lay.minX)) for (const [x, y] of corners(lay)) growQ(b, affApply(P, { x, y }));
      else growQ(b, affApply(P, e.insert));
      break;
    }
    case 'MTEXT': {
      const lb = mtextLocalBox(e, doc);
      const u = mtextDir(e);
      const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
      const v: Vec3 = { x: n.y * u.z - n.z * u.y, y: n.z * u.x - n.x * u.z, z: n.x * u.y - n.y * u.x };
      for (const [x, y] of corners(lb)) growBox(b, e.insert.x + u.x * x + v.x * y, e.insert.y + u.y * x + v.y * y);
      break;
    }
    case 'INSERT':
    case 'DIMENSION':
    case 'ACAD_TABLE':
    case 'MULTILEADER':
    case 'LEADER':
    case 'TOLERANCE':
    case 'MLINE': {
      if (depth > 8) break;
      const r = explodeEntity(e, doc);
      if (r.add?.length) union(r.add);
      else if (e.type === 'DIMENSION') for (const p of [e.defPoint, e.defPoint2, e.defPoint3, e.defPoint4, e.textMid]) growBox(b, p.x, p.y);
      else if (e.type === 'INSERT') growQ(b, insertionPoint(e)!);
      else pieces(edgePieces(e, doc));
      break;
    }
    case 'HATCH':
    case 'MPOLYGON': {
      const P = planProj(e.extrusion, e.elevation);
      for (const p of e.paths) {
        const ring = pathLoop(p, 1e-3);
        for (let i = 0; i + 1 < ring.length; i += 2) growQ(b, affApply(P, { x: ring[i]!, y: ring[i + 1]! }));
      }
      break;
    }
    case 'MESH':
      for (const p of e.vertices) growBox(b, p.x, p.y);
      break;
    case 'POLYLINE':
      for (const v of e.vertices) growBox(b, v.location.x, v.location.y);
      break;
    case 'SHAPE': {
      const P = planProj(e.extrusion, e.insert.z);
      const s = e.size || 1;
      for (const [x, y] of [
        [0, 0],
        [s * (e.widthFactor || 1), s],
      ] as const)
        growQ(b, affApply(P, { x: e.insert.x + x * Math.cos(e.rotation) - y * Math.sin(e.rotation), y: e.insert.y + x * Math.sin(e.rotation) + y * Math.cos(e.rotation) }));
      break;
    }
    case 'OLE2FRAME':
    case 'OLEFRAME':
      growBox(b, e.upperLeft.x, e.upperLeft.y);
      growBox(b, e.lowerRight.x, e.lowerRight.y);
      break;
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY': {
      const c = Math.cos(e.rotation);
      const s = Math.sin(e.rotation);
      const P = planProj(e.extrusion, e.insert.z);
      const pts = e.clipBoundary.length ? e.clipBoundary : [{ x: 0, y: 0 }];
      for (const q of pts) {
        const x = q.x * e.scale.x;
        const y = q.y * e.scale.y;
        growQ(b, affApply(P, { x: e.insert.x + c * x - s * y, y: e.insert.y + s * x + c * y }));
      }
      break;
    }
    default:
      pieces(edgePieces(e, doc));
  }
  return boxValid(b) ? b : null;
}

function corners(l: { minX: number; minY: number; maxX: number; maxY: number }): [number, number][] {
  return [
    [l.minX, l.minY],
    [l.maxX, l.minY],
    [l.maxX, l.maxY],
    [l.minX, l.maxY],
  ];
}

function growQ(b: Box, q: Vec2): void {
  growBox(b, q.x, q.y);
}

/** 여러 객체의 범위 */
export function boundsOf(list: readonly Entity[], doc: CadDocument): Box | null {
  const b = emptyBox();
  for (const e of list) {
    const r = entityBounds(e, doc);
    if (r) {
      growBox(b, r.minX, r.minY);
      growBox(b, r.maxX, r.maxY);
    }
  }
  return boxValid(b) ? b : null;
}

// ---------------------------------------------------------------------------
// 방향 바꾸기(REVERSE)
// ---------------------------------------------------------------------------

/** LINE·LWPOLYLINE·2D/3D POLYLINE·SPLINE(나선 포함)의 방향을 바꾼다(모양은 같다) */
export function reverseEntity(e: Entity): EditResult {
  switch (e.type) {
    case 'LINE': {
      const r = cloneEntity(e);
      r.start = { ...e.end };
      r.end = { ...e.start };
      return { replace: [r] };
    }
    case 'LWPOLYLINE': {
      const r = cloneEntity(e);
      r.vertices = reverseBulged(e.vertices, e.closed);
      return { replace: [r] };
    }
    case 'POLYLINE': {
      if (e.kind !== '2d' && e.kind !== '3d') return { message: MSG.cannotReverse };
      const r = cloneEntity(e);
      const frame = e.vertices.filter((v) => v.flags & 16);
      const drawn = e.vertices.filter((v) => !(v.flags & 16));
      const rev = reverseBulged(
        drawn.map((v) => ({ x: v.location.x, y: v.location.y, bulge: v.bulge, startWidth: v.startWidth, endWidth: v.endWidth })),
        (e.flags & 1) !== 0,
      );
      const order = reverseOrder(drawn.length, (e.flags & 1) !== 0);
      r.vertices = [
        ...order.map((k, i): PolyVertex => {
          const v = drawn[k]!;
          const nv: PolyVertex = { ...v, location: { ...v.location }, bulge: rev[i]!.bulge, startWidth: rev[i]!.startWidth, endWidth: rev[i]!.endWidth };
          if (v.tangent !== undefined) nv.tangent = (v.tangent + Math.PI) % (Math.PI * 2);
          return nv;
        }),
        ...frame.reverse().map((v) => ({ ...v, location: { ...v.location } })),
      ];
      return { replace: [r] };
    }
    case 'SPLINE':
      return { replace: [reverseSpline(e)] };
    default:
      return { message: MSG.cannotReverse };
  }
}

/** 정점 순서(닫힌 폴리선은 첫 정점을 그대로 두고 나머지를 거꾸로 — AutoCAD REVERSE와 같다) */
function reverseOrder(n: number, closed: boolean): number[] {
  const out: number[] = [];
  if (closed) {
    out.push(0);
    for (let i = n - 1; i >= 1; i--) out.push(i);
  } else for (let i = n - 1; i >= 0; i--) out.push(i);
  return out;
}

/** 볼록도·폭 정점 뒤집기: 세그먼트 i(i → i+1)의 볼록도는 부호를 바꿔 뒤집힌 세그먼트에 */
export function reverseBulged<T extends { x: number; y: number; bulge: number; startWidth: number; endWidth: number }>(vs: readonly T[], closed: boolean): T[] {
  const n = vs.length;
  const order = reverseOrder(n, closed);
  return order.map((k, i) => {
    // 새 정점 i → i+1 세그먼트 = 원래 (order[i+1]) → k 세그먼트
    const next = i + 1 < n ? order[i + 1]! : closed ? order[0]! : -1;
    const v = vs[k]!;
    if (next < 0) return { ...v, bulge: 0, startWidth: 0, endWidth: 0 };
    const seg = vs[next]!; // 원래 세그먼트의 시작 정점
    return { ...v, bulge: -seg.bulge, startWidth: seg.endWidth, endWidth: seg.startWidth };
  });
}

export function reverseSpline(e: SplineEntity): SplineEntity {
  const r = cloneEntity(e);
  r.controlPoints = [...e.controlPoints].reverse().map((q) => ({ ...q }));
  if (e.weights) r.weights = [...e.weights].reverse();
  if (e.knots.length) {
    const a = e.knots[0]!;
    const b = e.knots[e.knots.length - 1]!;
    r.knots = e.knots.map((_, i) => a + b - e.knots[e.knots.length - 1 - i]!);
  }
  r.fitPoints = [...e.fitPoints].reverse().map((q) => ({ ...q }));
  r.startTangent = e.endTangent ? { x: -e.endTangent.x, y: -e.endTangent.y, z: -e.endTangent.z } : undefined;
  r.endTangent = e.startTangent ? { x: -e.startTangent.x, y: -e.startTangent.y, z: -e.startTangent.z } : undefined;
  if (e.helix) r.helix = { ...e.helix, ccw: !e.helix.ccw };
  return r;
}

// ---------------------------------------------------------------------------
// 복사본(COPY·ARRAY)
// ---------------------------------------------------------------------------

/** 변환한 새 복사본(핸들 '' — 속성 핸들도 비운다). 원본은 그대로 둔다 */
export function copyEntity(e: Entity, m: Affine, doc: CadDocument, opts: TransformOptions = {}): EditResult {
  const r = transformEntity(e, m, doc, opts);
  const add: Entity[] = [];
  for (const x of [...(r.replace ?? []), ...(r.add ?? [])]) {
    add.push(freshEntity(x === e ? cloneEntity(e) : x));
  }
  const out: EditResult = {};
  if (add.length) out.add = add;
  if (r.blocks?.length) out.blocks = r.blocks;
  if (r.message) out.message = r.message;
  return out;
}

