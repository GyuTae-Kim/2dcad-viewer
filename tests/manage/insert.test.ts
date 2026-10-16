import { describe, expect, it } from 'vitest';
import type { AttribEntity, InsertEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { registerBlockCommands, makeAttribs } from '../../src/app/blocks';
import { belowPrevious, runInsert } from '../../src/app/blockinsert';
import { defineBlockOps } from '../../src/app/blockdefine';
import { setBrowserSysvar } from '../../src/app/sysvars';
import { makeHarness } from '../cmds2/harness';
import { line } from '../edit/make';

function attdef(tag: string, flags = 0): AttribEntity {
  return { ...entityDefaults(), type: 'ATTDEF', handle: '', insert: { x: 0, y: -5, z: 0 }, height: 2.5, text: '기본', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0, tag, prompt: `${tag} 입력`, attFlags: flags };
}

describe('INSERT(이름을 주면 대화상자 없이)와 속성', () => {
  it('블록 단위 축척(INSUNITS)과 ATTDIA 0·확인 속성의 두 번 묻기', async () => {
    const h = makeHarness((d) => d.header.set('$INSUNITS', 4));
    registerBlockCommands(h.app);
    const l = h.add(line(0, 0, 1, 0));
    const a = h.add(attdef('NO', 4));
    const r = defineBlockOps(h.app, { name: 'TAG', base: { x: 0, y: 0, z: 0 }, handles: [l.handle, a.handle], mode: 'delete', units: 1 });
    if ('error' in r) throw new Error(r.error);
    h.st.session.commit({ label: 'BLOCK', ops: r.ops });
    setBrowserSysvar('ATTDIA', 0);
    h.app.register({ name: 'T', title: 't', run: (ctx) => runInsert(h.app, ctx, 'TAG', (def, ins, sc, rot, values, hd) => makeAttribs(h.app, def, ins, sc, rot, values, hd)) });
    await h.run('T', [{ click: [10, 10] }, 'A-1', 'A-2']);
    setBrowserSysvar('ATTDIA', 1);
    const ins = h.doc.blocks.get(MODEL_SPACE)!.entities.find((e) => e.type === 'INSERT') as InsertEntity;
    expect(ins.scale.x).toBeCloseTo(25.4, 9);
    expect(ins.attribs[0]!.text).toBe('A-2');
    expect(h.prompts).toContain('NO 입력 <기본>:');
    expect(h.prompts).toContain('NO 입력 <A-1>:');
  });

  it('이전 속성 정의 아래 줄은 높이의 5/3만큼 회전 방향 아래', () => {
    const p = belowPrevious({ ...attdef('A'), insert: { x: 0, y: 0, z: 0 }, height: 3, rotation: Math.PI / 2 });
    expect(p.insert.x).toBeCloseTo(5, 9);
    expect(p.insert.y).toBeCloseTo(0, 9);
    const q = belowPrevious({ ...attdef('A'), insert: { x: 1, y: 1, z: 0 }, alignPoint: { x: 2, y: 1, z: 0 }, height: 3 });
    expect(q.insert).toMatchObject({ x: 1, y: -4 });
    expect(q.alignPoint).toMatchObject({ x: 2, y: -4 });
  });
});
