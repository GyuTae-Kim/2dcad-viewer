import { describe, expect, it } from 'vitest';
import type { CircleEntity, Entity, LineEntity } from '../../src/core/model';
import { affRotate, affTranslate } from '../../src/edit/geom/math';
import { transformEntity } from '../../src/edit/geom';
import { prepareGeo } from '../../src/edit/constraint/make';
import { readStore } from '../../src/edit/constraint/store';
import { addConstraints, followEdit } from '../../src/edit/constraint/system';
import type { Constraint, GeoType } from '../../src/edit/constraint/types';
import { afterEditSolve, constraintEditHook } from '../../src/app/constraints-hook';
import type { DocState } from '../../src/app/docstate';
import { L, apply, circle, line, put, setup, store } from './helpers';

const geo = (type: GeoType, refs: [string, string][], extra: Partial<Constraint> = {}): Constraint => ({ id: 0, kind: 'geo', type, refs: refs.map(([h, part]) => ({ h, part })), ...extra }) as Constraint;

function constrain(doc: ReturnType<typeof setup>['doc'], s: ReturnType<typeof setup>['s'], cs: Constraint[]) {
  const r = addConstraints(
    doc,
    store(doc),
    cs.map((c) => (c.kind === 'geo' ? prepareGeo(doc, c) : c)),
  );
  expect(r.message ?? 'ok').toBe('ok');
  apply(doc, s, r);
}

const moved = (e: Entity, dx: number, dy: number, doc: ReturnType<typeof setup>['doc']) => transformEntity(e, affTranslate(dx, dy), doc).replace![0]!;

describe('편집 뒤 다시 풀기', () => {
  it('이동: 일치로 이어진 선이 따라온다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 100, 0, 150, 50);
    put(doc, a, b);
    constrain(doc, s, [geo('COINCIDENT', [[a.handle, 'E'], [b.handle, 'S']]), geo('HORIZONTAL', [[a.handle, '']])]);
    const na = moved(doc.entityIndex.get(a.handle)!, 10, 20, doc);
    const out = followEdit(doc, readStore(doc), new Map([[a.handle, na]]), new Set(), { mode: 'maintain' });
    expect(out.ok).toBe(true);
    // 옮긴 선은 그대로, b의 시작점만 따라온다(끝점은 제자리)
    expect(out.entities.has(a.handle)).toBe(false);
    const B = out.entities.get(b.handle) as LineEntity;
    expect(B.start.x).toBeCloseTo(110, 8);
    expect(B.start.y).toBeCloseTo(20, 8);
    expect(B.end.x).toBeCloseTo(150, 6);
    expect(B.end.y).toBeCloseTo(50, 6);
  });

  it('회전: 수평 구속이 있으면 편집한 객체도 구속에 맞게 조정된다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    put(doc, a);
    constrain(doc, s, [geo('HORIZONTAL', [[a.handle, '']])]);
    const na = transformEntity(doc.entityIndex.get(a.handle)!, affRotate(0.3, { x: 0, y: 0 }), doc).replace![0]!;
    const out = followEdit(doc, readStore(doc), new Map([[a.handle, na]]), new Set(), { mode: 'maintain' });
    expect(out.ok).toBe(true);
    const A = out.entities.get(a.handle) as LineEntity;
    expect(A.end.y - A.start.y).toBeCloseTo(0, 8);
  });

  it('지킬 수 없는 편집은 거절, 완화 편집은 깨진 구속만 지운다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = circle(h(), 100, 10, 10);
    put(doc, a, b);
    constrain(doc, s, [
      geo('FIX', [[b.handle, '']]),
      geo('FIX', [[a.handle, 'S']]),
      geo('COINCIDENT', [[a.handle, 'E'], [b.handle, '']]),
      { id: 0, kind: 'dim', type: 'DIST', refs: [{ h: a.handle, part: 'S' }, { h: a.handle, part: 'E' }], name: 'd1', expr: '100', value: 100, reference: false, offset: 0 },
    ]);
    // 끝점 그립을 옮기면 구속이 끝점을 구속에 맞는 자리로 돌린다(편집 객체도 조정된다)
    const grip = { ...doc.entityIndex.get(a.handle)!, end: { x: 90, y: 30, z: 0 } } as LineEntity;
    const g = followEdit(doc, readStore(doc), new Map([[a.handle, grip]]), new Set(), { mode: 'maintain' });
    expect(g.ok).toBe(true);
    const A = g.entities.get(a.handle) as LineEntity;
    expect(Math.hypot(A.end.x, A.end.y)).toBeCloseTo(100, 7);
    expect(Math.hypot(A.end.x - 100, A.end.y - 10)).toBeCloseTo(10, 7);
    // 선 전체를 옮기면 고정한 시작점이 새 자리에 묶이고 길이 100으로는 원에 닿을 수 없다
    const na = moved(doc.entityIndex.get(a.handle)!, 300, 0, doc);
    const out = followEdit(doc, readStore(doc), new Map([[a.handle, na]]), new Set(), { mode: 'maintain' });
    expect(out.ok).toBe(false);
    expect(out.message).toBe('구속조건을 유지하면서 객체를 편집할 수 없습니다.');
    const relax = followEdit(doc, readStore(doc), new Map([[a.handle, na]]), new Set(), { mode: 'relax' });
    expect(relax.ok).toBe(true);
    expect(relax.removed).toBe(1);
    expect(relax.store!.constraints.map((c) => c.type).sort()).toEqual(['DIST', 'FIX', 'FIX']);
  });

  it('지운 객체의 구속은 지운다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const c = circle(h(), 50, 20, 20);
    put(doc, a, c);
    constrain(doc, s, [geo('TANGENT', [[a.handle, ''], [c.handle, '']])]);
    const out = followEdit(doc, readStore(doc), new Map(), new Set([c.handle]), { mode: 'relax' });
    expect(out.store!.constraints).toHaveLength(0);
    expect(out.removed).toBe(1);
  });

  it('훅: commitResults용 결과에 따라오는 객체를 더하고, 편집 작업용은 after를 바꾼다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 100, 0, 150, 50);
    const k = circle(h(), 300, 0, 10);
    const k2 = circle(h(), 340, 0, 15);
    put(doc, a, b, k, k2);
    constrain(doc, s, [geo('COINCIDENT', [[a.handle, 'E'], [b.handle, 'S']]), geo('EQUAL', [[k.handle, ''], [k2.handle, '']])]);
    const st = { doc, session: s } as unknown as DocState;
    const na = moved(doc.entityIndex.get(a.handle)!, 0, 10, doc);
    const res = constraintEditHook(st, [{ replace: [na] }], 'MOVE');
    expect(res.ok).toBe(true);
    const all = res.results.flatMap((r) => r.replace ?? []);
    expect(all.map((e) => e.handle).sort()).toEqual([a.handle, b.handle].sort());
    expect((all.find((e) => e.handle === b.handle) as LineEntity).start.y).toBeCloseTo(10, 8);
    // 특성 팔레트처럼 반지름을 바꾸면 같은 원도 따라간다
    const nk = { ...doc.entityIndex.get(k.handle)!, radius: 25 } as CircleEntity;
    const ops: import('../../src/edit/session').EditOp[] = [{ kind: 'modify', block: s.ownerOf(k.handle)!, before: doc.entityIndex.get(k.handle)!, after: nk }];
    const r2 = afterEditSolve(st, ops, 'PROPERTIES');
    expect(r2.ok).toBe(true);
    s.commit({ label: 'PROPERTIES', ops: [...ops, ...r2.extra] });
    expect((doc.entityIndex.get(k2.handle) as CircleEntity).radius).toBeCloseTo(25, 8);
    expect((doc.entityIndex.get(k.handle) as CircleEntity).radius).toBe(25);
    // 구속 명령 자신의 편집과 구속이 없는 결과는 그대로
    expect(constraintEditHook(st, [{ replace: [na] }], 'GCPARALLEL').results).toEqual([{ replace: [na] }]);
    // 지우기는 구속 기록을 고치는 작업을 낸다
    const r3 = afterEditSolve(st, [{ kind: 'remove', block: s.ownerOf(b.handle)!, entity: doc.entityIndex.get(b.handle)!, index: 1 }], 'ERASE');
    expect(r3.extra.some((o) => o.kind === 'object')).toBe(true);
    expect(r3.message).toBe('구속조건 1개를 제거했습니다.');
  });

  it('명령 취소하면 구속도 돌아간다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 10);
    put(doc, a);
    constrain(doc, s, [geo('HORIZONTAL', [[a.handle, '']])]);
    expect(store(doc).constraints).toHaveLength(1);
    expect(L(doc, a.handle).end.y).toBeCloseTo(L(doc, a.handle).start.y, 8);
    s.undo();
    expect(store(doc).constraints).toHaveLength(0);
    expect(L(doc, a.handle).end.y).toBe(10);
    s.redo();
    expect(store(doc).constraints).toHaveLength(1);
  });
});

describe('호와 OCS', () => {
  it('선–호 접선 + 끝점 일치: 선을 옮기면 호가 접한 채 따라온다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 100, 0);
    const k = { ...circle(h(), 100, 30, 30), type: 'ARC', startAngle: -Math.PI / 2, endAngle: Math.PI / 2 } as unknown as Entity;
    put(doc, a, k);
    constrain(doc, s, [geo('COINCIDENT', [[a.handle, 'E'], [k.handle, 'S']]), geo('TANGENT', [[a.handle, ''], [k.handle, '']])]);
    const na = moved(doc.entityIndex.get(a.handle)!, 0, 10, doc);
    const out = followEdit(doc, readStore(doc), new Map([[a.handle, na]]), new Set(), { mode: 'maintain' });
    expect(out.ok).toBe(true);
    const K = out.entities.get(k.handle) as unknown as { center: { x: number; y: number }; radius: number; startAngle: number };
    const sx = K.center.x + K.radius * Math.cos(K.startAngle);
    const sy = K.center.y + K.radius * Math.sin(K.startAngle);
    expect(sx).toBeCloseTo(100, 7);
    expect(sy).toBeCloseTo(10, 7);
    // 접선: 중심에서 선까지 거리 = 반지름
    expect(Math.abs(K.center.y - 10)).toBeCloseTo(K.radius, 7);
  });

  it('OCS가 (0,0,−1)인 호는 같은 모양의 자연 OCS 호로 되쓴다', () => {
    const { doc, s, h } = setup();
    // OCS 중심 (−100, 0) → WCS (100, 0), OCS 0°~90° → WCS 90°~180°
    const k = { ...circle(h(), -100, 0, 20), type: 'ARC', startAngle: 0, endAngle: Math.PI / 2, extrusion: { x: 0, y: 0, z: -1 } } as unknown as Entity;
    const a = line(h(), 0, 50, 60, 90);
    put(doc, k, a);
    // 호 끝점(WCS 시작 = (100, 20))에 선 시작을 붙인다
    constrain(doc, s, [geo('COINCIDENT', [[k.handle, 'S'], [a.handle, 'S']])]);
    // 호는 움직이지 않았고(앞에 고른 객체), 선 시작이 (100, 20)으로
    expect(L(doc, a.handle).start.x).toBeCloseTo(100, 7);
    expect(L(doc, a.handle).start.y).toBeCloseTo(20, 7);
    const na = moved(doc.entityIndex.get(a.handle)!, 5, 0, doc);
    const out = followEdit(doc, readStore(doc), new Map([[a.handle, na]]), new Set(), { mode: 'maintain' });
    const K = out.entities.get(k.handle) as unknown as { center: { x: number; y: number }; radius: number; startAngle: number; endAngle: number; extrusion?: unknown };
    expect(K.extrusion).toBeUndefined();
    // WCS 호의 시작점(반시계 시작)이 옮긴 선 시작 (105, 20)
    expect(K.center.x + K.radius * Math.cos(K.startAngle)).toBeCloseTo(105, 7);
    expect(K.center.y + K.radius * Math.sin(K.startAngle)).toBeCloseTo(20, 7);
    expect((((K.endAngle - K.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeLessThan(Math.PI);
  });
});
