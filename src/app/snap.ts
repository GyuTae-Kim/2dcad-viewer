/**
 * 객체 스냅: 끝점·중간점·중심·기하학적 중심·노드·사분점·교차점·연장선·삽입·수직·접점·근처점·가상 교차점·평행.
 * 연장선(EXT)·평행(PAR)은 커서를 끝점·선분 위에 잠시 머물러 얻은 획득점(SnapContext, 앱이 모은다)을 쓴다.
 * 중심·기하학적 중심은 원·호·닫힌 폴리선의 테두리 위에 커서를 두어도 잡힌다(AutoCAD와 같다).
 */
import type { CadDocument, Entity } from '../core/model';
import { tableKey } from '../core/model';
import { type Mat, applyXY, identity, multiply, rotationZ, scaling, translation, withOcs } from '../geom/matrix';
import { bulgeArc, ccwSweep, interpolateFitPoints, nurbsPoints } from '../geom/curves';
import type { Picker } from './pick';
import type { Pt, SnapKind } from './view';
import { lwVertices } from '../core/lwpoly';

export interface SnapPoint {
  x: number;
  y: number;
  kind: SnapKind;
  /** 스냅 점을 준 객체(교차점·근처점처럼 선분에서 구한 것은 없음) */
  handle?: string;
  handle2?: string;
  /** 연장선·평행 스냅의 정렬선(점선으로 보인다): 시작점과 단위 방향 */
  lines?: { from: Pt; dir: Pt }[];
}

/** 제도 설정 대화상자의 순서(AutoCAD 2026) */
export const ALL_SNAPS: SnapKind[] = ['end', 'mid', 'cen', 'gcen', 'nod', 'qua', 'int', 'ext', 'ins', 'per', 'tan', 'nea', 'app', 'par'];
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
  par: '평행',
};

/** 기본 켜진 스냅: AutoCAD 기본 OSMODE 4133 = 끝점(1)·중심(4)·교차점(32)·연장선(4096) */
export const DEFAULT_SNAPS: SnapKind[] = ['end', 'cen', 'int', 'ext'];

/** 연장선 획득점: 선분 끝(바깥 방향) 또는 호 끝(호가 놓인 원과 호 범위) */
export interface ExtAnchor {
  p: Pt;
  /** 선분 끝: 끝점에서 바깥으로 나가는 단위 방향 */
  dir?: Pt;
  /** 호 끝: 도면 좌표의 반시계 호(중심·반지름·시작 각·사잇각) */
  arc?: { cx: number; cy: number; r: number; a0: number; sweep: number };
}

/** 스냅이 쓰는 추적 상태(앱이 모아 넘긴다) */
export interface SnapContext {
  /** 연장선 획득점 */
  ext?: readonly ExtAnchor[];
  /** 평행: 획득한 선분 방향(단위 벡터) */
  par?: readonly Pt[];
}

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
      polySnaps(withOcs(m, e.extrusion), lwVertices(e), e.closed, e.elevation, out);
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


const PRIORITY: Record<string, number> = { end: 0, int: 0, cen: 1, mid: 1, qua: 1, ins: 1, nod: 1, gcen: 1, per: 2, tan: 2, app: 2, ext: 3, par: 3, nea: 5 };

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

/** 두 선분을 무한히 늘린 직선의 교점(가상 교차점). 나란하면 null */
export function lineInter(a: number[], i: number, j: number): Pt | null {
  const x1 = a[i]!;
  const y1 = a[i + 1]!;
  const x2 = a[i + 2]!;
  const y2 = a[i + 3]!;
  const x3 = a[j]!;
  const y3 = a[j + 1]!;
  const x4 = a[j + 2]!;
  const y4 = a[j + 3]!;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  const l = Math.hypot(x2 - x1, y2 - y1) * Math.hypot(x4 - x3, y4 - y3);
  if (l < 1e-24 || Math.abs(d) < 1e-9 * l) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/** 2×2 부분이 뒤집힌(대칭) 변환인지 */
function mirrored(m: Mat): boolean {
  return m[0]! * m[5]! - m[1]! * m[4]! < 0;
}

/** 객체 좌표의 반시계 호를 도면 좌표의 반시계 호로(OCS가 뒤집혀 있으면 방향이 바뀐다) */
function worldArc(m: Mat, cx: number, cy: number, z: number, r: number, a0: number, sweep: number): { cx: number; cy: number; r: number; a0: number; sweep: number } {
  const c = applyXY(m, cx, cy, z);
  const s = applyXY(m, cx + r * Math.cos(a0), cy + r * Math.sin(a0), z);
  const e = applyXY(m, cx + r * Math.cos(a0 + sweep), cy + r * Math.sin(a0 + sweep), z);
  const rr = Math.hypot(s.x - c.x, s.y - c.y);
  const from = mirrored(m) ? e : s;
  return { cx: c.x, cy: c.y, r: rr, a0: Math.atan2(from.y - c.y, from.x - c.x), sweep };
}

/** 각 a가 반시계 호(a0에서 sweep) 안에 드는지 */
function onArc(a: number, a0: number, sweep: number): boolean {
  return sweep >= Math.PI * 2 - 1e-12 || ccwSweep(a0, a) <= sweep + 1e-9 || Math.abs(ccwSweep(a0, a) - Math.PI * 2) < 1e-9;
}

/** 연장선 획득점이 될 수 있는 객체의 끝(선·호·열린 폴리선) */
export function extAnchorsOf(e: Entity): ExtAnchor[] {
  switch (e.type) {
    case 'LINE': {
      const dx = e.end.x - e.start.x;
      const dy = e.end.y - e.start.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-12) return [];
      return [
        { p: { x: e.start.x, y: e.start.y }, dir: { x: -dx / l, y: -dy / l } },
        { p: { x: e.end.x, y: e.end.y }, dir: { x: dx / l, y: dy / l } },
      ];
    }
    case 'ARC': {
      const m = withOcs(identity(), e.extrusion);
      const a = worldArc(m, e.center.x, e.center.y, e.center.z, e.radius, e.startAngle, ccwSweep(e.startAngle, e.endAngle));
      const P = (t: number) => ({ x: a.cx + a.r * Math.cos(t), y: a.cy + a.r * Math.sin(t) });
      return [
        { p: P(a.a0), arc: a },
        { p: P(a.a0 + a.sweep), arc: a },
      ];
    }
    case 'LWPOLYLINE': {
      if (e.closed) return [];
      const vs = lwVertices(e);
      if (vs.length < 2) return [];
      const m = withOcs(identity(), e.extrusion);
      const end = (i: number, j: number, bulgeFrom: number): ExtAnchor | null => {
        // i = 끝 정점, j = 이웃 정점. 끝 선분의 볼록도는 bulgeFrom 정점의 것(앞 정점에서 뒤 정점으로)
        const a = vs[i]!;
        const b = vs[j]!;
        const pa = applyXY(m, a.x, a.y, e.elevation);
        const pb = applyXY(m, b.x, b.y, e.elevation);
        const bulge = vs[bulgeFrom]!.bulge;
        const first = i < j ? a : b;
        const second = i < j ? b : a;
        const arc = bulgeArc(first.x, first.y, second.x, second.y, bulge);
        // 볼록도 호의 사잇각은 부호가 있다(음수 = 시계 방향): 반시계 호로 바꾼다
        if (arc) return { p: pa, arc: worldArc(m, arc.cx, arc.cy, e.elevation, arc.r, arc.sweep < 0 ? arc.a0 + arc.sweep : arc.a0, Math.abs(arc.sweep)) };
        const l = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        return l < 1e-12 ? null : { p: pa, dir: { x: (pa.x - pb.x) / l, y: (pa.y - pb.y) / l } };
      };
      const n = vs.length;
      return [end(0, 1, 0), end(n - 1, n - 2, n - 2)].filter((x): x is ExtAnchor => !!x);
    }
    default:
      return [];
  }
}

/** 커서 근처(aperture 안)의 연장선 획득점 후보 */
export function findExtAnchor(picker: Picker, p: Pt, aperture: number): ExtAnchor | null {
  let best: ExtAnchor | null = null;
  let bd = Infinity;
  for (const c of picker.candidates(p.x, p.y, aperture).slice(0, 200)) {
    const e = picker.entity(c.handle);
    if (!e) continue;
    for (const a of extAnchorsOf(e)) {
      const d = Math.hypot(a.p.x - p.x, a.p.y - p.y);
      if (d <= aperture && d < bd) {
        bd = d;
        best = a;
      }
    }
  }
  return best;
}

/** 커서 아래 선분의 방향(평행 획득). 없으면 null */
export function segmentDirAt(picker: Picker, p: Pt, aperture: number): { dir: Pt; at: Pt } | null {
  const s = picker.segmentsNear(p.x, p.y, aperture, 50);
  let best: { dir: Pt; at: Pt } | null = null;
  let bd = Infinity;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const dx = s[i + 2]! - s[i]!;
    const dy = s[i + 3]! - s[i + 1]!;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-24) continue;
    const t = Math.max(0, Math.min(1, ((p.x - s[i]!) * dx + (p.y - s[i + 1]!) * dy) / l2));
    const q = { x: s[i]! + dx * t, y: s[i + 1]! + dy * t };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) {
      bd = d;
      const l = Math.sqrt(l2);
      best = { dir: { x: dx / l, y: dy / l }, at: q };
    }
  }
  return best;
}

/** 연장선 스냅 후보: 선분 끝의 바깥 연장, 호의 원 위 연장, 두 연장선의 교점 */
export function extSnaps(anchors: readonly ExtAnchor[], p: Pt, aperture: number): SnapPoint[] {
  const out: SnapPoint[] = [];
  const rays: { from: Pt; dir: Pt }[] = [];
  for (const a of anchors) {
    if (a.dir) {
      const t = (p.x - a.p.x) * a.dir.x + (p.y - a.p.y) * a.dir.y;
      if (t <= 0) continue;
      rays.push({ from: a.p, dir: a.dir });
      const q = { x: a.p.x + a.dir.x * t, y: a.p.y + a.dir.y * t };
      if (Math.hypot(q.x - p.x, q.y - p.y) <= aperture) out.push({ ...q, kind: 'ext', lines: [{ from: a.p, dir: a.dir }] });
    } else if (a.arc) {
      const c = a.arc;
      const ang = Math.atan2(p.y - c.cy, p.x - c.cx);
      if (Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r) > aperture || onArc(ang, c.a0, c.sweep)) continue;
      out.push({ x: c.cx + c.r * Math.cos(ang), y: c.cy + c.r * Math.sin(ang), kind: 'ext' });
    }
  }
  // 두 연장선이 만나는 점
  for (let i = 0; i < rays.length; i++)
    for (let j = i + 1; j < rays.length; j++) {
      const A = rays[i]!;
      const B = rays[j]!;
      const den = A.dir.x * B.dir.y - A.dir.y * B.dir.x;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((B.from.x - A.from.x) * B.dir.y - (B.from.y - A.from.y) * B.dir.x) / den;
      const u = ((B.from.x - A.from.x) * A.dir.y - (B.from.y - A.from.y) * A.dir.x) / den;
      if (t <= 0 || u <= 0) continue;
      const q = { x: A.from.x + A.dir.x * t, y: A.from.y + A.dir.y * t };
      if (Math.hypot(q.x - p.x, q.y - p.y) <= aperture) out.push({ ...q, kind: 'ext', lines: [A, B] });
    }
  return out;
}

/** 평행 스냅 후보: 기준점에서 획득한 방향(앞뒤)으로 나가는 선 위 */
export function parSnaps(base: Pt, dirs: readonly Pt[], p: Pt, aperture: number): SnapPoint[] {
  const out: SnapPoint[] = [];
  for (const d of dirs)
    for (const s of [1, -1]) {
      const u = { x: d.x * s, y: d.y * s };
      const vx = p.x - base.x;
      const vy = p.y - base.y;
      const t = vx * u.x + vy * u.y;
      if (t <= 0) continue;
      if (Math.abs(vx * u.y - vy * u.x) > aperture) continue;
      out.push({ x: base.x + u.x * t, y: base.y + u.y * t, kind: 'par', lines: [{ from: base, dir: u }] });
    }
  return out;
}

/** 기준점에서 원(중심 c, 반지름 r)에 그은 접선의 접점들. 기준점이 원 안이면 없음 */
export function tangentPoints(base: Pt, c: Pt, r: number): Pt[] {
  const dx = base.x - c.x;
  const dy = base.y - c.y;
  const d = Math.hypot(dx, dy);
  if (r <= 0 || d <= r * (1 + 1e-12)) return [];
  const th = Math.atan2(dy, dx);
  const ph = Math.acos(r / d);
  return [th + ph, th - ph].map((a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }));
}

/** 닫힌 꼭짓점 목록(볼록도 포함)의 면적 중심. 면적이 0이면 null */
export function polygonCentroid(vs: readonly { x: number; y: number; bulge: number }[]): Pt | null {
  const pts: number[] = [];
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % n]!;
    const arc = bulgeArc(a.x, a.y, b.x, b.y, a.bulge);
    if (arc) {
      // 호를 앞 정점에서 뒤 정점 쪽으로(사잇각은 부호가 있다) 잘게 나눈다. 끝점은 다음 정점이 넣는다
      const k = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 32)));
      for (let t = 0; t < k; t++) pts.push(arc.cx + arc.r * Math.cos(arc.a0 + (arc.sweep * t) / k), arc.cy + arc.r * Math.sin(arc.a0 + (arc.sweep * t) / k));
    } else pts.push(a.x, a.y);
  }
  let A = 0;
  let cx = 0;
  let cy = 0;
  const m = pts.length / 2;
  for (let i = 0; i < m; i++) {
    const x0 = pts[i * 2]!;
    const y0 = pts[i * 2 + 1]!;
    const x1 = pts[((i + 1) % m) * 2]!;
    const y1 = pts[((i + 1) % m) * 2 + 1]!;
    const f = x0 * y1 - x1 * y0;
    A += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(A) < 1e-18) return null;
  return { x: cx / (3 * A), y: cy / (3 * A) };
}

/** 닫힌 폴리선의 기하학적 중심(도면 좌표). 닫히지 않았으면 null */
export function geometricCenter(e: Entity): Pt | null {
  if (e.type === 'LWPOLYLINE') {
    if (!e.closed) return null;
    const c = polygonCentroid(lwVertices(e));
    return c ? applyXY(withOcs(identity(), e.extrusion), c.x, c.y, e.elevation) : null;
  }
  if (e.type === 'POLYLINE' && e.kind === '2d' && e.flags & 1) {
    const vs = e.vertices.filter((v) => !(v.flags & 16)).map((v) => ({ x: v.location.x, y: v.location.y, bulge: e.flags & 2 ? 0 : v.bulge }));
    const c = polygonCentroid(vs);
    return c ? applyXY(withOcs(identity(), e.extrusion), c.x, c.y, e.elevation) : null;
  }
  return null;
}

/** 원·호(도면 좌표)와 호 범위 — 접점·중심 테두리 스냅용 */
function circleOf(e: Entity): { cx: number; cy: number; r: number; a0: number; sweep: number } | null {
  if (e.type === 'CIRCLE') {
    const c = applyXY(withOcs(identity(), e.extrusion), e.center.x, e.center.y, e.center.z);
    return { cx: c.x, cy: c.y, r: e.radius, a0: 0, sweep: Math.PI * 2 };
  }
  if (e.type === 'ARC') return worldArc(withOcs(identity(), e.extrusion), e.center.x, e.center.y, e.center.z, e.radius, e.startAngle, ccwSweep(e.startAngle, e.endAngle));
  return null;
}

/** 커서 근처의 스냅점. ctx는 연장선·평행 획득점(앱이 모은다) */
export function findSnap(doc: CadDocument, picker: Picker, p: Pt, aperture: number, modes: ReadonlySet<SnapKind>, base?: Pt | null, ctx?: SnapContext): SnapPoint | null {
  if (!modes.size) return null;
  const cands = picker.candidates(p.x, p.y, aperture);
  let best: SnapPoint | null = null;
  let bestScore = Infinity;
  /** d: 커서까지의 거리(테두리로 잡는 중심은 조준창의 절반으로 친다) */
  const considerAt = (s: SnapPoint, d: number) => {
    if (!modes.has(s.kind)) return;
    if (d > aperture) return;
    const score = d / aperture + (PRIORITY[s.kind] ?? 1) * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  };
  const consider = (s: SnapPoint) => considerAt(s, Math.hypot(s.x - p.x, s.y - p.y));
  const m = identity();
  for (const c of cands.slice(0, 200)) {
    const e = picker.entity(c.handle);
    if (!e) continue;
    const pts: SnapPoint[] = [];
    entitySnaps(doc, e, m, pts);
    for (const s of pts) consider({ ...s, handle: c.handle });
    // 테두리 위에 커서가 있으면 중심·기하학적 중심(AutoCAD와 같다)
    const round = e.type === 'CIRCLE' || e.type === 'ARC' || e.type === 'ELLIPSE';
    const poly = e.type === 'LWPOLYLINE' || e.type === 'POLYLINE';
    if (((round && modes.has('cen')) || (poly && modes.has('gcen'))) && picker.distance(c.handle, p.x, p.y) <= aperture) {
      if (poly) {
        const g = geometricCenter(e);
        if (g) considerAt({ ...g, kind: 'gcen', handle: c.handle }, aperture * 0.5);
      } else if (round) {
        const cp = applyXY(withOcs(m, e.extrusion), e.center.x, e.center.y, e.center.z);
        considerAt({ ...cp, kind: 'cen', handle: c.handle }, aperture * 0.5);
      }
    }
    if (modes.has('tan') && base) {
      const circ = circleOf(e);
      if (circ)
        for (const q of tangentPoints(base, { x: circ.cx, y: circ.cy }, circ.r))
          if (onArc(Math.atan2(q.y - circ.cy, q.x - circ.cx), circ.a0, circ.sweep)) consider({ ...q, kind: 'tan', handle: c.handle });
    }
  }
  if (modes.has('ext') && ctx?.ext?.length) for (const s of extSnaps(ctx.ext, p, aperture)) consider(s);
  if (modes.has('par') && base && ctx?.par?.length) for (const s of parSnaps(base, ctx.par, p, aperture)) consider(s);
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
  if (modes.has('app')) {
    // 가상 교차점: 근처 선분을 늘려 만나는 점(조준창의 4배 안의 선분끼리, 교점은 조준창 안)
    const segs = picker.segmentsNear(p.x, p.y, aperture * 4, 200);
    const n = segs.length / 4;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const q = lineInter(segs, i * 4, j * 4);
        if (q) consider({ ...q, kind: 'app' });
      }
  }
  return best;
}
