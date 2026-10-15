/**
 * LAYOUT(-LAYOUT)의 템플릿(T)과 다른 이름으로 저장(SA).
 * - T: 고른 .dwt·.dwg·.dxf 파일의 배치를 이 도면으로 가져온다. 종이 공간 객체·뷰포트·플롯 설정과, 그 객체가 쓰는 도면층·선종류·
 *   문자 스타일·치수 스타일·블록이 함께 온다(이 도면에 같은 이름이 있으면 이 도면의 정의를 쓴다 — 디자인센터와 같은 복사기).
 *   대화상자 모드면 파일 고르기 상자와 배치 고르기 상자, 스크립트·FILEDIA 0이면 이름으로 묻는다(브라우저는 경로로 파일을 열 수
 *   없어 이번 세션에 연 도면·읽은 도면·고른 파일만 찾는다). 같은 이름의 배치가 있으면 "이름 (2)"로 넣는다. 한 번이 명령 취소 한 단계.
 * - SA: 배치 하나를 새 도면 파일로 내려받는다(.dwt·.dwg = DWG 2018, .dxf = DXF 2018). AutoCAD처럼 모형 공간 객체와 다른 배치는
 *   넣지 않고 쓰이지 않는 블록·도면층·선종류·문자 스타일·치수 스타일은 뺀다. 고른 배치는 새 도면의 활성 배치(*Paper_Space)가 된다.
 */
import type { CadDocument, DictionaryObject, LayoutObject } from '../core/model';
import { MODEL_SPACE, PAPER_SPACE, normalizeHandle, tableKey } from '../core/model';
import { DefinitionCopier } from '../edit/layertools/clone';
import { purgeUnused, rebuildIndex } from '../edit/util/wblock';
import { groupDictionary } from '../edit/util/groups';
import { wcmatch } from '../edit/lisp/text';
import type { EditOp } from '../edit/session';
import type { App, CommandContext } from './app';
import { loadedDrawings, pickFiles } from './drawingfiles';
import { baseName, download } from './export';
import { fileNameMode } from './script';
import { sessionFile } from './sessionfiles';
import { form } from './ui/dom';

/** 파일 내려받기(시험이 바꿔 끼운다) */
export const layoutFileIO = {
  download: (blob: Blob, name: string): void => download(blob, name),
};

const TEMPLATE_EXT = /\.(dwt|dwg|dxf|dws)$/i;

/** 종이 배치(탭 순서) */
function paperLayouts(doc: CadDocument) {
  return [...doc.layouts].filter((l) => tableKey(l.blockName) !== MODEL_SPACE).sort((a, b) => a.tabOrder - b.tabOrder);
}

// --------------------------------------------------------------------------- 템플릿(T)

/** 가져올 배치 이름 → 이 도면에 넣을 이름(같은 이름이 있으면 "이름 (2)") */
function freeName(dst: CadDocument, name: string, taken: Set<string>): string {
  const used = (n: string) => dst.layouts.some((l) => tableKey(l.name) === tableKey(n)) || taken.has(tableKey(n));
  if (!used(name)) return name;
  for (let i = 2; ; i++) if (!used(`${name} (${i})`)) return `${name} (${i})`;
}

/**
 * 원본 도면의 배치들을 이 도면에 넣는 작업(화면·DOM 없음). 같은 이름이 있으면 이름을 바꿔 넣는다.
 * added: 원본 이름 → 넣은 이름
 */
export function importLayoutOps(dst: CadDocument, src: CadDocument, names: readonly string[], newHandle: () => string): { ops: EditOp[]; added: { from: string; to: string }[] } {
  const taken = new Set<string>();
  const added: { from: string; to: string }[] = [];
  // 이름을 바꿀 배치는 원본의 얕은 사본에서 바꾼 이름으로 찾게 한다(원본 문서는 그대로)
  const rename = new Map<string, string>();
  for (const n of names) {
    const l = paperLayouts(src).find((x) => tableKey(x.name) === tableKey(n));
    if (!l) continue;
    const to = freeName(dst, l.name, taken);
    taken.add(tableKey(to));
    if (to !== l.name) rename.set(l.handle, to);
    added.push({ from: l.name, to });
  }
  const view: CadDocument = rename.size ? { ...src, layouts: src.layouts.map((l) => (rename.has(l.handle) ? { ...l, name: rename.get(l.handle)! } : l)) } : src;
  const cp = new DefinitionCopier(view, dst, newHandle);
  for (const a of added) cp.copy('layout', a.to);
  return { ops: cp.finish(), added };
}

/** 이름으로 템플릿 도면 찾기: 열린 도면, 이번 세션에 읽은 도면, 고른 파일 */
export async function findTemplate(app: App, name: string): Promise<{ name: string; doc: CadDocument } | null> {
  const key = (n: string) => n.trim().replace(/^"|"$/g, '').replace(/^.*[\\/]/, '').toLowerCase();
  const k = key(name);
  if (!k) return null;
  const bare = k.replace(TEMPLATE_EXT, '');
  const same = (n: string) => {
    const x = key(n);
    return x === k || (x.replace(TEMPLATE_EXT, '') === bare && (k === bare || TEMPLATE_EXT.test(k)));
  };
  for (const d of app.docs) if (same(d.name) || same(d.saveName)) return { name: d.saveName, doc: d.doc };
  for (const l of loadedDrawings()) if (same(l.name)) return { name: l.name, doc: l.doc };
  for (const cand of [k, `${bare}.dwt`, `${bare}.dwg`, `${bare}.dxf`]) {
    const blob = sessionFile(cand);
    if (!blob) continue;
    // 보이는 이름: 고른 파일의 이름(없으면 입력한 이름 + 찾은 확장자)
    const typed = name.trim().replace(/^"|"$/g, '').replace(/^.*[\\/]/, '');
    const shown = (blob as File).name || (TEMPLATE_EXT.test(typed) ? typed : typed + cand.slice(bare.length));
    app.ui?.setBusy?.(`${shown} 읽는 중…`, 0.3);
    try {
      const res = await app.engine.open(shown, await blob.arrayBuffer());
      app.engine.closeDoc(res.docId);
      return { name: shown, doc: res.doc };
    } finally {
      app.ui?.setBusy?.(null);
    }
  }
  return null;
}

/** 배치 이름 입력(쉼표로 여럿, 와일드카드 *·?) → 원본 배치 이름 */
function matchLayouts(doc: CadDocument, text: string): string[] {
  const all = paperLayouts(doc).map((l) => l.name);
  const out: string[] = [];
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) for (const n of all) if (!out.includes(n) && wcmatch(n, part, true)) out.push(n);
  return out;
}

async function askTemplateByName(app: App, ctx: CommandContext): Promise<{ name: string; doc: CadDocument } | null> {
  const r = await ctx.getPoint('템플릿 파일 이름 입력:', { allowText: true });
  if (!('text' in r) || !r.text.trim()) return null;
  const t = await findTemplate(app, r.text);
  if (!t) ctx.print(`템플릿 파일 "${r.text.trim()}"을(를) 찾을 수 없습니다. 이 웹 버전은 경로로 파일을 열 수 없어 이번 세션에 연 도면·고른 파일만 이름으로 찾습니다.`, 'err');
  return t;
}

async function pickTemplateFile(app: App, ctx: CommandContext): Promise<{ name: string; doc: CadDocument } | null> {
  const f = (await pickFiles('.dwt,.dwg,.dxf,.DWT,.DWG,.DXF', false))[0];
  if (!f) return null;
  app.ui.setBusy(`${f.name} 읽는 중…`, 0.3);
  try {
    const res = await app.engine.open(f.name, await f.arrayBuffer());
    app.engine.closeDoc(res.docId);
    return { name: f.name, doc: res.doc };
  } catch (e) {
    ctx.print(`${f.name}을(를) 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return null;
  } finally {
    app.ui.setBusy(null);
  }
}

/** LAYOUT T */
export async function layoutTemplate(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  const byName = fileNameMode(app);
  const tpl = byName ? await askTemplateByName(app, ctx) : await pickTemplateFile(app, ctx);
  if (!tpl) return;
  const avail = paperLayouts(tpl.doc).map((l) => l.name);
  if (!avail.length) {
    ctx.print(`"${tpl.name}"에 배치가 없습니다.`, 'err');
    return;
  }
  let names: string[] = [];
  if (byName) {
    for (;;) {
      const r = await ctx.getPoint(`배치 이름 입력 또는 [?] <${avail[0]}>:`, { allowText: true });
      if ('enter' in r) names = [avail[0]!];
      else if ('text' in r || 'keyword' in r) {
        const t = ('text' in r ? r.text : r.keyword).trim();
        if (t === '?') {
          ctx.print(`"${tpl.name}"의 배치: ${avail.join(', ')}`, 'res');
          continue;
        }
        names = matchLayouts(tpl.doc, t);
        if (!names.length) {
          ctx.print(`배치 "${t}"이(가) "${tpl.name}"에 없습니다.`, 'err');
          return;
        }
      } else return;
      break;
    }
  } else if (avail.length === 1) names = avail;
  else {
    const v = await form(
      '배치 삽입',
      avail.map((n, i) => ({ key: `l${i}`, label: n, type: 'check' as const, value: i === 0 })),
      { ok: '확인', note: `템플릿 "${tpl.name}"에서 가져올 배치를 고르십시오.`, validate: (x) => (Object.values(x).some(Boolean) ? null : '배치를 하나 이상 고르십시오.') },
    );
    if (!v) return;
    names = avail.filter((_, i) => v[`l${i}`]);
  }
  await app.edits.flush(st);
  const { ops, added } = importLayoutOps(st.doc, tpl.doc, names, () => st.session.newHandle());
  if (!ops.length) {
    ctx.print('가져온 배치가 없습니다.', 'err');
    return;
  }
  st.session.commit({ label: 'LAYOUT', ops, group: ctx.group });
  app.ui?.refreshLayouts?.();
  for (const a of added) ctx.print(a.from === a.to ? `배치 "${a.to}"을(를) "${tpl.name}"에서 가져왔습니다.` : `배치 "${a.from}"을(를) "${tpl.name}"에서 "${a.to}"(으)로 가져왔습니다(같은 이름의 배치가 있음).`);
}

// --------------------------------------------------------------------------- 다른 이름으로 저장(SA)

/** 배치 하나만 든 새 도면(원본은 그대로). 모형 공간·다른 배치는 비우고 쓰이지 않는 정의는 뺀다 */
export function layoutTemplateDocument(src: CadDocument, layoutName: string): CadDocument {
  const out: CadDocument = structuredClone(src);
  out.warnings = [];
  const lay = out.layouts.find((l) => tableKey(l.name) === tableKey(layoutName) && tableKey(l.blockName) !== MODEL_SPACE);
  if (!lay) throw new Error(`배치 "${layoutName}"이(가) 없습니다.`);
  const model = out.blocks.get(MODEL_SPACE);
  if (model) model.entities = [];
  const dicts = [...out.objects.values()].filter((o): o is DictionaryObject => o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT');
  for (const l of out.layouts) {
    const k = tableKey(l.blockName);
    if (k === MODEL_SPACE || l === lay) continue;
    out.blocks.delete(k);
    out.blockRecords.delete(k);
    out.objects.delete(normalizeHandle(l.handle));
    out.objects.delete(l.handle);
    for (const d of dicts) for (const [n, h] of [...d.entries]) if (normalizeHandle(h) === normalizeHandle(l.handle)) d.entries.delete(n);
  }
  out.layouts = out.layouts.filter((l) => tableKey(l.blockName) === MODEL_SPACE || l === lay);
  // 고른 배치를 활성 배치(*Paper_Space)로
  const k = tableKey(lay.blockName);
  if (k !== PAPER_SPACE) {
    const def = out.blocks.get(k);
    const rec = out.blockRecords.get(k);
    out.blocks.delete(k);
    out.blockRecords.delete(k);
    out.blocks.delete(PAPER_SPACE);
    out.blockRecords.delete(PAPER_SPACE);
    if (def) out.blocks.set(PAPER_SPACE, { ...def, name: '*Paper_Space' });
    if (rec) out.blockRecords.set(PAPER_SPACE, { ...rec, name: '*Paper_Space' });
    lay.blockName = '*Paper_Space';
  }
  lay.tabOrder = 1;
  const lo = out.objects.get(normalizeHandle(lay.handle)) ?? out.objects.get(lay.handle);
  if (lo?.type === 'LAYOUT') (lo as LayoutObject).layout = lay;
  // 그룹은 넣지 않는다(모형 객체를 가리킨다)
  const gd = groupDictionary(out);
  if (gd) {
    for (const h of gd.entries.values()) out.objects.delete(normalizeHandle(h));
    gd.entries.clear();
  }
  purgeUnused(out);
  rebuildIndex(out);
  for (const b of out.blocks.values())
    for (const e of b.entities)
      if (e.reactors?.length) {
        const r = e.reactors.filter((h) => out.objects.has(normalizeHandle(h)) || out.entityIndex.has(normalizeHandle(h)));
        e.reactors = r.length ? r : undefined;
      }
  return out;
}

/** 저장 형식(확장자) */
function formatOf(name: string): { format: 'dwg' | 'dxf'; ext: string } {
  const m = /\.(dwt|dwg|dxf)$/i.exec(name);
  const ext = m ? m[1]!.toLowerCase() : 'dwt';
  return { format: ext === 'dxf' ? 'dxf' : 'dwg', ext };
}

/** LAYOUT SA */
export async function layoutSaveAs(app: App, ctx: CommandContext, curName: string): Promise<void> {
  const st = app.active!;
  const r = await ctx.getPoint(`템플릿에 저장할 배치 입력 <${curName}>:`, { allowText: true });
  const lname = 'text' in r && r.text.trim() ? r.text.trim() : 'enter' in r ? curName : '';
  const lay = paperLayouts(st.doc).find((l) => tableKey(l.name) === tableKey(lname));
  if (!lay) {
    ctx.print(`배치 "${lname}"이(가) 없습니다.`, 'err');
    return;
  }
  const def = `${lay.name}.dwt`;
  let fname: string;
  if (fileNameMode(app)) {
    const f = await ctx.getPoint(`도면 템플릿 파일 이름 입력 <${def}>:`, { allowText: true });
    fname = 'text' in f && f.text.trim() ? f.text.trim().replace(/^"|"$/g, '').replace(/^.*[\\/]/, '') : 'enter' in f ? def : '';
    if (!fname) return;
  } else {
    const v = await form(
      '도면 파일 작성',
      [
        { key: 'name', label: '파일 이름', type: 'text', value: lay.name, wide: true },
        {
          key: 'type',
          label: '파일 유형',
          type: 'select',
          value: 'dwt',
          options: [
            { value: 'dwt', label: 'AutoCAD 도면 템플릿 (*.dwt)' },
            { value: 'dwg', label: 'AutoCAD 2018 도면 (*.dwg)' },
            { value: 'dxf', label: 'AutoCAD 2018 DXF (*.dxf)' },
          ],
        },
      ],
      { ok: '저장', note: `배치 "${lay.name}"만 든 새 도면을 이 컴퓨터에 내려받습니다(모형 공간 객체는 넣지 않습니다).`, validate: (x) => (String(x.name ?? '').trim() ? null : '파일 이름을 입력하십시오.') },
    );
    if (!v) return;
    fname = `${baseName(String(v.name).trim()).replace(/\.dwt$/i, '')}.${String(v.type)}`;
  }
  if (!/\.(dwt|dwg|dxf)$/i.test(fname)) fname += '.dwt';
  const { format } = formatOf(fname);
  await app.edits.flush(st);
  let doc: CadDocument;
  try {
    doc = layoutTemplateDocument(st.doc, lay.name);
  } catch (e) {
    ctx.print(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return;
  }
  let docId = -1;
  try {
    docId = (await app.engine.adopt(fname, doc)).docId;
    const res = await app.engine.save(docId, format, 'AC1032', false);
    layoutFileIO.download(new Blob([res.data as BlobPart], { type: format === 'dxf' ? 'application/dxf' : 'application/acad' }), fname);
    ctx.print(`배치 "${lay.name}"을(를) ${fname}(으)로 저장했습니다(${(res.data.byteLength / 1024).toFixed(0)} KB).`);
  } catch (e) {
    ctx.print(`저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
  } finally {
    if (docId >= 0) app.engine.closeDoc(docId);
  }
}
