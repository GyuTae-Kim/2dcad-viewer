/**
 * PDF 가져오기: PDFIMPORT. 고른 PDF의 한 쪽에서 벡터 형상(선·곡선)·솔리드 채우기·문자를 도면 객체로 만든다.
 * 축척 1이면 실제 크기(미터법 도면은 mm, 영국식은 인치). 파일은 이 컴퓨터를 떠나지 않는다.
 */
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { type PdfPageData, pdfLayerRecords, pdfToEntities } from '../edit/pdfimport';
import type { App } from './app';
import { currentProps } from './draw';
import { form, h } from './ui/dom';

async function pickPdf(): Promise<File | null> {
  const input = h('input', { type: 'file', accept: '.pdf,application/pdf', hidden: true }) as HTMLInputElement;
  document.body.append(input);
  try {
    return await new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
  } finally {
    input.remove();
  }
}

let preset: File | null = null;

/** 다음 PDFIMPORT가 파일 고르기 대신 이 파일을 쓴다(IMPORT가 이미 고른 파일) */
export function presetPdfImportFile(f: File): void {
  preset = f;
}

export function registerPdfImportCommands(app: App): void {
  app.register({
    name: 'PDFIMPORT',
    aliases: ['IMPORTPDF'],
    title: 'PDF 가져오기',
    async run(ctx) {
      const st = app.active!;
      const doc = st.doc;
      const file = preset ?? (await pickPdf());
      preset = null;
      if (!file) return;
      const data = new Uint8Array(await file.arrayBuffer());
      ctx.print(`${file.name} 읽는 중…`);
      const vec = await import('./pdfvector');
      let pages: number;
      try {
        pages = await vec.pdfPageCount(data);
      } catch (e) {
        ctx.print(`PDF를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
        return;
      }
      const metric = Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
      const v = await form('PDF 가져오기', [
        { key: 'page', label: `쪽(1~${pages})`, type: 'number', value: 1 },
        { key: 'scale', label: `축척(1 = 실제 크기, ${metric ? 'mm' : '인치'})`, type: 'number', value: 1 },
        { key: 'rotation', label: '회전(도)', type: 'number', value: 0 },
        { key: 'geometry', label: '벡터 형상', type: 'check', value: true },
        { key: 'fills', label: '솔리드 채우기', type: 'check', value: true },
        { key: 'text', label: '트루타입 문자', type: 'check', value: true },
        { key: 'lineweights', label: '선가중치 적용', type: 'check', value: true },
        {
          key: 'layers',
          label: '도면층',
          type: 'select',
          value: 'pdf',
          options: [
            { value: 'pdf', label: '객체 도면층 작성(PDF_Geometry·PDF_Solid Fills·PDF_Text)' },
            { value: 'current', label: '현재 도면층' },
          ],
        },
      ], { ok: '확인', validate: (x) => (Number(x.page) >= 1 && Number(x.page) <= pages && Number(x.scale) > 0 ? null : '쪽 번호와 축척을 확인하십시오.') });
      if (!v) return;
      let page: PdfPageData;
      try {
        page = (await vec.extractPdfPage(data, Math.round(Number(v.page)))).page;
      } catch (e) {
        ctx.print(`PDF 쪽을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
        return;
      }
      // PDF 단위(1/72인치) → 도면 단위
      const unit = metric ? 25.4 / 72 : 1 / 72;
      const scale = unit * Number(v.scale);
      const rot = (Number(v.rotation) * Math.PI) / 180;
      const w = page.width * scale;
      const hh = page.height * scale;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const r = await ctx.getPoint('삽입점 지정:', {
        rubber: (q) => {
          const P = (x: number, y: number) => [q.x + c * x - s * y, q.y + s * x + c * y];
          return [{ pts: [...P(0, 0), ...P(w, 0), ...P(w, hh), ...P(0, hh)], closed: true, dashed: true }];
        },
      });
      if (!('point' in r)) return;
      const props = currentProps(app);
      const res = pdfToEntities(doc, page, {
        scale,
        insert: r.point,
        rotation: rot,
        geometry: !!v.geometry,
        fills: !!v.fills,
        text: !!v.text,
        lineweights: !!v.lineweights,
        pdfLayers: v.layers === 'pdf',
        currentLayer: props.layer,
        mmPerUnit: metric ? 1 : 25.4,
      });
      if (!res.entities.length) {
        ctx.print('가져올 벡터 형상이나 문자가 없습니다(스캔한 그림 PDF일 수 있습니다).', 'err');
        return;
      }
      const ops: EditOp[] = [];
      for (const L of pdfLayerRecords(doc, res.layers, () => st.session.newHandle())) ops.push({ kind: 'layer', key: tableKey(L.name), before: null, after: L });
      const block = doc.blocks.get(st.space)!;
      for (const e of res.entities) {
        e.handle = st.session.newHandle();
        e.owner = block.recordHandle;
        if (/^\*PAPER_SPACE/i.test(st.space)) e.paperSpace = true;
        ops.push({ kind: 'add', block: st.space, entity: e });
      }
      st.session.commit({ label: 'PDFIMPORT', ops, group: ctx.group });
      app.lastCreated = res.entities.map((e) => e.handle);
      const count = (t: string) => res.entities.filter((e) => e.type === t).length;
      ctx.print(`PDF ${Math.round(Number(v.page))}쪽에서 객체 ${res.entities.length}개를 가져왔습니다(선 ${count('LINE')}, 폴리선 ${count('LWPOLYLINE')}, 스플라인 ${count('SPLINE')}, 해치 ${count('HATCH')}, 문자 ${count('TEXT')}).`);
    },
  });
}
