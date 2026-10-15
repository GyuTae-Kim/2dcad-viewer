/**
 * 디자인센터(ADCENTER·ADC·DC, ADCCLOSE): 열린 도면과 사용자가 고른 DWG·DXF·DWS·DWT 파일(여러 개)의
 * 블록·치수 스타일·도면층·배치·선종류·다중 지시선 스타일·테이블 스타일·문자 스타일을 트리로 보이고, 고른 항목을 지금 도면에 넣는다.
 *
 * - 블록: 삽입점을 지정해 삽입(축척(S)·회전(R), 블록 단위가 다르면 단위 축척). 정의만 추가할 수도 있다.
 * - 나머지: 정의를 복사한다(쓰는 선종류·문자 스타일·중첩 블록이 함께 온다). 이름이 이미 있으면 이 도면의 정의를 두고 알린다.
 * - 한 번의 추가·삽입이 명령 취소 한 단계다. 파일은 이 브라우저 안에서만 읽고 이 세션 동안 "사용 내역"에 남는다.
 * - 폴더 탭은 없다(브라우저가 디스크 폴더를 탐색할 수 없다). 외부 참조 부착은 하지 않는다.
 */
import type { AttribEntity, CadDocument, InsertEntity, Layer } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import { DEF_KIND_LABEL, type DefKind, DefinitionCopier, listDefinitions, mleaderStyles } from '../edit/layertools/clone';
import { colorLabel, lineweightLabel } from '../edit/layertools/standards';
import { listTableStyles } from '../edit/table/style';
import { INSUNITS_MM } from '../edit/util/calc';
import type { App, CommandContext } from './app';
import { makeAttribs } from './blocks';
import { blockGeometry, drawGeometry } from './blockpreview';
import { addEntities, currentProps } from './draw';
import { type LoadedDrawing, loadedDrawings, onLoadedDrawingsChange, pickAndReadDrawings } from './drawingfiles';
import { ensureLtStyle, guardKeys } from './layertools-ui';
import { layerSwatch } from './laywalk';
import { Ghost } from './modify';
import type { Affine } from './modify';
import { form, h, showMenu } from './ui/dom';
import { icon } from './ui/icons';

const STYLE = `
.dc-panel{position:fixed;right:12px;top:120px;width:min(700px,calc(100vw - 24px));height:min(480px,calc(100vh - 140px));z-index:60;display:flex;flex-direction:column;
 border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-panel);box-shadow:0 10px 32px rgba(0,0,0,.45);color:var(--text);font-size:12px;min-width:360px;min-height:260px;resize:both;overflow:hidden}
.dc-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);cursor:move;user-select:none}
.dc-head .t{font-weight:600}
.dc-head .sp{flex:1}
.dc-tabs{display:flex;gap:2px;padding:4px 8px 0;border-bottom:1px solid var(--border)}
.dc-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--text-dim);padding:4px 10px;font:inherit;cursor:pointer}
.dc-tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
.dc-main{flex:1;display:flex;min-height:0}
.dc-tree{width:210px;flex:none;overflow:auto;border-right:1px solid var(--border);padding:4px 0;user-select:none}
.dc-tree .n{display:flex;align-items:center;gap:4px;padding:2px 6px;white-space:nowrap;cursor:default}
.dc-tree .n:hover{background:var(--bg-hover)}
.dc-tree .n.on{background:var(--bg-active);color:#fff}
.dc-tree .n .c{color:var(--text-faint);margin-left:auto;font-size:11px}
.dc-tree .n.on .c{color:#dfe8f5}
.dc-tree .k{padding-left:22px}
.dc-tree .tw{width:12px;text-align:center;color:var(--text-dim)}
.dc-right{flex:1;display:flex;flex-direction:column;min-width:0}
.dc-content{flex:1;overflow:auto;padding:6px;display:flex;flex-wrap:wrap;align-content:flex-start;gap:4px;user-select:none}
.dc-content.rows{flex-direction:column;flex-wrap:nowrap;gap:0}
.dc-item{display:flex;flex-direction:column;align-items:center;width:84px;padding:4px;border-radius:4px;cursor:default;border:1px solid transparent}
.dc-item canvas{width:72px;height:56px;background:var(--bg-input);border-radius:3px}
.dc-item span{max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.dc-row{display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:3px;cursor:default;white-space:nowrap}
.dc-row .sw{display:inline-block;width:10px;height:10px;border:1px solid rgba(0,0,0,.4);border-radius:2px}
.dc-row .d{color:var(--text-faint);margin-left:auto;padding-left:12px;overflow:hidden;text-overflow:ellipsis}
.dc-item:hover,.dc-row:hover{background:var(--bg-hover)}
.dc-item.sel,.dc-row.sel{background:var(--bg-active);color:#fff}
.dc-row.sel .d{color:#dfe8f5}
.dc-bottom{display:flex;gap:8px;padding:6px;border-top:1px solid var(--border);align-items:stretch;height:118px;flex:none}
.dc-bottom canvas{width:140px;height:104px;background:var(--bg-input);border-radius:4px;flex:none}
.dc-desc{flex:1;overflow:auto;color:var(--text-dim);line-height:1.5}
.dc-foot{display:flex;align-items:center;gap:6px;padding:6px 8px;border-top:1px solid var(--border)}
.dc-foot .st{flex:1;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-empty{color:var(--text-faint);padding:12px}
`;

function ensureStyle(): void {
  ensureLtStyle();
  if (document.getElementById('dc-style')) return;
  const s = document.createElement('style');
  s.id = 'dc-style';
  s.textContent = STYLE;
  document.head.append(s);
}

/** 트리 순서(AutoCAD 디자인센터와 같은 가나다·알파벳 순서의 종류) */
const KIND_ORDER: DefKind[] = ['block', 'dimStyle', 'layer', 'layout', 'linetype', 'mleaderStyle', 'tableStyle', 'textStyle'];

interface Source {
  key: string;
  label: string;
  doc: CadDocument;
  open: boolean;
}

/** 디자인센터가 ADCADD에 넘기는 일 */
interface Pending {
  doc: CadDocument;
  label: string;
  kind: DefKind;
  names: string[];
  insert: boolean;
}
let pending: Pending | null = null;
let panel: DesignCenter | null = null;

function textColor(): string {
  return getComputedStyle(document.body).getPropertyValue('--text').trim() || '#e8ebf0';
}

class DesignCenter {
  readonly el: HTMLDivElement;
  private tab: 'open' | 'history' = 'open';
  private readonly treeEl: HTMLDivElement;
  private readonly contentEl: HTMLDivElement;
  private readonly previewCanvas: HTMLCanvasElement;
  private readonly descEl: HTMLDivElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly insertBtn: HTMLButtonElement;
  private readonly tabBtns: Record<'open' | 'history', HTMLButtonElement>;
  private cur: { source: string; kind: DefKind } | null = null;
  private readonly expanded = new Set<string>();
  /** 원본 열쇠 → 이름(같은 파일을 다시 읽었을 때 따라가기) */
  private readonly labels = new Map<string, string>();
  private items: string[] = [];
  private readonly sel = new Set<string>();
  private anchor = -1;
  private sig = '';
  private timer = 0;
  private thumbJob = 0;
  private readonly unlisten: () => void;

  constructor(private readonly app: App) {
    ensureStyle();
    const btn = (label: string, title: string, run: () => void) => {
      const b = h('button', { class: 'ltx-btn', type: 'button', title }, label) as HTMLButtonElement;
      b.addEventListener('click', run);
      return b;
    };
    const close = h('button', { class: 'icon-btn', title: '닫기 (ADCCLOSE)', 'aria-label': '디자인센터 닫기', html: icon('close2') });
    close.addEventListener('click', () => this.close());
    const head = h('div', { class: 'dc-head' }, h('span', { class: 't' }, '디자인센터'), h('span', { class: 'sp' }), btn('로드(L)...', 'DWG·DXF·DWS·DWT 파일을 골라 사용 내역에 넣습니다', () => void this.load()), close);
    this.tabBtns = {
      open: h('button', { type: 'button', role: 'tab' }, '열린 도면') as HTMLButtonElement,
      history: h('button', { type: 'button', role: 'tab' }, '사용 내역') as HTMLButtonElement,
    };
    this.tabBtns.open.addEventListener('click', () => this.setTab('open'));
    this.tabBtns.history.addEventListener('click', () => this.setTab('history'));
    this.treeEl = h('div', { class: 'dc-tree', role: 'tree', 'aria-label': '도면과 종류' });
    this.contentEl = h('div', { class: 'dc-content', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': '내용', tabindex: 0 });
    this.previewCanvas = h('canvas', { 'aria-label': '미리보기' }) as HTMLCanvasElement;
    this.descEl = h('div', { class: 'dc-desc' });
    this.statusEl = h('span', { class: 'st' });
    this.addBtn = btn('도면에 추가(A)', '고른 정의를 지금 도면에 추가합니다', () => this.act(false));
    this.insertBtn = btn('삽입(I)...', '고른 블록을 삽입점을 지정해 넣습니다', () => this.act(true));
    this.el = h(
      'div',
      { class: 'dc-panel', role: 'dialog', 'aria-label': '디자인센터' },
      head,
      h('div', { class: 'dc-tabs', role: 'tablist' }, this.tabBtns.open, this.tabBtns.history),
      h('div', { class: 'dc-main' }, this.treeEl, h('div', { class: 'dc-right' }, this.contentEl, h('div', { class: 'dc-bottom' }, this.previewCanvas, this.descEl))),
      h('div', { class: 'dc-foot' }, this.statusEl, this.insertBtn, this.addBtn),
    );
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'wheel', 'contextmenu']) this.el.addEventListener(t, (ev) => ev.stopPropagation());
    guardKeys(this.el);
    this.el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.close();
      else if (ev.key === 'Enter' && this.sel.size) this.act(this.cur?.kind === 'block');
    });
    this.contentEl.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!this.cur || !this.sel.size) return;
      const blk = this.cur.kind === 'block';
      showMenu(ev.clientX, ev.clientY, [
        ...(blk ? [{ label: '블록 삽입(I)...', disabled: this.sel.size !== 1, run: () => this.act(true) }] : []),
        { label: blk ? '정의만 추가(D)' : `${DEF_KIND_LABEL[this.cur.kind]} 추가(A)`, run: () => this.act(false) },
      ]);
    });
    this.dragHead(head);
    this.unlisten = onLoadedDrawingsChange(() => this.refresh());
    document.body.append(this.el);
    this.setTab(app.docs.length ? 'open' : 'history');
    this.timer = window.setInterval(() => this.poll(), 800);
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

  close(): void {
    clearInterval(this.timer);
    this.unlisten();
    this.el.remove();
    if (panel === this) panel = null;
  }

  focus(): void {
    this.refresh();
    this.contentEl.focus();
  }

  private sources(): Source[] {
    if (this.tab === 'open') return this.app.docs.map((st) => ({ key: `open:${st.docId}`, label: st.name, doc: st.doc, open: true }));
    return loadedDrawings().map((d: LoadedDrawing) => ({ key: `file:${d.serial}`, label: d.name, doc: d.doc, open: false }));
  }

  private signature(): string {
    return `${this.tab}|${this.app.docs.map((d) => `${d.docId}:${d.gen}`).join(',')}|${this.app.active?.docId ?? ''}|${loadedDrawings().map((d) => d.serial).join(',')}`;
  }

  private poll(): void {
    if (this.signature() !== this.sig) this.refresh();
  }

  private setTab(t: 'open' | 'history'): void {
    this.tab = t;
    this.tabBtns.open.classList.toggle('on', t === 'open');
    this.tabBtns.history.classList.toggle('on', t === 'history');
    this.cur = null;
    const first = this.sources()[0];
    if (first) {
      this.expanded.add(first.key);
      this.cur = { source: first.key, kind: 'block' };
    }
    this.refresh();
  }

  private async load(): Promise<void> {
    const got = await pickAndReadDrawings(this.app, (t, c) => this.app.cmd.print(t, c));
    if (!got.length) return;
    this.tab = 'history';
    const src = `file:${got[0]!.serial}`;
    this.expanded.add(src);
    this.cur = { source: src, kind: 'block' };
    this.tabBtns.open.classList.remove('on');
    this.tabBtns.history.classList.add('on');
    this.refresh();
  }

  refresh(): void {
    this.sig = this.signature();
    const sources = this.sources();
    // 같은 파일을 다시 읽어 열쇠가 바뀌었으면 그 파일을 따라간다
    for (const k of [...this.expanded]) {
      if (sources.some((s) => s.key === k)) continue;
      this.expanded.delete(k);
      const label = this.labels.get(k);
      const same = label ? sources.find((s) => s.label === label) : undefined;
      if (same) this.expanded.add(same.key);
    }
    if (this.cur && !sources.some((s) => s.key === this.cur!.source)) {
      const label = this.labels.get(this.cur.source);
      const same = label ? sources.find((s) => s.label === label) : undefined;
      this.cur = same ? { source: same.key, kind: this.cur.kind } : null;
    }
    for (const s of sources) this.labels.set(s.key, s.label);
    this.renderTree(sources);
    this.renderContent(sources);
  }

  private renderTree(sources: Source[]): void {
    if (!sources.length) {
      this.treeEl.replaceChildren(h('div', { class: 'dc-empty' }, this.tab === 'open' ? '열린 도면이 없습니다.' : '로드(L)로 도면 파일을 고르십시오.'));
      return;
    }
    const rows: HTMLElement[] = [];
    for (const s of sources) {
      const open = this.expanded.has(s.key);
      const active = s.open && this.app.active?.doc === s.doc;
      const n = h('div', { class: 'n', role: 'treeitem', 'aria-expanded': open ? 'true' : 'false', title: s.label }, h('span', { class: 'tw' }, open ? '▾' : '▸'), h('span', {}, `${s.label}${active ? ' (현재)' : ''}`));
      n.addEventListener('click', () => {
        if (open) this.expanded.delete(s.key);
        else this.expanded.add(s.key);
        this.refresh();
      });
      rows.push(n);
      if (!open) continue;
      for (const k of KIND_ORDER) {
        const count = listDefinitions(s.doc, k).length;
        const on = this.cur?.source === s.key && this.cur.kind === k;
        const kn = h('div', { class: `n k${on ? ' on' : ''}`, role: 'treeitem' }, h('span', {}, DEF_KIND_LABEL[k]), h('span', { class: 'c' }, String(count)));
        kn.addEventListener('click', () => {
          this.cur = { source: s.key, kind: k };
          this.sel.clear();
          this.refresh();
        });
        rows.push(kn);
      }
    }
    this.treeEl.replaceChildren(...rows);
  }

  private source(): Source | null {
    if (!this.cur) return null;
    return this.sources().find((s) => s.key === this.cur!.source) ?? null;
  }

  private renderContent(sources: Source[]): void {
    const s = this.cur ? sources.find((x) => x.key === this.cur!.source) : null;
    const kind = this.cur?.kind;
    window.clearTimeout(this.thumbJob);
    if (!s || !kind) {
      this.items = [];
      this.contentEl.replaceChildren(h('div', { class: 'dc-empty' }, '왼쪽에서 도면과 종류를 고르십시오.'));
      this.update();
      return;
    }
    this.items = listDefinitions(s.doc, kind);
    for (const k of [...this.sel]) if (!this.items.includes(k)) this.sel.delete(k);
    this.contentEl.classList.toggle('rows', kind !== 'block');
    if (!this.items.length) {
      this.contentEl.replaceChildren(h('div', { class: 'dc-empty' }, `${DEF_KIND_LABEL[kind]}이(가) 없습니다.`));
      this.update();
      return;
    }
    const color = textColor();
    const pendingThumbs: [HTMLCanvasElement, string][] = [];
    const els = this.items.map((name, i) => {
      let el: HTMLElement;
      if (kind === 'block') {
        const cv = h('canvas', {}) as HTMLCanvasElement;
        el = h('div', { class: `dc-item${this.sel.has(name) ? ' sel' : ''}`, role: 'option', title: name }, cv, h('span', {}, name));
        pendingThumbs.push([cv, name]);
      } else {
        el = h('div', { class: `dc-row${this.sel.has(name) ? ' sel' : ''}`, role: 'option', title: name }, ...this.rowParts(s.doc, kind, name));
      }
      el.addEventListener('mousedown', (ev) => {
        if (ev.button === 2 && this.sel.has(name)) return;
        this.click(i, ev);
      });
      el.addEventListener('dblclick', () => {
        this.sel.clear();
        this.sel.add(name);
        this.act(kind === 'block');
      });
      return el;
    });
    this.contentEl.replaceChildren(...els);
    // 썸네일은 조금씩 그린다
    const step = () => {
      const t0 = performance.now();
      while (pendingThumbs.length && performance.now() - t0 < 24) {
        const [cv, name] = pendingThumbs.shift()!;
        if (cv.isConnected) drawGeometry(cv, blockGeometry(this.app, s.doc, name), color);
      }
      if (pendingThumbs.length) this.thumbJob = window.setTimeout(step, 0);
    };
    step();
    this.update();
  }

  private rowParts(doc: CadDocument, kind: DefKind, name: string): (HTMLElement | string)[] {
    const d = this.describe(doc, kind, name, true);
    if (kind === 'layer') {
      const l = doc.layers.get(tableKey(name)) as Layer;
      return [h('span', { class: 'sw', style: `background:${layerSwatch(l)}` }), h('span', {}, name), h('span', { class: 'd' }, d)];
    }
    return [h('span', {}, name), h('span', { class: 'd' }, d)];
  }

  /** 항목 설명 */
  private describe(doc: CadDocument, kind: DefKind, name: string, short = false): string {
    const k = tableKey(name);
    switch (kind) {
      case 'block': {
        const b = doc.blocks.get(k);
        if (!b) return '';
        const att = b.entities.filter((e) => e.type === 'ATTDEF').length;
        return `${b.description ? `${b.description} · ` : ''}객체 ${b.entities.length}개${att ? `, 속성 ${att}개` : ''} · 기준점 ${b.basePoint.x.toFixed(2)}, ${b.basePoint.y.toFixed(2)}`;
      }
      case 'layer': {
        const l = doc.layers.get(k);
        return l ? `${colorLabel(l.color)} · ${l.linetype} · ${lineweightLabel(l.lineweight)}${!short && l.description ? ` · ${l.description}` : ''}` : '';
      }
      case 'linetype': {
        const l = doc.linetypes.get(k);
        return l?.description ?? '';
      }
      case 'textStyle': {
        const s = doc.textStyles.get(k);
        return s ? `${s.fontFamily || s.font || ''}${s.bigFont ? ` + ${s.bigFont}` : ''}${s.height ? ` · 높이 ${s.height}` : ''}` : '';
      }
      case 'dimStyle': {
        const s = doc.dimStyles.get(k);
        if (!s) return '';
        const v = s.vars;
        return `DIMSCALE ${v.DIMSCALE ?? 1} · DIMTXT ${v.DIMTXT ?? '-'} · DIMASZ ${v.DIMASZ ?? '-'}${v.DIMTXSTY ? ` · ${v.DIMTXSTY}` : ''}`;
      }
      case 'mleaderStyle': {
        const s = mleaderStyles(doc).find((x) => tableKey(x.name) === k)?.obj;
        return s ? `문자 높이 ${s.textHeight} · 화살촉 ${s.arrowSize}` : '';
      }
      case 'tableStyle': {
        const s = listTableStyles(doc).find((x) => tableKey(x.name) === k)?.style;
        return s ? `${s.description || ''}${s.description ? ' · ' : ''}데이터 문자 ${s.cells.data.textStyle} ${s.cells.data.height}` : '';
      }
      case 'layout': {
        const l = doc.layouts.find((x) => tableKey(x.name) === k);
        if (!l) return '';
        const n = doc.blocks.get(tableKey(l.blockName))?.entities.length ?? 0;
        return `${l.plot.paperName || '용지'} ${l.plot.paperWidth}×${l.plot.paperHeight} mm · 객체 ${n}개`;
      }
    }
  }

  private click(i: number, ev: MouseEvent): void {
    const name = this.items[i]!;
    if (ev.shiftKey && this.anchor >= 0) {
      const [a, b] = this.anchor < i ? [this.anchor, i] : [i, this.anchor];
      if (!(ev.ctrlKey || ev.metaKey)) this.sel.clear();
      for (let k = a; k <= b; k++) this.sel.add(this.items[k]!);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (this.sel.has(name)) this.sel.delete(name);
      else this.sel.add(name);
      this.anchor = i;
    } else {
      this.sel.clear();
      this.sel.add(name);
      this.anchor = i;
    }
    for (const [j, el] of [...this.contentEl.children].entries()) el.classList.toggle('sel', this.sel.has(this.items[j] ?? ''));
    this.update();
  }

  /** 미리보기·설명·단추 */
  private update(): void {
    const s = this.source();
    const kind = this.cur?.kind;
    const one = this.sel.size === 1 ? [...this.sel][0]! : null;
    if (s && kind === 'block' && one) drawGeometry(this.previewCanvas, blockGeometry(this.app, s.doc, one), textColor());
    else drawGeometry(this.previewCanvas, null, textColor());
    this.descEl.textContent = s && kind && one ? `${one}\n${this.describe(s.doc, kind, one)}` : s && kind ? `${s.label} — ${DEF_KIND_LABEL[kind]} ${this.items.length}개` : '';
    this.descEl.style.whiteSpace = 'pre-line';
    const target = this.app.active;
    this.statusEl.textContent = !target ? '항목을 넣을 도면을 먼저 여십시오.' : this.sel.size ? `${this.sel.size}개 선택 → ${target.name}` : '항목을 고르십시오(Ctrl·Shift로 여러 개, 더블클릭으로 바로 추가).';
    this.addBtn.disabled = !target || !this.sel.size;
    this.insertBtn.hidden = kind !== 'block';
    this.insertBtn.disabled = !target || this.sel.size !== 1;
    this.addBtn.textContent = kind === 'block' ? '정의만 추가(D)' : '도면에 추가(A)';
  }

  /** 고른 항목을 지금 도면에 넣는다(ADCADD 명령으로) */
  private act(insert: boolean): void {
    const s = this.source();
    if (!s || !this.cur || !this.sel.size) return;
    if (!this.app.active) {
      this.app.cmd.print('항목을 넣을 도면을 먼저 여십시오.', 'err');
      return;
    }
    const names = this.items.filter((n) => this.sel.has(n));
    pending = { doc: s.doc, label: s.label, kind: this.cur.kind, names: insert ? names.slice(0, 1) : names, insert: insert && this.cur.kind === 'block' };
    void this.app.run('ADCADD');
  }
}

// ---------------------------------------------------------------------------
// 넣기
// ---------------------------------------------------------------------------

function unitFactor(srcUnits: number, dstUnits: number): number {
  const a = INSUNITS_MM[srcUnits];
  const b = INSUNITS_MM[dstUnits];
  return srcUnits && dstUnits && a && b ? a / b : 1;
}

async function askNumber(ctx: CommandContext, prompt: string, def: number, ok: (v: number) => boolean): Promise<number> {
  for (;;) {
    const r = await ctx.getPoint(`${prompt} <${Math.round(def * 1e6) / 1e6}>:`, { preferNumber: true, allowText: true });
    if ('enter' in r) return def;
    if ('text' in r) {
      const v = Number(r.text.trim());
      if (Number.isFinite(v) && ok(v)) return v;
    }
    ctx.print('올바른 값을 입력하십시오.', 'err');
  }
}

async function insertBlock(app: App, ctx: CommandContext, p: Pending): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const name = p.names[0]!;
  const key = tableKey(name);
  const srcDef = p.doc.blocks.get(key);
  if (!srcDef) {
    ctx.print(`블록 "${name}"을(를) 찾을 수 없습니다.`, 'err');
    return;
  }
  const exists = doc.blocks.has(key);
  if (exists && p.doc !== doc) ctx.print(`블록 "${doc.blocks.get(key)!.name}"의 중복 정의는 무시됩니다.`);
  const def = exists ? doc.blocks.get(key)! : srcDef;
  const geomDoc = exists ? doc : p.doc;
  const units = (d: CadDocument, k: string) => d.blockRecords.get(k)?.insertUnits || Number(d.header.get('$INSUNITS') ?? 0) || 0;
  let scale = unitFactor(units(geomDoc, key), Number(doc.header.get('$INSUNITS') ?? 0) || 0);
  let rotDeg = 0;
  const g = blockGeometry(app, geomDoc, def.name);
  const ghost = g ? Ghost.of(g) : null;
  const xf = (q: { x: number; y: number }): Affine => {
    const r = (rotDeg * Math.PI) / 180;
    const a = scale * Math.cos(r);
    const b = scale * Math.sin(r);
    const bx = def.basePoint.x;
    const by = def.basePoint.y;
    return [a, b, -b, a, q.x - (a * bx - b * by), q.y - (b * bx + a * by)];
  };
  let at: { x: number; y: number } | null = null;
  for (;;) {
    const r = await ctx.getPoint('삽입점 지정 또는 [축척(S)/회전(R)]:', {
      keywords: [
        { key: 'S', label: '축척' },
        { key: 'R', label: '회전' },
      ],
      ghost: ghost ? (q) => ghost.at(xf(q)) : undefined,
    });
    if ('point' in r) {
      at = r.point;
      break;
    }
    if ('keyword' in r && r.keyword === 'S') scale = await askNumber(ctx, 'XYZ 축에 대한 축척 비율 지정', scale, (v) => v !== 0);
    else if ('keyword' in r && r.keyword === 'R') rotDeg = await askNumber(ctx, '회전 각도 지정', rotDeg, () => true);
    else return;
  }
  // 정의(없으면 복사) → 삽입, 명령 취소 한 단계
  let dstName = def.name;
  if (!exists) {
    const cp = new DefinitionCopier(p.doc, doc, () => st.session.newHandle());
    const n = cp.block(name);
    if (!n) {
      ctx.print(`블록 "${name}"을(를) 가져올 수 없습니다(외부 참조 블록 등).`, 'err');
      return;
    }
    dstName = n;
    st.session.commit({ label: 'ADCENTER', ops: cp.finish(), group: ctx.group });
    const skipped = [...cp.skipped].map(([t, c]) => `${t} ${c}개`).join(', ');
    if (skipped) ctx.print(`블록 안의 옮길 수 없는 객체(${skipped})는 뺐습니다.`);
  }
  const dstDef = doc.blocks.get(tableKey(dstName))!;
  const defs = dstDef.entities.filter((e): e is AttribEntity => e.type === 'ATTDEF' && !((e as AttribEntity).attFlags & 2));
  const values = new Map<string, string>();
  const askDefs = defs.filter((d) => !(d.attFlags & 8));
  if (askDefs.length) {
    const v = await form(
      '속성 값',
      askDefs.map((d, i) => ({ key: `a${i}`, label: d.prompt || d.tag, type: 'text' as const, value: d.text })),
      { ok: '확인' },
    );
    if (v) askDefs.forEach((d, i) => values.set(d.tag, String(v[`a${i}`])));
  }
  const handle = st.session.newHandle();
  const insPt = { x: at.x, y: at.y, z: 0 };
  const sc = { x: scale, y: scale, z: scale };
  const rot = (rotDeg * Math.PI) / 180;
  const ins: InsertEntity = {
    ...entityDefaults(),
    ...currentProps(app),
    type: 'INSERT',
    handle,
    block: dstDef.name,
    insert: insPt,
    scale: sc,
    rotation: rot,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
  if (/^\*PAPER_SPACE/i.test(st.space)) ins.paperSpace = true;
  ins.attribs = makeAttribs(app, dstDef, insPt, sc, rot, values, handle);
  const added = addEntities(app, ctx, [ins], 'ADCENTER');
  app.lastCreated = added;
}

function addDefinitions(app: App, ctx: CommandContext, p: Pending): void {
  const st = app.active!;
  const label = DEF_KIND_LABEL[p.kind];
  const added: string[] = [];
  const dup: string[] = [];
  const miss: string[] = [];
  const cp = new DefinitionCopier(p.doc, st.doc, () => st.session.newHandle());
  for (const n of p.names) {
    const r = p.doc === st.doc ? 'exists' : cp.copy(p.kind, n);
    if (r === 'added') added.push(n);
    else if (r === 'exists') dup.push(n);
    else miss.push(n);
  }
  const ops = cp.finish();
  if (ops.length) st.session.commit({ label: 'ADCENTER', ops, group: ctx.group });
  if (added.length) ctx.print(`${label} ${added.length}개가 추가되었습니다(${added.join(', ')}).`);
  if (dup.length) {
    if (p.kind === 'block') for (const n of dup) ctx.print(`블록 "${n}"의 중복 정의는 무시됩니다.`);
    else ctx.print(`중복된 정의는 무시됩니다(이 도면에 이미 있는 ${label}: ${dup.join(', ')}).`);
  }
  if (miss.length) ctx.print(`${label} ${miss.join(', ')}을(를) 가져올 수 없습니다.`, 'err');
  const req = new Set(added.map((n) => `${p.kind}:${tableKey(n)}`));
  const deps = cp.added.filter((a) => !req.has(`${a.kind}:${tableKey(a.name)}`));
  if (deps.length) {
    const byKind = new Map<DefKind, number>();
    for (const d of deps) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    ctx.print(`함께 가져온 정의: ${[...byKind].map(([k, c]) => `${DEF_KIND_LABEL[k]} ${c}개`).join(', ')}`);
  }
  const skipped = [...cp.skipped].map(([t, c]) => `${t} ${c}개`).join(', ');
  if (skipped) ctx.print(`옮길 수 없는 객체(${skipped})는 뺐습니다(파일을 가리키는 이미지·언더레이 등).`);
}

export function registerDesignCenterCommands(app: App): void {
  app.register({
    name: 'ADCENTER',
    aliases: ['ADC', 'DC', 'DCENTER'],
    title: '디자인센터',
    noDoc: true,
    run() {
      if (panel) {
        panel.close();
        return;
      }
      panel = new DesignCenter(app);
      panel.focus();
    },
  });
  app.register({
    name: 'ADCCLOSE',
    title: '디자인센터 닫기',
    noDoc: true,
    run() {
      panel?.close();
    },
  });
  app.register({
    name: 'ADCADD',
    title: '디자인센터 항목 추가',
    async run(ctx) {
      const p = pending;
      pending = null;
      if (!p || !p.names.length) {
        ctx.print('디자인센터(ADCENTER)에서 넣을 항목을 고르십시오.');
        return;
      }
      if (p.insert) await insertBlock(app, ctx, p);
      else addDefinitions(app, ctx, p);
      panel?.refresh();
    },
  });
}

/** 디자인센터가 열려 있는지 */
export function designCenterOpen(): boolean {
  return panel !== null;
}

/** 다른 도면(또는 지금 도면)의 블록 하나를 디자인센터와 같은 방법으로 삽입한다(ADCADD 명령, 블록 팔레트가 쓴다) */
export function insertBlockFrom(app: App, doc: CadDocument, label: string, name: string): Promise<void> {
  pending = { doc, label, kind: 'block', names: [name], insert: true };
  return app.run('ADCADD');
}
