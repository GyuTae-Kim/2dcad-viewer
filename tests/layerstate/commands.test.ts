/**
 * 명령 흐름(가짜 App): -LAYERSTATE·-LAYER 상태(A), LAYERP·LAYERPMODE, SETBYLAYER.
 * 그리고 순수 계산: 도면층 이전 기록, SETBYLAYER 결과.
 */
import { describe, expect, it } from 'vitest';
import type { Entity, InsertEntity, Layer } from '../../src/core/model';
import { MODEL_SPACE, tableKey } from '../../src/core/model';
import { registerDashLayerCommand } from '../../src/app/layercmd';
import { registerLayerStateCommands } from '../../src/app/layerstate';
import { setLayerPMode, setSetByLayerMode } from '../../src/app/layerstate-tools';
import { LayerPreviousLog, layerPreviousOps, layerSettingChanges } from '../../src/edit/layerstate/previous';
import { LSM_COLOR, LSM_FROZEN, LSM_ON } from '../../src/edit/layerstate/record';
import { SBL_BLOCKS, SBL_BYBLOCK, SBL_DEFAULT, activeSettingsText, setByLayerOps } from '../../src/edit/layerstate/setbylayer';
import { findLayerState, listLayerStates } from '../../src/edit/layerstate/store';
import { line } from '../edit/make';
import { makeHarness } from '../cmds2/harness';

const STATE_PROMPT = '옵션입력 [?/저장(S)/복원(R)/편집(E)/이름(N)/삭제(D)/불러오기(I)/내보내기(EX)]:';

function layerOf(base: Layer, name: string, handle: string, p: Partial<Layer> = {}): Layer {
  return { ...structuredClone(base), name, handle, ...p };
}

function harness() {
  const h = makeHarness((doc) => {
    const zero = doc.layers.get('0')!;
    doc.layers.set('A', layerOf(zero, 'A', 'A0', { color: { aci: 1 } }));
    doc.layers.set('B', layerOf(zero, 'B', 'A1', { color: { aci: 2 } }));
  });
  registerLayerStateCommands(h.app);
  registerDashLayerCommand(h.app);
  return h;
}

function setLayer(h: ReturnType<typeof harness>, name: string, p: Partial<Layer>, label = 'LAYER') {
  const before = h.doc.layers.get(tableKey(name))!;
  h.st.session.commit({ label, ops: [{ kind: 'layer', key: tableKey(name), before, after: { ...before, ...p } }] });
}

describe('-LAYERSTATE', () => {
  it('저장(특성 고르기) → 바꾸기 → 복원 → 이름 → 목록 → 삭제', async () => {
    const h = harness();
    await h.run('-LAYERSTATE', ['S', '평면도', 'C', '', '']);
    expect(h.prompts[0]).toBe(STATE_PROMPT);
    expect(h.prompts).toContain('저장할 새 도면층 상태 이름 입력:');
    const s = findLayerState(h.doc, '평면도')!.state;
    expect(s.mask & LSM_COLOR).toBe(0);
    expect(s.mask & LSM_ON).toBe(LSM_ON);
    setLayer(h, 'A', { off: true, color: { aci: 5 } });
    await h.run('-LAYERSTATE', ['R', '?', '평면도', '']);
    expect(h.prompts).toContain('복원할 도면층 상태 이름 또는 [?] 입력:');
    expect(h.printed.some((t) => t.startsWith('"평면도"'))).toBe(true);
    // 색상은 복원 특성이 아니다
    expect(h.doc.layers.get('A')!.off).toBe(false);
    expect(h.doc.layers.get('A')!.color.aci).toBe(5);
    await h.run('-LAYERSTATE', ['N', '평면도', '배치도', '?', '', '']);
    expect(findLayerState(h.doc, '배치도')).not.toBeNull();
    expect(h.prompts).toContain('나열할 도면층 상태 이름 입력 <*>:');
    await h.run('-LAYERSTATE', ['D', '배치도', '']);
    expect(listLayerStates(h.doc)).toEqual([]);
  });

  it('같은 이름 저장은 덮어쓸지 묻고, 없는 이름·잘못된 옵션은 알린다', async () => {
    const h = harness();
    await h.run('-LAYERSTATE', ['S', 'X', '', 'S', 'x', 'N', 'R', 'NOPE', 'ZZ', 'S', 'a|b', '']);
    expect(h.prompts).toContain('도면층 상태 "X"이(가) 이미 있습니다. 덮어쓰시겠습니까? [예(Y)/아니오(N)] <아니오>:');
    expect(h.printed).toContain('도면층 상태 "NOPE"을(를) 찾을 수 없습니다.');
    expect(h.printed).toContain('옵션 키워드가 잘못되었습니다.');
    expect(h.printed.some((t) => t.includes('문자는 쓸 수 없습니다'))).toBe(true);
    expect(listLayerStates(h.doc).length).toBe(1);
  });

  it('편집: 상태 안 도면층의 값 바꾸기·추가·제거', async () => {
    const h = harness();
    await h.run('-LAYERSTATE', ['S', 'E1', '', '']);
    await h.run('-LAYERSTATE', ['E', 'E1', 'OFF', 'A', 'C', '3', 'A,B', 'R', 'B', '', '']);
    const s = findLayerState(h.doc, 'E1')!.state;
    const A = s.layers.find((l) => l.name === 'A')!;
    expect(A.flags & 1).toBe(1);
    expect(A.color.aci).toBe(3);
    expect(s.layers.some((l) => l.name === 'B')).toBe(false);
    await h.run('-LAYERSTATE', ['E', 'E1', 'A', 'B', '', '']);
    expect(findLayerState(h.doc, 'E1')!.state.layers.some((l) => l.name === 'B')).toBe(true);
  });

  it('-LAYER의 상태(A)가 같은 옵션으로 넘어간다', async () => {
    const h = harness();
    await h.run('-LAYER', ['A', 'S', 'L1', '', '', '']);
    expect(h.prompts).toContain(STATE_PROMPT);
    expect(findLayerState(h.doc, 'L1')).not.toBeNull();
  });
});

describe('LAYERP', () => {
  it('도면층 설정 변경을 한 단계씩 되돌리고, 새 도면층·이름 바꾸기는 되돌리지 않는다', async () => {
    const h = harness();
    setLayerPMode(true, h.app);
    setLayer(h, 'A', { off: true });
    setLayer(h, 'B', { color: { aci: 7 } });
    // 새 도면층
    h.st.session.commit({ label: 'LAYER', ops: [{ kind: 'layer', key: 'C', before: null, after: layerOf(h.doc.layers.get('0')!, 'C', 'A5') }] });
    // 이름 바꾸기 + 색
    const A = h.doc.layers.get('A')!;
    h.st.session.commit({
      label: 'RENAME',
      ops: [
        { kind: 'layer', key: 'A', before: A, after: null },
        { kind: 'layer', key: 'A2', before: null, after: { ...A, name: 'A2', color: { aci: 4 } } },
      ],
    });
    await h.run('LAYERP', []);
    // 이름은 그대로, 색만 되돌린다
    expect(h.doc.layers.get('A2')!.color.aci).toBe(1);
    expect(h.doc.layers.has('C')).toBe(true);
    await h.run('LAYERP', []);
    expect(h.doc.layers.get('B')!.color.aci).toBe(2);
    await h.run('LAYERP', []);
    expect(h.doc.layers.get('A2')!.off).toBe(false);
    await h.run('LAYERP', []);
    expect(h.printed).toContain('*** 이전 도면층 상태가 없습니다 ***');
    expect(h.printed.filter((t) => t === '이전 도면층 상태를 복원했습니다.').length).toBe(3);
  });

  it('LAYERPMODE를 끄면 기록하지 않고 LAYERP가 알린다', async () => {
    const h = harness();
    await h.run('LAYERPMODE', ['OFF']);
    setLayer(h, 'A', { off: true });
    await h.run('LAYERP', []);
    expect(h.printed.some((t) => t.includes('LAYERPMODE가 꺼져'))).toBe(true);
    await h.run('LAYERPMODE', ['']);
    expect(h.prompts).toContain('LAYERP 모드 입력 [켜기(ON)/끄기(OFF)] <끄기>:');
    await h.run('LAYERPMODE', ['ON']);
    setLayer(h, 'A', { off: false, locked: true });
    await h.run('LAYERP', []);
    expect(h.doc.layers.get('A')!.locked).toBe(false);
    expect(h.doc.layers.get('A')!.off).toBe(true);
  });

  it('도면층 상태 복원도 LAYERP로 되돌린다', async () => {
    const h = harness();
    setLayerPMode(true, h.app);
    await h.run('-LAYERSTATE', ['S', 'S1', '', '']);
    setLayer(h, 'A', { frozen: true });
    await h.run('-LAYERSTATE', ['R', 'S1', '']);
    expect(h.doc.layers.get('A')!.frozen).toBe(false);
    await h.run('LAYERP', []);
    expect(h.doc.layers.get('A')!.frozen).toBe(true);
  });

  it('기록: 같은 명령(묶음)의 여러 확정은 한 단계, 앞 값을 남긴다', () => {
    const log = new LayerPreviousLog();
    const L: Layer = { name: 'A', handle: '10', flags: 0, color: { aci: 1 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
    const L2 = { ...L, off: true };
    const L3 = { ...L2, color: { aci: 3 } };
    log.record({ label: 'X', group: 5, ops: [{ kind: 'layer', key: 'A', before: L, after: L2 }] });
    log.record({ label: 'X', group: 5, ops: [{ kind: 'layer', key: 'A', before: L2, after: L3 }] });
    expect(log.size).toBe(1);
    const step = log.pop()!;
    expect(step.before.get('h:10')).toEqual(L);
    expect(layerSettingChanges([{ kind: 'layer', key: 'A', before: L, after: { ...L } }]).size).toBe(0);
  });

  it('현재 도면층 바꾸기도 되돌린다', async () => {
    const h = harness();
    setLayerPMode(true, h.app);
    h.st.session.commit({ label: 'CLAYER', ops: [{ kind: 'header', name: '$CLAYER', before: '0', after: 'A' }] });
    setLayer(h, 'B', { off: true });
    await h.run('LAYERP', []);
    expect(h.doc.layers.get('B')!.off).toBe(false);
    expect(h.doc.header.get('$CLAYER')).toBe('A');
    await h.run('LAYERP', []);
    expect(h.doc.header.get('$CLAYER')).toBe('0');
  });

  it('없어진 도면층은 건너뛴다', () => {
    const h = harness();
    const step = { label: 'X', before: new Map([['h:FFFF', layerOf(h.doc.layers.get('0')!, 'GONE', 'FFFF')]]) };
    expect(layerPreviousOps(h.doc, step)).toEqual([]);
  });
});

describe('SETBYLAYER', () => {
  function colored(e: Entity, p: Partial<Entity>): Entity {
    return { ...e, ...p } as Entity;
  }

  it('설정한 특성을 ByLayer로, ByBlock은 답에 따라, 잠긴 도면층은 빼고', async () => {
    const h = harness();
    setSetByLayerMode(SBL_DEFAULT);
    const a = h.add(colored(line(0, 0, 1, 0), { color: { aci: 3 }, linetype: 'DASHED', lineweight: 50, transparency: 100 }));
    const b = h.add(colored(line(0, 1, 1, 1), { color: { aci: 0 }, linetype: 'ByBlock', lineweight: -2 }));
    const c = h.add(colored(line(0, 2, 1, 2), { layer: 'B', color: { aci: 4 } }));
    setLayer(h, 'B', { locked: true });
    await h.run('SETBYLAYER', [{ sel: [a.handle, b.handle, c.handle] }, 'N', 'N']);
    expect(h.prompts).toContain('ByBlock을 ByLayer로 변경하시겠습니까? [예(Y)/아니오(N)] <예>:');
    expect(h.prompts).toContain('블록을 포함하시겠습니까? [예(Y)/아니오(N)] <예>:');
    expect(h.printed).toContain(`현재 활성 설정: ${activeSettingsText(SBL_DEFAULT)}`);
    const A = h.doc.entityIndex.get(a.handle)!;
    expect([A.color.aci, A.linetype, A.lineweight, A.transparency]).toEqual([256, 'ByLayer', -1, -1]);
    const B = h.doc.entityIndex.get(b.handle)!;
    expect([B.color.aci, B.linetype, B.lineweight]).toEqual([0, 'ByBlock', -2]);
    expect(h.doc.entityIndex.get(c.handle)!.color.aci).toBe(4);
    expect(h.printed).toContain('1개의 객체가 수정되었습니다.');
    // 답이 다음 기본값이 된다
    await h.run('SETBYLAYER', [{ sel: [b.handle] }, '', '']);
    expect(h.prompts).toContain('ByBlock을 ByLayer로 변경하시겠습니까? [예(Y)/아니오(N)] <아니오>:');
    expect(h.doc.entityIndex.get(b.handle)!.color.aci).toBe(0);
    await h.run('SETBYLAYER', [{ sel: [b.handle] }, 'Y', '']);
    expect(h.doc.entityIndex.get(b.handle)!.color.aci).toBe(256);
  });

  it('블록 포함이면 블록 정의 안 객체도(한 번씩, 중첩 포함), 특성 비트만', () => {
    const h = harness();
    const doc = h.doc;
    const inner = { ...line(0, 0, 1, 0), handle: 'B1', color: { aci: 5 }, lineweight: 30 } as Entity;
    const nested = { ...line(0, 0, 2, 0), handle: 'B2', color: { aci: 0 } } as Entity;
    doc.blocks.set('INNER', { name: 'INNER', handle: 'B0', recordHandle: 'BR0', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [nested] });
    const ins2: InsertEntity = { ...line(0, 0, 0, 0), type: 'INSERT', handle: 'B3', block: 'INNER', insert: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: 0, columnCount: 1, rowCount: 1, columnSpacing: 0, rowSpacing: 0, attribs: [] } as unknown as InsertEntity;
    doc.blocks.set('OUTER', { name: 'OUTER', handle: 'C0', recordHandle: 'CR0', basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: [inner, ins2] });
    const ins = { ...ins2, handle: 'D1', block: 'OUTER', color: { aci: 6 } } as InsertEntity;
    const targets = [{ block: MODEL_SPACE, entity: ins as Entity }, { block: MODEL_SPACE, entity: { ...ins, handle: 'D2' } as Entity }];
    const r = setByLayerOps(doc, targets, { mode: 1, byBlock: true, includeBlocks: true });
    expect(r.changed).toBe(2);
    expect(r.blocks).toBe(2);
    expect(r.nested).toBe(2);
    const outer = r.ops.find((o) => o.kind === 'modify' && o.before.handle === 'B1');
    expect(outer && outer.kind === 'modify' && outer.after.color.aci).toBe(256);
    expect(outer && outer.kind === 'modify' && outer.after.lineweight).toBe(30);
    const none = setByLayerOps(doc, targets, { mode: 1, byBlock: false, includeBlocks: false });
    expect(none.nested).toBe(0);
    expect((SBL_BYBLOCK | SBL_BLOCKS) & 1).toBe(0);
  });

  it('SETBYLAYERMODE: 고르지 않은 특성은 그대로', async () => {
    const h = harness();
    setSetByLayerMode(SBL_DEFAULT);
    await h.run('SETBYLAYERMODE', ['300', '2']);
    expect(h.printed).toContain('0에서 255 사이의 정수가 필요합니다.');
    const a = h.add(colored(line(0, 0, 1, 0), { color: { aci: 3 }, linetype: 'DASHED' }));
    await h.run('SETBYLAYER', [{ sel: [a.handle] }, 'Y', 'Y']);
    expect(h.printed).toContain('현재 활성 설정: 선종류');
    expect(h.doc.entityIndex.get(a.handle)!.color.aci).toBe(3);
    expect(h.doc.entityIndex.get(a.handle)!.linetype).toBe('ByLayer');
    setSetByLayerMode(SBL_DEFAULT);
    expect(LSM_FROZEN).toBe(2);
  });
});
