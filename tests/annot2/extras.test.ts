/** 치수 덧붙임 기록(꺾기선·끊기)과 꺾기 반지름 치수 */
import { describe, expect, it } from 'vitest';
import type { DimensionEntity, Entity, LineEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createLinearDimension, generateDimensionGeometry } from '../../src/edit/dim';
import {
  BREAK_APP,
  JOG_APP,
  breakSize,
  dimFrame,
  fromFrame,
  jogHeightFactor,
  readBreaks,
  readJogLine,
  toFrame,
  writeBreaks,
  writeJogLine,
} from '../../src/edit/dim/extras';
import { jogPoints } from '../../src/edit/dim/jogged';
import { createJoggedDimension } from '../../src/edit/annot/create';
import { makeDoc, of } from '../dim/doc';

const P = (x: number, y: number) => ({ x, y, z: 0 });

function hdim(doc = makeDoc()): DimensionEntity {
  // ISO-25: 0,0 ~ 100,0, 치수선 y = 20
  const d = createLinearDimension(doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0, style: 'ISO-25' });
  d.handle = 'D1';
  return d;
}

/** 치수선(y = 20) 위 선분들 */
const dimLine = (es: Entity[]) =>
  of(es, 'LINE').filter((l) => Math.abs(l.start.y - 20) < 1e-9 && Math.abs(l.end.y - 20) < 1e-9);

function addLine(doc: ReturnType<typeof makeDoc>, h: string, x0: number, y0: number, x1: number, y1: number): LineEntity {
  const l: LineEntity = { ...entityDefaults(), type: 'LINE', handle: h, start: P(x0, y0), end: P(x1, y1) };
  doc.entityIndex.set(h, l);
  return l;
}

describe('기록이 없으면 그대로', () => {
  it('확장 데이터가 없는 치수의 그림은 같다', () => {
    const doc = makeDoc();
    const d = hdim(doc);
    const a = generateDimensionGeometry(doc, d).entities;
    const withOther = { ...d, xdata: [{ app: 'SOMEAPP', items: [{ code: 1000, value: 'x' }] }] };
    expect(generateDimensionGeometry(doc, withOther).entities).toEqual(a);
  });
});

describe('꺾기선(DIMJOGLINE)', () => {
  it('기본 위치: 첫째 보조선과 문자 가운데의 중간, 높이 1.5 × 문자 높이, 꼭지각 40°', () => {
    const doc = makeDoc();
    const d = hdim(doc);
    const plain = dimLine(generateDimensionGeometry(doc, d).entities);
    d.xdata = writeJogLine(d, { point: null, defaultPoint: { x: 25, y: 20 } });
    const j = readJogLine(d)!;
    expect(j.on).toBe(true);
    expect(j.user).toBe(false);
    const es = generateDimensionGeometry(doc, d).entities;
    const lines = of(es, 'LINE');
    // 지그재그 세 선: 치수선 위·아래로 높이/2
    const zig = lines.filter((l) => Math.abs(l.start.y - 20) > 1e-9 || Math.abs(l.end.y - 20) > 1e-9).filter((l) => Math.min(l.start.y, l.end.y) > 5);
    expect(zig.length).toBe(3);
    const ys = zig.flatMap((l) => [l.start.y, l.end.y]);
    const h = 1.5 * 2.5;
    expect(Math.max(...ys) - 20).toBeCloseTo(h / 2, 9);
    expect(20 - Math.min(...ys)).toBeCloseTo(h / 2, 9);
    // 가운데 = (첫 보조선 0 + 문자 50) / 2 = 25
    const xs = zig.flatMap((l) => [l.start.x, l.end.x]);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(25, 9);
    // 꼭지각 40°: 첫 선은 70° 기울기
    const s0 = zig.find((l) => Math.abs(l.start.y - 20) < 1e-9)!;
    expect((Math.atan2(Math.abs(s0.end.y - s0.start.y), Math.abs(s0.end.x - s0.start.x)) * 180) / Math.PI).toBeCloseTo(70, 9);
    // 치수선이 지그재그 폭만큼 빠졌다
    const before = plain.reduce((s, l) => s + Math.abs(l.end.x - l.start.x), 0);
    const after = dimLine(es).reduce((s, l) => s + Math.abs(l.end.x - l.start.x), 0);
    expect(before - after).toBeCloseTo((4 * h) / 2 / Math.tan((70 * Math.PI) / 180), 9);
    expect(d.xdata![0]!.app).toBe(JOG_APP);
    expect(d.xdata![0]!.items.map((i) => i.value)).toEqual([387, 1, 389, { x: 25, y: 20, z: 0 }]);
  });

  it('사용자 위치는 치수를 옮겨도 같은 자리(치수 기준 좌표)', () => {
    const doc = makeDoc();
    const d = hdim(doc);
    d.xdata = writeJogLine(d, { point: { x: 70, y: 20 }, defaultPoint: { x: 25, y: 20 } });
    expect(readJogLine(d)).toMatchObject({ on: true, user: true });
    const zx = (dd: DimensionEntity) => {
      const zig = of(generateDimensionGeometry(doc, dd).entities, 'LINE').filter((l) => Math.abs(l.start.y - l.end.y) > 1e-6 && Math.min(l.start.y, l.end.y) > 5 + dd.defPoint.y - 20);
      const xs = zig.flatMap((l) => [l.start.x, l.end.x]);
      return (Math.max(...xs) + Math.min(...xs)) / 2;
    };
    expect(zx(d)).toBeCloseTo(70, 9);
    // MOVE(확장 데이터 점은 그대로): 정의점만 (+30, +5)
    const m = structuredClone(d);
    for (const k of ['defPoint', 'defPoint2', 'defPoint3', 'textMid'] as const) m[k] = { x: m[k].x + 30, y: m[k].y + 5, z: 0 };
    expect(zx(m)).toBeCloseTo(100, 9);
  });

  it('제거하면 플래그 2만 남고 꺾기가 없다', () => {
    const doc = makeDoc();
    const d = hdim(doc);
    d.xdata = writeJogLine(d, { point: { x: 70, y: 20 }, defaultPoint: { x: 25, y: 20 } });
    d.xdata = writeJogLine(d, 'remove');
    expect(readJogLine(d)).toMatchObject({ on: false, user: true });
    expect(d.xdata!.some((x) => x.app === 'OPENCAD_DIMJOG')).toBe(false);
    const d0 = hdim(doc);
    expect(generateDimensionGeometry(doc, d).entities).toEqual(generateDimensionGeometry(doc, d0).entities);
  });

  it('꺾기 높이 계수: 스타일 ACAD_DSTYLE_DIMJAG(388)', () => {
    const doc = makeDoc();
    doc.dimStyles.get('ISO-25')!.xdata = [{ app: 'ACAD_DSTYLE_DIMJAG', items: [{ code: 1070, value: 388 }, { code: 1040, value: 2 }] }];
    expect(jogHeightFactor(doc, hdim(doc))).toBe(2);
    expect(jogHeightFactor(makeDoc(), hdim())).toBe(1.5);
  });
});

describe('끊기(DIMBREAK)', () => {
  it('끊기 크기: 스타일 ACAD_DSTYLE_DIMBREAK × DIMSCALE, 없으면 미터법 3.75·영국식 0.125', () => {
    const doc = makeDoc();
    expect(breakSize(doc, hdim(doc), 1)).toBe(3.75);
    doc.header.set('$MEASUREMENT', 0);
    expect(breakSize(doc, hdim(doc), 2)).toBe(0.25);
    doc.dimStyles.get('ISO-25')!.xdata = [{ app: 'ACAD_DSTYLE_DIMBREAK', items: [{ code: 1070, value: 391 }, { code: 1040, value: 5 }] }];
    expect(breakSize(doc, hdim(doc), 1)).toBe(5);
  });

  it('객체 끊기: 치수선·치수보조선이 끊는 객체와 만나는 곳에 끊기 크기만큼 틈', () => {
    const doc = makeDoc();
    const d = hdim(doc);
    // 세로선 x = 40 (치수선을 끊는다), 가로선 y = 10 (두 보조선을 끊는다)
    addLine(doc, 'A1', 40, -10, 40, 40);
    addLine(doc, 'A2', -10, 10, 120, 10);
    d.xdata = writeBreaks(d, [
      { kind: 'object', handle: 'A1' },
      { kind: 'object', handle: 'A2' },
    ]);
    expect(readBreaks(d)).toEqual([
      { kind: 'object', handle: 'A1' },
      { kind: 'object', handle: 'A2' },
    ]);
    const es = generateDimensionGeometry(doc, d).entities;
    const dl = dimLine(es).sort((a, b) => Math.min(a.start.x, a.end.x) - Math.min(b.start.x, b.end.x));
    // 틈: 38.125 ~ 41.875
    const gapLo = Math.max(...dl.filter((l) => Math.max(l.start.x, l.end.x) <= 40).map((l) => Math.max(l.start.x, l.end.x)));
    const gapHi = Math.min(...dl.filter((l) => Math.min(l.start.x, l.end.x) >= 40).map((l) => Math.min(l.start.x, l.end.x)));
    expect(gapLo).toBeCloseTo(40 - 3.75 / 2, 9);
    expect(gapHi).toBeCloseTo(40 + 3.75 / 2, 9);
    // 보조선 x = 0: y = 10 둘레가 빠진다
    const ext1 = of(es, 'LINE').filter((l) => Math.abs(l.start.x) < 1e-9 && Math.abs(l.end.x) < 1e-9);
    expect(ext1.length).toBe(2);
    const ends = ext1.flatMap((l) => [l.start.y, l.end.y]).sort((a, b) => a - b);
    expect(ends[1]).toBeCloseTo(10 - 3.75 / 2, 9);
    expect(ends[2]).toBeCloseTo(10 + 3.75 / 2, 9);
    // 끊는 객체를 옮기면 다시 그릴 때 틈이 따라간다
    (doc.entityIndex.get('A1') as LineEntity).start.x = 60;
    (doc.entityIndex.get('A1') as LineEntity).end.x = 60;
    const es2 = generateDimensionGeometry(doc, d).entities;
    const dl2 = dimLine(es2);
    expect(dl2.some((l) => Math.abs(Math.max(l.start.x, l.end.x) - (60 - 1.875)) < 1e-9)).toBe(true);
  });

  it('수동 끊기는 치수 기준 좌표로 두어 치수와 함께 움직인다', () => {
    const doc = makeDoc();
    const d = hdim(doc);
    const f = dimFrame(d);
    expect(fromFrame(f, toFrame(f, { x: 12, y: 34 }))).toMatchObject({ x: 12, y: 34 });
    d.xdata = writeBreaks(d, [{ kind: 'manual', a: toFrame(f, { x: 60, y: 22 }), b: toFrame(f, { x: 70, y: 18 }) }]);
    const gap = (dd: DimensionEntity, oy: number) => {
      const dl = of(generateDimensionGeometry(doc, dd).entities, 'LINE').filter((l) => Math.abs(l.start.y - 20 - oy) < 1e-9 && Math.abs(l.end.y - 20 - oy) < 1e-9);
      const xs = dl.flatMap((l) => [l.start.x, l.end.x]).sort((a, b) => a - b);
      return xs;
    };
    const xs = gap(d, 0);
    expect(xs.some((x) => Math.abs(x - 60) < 1e-9)).toBe(true);
    expect(xs.some((x) => Math.abs(x - 70) < 1e-9)).toBe(true);
    const m = structuredClone(d);
    for (const k of ['defPoint', 'defPoint2', 'defPoint3', 'textMid'] as const) m[k] = { x: m[k].x + 5, y: m[k].y + 7, z: 0 };
    const xs2 = gap(m, 7);
    expect(xs2.some((x) => Math.abs(x - 65) < 1e-9)).toBe(true);
    expect(xs2.some((x) => Math.abs(x - 75) < 1e-9)).toBe(true);
  });

  it('끊기 기록을 모두 지우면 확장 데이터 앱도 사라진다', () => {
    const d = hdim();
    d.xdata = writeBreaks(d, [{ kind: 'object', handle: 'A1' }]);
    expect(d.xdata!.map((x) => x.app)).toEqual([BREAK_APP]);
    expect(writeBreaks(d, [])).toBeUndefined();
  });
});

describe('꺾기 반지름 치수(DIMJOGGED)', () => {
  it('꺾기선 가운데로 맞추고 DIMJOGANG으로 가로지른다', () => {
    const j = jogPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 10 }, { x: 70, y: 99 }, Math.PI / 4);
    // 가운데: 반지름 선(y=0)과 재지정 중심을 지나는 평행선(y=10)의 가운데, x는 찍은 점
    expect(j.mid).toMatchObject({ x: 70, y: 5 });
    expect(j.j1.y).toBeCloseTo(0, 12);
    expect(j.j2.y).toBeCloseTo(10, 12);
    expect(Math.abs(Math.atan2(j.j2.y - j.j1.y, j.j2.x - j.j1.x))).toBeCloseTo((135 * Math.PI) / 180, 9);
  });

  it('만들기: 측정값 = 반지름, 치수선 세 토막(화살촉 쪽·가로지름·재지정 중심 쪽)', () => {
    const doc = makeDoc();
    const d = createJoggedDimension(doc, P(0, 0), 100, P(70, 0), P(20, -15), P(45, 0), { style: 'ISO-25' });
    expect(d.subtype).toBe('LARGE_RADIAL_DIMENSION');
    expect(d.measurement).toBeCloseTo(100, 12);
    expect(d.defPoint4).toMatchObject({ x: 100, y: 0 });
    expect(d.defPoint2).toMatchObject({ x: 20, y: -15 });
    expect(d.defPoint3.y).toBeCloseTo(-7.5, 12);
    const g = generateDimensionGeometry(doc, d);
    expect(g.warnings).not.toContain('dimension.jogged_radius_simplified');
    const lines = of(g.entities, 'LINE');
    // 재지정 중심에서 시작하는 선, 가로지르는 선(45°), 화살촉 쪽 선
    expect(lines.some((l) => [l.start, l.end].some((q) => Math.abs(q.x - 20) < 1e-9 && Math.abs(q.y + 15) < 1e-9))).toBe(true);
    const slanted = lines.filter((l) => Math.abs(l.start.y - l.end.y) > 1e-9 && Math.abs(l.start.x - l.end.x) > 1e-9);
    expect(slanted.length).toBe(1);
    expect(Math.abs(slanted[0]!.end.y - slanted[0]!.start.y)).toBeCloseTo(15, 9);
    expect(of(g.entities, 'MTEXT')[0]!.text).toContain('R100');
  });

  it('재지정 중심·꺾기 점이 0인 기록은 예전처럼 반지름 치수', () => {
    const doc = makeDoc();
    const d = createJoggedDimension(doc, P(0, 0), 100, P(70, 0), P(20, -15), P(45, 0), { style: 'ISO-25' });
    d.defPoint2 = P(0, 0);
    d.defPoint3 = P(0, 0);
    expect(generateDimensionGeometry(doc, d).warnings).toContain('dimension.jogged_radius_simplified');
  });
});
