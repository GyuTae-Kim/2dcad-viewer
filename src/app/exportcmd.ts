/**
 * 데이터 내보내기: EXPORT(EXP). 형식을 고르면 그 형식의 내보내기·저장 명령으로 보낸다.
 * DWG·DXF는 다른 이름으로 저장, PDF는 플롯, SVG·PNG·JPEG·BMP는 화면 내보내기다.
 */
import type { App } from './app';
import { form } from './ui/dom';

const FORMATS = [
  ['PDF', 'PDF (*.pdf) — 플롯', 'PLOT'],
  ['SVG', 'SVG (*.svg)', 'SVGOUT'],
  ['PNG', 'PNG (*.png)', 'PNGOUT'],
  ['JPG', 'JPEG (*.jpg)', 'JPGOUT'],
  ['BMP', '비트맵 (*.bmp)', 'BMPOUT'],
  ['WMF', 'Windows 메타파일 (*.wmf) — 고른 객체', 'WMFOUT'],
  ['DWG', '도면 (*.dwg) — 다른 이름으로 저장', 'SAVEAS'],
  ['DXF', 'DXF (*.dxf) — 다른 이름으로 저장', 'SAVEAS'],
  ['LAYOUT', '배치를 모형으로 (*.dwg)', 'EXPORTLAYOUT'],
] as const;

let last = 'PDF';

export function registerExportCommands(app: App): void {
  app.register({
    name: 'EXPORT',
    aliases: ['EXP'],
    title: '데이터 내보내기',
    async run(ctx) {
      const v = await form('데이터 내보내기', [{ key: 'fmt', label: '파일 유형', type: 'select', value: last, options: FORMATS.map(([value, label]) => ({ value, label })) }], { ok: '내보내기' });
      if (!v) return;
      last = String(v.fmt);
      const f = FORMATS.find(([k]) => k === last)!;
      if (f[2] === 'EXPORTLAYOUT' && app.active?.isModel) {
        ctx.print('배치를 모형으로 내보내기는 배치 탭에서 쓸 수 있습니다.', 'err');
        return;
      }
      await app.run(f[2]);
    },
  });
}
