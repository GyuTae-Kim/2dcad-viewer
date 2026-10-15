/**
 * 구속 기반 동적 블록: 정의 블록 레코드의 연관 망(ACAD_ASSOCNETWORK)에 있는 2D 구속 그룹을 읽어(src/edit/assocnet, 읽기 전용)
 * 블록 구속 매개변수의 값 바꾸기와, 동작이 객체를 옮긴 뒤 구속을 지키는 풀이를 이 앱의 구속 풀이기로 한다(문서는 바꾸지 않는다).
 *
 * 실물(공개 DXF architectural_example-imperial의 "Window - Imperial"):
 *  - 평가 그래프에 대리 노드(ACDB_DYNAMICBLOCKPROXYNODE)와 BLOCKHORIZONTAL·VERTICALCONSTRAINTPARAMETER("W"·"H").
 *  - 매개변수의 AcDbBlockConstraintParameter 330 = 구속 그룹 치수 노드의 연관 종속(몸체 BLOCKPARAMDEPENDENCYBODY,
 *    "W=3'-0\"" 같은 식 글). 정의 쪽 치수는 참조 치수로 읽히고(값은 지금 거리), 표현 블록(*U6 W=60·H=6, *U7 W=42·H=6)은
 *    각자 구속 그룹 사본을 가진다. 정의를 W=60·H=6으로 풀면 *U6의 형상과 같다(시험은 손으로 만든 같은 꼴의 자료로 한다).
 *
 * 블록 안 객체는 문서의 entityIndex에 없을 수 있어(표현 블록 사본을 고친다) 정의 핸들 → 지금 객체를 담은 문서 대리로 푼다.
 */
import type { CadDocument, Entity, GenericObject, Vec2 } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { assocData, blockNetwork, importGroup } from '../assocnet';
import { followEdit, measureConstraint, numberText, resolveParams } from '../constraint';
import { makePrim, newVars, pointOf } from '../constraint/prims';
import type { Constraint, ConstraintStore, DimConstraint, UserParam } from '../constraint/types';

export interface BlockConstraints {
  /** 블록 구속(정의 객체 핸들 기준, 번호는 1부터) */
  constraints: Constraint[];
  /** 그룹에 묶이지 않은 변수(식에서 쓰는 사용자 매개변수) */
  userParams: UserParam[];
  /** 연관 종속 핸들(블록 구속 매개변수의 330) → 그 치수 구속 */
  byDependency: Map<string, DimConstraint>;
  /** 읽을 수 없으면 까닭 */
  problem?: string;
}

const cache = new WeakMap<object, BlockConstraints>();

/** 정의 블록 레코드의 구속(망이 없으면 null). 그룹을 하나라도 읽지 못하면 problem */
export function blockConstraints(doc: CadDocument, recordHandle: string): BlockConstraints | null {
  const net = blockNetwork(doc, recordHandle);
  if (!net) return null;
  const hit = cache.get(net.network);
  if (hit) return hit;
  const out: BlockConstraints = { constraints: [], userParams: [], byDependency: new Map() };
  const d = assocData(net.network);
  if (d?.kind !== 'network') out.problem = '연관 망을 읽지 못했습니다.';
  else {
    let id = 1;
    const bound = new Set<string>();
    const vars: GenericObject[] = [];
    for (const a of d.net.actions) {
      const o = doc.objects.get(normalizeHandle(a.h)) as GenericObject | undefined;
      if (!o) continue;
      const t = o.type.toUpperCase();
      if (t === 'ACDBASSOCVARIABLE') {
        vars.push(o);
        continue;
      }
      if (t !== 'ACDBASSOC2DCONSTRAINTGROUP') continue;
      const g = o.raw?.length ? importGroup(doc, o) : null;
      if (!g) {
        out.problem = '구속 그룹을 읽지 못했습니다.';
        break;
      }
      if (g.skipped.length) {
        out.problem = `옮기지 못한 구속(${[...new Set(g.skipped.map((x) => x.cls))].join(', ')})`;
        break;
      }
      for (const vh of g.variables.values()) bound.add(vh);
      for (const [node, c] of g.constraints) {
        const cc = { ...c, id: id++ } as Constraint;
        out.constraints.push(cc);
        if (cc.kind !== 'dim') continue;
        const dep = g.data.nodes.find((n) => n.id === node)?.f.dimDep;
        if (typeof dep === 'string' && dep) out.byDependency.set(normalizeHandle(dep), cc);
      }
    }
    for (const o of vars) {
      if (bound.has(normalizeHandle(o.handle))) continue;
      const v = assocData(o);
      if (v?.kind !== 'variable' || !v.variable.name.trim()) continue;
      const n = typeof v.variable.value.v === 'number' ? v.variable.value.v : Number(v.variable.value.v);
      out.userParams.push({ name: v.variable.name, expr: v.variable.expr.trim() || numberText(Number.isFinite(n) ? n : 0), value: Number.isFinite(n) ? n : 0 });
    }
  }
  cache.set(net.network, out);
  return out;
}

/** 정의 핸들 → 지금 객체(핸들을 정의 핸들로 바꾼 사본)를 entityIndex로 가진 문서 대리 */
function subDoc(doc: CadDocument, current: ReadonlyMap<string, Entity>): CadDocument {
  const index = new Map<string, Entity>();
  for (const [h, e] of current) index.set(h, { ...e, handle: h } as Entity);
  return Object.assign(Object.create(doc) as CadDocument, { entityIndex: index });
}

/** 부호 있는 거리 치수(측정 방향 aux[0]이 부호를 정한다) */
const signed = (c: DimConstraint): boolean => c.type === 'DIST' || c.type === 'HDIST' || c.type === 'VDIST';

/** 측정 방향을 뒤집은 치수 */
function flipped(c: DimConstraint): DimConstraint {
  const aux = [...(c.aux ?? [1])];
  aux[0] = -(aux[0] ?? 1);
  return { ...c, aux };
}

/**
 * 풀이 기록: 부호 있는 거리는 지금 형상에서 양수가 되게 측정 방향을 맞추고(AutoCAD 치수 구속 값은 부호가 없다 — 뒤집기 동작 뒤에도
 * 같은 크기), 구속 매개변수가 정하는 치수는 참조가 아닌 구동 치수로 값 = 지금 잰 값(set이 있으면 그 값).
 */
function storeOf(sub: CadDocument, bc: BlockConstraints, set?: ReadonlyMap<number, number>): ConstraintStore {
  const driven = new Set([...bc.byDependency.values()].map((c) => c.id));
  const constraints = bc.constraints.map((c): Constraint => {
    if (c.kind !== 'dim') return c;
    const m = measureConstraint(sub, c);
    const cc = signed(c) && m < 0 ? flipped(c) : c;
    if (!driven.has(c.id)) return cc;
    const v = set?.get(c.id) ?? Math.abs(m);
    return { ...cc, reference: false, value: v, expr: numberText(v) };
  });
  return { constraints, userParams: bc.userParams, hiddenBars: [], nextId: constraints.length + 1 };
}

export type SolveResult = { ok: true; entities: Map<string, Entity> } | { ok: false; message: string };

/** 구속 매개변수 값 바꾸기: set = 치수 구속 번호 → 새 값. 돌려준 객체는 정의 핸들 → 새 객체(바뀐 것만) */
export function solveParams(doc: CadDocument, current: ReadonlyMap<string, Entity>, bc: BlockConstraints, set: ReadonlyMap<number, number>): SolveResult {
  const sub = subDoc(doc, current);
  const before = storeOf(sub, bc);
  const after = storeOf(sub, bc, set);
  const r = resolveParams(sub, before, after, { deadlineMs: 2000 });
  if (!r.ok) return { ok: false, message: r.message ?? '구속조건을 만족하는 형상을 찾지 못했습니다.' };
  return { ok: true, entities: r.entities };
}

/**
 * 동작이 객체를 옮긴 뒤 구속을 지킨다(AutoCAD: 동작 뒤 구속 풀이). before = 동작 전 객체, changes = 동작이 바꾼 객체.
 * 구속 매개변수의 값은 동작 전 값을 지킨다. 돌려준 객체는 따라 움직인 객체와 조정된 편집 객체.
 */
export function maintain(doc: CadDocument, before: ReadonlyMap<string, Entity>, changes: ReadonlyMap<string, Entity>, bc: BlockConstraints): SolveResult {
  const sub = subDoc(doc, before);
  const base = storeOf(sub, bc);
  const ch = new Map<string, Entity>();
  for (const [h, e] of changes) ch.set(h, { ...e, handle: h } as Entity);
  // 방향 있는 거리(수평·수직 거리, 점–선 거리)는 동작이 뒤집은 쪽을 따른다: 동작 뒤 형상에서 잰 부호가 바뀌었으면 측정 방향을
  // 뒤집는다(AutoCAD 치수 구속 값은 부호가 없어, 뒤집기 동작 뒤에도 같은 크기로 풀린다)
  const merged = new Map(before);
  for (const [h, e] of changes) merged.set(h, e);
  const subAfter = subDoc(doc, merged);
  const store: ConstraintStore = {
    ...base,
    constraints: base.constraints.map((c) => {
      if (c.kind !== 'dim' || !signed(c)) return c;
      const v1 = measureConstraint(subAfter, c);
      return Number.isFinite(v1) && v1 < -1e-12 ? flipped(c) : c;
    }),
  };
  const r = followEdit(sub, store, ch, new Set(), { mode: 'maintain', deadlineMs: 2000 });
  if (!r.ok) return { ok: false, message: r.message ?? '구속조건을 유지하면서 객체를 편집할 수 없습니다.' };
  return { ok: true, entities: r.entities };
}

/** 치수 구속의 지금 값(지금 형상에서 잰 값) */
export function measureIn(doc: CadDocument, current: ReadonlyMap<string, Entity>, c: DimConstraint): number {
  return measureConstraint(subDoc(doc, current), c);
}

/** 구속 참조 점(정의 핸들의 객체 부분 'S'·'E'·'M'·'C'·'V<i>' …)의 좌표 */
export function refPoint(e: Entity | undefined, part: string): Vec2 | null {
  if (!e) return null;
  const vs = newVars();
  const pr = makePrim(e, vs);
  return pr ? pointOf(pr, part, vs.x) : null;
}
