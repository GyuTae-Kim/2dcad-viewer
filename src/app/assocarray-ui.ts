/**
 * 특성 팔레트의 "배열(직사각형/원형/경로)" 묶음: 고르면 바로 배열을 다시 계산한다(AutoCAD 특성 팔레트 "기타" 범주의 배열 항목).
 * 팔레트(src/app/ui/palettes.ts)가 블록 참조 하나를 골랐을 때 arrayPaletteGroup을 부른다.
 */
import { formatAngle, formatLength, parseAngle, parseLength } from '../core/units';
import { pathSpacingOf, polarWithAngle, polarWithFill, polarWithItems } from '../edit/assocarray/layout';
import { arrayPath } from '../edit/assocarray/read';
import { type ArrayParams, KIND_LABEL, cloneState } from '../edit/assocarray/types';
import type { App } from './app';
import { applyArrayState, arrayOf } from './assocarray-core';
import { unlockedOnly } from './layers';
import { h } from './ui/dom';

type Kind = 'int' | 'length' | 'angle' | 'bool' | 'method';

interface Row {
  label: string;
  kind: Kind;
  value: number | boolean | string;
  /** 새 값 → 새 매개변수(바꿀 수 없으면 문구) */
  set?: (v: number | boolean | string) => ArrayParams | string;
}

function rowsOf(app: App, p: ArrayParams): Row[] {
  const st = app.active!;
  const common: Row[] = [
    { label: '행', kind: 'int', value: p.rows, set: (v) => ({ ...p, rows: v as number }) },
    { label: '행 간격', kind: 'length', value: p.rowSpacing, set: (v) => ({ ...p, rowSpacing: v as number }) },
    { label: '행 고도 증분', kind: 'length', value: p.rowElevation, set: (v) => ({ ...p, rowElevation: v as number }) },
    { label: '레벨', kind: 'int', value: p.levels, set: (v) => ({ ...p, levels: v as number }) },
    { label: '레벨 간격', kind: 'length', value: p.levelSpacing, set: (v) => ({ ...p, levelSpacing: v as number }) },
  ];
  if (p.kind === 'rect')
    return [
      { label: '열', kind: 'int', value: p.columns, set: (v) => ({ ...p, columns: v as number }) },
      { label: '열 간격', kind: 'length', value: p.columnSpacing, set: (v) => ({ ...p, columnSpacing: v as number }) },
      ...common,
    ];
  if (p.kind === 'polar')
    return [
      { label: '항목', kind: 'int', value: p.items, set: (v) => polarWithItems(p, v as number) },
      { label: '항목 사이 각도', kind: 'angle', value: p.itemAngle, set: (v) => (Math.abs((v as number) * (p.items - 1)) > 2 * Math.PI + 1e-9 || v === 0 ? '채울 각도가 360°를 넘습니다.' : polarWithAngle(p, v as number)) },
      { label: '채울 각도', kind: 'angle', value: p.fillAngle, set: (v) => (v === 0 || Math.abs(v as number) > 2 * Math.PI + 1e-9 ? '채울 각도는 0이 아니고 360°를 넘지 않아야 합니다.' : polarWithFill(p, v as number)) },
      { label: '항목 회전', kind: 'bool', value: p.rotateItems, set: (v) => ({ ...p, rotateItems: !!v }) },
      ...common,
    ];
  const ap = arrayPath(st.doc, p);
  return [
    { label: '방법', kind: 'method', value: p.method, set: (v) => ({ ...p, method: v === 'divide' ? 'divide' : 'measure', spacing: ap ? pathSpacingOf(p, ap.path) : p.spacing }) },
    { label: '항목', kind: 'int', value: p.items, set: (v) => ({ ...p, items: v as number }) },
    ...(p.method === 'measure' ? [{ label: '항목 사이 거리', kind: 'length' as const, value: p.spacing, set: (v: number | boolean | string) => ((v as number) > 0 ? { ...p, spacing: v as number } : '0보다 큰 거리를 입력하십시오.') }] : []),
    { label: '항목 정렬', kind: 'bool', value: p.align, set: (v) => ({ ...p, align: !!v }) },
    { label: 'Z 방향', kind: 'bool', value: p.zDir, set: (v) => ({ ...p, zDir: !!v }) },
    ...common,
  ];
}

/** 블록 참조 하나가 연관 배열이면 특성 팔레트 묶음 */
export function arrayPaletteGroup(app: App, handle: string): HTMLElement | null {
  const st = app.active;
  if (!st) return null;
  const info = arrayOf(st, handle);
  if (!info) return null;
  const p = info.state.params;
  const u = st.units;
  const ro = (k: string, v: string) => h('div', { class: 'prop-row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  const out: HTMLElement[] = [ro('연관', '예'), ro('배열 유형', KIND_LABEL[p.kind])];
  for (const row of rowsOf(app, p)) {
    const id = `pf-arr-${row.label}`;
    const commit = (v: number | boolean | string) => {
      if (!row.set || !unlockedOnly(app, [handle]).length) return false;
      const cur = arrayOf(st, handle);
      if (!cur) return false;
      const np = row.set(v);
      if (typeof np === 'string') {
        app.cmd.print(np, 'err');
        return false;
      }
      return !!applyArrayState(app, null, cur, { ...cloneState(cur.state), params: np }, 'PROPERTIES');
    };
    let ctl: HTMLElement;
    if (row.kind === 'bool' || row.kind === 'method') {
      const opts = row.kind === 'bool' ? [['1', '예'], ['0', '아니오']] : [['divide', '등분할'], ['measure', '길이 분할']];
      const el = h('select', { 'data-field': id, 'aria-label': row.label }, ...opts.map(([v, l]) => h('option', { value: v! }, l!)));
      el.value = row.kind === 'bool' ? (row.value ? '1' : '0') : String(row.value);
      el.addEventListener('change', () => void commit(row.kind === 'bool' ? el.value === '1' : el.value));
      ctl = el;
    } else {
      const el = h('input', { 'data-field': id, 'aria-label': row.label }) as HTMLInputElement;
      const show = row.kind === 'int' ? String(row.value) : row.kind === 'angle' ? formatAngle(row.value as number, u) : formatLength(row.value as number, u);
      el.value = show;
      el.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter') el.blur();
        if ((ev as KeyboardEvent).key === 'Escape') {
          el.value = show;
          el.blur();
        }
      });
      el.addEventListener('change', () => {
        const t = el.value.trim();
        if (t === show) return;
        let v: number | null = null;
        if (row.kind === 'int') {
          const n = Number(t);
          v = Number.isInteger(n) && n >= 1 ? n : null;
        } else if (row.kind === 'angle') v = parseAngle(t, u.aunits);
        else v = parseLength(t);
        if (v === null || !commit(v)) el.value = show;
      });
      ctl = el;
    }
    out.push(h('label', { class: 'prop-row edit' }, h('span', { class: 'k' }, row.label), ctl));
  }
  if (info.state.removed.size) out.push(ro('지운 항목', info.state.removed.size.toLocaleString()));
  if (info.state.replaced.size) out.push(ro('대체한 항목', info.state.replaced.size.toLocaleString()));
  if (info.origin === 'infer') out.push(ro('기록', 'DWG의 AutoCAD 배열(짐작한 값)'));
  return h('div', { class: 'prop-group' }, h('h4', {}, `배열(${KIND_LABEL[p.kind]})`), ...out);
}
