/**
 * 데이터 추출: DATAEXTRACTION(DX, EATTEXT). 블록 참조의 이름·개수·속성 값(또는 모든 객체의 종류)을 모아
 * 도면에 표로 넣거나 CSV로 내려받는다. 프롬프트는 AutoCAD 2026 한국어판을 따른다.
 */
import { tableKey } from '../core/model';
import { type ExtractResult, extractData, toCsv } from '../edit/extract';
import { createTable, setText, tableHeight, tableWidth } from '../edit/table/model';
import { addTableOps } from '../edit/table/ops';
import { currentTableStyle, defaultTableStyle, isMetric } from '../edit/table/style';
import type { App } from './app';
import { currentProps } from './draw';
import { baseName, download } from './export';
import { form } from './ui/dom';

/** 글자 수로 어림한 열 폭 */
function colWidths(r: ExtractResult, height: number, margin: number): number[] {
  const width = (s: string) => [...s].reduce((w, ch) => w + (/[ᄀ-ᇿ㄰-㆏가-힣一-鿿]/.test(ch) ? 1 : 0.62), 0) * height;
  return r.columns.map((c, i) => Math.max(width(c), ...r.rows.map((row) => width(row[i] ?? '')), height * 3) + margin * 2);
}

export function registerDataExtractCommands(app: App): void {
  app.register({
    name: 'DATAEXTRACTION',
    aliases: ['DX', 'EATTEXT'],
    title: '데이터 추출',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const v = await form('데이터 추출', [
        {
          key: 'scope',
          label: '데이터 원본',
          type: 'select',
          value: st.selection.size ? 'select' : 'space',
          options: [
            { value: 'space', label: '지금 공간의 모든 객체' },
            { value: 'select', label: '현재 도면에서 객체 선택' },
          ],
        },
        {
          key: 'kind',
          label: '객체',
          type: 'select',
          value: 'blocks',
          options: [
            { value: 'blocks', label: '블록만 표시(이름·속성)' },
            { value: 'all', label: '모든 객체 종류 표시' },
          ],
        },
        { key: 'attributes', label: '블록 속성 값 열', type: 'check', value: true },
        { key: 'layer', label: '도면층 열', type: 'check', value: false },
        { key: 'combine', label: '같은 행 결합(개수 열)', type: 'check', value: true },
        {
          key: 'output',
          label: '출력',
          type: 'select',
          value: 'table',
          options: [
            { value: 'table', label: '데이터 추출 테이블을 도면에 삽입' },
            { value: 'csv', label: 'CSV 파일로 내려받기' },
            { value: 'both', label: '둘 다' },
          ],
        },
        { key: 'title', label: '표 제목', type: 'text', value: '데이터 추출' },
      ]);
      if (!v) return;
      const block = doc.blocks.get(st.space);
      let ents = block?.entities ?? [];
      if (v.scope === 'select') {
        const hs = await ctx.getSelection('객체 선택:');
        if (!hs.length) return;
        const set = new Set(hs);
        ents = ents.filter((e) => set.has(e.handle));
      }
      // 꺼지거나 동결된 도면층은 뺀다
      ents = ents.filter((e) => {
        const L = doc.layers.get(tableKey(e.layer));
        return !(L && (L.off || L.frozen));
      });
      const res = extractData(doc, ents, { blocksOnly: v.kind === 'blocks', attributes: !!v.attributes, layer: !!v.layer, combine: !!v.combine });
      if (!res.rows.length) {
        ctx.print(v.kind === 'blocks' ? '추출할 블록 참조가 없습니다.' : '추출할 객체가 없습니다.', 'err');
        return;
      }
      ctx.print(`${res.rows.length}개 행, ${res.columns.length}개 열을 추출했습니다.`);
      if (v.output === 'csv' || v.output === 'both') {
        download(new Blob([toCsv(res)], { type: 'text/csv;charset=utf-8' }), `${baseName(st.saveName)}_데이터추출.csv`);
        ctx.print('CSV 파일을 내려받았습니다.');
      }
      if (v.output === 'csv') return;
      const entry = currentTableStyle(doc);
      const style = entry?.style ?? defaultTableStyle(isMetric(doc));
      const title = String(v.title ?? '').trim();
      let data = createTable({ cols: res.columns.length, colWidth: 10, dataRows: res.rows.length, rowLines: 1, first: title ? 'title' : 'header', second: title ? 'header' : 'data' }, style);
      data = { ...data, colWidths: colWidths(res, style.cells.data.height, style.hMargin) };
      let r0 = 0;
      if (title) data = setText(data, r0++, 0, title);
      res.columns.forEach((c, i) => (data = setText(data, r0, i, c)));
      r0++;
      res.rows.forEach((row, ri) => row.forEach((s, ci) => (data = setText(data, r0 + ri, ci, s))));
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
      st.session.commit({ label: 'DATAEXTRACTION', ops: r.ops, group: ctx.group });
      app.lastCreated = [r.table.handle];
    },
  });
}
