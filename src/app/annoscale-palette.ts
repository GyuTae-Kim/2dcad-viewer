/**
 * 특성 팔레트의 주석 항목(palettes.ts가 붙인다 — 보고서 참고):
 * - 문자·여러 줄 문자·치수·해치·다중 지시선: `주석`(예/아니오 편집), `주석 축척`(`1:2 (+1)`, 누르면 OBJECTSCALE)
 * - 블록 참조: `주석`(읽기 전용 — 블록 정의가 정한다), `주석 축척`
 * - 선택 없음: `주석 축척` = 지금 보이는 주석 축척(모형 CANNOSCALE·뷰포트, 리스트에서 고른다)
 */
import type { Entity } from '../core/model';
import type { EditOp } from '../edit/session';
import { ScaleIndex, annoKindOf, annoState, blockAnnotative, makeAnnotative, makeNonAnnotative, scaleNames } from '../edit/annoscale';
import type { App } from './app';
import { chooseScale, commitOwn, ensureScaleList, envFor, listedScales, newGroup, scaleForSpace, shownScale } from './annoscale-core';
import { objectScaleDialog } from './annoscale-ui';
import { h } from './ui/dom';

/** 주석을 켤 수 있는 종류(블록 참조·지시선은 아니다) */
const SETTABLE = new Set(['TEXT', 'MTEXT', 'DIMENSION', 'HATCH', 'MULTILEADER']);

/** 고른 객체들의 주석을 켜거나 끈다(한 번의 명령 취소). 바꾼 수 */
export function setAnnotativeFor(app: App, handles: readonly string[], on: boolean): number {
  const st = app.active;
  if (!st) return 0;
  const group = newGroup();
  if (on) ensureScaleList(st, 'PROPERTIES', group);
  const env = envFor(st);
  const ops: EditOp[] = [];
  let n = 0;
  for (const h0 of handles) {
    const e = st.doc.entityIndex.get(h0);
    if (!e || !SETTABLE.has(e.type)) continue;
    const block = st.session.ownerOf(e.handle);
    if (!block) continue;
    const s = on ? scaleForSpace(app, st, block) : undefined;
    if (on && !s) continue;
    const r = on ? makeAnnotative(env, e, s!.name) : makeNonAnnotative(env, e);
    if (r.entity === e && !r.ops.length) continue;
    ops.push(...r.ops);
    if (r.entity !== e) ops.push({ kind: 'modify', block, before: e, after: r.entity });
    n++;
  }
  commitOwn(st, 'PROPERTIES', ops, group);
  return n;
}

function row(label: string, ctl: HTMLElement, title?: string): HTMLElement {
  return h('label', { class: 'prop-row edit', title: title ?? label }, h('span', { class: 'k' }, label), ctl);
}

function readonlyRow(label: string, value: string): HTMLElement {
  return h('div', { class: 'prop-row', title: label }, h('span', { class: 'k' }, label), h('span', { class: 'v', title: value }, value));
}

/** 선택한 객체의 주석 항목 묶음(해당 종류가 없으면 null) */
export function annoPaletteGroup(app: App, sel: readonly Entity[]): HTMLElement | null {
  const st = app.active;
  if (!st) return null;
  const list = sel.filter((e) => annoKindOf(e) && e.type !== 'LEADER');
  if (!list.length) return null;
  const idx = new ScaleIndex(st.doc);
  const states = list.map((e) => ({ e, s: annoState(st.doc, e, idx) }));
  const on = states.filter((x) => x.s && !x.s.foreign).length;
  const rows: HTMLElement[] = [];
  const settable = list.every((e) => SETTABLE.has(e.type)) && !states.some((x) => x.s?.foreign);
  const insertOnly = list.every((e) => e.type === 'INSERT');
  if (settable) {
    const varies = on > 0 && on < list.length;
    const el = h('select', { 'data-field': 'pf-주석', 'aria-label': '주석' }, ...(varies ? [h('option', { value: '' }, '*여러 개*')] : []), h('option', { value: '1' }, '예'), h('option', { value: '0' }, '아니오')) as HTMLSelectElement;
    el.value = varies ? '' : on ? '1' : '0';
    el.addEventListener('change', () => {
      if (el.value === '') return;
      setAnnotativeFor(
        app,
        list.map((e) => e.handle),
        el.value === '1',
      );
    });
    rows.push(row('주석', el, '주석 객체는 주석 축척마다 크기(용지 크기 × 축척)가 다른 표현을 가집니다'));
  } else {
    const flag = insertOnly ? list.every((e) => e.type === 'INSERT' && blockAnnotative(st.doc, e.block)) : on === list.length;
    rows.push(readonlyRow('주석', on === list.length || (insertOnly && flag) ? '예' : on ? '*여러 개*' : '아니오'));
  }
  if (on === list.length) {
    const names = states.map((x) => scaleNames({ doc: st.doc, idx }, x.e));
    const first = names[0];
    let text = '*여러 개*';
    if (first && names.every((n) => n && n.current === first.current)) text = list.length === 1 ? `${first.current}${first.scales.length > 1 ? ` (+${first.scales.length - 1})` : ''}` : first.current;
    const btn = h('button', { class: 'prop-color', type: 'button', 'aria-label': '주석 축척', title: '축척 추가/삭제... (OBJECTSCALE)' }, `${text} …`) as HTMLButtonElement;
    btn.addEventListener('click', () => void objectScaleDialog(app, st, list.map((e) => e.handle)));
    rows.push(row('주석 축척', btn));
  }
  return h('div', { class: 'prop-group' }, h('h4', {}, '주석'), ...rows);
}

/** 선택이 없을 때: 지금 보이는 주석 축척(고르면 바꾼다) */
export function annoCurrentRow(app: App): HTMLElement | null {
  const sh = shownScale(app);
  if (sh.where === 'none') return null;
  if (sh.where === 'paper') return readonlyRow('주석 축척', '1:1');
  const el = h('select', { 'data-field': 'pf-주석 축척', 'aria-label': '주석 축척', disabled: !!sh.locked }, ...listedScales(sh.list).map((s) => h('option', { value: s.name }, s.name))) as HTMLSelectElement;
  el.value = sh.scale?.name ?? '';
  el.addEventListener('change', () => {
    if (el.value) chooseScale(app, el.value);
  });
  return row('주석 축척', el, sh.where === 'viewport' ? '뷰포트 주석 축척' : '현재 주석 축척(CANNOSCALE)');
}
