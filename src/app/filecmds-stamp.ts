/**
 * 플롯 스탬프: PLOTSTAMP(설정 대화상자)와 PLOT 출력에 스탬프 넣기.
 * 설정은 이 브라우저(localStorage)에만 둔다. 화면에는 그리지 않고 PDF·SVG(플롯·게시·미리보기) 쪽에만 덧붙인다.
 */
import { MODEL_SPACE, tableKey } from '../core/model';
import { DEFAULT_STAMP, type PlotStampInfo, type PlotStampSettings, normalizeStamp, plotStampLines, stampDate, stampGeometry } from '../edit/filecmds/stamp';
import { DisplayListBuilder } from '../render/displaylist';
import { type GlyphGeom, strokeFace } from '../text/fonts';
import type { App } from './app';
import type { DocState } from './docstate';
import type { Page } from './export';
import { PAPERS, type PlotSettings } from './plot';
import { type SpaceScene, paperInfo } from './scene';
import { form } from './ui/dom';

const KEY = 'opencad.plotstamp';
let cached: PlotStampSettings | null = null;

/** 지금 플롯 스탬프 설정 */
export function plotStampSettings(): PlotStampSettings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const t = localStorage.getItem(KEY);
    raw = t ? JSON.parse(t) : null;
  } catch {
    raw = null;
  }
  cached = normalizeStamp(raw);
  return cached;
}

export function savePlotStampSettings(s: PlotStampSettings): void {
  cached = { ...s };
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    /* 보관소를 못 쓰면 이번 세션만 */
  }
}

export function plotStampOn(): boolean {
  return plotStampSettings().on;
}

/** 플롯 대화상자의 "플롯 스탬프 켜기" */
export function setPlotStampOn(on: boolean): void {
  if (plotStampSettings().on !== on) savePlotStampSettings({ ...plotStampSettings(), on });
}

const trimNum = (v: number) => String(Math.round(v * 10000) / 10000);

/** 쪽마다 배치 이름·용지·축척·인쇄 가능 여백(mm, [왼쪽, 위, 오른쪽, 아래]) */
function pageInfos(st: DocState, s: PlotSettings, count: number): { layout: string; paper: string; scale: string; inset: [number, number, number, number] }[] {
  const model = () => ({
    layout: '모형',
    paper: PAPERS.find((p) => p.key === s.paper)?.label ?? s.paper,
    scale: s.scale === 'fit' ? '용지에 맞춤' : s.scale,
    inset: [s.margin, s.margin, s.margin, s.margin] as [number, number, number, number],
  });
  const ofLayout = (spaceKey: string) => {
    const l = st.layoutFor(spaceKey);
    if (!l) return model();
    const p = l.plot;
    const pi = paperInfo(l, st.scenes.get(spaceKey)?.bounds ?? null);
    const k = pi.mmPerUnit;
    const pr = pi.printable;
    const inset: [number, number, number, number] = pr ? [(pr[0] - pi.minX) * k, (pi.maxY - pr[3]) * k, (pi.maxX - pr[2]) * k, (pr[1] - pi.minY) * k] : [0, 0, 0, 0];
    const paper = p.paperName ? p.paperName.replace(/_/g, ' ') : `${trimNum(p.paperWidth)} × ${trimNum(p.paperHeight)} mm`;
    const scale = p.scaleNumerator > 0 && p.scaleDenominator > 0 ? `${trimNum(p.scaleNumerator)}:${trimNum(p.scaleDenominator)}` : '1:1';
    return { layout: l.name, paper, scale, inset };
  };
  if (s.what === 'layouts') {
    const lays = st.layouts.filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder);
    return Array.from({ length: count }, (_, i) => (lays[i] ? ofLayout(tableKey(lays[i]!.blockName)) : model()));
  }
  if (s.what === 'layout' && st.onLayout) return Array.from({ length: count }, () => ofLayout(st.displaySpace));
  return Array.from({ length: count }, model);
}

/** 단선 글꼴(Hershey)에 없는 글자(한글 등)는 윤곽 글꼴로 */
async function glyphSource(app: App, text: string): Promise<(code: number) => GlyphGeom | null> {
  const need = new Set<number>();
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (!strokeFace.has(c)) need.add(c);
  }
  if (need.size) await app.fontLib.require(need).catch(() => undefined);
  const q = strokeFace.glyph(63);
  return (code) => strokeFace.glyph(code) ?? (need.has(code) ? app.fontLib.cjkFace.glyph(code) : null) ?? q;
}

/** 출력 쪽마다 스탬프 레이어를 덧붙인다(용지 mm → 출력 단위 unitsPerMm) */
export async function stampPages(app: App, st: DocState, s: PlotSettings, pages: Page[], unitsPerMm: number): Promise<void> {
  const set = plotStampSettings();
  const infos = pageInfos(st, s, pages.length);
  const date = new Date();
  const device = s.format === 'svg' ? 'SVG' : 'DWG To PDF.pc3';
  const all = infos.map((pi) => plotStampLines(set, { drawing: st.saveName, layout: pi.layout, date, device, paper: pi.paper, scale: pi.scale }));
  const glyph = await glyphSource(app, all.flat().join(''));
  // 검정, 불투명, 0.18 mm, 보임
  const styles = new Float32Array([0, 0, 0, 1, 0.18, 1, 0, 0]);
  pages.forEach((page, i) => {
    const lines = all[i]!;
    if (!lines.length) return;
    const g = stampGeometry(set, lines, { w: page.width / unitsPerMm, h: page.height / unitsPerMm }, infos[i]!.inset, glyph);
    const b = new DisplayListBuilder(() => false);
    for (let k = 0; k + 3 < g.segs.length; k += 4) b.segment(g.segs[k]!, g.segs[k + 1]!, g.segs[k + 2]!, g.segs[k + 3]!, 0);
    for (let k = 0; k + 5 < g.tris.length; k += 6) b.triangle(g.tris[k]!, g.tris[k + 1]!, g.tris[k + 2]!, g.tris[k + 3]!, g.tris[k + 4]!, g.tris[k + 5]!, 0);
    b.endEntity('PLOTSTAMP');
    const source = b.finish();
    page.layers.push({ scene: { source } as unknown as SpaceScene, m: [unitsPerMm, 0, 0, unitsPerMm, 0, 0], styles });
  });
}

const CORNERS: { value: PlotStampSettings['location']; label: string }[] = [
  { value: 'BL', label: '왼쪽 아래' },
  { value: 'TL', label: '왼쪽 위' },
  { value: 'TR', label: '오른쪽 위' },
  { value: 'BR', label: '오른쪽 아래' },
];

export function registerPlotStampCommand(app: App, reg: (c: Parameters<App['register']>[0]) => void): void {
  reg({
    name: 'PLOTSTAMP',
    title: '플롯 스탬프',
    noDoc: true,
    async run(ctx) {
      const cur = plotStampSettings();
      const st = app.active;
      const sample: PlotStampInfo = {
        drawing: st?.saveName ?? 'Drawing1.dwg',
        layout: st ? (st.onLayout ? (st.layoutFor(st.displaySpace)?.name ?? '') : '모형') : '모형',
        date: new Date(),
        device: 'DWG To PDF.pc3',
        paper: 'ISO A3 (420.00 x 297.00 MM)',
        scale: '1:1',
      };
      const v = await form(
        '플롯 스탬프',
        [
          { key: 'on', label: '플롯 스탬프 켜기', type: 'check', value: cur.on },
          { key: 'drawing', label: '도면 이름', type: 'check', value: cur.drawing },
          { key: 'layout', label: '배치 이름', type: 'check', value: cur.layout },
          { key: 'date', label: '날짜 및 시간', type: 'check', value: cur.date },
          { key: 'login', label: '로그인 이름', type: 'check', value: cur.login },
          { key: 'device', label: '장치 이름', type: 'check', value: cur.device },
          { key: 'paper', label: '용지 크기', type: 'check', value: cur.paper },
          { key: 'scale', label: '플롯 축척', type: 'check', value: cur.scale },
          { key: 'loginName', label: '로그인 이름(직접 입력)', type: 'text', value: cur.loginName },
          { key: 'custom1', label: '사용자 정의 필드 1', type: 'text', value: cur.custom1 },
          { key: 'custom2', label: '사용자 정의 필드 2', type: 'text', value: cur.custom2 },
          { key: 'location', label: '위치', type: 'select', value: cur.location, options: CORNERS },
          {
            key: 'orientation',
            label: '방향',
            type: 'select',
            value: cur.orientation,
            options: [
              { value: 'H', label: '가로' },
              { value: 'V', label: '세로' },
            ],
          },
          { key: 'offsetX', label: 'X 간격띄우기(mm)', type: 'number', value: cur.offsetX },
          { key: 'offsetY', label: 'Y 간격띄우기(mm)', type: 'number', value: cur.offsetY },
          {
            key: 'relative',
            label: '간격띄우기 기준',
            type: 'select',
            value: cur.relative,
            options: [
              { value: 'printable', label: '인쇄 가능 영역에 상대적' },
              { value: 'border', label: '용지 경계에 상대적' },
            ],
          },
          { key: 'height', label: '문자 높이(mm)', type: 'number', value: cur.height },
          { key: 'singleLine', label: '한 줄로 플롯 스탬프', type: 'check', value: cur.singleLine },
        ],
        {
          ok: '확인',
          note: `미리보기: ${plotStampLines({ ...cur, on: true }, sample).join(' / ') || '(필드 없음)'} — 스탬프는 화면에 그리지 않고 PLOT·PUBLISH의 PDF·SVG에만 넣습니다.`,
          validate: (x) => (Number(x.height) > 0 ? null : '문자 높이는 0보다 커야 합니다.'),
        },
      );
      if (!v) return;
      const next = normalizeStamp({ ...DEFAULT_STAMP, ...v });
      savePlotStampSettings(next);
      const lines = plotStampLines(next, sample);
      ctx.print(next.on ? `플롯 스탬프를 켰습니다: ${lines.join(' / ') || '(필드 없음)'}` : '플롯 스탬프를 껐습니다.');
      if (next.on && next.date) ctx.print(`날짜 형식: ${stampDate(sample.date)}`);
    },
  });
}
