/**
 * 도면 비교: COMPARE, -COMPARE, COMPAREINFO, COMPAREIMPORT, COMPAREEXPORT, COMPARECLOSE와 비교 시스템 변수 명령.
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다. 계산은 src/edit/compare, 화면 요소는 compare-ui.ts.
 *
 * 비교 결과는 현재 도면 창에 보인다: 현재 도면에만 있는 객체 COMPARECOLOR1, 비교 도면에만 있는 객체
 * COMPARECOLOR2(그 도면의 객체를 겹쳐 그린다 — 고르거나 스냅하거나 저장되지 않는다), 차이 없음 COMPARECOLORCOMMON,
 * 변경 세트마다 구름형 리비전. 비교 중 도면을 고치면 1.5초 뒤(명령이 없을 때) 다시 비교한다.
 */
import type { App, CommandContext, Keyword } from './app';
import type { DocState } from './docstate';
import type { CadDocument, HeaderValue, MTextEntity } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { buildSnapshot, planImport, stripEntity } from '../edit/compare';
import { CLOUD_ACI, type CompareSource, CompareSession } from './compare-session';
import { CompareToolbar, chooseDrawing, pickDrawingFile, showInfo } from './compare-ui';
import { askCompareVar, getCompareVar, onCompareVarsChange, registerCompareVarCommands, setCompareVars } from './compare-vars';
import { Picker } from './pick';
import { commitResults } from './modify';
import { type EditResult, copyEntity } from '../edit/geom';
import { addEntities, currentProps } from './draw';
import { baseName } from './export';
import type { Pt } from './view';
import type { EntityBox } from '../render/displaylist';
import type { Box } from '../edit/compare';

let session: CompareSession | null = null;
let toolbar: CompareToolbar | null = null;
let unlisten: (() => void) | null = null;

/** 지금 비교 세션(없으면 null) */
export function activeCompare(): CompareSession | null {
  return session && !session.closed ? session : null;
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 30));

function boxMap(list: readonly EntityBox[]): Map<string, Box> {
  const m = new Map<string, Box>();
  for (const b of list) m.set(b.handle, b);
  return m;
}

function sourceFromDoc(d: DocState): CompareSource {
  const boxes = boxMap(d.scenes.get(MODEL_SPACE)?.entities ?? []);
  // 편집한 객체는 편집 덧그림의 상자
  const ed = d.edits.get(MODEL_SPACE);
  for (const b of ed?.overlay?.entities ?? []) if (ed?.live.has(b.handle)) boxes.set(b.handle, b);
  return { name: d.name, doc: d.doc, bounds: d.scenes.get(MODEL_SPACE)?.bounds ?? null, boxes, size: d.size, workerDocId: d.docId, open: d };
}

async function sourceFromFile(app: App, ctx: CommandContext, file: File): Promise<CompareSource | null> {
  app.ui.setBusy(`${file.name} 읽는 중…`, 0);
  try {
    const res = await app.engine.open(file.name, await file.arrayBuffer(), (stage, f) => app.ui.setBusy(stage === 'read' ? '비교할 도면 읽는 중…' : '비교할 도면 준비 중…', stage === 'read' ? f * 0.8 : 0.9));
    // 워커 문서는 비교가 끝날 때까지 둔다("비교 도면에서만" 객체를 워커가 그린다)
    const l = res.model.list;
    const bounds = Number.isFinite(l.minX) && l.minX <= l.maxX ? { minX: l.minX, minY: l.minY, maxX: l.maxX, maxY: l.maxY } : null;
    return { name: file.name, doc: res.doc, bounds, boxes: boxMap(l.entities), size: file.size, workerDocId: res.docId };
  } catch (e) {
    ctx.print(`${file.name}: 도면을 읽지 못했습니다(${e instanceof Error ? e.message : String(e)}).`, 'err');
    return null;
  } finally {
    app.ui.setBusy(null);
  }
}

function summary(s: CompareSession): string {
  const r = s.result!;
  const f = r.filtered.current + r.filtered.compare;
  return `현재 도면에서만 ${r.onlyCurrent.length}개, 비교 도면에서만 ${r.onlyCompare.length}개, 차이 없음 ${r.common}개, 변경 세트 ${s.sets.length}개${f ? ` (비교하지 않은 문자·해치 ${f}개)` : ''}.`;
}

/** 도면 비교를 시작하기 전에 부르는 것(외부 참조 비교가 자기 비교를 닫는다) */
export const beforeCompare = new Set<() => void>();

/** 도면 비교를 끝낸다(열려 있었으면 true). 외부 참조 비교가 시작할 때 부른다 */
export function closeCompare(): boolean {
  return endCompare();
}

/** 비교를 끝낸다 */
function endCompare(): boolean {
  const s = session;
  session = null;
  toolbar?.dispose();
  toolbar = null;
  unlisten?.();
  unlisten = null;
  if (!s || s.closed) return false;
  s.close();
  return true;
}

async function startCompare(app: App, ctx: CommandContext, st: DocState, src: CompareSource): Promise<void> {
  endCompare();
  for (const f of beforeCompare) f();
  if (st.blockEdit) {
    if (!src.open) app.engine.closeDoc(src.workerDocId);
    ctx.print('블록 편집기에서는 도면을 비교할 수 없습니다.', 'err');
    return;
  }
  if (st.space !== MODEL_SPACE || st.msVp) await app.setSpace(MODEL_SPACE);
  const s = new CompareSession(app, st, src);
  app.ui.setBusy('도면 비교 중…', 0.5);
  await nextFrame();
  try {
    s.compare();
  } finally {
    app.ui.setBusy(null);
  }
  s.install();
  session = s;
  const tb = new CompareToolbar(app, s, {
    prev: () => void app.run('-COMPARE', 'P'),
    next: () => void app.run('-COMPARE', 'N'),
    importObjects: () => void app.run('COMPAREIMPORT'),
    exportSnapshot: () => void app.run('COMPAREEXPORT'),
    info: () => void app.run('COMPAREINFO'),
    close: () => void app.run('COMPARECLOSE'),
  });
  toolbar = tb;
  s.onUpdate = () => {
    // 비교한 도면을 닫으면 세션이 스스로 끝난다: 도구막대도 치운다
    if (s.closed) {
      if (session === s) endCompare();
      return;
    }
    tb.update();
  };
  s.onTick = () => tb.setVisible(app.active === st);
  s.onRecompared = () => app.cmd.print(`다시 비교했습니다: ${summary(s)}`);
  unlisten = onCompareVarsChange((names) => s.applySettings(names));
  const r = s.result!;
  const t = s.timing;
  ctx.print(`"${st.name}"과(와) "${src.name}"을(를) 비교했습니다(맞추기 ${Math.round(t.compare)}ms, 그리기 ${Math.round(t.scenes + t.sets)}ms${r.sameLineage ? ', 같은 계보 — 핸들로 맞춤' : ''}).`);
  ctx.print(summary(s), 'res');
}

/** 열린 다른 도면 이름으로 찾기(확장자는 없어도 된다) */
function findOpen(app: App, st: DocState, name: string): DocState | null {
  const n = name.trim().replace(/^"|"$/g, '').toUpperCase();
  return app.docs.find((d) => d !== st && (d.name.toUpperCase() === n || baseName(d.name).toUpperCase() === n)) ?? null;
}

/** 지금 도면의 비교 세션(아니면 알리고 null) */
function need(app: App, ctx: CommandContext): CompareSession | null {
  const s = activeCompare();
  if (!s || s.st !== app.active) {
    ctx.print('비교 중인 도면이 아닙니다. 먼저 COMPARE로 도면을 비교하십시오.', 'err');
    return null;
  }
  if (!s.fresh && !s.busy) s.compare();
  return s;
}

const RELEASE: Record<string, string> = {
  AC1009: 'R12',
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: '2000',
  AC1018: '2004',
  AC1021: '2007',
  AC1024: '2010',
  AC1027: '2013',
  AC1032: '2018',
};

function formatOf(doc: CadDocument): string {
  if (doc.format === 'new') return '새 도면';
  return `${doc.format.toUpperCase()} ${RELEASE[doc.version] ?? doc.version}`;
}

function julian(v: HeaderValue | undefined): string {
  if (typeof v !== 'number' || !(v > 2000000)) return '-';
  // 율리우스일은 저장한 곳의 현지 시각이다: 시간대를 더하지 않고 그대로 보인다
  return new Date((v - 2440587.5) * 86400000).toLocaleString('ko-KR', { timeZone: 'UTC' });
}

function text(v: HeaderValue | undefined): string {
  return typeof v === 'string' && v.trim() ? v.trim() : '-';
}

function infoRows(s: CompareSession): ([string, string] | [string])[] {
  const r = s.result!;
  const doc = (title: string, name: string, d: CadDocument): ([string, string] | [string])[] => [
    [title],
    ['이름', name],
    ['형식', formatOf(d)],
    ['저장한 사람', text(d.header.get('$LASTSAVEDBY'))],
    ['마지막 수정', julian(d.header.get('$TDUPDATE'))],
  ];
  const rows: ([string, string] | [string])[] = [
    ...doc('현재 도면', s.st.name, s.st.doc),
    ...doc('비교 도면', s.src.name, s.src.doc),
    ['비교 결과'],
    ['현재 도면에서만', `${r.onlyCurrent.length}개`],
    ['비교 도면에서만', `${r.onlyCompare.length}개`],
    ['차이 없음', `${r.common}개`],
    ['변경 세트', `${s.sets.length}개`],
  ];
  const f = r.filtered.current + r.filtered.compare;
  if (f) rows.push(['비교하지 않음(문자·해치 필터)', `${f}개`]);
  return rows;
}

/** 여러 줄 문자 서식 문자를 글자 그대로 */
const mtextEscape = (t: string) => t.replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => `\\${c}`);

async function compareInfo(app: App, ctx: CommandContext): Promise<void> {
  const s = need(app, ctx);
  if (!s) return;
  const rows = infoRows(s);
  const lines = ['도면 비교 정보', ...rows.map((r) => (r.length === 1 ? `[${r[0]}]` : `${r[0]}: ${r[1]}`))];
  const choice = await showInfo(rows);
  if (choice === 'copy') {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      ctx.print('도면 비교 정보를 클립보드로 복사했습니다.');
    } catch {
      ctx.print('클립보드를 쓸 수 없습니다(브라우저 권한).', 'err');
    }
    return;
  }
  if (choice !== 'insert') return;
  const st = app.active!;
  const p = await ctx.getPoint('삽입점 지정:');
  if (!('point' in p)) return;
  // 문자 높이는 TEXTSIZE(여러 줄 문자 명령의 기본값과 같다)
  const ts = st.doc.header.get('$TEXTSIZE');
  const height = typeof ts === 'number' && ts > 0 ? ts : 2.5;
  const style = String(st.doc.header.get('$TEXTSTYLE') ?? 'Standard');
  const m: MTextEntity = {
    ...currentProps(app),
    type: 'MTEXT',
    handle: '',
    insert: { x: p.point.x, y: p.point.y, z: 0 },
    height,
    width: 0,
    attachment: 1,
    drawingDirection: 1,
    text: lines.map(mtextEscape).join('\\P'),
    style: st.doc.textStyles.get(tableKey(style))?.name ?? style,
    rotation: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
    backgroundFlags: 0,
    backgroundScale: 1.5,
  };
  app.lastCreated = addEntities(app, ctx, [m], 'COMPAREINFO');
  ctx.print('도면 비교 정보를 도면에 넣었습니다.');
}

async function compareImport(app: App, ctx: CommandContext): Promise<void> {
  const s = need(app, ctx);
  if (!s) return;
  const st = app.active!;
  if (st.space !== MODEL_SPACE || st.msVp || st.blockEdit) {
    ctx.print('모형 공간에서 실행하십시오.', 'err');
    return;
  }
  const boxes = s.compareBoxes();
  if (!boxes.length) {
    ctx.print('비교된 도면에만 있는 객체가 없습니다.', 'err');
    return;
  }
  const pk = new Picker(s.src.doc, boxes, app.text, MODEL_SPACE);
  const chosen = new Set<string>();
  const geoms = () => [...chosen].slice(0, 3000).map((h) => pk.geometry(h));
  const show = () => {
    app.view.overlay.ghost = geoms();
    app.view.requestOverlay();
  };
  const all: Keyword[] = [{ key: 'ALL', label: '모두' }];
  try {
    for (;;) {
      const r = await ctx.getPoint('비교된 도면에서 가져올 객체 선택 [모두(ALL)]:', { keywords: all, ghost: geoms });
      if ('enter' in r) break;
      const before = chosen.size;
      if ('keyword' in r) {
        for (const b of boxes) chosen.add(b.handle);
      } else if ('point' in r) {
        const tol = app.view.overlay.pickbox * app.view.pixelSize();
        const h = pk.pick(r.point.x, r.point.y, tol);
        if (h) chosen.add(h);
        else {
          // 빈 곳: 창(왼쪽→오른쪽) 또는 걸침(오른쪽→왼쪽)
          const a: Pt = r.point;
          const rect = (b: Pt) => [a.x, a.y, b.x, a.y, b.x, b.y, a.x, b.y];
          const r2 = await ctx.getPoint('반대 구석 지정:', { rubber: (b) => [{ pts: rect(b), closed: true, dashed: b.x < a.x }], ghost: geoms });
          if (!('point' in r2)) continue;
          const b = r2.point;
          const box: [number, number, number, number] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
          for (const x of pk.select(box, b.x < a.x)) chosen.add(x);
        }
      } else continue;
      ctx.print(`${chosen.size - before}개를 찾음, 총 ${chosen.size}개`);
      show();
    }
  } finally {
    app.view.overlay.ghost = [];
    app.view.requestOverlay();
  }
  if (!chosen.size) return;
  // 붙여넣기처럼: 없는 도면층·선종류·스타일·블록을 함께(같은 이름 블록은 이 도면의 것), 명령 취소 한 단계
  const list = [...chosen]
    .map((h) => s.src.doc.entityIndex.get(h))
    .filter((e) => !!e)
    .map((e) => stripEntity(structuredClone(e!)));
  const plan = planImport(s.src.doc, st.doc, list, () => st.session.newHandle());
  const ops: EditOp[] = [];
  for (const l of plan.linetypes) ops.push({ kind: 'linetype', key: tableKey(l.name), before: null, after: l });
  for (const l of plan.layers) ops.push({ kind: 'layer', key: tableKey(l.name), before: null, after: l });
  for (const t of plan.textStyles) ops.push({ kind: 'textStyle', key: tableKey(t.name), before: null, after: t });
  for (const d of plan.dimStyles) ops.push({ kind: 'dimStyle', key: tableKey(d.name), before: null, after: d });
  for (const b of plan.blocks) {
    const key = tableKey(b.def.name);
    ops.push({ kind: 'blockRecord', key, before: null, after: b.record });
    ops.push({ kind: 'blockDef', key, before: null, after: b.def });
  }
  if (ops.length) st.session.commit({ label: 'COMPAREIMPORT', ops, group: ctx.group });
  st.selection.clear();
  // 붙여넣기(PASTECLIP)처럼 복사 결과로 넣는다(제자리, 치수 그림 블록은 이 도면의 치수 스타일로 다시 만든다)
  const results: EditResult[] = list.map((e) => copyEntity(e, [1, 0, 0, 1, 0, 0], st.doc));
  const a = commitResults(app, ctx, results, 'COMPAREIMPORT', { quiet: true });
  ctx.print(`${a.added.length}개를 가져왔습니다.`);
  void s.recompare();
}

async function compareExport(app: App, ctx: CommandContext): Promise<void> {
  const s = need(app, ctx);
  if (!s) return;
  const r = s.result!;
  const set = s.settings;
  app.ui.setBusy('스냅샷 만드는 중…', 0.3);
  await nextFrame();
  try {
    const snap = buildSnapshot({
      current: s.st.doc,
      compare: s.src.doc,
      onlyCurrent: r.onlyCurrent,
      onlyCompare: r.onlyCompare,
      clouds: s.clouds.map((c) => c.verts),
      colors: { current: set.color1, compare: set.color2, common: set.colorCommon, cloud: CLOUD_ACI },
    });
    // 스냅샷은 DWG로(QSAVE가 DWG로 저장한다). 쓸 수 없는 판이면 R2018
    snap.doc.format = 'dwg';
    delete snap.doc.binary;
    if (!/^AC10(15|18|24|27|32)$/.test(snap.doc.version)) snap.doc.version = 'AC1032';
    const ext = 'dwg';
    const stem = `Compare_${baseName(s.st.name)} vs ${baseName(s.src.name)}`;
    let name = `${stem}.${ext}`;
    for (let i = 2; app.docs.some((d) => d.saveName === name || d.name === name); i++) name = `${stem} (${i}).${ext}`;
    app.ui.setBusy('스냅샷 여는 중…', 0.7);
    const res = await app.engine.adopt(name, snap.doc);
    app.addDocument(res, name, 0);
    const c = snap.counts;
    ctx.print(`스냅샷 "${name}"을(를) 열었습니다: 현재 도면에서만 ${c.current}개, 차이 없음 ${c.common}개, 비교 도면에서만 ${c.compare}개, 구름형 리비전 ${c.clouds}개. QSAVE나 SAVEAS로 저장하십시오.`);
  } catch (e) {
    ctx.print(`스냅샷을 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
  } finally {
    app.ui.setBusy(null);
  }
}

async function step(app: App, ctx: CommandContext, s: CompareSession, d: number): Promise<void> {
  if (!s.sets.length) {
    ctx.print('변경 세트가 없습니다.');
    return;
  }
  if (s.st.space !== MODEL_SPACE || s.st.msVp) await app.setSpace(MODEL_SPACE);
  s.step(d);
  ctx.print(`변경 세트 ${s.current + 1}/${s.sets.length}`);
}

const ON_OFF: Keyword[] = [
  { key: 'ON', label: '켜기' },
  { key: 'OFF', label: '끄기' },
];

async function onOff(ctx: CommandContext, prompt: string, name: string): Promise<void> {
  const cur = Number(getCompareVar(name)) === 1;
  const r = await ctx.getPoint(`${prompt} [켜기(ON)/끄기(OFF)] <${cur ? '켜기' : '끄기'}>:`, { keywords: ON_OFF });
  if ('keyword' in r) setCompareVars({ [name]: r.keyword === 'ON' ? 1 : 0 });
}

async function choice(ctx: CommandContext, prompt: string, name: string, opts: { key: string; label: string; value: number }[]): Promise<void> {
  const cur = Number(getCompareVar(name));
  const def = opts.find((o) => o.value === cur)?.label ?? '';
  const r = await ctx.getPoint(`${prompt} [${opts.map((o) => `${o.label}(${o.key})`).join('/')}] <${def}>:`, { keywords: opts.map((o) => ({ key: o.key, label: o.label })) });
  if ('keyword' in r) setCompareVars({ [name]: opts.find((o) => o.key === r.keyword)!.value });
}

async function settingsPrompt(ctx: CommandContext): Promise<void> {
  const kws: Keyword[] = [
    { key: 'T', label: '문자' },
    { key: 'H', label: '해치' },
    { key: 'P', label: '특성' },
    { key: 'O', label: '허용 오차' },
    { key: 'R', label: '구름형 리비전' },
    { key: 'S', label: '쉐이프' },
    { key: 'M', label: '여백' },
    { key: 'F', label: '앞' },
  ];
  const r = await ctx.getPoint('설정 옵션 입력 [문자(T)/해치(H)/특성(P)/허용 오차(O)/구름형 리비전(R)/쉐이프(S)/여백(M)/앞(F)]:', { keywords: kws });
  if (!('keyword' in r)) return;
  switch (r.keyword) {
    case 'T':
      return onOff(ctx, '문자 비교', 'COMPARETEXT');
    case 'H':
      return onOff(ctx, '해치 비교', 'COMPAREHATCH');
    case 'P':
      return askCompareVar(ctx, 'COMPAREPROPS');
    case 'O':
      return askCompareVar(ctx, 'COMPARETOLERANCE');
    case 'R':
      return onOff(ctx, '구름형 리비전', 'COMPARESHOWRC');
    case 'S':
      return choice(ctx, '구름형 리비전 쉐이프', 'COMPARERCSHAPE', [
        { key: 'R', label: '직사각형', value: 0 },
        { key: 'P', label: '폴리곤', value: 1 },
      ]);
    case 'M':
      return askCompareVar(ctx, 'COMPARERCMARGIN');
    case 'F':
      return choice(ctx, '앞에 표시', 'COMPAREFRONT', [
        { key: 'C', label: '현재 도면', value: 1 },
        { key: 'O', label: '비교 도면', value: 2 },
      ]);
  }
}

export function registerCompareCommands(app: App): void {
  registerCompareVarCommands(app);

  // ------------------------------------------------------------- COMPARE
  app.register({
    name: 'COMPARE',
    title: '도면 비교',
    async run(ctx) {
      const st = app.active!;
      const others = app.docs.filter((d) => d !== st);
      let src: CompareSource | null = null;
      const browse = async () => {
        const f = await pickDrawingFile();
        return f ? sourceFromFile(app, ctx, f) : null;
      };
      if (others.length) {
        const c = await chooseDrawing(st, others);
        if (!c) return;
        src = c === 'browse' ? await browse() : sourceFromDoc(c);
      } else src = await browse();
      if (!src) return;
      if (!app.docs.includes(st)) {
        if (!src.open) app.engine.closeDoc(src.workerDocId);
        return;
      }
      if (app.active !== st) app.activate(st);
      await startCompare(app, ctx, st, src);
    },
  });

  // ------------------------------------------------------------- -COMPARE
  app.register({
    name: '-COMPARE',
    title: '도면 비교(명령행)',
    async run(ctx, arg) {
      const st = app.active!;
      const s = activeCompare();
      if (!s || s.st !== st) {
        let name = arg;
        if (name === undefined) {
          const r = await ctx.getPoint('비교할 도면 이름 입력 <찾아보기>:', { allowText: true, preferNumber: true });
          if ('enter' in r) name = '';
          else if ('text' in r) name = r.text;
          else return;
        }
        let src: CompareSource | null;
        if (!name.trim()) {
          const f = await pickDrawingFile();
          if (!f) return;
          src = await sourceFromFile(app, ctx, f);
        } else {
          const d = findOpen(app, st, name);
          if (!d) {
            ctx.print(`"${name.trim()}" 도면이 열려 있지 않습니다. 열린 도면 이름을 입력하거나 Enter로 파일을 고르십시오.`, 'err');
            return;
          }
          src = sourceFromDoc(d);
        }
        if (src) await startCompare(app, ctx, st, src);
        return;
      }
      let opt = arg?.trim().toUpperCase();
      if (!opt) {
        const kws: Keyword[] = [
          { key: 'N', label: '다음' },
          { key: 'P', label: '이전' },
          { key: 'S', label: '설정' },
          { key: 'I', label: '가져오기' },
          { key: 'E', label: '내보내기' },
          { key: 'F', label: '정보' },
          { key: 'C', label: '닫기' },
        ];
        const r = await ctx.getPoint('옵션 입력 [다음(N)/이전(P)/설정(S)/가져오기(I)/내보내기(E)/정보(F)/닫기(C)] <다음>:', { keywords: kws });
        if ('enter' in r) opt = 'N';
        else if ('keyword' in r) opt = r.keyword;
        else return;
      }
      switch (opt) {
        case 'N':
          return step(app, ctx, s, 1);
        case 'P':
          return step(app, ctx, s, -1);
        case 'S':
          return settingsPrompt(ctx);
        case 'I':
          return compareImport(app, ctx);
        case 'E':
          return compareExport(app, ctx);
        case 'F':
          return compareInfo(app, ctx);
        case 'C':
          endCompare();
          ctx.print('도면 비교를 닫았습니다.');
          return;
        default:
          ctx.print('옵션이 올바르지 않습니다.', 'err');
      }
    },
  });

  app.register({ name: 'COMPAREINFO', title: '도면 비교 정보', run: (ctx) => compareInfo(app, ctx) });
  app.register({ name: 'COMPAREIMPORT', title: '비교 도면의 객체 가져오기', run: (ctx) => compareImport(app, ctx) });
  app.register({ name: 'COMPAREEXPORT', title: '도면 비교 스냅샷 내보내기', run: (ctx) => compareExport(app, ctx) });
  app.register({
    name: 'COMPARECLOSE',
    title: '도면 비교 닫기',
    noDoc: true,
    run(ctx) {
      if (endCompare()) ctx.print('도면 비교를 닫았습니다.');
      else ctx.print('비교 중인 도면이 없습니다.');
    },
  });
}
