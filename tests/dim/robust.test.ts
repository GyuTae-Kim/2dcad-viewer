/** 여러 치수 변수 조합·퇴화 입력에서 예외 없이 유한한 좌표를 내는지 */
import { describe, expect, it } from 'vitest';
import type { DimensionEntity, Entity, Vec3 } from '../../src/core/model';
import {
  createAlignedDimension,
  createAngular2LineDimension,
  createAngularDimension,
  createArcLengthDimension,
  createDiameterDimension,
  createLinearDimension,
  createOrdinateDimension,
  createRadialDimension,
  generateDimensionGeometry,
  moveDimensionText,
} from '../../src/edit/dim';
import { ISO25, makeDoc } from './doc';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function finite(e: Entity): boolean {
  const nums: number[] = [];
  const walk = (o: unknown) => {
    if (typeof o === 'number') nums.push(o);
    else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v);
  };
  walk(e);
  return nums.every(Number.isFinite);
}

describe('치수 생성 견고성', () => {
  it('무작위 변수 조합 600가지', () => {
    const r = rng(7);
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
    const v = (): Vec3 => ({ x: (r() - 0.5) * 200, y: (r() - 0.5) * 200, z: 0 });
    const doc = makeDoc();
    for (let i = 0; i < 600; i++) {
      const vars: Record<string, number | string> = {
        ...ISO25,
        DIMTAD: pick([0, 1, 2, 3, 4]),
        DIMJUST: pick([0, 1, 2, 3, 4]),
        DIMTIH: pick([0, 1]),
        DIMTOH: pick([0, 1]),
        DIMTIX: pick([0, 1]),
        DIMSOXD: pick([0, 1]),
        DIMATFIT: pick([0, 1, 2, 3]),
        DIMTOFL: pick([0, 1]),
        DIMTMOVE: pick([0, 1, 2]),
        DIMSE1: pick([0, 0, 1]),
        DIMSD2: pick([0, 0, 1]),
        DIMTSZ: pick([0, 0, 0, 1]),
        DIMBLK: pick(['', '_ArchTick', '_Dot', '_Oblique', '_None', '_Open', '_Integral', 'NOSUCHBLOCK']),
        DIMCEN: pick([0, 2.5, -2.5]),
        DIMTOL: pick([0, 1]),
        DIMTP: pick([0, 0.1]),
        DIMTM: pick([0, 0.2]),
        DIMLIM: pick([0, 0, 1]),
        DIMALT: pick([0, 1]),
        DIMLUNIT: pick([1, 2, 3, 4, 5, 6]),
        DIMAUNIT: pick([0, 1, 2, 3]),
        DIMTVP: pick([0, 0, 0.5]),
        DIMFXLON: pick([0, 1]),
        DIMSCALE: pick([1, 0, 10]),
        DIMTXT: pick([2.5, 0.18, 10]),
      };
      doc.dimStyles.set('R', { name: 'R', handle: 'FF', flags: 0, vars });
      const o = { style: 'R', text: pick(['', '', '<> TYP', ' ', 'X\\PY']) };
      const c = v();
      const kind = i % 9;
      let d: DimensionEntity;
      switch (kind) {
        case 0:
          d = createLinearDimension(doc, v(), v(), v(), o);
          break;
        case 1:
          d = createAlignedDimension(doc, v(), v(), v(), o);
          break;
        case 2:
          d = createAngularDimension(doc, c, v(), v(), v(), o);
          break;
        case 3:
          d = createAngular2LineDimension(doc, v(), v(), v(), v(), v(), o);
          break;
        case 4:
          d = createRadialDimension(doc, c, r() * 50 + 0.1, r() * 7, o);
          break;
        case 5:
          d = createDiameterDimension(doc, c, r() * 50 + 0.1, v(), o);
          break;
        case 6:
          d = createOrdinateDimension(doc, v(), v(), o);
          break;
        case 7:
          d = createArcLengthDimension(doc, c, r() * 50 + 1, r() * 6, r() * 6, v(), o);
          break;
        default:
          d = createLinearDimension(doc, c, { ...c }, c, o);
      }
      if (r() < 0.3) d = moveDimensionText(doc, d, v());
      const g = generateDimensionGeometry(doc, d);
      expect(Number.isFinite(g.measurement), `측정값 ${i}`).toBe(true);
      expect(Number.isFinite(g.textMid.x) && Number.isFinite(g.textMid.y)).toBe(true);
      for (const e of g.entities) expect(finite(e), `${i} ${e.type}`).toBe(true);
    }
  });

  it('퇴화 입력: 같은 점, 평행한 두 선, 반지름 0', () => {
    const doc = makeDoc();
    const z = { x: 1, y: 1, z: 0 };
    const g1 = generateDimensionGeometry(doc, createAlignedDimension(doc, z, z, z));
    expect(g1.measurement).toBe(0);
    const par = createAngular2LineDimension(doc, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 5, z: 0 });
    expect(generateDimensionGeometry(doc, par).warnings).toContain('dimension.angular_parallel');
    const g3 = generateDimensionGeometry(doc, createRadialDimension(doc, z, 0, 0));
    expect(g3.measurement).toBe(0);
  });
});
