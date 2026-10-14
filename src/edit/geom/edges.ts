/**
 * 절단·경계 모서리: 어떤 객체든 평면도 조각 목록으로(블록 참조·치수는 분해한 그림, 지시선·여러 줄·면은 선분).
 * EDGEMODE = 1이면 모서리를 자연스럽게 연장한다(선 → 무한선, 호 → 원, 타원호 → 타원, 열린 폴리선 → 끝 세그먼트의 연장).
 */
import type { BlockDef, CadDocument, Entity, Vec2 } from '../../core/model';
import { tableKey } from '../../core/model';
import { type ArcPiece, type EllPiece, type LinePiece, type Piece, pathBox, pieceAt, pieceBox, pieceTangent } from './curve';
import { type Affine, type Box, TAU, add, affApply, affMul, affRotate, affScale, affTranslate, boxValid, emptyBox, growBox, sub } from './math';
import { entityPath } from './path';
import { planProj } from './ocs';
import { explodeEntity } from './explode';

function segs(points: Vec2[], closed: boolean): LinePiece[] {
  const out: LinePiece[] = [];
  const n = points.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 0) out.push({ k: 'line', a, b });
  }
  return out;
}

/** 객체의 모서리 조각(평면도 WCS) */
export function edgePieces(e: Entity, doc?: CadDocument, depth = 0): Piece[] {
  const path = entityPath(e);
  if (path) return path.pieces.map((p) => ({ ...p }));
  switch (e.type) {
    case 'INSERT':
    case 'DIMENSION':
    case 'ACAD_TABLE':
    case 'MULTILEADER': {
      if (!doc || depth > 4) return [];
      const r = explodeEntity(e, doc);
      const out: Piece[] = [];
      for (const c of r.add ?? []) if (c.type !== 'TEXT' && c.type !== 'MTEXT' && c.type !== 'ATTDEF' && c.type !== 'POINT') out.push(...edgePieces(c, doc, depth + 1));
      return out;
    }
    case 'LEADER':
      return segs(
        e.vertices.map((v) => ({ x: v.x, y: v.y })),
        false,
      );
    case 'MLINE': {
      const out: Piece[] = [];
      const nEl = e.elementCount || e.vertices[0]?.elements.length || 0;
      for (let k = 0; k < nEl; k++) {
        const pts = e.vertices.map((v) => {
          const d = v.elements[k]?.params[0] ?? 0;
          return { x: v.position.x + v.miter.x * d, y: v.position.y + v.miter.y * d };
        });
        out.push(...segs(pts, (e.flags & 2) !== 0));
      }
      return out;
    }
    case 'SOLID':
    case 'TRACE': {
      const P = planProj(e.extrusion, e.points[0].z);
      const q = e.points.map((p) => affApply(P, p));
      return segs([q[0]!, q[1]!, q[3]!, q[2]!], true);
    }
    case '3DFACE':
      return segs(
        e.points.map((p) => ({ x: p.x, y: p.y })),
        true,
      );
    case 'IMAGE':
    case 'WIPEOUT': {
      let bnd = e.clipBoundary.map((p) => ({ x: p.x, y: p.y }));
      if (!e.clipping || bnd.length < 2)
        bnd = [
          { x: -0.5, y: -0.5 },
          { x: e.imageSize.x - 0.5, y: -0.5 },
          { x: e.imageSize.x - 0.5, y: e.imageSize.y - 0.5 },
          { x: -0.5, y: e.imageSize.y - 0.5 },
        ];
      else if (bnd.length === 2) {
        const [a, b] = bnd as [Vec2, Vec2];
        bnd = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      }
      const u = e.uVector;
      const v = e.vVector;
      const w = bnd.map((p) => ({ x: e.insert.x + u.x * (p.x + 0.5) + v.x * (p.y + 0.5), y: e.insert.y + u.y * (p.x + 0.5) + v.y * (p.y + 0.5) }));
      return segs(w, true);
    }
    case 'VIEWPORT': {
      const c = e.center;
      const w = e.width / 2;
      const h = e.height / 2;
      return segs(
        [
          { x: c.x - w, y: c.y - h },
          { x: c.x + w, y: c.y - h },
          { x: c.x + w, y: c.y + h },
          { x: c.x - w, y: c.y + h },
        ],
        true,
      );
    }
    case 'REGION':
    case '3DSOLID':
    case 'BODY': {
      const out: Piece[] = [];
      for (const w of e.wires ?? []) out.push(...segs(w.map((p) => ({ x: p.x, y: p.y })), false));
      return out;
    }
    default:
      return [];
  }
}

/** 조각의 나머지(호 → 원의 나머지, 타원호 → 타원의 나머지) */
export function complement(p: ArcPiece | EllPiece): Piece {
  if (p.k === 'arc') {
    const sg = p.sw >= 0 ? 1 : -1;
    return { k: 'arc', c: p.c, r: p.r, a0: p.a0 + p.sw, sw: sg * (TAU - Math.abs(p.sw)) };
  }
  const sg = p.dt >= 0 ? 1 : -1;
  return { k: 'ell', c: p.c, u: p.u, v: p.v, t0: p.t0 + p.dt, dt: sg * (TAU - Math.abs(p.dt)) };
}

/** 모서리 목록(연장 포함) */
export function edgeSet(e: Entity, doc: CadDocument | undefined, extend: boolean): Piece[] {
  const base = edgePieces(e, doc);
  if (!extend) return base;
  const path = entityPath(e);
  if (!path || path.closed || !path.pieces.length) return base;
  const out = [...base];
  const first = path.pieces[0]!;
  const last = path.pieces[path.pieces.length - 1]!;
  const extendEnd = (p: Piece, atStart: boolean) => {
    if (p.k === 'line') {
      if (p.inf0 || p.inf1) return;
      const pt = atStart ? p.a : p.b;
      const d = sub(p.b, p.a);
      const dir = atStart ? { x: -d.x, y: -d.y } : d;
      out.push({ k: 'line', a: pt, b: add(pt, dir), inf1: true });
    } else if (p.k === 'arc' || p.k === 'ell') {
      out.push(complement(p));
    } else {
      // 스플라인: 끝 접선 방향 반직선
      const t = atStart ? 0 : 1;
      const pt = pieceAt(p, t);
      const tg = pieceTangent(p, t);
      const dir = atStart ? { x: -tg.x, y: -tg.y } : tg;
      out.push({ k: 'line', a: pt, b: add(pt, dir), inf1: true });
    }
  };
  if (path.pieces.length === 1 && (first.k === 'arc' || first.k === 'ell')) {
    out.push(complement(first));
    return out;
  }
  extendEnd(first, true);
  extendEnd(last, false);
  return out;
}

// ---------------------------------------------------------------------------
// 모서리 범위(절단 모서리 미리 거르기)
// ---------------------------------------------------------------------------

const blockBoxCache = new WeakMap<BlockDef, { ents: Entity[]; box: Box | null }>();

/** 블록 정의 모서리의 범위(블록 좌표). 블록 정의마다 기억하고, 내용 객체가 하나라도 바뀌면 다시 구한다 */
function blockEdgeBox(b: BlockDef, doc: CadDocument, depth: number): Box | null {
  const c = blockBoxCache.get(b);
  if (c && c.ents.length === b.entities.length && c.ents.every((x, i) => x === b.entities[i])) return c.box;
  const box = emptyBox();
  for (const e of b.entities) {
    const eb = edgeBox(e, doc, depth + 1);
    if (eb === 'inf' || !eb) continue;
    growBox(box, eb.minX, eb.minY);
    growBox(box, eb.maxX, eb.maxY);
  }
  const out = boxValid(box) ? box : null;
  blockBoxCache.set(b, { ents: [...b.entities], box: out });
  return out;
}

function mapBox(b: Box, mats: Affine[]): Box {
  const out = emptyBox();
  for (const m of mats)
    for (const [x, y] of [
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.maxX, b.maxY],
      [b.minX, b.maxY],
    ] as const) {
      const q = affApply(m, { x, y });
      growBox(out, q.x, q.y);
    }
  return out;
}

/** 객체 모서리의 평면도 범위(무한선은 'inf', 모서리가 없으면 null). 정확한 모서리를 만들기 전에 거르는 데 쓴다 */
export function edgeBox(e: Entity, doc?: CadDocument, depth = 0): Box | 'inf' | null {
  const path = entityPath(e);
  if (path) {
    if (e.type === 'XLINE' || e.type === 'RAY') return 'inf';
    return pathBox(path);
  }
  if (doc && depth <= 4 && (e.type === 'INSERT' || e.type === 'DIMENSION')) {
    const b = doc.blocks.get(tableKey(e.block));
    if (!b) return null;
    const bb = blockEdgeBox(b, doc, depth);
    if (!bb) return null;
    if (e.type === 'DIMENSION') {
      let A: Affine = planProj(e.extrusion, 0);
      const ip = e.insertPoint;
      if (ip && (ip.x || ip.y)) A = affMul(affTranslate(ip.x, ip.y), A);
      return mapBox(bb, [A]);
    }
    const P = planProj(e.extrusion, e.insert.z);
    const rows = Math.max(1, e.rowCount);
    const cols = Math.max(1, e.columnCount);
    const mats: Affine[] = [];
    for (const r of rows > 1 ? [0, rows - 1] : [0])
      for (const c of cols > 1 ? [0, cols - 1] : [0])
        mats.push(
          affMul(
            P,
            affMul(
              affTranslate(e.insert.x, e.insert.y),
              affMul(affRotate(e.rotation), affMul(affTranslate(c * e.columnSpacing, r * e.rowSpacing), affMul(affScale(e.scale.x || 1, e.scale.y || 1), affTranslate(-b.basePoint.x, -b.basePoint.y)))),
            ),
          ),
        );
    return mapBox(bb, mats);
  }
  const box = emptyBox();
  for (const pc of edgePieces(e, doc, depth)) {
    if (pc.k === 'line' && (pc.inf0 || pc.inf1)) return 'inf';
    const pb = pieceBox(pc);
    growBox(box, pb.minX, pb.minY);
    growBox(box, pb.maxX, pb.maxY);
  }
  return boxValid(box) ? box : null;
}

export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return a.minX <= b.maxX + pad && b.minX <= a.maxX + pad && a.minY <= b.maxY + pad && b.minY <= a.maxY + pad;
}
