/**
 * 구속 체계: 도면 + 구속 기록에서 풀이 문제를 세우고 풀어 바뀐 객체와 새 구속 기록을 돌려준다(순수 함수, 화면 없음).
 *
 * - 구속을 더할 때(addConstraints): 먼저 고른 객체는 덜, 나중에 고른 객체가 더 움직인다(AutoCAD 규칙: 두 번째 객체를 첫 번째에 맞춘다).
 *   야코비안 행이 기존 구속에 종속이면 과도한 구속으로 보고 적용하지 않는다.
 * - 편집 뒤(followEdit): 편집으로 바뀐 변수는 크게 붙잡고 구속으로 이어진 다른 객체가 따라오게 다시 푼다(유지 편집).
 *   유지할 수 없으면 실패를 알린다. 형상을 다시 만드는 편집(자르기 등)은 깨진 구속만 지운다(완화 편집).
 * - 매개변수가 바뀌면(resolveParams) 값이 바뀐 치수 구속에 걸린 객체를 다시 푼다.
 */
import type { CadDocument, Entity, Vec2 } from '../../core/model';
import { INSUNITS_MM } from '../util/calc';
import { type Eq, type EqContext, ConstraintBuildError, constraintEquations, measureDim, sharedEnds } from './equations';
import { type ParamEval, evaluateParams, numberText, replaceName, storeParamDefs, usesName } from './params';
import { type Prim, type Vars, fixVars, isCurvePart, isPointPart, makePrim, newVars, partVars, primChanged, primDegenerate, primSize, primVars, unsupportedReason, writePrim } from './prims';
import { RowBasis, jacobian, solveEquations } from './solver';
import { type Constraint, type ConstraintStore, type DimConstraint, type GeoRef, constraintHandles } from './types';

export type EntityLookup = (h: string) => Entity | undefined;

export const MSG_OVER = '이 구속조건을 적용하면 형상이 과도하게 구속됩니다.';
export const MSG_UNSOLVED = '구속조건을 만족하는 형상을 찾지 못했습니다.';
export const MSG_EDIT = '구속조건을 유지하면서 객체를 편집할 수 없습니다.';

const W_MOVED = 1e6;
const W_FIRST = 1e3;
const W_OTHER = 10;

// ---------------------------------------------------------------------------
// 체계 세우기
// ---------------------------------------------------------------------------

export interface SysBuild {
  vars: Vars;
  prims: Map<string, Prim>;
  /** 참조가 모두 풀린 구속 */
  constraints: Constraint[];
  /** 객체가 없거나 부분이 맞지 않아 세울 수 없는 구속 */
  bad: Constraint[];
  S: number;
  origin: Vec2;
}

/** 참조가 객체의 올바른 부분을 가리키는지 */
function refsValid(c: Constraint, prims: Map<string, Prim>): boolean {
  return c.refs.every((r) => {
    const p = prims.get(r.h);
    return !!p && (isPointPart(p, r.part) || isCurvePart(p, r.part));
  });
}

export function buildSystem(lookup: EntityLookup, constraints: readonly Constraint[], handles: Iterable<string>): SysBuild {
  const vars = newVars();
  const prims = new Map<string, Prim>();
  for (const h of handles) {
    if (prims.has(h)) continue;
    const e = lookup(h);
    if (!e) continue;
    const p = makePrim(e, vars);
    if (p) prims.set(h, p);
  }
  // 척도: 객체 크기의 중앙값
  const sizes = [...prims.values()].map((p) => primSize(p, vars.x)).filter((v) => v > 1e-12 && Number.isFinite(v)).sort((a, b) => a - b);
  let S = sizes.length ? sizes[sizes.length >> 1]! : 0;
  // 원점: 위치 변수의 평균
  let sx = 0;
  let sy = 0;
  let nx = 0;
  let ny = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  vars.x.forEach((v, i) => {
    if (vars.pos[i] === 1) {
      sx += v;
      nx++;
      minX = Math.min(minX, v);
      maxX = Math.max(maxX, v);
    } else if (vars.pos[i] === 2) {
      sy += v;
      ny++;
      minY = Math.min(minY, v);
      maxY = Math.max(maxY, v);
    }
  });
  const origin = { x: nx ? sx / nx : 0, y: ny ? sy / ny : 0 };
  if (!(S > 0)) S = Math.max(maxX - minX, maxY - minY, 0) || 1;
  const ok: Constraint[] = [];
  const bad: Constraint[] = [];
  const ctx: EqContext = { prims, S, x0: vars.x };
  for (const c of constraints) {
    if (!refsValid(c, prims)) {
      bad.push(c);
      continue;
    }
    try {
      constraintEquations(c, ctx);
      ok.push(c);
    } catch {
      bad.push(c);
    }
  }
  return { vars, prims, constraints: ok, bad, S, origin };
}

/** 원점을 옮긴 변수 값(먼 좌표에서도 차분 정밀도를 지킨다) */
export function shifted(sys: SysBuild, x: readonly number[]): number[] {
  return x.map((v, i) => (sys.vars.pos[i] === 1 ? v - sys.origin.x : sys.vars.pos[i] === 2 ? v - sys.origin.y : v));
}

function unshifted(sys: SysBuild, x: readonly number[]): number[] {
  return x.map((v, i) => (sys.vars.pos[i] === 1 ? v + sys.origin.x : sys.vars.pos[i] === 2 ? v + sys.origin.y : v));
}

function tolOf(S: number): number {
  return Math.max(1e-10 * S, 1e-12);
}

/** 구속 그래프에서 이어진 객체와 구속(참조 매개변수를 읽는 식도 잇는다) */
export function linkedComponent(store: ConstraintStore, seeds: Iterable<string>): { handles: Set<string>; constraints: Constraint[] } {
  const byHandle = new Map<string, Constraint[]>();
  for (const c of store.constraints) for (const h of constraintHandles(c)) (byHandle.get(h) ?? byHandle.set(h, []).get(h)!).push(c);
  // 참조(측정) 치수를 읽는 구동 치수는 그 참조의 객체와 함께 풀어야 한다
  const refDims = store.constraints.filter((c): c is DimConstraint => c.kind === 'dim' && c.reference);
  const coupled = new Map<number, Constraint[]>();
  for (const r of refDims)
    for (const c of store.constraints)
      if (c.kind === 'dim' && !c.reference && c !== r && usesName(c.expr, r.name)) {
        (coupled.get(r.id) ?? coupled.set(r.id, []).get(r.id)!).push(c);
        (coupled.get(c.id) ?? coupled.set(c.id, []).get(c.id)!).push(r);
      }
  const handles = new Set<string>();
  const seen = new Set<number>();
  const out: Constraint[] = [];
  const queue = [...seeds];
  const visitC = (c: Constraint) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
    for (const h of constraintHandles(c)) if (!handles.has(h)) queue.push(h);
    for (const d of coupled.get(c.id) ?? []) visitC(d);
  };
  while (queue.length) {
    const h = queue.pop()!;
    if (handles.has(h)) continue;
    handles.add(h);
    for (const c of byHandle.get(h) ?? []) visitC(c);
  }
  return { handles, constraints: out };
}

// ---------------------------------------------------------------------------
// 풀기
// ---------------------------------------------------------------------------

export interface SolveOutcome {
  ok: boolean;
  /** 바뀐 객체(핸들 그대로, 아직 문서에 적용하지 않음) */
  entities: Map<string, Entity>;
  /** 바뀐 구속 기록(바뀐 것이 없으면 null) */
  store: ConstraintStore | null;
  message?: string;
  reason?: 'overconstrained' | 'unsolvable' | 'unsupported';
  /** 지운 구속 수(편집 뒤 깨진 것·객체가 없어진 것) */
  removed?: number;
}

function unitMm(doc: CadDocument): number {
  const u = doc.header.get('$INSUNITS');
  return typeof u === 'number' ? (INSUNITS_MM[u] ?? 1) : 1;
}

/** 매개변수를 계산한다(참조 구속은 지금 형상에서 잰 값) */
export function evaluateStore(doc: CadDocument, store: ConstraintStore, measure?: (c: DimConstraint) => number): ParamEval {
  return evaluateParams(storeParamDefs(store, measure), unitMm(doc));
}

interface Problem {
  sys: SysBuild;
  eqs: Eq[];
  /** 원점을 옮긴 시작 값 */
  xs: number[];
  ctx: EqContext;
}

function makeProblem(sys: SysBuild, constraints: readonly Constraint[], dimValue: (c: DimConstraint) => number): Problem {
  const xs = shifted(sys, sys.vars.x);
  const ctx: EqContext = { prims: sys.prims, S: sys.S, x0: xs, dimValue, shared: sharedEnds(constraints) };
  const eqs: Eq[] = [];
  for (const c of constraints) eqs.push(...constraintEquations(c, ctx));
  return { sys, eqs, xs, ctx };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface RunOptions {
  /** 차례로 해 볼 무게(앞의 것이 실패하면 다음 것). Infinity = 그 변수는 움직이지 않는다 */
  weights: Float64Array[];
  deadline: number;
  /** 이 구속들의 행이 나머지와 독립인지 먼저 본다 */
  checkIds?: Set<number>;
}

/** 체계를 풀고 참조 치수를 따라 매개변수를 다시 계산한다(최대 4번) */
function run(doc: CadDocument, store: ConstraintStore, sys: SysBuild, opt: RunOptions): { ok: boolean; x: number[]; reason?: SolveOutcome['reason']; values: Map<number, number> } {
  const values = new Map<number, number>();
  let measured = new Map<number, number>();
  const measureAt = (x: readonly number[]) => {
    const m = new Map<number, number>();
    for (const c of sys.constraints) if (c.kind === 'dim' && c.reference) m.set(c.id, measureDim(c, sys.prims, x));
    return m;
  };
  measured = measureAt(sys.vars.x);
  const evalValues = () => {
    const ev = evaluateStore(doc, store, (c) => measured.get(c.id) ?? c.value);
    return (c: DimConstraint) => {
      const v = ev.values.get(c.name.toLowerCase());
      return v !== undefined && Number.isFinite(v) ? v : c.value;
    };
  };
  let dimValue = evalValues();
  let pb: Problem;
  try {
    pb = makeProblem(sys, sys.constraints, dimValue);
  } catch {
    return { ok: false, x: sys.vars.x, reason: 'unsupported', values };
  }
  if (opt.checkIds?.size) {
    // 기존 구속의 행을 먼저 기저에 넣고, 새 구속의 행이 독립인지 본다
    const basis = new RowBasis(pb.xs.length, sys.vars.ang, sys.S);
    const x = [...pb.xs];
    const oldEqs = pb.eqs.filter((e) => !opt.checkIds!.has(e.id));
    const newEqs = pb.eqs.filter((e) => opt.checkIds!.has(e.id));
    for (const r of jacobian(oldEqs, x, { ang: sys.vars.ang, S: sys.S })) basis.add(r);
    if (!basis.addAll(jacobian(newEqs, x, { ang: sys.vars.ang, S: sys.S }))) return { ok: false, x: sys.vars.x, reason: 'overconstrained', values };
  }
  const tol = tolOf(sys.S);
  let xs = pb.xs;
  const tiny = 1e-9 * sys.S;
  const attempt = (x0: number[]): number[] | null => {
    for (const w of opt.weights) {
      const r = solveEquations(pb.eqs, x0, { weights: w, ang: sys.vars.ang, S: sys.S, tol, deadline: opt.deadline });
      if (!r.ok) continue;
      const xa = unshifted(sys, r.x);
      if ([...sys.prims.values()].some((p) => primDegenerate(p, xa, tiny))) continue;
      return r.x;
    }
    return null;
  };
  for (let round = 0; round < 4; round++) {
    const got = attempt(xs);
    if (!got) return { ok: false, x: sys.vars.x, reason: 'unsolvable', values };
    xs = got;
    const xa = unshifted(sys, xs);
    const m2 = measureAt(xa);
    let moved = false;
    for (const [id, v] of m2) if (!(Math.abs(v - (measured.get(id) ?? v)) <= 1e-9 * Math.max(1, Math.abs(v)))) moved = true;
    measured = m2;
    if (!moved || !sys.constraints.some((c) => c.kind === 'dim' && c.reference)) {
      for (const c of sys.constraints) if (c.kind === 'dim') values.set(c.id, c.reference ? (measured.get(c.id) ?? c.value) : dimValue(c));
      return { ok: true, x: xa, values };
    }
    // 참조 값이 바뀌었다: 그 값을 읽는 식을 다시 계산하고 다시 푼다
    dimValue = evalValues();
    pb = makeProblem(sys, sys.constraints, dimValue);
  }
  return { ok: false, x: sys.vars.x, reason: 'unsolvable', values };
}

/** 푼 결과 → 바뀐 객체 */
function changedEntities(doc: CadDocument, sys: SysBuild, x: readonly number[]): Map<string, Entity> {
  const out = new Map<string, Entity>();
  const tol = 1e-12 * Math.max(1, sys.S, Math.abs(sys.origin.x), Math.abs(sys.origin.y));
  for (const [h, p] of sys.prims) if (primChanged(p, x, sys.vars.x, tol)) out.set(h, writePrim(p, x, doc));
  return out;
}

/** 값이 바뀐 치수 구속을 반영한 새 기록(바뀐 것이 없으면 null) */
function withValues(store: ConstraintStore, values: Map<number, number>): ConstraintStore | null {
  let changed = false;
  const cs = store.constraints.map((c) => {
    if (c.kind !== 'dim') return c;
    const v = values.get(c.id);
    if (v === undefined || !Number.isFinite(v) || Math.abs(v - c.value) <= 1e-12 * Math.max(1, Math.abs(v))) return c;
    changed = true;
    return { ...c, value: v, ...(c.reference ? { expr: numberText(v) } : {}) };
  });
  return changed ? { ...store, constraints: cs } : null;
}

/** 점을 붙잡을 변수(점 자체가 변수면 그 둘, 호 끝처럼 계산되는 점이면 그 점을 정하는 변수 모두) */
function anchorOf(sys: SysBuild, r: GeoRef): number[] {
  const p = sys.prims.get(r.h);
  if (!p) return [];
  const f = fixVars(p, r.part);
  return f.length ? f : partVars(p, r.part);
}

/** 고정 구속의 변수는 움직이지 않게 한다(식도 세우지만 정확히 제자리에 둔다) */
function lockFixed(sys: SysBuild, weights: Float64Array[]): void {
  for (const c of sys.constraints) {
    if (c.type !== 'FIX') continue;
    for (const r of c.refs) {
      const p = sys.prims.get(r.h);
      if (p) for (const w of weights) for (const i of fixVars(p, r.part)) w[i] = Infinity;
    }
  }
}

/** 잠긴 객체의 변수는 움직이지 않게 한다 */
function lockAll(sys: SysBuild, weights: Float64Array[], locked?: ReadonlySet<string>): void {
  if (!locked?.size) return;
  for (const h of locked) {
    const p = sys.prims.get(h);
    if (p) for (const w of weights) for (const i of primVars(p)) w[i] = Infinity;
  }
}

function lookupOf(doc: CadDocument, override?: ReadonlyMap<string, Entity>): EntityLookup {
  return (h) => override?.get(h) ?? doc.entityIndex.get(h);
}

function message(reason: SolveOutcome['reason']): string {
  return reason === 'overconstrained' ? MSG_OVER : reason === 'unsupported' ? '이 객체에는 구속조건을 적용할 수 없습니다.' : MSG_UNSOLVED;
}

// ---------------------------------------------------------------------------
// 구속 더하기
// ---------------------------------------------------------------------------

export interface AddOptions {
  /** 고른 순서(첫 객체는 덜 움직인다) */
  order?: string[];
  /** 움직이면 안 되는 객체(잠긴 도면층) */
  locked?: ReadonlySet<string>;
  /** 과도한 구속 검사를 하지 않는다(자동 구속이 이미 검사했을 때) */
  noCheck?: boolean;
  deadlineMs?: number;
}

/**
 * 구속을 더해 풀어 본다. 성공하면 새 구속 기록(번호를 붙인 새 구속 포함)과 바뀐 객체.
 * 새 구속의 id는 무시하고 기록의 다음 번호를 붙인다.
 */
export function addConstraints(doc: CadDocument, store: ConstraintStore, add: readonly Constraint[], opt: AddOptions = {}): SolveOutcome & { added: Constraint[] } {
  const pruned = pruneStore(doc, store);
  const s: ConstraintStore = { ...pruned, constraints: [...pruned.constraints], userParams: [...pruned.userParams], hiddenBars: [...pruned.hiddenBars] };
  const added: Constraint[] = [];
  for (const c of add) {
    const nc = { ...c, id: s.nextId++ } as Constraint;
    added.push(nc);
    s.constraints.push(nc);
  }
  for (const c of added) {
    for (const h of constraintHandles(c)) {
      const e = doc.entityIndex.get(h);
      if (!e) return { ok: false, entities: new Map(), store: null, message: '객체가 없습니다.', reason: 'unsupported', added: [] };
      const why = unsupportedReason(e);
      if (why) return { ok: false, entities: new Map(), store: null, message: why, reason: 'unsupported', added: [] };
    }
  }
  const comp = linkedComponent(s, added.flatMap(constraintHandles));
  const sys = buildSystem(lookupOf(doc), comp.constraints, comp.handles);
  const badNew = sys.bad.filter((c) => added.includes(c));
  if (badNew.length) {
    let why = '이 객체에는 구속조건을 적용할 수 없습니다.';
    try {
      constraintEquations(badNew[0]!, { prims: sys.prims, S: sys.S, x0: sys.vars.x });
    } catch (e) {
      if (e instanceof ConstraintBuildError) why = e.message;
    }
    return { ok: false, entities: new Map(), store: null, message: why, reason: 'unsupported', added: [] };
  }
  // 무게: 마지막에 고른 객체가 맞춰 움직이고(1), 앞서 고른 객체는 먼저 그대로 두고 풀어 보고 안 되면 크게(W_FIRST),
  // 그 밖에 이어진 객체는 조금(W_OTHER)
  const order = opt.order ?? added.flatMap(constraintHandles);
  const follower = order[order.length - 1];
  const anchors = [...new Set(order.slice(0, -1))].filter((h) => h !== follower);
  const w = new Float64Array(sys.vars.x.length).fill(W_OTHER);
  const set = (h: string, v: number) => {
    const p = sys.prims.get(h);
    if (p) for (const i of primVars(p)) w[i] = v;
  };
  if (follower) set(follower, 1);
  // 점끼리 재는 치수 구속의 첫 점은 붙잡는다(같은 객체의 두 점이어도 두 번째 점 쪽이 움직인다)
  const anchorVars: number[] = [];
  for (const c of added) {
    if (c.kind !== 'dim' || c.refs.length < 2) continue;
    if (!c.refs.every((r) => {
      const p = sys.prims.get(r.h);
      return p && isPointPart(p, r.part);
    })) continue;
    anchorVars.push(...anchorOf(sys, c.refs[0]!));
  }
  const tries: Float64Array[] = [];
  if (anchors.length || anchorVars.length) {
    const w0 = Float64Array.from(w);
    for (const h of anchors) {
      const p = sys.prims.get(h);
      if (p) for (const i of primVars(p)) w0[i] = Infinity;
    }
    for (const i of anchorVars) w0[i] = Infinity;
    tries.push(w0);
    for (const h of anchors) set(h, W_FIRST);
    for (const i of anchorVars) w[i] = W_FIRST;
  }
  tries.push(w);
  lockFixed(sys, tries);
  lockAll(sys, tries, opt.locked);
  const r = run(doc, s, sys, { weights: tries, deadline: now() + (opt.deadlineMs ?? 3000), checkIds: opt.noCheck ? undefined : new Set(added.map((c) => c.id)) });
  if (!r.ok) return { ok: false, entities: new Map(), store: null, message: message(r.reason), reason: r.reason, added: [] };
  const entities = changedEntities(doc, sys, r.x);
  const st2 = withValues(s, r.values) ?? s;
  return { ok: true, entities, store: st2, added: added.map((c) => st2.constraints.find((x) => x.id === c.id) ?? c) };
}

// ---------------------------------------------------------------------------
// 구속 지우기(치수 구속 이름을 읽던 식에는 값을 써 넣는다)
// ---------------------------------------------------------------------------

export function removeConstraints(store: ConstraintStore, ids: Iterable<number>): ConstraintStore {
  const kill = new Set(ids);
  const gone = store.constraints.filter((c) => kill.has(c.id));
  if (!gone.length) return store;
  let cs = store.constraints.filter((c) => !kill.has(c.id));
  let ups = store.userParams;
  for (const g of gone) {
    if (g.kind !== 'dim') continue;
    const lit = `(${numberText(g.value)})`;
    cs = cs.map((c) => (c.kind === 'dim' && !c.reference && usesName(c.expr, g.name) ? { ...c, expr: replaceName(c.expr, g.name, lit) } : c));
    ups = ups.map((u) => (usesName(u.expr, g.name) ? { ...u, expr: replaceName(u.expr, g.name, lit) } : u));
  }
  const live = new Set(cs.flatMap(constraintHandles));
  return { ...store, constraints: cs, userParams: ups, hiddenBars: store.hiddenBars.filter((h) => live.has(h)) };
}

/** 객체에 걸린 구속 */
export function constraintsOf(store: ConstraintStore, handles: Iterable<string>): Constraint[] {
  const hs = new Set(handles);
  return store.constraints.filter((c) => c.refs.some((r) => hs.has(r.h)));
}

/** 없는 객체를 가리키는 구속을 지운다 */
export function pruneStore(doc: CadDocument, store: ConstraintStore): ConstraintStore {
  const dead = store.constraints.filter((c) => c.refs.some((r) => !doc.entityIndex.has(r.h))).map((c) => c.id);
  return dead.length ? removeConstraints(store, dead) : store;
}

// ---------------------------------------------------------------------------
// 편집 뒤 다시 풀기
// ---------------------------------------------------------------------------

export interface FollowOptions {
  /** 'maintain' = 구속을 지키며 다시 푼다(이동·회전·축척·신축·그립·특성), 'relax' = 깨진 구속만 지운다 */
  mode: 'maintain' | 'relax';
  /** 움직이면 안 되는 객체(잠긴 도면층) */
  locked?: ReadonlySet<string>;
  deadlineMs?: number;
}

/**
 * 편집 결과(changes: 바뀐 객체, removed: 지운 핸들)에 맞춰 구속을 다시 푼다.
 * 돌려준 entities는 따라 움직인 객체와, 구속 때문에 값이 조정된 편집 객체(편집 결과 대신 쓴다).
 */
export function followEdit(doc: CadDocument, store: ConstraintStore, changes: ReadonlyMap<string, Entity>, removed: ReadonlySet<string>, opt: FollowOptions): SolveOutcome {
  const none: SolveOutcome = { ok: true, entities: new Map(), store: null };
  if (!store.constraints.length) return none;
  const lookup = lookupOf(doc, changes);
  // 지운 객체·없는 객체를 가리키는 구속
  const dead = store.constraints.filter((c) => c.refs.some((r) => removed.has(r.h) || !lookup(r.h))).map((c) => c.id);
  let s = dead.length ? removeConstraints(store, dead) : store;
  let dropped = dead.length;
  const seeds = [...changes.keys()].filter((h) => s.constraints.some((c) => c.refs.some((r) => r.h === h)));
  if (!seeds.length) return { ok: true, entities: new Map(), store: dropped ? s : null, removed: dropped };
  const comp = linkedComponent(s, seeds);
  const sys = buildSystem(lookup, comp.constraints, comp.handles);
  // 바뀐 객체에서 부분이 사라졌거나(정점 수 감소 등) 종류가 바뀐 구속은 지운다
  if (sys.bad.length) {
    s = removeConstraints(s, sys.bad.map((c) => c.id));
    dropped += sys.bad.length;
  }
  if (opt.mode === 'relax') {
    // 다시 풀지 않고, 깨진 구속만 지운다
    const tol = Math.max(1e-6 * sys.S, 1e-9);
    const evs = evaluateStore(doc, s);
    const dimValue = (c: DimConstraint) => evs.values.get(c.name.toLowerCase()) ?? c.value;
    const ctx: EqContext = { prims: sys.prims, S: sys.S, x0: sys.vars.x, dimValue, shared: sharedEnds(sys.constraints) };
    const broken: number[] = [];
    for (const c of sys.constraints) {
      if (c.type === 'FIX') continue;
      try {
        if (!constraintEquations(c, ctx).every((e) => Math.abs(e.f(sys.vars.x)) <= tol)) broken.push(c.id);
      } catch {
        broken.push(c.id);
      }
    }
    if (broken.length) {
      s = removeConstraints(s, broken);
      dropped += broken.length;
    }
    // 참조 치수의 측정값
    const vals = new Map<number, number>();
    for (const c of sys.constraints) if (c.kind === 'dim' && c.reference && !broken.includes(c.id)) vals.set(c.id, measureDim(c, sys.prims, sys.vars.x));
    s = withValues(s, vals) ?? s;
    return { ok: true, entities: new Map(), store: s === store ? null : s, removed: dropped };
  }
  // 무게: 편집이 바꾼 변수는 크게 붙잡는다
  const w = new Float64Array(sys.vars.x.length).fill(1);
  const moved: number[] = [];
  for (const h of changes.keys()) {
    const p = sys.prims.get(h);
    if (!p) continue;
    const before = doc.entityIndex.get(h);
    const bv = newVars();
    const bp = before ? makePrim(before, bv) : null;
    const idx = primVars(p);
    const bidx = bp && bp.k === p.k ? primVars(bp) : null;
    if (!bidx || bidx.length !== idx.length) {
      for (const i of idx) moved.push(i);
      continue;
    }
    const tol = 1e-12 * Math.max(1, sys.S, Math.abs(sys.origin.x), Math.abs(sys.origin.y));
    idx.forEach((i, k) => {
      if (Math.abs(sys.vars.x[i]! - bv.x[bidx[k]!]!) > tol) moved.push(i);
    });
  }
  // 먼저 편집한 객체를 그대로 두고 풀어 보고, 안 되면 편집한 값은 크게 붙잡고 나머지(같은 객체의 안 바뀐 값 포함)를 고친다
  const locked = Float64Array.from(w);
  for (const h of changes.keys()) {
    const p = sys.prims.get(h);
    if (p) for (const i of primVars(p)) locked[i] = Infinity;
  }
  for (const i of moved) w[i] = W_MOVED;
  lockFixed(sys, [locked, w]);
  lockAll(sys, [locked, w], opt.locked);
  const r = run(doc, s, sys, { weights: [locked, w], deadline: now() + (opt.deadlineMs ?? 1500) });
  if (!r.ok) return { ok: false, entities: new Map(), store: null, message: MSG_EDIT, reason: r.reason };
  const entities = changedEntities(doc, sys, r.x);
  s = withValues(s, r.values) ?? s;
  return { ok: true, entities, store: s === store ? null : s, removed: dropped };
}

// ---------------------------------------------------------------------------
// 매개변수가 바뀐 뒤
// ---------------------------------------------------------------------------

/**
 * 새 구속 기록(식·이름을 고친 것)으로 다시 푼다. 값이 바뀐 치수 구속에 걸린 객체만 푼다.
 * 식 오류가 있으면 실패(message에 첫 오류).
 */
export function resolveParams(doc: CadDocument, before: ConstraintStore, after: ConstraintStore, opt: { deadlineMs?: number; locked?: ReadonlySet<string> } = {}): SolveOutcome {
  const ev = evaluateStore(doc, after);
  for (const [k, e] of ev.errors) {
    const name = [...after.constraints.filter((c): c is DimConstraint => c.kind === 'dim').map((c) => c.name), ...after.userParams.map((u) => u.name)].find((n) => n.toLowerCase() === k) ?? k;
    // 참조 구속의 "측정할 수 없음"은 무시
    if (after.constraints.some((c) => c.kind === 'dim' && c.reference && c.name.toLowerCase() === k)) continue;
    return { ok: false, entities: new Map(), store: null, message: `${name}: ${e}`, reason: 'unsolvable' };
  }
  const changedDims = after.constraints.filter((c): c is DimConstraint => {
    if (c.kind !== 'dim' || c.reference) return false;
    const v = ev.values.get(c.name.toLowerCase());
    const old = before.constraints.find((x) => x.id === c.id) as DimConstraint | undefined;
    return v !== undefined && (!old || Math.abs(v - old.value) > 1e-12 * Math.max(1, Math.abs(v)) || old.reference);
  });
  // 사용자 매개변수 값
  let s: ConstraintStore = { ...after, userParams: after.userParams.map((u) => ({ ...u, value: ev.values.get(u.name.toLowerCase()) ?? u.value })) };
  if (!changedDims.length) {
    const vals = new Map<number, number>();
    for (const c of s.constraints) if (c.kind === 'dim' && !c.reference) vals.set(c.id, ev.values.get(c.name.toLowerCase()) ?? c.value);
    return { ok: true, entities: new Map(), store: withValues(s, vals) ?? s };
  }
  for (const c of changedDims) {
    const why = dimValueProblem(c.type, ev.values.get(c.name.toLowerCase())!);
    if (why) return { ok: false, entities: new Map(), store: null, message: `${c.name}: ${why}`, reason: 'unsolvable' };
  }
  const comp = linkedComponent(s, changedDims.flatMap(constraintHandles));
  const sys = buildSystem(lookupOf(doc), comp.constraints, comp.handles);
  // 무게: 값이 바뀐 치수의 첫 점은 붙잡는다(두 번째 점 쪽이 움직인다). 모두 붙잡아 보고, 첫 치수의 것만, 그다음 조금만
  const anchors: number[][] = [];
  for (const c of changedDims) {
    if (c.refs.length < 2) continue;
    if (!c.refs.every((r) => {
      const p = sys.prims.get(r.h);
      return p && isPointPart(p, r.part);
    })) continue;
    anchors.push(anchorOf(sys, c.refs[0]!));
  }
  const w = new Float64Array(sys.vars.x.length).fill(1);
  for (const a of anchors) for (const i of a) w[i] = W_OTHER;
  const tries: Float64Array[] = [];
  if (anchors.length) {
    const all = Float64Array.from(w);
    for (const a of anchors) for (const i of a) all[i] = Infinity;
    tries.push(all);
    if (anchors.length > 1) {
      const first = Float64Array.from(w);
      for (const i of anchors[0]!) first[i] = Infinity;
      tries.push(first);
    }
  }
  tries.push(w);
  lockFixed(sys, tries);
  lockAll(sys, tries, opt.locked);
  const r = run(doc, s, sys, { weights: tries, deadline: now() + (opt.deadlineMs ?? 3000) });
  if (!r.ok) return { ok: false, entities: new Map(), store: null, message: message(r.reason), reason: r.reason };
  const entities = changedEntities(doc, sys, r.x);
  s = withValues(s, r.values) ?? s;
  return { ok: true, entities, store: s };
}

/** 치수 구속 값 검사(쓸 수 없으면 까닭). 길이는 0보다 크고, 각도는 0°와 360° 사이 */
export function dimValueProblem(type: DimConstraint['type'], v: number): string | null {
  if (!Number.isFinite(v)) return '값이 수가 아닙니다.';
  if (type === 'ANGLE') return v > 0 && v < 360 ? null : '각도는 0°보다 크고 360°보다 작아야 합니다.';
  return v > 0 ? null : '값은 0보다 커야 합니다.';
}

// ---------------------------------------------------------------------------
// 재기
// ---------------------------------------------------------------------------

/** 치수 구속의 지금 측정값(문서 형상에서). 잴 수 없으면 NaN */
export function measureConstraint(doc: CadDocument, c: DimConstraint, override?: ReadonlyMap<string, Entity>): number {
  const sys = buildSystem(lookupOf(doc, override), [c], constraintHandles(c));
  if (!sys.constraints.length) return NaN;
  return measureDim(c, sys.prims, sys.vars.x);
}

/** 지금 형상이 구속을 만족하는지(공차는 척도의 1e-6) */
export function isSatisfied(doc: CadDocument, store: ConstraintStore, c: Constraint): boolean {
  const sys = buildSystem(lookupOf(doc), [c], constraintHandles(c));
  if (!sys.constraints.length) return false;
  const ev = evaluateStore(doc, store);
  const ctx: EqContext = { prims: sys.prims, S: sys.S, x0: sys.vars.x, dimValue: (d) => ev.values.get(d.name.toLowerCase()) ?? d.value };
  try {
    return constraintEquations(c, ctx).every((e) => Math.abs(e.f(sys.vars.x)) <= Math.max(1e-6 * sys.S, 1e-9));
  } catch {
    return false;
  }
}
