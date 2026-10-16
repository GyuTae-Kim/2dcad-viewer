/**
 * HATCH 내부 점 미리보기: 커서가 놓인 닫힌 영역의 경계를 미리보기로 보여 준다(밖이면 미리보기 없음).
 */
import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/model';
import { registerHatchCommands } from '../../src/app/hatchcmd';
import { lw as lw0 } from '../edit/make';
import { makeHarness, modelEntities } from '../cmds2/harness';

const square = (x: number, y: number, s: number): Entity => ({ ...lw0([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], true), handle: '' });

describe('HATCH 내부 점 미리보기', () => {
  it('영역 안을 누르면 그 영역의 미리보기, 밖이면 없음', async () => {
    const h = makeHarness();
    registerHatchCommands(h.app);
    h.add(square(0, 0, 10));
    await h.run('HATCH', [{ click: [50, 50] }, { click: [5, 5] }, '']);
    // 첫 번째(밖): 경계를 못 찾아 미리보기 없음, 두 번째(안): 미리보기가 있다
    expect(h.ghostSizes[0]).toBe(0);
    expect(h.ghostSizes[1]).toBeGreaterThan(0);
    expect(modelEntities(h.doc, 'HATCH').length).toBe(1);
  });
});
