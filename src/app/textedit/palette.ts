/**
 * 팔레트 조각: 찾기 및 대치(FIND) 탭, 표 셀 문자 편집 묶음(특성 탭).
 */
import { tableKey } from '../../core/model';
import { isEditableTable, tableFromEntity } from '../../edit/table/entity';
import { getText, mergeAt, setText } from '../../edit/table/model';
import type { App } from '../app';
import { zoomToHandles } from '../commands';
import { commitTable, editTableAt } from '../tablecmds';
import { h } from '../ui/dom';
import { FIND_KINDS, type FindKind, type FindQuery, type FindScope, type FindTarget, findTargets, replaceTargets } from './findreplace';

export interface FindPanelState {
  query: string;
  replace: string;
  matchCase: boolean;
  wholeWord: boolean;
  scope: FindScope;
  kinds: Set<FindKind>;
  /** 결과에서 고른 줄 */
  picked: number;
  /** 결과를 보일지(찾기를 눌렀거나 대치한 뒤) */
  shown: boolean;
}

export function newFindState(): FindPanelState {
  return { query: '', replace: '', matchCase: false, wholeWord: false, scope: 'all', kinds: new Set(FIND_KINDS.map((k) => k.key)), picked: -1, shown: false };
}

const SCOPES: { value: FindScope; label: string }[] = [
  { value: 'all', label: '전체 도면' },
  { value: 'space', label: '현재 공간/배치' },
  { value: 'selection', label: '선택된 객체' },
];

/** 찾기 및 대치 탭 */
export function findPanel(app: App, s: FindPanelState): HTMLElement {
  const q = (): FindQuery => ({ query: s.query, matchCase: s.matchCase, wholeWord: s.wholeWord, scope: s.scope, kinds: s.kinds });
  const find = h('input', { class: 'search', placeholder: '찾을 문자 (Enter)', 'aria-label': '찾을 문자', 'data-field': 'find-query' }) as HTMLInputElement;
  find.value = s.query;
  const rep = h('input', { class: 'search', placeholder: '대치할 문자', 'aria-label': '대치할 문자', style: 'margin-top:4px', 'data-field': 'find-replace' }) as HTMLInputElement;
  rep.value = s.replace;
  const scope = h('select', { 'aria-label': '찾을 위치', style: 'height:26px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px' }, ...SCOPES.map((o) => h('option', { value: o.value }, o.label))) as HTMLSelectElement;
  scope.value = s.scope;
  const check = (label: string, on: boolean, set: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox', 'aria-label': label }) as HTMLInputElement;
    c.checked = on;
    c.addEventListener('change', () => {
      set(c.checked);
      if (s.shown) run();
    });
    return h('label', { style: 'display:inline-flex;gap:4px;align-items:center;margin-right:10px' }, c, label);
  };
  const results = h('div', { style: 'margin-top:6px' });
  const btnFind = h('button', { class: 'btn', type: 'button' }, '찾기');
  const btnRep = h('button', { class: 'btn', type: 'button' }, '대치');
  const btnAll = h('button', { class: 'btn', type: 'button' }, '모두 대치');
  let found: FindTarget[] = [];
  const sync = () => {
    s.query = find.value;
    s.replace = rep.value;
    s.scope = scope.value as FindScope;
    const on = !!s.query;
    btnRep.toggleAttribute('disabled', !on);
    btnAll.toggleAttribute('disabled', !on);
    btnFind.toggleAttribute('disabled', !on);
  };
  const show = (note?: string) => {
    results.replaceChildren();
    if (note) results.append(h('div', { style: 'margin:4px 0;color:var(--text-dim)' }, note));
    if (!s.query) return;
    if (!found.length) {
      results.append(h('div', { class: 'empty' }, '찾은 문자가 없습니다.'));
      return;
    }
    const total = found.reduce((a, t) => a + t.count, 0);
    results.append(h('div', { style: 'margin:4px 0;color:var(--text-dim)' }, `객체 ${found.length}개에서 ${total}개를 찾았습니다.`));
    const tbody = h('tbody');
    found.forEach((t, i) => {
      const tr = h(
        'tr',
        { class: `clickable ${i === s.picked ? 'selected' : ''}`, title: '눌러서 이동' },
        h('td', { style: 'color:var(--text-dim);white-space:nowrap' }, t.label),
        h('td', { style: 'white-space:normal' }, t.preview.slice(0, 200), t.field ? h('span', { class: 'chip', title: '필드가 있는 문자는 대치하지 않습니다' }, '필드') : null, t.locked ? h('span', { class: 'chip', title: '잠긴 도면층' }, '잠김') : null),
        h('td', { style: 'text-align:right;color:var(--text-faint)' }, String(t.count)),
      );
      tr.addEventListener('click', () => {
        s.picked = i;
        for (const x of tbody.querySelectorAll('tr')) x.classList.remove('selected');
        tr.classList.add('selected');
        app.setSelection([t.handle]);
        zoomToHandles(app, [t.handle]);
      });
      tbody.append(tr);
    });
    results.append(h('table', { class: 'grid' }, tbody));
  };
  const run = (note?: string) => {
    sync();
    s.shown = true;
    found = s.query ? findTargets(app, q()) : [];
    if (s.picked >= found.length) s.picked = -1;
    show(note);
  };
  const summary = (r: ReturnType<typeof replaceTargets>): string => {
    const parts = [`${r.replaced}개를 대치했습니다.`];
    if (r.skippedField) parts.push(`필드가 있는 문자 ${r.skippedField}개는 바꾸지 않았습니다(바꾸면 필드가 사라집니다).`);
    if (r.skippedLocked) parts.push(`잠긴 도면층의 객체 ${r.skippedLocked}개는 바꾸지 않았습니다.`);
    return parts.join(' ');
  };
  const replace = (all: boolean) => {
    sync();
    if (!s.query || !app.active) return;
    found = findTargets(app, q());
    if (!found.length) return show();
    const list = all ? found : [found[s.picked >= 0 && s.picked < found.length ? s.picked : 0]!];
    const r = replaceTargets(app, list, q(), s.replace);
    const note = summary(r);
    app.cmd.print(note);
    run(note);
  };
  find.addEventListener('input', sync);
  rep.addEventListener('input', sync);
  scope.addEventListener('change', () => {
    sync();
    if (s.shown) run();
  });
  find.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if ((ev as KeyboardEvent).key === 'Enter') run();
  });
  rep.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if ((ev as KeyboardEvent).key === 'Enter') replace(false);
  });
  btnFind.addEventListener('click', () => run());
  btnRep.addEventListener('click', () => replace(false));
  btnAll.addEventListener('click', () => replace(true));
  const kinds = h(
    'div',
    { style: 'margin-top:6px' },
    h('div', { style: 'color:var(--text-dim);margin-bottom:2px' }, '찾을 객체'),
    ...FIND_KINDS.map((k) =>
      check(k.label, s.kinds.has(k.key), (v) => {
        if (v) s.kinds.add(k.key);
        else s.kinds.delete(k.key);
      }),
    ),
  );
  const el = h(
    'div',
    { class: 'find-panel' },
    find,
    rep,
    h('div', { style: 'display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap' }, h('span', { style: 'color:var(--text-dim)' }, '찾을 위치'), scope),
    h('div', { style: 'margin-top:6px' }, check('대소문자 일치', s.matchCase, (v) => (s.matchCase = v)), check('전체 단어만 찾기', s.wholeWord, (v) => (s.wholeWord = v))),
    kinds,
    h('div', { style: 'display:flex;gap:6px;margin-top:8px' }, btnFind, btnRep, btnAll),
    results,
  );
  sync();
  if (s.shown && s.query) run();
  return el;
}

const colName = (c: number): string => {
  let out = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** 표 하나를 골랐을 때: 셀을 골라 문자를 고치는 묶음(특성 탭) */
export function tableCellGroup(app: App, handle: string): HTMLElement | null {
  const st = app.active;
  const e = st?.doc.entityIndex.get(handle);
  if (!st || !isEditableTable(e)) return null;
  const rt = tableFromEntity(e, st.doc);
  if (!rt) return null;
  const data = rt.data;
  const sel = h('select', { 'aria-label': '셀', 'data-field': 'pf-셀' }) as HTMLSelectElement;
  for (let r = 0; r < data.rows; r++)
    for (let c = 0; c < data.cols; c++) {
      const m = mergeAt(data, r, c);
      if (m && (m.row !== r || m.col !== c)) continue;
      const t = getText(data, r, c).replace(/\\P/g, ' ');
      sel.append(h('option', { value: `${r},${c}` }, `${colName(c)}${r + 1}${t ? `: ${t.slice(0, 24)}` : ''}`));
    }
  const key = `opencad.tablecell.${handle}`;
  let cur = '0,0';
  try {
    cur = sessionStorage.getItem(key) ?? '0,0';
  } catch {
    /* 저장소 없음 */
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  const ta = h('textarea', { rows: 3, 'aria-label': '셀 문자', 'data-field': 'pf-셀 문자' }) as HTMLTextAreaElement;
  const load = () => {
    const [r, c] = sel.value.split(',').map(Number);
    ta.value = getText(data, r!, c!).replace(/\\P/g, '\n');
    ta.disabled = ta.value.startsWith('=');
    ta.title = ta.disabled ? '수식 셀은 표 편집(TABLEDIT)으로 고치십시오.' : '';
  };
  sel.addEventListener('change', () => {
    try {
      sessionStorage.setItem(key, sel.value);
    } catch {
      /* 저장소 없음 */
    }
    load();
  });
  ta.addEventListener('keydown', (ev) => ev.stopPropagation());
  ta.addEventListener('change', () => {
    const [r, c] = sel.value.split(',').map(Number);
    const text = ta.value.replace(/\r?\n/g, '\\P');
    if (text === getText(data, r!, c!)) return;
    if (st.doc.layers.get(tableKey(e.layer))?.locked) {
      app.cmd.print('객체가 잠긴 도면층에 있습니다.', 'err');
      return;
    }
    commitTable(app, { entity: e, space: st.session.ownerOf(handle) ?? st.space, style: rt.style, styleHandle: rt.styleEntry?.handle }, setText(data, r!, c!, text), 'TABLEDIT');
  });
  load();
  const edit = h('button', { class: 'btn', type: 'button' }, '셀 편집...');
  edit.addEventListener('click', () => void editTableAt(app, handle, null));
  return h(
    'div',
    { class: 'prop-group' },
    h('h4', {}, '셀'),
    h('label', { class: 'prop-row edit' }, h('span', { class: 'k' }, '셀'), sel),
    h('label', { class: 'prop-row edit' }, h('span', { class: 'k' }, '내용'), ta),
    h('div', { style: 'display:flex;justify-content:flex-end;padding:4px 0' }, edit),
  );
}
