/** 테스트 객체 만들기(vitest 없이도 쓸 수 있다) */
import type { BlockDef, CadDocument, Entity, LwVertex, Vec2, Vec3 } from '../../src/core/model';
import { MODEL_SPACE, createDocument, entityDefaults } from '../../src/core/model';
import { packLw } from '../../src/core/lwpoly';

export const P = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
export const V = (x: number, y: number): Vec2 => ({ x, y });
export const NEG_Z: Vec3 = { x: 0, y: 0, z: -1 };
export const deg = (d: number) => (d * Math.PI) / 180;

let serial = 1;
const H = () => (serial++).toString(16).toUpperCase();

export function newDoc(): CadDocument {
  const doc = createDocument('new');
  const ms: BlockDef = { name: '*Model_Space', handle: H(), recordHandle: H(), basePoint: P(0, 0), flags: 0, entities: [] };
  doc.blocks.set(MODEL_SPACE, ms);
  doc.layers.set('0', { name: '0', handle: H(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 });
  return doc;
}

const base = () => ({ ...entityDefaults(), handle: H() });

export function line(x0: number, y0: number, x1: number, y1: number): Entity {
  return { type: 'LINE', ...base(), start: P(x0, y0), end: P(x1, y1) };
}

export function circle(cx: number, cy: number, r: number, ext?: Vec3): Entity {
  return { type: 'CIRCLE', ...base(), center: P(cx, cy), radius: r, extrusion: ext };
}

export function arc(cx: number, cy: number, r: number, a0: number, a1: number, ext?: Vec3): Entity {
  return { type: 'ARC', ...base(), center: P(cx, cy), radius: r, startAngle: deg(a0), endAngle: deg(a1), extrusion: ext };
}

export function ellipse(cx: number, cy: number, mx: number, my: number, ratio: number, p0 = 0, p1 = Math.PI * 2): Entity {
  return { type: 'ELLIPSE', ...base(), center: P(cx, cy), majorAxis: P(mx, my), ratio, startParam: p0, endParam: p1 };
}

export function lw(pts: [number, number, number?][], closed = false, ext?: Vec3, width = 0): Entity {
  const vertices: LwVertex[] = pts.map(([x, y, b]) => ({ x, y, bulge: b ?? 0, startWidth: 0, endWidth: 0 }));
  return { type: 'LWPOLYLINE', ...base(), ...packLw(vertices), closed, plinegen: false, constantWidth: width, elevation: 0, extrusion: ext };
}

export function poly2d(pts: [number, number, number?][], closed = false): Entity {
  return {
    type: 'POLYLINE',
    ...base(),
    kind: '2d',
    flags: closed ? 1 : 0,
    vertices: pts.map(([x, y, b]) => ({ location: P(x, y), bulge: b ?? 0, startWidth: 0, endWidth: 0, flags: 0 })),
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

export function spline(ctrl: [number, number][], degree = 3, closed = false): Entity {
  const n = ctrl.length;
  const knots: number[] = [];
  for (let i = 0; i < n + degree + 1; i++) knots.push(i <= degree ? 0 : i >= n ? n - degree : i - degree);
  return {
    type: 'SPLINE',
    ...base(),
    flags: (closed ? 1 : 0) | 8,
    degree,
    knots,
    controlPoints: ctrl.map(([x, y]) => P(x, y)),
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
  };
}

export function fitSpline(fit: [number, number][]): Entity {
  return {
    type: 'SPLINE',
    ...base(),
    flags: 8,
    degree: 3,
    knots: [],
    controlPoints: [],
    fitPoints: fit.map(([x, y]) => P(x, y)),
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
  };
}

export function xline(x: number, y: number, dx: number, dy: number, ray = false): Entity {
  const l = Math.hypot(dx, dy);
  return { type: ray ? 'RAY' : 'XLINE', ...base(), base: P(x, y), direction: P(dx / l, dy / l) };
}

export function text(x: number, y: number, s: string, h = 2.5, rot = 0, extra: Record<string, unknown> = {}): Entity {
  return {
    type: 'TEXT',
    ...base(),
    insert: P(x, y),
    height: h,
    text: s,
    rotation: rot,
    widthFactor: 1,
    oblique: 0,
    style: 'Standard',
    generation: 0,
    halign: 0,
    valign: 0,
    ...extra,
  } as Entity;
}

export function mtext(x: number, y: number, s: string, h = 2.5, extra: Record<string, unknown> = {}): Entity {
  return {
    type: 'MTEXT',
    ...base(),
    insert: P(x, y),
    height: h,
    width: 0,
    attachment: 1,
    drawingDirection: 1,
    text: s,
    style: 'Standard',
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
    ...extra,
  } as Entity;
}

