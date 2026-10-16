/**
 * 앱 컨트롤러: 문서·화면·명령·선택·스냅을 묶는다.
 * 직접 조작 입력(AutoCAD 2026 기본 설정과 같게): 동적 입력 칸·상대 좌표(dyninput.ts), 객체 스냅 재지정(osnap-override.ts),
 * 연장선·평행 획득(snap.ts), 선택한 객체 끌어 옮기기(dragmove.ts), 올가미(lasso.ts), 오른쪽 클릭 메뉴(ctxmenu.ts),
 * Ctrl 단축키(keys.ts), 다기능 그립 메뉴·여러 핫 그립, Shift 임시 직교. 화면 이벤트는 view.ts가 넘긴다.
 * OPTIONS·시스템 변수(GRIPS·GRIPSIZE·APERTURE·AUTOSNAP·PICKFIRST·PICKADD·PICKAUTO·SELECTIONPREVIEW·SHORTCUTMENU …)는
 * settings에 읽어 두고 바뀌면 바로 다시 읽는다(settings.ts, sysvars.ts onSysvarChange). 화면은 view.prefs로 같은 값을 본다.
 */
import { currentUcs, dirToUcs, isWorld, toUcs, toWcs } from './ucs';
import { viewportModel } from './psltscale';
import type { Entity, ViewportEntity } from '../core/model';
import { MODEL_SPACE, normalizeHandle, tableKey } from '../core/model';
import { errorMessage } from '../core/errors';
import type { CadErrorCode } from '../core/errors';
import { formatLength } from '../core/units';
import { OutlineLibrary } from '../text/fonts';
import { TextEngine } from '../text/layout';
import { collectTextUsage } from '../text/collect';
import { EngineClient, EngineError, type OpenResult } from './engine';
import { LoadPreview } from './loadpreview';
import { DocState } from './docstate';
import { CadView, type OverlayGeom, type Pt, type SnapKind } from './view';
import { CommandLine, parsePointInput } from './commandline';
import { Picker } from './pick';
import { SELECT_HELP, SELECT_METHODS, SELECT_OPTIONS, runSelectMethod, selectMethodOf } from './selmethod';
import { DEFAULT_SNAPS, SNAP_NAMES, findSnap } from './snap';
import { type Acquired, objectTrack, polarAngles, polarTrack } from './tracking';
import { gripPoints } from '../edit/geom';
import { dynGrips, isDynamicReference } from '../edit/dynblock';
import { spaceTolerance } from '../render/build';
import { ask, closeMenu, showMenu, toast } from './ui/dom';
import { kindName as entityKindName } from '../edit/extract';
import { EditManager } from './edits';
import { OverlayScene, layoutViewports, paperInfo } from './scene';
import { expandXrefBounds } from './refs';
import type { EditOp } from '../edit/session';
import { isEditableTable } from '../edit/table/entity';
import { type CommandFallback, type CommitHook, type ContextMenuItem, type ContextMenuMode, type ContextMenuProvider, type DblClickHandler, type EntityClickHandler, type GripMenuProvider, type InputFilter, type PendingInput, type PointFilter, type ResolvedPoint, bindCommitHooks } from './hooks';
import { cycleIsoPlane } from './viewtools-iso';
import { maximized } from './viewtools-vpmax';
import { DynInput, dynRelative } from './dyninput';
import { type Override, parseOverride, runPointOverride } from './osnap-override';
import { type ExtAnchor, findExtAnchor, segmentDirAt } from './snap';
import { DragGhost, commitDrag, pressKind } from './dragmove';
import { Lasso } from './lasso';
import { ctrlAction } from './keys';
import { commandLineMenu, commandMenu, idleMenu, osnapItems, showContextMenu } from './ctxmenu';
import { listGroups } from '../edit/util/groups';
import { type PickMode, type Settings, autoWindow, contextAction, gripPickRadius, gripsOn, pickMode, previewOn, readSettings, showSnapTip, showTrackTip, usePickfirst } from './settings';
import { onSysvarChange } from './sysvars';
import { optionValue } from './options';

export class CancelError extends Error {
  constructor() {
    super('취소');
  }
}

export interface Keyword {
  key: string;
  label: string;
}

/** 찍은 점의 객체 스냅(연관 치수 등). 결과의 snap이 null이면 스냅 없이 찍었거나 좌표를 입력한 것 */
export interface PointSnap {
  kind: SnapKind;
  handle?: string;
  handle2?: string;
}

/**
 * 점 요청의 결과. 클릭으로 찍었으면 그때 누른 보조키(shift·ctrl, ⌘는 ctrl로)를 눌렀을 때만 true로 싣는다
 * (그립 복사의 Ctrl 간격 맞춤 등). 좌표 입력·스냅 재지정으로 만든 점에는 없다
 */
export type PointResult = { point: Pt; snap?: PointSnap | null; shift?: boolean; ctrl?: boolean } | { keyword: string } | { text: string } | { enter: true };

interface PointRequest {
  kind: 'point';
  prompt: string;
  base: Pt | null;
  keywords: Keyword[];
  rubber?: (p: Pt) => { pts: number[]; closed?: boolean; fill?: boolean; dashed?: boolean }[];
  ghost?: (p: Pt) => OverlayGeom[];
  allowText: boolean;
  /** 명령이 글을 받는다고 한 요청(allowText): 객체 스냅 재지정 이름도 글로 돌려준다 */
  freeText: boolean;
  /** 숫자만 입력하면 직접 거리 입력 대신 문자로 돌려준다(각도·축척 입력) */
  preferNumber: boolean;
  /** 이 입력을 기다리는 명령(실행의 취소 신호). 명령이 끝날 때 자기 요청만 치운다 */
  signal: AbortSignal;
  resolve: (r: PointResult) => void;
  reject: (e: unknown) => void;
}

/** 객체를 고른 결과. shift: 고를 때 Shift를 누르고 있었는지(자르기·연장 전환 등) */
export type EntityPick = { handle: string; point: Pt; shift?: boolean };
export type EntityResult = EntityPick | { keyword: string } | { enter: true };
/** getEntity(…, { emptyPick: true })에서 빈 곳을 누르거나 좌표를 입력한 결과(point는 도면 좌표, 스냅 없음) */
export type EmptyPick = { point: Pt; empty: true; shift?: boolean };
/** getEntity 옵션. emptyPick: 빈 곳 클릭·좌표 입력도 돌려받는다(EmptyPick) */
export interface EntityOptions {
  emptyPick?: boolean;
}

interface EntityRequest {
  kind: 'entity';
  prompt: string;
  keywords: Keyword[];
  emptyPick: boolean;
  signal: AbortSignal;
  resolve: (r: EntityResult | EmptyPick) => void;
  reject: (e: unknown) => void;
}

/** 객체 선택 중 한 번의 고르기(명령 취소 U가 되돌린다). removed: 바꾸기(PICKADD 0)로 빠진 것 */
interface SelectStep {
  handles: string[];
  mode: 'add' | 'remove';
  removed?: string[];
}

interface SelectRequest {
  kind: 'select';
  prompt: string;
  keywords: Keyword[];
  remove: boolean;
  /** 단일(SI): 한 번 고르면 끝 */
  single: boolean;
  /** 다중(M): 강조 없이 모아 두었다가 Enter로 더한다 */
  multiple: string[] | null;
  /** 이 선택 프롬프트에서 고른 단계(U) */
  history: SelectStep[];
  signal: AbortSignal;
  resolve: (r: { handles: string[] } | { keyword: string }) => void;
  reject: (e: unknown) => void;
}

type Request = PointRequest | EntityRequest | SelectRequest;

export type { CommitHook, ContextMenuItem, ContextMenuProvider, EntityClickHandler, InputFilter, PendingInput, PointFilter, ResolvedPoint } from './hooks';

export interface CommandContext {
  app: App;
  print(text: string, cls?: 'err' | 'res'): void;
  getPoint(prompt: string, opt?: { base?: Pt | null; keywords?: Keyword[]; rubber?: PointRequest['rubber']; ghost?: PointRequest['ghost']; allowText?: boolean; preferNumber?: boolean }): Promise<PointResult>;
  getEntity(prompt: string, keywords?: Keyword[]): Promise<EntityResult>;
  /** emptyPick: 빈 곳 클릭·좌표 입력도 EmptyPick으로 돌려받는다(기존 호출의 동작은 그대로) */
  getEntity(prompt: string, keywords: Keyword[] | undefined, opt: EntityOptions): Promise<EntityResult | EmptyPick>;
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
  /** 진행 상자 뒤로 그림이 보이게(도면을 여는 동안의 미리 보기) */
  setBusySeeThrough?(on: boolean): void;
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
  /** 격자 표시(F7)·격자 스냅(F9) */
  gridOn = false;
  snapOn = false;
  /** 극좌표 추적(F10)과 증분 각도 */
  polarOn = false;
  polarInc = Math.PI / 2;
  /** 객체 스냅 추적(F11)과 획득점 */
  otrackOn = false;
  /** 동적 입력(F12): 커서 옆에 프롬프트·거리·입력 중인 값 */
  dynOn = true;
  private acquired: Acquired[] = [];
  private acqCandidate: { p: Pt; timer: number } | null = null;
  private request: Request | null = null;
  private running: { name: string; ctrl: AbortController } | null = null;
  private lastCommand: string | null = null;
  private groupSerial = 0;
  /** 고른 핸들을 넓히는 고리(PICKSTYLE 그룹 선택 등) */
  selectionExpander: ((handles: string[]) => string[]) | null = null;
  /** 확장 지점: 점 요청에서 객체 스냅이 잡히지 않은 점의 해석(추적·격자 스냅·직교)을 대신한다 — 등각투영 제도 */
  readonly pointFilters: PointFilter[] = [];
  /** 확장 지점: 명령행 입력을 요청보다 먼저 본다 — 점 프롬프트의 DRAG */
  readonly inputFilters: InputFilter[] = [];
  /** 확장 지점: 끌기 미리보기 모드(DRAGMODE 0 끄기·1 켜기·2 자동). 없으면 자동 */
  dragPreviewMode: (() => number) | null = null;
  /** 확장 지점: 명령 없이 Ctrl+클릭한 객체(하이퍼링크 linkClick보다 먼저) — 연관 배열 항목 고르기 */
  readonly entityClickHandlers: EntityClickHandler[] = [];
  /** 확장 지점: 명령 없이 두 번 누른 객체(종류별 기본 편집보다 먼저) */
  readonly dblClickHandlers: DblClickHandler[] = [];
  /** 확장 지점: 다기능 그립 메뉴 항목(그립 위에 커서를 올리거나 오른쪽 클릭) */
  readonly gripMenuProviders: GripMenuProvider[] = [];
  /** 확장 지점: 등록되지 않은 이름을 쳤을 때(알 수 없는 명령 안내보다 먼저) — 시스템 변수 이름 바로 입력 */
  readonly commandFallbacks: CommandFallback[] = [];
  /** 확장 지점: 편집 확정 고리(문서를 열 때 편집 세션에 잇는다) — 주석 축척·도면층 이전·연관 배열 경로 따라가기 */
  readonly commitHooks: CommitHook[] = [];
  /** 확장 지점: 도면 영역 오른쪽 클릭 메뉴(기본·편집·명령 모드)에 항목 더하기 */
  readonly contextMenuProviders: ContextMenuProvider[] = [];
  /** 누른 채 끌기를 올가미로(AutoCAD LASSO 켜짐). 끄면 직사각형 창 */
  lassoOn = true;
  /** 최근 명령(앞이 최근, 오른쪽 클릭·명령행 메뉴) */
  readonly recentCommands: string[] = [];
  /** 최근 입력(명령 중에 친 좌표·값, 앞이 최근) */
  readonly recentInputs: string[] = [];
  /** 동적 입력 칸(거리·각도 또는 X·Y)의 잠금 */
  readonly dyn = new DynInput();
  /** 객체 스냅 재지정(다음 한 점만): 그 점 요청과 쓸 스냅(빈 집합 = 스냅 없이) */
  private snapOverride: { req: Request; modes: Set<SnapKind> } | null = null;
  /** 임시 추적점(TT): 그 점 요청에서만 객체 스냅 추적이 꺼져 있어도 쓴다 */
  private tempTrack: { req: Request; points: Acquired[] } | null = null;
  /** 연장선 획득점·평행 방향(커서를 끝점·선분 위에 잠시 머물러 얻는다)과 얻는 중인 후보 */
  private extAnchors: ExtAnchor[] = [];
  private parDirs: { dir: Pt; at: Pt }[] = [];
  private extCandidate: { key: string; timer: number } | null = null;
  /** Shift를 누르고 있는지(임시 직교 반전) */
  private shiftHeld = false;
  /** 마지막 포인터 이동(Shift를 누르고 뗄 때 다시 해석) */
  private lastMove: { w: Pt; s: Pt; ev: PointerEvent } | null = null;
  /** 왼쪽 버튼을 누른 곳의 뜻(명령이 없을 때): 그립, 끌어 옮기기, 창·올가미 */
  private press: { kind: 'grip' | 'move' | 'window'; world: Pt; screen: Pt; ghost?: DragGhost; lasso?: Lasso; started?: boolean } | null = null;
  /** 핫 그립(Shift+클릭으로 여럿) */
  private hotGrips: Pt[] = [];
  /** 커서가 올라간 그립과 다기능 그립 메뉴 타이머 */
  private hoverGrip: { point: Pt; timer: number; shown: boolean } | null = null;
  /** 창·올가미 선택 미리보기를 다시 구할 시각 */
  private previewAt = 0;
  /** 마지막 점 요청과 DRAG로 끌기 미리보기를 켠 점 요청(DRAGMODE 켜기) */
  private lastPointRequest: PointRequest | null = null;
  private dragFor: PointRequest | null = null;
  /** 직전 선택(P 옵션) */
  lastSelection: string[] = [];
  lastPoint: Pt | null = null;
  private cursorWorld: Pt | null = null;
  private windowStart: { screen: Pt; world: Pt; viaClick: boolean } | null = null;
  private pickers = new Map<string, Picker>();
  private hoverHandle: string | null = null;
  private hoverTimer = 0;
  private readonly fontsReady = new WeakMap<DocState, Promise<void>>();
  /** OPTIONS·시스템 변수에서 읽은 화면·입력 설정(바뀌면 onSysvarChange로 다시 읽는다) */
  settings: Settings = readSettings(optionValue);

  constructor(drawingParent: HTMLElement) {
    const fontBase = new URL('fonts/noto-sans-kr/', document.baseURI).href;
    this.engine = new EngineClient(fontBase);
    this.fontLib = new OutlineLibrary(fontBase);
    this.text = new TextEngine(this.fontLib);
    this.view = new CadView(drawingParent);
    this.edits = new EditManager(this);
    this.cmd = new CommandLine(drawingParent, {
      submit: (t) => this.onInput(t, true),
      cancel: () => this.cancel(),
      suggest: (p) => this.suggest(p),
      keyword: (k) => this.onInput(k),
      repeat: () => {
        if (this.lastCommand) void this.run(this.lastCommand);
      },
    });
    this.view.on({
      move: (w, s, ev) => this.onMove(w, s, ev),
      down: (w, s, ev) => this.onDown(w, s, ev),
      click: (w, s, ev) => this.onClick(w, s, ev),
      drag: (a, b, done, ev) => this.onDrag(a, b, done, ev),
      context: (w, s, ev, held) => this.onContext(w, s, ev, held),
      dblclick: (w, s) => this.onDblClick(w, s),
      leave: () => {
        this.ui.setCoords('');
      },
      viewChanged: () => {
        this.refreshSelectionOverlay();
        this.ui?.refreshStatus();
        this.scheduleDetail();
      },
      viewportView: (vp, patch) => this.onViewportView(vp, patch),
    });
    this.cmd.onChange = (t) => {
      this.view.overlay.dynInput = this.dynOn && t ? t : null;
      this.updateDynFields();
      this.view.requestOverlay();
    };
    // 동적 입력 칸의 Tab, 올가미 중 스페이스바(명령행 입력란에 초점이 있어도)
    this.cmd.intercept = (ev) => this.interceptKey(ev);
    this.cmd.onContext = (ev) => showContextMenu(ev.clientX, ev.clientY, commandLineMenu(this, () => this.cmd.historyText(), this.cmd.selectedText()));
    this.view.onRestore = () => {
      for (const d of this.docs) {
        for (const sc of d.scenes.values()) sc.reupload(this.view.renderer);
        for (const v of d.ltVariants.values()) v.scene.reupload(this.view.renderer);
      }
    };
    this.view.viewportModel = (st, vx) => viewportModel(this, st, vx);
    // 설정: 화면이 같은 값을 보게 넣고, OPTIONS·SYSVDLG·변수 이름 입력·setvar로 바뀌면 바로 다시 읽는다
    this.applySettings();
    onSysvarChange((name) => this.applySettings(name));
    this.view.gridInfo = () => {
      const st = this.active;
      if (!this.gridOn || !st) return null;
      let limits: [number, number, number, number] | undefined;
      if (st.onLayout) {
        const lay = st.layoutFor(st.displaySpace);
        if (lay) {
          const p = paperInfo(lay, null);
          limits = [p.minX, p.minY, p.maxX, p.maxY];
        }
      }
      return { x: st.grid.x, y: st.grid.y, major: st.grid.major, baseX: st.snap.baseX, baseY: st.snap.baseY, limits, ucs: currentUcs(st) };
    };
    window.addEventListener('keydown', (ev) => this.onKey(ev));
    window.addEventListener('keyup', (ev) => {
      if (ev.key === 'Shift') this.setShift(false);
    });
    // 앱 안에서는 브라우저 기본 메뉴를 막는다(입력란·편집 가능한 곳·고른 글이 있을 때는 그대로)
    if (typeof document.addEventListener === 'function')
      document.addEventListener(
        'contextmenu',
        (ev) => {
          const t = ev.target as HTMLElement | null;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.closest?.('a[href]'))) return;
          const sel = window.getSelection?.();
          if (sel && !sel.isCollapsed) return;
          ev.preventDefault();
        },
        true,
      );
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

  /** 별칭을 더하거나(name) 지운다(null) — ALIASEDIT·사용자 별칭 */
  setAlias(alias: string, name: string | null): void {
    const a = alias.trim().toUpperCase();
    if (!a) return;
    if (name === null) this.aliases.delete(a);
    else this.aliases.set(a, name.trim().toUpperCase());
  }

  /** 지금 등록된 별칭 [별칭, 명령 이름] 목록 */
  aliasEntries(): [string, string][] {
    return [...this.aliases.entries()];
  }

  findCommand(name: string): Command | undefined {
    // 명령행판(-VIEW 등)이 따로 있으면 그것, 없으면 앞의 -를 떼고 찾는다
    const raw = name.trim().toUpperCase().replace(/^[_.']+/, '');
    const dash = this.commands.get(raw) ?? this.commands.get(this.aliases.get(raw) ?? '');
    if (dash) return dash;
    const n = raw.replace(/^-+/, '');
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
      const raw = name.trim().toUpperCase().replace(/^[_.']+/, '');
      for (const f of this.commandFallbacks) if (await f.run(raw, arg)) return;
      this.cmd.print(`알 수 없는 명령 "${name}". 도움말은 F1을 누르십시오.`, 'err');
      return;
    }
    if (!c.noDoc && !this.active) {
      this.cmd.print('열린 도면이 없습니다. 먼저 파일을 여십시오.', 'err');
      return;
    }
    const prev = this.running && !c.transparent ? this.running : null;
    if (prev) {
      this.cancel(true);
      // 앞 명령은 취소를 받은 뒤에도 더 묻지 못하고(요청이 곧바로 거절된다), 남긴 미리보기는 지금 지운다.
      // 앞 명령의 정리(finally)는 마이크로태스크 뒤에 오므로 새 명령의 요청·프롬프트를 건드리지 않게 한다.
      prev.ctrl.abort();
      this.resetCommandUi();
    }
    const outer = this.running && c.transparent ? this.running : null;
    const nested = !!outer;
    const saved = nested ? this.request : null;
    if (nested) this.request = null;
    const ctrl = new AbortController();
    if (!nested) this.running = { name: c.name, ctrl };
    this.lastCommand = c.name;
    remember(this.recentCommands, c.name);
    this.cmd.print(`명령: ${c.name}`);
    this.clearHover();
    this.clearGripHover();
    const ctx: CommandContext = {
      app: this,
      print: (t, cls) => this.cmd.print(t, cls),
      getPoint: (prompt, opt) => this.requestPoint(prompt, opt, ctrl.signal),
      getEntity: ((prompt: string, kws?: Keyword[], opt?: EntityOptions) => this.requestEntity(prompt, kws ?? [], ctrl.signal, opt ?? {})) as CommandContext['getEntity'],
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
      // 자기 것만 치운다: 이 명령이 끝나기 전에 다른 명령이 이어받았으면(취소 직후 같은 틱의 새 명령, 스크립트,
      // 명령 안에서 시작한 명령) 그 명령의 요청·프롬프트·미리보기는 그대로 둔다
      if (this.request?.signal === ctrl.signal) this.request = null;
      if (nested) {
        // 바깥 명령이 아직 그 입력을 기다리면 되돌린다(그 사이 취소·이어받기로 끝났으면 되돌리지 않는다)
        if (!this.request && saved && !saved.signal.aborted && this.running === outer) {
          this.request = saved;
          this.cmd.setPrompt(this.promptOf(saved));
        }
      } else {
        if (this.running?.ctrl === ctrl) this.running = null;
        if (!this.running) this.resetCommandUi();
      }
    }
  }

  /** 명령의 프롬프트·미리보기·추적 표시를 지운다 */
  private resetCommandUi(): void {
    this.cmd.setPrompt('');
    const o = this.view.overlay;
    o.rubber = [];
    o.ghost = [];
    o.marks = [];
    o.hotGrip = null;
    o.hotGrips = [];
    o.dynFields = null;
    this.hotGrips = [];
    this.snapOverride = null;
    this.tempTrack = null;
    this.clearTracking();
    o.tip = null;
    this.view.requestOverlay();
  }

  get busyCommand(): string | null {
    return this.running?.name ?? null;
  }

  /** 직전 명령(Enter·오른쪽 클릭 반복) */
  get lastCommandName(): string | null {
    return this.lastCommand;
  }

  /** 명령 밖의 편집(끌어 옮기기 등)이 쓸 명령 취소 묶음 번호 */
  nextGroup(): number {
    return ++this.groupSerial;
  }

  /** 명령이 기다리는 입력(스크립트 실행기가 다음 입력을 넣을 때를 안다). 없으면 null */
  get pendingInput(): PendingInput | null {
    return this.request;
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
    } else if (this.windowStart || this.press?.lasso) {
      this.windowStart = null;
      this.press = null;
      this.view.overlay.windowRect = null;
      this.view.overlay.lasso = null;
      this.view.overlay.preview = [];
      this.view.requestOverlay();
    } else if (this.hotGrips.length) {
      // Esc 한 번 = 핫 그립 풀기, 두 번 = 선택 해제(AutoCAD와 같다)
      this.hotGrips = [];
      this.view.overlay.hotGrips = [];
      this.view.requestOverlay();
    } else if (this.active && this.active.selection.size) {
      this.clearSelection();
    }
    this.cmd.setPrompt('');
  }

  /** 명령이 취소(abort)되면 그 명령의 요청을 거절한다(지금 요청이면 치운다) */
  private dropRequest(req: Request, reject: (e: unknown) => void): void {
    if (this.request === req) this.request = null;
    reject(new CancelError());
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
        freeText: !!opt.allowText,
        preferNumber: !!opt.preferNumber,
        signal,
        resolve: (r) => {
          if (this.request === req) this.request = null;
          resolve(r);
        },
        reject,
      };
      this.request = req;
      this.lastPointRequest = req;
      this.dyn.sync(req);
      // 연장선·평행 획득점은 점을 찍을 때마다 새로(AutoCAD와 같다)
      this.extAnchors = [];
      this.parDirs = [];
      this.refreshAcquired();
      this.cmd.setPrompt(this.promptOf(req));
      this.view.overlay.tip = prompt.replace(/\[.*$/, '').replace(/:\s*$/, '');
      signal.addEventListener('abort', () => this.dropRequest(req, reject), { once: true });
      this.view.requestOverlay();
    });
  }

  private async requestSelection(prompt: string, opt: { keywords?: Keyword[]; noPickfirst?: boolean }, signal: AbortSignal): Promise<string[]> {
    const st = this.active;
    if (!st) return [];
    if (st.selection.size && !opt.noPickfirst) {
      if (usePickfirst(this.settings.pickfirst)) {
        const hs = [...st.selection];
        this.lastSelection = hs;
        return hs;
      }
      // PICKFIRST 0(명사/동사 선택 끄기): 명령 전에 고른 것은 쓰지 않고 풀고 새로 묻는다(AutoCAD와 같다)
      this.clearSelection();
    }
    const kws: Keyword[] = [
      { key: 'ALL', label: '전체' },
      { key: 'P', label: '이전' },
      { key: 'L', label: '마지막' },
      { key: 'R', label: '제거' },
      { key: 'A', label: '추가' },
      ...(opt.keywords ?? []),
    ];
    // 선택 방식(W·C·BOX·WP·CP·F)과 그 밖의 옵션(G·M·AU·SI·U): 명령의 키워드가 먼저
    for (const m of [...SELECT_METHODS, ...SELECT_OPTIONS]) if (!kws.some((k) => k.key.toUpperCase() === m.key)) kws.push(m);
    let removing = false;
    let single = false;
    let multiple: string[] | null = null;
    const history: SelectStep[] = [];
    /** 이 프롬프트에서 고른 단계(U가 되돌린다) */
    const step = (hs: string[], mode: 'add' | 'remove') => this.selectStep(history, hs, mode);
    const done = () => {
      const hs = [...st.selection];
      this.lastSelection = hs;
      return hs;
    };
    for (;;) {
      const r = await new Promise<{ handles: string[] } | { keyword: string }>((resolve, reject) => {
        if (signal.aborted) return reject(new CancelError());
        const req: SelectRequest = {
          kind: 'select',
          prompt,
          keywords: kws,
          remove: removing,
          single,
          multiple,
          history,
          signal,
          resolve: (x) => {
            if (this.request === req) this.request = null;
            removing = req.remove;
            multiple = req.multiple;
            resolve(x);
          },
          reject,
        };
        this.request = req;
        this.cmd.setPrompt(removing ? '객체 제거:' : prompt);
        this.view.overlay.tip = prompt.replace(/:\s*$/, '');
        signal.addEventListener('abort', () => this.dropRequest(req, reject), { once: true });
        this.view.requestOverlay();
      });
      if ('handles' in r) {
        this.lastSelection = r.handles;
        return r.handles;
      }
      const k = r.keyword.toUpperCase();
      const mode = removing ? 'remove' : 'add';
      let picked = false;
      if (k === 'ALL') {
        const scene = st.scenes.get(st.space);
        const hs = (scene?.entities ?? []).map((b) => b.handle).filter((h) => {
          const e = st.doc.entityIndex.get(h);
          const l = e ? st.layers.get(tableKey(e.layer)) : undefined;
          return !!e && (!l || (l.on && !l.frozen));
        });
        const ed = st.edits.get(st.space);
        for (const b of ed?.overlay?.entities ?? []) if (!hs.includes(b.handle)) hs.push(b.handle);
        step(hs.filter((h) => !ed?.hidden.has(h) || ed.live.has(h)), mode);
        this.cmd.print(`${st.selection.size}개를 찾음`);
        picked = true;
      } else if (k === 'P') {
        step(this.lastSelection.filter((h) => st.doc.entityIndex.has(h)), mode);
        picked = true;
      } else if (k === 'L') {
        const last = this.lastCreated.filter((h) => st.doc.entityIndex.has(h)).slice(-1);
        step(last, mode);
        picked = true;
      } else if (opt.keywords?.some((x) => x.key.toUpperCase() === k)) return Promise.reject(Object.assign(new Error('keyword'), { keyword: k }));
      else if (k === 'SI') single = true;
      else if (k === 'AU') {
        // 자동: 객체를 누르면 고르고 빈 곳이면 창(이미 기본 동작)
      } else if (k === 'M') multiple = [];
      else if (k === 'U') {
        const last = history.pop();
        if (!last) this.cmd.print('되돌릴 선택이 없습니다.');
        else {
          this.setSelection(last.handles, last.mode === 'add' ? 'remove' : 'add');
          // 바꾸기(PICKADD 0)로 빠졌던 것은 되살린다
          if (last.removed?.length) this.setSelection(last.removed, 'add');
          this.cmd.print(`${last.handles.length + (last.removed?.length ?? 0)}개를 되돌림, 총 ${st.selection.size}개`);
        }
      } else if (k === 'G') {
        const g = await this.requestPoint('그룹 이름 입력:', { allowText: true }, signal);
        const name = 'text' in g ? g.text.trim() : '';
        if (name) {
          const grp = listGroups(st.doc).find((x) => x.name.toUpperCase() === name.toUpperCase());
          if (!grp) this.cmd.print(`그룹 "${name}"이(가) 없습니다.`, 'err');
          else {
            const hs = grp.group.entities.map((h) => normalizeHandle(h)).filter((h) => st.doc.entityIndex.has(h));
            step(this.expandPick(hs), mode);
            this.cmd.print(`${hs.length}개를 찾음`);
            picked = true;
          }
        }
      } else {
        const m = selectMethodOf(k);
        const pk = m ? this.picker() : null;
        if (m && pk) {
          const hs = await runSelectMethod(m, { getPoint: (p, o) => this.requestPoint(p, o, signal), print: (t, c) => this.cmd.print(t, c) }, pk);
          if (hs) {
            step(this.expandPick(hs), mode);
            this.cmd.print(`${hs.length}개를 찾음`);
            picked = true;
          }
        }
      }
      // 단일(SI): 한 번 고르면 끝
      if (single && picked) return done();
    }
  }

  /** 객체 선택 중 한 번의 고르기: 실제로 바뀐 것만 단계로 남긴다(U). replace(PICKADD 0)는 더한 것과 뺀 것을 한 단계로 */
  private selectStep(history: SelectStep[], hs: string[], mode: PickMode): void {
    const st = this.active;
    if (!st) return;
    const before = new Set(st.selection);
    this.setSelection(hs, mode);
    const added = [...st.selection].filter((h) => !before.has(h));
    const removed = [...before].filter((h) => !st.selection.has(h));
    if (mode === 'replace') {
      if (added.length || removed.length) history.push({ handles: added, mode: 'add', removed });
      return;
    }
    const changed = mode === 'add' ? added : removed;
    if (changed.length) history.push({ handles: changed, mode });
  }

  /** 마지막으로 만든 객체(L 옵션) */
  lastCreated: string[] = [];
  /** 파일이 연결된 래스터 이미지(열쇠 = 파일 이름 소문자) */
  readonly imageKeys = new Set<string>();
  /** 파일이 연결된 PDF 언더레이 페이지(열쇠 → 폭·높이, 인치) */
  readonly pdfPages = new Map<string, readonly [number, number]>();
  /** 선택한 객체의 그립(화면에 보이는 것) */
  gripList: { handle: string; id: string; point: Pt }[] = [];
  /**
   * 누른 그립(GRIPEDIT 명령이 쓴다). point = 누른 그립 점, items = 함께 움직일 그립(같은 점에 겹친 그립과
   * Shift+클릭으로 고른 다른 핫 그립 — 항목마다 제 그립 점)
   */
  hotGrip: { point: Pt; items: { handle: string; id: string; point: Pt }[] } | null = null;
  /** 파일을 연 뒤(빠진 글꼴 안내 등) */
  onOpened: ((st: DocState) => void) | null = null;
  /** 뷰포트 표(타일 뷰포트 구성)가 편집으로 바뀌었을 때(VPORTS가 연결한다) */
  onVportsChanged: ((st: DocState) => void) | null = null;

  /** 명령행에 글을 넣은 것처럼(투명 명령의 결과를 멈춘 프롬프트에 넣을 때 등) */
  submitInput(text: string): void {
    this.onInput(text);
  }

  /** 사람이 Enter를 누른 것처럼(오른쪽 클릭 메뉴의 입력): 동적 입력 칸을 잠갔으면 그 점 */
  acceptInput(): void {
    this.onInput('', true);
  }

  /** 지금 점 요청에 객체 스냅 재지정(END·FROM·M2P·TT·.X …)을 건다(바로 가기 메뉴). 점 요청이 아니거나 이름이 아니면 false */
  applyOverrideInput(key: string): boolean {
    const r = this.request;
    const ov = parseOverride(key);
    if (r?.kind !== 'point' || !ov) return false;
    this.cmd.print(`${this.promptOf(r)} ${key}`);
    void this.applyOverride(r, ov);
    return true;
  }

  private requestEntity(prompt: string, keywords: Keyword[], signal: AbortSignal, opt: EntityOptions = {}): Promise<EntityResult | EmptyPick> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CancelError());
      const req: EntityRequest = {
        kind: 'entity',
        prompt,
        keywords,
        emptyPick: !!opt.emptyPick,
        signal,
        resolve: (r) => {
          if (this.request === req) this.request = null;
          resolve(r);
        },
        reject,
      };
      this.request = req;
      this.cmd.setPrompt(this.promptOf(req));
      this.view.overlay.tip = prompt.replace(/\[.*$/, '').replace(/:\s*$/, '');
      signal.addEventListener('abort', () => this.dropRequest(req, reject), { once: true });
      this.view.requestOverlay();
    });
  }

  /**
   * 명령행 입력. interactive: 사람이 명령행·커서 옆에 친 입력(동적 입력의 상대 좌표 기본을 쓴다).
   * 스크립트·AutoLISP·submitInput은 늘 절대 좌표(AutoCAD처럼 동적 입력과 무관)
   */
  private onInput(text: string, interactive = false): void {
    for (const f of this.inputFilters) if (f.input(text, this.request)) return;
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
        // 다중(M): 모아 둔 것을 더하고 선택 프롬프트로 돌아간다
        if (r.multiple) {
          const hs = this.expandPick(r.multiple);
          r.multiple = null;
          this.selectStep(r.history, hs, r.remove ? 'remove' : 'add');
          this.cmd.print(`${hs.length}개를 찾음, 총 ${this.active?.selection.size ?? 0}개`);
          if (r.single) r.resolve({ handles: [...(this.active?.selection ?? [])] });
          return;
        }
        r.resolve({ handles: [...(this.active?.selection ?? [])] });
        return;
      }
      // 객체 선택 중에도 투명 명령('FILTER 등)
      if (t.startsWith("'")) {
        void this.run(t.slice(1));
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
      this.cmd.print(`*잘못된 선택* ${SELECT_HELP}`, 'err');
      return;
    }
    // 동적 입력 칸을 잠갔으면 Enter·값으로 그 칸들을 합친 점
    if (r.kind === 'point' && this.dynOn && interactive && this.dyn.locked) {
      const st = this.active;
      const p = st ? this.dyn.resolve(t, r.base, this.cursorWorld, currentUcs(st), st.units.aunits) : null;
      if (p) {
        if (this.outsideLimits(p)) return;
        this.cmd.print(`${this.promptOf(r)} ${[...this.dyn.locks.filter((x) => x !== null), t].filter(Boolean).join(' ')}`);
        this.lastPoint = p;
        this.finishPoint(r, { point: p, snap: null });
        return;
      }
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
        remember(this.recentInputs, t);
        r.resolve({ text: t });
        return;
      }
      // 객체 스냅 재지정(END·FROM·M2P·TT·.X …): 글을 받는 프롬프트에서는 글 그대로
      const ov = r.freeText ? null : parseOverride(t);
      if (ov) {
        this.cmd.print(`${this.promptOf(r)} ${t}`);
        void this.applyOverride(r, ov);
        return;
      }
      const p = this.parsePoint(r, interactive && this.dynOn && r.base ? dynRelative(t) : t);
      if (p) {
        if (this.outsideLimits(p)) return;
        this.cmd.print(`${this.promptOf(r)} ${t}`);
        remember(this.recentInputs, t);
        this.lastPoint = p;
        this.finishPoint(r, { point: p, snap: null });
        return;
      }
      if (r.allowText) {
        remember(this.recentInputs, t);
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
    // 객체 프롬프트에서 빈 곳을 받는 요청(emptyPick)은 좌표 입력도 점으로
    if (r.emptyPick) {
      const p = this.parsePoint(null, interactive && this.dynOn && this.lastPoint ? dynRelative(t) : t);
      if (p) {
        this.cmd.print(`${this.promptOf(r)} ${t}`);
        this.lastPoint = p;
        r.resolve({ point: p, empty: true });
        return;
      }
    }
    this.cmd.print('객체를 선택하거나 옵션을 입력하십시오.', 'err');
  }

  /** 좌표 글 읽기: 현재 UCS(* 로 시작하면 WCS), @는 기준점(없으면 마지막 점)에서, 숫자 하나는 커서 방향 직접 거리 */
  private parsePoint(r: PointRequest | null, t: string): Pt | null {
    const base = r?.base ?? null;
    const dir = this.cursorWorld && base ? { x: this.cursorWorld.x - base.x, y: this.cursorWorld.y - base.y } : null;
    const u = currentUcs(this.active);
    const wcs = t.startsWith('*');
    const conv = !wcs && !isWorld(u);
    const lastW = base ?? this.lastPoint;
    const pu = parsePointInput(wcs ? t.slice(1) : t, lastW && conv ? toUcs(u, lastW) : lastW, dir && conv ? dirToUcs(u, dir) : dir);
    return pu && conv ? toWcs(u, pu) : pu;
  }

  /** 점 요청을 점으로 끝낸다(그 요청의 스냅 재지정·임시 추적점도 끝) */
  private finishPoint(r: PointRequest, res: PointResult): void {
    if (this.snapOverride?.req === r) this.snapOverride = null;
    if (this.tempTrack?.req === r) {
      this.tempTrack = null;
      this.refreshAcquired();
    }
    r.resolve(res);
  }

  /**
   * 객체 스냅 재지정: 스냅은 다음 한 점에만 쓰고, TT는 임시 추적점을 더하고, FROM·M2P·점 필터는 점을 더 물어 그 점으로 끝낸다.
   * 더 묻는 동안 Esc는 명령 전체를 취소한다(AutoCAD와 같다)
   */
  private async applyOverride(r: PointRequest, ov: Override): Promise<void> {
    const back = () => {
      if (r.signal.aborted) return false;
      this.request = r;
      this.cmd.setPrompt(this.promptOf(r));
      this.view.overlay.tip = r.prompt.replace(/\[.*$/, '').replace(/:\s*$/, '');
      this.view.requestOverlay();
      return true;
    };
    if (ov.kind === 'snap') {
      this.snapOverride = { req: r, modes: new Set(ov.modes) };
      // AutoCAD처럼 "대상:"을 묻는다(NON은 원래 프롬프트)
      if (ov.modes.length) this.cmd.setPrompt('대상:');
      if (this.lastMove) this.onMove(this.lastMove.w, this.lastMove.s, this.lastMove.ev, true);
      return;
    }
    try {
      if (ov.kind === 'tt') {
        const q = await this.requestPoint('임시 OTRACK 점 지정:', {}, r.signal);
        if (!back()) return;
        if ('point' in q) {
          if (this.tempTrack?.req !== r) this.tempTrack = { req: r, points: [] };
          this.tempTrack.points.push({ p: q.point, label: '임시 추적점' });
          this.refreshAcquired();
        }
        return;
      }
      const st = this.active;
      const p = await runPointOverride(ov, {
        getPoint: (prompt, o) => this.requestPoint(prompt, o ?? {}, r.signal),
        print: (t, c) => this.cmd.print(t, c),
        ucs: currentUcs(st),
      });
      if (!back()) return;
      if (p) {
        if (this.outsideLimits(p)) return;
        this.lastPoint = p;
        this.finishPoint(r, { point: p, snap: null });
      }
    } catch (e) {
      // 더 묻는 중에 취소하면 명령도 취소
      if (!(e instanceof CancelError) || r.signal.aborted) return;
      if (this.request === r || !this.request) {
        this.request = null;
        r.reject(new CancelError());
      }
    }
  }

  // -------------------------------------------------------------------------
  // 문서
  // -------------------------------------------------------------------------

  async openFile(name: string, data: ArrayBuffer): Promise<DocState | null> {
    const size = data.byteLength;
    this.ui.setBusy(`${name} 여는 중…`, 0);
    // 점진 빌드: 장면을 만드는 동안 오는 조각을 먼저 그린다(문서·장면이 다 오면 탭을 연다)
    const preview = new LoadPreview(this.view.renderer);
    const showPreview = () => {
      this.ui.showStart(false);
      this.ui.setBusySeeThrough?.(true);
      this.view.setLoadPreview(preview);
    };
    try {
      const res = await this.engine.open(
        name,
        data,
        (stage, f) => {
          const label = stage === 'read' ? '도면 읽는 중' : stage === 'fonts' ? '글꼴 받는 중' : stage === 'build' ? '화면 그리는 중' : stage === 'scene' || stage === 'document' ? '도면 정보 받는 중' : '처리 중';
          this.ui.setBusy(`${label}…`, stage === 'read' ? f * 0.6 : stage === 'fonts' ? 0.62 : stage === 'build' ? 0.64 + f * 0.26 : stage === 'document' ? 0.9 + f * 0.1 : 0.9);
        },
        (part, view) => {
          const first = preview.empty;
          preview.add(part, view);
          if (first && !preview.empty) showPreview();
          this.view.requestRender();
        },
        { width: this.view.width, height: this.view.height },
      );
      this.view.setLoadPreview(null);
      preview.dispose();
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
      this.view.setLoadPreview(null);
      preview.dispose();
      this.ui.showStart(!this.active);
      this.ui.setBusy(null);
    }
  }

  /** 워커가 읽었거나 받아 둔 문서를 탭으로 연다 */
  addDocument(res: OpenResult, name: string, size: number): DocState {
    const st = new DocState(res.docId, res.doc, name, size, res.readMs);
    st.addScene(this.view.renderer, res.model, MODEL_SPACE);
    this.edits.attach(st);
    bindCommitHooks(this, st);
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
    // *Active가 여럿이면 타일 뷰포트로 연다
    if (st.doc.vports.filter((v) => v.name.toUpperCase() === '*ACTIVE').length > 1 && this.onVportsChanged) {
      this.onVportsChanged(st);
      if (st.tiles) return;
    }
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
    document.title = st ? `${st.name} - OpenCAD DWG·DXF`
      : document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? 'OpenCAD DWG·DXF';
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

  /** 객체 위 풍선말(하이퍼링크 등). 없으면 null */
  hoverTip: ((handle: string) => string | null) | null = null;
  /** Ctrl+클릭한 객체를 처리했으면 true(하이퍼링크 열기) */
  linkClick: ((handle: string) => boolean) | null = null;

  /** 문서를 닫은 뒤(자동 저장본 지우기 등) */
  onClosed: ((st: DocState) => void) | null = null;

  private closeNow(st: DocState): void {
    const i = this.docs.indexOf(st);
    if (i < 0) return;
    this.docs.splice(i, 1);
    this.onClosed?.(st);
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
          expandXrefBounds(this, st, key);
        })
        .finally(() => {
          st.buildPending.delete(key);
          this.ui.setBusy(null);
        });
      st.buildPending.set(key, p);
    }
    await p;
  }

  /** MSPACE에서 뷰포트 확대·이동: 뷰를 곧바로 바꾸고, 멈추면 한 번의 편집(명령 취소 한 단계)으로 기록한다 */
  private vpViewPending: { st: DocState; layout: string; before: ViewportEntity; timer: number } | null = null;

  private onViewportView(vp: ViewportEntity, patch: Pick<ViewportEntity, 'viewHeight' | 'viewCenter'>): void {
    const st = this.active;
    if (!st?.msVp) return;
    let p = this.vpViewPending;
    if (p && (p.st !== st || p.before.handle !== vp.handle)) {
      this.flushViewportView();
      p = null;
    }
    if (!p) p = this.vpViewPending = { st, layout: st.msVp.layout, before: { ...vp, viewCenter: { ...vp.viewCenter } }, timer: 0 };
    vp.viewHeight = patch.viewHeight;
    vp.viewCenter = { ...patch.viewCenter };
    clearTimeout(p.timer);
    p.timer = window.setTimeout(() => this.flushViewportView(), 500);
  }

  /** 미뤄 둔 뷰포트 뷰 변경을 기록한다 */
  flushViewportView(): void {
    const p = this.vpViewPending;
    if (!p) return;
    this.vpViewPending = null;
    clearTimeout(p.timer);
    const cur = p.st.doc.entityIndex.get(p.before.handle);
    if (!cur || cur.type !== 'VIEWPORT') return;
    const after = { ...cur, viewCenter: { ...cur.viewCenter } };
    // 지금 객체는 이미 바뀌어 있으므로 원래 값으로 되돌린 뒤 편집으로 적용한다
    Object.assign(cur, { viewHeight: p.before.viewHeight, viewCenter: p.before.viewCenter });
    p.st.session.commit({ label: 'ZOOM', ops: [{ kind: 'modify', block: p.layout, before: p.before, after }] });
  }

  /** 배치의 뷰포트로 들어가 모형을 다룬다(MSPACE). 비틀린 뷰포트는 아직 못 들어간다 */
  enterViewport(st: DocState, vp: ViewportEntity): boolean {
    if (vp.twistAngle) {
      this.cmd.print('비틀린 뷰포트는 아직 모형 공간으로 들어갈 수 없습니다.', 'err');
      return false;
    }
    const layout = st.msVp?.layout ?? st.space;
    if (!st.layoutFor(layout) || layout === MODEL_SPACE) return false;
    this.flushViewportView();
    if (st.msVp?.handle === vp.handle) return true;
    this.cancel(true);
    st.msVp = { layout, handle: vp.handle };
    st.space = MODEL_SPACE;
    st.selection.clear();
    this.view.setState(st);
    this.ui.refreshLayouts();
    this.ui.refreshStatus();
    this.ui.refreshPalette();
    this.refreshSelectionOverlay();
    return true;
  }

  /** 뷰포트에서 나와 종이 공간으로(PSPACE) */
  exitViewport(st: DocState): void {
    if (!st.msVp) return;
    this.flushViewportView();
    this.cancel(true);
    st.space = st.msVp.layout;
    st.msVp = null;
    st.selection.clear();
    this.view.setState(st);
    this.ui.refreshLayouts();
    this.ui.refreshStatus();
    this.ui.refreshPalette();
    this.refreshSelectionOverlay();
  }

  /** 모형·배치 전환 */
  async setSpace(space: string): Promise<void> {
    const st = this.active;
    if (!st) return;
    const key = tableKey(space);
    if (st.msVp) {
      this.flushViewportView();
      const lay = st.msVp.layout;
      st.msVp = null;
      st.space = lay;
      if (key === lay) {
        this.view.setState(st);
        this.ui.refreshLayouts();
        this.ui.refreshStatus();
        return;
      }
    }
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
    if (!st || !st.isModel || st.msVp || !st.scenes.get(st.space)) return this.dropDetail();
    const cam = this.view.camera();
    // 기본 장면의 현-곡선 오차가 0.6픽셀을 넘을 때만
    if (spaceTolerance(st.doc, st.space) * cam.scale < 0.6) return this.dropDetail();
    const vis = this.view.visibleWorld();
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
    const list = block.entities.filter((e) => want.has(e.handle) && !st.hiddenObjects.has(e.handle));
    const scene = new OverlayScene(this.view.renderer, st.doc, list, this.text, st.space, 0.3 / cam.scale, this.imageKeys, this.pdfPages);
    this.dropDetail();
    this.view.detail = { docId: st.docId, space: st.space, gen: st.gen, region, scale: cam.scale, scene };
    this.view.requestRender();
  }

  /** 객체 숨기기·격리(HIDEOBJECTS·ISOLATEOBJECTS): 이 객체들을 그리지도 고르지도 않는다. 빈 목록이면 모두 보인다 */
  setHiddenObjects(st: DocState, handles: Iterable<string>): void {
    st.hiddenObjects.clear();
    for (const h of handles) st.hiddenObjects.add(h);
    for (const h of st.hiddenObjects) st.selection.delete(h);
    this.engine.hide(st.docId, [...st.hiddenObjects]);
    this.dropDetail();
    this.edits.rebuildEverything(st);
    this.ui.refreshStatus();
    this.refreshSelectionOverlay();
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

  /** 고를 수 있는 객체만 남기는 고리(참조 편집: 작업 세트에 없는 객체 잠금) */
  selectionFilter: ((handles: string[]) => string[]) | null = null;

  setSelection(handles: Iterable<string>, mode: 'replace' | 'add' | 'remove' = 'replace'): void {
    const st = this.active;
    if (!st) return;
    if (mode !== 'remove' && this.selectionFilter) handles = this.selectionFilter([...handles]);
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

  /**
   * 설정을 다시 읽어 화면(view.prefs·선택 상자)에 넣는다. name: 바뀐 변수 — 지금 보이는 그립·미리보기를 그에 맞게 고친다
   * (없으면 처음 읽기)
   */
  applySettings(name?: string): void {
    this.settings = readSettings(optionValue);
    const v = this.view;
    v.prefs = this.settings;
    if (!name || name === 'PICKBOX') v.overlay.pickbox = this.settings.pickbox;
    if (!name) return;
    if (name === 'GRIPS' || name === 'GRIPSIZE') {
      this.clearGripHover();
      if (!gripsOn(this.settings.grips)) {
        this.hotGrips = [];
        v.overlay.hotGrips = [];
      }
      this.refreshSelectionOverlay();
    } else if (name === 'SELECTIONPREVIEW') {
      this.clearHover();
      v.overlay.preview = [];
    }
    v.requestOverlay();
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
        // 그립(GRIPS 0이면 보이지도, 누르지도 않는다)
        if (st.selection.size <= 200 && gripsOn(this.settings.grips)) {
          // 객체별 그립(편집 커널): 누르면 그립 편집(신축·이동·회전·축척·대칭)
          for (const h of st.selection) {
            const e = st.doc.entityIndex.get(h);
            if (!e) continue;
            try {
              for (const g of gripPoints(e, st.doc)) this.gripList.push({ handle: h, id: g.id, point: g.point });
            } catch {
              /* 그립이 없는 객체 */
            }
            if (e.type === 'INSERT') {
              try {
                for (const g of dynGrips(st.doc, e)) this.gripList.push({ handle: h, id: g.id, point: g.point });
              } catch {
                /* 동적 블록 정의를 읽지 못함 */
              }
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

  /** 지금 점 요청에서 쓸 객체 스냅(재지정이 있으면 그것, 객체 스냅이 꺼져 있으면 null) */
  private snapModesFor(r: Request | null): ReadonlySet<SnapKind> | null {
    if (r?.kind !== 'point') return null;
    if (this.snapOverride?.req === r) return this.snapOverride.modes;
    return this.osnapOn ? this.snapModes : null;
  }

  /** 스냅·추적·직교를 적용한 점(동적 입력 칸을 잠갔으면 그 값에 묶는다) */
  private resolvePoint(w: Pt): ResolvedPoint {
    const r = this.request;
    if (r?.kind !== 'point') return { p: w, snap: null };
    return this.dynLock(r, this.resolveRaw(r, w));
  }

  private resolveRaw(r: PointRequest, w: Pt): ResolvedPoint {
    const st = this.active!;
    const pk = this.picker();
    const modes = this.snapModesFor(r);
    if (pk && modes?.size) {
      // 조준창(APERTURE, 픽셀)
      const aperture = this.settings.aperture * this.view.pixelSize();
      const s = findSnap(st.doc, pk, w, aperture, modes, r.base, { ext: this.extAnchors, par: this.parDirs.map((d) => d.dir) });
      if (s) {
        const p = { x: s.x, y: s.y };
        // 연장선·평행은 정렬선을 함께 보인다
        const track = s.lines?.length ? { p, lines: s.lines, tip: SNAP_NAMES[s.kind] ?? '' } : undefined;
        return { p, snap: { p, kind: s.kind, handle: s.handle, handle2: s.handle2 }, track };
      }
    }
    // 확장 지점: 객체 스냅이 없으면 고리가 추적·격자 스냅·직교를 대신할 수 있다(등각투영 제도)
    for (const f of this.pointFilters) {
      const res = f.resolve(w, { base: r.base, acquired: this.acquired });
      if (res) return res;
    }
    const tol = 8 * this.view.pixelSize();
    const fmt = (v: number) => formatLength(v, st.units);
    // Shift를 누르는 동안 직교를 뒤집는다(켜져 있으면 끄고, 꺼져 있으면 켠다)
    const ortho = this.orthoOn !== this.shiftHeld;
    // 극좌표 각도는 UCS X축 기준
    const ua = currentUcs(st).angle;
    const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const pa = this.polarOn && !ortho ? polarAngles(this.polarInc).map((a) => norm(a + ua)) : null;
    // 획득점: 객체 스냅 추적이 켜져 있으면 획득한 점, 임시 추적점(TT)은 꺼져 있어도
    const temp = this.tempTrack?.req === r ? this.tempTrack.points : [];
    const acq = [...(this.otrackOn ? this.acquired : []), ...temp];
    if (acq.length) {
      // 획득점에서는 수평·수직(극좌표가 켜져 있으면 그 각도들도)
      const t = objectTrack(acq, w, pa ?? polarAngles(Math.PI / 2).map((a) => norm(a + ua)), tol, r.base, pa, fmt);
      if (t) return { p: t.p, snap: null, track: t };
    }
    if (r.base && pa) {
      const t = polarTrack(r.base, w, pa, tol, fmt);
      if (t) return { p: t.p, snap: null, track: t };
    }
    // 격자 스냅(객체 스냅·추적이 먼저)
    if (this.snapOn) w = this.snapToGrid(w);
    if (r.base && ortho) {
      // 직교는 UCS 축 방향
      const u = currentUcs(st);
      const d = dirToUcs(u, { x: w.x - r.base.x, y: w.y - r.base.y });
      const keep = Math.abs(d.x) >= Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
      const c = Math.cos(u.angle);
      const sn = Math.sin(u.angle);
      return { p: { x: r.base.x + keep.x * c - keep.y * sn, y: r.base.y + keep.x * sn + keep.y * c }, snap: null };
    }
    return { p: w, snap: null };
  }

  /** 동적 입력 칸을 잠갔으면 점을 그 값(거리·각도 또는 X·Y)에 묶는다 */
  private dynLock(r: PointRequest, res: ResolvedPoint): ResolvedPoint {
    const st = this.active;
    if (!st || !this.dynOn || !this.dyn.locked) return res;
    return { p: this.dyn.constrain(r.base, res.p, currentUcs(st), st.units.aunits), snap: null };
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
        this.refreshAcquired();
        this.view.requestOverlay();
      }, 450),
    };
  }

  /**
   * 연장선(EXT)·평행(PAR) 획득: 선·호·열린 폴리선의 끝점 위에 잠시 머물면 연장선 획득점, 기준점이 있을 때 선분 위에 머물면 평행 방향.
   * 같은 끝점·방향은 한 번만, 연장선은 네 개·평행은 두 개까지(오래된 것부터 버린다)
   */
  private updateExtPar(w: Pt): void {
    const r = this.request;
    const modes = this.snapModesFor(r);
    const pk = this.picker();
    const wantExt = !!modes?.has('ext');
    const wantPar = !!modes?.has('par') && r?.kind === 'point' && !!r.base;
    if (!pk || (!wantExt && !wantPar)) return this.dropExtCandidate();
    const ap = this.settings.aperture * this.view.pixelSize();
    const a = wantExt ? findExtAnchor(pk, w, ap) : null;
    const d = !a && wantPar ? segmentDirAt(pk, w, ap * 0.6) : null;
    const key = a ? `e${a.p.x},${a.p.y}` : d ? `p${d.dir.x.toFixed(9)},${d.dir.y.toFixed(9)}` : '';
    if (!key) return this.dropExtCandidate();
    if (this.extCandidate?.key === key) return;
    this.dropExtCandidate();
    this.extCandidate = {
      key,
      timer: window.setTimeout(() => {
        this.extCandidate = null;
        if (this.request !== r) return;
        if (a && !this.extAnchors.some((x) => samePt(x.p, a.p))) {
          this.extAnchors.push(a);
          if (this.extAnchors.length > 4) this.extAnchors.shift();
        }
        if (d && !this.parDirs.some((x) => Math.abs(x.dir.x * d.dir.y - x.dir.y * d.dir.x) < 1e-9)) {
          this.parDirs.push(d);
          if (this.parDirs.length > 2) this.parDirs.shift();
        }
        this.refreshAcquired();
        this.view.requestOverlay();
      }, 400),
    };
  }

  private dropExtCandidate(): void {
    if (this.extCandidate) clearTimeout(this.extCandidate.timer);
    this.extCandidate = null;
  }

  /** 획득점 표시(+): 객체 스냅 추적·임시 추적점·연장선·평행 */
  private refreshAcquired(): void {
    const temp = this.tempTrack && this.tempTrack.req === this.request ? this.tempTrack.points : [];
    this.view.overlay.acquired = [...this.acquired.map((a) => a.p), ...temp.map((a) => a.p), ...this.extAnchors.map((a) => a.p), ...this.parDirs.map((d) => d.at)];
  }

  private clearTracking(): void {
    this.acquired = [];
    if (this.acqCandidate) clearTimeout(this.acqCandidate.timer);
    this.acqCandidate = null;
    this.extAnchors = [];
    this.parDirs = [];
    this.dropExtCandidate();
    this.view.overlay.acquired = [];
    this.view.overlay.tracks = [];
  }

  /** Shift를 누르고 뗄 때(키보드): 임시 직교가 바로 보이게 마지막 커서 점을 다시 해석한다 */
  private setShift(on: boolean): void {
    if (this.shiftHeld === on) return;
    this.shiftHeld = on;
    const m = this.lastMove;
    if (m && this.request?.kind === 'point') this.onMove(m.w, m.s, m.ev, true);
  }

  /** 동적 입력 칸(점 요청, 동적 입력이 켜져 있고 숫자·글 프롬프트가 아닐 때) */
  private updateDynFields(p?: Pt): void {
    const o = this.view.overlay;
    const r = this.request;
    const st = this.active;
    const q = p ?? this.lastResolved ?? this.cursorWorld;
    if (!st || !this.dynOn || r?.kind !== 'point' || r.allowText || !o.cursor || !q) {
      o.dynFields = null;
      return;
    }
    o.dynFields = this.dyn.fields(r.base, q, this.cmd.input.value, currentUcs(st), (v) => formatLength(v, st.units));
  }

  /** 마지막으로 해석한 커서 점(동적 입력 칸) */
  private lastResolved: Pt | null = null;

  private onMove(w: Pt, s: Pt, ev: PointerEvent, fromKey = false): void {
    const o = this.view.overlay;
    o.cursor = ev.pointerType === 'touch' ? null : s;
    this.cursorWorld = w;
    this.lastMove = { w, s, ev };
    if (!fromKey) this.shiftHeld = ev.shiftKey;
    const st = this.active;
    if (!st) return;
    const r = this.request;
    if (r?.kind === 'point') this.updateExtPar(w);
    const { p, snap, track } = this.resolvePoint(w);
    this.lastResolved = p;
    o.snap = snap;
    o.tracks = track ? track.lines.map((l) => ({ from: l.from, dir: l.dir })) : [];
    this.updateAcquire(snap);
    if (r?.kind === 'point') {
      // 끌기 미리보기(DRAGMODE)가 꺼져 있으면 명령의 미리보기 대신 기준점 고무줄만
      const drag = this.dragPreviewOn(r);
      o.rubber = r.rubber && drag ? r.rubber(p) : r.base ? [{ pts: [r.base.x, r.base.y, p.x, p.y], dashed: false }] : [];
      o.ghost = r.ghost && drag ? r.ghost(p) : [];
      this.updateDynFields(p);
      // 툴팁: 객체 스냅 이름(AUTOSNAP 4), 추적 거리·각도(AUTOSNAP 32). 끄면 그 자리에 보통 문구
      const as = this.settings.autosnap;
      if (snap && showSnapTip(as)) o.tip = SNAP_NAMES[snap.kind] ?? null;
      else if (track && !snap && showTrackTip(as)) o.tip = track.tip;
      else if (!this.dynOn) o.tip = null;
      else if (r.base && !o.dynFields) {
        const d = Math.hypot(p.x - r.base.x, p.y - r.base.y);
        let a = (Math.atan2(p.y - r.base.y, p.x - r.base.x) * 180) / Math.PI;
        if (a < 0) a += 360;
        o.tip = `${formatLength(d, st.units)} < ${a.toFixed(1)}°`;
      } else o.tip = r.prompt.replace(/\[.*$/, '').replace(/:\s*$/, '');
    }
    if (this.windowStart) {
      o.windowRect = { a: this.windowStart.screen, b: s };
      this.updateSelectPreview();
    }
    const pu = toUcs(currentUcs(st), p);
    this.ui.setCoords(`${formatLength(pu.x, st.units)}, ${formatLength(pu.y, st.units)}, ${formatLength(0, st.units)}`);
    // 다기능 그립: 선택한 객체의 그립 위(명령 없음)
    if (!r && !this.running && !this.press) this.updateGripHover(w, ev);
    // 선택 미리보기(가만히 있을 때)
    if (!r && !this.windowStart && !this.press && ev.pointerType !== 'touch') {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => this.updateHover(w), 40);
    } else if (r?.kind === 'entity' || r?.kind === 'select') {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => this.updateHover(w), 30);
    }
    this.view.requestOverlay();
  }

  // ------------------------------------------------------------------------- 다기능 그립

  /** 커서 근처의 그립(그립 상자보다 2픽셀 넉넉히 — GRIPSIZE 5에서 6픽셀, 터치는 두 배) */
  private gripAt(w: Pt, touch = false): { handle: string; id: string; point: Pt } | null {
    if (!this.gripList.length) return null;
    const gt = gripPickRadius(this.settings.gripSize, touch) * this.view.pixelSize();
    let best: { handle: string; id: string; point: Pt } | null = null;
    let bd = Infinity;
    for (const g of this.gripList) {
      const d = Math.hypot(g.point.x - w.x, g.point.y - w.y);
      if (d <= gt && d < bd) {
        bd = d;
        best = g;
      }
    }
    return best;
  }

  /** 그립 위에 커서가 오면 분홍, 약 0.5초 머물면 다기능 그립 메뉴(항목이 있을 때). 메뉴는 그립에서 멀어지면 닫는다 */
  private updateGripHover(w: Pt, ev: PointerEvent): void {
    const g = ev.pointerType !== 'touch' && this.active?.selection.size ? this.gripAt(w) : null;
    const cur = this.hoverGrip;
    if (g && cur && samePt(cur.point, g.point)) return;
    if (cur) {
      clearTimeout(cur.timer);
      if (cur.shown) {
        // 커서를 메뉴로 옮기는 동안은 둔다
        if (!g && Math.hypot(w.x - cur.point.x, w.y - cur.point.y) <= 40 * this.view.pixelSize()) return;
        closeMenu();
      }
    }
    if (!g && !cur) return;
    const cx = ev.clientX;
    const cy = ev.clientY;
    this.hoverGrip = g ? { point: g.point, shown: false, timer: window.setTimeout(() => this.showGripMenu(g.point, cx, cy), 500) } : null;
    this.view.overlay.hoverGrip = g ? g.point : null;
    this.view.requestOverlay();
  }

  private clearGripHover(): void {
    if (this.hoverGrip) clearTimeout(this.hoverGrip.timer);
    this.hoverGrip = null;
    if (this.view.overlay.hoverGrip) {
      this.view.overlay.hoverGrip = null;
      this.view.requestOverlay();
    }
  }

  /** 그 점의 그립들에 고리(App.gripMenuProviders)가 붙인 메뉴 항목(같은 이름은 한 번) */
  gripMenuItems(point: Pt): ContextMenuItem[] {
    const st = this.active;
    if (!st) return [];
    const out: ContextMenuItem[] = [];
    const seen = new Set<string>();
    for (const g of this.gripList) {
      if (!samePt(g.point, point)) continue;
      const e = st.doc.entityIndex.get(g.handle);
      if (!e) continue;
      for (const pv of this.gripMenuProviders) {
        for (const it of pv.items(g, e, st) ?? []) {
          if (seen.has(it.label)) continue;
          seen.add(it.label);
          out.push({ label: it.label, run: () => void it.run() });
        }
      }
    }
    return out;
  }

  private showGripMenu(point: Pt, x: number, y: number): void {
    const h = this.hoverGrip;
    if (!h || !samePt(h.point, point) || this.request || this.running) return;
    const items = this.gripMenuItems(point);
    if (!items.length) return;
    h.shown = true;
    this.view.el.title = '';
    showContextMenu(x + 6, y + 6, items);
  }

  /** 이 점 요청에서 명령의 끌기 미리보기(ghost·rubber)를 보이는지: 자동(2)이거나, 켜기(1)이고 이 요청에서 DRAG를 입력했을 때 */
  private dragPreviewOn(r: PointRequest): boolean {
    const m = this.dragPreviewMode ? this.dragPreviewMode() : 2;
    return m === 2 || (m === 1 && this.dragFor === r);
  }

  /** DRAG: 지금(마지막) 점 요청에서 끌기 미리보기를 보인다(DRAGMODE 켜기일 때 쓴다) */
  dragPreviewNow(): void {
    this.dragFor = this.lastPointRequest;
    this.view.requestOverlay();
  }

  private updateHover(w: Pt): void {
    const pk = this.picker();
    if (!pk) return;
    const h = pk.pick(w.x, w.y, this.view.overlay.pickbox * this.view.pixelSize());
    if (h === this.hoverHandle) return;
    this.hoverHandle = h;
    // 호버 강조는 선택 미리보기(SELECTIONPREVIEW)가 켜져 있을 때만(하이퍼링크 툴팁은 그대로)
    const show = previewOn(this.settings.selectionPreview, !!this.request || !!this.running);
    this.view.overlay.hover = show && h && !this.active?.selection.has(h) ? pk.geometry(h) : null;
    this.view.el.title = h && this.hoverTip && !this.request ? (this.hoverTip(h) ?? '') : '';
    this.view.requestOverlay();
  }

  /** 종이 좌표의 점이 든 뷰포트(가장 앞) */
  viewportAt(st: DocState, p: Pt): ViewportEntity | null {
    const lay = st.layoutFor(st.displaySpace);
    if (!lay) return null;
    const vps = layoutViewports(st.doc, lay);
    for (let i = vps.length - 1; i >= 0; i--) {
      const v = vps[i]!;
      if (Math.abs(p.x - v.center.x) <= v.width / 2 && Math.abs(p.y - v.center.y) <= v.height / 2) return v;
    }
    return null;
  }

  private onClick(w: Pt, s: Pt, ev: PointerEvent): void {
    closeMenu();
    this.press = null;
    const st = this.active;
    if (!st) return;
    if (st.msVp) {
      // MSPACE: 활성 뷰포트 밖을 누르면 그 자리의 뷰포트를 활성으로(없으면 무시)
      const pp = this.view.paperPoint(s.x, s.y);
      const at = this.viewportAt(st, pp);
      if (!at) return;
      if (at.handle !== st.msVp.handle) {
        if (this.request) {
          this.flushViewportView();
          if (!at.twistAngle) st.msVp.handle = at.handle;
          this.view.requestRender();
          this.view.requestOverlay();
        } else this.enterViewport(st, at);
        return;
      }
    }
    const r = this.request;
    if (r?.kind === 'point') {
      this.shiftHeld = ev.shiftKey;
      const { p, snap } = this.resolvePoint(w);
      // 스냅 재지정(NON 말고)이 잡히지 않은 곳이면 다시 묻는다
      const ov = this.snapOverride?.req === r ? this.snapOverride.modes : null;
      if (ov?.size && !snap && !(this.dynOn && this.dyn.locked)) {
        this.cmd.print('객체 스냅 점을 찾지 못했습니다. 다시 지정하십시오.', 'err');
        return;
      }
      if (this.outsideLimits(p)) return;
      this.lastPoint = p;
      this.finishPoint(r, { point: p, snap: snap ? { kind: snap.kind, handle: snap.handle, handle2: snap.handle2 } : null, ...(ev.shiftKey ? { shift: true } : {}), ...(ev.ctrlKey || ev.metaKey ? { ctrl: true } : {}) });
      return;
    }
    const pk = this.picker();
    if (!pk) return;
    const tol = this.view.overlay.pickbox * this.view.pixelSize() * (ev.pointerType === 'touch' ? 3 : 1);
    const shift = ev.shiftKey ? { shift: true as const } : {};
    if (r?.kind === 'entity') {
      const h = pk.pick(w.x, w.y, tol);
      if (h) r.resolve({ handle: h, point: w, ...shift });
      else if (r.emptyPick) {
        this.lastPoint = w;
        r.resolve({ point: w, empty: true, ...shift });
      }
      return;
    }
    if (r?.kind === 'select') {
      if (this.windowStart?.viaClick) {
        this.finishWindow(this.windowStart.screen, s, ev, r.remove);
        return;
      }
      const pickIt = (h: string) => {
        this.clearHover();
        // 다중(M): 강조 없이 모았다가 Enter로 더한다
        if (r.multiple) {
          if (!r.multiple.includes(h)) r.multiple.push(h);
          this.cmd.print('1개를 찾음');
          return;
        }
        // PICKADD: 1·2 더하기(Shift 빼기), 0 바꾸기(Shift 더하기)
        this.pickedInSelect(r, this.expandPick([h]), pickMode(this.settings.pickadd, { shift: ev.shiftKey, removing: r.remove }));
      };
      if (this.cycleMenu(pk, w, tol, ev, pickIt)) return;
      const h = pk.pick(w.x, w.y, tol);
      if (h) {
        pickIt(h);
        return;
      }
      // 빈 곳: 창 선택 시작(PICKAUTO 1). 끄면 W·C 같은 선택 방식을 쳐야 한다
      if (!autoWindow(this.settings.pickauto, true)) {
        this.cmd.print(`*잘못된 선택* ${SELECT_HELP}`, 'err');
        return;
      }
      this.windowStart = { screen: s, world: w, viaClick: true };
      this.previewAt = 0;
      this.view.overlay.windowRect = { a: s, b: s };
      this.view.requestOverlay();
      return;
    }
    // 선택
    if (this.windowStart?.viaClick) {
      this.finishWindow(this.windowStart.screen, s, ev);
      return;
    }
    // 그립: 누르면 그립 편집, Shift+클릭은 핫 그립 더하기·빼기
    if (!r && st.selection.size && this.gripList.length && !this.busyCommand) {
      const g = this.gripAt(w, ev.pointerType === 'touch');
      if (g) {
        this.clickGrip(g.point, ev.shiftKey);
        return;
      }
    }
    const h = pk.pick(w.x, w.y, tol);
    // Ctrl+클릭: 확장 지점(연관 배열 항목 고르기 등)이 먼저, 그다음 하이퍼링크를 따라간다
    if (h && (ev.ctrlKey || ev.metaKey) && !r && (this.entityClickHandlers.some((f) => f.click(h, w)) || this.linkClick?.(h))) return;
    const pickIt = (h: string) => {
      const hs = this.expandPick([h]);
      // PICKADD 1·2: 더하기(Shift로 누르면 고른 것은 빼고 아니면 더한다), 0: 바꾸기(Shift 더하기·빼기)
      this.setSelection(hs, pickMode(this.settings.pickadd, { shift: ev.shiftKey, selected: st.selection.has(h) }));
      this.clearHover();
    };
    if (h && this.cycleMenu(pk, w, tol, ev, pickIt)) return;
    if (h) {
      pickIt(h);
      return;
    }
    if (ev.pointerType === 'touch') {
      this.clearSelection();
      return;
    }
    // 빈 곳: 창 선택 시작(클릭-클릭, PICKAUTO 4)
    if (!autoWindow(this.settings.pickauto, false)) return;
    this.windowStart = { screen: s, world: w, viaClick: true };
    this.previewAt = 0;
    this.view.overlay.windowRect = { a: s, b: s };
    this.view.requestOverlay();
  }

  /**
   * 그립을 눌렀을 때. Shift면 핫 그립에 더하거나 빼고(명령은 시작하지 않는다), 아니면 그립 편집(GRIPEDIT):
   * 누른 그립이 핫 그립 가운데 하나면 모든 핫 그립을, 아니면 그 그립 하나를(같은 점에 겹친 그립은 함께) 넘긴다
   */
  private clickGrip(point: Pt, shift: boolean): void {
    this.clearGripHover();
    closeMenu();
    const i = this.hotGrips.findIndex((p) => samePt(p, point));
    if (shift) {
      if (i >= 0) this.hotGrips.splice(i, 1);
      else this.hotGrips.push(point);
      this.view.overlay.hotGrips = [...this.hotGrips];
      this.view.requestOverlay();
      return;
    }
    const points = i >= 0 ? [...this.hotGrips] : [point];
    const items = this.gripList.filter((g) => points.some((p) => samePt(p, g.point))).map((g) => ({ handle: g.handle, id: g.id, point: g.point }));
    this.hotGrips = [];
    this.hotGrip = { point, items };
    this.view.overlay.hotGrips = points.filter((p) => !samePt(p, point));
    this.view.overlay.hotGrip = point;
    void this.run('GRIPEDIT');
  }

  /** 객체 선택 프롬프트에서 고른 것(단계로 남기고, 단일이면 끝) */
  private pickedInSelect(r: SelectRequest, hs: string[], mode: PickMode): void {
    this.selectStep(r.history, hs, mode);
    if (r.single && this.request === r) r.resolve({ handles: [...(this.active?.selection ?? [])] });
  }

  /** 왼쪽 버튼을 눌렀을 때(명령이 없거나 객체 선택 중): 그립·끌어 옮기기·창 가운데 무엇인지 정해 둔다 */
  private onDown(w: Pt, s: Pt, ev: PointerEvent): void {
    this.press = null;
    const st = this.active;
    const r = this.request;
    if (!st || ev.pointerType === 'touch' || (r && r.kind !== 'select') || this.windowStart?.viaClick) return;
    let kind: 'grip' | 'move' | 'window' = 'window';
    if (!r && !this.running && st.selection.size) {
      const onGrip = !!this.gripAt(w);
      const hit = onGrip ? null : (this.picker()?.pick(w.x, w.y, this.view.overlay.pickbox * this.view.pixelSize()) ?? null);
      kind = pressKind({ onGrip, hit, selected: st.selection, busy: false });
    }
    this.press = { kind, world: w, screen: s };
    this.previewAt = 0;
  }

  private onDrag(a: Pt, b: Pt, done: boolean, ev: PointerEvent): void {
    const st = this.active;
    // 그립을 눌러 끌기: 그립 편집을 시작하고, 놓은 곳을 그 점으로(클릭-클릭과 같은 결과)
    if (this.press?.kind === 'grip') {
      const pr = this.press;
      if (!pr.started) {
        pr.started = true;
        const g = this.gripAt(pr.world);
        if (g) this.clickGrip(g.point, false);
      }
      if (done) {
        this.press = null;
        if (this.request?.kind === 'point') this.onClick(this.view.screenToWorld(b.x, b.y), b, ev);
      }
      return;
    }
    if (!st || (this.request && this.request.kind !== 'select')) return;
    const pr = this.press ?? (this.press = { kind: 'window', world: this.view.screenToWorld(a.x, a.y), screen: { x: a.x, y: a.y } });
    this.clearGripHover();
    if (pr.kind === 'move') {
      this.dragMove(pr, b, done, ev);
      return;
    }
    const remove = this.request?.kind === 'select' ? this.request.remove : false;
    // 빈 곳을 누른 채 끌어 고르기는 PICKAUTO(객체 선택 프롬프트 1, 명령 프롬프트 4)가 켜져 있을 때만
    if (!this.windowStart && !autoWindow(this.settings.pickauto, this.request?.kind === 'select')) {
      if (done) this.press = null;
      return;
    }
    // 누른 채 끌기: 올가미(AutoCAD 기본), 끄면 직사각형 창
    if (this.lassoOn && !this.windowStart) {
      const lasso = pr.lasso ?? (pr.lasso = new Lasso(pr.screen));
      lasso.add(b);
      const o = this.view.overlay;
      o.lasso = { pts: lasso.pts, mode: lasso.mode };
      o.windowRect = null;
      this.cmd.setPrompt(`${lasso.label} 옵션을 순환하려면 스페이스바를 누르십시오.`);
      if (!done) {
        this.updateSelectPreview();
        this.view.requestOverlay();
        return;
      }
      this.press = null;
      o.lasso = null;
      o.preview = [];
      this.restorePrompt();
      if (!lasso.usable) {
        this.finishWindow(a, b, ev, remove);
        return;
      }
      const pk = this.picker();
      if (pk) this.applyPicked(this.expandPick(lasso.select(pk, (p) => this.view.screenToWorld(p.x, p.y))), pickMode(this.settings.pickadd, { shift: ev.shiftKey, removing: remove }));
      this.view.requestOverlay();
      return;
    }
    this.view.overlay.windowRect = { a, b };
    this.updateSelectPreview();
    this.view.requestOverlay();
    if (done) {
      this.press = null;
      this.finishWindow(a, b, ev, remove);
    }
  }

  /** 올가미·창 선택이 끝난 뒤 명령행 프롬프트를 되돌린다 */
  private restorePrompt(): void {
    const r = this.request;
    this.cmd.setPrompt(!r ? '' : r.kind === 'select' ? (r.remove ? '객체 제거:' : r.prompt) : this.promptOf(r));
  }

  /** 선택한 객체를 끌어 옮기기(놓을 때 Ctrl·⌘이면 복사) */
  private dragMove(pr: NonNullable<App['press']>, b: Pt, done: boolean, ev: PointerEvent): void {
    const st = this.active!;
    const wb = this.view.screenToWorld(b.x, b.y);
    const d = { x: wb.x - pr.world.x, y: wb.y - pr.world.y };
    const copy = ev.ctrlKey || ev.metaKey;
    const o = this.view.overlay;
    if (!pr.ghost) {
      const pk = this.picker();
      pr.ghost = new DragGhost(pk ? [...st.selection].slice(0, 3000).map((h) => pk.geometry(h)) : []);
      this.clearHover();
    }
    if (!done) {
      o.ghost = pr.ghost.at(d.x, d.y);
      o.rubber = [{ pts: [pr.world.x, pr.world.y, wb.x, wb.y], dashed: true }];
      o.tip = copy ? '복사' : '이동';
      this.view.requestOverlay();
      return;
    }
    this.press = null;
    o.ghost = [];
    o.rubber = [];
    o.tip = null;
    this.view.requestOverlay();
    void commitDrag(this, [...st.selection], d, copy);
  }

  /** 창·올가미로 고른 것을 선택에 더하거나 빼거나 바꾼다(객체 선택 중이면 단계로 남기고 단일이면 끝) */
  private applyPicked(hits: string[], mode: PickMode): void {
    const r = this.request;
    if (r?.kind === 'select') this.pickedInSelect(r, hits, mode);
    else this.setSelection(hits, mode);
  }

  private finishWindow(a: Pt, b: Pt, ev: PointerEvent, remove = false): void {
    this.windowStart = null;
    this.view.overlay.windowRect = null;
    this.view.overlay.preview = [];
    const pk = this.picker();
    if (!pk) return;
    const wa = this.view.screenToWorld(a.x, a.y);
    const wb = this.view.screenToWorld(b.x, b.y);
    const crossing = b.x < a.x;
    const rect: [number, number, number, number] = [Math.min(wa.x, wb.x), Math.min(wa.y, wb.y), Math.max(wa.x, wb.x), Math.max(wa.y, wb.y)];
    const hits = this.expandPick(pk.select(rect, crossing));
    // PICKADD: 1·2 더하기(Shift 빼기), 0 바꾸기(Shift 더하기)
    this.applyPicked(hits, pickMode(this.settings.pickadd, { shift: ev.shiftKey, removing: remove }));
    this.view.requestOverlay();
  }

  /** 창·올가미를 끄는 동안 걸릴 객체를 강조(선택 미리보기 — SELECTIONPREVIEW가 켜져 있을 때). 0.1초에 한 번, 300개까지 */
  private updateSelectPreview(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now < this.previewAt) return;
    this.previewAt = now + 100;
    const pk = this.picker();
    const o = this.view.overlay;
    if (!pk) return;
    if (!previewOn(this.settings.selectionPreview, !!this.request || !!this.running)) {
      o.preview = [];
      return;
    }
    let hits: string[] = [];
    if (o.lasso && this.press?.lasso?.usable) hits = this.press.lasso.select(pk, (p) => this.view.screenToWorld(p.x, p.y));
    else if (o.windowRect) {
      const { a, b } = o.windowRect;
      const wa = this.view.screenToWorld(a.x, a.y);
      const wb = this.view.screenToWorld(b.x, b.y);
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 2) hits = pk.select([Math.min(wa.x, wb.x), Math.min(wa.y, wb.y), Math.max(wa.x, wb.x), Math.max(wa.y, wb.y)], b.x < a.x);
    }
    const sel = this.active?.selection;
    o.preview = hits
      .filter((h) => !sel?.has(h))
      .slice(0, 300)
      .map((h) => pk.geometry(h));
  }

  /** 선택 순환(SELECTIONCYCLING 2): 겹친 객체가 여럿이면 목록에서 고르게 한다. 목록을 띄웠으면 true */
  selectionCycling = 0;
  private cycleMenu(pk: Picker, w: Pt, tol: number, ev: PointerEvent, pick: (h: string) => void): boolean {
    if (this.selectionCycling !== 2) return false;
    const all = pk.pickAll(w.x, w.y, tol);
    if (all.length < 2) return false;
    const st = this.active!;
    const items = all.slice(0, 20).map((h) => {
      const e = st.doc.entityIndex.get(h);
      return {
        label: e ? `${entityKindName(e.type)} · ${e.layer}` : h,
        run: () => pick(h),
        hover: () => {
          this.view.overlay.hover = pk.geometry(h);
          this.view.requestOverlay();
        },
      };
    });
    showMenu(ev.clientX + 8, ev.clientY + 8, [{ heading: `선택 순환 — ${all.length}개 겹침` }, ...items]);
    return true;
  }

  private expandPick(hs: string[]): string[] {
    return this.selectionExpander ? this.selectionExpander(hs) : hs;
  }

  /** 한계 검사(LIMCHECK·PLIMCHECK)가 켜져 있고 점이 한계 밖이면 알리고 true */
  private outsideLimits(p: Pt): boolean {
    const st = this.active;
    if (!st || st.blockEdit) return false;
    const cmd = this.running?.name;
    if (cmd === 'ZOOM' || cmd === 'PAN' || cmd === 'LIMITS') return false;
    const model = st.space === MODEL_SPACE;
    const h = st.doc.header;
    if (Number(h.get(model ? '$LIMCHECK' : '$PLIMCHECK') ?? 0) !== 1) return false;
    const v2 = (k: string) => {
      const v = h.get(k);
      return v && typeof v === 'object' ? { x: v.x, y: v.y } : null;
    };
    const layout = model ? null : st.layoutFor(st.space);
    const lo = model ? v2('$LIMMIN') : (layout?.limitsMin ?? v2('$PLIMMIN'));
    const hi = model ? v2('$LIMMAX') : (layout?.limitsMax ?? v2('$PLIMMAX'));
    if (!lo || !hi) return false;
    const e = 1e-9 * Math.max(1, Math.abs(hi.x - lo.x), Math.abs(hi.y - lo.y));
    if (p.x >= lo.x - e && p.x <= hi.x + e && p.y >= lo.y - e && p.y <= hi.y + e) return false;
    this.cmd.print('**한계 밖', 'err');
    return true;
  }

  private onDblClick(w: Pt, sp: Pt): void {
    const st = this.active;
    if (!st || this.request) return;
    // 배치: 뷰포트 안을 두 번 누르면 모형 공간으로, MSPACE에서 뷰포트 밖이면 종이 공간으로
    if (st.onLayout && !st.blockEdit) {
      const at = this.viewportAt(st, this.view.paperPoint(sp.x, sp.y));
      if (st.msVp && !at) {
        this.exitViewport(st);
        return;
      }
      if (!st.msVp && at) {
        const hit = this.picker()?.pick(w.x, w.y, this.view.overlay.pickbox * this.view.pixelSize());
        if (!hit || hit === at.handle) {
          this.enterViewport(st, at);
          return;
        }
      }
    }
    const pk = this.picker();
    const h = pk?.pick(w.x, w.y, this.view.overlay.pickbox * this.view.pixelSize());
    if (!h) return;
    const e = st.doc.entityIndex.get(h);
    if (e && this.dblClickHandlers.some((f) => f.dblclick(h, e, w))) return;
    // 표는 셀 편집, 여러 줄은 여러 줄 편집 도구
    const tableLike = (x: Entity | undefined): boolean => isEditableTable(x);
    if (tableLike(e)) {
      this.setSelection([h], 'replace');
      void import('./tablecmds').then((m) => m.editTableAt(this, h, w));
      return;
    }
    // 외부 참조를 두 번 누르면 참조 편집(AutoCAD와 같다)
    if (e?.type === 'INSERT' && ((this.active?.doc.blocks.get(tableKey(e.block))?.flags ?? 0) & 4) !== 0) {
      this.setSelection([h], 'replace');
      void this.run('REFEDIT', `${h}@${w.x},${w.y}`);
      return;
    }
    if (e?.type === 'ARCALIGNEDTEXT') {
      this.setSelection([h], 'replace');
      void this.run('ARCTEXT');
      return;
    }
    if (e?.type === 'MLINE') {
      this.setSelection([h], 'replace');
      void this.run('MLEDIT');
      return;
    }
    if (e?.type === 'HATCH') {
      this.setSelection([h], 'replace');
      void this.run('HATCHEDIT');
      return;
    }
    // 문자·치수·속성 블록은 두 번 누르면 바로 고친다(AutoCAD와 같다)
    if (e && (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTDEF' || e.type === 'DIMENSION' || (e.type === 'INSERT' && e.attribs.some((a) => !(a.attFlags & 2))))) {
      this.setSelection([h], 'replace');
      void import('./editcmds').then((m) => m.editText(this, h));
      return;
    }
    // 그 밖의 기본 편집(AutoCAD 2026 두 번 누르기 동작): 폴리선 PEDIT, 스플라인 SPLINEDIT, 블록 참조 BEDIT, 형상 객체 빠른 특성
    const cmd = e ? dblClickCommand(e) : null;
    this.setSelection([h], 'replace');
    if (cmd && this.findCommand(cmd)) {
      void this.run(cmd);
      return;
    }
    this.ui.openPalette('props');
  }

  /**
   * 오른쪽 클릭(SHORTCUTMENU, AutoCAD 2026 기본 11): 명령 중 옵션이 없는 프롬프트·객체 선택은 바로 Enter, 옵션이 있으면 명령 모드 메뉴,
   * Shift·Ctrl+오른쪽 클릭(점 프롬프트)은 객체 스냅 재지정 메뉴. 명령이 없으면 그립 위는 다기능 그립 메뉴, 그 밖은 편집·기본 모드 메뉴.
   * 모드 메뉴를 끄면 Enter(명령이 없으면 직전 명령 반복), 시간에 민감한 오른쪽 클릭(16)은 held(누른 시간)가 짧으면 Enter·길면 메뉴
   */
  private onContext(w: Pt, _s: Pt, ev: MouseEvent, held?: number): void {
    void _s;
    closeMenu();
    if (this.windowStart) {
      this.windowStart = null;
      this.view.overlay.windowRect = null;
      this.view.overlay.preview = [];
    }
    const st = this.active;
    const r = this.request;
    const providers = (mode: ContextMenuMode): ContextMenuItem[] => {
      const out: ContextMenuItem[] = [];
      const sel = st ? [...st.selection] : [];
      for (const pv of this.contextMenuProviders) {
        const its = pv.items({ mode, selection: sel, point: w, st });
        if (its?.length) out.push({ separator: true }, ...its);
      }
      return out;
    };
    if (r?.kind === 'point' && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
      showContextMenu(ev.clientX, ev.clientY, [{ heading: '객체 스냅 재지정' }, ...osnapItems(this)]);
      return;
    }
    const sm = this.settings.shortcutMenu;
    const dur = this.settings.shortcutMenuDuration;
    if (r) {
      if (contextAction(sm, 'command', r.kind !== 'select' && r.keywords.length > 0, held, dur) === 'enter') {
        this.onInput('', true);
        return;
      }
      showContextMenu(ev.clientX, ev.clientY, commandMenu(this, r, providers('command')));
      return;
    }
    if (st && !this.running && st.selection.size) {
      const g = this.gripAt(w);
      const items = g ? this.gripMenuItems(g.point) : [];
      if (items.length) {
        this.clearGripHover();
        showContextMenu(ev.clientX, ev.clientY, items);
        return;
      }
    }
    const sel = st ? [...st.selection] : [];
    // 기본·편집 모드 메뉴를 껐으면(또는 짧게 눌렀으면) 직전 명령 반복
    if (contextAction(sm, sel.length ? 'edit' : 'default', true, held, dur) === 'enter') {
      if (this.lastCommand && !this.running) void this.run(this.lastCommand);
      return;
    }
    const extra: ContextMenuItem[] = [];
    if (st && sel.length === 1 && isDynamicReference(st.doc, st.doc.entityIndex.get(sel[0]!))) {
      extra.push({ label: '동적 블록 특성', run: () => void this.run('DYNPROPS') }, { label: '블록 재설정', run: () => void this.run('RESETBLOCK') });
    }
    extra.push(...providers(sel.length ? 'edit' : 'default'));
    showContextMenu(ev.clientX, ev.clientY, idleMenu(this, w, extra).items);
  }

  // -------------------------------------------------------------------------
  // 키보드
  // -------------------------------------------------------------------------

  /**
   * 명령행 입력란이 키를 처리하기 전에 본다: 올가미 중 스페이스바(종류 순환), 동적 입력의 Tab(칸 잠그고 옮기기).
   * 처리했으면 true(명령행은 기본 동작을 막고 넘어간다)
   */
  private interceptKey(ev: KeyboardEvent): boolean {
    if (ev.key === ' ' && this.press?.lasso) return this.cycleLasso();
    if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !this.cmd.suggesting) return this.dynTab();
    return false;
  }

  /** 올가미를 끄는 중 스페이스바: 걸침 → 윈도우 → 울타리 */
  private cycleLasso(): boolean {
    const l = this.press?.lasso;
    if (!l) return false;
    l.cycle();
    this.view.overlay.lasso = { pts: l.pts, mode: l.mode };
    this.cmd.setPrompt(`${l.label} 옵션을 순환하려면 스페이스바를 누르십시오.`);
    this.previewAt = 0;
    this.updateSelectPreview();
    this.view.requestOverlay();
    return true;
  }

  /** 동적 입력의 Tab: 지금 칸에 친 값을 잠그고 다음 칸으로(점 요청에서만, 그 밖에는 Tab을 넘긴다) */
  private dynTab(): boolean {
    const r = this.request;
    const st = this.active;
    if (!st || !this.dynOn || r?.kind !== 'point' || r.allowText) return false;
    if (this.dyn.tab(this.cmd.input.value, !!r.base, st.units.aunits)) this.cmd.clearInput();
    const m = this.lastMove;
    if (m) this.onMove(m.w, m.s, m.ev, true);
    else {
      this.updateDynFields();
      this.view.requestOverlay();
    }
    return true;
  }

  /** Enter(Ctrl+J·Ctrl+M·도면 위 Enter): 명령 중이면 입력, 아니면 직전 명령 반복 */
  private pressEnter(inCmd: boolean): void {
    if (inCmd) this.cmd.submitCurrent();
    else if (this.request) this.onInput('', true);
    else if (this.lastCommand) void this.run(this.lastCommand);
  }

  /** Ctrl 단축키(keys.ts)의 동작 */
  private ctrlKey(a: NonNullable<ReturnType<typeof ctrlAction>>, inCmd: boolean): void {
    if ('enter' in a) return this.pressEnter(inCmd);
    if ('cancel' in a) {
      if (inCmd) this.cmd.escape();
      else this.cancel();
      return;
    }
    if ('run' in a) {
      void this.run(a.run);
      return;
    }
    switch (a.toggle) {
      case 'grid':
        return this.toggleGrid();
      case 'snap':
        return this.toggleSnap();
      case 'ortho':
        return this.toggleOrtho();
      case 'osnap':
        return this.toggleOsnap();
      case 'polar':
        return this.togglePolar();
      case 'pickstyle':
        void import('./util2-select').then((m) => {
          const v = m.pickstyle() ^ 1;
          m.setPickstyle(v);
          this.cmd.print(`<그룹 ${v & 1 ? '켜기' : '끄기'}>`);
        });
        return;
    }
  }

  private onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const inCmd = t === this.cmd.input;
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Shift') this.setShift(true);
    // 명령행 입력란의 키는 명령행이 먼저 처리했다(intercept). 여기서는 막힌 키를 다시 보지 않는다
    if (inCmd && ev.defaultPrevented && (ev.key === ' ' || ev.key === 'Tab')) return;
    // Ctrl 제도 보조·입력 키(글을 고치는 다른 입력란에서는 그 입력란의 키)
    const ca = !typing || inCmd ? ctrlAction(ev) : null;
    if (ca) {
      ev.preventDefault();
      this.ctrlKey(ca, inCmd);
      return;
    }
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
      case 'F5':
        // 등각평면 전환(도면이 없으면 브라우저 새로 고침을 막지 않는다)
        if (!this.active) break;
        ev.preventDefault();
        cycleIsoPlane(this);
        return;
      case 'F7':
        ev.preventDefault();
        this.toggleGrid();
        return;
      case 'F8':
        ev.preventDefault();
        this.toggleOrtho();
        return;
      case 'F9':
        ev.preventDefault();
        this.toggleSnap();
        return;
      case 'F10':
        ev.preventDefault();
        this.togglePolar();
        return;
      case 'F11':
        ev.preventDefault();
        this.toggleOtrack();
        return;
      case 'F12':
        ev.preventDefault();
        this.toggleDyn();
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
      if (k === 'l' && !typing) {
        ev.preventDefault();
        void this.run('LAYERSTATE');
        return;
      }
    }
    if (mod && !ev.shiftKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === 'e' && !typing && this.active) {
        ev.preventDefault();
        cycleIsoPlane(this);
        return;
      }
      // 최대화한 뷰포트에서 다음 뷰포트로(최대화 중이 아니면 브라우저 새로 고침 그대로)
      if (k === 'r' && !typing && maximized(this.active)) {
        ev.preventDefault();
        void this.run('VPMAXNEXT');
        return;
      }
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
        // Ctrl+Shift+C = 기준점을 두고 복사(AutoCAD와 같다)
        void this.run(k === 'c' ? (ev.shiftKey ? 'COPYBASE' : 'COPYCLIP') : 'CUTCLIP');
        return;
      }
      if (k === 'v' && !typing) {
        ev.preventDefault();
        // Ctrl+Shift+V = 블록으로 붙여넣기
        void this.run(ev.shiftKey ? 'PASTEBLOCK' : 'PASTECLIP');
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
      if (k === '2' && !typing) {
        // 디자인센터 열기·닫기(AutoCAD와 같다)
        ev.preventDefault();
        void this.run('ADCENTER');
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
    if (this.interceptKey(ev)) {
      ev.preventDefault();
      return;
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && !mod) {
      ev.preventDefault();
      this.pressEnter(false);
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

  toggleGrid(on = !this.gridOn): void {
    this.gridOn = on;
    this.cmd.print(`<격자 ${this.gridOn ? '켜기' : '끄기'}>`);
    this.view.requestOverlay();
    this.ui.refreshStatus();
  }

  toggleSnap(on = !this.snapOn): void {
    this.snapOn = on;
    this.cmd.print(`<스냅 ${this.snapOn ? '켜기' : '끄기'}>`);
    this.ui.refreshStatus();
  }

  /** 격자 스냅: 스냅 기준점에서 간격의 배수로 */
  private snapToGrid(w: Pt): Pt {
    const st = this.active;
    if (!st || st.msVp) return w;
    const s = st.snap;
    const u = currentUcs(st);
    const q = toUcs(u, w);
    return toWcs(u, { x: s.baseX + Math.round((q.x - s.baseX) / s.x) * s.x, y: s.baseY + Math.round((q.y - s.baseY) / s.y) * s.y });
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

  toggleDyn(): void {
    this.dynOn = !this.dynOn;
    if (!this.dynOn) {
      this.view.overlay.dynInput = null;
      this.view.overlay.dynFields = null;
      this.view.requestOverlay();
    }
    this.cmd.print(`<동적 입력 ${this.dynOn ? '켜기' : '끄기'}>`);
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

/** 최근 목록 앞에 넣는다(같은 것은 앞으로, 열 개까지) */
function remember(list: string[], v: string): void {
  const t = v.trim();
  if (!t) return;
  const i = list.indexOf(t);
  if (i >= 0) list.splice(i, 1);
  list.unshift(t);
  if (list.length > 10) list.length = 10;
}

/** 같은 점(그립·획득점 비교) */
function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 * Math.max(1, Math.abs(a.x) + Math.abs(a.y)) && Math.abs(a.y - b.y) <= 1e-9 * Math.max(1, Math.abs(a.x) + Math.abs(a.y));
}

/** 두 번 누른 객체의 기본 편집 명령(표·참조·호 문자·여러 줄·해치·문자는 앞에서 처리). 없으면 null(특성 팔레트) */
export function dblClickCommand(e: Entity): string | null {
  switch (e.type) {
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return 'PEDIT';
    case 'SPLINE':
      return e.helix ? 'QUICKPROPERTIES' : 'SPLINEDIT';
    case 'INSERT':
      return 'BEDIT';
    case 'LINE':
    case 'CIRCLE':
    case 'ARC':
    case 'ELLIPSE':
    case 'POINT':
    case 'RAY':
    case 'XLINE':
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
    case 'LEADER':
    case 'WIPEOUT':
      return 'QUICKPROPERTIES';
    default:
      return null;
  }
}
