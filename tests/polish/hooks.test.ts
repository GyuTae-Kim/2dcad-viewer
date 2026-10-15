/**
 * App의 확장 지점(src/app/hooks.ts) — 진짜 App에서 부르는 자리와 순서, 그리고 그 자리로 옮긴 기능:
 *  - commitHooks: before는 등록 순서로 앞 고리가 고친 것을 받고, after는 적용한 트랜잭션을 등록 순서로 본다(다시 확정 가능)
 *    주석 축척(before) → 도면층 이전(after) → 연관 배열 경로 따라가기(after)
 *  - pointFilters: 객체 스냅이 없을 때 추적·격자 스냅·직교 대신(등각투영 제도), null이면 다음 고리·기본 처리
 *  - inputFilters + dragPreviewMode: DRAGMODE·DRAG
 *  - entityClickHandlers: Ctrl+클릭(하이퍼링크 linkClick보다 먼저) — 연관 배열 항목 고르기
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Entity, InsertEntity, LineEntity, TextEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import type { PointResult } from '../../src/app/app';
import { type CommitHook, addHook } from '../../src/app/hooks';
import { installAnnoHooks, setCannoscale } from '../../src/app/annoscale-core';
import { registerLayerToolCommands, layerPreviousLog, setLayerPMode } from '../../src/app/layerstate-tools';
import { registerAssocArrayCommands } from '../../src/app/assocarray';
import { registerViewToolCommands } from '../../src/app/viewtools';
import { setIso } from '../../src/app/viewtools-iso';
import { annoState, withAnnotativeFlag } from '../../src/edit/annoscale';
import { createArrayOps } from '../../src/edit/assocarray/build';
import { readArray } from '../../src/edit/assocarray/read';
import { allocBlockName } from '../../src/edit/geom/types';
import { affTranslate } from '../../src/edit/geom/math';
import type { Transaction } from '../../src/edit/session';
import { browserGlobals } from './fakes';
import { type RealApp, makeApp, settle } from './real-app';

vi.mock('../../src/app/view', async (orig) => ({ ...(await orig<object>()), CadView: (await import('./fakes')).FakeView }));
vi.mock('../../src/app/commandline', async (orig) => ({ ...(await orig<object>()), CommandLine: (await import('./fakes')).FakeCommandLine }));
vi.mock('../../src/app/engine', async (orig) => ({ ...(await orig<object>()), EngineClient: (await import('./fakes')).FakeEngine }));
vi.mock('../../src/text/fonts', async (orig) => ({ ...(await orig<object>()), OutlineLibrary: (await import('./fakes')).FakeFonts }));

beforeAll(() => {
  const g = browserGlobals();
  vi.stubGlobal('window', g.window);
  vi.stubGlobal('document', g.document);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const header = (name: string, after: number) => ({ kind: 'header' as const, name, before: undefined, after });
const mouse = (o: Partial<PointerEvent> = {}) => ({ pointerType: 'mouse', shiftKey: false, ctrlKey: false, metaKey: false, clientX: 0, clientY: 0, ...o }) as PointerEvent;

function line(x0: number, y0: number, x1: number, y1: number): LineEntity {
  return { ...entityDefaults(), type: 'LINE', handle: '', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } };
}

function addModel(h: RealApp, e: Entity): Entity {
  e.handle ||= h.st.session.newHandle();
  e.owner = h.doc.blocks.get(MODEL_SPACE)!.recordHandle;
  h.st.session.commit({ label: 'T', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
  return h.doc.entityIndex.get(e.handle)!;
}

/** 점 하나를 묻는 명령(기준점·미리보기 선택) */
function pointCommand(h: RealApp, name: string, opt: { base?: { x: number; y: number }; ghost?: boolean } = {}) {
  const got: PointResult[] = [];
  h.app.register({
    name,
    title: name,
    async run(ctx) {
      got.push(await ctx.getPoint(`${name} 점:`, { base: opt.base ?? null, ghost: opt.ghost ? (p) => [{ segs: [0, 0, p.x, p.y] }] : undefined, rubber: opt.ghost ? (p) => [{ pts: [0, 0, p.x, p.y], closed: true }] : undefined }));
    },
  });
  return got;
}

describe('확정 고리(commitHooks)', () => {
  it('before는 등록 순서로 이어 고치고, after는 적용한 트랜잭션을 등록 순서로 본다. after에서 다시 확정하면 그 확정도 모든 고리를 거친다', () => {
    const h = makeApp();
    const log: string[] = [];
    const mark = (tx: Transaction) => tx.ops.map((o) => (o.kind === 'header' ? `${o.name}=${String(o.after)}` : o.kind)).join(',');
    addHook(h.app.commitHooks, {
      name: 'b1',
      before(_st, tx) {
        log.push(`b1(${mark(tx)})`);
        return { ...tx, ops: [...tx.ops, header('$USERI2', 2)] };
      },
    });
    addHook(h.app.commitHooks, {
      name: 'a1',
      after(st, tx) {
        log.push(`a1(${mark(tx)})`);
        if (tx.label === 'X') st.session.commit({ label: 'Y', ops: [header('$USERI4', 4)], group: tx.group });
      },
    });
    addHook(h.app.commitHooks, {
      name: 'b2',
      before(_st, tx) {
        log.push(`b2(${mark(tx)})`);
        return { ...tx, ops: [...tx.ops, header('$USERI3', 3)] };
      },
    });
    addHook(h.app.commitHooks, { name: 'a2', after: (_st, tx) => void log.push(`a2(${mark(tx)})`) });
    // 같은 이름은 한 번만
    addHook(h.app.commitHooks, { name: 'a2', after: () => void log.push('두 번째 a2') });
    expect(h.app.commitHooks.map((x: CommitHook) => x.name)).toEqual(['b1', 'a1', 'b2', 'a2']);
    h.st.session.commit({ label: 'X', ops: [header('$USERI1', 1)], group: 7 });
    expect(log).toEqual([
      'b1($USERI1=1)',
      'b2($USERI1=1,$USERI2=2)',
      'a1($USERI1=1,$USERI2=2,$USERI3=3)',
      // a1 안에서 다시 확정: before·after를 모두 거친다(a2보다 먼저)
      'b1($USERI4=4)',
      'b2($USERI4=4,$USERI2=2)',
      'a1($USERI4=4,$USERI2=2,$USERI3=3)',
      'a2($USERI4=4,$USERI2=2,$USERI3=3)',
      'a2($USERI1=1,$USERI2=2,$USERI3=3)',
    ]);
    // 같은 묶음(group 7): 한 번에 되돌린다
    h.st.session.undo();
    expect(h.doc.header.has('$USERI1') || h.doc.header.has('$USERI4')).toBe(false);
    // 명령 취소·다시 실행은 확정이 아니라 고리를 부르지 않는다
    const n = log.length;
    h.st.session.redo();
    h.st.session.undo();
    expect(log.length).toBe(n);
  });

  it('기능 등록(main.ts 순서): 주석 축척 → 도면층 이전 → 연관 배열 따라가기, 두 번 등록해도 한 번', () => {
    const h = makeApp();
    installAnnoHooks(h.app);
    registerLayerToolCommands(h.app);
    registerAssocArrayCommands(h.app);
    installAnnoHooks(h.app);
    registerAssocArrayCommands(h.app);
    expect(h.app.commitHooks.map((x) => x.name)).toEqual(['annoscale', 'layerp', 'assocarray-follow']);
    expect(h.app.entityClickHandlers.map((x) => x.name)).toEqual(['assocarray-item']);
  });

  it('주석 축척(before): 주석 문자 스타일의 새 TEXT는 지금 CANNOSCALE로 주석이 된다', () => {
    const h = makeApp((doc) => {
      doc.textStyles.set('ANNOTATIVE', { ...doc.textStyles.get('STANDARD')!, name: 'Annotative', handle: 'FFF1', xdata: withAnnotativeFlag(undefined, true) });
    });
    installAnnoHooks(h.app);
    setCannoscale(h.app, h.st, '1:20', 1);
    const t: TextEntity = { type: 'TEXT', ...entityDefaults(), handle: '', insert: { x: 0, y: 0, z: 0 }, height: 2.5, text: 'A', rotation: 0, widthFactor: 1, oblique: 0, style: 'Annotative', generation: 0, halign: 0, valign: 0 };
    const back = addModel(h, t) as TextEntity;
    expect(back.height).toBeCloseTo(50);
    expect(annoState(h.doc, back)?.scales).toEqual(['1:20']);
  });

  it('도면층 이전(after): App이 이은 편집 세션의 도면층 변경을 기록하고 LAYERP가 되돌린다', async () => {
    const h = makeApp();
    registerLayerToolCommands(h.app);
    setLayerPMode(true, h.app);
    const zero = h.doc.layers.get('0')!;
    h.st.session.commit({ label: 'LAYER', ops: [{ kind: 'layer', key: '0', before: zero, after: { ...zero, color: { aci: 3 } } }] });
    expect(layerPreviousLog(h.st).size).toBe(1);
    await h.app.run('LAYERP');
    await settle();
    expect(h.doc.layers.get('0')!.color.aci).toBe(zero.color.aci);
    expect(h.out()).toContain('이전 도면층 상태를 복원했습니다.');
  });

  it('연관 배열 따라가기(after): 경로 곡선을 고치면 같은 명령 취소 묶음으로 배열이 새 경로로 간다', () => {
    const h = makeApp();
    registerAssocArrayCommands(h.app);
    const path = addModel(h, line(0, 0, 10, 0)) as LineEntity;
    const src = addModel(h, { ...entityDefaults(), type: 'CIRCLE', handle: '', center: { x: 0, y: 0, z: 0 }, radius: 0.5 } as Entity);
    const env = { doc: h.doc, newHandle: () => h.st.session.newHandle(), newBlockName: () => allocBlockName(h.doc, '*U') };
    const { handle: _x, ...props } = { ...entityDefaults(), handle: '' };
    void _x;
    const params = { kind: 'path' as const, base: { x: 0, y: 0 }, rows: 1, rowSpacing: 3, rowElevation: 0, levels: 1, levelSpacing: 1, method: 'divide' as const, items: 3, spacing: 5, align: true, zDir: true, reverse: false, path: path.handle, tangentRef: 0 };
    const r = createArrayOps(env, { params, sources: [src], normalize: affTranslate(0, 0), insert: { x: 0, y: 0, z: 0 }, rotation: 0, props, space: MODEL_SPACE });
    if ('error' in r) throw new Error(r.error);
    h.st.session.commit({ label: 'ARRAYPATH', ops: r.ops });
    const ins = h.doc.entityIndex.get(r.insert.handle) as InsertEntity;
    const depth = h.st.session.depth;
    // 그립으로 경로 끝을 옮긴 것처럼
    h.st.session.commit({ label: 'GRIP', ops: [{ kind: 'modify', block: MODEL_SPACE, before: path, after: { ...path, end: { x: 0, y: 20, z: 0 } } }], group: 5 });
    expect(h.st.session.depth).toBe(depth + 1);
    const info = readArray(h.doc, h.doc.entityIndex.get(ins.handle))!;
    expect(info.stale).toBeUndefined();
    const xs = [...info.items.values()].map((hd) => (h.doc.blocks.get(tableKey(info.def.name))!.entities.find((e) => e.handle === hd) as InsertEntity).insert);
    expect(xs.some((p) => p.y > 5)).toBe(true);
    // 한 번 취소하면 경로와 배열이 함께 돌아간다
    h.st.session.undo();
    expect((h.doc.entityIndex.get(path.handle) as LineEntity).end).toEqual({ x: 10, y: 0, z: 0 });
    expect(readArray(h.doc, h.doc.entityIndex.get(ins.handle))!.stale).toBeUndefined();
  });
});

describe('점 해석 고리(pointFilters)', () => {
  it('점 요청에서만, 등록 순서로 부르고 처음 맡은 고리의 점을 쓴다. 모두 null이면 기본(직교)', async () => {
    const h = makeApp();
    const got = pointCommand(h, 'PT', { base: { x: 0, y: 0 } });
    const calls: string[] = [];
    let take = false;
    addHook(h.app.pointFilters, {
      name: 'f1',
      resolve(w, req) {
        calls.push(`f1 ${w.x},${w.y} 기준 ${req.base?.x},${req.base?.y}`);
        return null;
      },
    });
    addHook(h.app.pointFilters, {
      name: 'f2',
      resolve(w) {
        calls.push('f2');
        return take ? { p: { x: w.x * 2, y: w.y * 2 }, snap: null } : null;
      },
    });
    // 요청이 없을 때는 부르지 않는다
    h.view.events.move!({ x: 1, y: 1 }, { x: 1, y: 1 }, mouse());
    expect(calls).toEqual([]);
    h.app.orthoOn = true;
    void h.app.run('PT');
    await settle();
    h.view.events.click!({ x: 10, y: 3 }, { x: 10, y: 3 }, mouse());
    await settle();
    expect(calls).toEqual(['f1 10,3 기준 0,0', 'f2']);
    expect(got.at(-1)).toEqual({ point: { x: 10, y: 0 }, snap: null });
    take = true;
    void h.app.run('PT');
    await settle();
    h.view.events.click!({ x: 10, y: 3 }, { x: 10, y: 3 }, mouse());
    await settle();
    expect(got.at(-1)).toEqual({ point: { x: 20, y: 6 }, snap: null });
  });

  it('등각투영 제도: 직교가 등각평면 축(위 = 30°·150°)으로', async () => {
    const h = makeApp();
    registerViewToolCommands(h.app);
    expect(h.app.pointFilters.map((f) => f.name)).toEqual(['iso']);
    const got = pointCommand(h, 'PT', { base: { x: 0, y: 0 } });
    h.app.orthoOn = true;
    setIso(h.app, h.st, { style: 1, pair: 1 });
    void h.app.run('PT');
    await settle();
    h.view.events.click!({ x: 10, y: 4 }, { x: 10, y: 4 }, mouse());
    await settle();
    const p = (got.at(-1) as { point: { x: number; y: number } }).point;
    expect((Math.atan2(p.y, p.x) * 180) / Math.PI).toBeCloseTo(30, 6);
    // 등각을 끄면 표준 직교
    setIso(h.app, h.st, { style: 0 });
    void h.app.run('PT');
    await settle();
    h.view.events.click!({ x: 10, y: 4 }, { x: 10, y: 4 }, mouse());
    await settle();
    expect(got.at(-1)).toEqual({ point: { x: 10, y: 0 }, snap: null });
  });
});

describe('입력 고리(inputFilters)와 끌기 미리보기(DRAGMODE)', () => {
  it('DRAGMODE 1: 미리보기 없이 기준점 고무줄만, 그 점 프롬프트에서 DRAG를 입력하면 그 요청만 미리보기', async () => {
    const h = makeApp();
    registerViewToolCommands(h.app);
    expect(h.app.inputFilters.map((f) => f.name)).toEqual(['drag']);
    h.doc.header.set('$DRAGMODE', 1);
    const got = pointCommand(h, 'PT', { base: { x: 0, y: 0 }, ghost: true });
    void h.app.run('PT');
    await settle();
    const move = () => h.view.events.move!({ x: 4, y: 5 }, { x: 4, y: 5 }, mouse());
    move();
    expect(h.view.overlay.ghost).toEqual([]);
    expect(h.view.overlay.rubber).toEqual([{ pts: [0, 0, 4, 5], dashed: false }]);
    h.app.submitInput('DRAG');
    expect(h.app.pendingInput?.prompt).toBe('PT 점:');
    move();
    expect(h.view.overlay.ghost).toEqual([{ segs: [0, 0, 4, 5] }]);
    expect(h.view.overlay.rubber).toEqual([{ pts: [0, 0, 4, 5], closed: true }]);
    h.app.submitInput('1,1');
    await settle();
    expect(got.length).toBe(1);
    // 다음 요청은 다시 꺼진 채
    void h.app.run('PT');
    await settle();
    move();
    expect(h.view.overlay.ghost).toEqual([]);
    h.app.cancel();
    await settle();
  });

  it('DRAGMODE 0이면 DRAG는 알리기만, 2(자동)면 늘 미리보기. 점 요청이 아니면 DRAG를 가로채지 않는다', async () => {
    const h = makeApp();
    registerViewToolCommands(h.app);
    pointCommand(h, 'PT', { base: { x: 0, y: 0 }, ghost: true });
    h.doc.header.set('$DRAGMODE', 0);
    void h.app.run('PT');
    await settle();
    h.app.submitInput("'DRAG");
    expect(h.out().some((t) => t.includes('DRAGMODE가 끄기(0)'))).toBe(true);
    h.view.events.move!({ x: 4, y: 5 }, { x: 4, y: 5 }, mouse());
    expect(h.view.overlay.ghost).toEqual([]);
    h.app.cancel();
    await settle();
    h.doc.header.set('$DRAGMODE', 2);
    void h.app.run('PT');
    await settle();
    h.view.events.move!({ x: 4, y: 5 }, { x: 4, y: 5 }, mouse());
    expect(h.view.overlay.ghost).toEqual([{ segs: [0, 0, 4, 5] }]);
    h.app.cancel();
    await settle();
    // 명령이 없을 때 DRAG는 명령(DRAG)으로 실행된다
    const before = h.out().length;
    h.app.submitInput('DRAG');
    await settle();
    expect(h.out().slice(before)).toContain('명령: DRAG');
  });
});

describe('Ctrl+클릭 고리(entityClickHandlers)', () => {
  function withPicker(h: RealApp, handle: string) {
    // 장면·고르기(Picker) 대신: 어디를 눌러도 handle
    h.st.scenes.set(h.st.space, { entities: [] } as never);
    (h.app as unknown as { pickers: Map<string, unknown> }).pickers.set(`${h.st.docId}:${h.st.space}`, { pick: () => handle, pickAll: () => [handle], geometry: () => ({ segs: [] }) });
  }

  it('등록 순서로 부르고, 처리한 고리가 있으면 하이퍼링크(linkClick)·선택으로 넘기지 않는다', () => {
    const h = makeApp();
    withPicker(h, 'ABC');
    const calls: string[] = [];
    let second = true;
    addHook(h.app.entityClickHandlers, { name: 'c1', click: (hd, p) => (calls.push(`c1 ${hd} ${p.x},${p.y}`), false) });
    addHook(h.app.entityClickHandlers, { name: 'c2', click: () => (calls.push('c2'), second) });
    h.app.linkClick = () => (calls.push('link'), true);
    h.view.events.click!({ x: 1, y: 2 }, { x: 1, y: 2 }, mouse({ ctrlKey: true }));
    expect(calls).toEqual(['c1 ABC 1,2', 'c2']);
    expect(h.st.selection.size).toBe(0);
    second = false;
    calls.length = 0;
    h.view.events.click!({ x: 1, y: 2 }, { x: 1, y: 2 }, mouse({ metaKey: true }));
    expect(calls).toEqual(['c1 ABC 1,2', 'c2', 'link']);
    // Ctrl 없이 누르면 고리를 부르지 않고 고른다
    calls.length = 0;
    h.app.linkClick = null;
    h.view.events.click!({ x: 1, y: 2 }, { x: 1, y: 2 }, mouse());
    expect(calls).toEqual([]);
    expect([...h.st.selection]).toEqual(['ABC']);
  });
});
