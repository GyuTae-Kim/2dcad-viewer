import { describe, expect, it } from 'vitest';
import { MODEL_SPACE } from '../../src/core/model';
import { SNAPSHOT_LAYERS, buildSnapshot, handleAllocator, planImport, stripEntity } from '../../src/edit/compare/transfer';
import { compareDrawings } from '../../src/edit/compare/match';
import { DEFAULT_OPTIONS } from '../../src/edit/compare/signature';
import { Doc, circle, insert, line } from './make';

describe('비교 도면 객체 가져오기 계획', () => {
  it('없는 도면층·블록을 가져오고, 같은 이름 블록은 받는 도면의 것을 쓴다', () => {
    const dst = new Doc();
    const src = new Doc(0x900);
    src.doc.layers.set('NEW', { name: 'New', handle: 'AA0', flags: 0, color: { aci: 3 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 });
    dst.block('PART', [line(0, 0, 1, 0)]);
    src.block('PART', [line(0, 0, 9, 9)]);
    src.block('OWN', [circle(0, 0, 1)]);
    src.block('*D1', [line(0, 0, 2, 0)]);
    dst.block('*D1', [line(0, 0, 3, 0)]);
    const l = { ...line(0, 0, 1, 1), layer: 'New' };
    const list = [l, insert('PART', 0, 0), insert('OWN', 0, 0), insert('*D1', 0, 0)].map((e) => stripEntity(structuredClone(e)));
    const alloc = handleAllocator(dst.doc);
    const plan = planImport(src.doc, dst.doc, list, alloc.next);
    expect(plan.layers.map((x) => x.name)).toEqual(['New']);
    expect(plan.blocks.map((b) => b.def.name).sort()).toEqual(['*D2', 'OWN']);
    expect(plan.rename.get('*D1')).toBe('*D2');
    const d = list[3]!;
    expect(d.type === 'INSERT' && d.block).toBe('*D2');
    // 새 핸들은 겹치지 않는다
    const hs = plan.blocks.flatMap((b) => [b.def.handle, b.record.handle, ...b.def.entities.map((e) => e.handle)]);
    for (const h of hs) expect(dst.doc.entityIndex.has(h)).toBe(false);
    expect(new Set(hs).size).toBe(hs.length);
  });
});

describe('스냅샷 도면', () => {
  it('도면층과 객체 수', () => {
    const a = new Doc();
    a.add(line(0, 0, 1, 0));
    a.add(line(0, 0, 0, 1));
    const b = a.clone();
    b.model.pop();
    b.add(circle(5, 5, 1));
    const r = compareDrawings(a.doc, b.doc, DEFAULT_OPTIONS);
    const snap = buildSnapshot({
      current: a.doc,
      compare: b.doc,
      onlyCurrent: r.onlyCurrent,
      onlyCompare: r.onlyCompare,
      clouds: [
        [
          { x: 0, y: 0, bulge: 0.5, startWidth: 0, endWidth: 0 },
          { x: 1, y: 0, bulge: 0.5, startWidth: 0, endWidth: 0 },
          { x: 1, y: 1, bulge: 0.5, startWidth: 0, endWidth: 0 },
        ],
      ],
      colors: { current: '82', compare: 'RGB:255,0,0', common: '253', cloud: 30 },
    });
    expect(snap.counts).toEqual({ current: 1, common: 1, compare: 1, clouds: 1 });
    const ms = snap.doc.blocks.get(MODEL_SPACE)!.entities;
    expect(ms.map((e) => e.layer)).toEqual([SNAPSHOT_LAYERS.common, SNAPSHOT_LAYERS.current, SNAPSHOT_LAYERS.compare, SNAPSHOT_LAYERS.cloud]);
    expect(ms.every((e) => e.color.aci === 256)).toBe(true);
    expect(snap.doc.layers.get(SNAPSHOT_LAYERS.compare.toUpperCase())!.color).toEqual({ aci: 1, rgb: 0xff0000 });
    // 원본은 그대로
    expect(a.model.every((e) => e.layer === '0')).toBe(true);
    // 새 핸들은 색인에 있다
    for (const e of ms) expect(snap.doc.entityIndex.get(e.handle)).toBe(e);
    expect(new Set(ms.map((e) => e.handle)).size).toBe(ms.length);
  });
});
