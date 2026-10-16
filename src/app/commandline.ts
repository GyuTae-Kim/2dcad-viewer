/**
 * 명령행: 기록, 프롬프트(키워드 클릭), 입력, 명령 자동 완성.
 * AutoCAD처럼 Enter·Space로 입력을 마치고, 빈 입력의 Enter는 직전 명령을 다시 실행한다.
 * 닫히지 않은 AutoLISP 식("(" 로 시작)을 치는 동안은 Space가 글자다.
 * 앱이 키를 먼저 볼 수 있다(intercept: 동적 입력의 Tab, 올가미 중 스페이스바). 기록·프롬프트의 오른쪽 클릭은 onContext로 넘긴다
 * (입력란은 브라우저의 복사·붙여넣기 메뉴 그대로).
 */
import { lispUnclosed } from '../edit/lisp/reader';
export interface Suggestion {
  name: string;
  title: string;
}

export interface CommandLineHost {
  submit(text: string): void;
  cancel(): void;
  suggest(prefix: string): Suggestion[];
  keyword(k: string): void;
  /** 명령이 아닌 상태에서 입력란이 비었을 때 Enter·Space */
  repeat(): void;
}

export class CommandLine {
  readonly el: HTMLDivElement;
  private readonly hist: HTMLDivElement;
  private readonly promptEl: HTMLSpanElement;
  readonly input: HTMLInputElement;
  private readonly sugg: HTMLDivElement;
  private items: Suggestion[] = [];
  private selIdx = 0;
  private history: string[] = [];
  private histIdx = -1;
  /** 공백을 입력으로 받는지(문자열 입력 중) */
  acceptSpaces = false;
  /** 닫히지 않은 AutoLISP 식을 이어 받는 중(공백은 글자) */
  lispContinue = false;

  constructor(
    parent: HTMLElement,
    private readonly host: CommandLineHost,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'cmdline';
    this.hist = document.createElement('div');
    this.hist.className = 'cmd-history';
    const row = document.createElement('div');
    row.className = 'cmd-row';
    this.promptEl = document.createElement('span');
    this.promptEl.className = 'cmd-prompt';
    this.input = document.createElement('input');
    this.input.className = 'cmd-input';
    this.input.placeholder = '명령 입력';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', '명령 입력');
    this.sugg = document.createElement('div');
    this.sugg.className = 'cmd-suggest';
    this.sugg.hidden = true;
    row.append(this.promptEl, this.input);
    this.el.append(this.hist, row, this.sugg);
    parent.append(this.el);
    this.input.addEventListener('keydown', (ev) => this.onKey(ev));
    this.input.addEventListener('input', () => this.updateSuggest());
    this.hist.addEventListener('dblclick', () => this.hist.classList.toggle('expanded'));
    this.el.addEventListener('contextmenu', (ev) => {
      if (ev.target === this.input || !this.onContext) return;
      ev.preventDefault();
      this.onContext(ev);
    });
    this.setPrompt('');
  }

  /** 키를 앱이 먼저 본다(처리했으면 true, 기본 동작은 앱이 막는다) */
  intercept: ((ev: KeyboardEvent) => boolean) | null = null;
  /** 기록·프롬프트를 오른쪽 클릭했을 때(명령행 바로 가기 메뉴) */
  onContext: ((ev: MouseEvent) => void) | null = null;

  /** 자동 완성 목록이 떠 있는지 */
  get suggesting(): boolean {
    return !this.sugg.hidden;
  }

  /** 입력란 글을 비운다(동적 입력 칸을 잠근 뒤 등) */
  clearInput(): void {
    this.input.value = '';
    this.onChange?.('');
    this.sugg.hidden = true;
  }

  /** 입력란 끝에 글을 넣는다(붙여넣기) */
  insertText(t: string): void {
    this.input.focus({ preventScroll: true });
    this.input.value += t;
    this.updateSuggest();
  }

  /** 기록 전체(기록 복사) */
  historyText(): string {
    return [...this.hist.children].map((c) => c.textContent ?? '').join('\n');
  }

  /** 기록에서 고른 글(없으면 빈 글) */
  selectedText(): string {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    return sel && !sel.isCollapsed && this.hist.contains(sel.anchorNode) ? sel.toString() : '';
  }

  /** 입력란의 글을 Enter로 넣은 것처럼(Ctrl+J·Ctrl+M) */
  submitCurrent(): void {
    this.finish(false);
  }

  /** Esc와 같다: 입력을 비우고 취소(Ctrl+\\) */
  escape(): void {
    this.clearInput();
    this.host.cancel();
  }

  toggleHistory(): void {
    this.hist.classList.toggle('expanded');
    this.hist.scrollTop = this.hist.scrollHeight;
  }

  /** 출력을 지켜보는 고리(스크립트 실행기가 오류 출력을 알아챈다) */
  onPrint: ((text: string, cls?: 'err' | 'res') => void) | null = null;

  print(text: string, cls?: 'err' | 'res'): void {
    this.onPrint?.(text, cls);
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    this.hist.append(div);
    while (this.hist.childElementCount > 400) this.hist.firstElementChild?.remove();
    this.hist.scrollTop = this.hist.scrollHeight;
  }

  /** "점 지정 또는 [윈도우(W)/이전(P)] <범위>:" 형식. 대괄호 안 키워드는 눌러서 고를 수 있다 */
  setPrompt(text: string): void {
    this.promptEl.textContent = '';
    if (!text) {
      this.promptEl.hidden = true;
      this.input.placeholder = '명령 입력';
      return;
    }
    this.promptEl.hidden = false;
    this.input.placeholder = '';
    const m = /^(.*?)\[(.*?)\](.*)$/.exec(text);
    if (!m) {
      this.promptEl.textContent = text;
      return;
    }
    this.promptEl.append(document.createTextNode(m[1] + '['));
    const parts = m[2]!.split('/');
    parts.forEach((p, i) => {
      const span = document.createElement('span');
      span.className = 'kw';
      span.textContent = p;
      const key = /\(([^)]+)\)/.exec(p)?.[1] ?? p;
      span.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.host.keyword(key);
      });
      this.promptEl.append(span);
      if (i < parts.length - 1) this.promptEl.append(document.createTextNode('/'));
    });
    this.promptEl.append(document.createTextNode(']' + m[3]));
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** 도면 영역에서 누른 글자를 입력란으로 보낸다 */
  typeChar(ch: string): void {
    this.input.focus({ preventScroll: true });
    this.input.value += ch;
    this.updateSuggest();
  }

  /** 입력란 글자가 바뀔 때(동적 입력 표시) */
  onChange: ((text: string) => void) | null = null;

  private updateSuggest(): void {
    this.onChange?.(this.input.value);
    const v = this.input.value.trim();
    // AutoLISP 식("(…)"·"!변수")에는 명령 이름을 권하지 않는다
    if (!v || this.promptEl.hidden === false || v.startsWith('(') || v.startsWith('!')) {
      this.sugg.hidden = true;
      this.items = [];
      return;
    }
    this.items = this.host.suggest(v).slice(0, 8);
    this.selIdx = 0;
    this.sugg.innerHTML = '';
    this.items.forEach((it, i) => {
      const d = document.createElement('div');
      if (i === 0) d.className = 'sel';
      d.innerHTML = `<span></span><small></small>`;
      d.firstElementChild!.textContent = it.name;
      d.lastElementChild!.textContent = it.title;
      d.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.input.value = '';
        this.onChange?.('');
        this.sugg.hidden = true;
        this.submit(it.name);
      });
      this.sugg.append(d);
    });
    this.sugg.hidden = this.items.length === 0;
  }

  private submit(text: string): void {
    if (text) {
      this.history.push(text);
      if (this.history.length > 100) this.history.shift();
    }
    this.histIdx = -1;
    this.host.submit(text);
  }

  private onKey(ev: KeyboardEvent): void {
    if (this.intercept?.(ev)) {
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.escape();
      return;
    }
    if (!this.sugg.hidden && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      ev.preventDefault();
      this.selIdx = (this.selIdx + (ev.key === 'ArrowDown' ? 1 : this.items.length - 1)) % this.items.length;
      [...this.sugg.children].forEach((c, i) => c.classList.toggle('sel', i === this.selIdx));
      return;
    }
    if (this.sugg.hidden && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && this.history.length) {
      ev.preventDefault();
      if (this.histIdx < 0) this.histIdx = this.history.length;
      this.histIdx = Math.max(0, Math.min(this.history.length - 1, this.histIdx + (ev.key === 'ArrowUp' ? -1 : 1)));
      this.input.value = this.history[this.histIdx] ?? '';
      return;
    }
    const space = ev.key === ' ' && !this.acceptSpaces && !this.lispContinue && !lispUnclosed(this.input.value);
    if (ev.key === 'Enter' || space || ev.key === 'Tab') {
      if (ev.key === 'Tab' && this.sugg.hidden) return;
      ev.preventDefault();
      this.finish(ev.key === 'Tab');
    }
  }

  /** 입력을 마친다(Tab이면 자동 완성 목록의 고른 항목) */
  private finish(tab: boolean): void {
    let v = this.input.value.trim();
    if (!this.sugg.hidden && this.items.length) {
      const exact = this.items.find((x) => x.name.toUpperCase() === v.toUpperCase());
      if (tab || !exact) v = this.items[this.selIdx]!.name;
    }
    this.input.value = '';
    this.onChange?.('');
    this.sugg.hidden = true;
    if (!v && this.promptEl.hidden) {
      this.host.repeat();
      return;
    }
    this.submit(v);
  }
}

/** 점 입력 해석: "x,y", "@dx,dy", "@d<a", "d<a", 숫자(직접 거리) */
export function parsePointInput(s: string, last: { x: number; y: number } | null, cursorDir: { x: number; y: number } | null): { x: number; y: number } | null {
  const t = s.trim().replace(/\s+/g, '');
  if (!t) return null;
  const rel = t.startsWith('@');
  const body = rel ? t.slice(1) : t.startsWith('#') ? t.slice(1) : t;
  const base = rel ? (last ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
  const polar = /^(-?[\d.]+(?:e-?\d+)?)<(-?[\d.]+(?:e-?\d+)?)$/i.exec(body);
  if (polar) {
    const d = parseFloat(polar[1]!);
    const a = (parseFloat(polar[2]!) * Math.PI) / 180;
    if (!Number.isFinite(d) || !Number.isFinite(a)) return null;
    return { x: base.x + d * Math.cos(a), y: base.y + d * Math.sin(a) };
  }
  const xy = /^(-?[\d.]+(?:e-?\d+)?),(-?[\d.]+(?:e-?\d+)?)(?:,(-?[\d.]+(?:e-?\d+)?))?$/i.exec(body);
  if (xy) {
    const x = parseFloat(xy[1]!);
    const y = parseFloat(xy[2]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: base.x + x, y: base.y + y };
  }
  const dist = /^-?[\d.]+(?:e-?\d+)?$/i.exec(body);
  if (dist && last && cursorDir && !rel) {
    const d = parseFloat(t);
    const l = Math.hypot(cursorDir.x, cursorDir.y);
    if (!Number.isFinite(d) || l < 1e-12) return null;
    return { x: last.x + (cursorDir.x / l) * d, y: last.y + (cursorDir.y / l) * d };
  }
  return null;
}
