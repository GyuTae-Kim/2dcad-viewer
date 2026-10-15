/** 외부 참조: XATTACH 정의·의존 기호, XBIND 이름 바꾸기(참조$n$이름), BLOCKTOXREF, DXF·DWG 왕복 */
import { describe, expect, it } from 'vitest';
import type { CadDocument, InsertEntity, Layer } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { blockToXrefOps, dependentSymbols, xbindOps, xrefAttachOps, xrefNameFromFile } from '../../src/edit/blkcmds/xref';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';
import { readCadFile } from '../../src/io/index';
import { addBlock, attdef, insert, line, put, setup } from '../util2/helpers';

const props = () => {
  const { handle: _h, ...rest } = entityDefaults();
  return rest;
};

function xrefDrawing(): CadDocument {
  const x = setup();
  const d = x.doc;
  d.header.set('$INSBASE', { x: 5, y: 5, z: 0 });
  d.header.set('$INSUNITS', 4);
  d.linetypes.set('DASHED', { name: 'DASHED', handle: x.h(), flags: 0, description: '__ __', patternLength: 1, elements: [{ length: 0.5, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }, { length: -0.5, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }] });
  d.layers.set('WALL', { ...d.layers.get('0')!, name: 'WALL', handle: x.h(), color: { aci: 1 }, linetype: 'DASHED' });
  d.textStyles.set('ROMANS', { name: 'ROMANS', handle: x.h(), flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'romans.shx', bigFont: '' });
  addBlock(d, x.h, 'DOOR', [{ ...line(x.h(), 0, 0, 0, 9), layer: 'WALL' }]);
  put(d, { ...line(x.h(), 0, 0, 100, 0), layer: 'WALL' });
  return d;
}

function host() {
  const t = setup();
  t.doc.header.set('$INSUNITS', 4);
  return t;
}

describe('XATTACH', () => {
  it('외부 참조 블록(플래그 4·32, 객체 없음, 기준점 = 참조 도면 INSBASE)·의존 기호·참조', () => {
    const t = host();
    const x = xrefDrawing();
    const r = xrefAttachOps(t.doc, { name: 'plan', path: 'plan.dwg', overlay: false, xdoc: x }, { space: MODEL_SPACE, insert: { x: 1, y: 2, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, props: props() }, t.h);
    t.s.commit({ label: 'XATTACH', ops: r.ops });
    const b = t.doc.blocks.get('PLAN')!;
    expect(b.flags).toBe(4 | 32);
    expect(b.xrefPath).toBe('plan.dwg');
    expect(b.entities).toEqual([]);
    expect(b.basePoint).toEqual({ x: 5, y: 5, z: 0 });
    expect(t.doc.blockRecords.get('PLAN')!.insertUnits).toBe(4);
    const wall = t.doc.layers.get('PLAN|WALL')!;
    expect(wall.flags & 48).toBe(48);
    expect(wall.linetype).toBe('plan|DASHED');
    expect(t.doc.linetypes.has('PLAN|DASHED')).toBe(true);
    expect(t.doc.textStyles.has('PLAN|ROMANS')).toBe(true);
    expect(t.doc.layers.has('PLAN|0')).toBe(false);
    const ins = t.doc.entityIndex.get(r.insert.handle) as InsertEntity;
    expect(ins.block).toBe('plan');
    expect(ins.owner).toBe(t.doc.blocks.get(MODEL_SPACE)!.recordHandle);
    // 두 번째 부착은 정의를 다시 쓴다
    const r2 = xrefAttachOps(t.doc, { name: 'PLAN', path: 'plan.dwg', overlay: false, xdoc: x }, { space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, props: props() }, t.h);
    expect(r2.created).toBe(false);
    expect(r2.ops).toHaveLength(1);
    // 같은 이름의 보통 블록이면 오류
    addBlock(t.doc, t.h, 'B1', []);
    expect(() => xrefAttachOps(t.doc, { name: 'b1', path: 'b1.dwg', overlay: true, xdoc: null }, { space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, props: props() }, t.h)).toThrow();
  });

  it('파일 이름 → 참조 이름', () => {
    expect(xrefNameFromFile('C:\\dwg\\1층 평면.DWG')).toBe('1층 평면');
    expect(xrefNameFromFile('a;b.dxf')).toBe('a_b');
  });

  it('DXF·DWG로 쓰고 다시 읽어도 외부 참조와 의존 도면층이 남는다', () => {
    const t = host();
    const x = xrefDrawing();
    const r = xrefAttachOps(t.doc, { name: 'plan', path: 'plan.dwg', overlay: true, xdoc: x }, { space: MODEL_SPACE, insert: { x: 1, y: 2, z: 0 }, scale: { x: 2, y: 2, z: 2 }, rotation: 0.5, props: props() }, t.h);
    t.s.commit({ label: 'XATTACH', ops: r.ops });
    for (const [name, data] of [
      ['a.dxf', writeDxf(t.doc).data],
      ['a.dwg', writeDwg(t.doc).data],
    ] as const) {
      const back = readCadFile(data, name);
      const b = back.blocks.get('PLAN')!;
      expect(b.flags & 4, name).toBe(4);
      expect(b.flags & 8, name).toBe(8);
      expect(b.xrefPath, name).toBe('plan.dwg');
      expect(back.layers.has('PLAN|WALL'), name).toBe(true);
      const ins = [...back.blocks.get(MODEL_SPACE)!.entities].find((e) => e.type === 'INSERT') as InsertEntity;
      expect(ins.block.toUpperCase(), name).toBe('PLAN');
      expect(ins.scale.x, name).toBeCloseTo(2);
    }
  });
});

describe('XBIND', () => {
  function attached() {
    const t = host();
    const x = xrefDrawing();
    const r = xrefAttachOps(t.doc, { name: 'X', path: 'x.dwg', overlay: false, xdoc: x }, { space: MODEL_SPACE, insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, props: props() }, t.h);
    t.s.commit({ label: 'XATTACH', ops: r.ops });
    // 호스트에서 재지정한 상태(초록)
    const l = t.doc.layers.get('X|WALL')!;
    t.doc.layers.set('X|WALL', { ...l, color: { aci: 3 } });
    return { ...t, x };
  }

  it('의존 기호 목록(참조 도면이 없으면 호스트 레코드만)', () => {
    const { doc, x } = attached();
    const withFile = dependentSymbols(doc, 'X', x);
    expect(withFile.layer).toEqual(['WALL']);
    expect(withFile.block).toEqual(['DOOR']);
    expect(withFile.linetype).toEqual(['DASHED']);
    const noFile = dependentSymbols(doc, 'X', null);
    expect(noFile.block).toEqual([]);
    expect(noFile.layer).toEqual(['WALL']);
  });

  it('도면층 결합: X|WALL → X$0$WALL(재지정 색 유지), 선종류도 X$0$DASHED로, 의존 레코드는 지운다', () => {
    const t = attached();
    const r = xbindOps(t.doc, 'X', [{ kind: 'layer', name: 'X|WALL' }], null, t.h);
    expect(r.bound).toEqual([{ kind: 'layer', from: 'X|WALL', to: 'X$0$WALL' }]);
    t.s.commit({ label: 'XBIND', ops: r.ops });
    const l = t.doc.layers.get('X$0$WALL') as Layer;
    expect(l.color.aci).toBe(3);
    expect(l.flags & 48).toBe(0);
    expect(l.linetype).toBe('X$0$DASHED');
    expect(t.doc.linetypes.get('X$0$DASHED')!.flags & 48).toBe(0);
    expect(t.doc.layers.has('X|WALL')).toBe(false);
    // 다른 의존 도면층이 쓰지 않으면 의존 선종류는 남긴다(결합을 고르지 않았으므로)
    expect(t.doc.linetypes.has('X|DASHED')).toBe(true);
    // 다시 결합하면(재로드 뒤 되살아난 의존 기호) 다음 번호
    t.doc.layers.set('X|WALL', { ...l, name: 'X|WALL', flags: 48, linetype: 'X|DASHED' });
    const r2 = xbindOps(t.doc, 'X', [{ kind: 'layer', name: 'WALL' }], null, t.h);
    expect(r2.bound[0]!.to).toBe('X$1$WALL');
  });

  it('블록 결합은 참조 도면이 있어야 하고, 블록이 쓰는 도면층도 함께 결합한다', () => {
    const t = attached();
    const none = xbindOps(t.doc, 'X', [{ kind: 'block', name: 'DOOR' }], null, t.h);
    expect(none.failed).toHaveLength(1);
    const r = xbindOps(t.doc, 'X', [{ kind: 'block', name: 'DOOR' }], t.x, t.h);
    t.s.commit({ label: 'XBIND', ops: r.ops });
    const b = t.doc.blocks.get(tableKey('X$0$DOOR'))!;
    expect(b.entities).toHaveLength(1);
    expect(b.entities[0]!.layer).toBe('X$0$WALL');
    // 블록 결합에 딸려 만든 도면층은 호스트 재지정 상태를 받는다
    expect(t.doc.layers.get('X$0$WALL')!.color.aci).toBe(3);
    // 블록만 결합했으므로 의존 도면층은 남는다
    expect(t.doc.layers.has('X|WALL')).toBe(true);
  });

  it('문자 스타일·치수 스타일 결합과 이 도면 객체의 이름 바꾸기', () => {
    const t = attached();
    // 이 도면의 객체가 의존 도면층에 있으면(정상은 아니지만) 새 이름으로 옮긴다
    put(t.doc, { ...line('Q1', 0, 0, 1, 1), layer: 'X|WALL' });
    const r = xbindOps(
      t.doc,
      'X',
      [
        { kind: 'textStyle', name: 'ROMANS' },
        { kind: 'layer', name: 'WALL' },
        { kind: 'layer', name: '0' },
      ],
      null,
      t.h,
    );
    expect(r.failed).toEqual([{ kind: 'layer', name: '0' }]);
    t.s.commit({ label: 'XBIND', ops: r.ops });
    expect(t.doc.textStyles.has('X$0$ROMANS')).toBe(true);
    expect(t.doc.textStyles.has('X|ROMANS')).toBe(false);
    expect(t.doc.entityIndex.get('Q1')!.layer).toBe('X$0$WALL');
    t.s.undo();
    expect(t.doc.entityIndex.get('Q1')!.layer).toBe('X|WALL');
    expect(t.doc.layers.has('X|WALL')).toBe(true);
  });
});

describe('BLOCKTOXREF', () => {
  it('모든 참조(블록 안 포함)를 외부 참조로, 속성은 빠지고, 소거하면 블록 정의를 지운다', () => {
    const t = host();
    addBlock(t.doc, t.h, 'DOOR', [line(t.h(), 0, 0, 1, 0), attdef(t.h(), 'NO', '1', 0, 0)]);
    const inner = insert('C1', 'DOOR', 0, 0);
    addBlock(t.doc, t.h, 'WALLSET', [inner]);
    put(t.doc, insert('A1', 'DOOR', 5, 5, { rotation: 1, layer: '0', attribs: [{ ...attdef('B1', 'NO', '7', 5, 5), type: 'ATTRIB', owner: 'A1' }] }), insert('A2', 'DOOR', 9, 9));
    const r = blockToXrefOps(t.doc, 'door', { name: 'door-std', path: 'door-std.dwg', overlay: false, xdoc: xrefDrawing() }, true, t.h);
    expect(r.count).toBe(3);
    expect(r.droppedAttribs).toBe(1);
    expect(r.purged).toBe(true);
    t.s.commit({ label: 'BLOCKTOXREF', ops: r.ops });
    expect(t.doc.blocks.has('DOOR')).toBe(false);
    expect(t.doc.blocks.get('DOOR-STD')!.flags & 4).toBe(4);
    const a1 = t.doc.entityIndex.get('A1') as InsertEntity;
    expect(a1.block).toBe('door-std');
    expect(a1.attribs).toEqual([]);
    expect(a1.rotation).toBe(1);
    expect(t.doc.entityIndex.has('B1')).toBe(false);
    expect((t.doc.blocks.get('WALLSET')!.entities[0] as InsertEntity).block).toBe('door-std');
    t.s.undo();
    expect(t.doc.blocks.has('DOOR')).toBe(true);
    expect((t.doc.entityIndex.get('A1') as InsertEntity).block).toBe('DOOR');
  });

  it('외부 참조 이름이 블록 이름과 같으면 정의 자리를 외부 참조로 바꾼다(레코드 핸들 유지)', () => {
    const t = host();
    const def = addBlock(t.doc, t.h, 'DOOR', [line(t.h(), 0, 0, 1, 0)]);
    put(t.doc, insert('A1', 'DOOR', 5, 5));
    const r = blockToXrefOps(t.doc, 'DOOR', { name: 'DOOR', path: 'DOOR.dwg', overlay: false, xdoc: null }, true, t.h);
    t.s.commit({ label: 'BLOCKTOXREF', ops: r.ops });
    const b = t.doc.blocks.get('DOOR')!;
    expect(b.flags & 4).toBe(4);
    expect(b.entities).toEqual([]);
    expect(b.recordHandle).toBe(def.recordHandle);
    expect(t.doc.blockRecords.get('DOOR')!.handle).toBe(def.recordHandle);
    expect((t.doc.entityIndex.get('A1') as InsertEntity).block).toBe('DOOR');
    // 이미 외부 참조면 오류
    expect(() => blockToXrefOps(t.doc, 'DOOR', { name: 'Z', path: 'z.dwg', overlay: false, xdoc: null }, true, t.h)).toThrow();
  });
});
