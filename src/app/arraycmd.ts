/**
 * 배열 명령행 흐름: ARRAY(유형 고르기), ARRAYRECT, ARRAYPOLAR. AutoCAD처럼 객체를 고르면 기본 배열을 바로 만들어 보여 주고
 * `그립을 선택하여 배열을 편집하거나 [...] <종료>:`에서 옵션·그립으로 고친다.
 *  - 만드는 동안의 배열은 연관 배열(src/app/assocarray)이다 — 옵션은 ARRAYEDIT와 같은 함수(arrayEditOption), 그립은 배열 그립(assocarray-grips).
 *  - 연관(AS) = 아니오로 끝내면 그 배열을 거두고 항목마다 원본 사본을 만든다(같은 명령 취소 묶음).
 *  - Esc(취소)는 만든 배열을 거두고 원본을 되살린다. 명령 전체가 명령 취소 한 단계.
 * 예전 대화상자는 ARRAYCLASSIC(src/app/modify.ts), 명령행 클래식은 -ARRAY(src/app/dashcmds-array.ts).
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { Entity } from '../core/model';
import { formatLength } from '../core/units';
import { insertAffine } from '../edit/dynblock/build';
import { copyEntity, transformEntity, type EditResult } from '../edit/geom';
import { type Affine, affApply, affInv, affMul } from '../edit/geom/math';
import { expectedItems } from '../edit/assocarray/read';
import { MAX_ITEMS, itemKey } from '../edit/assocarray/types';
import { itemCount } from '../edit/assocarray/layout';
import type { App, CommandContext, Keyword } from './app';
import { CancelError } from './app';
import { unlockedOnly } from './layers';
import { arrayEditOption, arrayAssociativity, createAssocArray, setArrayAssociativity } from './assocarray';
import { applyArrayState, arrayOf, askNumber, askYesNo } from './assocarray-core';
import { arrayGripEdit, arrayGripPoints } from './assocarray-grips';
import { commitResults } from './modify';
import { runArrayPath } from './arraypath';
import type { Pt } from './view';

const RECT_KW: Keyword[] = [
  { key: 'AS', label: '연관' },
  { key: 'B', label: '기준점' },
  { key: 'COU', label: '개수' },
  { key: 'S', label: '간격두기' },
  { key: 'COL', label: '열' },
  { key: 'R', label: '행' },
  { key: 'L', label: '레벨' },
  { key: 'X', label: '종료' },
];

const POLAR_KW: Keyword[] = [
  { key: 'AS', label: '연관' },
  { key: 'B', label: '기준점' },
  { key: 'I', label: '항목' },
  { key: 'A', label: '사이각' },
  { key: 'F', label: '채울 각도' },
  { key: 'ROW', label: '행' },
  { key: 'L', label: '레벨' },
  { key: 'ROT', label: '항목 회전' },
  { key: 'X', label: '종료' },
];

const tooMany = `배열 항목이 너무 많습니다(최대 ${MAX_ITEMS.toLocaleString()}개).`;

/** 선택 범위(화면 고르기 상자) */
function extentsOf(app: App, hs: readonly string[]): [number, number, number, number] | null {
  const pk = app.picker();
  let r: [number, number, number, number] | null = null;
  for (const h of hs) {
    const b = pk?.box(h);
    if (!b) continue;
    r = r ? [Math.min(r[0], b.minX), Math.min(r[1], b.minY), Math.max(r[2], b.maxX), Math.max(r[3], b.maxY)] : [b.minX, b.minY, b.maxX, b.maxY];
  }
  return r;
}

async function selectForArray(app: App, ctx: CommandContext): Promise<string[]> {
  const st = app.active!;
  return unlockedOnly(app, await ctx.getSelection()).filter((h) => st.doc.entityIndex.has(h));
}

/** 이 명령 묶음에서 배열을 만든 뒤의 작업(취소·비연관 변환 때 거둔다) */
interface Session {
  handle: string;
  /** 만들기 전 이 묶음의 작업 수 */
  ops0: number;
  /** 원본 도면 좌표 → 원본 블록 좌표(만들 때: 첫 항목이 원본 자리) */
  normalize: Affine;
  sources: string[];
}

function rollback(app: App, ctx: CommandContext, s: Session): void {
  const ses = app.active!.session;
  const n = ses.opsInGroup(ctx.group) - s.ops0;
  if (n > 0) ses.undoLastStep(ctx.group, n);
}

/** 연관 = 아니오: 배열을 거두고(원본이 되살아난다) 항목마다 원본 사본(첫 항목이 원본 자리가 아니면 원본을 옮긴다) */
function convertToCopies(app: App, ctx: CommandContext, s: Session, label: string): number {
  const st = app.active!;
  const doc = st.doc;
  const info = arrayOf(st, s.handle);
  if (!info) return 0;
  const W = insertAffine(info.def, info.ins);
  const items = expectedItems(doc, info.ins, info.def, info.state.params).filter((it) => !info.state.removed.has(it.key));
  const z0 = info.ins.insert.z ?? 0;
  const mats = items.map((it) => ({ m: affMul(W, affMul(it.matrix, s.normalize)), dz: it.z + z0 }));
  rollback(app, ctx, s);
  const isId = (m: Affine) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.hypot(m[4], m[5]) < 1e-9 * Math.max(1, Math.abs(m[4]), Math.abs(m[5]));
  const mirrorText = Number(doc.header.get('$MIRRTEXT') ?? 0) === 1;
  const mirrorHatch = Number(doc.header.get('$MIRRHATCH') ?? 0) === 1;
  let keep = mats.findIndex((x) => isId(x.m) && Math.abs(x.dz) < 1e-12);
  const results: EditResult[] = [];
  const srcs = s.sources.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
  if (keep < 0 && mats.length) {
    // 원본이 첫 항목 자리로 옮겨 간다
    keep = 0;
    for (const e of srcs) results.push(transformEntity(e, mats[0]!.m, doc, { mirrorText, mirrorHatch }));
  }
  mats.forEach((x, i) => {
    if (i === keep) return;
    for (const e of srcs) results.push(copyEntity(e, x.m, doc, { mirrorText, mirrorHatch, dz: x.dz || undefined }));
  });
  st.selection.clear();
  const res = commitResults(app, ctx, results, label, { quiet: true });
  app.refreshSelectionOverlay();
  ctx.print(`항목 ${mats.length.toLocaleString()}개(새 객체 ${res.added.length.toLocaleString()}개)를 만들었습니다.`);
  return mats.length;
}

/** 배열의 그립(배열 그립 + 기준점(이동) 그립) 가운데 점 p에 가까운 것 */
function gripAt(app: App, handle: string, p: Pt): { id: string; point: Pt } | null {
  const st = app.active!;
  const info = arrayOf(st, handle);
  if (!info) return null;
  const grips: { id: string; point: Pt }[] = arrayGripPoints(st.doc, info.ins).map((g) => ({ id: g.id, point: g.point }));
  const p0 = info.state.params;
  const first = expectedItems(st.doc, info.ins, info.def, p0).find((it) => it.key === itemKey(0, 0, 0));
  const W = insertAffine(info.def, info.ins);
  // 직사각형: 첫 항목의 기준점 = 이동 그립. 원형: 중심(삽입점) = 이동 그립
  const movePt = p0.kind === 'polar' ? affApply(W, p0.center) : first ? affApply(affMul(W, first.matrix), p0.base) : null;
  if (movePt) grips.unshift({ id: 'move', point: movePt });
  const px = typeof app.view?.pixelSize === 'function' ? app.view.pixelSize() : 0;
  const tol = Math.max(8 * px, 1e-9);
  let best: { id: string; point: Pt } | null = null;
  let bd = Infinity;
  for (const g of grips) {
    const d = Math.hypot(g.point.x - p.x, g.point.y - p.y);
    if (d <= tol && d < bd) {
      bd = d;
      best = g;
    }
  }
  return best;
}

/** 배열 이동(이동 그립): 배열 참조의 삽입점을 옮긴다 */
async function moveArray(app: App, ctx: CommandContext, handle: string, from: Pt): Promise<void> {
  const st = app.active!;
  const info = arrayOf(st, handle);
  if (!info) return;
  ctx.print('** 이동 **');
  const r = await ctx.getPoint('이동점 지정:', { base: from });
  if (!('point' in r)) return;
  const dx = r.point.x - from.x;
  const dy = r.point.y - from.y;
  applyArrayState(app, ctx, info, info.state, 'GRIP', { insert: { ...info.ins, insert: { ...info.ins.insert, x: info.ins.insert.x + dx, y: info.ins.insert.y + dy } } });
}

/** 직사각형 배열의 개수(COU)·간격두기(S) */
async function rectCountSpacing(app: App, ctx: CommandContext, handle: string, k: 'COU' | 'S'): Promise<void> {
  const st = app.active!;
  const info = arrayOf(st, handle);
  if (!info || info.state.params.kind !== 'rect') return;
  const p = info.state.params;
  const fmt = (v: number) => formatLength(v, st.units);
  if (k === 'COU') {
    const cols = await askNumber(ctx, `열 수 입력 또는 [표현식(E)] <${p.columns}>:`, p.columns, {
      integer: true,
      check: (v) => (v < 1 ? '1 이상의 정수를 입력하십시오.' : itemCount({ ...p, columns: v }) > MAX_ITEMS ? tooMany : null),
    });
    if (typeof cols !== 'number') return;
    const rows = await askNumber(ctx, `행 수 입력 또는 [표현식(E)] <${p.rows}>:`, p.rows, {
      integer: true,
      check: (v) => (v < 1 ? '1 이상의 정수를 입력하십시오.' : itemCount({ ...p, columns: cols, rows: v }) > MAX_ITEMS ? tooMany : null),
    });
    if (typeof rows !== 'number') return;
    if (cols * rows < 2) {
      ctx.print('항목이 둘 이상이어야 합니다.', 'err');
      return;
    }
    applyArrayState(app, ctx, info, { ...info.state, params: { ...p, columns: cols, rows } }, 'ARRAYRECT');
    return;
  }
  // 간격두기: 열 사이 거리 또는 단위 셀(두 구석 = 열·행 간격), 다음에 행 사이 거리
  const d = await askNumber(ctx, `열 사이의 거리 지정 또는 [단위 셀(U)] <${fmt(p.columnSpacing)}>:`, p.columnSpacing, { keywords: [{ key: 'U', label: '단위 셀' }] });
  if (d === null) return;
  if (typeof d !== 'number') {
    const a = await ctx.getPoint('단위 셀 지정:');
    if (!('point' in a)) return;
    const b = await ctx.getPoint('다른 구석점 지정:', { base: a.point, rubber: (q) => [{ pts: [a.point.x, a.point.y, q.x, a.point.y, q.x, q.y, a.point.x, q.y], closed: true, dashed: true }] });
    if (!('point' in b)) return;
    const cx = b.point.x - a.point.x;
    const cy = b.point.y - a.point.y;
    if (Math.abs(cx) < 1e-12 || Math.abs(cy) < 1e-12) return;
    applyArrayState(app, ctx, info, { ...info.state, params: { ...p, columnSpacing: cx, rowSpacing: cy } }, 'ARRAYRECT');
    return;
  }
  const rs = await askNumber(ctx, `행 사이의 거리 지정 <${fmt(p.rowSpacing)}>:`, p.rowSpacing);
  if (typeof rs !== 'number') return;
  applyArrayState(app, ctx, info, { ...info.state, params: { ...p, columnSpacing: d, rowSpacing: rs } }, 'ARRAYRECT');
}

/**
 * 만든 배열을 고치는 공통 고리: 옵션·그립, 끝나면 연관이 아니면 사본으로. 취소하면 거둔다.
 */
async function editLoop(app: App, ctx: CommandContext, s: Session, kind: 'rect' | 'polar', label: string, assoc0: boolean): Promise<void> {
  const st = app.active!;
  let assoc = assoc0;
  const kws = kind === 'rect' ? RECT_KW : POLAR_KW;
  const prompt = `그립을 선택하여 배열을 편집하거나 [${kws.map((k) => `${k.label}(${k.key})`).join('/')}] <종료>:`;
  try {
    for (;;) {
      const info = arrayOf(st, s.handle);
      if (!info) {
        ctx.print('배열을 다시 읽을 수 없습니다.', 'err');
        return;
      }
      // 배열의 그립이 보이게 고른다(누른 점이 그립 가까이면 그 그립을 편집한다)
      app.setSelection([s.handle]);
      const r = await ctx.getPoint(prompt, { keywords: kws });
      if ('enter' in r || ('keyword' in r && r.keyword === 'X')) break;
      if ('point' in r) {
        const g = gripAt(app, s.handle, r.point);
        if (!g) continue;
        app.setSelection([]);
        if (g.id === 'move') await moveArray(app, ctx, s.handle, g.point);
        else await arrayGripEdit(app, ctx, s.handle, g.id);
        continue;
      }
      if (!('keyword' in r)) continue;
      const k = r.keyword;
      app.setSelection([]);
      if (k === 'AS') {
        assoc = await askYesNo(ctx, '연관 배열 작성', assoc);
        setArrayAssociativity(assoc);
      } else if (kind === 'rect' && (k === 'COU' || k === 'S')) await rectCountSpacing(app, ctx, s.handle, k);
      else await arrayEditOption(app, ctx, s.handle, info, k);
    }
  } catch (e) {
    // Esc: 만든 배열을 거두고 원본을 되살린다
    if (e instanceof CancelError) {
      app.setSelection([]);
      rollback(app, ctx, s);
    }
    throw e;
  }
  app.setSelection([]);
  if (!assoc) {
    convertToCopies(app, ctx, s, label);
    return;
  }
  const info = arrayOf(st, s.handle);
  if (info) {
    const n = expectedItems(st.doc, info.ins, info.def, info.state.params).length - info.state.removed.size;
    ctx.print(`항목 ${n.toLocaleString()}개의 연관 배열(${kind === 'rect' ? '직사각형' : '원형'})을 만들었습니다.`);
  }
  app.refreshSelectionOverlay();
}

/** 배열을 만든 직후의 정보(첫 항목 → 원본 자리 역행렬) */
function startSession(app: App, handle: string, ops0: number, sources: string[]): Session | null {
  const st = app.active!;
  const info = arrayOf(st, handle);
  if (!info) return null;
  const first = expectedItems(st.doc, info.ins, info.def, info.state.params).find((it) => it.key === itemKey(0, 0, 0));
  if (!first) return null;
  const inv = affInv(affMul(insertAffine(info.def, info.ins), first.matrix));
  if (!inv) return null;
  return { handle, ops0, normalize: inv, sources };
}

/** ARRAYRECT 본체(객체를 이미 골랐을 때) */
export async function runArrayRect(app: App, ctx: CommandContext, hs: string[]): Promise<void> {
  const st = app.active!;
  if (!hs.length) return;
  const assoc = arrayAssociativity();
  ctx.print(`유형 = 직사각형  연관 = ${assoc ? '예' : '아니오'}`);
  const ext = extentsOf(app, hs) ?? [0, 0, 1, 1];
  const w = Math.max(ext[2] - ext[0], 1e-6);
  const hgt = Math.max(ext[3] - ext[1], 1e-6);
  const ops0 = st.session.opsInGroup(ctx.group);
  // AutoCAD 기본: 4열 3행, 간격 = 선택 범위의 1.5배
  const handle = createAssocArray(app, ctx, { kind: 'rect', handles: hs, rows: 3, columns: 4, rowSpacing: +(hgt * 1.5).toPrecision(6), columnSpacing: +(w * 1.5).toPrecision(6), angle: 0 }, 'ARRAYRECT', { quiet: true });
  if (!handle) return;
  const s = startSession(app, handle, ops0, hs);
  if (!s) return;
  await editLoop(app, ctx, s, 'rect', 'ARRAYRECT', assoc);
}

/** ARRAYPOLAR 본체(객체를 이미 골랐을 때) */
export async function runArrayPolar(app: App, ctx: CommandContext, hs: string[]): Promise<void> {
  const st = app.active!;
  if (!hs.length) return;
  const assoc = arrayAssociativity();
  ctx.print(`유형 = 원형  연관 = ${assoc ? '예' : '아니오'}`);
  let base: Pt | undefined;
  let center: Pt | null = null;
  while (!center) {
    const r = await ctx.getPoint('배열의 중심점 지정 또는 [기준점(B)/회전축(A)]:', {
      keywords: [
        { key: 'B', label: '기준점' },
        { key: 'A', label: '회전축' },
      ],
    });
    if ('enter' in r) return;
    if ('point' in r) {
      center = r.point;
      continue;
    }
    if (!('keyword' in r)) continue;
    if (r.keyword === 'A') {
      ctx.print('평면도에서는 Z축이 회전축입니다(다른 회전축은 쓸 수 없습니다).');
      continue;
    }
    const b = await ctx.getPoint('기준점 지정 또는 [키 점(K)] <중심>:', { keywords: [{ key: 'K', label: '키 점' }] });
    if ('point' in b) base = b.point;
    else if ('keyword' in b) {
      const kp = await ctx.getPoint('원본 객체의 키 점 지정:');
      if ('point' in kp) base = kp.point;
    } else if ('enter' in b) base = undefined;
  }
  const ops0 = st.session.opsInGroup(ctx.group);
  // AutoCAD 기본: 항목 6개, 360°, 항목 회전
  const handle = createAssocArray(app, ctx, { kind: 'polar', handles: hs, center, items: 6, fill: Math.PI * 2, rotate: true, ...(base ? { base } : {}) }, 'ARRAYPOLAR', { quiet: true });
  if (!handle) return;
  const s = startSession(app, handle, ops0, hs);
  if (!s) return;
  await editLoop(app, ctx, s, 'polar', 'ARRAYPOLAR', assoc);
}

export function registerArrayCommands(app: App): void {
  app.register({
    name: 'ARRAYRECT',
    title: '직사각형 배열',
    async run(ctx) {
      await runArrayRect(app, ctx, await selectForArray(app, ctx));
    },
  });
  app.register({
    name: 'ARRAYPOLAR',
    title: '원형 배열',
    async run(ctx) {
      await runArrayPolar(app, ctx, await selectForArray(app, ctx));
    },
  });
  app.register({
    name: 'ARRAY',
    aliases: ['AR'],
    title: '배열',
    async run(ctx) {
      const hs = await selectForArray(app, ctx);
      if (!hs.length) return;
      const r = await ctx.getPoint('배열 유형 입력 [직사각형(R)/경로(PA)/원형(PO)] <직사각형>:', {
        keywords: [
          { key: 'R', label: '직사각형' },
          { key: 'PA', label: '경로' },
          { key: 'PO', label: '원형' },
        ],
      });
      const k = 'keyword' in r ? r.keyword : 'enter' in r ? 'R' : null;
      if (k === 'PA') await runArrayPath(app, ctx, hs);
      else if (k === 'PO') await runArrayPolar(app, ctx, hs);
      else if (k === 'R') await runArrayRect(app, ctx, hs);
    },
  });
}
