/**
 * CAD 표준: STANDARDS(표준 구성), CHECKSTANDARDS(표준 검사).
 *
 * - 사용자가 고른 표준 파일(DWS·DWG·DXF)의 도면층·선종류·문자 스타일·치수 스타일을 이 도면과 비교한다.
 * - 표준 파일 연결은 AutoCAD 형식(루트 사전 AcStStandard → "0"·"1"… XRECORD의 1 = 파일 경로)으로 저장한다 — AutoCAD의
 *   STANDARDS에도 보인다. AutoCAD가 적은 전체 경로는 그대로 두고, 같은 파일인지는 파일 이름(경로 제외, 대소문자 무시)으로 맞춘다.
 *   예전 이 앱 기록(OPENCAD_STANDARDS)도 읽고, 연결을 저장할 때 AcStStandard로 옮긴다.
 * - 브라우저는 저장된 경로의 파일을 열 수 없으므로 표준 파일 내용은 이 세션 동안만 기억한다. 도면을 다시 열면 다시 고르게 안내한다.
 */
import type { CadDocument, DimensionEntity, Entity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import {
  STD_KINDS,
  STD_KIND_LABEL,
  type StdKind,
  type StdProblem,
  type StdSource,
  checkStandards,
  diffsOf,
  fixPropsOps,
  readStandardsLink,
  recordOf,
  replacePlan,
  sameStdFile,
  standardsLinkOps,
  stdFileBase,
} from '../edit/layertools/standards';
import type { App, CommandContext } from './app';
import { dimensionBlockOps } from './dimcmds';
import type { DocState } from './docstate';
import { pickAndReadDrawings } from './drawingfiles';
import { PickList, wideDialog } from './layertools-ui';
import { commitResults } from './modify';
import { ask, form, h } from './ui/dom';

interface StdFile {
  name: string;
  /** 이 세션에서 읽은 내용(다시 골라야 하면 null) */
  doc: CadDocument | null;
}

interface StdState {
  files: StdFile[];
  kinds: Set<StdKind>;
  ignored: Set<string>;
}

/** 도면별 표준 상태(세션 동안) */
const states = new WeakMap<CadDocument, StdState>();
/** CAD 표준 설정(세션 동안) */
const config = { autoFix: false, showIgnored: false };

function stateOf(doc: CadDocument): StdState {
  let s = states.get(doc);
  if (!s) {
    s = { files: readStandardsLink(doc).map((name) => ({ name, doc: null })), kinds: new Set(STD_KINDS), ignored: new Set() };
    states.set(doc, s);
  }
  // 도면에 연결된 이름 가운데 아직 목록에 없는 것(명령 취소 등)
  for (const n of readStandardsLink(doc)) if (!s.files.some((f) => sameStdFile(f.name, n))) s.files.push({ name: n, doc: null });
  return s;
}

function loadedSources(s: StdState): StdSource[] {
  return s.files.filter((f): f is { name: string; doc: CadDocument } => !!f.doc).map((f) => ({ name: f.name, doc: f.doc }));
}

function missingNames(s: StdState): string[] {
  return s.files.filter((f) => !f.doc).map((f) => f.name);
}

async function settingsDialog(): Promise<void> {
  const v = await form(
    'CAD 표준 설정',
    [
      { key: 'autoFix', label: '비표준 특성 자동 수정(U)', type: 'check', value: config.autoFix },
      { key: 'showIgnored', label: '무시된 문제 표시(I)', type: 'check', value: config.showIgnored },
    ],
    { ok: '확인' },
  );
  if (!v) return;
  config.autoFix = !!v.autoFix;
  config.showIgnored = !!v.showIgnored;
}

/** 표준 파일 연결을 도면에 쓴다(바뀐 것이 있을 때만) */
function saveLink(st: DocState, ctx: CommandContext, s: StdState): void {
  const ops = standardsLinkOps(
    st.doc,
    s.files.map((f) => f.name),
    () => st.session.newHandle(),
  );
  if (ops === null) {
    ctx.print('이 도면에는 이름 있는 객체 사전이 없어 표준 파일 연결을 저장하지 못했습니다(이 세션에서는 기억합니다).', 'err');
    return;
  }
  if (ops.length) st.session.commit({ label: 'STANDARDS', ops, group: ctx.group });
}

/** "표준 구성" 대화상자. 'check'면 표준 검사로 이어간다 */
async function configureDialog(app: App, ctx: CommandContext, st: DocState): Promise<'ok' | 'check' | null> {
  const s = stateOf(st.doc);
  const files: StdFile[] = s.files.map((f) => ({ ...f }));
  const kinds = new Set(s.kinds);
  const list = new PickList('표준 파일', false);
  const desc = h('div', { class: 'ltx-box ltx-note', style: 'min-height:110px' });
  const refresh = () => {
    list.setItems(files.map((f, i) => ({ key: String(i), label: stdFileBase(f.name), tag: f.doc ? '' : '다시 골라야 함', dim: !f.doc, title: f.doc ? f.name : `${f.name} — 이 세션에서 아직 읽지 않았습니다. 추가(+)로 같은 파일을 고르십시오.` })));
    describe();
  };
  const describe = () => {
    const i = Number(list.selection()[0] ?? -1);
    const f = files[i];
    if (!f) {
      desc.textContent = files.length ? '표준 파일을 고르면 내용이 보입니다.' : '연결된 표준 파일이 없습니다. 추가(+)로 DWS·DWG·DXF 파일을 고르십시오.';
      return;
    }
    if (!f.doc) {
      desc.textContent = `${f.name}: 이 도면에 연결되어 있지만 이 세션에서 아직 읽지 않았습니다. 브라우저는 저장된 경로를 열 수 없으므로 추가(+)로 같은 파일을 다시 고르십시오.`;
      return;
    }
    const d = f.doc;
    desc.replaceChildren(
      h('div', {}, h('b', {}, f.name)),
      h('div', {}, `도면층 ${d.layers.size}개, 선종류 ${d.linetypes.size}개, 문자 스타일 ${[...d.textStyles.values()].filter((x) => x.name).length}개, 치수 스타일 ${d.dimStyles.size}개`),
      h('div', {}, `형식: ${d.format.toUpperCase()} ${d.version}`),
    );
  };
  list.onChange = describe;
  const addBtn = h('button', { class: 'ltx-btn', type: 'button', title: '표준 파일 추가(F3)' }, '+ 추가');
  addBtn.addEventListener('click', async () => {
    const got = await pickAndReadDrawings(app, (t, c) => ctx.print(t, c));
    for (const g of got) {
      const i = files.findIndex((f) => sameStdFile(f.name, g.name));
      if (i >= 0) files[i] = { name: files[i]!.name, doc: g.doc };
      else files.push({ name: g.name, doc: g.doc });
    }
    refresh();
    if (got.length) list.setSelection([String(files.findIndex((f) => sameStdFile(f.name, got[got.length - 1]!.name)))]);
  });
  const delBtn = h('button', { class: 'ltx-btn', type: 'button', title: '표준 파일 제거(Del)' }, '− 제거');
  delBtn.addEventListener('click', () => {
    const i = Number(list.selection()[0] ?? -1);
    if (i < 0) return;
    files.splice(i, 1);
    refresh();
  });
  const move = (d: number) => {
    const i = Number(list.selection()[0] ?? -1);
    const j = i + d;
    if (i < 0 || j < 0 || j >= files.length) return;
    [files[i], files[j]] = [files[j]!, files[i]!];
    refresh();
    list.setSelection([String(j)]);
  };
  const upBtn = h('button', { class: 'ltx-btn', type: 'button', title: '위로 이동' }, '▲');
  upBtn.addEventListener('click', () => move(-1));
  const downBtn = h('button', { class: 'ltx-btn', type: 'button', title: '아래로 이동' }, '▼');
  downBtn.addEventListener('click', () => move(1));
  const checks = STD_KINDS.map((k) => {
    const c = h('input', { type: 'checkbox', checked: kinds.has(k), 'aria-label': STD_KIND_LABEL[k] }) as HTMLInputElement;
    c.addEventListener('change', () => {
      if (c.checked) kinds.add(k);
      else kinds.delete(k);
    });
    return h('label', { class: 'ltx-check' }, c, `${STD_KIND_LABEL[k]} 표준`);
  });
  const body = h(
    'div',
    { class: 'ltx-col' },
    h(
      'div',
      { class: 'ltx-row', style: 'align-items:stretch;flex-wrap:nowrap' },
      h('div', { class: 'ltx-col ltx-grow' }, h('div', { class: 'ltx-h' }, '이 도면과 연관된 표준 파일(F):'), list.el, h('div', { class: 'ltx-row' }, addBtn, delBtn, upBtn, downBtn)),
      h('div', { class: 'ltx-col ltx-grow' }, h('div', { class: 'ltx-h' }, '설명:'), desc, h('div', { class: 'ltx-h' }, '플러그인(검사할 종류):'), ...checks),
    ),
    h('div', { class: 'ltx-note' }, '표준 파일 이름은 이 도면에 저장하지만 내용은 이 세션 동안만 기억합니다. 도면을 다시 열면 같은 파일을 다시 고르십시오. 앞에 있는 파일의 정의가 이깁니다.'),
  );
  refresh();
  if (files.length) list.setSelection(['0']);
  const dlg = wideDialog('표준 구성', body, [
    { label: '표준 검사(C)...', value: 'check' },
    { label: '설정(S)...', value: 'settings', keep: () => (void settingsDialog(), true) },
    { label: '취소', value: 'cancel' },
    { label: '확인', value: 'ok', primary: true },
  ], 720);
  const r = await dlg.closed;
  if (r !== 'ok' && r !== 'check') return null;
  if (app.active !== st) return null;
  s.files = files;
  s.kinds = kinds;
  saveLink(st, ctx, s);
  return r;
}

/** 이 스타일을 쓰는 치수를 다시 만드는 작업(치수 스타일을 고친 뒤) */
function regenDimOps(st: DocState, styleName: string): EditOp[] {
  const ops: EditOp[] = [];
  const extra = new Set<string>();
  const key = tableKey(styleName);
  for (const [bk, b] of st.doc.blocks) {
    if (/^\*D\d+$/i.test(b.name)) continue;
    for (const e of b.entities) {
      if (e.type !== 'DIMENSION' || tableKey(e.dimStyle || 'Standard') !== key) continue;
      const copy = structuredClone(e) as DimensionEntity;
      try {
        ops.push(...dimensionBlockOps(st, copy, true, extra), { kind: 'modify', block: bk, before: e, after: copy as Entity });
      } catch {
        /* 생성기가 못 다루는 치수는 그대로 둔다 */
      }
    }
  }
  return ops;
}

/** 문제 하나 수정(성공하면 true) */
function fixProblem(app: App, ctx: CommandContext, st: DocState, p: StdProblem, candidate: number, sources: StdSource[]): boolean {
  const nh = () => st.session.newHandle();
  if (p.type === 'props') {
    const ops = fixPropsOps(st.doc, p, sources, nh);
    if (!ops.length) return false;
    st.session.commit({ label: 'CHECKSTANDARDS', ops, group: ctx.group });
    if (p.kind === 'dimStyle') {
      const re = regenDimOps(st, p.name);
      if (re.length) st.session.commit({ label: 'CHECKSTANDARDS', ops: re, group: ctx.group, rebuildNow: true });
    }
    return true;
  }
  const c = p.candidates[candidate];
  if (!c) return false;
  const plan = replacePlan(st.doc, p, c, sources, nh);
  if (!plan) return false;
  if (plan.pre.length) st.session.commit({ label: 'CHECKSTANDARDS', ops: plan.pre, group: ctx.group });
  if (plan.entities.length) commitResults(app, ctx, [{ replace: plan.entities.map((x) => x.after) }], 'CHECKSTANDARDS', { quiet: true });
  if (plan.post.length) st.session.commit({ label: 'CHECKSTANDARDS', ops: plan.post, group: ctx.group });
  if (p.kind === 'dimStyle') {
    const re = regenDimOps(st, plan.target);
    if (re.length) st.session.commit({ label: 'CHECKSTANDARDS', ops: re, group: ctx.group, rebuildNow: true });
  }
  return true;
}

function problemText(p: StdProblem): string {
  const k = STD_KIND_LABEL[p.kind];
  return p.type === 'name' ? `${k} "${p.name}"의 이름이 표준이 아닙니다(표준 파일에 없는 이름).` : `${k} "${p.name}"의 특성이 표준이 아닙니다.`;
}

async function checkFlow(app: App, ctx: CommandContext, st: DocState): Promise<void> {
  const s = stateOf(st.doc);
  const sources = loadedSources(s);
  if (!sources.length) {
    const miss = missingNames(s);
    const msg = miss.length
      ? `이 도면에 연결된 표준 파일(${miss.join(', ')})을 이 세션에서 아직 읽지 않았습니다. 표준 구성에서 같은 파일을 다시 고르십시오.`
      : '이 도면에 연결된 표준 파일이 없습니다. 표준 구성(STANDARDS)에서 표준 파일(DWS)을 연결하십시오.';
    ctx.print(msg, 'err');
    const r = await ask('표준 검사', msg, [
      { label: '취소', value: 'no' },
      { label: '표준 구성...', value: 'yes', primary: true },
    ]);
    if (r !== 'yes') return;
    const c = await configureDialog(app, ctx, st);
    if (!c || !loadedSources(stateOf(st.doc)).length) return;
    return checkFlow(app, ctx, st);
  }
  if (missingNames(s).length) ctx.print(`참고: 다시 고르지 않은 표준 파일(${missingNames(s).join(', ')})은 검사에 쓰지 않습니다.`);
  const kinds = STD_KINDS.filter((k) => s.kinds.has(k));
  const ignoredNow = config.showIgnored ? new Set<string>() : s.ignored;
  let problems = checkStandards(st.doc, sources, kinds, ignoredNow);
  const total = problems.length;
  let autoFixed = 0;
  let fixed = 0;
  let ignoredCount = 0;
  if (config.autoFix) {
    for (const p of problems.filter((x) => x.type === 'props')) if (fixProblem(app, ctx, st, p, 0, sources)) autoFixed++;
    problems = checkStandards(st.doc, sources, kinds, ignoredNow);
  }
  // 문제 하나씩
  const queue = [...problems];
  let idx = 0;
  while (idx < queue.length && app.active === st) {
    // 앞의 수정으로 바뀌었을 수 있으니 다시 확인
    const fresh = checkStandards(st.doc, sources, [queue[idx]!.kind], ignoredNow).find((x) => x.id === queue[idx]!.id);
    if (!fresh) {
      idx++;
      continue;
    }
    const p = fresh;
    const cand = new PickList('대체 대상', false);
    cand.setItems(p.candidates.map((c, i) => ({ key: String(i), label: `${i === p.recommended ? '✓ ' : ''}${c.name}`, tag: sources[c.source]?.name ?? '' })));
    if (p.candidates.length) cand.setSelection([String(Math.max(0, p.recommended))], false);
    const preview = h('table', { class: 'ltx-table' });
    const showPreview = () => {
      const i = Number(cand.selection()[0] ?? -1);
      const c = p.candidates[i];
      const cur = recordOf(st.doc, p.kind, p.name);
      const std = c ? recordOf(sources[c.source]!.doc, p.kind, c.name) : undefined;
      const diffs = p.type === 'props' ? p.diffs : cur && std ? diffsOf(p.kind, cur, std) : [];
      preview.replaceChildren(
        h('tr', {}, h('th', {}, '특성'), h('th', {}, '현재 값'), h('th', {}, '표준 값')),
        ...(p.type === 'name' && c ? [h('tr', {}, h('td', {}, '이름'), h('td', {}, p.name), h('td', {}, c.name))] : []),
        ...diffs.map((d) => h('tr', {}, h('td', {}, d.label), h('td', {}, d.current), h('td', {}, d.standard))),
      );
    };
    cand.onChange = showPreview;
    showPreview();
    const ignore = h('input', { type: 'checkbox', checked: s.ignored.has(p.id), 'aria-label': '이 문제를 무시된 것으로 표시' }) as HTMLInputElement;
    const body = h(
      'div',
      { class: 'ltx-col' },
      h('div', { class: 'ltx-h' }, `문제(P): ${idx + 1} / ${queue.length}`),
      h('div', { class: 'ltx-box' }, problemText(p)),
      h('div', { class: 'ltx-h' }, p.type === 'name' ? '대체 대상(R):' : '표준 객체(R):'),
      cand.el,
      h('div', { class: 'ltx-h' }, '변경 사항 미리보기(V):'),
      h('div', { class: 'ltx-list', style: 'max-height:180px;min-height:60px' }, preview),
      h('label', { class: 'ltx-check' }, ignore, '이 문제를 무시된 것으로 표시(I)'),
    );
    cand.el.style.minHeight = '80px';
    cand.el.style.maxHeight = '160px';
    const dlg = wideDialog('표준 검사', body, [
      { label: '닫기', value: 'close' },
      { label: '다음 문제(N)', value: 'next' },
      { label: '수정(F)', value: 'fix', primary: true, keep: () => p.type === 'name' && !p.candidates.length },
    ], 620);
    cand.onActivate = () => (dlg.box.querySelector('footer .btn.primary') as HTMLButtonElement | null)?.click();
    const r = await dlg.closed;
    if (ignore.checked) {
      if (!s.ignored.has(p.id)) ignoredCount++;
      s.ignored.add(p.id);
    } else s.ignored.delete(p.id);
    if (r === 'fix') {
      if (fixProblem(app, ctx, st, p, Number(cand.selection()[0] ?? p.recommended), sources)) fixed++;
    } else if (r !== 'next') break;
    idx++;
  }
  const left = checkStandards(st.doc, sources, kinds, s.ignored).length;
  const summary = `검사한 문제 ${total}개: 자동 수정 ${autoFixed}개, 수정 ${fixed}개, 무시된 것으로 표시 ${ignoredCount}개. 남은 문제 ${left}개.`;
  ctx.print(`표준 검사 완료 — ${summary}`);
  await ask('검사 완료', total ? summary : '표준 위반이 없습니다.', [{ label: '닫기', value: 'ok', primary: true }]);
}

export function registerStandardsCommands(app: App): void {
  app.register({
    name: 'STANDARDS',
    aliases: ['STA'],
    title: 'CAD 표준 구성',
    async run(ctx) {
      const st = app.active!;
      const r = await configureDialog(app, ctx, st);
      if (r === 'check') await checkFlow(app, ctx, st);
    },
  });
  app.register({
    name: 'CHECKSTANDARDS',
    aliases: ['CHK'],
    title: 'CAD 표준 검사',
    async run(ctx) {
      await checkFlow(app, ctx, app.active!);
    },
  });
}

/** 시험·다른 모듈용: 이 도면의 표준 파일(읽은 것만)을 정한다 */
export function setStandardSources(doc: CadDocument, sources: StdSource[]): void {
  const s = stateOf(doc);
  s.files = sources.map((x) => ({ name: x.name, doc: x.doc }));
}
