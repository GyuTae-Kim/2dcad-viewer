/** 주석 객체: 레코드 읽기, 표현, 주석 켜기·끄기, 축척 추가·삭제·전환, 따라가기, 복사본 */
import { describe, expect, it } from 'vitest';
import type { BlockDef, DimensionEntity, Entity, GenericObject, HatchEntity, InsertEntity, MLeaderEntity, MTextEntity, TextEntity, TextStyle } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import {
  ScaleIndex,
  addScales,
  annoState,
  cloneRecordsForCopy,
  contextRecords,
  findScale,
  followEdit,
  makeAnnotative,
  makeNonAnnotative,
  parseRecord,
  readScaleList,
  removeScales,
  representation,
  resetScales,
  scaleNames,
  switchScale,
  textFields,
  viewAt,
  wantsAnnotative,
  withAnnotativeFlag,
} from '../../src/edit/annoscale';
import { createDimension } from './dimfix';
import { addModel, commit, envOf, hatch, insert, mtext, newDoc, text } from './helpers';

function annotate<T extends Entity>(doc: Parameters<typeof envOf>[0], session: Parameters<typeof envOf>[1], e: T, scale: string): T {
  const r = makeAnnotative(envOf(doc, session), e, scale);
  commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: e, after: r.entity }]);
  return doc.entityIndex.get(e.handle) as T;
}

function apply<T extends Entity>(doc: Parameters<typeof envOf>[0], session: Parameters<typeof envOf>[1], e: T, r: { entity: Entity; ops: unknown[] }): T {
  commit(session, [...(r.ops as never[]), ...(r.entity !== e ? [{ kind: 'modify' as const, block: MODEL_SPACE, before: e, after: r.entity }] : [])]);
  return doc.entityIndex.get(e.handle) as T;
}

describe('AutoCAD 레코드 읽기', () => {
  it('실물 꼴의 TEXT 레코드(공백이 붙은 문자열 값)를 푼다', () => {
    const o: GenericObject = {
      type: 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS',
      handle: '3C6',
      raw: [
        { code: 100, value: 'AcDbObjectContextData' },
        { code: 70, value: '     4' },
        { code: 290, value: '     1' },
        { code: 100, value: 'AcDbAnnotScaleObjectContextData' },
        { code: 340, value: 'B7' },
        { code: 70, value: '     0' },
        { code: 50, value: '90.0' },
        { code: 10, value: '147.8194471194604' },
        { code: 20, value: '10.32574050131268' },
        { code: 11, value: '0.0' },
        { code: 21, value: '0.0' },
      ],
    };
    const r = parseRecord(o)!;
    expect(r.kind).toBe('text');
    expect(r.scale).toBe('B7');
    expect(r.isDefault).toBe(true);
    const f = textFields(r)!;
    expect(f.insert.x).toBeCloseTo(147.8194471194604);
    expect(f.rotation).toBeCloseTo(Math.PI / 2);
  });
});

describe('TEXT', () => {
  it('주석으로: 높이 × 배율, AcadAnnotative {1,1}, 기본 레코드 하나', () => {
    const { doc, session } = newDoc();
    let t = addModel(doc, session, text(10, 20, 2.5));
    t = annotate(doc, session, t, '1:50');
    expect(t.height).toBeCloseTo(125);
    expect(t.xdata?.[0]?.app).toBe('AcadAnnotative');
    const recs = contextRecords(doc, t);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.isDefault).toBe(true);
    expect(recs[0]!.type).toBe('ACDB_TEXTOBJECTCONTEXTDATA_CLASS');
    const st = annoState(doc, t)!;
    expect(st.current).toBe('1:50');
    expect(st.scales).toEqual(['1:50']);
  });

  it('축척 추가 → 다른 축척의 표현은 같은 자리, 높이 = 용지 높이 × 그 배율', () => {
    const { doc, session } = newDoc();
    let t = annotate(doc, session, addModel(doc, session, text(10, 20, 2.5)), '1:50');
    t = apply(doc, session, t, addScales(envOf(doc, session), t, ['1:100', '1:10']));
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, t, idx)!;
    expect(st.scales).toEqual(['1:50', '1:100', '1:10']);
    const r100 = representation(doc, t, st, '1:100', idx).entity as TextEntity;
    expect(r100.height).toBeCloseTo(250);
    expect(r100.insert.x).toBeCloseTo(10);
    const r10 = representation(doc, t, st, '1:10', idx).entity as TextEntity;
    expect(r10.height).toBeCloseTo(25);
    // 지원하지 않는 축척: ANNOALLVISIBLE 1이면 그대로, 0이면 숨김
    expect(viewAt(doc, t, '1:5', true, idx)!.entity).toBe(t);
    expect(viewAt(doc, t, '1:5', false, idx)).toBeNull();
    expect(scaleNames({ doc, idx }, t)).toEqual({ current: '1:50', scales: ['1:50', '1:100', '1:10'] });
  });

  it('보이는 축척 바꾸기(CANNOSCALE): 데이터 = 그 표현, 기본 레코드가 옮겨 간다, 명령 취소', () => {
    const { doc, session } = newDoc();
    let t = annotate(doc, session, addModel(doc, session, text(10, 20, 2.5)), '1:50');
    t = apply(doc, session, t, addScales(envOf(doc, session), t, ['1:100']));
    t = apply(doc, session, t, switchScale(envOf(doc, session), t, '1:100'));
    expect(t.height).toBeCloseTo(250);
    const st = annoState(doc, t)!;
    expect(st.current).toBe('1:100');
    expect(contextRecords(doc, t).filter((r) => r.isDefault)).toHaveLength(1);
    session.undo();
    expect((doc.entityIndex.get(t.handle) as TextEntity).height).toBeCloseTo(125);
    expect(annoState(doc, doc.entityIndex.get(t.handle)!)!.current).toBe('1:50');
  });

  it('축척 삭제: 보이는 축척을 지우면 남은 첫 축척을 보이고, 마지막 하나는 남긴다', () => {
    const { doc, session } = newDoc();
    let t = annotate(doc, session, addModel(doc, session, text(0, 0, 2)), '1:10');
    t = apply(doc, session, t, addScales(envOf(doc, session), t, ['1:20']));
    const r = removeScales(envOf(doc, session), t, ['1:10']);
    t = apply(doc, session, t, r);
    expect(annoState(doc, t)!.scales).toEqual(['1:20']);
    expect(t.height).toBeCloseTo(40);
    const r2 = removeScales(envOf(doc, session), t, ['1:20']);
    expect(r2.kept).toBe(true);
    expect(r2.ops).toHaveLength(0);
  });

  it('이동·회전을 따라간다: 다른 축척 레코드도 같은 닮음 변환', () => {
    const { doc, session } = newDoc();
    let t = annotate(doc, session, addModel(doc, session, text(10, 0, 2)), '1:10');
    t = apply(doc, session, t, addScales(envOf(doc, session), t, ['1:20']));
    const moved: TextEntity = { ...t, insert: { x: 110, y: 50, z: 0 }, rotation: Math.PI / 2 };
    const f = followEdit(envOf(doc, session), t, moved);
    commit(session, [...f.ops, { kind: 'modify', block: MODEL_SPACE, before: t, after: f.entity }]);
    t = doc.entityIndex.get(t.handle) as TextEntity;
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, t, idx)!;
    const r20 = representation(doc, t, st, '1:20', idx).entity as TextEntity;
    expect(r20.insert.x).toBeCloseTo(110);
    expect(r20.insert.y).toBeCloseTo(50);
    expect(r20.rotation).toBeCloseTo(Math.PI / 2);
    expect(r20.height).toBeCloseTo(40);
  });

  it('ANNORESET: 다른 축척의 위치를 지금 위치로', () => {
    const { doc, session } = newDoc();
    let t = annotate(doc, session, addModel(doc, session, text(10, 0, 2)), '1:10');
    t = apply(doc, session, t, addScales(envOf(doc, session), t, ['1:20']));
    t = apply(doc, session, t, switchScale(envOf(doc, session), t, '1:20'));
    // 1:20에서만 옮긴다(레코드 기본 = 1:20이므로 데이터만 바꾼다: 따라가기 없이)
    const only: TextEntity = { ...t, insert: { x: 99, y: 9, z: 0 } };
    const f = followEdit(envOf(doc, session), t, only);
    // 따라가기는 1:10 레코드도 옮긴다 → 따로 1:10 레코드만 되돌린 상태를 만들려고 ops 일부만 쓴다
    commit(session, [{ kind: 'modify', block: MODEL_SPACE, before: t, after: only }, ...f.ops.filter((o) => o.kind === 'object' && (o.after as GenericObject | null)?.raw?.some((x) => x.code === 290 && x.value === 1))]);
    t = doc.entityIndex.get(t.handle) as TextEntity;
    let idx = new ScaleIndex(doc);
    let st = annoState(doc, t, idx)!;
    expect((representation(doc, t, st, '1:10', idx).entity as TextEntity).insert.x).toBeCloseTo(10);
    t = apply(doc, session, t, resetScales(envOf(doc, session), t));
    idx = new ScaleIndex(doc);
    st = annoState(doc, t, idx)!;
    expect((representation(doc, t, st, '1:10', idx).entity as TextEntity).insert.x).toBeCloseTo(99);
  });

  it('복사본은 자기 사전과 레코드를 얻고, 레코드는 복사 자리로 옮겨진다', () => {
    const { doc, session } = newDoc();
    let t = annotate(doc, session, addModel(doc, session, text(10, 0, 2)), '1:10');
    t = apply(doc, session, t, addScales(envOf(doc, session), t, ['1:20']));
    const copy: TextEntity = { ...t, handle: session.newHandle(), insert: { x: 60, y: 0, z: 0 } };
    const r = cloneRecordsForCopy(envOf(doc, session), copy, undefined);
    expect(r.entity.xdict).not.toBe(t.xdict);
    commit(session, [...r.ops, { kind: 'add', block: MODEL_SPACE, entity: r.entity }]);
    const c = doc.entityIndex.get(copy.handle) as TextEntity;
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, c, idx)!;
    expect(st.scales).toEqual(['1:10', '1:20']);
    expect((representation(doc, c, st, '1:20', idx).entity as TextEntity).insert.x).toBeCloseTo(60);
    // 원본 레코드는 그대로
    const st0 = annoState(doc, t, idx)!;
    expect((representation(doc, t, st0, '1:20', idx).entity as TextEntity).insert.x).toBeCloseTo(10);
  });

  it('주석 아님: 용지 높이로 돌아가고 레코드를 지우며 {1,0}을 남긴다', () => {
    const { doc, session } = newDoc();
    let t = annotate(doc, session, addModel(doc, session, text(10, 0, 2)), '1:10');
    t = apply(doc, session, t, makeNonAnnotative(envOf(doc, session), t));
    expect(t.height).toBeCloseTo(2);
    expect(annoState(doc, t)).toBeNull();
    expect(contextRecords(doc, t)).toHaveLength(0);
    expect(t.xdata?.[0]?.items[3]?.value).toBe(0);
  });

  it('주석 문자 스타일의 새 문자는 주석이 되어야 한다(복사본·표지가 있는 것은 아니다)', () => {
    const { doc } = newDoc();
    const st: TextStyle = { ...doc.textStyles.get('STANDARD')!, name: 'Annotative', handle: 'FFF0', xdata: withAnnotativeFlag(undefined, true) };
    doc.textStyles.set('ANNOTATIVE', st);
    expect(wantsAnnotative(doc, text(0, 0, 1, 'Annotative'))).toBe(true);
    expect(wantsAnnotative(doc, text(0, 0, 1))).toBe(false);
    expect(wantsAnnotative(doc, { ...text(0, 0, 1, 'Annotative'), xdata: withAnnotativeFlag(undefined, false) })).toBe(false);
  });
});

describe('MTEXT', () => {
  it('레코드에 위치·폭을 두고 다른 축척은 폭·높이가 배율 비만큼', () => {
    const { doc, session } = newDoc();
    let m = annotate(doc, session, addModel(doc, session, mtext(0, 0, 3, 40)), '1:2');
    expect(m.height).toBeCloseTo(6);
    expect(m.width).toBeCloseTo(80);
    m = apply(doc, session, m, addScales(envOf(doc, session), m, ['1:4']));
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, m, idx)!;
    const r = representation(doc, m, st, '1:4', idx).entity as MTextEntity;
    expect(r.height).toBeCloseTo(12);
    expect(r.width).toBeCloseTo(160);
    expect(contextRecords(doc, m)[0]!.type).toBe('ACDB_MTEXTOBJECTCONTEXTDATA_CLASS');
  });
});

describe('주석 블록 참조', () => {
  function annoBlock(doc: Parameters<typeof envOf>[0]): void {
    const def: BlockDef = { name: 'TAG', handle: 'F100', recordHandle: 'F101', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] };
    doc.blocks.set('TAG', def);
    doc.blockRecords.set('TAG', { name: 'TAG', handle: 'F101', flags: 0, insertUnits: 0, explodable: true, scalable: true, xdata: withAnnotativeFlag(undefined, true) });
  }

  it('축척 × 배율, BLKREF 레코드, 속성은 삽입점 기준으로', () => {
    const { doc, session } = newDoc();
    annoBlock(doc);
    const ins = insert('TAG', 100, 0);
    ins.attribs = [{ ...text(102, 1, 2), type: 'ATTRIB', tag: 'A', attFlags: 0, handle: 'F200' } as never];
    let b = addModel(doc, session, ins);
    b = annotate(doc, session, b, '1:10');
    expect(b.scale.x).toBeCloseTo(10);
    expect(b.attribs[0]!.insert.x).toBeCloseTo(120);
    expect(b.attribs[0]!.height).toBeCloseTo(20);
    expect(contextRecords(doc, b)[0]!.type).toBe('ACDB_BLKREFOBJECTCONTEXTDATA_CLASS');
    expect(contextRecords(doc, b.attribs[0]!)[0]!.type).toBe('ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS');
    b = apply(doc, session, b, addScales(envOf(doc, session), b, ['1:20']));
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, b, idx)!;
    const r = representation(doc, b, st, '1:20', idx).entity as InsertEntity;
    expect(r.scale.x).toBeCloseTo(20);
    expect(r.attribs[0]!.insert.x).toBeCloseTo(140);
    expect(r.attribs[0]!.height).toBeCloseTo(40);
  });
});

describe('치수·해치·다중 지시선(AutoCAD 레코드)', () => {
  it('치수: DIMSCALE 재지정으로 다시 그리고, 축척마다 레코드와 그 축척의 익명 블록', () => {
    const { doc, session } = newDoc();
    let d = addModel(doc, session, createDimension(doc, session));
    d = annotate(doc, session, d, '1:10');
    expect(d.overrides?.[40]).toBe(10);
    expect(doc.blocks.get(tableKey(d.block))?.entities.length).toBeGreaterThan(0);
    d = apply(doc, session, d, addScales(envOf(doc, session), d, ['1:20']));
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, d, idx)!;
    expect(st.own).toBe(false);
    expect(st.records.map((r) => r.type)).toEqual(['ACDB_ALDIMOBJECTCONTEXTDATA_CLASS', 'ACDB_ALDIMOBJECTCONTEXTDATA_CLASS']);
    expect(st.scales).toEqual(['1:10', '1:20']);
    const v = representation(doc, d, st, '1:20', idx);
    // 그 축척의 그림은 레코드가 가리키는 진짜 블록(가상 블록 아님)
    expect(v.blocks).toBeUndefined();
    const b20 = (v.entity as DimensionEntity).block;
    expect(b20).not.toBe(d.block);
    expect(doc.blocks.get(tableKey(b20))?.entities.length).toBeGreaterThan(0);
    // 전환하면 그 블록·DIMSCALE 20
    d = apply(doc, session, d, switchScale(envOf(doc, session), d, '1:20'));
    expect(d.overrides?.[40]).toBe(20);
    expect(d.block).toBe(b20);
    expect(annoState(doc, d)!.current).toBe('1:20');
  });

  it('치수: 옮기면 다른 축척의 그림을 다시 만들고 쓰이지 않는 옛 블록은 지운다', () => {
    const { doc, session } = newDoc();
    let d = addModel(doc, session, createDimension(doc, session));
    d = annotate(doc, session, d, '1:10');
    d = apply(doc, session, d, addScales(envOf(doc, session), d, ['1:20']));
    const idx = new ScaleIndex(doc);
    const old20 = (representation(doc, d, annoState(doc, d, idx)!, '1:20', idx).entity as DimensionEntity).block;
    const moved: DimensionEntity = {
      ...d,
      defPoint: { ...d.defPoint, y: d.defPoint.y + 50 },
      defPoint2: { ...d.defPoint2, y: d.defPoint2.y + 50 },
      defPoint3: { ...d.defPoint3, y: d.defPoint3.y + 50 },
      textMid: { ...d.textMid, y: d.textMid.y + 50 },
    };
    const r = followEdit(envOf(doc, session), d, moved);
    d = apply(doc, session, d, { entity: r.entity, ops: [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: d, after: r.entity }] });
    const st = annoState(doc, d, new ScaleIndex(doc))!;
    const rep = representation(doc, d, st, '1:20', new ScaleIndex(doc)).entity as DimensionEntity;
    expect(rep.block).not.toBe(old20);
    expect(rep.textMid.y).toBeGreaterThan(60);
    expect(doc.blocks.has(tableKey(old20))).toBe(false);
    // 도면층만 바꾸면 레코드는 그대로
    const n = doc.objects.size;
    const r2 = followEdit(envOf(doc, session), d, { ...d, layer: 'X' });
    expect(r2.ops).toHaveLength(0);
    expect(doc.objects.size).toBe(n);
  });

  it('해치: 패턴 선 × 배율, 다른 축척은 배율 비', () => {
    const { doc, session } = newDoc();
    let h = addModel(doc, session, hatch());
    h = annotate(doc, session, h, '1:10');
    expect(h.patternLines[0]!.offset.y).toBeCloseTo(22.450640303);
    h = apply(doc, session, h, addScales(envOf(doc, session), h, ['1:5']));
    const idx = new ScaleIndex(doc);
    const st = annoState(doc, h, idx)!;
    const r = representation(doc, h, st, '1:5', idx).entity as HatchEntity;
    expect(r.patternLines[0]!.offset.y).toBeCloseTo(11.2253201515);
  });

  it('다중 지시선: 연결선 시작을 중심으로 배율', () => {
    const { doc, session } = newDoc();
    const ml: MLeaderEntity = {
      type: 'MULTILEADER',
      ...entityDefaults(),
      leaderLineType: 1,
      leaderLineColor: { aci: 0 },
      leaderLineWeight: -2,
      landing: true,
      dogleg: true,
      doglegLength: 8,
      arrowSize: 4,
      contentType: 2,
      textColor: { aci: 0 },
      textFrame: false,
      blockColor: { aci: 0 },
      blockScale: { x: 1, y: 1, z: 1 },
      blockRotation: 0,
      blockConnection: 0,
      scale: 1,
      context: {
        scale: 1,
        contentBase: { x: 20, y: 10, z: 0 },
        textHeight: 4,
        arrowSize: 4,
        landingGap: 2,
        leaders: [{ lastLeaderPoint: { x: 10, y: 10, z: 0 }, doglegVector: { x: 1, y: 0, z: 0 }, doglegLength: 8, hasLastPoint: true, hasDogleg: true, lines: [{ vertices: [{ x: 0, y: 0, z: 0 }], index: 0 }], index: 0, attachmentDirection: 0 }],
        text: { text: 'A', location: { x: 20, y: 12, z: 0 }, direction: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, rotation: 0, width: 0, height: 0, lineSpacingFactor: 1, lineSpacingStyle: 1, color: { aci: 0 }, attachment: 1, flowDirection: 1, backgroundFill: false, backgroundScale: 1.5 },
        basePoint: { x: 10, y: 10, z: 0 },
        baseDirection: { x: 1, y: 0, z: 0 },
        baseVertical: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
    };
    let m = addModel(doc, session, ml);
    m = annotate(doc, session, m, '1:2');
    expect(m.context.textHeight).toBeCloseTo(8);
    expect(m.context.text!.location.x).toBeCloseTo(30);
    expect(m.context.leaders[0]!.lastLeaderPoint!.x).toBeCloseTo(10);
    expect(m.context.leaders[0]!.lines[0]!.vertices[0]!.x).toBeCloseTo(0);
  });
});

describe('리스트가 없는 축척', () => {
  it('리스트에 없는 이름으로는 만들지 않는다', () => {
    const { doc, session } = newDoc();
    const t = addModel(doc, session, text(0, 0, 1));
    expect(() => makeAnnotative(envOf(doc, session), t, '7:3')).toThrow();
    expect(findScale(readScaleList(doc), '1:10')).toBeTruthy();
  });
});
