import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, DictionaryObject, Entity, InsertEntity, MLeaderStyleObject, MLineEntity, MLineStyleObject } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { DocState } from '../../src/app/docstate';
import { EditSession } from '../../src/edit/session';
import { importDependencies } from '../../src/app/modify';
import { listMLineStyles } from '../../src/edit/mline/style';
import { mleaderStyles, namedDictionary } from '../../src/edit/layertools/clone';
import { circle, line } from '../edit/make';

function state(doc: CadDocument): DocState {
  const st = new DocState(1, doc, 'dst.dxf', 0, 0);
  st.session = new EditSession(doc, () => {});
  return st;
}

let serial = 0x9000;
const nh = () => (serial++).toString(16).toUpperCase();

function addBlock(doc: CadDocument, name: string, ents: Entity[]): BlockDef {
  const rec = nh();
  for (const e of ents) e.owner = rec;
  const def: BlockDef = { name, handle: nh(), recordHandle: rec, basePoint: { x: 0, y: 0, z: 0 }, flags: name.startsWith('*') ? 1 : 0, entities: ents, endHandle: nh() };
  doc.blocks.set(name.toUpperCase(), def);
  doc.blockRecords.set(name.toUpperCase(), { name, handle: rec, flags: def.flags & 1, insertUnits: 0, explodable: true, scalable: true });
  for (const e of ents) doc.entityIndex.set(e.handle, e);
  return def;
}

function ref(name: string): InsertEntity {
  return { ...entityDefaults(), type: 'INSERT', handle: nh(), block: name, insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
}

describe('다른 도면에 붙여넣기: 의존 정의', () => {
  it('대상 도면에 같은 이름의 익명 블록이 있으면 새 번호로 옮기고 참조를 다시 잇는다', () => {
    const src = createNewDocument('metric');
    const dst = createNewDocument('metric');
    addBlock(src, '*U1', [line(0, 0, 10, 0)]);
    addBlock(dst, '*U1', [circle(0, 0, 5)]);
    const st = state(dst);
    const list: Entity[] = [ref('*U1')];
    const ops = importDependencies(st, src, list);
    st.session.commit({ label: 'PASTECLIP', ops });
    const pasted = list[0] as InsertEntity;
    expect(pasted.block).not.toBe('*U1');
    expect(pasted.block).toMatch(/^\*U\d+$/);
    expect(dst.blocks.get(pasted.block.toUpperCase())!.entities.map((e) => e.type)).toEqual(['LINE']);
    // 대상 도면의 원래 *U1은 그대로
    expect(dst.blocks.get('*U1')!.entities.map((e) => e.type)).toEqual(['CIRCLE']);
  });

  it('치수의 *D 블록과 이름 있는 블록(대상에 있으면 대상 것), 도면층', () => {
    const src = createNewDocument('metric');
    const dst = createNewDocument('metric');
    addBlock(src, '*D1', [line(0, 0, 1, 1)]);
    addBlock(dst, '*D1', [circle(0, 0, 1)]);
    addBlock(src, 'DOOR', [line(0, 0, 2, 0)]);
    addBlock(dst, 'DOOR', [circle(0, 0, 2)]);
    src.layers.set('WALL', { ...src.layers.get('0')!, name: 'WALL', handle: nh() });
    const dim = { ...entityDefaults(), type: 'DIMENSION', handle: nh(), layer: 'WALL', block: '*D1', dimStyle: 'Standard' } as unknown as Entity;
    const list: Entity[] = [dim, ref('DOOR')];
    const st = state(dst);
    st.session.commit({ label: 'PASTECLIP', ops: importDependencies(st, src, list) });
    const d = list[0] as unknown as { block: string; layer: string };
    expect(d.block).not.toBe('*D1');
    expect(dst.blocks.get(d.block.toUpperCase())!.entities[0]!.type).toBe('LINE');
    expect(dst.layers.has('WALL')).toBe(true);
    expect((list[1] as InsertEntity).block).toBe('DOOR');
    expect(dst.blocks.get('DOOR')!.entities[0]!.type).toBe('CIRCLE');
  });

  it('다중 지시선 스타일·여러 줄 스타일도 따라온다', () => {
    const src = createNewDocument('metric');
    const dst = createNewDocument('metric');
    // 원본에 새 다중 지시선 스타일
    const mlDict = namedDictionary(src, 'ACAD_MLEADERSTYLE')!;
    const std = mleaderStyles(src)[0]!.obj;
    const mine: MLeaderStyleObject = { ...structuredClone(std), handle: nh(), name: 'ARROWS', raw: undefined };
    src.objects.set(mine.handle, mine);
    mlDict.entries.set('ARROWS', mine.handle);
    const ml = { ...entityDefaults(), type: 'MULTILEADER', handle: nh(), styleHandle: mine.handle, context: { leaders: [] } } as unknown as Entity;
    // 원본에 새 여러 줄 스타일
    const msStd = listMLineStyles(src)[0]!.style;
    const wall: MLineStyleObject = { ...structuredClone(msStd), handle: nh(), name: 'WALL' };
    src.objects.set(wall.handle, wall);
    const mDictH = [...(src.objects.get(src.rootDictionary!) as DictionaryObject).entries].find(([k]) => k === 'ACAD_MLINESTYLE')![1];
    (src.objects.get(mDictH) as DictionaryObject).entries.set('WALL', wall.handle);
    const mlineE = { ...entityDefaults(), type: 'MLINE', handle: nh(), styleName: 'WALL', styleHandle: wall.handle, scale: 1, justification: 0, flags: 1, startPoint: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, vertices: [], elementCount: 2 } as unknown as Entity;
    const list: Entity[] = [ml, mlineE];
    const st = state(dst);
    st.session.commit({ label: 'PASTECLIP', ops: importDependencies(st, src, list) });
    const got = mleaderStyles(dst).find((s) => s.name === 'ARROWS');
    expect(got).toBeTruthy();
    expect((list[0] as unknown as { styleHandle: string }).styleHandle).toBe(got!.obj.handle);
    const w = listMLineStyles(dst).find((s) => s.name === 'WALL');
    expect(w).toBeTruthy();
    expect((list[1] as MLineEntity).styleHandle).toBe(w!.style.handle);
    expect((list[1] as MLineEntity).styleName).toBe('WALL');
    // 명령 취소 한 번이면 모두 없어진다
    st.session.undo();
    expect(mleaderStyles(dst).some((s) => s.name === 'ARROWS')).toBe(false);
    expect(listMLineStyles(dst).some((s) => s.name === 'WALL')).toBe(false);
  });

  it('같은 도면이면 아무것도 하지 않는다', () => {
    const doc = createNewDocument('metric');
    const st = state(doc);
    const list: Entity[] = [line(0, 0, 1, 0)];
    expect(importDependencies(st, doc, list)).toEqual([]);
    void MODEL_SPACE;
  });
});
