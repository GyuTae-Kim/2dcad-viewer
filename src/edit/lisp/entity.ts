/**
 * AutoLISP 객체 자료: entget·entmod·entmake·entdel·entnext·entlast와 ssget 필터(화면·DOM 없음).
 * 그룹 코드 연관 목록은 AutoCAD entget 꼴을 따른다: (-1 . 이름) (0 . "LINE") (330 . 소유자) (5 . "핸들") (100 . "AcDbEntity")
 * (67 . 0) (410 . "Model") (8 . "0") [6 62 420 370 48 60 440] (100 . "AcDbLine") (10 x y z) (11 x y z) (210 0.0 0.0 1.0).
 * 각도는 라디안, 좌표는 WCS(2D 객체는 OCS). 색이 ByLayer면 62를 넣지 않는다(AutoCAD와 같다).
 * 블록 참조의 속성(ATTRIB)과 옛 폴리선(POLYLINE)의 정점(VERTEX)·SEQEND는 entnext로 따라갈 수 있다(정점·SEQEND는 자리표시 이름).
 * 블록 정의 안의 객체(nentsel·-2 그룹으로 얻은 이름)도 entget·entmod할 수 있다(소유자 330은 블록 레코드, 67·410은 없다).
 * 확장 데이터(-3)·비도형 객체(사전·XRECORD)·표 기록은 objects.ts.
 */
import type { AttribEntity, CadColor, Entity, InsertEntity, Layer, LwVertex, MTextEntity, PolylineEntity, TextEntity, Vec3 } from '../../core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity, isLayoutBlock } from '../session';
import type { LispDrawing } from './host';
import type { Interp } from './interp';
import { prin1 } from './printer';
import { wcmatch } from './text';
import { makeObject, mergeXData, modLayer, modObject, objectGroups, objectOf, readXData, recordXData, tableRecordGroups, xdataPair } from './objects';
import { Cons, Ename, LispError, Real, fromArray, isNum, numOf, toArray, type Value } from './types';

type Pair = [number, Value];

const R = (x: number) => new Real(x);
const P3 = (v: { x: number; y: number; z?: number }) => fromArray([R(v.x), R(v.y), R(v.z ?? 0)]);
const P2 = (v: { x: number; y: number }) => fromArray([R(v.x), R(v.y)]);
const Z: Vec3 = { x: 0, y: 0, z: 1 };

const SEQEND = 'SEQEND:';
const VERTEX = 'VERTEX:';

/** 맨 위(모형·배치) 공간 블록 키 → 배치 이름 */
function layoutName(d: LispDrawing, key: string): string {
  if (key === MODEL_SPACE) return 'Model';
  return d.doc.layouts.find((l) => tableKey(l.blockName) === key)?.name ?? 'Layout1';
}

/** 맨 위 공간들(모형 먼저, 배치는 탭 순서) */
function topSpaces(d: LispDrawing): string[] {
  const out = [MODEL_SPACE];
  for (const l of [...d.doc.layouts].sort((a, b) => a.tabOrder - b.tabOrder)) {
    const k = tableKey(l.blockName);
    if (!out.includes(k) && d.doc.blocks.has(k)) out.push(k);
  }
  for (const k of d.doc.blocks.keys()) if (isLayoutBlock(k) && !out.includes(k)) out.push(k);
  return out;
}

export function dxfType(e: Entity): string {
  if (e.type === 'DIMENSION') return e.subtype ?? 'DIMENSION';
  if (e.type === 'UNKNOWN') return e.originalType;
  return e.type;
}

// --------------------------------------------------------------------------- 데이터베이스 순서

interface Order {
  list: string[];
  index: Map<string, number>;
}
const orders = new WeakMap<object, Order>();

function buildOrder(d: LispDrawing): Order {
  const list: string[] = [];
  for (const k of topSpaces(d)) {
    for (const e of d.doc.blocks.get(k)?.entities ?? []) {
      if (!e.handle) continue;
      list.push(e.handle);
      if (e.type === 'INSERT' && e.attribs.length) {
        for (const a of e.attribs) if (a.handle) list.push(a.handle);
        list.push(SEQEND + e.handle);
      } else if (e.type === 'POLYLINE') {
        e.vertices.forEach((_, i) => list.push(`${VERTEX}${e.handle}:${i}`));
        list.push(SEQEND + e.handle);
      }
    }
  }
  const o = { list, index: new Map(list.map((h, i) => [h, i])) };
  orders.set(d.doc, o);
  return o;
}

/** 이름이 아직 도면에 있는가(자리표시 이름 포함) */
export function exists(d: LispDrawing, h: string): boolean {
  if (h.startsWith(SEQEND)) {
    const p = d.doc.entityIndex.get(h.slice(SEQEND.length));
    return !!p && ((p.type === 'INSERT' && p.attribs.length > 0) || p.type === 'POLYLINE');
  }
  if (h.startsWith(VERTEX)) {
    const [ph, i] = h.slice(VERTEX.length).split(':');
    const p = d.doc.entityIndex.get(ph!);
    return !!p && p.type === 'POLYLINE' && Number(i) < p.vertices.length;
  }
  return d.doc.entityIndex.has(h) && (!!topKey(d, h) || isAttrib(d, h));
}

function isAttrib(d: LispDrawing, h: string): boolean {
  const e = d.doc.entityIndex.get(h);
  return !!e && e.type === 'ATTRIB' && !!parentInsert(d, e as AttribEntity);
}

/** 맨 위 공간 블록 키(블록 정의 안이면 null) */
function topKey(d: LispDrawing, h: string): string | null {
  const k = d.session.ownerOf(h);
  return k && isLayoutBlock(k) ? k : null;
}

/** entnext: h 다음(없으면 처음) */
export function entnext(d: LispDrawing, h: string | null): string | null {
  let o = orders.get(d.doc) ?? buildOrder(d);
  if (h === null) {
    o = buildOrder(d);
    return o.list.find((x) => exists(d, x)) ?? null;
  }
  let i = o.index.get(h);
  if (i === undefined || i >= o.list.length - 1) {
    o = buildOrder(d);
    i = o.index.get(h);
    if (i === undefined) return null;
  }
  for (let j = i + 1; j < o.list.length; j++) if (exists(d, o.list[j]!)) return o.list[j]!;
  return null;
}

/** 모든 맨 위 객체(선택 세트 X) */
export function allMain(d: LispDrawing): string[] {
  const out: string[] = [];
  for (const k of topSpaces(d)) for (const e of d.doc.blocks.get(k)?.entities ?? []) if (e.handle) out.push(e.handle);
  return out;
}

/** entlast: 가장 나중에 만든 맨 위 객체(핸들이 가장 큰 것) */
export function entlast(d: LispDrawing): string | null {
  let best: string | null = null;
  let bv = -1n;
  for (const h of allMain(d)) {
    let v: bigint;
    try {
      v = BigInt('0x' + h);
    } catch {
      continue;
    }
    if (v > bv) {
      bv = v;
      best = h;
    }
  }
  return best;
}

function parentInsert(d: LispDrawing, a: AttribEntity): InsertEntity | null {
  const o = a.owner ? d.doc.entityIndex.get(a.owner) : undefined;
  if (o?.type === 'INSERT' && o.attribs.includes(a)) return o;
  for (const k of topSpaces(d)) for (const e of d.doc.blocks.get(k)?.entities ?? []) if (e.type === 'INSERT' && e.attribs.includes(a)) return e;
  return null;
}

// --------------------------------------------------------------------------- entget

function colorGroups(c: CadColor, out: Pair[]): void {
  if (c.aci !== 256) out.push([62, c.aci]);
  if (c.rgb !== undefined) out.push([420, c.rgb]);
}

function common(it: Interp, d: LispDrawing, e: Entity, key: string, ownerHandle: string | undefined): Pair[] {
  const out: Pair[] = [
    [-1, it.ename(e.handle)],
    [0, dxfType(e)],
  ];
  if (ownerHandle) out.push([330, it.ename(ownerHandle)]);
  out.push([5, e.handle], [100, 'AcDbEntity']);
  if (isLayoutBlock(key)) out.push([67, key === MODEL_SPACE ? 0 : 1], [410, layoutName(d, key)]);
  out.push([8, e.layer]);
  if (e.linetype && !/^bylayer$/i.test(e.linetype)) out.push([6, e.linetype]);
  colorGroups(e.color, out);
  if (e.lineweight !== -1) out.push([370, e.lineweight]);
  if (e.ltscale !== 1) out.push([48, R(e.ltscale)]);
  if (e.invisible) out.push([60, 1]);
  if (e.transparency >= 0) out.push([440, 0x2000000 + e.transparency]);
  return out;
}

function textGroups(e: TextEntity | AttribEntity, out: Pair[]): void {
  out.push([100, 'AcDbText']);
  if (e.thickness) out.push([39, R(e.thickness)]);
  out.push([10, P3(e.insert)], [40, R(e.height)], [1, e.text], [50, R(e.rotation)], [41, R(e.widthFactor)], [51, R(e.oblique)], [7, e.style], [71, e.generation], [72, e.halign]);
  out.push([11, P3(e.alignPoint ?? e.insert)], [210, P3(e.extrusion ?? Z)]);
}

/** 객체 → 그룹 목록 */
export function entityGroups(it: Interp, d: LispDrawing, h: string): Pair[] | null {
  if (h.startsWith(SEQEND)) {
    const p = d.doc.entityIndex.get(h.slice(SEQEND.length));
    if (!p) return null;
    return [
      [-1, it.ename(h)],
      [0, 'SEQEND'],
      [330, it.ename(p.handle)],
      [5, ''],
      [100, 'AcDbEntity'],
      [8, p.layer],
      [-2, it.ename(p.handle)],
    ];
  }
  if (h.startsWith(VERTEX)) {
    const [ph, is] = h.slice(VERTEX.length).split(':');
    const p = d.doc.entityIndex.get(ph!);
    const v = p?.type === 'POLYLINE' ? p.vertices[Number(is)] : undefined;
    if (!p || !v) return null;
    return [
      [-1, it.ename(h)],
      [0, 'VERTEX'],
      [330, it.ename(p.handle)],
      [5, ''],
      [100, 'AcDbEntity'],
      [8, p.layer],
      [100, 'AcDbVertex'],
      [10, P3(v.location)],
      [40, R(v.startWidth)],
      [41, R(v.endWidth)],
      [42, R(v.bulge)],
      [70, v.flags],
      [50, R(v.tangent ?? 0)],
    ];
  }
  const e = d.doc.entityIndex.get(h);
  if (!e) return null;
  let key = topKey(d, h);
  let ownerH = e.owner;
  if (!key) {
    const ins = e.type === 'ATTRIB' ? parentInsert(d, e as AttribEntity) : null;
    if (ins) {
      key = topKey(d, ins.handle) ?? MODEL_SPACE;
      ownerH = ins.handle;
    } else {
      // 블록 정의 안의 객체
      key = d.session.ownerOf(h);
      if (!key) return null;
    }
  }
  if (!ownerH) ownerH = d.doc.blocks.get(key)?.recordHandle;
  const out = common(it, d, e, key, ownerH);
  switch (e.type) {
    case 'LINE':
      out.push([100, 'AcDbLine']);
      if (e.thickness) out.push([39, R(e.thickness)]);
      out.push([10, P3(e.start)], [11, P3(e.end)], [210, P3(e.extrusion ?? Z)]);
      break;
    case 'POINT':
      out.push([100, 'AcDbPoint'], [10, P3(e.position)], [210, P3(e.extrusion ?? Z)], [50, R(e.angle)]);
      break;
    case 'CIRCLE':
      out.push([100, 'AcDbCircle']);
      if (e.thickness) out.push([39, R(e.thickness)]);
      out.push([10, P3(e.center)], [40, R(e.radius)], [210, P3(e.extrusion ?? Z)]);
      break;
    case 'ARC':
      out.push([100, 'AcDbCircle']);
      if (e.thickness) out.push([39, R(e.thickness)]);
      out.push([10, P3(e.center)], [40, R(e.radius)], [210, P3(e.extrusion ?? Z)], [100, 'AcDbArc'], [50, R(e.startAngle)], [51, R(e.endAngle)]);
      break;
    case 'ELLIPSE':
      out.push([100, 'AcDbEllipse'], [10, P3(e.center)], [11, P3(e.majorAxis)], [210, P3(e.extrusion ?? Z)], [40, R(e.ratio)], [41, R(e.startParam)], [42, R(e.endParam)]);
      break;
    case 'LWPOLYLINE':
      out.push([100, 'AcDbPolyline'], [90, e.vertices.length], [70, (e.closed ? 1 : 0) | (e.plinegen ? 128 : 0)], [43, R(e.constantWidth)]);
      if (e.elevation) out.push([38, R(e.elevation)]);
      if (e.thickness) out.push([39, R(e.thickness)]);
      for (const v of e.vertices) out.push([10, P2(v)], [40, R(v.startWidth)], [41, R(v.endWidth)], [42, R(v.bulge)], [91, 0]);
      out.push([210, P3(e.extrusion ?? Z)]);
      break;
    case 'POLYLINE':
      out.push([100, e.kind === '3d' ? 'AcDb3dPolyline' : e.kind === '2d' ? 'AcDb2dPolyline' : 'AcDbPolygonMesh'], [66, 1], [10, P3({ x: 0, y: 0, z: e.elevation })], [70, e.flags]);
      out.push([40, R(e.defaultStartWidth)], [41, R(e.defaultEndWidth)], [210, P3(e.extrusion ?? Z)]);
      break;
    case 'TEXT':
      textGroups(e, out);
      out.push([100, 'AcDbText'], [73, e.valign]);
      break;
    case 'ATTRIB':
    case 'ATTDEF': {
      const a = e as AttribEntity;
      textGroups(a, out);
      if (a.type === 'ATTDEF') out.push([100, 'AcDbAttributeDefinition'], [3, a.prompt ?? ''], [2, a.tag], [70, a.attFlags], [73, 0], [74, a.valign]);
      else out.push([100, 'AcDbAttribute'], [280, 0], [2, a.tag], [70, a.attFlags], [73, 0], [74, a.valign], [280, a.lockPosition ? 1 : 0]);
      break;
    }
    case 'MTEXT': {
      out.push([100, 'AcDbMText'], [10, P3(e.insert)], [40, R(e.height)], [41, R(e.width)]);
      if (e.rectHeight !== undefined) out.push([46, R(e.rectHeight)]);
      out.push([71, e.attachment], [72, e.drawingDirection]);
      const t = e.text;
      let i = 0;
      while (t.length - i > 250) {
        out.push([3, t.slice(i, i + 250)]);
        i += 250;
      }
      out.push([1, t.slice(i)], [7, e.style], [210, P3(e.extrusion ?? Z)]);
      const dir = e.direction ?? { x: Math.cos(e.rotation), y: Math.sin(e.rotation), z: 0 };
      out.push([11, P3(dir)], [50, R(e.rotation)], [73, e.lineSpacingStyle], [44, R(e.lineSpacingFactor)]);
      break;
    }
    case 'INSERT':
      out.push([100, 'AcDbBlockReference']);
      if (e.attribs.length) out.push([66, 1]);
      out.push([2, e.block], [10, P3(e.insert)], [41, R(e.scale.x)], [42, R(e.scale.y)], [43, R(e.scale.z)], [50, R(e.rotation)], [70, e.columnCount], [71, e.rowCount], [44, R(e.columnSpacing)], [45, R(e.rowSpacing)], [210, P3(e.extrusion ?? Z)]);
      break;
    case 'XLINE':
    case 'RAY':
      out.push([100, e.type === 'XLINE' ? 'AcDbXline' : 'AcDbRay'], [10, P3(e.base)], [11, P3(e.direction)]);
      break;
    case 'SPLINE':
      out.push([100, 'AcDbSpline'], [210, P3(e.normal ?? Z)], [70, e.flags], [71, e.degree], [72, e.knots.length], [73, e.controlPoints.length], [74, e.fitPoints.length]);
      out.push([42, R(e.knotTolerance)], [43, R(e.controlTolerance)], [44, R(e.fitTolerance)]);
      for (const k of e.knots) out.push([40, R(k)]);
      if (e.weights) for (const w of e.weights) out.push([41, R(w)]);
      for (const p of e.controlPoints) out.push([10, P3(p)]);
      for (const p of e.fitPoints) out.push([11, P3(p)]);
      break;
    case 'HATCH':
    case 'MPOLYGON':
      out.push([100, 'AcDbHatch'], [10, P3({ x: 0, y: 0, z: e.elevation })], [210, P3(e.extrusion ?? Z)], [2, e.patternName], [70, e.solid ? 1 : 0], [71, e.associative ? 1 : 0], [91, e.paths.length]);
      out.push([75, e.hatchStyle], [76, e.patternType]);
      if (!e.solid) out.push([52, R(e.patternAngle)], [41, R(e.patternScale)], [77, e.patternDouble ? 1 : 0]);
      for (const s of e.seedPoints) out.push([10, P2(s)]);
      break;
    case 'DIMENSION':
      out.push([100, 'AcDbDimension'], [2, e.block], [10, P3(e.defPoint)], [11, P3(e.textMid)], [70, e.dimType], [71, e.attachment], [1, e.text], [3, e.dimStyle], [42, R(e.measurement)], [53, R(e.textRotation)]);
      out.push([13, P3(e.defPoint2)], [14, P3(e.defPoint3)], [15, P3(e.defPoint4)], [50, R(e.rotation)]);
      break;
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      out.push([100, e.type === '3DFACE' ? 'AcDbFace' : 'AcDbTrace']);
      e.points.forEach((c, i) => out.push([10 + i, P3(c)]));
      break;
    default:
      break;
  }
  return out;
}

export function toAssoc(pairs: Pair[]): Value {
  return fromArray(pairs.map(([c, v]) => new Cons(c, v)));
}

/** entget: 객체·비도형 객체·표 기록. apps가 있으면 그 앱의 확장 데이터(-3)를 끝에 붙인다 */
export function entget(it: Interp, d: LispDrawing, h: string, apps: readonly string[] = []): Value {
  const g = entityGroups(it, d, h);
  if (g) {
    const x = xdataPair(d.doc.entityIndex.get(h)?.xdata, apps);
    return toAssoc(x ? [...g, x] : g);
  }
  const o = objectGroups(it, d.doc, h);
  if (o) {
    const x = xdataPair(objectOf(d.doc, h)?.xdata, apps);
    return toAssoc(x ? [...o, x] : o);
  }
  const t = tableRecordGroups(it, d.doc, h);
  if (t) {
    const x = xdataPair(recordXData(it, d.doc, h), apps);
    return toAssoc(x ? [...t, x] : t);
  }
  return null;
}

/** 목록의 확장 데이터(-3)를 객체에 넣는다. 등록하지 않은 앱이면 false */
function applyXData(d: LispDrawing, e: Entity, pairs: Pair[]): boolean {
  const x = pairs.find(([c]) => c === -3);
  if (!x) return true;
  const { list, unregistered } = readXData(d.doc, x[1]);
  if (unregistered.length) return false;
  e.xdata = mergeXData(e.xdata, list);
  return true;
}

// --------------------------------------------------------------------------- 그룹 읽기

function bad(pair: Value): LispError {
  return new LispError(`잘못된 DXF 그룹: ${prin1(pair)}`);
}

/** 연관 목록 → [코드, 값] 배열(점 쌍이 아니면 오류) */
export function readPairs(list: Value): Pair[] {
  const a = toArray(list);
  if (!a) throw bad(list);
  return a.map((p) => {
    if (!(p instanceof Cons) || typeof p.car !== 'number') throw bad(p);
    return [p.car, p.cdr] as Pair;
  });
}

function nv(code: number, v: Value): number {
  if (!isNum(v)) throw bad(new Cons(code, v));
  return numOf(v);
}

function iv(code: number, v: Value): number {
  if (typeof v !== 'number') {
    if (v instanceof Real && Number.isInteger(v.v)) return v.v;
    throw bad(new Cons(code, v));
  }
  return v;
}

function sv(code: number, v: Value): string {
  if (typeof v !== 'string') throw bad(new Cons(code, v));
  return v;
}

function pv(code: number, v: Value): Vec3 {
  const a = toArray(v);
  if (!a || a.length < 2 || a.length > 3 || !a.every(isNum)) throw bad(new Cons(code, v));
  return { x: numOf(a[0] as number), y: numOf(a[1] as number), z: a.length === 3 ? numOf(a[2] as number) : 0 };
}

interface Apply {
  /** 새로 만들어야 할 도면층 */
  layers: Layer[];
}

function ensureLayer(d: LispDrawing, name: string, ctx: Apply): void {
  if (!name || d.doc.layers.has(tableKey(name)) || ctx.layers.some((l) => tableKey(l.name) === tableKey(name))) return;
  ctx.layers.push(newLayer(d, name, {}));
}

function newLayer(d: LispDrawing, name: string, p: Partial<Layer>): Layer {
  return {
    name,
    handle: d.session.newHandle(),
    flags: 0,
    color: { aci: 7 },
    off: false,
    frozen: false,
    locked: false,
    linetype: 'Continuous',
    lineweight: -3,
    plot: true,
    transparency: 255,
    ...p,
  };
}

function linetypeOk(d: LispDrawing, n: string): boolean {
  return /^(bylayer|byblock|continuous)$/i.test(n) || d.doc.linetypes.has(tableKey(n));
}

/** 공통 그룹을 객체에 적용. 처리했으면 true */
function applyCommon(d: LispDrawing, e: Entity, code: number, v: Value, ctx: Apply): boolean {
  switch (code) {
    case -1:
    case 0:
    case 5:
    case 100:
    case 330:
    case 67:
    case 410:
    case 102:
      return true;
    case 8: {
      const n = sv(code, v);
      ensureLayer(d, n, ctx);
      e.layer = d.doc.layers.get(tableKey(n))?.name ?? n;
      return true;
    }
    case 6: {
      const n = sv(code, v);
      if (!linetypeOk(d, n)) throw new LispError(`선종류 "${n}"이(가) 도면에 없습니다`);
      e.linetype = /^bylayer$/i.test(n) ? 'ByLayer' : /^byblock$/i.test(n) ? 'ByBlock' : (d.doc.linetypes.get(tableKey(n))?.name ?? n);
      return true;
    }
    case 62: {
      const c = iv(code, v);
      if (c < 0 || c > 256) throw bad(new Cons(code, v));
      e.color = { aci: c };
      return true;
    }
    case 420:
      e.color = { ...e.color, rgb: iv(code, v) & 0xffffff };
      return true;
    case 370:
      e.lineweight = iv(code, v);
      return true;
    case 48:
      e.ltscale = nv(code, v);
      return true;
    case 60:
      e.invisible = iv(code, v) === 1 || undefined;
      return true;
    case 39:
      e.thickness = nv(code, v) || undefined;
      return true;
    case 210:
      e.extrusion = pv(code, v);
      return true;
    case 440: {
      const t = iv(code, v);
      e.transparency = t & 0x2000000 ? t & 0xff : -1;
      return true;
    }
    default:
      return false;
  }
}

function textCodes(t: TextEntity | AttribEntity, code: number, v: Value): boolean {
  switch (code) {
    case 10:
      t.insert = pv(code, v);
      return true;
    case 11:
      t.alignPoint = pv(code, v);
      return true;
    case 40:
      t.height = nv(code, v);
      return true;
    case 1:
      t.text = sv(code, v);
      return true;
    case 50:
      t.rotation = nv(code, v);
      return true;
    case 41:
      t.widthFactor = nv(code, v);
      return true;
    case 51:
      t.oblique = nv(code, v);
      return true;
    case 7:
      t.style = sv(code, v);
      return true;
    case 71:
      t.generation = iv(code, v);
      return true;
    case 72:
      t.halign = iv(code, v) as TextEntity['halign'];
      return true;
    default:
      return false;
  }
}

/** 형식별 그룹 적용(모르는 그룹은 무시: AutoCAD도 읽기 전용 그룹은 무시한다) */
function applyGroups(d: LispDrawing, e: Entity, pairs: Pair[], ctx: Apply): void {
  if (e.type === 'LWPOLYLINE' && pairs.some(([c]) => c === 10)) {
    const vs: LwVertex[] = [];
    for (const [c, v] of pairs) {
      if (c === 10) {
        const p = pv(c, v);
        vs.push({ x: p.x, y: p.y, bulge: 0, startWidth: 0, endWidth: 0 });
      } else if (vs.length && (c === 40 || c === 41 || c === 42)) {
        const last = vs[vs.length - 1]!;
        const n = nv(c, v);
        if (c === 40) last.startWidth = n;
        else if (c === 41) last.endWidth = n;
        else last.bulge = n;
      }
    }
    e.vertices = vs;
  }
  let text3 = '';
  let hasText3 = false;
  for (const [code, v] of pairs) {
    if (applyCommon(d, e, code, v, ctx)) continue;
    switch (e.type) {
      case 'LINE':
        if (code === 10) e.start = pv(code, v);
        else if (code === 11) e.end = pv(code, v);
        break;
      case 'POINT':
        if (code === 10) e.position = pv(code, v);
        else if (code === 50) e.angle = nv(code, v);
        break;
      case 'CIRCLE':
      case 'ARC':
        if (code === 10) e.center = pv(code, v);
        else if (code === 40) {
          const r = nv(code, v);
          if (!(r > 0)) throw bad(new Cons(code, v));
          e.radius = r;
        } else if (e.type === 'ARC' && code === 50) e.startAngle = nv(code, v);
        else if (e.type === 'ARC' && code === 51) e.endAngle = nv(code, v);
        break;
      case 'ELLIPSE':
        if (code === 10) e.center = pv(code, v);
        else if (code === 11) e.majorAxis = pv(code, v);
        else if (code === 40) e.ratio = nv(code, v);
        else if (code === 41) e.startParam = nv(code, v);
        else if (code === 42) e.endParam = nv(code, v);
        break;
      case 'LWPOLYLINE':
        if (code === 70) {
          const f = iv(code, v);
          e.closed = (f & 1) !== 0;
          e.plinegen = (f & 128) !== 0;
        } else if (code === 43) e.constantWidth = nv(code, v);
        else if (code === 38) e.elevation = nv(code, v);
        break;
      case 'TEXT':
        if (!textCodes(e, code, v) && code === 73) e.valign = iv(code, v) as TextEntity['valign'];
        break;
      case 'ATTRIB':
      case 'ATTDEF': {
        const a = e as AttribEntity;
        if (textCodes(a, code, v)) break;
        if (code === 74) a.valign = iv(code, v) as TextEntity['valign'];
        else if (code === 2) a.tag = sv(code, v);
        else if (code === 70) a.attFlags = iv(code, v);
        else if (code === 3 && a.type === 'ATTDEF') a.prompt = sv(code, v);
        break;
      }
      case 'MTEXT':
        if (code === 10) e.insert = pv(code, v);
        else if (code === 40) e.height = nv(code, v);
        else if (code === 41) e.width = nv(code, v);
        else if (code === 46) e.rectHeight = nv(code, v);
        else if (code === 71) e.attachment = iv(code, v);
        else if (code === 72) e.drawingDirection = iv(code, v);
        else if (code === 3) {
          text3 += sv(code, v);
          hasText3 = true;
        } else if (code === 1) {
          e.text = (hasText3 ? text3 : '') + sv(code, v);
          text3 = '';
          hasText3 = false;
        } else if (code === 7) e.style = sv(code, v);
        else if (code === 11) {
          e.direction = pv(code, v);
          e.rotation = Math.atan2(e.direction.y, e.direction.x);
        } else if (code === 50) {
          e.rotation = nv(code, v);
          e.direction = undefined;
        } else if (code === 44) e.lineSpacingFactor = nv(code, v);
        else if (code === 73) e.lineSpacingStyle = iv(code, v);
        break;
      case 'INSERT':
        if (code === 2) {
          const n = sv(code, v);
          const b = d.doc.blocks.get(tableKey(n));
          if (!b) throw new LispError(`블록 "${n}"이(가) 도면에 없습니다`);
          e.block = b.name;
        } else if (code === 10) e.insert = pv(code, v);
        else if (code === 41) e.scale = { ...e.scale, x: nv(code, v) };
        else if (code === 42) e.scale = { ...e.scale, y: nv(code, v) };
        else if (code === 43) e.scale = { ...e.scale, z: nv(code, v) };
        else if (code === 50) e.rotation = nv(code, v);
        else if (code === 70) e.columnCount = iv(code, v);
        else if (code === 71) e.rowCount = iv(code, v);
        else if (code === 44) e.columnSpacing = nv(code, v);
        else if (code === 45) e.rowSpacing = nv(code, v);
        break;
      case 'XLINE':
      case 'RAY':
        if (code === 10) e.base = pv(code, v);
        else if (code === 11) {
          const p = pv(code, v);
          const l = Math.hypot(p.x, p.y, p.z) || 1;
          e.direction = { x: p.x / l, y: p.y / l, z: p.z / l };
        }
        break;
      default:
        break;
    }
  }
}

// --------------------------------------------------------------------------- entmod

/** entmod: 바꾼 목록을 돌려준다. 실패하면 null */
export function entmod(it: Interp, d: LispDrawing, list: Value): Value {
  const pairs = readPairs(list);
  const self = pairs.find(([c]) => c === -1)?.[1];
  if (!(self instanceof Ename)) throw new LispError(`잘못된 인수 값: entmod 목록에 객체 이름(-1)이 없음: ${prin1(list)}`);
  const h = self.handle;
  const ctx: Apply = { layers: [] };
  const ops: EditOp[] = [];
  if (h.startsWith(VERTEX)) {
    const [ph, is] = h.slice(VERTEX.length).split(':');
    const p = d.doc.entityIndex.get(ph!);
    const i = Number(is);
    if (p?.type !== 'POLYLINE' || !p.vertices[i]) return null;
    const after = cloneEntity(p) as PolylineEntity;
    const vx = { ...after.vertices[i]! };
    for (const [c, v] of pairs) {
      if (c === 10) vx.location = pv(c, v);
      else if (c === 40) vx.startWidth = nv(c, v);
      else if (c === 41) vx.endWidth = nv(c, v);
      else if (c === 42) vx.bulge = nv(c, v);
    }
    after.vertices = after.vertices.map((x, j) => (j === i ? vx : x));
    const key = topKey(d, p.handle);
    if (!key) return null;
    d.commit([{ kind: 'modify', block: key, before: p, after }], 'ENTMOD');
    return list;
  }
  const e = d.doc.entityIndex.get(h);
  if (!e) {
    // 비도형 객체(사전·XRECORD)·표 기록(LAYER)
    if (objectOf(d.doc, h)) return modObject(d, h, pairs) ? list : null;
    return modLayer(it, d, h, pairs) ? list : null;
  }
  const type = pairs.find(([c]) => c === 0)?.[1];
  if (typeof type === 'string' && type.toUpperCase() !== dxfType(e)) throw new LispError(`잘못된 인수 값: 객체 형식을 바꿀 수 없음: ${prin1(type)}`);
  if (e.type === 'ATTRIB') {
    const ins = parentInsert(d, e as AttribEntity);
    const key = ins ? topKey(d, ins.handle) : null;
    if (!ins || !key) return null;
    const a = cloneEntity(e) as AttribEntity;
    try {
      applyGroups(d, a, pairs, ctx);
    } catch (err) {
      if (err instanceof LispError && !err.message.startsWith('잘못된 DXF')) return null;
      throw err;
    }
    if (!applyXData(d, a, pairs)) return null;
    const after = cloneEntity(ins);
    after.attribs = ins.attribs.map((x) => (x === e ? a : x));
    for (const l of ctx.layers) ops.push({ kind: 'layer', key: tableKey(l.name), before: null, after: l });
    ops.push({ kind: 'modify', block: key, before: ins, after });
    d.commit(ops, 'ENTMOD');
    return list;
  }
  const key = d.session.ownerOf(h);
  if (!key) return null;
  const after = cloneEntity(e);
  try {
    applyGroups(d, after, pairs, ctx);
  } catch (err) {
    if (err instanceof LispError && !err.message.startsWith('잘못된 DXF')) return null;
    throw err;
  }
  if (!applyXData(d, after, pairs)) return null;
  for (const l of ctx.layers) ops.push({ kind: 'layer', key: tableKey(l.name), before: null, after: l });
  ops.push({ kind: 'modify', block: key, before: e, after });
  d.commit(ops, 'ENTMOD');
  return list;
}

// --------------------------------------------------------------------------- entmake

/** INSERT (66 . 1) 다음 ATTRIB들을 받는 중 */
const pendingInserts = new WeakMap<object, { insert: InsertEntity; layers: Layer[] }>();

function blank(d: LispDrawing, type: string): Entity | null {
  const base = { ...entityDefaults(), layer: d.currentLayer() };
  const o: Vec3 = { x: 0, y: 0, z: 0 };
  const hv = (k: string) => d.doc.header.get(k);
  const textH = typeof hv('$TEXTSIZE') === 'number' ? (hv('$TEXTSIZE') as number) : 2.5;
  const style = typeof hv('$TEXTSTYLE') === 'string' ? (hv('$TEXTSTYLE') as string) : 'Standard';
  switch (type) {
    case 'LINE':
      return { ...base, type, start: { ...o }, end: { ...o } };
    case 'POINT':
      return { ...base, type, position: { ...o }, angle: 0 };
    case 'CIRCLE':
      return { ...base, type, center: { ...o }, radius: 1 };
    case 'ARC':
      return { ...base, type, center: { ...o }, radius: 1, startAngle: 0, endAngle: Math.PI };
    case 'ELLIPSE':
      return { ...base, type, center: { ...o }, majorAxis: { x: 1, y: 0, z: 0 }, ratio: 1, startParam: 0, endParam: Math.PI * 2 };
    case 'LWPOLYLINE':
      return { ...base, type, vertices: [], closed: false, plinegen: false, constantWidth: 0, elevation: 0 };
    case 'TEXT':
      return { ...base, type, insert: { ...o }, height: textH, text: '', rotation: 0, widthFactor: 1, oblique: 0, style, generation: 0, halign: 0, valign: 0 };
    case 'ATTRIB':
      return { ...base, type, insert: { ...o }, height: textH, text: '', rotation: 0, widthFactor: 1, oblique: 0, style, generation: 0, halign: 0, valign: 0, tag: '', attFlags: 0 } as AttribEntity;
    case 'MTEXT':
      return { ...base, type, insert: { ...o }, height: textH, width: 0, attachment: 1, drawingDirection: 1, text: '', style, rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 } as MTextEntity;
    case 'INSERT':
      return { ...base, type, block: '', insert: { ...o }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
    case 'XLINE':
    case 'RAY':
      return { ...base, type, base: { ...o }, direction: { x: 1, y: 0, z: 0 } };
    default:
      return null;
  }
}

const REQUIRED: Record<string, number[]> = {
  LINE: [10, 11],
  POINT: [10],
  CIRCLE: [10, 40],
  ARC: [10, 40, 50, 51],
  ELLIPSE: [10, 11, 40],
  LWPOLYLINE: [10],
  TEXT: [10, 1],
  ATTRIB: [10, 1, 2],
  MTEXT: [10, 1],
  INSERT: [2, 10],
  XLINE: [10, 11],
  RAY: [10, 11],
};

/** entmake: 만든 목록을 돌려준다. 만들 수 없으면 null. 비도형 객체(XRECORD·DICTIONARY)는 made에 핸들을 알린다 */
export function entmake(d: LispDrawing, list: Value, made?: (handle: string) => void): Value {
  if (list === null) {
    pendingInserts.delete(d.doc);
    return null;
  }
  const pairs = readPairs(list);
  const t = pairs.find(([c]) => c === 0)?.[1];
  if (typeof t !== 'string') throw bad(list);
  const type = t.toUpperCase();
  if (type === 'LAYER') return makeLayer(d, pairs) ? list : null;
  if (type === 'XRECORD' || type === 'DICTIONARY') {
    const h = makeObject(d, type, pairs);
    if (!h) return null;
    made?.(h);
    return list;
  }
  const pend = pendingInserts.get(d.doc);
  if (type === 'SEQEND') {
    if (!pend) return null;
    pendingInserts.delete(d.doc);
    commitNew(d, pend.insert, pend.layers);
    return list;
  }
  const need = REQUIRED[type];
  const e = blank(d, type);
  if (!e || !need || !need.every((c) => pairs.some(([k]) => k === c))) return null;
  const ctx: Apply = { layers: pend && type === 'ATTRIB' ? pend.layers : [] };
  try {
    applyGroups(d, e, pairs, ctx);
  } catch (err) {
    if (err instanceof LispError && !err.message.startsWith('잘못된 DXF')) return null;
    throw err;
  }
  if (type === 'LWPOLYLINE' && (e as { vertices: LwVertex[] }).vertices.length < 1) return null;
  if (!applyXData(d, e, pairs)) return null;
  e.handle = d.session.newHandle();
  if (type === 'ATTRIB') {
    if (!pend) return null;
    e.owner = pend.insert.handle;
    pend.insert.attribs.push(e as AttribEntity);
    return list;
  }
  if (pend) pendingInserts.delete(d.doc);
  if (type === 'INSERT' && pairs.some(([c, v]) => c === 66 && v === 1)) {
    pendingInserts.set(d.doc, { insert: e as InsertEntity, layers: ctx.layers });
    return list;
  }
  commitNew(d, e, ctx.layers);
  return list;
}

function commitNew(d: LispDrawing, e: Entity, layers: Layer[]): void {
  const block = d.doc.blocks.get(d.space);
  if (block?.recordHandle) e.owner = block.recordHandle;
  const ops: EditOp[] = layers.map((l) => ({ kind: 'layer' as const, key: tableKey(l.name), before: null, after: l }));
  ops.push({ kind: 'add', block: d.space, entity: e });
  d.commit(ops, 'ENTMAKE');
}

function makeLayer(d: LispDrawing, pairs: Pair[]): boolean {
  const get = (c: number) => pairs.find(([k]) => k === c)?.[1];
  const name = get(2);
  if (typeof name !== 'string' || !name.trim() || d.doc.layers.has(tableKey(name))) return false;
  const color = get(62);
  const flags = get(70);
  const lt = get(6);
  const lw = get(370);
  const f = typeof flags === 'number' ? flags : 0;
  const c = typeof color === 'number' ? color : 7;
  if (typeof lt === 'string' && !linetypeOk(d, lt)) return false;
  const layer = newLayer(d, name.trim(), {
    color: { aci: Math.abs(c) || 7 },
    off: c < 0,
    frozen: (f & 1) !== 0,
    locked: (f & 4) !== 0,
    linetype: typeof lt === 'string' ? lt : 'Continuous',
    lineweight: typeof lw === 'number' ? lw : -3,
    plot: get(290) !== 0,
  });
  d.commit([{ kind: 'layer', key: tableKey(layer.name), before: null, after: layer }], 'ENTMAKE');
  return true;
}

// --------------------------------------------------------------------------- entdel

const deleted = new WeakMap<object, Map<string, { block: string; entity: Entity; index: number }>>();

/** entdel: 지우거나(있으면) 이번 세션에 지운 것을 되살린다. 처리하지 못하면 false */
export function entdel(d: LispDrawing, h: string): boolean {
  let m = deleted.get(d.doc);
  if (!m) {
    m = new Map();
    deleted.set(d.doc, m);
  }
  const e = d.doc.entityIndex.get(h);
  if (e) {
    const key = topKey(d, h);
    if (!key) return false;
    const index = d.doc.blocks.get(key)!.entities.indexOf(e);
    m.set(h, { block: key, entity: e, index });
    d.commit([{ kind: 'remove', block: key, entity: e, index }], 'ENTDEL');
    return true;
  }
  const was = m.get(h);
  if (!was || !d.doc.blocks.has(was.block)) return false;
  m.delete(h);
  const len = d.doc.blocks.get(was.block)!.entities.length;
  d.commit([{ kind: 'add', block: was.block, entity: was.entity, index: Math.min(was.index, len) }], 'ENTDEL');
  return true;
}

// --------------------------------------------------------------------------- ssget 필터

type Node = { op: 'AND' | 'OR' | 'XOR' | 'NOT'; kids: Node[] } | { code: number; value: Value; rel: string | null };

function parseFilter(pairs: Pair[]): Node {
  const root: Node = { op: 'AND', kids: [] };
  const stack: { op: 'AND' | 'OR' | 'XOR' | 'NOT'; kids: Node[] }[] = [root];
  let rel: string | null = null;
  for (const [code, value] of pairs) {
    if (code === -4 && typeof value === 'string') {
      const v = value.trim().toUpperCase();
      const open = /^<(AND|OR|XOR|NOT)$/.exec(v);
      const close = /^(AND|OR|XOR|NOT)>$/.exec(v);
      if (open) {
        const n = { op: open[1] as 'AND', kids: [] };
        stack[stack.length - 1]!.kids.push(n);
        stack.push(n);
      } else if (close) {
        if (stack.length > 1) stack.pop();
      } else rel = v;
      continue;
    }
    stack[stack.length - 1]!.kids.push({ code, value, rel });
    rel = null;
  }
  return root;
}

function relTest(rel: string, a: number, b: number): boolean {
  switch (rel) {
    case '=':
      return a === b;
    case '!=':
    case '/=':
    case '<>':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '*':
      return true;
    case '&':
      return (a & b) !== 0;
    case '&=':
      return (a & b) === b;
    default:
      return a === b;
  }
}

/** 그룹 값 하나가 필터 값과 맞는가 */
function matchValue(rel: string | null, v: Value, want: Value): boolean {
  if (typeof want === 'string') return typeof v === 'string' && (rel === '!=' || rel === '/=' || rel === '<>' ? !wcmatch(v, want, true) : wcmatch(v, want, true));
  if (isNum(want)) return isNum(v) && relTest(rel ?? '=', numOf(v), numOf(want));
  const wp = toArray(want);
  const vp = toArray(v);
  if (wp && vp && wp.every(isNum) && vp.every(isNum)) {
    const rels = (rel ?? '=').split(',').map((s) => s.trim());
    return wp.every((w, i) => relTest(rels[Math.min(i, rels.length - 1)] ?? '=', numOf((vp[i] ?? 0) as number), numOf(w as number)));
  }
  if (want instanceof Ename) return v instanceof Ename && v.handle === want.handle;
  return false;
}

function evalNode(n: Node, groups: Pair[], xdataApps: string[]): boolean {
  if ('op' in n) {
    const r = n.kids.map((k) => evalNode(k, groups, xdataApps));
    if (n.op === 'AND') return r.every(Boolean);
    if (n.op === 'OR') return r.some(Boolean);
    if (n.op === 'XOR') return r.filter(Boolean).length === 1;
    return !r.every(Boolean);
  }
  if (n.code === -3) {
    // (-3 ("APP1") ("APP2")) 또는 (-3 "APP")
    const apps = (toArray(n.value) ?? [n.value]).map((a) => (a instanceof Cons ? a.car : a));
    return apps.every((a) => typeof a === 'string' && xdataApps.some((x) => wcmatch(x, a, true)));
  }
  let vals = groups.filter(([c]) => c === n.code).map(([, v]) => v);
  // 기본값이라 entget에 빠진 그룹
  if (!vals.length) {
    if (n.code === 62) vals = [256];
    else if (n.code === 6) vals = ['BYLAYER'];
    else if (n.code === 370) vals = [-1];
    else if (n.code === 67) vals = [0];
    else if (n.code === 60) vals = [0];
  }
  return vals.some((v) => matchValue(n.rel, v, n.value));
}

/** 필터 목록에 맞는 핸들만 */
export function filterHandles(it: Interp, d: LispDrawing, handles: string[], filter: Value): string[] {
  if (filter === null) return handles;
  const tree = parseFilter(readPairs(filter));
  return handles.filter((h) => {
    const g = entityGroups(it, d, h);
    if (!g) return false;
    const e = d.doc.entityIndex.get(h);
    const apps = (e?.xdata ?? []).map((x) => x.app);
    return evalNode(tree, g, apps);
  });
}
