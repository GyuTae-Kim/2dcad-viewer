/**
 * 제자리 문자 편집기: 도면 위(문자 자리)에 뜨는 편집 상자와 "문자 편집기" 도구 모음.
 *
 * - 여러 줄 문자(MTEXT·다중 지시선·치수 문자): 문자 스타일·높이, 굵게·기울임꼴·밑줄·윗줄·취소선, 글꼴, 색상,
 *   스택, 자리맞추기, 단락 정렬, 줄 간격두기, 글머리 기호 및 번호 매기기, 열, 기호, 필드, 대소문자, 기울기 각도·자간·폭 비율.
 * - 한 줄 문자(TEXT·속성 정의·DTEXT): 기호·필드만. Enter로 확인한다.
 * - 확인: Ctrl(⌘)+Enter, 도구 모음의 확인, 편집기 바깥 클릭. 취소: Esc(AutoCAD와 같다).
 * - 결과는 MTEXT(또는 TEXT) 서식 문자열이다. 아무것도 고치지 않았으면 처음 문자열을 그대로 돌려준다.
 * 편집 중 Ctrl+Z·Ctrl+Y는 편집기 안의 명령 취소·명령 복구다(도면의 명령 취소와 별개).
 */
import { aciToRgb, rgbToCss } from '../../core/color';
import type { CadColor, MTextColumns } from '../../core/model';
import { tableKey } from '../../core/model';
import { evaluateTemplate } from '../../edit/field/evaluate';
import { isShxFont } from '../../text/layout';
import * as M from '../../text/mtextedit';
import type { App, CommandContext } from '../app';
import { pickColor } from '../ui/colorpick';
import { form, h, showMenu, type MenuItem } from '../ui/dom';
import type { Pt } from '../view';
import { type RenderCtx, ZWSP, fmtCss, fmtOfNode, getSel, readDoc, renderDoc, setSel } from './dom';
import { installEditorStyle } from './style';

export interface EditorInit {
  mode: 'mtext' | 'text';
  /** 접근성 이름(대화상자 제목에 해당) */
  label: string;
  /** 처음 문자열(필드가 있으면 템플릿) */
  text: string;
  /** %<\…>% 필드 코드를 칩으로 */
  fields?: boolean;
  /** 치수 문자: <>를 이 측정값 칩으로 */
  measure?: string;
  /** 객체 문자 높이(도면 단위) */
  height: number;
  style: string;
  /** MTEXT 부착점 1~9 */
  attachment?: number;
  /** MTEXT 폭(0 = 줄바꿈 없음) */
  width?: number;
  /** 문자 방향(라디안, X축에서) */
  rotation?: number;
  /** 부착점(도면 좌표). 없으면 도면 영역 위쪽 가운데에 뜬다 */
  at?: Pt | null;
  /** 한 줄 문자: at이 기준선 왼쪽 점(just가 있으면 그 자리맞추기의 점) */
  baseline?: boolean;
  /** 한 줄 문자의 자리맞추기(TEXT 72·73) */
  just?: { h: number; v: number };
  lineSpacingFactor?: number;
  lineSpacingStyle?: number;
  columns?: MTextColumns;
  rectHeight?: number;
  /** 객체 색(ByLayer면 도면층 색) */
  color?: CadColor;
  layer?: string;
  /** 명령 문맥(필드 대화상자의 객체 선택) */
  ctx?: CommandContext;
  /** 처음에 모두 선택 */
  selectAll?: boolean;
  /** 객체 특성(스타일·높이·자리맞추기·줄 간격·열)을 감춘다(치수 문자) */
  noEntityProps?: boolean;
  /** 도구 모음 끝의 단추 */
  extra?: { label: string; title?: string; run(ed: TextEditor): void }[];
  /** 도면 밖(명령행 등)을 눌러도 닫지 않는다(DTEXT) */
  keepOnOutside?: boolean;
}

export interface EditorResult {
  /** 서식 문자열(필드가 있으면 템플릿) */
  text: string;
  height: number;
  style: string;
  attachment: number;
  width: number;
  lineSpacingFactor: number;
  lineSpacingStyle: number;
  columns?: MTextColumns;
  rectHeight?: number;
  /** 필드가 남아 있다 */
  fields: boolean;
  /** 문자열이나 객체 특성이 바뀌었다 */
  changed: boolean;
  /** 문자열이 바뀌었다 */
  textChanged: boolean;
  /** 보이는 글자(필드는 값) */
  plain: string;
}

export interface EditorHooks {
  /** 한 줄 문자에서 Enter: 처리했으면 true(편집기는 열린 채로) */
  onEnter?(r: EditorResult): boolean;
  /** 편집기 밖 도면 클릭: 처리했으면 true(닫지 않는다) */
  onCanvasClick?(w: Pt, r: EditorResult): boolean;
}

interface Props {
  height: number;
  style: string;
  attachment: number;
  width: number;
  lineSpacingFactor: number;
  lineSpacingStyle: number;
  columns?: MTextColumns;
  rectHeight?: number;
}

interface Snap {
  doc: M.RichDoc;
  props: Props;
  a: number;
  b: number;
}

type ToggleKey = 'bold' | 'italic' | 'underline' | 'overline' | 'strike';

/** 기호(AutoCAD 문자 편집기의 기호 메뉴) */
export const SYMBOLS: { label: string; ch: string }[] = [
  { label: '도 %%d', ch: '\u00b0' },
  { label: '플러스/마이너스 %%p', ch: '\u00b1' },
  { label: '지름 %%c', ch: '\u2205' },
  { label: '거의 같음 \\U+2248', ch: '\u2248' },
  { label: '각도 \\U+2220', ch: '\u2220' },
  { label: '중심선 \\U+2104', ch: '\u2104' },
  { label: '델타 \\U+0394', ch: '\u0394' },
  { label: '전기 위상 \\U+0278', ch: '\u0278' },
  { label: '동일 \\U+2261', ch: '\u2261' },
  { label: '같지 않음 \\U+2260', ch: '\u2260' },
  { label: '옴 \\U+2126', ch: '\u2126' },
  { label: '오메가 \\U+03A9', ch: '\u03a9' },
  { label: '아래 첨자 2 \\U+2082', ch: '\u2082' },
  { label: '제곱 \\U+00B2', ch: '\u00b2' },
  { label: '세제곱 \\U+00B3', ch: '\u00b3' },
  { label: '줄 바꿈하지 않는 공백 Ctrl+Shift+Space', ch: '\u00a0' },
];

const JUSTIFY = ['맨 위 왼쪽 TL', '맨 위 중심 TC', '맨 위 오른쪽 TR', '중간 왼쪽 ML', '중간 중심 MC', '중간 오른쪽 MR', '맨 아래 왼쪽 BL', '맨 아래 중심 BC', '맨 아래 오른쪽 BR'];

const COLORS: { value: string; label: string; c: CadColor }[] = [
  { value: '256', label: 'ByLayer', c: { aci: 256 } },
  { value: '0', label: 'ByBlock', c: { aci: 0 } },
  { value: '1', label: '빨간색', c: { aci: 1 } },
  { value: '2', label: '노란색', c: { aci: 2 } },
  { value: '3', label: '초록색', c: { aci: 3 } },
  { value: '4', label: '하늘색', c: { aci: 4 } },
  { value: '5', label: '파란색', c: { aci: 5 } },
  { value: '6', label: '선홍색', c: { aci: 6 } },
  { value: '7', label: '흰색', c: { aci: 7 } },
];

/** 글꼴 목록(도면의 글꼴 앞에 붙는 기본 목록) */
const FONTS = ['Arial', 'Times New Roman', 'Courier New', '맑은 고딕', '굴림', '바탕', 'txt.shx', 'simplex.shx', 'romans.shx', 'isocp.shx'];

const MIN_PX = 12;
const MAX_PX = 72;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** 열린 편집기(한 번에 하나) */
let current: TextEditor | null = null;

export function activeEditor(): TextEditor | null {
  return current;
}

export class TextEditor {
  readonly wrap: HTMLDivElement;
  readonly box: HTMLDivElement;
  readonly bar: HTMLDivElement;
  doc: M.RichDoc;
  hooks: EditorHooks = {};
  private props: Props;
  private initSer: string;
  private readonly initProps: string;
  private lastSel = { a: 0, b: 0 };
  private undoStack: Snap[] = [];
  private redoStack: Snap[] = [];
  private lastPush = 0;
  private before: M.RichDoc;
  private composing = false;
  private closed = false;
  private suspended = false;
  private resolveFn: ((r: EditorResult | null) => void) | null = null;
  private readonly cleanups: (() => void)[] = [];
  private camKey = '';
  private k = 1;
  private scale = 0;
  private readonly fieldCache = new Map<string, string>();
  private readonly controls: Record<string, HTMLElement> = {};

  constructor(
    readonly app: App | null,
    readonly init: EditorInit,
  ) {
    installEditorStyle();
    this.props = {
      height: init.height > 0 ? init.height : 2.5,
      style: init.style || 'Standard',
      attachment: init.attachment && init.attachment >= 1 && init.attachment <= 9 ? init.attachment : 1,
      width: Math.max(0, init.width ?? 0),
      lineSpacingFactor: init.lineSpacingFactor && init.lineSpacingFactor > 0 ? init.lineSpacingFactor : 1,
      lineSpacingStyle: init.lineSpacingStyle === 2 ? 2 : 1,
      columns: init.columns ? structuredClone(init.columns) : undefined,
      rectHeight: init.rectHeight,
    };
    this.initProps = JSON.stringify(this.props);
    this.doc = M.parseRich(init.text, this.parseOpt());
    if (init.mode === 'text' && this.doc.paras.length > 1) this.doc = { paras: [{ ...this.doc.paras[0]!, items: this.doc.paras.flatMap((p, i) => (i ? [{ k: 'ch', c: ' ', f: {} } as M.Item, ...p.items] : p.items)) }] };
    this.initSer = M.serializeRich(M.stripRaw(this.doc), this.serOpt());
    this.before = M.cloneDoc(this.doc);
    this.box = h('div', {
      class: `te-box${init.mode === 'text' ? ' te-nowrap' : ''}`,
      contenteditable: 'true',
      role: 'textbox',
      'aria-multiline': init.mode === 'mtext' ? 'true' : 'false',
      'aria-label': init.label,
      spellcheck: 'false',
    });
    this.wrap = h('div', { class: 'te-ui te-wrap' }, this.box);
    this.bar = h('div', { class: 'te-ui te-bar', role: 'toolbar', 'aria-label': '문자 편집기' });
    if (init.mode === 'mtext' && !init.noEntityProps) this.wrap.append(this.widthHandle());
    this.buildBar();
  }

  // ---------------------------------------------------------------------------
  // 열기·닫기
  // ---------------------------------------------------------------------------

  /** 편집기를 띄우고 확인(결과)·취소(null)를 기다린다 */
  open(): Promise<EditorResult | null> {
    current?.cancel();
    current = this;
    document.body.append(this.wrap, this.bar);
    this.render();
    this.listen();
    this.place();
    this.box.focus();
    const len = M.docLength(this.doc);
    if (this.init.selectAll) setSel(this.box, this.doc, 0, len);
    else setSel(this.box, this.doc, len);
    this.lastSel = this.init.selectAll ? { a: 0, b: len } : { a: len, b: len };
    this.refreshBar();
    return new Promise((resolve) => (this.resolveFn = resolve));
  }

  /** 지금 내용으로 확인 */
  confirm(): void {
    if (this.closed) return;
    this.sync();
    const r = this.result();
    this.close();
    this.resolveFn?.(r);
  }

  /** 고친 것을 버리고 닫는다 */
  cancel(): void {
    if (this.closed) return;
    this.close();
    this.resolveFn?.(null);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private close(): void {
    this.closed = true;
    if (current === this) current = null;
    for (const f of this.cleanups.splice(0)) f();
    this.wrap.remove();
    this.bar.remove();
    const input = (this.app?.cmd as unknown as { input?: { focus?: () => void } } | undefined)?.input;
    input?.focus?.();
  }

  /** 지금 내용(편집기는 닫지 않는다) */
  result(): EditorResult {
    const ser = M.serializeRich(this.doc, this.serOpt());
    const textChanged = ser !== this.initSer;
    const p = this.props;
    return {
      text: textChanged ? ser : this.init.text,
      height: p.height,
      style: p.style,
      attachment: p.attachment,
      width: p.width,
      lineSpacingFactor: p.lineSpacingFactor,
      lineSpacingStyle: p.lineSpacingStyle,
      columns: p.columns ? structuredClone(p.columns) : undefined,
      rectHeight: p.rectHeight,
      fields: M.hasFields(this.doc),
      textChanged,
      changed: textChanged || JSON.stringify(p) !== this.initProps,
      plain: M.plainText(this.doc, (c) => this.fieldValue(c), this.init.measure ?? '<>'),
    };
  }

  /** 내용을 바꾼다(DTEXT 다음 줄). 처음 문자열도 이것이 된다 */
  reset(text: string): void {
    this.doc = M.parseRich(text, this.parseOpt());
    this.initSer = M.serializeRich(M.stripRaw(this.doc), this.serOpt());
    this.before = M.cloneDoc(this.doc);
    this.undoStack = [];
    this.redoStack = [];
    this.render();
    const len = M.docLength(this.doc);
    setSel(this.box, this.doc, len);
    this.lastSel = { a: len, b: len };
    this.place();
  }

  /** 부착점을 옮긴다(DTEXT 다음 줄·새 위치) */
  moveTo(at: Pt): void {
    this.init.at = at;
    this.camKey = '';
    this.place();
  }

  private parseOpt(): M.ParseOpt {
    return { mode: this.init.mode, fields: this.init.fields, measure: this.init.measure !== undefined };
  }

  private serOpt(): M.SerializeOpt {
    return { mode: this.init.mode, attachment: this.props.attachment };
  }

  // ---------------------------------------------------------------------------
  // 그리기·자리
  // ---------------------------------------------------------------------------

  private renderCtx(): RenderCtx {
    const st = this.app?.active;
    const ts = st?.doc.textStyles.get(tableKey(this.props.style));
    const font = ts ? ts.fontFamily || ts.font || 'txt' : 'txt';
    const shx = ts?.fontFamily ? false : isShxFont(font);
    return {
      baseHeight: this.props.height,
      family: shx ? 'var(--font)' : `"${font.replace(/\.(ttf|ttc|otf)$/i, '').replace(/["\\]/g, '')}", var(--font)`,
      styleShx: shx,
      entityColor: this.entityColor(),
      fieldValue: (c) => this.fieldValue(c),
      measureText: this.init.measure ?? '<>',
      attachment: this.props.attachment,
      lineSpacing: this.props.lineSpacingFactor,
    };
  }

  /** 객체 색(ByLayer는 도면층 색, ByBlock은 흰색) */
  private entityColor(): string {
    const c = this.init.color;
    const st = this.app?.active;
    if (!c) return '#e8ebf0';
    if (c.rgb !== undefined && c.aci !== 0 && c.aci !== 256) return rgbToCss(c.rgb);
    if (c.aci === 256) {
      const l = st?.doc.layers.get(tableKey(this.init.layer ?? '0'))?.color;
      if (l) return l.rgb !== undefined ? rgbToCss(l.rgb) : rgbToCss(aciToRgb(l.aci, true));
      return '#e8ebf0';
    }
    if (c.aci <= 0 || c.aci > 255) return '#e8ebf0';
    return rgbToCss(aciToRgb(c.aci, true));
  }

  private fieldValue(code: string): string {
    let v = this.fieldCache.get(code);
    if (v === undefined) {
      const st = this.app?.active;
      try {
        v = st ? evaluateTemplate(code, { doc: st.doc, fileName: st.saveName || st.name, fileSize: st.size, now: new Date() }).text : '----';
      } catch {
        v = '####';
      }
      this.fieldCache.set(code, v);
    }
    return v;
  }

  /** 모델을 다시 그린다 */
  private render(): void {
    const rc = this.renderCtx();
    renderDoc(this.box, this.doc, rc);
    this.box.style.fontFamily = rc.family;
    this.box.style.color = rc.entityColor;
    this.box.style.lineHeight = String(Math.max(1, 1.1667 * (this.props.lineSpacingStyle === 2 ? 1 : 1) * this.props.lineSpacingFactor));
    this.before = M.cloneDoc(this.doc);
  }

  /** 화면 자리(카메라가 바뀌면 다시) */
  place(): void {
    const view = this.app?.view as unknown as { el?: HTMLElement; worldToScreen?: (x: number, y: number) => Pt; camera?: () => { cx: number; cy: number; scale: number } } | undefined;
    const vr = view?.el?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: window.innerWidth || 800, height: window.innerHeight || 600 };
    const vw = vr.width || window.innerWidth || 800;
    const vh = vr.height || window.innerHeight || 600;
    const at = this.init.at;
    let sx = vr.left + vw / 2;
    let sy = vr.top + vh * 0.3;
    let scale = 0;
    if (at && view?.worldToScreen && view.camera) {
      const s = view.worldToScreen(at.x, at.y);
      sx = vr.left + s.x;
      sy = vr.top + s.y;
      scale = view.camera().scale;
    }
    this.scale = scale;
    const p = this.props;
    const natural = scale > 0 ? (p.height * scale) / 0.7 : 16;
    const fpx = Math.max(MIN_PX, Math.min(MAX_PX, natural));
    this.k = natural > 0 ? fpx / natural : 1;
    const unit = scale > 0 ? scale * this.k : fpx / 0.7 / (p.height || 1);
    this.box.style.fontSize = `${fpx.toFixed(2)}px`;
    // 폭·열
    const cols = p.columns && p.columns.count > 1 && p.columns.type > 0 ? p.columns : null;
    this.box.style.columnCount = '';
    this.box.style.columnGap = '';
    this.box.style.height = '';
    if (this.init.mode === 'mtext' && cols) {
      const w = cols.width * cols.count + cols.gutter * (cols.count - 1);
      this.box.style.width = `${Math.max(40, w * unit)}px`;
      this.box.style.columnCount = String(cols.count);
      this.box.style.columnGap = `${cols.gutter * unit}px`;
      const ch = cols.heights[0] || p.rectHeight || 0;
      if (ch > 0) this.box.style.height = `${ch * unit}px`;
      this.box.classList.remove('te-nowrap');
    } else if (this.init.mode === 'mtext' && p.width > 0) {
      this.box.style.width = `${Math.max(24, p.width * unit)}px`;
      this.box.classList.remove('te-nowrap');
    } else {
      this.box.style.width = '';
      this.box.style.minWidth = scale > 0 ? '' : '260px';
      if (this.init.mode === 'mtext') this.box.classList.add('te-nowrap');
    }
    // 부착점
    const rot = scale > 0 ? (this.init.rotation ?? 0) : 0;
    let tx = '-50%';
    let ty = '0px';
    if (scale > 0) {
      if (this.init.baseline) {
        // 상자 위에서 기준선까지 2 + 0.925em. 대문자 높이 0.7em, 내림 0.2em
        const j = this.init.just ?? { h: 0, v: 0 };
        tx = j.h === 1 || j.h === 4 ? '-50%' : j.h === 2 ? '-100%' : '-4px';
        const lift = j.h === 4 || j.v === 2 ? 0.35 : j.v === 3 ? 0.7 : j.v === 1 ? -0.2 : 0;
        ty = `${-(2 + (0.925 - lift) * fpx).toFixed(1)}px`;
      } else {
        const att = p.attachment;
        const col = (att - 1) % 3;
        const row = Math.floor((att - 1) / 3);
        tx = col === 0 ? '0%' : col === 1 ? '-50%' : '-100%';
        ty = row === 0 ? '0%' : row === 1 ? '-50%' : '-100%';
      }
    }
    this.wrap.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) rotate(${(-rot).toFixed(6)}rad) translate(${tx}, ${ty})`;
    this.placeBar(vr);
    const cam = view?.camera?.();
    this.camKey = cam ? `${cam.cx}|${cam.cy}|${cam.scale}|${vr.left}|${vr.top}|${vw}|${vh}` : 'none';
  }

  private placeBar(vr: { left: number; top: number }): void {
    const r = this.wrap.getBoundingClientRect();
    const bw = this.bar.offsetWidth || 600;
    const bh = this.bar.offsetHeight || 34;
    const W = window.innerWidth || 1000;
    const H = window.innerHeight || 800;
    let top = r.top - bh - 8;
    if (top < Math.max(4, vr.top)) top = r.bottom + 8;
    if (top + bh > H - 4) top = Math.max(4, H - bh - 4);
    const left = Math.max(4, Math.min(W - bw - 4, r.left));
    this.bar.style.left = `${Math.round(left)}px`;
    this.bar.style.top = `${Math.round(top)}px`;
  }

  // ---------------------------------------------------------------------------
  // 이벤트
  // ---------------------------------------------------------------------------

  private on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Window | Document, type: K | string, fn: (ev: Event) => void, opt?: boolean | AddEventListenerOptions): void {
    el.addEventListener(type, fn, opt);
    this.cleanups.push(() => el.removeEventListener(type, fn, opt));
  }

  private listen(): void {
    const box = this.box;
    this.on(box, 'keydown', (ev) => this.onKey(ev as KeyboardEvent));
    this.on(this.bar, 'keydown', (ev) => {
      const k = ev as KeyboardEvent;
      k.stopPropagation();
      if (k.key === 'Escape') {
        k.preventDefault();
        this.cancel();
      } else if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) {
        k.preventDefault();
        this.confirm();
      }
    });
    for (const t of ['keyup', 'keypress']) this.on(this.wrap, t, (ev) => ev.stopPropagation());
    this.on(box, 'compositionstart', () => (this.composing = true));
    this.on(box, 'compositionend', () => {
      this.composing = false;
      setTimeout(() => this.syncTyping(), 0);
    });
    this.on(box, 'input', (ev) => {
      if ((ev as InputEvent).isComposing || this.composing) return;
      this.syncTyping();
    });
    this.on(box, 'beforeinput', (ev) => this.onBeforeInput(ev as InputEvent));
    this.on(box, 'paste', (ev) => this.onPaste(ev as ClipboardEvent));
    this.on(box, 'contextmenu', (ev) => this.onContext(ev as MouseEvent));
    this.on(box, 'dblclick', (ev) => this.onDblClick(ev as MouseEvent));
    this.on(document, 'selectionchange', () => {
      const s = getSel(box);
      if (s) {
        this.lastSel = s;
        this.refreshBar();
      }
    });
    // 바깥 클릭 = 확인(도면 클릭은 선택으로 넘기지 않는다)
    this.on(
      window,
      'pointerdown',
      (ev) => {
        if (this.closed || this.suspended) return;
        const t = ev.target as Element | null;
        if (!t || this.wrap.contains(t) || this.bar.contains(t) || t.closest?.('.te-ui, .menu, .dialog-back, .colorpick')) return;
        const viewEl = (this.app?.view as unknown as { el?: HTMLElement } | undefined)?.el;
        const inCanvas = !!viewEl && typeof viewEl.contains === 'function' && viewEl.contains(t);
        if (!inCanvas && this.init.keepOnOutside) return;
        if (inCanvas) {
          ev.stopPropagation();
          ev.preventDefault();
          const pe = ev as PointerEvent;
          if (this.hooks.onCanvasClick && this.app) {
            const vr = viewEl!.getBoundingClientRect();
            const w = this.app.view.screenToWorld(pe.clientX - vr.left, pe.clientY - vr.top);
            this.sync();
            if (this.hooks.onCanvasClick(w, this.result())) return;
          }
        }
        this.confirm();
      },
      true,
    );
    // 확대·이동하면 따라간다
    if (typeof requestAnimationFrame === 'function') {
      let raf = 0;
      const tick = () => {
        if (this.closed) return;
        const view = this.app?.view as unknown as { el?: HTMLElement; camera?: () => { cx: number; cy: number; scale: number } } | undefined;
        const cam = view?.camera?.();
        const vr = view?.el?.getBoundingClientRect?.();
        const key = cam && vr ? `${cam.cx}|${cam.cy}|${cam.scale}|${vr.left}|${vr.top}|${vr.width}|${vr.height}` : 'none';
        if (key !== this.camKey) this.place();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      this.cleanups.push(() => cancelAnimationFrame(raf));
    }
    this.on(window, 'resize', () => this.place());
  }

  private onKey(ev: KeyboardEvent): void {
    ev.stopPropagation();
    if (ev.isComposing || this.composing) return;
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    const key = ev.key;
    if (key === 'Escape') {
      ev.preventDefault();
      this.cancel();
      return;
    }
    if (key === 'Enter') {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) return this.confirm();
      if (this.init.mode === 'text') return this.enterLine();
      if (ev.altKey) return this.columnBreak();
      return this.edit((lo, hi) => {
        M.deleteRange(this.doc, lo, hi);
        const o = M.splitPara(this.doc, lo);
        return { a: o, b: o };
      });
    }
    if (key === 'Tab') {
      ev.preventDefault();
      if (this.init.mode === 'text') return;
      return this.insertString('\t');
    }
    if (mod && !ev.altKey) {
      const k = key.toLowerCase();
      if (k === 'b' && !ev.shiftKey) return this.prevent(ev, () => this.toggle('bold'));
      if (k === 'i' && !ev.shiftKey) return this.prevent(ev, () => this.toggle('italic'));
      if (k === 'u' && !ev.shiftKey) return this.prevent(ev, () => this.toggle('underline'));
      if (k === 'z' && !ev.shiftKey) return this.prevent(ev, () => this.undo());
      if (k === 'y' || (k === 'z' && ev.shiftKey)) return this.prevent(ev, () => this.redo());
      if (k === 'f') return this.prevent(ev, () => void this.insertField());
      if (key === ' ' && ev.shiftKey) return this.prevent(ev, () => this.insertString('\u00a0'));
    }
  }

  private prevent(ev: Event, fn: () => void): void {
    ev.preventDefault();
    fn();
  }

  private onBeforeInput(ev: InputEvent): void {
    switch (ev.inputType) {
      case 'insertParagraph':
      case 'insertLineBreak':
        // 휴대 기기 키보드의 줄 바꿈(키 이벤트 없이 온다)
        ev.preventDefault();
        if (this.init.mode === 'text') this.enterLine();
        else
          this.edit((lo, hi) => {
            M.deleteRange(this.doc, lo, hi);
            const o = M.splitPara(this.doc, lo);
            return { a: o, b: o };
          });
        return;
      case 'formatBold':
        ev.preventDefault();
        return this.toggle('bold');
      case 'formatItalic':
        ev.preventDefault();
        return this.toggle('italic');
      case 'formatUnderline':
        ev.preventDefault();
        return this.toggle('underline');
      case 'historyUndo':
        ev.preventDefault();
        return this.undo();
      case 'historyRedo':
        ev.preventDefault();
        return this.redo();
      case 'insertFromDrop':
      case 'insertFromPaste':
        // 붙여넣기는 paste에서 서식 없는 글자로
        if (ev.inputType === 'insertFromDrop') {
          ev.preventDefault();
          const t = ev.dataTransfer?.getData('text/plain') ?? '';
          if (t) this.insertString(t);
        }
        return;
    }
  }

  private onPaste(ev: ClipboardEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    let t = ev.clipboardData?.getData('text/plain') ?? '';
    if (!t) return;
    if (this.init.mode === 'text') t = t.replace(/\r?\n/g, ' ');
    this.insertString(t);
  }

  /** 브라우저가 고친 내용을 모델로 읽는다(글자 입력) */
  private syncTyping(): void {
    if (this.closed) return;
    const prev = this.before;
    this.doc = readDoc(this.box);
    if (this.init.mode === 'text' && this.doc.paras.length > 1) {
      // 한 줄 문자에 들어온 줄 바꿈은 공백으로
      const s = getSel(this.box);
      this.doc = { paras: [{ ...this.doc.paras[0]!, items: this.doc.paras.flatMap((p, i) => (i ? [{ k: 'ch', c: ' ', f: {} } as M.Item, ...p.items] : p.items)) }] };
      this.render();
      if (s) setSel(this.box, this.doc, s.a, s.b);
    }
    const now = Date.now();
    if (now - this.lastPush > 700) {
      this.undoStack.push({ doc: prev, props: { ...this.props }, a: this.lastSel.a, b: this.lastSel.b });
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastPush = now;
    this.before = M.cloneDoc(this.doc);
    const s = getSel(this.box);
    if (s) this.lastSel = s;
    this.refreshBar();
    // 줄바꿈 없는 상자는 내용에 따라 커지므로 도구 모음 자리를 다시 본다
    if (this.init.mode === 'text' || !this.props.width) this.place();
  }

  /** DOM → 모델(명령 전에) */
  private sync(): void {
    if (this.closed) return;
    this.doc = readDoc(this.box);
    if (this.init.mode === 'text' && this.doc.paras.length > 1) this.doc = { paras: [{ ...this.doc.paras[0]!, items: this.doc.paras.flatMap((p, i) => (i ? [{ k: 'ch', c: ' ', f: {} } as M.Item, ...p.items] : p.items)) }] };
    const s = getSel(this.box);
    if (s) this.lastSel = s;
  }

  private pushUndo(): void {
    this.undoStack.push({ doc: M.cloneDoc(this.doc), props: structuredClone(this.props), a: this.lastSel.a, b: this.lastSel.b });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.lastPush = 0;
  }

  /** 모델 편집 하나: 동기화 → 명령 취소 기록 → 편집 → 다시 그리기 → 선택 */
  edit(fn: (lo: number, hi: number) => { a: number; b: number } | void): void {
    if (this.closed) return;
    this.sync();
    this.pushUndo();
    const lo = Math.min(this.lastSel.a, this.lastSel.b);
    const hi = Math.max(this.lastSel.a, this.lastSel.b);
    const r = fn(lo, hi) ?? { a: lo, b: hi };
    this.render();
    this.box.focus();
    const len = M.docLength(this.doc);
    const a = Math.min(len, r.a);
    const b = Math.min(len, r.b);
    setSel(this.box, this.doc, a, b);
    this.lastSel = { a, b };
    this.refreshBar();
    this.place();
  }

  /** 객체 특성만 바꾼다(다시 그리기 포함) */
  private setProps(patch: Partial<Props>): void {
    this.sync();
    this.pushUndo();
    Object.assign(this.props, patch);
    this.render();
    this.box.focus();
    setSel(this.box, this.doc, this.lastSel.a, this.lastSel.b);
    this.refreshBar();
    this.place();
  }

  undo(): void {
    this.sync();
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ doc: M.cloneDoc(this.doc), props: structuredClone(this.props), a: this.lastSel.a, b: this.lastSel.b });
    this.restore(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.sync();
    this.undoStack.push({ doc: M.cloneDoc(this.doc), props: structuredClone(this.props), a: this.lastSel.a, b: this.lastSel.b });
    this.restore(s);
  }

  private restore(s: Snap): void {
    this.doc = M.cloneDoc(s.doc);
    this.props = structuredClone(s.props);
    this.render();
    this.box.focus();
    setSel(this.box, this.doc, s.a, s.b);
    this.lastSel = { a: s.a, b: s.b };
    this.refreshBar();
    this.place();
  }

  private enterLine(): void {
    this.sync();
    const r = this.result();
    if (this.hooks.onEnter?.(r)) return;
    this.confirm();
  }

  // ---------------------------------------------------------------------------
  // 편집 명령
  // ---------------------------------------------------------------------------

  /** 선택을 글자로 바꾼다(입력 서식은 커서 앞 글자) */
  insertString(text: string): void {
    this.edit((lo, hi) => {
      const f = M.fmtAt(this.doc, lo);
      M.deleteRange(this.doc, lo, hi);
      const o = M.insertText(this.doc, lo, this.init.mode === 'text' ? text.replace(/[\r\n\t]+/g, ' ') : text, f);
      return { a: o, b: o };
    });
  }

  /** 선택을 조각 하나로 바꾼다 */
  insertItem(item: (f: M.Fmt) => M.Item): void {
    this.edit((lo, hi) => {
      const f = M.fmtAt(this.doc, lo);
      M.deleteRange(this.doc, lo, hi);
      const o = M.insertItems(this.doc, lo, [item(f)]);
      return { a: o, b: o };
    });
  }

  private columnBreak(): void {
    this.edit((lo, hi) => {
      M.deleteRange(this.doc, lo, hi);
      const o = M.splitPara(this.doc, lo, 'N');
      return { a: o, b: o };
    });
  }

  /** 스타일 글꼴(트루타입이면 이름, SHX면 null) */
  private styleTtf(): string | null {
    const ts = this.app?.active?.doc.textStyles.get(tableKey(this.props.style));
    if (!ts) return null;
    if (ts.fontFamily) return ts.fontFamily;
    return isShxFont(ts.font) ? null : ts.font.replace(/\.(ttf|ttc|otf)$/i, '');
  }

  /** 글자의 트루타입 글꼴 지정(없으면 스타일 글꼴로 만든 것, SHX면 null) */
  private ttfSpec(f: M.Fmt): M.FontSpec | null {
    if (f.font) {
      if (f.font.code === 'F' || /\.shx$/i.test(f.font.spec.split('|')[0] ?? '')) return null;
      return M.parseFontSpec(f.font.spec);
    }
    const fam = this.styleTtf();
    return fam ? { family: fam, bold: false, italic: false, rest: [] } : null;
  }

  /** 서식 켜기·끄기(선택이 없으면 다음에 입력할 글자에) */
  toggle(key: ToggleKey): void {
    if (this.closed) return;
    this.sync();
    const lo = Math.min(this.lastSel.a, this.lastSel.b);
    const hi = Math.max(this.lastSel.a, this.lastSel.b);
    const has = (f: M.Fmt): boolean => {
      if (key === 'bold' || key === 'italic') {
        const s = this.ttfSpec(f);
        return !!s && s[key];
      }
      return !!f[key];
    };
    const items = M.itemsIn(this.doc, lo, hi);
    const curFmt = lo === hi ? this.caretFmt() : null;
    const on = lo === hi ? !has(curFmt!) : !items.every((it) => has(it.f));
    if ((key === 'bold' || key === 'italic') && on) {
      const probe = lo === hi ? [curFmt!] : items.map((it) => it.f);
      if (probe.some((f) => !this.ttfSpec(f))) {
        this.app?.cmd.print('굵게·기울임꼴은 트루타입 글꼴에만 적용됩니다. 먼저 트루타입 글꼴을 지정하십시오.', 'err');
        return;
      }
    }
    const fn = (f: M.Fmt): M.Fmt => {
      if (key === 'bold' || key === 'italic') {
        const s = this.ttfSpec(f);
        if (!s) return f;
        s[key] = on;
        return { ...f, font: { code: 'f', spec: M.buildFontSpec(s) } };
      }
      const o = { ...f };
      if (on) o[key] = true;
      else delete o[key];
      return o;
    };
    if (lo === hi) return this.pending(fn);
    this.edit((a, b) => M.applyFmt(this.doc, a, b, fn));
  }

  /** 서식 바꾸기(선택, 없으면 커서 자리의 다음 입력) */
  applyFmt(fn: (f: M.Fmt) => M.Fmt): void {
    this.sync();
    const lo = Math.min(this.lastSel.a, this.lastSel.b);
    const hi = Math.max(this.lastSel.a, this.lastSel.b);
    if (lo === hi) return this.pending(fn);
    this.edit((a, b) => M.applyFmt(this.doc, a, b, fn));
  }

  /** 커서 자리의 서식(0 너비 공백 칸 포함) */
  private caretFmt(): M.Fmt {
    const sel = document.getSelection();
    if (sel?.anchorNode && this.box.contains(sel.anchorNode) && sel.anchorNode !== this.box) {
      const n = sel.anchorNode;
      if (n.nodeType === 3 && (n.nodeValue ?? '').includes(ZWSP)) return fmtOfNode(n, this.box);
    }
    return M.fmtAt(this.doc, Math.min(this.lastSel.a, this.lastSel.b));
  }

  /** 커서 자리에 새 서식의 빈 칸(0 너비 공백)을 넣어 다음 입력이 그 서식을 받게 한다 */
  private pending(fn: (f: M.Fmt) => M.Fmt): void {
    const f = M.cleanFmt(fn({ ...this.caretFmt() }));
    const sel = document.getSelection();
    this.box.focus();
    if (!sel) return;
    if (!sel.rangeCount || !this.box.contains(sel.anchorNode)) setSel(this.box, this.doc, this.lastSel.a);
    if (!sel.rangeCount) return;
    const span = document.createElement('span');
    span.className = 'te-r';
    span.setAttribute('data-f', JSON.stringify(f));
    const css = fmtCss(f, this.renderCtx());
    if (css) span.style.cssText = css;
    span.textContent = ZWSP;
    const r = sel.getRangeAt(0);
    // 빈 문단의 <br> 앞에 넣는다
    r.insertNode(span);
    sel.setBaseAndExtent(span.firstChild!, 1, span.firstChild!, 1);
    this.refreshBar();
  }

  setFont(family: string): void {
    this.applyFmt((f) => {
      const o = { ...f };
      if (!family) delete o.font;
      else if (/\.shx$/i.test(family)) o.font = { code: 'F', spec: family };
      else {
        const old = f.font && f.font.code === 'f' ? M.parseFontSpec(f.font.spec) : null;
        o.font = { code: 'f', spec: M.buildFontSpec({ family, bold: old?.bold ?? false, italic: old?.italic ?? false, rest: old?.rest ?? [] }) };
      }
      return o;
    });
  }

  /** 문자 높이: 선택이 있으면 그 글자(\H), 없거나 전체면 객체 높이 */
  setHeight(v: number): void {
    if (!(v > 0)) return;
    this.sync();
    const lo = Math.min(this.lastSel.a, this.lastSel.b);
    const hi = Math.max(this.lastSel.a, this.lastSel.b);
    const len = M.docLength(this.doc);
    if (lo === hi || (lo === 0 && hi === len)) {
      this.pushUndo();
      if (lo !== hi)
        M.applyFmt(this.doc, 0, len, (f) => {
          const o = { ...f };
          delete o.height;
          return o;
        });
      this.props.height = v;
      this.render();
      this.box.focus();
      setSel(this.box, this.doc, this.lastSel.a, this.lastSel.b);
      this.refreshBar();
      this.place();
      return;
    }
    this.edit((a, b) => M.applyFmt(this.doc, a, b, (f) => ({ ...f, height: { v, rel: false } })));
  }

  setColor(c: CadColor): void {
    this.applyFmt((f) => ({ ...f, color: c.rgb !== undefined && c.aci !== 0 && c.aci !== 256 ? { bgr: ((c.rgb & 0xff) << 16) | (c.rgb & 0xff00) | ((c.rgb >> 16) & 0xff) } : { aci: c.aci } }));
  }

  /** 스택: 선택한 글자(/ # ^ 포함)를 쌓기로, 쌓기 하나를 고르면 풀기 */
  stack(): void {
    this.sync();
    const lo = Math.min(this.lastSel.a, this.lastSel.b);
    const hi = Math.max(this.lastSel.a, this.lastSel.b);
    const items = M.itemsIn(this.doc, lo, hi);
    if (items.length === 1 && items[0]!.k === 'stack') return this.unstack(lo);
    if (!items.length || items.some((it) => it.k !== 'ch') || M.toPos(this.doc, lo).p !== M.toPos(this.doc, hi).p) {
      this.app?.cmd.print('스택할 문자를 한 문단 안에서 선택하십시오(/, # 또는 ^ 포함).', 'err');
      return;
    }
    const text = items.map((it) => (it as { c: string }).c).join('');
    const m = /^(.*?)([/#^])(.*)$/s.exec(text);
    if (!m) {
      this.app?.cmd.print('스택할 문자에 /, # 또는 ^가 있어야 합니다.', 'err');
      return;
    }
    const f = items[0]!.f;
    this.edit((a, b) => {
      M.deleteRange(this.doc, a, b);
      const o = M.insertItems(this.doc, a, [{ k: 'stack', top: M.encodeStack(m[1]!), bot: M.encodeStack(m[3]!), sep: m[2] as M.StackSep, f }]);
      return { a: o, b: o };
    });
  }

  private unstack(at: number): void {
    this.edit(() => {
      const pos = M.toPos(this.doc, at);
      const it = this.doc.paras[pos.p]!.items[pos.i];
      if (it?.k !== 'stack') return;
      M.deleteRange(this.doc, at, at + 1);
      const o = M.insertText(this.doc, at, `${M.decodeStack(it.top)}${it.sep}${M.decodeStack(it.bot)}`, it.f);
      return { a: at, b: o };
    });
  }

  /** 스택 특성(위·아래·스타일) */
  async stackProps(at: number): Promise<void> {
    const pos = M.toPos(this.doc, at);
    const it = this.doc.paras[pos.p]?.items[pos.i];
    if (it?.k !== 'stack') return;
    this.suspended = true;
    const v = await form(
      '스택 특성',
      [
        { key: 'top', label: '위', type: 'text', value: M.decodeStack(it.top) },
        { key: 'bot', label: '아래', type: 'text', value: M.decodeStack(it.bot) },
        {
          key: 'sep',
          label: '스타일',
          type: 'select',
          value: it.sep,
          options: [
            { value: '/', label: '분수(수평)' },
            { value: '#', label: '분수(대각선)' },
            { value: '^', label: '공차' },
          ],
        },
      ],
      { ok: '확인' },
    );
    this.suspended = false;
    if (!v || this.closed) return this.box.focus();
    this.lastSel = { a: at, b: at + 1 };
    this.edit((a) => {
      M.deleteRange(this.doc, a, a + 1);
      const o = M.insertItems(this.doc, a, [{ k: 'stack', top: M.encodeStack(String(v.top)), bot: M.encodeStack(String(v.bot)), sep: String(v.sep) as M.StackSep, f: it.f }]);
      return { a: o, b: o };
    });
  }

  setAlign(a: M.ParaAlign): void {
    this.edit((lo, hi) => M.setParaFmt(this.doc, lo, hi, { align: a }));
  }

  setList(kind: M.ListKind): void {
    const indent = +(this.props.height * 1.5).toFixed(4);
    this.edit((lo, hi) => {
      const before = M.docLength(this.doc);
      const paras = M.parasIn(this.doc, lo, hi);
      M.setList(this.doc, lo, hi, kind, indent);
      const s = M.toOff(this.doc, { p: paras[0]!, i: 0 });
      const last = paras[paras.length - 1]!;
      const e = M.toOff(this.doc, { p: last, i: this.doc.paras[last]!.items.length });
      void before;
      return { a: s, b: e };
    });
  }

  changeCase(upper: boolean): void {
    this.edit((lo, hi) => {
      const s = M.toPos(this.doc, lo);
      const e = M.toPos(this.doc, hi);
      for (let p = s.p; p <= e.p; p++) {
        const items = this.doc.paras[p]!.items;
        for (let i = p === s.p ? s.i : 0; i < (p === e.p ? e.i : items.length); i++) {
          const it = items[i]!;
          if (it.k === 'ch') items[i] = { k: 'ch', c: upper ? it.c.toUpperCase() : it.c.toLowerCase(), f: it.f };
        }
      }
    });
  }

  setLineSpacing(v: string): void {
    if (v === 'clear') return this.setProps({ lineSpacingFactor: 1, lineSpacingStyle: 1 });
    if (v === 'other') {
      this.suspended = true;
      void form(
        '줄 간격두기',
        [
          {
            key: 'style',
            label: '줄 간격두기',
            type: 'select',
            value: String(this.props.lineSpacingStyle),
            options: [
              { value: '1', label: '최소' },
              { value: '2', label: '정확하게' },
            ],
          },
          { key: 'f', label: '간격두기 비율', type: 'number', value: this.props.lineSpacingFactor },
        ],
        { ok: '확인', validate: (x) => (Number(x.f) >= 0.25 && Number(x.f) <= 4 ? null : '간격두기 비율은 0.25에서 4 사이여야 합니다.') },
      ).then((r) => {
        this.suspended = false;
        if (r && !this.closed) this.setProps({ lineSpacingStyle: Number(r.style) === 2 ? 2 : 1, lineSpacingFactor: Number(r.f) });
        else this.box.focus();
      });
      return;
    }
    const n = Number(v);
    if (n > 0) this.setProps({ lineSpacingFactor: n });
  }

  /** 열: none·static2~6·dynamic·break·settings */
  setColumns(v: string): void {
    const p = this.props;
    const gutter = +(p.height * 1.25).toFixed(4);
    const totalH = this.measureHeight(p.width || 0);
    if (v === 'break') return this.columnBreak();
    if (v === 'none') return this.setProps({ columns: undefined });
    if (v.startsWith('static')) {
      const n = Number(v.slice(6)) || 2;
      const W = p.width > 0 ? p.width : Math.max(p.height * 20, 10);
      const cw = Math.max(p.height, (W - gutter * (n - 1)) / n);
      const ch = Math.max(p.height * 2, this.measureHeight(cw) / n);
      return this.setProps({ columns: { type: 1, count: n, width: cw, gutter, autoHeight: false, flowReversed: false, heights: [ch] }, rectHeight: ch, width: cw });
    }
    if (v === 'dynamic') {
      const cw = p.width > 0 ? p.width : Math.max(p.height * 20, 10);
      const ch = Math.max(p.height * 2, this.measureHeight(cw) / 2);
      const n = Math.max(2, Math.ceil(this.measureHeight(cw) / ch - 1e-9));
      return this.setProps({ columns: { type: 2, count: n, width: cw, gutter, autoHeight: true, flowReversed: false, heights: [ch] }, rectHeight: ch, width: cw });
    }
    if (v === 'settings') {
      const c = p.columns;
      this.suspended = true;
      void form(
        '열 설정',
        [
          {
            key: 'type',
            label: '열 유형',
            type: 'select',
            value: String(c?.type ?? 2),
            options: [
              { value: '2', label: '동적 열' },
              { value: '1', label: '정적 열' },
              { value: '0', label: '열 없음' },
            ],
          },
          { key: 'count', label: '열 수(정적)', type: 'number', value: c?.count ?? 2 },
          { key: 'height', label: '높이', type: 'number', value: +(c?.heights[0] ?? Math.max(p.height * 2, totalH / 2)).toFixed(4) },
          { key: 'width', label: '열 폭', type: 'number', value: +(c?.width ?? (p.width || p.height * 20)).toFixed(4) },
          { key: 'gutter', label: '거터', type: 'number', value: +(c?.gutter ?? gutter).toFixed(4) },
        ],
        { ok: '확인', validate: (x) => (Number(x.width) > 0 && Number(x.height) > 0 && Number(x.gutter) >= 0 && Number(x.count) >= 1 ? null : '값이 올바르지 않습니다.') },
      ).then((r) => {
        this.suspended = false;
        if (!r || this.closed) return this.box.focus();
        const type = Number(r.type);
        if (!type) return this.setProps({ columns: undefined });
        const cw = Number(r.width);
        const ch = Number(r.height);
        const n = type === 1 ? Math.max(1, Math.round(Number(r.count))) : Math.max(1, Math.ceil(this.measureHeight(cw) / ch - 1e-9));
        this.setProps({ columns: { type, count: n, width: cw, gutter: Number(r.gutter), autoHeight: false, flowReversed: false, heights: [ch] }, rectHeight: ch, width: cw });
      });
    }
  }

  /** 폭 w로 배치했을 때 문자 전체 높이(도면 단위) */
  private measureHeight(w: number): number {
    const p = this.props;
    try {
      const st = this.app?.active;
      const style = st?.doc.textStyles.get(tableKey(p.style));
      const l = this.app!.text.layoutMText({ text: M.serializeRich(this.doc, this.serOpt()), height: p.height, width: w, attachment: 1, lineSpacingStyle: p.lineSpacingStyle, lineSpacingFactor: p.lineSpacingFactor, style });
      if (Number.isFinite(l.maxY - l.minY) && l.maxY - l.minY > 0) return l.maxY - l.minY;
    } catch {
      /* 아래 대략 */
    }
    return this.doc.paras.length * p.height * 1.667 * p.lineSpacingFactor;
  }

  /** 필드 삽입(Ctrl+F) */
  async insertField(): Promise<void> {
    if (!this.app) return;
    this.sync();
    const sel = { ...this.lastSel };
    this.suspended = true;
    let code: string | null = null;
    try {
      const m = await import('../fieldcmds');
      code = await m.fieldDialog(this.app, this.init.ctx);
    } finally {
      this.suspended = false;
    }
    if (this.closed) return;
    this.box.focus();
    this.lastSel = sel;
    if (!code) return setSel(this.box, this.doc, sel.a, sel.b);
    if (this.init.mode === 'text' || this.init.fields) this.insertItem((f) => ({ k: 'field', code: code!, f }));
    else this.insertString(this.fieldValue(code));
  }

  /** 필드 편집 */
  async editField(at: number): Promise<void> {
    const pos = M.toPos(this.doc, at);
    const it = this.doc.paras[pos.p]?.items[pos.i];
    if (it?.k !== 'field' || !this.app) return;
    this.suspended = true;
    let code: string | null = null;
    try {
      const m = await import('../fieldcmds');
      code = await m.fieldDialog(this.app, this.init.ctx, it.code);
    } finally {
      this.suspended = false;
    }
    if (this.closed) return;
    this.box.focus();
    if (!code) return;
    this.lastSel = { a: at, b: at + 1 };
    this.insertItem((f) => ({ k: 'field', code: code!, f: it.f ?? f }));
  }

  /** 필드를 문자로 */
  fieldToText(at: number): void {
    const pos = M.toPos(this.doc, at);
    const it = this.doc.paras[pos.p]?.items[pos.i];
    if (it?.k !== 'field') return;
    const v = this.fieldValue(it.code);
    this.lastSel = { a: at, b: at + 1 };
    this.edit((a) => {
      M.deleteRange(this.doc, a, a + 1);
      const o = M.insertText(this.doc, a, v, it.f);
      return { a: o, b: o };
    });
  }

  /** 필드 값을 다시 계산한다 */
  updateFields(): void {
    this.fieldCache.clear();
    this.edit(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // 마우스
  // ---------------------------------------------------------------------------

  /** 칩 요소의 모델 오프셋 */
  private atomOffset(el: Element): number {
    const parent = el.parentNode!;
    const idx = [...parent.childNodes].indexOf(el as ChildNode);
    const r = document.createRange();
    r.setStart(parent, idx);
    r.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    return getSel(this.box)?.a ?? 0;
  }

  private onDblClick(ev: MouseEvent): void {
    const t = (ev.target as Element | null)?.closest?.('.te-a');
    if (!t || !this.box.contains(t)) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.sync();
    const at = this.atomOffset(t);
    if (t.classList.contains('te-field')) void this.editField(at);
    else if (t.classList.contains('te-stack')) void this.stackProps(at);
  }

  private onContext(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.sync();
    const t = (ev.target as Element | null)?.closest?.('.te-a');
    const at = t && this.box.contains(t) ? this.atomOffset(t) : -1;
    const items: MenuItem[] = [
      {
        label: '모두 선택',
        kbd: isMac ? '⌘A' : 'Ctrl+A',
        run: () => {
          const len = M.docLength(this.doc);
          this.box.focus();
          setSel(this.box, this.doc, 0, len);
          this.lastSel = { a: 0, b: len };
        },
      },
      { label: '잘라내기', kbd: isMac ? '⌘X' : 'Ctrl+X', run: () => this.clip(true) },
      { label: '복사', kbd: isMac ? '⌘C' : 'Ctrl+C', run: () => this.clip(false) },
      {
        label: '붙여넣기',
        kbd: isMac ? '⌘V' : 'Ctrl+V',
        run: () => {
          void navigator.clipboard
            ?.readText()
            .then((t2) => t2 && this.insertString(t2))
            .catch(() => this.app?.cmd.print('브라우저가 클립보드 읽기를 허용하지 않습니다. Ctrl+V로 붙여넣으십시오.', 'err'));
        },
      },
      { separator: true },
      { label: '필드 삽입...', kbd: isMac ? '⌘F' : 'Ctrl+F', run: () => void this.insertField() },
    ];
    if (t?.classList.contains('te-field')) {
      items.push({ label: '필드 편집...', run: () => void this.editField(at) }, { label: '필드 업데이트', run: () => this.updateFields() }, { label: '필드를 문자로 변환', run: () => this.fieldToText(at) });
    }
    if (t?.classList.contains('te-stack')) items.push({ label: '스택 특성...', run: () => void this.stackProps(at) }, { label: '스택 해제', run: () => this.unstack(at) });
    items.push({ separator: true }, { heading: '기호' }, ...SYMBOLS.slice(0, 6).map((s) => ({ label: s.label, run: () => this.insertString(s.ch) })));
    items.push({ separator: true }, { label: '문자 편집기 닫기', run: () => this.confirm() });
    showMenu(ev.clientX, ev.clientY, items);
    const m = document.querySelector('body > .menu');
    m?.classList.add('te-ui');
  }

  private clip(cut: boolean): void {
    this.box.focus();
    setSel(this.box, this.doc, this.lastSel.a, this.lastSel.b);
    const lo = Math.min(this.lastSel.a, this.lastSel.b);
    const hi = Math.max(this.lastSel.a, this.lastSel.b);
    const text = M.plainText({ paras: [{ items: M.itemsIn(this.doc, lo, hi), pf: M.defaultParaFmt(), praw: [], brk: 'P' }] }, (c) => this.fieldValue(c));
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    if (cut && lo !== hi) this.edit((a, b) => ({ a: M.deleteRange(this.doc, a, b), b: Math.min(a, b) }));
  }

  /** 폭 손잡이(오른쪽 가장자리를 끌어 MTEXT 폭을 바꾼다) */
  private widthHandle(): HTMLElement {
    const hd = h('div', { class: 'te-handle', title: '끌어서 문자 폭 바꾸기', 'aria-hidden': 'true' });
    hd.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.sync();
      this.pushUndo();
      hd.setPointerCapture?.(ev.pointerId);
      const x0 = ev.clientX;
      const y0 = ev.clientY;
      const unit = this.scale > 0 ? this.scale * this.k : 1;
      const w0 = this.props.width > 0 ? this.props.width : this.box.offsetWidth / unit;
      const rot = this.scale > 0 ? (this.init.rotation ?? 0) : 0;
      const move = (e: PointerEvent) => {
        const d = (e.clientX - x0) * Math.cos(rot) - (e.clientY - y0) * Math.sin(rot);
        this.props.width = Math.max(this.props.height, w0 + d / unit);
        if (this.props.columns) this.props.columns = { ...this.props.columns, width: this.props.width };
        this.place();
      };
      const up = () => {
        hd.removeEventListener('pointermove', move as EventListener);
        hd.removeEventListener('pointerup', up);
        hd.removeEventListener('pointercancel', up);
        this.box.focus();
        setSel(this.box, this.doc, this.lastSel.a, this.lastSel.b);
      };
      hd.addEventListener('pointermove', move as EventListener);
      hd.addEventListener('pointerup', up);
      hd.addEventListener('pointercancel', up);
    });
    return hd;
  }

  // ---------------------------------------------------------------------------
  // 도구 모음
  // ---------------------------------------------------------------------------

  private btn(key: string, label: string, title: string, run: () => void, toggle = false): HTMLButtonElement {
    const b = h('button', { type: 'button', title, 'aria-label': title }, label) as HTMLButtonElement;
    if (toggle) b.setAttribute('aria-pressed', 'false');
    // 누를 때 편집 상자의 선택을 잃지 않게
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      run();
    });
    this.controls[key] = b;
    return b;
  }

  /** 고르면 실행하고 첫 항목(이름표)으로 돌아가는 목록 */
  private menuSelect(key: string, title: string, options: { value: string; label: string }[], run: (v: string) => void): HTMLSelectElement {
    const s = h('select', { title, 'aria-label': title }, h('option', { value: '' }, title), ...options.map((o) => h('option', { value: o.value }, o.label))) as HTMLSelectElement;
    s.addEventListener('change', () => {
      const v = s.value;
      s.value = '';
      if (v) run(v);
    });
    this.controls[key] = s;
    return s;
  }

  private buildBar(): void {
    const init = this.init;
    const bar = this.bar;
    const grp = (...els: (HTMLElement | null | false)[]) => h('div', { class: 'te-grp' }, ...els);
    const doc = this.app?.active?.doc;
    if (init.mode === 'mtext') {
      // 스타일
      if (!init.noEntityProps) {
        const styles = doc ? [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1)).map((s) => s.name) : [];
        if (!styles.some((s) => tableKey(s) === tableKey(this.props.style))) styles.unshift(this.props.style);
        const st = h('select', { title: '문자 스타일', 'aria-label': '문자 스타일' }, ...styles.map((s) => h('option', { value: s }, s))) as HTMLSelectElement;
        st.value = styles.find((s) => tableKey(s) === tableKey(this.props.style)) ?? this.props.style;
        st.addEventListener('change', () => this.setProps({ style: st.value }));
        this.controls.style = st;
        bar.append(grp(st));
      }
      const hi = h('input', { title: '문자 높이', 'aria-label': '문자 높이', inputmode: 'decimal' }) as HTMLInputElement;
      hi.value = M.num(this.props.height);
      const applyH = () => {
        const v = Number(hi.value.trim());
        if (v > 0) this.setHeight(v);
        else hi.value = M.num(this.props.height);
      };
      hi.addEventListener('change', applyH);
      hi.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter' && !((ev as KeyboardEvent).ctrlKey || (ev as KeyboardEvent).metaKey)) {
          ev.preventDefault();
          ev.stopPropagation();
          applyH();
        }
      });
      this.controls.height = hi;
      // 형식 지정
      const fonts = new Set<string>(FONTS);
      if (doc) for (const t of doc.textStyles.values()) if (t.fontFamily || t.font) fonts.add(t.fontFamily || t.font);
      const fontSel = h('select', { title: '글꼴', 'aria-label': '글꼴' }, h('option', { value: '' }, '(스타일 글꼴)'), ...[...fonts].map((f) => h('option', { value: f }, f))) as HTMLSelectElement;
      fontSel.addEventListener('change', () => this.setFont(fontSel.value));
      this.controls.font = fontSel;
      const color = h('select', { title: '색상', 'aria-label': '색상' }, h('option', { value: '' }, '색상'), ...COLORS.map((c) => h('option', { value: c.value }, c.label)), h('option', { value: 'more' }, '색상 선택...')) as HTMLSelectElement;
      color.addEventListener('change', () => {
        const v = color.value;
        color.value = '';
        if (v === 'more') {
          this.suspended = true;
          void pickColor({ aci: 7 }, { allowBy: true }).then((c) => {
            this.suspended = false;
            if (c && !this.closed) this.setColor(c);
            else this.box.focus();
          });
        } else if (v) this.setColor(COLORS.find((c) => c.value === v)!.c);
      });
      this.controls.color = color;
      bar.append(
        grp(h('span', { class: 'te-lbl' }, '높이'), hi),
        grp(
          this.btn('bold', 'B', `굵게 (${isMac ? '⌘' : 'Ctrl+'}B)`, () => this.toggle('bold'), true),
          this.btn('italic', 'I', `기울임꼴 (${isMac ? '⌘' : 'Ctrl+'}I)`, () => this.toggle('italic'), true),
          this.btn('underline', 'U', `밑줄 (${isMac ? '⌘' : 'Ctrl+'}U)`, () => this.toggle('underline'), true),
          this.btn('overline', 'O', '윗줄', () => this.toggle('overline'), true),
          this.btn('strike', 'S', '취소선', () => this.toggle('strike'), true),
          fontSel,
          color,
          this.btn('stack', '½', '스택', () => this.stack()),
          this.menuSelect('case', 'Aa', [
            { value: 'up', label: '대문자' },
            { value: 'low', label: '소문자' },
          ], (v) => this.changeCase(v === 'up')),
        ),
      );
      this.controls.bold!.style.fontWeight = '700';
      this.controls.italic!.style.fontStyle = 'italic';
      this.controls.underline!.style.textDecoration = 'underline';
      this.controls.overline!.style.textDecoration = 'overline';
      this.controls.strike!.style.textDecoration = 'line-through';
      // 단락
      const para = grp(
        init.noEntityProps ? null : this.menuSelect('justify', '자리맞추기', JUSTIFY.map((l, i) => ({ value: String(i + 1), label: l })), (v) => this.setProps({ attachment: Number(v) })),
        this.btn('al', '⇤', '왼쪽 정렬', () => this.setAlign('l'), true),
        this.btn('ac', '≡', '중심', () => this.setAlign('c'), true),
        this.btn('ar', '⇥', '오른쪽 정렬', () => this.setAlign('r'), true),
        this.btn('aj', '☰', '양쪽 맞춤', () => this.setAlign('j'), true),
        this.btn('ad', '⇹', '분산', () => this.setAlign('d'), true),
        init.noEntityProps
          ? null
          : this.menuSelect('spacing', '줄 간격두기', [
              { value: '1', label: '1.0x' },
              { value: '1.5', label: '1.5x' },
              { value: '2', label: '2.0x' },
              { value: '2.5', label: '2.5x' },
              { value: 'other', label: '기타...' },
              { value: 'clear', label: '줄 간격두기 지우기' },
            ], (v) => this.setLineSpacing(v)),
        this.menuSelect('list', '글머리 기호 및 번호 매기기', [
          { value: 'off', label: '끄기' },
          { value: 'number', label: '숫자' },
          { value: 'lower', label: '문자 - 소문자' },
          { value: 'upper', label: '문자 - 대문자' },
          { value: 'bullet', label: '글머리 기호' },
        ], (v) => this.setList(v as M.ListKind)),
      );
      bar.append(para);
      // 삽입
      bar.append(
        grp(
          init.noEntityProps
            ? null
            : this.menuSelect('columns', '열', [
                { value: 'none', label: '열 없음' },
                { value: 'dynamic', label: '동적 열' },
                ...[2, 3, 4, 5, 6].map((n) => ({ value: `static${n}`, label: `정적 열 ${n}` })),
                { value: 'break', label: '열 구분 삽입 Alt+Enter' },
                { value: 'settings', label: '열 설정...' },
              ], (v) => this.setColumns(v)),
          this.menuSelect('symbol', '기호', SYMBOLS.map((s, i) => ({ value: String(i), label: s.label })), (v) => this.insertString(SYMBOLS[Number(v)]!.ch)),
          this.btn('field', '필드', `필드 삽입 (${isMac ? '⌘' : 'Ctrl+'}F)`, () => void this.insertField()),
        ),
      );
      // 도구
      const more = this.btn('more', '…', '형식 더 보기(기울기 각도·자간·폭 비율)', () => {
        bar.classList.toggle('te-show-more');
        this.place();
      });
      bar.append(grp(this.btn('undo', '↶', `명령 취소 (${isMac ? '⌘' : 'Ctrl+'}Z)`, () => this.undo()), this.btn('redo', '↷', `명령 복구 (${isMac ? '⌘' : 'Ctrl+'}Y)`, () => this.redo()), more));
    } else {
      bar.append(grp(this.menuSelect('symbol', '기호', SYMBOLS.map((s, i) => ({ value: String(i), label: s.label })), (v) => this.insertString(SYMBOLS[Number(v)]!.ch)), this.btn('field', '필드', `필드 삽입 (${isMac ? '⌘' : 'Ctrl+'}F)`, () => void this.insertField())));
    }
    if (init.extra?.length) bar.append(grp(...init.extra.map((x, i) => this.btn(`extra${i}`, x.label, x.title ?? x.label, () => x.run(this)))));
    const ok = this.btn('ok', '확인', `문자 편집기 닫기 (${isMac ? '⌘' : 'Ctrl+'}Enter)`, () => this.confirm());
    ok.classList.add('te-ok');
    bar.append(grp(ok, this.btn('cancel', '취소', '취소 (Esc)', () => this.cancel())));
    if (init.mode === 'mtext') {
      const num = (label: string, title: string, get: (f: M.Fmt) => number | undefined, set: (f: M.Fmt, v: number) => M.Fmt, lo: number, hi2: number) => {
        const i = h('input', { title, 'aria-label': title, inputmode: 'decimal' }) as HTMLInputElement;
        i.addEventListener('change', () => {
          const v = Number(i.value.trim());
          if (!Number.isFinite(v) || v < lo || v > hi2) {
            this.app?.cmd.print(`${title}: ${lo}에서 ${hi2} 사이의 값을 입력하십시오.`, 'err');
            return;
          }
          this.applyFmt((f) => set(f, v));
        });
        i.addEventListener('keydown', (ev) => {
          if ((ev as KeyboardEvent).key === 'Enter') {
            ev.preventDefault();
            i.dispatchEvent(new Event('change'));
          }
        });
        this.controls[`n-${label}`] = i;
        (i as HTMLInputElement & { _get?: typeof get })._get = get;
        return h('label', { style: 'display:flex;gap:3px;align-items:center' }, h('span', { class: 'te-lbl' }, label), i);
      };
      bar.append(
        h(
          'div',
          { class: 'te-more' },
          num('기울기 각도', '기울기 각도(−85~85)', (f) => f.oblique ?? 0, (f, v) => ({ ...f, oblique: v || undefined }), -85, 85),
          num('자간', '자간(0.75~4)', (f) => f.tracking ?? 1, (f, v) => ({ ...f, tracking: v === 1 ? undefined : v }), 0.75, 4),
          num('폭 비율', '폭 비율(0.1~10)', (f) => f.width ?? 1, (f, v) => ({ ...f, width: v === 1 ? undefined : v }), 0.1, 10),
        ),
      );
    }
  }

  /** 도구 모음의 눌림 상태·값을 선택에 맞춘다 */
  private refreshBar(): void {
    if (this.init.mode !== 'mtext') return;
    const lo = Math.min(this.lastSel.a, this.lastSel.b);
    const hi = Math.max(this.lastSel.a, this.lastSel.b);
    const fs = lo === hi ? [this.caretFmt()] : M.itemsIn(this.doc, lo, hi).map((it) => it.f);
    if (!fs.length) fs.push({});
    const all = (fn: (f: M.Fmt) => boolean) => fs.every(fn);
    const set = (key: string, on: boolean) => this.controls[key]?.setAttribute('aria-pressed', on ? 'true' : 'false');
    const spec = (f: M.Fmt) => this.ttfSpec(f);
    set('bold', all((f) => !!spec(f)?.bold));
    set('italic', all((f) => !!spec(f)?.italic));
    set('underline', all((f) => !!f.underline));
    set('overline', all((f) => !!f.overline));
    set('strike', all((f) => !!f.strike));
    const shx = fs.some((f) => !spec(f));
    (this.controls.bold as HTMLButtonElement | undefined)?.toggleAttribute('disabled', shx);
    (this.controls.italic as HTMLButtonElement | undefined)?.toggleAttribute('disabled', shx);
    const font = this.controls.font as HTMLSelectElement | undefined;
    if (font) {
      const fams = new Set(fs.map((f) => (f.font ? (f.font.code === 'F' ? f.font.spec : M.parseFontSpec(f.font.spec).family) : '')));
      const v = fams.size === 1 ? [...fams][0]! : '';
      if (v && ![...font.options].some((o) => o.value === v)) font.append(h('option', { value: v }, v));
      font.value = v;
    }
    const hiEl = this.controls.height as HTMLInputElement | undefined;
    if (hiEl && document.activeElement !== hiEl) {
      const hs = new Set(fs.map((f) => (f.height ? (f.height.rel ? f.height.v * this.props.height : f.height.v) : this.props.height)));
      hiEl.value = hs.size === 1 ? M.num([...hs][0]!) : '';
    }
    const pas = M.parasIn(this.doc, lo, hi).map((p) => this.doc.paras[p]?.pf.align ?? '');
    const eff = pas.map((a) => a || (['l', 'c', 'r'][(this.props.attachment - 1) % 3] as M.ParaAlign));
    for (const a of ['l', 'c', 'r', 'j', 'd'] as const) set(`a${a}`, eff.length > 0 && eff.every((x) => x === a));
    for (const key of Object.keys(this.controls)) {
      if (!key.startsWith('n-')) continue;
      const i = this.controls[key] as HTMLInputElement & { _get?: (f: M.Fmt) => number | undefined };
      if (document.activeElement === i || !i._get) continue;
      const vs = new Set(fs.map((f) => i._get!(f)));
      i.value = vs.size === 1 ? M.num(Number([...vs][0])) : '';
    }
    (this.controls.undo as HTMLButtonElement | undefined)?.toggleAttribute('disabled', !this.undoStack.length);
    (this.controls.redo as HTMLButtonElement | undefined)?.toggleAttribute('disabled', !this.redoStack.length);
  }
}

/** 편집기를 띄우고 결과를 기다린다 */
export function openTextEditor(app: App | null, init: EditorInit, hooks: EditorHooks = {}): Promise<EditorResult | null> {
  const ed = new TextEditor(app, init);
  ed.hooks = hooks;
  return ed.open();
}
