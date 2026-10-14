/**
 * 상태 막대의 주석 축척 항목:
 * - 주석 축척 단추(글자 = 지금 보이는 주석 축척: 모형 = CANNOSCALE, 뷰포트 안 = 그 뷰포트, 도면 공간 = 1:1 비활성).
 *   누르면 도면의 축척 리스트(현재 ✓) · 사용자...(SCALELISTEDIT) · 외부 참조 축척 숨기기 · 비율 축척 백분율.
 * - 주석 객체 표시(ANNOALLVISIBLE, 지금 탭), 주석 축척 변경 시 축척 추가(ANNOAUTOSCALE) 토글.
 * - 뷰포트 안에서 뷰포트 축척이 주석 축척과 다르면 동기화 단추.
 * shell.ts의 상태 막대가 elements를 넣고 refreshStatus마다 refresh를 부른다.
 */
import { percentText } from '../edit/annoscale';
import type { App } from './app';
import {
  annoAutoscale,
  chooseScale,
  hideXrefScales,
  listedScales,
  newGroup,
  percentScales,
  setAllVisible,
  setAnnoAutoscale,
  setHideXrefScales,
  setPercentScales,
  shownScale,
  syncViewportScale,
  tabAllVisible,
  watchAnnoDisplay,
} from './annoscale-core';
import { type MenuItem, h, showMenu } from './ui/dom';

const S = (body: string) =>
  `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** 주석 객체 표시: 크기가 다른 두 A */
const ICON_VISIBLE = S('<path d="M3 19l4-11 4 11M4.5 15h5"/><path d="M14 19l3.5-8 3.5 8M15.2 16.5h4.6"/>');
/** 축척 추가: A와 더하기 */
const ICON_AUTO = S('<path d="M3 19l5-13 5 13M5 14.5h6"/><path d="M18 5v6M15 8h6"/>');
/** 동기화: 두 화살표 */
const ICON_SYNC = S('<path d="M20 8a8 8 0 0 0-14-2M4 4v4h4"/><path d="M4 16a8 8 0 0 0 14 2M20 20v-4h-4"/>');

const CSS = `
.as-scale-btn { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; border: 0; border-radius: 3px; background: transparent; color: var(--text); cursor: pointer; font: inherit; font-family: var(--mono); white-space: nowrap; }
.as-scale-btn:hover:not(:disabled) { background: var(--bg-hover); }
.as-scale-btn:disabled { opacity: .45; cursor: default; }
.as-scale-btn .as-cap { color: var(--text-dim); font-family: inherit; }
.menu.as-menu { max-height: calc(100vh - 8px); overflow-y: auto; }
.icon-btn.as-warn { color: #ffb74d; }
`;

function styles(): void {
  if (typeof document === 'undefined' || document.getElementById('as-status-style')) return;
  const s = document.createElement('style');
  s.id = 'as-status-style';
  s.textContent = CSS;
  document.head.append(s);
}

export interface AnnoStatus {
  elements: HTMLElement[];
  refresh(): void;
}

/** 긴 메뉴(축척 33개)는 화면 안에서 스크롤 */
function scrollableMenu(x: number, y: number, items: MenuItem[]): void {
  showMenu(x, y, items);
  const menus = document.querySelectorAll('.menu');
  const m = menus[menus.length - 1] as HTMLElement | undefined;
  if (!m) return;
  m.classList.add('as-menu');
  const r = m.getBoundingClientRect();
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}

export function annoStatus(app: App): AnnoStatus {
  styles();
  const label = h('span', {}, '1:1');
  const scaleBtn = h('button', { class: 'as-scale-btn', title: '주석 축척', 'aria-label': '주석 축척', type: 'button' }, h('span', { class: 'as-cap', html: S('<path d="M4 18l4-12 4 12M5.5 14h5"/><path d="M15 7h5M15 12h5M15 17h5"/>') }), label, h('span', { class: 'as-cap' }, '▾')) as HTMLButtonElement;
  (scaleBtn.firstElementChild as HTMLElement).style.cssText = 'width:16px;height:16px;display:inline-block';
  const visBtn = h('button', { class: 'icon-btn', type: 'button', title: '주석 객체 표시 (ANNOALLVISIBLE) · 켜면 현재 주석 축척을 지원하지 않는 주석 객체도 보입니다', 'aria-label': '주석 객체 표시', html: ICON_VISIBLE }) as HTMLButtonElement;
  const autoBtn = h('button', { class: 'icon-btn', type: 'button', title: '주석 축척 변경 시 축척 추가 (ANNOAUTOSCALE) · 켜면 주석 축척을 바꿀 때 주석 객체에 새 축척을 더합니다', 'aria-label': '주석 축척 변경 시 축척 추가', html: ICON_AUTO }) as HTMLButtonElement;
  const syncBtn = h('button', { class: 'icon-btn as-warn', type: 'button', title: '주석 축척이 뷰포트 축척과 같지 않음: 동기화하려면 클릭', 'aria-label': '뷰포트 축척 동기화', html: ICON_SYNC, hidden: true }) as HTMLButtonElement;

  scaleBtn.addEventListener('click', (ev) => {
    const sh = shownScale(app);
    if (sh.where !== 'model' && sh.where !== 'viewport') return;
    const cur = sh.scale?.name.toUpperCase();
    const pct = percentScales();
    const items: MenuItem[] = [{ heading: sh.where === 'viewport' ? '뷰포트 주석 축척' : '주석 축척' }];
    for (const s of listedScales(sh.list)) {
      items.push({
        label: `${s.name.toUpperCase() === cur ? '✓ ' : ' '}${pct ? percentText(s) : s.name}`,
        disabled: sh.locked,
        run: () => {
          chooseScale(app, s.name, newGroup());
        },
      });
    }
    items.push(
      { separator: true },
      { label: '사용자...', run: () => void app.run('SCALELISTEDIT') },
      { separator: true },
      {
        label: `${hideXrefScales() ? '✓ ' : ' '}외부 참조 축척 숨기기`,
        run: () => {
          setHideXrefScales(!hideXrefScales());
          app.ui.refreshStatus();
        },
      },
      {
        label: `${pct ? '✓ ' : ' '}비율 축척 백분율`,
        run: () => {
          setPercentScales(!pct);
          app.ui.refreshStatus();
        },
      },
    );
    const r = scaleBtn.getBoundingClientRect();
    scrollableMenu(Math.max(4, r.left), ev.clientY - 40 - items.length * 30, items);
  });
  visBtn.addEventListener('click', () => {
    const st = app.active;
    if (!st) return;
    setAllVisible(st, !tabAllVisible(st));
  });
  autoBtn.addEventListener('click', () => {
    const v = annoAutoscale();
    setAnnoAutoscale(-v);
    app.cmd.print(`ANNOAUTOSCALE = ${-v}`);
    app.ui.refreshStatus();
  });
  syncBtn.addEventListener('click', () => {
    const st = app.active;
    const sh = shownScale(app);
    if (st && sh.vp) syncViewportScale(st, sh.vp, newGroup());
  });

  const refresh = () => {
    try {
      watchAnnoDisplay(app);
    } catch (e) {
      console.warn(e);
    }
    const st = app.active;
    const sh = shownScale(app);
    const show = !!st && sh.where !== 'none';
    for (const el of [scaleBtn, visBtn]) el.hidden = !show;
    autoBtn.hidden = !st;
    if (!show) {
      syncBtn.hidden = true;
      return;
    }
    const s = sh.scale;
    label.textContent = s ? (percentScales() ? percentText(s) : s.name) : '1:1';
    scaleBtn.disabled = sh.where === 'paper';
    scaleBtn.title =
      sh.where === 'paper'
        ? '주석 축척: 도면 공간의 주석 축척은 1:1입니다'
        : sh.where === 'viewport'
          ? `뷰포트 주석 축척: ${s?.name ?? ''}${sh.locked ? ' (잠긴 뷰포트)' : ''}`
          : `주석 축척(CANNOSCALE): ${s?.name ?? ''}`;
    visBtn.classList.toggle('on', tabAllVisible(st!));
    autoBtn.classList.toggle('on', annoAutoscale() > 0);
    syncBtn.hidden = !(sh.where === 'viewport' && sh.synced === false && !sh.locked);
  };
  return { elements: [syncBtn, scaleBtn, visBtn, autoBtn], refresh };
}
