/**
 * ARRAYRECT·ARRAYPOLAR·ARRAY 명령행 흐름: 기본 배열을 바로 만들고 옵션·그립으로 고친다, 연관 = 아니오면 사본으로.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Entity, InsertEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { registerArrayCommands } from '../../src/app/arraycmd';
import { setArrayAssociativity } from '../../src/app/assocarray';
import { readArray } from '../../src/edit/assocarray/read';
import type { PolarParams, RectParams } from '../../src/edit/assocarray/types';
import { lw as lw0 } from '../edit/make';
import { makeHarness, modelEntities } from '../cmds2/harness';
import { perCommandGroups } from './groups';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
// 시험 도구의 핸들은 문서 핸들과 겹칠 수 있다 → 세션이 새로 매기게
const square = (x: number, y: number): Entity => ({ ...lw0([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]], true), handle: '' });

function harness() {
  const h = perCommandGroups(makeHarness());
  registerArrayCommands(h.app);
  return h;
}

const arrays = (h: ReturnType<typeof harness>) => h.doc.blocks.get(MODEL_SPACE)!.entities.filter((e) => e.type === 'INSERT') as InsertEntity[];

afterEach(() => setArrayAssociativity(true));

describe('ARRAYRECT 명령행', () => {
  it('객체 선택 → 기본 4×3 연관 배열 → 개수(COU)·간격두기(S)', async () => {
    setArrayAssociativity(true);
    const h = harness();
    const s = h.add(square(0, 0));
    await h.run('ARRAYRECT', [{ sel: [s.handle] }, 'COU', '3', '2', 'S', '2', '3', '']);
    expect(h.prompts).toContain('그립을 선택하여 배열을 편집하거나 [연관(AS)/기준점(B)/개수(COU)/간격두기(S)/열(COL)/행(R)/레벨(L)/종료(X)] <종료>:');
    const [a] = arrays(h);
    const p = readArray(h.doc, a)!.state.params as RectParams;
    expect(p.columns).toBe(3);
    expect(p.rows).toBe(2);
    close(p.columnSpacing, 2);
    close(p.rowSpacing, 3);
    expect(modelEntities(h.doc, 'LWPOLYLINE').length).toBe(0);
    expect(h.printed.some((t) => t.includes('항목 6개의 연관 배열(직사각형)'))).toBe(true);
  });

  it('그립(둘째 열 기준점)을 눌러 열 간격을 고친다', async () => {
    setArrayAssociativity(true);
    const h = harness();
    const s = h.add(square(0, 0));
    // 기본 간격 1.5 → 둘째 열 기준점(중심) (2, 0.5)
    await h.run('ARRAYRECT', [{ sel: [s.handle] }, { click: [2, 0.5] }, { click: [3, 0.5] }, '']);
    const p = readArray(h.doc, arrays(h)[0]!)!.state.params as RectParams;
    close(p.columnSpacing, 2.5);
  });

  it('연관(AS) = 아니오: 항목마다 사본, 명령 취소 한 번이면 원래대로', async () => {
    setArrayAssociativity(true);
    const h = harness();
    const s = h.add(square(0, 0));
    await h.run('ARRAYRECT', [{ sel: [s.handle] }, 'AS', 'N', 'COU', '2', '2', '']);
    expect(arrays(h).length).toBe(0);
    expect(modelEntities(h.doc, 'LWPOLYLINE').length).toBe(4);
    // 원본은 그 자리에 남는다
    expect(h.doc.entityIndex.has(s.handle)).toBe(true);
    // 다음 시험을 위해 블록 정의도 남지 않는다
    h.st.session.undo();
    expect(modelEntities(h.doc, 'LWPOLYLINE').length).toBe(1);
    expect(arrays(h).length).toBe(0);
  });
});

describe('ARRAYPOLAR·ARRAY 명령행', () => {
  it('중심점 → 기본 6개 → 항목(I)·채울 각도(F)·항목 회전(ROT)', async () => {
    setArrayAssociativity(true);
    const h = harness();
    const s = h.add(square(9.5, -0.5));
    await h.run('ARRAYPOLAR', [{ sel: [s.handle] }, '0,0', 'I', '4', 'F', '180', 'ROT', 'N', '']);
    const p = readArray(h.doc, arrays(h)[0]!)!.state.params as PolarParams;
    expect(p.items).toBe(4);
    close(p.fillAngle, Math.PI);
    expect(p.rotateItems).toBe(false);
    close(p.radius, 10);
  });

  it('ARRAY: 유형 원형(PO)·연관 아니오 → 사본 6개', async () => {
    setArrayAssociativity(false);
    const h = harness();
    const s = h.add(square(9.5, -0.5));
    await h.run('ARRAY', [{ sel: [s.handle] }, 'PO', '0,0', '']);
    expect(arrays(h).length).toBe(0);
    const sq = modelEntities(h.doc, 'LWPOLYLINE');
    expect(sq.length).toBe(6);
  });
});
