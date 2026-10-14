/**
 * 도면층 탐색(LAYWALK): 목록에서 고른 도면층만 화면에 잠시 보인다(여러 개 고르기, 와일드카드 필터, 선택 유지, 검사, 소거).
 * 화면 상태만 바꾸고 도면의 도면층 표는 그대로 둔다. 닫으면 원래대로(종료 시 복원). 종료 시 복원을 끄고 닫으면
 * 그때 보이던 도면층만 켜진 상태를 도면층 표에 남긴다(명령 취소로 되돌릴 수 있다).
 */
import type { Layer } from '../core/model';
import { tableKey } from '../core/model';
import { aciToRgb, rgbToCss } from '../core/color';
import { filterLayerNames, layerObjectCounts, purgeLayersOps, unreferencedLayers, walkKeepPatches, walkVisibleKeys } from '../edit/layertools/walk';
import type { App } from './app';
import { currentLayer, patchLayers } from './layers';
import { type ListItem, PickList, TempLayerView, guardKeys, wideDialog } from './layertools-ui';
import { ask, h, showMenu } from './ui/dom';

/** 도면층 견본 색 */
export function layerSwatch(l: Layer): string {
  return rgbToCss(l.color.rgb !== undefined ? l.color.rgb : aciToRgb(Math.abs(l.color.aci) || 7, true));
}

export function registerLayWalkCommands(app: App): void {
  app.register({
    name: 'LAYWALK',
    title: '도면층 탐색',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const view = new TempLayerView(app, st);
      const held = new Set<string>();
      let filter = '';
      const list = new PickList('도면층');
      const status = h('div', { class: 'ltx-note' });
      // 도면층 표 + 화면에만 있는 외부 참조 도면층(참조|도면층)
      const names = () => {
        const out = [...doc.layers.values()].map((l) => l.name);
        for (const [k, l] of st.layers) if (!doc.layers.has(k)) out.push(l.name);
        return out.sort((a, b) => a.localeCompare(b, 'ko'));
      };
      const refresh = (keepSel = true) => {
        const counts = layerObjectCounts(doc);
        const shown = filterLayerNames(names(), filter);
        const items: ListItem[] = shown.map((n) => {
          const k = tableKey(n);
          const l = doc.layers.get(k);
          const ls = st.layers.get(k);
          const c = counts.get(k) ?? 0;
          const swatch = l ? layerSwatch(l) : rgbToCss(ls?.hasRgb ? ls.rgb : aciToRgb(Math.abs(ls?.aci ?? 7) || 7, true));
          return { key: k, label: `${held.has(k) ? '*' : ''}${n}`, swatch, dim: !!l && c === 0, tag: c ? String(c) : '', title: !l ? `${n} — 외부 참조` : c ? `${n} — 객체 ${c}개` : `${n} — 참조되지 않음` };
        });
        const sel = keepSel ? list.selection() : [];
        list.setItems(items);
        if (keepSel) list.setSelection(sel, false);
      };
      const apply = () => {
        const vis = walkVisibleKeys(list.selection(), held);
        view.show(vis);
        status.textContent = `도면층 ${list.keys.length}개 중 ${list.keys.filter((k) => vis.has(k)).length}개 표시${held.size ? ` · 선택 유지 ${held.size}개` : ''}`;
      };
      list.onChange = apply;
      refresh(false);
      // 처음: 지금 켜져 있고 동결되지 않은 도면층을 고른 상태(화면이 바뀌지 않게)
      list.setSelection(
        [...st.layers].filter(([, l]) => l.on && !l.frozen).map(([k]) => k),
        false,
      );
      apply();

      const filterInput = h('input', { class: 'ltx-input ltx-grow', type: 'text', placeholder: '* (예: A-*,~*TEXT*)', 'aria-label': '필터' }) as HTMLInputElement;
      guardKeys(filterInput);
      filterInput.addEventListener('input', () => {
        filter = filterInput.value;
        refresh();
        // 필터에 맞는 도면층만 보이게(AutoCAD처럼 필터를 바꾸면 맞는 도면층이 모두 선택된다)
        list.setSelection(list.keys);
      });
      const restore = h('input', { type: 'checkbox', checked: true, 'aria-label': '종료 시 복원' }) as HTMLInputElement;
      const pickBtn = h('button', { class: 'ltx-btn', type: 'button', title: '도면에서 객체를 골라 그 도면층을 고릅니다' }, '객체 선택(S)');
      const purgeBtn = h('button', { class: 'ltx-btn', type: 'button', title: '고른 도면층 가운데 참조되지 않은 도면층을 지웁니다' }, '소거(P)');
      const body = h(
        'div',
        { class: 'ltx-col' },
        h('div', { class: 'ltx-row' }, h('span', {}, '필터'), filterInput),
        list.el,
        status,
        h('div', { class: 'ltx-row' }, pickBtn, purgeBtn, h('span', { class: 'ltx-grow' }), h('label', { class: 'ltx-check' }, restore, '종료 시 복원(R)')),
        h('div', { class: 'ltx-note' }, '클릭하면 그 도면층만 보입니다. Ctrl·Shift로 여러 개, 오른쪽 클릭으로 선택 유지·참조되지 않은 항목 선택·검사. 도면은 이 창을 연 채 확대·초점이동할 수 있습니다.'),
      );
      list.el.style.maxHeight = '340px';
      list.el.style.minHeight = '220px';
      const dlg = wideDialog(`도면층 탐색 - 도면층 수: ${doc.layers.size}`, body, [{ label: '닫기', value: 'close', primary: true }], 380, true);

      const inspect = () => {
        const counts = layerObjectCounts(doc);
        const sel = list.selection();
        const n = sel.reduce((s, k) => s + (counts.get(k) ?? 0), 0);
        void ask('검사', `선택한 도면층 ${sel.length}개, 객체 ${n}개(블록 정의 안·속성 포함). 도면의 도면층은 모두 ${doc.layers.size}개입니다.`, [{ label: '확인', value: 'ok', primary: true }]);
      };
      list.onContext = (ev) =>
        showMenu(ev.clientX, ev.clientY, [
          {
            label: '선택 유지(H)',
            run: () => {
              for (const k of list.selection()) held.add(k);
              refresh();
              apply();
            },
          },
          {
            label: '해제(R)',
            run: () => {
              for (const k of list.selection()) held.delete(k);
              refresh();
              apply();
            },
          },
          {
            label: '모두 해제(A)',
            disabled: !held.size,
            run: () => {
              held.clear();
              refresh();
              apply();
            },
          },
          { separator: true },
          { label: '모두 선택(S)', run: () => list.setSelection(list.keys) },
          { label: '모두 지우기(C)', run: () => list.setSelection([]) },
          { label: '선택 반전(I)', run: () => list.setSelection(list.keys.filter((k) => !list.selected.has(k))) },
          { label: '참조되지 않은 항목 선택(U)', run: () => list.setSelection(unreferencedLayers(doc, currentLayer(app)).map(tableKey)) },
          { separator: true },
          { label: '검사(N)...', run: inspect },
        ]);

      pickBtn.addEventListener('click', async () => {
        dlg.back.style.display = 'none';
        try {
          const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
          const keys = new Set<string>();
          for (const x of hs) {
            const e = doc.entityIndex.get(x);
            if (e) keys.add(tableKey(e.layer));
          }
          app.clearSelection();
          if (keys.size) list.setSelection(keys);
        } catch {
          /* 취소 */
        } finally {
          dlg.back.style.display = '';
        }
      });
      purgeBtn.addEventListener('click', async () => {
        const sel = list.selection().map((k) => doc.layers.get(k)?.name ?? k);
        if (!sel.length) return;
        const r = purgeLayersOps(doc, sel, currentLayer(app));
        if (!r.ops.length) {
          ctx.print(`소거할 수 있는 도면층이 없습니다.${r.refused[0] ? ` ${r.refused[0].name}: ${r.refused[0].reason}` : ''}`, 'err');
          return;
        }
        const ok = await ask('도면층 소거', `참조되지 않은 도면층 ${r.purged.length}개(${r.purged.join(', ')})를 지우시겠습니까?${r.refused.length ? ` 객체가 있거나 지울 수 없는 ${r.refused.length}개는 건너뜁니다.` : ''}`, [
          { label: '취소', value: 'no' },
          { label: '소거', value: 'yes', primary: true },
        ]);
        if (ok !== 'yes') return;
        view.restore();
        st.session.commit({ label: 'LAYWALK', ops: r.ops, group: ctx.group });
        ctx.print(`도면층 ${r.purged.length}개를 소거했습니다.`);
        for (const k of r.purged) held.delete(tableKey(k));
        dlg.box.querySelector('header')!.firstChild!.textContent = `도면층 탐색 - 도면층 수: ${doc.layers.size}`;
        refresh();
        apply();
      });

      try {
        await dlg.closed;
      } finally {
        const vis = walkVisibleKeys(list.selection(), held);
        view.restore();
        dlg.close();
        if (!restore.checked && app.active === st) {
          const n = patchLayers(app, 'LAYWALK', walkKeepPatches(doc, vis));
          if (n) ctx.print(`도면층 ${n}개의 켜기·끄기를 바꿨습니다(종료 시 복원 꺼짐).`);
        }
      }
    },
  });
}
