/**
 * 내보내기·가져오기: WMFOUT(고른 객체를 Windows 메타파일로), IMPORT(파일 종류에 따라 PDF 가져오기 또는 도면을 블록으로 삽입).
 * 파일은 이 컴퓨터에서만 만들고 읽는다(서버 없음).
 */
import type { BlockDef, BlockRecord, Vec3, ViewportEntity } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { filterDisplayList } from '../edit/filecmds/dlfilter';
import { WmfSink, WmfWriter, wmfScale } from '../edit/filecmds/wmf';
import { DefinitionCopier } from '../edit/layertools/clone';
import type { EditOp } from '../edit/session';
import type { App, Command, CommandContext } from './app';
import type { DocState } from './docstate';
import { pickFiles, readDrawingFile } from './drawingfiles';
import { type Page, baseName, download, layoutPage, modelPage, walk } from './export';
import { presetPdfImportFile } from './pdfimport';
import { ensureLayoutVariants } from './psltscale';
import { paperInfo } from './scene';
import { ask } from './ui/dom';

/** 지금 화면(모형) 또는 배치 용지를 mm 단위 쪽으로 */
async function screenPage(app: App, st: DocState): Promise<Page | null> {
  await app.edits.flush(st);
  const opt = { lineweights: app.view.lwDisplay };
  if (st.onLayout) {
    await ensureLayoutVariants(app, st, st.displaySpace);
    return layoutPage(st, st.displaySpace, 1, opt);
  }
  const [x0, y0, x1, y1] = app.view.visibleWorld();
  // 화면 크기를 96 dpi 기준 mm로
  const W = (app.view.width * 25.4) / 96;
  const k = W / Math.max(1e-12, x1 - x0);
  return modelPage(st, [x0, y0, x1, y1], W, (y1 - y0) * k, k, 1, opt, true);
}

/** 고른 객체만 남긴 쪽. 고른 뷰포트는 그 안의 모형을 통째로 둔다 */
function selectedPage(st: DocState, page: Page, handles: ReadonlySet<string>): Page {
  const own = new Set([...st.scenes.values(), ...[...st.ltVariants.values()].map((v) => v.scene)]);
  // 고른 뷰포트의 출력 사각형 중심(용지 mm, y 아래로)
  const vpCenters: [number, number, number][] = [];
  const lay = st.onLayout ? st.layoutFor(st.displaySpace) : undefined;
  if (lay) {
    const pi = paperInfo(lay, st.scenes.get(st.displaySpace)?.bounds ?? null);
    for (const h of handles) {
      const e = st.doc.entityIndex.get(h) as ViewportEntity | undefined;
      if (e?.type !== 'VIEWPORT') continue;
      vpCenters.push([(e.center.x - pi.minX) * pi.mmPerUnit, (pi.maxY - e.center.y) * pi.mmPerUnit, Math.max(e.width, e.height) * pi.mmPerUnit * 1e-3 + 1e-6]);
    }
  }
  const layers: Page['layers'] = [];
  for (const L of page.layers) {
    const c = L.clipPx;
    if (c && vpCenters.some(([x, y, tol]) => Math.abs((c[0] + c[2]) / 2 - x) <= tol && Math.abs((c[1] + c[3]) / 2 - y) <= tol)) {
      layers.push(L);
      continue;
    }
    // 외부 참조 장면은 다른 도면의 핸들이라 고른 객체와 맞춰 볼 수 없다
    if (!own.has(L.scene)) continue;
    const source = filterDisplayList(L.scene.source, L.scene.entities, handles);
    if (!source.entities.length) continue;
    layers.push({ ...L, scene: { ...L.scene, source } as typeof L.scene });
  }
  return { ...page, layers };
}

/** 쪽(mm) → WMF 바이트 */
export function pageToWmf(page: Page): Uint8Array<ArrayBuffer> {
  const { k, inch, w, h } = wmfScale(page.width, page.height, 25.4);
  const out = new WmfWriter(w, h, inch);
  for (const L of page.layers) {
    const styles = L.styles;
    const sink = new WmfSink(out, k, (s) => {
      const r = Math.round(styles[s * 8]! * 255);
      const g = Math.round(styles[s * 8 + 1]! * 255);
      const b = Math.round(styles[s * 8 + 2]! * 255);
      const lw = styles[s * 8 + 4]!;
      return { rgb: (r << 16) | (g << 8) | b, width: lw > 0 ? lw * page.lwScale * k : 0 };
    });
    let clip: [number, number, number, number] | null = L.clipPx ?? null;
    if (L.clipPoly && L.clipPoly.length >= 6) {
      const p = L.clipPoly;
      clip = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 1 < p.length; i += 2) {
        clip[0] = Math.min(clip[0], p[i]!);
        clip[1] = Math.min(clip[1], p[i + 1]!);
        clip[2] = Math.max(clip[2], p[i]!);
        clip[3] = Math.max(clip[3], p[i + 1]!);
      }
    }
    if (clip) {
      out.saveDC();
      out.clipRect(clip[0] * k, clip[1] * k, clip[2] * k, clip[3] * k);
    }
    walk(L.scene.source, L.m, (s) => styles[s * 8 + 5]! > 0, sink, L.clipWorld);
    sink.flush();
    if (clip) out.restoreDC();
  }
  return out.finish();
}

// ---------------------------------------------------------------------------
// IMPORT: 도면 파일 → 블록 정의
// ---------------------------------------------------------------------------

/** 블록 이름으로 쓸 수 있게(AutoCAD 금지 문자 <>/\":;?*|,=` 를 _로) */
export function blockNameOf(fileName: string): string {
  const b = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return b.replace(/[<>/\\":;?*|,=`]/g, '_').trim() || '가져온 도면';
}

const IMPORT_ACCEPT = '.pdf,.dwg,.dxf,.wmf,.sat,.3ds,.dgn,.igs,.iges,.stp,.step,.fbx,.3dm,.PDF,.DWG,.DXF,.WMF';

async function importDrawing(app: App, ctx: CommandContext, file: File): Promise<void> {
  const st = app.active!;
  const doc = st.doc;
  let src;
  try {
    src = (await readDrawingFile(app, file)).doc;
  } catch (e) {
    ctx.print(`${file.name}을(를) 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return;
  } finally {
    app.ui.setBusy(null);
  }
  const name = blockNameOf(file.name);
  const key = tableKey(name);
  const model = (src.blocks.get(MODEL_SPACE)?.entities ?? []).filter((e) => !e.paperSpace);
  if (!model.length) {
    ctx.print(`${file.name}의 모형 공간에 객체가 없습니다.`, 'err');
    return;
  }
  const have = doc.blocks.get(key);
  if (have) {
    const a = await ask('블록 - 재정의', `블록 "${have.name}"이(가) 이미 도면에 있습니다. ${file.name}의 내용으로 재정의할까요?`, [
      { label: '블록 재정의', value: 'redefine', primary: true },
      { label: '기존 정의 사용', value: 'keep' },
      { label: '취소', value: 'cancel' },
    ]);
    if (a === 'cancel' || a === null) return;
    if (a === 'keep') {
      await app.run('INSERT', have.name);
      return;
    }
    if (have.flags & 4 || have.name.startsWith('*')) {
      ctx.print(`블록 "${have.name}"은(는) 다시 정의할 수 없습니다.`, 'err');
      return;
    }
  }
  const s = st.session;
  const cp = new DefinitionCopier(src, doc, () => s.newHandle());
  const recH = have?.recordHandle ?? s.newHandle();
  const ents = cp.entities(model, recH, false);
  const ib = src.header.get('$INSBASE');
  const base: Vec3 = ib && typeof ib === 'object' ? { x: ib.x || 0, y: ib.y || 0, z: 0 } : { x: 0, y: 0, z: 0 };
  const units = Number(src.header.get('$INSUNITS') ?? 0) || 0;
  const ops: EditOp[] = [...cp.finish()];
  if (have) {
    ops.push({ kind: 'blockDef', key, before: have, after: { ...have, basePoint: base, entities: ents } });
    const rec = doc.blockRecords.get(key);
    if (rec) ops.push({ kind: 'blockRecord', key, before: rec, after: { ...rec, insertUnits: units } });
  } else {
    const record: BlockRecord = { name, handle: recH, flags: 0, insertUnits: units, explodable: true, scalable: true };
    const def: BlockDef = { name, handle: s.newHandle(), recordHandle: recH, basePoint: base, flags: 0, entities: ents, endHandle: s.newHandle() };
    ops.unshift({ kind: 'blockRecord', key, before: null, after: record }, { kind: 'blockDef', key, before: null, after: def });
  }
  st.session.commit({ label: 'IMPORT', ops, group: ctx.group });
  const skipped = [...cp.skipped].map(([t, c]) => `${t} ${c}개`).join(', ');
  ctx.print(`${file.name}의 모형 객체 ${ents.length}개로 블록 "${name}"을(를) ${have ? '재정의' : '만들었'}습니다.${skipped ? ` 옮길 수 없는 객체(${skipped})는 뺐습니다.` : ''}`);
  // INSERT 흐름으로 삽입점·축척·회전을 받는다
  await app.run('INSERT', name);
}

export function registerFileExportCommands(app: App, reg: (c: Command) => void): void {
  reg({
    name: 'WMFOUT',
    title: 'Windows 메타파일(WMF)로 내보내기',
    async run(ctx) {
      const st = app.active!;
      const handles = await ctx.getSelection('객체 선택:');
      if (!handles.length) {
        ctx.print('선택된 객체가 없습니다.');
        return;
      }
      const page = await screenPage(app, st);
      if (!page) {
        ctx.print('내보낼 화면이 없습니다.', 'err');
        return;
      }
      const sel = selectedPage(st, page, new Set(handles));
      if (!sel.layers.length) {
        ctx.print('고른 객체가 지금 화면에 그려져 있지 않습니다.', 'err');
        return;
      }
      const data = pageToWmf(sel);
      const name = `${baseName(st.saveName)}.wmf`;
      download(new Blob([data], { type: 'image/wmf' }), name);
      ctx.print(`객체 ${handles.length}개를 ${name}(으)로 저장했습니다(${(data.length / 1024).toFixed(1)} KB, 지금 ${st.onLayout ? '배치 용지' : '화면'} 범위, 래스터 이미지는 빠집니다).`);
    },
  });

  reg({
    name: 'IMPORT',
    aliases: ['IMP'],
    title: '가져오기',
    async run(ctx) {
      const [file] = await pickFiles(IMPORT_ACCEPT, false);
      if (!file) return;
      const ext = (/\.([^.]+)$/.exec(file.name)?.[1] ?? '').toLowerCase();
      if (ext === 'pdf') {
        presetPdfImportFile(file);
        await app.run('PDFIMPORT');
        return;
      }
      if (ext === 'dwg' || ext === 'dxf') {
        await importDrawing(app, ctx, file);
        return;
      }
      const label = ext ? `*.${ext}` : file.name;
      ctx.print(`이 웹 버전은 ${label} 파일을 가져올 수 없습니다. 가져올 수 있는 파일: PDF(*.pdf, PDFIMPORT), 도면(*.dwg, *.dxf — 블록으로 삽입).`, 'err');
    },
  });
}
