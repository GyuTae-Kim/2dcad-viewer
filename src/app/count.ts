/**
 * 블록 개수: COUNT(개수 창 — 블록별 개수, 누르면 그 참조를 고르고 확대), COUNTTABLE(개수 표 삽입).
 * 범위는 지금 공간 전체 또는 고른 객체다.
 */
import { type CountRow, countRows } from '../edit/count';
import { boundsOf } from '../edit/geom/query';
import { createTable, setText, tableHeight, tableWidth } from '../edit/table/model';
import { addTableOps } from '../edit/table/ops';
import { currentTableStyle, defaultTableStyle, isMetric } from '../edit/table/style';
import type { App, CommandContext } from './app';
import { currentProps } from './draw';
import { dialog, h } from './ui/dom';

function scopeRows(app: App, handles: string[] | null): CountRow[] {
  const st = app.active!;
  const ents = handles ? handles.map((x) => st.doc.entityIndex.get(x)).filter((e) => !!e) : (st.doc.blocks.get(st.space)?.entities ?? []);
  return countRows(st.doc, ents as never);
}

async function insertCountTable(app: App, ctx: CommandContext, rows: CountRow[]): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  const entry = currentTableStyle(doc);
  const style = entry?.style ?? defaultTableStyle(isMetric(doc));
  let data = createTable({ cols: 2, colWidth: 10, dataRows: rows.length, rowLines: 1, first: 'title', second: 'header' }, style);
  const th = style.cells.data.height;
  const widest = Math.max(4, ...rows.map((r) => [...r.name].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 1 : 0.6), 0)));
  data = { ...data, colWidths: [widest * th + 2 * style.hMargin, 6 * th + 2 * style.hMargin] };
  data = setText(data, 0, 0, '개수');
  data = setText(data, 1, 0, '항목');
  data = setText(data, 1, 1, '개수');
  rows.forEach((r, i) => {
    data = setText(data, 2 + i, 0, r.name);
    data = setText(data, 2 + i, 1, String(r.handles.length));
  });
  const w = tableWidth(data);
  const hgt = tableHeight(data);
  const flow = style.flow;
  const p = await ctx.getPoint('테이블 삽입점 지정:', {
    rubber: (q) => {
      const y1 = flow === 1 ? q.y + hgt : q.y - hgt;
      return [{ pts: [q.x, q.y, q.x + w, q.y, q.x + w, y1, q.x, y1], closed: true, dashed: true }];
    },
  });
  if (!('point' in p)) return;
  const r = addTableOps(doc, () => st.session.newHandle(), { space: st.space, data, style, styleHandle: entry?.handle, insert: { x: p.point.x, y: p.point.y, z: 0 }, props: currentProps(app) });
  st.session.commit({ label: 'COUNTTABLE', ops: r.ops, group: ctx.group });
  app.lastCreated = [r.table.handle];
}

export function registerCountCommands(app: App): void {
  app.register({
    name: 'COUNT',
    title: '개수',
    async run(ctx) {
      const st = app.active!;
      const picked = st.selection.size ? [...st.selection] : null;
      const rows = scopeRows(app, picked);
      if (!rows.length) {
        ctx.print(`${picked ? '고른 객체' : '지금 공간'}에 셀 블록 참조가 없습니다.`);
        return;
      }
      const total = rows.reduce((n, r) => n + r.handles.length, 0);
      ctx.print(`블록 ${rows.length}종, 참조 ${total}개(${picked ? '고른 객체' : '지금 공간 전체'}).`);
      let want: 'table' | null = null;
      await new Promise<void>((resolve) => {
        const list = h(
          'table',
          { class: 'count-table', style: 'width:100%;border-collapse:collapse' },
          h('thead', {}, h('tr', {}, h('th', { style: 'text-align:left' }, '항목'), h('th', { style: 'text-align:right' }, '개수'))),
          h(
            'tbody',
            {},
            ...rows.map((r) => {
              const tr = h('tr', { style: 'cursor:pointer', title: '누르면 이 블록의 참조를 고르고 확대합니다' }, h('td', {}, r.name), h('td', { style: 'text-align:right' }, String(r.handles.length)));
              tr.addEventListener('click', () => {
                const hs = [...new Set(r.handles)];
                app.setSelection(hs, 'replace');
                // 명령 안이므로 ZOOM 명령 대신 화면만 맞춘다
                const b = boundsOf(hs.map((x) => st.doc.entityIndex.get(x)!).filter(Boolean), st.doc);
                if (b) app.view.zoomRect(b.minX, b.minY, b.maxX, b.maxY, true, 0.1);
              });
              return tr;
            }),
          ),
        );
        const back = dialog('개수', h('div', { style: 'max-height:50vh;overflow:auto;min-width:280px' }, list), [
          { label: '표 삽입', run: () => void (want = 'table') },
          { label: '닫기', primary: true },
        ]);
        new MutationObserver((_, ob) => {
          if (!back.isConnected) {
            ob.disconnect();
            resolve();
          }
        }).observe(document.body, { childList: true });
      });
      if (want === 'table') await insertCountTable(app, ctx, rows);
    },
  });

  app.register({
    name: 'COUNTTABLE',
    title: '개수 표 삽입',
    async run(ctx) {
      const hs = await ctx.getSelection('객체 선택 <지금 공간 전체>:');
      const rows = scopeRows(app, hs.length ? hs : null);
      if (!rows.length) {
        ctx.print('셀 블록 참조가 없습니다.');
        return;
      }
      app.clearSelection();
      await insertCountTable(app, ctx, rows);
    },
  });
}
