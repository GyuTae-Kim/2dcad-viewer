/**
 * 블록 팔레트(BLOCKSPALETTE, BLOCKSPALETTECLOSE): 현재 도면·최근 사용·라이브러리(고른 DWG·DXF 파일) 탭의 블록을
 * 미리보기로 보이고, 누르면 삽입점을 지정해 넣고(축척(S)·회전(R)), 그림 영역으로 끌어 놓으면 그 자리에 넣는다.
 * 미리보기는 디자인센터와 같은 blockGeometry, 삽입은 디자인센터의 ADCADD 흐름(정의 복사·단위 축척·속성 값)을 쓴다.
 * 최근 사용 목록은 이 세션 동안만 기억한다. 라이브러리 파일은 이 브라우저 안에서만 읽는다(디자인센터 "사용 내역"과 같은 목록).
 */
import type { CadDocument } from '../core/model';
import { tableKey } from '../core/model';
import type { App } from './app';
import { blockGeometry, drawGeometry } from './blockpreview';
import { insertBlockFrom } from './designcenter';
import { type LoadedDrawing, loadedDrawings, onLoadedDrawingsChange, pickAndReadDrawings } from './drawingfiles';
import { guardKeys } from './layertools-ui';
import { h } from './ui/dom';
import { icon } from './ui/icons';
import { registerOnce } from './blkcmds-io';

const STYLE = `
.bp-panel{position:fixed;right:12px;top:120px;width:min(340px,calc(100vw - 24px));height:min(520px,calc(100vh - 140px));z-index:60;display:flex;flex-direction:column;
 border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-panel);box-shadow:0 10px 32px rgba(0,0,0,.45);color:var(--text);font-size:12px;min-width:260px;min-height:240px;resize:both;overflow:hidden}
.bp-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);cursor:move;user-select:none}
.bp-head .t{font-weight:600;flex:1}
.bp-tabs{display:flex;gap:2px;padding:4px 8px 0;border-bottom:1px solid var(--border)}
.bp-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--text-dim);padding:4px 8px;font:inherit;cursor:pointer}
.bp-tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
.bp-bar{display:flex;gap:6px;align-items:center;padding:6px 8px}
.bp-bar input,.bp-bar select{flex:1;min-width:0}
.bp-grid{flex:1;overflow:auto;padding:6px;display:flex;flex-wrap:wrap;align-content:flex-start;gap:4px;user-select:none}
.bp-item{display:flex;flex-direction:column;align-items:center;width:86px;padding:4px;border-radius:4px;cursor:pointer;border:1px solid transparent}
.bp-item canvas{width:74px;height:58px;background:var(--bg-input);border-radius:3px;pointer-events:none}
.bp-item span{max-width:82px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.bp-item:hover{background:var(--bg-hover)}
.bp-item:focus-visible{outline:2px solid var(--accent)}
.bp-empty{color:var(--text-faint);padding:12px;line-height:1.6}
.bp-foot{display:flex;align-items:center;gap:8px;padding:6px 8px;border-top:1px solid var(--border);color:var(--text-dim)}
.bp-foot label{display:flex;align-items:center;gap:4px;white-space:nowrap}
.bp-foot .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

function ensureStyle(): void {
  if (document.getElementById('bp-style')) return;
  const s = document.createElement('style');
  s.id = 'bp-style';
  s.textContent = STYLE;
  document.head.append(s);
}

type Tab = 'current' | 'recent' | 'library';

interface Item {
  doc: CadDocument;
  /** 원본 이름(현재 도면이면 그 도면 이름) */
  label: string;
  name: string;
}

/** 최근 사용(이 세션, 최근 것이 앞) */
const recent: Item[] = [];

function remember(it: Item): void {
  const i = recent.findIndex((r) => r.doc === it.doc && tableKey(r.name) === tableKey(it.name));
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(it);
  if (recent.length > 30) recent.length = 30;
}

function blockNames(doc: CadDocument): string[] {
  return [...doc.blocks.values()]
    .filter((b) => !b.name.startsWith('*') && !(b.flags & (4 | 16)) && !b.name.includes('|'))
    .map((b) => b.name)
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

function textColor(): string {
  return getComputedStyle(document.body).getPropertyValue('--text').trim() || '#e8ebf0';
}

let panel: BlocksPalette | null = null;

class BlocksPalette {
  readonly el: HTMLDivElement;
  private tab: Tab;
  private readonly tabBtns: Record<Tab, HTMLButtonElement>;
  private readonly grid: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly filter: HTMLInputElement;
  private readonly libSelect: HTMLSelectElement;
  private readonly status: HTMLSpanElement;
  private readonly repeat: HTMLInputElement;
  private library: LoadedDrawing | null = null;
  private drag: Item | null = null;
  private job = 0;
  private sig = '';
  private timer = 0;
  private readonly unlisten: () => void;
  private readonly onDragOver = (ev: DragEvent) => {
    if (!this.drag) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  };
  private readonly onDrop = (ev: DragEvent) => {
    const it = this.drag;
    this.drag = null;
    if (!it) return;
    ev.preventDefault();
    const r = this.app.view.el.getBoundingClientRect();
    const p = this.app.view.screenToWorld(ev.clientX - r.left, ev.clientY - r.top);
    void this.insert(it, p);
  };

  constructor(private readonly app: App) {
    ensureStyle();
    this.tab = app.active ? 'current' : 'library';
    const mk = (t: Tab, label: string) => h('button', { type: 'button', role: 'tab', onclick: () => this.setTab(t) }, label) as HTMLButtonElement;
    this.tabBtns = { current: mk('current', '현재 도면'), recent: mk('recent', '최근 사용'), library: mk('library', '라이브러리') };
    this.filter = h('input', { type: 'search', placeholder: '이름 필터(* ? 사용 가능)', 'aria-label': '블록 이름 필터' }) as HTMLInputElement;
    this.filter.addEventListener('input', () => this.render());
    this.libSelect = h('select', { 'aria-label': '라이브러리 파일' }) as HTMLSelectElement;
    this.libSelect.addEventListener('change', () => {
      this.library = loadedDrawings().find((d) => String(d.serial) === this.libSelect.value) ?? null;
      this.render();
    });
    this.bar = h('div', { class: 'bp-bar' });
    this.grid = h('div', { class: 'bp-grid', role: 'listbox', 'aria-label': '블록' });
    this.status = h('span', { class: 'st' });
    this.repeat = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const head = h('div', { class: 'bp-head' }, h('span', { class: 't' }, '블록'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': '닫기', onclick: () => this.close(), html: icon('close2') }));
    this.el = h(
      'div',
      { class: 'bp-panel', role: 'dialog', 'aria-label': '블록 팔레트' },
      head,
      h('div', { class: 'bp-tabs', role: 'tablist' }, this.tabBtns.current, this.tabBtns.recent, this.tabBtns.library),
      this.bar,
      this.grid,
      h('div', { class: 'bp-foot' }, this.status, h('label', { title: '취소할 때까지 같은 블록을 계속 넣습니다' }, this.repeat, '반복 배치')),
    );
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'wheel', 'contextmenu']) this.el.addEventListener(t, (ev) => ev.stopPropagation());
    guardKeys(this.el);
    this.el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.close();
    });
    this.dragHead(head);
    this.unlisten = onLoadedDrawingsChange(() => {
      if (!this.library || !loadedDrawings().includes(this.library)) this.library = loadedDrawings()[0] ?? null;
      this.render();
    });
    this.library = loadedDrawings()[0] ?? null;
    app.view.el.addEventListener('dragover', this.onDragOver);
    app.view.el.addEventListener('drop', this.onDrop);
    document.body.append(this.el);
    this.setTab(this.tab);
    // 현재 도면이 바뀌거나 블록이 늘고 줄면 다시 그린다
    this.timer = window.setInterval(() => {
      if (this.tab === 'current' && this.signature() !== this.sig) this.render();
    }, 800);
  }

  private dragHead(head: HTMLElement): void {
    head.addEventListener('pointerdown', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      const r = this.el.getBoundingClientRect();
      const dx = ev.clientX - r.left;
      const dy = ev.clientY - r.top;
      head.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        this.el.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dx))}px`;
        this.el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy))}px`;
        this.el.style.right = 'auto';
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', () => head.removeEventListener('pointermove', move), { once: true });
    });
  }

  private signature(): string {
    const st = this.app.active;
    if (!st) return 'none';
    return `${st.docId}:${blockNames(st.doc).join('|')}`;
  }

  setTab(t: Tab): void {
    this.tab = t;
    for (const [k, b] of Object.entries(this.tabBtns) as [Tab, HTMLButtonElement][]) {
      b.classList.toggle('on', k === t);
      b.setAttribute('aria-selected', String(k === t));
    }
    this.bar.innerHTML = '';
    if (t === 'library') {
      const pick = h('button', { class: 'btn', type: 'button', onclick: () => void this.pickLibrary() }, '파일 고르기…');
      this.bar.append(this.libSelect, pick);
      this.fillLibraries();
    }
    this.bar.append(this.filter);
    this.render();
  }

  private fillLibraries(): void {
    const list = loadedDrawings();
    this.libSelect.innerHTML = '';
    for (const d of list) this.libSelect.append(h('option', { value: String(d.serial) }, d.name));
    if (!list.length) this.libSelect.append(h('option', { value: '' }, '(고른 파일 없음)'));
    this.libSelect.value = this.library ? String(this.library.serial) : '';
  }

  private async pickLibrary(): Promise<void> {
    const got = await pickAndReadDrawings(this.app, (t, cls) => this.app.cmd.print(t, cls), true);
    if (got.length) {
      this.library = got[got.length - 1]!;
      this.fillLibraries();
      this.render();
    }
  }

  private items(): Item[] {
    const st = this.app.active;
    if (this.tab === 'current') return st ? blockNames(st.doc).map((name) => ({ doc: st.doc, label: st.name, name })) : [];
    if (this.tab === 'recent') return recent.filter((r) => r.doc.blocks.has(tableKey(r.name)));
    const lib = this.library;
    if (lib) this.fillLibraries();
    return lib ? blockNames(lib.doc).map((name) => ({ doc: lib.doc, label: lib.name, name })) : [];
  }

  render(): void {
    this.sig = this.signature();
    const job = ++this.job;
    const f = this.filter.value.trim();
    const re = f ? new RegExp(`^${f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}`, 'i') : null;
    const list = this.items().filter((it) => !re || re.test(it.name) || it.name.toLowerCase().includes(f.toLowerCase()));
    this.grid.innerHTML = '';
    if (!list.length) {
      const msg =
        this.tab === 'current'
          ? this.app.active
            ? '이 도면에는 블록이 없습니다.'
            : '열린 도면이 없습니다.'
          : this.tab === 'recent'
            ? '아직 이 팔레트로 넣은 블록이 없습니다.'
            : '"파일 고르기…"로 블록이 든 DWG·DXF 파일을 고르십시오. 파일은 이 브라우저 안에서만 읽습니다.';
      this.grid.append(h('div', { class: 'bp-empty' }, f ? '필터에 맞는 블록이 없습니다.' : msg));
      this.status.textContent = '';
      return;
    }
    const color = textColor();
    const cells: { c: HTMLCanvasElement; it: Item }[] = [];
    for (const it of list) {
      const c = h('canvas', { width: 74, height: 58 }) as HTMLCanvasElement;
      const el = h('div', { class: 'bp-item', role: 'option', tabindex: 0, draggable: 'true', title: `${it.name}${this.tab === 'current' ? '' : ` — ${it.label}`}\n누르면 삽입, 그림 영역으로 끌어 놓으면 그 자리에 삽입` }, c, h('span', {}, it.name));
      el.addEventListener('click', () => void this.insert(it, null));
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') void this.insert(it, null);
      });
      el.addEventListener('dragstart', (ev) => {
        this.drag = it;
        ev.dataTransfer?.setData('text/plain', it.name);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
      });
      el.addEventListener('dragend', () => {
        // 그림 영역 밖에 놓았으면 잊는다
        setTimeout(() => (this.drag = null), 0);
      });
      this.grid.append(el);
      cells.push({ c, it });
    }
    this.status.textContent = `블록 ${list.length}개 — 누르면 삽입, 끌어 놓으면 그 자리에`;
    // 미리보기는 조금씩 그린다(큰 라이브러리)
    let i = 0;
    const step = () => {
      if (job !== this.job) return;
      const end = Math.min(cells.length, i + 12);
      for (; i < end; i++) {
        const { c, it } = cells[i]!;
        drawGeometry(c, blockGeometry(this.app, it.doc, it.name), color);
      }
      if (i < cells.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** 블록 하나를 넣는다(at이 있으면 그 점에) */
  private async insert(it: Item, at: { x: number; y: number } | null): Promise<void> {
    const app = this.app;
    if (!app.active) {
      app.cmd.print('블록을 넣을 도면을 먼저 여십시오.', 'err');
      return;
    }
    if (!it.doc.blocks.has(tableKey(it.name))) {
      app.cmd.print(`블록 "${it.name}"을(를) 찾을 수 없습니다.`, 'err');
      return;
    }
    remember(it);
    for (let n = 0; n < 1000; n++) {
      const before = app.lastCreated;
      const done = insertBlockFrom(app, it.doc, it.label, it.name);
      if (at && n === 0) {
        const p = at;
        // 삽입점 프롬프트가 뜨면 놓은 자리(WCS)를 넣는다
        const feed = (tries: number) => {
          if (app.pendingInput?.kind === 'point') app.submitInput(`*${+p.x.toPrecision(15)},${+p.y.toPrecision(15)}`);
          else if (tries > 0) setTimeout(() => feed(tries - 1), 25);
        };
        setTimeout(() => feed(40), 0);
      }
      await done;
      if (!this.repeat.checked || app.lastCreated === before || !this.el.isConnected) break;
    }
    if (this.tab === 'recent') this.render();
  }

  close(): void {
    clearInterval(this.timer);
    this.job++;
    this.unlisten();
    this.app.view.el.removeEventListener('dragover', this.onDragOver);
    this.app.view.el.removeEventListener('drop', this.onDrop);
    this.el.remove();
    if (panel === this) panel = null;
  }

  focus(): void {
    (this.grid.querySelector('.bp-item') as HTMLElement | null)?.focus();
  }
}

export function registerBlkPaletteCommands(app: App): void {
  registerOnce(app, {
    name: 'BLOCKSPALETTE',
    title: '블록 팔레트',
    noDoc: true,
    run() {
      if (panel) {
        panel.focus();
        return;
      }
      panel = new BlocksPalette(app);
      panel.focus();
    },
  });
  registerOnce(app, {
    name: 'BLOCKSPALETTECLOSE',
    title: '블록 팔레트 닫기',
    noDoc: true,
    run() {
      panel?.close();
    },
  });
}

/** 블록 팔레트가 열려 있는지 */
export function blocksPaletteOpen(): boolean {
  return panel !== null;
}
