// @vitest-environment jsdom
/** 제자리 문자 편집기(DOM): 모델 ↔ DOM, 선택 위치, 서식 단추, 확인·취소 */
import { afterEach, describe, expect, it } from 'vitest';
import { getSel, offsetAt, readDoc, renderDoc, setSel, type RenderCtx } from '../../src/app/textedit/dom';
import { TextEditor } from '../../src/app/textedit/editor';
import { mtextMeaning, parseRich, serializeRich } from '../../src/text/mtextedit';

const rc: RenderCtx = { baseHeight: 2.5, family: 'sans-serif', styleShx: false, entityColor: '#fff', fieldValue: () => '2026-10-16', measureText: '12.5', attachment: 1, lineSpacing: 1 };

afterEach(() => {
  document.body.replaceChildren();
});

describe('모델 ↔ DOM', () => {
  const SAMPLES = ['abc', '{\\fArial|b1|i0|c0|p34;굵게}보통\\P둘째', '\\pxqc;가운데\\P이어받음', '분수 \\S1/2; 끝', 'a^Ib', '{\\C1;빨강}{\\H2x;큰}', '열1\\N열2', ''];
  for (const s of SAMPLES) {
    it(`그렸다 읽어도 같은 뜻: ${s || '(빈 문자)'}`, () => {
      const root = document.createElement('div');
      document.body.append(root);
      renderDoc(root, parseRich(s), rc);
      const back = serializeRich(readDoc(root));
      expect(mtextMeaning(back, 2.5)).toEqual(mtextMeaning(s, 2.5));
    });
  }

  it('필드·측정값 칩', () => {
    const root = document.createElement('div');
    renderDoc(root, parseRich('A %<\\AcVar Date>% <>', { fields: true, measure: true }), rc);
    expect(root.querySelector('.te-field')?.textContent).toBe('2026-10-16');
    expect(root.querySelector('.te-measure')?.textContent).toBe('12.5');
    expect(serializeRich(readDoc(root))).toBe('A %<\\AcVar Date>% <>');
  });

  it('브라우저가 넣은 글자는 둘레 서식을 받는다', () => {
    const root = document.createElement('div');
    renderDoc(root, parseRich('{\\L밑줄}보통'), rc);
    const span = root.querySelector('.te-r') as HTMLElement;
    span.firstChild!.nodeValue = '밑줄XY';
    expect(serializeRich(readDoc(root))).toBe('{\\L밑줄XY}보통');
  });

  it('문단 요소가 나뉘어도(브라우저 줄 바꿈) 문단 서식을 잇는다', () => {
    const root = document.createElement('div');
    renderDoc(root, parseRich('\\pxqr;오른쪽'), rc);
    const p = root.firstElementChild!;
    p.append(document.createElement('br'), document.createTextNode('다음'));
    const d = readDoc(root);
    expect(d.paras.length).toBe(2);
    expect(d.paras[1]!.pf.align).toBe('r');
  });

  it('선택 위치 ↔ 오프셋(문단 사이 1칸, 칩은 1칸)', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const doc = parseRich('ab\\S1/2;c\\Pde');
    renderDoc(root, doc, rc);
    for (const off of [0, 1, 2, 3, 4, 5, 6, 7]) {
      setSel(root, doc, off);
      expect(getSel(root)!.a).toBe(off);
    }
    setSel(root, doc, 1, 6);
    expect(getSel(root)).toEqual({ a: 1, b: 6 });
    // 문단 사이(root 자신)
    expect(offsetAt(root, root, 1)).toBe(4);
  });
});

describe('편집기', () => {
  it('굵게·밑줄 단추는 선택한 글자에만, Ctrl+Enter로 확인', async () => {
    const ed = new TextEditor(null, { mode: 'mtext', label: '시험', text: '{\\fArial|b0|i0|c0|p34;abcd}', height: 2.5, style: 'Standard' });
    const p = ed.open();
    expect(document.querySelector('.te-box')).toBeTruthy();
    expect(document.querySelector('.te-bar')).toBeTruthy();
    setSel(ed.box, ed.doc, 1, 3);
    (ed as unknown as { lastSel: { a: number; b: number } }).lastSel = { a: 1, b: 3 };
    ed.toggle('bold');
    ed.toggle('underline');
    ed.box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    const r = await p;
    expect(r).not.toBeNull();
    expect(r!.textChanged).toBe(true);
    expect(r!.text).toBe('{\\fArial|b0|i0|c0|p34;a}{\\fArial|b1|i0|c0|p34;\\Lbc}{\\fArial|b0|i0|c0|p34;d}');
    expect(document.querySelector('.te-box')).toBeNull();
  });

  it('고치지 않으면 처음 문자열을 그대로, Esc는 취소', async () => {
    const src = '\\pxi-3,l3,t3;{\\H1.5x;•^I항목}';
    const ed = new TextEditor(null, { mode: 'mtext', label: '시험', text: src, height: 2.5, style: 'Standard' });
    const p = ed.open();
    ed.confirm();
    const r = await p;
    expect(r!.text).toBe(src);
    expect(r!.changed).toBe(false);
    const ed2 = new TextEditor(null, { mode: 'mtext', label: '시험', text: src, height: 2.5, style: 'Standard' });
    const p2 = ed2.open();
    ed2.box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p2).toBeNull();
  });

  it('Enter는 문단 나누기, 한 줄 문자에서는 확인', async () => {
    const ed = new TextEditor(null, { mode: 'mtext', label: '시험', text: 'abcd', height: 2.5, style: 'Standard' });
    const p = ed.open();
    setSel(ed.box, ed.doc, 2);
    (ed as unknown as { lastSel: { a: number; b: number } }).lastSel = { a: 2, b: 2 };
    ed.box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ed.doc.paras.length).toBe(2);
    ed.confirm();
    expect((await p)!.text).toBe('ab\\Pcd');
    const t = new TextEditor(null, { mode: 'text', label: '시험', text: '%%c20', height: 2.5, style: 'Standard' });
    const pt = t.open();
    expect(t.box.textContent).toBe('\u220520');
    t.box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const rt = await pt;
    expect(rt!.text).toBe('%%c20');
    expect(rt!.changed).toBe(false);
  });

  it('기호 넣기·스택·목록·편집기 안 명령 취소', async () => {
    const ed = new TextEditor(null, { mode: 'mtext', label: '시험', text: '1/2', height: 2, style: 'Standard' });
    const p = ed.open();
    const sel = ed as unknown as { lastSel: { a: number; b: number } };
    setSel(ed.box, ed.doc, 0, 3);
    sel.lastSel = { a: 0, b: 3 };
    ed.stack();
    expect(serializeRich(ed.doc)).toBe('\\S1/2;');
    sel.lastSel = { a: 1, b: 1 };
    ed.insertString('\u00b0');
    expect(serializeRich(ed.doc)).toBe('\\S1/2;%%d');
    ed.undo();
    expect(serializeRich(ed.doc)).toBe('\\S1/2;');
    ed.redo();
    expect(serializeRich(ed.doc)).toBe('\\S1/2;%%d');
    sel.lastSel = { a: 0, b: 2 };
    ed.setList('bullet');
    expect(serializeRich(ed.doc)).toBe('\\pxi-3,l3,t3;•^I\\S1/2;%%d');
    ed.cancel();
    expect(await p).toBeNull();
  });

  it('타이핑(브라우저가 DOM을 고친 것)을 읽는다', async () => {
    const ed = new TextEditor(null, { mode: 'mtext', label: '시험', text: 'ab', height: 2.5, style: 'Standard' });
    const p = ed.open();
    const tn = ed.box.querySelector('.te-r')!.firstChild!;
    tn.nodeValue = 'abc가';
    ed.box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    ed.confirm();
    expect((await p)!.text).toBe('abc가');
  });

  it('높이: 선택 없으면 객체 높이, 일부 선택이면 \\H', async () => {
    const ed = new TextEditor(null, { mode: 'mtext', label: '시험', text: 'abc', height: 2.5, style: 'Standard' });
    const p = ed.open();
    const sel = ed as unknown as { lastSel: { a: number; b: number } };
    sel.lastSel = { a: 3, b: 3 };
    setSel(ed.box, ed.doc, 3);
    ed.setHeight(5);
    sel.lastSel = { a: 0, b: 1 };
    setSel(ed.box, ed.doc, 0, 1);
    ed.setHeight(2);
    ed.confirm();
    const r = (await p)!;
    expect(r.height).toBe(5);
    expect(r.text).toBe('{\\H2;a}bc');
  });
});

describe('고치지 않음 판단', () => {
  it('원래 표기(\\U+·%%nnn·\\Z)가 있어도 그대로 확인하면 고치지 않은 것', async () => {
    const src = '\\U+AC00\\U+B098 %%065 \\Z{\\C1;빨강}';
    const ed = new TextEditor(null, { mode: 'mtext', label: '시험', text: src, height: 2.5, style: 'Standard' });
    const p = ed.open();
    ed.box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    ed.confirm();
    const r = (await p)!;
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
    const t = new TextEditor(null, { mode: 'text', label: '시험', text: '100%%% \\U+AC00', height: 2.5, style: 'Standard' });
    const pt = t.open();
    t.confirm();
    expect((await pt)!.changed).toBe(false);
  });
});
