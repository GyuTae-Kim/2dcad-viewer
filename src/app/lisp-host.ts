/**
 * AutoLISP ↔ App 연결(LispHost): 입력 요청(get*)·명령 넣기(command)·시스템 변수(getvar·setvar)·선택(ssget)·도면 편집.
 * 입력은 App의 요청(점·객체·선택)을 그대로 써서 마우스·스냅·키워드 클릭·스크립트 입력이 모두 통한다.
 * App의 요청 함수는 비공개라 구조 형식으로 꺼낸다(시험의 가짜 App도 같은 이름을 갖춘다).
 */
import type { Entity, HeaderValue } from '../core/model';
import { tableKey } from '../core/model';
import { HEADER_VARS } from '../io/dxf/headervars';
import type { AskOptions, AskResult, LispDrawing, LispHost } from '../edit/lisp/host';
import { isPoint, point } from '../edit/lisp/core';
import { prin1 } from '../edit/lisp/printer';
import { Ename, LispError, PickSet, Real, Sym, fromArray, toArray, type Value } from '../edit/lisp/types';
import type { Interp } from '../edit/lisp/interp';
import { parseCommandWord, scriptCommandName } from '../edit/script/reader';
import { entityPath } from '../edit/geom/path';
import { pathNearest } from '../edit/geom/curve';
import { boundsOf } from '../edit/geom/query';
import type { App, CommandContext, Keyword, PointResult } from './app';
import type { SnapKind } from './view';
import { currentUcs, toUcs, toWcs } from './ucs';
import { scriptVars } from './script';
import { toast } from './ui/dom';

type Pt = { x: number; y: number };

/** App의 비공개 요청 함수(구조 형식) */
interface AppInternals {
  request: { kind: string; signal?: AbortSignal } | null;
  requestPoint(prompt: string, opt: Parameters<CommandContext['getPoint']>[1], signal: AbortSignal): Promise<PointResult>;
  requestEntity(prompt: string, keywords: Keyword[], signal: AbortSignal): Promise<{ handle: string; point: Pt } | { keyword: string } | { enter: true }>;
  requestSelection(prompt: string, opt: { keywords?: Keyword[]; noPickfirst?: boolean }, signal: AbortSignal): Promise<string[]>;
  promptOf(r: unknown): string;
}

const internals = (app: App) => app as unknown as AppInternals;

/** 연결이 세션에서 읽고 바꾸는 상태 */
export interface HostState {
  readonly it: Interp;
  /** 지금 평가의 취소 신호 */
  signal(): AbortSignal;
  /** 사용자가 답할 요청(그 요청이 기다리는 동안은 스크립트 실행기가 다음 입력을 넣는다) */
  waitingFor: unknown;
  /** command가 명령행에 넣는 중(입력 고리를 건너뛴다) */
  feeding: boolean;
  /** 다른 명령의 프롬프트에서 평가 중(command를 쓸 수 없다) */
  transparent: boolean;
  defineCommand(name: string): void;
  /** 명령 실행(AutoLISP 명령이 가린 원래 명령이 있으면 그것: command는 C: 명령을 부르지 않는다) */
  runBuiltin(name: string): void;
  findFile(name: string): Promise<{ name: string; text: string } | null>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 명령행에 글을 넣는다(입력 고리를 건너뛴다) */
export function feed(app: App, s: HostState, text: string): void {
  s.feeding = true;
  try {
    app.submitInput(text);
  } finally {
    s.feeding = false;
  }
}

/** 객체 위의 점(WCS): 경계 상자 가운데에 가장 가까운 곡선 위 점 */
function pointOn(app: App, e: Entity): Pt {
  const doc = app.active!.doc;
  const b = boundsOf([e], doc);
  const c = b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
  const p = entityPath(e);
  if (p && p.pieces.length) {
    const n = pathNearest(p, c).p;
    return { x: n.x, y: n.y };
  }
  return c;
}

/** 값 → 명령행 글(점은 "x,y[,z]") */
export function inputText(v: Value): string | null {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof Real) return String(+v.v.toPrecision(15));
  if (v instanceof Sym) return v.name;
  if (isPoint(v)) {
    const p = point(v);
    const f = (n: number) => String(+n.toPrecision(15));
    // 2D 도면: Z가 0이면 "x,y"
    return p.dims === 3 && p.z !== 0 ? `${f(p.x)},${f(p.y)},${f(p.z)}` : `${f(p.x)},${f(p.y)}`;
  }
  return null;
}

/**
 * 기다리는 프롬프트에 AutoLISP 값을 넣는다: 점·수·글은 명령행 글로, 객체 이름·선택 세트는 객체 고르기·선택으로.
 * 넣지 못하면 오류 글
 */
export function supply(app: App, s: HostState, v: Value): string | null {
  const req = app.pendingInput as unknown as { kind: string; resolve?: (r: { handle: string; point: Pt }) => void } | null;
  if (!req) return '기다리는 프롬프트가 없습니다';
  const st = app.active;
  const u = currentUcs(st);
  // (ename (x y z)) — entsel의 결과
  let ename: Ename | null = v instanceof Ename ? v : null;
  let at: Pt | null = null;
  const a = toArray(v);
  if (a && a.length === 2 && a[0] instanceof Ename && isPoint(a[1]!)) {
    ename = a[0];
    const p = point(a[1]!);
    at = toWcs(u, p);
  }
  if (req.kind === 'select') {
    const hs = v instanceof PickSet ? v.handles : ename ? [ename.handle] : null;
    if (!hs) {
      if (typeof v === 'string' || v === null) {
        feed(app, s, v ?? '');
        return null;
      }
      return `객체 선택에는 객체 이름이나 선택 세트가 필요합니다: ${prin1(v)}`;
    }
    const live = hs.filter((h) => st?.doc.entityIndex.has(h));
    app.setSelection(live, (req as { remove?: boolean }).remove ? 'remove' : 'add');
    app.cmd.print(`${live.length}개를 찾음`);
    return null;
  }
  if (req.kind === 'entity' && ename) {
    const e = st?.doc.entityIndex.get(ename.handle);
    if (!e || !req.resolve) return `객체가 없습니다: ${prin1(v)}`;
    req.resolve({ handle: e.handle, point: at ?? pointOn(app, e) });
    return null;
  }
  if (v instanceof PickSet || ename) return `이 프롬프트에는 객체를 넣을 수 없습니다: ${prin1(v)}`;
  const t = inputText(v);
  if (t === null) return `명령에 넣을 수 없는 값: ${prin1(v)}`;
  feed(app, s, t);
  return null;
}

type State = 'command' | 'input' | 'busy';
const stateOf = (app: App): State => (app.pendingInput ? 'input' : app.busyCommand ? 'busy' : 'command');

/** 명령이 일을 마치고 입력을 기다리거나 끝날 때까지 */
async function settle(app: App, s: HostState): Promise<void> {
  for (let i = 0; i < 20 && stateOf(app) === 'busy'; i++) await Promise.resolve();
  let noted = false;
  while (stateOf(app) === 'busy') {
    s.it.checkCancel();
    if (!noted && typeof document !== 'undefined' && document.querySelector('.dialog-back')) {
      app.cmd.print('AutoLISP: 대화상자를 닫으면 이어서 실행합니다.');
      noted = true;
    }
    await wait(16);
  }
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** command·command-s·vl-cmdf */
async function runCommand(app: App, s: HostState, args: Value[], mode: 'command' | 'command-s' | 'vl-cmdf'): Promise<Value> {
  const it = s.it;
  if (s.transparent) throw new LispError('다른 명령의 프롬프트에서 평가한 AutoLISP 식에서는 command를 쓸 수 없습니다');
  if (!args.length) {
    // (command) = Esc
    if (app.pendingInput || app.busyCommand) app.cancel();
    return null;
  }
  // vl-cmdf는 넣기 전에 인수를 확인한다
  if (mode === 'vl-cmdf') for (const a of args) if (inputText(a) === null && !(a instanceof Ename) && !(a instanceof PickSet) && !(toArray(a)?.[0] instanceof Ename)) throw new LispError(`잘못된 인수 값: vl-cmdf: ${prin1(a)}`);
  let started = false;
  for (const a of args) {
    await settle(app, s);
    it.checkCancel();
    const state = stateOf(app);
    if (state === 'command') {
      if (a === null || a === '') continue;
      if (typeof a !== 'string') throw new LispError(`알 수 없는 명령: ${prin1(a)}`);
      const w = parseCommandWord(a);
      const canonical = w ? app.findCommand(w.name)?.name : undefined;
      if (!w || !canonical) throw new LispError(`알 수 없는 명령 "${a.trim()}"`);
      const name = scriptCommandName(w.name, canonical, (n) => app.commands.has(n.toUpperCase()));
      if (app.active?.selection.size) app.clearSelection();
      started = true;
      s.runBuiltin(name);
      continue;
    }
    if (a === '\\') {
      // PAUSE: 사용자가 이 프롬프트에 답할 때까지
      const req = app.pendingInput;
      s.waitingFor = req;
      try {
        while (app.pendingInput === req && stateOf(app) !== 'command') {
          it.checkCancel();
          await wait(30);
        }
      } finally {
        s.waitingFor = null;
      }
      continue;
    }
    const err = supply(app, s, a);
    if (err) throw new LispError(err);
  }
  await settle(app, s);
  if (mode === 'command-s' && started && stateOf(app) !== 'command') {
    app.cancel();
    throw new LispError('command-s: 명령이 인수 안에서 끝나지 않았습니다');
  }
  return mode === 'vl-cmdf' ? it.T : null;
}

// --------------------------------------------------------------------------- 시스템 변수

const OSNAP_BITS: [number, SnapKind][] = [
  [1, 'end'],
  [2, 'mid'],
  [4, 'cen'],
  [8, 'nod'],
  [16, 'qua'],
  [32, 'int'],
  [64, 'ins'],
  [128, 'per'],
  [256, 'tan'],
  [512, 'nea'],
  [1024, 'gcen'],
  [2048, 'app'],
  [4096, 'ext'],
];

const headerCodes = new Map(HEADER_VARS.map(([n, code]) => [n, code]));

/** 읽기 전용 세션 변수 */
function sessionVar(app: App, n: string): Value | undefined {
  const st = app.active;
  const now = new Date();
  switch (n) {
    case 'OSMODE': {
      let bits = 0;
      for (const [b, k] of OSNAP_BITS) if (app.snapModes.has(k)) bits |= b;
      return bits | (app.osnapOn ? 0 : 16384);
    }
    case 'ORTHOMODE':
      return app.orthoOn ? 1 : 0;
    case 'SNAPMODE':
      return app.snapOn ? 1 : 0;
    case 'GRIDMODE':
      return app.gridOn ? 1 : 0;
    case 'POLARMODE':
      return app.polarOn ? 1 : 0;
    case 'DYNMODE':
      return app.dynOn ? 3 : 0;
    case 'FILEDIA':
    case 'CMDDIA':
    case 'CMDECHO':
      return scriptVars[n];
    case 'DWGNAME':
      return st?.name ?? 'Drawing1.dwg';
    case 'DWGPREFIX':
      return '';
    case 'DWGTITLED':
      return st ? 1 : 0;
    case 'CTAB':
      return st ? (st.doc.layouts.find((l) => tableKey(l.blockName) === tableKey(st.displaySpace))?.name ?? 'Model') : 'Model';
    case 'CDATE': {
      const p = (x: number, w = 2) => String(x).padStart(w, '0');
      const s = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(Math.floor(now.getMilliseconds() / 10))}`;
      return new Real(Number(s));
    }
    case 'DATE':
      return new Real(now.getTime() / 86400000 + 2440587.5);
    case 'MILLISECS':
      return Math.floor(performance.now()) | 0;
    case 'ACADVER':
      return '25.1s (OpenCAD 웹)';
    case 'PRODUCT':
      return 'OpenCAD';
    case 'PLATFORM':
      return '웹 브라우저';
    case 'LOCALE':
      return 'KOR';
    case 'LISPINIT':
    case 'UNDOCTL':
      return 1;
    case 'SDI':
    case 'ERRNO':
      return 0;
    case 'LASTPOINT': {
      const p = app.lastPoint ? toUcs(currentUcs(st), app.lastPoint) : { x: 0, y: 0 };
      return fromArray([new Real(p.x), new Real(p.y), new Real(0)]);
    }
    default:
      return undefined;
  }
}

const READ_ONLY = new Set(['DWGNAME', 'DWGPREFIX', 'DWGTITLED', 'CDATE', 'DATE', 'MILLISECS', 'ACADVER', 'PRODUCT', 'PLATFORM', 'LOCALE', 'SDI', 'LISPINIT', 'CTAB', 'LASTPOINT', 'ERRNO', 'UNDOCTL']);

function headerToValue(name: string, v: HeaderValue): Value {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    const code = headerCodes.get(name);
    const isReal = code !== undefined ? code >= 40 && code < 60 : !Number.isInteger(v);
    return isReal ? new Real(v) : v;
  }
  if (typeof v === 'object' && v && 'x' in v) {
    const z = 'z' in v ? (v as { z: number }).z : undefined;
    return z === undefined ? fromArray([new Real(v.x), new Real(v.y)]) : fromArray([new Real(v.x), new Real(v.y), new Real(z)]);
  }
  return null;
}

export function getSysVar(app: App, name: string): Value | undefined {
  const n = name.trim().toUpperCase().replace(/^\$/, '');
  const sv = sessionVar(app, n);
  if (sv !== undefined) return sv;
  const v = app.active?.doc.header.get(`$${n}`);
  return v === undefined ? undefined : headerToValue(`$${n}`, v);
}

/** 바꾸면 null, 거부하면 까닭(빈 글이면 까닭 없음) */
export function setSysVar(app: App, name: string, v: Value): string | null {
  const n = name.trim().toUpperCase().replace(/^\$/, '');
  if (READ_ONLY.has(n)) return '읽기 전용';
  const int01 = (): number | null => (v === 0 || v === 1 ? v : null);
  switch (n) {
    case 'OSMODE': {
      if (typeof v !== 'number' || v < 0 || v > 32767) return '';
      app.snapModes.clear();
      for (const [b, k] of OSNAP_BITS) if (v & b) app.snapModes.add(k);
      app.osnapOn = (v & 16384) === 0 && v !== 0;
      app.ui?.refreshStatus?.();
      return null;
    }
    case 'ORTHOMODE':
    case 'SNAPMODE':
    case 'GRIDMODE':
    case 'POLARMODE': {
      const b = int01();
      if (b === null) return '';
      if (n === 'ORTHOMODE') app.orthoOn = !!b;
      else if (n === 'SNAPMODE') app.snapOn = !!b;
      else if (n === 'GRIDMODE') app.gridOn = !!b;
      else app.polarOn = !!b;
      app.ui?.refreshStatus?.();
      if (n === 'GRIDMODE') app.view?.requestRender?.();
      return null;
    }
    case 'DYNMODE':
      if (typeof v !== 'number') return '';
      app.dynOn = v !== 0;
      app.ui?.refreshStatus?.();
      return null;
    case 'FILEDIA':
    case 'CMDDIA':
    case 'CMDECHO': {
      const b = int01();
      if (b === null) return '';
      scriptVars[n] = b;
      return null;
    }
    default:
      break;
  }
  const st = app.active;
  const key = `$${n}`;
  const cur = st?.doc.header.get(key);
  if (!st || cur === undefined) return '';
  let after: HeaderValue;
  if (typeof cur === 'number') {
    if (typeof v === 'number') after = v;
    else if (v instanceof Real) {
      const code = headerCodes.get(key);
      const isInt = code !== undefined && !(code >= 40 && code < 60);
      if (isInt && !Number.isInteger(v.v)) return '정수가 필요합니다';
      after = v.v;
    } else return '';
  } else if (typeof cur === 'string') {
    if (typeof v !== 'string') return '';
    const doc = st.doc;
    if (n === 'CLAYER' && !doc.layers.has(tableKey(v))) return '도면층이 없습니다';
    if (n === 'TEXTSTYLE' && !doc.textStyles.has(tableKey(v))) return '문자 스타일이 없습니다';
    if (n === 'DIMSTYLE' && !doc.dimStyles.has(tableKey(v))) return '치수 스타일이 없습니다';
    if (n === 'CELTYPE' && !/^(bylayer|byblock|continuous)$/i.test(v) && !doc.linetypes.has(tableKey(v))) return '선종류가 없습니다';
    after = n === 'CLAYER' ? doc.layers.get(tableKey(v))!.name : v;
  } else {
    if (!isPoint(v)) return '';
    const p = point(v);
    after = 'z' in cur ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y };
  }
  if (JSON.stringify(after) === JSON.stringify(cur)) return null;
  st.session.commit({ label: n, ops: [{ kind: 'header', name: key, before: cur, after }] });
  app.ui?.refreshStatus?.();
  return null;
}

// --------------------------------------------------------------------------- 연결

export function makeHost(app: App, s: HostState): LispHost {
  const ucs = () => currentUcs(app.active);
  const tolerance = () => (app.view?.overlay?.pickbox ?? 5) * (app.view?.pixelSize?.() ?? 1);

  /** App 요청 하나(다른 명령의 프롬프트가 기다리고 있으면 끝난 뒤 되돌린다) */
  async function request<T>(make: (signal: AbortSignal) => Promise<T>, spaces: boolean): Promise<T> {
    const ai = internals(app);
    const saved = ai.request;
    if (saved) ai.request = null;
    const prevSpaces = app.cmd.acceptSpaces;
    if (spaces) app.cmd.acceptSpaces = true;
    try {
      const p = make(s.signal());
      s.waitingFor = ai.request;
      return await p;
    } finally {
      s.waitingFor = null;
      app.cmd.acceptSpaces = prevSpaces;
      if (saved) {
        if (!ai.request && !saved.signal?.aborted) {
          ai.request = saved;
          app.cmd.setPrompt(ai.promptOf(saved));
        }
      } else if (!ai.request && !app.busyCommand) {
        app.cmd.setPrompt('');
        const o = app.view?.overlay;
        if (o) {
          o.rubber = [];
          o.tip = null;
          app.view.requestOverlay?.();
        }
      }
    }
  }

  const drawing = (): LispDrawing | null => {
    const st = app.active;
    if (!st) return null;
    return {
      doc: st.doc,
      session: st.session,
      space: st.space,
      currentLayer: () => {
        const v = st.doc.header.get('$CLAYER');
        return typeof v === 'string' && st.doc.layers.has(tableKey(v)) ? st.doc.layers.get(tableKey(v))!.name : '0';
      },
      commit: (ops, label) => st.session.commit({ label, ops }),
    };
  };

  return {
    alert(text) {
      for (const line of text.split('\n')) app.cmd.print(`[알림] ${line}`);
      if (typeof document !== 'undefined') toast(text, 'info', 6000);
    },
    async ask(kind, prompt, opt: AskOptions): Promise<AskResult> {
      const ai = internals(app);
      const u = ucs();
      if (kind === 'entity') {
        const r = await request((sig) => ai.requestEntity(prompt, [], sig), false);
        if ('handle' in r) return { entity: r.handle, point: toUcs(u, r.point) };
        return r;
      }
      const base = opt.base ? toWcs(u, opt.base) : null;
      const ub = opt.base ?? null;
      const rubber = base
        ? (p: Pt) => {
            if (opt.rubber === 'rect' && ub) {
              const q = toUcs(u, p);
              const cs = [ub, { x: q.x, y: ub.y }, q, { x: ub.x, y: q.y }].map((c) => toWcs(u, c));
              return [{ pts: cs.flatMap((c) => [c.x, c.y]), closed: true }];
            }
            return [{ pts: [base.x, base.y, p.x, p.y] }];
          }
        : undefined;
      const r = await request((sig) => ai.requestPoint(prompt, { base, rubber, allowText: true, preferNumber: !!opt.preferNumber }, sig), !!opt.spaces);
      if ('point' in r) return { point: toUcs(u, r.point) };
      return r;
    },
    command: (args, mode) => runCommand(app, s, args, mode),
    getvar: (n) => getSysVar(app, n),
    setvar: (n, v) => setSysVar(app, n, v),
    drawing,
    async select(prompt) {
      const ai = internals(app);
      const hs = await request((sig) => ai.requestSelection(prompt, {}, sig), false);
      if (app.active?.selection.size) app.clearSelection();
      return hs;
    },
    selectWindow(a, b, crossing) {
      const pk = app.picker();
      if (!pk) return [];
      const u = ucs();
      const cs = [a, { x: a.x, y: b.y }, b, { x: b.x, y: a.y }].map((c) => toWcs(u, c));
      const xs = cs.map((c) => c.x);
      const ys = cs.map((c) => c.y);
      return pk.select([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], crossing);
    },
    pickAt(p) {
      const w = toWcs(ucs(), p);
      return app.picker()?.pick(w.x, w.y, tolerance()) ?? null;
    },
    implied: () => [...(app.active?.selection ?? [])],
    setImplied: (hs) => app.setSelection(hs, 'replace'),
    previous: () => app.lastSelection.filter((h) => app.active?.doc.entityIndex.has(h)),
    setPrevious(hs) {
      app.lastSelection = hs;
    },
    lastCreated: () => [...app.lastCreated].reverse().find((h) => app.active?.doc.entityIndex.has(h)) ?? null,
    ucs,
    defineCommand: (n) => s.defineCommand(n),
    findFile: (n) => s.findFile(n),
  };
}
