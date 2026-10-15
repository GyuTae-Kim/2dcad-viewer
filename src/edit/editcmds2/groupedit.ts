/**
 * GROUPEDIT의 그룹 편집(화면·DOM 없음): 객체 추가·제거, 이름 바꾸기, 분해.
 * 그룹 사전·GROUP 객체 작업은 src/edit/util/groups.ts(updateGroupOps·deleteGroupOps)를 쓴다.
 */
import type { CadDocument, GroupObject } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { deleteGroupOps, groupNameProblem, listGroups, updateGroupOps } from '../util/groups';
import type { EditOp } from '../session';

function groupOf(doc: CadDocument, gh: string): GroupObject | null {
  const g = doc.objects.get(normalizeHandle(gh));
  return g?.type === 'GROUP' ? (g as GroupObject) : null;
}

/** 그룹에 객체 더하기. 실제로 더한 수와 작업 */
export function addToGroupOps(doc: CadDocument, gh: string, handles: readonly string[]): { ops: EditOp[]; added: number } {
  const g = groupOf(doc, gh);
  if (!g) return { ops: [], added: 0 };
  const have = new Set(g.entities.map((x) => normalizeHandle(x)));
  const add: string[] = [];
  for (const h of handles) {
    const k = normalizeHandle(h);
    if (have.has(k) || !doc.entityIndex.has(k)) continue;
    have.add(k);
    add.push(k);
  }
  if (!add.length) return { ops: [], added: 0 };
  return { ops: updateGroupOps(doc, g.handle, { entities: [...g.entities, ...add] }), added: add.length };
}

/** 그룹에서 객체 빼기. 실제로 뺀 수와 작업(구성원이 모두 빠져도 이름 있는 그룹은 남는다) */
export function removeFromGroupOps(doc: CadDocument, gh: string, handles: readonly string[]): { ops: EditOp[]; removed: number } {
  const g = groupOf(doc, gh);
  if (!g) return { ops: [], removed: 0 };
  const drop = new Set(handles.map((h) => normalizeHandle(h)));
  const keep = g.entities.filter((x) => !drop.has(normalizeHandle(x)));
  const removed = g.entities.length - keep.length;
  if (!removed) return { ops: [], removed: 0 };
  // 이름 없는 그룹이 비면 그룹을 지운다
  if (!keep.length && g.unnamed) return { ops: deleteGroupOps(doc, g.handle), removed };
  return { ops: updateGroupOps(doc, g.handle, { entities: keep }), removed };
}

/** 그룹 이름 바꾸기. 쓸 수 없는 이름이면 까닭(글) */
export function renameGroupOps(doc: CadDocument, gh: string, name: string): EditOp[] | string {
  const g = groupOf(doc, gh);
  if (!g) return '그룹을 찾을 수 없습니다.';
  const cur = listGroups(doc).find((x) => x.handle === g.handle)?.name;
  const n = name.trim();
  if (n.startsWith('*')) return '이름에 쓸 수 없는 문자가 있습니다.';
  const bad = groupNameProblem(doc, n, cur);
  if (bad) return bad;
  if (cur === n) return [];
  return updateGroupOps(doc, g.handle, { name: n });
}

/** 그룹 분해(그룹 정의만 지우고 객체는 남긴다) */
export function explodeGroupOps(doc: CadDocument, gh: string): EditOp[] {
  return deleteGroupOps(doc, gh);
}
