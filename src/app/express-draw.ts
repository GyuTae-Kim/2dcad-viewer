/**
 * Express Tools 그리기·수정 명령: BREAKLINE(끊기선), MPEDIT(다중 폴리선 편집), EXOFFSET(간격띄우기 확장),
 * FLATTEN(평면화), CDORDER(색상별 그리기 순서), MKLTYPE(선종류 만들기), SHOWURLS(하이퍼링크 목록), REDIR(경로 바꾸기).
 * 계산은 src/edit/express/*.ts. 각 명령은 한 번의 명령 취소로 되돌린다.
 */
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import { formatLength } from '../core/units';
import { entityBounds } from '../edit/geom/query';
import { type Hyperlink, readHyperlink, withHyperlink } from '../edit/hyperlink';
import type { EditOp } from '../edit/session';
import { makeBreakline } from '../edit/express/breakline';
import { type Chain, type GapType, GAP_LABEL, chainDistance, chainsOf, offsetChain, oppositeSide } from '../edit/express/exoffset';
import { flattenEntity } from '../edit/express/flatten';
import { cdorderList, colorKeyLabel, colorsOf, displayColorKey, reorderOps } from '../edit/express/cdorder';
import { linFileText, linetypeFromObjects, linetypeNameProblem, makeLinetypeRecord } from '../edit/express/mkltype';
import { REDIR_DEFAULT, type RedirMode, redirList, redirModeText, redirOps } from '../edit/express/redir';
import type { App, Command, CommandContext } from './app';
import { currentProps } from './draw';
import { download } from './export';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import { askNumber, choose, memOf, previewOf, undoStep, yesNo } from './modify2-util';
import { peditMultiple } from './modify2-pedit';
import { dialog, form, h } from './ui/dom';
import { askString, whenClosed } from './express-util';
import type { Pt } from './view';

// ---------------------------------------------------------------------------
// BREAKLINE
// ---------------------------------------------------------------------------

async function runBreakline(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const m = memOf(st);
  let size = typeof m.brkSize === 'number' ? m.brkSize : 1;
  let ext = typeof m.brkExt === 'number' ? m.brkExt : 1;
  const L = (v: number) => formatLength(v, st.units);
  let p1: Pt;
  for (;;) {
    ctx.print(`블록 = BRKLINE.DWG(내장 기호), 크기 = ${L(size)}, 확장 = ${L(ext)}`);
    const r = await ctx.getPoint('끊기선의 첫 번째 점 지정 또는 [블록(B)/크기(S)/확장(E)]:', {
      keywords: [
        { key: 'B', label: '블록' },
        { key: 'S', label: '크기' },
        { key: 'E', label: '확장' },
      ],
    });
    if ('keyword' in r) {
      if (r.keyword === 'B') ctx.print('이 웹 버전은 내장 끊기 기호만 씁니다. 사용자 끊기 기호 블록(BRKLINE.DWG를 바꾼 도면)은 읽을 수 없습니다.', 'err');
      else if (r.keyword === 'S') {
        const v = await askNumber(ctx, '끊기선 기호 크기 입력', size, { positive: true });
        if (typeof v === 'number') m.brkSize = size = v;
      } else {
        const v = await askNumber(ctx, '확장 거리 입력', ext, { min: 0 });
        if (typeof v === 'number') m.brkExt = ext = v;
      }
      continue;
    }
    if (!('point' in r)) return;
    p1 = r.point;
    break;
  }
  const props = { ...currentProps(app), handle: '' };
  const make = (a: Pt, b: Pt, at?: Pt) => makeBreakline(props, a, b, { size, extension: ext, at });
  const r2 = await ctx.getPoint('끊기선의 두 번째 점 지정:', {
    base: p1,
    ghost: (p) => {
      const e = make(p1, p);
      return typeof e === 'string' ? [] : previewOf(app, [e]);
    },
  });
  if (!('point' in r2)) return;
  const p2 = r2.point;
  const r3 = await ctx.getPoint('끊기 기호 위치 지정 <중간점>:', {
    ghost: (p) => {
      const e = make(p1, p2, p);
      return typeof e === 'string' ? [] : previewOf(app, [e]);
    },
  });
  const at = 'point' in r3 ? r3.point : undefined;
  const e = make(p1, p2, at);
  if (typeof e === 'string') {
    ctx.print(e, 'err');
    return;
  }
  commitResults(app, ctx, [{ add: [e] }], 'BREAKLINE', { quiet: true });
}

// ---------------------------------------------------------------------------
// MPEDIT
// ---------------------------------------------------------------------------

async function runMpedit(app: App, ctx: CommandContext): Promise<void> {
  const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:'));
  if (!hs.length) return;
  await peditMultiple(app, ctx, hs);
}

// ---------------------------------------------------------------------------
// EXOFFSET
// ---------------------------------------------------------------------------

async function runExoffset(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const m = memOf(st);
  let through = m.exoDist === undefined || Number(m.exoDist) < 0;
  let distance = through ? 1 : Number(m.exoDist);
  let layerCurrent = m.exoLayer === 'C';
  let gap: GapType = (m.exoGap as GapType) ?? 'N';
  let join = !!m.exoJoin;
  let erase = !!m.exoErase;
  let fuzz = typeof m.exoFuzz === 'number' ? m.exoFuzz : 0;
  const L = (v: number) => formatLength(v, st.units);
  for (;;) {
    ctx.print(`현재 설정: 거리 = ${through ? '통과점' : L(distance)}, 도면층 = ${layerCurrent ? '현재' : '원본'}, 간격 유형 = ${GAP_LABEL[gap]}, 결합 = ${join ? '예' : '아니오'}, 원본 지우기 = ${erase ? '예' : '아니오'}, 틈 허용 = ${L(fuzz)}`);
    const r = await ctx.getPoint(`간격띄우기 거리 지정 또는 [통과점(T)/지우기(E)/도면층(L)/간격 유형(G)/결합(J)/틈 허용(F)] <${through ? '통과점' : L(distance)}>:`, {
      preferNumber: true,
      keywords: [
        { key: 'T', label: '통과점' },
        { key: 'E', label: '지우기' },
        { key: 'L', label: '도면층' },
        { key: 'G', label: '간격 유형' },
        { key: 'J', label: '결합' },
        { key: 'F', label: '틈 허용' },
      ],
    });
    if ('enter' in r) break;
    if ('keyword' in r) {
      switch (r.keyword) {
        case 'T':
          through = true;
          break;
        case 'E':
          erase = await yesNo(ctx, '간격띄우기 후 원본 객체를 지우시겠습니까?', erase);
          break;
        case 'L': {
          const k = await choose(ctx, `간격띄우기 객체에 대한 도면층 옵션 입력 [현재(C)/원본(S)] <${layerCurrent ? '현재' : '원본'}>:`, [
            { key: 'C', label: '현재' },
            { key: 'S', label: '원본' },
          ], layerCurrent ? 'C' : 'S');
          layerCurrent = k === 'C';
          break;
        }
        case 'G': {
          const k = await choose(ctx, `간격 유형 입력 [보통(N)/모깎기(F)/모따기(C)] <${GAP_LABEL[gap]}>:`, [
            { key: 'N', label: '보통' },
            { key: 'F', label: '모깎기' },
            { key: 'C', label: '모따기' },
          ], gap);
          gap = k as GapType;
          break;
        }
        case 'J':
          join = await yesNo(ctx, '이어진 객체의 간격띄우기 결과를 한 폴리선으로 결합하겠습니까?', join);
          break;
        case 'F': {
          const v = await askNumber(ctx, '이어 붙일 때 무시할 틈 거리 입력', fuzz, { min: 0 });
          if (typeof v === 'number') fuzz = v;
          break;
        }
      }
      if (r.keyword === 'T') break;
      continue;
    }
    if ('point' in r) {
      const p2 = await ctx.getPoint('두 번째 점 지정:', { base: r.point });
      if (!('point' in p2)) return;
      distance = Math.hypot(p2.point.x - r.point.x, p2.point.y - r.point.y);
    } else if ('text' in r) {
      const v = Number(r.text);
      if (!(v > 0)) {
        ctx.print('0보다 큰 값을 입력하십시오.', 'err');
        continue;
      }
      distance = v;
    }
    if (!(distance > 0)) continue;
    through = false;
    break;
  }
  Object.assign(m, { exoDist: through ? -1 : distance, exoLayer: layerCurrent ? 'C' : 'S', exoGap: gap, exoJoin: join, exoErase: erase, exoFuzz: fuzz });
  const clayer = String(doc.header.get('$CLAYER') ?? '0');
  const steps: number[] = [];
  for (;;) {
    let hs: string[];
    try {
      hs = unlockedOnly(app, await ctx.getSelection(steps.length ? '간격띄우기할 객체 선택 또는 [명령 취소(U)] <종료>:' : '간격띄우기할 객체 선택:', { keywords: [{ key: 'U', label: '명령 취소' }], noPickfirst: steps.length > 0 }));
    } catch (err) {
      if ((err as { keyword?: string }).keyword !== 'U') throw err;
      undoStep(app, ctx, steps);
      continue;
    }
    const list = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
    app.clearSelection();
    if (!list.length) return;
    const chains = chainsOf(list, fuzz);
    if (chains.some((c) => c.joined)) ctx.print(`이어진 객체를 묶어 ${chains.length}개 줄로 간격띄웁니다.`);
    const make = (side: Pt, both: boolean): { add: Entity[]; messages: string[] } => {
      const add: Entity[] = [];
      const messages: string[] = [];
      const one = (c: Chain, s: Pt) => {
        const d = through ? chainDistance(c, side) : distance;
        if (!(d > 1e-12)) return;
        const r = offsetChain(c, d, s, { gap, join, fuzz }, doc);
        if (!r.add.length && r.message) messages.push(r.message);
        if (layerCurrent) for (const x of r.add) x.layer = clayer;
        add.push(...r.add);
      };
      for (const c of chains) {
        one(c, side);
        if (both) {
          const o = oppositeSide(c, side);
          if (o) one(c, o);
        }
      }
      return { add, messages };
    };
    const q = await ctx.getPoint(`${through ? '통과점' : '간격띄우기할 면의 점'} 지정 또는 [양쪽(B)]:`, {
      keywords: [{ key: 'B', label: '양쪽' }],
      ghost: (p) => {
        try {
          return previewOf(app, make(p, false).add);
        } catch {
          return [];
        }
      },
    });
    let side: Pt;
    let both = false;
    if ('keyword' in q) {
      const q2 = await ctx.getPoint('간격띄우기할 면의 점 지정(반대쪽에도 같은 거리로 만듭니다):', {
        ghost: (p) => {
          try {
            return previewOf(app, make(p, true).add);
          } catch {
            return [];
          }
        },
      });
      if (!('point' in q2)) return;
      side = q2.point;
      both = true;
    } else if ('point' in q) side = q.point;
    else return;
    const res = make(side, both);
    if (!res.add.length) {
      ctx.print(res.messages[0] ?? '고른 객체를 간격띄우기할 수 없습니다.', 'err');
      continue;
    }
    const a = commitResults(app, ctx, [{ add: res.add, ...(erase ? { remove: unlockedOnly(app, list.map((e) => e.handle)) } : {}) }], 'EXOFFSET', { quiet: true });
    steps.push(a.ops);
    ctx.print(`객체 ${a.added.length}개를 만들었습니다.`);
  }
}

// ---------------------------------------------------------------------------
// FLATTEN
// ---------------------------------------------------------------------------

async function runFlatten(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const hs = unlockedOnly(app, await ctx.getSelection('2D로 변환할 객체 선택:'));
  if (!hs.length) return;
  const hide = await yesNo(ctx, '숨은선을 제거하겠습니까?', false);
  if (hide) ctx.print('숨은선 제거는 3D 뷰가 없는 이 웹 버전에서 쓸 수 없습니다. 숨은선을 남긴 채 평면화합니다.', 'err');
  const replace: Entity[] = [];
  const skipped = new Map<string, number>();
  for (const h of hs) {
    const e = doc.entityIndex.get(h);
    if (!e) continue;
    const r = flattenEntity(e, doc);
    if (!r) continue;
    if ('skip' in r) skipped.set(r.skip, (skipped.get(r.skip) ?? 0) + 1);
    else replace.push(r.entity);
  }
  if (replace.length) commitResults(app, ctx, [{ replace }], 'FLATTEN', { quiet: true });
  app.clearSelection();
  ctx.print(replace.length ? `객체 ${replace.length}개를 평면화했습니다(Z·고도·두께 = 0).` : '바꿀 객체가 없습니다(이미 평면입니다).');
  if (skipped.size) ctx.print(`건너뜀: ${[...skipped].map(([k, n]) => `${k} ${n}개`).join(', ')}`, 'err');
}

// ---------------------------------------------------------------------------
// CDORDER
// ---------------------------------------------------------------------------

let cdOrder: string[] = [];
let cdPlace: 'F' | 'B' = 'F';

function cdorderDialog(colors: string[], place: 'F' | 'B'): Promise<{ order: string[]; place: 'F' | 'B' } | null> {
  return new Promise((resolve) => {
    let done = false;
    const order = [...colors];
    let pick = 0;
    const list = h('div', { style: 'display:flex;flex-direction:column;gap:2px;max-height:50vh;overflow:auto;border:1px solid var(--border, #555);padding:4px;min-width:260px' });
    const render = () => {
      list.replaceChildren(
        ...order.map((k, i) =>
          h(
            'div',
            {
              role: 'option',
              'aria-selected': String(i === pick),
              style: `padding:3px 6px;cursor:pointer;${i === pick ? 'background:var(--accent, #2d6cdf);color:#fff' : ''}`,
              onclick: () => {
                pick = i;
                render();
              },
            },
            `${i + 1}. ${colorKeyLabel(k)}`,
          ),
        ),
      );
    };
    const move = (d: number) => {
      const j = pick + d;
      if (j < 0 || j >= order.length) return;
      [order[pick], order[j]] = [order[j]!, order[pick]!];
      pick = j;
      render();
    };
    const sel = h('select', { 'aria-label': '고른 객체를 놓을 자리' }, h('option', { value: 'F' }, '다른 객체의 맨 앞으로'), h('option', { value: 'B' }, '다른 객체의 맨 뒤로')) as HTMLSelectElement;
    sel.value = place;
    render();
    const body = h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:8px' },
      h('div', { style: 'color:var(--text-dim)' }, '위에 있는 색이 앞(위)에 그려집니다. 색을 고르고 위로·아래로 옮기십시오.'),
      h('div', { style: 'display:flex;gap:8px;align-items:flex-start' }, list, h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, h('button', { class: 'btn', onclick: () => move(-1) }, '위로'), h('button', { class: 'btn', onclick: () => move(1) }, '아래로'))),
      h('label', { class: 'form-row' }, h('span', {}, '그리기 순서'), sel),
    );
    const back = dialog('CDORDER - 색상별 그리기 순서', body, [
      { label: '취소' },
      {
        label: '확인',
        primary: true,
        run: () => {
          done = true;
          resolve({ order, place: sel.value === 'B' ? 'B' : 'F' });
        },
      },
    ]);
    void whenClosed(back).then(() => {
      if (!done) resolve(null);
    });
  });
}

async function runCdorder(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  let hs = unlockedOnly(app, await ctx.getSelection('객체 선택(Enter = 지금 공간의 모든 객체):'));
  if (!hs.length) hs = unlockedOnly(app, (doc.blocks.get(st.space)?.entities ?? []).map((e) => e.handle));
  const ents = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
  if (!ents.length) return;
  const found = colorsOf(ents, doc);
  // 지난번 순서를 먼저, 새 색은 뒤에
  const colors = [...cdOrder.filter((k) => found.includes(k)), ...found.filter((k) => !cdOrder.includes(k))];
  const v = await cdorderDialog(colors, cdPlace);
  if (!v) return;
  cdOrder = v.order;
  cdPlace = v.place;
  const sel = new Set(hs);
  const ops: EditOp[] = [];
  let moved = 0;
  const byBlock = new Map<string, string[]>();
  for (const h of hs) {
    const b = st.session.ownerOf(h);
    if (!b) continue;
    const l = byBlock.get(b) ?? [];
    l.push(h);
    byBlock.set(b, l);
  }
  for (const [bk] of byBlock) {
    const block = doc.blocks.get(bk);
    if (!block) continue;
    const next = cdorderList(block.entities, sel, (e) => displayColorKey(e, doc), v.order, v.place);
    if (!next) continue;
    ops.push(...reorderOps(bk, block.entities, sel, next, v.place));
    moved += block.entities.filter((e) => sel.has(e.handle)).length;
  }
  if (ops.length) st.session.commit({ label: 'CDORDER', ops, group: ctx.group, rebuildNow: true });
  app.clearSelection();
  ctx.print(moved ? `객체 ${moved}개를 색상 순서(${v.order.map(colorKeyLabel).join(' > ')})로 ${v.place === 'F' ? '맨 앞에' : '맨 뒤에'} 놓았습니다.` : '바꿀 것이 없습니다.');
}

// ---------------------------------------------------------------------------
// MKLTYPE
// ---------------------------------------------------------------------------

async function runMkltype(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  ctx.print('이 웹 버전은 .lin 파일을 고를 수 없어, 만든 선종류를 도면에 넣고 "이름.lin" 파일로 내려받습니다.');
  let name = '';
  for (;;) {
    const n = await askString(ctx, '선종류 이름 입력:');
    if (typeof n !== 'string') continue;
    if (!n.trim()) return;
    const p = linetypeNameProblem(n);
    if (p) {
      ctx.print(p, 'err');
      continue;
    }
    name = n.trim();
    break;
  }
  const existing = doc.linetypes.get(tableKey(name));
  if (existing && !(await yesNo(ctx, `선종류 "${existing.name}"이(가) 이미 있습니다. 다시 정의하겠습니까?`, false))) return;
  const d = await askString(ctx, '선종류 설명 입력:', '');
  const description = typeof d === 'string' ? d.replace(/[\r\n]/g, ' ').trim() : '';
  const a = await ctx.getPoint('선종류 정의의 시작점 지정:');
  if (!('point' in a)) return;
  const b = await ctx.getPoint('선종류 정의의 끝점 지정:', { base: a.point });
  if (!('point' in b)) return;
  const hs = await ctx.getSelection('객체 선택:', { noPickfirst: true });
  const ents = hs.map((h) => doc.entityIndex.get(h)).filter((e): e is Entity => !!e);
  const r = linetypeFromObjects({ start: a.point, end: b.point }, ents, doc);
  app.clearSelection();
  if (typeof r === 'string') {
    ctx.print(r, 'err');
    return;
  }
  const rec = makeLinetypeRecord(existing?.name ?? name, description, r.elements, r.patternLength, existing?.handle ?? st.session.newHandle());
  if (existing) {
    rec.flags = existing.flags;
    if (existing.xdata) rec.xdata = existing.xdata;
  }
  st.session.commit({ label: 'MKLTYPE', ops: [{ kind: 'linetype', key: tableKey(name), before: existing ?? null, after: rec }], group: ctx.group });
  const text = linFileText(rec.name, description, r.pattern);
  download(new Blob([text], { type: 'text/plain' }), `${rec.name}.lin`);
  ctx.print(`선종류 "${rec.name}"을(를) ${existing ? '다시 정의했습니다' : '만들었습니다'}: ${r.pattern}`);
  ctx.print(`${rec.name}.lin 파일을 내려받았습니다.`);
}

// ---------------------------------------------------------------------------
// SHOWURLS
// ---------------------------------------------------------------------------

interface UrlRow {
  handle: string;
  space: string;
  type: string;
  link: Hyperlink;
}

function urlRows(app: App): UrlRow[] {
  const st = app.active!;
  const out: UrlRow[] = [];
  for (const lay of st.doc.layouts) {
    const key = tableKey(lay.blockName);
    for (const e of st.doc.blocks.get(key)?.entities ?? []) {
      const l = readHyperlink(e);
      if (l) out.push({ handle: e.handle, space: key, type: e.type, link: l });
    }
  }
  return out;
}

async function runShowurls(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const rows = urlRows(app);
  if (!rows.length) {
    ctx.print('이 도면에는 하이퍼링크가 있는 객체가 없습니다.');
    return;
  }
  let edits = 0;
  const setLink = (h: string, link: Hyperlink | null) => {
    const e = doc.entityIndex.get(h);
    const block = e ? st.session.ownerOf(h) : null;
    if (!e || !block) return false;
    if (!unlockedOnly(app, [h]).length) return false;
    const after = { ...structuredClone(e), xdata: withHyperlink(e.xdata, link) } as Entity;
    if (!after.xdata) delete after.xdata;
    st.session.commit({ label: 'SHOWURLS', ops: [{ kind: 'modify', block, before: e, after }], group: ctx.group });
    edits++;
    return true;
  };
  let zoomTo: string | null = null;
  const tbody = h('tbody', {});
  const back = { el: null as HTMLElement | null };
  const render = () => {
    const list = urlRows(app);
    tbody.replaceChildren(
      ...list.map((r) =>
        h(
          'tr',
          {},
          h('td', { style: 'font-family:var(--mono)' }, r.handle),
          h('td', {}, r.link.url || (r.link.location ? `#${r.link.location}` : '')),
          h('td', { style: 'color:var(--text-dim)' }, r.link.description),
          h(
            'td',
            { style: 'white-space:nowrap' },
            h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  zoomTo = r.handle;
                  back.el?.remove();
                },
              },
              '보기',
            ),
            h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  const v = await form('URL 편집', [
                    { key: 'url', label: '파일 또는 웹 페이지 이름', type: 'text', value: r.link.url, wide: true },
                    { key: 'description', label: '표시할 문자', type: 'text', value: r.link.description, wide: true },
                  ]);
                  if (!v) return;
                  const link: Hyperlink = { url: String(v.url).trim(), description: String(v.description).trim(), location: r.link.location };
                  if (!setLink(r.handle, link.url || link.location ? link : null)) ctx.print('잠긴 도면층의 객체는 고칠 수 없습니다.', 'err');
                  render();
                },
              },
              '편집',
            ),
          ),
        ),
      ),
    );
  };
  render();
  const body = h(
    'div',
    {},
    h('p', { style: 'margin:0 0 6px;color:var(--text-dim)' }, '보기: 그 객체로 확대하고 고릅니다. 편집: 주소와 표시할 문자를 고칩니다. 바꾸기: 모든 주소에서 문자열을 찾아 바꿉니다.'),
    h('div', { style: 'max-height:55vh;overflow:auto' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '핸들'), h('th', {}, 'URL'), h('th', {}, '설명'), h('th', {}, ''))), tbody)),
  );
  back.el = dialog('SHOWURLS - 하이퍼링크', body, [
    {
      label: '바꾸기…',
      run: () => {
        void (async () => {
          const v = await form('URL 바꾸기', [
            { key: 'find', label: '찾을 문자열', type: 'text', value: '' },
            { key: 'rep', label: '바꿀 문자열', type: 'text', value: '' },
          ]);
          if (!v || !String(v.find)) return;
          let n = 0;
          for (const r of urlRows(app)) {
            const url = r.link.url.split(String(v.find)).join(String(v.rep));
            if (url !== r.link.url && setLink(r.handle, { ...r.link, url })) n++;
          }
          ctx.print(`URL ${n}개를 바꿨습니다.`);
          render();
        })();
        return true;
      },
    },
    { label: '닫기', primary: true },
  ]);
  await whenClosed(back.el);
  if (edits) ctx.print(`하이퍼링크 ${edits}개를 고쳤습니다.`);
  const target = zoomTo as string | null;
  if (target) {
    const e = doc.entityIndex.get(target);
    const space = st.session.ownerOf(target);
    if (!e || !space) return;
    if (space !== st.space) await app.setSpace(space);
    const b = entityBounds(e, doc);
    if (b) {
      const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.5 || 1;
      app.view.zoomRect(b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad, true);
    }
    app.setSelection([target], 'replace');
    const l = readHyperlink(e);
    if (l) ctx.print(`${l.url || `#${l.location}`}${l.description ? ` (${l.description})` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// REDIR
// ---------------------------------------------------------------------------

let redirMode: RedirMode = { ...REDIR_DEFAULT };

async function runRedir(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  let oldDir = '';
  for (;;) {
    ctx.print(`현재 REDIRMODE: ${redirModeText(redirMode)}`);
    ctx.print('폴더 이름 찾아 바꾸기');
    const o = await askString(ctx, "옛 폴더 입력(모두는 '*') 또는 ?(옵션):");
    if (typeof o !== 'string') continue;
    const t = o.trim();
    if (!t) return;
    if (t === '?') {
      for (;;) {
        const k = await choose(ctx, `바꿀 객체 유형 켜고 끄기 [스타일(S)/외부 참조(X)/이미지(I)/RTEXT(R)/목록(L)] <완료>:`, [
          { key: 'S', label: '스타일' },
          { key: 'X', label: '외부 참조' },
          { key: 'I', label: '이미지' },
          { key: 'R', label: 'RTEXT' },
          { key: 'L', label: '목록' },
        ], '');
        if (!k) break;
        if (k === 'L') {
          const list = redirList(doc, redirMode);
          if (!list.length) ctx.print('바꿀 수 있는 경로가 없습니다.');
          for (const x of list) ctx.print(`  ${x.kind === 'xref' ? '외부 참조' : x.kind === 'image' ? '이미지' : '스타일'} ${x.name}: ${x.before}`);
          continue;
        }
        const key = ({ S: 'styles', X: 'xrefs', I: 'images', R: 'rtext' } as const)[k as 'S' | 'X' | 'I' | 'R'];
        redirMode = { ...redirMode, [key]: !redirMode[key] };
        ctx.print(`현재 REDIRMODE: ${redirModeText(redirMode)}`);
      }
      continue;
    }
    oldDir = t;
    break;
  }
  const n = await askString(ctx, `"${oldDir}"을(를) 무엇으로 바꾸겠습니까:`, '');
  if (typeof n !== 'string') return;
  const { ops, changes } = redirOps(doc, oldDir, n.trim(), redirMode);
  if (redirMode.rtext) ctx.print('참고: RTEXT 객체는 이 웹 버전에서 읽지 않아 바꾸지 않습니다.');
  if (!ops.length) {
    ctx.print(oldDir === '*' ? '바꿀 경로가 없습니다.' : `"${oldDir}"이(가) 들어간 경로가 없습니다.`);
    return;
  }
  st.session.commit({ label: 'REDIR', ops, group: ctx.group });
  for (const c of changes) ctx.print(`  ${c.kind === 'xref' ? '외부 참조' : c.kind === 'image' ? '이미지' : '스타일'} ${c.name}: ${c.before} → ${c.after}`);
  const cnt = (k: string) => changes.filter((c) => c.kind === k).length;
  ctx.print(`외부 참조 ${cnt('xref')}개, 이미지 ${cnt('image')}개, 스타일 글꼴 ${cnt('style')}개의 경로를 바꿨습니다. 브라우저는 파일을 이름으로 다시 연결하므로 화면은 그대로입니다.`);
}

// ---------------------------------------------------------------------------

export function registerExpressDrawCommands(app: App, add: (c: Command) => void = (c) => app.register(c)): void {
  add({ name: 'BREAKLINE', title: '끊기선 기호', run: (ctx) => runBreakline(app, ctx) });
  add({ name: 'MPEDIT', title: '여러 폴리선 편집', run: (ctx) => runMpedit(app, ctx) });
  add({ name: 'EXOFFSET', title: '간격띄우기 확장', run: (ctx) => runExoffset(app, ctx) });
  add({ name: 'FLATTEN', title: '평면화(Z = 0)', run: (ctx) => runFlatten(app, ctx) });
  add({ name: 'CDORDER', title: '색상별 그리기 순서', run: (ctx) => runCdorder(app, ctx) });
  add({ name: 'MKLTYPE', title: '선종류 만들기', run: (ctx) => runMkltype(app, ctx) });
  add({ name: 'SHOWURLS', title: '하이퍼링크 목록', run: (ctx) => runShowurls(app, ctx) });
  add({ name: 'REDIR', title: '경로 바꾸기', run: (ctx) => runRedir(app, ctx) });
}
