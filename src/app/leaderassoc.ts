/**
 * 지시선 연관: 옛 지시선(LEADER)의 주석 객체(여러 줄 문자·공차·블록 참조 — 지시선 340 ↔ 주석의 반응자)를 옮기면
 * 지시선 끝(갈고리선이 있으면 그 시작점까지)이 같은 만큼 따라간다(AutoCAD와 같다).
 * 확정 직전 고리(App.commitHooks before)로 같은 트랜잭션에 지시선 수정을 더하므로 명령 취소 한 단계로 함께 되돌아간다.
 * 지시선이 같은 편집에서 이미 바뀌었으면(함께 옮김·복사) 건드리지 않는다.
 */
import type { Entity, LeaderEntity, Vec3 } from '../core/model';
import type { EditOp, Transaction } from '../edit/session';
import type { App } from './app';
import type { DocState } from './docstate';
import { addHook } from './hooks';

/** 주석 객체의 기준점(옮긴 양을 잴 점) */
function anchorOf(e: Entity): Vec3 | null {
  if (e.type === 'MTEXT' || e.type === 'TOLERANCE' || e.type === 'INSERT') return e.insert;
  return null;
}

/** 주석이 옮겨진 만큼 지시선 끝을 옮긴 사본(옮길 것이 없으면 null) */
export function followLeader(leader: LeaderEntity, before: Entity, after: Entity): LeaderEntity | null {
  const a = anchorOf(before);
  const b = anchorOf(after);
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return null;
  const n = leader.vertices.length;
  if (n < 2) return null;
  const c = structuredClone(leader);
  // 갈고리선이 있으면 마지막 두 점(갈고리선 시작·끝)이 주석과 함께 움직인다
  const from = c.hookline && n >= 3 ? n - 2 : n - 1;
  for (let i = from; i < n; i++) c.vertices[i] = { x: c.vertices[i]!.x + dx, y: c.vertices[i]!.y + dy, z: c.vertices[i]!.z };
  return c;
}

/** 트랜잭션의 주석 이동에 따라 지시선 수정 작업을 더한다 */
export function leaderFollowOps(st: DocState, tx: Transaction): EditOp[] {
  const touched = new Set<string>();
  for (const op of tx.ops) {
    if (op.kind === 'modify') touched.add(op.before.handle);
    else if (op.kind === 'remove' || op.kind === 'add') touched.add(op.entity.handle);
  }
  const extra: EditOp[] = [];
  for (const op of tx.ops) {
    if (op.kind !== 'modify') continue;
    const e = op.before;
    if (e.type !== 'MTEXT' && e.type !== 'TOLERANCE' && e.type !== 'INSERT') continue;
    for (const r of e.reactors ?? []) {
      const l = st.doc.entityIndex.get(r);
      if (l?.type !== 'LEADER' || l.annotation !== e.handle || touched.has(l.handle)) continue;
      const block = st.session.ownerOf(l.handle);
      const moved = block ? followLeader(l, op.before, op.after) : null;
      if (!moved || !block) continue;
      touched.add(l.handle);
      extra.push({ kind: 'modify', block, before: l, after: moved });
    }
  }
  return extra;
}

export function registerLeaderAssoc(app: App): void {
  addHook(app.commitHooks, {
    name: 'leaderassoc',
    before(st, tx) {
      const extra = leaderFollowOps(st, tx);
      return extra.length ? { ...tx, ops: [...tx.ops, ...extra] } : tx;
    },
  });
}
