/** 치수 생성기 단위 테스트(예제 도면 없이): 새로 만든 치수의 기하·특성·문자 */
import { describe, expect, it } from 'vitest';
import type { DimensionEntity, Vec3 } from '../../src/core/model';
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
  measureText,
  moveDimensionText,
} from '../../src/edit/dim';
import { ISO25, makeDoc, of } from './doc';

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
const close = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-9) => {
  expect(Math.hypot(a.x - b.x, a.y - b.y), `(${a.x}, ${a.y}) ≈ (${b.x}, ${b.y})`).toBeLessThan(tol);
};
const ARIAL = { name: 'Standard', handle: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 0, font: 'arial.ttf', bigFont: '', fontFamily: 'Arial' };
/** 문자 상자 높이(Arial "100": 0 아래 -25, 위 1472 / 대문자 1466) */
const H100 = (1497 / 1466) * 2.5;

function gen(doc: ReturnType<typeof makeDoc>, d: DimensionEntity) {
  return generateDimensionGeometry(doc, d);
}

describe('선형 치수', () => {
  it('수평 치수: 보조선·치수선·화살촉·문자(ISO-25)', () => {
    const doc = makeDoc();
    const d = createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20));
    expect(d.dimType).toBe(32);
    expect(d.rotation).toBe(0);
    expect(d.dimStyle).toBe('ISO-25');
    expect(d.block).toBe('');
    close(d.defPoint, v(100, 20));
    expect(d.measurement).toBeCloseTo(100, 12);
    const g = gen(doc, d);
    const lines = of(g.entities, 'LINE');
    expect(lines).toHaveLength(3);
    close(lines[0]!.start, v(0, 0.625));
    close(lines[0]!.end, v(0, 21.25));
    close(lines[1]!.start, v(100, 0.625));
    close(lines[1]!.end, v(100, 21.25));
    // 닫고 채운 화살촉 길이만큼 잘린 치수선
    close(lines[2]!.start, v(2.5, 20));
    close(lines[2]!.end, v(97.5, 20));
    const solids = of(g.entities, 'SOLID');
    expect(solids).toHaveLength(2);
    close(solids[0]!.points[2], v(0, 20));
    close(solids[0]!.points[0], v(2.5, 20 + 2.5 / 6));
    close(solids[1]!.points[2], v(100, 20));
    const [mt] = of(g.entities, 'MTEXT');
    expect(mt!.text).toBe('100');
    expect(mt!.height).toBe(2.5);
    expect(mt!.attachment).toBe(5);
    // DIMTAD=1: 문자 상자 아래가 치수선 + DIMGAP
    close(mt!.insert, v(50, 20 + 0.625 + H100 / 2), 1e-6);
    close(g.textMid, mt!.insert);
    const pts = of(g.entities, 'POINT');
    expect(pts.map((p) => p.layer)).toEqual(['Defpoints', 'Defpoints', 'Defpoints']);
    close(pts[2]!.position, v(100, 20));
    // 블록 안 객체는 ByBlock 색, 치수의 도면층
    expect(lines.every((l) => l.color.aci === 0 && l.layer === '0' && l.transparency === -2)).toBe(true);
    expect(g.entities.every((e) => e.handle === '')).toBe(true);
  });

  it('수평·수직 자동 선택과 회전 지정', () => {
    const doc = makeDoc();
    expect(createLinearDimension(doc, v(0, 0), v(30, 40), v(-20, 20)).rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(createLinearDimension(doc, v(0, 0), v(30, 40), v(10, 60)).rotation).toBe(0);
    const d = createLinearDimension(doc, v(0, 0), v(30, 40), v(10, 60), { rotation: Math.PI / 6 });
    expect(d.measurement).toBeCloseTo(30 * Math.cos(Math.PI / 6) + 40 * Math.sin(Math.PI / 6), 10);
    const vert = createLinearDimension(doc, v(0, 0), v(0, 50), v(-20, 25));
    const [mt] = of(gen(doc, vert).entities, 'MTEXT');
    // 세로 치수선의 정렬 문자: 90°, 위쪽(= -X)에 놓인다
    expect(mt!.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(mt!.insert.x).toBeLessThan(-20);
  });

  it('정렬 치수와 DIMTAD=0·DIMTIH=1: 수평 문자 상자 둘레에서 치수선을 끊는다', () => {
    const doc = makeDoc({ T: { ...ISO25, DIMTAD: 0, DIMTIH: 1 } });
    const d = createAlignedDimension(doc, v(0, 0), v(30, 40), v(-16, 12), { style: 'T' });
    expect(d.dimType & 7).toBe(1);
    expect(d.measurement).toBeCloseTo(50, 12);
    const g = gen(doc, d);
    const lines = of(g.entities, 'LINE');
    expect(lines).toHaveLength(4);
    const [mt] = of(g.entities, 'MTEXT');
    expect(mt!.text).toBe('\\A1;50');
    expect(mt!.rotation).toBe(0);
    const box = measureText('\\A1;50', 2.5, ARIAL);
    // 끊긴 끝은 DIMGAP만큼 넓힌 상자 테두리 위
    for (const l of lines.slice(2)) {
      const dx = Math.abs(l.end.x - mt!.insert.x);
      const dy = Math.abs(l.end.y - mt!.insert.y);
      const onX = Math.abs(dx - (box.w / 2 + 0.625)) < 1e-6 && dy <= box.h / 2 + 0.625 + 1e-6;
      const onY = Math.abs(dy - (box.h / 2 + 0.625)) < 1e-6 && dx <= box.w / 2 + 0.625 + 1e-6;
      expect(onX || onY).toBe(true);
    }
  });

  it('좁은 치수: 화살촉 바깥, 더 좁으면 문자도 둘째 보조선 바깥', () => {
    const doc = makeDoc();
    const g = gen(doc, createLinearDimension(doc, v(0, 0), v(5, 0), v(2, 10)));
    const solids = of(g.entities, 'SOLID');
    // 바깥 화살촉은 안쪽을 가리킨다: 몸통이 보조선 바깥
    expect(solids[0]!.points[0].x).toBeCloseTo(-2.5, 9);
    expect(solids[1]!.points[0].x).toBeCloseTo(7.5, 9);
    const [mt] = of(g.entities, 'MTEXT');
    expect(mt!.insert.x).toBeCloseTo(2.5, 9);
    const g2 = gen(doc, createLinearDimension(doc, v(0, 0), v(1, 0), v(2, 10)));
    const [mt2] = of(g2.entities, 'MTEXT');
    const w = measureText('1', 2.5, ARIAL).w;
    expect(mt2!.insert.x).toBeCloseTo(1 + 2 * 2.5 + 0.625 + w / 2, 9);
  });

  it('DIMTIX·DIMSOXD: 문자는 안, 화살촉은 숨김', () => {
    const doc = makeDoc({ T: { ...ISO25, DIMTIX: 1, DIMSOXD: 1 } });
    const g = gen(doc, createLinearDimension(doc, v(0, 0), v(3, 0), v(2, 10), { style: 'T' }));
    expect(of(g.entities, 'SOLID')).toHaveLength(0);
    expect(of(g.entities, 'MTEXT')[0]!.insert.x).toBeCloseTo(1.5, 9);
  });

  it('DIMSE1·DIMSE2·DIMSD1: 보조선과 치수선 반쪽 숨기기', () => {
    const doc = makeDoc({ T: { ...ISO25, DIMSE1: 1, DIMSE2: 1, DIMSD1: 1 } });
    const g = gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { style: 'T' }));
    const lines = of(g.entities, 'LINE');
    expect(lines).toHaveLength(1);
    expect(Math.min(lines[0]!.start.x, lines[0]!.end.x)).toBeCloseTo(50, 9);
    expect(of(g.entities, 'SOLID')).toHaveLength(1);
  });

  it('건축 눈금 화살촉: 블록 참조, DIMDLE 연장, 없는 블록 내용 제공', () => {
    const doc = makeDoc({ T: { ...ISO25, DIMBLK: '_ArchTick', DIMDLE: 2 } });
    const g = gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { style: 'T' }));
    const ins = of(g.entities, 'INSERT');
    expect(ins.map((i) => i.block)).toEqual(['_ArchTick', '_ArchTick']);
    expect(ins[0]!.rotation).toBeCloseTo(Math.PI, 12);
    expect(ins[1]!.rotation).toBe(0);
    expect(ins[0]!.scale.x).toBe(2.5);
    const dl = of(g.entities, 'LINE')[2]!;
    close(dl.start, v(-2, 20));
    close(dl.end, v(102, 20));
    expect(g.arrowBlocks.map((b) => b.name)).toEqual(['_ArchTick']);
    expect(g.arrowBlocks[0]!.entities[0]!.type).toBe('LWPOLYLINE');
    // 도면에 이미 있으면 내용을 다시 주지 않는다
    doc.blocks.set('_ARCHTICK', { name: '_ArchTick', handle: 'A0', recordHandle: 'A1', basePoint: v(0, 0), flags: 0, entities: [] });
    expect(gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { style: 'T' })).arrowBlocks).toEqual([]);
  });

  it('DIMSAH와 상자 화살촉: 첫째·둘째 다른 블록, 치수선은 화살 크기만큼 잘림', () => {
    const doc = makeDoc({ T: { ...ISO25, DIMSAH: 1, DIMBLK1: '_BoxBlank', DIMBLK2: '_Dot' } });
    const g = gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { style: 'T' }));
    expect(of(g.entities, 'INSERT').map((i) => i.block)).toEqual(['_BoxBlank', '_Dot']);
    const dl = of(g.entities, 'LINE')[2]!;
    close(dl.start, v(2.5, 20));
    close(dl.end, v(97.5, 20));
  });

  it('색·선종류·선가중치: DIMCLRD/E/T, DIMLTYPE·DIMLTEX1/2, DIMLWD/E', () => {
    const doc = makeDoc({ T: { ...ISO25, DIMCLRD: 1, DIMCLRE: 3, DIMCLRT: 5, DIMLWD: 30, DIMLWE: 13, DIMLTYPE: 'DASHED', DIMLTEX1: 'HIDDEN', DIMLTEX2: 'ByBlock' } });
    doc.linetypes.set('DASHED', { name: 'Dashed', handle: 'L1', flags: 0, description: '', patternLength: 1, elements: [] });
    const g = gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { style: 'T', layer: 'DIM' }));
    const [e1, e2, dl] = of(g.entities, 'LINE');
    expect([e1!.color.aci, e1!.linetype, e1!.lineweight]).toEqual([3, 'HIDDEN', 13]);
    expect([e2!.color.aci, e2!.linetype]).toEqual([3, 'ByBlock']);
    expect([dl!.color.aci, dl!.linetype, dl!.lineweight, dl!.layer]).toEqual([1, 'Dashed', 30, 'DIM']);
    expect(of(g.entities, 'SOLID')[0]!.color.aci).toBe(1);
    expect(of(g.entities, 'MTEXT')[0]!.color.aci).toBe(5);
  });

  it('문자 배경(DIMTFILL)', () => {
    const doc = makeDoc({ T: { ...ISO25, DIMTFILL: 2, DIMTFILLCLR: 97 } });
    const [mt] = of(gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { style: 'T' })).entities, 'MTEXT');
    expect(mt!.backgroundFlags).toBe(1);
    expect(mt!.backgroundColor).toEqual({ aci: 97 });
    expect(mt!.backgroundScale).toBe(1.25);
  });

  it('문자 숨김(" ")과 재지정("<> mm")', () => {
    const doc = makeDoc();
    expect(of(gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { text: ' ' })).entities, 'MTEXT')).toHaveLength(0);
    const [mt] = of(gen(doc, createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20), { text: 'L=<> mm' })).entities, 'MTEXT');
    expect(mt!.text).toBe('L=100 mm');
  });

  it('문자 옮기기(DIMTMOVE 0): 치수선이 문자를 따라가고 비트 128이 선다', () => {
    const doc = makeDoc();
    const d = createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20));
    const m = moveDimensionText(doc, d, v(30, 35));
    expect(m.dimType & 128).toBe(128);
    close(m.defPoint, v(100, 35));
    close(m.textMid, v(30, 35));
    const g = gen(doc, m);
    close(g.textMid, v(30, 35));
    const [mt] = of(g.entities, 'MTEXT');
    close(mt!.insert, v(30, 35 + 0.625 + H100 / 2), 1e-6);
    // 원래 치수는 그대로
    expect(d.dimType & 128).toBe(0);
  });

  it('정의점을 옮긴 치수를 다시 그리면 같은 규칙으로 새 블록 내용', () => {
    const doc = makeDoc();
    const d = createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20));
    const moved = structuredClone(d);
    for (const k of ['defPoint', 'defPoint2', 'defPoint3'] as const) moved[k] = v(d[k].x + 10, d[k].y + 5);
    const a = gen(doc, d);
    const b = gen(doc, moved);
    expect(b.entities).toHaveLength(a.entities.length);
    close(b.textMid, v(a.textMid.x + 10, a.textMid.y + 5), 1e-9);
  });

  it('OCS: 돌출 방향 (0,0,-1)이면 블록 내용은 X가 뒤집힌 OCS 좌표', () => {
    const doc = makeDoc();
    const d = createLinearDimension(doc, v(0, 0), v(100, 0), v(50, 20));
    d.extrusion = v(0, 0, -1);
    // WCS 정의점 → OCS(-x, y)
    const g = gen(doc, d);
    const pts = of(g.entities, 'POINT');
    close(pts[1]!.position, v(-100, 0));
    close(pts[2]!.position, v(-100, 20));
  });
});

describe('각도 치수', () => {
  it('세 점 각도: 측정값·호·화살촉(현 길이로 자름)', () => {
    const doc = makeDoc();
    const d = createAngularDimension(doc, v(0, 0), v(50, 0), v(0, 50), v(30, 30));
    expect(d.dimType).toBe(37);
    expect(d.measurement).toBeCloseTo(Math.PI / 2, 12);
    const g = gen(doc, d);
    const [arc] = of(g.entities, 'ARC');
    const R = Math.hypot(30, 30);
    expect(arc!.radius).toBeCloseTo(R, 12);
    const da = 2 * Math.asin(2.5 / (2 * R));
    expect(arc!.startAngle).toBeCloseTo(da, 12);
    expect(arc!.endAngle).toBeCloseTo(Math.PI / 2 - da, 12);
    const [mt] = of(g.entities, 'MTEXT');
    expect(mt!.text).toBe('90\\U+00B0');
    // 이등분선 위, 접선 방향 문자, 호 바깥쪽으로 DIMGAP + 높이/2
    const a = Math.atan2(mt!.insert.y, mt!.insert.x);
    expect(a).toBeCloseTo(Math.PI / 4, 9);
    const box = measureText('90\\U+00B0', 2.5, ARIAL);
    expect(Math.hypot(mt!.insert.x, mt!.insert.y)).toBeCloseTo(R + 0.625 + box.h / 2, 9);
    expect(mt!.rotation).toBeCloseTo(-Math.PI / 4 + 2 * Math.PI, 9);
    // 변 위 점이 호 안쪽이면 보조선은 점에서 호 쪽으로
    const ext = of(g.entities, 'LINE');
    expect(ext).toHaveLength(2);
    close(ext[0]!.start, v(50 - 0.625, 0));
    close(ext[0]!.end, v(R - 1.25, 0));
    expect(of(g.entities, 'POINT').map((p) => [p.position.x, p.position.y])).toEqual([[0, 0], [50, 0], [0, 50], [30, 30]]);
  });

  it('두 선 각도: 호 위 점이 든 사분면', () => {
    const doc = makeDoc();
    const d = createAngular2LineDimension(doc, v(0, 0), v(50, 0), v(0, 0), v(-30, 40), v(10, 20));
    expect(d.dimType & 7).toBe(2);
    expect(d.measurement).toBeCloseTo(Math.atan2(40, -30), 12);
    const d2 = createAngular2LineDimension(doc, v(0, 0), v(50, 0), v(0, 0), v(-30, 40), v(-20, -5));
    expect(d2.measurement).toBeCloseTo(Math.atan2(40, -30), 12);
    const d3 = createAngular2LineDimension(doc, v(0, 0), v(50, 0), v(0, 0), v(-30, 40), v(-20, 5));
    expect(d3.measurement).toBeCloseTo(Math.PI - Math.atan2(40, -30), 12);
    // 치수 호가 선분 밖이면 보조선
    const d4 = createAngular2LineDimension(doc, v(10, 0), v(20, 0), v(0, 10), v(0, 20), v(30, 30));
    const g = gen(doc, d4);
    expect(of(g.entities, 'LINE')).toHaveLength(2);
    expect(d4.measurement).toBeCloseTo(Math.PI / 2, 12);
  });

  it('호 길이 치수: 측정값, 90° 미만은 나란한 보조선, 이상은 방사 보조선', () => {
    const doc = makeDoc();
    const d = createArcLengthDimension(doc, v(0, 0), 20, 0, Math.PI / 3, v(20, 20));
    expect(d.subtype).toBe('ARC_DIMENSION');
    expect(d.measurement).toBeCloseTo((20 * Math.PI) / 3, 12);
    const g = gen(doc, d);
    const [e1, e2] = of(g.entities, 'LINE');
    const b = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) };
    for (const e of [e1!, e2!]) {
      const dx = e.end.x - e.start.x;
      const dy = e.end.y - e.start.y;
      expect(Math.abs(dx * b.y - dy * b.x)).toBeLessThan(1e-9);
    }
    expect(of(g.entities, 'MTEXT')[0]!.text.startsWith('\\U+2229')).toBe(true);
    const big = gen(doc, createArcLengthDimension(doc, v(0, 0), 20, 0, Math.PI, v(0, 30)));
    const [r1] = of(big.entities, 'LINE');
    close(r1!.start, v(20.625, 0));
    close(r1!.end, v(31.25, 0));
  });
});

describe('반지름·지름 치수', () => {
  it('반지름: 문자는 원 밖, 화살촉은 안쪽을 가리킴, DIMTOFL이면 중심에서 선', () => {
    const doc = makeDoc();
    const d = createRadialDimension(doc, v(0, 0), 20, Math.PI / 4);
    expect(d.dimType).toBe(36);
    expect(d.measurement).toBeCloseTo(20, 12);
    const g = gen(doc, d);
    const [mt] = of(g.entities, 'MTEXT');
    expect(mt!.text).toBe('R20');
    const u = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const box = measureText('R20', 2.5, ARIAL);
    const along = 20 + 2 * 2.5 + 0.625 + box.w / 2;
    close(mt!.insert, { x: u.x * along - u.y * (0.625 + box.h / 2), y: u.y * along + u.x * (0.625 + box.h / 2) }, 1e-9);
    const [leader, tofl] = of(g.entities, 'LINE');
    close(leader!.end, { x: u.x * 22.5, y: u.y * 22.5 });
    close(leader!.start, { x: u.x * (along + box.w / 2 + 0.625), y: u.y * (along + box.w / 2 + 0.625) });
    close(tofl!.start, v(0, 0));
    const [s] = of(g.entities, 'SOLID');
    close(s!.points[2], { x: u.x * 20, y: u.y * 20 });
  });

  it('반지름 DIMTOFL=0: 중심 표식(DIMCEN), 음수면 중심선까지', () => {
    const doc = makeDoc({ A: { ...ISO25, DIMTOFL: 0 }, B: { ...ISO25, DIMTOFL: 0, DIMCEN: -2.5 } });
    const a = of(gen(doc, createRadialDimension(doc, v(0, 0), 20, 1, { style: 'A' })).entities, 'LINE');
    expect(a).toHaveLength(3);
    close(a[1]!.start, v(-2.5, 0));
    close(a[1]!.end, v(2.5, 0));
    const b = of(gen(doc, createRadialDimension(doc, v(0, 0), 20, 1, { style: 'B' })).entities, 'LINE');
    expect(b).toHaveLength(7);
    close(b[3]!.start, v(5, 0));
    close(b[3]!.end, v(22.5, 0));
  });

  it('지름: 측정값·기호, 정의점 10과 15', () => {
    const doc = makeDoc();
    const d = createDiameterDimension(doc, v(5, 5), 20, v(5, 40));
    expect(d.dimType).toBe(35);
    close(d.defPoint4, v(5, 25));
    close(d.defPoint, v(5, -15));
    expect(d.measurement).toBeCloseTo(40, 12);
    const g = gen(doc, d);
    expect(of(g.entities, 'MTEXT')[0]!.text).toBe('\\U+220540');
    expect(of(g.entities, 'POINT').map((p) => p.position.y)).toEqual([25, -15]);
  });

  it('지름 문자 옮기기: 원 안이면 화살촉은 바깥을 가리키고 선은 문자 밑을 지난다', () => {
    const doc = makeDoc({ U: { ...ISO25, DIMUPT: 1 } });
    const d = createDiameterDimension(doc, v(0, 0), 20, v(20, 0), { style: 'U' });
    const m = moveDimensionText(doc, d, v(0, 0));
    const g = gen(doc, m);
    const [ln] = of(g.entities, 'LINE');
    const box = measureText('\\U+220540', 2.5, ARIAL);
    expect(ln!.start.x).toBeCloseTo(-(box.w / 2 + 0.625), 9);
    expect(ln!.end.x).toBeCloseTo(17.5, 9);
    const [s] = of(g.entities, 'SOLID');
    close(s!.points[2], v(20, 0));
    expect(of(g.entities, 'MTEXT')[0]!.insert.y).toBeCloseTo(0.625 + box.h / 2, 9);
  });
});

describe('세로좌표 치수', () => {
  it('X 좌표: 세로 지시선, 꺾임, 문자 끝까지 선', () => {
    const doc = makeDoc();
    const d = createOrdinateDimension(doc, v(10, 5), v(15, 40));
    expect(d.dimType).toBe(6 | 32 | 64);
    expect(d.measurement).toBeCloseTo(10, 12);
    const g = gen(doc, d);
    const lines = of(g.entities, 'LINE');
    expect(lines).toHaveLength(3);
    close(lines[0]!.start, v(10, 5.625));
    close(lines[0]!.end, v(10, 30));
    close(lines[1]!.end, v(15, 35));
    const box = measureText('10', 2.5, ARIAL);
    close(lines[2]!.end, v(15, 40 + 0.625 + box.w));
    const [mt] = of(g.entities, 'MTEXT');
    expect(mt!.rotation).toBeCloseTo(Math.PI / 2, 12);
    close(mt!.insert, v(15 - 0.625 - box.h / 2, 40 + 0.625 + box.w / 2), 1e-9);
  });

  it('Y 좌표: 가로 지시선, 꺾임 없음', () => {
    const doc = makeDoc();
    doc.header.set('$UCSORG', v(0, 1, 0));
    const d = createOrdinateDimension(doc, v(10, 5), v(40, 5));
    expect(d.dimType & 64).toBe(0);
    expect(d.measurement).toBeCloseTo(4, 12);
    expect(of(gen(doc, d).entities, 'LINE')).toHaveLength(1);
  });
});

describe('문자 상자(AutoCAD 치수 블록에서 잰 값과 비교)', () => {
  // [문자, 높이, AutoCAD 폭(대문자 1466 단위), AutoCAD 높이]
  const cases: [string, number, number, number][] = [
    ['R11,4', 2.5, 5205, 1762],
    ['102,59', 2.5, 5951, 1762],
    ['353,38', 2.5, 6088, 1762],
    ['\\A1;35.1233', 0.18, 7224, 0],
    ['\\A1;7.0711', 0.18, 5791, 1497],
    ['94\\U+00B0', 2.5, 0, 1497],
    ['\\U+220545,6', 2.5, 5402, 1810],
  ];
  for (const [s, h, w, hh] of cases)
    it(s, () => {
      const b = measureText(s, h, ARIAL);
      if (w) expect(Math.abs((b.w / h) * 1466 - w)).toBeLessThan(15);
      if (hh) expect(Math.abs((b.h / h) * 1466 - hh)).toBeLessThan(15);
    });
});

describe('블록 이름', () => {
  it('nextDimBlockName: 가장 큰 *D 번호 + 1', async () => {
    const { nextDimBlockName } = await import('../../src/edit/dim');
    const doc = makeDoc();
    expect(nextDimBlockName(doc)).toBe('*D1');
    doc.blocks.set('*D7', { name: '*D7', handle: '', recordHandle: '', basePoint: v(0, 0), flags: 1, entities: [] });
    doc.blocks.set('*U9', { name: '*U9', handle: '', recordHandle: '', basePoint: v(0, 0), flags: 1, entities: [] });
    expect(nextDimBlockName(doc)).toBe('*D8');
  });
});
