/**
 * 블록 명령(util2): BATTMAN(블록 속성 관리자), ATTSYNC, BCOUNT, BURST, BLOCKREPLACE, MINSERT, WBLOCK
 * 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import type { AttribEntity, BlockDef, BlockRecord, Entity, InsertEntity, Vec3 } from '../core/model';
import { entityDefaults, tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { cloneEntity } from '../edit/session';
import { boundsOf } from '../edit/geom/query';
import type { EditResult } from '../edit/geom/types';
import {
  allAttdefs,
  attdefsOf,
  buildAttribs,
  burstInsert,
  countBlocks,
  insertsOf,
  purgeBlockOps,
  replaceBlockOps,
  syncAllOps,
  withAttdefs,
} from '../edit/util/blockutil';
import { buildWblockDocument, type WblockSource } from '../edit/util/wblock';
import type { App, CommandContext } from './app';
import { userBlocks } from './blocks';
import { addEntities, currentProps } from './draw';
import { baseName, download } from './export';
import { unlockedOnly } from './layers';
import { commitResults } from './modify';
import { SAVE_TYPES } from './save';
import { form, h } from './ui/dom';
import type { Pt } from './view';
import { askInt, askKeyword, askYesNo, button, checkbox, modal, padWide, rememberErased, select, textWidth } from './util2-ui';

const BAD_BLOCK_NAME = /[<>/\\":;?*|,=`]/;

/** 속성 정의가 있는(편집 가능한) 블록 */
function attributedBlocks(app: App): BlockDef[] {
  return userBlocks(app).filter((b) => b.entities.some((e) => e.type === 'ATTDEF'));
}

function modeText(a: AttribEntity): string {
  return `${a.attFlags & 1 ? 'I' : ''}${a.attFlags & 2 ? 'C' : ''}${a.attFlags & 4 ? 'V' : ''}${a.attFlags & 8 ? 'P' : ''}${a.lockPosition ? 'L' : ''}`;
}

const INSUNITS_OPTIONS: { value: string; label: string }[] = [
  [0, '단위 없음'],
  [1, '인치'],
  [2, '피트'],
  [3, '마일'],
  [4, '밀리미터'],
  [5, '센티미터'],
  [6, '미터'],
  [7, '킬로미터'],
  [10, '야드'],
].map(([v, l]) => ({ value: String(v), label: String(l) }));

export function registerUtil2BlockCommands(app: App): void {
  // ------------------------------------------------------------- BATTMAN
  app.register({
    name: 'BATTMAN',
    title: '블록 속성 관리자',
    async run(ctx) {
      const st = app.active!;
      const blocks = attributedBlocks(app);
      if (!blocks.length) {
        ctx.print('이 도면에는 속성이 있는 블록 정의가 없습니다.', 'err');
        return;
      }
      const picked = [...st.selection].map((x) => st.doc.entityIndex.get(x)).find((e): e is InsertEntity => e?.type === 'INSERT' && blocks.some((b) => tableKey(b.name) === tableKey(e.block)));
      let cur = picked ? tableKey(picked.block) : tableKey(blocks[0]!.name);
      /** 블록 키 → 편집 중인 속성 정의(복제본, 순서대로) */
      const work = new Map<string, AttribEntity[]>();
      const dirty = new Set<string>();
      const listOf = (k: string): AttribEntity[] => {
        let w = work.get(k);
        if (!w) {
          w = allAttdefs(st.doc.blocks.get(k)!).map((a) => cloneEntity(a));
          work.set(k, w);
        }
        return w;
      };
      let row = 0;
      const where = h('span', { class: 'u2-note' });
      const tbody = h('tbody');
      const table = h('table', { class: 'u2-table' }, h('thead', {}, h('tr', {}, h('th', {}, '태그'), h('th', {}, '프롬프트'), h('th', {}, '기본값'), h('th', {}, '모드'))), tbody);
      const err = h('div', { class: 'u2-err' });
      const applyRefs = checkbox('기존 참조에 변경 사항 적용', true);
      const render = () => {
        const list = listOf(cur);
        row = Math.max(0, Math.min(row, list.length - 1));
        tbody.innerHTML = '';
        list.forEach((a, i) => {
          const tr = h('tr', { class: i === row ? 'sel' : '' }, h('td', {}, a.tag), h('td', {}, a.prompt ?? ''), h('td', {}, a.text), h('td', {}, modeText(a)));
          tr.addEventListener('click', () => {
            row = i;
            render();
          });
          tr.addEventListener('dblclick', () => {
            row = i;
            void edit();
          });
          tbody.append(tr);
        });
        const refs = insertsOf(st.doc, cur);
        const here = refs.filter((r) => r.block === st.space).length;
        where.textContent = `찾은 위치: 도면 ${refs.length}개, 지금 공간 ${here}개`;
      };
      const edit = async () => {
        const list = listOf(cur);
        const a = list[row];
        if (!a) return;
        const v = await form(
          `속성 편집 — ${st.doc.blocks.get(cur)!.name}`,
          [
            { key: 'tag', label: '태그', type: 'text', value: a.tag },
            { key: 'prompt', label: '프롬프트', type: 'text', value: a.prompt ?? '' },
            { key: 'text', label: '기본값', type: 'text', value: a.text },
            { key: 'i', label: '보이지 않음', type: 'check', value: !!(a.attFlags & 1) },
            { key: 'c', label: '상수', type: 'check', value: !!(a.attFlags & 2) },
            { key: 'v', label: '확인', type: 'check', value: !!(a.attFlags & 4) },
            { key: 'p', label: '미리 설정', type: 'check', value: !!(a.attFlags & 8) },
            { key: 'l', label: '위치 잠금', type: 'check', value: !!a.lockPosition },
          ],
          {
            validate: (x) => {
              const t = String(x.tag).trim();
              if (!t) return '태그를 입력하십시오.';
              if (/\s/.test(t)) return '태그에는 빈칸을 쓸 수 없습니다.';
              if (list.some((o, i) => i !== row && o.tag.toUpperCase() === t.toUpperCase())) return `태그 ${t.toUpperCase()}이(가) 이미 있습니다.`;
              return null;
            },
          },
        );
        if (!v) return;
        const n = cloneEntity(a);
        n.tag = String(v.tag).trim().toUpperCase();
        n.prompt = String(v.prompt) || undefined;
        n.text = String(v.text);
        if (n.mtext) n.mtext.text = String(v.text);
        n.attFlags = (v.i ? 1 : 0) | (v.c ? 2 : 0) | (v.v ? 4 : 0) | (v.p ? 8 : 0);
        n.lockPosition = v.l ? true : undefined;
        delete n.dwgRaw;
        list[row] = n;
        dirty.add(cur);
        render();
      };
      const move = (d: number) => {
        const list = listOf(cur);
        const j = row + d;
        if (j < 0 || j >= list.length) return;
        [list[row], list[j]] = [list[j]!, list[row]!];
        row = j;
        dirty.add(cur);
        render();
      };
      const remove = () => {
        const list = listOf(cur);
        if (!list[row]) return;
        if (list.length <= 1) {
          err.textContent = '블록에는 속성 정의가 하나 이상 남아 있어야 합니다.';
          return;
        }
        list.splice(row, 1);
        dirty.add(cur);
        render();
      };
      /** keys의 변경을 정의에 넣고(sync면 참조도 맞춘다) 한 단계로 기록한다 */
      const commit = (keys: string[], sync: boolean): number => {
        const ops: EditOp[] = [];
        let refs = 0;
        for (const k of keys) {
          const before = st.doc.blocks.get(k);
          if (!before) continue;
          let def = before;
          if (dirty.has(k)) {
            def = withAttdefs(before, listOf(k));
            ops.push({ kind: 'blockDef', key: k, before, after: def });
          }
          if (sync) {
            const r = syncAllOps(st.doc, k, () => st.session.newHandle(), def);
            ops.push(...r.ops);
            refs += r.ops.length;
            if (r.locked) ctx.print(`잠긴 도면층의 참조 ${r.locked}개는 건너뛰었습니다.`);
          }
        }
        if (ops.length) {
          st.session.commit({ label: 'BATTMAN', ops, group: ctx.group });
          const names = keys.map((k) => st.doc.blocks.get(k)?.name ?? k).join(', ');
          ctx.print(`블록 ${names}의 속성 정의를 고쳤습니다${sync ? `(참조 ${refs}개 동기화)` : ''}.`);
        }
        for (const k of keys) {
          dirty.delete(k);
          work.delete(k);
        }
        return refs;
      };
      const blockSel = select(
        blocks.map((b) => ({ value: tableKey(b.name), label: b.name })),
        cur,
        (v) => {
          cur = v;
          row = 0;
          err.textContent = '';
          render();
        },
      );
      const body = h(
        'div',
        {},
        h('div', { class: 'u2-row' }, h('span', {}, '블록:'), blockSel, where),
        h(
          'div',
          { class: 'u2-side' },
          h('div', { class: 'u2-list', style: 'max-height:320px' }, table),
          h(
            'div',
            { class: 'u2-col' },
            button('동기화(Y)', () => {
              const n = commit([cur], true);
              ctx.print(`블록 ${st.doc.blocks.get(cur)?.name}의 참조 ${n}개를 동기화했습니다.`);
              render();
            }),
            button('위로 이동(U)', () => move(-1)),
            button('아래로 이동(D)', () => move(1)),
            button('편집(E)...', () => void edit()),
            button('제거(R)', remove),
          ),
        ),
        h('div', { class: 'u2-row', style: 'margin-top:8px' }, applyRefs.el),
        h('div', { class: 'u2-note' }, '모드: I 보이지 않음, C 상수, V 확인, P 미리 설정, L 위치 잠금. 동기화는 속성 값을 지키고 위치·특성을 정의에 맞춥니다.'),
        err,
      );
      render();
      const m = modal<'ok'>(
        '블록 속성 관리자',
        body,
        [
          {
            label: '적용(A)',
            value: () => {
              commit([...dirty], applyRefs.box.checked);
              render();
              return undefined;
            },
          },
          { label: '취소', value: 'ok' as const },
          {
            label: '확인',
            primary: true,
            value: () => {
              commit([...dirty], applyRefs.box.checked);
              return 'ok';
            },
          },
        ],
        'wide',
      );
      await m.done;
    },
  });

  // ------------------------------------------------------------- ATTSYNC
  app.register({
    name: 'ATTSYNC',
    title: '속성 동기화',
    async run(ctx) {
      const st = app.active!;
      let name: string | null = null;
      while (!name) {
        const r = await askKeyword(
          ctx,
          '옵션 입력 [?/이름(N)/선택(S)] <선택>:',
          [
            { key: '?', label: '?' },
            { key: 'N', label: '이름' },
            { key: 'S', label: '선택' },
          ],
          'S',
        );
        if (r === '?') {
          const list = attributedBlocks(app).map((b) => b.name);
          ctx.print(list.length ? `속성이 있는 블록: ${list.join(', ')}` : '속성이 있는 블록이 없습니다.', 'res');
          continue;
        }
        if (r === 'N' || (typeof r === 'object' && r)) {
          let n = typeof r === 'object' && r ? r.text : '';
          if (!n) {
            const t = await ctx.getPoint('블록 이름 입력:', { allowText: true });
            if (!('text' in t)) return;
            n = t.text.trim();
          }
          const def = st.doc.blocks.get(tableKey(n));
          if (!def) {
            ctx.print(`블록 "${n}"을(를) 찾을 수 없습니다.`, 'err');
            continue;
          }
          name = def.name;
          break;
        }
        const e = await ctx.getEntity('블록 선택:');
        if (!('handle' in e)) return;
        const ent = st.doc.entityIndex.get(e.handle);
        if (ent?.type !== 'INSERT') {
          ctx.print('블록 참조가 아닙니다.', 'err');
          continue;
        }
        name = st.doc.blocks.get(tableKey(ent.block))?.name ?? ent.block;
      }
      const def = st.doc.blocks.get(tableKey(name))!;
      if (!def.entities.some((e) => e.type === 'ATTDEF')) {
        ctx.print(`블록 ${name}에는 속성 정의가 없습니다.`, 'err');
        return;
      }
      if (!(await askYesNo(ctx, `ATTSYNC 블록 ${name}?`, true))) return;
      const r = syncAllOps(st.doc, name, () => st.session.newHandle());
      if (r.ops.length) st.session.commit({ label: 'ATTSYNC', ops: r.ops, group: ctx.group });
      if (r.locked) ctx.print(`잠긴 도면층의 참조 ${r.locked}개는 건너뛰었습니다.`);
      ctx.print(`ATTSYNC 완료: 블록 ${name}의 참조 ${r.count}개(바뀐 참조 ${r.ops.length}개).`);
    },
  });

  // ------------------------------------------------------------- BCOUNT
  app.register({
    name: 'BCOUNT',
    title: '블록 개수',
    async run(ctx) {
      const st = app.active!;
      let hs = await ctx.getSelection('객체 선택 <전체 공간>:');
      let scope = '선택한 객체';
      if (!hs.length) {
        hs = (st.doc.blocks.get(st.space)?.entities ?? []).map((e) => e.handle);
        scope = '지금 공간 전체';
      }
      const ents = hs.map((x) => st.doc.entityIndex.get(x)).filter((e): e is Entity => !!e);
      const rows = countBlocks(st.doc, ents, true);
      app.clearSelection();
      if (!rows.length) {
        ctx.print(`${scope}에 블록 참조가 없습니다.`);
        return;
      }
      const w = Math.max(16, ...rows.map((r) => textWidth(r.name) + 2));
      ctx.print(`블록${'.'.repeat(Math.max(2, w - 4))}${'개수'.padStart(4)} (${scope}, 중첩 포함)`, 'res');
      ctx.print('-'.repeat(w + 6), 'res');
      for (const r of rows) ctx.print(`${padWide(r.name, w)}${String(r.count).padStart(6)}`, 'res');
    },
  });

  // ------------------------------------------------------------- BURST
  app.register({
    name: 'BURST',
    title: '분해(속성 값 유지)',
    async run(ctx) {
      const st = app.active!;
      const hs = unlockedOnly(app, await ctx.getSelection('객체 선택:'));
      if (!hs.length) return;
      const results: EditResult[] = [];
      let notBlock = 0;
      let fail = 0;
      for (const x of hs) {
        const e = st.doc.entityIndex.get(x);
        if (e?.type !== 'INSERT') {
          notBlock++;
          continue;
        }
        const r = burstInsert(e, st.doc);
        if (!r.add?.length) {
          fail++;
          if (r.message) ctx.print(r.message, 'err');
          continue;
        }
        results.push({ ...r, message: undefined });
      }
      st.selection.clear();
      if (!results.length) {
        ctx.print(notBlock ? '블록 참조가 선택되지 않았습니다.' : '분해할 수 있는 블록이 없습니다.', 'err');
        return;
      }
      const a = commitResults(app, ctx, results, 'BURST');
      ctx.print(`블록 ${results.length}개를 분해해 객체 ${a.added.length}개를 만들었습니다(속성은 값 문자로).${notBlock ? ` 블록이 아닌 객체 ${notBlock}개는 건너뛰었습니다.` : ''}${fail ? ` ${fail}개는 분해할 수 없습니다.` : ''}`);
      app.setSelection(a.added.slice(0, 5000));
    },
  });

  // ------------------------------------------------------------- BLOCKREPLACE
  app.register({
    name: 'BLOCKREPLACE',
    title: '블록 대치',
    async run(ctx) {
      const st = app.active!;
      const blocks = userBlocks(app);
      if (blocks.length < 2) {
        ctx.print('대치하려면 블록 정의가 둘 이상 있어야 합니다.', 'err');
        return;
      }
      const opts = blocks.map((b) => ({ value: b.name, label: `${b.name} (참조 ${insertsOf(st.doc, b.name).length}개)` }));
      const v = await form(
        '블록 대치',
        [
          { key: 'from', label: '대치할 블록', type: 'select', value: blocks[0]!.name, options: opts },
          { key: 'to', label: '다음으로 대치', type: 'select', value: blocks[1]!.name, options: opts },
          { key: 'purge', label: '참조되지 않은 블록 소거', type: 'check', value: true },
        ],
        { ok: '대치', validate: (x) => (x.from === x.to ? '같은 블록으로는 대치할 수 없습니다.' : null), note: '블록 안의 참조도 바뀝니다. 같은 태그의 속성 값은 지킵니다.' },
      );
      if (!v) return;
      const from = String(v.from);
      const to = String(v.to);
      const r = replaceBlockOps(st.doc, from, to, () => st.session.newHandle());
      if (!r.count) {
        ctx.print(r.skipped ? `블록 ${from}의 참조가 모두 ${to} 안에 있어 대치하면 자기 자신을 참조하게 됩니다.` : `블록 ${from}의 참조가 없습니다.`, 'err');
        return;
      }
      st.session.commit({ label: 'BLOCKREPLACE', ops: r.ops, group: ctx.group });
      let purged = false;
      if (v.purge) {
        const p = purgeBlockOps(st.doc, from);
        if (p.length) {
          st.session.commit({ label: 'BLOCKREPLACE', ops: p, group: ctx.group });
          purged = true;
        }
      }
      ctx.print(`블록 ${from}의 참조 ${r.count}개를 ${to}(으)로 대치했습니다.${r.skipped ? ` ${r.skipped}개는 자기 참조가 되어 건너뛰었습니다.` : ''}${purged ? ` 블록 ${from}을(를) 소거했습니다.` : ''}`);
    },
  });

  // ------------------------------------------------------------- MINSERT
  let lastMinsert = '';
  app.register({
    name: 'MINSERT',
    title: '다중 삽입',
    async run(ctx) {
      const st = app.active!;
      const blocks = userBlocks(app);
      if (!blocks.length) {
        ctx.print('이 도면에는 삽입할 블록이 없습니다. BLOCK 명령으로 먼저 만드십시오.', 'err');
        return;
      }
      let def: BlockDef | undefined;
      const defName = blocks.some((b) => b.name === lastMinsert) ? lastMinsert : '';
      while (!def) {
        const r = await ctx.getPoint(`블록 이름 입력 또는 [?]${defName ? ` <${defName}>` : ''}:`, { allowText: true });
        if ('enter' in r) {
          if (!defName) continue;
          def = st.doc.blocks.get(tableKey(defName));
          break;
        }
        if (!('text' in r)) continue;
        const t = r.text.trim();
        if (t === '?') {
          ctx.print(`블록: ${blocks.map((b) => b.name).join(', ')}`, 'res');
          continue;
        }
        def = st.doc.blocks.get(tableKey(t));
        if (!def || def.name.startsWith('*')) {
          ctx.print(`블록 "${t}"을(를) 찾을 수 없습니다.`, 'err');
          def = undefined;
        }
      }
      if (!def) return;
      const bd: BlockDef = def;
      lastMinsert = bd.name;
      const box = boundsOf(bd.entities, st.doc);
      let sx = 1;
      let sy = 1;
      let rot = 0;
      const outline = (p: Pt, scx: number, scy: number, r: number) => {
        if (!box) return [];
        const c = Math.cos(r);
        const s = Math.sin(r);
        const pts = [
          [box.minX, box.minY],
          [box.maxX, box.minY],
          [box.maxX, box.maxY],
          [box.minX, box.maxY],
        ].flatMap(([x, y]) => {
          const dx = (x! - bd.basePoint.x) * scx;
          const dy = (y! - bd.basePoint.y) * scy;
          return [p.x + dx * c - dy * s, p.y + dx * s + dy * c];
        });
        return [{ pts, closed: true, dashed: true }];
      };
      let ins: Pt | null = null;
      while (!ins) {
        const r = await ctx.getPoint('삽입점 지정 또는 [축척(S)/회전(R)]:', {
          keywords: [
            { key: 'S', label: '축척' },
            { key: 'R', label: '회전' },
          ],
          rubber: (p) => outline(p, sx, sy, rot),
        });
        if ('point' in r) ins = r.point;
        else if ('keyword' in r && r.keyword === 'S') {
          const v = await askNumber(ctx, '모든 축에 대한 축척 비율 지정 <1>:', 1, (x) => x !== 0);
          if (v !== null) sx = sy = v;
        } else if ('keyword' in r && r.keyword === 'R') {
          const v = await askNumber(ctx, '회전 각도 지정 <0>:', 0);
          if (v !== null) rot = (v * Math.PI) / 180;
        }
      }
      const p0 = ins;
      if (sx === 1 && sy === 1) {
        const rect = (p: Pt) => [{ pts: [p0.x, p0.y, p.x, p0.y, p.x, p.y, p0.x, p.y], closed: true, dashed: true }];
        let r = await ctx.getPoint('X 축척 비율 입력, 반대 구석 지정, 또는 [구석(C)/XYZ(XYZ)] <1>:', {
          base: p0,
          preferNumber: true,
          rubber: rect,
          keywords: [
            { key: 'C', label: '구석' },
            { key: 'XYZ', label: 'XYZ' },
          ],
        });
        if ('keyword' in r && r.keyword === 'C') r = await ctx.getPoint('반대 구석 지정:', { base: p0, rubber: rect });
        // 구석: 삽입점과 구석이 이루는 상자의 가로·세로가 X·Y 축척(AutoCAD와 같다)
        if ('point' in r) {
          sx = r.point.x - p0.x || 1;
          sy = r.point.y - p0.y || sx;
        } else {
          if ('text' in r && Number(r.text)) sx = Number(r.text);
          const y = await ctx.getPoint('Y 축척 비율 입력 <X 축척 비율 사용>:', { preferNumber: true });
          sy = 'text' in y && Number(y.text) ? Number(y.text) : sx;
        }
      }
      if (rot === 0) {
        const r = await ctx.getPoint('블록 회전 각도 지정 <0>:', { base: p0, preferNumber: true, rubber: (p) => outline(p0, sx, sy, Math.atan2(p.y - p0.y, p.x - p0.x)) });
        if ('text' in r && Number.isFinite(Number(r.text))) rot = (Number(r.text) * Math.PI) / 180;
        else if ('point' in r) rot = Math.atan2(r.point.y - p0.y, r.point.x - p0.x);
      }
      const rows = await askInt(ctx, '행 수 입력 (---)', 1, 1, 32767);
      const cols = await askInt(ctx, '열 수 입력 (|||)', 1, 1, 32767);
      let rowSp = 0;
      let colSp = 0;
      if (rows > 1 || cols > 1) {
        const first = rows > 1 ? '행 사이의 거리 입력 또는 단위 셀 지정 (---):' : '열 사이의 거리 지정 (|||):';
        for (;;) {
          const r = await ctx.getPoint(first, { preferNumber: true });
          if ('text' in r && Number.isFinite(Number(r.text))) {
            if (rows > 1) rowSp = Number(r.text);
            else colSp = Number(r.text);
            break;
          }
          if ('point' in r) {
            const a = r.point;
            const q = await ctx.getPoint('반대 구석 지정:', { base: a, rubber: (p) => [{ pts: [a.x, a.y, p.x, a.y, p.x, p.y, a.x, p.y], closed: true, dashed: true }] });
            if (!('point' in q)) continue;
            colSp = q.point.x - a.x;
            rowSp = q.point.y - a.y;
            break;
          }
          ctx.print('거리를 입력하거나 점을 지정하십시오.', 'err');
        }
        if (rows > 1 && cols > 1 && colSp === 0) {
          for (;;) {
            const r = await ctx.getPoint('열 사이의 거리 지정 (|||):', { preferNumber: true });
            if ('text' in r && Number.isFinite(Number(r.text))) {
              colSp = Number(r.text);
              break;
            }
            ctx.print('거리를 입력하십시오.', 'err');
          }
        }
      }
      // 속성 값
      const values = new Map<string, string>();
      const ask = attdefsOf(bd).filter((d) => !(d.attFlags & 8));
      if (ask.length) {
        const v = await form(
          '속성 값',
          ask.map((d, i) => ({ key: `a${i}`, label: d.prompt || d.tag, type: 'text' as const, value: d.text })),
          { ok: '확인' },
        );
        if (v) ask.forEach((d, i) => values.set(d.tag.toUpperCase(), String(v[`a${i}`])));
      }
      const handle = st.session.newHandle();
      const e: InsertEntity = {
        ...entityDefaults(),
        ...currentProps(app),
        type: 'INSERT',
        handle,
        block: bd.name,
        insert: { x: p0.x, y: p0.y, z: 0 },
        scale: { x: sx, y: sy, z: 1 },
        rotation: rot,
        columnCount: cols,
        rowCount: rows,
        columnSpacing: colSp,
        rowSpacing: rowSp,
        attribs: [],
      };
      e.attribs = buildAttribs(bd, e, values, () => st.session.newHandle());
      addEntities(app, ctx, [e], 'MINSERT');
      ctx.print(`블록 ${bd.name}을(를) ${rows}행 × ${cols}열로 넣었습니다.`);
    },
  });

  // ------------------------------------------------------------- WBLOCK
  app.register({
    name: 'WBLOCK',
    aliases: ['W'],
    title: '블록 쓰기',
    async run(ctx) {
      const st = app.active!;
      const blocks = userBlocks(app);
      const insunits = Number(st.doc.header.get('$INSUNITS') ?? 0) || 0;
      const v = await form(
        '블록 쓰기',
        [
          {
            key: 'source',
            label: '원본',
            type: 'select',
            value: 'objects',
            options: [
              ...(blocks.length ? [{ value: 'block', label: '블록' }] : []),
              { value: 'all', label: '전체 도면' },
              { value: 'objects', label: '객체' },
            ],
          },
          ...(blocks.length ? [{ key: 'block', label: '블록', type: 'select' as const, value: blocks[0]!.name, options: blocks.map((b) => ({ value: b.name, label: b.name })) }] : []),
          {
            key: 'mode',
            label: '객체 처리',
            type: 'select',
            value: 'retain',
            options: [
              { value: 'retain', label: '유지' },
              { value: 'convert', label: '블록으로 변환' },
              { value: 'delete', label: '도면에서 삭제' },
            ],
          },
          { key: 'name', label: '파일 이름', type: 'text', value: 'new block' },
          { key: 'type', label: '파일 유형', type: 'select', value: 'dwg-AC1032', options: SAVE_TYPES.filter((x) => !(x.format === 'dxf' && x.version === 'AC1009')).map((x) => ({ value: x.value, label: x.label })) },
          { key: 'units', label: '삽입 단위', type: 'select', value: String(insunits), options: INSUNITS_OPTIONS },
        ],
        {
          ok: '확인',
          note: '블록·객체는 기준점이 새 도면의 원점이 됩니다. 쓰이지 않는 블록·도면층·선종류·스타일은 넣지 않습니다. 파일은 이 컴퓨터에서 만들어 내려받습니다.',
          validate: (x) => {
            const n = String(x.name).trim();
            if (!n) return '파일 이름을 입력하십시오.';
            if (/[<>/\\":;?*|]/.test(n)) return '파일 이름에 쓸 수 없는 문자가 있습니다.';
            return null;
          },
        },
      );
      if (!v) return;
      const type = SAVE_TYPES.find((x) => x.value === v.type) ?? SAVE_TYPES[0]!;
      const kind = String(v.source) as WblockSource['kind'];
      let name = String(v.name).trim().replace(/\.(dwg|dxf)$/i, '');
      let source: WblockSource;
      let chosen: string[] = [];
      let base: Pt = { x: 0, y: 0 };
      if (kind === 'block') {
        source = { kind: 'block', name: String(v.block) };
        if (name === 'new block') name = String(v.block);
      } else if (kind === 'all') source = { kind: 'all' };
      else {
        chosen = await ctx.getSelection('객체 선택:');
        if (!chosen.length) {
          ctx.print('선택된 객체가 없습니다.', 'err');
          return;
        }
        const r = await ctx.getPoint('기준점 지정 <0,0,0>:');
        if ('point' in r) base = r.point;
        source = { kind: 'objects', handles: chosen, base };
      }
      const fileName = `${name}.${type.format}`;
      app.ui.setBusy('블록 쓰는 중…', 0.4);
      let saved = false;
      try {
        const built = buildWblockDocument(st.doc, source, { insUnits: Number(v.units) });
        const res = await app.engine.adopt(fileName, built.doc);
        try {
          const out = await app.engine.save(res.docId, type.format, type.version, false);
          download(new Blob([out.data as BlobPart], { type: type.format === 'dxf' ? 'application/dxf' : 'application/acad' }), fileName);
          saved = true;
          ctx.print(`${fileName}을(를) 썼습니다(객체 ${built.entities}개, ${(out.data.byteLength / 1024).toFixed(0)} KB).${built.skipped ? ` 옮길 수 없는 객체 ${built.skipped}개는 뺐습니다.` : ''}`);
          for (const w of out.warnings.slice(0, 3)) ctx.print(`참고: ${w.message}${w.count ? ` (${w.count})` : ''}`);
        } finally {
          app.engine.closeDoc(res.docId);
        }
      } catch (e) {
        ctx.print(`블록을 쓰지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
      } finally {
        app.ui.setBusy(null);
      }
      if (!saved || kind !== 'objects' || v.mode === 'retain') return;
      const space = st.space;
      const blk = st.doc.blocks.get(space);
      if (!blk) return;
      const order = new Map(blk.entities.map((e, i) => [e.handle, i]));
      const mine = unlockedOnly(app, chosen).filter((x) => st.session.ownerOf(x) === space).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      const removes: EditOp[] = mine.map((x) => ({ kind: 'remove', block: space, entity: st.doc.entityIndex.get(x)!, index: order.get(x) ?? -1 }));
      if (v.mode === 'delete') {
        rememberErased(
          st,
          mine.map((x) => ({ block: space, entity: st.doc.entityIndex.get(x)!, index: order.get(x) ?? -1 })),
        );
        st.selection.clear();
        st.session.commit({ label: 'WBLOCK', ops: removes.reverse(), group: ctx.group });
        ctx.print(`객체 ${mine.length}개를 도면에서 삭제했습니다(OOPS로 되살릴 수 있습니다).`);
        return;
      }
      // 블록으로 변환: 파일 이름의 블록 정의와 참조 하나
      const bname = baseName(fileName);
      if (BAD_BLOCK_NAME.test(bname) || bname.startsWith('*') || st.doc.blocks.has(tableKey(bname))) {
        ctx.print(`블록 이름 "${bname}"을(를) 쓸 수 없거나 이미 있어 객체를 그대로 두었습니다.`, 'err');
        return;
      }
      const recordHandle = st.session.newHandle();
      const ents: Entity[] = mine.map((x) => {
        const c = cloneEntity(st.doc.entityIndex.get(x)!);
        c.owner = recordHandle;
        return c;
      });
      const record: BlockRecord = { name: bname, handle: recordHandle, flags: 0, insertUnits: Number(v.units) || 0, explodable: true, scalable: true };
      const def: BlockDef = {
        name: bname,
        handle: st.session.newHandle(),
        recordHandle,
        basePoint: { x: base.x, y: base.y, z: 0 } as Vec3,
        flags: ents.some((e) => e.type === 'ATTDEF') ? 2 : 0,
        layer: '0',
        entities: ents,
        endHandle: st.session.newHandle(),
      };
      const insH = st.session.newHandle();
      const insE: InsertEntity = {
        ...entityDefaults(),
        ...currentProps(app),
        type: 'INSERT',
        handle: insH,
        owner: blk.recordHandle,
        block: bname,
        insert: { x: base.x, y: base.y, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        rotation: 0,
        columnCount: 1,
        rowCount: 1,
        columnSpacing: 0,
        rowSpacing: 0,
        attribs: [],
      };
      insE.attribs = buildAttribs(def, insE, new Map(), () => st.session.newHandle());
      st.selection.clear();
      st.session.commit({
        label: 'WBLOCK',
        group: ctx.group,
        ops: [...removes.reverse(), { kind: 'blockRecord', key: tableKey(bname), before: null, after: record }, { kind: 'blockDef', key: tableKey(bname), before: null, after: def }, { kind: 'add', block: space, entity: insE }],
      });
      app.setSelection([insH]);
      ctx.print(`객체 ${mine.length}개를 블록 ${bname}의 참조로 바꿨습니다.`);
    },
  });
}

async function askNumber(ctx: CommandContext, prompt: string, def: number, check: (v: number) => boolean = () => true): Promise<number | null> {
  for (;;) {
    const r = await ctx.getPoint(prompt, { preferNumber: true });
    if ('enter' in r) return def;
    if ('text' in r) {
      const v = Number(r.text.trim());
      if (Number.isFinite(v) && check(v)) return v;
    }
    if ('keyword' in r || 'point' in r) return null;
    ctx.print('올바른 값을 입력하십시오.', 'err');
  }
}

