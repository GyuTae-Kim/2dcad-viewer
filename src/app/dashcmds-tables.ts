/**
 * 명령행 표·설정 명령: -PURGE, -STYLE, -LINETYPE, -DIMSTYLE, -UNITS.
 * 프롬프트 순서는 AutoCAD 2026 한국어판을 따른다(스크립트가 그대로 쓴다). 대화상자판과 같은 데이터·함수를 쓴다
 * (소거 대상은 PURGE의 purgeable, 선종류 정의는 LINETYPE의 표준 목록, 치수 다시 만들기는 dimensionBlockOps).
 */
import { DIM_VAR_DEFAULTS } from '../core/dimvars';
import type { DimStyle, DimensionEntity, Entity, HeaderValue, TextStyle } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { cloneEntity } from '../edit/session';
import { STANDARD_LINETYPES, makeLinetype } from '../edit/linetypes';
import { matchNameList } from '../edit/layercmd';
import { annotativeFlag, textStyleAnnotative, withAnnotativeFlag } from '../edit/annoscale/xdata';
import { columns, degText } from '../edit/script/dash';
import type { App, CommandContext, Keyword } from './app';
import { askAngleDeg, askInteger, askOption, askReal, askWord, askYN, fmt4 } from './dashcmds-ask';
import { dimensionBlockOps } from './dimcmds';
import { purgeable } from './editcmds';
import { fileNameMode } from './script';
import { lwCount, lwPoint, lwPoints } from '../core/lwpoly';

function headerOps(doc: { header: Map<string, HeaderValue> }, values: Record<string, HeaderValue>): EditOp[] {
  const ops: EditOp[] = [];
  for (const [name, after] of Object.entries(values)) {
    const before = doc.header.get(name);
    if (before !== after) ops.push({ kind: 'header', name, before, after });
  }
  return ops;
}

const BAD_NAME = /[<>/\\":;?*|,=`]/;

// ---------------------------------------------------------------------------
// -PURGE
// ---------------------------------------------------------------------------

const PURGE_KW: Keyword[] = [
  { key: 'B', label: '블록' },
  { key: 'D', label: '치수 스타일' },
  { key: 'G', label: '그룹' },
  { key: 'LA', label: '도면층' },
  { key: 'LT', label: '선종류' },
  { key: 'MA', label: '재료' },
  { key: 'MU', label: '다중 지시선 스타일' },
  { key: 'P', label: '플롯 스타일' },
  { key: 'SH', label: '형태' },
  { key: 'ST', label: '문자 스타일' },
  { key: 'M', label: '다중선 스타일' },
  { key: 'T', label: '테이블 스타일' },
  { key: 'V', label: '비주얼 스타일' },
  { key: 'R', label: '등록된 응용프로그램' },
  { key: 'Z', label: '0 길이 형상' },
  { key: 'E', label: '빈 문자 객체' },
  { key: 'O', label: '고립된 데이터' },
  { key: 'A', label: '모두' },
];

type PurgeKind = 'blocks' | 'dimStyles' | 'layers' | 'linetypes' | 'textStyles';
const PURGE_KINDS: { kind: PurgeKind; key: string; noun: string }[] = [
  { kind: 'blocks', key: 'B', noun: '블록' },
  { kind: 'dimStyles', key: 'D', noun: '치수 스타일' },
  { kind: 'layers', key: 'LA', noun: '도면층' },
  { kind: 'linetypes', key: 'LT', noun: '선종류' },
  { kind: 'textStyles', key: 'ST', noun: '문자 스타일' },
];

/** 길이가 0인 형상인가(선·호·원·폴리선) */
export function zeroLength(e: Entity): boolean {
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-10;
  switch (e.type) {
    case 'LINE':
      return near(e.start, e.end);
    case 'CIRCLE':
      return e.radius < 1e-10;
    case 'ARC':
      return e.radius < 1e-10 || Math.abs(e.endAngle - e.startAngle) < 1e-12;
    case 'LWPOLYLINE':
      return lwCount(e) > 0 && lwPoints(e).every((v) => near(v, lwPoint(e, 0)));
    default:
      return false;
  }
}

/** 빈 문자 객체인가(공백만 있는 문자·여러 줄 문자) */
export function emptyText(e: Entity): boolean {
  if (e.type === 'TEXT') return !e.text.trim();
  if (e.type === 'MTEXT') return !e.text.replace(/\\P|\\~|\{|\}/g, '').trim();
  return false;
}

async function runDashPurge(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const k = await askOption(
    ctx,
    '소거할 사용하지 않는 객체 유형 입력 [블록(B)/치수 스타일(D)/그룹(G)/도면층(LA)/선종류(LT)/재료(MA)/다중 지시선 스타일(MU)/플롯 스타일(P)/형태(SH)/문자 스타일(ST)/다중선 스타일(M)/테이블 스타일(T)/비주얼 스타일(V)/등록된 응용프로그램(R)/0 길이 형상(Z)/빈 문자 객체(E)/고립된 데이터(O)/모두(A)]:',
    PURGE_KW,
    null,
  );
  if (!k) return;
  // 0 길이 형상·빈 문자: 이름을 묻지 않고 지운다
  if (k === 'Z' || k === 'E') {
    const test = k === 'Z' ? zeroLength : emptyText;
    const ops: EditOp[] = [];
    for (const [bk, b] of doc.blocks)
      b.entities.forEach((e, i) => {
        if (test(e) && !doc.layers.get(tableKey(e.layer))?.locked) ops.push({ kind: 'remove', block: bk, entity: e, index: i });
      });
    ops.reverse();
    if (ops.length) st.session.commit({ label: 'PURGE', ops, group: ctx.group });
    ctx.print(k === 'Z' ? `0 길이 형상 ${ops.length}개가 삭제되었습니다.` : `빈 문자 객체 ${ops.length}개가 삭제되었습니다.`);
    return;
  }
  const kinds = k === 'A' ? PURGE_KINDS : PURGE_KINDS.filter((x) => x.key === k);
  const spec = (await askWord(ctx, '소거할 이름 입력 <*>:')) ?? '*';
  const verify = await askYN(ctx, '소거할 각 이름을 확인하시겠습니까?', true);
  if (!kinds.length) {
    const label = PURGE_KW.find((x) => x.key === k)?.label ?? k;
    ctx.print(`${label} 소거는 이 웹 버전에서 지원하지 않습니다(블록·치수 스타일·도면층·선종류·문자 스타일·0 길이 형상·빈 문자 객체만).`);
    return;
  }
  const found = purgeable(app);
  const table = (kind: PurgeKind) =>
    kind === 'blocks' ? doc.blocks : kind === 'dimStyles' ? doc.dimStyles : kind === 'layers' ? doc.layers : kind === 'linetypes' ? doc.linetypes : doc.textStyles;
  const ops: EditOp[] = [];
  let total = 0;
  for (const { kind, noun } of kinds) {
    const keys = found[kind];
    const names = keys.map((key) => (table(kind).get(key) as { name: string } | undefined)?.name ?? key);
    const hit = matchNameList(names, spec).names;
    if (!hit.length) {
      if (k !== 'A') ctx.print(`참조되지 않은 ${noun}이(가) 없습니다.`);
      continue;
    }
    let n = 0;
    for (const name of hit) {
      if (verify && !(await askYN(ctx, `${noun} "${name}"을(를) 소거하시겠습니까?`, false))) continue;
      const key = tableKey(name);
      ctx.print(`${noun} "${name}"을(를) 삭제하는 중입니다.`);
      if (kind === 'blocks') {
        ops.push({ kind: 'blockDef', key, before: doc.blocks.get(key)!, after: null });
        const rec = doc.blockRecords.get(key);
        if (rec) ops.push({ kind: 'blockRecord', key, before: rec, after: null });
      } else if (kind === 'layers') ops.push({ kind: 'layer', key, before: doc.layers.get(key)!, after: null });
      else if (kind === 'linetypes') ops.push({ kind: 'linetype', key, before: doc.linetypes.get(key)!, after: null });
      else if (kind === 'textStyles') ops.push({ kind: 'textStyle', key, before: doc.textStyles.get(key)!, after: null });
      else ops.push({ kind: 'dimStyle', key, before: doc.dimStyles.get(key)!, after: null });
      n++;
    }
    if (n) ctx.print(`${noun} ${n}개가 삭제되었습니다.`);
    total += n;
  }
  if (ops.length) st.session.commit({ label: 'PURGE', ops, group: ctx.group });
  if (k === 'A' && !total) ctx.print('소거할 항목이 없습니다.');
}

// ---------------------------------------------------------------------------
// -STYLE
// ---------------------------------------------------------------------------

/** 트루타입 글꼴 이름 → 파일(STYLE 대화상자의 목록과 같다) */
const TTF_FAMILIES: Record<string, [string, string]> = {
  arial: ['arial.ttf', 'Arial'],
  'times new roman': ['times.ttf', 'Times New Roman'],
  'courier new': ['cour.ttf', 'Courier New'],
  '맑은 고딕': ['malgun.ttf', '맑은 고딕'],
  'malgun gothic': ['malgun.ttf', '맑은 고딕'],
  굴림: ['gulim.ttc', '굴림'],
  gulim: ['gulim.ttc', '굴림'],
  바탕: ['batang.ttc', '바탕'],
  batang: ['batang.ttc', '바탕'],
};

/** 글꼴 입력 → 글꼴 파일·큰 글꼴·트루타입 이름 */
export function parseFontSpec(text: string): { font: string; bigFont: string; family?: string } {
  const [f0, b0] = text.split(',').map((x) => x.trim());
  const f = f0 ?? '';
  const fam = TTF_FAMILIES[f.toLowerCase()];
  if (fam) return { font: fam[0], bigFont: '', family: fam[1] };
  if (/\.(ttf|ttc|otf)$/i.test(f)) {
    const known = Object.values(TTF_FAMILIES).find(([file]) => file.toLowerCase() === f.toLowerCase());
    return { font: f, bigFont: '', family: known?.[1] ?? f.replace(/\.(ttf|ttc|otf)$/i, '') };
  }
  return { font: f, bigFont: b0 ?? '' };
}

function styleFontText(s: TextStyle): string {
  if (s.fontFamily) return s.fontFamily;
  return s.bigFont ? `${s.font},${s.bigFont}` : s.font || 'txt';
}

function listStyles(ctx: CommandContext, pattern: string): void {
  const doc = ctx.app.active!.doc;
  const list = [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1));
  const names = matchNameList(
    list.map((s) => s.name),
    pattern,
  ).names;
  for (const n of names) {
    const s = doc.textStyles.get(tableKey(n))!;
    ctx.print(`스타일 이름: "${s.name}"  글꼴 파일: ${styleFontText(s)}`);
    const gen = [s.generation & 2 ? '반대로' : '', s.generation & 4 ? '거꾸로' : '', s.flags & 4 ? '수직' : ''].filter(Boolean).join(', ') || '보통';
    ctx.print(`   높이: ${fmt4(s.height)}  폭 비율: ${fmt4(s.widthFactor)}  기울기 각도: ${degText(s.oblique)}  생성: ${gen}`);
  }
  ctx.print(`현재 문자 스타일: ${String(doc.header.get('$TEXTSTYLE') ?? 'Standard')}`);
}

async function runDashStyle(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const cur = String(doc.header.get('$TEXTSTYLE') ?? 'Standard');
  let name: string;
  for (;;) {
    const t = await askWord(ctx, `문자 스타일 이름 입력 또는 [?] <${cur}>:`);
    if (t === '?') {
      listStyles(ctx, (await askWord(ctx, '나열할 문자 스타일 입력 <*>:')) ?? '*');
      continue;
    }
    name = t ?? cur;
    if (!name || BAD_NAME.test(name)) {
      ctx.print('문자 스타일 이름이 올바르지 않습니다.', 'err');
      continue;
    }
    break;
  }
  const key = tableKey(name);
  const before = doc.textStyles.get(key) ?? null;
  ctx.print(before ? '기존 스타일.' : '새 스타일.');
  const s: TextStyle = before ? structuredClone(before) : ({ name, handle: st.session.newHandle(), flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5, font: 'txt', bigFont: '' } as TextStyle);
  // 글꼴 이름의 공백은 Enter다(스크립트와 같다). 공백이 든 이름은 "…"로 감싼다
  const fontText = (await askWord(ctx, `전체 글꼴 이름 또는 글꼴 파일 이름(TTF 또는 SHX) 지정 <${styleFontText(s)}>:`)) ?? '';
  if (fontText.trim()) {
    const f = parseFontSpec(fontText.trim());
    s.font = f.font;
    s.bigFont = f.bigFont;
    s.fontFamily = f.family;
    if (!f.family) delete s.fontFamily;
  }
  const ttf = /\.(ttf|ttc|otf)$/i.test(s.font);
  // 높이(주석이면 용지 문자 높이)
  let annotative = textStyleAnnotative(doc, s.name);
  for (;;) {
    const r = await ctx.getPoint(`${annotative ? '용지 문자 높이 지정' : '문자 높이 지정'} 또는 [주석(A)] <${fmt4(s.height)}>:`, {
      keywords: [{ key: 'A', label: '주석' }],
      preferNumber: true,
      allowText: true,
    });
    if ('enter' in r) break;
    if ('keyword' in r) {
      annotative = await askYN(ctx, '주석 문자 스타일을 작성하시겠습니까?', true);
      continue;
    }
    const v = 'text' in r ? Number(r.text) : NaN;
    if (Number.isFinite(v) && v >= 0) {
      s.height = v;
      break;
    }
    ctx.print('0 이상의 높이가 필요합니다.', 'err');
  }
  s.widthFactor = await askReal(ctx, `폭 비율 지정 <${fmt4(s.widthFactor)}>:`, s.widthFactor, (v) => (v > 0 ? null : '값은 0보다 커야 합니다.'));
  s.oblique = (Math.PI / 180) * (await askReal(ctx, `기울기 각도 지정 <${degText(s.oblique)}>:`, +degText(s.oblique), (v) => (Math.abs(v) <= 85 ? null : '-85에서 85 사이의 각도가 필요합니다.')));
  const back = await askYN(ctx, '문자를 반대로 표시하시겠습니까?', !!(s.generation & 2));
  const upside = await askYN(ctx, '문자를 거꾸로 표시하시겠습니까?', !!(s.generation & 4));
  s.generation = (s.generation & ~6) | (back ? 2 : 0) | (upside ? 4 : 0);
  if (!ttf) {
    const vert = await askYN(ctx, '수직?', !!(s.flags & 4));
    s.flags = (s.flags & ~4) | (vert ? 4 : 0);
  }
  if (annotative || annotativeFlag(s.xdata) !== undefined) s.xdata = withAnnotativeFlag(s.xdata, annotative);
  const ops: EditOp[] = [{ kind: 'textStyle', key, before, after: s }, ...headerOps(doc, { $TEXTSTYLE: s.name })];
  st.session.commit({ label: 'STYLE', ops, group: ctx.group });
  ctx.print(`"${s.name}"은(는) 이제 현재 문자 스타일입니다.`);
}

// ---------------------------------------------------------------------------
// -LINETYPE
// ---------------------------------------------------------------------------

async function runDashLinetype(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  ctx.print(`현재 선종류: "${String(doc.header.get('$CELTYPE') ?? 'ByLayer')}"`);
  for (;;) {
    const k = await askOption(
      ctx,
      '옵션 입력 [?/작성(C)/로드(L)/설정(S)]:',
      [
        { key: '?', label: '?' },
        { key: 'C', label: '작성' },
        { key: 'L', label: '로드' },
        { key: 'S', label: '설정' },
      ],
      null,
    );
    if (!k) return;
    if (k === '?') {
      ctx.print('표준 선종류(acad.lin·acadiso.lin에 해당하는 이 앱의 정의):');
      for (const d of STANDARD_LINETYPES) ctx.print(`  ${d.name.padEnd(18)}${doc.linetypes.has(tableKey(d.name)) ? '(로드됨) ' : ''}${d.description}`);
      continue;
    }
    if (k === 'C') {
      ctx.print('선종류 작성(C)은 이 웹 버전에서 할 수 없습니다(선종류 파일을 쓸 수 없음). 표준 선종류를 로드(L)하거나, 그린 형상으로 만들려면 MKLTYPE을 쓰십시오.', 'err');
      continue;
    }
    if (k === 'L') {
      const spec = await askWord(ctx, '로드할 선종류 입력:');
      if (!spec) continue;
      if (fileNameMode(app)) {
        // 스크립트·FILEDIA 0: 선종류 파일 이름을 묻는다(이 앱은 내장 정의만 쓴다)
        const metricDef = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1 ? 'acadiso.lin' : 'acad.lin';
        const file = await askWord(ctx, `선종류 파일 지정 <${metricDef}>:`);
        if (file && !/^acad(iso)?(\.lin)?$/i.test(file.replace(/^.*[\\/]/, ''))) ctx.print(`"${file}"은(는) 읽을 수 없습니다. 이 앱의 표준 선종류 정의에서 로드합니다.`);
      }
      const metric = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
      const m = matchNameList(
        STANDARD_LINETYPES.map((d) => d.name),
        spec,
      );
      for (const u of m.unmatched) ctx.print(`선종류 "${u}"을(를) 찾을 수 없습니다.`);
      const ops: EditOp[] = [];
      for (const name of m.names) {
        const key = tableKey(name);
        const before = doc.linetypes.get(key) ?? null;
        if (before && !(await askYN(ctx, `선종류 "${before.name}"이(가) 이미 로드되었습니다. 다시 로드하시겠습니까?`, true))) continue;
        const def = STANDARD_LINETYPES.find((d) => d.name === name)!;
        const after = makeLinetype(def, before?.handle ?? st.session.newHandle(), metric);
        ops.push({ kind: 'linetype', key, before, after });
        ctx.print(`선종류 "${name}"이(가) ${before ? '다시 로드되었습니다' : '로드되었습니다'}.`);
      }
      if (ops.length) st.session.commit({ label: 'LINETYPE', ops, group: ctx.group });
      continue;
    }
    // 설정
    for (;;) {
      const cur = String(doc.header.get('$CELTYPE') ?? 'ByLayer');
      const t = await askWord(ctx, `선종류 이름 지정 또는 [?] <${cur}>:`);
      if (t === null) break;
      if (t === '?') {
        const names = [...doc.linetypes.values()].map((l) => l.name);
        for (const l of columns(names, 4)) ctx.print(l);
        continue;
      }
      const up = t.toUpperCase();
      const value: string | null = up === 'BYLAYER' ? 'ByLayer' : up === 'BYBLOCK' ? 'ByBlock' : (doc.linetypes.get(up)?.name ?? null);
      if (!value) {
        ctx.print(`선종류 "${t}"을(를) 찾을 수 없습니다. 로드(L) 옵션으로 먼저 로드하십시오.`, 'err');
        continue;
      }
      const ops = headerOps(doc, { $CELTYPE: value });
      if (ops.length) st.session.commit({ label: 'LINETYPE', ops, group: ctx.group });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// -DIMSTYLE
// ---------------------------------------------------------------------------

const dimVal = (s: DimStyle, v: string): number | string => s.vars[v] ?? DIM_VAR_DEFAULTS[v] ?? 0;
const showVal = (v: number | string): string => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : fmt4(v)) : `"${v}"`);

/** 그 스타일을 쓰는 치수(또는 고른 치수)를 다시 만드는 작업 */
function regenDims(app: App, dims: { block: string; e: DimensionEntity }[], style: string): EditOp[] {
  const st = app.active!;
  const ops: EditOp[] = [];
  const extra = new Set<string>();
  for (const { block, e } of dims) {
    const copy = cloneEntity(e);
    copy.dimStyle = style;
    try {
      ops.push(...dimensionBlockOps(st, copy, true, extra), { kind: 'modify', block, before: e, after: copy as Entity });
    } catch {
      /* 생성기가 못 다루는 치수는 그대로 */
    }
  }
  return ops;
}

function dimsUsing(app: App, style: string): { block: string; e: DimensionEntity }[] {
  const out: { block: string; e: DimensionEntity }[] = [];
  const key = tableKey(style);
  for (const [bk, b] of app.active!.doc.blocks) {
    if (/^\*D\d+$/i.test(b.name)) continue;
    for (const e of b.entities) if (e.type === 'DIMENSION' && tableKey(e.dimStyle || 'Standard') === key) out.push({ block: bk, e });
  }
  return out;
}

async function runDashDimstyle(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const curName = () => String(doc.header.get('$DIMSTYLE') ?? 'Standard') || 'Standard';
  const cur = () => doc.dimStyles.get(tableKey(curName()));
  ctx.print(`현재 치수 스타일: ${curName()}  주석: ${annotativeFlag(cur()?.xdata) ? '예' : '아니오'}`);
  const k = await askOption(
    ctx,
    '치수 스타일 옵션 입력 [주석(AN)/저장(S)/복원(R)/상태(ST)/변수(V)/적용(A)/?] <복원>:',
    [
      { key: 'AN', label: '주석' },
      { key: 'S', label: '저장' },
      { key: 'R', label: '복원' },
      { key: 'ST', label: '상태' },
      { key: 'V', label: '변수' },
      { key: 'A', label: '적용' },
      { key: '?', label: '?' },
    ],
    'R',
  );
  const list = (pattern: string) => {
    const names = matchNameList(
      [...doc.dimStyles.values()].filter((s) => s.name).map((s) => s.name),
      pattern,
    ).names;
    ctx.print('명명된 치수 스타일:');
    for (const n of names) ctx.print(`  ${n}${annotativeFlag(doc.dimStyles.get(tableKey(n))?.xdata) ? ' (주석)' : ''}`);
  };
  const printVars = (s: DimStyle, against?: DimStyle) => {
    for (const v of Object.keys(DIM_VAR_DEFAULTS).sort()) {
      const a = dimVal(s, v);
      if (against) {
        const b = dimVal(against, v);
        if (a !== b) ctx.print(`${v.padEnd(10)} ${showVal(b).padEnd(14)} ${showVal(a)}`);
      } else ctx.print(`${v.padEnd(10)} ${showVal(a)}`);
    }
  };
  /** 이름 또는 <치수 선택>으로 스타일 고르기. ~이름이면 비교 */
  const pickStyle = async (): Promise<{ style: DimStyle; compare: boolean } | null> => {
    for (;;) {
      const t = await askWord(ctx, '치수 스타일 이름 입력, [?] 또는 <치수 선택>:');
      if (t === '?') {
        list((await askWord(ctx, '나열할 치수 스타일 입력 <*>:')) ?? '*');
        continue;
      }
      if (t === null) {
        const r = await ctx.getEntity('치수 선택:');
        if (!('handle' in r)) return null;
        const e = doc.entityIndex.get(r.handle);
        if (e?.type !== 'DIMENSION') {
          ctx.print('치수가 아닙니다.', 'err');
          continue;
        }
        const s = doc.dimStyles.get(tableKey(e.dimStyle || 'Standard'));
        if (s) return { style: s, compare: false };
        ctx.print(`치수 스타일 "${e.dimStyle}"을(를) 찾을 수 없습니다.`, 'err');
        continue;
      }
      const compare = t.startsWith('~');
      const s = doc.dimStyles.get(tableKey(compare ? t.slice(1) : t));
      if (s) return { style: s, compare };
      ctx.print(`치수 스타일 "${t}"을(를) 찾을 수 없습니다.`, 'err');
    }
  };
  switch (k) {
    case '?':
      list((await askWord(ctx, '나열할 치수 스타일 입력 <*>:')) ?? '*');
      return;
    case 'ST': {
      const s = cur();
      ctx.print(`치수 스타일: ${curName()}`);
      if (s) printVars(s);
      return;
    }
    case 'V': {
      const p = await pickStyle();
      if (!p) return;
      const base = cur();
      if (p.compare && base) {
        ctx.print(`"${p.style.name}"과(와) 현재 설정의 차이:`);
        ctx.print(`${'변수'.padEnd(10)} ${p.style.name.padEnd(14)} 현재 설정`);
        printVars(base, p.style);
      } else {
        ctx.print(`치수 스타일: ${p.style.name}`);
        printVars(p.style);
      }
      return;
    }
    case 'R': {
      const p = await pickStyle();
      if (!p) return;
      if (p.compare) {
        const base = cur();
        if (base) {
          ctx.print(`"${p.style.name}"과(와) 현재 설정의 차이:`);
          printVars(base, p.style);
        }
        return;
      }
      const ops = headerOps(doc, { $DIMSTYLE: p.style.name });
      if (ops.length) st.session.commit({ label: 'DIMSTYLE', ops, group: ctx.group });
      ctx.print(`현재 치수 스타일: ${p.style.name}`);
      return;
    }
    case 'A': {
      const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
      app.clearSelection();
      const dims: { block: string; e: DimensionEntity }[] = [];
      for (const h of hs) {
        const e = doc.entityIndex.get(h);
        const block = st.session.ownerOf(h);
        if (e?.type === 'DIMENSION' && block && !doc.layers.get(tableKey(e.layer))?.locked) dims.push({ block, e });
      }
      if (!dims.length) {
        ctx.print('치수를 고르지 않았습니다.');
        return;
      }
      const ops = regenDims(app, dims, curName());
      if (ops.length) st.session.commit({ label: 'DIMSTYLE', ops, group: ctx.group, rebuildNow: true });
      ctx.print(`치수 ${dims.length}개에 현재 치수 스타일을 적용했습니다.`);
      return;
    }
    case 'AN':
    case 'S': {
      let anno = annotativeFlag(cur()?.xdata) ?? false;
      if (k === 'AN') anno = await askYN(ctx, '주석 치수 스타일을 작성하시겠습니까?', true);
      const base = cur();
      if (!base) {
        ctx.print(`현재 치수 스타일 "${curName()}"을(를) 찾을 수 없습니다.`, 'err');
        return;
      }
      for (;;) {
        const t = await askWord(ctx, '새 치수 스타일의 이름 입력 또는 [?]:');
        if (t === null) return;
        if (t === '?') {
          list((await askWord(ctx, '나열할 치수 스타일 입력 <*>:')) ?? '*');
          continue;
        }
        if (BAD_NAME.test(t)) {
          ctx.print('치수 스타일 이름이 올바르지 않습니다.', 'err');
          continue;
        }
        const key = tableKey(t);
        const before = doc.dimStyles.get(key) ?? null;
        if (before && key !== tableKey(base.name) && !(await askYN(ctx, `기존 스타일 "${before.name}"을(를) 재정의하시겠습니까?`, false))) return;
        const after: DimStyle = before ? { ...structuredClone(before), vars: { ...base.vars } } : { ...structuredClone(base), name: t, handle: st.session.newHandle(), flags: 0 };
        if (!before) delete (after as { xdata?: unknown }).xdata;
        if (anno || annotativeFlag(after.xdata) !== undefined) after.xdata = withAnnotativeFlag(after.xdata, anno);
        const ops: EditOp[] = [{ kind: 'dimStyle', key, before, after }, ...headerOps(doc, { $DIMSTYLE: after.name })];
        st.session.commit({ label: 'DIMSTYLE', ops, group: ctx.group });
        if (before) {
          const regen = regenDims(app, dimsUsing(app, after.name), after.name);
          if (regen.length) st.session.commit({ label: 'DIMSTYLE', ops: regen, group: ctx.group, rebuildNow: true });
        }
        ctx.print(`치수 스타일 "${after.name}"을(를) ${before ? '재정의했습니다' : '저장했습니다'}. 현재 치수 스타일입니다.`);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// -UNITS
// ---------------------------------------------------------------------------

async function runDashUnits(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const u = st.units;
  for (const l of ['보고서 형식:          (예)', '  1. 과학            1.55E+01', '  2. 십진            15.50', `  3. 공학            1'-3.50"`, `  4. 건축            1'-3 1/2"`, '  5. 분수            15 1/2', '']) ctx.print(l);
  const lunits = await askInteger(ctx, `선택 항목 입력, 1 ~ 5 <${u.lunits || 2}>:`, u.lunits || 2, 1, 5);
  let luprec: number;
  if (lunits >= 4) {
    const den = await askInteger(ctx, `나타낼 가장 작은 분수의 분모 입력 (1, 2, 4, 8, 16, 32, 64, 128 또는 256) <${2 ** u.luprec}>:`, 2 ** u.luprec, 1, 256);
    if (!Number.isInteger(Math.log2(den))) {
      ctx.print('분모는 2의 거듭제곱(1~256)이어야 합니다.', 'err');
      return;
    }
    luprec = Math.log2(den);
  } else luprec = await askInteger(ctx, `소수점 이하 자릿수 입력 (0 ~ 8) <${u.luprec}>:`, u.luprec, 0, 8);
  for (const l of ['', '각도 측정 체계:        (예)', '  1. 십진 도수           45.0000', `  2. 도/분/초            45d0'0"`, '  3. 그라디안            50.0000g', '  4. 라디안              0.7854r', `  5. 측량 단위           N 45d0'0" E`, '']) ctx.print(l);
  const aunits = (await askInteger(ctx, `선택 항목 입력, 1 ~ 5 <${u.aunits + 1}>:`, u.aunits + 1, 1, 5)) - 1;
  const auprec = await askInteger(ctx, `각도 표시를 위한 소수점 이하 자릿수 입력 (0 ~ 8) <${u.auprec}>:`, u.auprec, 0, 8);
  for (const l of ['', '방향 제어:', '  동       3 시 = 0', '  북      12 시 = 90', '  서       9 시 = 180', '  남       6 시 = 270', '']) ctx.print(l);
  const angbase = await askAngleDeg(ctx, `각도 0의 방향 입력 <${degText(u.angbase)}>:`, null, u.angbase);
  const angdir = await askYN(ctx, '각도를 시계 방향으로 측정하시겠습니까?', u.angdir === 1);
  const ops = headerOps(doc, { $LUNITS: lunits, $LUPREC: luprec, $AUNITS: aunits, $AUPREC: auprec, $ANGBASE: angbase, $ANGDIR: angdir ? 1 : 0 });
  if (ops.length) st.session.commit({ label: 'UNITS', ops, group: ctx.group });
}

export function registerDashTableCommands(app: App): void {
  app.register({ name: '-PURGE', aliases: ['-PU'], title: '소거(명령행)', run: (ctx) => runDashPurge(app, ctx) });
  app.register({ name: '-STYLE', aliases: ['-ST'], title: '문자 스타일(명령행)', run: (ctx) => runDashStyle(app, ctx) });
  app.register({ name: '-LINETYPE', aliases: ['-LT', '-LTYPE'], title: '선종류(명령행)', run: (ctx) => runDashLinetype(app, ctx) });
  app.register({ name: '-DIMSTYLE', title: '치수 스타일(명령행)', run: (ctx) => runDashDimstyle(app, ctx) });
  app.register({ name: '-UNITS', aliases: ['-UN'], title: '도면 단위(명령행)', run: (ctx) => runDashUnits(app, ctx) });
}
