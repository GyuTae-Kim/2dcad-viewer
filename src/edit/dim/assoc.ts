/**
 * 연관 치수(DIMASSOC): 치수 정의점과 형상 객체의 객체 스냅 점을 잇는 기록을 읽고 쓰고, 형상이 바뀌면 정의점을 다시 구한다.
 *
 * AutoCAD는 치수의 확장 사전 ACAD_DIMASSOC 항목에 DIMASSOC 객체를 두고, 연관된 형상 객체의 반응자(102 {ACAD_REACTORS 330)에
 * 그 DIMASSOC 핸들을 단다. DIMASSOC의 원본 태그(DXF 참조서 AcDbDimAssoc, ezdxf의 같은 정의로 확인):
 *
 *   100 AcDbDimAssoc, 330 치수 핸들, 90 연관 플래그(1·2·4·8 = 첫째~넷째 점 참조), 70 공간 넘김(trans-space),
 *   71 회전 치수 종류(0 모름, 1 평행, 2 직교)
 *   점 참조마다(플래그 비트 차례): 1 AcDbOsnapPointRef, 72 객체 스냅 종류, 331 주 객체(블록 안이면 바깥 참조부터 여럿),
 *   73 하위 객체 종류, 91 GS 표지, 301 외부 참조 객체 핸들(문자), 40 근처점 매개변수, 10·20·30 스냅 점(WCS),
 *   75 마지막 점 참조, 332 교차 객체, 74, 92, 302
 *
 * 스냅 종류(72): 0 없음, 1 끝점, 2 중간점, 3 중심, 4 노드, 5 사분점, 6 교차점, 7 삽입점, 8 직교, 9 접점, 10 근처점,
 * 11 가상 교차점, 12 평행, 13 시작점.
 *
 * 점 참조 번호와 정의점(AcDbDimAssoc::PointType):
 *   회전·정렬 치수 0 = 13, 1 = 14 / 두 선 각도 0 = 13, 1 = 14, 2 = 15, 3 = 10 / 3점 각도·호 길이 0 = 13, 1 = 14, 2 = 15(정점)
 *   반지름 0 = 15(현 위 점), 1 = 10(중심) / 지름 0 = 15, 1 = 10(반대쪽 현 위 점) / 꺾기 반지름 0 = 15, 1 = 10, 2 = 13, 3 = 14
 *   세로좌표 0 = 10(원점), 1 = 13(피쳐 위치)
 *
 * 근처점 매개변수(40)는 AcDbCurve 매개변수다: 선은 시작점에서의 거리, 원·호는 OCS 각도(라디안), 타원은 타원 매개변수,
 * 폴리선은 세그먼트 번호 + 비율, 스플라인은 매듭 값, 무한선은 기준점에서의 거리.
 * 폴리선의 GS 표지는 세그먼트 번호 + 1로 쓴다(하위 객체 종류 2 = 모서리).
 *
 * 이 모듈은 문서를 바꾸지 않는다. 바뀔 객체(사전·DIMASSOC·반응자·치수)를 돌려주면 부르는 쪽이 편집 작업으로 적용한다.
 */
import type { CadDocument, CadObject, DictionaryObject, DimensionEntity, Entity, GenericObject, RawTag, Vec2, Vec3 } from '../../core/model';
import { type Piece, pieceAt, pieceNearest } from '../geom/curve';
import { ocsToWcs, wcsToOcs } from '../geom/ocs';
import { entityPath, segOf } from '../geom/path';
import { insertionPoint, intersections } from '../geom/query';
import { generateDimensionGeometry } from './generate';
import { type P, add, ccw, cross, dir, dist, dot, intersect, madd, mid, perp, sub, unit } from './vec';

// ---------------------------------------------------------------------------
// 기록
// ---------------------------------------------------------------------------

/** 객체 스냅 종류(DIMASSOC 72) */
export const OSNAP = {
  NONE: 0,
  END: 1,
  MID: 2,
  CEN: 3,
  NODE: 4,
  QUAD: 5,
  INT: 6,
  INS: 7,
  PERP: 8,
  TAN: 9,
  NEAR: 10,
  APPINT: 11,
  PAR: 12,
  START: 13,
} as const;

/** 확장 사전 항목 이름 */
export const DIMASSOC_KEY = 'ACAD_DIMASSOC';

/** 점 참조(AcDbOsnapPointRef) */
export interface PointRef {
  /** 72 객체 스냅 종류 */
  osnap: number;
  /** 331 주 객체 경로(바깥 블록 참조 → 안쪽 객체). 보통 하나 */
  ids: string[];
  /** 73 하위 객체 종류(0 없음, 2 모서리) */
  subent: number;
  /** 91 GS 표지(폴리선 = 세그먼트 번호 + 1) */
  gsMarker: number;
  /** 301 외부 참조 객체 핸들 */
  xref?: string;
  /** 40 근처점 매개변수 */
  param: number;
  /** 10 스냅 점(WCS, 마지막으로 구한 자리) */
  point: Vec3;
  /** 75 마지막 점 참조 */
  lastPointRef: boolean;
  /** 332 교차 객체 경로 */
  ids2?: string[];
  subent2?: number;
  gsMarker2?: number;
  xref2?: string;
}

/** DIMASSOC 객체의 내용 */
export interface DimAssocData {
  /** 330 치수 핸들 */
  dimension: string;
  /** 70 공간 넘김 연관(배치 치수 ↔ 모형 객체) */
  transSpace: boolean;
  /** 71 회전 치수 종류 */
  rotatedType: number;
  /** 점 참조(번호 = 플래그 비트 차례, 없으면 null). 길이 4 */
  refs: (PointRef | null)[];
}

const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const hstr = (v: string | number | undefined): string => String(v ?? '').trim().toUpperCase().replace(/^0+(?=.)/, '');

/** 연관 플래그 */
export function assocFlags(data: DimAssocData): number {
  let f = 0;
  data.refs.forEach((r, i) => {
    if (r) f |= 1 << i;
  });
  return f;
}

/** DIMASSOC 원본 태그 → 내용. AcDbDimAssoc가 아니면 null */
export function parseDimAssoc(raw: readonly RawTag[] | undefined): DimAssocData | null {
  if (!raw?.length) return null;
  let i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbDimAssoc');
  if (i < 0) i = -1;
  const data: DimAssocData = { dimension: '', transSpace: false, rotatedType: 0, refs: [null, null, null, null] };
  let flags = 0;
  const groups: PointRef[] = [];
  let cur: PointRef | null = null;
  let px = 0;
  let py = 0;
  let pz = 0;
  const flushPoint = () => {
    if (cur) cur.point = { x: px, y: py, z: pz };
  };
  for (let k = i + 1; k < raw.length; k++) {
    const { code, value } = raw[k]!;
    if (code === 1) {
      flushPoint();
      cur = { osnap: 0, ids: [], subent: 0, gsMarker: 0, param: 0, point: { x: 0, y: 0, z: 0 }, lastPointRef: false };
      px = py = pz = 0;
      groups.push(cur);
      continue;
    }
    if (code === 100) break;
    if (!cur) {
      if (code === 330) data.dimension = hstr(value);
      else if (code === 90) flags = num(value);
      else if (code === 70) data.transSpace = num(value) !== 0;
      else if (code === 71) data.rotatedType = num(value);
      continue;
    }
    switch (code) {
      case 72:
        cur.osnap = num(value);
        break;
      case 331:
        cur.ids.push(hstr(value));
        break;
      case 73:
        cur.subent = num(value);
        break;
      case 91:
        cur.gsMarker = num(value);
        break;
      case 301:
        cur.xref = String(value);
        break;
      case 40:
        cur.param = num(value);
        break;
      case 10:
        px = num(value);
        break;
      case 20:
        py = num(value);
        break;
      case 30:
        pz = num(value);
        break;
      case 75:
        cur.lastPointRef = num(value) !== 0;
        break;
      case 332:
        (cur.ids2 ??= []).push(hstr(value));
        break;
      case 74:
        cur.subent2 = num(value);
        break;
      case 92:
        cur.gsMarker2 = num(value);
        break;
      case 302:
        cur.xref2 = String(value);
        break;
    }
  }
  flushPoint();
  // 참조를 플래그 비트 차례로 둔다(플래그가 모자라면 앞에서부터)
  const bits = [0, 1, 2, 3].filter((b) => flags & (1 << b));
  groups.forEach((g, n) => {
    if (g.ids2 && !g.ids2.some((h) => h && h !== '0')) delete g.ids2;
    g.ids = g.ids.filter((h) => h && h !== '0');
    const b = bits[n] ?? data.refs.findIndex((r, j) => !r && !bits.includes(j));
    if (b >= 0 && b < 4 && g.ids.length) data.refs[b] = g;
  });
  return data;
}

/** 내용 → DIMASSOC 원본 태그(DXF 리더가 남기는 꼴: 100부터) */
export function dimAssocRaw(data: DimAssocData): RawTag[] {
  const t: RawTag[] = [
    { code: 100, value: 'AcDbDimAssoc' },
    { code: 330, value: data.dimension },
    { code: 90, value: assocFlags(data) },
    { code: 70, value: data.transSpace ? 1 : 0 },
    { code: 71, value: data.rotatedType },
  ];
  for (const r of data.refs) {
    if (!r) continue;
    t.push({ code: 1, value: 'AcDbOsnapPointRef' }, { code: 72, value: r.osnap });
    for (const h of r.ids) t.push({ code: 331, value: h });
    t.push({ code: 73, value: r.subent }, { code: 91, value: r.gsMarker });
    if (r.xref) t.push({ code: 301, value: r.xref });
    t.push({ code: 40, value: r.param }, { code: 10, value: r.point.x }, { code: 20, value: r.point.y }, { code: 30, value: r.point.z });
    t.push({ code: 75, value: r.lastPointRef ? 1 : 0 });
    if (r.ids2?.length) {
      for (const h of r.ids2) t.push({ code: 332, value: h });
      t.push({ code: 74, value: r.subent2 ?? 0 }, { code: 92, value: r.gsMarker2 ?? 0 });
      if (r.xref2) t.push({ code: 302, value: r.xref2 });
    }
  }
  return t;
}

/** 치수의 DIMASSOC(확장 사전 → ACAD_DIMASSOC) */
export function dimAssocOf(doc: CadDocument, dim: { xdict?: string }): { dict: DictionaryObject; obj: GenericObject; data: DimAssocData } | null {
  if (!dim.xdict) return null;
  const dict = doc.objects.get(dim.xdict);
  if (!dict || (dict.type !== 'DICTIONARY' && dict.type !== 'ACDBDICTIONARYWDFLT')) return null;
  const h = (dict as DictionaryObject).entries.get(DIMASSOC_KEY);
  const obj = h ? doc.objects.get(h) : undefined;
  if (!obj || obj.type !== 'DIMASSOC') return null;
  const data = parseDimAssoc((obj as GenericObject).raw);
  if (!data) return null;
  return { dict: dict as DictionaryObject, obj: obj as GenericObject, data };
}

/** 참조 하나라도 있으면 연관 치수 */
export function isAssociative(doc: CadDocument, dim: { xdict?: string }): boolean {
  return !!dimAssocOf(doc, dim)?.data.refs.some((r) => r);
}

/** 객체 반응자에 걸린 DIMASSOC 핸들들 */
export function assocReactors(doc: CadDocument, e: { reactors?: string[] }): string[] {
  return (e.reactors ?? []).filter((r) => doc.objects.get(r)?.type === 'DIMASSOC');
}

/** 형상 객체에 연관된 치수 핸들(반응자 → DIMASSOC → 치수) */
export function associatedDimensions(doc: CadDocument, e: Entity): string[] {
  const out: string[] = [];
  for (const r of assocReactors(doc, e)) {
    const data = parseDimAssoc((doc.objects.get(r) as GenericObject).raw);
    if (data?.dimension && !out.includes(data.dimension) && data.refs.some((x) => x && (x.ids.includes(e.handle) || x.ids2?.includes(e.handle)))) out.push(data.dimension);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 치수 종류별 정의점
// ---------------------------------------------------------------------------

export type DefKey = 'defPoint' | 'defPoint2' | 'defPoint3' | 'defPoint4';

/** 점 참조 번호 → 정의점(번호가 없으면 undefined) */
export function assocKeys(d: DimensionEntity): (DefKey | undefined)[] {
  if (d.subtype === 'ARC_DIMENSION') return ['defPoint2', 'defPoint3', 'defPoint4'];
  if (d.subtype === 'LARGE_RADIAL_DIMENSION') return ['defPoint4', 'defPoint', 'defPoint2', 'defPoint3'];
  switch (d.dimType & 7) {
    case 0:
    case 1:
      return ['defPoint2', 'defPoint3'];
    case 2:
      return ['defPoint2', 'defPoint3', 'defPoint4', 'defPoint'];
    case 5:
      return ['defPoint2', 'defPoint3', 'defPoint4'];
    case 3:
    case 4:
      return ['defPoint4', 'defPoint'];
    case 6:
      return ['defPoint', 'defPoint2'];
    default:
      return [];
  }
}

/** 측정을 정하는 정의점(모두 같은 만큼 옮겨지면 치수 전체를 옮긴다) */
function measureKeys(d: DimensionEntity): DefKey[] {
  if (d.subtype === 'ARC_DIMENSION') return ['defPoint2', 'defPoint3', 'defPoint4'];
  if (d.subtype === 'LARGE_RADIAL_DIMENSION') return ['defPoint4', 'defPoint'];
  switch (d.dimType & 7) {
    case 0:
    case 1:
      return ['defPoint2', 'defPoint3'];
    case 2:
      return ['defPoint2', 'defPoint3', 'defPoint4', 'defPoint'];
    case 5:
      return ['defPoint2', 'defPoint3', 'defPoint4'];
    case 3:
    case 4:
      return ['defPoint4', 'defPoint'];
    case 6:
      return ['defPoint2'];
    default:
      return [];
  }
}

const xy = (q: { x: number; y: number }): P => ({ x: q.x, y: q.y });

/** 좌표 크기에 맞춘 허용 오차 */
export function tolFor(...ps: { x: number; y: number }[]): number {
  let m = 1;
  for (const q of ps) m = Math.max(m, Math.abs(q.x), Math.abs(q.y));
  return 1e-7 * m;
}

// ---------------------------------------------------------------------------
// 객체 스냅 점(종류별, 객체 안에서 정해진 이름을 가진다)
// ---------------------------------------------------------------------------

interface Cand {
  /** 객체 안 이름(v3 = 꼭짓점 3, m2 = 세그먼트 2 중간점, c0 = 중심, q1 = 사분점 1 …) */
  id: string;
  p: P;
  /** 이 점이 닿는 폴리선 세그먼트 번호들 */
  segs: number[];
}

const POLY = new Set(['LWPOLYLINE', 'POLYLINE']);

function pathPieces(e: Entity): { pieces: Piece[]; closed: boolean } | null {
  try {
    const path = entityPath(e);
    return path && path.pieces.length ? path : null;
  } catch {
    return null;
  }
}

function fullCurve(e: Entity): boolean {
  if (e.type === 'CIRCLE') return true;
  if (e.type === 'ELLIPSE') return Math.abs(e.endParam - e.startParam - Math.PI * 2) < 1e-9 || Math.abs(e.endParam - e.startParam) < 1e-12;
  return false;
}

/** 객체의 스냅 점(종류 osnap). 시작점은 첫 끝점 */
function candidates(e: Entity, osnap: number): Cand[] {
  const out: Cand[] = [];
  const push = (id: string, p: { x: number; y: number }, seg?: number) => {
    const c = out.find((x) => x.id === id);
    if (c) {
      if (seg !== undefined && !c.segs.includes(seg)) c.segs.push(seg);
      return;
    }
    out.push({ id, p: xy(p), segs: seg === undefined ? [] : [seg] });
  };
  switch (osnap) {
    case OSNAP.END:
    case OSNAP.START: {
      if (e.type === 'SOLID' || e.type === 'TRACE') e.points.forEach((q, i) => push(`v${i}`, ocsToWcs(q, e.extrusion)));
      else if (e.type === '3DFACE') e.points.forEach((q, i) => push(`v${i}`, q));
      else if (e.type === 'LEADER') e.vertices.forEach((q, i) => push(`v${i}`, q));
      else if (!fullCurve(e)) {
        const path = pathPieces(e);
        if (!path || (e.type === 'SPLINE' && path.closed)) return out;
        const nv = e.type === 'LWPOLYLINE' ? e.vertices.length : e.type === 'POLYLINE' ? e.vertices.filter((v) => !(v.flags & 16)).length : 2;
        const poly = POLY.has(e.type);
        path.pieces.forEach((pc, k) => {
          const s = segOf(pc) ?? k;
          push(`v${s}`, pieceAt(pc, 0), poly ? s : undefined);
          push(s + 1 >= nv && path.closed ? 'v0' : `v${s + 1}`, pieceAt(pc, 1), poly ? s : undefined);
        });
      }
      return osnap === OSNAP.START ? out.slice(0, 1) : out;
    }
    case OSNAP.MID: {
      const path = pathPieces(e);
      if (!path || fullCurve(e)) return out;
      path.pieces.forEach((pc, k) => {
        if (pc.k === 'nurbs' || (pc.k === 'line' && (pc.inf0 || pc.inf1))) return;
        const s = segOf(pc) ?? k;
        push(`m${s}`, pieceAt(pc, 0.5), POLY.has(e.type) ? s : undefined);
      });
      return out;
    }
    case OSNAP.CEN: {
      const path = pathPieces(e);
      if (!path) return out;
      path.pieces.forEach((pc, k) => {
        if (pc.k !== 'arc' && pc.k !== 'ell') return;
        const s = segOf(pc) ?? k;
        push(`c${s}`, pc.c, POLY.has(e.type) ? s : undefined);
      });
      return out;
    }
    case OSNAP.QUAD: {
      if (e.type !== 'CIRCLE' && e.type !== 'ARC' && e.type !== 'ELLIPSE') return out;
      const pc = pathPieces(e)?.pieces[0];
      if (!pc) return out;
      const full = fullCurve(e);
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        if (pc.k === 'arc') {
          const inside = full || (pc.sw >= 0 ? ccw(pc.a0, a) <= pc.sw + 1e-9 : ccw(a, pc.a0) <= -pc.sw + 1e-9);
          if (inside) push(`q${k}`, madd(pc.c, dir(a), pc.r));
        } else if (pc.k === 'ell') {
          const inside = full || (pc.dt >= 0 ? ccw(pc.t0, a) <= pc.dt + 1e-9 : ccw(a, pc.t0) <= -pc.dt + 1e-9);
          if (inside) push(`q${k}`, add(pc.c, add({ x: pc.u.x * Math.cos(a), y: pc.u.y * Math.cos(a) }, { x: pc.v.x * Math.sin(a), y: pc.v.y * Math.sin(a) })));
        }
      }
      return out;
    }
    case OSNAP.NODE: {
      if (e.type === 'POINT') push('n', e.position);
      else if (e.type === 'SPLINE') e.fitPoints.forEach((f, i) => push(`n${i}`, f));
      return out;
    }
    case OSNAP.INS: {
      if (e.type === 'MTEXT') push('i', e.insert);
      else if (e.type === 'INSERT' || e.type === 'TEXT' || e.type === 'ATTDEF' || e.type === 'ATTRIB' || e.type === 'SHAPE' || e.type === 'TOLERANCE') {
        const q = insertionPoint(e);
        if (q) push('i', q);
      }
      return out;
    }
    default:
      return out;
  }
}

/** 폴리선 GS 표지에 맞는 후보만(표지가 없거나 맞는 것이 없으면 전부) */
function bySegment(e: Entity, cs: Cand[], gs: number): Cand[] {
  if (!POLY.has(e.type) || !(gs > 0)) return cs;
  const s = gs - 1;
  const f = cs.filter((c) => c.segs.includes(s));
  return f.length ? f : cs;
}

function nearestCand(cs: readonly Cand[], q: P): Cand | null {
  let best: Cand | null = null;
  let bd = Infinity;
  for (const c of cs) {
    const d = dist(c.p, q);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** 형상 객체로 쓸 수 있는 종류(치수·해치·문자 아닌 곡선, 점, 블록 참조·문자의 삽입점) */
export function isAssocGeometry(e: Entity): boolean {
  switch (e.type) {
    case 'LINE':
    case 'ARC':
    case 'CIRCLE':
    case 'ELLIPSE':
    case 'LWPOLYLINE':
    case 'POLYLINE':
    case 'SPLINE':
    case 'XLINE':
    case 'RAY':
    case 'POINT':
    case 'INSERT':
    case 'TEXT':
    case 'MTEXT':
    case 'ATTDEF':
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
    case 'LEADER':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 곡선 매개변수(근처점)
// ---------------------------------------------------------------------------

/** q에 가장 가까운 곡선 위 점과 AcDbCurve 매개변수. 곡선이 아니면 null */
export function curveParam(e: Entity, q: P): { p: P; param: number; d: number; seg?: number } | null {
  switch (e.type) {
    case 'LINE': {
      const a = xy(e.start);
      const b = xy(e.end);
      const L = dist(a, b);
      if (L < 1e-15) return { p: a, param: 0, d: dist(a, q) };
      const u = unit(sub(b, a));
      const t = Math.max(0, Math.min(L, dot(sub(q, a), u)));
      const p = madd(a, u, t);
      return { p, param: t, d: dist(p, q) };
    }
    case 'XLINE':
    case 'RAY': {
      const a = xy(e.base);
      const u = unit(xy(e.direction));
      let t = dot(sub(q, a), u);
      if (e.type === 'RAY') t = Math.max(0, t);
      const p = madd(a, u, t);
      return { p, param: t, d: dist(p, q) };
    }
    case 'CIRCLE':
    case 'ARC': {
      const pc = pathPieces(e)?.pieces[0];
      if (!pc) return null;
      const near = pieceNearest(pc, q, e.type === 'ARC');
      const o = wcsToOcs({ x: near.p.x, y: near.p.y, z: 0 }, e.extrusion);
      let a = Math.atan2(o.y - e.center.y, o.x - e.center.x);
      if (a < 0) a += Math.PI * 2;
      return { p: near.p, param: a, d: near.d };
    }
    case 'ELLIPSE': {
      const pc = pathPieces(e)?.pieces[0];
      if (!pc || pc.k !== 'ell') return null;
      const near = pieceNearest(pc, q, !fullCurve(e));
      return { p: near.p, param: pc.t0 + pc.dt * near.t, d: near.d };
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const path = pathPieces(e);
      if (!path) return null;
      let best: { p: P; param: number; d: number; seg?: number } | null = null;
      path.pieces.forEach((pc, k) => {
        const n = pieceNearest(pc, q, true);
        const s = segOf(pc) ?? k;
        if (!best || n.d < best.d - 1e-12) best = { p: n.p, param: s + n.t, d: n.d, seg: s };
      });
      return best;
    }
    case 'SPLINE': {
      const pc = pathPieces(e)?.pieces[0];
      if (!pc || pc.k !== 'nurbs') return null;
      const n = pieceNearest(pc, q, true);
      return { p: n.p, param: pc.u0 + (pc.u1 - pc.u0) * n.t, d: n.d };
    }
    default:
      return null;
  }
}

/** AcDbCurve 매개변수의 점. 곡선이 아니거나 정의역 밖이면 가까운 끝 */
export function pointAtParam(e: Entity, param: number): P | null {
  switch (e.type) {
    case 'LINE': {
      const a = xy(e.start);
      const b = xy(e.end);
      const L = dist(a, b);
      if (L < 1e-15) return a;
      return madd(a, unit(sub(b, a)), Math.max(0, Math.min(L, param)));
    }
    case 'XLINE':
    case 'RAY':
      return madd(xy(e.base), unit(xy(e.direction)), e.type === 'RAY' ? Math.max(0, param) : param);
    case 'CIRCLE':
    case 'ARC': {
      // 호 밖의 매개변수도 원 위에서 구한다(지름 치수의 반대쪽 점)
      const o = { x: e.center.x + e.radius * Math.cos(param), y: e.center.y + e.radius * Math.sin(param), z: e.center.z };
      return xy(ocsToWcs(o, e.extrusion));
    }
    case 'ELLIPSE': {
      const pc = pathPieces(e)?.pieces[0];
      if (!pc || pc.k !== 'ell') return null;
      return add(pc.c, add({ x: pc.u.x * Math.cos(param), y: pc.u.y * Math.cos(param) }, { x: pc.v.x * Math.sin(param), y: pc.v.y * Math.sin(param) }));
    }
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const path = pathPieces(e);
      if (!path) return null;
      const s = Math.floor(param);
      let pc = path.pieces.find((x, k) => (segOf(x) ?? k) === s);
      let t = param - s;
      if (!pc) {
        // 마지막 꼭짓점(매개변수 = 세그먼트 수) 또는 범위 밖
        if (param <= 0) {
          pc = path.pieces[0]!;
          t = 0;
        } else {
          pc = path.pieces[path.pieces.length - 1]!;
          t = 1;
        }
      }
      return pieceAt(pc, Math.max(0, Math.min(1, t)));
    }
    case 'SPLINE': {
      const pc = pathPieces(e)?.pieces[0];
      if (!pc || pc.k !== 'nurbs') return null;
      const span = pc.u1 - pc.u0;
      return pieceAt(pc, span ? Math.max(0, Math.min(1, (param - pc.u0) / span)) : 0);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 점 참조 만들기
// ---------------------------------------------------------------------------

function makeRef(e: Entity, osnap: number, p: P, seg?: number, param = 0, e2?: Entity, seg2?: number): PointRef {
  const edge = (x: Entity, s?: number) => POLY.has(x.type) && s !== undefined;
  const r: PointRef = {
    osnap,
    ids: [e.handle],
    subent: edge(e, seg) ? 2 : 0,
    gsMarker: edge(e, seg) ? seg! + 1 : 0,
    param,
    point: { x: p.x, y: p.y, z: 0 },
    lastPointRef: false,
  };
  if (e2) {
    r.ids2 = [e2.handle];
    r.subent2 = edge(e2, seg2) ? 2 : 0;
    r.gsMarker2 = edge(e2, seg2) ? seg2! + 1 : 0;
  }
  return r;
}

/** 근처점 참조(곡선 위 tol 안). 직교·접점·근처점 스냅은 이것으로 둔다 */
export function nearRef(e: Entity, q: P, tol: number): PointRef | null {
  const c = curveParam(e, q);
  if (!c || c.d > tol) return null;
  return makeRef(e, OSNAP.NEAR, c.p, c.seg, c.param);
}

/** 원·호의 원 위 점 근처점 참조(호 밖이라도 원 위로 — 반지름·지름 치수의 현 위 점) */
export function circlePointRef(e: Entity, q: P): PointRef | null {
  if (e.type !== 'CIRCLE' && e.type !== 'ARC') return null;
  const pc = pathPieces(e)?.pieces[0];
  if (!pc || pc.k !== 'arc') return null;
  const u = unit(sub(q, pc.c));
  const p = madd(pc.c, u, pc.r);
  const o = wcsToOcs({ x: p.x, y: p.y, z: 0 }, e.extrusion);
  let a = Math.atan2(o.y - e.center.y, o.x - e.center.x);
  if (a < 0) a += Math.PI * 2;
  return makeRef(e, OSNAP.NEAR, p, undefined, a);
}

/** 교차점 참조(두 객체가 q에서 만날 때) */
export function intersectionRef(doc: CadDocument, a: Entity, b: Entity, q: P, tol: number): PointRef | null {
  if (a === b || a.handle === b.handle) return null;
  let pts: Vec2[] = [];
  try {
    pts = intersections(a, b, doc);
  } catch {
    return null;
  }
  let best: Vec2 | null = null;
  for (const x of pts) if (dist(x, q) <= tol && (!best || dist(x, q) < dist(best, q))) best = x;
  if (!best) return null;
  const sa = POLY.has(a.type) ? curveParam(a, best)?.seg : undefined;
  const sb = POLY.has(b.type) ? curveParam(b, best)?.seg : undefined;
  return makeRef(a, OSNAP.INT, best, sa, 0, b, sb);
}

/**
 * 객체의 스냅 점 참조: e에서 종류 osnap의 스냅 점이 q(tol 안)에 있으면 참조를, 없으면 null.
 * 근처점·직교·접점은 곡선 위 점이면 근처점 참조, 교차점은 e2와의 교점.
 */
export function snapRef(doc: CadDocument, e: Entity, osnap: number, q: P, tol: number, e2?: Entity): PointRef | null {
  if (!isAssocGeometry(e)) return null;
  if (osnap === OSNAP.NEAR || osnap === OSNAP.PERP || osnap === OSNAP.TAN || osnap === OSNAP.PAR) return nearRef(e, q, tol);
  if (osnap === OSNAP.INT || osnap === OSNAP.APPINT) return e2 ? intersectionRef(doc, e, e2, q, tol) : null;
  const c = nearestCand(candidates(e, osnap), q);
  if (!c || dist(c.p, q) > tol) return null;
  return makeRef(e, osnap === OSNAP.START ? OSNAP.END : osnap, c.p, c.segs[0]);
}

/** 기본 찾기 차례: 끝점 → 교차점 → 중심 → 중간점 → 사분점 → 노드 → 삽입점 */
export const DEFAULT_ORDER: readonly number[] = [OSNAP.END, OSNAP.INT, OSNAP.CEN, OSNAP.MID, OSNAP.QUAD, OSNAP.NODE, OSNAP.INS];

/**
 * 점 q에 스냅 점이 있는 객체를 찾아 참조를 만든다(객체 스냅 정보가 없을 때 정의점 자리로 찾기).
 * kinds 차례대로 찾고, nearTol이 있으면 마지막에 곡선 위 점을 근처점으로 잇는다.
 */
export function findRefAt(doc: CadDocument, cands: readonly Entity[], q: P, opt: { tol: number; kinds?: readonly number[]; nearTol?: number }): PointRef | null {
  const list = cands.filter(isAssocGeometry);
  for (const kind of opt.kinds ?? DEFAULT_ORDER) {
    if (kind === OSNAP.INT || kind === OSNAP.APPINT) {
      const curves = list.filter((e) => curveParam(e, q) && curveParam(e, q)!.d <= opt.tol);
      for (let i = 0; i < curves.length; i++)
        for (let j = i + 1; j < curves.length; j++) {
          const r = intersectionRef(doc, curves[i]!, curves[j]!, q, opt.tol);
          if (r) return r;
        }
      continue;
    }
    if (kind === OSNAP.NEAR || kind === OSNAP.PERP || kind === OSNAP.TAN) {
      const r = bestNear(list, q, opt.nearTol ?? opt.tol);
      if (r) return r;
      continue;
    }
    let best: PointRef | null = null;
    let bd = Infinity;
    for (const e of list) {
      const r = snapRef(doc, e, kind, q, opt.tol);
      if (r && dist(r.point, q) < bd) {
        bd = dist(r.point, q);
        best = r;
      }
    }
    if (best) return best;
  }
  if (opt.nearTol !== undefined) return bestNear(list, q, opt.nearTol);
  return null;
}

function bestNear(list: readonly Entity[], q: P, tol: number): PointRef | null {
  let best: PointRef | null = null;
  let bd = Infinity;
  for (const e of list) {
    const c = curveParam(e, q);
    if (c && c.d <= tol && c.d < bd) {
      bd = c.d;
      best = makeRef(e, OSNAP.NEAR, c.p, c.seg, c.param);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 점 참조 풀기(형상 → 정의점)
// ---------------------------------------------------------------------------

export interface ResolveContext {
  doc: CadDocument;
  /** 지금(편집 뒤) 객체. 없으면 지워진 것 */
  get(h: string): Entity | undefined;
  /** 편집 전 객체(바뀌지 않았으면 get과 같다) */
  before(h: string): Entity | undefined;
}

/** 객체의 기준점(편집 전후 이동량을 어림한다) */
function anchor(e: Entity): P | null {
  for (const k of [OSNAP.CEN, OSNAP.END, OSNAP.INS, OSNAP.NODE]) {
    const c = candidates(e, k)[0];
    if (c) return c.p;
  }
  const path = pathPieces(e);
  return path ? pieceAt(path.pieces[0]!, 0) : null;
}

function shiftOf(was: Entity | undefined, now: Entity | undefined): P {
  if (!was || !now || was === now) return { x: 0, y: 0 };
  const a = anchor(was);
  const b = anchor(now);
  return a && b ? sub(b, a) : { x: 0, y: 0 };
}

/** 참조가 따라갈 수 있는 것인지(블록 안 객체·외부 참조·공간 넘김은 읽어 두기만 한다) */
export function followable(r: PointRef): boolean {
  return r.ids.length === 1 && !r.xref && (!r.ids2 || r.ids2.length === 1) && !r.xref2;
}

/**
 * 점 참조의 지금 자리. hint는 바뀌기 전 자리(치수 정의점 또는 기록된 스냅 점)다.
 * 편집 전 객체에서 hint에 맞는 스냅 점의 이름을 찾고, 편집 뒤 객체의 같은 이름 점을 쓴다. 풀 수 없으면 null.
 * predict가 있으면(이동·회전·축척·대칭처럼 변환을 알 때 hint를 옮긴 자리) 편집 뒤 객체에서 그 자리에 가장 가까운
 * 같은 종류의 스냅 점을 쓴다(대칭한 호처럼 끝점 차례가 바뀌어도 맞는다).
 */
export function resolveRef(ctx: ResolveContext, r: PointRef, hint: P, predict?: P): P | null {
  if (!followable(r)) return null;
  const h = r.ids[0]!;
  const now = ctx.get(h);
  if (!now) return null;
  const was = ctx.before(h) ?? now;
  switch (r.osnap) {
    case OSNAP.INT:
    case OSNAP.APPINT: {
      const h2 = r.ids2?.[0];
      const now2 = h2 ? ctx.get(h2) : undefined;
      if (h2 && !now2) return null;
      let sh = shiftOf(was, now);
      if (now2 && sh.x === 0 && sh.y === 0) sh = shiftOf(ctx.before(h2!) ?? now2, now2);
      const target = predict ?? add(hint, sh);
      if (!now2) return curveParam(now, target)?.p ?? null;
      let pts: Vec2[] = [];
      try {
        pts = intersections(now, now2, ctx.doc);
      } catch {
        return null;
      }
      let best: Vec2 | null = null;
      for (const x of pts) if (!best || dist(x, target) < dist(best, target)) best = x;
      return best ? xy(best) : null;
    }
    case OSNAP.NEAR:
    case OSNAP.PERP:
    case OSNAP.TAN:
    case OSNAP.PAR: {
      if (predict) return curveParam(now, predict)?.p ?? null;
      if (r.osnap === OSNAP.NEAR && Number.isFinite(r.param)) {
        // 같은 매개변수의 점(선은 시작점에서 같은 거리, 원·호는 같은 각도)
        const p = pointAtParam(now, r.param);
        if (p) return p;
      }
      return curveParam(now, add(hint, shiftOf(was, now)))?.p ?? null;
    }
    default: {
      const kind = r.osnap === OSNAP.START ? OSNAP.END : r.osnap;
      const before = bySegment(was, candidates(was, kind), r.gsMarker);
      const after = bySegment(now, candidates(now, kind), r.gsMarker);
      if (!after.length) return null;
      if (predict) return nearestCand(after, predict)!.p;
      const id = nearestCand(before, hint)?.id;
      const same = id ? after.find((c) => c.id === id) : undefined;
      return (same ?? nearestCand(after, add(hint, shiftOf(was, now))))!.p;
    }
  }
}

// ---------------------------------------------------------------------------
// 정의점이 옮겨진 치수
// ---------------------------------------------------------------------------

/** 치수 종류가 쓰는 정의점(옮길 때 쓰지 않는 0 값은 그대로 둔다) */
function usedKeys(d: DimensionEntity): ('defPoint' | 'defPoint2' | 'defPoint3' | 'defPoint4' | 'defPoint5')[] {
  if (d.subtype === 'ARC_DIMENSION' || d.subtype === 'LARGE_RADIAL_DIMENSION') return ['defPoint', 'defPoint2', 'defPoint3', 'defPoint4'];
  switch (d.dimType & 7) {
    case 0:
    case 1:
      return ['defPoint', 'defPoint2', 'defPoint3'];
    case 2:
      return ['defPoint', 'defPoint2', 'defPoint3', 'defPoint4', 'defPoint5'];
    case 5:
      return ['defPoint', 'defPoint2', 'defPoint3', 'defPoint4'];
    case 3:
    case 4:
      return ['defPoint', 'defPoint4'];
    case 6:
      return ['defPoint2', 'defPoint3'];
    default:
      return ['defPoint', 'defPoint2', 'defPoint3', 'defPoint4', 'defPoint5'];
  }
}

/** 치수 전체를 d만큼(세로좌표 원점은 두고) */
function translateDim(r: DimensionEntity, src: DimensionEntity, d: P): void {
  const mv = (q: Vec3): Vec3 => ({ x: q.x + d.x, y: q.y + d.y, z: q.z });
  for (const k of usedKeys(src)) r[k] = mv(src[k]);
  r.textMid = mv(src.textMid);
  if (src.insertPoint) r.insertPoint = mv(src.insertPoint);
  if (src.arc) {
    r.arc = { ...src.arc, center: mv(src.arc.center), start: mv(src.arc.start), end: mv(src.arc.end) };
    if (src.arc.leader1) r.arc.leader1 = mv(src.arc.leader1);
    if (src.arc.leader2) r.arc.leader2 = mv(src.arc.leader2);
  }
}

/**
 * 각도·호 치수의 호 위치: 옛 꼭짓점 c0·두 다리 a10·a20에서 재던 부채꼴(호 위치 p0가 든 쪽) 안의 비율을
 * 새 꼭짓점·다리의 부채꼴에서 같게 둔다. 대칭처럼 방향이 뒤집히면(같은 방향 부채꼴보다 반대 방향의 크기가
 * 옛 크기에 가까우면) 반대 방향 부채꼴을 쓴다.
 */
function sectorPoint(c0: P, a10: P, a20: P, p0: P, c: P, a1: P, a2: P, radius: number): P {
  const A1 = Math.atan2(a10.y - c0.y, a10.x - c0.x);
  const A2 = Math.atan2(a20.y - c0.y, a20.x - c0.x);
  const AP = Math.atan2(p0.y - c0.y, p0.x - c0.x);
  const B1 = Math.atan2(a1.y - c.y, a1.x - c.x);
  const B2 = Math.atan2(a2.y - c.y, a2.x - c.x);
  const span = (x: number, y: number) => ccw(x, y) || Math.PI * 2;
  const s12 = span(A1, A2);
  const first = ccw(A1, AP) <= s12;
  const from0 = first ? A1 : A2;
  const size0 = first ? s12 : span(A2, A1);
  const f = ccw(from0, AP) / size0;
  const [x0, x1] = first ? [B1, B2] : [B2, B1];
  const same = span(x0, x1);
  const opp = span(x1, x0);
  const a = Math.abs(opp - size0) < Math.abs(same - size0) - 1e-9 ? x1 + (1 - f) * opp : x0 + f * same;
  return madd(c, dir(a), radius);
}

/**
 * 연관된 정의점이 pts로 옮겨진 치수(측정값·문자 중간점도 다시 구한다). 바뀐 것이 없으면 null.
 * - 측정을 정하는 점이 모두 같은 만큼 옮겨지면 치수 전체를 옮긴다(문자 위치 포함).
 * - 아니면 종류별로: 회전 치수는 각도와 치수선 자리, 정렬 치수는 치수선 간격, 각도·호 길이는 호의 반지름과 재는 쪽,
 *   반지름·지름·꺾기 치수는 중심을 따라 문자·꺾기 점, 세로좌표는 지시선 끝을 같은 만큼 옮긴다.
 */
export function movedDimension(doc: CadDocument, d: DimensionEntity, pts: ReadonlyMap<DefKey, P>): DimensionEntity | null {
  const ref = [...pts.values(), xy(d.defPoint), xy(d.defPoint2), xy(d.defPoint3), xy(d.defPoint4)];
  const tol = tolFor(...ref);
  let changed = false;
  for (const [k, q] of pts) if (dist(q, d[k]) > tol) changed = true;
  if (!changed) return null;
  const r: DimensionEntity = structuredClone(d);
  const P0 = (k: DefKey): P => xy(d[k]);
  const P1 = (k: DefKey): P => pts.get(k) ?? P0(k);
  const set = (k: DefKey | 'defPoint5' | 'textMid', q: P) => {
    r[k] = { x: q.x, y: q.y, z: d[k].z };
  };
  const user = (d.dimType & 128) !== 0;
  const kind = d.subtype === 'ARC_DIMENSION' ? 'arc' : d.subtype === 'LARGE_RADIAL_DIMENSION' ? 'jog' : d.dimType & 7;
  const mk = measureKeys(d);
  const d0 = mk.length ? sub(P1(mk[0]!), P0(mk[0]!)) : { x: 0, y: 0 };
  const natural = !d.extrusion || (Math.abs(d.extrusion.x) < 1e-12 && Math.abs(d.extrusion.y) < 1e-12 && d.extrusion.z > 0);
  const rigid = natural && mk.length > 0 && mk.every((k) => pts.has(k) && dist(sub(P1(k), P0(k)), d0) <= tol);
  if (rigid) translateDim(r, d, d0);
  else if (kind === 0) {
    const p2 = P1('defPoint3');
    const u = dir(d.rotation);
    const ext = d.obliqueAngle ? dir(d.obliqueAngle) : perp(u);
    set('defPoint2', P1('defPoint2'));
    set('defPoint3', p2);
    set('defPoint', intersect(P0('defPoint'), u, p2, ext) ?? madd(p2, perp(u), dot(sub(P0('defPoint'), p2), perp(u))));
  } else if (kind === 1) {
    const n0 = perp(unit(sub(P0('defPoint3'), P0('defPoint2'))));
    const h = dot(sub(P0('defPoint'), P0('defPoint3')), n0);
    const p1 = P1('defPoint2');
    const p2 = P1('defPoint3');
    const n1 = perp(unit(sub(p2, p1), unit(sub(P0('defPoint3'), P0('defPoint2')))));
    set('defPoint2', p1);
    set('defPoint3', p2);
    set('defPoint', madd(p2, n1, h));
  } else if (kind === 2) {
    const u10 = sub(P0('defPoint3'), P0('defPoint2'));
    const u20 = sub(P0('defPoint'), P0('defPoint4'));
    const u1 = sub(P1('defPoint3'), P1('defPoint2'));
    const u2 = sub(P1('defPoint'), P1('defPoint4'));
    const x0 = intersect(P0('defPoint2'), u10, P0('defPoint4'), u20);
    const x1 = intersect(P1('defPoint2'), u1, P1('defPoint4'), u2);
    for (const k of ['defPoint', 'defPoint2', 'defPoint3', 'defPoint4'] as const) set(k, P1(k));
    if (x0 && x1) {
      const e1 = unit(u10);
      const e2 = unit(u20);
      const det = cross(e1, e2);
      if (Math.abs(det) > 1e-12) {
        const w = sub(xy(d.defPoint5), x0);
        const s = cross(w, e2) / det;
        const t = cross(e1, w) / det;
        set('defPoint5', add(x1, add({ x: unit(u1).x * s, y: unit(u1).y * s }, { x: unit(u2).x * t, y: unit(u2).y * t })));
      }
    }
  } else if (kind === 5 || kind === 'arc') {
    const c0 = P0('defPoint4');
    const c1 = P1('defPoint4');
    let a1 = P1('defPoint2');
    let a2 = P1('defPoint3');
    if (kind === 'arc') {
      // 호 길이는 시작 → 끝 반시계로 잰다: 대칭 등으로 방향이 뒤집혔으면 두 끝을 바꾼다
      const sw0 = ccw(Math.atan2(P0('defPoint2').y - c0.y, P0('defPoint2').x - c0.x), Math.atan2(P0('defPoint3').y - c0.y, P0('defPoint3').x - c0.x));
      const swSame = ccw(Math.atan2(a1.y - c1.y, a1.x - c1.x), Math.atan2(a2.y - c1.y, a2.x - c1.x));
      const swOpp = ccw(Math.atan2(a2.y - c1.y, a2.x - c1.x), Math.atan2(a1.y - c1.y, a1.x - c1.x));
      if (Math.abs(swOpp - sw0) < Math.abs(swSame - sw0) - 1e-9) [a1, a2] = [a2, a1];
    }
    let radius = dist(P0('defPoint'), c0);
    if (kind === 'arc') radius += dist(a1, c1) - dist(P0('defPoint2'), c0);
    set('defPoint2', a1);
    set('defPoint3', a2);
    set('defPoint4', c1);
    if (dist(a1, c1) > tol && dist(a2, c1) > tol) set('defPoint', sectorPoint(c0, P0('defPoint2'), P0('defPoint3'), P0('defPoint'), c1, a1, a2, radius));
    if (kind === 'arc' && d.arc) {
      const v = (q: P, z: number): Vec3 => ({ x: q.x, y: q.y, z });
      r.arc = {
        ...d.arc,
        center: v(c1, d.arc.center.z),
        start: v(a1, d.arc.start.z),
        end: v(a2, d.arc.end.z),
        startAngle: Math.atan2(a1.y - c1.y, a1.x - c1.x),
        endAngle: Math.atan2(a2.y - c1.y, a2.x - c1.x),
      };
    }
  } else if (kind === 3 || kind === 4 || kind === 'jog') {
    const cOld = kind === 3 ? mid(P0('defPoint'), P0('defPoint4')) : P0('defPoint');
    set('defPoint4', P1('defPoint4'));
    set('defPoint', P1('defPoint'));
    const cNew = kind === 3 ? mid(P1('defPoint'), P1('defPoint4')) : P1('defPoint');
    const dc = sub(cNew, cOld);
    if (user) set('textMid', add(xy(d.textMid), dc));
    if (kind === 'jog') {
      set('defPoint2', add(P0('defPoint2'), dc));
      set('defPoint3', add(P0('defPoint3'), dc));
    }
  } else if (kind === 6) {
    const dd = sub(P1('defPoint2'), P0('defPoint2'));
    set('defPoint2', P1('defPoint2'));
    set('defPoint3', add(P0('defPoint3'), dd));
    if (pts.has('defPoint')) set('defPoint', P1('defPoint'));
    if (user) set('textMid', add(xy(d.textMid), dd));
  } else return null;
  try {
    const g = generateDimensionGeometry(doc, r);
    r.measurement = g.measurement;
    r.textMid = g.textMid;
  } catch {
    /* 생성기가 못 다루는 치수: 정의점만 바꾼다 */
  }
  return r;
}

/** 호 길이 치수의 두 끝이 바뀌었는지(옮긴 13 자리에 14가 왔으면) */
export function arcEndsSwapped(nd: DimensionEntity, pts: ReadonlyMap<DefKey, P>): boolean {
  if (nd.subtype !== 'ARC_DIMENSION') return false;
  const p2 = pts.get('defPoint2');
  const p3 = pts.get('defPoint3');
  if (!p2 || !p3) return false;
  const tol = tolFor(p2, p3);
  return dist(p2, p3) > tol && dist(xy(nd.defPoint3), p2) <= tol && dist(xy(nd.defPoint2), p3) <= tol;
}

/** 원·호(폴리선 호 세그먼트 포함)의 중심과 반지름 */
function circleOf(e: Entity | undefined, gs: number): { c: P; r: number } | null {
  if (!e) return null;
  if (e.type === 'CIRCLE' || e.type === 'ARC') {
    const pc = pathPieces(e)?.pieces[0];
    return pc?.k === 'arc' ? { c: pc.c, r: pc.r } : null;
  }
  if (POLY.has(e.type) && gs > 0) {
    const pc = pathPieces(e)?.pieces.find((x, k) => (segOf(x) ?? k) === gs - 1);
    return pc?.k === 'arc' ? { c: pc.c, r: pc.r } : null;
  }
  return null;
}

/** 반지름·지름·꺾기 치수: 현 위 점 참조가 원·호를 가리키면 중심·반지름을 객체에서 다시 잡는다(각도는 옮겨진 현 위 점) */
function radialFix(d: DimensionEntity, refs: readonly (PointRef | null)[], pts: Map<DefKey, P>, get: (h: string) => Entity | undefined): void {
  const t = d.dimType & 7;
  if (t !== 3 && t !== 4) return;
  const chord = refs[0];
  const circ = chord && followable(chord) ? circleOf(get(chord.ids[0]!), chord.gsMarker) : null;
  if (!circ) return;
  const at = pts.get('defPoint4') ?? xy(d.defPoint4);
  const u = unit(sub(at, circ.c), unit(sub(xy(d.defPoint4), xy(d.defPoint))));
  pts.set('defPoint4', madd(circ.c, u, circ.r));
  pts.set('defPoint', t === 4 ? circ.c : madd(circ.c, u, -circ.r));
}

// ---------------------------------------------------------------------------
// 기록 바꾸기(사전·DIMASSOC·반응자)
// ---------------------------------------------------------------------------

export interface ObjectChange {
  key: string;
  before: CadObject | null;
  after: CadObject | null;
}

export interface AssocChanges {
  /** 사전·DIMASSOC 객체 */
  objects: ObjectChange[];
  /** 반응자·확장 사전이 바뀐 객체(편집 뒤 모습, 핸들 → 객체) */
  entities: Map<string, Entity>;
}

export interface AssocEnv {
  /** 새 핸들 */
  alloc(): string;
  /** 객체의 지금 모습(같은 편집에서 이미 바뀐 것 포함). 없으면 지워진 것 */
  current(h: string): Entity | undefined;
}

function refHandles(data: DimAssocData | null | undefined): Set<string> {
  const s = new Set<string>();
  for (const r of data?.refs ?? []) {
    if (!r) continue;
    for (const h of r.ids) s.add(h);
    for (const h of r.ids2 ?? []) s.add(h);
  }
  return s;
}

function setReactor(out: AssocChanges, env: AssocEnv, h: string, assoc: string, on: boolean): void {
  const e = out.entities.get(h) ?? env.current(h);
  if (!e) return;
  const list = e.reactors ?? [];
  const has = list.includes(assoc);
  if (has === on) return;
  const next = on ? [...list, assoc] : list.filter((x) => x !== assoc);
  const after = { ...e } as Entity;
  if (next.length) after.reactors = next;
  else delete after.reactors;
  out.entities.set(h, after);
}

function upsertObject(out: AssocChanges, doc: CadDocument, key: string, after: CadObject | null): void {
  const i = out.objects.findIndex((o) => o.key === key);
  if (i >= 0) out.objects[i]!.after = after;
  else out.objects.push({ key, before: doc.objects.get(key) ?? null, after });
}

/** 지금(같은 편집 안에서 바뀐 것 포함) 객체 */
function objectNow(out: AssocChanges, doc: CadDocument, key: string): CadObject | undefined {
  const o = out.objects.find((x) => x.key === key);
  if (o) return o.after ?? undefined;
  return doc.objects.get(key);
}

/**
 * 치수의 연관을 refs로 바꾼다(없던 기록은 만들고, 참조가 하나도 없으면 DIMASSOC와 빈 확장 사전을 지운다).
 * dim은 지금 모습(새 치수면 핸들이 붙은 채 아직 문서에 없어도 된다). 돌려준 dim에 확장 사전 핸들이 반영된다.
 */
export function setDimAssocChanges(doc: CadDocument, dim: DimensionEntity, refs: readonly (PointRef | null)[], env: AssocEnv, out: AssocChanges = { objects: [], entities: new Map() }, keep?: { transSpace: boolean; rotatedType: number }): { dim: DimensionEntity; changes: AssocChanges } {
  let d = dim;
  // 지금 기록(같은 편집에서 바뀐 사전 포함)
  const dict0 = d.xdict ? objectNow(out, doc, d.xdict) : undefined;
  const dict = dict0 && (dict0.type === 'DICTIONARY' || dict0.type === 'ACDBDICTIONARYWDFLT') ? (dict0 as DictionaryObject) : undefined;
  const assocH = dict?.entries.get(DIMASSOC_KEY);
  const assocObj = assocH ? objectNow(out, doc, assocH) : undefined;
  const oldData = assocObj?.type === 'DIMASSOC' ? parseDimAssoc((assocObj as GenericObject).raw) : null;
  const want = [0, 1, 2, 3].map((i) => refs[i] ?? null);
  const any = want.some((r) => r);
  const oldH = refHandles(oldData);
  if (!any) {
    if (!assocH || !dict) return { dim: d, changes: out };
    for (const h of oldH) setReactor(out, env, h, assocH, false);
    upsertObject(out, doc, assocH, null);
    const entries = new Map(dict.entries);
    entries.delete(DIMASSOC_KEY);
    if (entries.size) upsertObject(out, doc, dict.handle, { ...dict, entries });
    else {
      upsertObject(out, doc, dict.handle, null);
      d = { ...d };
      delete d.xdict;
      out.entities.set(d.handle, d);
    }
    return { dim: d, changes: out };
  }
  const data: DimAssocData = {
    dimension: d.handle,
    transSpace: keep?.transSpace ?? oldData?.transSpace ?? false,
    rotatedType: keep?.rotatedType ?? oldData?.rotatedType ?? 0,
    refs: want,
  };
  let dictH = dict?.handle;
  let ah = assocH;
  if (!dict) {
    dictH = env.alloc();
    ah = env.alloc();
    const nd: DictionaryObject = { type: 'DICTIONARY', handle: dictH, owner: d.handle, reactors: [d.handle], entries: new Map([[DIMASSOC_KEY, ah]]), hardOwner: true, cloning: 1 };
    upsertObject(out, doc, dictH, nd);
    d = { ...d, xdict: dictH };
    out.entities.set(d.handle, d);
  } else if (!ah) {
    ah = env.alloc();
    upsertObject(out, doc, dict.handle, { ...dict, entries: new Map([...dict.entries, [DIMASSOC_KEY, ah]]) });
  }
  const prev = assocObj?.type === 'DIMASSOC' ? (assocObj as GenericObject) : undefined;
  const obj: GenericObject = { ...(prev ?? {}), type: 'DIMASSOC', handle: ah!, owner: dictH!, reactors: prev?.reactors?.length ? prev.reactors : [dictH!], raw: dimAssocRaw(data) };
  delete obj.dwgRaw;
  upsertObject(out, doc, ah!, obj);
  const newH = refHandles(data);
  for (const h of oldH) if (!newH.has(h)) setReactor(out, env, h, ah!, false);
  for (const h of newH) setReactor(out, env, h, ah!, true);
  return { dim: d, changes: out };
}

// ---------------------------------------------------------------------------
// 따라가기
// ---------------------------------------------------------------------------

export interface FollowResult extends AssocChanges {
  /** 정의점이 바뀐 치수(핸들 → 새 치수, 측정값·문자 중간점 갱신됨). 치수 블록은 부르는 쪽이 다시 만든다 */
  dims: Map<string, DimensionEntity>;
  /** 연관이 풀린(일부라도) 치수 핸들 */
  released: Set<string>;
}

/**
 * 편집(changes: 핸들 → 편집 뒤 객체, null = 지움)에 연관 치수를 맞춘다.
 * - 연관된 형상이 바뀌면 그 점 참조를 다시 풀어 정의점을 옮긴다(풀 수 없으면 그 참조만 끊는다).
 * - 연관된 형상이 지워지면 그 참조를 끊는다(치수는 남는다).
 * - 치수만 옮기거나 정의점을 그립으로 옮겨 형상의 스냅 점에서 벗어나면 그 점의 연관을 끊는다.
 * - 치수가 지워지면 DIMASSOC·확장 사전을 지우고 형상 반응자를 정리한다.
 */
export function followAssociations(
  doc: CadDocument,
  changes: ReadonlyMap<string, Entity | null>,
  alloc: () => string,
  opt: {
    /** 바뀐 객체가 모두 같은 변환을 받았으면 그 변환(이동·회전·축척·대칭) */
    transform?: (p: P) => P;
  } = {},
): FollowResult {
  const res: FollowResult = { objects: [], entities: new Map(), dims: new Map(), released: new Set() };
  // 걸린 DIMASSOC
  const assocs = new Set<string>();
  for (const h of changes.keys()) {
    const before = doc.entityIndex.get(h);
    if (!before) continue;
    for (const r of assocReactors(doc, before)) assocs.add(r);
    if (before.type === 'DIMENSION') {
      const a = dimAssocOf(doc, before);
      if (a) assocs.add(a.obj.handle);
    }
  }
  if (!assocs.size) return res;
  const nowOf = (h: string): Entity | undefined => {
    const x = res.entities.get(h);
    if (x) return x;
    if (changes.has(h)) return changes.get(h) ?? undefined;
    return doc.entityIndex.get(h);
  };
  const env: AssocEnv = { alloc, current: nowOf };
  const ctx: ResolveContext = {
    doc,
    get: (h) => (changes.has(h) ? (changes.get(h) ?? undefined) : doc.entityIndex.get(h)),
    before: (h) => doc.entityIndex.get(h),
  };
  for (const ah of assocs) {
    const obj = doc.objects.get(ah) as GenericObject | undefined;
    const data = parseDimAssoc(obj?.raw);
    if (!data) continue;
    const dimH = data.dimension;
    const dimBefore = doc.entityIndex.get(dimH);
    if (!dimBefore || dimBefore.type !== 'DIMENSION') continue;
    const dimNow0 = changes.has(dimH) ? changes.get(dimH) : dimBefore;
    if (!dimNow0 || dimNow0.type !== 'DIMENSION') {
      // 치수를 지웠다: 기록을 지우고 형상 반응자를 정리한다
      for (const h of refHandles(data)) if (nowOf(h)) setReactor(res, env, h, ah, false);
      upsertObject(res, doc, ah, null);
      const dict = dimBefore.xdict ? doc.objects.get(dimBefore.xdict) : undefined;
      if (dict && (dict.type === 'DICTIONARY' || dict.type === 'ACDBDICTIONARYWDFLT')) {
        const entries = new Map((dict as DictionaryObject).entries);
        entries.delete(DIMASSOC_KEY);
        upsertObject(res, doc, dict.handle, entries.size ? { ...(dict as DictionaryObject), entries } : null);
      }
      continue;
    }
    const dimNow = dimNow0 as DimensionEntity;
    const dimMoved = dimNow !== dimBefore;
    const keys = assocKeys(dimBefore);
    const pts = new Map<DefKey, P>();
    const refs = data.refs.map((r) => (r ? { ...r, point: { ...r.point } } : null));
    let released = false;
    let refsChanged = false;
    refs.forEach((r, i) => {
      if (!r) return;
      const key = keys[i];
      const hs = [...r.ids, ...(r.ids2 ?? [])];
      if (hs.some((h) => changes.has(h) && changes.get(h) === null)) {
        // 형상을 지웠다
        refs[i] = null;
        released = true;
        return;
      }
      if (!key || !followable(r)) return;
      const geomChanged = hs.some((h) => changes.has(h));
      const hint = xy(dimBefore[key]);
      if (geomChanged) {
        const all = hs.every((h) => changes.has(h));
        const q = resolveRef(ctx, r, hint, all && opt.transform ? opt.transform(hint) : undefined);
        if (!q) {
          refs[i] = null;
          released = true;
          return;
        }
        pts.set(key, q);
        r.point = { x: q.x, y: q.y, z: r.point.z };
        refsChanged = true;
      } else if (dimMoved) {
        // 치수만 바뀌었다: 정의점이 스냅 점에서 벗어났으면 그 점을 푼다
        const q = resolveRef({ ...ctx, before: ctx.get }, r, hint);
        const tol = tolFor(dimNow[key], hint);
        if (!q || dist(q, dimNow[key]) > tol) {
          refs[i] = null;
          released = true;
        }
      }
    });
    if (pts.size) radialFix(dimNow, refs, pts, ctx.get);
    let nd: DimensionEntity | null = null;
    if (pts.size) nd = movedDimension(doc, dimNow, pts);
    if (nd && arcEndsSwapped(nd, pts)) [refs[0], refs[1]] = [refs[1] ?? null, refs[0] ?? null];
    const base = nd ?? dimNow;
    if (nd) res.dims.set(dimH, nd);
    if (released) res.released.add(dimH);
    if (released || refsChanged) {
      const { dim } = setDimAssocChanges(doc, base, refs, env, res, { transSpace: data.transSpace, rotatedType: data.rotatedType });
      if (res.dims.has(dimH) || dim !== base) res.dims.set(dimH, dim);
    }
  }
  // 치수 자체는 dims로 돌려준다(반응자 목록에서는 뺀다)
  for (const h of res.dims.keys()) res.entities.delete(h);
  return res;
}

/**
 * 연관 치수를 지금 형상에 다시 맞춘다(DIMREGEN). only가 있으면 그 치수만.
 * 객체가 없어진 참조는 끊고, 풀 수 없는 참조도 끊는다.
 */
export function regenAssociations(doc: CadDocument, alloc: () => string, only?: ReadonlySet<string>): FollowResult {
  const res: FollowResult = { objects: [], entities: new Map(), dims: new Map(), released: new Set() };
  const nowOf = (h: string): Entity | undefined => res.entities.get(h) ?? doc.entityIndex.get(h);
  const env: AssocEnv = { alloc, current: nowOf };
  const ctx: ResolveContext = { doc, get: (h) => doc.entityIndex.get(h), before: (h) => doc.entityIndex.get(h) };
  for (const o of doc.objects.values()) {
    if (o.type !== 'DIMASSOC') continue;
    const data = parseDimAssoc((o as GenericObject).raw);
    if (!data) continue;
    const dim = doc.entityIndex.get(data.dimension);
    if (!dim || dim.type !== 'DIMENSION' || (only && !only.has(dim.handle))) continue;
    if (dimAssocOf(doc, dim)?.obj.handle !== o.handle) continue;
    const keys = assocKeys(dim);
    const pts = new Map<DefKey, P>();
    const refs = data.refs.map((r) => (r ? { ...r, point: { ...r.point } } : null));
    let released = false;
    let refsChanged = false;
    refs.forEach((r, i) => {
      if (!r) return;
      if (!followable(r)) return;
      if (![...r.ids, ...(r.ids2 ?? [])].every((h) => doc.entityIndex.has(h))) {
        refs[i] = null;
        released = true;
        return;
      }
      const key = keys[i];
      if (!key) return;
      const q = resolveRef(ctx, r, xy(dim[key]));
      if (!q) {
        refs[i] = null;
        released = true;
        return;
      }
      const tol = tolFor(q, dim[key]);
      if (dist(q, dim[key]) > tol) pts.set(key, q);
      if (dist(q, r.point) > tol) {
        r.point = { x: q.x, y: q.y, z: r.point.z };
        refsChanged = true;
      }
    });
    if (pts.size) radialFix(dim, refs, pts, ctx.get);
    const nd = pts.size ? movedDimension(doc, dim, pts) : null;
    if (nd && arcEndsSwapped(nd, pts)) [refs[0], refs[1]] = [refs[1] ?? null, refs[0] ?? null];
    if (nd) res.dims.set(dim.handle, nd);
    if (released) res.released.add(dim.handle);
    if (released || refsChanged) {
      const base = nd ?? dim;
      const out = setDimAssocChanges(doc, base, refs, env, res, { transSpace: data.transSpace, rotatedType: data.rotatedType });
      if (nd || out.dim !== base) res.dims.set(dim.handle, out.dim);
    }
  }
  for (const h of res.dims.keys()) res.entities.delete(h);
  return res;
}
