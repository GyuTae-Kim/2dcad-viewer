/** DOM 도우미: 요소 만들기, 알림, 메뉴, 대화상자 */
import { icon } from './icons';

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
      },
      it.icon ? iconSpan(it.icon) : h('span', { class: 'ic' }),
      it.label ?? '',
      it.kbd ? h('kbd', {}, it.kbd) : null,
    );
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
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
