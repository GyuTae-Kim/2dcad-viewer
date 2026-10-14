/**
 * 참조 편집 화면 요소: "참조 편집" 대화상자(참조 식별 — 참조 이름 트리·미리보기·경로·중첩 객체 선택 방법, 설정 — 세 항목)와
 * 편집 중에 도면 영역 위에 뜨는 "참조 편집" 띠(작업 세트에 추가·제거, 변경 사항 저장·취소).
 */
import type { App } from './app';
import type { OverlayGeom } from './view';
import { dialog, h } from './ui/dom';

const STYLE = `
.re-dlg{display:flex;flex-direction:column;gap:8px;min-width:0}
.re-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border-soft)}
.re-tabs button{border:0;background:transparent;color:var(--text-dim);padding:5px 12px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
.re-tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
.re-page{display:flex;flex-direction:column;gap:8px;padding-top:4px}
.re-page[hidden]{display:none}
.re-cols{display:flex;gap:12px;flex-wrap:wrap}
.re-col{display:flex;flex-direction:column;gap:4px;flex:1;min-width:200px}
.re-col h4,.re-page h4{margin:0;font-size:12px;font-weight:600;color:var(--text-dim)}
.re-tree{border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);height:180px;overflow:auto;padding:2px 0}
.re-tree button{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:var(--text);text-align:left;padding:3px 8px;cursor:pointer;font:inherit;white-space:nowrap}
.re-tree button:hover{background:var(--bg-hover)}
.re-tree button.on{background:var(--bg-active);color:#fff}
.re-tree button.bad{color:var(--text-faint)}
.re-tree button .k{font-size:11px;color:var(--text-faint)}
.re-tree button.on .k{color:#dbe7f7}
.re-prev{border:1px solid var(--border-soft);border-radius:4px;background:var(--canvas-model);width:100%;height:180px;display:block}
.re-path{font-size:12px;color:var(--text-dim);word-break:break-all;min-height:16px}
.re-msg{font-size:12px;color:var(--danger);min-height:16px}
.re-page label{display:flex;align-items:center;gap:6px}
.re-bar{position:absolute;top:6px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:2px 4px;
 border:1px solid var(--accent);border-radius:6px;background:rgba(46,53,63,.95);box-shadow:0 2px 10px rgba(0,0,0,.35);
 z-index:3;cursor:default;user-select:none;font-size:12px;color:#e8ebf0;white-space:nowrap;max-width:calc(100% - 16px);overflow:hidden}
.re-bar .t{padding:0 8px;color:#a9b2bf;overflow:hidden;text-overflow:ellipsis;max-width:240px}
.re-bar .t b{color:#e8ebf0;font-weight:600}
.re-bar button{border:0;background:transparent;color:inherit;padding:3px 8px;border-radius:4px;cursor:pointer;font:inherit}
.re-bar button:hover{background:#4a5564}
.re-bar button.save{color:#9fd0ff}
.re-bar .sep{width:1px;height:16px;background:#46505d;margin:0 3px}
`;

function ensureStyle(): void {
  if (document.getElementById('re-style')) return;
  const s = document.createElement('style');
  s.id = 're-style';
  s.textContent = STYLE;
  document.head.append(s);
}

export interface RefEditSettings {
  /** 고유한 도면층, 스타일 및 블록 이름 작성 */
  unique: boolean;
  /** 편집을 위한 속성 정의 표시 */
  attdefs: boolean;
  /** 작업 세트에 없는 객체 잠금 */
  lock: boolean;
}

export interface LevelView {
  label: string;
  depth: number;
  kind: 'block' | 'xref';
  path?: string;
  /** 편집할 수 없으면 그 까닭 */
  problem?: string;
  /** 미리보기 형상(정의 좌표) */
  preview(): OverlayGeom | null;
}

export interface RefEditChoice {
  index: number;
  mode: 'auto' | 'prompt';
  settings: RefEditSettings;
}

/** 미리보기: 형상을 캔버스에 맞춰 그린다 */
function drawPreview(cv: HTMLCanvasElement, g: OverlayGeom | null): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 240;
  const hh = cv.clientHeight || 180;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(hh * dpr);
  const c = cv.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, hh);
  if (!g || (!g.segs.length && !g.tris?.length)) {
    c.fillStyle = '#7d8796';
    c.font = '12px sans-serif';
    c.textAlign = 'center';
    c.fillText('미리보기 없음', w / 2, hh / 2);
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (a: readonly number[]) => {
    for (let i = 0; i + 1 < a.length; i += 2) {
      const x = a[i]!;
      const y = a[i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  };
  see(g.segs);
  if (g.tris) see(g.tris);
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const k = (Math.min(w, hh) - 16) / span;
  const ox = w / 2 - ((minX + maxX) / 2) * k;
  const oy = hh / 2 + ((minY + maxY) / 2) * k;
  const X = (x: number) => ox + x * k;
  const Y = (y: number) => oy - y * k;
  if (g.tris?.length) {
    c.fillStyle = 'rgba(200,210,225,.35)';
    c.beginPath();
    const t = g.tris;
    for (let i = 0; i + 5 < t.length; i += 6) {
      c.moveTo(X(t[i]!), Y(t[i + 1]!));
      c.lineTo(X(t[i + 2]!), Y(t[i + 3]!));
      c.lineTo(X(t[i + 4]!), Y(t[i + 5]!));
      c.closePath();
    }
    c.fill();
  }
  c.strokeStyle = '#e8ebf0';
  c.lineWidth = 1;
  c.beginPath();
  const s = g.segs;
  for (let i = 0; i + 3 < s.length; i += 4) {
    c.moveTo(X(s[i]!), Y(s[i + 1]!));
    c.lineTo(X(s[i + 2]!), Y(s[i + 3]!));
  }
  c.stroke();
}

/** "참조 편집" 대화상자. 취소하면 null */
export function refEditDialog(levels: readonly LevelView[], settings: RefEditSettings, mode: 'auto' | 'prompt'): Promise<RefEditChoice | null> {
  ensureStyle();
  return new Promise((resolve) => {
    let done = false;
    let index = levels.findIndex((l) => !l.problem);
    if (index < 0) index = 0;
    const tabId = h('button', { type: 'button', class: 'on' }, '참조 식별');
    const tabSet = h('button', { type: 'button' }, '설정');
    const pageId = h('div', { class: 're-page' });
    const pageSet = h('div', { class: 're-page', hidden: true });
    tabId.addEventListener('click', () => {
      tabId.classList.add('on');
      tabSet.classList.remove('on');
      pageId.hidden = false;
      pageSet.hidden = true;
    });
    tabSet.addEventListener('click', () => {
      tabSet.classList.add('on');
      tabId.classList.remove('on');
      pageSet.hidden = false;
      pageId.hidden = true;
    });
    const tree = h('div', { class: 're-tree', role: 'tree', 'aria-label': '참조 이름' });
    const cv = h('canvas', { class: 're-prev', 'aria-label': '미리보기' }) as HTMLCanvasElement;
    const path = h('div', { class: 're-path' });
    const msg = h('div', { class: 're-msg', role: 'alert' });
    const btns: HTMLButtonElement[] = [];
    const pick = (i: number) => {
      index = i;
      btns.forEach((b, k) => {
        b.classList.toggle('on', k === i);
        b.setAttribute('aria-selected', String(k === i));
      });
      const l = levels[i]!;
      path.textContent = l.kind === 'xref' ? `경로: ${l.path || '(없음)'}` : '';
      msg.textContent = l.problem ?? '';
      requestAnimationFrame(() => drawPreview(cv, l.problem ? null : l.preview()));
    };
    levels.forEach((l, i) => {
      const b = h(
        'button',
        { type: 'button', role: 'treeitem', class: l.problem ? 'bad' : '', title: l.problem ?? '', style: `padding-left:${8 + l.depth * 16}px` },
        l.depth ? '└ ' : '',
        l.label,
        h('span', { class: 'k' }, l.kind === 'xref' && l.depth === 0 ? '외부 참조' : l.kind === 'xref' ? '외부 참조 안 블록' : '블록'),
      ) as HTMLButtonElement;
      b.addEventListener('click', () => pick(i));
      b.addEventListener('dblclick', () => submit());
      btns.push(b);
      tree.append(b);
    });
    const rAuto = h('input', { type: 'radio', name: 're-mode', 'aria-label': '모든 중첩된 객체 자동 선택' }) as HTMLInputElement;
    const rPrompt = h('input', { type: 'radio', name: 're-mode', 'aria-label': '중첩된 객체 선택 프롬프트' }) as HTMLInputElement;
    rAuto.checked = mode === 'auto';
    rPrompt.checked = mode === 'prompt';
    pageId.append(
      h(
        'div',
        { class: 're-cols' },
        h('div', { class: 're-col' }, h('h4', {}, '참조 이름(R):'), tree),
        h('div', { class: 're-col' }, h('h4', {}, '미리보기:'), cv),
      ),
      path,
      h('label', {}, rAuto, '모든 중첩된 객체 자동 선택(A)'),
      h('label', {}, rPrompt, '중첩된 객체 선택 프롬프트(P)'),
      msg,
    );
    const cUnique = h('input', { type: 'checkbox', 'aria-label': '고유한 도면층, 스타일 및 블록 이름 작성' }) as HTMLInputElement;
    const cAtt = h('input', { type: 'checkbox', 'aria-label': '편집을 위한 속성 정의 표시' }) as HTMLInputElement;
    const cLock = h('input', { type: 'checkbox', 'aria-label': '작업 세트에 없는 객체 잠금' }) as HTMLInputElement;
    cUnique.checked = settings.unique;
    cAtt.checked = settings.attdefs;
    cLock.checked = settings.lock;
    pageSet.append(
      h('label', { title: '외부 참조에서 가져온 도면층·스타일·블록 이름을 결합처럼 XREF$0$이름으로 바꿉니다. 끄면 이름을 그대로 두고 현재 도면에 같은 이름이 있으면 현재 도면의 것을 씁니다.' }, cUnique, '고유한 도면층, 스타일 및 블록 이름 작성(C)'),
      h('label', { title: '블록의 속성 정의도 작업 세트에 넣어 고칩니다. 기존 블록 참조의 속성 값은 바뀌지 않습니다(ATTSYNC).' }, cAtt, '편집을 위한 속성 정의 표시(D)'),
      h('label', { title: '작업 세트에 없는 객체는 고를 수 없게 합니다(REFSET으로 추가할 때는 고를 수 있습니다).' }, cLock, '작업 세트에 없는 객체 잠금(L)'),
    );
    const body = h('div', { class: 're-dlg' }, h('div', { class: 're-tabs', role: 'tablist' }, tabId, tabSet), pageId, pageSet);
    body.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent;
      k.stopPropagation();
      if (k.key === 'Enter') submit();
    });
    const submit = () => {
      const l = levels[index];
      if (!l || l.problem) {
        msg.textContent = l?.problem ?? '편집할 참조를 고르십시오.';
        return;
      }
      done = true;
      back.remove();
      resolve({ index, mode: rPrompt.checked ? 'prompt' : 'auto', settings: { unique: cUnique.checked, attdefs: cAtt.checked, lock: cLock.checked } });
    };
    const back = dialog('참조 편집', body, [
      { label: '취소', run: () => undefined },
      { label: '확인', primary: true, run: () => (submit(), true) },
    ]);
    (back.querySelector('.dialog') as HTMLElement | null)?.style.setProperty('width', 'min(600px, 100%)');
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
    pick(index);
  });
}

/** 도면 영역의 입력(그리기·확대)으로 새지 않게 */
function isolate(el: HTMLElement): void {
  for (const t of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel'])
    el.addEventListener(t, (ev) => ev.stopPropagation(), { passive: t !== 'contextmenu' });
  el.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

export interface BarActions {
  add(): void;
  remove(): void;
  save(): void;
  discard(): void;
}

/** 편집 중 도면 영역 위의 "참조 편집" 띠(AutoCAD 리본의 참조 편집 패널과 같은 네 단추) */
export class RefEditBar {
  readonly el: HTMLDivElement;
  private readonly title: HTMLSpanElement;

  constructor(app: App, actions: BarActions) {
    ensureStyle();
    const btn = (label: string, title: string, run: () => void, cls = '') => h('button', { type: 'button', title, 'aria-label': title, class: cls, onclick: () => run() }, label);
    this.title = h('span', { class: 't' });
    this.el = h(
      'div',
      { class: 're-bar', role: 'toolbar', 'aria-label': '참조 편집' },
      this.title,
      h('span', { class: 'sep' }),
      btn('작업 세트에 추가', '작업 세트에 추가(REFSET 추가)', actions.add),
      btn('작업 세트에서 제거', '작업 세트에서 제거(REFSET 제거)', actions.remove),
      h('span', { class: 'sep' }),
      btn('변경 사항 저장', '변경 사항 저장(REFCLOSE 저장)', actions.save, 'save'),
      btn('변경 사항 취소', '변경 사항 취소(REFCLOSE 취소)', actions.discard),
    );
    isolate(this.el);
    app.view.el.append(this.el);
  }

  set(name: string, count: number, visible: boolean): void {
    this.title.replaceChildren('참조 편집: ', h('b', {}, name), ` · 작업 세트 ${count}개`);
    this.el.hidden = !visible;
  }

  dispose(): void {
    this.el.remove();
  }
}
