/**
 * 새 연관 배열의 AutoCAD 연관 객체 망(src/edit/assocnet/array.ts): 사전·망·동작·몸체·종속·매개변수의 구조,
 * DXF·DWG 저장 뒤 이 앱 기록 없이도 AutoCAD 기록으로 배열이 읽히는지, ezdxf 감사.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DictionaryObject, Entity, GenericObject, InsertEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, normalizeHandle } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { parseAssocObject } from '../../src/edit/assocnet/objects';
import { type BuildEnv, createArrayOps, regenerateOps } from '../../src/edit/assocarray/build';
import { readArray } from '../../src/edit/assocarray/read';
import type { ArrayParams } from '../../src/edit/assocarray/types';
import { allocBlockName } from '../../src/edit/geom/types';
import { affTranslate } from '../../src/edit/geom/math';
import { EditSession } from '../../src/edit/session';
import { readCadFile } from '../../src/io';
import { writeDwg } from '../../src/io/dwg';
import { writeDxf } from '../../src/io/dxf/writer';
import { PYTHON, hasPython } from '../oracle/ezdxf';
import { packLw } from '../../src/core/lwpoly';

const ROOT = join(__dirname, '../..');
const OUT = join(ROOT, '.runtime/assocnet/test-out');

function setup() {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const env: BuildEnv = { doc, newHandle: () => s.newHandle(), newBlockName: () => allocBlockName(doc, '*U') };
  const add = (e: Entity) => {
    e.handle = s.newHandle();
    e.owner = doc.blocks.get(MODEL_SPACE)!.recordHandle;
    s.commit({ label: 'T', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
    return doc.entityIndex.get(e.handle)!;
  };
  const circle = (x: number, y: number, r: number) => add({ ...entityDefaults(), type: 'CIRCLE', handle: '', center: { x, y, z: 0 }, radius: r } as Entity);
  const { handle: _h, ...props } = { ...entityDefaults(), handle: '' };
  void _h;
  const make = (params: ArrayParams, src: Entity, dx = 0, dy = 0, insert = { x: 0, y: 0, z: 0 }) => {
    const r = createArrayOps(env, { params, sources: [src], normalize: affTranslate(-dx, -dy), insert, rotation: 0, props, space: MODEL_SPACE });
    if ('error' in r) throw new Error(r.error);
    s.commit({ label: 'A', ops: r.ops });
    return doc.entityIndex.get(r.insert.handle) as InsertEntity;
  };
  return { doc, s, add, circle, make };
}

const common = { base: { x: 0, y: 0 }, rows: 1, rowSpacing: 10, rowElevation: 0, levels: 1, levelSpacing: 1 };
const RECT: ArrayParams = { kind: 'rect', ...common, rows: 2, origin: { x: 0, y: 0 }, columns: 3, columnSpacing: 20, axesAngle: Math.PI / 2 };
const POLAR: ArrayParams = { kind: 'polar', ...common, center: { x: 0, y: 0 }, items: 4, itemAngle: Math.PI / 2, fillAngle: 2 * Math.PI, startAngle: 0, radius: 30, rotateItems: true };

function parsed(doc: ReturnType<typeof createNewDocument>, h: string) {
  const o = doc.objects.get(normalizeHandle(h)) as GenericObject;
  return { o, d: parseAssocObject(o.type, o.raw!)! };
}

describe('새 배열의 AutoCAD 연관 객체', () => {
  it('직사각형: 루트·공간 망, 동작(종속 3·매개변수 3·값 9), 몸체(항목 6), 배열 참조의 반응자', () => {
    const t = setup();
    const ins = t.make(RECT, t.circle(5, 5, 2), 5, 5, { x: 5, y: 5, z: 0 });
    const doc = t.doc;
    // 루트 사전 → ACAD_ASSOCNETWORK 사전 → 최상위 망(공간 망을 330으로)
    const root = doc.objects.get(normalizeHandle(doc.rootDictionary!)) as DictionaryObject;
    const rd = doc.objects.get(root.entries.get('ACAD_ASSOCNETWORK')!) as DictionaryObject;
    const top = parsed(doc, rd.entries.get('ACAD_ASSOCNETWORK')!).d;
    if (top.kind !== 'network') throw new Error('망');
    expect(top.net.actions).toHaveLength(1);
    expect(top.net.actions[0]!.owned).toBe(false);
    // 모형 공간 블록 레코드 확장 사전 → ACAD_ASSOCNETWORK → 공간 망(동작을 360으로)
    const rec = doc.blockRecords.get(MODEL_SPACE)!;
    const xd = doc.objects.get(rec.xdict!) as DictionaryObject;
    expect(xd.hardOwner).toBe(true);
    const nd = doc.objects.get(xd.entries.get('ACAD_ASSOCNETWORK')!) as DictionaryObject;
    const netH = nd.entries.get('ACAD_ASSOCNETWORK')!;
    expect(netH).toBe(top.net.actions[0]!.h);
    const net = parsed(doc, netH).d;
    if (net.kind !== 'network') throw new Error('망');
    expect(net.head.network).toBe(normalizeHandle(rd.entries.get('ACAD_ASSOCNETWORK')!));
    expect(net.net.actions).toEqual([{ h: expect.any(String), owned: true }]);
    const act = parsed(doc, net.net.actions[0]!.h).d;
    if (act.kind !== 'action') throw new Error('동작');
    expect(act.head.version).toBe(2);
    expect(act.head.params!.values.map((v) => [v.name, v.unit, v.values[0]!.code])).toEqual([
      ['AlignItems', 0, 90],
      ['AxesAngle', 2, 40],
      ['ItemSpacing', 1, 40],
      ['Items', 0, 90],
      ['LevelSpacing', 1, 40],
      ['Levels', 0, 90],
      ['RowElevation', 1, 40],
      ['RowSpacing', 1, 40],
      ['Rows', 0, 90],
    ]);
    expect(act.head.params!.values.find((v) => v.name === 'Items')!.values[0]!.v).toBe(3);
    // 종속: 배열 블록(쓰기), 원본 블록(읽기), 배열 참조(읽기·쓰기, 순서 −2³¹)
    const deps = act.head.deps.map((h) => parsed(doc, h).d).map((d) => (d.kind === 'dependency' ? d.dep : null)!);
    const def = doc.blocks.get(ins.block.toUpperCase())!;
    expect(deps.map((d) => [d.target, d.read, d.write, d.order, d.index])).toEqual([
      [normalizeHandle(def.recordHandle), false, true, 0, 1],
      [expect.any(String), true, false, 0, 2],
      [ins.handle, true, true, -2147483648, 3],
    ]);
    expect(ins.reactors).toEqual([act.head.deps[2]]);
    // 동작 매개변수
    const names = act.head.params!.actionParams.map((h) => parsed(doc, h).d).map((d) => (d.kind === 'vertexparam' ? d.param.name : '?'));
    expect(names).toEqual(['BaseNormal', 'Origin', 'basePoint']);
    // 몸체
    const body = parsed(doc, act.head.body).d;
    if (body.kind !== 'arraybody') throw new Error('몸체');
    expect(body.body.paramsClass).toBe('AcDbAssocArrayRectangularParameters');
    expect(body.body.items.map((i) => `${i.i},${i.j},${i.k}:${i.flags}`)).toEqual(['0,0,0:8', '0,1,0:8', '1,0,0:8', '1,1,0:8', '2,0,0:8', '2,1,0:8']);
    expect(body.body.matrix.slice(0, 4)).toEqual([1, 0, 0, 5]);
    // 클래스
    expect(doc.classes.map((c) => c.dxfName)).toEqual(expect.arrayContaining(['ACDBASSOCNETWORK', 'ACDBASSOCACTION', 'ACDBASSOCARRAYACTIONBODY', 'ACDBASSOCDEPENDENCY', 'ACDBASSOCVERTEXACTIONPARAM', 'ACDBASSOCARRAYRECTANGULARPARAMETERS']));
    // 다시 읽기: AutoCAD 기록으로
    const info = readArray(doc, ins)!;
    expect(info.origin).toBe('acad');
    expect(info.acad?.raw).toBe(true);
  });

  it('원형: 값 10개(표본 차례), 항목 회전은 행렬(플래그 12)', () => {
    const t = setup();
    const ins = t.make(POLAR, t.circle(30, 0, 2), 30, 0);
    const a = readArray(t.doc, ins)!;
    const act = parsed(t.doc, a.acad!.action).d;
    if (act.kind !== 'action') throw new Error('동작');
    expect(act.head.params!.values.map((v) => v.name)).toEqual(['FillAngle', 'ItemSpacing', 'Items', 'LevelSpacing', 'Levels', 'RowElevation', 'RowSpacing', 'Rows', 'Radius', 'StartAngle']);
    const body = parsed(t.doc, a.acad!.body).d;
    if (body.kind !== 'arraybody') throw new Error('몸체');
    expect(body.body.items.map((i) => i.flags)).toEqual([8, 12, 12, 12]);
  });

  it('원형 시계 방향: 각도는 크기만, Direction 0을 더하고 다시 읽으면 음의 각도', () => {
    const t = setup();
    const cw: ArrayParams = { ...POLAR, itemAngle: -Math.PI / 4, fillAngle: -(3 * Math.PI) / 4 } as ArrayParams;
    const ins = t.make(cw, t.circle(30, 0, 2), 30, 0);
    const a = readArray(t.doc, ins)!;
    const act = parsed(t.doc, a.acad!.action).d;
    if (act.kind !== 'action') throw new Error('동작');
    const v = new Map(act.head.params!.values.map((x) => [x.name, x.values[0]!.v]));
    expect([v.get('FillAngle'), v.get('ItemSpacing'), v.get('Direction')]).toEqual([(3 * Math.PI) / 4, Math.PI / 4, 0]);
    expect(act.head.params!.values.at(-1)!.name).toBe('Direction');
    const p = a.state.params;
    expect(p.kind === 'polar' && [p.itemAngle, p.fillAngle]).toEqual([-Math.PI / 4, -(3 * Math.PI) / 4]);
    // 이 앱 기록 없이도 같은 방향
    const e = { ...ins, xdata: undefined } as InsertEntity;
    const b = readArray(t.doc, e)!;
    expect(b.state.params.kind === 'polar' && b.state.params.fillAngle).toBeCloseTo(-(3 * Math.PI) / 4);
  });

  it('반시계 AutoCAD 원형 배열을 시계 방향으로 고치면 Direction을 더한다', () => {
    const t = setup();
    const ins = t.make(POLAR, t.circle(30, 0, 2), 30, 0);
    const info = readArray(t.doc, ins)!;
    const next = { ...info.state, params: { ...info.state.params, itemAngle: -Math.PI / 2, fillAngle: -2 * Math.PI } as ArrayParams };
    const r = regenerateOps({ doc: t.doc, newHandle: () => t.s.newHandle(), newBlockName: () => allocBlockName(t.doc, '*U') }, info, next);
    if ('error' in r) throw new Error(r.error);
    t.s.commit({ label: 'ARRAYEDIT', ops: r.ops });
    const act = parsed(t.doc, info.acad!.action).d;
    if (act.kind !== 'action') throw new Error('동작');
    expect(act.head.params!.values.find((x) => x.name === 'Direction')!.values[0]!.v).toBe(0);
    const again = readArray(t.doc, { ...t.doc.entityIndex.get(ins.handle)!, xdata: undefined } as InsertEntity)!;
    expect([again.origin, again.state.params.kind === 'polar' && again.state.params.itemAngle]).toEqual(['acad', -Math.PI / 2]);
  });

  it('경로(선): 경로 종속이 맨 앞, RowProfile 곡선 캐시(선분), 경로 곡선의 반응자', () => {
    const t = setup();
    const path = t.add({ ...entityDefaults(), type: 'LINE', handle: '', start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 0, z: 0 } } as Entity);
    const params: ArrayParams = { kind: 'path', ...common, method: 'divide', items: 5, spacing: 25, align: true, zDir: true, reverse: false, path: path.handle, tangentRef: 0 };
    const ins = t.make(params, t.circle(0, 0, 2));
    const a = readArray(t.doc, ins)!;
    expect([a.origin, a.items.size]).toEqual(['acad', 5]);
    const act = parsed(t.doc, a.acad!.action).d;
    if (act.kind !== 'action') throw new Error('동작');
    const first = parsed(t.doc, act.head.deps[0]!).d;
    expect(first.kind === 'dependency' && [first.dep.target, first.dep.read, first.dep.write]).toEqual([path.handle, true, false]);
    const params2 = act.head.params!.actionParams.map((h) => parsed(t.doc, h).d);
    const edge = params2.find((d) => d.kind === 'edgeparam');
    expect(edge?.kind === 'edgeparam' && [edge.param.name, edge.param.single?.dep, edge.param.curve.map((x) => Number(x.value))]).toEqual(['RowProfile', act.head.deps[0], [23, 0, 0, 0, 100, 0, 0]]);
    expect(t.doc.entityIndex.get(path.handle)!.reactors).toEqual([act.head.deps[0]]);
    expect(act.head.params!.values.find((v) => v.name === 'ItemSpacing')!.values[0]!.v).toBe(25);
  });

  /** 곡선 경로(호·원·폴리선·스플라인)와 그 곡선 캐시 종류(공개 경로 배열 표본: 원호 11, 복합 47, NURBS 42) */
  const curvePaths: [string, (t: ReturnType<typeof setup>) => Entity, number][] = [
    ['호', (t) => t.add({ ...entityDefaults(), type: 'ARC', handle: '', center: { x: 0, y: 0, z: 0 }, radius: 50, startAngle: 0, endAngle: Math.PI } as Entity), 11],
    ['원', (t) => t.add({ ...entityDefaults(), type: 'CIRCLE', handle: '', center: { x: 0, y: 0, z: 0 }, radius: 40 } as Entity), 11],
    [
      '폴리선(볼록 포함)',
      (t) =>
        t.add({
          ...entityDefaults(),
          type: 'LWPOLYLINE',
          handle: '',
          ...packLw([
            { x: 0, y: 0, bulge: 0, startWidth: 0, endWidth: 0 },
            { x: 60, y: 0, bulge: -0.5, startWidth: 0, endWidth: 0 },
            { x: 60, y: 40, bulge: 0, startWidth: 0, endWidth: 0 },
          ]),
          closed: false,
          plinegen: false,
          constantWidth: 0,
          elevation: 0,
        } as Entity),
      47,
    ],
    [
      '스플라인',
      (t) =>
        t.add({
          ...entityDefaults(),
          type: 'SPLINE',
          handle: '',
          flags: 8,
          degree: 3,
          knots: [0, 0, 0, 0, 1, 2, 2, 2, 2],
          controlPoints: [
            { x: 0, y: 0, z: 0 },
            { x: 20, y: 30, z: 0 },
            { x: 50, y: -10, z: 0 },
            { x: 80, y: 20, z: 0 },
            { x: 100, y: 0, z: 0 },
          ],
          fitPoints: [],
          knotTolerance: 1e-10,
          controlTolerance: 1e-10,
          fitTolerance: 1e-10,
        } as Entity),
      42,
    ],
  ];
  for (const [name, mk, type] of curvePaths)
    it(`곡선 경로(${name}): 곡선 캐시 ${type}, DXF·DWG 저장 뒤 AutoCAD 기록만으로 같은 배열`, () => {
      const t = setup();
      const path = mk(t);
      const params: ArrayParams = { kind: 'path', ...common, method: 'divide', items: 4, spacing: 10, align: false, zDir: true, reverse: false, path: path.handle, tangentRef: 0 };
      const ins = t.make(params, t.circle(200, 200, 2), 200, 200);
      const a = readArray(t.doc, ins)!;
      expect([a.origin, a.items.size]).toEqual(['acad', 4]);
      const act = parsed(t.doc, a.acad!.action).d;
      if (act.kind !== 'action') throw new Error('동작');
      const eh = act.head.params!.actionParams.find((h) => parsed(t.doc, h).d.kind === 'edgeparam')!;
      const edge = parsed(t.doc, eh).d;
      if (edge.kind !== 'edgeparam') throw new Error('모서리 매개변수');
      expect(Number(edge.param.curve[0]!.value)).toBe(type);
      for (const [fmt, version] of [
        ['dxf', 'AC1032'],
        ['dxf', 'AC1015'],
        ['dwg', 'AC1032'],
        ['dwg', 'AC1018'],
      ] as const) {
        const data = fmt === 'dxf' ? writeDxf(t.doc, { version }).data : writeDwg(t.doc, { version }).data;
        const back = readCadFile(data, `x.${fmt}`);
        const e = back.entityIndex.get(ins.handle) as InsertEntity;
        delete e.xdata;
        const b = readArray(back, e)!;
        expect([b.origin, b.state.params.kind, b.items.size], `${fmt} ${version}`).toEqual(['acad', 'path', 4]);
        // 곡선 캐시가 그대로(DWG도 원본 비트가 아니라 해독한 태그로)
        const be = parsed(back, eh).d;
        expect(be.kind === 'edgeparam' && be.param.curve.map((x) => Number(x.value)), `${fmt} ${version}`).toEqual(edge.param.curve.map((x) => expect.closeTo(Number(x.value), 9)));
      }
    });

  it('경로 곡선을 지워도 AutoCAD 곡선 캐시(공간 좌표)를 배열 블록 좌표로 바꿔 같은 배열로 읽는다', () => {
    const t = setup();
    const arc = t.add({ ...entityDefaults(), type: 'ARC', handle: '', center: { x: 300, y: 200, z: 0 }, radius: 50, startAngle: 0, endAngle: Math.PI } as Entity);
    const params: ArrayParams = { kind: 'path', ...common, method: 'divide', items: 4, spacing: 10, align: true, zDir: true, reverse: false, path: arc.handle, tangentRef: 0 };
    // 배열 참조를 옮겨 둔다(배열 블록 좌표 ≠ 공간 좌표)
    const ins = t.make(params, t.circle(350, 200, 2), 350, 200, { x: 100, y: 50, z: 0 });
    const act = parsed(t.doc, readArray(t.doc, ins)!.acad!.action).d;
    if (act.kind !== 'action') throw new Error('동작');
    const edge = act.head.params!.actionParams.map((h) => parsed(t.doc, h).d).find((d) => d.kind === 'edgeparam');
    // 캐시는 경로 객체 좌표 그대로(중심 300, 200)
    expect(edge?.kind === 'edgeparam' && edge.param.curve.slice(1, 3).map((x) => Number(x.value))).toEqual([300, 200]);
    const ms = t.doc.blocks.get(MODEL_SPACE)!;
    const i = ms.entities.findIndex((e) => e.handle === arc.handle);
    t.s.commit({ label: 'ERASE', ops: [{ kind: 'remove', block: MODEL_SPACE, entity: ms.entities[i]!, index: i }] });
    const b = readArray(t.doc, { ...t.doc.entityIndex.get(ins.handle)!, xdata: undefined } as InsertEntity)!;
    expect([b.origin, b.items.size]).toEqual(['acad', 4]);
    const fb = (b.state.params as Extract<ArrayParams, { kind: 'path' }>).fallback![0]!;
    expect(fb.k === 'arc' && [fb.c.x, fb.c.y, fb.r]).toEqual([expect.closeTo(200, 9), expect.closeTo(150, 9), expect.closeTo(50, 9)]);
  });

  it('타원 경로는 AutoCAD 기록 없이 이 앱 기록만 둔다(타원 곡선 캐시는 실물로 확인하지 못했다)', () => {
    const t = setup();
    const el = t.add({ ...entityDefaults(), type: 'ELLIPSE', handle: '', center: { x: 0, y: 0, z: 0 }, majorAxis: { x: 50, y: 0, z: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI } as Entity);
    const params: ArrayParams = { kind: 'path', ...common, method: 'divide', items: 4, spacing: 10, align: false, zDir: true, reverse: false, path: el.handle, tangentRef: 0 };
    const ins = t.make(params, t.circle(50, 0, 2), 50, 0);
    const a = readArray(t.doc, ins)!;
    expect([a.origin, a.acad, a.items.size]).toEqual(['app', null, 4]);
  });

  it('경로를 고치면(배열 다시 계산) AutoCAD 곡선 캐시도 새 경로로 고친다', () => {
    const t = setup();
    const arc = t.add({ ...entityDefaults(), type: 'ARC', handle: '', center: { x: 0, y: 0, z: 0 }, radius: 50, startAngle: 0, endAngle: Math.PI } as Entity);
    const params: ArrayParams = { kind: 'path', ...common, method: 'divide', items: 4, spacing: 10, align: false, zDir: true, reverse: false, path: arc.handle, tangentRef: 0 };
    const ins = t.make(params, t.circle(50, 0, 2), 50, 0);
    const before = t.doc.entityIndex.get(arc.handle)!;
    t.s.commit({ label: 'T', ops: [{ kind: 'modify', block: MODEL_SPACE, before, after: { ...before, radius: 70 } as Entity }] });
    const info = readArray(t.doc, t.doc.entityIndex.get(ins.handle))!;
    const r = regenerateOps({ doc: t.doc, newHandle: () => t.s.newHandle(), newBlockName: () => allocBlockName(t.doc, '*U') }, info, info.state);
    if ('error' in r) throw new Error(r.error);
    t.s.commit({ label: 'ARRAYEDIT', ops: r.ops });
    const act = parsed(t.doc, info.acad!.action).d;
    if (act.kind !== 'action') throw new Error('동작');
    const edge = act.head.params!.actionParams.map((h) => parsed(t.doc, h).d).find((d) => d.kind === 'edgeparam');
    // 11 원호: 10 중심(3), 10 법선(3), 10 기준(3), 40 반지름
    expect(edge?.kind === 'edgeparam' && Number(edge.param.curve[10]!.value)).toBe(70);
  });

  for (const [fmt, version] of [
    ['dxf', 'AC1032'],
    ['dxf', 'AC1024'],
    ['dxf', 'AC1015'],
    ['dwg', 'AC1032'],
    ['dwg', 'AC1027'],
    ['dwg', 'AC1018'],
  ] as const)
    it(`${fmt.toUpperCase()} ${version}: 이 앱 기록을 빼도 AutoCAD 기록만으로 같은 배열로 읽힌다`, () => {
      const t = setup();
      const r = t.make(RECT, t.circle(5, 5, 2), 5, 5, { x: 5, y: 5, z: 0 });
      const p = t.make(POLAR, t.circle(130, 0, 2), 30, 0, { x: 100, y: 0, z: 0 });
      const data = fmt === 'dxf' ? writeDxf(t.doc, { version }).data : writeDwg(t.doc, { version }).data;
      const back = readCadFile(data, `x.${fmt}`);
      for (const [h, kind, n] of [
        [r.handle, 'rect', 6],
        [p.handle, 'polar', 4],
      ] as const) {
        const e = back.entityIndex.get(h) as InsertEntity;
        delete e.xdata;
        const a = readArray(back, e)!;
        expect([a.origin, a.state.params.kind, a.items.size], `${kind}`).toEqual(['acad', kind, n]);
      }
    });
});

describe.skipIf(!hasPython)('새 배열 DXF ↔ ezdxf 감사', () => {
  for (const version of ['AC1015', 'AC1024', 'AC1032'] as const)
    it(`${version}: 오류·고침 없음`, () => {
      const t = setup();
      t.make(RECT, t.circle(5, 5, 2), 5, 5, { x: 5, y: 5, z: 0 });
      t.make(POLAR, t.circle(130, 0, 2), 30, 0, { x: 100, y: 0, z: 0 });
      mkdirSync(OUT, { recursive: true });
      const src = join(OUT, `newarray-${version}.dxf`);
      writeFileSync(src, writeDxf(t.doc, { version }).data);
      const out = src + '.audit.json';
      execFileSync(PYTHON, ['-I', join(ROOT, 'scripts/oracle/ezdxf_audit.py'), out, src], { stdio: 'pipe', timeout: 120_000 });
      const res = JSON.parse(readFileSync(out, 'utf8'))[src];
      expect(res.ok).toBe(true);
      expect(res.errors).toEqual([]);
      expect(res.fixes).toEqual([]);
    });
});
