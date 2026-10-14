/**
 * 전자 전송: ETRANSMIT("전송 파일 작성").
 * 지금 도면과 이 세션에서 연결해 읽은 외부 참조 도면(중첩 포함)·래스터 이미지·PDF 언더레이·불러온 SHX 글꼴·
 * 플롯 스타일(CTB/STB) 파일을 하나의 zip으로 내려받게 한다(브라우저 안에서 묶고 서버로 보내지 않는다).
 *  - 바뀌는 도면(지금 도면, 형식 변환, 경로를 바꾸는 사본, 결합)만 엔진 저장을 거치고, 나머지 파일은 고른 그대로 넣는다.
 *  - 경로를 바꾸거나 결합하는 것은 패키지의 사본뿐이다: 고친 사본을 워커에 따로 넘겨 쓰고 닫는다(열린 도면은 그대로).
 *  - 이 세션에서 고르지 않은(로드되지 않은) 파일은 "찾을 수 없음"으로 보고서에 적는다.
 */
import type { CadDocument, ImageDefObject, UnderlayDefObject } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from '../edit/session';
import { bindXrefOps } from '../edit/refedit/bind';
import { seedAllocator } from '../edit/refedit/workset';
import { type PackagePlan, type TransmitFormat, type TransmitItem, type TransmitSettings, DEFAULT_SETTINGS, FORMAT_LABELS, baseNameOf, drawingName, kindLabel, planPackage, transmitReport } from '../edit/transmit/plan';
import { type ZipEntry, buildZip } from '../edit/transmit/zip';
import type { App, CommandContext } from './app';
import type { DocState } from './docstate';
import { baseName, download } from './export';
import { xrefOfDoc } from './refs';
import { docSaveFormat, saveDocCopy, workingSetRemovalOps } from './refedit';
import { installFileRegistry, sessionFile } from './sessionfiles';
import { usedShxFonts } from './shxfonts';
import { loadFonts } from './fontstore';
import { dialog, formatBytes, h } from './ui/dom';

type XrefFile = NonNullable<ReturnType<typeof xrefOfDoc>>;

const SETTINGS_KEY = 'opencad.etransmit';

function loadSettings(): TransmitSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<TransmitSettings> | null;
    return { ...DEFAULT_SETTINGS, ...(v ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function storeSettings(s: TransmitSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 이번만 */
  }
}

/** 항목마다 바이트를 얻는 곳과 경로를 바꿀 자리 */
interface Source {
  item: TransmitItem;
  /** 도면 항목: 그 도면(워커 번호) */
  doc?: CadDocument;
  docId?: number;
  /** 원래 바이트(이 세션에서 고른 파일) */
  original?: () => Promise<Uint8Array | null>;
  /** 외부 참조 항목: 소유 도면의 블록 키 */
  blockKey?: string;
  /** 이미지·PDF 항목: 소유 도면의 정의 객체 핸들 */
  objects?: string[];
}

const blobBytes = async (b: Blob | null): Promise<Uint8Array | null> => (b ? new Uint8Array(await b.arrayBuffer()) : null);

/** 패키지에 들 파일 목록(트리 순서) */
async function collect(st: DocState): Promise<Source[]> {
  const out: Source[] = [];
  let serial = 0;
  const ext = st.doc.format === 'dxf' ? '.dxf' : '.dwg';
  const rootName = /\.(dwg|dxf)$/i.test(st.saveName) ? st.saveName : `${st.saveName}${ext}`;
  const root: Source = {
    item: { id: 'root', kind: 'drawing', name: rootName, key: rootName.toLowerCase(), path: '', owner: null, found: true, include: true, depth: 0 },
    doc: st.doc,
    docId: st.docId,
  };
  out.push(root);
  const seen = new Set<string>();
  const docs: CadDocument[] = [st.doc];
  const walk = (doc: CadDocument, owner: string, depth: number) => {
    const xrefs = [...doc.blocks.values()].filter((b) => b.flags & 4).sort((a, b) => a.name.localeCompare(b.name));
    for (const b of xrefs) {
      // 참조 도면 안의 겹침(오버레이)은 함께 로드되지 않는다
      if (depth > 0 && b.flags & 8) continue;
      const stored = b.xrefPath ?? '';
      const name = baseNameOf(stored || `${b.name}.dwg`);
      const file: XrefFile | null = xrefOfDoc(doc, tableKey(b.name));
      const picked = sessionFile(name);
      const id = `n${++serial}`;
      out.push({
        item: { id, kind: 'xref', name, key: name.toLowerCase(), path: stored, owner, found: !!file || !!picked, include: true, depth: depth + 1, note: b.flags & 8 ? '겹침' : undefined },
        doc: file?.doc,
        docId: file?.docId,
        original: picked ? () => blobBytes(picked) : undefined,
        blockKey: tableKey(b.name),
      });
      if (file && !seen.has(name.toLowerCase()) && depth + 1 < 8) {
        seen.add(name.toLowerCase());
        docs.push(file.doc);
        walk(file.doc, id, depth + 1);
      }
    }
    const groups = new Map<string, { kind: 'image' | 'pdf'; path: string; handles: string[] }>();
    for (const o of doc.objects.values()) {
      if (o.type !== 'IMAGEDEF' && o.type !== 'PDFDEFINITION') continue;
      const fn = (o as ImageDefObject | UnderlayDefObject).fileName;
      if (!fn) continue;
      const k = `${o.type}:${baseNameOf(fn).toLowerCase()}`;
      const g = groups.get(k);
      if (g) g.handles.push(o.handle);
      else groups.set(k, { kind: o.type === 'IMAGEDEF' ? 'image' : 'pdf', path: fn, handles: [o.handle] });
    }
    for (const g of [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path))) {
      const name = baseNameOf(g.path);
      const picked = sessionFile(name);
      out.push({
        item: { id: `n${++serial}`, kind: g.kind, name, key: name.toLowerCase(), path: g.path, owner, found: !!picked, include: true, depth: depth + 1 },
        original: picked ? () => blobBytes(picked) : undefined,
        objects: g.handles,
      });
    }
  };
  walk(st.doc, 'root', 0);
  // 글꼴: 이 세션에서 고르거나 이 브라우저에 보관한 SHX
  const fonts = new Set<string>();
  for (const d of docs) for (const f of usedShxFonts(d)) fonts.add(f);
  let stored: Map<string, Uint8Array> | null = null;
  if (fonts.size) {
    try {
      stored = new Map((await loadFonts()).map((f) => [f.name.toLowerCase(), f.data]));
    } catch {
      stored = new Map();
    }
  }
  for (const f of [...fonts].sort()) {
    const picked = sessionFile(f);
    const kept = stored?.get(f.toLowerCase()) ?? null;
    out.push({
      item: { id: `n${++serial}`, kind: 'font', name: f, key: f.toLowerCase(), path: '', owner: 'root', found: !!picked || !!kept, include: true, depth: 1 },
      original: picked ? () => blobBytes(picked) : kept ? async () => kept : undefined,
    });
  }
  // 플롯 스타일 테이블: 배치·페이지 설정이 이름을 대는 것
  const sheets = new Set<string>();
  for (const l of st.doc.layouts) if (l.plot?.styleSheet) sheets.add(l.plot.styleSheet);
  for (const s of [...sheets].sort()) {
    const picked = sessionFile(s);
    out.push({
      item: { id: `n${++serial}`, kind: 'plotstyle', name: s, key: s.toLowerCase(), path: '', owner: 'root', found: !!picked, include: true, depth: 1 },
      original: picked ? () => blobBytes(picked) : undefined,
    });
  }
  return out;
}

function saveFormatFor(doc: CadDocument, f: TransmitFormat): { format: 'dwg' | 'dxf'; version: string; binary: boolean } {
  if (f === 'keep') return docSaveFormat(doc);
  if (f === 'dxf') return { format: 'dxf', version: 'AC1032', binary: false };
  return { format: 'dwg', version: f, binary: false };
}

/** 사본에서 참조 경로를 바꾸는 작업 */
function pathOps(doc: CadDocument, sources: readonly Source[], rewrites: ReadonlyMap<string, string> | undefined): EditOp[] {
  const ops: EditOp[] = [];
  if (!rewrites) return ops;
  for (const s of sources) {
    const p = rewrites.get(s.item.id);
    if (p === undefined) continue;
    if (s.blockKey) {
      const def = doc.blocks.get(s.blockKey);
      if (def) ops.push({ kind: 'blockDef', key: s.blockKey, before: def, after: { ...def, xrefPath: p } });
    }
    for (const h of s.objects ?? []) {
      const o = doc.objects.get(h);
      if (!o) continue;
      const after = { ...o, fileName: p } as ImageDefObject | UnderlayDefObject;
      delete after.dwgRaw;
      ops.push({ kind: 'object', key: h, before: o, after });
    }
  }
  return ops;
}

interface Built {
  blob: Blob;
  name: string;
  report: string;
  plan: PackagePlan;
  entries: { name: string; size: number }[];
}

async function buildPackage(app: App, st: DocState, sources: Source[], settings: TransmitSettings, memo: string): Promise<Built> {
  const items = sources.map((s) => s.item);
  const plan = planPackage(items, settings);
  const zipName = `${baseName(st.saveName)}.zip`;
  const notes: string[] = [];
  const entries: ZipEntry[] = [];
  const now = new Date();
  const byId = new Map(sources.map((s) => [s.item.id, s]));
  const ownedBy = (owner: string) => sources.filter((s) => s.item.owner === owner);
  // 결합(지금 도면의 사본에만)
  const bindOps: EditOp[] = [];
  if (settings.bind) {
    const alloc = seedAllocator(st.doc);
    for (const s of ownedBy('root')) {
      if (s.item.kind !== 'xref' || !s.blockKey) continue;
      const file = xrefOfDoc(st.doc, s.blockKey);
      if (!file) {
        notes.push(`외부 참조 "${s.item.name}"은(는) 로드되지 않아 결합하지 못했습니다(경로만 남은 외부 참조).`);
        continue;
      }
      const r = bindXrefOps(st.doc, s.blockKey, file.doc, alloc.newHandle);
      if (!r) continue;
      bindOps.push(...r.ops);
      if (r.skipped) notes.push(`"${s.item.name}"을(를) 결합할 때 옮길 수 없는 객체 ${r.skipped}개(다중 지시선·이미지·표 등)를 뺐습니다.`);
      if (r.nested) notes.push(`"${s.item.name}" 안의 중첩 외부 참조 ${r.nested}개는 결합 블록에 넣지 않았습니다.`);
    }
    bindOps.push(...alloc.finish());
  }
  await app.edits.flush(st);
  if (workingSetRemovalOps(st).length) notes.push('참조 편집 중이라 지금 도면은 작업 세트 없이(참조는 편집 전 그대로) 넣었습니다.');
  for (const f of plan.files) {
    const s = byId.get(f.item.id);
    if (!s) continue;
    let data: Uint8Array | null = null;
    try {
      if (f.item.kind === 'drawing' || f.item.kind === 'xref') {
        const rewrites = plan.rewrites.get(f.item.id);
        const needCopy = settings.format !== 'keep' || !!rewrites?.size || f.item.id === 'root' || !s.original;
        if (needCopy && s.doc && s.docId !== undefined) {
          // 지금 도면: 참조 편집 중이면 작업 세트를 빼고, 결합·경로 바꾸기는 사본에만
          const ops = [...(f.item.id === 'root' ? [...workingSetRemovalOps(st), ...bindOps] : []), ...pathOps(s.doc, ownedBy(f.item.id), rewrites)];
          const fmt = saveFormatFor(s.doc, settings.format);
          data = ops.length ? (await saveDocCopy(app, s.doc, f.item.name, ops, fmt)).data : (await app.engine.save(s.docId, fmt.format, fmt.version, fmt.binary)).data;
        } else if (s.original) {
          data = await s.original();
          if (needCopy) notes.push(`"${f.item.name}"은(는) 로드되지 않아 고른 파일 그대로 넣었습니다(형식·경로를 바꾸지 못함).`);
        }
      } else if (s.original) data = await s.original();
    } catch (e) {
      notes.push(`"${f.item.name}"을(를) 넣지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (data) entries.push({ name: f.zipPath, data, modified: now });
  }
  if (items.some((i) => i.kind === 'font')) notes.push('글꼴은 이 세션에서 고르거나 이 브라우저에 보관한 SHX 파일만 넣었습니다(트루타입 글꼴은 받는 쪽 컴퓨터의 것을 씁니다).');
  if (settings.format !== 'keep') notes.push(`모든 도면을 ${FORMAT_LABELS[settings.format]} 형식으로 바꿔 넣었습니다.`);
  const report = transmitReport({ items, plan, settings, zipName, date: now, notes, memo });
  if (settings.report) entries.push({ name: `${baseName(st.saveName)}.txt`, data: new TextEncoder().encode('﻿' + report), modified: now });
  const zip = await buildZip(entries);
  return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), name: zipName, report, plan, entries: entries.map((e) => ({ name: e.name, size: e.data.length })) };
}

// ---------------------------------------------------------------------------
// 대화상자
// ---------------------------------------------------------------------------

const STYLE = `
.et-dlg{display:flex;flex-direction:column;gap:8px;min-width:0}
.et-cols{display:flex;gap:12px;flex-wrap:wrap}
.et-col{display:flex;flex-direction:column;gap:6px;flex:1;min-width:240px}
.et-dlg h4{margin:0;font-size:12px;font-weight:600;color:var(--text-dim)}
.et-tree{border:1px solid var(--border-soft);border-radius:4px;background:var(--bg-input);height:240px;overflow:auto;padding:2px 0;font-size:12.5px}
.et-tree label{display:flex;align-items:center;gap:6px;padding:2px 8px;white-space:nowrap;cursor:pointer}
.et-tree label:hover{background:var(--bg-hover)}
.et-tree label.miss{color:var(--text-faint)}
.et-tree .k{color:var(--text-faint);font-size:11px}
.et-tree .st{margin-left:auto;padding-left:10px;font-size:11px;color:var(--text-dim)}
.et-tree label.miss .st{color:var(--danger)}
.et-dlg select,.et-dlg textarea{background:var(--bg-input);color:var(--text);border:1px solid var(--border-soft);border-radius:3px;padding:3px 4px;font:inherit}
.et-dlg textarea{min-height:52px;resize:vertical}
.et-dlg .row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.et-dlg label.ck{display:flex;align-items:center;gap:6px}
.et-sum{font-size:12px;color:var(--text-dim)}
.et-rep{white-space:pre-wrap;font-family:var(--mono);font-size:12px;max-height:60vh;overflow:auto;margin:0;user-select:text}
`;

function ensureStyle(): void {
  if (document.getElementById('et-style')) return;
  const s = document.createElement('style');
  s.id = 'et-style';
  s.textContent = STYLE;
  document.head.append(s);
}

function showReport(text: string, name: string): void {
  ensureStyle();
  const back = dialog('전송 보고서 보기', h('pre', { class: 'et-rep' }, text), [
    { label: '다른 이름으로 저장…', run: () => download(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' }), name) },
    { label: '닫기', primary: true },
  ]);
  (back.querySelector('.dialog') as HTMLElement | null)?.style.setProperty('width', 'min(760px, 100%)');
}

function transmitDialog(st: DocState, sources: Source[], settings: TransmitSettings): Promise<{ settings: TransmitSettings; memo: string } | null> {
  ensureStyle();
  return new Promise((resolve) => {
    let done = false;
    const checks = new Map<string, HTMLInputElement>();
    const tree = h('div', { class: 'et-tree', role: 'tree', 'aria-label': '이 전송에 포함할 파일' });
    const sum = h('div', { class: 'et-sum' });
    const status = (it: TransmitItem) => (it.owner === null ? '주 도면' : it.found ? (it.kind === 'xref' ? '로드됨' : '찾음') : '찾을 수 없음');
    for (const s of sources) {
      const it = s.item;
      const cb = h('input', { type: 'checkbox', 'aria-label': it.name }) as HTMLInputElement;
      cb.checked = it.include && (it.found || it.owner === null);
      cb.disabled = it.owner === null || !it.found;
      cb.addEventListener('change', () => {
        it.include = cb.checked;
        update();
      });
      checks.set(it.id, cb);
      tree.append(
        h(
          'label',
          { class: it.found || it.owner === null ? '' : 'miss', style: `padding-left:${8 + it.depth * 16}px`, title: it.path ? `저장된 경로: ${it.path}` : '' },
          cb,
          it.name,
          h('span', { class: 'k' }, it.owner === null ? '' : `${kindLabel(it.kind)}${it.note ? ` · ${it.note}` : ''}`),
          h('span', { class: 'st' }, status(it)),
        ),
      );
    }
    const sel = (opts: [string, string][], value: string, label: string) => {
      const s = h('select', { 'aria-label': label }, ...opts.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
      s.value = value;
      s.addEventListener('change', update);
      return s;
    };
    const folder = sel(
      [
        ['tree', '트리 유지(저장된 상대 경로대로)'],
        ['flat', '단일 폴더(모든 파일을 하나의 폴더에)'],
      ],
      settings.folder,
      '폴더 유형',
    );
    const format = sel(Object.entries(FORMAT_LABELS) as [string, string][], settings.format, '도면 파일 형식');
    const ck = (label: string, on: boolean) => {
      const c = h('input', { type: 'checkbox', 'aria-label': label }) as HTMLInputElement;
      c.checked = on;
      c.addEventListener('change', update);
      return c;
    };
    const bind = ck('외부 참조를 결합으로 바꾸기', settings.bind);
    const clear = ck('참조 경로 지우기', settings.clearPaths);
    const rep = ck('전송 보고서를 패키지에 넣기', settings.report);
    const memo = h('textarea', { 'aria-label': '이 전송에 대한 메모' }) as HTMLTextAreaElement;
    const read = (): TransmitSettings => ({ folder: folder.value === 'flat' ? 'flat' : 'tree', format: format.value as TransmitFormat, bind: bind.checked, clearPaths: clear.checked, report: rep.checked });
    function update(): void {
      const plan = planPackage(
        sources.map((s) => s.item),
        read(),
      );
      const fmt = read().format;
      const rootName = drawingName(sources[0]!.item.name, fmt);
      sum.textContent = `${baseName(st.saveName)}.zip — 파일 ${plan.files.length}개${read().report ? ' + 보고서' : ''}${plan.missing.length ? `, 찾을 수 없음 ${plan.missing.length}` : ''}${plan.bound.length ? `, 결합 ${plan.bound.length}` : ''} (주 도면 ${rootName})`;
    }
    const body = h(
      'div',
      { class: 'et-dlg' },
      h(
        'div',
        { class: 'et-cols' },
        h('div', { class: 'et-col', style: 'flex:1.4' }, h('h4', {}, '파일 트리 — 이 전송에 포함할 파일:'), tree, sum),
        h(
          'div',
          { class: 'et-col' },
          h('h4', {}, '전송 설정'),
          h('label', { class: 'row' }, '폴더 유형', folder),
          h('label', { class: 'row' }, '도면 파일 형식', format),
          h('label', { class: 'ck', title: '패키지의 지금 도면 사본에서 외부 참조를 블록으로 결합하고 외부 참조 파일은 넣지 않습니다.' }, bind, '외부 참조를 결합으로 바꾸기'),
          h('label', { class: 'ck', title: '패키지의 도면 사본에서 외부 참조·이미지·PDF 경로를 파일 이름만으로 바꿉니다.' }, clear, '참조 경로 지우기(파일 이름만)'),
          h('label', { class: 'ck' }, rep, '전송 보고서(.txt)를 패키지에 넣기'),
          h('h4', {}, '이 전송에 대한 메모 입력:'),
          memo,
        ),
      ),
    );
    body.addEventListener('keydown', (ev) => ev.stopPropagation());
    const back = dialog('전송 파일 작성', body, [
      {
        label: '보고서 보기',
        run: () => {
          const s = read();
          const items = sources.map((x) => x.item);
          showReport(transmitReport({ items, plan: planPackage(items, s), settings: s, zipName: `${baseName(st.saveName)}.zip`, date: new Date(), memo: memo.value }), `${baseName(st.saveName)}.txt`);
          return true;
        },
      },
      { label: '취소', run: () => undefined },
      {
        label: '확인',
        primary: true,
        run: () => {
          done = true;
          resolve({ settings: read(), memo: memo.value });
        },
      },
    ]);
    (back.querySelector('.dialog') as HTMLElement | null)?.style.setProperty('width', 'min(760px, 100%)');
    const obs = new MutationObserver(() => {
      if (!back.isConnected) {
        obs.disconnect();
        if (!done) resolve(null);
      }
    });
    obs.observe(document.body, { childList: true });
    update();
  });
}

// ---------------------------------------------------------------------------
// 명령
// ---------------------------------------------------------------------------

async function runTransmit(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  if (st.blockEdit) {
    ctx.print('블록 편집기에서는 전송할 수 없습니다. 먼저 BCLOSE로 닫으십시오.', 'err');
    return;
  }
  const sources = await collect(st);
  const v = await transmitDialog(st, sources, loadSettings());
  if (!v) return;
  storeSettings(v.settings);
  ctx.print('전송 패키지를 만드는 중…');
  app.ui.setBusy('전송 패키지를 만드는 중…', 0.5);
  let built: Built;
  try {
    built = await buildPackage(app, st, sources, v.settings, v.memo);
  } catch (e) {
    ctx.print(`전송 패키지를 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return;
  } finally {
    app.ui.setBusy(null);
  }
  download(built.blob, built.name);
  const total = built.entries.reduce((n, e) => n + e.size, 0);
  ctx.print(`${built.name}을(를) 만들었습니다(파일 ${built.entries.length}개, 압축 전 ${formatBytes(total)}, zip ${formatBytes(built.blob.size)}).`);
  if (built.plan.missing.length) ctx.print(`찾을 수 없는 파일 ${built.plan.missing.length}개: ${built.plan.missing.slice(0, 5).map((i) => i.name).join(', ')}${built.plan.missing.length > 5 ? ' …' : ''} — 보고서에 적었습니다.`, 'err');
}

export function registerTransmitCommands(app: App): void {
  installFileRegistry();
  app.register({ name: 'ETRANSMIT', title: '전자 전송', run: (ctx) => runTransmit(app, ctx) });
}

/** 시험·자동화용: 대화상자 없이 패키지를 만든다 */
export async function transmitPackage(app: App, settings: Partial<TransmitSettings> = {}, memo = ''): Promise<Built> {
  const st = app.active!;
  const sources = await collect(st);
  return buildPackage(app, st, sources, { ...loadSettings(), ...settings }, memo);
}

