/**
 * 여러 줄 스타일 편집 작업(EditOp): 새로 만들기·바꾸기·이름 바꾸기·삭제. 문서는 바꾸지 않는다.
 */
import type { CadDocument, DictionaryObject, MLineStyleObject } from '../../core/model';
import type { EditOp } from '../session';
import { mlineStyleDictionary, sortElements } from './style';

type NewHandle = () => string;

function cloneDict(d: DictionaryObject): DictionaryObject {
  return { ...d, entries: new Map(d.entries) };
}

function ensureDict(doc: CadDocument, nh: NewHandle, ops: EditOp[]): DictionaryObject | null {
  const d = mlineStyleDictionary(doc);
  if (d) return d;
  const rootH = doc.rootDictionary;
  const root = rootH ? doc.objects.get(rootH) : undefined;
  if (!root || (root.type !== 'DICTIONARY' && root.type !== 'ACDBDICTIONARYWDFLT')) return null;
  const nd: DictionaryObject = { type: 'DICTIONARY', handle: nh(), owner: root.handle, reactors: [root.handle], entries: new Map(), hardOwner: false, cloning: 1 };
  const nr = cloneDict(root as DictionaryObject);
  nr.entries.set('ACAD_MLINESTYLE', nd.handle);
  ops.push({ kind: 'object', key: nd.handle, before: null, after: nd }, { kind: 'object', key: root.handle, before: root, after: nr });
  return nd;
}

/** 새 스타일(요소는 간격 큰 순서로 정렬) */
export function addMLineStyleOps(doc: CadDocument, nh: NewHandle, s: MLineStyleObject): { ops: EditOp[]; style: MLineStyleObject } {
  const ops: EditOp[] = [];
  const dict = ensureDict(doc, nh, ops);
  const style: MLineStyleObject = { ...s, handle: nh(), owner: dict?.handle, reactors: dict ? [dict.handle] : undefined, elements: sortElements(s.elements) };
  ops.push({ kind: 'object', key: style.handle, before: null, after: style });
  if (dict) {
    const made = ops.find((o) => o.kind === 'object' && o.key === dict.handle && o.before === null);
    if (made && made.kind === 'object') (made.after as DictionaryObject).entries.set(style.name, style.handle);
    else {
      const nd = cloneDict(dict);
      nd.entries.set(style.name, style.handle);
      ops.push({ kind: 'object', key: dict.handle, before: dict, after: nd });
    }
  }
  return { ops, style };
}

/** 스타일 값 바꾸기(이름이 바뀌면 사전 항목도) */
export function updateMLineStyleOps(doc: CadDocument, before: MLineStyleObject, after: MLineStyleObject, dictName: string): EditOp[] {
  const ops: EditOp[] = [];
  const a: MLineStyleObject = { ...after, handle: before.handle, owner: before.owner, reactors: before.reactors, xdict: before.xdict, elements: sortElements(after.elements) };
  delete a.dwgRaw;
  ops.push({ kind: 'object', key: before.handle, before, after: a });
  if (after.name !== dictName) {
    const dict = mlineStyleDictionary(doc);
    if (dict && [...dict.entries.values()].includes(before.handle)) {
      const nd = cloneDict(dict);
      nd.entries = new Map([...dict.entries].map(([k, h]) => (h === before.handle ? [after.name, h] : [k, h]) as [string, string]));
      ops.push({ kind: 'object', key: dict.handle, before: dict, after: nd });
    }
  }
  return ops;
}

export function deleteMLineStyleOps(doc: CadDocument, style: MLineStyleObject): EditOp[] {
  const ops: EditOp[] = [{ kind: 'object', key: style.handle, before: style, after: null }];
  const dict = mlineStyleDictionary(doc);
  if (dict && [...dict.entries.values()].includes(style.handle)) {
    const nd = cloneDict(dict);
    for (const [k, h] of dict.entries) if (h === style.handle) nd.entries.delete(k);
    ops.push({ kind: 'object', key: dict.handle, before: dict, after: nd });
  }
  return ops;
}
