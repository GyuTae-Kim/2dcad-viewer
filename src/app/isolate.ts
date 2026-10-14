/**
 * 객체 격리·숨기기: ISOLATEOBJECTS, HIDEOBJECTS, UNISOLATEOBJECTS(UNHIDE)
 * 화면에서만 감추고 도면에는 저장하지 않는다(OBJECTISOLATIONMODE 0과 같다).
 */
import type { App } from './app';

export function registerIsolateCommands(app: App): void {
  app.register({
    name: 'ISOLATEOBJECTS',
    aliases: ['ISOLATE'],
    title: '객체 격리',
    async run(ctx) {
      const st = app.active!;
      const keep = new Set(await ctx.getSelection('객체 선택:'));
      if (!keep.size) return;
      const block = st.doc.blocks.get(st.space);
      const hide = new Set(st.hiddenObjects);
      for (const e of block?.entities ?? []) if (!keep.has(e.handle) && e.type !== 'VIEWPORT') hide.add(e.handle);
      for (const h of keep) hide.delete(h);
      app.setHiddenObjects(st, hide);
      ctx.print(`객체 ${keep.size}개를 격리했습니다. UNISOLATEOBJECTS로 모두 다시 보입니다.`);
    },
  });
  app.register({
    name: 'HIDEOBJECTS',
    title: '객체 숨기기',
    async run(ctx) {
      const st = app.active!;
      const sel = await ctx.getSelection('객체 선택:');
      if (!sel.length) return;
      app.setHiddenObjects(st, [...st.hiddenObjects, ...sel]);
      ctx.print(`객체 ${sel.length}개를 숨겼습니다. UNISOLATEOBJECTS로 다시 보입니다.`);
    },
  });
  app.register({
    name: 'UNISOLATEOBJECTS',
    aliases: ['UNHIDE', 'UNISOLATE'],
    title: '객체 격리 끝',
    run(ctx) {
      const st = app.active!;
      if (!st.hiddenObjects.size) {
        ctx.print('숨기거나 격리한 객체가 없습니다.');
        return;
      }
      const n = st.hiddenObjects.size;
      app.setHiddenObjects(st, []);
      ctx.print(`숨긴 객체 ${n}개를 다시 보입니다.`);
    },
  });
}
