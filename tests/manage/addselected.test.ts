import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { addSelectedPlan, registerAddSelected, runAddSelected } from '../../src/app/addselected';
import { makeHarness } from '../cmds2/harness';
import { circle, line } from '../edit/make';

describe('ADDSELECTED', () => {
  it('종류 → 작성 명령과 종류별 현재 값', () => {
    const h = makeHarness((d) => d.textStyles.set('ROMANS', { name: 'RomanS', handle: 'AA', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'romans.shx', bigFont: '' } as never));
    const has = () => true;
    expect(addSelectedPlan(h.st, line(0, 0, 1, 1), has)).toMatchObject({ command: 'LINE' });
    expect(addSelectedPlan(h.st, { ...line(0, 0, 1, 1), type: 'LWPOLYLINE' } as unknown as Entity, has)).toMatchObject({ command: 'PLINE' });
    expect(addSelectedPlan(h.st, { ...line(0, 0, 1, 1), type: 'TEXT', style: 'romans' } as unknown as Entity, has)).toMatchObject({ command: 'TEXT', header: { $TEXTSTYLE: 'RomanS' } });
    expect(addSelectedPlan(h.st, { ...line(0, 0, 1, 1), type: 'DIMENSION', dimType: 4, dimStyle: 'X' } as unknown as Entity, has)).toMatchObject({ command: 'DIMRADIUS' });
    expect(addSelectedPlan(h.st, { ...line(0, 0, 1, 1), type: 'MPOLYGON' } as unknown as Entity, has)).toEqual({ error: '이 객체 유형은 ADDSELECTED에서 지원하지 않습니다.' });
    expect(addSelectedPlan(h.st, line(0, 0, 1, 1), () => false)).toHaveProperty('error');
  });

  it('새 객체는 고른 객체의 도면층·색으로 만들어지고 현재 특성은 그대로(명령 취소 한 단계)', async () => {
    const h = makeHarness((d) => d.layers.set('WALL', { ...d.layers.get('0')!, name: 'WALL', handle: 'F1' }));
    registerAddSelected(h.app);
    const src = h.add({ ...circle(0, 0, 5), layer: 'WALL', color: { aci: 3 }, lineweight: 50 } as Entity);
    // 가짜 CIRCLE 명령: 현재 특성(0 도면층)으로 원 하나
    h.app.register({
      name: 'CIRCLE',
      title: '원',
      run: () => {
        const c = circle(10, 10, 2);
        c.owner = h.doc.blocks.get(MODEL_SPACE)!.recordHandle;
        h.st.session.commit({ label: 'CIRCLE', ops: [{ kind: 'add', block: MODEL_SPACE, entity: c }] });
      },
    });
    const app = h.app as unknown as { run: (n: string, a?: string) => Promise<void>; findCommand: (n: string) => unknown };
    app.run = (n) => h.run(n, []);
    app.findCommand = (n) => h.app.commands.get(n.toUpperCase());
    h.app.register({ name: 'AS', title: 't', run: (ctx) => runAddSelected(h.app, ctx, src.handle) });
    const before = h.doc.blocks.get(MODEL_SPACE)!.entities.length;
    await h.run('AS', []);
    const ents = h.doc.blocks.get(MODEL_SPACE)!.entities;
    expect(ents.length).toBe(before + 1);
    const made = ents.at(-1)!;
    expect(made).toMatchObject({ layer: 'WALL', color: { aci: 3 }, lineweight: 50 });
    expect(h.doc.header.get('$CLAYER')).toBe('0');
    // 고리는 명령이 끝나면 꺼진다
    const c2 = circle(1, 1, 1);
    h.add(c2);
    expect(h.doc.entityIndex.get(c2.handle)!.layer).toBe('0');
  });
});
