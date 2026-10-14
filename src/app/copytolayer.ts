/**
 * COPYTOLAYER(도면층에 복사): 고른 객체의 복사본을 대상 도면층에 만들고, 원하면 바로 옮긴다.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 복사와 이동은 명령 취소 한 단계다.
 */
import type { Layer } from '../core/model';
import { tableKey } from '../core/model';
import { copyEntity, transformEntity } from '../edit/geom';
import type { EditResult } from '../edit/geom';
import { moveCopyToLayer, targetLayerProblem } from '../edit/layertools/copytolayer';
import type { App, CommandContext } from './app';
import { currentLayer, validLayerName } from './layers';
import { Ghost, commitResults, translate } from './modify';
import { PickList, guardKeys, wideDialog } from './layertools-ui';
import { layerSwatch } from './laywalk';
import { h } from './ui/dom';

/** "도면층으로 복사" 대화상자: 대상 도면층 이름(목록에서 고르거나 새 이름 입력). 취소하면 null */
async function chooseTargetLayer(app: App): Promise<string | null> {
  const doc = app.active!.doc;
  const list = new PickList('대상 도면층', false);
  const layers = [...doc.layers.values()].filter((l) => !l.name.includes('|')).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  list.setItems(layers.map((l) => ({ key: l.name, label: l.name, swatch: layerSwatch(l), tag: l.locked ? '잠김' : l.frozen ? '동결' : l.off ? '끔' : '' })));
  const input = h('input', { class: 'ltx-input', type: 'text', 'aria-label': '대상 도면층', value: currentLayer(app) }) as HTMLInputElement;
  guardKeys(input);
  list.setSelection([layers.find((l) => tableKey(l.name) === tableKey(input.value))?.name ?? ''], false);
  list.onChange = () => {
    const k = list.selection()[0];
    if (k) input.value = k;
  };
  const err = h('div', { class: 'form-error', role: 'alert' });
  const body = h('div', { class: 'ltx-col' }, h('div', { class: 'ltx-h' }, '대상 도면층'), input, list.el, err);
  let ok = false;
  const dlg = wideDialog('도면층으로 복사', body, [
    { label: '취소', value: 'cancel' },
    {
      label: '확인',
      value: 'ok',
      primary: true,
      keep: () => {
        const p = targetLayerProblem(input.value);
        if (p) {
          err.textContent = p;
          return true;
        }
        ok = true;
        return false;
      },
    },
  ], 360);
  list.onActivate = () => (dlg.box.querySelector('footer .btn.primary') as HTMLButtonElement | null)?.click();
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (dlg.box.querySelector('footer .btn.primary') as HTMLButtonElement | null)?.click();
  });
  setTimeout(() => {
    input.focus();
    input.select();
  });
  await dlg.closed;
  return ok ? input.value.trim() : null;
}

async function ensureLayer(app: App, ctx: CommandContext, name: string): Promise<string | null> {
  const st = app.active!;
  const have = st.doc.layers.get(tableKey(name));
  if (have) return have.name;
  const r = await ctx.getPoint(`도면층 "${name}"이(가) 없습니다. 만드시겠습니까? [예(Y)/아니오(N)] <예>:`, {
    keywords: [
      { key: 'Y', label: '예' },
      { key: 'N', label: '아니오' },
    ],
  });
  if ('keyword' in r && r.keyword === 'N') return null;
  if (!('keyword' in r) && !('enter' in r)) return null;
  const err = validLayerName(name);
  if (err) {
    ctx.print(err, 'err');
    return null;
  }
  const layer: Layer = { name: name.trim(), handle: st.session.newHandle(), flags: 0, color: { aci: 7 }, off: false, frozen: false, locked: false, linetype: 'Continuous', lineweight: -3, plot: true, transparency: 255 };
  st.session.commit({ label: 'COPYTOLAYER', ops: [{ kind: 'layer', key: tableKey(layer.name), before: null, after: layer }], group: ctx.group });
  return layer.name;
}

export function registerCopyToLayerCommands(app: App): void {
  app.register({
    name: 'COPYTOLAYER',
    title: '도면층에 복사',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const hs = (await ctx.getSelection('복사할 객체 선택:')).filter((x) => doc.entityIndex.has(x) && st.session.ownerOf(x) === st.space);
      if (!hs.length) return;
      // 대상 도면층
      let target: string | null = null;
      for (;;) {
        const r = await ctx.getEntity('대상 도면층을 지정하기 위해 객체 선택 또는 [이름(N)] <이름>:', [{ key: 'N', label: '이름' }]);
        if ('handle' in r) {
          const e = doc.entityIndex.get(r.handle);
          if (!e) continue;
          target = doc.layers.get(tableKey(e.layer))?.name ?? e.layer;
          break;
        }
        const name = await chooseTargetLayer(app);
        if (name === null) return;
        target = await ensureLayer(app, ctx, name);
        if (!target) return;
        break;
      }
      if (targetLayerProblem(target)) {
        ctx.print(targetLayerProblem(target)!, 'err');
        return;
      }
      // 복사
      const results: EditResult[] = [];
      for (const x of hs) {
        const e = doc.entityIndex.get(x)!;
        const r = copyEntity(e, translate(0, 0), doc);
        for (const c of r.add ?? []) moveCopyToLayer(c, target);
        results.push(r);
      }
      st.selection.clear();
      const a = commitResults(app, ctx, results, 'COPYTOLAYER', { quiet: true });
      if (!a.added.length) {
        ctx.print('복사할 수 있는 객체가 없습니다.', 'err');
        return;
      }
      app.lastCreated = a.added;
      ctx.print(`${a.added.length}개의 객체가 "${target}" 도면층으로 복사되었습니다.`);
      // 옮기기(선택)
      const b = await ctx.getPoint('지정된 기준점 또는 [종료(X)] <종료>:', { keywords: [{ key: 'X', label: '종료' }] });
      if (!('point' in b)) {
        app.setSelection(a.added.slice(0, 5000));
        return;
      }
      const base = b.point;
      const ghost = new Ghost(app, a.added);
      const r2 = await ctx.getPoint('두 번째 점 지정 또는 <첫 번째 점을 변위로 사용>:', { base, ghost: (p) => ghost.at(translate(p.x - base.x, p.y - base.y)) });
      let dx: number;
      let dy: number;
      if ('point' in r2) {
        dx = r2.point.x - base.x;
        dy = r2.point.y - base.y;
      } else if ('enter' in r2) {
        dx = base.x;
        dy = base.y;
      } else {
        app.setSelection(a.added.slice(0, 5000));
        return;
      }
      if (dx || dy) {
        const m = translate(dx, dy);
        const moved: EditResult[] = a.added.map((x) => doc.entityIndex.get(x)).filter((e) => !!e).map((e) => transformEntity(e!, m, doc));
        commitResults(app, ctx, moved, 'COPYTOLAYER', { quiet: true, transform: m });
      }
      app.setSelection(a.added.filter((x) => doc.entityIndex.has(x)).slice(0, 5000));
    },
  });
}
