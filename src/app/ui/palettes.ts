/** 오른쪽 팔레트: 특성, 도면층, 치수 목록, 문자 찾기 */
import type { App } from '../app';
import type { DimensionEntity, Entity } from '../../core/model';
import { tableKey } from '../../core/model';
import { aciToRgb, rgbToCss } from '../../core/color';
import { formatLength } from '../../core/units';
import { dimDisplayText, dimTypeName, entityLength, entityProperties, plainText, typeName } from '../inquiry';
import { changedLayers, zoomToHandles } from '../commands';
import { h, showMenu } from './dom';
import { icon } from './icons';

type Tab = 'props' | 'layers' | 'dims' | 'find';

const TABS: { key: Tab; label: string }[] = [
  { key: 'props', label: '특성' },
  { key: 'layers', label: '도면층' },
  { key: 'dims', label: '치수' },
  { key: 'find', label: '찾기' },
];

export class Palette {
  readonly el: HTMLDivElement;
  private readonly tabs: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private tab: Tab = 'props';
  private layerFilter = '';
  private findQuery = '';
  private dimFilter: 'all' | 'mismatch' = 'all';
  private width = 320;

  constructor(
    private readonly app: App,
    parent: HTMLElement,
  ) {
    this.tabs = h('div', { class: 'palette-tabs', role: 'tablist' });
    const close = h('button', { class: 'icon-btn', title: '팔레트 닫기', 'aria-label': '팔레트 닫기', html: icon('close2') });
    close.addEventListener('click', () => this.close());
    this.body = h('div', { class: 'palette-body' });
    const grip = h('div', { class: 'palette-resize' });
    this.el = h('div', { class: 'palette', hidden: true }, grip, h('div', { class: 'palette-head' }, this.tabs, close), this.body);
    parent.append(this.el);
    try {
      const w = Number(localStorage.getItem('opencad.palette.width'));
      if (w >= 240 && w <= 900) this.width = w;
    } catch {
      /* 저장소를 못 쓰는 환경 */
    }
    this.el.style.width = `${this.width}px`;
    grip.addEventListener('pointerdown', (ev) => {
      grip.setPointerCapture(ev.pointerId);
      const x0 = ev.clientX;
      const w0 = this.el.getBoundingClientRect().width;
      const move = (e: PointerEvent) => {
        this.width = Math.max(240, Math.min(900, w0 + (x0 - e.clientX)));
        this.el.style.width = `${this.width}px`;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        try {
          localStorage.setItem('opencad.palette.width', String(Math.round(this.width)));
        } catch {
          /* 무시 */
        }
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
    });
  }

  open(tab: string): void {
    this.tab = (TABS.find((t) => t.key === tab)?.key ?? 'props') as Tab;
    this.el.hidden = false;
    this.refresh();
    if (this.tab === 'find') (this.body.querySelector('input.search') as HTMLInputElement | null)?.focus();
  }

  close(): void {
    this.el.hidden = true;
  }

  refresh(): void {
    if (this.el.hidden) return;
    this.tabs.innerHTML = '';
    for (const t of TABS) {
      const b = h('button', { class: `palette-tab ${t.key === this.tab ? 'active' : ''}`, role: 'tab' }, t.label);
      b.addEventListener('click', () => this.open(t.key));
      this.tabs.append(b);
    }
    const scroll = this.body.scrollTop;
    this.body.innerHTML = '';
    const st = this.app.active;
    if (!st) {
      this.body.append(h('div', { class: 'empty' }, '열린 도면이 없습니다.'));
      return;
    }
    switch (this.tab) {
      case 'props':
        this.props();
        break;
      case 'layers':
        this.layers();
        break;
      case 'dims':
        this.dims();
        break;
      case 'find':
        this.find();
        break;
    }
    this.body.scrollTop = scroll;
  }

  private props(): void {
    const st = this.app.active!;
    const sel = [...st.selection].map((x) => st.doc.entityIndex.get(x)).filter((e): e is Entity => !!e);
    if (!sel.length) {
      this.body.append(h('div', { class: 'empty' }, '선택한 객체가 없습니다. 도면에서 객체를 클릭하십시오.'));
      return;
    }
    if (sel.length === 1) {
      for (const g of entityProperties(st.doc, sel[0]!, st.units)) this.group(g.title, g.rows);
      return;
    }
    const counts = new Map<string, number>();
    for (const e of sel) counts.set(typeName(e), (counts.get(typeName(e)) ?? 0) + 1);
    const layers = new Set(sel.map((e) => e.layer));
    let total = 0;
    let lenCount = 0;
    for (const e of sel) {
      const l = entityLength(e);
      if (l !== null) {
        total += l;
        lenCount++;
      }
    }
    this.group(`전체 (${sel.length.toLocaleString()})`, [
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v: v.toLocaleString() })),
      { k: '도면층', v: layers.size === 1 ? [...layers][0]! : `*여러 개* (${layers.size})` },
      ...(lenCount ? [{ k: `길이 합계(${lenCount})`, v: formatLength(total, st.units) }] : []),
    ]);
  }

  private group(title: string, rows: { k: string; v: string }[]): void {
    this.body.append(
      h(
        'div',
        { class: 'prop-group' },
        h('h4', {}, title),
        ...rows.map((r) => h('div', { class: 'prop-row' }, h('span', { class: 'k' }, r.k), h('span', { class: 'v', title: r.v }, r.v))),
      ),
    );
  }

  private layers(): void {
    const app = this.app;
    const st = app.active!;
    const search = h('input', { class: 'search', placeholder: '도면층 이름 찾기', value: this.layerFilter, 'aria-label': '도면층 찾기' });
    search.addEventListener('input', () => {
      this.layerFilter = search.value;
      this.refresh();
      const s = this.body.querySelector('input.search') as HTMLInputElement | null;
      s?.focus();
      s?.setSelectionRange(s.value.length, s.value.length);
    });
    const used = new Map<string, number>();
    for (const b of st.doc.blocks.values()) for (const e of b.entities) used.set(tableKey(e.layer), (used.get(tableKey(e.layer)) ?? 0) + 1);
    const q = this.layerFilter.trim().toUpperCase();
    const rows = [...st.layers.entries()].filter(([k]) => !q || k.includes(q)).sort((a, b) => a[1].name.localeCompare(b[1].name, 'ko'));
    const clayer = String(st.doc.header.get('$CLAYER') ?? '0').toUpperCase();
    const bar = h(
      'div',
      { style: 'display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap' },
      h('button', { class: 'btn', onclick: () => (rows.forEach(([, l]) => (l.on = true)), changedLayers(app)) }, '모두 켜기'),
      h('button', { class: 'btn', onclick: () => (rows.forEach(([, l]) => (l.frozen = false)), changedLayers(app)) }, '동결 해제'),
      h('span', { class: 'chip', style: 'align-self:center' }, `${rows.length} / ${st.layers.size}`),
    );
    const tbody = h('tbody');
    for (const [k, l] of rows) {
      const lay = st.doc.layers.get(k);
      const color = l.hasRgb ? l.rgb : aciToRgb(l.aci, true);
      const tog = (ic: string, title: string, off: boolean, run: () => void) => {
        const b = h('button', { class: `toggle ${off ? 'off' : ''}`, title, 'aria-label': `${l.name} ${title}`, html: icon(ic) });
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          run();
          changedLayers(app);
        });
        return b;
      };
      const tr = h(
        'tr',
        { class: `${k === clayer ? 'current' : ''}` },
        h('td', {}, tog(l.on ? 'eye' : 'eyeOff', l.on ? '켜짐' : '꺼짐', !l.on, () => (l.on = !l.on))),
        h('td', {}, tog(l.frozen ? 'snow' : 'sun', l.frozen ? '동결' : '동결 해제', l.frozen, () => (l.frozen = !l.frozen))),
        h('td', { title: lay?.locked ? '잠김' : '잠기지 않음', style: 'opacity:.7' }, h('span', { style: 'display:inline-block;width:16px;height:16px', html: icon(lay?.locked ? 'lock' : 'unlock') })),
        h('td', {}, h('span', { class: 'swatch', style: `background:${rgbToCss(color)}` })),
        h('td', { style: 'max-width:150px;overflow:hidden;text-overflow:ellipsis', title: `${l.name}${lay?.description ? ` — ${lay.description}` : ''}` }, l.name),
        h('td', { style: 'color:var(--text-dim)' }, lay?.linetype ?? ''),
        h('td', { style: 'color:var(--text-faint);text-align:right' }, String(used.get(k) ?? 0)),
      );
      tr.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        showMenu(ev.clientX, ev.clientY, [
          {
            label: '이 도면층만 켜기',
            run: () => {
              for (const [kk, ll] of st.layers) ll.on = kk === k;
              changedLayers(app);
            },
          },
          { label: '이 도면층 객체 모두 선택', run: () => this.selectLayer(k) },
        ]);
      });
      tr.addEventListener('dblclick', () => this.selectLayer(k));
      tbody.append(tr);
    }
    this.body.append(
      search,
      bar,
      h(
        'table',
        { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, '켜기'), h('th', {}, '동결'), h('th', {}, '잠금'), h('th', {}, '색'), h('th', {}, '이름'), h('th', {}, '선종류'), h('th', { style: 'text-align:right' }, '객체'))),
        tbody,
      ),
      h('div', { style: 'margin-top:8px;color:var(--text-faint)' }, '행을 두 번 누르면 그 도면층 객체를 선택합니다.'),
    );
  }

  private selectLayer(k: string): void {
    const app = this.app;
    const st = app.active!;
    const scene = st.scenes.get(st.space);
    if (!scene) return;
    const hs = scene.entities.filter((b) => tableKey(st.doc.entityIndex.get(b.handle)?.layer ?? '') === k).map((b) => b.handle);
    app.setSelection(hs);
    app.cmd.print(`도면층 "${st.layers.get(k)?.name}" 객체 ${hs.length}개를 선택했습니다.`);
  }

  private dims(): void {
    const app = this.app;
    const st = app.active!;
    const scene = st.scenes.get(st.space);
    const list: { e: DimensionEntity; text: string; value: string; match: boolean | null }[] = [];
    for (const b of scene?.entities ?? []) {
      const e = st.doc.entityIndex.get(b.handle);
      if (e?.type !== 'DIMENSION') continue;
      const t = dimDisplayText(st.doc, e);
      const num = parseFloat(t.text.replace(/[^\d.\-]/g, ''));
      const fnum = parseFloat(t.formatted.replace(/[^\d.\-]/g, ''));
      let match: boolean | null = null;
      if (e.text && e.text !== '<>' && !e.text.includes('<>') && Number.isFinite(num) && Number.isFinite(fnum)) {
        const dec = (t.formatted.split('.')[1] ?? '').replace(/\D/g, '').length;
        match = Math.abs(num - fnum) <= 0.5 * Math.pow(10, -dec) + 1e-9;
      } else if (!e.text || e.text.includes('<>')) match = true;
      list.push({ e, text: t.text, value: t.isAngle ? `${((t.value * 180) / Math.PI).toFixed(4)}°` : formatLength(t.value, { lunits: 2, luprec: 4 }), match });
    }
    const mism = list.filter((x) => x.match === false).length;
    const sel = h('select', { style: 'height:26px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px' }, h('option', { value: 'all' }, `모두 (${list.length})`), h('option', { value: 'mismatch' }, `재지정 값 불일치 (${mism})`));
    (sel as HTMLSelectElement).value = this.dimFilter;
    sel.addEventListener('change', () => {
      this.dimFilter = (sel as HTMLSelectElement).value as 'all' | 'mismatch';
      this.refresh();
    });
    const rows = list.filter((x) => this.dimFilter === 'all' || x.match === false);
    if (!list.length) {
      this.body.append(h('div', { class: 'empty' }, '이 공간에는 치수가 없습니다.'));
      return;
    }
    const tbody = h('tbody');
    for (const r of rows) {
      const tr = h(
        'tr',
        { class: 'clickable', title: '눌러서 이동' },
        h('td', {}, dimTypeName(r.e)),
        h('td', { style: 'max-width:110px;overflow:hidden;text-overflow:ellipsis' }, r.text || '(숨김)'),
        h('td', { style: 'font-family:var(--mono);color:var(--text-dim)' }, r.value),
        h('td', {}, r.match === false ? h('span', { class: 'chip warn', title: '표시 문자가 실제 측정값과 다릅니다' }, '다름') : r.match ? '✓' : '-'),
      );
      tr.addEventListener('click', () => {
        app.setSelection([r.e.handle]);
        zoomToHandles(app, [r.e.handle]);
      });
      tbody.append(tr);
    }
    this.body.append(
      h('div', { style: 'margin-bottom:6px' }, sel),
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '종류'), h('th', {}, '표시'), h('th', {}, '측정값'), h('th', {}, '일치'))), tbody),
    );
  }

  private find(): void {
    const app = this.app;
    const st = app.active!;
    const input = h('input', { class: 'search', placeholder: '찾을 문자 (Enter)', value: this.findQuery, 'aria-label': '찾을 문자' });
    const results = h('div');
    const run = () => {
      this.findQuery = (input as HTMLInputElement).value;
      results.innerHTML = '';
      const q = this.findQuery.trim().toLowerCase();
      if (!q) return;
      const scene = st.scenes.get(st.space);
      const hits: { handle: string; text: string; type: string }[] = [];
      const check = (handle: string, e: Entity, owner: string) => {
        let t = '';
        if (e.type === 'TEXT' || e.type === 'ATTRIB' || e.type === 'MTEXT') t = plainText(e.text);
        else if (e.type === 'DIMENSION') t = dimDisplayText(st.doc, e).text;
        else if (e.type === 'MULTILEADER') t = plainText(e.context.text?.text ?? '');
        if (t && t.toLowerCase().includes(q)) hits.push({ handle: owner, text: t, type: typeName(e) });
        void handle;
      };
      for (const b of scene?.entities ?? []) {
        const e = st.doc.entityIndex.get(b.handle);
        if (!e) continue;
        check(b.handle, e, b.handle);
        if (e.type === 'INSERT') for (const a of e.attribs) check(a.handle, a, b.handle);
        if (hits.length > 500) break;
      }
      if (!hits.length) {
        results.append(h('div', { class: 'empty' }, '찾은 문자가 없습니다.'));
        return;
      }
      results.append(h('div', { style: 'margin:4px 0;color:var(--text-dim)' }, `${hits.length}개${hits.length > 500 ? ' 이상' : ''}`));
      const tbody = h('tbody');
      for (const x of hits) {
        const tr = h('tr', { class: 'clickable' }, h('td', { style: 'color:var(--text-dim)' }, x.type), h('td', { style: 'white-space:normal' }, x.text.slice(0, 200)));
        tr.addEventListener('click', () => {
          app.setSelection([x.handle]);
          zoomToHandles(app, [x.handle]);
        });
        tbody.append(tr);
      }
      results.append(h('table', { class: 'grid' }, tbody));
    };
    input.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') run();
    });
    this.body.append(input, results);
    if (this.findQuery) run();
  }
}
