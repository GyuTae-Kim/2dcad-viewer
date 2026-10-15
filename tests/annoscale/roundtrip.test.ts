/** DXF 저장 → 다시 읽기: 축척 리스트·CANNOSCALE·TEXT/MTEXT/블록 참조/치수/해치 레코드·ANNOALLVISIBLE */
import { describe, expect, it } from 'vitest';
import type { BlockDef, Entity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { readCadFile } from '../../src/io/index';
import { writeDxf } from '../../src/io/dxf/writer';
import { ScaleIndex, addScales, allVisible, allVisibleOps, annoState, cannoscaleName, dictVarOps, makeAnnotative, readScaleList, representation, scaleListOps, withAnnotativeFlag } from '../../src/edit/annoscale';
import { createDimension } from './dimfix';
import { addModel, commit, envOf, hatch, insert, mtext, newDoc, text } from './helpers';

function annotate(doc: Parameters<typeof envOf>[0], session: Parameters<typeof envOf>[1], e: Entity, scales: string[]): string {
  const r = makeAnnotative(envOf(doc, session), e, scales[0]!);
  commit(session, [...r.ops, { kind: 'modify', block: MODEL_SPACE, before: e, after: r.entity }]);
  const cur = doc.entityIndex.get(e.handle)!;
  const a = addScales(envOf(doc, session), cur, scales.slice(1));
  commit(session, [...a.ops, ...(a.entity !== cur ? [{ kind: 'modify' as const, block: MODEL_SPACE, before: cur, after: a.entity }] : [])]);
  return e.handle;
}

describe('DXF 왕복', () => {
  it('레코드·변수가 다시 읽힌다', () => {
    const { doc, session } = newDoc('metric');
    // 축척 하나 더(이름 바꾸기 포함)
    const list = readScaleList(doc);
    commit(session, scaleListOps(doc, [...list, { name: '사용자 1:25', paper: 1, drawing: 25, unit: false }], () => session.newHandle()).ops);
    const def: BlockDef = { name: 'TAG', handle: session.newHandle(), recordHandle: session.newHandle(), basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [] };
    doc.blocks.set('TAG', def);
    doc.blockRecords.set('TAG', { name: 'TAG', handle: def.recordHandle, flags: 0, insertUnits: 0, explodable: true, scalable: true, xdata: withAnnotativeFlag(undefined, true) });
    const t = annotate(doc, session, addModel(doc, session, text(10, 20, 2.5)), ['1:10', '사용자 1:25']);
    const m = annotate(doc, session, addModel(doc, session, mtext(0, 50, 2.5, 30)), ['1:10', '1:20']);
    const b = annotate(doc, session, addModel(doc, session, insert('TAG', 100, 0)), ['1:10', '1:20']);
    const d = annotate(doc, session, addModel(doc, session, createDimension(doc, session)), ['1:10', '1:20']);
    const h = annotate(doc, session, addModel(doc, session, hatch()), ['1:10', '1:20']);
    commit(session, dictVarOps(doc, 'CANNOSCALE', '1:10', () => session.newHandle()));
    commit(session, allVisibleOps(doc, MODEL_SPACE, false));
    const out = writeDxf(doc, { version: 'AC1032' as never });
    const back = readCadFile(out.data, 'rt.dxf');
    expect(readScaleList(back).map((s) => s.name)).toContain('사용자 1:25');
    expect(cannoscaleName(back)).toBe('1:10');
    expect(allVisible(back, MODEL_SPACE)).toBe(false);
    const idx = new ScaleIndex(back);
    const sc = (hh: string) => annoState(back, back.entityIndex.get(hh)!, idx);
    expect(sc(t)?.scales).toEqual(['1:10', '사용자 1:25'.toUpperCase()]);
    expect(sc(t)?.own).toBe(false);
    expect(sc(m)?.scales).toEqual(['1:10', '1:20']);
    expect(sc(b)?.scales).toEqual(['1:10', '1:20']);
    expect(sc(d)?.scales).toEqual(['1:10', '1:20']);
    expect(sc(d)?.own).toBe(false);
    expect(sc(h)?.own).toBe(false);
    expect(sc(h)?.scales).toEqual(['1:10', '1:20']);
    const te = back.entityIndex.get(t)!;
    const r = representation(back, te, sc(t)!, '사용자 1:25', idx).entity as { height: number };
    expect(r.height).toBeCloseTo(62.5);
    // 레코드 클래스가 CLASSES에 있는지(없으면 AutoCAD가 객체를 읽지 못한다)
    const txt = new TextDecoder().decode(out.data);
    const hasClass = /CLASS\r?\n\s*1\r?\nACDB_TEXTOBJECTCONTEXTDATA_CLASS/.test(txt);
    console.log('CLASSES에 TEXT 컨텍스트 클래스:', hasClass);
  });
});
