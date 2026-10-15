/**
 * 명령행 수정·참조 명령: -OVERKILL, -XREF, -IMAGE.
 * - -OVERKILL: 객체 선택 → `변경할 옵션 입력 [무시(I)/공차(O)/폴리선 최적화(P)/부분 겹침 결합(T)/끝과 끝 결합(E)] <완료>:`.
 *   설정은 OVERKILL 대화상자와 같이 문서별로 기억한다.
 * - -XREF: ?·결합(B)·분리(D)·경로(P). 언로드·다시 로드·부착·중첩처럼 파일이 필요하거나 이 웹 버전에 없는 옵션은 안내한다.
 * - -IMAGE: ?·분리(D)·경로(P)·다시 로드(R)·언로드(U)(로드 표시만 바꾼다). 부착(A)은 안내한다.
 */
import type { CadDocument, CadObject, DictionaryObject, Entity, ImageDefObject, ImageEntity } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { type OverkillProp, overkill } from '../edit/geom/overkill';
import { bindXrefOps } from '../edit/refedit/bind';
import { matchNameList } from '../edit/layercmd';
import type { App, CommandContext, Keyword } from './app';
import { askLine, askOption, askReal, askWord, askYN } from './dashcmds-ask';
import { commitResults } from './modify';
import { memOf, selectEditable } from './modify2-util';
import { xrefOfDoc } from './refs';

// ---------------------------------------------------------------------------
// -OVERKILL
// ---------------------------------------------------------------------------

const IGNORE_KW: [string, OverkillProp | null, string][] = [
  ['C', 'color', '색상'],
  ['LA', 'layer', '도면층'],
  ['LT', 'linetype', '선종류'],
  ['S', 'ltscale', '선종류 축척'],
  ['LW', 'lineweight', '선가중치'],
  ['TH', 'thickness', '두께'],
  ['TR', 'transparency', '투명도'],
  ['PL', 'plotstyle', '플롯 스타일'],
  ['M', 'material', '재료'],
];

/** 무시할 특성 입력(쉼표 목록, 없음 N·모두 A) → 특성. 모르는 항목이 있으면 null */
export function parseIgnoreList(text: string): OverkillProp[] | null {
  const out = new Set<OverkillProp>();
  for (const part of text.split(',')) {
    const t = part.trim().toUpperCase();
    if (!t) continue;
    if (t === 'N' || t === '없음') continue;
    if (t === 'A' || t === '모두') {
      for (const [, p] of IGNORE_KW) if (p) out.add(p);
      continue;
    }
    const hit = IGNORE_KW.find(([k, , label]) => k === t || label === part.trim());
    if (!hit) return null;
    out.add(hit[1]!);
  }
  return [...out];
}

async function runDashOverkill(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const hs = await selectEditable(app, ctx);
  if (!hs.length) return;
  const m = memOf(st);
  const saved = { ...((m.overkill as Record<string, number | boolean> | undefined) ?? {}) };
  const yn = (b: unknown) => (b ? '예' : '아니오');
  let tol = Number(saved.tol ?? 0.000001);
  const ign = new Set<OverkillProp>(IGNORE_KW.filter(([, p]) => p && saved[`ig_${p}`]).map(([, p]) => p!));
  let opt = saved.opt !== false;
  let overlap = saved.overlap !== false;
  let end = saved.end !== false;
  for (;;) {
    const names = IGNORE_KW.filter(([, p]) => p && ign.has(p)).map(([, , l]) => l);
    ctx.print(`현재 설정: 공차=${tol}, 무시=${names.length ? names.join(',') : '없음'}, 폴리선 최적화=${yn(opt)}, 부분 겹침 결합=${yn(overlap)}, 끝과 끝 결합=${yn(end)}`);
    const k = await askOption(
      ctx,
      '변경할 옵션 입력 [무시(I)/공차(O)/폴리선 최적화(P)/부분 겹침 결합(T)/끝과 끝 결합(E)] <완료>:',
      [
        { key: 'I', label: '무시' },
        { key: 'O', label: '공차' },
        { key: 'P', label: '폴리선 최적화' },
        { key: 'T', label: '부분 겹침 결합' },
        { key: 'E', label: '끝과 끝 결합' },
        { key: 'D', label: '완료' },
      ],
      'D',
    );
    if (k === 'D' || k === null) break;
    if (k === 'I') {
      for (;;) {
        const t = await askWord(ctx, '무시할 특성 지정 [없음(N)/모두(A)/색상(C)/도면층(LA)/선종류(LT)/선종류 축척(S)/선가중치(LW)/두께(TH)/투명도(TR)/플롯 스타일(PL)/재료(M)] <없음>:');
        const list = parseIgnoreList(t ?? 'N');
        if (!list) {
          ctx.print('옵션 키워드가 필요합니다(쉼표로 여러 개).', 'err');
          continue;
        }
        ign.clear();
        for (const p of list) ign.add(p);
        break;
      }
    } else if (k === 'O') tol = await askReal(ctx, `공차 값 지정 <${tol}>:`, tol, (v) => (v >= 0 ? null : '공차는 0 이상이어야 합니다.'));
    else if (k === 'P') opt = await askYN(ctx, '폴리선 내의 세그먼트 최적화', opt);
    else if (k === 'T') overlap = await askYN(ctx, '부분 겹침 객체 결합', overlap);
    else if (k === 'E') end = await askYN(ctx, '끝과 끝이 정렬된 동일 선상의 객체 결합', end);
  }
  // 대화상자와 같은 꼴로 기억
  const mem: Record<string, number | boolean> = { tol, opt, overlap, end };
  for (const [, p] of IGNORE_KW) if (p) mem[`ig_${p}`] = ign.has(p);
  m.overkill = mem;
  const list = hs.map((h) => st.doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
  const r = overkill(list, { tolerance: tol, ignore: ign, optimizePolylines: opt, combineOverlap: overlap, combineEndToEnd: end });
  st.selection.clear();
  commitResults(app, ctx, [{ ...r.result, message: undefined }], 'OVERKILL', { quiet: true });
  ctx.print(`${r.duplicates}개의 중복 항목 삭제됨`);
  ctx.print(`${r.overlaps}개의 겹치는 객체 또는 세그먼트 삭제됨`);
}

// ---------------------------------------------------------------------------
// -XREF
// ---------------------------------------------------------------------------

const xrefBlocks = (doc: CadDocument) => [...doc.blocks.values()].filter((b) => b.flags & 4);

/** 이름 사양에 맞는 외부 참조 블록(없으면 알린다) */
function pickXrefs(ctx: CommandContext, spec: string) {
  const doc = ctx.app.active!.doc;
  const all = xrefBlocks(doc);
  const m = matchNameList(
    all.map((b) => b.name),
    spec,
  );
  if (!m.names.length) ctx.print(`외부 참조 "${spec}"을(를) 찾을 수 없습니다.`, 'err');
  return m.names.map((n) => doc.blocks.get(tableKey(n))!).filter(Boolean);
}

/** 외부 참조 분리: 참조(INSERT)·블록 정의·블록 레코드·의존 기호(이름|…)를 지운다 */
export function detachXrefOps(doc: CadDocument, name: string): EditOp[] {
  const key = tableKey(name);
  const ops: EditOp[] = [];
  const usedLayers = new Set<string>();
  for (const [bk, b] of doc.blocks) {
    const removes: EditOp[] = [];
    b.entities.forEach((e, i) => {
      if (e.type === 'INSERT' && tableKey(e.block) === key) removes.push({ kind: 'remove', block: bk, entity: e, index: i });
      else if (bk !== key) usedLayers.add(tableKey(e.layer));
    });
    ops.push(...removes.reverse());
  }
  const def = doc.blocks.get(key);
  if (def) ops.push({ kind: 'blockDef', key, before: def, after: null });
  const rec = doc.blockRecords.get(key);
  if (rec) ops.push({ kind: 'blockRecord', key, before: rec, after: null });
  const dep = (k: string) => k.startsWith(`${key}|`);
  for (const [k, l] of doc.layers) if (dep(k) && !usedLayers.has(k)) ops.push({ kind: 'layer', key: k, before: l, after: null });
  for (const [k, l] of doc.linetypes) if (dep(k)) ops.push({ kind: 'linetype', key: k, before: l, after: null });
  for (const [k, s] of doc.textStyles) if (dep(k)) ops.push({ kind: 'textStyle', key: k, before: s, after: null });
  for (const [k, s] of doc.dimStyles) if (dep(k)) ops.push({ kind: 'dimStyle', key: k, before: s, after: null });
  return ops;
}

async function runDashXref(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const KW: Keyword[] = [
    { key: '?', label: '?' },
    { key: 'B', label: '결합' },
    { key: 'D', label: '분리' },
    { key: 'P', label: '경로' },
    { key: 'U', label: '언로드' },
    { key: 'R', label: '다시 로드' },
    { key: 'O', label: '중첩' },
    { key: 'A', label: '부착' },
  ];
  const k = await askOption(ctx, '옵션 입력 [?/결합(B)/분리(D)/경로(P)/언로드(U)/다시 로드(R)/중첩(O)/부착(A)] <부착>:', KW, 'A');
  if (k === 'A' || k === 'O') {
    ctx.print('외부 참조 부착은 이 웹 버전의 명령행에서 할 수 없습니다(경로로 파일을 열 수 없음). 참조 파일은 EXTERNALREFERENCES(XR)에서 연결하십시오.', 'err');
    return;
  }
  if (k === '?') {
    const spec = (await askWord(ctx, '나열할 외부 참조 입력 <*>:')) ?? '*';
    const all = xrefBlocks(doc);
    const names = new Set(
      matchNameList(
        all.map((b) => b.name),
        spec,
      ).names.map(tableKey),
    );
    ctx.print('참조 이름               경로');
    for (const b of all) if (names.has(tableKey(b.name))) ctx.print(`${b.name.padEnd(24)}${b.xrefPath ?? ''}${b.flags & 8 ? '  (중첩)' : ''}`);
    ctx.print(`총 외부 참조: ${all.length}개`);
    return;
  }
  const prompt = { B: '결합할 외부 참조 이름 입력:', D: '분리할 외부 참조 이름 입력:', P: '편집할 외부 참조 이름 입력:', U: '언로드할 외부 참조 이름 입력:', R: '다시 로드할 외부 참조 이름 입력:' }[k as 'B' | 'D' | 'P' | 'U' | 'R'];
  const spec = await askWord(ctx, prompt);
  if (!spec) return;
  const blocks = pickXrefs(ctx, spec);
  if (!blocks.length) return;
  if (k === 'U' || k === 'R') {
    ctx.print(
      k === 'U'
        ? '외부 참조 언로드는 이 웹 버전에서 지원하지 않습니다. 보이지 않게 하려면 그 도면층을 끄거나 분리(D)하십시오.'
        : '다시 로드하려면 파일이 필요합니다. EXTERNALREFERENCES(XR)에서 파일을 다시 연결하십시오.',
    );
    return;
  }
  if (k === 'P') {
    for (const b of blocks) {
      ctx.print(`외부 참조 이름: ${b.name}`);
      ctx.print(`이전 경로: ${b.xrefPath ?? ''}`);
      const path = (await askLine(ctx, '새 경로 입력:', '')).trim().replace(/^"(.*)"$/, '$1');
      if (!path) continue;
      st.session.commit({ label: 'XREF', ops: [{ kind: 'blockDef', key: tableKey(b.name), before: b, after: { ...b, xrefPath: path } }], group: ctx.group });
    }
    return;
  }
  if (k === 'D') {
    const ops = blocks.flatMap((b) => detachXrefOps(doc, b.name));
    if (ops.length) st.session.commit({ label: 'XREF', ops, group: ctx.group, rebuildNow: true });
    for (const b of blocks) ctx.print(`외부 참조 "${b.name}"을(를) 분리했습니다.`);
    return;
  }
  // 결합
  for (const b of blocks) {
    const file = xrefOfDoc(doc, tableKey(b.name));
    if (!file) {
      ctx.print(`외부 참조 "${b.name}"의 파일이 연결되지 않아 결합할 수 없습니다. EXTERNALREFERENCES(XR)에서 파일을 먼저 연결하십시오.`, 'err');
      continue;
    }
    const r = bindXrefOps(doc, tableKey(b.name), file.doc, () => st.session.newHandle());
    if (!r) continue;
    st.session.commit({ label: 'XREF', ops: r.ops, group: ctx.group, rebuildNow: true });
    ctx.print(`외부 참조 "${b.name}"을(를) 결합했습니다(객체 ${r.entities}개${r.skipped ? `, 옮기지 못한 객체 ${r.skipped}개` : ''}${r.nested ? `, 중첩 참조 ${r.nested}개는 빠짐` : ''}).`);
  }
}

// ---------------------------------------------------------------------------
// -IMAGE
// ---------------------------------------------------------------------------

/** 이미지 정의 이름(이미지 사전의 이름, 없으면 파일 이름) → 정의 */
export function imageDefs(doc: CadDocument): { name: string; def: ImageDefObject; dict: DictionaryObject | null }[] {
  const out: { name: string; def: ImageDefObject; dict: DictionaryObject | null }[] = [];
  const seen = new Set<string>();
  for (const o of doc.objects.values()) {
    if (o.type !== 'DICTIONARY' && o.type !== 'ACDBDICTIONARYWDFLT') continue;
    for (const [name, h] of (o as DictionaryObject).entries) {
      const d = doc.objects.get(h);
      if (d?.type === 'IMAGEDEF' && !seen.has(d.handle)) {
        seen.add(d.handle);
        out.push({ name, def: d as ImageDefObject, dict: o as DictionaryObject });
      }
    }
  }
  for (const o of doc.objects.values())
    if (o.type === 'IMAGEDEF' && !seen.has(o.handle)) out.push({ name: (o as ImageDefObject).fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, ''), def: o as ImageDefObject, dict: null });
  return out;
}

/** 이미지 분리: 그 정의를 쓰는 이미지 객체·반응자·정의·사전 항목을 지운다 */
export function detachImageOps(doc: CadDocument, item: { name: string; def: ImageDefObject; dict: DictionaryObject | null }): EditOp[] {
  const ops: EditOp[] = [];
  const reactors = new Set<string>();
  for (const [bk, b] of doc.blocks) {
    const removes: EditOp[] = [];
    b.entities.forEach((e, i) => {
      if (e.type === 'IMAGE' && (e as ImageEntity).imageDef === item.def.handle) {
        removes.push({ kind: 'remove', block: bk, entity: e, index: i });
        if ((e as ImageEntity).imageDefReactor) reactors.add((e as ImageEntity).imageDefReactor!);
      }
    });
    ops.push(...removes.reverse());
  }
  for (const h of reactors) {
    const o = doc.objects.get(h);
    if (o) ops.push({ kind: 'object', key: h, before: o, after: null });
  }
  ops.push({ kind: 'object', key: item.def.handle, before: item.def, after: null });
  if (item.dict) {
    const entries = new Map(item.dict.entries);
    entries.delete(item.name);
    ops.push({ kind: 'object', key: item.dict.handle, before: item.dict, after: { ...item.dict, entries } as CadObject });
  }
  return ops;
}

async function runDashImage(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const k = await askOption(
    ctx,
    '이미지 옵션 입력 [?/분리(D)/경로(P)/다시 로드(R)/언로드(U)/부착(A)] <부착>:',
    [
      { key: '?', label: '?' },
      { key: 'D', label: '분리' },
      { key: 'P', label: '경로' },
      { key: 'R', label: '다시 로드' },
      { key: 'U', label: '언로드' },
      { key: 'A', label: '부착' },
    ],
    'A',
  );
  if (k === 'A') {
    ctx.print('이미지 부착은 이 웹 버전의 명령행에서 할 수 없습니다(경로로 파일을 열 수 없음). 이미지 파일은 EXTERNALREFERENCES(XR)에서 연결하십시오.', 'err');
    return;
  }
  const all = imageDefs(doc);
  const pick = (spec: string) => {
    const names = new Set(
      matchNameList(
        all.map((x) => x.name),
        spec,
      ).names.map((n) => n.toUpperCase()),
    );
    const hit = all.filter((x) => names.has(x.name.toUpperCase()));
    if (!hit.length) ctx.print(`이미지 "${spec}"을(를) 찾을 수 없습니다.`, 'err');
    return hit;
  };
  if (k === '?') {
    const hit = pick((await askWord(ctx, '나열할 이미지 입력 <*>:')) ?? '*');
    ctx.print('이미지 이름             로드됨   경로');
    for (const x of hit) ctx.print(`${x.name.padEnd(24)}${(x.def.loaded ? '예' : '아니오').padEnd(9)}${x.def.fileName}`);
    ctx.print(`총 이미지 정의: ${all.length}개`);
    return;
  }
  const prompt = { D: '분리할 이미지 입력:', P: '편집할 이미지 입력:', R: '다시 로드할 이미지 입력:', U: '언로드할 이미지 입력:' }[k as 'D' | 'P' | 'R' | 'U'];
  const spec = await askWord(ctx, prompt);
  if (!spec) return;
  const hit = pick(spec);
  if (!hit.length) return;
  if (k === 'D') {
    const ops = hit.flatMap((x) => detachImageOps(doc, x));
    st.session.commit({ label: 'IMAGE', ops, group: ctx.group, rebuildNow: true });
    for (const x of hit) ctx.print(`이미지 "${x.name}"을(를) 분리했습니다.`);
    return;
  }
  if (k === 'P') {
    for (const x of hit) {
      ctx.print(`이미지 이름: ${x.name}`);
      ctx.print(`이전 경로: ${x.def.fileName}`);
      const path = (await askLine(ctx, '새 경로 입력:', '')).trim().replace(/^"(.*)"$/, '$1');
      if (path) st.session.commit({ label: 'IMAGE', ops: [{ kind: 'object', key: x.def.handle, before: x.def, after: { ...x.def, fileName: path } }], group: ctx.group });
    }
    return;
  }
  const loaded = k === 'R';
  const ops: EditOp[] = hit.filter((x) => x.def.loaded !== loaded).map((x) => ({ kind: 'object', key: x.def.handle, before: x.def, after: { ...x.def, loaded } }));
  if (ops.length) st.session.commit({ label: 'IMAGE', ops, group: ctx.group, rebuildNow: true });
  for (const x of hit) {
    const found = app.imageKeys.has(x.def.fileName.replace(/^.*[\\/]/, '').toLowerCase());
    ctx.print(
      loaded
        ? `이미지 "${x.name}"을(를) 로드됨으로 표시했습니다.${found ? '' : ' 파일이 연결되지 않아 테두리만 보입니다. EXTERNALREFERENCES(XR)에서 파일을 연결하십시오.'}`
        : `이미지 "${x.name}"을(를) 언로드됨으로 표시했습니다(저장하면 AutoCAD에서 언로드 상태로 열립니다).`,
    );
  }
}

export function registerDashMiscCommands(app: App): void {
  app.register({ name: '-OVERKILL', title: '중복 객체 삭제(명령행)', run: (ctx) => runDashOverkill(app, ctx) });
  app.register({ name: '-XREF', aliases: ['-XR'], title: '외부 참조(명령행)', run: (ctx) => runDashXref(app, ctx) });
  app.register({ name: '-IMAGE', aliases: ['-IM'], title: '이미지(명령행)', run: (ctx) => runDashImage(app, ctx) });
}
