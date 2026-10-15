/**
 * AutoCAD 파라메트릭 구속(2D 구속 그룹) → 이 앱의 구속 모델(읽기).
 *
 * 그룹의 노드 그래프(cgroup.ts)에서:
 *  - 형상 노드 → 객체 참조: 형상 종속(ACDBASSOCGEOMDEPENDENCY)의 대상 객체. 선·원·호는 객체 전체(''),
 *    폴리선 모서리(AcDbAssocEdgePersSubentId)는 캐시 좌표가 맞는 세그먼트('G<i>').
 *    암시 점(시작·끝·중간·중심)은 그 곡선의 부분('S'·'E'·'M'·'C', 폴리선은 'V<i>'·'M<i>'·'C<i>') — 시작·끝은 캐시 좌표가
 *    가까운 쪽으로 정한다(AutoCAD와 이 앱의 곡선 방향이 다를 수 있다).
 *  - 사용자 구속 노드(암시 290 = 0) → 기하 구속·치수 구속. 점–곡선·중심점·중간점처럼 암시인 노드는 구조라 옮기지 않는다.
 *    일치(점–점·점–곡선), 평행, 직교, 수평·수직(기준선 노드의 방향 → 축 각도), 접선, 동일선상, 동심, 같은 길이·같은 반지름(동일), 고정,
 *    거리(방향 종류 1 = 그 방향의 거리: X축 쪽이면 수평, Y축 쪽이면 수직, 0 = 정렬), 반지름·지름(280: 1 지름).
 *    치수 구속의 이름·식·값은 값 종속이 가리키는 ACDBASSOCVARIABLE(식이 빈 글이면 참조 구속), 치수선 자리는 치수 종속이
 *    가리키는 치수 객체(*ADSK_CONSTRAINTS 도면층의 숨은 DIMENSION)의 점에서 정한다.
 *  - 그룹에 묶이지 않은 변수(값 종속이 없는 ACDBASSOCVARIABLE) → 사용자 매개변수.
 * 표본에 없던 노드 클래스가 있는 그룹은 통째로 읽지 않는다(안내 문구에 센다).
 */
import type { CadDocument, DimensionEntity, Entity, GenericObject, Vec2, Vec3 } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { prepareDim, prepareGeo } from '../constraint/make';
import { numberText, replaceName } from '../constraint/params';
import { type Prim, curveOf, isCurvePart, isPointPart, pointOf } from '../constraint/prims';
import { buildSystem } from '../constraint/system';
import type { Constraint, DimConstraint, DimType, GeoConstraint, GeoRef, GeoType, UserParam } from '../constraint/types';
import { GEOMETRY_CLASSES, type CGroupData, type CNode } from './cgroup';
import { assocData, groupData, groupUnknownClasses, objectOf } from './network';
import { type VariableData, valueNumber } from './objects';

/** 작업 평면(그룹 좌표 → 블록 좌표) */
export interface Plane {
  o: Vec3;
  x: Vec3;
  y: Vec3;
}

export const planeOf = (g: CGroupData): Plane => ({ o: g.origin, x: g.xAxis, y: g.yAxis });
export const toWorld = (pl: Plane, p: Vec3): Vec2 => ({ x: pl.o.x + p.x * pl.x.x + p.y * pl.y.x, y: pl.o.y + p.x * pl.x.y + p.y * pl.y.y });
export const vecToWorld = (pl: Plane, v: Vec3): Vec2 => ({ x: v.x * pl.x.x + v.y * pl.y.x, y: v.x * pl.x.y + v.y * pl.y.y });
/** 블록 좌표 → 그룹 좌표(축은 정규 직교) */
export function toPlane(pl: Plane, p: Vec2, z = 0): Vec3 {
  const dx = p.x - pl.o.x;
  const dy = p.y - pl.o.y;
  return { x: dx * pl.x.x + dy * pl.x.y, y: dx * pl.y.x + dy * pl.y.y, z };
}
export function vecToPlane(pl: Plane, v: Vec2, z = 0): Vec3 {
  return { x: v.x * pl.x.x + v.y * pl.x.y, y: v.x * pl.y.x + v.y * pl.y.y, z };
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 구속 노드 클래스 → 기하 구속 종류 */
const GEO_OF: Record<string, GeoType> = {
  AcPointCoincidenceConstraint: 'COINCIDENT',
  AcPointCurveConstraint: 'COINCIDENT',
  AcParallelConstraint: 'PARALLEL',
  AcPerpendicularConstraint: 'PERPENDICULAR',
  AcHorizontalConstraint: 'HORIZONTAL',
  AcVerticalConstraint: 'VERTICAL',
  AcTangentConstraint: 'TANGENT',
  AcColinearConstraint: 'COLLINEAR',
  AcConcentricConstraint: 'CONCENTRIC',
  AcEqualLengthConstraint: 'EQUAL',
  AcEqualRadiusConstraint: 'EQUAL',
  AcFixedConstraint: 'FIX',
};

/** 읽은 그룹 하나 */
export interface GroupImport {
  group: string;
  data: CGroupData;
  /** 형상 노드 번호 → 참조 */
  refs: Map<number, GeoRef>;
  /** 구속 노드 번호 → 구속(번호는 0, importAcadConstraints가 붙인다) */
  constraints: Map<number, Constraint>;
  /** 옮기지 못한 사용자 구속 노드 */
  skipped: { node: number; cls: string; why: string }[];
  /** 값 종속 핸들 → 변수 핸들 */
  variables: Map<string, string>;
}

// ---------------------------------------------------------------------------
// 형상 노드 → 참조
// ---------------------------------------------------------------------------

interface Geo {
  prim(h: string): Prim | undefined;
  x: number[];
}

function geoFor(doc: CadDocument, handles: Iterable<string>): Geo {
  const sys = buildSystem((h) => doc.entityIndex.get(h), [], handles);
  return { prim: (h) => sys.prims.get(h), x: sys.vars.x };
}

/** 노드 캐시의 곡선(블록 좌표) */
function nodeCurve(n: CNode, pl: Plane): { k: 'line'; a: Vec2; b: Vec2 } | { k: 'circle'; c: Vec2; r: number; a?: Vec2; b?: Vec2 } | null {
  const f = n.f;
  if (n.cls === 'AcConstrainedBoundedLine') return { k: 'line', a: toWorld(pl, f.start as Vec3), b: toWorld(pl, f.end as Vec3) };
  if (n.cls === 'AcConstrainedCircle') return { k: 'circle', c: toWorld(pl, f.center as Vec3), r: f.radius as number };
  if (n.cls === 'AcConstrainedArc') return { k: 'circle', c: toWorld(pl, f.center as Vec3), r: f.radius as number, a: toWorld(pl, f.start as Vec3), b: toWorld(pl, f.end as Vec3) };
  return null;
}

/** 폴리선 세그먼트 중 캐시 곡선과 가장 가까운 것 */
function matchSegment(pr: Extract<Prim, { k: 'poly' }>, geo: Geo, cv: NonNullable<ReturnType<typeof nodeCurve>>): number {
  const n = pr.closed ? pr.v.length : pr.v.length - 1;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const c = curveOf(pr, `G${i}`, geo.x);
    if (!c || c.k !== cv.k) continue;
    const a = pointOf(pr, `V${i}`, geo.x)!;
    const b = pointOf(pr, `V${(i + 1) % pr.v.length}`, geo.x)!;
    let d: number;
    if (cv.k === 'line') d = Math.min(dist(a, cv.a) + dist(b, cv.b), dist(a, cv.b) + dist(b, cv.a));
    else if (c.k === 'circle') {
      d = dist(c.c, cv.c) + Math.abs(c.r - cv.r);
      if (cv.a && cv.b) d += Math.min(dist(a, cv.a) + dist(b, cv.b), dist(a, cv.b) + dist(b, cv.a));
    } else continue;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function mapGeometry(doc: CadDocument, g: CGroupData, geo: Geo): Map<number, GeoRef> {
  const pl = planeOf(g);
  const out = new Map<number, GeoRef>();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  // 곡선 노드
  for (const n of g.nodes) {
    if (!GEOMETRY_CLASSES.has(n.cls) || n.cls === 'AcConstrainedImplicitPoint' || n.cls === 'AcConstrainedDatumLine') continue;
    const dep = assocData(objectOf(doc, n.f.dep as string));
    if (dep?.kind !== 'geomdep' || !dep.dep.target) continue;
    const h = dep.dep.target;
    const pr = geo.prim(h);
    if (!pr) continue;
    const cv = nodeCurve(n, pl);
    if (!cv) continue;
    if (pr.k === 'poly') {
      if (dep.geom.subentClass !== 'AcDbAssocEdgePersSubentId') continue;
      const i = matchSegment(pr, geo, cv);
      if (i >= 0) out.set(n.id, { h, part: `G${i}` });
      continue;
    }
    const ok = (cv.k === 'line' && pr.k === 'line') || (cv.k === 'circle' && (pr.k === 'circle' || pr.k === 'arc') && (n.cls === 'AcConstrainedArc') === (pr.k === 'arc'));
    if (ok && dep.geom.subentClass === 'AcDbAssocSingleEdgePersSubentId') out.set(n.id, { h, part: '' });
  }
  // 암시 점
  for (const n of g.nodes) {
    if (n.cls !== 'AcConstrainedImplicitPoint') continue;
    if ((n.f.index as number) !== -1) continue;
    const cn = byId.get(n.f.curve as number);
    const cr = cn ? out.get(cn.id) : undefined;
    if (!cn || !cr) continue;
    const pr = geo.prim(cr.h)!;
    const t = n.f.ptype as number;
    const seg = cr.part.startsWith('G') ? Number(cr.part.slice(1)) : -1;
    let part: string | null = null;
    if (t === 3) part = seg >= 0 ? `C${seg}` : 'C';
    else if (t === 2) part = seg >= 0 ? `M${seg}` : 'M';
    else if (t === 0 || t === 1) {
      // 시작·끝을 함께 맞춘다(두 점이 같은 부분으로 가지 않게): 캐시의 (시작, 끝)과 객체의 (첫, 둘째) 거리 합이 작은 쪽
      const cv = nodeCurve(cn, pl);
      const cands = seg >= 0 && pr.k === 'poly' ? [`V${seg}`, `V${(seg + 1) % pr.v.length}`] : ['S', 'E'];
      let swap = false;
      if (cv && 'a' in cv && cv.a && cv.b) {
        const p0 = pointOf(pr, cands[0]!, geo.x);
        const p1 = pointOf(pr, cands[1]!, geo.x);
        if (p0 && p1) swap = dist(cv.a, p1) + dist(cv.b, p0) < dist(cv.a, p0) + dist(cv.b, p1);
      }
      part = cands[(t === 0) !== swap ? 0 : 1]!;
    }
    if (part && isPointPart(pr, part)) out.set(n.id, { h: cr.h, part });
  }
  for (const [id, r] of out) {
    const pr = geo.prim(r.h);
    if (!pr || !(isPointPart(pr, r.part) || isCurvePart(pr, r.part))) out.delete(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 구속 노드 → 구속
// ---------------------------------------------------------------------------

function variableOf(doc: CadDocument, valueDep: string): { handle: string; v: VariableData } | null {
  const vd = assocData(objectOf(doc, valueDep));
  if (vd?.kind !== 'valuedep' || !vd.dep.target) return null;
  const vo = objectOf(doc, vd.dep.target);
  const v = assocData(vo);
  return v?.kind === 'variable' ? { handle: normalizeHandle(vo!.handle), v: v.variable } : null;
}

function dimensionOf(doc: CadDocument, dimDep: string): DimensionEntity | null {
  const d = assocData(objectOf(doc, dimDep));
  if (d?.kind !== 'dependency' || !d.dep.target) return null;
  const e = doc.entityIndex.get(d.dep.target);
  return e?.type === 'DIMENSION' ? e : null;
}

/** 각도를 (−π/2, π/2]로 */
function halfTurn(a: number): number {
  while (a <= -Math.PI / 2) a += Math.PI;
  while (a > Math.PI / 2) a -= Math.PI;
  return a;
}

function axisOrUndefined(a: number): number | undefined {
  return Math.abs(a) < 1e-9 ? undefined : a;
}

function importConstraint(doc: CadDocument, g: CGroupData, n: CNode, refs: Map<number, GeoRef>, variables: Map<string, string>): Constraint | string {
  const pl = planeOf(g);
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const links = n.links.filter((id) => byId.get(id)?.cls !== 'AcConstrainedDatumLine');
  const rs: GeoRef[] = [];
  for (const id of links) {
    const r = refs.get(id);
    if (!r) return '참조한 형상을 이 앱에서 쓸 수 없습니다';
    rs.push(r);
  }
  const geoType = GEO_OF[n.cls];
  if (geoType) {
    let c: GeoConstraint = { id: 0, kind: 'geo', type: geoType, refs: rs };
    if (geoType === 'HORIZONTAL' || geoType === 'VERTICAL') {
      const dn = byId.get(n.f.datum as number);
      if (dn?.cls === 'AcConstrainedDatumLine') {
        const d = vecToWorld(pl, dn.f.dir as Vec3);
        const a = Math.atan2(d.y, d.x) - (geoType === 'VERTICAL' ? Math.PI / 2 : 0);
        const ax = axisOrUndefined(halfTurn(a));
        if (ax !== undefined) c.axis = ax;
      }
    }
    const need = geoType === 'FIX' ? 1 : geoType === 'HORIZONTAL' || geoType === 'VERTICAL' ? -1 : 2;
    if (need > 0 && rs.length !== need) return `참조 수 ${rs.length}`;
    if (need < 0 && rs.length !== 1 && rs.length !== 2) return `참조 수 ${rs.length}`;
    if (geoType === 'TANGENT') {
      try {
        c = prepareGeo(doc, c);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
    return c;
  }
  if (n.cls === 'AcDistanceConstraint' || n.cls === 'AcRadiusDiameterConstraint') {
    const v = variableOf(doc, n.f.valueDep as string);
    if (!v) return '값 변수가 없습니다';
    variables.set(normalizeHandle(n.f.valueDep as string), v.handle);
    const value = valueNumber(v.v.value);
    const reference = !v.v.expr.trim();
    let type: DimType;
    let axis: number | undefined;
    if (n.cls === 'AcRadiusDiameterConstraint') {
      if (rs.length !== 1) return `참조 수 ${rs.length}`;
      type = (n.f.rtype as number) === 1 ? 'DIAMETER' : 'RADIUS';
    } else {
      if (rs.length !== 2) return `참조 수 ${rs.length}`;
      if ((n.f.dirType as number) === 1 && n.f.dir) {
        const d = vecToWorld(pl, n.f.dir as Vec3);
        const a = halfTurn(Math.atan2(d.y, d.x));
        if (Math.abs(a) <= Math.PI / 4 + 1e-12) {
          type = 'HDIST';
          axis = axisOrUndefined(a);
        } else {
          type = 'VDIST';
          axis = axisOrUndefined(halfTurn(a - Math.PI / 2));
        }
      } else if ((n.f.dirType as number) === 0) type = 'DIST';
      else return `거리 방향 종류 ${n.f.dirType}`;
    }
    const dim = dimensionOf(doc, n.f.dimDep as string);
    const at = dim ? (type === 'RADIUS' || type === 'DIAMETER' ? dim.textMid : dim.defPoint) : null;
    const base: DimConstraint = {
      id: 0,
      kind: 'dim',
      type,
      refs: rs,
      name: v.v.name,
      expr: reference ? numberText(value) : v.v.expr.trim(),
      value,
      reference,
      offset: 0,
      ...(axis !== undefined ? { axis } : {}),
      ...(v.v.description ? { description: v.v.description } : {}),
    };
    try {
      return prepareDim(doc, base, at ? { x: at.x, y: at.y } : null);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return `옮기지 않는 구속(${n.cls})`;
}

const groupCache = new WeakMap<object, { imp: GroupImport; deps: Map<string, object | undefined> }>();

/** 그룹 하나를 읽는다(풀 수 없으면 null) */
export function importGroup(doc: CadDocument, o: GenericObject): GroupImport | null {
  const g = groupData(o);
  if (!g) return null;
  const hit = groupCache.get(o);
  if (hit && [...hit.deps].every(([h, x]) => doc.objects.get(h) === x || doc.entityIndex.get(h) === x)) return hit.imp;
  const handles = new Set<string>();
  for (const n of g.nodes) {
    if (n.cls === 'AcConstrainedImplicitPoint' || !n.f.dep) continue;
    const d = assocData(objectOf(doc, n.f.dep as string));
    if (d?.kind === 'geomdep' && d.dep.target) handles.add(d.dep.target);
  }
  let refs: Map<number, GeoRef>;
  try {
    refs = mapGeometry(doc, g, geoFor(doc, handles));
  } catch {
    refs = new Map();
  }
  const constraints = new Map<number, Constraint>();
  const skipped: GroupImport['skipped'] = [];
  const variables = new Map<string, string>();
  for (const n of g.nodes) {
    if (GEOMETRY_CLASSES.has(n.cls)) continue;
    if (n.f.implied) continue;
    let r: Constraint | string;
    try {
      r = importConstraint(doc, g, n, refs, variables);
    } catch (e) {
      r = e instanceof Error ? e.message : String(e);
    }
    if (typeof r === 'string') skipped.push({ node: n.id, cls: n.cls, why: r });
    else constraints.set(n.id, { ...r, acad: { group: normalizeHandle(o.handle), node: n.id } });
  }
  const imp: GroupImport = { group: normalizeHandle(o.handle), data: g, refs, constraints, skipped, variables };
  // 캐시가 기대는 객체(값 종속·변수·치수 종속·치수 객체·형상 객체)
  const deps = new Map<string, object | undefined>();
  for (const h of g.deps) deps.set(h, doc.objects.get(h));
  for (const [vd, vh] of variables) {
    deps.set(vd, doc.objects.get(vd));
    deps.set(vh, doc.objects.get(vh));
  }
  for (const h of handles) deps.set(h, doc.entityIndex.get(h));
  for (const n of g.nodes)
    if (n.f.dimDep) {
      const d = assocData(objectOf(doc, n.f.dimDep as string));
      if (d?.kind === 'dependency' && d.dep.target) deps.set(d.dep.target, doc.entityIndex.get(d.dep.target));
    }
  groupCache.set(o, { imp, deps });
  return imp;
}

// ---------------------------------------------------------------------------
// 도면 전체
// ---------------------------------------------------------------------------

export interface AcadImportInfo {
  /** 구속 그룹 수 */
  groups: number;
  /** 풀지 못한 그룹(모르는 노드 클래스) */
  unreadable: { handle: string; classes: string[] }[];
  /** 옮긴 구속 수 */
  imported: number;
  /** 옮기지 못한 사용자 구속 수 */
  skipped: number;
  /** 사용자 매개변수로 옮긴 변수 수 */
  variables: number;
  /** 원본 태그가 없는 구속 그룹(DWG에서 읽었는데 코덱이 풀지 못한 것) */
  raw: number;
}

export interface AcadImport {
  constraints: Constraint[];
  userParams: UserParam[];
  info: AcadImportInfo;
  groups: GroupImport[];
  /**
   * 망(블록)마다 이름이 겹쳐 바꾼 매개변수 이름: 망 핸들 → (바꾼 이름 소문자 → AutoCAD 이름).
   * AutoCAD는 변수 이름을 망마다 따로 두지만 이 앱은 도면 하나에 한 이름공간이라, 뒤에 나온 망의 겹치는 이름에 _2 …를 붙인다.
   */
  renames: Map<string, Map<string, string>>;
  /** 구속 그룹·변수 핸들 → 그 망 핸들 */
  networkOf: Map<string, string>;
}

/** 연관 망 객체(구속 그룹·변수)의 목록: 블록 레코드 확장 사전의 망(그 안의 동작 차례) */
export function networkActions(doc: CadDocument): { groups: GenericObject[]; variables: GenericObject[]; networkOf: Map<string, string> } {
  const groups: GenericObject[] = [];
  const variables: GenericObject[] = [];
  const networkOf = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (h: string, net: string, depth: number) => {
    if (!h || seen.has(h) || depth > 8) return;
    seen.add(h);
    const o = objectOf(doc, h);
    if (!o) return;
    const t = o.type.toUpperCase();
    if (t === 'ACDBASSOC2DCONSTRAINTGROUP') {
      groups.push(o);
      networkOf.set(h, net);
    } else if (t === 'ACDBASSOCVARIABLE') {
      variables.push(o);
      networkOf.set(h, net);
    } else if (t === 'ACDBASSOCNETWORK') {
      const d = assocData(o);
      if (d?.kind === 'network') for (const a of d.net.actions) visit(a.h, h, depth + 1);
    }
  };
  for (const r of doc.blockRecords.values()) {
    if (!r.xdict) continue;
    const xd = doc.objects.get(normalizeHandle(r.xdict));
    if (!xd || (xd.type !== 'DICTIONARY' && xd.type !== 'ACDBDICTIONARYWDFLT')) continue;
    for (const [k, dh] of (xd as { entries: Map<string, string> }).entries) {
      if (k.toUpperCase() !== 'ACAD_ASSOCNETWORK') continue;
      const d = doc.objects.get(normalizeHandle(dh));
      if (!d || (d.type !== 'DICTIONARY' && d.type !== 'ACDBDICTIONARYWDFLT')) continue;
      for (const [k2, nh] of (d as { entries: Map<string, string> }).entries) if (k2.toUpperCase() === 'ACAD_ASSOCNETWORK') visit(normalizeHandle(nh), '', 0);
    }
  }
  return { groups, variables, networkOf };
}

const ID_BASE = 1_000_000;
const idMaps = new WeakMap<CadDocument, { map: Map<string, number>; next: number }>();

/** AutoCAD 구속 번호(같은 그룹·노드는 같은 번호) */
function idFor(doc: CadDocument, key: string): number {
  let m = idMaps.get(doc);
  if (!m) idMaps.set(doc, (m = { map: new Map(), next: ID_BASE }));
  let id = m.map.get(key);
  if (id === undefined) {
    id = m.next++;
    m.map.set(key, id);
  }
  return id;
}

const docCache = new WeakMap<CadDocument, { sig: object[]; result: AcadImport }>();

/** 식 안의 이름들을 바꾼다(맵: 소문자 원래 이름 → 새 이름) */
function renameIn(expr: string, map: ReadonlyMap<string, string>): string {
  let out = expr;
  for (const [from, to] of map) if (from !== to.toLowerCase()) out = replaceName(out, from, to);
  return out;
}

/** 도면의 AutoCAD 구속을 이 앱의 구속으로 읽는다(객체가 그대로면 캐시) */
export function importAcadConstraints(doc: CadDocument): AcadImport {
  const { groups, variables, networkOf } = networkActions(doc);
  const sig: object[] = [...groups, ...variables];
  const hit = docCache.get(doc);
  if (hit && hit.sig.length === sig.length && hit.sig.every((x, i) => x === sig[i])) {
    // 그룹 캐시가 그대로인지(형상·변수 객체가 바뀌면 그룹을 다시 읽는다)
    let i = 0;
    const live = groups.filter((o) => o.raw?.length && groupData(o));
    if (live.length === hit.result.groups.length && live.every((o) => importGroup(doc, o) === hit.result.groups[i++])) return hit.result;
  }
  const info: AcadImportInfo = { groups: groups.length, unreadable: [], imported: 0, skipped: 0, variables: 0, raw: 0 };
  const imports: GroupImport[] = [];
  const usedVars = new Set<string>();
  // 망마다: 구속(그룹 차례)과 사용자 변수
  const perNet = new Map<string, { cons: Constraint[]; users: UserParam[] }>();
  const bucket = (net: string) => perNet.get(net) ?? perNet.set(net, { cons: [], users: [] }).get(net)!;
  for (const o of groups) {
    if (!o.raw?.length) {
      info.raw++;
      continue;
    }
    const gi = importGroup(doc, o);
    if (!gi) {
      info.unreadable.push({ handle: o.handle, classes: groupUnknownClasses(o) });
      continue;
    }
    imports.push(gi);
    for (const vh of gi.variables.values()) usedVars.add(vh);
    // 그룹의 값 종속이 가리키는 변수(옮기지 못한 구속의 변수도 사용자 매개변수로 만들지 않는다)
    for (const h of gi.data.deps) {
      const d = assocData(objectOf(doc, h));
      if (d?.kind === 'valuedep' && d.dep.target) usedVars.add(d.dep.target);
    }
    const b = bucket(networkOf.get(gi.group) ?? '');
    for (const [node, c] of gi.constraints) b.cons.push({ ...c, id: idFor(doc, `${gi.group}:${node}`) } as Constraint);
    info.skipped += gi.skipped.length;
  }
  for (const o of variables) {
    const h = normalizeHandle(o.handle);
    if (usedVars.has(h)) continue;
    const d = assocData(o);
    if (d?.kind !== 'variable') continue;
    const v = d.variable;
    const value = valueNumber(v.value);
    if (!v.name.trim()) continue;
    bucket(networkOf.get(h) ?? '').users.push({
      name: v.name,
      expr: v.expr.trim() || numberText(Number.isFinite(value) ? value : 0),
      value: Number.isFinite(value) ? value : 0,
      ...(v.description ? { description: v.description } : {}),
      acad: h,
    });
  }
  // 이름공간 맞추기: 앞 망이 쓴 이름이면 뒤 망의 이름에 _2 …를 붙인다
  const used = new Set<string>();
  const renames = new Map<string, Map<string, string>>();
  const constraints: Constraint[] = [];
  const userParams: UserParam[] = [];
  for (const [net, b] of perNet) {
    const names = [...b.cons.filter((c): c is DimConstraint => c.kind === 'dim').map((c) => c.name), ...b.users.map((u) => u.name)];
    const map = new Map<string, string>();
    const local = new Set(names.map((n) => n.toLowerCase()));
    for (const n of names) {
      const k = n.toLowerCase();
      if (!used.has(k) || map.has(k)) continue;
      let i = 2;
      while (used.has(`${k}_${i}`) || local.has(`${k}_${i}`)) i++;
      map.set(k, `${n}_${i}`);
    }
    if (map.size) {
      const back = new Map<string, string>();
      for (const n of names) {
        const to = map.get(n.toLowerCase());
        if (to) back.set(to.toLowerCase(), n);
      }
      renames.set(net, back);
    }
    for (const c of b.cons) {
      if (c.kind === 'dim' && map.size) {
        const name = map.get(c.name.toLowerCase()) ?? c.name;
        constraints.push({ ...c, name, expr: c.reference ? c.expr : renameIn(c.expr, map) });
      } else constraints.push(c);
    }
    for (const u of b.users) userParams.push(map.size ? { ...u, name: map.get(u.name.toLowerCase()) ?? u.name, expr: renameIn(u.expr, map) } : u);
    for (const c of constraints) if (c.kind === 'dim') used.add(c.name.toLowerCase());
    for (const u of userParams) used.add(u.name.toLowerCase());
  }
  info.imported = constraints.length;
  info.variables = userParams.length;
  const result: AcadImport = { constraints, userParams, info, groups: imports, renames, networkOf };
  docCache.set(doc, { sig, result });
  return result;
}

/** 이 앱 이름·식 → AutoCAD 망 안의 이름·식(겹쳐 바꾼 이름을 되돌린다) */
export function acadNames(imp: AcadImport, net: string, name: string, expr: string): { name: string; expr: string } {
  const back = imp.renames.get(net);
  if (!back) return { name, expr };
  return { name: back.get(name.toLowerCase()) ?? name, expr: renameIn(expr, back) };
}

/** 도면의 원본 그룹 객체 → 읽은 그룹(핸들로) */
export function importedGroup(doc: CadDocument, handle: string): GroupImport | null {
  const o = objectOf(doc, handle);
  return o ? importGroup(doc, o) : null;
}

export { dist as pointDistance, sub as vecSub };
export type { Entity };
