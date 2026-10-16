/**
 * 페이지 설정: PAGESETUP(페이지 설정 관리자 — 명명된 페이지 설정 목록, 현재로 설정, 새로 만들기, 수정, 이름 바꾸기, 삭제, 가져오기)과
 * 페이지 설정 대화상자(용지·방향·플롯 스타일 테이블·플롯 영역·간격띄우기/중심·축척·선가중치).
 * 명명된 페이지 설정은 도면의 ACAD_PLOTSETTINGS 사전의 PLOTSETTINGS 객체(DXF·DWG에 저장, 다시 열어도 남는다),
 * 배치·모형 탭의 페이지 설정은 그 LAYOUT의 플롯 설정이다. 관리자 안의 변경은 명령 취소 한 단계(같은 묶음).
 */
import type { CadDocument, CadObject, DictionaryObject, Layout, PlotSettings as PageSettings, PlotSettingsObject } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { namedPageSetups, type NamedPageSetup, validSetupName } from '../edit/script/pagesetup';
import { rootDictionary } from '../core/framevars';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { PAPERS } from './plot';
import { mediaName } from './layoutcmds';
import { paperInfo } from './scene';
import { ctbList } from './ctblib';
import { ask, h } from './ui/dom';
import { btn, checkIn, fail, group, numIn, numOf, pickList, resultDialog, row, selectIn, textIn } from './mgr-ui';

// ---------------------------------------------------------------------------
// 값 변환(대화상자 칸 ↔ PLOTSETTINGS)
// ---------------------------------------------------------------------------

export type PlotArea = 'layout' | 'extents' | 'display' | 'window' | 'limits';

export interface PageForm {
  /** PAPERS 열쇠, 목록에 없는 지금 용지면 'KEEP' */
  paper: string;
  landscape: boolean;
  /** 거꾸로 플롯(180° 회전) */
  upsideDown: boolean;
  styleSheet: string;
  area: PlotArea;
  window?: [number, number, number, number];
  /** 'fit' 또는 "용지:단위" */
  scale: string;
  offsetX: number;
  offsetY: number;
  centered: boolean;
  lineweights: boolean;
  /** 선가중치 축척(배치) */
  scaleLineweights: boolean;
}

/** DXF 75 표준 축척 번호 → "용지:단위"(미터·비율 축척만) */
const STD_SCALES: Record<number, string> = { 16: '1:1', 17: '1:2', 18: '1:4', 19: '1:8', 20: '1:10', 21: '1:16', 22: '1:20', 23: '1:30', 24: '1:40', 25: '1:50', 26: '1:100', 27: '2:1', 28: '4:1', 29: '8:1', 30: '10:1', 31: '100:1', 32: '1000:1' };

export const PAGE_SCALES = ['fit', '1:1', '1:2', '1:4', '1:5', '1:8', '1:10', '1:16', '1:20', '1:25', '1:30', '1:40', '1:50', '1:100', '1:200', '1:500', '1:1000', '2:1', '4:1', '5:1', '8:1', '10:1', '100:1'];

const AREA_TYPE: Record<PlotArea, number> = { display: 0, extents: 1, limits: 2, window: 4, layout: 5 };

function isLandscapeOf(p: PageSettings): boolean {
  const w = p.rotation & 1 ? p.paperHeight : p.paperWidth;
  const hgt = p.rotation & 1 ? p.paperWidth : p.paperHeight;
  return w >= hgt;
}

function paperKeyOf(p: PageSettings): string {
  const a = Math.min(p.paperWidth, p.paperHeight);
  const b = Math.max(p.paperWidth, p.paperHeight);
  return PAPERS.find((x) => Math.abs(x.w - a) < 1 && Math.abs(x.h - b) < 1)?.key ?? '';
}

/** PLOTSETTINGS → 칸 */
export function pageFormOf(p: PageSettings, model: boolean): PageForm {
  const n = p.scaleNumerator || 1;
  const d = p.scaleDenominator || 1;
  const fit = p.flags & 16 ? p.standardScaleType === 0 : false;
  const scale = fit ? 'fit' : p.flags & 16 && STD_SCALES[p.standardScaleType] ? STD_SCALES[p.standardScaleType]! : `${+n.toFixed(6)}:${+d.toFixed(6)}`;
  const area: PlotArea = model ? (p.plotType === 1 ? 'extents' : p.plotType === 2 ? 'limits' : p.plotType === 4 ? 'window' : 'display') : p.plotType === 1 ? 'extents' : p.plotType === 0 ? 'display' : p.plotType === 4 ? 'window' : 'layout';
  return {
    paper: paperKeyOf(p) || 'KEEP',
    landscape: isLandscapeOf(p),
    upsideDown: (p.rotation & 2) !== 0,
    styleSheet: p.styleSheet ?? '',
    area,
    window: p.plotType === 4 ? [p.windowMin.x, p.windowMin.y, p.windowMax.x, p.windowMax.y] : undefined,
    scale: model ? scale : scale === 'fit' ? 'fit' : '1:1',
    offsetX: p.plotOrigin.x,
    offsetY: p.plotOrigin.y,
    centered: (p.flags & 4) !== 0,
    lineweights: (p.flags & 128) !== 0 || (p.flags & 32) !== 0,
    scaleLineweights: (p.flags & 64) !== 0,
  };
}

/** 칸 → PLOTSETTINGS(base의 나머지 값은 그대로) */
export function pageSettingsOf(base: PageSettings, v: PageForm, model: boolean): PageSettings {
  const p: PageSettings = structuredClone(base);
  if (v.paper !== 'KEEP') {
    const paper = PAPERS.find((x) => x.key === v.paper)!;
    const w = v.landscape ? paper.h : paper.w;
    const hgt = v.landscape ? paper.w : paper.h;
    p.paperName = mediaName(v.paper, w, hgt);
    p.paperWidth = w;
    p.paperHeight = hgt;
    p.paperUnits = /^A\d$/.test(v.paper) ? 1 : (p.paperUnits ?? 1);
    p.rotation = v.upsideDown ? 2 : 0;
  } else {
    const was = isLandscapeOf(base);
    let r = base.rotation & 1;
    if (v.landscape !== was) r ^= 1;
    p.rotation = r | (v.upsideDown ? 2 : 0);
  }
  p.styleSheet = v.styleSheet;
  p.plotType = AREA_TYPE[v.area];
  if (v.area === 'window' && v.window) {
    p.windowMin = { x: v.window[0], y: v.window[1] };
    p.windowMax = { x: v.window[2], y: v.window[3] };
  }
  let flags = p.flags & ~(4 | 16 | 32 | 64 | 128 | 1024);
  if (model) flags |= 1024;
  if (v.centered) flags |= 4;
  if (v.lineweights) flags |= 128;
  if (v.scaleLineweights) flags |= 64;
  if (v.styleSheet) flags |= 32;
  if (v.scale === 'fit') {
    flags |= 16;
    p.standardScaleType = 0;
  } else {
    const [a, b] = v.scale.split(':').map(Number);
    p.scaleNumerator = a! > 0 ? a! : 1;
    p.scaleDenominator = b! > 0 ? b! : 1;
    const std = Object.entries(STD_SCALES).find(([, s]) => s === v.scale);
    if (std) {
      flags |= 16;
      p.standardScaleType = Number(std[0]);
    } else p.standardScaleType = 16;
  }
  p.flags = flags;
  p.plotOrigin = v.centered ? { x: 0, y: 0 } : { x: v.offsetX, y: v.offsetY };
  return p;
}

// ---------------------------------------------------------------------------
// 편집 작업
// ---------------------------------------------------------------------------

/** 배치의 플롯 설정을 바꾸는 작업(용지가 바뀌면 원점은 두고 한계를 새 크기로) */
export function layoutPlotOps(layout: Layout, plot: PageSettings): EditOp[] {
  const before = paperInfo(layout, null);
  const nl: Layout = { ...layout, plot };
  const after = paperInfo({ ...nl, limitsMin: { x: 0, y: 0 }, limitsMax: { x: 0, y: 0 } }, null);
  nl.limitsMin = { x: before.minX, y: before.minY };
  nl.limitsMax = { x: before.minX + (after.maxX - after.minX), y: before.minY + (after.maxY - after.minY) };
  return [{ kind: 'layout', key: tableKey(layout.blockName), before: layout, after: nl }];
}

/** ACAD_PLOTSETTINGS 사전(없으면 만드는 작업과 함께). 루트 사전이 없으면 null */
function plotSettingsDict(doc: CadDocument, newHandle: () => string, ops: EditOp[]): DictionaryObject | null {
  const { dict } = namedPageSetups(doc);
  if (dict) return dict;
  const root = rootDictionary(doc);
  if (!root) return null;
  const d: DictionaryObject = { type: 'DICTIONARY', handle: newHandle(), owner: root.handle, reactors: [root.handle], entries: new Map(), hardOwner: false, cloning: 1 };
  const rootAfter: DictionaryObject = { ...root, entries: new Map(root.entries) };
  rootAfter.entries.set('ACAD_PLOTSETTINGS', d.handle);
  delete rootAfter.dwgRaw;
  ops.push({ kind: 'object', key: d.handle, before: null, after: d }, { kind: 'object', key: root.handle, before: root as CadObject, after: rootAfter as CadObject });
  return d;
}

/** 명명된 페이지 설정을 만들거나(없으면) 바꾼다 */
export function saveNamedSetupOps(doc: CadDocument, name: string, plot: PageSettings, newHandle: () => string): EditOp[] | null {
  const ops: EditOp[] = [];
  const have = namedPageSetups(doc);
  const hit = have.dict ? [...have.dict.entries].find(([k]) => k.toUpperCase() === name.toUpperCase()) : undefined;
  if (hit) {
    const old = doc.objects.get(hit[1]);
    if (old?.type !== 'PLOTSETTINGS') return null;
    const after: PlotSettingsObject = { ...(old as PlotSettingsObject), plot: { ...structuredClone(plot), pageSetupName: hit[0] } };
    delete after.dwgRaw;
    return [{ kind: 'object', key: old.handle, before: old, after }];
  }
  const dict = plotSettingsDict(doc, newHandle, ops);
  if (!dict) return null;
  const hd = newHandle();
  const obj: PlotSettingsObject = { type: 'PLOTSETTINGS', handle: hd, owner: dict.handle, reactors: [dict.handle], plot: { ...structuredClone(plot), pageSetupName: name } };
  ops.push({ kind: 'object', key: hd, before: null, after: obj });
  // 사전이 이 작업에서 새로 만든 것이면 그 객체를, 아니면 지금 사전을 고친다
  const created = ops.find((o) => o.kind === 'object' && o.key === dict.handle && o.before === null);
  const cur = created && created.kind === 'object' ? (created.after as DictionaryObject) : dict;
  const after: DictionaryObject = { ...cur, entries: new Map(cur.entries) };
  after.entries.set(name, hd);
  delete after.dwgRaw;
  if (created && created.kind === 'object') created.after = after;
  else ops.push({ kind: 'object', key: dict.handle, before: dict, after });
  return ops;
}

/** 이름 바꾸기(이 이름을 따르던 배치도 따라간다) */
export function renameNamedSetupOps(doc: CadDocument, oldName: string, newName: string): EditOp[] | null {
  const { dict } = namedPageSetups(doc);
  const hit = dict ? [...dict.entries].find(([k]) => k.toUpperCase() === oldName.toUpperCase()) : undefined;
  if (!dict || !hit) return null;
  const obj = doc.objects.get(hit[1]);
  if (obj?.type !== 'PLOTSETTINGS') return null;
  const entries = new Map<string, string>();
  for (const [k, v] of dict.entries) entries.set(k === hit[0] ? newName : k, v);
  const dAfter: DictionaryObject = { ...dict, entries };
  delete dAfter.dwgRaw;
  const oAfter: PlotSettingsObject = { ...(obj as PlotSettingsObject), plot: { ...(obj as PlotSettingsObject).plot, pageSetupName: newName } };
  delete oAfter.dwgRaw;
  const ops: EditOp[] = [
    { kind: 'object', key: dict.handle, before: dict, after: dAfter },
    { kind: 'object', key: obj.handle, before: obj, after: oAfter },
  ];
  for (const l of doc.layouts) if (l.plot.pageSetupName && l.plot.pageSetupName.toUpperCase() === hit[0].toUpperCase()) ops.push({ kind: 'layout', key: tableKey(l.blockName), before: l, after: { ...l, plot: { ...l.plot, pageSetupName: newName } } });
  return ops;
}

/** 삭제(따르던 배치는 이름만 지운다 — 설정 값은 배치에 남는다) */
export function deleteNamedSetupOps(doc: CadDocument, name: string): EditOp[] | null {
  const { dict } = namedPageSetups(doc);
  const hit = dict ? [...dict.entries].find(([k]) => k.toUpperCase() === name.toUpperCase()) : undefined;
  if (!dict || !hit) return null;
  const obj = doc.objects.get(hit[1]);
  const entries = new Map(dict.entries);
  entries.delete(hit[0]);
  const dAfter: DictionaryObject = { ...dict, entries };
  delete dAfter.dwgRaw;
  const ops: EditOp[] = [{ kind: 'object', key: dict.handle, before: dict, after: dAfter }];
  if (obj) ops.push({ kind: 'object', key: obj.handle, before: obj, after: null });
  for (const l of doc.layouts) if (l.plot.pageSetupName && l.plot.pageSetupName.toUpperCase() === hit[0].toUpperCase()) ops.push({ kind: 'layout', key: tableKey(l.blockName), before: l, after: { ...l, plot: { ...l.plot, pageSetupName: '' } } });
  return ops;
}

/** 명명된 페이지 설정을 배치에 적용(현재로 설정) */
export function applyNamedSetupOps(layout: Layout, setup: NamedPageSetup): EditOp[] {
  const model = tableKey(layout.blockName) === MODEL_SPACE;
  const plot: PageSettings = { ...structuredClone(setup.plot), pageSetupName: setup.name };
  plot.flags = model ? plot.flags | 1024 : plot.flags & ~1024;
  return layoutPlotOps(layout, plot);
}

// ---------------------------------------------------------------------------
// 페이지 설정 대화상자
// ---------------------------------------------------------------------------

const STYLE_SHEETS = ['', 'monochrome.ctb', 'Grayscale.ctb', 'acad.ctb', 'Screening 50%.ctb', 'Fill Patterns.ctb'];

export interface PageDialogResult {
  form: PageForm;
  /** 윈도우 영역을 화면에서 다시 고르기 */
  pickWindow: boolean;
}

/** 페이지 설정 칸들(PLOT 대화상자도 쓴다). read로 지금 칸 값을 읽는다 */
export function pageFields(v: PageForm, model: boolean): { el: HTMLElement; read(): PageForm; set(f: PageForm): void; onWindow(f: () => void): void } {
  const paper = selectIn([...(v.paper === 'KEEP' ? [{ value: 'KEEP', label: '지금 용지' }] : []), ...PAPERS.map((x) => ({ value: x.key, label: x.label }))], v.paper, '용지 크기');
  const sheets = [...new Set([...STYLE_SHEETS, ...ctbList().map((t) => t.name), v.styleSheet])];
  const style = selectIn(sheets.map((x) => ({ value: x, label: x || '없음' })), v.styleSheet, '플롯 스타일 테이블');
  const areaOpts = model
    ? [
        { value: 'display', label: '화면표시' },
        { value: 'extents', label: '범위' },
        { value: 'limits', label: '한계' },
        { value: 'window', label: '윈도우' },
      ]
    : [
        { value: 'layout', label: '배치' },
        { value: 'extents', label: '범위' },
        { value: 'display', label: '화면표시' },
        { value: 'window', label: '윈도우' },
      ];
  const area = selectIn(areaOpts, v.area, '플롯 대상');
  const winBtn = btn('윈도우(O)<', () => windowCb?.());
  let windowCb: (() => void) | null = null;
  let win = v.window;
  const centered = checkIn(v.centered, '플롯의 중심');
  const ox = numIn(v.offsetX, '간격띄우기 X');
  const oy = numIn(v.offsetY, '간격띄우기 Y');
  const scale = selectIn([...new Set([...PAGE_SCALES, v.scale])].map((x) => ({ value: x, label: x === 'fit' ? '용지에 맞춤' : `${x} (mm = 단위)` })), v.scale, '축척');
  const lw = checkIn(v.lineweights, '객체의 선가중치 플롯');
  const slw = checkIn(v.scaleLineweights, '선가중치 축척');
  const land = selectIn(
    [
      { value: 'P', label: '세로(A)' },
      { value: 'L', label: '가로(N)' },
    ],
    v.landscape ? 'L' : 'P',
    '도면 방향',
  );
  const upside = checkIn(v.upsideDown, '대칭으로 플롯');
  const sync = () => {
    ox.disabled = oy.disabled = centered.checked;
    winBtn.disabled = area.value !== 'window';
  };
  centered.addEventListener('change', sync);
  area.addEventListener('change', sync);
  sync();
  const el = h(
    'div',
    { class: 'mgr-dlg' },
    h('div', { class: 'mgr-cols' }, group('용지 크기(Z)', paper), group('플롯 스타일 테이블(펜 지정)(G)', style)),
    h('div', { class: 'mgr-cols' }, group('플롯 영역', row('플롯 대상(W)', area), winBtn), group('도면 방향', land, row('대칭으로 플롯(-)', upside))),
    h('div', { class: 'mgr-cols' }, group('플롯 간격띄우기(인쇄 가능 영역의 원점 기준)', row('X(mm)', ox), row('Y(mm)', oy), row('플롯의 중심(C)', centered)), group('플롯 축척', row('축척(S)', scale), row('선가중치 축척(L)', slw))),
    group('플롯 옵션', row('객체의 선가중치 플롯', lw)),
  );
  const read = (): PageForm => ({
    paper: paper.value,
    landscape: land.value === 'L',
    upsideDown: upside.checked,
    styleSheet: style.value,
    area: area.value as PlotArea,
    window: win,
    scale: scale.value,
    offsetX: numOf(ox) || 0,
    offsetY: numOf(oy) || 0,
    centered: centered.checked,
    lineweights: lw.checked,
    scaleLineweights: slw.checked,
  });
  const set = (f: PageForm) => {
    if (f.paper !== 'KEEP') paper.value = f.paper;
    if (![...style.options].some((o) => o.value === f.styleSheet)) style.append(h('option', { value: f.styleSheet }, f.styleSheet || '없음'));
    style.value = f.styleSheet;
    if ([...area.options].some((o) => o.value === f.area)) area.value = f.area;
    win = f.window;
    if (![...scale.options].some((o) => o.value === f.scale)) scale.append(h('option', { value: f.scale }, `${f.scale} (mm = 단위)`));
    scale.value = f.scale;
    ox.value = String(f.offsetX);
    oy.value = String(f.offsetY);
    centered.checked = f.centered;
    lw.checked = f.lineweights;
    slw.checked = f.scaleLineweights;
    land.value = f.landscape ? 'L' : 'P';
    upside.checked = f.upsideDown;
    sync();
  };
  return { el, read, set, onWindow: (f) => (windowCb = f) };
}

/** 페이지 설정 대화상자(취소면 null). 윈도우(O)를 누르면 pickWindow로 닫는다 */
export async function pageSetupDialog(title: string, v: PageForm, model: boolean, extraNote?: string): Promise<PageDialogResult | null> {
  const f = pageFields(v, model);
  let pick = false;
  let submitNow: (() => void) | null = null;
  f.onWindow(() => {
    pick = true;
    submitNow?.();
  });
  const body = h('div', { class: 'mgr-dlg' }, f.el, extraNote ? h('div', { class: 'mgr-note' }, extraNote) : null);
  return resultDialog<PageDialogResult>(title, body, {
    width: 680,
    bind: (s) => (submitNow = s),
    submit: () => {
      const r = f.read();
      if (!r.centered && (!Number.isFinite(r.offsetX) || !Number.isFinite(r.offsetY))) return fail('간격띄우기: 숫자를 입력하십시오.');
      return { form: r, pickWindow: pick };
    },
  });
}

/** 화면에서 윈도우 두 구석 */
export async function askPlotWindow(ctx: CommandContext): Promise<[number, number, number, number] | null> {
  const a = await ctx.getPoint('첫 번째 구석 지정:');
  if (!('point' in a)) return null;
  const p = a.point;
  const b = await ctx.getPoint('반대 구석 지정:', { base: p, rubber: (q) => [{ pts: [p.x, p.y, q.x, p.y, q.x, q.y, p.x, q.y], closed: true, dashed: true }] });
  if (!('point' in b)) return null;
  const q = b.point;
  return [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)];
}

/** 대화상자로 페이지 설정 하나를 고친다(윈도우 고르기 왕복 포함) */
async function editPage(ctx: CommandContext, title: string, plot: PageSettings, model: boolean): Promise<PageSettings | null> {
  let form = pageFormOf(plot, model);
  for (;;) {
    const r = await pageSetupDialog(title, form, model);
    if (!r) return null;
    form = r.form;
    if (r.pickWindow) {
      const w = await askPlotWindow(ctx);
      if (w) form = { ...form, window: w, area: 'window' };
      continue;
    }
    return pageSettingsOf(plot, form, model);
  }
}

// ---------------------------------------------------------------------------
// 페이지 설정 관리자
// ---------------------------------------------------------------------------

type Row = { kind: 'layout'; name: string; layout: Layout } | { kind: 'named'; name: string; setup: NamedPageSetup };

function describe(p: PageSettings): string {
  const size = `${+p.paperWidth.toFixed(2)} × ${+p.paperHeight.toFixed(2)} ${p.paperUnits === 0 ? 'in' : 'mm'}`;
  const ori = isLandscapeOf(p) ? '가로' : '세로';
  return `장치: ${p.printerName || '없음'} · 용지: ${p.paperName || size} (${size}, ${ori}) · 플롯 스타일: ${p.styleSheet || '없음'}`;
}

type ManagerAction = { act: 'current' | 'new' | 'modify' | 'rename' | 'delete' | 'import' | 'close'; row: Row | null };

function managerDialog(st: DocState, layout: Layout): Promise<ManagerAction | null> {
  const model = tableKey(layout.blockName) === MODEL_SPACE;
  const label = model ? '모형' : layout.name;
  const rows: Row[] = [{ kind: 'layout', name: `*${label}${layout.plot.pageSetupName ? ` (${layout.plot.pageSetupName})` : ''}*`, layout }];
  for (const s of namedPageSetups(st.doc).items) if (s.model === model) rows.push({ kind: 'named', name: s.name, setup: s });
  const detail = h('div', { class: 'mgr-note', style: 'min-height:34px' });
  const list = pickList<Row>(['페이지 설정'], (r) => [r.name], {
    height: 220,
    onPick: (r) => (detail.textContent = r ? describe(r.kind === 'layout' ? r.layout.plot : r.setup.plot) : ''),
    onActivate: () => go('current'),
  });
  let action: ManagerAction['act'] = 'close';
  let submitNow: (() => void) | null = null;
  const go = (a: ManagerAction['act']) => {
    action = a;
    submitNow?.();
  };
  const body = h(
    'div',
    { class: 'mgr-dlg' },
    h('div', { class: 'mgr-note' }, `현재 배치: ${label}`),
    h('div', { class: 'mgr-cols' }, list.el, h('div', { class: 'mgr-btns', style: 'flex-direction:column;flex:0 0 140px;min-width:140px' }, btn('현재로 설정(S)', () => go('current')), btn('새로 만들기(N)...', () => go('new')), btn('수정(M)...', () => go('modify')), btn('이름 바꾸기(R)...', () => go('rename')), btn('삭제(D)', () => go('delete')), btn('가져오기(I)...', () => go('import')))),
    group('선택된 페이지 설정 세부 정보', detail),
  );
  list.refresh(rows);
  list.select((r) => r.kind === 'layout');
  return resultDialog<ManagerAction>('페이지 설정 관리자', body, {
    ok: '닫기',
    cancel: null,
    width: 600,
    bind: (s) => (submitNow = s),
    submit: () => {
      const r = list.selected();
      if (action !== 'close' && action !== 'new' && action !== 'import' && !r) return fail('페이지 설정을 고르십시오.');
      if ((action === 'rename' || action === 'delete') && r?.kind !== 'named') return fail('배치 자신의 페이지 설정은 이름을 바꾸거나 삭제할 수 없습니다.');
      if (action === 'current' && r?.kind === 'layout') return fail('이미 이 배치의 페이지 설정입니다.');
      const a = { act: action, row: r };
      action = 'close';
      return a;
    },
  });
}

async function askSetupName(title: string, label: string, def: string, taken: (n: string) => boolean, fromRows?: { value: string; label: string }[]): Promise<{ name: string; from: string } | null> {
  const name = textIn(def, label);
  const from = fromRows ? selectIn(fromRows, fromRows[0]!.value, '시작') : null;
  const body = h('div', { class: 'mgr-dlg' }, row(label, name), from ? row('시작(S)', from) : null);
  return resultDialog(title, body, {
    width: 420,
    submit: () => {
      const n = name.value.trim();
      if (!validSetupName(n)) return fail('이름에 쓸 수 없는 문자가 있습니다.');
      if (taken(n)) return fail(`페이지 설정 "${n}"이(가) 이미 있습니다.`);
      return { name: n, from: from?.value ?? '' };
    },
  });
}

/** PAGESETUP: 페이지 설정 관리자 */
export async function runPageSetupManager(app: App, ctx: CommandContext, importSetups: () => Promise<void>): Promise<void> {
  const st = app.active!;
  if (st.blockEdit) {
    ctx.print('블록 편집기에서는 쓸 수 없습니다.', 'err');
    return;
  }
  const commit = (ops: EditOp[] | null, msg: string) => {
    if (!ops) {
      ctx.print('이 도면에 이름 있는 객체 사전이 없어 페이지 설정을 저장할 수 없습니다.', 'err');
      return;
    }
    if (!ops.length) return;
    st.session.commit({ label: 'PAGESETUP', ops, group: ctx.group });
    app.view.requestRender();
    ctx.print(msg);
  };
  for (;;) {
    const layout = st.layoutFor(st.displaySpace);
    if (!layout) return;
    const model = tableKey(layout.blockName) === MODEL_SPACE;
    const r = await managerDialog(st, layout);
    if (!r || r.act === 'close') return;
    const row0 = r.row;
    const named = () => namedPageSetups(st.doc).items;
    const taken = (n: string) => named().some((x) => x.name.toUpperCase() === n.toUpperCase());
    switch (r.act) {
      case 'current':
        if (row0?.kind === 'named') commit(applyNamedSetupOps(layout, row0.setup), `페이지 설정 "${row0.setup.name}"을(를) ${model ? '모형' : `배치 "${layout.name}"`}에 적용했습니다.`);
        break;
      case 'modify': {
        if (!row0) break;
        if (row0.kind === 'layout') {
          const np = await editPage(ctx, `페이지 설정 - ${model ? '모형' : layout.name}`, layout.plot, model);
          if (np) commit(layoutPlotOps(st.layoutFor(st.displaySpace)!, { ...np, pageSetupName: '' }), `${model ? '모형' : `배치 "${layout.name}"`}의 페이지 설정을 바꿨습니다.`);
        } else {
          const np = await editPage(ctx, `페이지 설정 - ${row0.setup.name}`, row0.setup.plot, model);
          if (np) commit(saveNamedSetupOps(st.doc, row0.setup.name, np, () => st.session.newHandle()), `페이지 설정 "${row0.setup.name}"을(를) 고쳤습니다.`);
        }
        break;
      }
      case 'new': {
        let n = 1;
        while (taken(`설정${n}`)) n++;
        const label = model ? '모형' : layout.name;
        const r2 = await askSetupName('새 페이지 설정', '새 페이지 설정 이름(N)', `설정${n}`, taken, [
          { value: '*layout*', label: `*${label}*` },
          { value: '', label: '<없음>' },
          ...named()
            .filter((x) => x.model === model)
            .map((x) => ({ value: x.name, label: x.name })),
        ]);
        if (!r2) break;
        const base = r2.from === '*layout*' ? layout.plot : r2.from ? (named().find((x) => x.name === r2.from)?.plot ?? layout.plot) : { ...layout.plot, styleSheet: '', plotOrigin: { x: 0, y: 0 } };
        const np = await editPage(ctx, `페이지 설정 - ${r2.name}`, { ...base, pageSetupName: r2.name }, model);
        if (np) commit(saveNamedSetupOps(st.doc, r2.name, np, () => st.session.newHandle()), `페이지 설정 "${r2.name}"을(를) 만들었습니다.`);
        break;
      }
      case 'rename': {
        if (row0?.kind !== 'named') break;
        const r2 = await askSetupName('페이지 설정 이름 바꾸기', '새 이름', row0.setup.name, (x) => x.toUpperCase() !== row0.setup.name.toUpperCase() && taken(x));
        if (r2 && r2.name !== row0.setup.name) commit(renameNamedSetupOps(st.doc, row0.setup.name, r2.name), `페이지 설정 "${row0.setup.name}"의 이름을 "${r2.name}"(으)로 바꿨습니다.`);
        break;
      }
      case 'delete': {
        if (row0?.kind !== 'named') break;
        const a = await ask('페이지 설정 - 삭제', `페이지 설정 "${row0.setup.name}"을(를) 삭제하시겠습니까?`, [
          { label: '삭제', value: 'Y', primary: true },
          { label: '취소', value: 'N' },
        ]);
        if (a === 'Y') commit(deleteNamedSetupOps(st.doc, row0.setup.name), `페이지 설정 "${row0.setup.name}"을(를) 삭제했습니다.`);
        break;
      }
      case 'import':
        await importSetups();
        break;
    }
  }
}
