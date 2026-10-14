/**
 * 외부 참조 창(EXTERNALREFERENCES·XR): 도면이 쓰는 래스터 이미지·외부 참조(DWG)·PDF 참고와 그 상태.
 * 브라우저는 도면에 적힌 경로를 열 수 없으므로, 사용자가 고른 폴더·파일에서 같은 이름의 파일을 찾아 연결한다.
 * 파일은 서버로 보내지 않는다.
 */
import type { CadDocument, ImageDefObject, UnderlayDefObject } from '../core/model';
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

/** 연결한 이미지 원본(그래픽 문맥을 되찾을 때 다시 올린다) */
const bitmaps = new Map<string, ImageBitmap>();

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

function xrefFor(app: App, hostDocId: number, blockKey: string): XrefFile | null {
  const st = app.docs.find((d) => d.docId === hostDocId);
  return st ? xrefOfDoc(st.doc, blockKey) : null;
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
    for (const st of app.docs) expandXrefBounds(app, st);
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
      out.push({ kind: 'pdf', name: u.name || baseKey(u.fileName), path: u.fileName, key: baseKey(u.fileName), found: false });
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
    app.engine.images([...app.imageKeys]);
    for (const st of app.docs) app.edits.rebuildEverything(st);
  }
  return { linked, unsupported };
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
export function noteMissingRefs(app: App, st: DocState): void {
  expandXrefBounds(app, st);
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
  app.view.xrefScene = (docId, key) => xrefFor(app, docId, key);
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
                    h('td', { style: r.found ? '' : 'color:var(--warn, #e0a030)' }, r.found ? '로드됨' : r.kind === 'pdf' ? '아직 지원하지 않음' : '찾을 수 없음'),
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
        const n = img.linked.length + x.length;
        ctx.print(n ? `파일 ${n}개를 연결했습니다: ${[...img.linked, ...x].slice(0, 6).join(', ')}${n > 6 ? ' …' : ''}` : '이 도면이 찾는 이름의 파일이 없습니다.', n ? undefined : 'err');
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
