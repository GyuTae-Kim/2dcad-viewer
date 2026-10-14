import { describe, expect, it } from 'vitest';
import { type CircleEntity, type LineEntity, createDocument, entityDefaults, MODEL_SPACE, v3 } from '../../src/core/model';
import { finalizeDocument } from '../../src/core/finalize';
import { EditSession, type ChangeSummary, type Transaction, cloneEntity } from '../../src/edit/session';

function setup() {
  const doc = finalizeDocument(createDocument());
  doc.header.set('$HANDSEED', '100');
  const log: { tx: Transaction; sum: ChangeSummary }[] = [];
  const s = new EditSession(doc, (tx, sum) => log.push({ tx, sum }));
  const line = (x: number): LineEntity => ({ ...entityDefaults(), type: 'LINE', handle: s.newHandle(), start: v3(x, 0), end: v3(x, 10) });
  return { doc, s, log, line, ms: doc.blocks.get(MODEL_SPACE)! };
}

describe('EditSession', () => {
  it('새 핸들은 $HANDSEED에서 올라가고 쓰인 핸들과 겹치지 않는다', () => {
    const { doc, s } = setup();
    expect(s.newHandle()).toBe('100');
    expect(s.newHandle()).toBe('101');
    expect(doc.header.get('$HANDSEED')).toBe('102');
    doc.entityIndex.set('102', { ...entityDefaults(), type: 'POINT', handle: '102' } as never);
    const h = s.newHandle();
    expect(h).not.toBe('102');
  });

  it('추가·삭제·수정을 되돌리고 다시 한다', () => {
    const { doc, s, log, line, ms } = setup();
    const a = line(0);
    s.commit({ label: 'LINE', ops: [{ kind: 'add', block: MODEL_SPACE, entity: a }] });
    expect(ms.entities).toContain(a);
    expect(doc.entityIndex.get(a.handle)).toBe(a);
    expect(log.at(-1)!.sum.spaces.get(MODEL_SPACE)!.changed).toEqual([a]);
    expect(s.dirty).toBe(true);

    const b: LineEntity = { ...cloneEntity(a), end: v3(5, 5) };
    s.commit({ label: 'MOVE', ops: [{ kind: 'modify', block: MODEL_SPACE, before: a, after: b }] });
    expect(ms.entities[ms.entities.length - 1]).toBe(b);

    s.commit({ label: 'ERASE', ops: [{ kind: 'remove', block: MODEL_SPACE, entity: b, index: ms.entities.indexOf(b) }] });
    expect(doc.entityIndex.has(a.handle)).toBe(false);

    expect(s.undo()!.label).toBe('ERASE');
    expect(doc.entityIndex.get(a.handle)).toBe(b);
    expect(s.undo()!.label).toBe('MOVE');
    expect(doc.entityIndex.get(a.handle)).toBe(a);
    expect(log.at(-1)!.sum.spaces.get(MODEL_SPACE)!.removed.has(a.handle)).toBe(true);
    expect(s.undo()!.label).toBe('LINE');
    expect(ms.entities).not.toContain(a);
    expect(s.undo()).toBeNull();
    expect(s.dirty).toBe(false);

    s.redo();
    s.redo();
    expect(doc.entityIndex.get(a.handle)).toBe(b);
    // 새 변경은 다시 하기 목록을 비운다
    s.commit({ label: 'LINE', ops: [{ kind: 'add', block: MODEL_SPACE, entity: line(20) }] });
    expect(s.canRedo()).toBe(false);
  });

  it('삭제를 되돌리면 원래 순서 자리로 돌아간다', () => {
    const { s, line, ms } = setup();
    const ls = [line(0), line(1), line(2)];
    s.commit({ label: 'L', ops: ls.map((e) => ({ kind: 'add' as const, block: MODEL_SPACE, entity: e })) });
    s.commit({ label: 'E', ops: [{ kind: 'remove', block: MODEL_SPACE, entity: ls[1]!, index: ms.entities.indexOf(ls[1]!) }] });
    expect(ms.entities.slice(-2)).toEqual([ls[0], ls[2]]);
    s.undo();
    expect(ms.entities.slice(-3)).toEqual(ls);
  });

  it('같은 묶음의 트랜잭션은 한 번에 되돌리고, 마지막 단계만 되돌릴 수 있다', () => {
    const { s, line, ms } = setup();
    const n0 = ms.entities.length;
    s.commit({ label: 'LINE', ops: [{ kind: 'add', block: MODEL_SPACE, entity: line(0) }], group: 7 });
    s.commit({ label: 'LINE', ops: [{ kind: 'add', block: MODEL_SPACE, entity: line(1) }], group: 7 });
    s.commit({ label: 'LINE', ops: [{ kind: 'add', block: MODEL_SPACE, entity: line(2) }], group: 7 });
    expect(ms.entities.length).toBe(n0 + 3);
    expect(s.undoLastStep(7, 1)).toBe(1);
    expect(ms.entities.length).toBe(n0 + 2);
    expect(s.undoLastStep(8, 1)).toBe(0);
    s.undo();
    expect(ms.entities.length).toBe(n0);
    s.redo();
    expect(ms.entities.length).toBe(n0 + 2);
  });

  it('표와 머리말 변경도 되돌린다', () => {
    const { doc, s, log } = setup();
    const before = doc.layers.get('0')!;
    const after = { ...before, frozen: true };
    s.commit({
      label: 'LAYER',
      ops: [
        { kind: 'layer', key: '0', before, after },
        { kind: 'header', name: '$CLAYER', before: doc.header.get('$CLAYER'), after: 'WALL' },
      ],
    });
    // 도면층 상태만 바뀌면 다시 그리지 않고 스타일 표만 바꾼다
    expect(log.at(-1)!.sum.layersChanged).toBe(true);
    expect(log.at(-1)!.sum.tablesChanged).toBe(false);
    expect(doc.layers.get('0')!.frozen).toBe(true);
    expect(doc.header.get('$CLAYER')).toBe('WALL');
    s.undo();
    expect(doc.layers.get('0')).toBe(before);
    expect(doc.header.get('$CLAYER')).not.toBe('WALL');
  });

  it('도면층 선종류를 바꾸거나 새로 만들면 다시 그린다', () => {
    const { doc, s, log } = setup();
    const before = doc.layers.get('0')!;
    s.commit({ label: 'L', ops: [{ kind: 'layer', key: '0', before, after: { ...before, linetype: 'DASHED' } }] });
    expect(log.at(-1)!.sum.tablesChanged).toBe(true);
    s.commit({ label: 'L', ops: [{ kind: 'layer', key: 'NEW', before: null, after: { ...before, name: 'NEW' } }] });
    expect(log.at(-1)!.sum.tablesChanged).toBe(true);
  });

  it('블록 정의 안의 객체가 바뀌면 블록 변경으로 알리고, 블록 편집기용으로 그 블록의 변경도 담는다', () => {
    const { doc, s, log, line } = setup();
    doc.blocks.set('B1', { ...doc.blocks.get('*MODEL_SPACE')!, name: 'B1', entities: [] });
    s.commit({ label: 'B', ops: [{ kind: 'add', block: 'B1', entity: line(0) }] });
    expect(log.at(-1)!.sum.blocksChanged).toBe(true);
    expect([...log.at(-1)!.sum.spaces.keys()]).toEqual(['B1']);
    expect(log.at(-1)!.sum.spaces.get('B1')!.changed).toHaveLength(1);
  });

  it('배치 작업은 배치 목록과 LAYOUT 객체를 함께 바꾸고 되돌린다', () => {
    const { doc, s, log } = setup();
    const lay = { name: 'L1', handle: 'A1', tabOrder: 1, blockRecord: 'A2', blockName: '*Paper_Space', flags: 0, limitsMin: { x: 0, y: 0 }, limitsMax: { x: 0, y: 0 }, insertionBase: { x: 0, y: 0, z: 0 }, extMin: { x: 0, y: 0, z: 0 }, extMax: { x: 0, y: 0, z: 0 }, elevation: 0, ucsOrigin: { x: 0, y: 0, z: 0 }, ucsXAxis: { x: 1, y: 0, z: 0 }, ucsYAxis: { x: 0, y: 1, z: 0 }, plot: {} as never };
    const n0 = doc.layouts.length;
    s.commit({ label: 'LAYOUT', ops: [{ kind: 'object', key: 'A1', before: null, after: { type: 'LAYOUT', handle: 'A1', layout: lay } }, { kind: 'layout', key: '*PAPER_SPACE', before: null, after: lay }] });
    expect(doc.layouts.length).toBe(n0 + 1);
    expect(log.at(-1)!.sum.layoutsChanged).toBe(true);
    const renamed = { ...lay, name: 'L2' };
    s.commit({ label: 'LAYOUT', ops: [{ kind: 'layout', key: '*PAPER_SPACE', before: lay, after: renamed }] });
    expect(doc.layouts.find((l) => l.handle === 'A1')!.name).toBe('L2');
    expect((doc.objects.get('A1') as { layout: { name: string } }).layout.name).toBe('L2');
    s.undo();
    expect((doc.objects.get('A1') as { layout: { name: string } }).layout.name).toBe('L1');
    s.undo();
    expect(doc.layouts.length).toBe(n0);
    expect(doc.objects.has('A1')).toBe(false);
  });

  it('객체가 들어 있는 블록을 찾는다', () => {
    const { s, line } = setup();
    const c: CircleEntity = { ...entityDefaults(), type: 'CIRCLE', handle: s.newHandle(), center: v3(), radius: 1 };
    s.commit({ label: 'C', ops: [{ kind: 'add', block: MODEL_SPACE, entity: c }] });
    expect(s.ownerOf(c.handle)).toBe(MODEL_SPACE);
    expect(s.ownerOf(line(0).handle)).toBeNull();
  });
});
