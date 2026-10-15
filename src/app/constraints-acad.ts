/**
 * AutoCAD 구속(연관 망의 2D 구속 그룹)을 편집과 맞추는 고리.
 *
 * 구속 기록(readStore)은 AutoCAD 그룹을 읽어 함께 보여 주고, 구속·매개변수를 고친 것은 storeOps가 원본에 되쓴다
 * (src/edit/assocnet). 여기서는 그 밖의 편집 — 객체를 옮기거나 지운 트랜잭션 — 을 확정 직전에 보고 AutoCAD 그룹의
 * 형상 캐시 좌표를 고치고 지운 객체의 노드를 뺀다(App의 확정 고리 commitHooks의 before).
 */
import { acadCommitOps } from '../edit/assocnet/writeback';
import type { Transaction } from '../edit/session';
import type { App } from './app';
import type { DocState } from './docstate';
import { addHook } from './hooks';

export function installAcadConstraintSync(app: App): void {
  addHook(app.commitHooks, {
    name: 'acad-constraints',
    before(st: DocState, tx: Transaction): Transaction {
      try {
        const ops = acadCommitOps(st.doc, tx.ops);
        return ops ? { ...tx, ops } : tx;
      } catch {
        // 원본 그룹을 고치지 못하면 편집은 그대로 하고 그룹은 손대지 않는다(저장하면 원본 그대로)
        return tx;
      }
    },
  });
}
