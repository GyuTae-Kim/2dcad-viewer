import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, LwPolylineEntity } from '../../src/core/model';
import { prepareDim } from '../../src/edit/constraint/make';
import { evaluateParams, parseParamExpr, paramNameProblem, replaceName } from '../../src/edit/constraint/params';
import { cloneStore } from '../../src/edit/constraint/store';
import { addConstraints, measureConstraint, removeConstraints, resolveParams } from '../../src/edit/constraint/system';
import type { DimConstraint, DimType } from '../../src/edit/constraint/types';
import { L, apply, arc, circle, line, lwpoly, put, setup, store } from './helpers';
import { lwVertices } from '../../src/core/lwpoly';

const dim = (type: DimType, refs: [string, string][], name: string, expr: string, extra: Partial<DimConstraint> = {}): DimConstraint => ({
  id: 0,
  kind: 'dim',
  type,
  refs: refs.map(([h, part]) => ({ h, part })),
  name,
  expr,
  value: Number(expr) || 0,
  reference: false,
  offset: 0,
  ...extra,
});

const llen = (l: { start: { x: number; y: number }; end: { x: number; y: number } }) => Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y);

function addDim(doc: ReturnType<typeof setup>['doc'], s: ReturnType<typeof setup>['s'], c: DimConstraint, at?: { x: number; y: number } | null, order?: string[]) {
  const p = prepareDim(doc, c, at ?? null);
  const v = Number(c.expr);
  const r = addConstraints(doc, store(doc), [{ ...p, value: Number.isFinite(v) ? v : p.value }], { order: order ?? c.refs.map((x) => x.h) });
  expect(r.message ?? 'ok').toBe('ok');
  apply(doc, s, r);
  return r;
}

describe('치수 구속', () => {
  it('정렬·수평·수직 거리, 첫 점은 그대로', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 30, 40);
    const b = line(h(), 100, 0, 120, 10);
    put(doc, a, b);
    addDim(doc, s, dim('DIST', [[a.handle, 'S'], [a.handle, 'E']], 'd1', '100'));
    expect(llen(L(doc, a.handle))).toBeCloseTo(100, 7);
    expect(L(doc, a.handle).start.x).toBeCloseTo(0, 9);
    // 방향은 그대로(30:40)
    expect(L(doc, a.handle).end.x / L(doc, a.handle).end.y).toBeCloseTo(0.75, 7);
    addDim(doc, s, dim('HDIST', [[b.handle, 'S'], [b.handle, 'E']], 'd2', '50'));
    addDim(doc, s, dim('VDIST', [[b.handle, 'S'], [b.handle, 'E']], 'd3', '25'));
    const B = L(doc, b.handle);
    expect(B.end.x - B.start.x).toBeCloseTo(50, 7);
    expect(B.end.y - B.start.y).toBeCloseTo(25, 7);
  });

  it('점과 선, 두 선(평행으로 만든다)', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 10, 30, 90, 40);
    const c = line(h(), 0, -20, 50, -60);
    put(doc, a, b, c);
    addDim(doc, s, dim('DIST', [[a.handle, ''], [b.handle, '']], 'd1', '20'));
    const B = L(doc, b.handle);
    expect(B.start.y).toBeCloseTo(20, 7);
    expect(B.end.y).toBeCloseTo(20, 7);
    addDim(doc, s, dim('DIST', [[c.handle, 'E'], [a.handle, '']], 'd2', '15'), null, [a.handle, c.handle]);
    expect(L(doc, c.handle).end.y).toBeCloseTo(-15, 7);
  });

  it('각도(선 둘·3점·호)와 반지름·지름', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 0, 0, 50, 60);
    const k = circle(h(), 200, 0, 10);
    const ar = arc(h(), 300, 0, 20, 0, Math.PI / 3);
    put(doc, a, b, k, ar);
    addDim(doc, s, dim('ANGLE', [[a.handle, ''], [b.handle, '']], 'ang1', '30'), { x: 30, y: 5 });
    const B = L(doc, b.handle);
    expect((Math.atan2(B.end.y - B.start.y, B.end.x - B.start.x) * 180) / Math.PI).toBeCloseTo(30, 6);
    expect(L(doc, a.handle).end.y).toBe(0);
    addDim(doc, s, dim('RADIUS', [[k.handle, '']], 'rad1', '25'));
    expect((doc.entityIndex.get(k.handle) as CircleEntity).radius).toBeCloseTo(25, 8);
    addDim(doc, s, dim('DIAMETER', [[ar.handle, '']], 'dia1', '30'));
    expect((doc.entityIndex.get(ar.handle) as ArcEntity).radius).toBeCloseTo(15, 8);
    addDim(doc, s, dim('ANGLE', [[ar.handle, '']], 'ang2', '90'));
    const A = doc.entityIndex.get(ar.handle) as ArcEntity;
    expect((((A.endAngle - A.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo(Math.PI / 2, 7);
  });

  it('3점 각도와 폴리선 호 세그먼트 반지름', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 0, 0, 0, 80);
    const pl = lwpoly(h(), [
      [0, 100],
      [50, 100, 1],
      [100, 100],
    ]);
    put(doc, a, b, pl);
    addDim(doc, s, dim('ANGLE', [[a.handle, 'S'], [a.handle, 'E'], [b.handle, 'E']], 'ang1', '60'), { x: 10, y: 10 });
    const B = L(doc, b.handle);
    expect((Math.atan2(B.end.y, B.end.x) * 180) / Math.PI).toBeCloseTo(60, 6);
    addDim(doc, s, dim('RADIUS', [[pl.handle, 'G1']], 'rad1', '40'));
    const P = doc.entityIndex.get(pl.handle) as LwPolylineEntity;
    const v0 = lwVertices(P)[1]!;
    const v1 = lwVertices(P)[2]!;
    const chord = Math.hypot(v1.x - v0.x, v1.y - v0.y);
    const r = chord / (2 * Math.sin(Math.abs(4 * Math.atan(v0.bulge)) / 2));
    expect(r).toBeCloseTo(40, 6);
  });

  it('식: d2 = d1*2, 매개변수를 바꾸면 다시 푼다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 0, 50, 150, 50);
    put(doc, a, b);
    addDim(doc, s, dim('DIST', [[a.handle, 'S'], [a.handle, 'E']], 'd1', '100'));
    addDim(doc, s, dim('DIST', [[b.handle, 'S'], [b.handle, 'E']], 'd2', '200'));
    const before = store(doc);
    const after = cloneStore(before);
    const d2 = after.constraints.find((c) => c.kind === 'dim' && c.name === 'd2') as DimConstraint;
    d2.expr = 'd1*2';
    const d1 = after.constraints.find((c) => c.kind === 'dim' && c.name === 'd1') as DimConstraint;
    d1.expr = 'width';
    after.userParams.push({ name: 'width', expr: '40+2', value: 0 });
    const r = resolveParams(doc, before, after);
    expect(r.message ?? 'ok').toBe('ok');
    apply(doc, s, r);
    expect(llen(L(doc, a.handle))).toBeCloseTo(42, 7);
    expect(llen(L(doc, b.handle))).toBeCloseTo(84, 7);
    expect((store(doc).constraints.find((c) => c.kind === 'dim' && c.name === 'd2') as DimConstraint).value).toBeCloseTo(84, 9);
    expect(store(doc).userParams[0]!.value).toBeCloseTo(42, 9);
    // 순환 참조는 거절
    const bad = cloneStore(store(doc));
    (bad.constraints.find((c) => c.kind === 'dim' && c.name === 'd1') as DimConstraint).expr = 'd2/2';
    const rb = resolveParams(doc, store(doc), bad);
    expect(rb.ok).toBe(false);
    expect(rb.message).toContain('순환');
  });

  it('참조 구속은 형상을 구동하지 않고 재며, 그 값을 읽는 식은 따라간다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 70, 0);
    const b = line(h(), 0, 50, 150, 50);
    put(doc, a, b);
    addDim(doc, s, dim('DIST', [[a.handle, 'S'], [a.handle, 'E']], 'd1', '70', { reference: true }));
    const r = addConstraints(doc, store(doc), [{ ...prepareDim(doc, dim('DIST', [[b.handle, 'S'], [b.handle, 'E']], 'd2', 'd1+10'), null), value: 80 }], { order: [b.handle] });
    expect(r.ok).toBe(true);
    apply(doc, s, r);
    expect(llen(L(doc, a.handle))).toBeCloseTo(70, 9);
    expect(llen(L(doc, b.handle))).toBeCloseTo(80, 7);
  });

  it('구속을 지우면 그 이름을 읽던 식에 값이 들어간다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 0, 50, 150, 50);
    put(doc, a, b);
    addDim(doc, s, dim('DIST', [[a.handle, 'S'], [a.handle, 'E']], 'd1', '100'));
    const r = addConstraints(doc, store(doc), [{ ...prepareDim(doc, dim('DIST', [[b.handle, 'S'], [b.handle, 'E']], 'd2', 'd1*1.5'), null), value: 150 }], { order: [b.handle] });
    apply(doc, s, r);
    const id = store(doc).constraints.find((c) => c.kind === 'dim' && c.name === 'd1')!.id;
    const st2 = removeConstraints(store(doc), [id]);
    expect((st2.constraints[0] as DimConstraint).expr).toBe('(100)*1.5');
  });

  it('과도한 치수 구속: 두 끝을 고정한 선의 길이', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    put(doc, a);
    const r = addConstraints(doc, store(doc), [
      { id: 0, kind: 'geo', type: 'FIX', refs: [{ h: a.handle, part: 'S' }] },
      { id: 0, kind: 'geo', type: 'FIX', refs: [{ h: a.handle, part: 'E' }] },
    ]);
    apply(doc, s, r);
    const r2 = addConstraints(doc, store(doc), [dim('DIST', [[a.handle, 'S'], [a.handle, 'E']], 'd1', '50')]);
    expect(r2.reason).toBe('overconstrained');
    expect(measureConstraint(doc, dim('DIST', [[a.handle, 'S'], [a.handle, 'E']], 'd1', '0'))).toBeCloseTo(100, 12);
  });
});

describe('매개변수 식', () => {
  it('이름 검사·식 읽기·이름 바꾸기', () => {
    expect(paramNameProblem('d1')).toBeNull();
    expect(paramNameProblem('폭')).toBeNull();
    expect(paramNameProblem('1a')).not.toBeNull();
    expect(paramNameProblem('sin')).not.toBeNull();
    expect(paramNameProblem('pi')).not.toBeNull();
    expect(parseParamExpr('d1*2 + width/3 - pi').names.sort()).toEqual(['d1', 'width']);
    expect(() => parseParamExpr('end + 1')).toThrow();
    expect(() => parseParamExpr('d1 +')).toThrow();
    expect(replaceName('d1*2+D1/d10+2e1', 'd1', 'len')).toBe('len*2+len/d10+2e1');
  });

  it('의존 순서로 계산하고 오류를 알린다', () => {
    const ev = evaluateParams([
      { name: 'b', expr: 'a*2', reference: false },
      { name: 'a', expr: 'sqrt(16)+cos(60)', reference: false },
      { name: 'c', expr: 'nope+1', reference: false },
      { name: 'r', expr: '', reference: true, measured: 7 },
      { name: 'q', expr: 'r*2', reference: false },
    ]);
    expect(ev.values.get('a')).toBeCloseTo(4.5, 12);
    expect(ev.values.get('b')).toBeCloseTo(9, 12);
    expect(ev.values.get('q')).toBe(14);
    expect(ev.errors.get('c')).toContain('nope');
  });
});
