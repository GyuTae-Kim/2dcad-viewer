/**
 * Express Tools 문자 명령: TCASE·-TCASE(대소문자), TCOUNT(일련번호), TORIENT(방향), TEXTFIT(맞추기),
 * TEXTMASK·TEXTUNMASK(가리기), TCIRCLE(둘레 원·슬롯·사각형), TXTEXP(문자 분해).
 * 계산은 src/edit/express/*.ts. 각 명령은 한 번의 명령 취소로 되돌린다.
 */
import type { CadColor, Entity, TextEntity } from '../core/model';
import { tableKey } from '../core/model';
import { collectCodePoints } from '../text/mtext';
import { latinFamilyOf } from '../text/fonts';
import type { EditOp } from '../edit/session';
import { createGroupOps, deleteGroupOps } from '../edit/util/groups';
import { parseColor } from '../edit/util/select';
import type { TextLike } from '../edit/geom/textjust';
import { CASE_LABEL, type CaseMode, caseEntity, isCaseTarget } from '../edit/express/tcase';
import { type CountPlace, type CountSort, PLACE_LABEL, SORT_LABEL, isCountTarget, parseStartIncrement, planCount } from '../edit/express/tcount';
import { isOrientTarget, orientEntity } from '../edit/express/torient';
import { type FitMeasure, fitBaseline, fitText } from '../edit/express/textfit';
import { MASK_LABEL, type MaskType, isMaskTarget, makeMask, readMaskLink, withMaskLink } from '../edit/express/textmask';
import { type EncloseShape, SHAPE_LABEL, circleRadius, encloseText, isEncloseTarget, largestBox } from '../edit/express/tcircle';
import { explodeTextGeometry, isExplodableText } from '../edit/express/txtexp';
import type { App, Command, CommandContext, Keyword } from './app';
import { currentProps } from './draw';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import { askNumber, choose, previewOf } from './modify2-util';
import { form } from './ui/dom';
import { askAngle, askString, degText, numText } from './express-util';
import type { Pt } from './view';

/** 고른 것 중 조건에 맞고 잠기지 않은 객체 */
function pickTargets(app: App, hs: string[], ok: (e: Entity) => boolean): Entity[] {
  const doc = app.active!.doc;
  return unlockedOnly(app, hs)
    .map((h) => doc.entityIndex.get(h))
    .filter((e): e is Entity => !!e && ok(e));
}

function commitReplace(app: App, ctx: CommandContext, list: Entity[], label: string): number {
  if (!list.length) return 0;
  const a = commitResults(app, ctx, [{ replace: list }], label, { quiet: true });
  return a.changed.length;
}

// ---------------------------------------------------------------------------
// TCASE
// ---------------------------------------------------------------------------

let caseMode: CaseMode = 'upper';
const CASE_KEYS: [string, CaseMode][] = [
  ['S', 'sentence'],
  ['L', 'lower'],
  ['U', 'upper'],
  ['T', 'title'],
  ['G', 'toggle'],
];

async function runTcase(app: App, ctx: CommandContext, dialogMode: boolean): Promise<void> {
  const hs = await ctx.getSelection('문자 기반 객체 선택:');
  const list = pickTargets(app, hs, isCaseTarget);
  if (!list.length) {
    ctx.print('문자·여러 줄 문자·속성·치수·다중 지시선을 고르지 않았습니다.', 'err');
    return;
  }
  if (dialogMode) {
    const v = await form('TCASE', [
      {
        key: 'mode',
        label: '대/소문자 선택',
        type: 'select',
        value: caseMode,
        options: [
          { value: 'sentence', label: '문장 대소문자. (첫 글자만 대문자)' },
          { value: 'lower', label: '소문자' },
          { value: 'upper', label: '대문자' },
          { value: 'title', label: '제목 (단어 첫 글자 대문자)' },
          { value: 'toggle', label: '대소문자 전환' },
        ],
      },
    ], { note: '서식(글꼴·색·높이·스택·필드)은 그대로 두고 글자만 바꿉니다. 블록 참조를 고르면 그 속성을 바꿉니다.' });
    if (!v) return;
    caseMode = v.mode as CaseMode;
  } else {
    const kws: Keyword[] = CASE_KEYS.map(([k, m]) => ({ key: k, label: CASE_LABEL[m] }));
    const r = await ctx.getPoint(`대소문자 선택 [문장(S)/소문자(L)/대문자(U)/제목(T)/대소문자 전환(G)] <${CASE_LABEL[caseMode]}>:`, { keywords: kws });
    if ('keyword' in r) caseMode = CASE_KEYS.find(([k]) => k === r.keyword)![1];
  }
  const changed = list.map((e) => caseEntity(e, caseMode)).filter((e): e is Entity => !!e);
  const n = commitReplace(app, ctx, changed, 'TCASE');
  app.clearSelection();
  ctx.print(n ? `객체 ${n}개를 ${CASE_LABEL[caseMode]}(으)로 바꿨습니다.` : '바뀐 문자가 없습니다.');
}

// ---------------------------------------------------------------------------
// TCOUNT
// ---------------------------------------------------------------------------

let countSort: CountSort = 'S';
let countStart = '1,1';
let countPlace: CountPlace = 'P';
let countFind = '';

async function runTcount(app: App, ctx: CommandContext): Promise<void> {
  const hs = await ctx.getSelection('객체 선택:');
  const list = pickTargets(app, hs, isCountTarget);
  if (!list.length) {
    ctx.print('문자나 여러 줄 문자를 고르지 않았습니다.', 'err');
    return;
  }
  // 고른 순서를 지킨다
  const order = new Map(hs.map((h, i) => [h, i] as const));
  list.sort((a, b) => (order.get(a.handle) ?? 0) - (order.get(b.handle) ?? 0));
  const s = await ctx.getPoint(`선택한 객체 정렬 기준 [X/Y/선택 순서(S)] <${SORT_LABEL[countSort]}>:`, {
    keywords: [
      { key: 'X', label: 'X' },
      { key: 'Y', label: 'Y' },
      { key: 'S', label: '선택 순서' },
    ],
  });
  if ('keyword' in s) countSort = s.keyword as CountSort;
  let si: { start: number; inc: number; decimals: number } | null = null;
  for (;;) {
    const r = await askString(ctx, `시작 번호 및 증분 지정 (시작,증분) <${countStart}>:`, countStart);
    if (typeof r !== 'string') continue;
    si = parseStartIncrement(r);
    if (si) {
      countStart = r.trim();
      break;
    }
    ctx.print('시작 번호와 증분을 "1,1"처럼 입력하십시오.', 'err');
  }
  const p = await ctx.getPoint(`문자에 번호 배치 [덮어쓰기(O)/접두어(P)/접미어(S)/찾아서 바꾸기(F)] <${PLACE_LABEL[countPlace]}>:`, {
    keywords: [
      { key: 'O', label: '덮어쓰기' },
      { key: 'P', label: '접두어' },
      { key: 'S', label: '접미어' },
      { key: 'F', label: '찾아서 바꾸기' },
    ],
  });
  if ('keyword' in p) countPlace = p.keyword as CountPlace;
  if (countPlace === 'F') {
    for (;;) {
      const f = await askString(ctx, countFind ? `찾을 문자열 입력 <${countFind}>:` : '찾을 문자열 입력:', countFind);
      if (typeof f === 'string' && f) {
        countFind = f;
        break;
      }
      ctx.print('찾을 문자열을 입력하십시오.', 'err');
    }
  }
  const plan = planCount(list, app.active!.doc, { sort: countSort, start: si.start, inc: si.inc, decimals: si.decimals, place: countPlace, find: countFind });
  const n = commitReplace(app, ctx, plan.map((x) => x.after), 'TCOUNT');
  app.clearSelection();
  if (!plan.length) ctx.print(countPlace === 'F' ? `"${countFind}"을(를) 담은 문자가 없습니다.` : '바뀐 문자가 없습니다.');
  else ctx.print(`문자 ${n}개에 번호 ${plan[0]!.number}~${plan[plan.length - 1]!.number}을(를) 넣었습니다.`);
}

// ---------------------------------------------------------------------------
// TORIENT
// ---------------------------------------------------------------------------

async function runTorient(app: App, ctx: CommandContext): Promise<void> {
  const hs = await ctx.getSelection('문자, 여러 줄 문자, 속성 정의 또는 블록(속성) 선택:');
  const list = pickTargets(app, hs, isOrientTarget);
  if (!list.length) {
    ctx.print('문자나 속성이 있는 블록을 고르지 않았습니다.', 'err');
    return;
  }
  const a = await askAngle(ctx, '새 절대 회전 각도 <가장 읽기 쉬운 방향>:');
  const target: number | 'readable' = typeof a === 'number' ? a : 'readable';
  const doc = app.active!.doc;
  const changed = list.map((e) => orientEntity(e, target, doc)).filter((e): e is Entity => !!e);
  const n = commitReplace(app, ctx, changed, 'TORIENT');
  app.clearSelection();
  ctx.print(n ? `객체 ${n}개의 방향을 ${target === 'readable' ? '가장 읽기 쉽게' : `${degText(target)}°로`} 바꿨습니다.` : '바뀐 객체가 없습니다(이미 그 방향입니다).');
}

// ---------------------------------------------------------------------------
// TEXTFIT
// ---------------------------------------------------------------------------

/** 화면 글꼴로 잰 글자 폭·하강(문자 높이 단위) */
function fitMeasure(app: App, e: TextLike): FitMeasure {
  const doc = app.active!.doc;
  const style = doc.textStyles.get(tableKey(e.style));
  try {
    const lay = app.text.layoutText({ text: e.text, insert: { x: 0, y: 0 }, height: 1, rotation: 0, widthFactor: 1, oblique: 0, generation: 0, halign: 0, valign: 0, style });
    const w = Number.isFinite(lay.maxX) ? Math.max(0, lay.maxX) : undefined;
    return { unitWidth: w, descent: app.text.descentOf(app.text.styleFont(style)) };
  } catch {
    return {};
  }
}

async function runTextfit(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  let e: TextEntity | null = null;
  for (;;) {
    const r = await ctx.getEntity('늘이거나 줄일 문자 선택:');
    if (!('handle' in r)) return;
    const x = doc.entityIndex.get(r.handle);
    if (!x || (x.type !== 'TEXT' && x.type !== 'ATTDEF')) {
      ctx.print('한 줄 문자(TEXT)나 속성 정의를 고르십시오.', 'err');
      continue;
    }
    if (!unlockedOnly(app, [x.handle]).length) continue;
    e = x as TextEntity;
    break;
  }
  app.setSelection([e.handle], 'replace');
  const m = fitMeasure(app, e);
  const base = fitBaseline(e, doc, m);
  let start: Pt | undefined;
  const preview = (p: Pt) => {
    const r = fitText(e!, p, doc, { ...m, start });
    return typeof r === 'string' ? [] : previewOf(app, [r]);
  };
  for (;;) {
    const r = await ctx.getPoint(start ? '끝점 지정:' : '끝점 지정 또는 [시작점(S)]:', {
      base: start ?? base.start,
      keywords: start ? [] : [{ key: 'S', label: '시작점' }],
      ghost: preview,
    });
    if ('keyword' in r) {
      const s = await ctx.getPoint('새 시작점 지정:', { base: base.start });
      if (!('point' in s)) return;
      start = s.point;
      continue;
    }
    if (!('point' in r)) {
      app.clearSelection();
      return;
    }
    const out = fitText(e, r.point, doc, { ...m, start });
    if (typeof out === 'string') {
      ctx.print(out, 'err');
      continue;
    }
    commitReplace(app, ctx, [out], 'TEXTFIT');
    ctx.print(`폭 비율 = ${numText(out.widthFactor)}`);
    app.clearSelection();
    return;
  }
}

// ---------------------------------------------------------------------------
// TEXTMASK · TEXTUNMASK
// ---------------------------------------------------------------------------

let maskType: MaskType = 'wipeout';
let maskOffset = 0.35;
let maskColor: CadColor = { aci: 8 };

/** 가리개·그룹·짝 기록을 지우는 작업 */
function unmaskOps(app: App, e: Entity): EditOp[] {
  const st = app.active!;
  const doc = st.doc;
  const link = readMaskLink(e);
  if (!link) return [];
  const ops: EditOp[] = [];
  const mask = doc.entityIndex.get(link.mask);
  if (mask) {
    const block = st.session.ownerOf(mask.handle);
    const list = block ? doc.blocks.get(block)?.entities : undefined;
    if (block && list) ops.push({ kind: 'remove', block, entity: mask, index: list.indexOf(mask) });
  }
  if (link.group && doc.objects.get(link.group)?.type === 'GROUP') ops.push(...deleteGroupOps(doc, link.group));
  const block = st.session.ownerOf(e.handle);
  if (block) {
    const after = { ...structuredClone(e), xdata: withMaskLink(e.xdata, null) } as Entity;
    if (!after.xdata) delete after.xdata;
    ops.push({ kind: 'modify', block, before: e, after });
  }
  return ops;
}

async function runTextmask(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  let hs: string[] = [];
  let first = true;
  for (;;) {
    ctx.print(`현재 설정: 간격띄우기 비율 = ${numText(maskOffset)}, 가리기 유형 = ${MASK_LABEL[maskType]}${maskType === 'solid' ? ` (색상 ${maskColor.aci})` : ''}`);
    try {
      hs = await ctx.getSelection('가릴 문자 객체 선택 또는 [가리기 유형(M)/간격띄우기(O)]:', {
        keywords: [
          { key: 'M', label: '가리기 유형' },
          { key: 'O', label: '간격띄우기' },
        ],
        noPickfirst: !first,
      });
      break;
    } catch (err) {
      const k = (err as { keyword?: string }).keyword;
      if (k === 'M') {
        const t = await choose(ctx, `가리기에 사용할 객체 유형 지정 [가리기(W)/3D 면(3)/솔리드(S)] <${MASK_LABEL[maskType]}>:`, [
          { key: 'W', label: '가리기' },
          { key: '3', label: '3D 면' },
          { key: 'S', label: '솔리드' },
        ], maskType === 'solid' ? 'S' : 'W');
        if (t === '3') ctx.print('3D 면 가리기는 숨기기(HIDE) 표시가 필요해 이 웹 버전에서 쓸 수 없습니다. 가리기(W)나 솔리드(S)를 쓰십시오.', 'err');
        else maskType = t === 'S' ? 'solid' : 'wipeout';
        if (maskType === 'solid') {
          for (;;) {
            const c = await askString(ctx, `배경 가리기 색상 번호 입력 <${maskColor.aci}>:`, String(maskColor.aci));
            const col = typeof c === 'string' ? parseColor(c) : null;
            if (col && col.aci > 0 && col.aci < 256) {
              maskColor = col;
              break;
            }
            ctx.print('1에서 255 사이의 색상 번호를 입력하십시오.', 'err');
          }
        }
      } else if (k === 'O') {
        const v = await askNumber(ctx, '문자 높이에 대한 간격띄우기 비율 입력', maskOffset, { min: 0, distance: false, text: (x) => numText(x) });
        if (typeof v === 'number') maskOffset = v;
      } else throw err;
      first = false;
    }
  }
  const list = pickTargets(app, hs, isMaskTarget);
  if (!list.length) {
    ctx.print('문자·여러 줄 문자·속성 정의를 고르지 않았습니다.', 'err');
    return;
  }
  let n = 0;
  let noRoot = false;
  for (const e0 of list) {
    // 이미 가린 문자는 먼저 가리개를 지운다
    const un = unmaskOps(app, e0);
    if (un.length) st.session.commit({ label: 'TEXTMASK', ops: un, group: ctx.group });
    const e = st.doc.entityIndex.get(e0.handle);
    if (!e) continue;
    const mask = makeMask(e, { type: maskType, offset: maskOffset, color: maskColor }, st.doc);
    const block = st.session.ownerOf(e.handle);
    const def = block ? st.doc.blocks.get(block) : undefined;
    if (!mask || !block || !def) continue;
    mask.handle = st.session.newHandle();
    if (def.recordHandle) mask.owner = def.recordHandle;
    const ops: EditOp[] = [{ kind: 'add', block, entity: mask, index: def.entities.indexOf(e) }];
    const g = createGroupOps(st.doc, null, 'TEXTMASK', [e.handle, mask.handle], () => st.session.newHandle());
    if (g) ops.push(...g.ops);
    else noRoot = true;
    const after = { ...structuredClone(e), xdata: withMaskLink(e.xdata, { type: maskType, offset: maskOffset, mask: mask.handle, ...(g ? { group: g.handle } : {}) }) } as Entity;
    ops.push({ kind: 'modify', block, before: e, after });
    st.session.commit({ label: 'TEXTMASK', ops, group: ctx.group, rebuildNow: true });
    n++;
  }
  app.clearSelection();
  ctx.print(n ? `문자 ${n}개를 ${MASK_LABEL[maskType]}(으)로 가렸습니다.` : '가릴 수 있는 문자가 없습니다(빈 문자).');
  if (noRoot) ctx.print('이 도면에는 이름 있는 객체 사전이 없어 문자와 가리개를 그룹으로 묶지 못했습니다.');
}

async function runTextunmask(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const hs = await ctx.getSelection('가리기를 지울 문자 또는 여러 줄 문자 객체 선택:');
  const list = pickTargets(app, hs, (e) => !!readMaskLink(e));
  if (!list.length) {
    ctx.print('가린 문자를 고르지 않았습니다.', 'err');
    return;
  }
  const ops = list.flatMap((e) => unmaskOps(app, e));
  if (ops.length) st.session.commit({ label: 'TEXTUNMASK', ops, group: ctx.group, rebuildNow: true });
  app.clearSelection();
  ctx.print(`문자 ${list.length}개의 가리기를 지웠습니다.`);
}

// ---------------------------------------------------------------------------
// TCIRCLE
// ---------------------------------------------------------------------------

let encOffset = 0.35;
let encShape: EncloseShape = 'circle';
let encConstant = false;
let encRadius = 0;

async function runTcircle(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const hs = await ctx.getSelection('문자 선택:');
  const list = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e && isEncloseTarget(e));
  if (!list.length) {
    ctx.print('문자나 여러 줄 문자를 고르지 않았습니다.', 'err');
    return;
  }
  const off = await askNumber(ctx, '간격띄우기 거리 비율 입력', encOffset, { min: 0, distance: false, text: (x) => numText(x) });
  if (typeof off !== 'number') return;
  encOffset = off;
  const s = await choose(ctx, `문자를 둘러쌀 객체 [원(C)/슬롯(S)/사각형(R)] <${SHAPE_LABEL[encShape]}>:`, [
    { key: 'C', label: '원' },
    { key: 'S', label: '슬롯' },
    { key: 'R', label: '사각형' },
  ], encShape === 'slot' ? 'S' : encShape === 'rect' ? 'R' : 'C');
  encShape = s === 'S' ? 'slot' : s === 'R' ? 'rect' : 'circle';
  const k = await choose(ctx, `일정한 크기 또는 가변 크기로 만들기 [일정(C)/가변(V)] <${encConstant ? '일정' : '가변'}>:`, [
    { key: 'C', label: '일정' },
    { key: 'V', label: '가변' },
  ], encConstant ? 'C' : 'V');
  encConstant = k === 'C';
  const size: { radius?: number; w?: number; h?: number } = {};
  if (encConstant) {
    const big = largestBox(list, doc)!;
    if (encShape === 'circle') {
      const def = encRadius > 0 ? encRadius : circleRadius(big, encOffset);
      const r = await askNumber(ctx, '원 반지름 입력', def, { positive: true });
      if (typeof r !== 'number') return;
      encRadius = r;
      size.radius = r;
    } else {
      size.w = big.w;
      size.h = big.h;
      ctx.print(`가장 큰 문자 상자(폭 ${numText(big.w)}, 높이 ${numText(big.h)})에 맞춘 일정한 크기로 만듭니다.`);
    }
  }
  const props = currentProps(app);
  const add = list.map((e) => encloseText(e, doc, encShape, encOffset, { ...props, handle: '' }, size)).filter((e): e is Entity => !!e);
  if (!add.length) {
    ctx.print('둘러쌀 수 있는 문자가 없습니다(빈 문자).', 'err');
    return;
  }
  const a = commitResults(app, ctx, [{ add }], 'TCIRCLE', { quiet: true });
  app.clearSelection();
  ctx.print(`${SHAPE_LABEL[encShape]} ${a.added.length}개를 만들었습니다.`);
}

// ---------------------------------------------------------------------------
// TXTEXP
// ---------------------------------------------------------------------------

async function runTxtexp(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const hs = await ctx.getSelection('객체 선택:');
  const list = pickTargets(app, hs, isExplodableText);
  const skipped = hs.length - list.length;
  if (!list.length) {
    ctx.print('분해할 문자(문자·여러 줄 문자·속성 정의·원호 정렬 문자)를 고르지 않았습니다.', 'err');
    return;
  }
  // 화면 글꼴이 아직 없으면 받는다(이미 받은 글꼴은 그대로)
  try {
    const codes = new Set<number>();
    const fams = new Set<NonNullable<ReturnType<typeof latinFamilyOf>>>();
    for (const e of list) {
      const t = 'text' in e ? String((e as { text: string }).text) : '';
      collectCodePoints(t, codes);
      const style = doc.textStyles.get(tableKey((e as { style?: string }).style ?? ''));
      const fam = latinFamilyOf(app.text.styleFont(style));
      if (fam) fams.add(fam);
    }
    await Promise.all([app.fontLib.require(codes), app.fontLib.requireLatin(fams)]);
  } catch {
    /* 받지 못하면 단선 글꼴로 */
  }
  const add: Entity[] = [];
  const remove: string[] = [];
  for (const e of list) {
    const parts = explodeTextGeometry(e, doc, app.text);
    remove.push(e.handle);
    add.push(...parts);
  }
  const a = commitResults(app, ctx, [{ remove, add }], 'TXTEXP', { quiet: true });
  app.clearSelection();
  ctx.print(`문자 객체 ${list.length}개를 분해했습니다(폴리선·선 ${a.added.length}개).${skipped ? ` 문자가 아니거나 잠긴 객체 ${skipped}개는 건너뛰었습니다.` : ''}`);
}

// ---------------------------------------------------------------------------

export function registerExpressTextCommands(app: App, add: (c: Command) => void = (c) => app.register(c)): void {
  add({ name: 'TCASE', title: '문자 대소문자 바꾸기', run: (ctx) => runTcase(app, ctx, true) });
  add({ name: '-TCASE', title: '문자 대소문자 바꾸기(명령행)', run: (ctx) => runTcase(app, ctx, false) });
  add({ name: 'TCOUNT', title: '문자에 일련번호 넣기', run: (ctx) => runTcount(app, ctx) });
  add({ name: 'TORIENT', title: '문자 방향 바꾸기', run: (ctx) => runTorient(app, ctx) });
  add({ name: 'TEXTFIT', title: '문자 맞추기', run: (ctx) => runTextfit(app, ctx) });
  add({ name: 'TEXTMASK', title: '문자 가리기', run: (ctx) => runTextmask(app, ctx) });
  add({ name: 'TEXTUNMASK', title: '문자 가리기 지우기', run: (ctx) => runTextunmask(app, ctx) });
  add({ name: 'TCIRCLE', title: '문자 둘레에 원·슬롯·사각형', run: (ctx) => runTcircle(app, ctx) });
  add({ name: 'TXTEXP', title: '문자 분해', run: (ctx) => runTxtexp(app, ctx) });
}
