/** 블록 개수(COUNT): 이름별 묶기, 다중 삽입, 외부 참조·익명 블록 빼기, 동적 블록 정의 이름 */
import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, Entity, InsertEntity } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { entityDefaults, tableKey } from '../../src/core/model';
import { countRows } from '../../src/edit/count';

let n = 0x100;
function ins(block: string, extra: Partial<InsertEntity> = {}): InsertEntity {
  return { ...entityDefaults(), type: 'INSERT', handle: (n++).toString(16).toUpperCase(), block, insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, extrusion: { x: 0, y: 0, z: 1 }, attribs: [], rowCount: 1, columnCount: 1, rowSpacing: 0, columnSpacing: 0, ...extra } as InsertEntity;
}

function defBlock(doc: CadDocument, name: string, flags = 0): void {
  doc.blocks.set(tableKey(name), { name, flags, basePoint: { x: 0, y: 0, z: 0 }, entities: [], recordHandle: '' } as unknown as BlockDef);
}

describe('블록 개수', () => {
  it('이름별로 묶고 다중 삽입은 칸마다 센다', () => {
    const doc = createNewDocument('metric');
    for (const b of ['문', '창', 'XREF1', '*D5', '*U7']) defBlock(doc, b, b === 'XREF1' ? 4 : 0);
    doc.blockRecords.set(tableKey('*U7'), { name: '*U7', handle: '1F0', xdata: [{ app: 'AcDbDynamicBlockTrueName', items: [{ code: 1000, value: '문' }] }] } as never);
    const ents: Entity[] = [ins('문'), ins('창'), ins('문', { rowCount: 2, columnCount: 3 }), ins('XREF1'), ins('*D5'), ins('*U7')];
    const rows = countRows(doc, ents);
    expect(rows.map((r) => [r.name, r.handles.length])).toEqual([
      ['문', 8],
      ['창', 1],
    ]);
  });
});
