import { describe, expect, it } from 'vitest';
import type { InsertEntity, LineEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { auditDocument, docStats } from '../../src/edit/util/audit';
import { createGroupOps, listGroups } from '../../src/edit/util/groups';
import { parseColor, parseLineweight, passesFilter, quickSelect, selectSimilar, similarKey, testProp, valueProblem } from '../../src/edit/util/select';
import { buildWblockDocument } from '../../src/edit/util/wblock';
import { writeDxf } from '../../src/io/dxf/writer';
import { readDxf } from '../../src/io/dxf/reader';
import { addBlock, circle, insert, line, put, setup, text } from './helpers';

describe('AUDIT', () => {
  it('깨끗한 새 도면은 오류가 없다', () => {
    const { doc } = setup();
    expect(auditDocument(doc).issues).toEqual([]);
  });

  it('없는 도면층·선종류·블록, 같은 핸들, 핸들 시드, 0 축척, 그룹 구성원을 찾고 고친다', () => {
    const { doc, s, h } = setup();
    const a = line(h(), 0, 0, 1, 0, { layer: 'GHOST', linetype: 'NOPE' });
    const b = insert(h(), 'MISSING', 0, 0);
    const c = circle(h(), 0, 0, 1);
    const d = circle(c.handle, 5, 5, 2); // 같은 핸들
    const e = line(h(), 0, 0, Number.NaN, 0);
    addBlock(doc, h, 'OK', [circle(h(), 0, 0, 1)]);
    const f = insert(h(), 'OK', 0, 0, { scale: { x: 0, y: 1, z: 1 } });
    put(doc, a, b, c, d, e, f);
    s.commit({ label: 'GROUP', ops: createGroupOps(doc, 'G', '', [a.handle, 'FFFF'], h)!.ops });
    doc.header.set('$HANDSEED', '1');
    doc.header.set('$CLAYER', 'GONE');
    const rep = auditDocument(doc);
    const msgs = rep.issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/도면층 "GHOST"/);
    expect(msgs).toMatch(/선종류 "NOPE"/);
    expect(msgs).toMatch(/블록 "MISSING"/);
    expect(msgs).toMatch(/같은 핸들/);
    expect(msgs).toMatch(/수가 아닙니다/);
    expect(msgs).toMatch(/축척이 0/);
    expect(msgs).toMatch(/핸들 시드/);
    expect(msgs).toMatch(/현재 도면층/);
    expect(msgs).toMatch(/없는 구성원 1개/);
    const fx = rep.fix(() => s.newHandle());
    expect(fx.erased).toBe(2);
    s.commit({ label: 'AUDIT', ops: fx.ops });
    const ms = doc.blocks.get(MODEL_SPACE)!.entities;
    expect(ms.length).toBe(4);
    expect(new Set(ms.map((x) => x.handle)).size).toBe(4);
    for (const x of ms) expect(doc.entityIndex.get(x.handle)).toBe(x);
    expect(doc.layers.has('GHOST')).toBe(true);
    expect((doc.entityIndex.get(a.handle) as LineEntity).linetype).toBe('ByLayer');
    expect((doc.entityIndex.get(f.handle) as InsertEntity).scale.x).toBe(1);
    expect(doc.header.get('$CLAYER')).toBe('0');
    expect(listGroups(doc)[0]!.group.entities).toEqual([a.handle]);
    expect(auditDocument(doc).issues).toEqual([]);
    s.undo();
    expect(doc.blocks.get(MODEL_SPACE)!.entities.length).toBe(6);
  });

  it('블록 자기 참조는 지운다', () => {
    const { doc, s, h } = setup();
    addBlock(doc, h, 'LOOP', [circle(h(), 0, 0, 1)]);
    doc.blocks.get('LOOP')!.entities.push(insert(h(), 'LOOP', 1, 1));
    const rep = auditDocument(doc);
    expect(rep.issues.some((i) => i.phase === 'blocks')).toBe(true);
    s.commit({ label: 'AUDIT', ops: rep.fix(() => s.newHandle()).ops });
    expect(doc.blocks.get('LOOP')!.entities.length).toBe(1);
  });

  it('STATUS 통계', () => {
    const { doc, h } = setup();
    put(doc, line(h(), 0, 0, 1, 1), circle(h(), 0, 0, 1), circle(h(), 2, 0, 1));
    const st = docStats(doc);
    expect(st.total).toBe(3);
    expect(st.byType.get('CIRCLE')).toBe(2);
    expect(st.bySpace[0]).toEqual({ name: 'Model', count: 3 });
  });
});

describe('특성으로 고르기', () => {
  it('색·선가중치 입력', () => {
    expect(parseColor('ByLayer')).toEqual({ aci: 256 });
    expect(parseColor('빨간색')).toEqual({ aci: 1 });
    expect(parseColor('255,0,0')).toEqual({ aci: 7, rgb: 0xff0000 });
    expect(parseColor('300')).toBeNull();
    expect(parseLineweight('0.25')).toBe(25);
    expect(parseLineweight('ByBlock')).toBe(-2);
    expect(valueProblem('radius', 'eq', 'abc')).toMatch(/수/);
    expect(valueProblem('color', 'eq', '빨간색')).toBeNull();
  });

  it('비교 연산', () => {
    const { h } = setup();
    const c = circle(h(), 0, 0, 2.5, { layer: 'WALL-1', color: { aci: 1 }, lineweight: 30 });
    expect(testProp(c, 'radius', 'eq', '2.5')).toBe(true);
    expect(testProp(c, 'radius', 'gt', '2')).toBe(true);
    expect(testProp(c, 'radius', 'lt', '2.5')).toBe(false);
    expect(testProp(c, 'layer', 'eq', 'wall-1')).toBe(true);
    expect(testProp(c, 'layer', 'eq', 'WALL*')).toBe(true);
    expect(testProp(c, 'layer', 'ne', 'WALL*')).toBe(false);
    expect(testProp(c, 'layer', 'wild', 'W?LL-#')).toBe(true);
    expect(testProp(c, 'color', 'eq', 'red')).toBe(true);
    expect(testProp(c, 'color', 'eq', 'ByLayer')).toBe(false);
    expect(testProp(c, 'lineweight', 'ge', '0.3')).toBe(true);
    expect(testProp(c, 'textHeight', 'any', '')).toBe(false);
    expect(testProp(c, 'type', 'eq', 'CIRCLE')).toBe(true);
    expect(testProp(c, 'type', 'eq', '원')).toBe(true);
  });

  it('QSELECT: 포함·제외, 종류', () => {
    const { doc, h } = setup();
    const a = circle(h(), 0, 0, 1);
    const b = circle(h(), 0, 0, 5);
    const c = line(h(), 0, 0, 10, 0);
    const t = text(h(), 0, 0, '펌프 P-101');
    put(doc, a, b, c, t);
    const scope = [a, b, c, t].map((e) => e.handle);
    expect(quickSelect(doc, scope, { types: ['CIRCLE'], prop: 'radius', op: 'gt', value: '2', include: true })).toEqual([b.handle]);
    expect(quickSelect(doc, scope, { types: ['CIRCLE'], prop: 'radius', op: 'gt', value: '2', include: false })).toEqual([a.handle, c.handle, t.handle]);
    expect(quickSelect(doc, scope, { types: [], prop: 'textValue', op: 'wild', value: '*P-1##', include: true })).toEqual([t.handle]);
    expect(quickSelect(doc, scope, { types: ['LINE'], prop: '', op: 'all', value: '', include: true })).toEqual([c.handle]);
    expect(quickSelect(doc, scope, { types: [], prop: 'length', op: 'eq', value: '10', include: true })).toEqual([c.handle]);
  });

  it('FILTER: 모든 행을 통과해야 한다', () => {
    const { h } = setup();
    const c = circle(h(), 0, 0, 3, { layer: 'A' });
    expect(passesFilter(c, [{ prop: 'type', op: 'eq', value: 'CIRCLE' }, { prop: 'radius', op: 'ge', value: '3' }])).toBe(true);
    expect(passesFilter(c, [{ prop: 'type', op: 'eq', value: 'CIRCLE' }, { prop: 'layer', op: 'eq', value: 'B' }])).toBe(false);
    expect(passesFilter(c, [{ prop: 'textStyle', op: 'any', value: '' }])).toBe(false);
  });

  it('SELECTSIMILAR: 기본(도면층 + 이름)과 비트', () => {
    const { doc, h } = setup();
    addBlock(doc, h, 'X', [circle(h(), 0, 0, 1)]);
    addBlock(doc, h, 'Y', [circle(h(), 0, 0, 1)]);
    const i1 = insert(h(), 'X', 0, 0, { layer: 'A' });
    const i2 = insert(h(), 'X', 5, 0, { layer: 'A', color: { aci: 1 } });
    const i3 = insert(h(), 'Y', 9, 0, { layer: 'A' });
    const i4 = insert(h(), 'X', 9, 9, { layer: 'B' });
    const c = circle(h(), 0, 0, 1, { layer: 'A' });
    put(doc, i1, i2, i3, i4, c);
    const all = [i1, i2, i3, i4, c].map((e) => e.handle);
    expect(selectSimilar(doc, [i1.handle], all, 130)).toEqual([i1.handle, i2.handle]);
    expect(selectSimilar(doc, [i1.handle], all, 131)).toEqual([i1.handle]);
    expect(selectSimilar(doc, [i1.handle], all, 0)).toEqual([i1.handle, i2.handle, i3.handle, i4.handle]);
    expect(similarKey(c, 2)).not.toBe(similarKey(i1, 2));
  });
});

describe('WBLOCK', () => {
  it('객체: 기준점이 원점, 쓰지 않는 도면층·블록은 빼고, DXF로 쓸 수 있다', () => {
    const { doc, h } = setup();
    doc.layers.set('USED', { ...doc.layers.get('0')!, name: 'USED', handle: h() });
    doc.layers.set('UNUSED', { ...doc.layers.get('0')!, name: 'UNUSED', handle: h() });
    addBlock(doc, h, 'B1', [circle(h(), 0, 0, 1, { layer: 'USED' })]);
    addBlock(doc, h, 'B2', [circle(h(), 0, 0, 1)]);
    const a = line(h(), 100, 100, 110, 100);
    const i = insert(h(), 'B1', 105, 105);
    const other = insert(h(), 'B2', 0, 0);
    put(doc, a, i, other);
    const r = buildWblockDocument(doc, { kind: 'objects', handles: [a.handle, i.handle], base: { x: 100, y: 100 } });
    const out = r.doc;
    expect(r.entities).toBe(2);
    const ms = out.blocks.get(MODEL_SPACE)!.entities;
    expect((ms[0] as LineEntity).start).toEqual({ x: 0, y: 0, z: 0 });
    expect((ms[1] as InsertEntity).insert).toEqual({ x: 5, y: 5, z: 0 });
    expect(out.blocks.has('B1')).toBe(true);
    expect(out.blocks.has('B2')).toBe(false);
    expect(out.layers.has('USED')).toBe(true);
    expect(out.layers.has('UNUSED')).toBe(false);
    expect(out.header.get('$INSBASE')).toEqual({ x: 0, y: 0, z: 0 });
    // 원본은 그대로
    expect(doc.blocks.get(MODEL_SPACE)!.entities.length).toBe(3);
    expect((doc.entityIndex.get(a.handle) as LineEntity).start.x).toBe(100);
    const back = readDxf(writeDxf(out, { version: 'AC1032' as never }).data);
    expect(back.blocks.get(MODEL_SPACE)!.entities.length).toBe(2);
    expect(back.layouts.length).toBe(2);
  });

  it('블록: 블록 내용이 모형 공간에(기준점 기준), 그 블록 정의는 없다', () => {
    const { doc, h } = setup();
    addBlock(doc, h, 'INNER', [circle(h(), 0, 0, 1)]);
    addBlock(doc, h, 'PART', [line(h(), 10, 10, 20, 10), insert(h(), 'INNER', 15, 15)], { x: 10, y: 10, z: 0 });
    doc.blockRecords.get('PART')!.insertUnits = 4;
    const r = buildWblockDocument(doc, { kind: 'block', name: 'PART' });
    const ms = r.doc.blocks.get(MODEL_SPACE)!.entities;
    expect((ms[0] as LineEntity).start).toEqual({ x: 0, y: 0, z: 0 });
    expect((ms[1] as InsertEntity).insert).toEqual({ x: 5, y: 5, z: 0 });
    expect(r.doc.blocks.has('PART')).toBe(false);
    expect(r.doc.blocks.has('INNER')).toBe(true);
    expect(r.doc.header.get('$INSUNITS')).toBe(4);
    for (const e of ms) expect(r.doc.entityIndex.get(e.handle)).toBe(e);
  });

  it('전체 도면: 쓰지 않는 블록만 뺀다', () => {
    const { doc, h } = setup();
    addBlock(doc, h, 'USED', [circle(h(), 0, 0, 1)]);
    addBlock(doc, h, 'UNUSED', [circle(h(), 0, 0, 1)]);
    put(doc, insert(h(), 'USED', 3, 3), line(h(), 0, 0, 1, 1));
    const r = buildWblockDocument(doc, { kind: 'all' });
    expect(r.entities).toBe(2);
    expect(r.doc.blocks.has('USED')).toBe(true);
    expect(r.doc.blocks.has('UNUSED')).toBe(false);
    expect(r.doc.layouts.length).toBe(doc.layouts.length);
  });
});
