/**
 * 저장과 새 도면: QSAVE, SAVE, SAVEAS, NEW
 * 파일은 이 컴퓨터에서 만든다(서버 없음). 브라우저가 파일 시스템 접근을 허락하면 고른 파일에 바로 쓰고,
 * 아니면 내려받기로 저장한다.
 */
import { syncActiveVports } from './vports';
import { forgetRecovery } from './autosave';
import { createNewDocument } from '../core/newdoc';
import type { SaveFormat } from '../worker/protocol';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { baseName, download } from './export';
import { form } from './ui/dom';

interface SaveTarget {
  format: SaveFormat;
  version: string;
  binary: boolean;
  /** 파일 시스템 접근 API로 고른 파일(있으면 QSAVE가 그 파일에 바로 쓴다) */
  handle?: FileSystemFileHandleLike;
}

/** 브라우저 파일 시스템 접근 API 중 쓰는 부분 */
interface FileSystemFileHandleLike {
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
type SavePicker = (opt: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandleLike>;

export const SAVE_TYPES: { value: string; label: string; format: SaveFormat; version: string }[] = [
  { value: 'dwg-AC1032', label: 'AutoCAD 2018/LT2018 도면 (*.dwg)', format: 'dwg', version: 'AC1032' },
  { value: 'dwg-AC1027', label: 'AutoCAD 2013/LT2013 도면 (*.dwg)', format: 'dwg', version: 'AC1027' },
  { value: 'dwg-AC1024', label: 'AutoCAD 2010/LT2010 도면 (*.dwg)', format: 'dwg', version: 'AC1024' },
  { value: 'dwg-AC1018', label: 'AutoCAD 2004/LT2004 도면 (*.dwg)', format: 'dwg', version: 'AC1018' },
  { value: 'dwg-AC1015', label: 'AutoCAD 2000/LT2000 도면 (*.dwg)', format: 'dwg', version: 'AC1015' },
  { value: 'dxf-AC1032', label: 'AutoCAD 2018 DXF (*.dxf)', format: 'dxf', version: 'AC1032' },
  { value: 'dxf-AC1027', label: 'AutoCAD 2013/LT2013 DXF (*.dxf)', format: 'dxf', version: 'AC1027' },
  { value: 'dxf-AC1024', label: 'AutoCAD 2010/LT2010 DXF (*.dxf)', format: 'dxf', version: 'AC1024' },
  { value: 'dxf-AC1021', label: 'AutoCAD 2007/LT2007 DXF (*.dxf)', format: 'dxf', version: 'AC1021' },
  { value: 'dxf-AC1018', label: 'AutoCAD 2004/LT2004 DXF (*.dxf)', format: 'dxf', version: 'AC1018' },
  { value: 'dxf-AC1015', label: 'AutoCAD 2000/LT2000 DXF (*.dxf)', format: 'dxf', version: 'AC1015' },
  { value: 'dxf-AC1009', label: 'AutoCAD R12/LT2 DXF (*.dxf)', format: 'dxf', version: 'AC1009' },
];

const targets = new WeakMap<DocState, SaveTarget>();

/** 열린 파일과 같은 형식으로 저장할 수 있으면 그 설정 */
export function sameFormat(st: DocState): SaveTarget | null {
  const d = st.doc;
  if (d.format === 'dwg') {
    // R2007은 쓸 수 없어 R2004로, R13·R14는 R2000으로
    const v = d.version === 'AC1021' ? 'AC1018' : d.version === 'AC1012' || d.version === 'AC1014' ? 'AC1015' : d.version;
    const t = SAVE_TYPES.find((x) => x.format === 'dwg' && x.version === v);
    return { format: 'dwg', version: t ? t.version : 'AC1032', binary: false };
  }
  if (d.format !== 'dxf') return null;
  const t = SAVE_TYPES.find((x) => x.format === 'dxf' && x.version === d.version);
  return { format: 'dxf', version: t ? t.version : 'AC1032', binary: !!d.binary };
}

function fileName(st: DocState, t: SaveTarget): string {
  return `${baseName(st.saveName)}.${t.format}`;
}

/** 실제로 쓰기 */
async function write(app: App, ctx: CommandContext, st: DocState, t: SaveTarget, name: string): Promise<boolean> {
  await app.edits.flush(st);
  // 다시 열 때 같은 화면·타일 뷰포트로 열리게 *Active 뷰를 지금 화면으로
  syncActiveVports(app, st);
  ctx.print(`${name} 저장하는 중…`);
  app.ui.setBusy('저장하는 중…', 0.5);
  let res;
  try {
    res = await app.engine.save(st.docId, t.format, t.version, t.binary);
  } catch (e) {
    ctx.print(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return false;
  } finally {
    app.ui.setBusy(null);
  }
  const blob = new Blob([res.data as BlobPart], { type: t.format === 'dxf' ? 'application/dxf' : 'application/acad' });
  if (t.handle) {
    try {
      const w = await t.handle.createWritable();
      await w.write(blob);
      await w.close();
    } catch (e) {
      ctx.print(`파일에 쓰지 못해 내려받기로 저장합니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
      t.handle = undefined;
      download(blob, name);
    }
  } else download(blob, name);
  st.saveName = name;
  st.session.markSaved();
  // 저장했으니 자동 저장본은 필요 없다
  forgetRecovery(st);
  targets.set(st, t);
  app.ui.refreshTabs();
  document.title = `${st.saveName} - OpenCAD 2D 뷰어`;
  const label = SAVE_TYPES.find((x) => x.format === t.format && x.version === t.version)?.label ?? t.version;
  ctx.print(`${name}을(를) ${label}${t.binary ? ' 이진' : ''} 형식으로 저장했습니다(${(res.data.byteLength / 1024).toFixed(0)} KB, ${Math.round(res.ms)}ms).`);
  for (const w of res.warnings.slice(0, 5)) ctx.print(`참고: ${w.message}${w.count ? ` (${w.count})` : ''}`);
  return true;
}

async function saveAs(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const prev = targets.get(st) ?? sameFormat(st);
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  const v = await form(
    '다른 이름으로 저장',
    [
      ...(picker ? [] : [{ key: 'name', label: '파일 이름', type: 'text' as const, value: baseName(st.saveName), wide: true }]),
      { key: 'type', label: '파일 유형', type: 'select', value: prev ? `${prev.format}-${prev.version}` : 'dwg-AC1032', options: SAVE_TYPES.map((x) => ({ value: x.value, label: x.label })) },
      { key: 'binary', label: '이진 DXF(DXF일 때)', type: 'check', value: prev?.binary ?? false },
    ],
    {
      ok: '저장',
      note: '파일은 서버로 보내지 않고 이 컴퓨터에서 만듭니다. DWG R2007(AC1021) 형식은 R2004로 저장합니다.',
      validate: (x) => (picker || String(x.name ?? '').trim() ? null : '파일 이름을 입력하십시오.'),
    },
  );
  if (!v) return;
  const type = SAVE_TYPES.find((x) => x.value === v.type) ?? SAVE_TYPES[0]!;
  const t: SaveTarget = { format: type.format, version: type.version, binary: !!v.binary && type.format === 'dxf' };
  let name = picker ? fileName(st, t) : `${String(v.name).trim().replace(/\.(dxf|dwg)$/i, '')}.${t.format}`;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description: type.label, accept: type.format === 'dwg' ? { 'application/acad': ['.dwg'] } : { 'application/dxf': ['.dxf'] } }] });
      t.handle = handle;
      name = handle.name;
    } catch {
      ctx.print('저장을 취소했습니다.');
      return;
    }
  }
  await write(app, ctx, st, t, name);
}

let drawingSerial = 1;

function lastUnits(): 'metric' | 'imperial' {
  try {
    return localStorage.getItem('opencad.newUnits') === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}

export function registerSaveCommands(app: App): void {
  app.register({
    name: 'QSAVE',
    title: '저장',
    async run(ctx) {
      const st = app.active!;
      const t = targets.get(st) ?? sameFormat(st);
      if (!t) {
        await saveAs(app, ctx);
        return;
      }
      await write(app, ctx, st, t, t.handle?.name ?? fileName(st, t));
    },
  });
  app.register({ name: 'SAVEAS', aliases: ['SAVE', 'DXFOUT'], title: '다른 이름으로 저장', run: (ctx) => saveAs(app, ctx) });

  app.register({
    name: 'NEW',
    aliases: ['QNEW'],
    title: '새 도면',
    noDoc: true,
    async run(ctx) {
      const v = await form(
        '새 도면',
        [
          {
            key: 'units',
            label: '템플릿',
            type: 'select',
            value: lastUnits(),
            options: [
              { value: 'metric', label: 'acadiso (미터법, 밀리미터)' },
              { value: 'imperial', label: 'acad (영국식, 인치)' },
            ],
          },
        ],
        { ok: '만들기' },
      );
      if (!v) return;
      const units = v.units === 'imperial' ? 'imperial' : 'metric';
      try {
        localStorage.setItem('opencad.newUnits', units);
      } catch {
        /* 저장소를 못 쓰면 기억하지 않는다 */
      }
      let name: string;
      do name = `Drawing${drawingSerial++}.dwg`;
      while (app.docs.some((d) => d.saveName === name));
      const doc = createNewDocument(units);
      const res = await app.engine.adopt(name, doc);
      app.addDocument(res, name, 0);
      ctx.print(`새 도면 ${name}을(를) 만들었습니다(${units === 'metric' ? 'acadiso, mm' : 'acad, inch'}).`);
    },
  });
}
