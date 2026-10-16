/**
 * 관리·출력 대화상자(BLOCK·DWGPROPS·OPTIONS·SYSVDLG·ALIASEDIT·PAGESETUP …)가 함께 쓰는 화면 도우미.
 * 탭·입력 칸·목록·결과를 돌려주는 대화상자. CSS 접두사는 mgr-.
 */
import { dialog, h } from './ui/dom';

const STYLE = `
.mgr-dlg{display:flex;flex-direction:column;gap:8px;min-width:0}
.mgr-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border-soft);flex-wrap:wrap}
.mgr-tabs button{border:0;background:transparent;color:var(--text-dim);padding:5px 12px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
.mgr-tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
.mgr-page{display:flex;flex-direction:column;gap:6px;padding-top:4px}
.mgr-page[hidden]{display:none}
.mgr-row{display:grid;grid-template-columns:140px 1fr;align-items:center;gap:8px}
.mgr-row.check{grid-template-columns:auto 1fr;justify-content:start}
.mgr-row > span{color:var(--text-dim);font-size:12.5px}
.mgr-row input[type=text],.mgr-row select,.mgr-row textarea,.mgr-in{height:28px;padding:0 6px;border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);color:var(--text);font:inherit;min-width:0;width:100%}
.mgr-row textarea{height:auto;padding:4px 6px;resize:vertical}
.mgr-group{border:1px solid var(--border-soft);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;margin:0}
.mgr-group legend{padding:0 4px;color:var(--text-dim);font-size:12px}
.mgr-cols{display:flex;gap:10px;flex-wrap:wrap}
.mgr-cols > *{flex:1;min-width:200px}
.mgr-list{border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);overflow:auto;max-height:260px;min-height:120px}
.mgr-list table{width:100%;border-collapse:collapse;font-size:12.5px}
.mgr-list th{position:sticky;top:0;background:var(--bg-panel);text-align:left;font-weight:600;padding:3px 6px;border-bottom:1px solid var(--border-soft);color:var(--text-dim)}
.mgr-list td{padding:3px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.mgr-list tr.on td{background:var(--bg-active);color:#fff}
.mgr-list tr.ro td{color:var(--text-faint)}
.mgr-list tbody tr{cursor:default}
.mgr-list tbody tr:hover td{background:var(--bg-hover)}
.mgr-list tbody tr.on:hover td{background:var(--bg-active)}
.mgr-btns{display:flex;gap:6px;flex-wrap:wrap}
.mgr-btns .btn{min-width:84px}
.mgr-note{font-size:12px;color:var(--text-dim)}
.mgr-err{font-size:12px;color:var(--danger);min-height:16px}
.mgr-prev{border:1px solid var(--border-soft);border-radius:4px;background:var(--canvas-model);width:100%;height:120px;display:block}
.mgr-inline{display:flex;gap:6px;align-items:center}
.mgr-inline > input{flex:1}
`;

export function ensureMgrStyle(): void {
  if (typeof document === 'undefined' || document.getElementById('mgr-style')) return;
  const s = document.createElement('style');
  s.id = 'mgr-style';
  s.textContent = STYLE;
  document.head.append(s);
}

/** 라벨 + 입력 한 줄 */
export function row(label: string, el: HTMLElement, title?: string): HTMLLabelElement {
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return h('label', { class: 'mgr-row check', title }, el, h('span', {}, label));
  return h('label', { class: 'mgr-row', title }, h('span', {}, label), el);
}

export function textIn(value: string, aria: string, list?: string): HTMLInputElement {
  const el = h('input', { type: 'text', 'aria-label': aria, list }) as HTMLInputElement;
  el.value = value;
  return el;
}

export function numIn(value: number, aria: string): HTMLInputElement {
  const el = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': aria }) as HTMLInputElement;
  el.value = String(+value.toFixed(8));
  return el;
}

export function checkIn(value: boolean, aria: string): HTMLInputElement {
  const el = h('input', { type: 'checkbox', 'aria-label': aria }) as HTMLInputElement;
  el.checked = value;
  return el;
}

export function selectIn(options: readonly { value: string; label: string }[], value: string, aria: string): HTMLSelectElement {
  const el = h('select', { 'aria-label': aria }, ...options.map((o) => h('option', { value: o.value }, o.label))) as HTMLSelectElement;
  el.value = value;
  if (el.value !== value && options.length) el.value = options[0]!.value;
  return el;
}

export function areaIn(value: string, aria: string, rows = 3): HTMLTextAreaElement {
  const el = h('textarea', { 'aria-label': aria, rows }) as HTMLTextAreaElement;
  el.value = value;
  return el;
}

export function group(legend: string, ...children: (Node | null | false)[]): HTMLFieldSetElement {
  return h('fieldset', { class: 'mgr-group' }, h('legend', {}, legend), ...children);
}

/** 숫자 칸 읽기(빈칸·숫자가 아니면 NaN) */
export function numOf(el: HTMLInputElement): number {
  const t = el.value.trim();
  return t ? Number(t) : NaN;
}

/** 탭 묶음: 탭 단추와 쪽. 쪽은 순서대로 */
export function tabs(pages: { label: string; body: HTMLElement }[], start = 0): { el: HTMLElement; show(i: number): void } {
  const btns = pages.map((p, i) => h('button', { type: 'button', role: 'tab', onclick: () => show(i) }, p.label) as HTMLButtonElement);
  const wraps = pages.map((p) => h('div', { class: 'mgr-page', role: 'tabpanel' }, p.body));
  const show = (i: number) => {
    btns.forEach((b, j) => {
      b.classList.toggle('on', i === j);
      b.setAttribute('aria-selected', String(i === j));
    });
    wraps.forEach((w, j) => (w.hidden = i !== j));
  };
  show(start);
  return { el: h('div', { class: 'mgr-dlg' }, h('div', { class: 'mgr-tabs', role: 'tablist' }, ...btns), ...wraps), show };
}

/** 확인을 거절하는 결과(대화상자를 열어 두고 문구를 보인다) */
export class DialogFail {
  constructor(readonly message: string) {}
}
export const fail = (message: string): DialogFail => new DialogFail(message);

export interface ResultDialogOptions<T> {
  ok?: string;
  cancel?: string | null;
  width?: number;
  /** 확인을 누르면 부른다: 결과(닫음) 또는 fail(문구)(열어 둔다) */
  submit: () => T | DialogFail;
  /** 확인·취소 앞에 둘 단추(누른 뒤 대화상자를 열어 둔다) */
  extra?: { label: string; run: () => void }[];
  /** 확인을 코드에서 누르는 함수를 받는다(대화상자 안 단추가 결과와 함께 닫을 때) */
  bind?: (submit: () => void) => void;
}

/** 결과를 돌려주는 대화상자(취소하거나 닫으면 null). Enter는 확인(여러 줄 칸 제외), Esc는 취소 */
export function resultDialog<T>(title: string, body: HTMLElement, opt: ResultDialogOptions<T>): Promise<T | null> {
  ensureMgrStyle();
  return new Promise((resolve) => {
    let done = false;
    const err = h('div', { class: 'mgr-err', role: 'alert' });
    const wrap = h('div', { class: 'mgr-dlg' }, body, err);
    const submit = () => {
      const r = opt.submit();
      if (r instanceof DialogFail) {
        err.textContent = r.message;
        return;
      }
      done = true;
      back.remove();
      resolve(r);
    };
    wrap.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent;
      k.stopPropagation();
      if (k.key === 'Enter' && !(k.target instanceof HTMLTextAreaElement) && !(k.target instanceof HTMLButtonElement)) {
        k.preventDefault();
        submit();
      }
    });
    opt.bind?.(submit);
    const buttons: { label: string; primary?: boolean; run?: () => void | boolean }[] = [];
    for (const x of opt.extra ?? []) buttons.push({ label: x.label, run: () => (x.run(), true) });
    if (opt.cancel !== null) buttons.push({ label: opt.cancel ?? '취소', run: () => undefined });
    buttons.push({ label: opt.ok ?? '확인', primary: true, run: () => (submit(), true) });
    const back = dialog(title, wrap, buttons);
    if (opt.width) (back.querySelector('.dialog') as HTMLElement | null)?.style.setProperty('width', `min(${opt.width}px, 100%)`);
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
    setTimeout(() => {
      const first = wrap.querySelector('input,select,textarea') as HTMLElement | null;
      first?.focus();
    });
  });
}

/** 열 머리와 행으로 고르는 목록(한 행 선택). 행을 다시 그릴 때 refresh */
export function pickList<R>(
  columns: string[],
  cells: (r: R) => string[],
  opt: { onPick?: (r: R | null) => void; onActivate?: (r: R) => void; rowClass?: (r: R) => string; height?: number } = {},
): { el: HTMLElement; refresh(rows: readonly R[], keep?: (r: R) => boolean): void; selected(): R | null; select(pred: (r: R) => boolean): void } {
  const body = h('tbody');
  const el = h('div', { class: 'mgr-list', style: opt.height ? `max-height:${opt.height}px` : undefined }, h('table', {}, h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', {}, c)))), body));
  let rows: readonly R[] = [];
  let sel = -1;
  const paint = () => {
    [...body.children].forEach((tr, i) => tr.classList.toggle('on', i === sel));
  };
  const api = {
    el,
    refresh(next: readonly R[], keep?: (r: R) => boolean) {
      const prev = sel >= 0 ? rows[sel] : undefined;
      rows = next;
      body.textContent = '';
      sel = -1;
      rows.forEach((r, i) => {
        const tr = h(
          'tr',
          {
            class: opt.rowClass?.(r) ?? '',
            onclick: () => {
              sel = i;
              paint();
              opt.onPick?.(r);
            },
            ondblclick: () => opt.onActivate?.(r),
          },
          ...cells(r).map((c) => h('td', { title: c }, c)),
        );
        body.append(tr);
        if ((keep && keep(r)) || (!keep && prev !== undefined && r === prev)) sel = i;
      });
      paint();
      opt.onPick?.(sel >= 0 ? rows[sel]! : null);
    },
    selected: () => (sel >= 0 ? (rows[sel] ?? null) : null),
    select(pred: (r: R) => boolean) {
      sel = rows.findIndex(pred);
      paint();
      opt.onPick?.(sel >= 0 ? rows[sel]! : null);
      (body.children[sel] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
    },
  };
  return api;
}

/** 단추 */
export function btn(label: string, run: () => void, primary = false): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${primary ? 'primary' : ''}`, onclick: run }, label) as HTMLButtonElement;
}

/** 이 브라우저의 보관 값(localStorage를 못 쓰면 이번 세션만) */
const memoryStore = new Map<string, string>();
export function prefGet(key: string): string | null {
  try {
    const v = globalThis.localStorage?.getItem(key);
    if (v !== undefined && v !== null) return v;
  } catch {
    // 사생활 보호 모드 등
  }
  return memoryStore.get(key) ?? null;
}
export function prefSet(key: string, value: string | null): void {
  if (value === null) memoryStore.delete(key);
  else memoryStore.set(key, value);
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // 보관하지 못하면 이번 세션만
  }
}
