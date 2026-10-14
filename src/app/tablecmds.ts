/**
 * 표 명령: TABLE(테이블 삽입), TABLEDIT(셀 문자 편집), TABLECELL(행·열 삽입·삭제, 병합·병합 해제, 정렬, 행 높이·열 폭),
 * TABLESTYLE(테이블 스타일 관리), CTABLESTYLE(현재 테이블 스타일).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 표 계산은 src/edit/table의 순수 함수가 한다.
 */
import type { CadColor, CadDocument, Entity, InsertEntity, TableEntity } from '../core/model';
import { tableKey } from '../core/model';
import { ACI_RGB } from '../core/color';
import { tableBlockEntities } from '../edit/table/geometry';
import type { EditOp } from '../edit/session';
import type { App, CommandContext, Keyword } from './app';
import type { Pt } from './view';
import { currentProps } from './draw';
import { dialog, form, h } from './ui/dom';
import { type CellKind, type TableStyle, type TableStyleEntry, ALIGN_LABEL, KIND_LABEL, cloneTableStyle, currentTableStyle, defaultTableStyle, isMetric, listTableStyles } from '../edit/table/style';
import {
  type MergeMode,
  type TableData,
  anchorOf,
  cellAt,
  cellIndex,
  cellName,
  columnName,
  createTable,
  deleteCols,
  deleteRows,
  fitRowHeights,
  insertCols,
  insertRows,
  setText,
  mergeAt,
  mergeCells,
  setAlign,
  setRowKind,
  tableHeight,
  tableWidth,
  unmergeCells,
} from '../edit/table/model';
import { isEditableTable, tableFromEntity } from '../edit/table/entity';
import { addTableOps, deleteTableStyleOps, previewSegments, restyleTablesOps, saveTableStyleOps, tablesUsingStyle, updateTableOps } from '../edit/table/ops';


// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/** 여러 줄 문자 높이 재기(행 높이 맞춤용) */
function measurer(app: App, doc: CadDocument): (text: string, height: number, width: number, textStyle: string) => number {
  return (text, height, width, textStyle) => {
    try {
      const lay = app.text.layoutMText({ text, height, width, attachment: 1, lineSpacingStyle: 1, lineSpacingFactor: 1, style: doc.textStyles.get(tableKey(textStyle)) });
      // 글자 상자는 글꼴마다 위아래 여유가 달라 줄 수로 센다(줄 간격 = 높이 × 5/3)
      const step = height * (5 / 3);
      const lines = Math.max(1, Math.round((lay.maxY - lay.minY - height) / step) + 1);
      return height + (lines - 1) * step;
    } catch {
      return height;
    }
  };
}

interface PickedTable {
  entity: TableEntity | InsertEntity;
  space: string;
  data: TableData;
  style: TableStyle;
  styleHandle: string | undefined;
  cell: { r: number; c: number } | null;
}

/** 표 좌표(삽입점 원점, 회전·축척을 푼다) */
function toTableLocal(e: TableEntity | InsertEntity, p: Pt): Pt {
  const ang = e.type === 'ACAD_TABLE' ? Math.atan2(e.direction.y, e.direction.x) : e.rotation;
  const dx = p.x - e.insert.x;
  const dy = p.y - e.insert.y;
  const c = Math.cos(-ang);
  const s = Math.sin(-ang);
  return { x: (dx * c - dy * s) / (e.scale.x || 1), y: (dx * s + dy * c) / (e.scale.y || 1) };
}

function readPicked(app: App, handle: string, point: Pt | null): PickedTable | null {
  const st = app.active!;
  const e = st.doc.entityIndex.get(handle);
  if (!isEditableTable(e)) return null;
  const space = st.session.ownerOf(handle);
  if (!space) return null;
  const rt = tableFromEntity(e, st.doc);
  if (!rt) return null;
  let cell: { r: number; c: number } | null = null;
  if (point) {
    const q = toTableLocal(e, point);
    const at = cellAt(rt.data, q.x, q.y, rt.style.flow);
    cell = at ? anchorOf(rt.data, at.r, at.c) : null;
  }
  return { entity: e, space, data: rt.data, style: rt.style, styleHandle: rt.styleEntry?.handle, cell };
}

function lockedLayer(app: App, e: Entity): boolean {
  const l = app.active!.doc.layers.get(tableKey(e.layer));
  if (l?.locked) {
    app.cmd.print('객체가 잠긴 도면층에 있습니다.', 'err');
    return true;
  }
  return false;
}

/** 표 셀 고르기(표가 아니거나 셀 밖이면 다시 묻는다). Enter면 null */
async function pickCell(app: App, ctx: CommandContext, prompt: string, keywords: Keyword[] = []): Promise<PickedTable | { keyword: string } | null> {
  for (;;) {
    const r = await ctx.getEntity(prompt, keywords);
    if ('enter' in r) return null;
    if ('keyword' in r) return { keyword: r.keyword };
    const p = readPicked(app, r.handle, r.point);
    if (!p) {
      ctx.print('표가 아닙니다.', 'err');
      continue;
    }
    if (!p.cell) {
      ctx.print('셀 안을 고르십시오.', 'err');
      continue;
    }
    return p;
  }
}

/** 표 정의를 적용한다(행 높이를 문자에 맞춘 뒤) */
function commitTable(app: App, p: Pick<PickedTable, 'entity' | 'space' | 'style' | 'styleHandle'>, data: TableData, label: string, group?: number): TableEntity {
  const st = app.active!;
  const fitted = fitRowHeights(data, p.style, measurer(app, st.doc));
  const r = updateTableOps(st.doc, () => st.session.newHandle(), p.entity, p.space, fitted, p.style, p.styleHandle);
  st.session.commit({ label, ops: r.ops, group });
  return r.table;
}

// ---------------------------------------------------------------------------
// 셀 문자 편집기(표 전체 격자)
// ---------------------------------------------------------------------------

const INPUT_CSS = 'width:100%;min-width:72px;box-sizing:border-box;resize:vertical;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;padding:3px 5px;font:13px var(--font)';

/**
 * 셀 문자 편집 대화상자. 병합된 셀은 하나의 칸, 줄바꿈은 여러 줄 문자 문단(\P).
 * Enter 아래 셀, Alt+Enter·Shift+Enter 줄바꿈, Tab·Shift+Tab 다음·이전 셀, Ctrl+Enter 확인, Esc 취소.
 */
export function editCellsDialog(title: string, t: TableData, focus: { r: number; c: number } | null): Promise<TableData | null> {
  return new Promise((resolve) => {
    let done = false;
    const inputs = new Map<number, HTMLTextAreaElement>();
    const table = h('table', { style: 'border-collapse:collapse;width:100%' });
    const head = h('tr', {}, h('th', { style: 'width:28px' }));
    for (let c = 0; c < t.cols; c++) head.append(h('th', { style: 'color:var(--text-dim);font-weight:500;padding:2px' }, columnName(c)));
    table.append(head);
    for (let r = 0; r < t.rows; r++) {
      const tr = h('tr', {}, h('th', { style: 'color:var(--text-dim);font-weight:500;padding:2px 4px', title: KIND_LABEL[t.rowKinds[r] ?? 'data'] }, String(r + 1)));
      for (let c = 0; c < t.cols; c++) {
        const m = mergeAt(t, r, c);
        if (m && (m.row !== r || m.col !== c)) continue;
        const ta = h('textarea', { rows: 1, 'aria-label': `셀 ${cellName(r, c)}`, style: INPUT_CSS + (t.rowKinds[r] !== 'data' ? ';font-weight:600' : '') });
        ta.value = (t.cells[cellIndex(t, r, c)]?.text ?? '').replace(/\\P/g, '\n');
        inputs.set(cellIndex(t, r, c), ta);
        tr.append(h('td', { colspan: m?.cols ?? 1, rowspan: m?.rows ?? 1, style: 'padding:2px;vertical-align:top' }, ta));
      }
      table.append(tr);
    }
    const body = h(
      'div',
      {},
      h('div', { style: 'max-height:60vh;overflow:auto' }, table),
      h('div', { style: 'margin-top:6px;color:var(--text-dim)' }, 'Enter 아래 셀 · Alt+Enter 줄 바꿈 · Tab 다음 셀 · Ctrl+Enter 확인'),
    );
    const read = (): TableData => {
      const out: TableData = structuredClone(t);
      for (const [i, ta] of inputs) out.cells[i]!.text = ta.value.replace(/\r?\n/g, '\\P');
      return out;
    };
    const back = dialog(title, body, [
      { label: '취소', run: () => ((done = true), resolve(null)) },
      { label: '확인', primary: true, run: () => ((done = true), resolve(read())) },
    ]);
    const box = back.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = `min(${Math.min(1100, 160 + t.cols * 150)}px, 100%)`;
    const order = [...inputs.keys()];
    for (const [i, ta] of inputs) {
      ta.addEventListener('keydown', (ev) => {
        const k = ev as KeyboardEvent;
        k.stopPropagation();
        if (k.key !== 'Enter') return;
        if (k.ctrlKey || k.metaKey) {
          k.preventDefault();
          (back.querySelector('footer .btn.primary') as HTMLButtonElement | null)?.click();
          return;
        }
        if (k.altKey || k.shiftKey) return;
        // 아래 셀(병합 셀은 그 아래)
        k.preventDefault();
        const r = Math.floor(i / t.cols);
        const c = i % t.cols;
        const m = mergeAt(t, r, c);
        const below = r + (m?.rows ?? 1);
        if (below < t.rows) {
          const a = anchorOf(t, below, c);
          inputs.get(cellIndex(t, a.r, a.c))?.focus();
        } else inputs.get(order[(order.indexOf(i) + 1) % order.length]!)?.focus();
      });
    }
    setTimeout(() => {
      const a = focus ? anchorOf(t, focus.r, focus.c) : { r: 0, c: 0 };
      const ta = inputs.get(cellIndex(t, a.r, a.c)) ?? inputs.values().next().value;
      ta?.focus();
      ta?.select();
    });
    new MutationObserver((_, obs) => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    }).observe(document.body, { childList: true });
  });
}

/** 표의 셀을 편집한다(더블클릭 연결용: 리더가 app.ts에서 부를 수 있다) */
export async function editTableAt(app: App, handle: string, point: Pt | null): Promise<void> {
  const p = readPicked(app, handle, point);
  if (!p || lockedLayer(app, p.entity)) return;
  const out = await editCellsDialog('테이블 셀 편집', p.data, p.cell);
  if (!out) return;
  commitTable(app, p, out, 'TABLEDIT');
}

// ---------------------------------------------------------------------------
// TABLE
// ---------------------------------------------------------------------------

interface InsertSettings {
  style: string;
  mode: 'point' | 'window';
  cols: number;
  colWidth: number;
  dataRows: number;
  rowLines: number;
  first: CellKind;
  second: CellKind;
}

const lastInsert = new WeakMap<CadDocument, InsertSettings>();

function kindOptions(): { value: string; label: string }[] {
  return (['title', 'header', 'data'] as CellKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }));
}

async function tableInsertDialog(app: App): Promise<InsertSettings | null> {
  const doc = app.active!.doc;
  const styles = listTableStyles(doc);
  const cur = currentTableStyle(doc);
  const metric = isMetric(doc);
  const prev = lastInsert.get(doc);
  const v = await form(
    '테이블 삽입',
    [
      { key: 'style', label: '테이블 스타일', type: 'select', value: prev?.style ?? cur?.handle ?? '', options: styles.length ? styles.map((s) => ({ value: s.handle, label: s.name })) : [{ value: '', label: 'Standard' }] },
      {
        key: 'mode',
        label: '삽입 동작',
        type: 'select',
        value: prev?.mode ?? 'point',
        options: [
          { value: 'point', label: '삽입점 지정' },
          { value: 'window', label: '윈도우 지정' },
        ],
      },
      { key: 'cols', label: '열', type: 'number', value: prev?.cols ?? 5 },
      { key: 'colWidth', label: '열 폭', type: 'number', value: prev?.colWidth ?? (metric ? 63.5 : 2.5) },
      { key: 'dataRows', label: '데이터 행', type: 'number', value: prev?.dataRows ?? 1 },
      { key: 'rowLines', label: '행 높이(줄)', type: 'number', value: prev?.rowLines ?? 1 },
      { key: 'first', label: '첫 번째 행 셀 스타일', type: 'select', value: prev?.first ?? 'title', options: kindOptions() },
      { key: 'second', label: '두 번째 행 셀 스타일', type: 'select', value: prev?.second ?? 'header', options: kindOptions() },
    ],
    {
      ok: '확인',
      note: '다른 모든 행은 데이터 셀 스타일입니다. 윈도우 지정에서는 열 폭과 행 높이를 창 크기에서 정합니다.',
      validate: (x) => {
        const int = (k: string, lo: number, hi: number) => Number.isInteger(Number(x[k])) && Number(x[k]) >= lo && Number(x[k]) <= hi;
        if (!int('cols', 1, 200)) return '열은 1~200 사이의 정수입니다.';
        if (!int('dataRows', 1, 1000)) return '데이터 행은 1~1000 사이의 정수입니다.';
        if (!int('rowLines', 1, 100)) return '행 높이(줄)는 1 이상의 정수입니다.';
        if (!(Number(x.colWidth) > 0)) return '열 폭은 0보다 커야 합니다.';
        return null;
      },
    },
  );
  if (!v) return null;
  const s: InsertSettings = {
    style: String(v.style),
    mode: v.mode === 'window' ? 'window' : 'point',
    cols: Number(v.cols),
    colWidth: Number(v.colWidth),
    dataRows: Number(v.dataRows),
    rowLines: Number(v.rowLines),
    first: v.first as CellKind,
    second: v.second as CellKind,
  };
  lastInsert.set(doc, s);
  return s;
}

function styleFor(doc: CadDocument, handle: string): { entry: TableStyleEntry | null; style: TableStyle } {
  const entry = listTableStyles(doc).find((s) => s.handle === handle) ?? currentTableStyle(doc);
  return { entry, style: entry?.style ?? defaultTableStyle(isMetric(doc)) };
}

/** 표 좌표 선분을 삽입점 기준 월드 선분으로 */
function ghostSegs(segs: number[][], at: Pt): number[] {
  const out: number[] = [];
  for (const s of segs) out.push(s[0]! + at.x, s[1]! + at.y, s[2]! + at.x, s[3]! + at.y);
  return out;
}

// ---------------------------------------------------------------------------
// TABLESTYLE 편집기
// ---------------------------------------------------------------------------

const FIELD_CSS = 'width:100%;box-sizing:border-box;height:26px;padding:0 6px;border:1px solid var(--border-soft);border-radius:3px;background:var(--bg-input);color:var(--text);font:inherit';

function aciText(c: { aci: number } | null): string {
  if (!c) return '';
  if (c.aci === 0) return 'ByBlock';
  if (c.aci === 256) return 'ByLayer';
  return String(c.aci);
}

function parseAci(s: string, allowEmpty: boolean): { aci: number } | null | undefined {
  const t = s.trim().toUpperCase();
  if (!t) return allowEmpty ? null : undefined;
  if (t === 'BYBLOCK') return { aci: 0 };
  if (t === 'BYLAYER') return { aci: 256 };
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 256 ? { aci: n } : undefined;
}

/** 테이블 스타일 편집 대화상자(확인하면 새 스타일 값) */
function tableStyleEditor(doc: CadDocument, title: string, start: TableStyle): Promise<TableStyle | null> {
  return new Promise((resolve) => {
    let done = false;
    const s = cloneTableStyle(start);
    const textStyles = [...doc.textStyles.values()].filter((x) => x.name && !(x.flags & 1)).map((x) => x.name);
    if (!textStyles.length) textStyles.push('Standard');
    const err = h('div', { class: 'form-error', role: 'alert' });
    const inp = (value: string, label: string) => {
      const el = h('input', { type: 'text', 'aria-label': label, style: FIELD_CSS });
      el.value = value;
      el.addEventListener('keydown', (ev) => ev.stopPropagation());
      return el;
    };
    const sel = (value: string, opts: { value: string; label: string }[], label: string) => {
      const el = h('select', { 'aria-label': label, style: FIELD_CSS }, ...opts.map((o) => h('option', { value: o.value }, o.label)));
      el.value = value;
      return el;
    };
    const desc = inp(s.description, '설명');
    const flow = sel(String(s.flow), [
      { value: '0', label: '아래로' },
      { value: '1', label: '위로' },
    ], '표 방향');
    const hm = inp(String(s.hMargin), '여백 수평');
    const vm = inp(String(s.vMargin), '여백 수직');
    const kinds: CellKind[] = ['data', 'header', 'title'];
    type Row = { label: string; make: (k: CellKind) => HTMLElement; read: (k: CellKind, el: HTMLElement) => string | null };
    const els = new Map<string, HTMLElement>();
    const rows: Row[] = [
      {
        label: '문자 스타일',
        make: (k) => sel(textStyles.find((n) => tableKey(n) === tableKey(s.cells[k].textStyle)) ?? textStyles[0]!, textStyles.map((n) => ({ value: n, label: n })), `${KIND_LABEL[k]} 문자 스타일`),
        read: (k, el) => ((s.cells[k].textStyle = (el as HTMLSelectElement).value), null),
      },
      {
        label: '문자 높이',
        make: (k) => inp(String(s.cells[k].height), `${KIND_LABEL[k]} 문자 높이`),
        read: (k, el) => {
          const v = Number((el as HTMLInputElement).value);
          if (!(v > 0)) return `${KIND_LABEL[k]} 문자 높이는 0보다 커야 합니다.`;
          s.cells[k].height = v;
          return null;
        },
      },
      {
        label: '정렬',
        make: (k) => sel(String(s.cells[k].align), Object.entries(ALIGN_LABEL).map(([v, l]) => ({ value: v, label: l })), `${KIND_LABEL[k]} 정렬`),
        read: (k, el) => ((s.cells[k].align = Number((el as HTMLSelectElement).value)), null),
      },
      {
        label: '문자 색상',
        make: (k) => inp(aciText(s.cells[k].color), `${KIND_LABEL[k]} 문자 색상`),
        read: (k, el) => {
          const c = parseAci((el as HTMLInputElement).value, false);
          if (!c) return `${KIND_LABEL[k]} 문자 색상: ByBlock·ByLayer 또는 1~255`;
          s.cells[k].color = c;
          return null;
        },
      },
      {
        label: '채우기 색상',
        make: (k) => inp(aciText(s.cells[k].fill), `${KIND_LABEL[k]} 채우기 색상`),
        read: (k, el) => {
          const c = parseAci((el as HTMLInputElement).value, true);
          if (c === undefined) return `${KIND_LABEL[k]} 채우기 색상: 비우면 없음, 또는 1~255`;
          s.cells[k].fill = c;
          return null;
        },
      },
      {
        label: '테두리 색상',
        make: (k) => inp(aciText(s.cells[k].borderColor), `${KIND_LABEL[k]} 테두리 색상`),
        read: (k, el) => {
          const c = parseAci((el as HTMLInputElement).value, false);
          if (!c) return `${KIND_LABEL[k]} 테두리 색상: ByBlock·ByLayer 또는 1~255`;
          s.cells[k].borderColor = c;
          return null;
        },
      },
    ];
    const grid = h('table', { style: 'width:100%;border-collapse:collapse;margin-top:8px' }, h('tr', {}, h('th', { style: 'text-align:left;color:var(--text-dim);font-weight:500' }, '셀 스타일'), ...kinds.map((k) => h('th', { style: 'text-align:left;padding:2px 4px' }, KIND_LABEL[k]))));
    for (const row of rows) {
      const tr = h('tr', {}, h('td', { style: 'color:var(--text-dim);padding-right:6px;white-space:nowrap' }, row.label));
      for (const k of kinds) {
        const el = row.make(k);
        els.set(`${row.label}:${k}`, el);
        tr.append(h('td', { style: 'padding:2px 4px' }, el));
      }
      grid.append(tr);
    }
    const line = (label: string, el: HTMLElement) => h('label', { class: 'form-row' }, h('span', {}, label), el);
    const body = h(
      'div',
      {},
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 12px' }, line('설명', desc), line('표 방향', flow), line('여백 수평', hm), line('여백 수직', vm)),
      grid,
      h('div', { class: 'form-note' }, '색상: ByBlock, ByLayer 또는 색상 번호(1~255). 채우기를 비우면 채우지 않습니다.'),
      err,
    );
    const submit = (): boolean => {
      s.description = desc.value;
      s.flow = flow.value === '1' ? 1 : 0;
      const a = Number(hm.value);
      const b = Number(vm.value);
      if (!(a >= 0) || !(b >= 0)) {
        err.textContent = '여백은 0 이상이어야 합니다.';
        return false;
      }
      s.hMargin = a;
      s.vMargin = b;
      for (const row of rows)
        for (const k of kinds) {
          const m = row.read(k, els.get(`${row.label}:${k}`)!);
          if (m) {
            err.textContent = m;
            return false;
          }
        }
      return true;
    };
    const back = dialog(title, body, [
      { label: '취소', run: () => ((done = true), resolve(null)) },
      {
        label: '확인',
        primary: true,
        run: () => {
          if (!submit()) return true;
          done = true;
          resolve(s);
        },
      },
    ]);
    const box = back.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = 'min(640px, 100%)';
    new MutationObserver((_, obs) => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    }).observe(document.body, { childList: true });
  });
}

/** 색 → CSS(ByLayer·ByBlock·7은 글자색) */
function cssColor(c: CadColor): string {
  if (c.rgb !== undefined) return `#${c.rgb.toString(16).padStart(6, '0')}`;
  if (c.aci <= 0 || c.aci >= 256 || c.aci === 7) return 'currentColor';
  return `#${(ACI_RGB[c.aci] ?? 0xffffff).toString(16).padStart(6, '0')}`;
}

/** 스타일 미리보기: 제목·머리글·데이터 행이 있는 작은 표(SVG, 글꼴은 화면 글꼴로 흉내) */
function tableStylePreview(style: TableStyle): SVGSVGElement {
  const hMax = Math.max(style.cells.data.height, style.cells.header.height, style.cells.title.height);
  let t = createTable({ cols: 3, colWidth: hMax * 9, dataRows: 3, rowLines: 1, first: 'title', second: 'header' }, style);
  t = setText(t, 0, 0, '제목');
  for (let c = 0; c < 3; c++) t = setText(t, 1, c, '머리글');
  for (let r = 2; r < t.rows; r++) for (let c = 0; c < 3; c++) t = setText(t, r, c, '데이터');
  const ents = tableBlockEntities(t, style);
  const W = tableWidth(t);
  const H = tableHeight(t);
  const pad = hMax;
  // 표 좌표: 아래로 쌓으면 y는 0 → -H, 위로 쌓으면 0 → H
  const top = style.flow === 1 ? H : 0;
  const X = (x: number) => (x + pad).toFixed(3);
  const Y = (y: number) => (top - y + pad).toFixed(3);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${(W + 2 * pad).toFixed(3)} ${(H + 2 * pad).toFixed(3)}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '미리보기');
  svg.style.cssText = 'width:100%;height:150px;background:var(--bg-input);border:1px solid var(--border-soft);border-radius:4px;color:var(--text)';
  const el = (name: string, attrs: Record<string, string>, text?: string) => {
    const x = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v);
    if (text) x.textContent = text;
    svg.append(x);
  };
  for (const e of ents) {
    if (e.type === 'SOLID') {
      const q = e.points;
      el('polygon', { points: [q[0]!, q[1]!, q[3]!, q[2]!].map((p) => `${X(p.x)},${Y(p.y)}`).join(' '), fill: cssColor(e.color) });
    } else if (e.type === 'LINE') {
      el('line', { x1: X(e.start.x), y1: Y(e.start.y), x2: X(e.end.x), y2: Y(e.end.y), stroke: cssColor(e.color), 'stroke-width': '1', 'vector-effect': 'non-scaling-stroke' });
    } else if (e.type === 'MTEXT') {
      const a = e.attachment - 1;
      const anchor = ['start', 'middle', 'end'][a % 3]!;
      const base = ['text-before-edge', 'central', 'text-after-edge'][Math.floor(a / 3)]!;
      el('text', { x: X(e.insert.x), y: Y(e.insert.y), 'font-size': e.height.toFixed(3), 'text-anchor': anchor, 'dominant-baseline': base, fill: cssColor(e.color), style: 'font-family:var(--font)' }, e.text);
    }
  }
  return svg;
}

/** 스타일 요약(목록 옆 설명) */
function styleSummary(s: TableStyle): string {
  const c = (k: CellKind) => `${KIND_LABEL[k]} ${s.cells[k].textStyle} ${+s.cells[k].height.toFixed(4)} · ${ALIGN_LABEL[s.cells[k].align] ?? ''}${s.cells[k].fill ? ` · 채우기 ${aciText(s.cells[k].fill)}` : ''}`;
  return [`표 방향: ${s.flow === 1 ? '위로' : '아래로'}, 여백 ${+s.hMargin.toFixed(4)} / ${+s.vMargin.toFixed(4)}`, c('title'), c('header'), c('data')].join('\n');
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

const ALIGN_KEYS: Keyword[] = [
  { key: 'TL', label: '맨 위 왼쪽' },
  { key: 'TC', label: '맨 위 중심' },
  { key: 'TR', label: '맨 위 오른쪽' },
  { key: 'ML', label: '중간 왼쪽' },
  { key: 'MC', label: '중간 중심' },
  { key: 'MR', label: '중간 오른쪽' },
  { key: 'BL', label: '맨 아래 왼쪽' },
  { key: 'BC', label: '맨 아래 중심' },
  { key: 'BR', label: '맨 아래 오른쪽' },
  { key: 'S', label: '스타일 따름' },
];

export function registerTableEditCommands(app: App): void {
  // ------------------------------------------------------------- TABLE
  app.register({
    name: 'TABLE',
    aliases: ['TB'],
    title: '테이블',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const set = await tableInsertDialog(app);
      if (!set) return;
      const { entry, style } = styleFor(doc, set.style);
      let data = createTable({ cols: set.cols, colWidth: set.colWidth, dataRows: set.dataRows, rowLines: set.rowLines, first: set.first, second: set.second }, style);
      let insert: Pt;
      if (set.mode === 'point') {
        const segs = previewSegments(data, style);
        const r = await ctx.getPoint('삽입점 지정:', { ghost: (q) => [{ segs: ghostSegs(segs, q) }] });
        if (!('point' in r)) return;
        insert = r.point;
      } else {
        const a = await ctx.getPoint('첫 번째 구석 지정:');
        if (!('point' in a)) return;
        const p0 = a.point;
        const b = await ctx.getPoint('두 번째 구석 지정:', {
          base: p0,
          rubber: (q) => [{ pts: [p0.x, p0.y, q.x, p0.y, q.x, q.y, p0.x, q.y], closed: true, dashed: true }],
        });
        if (!('point' in b)) return;
        const p1 = b.point;
        const w = Math.abs(p1.x - p0.x);
        const hgt = Math.abs(p1.y - p0.y);
        if (!(w > 0 && hgt > 0)) {
          ctx.print('창의 크기가 0입니다.', 'err');
          return;
        }
        // 열 폭은 창 폭을 나누고, 행 높이는 창 높이에 맞춰 늘린다(한 줄 높이보다 낮아지지 않는다)
        const total = tableHeight(data);
        const k = Math.max(1, hgt / total);
        data = { ...data, colWidths: data.colWidths.map(() => w / data.cols), rowHeights: data.rowHeights.map((x) => x * k), baseRowHeights: data.baseRowHeights.map((x) => x * k) };
        const left = Math.min(p0.x, p1.x);
        insert = { x: left, y: style.flow === 1 ? Math.min(p0.y, p1.y) : Math.max(p0.y, p1.y) };
      }
      const r = addTableOps(doc, () => st.session.newHandle(), { space: st.space, data, style, styleHandle: entry?.handle, insert: { x: insert.x, y: insert.y, z: 0 }, props: currentProps(app) });
      st.session.commit({ label: 'TABLE', ops: r.ops, group: ctx.group });
      app.lastCreated = [r.table.handle];
      ctx.print(`${data.rows}행 ${data.cols}열 표를 만들었습니다(폭 ${+tableWidth(data).toFixed(4)}, 높이 ${+tableHeight(data).toFixed(4)}).`);
      // 첫 셀부터 문자 입력
      const filled = await editCellsDialog('테이블 셀 문자', data, { r: 0, c: 0 });
      if (!filled || filled.cells.every((c) => !c.text)) return;
      const placed = st.doc.entityIndex.get(r.table.handle);
      if (placed?.type !== 'ACAD_TABLE') return;
      commitTable(app, { entity: placed, space: st.space, style, styleHandle: entry?.handle }, filled, 'TABLE', ctx.group);
    },
  });

  // ------------------------------------------------------------- TABLEDIT
  app.register({
    name: 'TABLEDIT',
    title: '테이블 셀 편집',
    async run(ctx) {
      const p = await pickCell(app, ctx, '테이블 셀 선택:');
      if (!p || 'keyword' in p) return;
      if (lockedLayer(app, p.entity)) return;
      const out = await editCellsDialog(`테이블 셀 편집 — ${cellName(p.cell!.r, p.cell!.c)}`, p.data, p.cell);
      if (!out) return;
      commitTable(app, p, out, 'TABLEDIT');
    },
  });

  // ------------------------------------------------------------- TABLECELL(테이블 셀 탭의 동작)
  app.register({
    name: 'TABLECELL',
    aliases: ['TCELL'],
    title: '테이블 셀(행·열·병합)',
    async run(ctx) {
      let first = true;
      for (;;) {
        const p = await pickCell(app, ctx, first ? '테이블 셀 선택:' : '테이블 셀 선택 또는 <끝>:');
        first = false;
        if (!p || 'keyword' in p) return;
        if (lockedLayer(app, p.entity)) continue;
        const cell = p.cell!;
        const kw: Keyword[] = [
          { key: 'RA', label: '위에 행 삽입' },
          { key: 'RB', label: '아래에 행 삽입' },
          { key: 'DR', label: '행 삭제' },
          { key: 'CL', label: '왼쪽에 열 삽입' },
          { key: 'CR', label: '오른쪽에 열 삽입' },
          { key: 'DC', label: '열 삭제' },
          { key: 'M', label: '셀 병합' },
          { key: 'U', label: '셀 병합 해제' },
          { key: 'A', label: '정렬' },
          { key: 'S', label: '셀 스타일' },
          { key: 'H', label: '행 높이' },
          { key: 'W', label: '열 폭' },
          { key: 'E', label: '문자 편집' },
        ];
        const r = await ctx.getPoint(`셀 ${cellName(cell.r, cell.c)} 옵션 입력 [${kw.map((k) => `${k.label}(${k.key})`).join('/')}] <문자 편집>:`, { keywords: kw });
        const key = 'keyword' in r ? r.keyword : 'enter' in r ? 'E' : null;
        if (!key) continue;
        const t = p.data;
        const m = mergeAt(t, cell.r, cell.c);
        const r1 = cell.r + (m?.rows ?? 1) - 1;
        const c1 = cell.c + (m?.cols ?? 1) - 1;
        let next: TableData | null = null;
        let label = 'TABLECELL';
        switch (key) {
          case 'RA':
            next = insertRows(t, cell.r, 1);
            label = '위에 행 삽입';
            break;
          case 'RB':
            next = insertRows(t, r1 + 1, 1);
            label = '아래에 행 삽입';
            break;
          case 'DR':
            next = deleteRows(t, cell.r, r1);
            if (!next) ctx.print('표의 모든 행을 삭제할 수는 없습니다.', 'err');
            label = '행 삭제';
            break;
          case 'CL':
            next = insertCols(t, cell.c, 1);
            label = '왼쪽에 열 삽입';
            break;
          case 'CR':
            next = insertCols(t, c1 + 1, 1);
            label = '오른쪽에 열 삽입';
            break;
          case 'DC':
            next = deleteCols(t, cell.c, c1);
            if (!next) ctx.print('표의 모든 열을 삭제할 수는 없습니다.', 'err');
            label = '열 삭제';
            break;
          case 'M': {
            const q = await pickCell(app, ctx, '병합할 범위의 반대쪽 셀 선택:');
            if (!q || 'keyword' in q) continue;
            if (q.entity.handle !== p.entity.handle) {
              ctx.print('같은 표의 셀을 고르십시오.', 'err');
              continue;
            }
            const how = await ctx.getPoint('셀 병합 [모두(A)/행별(R)/열별(C)] <모두>:', {
              keywords: [
                { key: 'A', label: '모두' },
                { key: 'R', label: '행별' },
                { key: 'C', label: '열별' },
              ],
            });
            const mode: MergeMode = 'keyword' in how && how.keyword === 'R' ? 'rows' : 'keyword' in how && how.keyword === 'C' ? 'cols' : 'all';
            next = mergeCells(t, cell.r, cell.c, q.cell!.r, q.cell!.c, mode);
            if (!next) ctx.print('셀을 두 개 이상 고르십시오.', 'err');
            label = '셀 병합';
            break;
          }
          case 'U':
            next = unmergeCells(t, cell.r, cell.c);
            if (!next) ctx.print('병합된 셀이 아닙니다.', 'err');
            label = '셀 병합 해제';
            break;
          case 'A': {
            const a = await ctx.getPoint('정렬 입력 [' + ALIGN_KEYS.map((k) => `${k.label}(${k.key})`).join('/') + ']:', { keywords: ALIGN_KEYS });
            if (!('keyword' in a)) continue;
            const idx = ALIGN_KEYS.findIndex((k) => k.key === a.keyword);
            next = setAlign(t, cell.r, cell.c, r1, c1, a.keyword === 'S' ? 0 : idx + 1);
            label = '셀 정렬';
            break;
          }
          case 'S': {
            const a = await ctx.getPoint('행의 셀 스타일 입력 [제목(T)/머리글(H)/데이터(D)]:', {
              keywords: [
                { key: 'T', label: '제목' },
                { key: 'H', label: '머리글' },
                { key: 'D', label: '데이터' },
              ],
            });
            if (!('keyword' in a)) continue;
            next = setRowKind(t, cell.r, r1, a.keyword === 'T' ? 'title' : a.keyword === 'H' ? 'header' : 'data');
            label = '셀 스타일';
            break;
          }
          case 'H':
          case 'W': {
            const cur = key === 'H' ? t.baseRowHeights[r1]! : t.colWidths[c1]!;
            const a = await ctx.getPoint(`${key === 'H' ? '행 높이' : '열 폭'} 입력 <${+cur.toFixed(4)}>:`, { preferNumber: true });
            const v = 'text' in a ? Number(a.text) : 'enter' in a ? cur : NaN;
            if (!(v > 0)) {
              ctx.print('0보다 큰 값을 입력하십시오.', 'err');
              continue;
            }
            next = structuredClone(t);
            if (key === 'H') {
              next.baseRowHeights[r1] = v;
              next.rowHeights[r1] = v;
            } else next.colWidths[c1] = v;
            label = key === 'H' ? '행 높이' : '열 폭';
            break;
          }
          case 'E': {
            next = await editCellsDialog(`테이블 셀 편집 — ${cellName(cell.r, cell.c)}`, t, cell);
            label = 'TABLEDIT';
            break;
          }
        }
        if (!next) continue;
        commitTable(app, p, next, label);
        ctx.print(`${label}: 표 ${next.rows}행 ${next.cols}열`);
      }
    },
  });

  // ------------------------------------------------------------- TABLESTYLE
  app.register({
    name: 'TABLESTYLE',
    aliases: ['TS'],
    title: '테이블 스타일',
    async run(ctx) {
      await new Promise<void>((resolve) => {
        const st = app.active!;
        const list = h('select', { size: 9, 'aria-label': '스타일', style: 'width:100%;min-width:180px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:4px' });
        const info = h('pre', { style: 'margin:0;white-space:pre-wrap;font:12px var(--font);color:var(--text-dim)' });
        const preview = h('div', { style: 'margin-top:8px' });
        const curLine = h('div', { style: 'margin-bottom:6px' });
        let entries: TableStyleEntry[] = [];
        const refresh = (keep?: string) => {
          entries = listTableStyles(st.doc);
          // Standard가 없는 도면(다른 프로그램이 만든 파일): 기본값으로 보이고, 수정하면 만든다
          if (!entries.some((e) => tableKey(e.name) === 'STANDARD')) entries.unshift({ name: 'Standard', handle: '', obj: { type: 'TABLESTYLE', handle: '' }, style: defaultTableStyle(isMetric(st.doc)) });
          const cur = currentTableStyle(st.doc);
          curLine.textContent = `현재 테이블 스타일: ${cur?.name ?? 'Standard'}`;
          list.innerHTML = '';
          for (const e of entries) list.append(h('option', { value: e.handle }, e.name + (tablesUsingStyle(st.doc, e.handle).length ? ' (사용 중)' : '')));
          list.value = keep && entries.some((e) => e.handle === keep) ? keep : (cur?.handle ?? entries[0]?.handle ?? '');
          show();
        };
        const selected = () => entries.find((e) => e.handle === list.value) ?? null;
        const show = () => {
          const s = selected();
          info.textContent = s ? styleSummary(s.style) : '';
          preview.innerHTML = '';
          if (s) preview.append(tableStylePreview(s.style));
        };
        list.addEventListener('change', show);
        const body = h('div', {}, curLine, h('div', { style: 'display:grid;grid-template-columns:200px 1fr;gap:12px' }, list, h('div', {}, info, preview)));
        const act = async (what: 'current' | 'new' | 'modify' | 'delete') => {
          const s = selected();
          const nh = () => st.session.newHandle();
          if (what === 'current') {
            if (!s) return;
            const before = st.doc.header.get('$CTABLESTYLE');
            st.session.commit({ label: 'TABLESTYLE', ops: [{ kind: 'header', name: '$CTABLESTYLE', before, after: s.name }] });
            refresh(s.handle);
            return;
          }
          if (what === 'new') {
            const v = await form(
              '새 테이블 스타일 작성',
              [
                { key: 'name', label: '새 스타일 이름', type: 'text', value: `${s?.name ?? 'Standard'}의 복사` },
                { key: 'from', label: '시작', type: 'select', value: s?.handle ?? '', options: entries.map((e) => ({ value: e.handle, label: e.name })) },
              ],
              {
                ok: '계속',
                validate: (x) => {
                  const n = String(x.name).trim();
                  if (!n || /[<>/\\":;?*|,=`]/.test(n)) return '이름이 올바르지 않습니다.';
                  if (entries.some((e) => tableKey(e.name) === tableKey(n))) return '같은 이름의 스타일이 있습니다.';
                  return null;
                },
              },
            );
            if (!v) return;
            const from = entries.find((e) => e.handle === v.from)?.style ?? defaultTableStyle(isMetric(st.doc));
            const start = { ...cloneTableStyle(from), name: String(v.name).trim(), description: '' };
            const edited = await tableStyleEditor(st.doc, `새 테이블 스타일: ${start.name}`, start);
            if (!edited) return;
            const r = saveTableStyleOps(st.doc, nh, edited);
            st.session.commit({ label: 'TABLESTYLE', ops: r.ops });
            refresh(r.handle);
            return;
          }
          if (!s) return;
          if (what === 'modify') {
            const edited = await tableStyleEditor(st.doc, `테이블 스타일 수정: ${s.name}`, s.style);
            if (!edited) return;
            const r = saveTableStyleOps(st.doc, nh, edited, s.handle || undefined);
            // 스타일을 쓰는 표를 새 값으로 다시 그린다(같은 명령 취소 한 단계). 새로 만든 Standard는 스타일 없는 표가 쓴다
            const re = restyleTablesOps(st.doc, nh, r.handle, edited, !s.handle);
            const ops: EditOp[] = [...r.ops, ...re];
            st.session.commit({ label: 'TABLESTYLE', ops });
            const n = re.filter((o) => o.kind === 'modify').length;
            if (n) ctx.print(`스타일을 쓰는 표 ${n}개를 다시 그렸습니다.`);
            refresh(r.handle);
            return;
          }
          if (what === 'delete') {
            const cur = currentTableStyle(st.doc);
            if (tableKey(s.name) === 'STANDARD') return void ctx.print('Standard 스타일은 삭제할 수 없습니다.', 'err');
            if (cur?.handle === s.handle) return void ctx.print('현재 스타일은 삭제할 수 없습니다.', 'err');
            if (tablesUsingStyle(st.doc, s.handle).length) return void ctx.print('사용 중인 스타일은 삭제할 수 없습니다.', 'err');
            st.session.commit({ label: 'TABLESTYLE', ops: deleteTableStyleOps(st.doc, s.handle) });
            refresh();
          }
        };
        const back = dialog('테이블 스타일', body, [
          { label: '현재로 설정', run: () => (void act('current'), true) },
          { label: '새로 만들기...', run: () => (void act('new'), true) },
          { label: '수정...', run: () => (void act('modify'), true) },
          { label: '삭제', run: () => (void act('delete'), true) },
          { label: '닫기', primary: true },
        ]);
        const box = back.querySelector('.dialog') as HTMLElement | null;
        if (box) box.style.width = 'min(640px, 100%)';
        refresh();
        new MutationObserver((_, obs) => {
          if (!back.isConnected) {
            obs.disconnect();
            resolve();
          }
        }).observe(document.body, { childList: true });
      });
    },
  });

  // ------------------------------------------------------------- CTABLESTYLE
  app.register({
    name: 'CTABLESTYLE',
    title: '현재 테이블 스타일',
    async run(ctx, arg) {
      const st = app.active!;
      const cur = currentTableStyle(st.doc);
      let name = arg?.trim();
      if (!name) {
        const r = await ctx.getPoint(`CTABLESTYLE에 대한 새 값 입력 <${cur?.name ?? 'Standard'}>:`, { allowText: true });
        if (!('text' in r)) return;
        name = r.text.trim();
      }
      const f = listTableStyles(st.doc).find((s) => tableKey(s.name) === tableKey(name));
      if (!f) {
        ctx.print(`테이블 스타일 "${name}"을(를) 찾을 수 없습니다.`, 'err');
        return;
      }
      st.session.commit({ label: 'CTABLESTYLE', ops: [{ kind: 'header', name: '$CTABLESTYLE', before: st.doc.header.get('$CTABLESTYLE'), after: f.name }] });
    },
  });
}

