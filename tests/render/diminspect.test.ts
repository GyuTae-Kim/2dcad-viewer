/** 검사 치수(DIMINSPECT): XDATA 왕복과 프레임 그림 */
import { describe, expect, it } from 'vitest';
import type { DimensionEntity, Entity } from '../../src/core/model';
import { createLinearDimension, generateDimensionGeometry } from '../../src/edit/dim';
import { INSPECT_APP, inspectXData, readInspect, withInspect } from '../../src/edit/dim/inspect';
import { makeDoc } from '../dim/doc';

const V = (x: number, y: number) => ({ x, y, z: 0 });

function dimWith(xdata?: DimensionEntity['xdata']): { doc: ReturnType<typeof makeDoc>; d: DimensionEntity } {
  const doc = makeDoc();
  const d = createLinearDimension(doc, V(0, 0), V(100, 0), V(50, 20));
  if (xdata) d.xdata = xdata;
  return { doc, d };
}

const texts = (es: Entity[]) => es.filter((e) => e.type === 'MTEXT').map((e) => (e as { text: string }).text);

describe('검사 치수', () => {
  it('AutoCAD 순서대로 XDATA를 쓰고 다시 읽는다', () => {
    const x = inspectXData({ on: true, shape: 'round', label: 'A', rate: '100%' });
    expect(x.app).toBe(INSPECT_APP);
    expect(x.items).toEqual([
      { code: 1070, value: 396 },
      { code: 1000, value: '100%' },
      { code: 1070, value: 395 },
      { code: 1000, value: 'A' },
      { code: 1070, value: 394 },
      { code: 1070, value: 1 | 16 | 32 },
      { code: 1070, value: 393 },
      { code: 1070, value: 1 },
    ]);
    expect(readInspect({ xdata: [x] })).toEqual({ on: true, shape: 'round', label: 'A', rate: '100%' });
    const y = inspectXData({ on: false, shape: 'angular', label: null, rate: null });
    expect(y.items).toEqual([
      { code: 1070, value: 394 },
      { code: 1070, value: 2 },
      { code: 1070, value: 393 },
      { code: 1070, value: 0 },
    ]);
    expect(readInspect({ xdata: [y] })).toEqual({ on: false, shape: 'angular', label: null, rate: null });
  });

  it('다른 XDATA는 두고 검사 기록만 바꾸거나 지운다', () => {
    const other = { app: 'ACAD', items: [{ code: 1000, value: 'x' }] };
    const a = withInspect([other], { on: true, shape: 'none', label: null, rate: '50%' })!;
    expect(a.map((d) => d.app)).toEqual(['ACAD', INSPECT_APP]);
    expect(withInspect(a, null)).toEqual([other]);
    expect(withInspect([a[1]!], null)).toBeUndefined();
  });

  it('원형 프레임은 레이블·값·검사율 칸과 양 끝 반원을 그린다', () => {
    const plain = dimWith();
    const g0 = generateDimensionGeometry(plain.doc, plain.d);
    const { doc, d } = dimWith([inspectXData({ on: true, shape: 'round', label: 'A1', rate: '100%' })]);
    const g = generateDimensionGeometry(doc, d);
    const t = texts(g.entities);
    expect(t).toContain('A1');
    expect(t).toContain('100%');
    expect(t.length).toBe(texts(g0.entities).length + 2);
    expect(g.entities.filter((e) => e.type === 'ARC').length).toBe(2);
    // 프레임 위·아래 선과 칸막이 둘이 더해진다
    expect(g.entities.filter((e) => e.type === 'LINE').length).toBeGreaterThanOrEqual(g0.entities.filter((e) => e.type === 'LINE').length + 4);
  });

  it('꺼진 검사와 없음 쉐이프', () => {
    const off = dimWith([inspectXData({ on: false, shape: 'round', label: 'A1', rate: '100%' })]);
    const g0 = generateDimensionGeometry(off.doc, off.d);
    expect(texts(g0.entities)).not.toContain('A1');
    const none = dimWith([inspectXData({ on: true, shape: 'none', label: null, rate: '25%' })]);
    const g = generateDimensionGeometry(none.doc, none.d);
    expect(texts(g.entities)).toContain('25%');
    expect(g.entities.filter((e) => e.type === 'ARC').length).toBe(0);
  });
});
