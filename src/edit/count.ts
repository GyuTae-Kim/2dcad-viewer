/**
 * 블록 개수(COUNT): 공간의 맨 위 블록 참조를 블록 이름(동적 블록은 정의 이름)별로 묶는다.
 * 외부 참조·익명 블록(*D·*X 등, 동적 블록 표현 *U는 제외)은 세지 않는다(AutoCAD와 같다).
 */
import type { CadDocument, Entity, InsertEntity } from '../core/model';
import { tableKey } from '../core/model';
import { blockDisplayName } from './extract';

export interface CountRow {
  name: string;
  handles: string[];
}

export function countRows(doc: CadDocument, entities: readonly Entity[]): CountRow[] {
  const map = new Map<string, CountRow>();
  for (const e of entities) {
    if (e.type !== 'INSERT') continue;
    const ins = e as InsertEntity;
    const def = doc.blocks.get(tableKey(ins.block));
    if (def && def.flags & 4) continue;
    if (/^\*/.test(ins.block) && !/^\*U/i.test(ins.block)) continue;
    const name = blockDisplayName(doc, ins);
    if (/^\*/.test(name)) continue;
    const k = tableKey(name);
    const row = map.get(k) ?? { name, handles: [] };
    row.handles.push(ins.handle);
    // 다중 삽입(MINSERT)은 배열 칸마다 하나
    for (let i = 1; i < Math.max(1, ins.rowCount) * Math.max(1, ins.columnCount); i++) row.handles.push(ins.handle);
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}
