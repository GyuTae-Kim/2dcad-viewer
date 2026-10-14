/**
 * 앱 컨트롤러: 문서·화면·명령·선택·스냅을 묶는다.
 */
import type { Entity } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { errorMessage } from '../core/errors';
import type { CadErrorCode } from '../core/errors';
import { formatLength } from '../core/units';
import { OutlineLibrary } from '../text/fonts';
import { TextEngine } from '../text/layout';
import { collectTextUsage } from '../text/collect';
import { EngineClient, EngineError, type OpenResult } from './engine';
import { DocState } from './docstate';
import { CadView, type OverlayGeom, type Pt, type SnapKind } from './view';
import { CommandLine, parsePointInput } from './commandline';
import { Picker } from './pick';
import { DEFAULT_SNAPS, SNAP_NAMES, findSnap } from './snap';
import { type Acquired, type TrackResult, objectTrack, polarAngles, polarTrack } from './tracking';
import { gripPoints } from '../edit/geom';
import { spaceTolerance } from '../render/build';
import { ask, closeMenu, showMenu, toast } from './ui/dom';
import { EditManager } from './edits';
import { OverlayScene } from './scene';
import type { EditOp } from '../edit/session';

export class CancelError extends Error {
  constructor() {
    super('취소');
  }
}

export interface Keyword {
  key: string;
  label: string;
}

export type PointResult = { point: Pt } | { keyword: string } | { text: string } | { enter: true };

interface PointRequest {
  kind: 'point';
  prompt: string;
  base: Pt | null;
  keywords: Keyword[];
  rubber?: (p: Pt) => { pts: number[]; closed?: boolean; fill?: boolean; dashed?: boolean }[];
  ghost?: (p: Pt) => OverlayGeom[];
  allowText: boolean;
  /** 숫자만 입력하면 직접 거리 입력 대신 문자로 돌려준다(각도·축척 입력) */
  preferNumber: boolean;
  resolve: (r: PointResult) => void;
  reject: (e: unknown) => void;
}

interface EntityRequest {
  kind: 'entity';
  prompt: string;
  keywords: Keyword[];
  resolve: (r: { handle: string; point: Pt } | { keyword: string } | { enter: true }) => void;
  reject: (e: unknown) => void;
}

interface SelectRequest {
  kind: 'select';
  prompt: string;
  keywords: Keyword[];
  remove: boolean;
  resolve: (r: { handles: string[] } | { keyword: string }) => void;
  reject: (e: unknown) => void;
}

type Request = PointRequest | EntityRequest | SelectRequest;

export interface CommandContext {
  app: App;
  print(text: string, cls?: 'err' | 'res'): void;
  getPoint(prompt: string, opt?: { base?: Pt | null; keywords?: Keyword[]; rubber?: PointRequest['rubber']; ghost?: PointRequest['ghost']; allowText?: boolean; preferNumber?: boolean }): Promise<PointResult>;
  getEntity(prompt: string, keywords?: Keyword[]): Promise<{ handle: string; point: Pt } | { keyword: string } | { enter: true }>;
  /** 객체 고르기(이미 고른 것이 있으면 그것). 빈 배열이면 아무것도 고르지 않음 */
  getSelection(prompt?: string, opt?: { keywords?: Keyword[]; noPickfirst?: boolean }): Promise<string[]>;
  /** 명령 안의 여러 단계를 한 번의 명령 취소로 묶는 번호 */
  group: number;
}

export interface Command {
  name: string;
  aliases?: string[];
  title: string;
  /** 다른 명령 중에도 실행(ZOOM 같은 투명 명령) */
  transparent?: boolean;
  /** 열린 도면이 없어도 실행 */
  noDoc?: boolean;
  run(ctx: CommandContext, arg?: string): Promise<void> | void;
}

export interface UiHooks {
  refreshTabs(): void;
  refreshLayouts(): void;
  refreshStatus(): void;
  refreshPalette(): void;
  showStart(show: boolean): void;
  setBusy(text: string | null, fraction?: number): void;
  setCoords(text: string): void;
  openPalette(tab: string): void;
}

export class App {
  readonly engine: EngineClient;
  readonly view: CadView;
  readonly cmd: CommandLine;
  readonly fontLib: OutlineLibrary;
  readonly text: TextEngine;
  readonly docs: DocState[] = [];
  active: DocState | null = null;
  readonly edits: EditManager;
  ui!: UiHooks;
  readonly commands = new Map<string, Command>();
  private readonly aliases = new Map<string, string>();
  osnapOn = true;
  readonly snapModes = new Set<SnapKind>(DEFAULT_SNAPS);
  orthoOn = false;
  /** 극좌표 추적(F10)과 증분 각도 */
  polarOn = false;
  polarInc = Math.PI / 2;
  /** 객체 스냅 추적(F11)과 획득점 */
  otrackOn = false;
  private acquired: Acquired[] = [];
  private acqCandidate: { p: Pt; timer: number } | null = null;
  private request: Request | null = null;
  private running: { name: string; ctrl: AbortController } | null = null;
  private lastCommand: string | null = null;
  private groupSerial = 0;
  /** 직전 선택(P 옵션) */
  lastSelection: string[] = [];
  lastPoint: Pt | null = null;
  private cursorWorld: Pt | null = null;
  private windowStart: { screen: Pt; world: Pt; viaClick: boolean } | null = null;
  private pickers = new Map<string, Picker>();
  private hoverHandle: string | null = null;
  private hoverTimer = 0;
  private readonly fontsReady = new WeakMap<DocState, Promise<void>>();

  constructor(drawingParent: HTMLElement) {
    const fontBase = new URL('fonts/noto-sans-kr/', document.baseURI).href;
    this.engine = new EngineClient(fontBase);
    this.fontLib = new OutlineLibrary(fontBase);
    this.text = new TextEngine(this.fontLib);
    this.view = new CadView(drawingParent);
    this.edits = new EditManager(this);
    this.cmd = new CommandLine(drawingParent, {
      submit: (t) => this.onInput(t),
      cancel: () => this.cancel(),
      suggest: (p) => this.suggest(p),
      keyword: (k) => this.onInput(k),
      repeat: () => {
        if (this.lastCommand) void this.run(this.lastCommand);
      },
    });
    this.view.on({
      move: (w, s, ev) => this.onMove(w, s, ev),
      down: () => {},
      click: (w, s, ev) => this.onClick(w, s, ev),
      drag: (a, b, done, ev) => this.onDrag(a, b, done, ev),
      context: (w, s, ev) => this.onContext(w, s, ev),
      dblclick: (w, s) => this.onDblClick(w, s),
      leave: () => {
        this.ui.setCoords('');
      },
      viewChanged: () => {
        this.refreshSelectionOverlay();
        this.ui?.refreshStatus();
        this.scheduleDetail();
      },
    });
    this.view.onRestore = () => {
      for (const d of this.docs) for (const sc of d.scenes.values()) sc.reupload(this.view.renderer);
    };
    window.addEventListener('keydown', (ev) => this.onKey(ev));
    window.addEventListener('beforeunload', (ev) => {
      if (this.docs.some((d) => d.session?.dirty)) ev.preventDefault();
    });
  }

  // -------------------------------------------------------------------------
  // 명령 등록·실행
  // -------------------------------------------------------------------------

  register(c: Command): void {
    this.commands.set(c.name.toUpperCase(), c);
    for (const a of c.aliases ?? []) this.aliases.set(a.toUpperCase(), c.name.toUpperCase());
  }

  findCommand(name: string): Command | undefined {
    const n = name.trim().toUpperCase().replace(/^[_.'-]+/, '');
    return this.commands.get(n) ?? this.commands.get(this.aliases.get(n) ?? '');
  }

  private suggest(prefix: string): { name: string; title: string }[] {
    const p = prefix.toUpperCase().replace(/^[_.'-]+/, '');
    const out: { name: string; title: string; score: number }[] = [];
    const seen = new Set<string>();
    for (const [a, n] of this.aliases) {
      if (a.startsWith(p)) {
        const c = this.commands.get(n)!;
        out.push({ name: a, title: `${c.name} · ${c.title}`, score: a === p ? 0 : 1 + a.length });
      }
    }
    for (const c of this.commands.values()) {
      const n = c.name.toUpperCase();
      if ((n.startsWith(p) || c.title.includes(prefix)) && !seen.has(n)) {
        seen.add(n);
        out.push({ name: c.name, title: c.title, score: n === p ? 0 : 2 + n.length });
      }
    }
    return out.sort((a, b) => a.score - b.score);
  }

  /** 명령 실행. arg가 있으면 첫 프롬프트의 답으로 쓴다 */
  async run(name: string, arg?: string): Promise<void> {
    const c = this.findCommand(name);
    if (!c) {
      this.cmd.print(`알 수 없는 명령 "${name}". 도움말은 F1을 누르십시오.`, 'err');
      return;
    }
    if (!c.noDoc && !this.active) {
      this.cmd.print('열린 도면이 없습니다. 먼저 파일을 여십시오.', 'err');
      return;
    }
    if (this.running && !c.transparent) this.cancel(true);
    const nested = this.running && c.transparent;
    const saved = nested ? this.request : null;
    if (nested) this.request = null;
    const ctrl = new AbortController();
    if (!nested) this.running = { name: c.name, ctrl };
    this.lastCommand = c.name;
    this.cmd.print(`명령: ${c.name}`);
    this.clearHover();
    const ctx: CommandContext = {
      app: this,
      print: (t, cls) => this.cmd.print(t, cls),
      getPoint: (prompt, opt) => this.requestPoint(prompt, opt, ctrl.signal),
      getEntity: (prompt, kws) => this.requestEntity(prompt, kws ?? [], ctrl.signal),
      getSelection: (prompt, opt) => this.requestSelection(prompt ?? '객체 선택:', opt ?? {}, ctrl.signal),
      group: ++this.groupSerial,
    };
    try {
      await c.run(ctx, arg);
    } catch (e) {
      if (e instanceof CancelError) this.cmd.print('*취소*');
      else {
        console.error(e);
        this.cmd.print(`오류: ${e instanceof Error ? e.message : String(e)}`, 'err');
      }
    } finally {
      if (nested) {
        this.request = saved;
        if (saved) this.cmd.setPrompt(this.promptOf(saved));
      } else {
        if (this.running?.ctrl === ctrl) this.running = null;
        this.request = null;
        this.cmd.setPrompt('');
        this.view.overlay.rubber = [];
        this.view.overlay.ghost = [];
        this.view.overlay.marks = [];
        this.view.overlay.hotGrip = null;
        this.clearTracking();
        this.view.overlay.tip = null;
        this.view.requestOverlay();
      }
    }
  }

  get busyCommand(): string | null {
    return this.running?.name ?? null;
  }

  cancel(silent = false): void {
    if (this.request) {
      const r = this.request;
      this.request = null;
      r.reject(new CancelError());
    } else if (this.running) {
      this.running.ctrl.abort();
      this.running = null;
      if (!silent) this.cmd.print('*취소*');
    } else if (this.windowStart) {
      this.windowStart = null;
      this.view.overlay.windowRect = null;
      this.view.requestOverlay();
    } else if (this.active && this.active.selection.size) {
      this.clearSelection();
    }
    this.cmd.setPrompt('');
  }

  private promptOf(r: Request): string {
    if (!r.keywords.length) return r.prompt;
    if (r.prompt.includes('[')) return r.prompt;
    const kw = r.keywords.map((k) => `${k.label}(${k.key})`).join('/');
    return r.prompt.replace(/:$/, '') + ` [${kw}]:`;
  }

  private requestPoint(prompt: string, opt: Parameters<CommandContext['getPoint']>[1] = {}, signal: AbortSignal): Promise<PointResult> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CancelError());
      const req: PointRequest = {
        kind: 'point',
        prompt,
        base: opt.base ?? null,
        keywords: opt.keywords ?? [],
        rubber: opt.rubber,
        ghost: opt.ghost,
        allowText: !!opt.allowText || !!opt.preferNumber,
        preferNumber: !!opt.preferNumber,
        resolve: (r) => {
          this.request = null;
          resolve(r);
        },
        reject,
      };
      this.request = req;
      this.cmd.setPrompt(this.promptOf(req));
      this.view.overlay.tip = prompt.replace(/\[.*$/, '').replace(/:\s*$/, '');
      signal.addEventListener('abort', () => reject(new CancelError()), { once: true });
      this.view.requestOverlay();
    });
  }

  private async requestSelection(prompt: string, opt: { keywords?: Keyword[]; noPickfirst?: boolean }, signal: AbortSignal): Promise<string[]> {
    const st = this.active;
    if (!st) return [];
    if (st.selection.size && !opt.noPickfirst) {
      const hs = [...st.selection];
      this.lastSelection = hs;
      return hs;
    }
    const kws: Keyword[] = [
      { key: 'ALL', label: '전체' },
      { key: 'P', label: '이전' },
      { key: 'L', label: '마지막' },
      { key: 'R', label: '제거' },
      { key: 'A', label: '추가' },
      ...(opt.keywords ?? []),
    ];
    for (;;) {
      const r = await new Promise<{ handles: string[] } | { keyword: string }>((resolve, reject) => {
        if (signal.aborted) return reject(new CancelError());
        const req: SelectRequest = {
          kind: 'select',
          prompt,
          keywords: kws,
          remove: false,
          resolve: (x) => {
            this.request = null;
            resolve(x);
          },
          reject,
        };
        this.request = req;
        this.cmd.setPrompt(prompt);
        this.view.overlay.tip = prompt.replace(/:\s*$/, '');
        signal.addEventListener('abort', () => reject(new CancelError()), { once: true });
        this.view.requestOverlay();
      });
      if ('handles' in r) {
        this.lastSelection = r.handles;
        return r.handles;
      }
      const k = r.keyword.toUpperCase();
      if (k === 'ALL') {
        const scene = st.scenes.get(st.space);
        const hs = (scene?.entities ?? []).map((b) => b.handle).filter((h) => {
          const e = st.doc.entityIndex.get(h);
          const l = e ? st.layers.get(tableKey(e.layer)) : undefined;
          return !!e && (!l || (l.on && !l.frozen));
        });
        const ed = st.edits.get(st.space);
        for (const b of ed?.overlay?.entities ?? []) if (!hs.includes(b.handle)) hs.push(b.handle);
        this.setSelection(hs.filter((h) => !ed?.hidden.has(h) || ed.live.has(h)), 'add');
        this.cmd.print(`${st.selection.size}개를 찾음`);
      } else if (k === 'P') this.setSelection(this.lastSelection.filter((h) => st.doc.entityIndex.has(h)), 'add');
      else if (k === 'L') {
        const last = this.lastCreated.filter((h) => st.doc.entityIndex.has(h)).slice(-1);
        this.setSelection(last, 'add');
      } else if (opt.keywords?.some((x) => x.key.toUpperCase() === k)) return Promise.reject(Object.assign(new Error('keyword'), { keyword: k }));
    }
  }

  /** 마지막으로 만든 객체(L 옵션) */
  lastCreated: string[] = [];
  /** 파일이 연결된 래스터 이미지(열쇠 = 파일 이름 소문자) */
  readonly imageKeys = new Set<string>();
  /** 선택한 객체의 그립(화면에 보이는 것) */
  gripList: { handle: string; id: string; point: Pt }[] = [];
  /** 누른 그립(GRIPEDIT 명령이 쓴다) */
  hotGrip: { point: Pt; items: { handle: string; id: string }[] } | null = null;
  /** 파일을 연 뒤(빠진 글꼴 안내 등) */
  onOpened: ((st: DocState) => void) | null = null;

  private requestEntity(prompt: string, keywords: Keyword[], signal: AbortSignal): Promise<{ handle: string; point: Pt } | { keyword: string } | { enter: true }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CancelError());
      const req: EntityRequest = {
        kind: 'entity',
        prompt,
        keywords,
        resolve: (r) => {
          this.request = null;
          resolve(r);
        },
        reject,
      };
      this.request = req;
      this.cmd.setPrompt(this.promptOf(req));
      this.view.overlay.tip = prompt.replace(/\[.*$/, '').replace(/:\s*$/, '');
      signal.addEventListener('abort', () => reject(new CancelError()), { once: true });
      this.view.requestOverlay();
    });
  }

  /** 명령행 입력 */
  private onInput(text: string): void {
    const r = this.request;
    if (!r) {
      if (!text) return;
      // 투명 명령 접두사 '
      void this.run(text);
      return;
    }
    const t = text.trim();
    if (r.kind === 'select') {
      if (!t) {
        r.resolve({ handles: [...(this.active?.selection ?? [])] });
        return;
      }
      const up = t.toUpperCase();
      if (up === 'R' || up === 'REMOVE') {
        r.remove = true;
        this.cmd.setPrompt('객체 제거:');
        return;
      }
      if (up === 'A' || up === 'ADD') {
        r.remove = false;
        this.cmd.setPrompt(r.prompt);
        return;
      }
      const kw = r.keywords.find((k) => k.key.toUpperCase() === up || k.label === t);
      if (kw) {
        r.resolve({ keyword: kw.key });
        return;
      }
      this.cmd.print('객체를 고르거나 옵션(ALL·P·L·R)을 입력하십시오.', 'err');
      return;
    }
    if (!t) {
      r.resolve({ enter: true });
      return;
    }
    const up = t.toUpperCase();
    const kw = r.keywords.find((k) => k.key.toUpperCase() === up || k.label === t);
    if (kw) {
      this.cmd.print(`${this.promptOf(r)} ${t}`);
      r.resolve({ keyword: kw.key });
      return;
    }
    if (t.startsWith("'")) {
      void this.run(t.slice(1));
      return;
    }
    if (r.kind === 'point') {
      if (r.preferNumber && /^-?[\d.]+(?:e-?\d+)?$/i.test(t)) {
        this.cmd.print(`${this.promptOf(r)} ${t}`);
        r.resolve({ text: t });
        return;
      }
      const dir = this.cursorWorld && r.base ? { x: this.cursorWorld.x - r.base.x, y: this.cursorWorld.y - r.base.y } : null;
      const p = parsePointInput(t, r.base ?? this.lastPoint, dir);
      if (p) {
        this.cmd.print(`${this.promptOf(r)} ${t}`);
        this.lastPoint = p;
        r.resolve({ point: p });
        return;
      }
      if (r.allowText) {
        r.resolve({ text: t });
        return;
      }
      const tc = this.findCommand(t);
      if (tc?.transparent) {
        void this.run(t);
        return;
      }
      this.cmd.print('점이 올바르지 않습니다. 예: 100,50  @20,0  @30<45', 'err');
      return;
    }
    this.cmd.print('객체를 선택하거나 옵션을 입력하십시오.', 'err');
  }

  // -------------------------------------------------------------------------
  // 문서
  // -------------------------------------------------------------------------

  async openFile(name: string, data: ArrayBuffer): Promise<DocState | null> {
    const size = data.byteLength;
    this.ui.setBusy(`${name} 여는 중…`, 0);
    try {
      const res = await this.engine.open(name, data, (stage, f) => {
        const label = stage === 'read' ? '도면 읽는 중' : stage === 'fonts' ? '글꼴 받는 중' : stage === 'build' || stage === 'document' ? '화면 그리는 중' : '처리 중';
        this.ui.setBusy(`${label}…`, stage === 'read' ? f * 0.7 : stage === 'fonts' ? 0.75 : 0.85);
      });
      const st = this.addDocument(res, name, size);
      const w = st.warnings.filter((x) => x.code !== 'entity.not_drawn' || (x.count ?? 0) > 0);
      this.cmd.print(`${name}: ${res.doc.format.toUpperCase()} ${res.doc.version}, 객체 ${res.doc.entityIndex.size.toLocaleString()}개, 읽기 ${Math.round(res.readMs)}ms, 그리기 ${Math.round(res.model.ms)}ms`);
      for (const x of w.slice(0, 6)) this.cmd.print(`참고: ${x.message}${x.count ? ` (${x.count})` : ''}`);
      this.onOpened?.(st);
      return st;
    } catch (e) {
      const code = e instanceof EngineError ? e.code : 'internal';
      const msg = e instanceof EngineError && code !== 'internal' ? errorMessage(code as CadErrorCode) : `파일을 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
      toast(`${name}: ${msg}`, 'error', 7000);
      this.cmd.print(`${name}: ${msg}`, 'err');
      return null;
    } finally {
      this.ui.setBusy(null);
    }
  }

  /** 워커가 읽었거나 받아 둔 문서를 탭으로 연다 */
  addDocument(res: OpenResult, name: string, size: number): DocState {
    const st = new DocState(res.docId, res.doc, name, size, res.readMs);
    st.addScene(this.view.renderer, res.model, MODEL_SPACE);
    this.edits.attach(st);
    this.docs.push(st);
    this.activate(st);
    this.initialView(st);
    void this.loadFonts(st);
    return st;
  }

  private loadFonts(st: DocState): Promise<void> {
    let p = this.fontsReady.get(st);
    if (!p) {
      const usage = collectTextUsage(st.doc);
      p = usage.needsOutline ? Promise.all([this.fontLib.require(usage.codes), this.fontLib.requireLatin(usage.latin)]).then(() => undefined).catch(() => undefined) : Promise.resolve();
      p.then(() => this.pickers.clear());
      this.fontsReady.set(st, p);
    }
    return p;
  }

  /** 저장된 *Active 뷰가 범위와 겹치고 충분히 크면 그 화면, 아니면 전체 보기 */
  private initialView(st: DocState): void {
    const vp = st.doc.vports.find((v) => v.name.toUpperCase() === '*ACTIVE');
    const b = st.scenes.get(MODEL_SPACE)?.bounds;
    if (vp && b && vp.height > 0 && Number.isFinite(vp.center.x)) {
      const aspect = vp.aspect > 0 ? vp.aspect : this.view.width / this.view.height;
      const hw = (vp.height * aspect) / 2;
      const hh = vp.height / 2;
      const ext = Math.max(b.maxX - b.minX, b.maxY - b.minY);
      const overlaps = !(vp.center.x + hw < b.minX || vp.center.x - hw > b.maxX || vp.center.y + hh < b.minY || vp.center.y - hh > b.maxY);
      if (overlaps && vp.height >= ext * 0.02 && vp.height <= ext * 50) {
        this.view.zoomRect(vp.center.x - hw, vp.center.y - hh, vp.center.x + hw, vp.center.y + hh, false, 0);
        return;
      }
    }
    this.view.zoomExtents(false);
  }

  activate(st: DocState | null): void {
    this.cancel(true);
    this.active = st;
    this.view.setState(st);
    this.hoverHandle = null;
    this.ui.showStart(!st);
    this.ui.refreshTabs();
    this.ui.refreshLayouts();
    this.ui.refreshStatus();
    this.ui.refreshPalette();
    this.refreshSelectionOverlay();
    document.title = st ? `${st.name} - OpenCAD 2D 뷰어` : 'OpenCAD 2D 뷰어';
  }

  /** 문서 닫기(저장하지 않은 변경이 있으면 먼저 묻는다) */
  async close(st: DocState, force = false): Promise<boolean> {
    if (!force && st.session?.dirty) {
      const answer = await ask(`${st.saveName}`, '저장하지 않은 변경이 있습니다. 닫기 전에 저장할까요?', [
        { label: '저장', value: 'save', primary: true },
        { label: '저장 안 함', value: 'discard' },
        { label: '취소', value: 'cancel' },
      ]);
      if (answer === 'cancel' || answer === null) return false;
      if (answer === 'save') {
        this.activate(st);
        await this.run('QSAVE');
        if (st.session.dirty) return false;
      }
    }
    this.closeNow(st);
    return true;
  }

  private closeNow(st: DocState): void {
    const i = this.docs.indexOf(st);
    if (i < 0) return;
    this.docs.splice(i, 1);
    this.edits.detach(st);
    st.dispose(this.view.renderer);
    for (const k of [...this.pickers.keys()]) if (k.startsWith(`${st.docId}:`)) this.pickers.delete(k);
    if (this.active === st) this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    else this.ui.refreshTabs();
  }

  /** 공간 장면이 없으면 워커에서 그려 온다 */
  async ensureScene(st: DocState, space: string): Promise<void> {
    const key = tableKey(space);
    if (st.scenes.has(key)) return;
    let p = st.buildPending.get(key);
    if (!p) {
      this.ui.setBusy('배치 그리는 중…', 0.5);
      p = this.engine
        .build(st.docId, key)
        .then((msg) => {
          st.addScene(this.view.renderer, msg, key);
        })
        .finally(() => {
          st.buildPending.delete(key);
          this.ui.setBusy(null);
        });
      st.buildPending.set(key, p);
    }
    await p;
  }

  /** 모형·배치 전환 */
  async setSpace(space: string): Promise<void> {
    const st = this.active;
    if (!st) return;
    const key = tableKey(space);
    if (st.space === key) return;
    if (st.blockEdit) {
      await this.closeBlockEditor(true);
      if (st.space === key) return;
    }
    this.cancel(true);
    await this.ensureScene(st, key);
    st.space = key;
    st.selection.clear();
    this.view.setState(st);
    if (!st.cameras.has(key)) this.view.zoomExtents(false);
    this.ui.refreshLayouts();
    this.ui.refreshStatus();
    this.ui.refreshPalette();
    this.refreshSelectionOverlay();
  }

  // -------------------------------------------------------------------------
  // 깊이 확대: 보이는 영역을 지금 확대에 맞는 정밀도로 다시 나눈다(AutoCAD의 재생성과 같은 일)
  // -------------------------------------------------------------------------

  private detailTimer = 0;

  scheduleDetail(): void {
    clearTimeout(this.detailTimer);
    this.detailTimer = window.setTimeout(() => this.updateDetail(), 250);
  }

  private dropDetail(): void {
    const d = this.view.detail;
    if (!d) return;
    d.scene.dispose(this.view.renderer);
    this.view.detail = null;
    this.view.requestRender();
  }

  private updateDetail(): void {
    const st = this.active;
    if (!st || !st.isModel || !st.scenes.get(st.space)) return this.dropDetail();
    const cam = this.view.camera();
    // 기본 장면의 현-곡선 오차가 0.6픽셀을 넘을 때만
    if (spaceTolerance(st.doc, st.space) * cam.scale < 0.6) return this.dropDetail();
    const a = this.view.screenToWorld(0, this.view.height);
    const b = this.view.screenToWorld(this.view.width, 0);
    const vis: [number, number, number, number] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
    const d = this.view.detail;
    if (
      d &&
      d.docId === st.docId &&
      d.space === st.space &&
      d.gen === st.gen &&
      d.region[0] <= vis[0] &&
      d.region[1] <= vis[1] &&
      d.region[2] >= vis[2] &&
      d.region[3] >= vis[3] &&
      cam.scale <= d.scale * 1.5 &&
      cam.scale >= d.scale / 4
    )
      return;
    const pk = this.picker();
    if (!pk) return;
    const w = vis[2] - vis[0];
    const hgt = vis[3] - vis[1];
    const region: [number, number, number, number] = [vis[0] - w * 0.5, vis[1] - hgt * 0.5, vis[2] + w * 0.5, vis[3] + hgt * 0.5];
    const handles = pk.overlapping(region);
    if (handles.length > 30000) return this.dropDetail();
    const block = st.doc.blocks.get(st.space);
    if (!block) return;
    const want = new Set(handles);
    const list = block.entities.filter((e) => want.has(e.handle));
    const scene = new OverlayScene(this.view.renderer, st.doc, list, this.text, st.space, 0.3 / cam.scale, this.imageKeys);
    this.dropDetail();
    this.view.detail = { docId: st.docId, space: st.space, gen: st.gen, region, scale: cam.scale, scene };
    this.view.requestRender();
  }

  /** 블록 편집기 열기: 블록 정의를 공간처럼 열어 그리기·수정 명령으로 고친다 */
  async openBlockEditor(name: string): Promise<boolean> {
    const st = this.active;
    if (!st) return false;
    const key = tableKey(name);
    const blk = st.doc.blocks.get(key);
    if (!blk) return false;
    if (st.blockEdit) await this.closeBlockEditor(true);
    this.cancel(true);
    st.blockEdit = { name: blk.name, key, back: st.space, depth: st.session.depth };
    await this.ensureScene(st, key);
    st.space = key;
    st.selection.clear();
    this.view.setState(st);
    if (!st.cameras.has(key)) this.view.zoomExtents(false);
    this.ui.refreshLayouts();
    this.ui.refreshStatus();
    this.ui.refreshPalette();
    this.refreshSelectionOverlay();
    return true;
  }

  /** 블록 편집기 닫기. save가 거짓이면 연 뒤의 변경을 되돌린다 */
  async closeBlockEditor(save: boolean): Promise<void> {
    const st = this.active;
    const be = st?.blockEdit;
    if (!st || !be) return;
    this.cancel(true);
    if (!save) while (st.session.depth > be.depth && st.session.undo());
    await this.edits.flush(st);
    st.blockEdit = null;
    st.space = be.back;
    st.scenes.get(be.key)?.dispose(this.view.renderer);
    st.scenes.delete(be.key);
    st.edits.get(be.key)?.overlay?.dispose(this.view.renderer);
    st.edits.delete(be.key);
    st.cameras.delete(be.key);
    this.resetPicker(st, be.key);
    st.selection.clear();
    this.view.setState(st);
    this.ui.refreshLayouts();
    this.ui.refreshStatus();
    this.ui.refreshPalette();
    this.refreshSelectionOverlay();
  }

  picker(): Picker | null {
    const st = this.active;
    if (!st) return null;
    const scene = st.scenes.get(st.space);
    if (!scene) return null;
    const key = `${st.docId}:${st.space}`;
    let p = this.pickers.get(key);
    if (!p) {
      p = new Picker(st.doc, scene.entities, this.text, st.space);
      this.pickers.set(key, p);
      const ed = st.edits.get(st.space);
      if (ed) {
        for (const h of ed.hidden) p.exclude.add(h);
        p.extra = ed.overlay ? [...ed.overlay.entities] : [];
      }
    }
    return p;
  }

  /** 편집 뒤 고르기 상태(제외·추가 객체)를 맞춘다 */
  updatePicker(st: DocState, space: string, changed: Iterable<string>): void {
    const p = this.pickers.get(`${st.docId}:${space}`);
    if (!p) return;
    const ed = st.spaceEdits(space);
    p.exclude.clear();
    for (const h of ed.hidden) p.exclude.add(h);
    p.extra = ed.overlay ? [...ed.overlay.entities] : [];
    p.invalidate(changed);
  }

  resetPicker(st: DocState, space: string): void {
    this.pickers.delete(`${st.docId}:${space}`);
  }

  /** 변경을 한 번의 명령으로 적용한다(명령 취소 단위) */
  commit(label: string, ops: EditOp[]): void {
    const st = this.active;
    if (!st || !ops.length) return;
    st.session.commit({ label, ops });
  }

  entity(handle: string): Entity | undefined {
    return this.active?.doc.entityIndex.get(handle);
  }

  // -------------------------------------------------------------------------
  // 선택
  // -------------------------------------------------------------------------

  setSelection(handles: Iterable<string>, mode: 'replace' | 'add' | 'remove' = 'replace'): void {
    const st = this.active;
    if (!st) return;
    if (mode === 'replace') st.selection.clear();
    for (const h of handles) {
      if (mode === 'remove') st.selection.delete(h);
      else st.selection.add(h);
    }
    this.refreshSelectionOverlay();
    this.ui.refreshPalette();
    this.ui.refreshStatus();
  }

  clearSelection(): void {
    this.setSelection([], 'replace');
  }

  refreshSelectionOverlay(): void {
    const st = this.active;
    const o = this.view.overlay;
    o.selection = [];
    o.grips = [];
    this.gripList = [];
    if (st && st.selection.size) {
      const p = this.picker();
      if (p) {
        let n = 0;
        for (const h of st.selection) {
          if (n++ > 3000) break;
          o.selection.push(p.geometry(h));
        }
        if (st.selection.size <= 200) {
          // 객체별 그립(편집 커널): 누르면 그립 편집(신축·이동·회전·축척·대칭)
          for (const h of st.selection) {
            const e = st.doc.entityIndex.get(h);
            if (!e) continue;
            try {
              for (const g of gripPoints(e, st.doc)) this.gripList.push({ handle: h, id: g.id, point: g.point });
            } catch {
              /* 그립이 없는 객체 */
            }
            if (this.gripList.length > 2000) break;
          }
          o.grips = this.gripList.map((g) => g.point);
        }
      }
    }
    this.view.requestOverlay();
  }

  private clearHover(): void {
    if (this.hoverHandle) {
      this.hoverHandle = null;
      this.view.overlay.hover = null;
      this.view.requestOverlay();
    }
  }

  // -------------------------------------------------------------------------
  // 화면 입력
  // -------------------------------------------------------------------------

  /** 스냅·추적·직교를 적용한 점 */
  private resolvePoint(w: Pt): { p: Pt; snap: { p: Pt; kind: SnapKind } | null; track?: TrackResult } {
    const r = this.request;
    if (r?.kind === 'point' || !r) {
      const pk = this.picker();
      if (pk && this.osnapOn && r?.kind === 'point') {
        const aperture = 10 * this.view.pixelSize();
        const s = findSnap(this.active!.doc, pk, w, aperture, this.snapModes, r.base);
        if (s) return { p: { x: s.x, y: s.y }, snap: { p: { x: s.x, y: s.y }, kind: s.kind } };
      }
      if (r?.kind === 'point') {
        const tol = 8 * this.view.pixelSize();
        const st = this.active!;
        const fmt = (v: number) => formatLength(v, st.units);
        const pa = this.polarOn ? polarAngles(this.polarInc) : null;
        if (this.otrackOn && this.acquired.length) {
          // 획득점에서는 수평·수직(극좌표가 켜져 있으면 그 각도들도)
          const t = objectTrack(this.acquired, w, pa ?? polarAngles(Math.PI / 2), tol, r.base, pa, fmt);
          if (t) return { p: t.p, snap: null, track: t };
        }
        if (r.base && pa && !this.orthoOn) {
          const t = polarTrack(r.base, w, pa, tol, fmt);
          if (t) return { p: t.p, snap: null, track: t };
        }
      }
      if (r?.kind === 'point' && r.base && this.orthoOn) {
        const dx = w.x - r.base.x;
        const dy = w.y - r.base.y;
        return { p: Math.abs(dx) >= Math.abs(dy) ? { x: w.x, y: r.base.y } : { x: r.base.x, y: w.y }, snap: null };
      }
    }
    return { p: w, snap: null };
  }

  /** 스냅점 위에 잠시 머물면 추적용으로 획득(다시 머물면 해제) */
  private updateAcquire(snap: { p: Pt; kind: SnapKind } | null): void {
    const c = this.acqCandidate;
    if (!snap || !this.otrackOn || this.request?.kind !== 'point') {
      if (c) clearTimeout(c.timer);
      this.acqCandidate = null;
      return;
    }
    if (c && Math.abs(c.p.x - snap.p.x) < 1e-9 && Math.abs(c.p.y - snap.p.y) < 1e-9) return;
    if (c) clearTimeout(c.timer);
    const p = snap.p;
    const label = SNAP_NAMES[snap.kind] ?? '점';
    this.acqCandidate = {
      p,
      timer: window.setTimeout(() => {
        const i = this.acquired.findIndex((a) => Math.abs(a.p.x - p.x) < 1e-9 && Math.abs(a.p.y - p.y) < 1e-9);
        if (i >= 0) this.acquired.splice(i, 1);
        else {
          this.acquired.push({ p, label });
          if (this.acquired.length > 7) this.acquired.shift();
        }
        this.view.overlay.acquired = this.acquired.map((a) => a.p);
        this.view.requestOverlay();
      }, 450),
    };
  }

  private clearTracking(): void {
    this.acquired = [];
    if (this.acqCandidate) clearTimeout(this.acqCandidate.timer);
    this.acqCandidate = null;
    this.view.overlay.acquired = [];
    this.view.overlay.tracks = [];
  }

  private onMove(w: Pt, s: Pt, ev: PointerEvent): void {
    const o = this.view.overlay;
    o.cursor = ev.pointerType === 'touch' ? null : s;
    this.cursorWorld = w;
    const st = this.active;
    if (!st) return;
    const r = this.request;
    const { p, snap, track } = this.resolvePoint(w);
    o.snap = snap;
    o.tracks = track ? track.lines.map((l) => ({ from: l.from, dir: l.dir })) : [];
    this.updateAcquire(snap);
    if (r?.kind === 'point') {
      o.rubber = r.rubber ? r.rubber(p) : r.base ? [{ pts: [r.base.x, r.base.y, p.x, p.y], dashed: false }] : [];
      o.ghost = r.ghost ? r.ghost(p) : [];
      if (snap) o.tip = SNAP_NAMES[snap.kind] ?? null;
      else if (track) o.tip = track.tip;
      else if (r.base) {
        const d = Math.hypot(p.x - r.base.x, p.y - r.base.y);
        let a = (Math.atan2(p.y - r.base.y, p.x - r.base.x) * 180) / Math.PI;
        if (a < 0) a += 360;
        o.tip = `${formatLength(d, st.units)} < ${a.toFixed(1)}°`;
      } else o.tip = r.prompt.replace(/\[.*$/, '').replace(/:\s*$/, '');
    }
    if (this.windowStart) {
      o.windowRect = { a: this.windowStart.screen, b: s };
    }
    this.ui.setCoords(`${formatLength(p.x, st.units)}, ${formatLength(p.y, st.units)}, ${formatLength(0, st.units)}`);
    // 선택 미리보기(가만히 있을 때)
    if (!r && !this.windowStart && ev.pointerType !== 'touch') {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => this.updateHover(w), 40);
    } else if (r?.kind === 'entity' || r?.kind === 'select') {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => this.updateHover(w), 30);
    }
    this.view.requestOverlay();
  }

  private updateHover(w: Pt): void {
    const pk = this.picker();
    if (!pk) return;
    const h = pk.pick(w.x, w.y, this.view.overlay.pickbox * this.view.pixelSize());
    if (h === this.hoverHandle) return;
    this.hoverHandle = h;
    this.view.overlay.hover = h && !this.active?.selection.has(h) ? pk.geometry(h) : null;
    this.view.requestOverlay();
  }

  private onClick(w: Pt, s: Pt, ev: PointerEvent): void {
    closeMenu();
    const st = this.active;
    if (!st) return;
    const r = this.request;
    if (r?.kind === 'point') {
      const { p } = this.resolvePoint(w);
      this.lastPoint = p;
      r.resolve({ point: p });
      return;
    }
    const pk = this.picker();
    if (!pk) return;
    const tol = this.view.overlay.pickbox * this.view.pixelSize() * (ev.pointerType === 'touch' ? 3 : 1);
    if (r?.kind === 'entity') {
      const h = pk.pick(w.x, w.y, tol);
      if (h) r.resolve({ handle: h, point: w });
      return;
    }
    if (r?.kind === 'select') {
      if (this.windowStart?.viaClick) {
        this.finishWindow(this.windowStart.screen, s, ev, r.remove);
        return;
      }
      const h = pk.pick(w.x, w.y, tol);
      if (h) {
        this.setSelection([h], r.remove || ev.shiftKey ? 'remove' : 'add');
        this.clearHover();
        return;
      }
      this.windowStart = { screen: s, world: w, viaClick: true };
      this.view.overlay.windowRect = { a: s, b: s };
      this.view.requestOverlay();
      return;
    }
    // 선택
    if (this.windowStart?.viaClick) {
      this.finishWindow(this.windowStart.screen, s, ev);
      return;
    }
    // 그립을 누르면 그립 편집
    if (!r && st.selection.size && this.gripList.length && !this.busyCommand) {
      const gt = 6 * this.view.pixelSize() * (ev.pointerType === 'touch' ? 2 : 1);
      let best: Pt | null = null;
      let bd = Infinity;
      for (const g of this.gripList) {
        const d = Math.hypot(g.point.x - w.x, g.point.y - w.y);
        if (d <= gt && d < bd) {
          bd = d;
          best = g.point;
        }
      }
      if (best) {
        const bp = best;
        const items = this.gripList.filter((g) => Math.hypot(g.point.x - bp.x, g.point.y - bp.y) <= 1e-9 * Math.max(1, Math.abs(bp.x) + Math.abs(bp.y))).map((g) => ({ handle: g.handle, id: g.id }));
        this.hotGrip = { point: bp, items };
        this.view.overlay.hotGrip = bp;
        void this.run('GRIPEDIT');
        return;
      }
    }
    const h = pk.pick(w.x, w.y, tol);
    if (h) {
      if (ev.shiftKey) this.setSelection([h], st.selection.has(h) ? 'remove' : 'add');
      else this.setSelection([h], ev.ctrlKey || ev.metaKey ? 'add' : 'add');
      this.clearHover();
      return;
    }
    if (ev.pointerType === 'touch') {
      this.clearSelection();
      return;
    }
    // 빈 곳: 창 선택 시작(클릭-클릭)
    this.windowStart = { screen: s, world: w, viaClick: true };
    this.view.overlay.windowRect = { a: s, b: s };
    this.view.requestOverlay();
  }

  private onDrag(a: Pt, b: Pt, done: boolean, ev: PointerEvent): void {
    if (!this.active || (this.request && this.request.kind !== 'select')) return;
    this.view.overlay.windowRect = { a, b };
    this.view.requestOverlay();
    if (done) this.finishWindow(a, b, ev, this.request?.kind === 'select' ? this.request.remove : false);
  }

  private finishWindow(a: Pt, b: Pt, ev: PointerEvent, remove = false): void {
    this.windowStart = null;
    this.view.overlay.windowRect = null;
    const pk = this.picker();
    if (!pk) return;
    const wa = this.view.screenToWorld(a.x, a.y);
    const wb = this.view.screenToWorld(b.x, b.y);
    const crossing = b.x < a.x;
    const rect: [number, number, number, number] = [Math.min(wa.x, wb.x), Math.min(wa.y, wb.y), Math.max(wa.x, wb.x), Math.max(wa.y, wb.y)];
    const hits = pk.select(rect, crossing);
    this.setSelection(hits, ev.shiftKey || remove ? 'remove' : 'add');
    this.view.requestOverlay();
  }

  private onDblClick(w: Pt, _s: Pt): void {
    void _s;
    const st = this.active;
    if (!st || this.request) return;
    const pk = this.picker();
    const h = pk?.pick(w.x, w.y, this.view.overlay.pickbox * this.view.pixelSize());
    if (!h) return;
    const e = st.doc.entityIndex.get(h);
    // 문자·치수·속성 블록은 두 번 누르면 바로 고친다(AutoCAD와 같다)
    if (e && (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTDEF' || e.type === 'DIMENSION' || (e.type === 'INSERT' && e.attribs.some((a) => !(a.attFlags & 2))))) {
      this.setSelection([h], 'replace');
      void import('./editcmds').then((m) => m.editText(this, h));
      return;
    }
    this.setSelection([h], 'replace');
    this.ui.openPalette('props');
  }

  private onContext(w: Pt, _s: Pt, ev: MouseEvent): void {
    void _s;
    void w;
    const r = this.request;
    if (r?.kind === 'select') {
      r.resolve({ handles: [...(this.active?.selection ?? [])] });
      return;
    }
    if (r) {
      // 명령 중 오른쪽 클릭 = Enter(AutoCAD 기본 설정과 같은 바로가기 메뉴 대신)
      const items = [{ label: 'Enter', run: () => r.resolve({ enter: true } as never) }, { label: '취소', kbd: 'Esc', run: () => this.cancel() }, { separator: true }];
      for (const k of r.keywords) items.push({ label: `${k.label}(${k.key})`, run: () => r.resolve({ keyword: k.key } as never) } as never);
      if (r.kind === 'point') {
        items.push({ separator: true } as never, { heading: '객체 스냅 재지정' } as never);
        for (const kind of ['end', 'mid', 'cen', 'qua', 'int', 'per', 'nea', 'ins', 'nod'] as SnapKind[]) {
          items.push({ label: SNAP_NAMES[kind]!, run: () => this.snapOnce(kind) } as never);
        }
      }
      showMenu(ev.clientX, ev.clientY, items as never);
      return;
    }
    const st = this.active;
    const sel = st?.selection.size ?? 0;
    showMenu(ev.clientX, ev.clientY, [
      ...(this.lastCommand ? [{ label: `반복 ${this.lastCommand}`, run: () => void this.run(this.lastCommand!) }, { separator: true }] : []),
      { label: '특성', icon: 'props', kbd: 'Ctrl+1', disabled: !sel, run: () => this.ui.openPalette('props') },
      { label: '리스트', icon: 'list', disabled: !sel, run: () => void this.run('LIST') },
      { label: '선택한 객체로 확대', icon: 'zoomWindow', disabled: !sel, run: () => void this.run('ZOOM', 'O') },
      { label: '선택 해제', disabled: !sel, kbd: 'Esc', run: () => this.clearSelection() },
      { separator: true },
      { label: '거리 측정', icon: 'dist', run: () => void this.run('DIST') },
      { label: '면적 측정', icon: 'area', run: () => void this.run('AREA') },
      { label: '좌표 확인', icon: 'id', run: () => void this.run('ID') },
      { separator: true },
      { label: '전체 보기', icon: 'extents', kbd: '휠 두 번', run: () => this.view.zoomExtents() },
      { label: '이전 화면', icon: 'zoomPrev', run: () => this.view.zoomPrevious() },
      { label: '모두 선택', icon: 'selectAll', kbd: 'Ctrl+A', run: () => void this.run('SELECTALL') },
    ]);
  }

  private snapOnce(kind: SnapKind): void {
    const prev = new Set(this.snapModes);
    const prevOn = this.osnapOn;
    this.snapModes.clear();
    this.snapModes.add(kind);
    this.osnapOn = true;
    const r = this.request;
    if (r?.kind === 'point') {
      const orig = r.resolve;
      r.resolve = (res) => {
        this.snapModes.clear();
        for (const k of prev) this.snapModes.add(k);
        this.osnapOn = prevOn;
        orig(res);
      };
    }
  }

  // -------------------------------------------------------------------------
  // 키보드
  // -------------------------------------------------------------------------

  private onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const inCmd = t === this.cmd.input;
    const mod = ev.ctrlKey || ev.metaKey;
    // 기능 키는 어디서나
    switch (ev.key) {
      case 'F1':
        ev.preventDefault();
        void this.run('HELP');
        return;
      case 'F2':
        ev.preventDefault();
        this.cmd.toggleHistory();
        return;
      case 'F3':
        ev.preventDefault();
        this.toggleOsnap();
        return;
      case 'F8':
        ev.preventDefault();
        this.toggleOrtho();
        return;
      case 'F10':
        ev.preventDefault();
        this.togglePolar();
        return;
      case 'F11':
        ev.preventDefault();
        this.toggleOtrack();
        return;
    }
    if (mod && ev.shiftKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === 'z' && !typing) {
        ev.preventDefault();
        void this.run('REDO');
        return;
      }
      if (k === 's') {
        ev.preventDefault();
        void this.run('SAVEAS');
        return;
      }
    }
    if (mod && !ev.shiftKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === 'o') {
        ev.preventDefault();
        void this.run('OPEN');
        return;
      }
      if (k === '1') {
        ev.preventDefault();
        void this.run('PROPERTIES');
        return;
      }
      if (k === 'z' && !typing) {
        ev.preventDefault();
        void this.run('U');
        return;
      }
      if (k === 'y' && !typing) {
        ev.preventDefault();
        void this.run('REDO');
        return;
      }
      if (k === 'n') {
        ev.preventDefault();
        void this.run('NEW');
        return;
      }
      if ((k === 'c' || k === 'x') && !typing && this.active?.selection.size) {
        ev.preventDefault();
        void this.run(k === 'c' ? 'COPYCLIP' : 'CUTCLIP');
        return;
      }
      if (k === 'v' && !typing) {
        ev.preventDefault();
        void this.run('PASTECLIP');
        return;
      }
      if (k === 's') {
        ev.preventDefault();
        void this.run('QSAVE');
        return;
      }
      if (k === '9') {
        ev.preventDefault();
        this.cmd.el.hidden = !this.cmd.el.hidden;
        return;
      }
      if (k === 'p') {
        ev.preventDefault();
        void this.run('PLOT');
        return;
      }
      if (k === 'a' && !typing) {
        ev.preventDefault();
        void this.run('SELECTALL');
        return;
      }
      if (k === 'tab' || ev.key === 'Tab') {
        ev.preventDefault();
        this.cycleDoc(1);
        return;
      }
      if (ev.key === 'PageDown' || ev.key === 'PageUp') {
        ev.preventDefault();
        this.cycleLayout(ev.key === 'PageDown' ? 1 : -1);
        return;
      }
    }
    if (typing && !inCmd) return;
    if (inCmd) return; // 명령행이 직접 처리
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.cancel();
      return;
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && !mod) {
      ev.preventDefault();
      if (this.request) this.onInput('');
      else if (this.lastCommand) void this.run(this.lastCommand);
      return;
    }
    if (ev.key === 'Delete' || (ev.key === 'Backspace' && !this.request)) {
      ev.preventDefault();
      if (!this.request && this.active?.selection.size) void this.run('ERASE');
      return;
    }
    // 글자는 명령행으로
    if (ev.key.length === 1 && !mod && !ev.altKey && ev.key !== ' ') {
      ev.preventDefault();
      this.cmd.typeChar(ev.key);
    }
  }

  toggleOsnap(): void {
    this.osnapOn = !this.osnapOn;
    this.cmd.print(`<객체 스냅 ${this.osnapOn ? '켜기' : '끄기'}>`);
    this.ui.refreshStatus();
  }

  toggleOrtho(): void {
    this.orthoOn = !this.orthoOn;
    // 직교와 극좌표 추적은 함께 켤 수 없다
    if (this.orthoOn) this.polarOn = false;
    this.cmd.print(`<직교 ${this.orthoOn ? '켜기' : '끄기'}>`);
    this.ui.refreshStatus();
  }

  togglePolar(): void {
    this.polarOn = !this.polarOn;
    if (this.polarOn) this.orthoOn = false;
    this.cmd.print(`<극좌표 ${this.polarOn ? '켜기' : '끄기'}>`);
    this.ui.refreshStatus();
  }

  toggleOtrack(): void {
    this.otrackOn = !this.otrackOn;
    if (!this.otrackOn) this.clearTracking();
    this.cmd.print(`<객체 스냅 추적 ${this.otrackOn ? '켜기' : '끄기'}>`);
    this.ui.refreshStatus();
  }

  cycleDoc(d: number): void {
    if (!this.docs.length) return;
    const i = this.active ? this.docs.indexOf(this.active) : -1;
    this.activate(this.docs[(i + d + this.docs.length) % this.docs.length]!);
  }

  cycleLayout(d: number): void {
    const st = this.active;
    if (!st) return;
    const keys = st.layouts.map((l) => tableKey(l.blockName));
    const i = keys.indexOf(st.space);
    void this.setSpace(keys[(i + d + keys.length) % keys.length]!);
  }

  /** 선택한 객체(없으면 고르게 한다) */
  async selectedOrPick(ctx: CommandContext, prompt = '객체 선택:'): Promise<string[]> {
    const st = this.active!;
    if (st.selection.size) return [...st.selection];
    const out: string[] = [];
    for (;;) {
      const r = await ctx.getEntity(out.length ? `${prompt} (Enter = 끝)` : prompt);
      if ('enter' in r) break;
      if ('handle' in r) {
        out.push(r.handle);
        this.setSelection([r.handle], 'add');
      }
      if (out.length && 'handle' in r && st.selection.size) continue;
    }
    return out;
  }

  /** 선택 하이라이트 형상(오버레이) */
  geometryOf(handle: string): OverlayGeom | null {
    return this.picker()?.geometry(handle) ?? null;
  }
}
