/**
 * 도면층 필터 화면(AutoCAD 도면층 특성 관리자의 필터 동작과 문구를 따른다):
 * - 도면층 팔레트의 필터 트리(모두·사용된 모든 도면층·외부 참조·사용자 필터, 중첩), 필터 반전 확인란, 상태 줄
 *   "모두: n개 도면층 중 m개 표시", 도면층 행 끌어 놓기(그룹 필터에 넣기), 필터 오른쪽 클릭 메뉴.
 * - 도면층 필터 특성 대화상자(필터 이름, 필터 정의 행, 필터 미리보기), 그룹 필터 대화상자(도면층 추가·제거·끌어 놓기·도면에서 선택),
 *   FILTERS(도면층 필터 삭제) 대화상자.
 * 화면의 변경은 모두 도면에 바로 쓰고 명령 취소할 수 있다.
 * 필터는 AutoCAD 형식으로 저장한다(AutoCAD에서도 보인다). AutoCAD 형식으로 쓸 수 없는 조건의 필터는 이 앱 기록으로 저장하고
 * 트리에 "앱" 표지를 단다. 이 앱 정의로 바꿀 수 없는 AutoCAD 식은 "식" 표지를 달고 정의를 읽기 전용으로 보인다.
 */
import { aciToRgb, rgbToCss } from '../core/color';
import type { CadColor, Layer } from '../core/model';
import { tableKey } from '../core/model';
import { LINEWEIGHTS, lineweightText, parseLayerColor, parseTrueColor, percentFromOpacity } from '../edit/layercmd';
import { FilterEvaluator, type FilterNode, colorValueText, filterTree, findNode, isUserRef, matchContext, userRef } from '../edit/layerfilter/match';
import { FILTER_COLUMNS, type FilterKind, type FilterRow, type LayerFilter, canConvertToGroup, cleanRow, defaultFilterName, descendantsOf, filterKey, findFilter } from '../edit/layerfilter/model';
import { hasWildcard, wcmatch } from '../edit/util/wildcard';
import { type StoredFilter, listLayerFilters, listStoredFilters } from '../edit/layerfilter/store';
import { unwritableColumns } from '../edit/layerfilter/expr';
import type { App } from './app';
import type { DocState } from './docstate';
import {
  type FilterAction,
  applyFilterAction,
  convertToGroupFilter,
  currentFilterResult,
  deleteLayerFilter,
  deleteLayerFilters,
  editGroupLayers,
  filterStatusText,
  filterView,
  parentForNew,
  pickLayersFromDrawing,
  renameLayerFilter,
  saveLayerFilter,
  setFilterView,
} from './layerfilter-core';
import { PickList, ensureLtStyle, guardKeys, wideDialog } from './layertools-ui';
import { loadPref, savePref } from './util2-ui';
import { pickColor } from './ui/colorpick';
import { type MenuItem, ask, h, showMenu } from './ui/dom';
import { icon } from './ui/icons';

const STYLE = `
.lf-split{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch}
.lf-split>.lf-tree{flex:1 1 150px;max-width:100%}
.lf-split>.lf-list{flex:999 1 300px;min-width:0}
.lf-tree{border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);overflow:auto;max-height:42vh;min-height:64px;padding:2px 0;user-select:none;outline:0}
.lf-tree:focus-visible{border-color:var(--accent)}
.lf-node{display:flex;align-items:center;gap:4px;padding:1px 6px 1px 4px;white-space:nowrap;cursor:default;font-size:12px;line-height:20px}
.lf-node:hover{background:var(--bg-hover)}
.lf-node.sel{background:var(--bg-active);color:#fff}
.lf-node.drop{outline:1px dashed var(--accent);outline-offset:-1px}
.lf-node .tw{width:12px;text-align:center;color:var(--text-faint);flex:none;font-size:10px}
.lf-node.sel .tw{color:#dfe8f5}
.lf-node .ic{width:14px;height:14px;flex:none;display:inline-flex}
.lf-node .lbl{overflow:hidden;text-overflow:ellipsis}
.lf-node .tag{flex:none;font-size:10px;line-height:14px;padding:0 4px;border-radius:7px;border:1px solid var(--border-soft);color:var(--text-faint)}
.lf-node.sel .tag{color:#dfe8f5;border-color:rgba(255,255,255,.35)}
.lf-expr{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;padding:6px 8px;border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);max-height:120px;overflow:auto}
.lf-warn{color:#ffcc80;font-size:12px;min-height:0}
.lf-node input{background:var(--bg-input);color:var(--text);border:1px solid var(--accent);border-radius:2px;font:inherit;padding:0 3px;min-width:80px}
.lf-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-top:6px;color:var(--text-dim);font-size:11.5px}
.lf-foot label{display:flex;align-items:center;gap:5px;cursor:pointer}
.lf-bar-ic{width:26px;height:26px}
.lf-bar-ic.on{background:var(--accent-soft)}
.lf-def{overflow:auto;max-height:230px;border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input)}
.lf-def table{border-collapse:collapse;font-size:12px}
.lf-def th{position:sticky;top:0;background:var(--bg-ribbon-tabs);color:var(--text-dim);font-weight:500;padding:3px 4px;text-align:left;white-space:nowrap;z-index:1}
.lf-def td{padding:1px 2px;border-bottom:1px solid rgba(255,255,255,.04)}
.lf-def select,.lf-def input{background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;font:inherit;font-size:12px;height:22px;padding:0 3px}
.lf-def input.w-name{width:120px}.lf-def input.w-mid{width:96px}.lf-def input.w-num{width:44px}.lf-def input.w-color{width:70px}
.lf-def .colorcell{display:flex;align-items:center;gap:2px}
.lf-def .colorcell .sw{display:inline-block;width:11px;height:11px;border:1px solid rgba(0,0,0,.4);border-radius:2px;flex:none}
.lf-def button.mini{height:22px;min-width:22px;padding:0 4px;border:1px solid var(--border-soft);border-radius:3px;background:var(--bg-ribbon);color:var(--text);cursor:pointer;font:inherit;font-size:11px}
.lf-def button.mini:hover{background:var(--bg-hover)}
.lf-prev{overflow:auto;max-height:220px;border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input)}
.lf-prev table{width:100%}
.lf-prev .sw{display:inline-block;width:10px;height:10px;border:1px solid rgba(0,0,0,.4);border-radius:2px;margin-right:4px;vertical-align:-1px}
.lf-grp{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:8px;align-items:center}
.lf-grp .ltx-list{min-height:220px;max-height:300px}
.lf-grp .mid{display:flex;flex-direction:column;gap:6px}
.lf-grp .ltx-list.drop{outline:1px dashed var(--accent)}
.lf-err{color:#ff8a80;min-height:18px;font-size:12px}
`;

function ensureStyle(): void {
  ensureLtStyle();
  if (document.getElementById('lf-style')) return;
  const s = document.createElement('style');
  s.id = 'lf-style';
  s.textContent = STYLE;
  document.head.append(s);
}

/** 직접 그린 아이콘(24×24, 선 = currentColor) */
const S = (body: string) =>
  `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const IC = {
  funnel: S('<path d="M4 5h16l-6 7v6l-4 2v-8z"/>'),
  funnelNew: S('<path d="M3 5h12l-4.5 5.5V16l-3 1.5v-7z"/><path d="M18 12v8M14 16h8"/>'),
  group: S('<path d="M3 6h6l2 2h10v11H3z"/><path d="M8 12h8M8 15h5"/>'),
  groupNew: S('<path d="M3 17V6h6l2 2h8v3"/><path d="M3 17h9"/><path d="M18 13v8M14 17h8"/>'),
  tree: S('<path d="M5 4v15M5 8h4M5 15h4"/><rect x="10" y="6" width="9" height="4" rx="1"/><rect x="10" y="13" width="9" height="4" rx="1"/>'),
  xref: S('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
};

function nodeIcon(n: FilterNode): string {
  switch (n.kind) {
    case 'property':
      return IC.funnel;
    case 'group':
      return IC.group;
    case 'xref':
    case 'xrefItem':
      return IC.xref;
    default:
      return icon('layers');
  }
}

const MIME = 'application/x-opencad-layers';
const TREE_PREF = 'opencad.layerfilter.tree';

function swatchCss(c: CadColor): string {
  return rgbToCss(c.rgb !== undefined ? c.rgb : aciToRgb(Math.abs(c.aci) || 7, true));
}

function draggedLayers(ev: DragEvent): string[] | null {
  const raw = ev.dataTransfer?.getData(MIME);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

const hasLayerDrag = (ev: DragEvent): boolean => !!ev.dataTransfer && [...ev.dataTransfer.types].includes(MIME);

// ---------------------------------------------------------------------------
// 팔레트의 필터 트리
// ---------------------------------------------------------------------------

export interface LayerFilterPanel {
  /** 보일 도면층 키(필터와 필터 반전을 적용한 것) */
  visible: ReadonlySet<string>;
  /** 도면층 막대에 넣을 단추(새 특성 필터, 새 그룹 필터, 필터 트리 표시) */
  barButtons: HTMLElement[];
  /** 도면층 표를 필터 트리와 나란히 둔다(트리를 숨겼으면 표 그대로) */
  wrap(list: HTMLElement): HTMLElement;
  /** 필터 반전 확인란과 상태 줄 */
  footer(shown: number): HTMLElement;
  /** 도면층 행의 오른쪽 클릭 메뉴에 덧붙일 항목 */
  rowMenu(layerName: string): MenuItem[];
  /** 도면층 행을 끌어 그룹 필터에 놓을 수 있게 */
  draggable(row: HTMLElement, layerName: string): void;
}

const collapsedOf = new WeakMap<DocState, Set<string>>();

export function layerFilterPanel(app: App, refresh: () => void): LayerFilterPanel {
  ensureStyle();
  const st = app.active!;
  const res = currentFilterResult(st);
  const stored = listStoredFilters(st.doc);
  const filters = stored.map((x) => x.filter);
  const info = new Map<string, StoredFilter>(stored.map((x) => [userRef(x.filter.name), x]));
  const showTree = loadPref<boolean>(TREE_PREF, true);
  let collapsed = collapsedOf.get(st);
  if (!collapsed) collapsedOf.set(st, (collapsed = new Set()));
  const select = (ref: string) => {
    setFilterView(st, { ref });
    refresh();
  };

  const tree = (): HTMLElement => {
    const root = filterTree(st.doc, filters);
    const box = h('div', { class: 'lf-tree', role: 'tree', 'aria-label': '도면층 필터', tabindex: 0 });
    const order: string[] = [];
    const add = (n: FilterNode, depth: number) => {
      order.push(n.ref);
      const closed = collapsed!.has(n.ref);
      const tw = h('span', { class: 'tw' }, n.children.length ? (closed ? '▸' : '▾') : '');
      if (n.children.length)
        tw.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (closed) collapsed!.delete(n.ref);
          else collapsed!.add(n.ref);
          refresh();
        });
      const lbl = h('span', { class: 'lbl' }, n.label);
      const sel = n.ref === res.ref;
      const si = info.get(n.ref);
      const tag = si?.readOnly
        ? h('span', { class: 'tag', title: `AutoCAD 필터 식(읽기 전용): ${si.filter.expression ?? ''}` }, '식')
        : si?.format === 'app'
          ? h('span', { class: 'tag', title: '이 앱 기록 — AutoCAD에서는 보이지 않습니다(AutoCAD 형식으로 쓸 수 없는 조건)' }, '앱')
          : null;
      const row = h(
        'div',
        { class: `lf-node${sel ? ' sel' : ''}`, role: 'treeitem', 'aria-selected': sel ? 'true' : 'false', 'aria-expanded': n.children.length ? (closed ? 'false' : 'true') : undefined, style: `padding-left:${4 + depth * 14}px`, title: n.label },
        tw,
        h('span', { class: 'ic', html: nodeIcon(n) }),
        lbl,
        tag,
      );
      row.addEventListener('click', () => {
        if (!sel) select(n.ref);
      });
      row.addEventListener('dblclick', () => {
        if (isUserRef(n.ref)) void editFilter(app, n.label);
      });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (!sel) setFilterView(st, { ref: n.ref });
        filterMenu(app, n, ev.clientX, ev.clientY, () => {
          // 메뉴를 여는 사이 팔레트를 다시 그렸을 수 있다 — 지금 고른 노드의 이름 칸
          const cur = document.querySelector('.lf-tree .lf-node.sel .lbl') as HTMLElement | null;
          if (cur) renameInline(app, cur, n.label, refresh);
        });
        if (!sel) refresh();
      });
      if (n.kind === 'group') {
        row.addEventListener('dragover', (ev) => {
          if (!hasLayerDrag(ev)) return;
          ev.preventDefault();
          ev.dataTransfer!.dropEffect = 'copy';
          row.classList.add('drop');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (ev) => {
          row.classList.remove('drop');
          const names = draggedLayers(ev);
          if (!names) return;
          ev.preventDefault();
          const n2 = editGroupLayers(app, n.label, names, 'add');
          if (n2 > 0) app.cmd.print(`그룹 필터 "${n.label}"에 도면층 ${n2}개를 넣었습니다.`);
        });
      }
      box.append(row);
      if (!closed) for (const c of n.children) add(c, depth + 1);
    };
    add(root, 0);
    box.addEventListener('keydown', (ev) => {
      const i = order.indexOf(res.ref);
      const node = findNode(root, res.ref);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        ev.stopPropagation();
        const j = Math.max(0, Math.min(order.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
        if (j !== i) {
          select(order[j]!);
          (document.querySelector('.lf-tree') as HTMLElement | null)?.focus();
        }
      } else if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && node?.children.length) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'ArrowLeft') collapsed!.add(node.ref);
        else collapsed!.delete(node.ref);
        refresh();
        (document.querySelector('.lf-tree') as HTMLElement | null)?.focus();
      } else if (ev.key === 'F2' && node && isUserRef(node.ref)) {
        ev.preventDefault();
        ev.stopPropagation();
        const lbl = box.querySelector('.lf-node.sel .lbl') as HTMLElement | null;
        if (lbl) renameInline(app, lbl, node.label, refresh);
      } else if (ev.key === 'Delete' && node && isUserRef(node.ref)) {
        ev.preventDefault();
        ev.stopPropagation();
        void confirmDelete(app, node.label);
      }
    });
    return box;
  };

  const barButtons = [
    h('button', { class: 'icon-btn lf-bar-ic', title: '새 특성 필터…', 'aria-label': '새 특성 필터', html: IC.funnelNew, onclick: () => void newFilter(app, 'property') }),
    h('button', { class: 'icon-btn lf-bar-ic', title: '새 그룹 필터…', 'aria-label': '새 그룹 필터', html: IC.groupNew, onclick: () => void newFilter(app, 'group') }),
    h('button', {
      class: `icon-btn lf-bar-ic${showTree ? ' on' : ''}`,
      title: showTree ? '필터 트리 숨기기' : '필터 트리 표시',
      'aria-label': '필터 트리 표시',
      'aria-pressed': showTree ? 'true' : 'false',
      html: IC.tree,
      onclick: () => {
        savePref(TREE_PREF, !showTree);
        refresh();
      },
    }),
  ];

  return {
    visible: res.visible,
    barButtons,
    wrap(list) {
      if (!showTree) return list;
      list.classList.add('lf-list');
      return h('div', { class: 'lf-split' }, tree(), list);
    },
    footer(shown) {
      const box = h('input', { type: 'checkbox', 'aria-label': '필터 반전' }) as HTMLInputElement;
      box.checked = res.invert;
      box.addEventListener('change', () => {
        setFilterView(st, { invert: box.checked });
        refresh();
      });
      return h('div', { class: 'lf-foot' }, h('label', { title: '필터 조건에 맞지 않는 도면층을 보여 줍니다' }, box, '필터 반전(I)'), h('span', { role: 'status' }, filterStatusText(res.label, res.total, shown, res.invert)));
    },
    rowMenu(layerName) {
      const groups = filters.filter((f) => f.kind === 'group');
      const cur = isUserRef(res.ref) ? filters.find((f) => userRef(f.name) === res.ref) : undefined;
      const out: MenuItem[] = [];
      if (cur?.kind === 'group' && !res.invert) {
        out.push({ separator: true }, { label: '그룹 필터에서 제거', run: () => editGroupLayers(app, cur.name, [layerName], 'remove') });
      }
      if (groups.length) {
        out.push({ separator: true }, { heading: '그룹 필터에 추가' });
        for (const g of groups.slice(0, 12)) {
          const has = g.layers.some((n) => tableKey(n) === tableKey(layerName));
          out.push({ label: g.name, disabled: has, run: () => editGroupLayers(app, g.name, [layerName], 'add') });
        }
      }
      return out;
    },
    draggable(row, layerName) {
      row.draggable = true;
      // 칸 안의 입력·고르기 상자에서는 끌지 않는다(글 고르기·목록 열기)
      row.addEventListener('mousedown', (ev) => (row.draggable = !(ev.target as HTMLElement | null)?.closest('input,select,textarea,button')), true);
      row.addEventListener('dragstart', (ev) => {
        if (!ev.dataTransfer) return;
        ev.dataTransfer.setData(MIME, JSON.stringify([layerName]));
        ev.dataTransfer.setData('text/plain', layerName);
        ev.dataTransfer.effectAllowed = 'copy';
      });
    },
  };
}

/** 트리 노드 이름을 그 자리에서 바꾼다 */
function renameInline(app: App, lbl: HTMLElement, name: string, refresh: () => void): void {
  const input = h('input', { value: name, 'aria-label': '새 필터 이름' }) as HTMLInputElement;
  lbl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (ok && v && v !== name) {
      const err = renameLayerFilter(app, name, v);
      if (err) app.cmd.print(err, 'err');
    }
    refresh();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  for (const t of ['click', 'dblclick', 'mousedown']) input.addEventListener(t, (ev) => ev.stopPropagation());
}

async function confirmDelete(app: App, name: string): Promise<void> {
  const filters = listLayerFilters(app.active!.doc);
  const kids = descendantsOf(filters, name);
  if (kids.length) {
    const a = await ask('도면층 필터 삭제', `필터 "${name}"과(와) 그 안의 필터 ${kids.length}개를 삭제하시겠습니까?`, [
      { label: '예(Y)', value: 'yes', primary: true },
      { label: '아니오(N)', value: 'no' },
    ]);
    if (a !== 'yes') return;
  }
  deleteLayerFilter(app, name);
}

/** 필터(트리 노드) 오른쪽 클릭 메뉴 */
function filterMenu(app: App, n: FilterNode, x: number, y: number, startRename: () => void): void {
  const st = app.active!;
  const filters = listLayerFilters(st.doc);
  const f = isUserRef(n.ref) ? findFilter(filters, n.label) : null;
  const act = (a: FilterAction) => () => void applyFilterAction(app, n.ref, a);
  const items: MenuItem[] = [
    { heading: '가시성' },
    { label: '켜기', icon: 'eye', run: act('on') },
    { label: '끄기', icon: 'eyeOff', run: act('off') },
    { label: '동결 해제', icon: 'sun', run: act('thaw') },
    { label: '동결', icon: 'snow', run: act('freeze') },
    { heading: '잠금' },
    { label: '잠금', icon: 'lock', run: act('lock') },
    { label: '잠금 해제', icon: 'unlock', run: act('unlock') },
  ];
  if (st.onLayout) items.push({ heading: '뷰포트' }, { label: '동결', icon: 'snow', run: act('vpfreeze') }, { label: '동결 해제', icon: 'sun', run: act('vpthaw') });
  items.push(
    { separator: true },
    { label: '새 특성 필터…', run: () => void newFilter(app, 'property') },
    { label: '새 그룹 필터', run: () => void newFilter(app, 'group') },
    {
      label: '그룹 필터로 변환',
      disabled: !f || !canConvertToGroup(filters, f),
      run: () => {
        const err = convertToGroupFilter(app, f!.name);
        app.cmd.print(err ?? `특성 필터 "${f!.name}"을(를) 그룹 필터로 바꿨습니다.`, err ? 'err' : undefined);
      },
    },
    { separator: true },
    { label: '이름 바꾸기', kbd: 'F2', disabled: !f, run: startRename },
    { label: '삭제', kbd: 'Del', disabled: !f, run: () => void confirmDelete(app, f!.name) },
    { label: '특성…', disabled: !f, run: () => void editFilter(app, f!.name) },
  );
  if (f?.kind === 'group') {
    const pick = (mode: 'add' | 'replace') => async () => {
      const names = await pickLayersFromDrawing(app);
      if (!names) return;
      const k = editGroupLayers(app, f.name, names, mode);
      if (k >= 0) app.cmd.print(`그룹 필터 "${f.name}"의 도면층: ${mode === 'add' ? '추가' : '대치'} — ${names.join(', ')}`);
    };
    items.push({ heading: '도면층 선택' }, { label: '추가', run: () => void pick('add')() }, { label: '대치', run: () => void pick('replace')() });
  }
  showMenu(x, y, items);
}

// ---------------------------------------------------------------------------
// 새 필터·편집
// ---------------------------------------------------------------------------

/** 새 필터(지금 고른 사용자 필터 아래에 둘 수 있으면 그 아래) */
export async function newFilter(app: App, kind: FilterKind): Promise<boolean> {
  const st = app.active;
  if (!st) return false;
  const filters = listLayerFilters(st.doc);
  const parent = parentForNew(app, kind, filterView(st).ref);
  const name = defaultFilterName(kind, filters.map((f) => f.name));
  if (kind === 'property') return propertyFilterDialog(app, { name, kind, parent, rows: [], layers: [] });
  return groupFilterDialog(app, { name, kind, parent, rows: [], layers: [] });
}

/** 필터 특성(편집) */
export async function editFilter(app: App, name: string): Promise<boolean> {
  const f = findFilter(listLayerFilters(app.active!.doc), name);
  if (!f) return false;
  return f.kind === 'property' ? propertyFilterDialog(app, f, f.name) : groupFilterDialog(app, f, f.name);
}

function onOff(v: boolean, a: string, b: string): string {
  return v ? a : b;
}

/** 미리보기 표 */
function previewTable(app: App, keys: ReadonlySet<string>, used: ReadonlySet<string>, plotStyle: (l: Layer) => string): HTMLElement {
  const doc = app.active!.doc;
  const layers = [...keys].map((k) => doc.layers.get(k)!).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const head = h('tr', {}, ...['상태', '이름', '켜기', '동결', '잠금', '색상', '선종류', '선가중치', '투명도', '플롯 스타일', '플롯', '새 VP 동결', '설명'].map((c) => h('th', {}, c)));
  const rows = layers.map((l) =>
    h(
      'tr',
      {},
      h('td', {}, used.has(tableKey(l.name)) ? '사용 중' : ''),
      h('td', {}, l.name),
      h('td', {}, onOff(!l.off, '켜기', '끄기')),
      h('td', {}, onOff(l.frozen, '동결', '')),
      h('td', {}, onOff(l.locked, '잠금', '')),
      h('td', {}, h('span', { class: 'sw', style: `background:${swatchCss(l.color)}` }), colorValueText(l.color)),
      h('td', {}, l.linetype || 'Continuous'),
      h('td', {}, lineweightText(l.lineweight)),
      h('td', {}, String(percentFromOpacity(l.transparency))),
      h('td', {}, plotStyle(l)),
      h('td', {}, onOff(l.plot !== false, '플롯', '플롯 안 함')),
      h('td', {}, onOff((l.flags & 2) !== 0, '동결', '')),
      h('td', {}, l.description ?? ''),
    ),
  );
  return h('table', { class: 'ltx-table' }, h('thead', {}, head), h('tbody', {}, ...rows));
}

/** 색 칸 값 맞추기(이름 → 번호). 와일드카드는 그대로 */
function normalizeColorInput(t: string): string {
  const v = t.trim();
  if (!v) return '';
  const tc = parseTrueColor(v);
  if (tc) return colorValueText(tc);
  if (!v.startsWith('-')) {
    const c = parseLayerColor(v);
    if (c) return String(c.color.aci);
  }
  return v;
}

/**
 * 도면층 필터 특성 대화상자. 확인하면 저장하고 true.
 * 필터 정의: 한 행의 조건은 모두 맞아야 하고(AND), 행끼리는 하나만 맞으면 된다(OR). 마지막 빈 행에 쓰면 행이 늘어난다.
 */
export async function propertyFilterDialog(app: App, init: LayerFilter, previousName?: string): Promise<boolean> {
  ensureStyle();
  const st = app.active!;
  const doc = st.doc;
  const others = listLayerFilters(doc).filter((f) => !previousName || filterKey(f.name) !== filterKey(previousName));
  const ctx = matchContext(doc);
  const rows: FilterRow[] = init.rows.map((r) => ({ ...r }));
  /** 이 앱 정의로 바꿀 수 없는 AutoCAD 식(정의는 읽기 전용, 이름만 바꾼다) */
  const readOnlyExpr = init.expression;
  const parentStored = init.parent ? listStoredFilters(doc).find((x) => filterKey(x.filter.name) === filterKey(init.parent!)) : undefined;
  const warn = h('div', { class: 'lf-warn', role: 'status' });
  const nameIn = h('input', { class: 'ltx-input', value: init.name, 'aria-label': '필터 이름', style: 'width:260px' }) as HTMLInputElement;
  const err = h('div', { class: 'lf-err', role: 'alert' });
  const defBox = h('div', { class: 'lf-def' });
  const prevBox = h('div', { class: 'lf-prev' });
  const prevTitle = h('div', { class: 'ltx-h' });
  const lts = [...new Set(['Continuous', ...[...doc.linetypes.values()].map((l) => l.name).filter((n) => !/^(BYLAYER|BYBLOCK)$/i.test(n))])];
  const pss = [...new Set([...doc.layers.values()].map((l) => ctx.plotStyle(l)))];
  const lists = h(
    'div',
    { hidden: true },
    h('datalist', { id: 'lf-dl-lt' }, ...lts.map((n) => h('option', { value: n }))),
    h('datalist', { id: 'lf-dl-ps' }, ...pss.map((n) => h('option', { value: n }))),
    h('datalist', { id: 'lf-dl-name' }, ...[...doc.layers.values()].map((l) => h('option', { value: l.name }))),
  );

  const draft = (): LayerFilter => {
    const d: LayerFilter = { name: nameIn.value.trim() || init.name, kind: 'property', parent: init.parent, rows: readOnlyExpr !== undefined ? [] : rows.map((r) => cleanRow(r)).filter((r): r is FilterRow => !!r), layers: [] };
    if (readOnlyExpr !== undefined) d.expression = readOnlyExpr;
    return d;
  };

  const updatePreview = () => {
    const d = draft();
    const keys = new FilterEvaluator(doc, others, ctx, d).of(d);
    prevTitle.textContent = `필터 미리보기: ${keys.size}개 도면층`;
    prevBox.replaceChildren(previewTable(app, keys, ctx.used, ctx.plotStyle));
    if (readOnlyExpr !== undefined) return;
    const bad = unwritableColumns(d.rows).map((k) => FILTER_COLUMNS.find((c) => c.key === k)?.label ?? k);
    warn.textContent = bad.length
      ? `AutoCAD 형식으로 쓰는 방법을 확인하지 못한 조건(${bad.join('·')})이 있어 이 필터는 이 앱 기록으로 저장합니다 — AutoCAD에서는 보이지 않습니다. (색상은 ACI 번호, 선가중치는 mm 값만 AutoCAD 형식으로 씁니다)`
      : parentStored?.format === 'app'
        ? '상위 필터가 이 앱 기록이라 이 필터도 이 앱 기록으로 저장합니다 — AutoCAD에서는 보이지 않습니다.'
        : '';
  };

  const cell = (row: FilterRow, col: (typeof FILTER_COLUMNS)[number]): HTMLElement => {
    const val = row[col.key] ?? '';
    const set = (v: string) => {
      if (v) row[col.key] = v;
      else delete row[col.key];
      const last = rows[rows.length - 1];
      if (last && cleanRow(last)) {
        rows.push({});
        renderDef();
      }
      updatePreview();
    };
    const label = `${col.label} 조건`;
    switch (col.kind) {
      case 'choice': {
        const s = h('select', { 'aria-label': label }, h('option', { value: '' }, ''), ...col.choices!.map((c) => h('option', { value: c.value }, c.label))) as HTMLSelectElement;
        s.value = col.choices!.some((c) => c.value === val.toUpperCase()) ? val.toUpperCase() : '';
        s.addEventListener('change', () => set(s.value));
        return s;
      }
      case 'lineweight': {
        const s = h('select', { 'aria-label': label }, h('option', { value: '' }, ''), h('option', { value: '-3' }, '기본값'), ...LINEWEIGHTS.map((w) => h('option', { value: String(w) }, lineweightText(w)))) as HTMLSelectElement;
        if (val && ![...s.options].some((o) => o.value === val)) s.append(h('option', { value: val }, val));
        s.value = val;
        s.addEventListener('change', () => set(s.value));
        return s;
      }
      case 'color': {
        const inp = h('input', { class: 'w-color', value: val, 'aria-label': label, placeholder: '' }) as HTMLInputElement;
        guardKeys(inp);
        const sw = h('span', { class: 'sw' });
        const paint = () => {
          const t = normalizeColorInput(inp.value);
          const tc = parseTrueColor(t);
          const aci = /^\d+$/.test(t) ? Number(t) : 0;
          sw.style.background = tc ? swatchCss(tc) : aci >= 1 && aci <= 255 ? swatchCss({ aci }) : 'transparent';
        };
        paint();
        inp.addEventListener('change', () => {
          inp.value = normalizeColorInput(inp.value);
          paint();
          set(inp.value);
        });
        const more = h('button', { class: 'mini', type: 'button', title: '색 선택', 'aria-label': `${col.label} 색 선택` }, '…');
        more.addEventListener('click', async () => {
          const t = normalizeColorInput(inp.value);
          const tc = parseTrueColor(t);
          const cur: CadColor = tc ?? { aci: /^\d+$/.test(t) ? Number(t) : 7 };
          const c = await pickColor(cur, { allowBy: false });
          if (!c || c.aci === 0 || c.aci === 256) return;
          inp.value = colorValueText(c);
          paint();
          set(inp.value);
        });
        return h('span', { class: 'colorcell' }, sw, inp, more);
      }
      default: {
        const cls = col.key === 'NAME' || col.key === 'DESCRIPTION' ? 'w-name' : col.kind === 'transparency' ? 'w-num' : 'w-mid';
        const list = col.key === 'LINETYPE' ? 'lf-dl-lt' : col.key === 'PLOTSTYLE' ? 'lf-dl-ps' : col.key === 'NAME' ? 'lf-dl-name' : undefined;
        const inp = h('input', { class: cls, value: val, 'aria-label': label, list, title: col.kind === 'transparency' ? '0~90(%)' : '와일드카드: * ? # @ . [ ] ~ `' }) as HTMLInputElement;
        guardKeys(inp);
        inp.addEventListener('input', () => {
          if (inp.value.trim()) row[col.key] = inp.value.trim();
          else delete row[col.key];
          updatePreview();
        });
        inp.addEventListener('change', () => set(inp.value.trim()));
        return inp;
      }
    }
  };

  const renderDef = () => {
    const last = rows[rows.length - 1];
    if (!last || cleanRow(last)) rows.push({});
    const head = h('tr', {}, ...FILTER_COLUMNS.map((c) => h('th', {}, c.label)), h('th', {}, ''));
    const body = rows.map((r, i) =>
      h(
        'tr',
        {},
        ...FILTER_COLUMNS.map((c) => h('td', {}, cell(r, c))),
        h(
          'td',
          {},
          i < rows.length - 1
            ? h('button', {
                class: 'mini',
                type: 'button',
                title: '이 행 지우기',
                'aria-label': `${i + 1}행 지우기`,
                onclick: () => {
                  rows.splice(i, 1);
                  renderDef();
                  updatePreview();
                },
              }, '×')
            : '',
        ),
      ),
    );
    defBox.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, ...body)));
  };
  renderDef();
  updatePreview();
  nameIn.addEventListener('input', () => (err.textContent = ''));
  guardKeys(nameIn);

  const parentNote = init.parent ? h('div', { class: 'ltx-note' }, `상위 필터: ${init.parent} — 이 필터는 상위 필터의 도면층 가운데에서 고릅니다.`) : null;
  const definition =
    readOnlyExpr !== undefined
      ? [
          h('div', { class: 'ltx-h' }, '필터 정의(AutoCAD 필터 식, 읽기 전용):'),
          h('div', { class: 'lf-expr', 'aria-label': 'AutoCAD 필터 식' }, readOnlyExpr || '(조건 없음)'),
          h('div', { class: 'ltx-note' }, '이 식은 이 앱의 필터 정의 행으로 바꿀 수 없어 원본 그대로 둡니다(이름은 바꿀 수 있습니다). 미리보기는 이 앱이 아는 열만 따진 결과입니다.'),
        ]
      : [
          h('div', { class: 'ltx-h' }, '필터 정의:'),
          defBox,
          h('div', { class: 'ltx-note' }, '한 행의 조건은 모두 맞아야 하고, 행끼리는 하나만 맞으면 됩니다. 빈 칸은 상관없음입니다. 이름·선종류·플롯 스타일·설명에는 와일드카드(* ? # @ . [ ] ~ `)를 쓸 수 있습니다.'),
          warn,
        ];
  const body = h('div', { class: 'ltx-col' }, lists, h('label', { class: 'ltx-row' }, h('span', { class: 'ltx-h' }, '필터 이름(N):'), nameIn), parentNote, ...definition, prevTitle, prevBox, err);
  let ok = false;
  const dlg = wideDialog('도면층 필터 특성', body, [
    { label: '취소', value: 'cancel' },
    {
      label: '확인',
      value: 'ok',
      primary: true,
      keep: () => {
        const d = draft();
        d.name = nameIn.value.trim();
        const e = saveLayerFilter(app, d, previousName);
        if (e) {
          err.textContent = e;
          return true;
        }
        ok = true;
        return false;
      },
    },
  ], 1040);
  nameIn.focus();
  nameIn.select();
  await dlg.closed;
  if (ok && !previousName) setFilterView(st, { ref: userRef(nameIn.value.trim()) });
  if (ok) app.ui.refreshPalette();
  return ok;
}

/** 끌어 놓을 수 있는 목록(고른 항목을 끈다) */
class DragList extends PickList {
  onDropKeys: ((keys: string[]) => void) | null = null;

  constructor(label: string) {
    super(label, true);
    this.el.addEventListener('dragover', (ev) => {
      if (!hasLayerDrag(ev)) return;
      ev.preventDefault();
      this.el.classList.add('drop');
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    this.el.addEventListener('drop', (ev) => {
      this.el.classList.remove('drop');
      const keys = draggedLayers(ev);
      if (!keys) return;
      ev.preventDefault();
      this.onDropKeys?.(keys);
    });
  }

  override render(): void {
    super.render();
    const rows = [...this.el.children] as HTMLElement[];
    const keys = this.keys;
    rows.forEach((r, i) => {
      r.draggable = true;
      r.addEventListener('dragstart', (ev) => {
        if (!ev.dataTransfer) return;
        const k = keys[i]!;
        const sel = this.selection();
        ev.dataTransfer.setData(MIME, JSON.stringify(sel.includes(k) ? sel : [k]));
        ev.dataTransfer.effectAllowed = 'move';
      });
    });
  }
}

/**
 * 그룹 필터 대화상자: 필터 이름, 도면층 목록(왼쪽 도면의 도면층, 오른쪽 그룹 필터의 도면층), 도면층 추가·제거, 끌어 놓기,
 * 도면에서 선택(대화상자를 잠시 닫고 객체를 고르면 그 도면층을 넣는다). 확인하면 저장하고 true.
 */
export async function groupFilterDialog(app: App, init: LayerFilter, previousName?: string): Promise<boolean> {
  ensureStyle();
  const st = app.active!;
  let name = init.name;
  let members = new Map<string, string>(init.layers.filter((n) => st.doc.layers.has(tableKey(n))).map((n) => [tableKey(n), st.doc.layers.get(tableKey(n))!.name]));
  for (;;) {
    const doc = st.doc;
    const nameIn = h('input', { class: 'ltx-input', value: name, 'aria-label': '필터 이름', style: 'width:260px' }) as HTMLInputElement;
    guardKeys(nameIn);
    const err = h('div', { class: 'lf-err', role: 'alert' });
    const find = h('input', { class: 'ltx-input', placeholder: '도면층 이름 찾기(와일드카드)', 'aria-label': '도면층 찾기' }) as HTMLInputElement;
    guardKeys(find);
    const left = new DragList('도면의 도면층');
    const right = new DragList('그룹 필터의 도면층');
    const count = h('div', { class: 'ltx-h' });
    const item = (l: Layer) => ({ key: tableKey(l.name), label: l.name, swatch: swatchCss(l.color) });
    const render = () => {
      const q = find.value.trim();
      const all = [...doc.layers.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      left.setItems(all.filter((l) => !members.has(tableKey(l.name)) && (!q || matchesQuery(l.name, q))).map(item));
      right.setItems(all.filter((l) => members.has(tableKey(l.name))).map(item));
      count.textContent = `그룹 필터의 도면층: ${members.size}개`;
    };
    const addKeys = (keys: string[]) => {
      for (const k of keys) {
        const l = doc.layers.get(tableKey(k));
        if (l) members.set(tableKey(l.name), l.name);
      }
      render();
    };
    const removeKeys = (keys: string[]) => {
      for (const k of keys) members.delete(tableKey(k));
      render();
    };
    left.onDropKeys = removeKeys;
    right.onDropKeys = addKeys;
    left.onActivate = (k) => addKeys([k]);
    right.onActivate = (k) => removeKeys([k]);
    find.addEventListener('input', render);
    render();
    let picking = false;
    const mid = h(
      'div',
      { class: 'mid' },
      h('button', { class: 'ltx-btn', type: 'button', onclick: () => addKeys(left.selection()) }, '도면층 추가 ›'),
      h('button', { class: 'ltx-btn', type: 'button', onclick: () => removeKeys(right.selection()) }, '‹ 제거'),
      h(
        'button',
        {
          class: 'ltx-btn',
          type: 'button',
          title: '대화상자를 잠시 닫고 도면에서 객체를 고르면 그 도면층을 넣습니다',
          onclick: () => {
            picking = true;
            name = nameIn.value;
            dlg.close();
          },
        },
        '도면에서 선택 ‹',
      ),
    );
    const body = h(
      'div',
      { class: 'ltx-col' },
      h('label', { class: 'ltx-row' }, h('span', { class: 'ltx-h' }, '필터 이름(N):'), nameIn),
      init.parent ? h('div', { class: 'ltx-note' }, `상위 필터: ${init.parent}`) : null,
      h('div', { class: 'lf-grp' }, h('div', { class: 'ltx-col' }, h('div', { class: 'ltx-h' }, '도면층'), find, left.el), mid, h('div', { class: 'ltx-col' }, count, right.el)),
      h('div', { class: 'ltx-note' }, '도면층을 끌어 오른쪽 목록에 놓거나 "도면층 추가"로 넣습니다. 두 번 누르면 옮깁니다. 그룹 필터는 이름이나 특성과 상관없이 고른 도면층을 보여 줍니다.'),
      err,
    );
    let ok = false;
    const dlg = wideDialog(previousName ? '그룹 필터 특성' : '새 그룹 필터', body, [
      { label: '취소', value: 'cancel' },
      {
        label: '확인',
        value: 'ok',
        primary: true,
        keep: () => {
          const f: LayerFilter = { name: nameIn.value.trim(), kind: 'group', parent: init.parent, rows: [], layers: [...members.values()] };
          const e = saveLayerFilter(app, f, previousName);
          if (e) {
            err.textContent = e;
            return true;
          }
          name = f.name;
          ok = true;
          return false;
        },
      },
    ], 820);
    nameIn.focus();
    nameIn.select();
    await dlg.closed;
    if (picking) {
      const got = await pickLayersFromDrawing(app);
      if (got) members = new Map([...members, ...got.map((n) => [tableKey(n), n] as [string, string])]);
      continue;
    }
    if (ok && !previousName) setFilterView(st, { ref: userRef(name) });
    if (ok) app.ui.refreshPalette();
    return ok;
  }
}

function matchesQuery(name: string, q: string): boolean {
  return hasWildcard(q) ? wcmatch(name, q) : name.toUpperCase().includes(q.toUpperCase());
}

// ---------------------------------------------------------------------------
// FILTERS: 도면층 필터 삭제
// ---------------------------------------------------------------------------

/** FILTERS 대화상자: 왼쪽 "유지할 필터", 오른쪽 "삭제할 필터". 처음에는 모두 오른쪽에 있다. 지운 필터 수(취소하면 0) */
export async function deleteFiltersDialog(app: App): Promise<number> {
  ensureStyle();
  const st = app.active!;
  const filters = listLayerFilters(st.doc);
  if (!filters.length) {
    app.cmd.print('이 도면에는 삭제할 도면층 필터가 없습니다.');
    return 0;
  }
  const keep = new Set<string>();
  const keepList = new PickList('유지할 필터');
  const delList = new PickList('삭제할 필터');
  const path = (f: LayerFilter): string => {
    const chain: string[] = [f.name];
    let p = findFilter(filters, f.parent);
    const seen = new Set<string>();
    while (p && !seen.has(filterKey(p.name))) {
      seen.add(filterKey(p.name));
      chain.unshift(p.name);
      p = findFilter(filters, p.parent);
    }
    return chain.join(' › ');
  };
  const items = filters.map((f) => ({ key: filterKey(f.name), label: path(f), tag: f.kind === 'group' ? '그룹' : '특성' })).sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  const render = () => {
    keepList.setItems(items.filter((i) => keep.has(i.key)));
    delList.setItems(items.filter((i) => !keep.has(i.key)));
  };
  const toKeep = (keys: string[]) => {
    for (const k of keys) keep.add(k);
    render();
  };
  const toDel = (keys: string[]) => {
    for (const k of keys) keep.delete(k);
    render();
  };
  keepList.onActivate = (k) => toDel([k]);
  delList.onActivate = (k) => toKeep([k]);
  render();
  const body = h(
    'div',
    { class: 'ltx-col' },
    h(
      'div',
      { class: 'lf-grp' },
      h('div', { class: 'ltx-col' }, h('div', { class: 'ltx-h' }, '유지할 필터'), keepList.el),
      h(
        'div',
        { class: 'mid' },
        h('button', { class: 'ltx-btn', type: 'button', onclick: () => toKeep(delList.selection()) }, '‹ 유지'),
        h('button', { class: 'ltx-btn', type: 'button', onclick: () => toDel(keepList.selection()) }, '삭제 ›'),
        h('button', { class: 'ltx-btn', type: 'button', onclick: () => toKeep(items.map((i) => i.key)) }, '« 모두 유지'),
        h('button', { class: 'ltx-btn', type: 'button', onclick: () => toDel(items.map((i) => i.key)) }, '모두 삭제 »'),
      ),
      h('div', { class: 'ltx-col' }, h('div', { class: 'ltx-h' }, '삭제할 필터'), delList.el),
    ),
    h('div', { class: 'ltx-note' }, '남길 필터를 왼쪽으로 옮긴 뒤 "필터 삭제"를 누르십시오. 지우는 필터 안에 남길 필터가 있으면 그 필터는 위쪽으로 옮겨 남깁니다.'),
  );
  const dlg = wideDialog('도면층 필터 삭제', body, [
    { label: '닫기', value: 'close' },
    { label: '필터 삭제', value: 'delete', primary: true },
  ], 720);
  const r = await dlg.closed;
  if (r !== 'delete') return 0;
  const names = filters.filter((f) => !keep.has(filterKey(f.name))).map((f) => f.name);
  const n = deleteLayerFilters(app, names);
  app.cmd.print(n ? `도면층 필터 ${n}개를 삭제했습니다.` : '삭제한 도면층 필터가 없습니다.');
  app.ui.refreshPalette();
  return n;
}
