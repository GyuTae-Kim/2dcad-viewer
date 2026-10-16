/** 격자 간격·색 읽기·행렬 도구·공구 표시 그물 */
import { describe, expect, it } from 'vitest';
import { gridLines, gridSpec } from '../../src/viewer3d/grid';
import { markerMesh } from '../../src/viewer3d/marker';
import { mat4Invert, mat4Mul, niceStep, normalMatrix, placeMatrix, transformDir, transformPoint } from '../../src/viewer3d/math';
import { parseColor } from '../../src/viewer3d/theme';

describe('격자', () => {
  it('1·2·5 간격', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(23)).toBe(50);
    expect(niceStep(0.012)).toBeCloseTo(0.02, 12);
  });

  it('범위를 덮고, 바닥 높이, 원점 축', () => {
    const g = gridSpec({ min: [-30, 10, -5], max: [170, 90, 40] }, 'min');
    expect(g.step).toBe(20);
    expect(g.minorStep).toBe(5);
    expect(g.z).toBe(-5);
    expect(g.x0).toBeLessThanOrEqual(-30);
    expect(g.x1).toBeGreaterThanOrEqual(170);
    expect(g.y0).toBeLessThanOrEqual(10);
    expect(g.y1).toBeGreaterThanOrEqual(90);
    expect(g.x0 % g.step).toBeCloseTo(0, 9);
    const l = gridLines(g);
    expect(l.axisX.length).toBe(6);
    expect(l.axisY.length).toBe(6);
    // 축 선과 겹치는 격자 선은 뺀다
    for (let i = 0; i < l.major.length; i += 6) expect(l.major[i] === 0 && l.major[i + 3] === 0).toBe(false);
    expect(gridSpec({ min: [0, 0, 0], max: [1, 1, 1] }, 'zero').z).toBe(0);
    expect(gridSpec({ min: [0, 0, 0], max: [1, 1, 1] }, 7).z).toBe(7);
  });

  it('원점이 밖이면 축 선 없음, 빈 장면은 기본 격자', () => {
    const l = gridLines(gridSpec({ min: [1000, 1000, 0], max: [1100, 1050, 0] }));
    expect(l.axisX.length).toBe(0);
    expect(l.axisY.length).toBe(0);
    const e = gridSpec({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    expect(e.x1 - e.x0).toBeGreaterThan(0);
  });
});

describe('색 읽기', () => {
  it('#·rgb()·rgba()', () => {
    expect(parseColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseColor('#00000080')![3]).toBeCloseTo(128 / 255, 9);
    expect(parseColor('#212830')).toEqual([0x21 / 255, 0x28 / 255, 0x30 / 255, 1]);
    expect(parseColor('rgba(255, 0, 51, 0.5)')).toEqual([1, 0, 0.2, 0.5]);
    expect(parseColor('rgb(0 128 255 / 25%)')).toEqual([0, 128 / 255, 1, 0.25]);
    expect(parseColor('tomato')).toBeNull();
  });
});

describe('행렬', () => {
  it('역행렬·법선 행렬', () => {
    const m = mat4Mul(placeMatrix([5, -2, 3], [1, 1, 0], 2.5), new Float64Array([1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]));
    const inv = mat4Invert(m)!;
    const id = mat4Mul(m, inv);
    for (let i = 0; i < 16; i++) expect(id[i]!).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9);
    // 법선은 면 위 접선과 수직을 지킨다
    const n = normalMatrix(m);
    const t = transformDir(m, [1, -1, 0]);
    const nn = [n[0]! * 0 + n[3]! * 0 + n[6]! * 1, n[1]! * 0 + n[4]! * 0 + n[7]! * 1, n[2]! * 0 + n[5]! * 0 + n[8]! * 1];
    expect(t[0] * nn[0]! + t[1] * nn[1]! + t[2] * nn[2]!).toBeCloseTo(0, 9);
  });

  it('놓기 행렬: 원점 → pos, +Z → axis', () => {
    const m = placeMatrix([1, 2, 3], [0, 0, -2], 4);
    expect(transformPoint(m, [0, 0, 0])).toEqual([1, 2, 3]);
    const z = transformPoint(m, [0, 0, 1]);
    expect(z[2]).toBeCloseTo(-1, 12);
  });
});

describe('공구 표시', () => {
  it('세 모양, 법선은 단위 길이, 높이 5', () => {
    for (const k of ['cone', 'cylinder', 'ball'] as const) {
      const g = markerMesh(k, 12);
      expect(g.positions.length % 9).toBe(0);
      expect(g.normals.length).toBe(g.positions.length);
      for (let i = 0; i < g.normals.length; i += 3) expect(Math.hypot(g.normals[i]!, g.normals[i + 1]!, g.normals[i + 2]!)).toBeCloseTo(1, 6);
      let zmax = -Infinity, zmin = Infinity;
      for (let i = 2; i < g.positions.length; i += 3) {
        zmax = Math.max(zmax, g.positions[i]!);
        zmin = Math.min(zmin, g.positions[i]!);
      }
      expect(zmin).toBeCloseTo(0, 6);
      expect(zmax).toBeCloseTo(5, 6);
    }
  });
});

describe('NC 재생 도우미', () => {
  it('원본 번호 이하 앞쪽 개수', async () => {
    const { countIdsUpTo, idsAscending } = await import('../../src/viewer3d/playback');
    const ids = new Uint32Array([2, 2, 5, 9, 9, 9, 14]);
    expect(countIdsUpTo(ids, 7, 0)).toBe(0);
    expect(countIdsUpTo(ids, 7, 2)).toBe(2);
    expect(countIdsUpTo(ids, 7, 8)).toBe(3);
    expect(countIdsUpTo(ids, 7, 9)).toBe(6);
    expect(countIdsUpTo(ids, 7, 100)).toBe(7);
    expect(countIdsUpTo(ids, 4, 100)).toBe(4);
    expect(idsAscending(ids)).toBe(true);
    expect(idsAscending([3, 1])).toBe(false);
  });
});
