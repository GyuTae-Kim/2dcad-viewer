/**
 * AutoCAD 2D 구속 그룹 → 이 앱 구속(src/edit/assocnet/constraints.ts), 해법기로 따라가기, 원본 망 되쓰기(writeback.ts),
 * 객체를 옮기거나 지운 트랜잭션의 그룹 갱신(acadCommitOps), DXF·DWG 저장 뒤 다시 읽기.
 */
import { describe, expect, it } from 'vitest';
import type { BlockDef, BlockRecord, DictionaryObject, Entity, GenericObject, LineEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { parseGroupRest } from '../../src/edit/assocnet/cgroup';
import { importAcadConstraints } from '../../src/edit/assocnet/constraints';
import { type AssocObjectData, parseAssocObject, writeAssocObject } from '../../src/edit/assocnet/objects';
import { acadCommitOps, dimText } from '../../src/edit/assocnet/writeback';
import { foreignConstraintNotice, readAppStore, readStore, storeOps } from '../../src/edit/constraint/store';
import { followEdit, isSatisfied, removeConstraints, resolveParams } from '../../src/edit/constraint/system';
import type { DimConstraint } from '../../src/edit/constraint/types';
import type { EditOp } from '../../src/edit/session';
import { writeDwg } from '../../src/io/dwg';
import { writeDxf } from '../../src/io/dxf/writer';
import { readCadFile } from '../../src/io';
import { type ConstraintFixture, constraintDoc } from './fixture';

/** 트랜잭션 확정(앱의 확정 고리처럼 AutoCAD 그룹 갱신을 덧붙인다) */
function commit(f: ConstraintFixture, ops: EditOp[]): void {
  f.s.commit({ label: 'T', ops: acadCommitOps(f.doc, ops) ?? ops });
}

function modifyOps(f: ConstraintFixture, entities: Map<string, Entity>): EditOp[] {
  const ms = f.doc.blocks.get(MODEL_SPACE)!;
  return [...entities].map(([h, after]) => ({ kind: 'modify', block: MODEL_SPACE, before: ms.entities.find((e) => e.handle === h)!, after }));
}

function group(f: ConstraintFixture) {
  const o = f.doc.objects.get(f.h.group) as GenericObject;
  const d = parseAssocObject(o.type, o.raw!)!;
  if (d.kind !== 'cgroup') throw new Error('그룹');
  return parseGroupRest(d.head.version, d.rest);
}

function variable(f: ConstraintFixture) {
  const o = f.doc.objects.get(f.h.variable) as GenericObject | undefined;
  const d = o?.raw ? parseAssocObject(o.type, o.raw) : null;
  return d?.kind === 'variable' ? d.variable : null;
}

const line = (f: ConstraintFixture, h: string) => f.doc.entityIndex.get(h) as LineEntity;

for (const v of [1, 2] as const)
  describe(`AutoCAD 구속 읽기(판 ${v})`, () => {
    it('사용자 구속 4개(일치·수평·수평 거리·직교)를 객체 부분과 이름·식으로 읽고, 암시 구속은 옮기지 않는다', () => {
      const f = constraintDoc(v);
      const s = readStore(f.doc);
      expect(readAppStore(f.doc).constraints).toEqual([]);
      const byType = new Map(s.constraints.map((c) => [c.type, c]));
      expect([...byType.keys()].sort()).toEqual(['COINCIDENT', 'HDIST', 'HORIZONTAL', 'PERPENDICULAR']);
      expect(byType.get('COINCIDENT')!.refs).toEqual([
        { h: f.h.l1, part: 'E' },
        { h: f.h.l2, part: 'S' },
      ]);
      expect(byType.get('HORIZONTAL')!.refs).toEqual([{ h: f.h.l1, part: '' }]);
      const d = byType.get('HDIST') as DimConstraint;
      expect([d.name, d.expr, d.value, d.reference]).toEqual(['d1', '10', 10, false]);
      expect(d.refs).toEqual([
        { h: f.h.l1, part: 'S' },
        { h: f.h.l1, part: 'E' },
      ]);
      // 치수선 자리: 숨은 치수 객체의 점(아래 3)
      expect(d.offset).toBeCloseTo(-3);
      for (const c of s.constraints) {
        expect(c.acad?.group).toBe(f.h.group);
        expect(c.id).toBeGreaterThanOrEqual(1_000_000);
        expect(isSatisfied(f.doc, s, c)).toBe(true);
      }
      expect(foreignConstraintNotice(f.doc)).toContain('구속 4개를 읽었습니다');
    });

    it('값을 바꾸면 해법기가 형상을 따라 고치고, 변수·값 종속·치수 글·그룹 캐시를 같은 형식으로 고친다', () => {
      const f = constraintDoc(v);
      const s0 = readStore(f.doc);
      const after = { ...s0, constraints: s0.constraints.map((c) => (c.kind === 'dim' ? { ...c, expr: '12' } : c)) };
      const r = resolveParams(f.doc, s0, after);
      expect(r.ok).toBe(true);
      commit(f, [...modifyOps(f, r.entities), ...(storeOps(f.doc, r.store!, () => f.s.newHandle()) ?? [])]);
      // L1 끝이 (12,0)으로, L2가 따라간다(일치·직교)
      expect(line(f, f.h.l1).end.x).toBeCloseTo(12);
      expect(line(f, f.h.l2).start.x).toBeCloseTo(12);
      expect(line(f, f.h.l2).end.x).toBeCloseTo(12);
      const vv = variable(f)!;
      expect([vv.name, vv.expr, vv.value]).toEqual(['d1', '12', { code: 90, v: 12 }]);
      const body = parseAssocObject('ASSOCDIMDEPENDENCYBODY', (f.doc.objects.get(f.h.dimBody) as GenericObject).raw!)!;
      expect(body.kind === 'dimbody' && body.body.text).toBe('d1=12');
      // 숨은 치수 객체: 글·측정값, 정의점(13·14)이 새 점으로
      const dim = f.doc.entityIndex.get(f.h.dim) as unknown as { text: string; measurement: number; defPoint2: { x: number }; defPoint3: { x: number } };
      expect([dim.text, dim.measurement]).toEqual(['d1=12', 12]);
      expect(dim.defPoint2.x).toBeCloseTo(0);
      expect(dim.defPoint3.x).toBeCloseTo(12);
      // 그룹의 L1 노드 캐시(작업 평면 좌표)
      expect((group(f).nodes.find((n) => n.id === 1)!.f.end as { x: number }).x).toBeCloseTo(12);
      // 이 앱 기록(XRECORD)은 만들지 않는다
      expect(readAppStore(f.doc).constraints).toEqual([]);
      const s1 = readStore(f.doc);
      expect((s1.constraints.find((c) => c.kind === 'dim') as DimConstraint).value).toBe(12);
      for (const c of s1.constraints) expect(isSatisfied(f.doc, s1, c)).toBe(true);
    });

    it('객체를 옮기면(유지 편집) 구속으로 이어진 객체가 따라오고 그룹 캐시가 바뀐다', () => {
      const f = constraintDoc(v);
      const s0 = readStore(f.doc);
      const l2 = line(f, f.h.l2);
      const moved = new Map<string, Entity>([[f.h.l2, { ...l2, end: { ...l2.end, y: 8 } }]]);
      const out = followEdit(f.doc, s0, moved, new Set(), { mode: 'maintain' });
      expect(out.ok).toBe(true);
      commit(f, modifyOps(f, new Map([...moved, ...out.entities])));
      expect(line(f, f.h.l2).end.y).toBeCloseTo(8);
      expect((group(f).nodes.find((n) => n.id === 10)!.f.end as { y: number }).y).toBeCloseTo(8);
      const s1 = readStore(f.doc);
      for (const c of s1.constraints) expect(isSatisfied(f.doc, s1, c)).toBe(true);
    });

    it('기하 구속을 지우면 노드와 이웃 목록에서 뺀다', () => {
      const f = constraintDoc(v);
      const s0 = readStore(f.doc);
      const co = s0.constraints.find((c) => c.type === 'COINCIDENT')!;
      commit(f, storeOps(f.doc, removeConstraints(s0, [co.id]), () => f.s.newHandle()) ?? []);
      const g = group(f);
      expect(g.nodes.some((n) => n.id === 6)).toBe(false);
      expect(g.nodes.find((n) => n.id === 4)!.links).toEqual([5, 9]);
      expect(g.nodes.find((n) => n.id === 11)!.links).toEqual([12]);
      expect(readStore(f.doc).constraints.map((c) => c.type).sort()).toEqual(['HDIST', 'HORIZONTAL', 'PERPENDICULAR']);
    });

    it('치수 구속을 지우면 값 종속·치수 종속·몸체·숨은 치수·변수(망 목록에서도)를 함께 지운다', () => {
      const f = constraintDoc(v);
      const s0 = readStore(f.doc);
      const d = s0.constraints.find((c) => c.kind === 'dim')!;
      commit(f, storeOps(f.doc, removeConstraints(s0, [d.id]), () => f.s.newHandle()) ?? []);
      for (const h of [f.h.valueDep, f.h.dimDep, f.h.dimBody, f.h.variable]) expect(f.doc.objects.has(h), h).toBe(false);
      expect(f.doc.entityIndex.has(f.h.dim)).toBe(false);
      expect(group(f).deps).toEqual([f.h.depL1, f.h.depL2]);
      const net = parseAssocObject('ACDBASSOCNETWORK', (f.doc.objects.get(f.h.network) as GenericObject).raw!)!;
      expect(net.kind === 'network' && net.net.actions.map((a) => a.h)).toEqual([f.h.group]);
      // 명령 취소로 모두 돌아온다
      f.s.undo();
      expect(f.doc.objects.has(f.h.variable)).toBe(true);
      expect(readStore(f.doc).constraints.length).toBe(4);
    });

    it('객체를 지우면 그 형상 노드·암시 점·이어진 구속과 형상 종속을 뺀다', () => {
      const f = constraintDoc(v);
      const ms = f.doc.blocks.get(MODEL_SPACE)!;
      const i = ms.entities.findIndex((e) => e.handle === f.h.l2);
      commit(f, [{ kind: 'remove', block: MODEL_SPACE, entity: ms.entities[i]!, index: i }]);
      const g = group(f);
      expect(g.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 5, 7, 8, 9]);
      expect(f.doc.objects.has(f.h.depL2)).toBe(false);
      expect(readStore(f.doc).constraints.map((c) => c.type).sort()).toEqual(['HDIST', 'HORIZONTAL']);
    });
  });

describe('저장 뒤 다시 읽기', () => {
  for (const [fmt, version] of [
    ['dxf', 'AC1032'],
    ['dxf', 'AC1024'],
    ['dxf', 'AC1015'],
    ['dwg', 'AC1032'],
    ['dwg', 'AC1018'],
  ] as const)
    it(`${fmt.toUpperCase()} ${version}: 고친 값으로 구속을 다시 읽는다`, () => {
      const f = constraintDoc(2);
      const s0 = readStore(f.doc);
      const r = resolveParams(f.doc, s0, { ...s0, constraints: s0.constraints.map((c) => (c.kind === 'dim' ? { ...c, expr: '7.5' } : c)) });
      commit(f, [...modifyOps(f, r.entities), ...(storeOps(f.doc, r.store!, () => f.s.newHandle()) ?? [])]);
      const data = fmt === 'dxf' ? writeDxf(f.doc, { version }).data : writeDwg(f.doc, { version }).data;
      const back = readCadFile(data, `x.${fmt}`);
      const imp = importAcadConstraints(back);
      expect(imp.info.unreadable).toEqual([]);
      const s = readStore(back);
      expect(s.constraints.length).toBe(4);
      const d = s.constraints.find((c) => c.kind === 'dim') as DimConstraint;
      expect([d.name, d.expr, d.value]).toEqual(['d1', '7.5', 7.5]);
      for (const c of s.constraints) expect(isSatisfied(back, s, c)).toBe(true);
      // 판: AC1024 이하 1, 이상 2
      const g = back.objects.get(f.h.group) as GenericObject;
      expect(Number(g.raw!.find((t) => t.code === 90)!.value)).toBe(Number(version.slice(2)) >= 1027 ? 2 : 1);
    });
});

/** 망에 변수(사용자 매개변수)를 더한다 */
function addVariable(f: ConstraintFixture, network: string, name: string, expr: string, value: number): string {
  const h = f.s.newHandle();
  const head = { version: 2, status: 0, network, body: '', index: 9, maxDep: 0, deps: [], params: { a: 0, actionParams: [], b: 0, values: [] } };
  const d: AssocObjectData = { kind: 'variable', head, variable: { version: 2, name, expr, evaluator: 'AcDbCalc:1.0', description: '', value: { code: 40, v: value }, b1: false, b2: false, tail: 0 } };
  const net = f.doc.objects.get(network) as GenericObject;
  const nd = parseAssocObject(net.type, net.raw!)!;
  if (nd.kind !== 'network') throw new Error('망');
  const net2 = { ...net, raw: writeAssocObject({ ...nd, net: { ...nd.net, actions: [...nd.net.actions, { h, owned: true }] } }) };
  f.s.commit({
    label: 'T',
    ops: [
      { kind: 'object', key: h, before: null, after: { type: 'ACDBASSOCVARIABLE', handle: h, owner: network, raw: writeAssocObject(d) } as GenericObject },
      { kind: 'object', key: network, before: net, after: net2 },
    ],
  });
  return h;
}

describe('사용자 매개변수와 망마다의 이름', () => {
  it('그룹에 묶이지 않은 변수는 사용자 매개변수로 읽고, 고치면 변수를 고친다', () => {
    const f = constraintDoc(2);
    const uh = addVariable(f, f.h.network, 'gap', 'd1/2', 5);
    const s0 = readStore(f.doc);
    expect(s0.userParams).toEqual([{ name: 'gap', expr: 'd1/2', value: 5, acad: uh }]);
    const s1 = { ...s0, userParams: s0.userParams.map((u) => ({ ...u, expr: 'd1/4', value: 2.5 })) };
    commit(f, storeOps(f.doc, s1, () => f.s.newHandle()) ?? []);
    const d = parseAssocObject('ACDBASSOCVARIABLE', (f.doc.objects.get(uh) as GenericObject).raw!)!;
    expect(d.kind === 'variable' && [d.variable.name, d.variable.expr, d.variable.value]).toEqual(['gap', 'd1/4', { code: 40, v: 2.5 }]);
    // 사용자 매개변수를 지우면 변수와 망 목록의 항목을 지운다
    commit(f, storeOps(f.doc, { ...s1, userParams: [] }, () => f.s.newHandle()) ?? []);
    expect(f.doc.objects.has(uh)).toBe(false);
  });

  it('다른 망(블록)의 같은 이름은 _2를 붙여 보이고, 되쓸 때는 AutoCAD 이름으로 쓴다', () => {
    const f = constraintDoc(2);
    // 블록 하나와 그 망
    const rec: BlockRecord = { name: 'B1', handle: f.s.newHandle(), flags: 0, insertUnits: 0, explodable: true, scalable: true };
    const def: BlockDef = { name: 'B1', handle: f.s.newHandle(), recordHandle: rec.handle, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [], endHandle: f.s.newHandle() };
    const xd = f.s.newHandle();
    const nd = f.s.newHandle();
    const net = f.s.newHandle();
    const dict = (handle: string, owner: string, k: string, v: string, hardOwner: boolean): DictionaryObject => ({ type: 'DICTIONARY', handle, owner, reactors: [owner], entries: new Map([[k, v]]), hardOwner, cloning: 1 });
    const netData: AssocObjectData = { kind: 'network', head: { version: 2, status: 0, network: '', body: '', index: 0, maxDep: 0, deps: [], params: { a: 0, actionParams: [], b: 0, values: [] } }, net: { version: 0, maxIndex: 0, actions: [], tail: [] } };
    f.s.commit({
      label: 'T',
      ops: [
        { kind: 'blockRecord', key: 'B1', before: null, after: { ...rec, xdict: xd } },
        { kind: 'blockDef', key: 'B1', before: null, after: def },
        { kind: 'object', key: xd, before: null, after: dict(xd, rec.handle, 'ACAD_ASSOCNETWORK', nd, true) },
        { kind: 'object', key: nd, before: null, after: dict(nd, xd, 'ACAD_ASSOCNETWORK', net, false) },
        { kind: 'object', key: net, before: null, after: { type: 'ACDBASSOCNETWORK', handle: net, owner: nd, raw: writeAssocObject(netData) } as GenericObject },
      ],
    });
    const vh = addVariable(f, net, 'd1', '3', 3);
    const s0 = readStore(f.doc);
    const u = s0.userParams.find((x) => x.acad === vh)!;
    expect(u.name).toBe('d1_2');
    commit(f, storeOps(f.doc, { ...s0, userParams: s0.userParams.map((x) => (x.acad === vh ? { ...x, expr: '4', value: 4 } : x)) }, () => f.s.newHandle()) ?? []);
    const d = parseAssocObject('ACDBASSOCVARIABLE', (f.doc.objects.get(vh) as GenericObject).raw!)!;
    expect(d.kind === 'variable' && [d.variable.name, d.variable.expr]).toEqual(['d1', '4']);
    // 모형 공간 망의 d1은 그대로
    expect(variable(f)!.name).toBe('d1');
  });
});

describe('치수 표시 숨김(DCDISPLAY)', () => {
  it('AutoCAD 치수 구속의 숨김은 이 앱 기록(AH)에 남고 다시 읽을 때 붙는다', () => {
    const f = constraintDoc(2);
    const s0 = readStore(f.doc);
    const s1 = { ...s0, constraints: s0.constraints.map((c) => (c.kind === 'dim' ? { ...c, hidden: true } : c)) };
    commit(f, storeOps(f.doc, s1, () => f.s.newHandle()) ?? []);
    expect(readAppStore(f.doc).acadHidden).toEqual([`${f.h.group}:9`]);
    expect((readStore(f.doc).constraints.find((c) => c.kind === 'dim') as DimConstraint).hidden).toBe(true);
    const back = readCadFile(writeDxf(f.doc, { version: 'AC1032' }).data, 'x.dxf');
    expect((readStore(back).constraints.find((c) => c.kind === 'dim') as DimConstraint).hidden).toBe(true);
  });
});

describe('이름공간과 도우미', () => {
  it('치수 글은 옛 글의 꼴을 따른다', () => {
    expect(dimText('d1=20.0000', 'd1', 12.5)).toBe('d1=12.5000');
    expect(dimText('10', 'd1', 12)).toBe('12');
    expect(dimText('dia2=57', 'dia2', 60.25)).toBe('dia2=60.25');
  });
});
