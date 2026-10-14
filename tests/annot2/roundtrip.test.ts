/**
 * 왕복: 새 도면에 재지정·꺾기선·끊기가 있는 선형 치수, 꺾기 반지름 치수, QLEADER식 지시선 + 여러 줄 문자,
 * 공차, 끊긴 다중 지시선을 편집 작업으로 넣고 DXF(R2018)·DWG(R2018)로 써서 다시 읽으면 기록과 그림이 같은지 본다.
 */
import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, DimensionEntity, Entity, LeaderEntity, LineEntity, MTextEntity, ToleranceEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { createLinearDimension, generateDimensionGeometry, nextDimBlockName } from '../../src/edit/dim';
import { dimFrame, readBreaks, readJogLine, toFrame, writeBreaks, writeJogLine } from '../../src/edit/dim/extras';
import { createJoggedDimension } from '../../src/edit/annot/create';
import { applyOverrides } from '../../src/edit/annot/override';
import { buildLeader } from '../../src/edit/annot/qleader';
import { type EditOp, EditSession } from '../../src/edit/session';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { readCadFile } from '../../src/io/index';

const P = (x: number, y: number) => ({ x, y, z: 0 });

function build(): { doc: CadDocument; handles: Record<string, string> } {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const ms = doc.blocks.get(MODEL_SPACE)!;
  const add = (e: Entity): string => {
    e.handle ||= s.newHandle();
    e.owner = ms.recordHandle;
    s.commit({ label: 'ADD', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
    return e.handle;
  };
  const addDim = (d: DimensionEntity): string => {
    const g = generateDimensionGeometry(doc, d);
    d.measurement = g.measurement;
    d.textMid = g.textMid;
    const name = nextDimBlockName(doc);
    const key = tableKey(name);
    const rh = s.newHandle();
    for (const e of g.entities) {
      e.handle = s.newHandle();
      e.owner = rh;
    }
    const def: BlockDef = { name, handle: s.newHandle(), recordHandle: rh, basePoint: P(0, 0), flags: 1, entities: g.entities, endHandle: s.newHandle() };
    const ops: EditOp[] = [
      { kind: 'blockRecord', key, before: null, after: { name, handle: rh, flags: 1, insertUnits: 0, explodable: true, scalable: true } },
      { kind: 'blockDef', key, before: null, after: def },
    ];
    if (!doc.layers.has('DEFPOINTS')) ops.push({ kind: 'layer', key: 'DEFPOINTS', before: null, after: { name: 'Defpoints', handle: s.newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: false, transparency: 255 } });
    d.block = name;
    d.handle = s.newHandle();
    d.owner = ms.recordHandle;
    ops.push({ kind: 'add', block: MODEL_SPACE, entity: d });
    s.commit({ label: 'DIM', ops });
    return d.handle;
  };
  const cut: LineEntity = { ...entityDefaults(), type: 'LINE', handle: '', start: P(40, -10), end: P(40, 40) };
  const cutH = add(cut);
  // 선형 치수: 재지정 + 꺾기선(사용자 위치) + 객체·수동 끊기
  let d = createLinearDimension(doc, P(0, 0), P(100, 0), P(50, 20), { rotation: 0 });
  d = applyOverrides(d, { 140: 3.5, 77: 0, 280: 1 });
  d.xdata = writeJogLine(d, { point: { x: 75, y: 20 }, defaultPoint: { x: 25, y: 20 } });
  const f = dimFrame(d);
  d.xdata = writeBreaks(d, [
    { kind: 'object', handle: cutH },
    { kind: 'manual', a: toFrame(f, { x: 85, y: 21 }), b: toFrame(f, { x: 90, y: 19 }) },
  ]);
  const linH = addDim(d);
  // 꺾기 반지름 치수
  const jogH = addDim(createJoggedDimension(doc, P(0, -100), 100, P(70, -100), P(20, -115), P(45, -100)));
  // 지시선 + 여러 줄 문자(서로 가리킨다)
  const lv = buildLeader([P(200, 0), P(220, 30)], { hook: true, hookLength: 2.5 });
  const leader: LeaderEntity = {
    ...entityDefaults(),
    type: 'LEADER',
    handle: s.newHandle(),
    dimStyle: 'ISO-25',
    vertices: lv.vertices.map((q) => P(q.x, q.y)),
    arrowHead: true,
    pathType: 0,
    creation: 0,
    hooklineDirection: lv.hookDirection,
    hookline: lv.hooked,
    textHeight: 2.5,
    textWidth: 0,
    horizontalDirection: { x: 1, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };
  const m: MTextEntity = {
    ...entityDefaults(),
    type: 'MTEXT',
    handle: s.newHandle(),
    insert: P(220.625, 31.25),
    height: 2.5,
    width: 0,
    attachment: 1,
    drawingDirection: 1,
    text: '주석',
    style: 'Standard',
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
    reactors: [leader.handle],
  };
  leader.annotation = m.handle;
  const leaderH = add(leader);
  const mtH = add(m);
  // 공차
  const tol: ToleranceEntity = { ...entityDefaults(), type: 'TOLERANCE', handle: '', dimStyle: 'ISO-25', insert: P(300, 0), text: '{\\Fgdt;j}%%v{\\Fgdt;n}0.05{\\Fgdt;m}%%vA%%vB', direction: { x: 1, y: 0, z: 0 } };
  const tolH = add(tol);
  return { doc, handles: { cut: cutH, lin: linH, jog: jogH, leader: leaderH, mtext: mtH, tol: tolH } };
}

/** 선·문자의 좌표 요약(그림 비교) */
function shape(es: Entity[]): string[] {
  const r = (v: number) => (Math.round(v * 1e6) / 1e6).toFixed(6);
  return es
    .map((e) => (e.type === 'LINE' ? `L ${r(e.start.x)},${r(e.start.y)} ${r(e.end.x)},${r(e.end.y)}` : e.type === 'MTEXT' ? `T ${e.text} ${r(e.insert.x)},${r(e.insert.y)}` : e.type))
    .sort();
}

describe('주석 편집 기록 왕복', () => {
  const { doc, handles } = build();
  const orig = (h: string) => doc.entityIndex.get(h)!;

  for (const fmt of ['dxf', 'dwg'] as const) {
    it(`${fmt.toUpperCase()} R2018`, () => {
      const data = fmt === 'dxf' ? writeDxf(doc, { version: 'AC1032' }).data : writeDwg(doc, { version: 'AC1032' }).data;
      const back = readCadFile(data, `x.${fmt}`);
      const get = (h: string) => back.entityIndex.get(h)!;
      // 선형 치수: 재지정·꺾기·끊기 기록
      const lin = get(handles.lin) as DimensionEntity;
      const lin0 = orig(handles.lin) as DimensionEntity;
      expect(lin.type).toBe('DIMENSION');
      expect(lin.overrides).toEqual({ 77: 0, 140: 3.5, 280: 1 });
      expect(readJogLine(lin)).toEqual(readJogLine(lin0));
      expect(readBreaks(lin)).toEqual(readBreaks(lin0));
      // 다시 그린 그림이 같다(끊는 객체는 다시 읽은 도면의 것)
      expect(shape(generateDimensionGeometry(back, lin).entities)).toEqual(shape(generateDimensionGeometry(doc, lin0).entities));
      // 저장된 블록 그림에도 끊기·꺾기가 있다
      expect(shape(back.blocks.get(tableKey(lin.block))!.entities.filter((e) => e.type === 'LINE'))).toEqual(shape(doc.blocks.get(tableKey(lin0.block))!.entities.filter((e) => e.type === 'LINE')));
      // 꺾기 반지름 치수
      const jog = get(handles.jog) as DimensionEntity;
      expect(jog.subtype).toBe('LARGE_RADIAL_DIMENSION');
      for (const k of ['defPoint', 'defPoint2', 'defPoint3', 'defPoint4'] as const) expect(jog[k]).toMatchObject({ x: expect.closeTo((orig(handles.jog) as DimensionEntity)[k].x, 9), y: expect.closeTo((orig(handles.jog) as DimensionEntity)[k].y, 9) });
      expect(shape(generateDimensionGeometry(back, jog).entities)).toEqual(shape(generateDimensionGeometry(doc, orig(handles.jog) as DimensionEntity).entities));
      // 지시선 ↔ 주석
      const ld = get(handles.leader) as LeaderEntity;
      expect(ld.annotation).toBe(handles.mtext);
      expect(ld.creation).toBe(0);
      expect(ld.vertices.length).toBe(3);
      expect(ld.vertices[1]).toMatchObject({ x: 217.5, y: 30 });
      expect((get(handles.mtext) as MTextEntity).reactors).toContain(handles.leader);
      // 공차
      expect((get(handles.tol) as ToleranceEntity).text).toBe((orig(handles.tol) as ToleranceEntity).text);
    });
  }
});
