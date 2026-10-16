// @vitest-environment jsdom
/**
 * 문자·치수 스타일(STYLE·DIMSTYLE 대화상자, 이름 바꾸기·재지정·비교), MLEADER 옵션, 지시선 연관, 치수 문자 각도(A),
 * FIELDEVAL. 진짜 App(가짜 화면·명령행)에서.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DimensionEntity, Entity, LeaderEntity, MLeaderEntity, MTextEntity, TextEntity } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { compareVars, dimStyleRenameOps, headerOverrides, registerDimStyleCommands, styleVars } from '../../src/app/dimstyle';
import { registerDimCommands, withStyleOverrides } from '../../src/app/dimcmds';
import { createLinearDimension } from '../../src/edit/dim';
import { textStyleDialog, textStyleRenameOps, usedTextStyles, withFontStyle, fontStyleOf } from '../../src/app/textedit/styledlg';
import { registerAnnotateCommands, mleaderSession } from '../../src/app/annotate';
import { registerLeaderAssoc } from '../../src/app/leaderassoc';
import { registerFieldCommands, setFieldEval, updateFieldsOn } from '../../src/app/fieldcmds';
import { encodeFieldXData } from '../../src/edit/field/store';
import { activeEditor } from '../../src/app/textedit/editor';
import { makeApp, settle } from '../polish/real-app';

vi.mock('../../src/app/view', async (orig) => ({ ...(await orig<object>()), CadView: (await import('../polish/fakes')).FakeView }));
vi.mock('../../src/app/commandline', async (orig) => ({ ...(await orig<object>()), CommandLine: (await import('../polish/fakes')).FakeCommandLine }));
vi.mock('../../src/app/engine', async (orig) => ({ ...(await orig<object>()), EngineClient: (await import('../polish/fakes')).FakeEngine }));
vi.mock('../../src/text/fonts', async (orig) => ({ ...(await orig<object>()), OutlineLibrary: (await import('../polish/fakes')).FakeFonts }));

// jsdom에는 캔버스 그리기가 없다(미리보기는 그리지 않고 넘어간다)
HTMLCanvasElement.prototype.getContext = (() => null) as never;

afterEach(() => {
  activeEditor()?.cancel();
  document.body.replaceChildren();
});

function setup() {
  const h = makeApp();
  h.app.text.layoutMText = ((p: { height: number; text: string }) => ({ glyphs: [], lines: [], minX: 0, minY: -p.height, maxX: p.text.length * p.height, maxY: 0 })) as never;
  return h;
}

function add<T extends Entity>(h: ReturnType<typeof setup>, e: T): T {
  if (!e.handle) e.handle = h.st.session.newHandle();
  h.st.session.commit({ label: 'ADD', ops: [{ kind: 'add', block: h.st.space, entity: e }] });
  return h.doc.entityIndex.get(e.handle) as T;
}

const mtext = (text: string, x = 0, y = 0): MTextEntity => ({ ...entityDefaults(), type: 'MTEXT', handle: '', insert: { x, y, z: 0 }, height: 2.5, width: 0, attachment: 1, drawingDirection: 1, text, style: 'Standard', rotation: 0, lineSpacingStyle: 1, lineSpacingFactor: 1, backgroundFlags: 0, backgroundScale: 1.5 });

describe('치수 스타일', () => {
  it('<스타일 재지정>: 머리말 치수 변수가 스타일과 다르면 재지정이고, 새 치수가 그것을 지닌다', () => {
    const h = setup();
    const cur = String(h.doc.header.get('$DIMSTYLE'));
    expect(headerOverrides(h.doc, cur)).toEqual({});
    h.doc.header.set('$DIMTXT', 5);
    h.doc.header.set('$DIMASZ', 4);
    expect(headerOverrides(h.doc, cur)).toEqual({ DIMTXT: 5, DIMASZ: 4 });
    const d = createLinearDimension(h.doc, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 5, z: 0 });
    withStyleOverrides(h.doc, d);
    expect(d.overrides).toMatchObject({ 140: 5, 41: 4 });
  });

  it('이름 바꾸기: 스타일과 그 스타일의 치수·머리말이 함께', () => {
    const h = setup();
    const cur = String(h.doc.header.get('$DIMSTYLE'));
    const d = add(h, { ...createLinearDimension(h.doc, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }), handle: '' } as DimensionEntity);
    h.st.session.commit({ label: 'RENAME', ops: dimStyleRenameOps(h.st, cur, '기계') });
    expect(h.doc.dimStyles.has('기계'.toUpperCase())).toBe(true);
    expect((h.doc.entityIndex.get(d.handle) as DimensionEntity).dimStyle).toBe('기계');
    expect(h.doc.header.get('$DIMSTYLE')).toBe('기계');
    h.st.session.undo();
    expect((h.doc.entityIndex.get(d.handle) as DimensionEntity).dimStyle).toBe(cur);
  });

  it('비교: 다른 변수만(대상이 없으면 모두)', () => {
    const a = { DIMTXT: 2.5, DIMASZ: 2.5, DIMDEC: 2 };
    const b = { DIMTXT: 3.5, DIMASZ: 2.5, DIMDEC: 2 };
    expect(compareVars(a, b).map((x) => x.name)).toEqual(['DIMTXT']);
    expect(compareVars(a, b)[0]).toMatchObject({ label: '문자 높이', a: '2.5', b: '3.5' });
    expect(compareVars(a, null).length).toBe(3);
  });

  it('관리자 대화상자: 목록·미리보기·단추가 한 대화상자, 비교 대화상자', async () => {
    const h = setup();
    registerDimStyleCommands(h.app);
    void h.app.run('DIMSTYLE');
    await settle();
    const dlg = document.querySelector('.dialog')!;
    expect(dlg.textContent).toContain('치수 스타일 관리자');
    expect(dlg.querySelector('[role="listbox"]')!.children.length).toBeGreaterThan(0);
    expect(dlg.querySelector('canvas')).toBeTruthy();
    const labels = [...dlg.querySelectorAll('button')].map((b) => b.textContent);
    for (const l of ['현재로 설정', '새로 만들기...', '수정...', '재지정...', '비교...']) expect(labels).toContain(l);
    ([...dlg.querySelectorAll('button')].find((b) => b.textContent === '비교...') as HTMLButtonElement).click();
    expect([...document.querySelectorAll('.dialog')].some((d) => d.textContent?.includes('치수 스타일 비교'))).toBe(true);
    // 재지정이 있으면 현재 스타일 아래 <스타일 재지정>
    h.doc.header.set('$DIMTXT', 9);
    document.body.replaceChildren();
    void h.app.run('DIMSTYLE');
    await settle();
    expect(document.querySelector('.dialog')!.textContent).toContain('<스타일 재지정>');
    void styleVars;
  });
});

describe('문자 스타일', () => {
  it('이름 바꾸기: 문자·여러 줄 문자·속성·치수 스타일 DIMTXSTY·머리말', () => {
    const h = setup();
    h.doc.textStyles.set('KOR', { name: 'Kor', handle: h.st.session.newHandle(), flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'malgun.ttf', bigFont: '', fontFamily: '맑은 고딕' });
    const t = add(h, { ...entityDefaults(), type: 'TEXT', handle: '', insert: { x: 0, y: 0, z: 0 }, height: 2.5, text: 'a', rotation: 0, widthFactor: 1, oblique: 0, style: 'Kor', generation: 0, halign: 0, valign: 0 } as TextEntity);
    const m = add(h, { ...mtext('b'), style: 'kor' });
    const ds = [...h.doc.dimStyles.values()][0]!;
    ds.vars.DIMTXSTY = 'Kor';
    h.doc.header.set('$TEXTSTYLE', 'Kor');
    expect(usedTextStyles(h.doc).has('KOR')).toBe(true);
    h.st.session.commit({ label: 'RENAME', ops: textStyleRenameOps(h.st, 'Kor', '한글') });
    expect((h.doc.entityIndex.get(t.handle) as TextEntity).style).toBe('한글');
    expect((h.doc.entityIndex.get(m.handle) as MTextEntity).style).toBe('한글');
    expect([...h.doc.dimStyles.values()].find((x) => x.name === ds.name)!.vars.DIMTXSTY).toBe('한글');
    expect(h.doc.header.get('$TEXTSTYLE')).toBe('한글');
    h.st.session.undo();
    expect((h.doc.entityIndex.get(t.handle) as TextEntity).style).toBe('Kor');
  });

  it('글꼴 스타일 비트(굵게 0x2000000·기울임 0x1000000)', () => {
    const s = { name: 'A', handle: '1', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'arial.ttf', bigFont: '', fontFamily: 'Arial', fontFlags: 34 };
    const b = withFontStyle(s, 3);
    expect(b.fontFlags).toBe(34 | 0x2000000 | 0x1000000);
    expect(fontStyleOf(b)).toBe(3);
    expect(withFontStyle(b, 0).fontFlags).toBe(34);
  });

  it('대화상자: 굵게로 바꾸고 적용하면 한 단계로 되돌린다, 효과(거꾸로·반대로)', async () => {
    const h = setup();
    h.doc.textStyles.set('ARIAL', { name: 'Arial', handle: h.st.session.newHandle(), flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'arial.ttf', bigFont: '', fontFamily: 'Arial', fontFlags: 34 });
    h.doc.header.set('$TEXTSTYLE', 'Arial');
    const done = textStyleDialog(h.app);
    const dlg = document.querySelector('.dialog')!;
    const fstyle = dlg.querySelector('select[aria-label="글꼴 스타일"]') as HTMLSelectElement;
    fstyle.value = '1';
    fstyle.dispatchEvent(new Event('change'));
    const up = dlg.querySelector('input[aria-label="거꾸로"]') as HTMLInputElement;
    up.checked = true;
    up.dispatchEvent(new Event('change'));
    ([...dlg.querySelectorAll('footer button')].find((b) => b.textContent === '적용') as HTMLButtonElement).click();
    const s = h.doc.textStyles.get('ARIAL')!;
    expect(fontStyleOf(s)).toBe(1);
    expect(s.generation & 4).toBe(4);
    ([...dlg.querySelectorAll('footer button')].find((b) => b.textContent === '닫기') as HTMLButtonElement).click();
    await done;
    h.st.session.undo();
    expect(fontStyleOf(h.doc.textStyles.get('ARIAL')!)).toBe(0);
  });
});

describe('MLEADER 옵션', () => {
  it('최대 점 수 3: 화살촉 → 중간 점 → 연결선, 첫 번째 각도 구속 45°', async () => {
    const h = setup();
    registerAnnotateCommands(h.app);
    void h.app.run('MLEADER');
    await settle();
    for (const t of ['O', 'M', '3', 'F', '45', 'X', '0,0', '10,1', '20,10']) {
      h.app.submitInput(t);
      await settle();
    }
    expect(document.querySelector('.te-box')).toBeTruthy();
    const box = document.querySelector('.te-box') as HTMLElement;
    box.firstElementChild!.replaceChildren(document.createTextNode('메모'));
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await settle();
    const m = [...h.doc.entityIndex.values()].find((x): x is MLeaderEntity => x.type === 'MULTILEADER')!;
    expect(m.context.text!.text).toBe('메모');
    const ld = m.context.leaders[0]!;
    expect(ld.lines[0]!.vertices.length).toBe(2);
    // 첫 세그먼트가 45°로 구속된다
    const v1 = ld.lines[0]!.vertices[1]!;
    expect(Math.atan2(v1.y, v1.x)).toBeCloseTo(0, 6);
    expect(ld.lastLeaderPoint).toMatchObject({ x: 20, y: 10 });
    expect(mleaderSession(h.doc).maxPoints).toBe(3);
  });

  it('내용 먼저(C): 문자 상자 → 편집기 → 화살촉. 내용 없음(N)', async () => {
    const h = setup();
    registerAnnotateCommands(h.app);
    void h.app.run('MLEADER');
    await settle();
    for (const t of ['C', '10,10', '40,0']) {
      h.app.submitInput(t);
      await settle();
    }
    const box = document.querySelector('.te-box') as HTMLElement;
    expect(box).toBeTruthy();
    box.firstElementChild!.replaceChildren(document.createTextNode('먼저'));
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await settle();
    h.app.submitInput('0,-20');
    await settle();
    const m = [...h.doc.entityIndex.values()].find((x): x is MLeaderEntity => x.type === 'MULTILEADER')!;
    expect(m.context.text!.text).toBe('먼저');
    expect(m.context.text!.width).toBeCloseTo(30);
    expect(m.context.text!.location.x).toBeCloseTo(10);
    expect(m.context.leaders[0]!.lines[0]!.vertices[0]).toMatchObject({ x: 0, y: -20 });
    // 내용 없음
    void h.app.run('MLEADER');
    await settle();
    for (const t of ['O', 'C', 'N', 'X', 'H', '0,0', '5,5']) {
      h.app.submitInput(t);
      await settle();
    }
    const none = [...h.doc.entityIndex.values()].filter((x): x is MLeaderEntity => x.type === 'MULTILEADER');
    expect(none.length).toBe(2);
    expect(none[1]!.contentType).toBe(0);
  });
});

describe('지시선 연관·치수 문자 각도·FIELDEVAL', () => {
  it('주석을 옮기면 지시선 끝이 따라가고 한 단계로 되돌아간다', () => {
    const h = setup();
    registerLeaderAssoc(h.app);
    const note = add(h, mtext('주석', 10, 10));
    const ld = add(h, { ...entityDefaults(), type: 'LEADER', handle: '', dimStyle: 'Standard', vertices: [{ x: 0, y: 0, z: 0 }, { x: 8, y: 9, z: 0 }], arrowHead: true, pathType: 0, creation: 0, hooklineDirection: 0, hookline: false, textHeight: 2.5, textWidth: 0, horizontalDirection: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, annotation: note.handle } as LeaderEntity);
    const n2 = { ...structuredClone(note), reactors: [ld.handle] };
    h.st.session.commit({ label: 'LINK', ops: [{ kind: 'modify', block: h.st.space, before: note, after: n2 }] });
    const before = h.doc.entityIndex.get(note.handle)!;
    h.st.session.commit({ label: 'MOVE', ops: [{ kind: 'modify', block: h.st.space, before, after: { ...structuredClone(before), insert: { x: 15, y: 12, z: 0 } } as Entity }] });
    const moved = h.doc.entityIndex.get(ld.handle) as LeaderEntity;
    expect(moved.vertices[1]).toMatchObject({ x: 13, y: 11 });
    expect(moved.vertices[0]).toMatchObject({ x: 0, y: 0 });
    h.st.session.undo();
    expect((h.doc.entityIndex.get(ld.handle) as LeaderEntity).vertices[1]).toMatchObject({ x: 8, y: 9 });
  });

  it('DIMLINEAR 각도(A): 치수 문자 각도(53)', async () => {
    const h = setup();
    registerDimCommands(h.app);
    void h.app.run('DIMLINEAR');
    await settle();
    for (const t of ['0,0', '30,0', 'A', '30', '15,10']) {
      h.app.submitInput(t);
      await settle();
    }
    const d = [...h.doc.entityIndex.values()].find((x): x is DimensionEntity => x.type === 'DIMENSION')!;
    expect(d.textRotation).toBeCloseTo(Math.PI / 6, 9);
  });

  it('FIELDEVAL: 저장 비트가 켜졌을 때만 저장 직전 필드를 다시 계산', () => {
    const h = setup();
    registerFieldCommands(h.app);
    const tpl = '%<\\AcVar Filename \\f "%fn6">%';
    const t = add(h, { ...entityDefaults(), type: 'TEXT', handle: '', insert: { x: 0, y: 0, z: 0 }, height: 2.5, text: 'old.dwg', rotation: 0, widthFactor: 1, oblique: 0, style: 'Standard', generation: 0, halign: 0, valign: 0, xdata: [encodeFieldXData(tpl, 'old.dwg')] } as TextEntity);
    setFieldEval(0);
    expect(updateFieldsOn(h.app, 'save', { fileName: 'new.dwg' })).toBe(0);
    setFieldEval(31);
    expect(updateFieldsOn(h.app, 'save', { fileName: 'new.dwg' })).toBe(1);
    expect((h.doc.entityIndex.get(t.handle) as TextEntity).text).toBe('new.dwg');
  });
});
