/** 연관 치수(DIMASSOC): 기록 읽기·쓰기, 점 참조 만들기·풀기, 형상 편집 따라가기, 연관 끊기, DIMREGEN */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, DictionaryObject, DimensionEntity, Entity, GenericObject, LineEntity, LwPolylineEntity, RawTag } from '../../src/core/model';
import {
  createAlignedDimension,
  createAngular2LineDimension,
  createAngularDimension,
  createDiameterDimension,
  createLinearDimension,
  createOrdinateDimension,
  createRadialDimension,
} from '../../src/edit/dim';
import {
  DIMASSOC_KEY,
  type DimAssocData,
  OSNAP,
  type PointRef,
  assocFlags,
  associatedDimensions,
  circlePointRef,
  curveParam,
  dimAssocOf,
  dimAssocRaw,
  findRefAt,
  isAssociative,
  nearRef,
  parseDimAssoc,
  pointAtParam,
  regenAssociations,
  snapRef,
} from '../../src/edit/dim/assoc';
import { transformEntity } from '../../src/edit/geom';
import { affApply, affMirror, affRotate, affScale, affTranslate } from '../../src/edit/geom/math';
import { P, arc, bench, circle, line } from './helpers';

const close = (a: { x: number; y: number }, b: { x: number; y: number }, d = 9) => {
  expect(a.x).toBeCloseTo(b.x, d);
  expect(a.y).toBeCloseTo(b.y, d);
};

describe('DIMASSOC 기록', () => {
  it('원본 태그 → 내용 → 원본 태그가 같고, 플래그 비트 차례로 참조를 둔다', () => {
    const r1: PointRef = { osnap: OSNAP.END, ids: ['2F'], subent: 0, gsMarker: 0, param: 0, point: P(1, 2), lastPointRef: false };
    const r3: PointRef = { osnap: OSNAP.INT, ids: ['30'], subent: 2, gsMarker: 3, param: 0, point: P(5, 6), lastPointRef: false, ids2: ['31'], subent2: 0, gsMarker2: 0 };
    const data: DimAssocData = { dimension: '40', transSpace: false, rotatedType: 0, refs: [r1, null, r3, null] };
    const raw = dimAssocRaw(data);
    expect(raw[0]).toEqual({ code: 100, value: 'AcDbDimAssoc' });
    expect(raw.find((t) => t.code === 90)?.value).toBe(5);
    expect(assocFlags(data)).toBe(5);
    const back = parseDimAssoc(raw)!;
    expect(back.dimension).toBe('40');
    expect(back.refs[0]).toMatchObject({ osnap: 1, ids: ['2F'], point: { x: 1, y: 2, z: 0 } });
    expect(back.refs[1]).toBeNull();
    expect(back.refs[2]).toMatchObject({ osnap: 6, ids: ['30'], ids2: ['31'], gsMarker: 3, subent: 2 });
    expect(dimAssocRaw(back)).toEqual(raw);
  });

  it('AutoCAD식 태그(75가 교차 객체 앞·뒤, 0 핸들, 앞자리 0)도 읽는다', () => {
    const raw: RawTag[] = [
      { code: 100, value: 'AcDbDimAssoc' },
      { code: 330, value: '00A1' },
      { code: 90, value: 2 },
      { code: 70, value: 0 },
      { code: 71, value: 1 },
      { code: 1, value: 'AcDbOsnapPointRef' },
      { code: 72, value: 10 },
      { code: 331, value: '9f' },
      { code: 73, value: 0 },
      { code: 91, value: 0 },
      { code: 40, value: 1.25 },
      { code: 10, value: 3 },
      { code: 20, value: 4 },
      { code: 30, value: 0 },
      { code: 75, value: 0 },
      { code: 332, value: '0' },
    ];
    const d = parseDimAssoc(raw)!;
    expect(d.dimension).toBe('A1');
    expect(d.rotatedType).toBe(1);
    expect(d.refs[0]).toBeNull();
    expect(d.refs[1]).toMatchObject({ osnap: 10, ids: ['9F'], param: 1.25, point: { x: 3, y: 4, z: 0 } });
    expect(d.refs[1]!.ids2).toBeUndefined();
  });
});

describe('점 참조', () => {
  it('선 끝점·중간점, 원 중심·사분점, 근처점 매개변수(선 = 시작에서 거리, 원 = 각도)', () => {
    const b = bench();
    const l = b.add(line(P(0, 0), P(100, 0))) as LineEntity;
    const c = b.add(circle(P(50, 50), 10)) as CircleEntity;
    expect(snapRef(b.doc, l, OSNAP.END, { x: 100, y: 0 }, 1e-6)).toMatchObject({ osnap: OSNAP.END, ids: [l.handle] });
    expect(snapRef(b.doc, l, OSNAP.MID, { x: 50, y: 0 }, 1e-6)?.osnap).toBe(OSNAP.MID);
    expect(snapRef(b.doc, l, OSNAP.END, { x: 50, y: 0 }, 1e-6)).toBeNull();
    expect(snapRef(b.doc, c, OSNAP.CEN, { x: 50, y: 50 }, 1e-6)?.osnap).toBe(OSNAP.CEN);
    expect(snapRef(b.doc, c, OSNAP.QUAD, { x: 50, y: 60 }, 1e-6)?.osnap).toBe(OSNAP.QUAD);
    const n = nearRef(l, { x: 30, y: 0.0001 }, 0.001)!;
    expect(n.osnap).toBe(OSNAP.NEAR);
    expect(n.param).toBeCloseTo(30, 9);
    const cn = circlePointRef(c, { x: 50, y: 70 })!;
    expect(cn.param).toBeCloseTo(Math.PI / 2, 12);
    close(cn.point, { x: 50, y: 60 });
    close(pointAtParam(c, Math.PI)!, { x: 40, y: 50 });
    expect(curveParam(l, { x: 200, y: 5 })!.param).toBeCloseTo(100, 9);
  });

  it('자리로 찾기: 끝점이 교차점보다 먼저, 교차점은 두 객체, 치수는 빼고', () => {
    const b = bench();
    const l1 = b.add(line(P(0, 0), P(100, 100)));
    const l2 = b.add(line(P(0, 100), P(100, 0)));
    const l3 = b.add(line(P(50, 50), P(50, -50)));
    const r = findRefAt(b.doc, [l1, l2], { x: 50, y: 50 }, { tol: 1e-6 })!;
    expect(r.osnap).toBe(OSNAP.INT);
    expect(new Set([r.ids[0], r.ids2![0]])).toEqual(new Set([l1.handle, l2.handle]));
    expect(findRefAt(b.doc, [l1, l2, l3], { x: 50, y: 50 }, { tol: 1e-6 })).toMatchObject({ osnap: OSNAP.END, ids: [l3.handle] });
    const d = createLinearDimension(b.doc, P(0, 0), P(100, 100), P(50, 120), { rotation: 0 });
    d.handle = 'FFFF';
    expect(findRefAt(b.doc, [d], { x: 0, y: 0 }, { tol: 1e-6 })).toBeNull();
  });

  it('폴리선 꼭짓점은 세그먼트 GS 표지(번호 + 1)를 단다', () => {
    const b = bench();
    const pl = b.add({
      type: 'LWPOLYLINE',
      handle: '',
      layer: '0',
      linetype: 'ByLayer',
      color: { aci: 256 },
      lineweight: -1,
      ltscale: 1,
      transparency: -1,
      closed: true,
      plinegen: false,
      constantWidth: 0,
      elevation: 0,
      vertices: [
        { x: 0, y: 0, bulge: 0, startWidth: 0, endWidth: 0 },
        { x: 100, y: 0, bulge: 0, startWidth: 0, endWidth: 0 },
        { x: 100, y: 50, bulge: 0, startWidth: 0, endWidth: 0 },
        { x: 0, y: 50, bulge: 0, startWidth: 0, endWidth: 0 },
      ],
    } as LwPolylineEntity);
    const r = snapRef(b.doc, pl, OSNAP.END, { x: 100, y: 50 }, 1e-6)!;
    expect(r.subent).toBe(2);
    expect([2, 3]).toContain(r.gsMarker);
    const m = snapRef(b.doc, pl, OSNAP.MID, { x: 50, y: 50 }, 1e-6)!;
    expect(m.gsMarker).toBe(3);
  });
});

describe('새 연관 치수', () => {
  it('확장 사전 ACAD_DIMASSOC → DIMASSOC, 형상 반응자, 치수 핸들(330)', () => {
    const b = bench();
    const l = b.add(line(P(0, 0), P(100, 0)));
    const d0 = createLinearDimension(b.doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0 });
    const refs = [snapRef(b.doc, l, OSNAP.END, { x: 0, y: 0 }, 1e-6), snapRef(b.doc, l, OSNAP.END, { x: 100, y: 0 }, 1e-6)];
    const d = b.addDim(d0, refs);
    expect(d.xdict).toBeTruthy();
    const dict = b.doc.objects.get(d.xdict!) as DictionaryObject;
    expect(dict.type).toBe('DICTIONARY');
    expect(dict.owner).toBe(d.handle);
    expect(dict.hardOwner).toBe(true);
    const ah = dict.entries.get(DIMASSOC_KEY)!;
    const obj = b.doc.objects.get(ah) as GenericObject;
    expect(obj.type).toBe('DIMASSOC');
    expect(obj.owner).toBe(dict.handle);
    expect(obj.reactors).toEqual([dict.handle]);
    const a = dimAssocOf(b.doc, d)!;
    expect(a.data.dimension).toBe(d.handle);
    expect(assocFlags(a.data)).toBe(3);
    expect(b.doc.entityIndex.get(l.handle)!.reactors).toEqual([ah]);
    expect(associatedDimensions(b.doc, b.doc.entityIndex.get(l.handle)!)).toEqual([d.handle]);
    expect(isAssociative(b.doc, d)).toBe(true);
    // 명령 취소하면 기록이 모두 빠진다
    b.s.undo();
    expect(b.doc.objects.has(ah)).toBe(false);
    expect(b.doc.objects.has(dict.handle)).toBe(false);
    expect(b.doc.entityIndex.get(l.handle)!.reactors).toBeUndefined();
  });
});

describe('따라가기', () => {
  const linearSetup = (aligned = false) => {
    const b = bench();
    const l = b.add(line(P(0, 0), P(100, 0))) as LineEntity;
    const d0 = aligned ? createAlignedDimension(b.doc, P(0, 0), P(100, 0), P(50, 20)) : createLinearDimension(b.doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0 });
    const refs = [snapRef(b.doc, l, OSNAP.END, { x: 0, y: 0 }, 1e-6), snapRef(b.doc, l, OSNAP.END, { x: 100, y: 0 }, 1e-6)];
    const d = b.addDim(d0, refs);
    return { b, l, d };
  };
  const moved = (b: ReturnType<typeof bench>, e: Entity, m: Parameters<typeof transformEntity>[1]) => transformEntity(e, m, b.doc).replace![0]!;

  it('이동: 치수 전체(문자 포함)가 같이 옮겨지고 기록된 스냅 점도 바뀐다', () => {
    const { b, l, d } = linearSetup();
    const m = affTranslate(10, 5);
    const f = b.edit(new Map([[l.handle, moved(b, l, m)]]), { transform: (p) => affApply(m, p) });
    expect(f.dims.has(d.handle)).toBe(true);
    const n = b.dim(d.handle);
    close(n.defPoint2, { x: 10, y: 5 });
    close(n.defPoint3, { x: 110, y: 5 });
    close(n.defPoint, { x: d.defPoint.x + 10, y: d.defPoint.y + 5 });
    close(n.textMid, { x: d.textMid.x + 10, y: d.textMid.y + 5 });
    expect(n.measurement).toBeCloseTo(100, 9);
    const a = dimAssocOf(b.doc, n)!;
    close(a.data.refs[1]!.point, { x: 110, y: 5 });
    // 되돌리기
    b.s.undo();
    close(b.dim(d.handle).defPoint2, { x: 0, y: 0 });
    close(dimAssocOf(b.doc, b.dim(d.handle))!.data.refs[1]!.point, { x: 100, y: 0 });
  });

  it('끝점 신축: 회전 치수는 각도와 치수선 자리를 지킨다', () => {
    const { b, l, d } = linearSetup();
    const ln = { ...(l as LineEntity), end: P(120, 30) };
    b.edit(new Map([[l.handle, ln]]));
    const n = b.dim(d.handle);
    close(n.defPoint3, { x: 120, y: 30 });
    expect(n.rotation).toBe(0);
    expect(n.defPoint.y).toBeCloseTo(d.defPoint.y, 9);
    expect(n.measurement).toBeCloseTo(120, 9);
  });

  it('회전: 정렬 치수는 치수선 간격을 지키며 같이 돈다', () => {
    const { b, l, d } = linearSetup(true);
    const m = affRotate(Math.PI / 2, { x: 0, y: 0 });
    b.edit(new Map([[l.handle, moved(b, l, m)]]), { transform: (p) => affApply(m, p) });
    const n = b.dim(d.handle);
    close(n.defPoint3, { x: 0, y: 100 });
    close(n.defPoint, { x: -20, y: 100 });
    expect(n.measurement).toBeCloseTo(100, 9);
  });

  it('형상을 지우면 치수는 남고 연관(DIMASSOC·확장 사전)만 끊긴다', () => {
    const { b, l, d } = linearSetup();
    const dictH = d.xdict!;
    const f = b.edit(new Map([[l.handle, null]]));
    expect(f.released.has(d.handle)).toBe(true);
    const n = b.dim(d.handle);
    expect(n).toBeTruthy();
    expect(n.xdict).toBeUndefined();
    expect(b.doc.objects.has(dictH)).toBe(false);
    expect([...b.doc.objects.values()].some((o) => o.type === 'DIMASSOC')).toBe(false);
    close(n.defPoint3, d.defPoint3);
  });

  it('치수만 옮기면 연관이 풀리고, 정의점 하나를 그립으로 옮기면 그 점만 풀린다', () => {
    {
      const { b, l, d } = linearSetup();
      b.edit(new Map([[d.handle, moved(b, d, affTranslate(0, 10))]]));
      expect(isAssociative(b.doc, b.dim(d.handle))).toBe(false);
      expect(b.doc.entityIndex.get(l.handle)!.reactors).toBeUndefined();
    }
    {
      const { b, l, d } = linearSetup();
      const g = { ...structuredClone(d), defPoint2: P(-10, 0) };
      b.edit(new Map([[d.handle, g]]));
      const a = dimAssocOf(b.doc, b.dim(d.handle))!;
      expect(assocFlags(a.data)).toBe(2);
      expect(b.doc.entityIndex.get(l.handle)!.reactors).toEqual([a.obj.handle]);
      // 남은 점은 계속 따라간다
      b.edit(new Map([[l.handle, { ...(b.doc.entityIndex.get(l.handle) as LineEntity), end: P(150, 0) }]]));
      close(b.dim(d.handle).defPoint3, { x: 150, y: 0 });
      close(b.dim(d.handle).defPoint2, { x: -10, y: 0 });
    }
  });

  it('형상과 치수를 함께 옮기면 연관이 그대로다', () => {
    const { b, l, d } = linearSetup();
    const m = affTranslate(30, -7);
    b.edit(
      new Map([
        [l.handle, moved(b, l, m)],
        [d.handle, moved(b, d, m)],
      ]),
      { transform: (p) => affApply(m, p) },
    );
    const n = b.dim(d.handle);
    expect(assocFlags(dimAssocOf(b.doc, n)!.data)).toBe(3);
    close(n.defPoint2, { x: 30, y: -7 });
  });

  it('반지름·지름: 원을 옮기면 같이, 축척하면 반지름이 바뀌고 현 위 점의 각도는 그대로', () => {
    const b = bench();
    const c = b.add(circle(P(0, 0), 10)) as CircleEntity;
    const r0 = createRadialDimension(b.doc, P(0, 0), 10, P(10, 0));
    const rd = b.addDim(r0, [circlePointRef(c, r0.defPoint4), snapRef(b.doc, c, OSNAP.CEN, { x: 0, y: 0 }, 1e-9)]);
    const d0 = createDiameterDimension(b.doc, P(0, 0), 10, P(0, 10));
    const dd = b.addDim(d0, [circlePointRef(c, d0.defPoint4), circlePointRef(c, d0.defPoint)]);
    const s = affScale(2, 2, { x: 0, y: 0 });
    b.edit(new Map([[c.handle, moved(b, c, s)]]), { transform: (p) => affApply(s, p) });
    expect(b.dim(rd.handle).measurement).toBeCloseTo(20, 9);
    close(b.dim(rd.handle).defPoint4, { x: 20, y: 0 });
    expect(b.dim(dd.handle).measurement).toBeCloseTo(40, 9);
    close(b.dim(dd.handle).defPoint, { x: 0, y: -20 });
    const t = affTranslate(5, 5);
    const c2 = b.doc.entityIndex.get(c.handle)!;
    b.edit(new Map([[c.handle, moved(b, c2, t)]]), { transform: (p) => affApply(t, p) });
    close(b.dim(rd.handle).defPoint, { x: 5, y: 5 });
    close(b.dim(rd.handle).defPoint4, { x: 25, y: 5 });
    close(b.dim(dd.handle).defPoint4, { x: 5, y: 25 });
  });

  it('3점 각도(호): 회전·대칭에도 재는 쪽과 호 반지름을 지킨다', () => {
    const b = bench();
    const a = b.add(arc(P(0, 0), 10, 0, Math.PI / 2)) as ArcEntity;
    const d0 = createAngularDimension(b.doc, P(0, 0), P(10, 0), P(0, 10), P(7, 7));
    const d = b.addDim(d0, [snapRef(b.doc, a, OSNAP.END, { x: 10, y: 0 }, 1e-9), snapRef(b.doc, a, OSNAP.END, { x: 0, y: 10 }, 1e-9), snapRef(b.doc, a, OSNAP.CEN, { x: 0, y: 0 }, 1e-9)]);
    const m = affRotate(Math.PI / 2, { x: 0, y: 0 });
    b.edit(new Map([[a.handle, moved(b, a, m)]]), { transform: (p) => affApply(m, p) });
    let n = b.dim(d.handle);
    close(n.defPoint2, { x: 0, y: 10 });
    close(n.defPoint3, { x: -10, y: 0 });
    close(n.defPoint, { x: -7, y: 7 });
    expect(n.measurement).toBeCloseTo(Math.PI / 2, 9);
    // 세로축 대칭: 호의 시작·끝이 바뀌어도 같은 점을 따라간다
    const mm = affMirror({ x: 0, y: 0 }, { x: 0, y: 1 });
    const a2 = b.doc.entityIndex.get(a.handle)!;
    b.edit(new Map([[a.handle, moved(b, a2, mm)]]), { transform: (p) => affApply(mm, p) });
    n = b.dim(d.handle);
    close(n.defPoint2, { x: 0, y: 10 });
    close(n.defPoint3, { x: 10, y: 0 });
    expect(n.measurement).toBeCloseTo(Math.PI / 2, 9);
  });

  it('두 선 각도: 한 선을 돌리면 정점(가상 교차점)·재는 쪽을 지킨다', () => {
    const b = bench();
    const l1 = b.add(line(P(0, 0), P(10, 0))) as LineEntity;
    const l2 = b.add(line(P(0, 0), P(0, 10))) as LineEntity;
    const d0 = createAngular2LineDimension(b.doc, l1.start, l1.end, l2.start, l2.end, P(5, 5));
    const end = (e: Entity, q: { x: number; y: number }) => snapRef(b.doc, e, OSNAP.END, q, 1e-9);
    const d = b.addDim(d0, [end(l1, l1.start), end(l1, l1.end), end(l2, l2.start), end(l2, l2.end)]);
    const m = affRotate(-Math.PI / 4, { x: 0, y: 0 });
    b.edit(new Map([[l2.handle, moved(b, l2, m)]]), { transform: (p) => affApply(m, p) });
    const n = b.dim(d.handle);
    close(n.defPoint, { x: Math.SQRT1_2 * 10, y: Math.SQRT1_2 * 10 });
    expect(n.measurement).toBeCloseTo(Math.PI / 4, 9);
    const a5 = Math.atan2(n.defPoint5.y, n.defPoint5.x);
    expect(a5).toBeGreaterThan(0);
    expect(a5).toBeLessThan(Math.PI / 4);
  });

  it('교차점·근처점·폴리선 꼭짓점 참조', () => {
    const b = bench();
    const l1 = b.add(line(P(0, 0), P(100, 100))) as LineEntity;
    const l2 = b.add(line(P(0, 100), P(100, 0))) as LineEntity;
    const l3 = b.add(line(P(0, -50), P(100, -50))) as LineEntity;
    const ri = findRefAt(b.doc, [l1, l2], { x: 50, y: 50 }, { tol: 1e-9 })!;
    const rn = nearRef(l3, { x: 30, y: -50 }, 1e-9)!;
    const d = b.addDim(createAlignedDimension(b.doc, P(50, 50), P(30, -50), P(80, 0)), [ri, rn]);
    b.edit(new Map([[l2.handle, { ...l2, start: P(20, 100), end: P(120, 0) }]]));
    close(b.dim(d.handle).defPoint2, { x: 60, y: 60 });
    // 근처점: 선 시작을 옮기면 시작에서 같은 거리
    b.edit(new Map([[l3.handle, { ...l3, start: P(-10, -50) }]]));
    close(b.dim(d.handle).defPoint3, { x: 20, y: -50 });
  });

  it('세로좌표: 피쳐가 옮겨지면 지시선 끝도 같은 만큼, 원점은 그대로', () => {
    const b = bench();
    const pt = b.add({ type: 'POINT', handle: '', layer: '0', linetype: 'ByLayer', color: { aci: 256 }, lineweight: -1, ltscale: 1, transparency: -1, position: P(30, 40), angle: 0 } as unknown as Entity);
    const d0 = createOrdinateDimension(b.doc, P(30, 40), P(30, 70), { xAxis: true });
    const d = b.addDim(d0, [null, snapRef(b.doc, pt, OSNAP.NODE, { x: 30, y: 40 }, 1e-9)]);
    b.edit(new Map([[pt.handle, { ...(pt as Entity & { position: { x: number; y: number; z: number } }), position: P(35, 45) } as Entity]]));
    const n = b.dim(d.handle);
    close(n.defPoint2, { x: 35, y: 45 });
    close(n.defPoint3, { x: 35, y: 75 });
    close(n.defPoint, d.defPoint);
    expect(n.measurement).toBeCloseTo(35, 9);
  });

  it('치수를 지우면 DIMASSOC·확장 사전을 지우고 형상 반응자를 정리한다', () => {
    const { b, l, d } = linearSetup();
    b.edit(new Map([[d.handle, null]]));
    expect([...b.doc.objects.values()].some((o) => o.type === 'DIMASSOC')).toBe(false);
    expect(b.doc.objects.has(d.xdict!)).toBe(false);
    expect(b.doc.entityIndex.get(l.handle)!.reactors).toBeUndefined();
  });
});

describe('DIMREGEN', () => {
  it('따라가지 않은 편집 뒤 연관 치수를 형상에 다시 맞추고, 없어진 객체의 참조는 끊는다', () => {
    const b = bench();
    const l = b.add(line(P(0, 0), P(100, 0))) as LineEntity;
    const l2 = b.add(line(P(0, 30), P(80, 30))) as LineEntity;
    const d = b.addDim(createLinearDimension(b.doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0 }), [
      snapRef(b.doc, l, OSNAP.END, { x: 0, y: 0 }, 1e-9),
      snapRef(b.doc, l, OSNAP.END, { x: 100, y: 0 }, 1e-9),
    ]);
    const d2 = b.addDim(createLinearDimension(b.doc, P(0, 30), P(80, 30), P(40, 50), { rotation: 0 }), [
      snapRef(b.doc, l2, OSNAP.END, { x: 0, y: 30 }, 1e-9),
      snapRef(b.doc, l2, OSNAP.END, { x: 80, y: 30 }, 1e-9),
    ]);
    // 연관을 거치지 않은 편집(예: 다른 경로)
    b.s.commit({ label: 'X', ops: [{ kind: 'modify', block: '*MODEL_SPACE', before: l, after: { ...l, end: P(140, 0) } }] });
    const ms = b.doc.blocks.get('*MODEL_SPACE')!;
    b.s.commit({ label: 'E', ops: [{ kind: 'remove', block: '*MODEL_SPACE', entity: b.doc.entityIndex.get(l2.handle)!, index: ms.entities.findIndex((e) => e.handle === l2.handle) }] });
    const r = regenAssociations(b.doc, () => b.s.newHandle());
    expect(r.dims.get(d.handle)!.measurement).toBeCloseTo(140, 9);
    expect(r.released.has(d2.handle)).toBe(true);
    expect(r.objects.some((o) => o.after === null && o.before?.type === 'DIMASSOC')).toBe(true);
    // 다시 하면 바뀔 것이 없다
    const ops = [...r.dims].map(([h, x]) => ({ kind: 'modify' as const, block: '*MODEL_SPACE', before: b.doc.entityIndex.get(h)!, after: x as DimensionEntity }));
    b.s.commit({ label: 'DIMREGEN', ops: [...ops, ...r.objects.map((o) => ({ kind: 'object' as const, key: o.key, before: o.before, after: o.after }))] });
    const again = regenAssociations(b.doc, () => b.s.newHandle());
    expect(again.dims.size).toBe(0);
    expect(again.objects.length).toBe(0);
  });
});
