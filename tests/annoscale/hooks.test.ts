/** 편집 고리: 새 주석 객체(주석 스타일·주석 블록·주석 치수 스타일), 확장 사전을 뗀 복사본, CANNOSCALE 전환·ANNOAUTOSCALE */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockDef, DimensionEntity, Entity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import { DocState } from '../../src/app/docstate';
import { annotateTransaction, normalizeShown, setAnnoAutoscale, setCannoscale, shownScale, upgradeOwnOnOpen } from '../../src/app/annoscale-core';
import type { App } from '../../src/app/app';
import { ScaleIndex, addScales, annoState, contextRecords, dictVarOps, dimFields, readScaleList, regenerateDimension, representation, withAnnotativeFlag, withOwnRecord } from '../../src/edit/annoscale';
import { EditSession, type EditOp, type Transaction } from '../../src/edit/session';
import { createLinearDimension } from '../../src/edit/dim/create';
import { envOf, insert, newDoc, text } from './helpers';

function setup() {
  const { doc } = newDoc('metric');
  const st = new DocState(1, doc, 't.dxf', 0, 0);
  const app = { lastSelection: [] as string[], active: st, docs: [st] } as unknown as App;
  st.session = new EditSession(doc, () => {});
  const raw = st.session.commit.bind(st.session);
  st.session.commit = (tx: Transaction) => raw(annotateTransaction(app, st, tx));
  doc.textStyles.set('ANNOTATIVE', { ...doc.textStyles.get('STANDARD')!, name: 'Annotative', handle: 'FFF1', xdata: withAnnotativeFlag(undefined, true) });
  return { doc, st, app };
}

const add = (st: DocState, e: Entity, extra: EditOp[] = []) => {
  e.handle ||= st.session.newHandle();
  st.session.commit({ label: 'TEST', ops: [...extra, { kind: 'add', block: MODEL_SPACE, entity: e }] });
  return st.doc.entityIndex.get(e.handle)!;
};

describe('편집 고리', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('주석 문자 스타일의 새 TEXT는 지금 CANNOSCALE로 주석이 된다(높이 = 용지 높이 × 배율)', () => {
    setCannoscale(s.app, s.st, '1:20', 1);
    const t = add(s.st, text(0, 0, 2.5, 'Annotative')) as TextEntity;
    expect(t.height).toBeCloseTo(50);
    expect(annoState(s.doc, t)?.scales).toEqual(['1:20']);
    // 명령 취소 한 번에 객체와 레코드가 함께 빠진다
    s.st.session.undo();
    expect(s.doc.entityIndex.get(t.handle)).toBeUndefined();
    expect([...s.doc.objects.values()].some((o) => o.type === 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS')).toBe(false);
  });

  it('주석 블록의 새 참조는 축척 × 배율, 복사본(확장 사전 없음)은 원본의 축척을 복사 자리에 갖는다', () => {
    const def: BlockDef = { name: 'TAG', handle: 'F100', recordHandle: 'F101', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] };
    s.doc.blocks.set('TAG', def);
    s.doc.blockRecords.set('TAG', { name: 'TAG', handle: 'F101', flags: 0, insertUnits: 0, explodable: true, scalable: true, xdata: withAnnotativeFlag(undefined, true) });
    setCannoscale(s.app, s.st, '1:10', 1);
    let b = add(s.st, insert('TAG', 0, 0));
    expect((b as { scale: { x: number } }).scale.x).toBeCloseTo(10);
    const a = addScales(envOf(s.doc, s.st.session), b, ['1:20']);
    s.st.session.commit({ label: 'X', ops: [...a.ops, ...(a.entity !== b ? [{ kind: 'modify' as const, block: MODEL_SPACE, before: b, after: a.entity }] : [])] });
    b = s.doc.entityIndex.get(b.handle)!;
    // 복사 명령처럼: 확장 사전을 뗀 같은 객체를 옆에
    s.app.lastSelection = [b.handle];
    const copy = { ...b, handle: '', insert: { x: 500, y: 0, z: 0 } } as Entity;
    delete copy.xdict;
    const c = add(s.st, copy);
    expect((c as { scale: { x: number } }).scale.x).toBeCloseTo(10);
    const idx = new ScaleIndex(s.doc);
    const stc = annoState(s.doc, c, idx)!;
    expect(stc.scales).toEqual(['1:10', '1:20']);
    expect((representation(s.doc, c, stc, '1:20', idx).entity as { insert: { x: number } }).insert.x).toBeCloseTo(500);
    expect(c.xdict).not.toBe(b.xdict);
  });

  it('주석 치수 스타일의 새 치수는 DIMSCALE = 배율로 다시 그리고, 명령이 만든 옛 블록은 넣지 않는다', () => {
    const std = s.doc.dimStyles.get('STANDARD') ?? [...s.doc.dimStyles.values()][0]!;
    s.doc.dimStyles.set('ANNO', { ...std, name: 'Anno', handle: 'FFF2', xdata: withAnnotativeFlag(undefined, true) });
    setCannoscale(s.app, s.st, '1:5', 1);
    const d = createLinearDimension(s.doc, { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 50, y: 20, z: 0 }, { style: 'Anno' });
    const ops: EditOp[] = [];
    const withBlock = regenerateDimension(envOf(s.doc, s.st.session), d, null, ops);
    const before = s.doc.blocks.size;
    const out = add(s.st, withBlock, ops) as DimensionEntity;
    expect(out.overrides?.[40]).toBe(5);
    expect(out.block).not.toBe(withBlock.block);
    expect(s.doc.blocks.has(tableKey(withBlock.block))).toBe(false);
    expect(s.doc.blocks.size).toBe(before + 1);
    expect(annoState(s.doc, out)?.scales).toEqual(['1:5']);
  });

  it('CANNOSCALE: 리스트가 없는 도면은 리스트부터 만들고, 지원 객체는 그 표현을 보인다. ANNOAUTOSCALE은 축척을 더한다', () => {
    setCannoscale(s.app, s.st, '1:10', 1);
    const t = add(s.st, text(0, 0, 2, 'Annotative')) as TextEntity;
    expect(t.height).toBeCloseTo(20);
    setCannoscale(s.app, s.st, '1:1', 2);
    // 1:1을 지원하지 않으므로 그대로
    expect((s.doc.entityIndex.get(t.handle) as TextEntity).height).toBeCloseTo(20);
    expect(shownScale(s.app).scale?.name).toBe('1:1');
    expect(readScaleList(s.doc).length).toBe(17);
    expect(contextRecords(s.doc, t)).toHaveLength(1);
    // ANNOAUTOSCALE 4: 바꾸기 전 축척(1:1)을 지원하던 객체가 아니므로 그대로, 1:10으로 돌아간 뒤 1:50으로 바꾸면 더해진다
    setAnnoAutoscale(4);
    try {
      setCannoscale(s.app, s.st, '1:10', 3);
      setCannoscale(s.app, s.st, '1:50', 4);
      const t2 = s.doc.entityIndex.get(t.handle) as TextEntity;
      expect(annoState(s.doc, t2)?.scales).toEqual(['1:10', '1:50']);
      expect(t2.height).toBeCloseTo(100);
      s.st.session.undo();
      expect(annoState(s.doc, s.doc.entityIndex.get(t.handle)!)?.scales).toEqual(['1:10']);
    } finally {
      setAnnoAutoscale(-4);
    }
  });

  it('연 도면 맞추기: CANNOSCALE의 레코드가 있으면 데이터를 그 표현으로(명령 취소 기록 없이, 워커에도)', () => {
    setCannoscale(s.app, s.st, '1:1', 1);
    const t = add(s.st, text(0, 0, 2, 'Annotative')) as TextEntity;
    const a = addScales(envOf(s.doc, s.st.session), t, ['1:4']);
    s.st.session.commit({ label: 'X', ops: a.ops });
    // AutoCAD가 CANNOSCALE만 1:4로 바꿔 저장한 것처럼(기본 레코드는 1:1)
    s.st.session.commit({ label: 'X', ops: dictVarOps(s.doc, 'CANNOSCALE', '1:4', () => s.st.session.newHandle()) });
    const sent: unknown[] = [];
    (s.app as unknown as { engine: { edit: (id: number, ops: unknown[]) => void } }).engine = { edit: (_id, ops) => sent.push(...ops) };
    const depth = s.st.session.depth;
    expect(normalizeShown(s.app, s.st)).toBe(1);
    const t2 = s.doc.entityIndex.get(t.handle) as TextEntity;
    expect(t2.height).toBeCloseTo(8);
    expect(annoState(s.doc, t2)?.current).toBe('1:4');
    expect(s.st.session.depth).toBe(depth);
    expect(sent.length).toBeGreaterThan(0);
    expect(normalizeShown(s.app, s.st)).toBe(0);
  });

  it('연 도면 맞추기: 예전 빌드의 자체 기록(치수·해치)을 AutoCAD 레코드로(명령 취소 기록 없이, 워커에도)', () => {
    const ops: EditOp[] = [];
    const d0 = createLinearDimension(s.doc, { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 50, y: 20, z: 0 });
    const d1 = regenerateDimension(envOf(s.doc, s.st.session), d0, 10, ops);
    s.st.session.commit({ label: 'DIM', ops });
    const own = { current: '1:10', scales: ['1:10', '1:20'] };
    const d = add(s.st, { ...d1, xdata: withOwnRecord(undefined, own) }) as DimensionEntity;
    expect(annoState(s.doc, d)?.own).toBe(true);
    const sent: unknown[] = [];
    (s.app as unknown as { engine: { edit: (id: number, ops: unknown[]) => void } }).engine = { edit: (_id, o) => sent.push(...o) };
    const depth = s.st.session.depth;
    expect(upgradeOwnOnOpen(s.app, s.st)).toBe(1);
    const now = s.doc.entityIndex.get(d.handle) as DimensionEntity;
    const st = annoState(s.doc, now)!;
    expect(st.own).toBe(false);
    expect(st.scales).toEqual(['1:10', '1:20']);
    expect(st.records).toHaveLength(2);
    expect(dimFields(st.byScale.get('1:10')!)!.block).toBe(now.block);
    expect(s.doc.blocks.get(tableKey(dimFields(st.byScale.get('1:20')!)!.block))?.entities.length).toBeGreaterThan(0);
    expect(now.xdata?.some((x) => x.app === 'OPENCAD_ANNOSCALE')).toBeFalsy();
    expect(s.st.session.depth).toBe(depth);
    expect(sent.length).toBeGreaterThan(0);
    expect(upgradeOwnOnOpen(s.app, s.st)).toBe(0);
  });

  it('주석 치수를 옮기면(다른 편집) 편집 고리가 다른 축척의 그림과 레코드를 다시 만든다', () => {
    s.doc.dimStyles.set('ANNO', { ...s.doc.dimStyles.get('STANDARD')!, name: 'Anno', handle: 'FFF2', xdata: withAnnotativeFlag(undefined, true) });
    setCannoscale(s.app, s.st, '1:10', 1);
    const ops: EditOp[] = [];
    const d0 = createLinearDimension(s.doc, { x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 50, y: 20, z: 0 }, { style: 'Anno' });
    const d1 = regenerateDimension(envOf(s.doc, s.st.session), d0, null, ops);
    s.st.session.commit({ label: 'DIM', ops });
    let d = add(s.st, d1) as DimensionEntity;
    const a = addScales(envOf(s.doc, s.st.session), d, ['1:20']);
    s.st.session.commit({ label: 'X', ops: [...a.ops, { kind: 'modify', block: MODEL_SPACE, before: d, after: a.entity }] });
    d = s.doc.entityIndex.get(d.handle) as DimensionEntity;
    const rec20 = () => contextRecords(s.doc, s.doc.entityIndex.get(d.handle)!).find((r) => !r.isDefault)!;
    const before = dimFields(rec20())!;
    const moved: DimensionEntity = { ...d, defPoint: { ...d.defPoint, y: d.defPoint.y + 30 }, textMid: { ...d.textMid, y: d.textMid.y + 30 } };
    s.st.session.commit({ label: 'MOVE', ops: [{ kind: 'modify', block: MODEL_SPACE, before: d, after: moved }] });
    const after = dimFields(rec20())!;
    expect(after.block).not.toBe(before.block);
    expect(after.points![0]!.y).toBeCloseTo(d.defPoint.y + 30);
    expect(s.doc.blocks.has(tableKey(before.block))).toBe(false);
    // 명령 취소하면 옛 레코드와 그림이 돌아온다
    s.st.session.undo();
    expect(dimFields(rec20())!.block).toBe(before.block);
    expect(s.doc.blocks.has(tableKey(before.block))).toBe(true);
  });
});
