/** 객체 스냅: 끝점·중간점·중심·사분점·교차점·근처점·삽입점·노드·수직 */
import type { CadDocument, Entity } from '../core/model';
import { tableKey } from '../core/model';
import { type Mat, applyXY, identity, multiply, rotationZ, scaling, translation, withOcs } from '../geom/matrix';
import { bulgeArc, ccwSweep, interpolateFitPoints, nurbsPoints } from '../geom/curves';
import type { Picker } from './pick';
import type { Pt, SnapKind } from './view';

export interface SnapPoint {
  x: number;
  y: number;
  kind: SnapKind;
  /** 스냅 점을 준 객체(교차점·근처점처럼 선분에서 구한 것은 없음) */
  handle?: string;
  handle2?: string;
}

export const ALL_SNAPS: SnapKind[] = ['end', 'mid', 'cen', 'qua', 'int', 'ins', 'nod', 'per', 'nea'];
export const SNAP_NAMES: Record<string, string> = {
  end: '끝점',
  mid: '중간점',
  cen: '중심',
  qua: '사분점',
  int: '교차점',
  ins: '삽입',
  nod: '노드',
  per: '수직',
  nea: '근처점',
  tan: '접점',
  ext: '연장선',
  gcen: '기하학적 중심',
  app: '가상 교차점',
};

/** 기본 켜진 스냅(AutoCAD 기본 OSMODE 4133 = 끝점·중심·교차점·연장선과 비슷하게) */
export const DEFAULT_SNAPS: SnapKind[] = ['end', 'mid', 'cen', 'qua', 'int', 'ins', 'nod'];

function arcSnaps(m: Mat, cx: number, cy: number, z: number, r: number, a0: number, sweep: number, full: boolean, out: SnapPoint[]): void {
  const P = (a: number) => applyXY(m, cx + r * Math.cos(a), cy + r * Math.sin(a), z);
  const c = applyXY(m, cx, cy, z);
  out.push({ ...c, kind: 'cen' });
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    if (full || ccwSweep(a0, a) <= sweep + 1e-9) out.push({ ...P(a), kind: 'qua' });
  }
  if (!full) {
    out.push({ ...P(a0), kind: 'end' }, { ...P(a0 + sweep), kind: 'end' }, { ...P(a0 + sweep / 2), kind: 'mid' });
  }
}

function polySnaps(m: Mat, vs: { x: number; y: number; bulge: number }[], closed: boolean, z: number, out: SnapPoint[]): void {
  const n = vs.length;
  for (const v of vs) out.push({ ...applyXY(m, v.x, v.y, z), kind: 'end' });
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
    if (arc) {
      const am = arc.a0 + arc.sweep / 2;
      out.push({ ...applyXY(m, arc.cx + arc.r * Math.cos(am), arc.cy + arc.r * Math.sin(am), z), kind: 'mid' });
      out.push({ ...applyXY(m, arc.cx, arc.cy, z), kind: 'cen' });
    } else out.push({ ...applyXY(m, (a.x + b.x) / 2, (a.y + b.y) / 2, z), kind: 'mid' });
  }
}

/** 객체의 정의 스냅점(월드 좌표). 블록 참조는 안쪽 객체까지(깊이 제한) */
export function entitySnaps(doc: CadDocument, e: Entity, m: Mat, out: SnapPoint[], depth = 0): void {
  switch (e.type) {
    case 'LINE': {
      const a = applyXY(m, e.start.x, e.start.y, e.start.z);
      const b = applyXY(m, e.end.x, e.end.y, e.end.z);
      out.push({ ...a, kind: 'end' }, { ...b, kind: 'end' }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, kind: 'mid' });
      return;
    }
    case 'CIRCLE':
      arcSnaps(withOcs(m, e.extrusion), e.center.x, e.center.y, e.center.z, e.radius, 0, Math.PI * 2, true, out);
      return;
    case 'ARC':
      arcSnaps(withOcs(m, e.extrusion), e.center.x, e.center.y, e.center.z, e.radius, e.startAngle, ccwSweep(e.startAngle, e.endAngle), false, out);
      return;
    case 'ELLIPSE': {
      const n = e.extrusion ?? { x: 0, y: 0, z: 1 };
      const M = e.majorAxis;
      const mn = { x: (n.y * M.z - n.z * M.y) * e.ratio, y: (n.z * M.x - n.x * M.z) * e.ratio, z: (n.x * M.y - n.y * M.x) * e.ratio };
      const P = (t: number) => applyXY(m, e.center.x + M.x * Math.cos(t) + mn.x * Math.sin(t), e.center.y + M.y * Math.cos(t) + mn.y * Math.sin(t), e.center.z + M.z * Math.cos(t) + mn.z * Math.sin(t));
      out.push({ ...applyXY(m, e.center.x, e.center.y, e.center.z), kind: 'cen' });
      const full = Math.abs(e.endParam - e.startParam - Math.PI * 2) < 1e-9 || Math.abs(e.endParam - e.startParam) < 1e-12;
      const sweep = full ? Math.PI * 2 : ccwSweep(e.startParam, e.endParam);
      for (let k = 0; k < 4; k++) {
        const t = (k * Math.PI) / 2;
        if (full || ccwSweep(e.startParam, t) <= sweep + 1e-9) out.push({ ...P(t), kind: 'qua' });
      }
      if (!full) out.push({ ...P(e.startParam), kind: 'end' }, { ...P(e.startParam + sweep), kind: 'end' }, { ...P(e.startParam + sweep / 2), kind: 'mid' });
      return;
    }
    case 'LWPOLYLINE':
      polySnaps(withOcs(m, e.extrusion), e.vertices, e.closed, e.elevation, out);
      return;
    case 'POLYLINE': {
      const vs = e.vertices.filter((v) => !(v.flags & 16) && !(v.faceIndices && !(v.flags & 64)));
      if (e.kind === '2d') polySnaps(withOcs(m, e.extrusion), vs.map((v) => ({ x: v.location.x, y: v.location.y, bulge: e.flags & 2 ? 0 : v.bulge })), (e.flags & 1) !== 0, e.elevation, out);
      else for (const v of vs) out.push({ ...applyXY(m, v.location.x, v.location.y, v.location.z), kind: 'end' });
      return;
    }
    case 'SPLINE': {
      let pts: number[];
      if (e.controlPoints.length >= 2) pts = nurbsPoints(e.degree, e.knots, e.controlPoints, e.weights, 1e9);
      else if (e.fitPoints.length >= 2) {
        const s = interpolateFitPoints(e.fitPoints);
        pts = nurbsPoints(s.degree, s.knots, s.ctrl, undefined, 1e9);
      } else return;
      if (!(e.flags & 1)) {
        out.push({ ...applyXY(m, pts[0]!, pts[1]!, pts[2]!), kind: 'end' });
        out.push({ ...applyXY(m, pts[pts.length - 3]!, pts[pts.length - 2]!, pts[pts.length - 1]!), kind: 'end' });
      }
      for (const f of e.fitPoints) out.push({ ...applyXY(m, f.x, f.y, f.z), kind: 'nod' });
      return;
    }
    case 'POINT':
      out.push({ ...applyXY(m, e.position.x, e.position.y, e.position.z), kind: 'nod' });
      return;
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      const p = e.alignPoint && (e.halign !== 0 || e.valign !== 0) && e.halign !== 3 && e.halign !== 5 ? e.alignPoint : e.insert;
      out.push({ ...applyXY(withOcs(m, e.extrusion), p.x, p.y, p.z), kind: 'ins' });
      return;
    }
    case 'MTEXT':
      out.push({ ...applyXY(m, e.insert.x, e.insert.y, e.insert.z), kind: 'ins' });
      return;
    case 'INSERT': {
      const om = withOcs(m, e.extrusion);
      out.push({ ...applyXY(om, e.insert.x, e.insert.y, e.insert.z), kind: 'ins' });
      for (const a of e.attribs) entitySnaps(doc, a, m, out, depth + 1);
      if (depth >= 3) return;
      const b = doc.blocks.get(tableKey(e.block));
      if (!b || b.entities.length > 400) return;
      const local = multiply(translation(e.insert.x, e.insert.y, e.insert.z), multiply(rotationZ(e.rotation), scaling(e.scale.x || 1, e.scale.y || 1, e.scale.z || 1)));
      const bm = multiply(om, multiply(local, translation(-b.basePoint.x, -b.basePoint.y, -b.basePoint.z)));
      for (const c of b.entities) if (c.type !== 'ATTDEF') entitySnaps(doc, c, bm, out, depth + 1);
      return;
    }
    case 'DIMENSION':
      for (const p of [e.defPoint, e.defPoint2, e.defPoint3, e.defPoint4]) if (p.x || p.y || p.z) out.push({ ...applyXY(m, p.x, p.y, p.z), kind: 'nod' });
      return;
    case 'SOLID':
    case 'TRACE': {
      const om = withOcs(m, e.extrusion);
      for (const p of e.points) out.push({ ...applyXY(om, p.x, p.y, p.z), kind: 'end' });
      return;
    }
    case '3DFACE':
      for (const p of e.points) out.push({ ...applyXY(m, p.x, p.y, p.z), kind: 'end' });
      return;
    case 'LEADER':
      for (const p of e.vertices) out.push({ ...applyXY(m, p.x, p.y, p.z), kind: 'end' });
      return;
    case 'MULTILEADER':
      for (const l of e.context.leaders) {
        for (const ln of l.lines) for (const p of ln.vertices) out.push({ ...applyXY(m, p.x, p.y, p.z), kind: 'end' });
        if (l.lastLeaderPoint) out.push({ ...applyXY(m, l.lastLeaderPoint.x, l.lastLeaderPoint.y, l.lastLeaderPoint.z), kind: 'end' });
      }
      return;
    case 'VIEWPORT': {
      const c = e.center;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const)
        out.push({ ...applyXY(m, c.x + (sx * e.width) / 2, c.y + (sy * e.height) / 2, c.z), kind: 'end' });
      return;
    }
    default:
      return;
  }
}

const PRIORITY: Record<string, number> = { end: 0, int: 0, cen: 1, mid: 1, qua: 1, ins: 1, nod: 1, per: 2, tan: 2, nea: 5 };

function segInter(a: number[], i: number, j: number): Pt | null {
  const x1 = a[i]!;
  const y1 = a[i + 1]!;
  const x2 = a[i + 2]!;
  const y2 = a[i + 3]!;
  const x3 = a[j]!;
  const y3 = a[j + 1]!;
  const x4 = a[j + 2]!;
  const y4 = a[j + 3]!;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-18) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/** 커서 근처의 스냅점 */
export function findSnap(doc: CadDocument, picker: Picker, p: Pt, aperture: number, modes: ReadonlySet<SnapKind>, base?: Pt | null): SnapPoint | null {
  if (!modes.size) return null;
  const cands = picker.candidates(p.x, p.y, aperture);
  let best: SnapPoint | null = null;
  let bestScore = Infinity;
  const consider = (s: SnapPoint) => {
    if (!modes.has(s.kind)) return;
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d > aperture) return;
    const score = d / aperture + (PRIORITY[s.kind] ?? 1) * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  };
  const m = identity();
  for (const c of cands.slice(0, 200)) {
    const e = picker.entity(c.handle);
    if (!e) continue;
    const pts: SnapPoint[] = [];
    entitySnaps(doc, e, m, pts);
    for (const s of pts) consider({ ...s, handle: c.handle });
  }
  const needSegs = modes.has('int') || modes.has('nea') || (modes.has('per') && base);
  if (needSegs) {
    const segs = picker.segmentsNear(p.x, p.y, aperture, 800);
    const n = segs.length / 4;
    if (modes.has('int') && n > 1) {
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const q = segInter(segs, i * 4, j * 4);
          if (!q) continue;
          // 같은 꺾은선의 이어진 꼭짓점은 교차점이 아니다
          const shared =
            (Math.abs(q.x - segs[i * 4]!) < 1e-12 && Math.abs(q.y - segs[i * 4 + 1]!) < 1e-12) ||
            (Math.abs(q.x - segs[i * 4 + 2]!) < 1e-12 && Math.abs(q.y - segs[i * 4 + 3]!) < 1e-12);
          const shared2 =
            (Math.abs(q.x - segs[j * 4]!) < 1e-12 && Math.abs(q.y - segs[j * 4 + 1]!) < 1e-12) ||
            (Math.abs(q.x - segs[j * 4 + 2]!) < 1e-12 && Math.abs(q.y - segs[j * 4 + 3]!) < 1e-12);
          if (shared && shared2) continue;
          consider({ ...q, kind: 'int' });
        }
    }
    if (modes.has('per') && base) {
      for (let i = 0; i < n; i++) {
        const x0 = segs[i * 4]!;
        const y0 = segs[i * 4 + 1]!;
        const x1 = segs[i * 4 + 2]!;
        const y1 = segs[i * 4 + 3]!;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const l2 = dx * dx + dy * dy;
        if (l2 < 1e-24) continue;
        const t = ((base.x - x0) * dx + (base.y - y0) * dy) / l2;
        if (t < 0 || t > 1) continue;
        consider({ x: x0 + dx * t, y: y0 + dy * t, kind: 'per' });
      }
    }
    if (modes.has('nea') && !best) {
      for (let i = 0; i < n; i++) {
        const x0 = segs[i * 4]!;
        const y0 = segs[i * 4 + 1]!;
        const x1 = segs[i * 4 + 2]!;
        const y1 = segs[i * 4 + 3]!;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / l2)) : 0;
        consider({ x: x0 + dx * t, y: y0 + dy * t, kind: 'nea' });
      }
    }
  }
  return best;
}
