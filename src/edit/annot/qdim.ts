/**
 * 빠른 치수(QDIM): 고른 객체의 치수 점을 모아 연속·다중(엇갈림)·기준선·세로좌표·반지름·지름 치수를 한꺼번에 만든다.
 * 치수 점 = 선·폴리선 끝점과 꼭짓점, 호 끝점, 원 중심, 점, 블록 삽입점. 반지름·지름은 원과 호.
 * 방향: 치수선 위치가 점들의 범위 위·아래면 수평(X 거리), 왼쪽·오른쪽이면 수직(Y 거리).
 */
import type { CadDocument, DimensionEntity, Entity, Vec3 } from '../../core/model';
import { createDiameterDimension, createLinearDimension, createOrdinateDimension, createRadialDimension } from '../dim/create';
import { dimVars } from '../dim/vars';

export interface P {
  x: number;
  y: number;
}

export type QdimMode = 'C' | 'S' | 'B' | 'O' | 'R' | 'D';

export interface QdimGeometry {
  points: P[];
  circles: { c: P; r: number }[];
}

const v3 = (q: P, z = 0): Vec3 => ({ x: q.x, y: q.y, z });

/** 고른 객체의 치수 점과 원·호 */
export function qdimGeometry(ents: readonly Entity[]): QdimGeometry {
  const points: P[] = [];
  const circles: { c: P; r: number }[] = [];
  const add = (q: { x: number; y: number }) => {
    if (!points.some((o) => Math.abs(o.x - q.x) < 1e-9 && Math.abs(o.y - q.y) < 1e-9)) points.push({ x: q.x, y: q.y });
  };
  for (const e of ents) {
    switch (e.type) {
      case 'LINE':
        add(e.start);
        add(e.end);
        break;
      case 'LWPOLYLINE':
        for (const v of e.vertices) add(v);
        for (let i = 0; i < e.vertices.length; i++) {
          const a = e.vertices[i]!;
          const b = e.vertices[(i + 1) % e.vertices.length]!;
          if (!a.bulge || (!e.closed && i === e.vertices.length - 1)) continue;
          // 호 세그먼트: 중심·반지름
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (!(d > 0)) continue;
          const th = 4 * Math.atan(a.bulge);
          const r = Math.abs(d / (2 * Math.sin(th / 2)));
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const h = (r * Math.cos(th / 2)) * Math.sign(a.bulge);
          const nx = -(b.y - a.y) / d;
          const ny = (b.x - a.x) / d;
          circles.push({ c: { x: mx + nx * h, y: my + ny * h }, r });
        }
        break;
      case 'POLYLINE':
        for (const v of e.vertices) add(v.location);
        break;
      case 'ARC':
        add({ x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) });
        add({ x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle) });
        circles.push({ c: { x: e.center.x, y: e.center.y }, r: e.radius });
        break;
      case 'CIRCLE':
        add(e.center);
        circles.push({ c: { x: e.center.x, y: e.center.y }, r: e.radius });
        break;
      case 'POINT':
        add(e.position);
        break;
      case 'INSERT':
        add(e.insert);
        break;
      default:
        break;
    }
  }
  return { points, circles };
}

/** 치수선 위치로 방향 정하기: 0 = 수평(X 거리), π/2 = 수직 */
export function qdimRotation(points: readonly P[], at: P): number {
  if (!points.length) return 0;
  const xs = points.map((q) => q.x);
  const ys = points.map((q) => q.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const outX = Math.max(0, minX - at.x, at.x - maxX);
  const outY = Math.max(0, minY - at.y, at.y - maxY);
  if (outX === 0 && outY === 0) return maxX - minX >= maxY - minY ? 0 : Math.PI / 2;
  return outY >= outX ? 0 : Math.PI / 2;
}

/** 측정 축 좌표로 정렬하고 같은 좌표는 하나만 */
function sortedAlong(points: readonly P[], horizontal: boolean): P[] {
  const k = (q: P) => (horizontal ? q.x : q.y);
  const s = [...points].sort((a, b) => k(a) - k(b));
  const span = s.length ? Math.max(1, Math.abs(k(s[s.length - 1]!) - k(s[0]!))) : 1;
  const out: P[] = [];
  for (const q of s) if (!out.length || Math.abs(k(q) - k(out[out.length - 1]!)) > 1e-9 * span) out.push(q);
  return out;
}

export interface QdimOptions {
  /** 기준선·세로좌표의 데이텀 점 */
  datum?: P | null;
  style?: string;
}

/** 치수 만들기(블록은 부르는 쪽이 만든다) */
export function qdimCreate(doc: CadDocument, mode: QdimMode, g: QdimGeometry, at: P, opt: QdimOptions = {}): DimensionEntity[] {
  const out: DimensionEntity[] = [];
  const style = opt.style;
  if (mode === 'R' || mode === 'D') {
    for (const c of g.circles) {
      const a = Math.atan2(at.y - c.c.y, at.x - c.c.x);
      const on = v3({ x: c.c.x + c.r * Math.cos(a), y: c.c.y + c.r * Math.sin(a) });
      out.push(mode === 'R' ? createRadialDimension(doc, v3(c.c), c.r, on, { style }) : createDiameterDimension(doc, v3(c.c), c.r, on, { style }));
    }
    return out;
  }
  const rot = qdimRotation(g.points, at);
  const hz = rot === 0;
  const pts = sortedAlong(g.points, hz);
  if (!pts.length) return out;
  const ys = g.points.map((q) => (hz ? q.y : q.x));
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const atN = hz ? at.y : at.x;
  const away = atN >= mid ? 1 : -1;
  const probe = createLinearDimension(doc, v3(pts[0]!), v3(pts[pts.length - 1]!), v3(at), { rotation: rot, style });
  const raw = dimVars(doc, probe);
  const step = (raw.dli > 0 ? raw.dli : raw.txt * 2) * away;
  const lineAt = (k: number): Vec3 => (hz ? { x: at.x, y: at.y + k * step, z: 0 } : { x: at.x + k * step, y: at.y, z: 0 });
  const lin = (a: P, b: P, k: number) => createLinearDimension(doc, v3(a), v3(b), lineAt(k), { rotation: rot, style });
  if (mode === 'C') {
    for (let i = 0; i + 1 < pts.length; i++) out.push(lin(pts[i]!, pts[i + 1]!, 0));
  } else if (mode === 'S') {
    // 엇갈림: 안쪽 쌍부터 바깥 쌍으로, 바깥일수록 한 칸씩 멀리
    const n = pts.length;
    const pairs: [P, P][] = [];
    for (let i = 0; i < Math.floor(n / 2); i++) if (i !== n - 1 - i) pairs.push([pts[i]!, pts[n - 1 - i]!]);
    pairs.reverse().forEach(([a, b], k) => out.push(lin(a, b, k)));
  } else if (mode === 'B') {
    const datum = opt.datum ?? pts[0]!;
    const key = (q: P) => (hz ? q.x : q.y);
    const rest = pts.filter((q) => Math.abs(key(q) - key(datum)) > 1e-9 * Math.max(1, Math.abs(key(datum)))).sort((a, b) => Math.abs(key(a) - key(datum)) - Math.abs(key(b) - key(datum)));
    rest.forEach((q, k) => out.push(lin(datum, q, k)));
  } else if (mode === 'O') {
    for (const q of pts) {
      const end: Vec3 = hz ? { x: q.x, y: at.y, z: 0 } : { x: at.x, y: q.y, z: 0 };
      const d = createOrdinateDimension(doc, v3(q), end, { xAxis: hz, style });
      if (opt.datum) d.defPoint = v3(opt.datum);
      out.push(d);
    }
  }
  return out;
}
