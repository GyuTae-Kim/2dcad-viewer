/**
 * AutoLISP 부분 집합의 App 연결과 명령.
 * - 명령행: "(…)"를 입력하면 평가해 결과를 찍는다. 명령이 입력을 기다릴 때는 그 값이 입력이 된다(점 목록은 "x,y").
 *   "!변수"는 그 값. 괄호가 닫히지 않으면 "(_>" 프롬프트로 이어 받는다(공백은 글자). Esc는 평가를 멈춘다.
 * - (defun c:이름 …)은 그 이름의 명령이 된다. 같은 이름의 명령이 있으면 사용자 정의가 먼저이고 알린다.
 * - APPLOAD(AP): .lsp 파일(UTF-8·UTF-16·CP949)을 골라 평가한다. (load "이름")은 이 세션에 연 파일만 이름으로 찾는다.
 * - 스크립트: 스크립트 실행기가 AutoLISP 식을 이 입력으로 넘기고 평가가 끝나기를 기다린다(get*는 스크립트의 다음 입력을 받는다).
 * - 최상위 평가 하나(C: 명령 하나)의 편집은 명령 취소 한 번으로 되돌린다.
 * 평가기는 src/edit/lisp(화면·DOM 없음), App 연결 함수는 lisp-host.ts.
 */
import type { App, Command } from './app';
import { createInterp, type Interp, type LispHost, type Outcome } from '../edit/lisp';
import { EOF, LispReader, lispExtent } from '../edit/lisp/reader';
import type { Value } from '../edit/lisp/types';
import { decodeScript } from '../edit/script/reader';
import { type HostState, makeHost, supply } from './lisp-host';
import { pickFiles } from './drawingfiles';
import { sessionFile } from './sessionfiles';
import { fileNameMode, linkLisp } from './script';

/** 입력 고리 이름(App.inputFilters) */
const HOOK = 'autolisp';

class LispSession implements HostState {
  readonly it: Interp;
  readonly host: LispHost;
  /** 최상위 평가 중(0 또는 1) */
  depth = 0;
  /** 곧 시작할 평가(C: 명령·APPLOAD) */
  pending = 0;
  waitingFor: unknown = null;
  feeding = false;
  transparent = false;
  /** 닫히지 않은 식(여러 줄 입력) */
  private buffer: string | null = null;
  private bufferFor: unknown = null;
  private ctrl: AbortController | null = null;
  /** 이 세션에 읽은 .lsp(이름 소문자 → 글) */
  readonly loaded = new Map<string, { name: string; text: string }>();
  /** (defun c:…)로 만든 명령 */
  readonly commands = new Set<string>();
  /** AutoLISP 명령이 가린 원래 명령 */
  readonly overridden = new Map<string, Command>();

  constructor(readonly app: App) {
    this.host = makeHost(app, this);
    this.it = createInterp(this.host, {
      print: (t, cls) => app.cmd.print(t, cls),
      pause: () => new Promise((r) => setTimeout(r, 0)),
    });
  }

  signal(): AbortSignal {
    this.ctrl ??= new AbortController();
    return this.ctrl.signal;
  }

  /** 평가 중이고 사용자 입력을 기다리지 않는다(스크립트가 기다려야 한다) */
  get busy(): boolean {
    if (!this.running) return false;
    return !(this.waitingFor !== null && this.app.pendingInput === this.waitingFor);
  }

  get running(): boolean {
    return this.depth > 0 || this.pending > 0;
  }

  // ------------------------------------------------------------------ 명령행 입력

  /** 명령행 입력 고리. 처리했으면 true */
  input(text: string): boolean {
    if (this.feeding) return false;
    const app = this.app;
    if (this.buffer !== null) {
      this.buffer += `\n${text}`;
      if (lispExtent(this.buffer, 0) >= 0) {
        const t = this.buffer;
        const pending = this.bufferFor;
        this.endBuffer();
        this.submit(t, pending === app.pendingInput ? app.pendingInput : null);
      }
      return true;
    }
    const pending = app.pendingInput;
    // 글 입력(공백을 받는 프롬프트)의 괄호·느낌표는 글자다
    if (pending && app.cmd.acceptSpaces) return false;
    const t = text.trim();
    // ".이름": AutoLISP 명령이 가린 원래 명령
    if (!pending && /^[_]*\./.test(t) && this.commands.has(t.replace(/^[_.]+/, '').toUpperCase())) {
      this.runBuiltin(t);
      return true;
    }
    if (t.startsWith('(')) {
      if (lispExtent(t, 0) < 0) {
        this.buffer = t;
        this.bufferFor = pending;
        app.cmd.lispContinue = true;
        app.cmd.setPrompt('(_>');
        return true;
      }
      this.submit(t, pending);
      return true;
    }
    if (t.length > 1 && t.startsWith('!')) {
      this.submit(t.slice(1), pending, true);
      return true;
    }
    return false;
  }

  /** 여러 줄 입력을 끝낸다(Esc면 버린다) */
  endBuffer(): void {
    if (this.buffer === null) return;
    this.buffer = null;
    this.bufferFor = null;
    const app = this.app;
    app.cmd.lispContinue = false;
    const pend = app.pendingInput;
    const ai = app as unknown as { promptOf?: (r: unknown) => string };
    app.cmd.setPrompt(pend && ai.promptOf ? ai.promptOf.call(app, pend) : '');
  }

  get continuing(): boolean {
    return this.buffer !== null;
  }

  /** 식 글 하나를 평가한다(pending이 있으면 결과를 그 프롬프트의 입력으로) */
  submit(text: string, pending: unknown, bang = false): void {
    const app = this.app;
    if (this.running) {
      app.cmd.print('AutoLISP를 다시 시작할 수 없습니다: 다른 AutoLISP 식이 실행 중입니다.', 'err');
      return;
    }
    const p = pending as { prompt?: string } | null;
    app.cmd.print(p ? `${p.prompt ?? ''} ${bang ? '!' : ''}${text}`.trim() : `명령: ${bang ? '!' : ''}${text}`);
    // 한 줄에 식이 여럿이면 차례로(명령행에서 식마다 Enter를 친 것처럼)
    const forms: Value[] = [];
    try {
      const r = new LispReader(text, this.it.syms);
      for (let f = r.read(); f !== EOF; f = r.read()) forms.push(f);
    } catch (e) {
      app.cmd.print(`; 오류: ${e instanceof Error ? e.message : String(e)}`, 'err');
      return;
    }
    void this.evaluate(forms, p);
  }

  private async evaluate(forms: Value[], pending: unknown): Promise<void> {
    const app = this.app;
    const it = this.it;
    let value: Value = null;
    const o = await this.run('AutoLISP', !!pending, async () => {
      for (let i = 0; i < forms.length; i++) {
        const r = await it.evaluate(forms[i]!);
        if (!r.ok) return r;
        value = r.value;
        // 명령행: 식마다 결과를 찍는다(프롬프트의 입력이면 마지막 값을 넣는다)
        if (!pending || i < forms.length - 1) it.echo(r.value);
      }
      return { ok: true, value };
    });
    if (!o.ok || !pending) return;
    if (app.pendingInput === pending) {
      if (value === null) {
        it.echo(null);
        return;
      }
      it.flush();
      const err = supply(app, this, value);
      if (err) app.cmd.print(err, 'err');
    } else it.echo(value);
  }

  /** 최상위 평가(편집은 명령 취소 한 번으로 묶는다) */
  async run(label: string, transparent: boolean, fn: () => Promise<Outcome>): Promise<Outcome> {
    const app = this.app;
    const st = app.active;
    const mark = st && !transparent ? { session: st.session, depth: st.session.depth } : null;
    this.depth++;
    this.transparent = transparent;
    this.ctrl = new AbortController();
    try {
      return await fn();
    } finally {
      this.depth--;
      this.transparent = false;
      this.ctrl = null;
      if (mark && app.docs.some((d) => d.session === mark.session)) mark.session.squashUndo(mark.depth, label);
    }
  }

  /** 지금 명령이 끝난 뒤 평가를 시작한다(C: 명령·APPLOAD) */
  later(fn: () => Promise<unknown>): void {
    this.pending++;
    setTimeout(() => {
      this.pending--;
      void fn();
    }, 0);
  }

  // ------------------------------------------------------------------ C: 명령

  defineCommand(name: string): void {
    const n = name.toUpperCase();
    const app = this.app;
    if (!this.commands.has(n)) {
      const existing = app.findCommand(n);
      if (existing) app.cmd.print(`참고: AutoLISP 명령 ${n}이(가) 같은 이름의 기존 명령(${existing.name})보다 먼저 실행됩니다. 원래 명령은 .${n}으로 부를 수 있습니다.`);
      const own = app.commands.get(n);
      if (own) this.overridden.set(n, own);
      this.commands.add(n);
    }
    const cmd: Command = {
      name: n,
      title: `AutoLISP 명령 C:${n}`,
      noDoc: true,
      run: () => this.startCommand(n),
    };
    app.register(cmd);
  }

  runBuiltin(name: string): void {
    const app = this.app;
    const key = name.trim().toUpperCase().replace(/^[_.']+/, '');
    const mine = this.commands.has(key) ? app.commands.get(key) : undefined;
    if (!mine) {
      void app.run(name);
      return;
    }
    // App.run은 처음에 이름을 찾으므로 그동안만 원래 명령(없으면 별칭)이 보이게 한다
    const orig = this.overridden.get(key);
    if (orig) app.commands.set(key, orig);
    else app.commands.delete(key);
    try {
      void app.run(name);
    } finally {
      app.commands.set(key, mine);
    }
  }

  private startCommand(n: string): void {
    const app = this.app;
    if (this.running) {
      app.cmd.print(`AutoLISP 명령 ${n}은(는) AutoLISP 식이 실행 중일 때 명령으로 부를 수 없습니다. (c:${n.toLowerCase()})처럼 함수로 부르십시오.`, 'err');
      return;
    }
    this.later(async () => {
      const fn = this.it.syms.find(`C:${n}`)?.value ?? null;
      if (fn === null) {
        app.cmd.print(`; 오류: 함수 정의 없음: C:${n}`, 'err');
        return;
      }
      const o = await this.run(`C:${n}`, false, () => this.it.callFunction(fn, []));
      if (o.ok) this.it.echo(o.value);
    });
  }

  // ------------------------------------------------------------------ 파일

  remember(name: string, text: string): void {
    this.loaded.set(name.replace(/^.*[\\/]/, '').toLowerCase(), { name, text });
  }

  async findFile(name: string): Promise<{ name: string; text: string } | null> {
    const k = name.trim().replace(/^"|"$/g, '').replace(/^.*[\\/]/, '').toLowerCase();
    const hit = this.loaded.get(k) ?? this.loaded.get(`${k}.lsp`) ?? this.loaded.get(`${k}.mnl`);
    if (hit) return hit;
    const blob = sessionFile(k) ?? sessionFile(`${k}.lsp`);
    if (!blob) return null;
    const { text } = decodeScript(new Uint8Array(await blob.arrayBuffer()));
    const fname = sessionFile(k) ? k : `${k}.lsp`;
    this.remember(fname, text);
    return { name: fname, text };
  }

  /** .lsp 글을 평가한다(지금 다른 평가가 없을 때) */
  async loadText(name: string, text: string): Promise<boolean> {
    const app = this.app;
    if (this.depth > 0) {
      app.cmd.print(`"${name}": 다른 AutoLISP 식이 실행 중이어서 로드할 수 없습니다.`, 'err');
      return false;
    }
    const o = await this.run(`APPLOAD ${name}`, false, () => this.it.evalText(text));
    this.it.flush();
    if (o.ok) app.cmd.print(`"${name}"을(를) 로드했습니다.`);
    else app.cmd.print(`"${name}"을(를) 로드하다가 멈췄습니다.`, 'err');
    return o.ok;
  }
}

const sessions = new WeakMap<App, LispSession>();

/** App의 AutoLISP 세션 */
export function lispSession(app: App): LispSession {
  let s = sessions.get(app);
  if (!s) {
    s = new LispSession(app);
    sessions.set(app, s);
  }
  return s;
}

/** AutoLISP가 평가 중이고 사용자 입력을 기다리지 않는가(스크립트 실행기가 기다린다) */
export function lispBusy(app: App): boolean {
  return sessions.get(app)?.busy ?? false;
}

/** .lsp 파일을 읽어 평가한다(파일 끌어 놓기 등). 지금 명령이 끝난 뒤 시작한다 */
export async function loadLispFile(app: App, file: Blob & { name?: string }, name = file.name ?? 'untitled.lsp'): Promise<void> {
  const s = lispSession(app);
  const { text, encoding } = decodeScript(new Uint8Array(await file.arrayBuffer()));
  s.remember(name, text);
  if (encoding === 'cp949') app.cmd.print(`참고: "${name}"은(는) CP949(한국어 Windows) 인코딩으로 읽었습니다.`);
  await new Promise<void>((resolve) => s.later(() => s.loadText(name, text).then(() => resolve())));
}

type InputHook = { readonly name: string; input(text: string, pending: unknown): boolean };

const installed = new WeakSet<App>();

export function registerLispCommands(app: App): void {
  if (installed.has(app)) return;
  installed.add(app);
  const s = lispSession(app);
  // 명령행 입력 고리: App.inputFilters가 있으면 거기에, 없으면 입력 처리를 감싼다
  const filters = (app as unknown as { inputFilters?: InputHook[] }).inputFilters;
  if (filters) {
    if (!filters.some((f) => f.name === HOOK)) filters.push({ name: HOOK, input: (t) => s.input(t) });
  } else {
    const pi = app as unknown as { onInput: (t: string) => void; __lispHooked?: boolean };
    if (!pi.__lispHooked) {
      const prev = pi.onInput.bind(app);
      pi.onInput = (t: string) => {
        if (!s.input(t)) prev(t);
      };
      pi.__lispHooked = true;
    }
  }
  linkLisp({ busy: (a) => lispBusy(a), available: (a) => sessions.has(a) });
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Escape') return;
        if (s.continuing) s.endBuffer();
        if (s.running) s.it.cancel();
      },
      true,
    );
  }

  const taken = (n: string) => !!app.findCommand(n);
  app.register({
    name: 'APPLOAD',
    aliases: taken('AP') ? [] : ['AP'],
    title: 'AutoLISP 파일 로드',
    noDoc: true,
    async run(ctx) {
      if (fileNameMode(app)) {
        const r = await ctx.getPoint('로드할 AutoLISP 파일 이름 입력:', { allowText: true });
        if (!('text' in r)) return;
        const f = await s.findFile(r.text);
        if (!f) {
          ctx.print(`파일 "${r.text.trim()}"을(를) 찾을 수 없습니다. 이 웹 버전은 경로로 파일을 열 수 없어 이번 세션에서 연 파일만 이름으로 로드합니다.`, 'err');
          return;
        }
        s.later(() => s.loadText(f.name, f.text));
        return;
      }
      const files = await pickFiles('.lsp,.LSP,.mnl,.MNL', true);
      const items: { name: string; text: string }[] = [];
      for (const f of files) {
        const { text, encoding } = decodeScript(new Uint8Array(await f.arrayBuffer()));
        if (encoding === 'cp949') ctx.print(`참고: "${f.name}"은(는) CP949(한국어 Windows) 인코딩으로 읽었습니다.`);
        s.remember(f.name, text);
        items.push({ name: f.name, text });
      }
      if (!items.length) return;
      s.later(async () => {
        for (const x of items) if (!(await s.loadText(x.name, x.text))) break;
      });
    },
  });
}
