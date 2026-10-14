/** PDF 가져오기 변환(경로·채우기·문자 → 도면 객체) */
import { describe, expect, it } from 'vitest';
import type { Entity, SplineEntity } from '../../src/core/model';
import { type PdfPageData, pdfToEntities } from '../../src/edit/pdfimport';
import { newDoc } from '../hatch/helpers';

const opt = { scale: 25.4 / 72, insert: { x: 0, y: 0 }, rotation: 0, geometry: true, fills: true, text: true, lineweights: true, pdfLayers: true, currentLayer: '0', mmPerUnit: 1 };

describe('PDF 가져오기', () => {
  it('직선·곡선·채우기·문자를 각각 바꾼다', () => {
    const page: PdfPageData = {
      originX: 0,
      originY: 0,
      width: 288,
      height: 216,
      shapes: [
        { stroke: true, fill: false, strokeRgb: 0, fillRgb: 0, width: 1, subpaths: [{ x0: 72, y0: 72, segs: [{ k: 'L', x: 144, y: 72 }], closed: false }] },
        {
          stroke: true,
          fill: false,
          strokeRgb: 0xff0000,
          fillRgb: 0,
          width: 2,
          subpaths: [
            {
              x0: 0,
              y0: 0,
              segs: [
                { k: 'C', x1: 10, y1: 20, x2: 30, y2: 20, x: 40, y: 0 },
                { k: 'C', x1: 50, y1: -20, x2: 70, y2: -20, x: 80, y: 0 },
              ],
              closed: false,
            },
          ],
        },
        { stroke: false, fill: true, strokeRgb: 0, fillRgb: 0x00ff00, width: 0, subpaths: [{ x0: 0, y0: 0, segs: [{ k: 'L', x: 10, y: 0 }, { k: 'L', x: 10, y: 10 }, { k: 'L', x: 0, y: 10 }], closed: true }] },
        { stroke: false, fill: true, strokeRgb: 0, fillRgb: 0xffffff, width: 0, subpaths: [{ x0: 0, y0: 0, segs: [{ k: 'L', x: 288, y: 0 }, { k: 'L', x: 288, y: 216 }], closed: true }] },
      ],
      texts: [{ str: 'ABC', x: 72, y: 144, height: 12, rotation: 0, rgb: 0 }],
    };
    const r = pdfToEntities(newDoc(), page, opt);
    const types = r.entities.map((e) => e.type);
    expect(types).toEqual(['LINE', 'SPLINE', 'HATCH', 'TEXT']);
    const line = r.entities[0] as Extract<Entity, { type: 'LINE' }>;
    expect(line.start.x).toBeCloseTo(25.4, 9);
    expect(line.color).toEqual({ aci: 7 });
    const sp = r.entities[1] as SplineEntity;
    expect(sp.degree).toBe(3);
    expect(sp.controlPoints).toHaveLength(7);
    expect(sp.knots).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2]);
    expect(sp.color.rgb).toBe(0xff0000);
    const t = r.entities[3] as unknown as { height: number };
    expect(t.height).toBeCloseTo(4.2333, 3);
    expect(r.layers.sort()).toEqual(['PDF_Geometry', 'PDF_Solid Fills', 'PDF_Text']);
  });
});
