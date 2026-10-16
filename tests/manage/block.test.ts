import { describe, expect, it } from 'vitest';
import type { InsertEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { registerBlockCommands } from '../../src/app/blocks';
import { defineBlockOps } from '../../src/app/blockdefine';
import { makeHarness } from '../cmds2/harness';
import { circle, line } from '../edit/make';

const model = (h: ReturnType<typeof makeHarness>) => h.doc.blocks.get(MODEL_SPACE)!.entities;

function ref(name: string): InsertEntity {
  return { ...entityDefaults(), type: 'INSERT', handle: '', block: name, insert: { x: 100, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
}

describe('-BLOCK 정의와 재정의', () => {
  it('새 블록은 고른 객체를 지우고 정의를 만든다', async () => {
    const h = makeHarness();
    registerBlockCommands(h.app);
    const l = h.add(line(0, 0, 10, 0));
    await h.run('-BLOCK', ['B1', '0,0', { sel: [l.handle] }]);
    const def = h.doc.blocks.get('B1')!;
    expect(def.entities.map((e) => e.type)).toEqual(['LINE']);
    expect(model(h).some((e) => e.handle === l.handle)).toBe(false);
    expect(h.doc.blockRecords.get('B1')?.explodable).toBe(true);
  });

  it('같은 이름은 재정의 확인 뒤 정의를 바꾸고 참조는 그대로 새 정의를 가리킨다(명령 취소 한 단계)', async () => {
    const h = makeHarness();
    registerBlockCommands(h.app);
    const l = h.add(line(0, 0, 10, 0));
    await h.run('-BLOCK', ['B1', '0,0', { sel: [l.handle] }]);
    const ins = h.add(ref('B1'));
    const c = h.add(circle(5, 5, 2));
    const before = h.doc.blocks.get('B1')!;
    // 아니오면 그대로
    await h.run('-BLOCK', ['B1', 'N']);
    expect(h.doc.blocks.get('B1')).toBe(before);
    await h.run('-BLOCK', ['B1', 'Y', '5,5', { sel: [c.handle] }]);
    const def = h.doc.blocks.get('B1')!;
    expect(def.entities.map((e) => e.type)).toEqual(['CIRCLE']);
    expect(def.basePoint).toMatchObject({ x: 5, y: 5 });
    expect(def.handle).toBe(before.handle);
    expect(def.recordHandle).toBe(before.recordHandle);
    expect(h.printed.some((t) => t.includes('재정의되었습니다'))).toBe(true);
    expect((h.doc.entityIndex.get(ins.handle) as InsertEntity).block).toBe('B1');
    expect(model(h).some((e) => e.handle === c.handle)).toBe(false);
    h.st.session.undo();
    expect(h.doc.blocks.get('B1')!.entities.map((e) => e.type)).toEqual(['LINE']);
    expect(model(h).some((e) => e.handle === c.handle)).toBe(true);
  });

  it('자기 자신을 참조하는 재정의는 거절한다', async () => {
    const h = makeHarness();
    registerBlockCommands(h.app);
    const l = h.add(line(0, 0, 10, 0));
    await h.run('-BLOCK', ['B1', '0,0', { sel: [l.handle] }]);
    const ins = h.add(ref('B1'));
    const r = defineBlockOps(h.app, { name: 'b1', base: { x: 0, y: 0, z: 0 }, handles: [ins.handle], mode: 'convert' });
    expect('error' in r && r.error).toContain('자신을 참조');
  });

  it('균일 축척·분해 허용·블록 단위·유지 모드', () => {
    const h = makeHarness();
    registerBlockCommands(h.app);
    const l = h.add(line(0, 0, 10, 0));
    const r = defineBlockOps(h.app, { name: 'K', base: { x: 1, y: 2, z: 0 }, handles: [l.handle], mode: 'retain', scaleUniformly: true, explodable: false, units: 6, description: '설명' });
    if ('error' in r) throw new Error(r.error);
    h.st.session.commit({ label: 'BLOCK', ops: r.ops });
    const rec = h.doc.blockRecords.get('K')!;
    expect(rec).toMatchObject({ scalable: false, explodable: false, insertUnits: 6 });
    expect(h.doc.blocks.get('K')!.description).toBe('설명');
    // 유지: 원본은 남고 정의의 객체는 새 핸들
    expect(model(h).some((e) => e.handle === l.handle)).toBe(true);
    expect(h.doc.blocks.get('K')!.entities[0]!.handle).not.toBe(l.handle);
    expect(r.insertHandle).toBeNull();
  });
});
