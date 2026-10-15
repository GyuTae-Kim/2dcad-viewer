/**
 * 이 앱에서 만든 구속을 AutoCAD 2D 구속 그룹으로 쓰기(src/edit/assocnet/cwrite.ts): 새 망·그룹, 있는 그룹에 덧붙이기,
 * 다시 읽으면 'acad' 구속으로 같은 내용, DXF·DWG 저장 뒤 왕복, 쓸 수 없는 종류는 이 앱 기록, ezdxf 감사.
 * 자료는 이 시험이 만든 것이다(공개 도면 파일을 쓰지 않는다).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument, DimensionEntity, Entity, GenericObject } from '../../src/core/model';
import { MODEL_SPACE, normalizeHandle } from '../../src/core/model';
import { type CNode, parseGroupRest } from '../../src/edit/assocnet/cgroup';
import { acadClassFor } from '../../src/edit/assocnet/cwrite';
import { importAcadConstraints } from '../../src/edit/assocnet/constraints';
import { rootNetwork } from '../../src/edit/assocnet/network';
import { parseAssocObject } from '../../src/edit/assocnet/objects';
import { prepareDim, prepareGeo } from '../../src/edit/constraint/make';
import { readAppStore, readStore, storeOps } from '../../src/edit/constraint/store';
import { addConstraints, isSatisfied, removeConstraints, resolveParams } from '../../src/edit/constraint/system';
import type { Constraint, DimConstraint, GeoConstraint, GeoRef } from '../../src/edit/constraint/types';
import { acadCommitOps } from '../../src/edit/assocnet/writeback';
import { readCadFile } from '../../src/io';
import { writeDwg } from '../../src/io/dwg';
import { writeDxf } from '../../src/io/dxf/writer';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { apply, arc, circle, line, lwpoly, put, setup } from '../constraint/helpers';
import { constraintDoc } from './fixture';

const ROOT = join(__dirname, '../..');
const OUT = join(ROOT, '.runtime/assoc2/test-out');

const R = (h: string, part = ''): GeoRef => ({ h, part });
const geo = (doc: CadDocument, type: GeoConstraint['type'], refs: GeoRef[], extra: Partial<GeoConstraint> = {}): GeoConstraint => prepareGeo(doc, { id: 0, kind: 'geo', type, refs, ...extra });
const dim = (doc: CadDocument, type: DimConstraint['type'], refs: GeoRef[], name: string, expr: string, at: { x: number; y: number }, extra: Partial<DimConstraint> = {}): DimConstraint =>
  prepareDim(doc, { id: 0, kind: 'dim', type, refs, name, expr, value: Number(expr), reference: false, offset: 0, ...extra }, at);

function obj(doc: CadDocument, h: string) {
  const o = doc.objects.get(normalizeHandle(h)) as GenericObject;
  return { o, d: parseAssocObject(o.type, o.raw!)! };
}

function groups(doc: CadDocument) {
  return [...doc.objects.values()].filter((o) => o.type === 'ACDBASSOC2DCONSTRAINTGROUP').map((o) => {
    const d = parseAssocObject(o.type, (o as GenericObject).raw!)!;
    if (d.kind !== 'cgroup') throw new Error('그룹');
    return { o: o as GenericObject, head: d.head, g: parseGroupRest(d.head.version, d.rest) };
  });
}

/** 비교용: 구속의 뜻(번호·연결 제외) */
function meaning(c: Constraint) {
  const base = { kind: c.kind, type: c.type, refs: c.refs };
  if (c.kind === 'geo') return { ...base, axis: c.axis ?? 0 };
  return { ...base, name: c.name, expr: c.expr, value: expect.closeTo(c.value, 9), reference: c.reference, axis: expect.closeTo(c.axis ?? 0, 9), offset: expect.closeTo(c.offset, 6), description: c.description };
}

/** 선 셋·원·호에 구속 여러 개를 만든 도면 */
function sample() {
  const t = setup();
  const { doc, s, h } = t;
  const a = line(h(), 0, 0, 100, 0);
  const b = line(h(), 100, 0, 100, 60);
  const c = circle(h(), 150, 30, 12);
  const k = arc(h(), 50, 80, 20, 0, Math.PI);
  const d = circle(h(), 220, 30, 15);
  const e = line(h(), 0, 60, 40, 90);
  const f = line(h(), 250, 0, 260, 50);
  put(doc, a, b, c, k, d, e, f);
  const cs: Constraint[] = [
    geo(doc, 'HORIZONTAL', [R(a.handle)]),
    geo(doc, 'PERPENDICULAR', [R(a.handle), R(b.handle)]),
    geo(doc, 'COINCIDENT', [R(a.handle, 'E'), R(b.handle, 'S')]),
    geo(doc, 'COINCIDENT', [R(k.handle, 'S'), R(e.handle, '')]),
    geo(doc, 'EQUAL', [R(c.handle), R(d.handle)]),
    geo(doc, 'FIX', [R(a.handle, 'S')]),
    geo(doc, 'VERTICAL', [R(f.handle)]),
  ];
  let r = addConstraints(doc, readStore(doc), cs);
  expect(r.message ?? 'ok').toBe('ok');
  apply(doc, s, r);
  const ds = [
    dim(doc, 'HDIST', [R(a.handle, 'S'), R(a.handle, 'E')], 'd1', '120', { x: 60, y: -15 }),
    dim(doc, 'DIST', [R(e.handle, 'S'), R(e.handle, 'E')], 'd2', '50', { x: 0, y: 90 }, { description: '빗변' }),
    dim(doc, 'RADIUS', [R(c.handle)], 'rad1', '10', { x: 170, y: 40 }),
    dim(doc, 'DIAMETER', [R(k.handle)], 'dia1', '44', { x: 50, y: 110 }),
    dim(doc, 'VDIST', [R(b.handle, 'E'), R(c.handle, 'C')], 'd3', '30', { x: 130, y: 45 }),
  ];
  r = addConstraints(doc, readStore(doc), ds);
  expect(r.message ?? 'ok').toBe('ok');
  apply(doc, s, r);
  return { ...t, a, b, c, k, d, e, f };
}

describe('이 앱 구속 → AutoCAD 구속 그룹', () => {
  it('새 망·그룹을 만들고, 다시 읽으면 모두 AutoCAD 구속으로 같은 내용이다', () => {
    const t = sample();
    const { doc } = t;
    expect(readAppStore(doc).constraints).toEqual([]);
    const s = readStore(doc);
    expect(s.constraints.length).toBe(12);
    expect(s.constraints.every((c) => c.acad)).toBe(true);
    for (const c of s.constraints) expect(isSatisfied(doc, s, c), c.type).toBe(true);
    expect(importAcadConstraints(doc).info.skipped).toBe(0);
    // 망: 루트 → 최상위 망(공간 망을 330 참조), 모형 공간 확장 사전 → 공간 망(그룹·변수 5개를 360 소유)
    const root = rootNetwork(doc)!;
    const rd = parseAssocObject(root.network.type, root.network.raw!)!;
    expect(rd.kind === 'network' && rd.net.actions.map((x) => x.owned)).toEqual([false]);
    const [G] = groups(doc);
    const sd = obj(doc, G!.head.network).d;
    expect(sd.kind === 'network' && sd.net.actions.length).toBe(6);
    // 그룹 노드: 선 셋(시작·끝 + 점–곡선), 원 둘(중심 + 중심점), 호(시작·끝·중심), 기준선 X·Y
    const cls = (n: string) => G!.g.nodes.filter((x) => x.cls === n).length;
    expect([cls('AcConstrainedBoundedLine'), cls('AcConstrainedCircle'), cls('AcConstrainedArc'), cls('AcConstrainedDatumLine')]).toEqual([4, 2, 1, 2]);
    expect(cls('AcConstrainedImplicitPoint')).toBe(4 * 2 + 2 + 3);
    expect(cls('AcEqualRadiusConstraint')).toBe(1);
    expect(cls('AcPointCurveConstraint')).toBe(4 * 2 + 2 + 1);
    expect(G!.g.seed).toBe(Math.max(...G!.g.nodes.map((n) => n.id)));
    // 이웃 목록이 서로 맞다(구속 노드 → 형상, 형상 → 구속)
    const byId = new Map(G!.g.nodes.map((n) => [n.id, n]));
    for (const n of G!.g.nodes) for (const l of n.links) expect(byId.get(l)!.links, `${n.id}→${l}`).toContain(n.id);
    // 형상 종속: 객체마다 하나, 객체의 반응자에 있다
    for (const e of [t.a, t.b, t.c, t.k, t.d, t.e, t.f]) {
      const reactors = doc.entityIndex.get(e.handle)!.reactors ?? [];
      const geomDeps = reactors.filter((h) => doc.objects.get(normalizeHandle(h))?.type === 'ACDBASSOCGEOMDEPENDENCY');
      expect(geomDeps.length, e.type).toBe(1);
    }
    // 치수 구속: 변수·값 종속·치수 종속·몸체·숨은 치수
    const n = G!.g.nodes.find((x) => x.cls === 'AcDistanceConstraint' && x.f.dirType === 0) as CNode;
    const vd = obj(doc, n.f.valueDep as string).d;
    const dd = obj(doc, n.f.dimDep as string).d;
    if (vd.kind !== 'valuedep' || dd.kind !== 'dependency') throw new Error('종속');
    const v = obj(doc, vd.dep.target).d;
    expect(v.kind === 'variable' && [v.variable.name, v.variable.expr, v.variable.value, v.variable.description]).toEqual(['d2', '50', { code: 90, v: 50 }, '빗변']);
    expect(obj(doc, vd.dep.target).o.reactors).toEqual([normalizeHandle(n.f.valueDep as string)]);
    const body = obj(doc, dd.dep.body).d;
    expect(body.kind === 'dimbody' && body.body.text).toBe('d2=50');
    const hd = doc.entityIndex.get(dd.dep.target) as DimensionEntity & { invisible?: boolean };
    expect([hd.type, hd.layer, hd.invisible, hd.dimType, hd.text, hd.block]).toEqual(['DIMENSION', '*ADSK_CONSTRAINTS', true, 161, 'd2=50', '']);
    expect(hd.reactors).toEqual([normalizeHandle(n.f.dimDep as string)]);
    expect(doc.layers.has('*ADSK_CONSTRAINTS')).toBe(true);
    // 숨은 치수 종류: 수평 거리 128, 반지름 132, 지름 131
    const types = G!.g.nodes
      .filter((x) => x.f.dimDep)
      .map((x) => {
        const q = obj(doc, x.f.dimDep as string).d;
        return q.kind === 'dependency' ? (doc.entityIndex.get(q.dep.target) as DimensionEntity).dimType : -1;
      })
      .sort((p, q) => p - q);
    expect(types).toEqual([128, 128, 131, 132, 161]);
  });

  it('방향 거리의 방향 벡터는 둘째 점에서 첫째 점 쪽, 수평·수직은 기준선 노드를 가리킨다', () => {
    const t = sample();
    const [G] = groups(t.doc);
    const byId = new Map(G!.g.nodes.map((n) => [n.id, n]));
    const hd = G!.g.nodes.find((n) => n.cls === 'AcDistanceConstraint' && n.f.dirType === 1 && (n.f.dir as { y: number }).y === 0)!;
    // d1: 선 a 시작(0,0) → 끝(120,0): 방향 (−1, 0)
    expect(hd.f.dir).toEqual({ x: -1, y: 0, z: 0 });
    const hz = G!.g.nodes.find((n) => n.cls === 'AcHorizontalConstraint')!;
    expect(byId.get(hz.f.datum as number)!.cls).toBe('AcConstrainedDatumLine');
    expect(byId.get(hz.f.datum as number)!.f.dir).toEqual({ x: 1, y: 0, z: 0 });
    const vt = G!.g.nodes.find((n) => n.cls === 'AcVerticalConstraint')!;
    expect(byId.get(vt.f.datum as number)!.f.dir).toEqual({ x: 0, y: 1, z: 0 });
    expect(vt.links.map((l) => byId.get(l)!.cls)).toEqual(['AcConstrainedBoundedLine']);
  });

  for (const [fmt, version] of [
    ['dxf', 'AC1032'],
    ['dxf', 'AC1024'],
    ['dxf', 'AC1015'],
    ['dwg', 'AC1032'],
    ['dwg', 'AC1024'],
    ['dwg', 'AC1018'],
  ] as const)
    it(`${fmt.toUpperCase()} ${version}: 저장해 다시 열면 같은 AutoCAD 구속`, () => {
      const t = sample();
      const want = readStore(t.doc).constraints.map(meaning);
      const data = fmt === 'dxf' ? writeDxf(t.doc, { version }).data : writeDwg(t.doc, { version }).data;
      const back = readCadFile(data, `x.${fmt}`);
      const imp = importAcadConstraints(back);
      expect(imp.info.unreadable).toEqual([]);
      expect(imp.info.raw).toBe(0);
      const s = readStore(back);
      expect(s.constraints.map(meaning)).toEqual(want);
      for (const c of s.constraints) expect(isSatisfied(back, s, c), c.type).toBe(true);
    });

  it('쓸 수 없는 종류(각도·대칭·폴리선·두 점 수직·다른 매개변수를 쓰는 식)는 이 앱 기록에 남는다', () => {
    const t = setup();
    const { doc, s, h } = t;
    const a = line(h(), 0, 0, 100, 0);
    const b = line(h(), 0, 0, 50, 60);
    const m = line(h(), 50, -10, 50, 100);
    const p = lwpoly(h(), [
      [0, 120],
      [80, 120],
    ]);
    const c = circle(h(), 200, 0, 10);
    put(doc, a, b, m, p, c);
    const cs: Constraint[] = [
      dim(doc, 'ANGLE', [R(a.handle), R(b.handle)], 'ang1', '40', { x: 30, y: 5 }),
      geo(doc, 'SYMMETRIC', [R(a.handle, 'S'), R(a.handle, 'E'), R(m.handle)]),
      geo(doc, 'HORIZONTAL', [R(p.handle, 'G0')]),
      geo(doc, 'VERTICAL', [R(m.handle, 'S'), R(c.handle, 'C')]),
      dim(doc, 'RADIUS', [R(c.handle)], 'rad1', '10', { x: 210, y: 0 }),
    ];
    for (const x of cs) {
      const r = addConstraints(doc, readStore(doc), [x]);
      expect(r.message ?? 'ok').toBe('ok');
      apply(doc, s, r);
    }
    const r2 = addConstraints(doc, readStore(doc), [{ ...dim(doc, 'DIST', [R(b.handle, 'S'), R(b.handle, 'E')], 'd1', 'rad1*8', { x: 0, y: 40 }), value: 80 }]);
    expect(r2.message ?? 'ok').toBe('ok');
    apply(doc, s, r2);
    expect(readAppStore(doc).constraints.map((x) => x.type).sort()).toEqual(['ANGLE', 'DIST', 'HORIZONTAL', 'SYMMETRIC', 'VERTICAL']);
    expect(readStore(doc).constraints.filter((x) => x.acad).map((x) => x.type)).toEqual(['RADIUS']);
    expect(acadClassFor(doc, readAppStore(doc).constraints.find((x) => x.type === 'DIST')!)).toBeNull();
  });

  it('도면에 AutoCAD 그룹이 있으면 그 그룹에 덧붙이고 형상 노드를 다시 쓴다', () => {
    const f = constraintDoc(2);
    const before = groups(f.doc)[0]!;
    const n0 = before.g.nodes.length;
    const r = addConstraints(f.doc, readStore(f.doc), [geo(f.doc, 'EQUAL', [R(f.h.l1), R(f.h.l2)])]);
    expect(r.message ?? 'ok').toBe('ok');
    f.s.commit({ label: 'T', ops: (() => {
      const ops = [...(storeOps(f.doc, r.store!, () => f.s.newHandle()) ?? []), ...[...r.entities].map(([h, e]) => ({ kind: 'modify' as const, block: MODEL_SPACE, before: f.doc.entityIndex.get(h)!, after: e as Entity }))];
      return acadCommitOps(f.doc, ops) ?? ops;
    })() });
    const gs = groups(f.doc);
    expect(gs.length).toBe(1);
    const g = gs[0]!.g;
    // 선 노드·암시 점은 그대로 쓰고 구속 노드 하나만 더한다
    expect(g.nodes.length).toBe(n0 + 1);
    const eq = g.nodes.at(-1)!;
    expect([eq.cls, eq.links, eq.id]).toEqual(['AcEqualLengthConstraint', [1, 10], 16]);
    expect(g.nodes.find((n) => n.id === 1)!.links.at(-1)).toBe(16);
    expect(readAppStore(f.doc).constraints).toEqual([]);
    const s = readStore(f.doc);
    expect(s.constraints.map((c) => c.type).sort()).toEqual(['COINCIDENT', 'EQUAL', 'HDIST', 'HORIZONTAL', 'PERPENDICULAR']);
    for (const c of s.constraints) expect(isSatisfied(f.doc, s, c)).toBe(true);
  });

  it('앱처럼 기록과 형상을 두 번에 확정해도(옛 사본의 형상 결과) 반응자·그룹 캐시·숨은 치수가 새 형상을 따른다', () => {
    const t = setup();
    const { doc, s, h } = t;
    const a = line(h(), 0, 0, 30, 40);
    put(doc, a);
    const c = dim(doc, 'DIST', [R(a.handle, 'S'), R(a.handle, 'E')], 'd1', '100', { x: 0, y: 30 });
    const r = addConstraints(doc, readStore(doc), [c]);
    expect(r.message ?? 'ok').toBe('ok');
    const commit = (ops: import('../../src/edit/session').EditOp[]) => s.commit({ label: 'T', ops: acadCommitOps(doc, ops) ?? ops });
    commit(storeOps(doc, r.store!, () => s.newHandle())!);
    // 해법기 결과는 기록을 쓰기 전 객체의 사본이다(반응자 없음)
    commit([...r.entities].map(([hh, e]) => ({ kind: 'modify' as const, block: MODEL_SPACE, before: doc.entityIndex.get(hh)!, after: e })));
    const L = doc.entityIndex.get(a.handle)!;
    expect((L.reactors ?? []).map((x) => doc.objects.get(normalizeHandle(x))?.type)).toEqual(['ACDBASSOCGEOMDEPENDENCY']);
    const [G] = groups(doc);
    const ln = G!.g.nodes.find((n) => n.cls === 'AcConstrainedBoundedLine')!;
    expect((ln.f.end as { x: number; y: number }).x).toBeCloseTo(60, 6);
    expect((ln.f.end as { x: number; y: number }).y).toBeCloseTo(80, 6);
    const st = readStore(doc);
    expect(st.constraints.map(meaning)).toEqual([meaning({ ...c, value: 100 })].map((m) => ({ ...m, offset: expect.closeTo(c.offset, 6) })));
    for (const x of st.constraints) expect(isSatisfied(doc, st, x)).toBe(true);
    // 복사해 넣은 객체는 원본의 종속을 반응자로 가지고 들어오지 않는다
    const copy = { ...L, handle: s.newHandle() } as Entity;
    commit([{ kind: 'add', block: MODEL_SPACE, entity: copy }]);
    expect(doc.entityIndex.get(copy.handle)!.reactors).toBeUndefined();
  });

  it('쓴 구속을 고치고 지우면 원본 그룹 형식으로 고친다(값·삭제·명령 취소)', () => {
    const t = sample();
    const { doc, s } = t;
    const s0 = readStore(doc);
    const d2 = s0.constraints.find((c) => c.kind === 'dim' && c.name === 'd2') as DimConstraint;
    const r = resolveParams(doc, s0, { ...s0, constraints: s0.constraints.map((c) => (c === d2 ? { ...d2, expr: '60', value: 60 } : c)) });
    expect(r.ok).toBe(true);
    apply(doc, s, { entities: r.entities, store: r.store! });
    const s1 = readStore(doc);
    expect((s1.constraints.find((c) => c.kind === 'dim' && c.name === 'd2') as DimConstraint).value).toBe(60);
    for (const c of s1.constraints) expect(isSatisfied(doc, s1, c), c.type).toBe(true);
    const nObj = doc.objects.size;
    const rad = s1.constraints.find((c) => c.kind === 'dim' && c.name === 'rad1')!;
    apply(doc, s, { entities: new Map(), store: removeConstraints(s1, [rad.id]) });
    expect(readStore(doc).constraints.length).toBe(11);
    // 값 종속·치수 종속·몸체·변수 4개를 지웠다
    expect(doc.objects.size).toBe(nObj - 4);
    s.undo();
    expect(readStore(doc).constraints.length).toBe(12);
  });
});

describe.skipIf(!hasPython)('AutoCAD 구속 그룹으로 쓴 DXF ↔ ezdxf 감사', () => {
  for (const version of ['AC1015', 'AC1024', 'AC1032'] as const)
    it(`${version}: 오류·고침 없음`, () => {
      const t = sample();
      mkdirSync(OUT, { recursive: true });
      const src = join(OUT, `cwrite-${version}.dxf`);
      writeFileSync(src, writeDxf(t.doc, { version }).data);
      const out = src + '.audit.json';
      execFileSync(PYTHON, ['-I', join(ROOT, 'scripts/oracle/ezdxf_audit.py'), out, src], { stdio: 'pipe', timeout: 120_000 });
      const res = JSON.parse(readFileSync(out, 'utf8'))[src];
      expect(res.ok).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.fixes).toEqual([]);
    });
});

describe('풀지 못한 변수를 가리키는 그룹', () => {
  for (const [fmt, version] of [
    ['dxf', 'AC1032'],
    ['dwg', 'AC1018'],
  ] as const)
    it(`${fmt.toUpperCase()} ${version}: 값 종속이 가리키는 변수를 쓸 수 없으면 그룹을 통째로 빼고 망 목록에서도 뺀다(끊긴 참조를 남기지 않는다)`, () => {
      const f = constraintDoc(2);
      // DWG에서 읽었는데 코덱이 풀지 못한 변수처럼(원본 태그 없음)
      const v = f.doc.objects.get(f.h.variable) as GenericObject;
      f.doc.objects.set(f.h.variable, { ...v, raw: undefined } as GenericObject);
      const data = fmt === 'dxf' ? writeDxf(f.doc, { version }).data : writeDwg(f.doc, { version }).data;
      const back = readCadFile(data, `x.${fmt}`);
      expect(back.objects.has(f.h.group)).toBe(false);
      const net = back.objects.get(f.h.network) as GenericObject;
      const nd = parseAssocObject(net.type, net.raw!)!;
      expect(nd.kind === 'network' && nd.net.actions.map((a) => a.h)).toEqual([]);
      for (const h of [f.h.depL1, f.h.valueDep, f.h.dimDep]) expect(back.objects.has(h), h).toBe(false);
    });
});
