/**
 * 도면층 도구·디자인센터·CAD 표준 화면의 공통 부품: 스타일, 넓은 대화상자, 여러 개 고르는 목록,
 * 도면층을 잠시 보이거나 감추는 화면 표시(도면 자료는 바꾸지 않는다).
 */
import { tableKey } from '../core/model';
import type { App } from './app';
import type { DocState } from './docstate';
import { dialog, h } from './ui/dom';

const STYLE = `
.ltx-dialog{width:min(var(--ltx-w,760px),100%)!important}
.ltx-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ltx-col{display:flex;flex-direction:column;gap:6px;min-width:0}
.ltx-grow{flex:1 1 0;min-width:0}
.ltx-h{font-weight:600;color:var(--text-dim);font-size:11.5px;margin:2px 0}
.ltx-list{border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);overflow:auto;min-height:120px;max-height:260px;user-select:none}
.ltx-list .it{display:flex;align-items:center;gap:6px;padding:2px 8px;cursor:default;white-space:nowrap}
.ltx-list .it:hover{background:var(--bg-hover)}
.ltx-list .it.sel{background:var(--bg-active);color:#fff}
.ltx-list .it.dim{color:var(--text-faint)}
.ltx-list .it .sw{display:inline-block;width:10px;height:10px;border:1px solid rgba(0,0,0,.4);border-radius:2px;flex:none}
.ltx-list .it .tag{margin-left:auto;color:var(--text-faint);font-size:11px}
.ltx-list .it.sel .tag{color:#dfe8f5}
.ltx-input{background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:4px;padding:4px 6px;font:inherit;min-width:0}
.ltx-btn{height:26px;padding:0 10px;border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-ribbon);color:var(--text);font:inherit;cursor:pointer;white-space:nowrap}
.ltx-btn:hover:not(:disabled){background:var(--bg-hover)}
.ltx-btn:disabled{opacity:.45;cursor:default}
.ltx-table{width:100%;border-collapse:collapse;font-size:12px}
.ltx-table th{text-align:left;font-weight:600;color:var(--text-dim);padding:3px 6px;border-bottom:1px solid var(--border-soft);position:sticky;top:0;background:var(--bg-input)}
.ltx-table td{padding:2px 6px;white-space:nowrap}
.ltx-table tr.sel td{background:var(--bg-active);color:#fff}
.ltx-table tr:hover td{background:var(--bg-hover)}
.ltx-note{color:var(--text-dim);font-size:11.5px;line-height:1.5}
.ltx-check{display:flex;align-items:center;gap:6px}
.ltx-box{border:1px solid var(--border-soft);border-radius:4px;padding:6px 8px;background:var(--bg-input);min-height:40px;overflow:auto}
.ltx-pass{pointer-events:none;background:transparent!important;justify-content:flex-start!important;align-items:flex-start!important;padding-top:80px!important}
.ltx-pass .dialog{pointer-events:auto}
`;

export function ensureLtStyle(): void {
  if (document.getElementById('ltx-style')) return;
  const s = document.createElement('style');
  s.id = 'ltx-style';
  s.textContent = STYLE;
  document.head.append(s);
}

/** 입력 칸의 키가 도면 단축키로 새지 않게 */
export function guardKeys(el: HTMLElement): void {
  el.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Escape') ev.stopPropagation();
  });
}

export interface WideDialog {
  back: HTMLDivElement;
  box: HTMLDivElement;
  /** 닫히면 끝나는 약속(고른 단추 값) */
  closed: Promise<string | null>;
  close(): void;
}

/**
 * 넓은 대화상자. buttons의 value가 결과로 돌아온다(닫기 단추·Esc·바깥 누르기는 null).
 * passThrough면 바깥이 어둡지 않고 도면을 확대·초점이동할 수 있다(도면층 탐색).
 */
export function wideDialog(title: string, body: Node, buttons: { label: string; value: string; primary?: boolean; keep?: () => boolean }[], width = 760, passThrough = false): WideDialog {
  ensureLtStyle();
  let result: string | null = null;
  const back = dialog(
    title,
    body,
    buttons.map((b) => ({
      label: b.label,
      primary: b.primary,
      run: () => {
        if (b.keep?.()) return true;
        result = b.value;
        return undefined;
      },
    })),
  );
  const box = back.querySelector('.dialog') as HTMLDivElement;
  box.classList.add('ltx-dialog');
  box.style.setProperty('--ltx-w', `${width}px`);
  if (passThrough) back.classList.add('ltx-pass');
  guardKeys(box);
  const closed = new Promise<string | null>((resolve) => {
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(document.body, { childList: true });
  });
  return { back, box, closed, close: () => back.remove() };
}

export interface ListItem {
  key: string;
  label: string;
  /** 오른쪽 작은 글 */
  tag?: string;
  /** 색 견본(CSS 색) */
  swatch?: string;
  dim?: boolean;
  title?: string;
}

/** 여러 개 고르는 목록(클릭·Ctrl·Shift). 더블클릭과 오른쪽 클릭을 알린다 */
export class PickList {
  readonly el: HTMLDivElement;
  private items: ListItem[] = [];
  readonly selected = new Set<string>();
  private anchor = -1;
  onChange: (() => void) | null = null;
  onActivate: ((key: string) => void) | null = null;
  onContext: ((ev: MouseEvent) => void) | null = null;

  constructor(
    label: string,
    private readonly multi = true,
  ) {
    ensureLtStyle();
    this.el = h('div', { class: 'ltx-list', role: 'listbox', 'aria-label': label, 'aria-multiselectable': multi ? 'true' : 'false', tabindex: 0 });
    this.el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.onContext?.(ev);
    });
    this.el.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a' && this.multi) {
        ev.preventDefault();
        this.setSelection(this.items.map((i) => i.key));
      }
    });
  }

  setItems(items: ListItem[]): void {
    this.items = items;
    const keys = new Set(items.map((i) => i.key));
    for (const k of [...this.selected]) if (!keys.has(k)) this.selected.delete(k);
    this.render();
  }

  get keys(): string[] {
    return this.items.map((i) => i.key);
  }

  selection(): string[] {
    return this.items.filter((i) => this.selected.has(i.key)).map((i) => i.key);
  }

  setSelection(keys: Iterable<string>, notify = true): void {
    this.selected.clear();
    for (const k of keys) if (this.items.some((i) => i.key === k)) this.selected.add(k);
    this.render();
    if (notify) this.onChange?.();
  }

  private click(i: number, ev: MouseEvent): void {
    const key = this.items[i]!.key;
    if (this.multi && ev.shiftKey && this.anchor >= 0) {
      const [a, b] = this.anchor < i ? [this.anchor, i] : [i, this.anchor];
      if (!(ev.ctrlKey || ev.metaKey)) this.selected.clear();
      for (let k = a; k <= b; k++) this.selected.add(this.items[k]!.key);
    } else if (this.multi && (ev.ctrlKey || ev.metaKey)) {
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      this.anchor = i;
    } else {
      this.selected.clear();
      this.selected.add(key);
      this.anchor = i;
    }
    this.render();
    this.onChange?.();
  }

  render(): void {
    this.el.replaceChildren(
      ...this.items.map((it, i) => {
        const row = h(
          'div',
          { class: `it${this.selected.has(it.key) ? ' sel' : ''}${it.dim ? ' dim' : ''}`, role: 'option', 'aria-selected': this.selected.has(it.key) ? 'true' : 'false', title: it.title ?? it.label },
          it.swatch ? h('span', { class: 'sw', style: `background:${it.swatch}` }) : null,
          h('span', {}, it.label),
          it.tag ? h('span', { class: 'tag' }, it.tag) : null,
        );
        row.addEventListener('mousedown', (ev) => {
          if (ev.button === 2 && this.selected.has(it.key)) return;
          if (ev.button === 0 || ev.button === 2) this.click(i, ev);
        });
        row.addEventListener('dblclick', () => this.onActivate?.(it.key));
        return row;
      }),
    );
  }
}

/**
 * 도면층을 잠시 보이거나 감추는 화면 표시(LAYWALK·LAYTRANS "선택 시 도면층 내용 표시").
 * 도면의 도면층 표는 바꾸지 않고 화면 상태(DocState.layers)만 바꾼다. restore()로 원래대로.
 */
export class TempLayerView {
  private readonly saved = new Map<string, { on: boolean; frozen: boolean }>();
  private visible: Set<string> | null = null;

  constructor(
    private readonly app: App,
    private readonly st: DocState,
  ) {}

  /** 보일 도면층(대문자 이름). null이면 원래대로 */
  show(keys: ReadonlySet<string> | null): void {
    this.visible = keys ? new Set(keys) : null;
    this.apply();
  }

  /** 도면 편집(소거 등)으로 화면 상태가 다시 맞춰진 뒤 다시 적용 */
  apply(): void {
    const st = this.st;
    if (!this.visible) {
      this.restore();
      return;
    }
    for (const [k, l] of st.layers) {
      if (!this.saved.has(k)) this.saved.set(k, { on: l.on, frozen: l.frozen });
      const show = this.visible.has(tableKey(k));
      l.on = show;
      l.frozen = show ? false : this.saved.get(k)!.frozen;
    }
    this.refresh();
  }

  restore(): void {
    for (const [k, s] of this.saved) {
      const l = this.st.layers.get(k);
      if (!l) continue;
      l.on = s.on;
      l.frozen = s.frozen;
    }
    this.saved.clear();
    this.visible = null;
    this.refresh();
  }

  /** 원래(저장한) 상태를 잊는다: 지금 화면 상태가 도면과 같아졌을 때(편집으로 다시 맞춘 뒤) */
  forget(): void {
    this.saved.clear();
  }

  private refresh(): void {
    this.st.touchLayers();
    this.app.view.requestRender();
  }
}
