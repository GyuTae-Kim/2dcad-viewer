/** 3D 범위 계산: 형식 배열·행렬·NaN·장면 전체 */
import { describe, expect, it } from 'vitest';
import { boxIsEmpty, boxSphere, emptyBox, meshBounds, positionsBox, sceneBounds, transformBox, unionBox } from '../../src/viewer3d/bounds';
import { boxMesh, syntheticScene } from '../../src/viewer3d/synth';
import type { Scene3d } from '../../src/viewer3d/types';

describe('범위', () => {
  it('xyz 배열(NaN·무한대는 건너뜀)', () => {
    const b = positionsBox(new Float32Array([1, 2, 3, -4, NaN, 6, 7, 8, -9, Infinity, 0, 0]));
    expect(b.min).toEqual([1, 2, -9]);
    expect(b.max).toEqual([7, 8, 3]);
  });

  it('빈 상자와 합치기', () => {
    const e = emptyBox();
    expect(boxIsEmpty(e)).toBe(true);
    const u = unionBox(e, { min: [0, 0, 0], max: [1, 2, 3] });
    expect(u).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
    expect(boxIsEmpty(unionBox(e, emptyBox()))).toBe(true);
  });

  it('행렬로 옮긴 그물(이동 + Z축 90° 회전)', () => {
    const m = boxMesh('a', [0, 0, 0], [2, 1, 1], [1, 1, 1, 1]);
    // 열 우선: x' = −y + 10, y' = x + 20, z' = z
    m.matrix = new Float64Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1]);
    const b = meshBounds(m);
    expect(b.min).toEqual([9, 20, 0]);
    expect(b.max).toEqual([10, 22, 1]);
    expect(transformBox(emptyBox(), m.matrix)).toEqual(emptyBox());
  });

  it('장면 전체 = 그물·선분·점의 합, 고르개로 일부만', () => {
    const s: Scene3d = {
      name: 't',
      units: 'mm',
      meshes: [boxMesh('m', [0, 0, 0], [1, 1, 1], [1, 1, 1, 1], 'g1')],
      lines: [{ id: 'l', positions: new Float32Array([-5, 0, 0, 0, 0, 9]), group: 'g2' }],
      points: [{ id: 'p', positions: new Float32Array([3, 7, -2]) }],
    };
    expect(sceneBounds(s)).toEqual({ min: [-5, 0, -2], max: [3, 7, 9] });
    expect(sceneBounds(s, (it) => it.group === 'g1')).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });

  it('합성 장면 범위와 감싸는 구', () => {
    const s = syntheticScene({ segments: 2000, sphereSeg: 16 });
    const b = sceneBounds(s);
    expect(boxIsEmpty(b)).toBe(false);
    const sp = boxSphere(b);
    for (const k of [0, 1, 2]) {
      expect(sp.center[k]! - sp.radius).toBeLessThanOrEqual(b.min[k]!);
      expect(sp.center[k]! + sp.radius).toBeGreaterThanOrEqual(b.max[k]!);
    }
  });
});
