/**
 * 동적 블록 평가: 참조의 지금 상태(표현 블록 객체 + 지금 값)에서 매개변수 하나를 바꾸고, 그 매개변수에 연결된 동작을
 * 그래프 순서대로 실행한다(AutoCAD가 그립 기록을 되풀이하는 방식 — 한 변경은 지금 상태에서 평가).
 *
 * - 가시성: 매개변수가 다루는 객체의 보이지 않음(60)을 상태대로.
 * - 뒤집기: 뒤집기 동작의 선택 객체를 지금 뒤집기 선(첫 점 → 둘째 점)에 대해 대칭(문자는 읽을 수 있게).
 * - 선형·XY·회전: 새 점 → 연결 속성(EndXDelta·Scale …) → 이동·신축·축척·회전 동작.
 * - 조회: 표의 행이 정하는 값(가시성·뒤집기·거리·XY)을 차례로 적용하고, 다른 조회 표는 일치하는 행으로 맞춘다.
 * - 배열: 매개변수 기준점이 움직이면 선택 객체를 같이 옮기고, 끝낼 때(finish) 지금 매개변수 거리로 사본을 다시 만든다
 *   (열 = floor(|거리| / 141 간격), XY는 행 = floor(|Y 거리| / 140 간격) — 공개 도면 표현 블록 50여 개로 확인).
 * - 구속 기반 정의: 구속 매개변수는 블록의 구속 그룹을 풀어 값을 바꾸고, 동작이 구속된 객체를 옮기면 바로 구속을 다시 푼다
 *   (방향 있는 거리는 뒤집힌 쪽을 따른다 — 공개 DXF의 창 블록 표현 *U6·*U7과 같은 형상).
 *
 * 모든 좌표는 블록 정의 좌표다. 지원하지 않는 경우는 DynError(MSG_UNSUPPORTED)로 거절한다(부분 결과를 남기지 않는다).
 */
import type { CadDocument, Entity, Vec3 } from '../../core/model';
import { transformEntity } from '../geom/transform';
import { type Affine, affApply, affIdentity, affMirror, affMul, affRotate, affScale, affTranslate, pointInPolygon } from '../geom/math';
import { blockConstraints, maintain, refPoint, solveParams } from './cblock';
import { actionsOf, paramById } from './definition';
import { type DynRef, type WorkItem, cloneValues, workItems } from './reference';
import {
  type BaseAction,
  type Conn,
  type DynAction,
  type DynDefinition,
  type DynParam,
  type FlipParam,
  type LinearParam,
  type LookupAction,
  type LookupParam,
  type MoveAction,
  type OtherAction,
  type PointParam,
  type PolarParam,
  type RefValues,
  type RotationParam,
  type ValueSet,
  type VisibilityParam,
  type XYParam,
  FLIP_NOT,
  FLIP_YES,
  LOOKUP_CUSTOM,
  MSG_UNSUPPORTED,
} from './types';
import { lwPoints, lwVertices, setLwVertices } from '../../core/lwpoly';

export class DynError extends Error {}

const EPS = 1e-9;

/** 배열 사본 수 한도(한 번 평가에서) */
const MAX_COPIES = 20000;

/** 배열 개수: 거리를 간격으로 나눈 몫(1 이상). 표현 블록에서 306 / 51 → 6, 316 / 24 → 13, 100.59 / 25 → 4 */
export function arrayCount(distance: number, spacing: number): number {
  if (!(spacing > EPS) || !Number.isFinite(distance)) return 1;
  return Math.max(1, Math.floor(Math.abs(distance) / spacing + 1e-6));
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const len = (a: Vec3): number => Math.hypot(a.x, a.y);
const xf = (m: Affine, p: Vec3): Vec3 => {
  const q = affApply(m, p);
  return { x: q.x, y: q.y, z: p.z };
};

function sameNum(a: number, b: number, rel = 1e-6): boolean {
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
}

/** 값 집합에 맞춘다(사용자가 준 값만). drawn = 정의가 그려진 값 — 목록에 없어도 허용 값이다 */
export function snapToValueSet(vs: ValueSet, value: number, drawn: number | null): number {
  let v = value;
  if (vs.type & 8 && vs.list.length) {
    const cands = [...vs.list];
    if (drawn !== null) cands.push(drawn);
    let best = cands[0]!;
    for (const c of cands) if (Math.abs(c - v) < Math.abs(best - v)) best = c;
    return best;
  }
  if (vs.type & 4 && vs.increment > 0) {
    const base = vs.type & 1 ? vs.min : 0;
    v = base + Math.round((v - base) / vs.increment) * vs.increment;
  }
  if (vs.type & 1 && v < vs.min) v = vs.min;
  if (vs.type & 2 && v > vs.max) v = vs.max;
  return v;
}

/** 값 집합의 고를 수 있는 값(목록 + 그려진 값, 오름차순). 목록이 아니면 빈 배열 */
export function valueChoices(vs: ValueSet, drawn: number | null): number[] {
  if (!(vs.type & 8) || !vs.list.length) return [];
  const all = [...vs.list, ...(drawn !== null ? [drawn] : [])].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of all) if (!out.length || !sameNum(out[out.length - 1]!, v, 1e-5)) out.push(v);
  return out;
}

/** 블록 객체의 신축점 옮기기. 지원하지 않으면 null */
function stretchEntity(e: Entity, pts: readonly number[], d: Vec3, doc: CadDocument): Entity | null {
  const set = new Set(pts);
  const mv = (p: Vec3): Vec3 => ({ x: p.x + d.x, y: p.y + d.y, z: p.z });
  const whole = (): Entity | null => {
    const r = transformEntity(e, affTranslate(d.x, d.y), doc);
    return r.replace?.[0] ?? r.add?.[0] ?? null;
  };
  switch (e.type) {
    case 'LINE': {
      const r = structuredClone(e);
      if (set.has(0)) r.start = mv(e.start);
      if (set.has(1)) r.end = mv(e.end);
      return r;
    }
    case 'LWPOLYLINE': {
      if (e.extrusion && Math.abs(e.extrusion.z - 1) > 1e-9) return null;
      const r = structuredClone(e);
      const vs = lwVertices(e);
      vs.forEach((v, i) => {
        if (set.has(i)) {
          v.x += d.x;
          v.y += d.y;
        }
      });
      setLwVertices(r, vs);
      return r;
    }
    case 'POLYLINE': {
      if (e.kind === 'polyface' || e.kind === 'mesh') return null;
      if (e.kind === '2d' && e.extrusion && Math.abs(e.extrusion.z - 1) > 1e-9) return null;
      const r = structuredClone(e);
      r.vertices.forEach((v, i) => {
        if (set.has(i)) v.location = mv(v.location);
      });
      return r;
    }
    case 'SOLID':
    case 'TRACE':
    case '3DFACE': {
      if (e.type !== '3DFACE' && e.extrusion && Math.abs(e.extrusion.z - 1) > 1e-9) return null;
      const r = structuredClone(e);
      r.points = r.points.map((p, i) => (set.has(i) ? mv(p) : p)) as typeof r.points;
      return r;
    }
    case 'SPLINE': {
      if (e.fitPoints.length) return set.size >= e.fitPoints.length ? whole() : null;
      const r = structuredClone(e);
      r.controlPoints = r.controlPoints.map((p, i) => (set.has(i) ? mv(p) : p));
      return r;
    }
    case 'ARC':
      return set.has(0) && set.has(1) ? whole() : null;
    case 'CIRCLE':
    case 'POINT':
    case 'TEXT':
    case 'ATTDEF':
    case 'ATTRIB':
    case 'MTEXT':
    case 'INSERT':
    case 'ELLIPSE':
    case 'SHAPE':
    case 'TOLERANCE':
      return set.size ? whole() : e;
    default:
      return null;
  }
}

/** 객체의 신축점(블록 좌표). 다루지 않는 종류는 null */
function stretchPoints(e: Entity): { x: number; y: number }[] | null {
  const flat = !e.extrusion || Math.abs(e.extrusion.z - 1) < 1e-9;
  switch (e.type) {
    case 'LINE':
      return [e.start, e.end];
    case 'LWPOLYLINE':
      return flat ? lwPoints(e) : null;
    case 'POLYLINE':
      return e.kind === 'polyface' || e.kind === 'mesh' ? null : e.vertices.map((v) => v.location);
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      return e.type === '3DFACE' || flat ? e.points : null;
    case 'SPLINE':
      return e.fitPoints.length ? e.fitPoints : e.controlPoints;
    case 'ARC':
      return flat
        ? [
            { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) },
            { x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle) },
          ]
        : null;
    case 'CIRCLE':
    case 'ELLIPSE':
      return [e.center];
    case 'POINT':
      return [e.position];
    case 'TEXT':
    case 'ATTDEF':
    case 'ATTRIB':
    case 'MTEXT':
    case 'INSERT':
    case 'SHAPE':
    case 'TOLERANCE':
      return [e.insert];
    default:
      return null;
  }
}

export interface EvalOptions {
  /** 값 집합에 맞추지 않는다(조회 행·복사한 값) */
  exact?: boolean;
  /** 끄는 그립: 첫 점(base)이나 둘째 점(end) */
  grip?: 'base' | 'end';
}

/**
 * 평가 작업 상태. 생성할 때 참조의 지금 블록 객체를 복사한다.
 */
export class DynEval {
  readonly def: DynDefinition;
  /** 원본 객체(정의 객체와 짝). 배열 사본은 copies */
  readonly items: WorkItem[];
  /** 배열 사본(원본 뒤에 붙는다). finish가 지금 값으로 다시 만든다 */
  copies: WorkItem[];
  readonly values: RefValues;
  /** ETag 색인 → 블록 좌표에서 통째로 적용된 변환(속성 따라가기용) */
  readonly moved = new Map<number, Affine>();
  /** 값이 바뀐 노드 id(캐시 갱신) */
  readonly changedNodes = new Set<number>();
  /** 객체(모양·보이지 않음)가 바뀌었는지 */
  geometryChanged = false;
  private readonly byDef = new Map<string, WorkItem>();
  /** 동작이 바꾼 원본(정의 핸들) — 구속 기반 정의는 동작 뒤 구속을 다시 푼다 */
  private readonly touched = new Set<string>();

  /** copy = 거짓이면 객체를 복사하지 않는다(값만 읽거나 조회 값만 맞출 때) */
  constructor(
    readonly doc: CadDocument,
    readonly ref: DynRef,
    copy = true,
  ) {
    this.def = ref.def;
    const all = workItems(ref.def, ref.block, ref.direct).map((it) => (copy ? { ...it, entity: structuredClone(it.entity) } : it));
    this.items = all.filter((it) => !it.copy);
    this.copies = all.filter((it) => it.copy);
    for (const it of this.items) if (it.defHandle) this.byDef.set(it.defHandle, it);
    this.values = cloneValues(ref.values);
  }

  /** 정의 핸들의 작업 객체 */
  item(defHandle: string): WorkItem | undefined {
    return this.byDef.get(defHandle.toUpperCase());
  }

  points(id: number): Vec3[] {
    return this.values.get(id)?.points?.map((p) => ({ ...p })) ?? [];
  }

  private setPoints(id: number, pts: Vec3[]): void {
    const v = this.values.get(id) ?? {};
    v.points = pts;
    this.values.set(id, v);
    this.changedNodes.add(id);
  }

  // -------------------------------------------------------------------------
  // 읽기
  // -------------------------------------------------------------------------

  distance(p: LinearParam | DynParam): number {
    const [a, b] = this.points(p.id);
    return a && b ? len(sub(b, a)) : 0;
  }

  xyValues(p: XYParam): { x: number; y: number } {
    const [a, b] = this.points(p.id);
    return a && b ? { x: b.x - a.x, y: b.y - a.y } : { x: 0, y: 0 };
  }

  angle(p: RotationParam): number {
    const [a, b] = this.points(p.id);
    return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  }

  state(p: VisibilityParam): string {
    return this.values.get(p.id)?.state ?? '';
  }

  flipped(p: FlipParam): boolean {
    return !!this.values.get(p.id)?.flipped;
  }

  lookupValue(p: LookupParam): string {
    return this.values.get(p.id)?.value ?? '';
  }

  /** 정의가 그려진 거리 */
  drawnDistance(p: LinearParam): number {
    return len(sub(p.end, p.base));
  }

  // -------------------------------------------------------------------------
  // 객체 변환
  // -------------------------------------------------------------------------

  private transformItem(it: WorkItem, m: Affine): void {
    const r = transformEntity(it.entity, m, this.doc);
    const out = r.replace?.[0] ?? r.add?.[0];
    if (!out) throw new DynError(MSG_UNSUPPORTED);
    out.handle = it.entity.handle;
    out.xdata = it.entity.xdata;
    if (it.entity.invisible) out.invisible = true;
    else delete out.invisible;
    it.entity = out;
    this.moved.set(it.index, affMul(m, this.moved.get(it.index) ?? affIdentity()));
    this.geometryChanged = true;
    if (it.defHandle) this.touched.add(it.defHandle);
  }

  private transformEntities(handles: readonly string[], m: Affine): void {
    for (const h of handles) {
      const it = this.item(h);
      if (it) this.transformItem(it, m);
    }
  }

  /** 다른 노드(매개변수 점·축척 동작 기준점)를 옮긴다. skip = 바꾸는 매개변수 */
  private transformNode(id: number, m: Affine, skip: number, which?: readonly number[]): void {
    if (id === skip) return;
    const p = paramById(this.def, id);
    const v = this.values.get(id);
    if (!v) return;
    if (p) {
      if (p.kind === 'basepoint') throw new DynError(MSG_UNSUPPORTED);
      if (p.chain && actionsOf(this.def, id).length) throw new DynError(MSG_UNSUPPORTED);
      const pts = this.points(id).map((q, i) => (!which || which.includes(i) ? xf(m, q) : q));
      this.setPoints(id, pts);
      return;
    }
    if (v.base) {
      v.base = xf(m, v.base);
      this.changedNodes.add(id);
    }
  }

  // -------------------------------------------------------------------------
  // 연결 속성
  // -------------------------------------------------------------------------

  /** 바뀌는 매개변수의 속성 값(이전 점 old, 새 점 now). 다른 매개변수면 그 지금 값(변위는 0) */
  private prop(c: Conn, changed: number, old: Vec3[], now: Vec3[]): number | null {
    const k = c.prop.toLowerCase();
    const isChanged = c.node === changed;
    const pts = isChanged ? now : this.points(c.node);
    const prev = isChanged ? old : pts;
    const p0 = pts[0];
    const p1 = pts[1] ?? pts[0];
    const q0 = prev[0];
    const q1 = prev[1] ?? prev[0];
    if (!p0 || !p1 || !q0 || !q1) return null;
    switch (k) {
      case 'updatedbasex':
      case 'updatedx':
      case 'basex':
        return p0.x;
      case 'updatedbasey':
      case 'updatedy':
      case 'basey':
        return p0.y;
      case 'updatedendx':
      case 'endx':
        return p1.x;
      case 'updatedendy':
      case 'endy':
        return p1.y;
      case 'basexdelta':
      case 'xdelta':
      case 'deltax':
        return p0.x - q0.x;
      case 'baseydelta':
      case 'ydelta':
      case 'deltay':
        return p0.y - q0.y;
      case 'endxdelta':
        return p1.x - q1.x;
      case 'endydelta':
        return p1.y - q1.y;
      case 'distance':
      case 'updateddistance':
        return len(sub(p1, p0));
      case 'updateddistancex':
      case 'distancex':
        return Math.abs(p1.x - p0.x);
      case 'updateddistancey':
      case 'distancey':
        return Math.abs(p1.y - p0.y);
      case 'scale': {
        const d0 = len(sub(q1, q0));
        return d0 > EPS ? len(sub(p1, p0)) / d0 : null;
      }
      case 'xscale': {
        const d0 = Math.abs(q1.x - q0.x);
        return d0 > EPS ? Math.abs(p1.x - p0.x) / d0 : null;
      }
      case 'yscale': {
        const d0 = Math.abs(q1.y - q0.y);
        return d0 > EPS ? Math.abs(p1.y - p0.y) / d0 : null;
      }
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // 동작
  // -------------------------------------------------------------------------

  /** 매개변수 param이 old → now로 바뀌었을 때 연결된 동작을 실행한다 */
  private runActions(param: DynParam, old: Vec3[], now: Vec3[], extra?: { angle?: number }): void {
    this.constrainedRun(() => {
      for (const a of actionsOf(this.def, param.id)) this.runAction(a, param, old, now, extra);
    });
  }

  /** 구속 기반 정의: 동작을 돌린 뒤 구속된 객체가 바뀌었으면 구속을 지키게 다시 푼다(AutoCAD: 동작 뒤 구속 풀이) */
  private constrainedRun(fn: () => void): void {
    if (!this.def.constrained) {
      fn();
      return;
    }
    const before = this.currentByDef();
    this.touched.clear();
    fn();
    if (this.touched.size) this.maintainConstraints(before);
  }

  private baseOf(a: BaseAction, changed: number, old: Vec3[], now: Vec3[]): Vec3 {
    if (a.dependent) {
      const x = this.prop(a.baseX, changed, old, now);
      const y = this.prop(a.baseY, changed, old, now);
      if (x === null || y === null) throw new DynError(MSG_UNSUPPORTED);
      return { x: x + a.offset.x, y: y + a.offset.y, z: 0 };
    }
    return this.values.get(a.id)?.base ?? a.basePoint;
  }

  private runAction(a: DynAction, param: DynParam, old: Vec3[], now: Vec3[], extra?: { angle?: number }): void {
    switch (a.kind) {
      case 'move':
      case 'stretch': {
        const d = this.displacement(a, param.id, old, now);
        if (len(d) < EPS) return;
        const m = affTranslate(d.x, d.y);
        if (a.kind === 'move') {
          this.transformEntities(a.entities, m);
          for (const n of a.nodes) this.transformNode(n, m, param.id);
          return;
        }
        const bound = new Map(a.bindings.map((b) => [b.handle, b.points]));
        // 묶음이 없는 신축(예전 형식): 틀 안의 신축점(정의 좌표의 틀 — 처음 평가에서 정확하다)
        if (!a.bindings.length && a.frame.length >= 3)
          for (const h of a.entities) {
            const it = this.item(h);
            const pts = it ? stretchPoints(it.entity) : null;
            if (!it) continue;
            if (!pts) throw new DynError(MSG_UNSUPPORTED);
            bound.set(h.toUpperCase(), pts.flatMap((q, i) => (pointInPolygon(q, a.frame) ? [i] : [])));
          }
        for (const h of new Set([...a.entities, ...a.bindings.map((b) => b.handle)])) {
          const it = this.item(h);
          if (!it) continue;
          const pts = bound.get(h.toUpperCase());
          if (!pts) {
            this.transformItem(it, m);
            continue;
          }
          if (!pts.length) continue;
          const r = stretchEntity(it.entity, pts, d, this.doc);
          if (!r) throw new DynError(MSG_UNSUPPORTED);
          r.handle = it.entity.handle;
          r.xdata = it.entity.xdata;
          if (it.entity.invisible) r.invisible = true;
          else delete r.invisible;
          if (r !== it.entity) {
            it.entity = r;
            this.geometryChanged = true;
            if (it.defHandle) this.touched.add(it.defHandle);
            // 한 점짜리 객체는 통째로 옮긴 것과 같다(속성이 따라간다)
            if (['TEXT', 'ATTDEF', 'MTEXT', 'INSERT', 'CIRCLE', 'POINT', 'ELLIPSE', 'SHAPE', 'TOLERANCE', 'ARC'].includes(r.type)) this.moved.set(it.index, affMul(m, this.moved.get(it.index) ?? affIdentity()));
          }
        }
        const listed = new Set<number>();
        for (const np of a.nodePoints) {
          listed.add(np.node);
          this.transformNode(np.node, m, param.id, np.points);
        }
        for (const n of a.nodes) if (!listed.has(n)) this.transformNode(n, m, param.id);
        return;
      }
      case 'scale': {
        let kx: number | null;
        let ky: number | null;
        if (param.kind === 'xy') {
          kx = a.scaleX && a.scaleX.node === param.id ? this.prop(a.scaleX, param.id, old, now) : 1;
          ky = a.scaleY && a.scaleY.node === param.id ? this.prop(a.scaleY, param.id, old, now) : 1;
          if (a.scale && a.scale.node === param.id) kx = ky = this.prop(a.scale, param.id, old, now);
        } else kx = ky = a.scale ? this.prop(a.scale, param.id, old, now) : null;
        if (kx === null || ky === null || !(kx > 0) || !(ky > 0) || !sameNum(kx, ky, 1e-9)) throw new DynError(MSG_UNSUPPORTED);
        const base = this.baseOf(a, param.id, old, now);
        const v = this.values.get(a.id) ?? {};
        v.base = { ...base };
        this.values.set(a.id, v);
        this.changedNodes.add(a.id);
        if (sameNum(kx, 1, 1e-12)) return;
        const m = affScale(kx, kx, base);
        this.transformEntities(a.entities, m);
        for (const n of a.nodes) this.transformNode(n, m, param.id);
        return;
      }
      case 'rotate': {
        if ((param.kind !== 'rotation' && param.kind !== 'polar') || extra?.angle === undefined) throw new DynError(MSG_UNSUPPORTED);
        const base = this.baseOf(a, param.id, old, now);
        const v = this.values.get(a.id) ?? {};
        v.base = { ...base };
        this.values.set(a.id, v);
        this.changedNodes.add(a.id);
        const m = affRotate(extra.angle, base);
        this.transformEntities(a.entities, m);
        for (const n of a.nodes) this.transformNode(n, m, param.id);
        return;
      }
      case 'flip':
        // 뒤집기 동작은 뒤집기 매개변수에서만 돈다
        if (param.kind !== 'flip') throw new DynError(MSG_UNSUPPORTED);
        return;
      case 'lookup':
        return;
      case 'polar_stretch':
        this.polarStretch(a, param, old, now);
        return;
      case 'array': {
        // 기준점(Base → UpdatedBase)이 움직이면 선택 객체가 같이 움직인다(XY 배열 표본: 원본 원이 기준점을 따라갔다).
        // 사본은 finish에서 지금 거리로 다시 만든다
        if (param.kind !== 'linear' && param.kind !== 'xy' && param.kind !== 'polar') throw new DynError(MSG_UNSUPPORTED);
        const [o0] = old;
        const [n0] = now;
        if (!o0 || !n0) throw new DynError(MSG_UNSUPPORTED);
        const d = sub(n0, o0);
        if (len(d) < EPS) return;
        const m = affTranslate(d.x, d.y);
        this.transformEntities(a.entities, m);
        for (const n of a.nodes) this.transformNode(n, m, param.id);
        return;
      }
      default:
        throw new DynError(MSG_UNSUPPORTED);
    }
  }

  // -------------------------------------------------------------------------
  // 끝내기: 배열 사본
  // -------------------------------------------------------------------------

  /** 값을 다 바꾼 뒤 부른다: 배열 사본을 지금 값으로 다시 만든다 */
  finish(): void {
    this.regenerateArrays();
  }

  /** 배열 동작의 사본 변위(블록 좌표, 원본 자리 (0, 0)은 빼고 AutoCAD 순서 — XY는 행 바깥·열 안쪽) */
  arrayOffsets(a: OtherAction): Vec3[] {
    const p = a.conns[0] ? paramById(this.def, a.conns[0].node) : undefined;
    if (!p) return [];
    const [b, e] = this.points(p.id);
    if (!b || !e) return [];
    const col = a.columnSpacing ?? 0;
    const row = a.rowSpacing ?? 0;
    const out: Vec3[] = [];
    if (p.kind === 'xy') {
      const dx = e.x - b.x;
      const dy = e.y - b.y;
      const nc = arrayCount(dx, col);
      const nr = arrayCount(dy, row);
      if (nc * nr > MAX_COPIES) throw new DynError('배열 사본이 너무 많습니다.');
      const sx = dx < 0 ? -1 : 1;
      const sy = dy < 0 ? -1 : 1;
      for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) if (r || c) out.push({ x: c * col * sx, y: r * row * sy, z: 0 });
      return out;
    }
    const L = len(sub(e, b));
    const n = arrayCount(L, col);
    if (n > MAX_COPIES) throw new DynError('배열 사본이 너무 많습니다.');
    const u = L > EPS ? mul(sub(e, b), 1 / L) : { x: 1, y: 0, z: 0 };
    for (let k = 1; k < n; k++) out.push({ x: u.x * col * k, y: u.y * col * k, z: 0 });
    return out;
  }

  /**
   * 배열 사본을 다시 만든다: 배열 동작마다(그래프 순서) 사본 자리마다 선택 객체(블록 순서)를 옮겨 붙인다.
   * 사본은 원본의 ETag 색인·보이지 않음을 따른다(속성 정의는 사본을 만들지 않는다).
   */
  private regenerateArrays(): void {
    const arrays = this.def.actions.filter((a): a is OtherAction => a.kind === 'array');
    if (!arrays.length) return;
    arrays.sort((a, b) => (this.def.order.get(a.id) ?? 0) - (this.def.order.get(b.id) ?? 0) || a.id - b.id);
    const out: WorkItem[] = [];
    for (const a of arrays) {
      const offs = this.arrayOffsets(a);
      if (!offs.length) continue;
      const sel = new Set(a.entities.map((h) => h.toUpperCase()));
      const src = this.items.filter((it) => it.defHandle && sel.has(it.defHandle) && it.entity.type !== 'ATTDEF');
      if (out.length + offs.length * src.length > MAX_COPIES) throw new DynError('배열 사본이 너무 많습니다.');
      for (const d of offs)
        for (const it of src) {
          const r = transformEntity(it.entity, affTranslate(d.x, d.y), this.doc);
          const e = r.replace?.[0] ?? r.add?.[0];
          if (!e) throw new DynError(MSG_UNSUPPORTED);
          e.handle = it.entity.handle;
          e.xdata = it.entity.xdata;
          if (it.entity.invisible) e.invisible = true;
          else delete e.invisible;
          out.push({ index: it.index, defHandle: null, entity: e, copy: true });
        }
    }
    if (out.length || this.copies.length) this.geometryChanged = true;
    this.copies = out;
  }

  // -------------------------------------------------------------------------
  // 구속 기반 정의
  // -------------------------------------------------------------------------

  /** 지금 원본(정의 핸들 → 객체) */
  private currentByDef(): Map<string, Entity> {
    const m = new Map<string, Entity>();
    for (const it of this.items) if (it.defHandle) m.set(it.defHandle, it.entity);
    return m;
  }

  /** 푼 객체(정의 핸들 → 새 객체)를 원본에 적용하고, 구속 매개변수의 점을 형상에 맞춰 옮긴다 */
  private applySolved(before: ReadonlyMap<string, Entity>, solved: ReadonlyMap<string, Entity>, skip?: number): void {
    for (const [h, e] of solved) {
      const it = this.item(h);
      if (!it) continue;
      const out = { ...e, handle: it.entity.handle, xdata: it.entity.xdata } as Entity;
      if (it.entity.invisible) out.invisible = true;
      else delete out.invisible;
      it.entity = out;
      this.geometryChanged = true;
    }
    const bc = blockConstraints(this.doc, this.def.recordHandle);
    if (!bc) return;
    const after = this.currentByDef();
    for (const p of this.def.params) {
      if (p.kind !== 'linear' || !p.constraint || p.id === skip) continue;
      const c = bc.byDependency.get(p.constraint.dependency);
      const pts = this.points(p.id);
      if (!c || c.refs.length < 2 || pts.length < 2) continue;
      const P = c.refs.map((r) => refPoint(before.get(r.h), r.part));
      const Q = c.refs.map((r) => refPoint(after.get(r.h), r.part));
      if (P.some((x) => !x) || Q.some((x) => !x)) continue;
      const [b, e] = pts as [Vec3, Vec3];
      const d = (u: Vec3, v: { x: number; y: number }) => Math.hypot(u.x - v.x, u.y - v.y);
      const swap = d(b, P[1]!) + d(e, P[0]!) < d(b, P[0]!) + d(e, P[1]!);
      const [i0, i1] = swap ? [1, 0] : [0, 1];
      const nb = { x: b.x + Q[i0]!.x - P[i0]!.x, y: b.y + Q[i0]!.y - P[i0]!.y, z: b.z };
      const ne = { x: e.x + Q[i1]!.x - P[i1]!.x, y: e.y + Q[i1]!.y - P[i1]!.y, z: e.z };
      if (len(sub(nb, b)) > EPS || len(sub(ne, e)) > EPS) this.setPoints(p.id, [nb, ne, ...pts.slice(2)]);
    }
  }

  /** 구속 매개변수 값 바꾸기(블록의 구속 그룹을 푼다) */
  private setConstraintParam(p: LinearParam, d: number): boolean {
    const bc = blockConstraints(this.doc, this.def.recordHandle);
    const c = bc && !bc.problem ? bc.byDependency.get(p.constraint!.dependency) : undefined;
    if (!bc || !c) throw new DynError(MSG_UNSUPPORTED);
    const before = this.currentByDef();
    const r = solveParams(this.doc, before, bc, new Map([[c.id, d]]));
    if (!r.ok) throw new DynError(r.message);
    this.applySolved(before, r.entities, p.id);
    // 이 매개변수의 점: 형상을 따라 옮기고 거리를 새 값으로(기준점 쪽 고정)
    const old = this.points(p.id);
    const [a, b] = old;
    if (a && b) {
      const P = c.refs.map((x) => refPoint(before.get(x.h), x.part));
      const Q = c.refs.map((x) => refPoint(this.currentByDef().get(x.h), x.part));
      let na = { ...a };
      if (P[0] && P[1] && Q[0] && Q[1]) {
        const swap = Math.hypot(a.x - P[1].x, a.y - P[1].y) < Math.hypot(a.x - P[0].x, a.y - P[0].y);
        const k = swap ? 1 : 0;
        na = { x: a.x + Q[k]!.x - P[k]!.x, y: a.y + Q[k]!.y - P[k]!.y, z: a.z };
      }
      const L = len(sub(b, a));
      const u = L > EPS ? mul(sub(b, a), 1 / L) : { x: 1, y: 0, z: 0 };
      this.setPoints(p.id, [na, add(na, mul(u, d)), ...old.slice(2)]);
    }
    this.changedNodes.add(p.id);
    return true;
  }

  /** 동작이 구속된 객체를 옮긴 뒤: 구속을 지키게 다시 푼다(지킬 수 없으면 거절). before = 동작 전 원본 */
  private maintainConstraints(before: ReadonlyMap<string, Entity>): void {
    const bc = blockConstraints(this.doc, this.def.recordHandle);
    if (!bc || bc.problem || !bc.constraints.length) return;
    const changes = new Map<string, Entity>();
    for (const h of this.touched) {
      const it = this.item(h);
      if (it) changes.set(h, it.entity);
    }
    const r = maintain(this.doc, before, changes, bc);
    if (!r.ok) throw new DynError(r.message);
    this.applySolved(before, r.entities);
    this.touched.clear();
  }

  /**
   * 극좌표 신축: 끝점의 거리 변화 Δd(지금 방향 u)와 각도 변화 Δθ(첫 점 둘레).
   * 신축 객체(332, 없으면 선택 집합)마다 틀 안의 신축점은 u·Δd만큼 옮긴 뒤 객체 전체를 Δθ 돌린다 — 틀 안에 다 들면
   * 통째로 옮겨 돌고, 하나도 없으면 돌기만 한다. 틀은 정의 좌표라 지금 매개변수 상태로 옮겨서 쓴다.
   * 점이 묶인 객체(72)가 있거나 첫 점이 움직이면 지원하지 않는다(그 DXF 코드·뜻을 확인하지 못했다).
   */
  private polarStretch(a: OtherAction, param: DynParam, old: Vec3[], now: Vec3[]): void {
    if (param.kind !== 'polar' || a.boundCount || !a.frame || a.frame.length < 2) throw new DynError(MSG_UNSUPPORTED);
    const [a0, b0] = old;
    const [a1, b1] = now;
    if (!a0 || !b0 || !a1 || !b1 || len(sub(a1, a0)) > EPS) throw new DynError(MSG_UNSUPPORTED);
    const polarMap = (p0: Vec3, q0: Vec3, p1: Vec3, q1: Vec3): Affine => {
      const d0 = len(sub(q0, p0));
      const u = d0 > EPS ? mul(sub(q0, p0), 1 / d0) : { x: 1, y: 0, z: 0 };
      const dd = len(sub(q1, p1)) - d0;
      const th = Math.atan2(q1.y - p1.y, q1.x - p1.x) - Math.atan2(q0.y - p0.y, q0.x - p0.x);
      return affMul(affRotate(th, p1), affMul(affTranslate(p1.x - p0.x, p1.y - p0.y), affTranslate(u.x * dd, u.y * dd)));
    };
    // 정의 상태 → 지금(바꾸기 전) 상태로 틀을 옮긴다
    const toOld = polarMap(param.base, param.end, a0, b0);
    const f = a.frame.map((q) => xf(toOld, { x: q.x, y: q.y, z: 0 }));
    const poly =
      f.length === 2
        ? [
            { x: Math.min(f[0]!.x, f[1]!.x), y: Math.min(f[0]!.y, f[1]!.y) },
            { x: Math.max(f[0]!.x, f[1]!.x), y: Math.min(f[0]!.y, f[1]!.y) },
            { x: Math.max(f[0]!.x, f[1]!.x), y: Math.max(f[0]!.y, f[1]!.y) },
            { x: Math.min(f[0]!.x, f[1]!.x), y: Math.max(f[0]!.y, f[1]!.y) },
          ]
        : f;
    const d0 = len(sub(b0, a0));
    const u = d0 > EPS ? mul(sub(b0, a0), 1 / d0) : { x: 1, y: 0, z: 0 };
    const delta = mul(u, len(sub(b1, a1)) - d0);
    const turn = Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
    const turns = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > 1e-12;
    const rot = affRotate(turn, a0);
    const full = affMul(rot, affTranslate(delta.x, delta.y));
    const handles = a.stretchEntities?.length ? a.stretchEntities : a.entities;
    for (const h of handles) {
      const it = this.item(h);
      if (!it) continue;
      const pts = stretchPoints(it.entity);
      if (!pts) throw new DynError(MSG_UNSUPPORTED);
      const inside = pts.flatMap((q, i) => (pointInPolygon(q, poly) ? [i] : []));
      if (inside.length === pts.length) {
        if (turns || len(delta) > EPS) this.transformItem(it, full);
        continue;
      }
      if (inside.length && len(delta) > EPS) {
        const r = stretchEntity(it.entity, inside, delta, this.doc);
        if (!r) throw new DynError(MSG_UNSUPPORTED);
        r.handle = it.entity.handle;
        r.xdata = it.entity.xdata;
        if (it.entity.invisible) r.invisible = true;
        else delete r.invisible;
        it.entity = r;
        this.geometryChanged = true;
        if (it.defHandle) this.touched.add(it.defHandle);
      }
      if (turns) this.transformItem(it, rot);
    }
    for (const n of a.nodes) this.transformNode(n, full, param.id);
    const v = this.values.get(a.id) ?? {};
    if (v.angle === undefined) v.angle = 0;
    this.values.set(a.id, v);
  }

  private displacement(a: MoveAction, changed: number, old: Vec3[], now: Vec3[]): Vec3 {
    const comp = (c: Conn) => {
      if (c.node !== changed) return 0;
      const v = this.prop(c, changed, old, now);
      if (v === null) throw new DynError(MSG_UNSUPPORTED);
      return v;
    };
    let dx = a.x.node ? comp(a.x) : 0;
    let dy = a.y.node ? comp(a.y) : 0;
    if (a.xyType === 1) dy = 0;
    if (a.xyType === 2) dx = 0;
    dx *= a.multiplier;
    dy *= a.multiplier;
    const ang = this.values.get(a.id)?.angle ?? a.angle;
    if (Math.abs(ang) > 1e-12) {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      return { x: dx * c - dy * s, y: dx * s + dy * c, z: 0 };
    }
    return { x: dx, y: dy, z: 0 };
  }

  // -------------------------------------------------------------------------
  // 매개변수 바꾸기
  // -------------------------------------------------------------------------

  /** 가시성 상태. 바뀌면 참 */
  setVisibility(p: VisibilityParam, name: string): boolean {
    const st = p.states.find((s) => s.name === name) ?? p.states.find((s) => s.name.toUpperCase() === name.trim().toUpperCase());
    if (!st) throw new DynError(`가시성 상태 "${name}"이(가) 없습니다.`);
    const show = new Set(st.entities);
    let changed = this.state(p) !== st.name;
    for (const h of p.entities) {
      const it = this.item(h);
      if (!it) continue;
      const inv = !show.has(h);
      if (!!it.entity.invisible !== inv) {
        changed = true;
        this.geometryChanged = true;
        if (inv) it.entity.invisible = true;
        else delete it.entity.invisible;
      }
    }
    if (!changed) return false;
    this.values.get(p.id)!.state = st.name;
    this.changedNodes.add(p.id);
    return true;
  }

  /** 뒤집기. 바뀌면 참 */
  setFlip(p: FlipParam, flipped: boolean): boolean {
    if (this.flipped(p) === flipped) return false;
    const [a, b] = this.points(p.id);
    if (!a || !b || len(sub(b, a)) < EPS) throw new DynError(MSG_UNSUPPORTED);
    const m = affMirror(a, b);
    this.constrainedRun(() => {
      for (const act of actionsOf(this.def, p.id)) {
        if (act.kind !== 'flip') throw new DynError(MSG_UNSUPPORTED);
        this.transformEntities(act.entities, m);
        for (const n of act.nodes) this.transformNode(n, m, p.id);
      }
    });
    this.values.get(p.id)!.flipped = flipped;
    this.changedNodes.add(p.id);
    return true;
  }

  /** 선형 거리. 바뀌면 참 */
  setLinear(p: LinearParam, distance: number, opt: EvalOptions = {}): boolean {
    if (!(distance > 0) || !Number.isFinite(distance)) throw new DynError('거리는 0보다 커야 합니다.');
    const old = this.points(p.id);
    const [a, b] = old;
    if (!a || !b) throw new DynError(MSG_UNSUPPORTED);
    const d0 = len(sub(b, a));
    const d = opt.exact ? distance : snapToValueSet(p.values, distance, this.drawnDistance(p));
    if (sameNum(d, d0, 1e-9)) return false;
    if (p.constraint) return this.setConstraintParam(p, d);
    const u = d0 > EPS ? mul(sub(b, a), 1 / d0) : { x: 1, y: 0, z: 0 };
    let na: Vec3;
    let nb: Vec3;
    if (p.baseLocation === 1) {
      const m = mul(add(a, b), 0.5);
      na = sub(m, mul(u, d / 2));
      nb = add(m, mul(u, d / 2));
    } else if (opt.grip === 'base') {
      na = sub(b, mul(u, d));
      nb = { ...b };
    } else {
      na = { ...a };
      nb = add(a, mul(u, d));
    }
    const now = [na, nb, ...old.slice(2)];
    this.setPoints(p.id, now);
    this.runActions(p, old, now);
    return true;
  }

  /** XY 거리(부호는 지금 쪽을 지킨다). 바뀌면 참 */
  setXY(p: XYParam, x: number | undefined, y: number | undefined, opt: EvalOptions = {}): boolean {
    const old = this.points(p.id);
    const [a, b] = old;
    if (!a || !b) throw new DynError(MSG_UNSUPPORTED);
    const cur = this.xyValues(p);
    const drawnX = Math.abs(p.end.x - p.base.x);
    const drawnY = Math.abs(p.end.y - p.base.y);
    const fix = (v: number | undefined, c: number, vs: ValueSet, drawn: number) => {
      if (v === undefined) return c;
      const m = Math.abs(v);
      if (!Number.isFinite(m)) throw new DynError('값이 올바르지 않습니다.');
      const s = opt.exact ? m : snapToValueSet(vs, m, drawn);
      return (c < 0 ? -1 : 1) * s;
    };
    const nx = fix(x, cur.x, p.valuesX, drawnX);
    const ny = fix(y, cur.y, p.valuesY, drawnY);
    if (sameNum(nx, cur.x, 1e-9) && sameNum(ny, cur.y, 1e-9)) return false;
    let na: Vec3;
    let nb: Vec3;
    if (opt.grip === 'base') {
      na = { x: b.x - nx, y: b.y - ny, z: a.z };
      nb = { ...b };
    } else {
      na = { ...a };
      nb = { x: a.x + nx, y: a.y + ny, z: b.z };
    }
    const now = [na, nb, ...old.slice(2)];
    this.setPoints(p.id, now);
    this.runActions(p, old, now);
    return true;
  }

  /**
   * XY 그립 끌기: 그립의 X·Y가 가리키는 점 좌표(첫 점 base / 둘째 점 end)를 P로 옮기고 축마다 값 집합에 맞춘다.
   * 기준 모서리를 넘으면(부호가 바뀌면) 거절한다.
   */
  dragXY(p: XYParam, P: Vec3, wx: 'base' | 'end' | null, wy: 'base' | 'end' | null): boolean {
    const old = this.points(p.id);
    const [a, b] = old;
    if (!a || !b) throw new DynError(MSG_UNSUPPORTED);
    const na = { ...a };
    const nb = { ...b };
    const axis = (k: 'x' | 'y', w: 'base' | 'end' | null, vs: ValueSet, drawn: number) => {
      if (!w) return;
      const cur = b[k] - a[k];
      const want = w === 'base' ? b[k] - P[k] : P[k] - a[k];
      if (cur && Math.sign(want) !== Math.sign(cur)) throw new DynError('기준 모서리를 넘어 끌 수 없습니다.');
      const s = (cur < 0 ? -1 : 1) * snapToValueSet(vs, Math.abs(want), drawn);
      if (w === 'base') na[k] = b[k] - s;
      else nb[k] = a[k] + s;
    };
    axis('x', wx, p.valuesX, Math.abs(p.end.x - p.base.x));
    axis('y', wy, p.valuesY, Math.abs(p.end.y - p.base.y));
    if (sameNum(na.x, a.x, 1e-12) && sameNum(na.y, a.y, 1e-12) && sameNum(nb.x, b.x, 1e-12) && sameNum(nb.y, b.y, 1e-12)) return false;
    const now = [na, nb, ...old.slice(2)];
    this.setPoints(p.id, now);
    this.runActions(p, old, now);
    return true;
  }

  /** 회전 각도(라디안, 첫 점 → 둘째 점 방향). 바뀌면 참 */
  setRotation(p: RotationParam, angle: number, opt: EvalOptions = {}): boolean {
    const old = this.points(p.id);
    const [a, b] = old;
    if (!a || !b) throw new DynError(MSG_UNSUPPORTED);
    let t = angle;
    if (!opt.exact && p.values.type) t = snapToValueSet(p.values, t, null);
    let delta = t - Math.atan2(b.y - a.y, b.x - a.x);
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) < 1e-12) return false;
    const m = affRotate(delta, a);
    const now = [{ ...a }, xf(m, b), ...old.slice(2)];
    this.setPoints(p.id, now);
    this.runActions(p, old, now, { angle: delta });
    return true;
  }

  /** 점 매개변수 위치(블록 좌표, 주지 않은 축은 그대로). 바뀌면 참 */
  setPoint(p: PointParam, x: number | undefined, y: number | undefined): boolean {
    if (p.kind !== 'point') throw new DynError(MSG_UNSUPPORTED);
    const old = this.points(p.id);
    const [a] = old;
    if (!a) throw new DynError(MSG_UNSUPPORTED);
    if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y))) throw new DynError('값이 올바르지 않습니다.');
    const na = { x: x ?? a.x, y: y ?? a.y, z: a.z };
    if (sameNum(na.x, a.x, 1e-12) && sameNum(na.y, a.y, 1e-12)) return false;
    const now = [na, ...old.slice(1)];
    this.setPoints(p.id, now);
    this.runActions(p, old, now);
    return true;
  }

  /** 극좌표 거리 */
  polarDistance(p: PolarParam): number {
    return this.distance(p);
  }

  /** 극좌표 각도(라디안, 첫 점 → 둘째 점) */
  polarAngle(p: PolarParam): number {
    const [a, b] = this.points(p.id);
    return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  }

  /** 극좌표 거리·각도(주지 않은 것은 그대로, 첫 점 고정). 바뀌면 참 */
  setPolar(p: PolarParam, distance: number | undefined, angle: number | undefined, opt: EvalOptions = {}): boolean {
    const old = this.points(p.id);
    const [a, b] = old;
    if (!a || !b) throw new DynError(MSG_UNSUPPORTED);
    const d0 = len(sub(b, a));
    const t0 = Math.atan2(b.y - a.y, b.x - a.x);
    let d = d0;
    let t = t0;
    if (distance !== undefined) {
      if (!(distance > 0) || !Number.isFinite(distance)) throw new DynError('거리는 0보다 커야 합니다.');
      d = opt.exact ? distance : snapToValueSet(p.values, distance, len(sub(p.end, p.base)));
    }
    if (angle !== undefined) {
      if (!Number.isFinite(angle)) throw new DynError('각도가 올바르지 않습니다.');
      t = !opt.exact && p.angleValues.type ? snapToValueSet(p.angleValues, angle, null) : angle;
    }
    let delta = t - t0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (sameNum(d, d0, 1e-9) && Math.abs(delta) < 1e-12) return false;
    const now = [{ ...a }, { x: a.x + d * Math.cos(t0 + delta), y: a.y + d * Math.sin(t0 + delta), z: b.z }, ...old.slice(2)];
    this.setPoints(p.id, now);
    this.runActions(p, old, now, { angle: delta });
    return true;
  }

  // -------------------------------------------------------------------------
  // 조회
  // -------------------------------------------------------------------------

  lookupActionOf(p: LookupParam): LookupAction | undefined {
    const a = this.def.actions.find((x) => x.id === p.action && x.kind === 'lookup') as LookupAction | undefined;
    return a ?? (this.def.actions.find((x) => x.kind === 'lookup' && x.columns.some((c) => c.node === p.id)) as LookupAction | undefined);
  }

  /** 조회 매개변수의 열 */
  lookupColumn(a: LookupAction, p: LookupParam): number {
    const i = a.columns.findIndex((c) => c.lookup && c.node === p.id);
    return i >= 0 ? i : a.columns.findIndex((c) => c.node === p.id);
  }

  /** 고를 수 있는 조회 값(표의 행 이름, 같은 이름은 한 번) */
  lookupChoices(p: LookupParam): string[] {
    const a = this.lookupActionOf(p);
    if (!a) return [];
    const k = this.lookupColumn(a, p);
    if (k < 0) return [];
    const out: string[] = [];
    for (const r of a.rows) {
      const v = r[k] ?? '';
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }

  /** 조회 열의 역방향 조회 허용(고를 수 있는지) */
  lookupEditable(p: LookupParam): boolean {
    const a = this.lookupActionOf(p);
    if (!a) return false;
    const k = this.lookupColumn(a, p);
    return k >= 0 && a.columns[k]!.reverse;
  }

  /** 입력 열의 지금 값(읽을 수 없으면 null) */
  private inputValue(col: { node: number; prop: string }): string | number | boolean | null {
    const p = paramById(this.def, col.node);
    if (!p) return null;
    const k = col.prop.toLowerCase();
    switch (p.kind) {
      case 'visibility':
        return this.state(p);
      case 'flip':
        return this.flipped(p);
      case 'lookup':
        return this.lookupValue(p);
      case 'linear':
      case 'polar':
        return this.distance(p);
      case 'xy': {
        const v = this.xyValues(p);
        if (k.endsWith('x')) return Math.abs(v.x);
        if (k.endsWith('y')) return Math.abs(v.y);
        return null;
      }
      default:
        return null;
    }
  }

  private cellMatches(col: { node: number }, cell: string, cur: string | number | boolean): boolean {
    const s = cell.trim();
    if (typeof cur === 'number') {
      const n = Number(s);
      return s !== '' && Number.isFinite(n) && sameNum(n, cur);
    }
    if (typeof cur === 'boolean') {
      const p = paramById(this.def, col.node) as FlipParam | undefined;
      return flipCell(p, s) === cur;
    }
    return s === cur.trim();
  }

  /** 조회 표의 행을 고른다(조회 매개변수 값). 바뀌면 참 */
  setLookup(p: LookupParam, value: string): boolean {
    const a = this.lookupActionOf(p);
    if (!a) throw new DynError(MSG_UNSUPPORTED);
    const k = this.lookupColumn(a, p);
    if (k < 0) throw new DynError(MSG_UNSUPPORTED);
    const want = value.trim();
    const rows = a.rows.filter((r) => (r[k] ?? '').trim() === want);
    if (!rows.length) {
      const col = a.columns[k]!;
      if (want === (col.unmatched.trim() || LOOKUP_CUSTOM)) return false;
      throw new DynError(`조회 값 "${value}"이(가) 표에 없습니다.`);
    }
    const inputs = a.columns.map((c, i) => ({ c, i })).filter((x) => !x.c.lookup);
    // 여러 행이면 지금 입력과 맞는 행
    const row = rows.find((r) => inputs.every(({ c, i }) => {
      const cur = this.inputValue(c);
      return cur !== null && this.cellMatches(c, r[i] ?? '', cur);
    })) ?? rows[0]!;
    let changed = false;
    // 가시성 → 뒤집기 → 조회 → 거리 순
    const rank = (c: { node: number }) => {
      const kind = paramById(this.def, c.node)?.kind;
      return kind === 'visibility' ? 0 : kind === 'flip' ? 1 : kind === 'lookup' ? 2 : 3;
    };
    for (const { c, i } of [...inputs].sort((x, y) => rank(x.c) - rank(y.c))) {
      const cell = (row[i] ?? '').trim();
      if (!cell) continue;
      const q = paramById(this.def, c.node);
      if (!q) continue;
      const kp = c.prop.toLowerCase();
      switch (q.kind) {
        case 'visibility':
          changed = this.setVisibility(q, cell) || changed;
          break;
        case 'flip': {
          const f = flipCell(q, cell);
          if (f === null) throw new DynError(MSG_UNSUPPORTED);
          changed = this.setFlip(q, f) || changed;
          break;
        }
        case 'lookup':
          if (this.lookupValue(q) !== cell) {
            this.values.get(q.id)!.value = cell;
            this.changedNodes.add(q.id);
            changed = true;
          }
          break;
        case 'linear': {
          const n = Number(cell);
          if (!Number.isFinite(n)) throw new DynError(MSG_UNSUPPORTED);
          changed = this.setLinear(q, n, { exact: true }) || changed;
          break;
        }
        case 'xy': {
          const n = Number(cell);
          if (!Number.isFinite(n)) throw new DynError(MSG_UNSUPPORTED);
          if (kp.endsWith('x')) changed = this.setXY(q, n, undefined, { exact: true }) || changed;
          else if (kp.endsWith('y')) changed = this.setXY(q, undefined, n, { exact: true }) || changed;
          else throw new DynError(MSG_UNSUPPORTED);
          break;
        }
        default: {
          const cur = this.inputValue(c);
          if (cur === null || !this.cellMatches(c, cell, cur)) throw new DynError(MSG_UNSUPPORTED);
        }
      }
    }
    for (const [i, c] of a.columns.entries()) {
      if (!c.lookup) continue;
      const v = this.values.get(c.node);
      if (!v) continue;
      const cell = row[i] ?? '';
      if (v.value !== cell) {
        v.value = cell;
        this.changedNodes.add(c.node);
        changed = true;
      }
    }
    this.settleLookups(a.id);
    return changed;
  }

  /**
   * 조회 표마다 지금 입력과 일치하는 행을 찾아 조회 값을 맞춘다. 없으면 열의 일치하지 않는 이름(비었으면 "사용자").
   * except: 방금 직접 고른 표.
   */
  settleLookups(except?: number): void {
    for (const a of this.def.actions) {
      if (a.kind !== 'lookup' || a.id === except) continue;
      const inputs = a.columns.map((c, i) => ({ c, i })).filter((x) => !x.c.lookup);
      if (!inputs.length) continue;
      const cur = inputs.map(({ c }) => this.inputValue(c));
      if (cur.some((v) => v === null)) continue;
      const matching = a.rows.filter((r) => inputs.every(({ c, i }, j) => this.cellMatches(c, r[i] ?? '', cur[j]!)));
      const outs = a.columns.map((c, i) => ({ c, i })).filter((x) => x.c.lookup);
      const row = matching.find((r) => outs.every(({ c, i }) => (this.values.get(c.node)?.value ?? '') === (r[i] ?? ''))) ?? matching[0];
      for (const { c, i } of outs) {
        const v = this.values.get(c.node);
        if (!v) continue;
        const next = row ? (row[i] ?? '') : c.unmatched.trim() || LOOKUP_CUSTOM;
        if (v.value !== next) {
          v.value = next;
          this.changedNodes.add(c.node);
        }
      }
    }
  }
}

/** 뒤집기 열의 칸 → 뒤집힘(알 수 없으면 null) */
export function flipCell(p: FlipParam | undefined, cell: string): boolean | null {
  const s = cell.trim();
  if (p && p.flippedState && s === p.flippedState.trim()) return true;
  if (p && p.baseState && s === p.baseState.trim()) return false;
  const u = s.toUpperCase();
  if (s === FLIP_YES || u === 'FLIPPED' || u === '1' || u === 'TRUE') return true;
  if (s === FLIP_NOT || u === 'NOT FLIPPED' || u === '0' || u === 'FALSE') return false;
  return null;
}

/** 뒤집기 상태 이름(정의에 이름이 없으면 한국어판 기본) */
export function flipStateName(p: FlipParam, flipped: boolean): string {
  return flipped ? p.flippedState.trim() || FLIP_YES : p.baseState.trim() || FLIP_NOT;
}

/** 평가 시작 전 확인: 해석하지 못한 노드가 있으면 편집하지 않는다 */
export function assertEditable(def: DynDefinition): void {
  if (def.undecoded.length) throw new DynError(`이 동적 블록 정의는 읽을 수 없는 자료(${[...new Set(def.undecoded)].join(', ')})가 있어 고칠 수 없습니다.`);
}

export { xf as applyAffine3 };
