/**
 * 도면층 상태 관리자(LAYERSTATE) 대화상자와 그 하위 대화상자:
 * - 관리자: 상태 목록(이름·공간·동일·저장 위치·설명), 새로 만들기·업데이트·편집·이름 바꾸기·삭제·가져오기·내보내기,
 *   외부 참조 상태 나열 안 함, 상태에서 찾을 수 없는 도면층 끄기, 뷰포트 재지정으로 특성 적용, 복원할 도면층 특성, 복원·닫기.
 * - 저장할 새 도면층 상태(이름·설명), 도면층 상태 편집(상태 안 도면층의 저장 값, 도면층 추가·제거), 가져올 상태 고르기.
 * 대화상자 안의 변경은 명령 하나(명령 취소 한 단계)로 묶는다.
 */
import { aciToRgb, rgbToCss } from '../core/color';
import type { CadColor } from '../core/model';
import { tableKey } from '../core/model';
import { lineweightText } from '../edit/layercmd';
import { colorLabel } from '../edit/layertools/standards';
import {
  LSF_FROZEN,
  LSF_LOCKED,
  LSF_NEWVP,
  LSF_OFF,
  LSF_PLOT,
  LSF_VPFROZEN,
  LSM_ALL,
  LSM_CURVP,
  LSM_PLOTSTYLE,
  RESTORE_PROPS,
  type LayerState,
  type LayerStateLayer,
  layerStateNameProblem,
} from '../edit/layerstate/record';
import { layerStateEntry, namedPlotStyles, plotStyleNameMap, stateMatches, xrefOfState } from '../edit/layerstate/store';
import type { App, CommandContext } from './app';
import {
  type ImportSource,
  currentViewport,
  deleteLayerState,
  exportLayerState,
  importLayerStates,
  layerStateOptions,
  pickImportSource,
  putLayerState,
  renameLayerState,
  restoreLayerState,
  saveLayerState,
  setLayerStateMask,
  setLayerStateOptions,
  stateByName,
  updateLayerState,
  visibleStates,
} from './layerstate-core';
import { type ListItem, PickList, ensureLtStyle, guardKeys, wideDialog } from './layertools-ui';
import { LINEWEIGHTS } from './propedit';
import { ask, form, h } from './ui/dom';
import { pickColor } from './ui/colorpick';

const STYLE = `
.lst-main{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:start}
.lst-side{display:flex;flex-direction:column;gap:6px;min-width:150px}
.lst-side .ltx-btn{text-align:left}
.lst-props{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(6,auto);grid-auto-flow:column;gap:2px 14px;margin-top:4px}
.lst-sec{border:1px solid var(--border-soft);border-radius:4px;padding:6px 10px 8px;margin-top:8px}
.lst-sec legend{padding:0 4px;color:var(--text-dim);font-size:12px}
.lst-edit td.tog{cursor:pointer;text-align:center}
.lst-edit td.tog:hover{background:var(--bg-hover)}
.lst-edit select,.lst-edit input{background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;font:inherit;font-size:12px;padding:1px 3px}
.lst-edit input.num{width:46px}
.lst-sw{display:inline-block;width:10px;height:10px;border:1px solid rgba(0,0,0,.4);border-radius:2px;margin-right:5px;vertical-align:-1px}
.lst-dim{color:var(--text-faint)}
`;

function ensureStyle(): void {
  ensureLtStyle();
  if (document.getElementById('lst-style')) return;
  const s = document.createElement('style');
  s.id = 'lst-style';
  s.textContent = STYLE;
  document.head.append(s);
}

function swatch(c: CadColor): HTMLSpanElement {
  const rgb = c.rgb !== undefined ? c.rgb : aciToRgb(Math.abs(c.aci) || 7, true);
  return h('span', { class: 'lst-sw', style: `background:${rgbToCss(rgb)}` });
}

function check(label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false, title?: string): { el: HTMLLabelElement; box: HTMLInputElement } {
  const box = h('input', { type: 'checkbox', disabled }) as HTMLInputElement;
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  return { el: h('label', { class: 'ltx-check', title }, box, label), box };
}

function btn(label: string, run: () => void): HTMLButtonElement {
  return h('button', { class: 'ltx-btn', type: 'button', onclick: run }, label);
}

/** 쓸 수 있는 새 상태 이름 */
function defaultName(app: App): string {
  for (let i = 1; ; i++) {
    const n = `도면층 상태${i}`;
    if (!stateByName(app, n)) return n;
  }
}

// ---------------------------------------------------------------------------
// 저장할 새 도면층 상태
// ---------------------------------------------------------------------------

/** 새 상태 이름·설명을 묻고 저장한다. 저장한 이름(취소하면 null) */
export async function newLayerStateDialog(app: App, group?: number): Promise<string | null> {
  for (;;) {
    const v = await form(
      '저장할 새 도면층 상태',
      [
        { key: 'name', label: '새 도면층 상태 이름(N)', type: 'text', value: defaultName(app) },
        { key: 'desc', label: '설명(D)', type: 'textarea', value: '' },
      ],
      { ok: '확인', validate: (x) => layerStateNameProblem(String(x.name)) },
    );
    if (!v) return null;
    const name = String(v.name).trim();
    const old = stateByName(app, name);
    if (old) {
      const a = await ask('도면층 상태', `도면층 상태 "${old.key}"이(가) 이미 있습니다. 덮어쓰시겠습니까?`, [
        { label: '예(Y)', value: 'yes', primary: true },
        { label: '아니오(N)', value: 'no' },
      ]);
      if (a !== 'yes') continue;
    }
    saveLayerState(app, name, String(v.desc).replace(/\r?\n/g, ' ').trim(), group, old ? old.state.mask : LSM_ALL);
    return name;
  }
}

// ---------------------------------------------------------------------------
// 도면층 상태 편집
// ---------------------------------------------------------------------------

/** 상태 안 도면층 값을 고친다. 고친 상태(취소하면 null) */
export async function editLayerStateDialog(app: App, state: LayerState): Promise<LayerState | null> {
  ensureStyle();
  const st = app.active!;
  const doc = st.doc;
  const s: LayerState = structuredClone(state);
  const named = namedPlotStyles(doc);
  const psNames = [...plotStyleNameMap(doc).values()];
  const lts = ['Continuous', ...[...doc.linetypes.values()].map((l) => l.name).filter((n) => !/^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(n))];
  const selected = new Set<LayerStateLayer>();
  const table = h('table', { class: 'ltx-table lst-edit' });
  const box = h('div', { class: 'ltx-list', style: 'max-height:340px;min-height:200px' }, table);
  const info = h('div', { class: 'ltx-note' });

  const toggle = (l: LayerStateLayer, bit: number, label: [string, string]) => {
    const td = h('td', { class: 'tog', title: '눌러서 바꾸기' }, l.flags & bit ? label[0] : label[1]);
    td.addEventListener('click', () => {
      l.flags ^= bit;
      render();
    });
    return td;
  };

  const render = () => {
    const cols = ['이름', '켜기', '동결', ...(s.paperSpace ? ['VP 동결'] : []), '잠금', '플롯', '새 VP 동결', '색상', '선종류', '선가중치', '투명도', '플롯 스타일'];
    const head = h('tr', {}, ...cols.map((c) => h('th', {}, c)));
    const rows = s.layers
      .filter((l) => l.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      .map((l) => {
        const nameTd = h('td', { style: 'cursor:default' }, l.name);
        const tr = h('tr', { class: selected.has(l) ? 'sel' : '' });
        nameTd.addEventListener('click', (ev) => {
          if (!(ev.ctrlKey || ev.metaKey)) selected.clear();
          if (selected.has(l)) selected.delete(l);
          else selected.add(l);
          render();
        });
        const onTd = h('td', { class: 'tog', title: '눌러서 바꾸기' }, l.flags & LSF_OFF ? '끄기' : '켜기');
        onTd.addEventListener('click', () => {
          l.flags ^= LSF_OFF;
          render();
        });
        const colorTd = h('td', { class: 'tog', title: '눌러서 색 고르기' }, swatch(l.color), colorLabel(l.color));
        colorTd.addEventListener('click', async () => {
          const c = await pickColor(l.color, { allowBy: false });
          if (c && c.aci !== 0 && c.aci !== 256) {
            l.color = { ...c };
            render();
          }
        });
        const ltSel = h('select', { 'aria-label': `${l.name} 선종류` }, ...[...new Set([...lts, l.linetype])].map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
        ltSel.value = l.linetype;
        ltSel.addEventListener('change', () => (l.linetype = ltSel.value));
        const lwSel = h('select', { 'aria-label': `${l.name} 선가중치` }, h('option', { value: '-3' }, '기본값'), ...LINEWEIGHTS.map((w) => h('option', { value: String(w) }, lineweightText(w)))) as HTMLSelectElement;
        lwSel.value = String(l.lineweight);
        lwSel.addEventListener('change', () => (l.lineweight = Number(lwSel.value)));
        const tr0 = h('input', { class: 'num', type: 'text', inputmode: 'numeric', 'aria-label': `${l.name} 투명도` }) as HTMLInputElement;
        tr0.value = String(Math.round((1 - l.transparency / 255) * 100));
        guardKeys(tr0);
        tr0.addEventListener('change', () => {
          const v = Number(tr0.value);
          if (Number.isFinite(v) && v >= 0 && v <= 90) l.transparency = Math.round(255 * (1 - v / 100));
          else tr0.value = String(Math.round((1 - l.transparency / 255) * 100));
        });
        let psTd: HTMLTableCellElement;
        if (named) {
          const ps = h('select', { 'aria-label': `${l.name} 플롯 스타일` }, ...[...new Set([...psNames, l.plotStyle].filter(Boolean))].map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
          ps.value = l.plotStyle;
          ps.addEventListener('change', () => (l.plotStyle = ps.value));
          psTd = h('td', {}, ps);
        } else psTd = h('td', { class: 'lst-dim', title: '색상 종속 플롯 스타일 도면' }, l.plotStyle || '');
        tr.append(
          nameTd,
          onTd,
          toggle(l, LSF_FROZEN, ['동결', '-']),
          ...(s.paperSpace ? [toggle(l, LSF_VPFROZEN, ['동결', '-'])] : []),
          toggle(l, LSF_LOCKED, ['잠금', '-']),
          toggle(l, LSF_PLOT, ['플롯', '안 함']),
          toggle(l, LSF_NEWVP, ['동결', '-']),
          colorTd,
          h('td', {}, ltSel),
          h('td', {}, lwSel),
          h('td', {}, tr0),
          psTd,
        );
        return tr;
      });
    table.replaceChildren(head, ...rows);
    const missing = s.layers.filter((l) => !l.name).length;
    info.textContent = `도면층 ${s.layers.length - missing}개${missing ? ` (지워진 도면층 ${missing}개는 그대로 둡니다)` : ''}. 이름을 눌러 고르고(Ctrl로 여러 개), 값 칸을 눌러 바꿉니다.`;
  };

  const add = async () => {
    const have = new Set(s.layers.map((l) => tableKey(l.name)));
    const list = new PickList('추가할 도면층');
    list.setItems(
      [...doc.layers.values()]
        .filter((l) => !have.has(tableKey(l.name)))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
        .map((l): ListItem => ({ key: tableKey(l.name), label: l.name })),
    );
    if (!list.keys.length) {
      info.textContent = '상태에 넣을 수 있는 도면층이 없습니다(모든 도면층이 이미 들어 있습니다).';
      return;
    }
    const d = wideDialog('도면층 선택', h('div', { class: 'ltx-col' }, h('div', { class: 'ltx-note' }, '상태에 추가할 도면층을 고르십시오.'), list.el), [
      { label: '확인', value: 'ok', primary: true },
      { label: '취소', value: 'cancel' },
    ], 360);
    if ((await d.closed) !== 'ok') return;
    for (const k of list.selection()) {
      const L = doc.layers.get(k);
      if (L) s.layers.push(layerStateEntry(doc, L));
    }
    render();
  };
  const remove = () => {
    if (!selected.size) {
      info.textContent = '제거할 도면층을 먼저 고르십시오.';
      return;
    }
    s.layers = s.layers.filter((l) => !selected.has(l));
    selected.clear();
    render();
  };

  render();
  const body = h(
    'div',
    { class: 'ltx-col' },
    h('div', { class: 'ltx-row' }, btn('도면층 상태에 도면층 추가(+)', () => void add()), btn('도면층 상태에서 도면층 제거(-)', remove)),
    box,
    info,
  );
  const d = wideDialog(`도면층 상태 편집 - ${state.name}`, body, [
    { label: '확인', value: 'ok', primary: true },
    { label: '취소', value: 'cancel' },
  ], 980);
  return (await d.closed) === 'ok' ? s : null;
}

// ---------------------------------------------------------------------------
// 가져올 상태 고르기(다른 도면)
// ---------------------------------------------------------------------------

async function pickStates(src: ImportSource): Promise<LayerState[] | null> {
  const list = new PickList('도면층 상태');
  list.setItems(src.states.map((s, i): ListItem => ({ key: String(i), label: s.name, tag: s.description, title: s.description || s.name })));
  list.setSelection(list.keys, false);
  const d = wideDialog(
    '도면층 상태 선택',
    h('div', { class: 'ltx-col' }, h('div', { class: 'ltx-note' }, `${src.file}에서 가져올 도면층 상태를 고르십시오.`), list.el),
    [
      { label: '확인', value: 'ok', primary: true },
      { label: '취소', value: 'cancel' },
    ],
    420,
  );
  if ((await d.closed) !== 'ok') return null;
  return list.selection().map((k) => src.states[Number(k)]!);
}

// ---------------------------------------------------------------------------
// 도면층 상태 관리자
// ---------------------------------------------------------------------------

export async function openLayerStateManager(app: App, ctx: CommandContext): Promise<void> {
  ensureStyle();
  const st = app.active!;
  const group = ctx.group;
  const opts = layerStateOptions();
  let selected: string | null = null;

  const table = h('table', { class: 'ltx-table' });
  const listBox = h('div', { class: 'ltx-list', style: 'min-height:200px;max-height:280px' }, table);
  const note = h('div', { class: 'ltx-note' });

  const xrefBox = check('외부 참조에 도면층 상태 나열 안 함(F)', opts.hideXref, (v) => {
    setLayerStateOptions({ hideXref: v });
    refresh();
  });
  const offBox = check('상태에서 찾을 수 없는 도면층 끄기(T)', opts.offMissing, (v) => setLayerStateOptions({ offMissing: v }));
  const vpOver = check(
    '뷰포트 재지정으로 특성 적용(W)',
    opts.asOverrides && !!st.msVp,
    (v) => {
      setLayerStateOptions({ asOverrides: v });
      if (v) note.textContent = '이 웹 버전은 뷰포트 재지정을 지원하지 않습니다. 이 옵션으로 복원하면 색상·선종류·선가중치·투명도·플롯 스타일은 건너뛰고 나머지 특성만 복원합니다.';
    },
    !st.msVp,
    st.msVp ? undefined : '배치의 뷰포트 안(MSPACE)에서만 고를 수 있습니다.',
  );

  // 복원할 도면층 특성
  const propBoxes = RESTORE_PROPS.map((p) => {
    const disabled = p.bit === LSM_PLOTSTYLE && !namedPlotStyles(st.doc);
    const c = check(
      p.label,
      false,
      () => {
        if (!selected) return;
        let m = 0;
        for (const x of propBoxes) if (x.c.box.checked) m |= x.bit;
        const s = stateByName(app, selected);
        if (s) setLayerStateMask(app, selected, (s.state.mask & ~LSM_ALL) | m, group);
        refresh();
      },
      disabled,
      disabled ? '색상 종속 플롯 스타일 도면에서는 플롯 스타일을 복원하지 않습니다.' : p.bit === LSM_CURVP ? '배치에서 저장한 상태를 배치 탭에서 복원할 때 현재 뷰포트의 VP 동결을 복원합니다.' : undefined,
    );
    return { bit: p.bit, c };
  });
  const setAll = (on: boolean) => {
    if (!selected) return;
    const s = stateByName(app, selected);
    if (!s) return;
    let m = 0;
    if (on) for (const x of propBoxes) if (!x.c.box.disabled) m |= x.bit;
    setLayerStateMask(app, selected, (s.state.mask & ~LSM_ALL) | m, group);
    refresh();
  };

  const sideButtons: Record<string, HTMLButtonElement> = {};
  let footerRestore: HTMLButtonElement | undefined;
  const side = h('div', { class: 'lst-side' });
  const addSide = (key: string, label: string, run: () => void | Promise<void>) => {
    const b = btn(label, () => void run());
    sideButtons[key] = b;
    side.append(b);
  };

  let states = visibleStates(st.doc);
  const rowOf = new Map<string, HTMLTableRowElement>();
  /** 목록 다시 만들기(상태가 바뀐 뒤) */
  const refresh = () => {
    states = visibleStates(st.doc);
    if (selected && !states.some((s) => s.key === selected)) selected = null;
    const cv = currentViewport(st);
    const head = h('tr', {}, ...['이름', '공간', '동일', '저장 위치', '설명'].map((c) => h('th', {}, c)));
    rowOf.clear();
    const rows = states.map((s) => {
      const xr = xrefOfState(s.key);
      const same = stateMatches(st.doc, s.state, cv ? cv.vp.frozenLayers : null);
      const tr = h(
        'tr',
        { title: s.state.description || s.key },
        h('td', {}, s.key),
        h('td', {}, s.state.paperSpace ? '배치' : '모형'),
        h('td', { style: 'text-align:center' }, same ? '예' : ''),
        h('td', {}, xr ? `외부 참조: ${xr}` : '도면'),
        h('td', {}, s.state.description),
      );
      // 고르기는 줄을 다시 만들지 않는다(두 번 누르기 = 이름 바꾸기가 같은 줄에서 일어나게)
      tr.addEventListener('mousedown', () => {
        selected = s.key;
        showSelection();
      });
      tr.addEventListener('dblclick', () => void renameSel());
      rowOf.set(s.key, tr);
      return tr;
    });
    table.replaceChildren(head, ...rows);
    if (!states.length) table.append(h('tr', {}, h('td', { colspan: 5, class: 'lst-dim' }, '저장된 도면층 상태가 없습니다.')));
    showSelection();
  };
  /** 고른 상태에 맞춰 강조·단추·복원할 특성 */
  const showSelection = () => {
    for (const [k, tr] of rowOf) tr.classList.toggle('sel', k === selected);
    const sel = selected ? states.find((s) => s.key === selected) : undefined;
    const xref = !!(sel && xrefOfState(sel.key));
    for (const k of ['update', 'edit', 'rename', 'delete']) sideButtons[k]!.disabled = !sel || xref;
    sideButtons.export!.disabled = !sel;
    if (footerRestore) footerRestore.disabled = !sel;
    for (const x of propBoxes) {
      x.c.box.checked = !!sel && (sel.state.mask & x.bit) !== 0;
      if (!sel) x.c.box.disabled = true;
      else x.c.box.disabled = x.bit === LSM_PLOTSTYLE && !namedPlotStyles(st.doc);
    }
    if (!sel) note.textContent = states.length ? '상태를 고르십시오.' : '새로 만들기로 지금 도면층 설정을 상태로 저장합니다.';
    else note.textContent = xref ? '외부 참조의 도면층 상태는 복원·내보내기만 할 수 있습니다.' : `${sel.key}: 도면층 ${sel.state.layers.filter((l) => l.name).length}개${sel.state.description ? ` — ${sel.state.description}` : ''}`;
  };

  const renameSel = async () => {
    if (!selected || xrefOfState(selected)) return;
    const old = selected;
    const v = await form('도면층 상태 이름 바꾸기', [{ key: 'name', label: '새 이름', type: 'text', value: old }], {
      ok: '확인',
      validate: (x) => {
        const n = String(x.name).trim();
        const bad = layerStateNameProblem(n);
        if (bad) return bad;
        const dup = stateByName(app, n);
        if (dup && dup.key.toUpperCase() !== old.toUpperCase()) return `도면층 상태 "${n}"이(가) 이미 있습니다.`;
        return null;
      },
    });
    if (!v) return;
    const err = renameLayerState(app, old, String(v.name), group);
    if (err) note.textContent = err;
    else selected = String(v.name).trim();
    refresh();
  };

  addSide('new', '새로 만들기(N)...', async () => {
    const n = await newLayerStateDialog(app, group);
    if (n) selected = stateByName(app, n)?.key ?? null;
    refresh();
  });
  addSide('update', '업데이트(U)', () => {
    if (!selected) return;
    updateLayerState(app, selected, group);
    note.textContent = `도면층 상태 "${selected}"을(를) 지금 도면층 설정으로 업데이트했습니다.`;
    refresh();
  });
  addSide('edit', '편집(I)...', async () => {
    if (!selected) return;
    const s = stateByName(app, selected);
    if (!s) return;
    const edited = await editLayerStateDialog(app, s.state);
    if (edited) putLayerState(app, edited, group);
    refresh();
  });
  addSide('rename', '이름 바꾸기', renameSel);
  addSide('delete', '삭제(D)', async () => {
    if (!selected) return;
    const a = await ask('도면층 상태', `도면층 상태 "${selected}"을(를) 삭제하시겠습니까?`, [
      { label: '예(Y)', value: 'yes', primary: true },
      { label: '아니오(N)', value: 'no' },
    ]);
    if (a !== 'yes') return;
    deleteLayerState(app, selected, group);
    selected = null;
    refresh();
  });
  side.append(h('div', { style: 'height:6px' }));
  addSide('import', '가져오기(M)...', async () => {
    const src = await pickImportSource(app, ctx.print);
    if (!src) return;
    if (!src.states.length) {
      note.textContent = `${src.file}에 가져올 도면층 상태가 없습니다.`;
      return;
    }
    const chosen = src.source ? await pickStates(src) : src.states;
    if (!chosen || !chosen.length) return;
    const yes = new Set<string>();
    for (const s of chosen) {
      const old = stateByName(app, s.name);
      if (!old) continue;
      const a = await ask('도면층 상태', `도면층 상태 "${old.key}"이(가) 이미 있습니다. 덮어쓰시겠습니까?`, [
        { label: '예(Y)', value: 'yes', primary: true },
        { label: '아니오(N)', value: 'no' },
      ]);
      if (a === 'yes') yes.add(s.name.toUpperCase());
    }
    const got = importLayerStates(app, ctx.print, src, chosen, (n) => yes.has(n.toUpperCase()), group);
    refresh();
    if (!got.length) {
      note.textContent = '가져온 도면층 상태가 없습니다.';
      return;
    }
    selected = stateByName(app, got[got.length - 1]!)?.key ?? null;
    refresh();
    note.textContent = `도면층 상태 ${got.length}개를 가져왔습니다: ${got.join(', ')}`;
    if (got.length === 1) {
      const a = await ask('도면층 상태', `도면층 상태 "${got[0]}"을(를) 가져왔습니다. 지금 복원하시겠습니까?`, [
        { label: '예(Y)', value: 'yes', primary: true },
        { label: '아니오(N)', value: 'no' },
      ]);
      if (a === 'yes') {
        const s = stateByName(app, got[0]!);
        if (s) restoreLayerState(app, ctx.print, s.state, { group });
        refresh();
      }
    }
  });
  addSide('export', '내보내기(X)...', () => {
    if (!selected) return;
    const f = exportLayerState(app, selected);
    if (f) note.textContent = `${f}을(를) 내려받았습니다.`;
  });

  const props = h(
    'fieldset',
    { class: 'lst-sec' },
    h('legend', {}, '복원할 도면층 특성'),
    h('div', { class: 'lst-props' }, ...propBoxes.map((x) => x.c.el)),
    h('div', { class: 'ltx-row', style: 'margin-top:6px' }, btn('모두 선택(S)', () => setAll(true)), btn('모두 지우기(A)', () => setAll(false))),
  );
  const body = h(
    'div',
    { class: 'ltx-col' },
    h('div', { class: 'ltx-h' }, '도면층 상태(E)'),
    h('div', { class: 'lst-main' }, listBox, side),
    xrefBox.el,
    h('div', { class: 'ltx-row', style: 'gap:18px' }, offBox.el, vpOver.el),
    props,
    note,
  );
  refresh();
  const d = wideDialog(
    '도면층 상태 관리자',
    body,
    [
      { label: '복원(R)', value: 'restore', primary: true, keep: () => !selected },
      { label: '닫기(C)', value: 'close' },
    ],
    860,
  );
  // 복원 단추는 상태를 골랐을 때만
  footerRestore = [...d.box.querySelectorAll('footer button')].find((b) => b.textContent === '복원(R)') as HTMLButtonElement | undefined;
  refresh();
  const r = await d.closed;
  if (r === 'restore' && selected) {
    const s = stateByName(app, selected);
    if (s) restoreLayerState(app, ctx.print, s.state, { group });
  }
}
