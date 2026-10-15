/**
 * ATTREDEF(UI 없음): 고른 객체로 블록을 다시 정의하고, 그 블록의 모든 참조의 속성을 새 정의에 맞춘다.
 * - 두 정의에 다 있는 태그의 값은 지킨다. 새 정의에만 있는 태그는 기본값으로 만든다. 새 정의에 없는 태그는 지운다.
 * - 고른 객체는 정의로 옮기고 도면에서 지운다(BLOCK과 같다). 블록 이름·레코드 핸들·설명은 그대로 둔다.
 */
import type { BlockDef, CadDocument, Entity, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity } from '../session';
import { blockReaches, syncAllOps } from '../util/blockutil';

export interface AttRedefResult {
  ops: EditOp[];
  /** 새 정의의 객체 수 */
  entities: number;
  /** 맞춘 참조 수 */
  references: number;
  /** 잠긴 도면층이라 맞추지 못한 참조 수 */
  locked: number;
}

/**
 * name 블록을 space 공간의 handles 객체로 다시 정의한다. 고른 객체가 그 블록(또는 그 블록을 담은 블록)의 참조면
 * 자기 참조가 되므로 오류를 던진다.
 */
export function attRedefOps(doc: CadDocument, name: string, space: string, handles: readonly string[], base: Vec3, newHandle: () => string): AttRedefResult {
  const key = tableKey(name);
  const old = doc.blocks.get(key);
  if (!old) throw new Error(`블록 "${name}"이(가) 없습니다.`);
  if (old.flags & 4) throw new Error(`"${old.name}"은(는) 외부 참조라 다시 정의할 수 없습니다.`);
  const blk = doc.blocks.get(space);
  if (!blk) throw new Error('공간이 없습니다.');
  const order = new Map(blk.entities.map((e, i) => [e.handle, i]));
  const chosen = handles.filter((h) => order.has(h)).sort((a, b) => order.get(a)! - order.get(b)!);
  for (const h of chosen) {
    const e = doc.entityIndex.get(h);
    if (e?.type === 'INSERT' && blockReaches(doc, e.block, key)) throw new Error(`블록 "${old.name}"은(는) 자기 자신을 참조할 수 없습니다.`);
  }
  const ents: Entity[] = [];
  const removes: EditOp[] = [];
  for (const h of chosen) {
    const e = doc.entityIndex.get(h)!;
    const c = cloneEntity(e);
    c.owner = old.recordHandle;
    delete c.dwgRaw;
    ents.push(c);
    removes.push({ kind: 'remove', block: space, entity: e, index: order.get(h)! });
  }
  const def: BlockDef = {
    ...old,
    basePoint: { ...base },
    flags: ents.some((e) => e.type === 'ATTDEF') ? old.flags | 2 : old.flags & ~2,
    entities: ents,
  };
  const ops: EditOp[] = [...removes.reverse(), { kind: 'blockDef', key, before: old, after: def }];
  const sync = syncAllOps(doc, old.name, newHandle, def);
  // 지우는 객체 중에 그 블록의 참조가 있으면(고른 객체가 참조였다면) 맞추지 않는다
  const gone = new Set(chosen);
  ops.push(...sync.ops.filter((op) => op.kind !== 'modify' || !gone.has(op.before.handle)));
  return { ops, entities: ents.length, references: sync.count, locked: sync.locked };
}
