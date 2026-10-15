/**
 * 이 앱에서 고친 AutoCAD 구속을 원본 연관 망에 같은 형식으로 고쳐 쓴다.
 *
 *  - 치수 구속의 이름·식·값(값 종속이 가리키는 ACDBASSOCVARIABLE의 1 이름·1 식·값, 값 종속의 캐시 값,
 *    치수 종속 몸체의 글 "d1=10", 숨은 치수 객체의 문자·측정값)과 사용자 매개변수(그룹에 묶이지 않은 변수).
 *  - 구속을 지우면 그 노드를 그룹에서 빼고(이웃 목록에서도 뺀다), 치수 구속이면 값 종속·치수 종속·종속 몸체·
 *    숨은 치수 객체·변수(망의 동작 목록에서도)를 함께 지운다.
 *  - 형상이 바뀌면 형상 노드의 캐시 좌표(선: 점·방향·시작·끝, 원: 중심·반지름, 호: + 시작·끝)를 작업 평면 좌표로 고친다.
 *  - 객체를 지우면 그 형상 노드·암시 점·이어진 구속 노드와 형상 종속을 뺀다(AutoCAD가 객체를 지울 때처럼).
 *  - 확정 고리(acadCommitOps)는 연관 종속과 대상 객체의 반응자도 맞춘다(syncReactors).
 * 이 앱에서 새로 만든 구속을 AutoCAD 그룹에 쓰는 것은 cwrite.ts(쓸 수 없는 종류만 이 앱 기록 OPENCAD_CONSTRAINTS에 남는다).
 */
import type { CadDocument, CadObject, DimensionEntity, GenericObject, Vec2, Vec3 } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { numberText } from '../constraint/params';
import { pointOf, curveOf } from '../constraint/prims';
import { buildSystem } from '../constraint/system';
import type { ConstraintStore, DimConstraint, UserParam } from '../constraint/types';
import type { EditOp } from '../session';
import { type CGroupData, type CNode, GEOMETRY_CLASSES, writeGroupRest } from './cgroup';
import { type GroupImport, acadNames, importAcadConstraints, importGroup, planeOf, toPlane, vecToPlane } from './constraints';
import { assocData } from './network';
import { type ActionHead, type AssocObjectData, type VariableData, parseAssocObject, valueOf, writeAssocObject } from './objects';
import { AssocPatch } from './patch';
import { tryParseGroupRest } from './cgroup';

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 지금(작업을 반영한) 객체의 해석 */
function dataOf(p: AssocPatch, h: string | undefined): AssocObjectData | null {
  const o = p.obj(h) as GenericObject | undefined;
  if (!o?.raw) return null;
  try {
    return parseAssocObject(o.type, o.raw);
  } catch {
    return null;
  }
}

function groupOf(p: AssocPatch, h: string): { head: ActionHead; g: CGroupData } | null {
  const d = dataOf(p, h);
  if (d?.kind !== 'cgroup') return null;
  const g = tryParseGroupRest(d.head.version, d.rest);
  return g ? { head: d.head, g } : null;
}

function saveGroup(p: AssocPatch, h: string, head: ActionHead, g: CGroupData): void {
  const raw = [...writeAssocObject({ kind: 'action', head }), ...writeGroupRest(g, normalizeHandle(h))];
  p.setRaw(h, raw);
}

// ---------------------------------------------------------------------------
// 변수
// ---------------------------------------------------------------------------

/** 치수 글: 옛 글의 꼴("이름=값" / "값", 소수 자리)을 따른다 */
export function dimText(old: string, name: string, value: number): string {
  const m = /^(.*?)=(.*)$/.exec(old);
  const numPart = m ? m[2]! : old;
  const dec = /\.(\d+)/.exec(numPart)?.[1]?.length ?? 0;
  const v = dec > 0 ? value.toFixed(dec) : numberText(value);
  return m ? `${name}=${v}` : v;
}

interface VarPatch {
  name: string;
  expr: string;
  value: number;
  description?: string;
}

/** 변수와 그 값 종속·치수 글을 고친다 */
function updateVariable(p: AssocPatch, varHandle: string, next: VarPatch, links: { valueDep?: string; dimDep?: string } = {}): void {
  const d = dataOf(p, varHandle);
  if (d?.kind !== 'variable') return;
  const v: VariableData = { ...d.variable, name: next.name, expr: next.expr, value: valueOf(next.value, next.expr.trim() ? next.expr : undefined), description: next.description ?? '' };
  const same = v.name === d.variable.name && v.expr === d.variable.expr && v.description === d.variable.description && v.value.code === d.variable.value.code && v.value.v === d.variable.value.v;
  if (!same) p.setRaw(varHandle, writeAssocObject({ ...d, variable: v }));
  if (links.valueDep) {
    const vd = dataOf(p, links.valueDep);
    if (vd?.kind === 'valuedep' && (vd.value.value.code !== v.value.code || vd.value.value.v !== v.value.v)) p.setRaw(links.valueDep, writeAssocObject({ ...vd, value: { ...vd.value, value: v.value } }));
  }
  if (links.dimDep) {
    const dd = dataOf(p, links.dimDep);
    if (dd?.kind !== 'dependency') return;
    const body = dataOf(p, dd.dep.body);
    let oldText = '';
    if (body?.kind === 'dimbody') {
      oldText = body.body.text;
      const text = dimText(body.body.text, next.name, next.value);
      if (text !== body.body.text) p.setRaw(dd.dep.body, writeAssocObject({ ...body, body: { ...body.body, text } }));
    }
    const e = dd.dep.target ? p.entity(dd.dep.target) : undefined;
    if (e?.type === 'DIMENSION') {
      const dim = e as DimensionEntity;
      const text = dim.text && dim.text === oldText ? dimText(dim.text, next.name, next.value) : dim.text;
      if (text !== dim.text || dim.measurement !== next.value) p.modifyEntity({ ...dim, text, measurement: next.value });
    }
  }
}

/** 변수를 지운다(소유 망의 동작 목록에서도) */
function deleteVariable(p: AssocPatch, varHandle: string): void {
  const d = dataOf(p, varHandle);
  if (d?.kind !== 'variable') return;
  const net = dataOf(p, d.head.network);
  if (net?.kind === 'network') {
    const k = normalizeHandle(varHandle);
    const actions = net.net.actions.filter((a) => a.h !== k);
    if (actions.length !== net.net.actions.length) p.setRaw(d.head.network, writeAssocObject({ ...net, net: { ...net.net, actions } }));
  }
  p.deleteObj(varHandle);
}

// ---------------------------------------------------------------------------
// 노드 빼기
// ---------------------------------------------------------------------------

/** 치수 구속 노드에 딸린 객체(값 종속·변수·치수 종속·몸체·치수 객체)를 지운다 */
function deleteExplicit(p: AssocPatch, n: CNode, g: CGroupData): void {
  const vdh = n.f.valueDep as string | undefined;
  const ddh = n.f.dimDep as string | undefined;
  if (vdh) {
    const vd = dataOf(p, vdh);
    if (vd?.kind === 'valuedep' && vd.dep.target) {
      // 다른 노드의 값 종속이 같은 변수를 가리키지 않을 때만 변수를 지운다
      const varOf = (h: string): string => {
        const x = dataOf(p, h);
        return x?.kind === 'valuedep' ? x.dep.target : '';
      };
      const shared = g.nodes.some((m) => m !== n && typeof m.f.valueDep === 'string' && m.f.valueDep && normalizeHandle(m.f.valueDep) !== normalizeHandle(vdh) && varOf(m.f.valueDep) === vd.dep.target);
      if (!shared) deleteVariable(p, vd.dep.target);
    }
    p.deleteObj(vdh);
  }
  if (ddh) {
    const dd = dataOf(p, ddh);
    if (dd?.kind === 'dependency') {
      if (dd.dep.body) p.deleteObj(dd.dep.body);
      if (dd.dep.target && p.entity(dd.dep.target)?.type === 'DIMENSION') p.removeEntity(dd.dep.target);
    }
    p.deleteObj(ddh);
  }
  const gone = new Set([vdh, ddh].filter((x): x is string => !!x).map(normalizeHandle));
  g.deps = g.deps.filter((h) => !gone.has(h));
}

/** 노드를 빼고 이웃 목록을 고친다(치수 구속이면 딸린 객체도 지운다) */
function removeNodes(p: AssocPatch, g: CGroupData, ids: ReadonlySet<number>): void {
  if (!ids.size) return;
  for (const n of g.nodes) if (ids.has(n.id) && (n.f.valueDep || n.f.dimDep)) deleteExplicit(p, n, g);
  g.nodes = g.nodes.filter((n) => !ids.has(n.id));
  for (const n of g.nodes) n.links = n.links.filter((l) => !ids.has(l));
}

/** 형상 노드(와 그 암시 점, 이어진 구속)를 뺄 번호 */
function geometryClosure(g: CGroupData, geomIds: Iterable<number>): Set<number> {
  const out = new Set<number>(geomIds);
  for (const n of g.nodes) if (n.cls === 'AcConstrainedImplicitPoint' && out.has(n.f.curve as number)) out.add(n.id);
  for (const n of g.nodes) if (!GEOMETRY_CLASSES.has(n.cls) && n.links.some((l) => out.has(l))) out.add(n.id);
  return out;
}

// ---------------------------------------------------------------------------
// 구속 기록 → 원본
// ---------------------------------------------------------------------------

function sameDim(a: DimConstraint, b: DimConstraint): boolean {
  return a.name === b.name && a.expr === b.expr && a.reference === b.reference && Math.abs(a.value - b.value) <= 1e-12 * Math.max(1, Math.abs(a.value)) && (a.description ?? '') === (b.description ?? '');
}

function varPatchOf(c: DimConstraint): VarPatch {
  return { name: c.name, expr: c.reference ? '' : c.expr, value: c.value, ...(c.description ? { description: c.description } : {}) };
}

/**
 * 구속 기록의 AutoCAD 부분(acad 연결이 있는 구속·매개변수)을 원본 그룹·변수에 반영하는 작업.
 * ops: 같은 트랜잭션의 앞선 작업(그 결과 위에 고친다). 바뀐 것이 없으면 빈 배열.
 */
export function acadStoreOps(doc: CadDocument, s: ConstraintStore, ops: readonly EditOp[] = []): EditOp[] {
  const imp = importAcadConstraints(doc);
  if (!imp.constraints.length && !imp.userParams.length) return [];
  const p = new AssocPatch(doc, ops);
  const want = new Map<string, DimConstraint | null>();
  for (const c of s.constraints) if (c.acad) want.set(`${normalizeHandle(c.acad.group)}:${c.acad.node}`, c.kind === 'dim' ? c : null);
  for (const gi of imp.groups) {
    const kill = new Set<number>();
    const changed: { node: number; c: DimConstraint }[] = [];
    for (const [node, c] of gi.constraints) {
      const key = `${gi.group}:${node}`;
      if (!want.has(key)) {
        kill.add(node);
        continue;
      }
      const w = want.get(key);
      if (c.kind === 'dim' && w && !sameDim(c, w)) changed.push({ node, c: w });
    }
    if (!kill.size && !changed.length) continue;
    const cur = groupOf(p, gi.group);
    if (!cur) continue;
    for (const { node, c } of changed) {
      const n = cur.g.nodes.find((x) => x.id === node);
      const vdh = n?.f.valueDep as string | undefined;
      if (!n || !vdh) continue;
      const vh = gi.variables.get(normalizeHandle(vdh));
      if (!vh) continue;
      const vp = varPatchOf(c);
      const nm = acadNames(imp, imp.networkOf.get(gi.group) ?? '', vp.name, vp.expr);
      updateVariable(p, vh, { ...vp, ...nm }, { valueDep: vdh, dimDep: n.f.dimDep as string | undefined });
    }
    if (kill.size) {
      removeNodes(p, cur.g, kill);
      saveGroup(p, gi.group, cur.head, cur.g);
    }
  }
  // 사용자 매개변수(그룹에 묶이지 않은 변수)
  const wantU = new Map<string, UserParam>();
  for (const u of s.userParams) if (u.acad) wantU.set(normalizeHandle(u.acad), u);
  for (const u of imp.userParams) {
    const h = normalizeHandle(u.acad!);
    const w = wantU.get(h);
    if (!w) {
      deleteVariable(p, h);
      continue;
    }
    if (w.name !== u.name || w.expr !== u.expr || (w.description ?? '') !== (u.description ?? '') || Math.abs(w.value - u.value) > 1e-12 * Math.max(1, Math.abs(w.value))) {
      const nm = acadNames(imp, imp.networkOf.get(h) ?? '', w.name, w.expr);
      updateVariable(p, h, { ...nm, value: w.value, ...(w.description ? { description: w.description } : {}) });
    }
  }
  // 앞선 작업(ops)의 객체를 고친 것은 그 작업 안에서 바뀐다(같은 객체를 두 번 바꾸지 않는다)
  return p.ops.slice(ops.length);
}

// ---------------------------------------------------------------------------
// 형상이 바뀐 트랜잭션 → 캐시 좌표·지운 객체
// ---------------------------------------------------------------------------

/** 형상 노드의 방향(노드 시작점이 객체의 어느 부분인지) — 바뀌기 전 형상으로 정한다 */
function startPart(doc: CadDocument, gi: GroupImport, n: CNode, ref: { h: string; part: string }): string | null {
  // 암시 점(시작 = 0)이 있으면 그 부분
  for (const m of gi.data.nodes) if (m.cls === 'AcConstrainedImplicitPoint' && m.f.curve === n.id && m.f.ptype === 0) {
    const r = gi.refs.get(m.id);
    if (r) return r.part;
  }
  const seg = ref.part.startsWith('G') ? Number(ref.part.slice(1)) : -1;
  const sys = buildSystem((h) => doc.entityIndex.get(h), [], [ref.h]);
  const pr = sys.prims.get(ref.h);
  if (!pr || !n.f.start) return null;
  const pl = planeOf(gi.data);
  const s0 = n.f.start as Vec3;
  const want = { x: pl.o.x + s0.x * pl.x.x + s0.y * pl.y.x, y: pl.o.y + s0.x * pl.x.y + s0.y * pl.y.y };
  const cands = seg >= 0 && pr.k === 'poly' ? [`V${seg}`, `V${(seg + 1) % pr.v.length}`] : ['S', 'E'];
  let best: string | null = null;
  let bd = Infinity;
  for (const c of cands) {
    const q = pointOf(pr, c, sys.vars.x);
    if (q && dist(q, want) < bd) {
      bd = dist(q, want);
      best = c;
    }
  }
  return best;
}

function otherEnd(part: string, nVerts: number): string {
  if (part === 'S') return 'E';
  if (part === 'E') return 'S';
  const i = Number(part.slice(1));
  return part[0] === 'V' ? `V${(i + 1) % nVerts}` : part;
}

/** 형상 노드 캐시를 새 형상으로 고친다(바뀌었으면 true) */
function refreshNode(doc: CadDocument, p: AssocPatch, gi: GroupImport, g: CGroupData, n: CNode): boolean {
  const ref = gi.refs.get(n.id);
  if (!ref) return false;
  const e = p.entity(ref.h);
  if (!e) return false;
  const sys = buildSystem((h) => (h === ref.h ? e : undefined), [], [ref.h]);
  const pr = sys.prims.get(ref.h);
  if (!pr) return false;
  const x = sys.vars.x;
  const cv = curveOf(pr, ref.part, x);
  if (!cv) return false;
  const pl = planeOf(g);
  const z = (n.f.start as Vec3 | undefined)?.z ?? (n.f.center as Vec3 | undefined)?.z ?? 0;
  const f = { ...n.f };
  const ends = (): [Vec2, Vec2] | null => {
    const sp = startPart(doc, gi, n, ref);
    if (!sp) return null;
    const nv = pr.k === 'poly' ? pr.v.length : 0;
    const a = pointOf(pr, sp, x);
    const b = pointOf(pr, otherEnd(sp, nv), x);
    return a && b ? [a, b] : null;
  };
  if (n.cls === 'AcConstrainedBoundedLine' && cv.k === 'line') {
    const ab = ends();
    if (!ab) return false;
    const a = toPlane(pl, ab[0], z);
    const b = toPlane(pl, ab[1], z);
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    f.point = a;
    f.dir = { x: (b.x - a.x) / l, y: (b.y - a.y) / l, z: 0 };
    f.start = a;
    f.end = b;
  } else if ((n.cls === 'AcConstrainedCircle' || n.cls === 'AcConstrainedArc') && cv.k === 'circle') {
    f.center = toPlane(pl, cv.c, z);
    f.radius = cv.r;
    if (n.cls === 'AcConstrainedArc') {
      const ab = ends();
      if (!ab) return false;
      f.start = toPlane(pl, ab[0], z);
      f.end = toPlane(pl, ab[1], z);
    }
  } else return false;
  const same = Object.keys(f).every((k) => JSON.stringify(f[k]) === JSON.stringify(n.f[k]));
  if (same) return false;
  n.f = f;
  return true;
}

/** 형상 종속 대상 → 그룹(읽은 그룹에서) */
const targetIndex = new WeakMap<object, Map<string, string[]>>();

function groupsByTarget(doc: CadDocument): Map<string, string[]> {
  const imp = importAcadConstraints(doc);
  let m = targetIndex.get(imp);
  if (m) return m;
  m = new Map();
  for (const gi of imp.groups) for (const r of gi.refs.values()) {
    const l = m.get(r.h) ?? [];
    if (!l.includes(gi.group)) l.push(gi.group);
    m.set(r.h, l);
  }
  // 참조로 옮기지 못한 형상(지원하지 않는 객체)도 지울 때는 빼야 한다: 형상 종속 대상
  for (const gi of imp.groups) for (const h of gi.data.deps) {
    const d = assocData(doc.objects.get(h));
    if (d?.kind === 'geomdep' && d.dep.target) {
      const l = m.get(d.dep.target) ?? [];
      if (!l.includes(gi.group)) l.push(gi.group);
      m.set(d.dep.target, l);
    }
  }
  targetIndex.set(imp, m);
  return m;
}

/**
 * 트랜잭션의 객체 수정·삭제를 AutoCAD 구속 그룹에 반영하는 작업을 덧붙인다(바뀐 것이 없으면 null).
 * 수정: 형상 노드 캐시 좌표. 삭제: 그 객체의 형상 노드와 이어진 구속, 형상 종속.
 */
export function acadCommitOps(doc: CadDocument, ops: readonly EditOp[]): EditOp[] | null {
  const a = groupCommitOps(doc, ops);
  const b = syncReactors(doc, a ?? ops);
  return b ?? a;
}

const isDepType = (t: string | undefined) => !!t && /^ACDBASSOC(GEOM|VALUE)?DEPENDENCY$/i.test(t);

/**
 * 연관 종속과 그 대상 객체의 반응자를 맞춘다: 새로 만든(또는 대상이 바뀐) 종속은 대상 객체의 반응자에 더하고, 지운 종속은 뺀다.
 * 같은 트랜잭션의 객체 수정이 옛 사본으로 반응자를 잃으면(해법기 결과 등) 되살리고, 복사해 넣은 객체가 원본의 종속을 반응자로
 * 가지고 들어오면 뺀다. 바뀐 것이 없으면 null.
 */
export function syncReactors(doc: CadDocument, ops: readonly EditOp[]): EditOp[] | null {
  const want = new Map<string, Set<string>>();
  const drop = new Map<string, Set<string>>();
  const put = (m: Map<string, Set<string>>, e: string, h: string) => (m.get(e) ?? m.set(e, new Set()).get(e)!).add(normalizeHandle(h));
  const deleted = new Set<string>();
  const targetOf = (o: unknown): string => {
    const g = o as GenericObject | null;
    if (!g || !isDepType(g.type)) return '';
    const d = assocData(g);
    return d && 'dep' in d ? d.dep.target : '';
  };
  for (const op of ops) {
    if (op.kind !== 'object') continue;
    const t0 = targetOf(op.before);
    const t1 = targetOf(op.after);
    if (!op.after && op.before && isDepType(op.before.type)) deleted.add(normalizeHandle(op.key));
    if (t0 && t0 !== t1) put(drop, t0, op.key);
    if (t1 && t1 !== t0) put(want, t1, op.key);
  }
  // 옛 사본으로 반응자를 잃은 수정
  for (const op of ops) {
    if (op.kind !== 'modify') continue;
    const lost = (op.before.reactors ?? []).filter((r) => !(op.after.reactors ?? []).some((x) => normalizeHandle(x) === normalizeHandle(r)));
    for (const r of lost) {
      const h = normalizeHandle(r);
      if (deleted.has(h)) continue;
      if (targetOf(doc.objects.get(h)) === op.after.handle) put(want, op.after.handle, h);
    }
  }
  // 복사한 객체가 원본의 연관 종속을 반응자로 가지고 들어오면 뺀다(그 종속의 대상은 원본이다)
  const txObjects = new Map<string, unknown>();
  for (const op of ops) if (op.kind === 'object') txObjects.set(normalizeHandle(op.key), op.after);
  let base: readonly EditOp[] = ops;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind !== 'add' || !op.entity.reactors?.length) continue;
    const keep = op.entity.reactors.filter((r) => {
      const h = normalizeHandle(r);
      const t = targetOf(txObjects.has(h) ? txObjects.get(h) : doc.objects.get(h));
      return !t || t === normalizeHandle(op.entity.handle);
    });
    if (keep.length === op.entity.reactors.length) continue;
    if (base === ops) base = [...ops];
    const entity = { ...op.entity, reactors: keep } as typeof op.entity;
    if (!keep.length) delete (entity as { reactors?: string[] }).reactors;
    (base as EditOp[])[i] = { ...op, entity };
  }
  if (!want.size && !drop.size) return base === ops ? null : [...base];
  const p = new AssocPatch(doc, base);
  let changed = false;
  for (const h of new Set([...want.keys(), ...drop.keys()])) {
    const e = p.entity(h);
    if (!e || p.entityRemoved(h)) continue;
    const cur = (e.reactors ?? []).map(normalizeHandle);
    const add = [...(want.get(h) ?? [])].filter((x) => !cur.includes(x));
    const rm = drop.get(h) ?? new Set();
    const next = [...cur.filter((x) => !rm.has(x) || want.get(h)?.has(x)), ...add];
    if (next.length === cur.length && next.every((x, i) => x === cur[i])) continue;
    p.modifyEntity({ ...e, reactors: next } as typeof e);
    changed = true;
  }
  return changed || base !== ops ? p.ops : null;
}

/** 객체 수정·삭제를 AutoCAD 그룹 캐시에 반영(acadCommitOps의 앞부분) */
function groupCommitOps(doc: CadDocument, ops: readonly EditOp[]): EditOp[] | null {
  const touched = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'modify') touched.add(op.after.handle);
    else if (op.kind === 'remove') touched.add(op.entity.handle);
  }
  if (!touched.size) return null;
  // 이 트랜잭션에서 만들거나 고친 연관 객체(새 구속을 그룹에 쓴 것 — 캐시는 바뀌기 전 형상으로 쓰였다)
  const assocChanged = new Map<string, CadObject | null>();
  for (const op of ops) if (op.kind === 'object' && /^(ACDBASSOC|ASSOCDIM)/i.test((op.after ?? op.before)?.type ?? '')) assocChanged.set(normalizeHandle(op.key), op.after);
  const byTarget = groupsByTarget(doc);
  const groupsHit = new Set<string>();
  for (const h of touched) for (const g of byTarget.get(h) ?? []) groupsHit.add(g);
  for (const [h, o] of assocChanged) if (o?.type.toUpperCase() === 'ACDBASSOC2DCONSTRAINTGROUP') groupsHit.add(h);
  if (!groupsHit.size) return null;
  const p = new AssocPatch(doc, ops);
  // 바뀐 연관 객체를 얹은 도면(형상은 바뀌기 전 그대로) — 새 노드의 참조도 옛 형상으로 정한다
  let view = doc;
  if (assocChanged.size) {
    const objects = new Map(doc.objects);
    for (const [h, o] of assocChanged) {
      if (o) objects.set(h, o);
      else objects.delete(h);
    }
    view = { ...doc, objects } as CadDocument;
  }
  let changed = false;
  for (const gh of groupsHit) {
    const o = view.objects.get(gh) as GenericObject | undefined;
    const gi = o ? importGroup(view, o) : null;
    const cur = groupOf(p, gh);
    if (!gi || !cur) continue;
    let dirty = false;
    // 지운 객체의 형상 노드
    const deadGeom: number[] = [];
    const deadDeps = new Set<string>();
    for (const n of cur.g.nodes) {
      if (!n.f.dep || n.cls === 'AcConstrainedImplicitPoint') continue;
      const d = dataOf(p, n.f.dep as string);
      const t = d?.kind === 'geomdep' ? d.dep.target : '';
      if (t && p.entityRemoved(t)) {
        deadGeom.push(n.id);
        deadDeps.add(normalizeHandle(n.f.dep as string));
      }
    }
    if (deadGeom.length) {
      removeNodes(p, cur.g, geometryClosure(cur.g, deadGeom));
      cur.g.deps = cur.g.deps.filter((h) => !deadDeps.has(h));
      for (const h of deadDeps) p.deleteObj(h);
      dirty = true;
    }
    for (const n of cur.g.nodes) {
      if (n.cls !== 'AcConstrainedBoundedLine' && n.cls !== 'AcConstrainedCircle' && n.cls !== 'AcConstrainedArc') continue;
      const ref = gi.refs.get(n.id);
      if (!ref || !touched.has(ref.h) || p.entityRemoved(ref.h)) continue;
      if (refreshNode(view, p, gi, cur.g, n)) dirty = true;
    }
    if (dirty) {
      saveGroup(p, gh, cur.head, cur.g);
      changed = true;
    }
    if (refreshDims(view, p, gi, cur.g, touched)) changed = true;
  }
  return changed ? p.ops : null;
}

/** 참조의 자리(점 부분은 그 점, 곡선은 중심 또는 가운데) — 객체 찾기 함수로 */
function refAt(look: (h: string) => import('../../core/model').Entity | undefined, r: { h: string; part: string }): Vec2 | null {
  const e = look(r.h);
  if (!e) return null;
  const sys = buildSystem((h) => (h === r.h ? e : undefined), [], [r.h]);
  const pr = sys.prims.get(r.h);
  if (!pr) return null;
  const pt = pointOf(pr, r.part, sys.vars.x);
  if (pt) return pt;
  const cv = curveOf(pr, r.part, sys.vars.x);
  if (cv?.k === 'circle') return cv.c;
  if (cv?.k === 'line') return { x: (cv.a.x + cv.b.x) / 2, y: (cv.a.y + cv.b.y) / 2 };
  return null;
}

/**
 * 치수 구속의 숨은 치수 객체(*ADSK_CONSTRAINTS)를 형상을 따라 옮긴다: 선형 치수는 정의점 13·14를 새 점으로, 치수선·문자 자리는
 * 점들의 평균 이동만큼, 그 밖의 치수는 통째로 평균 이동만큼(AutoCAD가 다시 계산할 때까지 화면에 엉뚱한 자리에 남지 않게).
 */
function refreshDims(doc: CadDocument, p: AssocPatch, gi: GroupImport, g: CGroupData, touched: ReadonlySet<string>): boolean {
  let changed = false;
  const oldLook = (h: string) => doc.entityIndex.get(h);
  const newLook = (h: string) => p.entity(h);
  for (const n of g.nodes) {
    if (!n.f.dimDep) continue;
    const refs = n.links.map((l) => gi.refs.get(l)).filter((r): r is NonNullable<typeof r> => !!r);
    if (!refs.length || !refs.some((r) => touched.has(r.h))) continue;
    const dd = dataOf(p, n.f.dimDep as string);
    if (dd?.kind !== 'dependency' || !dd.dep.target) continue;
    const e = p.entity(dd.dep.target);
    if (e?.type !== 'DIMENSION') continue;
    const olds = refs.map((r) => refAt(oldLook, r));
    const news = refs.map((r) => refAt(newLook, r));
    if (olds.some((x) => !x) || news.some((x) => !x)) continue;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < refs.length; i++) {
      dx += news[i]!.x - olds[i]!.x;
      dy += news[i]!.y - olds[i]!.y;
    }
    dx /= refs.length;
    dy /= refs.length;
    const dim = e as DimensionEntity;
    const mv = (q: Vec3): Vec3 => ({ ...q, x: q.x + dx, y: q.y + dy });
    let next: DimensionEntity = { ...dim, defPoint: mv(dim.defPoint), textMid: mv(dim.textMid) };
    if ((dim.dimType & 7) <= 1 && refs.length === 2) {
      // 13·14 중 어느 것이 첫 점인지는 옛 자리로
      const a0 = olds[0]!;
      const d13 = dist({ x: dim.defPoint2.x, y: dim.defPoint2.y }, a0);
      const d14 = dist({ x: dim.defPoint3.x, y: dim.defPoint3.y }, a0);
      const [p13, p14] = d13 <= d14 ? [news[0]!, news[1]!] : [news[1]!, news[0]!];
      next = { ...next, defPoint2: { ...dim.defPoint2, x: p13.x, y: p13.y }, defPoint3: { ...dim.defPoint3, x: p14.x, y: p14.y } };
    } else next = { ...next, defPoint2: mv(dim.defPoint2), defPoint3: mv(dim.defPoint3), defPoint4: mv(dim.defPoint4) };
    if (Math.abs(dx) > 1e-12 || Math.abs(dy) > 1e-12 || JSON.stringify(next) !== JSON.stringify(dim)) {
      p.modifyEntity(next);
      changed = true;
    }
  }
  return changed;
}

export { vecToPlane };
