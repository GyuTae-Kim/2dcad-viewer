/**
 * 주석 축척 대화상자: SCALELISTEDIT "도면 축척 편집"(축척 추가·편집), OBJECTSCALE "주석 객체 축척"("객체에 축척 추가").
 * 확인을 누를 때 한 번의 편집(명령 취소 한 단계). 스타일 접두사 as-.
 */
import type { Entity } from '../core/model';
import { MODEL_SPACE } from '../core/model';
import type { EditOp } from '../edit/session';
import {
  type AnnoScale,
  ScaleIndex,
  addScales,
  annoState,
  defaultScales,
  dictVarOps,
  fmtNum,
  isMetric,
  isUsed,
  listProblem,
  nameProblem,
  ownRecord,
  ratioText,
  readScaleList,
  removeScales,
  sameRatio,
  scaleListOps,
  switchScale,
  upper,
  usedScales,
  withOwnRecord,
} from '../edit/annoscale';
import type { App } from './app';
import type { DocState } from './docstate';
import { commitOwn, currentScaleName, ensureScaleList, envFor, isXrefScale, newGroup } from './annoscale-core';
import { ask, form, h } from './ui/dom';
import { button, ensureStyles, modal } from './util2-ui';

const CSS = `
.as-wrap { display: grid; grid-template-columns: 1fr 150px; gap: 10px; }
.as-list { border: 1px solid var(--border-soft); border-radius: 3px; background: var(--bg-input); overflow: auto; height: 260px; outline: 0; }
.as-list:focus { border-color: var(--accent); }
.as-item { padding: 2px 8px; cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); font-size: 12px; }
.as-item:hover { background: var(--bg-hover); }
.as-item.sel { background: var(--bg-active); color: #fff; }
.as-item.dim { color: var(--text-faint); }
.as-btns { display: flex; flex-direction: column; gap: 6px; }
.as-btns .btn { justify-content: flex-start; }
.as-ratio { margin-top: 6px; font-size: 12px; color: var(--text-dim); min-height: 16px; }
.as-why { font-size: 12px; color: var(--text-dim); min-height: 16px; }
.as-radio { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; font-size: 12px; }
.as-radio label { display: inline-flex; gap: 6px; align-items: center; }
`;

function styles(): void {
  ensureStyles();
  if (typeof document === 'undefined' || document.getElementById('as-style')) return;
  const s = document.createElement('style');
  s.id = 'as-style';
  s.textContent = CSS;
  document.head.append(s);
}

/** 여러 개(multi) 또는 하나를 고르는 목록 */
function pickList(multi: boolean, onChange: () => void, onActivate?: (i: number) => void): { el: HTMLDivElement; set(items: { label: string; dim?: boolean }[], sel?: number[]): void; selected(): number[]; move(d: number): void } {
  const el = h('div', { class: 'as-list', tabindex: 0, role: 'listbox' });
  let items: { label: string; dim?: boolean }[] = [];
  let sel = new Set<number>();
  let anchor = -1;
  const render = () => {
    el.innerHTML = '';
    items.forEach((it, i) => {
      const d = h('div', { class: `as-item${sel.has(i) ? ' sel' : ''}${it.dim ? ' dim' : ''}`, role: 'option', 'aria-selected': sel.has(i) ? 'true' : 'false', title: it.label }, it.label);
      d.addEventListener('click', (ev) => {
        if (multi && (ev.ctrlKey || ev.metaKey)) {
          if (sel.has(i)) sel.delete(i);
          else sel.add(i);
        } else if (multi && ev.shiftKey && anchor >= 0) {
          sel = new Set();
          for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k);
        } else sel = new Set([i]);
        anchor = i;
        render();
        onChange();
      });
      if (onActivate) d.addEventListener('dblclick', () => onActivate(i));
      el.append(d);
    });
  };
  const api = {
    el,
    set(next: { label: string; dim?: boolean }[], s?: number[]) {
      items = next;
      sel = new Set((s ?? [...sel]).filter((i) => i >= 0 && i < items.length));
      render();
    },
    selected: () => [...sel].sort((a, b) => a - b),
    move(d: number) {
      const cur = api.selected();
      const i = Math.max(0, Math.min(items.length - 1, (cur.length ? (d < 0 ? cur[0]! : cur[cur.length - 1]!) : -1) + d));
      sel = new Set([i]);
      anchor = i;
      render();
      (el.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
      onChange();
    },
  };
  return api;
}

/** 축척 추가·편집 상자. 취소면 null */
async function scaleForm(title: string, init: { name: string; paper: number; drawing: number }, others: readonly AnnoScale[]): Promise<{ name: string; paper: number; drawing: number } | null> {
  const r = await form(
    title,
    [
      { key: 'name', label: '축척 리스트에 나타나는 이름(N)', type: 'text', value: init.name },
      { key: 'paper', label: '용지 단위(P)', type: 'number', value: fmtNum(init.paper) },
      { key: 'drawing', label: '도면 단위(W)', type: 'number', value: fmtNum(init.drawing) },
    ],
    {
      note: '축척 특성: 용지 단위 1이 도면 단위 몇과 같은지 입력합니다.',
      validate: (v) => {
        const n = String(v.name).trim();
        const p = nameProblem(n);
        if (p) return p;
        if (others.some((s) => s.name.toUpperCase() === n.toUpperCase())) return `축척 이름 ${n}이(가) 이미 있습니다.`;
        const a = Number(v.paper);
        const b = Number(v.drawing);
        if (!(a > 0) || !(b > 0) || a > 1e9 || b > 1e9) return '단위는 0보다 크고 1e9 이하인 수여야 합니다.';
        return null;
      },
    },
  );
  if (!r) return null;
  return { name: String(r.name).trim(), paper: Number(r.paper), drawing: Number(r.drawing) };
}

/** 재설정한 리스트: 기본 리스트 + 쓰이는 축척·현재 축척(기본에 없으면 끝에). 이름과 비율이 같은 기본 축척은 기존 객체를 쓴다 */
export function resetList(st: DocState, work: readonly AnnoScale[], current: AnnoScale | undefined): AnnoScale[] {
  const used = usedScales(st.doc);
  const defs = defaultScales(isMetric(st.doc));
  const out: AnnoScale[] = defs.map((d) => {
    const same = work.find((w) => w.name.toUpperCase() === d.name.toUpperCase() && sameRatio(w, d));
    return same ? { ...d, handle: same.handle } : d;
  });
  for (const w of work) {
    if (out.some((o) => o.name.toUpperCase() === w.name.toUpperCase())) continue;
    if (w === current || isUsed(used, w) || isXrefScale(w)) out.push(w);
  }
  return out;
}

/** SCALELISTEDIT "도면 축척 편집" */
export async function scaleListDialog(app: App, st: DocState, group = newGroup()): Promise<void> {
  styles();
  const doc = st.doc;
  const orig = readScaleList(doc);
  let work: AnnoScale[] = (orig.length ? orig : defaultScales(isMetric(doc))).map((s) => ({ ...s }));
  const curName = currentScaleName(st).toUpperCase();
  let current: AnnoScale | undefined = work.find((s) => s.name.toUpperCase() === curName);
  const used = usedScales(doc);
  const ratio = h('div', { class: 'as-ratio' });
  const why = h('div', { class: 'as-why' });
  const list = pickList(false, () => refresh(), (i) => void edit(i));
  const label = (s: AnnoScale) => `${s === current ? '▶ ' : ' '}${s.name}`;
  const btnAdd = button('추가(A)...', () => void add());
  const btnEdit = button('편집(E)...', () => void edit(list.selected()[0] ?? -1));
  const btnUp = button('위로 이동(U)', () => move(-1));
  const btnDown = button('아래로 이동(O)', () => move(1));
  const btnDel = button('삭제(D)', () => del());
  const btnReset = button('재설정(R)', () => void reset());
  const deleteBlock = (s: AnnoScale): string | null => {
    if (work.length <= 1) return '축척 리스트에는 축척이 하나 이상 있어야 합니다.';
    if (s === current) return `${s.name}은(는) 현재 주석 축척이므로 삭제할 수 없습니다.`;
    if (s.handle && isUsed(used, s)) return `${s.name}은(는) 주석 객체나 뷰포트가 쓰고 있어 삭제할 수 없습니다.`;
    if (!s.handle && used.names.has(s.name.toUpperCase())) return `${s.name}은(는) 주석 객체가 쓰고 있어 삭제할 수 없습니다.`;
    return null;
  };
  const refresh = (sel?: number) => {
    list.set(
      work.map((s) => ({ label: label(s) })),
      sel !== undefined ? [sel] : undefined,
    );
    const i = list.selected()[0];
    const s = i !== undefined ? work[i] : undefined;
    ratio.textContent = s ? ratioText(s) : '';
    const block = s ? deleteBlock(s) : null;
    why.textContent = block ?? '';
    btnEdit.disabled = !s;
    btnUp.disabled = !s || i === 0;
    btnDown.disabled = !s || i === work.length - 1;
    btnDel.disabled = !s || !!block;
  };
  const add = async () => {
    const r = await scaleForm('축척 추가', { name: '', paper: 1, drawing: 1 }, work);
    if (!r) return;
    const at = (list.selected()[0] ?? work.length - 1) + 1;
    work.splice(at, 0, { name: r.name, paper: r.paper, drawing: r.drawing, unit: false });
    refresh(at);
  };
  const edit = async (i: number) => {
    const s = work[i];
    if (!s) return;
    const r = await scaleForm(
      '축척 편집',
      s,
      work.filter((w) => w !== s),
    );
    if (!r) return;
    const next = { ...s, name: r.name, paper: r.paper, drawing: r.drawing };
    if (current === s) current = next;
    work[i] = next;
    refresh(i);
  };
  const move = (d: number) => {
    const i = list.selected()[0];
    if (i === undefined) return;
    const j = i + d;
    if (j < 0 || j >= work.length) return;
    [work[i], work[j]] = [work[j]!, work[i]!];
    refresh(j);
  };
  const del = () => {
    const i = list.selected()[0];
    const s = i !== undefined ? work[i] : undefined;
    if (!s || deleteBlock(s)) return;
    work.splice(i!, 1);
    refresh(Math.min(i!, work.length - 1));
  };
  const reset = async () => {
    const a = await ask('도면 축척 편집', '축척 리스트를 기본값으로 재설정하시겠습니까? 사용 중인 축척과 현재 축척은 남습니다.', [
      { label: '예', value: 'y', primary: true },
      { label: '아니오', value: 'n' },
    ]);
    if (a !== 'y') return;
    work = resetList(st, work, current);
    current = work.find((s) => s.name.toUpperCase() === (current?.name ?? curName).toUpperCase()) ?? current;
    refresh(0);
  };
  list.el.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'ArrowUp') (ev.preventDefault(), list.move(-1));
    else if (ev.key === 'ArrowDown') (ev.preventDefault(), list.move(1));
    else if (ev.key === 'Delete') del();
    else if (ev.key === 'Enter') void edit(list.selected()[0] ?? -1);
  });
  const body = h(
    'div',
    {},
    h('div', { class: 'as-wrap' }, h('div', {}, h('div', { class: 'u2-note' }, '축척 리스트'), list.el, ratio, why), h('div', { class: 'as-btns' }, h('div', { class: 'u2-note' }, ' '), btnAdd, btnEdit, btnUp, btnDown, btnDel, btnReset)),
  );
  const m = modal<'ok' | 'cancel'>('도면 축척 편집', body, [
    { label: '취소', value: 'cancel' },
    { label: '확인', primary: true, value: 'ok' },
  ], 'mid');
  const i0 = current ? work.indexOf(current) : 0;
  refresh(Math.max(0, i0));
  list.el.focus();
  const res = await m.done;
  if (res !== 'ok') return;
  applyScaleList(app, st, work, current, group);
}

/** 리스트를 도면에 쓴다(바뀐 것이 없으면 편집 없음). 이름을 바꾼 현재 축척은 계속 현재 */
export function applyScaleList(app: App, st: DocState, work: readonly AnnoScale[], current: AnnoScale | undefined, group: number, label = 'SCALELISTEDIT'): boolean {
  const p = listProblem(work);
  if (p) {
    app.cmd.print(p, 'err');
    return false;
  }
  const used = usedScales(st.doc);
  const usedH = new Set(used.handles);
  const r = scaleListOps(st.doc, work, () => st.session.newHandle(), usedH);
  const ops: EditOp[] = [...r.ops];
  const curName = currentScaleName(st);
  if (current && current.name.toUpperCase() !== curName.toUpperCase()) dictVarOps(st.doc, 'CANNOSCALE', current.name, () => st.session.newHandle(), ops);
  // 자체 기록은 축척을 이름으로 가리키므로 이름을 바꾼 축척을 따라 고친다
  if (r.renamed.size) {
    const map = new Map([...r.renamed].map(([a, b]) => [a.toUpperCase(), b]));
    for (const e of st.doc.entityIndex.values()) {
      const own = ownRecord(e.xdata);
      if (!own || !own.scales.some((n) => map.has(n.toUpperCase()))) continue;
      const ren = (n: string) => map.get(n.toUpperCase()) ?? n;
      const block = st.session.ownerOf(e.handle);
      if (!block) continue;
      ops.push({ kind: 'modify', block, before: e, after: { ...e, xdata: withOwnRecord(e.xdata, { current: ren(own.current), scales: own.scales.map(ren) }) } });
    }
  }
  for (const k of r.kept) app.cmd.print(`축척 ${k}은(는) 쓰이고 있어 리스트 끝에 남겼습니다.`);
  if (!ops.length) return false;
  commitOwn(st, label, ops, group);
  return true;
}

// ---------------------------------------------------------------------------
// OBJECTSCALE "주석 객체 축척"
// ---------------------------------------------------------------------------

/** "객체에 축척 추가": 도면 축척 리스트에서 여러 개 */
async function addScalesDialog(choices: readonly AnnoScale[]): Promise<AnnoScale[] | null> {
  styles();
  const ratio = h('div', { class: 'as-ratio' });
  const list = pickList(true, () => {
    const i = list.selected()[0];
    ratio.textContent = i !== undefined ? ratioText(choices[i]!) : '';
  });
  list.set(choices.map((s) => ({ label: s.name })));
  const m = modal<'ok' | 'cancel'>('객체에 축척 추가', h('div', {}, h('div', { class: 'u2-note' }, '추가할 축척(Ctrl·Shift로 여러 개)'), list.el, ratio), [
    { label: '취소', value: 'cancel' },
    { label: '확인', primary: true, value: 'ok' },
  ]);
  list.el.focus();
  const r = await m.done;
  if (r !== 'ok') return null;
  return list.selected().map((i) => choices[i]!);
}

/** OBJECTSCALE 대화상자. handles는 주석 객체(지금 공간의 최상위 객체) */
export async function objectScaleDialog(app: App, st: DocState, handles: string[], group = newGroup()): Promise<void> {
  styles();
  const doc = st.doc;
  const idx = new ScaleIndex(doc);
  const objs: { e: Entity; scales: string[] }[] = [];
  for (const h0 of handles) {
    const e = doc.entityIndex.get(h0);
    if (!e) continue;
    const s = annoState(doc, e, idx);
    if (!s || s.foreign) continue;
    objs.push({ e, scales: s.scales });
  }
  if (!objs.length) {
    app.cmd.print('고른 객체 가운데 주석 객체가 없습니다.', 'err');
    return;
  }
  const adds = new Set<string>();
  const removes = new Set<string>();
  let mode: 'L' | 'C' = 'L';
  const nameOf = (k: string) => idx.name(k)?.name ?? k;
  const shown = (): string[] => {
    const sets = objs.map((o) => new Set(o.scales));
    const base = mode === 'L' ? [...new Set(objs.flatMap((o) => o.scales))] : objs[0]!.scales.filter((k) => sets.every((s) => s.has(k)));
    const out = base.filter((k) => !removes.has(k));
    for (const a of adds) if (!out.includes(a)) out.push(a);
    // 리스트 순서
    const order = new Map(idx.list.map((s, i) => [s.name.toUpperCase(), i]));
    return out.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  };
  const ratio = h('div', { class: 'as-ratio' });
  const list = pickList(true, () => refresh(false));
  const btnAdd = button('추가(A)...', () => void addMore());
  const btnDel = button('삭제(D)', () => del());
  let names: string[] = [];
  const refresh = (rebuild = true) => {
    if (rebuild) {
      names = shown();
      list.set(names.map((k) => ({ label: nameOf(k) })));
    }
    const sel = list.selected();
    const s = sel.length ? idx.name(names[sel[0]!]!) : undefined;
    ratio.textContent = s ? ratioText(s) : '';
    btnDel.disabled = !sel.length || names.length - sel.length < 1;
  };
  const addMore = async () => {
    const have = new Set(names);
    const pick = await addScalesDialog(idx.list.filter((s) => !have.has(s.name.toUpperCase())));
    if (!pick) return;
    for (const s of pick) {
      adds.add(s.name.toUpperCase());
      removes.delete(s.name.toUpperCase());
    }
    refresh();
  };
  const del = () => {
    for (const i of list.selected()) {
      const k = names[i]!;
      if (adds.has(k)) adds.delete(k);
      else removes.add(k);
    }
    list.set([], []);
    refresh();
  };
  const radio = (k: 'L' | 'C', text: string) => {
    const r = h('input', { type: 'radio', name: 'as-mode', checked: mode === k }) as HTMLInputElement;
    r.addEventListener('change', () => {
      if (r.checked) {
        mode = k;
        refresh();
      }
    });
    return h('label', {}, r, text);
  };
  const body = h(
    'div',
    {},
    h('div', { class: 'u2-note' }, `선택한 주석 객체 ${objs.length}개`),
    h('div', { class: 'as-wrap' }, h('div', {}, h('div', { class: 'u2-note' }, '객체 축척 리스트(O)'), list.el, ratio), h('div', { class: 'as-btns' }, h('div', { class: 'u2-note' }, ' '), btnAdd, btnDel)),
    h('div', { class: 'as-radio' }, radio('L', '선택된 모든 객체의 모든 축척 나열(L)'), radio('C', '선택된 모든 객체에 공통인 축척만 나열(C)')),
  );
  const m = modal<'ok' | 'cancel'>('주석 객체 축척', body, [
    { label: '취소', value: 'cancel' },
    { label: '확인', primary: true, value: 'ok' },
  ], 'mid');
  refresh();
  list.el.focus();
  const r = await m.done;
  if (r !== 'ok' || (!adds.size && !removes.size)) return;
  const n = applyObjectScales(st, objs.map((o) => o.e), [...adds].map(nameOf), [...removes].map(nameOf), group);
  if (n.single) app.cmd.print(`${n.single}개의 객체는 축척이 하나뿐이어서 삭제하지 않았습니다.`);
}

/** 여러 객체에 축척을 더하고 지운다(더하기·지우기 두 변경을 한 명령 취소 단계로) */
export function applyObjectScales(st: DocState, list: readonly Entity[], add: readonly string[], remove: readonly string[], group: number, label = 'OBJECTSCALE'): { changed: number; single: number } {
  const changedH = new Set<string>();
  let single = 0;
  ensureScaleList(st, label, group);
  const pass = (f: (env: ReturnType<typeof envFor>, e: Entity) => { entity: Entity; ops: EditOp[]; kept?: boolean }) => {
    const env = envFor(st);
    const ops: EditOp[] = [];
    for (const e0 of list) {
      const e = st.doc.entityIndex.get(e0.handle) ?? e0;
      const r = f(env, e);
      if (r.kept) single++;
      if (!r.ops.length && r.entity === e) continue;
      ops.push(...r.ops);
      if (r.entity !== e) ops.push({ kind: 'modify', block: st.session.ownerOf(e.handle) ?? MODEL_SPACE.toUpperCase(), before: e, after: r.entity });
      changedH.add(e.handle);
    }
    commitOwn(st, label, ops, group);
  };
  if (add.length) pass((env, e) => addScales(env, e, add));
  if (remove.length) pass((env, e) => removeScales(env, e, remove));
  // 모형 공간 객체가 이제 CANNOSCALE을 가지면 그 표현을 보인다(그립·스냅이 화면과 맞게)
  const cur = currentScaleName(st);
  pass((env, e) => (st.session.ownerOf(e.handle) === MODEL_SPACE.toUpperCase() ? switchScale(env, e, cur) : { entity: e, ops: [] }));
  return { changed: changedH.size, single };
}

export { upper };
