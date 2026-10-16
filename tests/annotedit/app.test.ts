// @vitest-environment jsdom
/**
 * 진짜 App에서 주석 편집 흐름: TEXTEDIT·두 번 누르기(제자리 편집기), MTEXT·TEXT 명령, 치수·다중 지시선·지시선 문자,
 * 특성 팔레트 항목, 찾기 및 대치. 편집 하나는 명령 취소 한 단계다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DimensionEntity, Entity, LeaderEntity, MLeaderEntity, MTextEntity, TextEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { createLinearDimension } from '../../src/edit/dim';
import { registerEditCommands } from '../../src/app/editcmds';
import { registerTextCommands } from '../../src/app/textedit/commands';
import { dimensionBlockOps } from '../../src/app/dimcmds';
import { makeMLeader } from '../../src/app/annotate';
import { DIMENSION_FIELDS, MLEADER_FIELDS, applyField, commonValue } from '../../src/app/propedit';
import { findTargets, replaceTargets } from '../../src/app/textedit/findreplace';
import { activeEditor } from '../../src/app/textedit/editor';
import { findPanel, newFindState } from '../../src/app/textedit/palette';
import { makeApp, settle } from '../polish/real-app';

vi.mock('../../src/app/view', async (orig) => ({ ...(await orig<object>()), CadView: (await import('../polish/fakes')).FakeView }));
vi.mock('../../src/app/commandline', async (orig) => ({ ...(await orig<object>()), CommandLine: (await import('../polish/fakes')).FakeCommandLine }));
vi.mock('../../src/app/engine', async (orig) => ({ ...(await orig<object>()), EngineClient: (await import('../polish/fakes')).FakeEngine }));
vi.mock('../../src/text/fonts', async (orig) => ({ ...(await orig<object>()), OutlineLibrary: (await import('../polish/fakes')).FakeFonts }));

afterEach(() => {
  activeEditor()?.cancel();
  document.body.replaceChildren();
});

function setup() {
  const h = makeApp();
  registerEditCommands(h.app);
  registerTextCommands(h.app);
  // 시험의 가짜 글꼴로는 배치하지 못한다: 문자 범위만 대략
  h.app.text.layoutMText = ((p: { height: number; text: string }) => ({ glyphs: [], lines: [], minX: 0, minY: -p.height, maxX: p.text.length * p.height, maxY: 0 })) as never;
  return h;
}

function add(h: ReturnType<typeof setup>, e: Entity): Entity {
  e.handle = h.st.session.newHandle();
  h.st.session.commit({ label: 'ADD', ops: [{ kind: 'add', block: h.st.space, entity: e }] });
  return h.doc.entityIndex.get(e.handle)!;
}

const mtext = (text: string): MTextEntity => ({ ...entityDefaults(), type: 'MTEXT', handle: '', insert: { x: 0, y: 0, z: 0 }, height: 2.5, width: 50, attachment: 1, drawingDirection: 1, text, style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 });
const text = (t: string): TextEntity => ({ ...entityDefaults(), type: 'TEXT', handle: '', insert: { x: 0, y: 0, z: 0 }, height: 2.5, text: t, rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0 });

/** 열린 편집기의 첫 글자 마디를 바꾸고 입력 이벤트 */
function typeInto(t: string): void {
  const box = document.querySelector('.te-box') as HTMLElement;
  const span = box.querySelector('.te-r');
  if (span) span.firstChild!.nodeValue = t;
  else box.firstElementChild!.replaceChildren(document.createTextNode(t));
  box.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function key(k: string, opt: KeyboardEventInit = {}): void {
  (document.querySelector('.te-box') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opt }));
}

describe('TEXTEDIT·두 번 누르기', () => {
  it('여러 줄 문자를 제자리에서 고치고 명령 취소 한 단계로 되돌린다', async () => {
    const h = setup();
    const e = add(h, mtext('{\\C1;빨강} 보통'));
    void h.app.run('TEXTEDIT', e.handle);
    await settle();
    expect(document.querySelector('.te-box')).toBeTruthy();
    expect(document.querySelector('.te-bar [aria-label="문자 스타일"]')).toBeTruthy();
    const spans = document.querySelectorAll('.te-box .te-r');
    spans[1]!.firstChild!.nodeValue = ' 바뀜';
    (document.querySelector('.te-box') as HTMLElement).dispatchEvent(new InputEvent('input', { bubbles: true }));
    key('Enter', { ctrlKey: true });
    await settle();
    expect((h.doc.entityIndex.get(e.handle) as MTextEntity).text).toBe('{\\C1;빨강} 바뀜');
    expect(h.app.busyCommand).toBeNull();
    h.st.session.undo();
    expect((h.doc.entityIndex.get(e.handle) as MTextEntity).text).toBe('{\\C1;빨강} 보통');
  });

  it('두 번 누르기 고리가 문자·치수·다중 지시선을 맡는다(그 밖은 앱 기본 처리)', async () => {
    const h = setup();
    const e = add(h, text('%%c10'));
    const hook = h.app.dblClickHandlers.find((x) => x.name === 'textedit')!;
    expect(hook.dblclick(e.handle, e, { x: 0, y: 0 })).toBe(true);
    await settle();
    const box = document.querySelector('.te-box') as HTMLElement;
    expect(box.textContent).toBe('∅10');
    typeInto('∅12');
    key('Enter');
    await settle();
    expect((h.doc.entityIndex.get(e.handle) as TextEntity).text).toBe('%%c12');
    const line = add(h, { ...entityDefaults(), type: 'LINE', handle: '', start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } } as Entity);
    expect(hook.dblclick(line.handle, line, { x: 0, y: 0 })).toBe(false);
  });

  it('내용을 모두 지우면 객체를 지운다', async () => {
    const h = setup();
    const e = add(h, text('abc'));
    void h.app.run('TEXTEDIT', e.handle);
    await settle();
    typeInto('');
    key('Enter');
    await settle();
    expect(h.doc.entityIndex.has(e.handle)).toBe(false);
  });

  it('치수 문자: <>는 측정값 칩, 바꾸면 치수 블록을 다시 만든다', async () => {
    const h = setup();
    const d = createLinearDimension(h.doc, { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, { x: 20, y: 10, z: 0 });
    d.handle = h.st.session.newHandle();
    h.st.session.commit({ label: 'DIM', ops: [...dimensionBlockOps(h.st, d, false), { kind: 'add', block: h.st.space, entity: d }] });
    const blockBefore = d.block;
    void h.app.run('TEXTEDIT', d.handle);
    await settle();
    const chip = document.querySelector('.te-box .te-measure');
    expect(chip?.textContent).toMatch(/40/);
    // 칩 뒤에 글자를 붙인다
    chip!.parentElement!.append(document.createTextNode(' TYP'));
    (document.querySelector('.te-box') as HTMLElement).dispatchEvent(new InputEvent('input', { bubbles: true }));
    key('Enter', { ctrlKey: true });
    await settle();
    const after = h.doc.entityIndex.get(d.handle) as DimensionEntity;
    expect(after.text).toBe('<> TYP');
    const blk = h.doc.blocks.get(after.block.toUpperCase()) ?? [...h.doc.blocks.values()].find((b) => b.name === after.block);
    const mt = blk?.entities.find((x) => x.type === 'MTEXT') as MTextEntity | undefined;
    expect(mt?.text).toContain('TYP');
    void blockBefore;
  });

  it('다중 지시선 문자와 옛 지시선의 주석 문자', async () => {
    const h = setup();
    const ml = makeMLeader(h.app, { x: 0, y: 0 }, { x: 10, y: 10 }, '첫줄', 2.5, { lineType: 1, landing: true, doglegLength: 2 });
    const m = add(h, ml) as MLeaderEntity;
    void h.app.run('TEXTEDIT', m.handle);
    await settle();
    typeInto('고친 줄');
    key('Enter', { ctrlKey: true });
    await settle();
    expect((h.doc.entityIndex.get(m.handle) as MLeaderEntity).context.text!.text).toBe('고친 줄');
    const note = add(h, mtext('주석'));
    const ld = add(h, { ...entityDefaults(), type: 'LEADER', handle: '', dimStyle: 'Standard', vertices: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }], arrowHead: true, pathType: 0, creation: 0, hooklineDirection: 0, hookline: false, textHeight: 2.5, textWidth: 0, horizontalDirection: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, annotation: note.handle } as LeaderEntity);
    void h.app.run('TEXTEDIT', ld.handle);
    await settle();
    typeInto('바뀐 주석');
    key('Enter', { ctrlKey: true });
    await settle();
    expect((h.doc.entityIndex.get(note.handle) as MTextEntity).text).toBe('바뀐 주석');
  });

  it('Esc는 취소(도면은 그대로)', async () => {
    const h = setup();
    const e = add(h, mtext('그대로'));
    void h.app.run('TEXTEDIT', e.handle);
    await settle();
    typeInto('바꿈');
    key('Escape');
    await settle();
    expect((h.doc.entityIndex.get(e.handle) as MTextEntity).text).toBe('그대로');
    expect(h.app.busyCommand).toBeNull();
  });
});

describe('MTEXT·TEXT 명령', () => {
  it('MTEXT: 두 구석 → 제자리 편집기 → 여러 줄 문자(폭·자리맞추기·높이 옵션)', async () => {
    const h = setup();
    void h.app.run('MTEXT');
    await settle();
    h.app.submitInput('0,0');
    await settle();
    h.app.submitInput('J');
    await settle();
    h.app.submitInput('MC');
    await settle();
    h.app.submitInput('H');
    await settle();
    h.app.submitInput('5');
    await settle();
    h.app.submitInput('100,-50');
    await settle();
    expect(document.querySelector('.te-box')).toBeTruthy();
    typeInto('새 문자');
    key('Enter', { ctrlKey: true });
    await settle();
    const m = [...h.doc.entityIndex.values()].find((x) => x.type === 'MTEXT') as MTextEntity;
    expect(m.text).toBe('새 문자');
    expect(m.width).toBeCloseTo(100);
    expect(m.attachment).toBe(5);
    expect(m.height).toBe(5);
    expect(m.insert.x).toBeCloseTo(50);
    expect(m.insert.y).toBeCloseTo(-25);
  });

  it('TEXT: 명령행(스크립트) 입력도 받고, 도면 위 편집기에서 Enter로 줄을 넘긴다', async () => {
    const h = setup();
    void h.app.run('TEXT');
    await settle();
    h.app.submitInput('0,0');
    await settle();
    h.app.submitInput('2.5');
    await settle();
    h.app.submitInput('0');
    await settle();
    expect(document.querySelector('.te-box')).toBeTruthy();
    // 명령행
    h.app.submitInput('첫 줄');
    await settle();
    // 도면 위 편집기
    typeInto('둘째 줄');
    key('Enter');
    await settle();
    key('Enter');
    await settle();
    const texts = [...h.doc.entityIndex.values()].filter((x): x is TextEntity => x.type === 'TEXT');
    expect(texts.map((t) => t.text)).toEqual(['첫 줄', '둘째 줄']);
    expect(texts[1]!.insert.y).toBeCloseTo(-2.5 * 1.667 * 1);
    expect(document.querySelector('.te-box')).toBeNull();
    expect(h.app.busyCommand).toBeNull();
  });

  it('TEXT 자리맞추기(J): 중간 중심이면 정렬점', async () => {
    const h = setup();
    void h.app.run('TEXT');
    await settle();
    h.app.submitInput('J');
    await settle();
    h.app.submitInput('MC');
    await settle();
    h.app.submitInput('10,10');
    await settle();
    h.app.submitInput('3');
    await settle();
    h.app.submitInput('0');
    await settle();
    h.app.submitInput('가운데');
    await settle();
    h.app.submitInput('');
    await settle();
    const t = [...h.doc.entityIndex.values()].find((x): x is TextEntity => x.type === 'TEXT')!;
    expect(t).toMatchObject({ text: '가운데', halign: 1, valign: 2, height: 3 });
    expect(t.alignPoint).toMatchObject({ x: 10, y: 10 });
  });
});

describe('특성 팔레트·찾기 및 대치', () => {
  it('치수 문자 높이(재지정 DIMTXT)·문자 재지정: 블록을 다시 만든다', () => {
    const h = setup();
    const d = createLinearDimension(h.doc, { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, { x: 20, y: 10, z: 0 });
    d.handle = h.st.session.newHandle();
    h.st.session.commit({ label: 'DIM', ops: [...dimensionBlockOps(h.st, d, false), { kind: 'add', block: h.st.space, entity: d }] });
    const f = DIMENSION_FIELDS.find((x) => x.label === '문자 높이')!;
    expect(commonValue(f, [d], h.doc).value).toBeGreaterThan(0);
    applyField(h.app, [d.handle], f, 7);
    const a = h.doc.entityIndex.get(d.handle) as DimensionEntity;
    expect(a.overrides?.[140]).toBe(7);
    const blk = [...h.doc.blocks.values()].find((b) => b.name === a.block)!;
    expect((blk.entities.find((x) => x.type === 'MTEXT') as MTextEntity).height).toBeCloseTo(7);
    applyField(h.app, [d.handle], DIMENSION_FIELDS.find((x) => x.label === '문자 재지정')!, '<> 공통');
    expect((h.doc.entityIndex.get(d.handle) as DimensionEntity).text).toBe('<> 공통');
    h.st.session.undo();
    expect((h.doc.entityIndex.get(d.handle) as DimensionEntity).text).toBe('');
  });

  it('다중 지시선 연결선 거리: 내용이 그만큼 움직인다', () => {
    const h = setup();
    const m = add(h, makeMLeader(h.app, { x: 0, y: 0 }, { x: 10, y: 10 }, 'A', 2.5, { lineType: 1, landing: true, doglegLength: 2 })) as MLeaderEntity;
    const x0 = m.context.text!.location.x;
    applyField(h.app, [m.handle], MLEADER_FIELDS.find((x) => x.label === '연결선 거리')!, 5);
    const a = h.doc.entityIndex.get(m.handle) as MLeaderEntity;
    expect(a.context.leaders[0]!.doglegLength).toBe(5);
    expect(a.context.text!.location.x - x0).toBeCloseTo(3);
  });

  it('찾기 및 대치: 문자·속성 아닌 것·치수·다중 지시선, 한 단계로 되돌린다', () => {
    const h = setup();
    const t1 = add(h, text('M10 볼트'));
    const t2 = add(h, mtext('{\\C1;볼트} 둘'));
    const ml = add(h, makeMLeader(h.app, { x: 0, y: 0 }, { x: 10, y: 10 }, '볼트 구멍', 2.5, { lineType: 1, landing: true, doglegLength: 2 }));
    const q = { query: '볼트', matchCase: false, wholeWord: false, scope: 'all' as const, kinds: new Set(['text', 'attrib', 'dim', 'table', 'mleader'] as const) };
    const found = findTargets(h.app, q);
    expect(found.map((f) => f.handle).sort()).toEqual([t1.handle, t2.handle, ml.handle].sort());
    const depth = h.st.session.depth;
    const r = replaceTargets(h.app, found, q, '너트');
    expect(r.replaced).toBe(3);
    expect((h.doc.entityIndex.get(t1.handle) as TextEntity).text).toBe('M10 너트');
    expect((h.doc.entityIndex.get(t2.handle) as MTextEntity).text).toBe('{\\C1;너트} 둘');
    expect((h.doc.entityIndex.get(ml.handle) as MLeaderEntity).context.text!.text).toBe('너트 구멍');
    expect(h.st.session.depth).toBe(depth + 1);
    h.st.session.undo();
    expect((h.doc.entityIndex.get(t1.handle) as TextEntity).text).toBe('M10 볼트');
  });

  it('찾기 및 대치 탭: 찾을 위치·대소문자·모두 대치(필드가 있는 문자는 남기고 센다)', () => {
    const h = setup();
    const a = add(h, text('Bolt bolt'));
    const b = add(h, { ...text('bolt'), xdata: [{ app: 'OPENCAD_FIELD', items: [{ code: 1000, value: 'OPENCAD_FIELD 1' }, { code: 1071, value: 1 }, { code: 1000, value: '%<\\AcVar Author>%' }] }] } as TextEntity);
    const st = newFindState();
    const el = findPanel(h.app, st);
    document.body.append(el);
    const q = el.querySelector('input[aria-label="찾을 문자"]') as HTMLInputElement;
    const r = el.querySelector('input[aria-label="대치할 문자"]') as HTMLInputElement;
    q.value = 'bolt';
    q.dispatchEvent(new Event('input'));
    r.value = 'nut';
    r.dispatchEvent(new Event('input'));
    const mc = el.querySelector('input[aria-label="대소문자 일치"]') as HTMLInputElement;
    mc.checked = true;
    mc.dispatchEvent(new Event('change'));
    ([...el.querySelectorAll('button')].find((x) => x.textContent === '모두 대치') as HTMLButtonElement).click();
    expect((h.doc.entityIndex.get(a.handle) as TextEntity).text).toBe('Bolt nut');
    expect((h.doc.entityIndex.get(b.handle) as TextEntity).text).toBe('bolt');
    expect(h.out().some((l) => l.includes('필드가 있는 문자 1개'))).toBe(true);
  });
});
