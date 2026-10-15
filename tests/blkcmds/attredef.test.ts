/** ATTREDEF: 새 객체로 다시 정의하고 속성 값은 태그로 지키며, 새 태그는 기본값, 없어진 태그는 지운다 */
import { describe, expect, it } from 'vitest';
import type { AttribEntity, InsertEntity } from '../../src/core/model';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import { attRedefOps } from '../../src/edit/blkcmds/attredef';
import { addBlock, attdef, circle, insert, line, put, setup } from '../util2/helpers';

function attrib(h: string, owner: string, tag: string, value: string, x = 0, y = 0): AttribEntity {
  return { ...attdef(h, tag, value, x, y), type: 'ATTRIB', owner, prompt: undefined };
}

describe('ATTREDEF', () => {
  it('값 유지·새 태그 기본값·없어진 태그 삭제·고른 객체는 정의로 옮겨 도면에서 지운다', () => {
    const t = setup();
    addBlock(t.doc, t.h, 'DOOR', [line(t.h(), 0, 0, 1, 0), attdef(t.h(), 'NO', '0', 0, 0), attdef(t.h(), 'OLD', 'o', 0, 1)]);
    const ins = insert('A1', 'DOOR', 50, 50, { attribs: [attrib('B1', 'A1', 'NO', 'D-17', 50, 50), attrib('B2', 'A1', 'OLD', 'gone', 50, 51)] });
    // 새 정의 객체: 원, NO(위치 바뀜), NEW
    const c = circle('N1', 0, 0, 5);
    const d1 = attdef('N2', 'NO', '?', 2, 3);
    const d2 = attdef('N3', 'NEW', '기본', 2, 6);
    put(t.doc, ins, c, d1, d2);
    const r = attRedefOps(t.doc, 'door', MODEL_SPACE, ['N1', 'N2', 'N3'], { x: 0, y: 0, z: 0 }, t.h);
    expect(r.entities).toBe(3);
    expect(r.references).toBe(1);
    t.s.commit({ label: 'ATTREDEF', ops: r.ops });
    const def = t.doc.blocks.get('DOOR')!;
    expect(def.entities.map((e) => e.type)).toEqual(['CIRCLE', 'ATTDEF', 'ATTDEF']);
    expect(def.entities.every((e) => e.owner === def.recordHandle)).toBe(true);
    expect(def.flags & 2).toBe(2);
    // 고른 객체는 모형 공간에서 빠진다
    const ms = t.doc.blocks.get(MODEL_SPACE)!;
    expect(ms.entities.map((e) => e.handle)).toEqual(['A1']);
    const after = t.doc.entityIndex.get('A1') as InsertEntity;
    expect(after.attribs.map((a) => [a.tag, a.text])).toEqual([
      ['NO', 'D-17'],
      ['NEW', '기본'],
    ]);
    // 같은 태그는 핸들 유지, 위치는 새 정의대로
    expect(after.attribs[0]!.handle).toBe('B1');
    expect(after.attribs[0]!.insert.x).toBeCloseTo(52);
    expect(after.attribs[0]!.insert.y).toBeCloseTo(53);
    expect(t.doc.entityIndex.has('B2')).toBe(false);
    // 명령 취소 한 번이면 모두 되돌아간다
    t.s.undo();
    expect(t.doc.blocks.get(tableKey('DOOR'))!.entities.map((e) => e.type)).toEqual(['LINE', 'ATTDEF', 'ATTDEF']);
    expect((t.doc.entityIndex.get('A1') as InsertEntity).attribs.map((a) => a.text)).toEqual(['D-17', 'gone']);
    expect(ms.entities.map((e) => e.handle)).toEqual(['A1', 'N1', 'N2', 'N3']);
  });

  it('자기 참조·외부 참조·없는 블록은 오류', () => {
    const t = setup();
    addBlock(t.doc, t.h, 'B', [line(t.h(), 0, 0, 1, 0)]);
    put(t.doc, insert('A1', 'B', 0, 0));
    expect(() => attRedefOps(t.doc, 'B', MODEL_SPACE, ['A1'], { x: 0, y: 0, z: 0 }, t.h)).toThrow(/자기 자신/);
    expect(() => attRedefOps(t.doc, 'NOPE', MODEL_SPACE, ['A1'], { x: 0, y: 0, z: 0 }, t.h)).toThrow();
    t.doc.blocks.get('B')!.flags |= 4;
    expect(() => attRedefOps(t.doc, 'B', MODEL_SPACE, [], { x: 0, y: 0, z: 0 }, t.h)).toThrow(/외부 참조/);
  });
});
