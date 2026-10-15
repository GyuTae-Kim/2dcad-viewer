/** TINSERT: 셀 정렬·자동 맞춤·여백·블록 회전·표 회전과 축척 */
import { describe, expect, it } from 'vitest';
import { cellPlacement } from '../../src/edit/blkcmds/tinsert';

const base = {
  cell: { x0: 0, x1: 40, y0: -20, y1: 0 },
  hMargin: 1,
  vMargin: 1,
  // 블록 범위 10×5, 기준점은 왼쪽 아래
  box: [100, 200, 110, 205] as [number, number, number, number],
  base: { x: 100, y: 200 },
  autofit: true,
  scale: 1,
  rotation: 0,
  align: 5,
  table: { insert: { x: 0, y: 0, z: 0 }, angle: 0, scale: 1 },
};

describe('표 셀 블록 자리', () => {
  it('자동 맞춤 + 중간 중심: 여백 뺀 38×18 안에서 가장 큰 축척(18/5=3.6)', () => {
    const p = cellPlacement(base);
    expect(p.scale).toBeCloseTo(3.6);
    // 블록 폭 36, 높이 18 → 가운데
    expect(p.insert.x).toBeCloseTo(2);
    expect(p.insert.y).toBeCloseTo(-19);
    expect(p.rotation).toBe(0);
  });

  it('정렬 1(맨 위 왼쪽)·9(맨 아래 오른쪽), 고정 축척', () => {
    const tl = cellPlacement({ ...base, autofit: false, scale: 2, align: 1 });
    expect(tl.insert.x).toBeCloseTo(1);
    expect(tl.insert.y).toBeCloseTo(-1 - 10);
    const br = cellPlacement({ ...base, autofit: false, scale: 2, align: 9 });
    expect(br.insert.x).toBeCloseTo(39 - 20);
    expect(br.insert.y).toBeCloseTo(-19);
  });

  it('블록 90° 회전이면 회전한 범위(5×10)로 맞춘다', () => {
    const p = cellPlacement({ ...base, rotation: Math.PI / 2 });
    // 회전한 폭 5, 높이 10 → min(38/5, 18/10) = 1.8
    expect(p.scale).toBeCloseTo(1.8);
    expect(p.rotation).toBeCloseTo(Math.PI / 2);
    // 회전 뒤 범위 x ∈ [-5k, 0], y ∈ [0, 10k] → 가운데: x = 20 + 4.5, y = -10 - 9
    expect(p.insert.x).toBeCloseTo(24.5);
    expect(p.insert.y).toBeCloseTo(-19);
  });

  it('표 회전·축척을 입힌다', () => {
    const p = cellPlacement({ ...base, table: { insert: { x: 100, y: 50, z: 0 }, angle: Math.PI / 2, scale: 2 } });
    expect(p.scale).toBeCloseTo(7.2);
    expect(p.rotation).toBeCloseTo(Math.PI / 2);
    // 표 좌표 (2, -19) × 2 → (4, -38), 90° 회전 → (38, 4)
    expect(p.insert.x).toBeCloseTo(138);
    expect(p.insert.y).toBeCloseTo(54);
  });

  it('범위가 없는(점) 블록은 주어진 축척', () => {
    const p = cellPlacement({ ...base, box: [100, 200, 100, 200], scale: 1.5 });
    expect(p.scale).toBe(1.5);
  });
});
