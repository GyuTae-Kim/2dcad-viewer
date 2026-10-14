/**
 * 원호 정렬 문자 편집(순수 함수): 호에서 만들기, 이동·회전·축척·대칭, 분해, 호를 따라가기(연관).
 *
 * 연관 규칙(followArcTexts):
 * - 호가 바뀌면(이동·회전·축척·그립·TRIM·LENGTHEN 등으로 같은 핸들의 ARC가 바뀜) 그 호를 따르는 문자를 새 호에 다시 놓는다.
 *   같은 편집에서 문자도 같은 행렬로 함께 움직였으면(호와 맞으면) 그대로 둔다.
 * - 문자가 새 호에 들어가지 않거나 호가 호가 아니게 되면 연관을 끊는다(문자는 그 자리에 남는다).
 * - 문자만 옮기면(호와 맞지 않게 되면) 연관을 끊는다. 문자만 복사하면 복사본은 연관이 없고,
 *   호와 함께 같은 행렬로 복사한 문자는 같은 편집에서 생긴 맞는 호를 따른다.
 * - 호를 지우면(ERASE 등) 핸들은 남긴다: 명령 취소로 호가 돌아오면 연관도 돌아오고, 저장할 때 없는 호는 빠진다.
 */
import type { ArcEntity, ArcTextEntity, Entity, Vec3 } from '../../core/model';
import { type ArcTextDef, arcTextDefaults, arcTextError, arcTextParts } from '../../text/arctext';
import type { EditOp, EditSession, Transaction } from '../session';
import { type Affine, affApply, affSimilarity, normAngle } from '../geom/math';
import { isNaturalExt } from '../geom/ocs';
import { type EditResult, MSG } from '../geom/types';

const TAU = Math.PI * 2;

export interface ArcTextOptions extends Partial<Omit<ArcTextDef, 'center' | 'radius' | 'startAngle' | 'endAngle'>> {
  style: string;
  height: number;
  text: string;
  font?: string;
  bold?: boolean;
  italic?: boolean;
}

/** 호를 따르는 새 원호 정렬 문자(핸들 ''; 표시 특성은 호출한 쪽이 정한다) */
export function newArcText(arc: ArcEntity, opt: ArcTextOptions, props: Pick<Entity, 'layer' | 'color' | 'linetype' | 'lineweight' | 'ltscale' | 'transparency'>): ArcTextEntity {
  const d = arcTextDefaults();
  const e: ArcTextEntity = {
    ...d,
    handle: '',
    layer: props.layer,
    color: { ...props.color },
    linetype: props.linetype,
    lineweight: props.lineweight,
    ltscale: props.ltscale,
    transparency: props.transparency,
    text: opt.text,
    center: { ...arc.center },
    radius: arc.radius,
    startAngle: arc.startAngle,
    endAngle: arc.endAngle,
    style: opt.style,
    height: opt.height,
  };
  for (const k of ['font', 'widthFactor', 'charSpacing', 'offset', 'leftOffset', 'rightOffset', 'alignment', 'position', 'direction', 'reversed', 'underline', 'bold', 'italic'] as const) {
    const v = opt[k];
    if (v !== undefined) (e as unknown as Record<string, unknown>)[k] = v;
  }
  if (arc.handle) e.arc = arc.handle;
  if (arc.extrusion && !isNaturalExt(arc.extrusion)) e.extrusion = { ...arc.extrusion };
  return e;
}

const sameAngle = (a: number, b: number, tol: number) => {
  const d = Math.abs(normAngle(a) - normAngle(b));
  return d <= tol || TAU - d <= tol;
};

const sameExt = (a: Vec3 | undefined, b: Vec3 | undefined) => {
  const x = a ?? { x: 0, y: 0, z: 1 };
  const y = b ?? { x: 0, y: 0, z: 1 };
  return Math.abs(x.x - y.x) < 1e-9 && Math.abs(x.y - y.y) < 1e-9 && Math.abs(x.z - y.z) < 1e-9;
};

/** 문자의 원호가 그 호와 같은지 */
export function fitsArc(e: ArcTextEntity, a: ArcEntity): boolean {
  const tol = 1e-7 * Math.max(1, Math.abs(a.radius), Math.abs(a.center.x), Math.abs(a.center.y));
  return (
    Math.abs(e.center.x - a.center.x) <= tol &&
    Math.abs(e.center.y - a.center.y) <= tol &&
    Math.abs(e.radius - a.radius) <= tol &&
    sameAngle(e.startAngle, a.startAngle, 1e-7) &&
    sameAngle(e.endAngle, a.endAngle, 1e-7) &&
    sameExt(e.extrusion, a.extrusion)
  );
}

/** 새 호에 다시 놓은 문자(들어가지 않으면 null) */
export function refitArcText(e: ArcTextEntity, a: ArcEntity): ArcTextEntity | null {
  const out: ArcTextEntity = { ...e, center: { ...a.center }, radius: a.radius, startAngle: a.startAngle, endAngle: a.endAngle };
  if (a.extrusion && !isNaturalExt(a.extrusion)) out.extrusion = { ...a.extrusion };
  else delete out.extrusion;
  return arcTextError(out) ? null : out;
}

/** 이동·회전·균일 축척·대칭. 대칭해도 읽을 수 있게 다시 놓는다(MIRRTEXT와 무관). 고르지 않은 축척·기울이기는 거절 */
export function xformArcText(e: ArcTextEntity, m: Affine, dz = 0): EditResult {
  if (!isNaturalExt(e.extrusion)) return { message: MSG.cannotTransform };
  const sim = affSimilarity(m, 1e-7);
  if (!sim) return { message: '원호 정렬 문자는 고르지 않게 축척하거나 기울일 수 없습니다.' };
  const c = affApply(m, e.center);
  const s = sim.s;
  const r: ArcTextEntity = {
    ...e,
    center: { x: c.x, y: c.y, z: e.center.z + dz },
    radius: e.radius * s,
    height: e.height * s,
    charSpacing: e.charSpacing * s,
    offset: e.offset * s,
    leftOffset: e.leftOffset * s,
    rightOffset: e.rightOffset * s,
    startAngle: sim.mirror ? normAngle(sim.rot - e.endAngle) : normAngle(e.startAngle + sim.rot),
    endAngle: sim.mirror ? normAngle(sim.rot - e.startAngle) : normAngle(e.endAngle + sim.rot),
  };
  if (sim.mirror) {
    // 대칭하면 읽는 방향이 거꾸로 되므로 왼쪽·오른쪽 간격띄우기와 왼쪽·오른쪽 정렬을 바꾼다
    r.leftOffset = e.rightOffset * s;
    r.rightOffset = e.leftOffset * s;
    if (e.alignment === 2) r.alignment = 3;
    else if (e.alignment === 3) r.alignment = 2;
  }
  return { replace: [r] };
}

/** 분해: 한 줄 문자(글자마다)와 밑줄 호 */
export function explodeArcText(e: ArcTextEntity): EditResult {
  const parts = arcTextParts(e).map((p) => ({ ...p, handle: '' }) as Entity);
  if (!parts.length) return { message: MSG.cannotExplode };
  return { remove: e.handle ? [e.handle] : [], add: parts };
}

/** 문서의 원호 정렬 문자 중 이 호들을 따르는 것 */
function followersOf(index: ReadonlyMap<string, Entity>, arcs: ReadonlySet<string>): ArcTextEntity[] {
  const out: ArcTextEntity[] = [];
  if (!arcs.size) return out;
  for (const e of index.values()) if (e.type === 'ARCALIGNEDTEXT' && e.arc && arcs.has(e.arc)) out.push(e);
  return out;
}

/**
 * 편집 작업 목록에 연관을 반영한다(커밋 직전). 바꿀 것이 없으면 같은 배열을 돌려준다.
 * index = 문서의 핸들 색인(작업 적용 전), ownerOf = 객체가 든 블록 키.
 */
export function followArcTexts(index: ReadonlyMap<string, Entity>, ops: readonly EditOp[], ownerOf: (h: string) => string | null): EditOp[] {
  let touches = false;
  for (const op of ops) {
    const es = op.kind === 'modify' ? [op.before, op.after] : op.kind === 'add' || op.kind === 'remove' ? [op.entity] : [];
    if (es.some((e) => e.type === 'ARC' || e.type === 'ARCALIGNEDTEXT')) {
      touches = true;
      break;
    }
  }
  if (!touches) return ops as EditOp[];
  // 이 편집 뒤의 객체(지운 것은 null)
  const after = new Map<string, Entity | null>();
  const added = new Map<string, Entity>();
  for (const op of ops) {
    if (op.kind === 'modify') after.set(op.after.handle, op.after);
    else if (op.kind === 'add') {
      after.set(op.entity.handle, op.entity);
      added.set(op.entity.handle, op.entity);
    } else if (op.kind === 'remove' && !added.has(op.entity.handle)) after.set(op.entity.handle, null);
  }
  const arcNow = (h: string): Entity | null | undefined => (after.has(h) ? after.get(h) : index.get(h));
  const changedArcs = new Set<string>();
  for (const op of ops) if (op.kind === 'modify' && (op.before.type === 'ARC' || op.after.type === 'ARC')) changedArcs.add(op.after.handle);
  const addedArcs = [...added.values()].filter((e): e is ArcEntity => e.type === 'ARC');
  let changed = false;
  const out: EditOp[] = [];
  const inTx = new Set<string>();
  const fixText = (t: ArcTextEntity, isNew: boolean): ArcTextEntity => {
    if (!t.arc) return t;
    const a = arcNow(t.arc);
    if (a?.type === 'ARC' && fitsArc(t, a)) return t;
    if (isNew) {
      // 복사: 같은 편집에서 생긴 맞는 호를 따른다(없으면 연관 없음)
      const m = addedArcs.find((x) => fitsArc(t, x));
      const r = { ...t };
      if (m?.handle) r.arc = m.handle;
      else delete r.arc;
      return r;
    }
    if (a?.type === 'ARC' && changedArcs.has(t.arc)) {
      const f = refitArcText(t, a);
      if (f) return f;
    }
    if (a === null) return t; // 호를 지웠으면 핸들을 남긴다
    const r = { ...t };
    delete r.arc;
    return r;
  };
  for (const op of ops) {
    if (op.kind === 'modify' && op.after.type === 'ARCALIGNEDTEXT') {
      inTx.add(op.after.handle);
      const f = fixText(op.after, false);
      if (f !== op.after) {
        changed = true;
        out.push({ ...op, after: f });
        continue;
      }
    } else if (op.kind === 'add' && op.entity.type === 'ARCALIGNEDTEXT') {
      inTx.add(op.entity.handle);
      const f = fixText(op.entity, true);
      if (f !== op.entity) {
        changed = true;
        out.push({ ...op, entity: f });
        continue;
      }
    } else if (op.kind === 'remove' && op.entity.type === 'ARCALIGNEDTEXT') inTx.add(op.entity.handle);
    out.push(op);
  }
  // 이 편집에 없는 문자: 바뀐 호를 따라간다
  for (const t of followersOf(index, changedArcs)) {
    if (inTx.has(t.handle)) continue;
    const a = arcNow(t.arc!);
    if (a?.type === 'ARC' && fitsArc(t, a)) continue;
    let next: ArcTextEntity | null = a?.type === 'ARC' ? refitArcText(t, a) : null;
    if (!next) {
      next = { ...t };
      delete next.arc;
    }
    const block = ownerOf(t.handle);
    if (!block) continue;
    out.push({ kind: 'modify', block, before: t, after: next });
    changed = true;
  }
  return changed ? out : (ops as EditOp[]);
}

/**
 * 편집 세션의 commit을 감싸 커밋마다 연관을 반영한다(한 번만). 되돌리기는 저장된 트랜잭션(따라간 문자 포함)을 그대로 되돌린다.
 */
export function followArcTextsOnCommit(session: EditSession): void {
  const s = session as EditSession & { __arcTextHooked?: boolean };
  if (s.__arcTextHooked) return;
  s.__arcTextHooked = true;
  const commit = s.commit.bind(s);
  s.commit = (tx: Transaction) => {
    let ops = tx.ops;
    try {
      ops = followArcTexts(s.doc.entityIndex, tx.ops, (hd) => s.ownerOf(hd));
    } catch {
      ops = tx.ops; // 연관을 맞추지 못해도 편집은 한다
    }
    commit(ops === tx.ops ? tx : { ...tx, ops });
  };
}
