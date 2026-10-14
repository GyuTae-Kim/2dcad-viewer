/**
 * 외부 참조 창(EXTERNALREFERENCES·XR): 도면이 쓰는 래스터 이미지·외부 참조(DWG)·PDF 참고와 그 상태.
 * 브라우저는 도면에 적힌 경로를 열 수 없으므로, 사용자가 고른 폴더·파일에서 같은 이름의 파일을 찾아 연결한다.
 * 파일은 서버로 보내지 않는다.
 */
import type { CadDocument, ImageDefObject, UnderlayDefObject } from '../core/model';
import { tableKey } from '../core/model';
import type { DisplayList } from '../render/displaylist';
import { pdfPageNumber } from '../render/build';
import type { LayerState } from '../render/styles';
import { SpaceScene } from './scene';
import type { App } from './app';
import type { DocState } from './docstate';
import { dialog, h, toast } from './ui/dom';

export interface RefItem {
  kind: 'image' | 'xref' | 'pdf';
  name: string;
  /** 도면에 적힌 경로 */
  path: string;
  /** 연결에 쓰는 열쇠(파일 이름 소문자) */
  key: string;
  found: boolean;
}

const baseKey = (p: string) => p.replace(/^.*[\\/]/, '').toLowerCase();

/** 연결한 이미지 원본(그래픽 문맥을 되찾을 때 다시 올린다). PDF 페이지는 'pdf:파일#쪽' 열쇠 */
const bitmaps = new Map<string, ImageBitmap>();
/** 연결한 PDF 파일(파일 이름 소문자 → 바이트). 나중에 연 도면이 다른 페이지를 쓰면 그때 그린다 */
const pdfData = new Map<string, Uint8Array>();

const pdfKeyOf = (u: UnderlayDefObject) => `pdf:${baseKey(u.fileName)}#${pdfPageNumber(u.name)}`;

/** 연결한 외부 참조 파일(열쇠 = 파일 이름 소문자): 워커 문서와 모형 장면 */
interface XrefFile {
  name: string;
  docId: number;
  doc: CadDocument;
  scene: SpaceScene;
  layers: LayerState[];
}
const xrefFiles = new Map<string, XrefFile>();

/** 호스트 도면의 외부 참조 블록 → 연결한 참조 파일 */
export function xrefOfDoc(doc: CadDocument, blockKey: string): XrefFile | null {
  const b = doc.blocks.get(blockKey);
  if (!b || !(b.flags & 4)) return null;
  return xrefFiles.get(baseKey(b.xrefPath || `${b.name}.dwg`)) ?? null;
}

type M6 = [number, number, number, number, number, number];

/** 목록 좌표에 놓인 외부 참조 하나(중첩 참조는 펼친다) */
export interface XrefPlacement {
  file: XrefFile;
  /** 참조 모형 → 목록 좌표 */
  m: M6;
  /** 가장 바깥 XCLIP 경계(목록 좌표) */
  clip?: number[];
  /** 호스트의 `참조|도면층` 상태와 뷰포트 동결을 반영한 도면층(장면 순서) */
  layers: LayerState[];
  /** 스타일 표 캐시 열쇠 */
  key: string;
}

const MAX_NEST = 8;

const compose = (A: readonly number[], B: readonly number[]): M6 => [
  A[0]! * B[0]! + A[2]! * B[1]!,
  A[1]! * B[0]! + A[3]! * B[1]!,
  A[0]! * B[2]! + A[2]! * B[3]!,
  A[1]! * B[2]! + A[3]! * B[3]!,
  A[0]! * B[4]! + A[2]! * B[5]! + A[4]!,
  A[1]! * B[4]! + A[3]! * B[5]! + A[5]!,
];

/** 참조 파일의 도면층에 호스트 재지정(`블록이름|도면층`)과 뷰포트 동결을 입힌다 */
function hostLayers(st: DocState, file: XrefFile, prefix: string, vpFrozen?: ReadonlySet<string>): LayerState[] {
  return file.layers.map((l) => {
    const n = tableKey(l.name);
    if (n === '0' || n === 'DEFPOINTS') return l;
    const hk = tableKey(`${prefix}|${l.name}`);
    const h = st.layers.get(hk);
    let out = h ? { ...l, on: h.on, frozen: h.frozen, rgb: h.rgb, aci: h.aci, hasRgb: h.hasRgb, lineweight: h.lineweight, transparency: h.transparency, plot: h.plot } : l;
    if (vpFrozen?.has(hk)) out = { ...out, frozen: true };
    return out;
  });
}

/**
 * 표시 목록의 외부 참조 인스턴스를 펼친다. visible(스타일)이 거짓인 인스턴스(꺼진 도면층 등)는 뺀다.
 * 중첩 참조는 덮어씌우기(블록 플래그 8)가 아닐 때만, 같은 파일이 다시 나오면 멈춘다.
 */
export function xrefPlacements(st: DocState, list: DisplayList, visible: (style: number) => boolean, vpFrozen?: ReadonlySet<string>): XrefPlacement[] {
  const out: XrefPlacement[] = [];
  const vf = vpFrozen?.size ? [...vpFrozen].sort().join(',') : '';
  const walk = (doc: CadDocument, l: DisplayList, base: M6 | null, clip: number[] | undefined, vis: (style: number) => boolean, chain: string[], depth: number) => {
    for (const x of l.xrefs ?? []) {
      if (!vis(x.style)) continue;
      const blk = doc.blocks.get(x.key);
      if (!blk || !(blk.flags & 4) || (depth > 0 && blk.flags & 8)) continue;
      const fk = baseKey(blk.xrefPath || `${blk.name}.dwg`);
      const file = xrefFiles.get(fk);
      if (!file || chain.includes(fk)) continue;
      const m = base ? compose(base, x.m) : ([...x.m] as M6);
      let c = clip;
      if (!c && x.clip && x.clip.length >= 6 && !x.clipInverted) c = base ? x.clip.map((v, i) => (i & 1 ? base[1] * x.clip![i - 1]! + base[3] * v + base[5] : base[0] * v + base[2] * x.clip![i + 1]! + base[4])) : x.clip;
      const key = `xref|${st.docId}|${[...chain, fk].join('>')}|${blk.name}|${st.layerVersion}|${vf}`;
      const layers = hostLayers(st, file, blk.name, vpFrozen);
      out.push({ file, m, clip: c, layers, key });
      if (depth + 1 < MAX_NEST && file.scene.source.xrefs?.length) {
        const styles = file.scene.styleData(layers, `${key}|vis`, false, 0xffffff, false);
        walk(file.doc, file.scene.source, m, c, (sty) => styles[sty * 8 + 5]! > 0, [...chain, fk], depth + 1);
      }
    }
  };
  walk(st.doc, list, null, undefined, visible, [], 0);
  return out;
}

/** 열린 도면이 쓰는 참조 파일의 키(중첩 포함, 연결된 것을 따라간다) */
function wantedXrefKeys(app: App): Set<string> {
  const keys = new Set<string>();
  const visit = (doc: CadDocument, depth: number) => {
    for (const b of doc.blocks.values()) {
      if (!(b.flags & 4)) continue;
      const k = baseKey(b.xrefPath || `${b.name}.dwg`);
      if (keys.has(k)) continue;
      keys.add(k);
      const f = xrefFiles.get(k);
      if (f && depth < MAX_NEST) visit(f.doc, depth + 1);
    }
  };
  for (const st of app.docs) visit(st.doc, 0);
  return keys;
}

/**
 * VISRETAIN = 0이면 호스트에 저장된 `참조|도면층` 상태 대신 참조 파일의 상태를 쓴다(연결할 때 맞춘다).
 */
export function syncXrefLayers(st: DocState): void {
  if (st.doc.header.get('$VISRETAIN') !== 0) return;
  let changed = false;
  for (const b of st.doc.blocks.values()) {
    if (!(b.flags & 4)) continue;
    const file = xrefFiles.get(baseKey(b.xrefPath || `${b.name}.dwg`));
    if (!file) continue;
    for (const l of file.layers) {
      const hk = tableKey(`${b.name}|${l.name}`);
      const h = st.layers.get(hk);
      if (!h) continue;
      Object.assign(h, { on: l.on, frozen: l.frozen, rgb: l.rgb, aci: l.aci, hasRgb: l.hasRgb, lineweight: l.lineweight, transparency: l.transparency, plot: l.plot });
      changed = true;
    }
  }
  if (changed) st.touchLayers();
}

/**
 * 연결한 외부 참조의 범위를 블록 참조의 범위와 공간 범위에 넣는다(범위 확대·창 선택·출력 범위).
 * 장면을 새로 만들 때마다 다시 부른다.
 */
export function expandXrefBounds(app: App, st: DocState, space?: string): void {
  for (const [key, sc] of st.scenes) {
    if (space && key !== space) continue;
    let changed = false;
    for (const x of sc.source.xrefs ?? []) {
      const e = xrefOfDoc(st.doc, x.key);
      const b = e?.scene.bounds;
      if (!b) continue;
      const [a, bb, c, d, ex, fy] = x.m;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [px, py] of [
        [b.minX, b.minY],
        [b.maxX, b.minY],
        [b.maxX, b.maxY],
        [b.minX, b.maxY],
      ] as const) {
        const X = a * px + c * py + ex;
        const Y = bb * px + d * py + fy;
        minX = Math.min(minX, X);
        minY = Math.min(minY, Y);
        maxX = Math.max(maxX, X);
        maxY = Math.max(maxY, Y);
      }
      const box = sc.boxOf(x.handle);
      if (box) {
        box.minX = Math.min(box.minX, minX);
        box.minY = Math.min(box.minY, minY);
        box.maxX = Math.max(box.maxX, maxX);
        box.maxY = Math.max(box.maxY, maxY);
      }
      const sb = sc.bounds ?? { minX, minY, maxX, maxY };
      sc.bounds = { minX: Math.min(sb.minX, minX), minY: Math.min(sb.minY, minY), maxX: Math.max(sb.maxX, maxX), maxY: Math.max(sb.maxY, maxY) };
      changed = true;
    }
    if (changed) app.resetPicker(st, key);
  }
}

/** 고른 파일 중 외부 참조(DWG·DXF)를 연다. 연결한 파일 이름들 */
export async function linkXrefFiles(app: App, files: File[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    if (!/\.(dwg|dxf)$/i.test(f.name)) continue;
    const key = f.name.toLowerCase();
    try {
      const res = await app.engine.open(f.name, await f.arrayBuffer());
      const old = xrefFiles.get(key);
      if (old) {
        old.scene.dispose(app.view.renderer);
        app.engine.closeDoc(old.docId);
      }
      xrefFiles.set(key, { name: f.name, docId: res.docId, doc: res.doc, scene: new SpaceScene(app.view.renderer, res.model, '*MODEL_SPACE'), layers: res.model.layers });
      out.push(f.name);
    } catch (e) {
      app.cmd.print(`${f.name}: 외부 참조를 열지 못했습니다(${e instanceof Error ? e.message : String(e)}).`, 'err');
    }
  }
  if (out.length) {
    for (const st of app.docs) {
      syncXrefLayers(st);
      expandXrefBounds(app, st);
    }
    app.view.requestRender();
  }
  return out;
}

export function docRefs(app: App, doc: CadDocument): RefItem[] {
  const out: RefItem[] = [];
  for (const o of doc.objects.values()) {
    if (o.type === 'IMAGEDEF') {
      const f = (o as ImageDefObject).fileName;
      const key = baseKey(f);
      if (key && !out.some((r) => r.kind === 'image' && r.key === key)) out.push({ kind: 'image', name: key, path: f, key, found: app.imageKeys.has(key) });
    } else if (o.type === 'PDFDEFINITION') {
      const u = o as UnderlayDefObject;
      const key = baseKey(u.fileName);
      const page = pdfPageNumber(u.name);
      const name = `${key}${page > 1 ? ` (${page}쪽)` : ''}`;
      if (key && !out.some((r) => r.kind === 'pdf' && r.name === name)) out.push({ kind: 'pdf', name, path: u.fileName, key, found: app.pdfPages.has(pdfKeyOf(u)) });
    }
  }
  for (const b of doc.blocks.values())
    if (b.flags & 4) {
      const key = baseKey(b.xrefPath || b.name + '.dwg');
      out.push({ kind: 'xref', name: b.name, path: b.xrefPath ?? '', key, found: b.entities.length > 0 || xrefFiles.has(key) });
    }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;

/** 고른 파일 중 이미지를 연결한다. 연결한 수 */
export async function linkImageFiles(app: App, files: File[]): Promise<{ linked: string[]; unsupported: string[] }> {
  const linked: string[] = [];
  const unsupported: string[] = [];
  const max = Math.min(8192, (app.view.renderer.gl.getParameter(app.view.renderer.gl.MAX_TEXTURE_SIZE) as number) || 4096);
  for (const f of files) {
    const key = f.name.toLowerCase();
    if (!IMAGE_EXT.test(f.name)) {
      if (/\.(tiff?|jp2|ecw|mrsid|sid)$/i.test(f.name)) unsupported.push(f.name);
      continue;
    }
    try {
      let bmp = await createImageBitmap(f);
      if (bmp.width > max || bmp.height > max) {
        const k = max / Math.max(bmp.width, bmp.height);
        const small = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(bmp.width * k)), resizeHeight: Math.max(1, Math.round(bmp.height * k)), resizeQuality: 'high' });
        bmp.close();
        bmp = small;
      }
      bitmaps.get(key)?.close();
      bitmaps.set(key, bmp);
      pixelCache.delete(key);
      urlCache.delete(key);
      app.view.renderer.setImage(key, bmp);
      app.imageKeys.add(key);
      linked.push(f.name);
    } catch {
      unsupported.push(f.name);
    }
  }
  if (linked.length) {
    app.engine.images([...app.imageKeys], app.pdfPages);
    for (const st of app.docs) app.edits.rebuildEverything(st);
  }
  return { linked, unsupported };
}

/** 고른 파일 중 PDF를 연결하고, 열린 도면들이 쓰는 페이지를 그린다 */
export async function linkPdfFiles(app: App, files: File[]): Promise<{ linked: string[]; failed: string[] }> {
  const linked: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) continue;
    const key = f.name.toLowerCase();
    pdfData.set(key, new Uint8Array(await f.arrayBuffer()));
    // 같은 이름을 다시 고르면 페이지를 새로 그린다
    for (const k of [...app.pdfPages.keys()]) if (k.startsWith(`pdf:${key}#`)) app.pdfPages.delete(k);
    linked.push(f.name);
  }
  if (linked.length) failed.push(...(await renderPdfPages(app)).failed);
  return { linked: linked.filter((n) => !failed.includes(n)), failed };
}

/** 열린 도면들이 쓰는 PDF 페이지 중 파일이 있고 아직 그리지 않은 것을 그린다 */
export async function renderPdfPages(app: App): Promise<{ rendered: number; failed: string[] }> {
  const want = new Map<string, Set<number>>();
  for (const st of app.docs)
    for (const o of st.doc.objects.values()) {
      if (o.type !== 'PDFDEFINITION') continue;
      const u = o as UnderlayDefObject;
      const fk = baseKey(u.fileName);
      if (!pdfData.has(fk) || app.pdfPages.has(pdfKeyOf(u))) continue;
      let set = want.get(fk);
      if (!set) want.set(fk, (set = new Set()));
      set.add(pdfPageNumber(u.name));
    }
  if (!want.size) return { rendered: 0, failed: [] };
  const failed: string[] = [];
  let rendered = 0;
  app.ui.setBusy('PDF 페이지 그리는 중…', 0.5);
  try {
    const r = await import('./pdfraster');
    const gl = app.view.renderer.gl;
    const max = Math.min(4096, (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096);
    for (const [fk, pages] of want) {
      let opened;
      try {
        opened = await r.openPdf(pdfData.get(fk)!);
      } catch {
        failed.push(fk);
        pdfData.delete(fk);
        continue;
      }
      try {
        for (const n of pages) {
          const key = `pdf:${fk}#${n}`;
          const page = await r.rasterPage(opened.pdf, n, max).catch(() => null);
          if (!page) continue;
          bitmaps.get(key)?.close();
          bitmaps.set(key, page.bitmap);
          pixelCache.delete(key);
          urlCache.delete(key);
          app.view.renderer.setImage(key, page.bitmap);
          app.imageKeys.add(key);
          app.pdfPages.set(key, [page.width, page.height]);
          rendered++;
        }
      } finally {
        void opened.close();
      }
    }
  } catch (e) {
    app.cmd.print(`PDF를 그리지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
  } finally {
    app.ui.setBusy(null);
  }
  if (rendered) {
    app.engine.images([...app.imageKeys], app.pdfPages);
    for (const st of app.docs) app.edits.rebuildEverything(st);
  }
  return { rendered, failed };
}

const pixelCache = new Map<string, { w: number; h: number; rgb: Uint8Array; alpha: Uint8Array | null }>();
const urlCache = new Map<string, string>();

function canvasOf(b: ImageBitmap): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = b.width;
  c.height = b.height;
  c.getContext('2d')!.drawImage(b, 0, 0);
  return c;
}

/** 출력용 화소(RGB, 투명하면 알파). 연결하지 않은 이미지는 null */
export function imagePixels(key: string): { w: number; h: number; rgb: Uint8Array; alpha: Uint8Array | null } | null {
  const hit = pixelCache.get(key);
  if (hit) return hit;
  const b = bitmaps.get(key);
  if (!b) return null;
  const d = canvasOf(b).getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
  const n = b.width * b.height;
  const rgb = new Uint8Array(n * 3);
  let alpha: Uint8Array | null = null;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4]!;
    rgb[i * 3 + 1] = d[i * 4 + 1]!;
    rgb[i * 3 + 2] = d[i * 4 + 2]!;
    if (d[i * 4 + 3]! < 255) {
      if (!alpha) alpha = new Uint8Array(n).fill(255);
      alpha[i] = d[i * 4 + 3]!;
    }
  }
  const out = { w: b.width, h: b.height, rgb, alpha };
  pixelCache.set(key, out);
  return out;
}

/** SVG용 data URL(PNG) */
export function imageDataUrl(key: string): string | null {
  const hit = urlCache.get(key);
  if (hit) return hit;
  const b = bitmaps.get(key);
  if (!b) return null;
  const url = canvasOf(b).toDataURL('image/png');
  urlCache.set(key, url);
  return url;
}

/** 그래픽 문맥을 되찾으면 텍스처를 다시 올린다 */
export function reuploadImages(app: App): void {
  for (const [k, b] of bitmaps) app.view.renderer.setImage(k, b);
}

function pickFiles(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, style: 'display:none' }) as HTMLInputElement;
    if (folder) input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** 문서를 연 뒤: 찾지 못한 참조 안내 */
export async function noteMissingRefs(app: App, st: DocState): Promise<void> {
  syncXrefLayers(st);
  expandXrefBounds(app, st);
  // 이미 연결한 PDF의 다른 페이지를 이 도면이 쓰면 그린다
  if (pdfData.size) await renderPdfPages(app);
  const miss = docRefs(app, st.doc).filter((r) => !r.found);
  if (!miss.length) return;
  const n = (k: RefItem['kind']) => miss.filter((r) => r.kind === k).length;
  const parts = [n('xref') && `외부 참조 ${n('xref')}개`, n('image') && `이미지 ${n('image')}개`, n('pdf') && `PDF 참고 ${n('pdf')}개`].filter(Boolean);
  app.cmd.print(`참고: ${parts.join(', ')}의 파일을 찾지 못했습니다. EXTERNALREFERENCES(XR)에서 파일이 있는 폴더를 고르면 표시합니다.`);
}

export function registerRefCommands(app: App): void {
  const prevRestore = app.view.onRestore;
  app.view.onRestore = () => {
    prevRestore?.();
    reuploadImages(app);
    for (const x of xrefFiles.values()) x.scene.reupload(app.view.renderer);
  };
  app.view.xrefPlacements = (st, list, visible, vpFrozen) => xrefPlacements(st, list, visible, vpFrozen);
  app.register({
    name: 'EXTERNALREFERENCES',
    aliases: ['XR', 'ER', 'XREF', 'IMAGE'],
    title: '외부 참조',
    run(ctx) {
      const st = app.active!;
      const refs = docRefs(app, st.doc);
      const kindName = { image: '래스터 이미지', xref: 'DWG 참조', pdf: 'PDF 참고' } as const;
      const body = h(
        'div',
        {},
        h('p', {}, '도면이 쓰는 외부 파일입니다. 브라우저는 도면에 적힌 경로를 열 수 없으니, 파일이 있는 폴더나 파일을 고르면 같은 이름의 파일을 찾아 연결합니다. 파일은 서버로 보내지 않습니다.'),
        refs.length
          ? h(
              'table',
              { class: 'grid' },
              h('thead', {}, h('tr', {}, h('th', {}, '참조 이름'), h('th', {}, '종류'), h('th', {}, '상태'), h('th', {}, '저장된 경로'))),
              h(
                'tbody',
                {},
                ...refs.map((r) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, r.name),
                    h('td', {}, kindName[r.kind]),
                    h('td', { style: r.found ? '' : 'color:var(--warn, #e0a030)' }, r.found ? '로드됨' : '찾을 수 없음'),
                    h('td', { style: 'color:var(--text-dim);word-break:break-all' }, r.path),
                  ),
                ),
              ),
            )
          : h('div', { style: 'color:var(--text-dim)' }, '이 도면은 외부 파일을 쓰지 않습니다.'),
      );
      const load = async (folder: boolean) => {
        const files = await pickFiles(folder);
        if (!files.length) return;
        // 이 도면이 찾는 이름만
        const want = new Set(refs.map((r) => r.key));
        const pick = files.filter((f) => want.has(f.name.toLowerCase()));
        const img = await linkImageFiles(app, pick);
        const x = await linkXrefFiles(app, pick);
        // 연결한 참조 파일이 다시 참조하는 파일(중첩)도 같은 선택에서 찾는다
        for (let i = 0; i < MAX_NEST && x.length; i++) {
          const more = wantedXrefKeys(app);
          const next = files.filter((f) => more.has(f.name.toLowerCase()) && !want.has(f.name.toLowerCase()) && !x.includes(f.name));
          if (!next.length) break;
          for (const f of next) want.add(f.name.toLowerCase());
          x.push(...(await linkXrefFiles(app, next)));
        }
        const pdf = await linkPdfFiles(app, pick);
        const names = [...img.linked, ...x, ...pdf.linked];
        const n = names.length;
        ctx.print(n ? `파일 ${n}개를 연결했습니다: ${names.slice(0, 6).join(', ')}${n > 6 ? ' …' : ''}` : '이 도면이 찾는 이름의 파일이 없습니다.', n ? undefined : 'err');
        if (pdf.failed.length) ctx.print(`참고: ${pdf.failed.slice(0, 4).join(', ')}은(는) 읽을 수 없는 PDF입니다(암호가 걸렸거나 손상됨).`, 'err');
        if (img.unsupported.length) ctx.print(`참고: ${img.unsupported.slice(0, 4).join(', ')}은(는) 이 브라우저가 읽을 수 없는 이미지 형식입니다(PNG·JPEG·GIF·BMP·WebP만).`);
        if (n) toast(`외부 파일 ${n}개를 연결했습니다.`, 'info', 3000);
      };
      dialog('외부 참조', body, [
        { label: '파일 고르기…', run: () => void load(false) },
        { label: '폴더 고르기…', primary: true, run: () => void load(true) },
      ]);
    },
  });
}
