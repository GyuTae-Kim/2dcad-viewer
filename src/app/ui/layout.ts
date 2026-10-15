/**
 * 화면 폭에 따른 배치 계산(순수 함수)과 화면 크기 감시.
 * - 760px보다 좁거나 480px보다 낮으면 리본을 작업 영역 위에 겹쳐 펼친다(겹침 리본).
 * - 리본 패널은 자리가 모자라면 오른쪽부터 단추 하나로 접는다.
 * - 상태 막대는 넘치면 덜 중요한 항목부터 "⋯" 메뉴로 옮긴다.
 * - 소프트 키보드가 올라오면(visualViewport) 명령행·팔레트를 그만큼 올린다.
 */

export type LayoutMode = 'phone' | 'narrow' | 'tablet' | 'desktop';

/** 이 폭보다 좁으면 겹침 리본 */
export const NARROW_WIDTH = 760;
/** 이 폭 이하는 휴대폰 */
export const PHONE_WIDTH = 480;
/** 이 폭 이상은 데스크톱 */
export const DESKTOP_WIDTH = 1280;
/** 이 높이보다 낮으면(가로로 눕힌 휴대폰) 폭과 관계없이 겹침 리본 */
export const SHORT_HEIGHT = 480;

/** 폭 기준 배치 단계 */
export function layoutMode(width: number): LayoutMode {
  if (width <= PHONE_WIDTH) return 'phone';
  if (width < NARROW_WIDTH) return 'narrow';
  if (width < DESKTOP_WIDTH) return 'tablet';
  return 'desktop';
}

/** 리본을 작업 영역 위에 겹쳐 펼칠지(작업 영역 높이를 리본이 빼앗지 않게) */
export function ribbonOverlay(width: number, height: number): boolean {
  return width < NARROW_WIDTH || height < SHORT_HEIGHT;
}

/** #app에 붙일 배치 클래스 */
export function layoutClasses(width: number, height: number): string[] {
  const out = [`layout-${layoutMode(width)}`];
  if (ribbonOverlay(width, height)) out.push('ribbon-overlay');
  return out;
}

/**
 * 접을 패널 수(오른쪽부터). full은 펼친 폭, folded는 접은 폭, avail은 쓸 수 있는 폭.
 * 첫 패널은 나머지를 다 접어도 넘칠 때만 접는다. 다 접어도 넘치면 전부 접는다(남는 것은 가로 스크롤).
 */
export function foldCount(full: readonly number[], folded: readonly number[], avail: number): number {
  const n = full.length;
  let total = full.reduce((a, b) => a + b, 0);
  let k = 0;
  while (k < n && total > avail + 1) {
    const i = n - 1 - k;
    total += (folded[i] ?? full[i]!) - full[i]!;
    k++;
  }
  return k;
}

export interface StatusItem {
  /** 지금 폭(px) */
  w: number;
  /** 클수록 오래 남는다. 0 이하는 넘치면 가장 먼저 숨긴다 */
  prio: number;
}

/**
 * 상태 막대가 넘칠 때 숨길 항목 번호. 숨긴 것이 하나라도 있으면 "⋯" 단추(moreW)가 자리를 차지한다.
 * 우선순위가 낮은 것부터, 같으면 오른쪽 것부터 숨긴다.
 */
export function statusHidden(items: readonly StatusItem[], avail: number, moreW: number): Set<number> {
  const hidden = new Set<number>();
  let total = items.reduce((a, it) => a + it.w, 0);
  if (total <= avail) return hidden;
  total += moreW;
  const order = items.map((it, i) => ({ i, prio: it.prio })).sort((a, b) => a.prio - b.prio || b.i - a.i);
  for (const { i } of order) {
    if (total <= avail) break;
    hidden.add(i);
    total -= items[i]!.w;
  }
  return hidden;
}

/**
 * 소프트 키보드(또는 브라우저 아래 막대)가 가린 만큼 hostBottom 위의 요소를 올릴 높이.
 * hostBottom은 레이아웃 뷰포트 기준 요소의 아래 끝, vvTop·vvHeight·scale은 visualViewport의 offsetTop·height·scale.
 * 손가락으로 확대한 동안(scale > 1)은 올리지 않는다(확대해 보는 곳을 따라 움직이면 어지럽다)
 */
export function keyboardLift(hostBottom: number, vvTop: number, vvHeight: number, scale = 1): number {
  if (scale > 1.01) return 0;
  return Math.max(0, Math.round(hostBottom - (vvTop + vvHeight)));
}

/** 떠 있는 상자(메뉴·접힌 패널)를 화면 안에 둔다 */
export function clampBox(x: number, y: number, w: number, hgt: number, vw: number, vh: number, margin = 4): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, vw - w - margin));
  const top = Math.max(margin, Math.min(y, vh - hgt - margin));
  return { left, top };
}

/** 아래쪽 시트 팔레트 높이(작업 영역 높이에 대한 비율, 0.25~0.9) */
export function sheetFraction(requested: number): number {
  if (!Number.isFinite(requested)) return 0.5;
  return Math.max(0.25, Math.min(0.9, requested));
}

/** el이 가로 스크롤 상자 box 안에서 보이도록 box.scrollLeft를 고른다 */
export function scrollLeftToShow(scrollLeft: number, boxWidth: number, elLeft: number, elWidth: number): number {
  if (elLeft < scrollLeft) return Math.max(0, elLeft - 8);
  if (elLeft + elWidth > scrollLeft + boxWidth) return Math.max(0, elLeft + elWidth - boxWidth + 8);
  return scrollLeft;
}

// ---------------------------------------------------------------------------
// 화면 쪽 연결
// ---------------------------------------------------------------------------

/** 가로로만 넘치는 줄(탭·상태 막대): 마우스 휠의 세로 움직임을 가로 스크롤로 */
export function wheelToHorizontal(el: HTMLElement): void {
  el.addEventListener(
    'wheel',
    (ev) => {
      if (ev.ctrlKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += ev.deltaY;
      ev.preventDefault();
    },
    { passive: false },
  );
}

/** 가로 스크롤 상자 안의 요소를 보이게(페이지는 움직이지 않는다) */
export function revealX(box: HTMLElement, el: HTMLElement | null): void {
  if (!el || box.scrollWidth <= box.clientWidth) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  box.scrollLeft = scrollLeftToShow(box.scrollLeft, box.clientWidth, r.left - b.left + box.scrollLeft, r.width);
}

/**
 * visualViewport를 지켜 CSS 변수를 맞춘다.
 * 문서: --vvh(보이는 높이), --vvtop(보이는 영역의 위 끝). 작업 영역: --kb-lift(키보드가 가린 높이)
 */
export function watchViewport(workspace: HTMLElement, onChange?: () => void): void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  let raf = 0;
  const apply = () => {
    raf = 0;
    const top = vv ? vv.offsetTop : 0;
    const height = vv ? vv.height : window.innerHeight;
    root.style.setProperty('--vvh', `${Math.round(height)}px`);
    root.style.setProperty('--vvtop', `${Math.round(top)}px`);
    const lift = keyboardLift(workspace.getBoundingClientRect().bottom, top, height, vv?.scale ?? 1);
    workspace.style.setProperty('--kb-lift', `${lift}px`);
    workspace.classList.toggle('kb-up', lift > 0);
    onChange?.();
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply);
  };
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  apply();
}
