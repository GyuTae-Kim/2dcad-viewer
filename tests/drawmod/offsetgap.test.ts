/**
 * OFFSETGAPTYPE 1·2: 폴리선을 바깥으로 간격띄울 때 꼭짓점 틈을 호·모따기로 잇는다(안쪽은 그대로 만난다).
 */
import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/model';
import { lwVertices } from '../../src/core/lwpoly';
import { offsetEntity } from '../../src/edit/geom/offset';
import { lw } from '../edit/make';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const sq = (): Entity => lw([[0, 0], [10, 0], [10, 10], [0, 10]], true);

describe('OFFSETGAPTYPE', () => {
  it('0: 연장해 만난다(정점 4개)', () => {
    const r = offsetEntity(sq(), 1, { x: 20, y: 20 });
    expect(lwVertices(r.add![0] as never).length).toBe(4);
  });

  it('1: 바깥 꼭짓점은 반지름 = 거리인 호', () => {
    const r = offsetEntity(sq(), 1, { x: 20, y: 20 }, { gapType: 1 });
    const vs = lwVertices(r.add![0] as never);
    expect(vs.length).toBe(8);
    const arcs = vs.filter((v) => Math.abs(v.bulge) > 1e-9);
    expect(arcs.length).toBe(4);
    for (const v of arcs) close(Math.abs(v.bulge), Math.tan(Math.PI / 8));
    // 안쪽으로는 틈이 없어 그대로
    const inner = offsetEntity(sq(), 1, { x: 5, y: 5 }, { gapType: 1 });
    expect(lwVertices(inner.add![0] as never).length).toBe(4);
  });

  it('2: 꼭짓점에서 거리만큼 떨어진 모따기 선', () => {
    const r = offsetEntity(sq(), 1, { x: 20, y: 20 }, { gapType: 2 });
    const vs = lwVertices(r.add![0] as never);
    expect(vs.length).toBe(8);
    expect(vs.every((v) => v.bulge === 0)).toBe(true);
    const bottom = vs.filter((v) => Math.abs(v.y + 1) < 1e-9).map((v) => v.x).sort((a, b) => a - b);
    close(bottom[0]!, 1 - Math.SQRT2);
    close(bottom[1]!, 9 + Math.SQRT2);
  });
});
