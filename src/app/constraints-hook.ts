/**
 * 편집 뒤 구속 다시 풀기 훅. 다른 명령의 편집 결과에 구속으로 이어진 객체가 따라오게 하고, 구속 기록을 맞춘다.
 *
 * - constraintEditHook: commitResults(src/app/modify.ts)가 결과를 작업으로 바꾸기 전에 부른다.
 * - afterEditSolve: 편집 작업(EditOp[])을 직접 commit하는 명령(ERASE·특성 팔레트 등)이 commit 전에 부른다.
 *
 * 이동·회전·축척·신축·그립·정렬·특성 편집은 구속을 지키며 다시 풀고(못 지키면 편집을 거절),
 * 그 밖의 편집(자르기·연장·끊기 등)은 깨진 구속만 지운다. 지운 객체의 구속은 지운다.
 */
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditResult } from '../edit/geom';
import type { EditOp } from '../edit/session';
import { followEdit } from '../edit/constraint/system';
import { readStore, storeOps } from '../edit/constraint/store';
import type { DocState } from './docstate';

/** 구속을 지키며 다시 푸는 편집(명령 이름) */
export const MAINTAIN_LABELS = new Set(['MOVE', 'ROTATE', 'SCALE', 'STRETCH', 'GRIP', 'GRIPEDIT', 'ALIGN', 'PROPERTIES', 'PROPS', 'CHPROP', 'CHANGE', 'NUDGE', 'DRAGMOVE']);

/** 구속 명령 자신의 편집(다시 풀지 않는다) */
const OWN = /^(GC|DC|GEOMCONSTRAINT|DIMCONSTRAINT|AUTOCONSTRAIN|DELCONSTRAINT|PARAMETERS|CONSTRAINTBAR)/i;

export interface ConstraintHookResult {
  /** false면 구속을 지킬 수 없어 편집을 하지 말아야 한다(message) */
  ok: boolean;
  /** 따라 움직인 객체를 더하고, 구속 때문에 조정된 편집 객체를 바꾼 결과 */
  results: EditResult[];
  /** 구속 기록 갱신 작업(같은 트랜잭션에 넣는다) */
  ops: EditOp[];
  /** 알릴 말(지운 구속 수 등) */
  message?: string;
}

/** 잠긴 도면층의 객체 */
function lockedOf(st: DocState, handles: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    if (e && st.doc.layers.get(tableKey(e.layer))?.locked) out.add(h);
  }
  return out;
}

function lockedInStore(st: DocState): Set<string> {
  const s = readStore(st.doc);
  return lockedOf(st, new Set(s.constraints.flatMap((c) => c.refs.map((r) => r.h))));
}

function removedMessage(n: number | undefined): string | undefined {
  return n ? `구속조건 ${n}개를 제거했습니다.` : undefined;
}

/**
 * commitResults용 훅: 편집 결과(results)를 받아 구속을 다시 푼 결과를 돌려준다.
 * 구속이 없거나 구속 명령 자신의 편집이면 그대로 돌려준다.
 */
export function constraintEditHook(st: DocState, results: EditResult[], label: string): ConstraintHookResult {
  const store = readStore(st.doc);
  if (!store.constraints.length || OWN.test(label)) return { ok: true, results, ops: [] };
  const changes = new Map<string, Entity>();
  const removed = new Set<string>();
  for (const r of results) {
    for (const e of r.replace ?? []) changes.set(e.handle, e);
    for (const h of r.remove ?? []) removed.add(h);
  }
  for (const h of removed) changes.delete(h);
  if (!changes.size && !removed.size) return { ok: true, results, ops: [] };
  const mode = MAINTAIN_LABELS.has(label.toUpperCase()) ? 'maintain' : 'relax';
  const out = followEdit(st.doc, store, changes, removed, { mode, locked: lockedInStore(st) });
  if (!out.ok) return { ok: false, results, ops: [], message: out.message };
  let res = results;
  if (out.entities.size) {
    const adj = out.entities;
    res = results.map((r) => (r.replace ? { ...r, replace: r.replace.map((e) => adj.get(e.handle) ?? e) } : r));
    const followers = [...adj].filter(([h]) => !changes.has(h)).map(([, e]) => e);
    if (followers.length) res = [...res, { replace: followers }];
  }
  const ops = out.store ? (storeOps(st.doc, out.store, () => st.session.newHandle()) ?? []) : [];
  return { ok: true, results: res, ops, message: removedMessage(out.removed) };
}

/**
 * 편집 작업용 훅: commit 전에 부른다. modify 작업의 after는 구속에 맞게 제자리에서 바꾸고,
 * 따라 움직인 객체의 modify 작업과 구속 기록 갱신 작업을 extra로 돌려준다(ops 뒤에 붙인다).
 */
export function afterEditSolve(st: DocState, ops: EditOp[], label: string): { ok: boolean; extra: EditOp[]; message?: string } {
  const store = readStore(st.doc);
  if (!store.constraints.length || OWN.test(label)) return { ok: true, extra: [] };
  const changes = new Map<string, Entity>();
  const removed = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'modify') changes.set(op.after.handle, op.after);
    else if (op.kind === 'remove') removed.add(op.entity.handle);
    else if (op.kind === 'add') removed.delete(op.entity.handle);
  }
  for (const h of removed) changes.delete(h);
  if (!changes.size && !removed.size) return { ok: true, extra: [] };
  const mode = MAINTAIN_LABELS.has(label.toUpperCase()) ? 'maintain' : 'relax';
  const out = followEdit(st.doc, store, changes, removed, { mode, locked: lockedInStore(st) });
  if (!out.ok) return { ok: false, extra: [], message: out.message };
  const extra: EditOp[] = [];
  for (const [h, e] of out.entities) {
    const op = ops.find((o): o is Extract<EditOp, { kind: 'modify' }> => o.kind === 'modify' && o.after.handle === h);
    if (op) {
      op.after = e;
      continue;
    }
    const before = st.doc.entityIndex.get(h);
    const block = st.session.ownerOf(h);
    if (before && block) extra.push({ kind: 'modify', block, before, after: e });
  }
  if (out.store) extra.push(...(storeOps(st.doc, out.store, () => st.session.newHandle()) ?? []));
  return { ok: true, extra, message: removedMessage(out.removed) };
}
