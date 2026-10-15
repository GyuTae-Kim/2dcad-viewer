/**
 * 스크립트 시험용 가짜 App: 문서·편집 세션은 진짜(DocState·EditSession), 명령행은 App의 요청·입력 해석을 줄여 흉내 낸다.
 * 명령은 진짜 등록 함수로 붙이고, 스크립트는 src/app/script.ts의 실행기(appHost)가 그대로 넣는다.
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
import { SELECT_METHODS, runSelectMethod, selectMethodOf } from '../../src/app/selmethod';
import { runScriptText, scriptRunner } from '../../src/app/script';
import { fakePolySelect } from './selfake';
import { readCadFile } from '../../src/io';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';

/** 엔진 워커 흉내: 같은 스레드에서 읽고 쓴다 */
export function fakeEngine() {
  const docs = new Map<number, CadDocument>();
  let next = 100;
  return {
    async open(name: string, data: ArrayBuffer) {
      const doc = readCadFile(new Uint8Array(data), name);
      const docId = next++;
      docs.set(docId, doc);
      return { docId, doc, readMs: 0 };
    },
    async adopt(_name: string, doc: CadDocument) {
      const docId = next++;
      docs.set(docId, doc);
      return { docId, doc, readMs: 0 };
    },
    async save(docId: number, format: 'dxf' | 'dwg', version: string) {
      const doc = docs.get(docId)!;
      const r = format === 'dwg' ? writeDwg(doc, { version: version as never }) : writeDxf(doc, { version: version as never });
      return { data: r.data, warnings: r.warnings, ms: 0 };
    },
    closeDoc(docId: number) {
      docs.delete(docId);
    },
  };
}

type Pt = { x: number; y: number };
type Req =
  | { kind: 'point'; prompt: string; keywords: Keyword[]; base: Pt | null; allowText: boolean; preferNumber: boolean; resolve: (r: PointResult) => void; reject: (e: unknown) => void }
  | { kind: 'entity'; prompt: string; keywords: Keyword[]; resolve: (r: { handle: string; point: Pt } | { keyword: string } | { enter: true }) => void; reject: (e: unknown) => void }
  | { kind: 'select'; prompt: string; keywords: Keyword[]; remove: boolean; resolve: (r: { handles: string[] } | { keyword: string }) => void; reject: (e: unknown) => void };

export interface ScriptApp {
  app: App;
  st: DocState;
  doc: CadDocument;
  printed: { text: string; cls?: 'err' | 'res' }[];
  prompts: string[];
  /** 스크립트를 끝까지(또는 멈출 때까지) 실행한다 */
  script(text: string, name?: string): Promise<'idle' | 'paused'>;
  /** 출력 글(줄바꿈으로 이음) */
  out(): string;
  errors(): string[];
  add(e: Entity): Entity;
  model<T extends Entity['type']>(type: T): (Entity & { type: T } & Record<string, any>)[];
}

function distanceTo(doc: CadDocument, e: Entity, x: number, y: number): number {
  const p = entityPath(e);
  if (p && p.pieces.length) return pathNearest(p, { x, y }).d;
  const b = boundsOf([e], doc);
  if (!b) return Infinity;
  return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));
}

export function makeScriptApp(setup?: (doc: CadDocument) => void): ScriptApp {
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
  let request: Req | null = null;
  let running: string | null = null;
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
    ...fakePolySelect(doc, space),
    geometryOf: (list: Entity[]) => ({ segs: list.length ? [0, 0, 1, 1] : [] }),
    box(h: string) {
      const e = doc.entityIndex.get(h);
      return e ? (boundsOf([e], doc) ?? undefined) : undefined;
    },
  };
  const print = (text: string, cls?: 'err' | 'res') => {
    cmd.onPrint?.(text, cls);
    printed.push({ text, cls });
  };
  const cmd = { print, acceptSpaces: false, onPrint: null as null | ((t: string, c?: 'err' | 'res') => void), input: { value: '' } };

  const findCommand = (name: string): Command | undefined => {
    const raw = name.trim().toUpperCase().replace(/^[_.']+/, '');
    const dash = commands.get(raw) ?? commands.get(aliases.get(raw) ?? '');
    if (dash) return dash;
    const n = raw.replace(/^-+/, '');
    return commands.get(n) ?? commands.get(aliases.get(n) ?? '');
  };

  const ask = <T>(make: (resolve: (v: T) => void, reject: (e: unknown) => void) => Req): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const r = make(
        (v) => {
          request = null;
          resolve(v);
        },
        reject,
      );
      prompts.push(r.prompt);
      request = r;
    });

  const selectAll = (): string[] => space().map((e) => e.handle);

  async function requestSelection(prompt: string, opt: { keywords?: Keyword[]; noPickfirst?: boolean }): Promise<string[]> {
    if (st.selection.size && !opt.noPickfirst) {
      const hs = [...st.selection];
      app.lastSelection = hs;
      return hs;
    }
    const kws: Keyword[] = [{ key: 'ALL', label: '전체' }, { key: 'P', label: '이전' }, { key: 'L', label: '마지막' }, { key: 'R', label: '제거' }, { key: 'A', label: '추가' }, ...(opt.keywords ?? [])];
    for (const m of SELECT_METHODS) if (!kws.some((x) => x.key === m.key)) kws.push(m);
    for (;;) {
      const r = await ask<{ handles: string[] } | { keyword: string }>((resolve, reject) => ({ kind: 'select', prompt, keywords: kws, remove: false, resolve, reject }));
      if ('handles' in r) {
        app.lastSelection = r.handles;
        st.selection.clear();
        return r.handles;
      }
      const k = r.keyword.toUpperCase();
      if (k === 'ALL') for (const h of selectAll()) st.selection.add(h);
      else if (k === 'P') for (const h of app.lastSelection) st.selection.add(h);
      else if (k === 'L') {
        const h = lastCreated.filter((x) => doc.entityIndex.has(x)).slice(-1)[0];
        if (h) st.selection.add(h);
      } else if (opt.keywords?.some((x) => x.key.toUpperCase() === k)) return Promise.reject(Object.assign(new Error('keyword'), { keyword: k }));
      else {
        const m = selectMethodOf(k);
        if (m) {
          const getPoint = (prompt: string, o: { base?: Pt | null; keywords?: Keyword[] }) =>
            ask<PointResult>((resolve, reject) => ({ kind: 'point', prompt, keywords: o.keywords ?? [], base: o.base ?? null, allowText: false, preferNumber: false, resolve, reject }));
          const hs = await runSelectMethod(m, { getPoint, print }, picker);
          if (hs) for (const h of hs) st.selection.add(h);
          if (hs) print(`${hs.length}개를 찾음`);
        }
      }
    }
  }

  function onInput(text: string): void {
    const r = request;
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
      if (t.startsWith("'")) {
        void run(t.slice(1));
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
    if (request) {
      const r = request;
      request = null;
      r.reject(new CancelError());
    } else running = null;
  }

  async function run(name: string, arg?: string): Promise<void> {
    const c = findCommand(name);
    if (!c) {
      print(`알 수 없는 명령 "${name}". 도움말은 F1을 누르십시오.`, 'err');
      return;
    }
    if (running && !c.transparent) cancel();
    const nested = !!running && !!c.transparent;
    const saved = nested ? request : null;
    if (nested) request = null;
    if (!nested) running = c.name;
    print(`명령: ${c.name}`);
    const ctx: CommandContext = {
      app,
      print,
      group: ++serial,
      getPoint: (prompt, opt = {}) =>
        ask<PointResult>((resolve, reject) => ({
          kind: 'point',
          prompt,
          keywords: opt.keywords ?? [],
          base: opt.base ?? null,
          allowText: !!opt.allowText || !!opt.preferNumber,
          preferNumber: !!opt.preferNumber,
          resolve,
          reject,
        })),
      getEntity: (prompt, kws) => ask((resolve, reject) => ({ kind: 'entity', prompt, keywords: kws ?? [], resolve, reject })),
      getSelection: (prompt, opt) => requestSelection(prompt ?? '객체 선택:', opt ?? {}),
    };
    try {
      await c.run(ctx, arg);
    } catch (e) {
      if (e instanceof CancelError) print('*취소*');
      else print(`오류: ${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      if (nested) request = saved;
      else {
        if (running === c.name) running = null;
        request = null;
      }
    }
  }

  const app = {
    active: st,
    docs: [st],
    commands,
    lastCreated,
    lastSelection: [] as string[],
    imageKeys: new Set<string>(),
    register(c: Command) {
      commands.set(c.name.toUpperCase(), c);
      for (const a of c.aliases ?? []) aliases.set(a.toUpperCase(), c.name.toUpperCase());
    },
    findCommand,
    picker: () => picker,
    view: { overlay: { pickbox: 5, snap: null, ghost: [], rubber: [], marks: [] }, pixelSize: () => 0.01, requestOverlay() {}, requestRender() {} },
    cmd,
    ui: { setBusy() {}, refreshPalette() {}, refreshStatus() {}, refreshLayouts() {}, refreshTabs() {} },
    edits: { flush: async () => {} },
    engine: fakeEngine(),
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
      return running;
    },
    get pendingInput() {
      return request;
    },
    submitInput: onInput,
    run,
    cancel,
  } as unknown as App;
  (app as unknown as { aliases: Map<string, string> }).aliases = aliases;

  const h: ScriptApp = {
    app,
    st,
    doc,
    printed,
    prompts,
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
  };
  return h;
}
