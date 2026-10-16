/**
 * 시험 도우미: tests/cmds2/harness.ts는 모든 명령에 같은 묶음 번호(99)를 준다 → 명령마다 새 묶음 번호가 되게
 * 편집 세션의 commit·undoLastStep·opsInGroup을 감싼다(App.run이 명령마다 새 번호를 주는 것과 같게).
 */
import type { Harness, Input } from '../cmds2/harness';

export function perCommandGroups(h: Harness): Harness {
  const s = h.st.session;
  let current = 1000;
  const map = (g: number | undefined) => (g === 99 ? current : g);
  const commit = s.commit.bind(s);
  s.commit = (tx) => commit({ ...tx, group: map(tx.group) });
  const undoLastStep = s.undoLastStep.bind(s);
  s.undoLastStep = (g, n) => undoLastStep(map(g)!, n);
  const opsInGroup = s.opsInGroup.bind(s);
  s.opsInGroup = (g) => opsInGroup(map(g)!);
  const run = h.run.bind(h);
  h.run = async (name: string, inputs: Input[]) => {
    current++;
    await run(name, inputs);
  };
  return h;
}
