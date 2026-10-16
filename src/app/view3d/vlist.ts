/**
 * 가상 목록: 줄이 수백만 개여도 보이는 줄만 DOM으로 만든다(NC 코드 보기·가공 목록).
 *
 * 브라우저는 요소 높이에 한계가 있어(Firefox 약 1,790만 화소) 줄 높이 × 줄 수가 maxPx를 넘으면
 * 스크롤 위치를 비율로 줄 번호에 잇는다(스크롤 막대 1화소 = 여러 줄). 계산은 listWindow·scrollTopForRow(순수 함수).
 */

/** 화면에 둘 줄 범위 [first, last)와 first 줄의 내용 안 y(화소), 내용 높이 */
export interface ListWindow {
  first: number;
  last: number;
  top: number;
  height: number;
}

export const LIST_MAX_PX = 8_000_000;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 내용 높이(화소) */
export function listHeight(count: number, rowH: number, maxPx = LIST_MAX_PX): number {
  return Math.min(Math.max(0, count) * rowH, maxPx);
}

/** 스크롤 위치 → 맨 위에 보이는 줄(소수) */
export function topRowAt(scrollTop: number, viewH: number, rowH: number, count: number, maxPx = LIST_MAX_PX): number {
  const height = listHeight(count, rowH, maxPx);
  const maxTop = Math.max(0, height - viewH);
  const span = Math.max(0, count - viewH / rowH);
  return maxTop > 0 ? (clamp(scrollTop, 0, maxTop) / maxTop) * span : 0;
}

/** 보이는 범위(앞뒤로 overscan 줄 더) */
export function listWindow(scrollTop: number, viewH: number, rowH: number, count: number, overscan = 8, maxPx = LIST_MAX_PX): ListWindow {
  const height = listHeight(count, rowH, maxPx);
  if (count <= 0 || rowH <= 0) return { first: 0, last: 0, top: 0, height };
  const maxTop = Math.max(0, height - viewH);
  const st = clamp(scrollTop, 0, maxTop);
  const topRow = topRowAt(st, viewH, rowH, count, maxPx);
  const first = Math.max(0, Math.floor(topRow) - overscan);
  const last = Math.min(count, Math.ceil(topRow + viewH / rowH) + overscan);
  // 줄 topRow가 화면 맨 위(st)에 오게: first 줄은 그보다 (topRow-first)줄 위
  const top = st - (topRow - first) * rowH;
  return { first, last, top, height };
}

/** 줄 row가 화면 가운데쯤 오는 스크롤 위치 */
export function scrollTopForRow(row: number, viewH: number, rowH: number, count: number, maxPx = LIST_MAX_PX): number {
  const height = listHeight(count, rowH, maxPx);
  const maxTop = Math.max(0, height - viewH);
  const span = Math.max(0, count - viewH / rowH);
  if (maxTop <= 0 || span <= 0) return 0;
  const want = clamp(row + 0.5 - viewH / rowH / 2, 0, span);
  return (want / span) * maxTop;
}

/** 줄 row가 지금 화면 안에 다 보이는지 */
export function rowVisible(row: number, scrollTop: number, viewH: number, rowH: number, count: number, maxPx = LIST_MAX_PX): boolean {
  const top = topRowAt(scrollTop, viewH, rowH, count, maxPx);
  return row >= top - 1e-6 && row + 1 <= top + viewH / rowH + 1e-6;
}

// ───────────────────────── DOM ─────────────────────────

export interface VirtualListOptions {
  rowHeight: number;
  /** 줄 하나 채우기(요소는 다시 쓴다) */
  render: (row: number, el: HTMLElement) => void;
  onClick?: (row: number, ev: MouseEvent) => void;
  className?: string;
}

export class VirtualList {
  readonly el: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private readonly rows: HTMLDivElement;
  private count = 0;
  private raf = 0;
  private pool: HTMLDivElement[] = [];
  private shown: { first: number; last: number } = { first: 0, last: 0 };

  constructor(private readonly opts: VirtualListOptions) {
    this.el = document.createElement('div');
    this.el.className = `vlist ${opts.className ?? ''}`;
    this.el.tabIndex = 0;
    this.inner = document.createElement('div');
    this.inner.className = 'vlist-inner';
    this.rows = document.createElement('div');
    this.rows.className = 'vlist-rows';
    this.inner.append(this.rows);
    this.el.append(this.inner);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.el.addEventListener('click', (ev) => {
      const r = (ev.target as HTMLElement).closest<HTMLElement>('.vlist-row');
      if (!r || !this.el.contains(r)) return;
      const row = Number(r.dataset.row);
      if (Number.isFinite(row)) this.opts.onClick?.(row, ev);
    });
    new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  get rowCount(): number {
    return this.count;
  }

  setCount(n: number): void {
    this.count = Math.max(0, n | 0);
    this.inner.style.height = `${listHeight(this.count, this.opts.rowHeight)}px`;
    this.render();
  }

  /** 보이는 줄을 다시 채운다(강조가 바뀌었을 때) */
  refresh(): void {
    this.render();
  }

  /** 줄이 보이게 스크롤한다(이미 보이면 그대로, center면 늘 가운데로) */
  reveal(row: number, center = false): void {
    if (row < 0 || row >= this.count) return;
    const viewH = this.el.clientHeight;
    if (!viewH) return;
    if (!center && rowVisible(row, this.el.scrollTop, viewH, this.opts.rowHeight, this.count)) return;
    this.el.scrollTop = scrollTopForRow(row, viewH, this.opts.rowHeight, this.count);
    this.render();
  }

  get scrollTop(): number {
    return this.el.scrollTop;
  }

  set scrollTop(v: number) {
    this.el.scrollTop = v;
    this.render();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render(): void {
    const viewH = this.el.clientHeight || 300;
    const w = listWindow(this.el.scrollTop, viewH, this.opts.rowHeight, this.count);
    this.rows.style.transform = `translateY(${w.top}px)`;
    const n = w.last - w.first;
    while (this.pool.length < n) {
      const r = document.createElement('div');
      r.className = 'vlist-row';
      r.style.height = `${this.opts.rowHeight}px`;
      this.pool.push(r);
    }
    while (this.rows.childElementCount > n) this.rows.lastElementChild!.remove();
    for (let i = 0; i < n; i++) {
      const el = this.pool[i]!;
      const row = w.first + i;
      el.dataset.row = String(row);
      this.opts.render(row, el);
      if (el.parentElement !== this.rows) this.rows.append(el);
    }
    this.shown = { first: w.first, last: w.last };
  }

  /** 지금 DOM에 있는 줄 범위 */
  get window(): { first: number; last: number } {
    return this.shown;
  }
}
