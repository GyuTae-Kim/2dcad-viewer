/**
 * 여러 줄 명령: MLINE(ML), MLSTYLE(여러 줄 스타일), MLEDIT(여러 줄 편집 도구), -MLEDIT(명령행).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 형상 계산은 src/edit/mline의 순수 함수가 한다.
 */
import type { CadColor, CadDocument, HeaderValue, MLineEntity, MLineStyleElement, MLineStyleObject } from '../core/model';
import { tableKey } from '../core/model';
import { ACI_RGB } from '../core/color';
import type { EditOp } from '../edit/session';
import type { App, CommandContext, Keyword } from './app';
import type { Pt } from './view';
import { currentProps } from './draw';
import { dialog, form, h } from './ui/dom';
import { type MLineStyleEntry, MAX_ELEMENTS, ML_END_INNER, ML_END_LINE, ML_END_OUTER, ML_FILL, ML_JOINTS, ML_START_INNER, ML_START_LINE, ML_START_OUTER, currentMLineStyle, findMLineStyle, listMLineStyles, mlineStyleUseCount, newMLineStyle, sortElements, validateMLineStyle } from '../edit/mline/style';
import { addMLineStyleOps, deleteMLineStyleOps, updateMLineStyleOps } from '../edit/mline/ops';
import { addVertex, cornerJoint, crossJoint, cutAll, cutSingle, deleteVertex, mlineGeometry, nearestElement, nearestSegment, teeJoint, weldAll } from '../edit/mline/geom';
import { mlineDrawing } from '../edit/mline/draw';

const JUST_LABEL = ['맨 위', '0', '맨 아래'];

function headerNum(doc: CadDocument, k: string, d: number): number {
  const v = doc.header.get(k);
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function headerOp(doc: CadDocument, name: string, after: HeaderValue): EditOp[] {
  const before = doc.header.get(name);
  return before === after ? [] : [{ kind: 'header', name, before, after }];
}

function fmtNum(v: number): string {
  return v.toFixed(2);
}

/** 여러 줄 미리보기 선(고무줄): 요소 선과 스타일의 마구리·연결부 */
function previewLines(pts: Pt[], closed: boolean, style: MLineStyleObject | null, scale: number, just: number): { pts: number[]; closed?: boolean }[] {
  if (pts.length < 2) return [];
  const e = { ...mlineGeometry({ points: pts, closed, style, scale, justification: just }), type: 'MLINE' } as MLineEntity;
  const d = mlineDrawing(e, style, 8);
  const flat = (pl: Pt[]) => ({ pts: pl.flatMap((p) => [p.x, p.y]) });
  return [...d.elements.flat().map(flat), ...d.caps.map(flat), ...d.joints.map(flat)];
}

/** 색 → CSS(ByLayer·ByBlock·7은 글자색) */
function cssColor(c: CadColor): string {
  if (c.rgb !== undefined) return `#${c.rgb.toString(16).padStart(6, '0')}`;
  if (c.aci <= 0 || c.aci >= 256 || c.aci === 7) return 'currentColor';
  return `#${(ACI_RGB[c.aci] ?? 0xffffff).toString(16).padStart(6, '0')}`;
}

/** 스타일 미리보기(꺾인 여러 줄 하나를 SVG로) */
function stylePreview(style: MLineStyleObject): SVGSVGElement {
  const offs = style.elements.map((e) => e.offset);
  const span = offs.length ? Math.max(...offs) - Math.min(...offs) : 0;
  const scale = span > 1e-9 ? 14 / span : 1;
  const pts = [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 80, y: 36 },
  ];
  const e = { ...mlineGeometry({ points: pts, closed: false, style, scale, justification: 1 }), type: 'MLINE' } as MLineEntity;
  const d = mlineDrawing(e, style, 12);
  const all = [...d.elements.flat(), ...d.caps, ...d.joints].flat();
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const pad = 4;
  const x0 = Math.min(...xs) - pad;
  const y1 = Math.max(...ys) + pad;
  const w = Math.max(...xs) + pad - x0;
  const hgt = y1 - (Math.min(...ys) - pad);
  const path = (pl: Pt[]) => pl.map((p, i) => `${i ? 'L' : 'M'}${(p.x - x0).toFixed(2)} ${(y1 - p.y).toFixed(2)}`).join('');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w.toFixed(2)} ${hgt.toFixed(2)}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '미리보기');
  svg.style.cssText = 'width:100%;height:120px;background:var(--bg-input);border:1px solid var(--border-soft);border-radius:4px;color:var(--text)';
  const add = (dd: string, stroke: string, fill = 'none', opacity = 1) => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', dd);
    p.setAttribute('stroke', stroke);
    p.setAttribute('fill', fill);
    p.setAttribute('fill-opacity', String(opacity));
    p.setAttribute('stroke-width', '1');
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(p);
  };
  if (d.fill.length) add(d.fill.map((l) => path(l) + 'Z').join(''), 'none', cssColor(style.fillColor), 0.45);
  d.elements.forEach((pls, k) => {
    const c = style.elements[k]?.color ?? { aci: 256 };
    for (const pl of pls) add(path(pl), cssColor(c));
  });
  for (const pl of [...d.caps, ...d.joints]) add(path(pl), 'currentColor');
  return svg;
}

// ---------------------------------------------------------------------------
// MLSTYLE 편집기
// ---------------------------------------------------------------------------

const IN_CSS = 'box-sizing:border-box;height:26px;padding:0 6px;border:1px solid var(--border-soft);border-radius:3px;background:var(--bg-input);color:var(--text);font:inherit';

function colorText(c: CadColor): string {
  if (c.aci === 0) return 'ByBlock';
  if (c.aci === 256) return 'ByLayer';
  return String(c.aci);
}

function parseColor(s: string): CadColor | null {
  const t = s.trim().toUpperCase();
  if (t === 'BYBLOCK') return { aci: 0 };
  if (t === 'BYLAYER') return { aci: 256 };
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 255 ? { aci: n } : null;
}

/**
 * 여러 줄 스타일 편집 대화상자. limited면 설명만 바꿀 수 있다(사용 중인 스타일·STANDARD, AutoCAD와 같다).
 */
function mlineStyleEditor(doc: CadDocument, title: string, start: MLineStyleObject, limited: boolean): Promise<MLineStyleObject | null> {
  return new Promise((resolve) => {
    let done = false;
    const s: MLineStyleObject = structuredClone(start);
    const err = h('div', { class: 'form-error', role: 'alert' });
    const stop = (el: HTMLElement) => (el.addEventListener('keydown', (ev) => ev.stopPropagation()), el);
    const text = (v: string, label: string, w = '100%') => {
      const i = h('input', { type: 'text', 'aria-label': label, style: `${IN_CSS};width:${w}`, disabled: limited });
      i.value = v;
      return stop(i) as HTMLInputElement;
    };
    const check = (on: boolean, label: string) => {
      const c = h('input', { type: 'checkbox', 'aria-label': label, disabled: limited });
      c.checked = on;
      return c;
    };
    const desc = h('input', { type: 'text', 'aria-label': '설명', style: `${IN_CSS};width:100%` });
    desc.value = s.description;
    stop(desc);
    const f = s.flags;
    const caps = {
      ls: check(!!(f & ML_START_LINE), '선 시작'),
      le: check(!!(f & ML_END_LINE), '선 끝'),
      os: check(!!(f & ML_START_OUTER), '외부 호 시작'),
      oe: check(!!(f & ML_END_OUTER), '외부 호 끝'),
      is: check(!!(f & ML_START_INNER), '내부 호 시작'),
      ie: check(!!(f & ML_END_INNER), '내부 호 끝'),
    };
    const a0 = text(String(+((s.startAngle * 180) / Math.PI).toFixed(4)), '각도 시작', '70px');
    const a1 = text(String(+((s.endAngle * 180) / Math.PI).toFixed(4)), '각도 끝', '70px');
    const fillOn = check(!!(f & ML_FILL), '채우기');
    const fillColor = text(colorText(s.fillColor), '채우기 색상', '90px');
    const joints = check(!!(f & ML_JOINTS), '조인 표시');
    const linetypes = ['BYLAYER', 'BYBLOCK', ...[...doc.linetypes.values()].map((l) => l.name).filter((n) => !/^BY(LAYER|BLOCK)$/i.test(n))];
    type ElRow = { off: HTMLInputElement; col: HTMLInputElement; lt: HTMLSelectElement };
    const rows: ElRow[] = [];
    const tbody = h('tbody');
    const addRow = (el: MLineStyleElement) => {
      const lt = h('select', { 'aria-label': '요소 선종류', style: `${IN_CSS};width:100%`, disabled: limited }, ...linetypes.map((n) => h('option', { value: n }, n)));
      lt.value = linetypes.find((n) => tableKey(n) === tableKey(el.linetype)) ?? 'BYLAYER';
      const r: ElRow = { off: text(String(el.offset), '요소 간격띄우기', '90px'), col: text(colorText(el.color), '요소 색상', '90px'), lt };
      rows.push(r);
      const del = h('button', { class: 'btn', type: 'button', disabled: limited }, '삭제');
      const tr = h('tr', {}, h('td', {}, r.off), h('td', {}, r.col), h('td', {}, lt), h('td', {}, del));
      del.addEventListener('click', () => {
        if (rows.length <= 1) return;
        rows.splice(rows.indexOf(r), 1);
        tr.remove();
      });
      tbody.append(tr);
    };
    for (const el of s.elements) addRow(el);
    const add = h('button', { class: 'btn', type: 'button', disabled: limited }, '추가');
    add.addEventListener('click', () => {
      if (rows.length >= MAX_ELEMENTS) {
        err.textContent = `요소는 ${MAX_ELEMENTS}개까지입니다.`;
        return;
      }
      addRow({ offset: 0, color: { aci: 256 }, linetype: 'BYLAYER' });
    });
    const capTable = h(
      'table',
      { style: 'border-collapse:collapse' },
      h('tr', {}, h('th'), h('th', { style: 'padding:0 8px;font-weight:500' }, '시작'), h('th', { style: 'padding:0 8px;font-weight:500' }, '끝')),
      h('tr', {}, h('td', {}, '선'), h('td', { style: 'text-align:center' }, caps.ls), h('td', { style: 'text-align:center' }, caps.le)),
      h('tr', {}, h('td', {}, '외부 호'), h('td', { style: 'text-align:center' }, caps.os), h('td', { style: 'text-align:center' }, caps.oe)),
      h('tr', {}, h('td', {}, '내부 호'), h('td', { style: 'text-align:center' }, caps.is), h('td', { style: 'text-align:center' }, caps.ie)),
      h('tr', {}, h('td', {}, '각도'), h('td', {}, a0), h('td', {}, a1)),
    );
    const body = h(
      'div',
      {},
      h('label', { class: 'form-row' }, h('span', {}, '설명'), desc),
      h(
        'div',
        { style: 'display:grid;grid-template-columns:auto 1fr;gap:16px;margin-top:6px' },
        h('fieldset', { style: 'border:1px solid var(--border-soft);border-radius:4px' }, h('legend', {}, '마구리'), capTable),
        h(
          'div',
          {},
          h('fieldset', { style: 'border:1px solid var(--border-soft);border-radius:4px' }, h('legend', {}, '채우기'), h('label', { style: 'display:flex;gap:6px;align-items:center' }, fillOn, '채우기 색상', fillColor)),
          h('label', { style: 'display:flex;gap:6px;align-items:center;margin-top:8px' }, joints, '조인 표시'),
        ),
      ),
      h('fieldset', { style: 'border:1px solid var(--border-soft);border-radius:4px;margin-top:8px' }, h('legend', {}, '요소'), h('table', { style: 'width:100%;border-collapse:collapse' }, h('thead', {}, h('tr', {}, h('th', { style: 'text-align:left;font-weight:500' }, '간격띄우기'), h('th', { style: 'text-align:left;font-weight:500' }, '색상'), h('th', { style: 'text-align:left;font-weight:500' }, '선종류'), h('th'))), tbody), add),
      limited ? h('div', { class: 'form-note' }, '사용 중인 스타일과 STANDARD는 설명만 바꿀 수 있습니다.') : null,
      h('div', { class: 'form-note' }, '색상: ByLayer, ByBlock 또는 색상 번호(1~255).'),
      err,
    );
    const submit = (): MLineStyleObject | null => {
      const out: MLineStyleObject = structuredClone(s);
      out.description = desc.value;
      if (limited) return out;
      let flags = 0;
      if (caps.ls.checked) flags |= ML_START_LINE;
      if (caps.le.checked) flags |= ML_END_LINE;
      if (caps.os.checked) flags |= ML_START_OUTER;
      if (caps.oe.checked) flags |= ML_END_OUTER;
      if (caps.is.checked) flags |= ML_START_INNER;
      if (caps.ie.checked) flags |= ML_END_INNER;
      if (fillOn.checked) flags |= ML_FILL;
      if (joints.checked) flags |= ML_JOINTS;
      out.flags = flags;
      out.startAngle = (Number(a0.value) * Math.PI) / 180;
      out.endAngle = (Number(a1.value) * Math.PI) / 180;
      const fc = parseColor(fillColor.value);
      if (!fc) return ((err.textContent = '채우기 색상이 올바르지 않습니다.'), null);
      out.fillColor = fc;
      const els: MLineStyleElement[] = [];
      for (const r of rows) {
        const off = Number(r.off.value);
        const col = parseColor(r.col.value);
        if (!Number.isFinite(off)) return ((err.textContent = '간격띄우기는 숫자여야 합니다.'), null);
        if (!col) return ((err.textContent = '요소 색상이 올바르지 않습니다.'), null);
        els.push({ offset: off, color: col, linetype: r.lt.value });
      }
      out.elements = sortElements(els);
      const v = validateMLineStyle(out);
      if (v) return ((err.textContent = v), null);
      return out;
    };
    const back = dialog(title, body, [
      { label: '취소', run: () => ((done = true), resolve(null)) },
      {
        label: '확인',
        primary: true,
        run: () => {
          const out = submit();
          if (!out) return true;
          done = true;
          resolve(out);
        },
      },
    ]);
    const box = back.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = 'min(620px, 100%)';
    new MutationObserver((_, obs) => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    }).observe(document.body, { childList: true });
  });
}

// ---------------------------------------------------------------------------
// MLEDIT
// ---------------------------------------------------------------------------

type ToolKey = 'CC' | 'OC' | 'MC' | 'CT' | 'OT' | 'MT' | 'CJ' | 'AV' | 'DV' | 'CS' | 'CA' | 'WA';

const TOOLS: { key: ToolKey; label: string }[] = [
  { key: 'CC', label: '닫힌 십자형' },
  { key: 'CT', label: '닫힌 T자형' },
  { key: 'CJ', label: '구석 접합' },
  { key: 'CS', label: '단일 자르기' },
  { key: 'OC', label: '열린 십자형' },
  { key: 'OT', label: '열린 T자형' },
  { key: 'AV', label: '정점 추가' },
  { key: 'CA', label: '전체 자르기' },
  { key: 'MC', label: '병합된 십자형' },
  { key: 'MT', label: '병합된 T자형' },
  { key: 'DV', label: '정점 삭제' },
  { key: 'WA', label: '전체 용접' },
];

/** 도구 그림(간단한 선 그림, 48×48) */
function toolIcon(k: ToolKey): string {
  const L = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const H = (cut: boolean[]) => [cut[0] ? L(4, 20, 18, 20) + L(30, 20, 44, 20) : L(4, 20, 44, 20), cut[1] ? L(4, 28, 18, 28) + L(30, 28, 44, 28) : L(4, 28, 44, 28)].join('');
  const V = (cut: boolean[]) => [cut[0] ? L(20, 4, 20, 18) + L(20, 30, 20, 44) : L(20, 4, 20, 44), cut[1] ? L(28, 4, 28, 18) + L(28, 30, 28, 44) : L(28, 4, 28, 44)].join('');
  let g = '';
  switch (k) {
    case 'CC':
      g = H([true, true]) + V([false, false]);
      break;
    case 'OC':
    case 'MC':
      g = H([true, true]) + L(20, 4, 20, 20) + L(28, 4, 28, 20) + L(20, 28, 20, 44) + L(28, 28, 28, 44);
      break;
    case 'CT':
      g = L(4, 20, 44, 20) + L(4, 28, 44, 28) + L(20, 28, 20, 44) + L(28, 28, 28, 44);
      break;
    case 'OT':
    case 'MT':
      g = L(4, 20, 44, 20) + L(4, 28, 20, 28) + L(28, 28, 44, 28) + L(20, 28, 20, 44) + L(28, 28, 28, 44);
      break;
    case 'CJ':
      g = L(4, 20, 28, 20) + L(4, 28, 20, 28) + L(28, 20, 28, 44) + L(20, 28, 20, 44);
      break;
    case 'AV':
      g = L(4, 20, 44, 20) + L(4, 28, 44, 28) + '<circle cx="24" cy="24" r="3"/>';
      break;
    case 'DV':
      g = L(4, 28, 24, 12) + L(24, 12, 44, 28) + L(4, 36, 44, 36);
      break;
    case 'CS':
      g = L(4, 20, 18, 20) + L(30, 20, 44, 20) + L(4, 28, 44, 28);
      break;
    case 'CA':
      g = L(4, 20, 18, 20) + L(30, 20, 44, 20) + L(4, 28, 18, 28) + L(30, 28, 44, 28);
      break;
    case 'WA':
      g = L(4, 20, 44, 20) + L(4, 28, 44, 28) + L(18, 16, 18, 32) + L(30, 16, 30, 32);
      break;
  }
  return `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2">${g}</svg>`;
}

function chooseTool(): Promise<ToolKey | null> {
  return new Promise((resolve) => {
    let done = false;
    const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px' });
    const back = dialog('여러 줄 편집 도구', h('div', {}, h('div', { style: 'margin-bottom:8px;color:var(--text-dim)' }, '도구를 사용하려면 아이콘을 클릭하십시오.'), grid), [{ label: '닫기', run: () => ((done = true), resolve(null)) }]);
    for (const t of TOOLS) {
      const b = h('button', { class: 'btn', type: 'button', style: 'display:flex;flex-direction:column;align-items:center;gap:4px;height:auto;padding:6px', title: `${t.label} (${t.key})` });
      b.innerHTML = toolIcon(t.key);
      b.append(h('span', { style: 'font-size:12px' }, t.label));
      b.addEventListener('click', () => {
        done = true;
        back.remove();
        resolve(t.key);
      });
      grid.append(b);
    }
    const box = back.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = 'min(560px, 100%)';
    new MutationObserver((_, obs) => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    }).observe(document.body, { childList: true });
  });
}

interface Picked {
  e: MLineEntity;
  block: string;
  point: Pt;
}

async function pickMLine(app: App, ctx: CommandContext, prompt: string, keywords: Keyword[]): Promise<Picked | 'U' | null> {
  const st = app.active!;
  for (;;) {
    const r = await ctx.getEntity(prompt, keywords);
    if ('enter' in r) return null;
    if ('keyword' in r) return r.keyword === 'U' ? 'U' : null;
    const e = st.doc.entityIndex.get(r.handle);
    const block = st.session.ownerOf(r.handle);
    if (e?.type !== 'MLINE' || !block) {
      ctx.print('여러 줄을 선택하십시오.', 'err');
      continue;
    }
    if (st.doc.layers.get(tableKey(e.layer))?.locked) {
      ctx.print('객체가 잠긴 도면층에 있습니다.', 'err');
      continue;
    }
    return { e, block, point: r.point };
  }
}

function styleOf(doc: CadDocument, e: MLineEntity): MLineStyleObject | null {
  return findMLineStyle(doc, e.styleHandle ?? e.styleName)?.style ?? findMLineStyle(doc, e.styleName)?.style ?? null;
}

async function runMLEdit(app: App, ctx: CommandContext, tool: ToolKey): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const steps: number[] = [];
  const label = TOOLS.find((t) => t.key === tool)!.label;
  const commit = (ops: EditOp[]) => {
    if (!ops.length) return;
    st.session.commit({ label: 'MLEDIT', ops, group: ctx.group });
    steps.push(ops.length);
  };
  const undoKw = (): Keyword[] => (steps.length ? [{ key: 'U', label: '명령 취소' }] : []);
  const undo = () => {
    const n = steps.pop();
    if (n) st.session.undoLastStep(ctx.group, n);
  };
  const two = tool === 'CC' || tool === 'OC' || tool === 'MC' || tool === 'CT' || tool === 'OT' || tool === 'MT' || tool === 'CJ';
  const pts = tool === 'CS' || tool === 'CA' || tool === 'WA';
  for (;;) {
    const firstPrompt = two ? (steps.length ? '첫 번째 여러 줄 선택 또는 [명령 취소(U)]:' : '첫 번째 여러 줄 선택:') : steps.length ? '여러 줄 선택 또는 [명령 취소(U)]:' : '여러 줄 선택:';
    const a = await pickMLine(app, ctx, firstPrompt, undoKw());
    if (a === 'U') {
      undo();
      continue;
    }
    if (!a) return;
    if (two) {
      const b = await pickMLine(app, ctx, '두 번째 여러 줄 선택:', []);
      if (b === 'U' || !b) return;
      if (b.e.handle === a.e.handle) {
        ctx.print('서로 다른 여러 줄 두 개를 선택하십시오.', 'err');
        continue;
      }
      const sa = nearestSegment(a.e, a.point)?.seg ?? 0;
      const sb = nearestSegment(b.e, b.point)?.seg ?? 0;
      let res: { a: MLineEntity; b: MLineEntity } | null = null;
      if (tool === 'CC' || tool === 'OC' || tool === 'MC') res = crossJoint(a.e, sa, b.e, sb, tool === 'CC' ? 'closed' : tool === 'OC' ? 'open' : 'merged');
      else if (tool === 'CJ') res = cornerJoint(a.e, sa, a.point, b.e, sb, b.point);
      else res = teeJoint(a.e, sa, a.point, b.e, sb, tool === 'CT' ? 'closed' : tool === 'OT' ? 'open' : 'merged');
      if (!res) {
        ctx.print(`${label}: 두 여러 줄이 만나지 않거나(평행) 닫힌 여러 줄입니다.`, 'err');
        continue;
      }
      const ops: EditOp[] = [];
      if (JSON.stringify(res.a) !== JSON.stringify(a.e)) ops.push({ kind: 'modify', block: a.block, before: a.e, after: res.a });
      if (JSON.stringify(res.b) !== JSON.stringify(b.e)) ops.push({ kind: 'modify', block: b.block, before: b.e, after: res.b });
      commit(ops);
      continue;
    }
    let out: MLineEntity | null = null;
    if (tool === 'AV') {
      out = addVertex(a.e, a.point);
      if (!out) ctx.print('정점 위에서는 정점을 추가할 수 없습니다.', 'err');
    } else if (tool === 'DV') {
      const s = styleOf(doc, a.e);
      out = deleteVertex(a.e, a.point, s?.startAngle, s?.endAngle);
      if (!out) ctx.print('정점이 너무 적어 삭제할 수 없습니다.', 'err');
    } else if (pts) {
      const r = await ctx.getPoint('두 번째 점 선택:', { base: a.point });
      if (!('point' in r)) return;
      if (tool === 'CS') {
        const k = nearestElement(a.e, a.point)?.k ?? 0;
        out = cutSingle(a.e, k, a.point, r.point);
      } else if (tool === 'CA') out = cutAll(a.e, a.point, r.point);
      else out = weldAll(a.e, a.point, r.point);
    }
    if (out) commit([{ kind: 'modify', block: a.block, before: a.e, after: out }]);
  }
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

export function registerMLineCommands(app: App): void {
  // ------------------------------------------------------------- MLINE
  app.register({
    name: 'MLINE',
    aliases: ['ML'],
    title: '여러 줄',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const metric = headerNum(doc, '$MEASUREMENT', 1) === 1;
      let just = Math.min(2, Math.max(0, Math.round(headerNum(doc, '$CMLJUST', 0))));
      let scale = headerNum(doc, '$CMLSCALE', metric ? 20 : 1);
      let style = currentMLineStyle(doc);
      const status = () => ctx.print(`현재 설정: 자리맞추기 = ${JUST_LABEL[just]}, 축척 = ${fmtNum(scale)}, 스타일 = ${(style?.name ?? 'STANDARD').toUpperCase()}`);
      status();
      const pts: Pt[] = [];
      let handle: string | null = null;
      let closed = false;
      const saveSettings = () => {
        const ops = [...headerOp(doc, '$CMLJUST', just), ...headerOp(doc, '$CMLSCALE', scale), ...headerOp(doc, '$CMLSTYLE', style?.name ?? 'Standard')];
        if (ops.length) st.session.commit({ label: 'MLINE', ops, group: ctx.group });
      };
      // 시작점과 설정
      for (;;) {
        const r = await ctx.getPoint('시작점 지정 또는 [자리맞추기(J)/축척(S)/스타일(ST)]:', {
          keywords: [
            { key: 'J', label: '자리맞추기' },
            { key: 'S', label: '축척' },
            { key: 'ST', label: '스타일' },
          ],
        });
        if ('enter' in r) return;
        if ('point' in r) {
          pts.push(r.point);
          break;
        }
        if (!('keyword' in r)) continue;
        if (r.keyword === 'J') {
          const v = await ctx.getPoint(`자리맞추기 유형 입력 [맨 위(T)/0(Z)/맨 아래(B)] <${JUST_LABEL[just]}>:`, {
            keywords: [
              { key: 'T', label: '맨 위' },
              { key: 'Z', label: '0' },
              { key: 'B', label: '맨 아래' },
            ],
          });
          if ('keyword' in v) just = v.keyword === 'T' ? 0 : v.keyword === 'Z' ? 1 : 2;
        } else if (r.keyword === 'S') {
          const v = await ctx.getPoint(`여러 줄 축척 입력 <${fmtNum(scale)}>:`, { preferNumber: true });
          if ('text' in v) {
            const n = Number(v.text);
            if (Number.isFinite(n) && n !== 0) scale = n;
            else ctx.print('0이 아닌 숫자를 입력하십시오.', 'err');
          }
        } else if (r.keyword === 'ST') {
          for (;;) {
            const v = await ctx.getPoint('여러 줄 스타일 이름 입력 또는 [?]:', { allowText: true });
            if (!('text' in v)) break;
            const name = v.text.trim();
            if (name === '?') {
              ctx.print('로드된 여러 줄 스타일:');
              for (const s of listMLineStyles(doc)) ctx.print(`  ${s.name.padEnd(20)} ${s.style.description}`);
              continue;
            }
            const f = findMLineStyle(doc, name);
            if (!f) {
              ctx.print(`여러 줄 스타일 ${name}을(를) 찾을 수 없습니다.`, 'err');
              continue;
            }
            style = f;
            break;
          }
        }
        status();
      }
      saveSettings();
      const sObj = style?.style ?? null;
      const make = (): MLineEntity => ({ ...currentProps(app), type: 'MLINE', handle: handle ?? '', ...mlineGeometry({ points: pts, closed, style: sObj, scale, justification: just }) });
      const commit = () => {
        const e = make();
        if (!handle) {
          handle = st.session.newHandle();
          e.handle = handle;
          const space = doc.blocks.get(st.space);
          if (space?.recordHandle) e.owner = space.recordHandle;
          st.session.commit({ label: 'MLINE', ops: [{ kind: 'add', block: st.space, entity: e }], group: ctx.group });
          app.lastCreated = [handle];
        } else {
          const before = doc.entityIndex.get(handle);
          if (before) st.session.commit({ label: 'MLINE', ops: [{ kind: 'modify', block: st.space, before, after: { ...e, owner: before.owner } as MLineEntity }], group: ctx.group });
        }
      };
      for (;;) {
        const n = pts.length;
        const kws: Keyword[] = n >= 3 ? [{ key: 'C', label: '닫기' }, { key: 'U', label: '명령 취소' }] : n >= 2 ? [{ key: 'U', label: '명령 취소' }] : [];
        const prompt = n >= 3 ? '다음 점 지정 또는 [닫기(C)/명령 취소(U)]:' : n >= 2 ? '다음 점 지정 또는 [명령 취소(U)]:' : '다음 점 지정:';
        const r = await ctx.getPoint(prompt, { base: pts[n - 1]!, keywords: kws, rubber: (q) => previewLines([...pts, q], false, sObj, scale, just) });
        if ('enter' in r) return;
        if ('keyword' in r) {
          if (r.keyword === 'U' && n >= 2) {
            pts.pop();
            if (pts.length >= 2) commit();
            else if (handle) {
              st.session.undoLastStep(ctx.group, 1);
              handle = null;
            }
            continue;
          }
          if (r.keyword === 'C' && n >= 3) {
            closed = true;
            commit();
            return;
          }
          continue;
        }
        if (!('point' in r)) continue;
        const last = pts[n - 1]!;
        if (Math.hypot(r.point.x - last.x, r.point.y - last.y) < 1e-12) continue;
        pts.push(r.point);
        commit();
      }
    },
  });

  // ------------------------------------------------------------- MLSTYLE
  app.register({
    name: 'MLSTYLE',
    title: '여러 줄 스타일',
    async run(ctx) {
      await new Promise<void>((resolve) => {
        const st = app.active!;
        const doc = st.doc;
        const list = h('select', { size: 9, 'aria-label': '스타일', style: 'width:100%;min-width:180px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:4px' });
        const info = h('pre', { style: 'margin:0;white-space:pre-wrap;font:12px var(--font);color:var(--text-dim)' });
        const preview = h('div', { style: 'margin-top:8px' });
        const curLine = h('div', { style: 'margin-bottom:6px' });
        let entries: MLineStyleEntry[] = [];
        const refresh = (keep?: string) => {
          entries = listMLineStyles(doc);
          const cur = currentMLineStyle(doc);
          curLine.textContent = `현재 여러 줄 스타일: ${(cur?.name ?? 'STANDARD').toUpperCase()}`;
          list.innerHTML = '';
          for (const e of entries) list.append(h('option', { value: e.style.handle }, e.name.toUpperCase() + (mlineStyleUseCount(doc, e) ? ' (사용 중)' : '')));
          list.value = keep && entries.some((e) => e.style.handle === keep) ? keep : (cur?.style.handle ?? entries[0]?.style.handle ?? '');
          show();
        };
        const selected = () => entries.find((e) => e.style.handle === list.value) ?? null;
        const show = () => {
          const s = selected();
          preview.innerHTML = '';
          if (!s) return void (info.textContent = '');
          preview.append(stylePreview(s.style));
          const els = s.style.elements.map((e) => `  ${String(+e.offset.toFixed(4)).padStart(8)}  ${colorText(e.color).padEnd(8)} ${e.linetype}`).join('\n');
          info.textContent = `설명: ${s.style.description || '(없음)'}\n요소 ${s.style.elements.length}개(간격띄우기·색상·선종류):\n${els}\n채우기: ${s.style.flags & ML_FILL ? colorText(s.style.fillColor) : '없음'}  조인 표시: ${s.style.flags & ML_JOINTS ? '예' : '아니요'}`;
        };
        list.addEventListener('change', show);
        const body = h('div', {}, curLine, h('div', { style: 'display:grid;grid-template-columns:200px 1fr;gap:12px' }, list, h('div', {}, info, preview)));
        const act = async (what: 'current' | 'new' | 'modify' | 'rename' | 'delete') => {
          const s = selected();
          const nh = () => st.session.newHandle();
          if (what === 'new') {
            const v = await form(
              '새 여러 줄 스타일 작성',
              [
                { key: 'name', label: '새 스타일 이름', type: 'text', value: '' },
                { key: 'from', label: '시작', type: 'select', value: s?.style.handle ?? '', options: entries.map((e) => ({ value: e.style.handle, label: e.name.toUpperCase() })) },
              ],
              {
                ok: '계속',
                validate: (x) => {
                  const n = String(x.name).trim();
                  if (!n || /[<>/\\":;?*|,=`\s]/.test(n)) return '이름이 올바르지 않습니다(빈칸·특수 문자 없이).';
                  if (entries.some((e) => tableKey(e.name) === tableKey(n))) return '같은 이름의 스타일이 있습니다.';
                  return null;
                },
              },
            );
            if (!v) return;
            const from = entries.find((e) => e.style.handle === v.from)?.style;
            const start = newMLineStyle(String(v.name).trim(), from);
            start.description = '';
            const edited = await mlineStyleEditor(doc, `새 여러 줄 스타일: ${start.name.toUpperCase()}`, start, false);
            if (!edited) return;
            const r = addMLineStyleOps(doc, nh, edited);
            st.session.commit({ label: 'MLSTYLE', ops: r.ops });
            refresh(r.style.handle);
            return;
          }
          if (!s) return;
          const used = mlineStyleUseCount(doc, s) > 0;
          const isStd = tableKey(s.name) === 'STANDARD';
          if (what === 'current') {
            const ops = headerOp(doc, '$CMLSTYLE', s.name);
            if (ops.length) st.session.commit({ label: 'MLSTYLE', ops });
            refresh(s.style.handle);
            return;
          }
          if (what === 'modify') {
            const edited = await mlineStyleEditor(doc, `여러 줄 스타일 수정: ${s.name.toUpperCase()}`, s.style, used || isStd);
            if (!edited) return;
            st.session.commit({ label: 'MLSTYLE', ops: updateMLineStyleOps(doc, s.style, edited, s.name) });
            refresh(s.style.handle);
            return;
          }
          if (what === 'rename') {
            if (isStd) return void ctx.print('STANDARD 스타일은 이름을 바꿀 수 없습니다.', 'err');
            if (used) return void ctx.print('사용 중인 스타일은 이름을 바꿀 수 없습니다.', 'err');
            const v = await form('이름 바꾸기', [{ key: 'name', label: '새 이름', type: 'text', value: s.name }], {
              validate: (x) => {
                const n = String(x.name).trim();
                if (!n || /[<>/\\":;?*|,=`\s]/.test(n)) return '이름이 올바르지 않습니다.';
                if (entries.some((e) => e !== s && tableKey(e.name) === tableKey(n))) return '같은 이름의 스타일이 있습니다.';
                return null;
              },
            });
            if (!v) return;
            const name = String(v.name).trim();
            const ops = updateMLineStyleOps(doc, s.style, { ...s.style, name }, s.name);
            if (currentMLineStyle(doc)?.style.handle === s.style.handle) ops.push(...headerOp(doc, '$CMLSTYLE', name));
            st.session.commit({ label: 'MLSTYLE', ops });
            refresh(s.style.handle);
            return;
          }
          if (what === 'delete') {
            if (isStd) return void ctx.print('STANDARD 스타일은 삭제할 수 없습니다.', 'err');
            if (currentMLineStyle(doc)?.style.handle === s.style.handle) return void ctx.print('현재 스타일은 삭제할 수 없습니다.', 'err');
            if (used) return void ctx.print('사용 중인 스타일은 삭제할 수 없습니다.', 'err');
            st.session.commit({ label: 'MLSTYLE', ops: deleteMLineStyleOps(doc, s.style) });
            refresh();
          }
        };
        const back = dialog('여러 줄 스타일', body, [
          { label: '현재로 설정', run: () => (void act('current'), true) },
          { label: '새로 만들기...', run: () => (void act('new'), true) },
          { label: '수정...', run: () => (void act('modify'), true) },
          { label: '이름 바꾸기', run: () => (void act('rename'), true) },
          { label: '삭제', run: () => (void act('delete'), true) },
          { label: '닫기', primary: true },
        ]);
        const box = back.querySelector('.dialog') as HTMLElement | null;
        if (box) box.style.width = 'min(660px, 100%)';
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

  // ------------------------------------------------------------- MLEDIT / -MLEDIT
  app.register({
    name: 'MLEDIT',
    title: '여러 줄 편집',
    async run(ctx) {
      const tool = await chooseTool();
      if (tool) await runMLEdit(app, ctx, tool);
    },
  });
  app.register({
    name: '-MLEDIT',
    title: '여러 줄 편집(명령행)',
    async run(ctx, arg) {
      let key = arg?.trim().toUpperCase();
      if (!key) {
        const kws = TOOLS.map((t) => ({ key: t.key, label: t.key }));
        const r = await ctx.getPoint('여러 줄 편집 옵션 입력 [CC/OC/MC/CT/OT/MT/CJ/AV/DV/CS/CA/WA]:', { keywords: kws });
        if (!('keyword' in r)) return;
        key = r.keyword;
      }
      const t = TOOLS.find((x) => x.key === key);
      if (!t) {
        ctx.print('옵션이 올바르지 않습니다.', 'err');
        return;
      }
      await runMLEdit(app, ctx, t.key);
    },
  });
}

/** 여러 줄 더블클릭 연결용(리더가 app.ts에서 부를 수 있다) */
export function openMLEdit(app: App): void {
  void app.run('MLEDIT');
}
