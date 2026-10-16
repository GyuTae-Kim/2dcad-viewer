/**
 * 진짜 App의 직접 조작 입력(화면·명령행은 가짜, 고르기는 tests/direct/fakes.ts의 FakePicker):
 *  동적 입력(상대 좌표 기본·칸 잠금), 객체 스냅 재지정(END·NON·FROM·M2P·TT·점 필터), 연장선 획득, Shift 임시 직교,
 *  오른쪽 클릭(SHORTCUTMENU 11·스냅 메뉴·고리), 객체 선택 옵션(SI·U·M·G), getEntity의 emptyPick·shift,
 *  선택한 객체 끌어 옮기기·복사, 올가미, 여러 핫 그립과 GRIPEDIT, 다기능 그립 메뉴, 두 번 누르기 기본 편집, Ctrl 단축키
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Entity, LineEntity } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import type { EmptyPick, EntityResult, PointResult } from '../../src/app/app';
import type { OverlayState } from '../../src/app/view';
import { dblClickCommand } from '../../src/app/app';
import { addHook } from '../../src/app/hooks';
import { createGroupOps } from '../../src/edit/util/groups';
import * as dom from '../../src/app/ui/dom';
import { browserGlobals } from '../polish/fakes';
import { type RealApp, makeApp, settle } from '../polish/real-app';
import { type DirectCommandLine, FakePicker } from './fakes';

vi.mock('../../src/app/view', async (orig) => ({ ...(await orig<object>()), CadView: (await import('../polish/fakes')).FakeView }));
vi.mock('../../src/app/commandline', async (orig) => ({ ...(await orig<object>()), CommandLine: (await import('./fakes')).DirectCommandLine }));
vi.mock('../../src/app/engine', async (orig) => ({ ...(await orig<object>()), EngineClient: (await import('../polish/fakes')).FakeEngine }));
vi.mock('../../src/text/fonts', async (orig) => ({ ...(await orig<object>()), OutlineLibrary: (await import('../polish/fakes')).FakeFonts }));
vi.mock('../../src/app/ui/dom', async (orig) => ({ ...(await orig<object>()), showMenu: vi.fn(), closeMenu: vi.fn(), toast: vi.fn() }));

beforeAll(() => {
  const g = browserGlobals();
  vi.stubGlobal('window', g.window);
  vi.stubGlobal('document', g.document);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.mocked(dom.showMenu).mockClear();
  vi.useRealTimers();
});

type Pt = { x: number; y: number };
const ev = (o: Partial<PointerEvent> = {}) => ({ pointerType: 'mouse', shiftKey: false, ctrlKey: false, metaKey: false, clientX: 0, clientY: 0, ...o }) as PointerEvent;
const P = (x: number, y: number) => ({ x, y });

interface H extends RealApp {
  pk: FakePicker;
  line: (x0: number, y0: number, x1: number, y1: number) => string;
  /** 비공개 메서드·상태를 시험에서 본다 */
  priv: Record<string, (...a: unknown[]) => unknown>;
  cl: DirectCommandLine;
  move(p: Pt, o?: Partial<PointerEvent>): void;
  click(p: Pt, o?: Partial<PointerEvent>): void;
}

function setup(): H {
  const h = makeApp();
  const pk = new FakePicker(h.doc);
  (h.app as unknown as { picker: () => unknown }).picker = () => pk;
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const e: LineEntity = { ...entityDefaults(), type: 'LINE', handle: h.st.session.newHandle(), start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } };
    e.owner = h.doc.blocks.get(MODEL_SPACE)!.recordHandle;
    h.st.session.commit({ label: 'T', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
    return e.handle;
  };
  return {
    ...h,
    pk,
    line,
    priv: h.app as unknown as Record<string, (...a: unknown[]) => unknown>,
    cl: h.cmd as unknown as DirectCommandLine,
    move: (p, o) => h.view.events.move!(p, p, ev(o)),
    click: (p, o) => h.view.events.click!(p, p, ev(o)),
  };
}

/** 점 하나를 묻는 명령(결과를 모은다) */
function pointCmd(h: H, name: string, opt: { base?: Pt; keywords?: { key: string; label: string }[]; preferNumber?: boolean } = {}) {
  const got: PointResult[] = [];
  h.app.register({
    name,
    title: name,
    async run(ctx) {
      got.push(await ctx.getPoint(`${name} 점:`, { base: opt.base ?? null, keywords: opt.keywords, preferNumber: opt.preferNumber }));
    },
  });
  return got;
}

const pointOf = (r: PointResult | undefined) => (r && 'point' in r ? r.point : null);
/** 화면 덧그림(가짜 화면의 덧그림에 앱이 더한 칸까지) */
const ov = (h: RealApp) => h.view.overlay as unknown as OverlayState;

describe('동적 입력', () => {
  it('두 번째 점부터 명령행·커서 입력 10,5는 기준점에서 상대, #은 절대, 스크립트(submitInput)는 늘 절대', async () => {
    const h = setup();
    const got = pointCmd(h, 'PT', { base: P(5, 5) });
    void h.app.run('PT');
    await settle();
    h.cl.type('10,5');
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(15, 10));
    void h.app.run('PT');
    await settle();
    h.cl.type('#10,5');
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(10, 5));
    void h.app.run('PT');
    await settle();
    h.app.submitInput('10,5');
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(10, 5));
    // 동적 입력을 끄면 절대
    h.app.dynOn = false;
    void h.app.run('PT');
    await settle();
    h.cl.type('10,5');
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(10, 5));
    // 첫 점(기준점 없음)은 절대
    h.app.dynOn = true;
    const first = pointCmd(h, 'P0');
    void h.app.run('P0');
    await settle();
    h.cl.type('3,4');
    await settle();
    expect(pointOf(first.at(-1))).toEqual(P(3, 4));
  });

  it('Tab으로 거리 칸을 잠그면 커서가 움직여도 그 거리, 각도 칸에 값을 치고 Enter면 그 점', async () => {
    const h = setup();
    const got = pointCmd(h, 'PT', { base: P(0, 0) });
    void h.app.run('PT');
    await settle();
    h.move(P(3, 4));
    expect(ov(h).dynFields).toEqual([
      { text: '5.0000', locked: false, active: true },
      { text: '53.1°', locked: false, active: false },
    ]);
    h.cl.input.value = '10';
    expect(h.cl.intercept!({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent)).toBe(true);
    expect(h.cl.input.value).toBe('');
    h.move(P(0, 50));
    // 고무줄 끝이 거리 10에 묶인다
    const rb = ov(h).rubber[0]!.pts;
    expect(rb[2]).toBeCloseTo(0, 9);
    expect(rb[3]).toBeCloseTo(10, 9);
    expect(ov(h).dynFields![0]).toEqual({ text: '10', locked: true, active: false });
    h.cl.type('0');
    await settle();
    expect(pointOf(got.at(-1))!.x).toBeCloseTo(10, 9);
    expect(pointOf(got.at(-1))!.y).toBeCloseTo(0, 9);
  });

  it('숫자를 받는 요청(preferNumber)은 값 그대로 글로 — 칸 없음', async () => {
    const h = setup();
    const got = pointCmd(h, 'PT', { base: P(1, 1), preferNumber: true });
    void h.app.run('PT');
    await settle();
    h.move(P(4, 5));
    expect(ov(h).dynFields).toBeNull();
    h.cl.type('12.5');
    await settle();
    expect(got.at(-1)).toEqual({ text: '12.5' });
  });
});

describe('객체 스냅 재지정', () => {
  it('END·MID는 다음 한 점만(대상: 프롬프트), 잡히지 않으면 다시 묻고, NON은 스냅 없이', async () => {
    const h = setup();
    h.line(0, 0, 10, 0);
    const got = pointCmd(h, 'PT');
    void h.app.run('PT');
    await settle();
    h.app.submitInput('MID');
    expect(h.cmd.prompt).toBe('대상:');
    h.click(P(4, 1));
    await settle();
    expect(got.at(-1)).toEqual({ point: P(5, 0), snap: { kind: 'mid', handle: expect.any(String), handle2: undefined } });
    // 다음 점은 기본 스냅(끝점)
    void h.app.run('PT');
    await settle();
    h.click(P(4, 1));
    await settle();
    expect(got.at(-1)).toMatchObject({ point: P(0, 0), snap: { kind: 'end' } });
    // END가 잡히지 않는 빈 곳: 알리고 기다린다
    void h.app.run('PT');
    await settle();
    h.app.submitInput('END');
    h.click(P(50, 50));
    await settle();
    expect(got.length).toBe(2);
    expect(h.out().at(-1)).toContain('객체 스냅 점을 찾지 못했습니다');
    h.click(P(9, 1));
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(10, 0));
    void h.app.run('PT');
    await settle();
    h.app.submitInput('NON');
    h.click(P(0.5, 0.5));
    await settle();
    expect(got.at(-1)).toEqual({ point: P(0.5, 0.5), snap: null });
  });

  it('FROM(동적 입력이면 간격도 상대)·M2P·.X 필터, 더 묻는 중 Esc는 명령 취소', async () => {
    const h = setup();
    const got = pointCmd(h, 'PT');
    void h.app.run('PT');
    await settle();
    h.cl.type('FROM');
    expect(h.cmd.prompt).toBe('기준점:');
    h.cl.type('10,10');
    await settle();
    expect(h.cmd.prompt).toBe('<간격띄우기>:');
    h.cl.type('5,0');
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(15, 10));
    void h.app.run('PT');
    await settle();
    for (const t of ['M2P', '0,0', '10,4']) {
      h.app.submitInput(t);
      await settle();
    }
    expect(pointOf(got.at(-1))).toEqual(P(5, 2));
    void h.app.run('PT');
    await settle();
    h.app.submitInput('.X');
    expect(h.cmd.prompt).toBe('대상:');
    h.app.submitInput('1,2');
    await settle();
    expect(h.cmd.prompt).toBe('(YZ 필요):');
    h.app.submitInput('7,8');
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(1, 8));
    void h.app.run('PT');
    await settle();
    h.app.submitInput('FROM');
    h.app.cancel();
    await settle();
    expect(got.length).toBe(3);
    expect(h.out()).toContain('*취소*');
    expect(h.app.pendingInput).toBeNull();
  });

  it('TT: 임시 추적점에서 수평·수직 정렬(객체 스냅 추적이 꺼져 있어도), 그 점 요청에서만', async () => {
    const h = setup();
    const got = pointCmd(h, 'PT');
    void h.app.run('PT');
    await settle();
    h.app.submitInput('TT');
    expect(h.cmd.prompt).toBe('임시 OTRACK 점 지정:');
    h.app.submitInput('10,10');
    await settle();
    expect(h.app.pendingInput?.prompt).toBe('PT 점:');
    expect(ov(h).acquired).toEqual([P(10, 10)]);
    h.click(P(10.3, 30));
    await settle();
    expect(pointOf(got.at(-1))!.x).toBeCloseTo(10, 9);
    expect(pointOf(got.at(-1))!.y).toBeCloseTo(30, 9);
    void h.app.run('PT');
    await settle();
    h.click(P(10.3, 30));
    await settle();
    expect(pointOf(got.at(-1))).toEqual(P(10.3, 30));
  });

  it('연장선: 끝점 위에 잠시 머물면 획득(+), 그 연장선 위의 커서는 연장선 스냅', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.line(0, 0, 10, 0);
    const got = pointCmd(h, 'PT', { base: P(0, -20) });
    void h.app.run('PT');
    await vi.advanceTimersByTimeAsync(0);
    h.move(P(10.2, 0.2));
    vi.advanceTimersByTime(450);
    expect(ov(h).acquired).toEqual([P(10, 0)]);
    h.move(P(24, 0.6));
    expect(ov(h).snap).toMatchObject({ kind: 'ext', p: P(24, 0) });
    expect(ov(h).tracks.length).toBe(1);
    h.click(P(24, 0.6));
    await vi.advanceTimersByTimeAsync(0);
    expect(got.at(-1)).toMatchObject({ point: P(24, 0), snap: { kind: 'ext' } });
  });
});

describe('Shift 임시 직교와 클릭 보조키', () => {
  it('Shift를 누르는 동안 직교를 뒤집고, 결과에 shift를 싣는다', async () => {
    const h = setup();
    const got = pointCmd(h, 'PT', { base: P(0, 0) });
    void h.app.run('PT');
    await settle();
    h.click(P(10, 3), { shiftKey: true });
    await settle();
    expect(got.at(-1)).toEqual({ point: P(10, 0), snap: null, shift: true });
    h.app.orthoOn = true;
    void h.app.run('PT');
    await settle();
    h.click(P(10, 3), { shiftKey: true, ctrlKey: true });
    await settle();
    expect(got.at(-1)).toEqual({ point: P(10, 3), snap: null, shift: true, ctrl: true });
  });
});

describe('오른쪽 클릭', () => {
  it('옵션 없는 점 프롬프트·객체 선택은 바로 Enter, 옵션이 있으면 명령 메뉴, Shift는 스냅 재지정 메뉴', async () => {
    const h = setup();
    const got = pointCmd(h, 'PT');
    void h.app.run('PT');
    await settle();
    h.view.events.context!(P(1, 1), P(1, 1), ev());
    await settle();
    expect(got.at(-1)).toEqual({ enter: true });
    expect(dom.showMenu).not.toHaveBeenCalled();
    const kw = pointCmd(h, 'KW', { keywords: [{ key: 'U', label: '명령 취소' }] });
    void h.app.run('KW');
    await settle();
    h.view.events.context!(P(1, 1), P(1, 1), ev());
    const items = vi.mocked(dom.showMenu).mock.calls.at(-1)![2];
    expect(items.map((i) => i.label).filter(Boolean)).toEqual(expect.arrayContaining(['입력', '취소', '최근 입력 ▸', '명령 취소(U)', '객체 스냅 재지정 ▸']));
    h.view.events.context!(P(1, 1), P(1, 1), ev({ shiftKey: true }));
    const snapItems = vi.mocked(dom.showMenu).mock.calls.at(-1)![2];
    expect(snapItems[0]).toEqual({ heading: '객체 스냅 재지정' });
    expect(snapItems.map((i) => i.label)).toEqual(expect.arrayContaining(['임시 추적점', '시작점', '두 점 사이의 중간점', '끝점', '평행', '없음']));
    // 메뉴의 "중간점" = MID 재지정
    snapItems.find((i) => i.label === '중간점')!.run!();
    expect(h.cmd.prompt).toBe('대상:');
    items.find((i) => i.label === '명령 취소(U)')!.run!();
    await settle();
    expect(kw.at(-1)).toEqual({ keyword: 'U' });
  });

  it('명령이 없으면 편집·기본 모드 메뉴(반복·최근 입력·고리 항목), 그립 위는 다기능 그립 메뉴', async () => {
    const h = setup();
    const a = h.line(0, 0, 10, 0);
    pointCmd(h, 'PT');
    void h.app.run('PT');
    await settle();
    h.app.cancel();
    await settle();
    addHook(h.app.contextMenuProviders, { name: 'x', items: ({ mode }) => [{ label: `고리-${mode}` }] });
    h.view.events.context!(P(50, 50), P(50, 50), ev());
    let labels = vi.mocked(dom.showMenu).mock.calls.at(-1)![2].map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['반복 PT', '최근 입력 ▸', '고리-default']));
    h.app.setSelection([a]);
    h.view.events.context!(P(50, 50), P(50, 50), ev());
    labels = vi.mocked(dom.showMenu).mock.calls.at(-1)![2].map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['고리-edit', '그리기 순서 ▸', '모두 선택 해제']));
    addHook(h.app.gripMenuProviders, { name: 'g', items: (g) => [{ label: `그립 ${g.id}`, run: () => {} }] });
    h.view.events.context!(P(10, 0), P(10, 0), ev());
    labels = vi.mocked(dom.showMenu).mock.calls.at(-1)![2].map((i) => i.label);
    expect(labels).toEqual(['그립 end']);
  });
});

describe('객체 선택 옵션', () => {
  function selCmd(h: H) {
    const got: string[][] = [];
    h.app.register({
      name: 'SEL',
      title: 'SEL',
      async run(ctx) {
        got.push(await ctx.getSelection('객체 선택:', { noPickfirst: true }));
      },
    });
    return got;
  }

  it('단일(SI)은 한 번 고르면 끝, 명령 취소(U)는 마지막 고르기를 되돌린다', async () => {
    const h = setup();
    const a = h.line(0, 0, 10, 0);
    const b = h.line(0, 20, 10, 20);
    const got = selCmd(h);
    void h.app.run('SEL');
    await settle();
    h.app.submitInput('SI');
    await settle();
    h.click(P(5, 0));
    await settle();
    expect(got.at(-1)).toEqual([a]);
    h.app.clearSelection();
    void h.app.run('SEL');
    await settle();
    h.click(P(5, 0));
    h.click(P(5, 20));
    expect([...h.st.selection].sort()).toEqual([a, b].sort());
    h.app.submitInput('U');
    await settle();
    expect([...h.st.selection]).toEqual([a]);
    h.app.submitInput('');
    await settle();
    expect(got.at(-1)).toEqual([a]);
  });

  it('다중(M)은 강조 없이 모았다가 Enter로 더하고, 그룹(G)은 이름으로', async () => {
    const h = setup();
    const a = h.line(0, 0, 10, 0);
    const b = h.line(0, 20, 10, 20);
    const got = selCmd(h);
    void h.app.run('SEL');
    await settle();
    h.app.submitInput('M');
    await settle();
    h.click(P(5, 0));
    h.click(P(5, 20));
    expect(h.st.selection.size).toBe(0);
    h.app.submitInput('');
    expect([...h.st.selection].sort()).toEqual([a, b].sort());
    h.app.submitInput('');
    await settle();
    expect(got.at(-1)!.sort()).toEqual([a, b].sort());
    // 그룹
    const g = createGroupOps(h.doc, 'G1', '', [b], () => h.st.session.newHandle())!;
    h.st.session.commit({ label: 'GROUP', ops: g.ops });
    h.app.clearSelection();
    void h.app.run('SEL');
    await settle();
    h.app.submitInput('G');
    await settle();
    expect(h.cmd.prompt).toBe('그룹 이름 입력:');
    h.app.submitInput('g1');
    await settle();
    expect([...h.st.selection]).toEqual([b]);
    h.app.submitInput('');
    await settle();
    expect(got.at(-1)).toEqual([b]);
  });
});

describe('getEntity 옵션', () => {
  it('emptyPick이면 빈 곳 클릭·좌표 입력을 점으로, 고른 객체에는 Shift를 싣는다. 옵션이 없으면 빈 곳은 무시', async () => {
    const h = setup();
    const a = h.line(0, 0, 10, 0);
    const got: (EntityResult | EmptyPick)[] = [];
    h.app.register({
      name: 'ENT',
      title: 'ENT',
      async run(ctx) {
        got.push(await ctx.getEntity('객체 선택:', [], { emptyPick: true }));
      },
    });
    h.app.register({
      name: 'ENT0',
      title: 'ENT0',
      async run(ctx) {
        got.push(await ctx.getEntity('객체 선택:'));
      },
    });
    void h.app.run('ENT');
    await settle();
    h.click(P(50, 50));
    await settle();
    expect(got.at(-1)).toEqual({ point: P(50, 50), empty: true });
    void h.app.run('ENT');
    await settle();
    h.click(P(5, 0.5), { shiftKey: true });
    await settle();
    expect(got.at(-1)).toEqual({ handle: a, point: P(5, 0.5), shift: true });
    void h.app.run('ENT');
    await settle();
    h.app.submitInput('3,4');
    await settle();
    expect(got.at(-1)).toEqual({ point: P(3, 4), empty: true });
    void h.app.run('ENT0');
    await settle();
    h.click(P(50, 50));
    await settle();
    expect(got.length).toBe(3);
    h.click(P(5, 0.5));
    await settle();
    expect(got.at(-1)).toEqual({ handle: a, point: P(5, 0.5) });
  });
});

describe('끌기', () => {
  it('선택한 객체를 그립이 아닌 곳에서 끌면 미리보기 뒤 이동(명령 취소 한 단계), Ctrl이면 복사', async () => {
    const h = setup();
    const a = h.line(0, 0, 100, 0);
    h.app.setSelection([a]);
    h.view.events.down!(P(30, 0), P(30, 0), ev());
    h.view.events.drag!(P(30, 0), P(30, 10), false, ev());
    expect(ov(h).ghost[0]!.segs).toEqual([0, 10, 100, 10]);
    expect(ov(h).windowRect).toBeNull();
    h.view.events.drag!(P(30, 0), P(30, 10), true, ev());
    // 놓을 때 수정 모듈을 불러온다
    await vi.waitFor(() => expect((h.doc.entityIndex.get(a) as LineEntity).start).toMatchObject({ x: 0, y: 10 }), { timeout: 5000 });
    expect([...h.st.selection]).toEqual([a]);
    h.st.session.undo();
    expect((h.doc.entityIndex.get(a) as LineEntity).start).toMatchObject({ x: 0, y: 0 });
    const n = h.doc.blocks.get(MODEL_SPACE)!.entities.length;
    h.view.events.down!(P(30, 0), P(30, 0), ev());
    h.view.events.drag!(P(30, 0), P(30, 5), true, ev({ ctrlKey: true }));
    await vi.waitFor(() => expect(h.doc.blocks.get(MODEL_SPACE)!.entities.length).toBe(n + 1), { timeout: 5000 });
    expect((h.doc.entityIndex.get(a) as LineEntity).start).toMatchObject({ x: 0, y: 0 });
  });

  it('빈 곳에서 누른 채 끌면 올가미(오른쪽 = 윈도우), 스페이스바로 걸침·울타리, 끄는 동안 걸릴 객체 미리보기', async () => {
    const h = setup();
    const a = h.line(1, 1, 3, 1);
    const b = h.line(5, 1, 15, 1);
    const path = [P(8, 0), P(8, 3), P(0, 3)];
    const lasso = (cycles: number) => {
      h.app.clearSelection();
      h.view.events.down!(P(0, 0), P(0, 0), ev());
      for (const [i, p] of path.entries()) {
        if (i === 1) for (let k = 0; k < cycles; k++) h.cl.intercept!({ key: ' ' } as KeyboardEvent);
        h.view.events.drag!(P(0, 0), p, false, ev());
      }
      expect(ov(h).lasso).not.toBeNull();
      h.view.events.drag!(P(0, 0), P(0, 3), true, ev());
      expect(ov(h).lasso).toBeNull();
      return [...h.st.selection].sort();
    };
    expect(lasso(0)).toEqual([a]);
    // 윈도우 → 울타리
    expect(lasso(1)).toEqual([b]);
    // 윈도우 → 울타리 → 걸침
    expect(lasso(2)).toEqual([a, b].sort());
    // 클릭-클릭 창의 미리보기
    h.app.clearSelection();
    h.click(P(-10, -10));
    h.move(P(4, 2));
    expect(ov(h).preview.length).toBe(1);
    h.click(P(4, 2));
    expect([...h.st.selection]).toEqual([a]);
    expect(ov(h).preview).toEqual([]);
  });
});

describe('그립', () => {
  it('Shift+클릭으로 핫 그립 여럿(명령 없음), 그중 하나를 누르면 GRIPEDIT에 서로 다른 점의 그립을 넘긴다. Esc 한 번은 핫 그립만 푼다', async () => {
    const h = setup();
    const a = h.line(0, 0, 10, 0);
    const b = h.line(0, 20, 10, 20);
    let hot: typeof h.app.hotGrip = null;
    h.app.register({ name: 'GRIPEDIT', title: 'g', run: () => void (hot = h.app.hotGrip) });
    h.app.setSelection([a, b]);
    h.click(P(10, 0), { shiftKey: true });
    h.click(P(10, 20), { shiftKey: true });
    expect(ov(h).hotGrips).toEqual([P(10, 0), P(10, 20)]);
    expect(h.app.busyCommand).toBeNull();
    h.app.cancel();
    expect(ov(h).hotGrips).toEqual([]);
    expect(h.st.selection.size).toBe(2);
    h.click(P(10, 0), { shiftKey: true });
    h.click(P(10, 20), { shiftKey: true });
    h.click(P(10, 0));
    await settle();
    expect(hot!.point).toEqual(P(10, 0));
    expect(hot!.items).toEqual([
      { handle: a, id: 'end', point: P(10, 0) },
      { handle: b, id: 'end', point: P(10, 20) },
    ]);
    // 핫 그립이 아닌 그립을 누르면 그 그립 하나
    h.click(P(0, 0));
    await settle();
    expect(hot!.items).toEqual([{ handle: a, id: 'start', point: P(0, 0) }]);
  });

  it('그립을 눌러 끌면 그립 편집을 시작하고 놓은 곳이 그 점(창 선택이 아니다)', async () => {
    const h = setup();
    const a = h.line(0, 0, 100, 0);
    const got: PointResult[] = [];
    h.app.register({
      name: 'GRIPEDIT',
      title: 'g',
      async run(ctx) {
        got.push(await ctx.getPoint('신축점 지정:', { base: h.app.hotGrip!.point }));
      },
    });
    h.app.setSelection([a]);
    h.view.events.down!(P(100, 0), P(100, 0), ev());
    h.view.events.drag!(P(100, 0), P(100, 8), false, ev());
    await settle();
    expect(h.app.busyCommand).toBe('GRIPEDIT');
    expect(ov(h).windowRect).toBeNull();
    expect(ov(h).lasso).toBeFalsy();
    h.view.events.drag!(P(100, 0), P(100, 30), true, ev());
    await settle();
    expect(got).toEqual([{ point: P(100, 30), snap: null }]);
  });

  it('그립 위에 약 0.5초 머물면 분홍 그립과 다기능 그립 메뉴(고리 항목)', async () => {
    vi.useFakeTimers();
    const h = setup();
    const a = h.line(0, 0, 10, 0);
    const ran: string[] = [];
    addHook(h.app.gripMenuProviders, { name: 'g', items: (g) => [{ label: '정점 추가', run: () => void ran.push(g.id) }] });
    h.app.setSelection([a]);
    h.move(P(10.5, 0.5));
    expect(ov(h).hoverGrip).toEqual(P(10, 0));
    vi.advanceTimersByTime(520);
    const items = vi.mocked(dom.showMenu).mock.calls.at(-1)![2];
    expect(items.map((i) => i.label)).toEqual(['정점 추가']);
    items[0]!.run!();
    expect(ran).toEqual(['end']);
    h.move(P(60, 60));
    expect(ov(h).hoverGrip).toBeNull();
  });
});

describe('두 번 누르기와 Ctrl 단축키', () => {
  it('선은 빠른 특성, 폴리선 PEDIT, 스플라인 SPLINEDIT, 블록 참조 BEDIT(고리가 먼저)', async () => {
    const h = setup();
    const a = h.line(0, 0, 10, 0);
    const ran: string[] = [];
    for (const n of ['QUICKPROPERTIES', 'PEDIT', 'BEDIT', 'SPLINEDIT']) h.app.register({ name: n, title: n, run: () => void ran.push(n) });
    h.view.events.dblclick!(P(5, 0), P(5, 0), ev());
    await settle();
    expect(ran).toEqual(['QUICKPROPERTIES']);
    expect([...h.st.selection]).toEqual([a]);
    expect(dblClickCommand({ type: 'LWPOLYLINE' } as Entity)).toBe('PEDIT');
    expect(dblClickCommand({ type: 'POLYLINE' } as Entity)).toBe('PEDIT');
    expect(dblClickCommand({ type: 'SPLINE' } as Entity)).toBe('SPLINEDIT');
    expect(dblClickCommand({ type: 'INSERT' } as Entity)).toBe('BEDIT');
    expect(dblClickCommand({ type: 'IMAGE' } as Entity)).toBeNull();
    addHook(h.app.dblClickHandlers, { name: 'first', dblclick: () => true });
    h.view.events.dblclick!(P(5, 0), P(5, 0), ev());
    await settle();
    expect(ran).toEqual(['QUICKPROPERTIES']);
  });

  it('Ctrl+G·B·L·F·U는 제도 보조 켜고 끄기, Ctrl+J는 Enter, Ctrl+\\는 취소', async () => {
    const h = setup();
    const key = (k: string, code: string) => {
      const prevent = vi.fn();
      h.priv.onKey!({ key: k, code, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, target: null, preventDefault: prevent } as unknown as KeyboardEvent);
      return prevent;
    };
    expect(key('g', 'KeyG')).toHaveBeenCalled();
    expect(h.app.gridOn).toBe(true);
    key('b', 'KeyB');
    expect(h.app.snapOn).toBe(true);
    key('l', 'KeyL');
    expect(h.app.orthoOn).toBe(true);
    key('u', 'KeyU');
    expect(h.app.polarOn).toBe(true);
    expect(h.app.orthoOn).toBe(false);
    key('f', 'KeyF');
    expect(h.app.osnapOn).toBe(false);
    const got = pointCmd(h, 'PT');
    void h.app.run('PT');
    await settle();
    key('j', 'KeyJ');
    await settle();
    expect(got.at(-1)).toEqual({ enter: true });
    void h.app.run('PT');
    await settle();
    key('\\', 'Backslash');
    await settle();
    expect(h.app.pendingInput).toBeNull();
    expect(h.out()).toContain('*취소*');
  });
});
