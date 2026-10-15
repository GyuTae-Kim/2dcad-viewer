/**
 * 3D 패널: 2D 팔레트 자리(오른쪽, 760px 미만이면 아래 시트)에 놓이는 3D 문서 정보.
 *
 * 탭: NC = 코드·공구·정보(+재생 막대), MPR = 가공·변수·코드·정보, STEP = 제품·정보, SKP = 태그·재질·정보.
 * 아래 띠에는 고른 객체(Pick3d)와 측정 결과를 늘 보인다. 코드 보기는 가상 목록(보이는 줄만 DOM).
 */
import { MOVE_KIND_NAMES, NC_DIALECT_NAMES, type NcDialect } from '../../formats/nc/model';
import { sourceLine } from '../../formats/nc/text';
import { formatBytes, h } from '../ui/dom';
import { icon } from '../ui/icons';
import { NARROW_WIDTH, sheetFraction } from '../ui/layout';
import {
  docLabel,
  sceneCounts,
  skpMaterials,
  stepProducts,
  subtreeMeshIds,
  toolGroup,
  toolItems,
  unitLabel,
  type Doc3d,
  type ProductNode,
} from './doc';
import type { View3dManager } from './manager';
import { PLAY_SPEEDS, formatDuration, type PlaySpeed } from './playback';
import { VirtualList } from './vlist';

type TabKey = 'code' | 'tools' | 'info' | 'ops' | 'vars' | 'tree' | 'tags';

const KIND_LABEL: Record<string, string> = { rapid: '급속', feed: '직선 이송', arc: '원호 이송', drill: '드릴' };
const MPR_KIND: Record<string, string> = {
  drillV: '수직 구멍',
  drillH: '수평 구멍',
  contour: '윤곽',
  groove: '홈',
  pocket: '포켓',
  comment: '주석',
  other: '기타',
};

/** 숫자 → 글(소수 셋째 자리까지, 끝 0 없이) */
export function fmtNum(v: number | undefined | null, digits = 3): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) ? '0' : r.toLocaleString('ko-KR', { maximumFractionDigits: digits });
}

function fmtPt(p: readonly number[] | undefined): string {
  if (!p) return '—';
  return `${fmtNum(p[0])}, ${fmtNum(p[1])}, ${fmtNum(p[2])}`;
}

function rgbCss(c: readonly number[]): string {
  return `rgb(${Math.round((c[0] ?? 0) * 255)},${Math.round((c[1] ?? 0) * 255)},${Math.round((c[2] ?? 0) * 255)})`;
}

const row = (k: string, v: string): HTMLElement => h('div', { class: 'prop-row' }, h('span', { class: 'k' }, k), h('span', { class: 'v', title: v }, v));
const group = (title: string, ...children: (Node | null)[]): HTMLElement => h('div', { class: 'prop-group' }, h('h4', {}, title), ...children);

export class View3dPanel {
  readonly el: HTMLDivElement;
  private readonly tabsEl: HTMLDivElement;
  private readonly play: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly foot: HTMLDivElement;
  private doc: Doc3d | null = null;
  private code: VirtualList | null = null;
  private codeDoc: Doc3d | null = null;
  private codeSrc: object | null = null;
  private expanded = new WeakMap<Doc3d, Set<string>>();
  private lastPlayLine = -2;
  private playEls: { btn: HTMLButtonElement; range: HTMLInputElement; time: HTMLSpanElement; line: HTMLSpanElement; speed: HTMLSelectElement } | null = null;
  private width = 320;

  constructor(
    private readonly mgr: View3dManager,
    private readonly parent: HTMLElement,
  ) {
    this.tabsEl = h('div', { class: 'palette-tabs', role: 'tablist' });
    const close = h('button', { class: 'icon-btn', title: '3D 패널 닫기', 'aria-label': '3D 패널 닫기', html: icon('close2') });
    close.addEventListener('click', () => this.mgr.togglePanel(false));
    this.play = h('div', { class: 'v3d-play', hidden: true });
    this.body = h('div', { class: 'palette-body v3d-body' });
    this.foot = h('div', { class: 'v3d-sel', hidden: true });
    const grip = h('div', { class: 'palette-resize', 'aria-hidden': 'true' });
    this.el = h('div', { class: 'palette v3d-panel', hidden: true, 'aria-label': '3D 패널' }, grip, h('div', { class: 'palette-head' }, this.tabsEl, close), this.play, this.body, this.foot);
    parent.append(this.el);
    try {
      const w = Number(localStorage.getItem('opencad.palette.width'));
      if (w >= 240 && w <= 900) this.width = w;
    } catch {
      /* 저장소를 못 쓰는 환경 */
    }
    this.el.style.setProperty('--palette-w', `${this.width}px`);
    this.bindResize(grip);
  }

  /** 팔레트와 같은 손잡이 규칙: 넓으면 폭, 좁으면(아래 시트) 높이 */
  private bindResize(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (ev) => {
      grip.setPointerCapture(ev.pointerId);
      const asSheet = window.innerWidth < NARROW_WIDTH;
      const x0 = ev.clientX;
      const w0 = this.el.getBoundingClientRect().width;
      const host = this.parent.getBoundingClientRect();
      let sheet = 0.5;
      const move = (e: PointerEvent) => {
        if (asSheet) {
          sheet = sheetFraction((host.bottom - e.clientY) / Math.max(1, host.height));
          this.parent.style.setProperty('--sheet-h', `${Math.round(sheet * 100)}%`);
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

  // ───────────────────────── 바깥에서 부르는 것 ─────────────────────────

  show(d: Doc3d): void {
    if (this.doc !== d) this.saveScroll();
    this.doc = d;
    const tabs = this.tabsFor(d);
    if (!tabs.some(([k]) => k === d.panelTab)) d.panelTab = tabs[0]![0];
    this.lastPlayLine = -2;
    this.buildPlay();
    this.render();
  }

  hide(): void {
    this.saveScroll();
    this.doc = null;
    this.el.hidden = true;
  }

  setOpen(on: boolean): void {
    this.el.hidden = !on || !this.doc;
    if (!this.el.hidden && this.doc?.panelTab === 'code') this.code?.reveal(Math.max(0, this.doc.selLine));
  }

  onPick(reveal = false): void {
    if (!this.doc) return;
    const t = this.doc.panelTab;
    if (t === 'ops' || t === 'tree' || t === 'info' || t === 'tools') this.render();
    else if (t === 'code') {
      this.code?.refresh();
      if (reveal && this.doc.selLine >= 0) this.code?.reveal(this.doc.selLine, true);
    }
    if (reveal && t === 'ops') this.body.querySelector('tr.current')?.scrollIntoView({ block: 'nearest' });
    if (reveal && t === 'tree') this.body.querySelector('.v3d-tree .sel')?.scrollIntoView({ block: 'nearest' });
    this.renderFoot();
  }

  onSelectLine(reveal: boolean): void {
    if (!this.doc) return;
    if (this.doc.panelTab === 'code') {
      this.code?.refresh();
      if (reveal && this.doc.selLine >= 0) this.code?.reveal(this.doc.selLine, true);
    }
    this.renderFoot();
  }

  onMeasure(): void {
    this.renderFoot();
  }

  onPlayback(): void {
    const p = this.playEls;
    const info = this.mgr.playbackInfo();
    if (!p || !info) return;
    const playing = this.mgr.isPlaying;
    p.btn.textContent = playing ? '멈춤' : '재생';
    p.btn.classList.toggle('on', playing);
    p.range.value = String(info.total > 0 ? Math.round((info.sec / info.total) * 1000) : 1000);
    p.time.textContent = `${formatDuration(info.sec)} / ${formatDuration(info.total)}`;
    p.line.textContent = info.line >= 0 ? `줄 ${(info.line + 1).toLocaleString()}` : '전체 경로';
    p.speed.value = String(this.mgr.speed);
    if (info.line !== this.lastPlayLine) {
      this.lastPlayLine = info.line;
      if (this.doc?.panelTab === 'code' && this.code) {
        this.code.refresh();
        if (info.line >= 0) this.code.reveal(info.line);
      }
    }
  }

  // ───────────────────────── 틀 ─────────────────────────

  private tabsFor(d: Doc3d): [TabKey, string][] {
    if (d.nc) return [
      ['code', '코드'],
      ['tools', '공구'],
      ['info', '정보'],
    ];
    if (d.mpr) return [
      ['ops', '가공'],
      ['vars', '변수'],
      ['code', '코드'],
      ['info', '정보'],
    ];
    if (d.format === 'step') return [
      ['tree', '제품'],
      ['info', '정보'],
    ];
    if (d.format === 'skp') return [
      ['tags', '태그·재질'],
      ['info', '정보'],
    ];
    return [['info', '정보']];
  }

  private saveScroll(): void {
    const d = this.doc;
    if (d && d.panelTab === 'code' && this.codeDoc === d && this.code?.el.isConnected) d.codeScroll = this.code.scrollTop;
  }

  private render(): void {
    const d = this.doc;
    if (!d) return;
    this.tabsEl.innerHTML = '';
    for (const [k, label] of this.tabsFor(d)) {
      const b = h('button', { class: `palette-tab ${k === d.panelTab ? 'active' : ''}`, role: 'tab', 'aria-selected': k === d.panelTab ? 'true' : 'false' }, label);
      b.addEventListener('click', () => {
        if (d.panelTab === k) return;
        this.saveScroll();
        d.panelTab = k;
        this.render();
      });
      this.tabsEl.append(b);
    }
    const scroll = this.body.scrollTop;
    const sameTab = this.body.dataset.tab === `${d.id}:${d.panelTab}`;
    this.body.dataset.tab = `${d.id}:${d.panelTab}`;
    this.body.classList.toggle('v3d-code-body', d.panelTab === 'code');
    if (d.panelTab === 'code') {
      this.renderCode(d);
    } else {
      this.body.innerHTML = '';
      switch (d.panelTab) {
        case 'tools':
          this.renderTools(d);
          break;
        case 'ops':
          this.renderOps(d);
          break;
        case 'vars':
          this.renderVars(d);
          break;
        case 'tree':
          this.renderTree(d);
          break;
        case 'tags':
          this.renderTags(d);
          break;
        default:
          this.renderInfo(d);
      }
      if (sameTab) this.body.scrollTop = scroll;
    }
    this.renderFoot();
    this.onPlayback();
  }

  // ───────────────────────── 재생 막대(NC) ─────────────────────────

  private buildPlay(): void {
    const d = this.doc;
    this.play.innerHTML = '';
    this.playEls = null;
    this.play.hidden = !d?.nc || !d.nc.moves.count;
    if (this.play.hidden) return;
    const mk = (label: string, title: string, run: () => void): HTMLButtonElement => {
      const b = h('button', { class: 'btn small', title }, label);
      b.addEventListener('click', run);
      return b;
    };
    const first = mk('처음', '처음으로', () => this.mgr.seek(0));
    const btn = mk('재생', '재생 / 멈춤 (Space)', () => this.mgr.togglePlay());
    const all = mk('전체', '전체 경로 보기', () => {
      this.mgr.stopPlay();
      this.mgr.seek(null);
    });
    const speed = h('select', { 'aria-label': '재생 속도', title: '재생 속도' }) as HTMLSelectElement;
    for (const s of PLAY_SPEEDS) speed.append(h('option', { value: String(s) }, `×${s}`));
    speed.addEventListener('change', () => this.mgr.setSpeed(Number(speed.value) as PlaySpeed));
    const range = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: 1000, 'aria-label': '재생 위치' }) as HTMLInputElement;
    range.addEventListener('input', () => {
      const info = this.mgr.playbackInfo();
      if (!info) return;
      this.mgr.seek((Number(range.value) / 1000) * info.total);
    });
    const time = h('span', { class: 'v3d-time' });
    const line = h('span', { class: 'v3d-time' });
    this.play.append(h('div', { class: 'v3d-play-row' }, first, btn, all, speed, time, line), range);
    this.playEls = { btn, range, time, line, speed };
  }

  // ───────────────────────── 코드 보기 ─────────────────────────

  private lineCount(d: Doc3d): number {
    if (d.nc) return d.nc.source.lineCount;
    if (d.mpr) return d.mpr.lines.length;
    return 0;
  }

  private lineText(d: Doc3d, i: number): string {
    if (d.nc) return sourceLine(d.nc.source, i);
    if (d.mpr) return d.mpr.lines[i] ?? '';
    return '';
  }

  /** 코드 보기 목록은 하나를 만들어 문서마다 줄 수·위치만 바꿔 쓴다 */
  private ensureCode(): VirtualList {
    if (this.code) return this.code;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    this.code = new VirtualList({
      rowHeight: coarse ? 22 : 18,
      className: 'v3d-code',
      render: (i, el) => {
        const doc = this.doc;
        if (!doc) return;
        const digits = String(Math.max(1, this.lineCount(doc))).length;
        const play = this.mgr.playbackInfo();
        el.className = `vlist-row${i === doc.selLine ? ' sel' : ''}${play && play.line === i ? ' cur' : ''}`;
        el.textContent = '';
        el.append(h('span', { class: 'ln', style: `width:${digits + 1}ch` }, String(i + 1)), h('span', { class: 'tx' }, this.lineText(doc, i).replace(/\t/g, '    ')));
      },
      onClick: (i) => this.clickLine(i),
    });
    return this.code;
  }

  private renderCode(d: Doc3d): void {
    const c = this.ensureCode();
    const src: object | null = d.nc ?? d.mpr;
    if (this.codeDoc !== d || this.codeSrc !== src) {
      this.codeDoc = d;
      this.codeSrc = src;
      c.setCount(this.lineCount(d));
    }
    this.body.innerHTML = '';
    this.body.append(c.el);
    requestAnimationFrame(() => {
      if (this.codeDoc !== d || this.doc !== d) return;
      c.scrollTop = d.codeScroll;
      if (d.selLine >= 0) c.reveal(d.selLine);
      else c.refresh();
    });
  }

  private clickLine(i: number): void {
    const d = this.doc;
    if (!d) return;
    if (d.nc) {
      this.mgr.selectLine(d.selLine === i ? -1 : i);
      return;
    }
    if (d.mpr) {
      // 그 줄을 품은 가공(시작 줄이 i 이하인 마지막 가공)
      const ops = this.mprOps(d);
      let best = -1;
      for (const o of ops) if (typeof o.line === 'number' && o.line <= i && (best < 0 || o.line >= (ops[best]!.line ?? -1))) best = o.index;
      if (best >= 0) this.mgr.selectMprOp(best);
      d.selLine = i;
      this.code?.refresh();
      this.renderFoot();
    }
  }

  // ───────────────────────── NC 공구 ─────────────────────────

  private renderTools(d: Doc3d): void {
    const nc = d.nc;
    if (!nc) return;
    type ToolRow = (typeof nc.tools)[number] & { color?: number[] };
    const meta = d.scene.meta as { tools?: ToolRow[] } | undefined;
    const tools: ToolRow[] = meta?.tools ?? nc.tools;
    if (!tools.length) {
      this.body.append(h('div', { class: 'empty' }, '공구 정보가 없습니다.'));
      return;
    }
    const u = unitLabel(d.scene.units);
    const tbody = h('tbody');
    for (const t of tools) {
      const g = toolGroup(d.scene, t.number);
      const visible = g ? !d.hiddenGroups.has(g) : true;
      const eye = h('button', { class: `toggle ${visible ? '' : 'off'}`, title: visible ? '숨기기' : '보이기', 'aria-label': `${g ?? `T${t.number}`} ${visible ? '숨기기' : '보이기'}`, html: icon(visible ? 'eye' : 'eyeOff') });
      eye.disabled = !g;
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!g) return;
        this.mgr.setGroupVisible(g, d.hiddenGroups.has(g));
        this.render();
      });
      const items = toolItems(d.scene, t.number);
      const cur = items.length > 0 && items.every((id) => d.highlight.includes(id)) && d.highlight.length === items.length;
      const tr = h(
        'tr',
        { class: `clickable ${cur ? 'current' : ''}`, title: `처음 나온 줄 ${t.firstLine + 1}` },
        h('td', {}, eye),
        h('td', {}, h('span', { class: 'swatch', style: `background:${rgbCss(t.color ?? [0.5, 0.5, 0.5])}` })),
        h('td', {}, t.number >= 0 && t.number < 100000 ? `T${t.number}` : '—'),
        h('td', { style: 'white-space:normal' }, t.name ?? ''),
        h('td', { style: 'text-align:right' }, t.diameter ? `Ø${fmtNum(t.diameter)}` : ''),
        h('td', { style: 'text-align:right' }, formatDuration(t.time)),
        h('td', { style: 'text-align:right' }, `${fmtNum(t.feedLength, 1)}${u}`),
      );
      tr.addEventListener('click', () => {
        this.mgr.setHighlight(cur ? [] : items);
        // 코드 보기는 그 공구가 처음 나온 줄로(그 줄의 이동이 있으면 덧그림 강조)
        if (!cur) this.mgr.selectLine(t.firstLine);
        this.render();
      });
      tbody.append(tr);
    }
    this.body.append(
      h('table', { class: 'grid v3d-tools' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '색'), h('th', {}, '번호'), h('th', {}, '이름'), h('th', {}, '지름'), h('th', {}, '시간'), h('th', {}, '이송 길이'))), tbody),
      h('div', { class: 'v3d-hint' }, '줄을 누르면 그 공구의 경로를 강조합니다. 눈 단추로 켜고 끕니다.'),
    );
  }

  // ───────────────────────── MPR ─────────────────────────

  private mprOps(d: Doc3d): { index: number; kind: string; label: string; line?: number; enabled: boolean; tool?: number; diameter?: number; depth?: number; holeCount?: number }[] {
    const ops = (d.scene.meta as { operations?: unknown } | undefined)?.operations;
    return Array.isArray(ops) ? (ops as ReturnType<View3dPanel['mprOps']>) : [];
  }

  private renderOps(d: Doc3d): void {
    const meta = (d.scene.meta ?? {}) as { workpiece?: { length: number; width: number; thickness: number } };
    const u = unitLabel(d.scene.units);
    const wp = meta.workpiece;
    if (wp) this.body.append(group('공작물', row('크기(L × W × T)', `${fmtNum(wp.length)} × ${fmtNum(wp.width)} × ${fmtNum(wp.thickness)} ${u}`)));
    const ops = this.mprOps(d);
    if (!ops.length) {
      this.body.append(h('div', { class: 'empty' }, '가공이 없습니다.'));
      return;
    }
    const tbody = h('tbody');
    for (const o of ops) {
      const sel = d.selKey === String(o.index);
      const detail = [o.diameter ? `Ø${fmtNum(o.diameter)}` : '', o.depth !== undefined ? `깊이 ${fmtNum(o.depth)}` : '', o.holeCount ? `${o.holeCount}개` : '', o.tool !== undefined ? `T${o.tool}` : '']
        .filter(Boolean)
        .join(' · ');
      const tr = h(
        'tr',
        { class: `clickable ${sel ? 'current' : ''} ${o.enabled ? '' : 'v3d-off'}`, title: typeof o.line === 'number' ? `줄 ${o.line + 1}` : '' },
        h('td', { style: 'text-align:right;color:var(--text-faint)' }, String(o.index + 1)),
        h('td', { style: 'white-space:normal' }, o.label || MPR_KIND[o.kind] || o.kind),
        h('td', {}, MPR_KIND[o.kind] ?? o.kind),
        h('td', { style: 'white-space:normal' }, detail),
        h('td', {}, o.enabled ? h('span', { class: 'chip' }, '켜짐') : h('span', { class: 'chip warn' }, '꺼짐')),
      );
      tr.addEventListener('click', () => this.mgr.selectMprOp(o.index));
      tbody.append(tr);
    }
    this.body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, '가공'), h('th', {}, '종류'), h('th', {}, '값'), h('th', {}, '상태'))), tbody));
  }

  private renderVars(d: Doc3d): void {
    const vars = (d.scene.meta as { variables?: { name: string; value?: number; expr: string; comment?: string }[] } | undefined)?.variables ?? [];
    if (!vars.length) {
      this.body.append(h('div', { class: 'empty' }, '변수가 없습니다.'));
      return;
    }
    const tbody = h('tbody');
    for (const v of vars)
      tbody.append(
        h(
          'tr',
          {},
          h('td', { style: 'font-family:var(--mono)' }, v.name),
          h('td', { style: 'text-align:right;font-family:var(--mono)' }, v.value !== undefined ? fmtNum(v.value) : '—'),
          h('td', { style: 'font-family:var(--mono);color:var(--text-dim);white-space:normal' }, v.expr !== String(v.value) ? v.expr : ''),
          h('td', { style: 'white-space:normal;color:var(--text-dim)' }, v.comment ?? ''),
        ),
      );
    this.body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '이름'), h('th', {}, '값'), h('th', {}, '식'), h('th', {}, '설명'))), tbody));
  }

  // ───────────────────────── STEP 제품 나무 ─────────────────────────

  private renderTree(d: Doc3d): void {
    const roots = stepProducts(d.scene);
    const meta = (d.scene.meta ?? {}) as { lengthUnit?: string; productCounts?: { name: string; productId: string; instances: number }[] };
    this.body.append(group('단위', row('길이 단위', `${meta.lengthUnit || unitLabel(d.scene.units) || '모름'}`)));
    if (!roots.length) {
      this.body.append(h('div', { class: 'empty' }, '제품 구조 정보가 없습니다.'));
      return;
    }
    let exp = this.expanded.get(d);
    if (!exp) {
      exp = new Set<string>();
      // 처음에는 두 단계까지 펼친다
      roots.forEach((r, i) => {
        exp!.add(String(i));
        r.children.forEach((_, j) => exp!.add(`${i}/${j}`));
      });
      this.expanded.set(d, exp);
    }
    const list = h('div', { class: 'v3d-tree' });
    let count = 0;
    const LIMIT = 3000;
    const walk = (nodes: readonly ProductNode[], prefix: string, depth: number): void => {
      nodes.forEach((n, i) => {
        if (count >= LIMIT) return;
        count++;
        const key = prefix ? `${prefix}/${i}` : String(i);
        const ids = subtreeMeshIds(n);
        const visible = ids.length === 0 || ids.some((id) => !d.hiddenItems.has(id));
        const open = exp!.has(key);
        const tog = h('button', { class: 'v3d-twisty', 'aria-label': open ? '접기' : '펼치기', disabled: !n.children.length }, n.children.length ? (open ? '▾' : '▸') : '');
        tog.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (open) exp!.delete(key);
          else exp!.add(key);
          this.render();
        });
        const eye = h('button', { class: `toggle ${visible ? '' : 'off'}`, title: visible ? '숨기기' : '보이기', 'aria-label': `${n.name} ${visible ? '숨기기' : '보이기'}`, html: icon(visible ? 'eye' : 'eyeOff') });
        eye.disabled = !ids.length;
        eye.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.mgr.setItemsVisible(ids, !visible);
          this.render();
        });
        const label = n.instance && n.instance !== n.name ? `${n.name} · ${n.instance}` : n.name || n.productId || '(이름 없음)';
        const item = h(
          'div',
          { class: `v3d-node ${d.selKey === key ? 'sel' : ''}`, style: `padding-left:${depth * 14}px`, title: n.productId ? `제품 번호 ${n.productId}` : '' },
          tog,
          eye,
          h('span', { class: 'v3d-node-name' }, label),
          ids.length ? h('span', { class: 'chip' }, `${ids.length}`) : null,
        );
        item.addEventListener('click', () => {
          const sel = d.selKey === key;
          d.selKey = sel ? null : key;
          this.mgr.setHighlight(sel ? [] : ids);
          this.render();
        });
        list.append(item);
        if (open) walk(n.children, key, depth + 1);
      });
    };
    walk(roots, '', 0);
    this.body.append(group('제품 나무', list, count >= LIMIT ? h('div', { class: 'v3d-hint' }, `처음 ${LIMIT}개 마디만 보입니다.`) : null));
    const counts = meta.productCounts ?? [];
    if (counts.length) {
      const tbody = h('tbody');
      for (const c of counts) tbody.append(h('tr', {}, h('td', { style: 'white-space:normal' }, c.name || c.productId), h('td', { style: 'text-align:right' }, c.instances.toLocaleString())));
      this.body.append(group('부품별 인스턴스', h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '부품'), h('th', {}, '수'))), tbody)));
    }
  }

  // ───────────────────────── SKP ─────────────────────────

  private renderTags(d: Doc3d): void {
    this.body.append(this.groupList(d, '태그'));
    const mats = skpMaterials(d.scene);
    if (mats.length) {
      const tbody = h('tbody');
      for (const m of mats.slice(0, 500))
        tbody.append(h('tr', {}, h('td', {}, h('span', { class: 'swatch', style: `background:${rgbCss(m.color)};opacity:${Math.max(0.25, m.color[3] ?? 1)}` })), h('td', { style: 'white-space:normal' }, m.name), h('td', { style: 'text-align:right' }, Math.round(m.triangles).toLocaleString())));
      this.body.append(group('재질', h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '색'), h('th', {}, '이름'), h('th', {}, '삼각형'))), tbody)));
    }
  }

  // ───────────────────────── 정보(공통) ─────────────────────────

  private groupList(d: Doc3d, title: string): HTMLElement {
    const groups = this.mgr.groups();
    if (!groups.length) return group(title, h('div', { class: 'v3d-hint' }, '묶음이 없습니다.'));
    const list = h('div', { class: 'v3d-groups' });
    for (const g of groups) {
      const visible = !d.hiddenGroups.has(g.name);
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = visible;
      cb.addEventListener('change', () => {
        this.mgr.setGroupVisible(g.name, cb.checked);
      });
      list.append(h('label', { class: 'v3d-group' }, cb, h('span', {}, g.name), h('span', { class: 'chip' }, String(g.count))));
    }
    return group(title, list);
  }

  private renderInfo(d: Doc3d): void {
    const s = d.scene;
    const u = unitLabel(s.units);
    const c = sceneCounts(s);
    const b = s.bounds;
    const rows: HTMLElement[] = [row('파일', d.name), row('형식', docLabel(d)), row('크기', formatBytes(d.size)), row('단위', u || '모름'), row('읽기 시간', `${Math.round(d.ms).toLocaleString()} ms`)];
    if (b) {
      rows.push(row('범위 크기', `${fmtNum(b.max[0] - b.min[0])} × ${fmtNum(b.max[1] - b.min[1])} × ${fmtNum(b.max[2] - b.min[2])} ${u}`));
      rows.push(row('최소', fmtPt(b.min)), row('최대', fmtPt(b.max)));
    }
    if (c.triangles) rows.push(row('삼각형', c.triangles.toLocaleString()));
    if (c.segments) rows.push(row('선분', c.segments.toLocaleString()));
    this.body.append(group('문서', ...rows));

    if (d.nc) this.ncInfo(d);
    const meta = (s.meta ?? {}) as Record<string, unknown>;
    if (d.mpr) {
      const st = meta.stats as Record<string, number> | undefined;
      if (st)
        this.body.append(
          group('가공 요약', row('구멍', `${st.holes ?? 0}개 (드릴 가공 ${st.drillOps ?? 0})`), row('윤곽 가공', String(st.contourOps ?? 0)), row('홈·포켓', `${st.grooves ?? 0} · ${st.pockets ?? 0}`), row('꺼진 가공', String(st.disabled ?? 0))),
        );
    }
    if (d.format === 'step') {
      const st = meta.stats as Record<string, number> | undefined;
      const hd = meta.header as { name?: string; description?: string[]; originatingSystem?: string } | undefined;
      const r: HTMLElement[] = [];
      if (Array.isArray(meta.schema)) r.push(row('스키마', (meta.schema as string[]).join(', ')));
      if (typeof meta.lengthUnit === 'string') r.push(row('길이 단위', meta.lengthUnit || '모름'));
      if (hd?.name) r.push(row('머리 이름', hd.name));
      if (hd?.originatingSystem) r.push(row('만든 프로그램', hd.originatingSystem));
      if (typeof meta.entityCount === 'number') r.push(row('엔티티', meta.entityCount.toLocaleString()));
      if (st) {
        r.push(row('솔리드·면', `${st.solids ?? 0} · ${(st.faces ?? 0).toLocaleString()}`));
        if (st.failedFaces) r.push(row('삼각화 못 한 면', st.failedFaces.toLocaleString()));
        r.push(row('인스턴스', (st.instances ?? 0).toLocaleString()));
        r.push(row('읽기·삼각화', `${st.parseMs ?? 0} ms · ${st.meshMs ?? 0} ms`));
      }
      if (r.length) this.body.append(group('STEP', ...r));
    }
    if (d.format === 'skp') {
      const r: HTMLElement[] = [];
      for (const [k, label] of [
        ['version', '버전'],
        ['lengthUnit', '길이 단위'],
        ['definitions', '컴포넌트 정의'],
        ['instances', '인스턴스'],
        ['faces', '면'],
        ['edges', '모서리'],
        ['materials', '재질'],
      ] as const) {
        const v = meta[k];
        if (v !== undefined) r.push(row(label, typeof v === 'number' ? v.toLocaleString() : String(v)));
      }
      if (r.length) this.body.append(group('SketchUp', ...r));
    }
    if (d.format !== 'skp') this.body.append(this.groupList(d, '묶음'));
    const warns = s.warnings ?? [];
    if (warns.length) this.body.append(group(`경고 ${warns.length}개`, h('ul', { class: 'v3d-warn' }, ...warns.slice(0, 300).map((w) => h('li', {}, w)))));
  }

  private ncInfo(d: Doc3d): void {
    const nc = d.nc!;
    const st = nc.stats;
    const u = unitLabel(d.scene.units);
    if (nc.kind === 'gcode') {
      const dialect = h('select', { 'aria-label': 'G-code 방언' }) as HTMLSelectElement;
      dialect.append(h('option', { value: 'auto' }, `자동 (${NC_DIALECT_NAMES[nc.dialect]})`));
      for (const k of ['iso', 'fanuc', 'linuxcnc', 'grbl', 'mach3'] as NcDialect[]) dialect.append(h('option', { value: k }, NC_DIALECT_NAMES[k]));
      dialect.value = d.ncOptions.dialect ?? 'auto';
      const units = h('select', { 'aria-label': '기본 단위' }) as HTMLSelectElement;
      units.append(h('option', { value: 'mm' }, 'mm'), h('option', { value: 'inch' }, 'inch'));
      units.value = d.ncOptions.units ?? 'mm';
      const apply = () => void this.mgr.reparse(d, { dialect: dialect.value as NcDialect | 'auto', units: units.value as 'mm' | 'inch' });
      dialect.addEventListener('change', apply);
      units.addEventListener('change', apply);
      this.body.append(
        group(
          '해석 설정',
          h('label', { class: 'prop-row edit' }, h('span', { class: 'k' }, '방언'), dialect),
          h('label', { class: 'prop-row edit', title: 'G20/G21이 없을 때 쓰는 단위' }, h('span', { class: 'k' }, '기본 단위'), units),
        ),
      );
    }
    this.body.append(
      group(
        '통계',
        row('방언·단위', `${nc.kind === 'heidenhain' ? 'Heidenhain 평문' : NC_DIALECT_NAMES[nc.dialect]} · ${nc.units}`),
        row('줄·블록', `${nc.source.lineCount.toLocaleString()} · ${st.blocks.toLocaleString()}`),
        row('이동', st.moveCount.toLocaleString()),
        row('이송 길이', `${fmtNum(st.feedLength, 1)} ${u}`),
        row('급속 길이', `${fmtNum(st.rapidLength, 1)} ${u}`),
        row('예상 시간', formatDuration(st.time)),
        row('이송·급속·휴지', `${formatDuration(st.feedTime)} · ${formatDuration(st.rapidTime)} · ${formatDuration(st.dwellTime)}`),
        row('급속 속도(계산용)', `${fmtNum(st.rapidFeed, 0)} ${u}/분`),
        row('공구 교환·원호·구멍', `${st.toolChanges} · ${st.arcCount.toLocaleString()} · ${st.holeCount.toLocaleString()}`),
      ),
    );
  }

  // ───────────────────────── 아래 띠: 고른 것·측정 ─────────────────────────

  private renderFoot(): void {
    const d = this.doc;
    const f = this.foot;
    f.innerHTML = '';
    if (!d) {
      f.hidden = true;
      return;
    }
    const lines: HTMLElement[] = [];
    const u = unitLabel(d.scene.units);
    const p = d.pick;
    if (d.nc && d.selLine >= 0) {
      const text = sourceLine(d.nc.source, d.selLine).trim();
      const mv = d.selMoves.length;
      lines.push(h('div', {}, h('b', {}, `줄 ${(d.selLine + 1).toLocaleString()}`), ` ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`));
      if (p && (p.kind === 'line' || p.kind === 'point') && p.id.startsWith('nc-') && p.index >= 0 && p.index < d.nc.moves.count) {
        const i = p.index;
        const kind = MOVE_KIND_NAMES[d.nc.moves.kind[i]!] ?? 'feed';
        const tool = d.nc.moves.tool[i]!;
        const feed = d.nc.moves.feed[i]!;
        lines.push(h('div', { class: 'v3d-dim' }, `${KIND_LABEL[kind] ?? kind}${tool >= 0 ? ` · T${tool}` : ''}${kind !== 'rapid' && feed > 0 ? ` · F${fmtNum(feed, 1)}` : ''} · ${fmtPt(p.point)}`));
      } else if (mv) lines.push(h('div', { class: 'v3d-dim' }, `이 줄의 이동 ${mv.toLocaleString()}개를 강조했습니다.`));
      else lines.push(h('div', { class: 'v3d-dim' }, '이 줄은 이동을 만들지 않습니다.'));
    } else if (p) {
      const item = p.kind === 'mesh' ? d.scene.meshes.find((m) => m.id === p.id) : p.kind === 'line' ? d.scene.lines.find((l) => l.id === p.id) : d.scene.points?.find((x) => x.id === p.id);
      const name = item?.name ?? p.id;
      lines.push(h('div', {}, h('b', {}, '고른 것 '), name, item?.group && item.group !== name ? h('span', { class: 'v3d-dim' }, ` · ${item.group}`) : null));
      lines.push(h('div', { class: 'v3d-dim' }, `점 ${fmtPt(p.point)}${p.normal ? ` · 법선 ${fmtPt(p.normal)}` : ''}`));
    }
    if (d.measure) {
      const m = d.measure;
      lines.push(h('div', {}, h('b', {}, '거리 '), `${fmtNum(m.distance)} ${u}`, h('span', { class: 'v3d-dim' }, ` · dx ${fmtNum(m.dx)} · dy ${fmtNum(m.dy)} · dz ${fmtNum(m.dz)}`)));
    } else if (this.mgr.measuring) lines.push(h('div', { class: 'v3d-dim' }, '측정: 두 점을 누르십시오. Esc = 지우기'));
    f.hidden = !lines.length;
    f.append(...lines);
  }
}
