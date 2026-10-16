/**
 * "문자 스타일" 대화상자(STYLE·ST): 스타일 목록(모든·사용 중인 스타일)과 미리보기, 글꼴(글꼴 이름·글꼴 스타일·큰 글꼴),
 * 크기(주석·높이), 효과(거꾸로·반대로·수직·폭 비율·기울기 각도), 현재로 설정·새로 만들기·삭제·적용.
 * 목록의 오른쪽 클릭·F2·두 번 누르기로 이름 바꾸기, Delete로 삭제. 적용하지 않은 변경은 다른 스타일로 옮기거나 닫을 때 묻는다.
 * 항목 이름은 AutoCAD 2026 한국어판의 "문자 스타일" 대화상자를 따른다.
 */
import type { CadDocument, Entity, TextStyle } from '../../core/model';
import { tableKey } from '../../core/model';
import { annotativeFlag, withAnnotativeFlag } from '../../edit/annoscale/xdata';
import type { EditOp } from '../../edit/session';
import { isShxFont } from '../../text/layout';
import type { App } from '../app';
import type { DocState } from '../docstate';
import { ask, dialog, form, h, showMenu } from '../ui/dom';

/** 트루타입 글꼴(파일 → 패밀리) */
export const TTF_FONTS: { file: string; family: string }[] = [
  { file: 'arial.ttf', family: 'Arial' },
  { file: 'times.ttf', family: 'Times New Roman' },
  { file: 'cour.ttf', family: 'Courier New' },
  { file: 'consola.ttf', family: 'Consolas' },
  { file: 'malgun.ttf', family: '맑은 고딕' },
  { file: 'gulim.ttc', family: '굴림' },
  { file: 'gulim.ttc', family: '굴림체' },
  { file: 'batang.ttc', family: '바탕' },
  { file: 'batang.ttc', family: '바탕체' },
  { file: 'gulim.ttc', family: '돋움' },
  { file: 'gulim.ttc', family: '돋움체' },
  { file: 'batang.ttc', family: '궁서' },
  { file: 'batang.ttc', family: '궁서체' },
];
export const SHX_FONTS = ['txt.shx', 'simplex.shx', 'romans.shx', 'romand.shx', 'romanc.shx', 'romant.shx', 'isocp.shx', 'isoct.shx', 'italic.shx', 'gothice.shx', 'monotxt.shx', 'gdt.shx'];
export const BIG_FONTS = ['whgtxt.shx', 'whgdtxt.shx', 'whtgtxt.shx', 'whtmtxt.shx', 'gbcbig.shx', 'bigfont.shx', 'extfont.shx', 'chineset.shx'];

/** 트루타입 굵게·기울임 비트(확장 데이터 1071) */
const BOLD = 0x2000000;
const ITALIC = 0x1000000;

export const isTtfStyle = (s: Pick<TextStyle, 'font' | 'fontFamily'>): boolean => !!s.fontFamily || !isShxFont(s.font || 'txt');

/** 글꼴 스타일: 0 보통, 1 굵게, 2 기울임꼴, 3 굵은 기울임꼴 */
export function fontStyleOf(s: TextStyle): number {
  const f = s.fontFlags ?? 0;
  return (f & BOLD ? 1 : 0) | (f & ITALIC ? 2 : 0);
}

export function withFontStyle(s: TextStyle, v: number): TextStyle {
  const base = (s.fontFlags ?? 34) & ~(BOLD | ITALIC);
  return { ...s, fontFlags: base | (v & 1 ? BOLD : 0) | (v & 2 ? ITALIC : 0) };
}

/** 쓰이는 문자 스타일(문자·속성·치수 스타일·다중 지시선 스타일·현재 스타일) */
export function usedTextStyles(doc: CadDocument): Set<string> {
  const used = new Set<string>(['STANDARD', tableKey(String(doc.header.get('$TEXTSTYLE') ?? 'Standard'))]);
  const visit = (e: Entity) => {
    const a = e as Entity & { style?: string };
    if (typeof a.style === 'string') used.add(tableKey(a.style));
    if (e.type === 'INSERT') for (const at of e.attribs) visit(at as unknown as Entity);
  };
  for (const b of doc.blocks.values()) for (const e of b.entities) visit(e);
  for (const ds of doc.dimStyles.values()) if (typeof ds.vars.DIMTXSTY === 'string') used.add(tableKey(ds.vars.DIMTXSTY));
  const byHandle = new Map([...doc.textStyles.values()].map((t) => [t.handle, tableKey(t.name)]));
  for (const o of doc.objects.values()) {
    const th = (o as { textStyleHandle?: string }).textStyleHandle;
    if (th && byHandle.has(th)) used.add(byHandle.get(th)!);
  }
  return used;
}

/** 이름 바꾸기: 스타일과 그 이름을 쓰는 문자·속성(블록 정의·참조 안 포함)·치수 스타일 DIMTXSTY·머리말 */
export function textStyleRenameOps(st: DocState, from: string, to: string): EditOp[] {
  const doc = st.doc;
  const fk = tableKey(from);
  const s = doc.textStyles.get(fk);
  if (!s) return [];
  const ops: EditOp[] = [
    { kind: 'textStyle', key: fk, before: s, after: null },
    { kind: 'textStyle', key: tableKey(to), before: null, after: { ...s, name: to } },
  ];
  const fix = (e: Entity): Entity | null => {
    let changed = false;
    const c = structuredClone(e) as Entity & { style?: string; mtext?: { style: string } };
    if (typeof c.style === 'string' && tableKey(c.style) === fk) {
      c.style = to;
      changed = true;
    }
    if (c.mtext && tableKey(c.mtext.style) === fk) {
      c.mtext.style = to;
      changed = true;
    }
    if (c.type === 'INSERT')
      for (const a of c.attribs) {
        if (tableKey(a.style) === fk) {
          a.style = to;
          changed = true;
        }
        if (a.mtext && tableKey(a.mtext.style) === fk) {
          a.mtext.style = to;
          changed = true;
        }
      }
    return changed ? c : null;
  };
  for (const [bk, b] of doc.blocks)
    for (const e of b.entities) {
      const c = fix(e);
      if (c) ops.push({ kind: 'modify', block: bk, before: e, after: c });
    }
  for (const [k, ds] of doc.dimStyles) if (typeof ds.vars.DIMTXSTY === 'string' && tableKey(ds.vars.DIMTXSTY) === fk) ops.push({ kind: 'dimStyle', key: k, before: ds, after: { ...ds, vars: { ...ds.vars, DIMTXSTY: to } } });
  for (const hk of ['$TEXTSTYLE', '$DIMTXSTY']) if (tableKey(String(doc.header.get(hk) ?? '')) === fk) ops.push({ kind: 'header', name: hk, before: doc.header.get(hk), after: to });
  return ops;
}

/** 미리보기(AaBb123 가나다)를 이 앱의 글꼴 엔진으로 캔버스에 */
export function drawStylePreview(app: App, canvas: HTMLCanvasElement, s: TextStyle): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const hh = canvas.clientHeight || canvas.height;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(hh * dpr));
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, hh);
  let lay;
  try {
    lay = app.text.layoutText({ text: 'AaBb123 가나다', insert: { x: 0, y: 0 }, height: 1, rotation: 0, widthFactor: s.widthFactor || 1, oblique: s.oblique || 0, generation: s.generation || 0, halign: 0, valign: 0, style: s });
  } catch {
    lay = null;
  }
  c.strokeStyle = '#e8ebf0';
  c.fillStyle = '#e8ebf0';
  if (!lay || !Number.isFinite(lay.minX)) {
    c.font = '13px sans-serif';
    c.fillText('AaBb123 가나다', 8, hh / 2);
    return;
  }
  const bw = Math.max(lay.maxX - lay.minX, 1e-6);
  const bh = Math.max(lay.maxY - lay.minY, 1e-6);
  const k = Math.min((w - 16) / bw, (hh - 16) / bh);
  const ox = (w - bw * k) / 2 - lay.minX * k;
  const oy = (hh + bh * k) / 2 + lay.minY * k;
  const X = (x: number) => ox + x * k;
  const Y = (y: number) => oy - y * k;
  c.lineWidth = 1;
  for (const g of lay.glyphs) {
    const m = g.m;
    const T = (x: number, y: number): [number, number] => [X(m[0] * x + m[2] * y + m[4]), Y(m[1] * x + m[3] * y + m[5])];
    if (g.geom.tris) {
      c.beginPath();
      const t = g.geom.tris;
      for (let i = 0; i + 5 < t.length; i += 6) {
        c.moveTo(...T(t[i]!, t[i + 1]!));
        c.lineTo(...T(t[i + 2]!, t[i + 3]!));
        c.lineTo(...T(t[i + 4]!, t[i + 5]!));
        c.closePath();
      }
      c.fill();
    }
    for (const sline of g.geom.strokes ?? []) {
      c.beginPath();
      for (let i = 0; i + 1 < sline.length; i += 2) {
        const [px, py] = T(sline[i]!, sline[i + 1]!);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
    }
  }
  for (const l of lay.lines) {
    c.beginPath();
    c.moveTo(X(l.x0), Y(l.y0));
    c.lineTo(X(l.x1), Y(l.y1));
    c.stroke();
  }
}

const BAD = /[<>/\\":;?*|,=`]/;
const CSS_IN = 'height:24px;background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;font:inherit;padding:0 4px';

/** 문자 스타일 대화상자 */
export function textStyleDialog(app: App): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const curName = () => doc.textStyles.get(tableKey(String(doc.header.get('$TEXTSTYLE') ?? 'Standard')))?.name ?? 'Standard';
  let picked = curName();
  let filter: 'all' | 'used' = 'all';
  /** 고치는 중인 값(적용 전) */
  let work: TextStyle = structuredClone(doc.textStyles.get(tableKey(picked))!);
  let dirty = false;
  return new Promise((resolve) => {
    const list = h('div', { tabindex: '0', role: 'listbox', 'aria-label': '스타일', style: 'min-height:200px;max-height:40vh;overflow:auto;border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);padding:2px' });
    const filterSel = h('select', { 'aria-label': '스타일 거르기', style: CSS_IN }, h('option', { value: 'all' }, '모든 스타일'), h('option', { value: 'used' }, '사용 중인 스타일')) as HTMLSelectElement;
    const canvas = h('canvas', { width: 220, height: 70, style: 'width:220px;height:70px;background:var(--canvas-model);border:1px solid var(--border-soft);border-radius:4px' }) as HTMLCanvasElement;
    const head = h('div', { style: 'margin-bottom:6px' });
    const fontSel = h('select', { 'aria-label': '글꼴 이름', style: CSS_IN }) as HTMLSelectElement;
    const fstyle = h('select', { 'aria-label': '글꼴 스타일', style: CSS_IN }, ...['보통', '굵게', '기울임꼴', '굵은 기울임꼴'].map((l, i) => h('option', { value: String(i) }, l))) as HTMLSelectElement;
    const useBig = h('input', { type: 'checkbox', 'aria-label': '큰 글꼴 사용' }) as HTMLInputElement;
    const bigSel = h('select', { 'aria-label': '큰 글꼴', style: CSS_IN }, h('option', { value: '' }, '(없음)'), ...BIG_FONTS.map((f) => h('option', { value: f }, f))) as HTMLSelectElement;
    const anno = h('input', { type: 'checkbox', 'aria-label': '주석' }) as HTMLInputElement;
    const heightIn = h('input', { 'aria-label': '높이', style: `${CSS_IN};width:90px`, inputmode: 'decimal' }) as HTMLInputElement;
    const heightLbl = h('span', {}, '높이');
    const upside = h('input', { type: 'checkbox', 'aria-label': '거꾸로' }) as HTMLInputElement;
    const back = h('input', { type: 'checkbox', 'aria-label': '반대로' }) as HTMLInputElement;
    const vert = h('input', { type: 'checkbox', 'aria-label': '수직' }) as HTMLInputElement;
    const widthIn = h('input', { 'aria-label': '폭 비율', style: `${CSS_IN};width:90px`, inputmode: 'decimal' }) as HTMLInputElement;
    const oblIn = h('input', { 'aria-label': '기울기 각도', style: `${CSS_IN};width:90px`, inputmode: 'decimal' }) as HTMLInputElement;
    const err = h('div', { class: 'form-error', role: 'alert' });
    for (const i of [heightIn, widthIn, oblIn]) i.addEventListener('keydown', (ev) => ev.stopPropagation());
    const bigRow = h('label', { class: 'form-row' }, h('span', {}, '큰 글꼴'), bigSel);
    const fontOptions = () => {
      fontSel.replaceChildren();
      const seen = new Set<string>();
      const add = (value: string, label: string) => {
        if (seen.has(value.toUpperCase())) return;
        seen.add(value.toUpperCase());
        fontSel.append(h('option', { value }, label));
      };
      for (const f of TTF_FONTS) add(`ttf:${f.family}`, f.family);
      for (const t of doc.textStyles.values()) if (t.fontFamily) add(`ttf:${t.fontFamily}`, t.fontFamily);
      for (const f of SHX_FONTS) add(`shx:${f}`, f);
      for (const t of doc.textStyles.values()) if (!t.fontFamily && t.font && isShxFont(t.font)) add(`shx:${t.font}`, t.font);
      for (const t of doc.textStyles.values()) if (!t.fontFamily && t.font && !isShxFont(t.font)) add(`ttf:${t.font}`, t.font);
    };
    const fontValue = (s: TextStyle) => (s.fontFamily ? `ttf:${s.fontFamily}` : isShxFont(s.font || 'txt') ? `shx:${s.font || 'txt'}` : `ttf:${s.font}`);
    /** 지금 칸 값으로 work를 고친다 */
    const read = (): boolean => {
      err.textContent = '';
      const fv = fontSel.value;
      if (fv.startsWith('ttf:')) {
        const fam = fv.slice(4);
        const known = TTF_FONTS.find((f) => f.family === fam);
        work.font = known?.file ?? (/\.(ttf|ttc|otf)$/i.test(fam) ? fam : `${fam}.ttf`);
        work.fontFamily = known || !/\.(ttf|ttc|otf)$/i.test(fam) ? fam : undefined;
        work.bigFont = '';
        work = withFontStyle(work, Number(fstyle.value));
        work.flags &= ~4;
      } else {
        work.font = fv.slice(4);
        delete work.fontFamily;
        delete work.fontFlags;
        work.bigFont = useBig.checked ? bigSel.value : '';
        work.flags = vert.checked ? work.flags | 4 : work.flags & ~4;
      }
      const hgt = Number(heightIn.value.trim());
      const wf = Number(widthIn.value.trim());
      const ob = Number(oblIn.value.trim());
      if (!(hgt >= 0)) return ((err.textContent = '높이는 0 이상이어야 합니다.'), false);
      if (!(wf >= 0.01 && wf <= 100)) return ((err.textContent = '폭 비율은 0.01에서 100 사이여야 합니다.'), false);
      if (!(ob >= -85 && ob <= 85)) return ((err.textContent = '기울기 각도는 −85에서 85 사이여야 합니다.'), false);
      work.height = hgt;
      work.widthFactor = wf;
      work.oblique = (ob * Math.PI) / 180;
      work.generation = (upside.checked ? 4 : 0) | (back.checked ? 2 : 0);
      if (anno.checked || annotativeFlag(work.xdata) !== undefined) work.xdata = withAnnotativeFlag(work.xdata, anno.checked);
      return true;
    };
    /** work → 칸 */
    const fill = () => {
      fontOptions();
      const fv = fontValue(work);
      if (![...fontSel.options].some((o) => o.value === fv)) fontSel.append(h('option', { value: fv }, fv.slice(4)));
      fontSel.value = fv;
      const ttf = isTtfStyle(work);
      fstyle.value = String(fontStyleOf(work));
      fstyle.disabled = !ttf;
      useBig.checked = !ttf && !!work.bigFont;
      useBig.disabled = ttf;
      bigSel.value = work.bigFont && BIG_FONTS.includes(work.bigFont.toLowerCase()) ? work.bigFont.toLowerCase() : '';
      if (work.bigFont && !bigSel.value) {
        bigSel.append(h('option', { value: work.bigFont }, work.bigFont));
        bigSel.value = work.bigFont;
      }
      bigRow.hidden = !useBig.checked;
      anno.checked = !!annotativeFlag(work.xdata);
      heightLbl.textContent = anno.checked ? '용지 문자 높이' : '높이';
      heightIn.value = String(+(work.height || 0).toFixed(6));
      upside.checked = !!(work.generation & 4);
      back.checked = !!(work.generation & 2);
      vert.checked = !!(work.flags & 4);
      vert.disabled = ttf;
      widthIn.value = String(+(work.widthFactor || 1).toFixed(6));
      oblIn.value = String(+(((work.oblique || 0) * 180) / Math.PI).toFixed(6));
      drawStylePreview(app, canvas, work);
    };
    const changed = () => {
      if (!read()) return;
      dirty = true;
      bigRow.hidden = !useBig.checked;
      fstyle.disabled = !fontSel.value.startsWith('ttf:');
      useBig.disabled = fontSel.value.startsWith('ttf:');
      vert.disabled = fontSel.value.startsWith('ttf:');
      heightLbl.textContent = anno.checked ? '용지 문자 높이' : '높이';
      drawStylePreview(app, canvas, work);
    };
    for (const el of [fontSel, fstyle, useBig, bigSel, anno, upside, back, vert, heightIn, widthIn, oblIn]) el.addEventListener('change', changed);
    const apply = (): boolean => {
      if (!dirty) return true;
      if (!read()) return false;
      const key = tableKey(work.name);
      const before = doc.textStyles.get(key) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(work)) st.session.commit({ label: 'STYLE', ops: [{ kind: 'textStyle', key, before, after: structuredClone(work) }] });
      dirty = false;
      app.cmd.print(`문자 스타일 "${work.name}"을(를) 적용했습니다.`);
      return true;
    };
    /** 적용하지 않은 변경을 물어 처리한다. 계속하면 true */
    const settle = async (): Promise<boolean> => {
      if (!dirty) return true;
      const a = await ask('문자 스타일', `현재 스타일 "${work.name}"이(가) 수정되었습니다. 변경 사항을 저장하시겠습니까?`, [
        { label: '예', value: 'yes', primary: true },
        { label: '아니오', value: 'no' },
        { label: '취소', value: 'cancel' },
      ]);
      if (a === 'cancel' || a === null) return false;
      if (a === 'yes') return apply();
      dirty = false;
      return true;
    };
    const select = async (name: string) => {
      if (tableKey(name) === tableKey(picked)) return;
      if (!(await settle())) return;
      picked = name;
      work = structuredClone(doc.textStyles.get(tableKey(name))!);
      render();
    };
    const render = () => {
      const cur = curName();
      head.textContent = `현재 문자 스타일: ${cur}`;
      const used = usedTextStyles(doc);
      const styles = [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1) && (filter === 'all' || used.has(tableKey(s.name)))).sort((a, b) => a.name.localeCompare(b.name));
      list.replaceChildren(
        ...styles.map((s) => {
          const sel = tableKey(s.name) === tableKey(picked);
          const r = h('div', { role: 'option', 'aria-selected': sel ? 'true' : 'false', style: `padding:3px 6px;cursor:pointer;border-radius:3px;${sel ? 'background:var(--accent-soft);outline:1px solid var(--accent)' : ''}` }, `${annotativeFlag(s.xdata) ? '▲ ' : ''}${s.name}${tableKey(s.name) === tableKey(cur) ? ' (현재)' : ''}`);
          r.addEventListener('click', () => void select(s.name));
          r.addEventListener('dblclick', () => void rename());
          r.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            void select(s.name).then(() =>
              showMenu(ev.clientX, ev.clientY, [
                { label: '현재로 설정', run: () => void setCurrent() },
                { label: '이름 바꾸기', kbd: 'F2', run: () => void rename() },
                { label: '삭제', kbd: 'Del', run: () => void remove() },
              ]),
            );
          });
          return r;
        }),
      );
      fill();
    };
    const setCurrent = async () => {
      if (!(await settle())) return;
      if (tableKey(String(doc.header.get('$TEXTSTYLE') ?? '')) !== tableKey(picked)) st.session.commit({ label: 'STYLE', ops: [{ kind: 'header', name: '$TEXTSTYLE', before: doc.header.get('$TEXTSTYLE'), after: work.name }] });
      render();
    };
    const create = async () => {
      if (!(await settle())) return;
      let n = 1;
      while (doc.textStyles.has(tableKey(`스타일${n}`))) n++;
      const v = await form('새 문자 스타일', [{ key: 'name', label: '스타일 이름', type: 'text', value: `스타일${n}` }], {
        validate: (x) => {
          const s = String(x.name).trim();
          if (!s || BAD.test(s)) return '스타일 이름이 올바르지 않습니다.';
          return doc.textStyles.has(tableKey(s)) ? '같은 이름의 스타일이 있습니다.' : null;
        },
      });
      if (!v) return;
      const name = String(v.name).trim();
      const src = doc.textStyles.get(tableKey(picked));
      const s: TextStyle = { ...(src ? structuredClone(src) : { flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'txt', bigFont: '' }), name, handle: st.session.newHandle() } as TextStyle;
      st.session.commit({ label: 'STYLE', ops: [{ kind: 'textStyle', key: tableKey(name), before: null, after: s }] });
      picked = name;
      work = structuredClone(s);
      render();
    };
    const rename = async () => {
      const s = doc.textStyles.get(tableKey(picked));
      if (!s) return;
      if (tableKey(s.name) === 'STANDARD') {
        err.textContent = 'Standard 스타일의 이름은 바꿀 수 없습니다.';
        return;
      }
      if (!(await settle())) return;
      const v = await form('이름 바꾸기', [{ key: 'name', label: '새 이름', type: 'text', value: s.name }], {
        validate: (x) => {
          const t = String(x.name).trim();
          if (!t || BAD.test(t)) return '스타일 이름이 올바르지 않습니다.';
          if (tableKey(t) !== tableKey(s.name) && doc.textStyles.has(tableKey(t))) return '같은 이름의 스타일이 있습니다.';
          return null;
        },
      });
      if (!v) return;
      const to = String(v.name).trim();
      if (to === s.name) return;
      st.session.commit({ label: 'RENAME', ops: textStyleRenameOps(st, s.name, to) });
      picked = to;
      work = structuredClone(doc.textStyles.get(tableKey(to))!);
      render();
    };
    const remove = async () => {
      const key = tableKey(picked);
      const s = doc.textStyles.get(key);
      if (!s) return;
      if (key === 'STANDARD' || key === tableKey(curName()) || usedTextStyles(doc).has(key)) {
        err.textContent = `문자 스타일 "${s.name}"은(는) 현재 스타일이거나 사용 중이라 삭제할 수 없습니다.`;
        return;
      }
      const a = await ask('문자 스타일 - 삭제', `문자 스타일 "${s.name}"을(를) 삭제하시겠습니까?`, [
        { label: '예', value: 'yes', primary: true },
        { label: '아니오', value: 'no' },
      ]);
      if (a !== 'yes') return;
      st.session.commit({ label: 'STYLE', ops: [{ kind: 'textStyle', key, before: s, after: null }] });
      dirty = false;
      picked = curName();
      work = structuredClone(doc.textStyles.get(tableKey(picked))!);
      render();
    };
    filterSel.addEventListener('change', () => {
      filter = filterSel.value as 'all' | 'used';
      render();
    });
    list.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      const k = (ev as KeyboardEvent).key;
      if (k === 'F2') void rename();
      else if (k === 'Delete') void remove();
    });
    useBig.addEventListener('change', () => (bigRow.hidden = !useBig.checked));
    const btn = (label: string, run: () => void) => {
      const b = h('button', { class: 'btn', type: 'button', style: 'width:100%;margin-bottom:4px' }, label);
      b.addEventListener('click', run);
      return b;
    };
    const row = (label: HTMLElement | string, el: HTMLElement) => h('label', { class: 'form-row' }, typeof label === 'string' ? h('span', {}, label) : label, el);
    const chk = (label: string, el: HTMLElement) => h('label', { class: 'form-row check' }, h('span', {}, label), el);
    const body = h(
      'div',
      {},
      head,
      h(
        'div',
        { style: 'display:grid;grid-template-columns:minmax(150px,200px) minmax(260px,1fr) 120px;gap:12px;align-items:start' },
        h('div', {}, h('div', { style: 'color:var(--text-dim);margin-bottom:2px' }, '스타일'), list, h('div', { style: 'margin:6px 0' }, filterSel), h('div', { style: 'color:var(--text-dim);margin-bottom:2px' }, '미리보기'), canvas),
        h(
          'div',
          { class: 'form' },
          h('h4', { style: 'margin:0 0 4px' }, '글꼴'),
          row('글꼴 이름', fontSel),
          row('글꼴 스타일', fstyle),
          chk('큰 글꼴 사용', useBig),
          bigRow,
          h('h4', { style: 'margin:8px 0 4px' }, '크기'),
          chk('주석', anno),
          row(heightLbl, heightIn),
          h('h4', { style: 'margin:8px 0 4px' }, '효과'),
          chk('거꾸로', upside),
          chk('반대로', back),
          chk('수직', vert),
          row('폭 비율', widthIn),
          row('기울기 각도', oblIn),
          err,
        ),
        h('div', {}, btn('현재로 설정', () => void setCurrent()), btn('새로 만들기...', () => void create()), btn('삭제', () => void remove())),
      ),
    );
    let closing = false;
    const dlg = dialog('문자 스타일', body, [
      { label: '적용', run: () => (apply(), render(), true) },
      {
        label: '닫기',
        primary: true,
        run: () => {
          if (!dirty) return;
          void settle().then((ok) => {
            if (ok) {
              closing = true;
              dlg.remove();
            }
          });
          return true;
        },
      },
    ]);
    const box = dlg.querySelector('.dialog') as HTMLElement | null;
    if (box) box.style.width = 'min(720px, 100%)';
    render();
    new MutationObserver((_, obs) => {
      if (!dlg.isConnected) {
        obs.disconnect();
        void closing;
        resolve();
      }
    }).observe(document.body, { childList: true });
  });
}
