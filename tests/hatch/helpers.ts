/** 해치 테스트 도우미: 객체 만들기, 경로 넓이·점 판정 */
import type { BlockDef, CadDocument, Entity, HatchPath, LwVertex, Vec2, Vec3 } from '../../src/core/model';
import { MODEL_SPACE, createDocument, entityDefaults } from '../../src/core/model';
import { pathLoop } from '../../src/render/hatch';
import { packLw } from '../../src/core/lwpoly';

export const P = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
export const deg = (d: number) => (d * Math.PI) / 180;

let serial = 0x100;
const H = () => (serial++).toString(16).toUpperCase();
const base = () => ({ ...entityDefaults(), handle: H() });

export function newDoc(): CadDocument {
  const doc = createDocument('new');
  const ms: BlockDef = { name: '*Model_Space', handle: H(), recordHandle: H(), basePoint: P(0, 0), flags: 0, entities: [] };
  doc.blocks.set(MODEL_SPACE, ms);
  doc.layers.set('0', { name: '0', handle: H(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 });
  return doc;
}

/** 모형 공간에 넣고 색인 */
export function add(doc: CadDocument, ...list: Entity[]): Entity[] {
  const ms = doc.blocks.get(MODEL_SPACE)!;
  for (const e of list) {
    ms.entities.push(e);
    doc.entityIndex.set(e.handle, e);
  }
  return list;
}

export function line(x0: number, y0: number, x1: number, y1: number): Entity {
  return { type: 'LINE', ...base(), start: P(x0, y0), end: P(x1, y1) };
}

export function circle(cx: number, cy: number, r: number, ext?: Vec3): Entity {
  return { type: 'CIRCLE', ...base(), center: P(cx, cy), radius: r, extrusion: ext };
}

export function arc(cx: number, cy: number, r: number, a0: number, a1: number): Entity {
  return { type: 'ARC', ...base(), center: P(cx, cy), radius: r, startAngle: deg(a0), endAngle: deg(a1) };
}

export function ellipse(cx: number, cy: number, mx: number, my: number, ratio: number, p0 = 0, p1 = Math.PI * 2): Entity {
  return { type: 'ELLIPSE', ...base(), center: P(cx, cy), majorAxis: P(mx, my), ratio, startParam: p0, endParam: p1 };
}

export function lw(pts: [number, number, number?][], closed = false, ext?: Vec3): Entity {
  const vertices: LwVertex[] = pts.map(([x, y, b]) => ({ x, y, bulge: b ?? 0, startWidth: 0, endWidth: 0 }));
  return { type: 'LWPOLYLINE', ...base(), ...packLw(vertices), closed, plinegen: false, constantWidth: 0, elevation: 0, extrusion: ext };
}

export function rect(x0: number, y0: number, x1: number, y1: number): Entity {
  return lw(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    true,
  );
}

export function spline(ctrl: [number, number][], degree = 3): Entity {
  const n = ctrl.length;
  const knots: number[] = [];
  for (let i = 0; i < n + degree + 1; i++) knots.push(i <= degree ? 0 : i >= n ? n - degree : i - degree);
  return {
    type: 'SPLINE',
    ...base(),
    flags: 8,
    degree,
    knots,
    controlPoints: ctrl.map(([x, y]) => P(x, y)),
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
  };
}

export function insert(block: string, x: number, y: number, sx = 1, sy = 1, rot = 0): Entity {
  return {
    type: 'INSERT',
    ...base(),
    block,
    insert: P(x, y),
    scale: P(sx, sy, 1),
    rotation: deg(rot),
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
}

export function defineBlock(doc: CadDocument, name: string, entities: Entity[], basePoint = P(0, 0)): void {
  doc.blocks.set(name.toUpperCase(), { name, handle: H(), recordHandle: H(), basePoint, flags: 0, entities });
}

/** 경로 → 점 배열 */
export function ring(p: HatchPath, tol = 1e-3): Vec2[] {
  const f = pathLoop(p, tol);
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) out.push({ x: f[i]!, y: f[i + 1]! });
  return out;
}

export function area(p: HatchPath, tol = 1e-6): number {
  const r = ring(p, tol);
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j]!.x * r[i]!.y - r[i]!.x * r[j]!.y;
  return a / 2;
}

/** 홀짝 규칙으로 점이 해치 안쪽인지 */
export function insideHatch(paths: HatchPath[], q: Vec2): boolean {
  let n = 0;
  for (const p of paths) {
    const r = ring(p);
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i]!;
      const b = r[j]!;
      if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    if (inside) n++;
  }
  return n % 2 === 1;
}
