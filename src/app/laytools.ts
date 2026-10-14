/**
 * 도면층 도구: LAYLCK, LAYULK, LAYMCUR, LAYMCH, LAYCUR, LAYDEL, LAYMRG
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { currentLayer, patchLayers, setCurrentLayer } from './layers';

/** 객체를 골라 그 도면층 이름, 또는 이름(N)으로 입력 */
async function pickLayer(app: App, ctx: CommandContext, prompt: string, allowName: boolean): Promise<string | null | 'done'> {
  const st = app.active!;
  const r = await ctx.getEntity(prompt, allowName ? [{ key: 'N', label: '이름' }] : []);
  if ('handle' in r) return st.doc.entityIndex.get(r.handle)?.layer ?? null;
  if ('keyword' in r && r.keyword === 'N') {
    const t = await ctx.getPoint('도면층 이름 입력:', { allowText: true });
    if (!('text' in t)) return null;
    const L = st.doc.layers.get(tableKey(t.text.trim()));
    if (!L) {
      ctx.print(`도면층 "${t.text.trim()}"을(를) 찾을 수 없습니다.`, 'err');
      return null;
    }
    return L.name;
  }
  return 'done';
}

/** 도면층 이름을 바꾸는 객체 편집(공간·블록 정의 안의 객체 모두) */
function relayerOps(st: DocState, pred: (e: Entity) => boolean, layer: string): EditOp[] {
  const ops: EditOp[] = [];
  for (const [key, b] of st.doc.blocks)
    for (const e of b.entities) {
      if (!pred(e)) continue;
      const after = { ...e, layer } as Entity;
      if (after.type === 'INSERT') after.attribs = after.attribs.map((a) => (pred(a as Entity) ? { ...a, layer } : a));
      ops.push({ kind: 'modify', block: key, before: e, after });
    }
  return ops;
}

/** 도면층의 모든 객체를 지우는 편집(뒤에서부터) */
function eraseLayerOps(st: DocState, key: string): EditOp[] {
  const ops: EditOp[] = [];
  for (const [bk, b] of st.doc.blocks)
    for (let i = b.entities.length - 1; i >= 0; i--) {
      const e = b.entities[i]!;
      if (tableKey(e.layer) === key) ops.push({ kind: 'remove', block: bk, entity: e, index: i });
    }
  return ops;
}

function canRemove(app: App, ctx: CommandContext, key: string): boolean {
  if (key === '0' || key === 'DEFPOINTS') {
    ctx.print(`도면층 ${key === '0' ? '0' : 'Defpoints'}은(는) 지울 수 없습니다.`, 'err');
    return false;
  }
  if (key === tableKey(currentLayer(app))) {
    ctx.print('현재 도면층은 지울 수 없습니다.', 'err');
    return false;
  }
  if (key.includes('|')) {
    ctx.print('외부 참조 도면층은 지울 수 없습니다.', 'err');
    return false;
  }
  return true;
}

export function registerLayerToolCommands(app: App): void {
  app.register({
    name: 'LAYLCK',
    title: '도면층 잠금',
    async run(ctx) {
      for (;;) {
        const n = await pickLayer(app, ctx, '잠글 도면층의 객체 선택:', false);
        if (n === 'done') return;
        if (!n) continue;
        patchLayers(app, 'LAYLCK', [[n, { locked: true }]]);
        ctx.print(`도면층 "${n}"이(가) 잠겼습니다.`);
      }
    },
  });

  app.register({
    name: 'LAYULK',
    title: '도면층 잠금 해제',
    async run(ctx) {
      for (;;) {
        const n = await pickLayer(app, ctx, '잠금 해제할 도면층의 객체 선택:', false);
        if (n === 'done') return;
        if (!n) continue;
        patchLayers(app, 'LAYULK', [[n, { locked: false }]]);
        ctx.print(`도면층 "${n}"의 잠금이 해제되었습니다.`);
      }
    },
  });

  app.register({
    name: 'LAYMCUR',
    title: '객체의 도면층을 현재로',
    async run(ctx) {
      const hs = ctx.app.active!.selection.size ? [...ctx.app.active!.selection] : [];
      let n: string | null | 'done';
      if (hs.length === 1) n = ctx.app.active!.doc.entityIndex.get(hs[0]!)?.layer ?? null;
      else n = await pickLayer(app, ctx, '도면층을 현재로 설정할 객체 선택:', false);
      if (!n || n === 'done') return;
      if (setCurrentLayer(app, n)) ctx.print(`${n}이(가) 이제 현재 도면층입니다.`);
    },
  });

  app.register({
    name: 'LAYMCH',
    title: '도면층 일치',
    async run(ctx) {
      const st = app.active!;
      const hs = await ctx.getSelection('변경할 객체 선택:');
      if (!hs.length) return;
      const n = await pickLayer(app, ctx, '대상 도면층에 있는 객체 선택 또는 [이름(N)]:', true);
      if (!n || n === 'done') return;
      const set = new Set(hs);
      const ops = relayerOps(st, (e) => set.has(e.handle) && e.layer !== n, n).filter((o) => o.kind === 'modify' && set.has(o.before.handle));
      if (ops.length) st.session.commit({ label: 'LAYMCH', ops, group: ctx.group });
      ctx.print(`${ops.length}개 객체가 도면층 "${n}"(으)로 변경되었습니다.`);
    },
  });

  app.register({
    name: 'LAYCUR',
    title: '객체를 현재 도면층으로',
    async run(ctx) {
      const st = app.active!;
      const hs = await ctx.getSelection('현재 도면층으로 변경할 객체 선택:');
      if (!hs.length) return;
      const cur = currentLayer(app);
      const set = new Set(hs);
      const ops = relayerOps(st, (e) => set.has(e.handle) && e.layer !== cur, cur).filter((o) => o.kind === 'modify' && set.has(o.before.handle));
      if (ops.length) st.session.commit({ label: 'LAYCUR', ops, group: ctx.group });
      ctx.print(`${ops.length}개 객체가 현재 도면층 "${cur}"(으)로 변경되었습니다.`);
    },
  });

  app.register({
    name: 'LAYDEL',
    title: '도면층 삭제',
    async run(ctx) {
      const st = app.active!;
      const names: string[] = [];
      for (;;) {
        const n = await pickLayer(app, ctx, `삭제할 도면층의 객체 선택 또는 [이름(N)]${names.length ? ` (선택한 도면층: ${names.join(', ')})` : ''}:`, true);
        if (n === 'done') break;
        if (!n) continue;
        if (canRemove(app, ctx, tableKey(n)) && !names.includes(n)) names.push(n);
      }
      if (!names.length) return;
      ctx.print(`******** 경고 ********\n도면층 "${names.join(', ')}"을(를) 도면에서 삭제하려고 합니다.`);
      const ok = await ctx.getPoint('계속하시겠습니까? [예(Y)/아니오(N)] <아니오>:', {
        keywords: [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
      });
      if (!('keyword' in ok) || ok.keyword !== 'Y') return;
      const ops: EditOp[] = [];
      let n = 0;
      for (const name of names) {
        const key = tableKey(name);
        const erase = eraseLayerOps(st, key);
        n += erase.length;
        ops.push(...erase);
        const before = st.doc.layers.get(key);
        if (before) ops.push({ kind: 'layer', key, before, after: null });
      }
      st.session.commit({ label: 'LAYDEL', ops, group: ctx.group });
      ctx.print(`도면층 ${names.length}개와 객체 ${n}개를 삭제했습니다.`);
    },
  });

  app.register({
    name: 'LAYMRG',
    title: '도면층 병합',
    async run(ctx) {
      const st = app.active!;
      const names: string[] = [];
      for (;;) {
        const n = await pickLayer(app, ctx, `병합할 도면층의 객체 선택 또는 [이름(N)]${names.length ? ` (선택한 도면층: ${names.join(', ')})` : ''}:`, true);
        if (n === 'done') break;
        if (!n) continue;
        if (canRemove(app, ctx, tableKey(n)) && !names.includes(n)) names.push(n);
      }
      if (!names.length) return;
      const target = await pickLayer(app, ctx, '대상 도면층의 객체 선택 또는 [이름(N)]:', true);
      if (!target || target === 'done') return;
      const tkey = tableKey(target);
      const from = new Set(names.map(tableKey).filter((k) => k !== tkey));
      if (!from.size) return;
      ctx.print(`******** 경고 ********\n도면층 "${[...from].map((k) => st.doc.layers.get(k)?.name ?? k).join(', ')}"을(를) 도면층 "${target}"(으)로 병합하려고 합니다.`);
      const ok = await ctx.getPoint('계속하시겠습니까? [예(Y)/아니오(N)] <아니오>:', {
        keywords: [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
      });
      if (!('keyword' in ok) || ok.keyword !== 'Y') return;
      const ops = relayerOps(st, (e) => from.has(tableKey(e.layer)), target);
      for (const k of from) {
        const before = st.doc.layers.get(k);
        if (before) ops.push({ kind: 'layer', key: k, before, after: null });
      }
      st.session.commit({ label: 'LAYMRG', ops, group: ctx.group });
      ctx.print(`도면층 ${from.size}개를 "${target}"(으)로 병합했습니다.`);
    },
  });
}
