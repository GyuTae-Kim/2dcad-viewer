/** DOM 도우미: 요소 만들기, 알림, 메뉴, 대화상자 */
import { icon } from './icons';
import { clampBox } from './layout';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | ((ev: Event) => void) | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function iconSpan(name: string, cls = 'ic'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = icon(name);
  return s;
}

let toastWrap: HTMLDivElement | null = null;

export function toast(text: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 4200): void {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  const t = h('div', { class: `toast ${kind === 'info' ? '' : kind}` }, text);
  toastWrap.append(t);
  setTimeout(() => t.remove(), ms);
}

export interface MenuItem {
  label?: string;
  icon?: string;
  kbd?: string;
  disabled?: boolean;
  separator?: boolean;
  heading?: string;
  run?: () => void;
  /** 마우스가 올라갈 때(선택 순환의 강조 등) */
  hover?: () => void;
}

let openMenu: HTMLDivElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.separator) {
      m.append(h('hr'));
      continue;
    }
    if (it.heading) {
      m.append(h('div', { class: 'label' }, it.heading));
      continue;
    }
    const b = h(
      'button',
      {
        role: 'menuitem',
        disabled: !!it.disabled,
        onclick: () => {
          closeMenu();
          it.run?.();
        },
        onmouseenter: () => it.hover?.(),
      },
      it.icon ? iconSpan(it.icon) : h('span', { class: 'ic' }),
      it.label ?? '',
      it.kbd ? h('kbd', {}, it.kbd) : null,
    );
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  // 보이는 영역(소프트 키보드가 올라오면 그만큼 줄어든다) 안에 둔다. 데스크톱에서는 창 크기와 같다
  const vv = window.visualViewport;
  const ox = vv?.offsetLeft ?? 0;
  const oy = vv?.offsetTop ?? 0;
  const pos = clampBox(x - ox, y - oy, r.width, r.height, vv?.width ?? window.innerWidth, vv?.height ?? window.innerHeight);
  m.style.left = `${pos.left + ox}px`;
  m.style.top = `${pos.top + oy}px`;
  openMenu = m;
  setTimeout(() => {
    const off = (ev: Event) => {
      if (openMenu && !openMenu.contains(ev.target as Node)) {
        closeMenu();
        window.removeEventListener('pointerdown', off, true);
      }
    };
    window.addEventListener('pointerdown', off, true);
  });
}

export function dialog(title: string, body: Node | string, buttons: { label: string; primary?: boolean; run?: () => void | boolean }[] = [{ label: '닫기', primary: true }]): HTMLDivElement {
  const back = h('div', { class: 'dialog-back' });
  const close = () => back.remove();
  const box = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', {}, title, h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: close, html: icon('close2') })),
    h('div', { class: 'body' }, typeof body === 'string' ? h('div', { html: body }) : body),
    h(
      'footer',
      {},
      ...buttons.map((b) =>
        h(
          'button',
          {
            class: `btn ${b.primary ? 'primary' : ''}`,
            onclick: () => {
              const keep = b.run?.();
              if (keep !== true) close();
            },
          },
          b.label,
        ),
      ),
    ),
  );
  back.append(box);
  back.addEventListener('pointerdown', (ev) => {
    if (ev.target === back) close();
  });
  back.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape') close();
  });
  document.body.append(back);
  (box.querySelector('footer .btn.primary') as HTMLButtonElement | null)?.focus();
  return back;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 버튼을 고르게 하는 질문 상자(닫으면 null) */
export function ask<T extends string>(title: string, text: string, buttons: { label: string; value: T; primary?: boolean }[]): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const back = dialog(
      title,
      h('div', {}, text),
      buttons.map((b) => ({
        label: b.label,
        primary: b.primary,
        run: () => {
          done = true;
          resolve(b.value);
        },
      })),
    );
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

export type FormField =
  | { key: string; label: string; type: 'text' | 'number'; value: string | number; placeholder?: string; wide?: boolean }
  | { key: string; label: string; type: 'select'; value: string; options: { value: string; label: string }[] }
  | { key: string; label: string; type: 'check'; value: boolean }
  | { key: string; label: string; type: 'textarea'; value: string };

/** 입력 칸 여러 개를 받는 대화상자(취소하면 null). check는 boolean, number는 숫자로 돌려준다 */
export function form(title: string, fields: FormField[], opt: { ok?: string; note?: string; validate?: (v: Record<string, string | number | boolean>) => string | null } = {}): Promise<Record<string, string | number | boolean> | null> {
  return new Promise((resolve) => {
    let done = false;
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    const err = h('div', { class: 'form-error', role: 'alert' });
    const rows = fields.map((f) => {
      let el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (f.type === 'select') {
        el = h('select', { 'aria-label': f.label }, ...f.options.map((o) => h('option', { value: o.value }, o.label)));
        el.value = f.value;
      } else if (f.type === 'check') {
        el = h('input', { type: 'checkbox', 'aria-label': f.label });
        (el as HTMLInputElement).checked = f.value;
      } else if (f.type === 'textarea') {
        el = h('textarea', { 'aria-label': f.label, rows: 4 });
        el.value = f.value;
      } else {
        el = h('input', { type: f.type === 'number' ? 'text' : 'text', inputmode: f.type === 'number' ? 'decimal' : undefined, 'aria-label': f.label, placeholder: f.placeholder ?? '' });
        el.value = String(f.value);
      }
      inputs.set(f.key, el);
      el.addEventListener('keydown', (ev) => {
        const k = ev as KeyboardEvent;
        k.stopPropagation();
        if (k.key === 'Enter' && f.type !== 'textarea') submit();
      });
      return h('label', { class: `form-row ${f.type === 'check' ? 'check' : ''}` }, h('span', {}, f.label), el);
    });
    const read = () => {
      const out: Record<string, string | number | boolean> = {};
      for (const f of fields) {
        const el = inputs.get(f.key)!;
        if (f.type === 'check') out[f.key] = (el as HTMLInputElement).checked;
        else if (f.type === 'number') out[f.key] = Number(el.value.trim());
        else out[f.key] = el.value;
      }
      return out;
    };
    const submit = () => {
      const v = read();
      for (const f of fields) {
        if (f.type === 'number' && !Number.isFinite(v[f.key] as number)) {
          err.textContent = `${f.label}: 숫자를 입력하십시오.`;
          return;
        }
      }
      const e = opt.validate?.(v) ?? null;
      if (e) {
        err.textContent = e;
        return;
      }
      done = true;
      back.remove();
      resolve(v);
    };
    const body = h('div', { class: 'form' }, ...rows, opt.note ? h('div', { class: 'form-note' }, opt.note) : null, err);
    const back = dialog(title, body, [
      { label: '취소', run: () => undefined },
      { label: opt.ok ?? '확인', primary: true, run: () => (submit(), true) },
    ]);
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
    setTimeout(() => {
      const first = inputs.values().next().value as HTMLElement | undefined;
      first?.focus();
      if (first instanceof HTMLInputElement) first.select();
    });
  });
}
