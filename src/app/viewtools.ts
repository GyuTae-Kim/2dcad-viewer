/**
 * 뷰포트·표시 도구 명령(이 파일 하나를 main.ts에 등록한다):
 * - VPMAX·VPMIN(뷰포트 최대화, viewtools-vpmax.ts), VPMAXPREV·VPMAXNEXT(최대화한 채 이전/다음 뷰포트 — 상태 막대 단추용)
 * - VPSYNC(마스터 뷰포트에 축척·중심 맞추기), VPSCALE(뷰포트 축척 보기)
 * - FILL·FILLMODE(채우기), QTEXT·QTEXTMODE(빠른 문자), DRAGMODE·DRAG(끌기 미리보기)
 * - 등각투영 제도 ISODRAFT·ISOPLANE·SNAPSTYL·SNAPISOPAIR(viewtools-iso.ts)
 * - 외부 참조 비교 XCOMPARE·XCOMPARECLOSE·XCOMPARERCNEXT·XCOMPARERCPREV(xcompare.ts)
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 계산은 src/edit/viewtools, 채우기·빠른 문자 그리기는 src/render/fillmode.ts.
 */
import type { App, CommandContext, Keyword, PointResult } from './app';
import type { DocState } from './docstate';
import type { HeaderValue, ViewportEntity } from '../core/model';
import type { EditOp } from '../edit/session';
import type { Pt } from './view';
import { layoutViewports } from './scene';
import { HEADER_VAR_DEFAULT, HEADER_VAR_RANGE, insideViewport, shortNumber, syncViewport, vpScale, vpScaleLines } from '../edit/viewtools';
import { drawIsoOverlay, installIsoHooks, registerIsoCommands } from './viewtools-iso';
import { drawVpMaxOverlay, vpMax, vpMaxStep, vpMin } from './viewtools-vpmax';
import { registerXCompareCommands } from './xcompare';

const ON_OFF: Keyword[] = [
  { key: 'ON', label: '켜기' },
  { key: 'OFF', label: '끄기' },
];

/** 화면표시 잠금 플래그 */
const VP_LOCKED = 0x4000;

// ---------------------------------------------------------------------------
// 머리말 변수(FILLMODE·QTEXTMODE·DRAGMODE)
// ---------------------------------------------------------------------------

/** 머리말 변수 값(없으면 초기값) */
export function headerVar(st: DocState | null, name: keyof typeof HEADER_VAR_DEFAULT | string): number {
  const v = st?.doc.header.get(`$${name}`);
  return typeof v === 'number' && Number.isFinite(v) ? v : (HEADER_VAR_DEFAULT[name] ?? 0);
}

/** 머리말 변수를 바꾼다(명령 취소 한 단계. FILLMODE·QTEXTMODE는 편집 관리자가 곧바로 다시 그린다) */
function setHeaderVar(st: DocState, ctx: CommandContext, label: string, name: string, value: number): void {
  const key = `$${name}`;
  const before: HeaderValue | undefined = st.doc.header.get(key);
  if (before === value) return;
  const ops: EditOp[] = [{ kind: 'header', name: key, before, after: value }];
  st.session.commit({ label, ops, group: ctx.group });
}

/** 켜기/끄기 프롬프트(`모드 입력 [켜기(ON)/끄기(OFF)] <켜기>:`). 답이 없으면 null */
async function askOnOff(ctx: CommandContext, cur: boolean, arg?: string): Promise<boolean | null> {
  let k = arg?.trim().toUpperCase();
  if (!k) {
    const r = await ctx.getPoint(`모드 입력 [켜기(ON)/끄기(OFF)] <${cur ? '켜기' : '끄기'}>:`, { keywords: ON_OFF });
    if (!('keyword' in r)) return null;
    k = r.keyword;
  }
  if (k === 'ON' || k === '켜기') return true;
  if (k === 'OFF' || k === '끄기') return false;
  ctx.print('켜기(ON) 또는 끄기(OFF)를 입력하십시오.', 'err');
  return null;
}

/** 정수 머리말 변수 명령(`FILLMODE에 대한 새 값 입력 <1>:`) */
async function askHeaderVar(app: App, ctx: CommandContext, name: string, arg?: string): Promise<void> {
  const st = app.active!;
  const ok = HEADER_VAR_RANGE[name] ?? [0, 1];
  const cur = headerVar(st, name);
  let text = arg?.trim();
  for (;;) {
    if (text === undefined) {
      const r = await ctx.getPoint(`${name}에 대한 새 값 입력 <${cur}>:`, { allowText: true, preferNumber: true });
      if (!('text' in r)) return;
      text = r.text.trim();
    }
    if (text === '') return;
    const n = Number(text);
    if (/^-?\d+$/.test(text) && ok.includes(n)) {
      setHeaderVar(st, ctx, name, name, n);
      return;
    }
    ctx.print(`${ok.join(', ')} 중 하나를 입력하십시오.`, 'err');
    if (arg !== undefined) return;
    text = undefined;
  }
}

// ---------------------------------------------------------------------------
// 끌기(DRAGMODE)
// ---------------------------------------------------------------------------

type PointOpts = Parameters<CommandContext['getPoint']>[1];
let reqSerial = 0;
let lastRequest = 0;
/** DRAGMODE 켜기(1)에서 DRAG를 입력한 점 요청 */
let dragFor = -1;

/** DRAGMODE: 0 끄기(끌기 미리보기 없음 — 기준점에서 고무줄만), 1 켜기(DRAG를 입력해야), 2 자동 */
function dragAllowed(app: App, id: number): boolean {
  const m = headerVar(app.active, 'DRAGMODE');
  return m === 2 || (m === 1 && dragFor === id);
}

/** 점 요청의 끌기 미리보기(ghost·rubber)를 DRAGMODE에 따라 거른다(app.ts의 점 요청을 감싼다) */
function installDragHook(app: App): void {
  const p = app as unknown as { requestPoint: (prompt: string, opt: PointOpts, signal: AbortSignal) => Promise<PointResult> };
  const orig = p.requestPoint.bind(app);
  p.requestPoint = (prompt, opt = {}, signal) => {
    const id = ++reqSerial;
    lastRequest = id;
    const o = { ...opt };
    if (opt.ghost) {
      const g = opt.ghost;
      o.ghost = (q) => (dragAllowed(app, id) ? g(q) : []);
    }
    if (opt.rubber) {
      const rb = opt.rubber;
      const base = opt.base ?? null;
      o.rubber = (q) => (dragAllowed(app, id) ? rb(q) : base ? [{ pts: [base.x, base.y, q.x, q.y] }] : []);
    }
    return orig(prompt, o, signal);
  };
  // 점 프롬프트에서 DRAG를 입력하면(문자를 받는 프롬프트여도) 그 프롬프트에서 끌기 미리보기
  const pi = app as unknown as { onInput: (t: string) => void; request: { kind: string } | null };
  const input = pi.onInput.bind(app);
  pi.onInput = (t: string) => {
    if (pi.request?.kind === 'point' && /^'?DRAG$/i.test(t.trim())) {
      dragNow(app, (text, cls) => app.cmd.print(text, cls));
      return;
    }
    input(t);
  };
}

/** DRAG: DRAGMODE 켜기(1)일 때 지금 점 프롬프트에서 끌기 미리보기를 보인다 */
function dragNow(app: App, print: (text: string, cls?: 'err' | 'res') => void): void {
  const m = headerVar(app.active, 'DRAGMODE');
  if (m === 0) {
    print('DRAGMODE가 끄기(0)라 끌기 미리보기를 보이지 않습니다. DRAGMODE를 켜기나 자동으로 바꾸십시오.');
    return;
  }
  dragFor = lastRequest;
  app.view.requestOverlay();
}

// ---------------------------------------------------------------------------
// 덧그림(등각 격자·십자선, 최대화 테두리)
// ---------------------------------------------------------------------------

/**
 * 덧그림 고리를 이어 붙인다. main.ts가 등록 뒤에 extraOverlay(구속 표식)를 대입하므로 지금 할 일을 마친 뒤(다음 틀) 감싼다.
 */
function chainOverlay(app: App): void {
  const v = app.view;
  const prev = v.extraOverlay;
  v.extraOverlay = (g, W, dark) => {
    prev?.(g, W, dark);
    drawIsoOverlay(app, g, W, dark);
    drawVpMaxOverlay(app, g);
  };
  v.requestOverlay();
}

// ---------------------------------------------------------------------------
// 배치 뷰포트 고르기
// ---------------------------------------------------------------------------

/** MSPACE면 명령을 끊지 않고 도면 공간으로(app.exitViewport는 실행 중인 명령을 취소한다) */
function toPaper(app: App, st: DocState): void {
  if (!st.msVp) return;
  app.flushViewportView();
  st.space = st.msVp.layout;
  st.msVp = null;
  st.selection.clear();
  app.view.setState(st);
  app.ui.refreshLayouts();
  app.ui.refreshStatus();
  app.ui.refreshPalette();
  app.refreshSelectionOverlay();
}

/** 배치의 뷰포트(꺼진 것·전체 용지 뷰포트 제외) */
function viewportsOn(st: DocState): ViewportEntity[] {
  const lay = st.layoutFor(st.msVp?.layout ?? st.space);
  return lay ? layoutViewports(st.doc, lay) : [];
}

/** 종이 점이 든 뷰포트(가장 앞, 같으면 작은 것) */
function viewportAt(vps: readonly ViewportEntity[], p: Pt): ViewportEntity | null {
  let best: ViewportEntity | null = null;
  for (const v of vps) if (insideViewport(v, p) && (!best || v.width * v.height <= best.width * best.height)) best = v;
  return best;
}

async function pickViewport(ctx: CommandContext, vps: readonly ViewportEntity[], prompt: string): Promise<ViewportEntity | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt);
    if (!('point' in r)) return null;
    const vp = viewportAt(vps, r.point);
    if (vp) return vp;
    ctx.print('뷰포트를 찾을 수 없습니다.', 'err');
  }
}

function needLayout(app: App, ctx: CommandContext): DocState | null {
  const st = app.active!;
  if (!st.onLayout || st.blockEdit) {
    ctx.print('** 모형 탭에서는 명령을 사용할 수 없습니다 **', 'err');
    return null;
  }
  return st;
}

// ---------------------------------------------------------------------------
// 등록
// ---------------------------------------------------------------------------

export function registerViewToolCommands(app: App): void {
  installIsoHooks(app);
  registerIsoCommands(app);
  registerXCompareCommands(app);
  installDragHook(app);
  setTimeout(() => chainOverlay(app), 0);

  // ------------------------------------------------------------- VPMAX·VPMIN
  app.register({ name: 'VPMAX', title: '뷰포트 최대화', run: (ctx) => vpMax(app, ctx) });
  app.register({
    name: 'VPMIN',
    title: '뷰포트 최소화(복원)',
    async run(ctx) {
      await vpMin(app, ctx);
    },
  });
  app.register({ name: 'VPMAXPREV', title: '최대화한 뷰포트: 이전 뷰포트', run: (ctx) => vpMaxStep(app, ctx, -1) });
  app.register({ name: 'VPMAXNEXT', title: '최대화한 뷰포트: 다음 뷰포트', run: (ctx) => vpMaxStep(app, ctx, 1) });

  // ------------------------------------------------------------- VPSCALE
  app.register({
    name: 'VPSCALE',
    title: '뷰포트 축척 보기',
    transparent: true,
    async run(ctx) {
      const st = needLayout(app, ctx);
      if (!st) return;
      const vps = viewportsOn(st);
      if (!vps.length) {
        ctx.print('이 배치에 뷰포트가 없습니다.', 'err');
        return;
      }
      let vp: ViewportEntity | null = null;
      if (st.msVp) vp = vps.find((v) => v.handle === st.msVp!.handle) ?? null;
      else {
        const sel = [...st.selection].map((h) => st.doc.entityIndex.get(h)).find((e): e is ViewportEntity => e?.type === 'VIEWPORT');
        vp = sel ?? (vps.length === 1 ? vps[0]! : await pickViewport(ctx, vps, '축척을 나열할 뷰포트 선택:'));
      }
      if (!vp) return;
      for (const line of vpScaleLines(vp)) ctx.print(line, 'res');
    },
  });

  // ------------------------------------------------------------- VPSYNC
  app.register({
    name: 'VPSYNC',
    title: '뷰포트 동기화',
    async run(ctx) {
      const st = needLayout(app, ctx);
      if (!st) return;
      if (viewportsOn(st).length < 2) {
        ctx.print('동기화하려면 뷰포트가 둘 이상 있어야 합니다.', 'err');
        return;
      }
      toPaper(app, st);
      const vps = viewportsOn(st);
      const master = await pickViewport(ctx, vps, '마스터 뷰포트 선택:');
      if (!master) return;
      if (!(vpScale(master) > 0)) {
        ctx.print('마스터 뷰포트의 축척을 알 수 없습니다.', 'err');
        return;
      }
      const hs = await ctx.getSelection('마스터 뷰포트에 맞춰 정렬할 뷰포트 선택:', { noPickfirst: true });
      const own = new Set(vps.map((v) => v.handle));
      const targets = hs
        .map((h) => st.doc.entityIndex.get(h))
        .filter((e): e is ViewportEntity => e?.type === 'VIEWPORT' && e.handle !== master.handle && own.has(e.handle));
      if (!targets.length) {
        ctx.print('정렬할 뷰포트를 고르지 않았습니다.');
        return;
      }
      const ops: EditOp[] = [];
      let locked = 0;
      let twisted = 0;
      for (const t of targets) {
        if (t.flags & VP_LOCKED) {
          locked++;
          continue;
        }
        const p = syncViewport(master, t);
        if (!p) {
          twisted++;
          continue;
        }
        ops.push({ kind: 'modify', block: st.space, before: t, after: { ...t, viewHeight: p.viewHeight, viewCenter: p.viewCenter } });
      }
      if (ops.length) st.session.commit({ label: 'VPSYNC', ops, group: ctx.group });
      const k = vpScale(master);
      const ratio = k >= 1 ? `${shortNumber(k)}:1` : `1:${shortNumber(1 / k)}`;
      if (ops.length) ctx.print(`뷰포트 ${ops.length}개를 마스터 뷰포트 ${master.id}에 맞췄습니다(축척 ${ratio}).`, 'res');
      if (locked) ctx.print(`화면표시가 잠긴 뷰포트 ${locked}개는 건너뛰었습니다.`);
      if (twisted) ctx.print(`비틀기 각도가 마스터와 다른 뷰포트 ${twisted}개는 맞출 수 없습니다.`, 'err');
    },
  });

  // ------------------------------------------------------------- FILL·FILLMODE
  app.register({
    name: 'FILL',
    title: '채우기 모드',
    transparent: true,
    async run(ctx, arg) {
      const st = app.active!;
      const on = await askOnOff(ctx, headerVar(st, 'FILLMODE') !== 0, arg);
      if (on !== null) setHeaderVar(st, ctx, 'FILL', 'FILLMODE', on ? 1 : 0);
    },
  });
  app.register({ name: 'FILLMODE', title: '채우기 모드 변수(0 끄기, 1 켜기)', transparent: true, run: (ctx, arg) => askHeaderVar(app, ctx, 'FILLMODE', arg) });

  // ------------------------------------------------------------- QTEXT·QTEXTMODE
  app.register({
    name: 'QTEXT',
    title: '빠른 문자',
    transparent: true,
    async run(ctx, arg) {
      const st = app.active!;
      const on = await askOnOff(ctx, headerVar(st, 'QTEXTMODE') !== 0, arg);
      if (on !== null) setHeaderVar(st, ctx, 'QTEXT', 'QTEXTMODE', on ? 1 : 0);
    },
  });
  app.register({ name: 'QTEXTMODE', title: '빠른 문자 변수(0 끄기, 1 켜기)', transparent: true, run: (ctx, arg) => askHeaderVar(app, ctx, 'QTEXTMODE', arg) });

  // ------------------------------------------------------------- DRAGMODE·DRAG
  app.register({
    name: 'DRAGMODE',
    title: '끌기 모드',
    transparent: true,
    async run(ctx, arg) {
      const st = app.active!;
      const cur = headerVar(st, 'DRAGMODE');
      let k = arg?.trim().toUpperCase();
      if (!k) {
        const label = cur === 0 ? '끄기' : cur === 1 ? '켜기' : '자동';
        const r = await ctx.getPoint(`새 값 입력 [켜기(ON)/끄기(OFF)/자동(A)] <${label}>:`, { keywords: [...ON_OFF, { key: 'A', label: '자동' }] });
        if (!('keyword' in r)) return;
        k = r.keyword;
      }
      const v = k === 'OFF' ? 0 : k === 'ON' ? 1 : k === 'A' || k === 'AUTO' ? 2 : /^[012]$/.test(k) ? Number(k) : -1;
      if (v < 0) {
        ctx.print('켜기(ON), 끄기(OFF) 또는 자동(A)을 입력하십시오.', 'err');
        return;
      }
      setHeaderVar(st, ctx, 'DRAGMODE', 'DRAGMODE', v);
    },
  });
  app.register({
    name: 'DRAG',
    title: '끌기(DRAGMODE 켜기일 때 지금 프롬프트에서 끌기 미리보기)',
    transparent: true,
    run(ctx) {
      dragNow(app, (text, cls) => ctx.print(text, cls));
    },
  });

}
