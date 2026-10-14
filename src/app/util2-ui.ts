/**
 * util2 명령이 함께 쓰는 화면 도우미: 대화상자, 명령행 질문, 지금 공간의 객체, 사용자 변수 저장.
 * 스타일은 이 파일이 한 번 넣는다(접두사 u2-).
 */
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import { dialog, h } from './ui/dom';

const CSS = `
.dialog.u2-wide { width: min(760px, 100%); }
.dialog.u2-mid { width: min(620px, 100%); }
.u2-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.u2-row > label { display: inline-flex; gap: 6px; align-items: center; }
.u2-col { display: flex; flex-direction: column; gap: 6px; }
.u2-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.u2-side { display: grid; grid-template-columns: 1fr 140px; gap: 10px; }
.u2 select, .u2 input[type=text], .u2 input:not([type]), .u2 textarea {
  height: 26px; padding: 0 6px; border: 1px solid var(--border-soft); border-radius: 3px;
  background: var(--bg-input); color: var(--text); font: inherit; min-width: 0;
}
.u2 select:focus, .u2 input:focus { border-color: var(--accent); outline: 0; }
.u2 .btn { height: 28px; padding: 0 10px; }
.u2 .btn[disabled] { opacity: .45; cursor: default; }
.u2-list { border: 1px solid var(--border-soft); border-radius: 3px; background: var(--bg-input); overflow: auto; min-height: 120px; max-height: 300px; }
.u2-list .u2-item { padding: 2px 8px; cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.u2-list .u2-item:hover { background: var(--bg-hover); }
.u2-list .u2-item.sel { background: var(--bg-active); color: #fff; }
.u2-list .u2-item.dim { color: var(--text-faint); }
.u2-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.u2-table th { position: sticky; top: 0; background: var(--bg-ribbon); text-align: left; font-weight: 600; padding: 3px 8px; border-bottom: 1px solid var(--border); }
.u2-table td { padding: 2px 8px; border-bottom: 1px solid rgba(255,255,255,.04); white-space: nowrap; }
.u2-table td.num { text-align: right; font-family: var(--mono); }
.u2-table tr.sel td { background: var(--bg-active); color: #fff; }
.u2-table tbody tr:hover td { background: var(--bg-hover); }
.u2-note { color: var(--text-dim); font-size: 12px; }
.u2-err { color: #ff8a80; min-height: 16px; font-size: 12px; }
.u2-result { font-family: var(--mono); font-size: 18px; text-align: right; padding: 6px 8px; border: 1px solid var(--border-soft); border-radius: 3px; background: var(--bg-input); min-height: 34px; overflow-x: auto; }
.u2-keys { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
.u2-keys .btn { justify-content: center; padding: 0 4px; }
.u2 fieldset { border: 1px solid var(--border-soft); border-radius: 4px; padding: 6px 10px 8px; margin: 0 0 8px; }
.u2 legend { padding: 0 4px; color: var(--text-dim); font-size: 12px; }
`;

export function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('u2-style')) return;
  const s = document.createElement('style');
  s.id = 'u2-style';
  s.textContent = CSS;
  document.head.append(s);
}

export interface ModalButton<T> {
  label: string;
  primary?: boolean;
  /** 누르면 이 값으로 닫는다. 함수면 그 결과(undefined면 닫지 않는다) */
  value: T | (() => T | undefined);
}

/** 대화상자를 열고 단추 값으로 닫힐 때까지 기다린다(닫기·Esc면 null) */
export function modal<T>(title: string, body: HTMLElement, buttons: ModalButton<T>[], size: 'normal' | 'mid' | 'wide' = 'normal'): { done: Promise<T | null>; close: (v: T | null) => void; back: HTMLDivElement } {
  ensureStyles();
  let resolveFn!: (v: T | null) => void;
  let settled = false;
  const done = new Promise<T | null>((r) => (resolveFn = r));
  const finish = (v: T | null) => {
    if (settled) return;
    settled = true;
    resolveFn(v);
  };
  body.classList.add('u2');
  const back = dialog(
    title,
    body,
    buttons.map((b) => ({
      label: b.label,
      primary: b.primary,
      run: () => {
        const v = typeof b.value === 'function' ? (b.value as () => T | undefined)() : b.value;
        if (v === undefined) return true;
        finish(v);
        return undefined;
      },
    })),
  );
  if (size !== 'normal') back.querySelector('.dialog')?.classList.add(size === 'wide' ? 'u2-wide' : 'u2-mid');
  const obs = new MutationObserver(() => {
    if (!back.isConnected) {
      obs.disconnect();
      finish(null);
    }
  });
  obs.observe(document.body, { childList: true });
  return {
    done,
    back,
    close: (v) => {
      finish(v);
      back.remove();
    },
  };
}

/** 선택 목록(한 개 고르기). onPick은 고를 때, onActivate는 두 번 누를 때 */
export function listBox(items: { value: string; label: string; dim?: boolean }[], selected: string | null, onPick: (v: string) => void, onActivate?: (v: string) => void): { el: HTMLDivElement; set(items: { value: string; label: string; dim?: boolean }[], sel: string | null): void; value(): string | null } {
  const el = h('div', { class: 'u2-list', tabindex: 0 });
  let cur = selected;
  let list = items;
  const render = () => {
    el.innerHTML = '';
    for (const it of list) {
      const d = h('div', { class: `u2-item${it.value === cur ? ' sel' : ''}${it.dim ? ' dim' : ''}`, title: it.label }, it.label);
      d.addEventListener('click', () => {
        cur = it.value;
        render();
        onPick(it.value);
      });
      if (onActivate) d.addEventListener('dblclick', () => onActivate(it.value));
      el.append(d);
    }
  };
  render();
  return {
    el,
    set(items2, sel) {
      list = items2;
      cur = sel;
      render();
    },
    value: () => cur,
  };
}

/** 선택 상자 */
export function select(options: { value: string; label: string }[], value: string, onChange?: (v: string) => void): HTMLSelectElement {
  const s = h('select', {}, ...options.map((o) => h('option', { value: o.value }, o.label))) as HTMLSelectElement;
  s.value = value;
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function setOptions(s: HTMLSelectElement, options: { value: string; label: string }[], value?: string): void {
  const keep = value ?? s.value;
  s.innerHTML = '';
  for (const o of options) s.append(h('option', { value: o.value }, o.label));
  s.value = options.some((o) => o.value === keep) ? keep : (options[0]?.value ?? '');
}

export function textInput(value = '', placeholder = ''): HTMLInputElement {
  const i = h('input', { type: 'text', placeholder }) as HTMLInputElement;
  i.value = value;
  return i;
}

export function checkbox(label: string, checked: boolean, onChange?: (v: boolean) => void): { el: HTMLLabelElement; box: HTMLInputElement } {
  const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = checked;
  if (onChange) box.addEventListener('change', () => onChange(box.checked));
  return { el: h('label', {}, box, label), box };
}

export function button(label: string, run: () => void, opt: { primary?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const b = h('button', { class: `btn${opt.primary ? ' primary' : ''}`, type: 'button', disabled: !!opt.disabled }, label) as HTMLButtonElement;
  b.addEventListener('click', run);
  return b;
}

// ---------------------------------------------------------------------------
// 명령행 질문
// ---------------------------------------------------------------------------

/** 키워드 질문. 키워드 키, Enter면 def(없으면 null), 글이면 { text } */
export async function askKeyword(ctx: CommandContext, prompt: string, keywords: Keyword[], def?: string): Promise<string | { text: string } | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { keywords, allowText: true });
    if ('keyword' in r) return r.keyword;
    if ('enter' in r) return def ?? null;
    if ('text' in r) {
      const t = r.text.trim();
      const k = keywords.find((x) => x.key.toUpperCase() === t.toUpperCase() || x.label === t);
      if (k) return k.key;
      return { text: t };
    }
    ctx.print('옵션을 입력하십시오.', 'err');
  }
}

/** 예/아니오 */
export async function askYesNo(ctx: CommandContext, prompt: string, def: boolean): Promise<boolean> {
  for (;;) {
    const r = await askKeyword(ctx, `${prompt} [예(Y)/아니오(N)] <${def ? '예' : '아니오'}>:`, [
      { key: 'Y', label: '예' },
      { key: 'N', label: '아니오' },
    ]);
    if (r === null) return def;
    if (r === 'Y') return true;
    if (r === 'N') return false;
    ctx.print('Y 또는 N을 입력하십시오.', 'err');
  }
}

/** 글 입력(빈칸 포함). Enter면 def */
export async function askText(ctx: CommandContext, prompt: string, def = ''): Promise<string> {
  const app = ctx.app;
  const prev = app.cmd.acceptSpaces;
  app.cmd.acceptSpaces = true;
  try {
    const r = await ctx.getPoint(prompt, { allowText: true });
    if ('text' in r) return r.text;
    if ('point' in r) return `${r.point.x},${r.point.y}`;
    return def;
  } finally {
    app.cmd.acceptSpaces = prev;
  }
}

/** 정수 입력 */
export async function askInt(ctx: CommandContext, prompt: string, def: number, min: number, max: number): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${def}>:`, { allowText: true, preferNumber: true });
    if ('enter' in r) return def;
    if ('text' in r) {
      const v = Number(r.text.trim());
      if (Number.isInteger(v) && v >= min && v <= max) return v;
    }
    ctx.print(`${min}에서 ${max} 사이의 정수가 필요합니다.`, 'err');
  }
}

// ---------------------------------------------------------------------------
// 공간·선택
// ---------------------------------------------------------------------------

/** 지금 공간의 고를 수 있는 객체(켜져 있고 동결되지 않은 도면층, 숨기지 않은 것) */
export function spaceHandles(app: App): string[] {
  const st = app.active;
  if (!st) return [];
  const b = st.doc.blocks.get(st.space);
  const out: string[] = [];
  for (const e of b?.entities ?? []) {
    if (!e.handle || st.hiddenObjects.has(e.handle)) continue;
    const l = st.doc.layers.get(tableKey(e.layer));
    if (l && (l.off || l.frozen)) continue;
    out.push(e.handle);
  }
  return out;
}

/** 키워드를 받는 선택 프롬프트. 키워드면 { keyword } */
export async function selectWithKeywords(ctx: CommandContext, prompt: string, keywords: Keyword[], first: boolean): Promise<string[] | { keyword: string }> {
  try {
    return await ctx.getSelection(prompt, { keywords, noPickfirst: !first });
  } catch (e) {
    const k = (e as { keyword?: string }).keyword;
    if (k) return { keyword: k };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 사용자 변수(이 브라우저에 저장)
// ---------------------------------------------------------------------------

const memory = new Map<string, unknown>();

export function loadPref<T>(key: string, def: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const v = JSON.parse(raw) as T;
      memory.set(key, v);
      return v;
    }
  } catch {
    /* 저장소를 못 쓰면 기본값 */
  }
  return def;
}

export function savePref<T>(key: string, v: T): void {
  memory.set(key, v);
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 저장소를 못 쓰면 이 세션만 */
  }
}

/** 명령이 끝난 뒤 멈춘 프롬프트에 답을 넣는다(투명 명령의 결과) */
export function feedPrompt(app: App, text: string): void {
  setTimeout(() => {
    const input = app.cmd.input;
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  }, 0);
}

/** 고정폭 글꼴에서 글의 칸 수(한글·전각은 두 칸) */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

/** 칸 수 기준 오른쪽 채우기 */
export function padWide(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - textWidth(s)));
}

/** 이 명령이 다른 명령 안에서(투명하게) 실행 중인지 */
export function isNested(app: App, name: string): boolean {
  const b = app.busyCommand;
  return !!b && b.toUpperCase() !== name.toUpperCase();
}

// ---------------------------------------------------------------------------
// OOPS: 마지막으로 지운 객체(ERASE·WBLOCK 삭제)
// ---------------------------------------------------------------------------

export interface ErasedItem {
  block: string;
  entity: Entity;
  index: number;
}

const erased = new WeakMap<DocState, ErasedItem[]>();

export function rememberErased(st: DocState, items: ErasedItem[]): void {
  if (items.length) erased.set(st, items);
}

export function takeErased(st: DocState): ErasedItem[] | null {
  const v = erased.get(st) ?? null;
  erased.delete(st);
  return v;
}
