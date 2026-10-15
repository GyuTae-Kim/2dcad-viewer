/**
 * 빠른 특성(QUICKPROPERTIES·QPMODE): 고른 객체 옆에 뜨는 작은 특성 창.
 * 특성 팔레트의 항목(src/app/propedit.ts: 도면층·색상·선종류 + 종류별 형상 항목)을 그대로 써서 읽고 고친다.
 * - QPMODE 1: 객체를 고르면 늘 뜬다. 2: 형상 항목이 있는 종류만. 0·음수: QUICKPROPERTIES로 부를 때만.
 * - 여러 종류를 고르면 위쪽 목록에서 종류를 골라 그 종류만 고친다(전체는 일반 항목만).
 * 앱의 선택 갱신(refreshSelectionOverlay)에 걸어 선택이 바뀌면 다시 그리고 화면이 움직이면 따라간다.
 */
import type { CadColor, Entity } from '../core/model';
import type { App } from './app';
import { colorText, typeName } from './inquiry';
import { type Field, GENERAL_FIELDS, applyField, commonValue, formatValue, geometryFields, parseValue } from './propedit';
import { h } from './ui/dom';
import { loadPref, savePref } from './util2-ui';

const QPMODE_KEY = 'opencad.qpmode';

export function qpMode(): number {
  const v = loadPref<number>(QPMODE_KEY, 0);
  return Number.isInteger(v) && v >= -2 && v <= 2 ? v : 0;
}

export function setQpMode(v: number): void {
  savePref(QPMODE_KEY, v);
}

/** 빠른 특성 창에 보일 항목(일반 3개 + 종류의 형상 항목) */
export function quickFields(type: string | null): Field[] {
  const general = GENERAL_FIELDS.slice(0, 3);
  return type ? [...general, ...geometryFields(type)] : general;
}

const COLOR_CHOICES: { value: string; label: string; c: CadColor }[] = [
  { value: '256', label: 'ByLayer', c: { aci: 256 } },
  { value: '0', label: 'ByBlock', c: { aci: 0 } },
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: String(n), label: colorText({ aci: n }), c: { aci: n } })),
];

interface QpState {
  el: HTMLDivElement | null;
  /** 지금 보이는 선택(정렬한 핸들) */
  key: string;
  /** QUICKPROPERTIES로 띄운 선택(QPMODE가 꺼져 있어도 이 선택이 그대로면 보인다) */
  pinned: string | null;
  /** 고른 종류(null = 전체) */
  type: string | null;
  dismissed: string | null;
  /** 앱의 선택 갱신에 이었는지 */
  attached: boolean;
}

const states = new WeakMap<App, QpState>();

function stateOf(app: App): QpState {
  let s = states.get(app);
  if (!s) states.set(app, (s = { el: null, key: '', pinned: null, type: null, dismissed: null, attached: false }));
  return s;
}

function selectionKey(app: App): string {
  const st = app.active;
  return st && st.selection.size ? [...st.selection].sort().join(',') : '';
}

function hide(s: QpState): void {
  s.el?.remove();
  s.el = null;
  s.key = '';
}

/** 선택 범위의 오른쪽 위(화면 좌표). 모르면 null */
function anchorPoint(app: App, handles: string[]): { x: number; y: number } | null {
  const pk = app.picker();
  if (!pk) return null;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const x of handles.slice(0, 2000)) {
    const b = pk.box(x);
    if (!b) continue;
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(maxX)) return null;
  return app.view.worldToScreen(maxX, maxY);
}

function place(app: App, s: QpState, handles: string[]): void {
  if (!s.el) return;
  const p = anchorPoint(app, handles);
  const host = app.view.el.getBoundingClientRect();
  const w = s.el.offsetWidth || 260;
  const hh = s.el.offsetHeight || 160;
  let x = (p?.x ?? host.width - w - 24) + 16;
  let y = (p?.y ?? 24) - 8;
  x = Math.max(8, Math.min(host.width - w - 8, x));
  y = Math.max(8, Math.min(host.height - hh - 8, y));
  s.el.style.left = `${Math.round(x)}px`;
  s.el.style.top = `${Math.round(y)}px`;
}

function fieldInput(app: App, s: QpState, handles: string[], list: Entity[], f: Field): HTMLElement {
  const st = app.active!;
  const { value, varies } = commonValue(f, list);
  const apply = (v: unknown) => {
    applyField(app, handles, f, v, (e) => s.type === null || e.type === s.type);
    // 값이 바뀌면 선택은 그대로라 창을 직접 새로 그린다
    s.key = '';
    sync(app, true);
  };
  const base = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;padding:2px 4px;font:12px var(--font)';
  if (f.kind === 'select' || f.kind === 'color') {
    const opts = f.kind === 'color' ? COLOR_CHOICES.map((c) => ({ value: c.value, label: c.label })) : (f.options?.(st.doc) ?? []);
    const cv = f.kind === 'color' ? (value as CadColor | undefined) : undefined;
    // 색은 ACI(ByLayer·ByBlock 포함)만 목록에 있다. 트루 컬러는 지금 값으로만 보인다
    const cur = f.kind === 'color' ? (cv && (cv.rgb === undefined || cv.aci === 256 || cv.aci === 0) ? String(cv.aci) : '') : String(value ?? '');
    const sel = h('select', { style: base, 'aria-label': f.label }) as HTMLSelectElement;
    if (varies || !opts.some((o) => o.value === cur)) sel.append(h('option', { value: '' }, varies ? '*여러 값*' : f.kind === 'color' && value ? colorText(value as CadColor) : String(value ?? '')));
    for (const o of opts) sel.append(h('option', { value: o.value }, o.label));
    sel.value = varies || !opts.some((o) => o.value === cur) ? '' : cur;
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      apply(f.kind === 'color' ? { ...COLOR_CHOICES.find((c) => c.value === sel.value)!.c } : sel.value);
    });
    return sel;
  }
  if (f.kind === 'bool') {
    const c = h('input', { type: 'checkbox', 'aria-label': f.label }) as HTMLInputElement;
    c.checked = !!value && !varies;
    c.indeterminate = varies;
    c.addEventListener('change', () => apply(c.checked));
    return c;
  }
  const inp = h('input', { type: 'text', style: base, 'aria-label': f.label, placeholder: varies ? '*여러 값*' : '' }) as HTMLInputElement;
  inp.value = varies ? '' : formatValue(f, value, st.units).replace(/\n/g, ' ');
  const commit = () => {
    if (varies && !inp.value.trim()) return;
    const r = parseValue(f, inp.value, st.units);
    if ('error' in r) {
      app.cmd.print(r.error, 'err');
      inp.value = varies ? '' : formatValue(f, value, st.units);
      return;
    }
    apply(r.value);
  };
  inp.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit();
    if (ev.key === 'Escape') {
      inp.value = varies ? '' : formatValue(f, value, st.units);
      inp.blur();
    }
  });
  inp.addEventListener('change', commit);
  return inp;
}

function render(app: App, s: QpState, handles: string[]): void {
  const st = app.active!;
  const all = handles.map((x) => st.doc.entityIndex.get(x)).filter((e): e is Entity => !!e);
  if (!all.length) {
    hide(s);
    return;
  }
  const types = new Map<string, Entity[]>();
  for (const e of all) {
    const l = types.get(e.type);
    if (l) l.push(e);
    else types.set(e.type, [e]);
  }
  if (s.type && !types.has(s.type)) s.type = null;
  if (types.size === 1) s.type = all[0]!.type;
  const list = s.type ? types.get(s.type)! : all;
  const el = s.el ?? (h('div', { class: 'opencad-qp', role: 'dialog', 'aria-label': '빠른 특성' }) as HTMLDivElement);
  el.setAttribute(
    'style',
    'position:absolute;z-index:20;width:260px;max-height:60%;overflow:auto;background:var(--bg-panel);color:var(--text);border:1px solid var(--border-soft);border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.35);font:12px var(--font);padding:6px',
  );
  el.innerHTML = '';
  // 머리: 종류 고르기와 닫기
  const pickType = h('select', { style: 'flex:1;min-width:0;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;font:12px var(--font)', 'aria-label': '객체 종류' }) as HTMLSelectElement;
  if (types.size > 1) pickType.append(h('option', { value: '' }, `전체 (${all.length})`));
  for (const [t, l] of types) pickType.append(h('option', { value: t }, `${typeName(l[0]!)} (${l.length})`));
  pickType.value = s.type ?? '';
  pickType.addEventListener('change', () => {
    s.type = pickType.value || null;
    render(app, s, handles);
  });
  const close = h('button', { class: 'icon-btn', title: '닫기', 'aria-label': '빠른 특성 닫기', style: 'padding:0 6px' }, '×');
  close.addEventListener('click', () => {
    s.dismissed = s.key;
    s.pinned = null;
    hide(s);
  });
  el.append(h('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px' }, pickType, close));
  const grid = h('div', { style: 'display:grid;grid-template-columns:88px 1fr;gap:4px 6px;align-items:center' });
  for (const f of quickFields(s.type)) {
    if (s.type && f.kind === 'multiline' && list.length > 1) continue;
    grid.append(h('span', { style: 'color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: f.label }, f.label), fieldInput(app, s, handles, list, f));
  }
  el.append(grid);
  if (!s.el) {
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    el.addEventListener('wheel', (ev) => ev.stopPropagation());
    app.view.el.append(el);
    s.el = el;
  }
  place(app, s, handles);
}

/** 선택·화면이 바뀌었을 때 창을 맞춘다. force면 같은 선택이라도 다시 그린다 */
export function sync(app: App, force = false): void {
  const s = stateOf(app);
  const st = app.active;
  const key = selectionKey(app);
  if (!st || !key || app.busyCommand) {
    if (!key) s.pinned = null;
    if (!key) s.dismissed = null;
    hide(s);
    return;
  }
  const mode = qpMode();
  const handles = [...st.selection];
  const show = s.pinned === key || (s.dismissed !== key && (mode === 1 || (mode === 2 && handles.some((x) => geometryFields(st.doc.entityIndex.get(x)?.type ?? '').length > 0))));
  if (!show) {
    hide(s);
    return;
  }
  if (force || key !== s.key || !s.el) {
    if (key !== s.key) s.type = null;
    s.key = key;
    render(app, s, handles);
  } else place(app, s, handles);
}

/** 고른 객체에 빠른 특성 창을 띄운다(QUICKPROPERTIES) */
export function showQuickProperties(app: App): void {
  const s = stateOf(app);
  const key = selectionKey(app);
  if (!key) return;
  s.pinned = key;
  s.dismissed = null;
  s.key = '';
  // 명령이 끝난 뒤에 그린다(명령 중에는 숨긴다)
  queueMicrotask(() => setTimeout(() => sync(app, true), 0));
}

/** 앱의 선택 갱신에 빠른 특성 창을 잇는다(한 번만) */
export function attachQuickProperties(app: App): void {
  const s = stateOf(app);
  if (s.attached) return;
  s.attached = true;
  const orig = app.refreshSelectionOverlay.bind(app);
  app.refreshSelectionOverlay = () => {
    orig();
    try {
      sync(app);
    } catch {
      /* 빠른 특성 창 오류가 선택 표시를 막지 않게 */
    }
  };
}
