/** 오른쪽 팔레트: 특성, 도면층, 치수 목록, 문자 찾기 */
import type { App } from '../app';
import type { CadColor, CadDocument, DimensionEntity, Entity, InsertEntity } from '../../core/model';
import { tableKey } from '../../core/model';
import { aciToRgb, nearestAci, rgbToCss } from '../../core/color';
import { formatLength } from '../../core/units';
import { colorText, dimDisplayText, dimTypeName, entityLength, entityProperties, lineweightText, plainText, typeName } from '../inquiry';
import { zoomToHandles } from '../commands';
import { type Field, GENERAL_FIELDS, LINEWEIGHTS, applyField, attribFields, commonValue, formatValue, geometryFields, parseValue } from '../propedit';
import { type LayerPatch, cannotDeleteLayer, createLayer, currentLayer, deleteLayer, layerUsage, newLayerName, patchLayers, renameLayer, setCurrentLayer } from '../layers';
import { pickColor } from './colorpick';
import { h, showMenu } from './dom';
import { icon } from './icons';
import { NARROW_WIDTH, sheetFraction } from './layout';
import { dynPaletteGroup } from '../dynblock';
import { arrayPaletteGroup } from '../assocarray-ui';
import { annoCurrentRow, annoPaletteGroup } from '../annoscale-palette';
import { layerFilterPanel } from '../layerfilter-ui';

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
    const grip = h('div', { class: 'palette-resize', 'aria-hidden': 'true' });
    this.el = h('div', { class: 'palette', hidden: true }, grip, h('div', { class: 'palette-head' }, this.tabs, close), this.body);
    parent.append(this.el);
    try {
      const w = Number(localStorage.getItem('opencad.palette.width'));
      if (w >= 240 && w <= 900) this.width = w;
    } catch {
      /* 저장소를 못 쓰는 환경 */
    }
    this.el.style.setProperty('--palette-w', `${this.width}px`);
    // 좁은 화면(760px 미만)에서는 아래쪽 시트: 손잡이를 위아래로 끌어 높이를 바꾼다(작업 영역 높이에 대한 비율)
    let sheet = 0.5;
    try {
      sheet = sheetFraction(Number(localStorage.getItem('opencad.palette.sheet') ?? 0.5));
    } catch {
      /* 저장소를 못 쓰는 환경 */
    }
    parent.style.setProperty('--sheet-h', `${Math.round(sheet * 100)}%`);
    grip.addEventListener('pointerdown', (ev) => {
      grip.setPointerCapture(ev.pointerId);
      const asSheet = window.innerWidth < NARROW_WIDTH;
      const x0 = ev.clientX;
      const w0 = this.el.getBoundingClientRect().width;
      const host = parent.getBoundingClientRect();
      const move = (e: PointerEvent) => {
        if (asSheet) {
          sheet = sheetFraction((host.bottom - e.clientY) / Math.max(1, host.height));
          parent.style.setProperty('--sheet-h', `${Math.round(sheet * 100)}%`);
          return;
        }
        this.width = Math.max(240, Math.min(900, w0 + (x0 - e.clientX)));
        this.el.style.setProperty('--palette-w', `${this.width}px`);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        try {
          if (asSheet) localStorage.setItem('opencad.palette.sheet', sheet.toFixed(3));
          else localStorage.setItem('opencad.palette.width', String(Math.round(this.width)));
        } catch {
          /* 무시 */
        }
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
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
    // 편집 중이던 칸으로 포커스를 되돌린다(Tab으로 옮긴 칸 포함)
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('[data-field]') as HTMLElement | null;
    const focusKey = focused && this.body.contains(focused) ? focused.dataset.field : null;
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
    if (focusKey) {
      const el = [...this.body.querySelectorAll<HTMLElement>('[data-field]')].find((x) => x.dataset.field === focusKey);
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    }
  }

  private props(): void {
    const app = this.app;
    const st = app.active!;
    const sel = [...st.selection].map((x) => st.doc.entityIndex.get(x)).filter((e): e is Entity => !!e);
    if (!sel.length) {
      this.body.append(h('div', { class: 'empty' }, '선택한 객체가 없습니다. 도면에서 객체를 클릭하십시오.'));
      this.currentSettings();
      return;
    }
    const handles = sel.map((e) => e.handle);
    const types = new Set(sel.map((e) => e.type));
    const title = sel.length === 1 ? typeName(sel[0]!) : types.size === 1 ? `${typeName(sel[0]!)} (${sel.length.toLocaleString()})` : `전체 (${sel.length.toLocaleString()})`;
    this.body.append(h('div', { class: 'prop-title' }, title));
    this.editGroup('일반', GENERAL_FIELDS, sel, handles);
    const anno = annoPaletteGroup(this.app, sel);
    if (anno) this.body.append(anno);
    if (types.size === 1) {
      const t = sel[0]!.type;
      const fields = geometryFields(t);
      if (fields.length) this.editGroup(t === 'TEXT' || t === 'MTEXT' || t === 'ATTDEF' ? '문자' : '형상', fields, sel, handles);
      if (sel.length === 1 && t === 'INSERT') {
        const dyn = dynPaletteGroup(app, sel[0]!.handle);
        if (dyn) this.body.append(dyn);
        const arr = arrayPaletteGroup(app, sel[0]!.handle);
        if (arr) this.body.append(arr);
        const af = attribFields(sel[0] as InsertEntity);
        if (af.length) this.editGroup('속성', af, sel, handles);
      }
    }
    if (sel.length === 1) {
      const edited = new Set(['도면층', '색상', '선종류', '선종류 축척', '선가중치', '투명도', ...geometryFields(sel[0]!.type).map((f) => f.label)]);
      const dup = /^(시작점|끝점|중심|위치|삽입점|축척|내용)$/;
      for (const g of entityProperties(st.doc, sel[0]!, st.units)) {
        const rows = g.rows.filter((r) => !edited.has(r.k) && !dup.test(r.k));
        if (rows.length) this.group(g.title === '일반' ? '정보' : g.title === '형상' ? '측정' : g.title, rows);
      }
      return;
    }
    const counts = new Map<string, number>();
    for (const e of sel) counts.set(typeName(e), (counts.get(typeName(e)) ?? 0) + 1);
    let total = 0;
    let lenCount = 0;
    for (const e of sel) {
      const l = entityLength(e);
      if (l !== null) {
        total += l;
        lenCount++;
      }
    }
    this.group('종류별', [
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v: v.toLocaleString() })),
      ...(lenCount ? [{ k: `길이 합계(${lenCount})`, v: formatLength(total, st.units) }] : []),
    ]);
  }

  /** 선택이 없을 때: 새로 그릴 객체의 현재 특성 */
  private currentSettings(): void {
    const app = this.app;
    const st = app.active!;
    const hdr = st.doc.header;
    const cur = {
      layer: String(hdr.get('$CLAYER') ?? '0'),
      color: currentColor(st.doc),
      linetype: String(hdr.get('$CELTYPE') ?? 'ByLayer'),
      lineweight: Number(hdr.get('$CELWEIGHT') ?? -1),
      ltscale: Number(hdr.get('$CELTSCALE') ?? 1),
    };
    const setHeader = (name: string, after: string | number) => {
      const before = st.doc.header.get(name);
      if (before === after) return;
      st.session.commit({ label: 'SETVAR', ops: [{ kind: 'header', name, before, after }] });
    };
    const fake = { ...cur, type: 'CURRENT', handle: '', transparency: -1 } as unknown as Entity;
    const rows: HTMLElement[] = [];
    for (const f of GENERAL_FIELDS) {
      if (f.label === '투명도') continue;
      rows.push(
        this.editor(f, [fake], (v) => {
          if (f.label === '도면층') setCurrentLayer(app, String(v));
          else if (f.label === '색상') setHeader('$CECOLOR', colorToHeader(v as CadColor));
          else if (f.label === '선종류') setHeader('$CELTYPE', String(v));
          else if (f.label === '선가중치') setHeader('$CELWEIGHT', Number(v));
          else if (f.label === '선종류 축척') setHeader('$CELTSCALE', Number(v));
        }),
      );
    }
    const annoRow = annoCurrentRow(app);
    if (annoRow) rows.push(annoRow);
    this.body.append(h('div', { class: 'prop-group' }, h('h4', {}, '새 객체의 현재 특성'), ...rows));
  }

  private editGroup(title: string, fields: Field[], sel: Entity[], handles: string[]): void {
    const rows = fields.map((f) => this.editor(f, sel, (v) => applyField(this.app, handles, f, v)));
    this.body.append(h('div', { class: 'prop-group' }, h('h4', {}, title), ...rows));
  }

  /** 항목 하나의 편집 줄 */
  private editor(f: Field, sel: Entity[], commit: (v: unknown) => void): HTMLElement {
    const st = this.app.active!;
    const { value, varies } = commonValue(f, sel);
    const id = `pf-${f.label}`;
    let ctl: HTMLElement;
    switch (f.kind) {
      case 'select': {
        const opts = f.options?.(st.doc) ?? [];
        const sv = value === undefined ? '' : String(value);
        if (!varies && sv && !opts.some((o) => o.value.toUpperCase() === sv.toUpperCase())) opts.unshift({ value: sv, label: sv });
        const el = h('select', { 'data-field': id, 'aria-label': f.label }, ...(varies ? [h('option', { value: '' }, '*여러 개*')] : []), ...opts.map((o) => h('option', { value: o.value }, o.label)));
        const match = opts.find((o) => o.value.toUpperCase() === sv.toUpperCase());
        el.value = varies ? '' : (match?.value ?? sv);
        el.addEventListener('change', () => {
          if (el.value !== '') commit(el.value);
        });
        ctl = el;
        break;
      }
      case 'bool': {
        const el = h('select', { 'data-field': id, 'aria-label': f.label }, ...(varies ? [h('option', { value: '' }, '*여러 개*')] : []), h('option', { value: '1' }, '예'), h('option', { value: '0' }, '아니오'));
        el.value = varies ? '' : value ? '1' : '0';
        el.addEventListener('change', () => {
          if (el.value !== '') commit(el.value === '1');
        });
        ctl = el;
        break;
      }
      case 'color': {
        const c = value as CadColor | undefined;
        const rgb = c ? (c.rgb !== undefined && c.aci !== 0 && c.aci !== 256 ? c.rgb : c.aci > 0 && c.aci < 256 ? aciToRgb(c.aci, true) : null) : null;
        const el = h(
          'button',
          { class: 'prop-color', 'data-field': id, 'aria-label': f.label },
          h('span', { class: 'swatch', style: rgb === null ? 'background:transparent' : `background:${rgbToCss(rgb)}` }),
          varies ? '*여러 개*' : c ? colorText(c) : '',
        );
        el.addEventListener('click', async () => {
          const r = await pickColor(c ?? { aci: 256 }, { allowBy: true });
          if (r) commit(r);
        });
        ctl = el;
        break;
      }
      case 'multiline': {
        const el = h('textarea', { 'data-field': id, rows: 3, 'aria-label': f.label, placeholder: varies ? '*여러 개*' : '' }) as HTMLTextAreaElement;
        el.value = varies ? '' : String(value ?? '');
        el.addEventListener('change', () => commit(el.value));
        ctl = el;
        break;
      }
      default: {
        const el = h('input', { 'data-field': id, 'aria-label': f.label, placeholder: varies ? '*여러 개*' : '' }) as HTMLInputElement;
        el.value = varies ? '' : formatValue(f, value, st.units);
        const orig = el.value;
        el.addEventListener('keydown', (ev) => {
          if ((ev as KeyboardEvent).key === 'Enter') el.blur();
          if ((ev as KeyboardEvent).key === 'Escape') {
            el.value = orig;
            el.blur();
          }
        });
        el.addEventListener('change', () => {
          if (el.value === orig || (varies && !el.value.trim())) return;
          const r = parseValue(f, el.value, st.units);
          if ('error' in r) {
            this.app.cmd.print(`${f.label}: ${r.error}`, 'err');
            el.value = orig;
            return;
          }
          commit(r.value);
        });
        ctl = el;
      }
    }
    return h('label', { class: 'prop-row edit' }, h('span', { class: 'k' }, f.label), ctl);
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
    const used = layerUsage(app);
    const q = this.layerFilter.trim().toUpperCase();
    // 도면층 필터(필터 트리에서 고른 필터와 필터 반전) 안에서 이름 찾기
    const lf = layerFilterPanel(app, () => this.refresh());
    const rows = [...st.doc.layers.entries()].filter(([k]) => lf.visible.has(k) && (!q || k.includes(q))).sort((a, b) => a[1].name.localeCompare(b[1].name, 'ko'));
    const clayer = tableKey(currentLayer(app));
    if (this.layerSel && !st.doc.layers.has(this.layerSel)) this.layerSel = null;
    const sel = this.layerSel;
    const bar = h(
      'div',
      { class: 'layer-bar' },
      h('button', { class: 'icon-btn', title: '새 도면층', 'aria-label': '새 도면층', html: icon('layerNew'), onclick: () => this.newLayer() }),
      h('button', {
        class: 'icon-btn',
        title: '지우기',
        'aria-label': '도면층 지우기',
        html: icon('layerDelete'),
        disabled: !sel,
        onclick: () => sel && deleteLayer(app, sel),
      }),
      h('button', { class: 'icon-btn', title: '현재 도면층으로', 'aria-label': '현재 도면층으로', html: icon('layerCurrent'), disabled: !sel, onclick: () => sel && setCurrentLayer(app, sel) }),
      ...lf.barButtons,
      h('span', { class: 'status-sep' }),
      h('button', { class: 'btn', onclick: () => patchLayers(app, 'LAYON', rows.map(([, l]) => [l.name, { off: false }])) }, '모두 켜기'),
      h('button', { class: 'btn', onclick: () => patchLayers(app, 'LAYTHW', rows.map(([, l]) => [l.name, { frozen: false }])) }, '동결 해제'),
      h('span', { class: 'chip', style: 'align-self:center;margin-left:auto' }, `${rows.length} / ${st.doc.layers.size}`),
    );
    const tbody = h('tbody');
    for (const [k, lay] of rows) {
      const color = lay.color.rgb !== undefined ? lay.color.rgb : aciToRgb(lay.color.aci, true);
      const tog = (ic: string, title: string, off: boolean, patch: LayerPatch) => {
        const b = h('button', { class: `toggle ${off ? 'off' : ''}`, title, 'aria-label': `${lay.name} ${title}`, html: icon(ic) });
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (patch.frozen && k === clayer) {
            app.cmd.print('현재 도면층은 동결할 수 없습니다.', 'err');
            return;
          }
          patchLayers(app, 'LAYER', [[lay.name, patch]]);
        });
        return b;
      };
      const sw = h('button', { class: 'toggle', title: `색: ${colorText(lay.color)}`, 'aria-label': `${lay.name} 색 바꾸기` }, h('span', { class: 'swatch', style: `background:${rgbToCss(color)}` }));
      sw.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const c = await pickColor(lay.color);
        if (c) patchLayers(app, 'LAYER', [[lay.name, { color: c }]]);
      });
      const lt = h('select', { class: 'cell-select', 'aria-label': `${lay.name} 선종류` }, ...[...st.doc.linetypes.values()].filter((l) => !/^by(layer|block)$/i.test(l.name)).map((l) => h('option', { value: l.name }, l.name)));
      lt.value = [...st.doc.linetypes.values()].find((l) => tableKey(l.name) === tableKey(lay.linetype))?.name ?? lay.linetype;
      lt.addEventListener('change', () => patchLayers(app, 'LAYER', [[lay.name, { linetype: lt.value }]]));
      const lw = h('select', { class: 'cell-select', 'aria-label': `${lay.name} 선가중치` }, h('option', { value: '-3' }, '기본값'), ...LINEWEIGHTS.map((w) => h('option', { value: String(w) }, lineweightText(w))));
      lw.value = String(lay.lineweight);
      lw.addEventListener('change', () => patchLayers(app, 'LAYER', [[lay.name, { lineweight: Number(lw.value) }]]));
      const nameCell = h('td', { class: 'layer-name', title: `${lay.name}${lay.description ? ` — ${lay.description}` : ''}` }, lay.name);
      nameCell.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        this.renameInline(nameCell, k, lay.name);
      });
      const tr = h(
        'tr',
        { class: `${k === clayer ? 'current' : ''} ${k === sel ? 'selected' : ''}` },
        h('td', { class: 'cur', title: k === clayer ? '현재 도면층' : '' }, k === clayer ? '✓' : ''),
        h('td', {}, tog(lay.off ? 'eyeOff' : 'eye', lay.off ? '꺼짐' : '켜짐', lay.off, { off: !lay.off })),
        h('td', {}, tog(lay.frozen ? 'snow' : 'sun', lay.frozen ? '동결' : '동결 해제', lay.frozen, { frozen: !lay.frozen })),
        h('td', {}, tog(lay.locked ? 'lock' : 'unlock', lay.locked ? '잠김' : '잠기지 않음', !lay.locked, { locked: !lay.locked })),
        h('td', {}, sw),
        nameCell,
        h('td', {}, lt),
        h('td', {}, lw),
        h('td', { style: 'color:var(--text-faint);text-align:right' }, String(used.get(k) ?? 0)),
      );
      tr.addEventListener('click', () => {
        this.layerSel = k;
        this.refresh();
      });
      tr.addEventListener('dblclick', () => setCurrentLayer(app, lay.name));
      lf.draggable(tr, lay.name);
      tr.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.layerSel = k;
        showMenu(ev.clientX, ev.clientY, [
          { label: '현재 도면층으로', icon: 'layerCurrent', run: () => setCurrentLayer(app, lay.name) },
          { label: '이름 바꾸기', run: () => this.renameInline(nameCell, k, lay.name) },
          {
            label: '색 바꾸기',
            run: async () => {
              const c = await pickColor(lay.color);
              if (c) patchLayers(app, 'LAYER', [[lay.name, { color: c }]]);
            },
          },
          { separator: true },
          { label: '이 도면층만 켜기', run: () => patchLayers(app, 'LAYISO', [...st.doc.layers.values()].map((l) => [l.name, { off: tableKey(l.name) !== k }])) },
          { label: '이 도면층 객체 모두 선택', run: () => this.selectLayer(k) },
          { label: '고른 객체를 이 도면층으로', disabled: !st.selection.size, run: () => applyField(app, [...st.selection], GENERAL_FIELDS[0]!, lay.name) },
          { separator: true },
          { label: '도면층 지우기', icon: 'layerDelete', disabled: !!cannotDeleteLayer(app, k), run: () => deleteLayer(app, k) },
          ...lf.rowMenu(lay.name),
        ]);
      });
      tbody.append(tr);
    }
    this.body.append(
      search,
      bar,
      lf.wrap(h(
        'div',
        { class: 'layer-table' },
        h(
          'table',
          { class: 'grid' },
          h(
            'thead',
            {},
            h('tr', {}, h('th', {}, ''), h('th', {}, '켜기'), h('th', {}, '동결'), h('th', {}, '잠금'), h('th', {}, '색'), h('th', {}, '이름'), h('th', {}, '선종류'), h('th', {}, '선가중치'), h('th', { style: 'text-align:right' }, '객체')),
          ),
          tbody,
        ),
      )),
      lf.footer(rows.length),
      h('div', { style: 'margin-top:8px;color:var(--text-faint)' }, '행을 두 번 누르면 현재 도면층이 되고, 이름을 두 번 누르면 이름을 바꿉니다. 오른쪽 클릭으로 더 많은 기능을 씁니다.'),
    );
  }

  private layerSel: string | null = null;

  private newLayer(): void {
    const app = this.app;
    const name = newLayerName(app);
    const l = createLayer(app, name);
    if (!l) return;
    this.layerSel = tableKey(name);
    this.refresh();
    const cell = [...this.body.querySelectorAll<HTMLTableCellElement>('td.layer-name')].find((c) => c.textContent === name);
    if (cell) this.renameInline(cell, tableKey(name), name);
  }

  private renameInline(cell: HTMLElement, key: string, name: string): void {
    const input = h('input', { class: 'cell-input', value: name, 'aria-label': '새 도면층 이름' }) as HTMLInputElement;
    cell.innerHTML = '';
    cell.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok && input.value.trim() && input.value.trim() !== name) renameLayer(this.app, key, input.value.trim());
      else this.refresh();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());
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

/** 머리말 $CECOLOR(색 번호: 256 ByLayer, 0 ByBlock) → 색 */
export function currentColor(doc: CadDocument): CadColor {
  const v = doc.header.get('$CECOLOR');
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 256 ? { aci: v } : { aci: 256 };
}

/** 색 → $CECOLOR 값(트루컬러는 가장 가까운 색 번호로) */
export function colorToHeader(c: CadColor): number {
  if (c.aci === 256 || c.aci === 0) return c.aci;
  if (c.rgb !== undefined) return nearestAci(c.rgb);
  return c.aci;
}
