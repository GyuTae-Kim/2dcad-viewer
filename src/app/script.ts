/**
 * 스크립트: SCRIPT(SCR), RSCRIPT, RESUME, DELAY와 스크립트용 변수 FILEDIA·CMDDIA·CMDECHO.
 * 고른 .scr 파일(UTF-8·UTF-16·CP949 자동 판별)을 명령행에 차례로 넣는다. 규칙과 실행은 src/edit/script(읽기·실행기),
 * 여기는 App과의 연결(명령행 출력 지켜보기, 선택·객체 고르기, Esc·Backspace, 명령 취소 묶음)이다.
 * 파일 끌어 놓기 등 다른 곳에서 부를 때는 runScriptFile·runScriptText.
 */
import type { App } from './app';
import { ScriptRunner, type ScriptHost } from '../edit/script/runner';
import { decodeScript } from '../edit/script/reader';
import { pickFiles } from './drawingfiles';
import type { EditSession } from '../edit/session';

/** 이 세션에서 읽은 스크립트(이름 소문자 → 글). 스크립트 안의 SCRIPT·FILEDIA 0은 이름으로 찾는다 */
const loaded = new Map<string, { name: string; text: string }>();

/** 스크립트용 변수(도면에 저장하지 않는다) */
export const scriptVars = { FILEDIA: 1, CMDDIA: 1, CMDECHO: 1 };

const runners = new WeakMap<App, ScriptRunner>();

/** AutoLISP 연결(lisp.ts가 단다): 평가 중인가(입력을 기다리지 않음), 식을 평가할 수 있는가 */
let lispLink: { busy(app: App): boolean; available(app: App): boolean } | null = null;
export function linkLisp(link: { busy(app: App): boolean; available(app: App): boolean }): void {
  lispLink = link;
}

/** App과 실행기를 잇는다 */
function appHost(app: App): ScriptHost {
  const picker = () => app.picker();
  const tolerance = () => app.view.overlay.pickbox * app.view.pixelSize();
  const removing = () => !!app.pendingInput?.remove;
  return {
    state: () => (lispLink?.busy(app) ? 'busy' : app.pendingInput ? 'input' : app.busyCommand ? 'busy' : 'command'),
    evalLisp: (t) => {
      if (!lispLink?.available(app)) return false;
      app.submitInput(t);
      return true;
    },
    inputKind: () => app.pendingInput?.kind ?? null,
    acceptsSpaces: () => app.cmd.acceptSpaces,
    findCommand: (n) => app.findCommand(n)?.name ?? null,
    hasCommand: (n) => app.commands.has(n.toUpperCase()),
    isVariable: (n) => !!app.active?.doc.header.has(`$${n.toUpperCase()}`),
    runCommand: (n, arg) => void app.run(n, arg),
    submit: (t) => app.submitInput(t),
    print: (t, cls) => app.cmd.print(t, cls),
    watchPrint(f) {
      const prev = app.cmd.onPrint;
      const mine = (t: string, cls?: 'err' | 'res') => {
        prev?.(t, cls);
        f(t, cls);
      };
      app.cmd.onPrint = mine;
      return () => {
        if (app.cmd.onPrint === mine) app.cmd.onPrint = prev;
      };
    },
    watchKeys(f) {
      if (typeof window === 'undefined') return () => {};
      const on = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') f('esc');
        else if (ev.key === 'Backspace') {
          // 글을 고치는 중(대화상자 입력란·명령행에 글이 있음)이면 멈추지 않는다
          const t = ev.target as HTMLElement | null;
          const editing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
          if (!editing || (t === app.cmd.input && !app.cmd.input.value)) f('backspace');
        }
      };
      window.addEventListener('keydown', on, true);
      return () => window.removeEventListener('keydown', on, true);
    },
    pickEntity(p) {
      // 객체 하나 고르기 요청에 그 자리의 객체를 답한다(App.onClick과 같은 답)
      const req = app.pendingInput as unknown as { kind: string; resolve?: (r: { handle: string; point: { x: number; y: number } }) => void } | null;
      const pk = picker();
      if (req?.kind !== 'entity' || !req.resolve || !pk) return false;
      const h = pk.pick(p.x, p.y, tolerance());
      if (!h) return false;
      req.resolve({ handle: h, point: p });
      return true;
    },
    selectAt(p) {
      const pk = picker();
      const h = pk?.pick(p.x, p.y, tolerance());
      if (!h) return 0;
      app.setSelection([h], removing() ? 'remove' : 'add');
      return 1;
    },
    selectWindow(a, b, crossing) {
      const pk = picker();
      if (!pk) return 0;
      const hits = pk.select([Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)], crossing);
      app.setSelection(hits, removing() ? 'remove' : 'add');
      return hits.length;
    },
    selectPolygon(pts, crossing) {
      const hits = picker()?.selectPolygon(pts, crossing) ?? [];
      app.setSelection(hits, removing() ? 'remove' : 'add');
      return hits.length;
    },
    selectFence(pts) {
      const hits = picker()?.selectFence(pts) ?? [];
      app.setSelection(hits, removing() ? 'remove' : 'add');
      return hits.length;
    },
    clearSelection: () => {
      if (app.active?.selection.size) app.clearSelection();
    },
    dialogOpen: () => typeof document !== 'undefined' && !!document.querySelector('.dialog-back'),
    undoMark: () => (app.active ? { session: app.active.session, depth: app.active.session.depth } : null),
    squashUndo: (mark, label) => {
      const m = mark as { session: EditSession; depth: number } | null;
      // 스크립트가 다른 도면을 열거나 닫았어도 시작한 도면의 기록만 합친다
      if (m && app.docs.some((d) => d.session === m.session)) m.session.squashUndo(m.depth, label);
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => performance.now(),
    flush: async () => {
      if (app.active) await app.edits.flush(app.active);
    },
  };
}

/** App의 스크립트 실행기 */
export function scriptRunner(app: App): ScriptRunner {
  let r = runners.get(app);
  if (!r) {
    r = new ScriptRunner(appHost(app));
    runners.set(app, r);
  }
  return r;
}

/** 스크립트가 실행 중인가(명령이 파일 선택 창·대화상자 대신 명령행 버전을 써야 할 때) */
export function inScript(app: App): boolean {
  return runners.get(app)?.active ?? false;
}

/** 대화상자 대신 명령행으로 물어야 하는가(스크립트 실행 중이거나 CMDDIA 0) */
export function commandLineMode(app: App): boolean {
  return inScript(app) || scriptVars.CMDDIA === 0;
}

/** 파일 선택 창 대신 이름을 물어야 하는가(스크립트 실행 중이거나 FILEDIA 0) */
export function fileNameMode(app: App): boolean {
  return inScript(app) || scriptVars.FILEDIA === 0;
}

/** 스크립트 글을 실행한다(파일 끌어 놓기 등) */
export function runScriptText(app: App, name: string, text: string): void {
  loaded.set(name.toLowerCase(), { name, text });
  app.cmd.print(`스크립트 "${name}"을(를) 실행합니다.`);
  scriptRunner(app).load(name, text);
}

/** .scr 파일을 읽어 실행한다(인코딩 자동 판별) */
export async function runScriptFile(app: App, file: File): Promise<void> {
  const { text } = decodeScript(new Uint8Array(await file.arrayBuffer()));
  runScriptText(app, file.name, text);
}

/** 이 세션에서 읽은 스크립트를 이름으로(확장자 없어도) */
function findLoaded(name: string): { name: string; text: string } | null {
  const k = name.trim().replace(/^"|"$/g, '').replace(/^.*[\\/]/, '').toLowerCase();
  return loaded.get(k) ?? loaded.get(`${k}.scr`) ?? null;
}

export function registerScriptCommands(app: App): void {
  app.register({
    name: 'SCRIPT',
    aliases: ['SCR'],
    title: '스크립트 실행',
    async run(ctx) {
      const runner = scriptRunner(app);
      let item: { name: string; text: string } | null = null;
      if (fileNameMode(app)) {
        // 스크립트 안(또는 FILEDIA 0): 이름으로. 브라우저는 경로로 파일을 열 수 없어 이 세션에서 연 스크립트만 찾는다
        const r = await ctx.getPoint('스크립트 파일 이름 입력:', { allowText: true });
        if (!('text' in r)) return;
        item = findLoaded(r.text);
        if (!item) {
          ctx.print(`스크립트 파일 "${r.text.trim()}"을(를) 찾을 수 없습니다. 이 웹 버전은 경로로 파일을 열 수 없어 이번 세션에서 연 스크립트만 이름으로 실행합니다.`, 'err');
          return;
        }
      } else {
        const files = await pickFiles('.scr,.SCR,.txt', false);
        const f = files[0];
        if (!f) return;
        const { text, encoding } = decodeScript(new Uint8Array(await f.arrayBuffer()));
        item = { name: f.name, text };
        loaded.set(f.name.toLowerCase(), item);
        if (encoding === 'cp949') ctx.print('참고: 이 스크립트는 CP949(한국어 Windows) 인코딩으로 읽었습니다.');
      }
      ctx.print(`스크립트 "${item.name}"을(를) 실행합니다. 멈추려면 Esc나 Backspace를 누르십시오.`);
      runner.load(item.name, item.text);
    },
  });

  app.register({
    name: 'RSCRIPT',
    title: '스크립트 처음부터 다시',
    noDoc: true,
    run(ctx) {
      if (!scriptRunner(app).restart()) ctx.print('다시 실행할 스크립트가 없습니다. 먼저 SCRIPT로 실행하십시오.', 'err');
    },
  });

  app.register({
    name: 'RESUME',
    title: '멈춘 스크립트 이어서',
    transparent: true,
    noDoc: true,
    run(ctx) {
      if (!scriptRunner(app).resume()) ctx.print('이어서 실행할 스크립트가 없습니다.');
    },
  });

  app.register({
    name: 'DELAY',
    title: '스크립트 지연',
    transparent: true,
    noDoc: true,
    async run(ctx, arg) {
      let ms = arg !== undefined && arg.trim() ? Number(arg) : NaN;
      while (!(Number.isInteger(ms) && ms >= 0 && ms <= 32767)) {
        if (!Number.isNaN(ms)) ctx.print('0에서 32767 사이의 정수(밀리초)가 필요합니다.', 'err');
        const r = await ctx.getPoint('지연 시간 입력(밀리초):', { preferNumber: true });
        if (!('text' in r)) return;
        ms = Number(r.text);
        if (Number.isNaN(ms)) ms = -1;
      }
      // 조금씩 기다리며 명령 취소(Esc)를 본다
      const end = performance.now() + ms;
      const me = app.busyCommand;
      while (performance.now() < end && app.busyCommand === me) await new Promise((r) => setTimeout(r, Math.min(50, end - performance.now())));
    },
  });

  // 스크립트용 변수: 도면에 없는 시스템 변수라 이 세션에만 둔다
  const sysvar = (name: keyof typeof scriptVars, title: string) =>
    app.register({
      name,
      title,
      noDoc: true,
      async run(ctx, arg) {
        let v = arg !== undefined && arg.trim() ? Number(arg) : NaN;
        while (!(v === 0 || v === 1)) {
          if (!Number.isNaN(v)) ctx.print('0 또는 1이 필요합니다.', 'err');
          const r = await ctx.getPoint(`${name}에 대한 새 값 입력 <${scriptVars[name]}>:`, { preferNumber: true });
          if ('enter' in r) return;
          if (!('text' in r)) return;
          v = Number(r.text);
          if (Number.isNaN(v)) v = -1;
        }
        scriptVars[name] = v;
      },
    });
  sysvar('FILEDIA', '파일 대화상자 표시(0 = 이름 입력)');
  sysvar('CMDDIA', '명령 대화상자 표시(0 = 명령행)');
  sysvar('CMDECHO', '스크립트 입력 표시');
}
