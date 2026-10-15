/**
 * 이 앱에서 새로 만든 구속(GEOMCONSTRAINT·DIMCONSTRAINT·AUTOCONSTRAIN)을 AutoCAD 2D 구속 그룹으로 쓴다.
 *
 * 공개 도면(AutoCAD가 저장한 구속 DXF 100여 개와 DWG — 출처는 보고서)에서 본 배치를 그대로 따른다:
 *  - 망: 블록 레코드(모형 공간·블록)의 확장 사전 "ACAD_ASSOCNETWORK" → 사전 → ACDBASSOCNETWORK(최상위 망의 동작 목록에 330 참조).
 *    그 망의 동작 목록에 구속 그룹과 변수를 360 소유로 둔다. 같은 공간에 그룹이 있으면 그 그룹에 덧붙인다.
 *  - 그룹(작업 평면: 원점 0, X·Y축): 형상 노드마다 형상 종속(ACDBASSOCGEOMDEPENDENCY, 순서 −10000, 읽기·쓰기,
 *    AcDbAssocSingleEdgePersSubentId)을 두고, 암시 점을 붙인다 — 선: 시작(0)·끝(1) + 점–곡선, 원: 중심(3) + 중심점,
 *    호: 시작·끝 + 점–곡선, 중심 + 중심점, 선의 중간점(2)은 쓸 때만 점–곡선 + 중간점. 형상 노드의 이웃 목록은 붙인 구속 차례,
 *    암시 점의 이웃 목록은 [붙임 구속…, 그 점을 쓰는 구속…]. 수평·수직은 기준선 노드(AcConstrainedDatumLine, 이웃 없음)를 가리킨다.
 *  - 치수 구속: 변수(ACDBASSOCVARIABLE, 망 소유, 반응자 = 값 종속), 값 종속(그룹 소유, 읽기), 치수 종속(그룹 소유, 쓰기, 몸체
 *    ASSOCDIMDEPENDENCYBODY "이름=식"), 숨은 치수(*ADSK_CONSTRAINTS 도면층, 보이지 않음, 블록 없음, 반응자 = 치수 종속).
 *    숨은 치수 종류: 수평·수직 거리 128(회전 0·90°), 정렬 161, 반지름 132, 지름 131. 방향 거리의 방향 벡터는 둘째 점에서 첫째 점 쪽.
 * 쓸 수 있는 것(공개 도면에서 본 노드 클래스와 이웃 꼴): 선·원·호(법선 +Z, 고도 0)의 일치(점–점·점–곡선)·평행·직교·동일선상(선)·
 *   접선(곡선 둘)·동심·같은 길이(선)·같은 반지름(원·호)·수평·수직(선)·고정(점), 두 점 사이 거리(정렬·수평·수직), 반지름·지름.
 *   치수 구속의 식은 수 하나(또는 참조 구속)만 —
 *   다른 매개변수를 쓰는 식은 변수 사이 값 종속의 DXF 배치를 확인하지 못해 쓰지 않는다.
 * 그 밖(각도·대칭·부드러움·폴리선·타원·스플라인·다른 매개변수를 쓰는 식 등)은 부르는 쪽이 이 앱 기록에 남긴다.
 * 형상 객체의 반응자(형상 종속 핸들)는 확정 고리(writeback.ts syncReactors)가 같은 트랜잭션의 객체 수정과 합쳐 더한다.
 */
import type { CadDocument, DictionaryObject, DimensionEntity, Entity, GenericObject, Layer, Vec2, Vec3 } from '../../core/model';
import { entityDefaults, normalizeHandle, tableKey } from '../../core/model';
import { isNumberExpr, numberText } from '../constraint/params';
import type { Constraint, DimConstraint, GeoConstraint, GeoRef } from '../constraint/types';
import type { EditOp } from '../session';
import { ensureAssocClasses } from './array';
import { type CGroupData, type CNode, writeGroupRest, tryParseGroupRest } from './cgroup';
import { type Plane, toPlane, vecToPlane } from './constraints';
import { blockKeyOf, dictEntry } from './network';
import { type ActionHead, type AssocObjectData, type DependencyData, type EvalValue, parseAssocObject, valueOf, writeAssocObject } from './objects';
import { AssocPatch } from './patch';

export const CONSTRAINT_LAYER = '*ADSK_CONSTRAINTS';
const TAU = 2 * Math.PI;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);

// ---------------------------------------------------------------------------
// 쓸 수 있는지
// ---------------------------------------------------------------------------

type GeoKind = 'line' | 'circle' | 'arc';

/** 쓸 수 있는 형상 객체의 종류(선·원·호, 법선 +Z, 고도 0) */
function geoKind(e: Entity | undefined): GeoKind | null {
  if (!e) return null;
  const ex = (e as { extrusion?: Vec3 }).extrusion;
  if (ex && (Math.abs(ex.x) > 1e-12 || Math.abs(ex.y) > 1e-12 || ex.z <= 0)) return null;
  if (e.type === 'LINE') return Math.abs(e.start.z) < 1e-9 && Math.abs(e.end.z) < 1e-9 ? 'line' : null;
  if (e.type === 'CIRCLE') return Math.abs(e.center.z) < 1e-9 ? 'circle' : null;
  if (e.type === 'ARC') return Math.abs(e.center.z) < 1e-9 ? 'arc' : null;
  return null;
}

/** 참조 → (형상 종류, 암시 점 종류: −1 곡선 자체, 0 시작, 1 끝, 2 중간, 3 중심). 쓸 수 없으면 null */
function refSlot(doc: CadDocument, r: GeoRef): { kind: GeoKind; pt: number } | null {
  const kind = geoKind(doc.entityIndex.get(r.h));
  if (!kind) return null;
  if (r.part === '') return { kind, pt: -1 };
  if (kind === 'line') return r.part === 'S' ? { kind, pt: 0 } : r.part === 'E' ? { kind, pt: 1 } : r.part === 'M' ? { kind, pt: 2 } : null;
  if (kind === 'circle') return r.part === 'C' ? { kind, pt: 3 } : null;
  return r.part === 'S' ? { kind, pt: 0 } : r.part === 'E' ? { kind, pt: 1 } : r.part === 'C' ? { kind, pt: 3 } : null;
}

const isPoint = (s: { pt: number } | null) => !!s && s.pt >= 0;
const isCurve = (s: { pt: number } | null) => !!s && s.pt < 0;
const isRound = (s: { kind: GeoKind; pt: number } | null) => !!s && s.pt < 0 && (s.kind === 'circle' || s.kind === 'arc');
const isLine = (s: { kind: GeoKind; pt: number } | null) => !!s && s.pt < 0 && s.kind === 'line';

/** 이 구속을 AutoCAD 그룹 노드로 쓸 수 있는지(노드 클래스) — 쓸 수 없으면 null */
export function acadClassFor(doc: CadDocument, c: Constraint): string | null {
  const s = c.refs.map((r) => refSlot(doc, r));
  if (s.some((x) => !x)) return null;
  // 한 객체(공간) 안에서만
  if (new Set(c.refs.map((r) => blockKeyOf(doc, r.h))).size !== 1) return null;
  const [a, b] = s;
  if (c.kind === 'geo') {
    const g = c as GeoConstraint;
    switch (g.type) {
      case 'COINCIDENT':
        if (s.length !== 2) return null;
        if (isPoint(a) && isPoint(b)) return 'AcPointCoincidenceConstraint';
        if ((isPoint(a) && isCurve(b)) || (isCurve(a) && isPoint(b))) return 'AcPointCurveConstraint';
        return null;
      case 'PARALLEL':
        return s.length === 2 && isLine(a) && isLine(b) ? 'AcParallelConstraint' : null;
      case 'PERPENDICULAR':
        return s.length === 2 && isLine(a) && isLine(b) ? 'AcPerpendicularConstraint' : null;
      case 'COLLINEAR':
        return s.length === 2 && isLine(a) && isLine(b) ? 'AcColinearConstraint' : null;
      case 'TANGENT':
        return s.length === 2 && isCurve(a) && isCurve(b) && (isRound(a) || isRound(b)) ? 'AcTangentConstraint' : null;
      case 'CONCENTRIC':
        return s.length === 2 && isRound(a) && isRound(b) ? 'AcConcentricConstraint' : null;
      case 'EQUAL':
        if (s.length !== 2) return null;
        if (isLine(a) && isLine(b)) return 'AcEqualLengthConstraint';
        if (isRound(a) && isRound(b)) return 'AcEqualRadiusConstraint';
        return null;
      // 수평·수직은 선(표본에서 본 꼴 — 두 점 꼴은 실물이 없다), 고정은 점(곡선 고정은 실물이 없다)
      case 'HORIZONTAL':
      case 'VERTICAL':
        return s.length === 1 && isLine(a) ? (g.type === 'HORIZONTAL' ? 'AcHorizontalConstraint' : 'AcVerticalConstraint') : null;
      case 'FIX':
        return s.length === 1 && isPoint(a) ? 'AcFixedConstraint' : null;
      default:
        return null;
    }
  }
  const d = c as DimConstraint;
  // 식: 수 하나 또는 참조 구속(다른 매개변수를 쓰는 식은 변수 사이 종속의 DXF 배치를 확인하지 못했다)
  if (!d.reference && !isNumberExpr(d.expr)) return null;
  if (!d.name.trim() || !Number.isFinite(d.value)) return null;
  switch (d.type) {
    case 'DIST':
    case 'HDIST':
    case 'VDIST':
      return s.length === 2 && isPoint(a) && isPoint(b) ? 'AcDistanceConstraint' : null;
    case 'RADIUS':
    case 'DIAMETER':
      return s.length === 1 && isRound(a) ? 'AcRadiusDiameterConstraint' : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 망·그룹 찾기·만들기
// ---------------------------------------------------------------------------

function isDict(o: unknown): o is DictionaryObject {
  const t = (o as { type?: string } | undefined)?.type;
  return t === 'DICTIONARY' || t === 'ACDBDICTIONARYWDFLT';
}

function dataOf(p: AssocPatch, h: string | undefined): AssocObjectData | null {
  const o = p.obj(h) as GenericObject | undefined;
  if (!o?.raw?.length) return null;
  try {
    return parseAssocObject(o.type, o.raw);
  } catch {
    return null;
  }
}

const emptyLists = () => ({ a: 0, actionParams: [] as string[], b: 0, values: [] });

function head(version: number, network: string, index: number): ActionHead {
  const h: ActionHead = { version, status: 0, network, body: '', index, maxDep: 0, deps: [] };
  if (version >= 2) h.params = emptyLists();
  return h;
}

const newDict = (handle: string, owner: string, entries: [string, string][], hardOwner = false): DictionaryObject => ({
  type: 'DICTIONARY',
  handle,
  owner,
  reactors: [owner],
  entries: new Map(entries),
  hardOwner,
  cloning: 1,
});

const generic = (type: string, handle: string, owner: string, d: AssocObjectData, reactors?: string[]): GenericObject => ({
  type,
  handle,
  owner,
  ...(reactors ? { reactors } : {}),
  raw: writeAssocObject(d),
});

/** 공간(블록 키)의 망 핸들 — 없으면 최상위 망·공간 망을 만든다(루트 사전이 없으면 null) */
function ensureSpaceNetwork(p: AssocPatch, doc: CadDocument, blockKey: string, newHandle: () => string): string | null {
  const recEntry = [...doc.blockRecords.entries()].find(([k]) => k === blockKey) ?? [...doc.blockRecords.entries()].find(([, r]) => normalizeHandle(r.handle) === normalizeHandle(doc.blocks.get(blockKey)?.recordHandle ?? ''));
  if (!recEntry) return null;
  const [recKey, record0] = recEntry;
  // 앞선 작업이 바꾼 블록 레코드
  let record = record0;
  for (const op of p.ops) if (op.kind === 'blockRecord' && op.key === recKey && op.after) record = op.after;
  const xdict = record.xdict ? p.obj(record.xdict) : undefined;
  if (xdict && !isDict(xdict)) return null;
  const netDictH = xdict ? dictEntry(xdict as DictionaryObject, 'ACAD_ASSOCNETWORK') : undefined;
  const netDict = netDictH ? p.obj(netDictH) : undefined;
  if (netDictH && !isDict(netDict)) return null;
  const spaceNet = netDict ? dictEntry(netDict as DictionaryObject, 'ACAD_ASSOCNETWORK') : undefined;
  if (spaceNet) return dataOf(p, spaceNet)?.kind === 'network' ? spaceNet : null;
  // 최상위 망
  const rootH = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
  const root = rootH ? p.obj(rootH) : undefined;
  if (!isDict(root)) return null;
  let rootNet = '';
  const rdh = dictEntry(root, 'ACAD_ASSOCNETWORK');
  const rd = rdh ? p.obj(rdh) : undefined;
  if (rdh && !isDict(rd)) return null;
  if (rd) rootNet = dictEntry(rd as DictionaryObject, 'ACAD_ASSOCNETWORK') ?? '';
  if (rootNet && dataOf(p, rootNet)?.kind !== 'network') return null;
  if (!rootNet) {
    const dh = rdh ?? newHandle();
    rootNet = newHandle();
    if (!rd) {
      p.setObj(dh, newDict(dh, root.handle, [['ACAD_ASSOCNETWORK', rootNet]]));
      const entries = new Map(root.entries);
      entries.set('ACAD_ASSOCNETWORK', dh);
      p.setObj(root.handle, { ...root, entries });
    } else {
      const entries = new Map((rd as DictionaryObject).entries);
      entries.set('ACAD_ASSOCNETWORK', rootNet);
      p.setObj(dh, { ...(rd as DictionaryObject), entries });
    }
    p.setObj(rootNet, generic('ACDBASSOCNETWORK', rootNet, dh, { kind: 'network', head: head(2, '', 0), net: { version: 0, maxIndex: 0, actions: [], tail: [] } }, [dh]));
  }
  // 공간 망
  let xh = record.xdict ? normalizeHandle(record.xdict) : '';
  if (!xdict) {
    xh = newHandle();
    p.setObj(xh, newDict(xh, record.handle, [], true));
    p.ops.push({ kind: 'blockRecord', key: recKey, before: record0, after: { ...record, xdict: xh } });
  }
  const xd = p.obj(xh) as DictionaryObject;
  const dh = netDictH ?? newHandle();
  const net = newHandle();
  if (!netDict) {
    p.setObj(dh, newDict(dh, xh, [['ACAD_ASSOCNETWORK', net]]));
    const entries = new Map(xd.entries);
    entries.set('ACAD_ASSOCNETWORK', dh);
    p.setObj(xh, { ...xd, entries });
  } else {
    const entries = new Map((netDict as DictionaryObject).entries);
    entries.set('ACAD_ASSOCNETWORK', net);
    p.setObj(dh, { ...(netDict as DictionaryObject), entries });
  }
  const r = dataOf(p, rootNet);
  if (r?.kind !== 'network') return null;
  const idx = r.net.maxIndex + 1;
  p.setRaw(rootNet, writeAssocObject({ ...r, net: { ...r.net, maxIndex: idx, actions: [...r.net.actions, { h: net, owned: false }] } }));
  p.setObj(net, generic('ACDBASSOCNETWORK', net, dh, { kind: 'network', head: head(r.head.version, normalizeHandle(rootNet), idx), net: { version: 0, maxIndex: 0, actions: [], tail: [] } }, [dh]));
  return net;
}

/** 망에 동작을 더한다(360 소유) — 새 동작 번호 */
function addAction(p: AssocPatch, net: string, action: string): number {
  const d = dataOf(p, net);
  if (d?.kind !== 'network') return 0;
  const idx = d.net.maxIndex + 1;
  p.setRaw(net, writeAssocObject({ ...d, net: { ...d.net, maxIndex: idx, actions: [...d.net.actions, { h: normalizeHandle(action), owned: true }] } }));
  return idx;
}

// ---------------------------------------------------------------------------
// 그룹 편집 상태
// ---------------------------------------------------------------------------

interface GroupState {
  handle: string;
  net: string;
  head: ActionHead;
  g: CGroupData;
  pl: Plane;
  byId: Map<number, CNode>;
  /** 객체 핸들 → 형상 노드 번호 */
  geom: Map<string, number>;
  dirty: boolean;
}

/** 망의 그룹들(XY 평면) */
function groupsOf(p: AssocPatch, net: string): GroupState[] {
  const d = dataOf(p, net);
  if (d?.kind !== 'network') return [];
  const out: GroupState[] = [];
  for (const a of d.net.actions) {
    const o = p.obj(a.h) as GenericObject | undefined;
    if (o?.type.toUpperCase() !== 'ACDBASSOC2DCONSTRAINTGROUP') continue;
    const gd = dataOf(p, a.h);
    if (gd?.kind !== 'cgroup') continue;
    const g = tryParseGroupRest(gd.head.version, gd.rest);
    if (!g) continue;
    // 평면 법선이 Z축이고 축이 정규 직교일 때만
    const nz = g.xAxis.x * g.yAxis.y - g.xAxis.y * g.yAxis.x;
    if (Math.abs(nz - 1) > 1e-9 || Math.abs(g.xAxis.z) > 1e-12 || Math.abs(g.yAxis.z) > 1e-12 || Math.abs(g.origin.z) > 1e-9) continue;
    const st: GroupState = { handle: normalizeHandle(a.h), net, head: gd.head, g, pl: { o: g.origin, x: g.xAxis, y: g.yAxis }, byId: new Map(g.nodes.map((n) => [n.id, n])), geom: new Map(), dirty: false };
    for (const n of g.nodes) {
      if (n.cls === 'AcConstrainedImplicitPoint' || n.cls === 'AcConstrainedDatumLine' || !n.f.dep) continue;
      const dep = dataOf(p, n.f.dep as string);
      if (dep?.kind === 'geomdep' && dep.dep.target && dep.geom.subentClass === 'AcDbAssocSingleEdgePersSubentId') st.geom.set(dep.dep.target, n.id);
    }
    out.push(st);
  }
  return out;
}

function newGroup(p: AssocPatch, net: string, newHandle: () => string): GroupState | null {
  const nd = dataOf(p, net);
  if (nd?.kind !== 'network') return null;
  const h = newHandle();
  const version = nd.head.version;
  const g: CGroupData = { version, gversion: 2, g70: 0, origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, g360: '', deps: [], seed: 0, ...(version >= 2 ? { v2: { a: 0, b: 0, c: false } } : {}), nodes: [] };
  const hd = head(version, normalizeHandle(net), 0);
  p.setObj(h, { type: 'ACDBASSOC2DCONSTRAINTGROUP', handle: h, owner: normalizeHandle(net), raw: [] } as GenericObject);
  hd.index = addAction(p, net, h);
  return { handle: normalizeHandle(h), net: normalizeHandle(net), head: hd, g, pl: { o: g.origin, x: g.xAxis, y: g.yAxis }, byId: new Map(), geom: new Map(), dirty: true };
}

function saveGroup(p: AssocPatch, st: GroupState): void {
  p.setRaw(st.handle, [...writeAssocObject({ kind: 'action', head: st.head }), ...writeGroupRest(st.g, st.handle)]);
}

// ---------------------------------------------------------------------------
// 노드 만들기
// ---------------------------------------------------------------------------

class Writer {
  constructor(
    readonly p: AssocPatch,
    readonly doc: CadDocument,
    readonly newHandle: () => string,
  ) {}

  nextId(st: GroupState): number {
    let m = st.g.seed;
    for (const n of st.g.nodes) if (n.id > m) m = n.id;
    st.g.seed = m + 1;
    return m + 1;
  }

  node(st: GroupState, cls: string, f: CNode['f'], links: number[] = []): CNode {
    const n: CNode = { cls, id: this.nextId(st), owner: '', flags: 0, links, f };
    st.g.nodes.push(n);
    st.byId.set(n.id, n);
    st.dirty = true;
    return n;
  }

  link(st: GroupState, id: number, to: number): void {
    const n = st.byId.get(id);
    if (n && !n.links.includes(to)) n.links.push(to);
  }

  /** 의존(종속) 하나: 그룹 소유, 동작 안 번호는 그룹 머리의 최대 번호 다음 */
  dep(st: GroupState, d: Omit<DependencyData, 'version' | 'status' | 'f3' | 'f4' | 'f5' | 'prev' | 'next' | 'index'>): DependencyData & { handle: string } {
    st.head.maxDep += 1;
    const handle = normalizeHandle(this.newHandle());
    st.g.deps.push(handle);
    return { version: 2, status: 0, f3: true, f4: true, f5: false, prev: '', next: '', index: st.head.maxDep, ...d, handle };
  }

  /** 객체의 형상 노드(없으면 형상 종속·암시 점과 함께 만든다) */
  geometry(st: GroupState, h: string): number {
    const k = normalizeHandle(h);
    const have = st.geom.get(k);
    if (have !== undefined) return have;
    const e = this.doc.entityIndex.get(k)!;
    const kind = geoKind(e)!;
    const d = this.dep(st, { read: true, write: true, order: -10000, target: k, body: '' });
    const { handle: dh, ...dd } = d;
    // 같은 객체의 앞 종속(반응자에 있는 연관 종속 중 뒤 종속이 없는 것)과 잇는다
    for (const r of e.reactors ?? []) {
      const x = dataOf(this.p, r);
      if (!x || !('dep' in x) || x.dep.target !== k || x.dep.next) continue;
      dd.prev = normalizeHandle(r);
      this.p.setRaw(r, writeAssocObject({ ...x, dep: { ...x.dep, next: dh } } as AssocObjectData));
      break;
    }
    this.p.setObj(dh, generic('ACDBASSOCGEOMDEPENDENCY', dh, st.handle, { kind: 'geomdep', dep: dd, geom: { version: 0, flag: true, subentClass: 'AcDbAssocSingleEdgePersSubentId', subent: [], flag2: false } }));
    const P = (v: Vec2) => toPlane(st.pl, v, 0);
    const base = { dep: dh, gx: 0 };
    let n: CNode;
    if (kind === 'line') {
      const a = P(e.type === 'LINE' ? e.start : { x: 0, y: 0 });
      const b = P(e.type === 'LINE' ? e.end : { x: 0, y: 0 });
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      n = this.node(st, 'AcConstrainedBoundedLine', { ...base, point: a, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l, z: 0 }, ray: 0, start: a, end: b });
    } else {
      const c = e as Extract<Entity, { type: 'CIRCLE' | 'ARC' }>;
      const f: CNode['f'] = { ...base, center: P(c.center), normal: { x: 0, y: 0, z: 1 }, ref: vecToPlane(st.pl, { x: 1, y: 0 }), radius: c.radius, a0: 0, a1: TAU };
      if (st.g.version >= 2) f.cx = 0;
      if (c.type === 'ARC') {
        f.start = P({ x: c.center.x + c.radius * Math.cos(c.startAngle), y: c.center.y + c.radius * Math.sin(c.startAngle) });
        f.end = P({ x: c.center.x + c.radius * Math.cos(c.endAngle), y: c.center.y + c.radius * Math.sin(c.endAngle) });
      }
      n = this.node(st, c.type === 'ARC' ? 'AcConstrainedArc' : 'AcConstrainedCircle', f);
    }
    st.geom.set(k, n.id);
    // 암시 점(표본의 차례): 선 시작·끝, 원 중심, 호 시작·끝·중심
    const pts = kind === 'line' ? [0, 1] : kind === 'circle' ? [3] : [0, 1, 3];
    for (const t of pts) this.implicit(st, n.id, t);
    return n.id;
  }

  /** 곡선의 암시 점(없으면 만든다 — 붙임 구속과 함께) */
  implicit(st: GroupState, curve: number, ptype: number): number {
    for (const n of st.g.nodes) if (n.cls === 'AcConstrainedImplicitPoint' && n.f.curve === curve && n.f.ptype === ptype && n.f.index === -1) return n.id;
    const pt = this.node(st, 'AcConstrainedImplicitPoint', { dep: '', gx: 0, ptype, index: -1, curve });
    const glue = (cls: string) => {
      const c = this.node(st, cls, { cx: 0, implied: 1, enabled: 1 }, [pt.id, curve]);
      pt.links.push(c.id);
      this.link(st, curve, c.id);
    };
    if (ptype === 3) glue('AcCenterPointConstraint');
    else {
      glue('AcPointCurveConstraint');
      if (ptype === 2) glue('AcMidPointConstraint');
    }
    return pt.id;
  }

  /** 참조 → 노드 번호 */
  ref(st: GroupState, r: GeoRef): number {
    const s = refSlot(this.doc, r)!;
    const g = this.geometry(st, r.h);
    return s.pt < 0 ? g : this.implicit(st, g, s.pt);
  }

  /** 기준선(방향이 평행한 것이 있으면 그것) */
  datum(st: GroupState, dir: Vec3): number {
    for (const n of st.g.nodes) {
      if (n.cls !== 'AcConstrainedDatumLine') continue;
      const d = n.f.dir as Vec3;
      if (Math.abs(d.x * dir.y - d.y * dir.x) < 1e-9 && d.x * dir.x + d.y * dir.y > 0) return n.id;
    }
    return this.node(st, 'AcConstrainedDatumLine', { dep: '', gx: 0, point: { x: 0, y: 0, z: 0 }, dir }).id;
  }

  constraintNode(st: GroupState, cls: string, ids: number[], extra: CNode['f'] = {}): CNode {
    const n = this.node(st, cls, { cx: 0, implied: 0, enabled: 1, ...extra }, ids);
    for (const id of ids) this.link(st, id, n.id);
    return n;
  }
}

// ---------------------------------------------------------------------------
// 치수 구속의 변수·종속·숨은 치수
// ---------------------------------------------------------------------------

function ensureLayer(doc: CadDocument, p: AssocPatch, newHandle: () => string): void {
  const k = tableKey(CONSTRAINT_LAYER);
  if (doc.layers.has(k) || p.ops.some((o) => o.kind === 'layer' && o.key === k)) return;
  const layer: Layer = { name: CONSTRAINT_LAYER, handle: newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
  p.ops.push({ kind: 'layer', key: k, before: null, after: layer });
}

function dimStyleName(doc: CadDocument): string {
  const h = doc.header.get('$DIMSTYLE');
  const want = typeof h === 'string' ? h : '';
  if (want && doc.dimStyles.has(tableKey(want))) return doc.dimStyles.get(tableKey(want))!.name;
  const first = [...doc.dimStyles.values()][0];
  return first?.name ?? 'Standard';
}

/** 숨은 치수의 점들(작업 평면 = 블록 좌표, 이 앱 치수선 자리 offset을 따른다 — constraints.ts의 prepareDim과 거꾸로) */
function hiddenDim(doc: CadDocument, c: DimConstraint, pts: Vec2[], circle: { c: Vec2; r: number } | null): Partial<DimensionEntity> & { dimType: number } {
  const v3 = (q: Vec2): Vec3 => ({ x: q.x, y: q.y, z: 0 });
  const zero = { x: 0, y: 0, z: 0 };
  if (circle) {
    const a = c.offset;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const near = { x: circle.c.x + circle.r * u.x, y: circle.c.y + circle.r * u.y };
    if (c.type === 'RADIUS') return { dimType: 132, defPoint: v3(circle.c), textMid: v3(near), defPoint2: zero, defPoint3: zero, defPoint4: v3(near), rotation: 0 };
    const far = { x: circle.c.x - circle.r * u.x, y: circle.c.y - circle.r * u.y };
    return { dimType: 131, defPoint: v3(far), textMid: v3(near), defPoint2: zero, defPoint3: zero, defPoint4: v3(near), rotation: 0 };
  }
  const [p, q] = pts as [Vec2, Vec2];
  const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const axis = c.axis ?? 0;
  const ax = { x: Math.cos(axis), y: Math.sin(axis) };
  const ay = { x: -ax.y, y: ax.x };
  let at: Vec2;
  let dimType = 128;
  let rotation = 0;
  if (c.type === 'DIST') {
    const l = len(sub(q, p)) || 1;
    const n = { x: -(q.y - p.y) / l, y: (q.x - p.x) / l };
    at = { x: m.x + c.offset * n.x, y: m.y + c.offset * n.y };
    dimType = 161;
  } else if (c.type === 'HDIST') {
    at = { x: m.x + c.offset * ay.x, y: m.y + c.offset * ay.y };
    rotation = axis;
  } else {
    at = { x: m.x + c.offset * ax.x, y: m.y + c.offset * ax.y };
    rotation = axis + Math.PI / 2;
  }
  void doc;
  return { dimType, defPoint: v3(at), textMid: v3(at), defPoint2: v3(p), defPoint3: v3(q), defPoint4: zero, rotation };
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export interface AcadWriteResult {
  ops: EditOp[];
  /** 쓴 이 앱 구속 번호 → 그룹·노드 */
  written: Map<number, { group: string; node: number }>;
}

/**
 * 이 앱 구속(acad 연결이 없는 것) 가운데 쓸 수 있는 것을 AutoCAD 구속 그룹에 쓰는 작업. prior: 같은 트랜잭션의 앞선 작업
 * (그 결과 위에 쓴다). 돌려준 ops는 prior 다음에 붙일 작업만이다.
 */
export function acadWriteOps(doc: CadDocument, constraints: readonly Constraint[], prior: readonly EditOp[], newHandle: () => string): AcadWriteResult {
  const written = new Map<number, { group: string; node: number }>();
  const todo = constraints.filter((c) => !c.acad && acadClassFor(doc, c));
  if (!todo.length) return { ops: [], written };
  const p = new AssocPatch(doc, prior);
  const w = new Writer(p, doc, newHandle);
  // 망 안의 변수 이름(대소문자 무시) — 겹치면 그 구속은 쓰지 않는다
  const varNames = new Map<string, Set<string>>();
  const namesOf = (net: string): Set<string> => {
    let s = varNames.get(net);
    if (s) return s;
    s = new Set();
    const d = dataOf(p, net);
    if (d?.kind === 'network')
      for (const a of d.net.actions) {
        const v = dataOf(p, a.h);
        if (v?.kind === 'variable') s.add(v.variable.name.toLowerCase());
      }
    varNames.set(net, s);
    return s;
  };
  const states = new Map<string, GroupState[]>();
  const touched = new Set<GroupState>();
  const classes = new Set<string>(['ACDBASSOCNETWORK', 'ACDBASSOC2DCONSTRAINTGROUP', 'ACDBASSOCGEOMDEPENDENCY']);
  for (const c of todo) {
    const cls = acadClassFor(doc, c)!;
    const blockKey = blockKeyOf(doc, c.refs[0]!.h);
    if (!blockKey) continue;
    const net = ensureSpaceNetwork(p, doc, blockKey, newHandle);
    if (!net) continue;
    const dim = c.kind === 'dim' ? (c as DimConstraint) : null;
    if (dim && namesOf(net).has(dim.name.toLowerCase())) continue;
    let list = states.get(net);
    if (!list) states.set(net, (list = groupsOf(p, net)));
    // 객체가 이미 들어 있는 그룹, 없으면 첫 그룹, 없으면 새 그룹. 다른 그룹(다른 평면 포함)의 형상 종속이 걸린 객체면 쓰지 않는다
    const hs = [...new Set(c.refs.map((r) => normalizeHandle(r.h)))];
    const holders = list.filter((st) => hs.some((h) => st.geom.has(h)));
    if (holders.length > 1) continue;
    let st = holders[0] ?? list[0];
    const foreign = hs.some((h) =>
      (doc.entityIndex.get(h)?.reactors ?? []).some((r) => {
        const x = dataOf(p, r);
        return x?.kind === 'geomdep' && x.dep.target === h && !st?.g.deps.includes(normalizeHandle(r));
      }),
    );
    if (foreign) continue;
    // 치수 구속의 숨은 치수 자리(형상을 못 읽으면 쓰지 않는다)
    let hd: ReturnType<typeof hiddenDim> | null = null;
    let pts: Vec2[] = [];
    if (dim) {
      const geo = new GeoReader(doc);
      const isCircle = dim.type === 'RADIUS' || dim.type === 'DIAMETER';
      const circle = isCircle ? geo.circle(dim.refs[0]!) : null;
      const raw = isCircle ? [] : dim.refs.map((r) => geo.point(r));
      if ((isCircle && !circle) || raw.some((x) => !x)) continue;
      pts = raw as Vec2[];
      hd = hiddenDim(doc, dim, pts, circle);
    }
    if (!st) {
      const ng = newGroup(p, net, newHandle);
      if (!ng) continue;
      list.push(ng);
      st = ng;
    }
    touched.add(st);
    const ids = c.refs.map((r) => w.ref(st!, r));
    let node: CNode;
    if (!dim) {
      const g = c as GeoConstraint;
      let order = ids;
      if (cls === 'AcPointCurveConstraint') {
        // 표본은 [점, 곡선]
        const s0 = refSlot(doc, c.refs[0]!)!;
        if (s0.pt < 0) order = [ids[1]!, ids[0]!];
      }
      const extra: CNode['f'] = {};
      if (g.type === 'HORIZONTAL' || g.type === 'VERTICAL') {
        const a = (g.axis ?? 0) + (g.type === 'VERTICAL' ? Math.PI / 2 : 0);
        const d = vecToPlane(st.pl, { x: Math.cos(a), y: Math.sin(a) });
        extra.datum = w.datum(st, { x: Math.abs(d.x) < 1e-15 ? 0 : d.x, y: Math.abs(d.y) < 1e-15 ? 0 : d.y, z: 0 });
      }
      node = w.constraintNode(st, cls, order, extra);
    } else {
      // 변수(망 소유)
      const vh = normalizeHandle(newHandle());
      const expr = dim.reference ? '' : dim.expr.trim();
      const value: EvalValue = dim.reference ? { code: 40, v: dim.value } : valueOf(dim.value, expr);
      const vd = w.dep(st, { read: true, write: false, order: 0, target: vh, body: '' });
      const dd = w.dep(st, { read: false, write: true, order: 0, target: '', body: '' });
      const bodyH = normalizeHandle(newHandle());
      const dimH = normalizeHandle(newHandle());
      dd.target = dimH;
      dd.body = bodyH;
      const vIndex = addAction(p, net, vh);
      const vHead = head(st.head.version, net, vIndex);
      p.setObj(vh, generic('ACDBASSOCVARIABLE', vh, net, { kind: 'variable', head: vHead, variable: { version: 2, name: dim.name, expr, evaluator: 'AcDbCalc:1.0', description: dim.description ?? '', value, b1: false, b2: false, tail: 0 } }, [vd.handle]));
      const { handle: vdh, ...vdd } = vd;
      p.setObj(vdh, generic('ACDBASSOCVALUEDEPENDENCY', vdh, st.handle, { kind: 'valuedep', dep: vdd, value: { version: 0, name: '', value } }));
      const { handle: ddh, ...ddd } = dd;
      p.setObj(ddh, generic('ACDBASSOCDEPENDENCY', ddh, st.handle, { kind: 'dependency', dep: ddd }));
      const text = `${dim.name}=${dim.reference ? numberText(dim.value) : expr}`;
      p.setObj(bodyH, generic('ASSOCDIMDEPENDENCYBODY', bodyH, ddh, { kind: 'dimbody', body: { v1: 1, v2: 1, text, v3: 1 } }));
      // 숨은 치수
      ensureLayer(doc, p, newHandle);
      const space = doc.blocks.get(blockKey);
      const ent = {
        ...entityDefaults(),
        type: 'DIMENSION',
        handle: dimH,
        owner: space?.recordHandle ?? '',
        layer: CONSTRAINT_LAYER,
        invisible: true,
        reactors: [ddh],
        block: '',
        dimStyle: dimStyleName(doc),
        defPoint: { x: 0, y: 0, z: 0 },
        textMid: { x: 0, y: 0, z: 0 },
        defPoint2: { x: 0, y: 0, z: 0 },
        defPoint3: { x: 0, y: 0, z: 0 },
        defPoint4: { x: 0, y: 0, z: 0 },
        defPoint5: { x: 0, y: 0, z: 0 },
        text,
        measurement: dim.value,
        rotation: 0,
        obliqueAngle: 0,
        textRotation: 0,
        horizontalDirection: 0,
        attachment: 5,
        leaderLength: 0,
        lineSpacingStyle: 1,
        lineSpacingFactor: 1,
        ...hd!,
      } as unknown as DimensionEntity;
      p.ops.push({ kind: 'add', block: blockKey, entity: ent });
      const extra: CNode['f'] = { valueDep: vdh, dimDep: ddh };
      if (cls === 'AcRadiusDiameterConstraint') extra.rtype = dim.type === 'DIAMETER' ? 1 : 0;
      else if (dim.type === 'DIST') extra.dirType = 0;
      else {
        // 방향 거리: 방향 벡터는 둘째 점에서 첫째 점 쪽(표본)
        const axis = (dim.axis ?? 0) + (dim.type === 'VDIST' ? Math.PI / 2 : 0);
        const u = { x: Math.cos(axis), y: Math.sin(axis) };
        const sgn = dot(sub(pts[0]!, pts[1]!), u) < 0 ? -1 : 1;
        const d = vecToPlane(st.pl, { x: u.x * sgn, y: u.y * sgn });
        extra.dirType = 1;
        extra.dir = { x: Math.abs(d.x) < 1e-15 ? 0 : d.x, y: Math.abs(d.y) < 1e-15 ? 0 : d.y, z: 0 };
      }
      node = w.constraintNode(st, cls, ids, extra);
      namesOf(net).add(dim.name.toLowerCase());
      for (const t of ['ACDBASSOCVARIABLE', 'ACDBASSOCVALUEDEPENDENCY', 'ACDBASSOCDEPENDENCY', 'ASSOCDIMDEPENDENCYBODY']) classes.add(t);
    }
    written.set(c.id, { group: st.handle, node: node.id });
  }
  for (const st of touched) if (st.dirty) saveGroup(p, st);
  if (written.size) ensureAssocClasses(doc, [...classes]);
  return { ops: written.size ? p.ops.slice(prior.length) : [], written };
}

/** 지금 형상의 점·원(블록 좌표) */
class GeoReader {
  constructor(readonly doc: CadDocument) {}
  point(r: GeoRef): Vec2 | null {
    const e = this.doc.entityIndex.get(r.h);
    if (!e) return null;
    if (e.type === 'LINE') return r.part === 'S' ? e.start : r.part === 'E' ? e.end : r.part === 'M' ? { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 } : null;
    if (e.type === 'CIRCLE') return r.part === 'C' ? e.center : null;
    if (e.type === 'ARC') {
      if (r.part === 'C') return e.center;
      const a = r.part === 'S' ? e.startAngle : r.part === 'E' ? e.endAngle : NaN;
      return Number.isFinite(a) ? { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) } : null;
    }
    return null;
  }
  circle(r: GeoRef): { c: Vec2; r: number } | null {
    const e = this.doc.entityIndex.get(r.h);
    return e && (e.type === 'CIRCLE' || e.type === 'ARC') ? { c: e.center, r: e.radius } : null;
  }
}
