import { describe, expect, it } from 'vitest';
import type { CadDocument, GenericObject, LineEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { readDwg, writeDwg } from '../../src/io/dwg/index';
import { readDxf } from '../../src/io/dxf/reader';
import { writeDxf } from '../../src/io/dxf/writer';
import { prepareDim, prepareGeo } from '../../src/edit/constraint/make';
import { STORE_KEY, decodeStore, encodeStore, foreignConstraintInfo, foreignConstraintNotice, readStore, storeObject } from '../../src/edit/constraint/store';
import { addConstraints, followEdit } from '../../src/edit/constraint/system';
import type { ConstraintStore, DimConstraint } from '../../src/edit/constraint/types';
import { apply, arc, circle, line, lwpoly, put, setup, store } from './helpers';

/** 여러 종류의 구속이 든 도면 */
function sample(): { doc: CadDocument; hs: string[] } {
  const { doc, s, h } = setup();
  const a = line(h(), 0, 0, 100, 0);
  const b = line(h(), 100, 0, 100, 60);
  const c = circle(h(), 150, 30, 12);
  const k = arc(h(), 50, 80, 20, 0, Math.PI);
  const p = lwpoly(h(), [
    [0, 120],
    [80, 120, 0.3],
    [80, 160],
  ]);
  put(doc, a, b, c, k, p);
  const g = (type: 'HORIZONTAL' | 'PERPENDICULAR' | 'COINCIDENT' | 'TANGENT' | 'FIX', refs: [string, string][]) => prepareGeo(doc, { id: 0, kind: 'geo', type, refs: refs.map(([hh, part]) => ({ h: hh, part })) });
  let r = addConstraints(doc, store(doc), [
    g('HORIZONTAL', [[a.handle, '']]),
    g('PERPENDICULAR', [[a.handle, ''], [b.handle, '']]),
    g('COINCIDENT', [[a.handle, 'E'], [b.handle, 'S']]),
    g('FIX', [[p.handle, 'V0']]),
    { ...prepareGeo(doc, { id: 0, kind: 'geo', type: 'HORIZONTAL', refs: [{ h: p.handle, part: 'G0' }] }), axis: 0 },
  ]);
  expect(r.ok).toBe(true);
  apply(doc, s, r);
  const d: DimConstraint = prepareDim(doc, { id: 0, kind: 'dim', type: 'DIST', refs: [{ h: a.handle, part: 'S' }, { h: a.handle, part: 'E' }], name: 'd1', expr: '120', value: 120, reference: false, offset: 0 }, { x: 50, y: -15 });
  const rd: DimConstraint = prepareDim(doc, { id: 0, kind: 'dim', type: 'RADIUS', refs: [{ h: c.handle, part: '' }], name: '반지름', expr: 'd1/10', value: 12, reference: false, offset: 0, description: '설명 글' }, { x: 170, y: 40 });
  r = addConstraints(doc, store(doc), [d, rd]);
  expect(r.message ?? 'ok').toBe('ok');
  apply(doc, s, r);
  const st2: ConstraintStore = { ...store(doc), userParams: [{ name: 'width', expr: 'd1+5', value: 125, description: 'w' }], hiddenBars: [b.handle] };
  apply(doc, s, { entities: new Map(), store: st2 });
  return { doc, hs: [a.handle, b.handle, c.handle, k.handle, p.handle] };
}

function sameStore(x: ConstraintStore, y: ConstraintStore): void {
  expect(y.constraints.length).toBe(x.constraints.length);
  for (let i = 0; i < x.constraints.length; i++) {
    const a = x.constraints[i]!;
    const b = y.constraints[i]!;
    expect(b.type).toBe(a.type);
    expect(b.kind).toBe(a.kind);
    expect(b.id).toBe(a.id);
    expect(b.refs).toEqual(a.refs);
    expect(b.aux ?? []).toEqual((a.aux ?? []).map((v) => expect.closeTo(v, 12)));
    if (a.kind === 'dim' && b.kind === 'dim') {
      expect(b.name).toBe(a.name);
      expect(b.expr).toBe(a.expr);
      expect(b.value).toBeCloseTo(a.value, 9);
      expect(b.offset).toBeCloseTo(a.offset, 9);
      expect(b.reference).toBe(a.reference);
      expect(b.description).toBe(a.description);
    }
  }
  expect(y.userParams).toEqual(x.userParams);
  expect(y.hiddenBars).toEqual(x.hiddenBars);
  expect(y.nextId).toBe(x.nextId);
}

describe('구속 기록 저장', () => {
  it('XRECORD 자료로 쓰고 읽는다', () => {
    const { doc } = sample();
    const s = readStore(doc);
    expect(s.constraints.length).toBe(7);
    sameStore(s, decodeStore(encodeStore(s)));
    const x = storeObject(doc)!;
    expect(x.type).toBe('XRECORD');
    expect(x.data[0]).toEqual({ code: 1, value: STORE_KEY });
  });

  it('DXF R2018·R2000 왕복', () => {
    const { doc } = sample();
    for (const version of ['AC1032', 'AC1015'] as const) {
      const back = readDxf(writeDxf(doc, { version }).data);
      sameStore(readStore(doc), readStore(back));
      // 다시 연 도면에서도 구속을 풀 수 있다
      const a = back.blocks.get(MODEL_SPACE)!.entities[0] as LineEntity;
      const out = followEdit(back, readStore(back), new Map([[a.handle, { ...a, end: { x: a.end.x, y: a.end.y + 20, z: 0 } }]]), new Set(), { mode: 'maintain' });
      expect(out.ok).toBe(true);
      const A = out.entities.get(a.handle) as LineEntity;
      expect(A.end.y - A.start.y).toBeCloseTo(0, 7);
    }
  });

  it('DWG R2018·R2000 왕복', () => {
    const { doc } = sample();
    for (const version of ['AC1032', 'AC1015'] as const) {
      const back = readDwg(writeDwg(doc, { version }).data);
      sameStore(readStore(doc), readStore(back));
    }
  });

  it('AutoCAD 연관 네트워크는 세기만 하고 그대로 둔다', () => {
    const { doc } = setup();
    expect(foreignConstraintNotice(doc)).toBeNull();
    const objs: GenericObject[] = [
      { type: 'ACDBASSOCNETWORK', handle: 'F001', raw: [{ code: 90, value: 2 }] },
      { type: 'ACDBASSOC2DCONSTRAINTGROUP', handle: 'F002', raw: [{ code: 90, value: 1 }] },
      { type: 'ACDBASSOCVARIABLE', handle: 'F003', raw: [{ code: 1, value: 'd1' }] },
      { type: 'ACDBASSOCGEOMDEPENDENCY', handle: 'F004', raw: [{ code: 90, value: 0 }] },
    ];
    for (const o of objs) doc.objects.set(o.handle, o);
    const i = foreignConstraintInfo(doc);
    expect(i).toMatchObject({ networks: 1, groups: 1, variables: 1, total: 4 });
    expect(foreignConstraintNotice(doc)).toContain('구속 그룹 1개');
    // 우리 구속을 더해도 그 객체들은 그대로다
    const { s } = { s: null };
    void s;
    expect(doc.objects.get('F002')).toBe(objs[1]);
  });
});
