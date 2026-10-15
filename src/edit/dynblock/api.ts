/**
 * 동적 블록 참조 편집 API(UI 없음): 특성 목록, 값 바꾸기, 그립, 재설정.
 * 모든 함수는 문서를 바꾸지 않고 편집 작업(EditOp)을 돌려준다 — 호출한 쪽이 세션에 한 트랜잭션으로 넣는다.
 */
import type { CadDocument, Entity, InsertEntity, Vec2, Vec3 } from '../../core/model';
import { cloneEntity, ownerBlockKey } from '../session';
import { transformEntity } from '../geom/transform';
import { type Affine, affApply, affInv, affLin, affMul } from '../geom/math';
import { pathNearest, pathTangent } from '../geom/curve';
import { entityPath } from '../geom/path';
import { paramById } from './definition';
import { DynError, DynEval, assertEditable, flipCell, flipStateName, valueChoices } from './evaluate';
import { buildChangeOps, buildResetOps, insertAffine } from './build';
import { type DynRef, pointProp, readReference } from './reference';
import { type DynDefinition, type DynEditResult, type DynGripNode, type DynParam, type ParamKind, MSG_NOT_DYNAMIC, MSG_SAME, MSG_UNSUPPORTED } from './types';

// ---------------------------------------------------------------------------
// 특성
// ---------------------------------------------------------------------------

export interface DynProperty {
  /** 값 바꾸기에 쓰는 열쇠(매개변수 id, XY는 "id:x"·"id:y") */
  key: string;
  param: number;
  kind: ParamKind;
  label: string;
  description: string;
  /** 지금 값: 가시성·조회 = 이름, 뒤집기 = 참/거짓, 거리 = 수, 각도 = 라디안, 점 = Vec3 */
  value: string | number | boolean | Vec3;
  /** 편집기: select(options), length(0보다 큰 거리), coord(좌표, 음수 가능), angle, readonly */
  editor: 'select' | 'length' | 'coord' | 'angle' | 'readonly';
  options?: { value: string; label: string }[];
}

/** 동적 참조의 특성 행(특성 팔레트의 "사용자화" 범주). 동적 참조가 아니면 null */
export function dynProperties(doc: CadDocument, ins: InsertEntity): DynProperty[] | null {
  const ref = readReference(doc, ins);
  if (!ref) return null;
  const ev = new DynEval(doc, ref, false);
  ev.settleLookups();
  const out: DynProperty[] = [];
  const editable = !ref.def.undecoded.length;
  for (const p of ref.def.params) {
    if (!p.show) continue;
    const base = { key: String(p.id), param: p.id, kind: p.kind, label: p.label, description: p.description };
    switch (p.kind) {
      case 'visibility':
        out.push({ ...base, value: ev.state(p), editor: editable ? 'select' : 'readonly', options: p.states.map((s) => ({ value: s.name, label: s.name })) });
        break;
      case 'flip':
        out.push({
          ...base,
          label: p.label || '반전 상태',
          value: ev.flipped(p),
          editor: editable ? 'select' : 'readonly',
          options: [
            { value: '0', label: flipStateName(p, false) },
            { value: '1', label: flipStateName(p, true) },
          ],
        });
        break;
      case 'linear': {
        const ch = valueChoices(p.values, ev.drawnDistance(p));
        out.push({ ...base, value: ev.distance(p), editor: editable ? (ch.length ? 'select' : 'length') : 'readonly', options: ch.length ? ch.map((v) => ({ value: String(v), label: String(v) })) : undefined });
        break;
      }
      case 'xy': {
        const v = ev.xyValues(p);
        const cx = valueChoices(p.valuesX, Math.abs(p.end.x - p.base.x));
        const cy = valueChoices(p.valuesY, Math.abs(p.end.y - p.base.y));
        out.push({ ...base, key: `${p.id}:x`, label: p.labelX, description: p.descriptionX, value: Math.abs(v.x), editor: editable ? (cx.length ? 'select' : 'length') : 'readonly', options: cx.length ? cx.map((x) => ({ value: String(x), label: String(x) })) : undefined });
        out.push({ ...base, key: `${p.id}:y`, label: p.labelY, description: p.descriptionY, value: Math.abs(v.y), editor: editable ? (cy.length ? 'select' : 'length') : 'readonly', options: cy.length ? cy.map((x) => ({ value: String(x), label: String(x) })) : undefined });
        break;
      }
      case 'rotation':
        out.push({ ...base, value: ev.angle(p), editor: editable ? 'angle' : 'readonly' });
        break;
      case 'lookup': {
        const choices = ev.lookupChoices(p);
        out.push({ ...base, value: ev.lookupValue(p), editor: editable && ev.lookupEditable(p) && choices.length ? 'select' : 'readonly', options: choices.map((c) => ({ value: c, label: c })) });
        break;
      }
      case 'polar': {
        const ch = valueChoices(p.values, Math.hypot(p.end.x - p.base.x, p.end.y - p.base.y));
        out.push({ ...base, key: `${p.id}:d`, value: ev.polarDistance(p), editor: editable ? (ch.length ? 'select' : 'length') : 'readonly', options: ch.length ? ch.map((v) => ({ value: String(v), label: String(v) })) : undefined });
        out.push({ ...base, key: `${p.id}:a`, label: p.angleLabel, description: p.angleDescription, value: ev.polarAngle(p), editor: editable ? 'angle' : 'readonly' });
        break;
      }
      case 'point': {
        // 위치 X·Y(블록 기준점에서)
        const pt = ev.points(p.id)[0] ?? { x: 0, y: 0, z: 0 };
        const bp = ref.defBlock.basePoint;
        out.push({ ...base, key: `${p.id}:x`, label: `${p.label} X`, value: pt.x - bp.x, editor: editable ? 'coord' : 'readonly' });
        out.push({ ...base, key: `${p.id}:y`, label: `${p.label} Y`, value: pt.y - bp.y, editor: editable ? 'coord' : 'readonly' });
        break;
      }
      default: {
        const pt = ev.points(p.id)[0] ?? { x: 0, y: 0, z: 0 };
        out.push({ ...base, value: pt, editor: 'readonly' });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 값 바꾸기
// ---------------------------------------------------------------------------

export interface DynChange {
  /** 특성 열쇠(DynProperty.key), 매개변수 레이블·이름, 또는 id */
  key: string | number;
  /** 가시성·조회: 이름, 뒤집기: 참/거짓·상태 이름, 거리: 수, 회전: 라디안, XY: "id:x"·"id:y" 열쇠와 수 */
  value: string | number | boolean;
}

type Axis = 'x' | 'y' | 'd' | 'a';

function resolveKey(def: DynDefinition, key: string | number): { param: DynParam; axis?: Axis } | null {
  if (typeof key === 'number') {
    const p = paramById(def, key);
    return p ? { param: p } : null;
  }
  const m = /^(\d+):([xyda])$/i.exec(key.trim());
  if (m) {
    const p = paramById(def, Number(m[1]));
    return p ? { param: p, axis: m[2]!.toLowerCase() as Axis } : null;
  }
  const k = key.trim().toUpperCase();
  for (const p of def.params) {
    if (p.kind === 'xy') {
      if (p.labelX.toUpperCase() === k) return { param: p, axis: 'x' };
      if (p.labelY.toUpperCase() === k) return { param: p, axis: 'y' };
    }
    if (p.kind === 'polar' && p.angleLabel.toUpperCase() === k) return { param: p, axis: 'a' };
    if (p.kind === 'point') {
      if (`${p.label} X`.toUpperCase() === k) return { param: p, axis: 'x' };
      if (`${p.label} Y`.toUpperCase() === k) return { param: p, axis: 'y' };
    }
  }
  const p = def.params.find((q) => q.label.toUpperCase() === k) ?? def.params.find((q) => q.name.toUpperCase() === k) ?? (/^\d+$/.test(k) ? paramById(def, Number(k)) : undefined);
  return p ? { param: p } : null;
}

function toNumber(v: string | number | boolean): number {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw new DynError('값이 올바르지 않습니다.');
  return n;
}

function applyChange(ev: DynEval, c: DynChange, exact: boolean): boolean {
  const r = resolveKey(ev.def, c.key);
  if (!r) throw new DynError(`매개변수 "${c.key}"이(가) 없습니다.`);
  const p = r.param;
  switch (p.kind) {
    case 'visibility':
      return ev.setVisibility(p, String(c.value));
    case 'flip': {
      const f = typeof c.value === 'boolean' ? c.value : flipCell(p, String(c.value));
      if (f === null) throw new DynError(`반전 상태 "${String(c.value)}"을(를) 알 수 없습니다.`);
      return ev.setFlip(p, f);
    }
    case 'linear':
      return ev.setLinear(p, toNumber(c.value), { exact });
    case 'xy':
      if (!r.axis) throw new DynError('XY 매개변수는 X나 Y를 정하십시오.');
      return r.axis === 'x' ? ev.setXY(p, toNumber(c.value), undefined, { exact }) : ev.setXY(p, undefined, toNumber(c.value), { exact });
    case 'rotation':
      return ev.setRotation(p, toNumber(c.value), { exact });
    case 'lookup':
      return ev.setLookup(p, String(c.value));
    case 'polar':
      return r.axis === 'a' ? ev.setPolar(p, undefined, toNumber(c.value), { exact }) : ev.setPolar(p, toNumber(c.value), undefined, { exact });
    case 'point': {
      if (r.axis !== 'x' && r.axis !== 'y') throw new DynError('점 매개변수는 X나 Y를 정하십시오.');
      const bp = ev.ref.defBlock.basePoint;
      const v = toNumber(c.value);
      return r.axis === 'x' ? ev.setPoint(p, v + bp.x, undefined) : ev.setPoint(p, undefined, v + bp.y);
    }
    default:
      throw new DynError(MSG_UNSUPPORTED);
  }
}

function run(doc: CadDocument, ins: InsertEntity, newHandle: () => string, body: (ev: DynEval) => boolean): DynEditResult {
  const ref = readReference(doc, ins);
  if (!ref) return { ops: [], message: MSG_NOT_DYNAMIC };
  try {
    assertEditable(ref.def);
    const ev = new DynEval(doc, ref);
    if (!body(ev)) return { ops: [], message: MSG_SAME };
    ev.finish();
    ev.settleLookups();
    return buildChangeOps(doc, ins, ev, newHandle);
  } catch (e) {
    if (e instanceof DynError) return { ops: [], message: e.message };
    throw e;
  }
}

/**
 * 매개변수 값을 바꾸는 편집 작업. 여러 값을 한 번에(차례대로 평가) 바꿀 수 있다.
 * exact: 값 집합에 맞추지 않는다(다른 참조에서 복사한 값).
 */
export function dynSetOps(doc: CadDocument, ins: InsertEntity, changes: DynChange | DynChange[], newHandle: () => string, opt: { exact?: boolean } = {}): DynEditResult {
  const list = Array.isArray(changes) ? changes : [changes];
  return run(doc, ins, newHandle, (ev) => {
    let changed = false;
    for (const c of list) changed = applyChange(ev, c, !!opt.exact) || changed;
    return changed;
  });
}

/** RESETBLOCK: 정의의 기본 상태로(정의를 직접 가리키고 표현 자료를 지운다). 바꿀 것이 없으면 ops가 비어 있다 */
export function dynResetOps(doc: CadDocument, ins: InsertEntity, newHandle: () => string): DynEditResult {
  return buildResetOps(doc, ins, newHandle);
}

// ---------------------------------------------------------------------------
// 그립
// ---------------------------------------------------------------------------

export interface DynGrip {
  /** 그립 id("dyn:<그립 노드 id>") — 앱 그립 목록의 id로 쓴다 */
  id: string;
  /** 도면 좌표 */
  point: Vec2;
  /** 매개변수 종류(그립 모양: 가시성·조회 ▼, 뒤집기 화살표, 선형 ▶, 회전 원, 정렬 마름모, 나머지 사각형) */
  kind: ParamKind;
  param: number;
  label: string;
  description: string;
  /**
   * menu = 목록에서 고르기(가시성·조회), toggle = 누르면 바로(뒤집기), drag = 끌기(선형·XY·회전·극좌표·점·정렬),
   * none = 지원하지 않음. 정렬 그립 끌기는 참조를 옮기고, 근처 곡선이 있으면(opt.align) 그 접선 방향으로 돌린다.
   */
  mode: 'menu' | 'toggle' | 'drag' | 'none';
  /** 선형·뒤집기 그립의 방향(도면 좌표 단위 벡터) */
  direction?: Vec2;
  /** 끌기 그립의 기준점(도면 좌표, 고무줄 선용) */
  anchor?: Vec2;
}

interface GripInfo {
  node: DynGripNode;
  param: DynParam;
  /** 블록 좌표 위치 */
  at: Vec3;
  /** 그립의 X·Y가 가리키는 점(base | end) */
  wx: 'base' | 'end' | null;
  wy: 'base' | 'end' | null;
}

function which(prop: string | undefined): 'base' | 'end' | null {
  const k = (prop ?? '').toLowerCase();
  if (k.includes('end')) return 'end';
  if (k.includes('base') || k === 'updatedx' || k === 'updatedy') return 'base';
  return null;
}

/** 지금 가시성 상태에서 보이는 노드인지 */
function visibleNode(ref: DynRef, p: DynParam): boolean {
  for (const v of ref.def.params) {
    if (v.kind !== 'visibility' || v.id === p.id) continue;
    const st = v.states.find((s) => s.name === ref.values.get(v.id)?.state);
    if (st && !st.nodes.includes(p.handle.toUpperCase())) return false;
  }
  return true;
}

function gripInfos(ref: DynRef): GripInfo[] {
  const out: GripInfo[] = [];
  for (const p of ref.def.params) {
    if (!visibleNode(ref, p)) continue;
    const pts = ref.values.get(p.id)?.points ?? [];
    for (const gid of p.grips) {
      const node = ref.def.grips.find((g) => g.id === gid);
      if (!node) continue;
      const x = node.x ? pointProp(node.x.node === p.id ? pts : ref.values.get(node.x.node)?.points, node.x.prop) : null;
      const y = node.y ? pointProp(node.y.node === p.id ? pts : ref.values.get(node.y.node)?.points, node.y.prop) : null;
      let at: Vec3;
      if (x !== null && y !== null) at = { x, y, z: 0 };
      else {
        // 위치 식을 읽지 못하면 정의 위치를 매개변수 첫 점이 옮겨진 만큼
        const d0 = 'location' in p ? p.location : p.base;
        const c0 = pts[0] ?? d0;
        at = { x: node.location.x + c0.x - d0.x, y: node.location.y + c0.y - d0.y, z: 0 };
      }
      out.push({ node, param: p, at, wx: which(node.x?.prop), wy: which(node.y?.prop) });
    }
  }
  return out;
}

const unit = (v: Vec2): Vec2 | undefined => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-12 ? { x: v.x / l, y: v.y / l } : undefined;
};

/** 선택한 동적 참조의 매개변수 그립(도면 좌표). 동적 참조가 아니면 빈 배열 */
export function dynGrips(doc: CadDocument, ins: InsertEntity): DynGrip[] {
  const ref = readReference(doc, ins);
  if (!ref) return [];
  const W = insertAffine(ref.defBlock, ins);
  const editable = !ref.def.undecoded.length;
  const ev = new DynEval(doc, ref, false);
  return gripInfos(ref).map((g) => {
    const p = g.param;
    let mode: DynGrip['mode'] = 'none';
    if (editable) {
      if (p.kind === 'visibility') mode = 'menu';
      else if (p.kind === 'lookup') mode = ev.lookupEditable(p) && ev.lookupChoices(p).length ? 'menu' : 'none';
      else if (p.kind === 'flip') mode = 'toggle';
      else if (p.kind === 'linear' || p.kind === 'xy' || p.kind === 'rotation' || p.kind === 'point' || p.kind === 'alignment') mode = 'drag';
      // 극좌표는 끝점 그립만(첫 점을 옮기는 극좌표 신축은 확인하지 못했다)
      else if (p.kind === 'polar') mode = g.wx === 'end' ? 'drag' : 'none';
    }
    const pts = ref.values.get(p.id)?.points ?? [];
    let direction: Vec2 | undefined;
    let anchor: Vec2 | undefined;
    if (p.kind === 'linear' && pts[0] && pts[1]) {
      const d = g.wx === 'base' ? { x: pts[0].x - pts[1].x, y: pts[0].y - pts[1].y } : { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
      direction = unit(affLin(W, d));
      anchor = affApply(W, p.baseLocation === 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : g.wx === 'base' ? pts[1] : pts[0]);
    } else if ((p.kind === 'xy' || p.kind === 'rotation' || p.kind === 'polar') && pts[0] && pts[1]) {
      anchor = affApply(W, g.wx === 'base' && p.kind === 'xy' ? pts[1] : pts[0]);
    } else if (p.kind === 'alignment' && pts[0] && pts[1]) {
      direction = unit(affLin(W, { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y }));
    } else if (p.kind === 'flip' && pts[0] && pts[1]) {
      const o = g.node.orientation;
      const line = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
      let dir = o && Math.hypot(o.x, o.y) > 1e-12 ? { x: o.x, y: o.y } : { x: -line.y, y: line.x };
      if (ev.flipped(p)) dir = { x: -dir.x, y: -dir.y };
      direction = unit(affLin(W, dir));
    }
    return { id: `dyn:${g.node.id}`, point: affApply(W, g.at), kind: p.kind, param: p.id, label: p.label, description: p.description, mode, direction, anchor };
  });
}

function gripOf(ref: DynRef, gripId: string): GripInfo | null {
  const m = /^dyn:(-?\d+)$/.exec(gripId);
  if (!m) return null;
  const id = Number(m[1]);
  return gripInfos(ref).find((g) => g.node.id === id) ?? null;
}

/** 끄는 그립을 도면 점 to로 옮긴 평가(블록 좌표). 바뀌면 참 */
function dragGrip(ev: DynEval, g: GripInfo, P: Vec3): boolean {
  const p = g.param;
  if (p.kind === 'point') return ev.setPoint(p, P.x, P.y);
  const pts = ev.points(p.id);
  const [a, b] = pts;
  if (!a || !b) throw new DynError(MSG_UNSUPPORTED);
  switch (p.kind) {
    case 'linear': {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const u = L > 1e-12 ? { x: (b.x - a.x) / L, y: (b.y - a.y) / L } : { x: 1, y: 0 };
      let d: number;
      if (p.baseLocation === 1) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        d = 2 * Math.abs((P.x - mx) * u.x + (P.y - my) * u.y);
      } else if (g.wx === 'base') d = (b.x - P.x) * u.x + (b.y - P.y) * u.y;
      else d = (P.x - a.x) * u.x + (P.y - a.y) * u.y;
      if (!(d > 1e-12)) throw new DynError('거리는 0보다 커야 합니다.');
      return ev.setLinear(p, d, { grip: g.wx === 'base' && p.baseLocation !== 1 ? 'base' : 'end' });
    }
    case 'xy':
      return ev.dragXY(p, P, g.wx, g.wy);
    case 'rotation':
      return ev.setRotation(p, Math.atan2(P.y - a.y, P.x - a.x));
    case 'polar': {
      if (g.wx !== 'end') throw new DynError(MSG_UNSUPPORTED);
      const d = Math.hypot(P.x - a.x, P.y - a.y);
      if (!(d > 1e-12)) throw new DynError('거리는 0보다 커야 합니다.');
      return ev.setPolar(p, d, Math.atan2(P.y - a.y, P.x - a.x));
    }
    default:
      throw new DynError(MSG_UNSUPPORTED);
  }
}

// ---------------------------------------------------------------------------
// 정렬 매개변수
// ---------------------------------------------------------------------------

/** 정렬 그립을 맞출 곡선 위 자리(도면 좌표) */
export interface AlignTarget {
  /** 곡선 위 가장 가까운 점 */
  point: Vec2;
  /** 그 점의 접선 방향(라디안) */
  angle: number;
}

/** 그립 편집 선택 사항 */
export interface DynGripOptions {
  /** 정렬 그립: 근처 곡선(없으면 참조를 돌리지 않고 옮기기만 한다) */
  align?: AlignTarget | null;
}

/** 곡선 객체(선·폴리선·호·원·타원·스플라인 …) 위에서 p에 가장 가까운 점과 접선 방향. 곡선이 아니면 null */
export function alignTargetOn(e: Entity, p: Vec2): AlignTarget | null {
  const path = entityPath(e);
  if (!path?.pieces.length) return null;
  const n = pathNearest(path, p);
  const t = pathTangent(path, n.s);
  if (!Number.isFinite(n.d) || !(Math.hypot(t.x, t.y) > 1e-12)) return null;
  return { point: { x: n.p.x, y: n.p.y }, angle: Math.atan2(t.y, t.x) };
}

/**
 * 정렬 그립을 to로 끈 참조: 정렬 기준점이 to(곡선이 있으면 곡선 위 점)에 오게 옮기고, 곡선이 있으면 정렬 방향(첫 점 → 둘째 점)이
 * 곡선 접선과 나란하게 돌린다(두 방향 중 지금 방향에 가까운 쪽). 블록 내용·캐시는 그대로(참조의 위치·회전만 — AutoCAD 정렬
 * 매개변수는 참조의 회전 특성을 바꾼다). 정렬 종류(280)는 AutoCAD 예제 도면(문·변기, 280 = 1)의 정렬 방향이 벽 선을 따라
 * 그려져 있어 접선에 나란히 맞추는 것으로 보았다(280 = 0의 뜻은 실물이 없어 같게 둔다).
 */
function alignedInsert(ref: DynRef, ins: InsertEntity, g: GripInfo, to: Vec2, target: AlignTarget | null | undefined): Affine | null {
  const pts = ref.values.get(g.param.id)?.points ?? [];
  const [a, b] = pts;
  if (!a) return null;
  const W = insertAffine(ref.defBlock, ins);
  const Wi = affInv(W);
  if (!Wi) return null;
  const A = affApply(W, a);
  const q = target ? target.point : to;
  let turn = 0;
  if (target && b) {
    const dir = affLin(W, { x: b.x - a.x, y: b.y - a.y });
    if (Math.hypot(dir.x, dir.y) > 1e-12) {
      const cur = Math.atan2(dir.y, dir.x);
      const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
      const d1 = wrap(target.angle - cur);
      const d2 = wrap(target.angle + Math.PI - cur);
      turn = Math.abs(d1) <= Math.abs(d2) ? d1 : d2;
    }
  }
  // D = 기준점 둘레로 turn 돌린 뒤 기준점을 q로
  const c = Math.cos(turn);
  const s2 = Math.sin(turn);
  const D: Affine = [c, s2, -s2, c, q.x - (c * A.x - s2 * A.y), q.y - (s2 * A.x + c * A.y)];
  return D;
}

/** 정렬 그립 끌기: 참조(속성 포함)를 옮기고 돌린 편집 작업 */
function alignOps(doc: CadDocument, ref: DynRef, ins: InsertEntity, g: GripInfo, to: Vec2, opt: DynGripOptions): DynEditResult {
  const D = alignedInsert(ref, ins, g, to, opt.align);
  if (!D) return { ops: [], message: MSG_UNSUPPORTED };
  const owner = ownerBlockKey(doc, ins.handle);
  if (!owner) return { ops: [], message: '참조가 들어 있는 블록을 찾지 못했습니다.' };
  if (Math.abs(D[0] - 1) < 1e-12 && Math.abs(D[1]) < 1e-12 && Math.hypot(D[4], D[5]) < 1e-12) return { ops: [], message: MSG_SAME };
  const r = transformEntity(ins, D, doc);
  const out = (r.replace?.[0] ?? r.add?.[0]) as InsertEntity | undefined;
  if (!out || out.type !== 'INSERT') return { ops: [], message: MSG_UNSUPPORTED };
  const after = cloneEntity(out);
  after.handle = ins.handle;
  delete after.dwgRaw;
  return { ops: [{ kind: 'modify', block: owner, before: ins, after }] };
}

/**
 * 그립 편집 작업. 끌기 그립(선형·XY·회전·극좌표·점)은 도면 점 to로 옮기고(값 집합에 맞춘다), 뒤집기 그립은 뒤집는다(to는 쓰지 않는다).
 * 정렬 그립은 참조를 to로 옮기고 opt.align 곡선의 접선에 맞춰 돌린다. 가시성·조회 그립은 목록에서 고르는 것이므로 dynSetOps를 쓴다.
 */
export function applyDynGrip(doc: CadDocument, ins: InsertEntity, gripId: string, to: Vec2 | null, newHandle: () => string, opt: DynGripOptions = {}): DynEditResult {
  const ref = readReference(doc, ins);
  if (!ref) return { ops: [], message: MSG_NOT_DYNAMIC };
  const g = gripOf(ref, gripId);
  if (!g) return { ops: [], message: '그립을 찾지 못했습니다.' };
  if (g.param.kind === 'visibility' || g.param.kind === 'lookup') return { ops: [], message: '목록에서 상태를 고르십시오.' };
  if (g.param.kind === 'alignment') {
    if (ref.def.undecoded.length) return { ops: [], message: MSG_UNSUPPORTED };
    return to ? alignOps(doc, ref, ins, g, to, opt) : { ops: [], message: MSG_UNSUPPORTED };
  }
  const Wi = affInv(insertAffine(ref.defBlock, ins));
  return run(doc, ins, newHandle, (ev) => {
    if (g.param.kind === 'flip') return ev.setFlip(g.param, !ev.flipped(g.param));
    if (!to || !Wi) throw new DynError(MSG_UNSUPPORTED);
    const q = affApply(Wi, to);
    return dragGrip(ev, g, { x: q.x, y: q.y, z: 0 });
  });
}

/** 그립을 to로 끌었을 때의 모양(도면 좌표 객체, 미리보기용). 지원하지 않으면 빈 배열 */
export function previewDynGrip(doc: CadDocument, ins: InsertEntity, gripId: string, to: Vec2, opt: DynGripOptions = {}): Entity[] {
  const ref = readReference(doc, ins);
  if (!ref || ref.def.undecoded.length) return [];
  const g = gripOf(ref, gripId);
  if (!g || g.param.kind === 'visibility' || g.param.kind === 'lookup') return [];
  const W = insertAffine(ref.defBlock, ins);
  const Wi = affInv(W);
  if (!Wi) return [];
  if (g.param.kind === 'alignment') {
    const D = alignedInsert(ref, ins, g, to, opt.align);
    if (!D) return [];
    const M = affMul(D, W);
    const out: Entity[] = [];
    for (const e of ref.block.entities) {
      if (e.invisible || e.type === 'ATTDEF') continue;
      const r = transformEntity(e, M, doc);
      for (const x of [...(r.replace ?? []), ...(r.add ?? [])]) out.push(x);
    }
    return out;
  }
  try {
    const ev = new DynEval(doc, ref);
    const q = affApply(Wi, to);
    if (g.param.kind === 'flip') ev.setFlip(g.param, !ev.flipped(g.param));
    else dragGrip(ev, g, { x: q.x, y: q.y, z: 0 });
    ev.finish();
    const out: Entity[] = [];
    for (const it of [...ev.items, ...ev.copies]) {
      if (it.entity.invisible || it.entity.type === 'ATTDEF') continue;
      const r = transformEntity(it.entity, W, doc);
      for (const e of [...(r.replace ?? []), ...(r.add ?? [])]) out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

/** 동적 참조인지(정의를 해석할 수 있는지와 무관) */
export { isDynamicReference, definitionName } from './reference';
