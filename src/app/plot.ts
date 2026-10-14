/**
 * 출력: PLOT(용지·축척·플롯 스타일을 골라 PDF·SVG로), PUBLISH(모든 배치를 한 PDF로)
 */
import { ensureLayoutVariants } from './psltscale';
import { MODEL_SPACE, tableKey } from '../core/model';
import type { PlotStyle } from '../render/styles';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { type Page, type PageOptions, PT_PER_MM, baseName, download, exportPageSvg, layoutPage, modelPage, pdfDocument } from './export';
import { form } from './ui/dom';
import { ctbByName, ctbList, pickCtbFiles } from './ctblib';

/** 용지(mm, 세로 방향 폭 × 높이) */
export const PAPERS: { key: string; label: string; w: number; h: number }[] = [
  { key: 'A4', label: 'ISO A4 (210 × 297 mm)', w: 210, h: 297 },
  { key: 'A3', label: 'ISO A3 (297 × 420 mm)', w: 297, h: 420 },
  { key: 'A2', label: 'ISO A2 (420 × 594 mm)', w: 420, h: 594 },
  { key: 'A1', label: 'ISO A1 (594 × 841 mm)', w: 594, h: 841 },
  { key: 'A0', label: 'ISO A0 (841 × 1189 mm)', w: 841, h: 1189 },
  { key: 'LETTER', label: 'Letter (8.5 × 11 in)', w: 215.9, h: 279.4 },
  { key: 'LEGAL', label: 'Legal (8.5 × 14 in)', w: 215.9, h: 355.6 },
  { key: 'TABLOID', label: 'Tabloid / ANSI B (11 × 17 in)', w: 279.4, h: 431.8 },
  { key: 'ANSIC', label: 'ANSI C (17 × 22 in)', w: 431.8, h: 558.8 },
  { key: 'ANSID', label: 'ANSI D (22 × 34 in)', w: 558.8, h: 863.6 },
  { key: 'ANSIE', label: 'ANSI E (34 × 44 in)', w: 863.6, h: 1117.6 },
];

/** 플롯 스타일 표(CTB) 이름 → 출력 색 처리 */
export function styleSheetPlotStyle(name: string | undefined): PlotStyle | null {
  const n = (name ?? '').toLowerCase();
  if (!n) return null;
  if (n.startsWith('monochrome')) return 'mono';
  if (n.startsWith('grayscale')) return 'gray';
  return 'color';
}

const SCALES = ['fit', '1:1', '1:2', '1:5', '1:10', '1:20', '1:25', '1:50', '1:100', '1:200', '1:500', '1:1000', '2:1', '5:1', '10:1'];

/** 도면 단위 1이 몇 mm인지(INSUNITS) */
export function unitMm(insunits: number): number {
  const t: Record<number, number> = { 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 0.0000254, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100, 15: 10000, 16: 100000 };
  return t[insunits] ?? 1;
}

export interface PlotSettings {
  what: 'display' | 'extents' | 'window' | 'layout' | 'layouts';
  paper: string;
  landscape: boolean;
  scale: string;
  plotStyle: PlotStyle;
  /** 불러온 플롯 스타일 표(CTB) 이름. 있으면 plotStyle 대신 쓴다 */
  ctb?: string;
  lineweights: boolean;
  format: 'pdf' | 'svg';
  margin: number;
  window?: [number, number, number, number];
}

/** 문서별 마지막 출력 설정 */
const lastSettings = new WeakMap<DocState, PlotSettings>();

/** 모형 출력 페이지 */
function modelPlotPage(app: App, st: DocState, s: PlotSettings, unitsPerMm: number): Page | null {
  const v = app.view;
  let rect: [number, number, number, number];
  if (s.what === 'window' && s.window) rect = s.window;
  else if (s.what === 'extents') {
    const b = st.scenes.get(MODEL_SPACE)?.bounds;
    if (!b) return null;
    rect = [b.minX, b.minY, b.maxX, b.maxY];
  } else {
    const a = v.screenToWorld(0, v.height);
    const b = v.screenToWorld(v.width, 0);
    rect = [a.x, a.y, b.x, b.y];
  }
  const paper = PAPERS.find((p) => p.key === s.paper) ?? PAPERS[1]!;
  const pw = s.landscape ? paper.h : paper.w;
  const ph = s.landscape ? paper.w : paper.h;
  const rw = Math.max(1e-9, rect[2] - rect[0]);
  const rh = Math.max(1e-9, rect[3] - rect[1]);
  let mmPerUnit: number;
  if (s.scale === 'fit') mmPerUnit = Math.min((pw - 2 * s.margin) / rw, (ph - 2 * s.margin) / rh);
  else {
    const [a, b] = s.scale.split(':').map(Number);
    mmPerUnit = (unitMm(st.units.insunits || (st.units.measurement ? 4 : 1)) * a!) / b!;
  }
  // 용지 영역 밖은 자른다: 그릴 사각형을 용지에 맞게 넓히거나 줄인다
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;
  const hw = (pw - 2 * s.margin) / 2 / mmPerUnit;
  const hh = (ph - 2 * s.margin) / 2 / mmPerUnit;
  const area: [number, number, number, number] = s.scale === 'fit' ? rect : [cx - hw, cy - hh, cx + hw, cy + hh];
  return modelPage(st, area, pw * unitsPerMm, ph * unitsPerMm, mmPerUnit * unitsPerMm, unitsPerMm, pageOptions(s));
}

function pageOptions(s: PlotSettings): PageOptions {
  const ctb = ctbByName(s.ctb);
  return ctb ? { ctb, lineweights: s.lineweights } : { plotStyle: s.plotStyle, lineweights: s.lineweights };
}

/** 설정대로 페이지들을 만든다(배치 장면이 없으면 그려 온다) */
export async function plotPages(app: App, st: DocState, s: PlotSettings, unitsPerMm: number): Promise<Page[]> {
  await app.edits.flush(st);
  const opt = pageOptions(s);
  const pages: Page[] = [];
  if (s.what === 'layouts') {
    const lays = st.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder);
    if (lays.length) await app.ensureScene(st, MODEL_SPACE);
    for (const l of lays) {
      await app.ensureScene(st, l.blockName);
      await ensureLayoutVariants(app, st, l.blockName);
      const p = layoutPage(st, tableKey(l.blockName), unitsPerMm, opt);
      if (p) pages.push(p);
    }
    return pages;
  }
  if (s.what === 'layout' && st.onLayout) {
    await ensureLayoutVariants(app, st, st.displaySpace);
    const p = layoutPage(st, st.displaySpace, unitsPerMm, opt);
    if (p) pages.push(p);
    return pages;
  }
  const p = modelPlotPage(app, st, s, unitsPerMm);
  if (p) pages.push(p);
  return pages;
}

async function askWindow(ctx: CommandContext): Promise<[number, number, number, number] | null> {
  const a = await ctx.getPoint('첫 번째 구석 지정:');
  if (!('point' in a)) return null;
  const p = a.point;
  const b = await ctx.getPoint('반대 구석 지정:', { base: p, rubber: (q) => [{ pts: [p.x, p.y, q.x, p.y, q.x, q.y, p.x, q.y], closed: true, dashed: true }] });
  if (!('point' in b)) return null;
  const q = b.point;
  return [Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y)];
}

export function registerPlotCommands(app: App): void {
  app.register({
    name: 'PLOT',
    aliases: ['PRINT', 'EXPORTPDF'],
    title: '플롯(PDF로 출력)',
    async run(ctx) {
      const st = app.active!;
      const layoutCount = st.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).length;
      const prev = lastSettings.get(st);
      const metric = !!st.units.measurement;
      const sheet = st.layoutFor(st.displaySpace)?.plot.styleSheet;
      const sheetCtb = ctbByName(sheet);
      const v = await form(
        '플롯',
        [
          {
            key: 'what',
            label: '플롯 영역',
            type: 'select',
            value: prev?.what ?? (!st.onLayout ? 'display' : 'layout'),
            options: [
              ...(!st.onLayout
                ? [
                    { value: 'display', label: '화면 표시' },
                    { value: 'extents', label: '범위' },
                    { value: 'window', label: '윈도우(두 점 지정)' },
                  ]
                : [{ value: 'layout', label: `배치 "${st.layoutFor(st.displaySpace)?.name ?? ''}" (용지 그대로)` }]),
              ...(layoutCount ? [{ value: 'layouts', label: `모든 배치 (${layoutCount}쪽)` }] : []),
            ],
          },
          { key: 'paper', label: '용지(모형)', type: 'select', value: prev?.paper ?? (metric ? 'A3' : 'TABLOID'), options: PAPERS.map((p) => ({ value: p.key, label: p.label })) },
          { key: 'landscape', label: '가로 방향', type: 'check', value: prev?.landscape ?? true },
          { key: 'scale', label: '축척(모형)', type: 'select', value: prev?.scale ?? 'fit', options: SCALES.map((x) => ({ value: x, label: x === 'fit' ? '용지에 맞춤' : `${x} (용지 mm : 도면 ${metric ? 'mm' : '단위'})` })) },
          {
            key: 'plotStyle',
            label: '플롯 스타일',
            type: 'select',
            value: prev?.ctb ? `ctb:${prev.ctb}` : (prev?.plotStyle ?? (sheetCtb ? `ctb:${sheetCtb.name}` : (styleSheetPlotStyle(sheet) ?? 'mono'))),
            options: [
              { value: 'mono', label: 'monochrome (흑백)' },
              { value: 'gray', label: 'grayscale (회색조)' },
              { value: 'color', label: '색 그대로' },
              ...ctbList().map((t) => ({ value: `ctb:${t.name}`, label: `${t.name} (불러온 플롯 스타일 표)` })),
              { value: 'load', label: 'CTB 파일 불러오기…' },
            ],
          },
          { key: 'lineweights', label: '선가중치 출력', type: 'check', value: prev?.lineweights ?? true },
          {
            key: 'format',
            label: '파일 형식',
            type: 'select',
            value: prev?.format ?? 'pdf',
            options: [
              { value: 'pdf', label: 'PDF' },
              { value: 'svg', label: 'SVG(첫 쪽)' },
            ],
          },
        ],
        { ok: '플롯', note: '파일은 이 컴퓨터에서 만들어 바로 내려받습니다. 플롯하지 않는 도면층과 Defpoints는 빠집니다.' },
      );
      if (!v) return;
      let styleKey = String(v.plotStyle);
      if (styleKey === 'load') {
        const loaded = await pickCtbFiles();
        if (!loaded.length) {
          ctx.print('CTB 파일을 읽지 못했습니다. 색 그대로 출력합니다.', 'err');
          styleKey = 'color';
        } else {
          ctx.print(`플롯 스타일 표 ${loaded.map((t) => t.name).join(', ')}을(를) 불러왔습니다.`);
          styleKey = `ctb:${loaded[0]!.name}`;
        }
      }
      const s: PlotSettings = {
        what: v.what as PlotSettings['what'],
        paper: String(v.paper),
        landscape: !!v.landscape,
        scale: String(v.scale),
        plotStyle: styleKey.startsWith('ctb:') ? 'color' : (styleKey as PlotStyle),
        ctb: styleKey.startsWith('ctb:') ? styleKey.slice(4) : undefined,
        lineweights: !!v.lineweights,
        format: v.format as 'pdf' | 'svg',
        margin: 5,
      };
      if (s.what === 'window') {
        const w = await askWindow(ctx);
        if (!w) return;
        s.window = w;
      }
      lastSettings.set(st, s);
      ctx.print('출력 파일을 만드는 중…');
      const name = baseName(st.saveName);
      if (s.format === 'svg') {
        const pages = await plotPages(app, st, s, 1);
        if (!pages.length) return;
        download(exportPageSvg(pages[0]!, 'mm'), `${name}.svg`);
        ctx.print('SVG로 저장했습니다(단위 mm).');
        return;
      }
      const pages = await plotPages(app, st, s, PT_PER_MM);
      if (!pages.length) {
        ctx.print('출력할 내용이 없습니다.', 'err');
        return;
      }
      const blob = await pdfDocument(pages, st.saveName);
      const suffix = s.what === 'layouts' ? '-배치' : s.what === 'layout' ? `-${st.layoutFor(st.displaySpace)?.name ?? 'layout'}` : '';
      download(blob, `${name}${suffix}.pdf`);
      ctx.print(`PDF ${pages.length}쪽을 저장했습니다.`);
    },
  });

  app.register({
    name: 'PUBLISH',
    title: '모든 배치를 PDF로',
    async run(ctx) {
      const st = app.active!;
      const s: PlotSettings = { ...(lastSettings.get(st) ?? { paper: 'A3', landscape: true, scale: 'fit', plotStyle: 'mono', lineweights: true, format: 'pdf', margin: 5 }), what: 'layouts' };
      const pages = await plotPages(app, st, s, PT_PER_MM);
      if (!pages.length) {
        ctx.print('배치가 없습니다. 모형은 PLOT으로 출력하십시오.', 'err');
        return;
      }
      download(await pdfDocument(pages, st.saveName), `${baseName(st.saveName)}-배치.pdf`);
      ctx.print(`배치 ${pages.length}쪽을 PDF 하나로 저장했습니다.`);
    },
  });
}
