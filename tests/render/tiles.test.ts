/** 타일 뷰포트 배치(나누기·합치기)와 뷰포트 표 연산 */
import { describe, expect, it } from 'vitest';
import type { VPortRecord } from '../../src/core/model';
import { applyOps, inverseTransaction } from '../../src/edit/session';
import { type R, joinRects, splitRect } from '../../src/app/tilelayout';
import { newDoc } from '../hatch/helpers';

const FULL: R = { x0: 0, y0: 0, x1: 1, y1: 1 };
const area = (rs: R[]) => rs.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);

describe('타일 나누기', () => {
  it('모든 구성이 겹치지 않고 원래 사각형을 채운다', () => {
    for (const k of ['SI', '2H', '2V', '3H', '3V', '3A', '3B', '3L', '3R', '4'] as const) {
      const parts = splitRect(FULL, k);
      expect(area(parts)).toBeCloseTo(1, 12);
      for (const p of parts) {
        expect(p.x0).toBeGreaterThanOrEqual(0);
        expect(p.y1).toBeLessThanOrEqual(1);
        expect(p.x1).toBeGreaterThan(p.x0);
      }
    }
  });

  it('셋: 오른쪽은 큰 칸이 오른쪽이고 첫째(활성)', () => {
    const [a] = splitRect(FULL, '3R');
    expect(a).toEqual({ x0: 0.5, y0: 0, x1: 1, y1: 1 });
  });

  it('활성 타일만 나누면 그 안에서 나눈다', () => {
    const half: R = { x0: 0, y0: 0, x1: 0.5, y1: 1 };
    const parts = splitRect(half, '4');
    expect(area(parts)).toBeCloseTo(0.5, 12);
    expect(Math.max(...parts.map((p) => p.x1))).toBe(0.5);
  });
});

describe('타일 합치기', () => {
  it('한 변을 온전히 맞댄 두 칸만 합친다', () => {
    expect(joinRects({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, { x0: 0, y0: 0.5, x1: 0.5, y1: 1 })).toEqual({ x0: 0, y0: 0, x1: 0.5, y1: 1 });
    expect(joinRects({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, { x0: 0.5, y0: 0, x1: 1, y1: 1 })).toBeNull();
  });
});

describe('뷰포트 표 연산', () => {
  it('표 전체를 바꾸고 명령 취소로 되돌린다', () => {
    const doc = newDoc();
    const rec = (ll: number, name = '*Active'): VPortRecord => ({
      name,
      handle: `V${ll}`,
      flags: 0,
      lowerLeft: { x: ll, y: 0 },
      upperRight: { x: ll + 0.5, y: 1 },
      center: { x: 0, y: 0 },
      snapBase: { x: 0, y: 0 },
      snapSpacing: { x: 1, y: 1 },
      gridSpacing: { x: 1, y: 1 },
      viewDirection: { x: 0, y: 0, z: 1 },
      viewTarget: { x: 0, y: 0, z: 0 },
      height: 10,
      aspect: 1,
      lensLength: 50,
      twist: 0,
    });
    doc.vports.push(rec(0));
    const before = doc.vports.slice();
    const after = [rec(0), rec(0.5), rec(0, 'TWO')];
    const tx = { label: 'VPORTS', ops: [{ kind: 'vports' as const, before, after }] };
    applyOps(doc, tx.ops);
    expect(doc.vports.map((v) => v.name)).toEqual(['*Active', '*Active', 'TWO']);
    applyOps(doc, inverseTransaction(tx).ops);
    expect(doc.vports).toHaveLength(1);
  });
});
