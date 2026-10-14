import { describe, expect, it } from 'vitest';
import type {
  ArcEntity,
  CircleEntity,
  DimensionEntity,
  EllipseEntity,
  Entity,
  InsertEntity,
  LineEntity,
  LwPolylineEntity,
  MTextEntity,
  PolylineEntity,
  SplineEntity,
  TextEntity,
  ViewportEntity,
  XLineEntity,
} from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { gripMove, gripPoints } from '../../src/edit/geom/grips';
import { entityPath } from '../../src/edit/geom/path';
import { pathNearest } from '../../src/edit/geom/curve';
import { NEG_Z, P, V, arc, circle, deg, ellipse, fitSpline, line, lw, mtext, near, newDoc, poly2d, renders, spline, text, xline } from './helpers';

const doc = newDoc();
const one = (r: { replace?: Entity[]; add?: Entity[] }) => (r.replace ?? r.add ?? [])[0]!;
const gp = (e: Entity, id: string) => gripPoints(e, doc).find((g) => g.id === id)!;

describe('gripPoints', () => {
  it('종류별 그립', () => {
    expect(gripPoints(line(0, 0, 10, 0), doc).map((g) => g.kind)).toEqual(['end', 'mid', 'end']);
    expect(gripPoints(circle(0, 0, 1), doc).map((g) => g.id)).toEqual(['center', 'q0', 'q1', 'q2', 'q3']);
    expect(gripPoints(arc(0, 0, 5, 0, 90), doc).length).toBe(4);
    expect(gripPoints(ellipse(0, 0, 4, 0, 0.5), doc).length).toBe(5);
    expect(gripPoints(ellipse(0, 0, 4, 0, 0.5, 0, 1), doc).length).toBe(7);
    expect(gripPoints(lw([[0, 0], [5, 0], [5, 5]]), doc).map((g) => g.id)).toEqual(['v0', 'm0', 'v1', 'm1', 'v2']);
    expect(gripPoints(lw([[0, 0], [5, 0], [5, 5]], true), doc).length).toBe(6);
    expect(gripPoints(spline([[0, 0], [1, 1], [2, 0]]), doc).every((g) => g.kind === 'ctrl')).toBe(true);
    expect(gripPoints(fitSpline([[0, 0], [1, 1], [2, 0]]), doc).every((g) => g.kind === 'fit')).toBe(true);
    // −Z 원의 그립은 WCS 자리
    near(gp(circle(3, 0, 1, NEG_Z), 'center').point, V(-3, 0));
    near(gp(arc(0, 0, 5, 0, 90, NEG_Z), 'mid').point, V(-5 / Math.SQRT2, 5 / Math.SQRT2));
  });
});

describe('gripMove — 곡선', () => {
  it('선 끝·중간', () => {
    const l = line(0, 0, 10, 0);
    near((one(gripMove(l, 'end', V(10, 5), doc)) as LineEntity).end, P(10, 5));
    const m = one(gripMove(l, 'mid', V(5, 3), doc)) as LineEntity;
    near(m.start, P(0, 3));
    near(m.end, P(10, 3));
  });
  it('원: 중심 이동, 사분점 = 반지름', () => {
    const c = circle(0, 0, 5);
    expect((one(gripMove(c, 'q1', V(0, 8), doc)) as CircleEntity).radius).toBeCloseTo(8);
    near((one(gripMove(c, 'center', V(2, 2), doc)) as CircleEntity).center, P(2, 2));
  });
  it('호: 끝(세 점 호), 중간(세 점 호 / 반지름), 중심', () => {
    const a = arc(0, 0, 5, 0, 180) as ArcEntity;
    const e = one(gripMove(a, 'start', V(4, -3), doc)) as ArcEntity;
    expect(e.handle).toBe(a.handle);
    const pe = entityPath(e)!;
    for (const q of [V(4, -3), V(0, 5), V(-5, 0)]) expect(pathNearest(pe, q).d).toBeLessThan(1e-9);
    const m = one(gripMove(a, 'mid', V(0, 2), doc)) as ArcEntity;
    for (const q of [V(5, 0), V(0, 2), V(-5, 0)]) expect(pathNearest(entityPath(m)!, q).d).toBeLessThan(1e-9);
    const rr = one(gripMove(a, 'mid', V(0, 7), doc, { arcMid: 'radius' })) as ArcEntity;
    expect(rr.radius).toBeCloseTo(7);
    expect(rr.endAngle).toBeCloseTo(Math.PI);
    const n = arc(0, 0, 5, 0, 90, NEG_Z); // WCS 90°..180°
    const nm = one(gripMove(n, 'mid', V(-2, 2), doc)) as ArcEntity;
    expect(nm.extrusion).toBeUndefined();
    for (const q of [V(0, 5), V(-2, 2), V(-5, 0)]) expect(pathNearest(entityPath(nm)!, q).d).toBeLessThan(1e-9);
    renders(doc, [e, m, rr, nm]);
  });
  it('타원: 축 끝, 단축이 길어지면 맞바꿈, 호 끝', () => {
    const el = ellipse(0, 0, 4, 0, 0.5) as EllipseEntity;
    const a = one(gripMove(el, 'maj+', V(6, 0), doc)) as EllipseEntity;
    expect(a.majorAxis.x).toBeCloseTo(6);
    expect(a.ratio).toBeCloseTo(2 / 6);
    const b = one(gripMove(el, 'min+', V(0, 3), doc)) as EllipseEntity;
    expect(b.ratio).toBeCloseTo(0.75);
    const c = one(gripMove(el, 'min+', V(0, 8), doc)) as EllipseEntity;
    expect(Math.hypot(c.majorAxis.x, c.majorAxis.y)).toBeCloseTo(8);
    expect(c.majorAxis.y).toBeCloseTo(8);
    expect(c.ratio).toBeCloseTo(0.5);
    // 모양: (0, ±8), (±4, 0)을 지난다
    for (const q of [V(0, 8), V(4, 0), V(0, -8), V(-4, 0)]) expect(pathNearest(entityPath(c)!, q).d).toBeLessThan(1e-9);
    const ea = ellipse(0, 0, 4, 0, 0.5, 0, Math.PI / 2) as EllipseEntity;
    const d = one(gripMove(ea, 'end', V(-1, 1), doc)) as EllipseEntity;
    expect(d.endParam).toBeCloseTo(Math.atan2(1 / 2, -1 / 4));
    expect(gripMove(ea, 'end', V(1, 0), doc).message).toBe('길이가 너무 짧습니다.');
    // 맞바꾼 타원형 호는 같은 자리
    const sw = one(gripMove(ea, 'min+', V(0, 8), doc)) as EllipseEntity;
    expect(pathNearest(entityPath(sw)!, V(0, 8)).d).toBeLessThan(1e-9);
    expect(pathNearest(entityPath(sw)!, V(4, 0)).d).toBeLessThan(1e-9);
    expect(pathNearest(entityPath(sw)!, V(-4, 0)).d).toBeGreaterThan(1);
    renders(doc, [a, b, c, d, sw]);
  });
  it('폴리선: 정점, 직선 세그먼트 중간(평행 이동), 호 세그먼트 중간(점을 지나는 호)', () => {
    const p = lw([
      [0, 0],
      [10, 0, 0.5],
      [10, 10],
    ]) as LwPolylineEntity;
    near((one(gripMove(p, 'v1', V(12, 1), doc)) as LwPolylineEntity).vertices[1]!, V(12, 1));
    const m0 = one(gripMove(p, 'm0', V(5, 2), doc)) as LwPolylineEntity;
    near(m0.vertices[0]!, V(0, 2));
    near(m0.vertices[1]!, V(10, 2));
    const m1 = one(gripMove(p, 'm1', V(13, 5), doc)) as LwPolylineEntity;
    expect(pathNearest(entityPath(m1)!, V(13, 5)).d).toBeLessThan(1e-9);
    near(m1.vertices[1]!, V(10, 0));
    near(m1.vertices[2]!, V(10, 10));
    const n = lw([[0, 0], [10, 0]], false, NEG_Z);
    const nv = one(gripMove(n, 'v1', V(-10, 5), doc)) as LwPolylineEntity;
    expect(pathNearest(entityPath(nv)!, V(-10, 5)).d).toBeLessThan(1e-9);
    const p2 = poly2d([[0, 0], [10, 0, 0.4], [10, 10]]) as PolylineEntity;
    const q2 = one(gripMove(p2, 'm1', V(12, 5), doc)) as PolylineEntity;
    expect(pathNearest(entityPath(q2)!, V(12, 5)).d).toBeLessThan(1e-9);
    renders(doc, [m0, m1, nv, q2]);
  });
  it('스플라인: 조정점·맞춤점', () => {
    const s = spline([
      [0, 0],
      [3, 5],
      [6, 0],
    ]) as SplineEntity;
    near((one(gripMove(s, 'c1', V(3, 8), doc)) as SplineEntity).controlPoints[1]!, P(3, 8));
    const f = { ...(fitSpline([[0, 0], [3, 4], [7, 1]]) as SplineEntity) };
    const of = one(gripMove(f, 'f1', V(3, 6), doc)) as SplineEntity;
    expect(pathNearest(entityPath(of)!, V(3, 6)).d).toBeLessThan(1e-9);
  });
  it('구성선 방향', () => {
    const x = xline(0, 0, 1, 0);
    const r = one(gripMove(x, 'dir', V(3, 3), doc)) as XLineEntity;
    expect(r.direction.x).toBeCloseTo(Math.SQRT1_2);
    near((one(gripMove(x, 'base', V(2, 2), doc)) as XLineEntity).base, P(2, 2));
  });
});

describe('gripMove — 문자·블록·치수·기타', () => {
  it('문자 이동, 정렬 문자의 두 점, 여러 줄 문자 폭', () => {
    const t = text(1, 1, 'A');
    near((one(gripMove(t, 'ins', V(5, 5), doc)) as TextEntity).insert, P(5, 5));
    const al = text(0, 0, 'ABC', 1, 0, { halign: 3, alignPoint: P(10, 0) });
    const a2 = one(gripMove(al, 'align', V(10, 10), doc)) as TextEntity;
    near(a2.alignPoint!, P(10, 10));
    near(a2.insert, P(0, 0));
    const m = mtext(0, 0, 'Hello world', 2, { width: 10 }) as MTextEntity;
    expect((one(gripMove(m, 'width', V(15, -1), doc)) as MTextEntity).width).toBeCloseTo(15);
    renders(doc, [a2]);
  });
  it('블록 참조와 속성', () => {
    const at = { type: 'ATTRIB', ...entityDefaults(), handle: 'A1', insert: P(1, 1), height: 1, text: 'V', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0, tag: 'T', attFlags: 0 } as const;
    const ins = { type: 'INSERT', ...entityDefaults(), handle: 'I', block: 'X', insert: P(0, 0), scale: P(1, 1, 1), rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [{ ...at }] } as InsertEntity;
    const a = one(gripMove(ins, 'a0', V(4, 4), doc)) as InsertEntity;
    near(a.insert, P(0, 0));
    near(a.attribs[0]!.insert, P(4, 4));
    const b = one(gripMove(ins, 'ins', V(2, 0), doc)) as InsertEntity;
    near(b.insert, P(2, 0));
    near(b.attribs[0]!.insert, P(3, 1));
  });
  it('치수: 정의점 → 측정값, 문자 그립(블록 근사), 다시 만드는 함수', () => {
    const d = newDoc();
    d.blocks.set('*D5', { name: '*D5', handle: 'X1', recordHandle: 'X2', basePoint: P(0, 0), flags: 1, entities: [line(0, 3, 5, 3), mtext(2.5, 3.5, '5', 2.5, { attachment: 8 })] });
    const dm: DimensionEntity = {
      type: 'DIMENSION',
      ...entityDefaults(),
      handle: 'D',
      block: '*D5',
      dimStyle: 'Standard',
      dimType: 32 | 1,
      defPoint: P(5, 3),
      textMid: P(2.5, 3.5),
      defPoint2: P(0, 0),
      defPoint3: P(5, 0),
      defPoint4: P(0, 0),
      defPoint5: P(0, 0),
      text: '',
      measurement: 5,
      rotation: 0,
      obliqueAngle: 0,
      textRotation: 0,
      horizontalDirection: 0,
      attachment: 5,
      leaderLength: 0,
      lineSpacingStyle: 1,
      lineSpacingFactor: 1,
    };
    const ids = gripPoints(dm, d).map((g) => g.id);
    expect(ids).toEqual(['textMid', 'defPoint2', 'defPoint3', 'defPoint']);
    const a = one(gripMove(dm, 'defPoint3', V(8, 4), d)) as DimensionEntity;
    expect(a.measurement).toBeCloseTo(Math.hypot(8, 4));
    const t = gripMove(dm, 'textMid', V(2.5, 6), d);
    const tt = one(t) as DimensionEntity;
    expect(tt.dimType & 128).toBe(128);
    expect(t.blocks![0]!.entities.find((e) => e.type === 'MTEXT')!).toMatchObject({ insert: { y: 6 } });
    let called = 0;
    const g = gripMove(dm, 'defPoint', V(5, 6), d, {
      regenDimension: (x) => {
        called++;
        return { name: '*D99', handle: '', recordHandle: '', basePoint: P(0, 0), flags: 1, entities: [line(0, 6, x.defPoint.x, 6)] };
      },
    });
    expect(called).toBe(1);
    expect((one(g) as DimensionEntity).block).toBe('*D99');
  });
  it('뷰포트 모서리, 면 꼭짓점', () => {
    const vp = { type: 'VIEWPORT', ...entityDefaults(), handle: 'VP', center: P(5, 5), width: 10, height: 10, status: 1, id: 2, viewCenter: V(0, 0), snapBase: V(0, 0), snapSpacing: V(1, 1), gridSpacing: V(1, 1), viewDirection: P(0, 0, 1), viewTarget: P(0, 0), lensLength: 50, frontClip: 0, backClip: 0, viewHeight: 10, snapAngle: 0, twistAngle: 0, circleSides: 100, flags: 0, frozenLayers: [], renderMode: 0, ucsPerViewport: false } as ViewportEntity;
    const r = one(gripMove(vp, 'v2', V(20, 15), doc)) as ViewportEntity;
    near(r.center, P(10, 7.5));
    expect(r.width).toBeCloseTo(20);
    expect(r.height).toBeCloseTo(15);
  });
  it('모든 그립을 조금씩 옮겨도 그리기가 된다', () => {
    const list: Entity[] = [line(0, 0, 5, 5), circle(0, 0, 3), arc(0, 0, 4, 10, 200), arc(1, 1, 2, 0, 90, NEG_Z), ellipse(0, 0, 5, 1, 0.4, 0.3, 4), lw([[0, 0], [5, 0, 0.4], [5, 5], [0, 5, -0.2]], true), poly2d([[0, 0], [3, 1, 0.5], [6, 0]]), spline([[0, 0], [2, 3], [5, -1], [8, 2]]), fitSpline([[0, 0], [2, 3], [5, -1]]), text(0, 0, 'AB'), mtext(0, 0, 'AB', 2, { width: 5 }), xline(0, 0, 1, 1)];
    const out: Entity[] = [];
    for (const e of list)
      for (const g of gripPoints(e, doc)) {
        const r = gripMove(e, g.id, { x: g.point.x + 0.37, y: g.point.y - 0.21 }, doc);
        if (r.message) continue;
        out.push(...(r.replace ?? []), ...(r.add ?? []));
      }
    expect(out.length).toBeGreaterThan(40);
    renders(doc, out);
    expect(deg(1)).toBeGreaterThan(0);
  });
});
