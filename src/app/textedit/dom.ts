/**
 * 편집 모델(src/text/mtextedit) ↔ 편집기 DOM.
 *
 * 문단은 <div class="te-p">, 같은 서식의 글자는 <span class="te-r" data-f>, 쌓기·필드·측정값은 고칠 수 없는 칩
 * <span class="te-a" contenteditable="false" data-item>, 탭은 글자 '\t'(white-space: pre-wrap)이다.
 * 브라우저가 직접 넣은 글자는 가장 가까운 data-f 조상의 서식을 받는다(readDoc). 서식은 DOM에 JSON으로 두므로
 * 브라우저가 span을 복제해도(나누기·붙이기) 따라간다.
 */
import { aciToRgb, rgbToCss } from '../../core/color';
import { type Fmt, type Item, type Para, type RichDoc, decodeStack, defaultParaFmt, docLength, parseFontSpec, toPos } from '../../text/mtextedit';

/** 0 너비 공백: 커서 자리에 새 서식을 걸어 둘 때(읽을 때 버린다) */
export const ZWSP = '\u200b';

export interface RenderCtx {
  /** 객체 높이(도면 단위): 절대 \H를 배율로 바꿀 때. 글자 크기는 편집 상자 글꼴 크기(em)에 대한 배율로 쓴다 */
  baseHeight: number;
  /** 문자 스타일 글꼴의 CSS 글꼴 패밀리 */
  family: string;
  /** 문자 스타일이 SHX면 굵게·기울임을 그리지 않는다 */
  styleShx: boolean;
  /** 색상 ByLayer·ByBlock일 때 보일 CSS 색 */
  entityColor: string;
  /** 필드 칩에 보일 값 */
  fieldValue(code: string): string;
  /** 측정값 칩(<>)에 보일 값 */
  measureText: string;
  /** MTEXT 부착점(문단 정렬 기본값) */
  attachment: number;
  /** 줄 간격 비율(1 = 문자 높이의 5/3) */
  lineSpacing: number;
}

const fmtCache = new WeakMap<Element, Fmt>();

/** 요소에 적은 서식 */
function fmtOfElement(el: Element): Fmt {
  let f = fmtCache.get(el);
  if (!f) {
    try {
      f = JSON.parse(el.getAttribute('data-f') || '{}') as Fmt;
    } catch {
      f = {};
    }
    fmtCache.set(el, f);
  }
  return f;
}

/** 노드에 적용되는 서식(가장 가까운 data-f 조상) */
export function fmtOfNode(n: Node, root: Node): Fmt {
  let e: Node | null = n.nodeType === 1 ? n : n.parentNode;
  while (e && e !== root) {
    if (e.nodeType === 1 && (e as Element).hasAttribute('data-f')) return fmtOfElement(e as Element);
    e = e.parentNode;
  }
  return {};
}

/** 서식 → CSS(글꼴 크기·패밀리·굵게·기울임·장식·색) */
export function fmtCss(f: Fmt, rc: RenderCtx): string {
  const css: string[] = [];
  let scale = 1;
  if (f.height) scale = f.height.rel ? f.height.v : f.height.v / (rc.baseHeight || 1);
  if (Math.abs(scale - 1) > 1e-9) css.push(`font-size:${scale.toFixed(4)}em`);
  if (f.font) {
    const fs = parseFontSpec(f.font.spec);
    const shx = f.font.code === 'F' || /\.shx$/i.test(fs.family);
    if (!shx && fs.family) css.push(`font-family:${cssFamily(fs.family)}`);
    if (!shx && fs.bold) css.push('font-weight:700');
    if (!shx && fs.italic) css.push('font-style:italic');
  }
  if (f.oblique) css.push('font-style:oblique 15deg');
  const deco = [f.underline ? 'underline' : '', f.overline ? 'overline' : '', f.strike ? 'line-through' : ''].filter(Boolean);
  if (deco.length) css.push(`text-decoration-line:${deco.join(' ')}`);
  if (f.color) css.push(`color:${fmtColorCss(f.color, rc.entityColor)}`);
  if (f.tracking && Math.abs(f.tracking - 1) > 1e-9) css.push(`letter-spacing:${((f.tracking - 1) * 0.3).toFixed(3)}em`);
  if (f.width && Math.abs(f.width - 1) > 1e-9) css.push(`font-stretch:${Math.round(Math.max(50, Math.min(200, f.width * 100)))}%`);
  if (f.valign === 2) css.push('vertical-align:top');
  else if (f.valign === 1) css.push('vertical-align:middle');
  return css.join(';');
}

/** 서식 색 → CSS(0·256은 객체 색) */
export function fmtColorCss(c: NonNullable<Fmt['color']>, entityColor: string): string {
  if ('bgr' in c) {
    const v = c.bgr;
    return rgbToCss(((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff));
  }
  if (c.aci <= 0 || c.aci >= 256) return entityColor;
  return rgbToCss(aciToRgb(c.aci, true));
}

/** 글꼴 이름 → CSS 글꼴 패밀리(UI 글꼴로 대체) */
export function cssFamily(name: string): string {
  const n = name.replace(/\.(ttf|ttc|otf)$/i, '').replace(/["\\]/g, '');
  const alias: Record<string, string> = { arial: 'Arial', times: 'Times New Roman', cour: 'Courier New', malgun: 'Malgun Gothic', gulim: 'Gulim', batang: 'Batang' };
  const fam = alias[n.toLowerCase()] ?? n;
  return `"${fam}", var(--font)`;
}

function para(doc: RichDoc, p: Para, k: number, rc: RenderCtx, carry: Fmt): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `te-p${p.brk === 'N' && k > 0 ? ' te-col' : ''}`;
  div.setAttribute('data-pf', JSON.stringify({ pf: p.pf, praw: p.praw, brk: p.brk }));
  const align = p.pf.align || (['l', 'c', 'r'][((Math.max(1, Math.min(9, rc.attachment)) - 1) % 3)] as string);
  const cssAlign = { l: 'left', c: 'center', r: 'right', j: 'justify', d: 'justify' }[align] ?? 'left';
  // 문자 높이(대문자 높이)는 글꼴 크기의 0.7em
  const em = (v: number) => `${((v * 0.7) / (rc.baseHeight || 1)).toFixed(4)}em`;
  div.style.cssText = `text-align:${cssAlign};${p.pf.indentLeft ? `padding-left:${em(p.pf.indentLeft)};` : ''}${p.pf.indentRight ? `padding-right:${em(p.pf.indentRight)};` : ''}${p.pf.indentFirst ? `text-indent:${em(p.pf.indentFirst)};` : ''}`;
  if (align === 'd') div.style.textAlignLast = 'justify';
  let i = 0;
  const items = p.items;
  while (i < items.length) {
    const it = items[i]!;
    if (it.k === 'ch' || it.k === 'tab') {
      const key = JSON.stringify(it.f);
      let text = '';
      let j = i;
      while (j < items.length && (items[j]!.k === 'ch' || items[j]!.k === 'tab') && JSON.stringify(items[j]!.f) === key) {
        const x = items[j]!;
        text += x.k === 'tab' ? '\t' : (x as { c: string }).c;
        j++;
      }
      const span = document.createElement('span');
      span.className = 'te-r';
      span.setAttribute('data-f', key);
      const css = fmtCss(it.f, rc);
      if (css) span.style.cssText = css;
      span.textContent = text;
      div.append(span);
      i = j;
      continue;
    }
    div.append(atom(it, rc));
    i++;
  }
  if (!items.length) {
    // 빈 문단: 앞 문단 끝의 서식을 0 너비 공백 칸에 걸어 두어 여기에 입력한 글자가 그 서식을 받게 한다(AutoCAD와 같다)
    const key = JSON.stringify(carry);
    if (key !== '{}') {
      const span = document.createElement('span');
      span.className = 'te-r';
      span.setAttribute('data-f', key);
      const css = fmtCss(carry, rc);
      if (css) span.style.cssText = css;
      span.textContent = ZWSP;
      div.append(span);
    }
    div.append(document.createElement('br'));
  }
  void doc;
  return div;
}

/** 고칠 수 없는 칩(쌓기·필드·측정값) */
export function atom(it: Item, rc: RenderCtx): HTMLSpanElement {
  const span = document.createElement('span');
  span.contentEditable = 'false';
  span.setAttribute('data-item', JSON.stringify({ ...it, f: undefined }));
  span.setAttribute('data-f', JSON.stringify(it.f));
  const css = fmtCss(it.f, rc);
  if (it.k === 'stack') {
    span.className = 'te-a te-stack';
    const top = document.createElement('span');
    top.className = 'te-st-top';
    top.textContent = decodeStack(it.top) || ' ';
    const bot = document.createElement('span');
    bot.className = 'te-st-bot';
    bot.textContent = decodeStack(it.bot) || ' ';
    if (it.sep === '#') {
      span.classList.add('te-st-diag');
      span.append(top, document.createTextNode('/'), bot);
    } else {
      if (it.sep === '/') span.classList.add('te-st-frac');
      span.append(top, bot);
    }
    span.title = '스택(두 번 클릭하면 스택 특성)';
  } else if (it.k === 'field') {
    span.className = 'te-a te-field';
    span.textContent = rc.fieldValue(it.code) || '----';
    span.title = '필드(두 번 클릭하면 필드 편집)';
  } else if (it.k === 'measure') {
    span.className = 'te-a te-measure';
    span.textContent = rc.measureText || '<>';
    span.title = '측정값';
  }
  if (css) span.style.cssText = css;
  return span;
}

/** 모델을 DOM으로 그린다(root의 내용을 바꾼다) */
export function renderDoc(root: HTMLElement, doc: RichDoc, rc: RenderCtx): void {
  const frag = document.createDocumentFragment();
  let carry: Fmt = {};
  doc.paras.forEach((p, k) => {
    frag.append(para(doc, p, k, rc, carry));
    const last = p.items[p.items.length - 1];
    if (last) carry = last.f;
  });
  root.replaceChildren(frag);
}

interface ParaMeta {
  pf: Para['pf'];
  praw: string[];
  brk: Para['brk'];
}

function metaOf(el: Element | null, prev: Para | undefined): ParaMeta {
  const raw = el?.getAttribute('data-pf');
  if (raw) {
    try {
      const m = JSON.parse(raw) as ParaMeta;
      return { pf: { ...defaultParaFmt(), ...m.pf, tabs: [...(m.pf?.tabs ?? [])] }, praw: [...(m.praw ?? [])], brk: m.brk ?? 'P' };
    } catch {
      /* 아래 */
    }
  }
  return { pf: prev ? { ...prev.pf, tabs: [...prev.pf.tabs] } : defaultParaFmt(), praw: [], brk: 'P' };
}

const isBlock = (n: Node): boolean => n.nodeType === 1 && /^(DIV|P|LI|H\d)$/.test((n as Element).tagName);

/** DOM → 모델(브라우저가 고친 내용을 읽는다) */
export function readDoc(root: Node): RichDoc {
  const paras: Para[] = [];
  let cur: Para | null = null;
  // 이미 문단 표지를 쓴 문단 요소(같은 요소가 나뉘어 여러 문단이 될 때 둘째부터는 서식만 잇는다)
  const used = new Set<Element>();
  const start = (el: Element | null, brk?: Para['brk']) => {
    const fresh = !!el && !used.has(el);
    const m = metaOf(fresh ? el : null, paras[paras.length - 1]);
    if (el) used.add(el);
    cur = { items: [], pf: m.pf, praw: m.praw, brk: brk ?? (fresh ? m.brk : 'P') };
    paras.push(cur);
    return cur;
  };
  const walk = (n: Node, block: Element | null) => {
    if (n.nodeType === 3) {
      const text = n.nodeValue ?? '';
      if (!text) return;
      const f = fmtOfNode(n, root);
      for (const c of text) {
        if (c === ZWSP) continue;
        if (!cur) start(block);
        if (c === '\n') {
          start(block, 'P');
          continue;
        }
        if (c === '\t') cur!.items.push({ k: 'tab', f });
        else cur!.items.push({ k: 'ch', c, f });
      }
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.tagName === 'BR') {
      // 문단 끝의 자리 표시 <br>은 버리고, 가운데의 <br>은 문단 나누기
      if (!cur) start(block);
      let next = el.nextSibling;
      while (next && next.nodeType === 3 && !next.nodeValue) next = next.nextSibling;
      if (next) start(block, 'P');
      return;
    }
    const item = el.getAttribute('data-item');
    if (item) {
      if (!cur) start(block);
      try {
        const it = JSON.parse(item) as Item;
        cur!.items.push({ ...it, f: fmtOfNode(el, root) } as Item);
      } catch {
        /* 깨진 칩은 버린다 */
      }
      return;
    }
    if (isBlock(el)) {
      // 문단 요소(또는 브라우저가 넣은 블록): 새 문단
      start(el);
      for (const c of [...el.childNodes]) walk(c, el);
      cur = null;
      return;
    }
    for (const c of [...el.childNodes]) walk(c, block);
  };
  for (const c of [...root.childNodes]) {
    if (isBlock(c)) walk(c, null);
    else {
      if (!cur) start(null);
      walk(c, null);
    }
  }
  if (!paras.length) paras.push({ items: [], pf: defaultParaFmt(), praw: [], brk: 'P' });
  paras[0]!.brk = 'P';
  return { paras };
}

// ---------------------------------------------------------------------------
// 선택 ↔ 오프셋
// ---------------------------------------------------------------------------

/** DOM 점(노드, 오프셋) → 모델 오프셋: 처음부터 그 점까지의 내용을 복제해 읽은 길이 */
export function offsetAt(root: HTMLElement, node: Node, offset: number): number {
  if (!root.contains(node)) return 0;
  const r = document.createRange();
  r.setStart(root, 0);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0;
  }
  const frag = r.cloneContents();
  // 끝이 문단 요소 안이면 복제된 마지막 문단이 그 문단이다. 끝이 root 자신(문단 사이)이면 마지막 문단의 끝
  const d = readDoc(frag);
  const empty = !frag.childNodes.length;
  return empty ? 0 : docLength(d);
}

/** 지금 선택(편집기 안이 아니면 null): 시작·끝(앞뒤 순서 그대로) */
export function getSel(root: HTMLElement): { a: number; b: number } | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || !sel.anchorNode || !root.contains(sel.anchorNode) || !sel.focusNode || !root.contains(sel.focusNode)) return null;
  const a = offsetAt(root, sel.anchorNode, sel.anchorOffset);
  const b = sel.isCollapsed ? a : offsetAt(root, sel.focusNode, sel.focusOffset);
  return { a, b };
}

/** 모델 오프셋 → DOM 점 */
export function pointAt(root: HTMLElement, doc: RichDoc, off: number): { node: Node; offset: number } {
  const pos = toPos(doc, off);
  const paras = [...root.children].filter((c) => c.classList.contains('te-p'));
  const div = paras[pos.p];
  if (!div) return { node: root, offset: root.childNodes.length };
  if (pos.i === 0) {
    // 문단 처음: 첫 글자 마디 앞(서식을 잇도록 글자 마디 안)
    const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1 && (n as Element).hasAttribute('data-item')) break;
      if (n.nodeType === 3 && n.nodeValue) return { node: n, offset: 0 };
      if (n.nodeType === 1 && (n as Element).tagName === 'BR') break;
    }
    return { node: div, offset: 0 };
  }
  let count = 0;
  const walk = (n: Node): { node: Node; offset: number } | null => {
    if (n.nodeType === 3) {
      const t = n.nodeValue ?? '';
      let u = 0;
      for (const c of t) {
        u += c.length;
        if (c === ZWSP) continue;
        count++;
        if (count === pos.i) return { node: n, offset: u };
      }
      return null;
    }
    if (n.nodeType !== 1) return null;
    const el = n as Element;
    if (el.hasAttribute('data-item')) {
      count++;
      if (count === pos.i) {
        const parent = el.parentNode!;
        return { node: parent, offset: [...parent.childNodes].indexOf(el as ChildNode) + 1 };
      }
      return null;
    }
    for (const c of [...el.childNodes]) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(div) ?? { node: div, offset: div.childNodes.length };
}

/** 선택을 오프셋으로 놓는다 */
export function setSel(root: HTMLElement, doc: RichDoc, a: number, b = a): void {
  const sel = root.ownerDocument.getSelection();
  if (!sel) return;
  const pa = pointAt(root, doc, a);
  const pb = a === b ? pa : pointAt(root, doc, b);
  try {
    sel.setBaseAndExtent(pa.node, pa.offset, pb.node, pb.offset);
  } catch {
    /* 붙지 않은 노드 */
  }
}
