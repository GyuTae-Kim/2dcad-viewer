/**
 * AutoCAD 연관 배열 기록: 원본 태그 해석(판 1·2, 직사각형·원형·경로), 고쳐 쓰기(값 매개변수·점 매개변수·항목 목록·끝 행렬),
 * DXF 저장 뒤 다시 읽기, 원본 태그가 없는 배열(DWG)의 짐작.
 */
import { describe, expect, it } from 'vitest';
import type { GenericObject, InsertEntity, RawTag } from '../../src/core/model';
import { tableKey } from '../../src/core/model';
import { readCurve } from '../../src/edit/assocarray/acad';
import { regenerateOps } from '../../src/edit/assocarray/build';
import { readArray } from '../../src/edit/assocarray/read';
import { cloneState, type PathParams, type PolarParams, type RectParams } from '../../src/edit/assocarray/types';
import { allocBlockName } from '../../src/edit/geom/types';
import { EditSession } from '../../src/edit/session';
import { readCadFile } from '../../src/io';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg';
import { type Bench, bench, pathFixture, polarFixture, rectFixture, stripRaw } from './fixture';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
const env = (b: Bench) => ({ doc: b.doc, newHandle: () => b.s.newHandle(), newBlockName: () => allocBlockName(b.doc, '*U') });

function rawOf(b: { doc: Bench['doc'] }, h: string): RawTag[] {
  return (b.doc.objects.get(h) as GenericObject).raw ?? [];
}

/** 원본 태그에서 값 매개변수 하나 */
function value(raw: readonly RawTag[], name: string): number | undefined {
  const i = raw.findIndex((t, k) => t.code === 1 && t.value === name && raw[k + 1]?.code === 90);
  return i >= 0 ? Number(raw[i + 3]!.value) : undefined;
}

function itemCountOf(raw: readonly RawTag[]): number {
  return raw.filter((t) => t.code === 100 && t.value === 'AcDbAssocArrayItem').length;
}

function roundTrip(doc: Bench['doc']) {
  return readCadFile(writeDxf(doc, { version: 'AC1032' }).data, 'x.dxf');
}

describe('AutoCAD 연관 배열 읽기', () => {
  it('직사각형(판 1, 값 매개변수가 몸체에)', () => {
    const b = bench();
    const a = rectFixture(b);
    const info = readArray(b.doc, a.ins)!;
    expect(info).not.toBeNull();
    expect(info.origin).toBe('acad');
    const p = info.state.params as RectParams;
    expect(p.kind).toBe('rect');
    expect([p.columns, p.rows, p.columnSpacing, p.rowSpacing]).toEqual([4, 2, 10, 5]);
    close(p.axesAngle, Math.PI / 2);
    expect(info.state.source).toBe(a.source);
    expect(info.items.size).toBe(8);
    expect(info.state.removed.size).toBe(0);
  });

  it('원형(항목 회전은 항목 행렬로)', () => {
    const b = bench();
    const a = polarFixture(b);
    const info = readArray(b.doc, a.ins)!;
    const p = info.state.params as PolarParams;
    expect(p.kind).toBe('polar');
    expect(p.items).toBe(6);
    expect(p.rotateItems).toBe(true);
    close(p.radius, 8);
    close(p.startAngle, Math.PI / 2);
    expect(p.center).toEqual({ x: 20, y: 30 });
  });

  it('경로(판 2, 값 매개변수가 동작에, 곡선 캐시 = 선분 + 호 + 선분, 대칭한 배열도)', () => {
    const b = bench();
    const a = pathFixture(b);
    const info = readArray(b.doc, a.ins)!;
    expect(info).not.toBeNull();
    const p = info.state.params as PathParams;
    expect(p.method).toBe('divide');
    expect(p.items).toBe(5);
    expect(p.align).toBe(true);
    expect(p.reverse).toBe(false);
    expect(p.path).toBeNull();
    expect(p.fallback?.map((c) => c.k)).toEqual(['line', 'arc', 'line']);
    // 곡선 캐시는 배열 블록 좌표: 배열을 대칭(X 축척 −1)해 옮겨도 항목이 맞는다
    const b2 = bench();
    const m = pathFixture(b2, [50, 0, 0, -1]);
    expect(readArray(b2.doc, m.ins)?.items.size).toBe(5);
  });

  it('곡선 캐시: 시계 방향 호, NURBS', () => {
    const T = (code: number, value: number): RawTag => ({ code, value });
    const arc = readCurve([T(90, 11), T(10, 0), T(20, 0), T(30, 0), T(10, 0), T(20, 0), T(30, -1), T(10, 1), T(20, 0), T(30, 0), T(40, 2), T(40, 0), T(40, Math.PI / 2), T(40, 0)], 0)!;
    const pc = arc.pieces[0]!;
    expect(pc.k).toBe('arc');
    if (pc.k === 'arc') {
      close(pc.a0, 0);
      close(pc.sw, -Math.PI / 2);
    }
    const nurbs = readCurve(
      [T(90, 42), T(70, 0), T(70, 0), T(90, 2), T(40, 1e-9), T(90, 6), T(90, 6), T(90, 8), ...[0, 0, 0, 1, 1, 1].map((v) => T(40, v)), T(90, 0), T(90, 0), T(90, 8), T(90, 3), T(90, 3), T(90, 8), T(10, 0), T(20, 0), T(30, 0), T(10, 1), T(20, 1), T(30, 0), T(10, 2), T(20, 0), T(30, 0)],
      0,
    )!;
    expect(nurbs.pieces[0]).toEqual({ k: 'nurbs', degree: 2, knots: [0, 0, 0, 1, 1, 1], ctrl: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] });
    expect(readCurve([T(90, 99)], 0)).toBeNull();
  });

  it('항목이 기록과 맞지 않으면 배열로 읽지 않는다', () => {
    const b = bench();
    const a = rectFixture(b);
    const def = b.doc.blocks.get(tableKey(a.array))!;
    const moved = { ...(def.entities[3] as InsertEntity), insert: { x: 99, y: 99, z: 0 } };
    b.s.commit({ label: 'T', ops: [{ kind: 'modify', block: tableKey(a.array), before: def.entities[3]!, after: moved }] });
    expect(readArray(b.doc, a.ins)).toBeNull();
  });
});

describe('AutoCAD 연관 배열 고쳐 쓰기', () => {
  it('열 수를 바꾸면 배열 블록·값 매개변수·항목 목록이 함께 바뀌고 블록 레코드는 그대로', () => {
    const b = bench();
    const a = rectFixture(b);
    const info = readArray(b.doc, a.ins)!;
    const next = cloneState(info.state);
    next.params = { ...(next.params as RectParams), columns: 5, columnSpacing: 12 };
    const r = regenerateOps(env(b), info, next);
    if ('error' in r) throw new Error(r.error);
    b.s.commit({ label: 'ARRAYEDIT', ops: r.ops });
    const ins = b.doc.entityIndex.get(a.ins.handle) as InsertEntity;
    expect(ins.block).toBe(a.array);
    expect(b.doc.blocks.get(tableKey(a.array))!.entities.length).toBe(10);
    const body = rawOf(b, a.body);
    expect(value(body, 'Items')).toBe(5);
    expect(value(body, 'ItemSpacing')).toBe(12);
    expect(itemCountOf(body)).toBe(10);
    // 항목 목록의 330은 배열 블록 안 참조
    const handles = new Set(b.doc.blocks.get(tableKey(a.array))!.entities.map((e) => e.handle));
    const refs = body.filter((t, i) => t.code === 330 && body[i - 1]?.code !== 330 && i > body.findIndex((x) => x.value === 'AcDbAssocArrayItem'));
    expect(refs.every((t) => handles.has(String(t.value)))).toBe(true);
    // 남은 항목은 핸들을 유지한다
    for (const [k, h] of info.items) if (Number(k.split(',')[0]) < 4) expect(handles.has(h)).toBe(true);
    // 다시 읽으면 같은 값(이 앱 기록도 남는다)
    const again = readArray(b.doc, ins)!;
    expect(again.origin).toBe('acad');
    expect((again.state.params as RectParams).columns).toBe(5);
    expect(ins.xdata?.some((x) => x.app === 'OPENCAD_ARRAY')).toBe(true);
    // 명령 취소
    b.s.undo();
    expect(value(rawOf(b, a.body), 'Items')).toBe(4);
    expect(readArray(b.doc, b.doc.entityIndex.get(a.ins.handle))!.items.size).toBe(8);
  });

  it('항목 지우기·원형 중심 옮기기(점 매개변수)', () => {
    const b = bench();
    const a = polarFixture(b);
    const info = readArray(b.doc, a.ins)!;
    const next = cloneState(info.state);
    next.removed.add('2,0,0');
    next.params = { ...(next.params as PolarParams), center: { x: 21, y: 30 } };
    const r = regenerateOps(env(b), info, next);
    if ('error' in r) throw new Error(r.error);
    b.s.commit({ label: 'ARRAYEDIT', ops: r.ops });
    expect(itemCountOf(rawOf(b, a.body))).toBe(5);
    const origin = [...b.doc.objects.values()].find((o) => o.type === 'ACDBASSOCVERTEXACTIONPARAM' && (o as GenericObject).raw?.some((t) => t.value === 'Origin')) as GenericObject;
    expect(origin.raw!.find((t) => t.code === 10)!.value).toBe(21);
    const again = readArray(b.doc, b.doc.entityIndex.get(a.ins.handle))!;
    expect([...again.state.removed]).toEqual(['2,0,0']);
    expect((again.state.params as PolarParams).center.x).toBe(21);
  });

  it('DXF로 저장하고 다시 읽어도 AutoCAD 배열로 읽고, 고친 뒤에도 그렇다', () => {
    const b = bench();
    const a = rectFixture(b);
    const p = pathFixture(b);
    let doc = roundTrip(b.doc);
    const info = readArray(doc, doc.entityIndex.get(a.ins.handle))!;
    expect(info.origin).toBe('acad');
    expect(readArray(doc, doc.entityIndex.get(p.ins.handle))!.origin).toBe('acad');
    // 경로 배열 항목 수 바꾸기(등분할 간격도 다시 계산해 쓴다)
    const s: Bench = { doc, s: new EditSession(doc, () => {}) };
    const pinfo = readArray(doc, doc.entityIndex.get(p.ins.handle))!;
    const next = cloneState(pinfo.state);
    next.params = { ...(next.params as PathParams), items: 7 };
    const r = regenerateOps(env(s), pinfo, next);
    if ('error' in r) throw new Error(r.error);
    s.s.commit({ label: 'ARRAYEDIT', ops: r.ops });
    const action = rawOf(s, p.action);
    expect(value(action, 'Items')).toBe(7);
    close(value(action, 'ItemSpacing')!, (20 + 5 * Math.PI) / 6, 1e-9);
    doc = roundTrip(s.doc);
    const back = readArray(doc, doc.entityIndex.get(p.ins.handle))!;
    expect(back.origin).toBe('acad');
    expect((back.state.params as PathParams).items).toBe(7);
    expect(back.items.size).toBe(7);
  });

  it('DWG로 저장하면 AutoCAD 기록 대신 이 앱 기록으로 배열이 남는다(고친 배열)', () => {
    const b = bench();
    const a = rectFixture(b);
    const info = readArray(b.doc, a.ins)!;
    const next = cloneState(info.state);
    next.params = { ...(next.params as RectParams), rows: 3 };
    const r = regenerateOps(env(b), info, next);
    if ('error' in r) throw new Error(r.error);
    b.s.commit({ label: 'ARRAYEDIT', ops: r.ops });
    const out = writeDwg(b.doc, { version: 'AC1032' });
    const doc = readCadFile(out.data, 'x.dwg');
    const back = readArray(doc, doc.entityIndex.get(a.ins.handle))!;
    expect(back).not.toBeNull();
    expect((back.state.params as RectParams).rows).toBe(3);
    expect(back.items.size).toBe(12);
  });
});

describe('원본 태그가 없는 AutoCAD 배열(DWG) — 항목 배치에서 짐작', () => {
  it('직사각형·원형', () => {
    const b = bench();
    const r = rectFixture(b);
    const p = polarFixture(b);
    stripRaw(b.doc);
    const ri = readArray(b.doc, r.ins)!;
    expect(ri.origin).toBe('infer');
    const rp = ri.state.params as RectParams;
    expect([rp.columns, rp.rows, rp.columnSpacing, rp.rowSpacing]).toEqual([4, 2, 10, 5]);
    const pi = readArray(b.doc, p.ins)!;
    expect(pi.origin).toBe('infer');
    const pp = pi.state.params as PolarParams;
    expect(pp.items).toBe(6);
    expect(pp.rotateItems).toBe(true);
    close(pp.radius, 8, 1e-6);
    close(pp.center.x, 20, 1e-6);
    close(pp.fillAngle, 2 * Math.PI, 1e-6);
  });

  it('지운 항목이 있는 직사각형도 짐작한다', () => {
    const b = bench();
    const a = rectFixture(b);
    stripRaw(b.doc);
    const def = b.doc.blocks.get(tableKey(a.array))!;
    b.s.commit({ label: 'T', ops: [{ kind: 'remove', block: tableKey(a.array), entity: def.entities[3]!, index: 3 }] });
    const info = readArray(b.doc, a.ins)!;
    expect(info.origin).toBe('infer');
    expect(info.state.removed.size).toBe(1);
    expect(info.items.size).toBe(7);
  });
});
