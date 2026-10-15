/**
 * 도면 비교 화면 요소: 도면 영역 위의 비교 도구막대(설정·◀ n/m ▶·가져오기·내보내기·정보·닫기), 설정 창,
 * "DWG 비교" 대화상자(비교할 도면 고르기), "도면 비교 정보" 대화상자.
 */
import type { App } from './app';
import type { DocState } from './docstate';
import { dialog, h } from './ui/dom';
import { rgbToCss } from '../core/color';
import { compareRgb } from './compare-session';
import type { CompareSettings } from '../edit/compare/settings';
import { compareSettings, getCompareVar, setCompareVars } from './compare-vars';
import { formatCompareColor } from '../edit/compare/settings';

const STYLE = `
.cmp-bar{position:absolute;top:6px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:2px 4px;
 border:1px solid var(--border-soft);border-radius:6px;background:rgba(46,53,63,.94);box-shadow:0 2px 10px rgba(0,0,0,.35);
 z-index:3;cursor:default;user-select:none;font-size:12px;color:var(--text);white-space:nowrap;max-width:calc(100% - 16px)}
.cmp-bar button{border:0;background:transparent;color:inherit;padding:3px 7px;border-radius:4px;cursor:pointer;font:inherit}
.cmp-bar button:hover:not(:disabled){background:var(--bg-hover)}
.cmp-bar button:disabled{opacity:.4;cursor:default}
.cmp-bar button.on{background:var(--accent-soft)}
.cmp-bar .sep{width:1px;height:16px;background:var(--border-soft);margin:0 3px}
.cmp-bar .count{min-width:52px;text-align:center;color:var(--text-dim);font-variant-numeric:tabular-nums}
.cmp-bar .chip{display:inline-flex;align-items:center;gap:4px;padding:0 5px;color:var(--text-dim);font-variant-numeric:tabular-nums}
.cmp-bar .chip i{display:inline-block;width:10px;height:10px;border-radius:2px;border:1px solid rgba(0,0,0,.4)}
.cmp-bar .busy{color:var(--accent);padding:0 6px}
.cmp-pop{position:absolute;top:40px;left:50%;transform:translateX(-50%);z-index:4;width:300px;padding:10px 12px;cursor:default;
 border:1px solid var(--border-soft);border-radius:6px;background:var(--bg-panel);box-shadow:0 6px 22px rgba(0,0,0,.45);font-size:12px;color:var(--text)}
.cmp-pop h4{margin:8px 0 4px;font-size:11.5px;font-weight:600;color:var(--text-dim)}
.cmp-pop h4:first-child{margin-top:0}
.cmp-pop label{display:flex;align-items:center;gap:6px;padding:2px 0}
.cmp-pop .row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.cmp-pop input[type=color]{width:28px;height:18px;padding:0;border:1px solid var(--border-soft);background:none;cursor:pointer}
.cmp-pop input[type=range]{flex:1}
.cmp-pop input[type=number]{width:52px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;padding:1px 4px}
.cmp-pop .val{min-width:20px;text-align:right;color:var(--text-dim)}
.cmp-pop .seg{display:inline-flex;border:1px solid var(--border-soft);border-radius:4px;overflow:hidden}
.cmp-pop .seg button{border:0;background:transparent;color:var(--text-dim);padding:2px 8px;cursor:pointer;font:inherit}
.cmp-pop .seg button.on{background:var(--bg-active);color:#fff}
.cmp-list{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;margin:4px 0 8px;min-width:320px}
.cmp-list label{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer}
.cmp-list label:hover{background:var(--bg-hover)}
.cmp-info{border-collapse:collapse;min-width:380px}
.cmp-info th{text-align:left;font-weight:600;padding:6px 10px 2px 0;color:var(--text-dim)}
.cmp-info td{padding:2px 10px 2px 0;vertical-align:top}
.cmp-info td:first-child{color:var(--text-dim);white-space:nowrap}
`;

function ensureStyle(): void {
  if (document.getElementById('cmp-style')) return;
  const s = document.createElement('style');
  s.id = 'cmp-style';
  s.textContent = STYLE;
  document.head.append(s);
}

/** 도면 영역의 입력(그리기·확대)으로 새지 않게 */
function isolate(el: HTMLElement): void {
  for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel'])
    el.addEventListener(t, (ev) => ev.stopPropagation(), { passive: t !== 'contextmenu' });
  el.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

export interface ToolbarActions {
  prev(): void;
  next(): void;
  /** 없으면 단추를 두지 않는다(외부 참조 비교) */
  importObjects?(): void;
  exportSnapshot?(): void;
  info?(): void;
  close(): void;
}

/** 도구막대가 읽는 비교 상태(도면 비교·외부 참조 비교가 함께 쓴다) */
export interface CompareBarSession {
  readonly sets: readonly unknown[];
  readonly current: number;
  readonly busy: boolean;
  readonly result: { readonly onlyCurrent: readonly string[]; readonly onlyCompare: readonly string[]; readonly common: number } | null;
  readonly settings: CompareSettings;
}

/** 도구막대 문구·추가 설정(외부 참조 비교) */
export interface ToolbarOptions {
  /** 도구막대 이름(접근성) */
  title?: string;
  /** 개수 칩 설명: [현재에서만, 비교에서만, 차이 없음] */
  labels?: [string, string, string];
  /** 설정 창 끝에 붙일 줄 */
  extraSettings?: () => Node[];
}

/** 비교 도구막대(도면 영역 위) */
export class CompareToolbar {
  readonly el: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private readonly chips: HTMLSpanElement;
  private readonly busy: HTMLSpanElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly setBtn: HTMLButtonElement;
  private pop: HTMLDivElement | null = null;

  private readonly labels: [string, string, string];

  constructor(
    private readonly app: App,
    private readonly session: CompareBarSession,
    actions: ToolbarActions,
    private readonly opts: ToolbarOptions = {},
  ) {
    this.labels = opts.labels ?? ['현재 도면에서만', '비교 도면에서만', '차이 없음'];
    ensureStyle();
    const btn = (label: string, title: string, run: () => void) => h('button', { type: 'button', title, 'aria-label': title, onclick: () => run() }, label);
    this.setBtn = btn('⚙ 설정', '비교 설정', () => this.toggleSettings());
    this.prevBtn = btn('◀', '이전 변경 세트', actions.prev);
    this.nextBtn = btn('▶', '다음 변경 세트', actions.next);
    this.count = h('span', { class: 'count', title: '변경 세트' }, '–');
    this.chips = h('span', {});
    this.busy = h('span', { class: 'busy', hidden: true }, '비교 중…');
    this.el = h(
      'div',
      { class: 'cmp-bar', role: 'toolbar', 'aria-label': opts.title ?? '도면 비교' },
      this.setBtn,
      h('span', { class: 'sep' }),
      this.prevBtn,
      this.count,
      this.nextBtn,
      h('span', { class: 'sep' }),
      this.chips,
      this.busy,
      h('span', { class: 'sep' }),
      actions.importObjects ? btn('가져오기', '비교 도면의 객체 가져오기(COMPAREIMPORT)', actions.importObjects) : null,
      actions.exportSnapshot ? btn('내보내기', '스냅샷 내보내기(COMPAREEXPORT)', actions.exportSnapshot) : null,
      actions.info ? btn('정보', '도면 비교 정보(COMPAREINFO)', actions.info) : null,
      btn('✕', opts.title ? `${opts.title} 닫기` : '비교 닫기(COMPARECLOSE)', actions.close),
    );
    isolate(this.el);
    app.view.el.append(this.el);
    this.update();
  }

  /** 지금 도면이 비교 중인 도면일 때만 보인다 */
  setVisible(on: boolean): void {
    this.el.hidden = !on;
    if (!on) this.closeSettings();
  }

  update(): void {
    const s = this.session;
    const n = s.sets.length;
    this.count.textContent = n ? `${s.current >= 0 ? s.current + 1 : '–'} / ${n}` : '0 / 0';
    this.prevBtn.disabled = this.nextBtn.disabled = !n;
    this.busy.hidden = !s.busy;
    const r = s.result;
    const set = s.settings;
    const dark = true;
    const chip = (text: string, title: string, color: string) => h('span', { class: 'chip', title }, h('i', { style: `background:${rgbToCss(compareRgb(color, dark, 7))}` }), text);
    this.chips.replaceChildren(
      chip(String(r?.onlyCurrent.length ?? 0), this.labels[0], set.color1),
      chip(String(r?.onlyCompare.length ?? 0), this.labels[1], set.color2),
      chip(String(r?.common ?? 0), this.labels[2], set.colorCommon),
    );
    if (this.pop) this.fillSettings(this.pop);
  }

  toggleSettings(): void {
    if (this.pop) this.closeSettings();
    else this.openSettings();
  }

  openSettings(): void {
    this.closeSettings();
    const pop = h('div', { class: 'cmp-pop', role: 'dialog', 'aria-label': '비교 설정' });
    isolate(pop);
    pop.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if ((ev as KeyboardEvent).key === 'Escape') this.closeSettings();
    });
    this.fillSettings(pop);
    this.app.view.el.append(pop);
    this.pop = pop;
    this.setBtn.classList.add('on');
  }

  closeSettings(): void {
    this.pop?.remove();
    this.pop = null;
    this.setBtn.classList.remove('on');
  }

  private fillSettings(pop: HTMLDivElement): void {
    const s = compareSettings();
    const check = (label: string, name: string, on: boolean, extra?: Node) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': label }) as HTMLInputElement;
      cb.checked = on;
      cb.addEventListener('change', () => setCompareVars({ [name]: cb.checked ? 1 : 0 }));
      return h('div', { class: 'row' }, h('label', {}, cb, label), extra ?? null);
    };
    const color = (name: string, value: string, label: string) => {
      const inp = h('input', { type: 'color', title: `${label} 색상 (${name} = ${value})`, 'aria-label': `${label} 색상` }) as HTMLInputElement;
      inp.value = rgbToCss(compareRgb(value, true, 7));
      inp.addEventListener('change', () => setCompareVars({ [name]: formatCompareColor({ rgb: parseInt(inp.value.slice(1), 16) }) }));
      return inp;
    };
    const seg = (name: string, value: number, opts: [number, string][]) =>
      h('span', { class: 'seg' }, ...opts.map(([v, l]) => h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => setCompareVars({ [name]: v }) }, l)));
    const margin = h('input', { type: 'range', min: 1, max: 25, step: 1, 'aria-label': '여백' }) as HTMLInputElement;
    margin.value = String(s.rcMargin);
    const mval = h('span', { class: 'val' }, String(s.rcMargin));
    margin.addEventListener('input', () => (mval.textContent = margin.value));
    margin.addEventListener('change', () => setCompareVars({ COMPARERCMARGIN: Number(margin.value) }));
    const props = h('input', { type: 'checkbox', 'aria-label': '특성' }) as HTMLInputElement;
    props.checked = s.props === 127;
    props.indeterminate = s.props > 0 && s.props < 127;
    props.title = `COMPAREPROPS = ${s.props}`;
    props.addEventListener('change', () => setCompareVars({ COMPAREPROPS: props.checked ? 127 : 0 }));
    const tol = h('input', { type: 'number', min: 0, max: 14, step: 1, 'aria-label': '허용 오차' }) as HTMLInputElement;
    tol.value = String(s.tolerance);
    tol.addEventListener('change', () => {
      const v = Math.round(Number(tol.value));
      if (Number.isFinite(v) && v >= 0 && v <= 14) setCompareVars({ COMPARETOLERANCE: v });
      else tol.value = String(getCompareVar('COMPARETOLERANCE'));
    });
    const textCb = h('input', { type: 'checkbox', 'aria-label': '문자' }) as HTMLInputElement;
    textCb.checked = s.text;
    textCb.addEventListener('change', () => setCompareVars({ COMPARETEXT: textCb.checked ? 1 : 0 }));
    const hatchCb = h('input', { type: 'checkbox', 'aria-label': '해치' }) as HTMLInputElement;
    hatchCb.checked = s.hatch;
    hatchCb.addEventListener('change', () => setCompareVars({ COMPAREHATCH: hatchCb.checked ? 1 : 0 }));
    pop.replaceChildren(
      h('h4', {}, '비교 표시'),
      check(this.labels[0], 'COMPARESHOW1', s.show1, color('COMPARECOLOR1', s.color1, this.labels[0])),
      check(this.labels[1], 'COMPARESHOW2', s.show2, color('COMPARECOLOR2', s.color2, this.labels[1])),
      check(this.labels[2], 'COMPARESHOWCOMMON', s.showCommon, color('COMPARECOLORCOMMON', s.colorCommon, this.labels[2])),
      h(
        'div',
        { class: 'row' },
        h('span', {}, '앞에 표시'),
        seg('COMPAREFRONT', s.front, [
          [1, '현재 도면'],
          [2, '비교 도면'],
        ]),
      ),
      h('h4', {}, '구름형 리비전'),
      check(
        '구름형 리비전 켜기',
        'COMPARESHOWRC',
        s.showRc,
        seg('COMPARERCSHAPE', s.rcShape, [
          [0, '직사각형'],
          [1, '폴리곤'],
        ]),
      ),
      h('div', { class: 'row' }, h('span', {}, '여백'), margin, mval),
      h('h4', {}, '비교 필터'),
      h('div', { class: 'row' }, h('label', {}, textCb, '문자'), h('label', {}, hatchCb, '해치'), h('label', {}, props, '특성')),
      h('div', { class: 'row' }, h('span', {}, '허용 오차(소수점 자릿수)'), tol),
      ...(this.opts.extraSettings?.() ?? []),
    );
  }

  dispose(): void {
    this.closeSettings();
    this.el.remove();
  }
}

/** "DWG 비교" 대화상자: 열린 다른 도면 또는 찾아보기. 닫으면 null */
export function chooseDrawing(current: DocState, others: DocState[]): Promise<DocState | 'browse' | null> {
  ensureStyle();
  return new Promise((resolve) => {
    let result: DocState | 'browse' | null = null;
    let picked: DocState | null = others[0] ?? null;
    const list = h(
      'div',
      { class: 'cmp-list', role: 'radiogroup', 'aria-label': '열린 도면' },
      ...others.map((d, i) => {
        const r = h('input', { type: 'radio', name: 'cmp-doc', value: String(i) }) as HTMLInputElement;
        r.checked = i === 0;
        r.addEventListener('change', () => (picked = d));
        r.addEventListener('keydown', (ev) => ev.stopPropagation());
        return h('label', {}, r, d.name);
      }),
    );
    const body = h('div', {}, h('div', {}, `현재 도면 "${current.name}"과(와) 비교할 도면을 고르십시오.`), list);
    const back = dialog('DWG 비교', body, [
      { label: '찾아보기(B)...', run: () => void (result = 'browse') },
      { label: '취소' },
      { label: '비교', primary: true, run: () => void (result = picked) },
    ]);
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

/** 도면 파일 하나 고르기(취소하면 null) */
export function pickDrawingFile(): Promise<File | null> {
  const input = h('input', { type: 'file', accept: '.dwg,.dxf,.DWG,.DXF', hidden: true }) as HTMLInputElement;
  document.body.append(input);
  return new Promise<File | null>((resolve) => {
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  }).finally(() => input.remove());
}

/** "도면 비교 정보" 대화상자: 줄 목록을 표로. 고른 단추(insert·copy) 또는 null */
export function showInfo(rows: ([string, string] | [string])[]): Promise<'insert' | 'copy' | null> {
  ensureStyle();
  return new Promise((resolve) => {
    let result: 'insert' | 'copy' | null = null;
    const table = h(
      'table',
      { class: 'cmp-info' },
      ...rows.map((r) => (r.length === 1 ? h('tr', {}, h('th', { colspan: 2 }, r[0])) : h('tr', {}, h('td', {}, r[0]), h('td', {}, r[1])))),
    );
    const back = dialog('도면 비교 정보', table, [
      { label: '도면에 삽입(I)', run: () => void (result = 'insert') },
      { label: '클립보드로 복사(C)', run: () => void (result = 'copy') },
      { label: '닫기', primary: true },
    ]);
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}
