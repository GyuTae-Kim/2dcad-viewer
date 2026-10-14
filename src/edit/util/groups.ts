/**
 * 그룹(GROUP 객체와 ACAD_GROUP 사전) 도우미(UI 없음).
 * 그룹은 이름 있는 객체 사전의 ACAD_GROUP 사전에 이름 → GROUP 객체 핸들로 들어 있다. 이름 없는 그룹은 *A1, *A2 …
 * 구성원의 영구 반응자(330)는 DXF·DWG 쓰기가 그룹에서 만들어 주므로 객체에는 넣지 않는다.
 */
import type { CadDocument, DictionaryObject, GroupObject } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import type { EditOp } from '../session';

export interface GroupInfo {
  name: string;
  handle: string;
  group: GroupObject;
}

function isDict(o: unknown): o is DictionaryObject {
  const t = (o as { type?: string } | undefined)?.type;
  return t === 'DICTIONARY' || t === 'ACDBDICTIONARYWDFLT';
}

function rootDict(doc: CadDocument): DictionaryObject | null {
  const h = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
  const o = h ? doc.objects.get(h) : undefined;
  return isDict(o) ? o : null;
}

/** ACAD_GROUP 사전(없으면 null) */
export function groupDictionary(doc: CadDocument): DictionaryObject | null {
  const root = rootDict(doc);
  if (!root) return null;
  for (const [k, h] of root.entries) {
    if (k.toUpperCase() !== 'ACAD_GROUP') continue;
    const o = doc.objects.get(normalizeHandle(h));
    return isDict(o) ? o : null;
  }
  return null;
}

/** 도면의 그룹(사전 순서) */
export function listGroups(doc: CadDocument): GroupInfo[] {
  const d = groupDictionary(doc);
  const out: GroupInfo[] = [];
  if (!d) return out;
  for (const [name, h] of d.entries) {
    const g = doc.objects.get(normalizeHandle(h));
    if (g?.type === 'GROUP') out.push({ name, handle: g.handle, group: g as GroupObject });
  }
  return out;
}

/** 객체가 든 그룹 */
export function groupsContaining(doc: CadDocument, handle: string): GroupInfo[] {
  const h = normalizeHandle(handle);
  return listGroups(doc).filter((g) => g.group.entities.some((x) => normalizeHandle(x) === h));
}

/** 다음 이름 없는 그룹 이름(*A1 …) */
export function nextUnnamedName(doc: CadDocument): string {
  const used = new Set(listGroups(doc).map((g) => g.name.toUpperCase()));
  let n = 1;
  while (used.has(`*A${n}`)) n++;
  return `*A${n}`;
}

const BAD = /[<>/\\":;?*|,=`]/;

/** 그룹 이름 검사(쓸 수 없으면 까닭) */
export function groupNameProblem(doc: CadDocument, name: string, except?: string): string | null {
  const n = name.trim();
  if (!n) return '이름을 입력하십시오.';
  if (n.length > 255) return '이름이 너무 깁니다.';
  if (BAD.test(n) || /[\u0000-\u001f]/.test(n)) return '이름에 쓸 수 없는 문자가 있습니다.';
  if (listGroups(doc).some((g) => g.name.toUpperCase() === n.toUpperCase() && g.name.toUpperCase() !== except?.toUpperCase())) return `그룹 ${n}이(가) 이미 있습니다.`;
  return null;
}

/**
 * 그룹 만들기. name이 null이면 이름 없는 그룹. ACAD_GROUP 사전이 없으면 만들어 루트 사전에 넣는다.
 * 돌려주는 ops는 한 트랜잭션으로 적용한다. 루트 사전도 없으면 null.
 */
export function createGroupOps(
  doc: CadDocument,
  name: string | null,
  description: string,
  members: string[],
  newHandle: () => string,
  selectable = true,
): { ops: EditOp[]; name: string; handle: string } | null {
  const root = rootDict(doc);
  if (!root) return null;
  const ops: EditOp[] = [];
  const old = groupDictionary(doc);
  const dict: DictionaryObject = old ?? { type: 'DICTIONARY', handle: newHandle(), owner: root.handle, reactors: [root.handle], entries: new Map(), hardOwner: false, cloning: 1 };
  if (!old) {
    const entries = new Map(root.entries);
    entries.set('ACAD_GROUP', dict.handle);
    ops.push({ kind: 'object', key: root.handle, before: root, after: { ...root, entries } });
  }
  const gname = name ?? nextUnnamedName(doc);
  const gh = newHandle();
  const g: GroupObject = {
    type: 'GROUP',
    handle: gh,
    owner: dict.handle,
    reactors: [dict.handle],
    description,
    unnamed: name === null,
    selectable,
    entities: [...new Set(members)],
  };
  ops.push({ kind: 'object', key: gh, before: null, after: g });
  const entries = new Map(dict.entries);
  entries.set(gname, gh);
  ops.push({ kind: 'object', key: dict.handle, before: old, after: { ...dict, entries } });
  return { ops, name: gname, handle: gh };
}

/** 그룹 지우기(사전 항목과 GROUP 객체) */
export function deleteGroupOps(doc: CadDocument, groupHandle: string): EditOp[] {
  const h = normalizeHandle(groupHandle);
  const g = doc.objects.get(h);
  const dict = groupDictionary(doc);
  if (!g || g.type !== 'GROUP') return [];
  const ops: EditOp[] = [];
  if (dict) {
    const entries = new Map([...dict.entries].filter(([, x]) => normalizeHandle(x) !== h));
    if (entries.size !== dict.entries.size) ops.push({ kind: 'object', key: dict.handle, before: dict, after: { ...dict, entries } });
  }
  ops.push({ kind: 'object', key: h, before: g, after: null });
  return ops;
}

/** 그룹의 구성원·설명·이름·선택 가능 여부 바꾸기 */
export function updateGroupOps(doc: CadDocument, groupHandle: string, patch: { name?: string; description?: string; entities?: string[]; selectable?: boolean }): EditOp[] {
  const h = normalizeHandle(groupHandle);
  const g = doc.objects.get(h) as GroupObject | undefined;
  if (!g || g.type !== 'GROUP') return [];
  const ops: EditOp[] = [];
  const after: GroupObject = { ...g, entities: [...(patch.entities ?? g.entities)] };
  if (patch.description !== undefined) after.description = patch.description;
  if (patch.selectable !== undefined) after.selectable = patch.selectable;
  if (JSON.stringify(after) !== JSON.stringify(g)) ops.push({ kind: 'object', key: h, before: g, after });
  if (patch.name !== undefined) {
    const dict = groupDictionary(doc);
    if (dict) {
      const entries = new Map<string, string>();
      for (const [k, x] of dict.entries) entries.set(normalizeHandle(x) === h ? patch.name : k, x);
      ops.push({ kind: 'object', key: dict.handle, before: dict, after: { ...dict, entries } });
      if (after.unnamed && !patch.name.startsWith('*')) {
        after.unnamed = false;
        if (!ops.some((o) => o.kind === 'object' && o.key === h)) ops.push({ kind: 'object', key: h, before: g, after });
      }
    }
  }
  return ops;
}

/**
 * PICKSTYLE 1: 고른 객체가 선택 가능한 그룹에 들어 있으면 그 그룹의 (살아 있는) 구성원을 모두 더한다.
 * 고른 순서를 지키고 더한 것은 뒤에 붙인다.
 */
export function expandByGroups(doc: CadDocument, handles: readonly string[]): string[] {
  if (!handles.length) return [...handles];
  const groups = listGroups(doc).filter((g) => g.group.selectable);
  if (!groups.length) return [...handles];
  const out = [...handles];
  const have = new Set(handles.map((h) => normalizeHandle(h)));
  const byMember = new Map<string, GroupInfo[]>();
  for (const g of groups)
    for (const m of g.group.entities) {
      const k = normalizeHandle(m);
      const list = byMember.get(k);
      if (list) list.push(g);
      else byMember.set(k, [g]);
    }
  for (const h of handles) {
    for (const g of byMember.get(normalizeHandle(h)) ?? []) {
      for (const m of g.group.entities) {
        const k = normalizeHandle(m);
        if (have.has(k) || !doc.entityIndex.has(k)) continue;
        have.add(k);
        out.push(k);
      }
    }
  }
  return out;
}
