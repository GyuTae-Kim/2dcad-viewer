import { describe, expect, it } from 'vitest';
import type { InsertEntity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { blockReaches, buildAttribs, burstInsert, countBlocks, purgeBlockOps, replaceBlockOps, syncedInsert } from '../../src/edit/util/blockutil';
import { addBlock, attdef, circle, insert, line, put, setup } from './helpers';

describe('속성 동기화(ATTSYNC)', () => {
  it('값은 태그로 지키고, 새 정의는 기본값, 없어진 정의는 뺀다', () => {
    const { doc, h } = setup();
    const def = addBlock(doc, h, 'TAG', [line(h(), 0, 0, 10, 0), attdef(h(), 'NO', '1', 0, 2), attdef(h(), 'NAME', 'x', 0, 5)]);
    const ins = insert(h(), 'TAG', 100, 50, { scale: { x: 2, y: 2, z: 1 } });
    ins.attribs = buildAttribs(def, ins, new Map([['NO', '7'], ['NAME', '펌프']]), h);
    expect(ins.attribs.map((a) => [a.tag, a.text, a.insert.x, a.insert.y, a.height])).toEqual([
      ['NO', '7', 100, 54, 5],
      ['NAME', '펌프', 100, 60, 5],
    ]);
    // 정의 바꾸기: NAME 지움, SIZE 더함, NO 자리 옮김
    def.entities = [def.entities[0]!, attdef(h(), 'SIZE', 'DN50', 3, 3), { ...def.entities[1]!, insert: { x: 1, y: 1, z: 0 } } as never];
    const keepH = ins.attribs[0]!.handle;
    const out = syncedInsert(def, ins, h)!;
    expect(out.attribs.map((a) => [a.tag, a.text])).toEqual([
      ['SIZE', 'DN50'],
      ['NO', '7'],
    ]);
    expect(out.attribs[1]!.handle).toBe(keepH);
    expect(out.attribs[1]!.insert).toEqual({ x: 102, y: 52, z: 0 });
    // 이미 맞으면 null
    expect(syncedInsert(def, out, h)).toBeNull();
  });

  it('상수 속성은 참조에 만들지 않는다', () => {
    const { doc, h } = setup();
    const def = addBlock(doc, h, 'C', [attdef(h(), 'K', 'const', 0, 0, 2), attdef(h(), 'V', 'v', 0, 0)]);
    const ins = insert(h(), 'C', 0, 0);
    expect(buildAttribs(def, ins, new Map(), h).map((a) => a.tag)).toEqual(['V']);
  });
});

describe('BCOUNT', () => {
  it('중첩 블록은 바깥 참조 수만큼 센다', () => {
    const { doc, h } = setup();
    addBlock(doc, h, 'BOLT', [circle(h(), 0, 0, 1)]);
    addBlock(doc, h, 'PLATE', [line(h(), 0, 0, 10, 0), insert(h(), 'BOLT', 1, 1), insert(h(), 'BOLT', 9, 1)]);
    const ents = [insert(h(), 'PLATE', 0, 0), insert(h(), 'PLATE', 20, 0), insert(h(), 'BOLT', 50, 0), line(h(), 0, 0, 1, 1)];
    expect(countBlocks(doc, ents, true)).toEqual([
      { name: 'BOLT', count: 5 },
      { name: 'PLATE', count: 2 },
    ]);
    expect(countBlocks(doc, ents, false)).toEqual([
      { name: 'PLATE', count: 2 },
      { name: 'BOLT', count: 1 },
    ]);
  });
});

describe('BURST', () => {
  it('속성은 값 문자로, 도면층 0과 ByBlock은 참조 특성으로', () => {
    const { doc, h } = setup();
    doc.layers.set('A', { ...doc.layers.get('0')!, name: 'A', handle: h(), color: { aci: 3 } });
    doc.layers.set('B', { ...doc.layers.get('0')!, name: 'B', handle: h(), color: { aci: 5 } });
    const def = addBlock(doc, h, 'P', [
      line(h(), 0, 0, 10, 0, { layer: '0', color: { aci: 0 } }),
      line(h(), 0, 0, 0, 10, { layer: 'B', color: { aci: 0 } }),
      line(h(), 0, 0, 5, 5, { layer: 'B', color: { aci: 1 } }),
      attdef(h(), 'NO', '1', 0, 2),
      attdef(h(), 'HID', 'h', 0, 3, 1),
    ]);
    const ins = insert(h(), 'P', 100, 0, { layer: 'A', color: { aci: 256 } });
    ins.attribs = buildAttribs(def, ins, new Map([['NO', 'P-101'], ['HID', 'secret']]), h);
    put(doc, ins);
    const r = burstInsert(ins, doc);
    expect(r.remove).toEqual([ins.handle]);
    const add = r.add!;
    const lines = add.filter((e) => e.type === 'LINE');
    expect(lines.map((e) => [e.layer, e.color.aci])).toEqual([
      ['A', 256],
      ['B', 3],
      ['B', 1],
    ]);
    const texts = add.filter((e): e is TextEntity => e.type === 'TEXT');
    expect(texts.map((t) => t.text)).toEqual(['P-101']);
    expect(texts[0]!.layer).toBe('A');
    expect((lines[0] as { start: { x: number } }).start.x).toBe(100);
  });
});

describe('BLOCKREPLACE', () => {
  it('참조를 바꾸고 속성 값은 태그로 지키며, 자기 참조가 될 자리는 건너뛴다', () => {
    const { doc, h } = setup();
    const a = addBlock(doc, h, 'A', [circle(h(), 0, 0, 1), attdef(h(), 'NO', '0', 0, 0)]);
    addBlock(doc, h, 'B', [line(h(), 0, 0, 1, 1), attdef(h(), 'NO', '0', 0, 1), attdef(h(), 'EXTRA', 'e', 0, 2)]);
    // C는 A를 품고, B는 C를 품는다 → C 안의 A를 B로 바꾸면 B ⊃ C ⊃ B
    addBlock(doc, h, 'C', [insert(h(), 'A', 0, 0)]);
    doc.blocks.get('B')!.entities.push(insert(h(), 'C', 5, 5));
    const i1 = insert(h(), 'A', 10, 0, { rotation: 0.5 });
    i1.attribs = buildAttribs(a, i1, new Map([['NO', '42']]), h);
    put(doc, i1);
    expect(blockReaches(doc, 'B', 'C')).toBe(true);
    expect(blockReaches(doc, 'C', 'B')).toBe(false);
    const r = replaceBlockOps(doc, 'A', 'B', h);
    expect(r.count).toBe(1);
    expect(r.skipped).toBe(1);
    const op = r.ops[0] as { kind: 'modify'; block: string; after: InsertEntity };
    expect(op.block).toBe(MODEL_SPACE);
    expect(op.after.block).toBe('B');
    expect(op.after.rotation).toBe(0.5);
    expect(op.after.attribs.map((x) => [x.tag, x.text])).toEqual([
      ['NO', '42'],
      ['EXTRA', 'e'],
    ]);
  });

  it('소거: 참조가 남으면 지우지 않는다', () => {
    const { doc, h, s } = setup();
    addBlock(doc, h, 'A', [circle(h(), 0, 0, 1)]);
    addBlock(doc, h, 'B', [circle(h(), 0, 0, 2)]);
    const i = insert(h(), 'A', 0, 0);
    put(doc, i);
    expect(purgeBlockOps(doc, 'A')).toEqual([]);
    s.commit({ label: 'BLOCKREPLACE', ops: replaceBlockOps(doc, 'A', 'B', h).ops });
    const p = purgeBlockOps(doc, 'A');
    expect(p.map((o) => o.kind)).toEqual(['blockDef', 'blockRecord']);
    s.commit({ label: 'P', ops: p });
    expect(doc.blocks.has('A')).toBe(false);
    s.undo();
    expect(doc.blocks.has('A')).toBe(true);
  });
});
