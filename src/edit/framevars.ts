/** IMAGEFRAME·WIPEOUTFRAME 바꾸기(변수 객체가 없으면 만들어 이름 있는 객체 사전에 넣는다) */
import type { CadDocument, GenericObject } from '../core/model';
import { FRAME_DICT, FRAME_TYPE, type FrameKind, frameVarObject, frameVarTags, rootDictionary, withFrameValue } from '../core/framevars';
import type { EditOp } from './session';

export function frameSettingOps(doc: CadDocument, kind: FrameKind, value: number, newHandle: () => string): EditOp[] | null {
  const cur = frameVarObject(doc, kind);
  if (cur) {
    const after: GenericObject = { ...cur, raw: withFrameValue(cur.raw, kind, value) };
    // 원본 본문을 그대로 되쓰면 바꾼 값이 빠지므로 버린다
    delete after.dwgRaw;
    return [{ kind: 'object', key: cur.handle, before: cur, after }];
  }
  const root = rootDictionary(doc);
  if (!root) return null;
  const h = newHandle();
  const o: GenericObject = { type: FRAME_TYPE[kind], handle: h, owner: root.handle, reactors: [root.handle], raw: frameVarTags(kind, value) };
  const entries = new Map(root.entries);
  entries.set(FRAME_DICT[kind], h);
  return [
    { kind: 'object', key: h, before: null, after: o },
    { kind: 'object', key: root.handle, before: root, after: { ...root, entries } },
  ];
}
