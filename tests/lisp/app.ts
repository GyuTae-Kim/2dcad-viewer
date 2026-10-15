/**
 * AutoLISP 시험용 가짜 App(tests/script/app.ts를 본떴다): 문서·편집 세션은 진짜(DocState·EditSession),
 * 명령행은 App의 요청(requestPoint·requestEntity·requestSelection)·입력 고리(inputFilters)·입력 해석을 줄여 흉내 낸다.
 * AutoLISP 연결(src/app/lisp.ts)과 스크립트 실행기(src/app/script.ts)를 그대로 붙인다.
 */
import type { CadDocument, Entity } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import type { App, Command, CommandContext, Keyword, PointResult } from '../../src/app/app';
import { CancelError } from '../../src/app/app';
import { DocState } from '../../src/app/docstate';
import { parsePointInput } from '../../src/app/commandline';
import { EditSession } from '../../src/edit/session';
import { entityPath } from '../../src/edit/geom/path';
import { pathNearest } from '../../src/edit/geom/curve';
import { boundsOf } from '../../src/edit/geom/query';
import { lispBusy, lispSession, registerLispCommands } from '../../src/app/lisp';
import { runScriptText, scriptRunner } from '../../src/app/script';

type Pt = { x: number; y: number };
type PointOpts = Parameters<CommandContext['getPoint']>[1];
type Req =
  | { kind: 'point'; prompt: string; keywords: Keyword[]; base: Pt | null; allowText: boolean; preferNumber: boolean; signal: AbortSignal; resolve: (r: PointResult) => void; reject: (e: unknown) => void }
  | { kind: 'entity'; prompt: string; keywords: Keyword[]; signal: AbortSignal; resolve: (r: { handle: string; point: Pt } | { keyword: string } | { enter: true }) => void; reject: (e: unknown) => void }
  | { kind: 'select'; prompt: string; keywords: Keyword[]; remove: boolean; signal: AbortSignal; resolve: (r: { handles: string[] } | { keyword: string }) => void; reject: (e: unknown) => void };

export interface LispApp {
  app: App;
  st: DocState;
  doc: CadDocument;
  printed: { text: string; cls?: 'err' | 'res' }[];
  prompts: string[];
  /** 명령행에 친 것처럼 */
  type(text: string): void;
  /** AutoLISP·명령이 쉬거나 입력을 기다릴 때까지 */
  idle(): Promise<void>;
  /** 식을 치고 끝날 때까지 기다린다 */
  lisp(text: string): Promise<void>;
  script(text: string, name?: string): Promise<'idle' | 'paused'>;
  out(): string;
  errors(): string[];
  add(e: Entity): Entity;
  model<T extends Entity['type']>(type: T): (Entity & { type: T } & Record<string, any>)[];
  pending(): { kind: string; prompt: string } | null;
}

function distanceTo(doc: CadDocument, e: Entity, x: number, y: number): number {
  const p = entityPath(e);
  if (p && p.pieces.length) return pathNearest(p, { x, y }).d;
  const b = boundsOf([e], doc);
  if (!b) return Infinity;
  return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));
}

export function makeLispApp(setup?: (doc: CadDocument) => void): LispApp {
  const doc = createNewDocument('metric');
  setup?.(doc);
  const st = new DocState(1, doc, 'test.dwg', 0, 0);
  const lastCreated: string[] = [];
  st.session = new EditSession(doc, (tx) => {
    for (const op of tx.ops) if (op.kind === 'add') lastCreated.push(op.entity.handle);
  });
  const commands = new Map<string, Command>();
  const aliases = new Map<string, string>();
  const printed: { text: string; cls?: 'err' | 'res' }[] = [];
  const prompts: string[] = [];
  let running: { name: string; ctrl: AbortController } | null = null;
  let serial = 0;
  let lastPoint: Pt | null = null;
  const space = () => doc.blocks.get(MODEL_SPACE)!.entities;
  const picker = {
    pick(x: number, y: number, tol: number): string | null {
      let best: string | null = null;
      let bd = Infinity;
      for (const e of space()) {
        const d = distanceTo(doc, e, x, y);
        if (d <= tol && d < bd) {
          bd = d;
          best = e.handle;
        }
      }
      return best;
    },
    select(r: [number, number, number, number], crossing: boolean): string[] {
      return space()
        .filter((e) => {
          const b = boundsOf([e], doc);
          if (!b) return false;
          const inside = b.minX >= r[0] && b.minY >= r[1] && b.maxX <= r[2] && b.maxY <= r[3];
          const touch = b.maxX >= r[0] && b.maxY >= r[1] && b.minX <= r[2] && b.minY <= r[3];
          return crossing ? touch : inside;
        })
        .map((e) => e.handle);
    },
  };
  const print = (text: string, cls?: 'err' | 'res') => {
    cmd.onPrint?.(text, cls);
    printed.push({ text, cls });
  };
  const cmd = {
    print,
    acceptSpaces: false,
    lispContinue: false,
    prompt: '',
    setPrompt(t: string) {
      cmd.prompt = t;
    },
    onPrint: null as null | ((t: string, c?: 'err' | 'res') => void),
    input: { value: '' },
  };

  const findCommand = (name: string): Command | undefined => {
    const raw = name.trim().toUpperCase().replace(/^[_.']+/, '');
    const dash = commands.get(raw) ?? commands.get(aliases.get(raw) ?? '');
    if (dash) return dash;
    const n = raw.replace(/^-+/, '');
    return commands.get(n) ?? commands.get(aliases.get(n) ?? '');
  };

  const promptOf = (r: { prompt: string; keywords: Keyword[] }) => (r.keywords.length && !r.prompt.includes('[') ? `${r.prompt.replace(/:$/, '')} [${r.keywords.map((k) => `${k.label}(${k.key})`).join('/')}]:` : r.prompt);

  function setRequest(r: Req): void {
    prompts.push(r.prompt);
    a.request = r;
    cmd.setPrompt(promptOf(r));
    r.signal.addEventListener(
      'abort',
      () => {
        if (a.request === r) a.request = null;
        r.reject(new CancelError());
      },
      { once: true },
    );
  }

  function requestPoint(prompt: string, opt: PointOpts = {}, signal: AbortSignal): Promise<PointResult> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CancelError());
      const r: Req = {
        kind: 'point',
        prompt,
        keywords: opt.keywords ?? [],
        base: opt.base ?? null,
        allowText: !!opt.allowText || !!opt.preferNumber,
        preferNumber: !!opt.preferNumber,
        signal,
        resolve: (v) => {
          if (a.request === r) a.request = null;
          resolve(v);
        },
        reject,
      };
      setRequest(r);
    });
  }

  function requestEntity(prompt: string, keywords: Keyword[], signal: AbortSignal): Promise<{ handle: string; point: Pt } | { keyword: string } | { enter: true }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CancelError());
      const r: Req = {
        kind: 'entity',
        prompt,
        keywords,
        signal,
        resolve: (v) => {
          if (a.request === r) a.request = null;
          resolve(v);
        },
        reject,
      };
      setRequest(r);
    });
  }

  async function requestSelection(prompt: string, opt: { keywords?: Keyword[]; noPickfirst?: boolean }, signal: AbortSignal): Promise<string[]> {
    if (st.selection.size && !opt.noPickfirst) {
      const hs = [...st.selection];
      a.lastSelection = hs;
      return hs;
    }
    const kws: Keyword[] = [{ key: 'ALL', label: '전체' }, { key: 'P', label: '이전' }, { key: 'L', label: '마지막' }, { key: 'R', label: '제거' }, { key: 'A', label: '추가' }, ...(opt.keywords ?? [])];
    for (;;) {
      const r = await new Promise<{ handles: string[] } | { keyword: string }>((resolve, reject) => {
        if (signal.aborted) return reject(new CancelError());
        const q: Req = {
          kind: 'select',
          prompt,
          keywords: kws,
          remove: false,
          signal,
          resolve: (v) => {
            if (a.request === q) a.request = null;
            resolve(v);
          },
          reject,
        };
        setRequest(q);
      });
      if ('handles' in r) {
        a.lastSelection = r.handles;
        return r.handles;
      }
      const k = r.keyword.toUpperCase();
      if (k === 'ALL') for (const h of space().map((e) => e.handle)) st.selection.add(h);
      else if (k === 'P') for (const h of a.lastSelection) st.selection.add(h);
      else if (k === 'L') {
        const h = lastCreated.filter((x) => doc.entityIndex.has(x)).slice(-1)[0];
        if (h) st.selection.add(h);
      }
    }
  }

  function onInput(text: string): void {
    for (const f of a.inputFilters) if (f.input(text, a.request)) return;
    const r = a.request;
    if (!r) {
      if (text) void run(text);
      return;
    }
    const t = text.trim();
    if (r.kind === 'select') {
      if (!t) {
        r.resolve({ handles: [...st.selection] });
        return;
      }
      const up = t.toUpperCase();
      if (up === 'R') {
        r.remove = true;
        return;
      }
      if (up === 'A') {
        r.remove = false;
        return;
      }
      const kw = r.keywords.find((k) => k.key.toUpperCase() === up || k.label === t);
      if (kw) {
        r.resolve({ keyword: kw.key });
        return;
      }
      print('객체를 고르거나 옵션(ALL·P·L·R)을 입력하십시오.', 'err');
      return;
    }
    if (!t) {
      r.resolve({ enter: true });
      return;
    }
    const up = t.toUpperCase();
    const kw = r.keywords.find((k) => k.key.toUpperCase() === up || k.label === t);
    if (kw) {
      r.resolve({ keyword: kw.key });
      return;
    }
    if (t.startsWith("'")) {
      void run(t.slice(1));
      return;
    }
    if (r.kind === 'point') {
      if (r.preferNumber && /^-?[\d.]+(?:e-?\d+)?$/i.test(t)) {
        r.resolve({ text: t });
        return;
      }
      const p = parsePointInput(t, r.base ?? lastPoint, null);
      if (p) {
        lastPoint = p;
        a.lastPoint = p;
        print(`${promptOf(r)} ${t}`);
        r.resolve({ point: p, snap: null });
        return;
      }
      if (r.allowText) {
        r.resolve({ text: t });
        return;
      }
      print('점이 올바르지 않습니다. 예: 100,50  @20,0  @30<45', 'err');
      return;
    }
    print('객체를 선택하거나 옵션을 입력하십시오.', 'err');
  }

  function cancel(): void {
    if (a.request) {
      const r = a.request;
      a.request = null;
      r.reject(new CancelError());
    } else if (running) {
      running.ctrl.abort();
      running = null;
    }
    cmd.setPrompt('');
  }

  async function run(name: string, arg?: string): Promise<void> {
    const c = findCommand(name);
    if (!c) {
      print(`알 수 없는 명령 "${name}". 도움말은 F1을 누르십시오.`, 'err');
      return;
    }
    if (running && !c.transparent) {
      cancel();
      running?.ctrl.abort();
    }
    const nested = !!running && !!c.transparent;
    const saved = nested ? a.request : null;
    if (nested) a.request = null;
    const ctrl = new AbortController();
    if (!nested) running = { name: c.name, ctrl };
    print(`명령: ${c.name}`);
    const ctx: CommandContext = {
      app: a as unknown as App,
      print,
      group: ++serial,
      getPoint: (prompt, opt) => requestPoint(prompt, opt, ctrl.signal),
      getEntity: (prompt, kws) => requestEntity(prompt, kws ?? [], ctrl.signal),
      getSelection: (prompt, opt) => requestSelection(prompt ?? '객체 선택:', opt ?? {}, ctrl.signal),
    };
    try {
      await c.run(ctx, arg);
    } catch (e) {
      if (e instanceof CancelError) print('*취소*');
      else print(`오류: ${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      if (a.request?.signal === ctrl.signal) a.request = null;
      if (nested) {
        if (!a.request && saved) a.request = saved;
      } else if (running?.ctrl === ctrl) {
        running = null;
        cmd.setPrompt('');
      }
    }
  }

  const a = {
    request: null as Req | null,
    inputFilters: [] as { name: string; input(t: string, p: unknown): boolean }[],
    active: st,
    docs: [st],
    commands,
    aliases,
    lastCreated,
    lastSelection: [] as string[],
    lastPoint: null as Pt | null,
    imageKeys: new Set<string>(),
    snapModes: new Set<string>(['end', 'mid', 'cen']),
    osnapOn: true,
    orthoOn: false,
    gridOn: false,
    snapOn: false,
    polarOn: false,
    dynOn: true,
    register(c: Command) {
      commands.set(c.name.toUpperCase(), c);
      for (const al of c.aliases ?? []) aliases.set(al.toUpperCase(), c.name.toUpperCase());
    },
    findCommand,
    picker: () => picker,
    view: { overlay: { pickbox: 5, snap: null, ghost: [], rubber: [] as unknown[], marks: [], tip: null as string | null }, pixelSize: () => 0.01, requestOverlay() {}, requestRender() {} },
    cmd,
    ui: { setBusy() {}, refreshPalette() {}, refreshStatus() {}, refreshLayouts() {}, refreshTabs() {} },
    edits: { flush: async () => {} },
    clearSelection() {
      st.selection.clear();
    },
    setSelection(hs: Iterable<string>, mode: 'replace' | 'add' | 'remove' = 'replace') {
      if (mode === 'replace') st.selection.clear();
      for (const h of hs) {
        if (mode === 'remove') st.selection.delete(h);
        else st.selection.add(h);
      }
    },
    refreshSelectionOverlay() {},
    get busyCommand() {
      return running?.name ?? null;
    },
    get pendingInput() {
      return a.request;
    },
    submitInput: (t: string) => onInput(t),
    onInput,
    requestPoint,
    requestEntity,
    requestSelection,
    promptOf,
    run,
    cancel,
  };
  const app = a as unknown as App;
  registerLispCommands(app);

  const idle = async () => {
    for (let i = 0; i < 2000; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (!lispBusy(app) && !(a.busyCommand && !a.request)) return;
    }
    throw new Error('AutoLISP가 끝나지 않았습니다');
  };

  return {
    app,
    st,
    doc,
    printed,
    prompts,
    type: (t) => onInput(t),
    idle,
    async lisp(text: string) {
      onInput(text);
      await idle();
      lispSession(app).it.flush();
    },
    async script(text, name = 'test.scr') {
      const runner = scriptRunner(app);
      const done = new Promise<'idle' | 'paused'>((resolve) => {
        runner.onStop = (s) => resolve(s === 'idle' ? 'idle' : 'paused');
      });
      runScriptText(app, name, text);
      return done;
    },
    out: () => printed.map((p) => p.text).join('\n'),
    errors: () => printed.filter((p) => p.cls === 'err').map((p) => p.text),
    add(e: Entity) {
      if (!e.handle) e.handle = st.session.newHandle();
      e.owner = doc.blocks.get(MODEL_SPACE)!.recordHandle;
      st.session.commit({ label: 'TEST', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
      return doc.entityIndex.get(e.handle)!;
    },
    model<T extends Entity['type']>(type: T) {
      return space().filter((e) => e.type === type) as (Entity & { type: T } & Record<string, any>)[];
    },
    pending: () => (a.request ? { kind: a.request.kind, prompt: a.request.prompt } : null),
  };
}
