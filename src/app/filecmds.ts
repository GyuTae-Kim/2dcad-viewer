/**
 * 파일 명령: CLOSEALL·SAVEALL·QQUIT(Express)·REVERT(Express)·CLEANSCREENOFF, 그리고 플롯·배치·내보내기 쪽 파일 명령 묶음.
 * 같은 이름(별칭 포함)이 이미 등록돼 있으면 건너뛴다.
 */
import type { App, Command } from './app';
import type { DocState } from './docstate';
import { registerFileExportCommands } from './filecmds-export';
import { registerFileLayoutCommands } from './filecmds-layout';
import { registerFilePlotCommands } from './filecmds-plot';
import { RecentStore } from './recent';
import { quickSave, savedListeners } from './save';
import { sessionFile } from './sessionfiles';

/** 이 세션에서 마지막으로 저장한 내용(REVERT가 되돌릴 곳) */
const lastSaved = new WeakMap<DocState, { data: Blob; name: string }>();
let listening = false;

/** 되돌릴 원본: 이 세션에서 저장한 내용, 없으면 연 파일(고른 파일·최근 문서·예제) */
async function revertSource(st: DocState): Promise<{ data: ArrayBuffer; name: string; saved?: { data: Blob; name: string } } | null> {
  const saved = lastSaved.get(st);
  if (saved) return { data: await saved.data.arrayBuffer(), name: saved.name, saved };
  const f = sessionFile(st.name);
  if (f && f.size === st.size) {
    try {
      return { data: await f.arrayBuffer(), name: st.name };
    } catch {
      /* 디스크의 파일이 바뀌어 읽을 수 없으면 최근 문서에서 */
    }
  }
  const recent = await new RecentStore().get(`${st.name}:${st.size}`);
  if (recent) return { data: recent, name: st.name };
  if (st.name === 'opencad-sample.dxf') {
    try {
      const r = await fetch(new URL('samples/opencad-sample.dxf', document.baseURI));
      if (r.ok) return { data: await r.arrayBuffer(), name: st.name };
    } catch {
      /* 받지 못함 */
    }
  }
  return null;
}

/** 열린 도면을 차례로 닫는다(바뀐 도면은 그 도면을 보이고 저장할지 묻는다). 모두 닫았으면 true */
async function closeAll(app: App): Promise<boolean> {
  for (const st of [...app.docs]) {
    if (!app.docs.includes(st)) continue;
    if (st.session?.dirty && app.active !== st) app.activate(st);
    if (!(await app.close(st))) return false;
  }
  return true;
}

export function registerFileCommands(app: App): void {
  const reg = (c: Command) => {
    if (app.findCommand(c.name)) return;
    for (const a of c.aliases ?? []) if (app.findCommand(a)) c.aliases = c.aliases!.filter((x) => x !== a);
    app.register(c);
  };
  if (!listening) {
    listening = true;
    savedListeners.add((st, data, name) => lastSaved.set(st, { data, name }));
  }

  reg({
    name: 'CLOSEALL',
    title: '모두 닫기',
    noDoc: true,
    async run(ctx) {
      if (!app.docs.length) {
        ctx.print('열린 도면이 없습니다.');
        return;
      }
      const n = app.docs.length;
      if (!(await closeAll(app))) {
        ctx.print(`*취소* (${n - app.docs.length}개를 닫았습니다)`);
        return;
      }
      ctx.print(`도면 ${n}개를 모두 닫았습니다.`);
    },
  });

  reg({
    name: 'QQUIT',
    title: '모두 닫고 끝내기(Express)',
    noDoc: true,
    async run(ctx) {
      const n = app.docs.length;
      if (!(await closeAll(app))) {
        ctx.print('*취소*');
        return;
      }
      ctx.print(`${n ? `도면 ${n}개를 모두 닫았습니다. ` : ''}브라우저에서는 이 탭을 직접 닫으십시오.`);
    },
  });

  reg({
    name: 'SAVEALL',
    title: '모두 저장',
    async run(ctx) {
      const dirty = app.docs.filter((d) => d.session?.dirty);
      if (!dirty.length) {
        ctx.print('바뀐 도면이 없습니다.');
        return;
      }
      let saved = 0;
      for (const st of dirty) {
        if (!app.docs.includes(st)) continue;
        if (await quickSave(app, ctx, st)) saved++;
      }
      // 저장이 창 제목을 저장한 도면 이름으로 바꾸므로 보고 있는 도면으로 되돌린다
      if (app.active) document.title = `${app.active.saveName} - OpenCAD 2D 뷰어`;
      ctx.print(`바뀐 도면 ${dirty.length}개 중 ${saved}개를 저장했습니다.`);
    },
  });

  reg({
    name: 'REVERT',
    title: '마지막 저장 상태로 되돌리기(Express)',
    async run(ctx) {
      const st = app.active!;
      if (!st.session.dirty) {
        ctx.print('도면이 수정되지 않았습니다.');
        return;
      }
      const r = await ctx.getPoint(`${st.saveName}의 변경 내용을 모두 버리고 마지막으로 저장한 상태로 되돌리겠습니까? [예(Y)/아니오(N)] <예>:`, {
        keywords: [
          { key: 'Y', label: '예' },
          { key: 'N', label: '아니오' },
        ],
      });
      if ('keyword' in r && r.keyword === 'N') return;
      if ('point' in r || 'text' in r) return;
      const src = await revertSource(st);
      if (!src) {
        ctx.print('이 도면은 아직 파일로 저장되지 않아 되돌릴 내용이 없습니다.', 'err');
        return;
      }
      const index = app.docs.indexOf(st);
      // 새로 열고 나서 옛 탭을 닫는다(열지 못하면 그대로 둔다). 같은 자리에 둔다
      const fresh = await app.openFile(src.name, src.data);
      if (!fresh) return;
      // 다시 되돌릴 때도 같은 저장본을 쓴다
      if (src.saved) lastSaved.set(fresh, src.saved);
      await app.close(st, true);
      const at = app.docs.indexOf(fresh);
      if (at >= 0 && index >= 0 && at !== index) {
        app.docs.splice(at, 1);
        app.docs.splice(Math.min(index, app.docs.length), 0, fresh);
      }
      app.activate(fresh);
      ctx.print(`${src.name}을(를) 마지막으로 저장한 상태로 되돌렸습니다.`);
    },
  });

  reg({
    name: 'CLEANSCREENOFF',
    title: '전체 화면 끄기',
    noDoc: true,
    transparent: true,
    run(ctx) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else ctx.print('전체 화면이 아닙니다.');
    },
  });

  registerFilePlotCommands(app, reg);
  registerFileLayoutCommands(app, reg);
  registerFileExportCommands(app, reg);
}
