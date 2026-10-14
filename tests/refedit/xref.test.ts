/** 참조 편집: 외부 참조 도면 ↔ 현재 도면(이름 맞추기, 고유 이름, 저장할 때 되돌리기) */
import { describe, expect, it } from 'vitest';
import type { BlockDef, CadDocument, CircleEntity, Entity, InsertEntity, LineEntity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { applyOps } from '../../src/edit/session';
import { insertXf } from '../../src/edit/refedit/xform';
import { bindMapper, createImporter, reverseMapper, unbindName, isFixedName } from '../../src/edit/refedit/names';
import { extendBlocks, openWorkingSet, planSave, seedAllocator } from '../../src/edit/refedit/workset';
import { affApply } from '../../src/edit/geom/math';
import { circle, line, newDoc, text } from '../edit/make';

const layer = (name: string, aci: number, linetype = 'Continuous') => ({ name, handle: 'L' + name, flags: 0, color: { aci }, off: false, frozen: false, locked: false, linetype, lineweight: -3, plot: true, transparency: 255 });

function xrefDoc(): CadDocument {
  const d = newDoc();
  d.layers.set('WALL', layer('WALL', 1, 'DASHED'));
  d.linetypes.set('DASHED', { name: 'DASHED', handle: 'LT1', flags: 0, description: '__ __', patternLength: 1, elements: [{ length: 0.5, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }, { length: -0.5, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }] });
  d.textStyles.set('ROMANS', { name: 'ROMANS', handle: 'TS1', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'romans.shx', bigFont: '' });
  const door: BlockDef = { name: 'DOOR', handle: 'DB1', recordHandle: 'DB2', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [{ ...line(0, 0, 0, 9), layer: 'WALL', handle: 'D1', owner: 'DB2' }] };
  d.blocks.set('DOOR', door);
  d.blockRecords.set('DOOR', { name: 'DOOR', handle: 'DB2', flags: 0, insertUnits: 0, explodable: true, scalable: true });
  const ms = d.blocks.get(MODEL_SPACE)!;
  const l: Entity = { ...line(0, 0, 100, 0), layer: 'WALL', handle: 'A1', owner: ms.recordHandle };
  const t: Entity = { ...(text(10, 10, 'ROOM', 3) as TextEntity), style: 'ROMANS', layer: 'WALL', handle: 'A2', owner: ms.recordHandle };
  const di: InsertEntity = { type: 'INSERT', ...entityDefaults(), handle: 'A3', owner: ms.recordHandle, layer: 'WALL', block: 'DOOR', insert: { x: 50, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
  for (const e of [l, t, di]) {
    ms.entities.push(e);
    d.entityIndex.set(e.handle, e);
  }
  d.header.set('$HANDSEED', '100');
  return d;
}

function hostDoc(): { doc: CadDocument; ins: InsertEntity } {
  const d = newDoc();
  d.blocks.set('X', { name: 'X', handle: 'XB1', recordHandle: 'XB2', basePoint: { x: 0, y: 0, z: 0 }, flags: 4, xrefPath: '.\\x.dwg', entities: [] });
  d.blockRecords.set('X', { name: 'X', handle: 'XB2', flags: 0, insertUnits: 0, explodable: true, scalable: true });
  // 호스트의 외부 참조 의존 도면층(재지정: 초록)
  d.layers.set('X|WALL', { ...layer('X|WALL', 3, 'X|DASHED'), flags: 16 | 32 });
  const ms = d.blocks.get(MODEL_SPACE)!;
  const ins: InsertEntity = { type: 'INSERT', ...entityDefaults(), handle: 'H1', owner: ms.recordHandle, block: 'X', insert: { x: 1000, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: Math.PI / 2, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] };
  ms.entities.push(ins);
  d.entityIndex.set(ins.handle, ins);
  d.header.set('$HANDSEED', '5000');
  return { doc: d, ins };
}

describe('이름', () => {
  it('결합 이름은 접두사$n$이름, 고정 이름은 그대로', () => {
    const { doc } = hostDoc();
    const m = bindMapper(doc, 'X');
    expect(m('layer', 'WALL')).toBe('X$0$WALL');
    expect(m('layer', '0')).toBe('0');
    expect(m('linetype', 'ByLayer')).toBe('ByLayer');
    doc.layers.set('X$0$DOOR', layer('X$0$DOOR', 1));
    expect(m('layer', 'DOOR')).toBe('X$1$DOOR');
    expect(unbindName('X', 'X$1$DOOR')).toBe('DOOR');
    expect(unbindName('Y', 'X$1$DOOR')).toBe(null);
    expect(isFixedName('layer', 'defpoints')).toBe(true);
  });
});

describe('외부 참조 작업 세트', () => {
  function open(unique: boolean) {
    const xd = xrefDoc();
    const { doc: host, ins } = hostDoc();
    const xf = insertXf(host.blocks.get('X')!, ins);
    if (typeof xf === 'string') throw new Error(xf);
    let n = 0x5000;
    const newHandle = () => (n++).toString(16).toUpperCase();
    const imp = createImporter(extendBlocks(xd), host, unique ? bindMapper(host, 'X') : (_k, s) => s, newHandle, {
      layerFrom: (s) => host.layers.get(tableKey(`X|${s}`)),
    });
    const target = { kind: 'xref' as const, doc: xd, key: MODEL_SPACE, xf };
    const res = openWorkingSet(target, { host, space: MODEL_SPACE, attdefs: false, newHandle, importer: imp });
    applyOps(host, res.ops);
    return { xd, host, ins, xf, imp, target, res, newHandle };
  }

  it('고유 이름: 도면층·선종류·문자 스타일·블록이 XREF$0$이름으로 들어온다(도면층 상태는 호스트 재지정)', () => {
    const { host, res } = open(true);
    expect(res.copies.length).toBe(3);
    const wall = host.layers.get('X$0$WALL')!;
    expect(wall).toBeTruthy();
    expect(wall.color.aci).toBe(3);
    expect(wall.linetype).toBe('X$0$DASHED');
    expect(wall.flags & 16).toBe(0);
    expect(host.linetypes.has('X$0$DASHED')).toBe(true);
    expect(host.textStyles.get('X$0$ROMANS')?.font).toBe('romans.shx');
    const door = host.blocks.get('X$0$DOOR')!;
    expect(door.entities.length).toBe(1);
    expect(door.entities[0]!.layer).toBe('X$0$WALL');
    expect(host.blockRecords.get('X$0$DOOR')?.handle).toBe(door.recordHandle);
    const t = res.copies.find((e) => e.type === 'TEXT') as TextEntity;
    expect(t.style).toBe('X$0$ROMANS');
    expect(t.layer).toBe('X$0$WALL');
    const ins = res.copies.find((e) => e.type === 'INSERT') as InsertEntity;
    expect(ins.block).toBe('X$0$DOOR');
  });

  it('고유 이름 끔: 이름은 그대로, 호스트에 없으면 만든다', () => {
    const { host, res } = open(false);
    expect(host.layers.has('WALL')).toBe(true);
    expect(res.copies.every((e) => e.layer === 'WALL')).toBe(true);
    expect(host.blocks.has('DOOR')).toBe(true);
  });

  it('저장하면 참조 도면 자신의 이름·좌표로 되돌린 편집 작업을 만든다', () => {
    const { xd, host, imp, target, res, xf } = open(true);
    const ms = host.blocks.get(MODEL_SPACE)!;
    const wl = ms.entities.find((e) => res.origin.get(e.handle) === 'A1') as LineEntity;
    // 참조 도면 좌표 (100,0) → (100,20)
    const to = affApply(xf.m, { x: 100, y: 20 });
    applyOps(host, [{ kind: 'modify', block: MODEL_SPACE, before: wl, after: { ...wl, end: { x: to.x, y: to.y, z: 0 } } }]);
    // 새 원 두 개: 도면층 0, 호스트의 새 도면층 NEW
    host.layers.set('NEW', layer('NEW', 5));
    const c0 = affApply(xf.m, { x: 5, y: 5 });
    const a: Entity = { ...circle(c0.x, c0.y, 2), handle: 'C9001' };
    const b: Entity = { ...circle(c0.x, c0.y, 3), handle: 'C9002', layer: 'NEW' };
    applyOps(host, [
      { kind: 'add', block: MODEL_SPACE, entity: a },
      { kind: 'add', block: MODEL_SPACE, entity: b },
    ]);
    const working = ms.entities.filter((e) => e.type !== 'INSERT' || e.block !== 'X');
    const alloc = seedAllocator(xd);
    const exporter = createImporter(extendBlocks(host), xd, reverseMapper(imp.origin, 'X'), alloc.newHandle);
    const plan = planSave({ target, host, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle: alloc.newHandle, exporter });
    expect(plan.error).toBeUndefined();
    expect(plan.changed).toBe(1);
    expect(plan.added).toBe(2);
    expect(plan.kept).toBe(2);
    applyOps(xd, [...plan.defOps, ...alloc.finish()]);
    const xms = xd.blocks.get(MODEL_SPACE)!;
    const l = xms.entities.find((e) => e.handle === 'A1') as LineEntity;
    expect(l.layer).toBe('WALL');
    expect(Math.abs(l.end.x - 100)).toBeLessThan(1e-7);
    expect(Math.abs(l.end.y - 20)).toBeLessThan(1e-7);
    const circles = xms.entities.filter((e): e is CircleEntity => e.type === 'CIRCLE');
    expect(circles.map((c) => c.layer).sort()).toEqual(['0', 'NEW']);
    expect(Math.abs(circles[0]!.center.x - 5)).toBeLessThan(1e-7);
    expect(xd.layers.get('NEW')?.color.aci).toBe(5);
    // 참조 도면에 XREF$0$ 이름이 새로 생기지 않는다
    expect([...xd.layers.keys()].some((k) => k.includes('$'))).toBe(false);
    expect(xd.blocks.has('X$0$DOOR')).toBe(false);
    expect(BigInt('0x' + String(xd.header.get('$HANDSEED')))).toBeGreaterThan(0x100n);
    // 현재 도면의 작업 세트는 빠진다
    applyOps(host, plan.removeWorking);
    expect(ms.entities.map((e) => e.type)).toEqual(['INSERT']);
  });

  it('외부 참조 블록 자신을 작업 세트에 넣으면 되돌리지 못해 현재 도면에 남긴다', () => {
    const { xd, host, imp, target, res } = open(true);
    const ms = host.blocks.get(MODEL_SPACE)!;
    const self: InsertEntity = { ...(ms.entities[0] as InsertEntity), handle: 'S1' };
    applyOps(host, [{ kind: 'add', block: MODEL_SPACE, entity: self }]);
    const working = ms.entities.filter((e) => e.handle !== 'H1');
    const alloc = seedAllocator(xd);
    const exporter = createImporter(extendBlocks(host), xd, reverseMapper(imp.origin, 'X'), alloc.newHandle);
    const plan = planSave({ target, host, space: MODEL_SPACE, working, origin: res.origin, snapshot: res.snapshot, newHandle: alloc.newHandle, exporter });
    expect(plan.left).toEqual(['S1']);
    expect(plan.removeWorking.some((o) => o.kind === 'remove' && o.entity.handle === 'S1')).toBe(false);
  });
});

describe('외부 참조 결합(전송의 사본)', () => {
  it('외부 참조 블록이 참조 도면 객체를 담은 보통 블록이 되고 XREF|기호는 지운다', async () => {
    const { bindXrefOps } = await import('../../src/edit/refedit/bind');
    const xd = xrefDoc();
    const { doc: host } = hostDoc();
    let n = 0x7000;
    const r = bindXrefOps(host, 'X', xd, () => (n++).toString(16).toUpperCase())!;
    expect(r.entities).toBe(3);
    expect(r.skipped).toBe(0);
    applyOps(host, r.ops);
    const b = host.blocks.get('X')!;
    expect(b.flags & 4).toBe(0);
    expect(b.xrefPath).toBeUndefined();
    expect(b.entities.length).toBe(3);
    expect(b.entities.every((e) => e.owner === b.recordHandle)).toBe(true);
    expect(host.layers.has('X|WALL')).toBe(false);
    expect(host.layers.get('X$0$WALL')?.color.aci).toBe(3);
    expect(host.blocks.has('X$0$DOOR')).toBe(true);
    // 원래 참조 도면은 바뀌지 않는다
    expect(xd.blocks.get(MODEL_SPACE)!.entities[0]!.layer).toBe('WALL');
    // 외부 참조가 아니면 null
    expect(bindXrefOps(host, 'X', xd, () => 'Z')).toBe(null);
  });
});

describe('옮길 수 없는 객체', () => {
  it('핸들로 다른 객체를 가리키는 객체(다중 지시선 등)는 작업 세트로 가져오지 않고 참조에 그대로 둔다', () => {
    const xd = xrefDoc();
    const ms = xd.blocks.get(MODEL_SPACE)!;
    const ml = { ...line(0, 0, 1, 1), type: 'MULTILEADER', handle: 'ML1' } as unknown as Entity;
    ms.entities.push(ml);
    const { doc: host, ins } = hostDoc();
    const xf = insertXf(host.blocks.get('X')!, ins);
    if (typeof xf === 'string') throw new Error(xf);
    let n = 0x5000;
    const newHandle = () => (n++).toString(16).toUpperCase();
    const imp = createImporter(extendBlocks(xd), host, bindMapper(host, 'X'), newHandle);
    const res = openWorkingSet({ kind: 'xref', doc: xd, key: MODEL_SPACE, xf }, { host, space: MODEL_SPACE, attdefs: false, newHandle, importer: imp });
    expect(res.skipped).toBe(1);
    expect(res.copies.length).toBe(3);
    expect([...res.origin.values()].includes('ML1')).toBe(false);
  });
});
