/**
 * OVERKILL 옵션: 연관 객체 유지, 폴리선 세그먼트 폭 무시, 폴리선 분할 안 함.
 */
import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/model';
import { overkill } from '../../src/edit/geom/overkill';
import { line, lw } from '../edit/make';

describe('OVERKILL 옵션', () => {
  it('연관 객체 유지: 반응자가 있는 중복은 남기고 다른 쪽을 지운다', () => {
    const a = line(0, 0, 10, 0);
    const b: Entity = { ...line(0, 0, 10, 0), reactors: ['ABC'] };
    const r = overkill([a, b], { keepAssociative: true });
    expect(r.result.remove).toEqual([a.handle]);
    // 끄면 먼저 고른 것이 남는다
    const r2 = overkill([a, b]);
    expect(r2.result.remove).toEqual([b.handle]);
    // 덮인 연관 선도 지우지 않는다
    const c: Entity = { ...line(2, 0, 5, 0), reactors: ['X'] };
    const r3 = overkill([a, c], { keepAssociative: true });
    expect(r3.result.remove ?? []).not.toContain(c.handle);
  });

  it('폴리선 분할 안 함: 폴리선을 최적화하지 않는다, 폭 무시: 폭 있는 폴리선도 최적화', () => {
    const p = lw([[0, 0], [5, 0], [10, 0]]);
    expect(overkill([p]).result.replace?.length).toBe(1);
    expect(overkill([p], { noBreakPolylines: true }).result.replace).toBeUndefined();
    const w: Entity = { ...lw([[0, 0], [5, 0], [10, 0]]), widths: [1, 2, 2, 3, 0, 0] } as Entity;
    expect(overkill([w]).result.replace).toBeUndefined();
    expect(overkill([w], { ignoreWidths: true }).result.replace?.length).toBe(1);
  });
});
