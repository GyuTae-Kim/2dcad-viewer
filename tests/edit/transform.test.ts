import { describe, expect, it } from 'vitest';
import type { ArcEntity, EllipseEntity, Entity, InsertEntity, LwPolylineEntity, MTextEntity, SplineEntity, TextEntity } from '../../src/core/model';
import { transformEntity } from '../../src/edit/geom/transform';
import { type Affine, affInv, affMirror, affMul, affRotate, affScale, affTranslate } from '../../src/edit/geom/math';
import { NEG_Z, P, V, arc, circle, deg, ellipse, fitSpline, line, lw, mappedPath, mtext, near, newDoc, only, poly2d, renders, samePath, spline, text, xline } from './helpers';

const doc = newDoc();

const MATS: [string, Affine][] = [
  ['이동', affTranslate(10, -5)],
  ['회전', affRotate(deg(30), V(3, 4))],
  ['축척', affScale(2.5, 2.5, V(1, 1))],
  ['대칭(세로)', affMirror(V(0, 0), V(0, 1))],
  ['대칭(가로)', affMirror(V(0, 0), V(1, 0))],
  ['대칭(비스듬히)', affMirror(V(1, 2), V(4, 7))],
  ['회전+축척+이동', affMul(affTranslate(100, 50), affMul(affRotate(deg(-70)), affScale(0.4)))],
];

const NONUNI: Affine = affScale(2, 0.5, V(1, -1));
const SHEAR: Affine = [1, 0, 0.5, 1, 3, 0];

const curves = (): [string, Entity][] => [
  ['선', line(0, 0, 10, 5)],
  ['원', circle(5, 5, 3)],
  ['호', arc(2, 3, 4, 10, 200)],
  ['호(−Z)', arc(2, 3, 4, 10, 200, NEG_Z)],
  ['원(−Z)', circle(-4, 2, 2, NEG_Z)],
  ['타원', ellipse(1, 2, 6, 2, 0.4)],
  ['타원호', ellipse(1, 2, 6, 2, 0.4, 0.5, 4)],
  ['폴리선', lw([[0, 0], [10, 0, 0.5], [10, 10], [0, 10, -1]], true)],
  ['폴리선(−Z)', lw([[0, 0], [10, 0, 0.5], [10, 10], [5, 12]], false, NEG_Z)],
  ['2D 폴리선', poly2d([[0, 0, 0.3], [5, 1], [8, 6, -0.7], [2, 9]])],
  ['스플라인', spline([[0, 0], [3, 5], [7, -2], [10, 4], [14, 0]])],
  ['맞춤 스플라인', fitSpline([[0, 0], [3, 4], [7, 1], [10, 6]])],
];

describe('transformEntity — 곡선 객체는 경로가 정확히 옮겨진다', () => {
  for (const [mn, m] of [...MATS, ['비균등 축척', NONUNI] as [string, Affine], ['기울임', SHEAR] as [string, Affine]]) {
    for (const [cn, e] of curves()) {
      it(`${cn} × ${mn}`, () => {
        const r = transformEntity(e, m, doc);
        const out = only(r);
        mappedPath(e, out, m, 1e-6);
        renders(doc, [out]);
      });
    }
  }
});

describe('transformEntity — 종류와 표현', () => {
  it('원·호는 닮음 변환에서 원·호, 비균등 축척에서 ELLIPSE(삭제 + 추가)', () => {
    const c = circle(0, 0, 2);
    const r1 = transformEntity(c, affScale(3), doc);
    expect(r1.replace?.[0]?.type).toBe('CIRCLE');
    expect((r1.replace![0] as { radius: number }).radius).toBeCloseTo(6);
    const r2 = transformEntity(c, NONUNI, doc);
    expect(r2.remove).toEqual([c.handle]);
    expect(r2.add?.[0]?.type).toBe('ELLIPSE');
    const el = r2.add![0] as EllipseEntity;
    expect(Math.hypot(el.majorAxis.x, el.majorAxis.y)).toBeCloseTo(4);
    expect(el.ratio).toBeCloseTo(0.25);
  });
  it('대칭한 호는 +Z 그대로 각도를 바꾼다(AutoCAD MIRROR)', () => {
    const a = arc(5, 0, 2, 0, 90) as ArcEntity;
    const r = only(transformEntity(a, affMirror(V(0, 0), V(0, 1)), doc)) as ArcEntity;
    expect(r.extrusion).toBeUndefined();
    near(r.center, P(-5, 0));
    expect(r.startAngle).toBeCloseTo(deg(90));
    expect(r.endAngle).toBeCloseTo(deg(180));
  });
  it('−Z 호를 옮기면 자연스러운 호가 된다', () => {
    const a = arc(5, 0, 2, 0, 90, NEG_Z) as ArcEntity;
    const r = only(transformEntity(a, affTranslate(1, 1), doc)) as ArcEntity;
    expect(r.extrusion).toBeUndefined();
    near(r.center, P(-4, 1));
    // OCS 0°..90° → WCS 90°..180°
    expect(r.startAngle).toBeCloseTo(deg(90));
    expect(r.endAngle).toBeCloseTo(deg(180));
  });
  it('볼록도 폴리선 대칭 → 볼록도 부호 반전', () => {
    const p = lw([[0, 0, 1], [10, 0]]) as LwPolylineEntity;
    const r = only(transformEntity(p, affMirror(V(0, 0), V(1, 0)), doc)) as LwPolylineEntity;
    expect(r.vertices[0]!.bulge).toBeCloseTo(-1);
  });
  it('볼록도 폴리선 비균등 축척 → 유리 SPLINE', () => {
    const p = lw([[0, 0, 1], [10, 0], [10, 5]]);
    const r = transformEntity(p, NONUNI, doc);
    expect(r.add?.[0]?.type).toBe('SPLINE');
    expect((r.add![0] as SplineEntity).weights).toBeDefined();
  });
  it('폭 있는 폴리선은 축척만큼 폭도 바뀐다', () => {
    const p = lw([[0, 0], [10, 0]], false, undefined, 0.5) as LwPolylineEntity;
    const r = only(transformEntity(p, affScale(2), doc)) as LwPolylineEntity;
    expect(r.constantWidth).toBeCloseTo(1);
  });
  it('맞춤점 스플라인: 닮음은 맞춤점 유지, 비균등은 조정점 정의로', () => {
    const s = fitSpline([[0, 0], [3, 4], [7, 1], [10, 6]]) as SplineEntity;
    const a = only(transformEntity(s, affRotate(1), doc)) as SplineEntity;
    expect(a.fitPoints.length).toBe(4);
    const b = only(transformEntity(s, NONUNI, doc)) as SplineEntity;
    expect(b.fitPoints.length).toBe(0);
    expect(b.controlPoints.length).toBeGreaterThan(3);
  });
  it('XLINE·RAY 방향', () => {
    const x = xline(1, 1, 1, 0);
    const r = only(transformEntity(x, affRotate(deg(90)), doc)) as { base: { x: number; y: number }; direction: { x: number; y: number } };
    near(r.base, P(-1, 1));
    near(r.direction, P(0, 1));
  });
  it('변환 후 역변환 = 원래(속성 시험)', () => {
    for (const [, m] of [...MATS, ['비균등', NONUNI] as [string, Affine]]) {
      const inv = affInv(m)!;
      for (const [, e] of curves()) {
        const a = only(transformEntity(e, m, doc));
        const b = only(transformEntity(a, inv, doc));
        samePath(e, b, 1e-6);
      }
    }
  });
});

describe('transformEntity — 문자', () => {
  it('이동·회전·축척', () => {
    const t = text(1, 2, 'ABC', 2) as TextEntity;
    const r = only(transformEntity(t, affMul(affRotate(deg(90)), affScale(2)), doc)) as TextEntity;
    near(r.insert, P(-4, 2));
    expect(r.rotation).toBeCloseTo(deg(90));
    expect(r.height).toBeCloseTo(4);
    expect(r.generation).toBe(0);
  });
  it('MIRRTEXT = 1: 세로 대칭선이면 좌우 반전 플래그', () => {
    const t = text(1, 0, 'ABC', 2) as TextEntity;
    const r = only(transformEntity(t, affMirror(V(0, 0), V(0, 1)), doc, { mirrorText: true })) as TextEntity;
    expect(r.generation & 2).toBe(2);
    expect(r.rotation).toBeCloseTo(0);
    near(r.insert, P(-1, 0));
  });
  it('MIRRTEXT = 1: 가로 대칭선이면 상하 반전 플래그', () => {
    const t = text(1, 3, 'ABC', 2) as TextEntity;
    const r = only(transformEntity(t, affMirror(V(0, 0), V(1, 0)), doc, { mirrorText: true })) as TextEntity;
    expect(r.generation & 4).toBe(4);
    expect(r.rotation).toBeCloseTo(0);
    near(r.insert, P(1, -3));
  });
  it('MIRRTEXT = 0(기본): 읽을 수 있고 상자는 거울상 자리', () => {
    const t = text(1, 0, 'ABC', 2) as TextEntity;
    const r = only(transformEntity(t, affMirror(V(0, 0), V(0, 1)), doc)) as TextEntity;
    expect(r.generation).toBe(0);
    expect(r.rotation).toBeCloseTo(0);
    // 상자 [1, 1 + w] → [−1 − w, −1]: 왼쪽 정렬점은 −1 − w
    expect(r.insert.x).toBeLessThan(-1.5);
    expect(r.insert.y).toBeCloseTo(0);
    const r2 = only(transformEntity(t, affMirror(V(0, 0), V(1, 0)), doc)) as TextEntity;
    expect(r2.generation).toBe(0);
    expect(r2.rotation).toBeCloseTo(0);
    expect(r2.insert.y).toBeLessThan(-1);
  });
  it('가운데 정렬 문자의 대칭(MIRRTEXT = 0)은 정렬점이 거울상', () => {
    const t = text(0, 0, 'ABC', 2, 0, { halign: 1, alignPoint: P(5, 1) }) as TextEntity;
    const r = only(transformEntity(t, affMirror(V(0, 0), V(0, 1)), doc)) as TextEntity;
    near(r.alignPoint!, P(-5, 1), 1e-6);
    expect(r.generation).toBe(0);
  });
  it('−Z 문자를 옮기면 자연스러운 좌우 반전 문자(같은 모양)', () => {
    const t = text(3, 1, 'ABC', 2, 0, { extrusion: NEG_Z }) as TextEntity;
    const r = only(transformEntity(t, affTranslate(0, 0), doc)) as TextEntity;
    expect(r.extrusion).toBeUndefined();
    near(r.insert, P(-3, 1));
    renders(doc, [r]);
  });
  it('MTEXT 회전·대칭(늘 읽을 수 있게)', () => {
    const t = mtext(2, 2, 'Hello\\PWorld', 2.5, { width: 20 }) as MTextEntity;
    const a = only(transformEntity(t, affRotate(deg(45)), doc)) as MTextEntity;
    expect(Math.atan2(a.direction!.y, a.direction!.x)).toBeCloseTo(deg(45));
    const b = only(transformEntity(t, affMirror(V(0, 0), V(0, 1)), doc)) as MTextEntity;
    expect(b.extrusion).toBeUndefined();
    expect(b.direction!.x).toBeCloseTo(1);
    expect(b.insert.x).toBeLessThan(-2);
    const c = only(transformEntity(t, affScale(2), doc)) as MTextEntity;
    expect(c.height).toBeCloseTo(5);
    expect(c.width).toBeCloseTo(40);
    renders(doc, [a, b, c]);
  });
});

describe('transformEntity — 블록 참조', () => {
  const d2 = newDoc();
  d2.blocks.set('B', { name: 'B', handle: 'B1', recordHandle: 'B2', basePoint: P(0, 0), flags: 0, entities: [line(0, 0, 1, 0), circle(0, 0, 0.5)] });
  const ins = (): InsertEntity => ({
    type: 'INSERT',
    handle: 'I1',
    layer: '0',
    linetype: 'ByLayer',
    color: { aci: 256 },
    lineweight: -1,
    ltscale: 1,
    transparency: -1,
    block: 'B',
    insert: P(5, 5),
    scale: P(1, 1, 1),
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  });
  it('대칭: X 축척 음수(AutoCAD 방식)', () => {
    const r = only(transformEntity(ins(), affMirror(V(0, 0), V(0, 1)), d2)) as InsertEntity;
    near(r.insert, P(-5, 5));
    expect(r.scale.x).toBeCloseTo(-1);
    expect(r.scale.y).toBeCloseTo(1);
    expect(r.rotation).toBeCloseTo(0);
    const r2 = only(transformEntity(ins(), affMirror(V(0, 0), V(1, 0)), d2)) as InsertEntity;
    expect(r2.scale.x).toBeCloseTo(-1);
    expect(r2.rotation).toBeCloseTo(Math.PI);
    renders(d2, [r, r2]);
  });
  it('회전·축척', () => {
    const r = only(transformEntity(ins(), affMul(affRotate(deg(30)), affScale(2)), d2)) as InsertEntity;
    expect(r.rotation).toBeCloseTo(deg(30));
    expect(r.scale.x).toBeCloseTo(2);
    expect(r.scale.y).toBeCloseTo(2);
  });
  it('기울임은 안내 문구', () => {
    const e = ins();
    e.rotation = deg(30);
    const r = transformEntity(e, NONUNI, d2);
    expect(r.message).toBeTruthy();
  });
});
