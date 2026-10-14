/// <reference lib="webworker" />
/**
 * 엔진 워커: 파일 해석과 장면 만들기를 화면과 다른 스레드에서 한다.
 * 프리즘 서비스에서는 서버 엔진이 하던 일을 브라우저 안에서 한다.
 */
import type { CadDocument } from '../core/model';
import { CadReadError } from '../core/errors';
import { readCadFile } from '../io/index';
import { buildSpace } from '../render/build';
import { transferables } from '../render/displaylist';
import { OutlineLibrary } from '../text/fonts';
import { TextEngine } from '../text/layout';
import { ShxLibrary } from '../text/shx';
import { collectTextUsage } from '../text/collect';
import type { FromWorker, SceneMessage, ToWorker } from './protocol';
import { applyOps } from '../edit/session';

declare const self: DedicatedWorkerGlobalScope;

let lib: OutlineLibrary | null = null;
const shx = new ShxLibrary();
let text: TextEngine = new TextEngine(null);
text.shx = shx;
const docs = new Map<number, CadDocument>();
let nextDoc = 1;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

/** 파일이 연결된 래스터 이미지 */
let imageKeys: ReadonlySet<string> = new Set();
let pdfPages: ReadonlyMap<string, readonly [number, number]> = new Map();
/** 문서별로 숨긴 최상위 객체 */
const hiddenByDoc = new Map<number, ReadonlySet<string>>();

function makeScene(doc: CadDocument, space: string, ltFactor?: number, docId?: number, anno?: { annoScale?: string | null; annoAllVisible?: boolean }): SceneMessage {
  const t0 = performance.now();
  const s = buildSpace(doc, space, { text, images: imageKeys, pdfPages, ltFactor, hidden: docId !== undefined ? hiddenByDoc.get(docId) : undefined, annoScale: anno?.annoScale, annoAllVisible: anno?.annoAllVisible });
  return {
    list: s.list,
    styles: s.styles.specs,
    layers: s.layers,
    layerIndex: [...s.layerIndex.entries()],
    warnings: s.warnings,
    ms: performance.now() - t0,
    annotative: s.annotative ?? 0,
  };
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        lib = new OutlineLibrary(msg.fontBase);
        text = new TextEngine(lib);
        text.shx = shx;
        break;
      case 'images':
        imageKeys = new Set(msg.keys);
        pdfPages = new Map((msg.pdfPages ?? []).map(([k, w, h]) => [k, [w, h] as const]));
        break;
      case 'shx':
        if (msg.clear) shx.clear();
        for (const f of msg.files) shx.add(f.name, new Uint8Array(f.data));
        break;
      case 'open': {
        const t0 = performance.now();
        const doc = readCadFile(new Uint8Array(msg.data), msg.name, {
          onProgress: (f) => post({ type: 'progress', id: msg.id, stage: 'read', fraction: f }),
        });
        const readMs = performance.now() - t0;
        const docId = nextDoc++;
        docs.set(docId, doc);
        const usage = collectTextUsage(doc);
        if (usage.needsOutline && lib) {
          post({ type: 'progress', id: msg.id, stage: 'fonts', fraction: 0 });
          try {
            await Promise.all([lib.require(usage.codes), lib.requireLatin(usage.latin)]);
          } catch (e) {
            doc.warnings.push({ code: 'font.unavailable', message: '글꼴을 받지 못해 일부 문자를 대체 글꼴로 그립니다.' });
            void e;
          }
        }
        post({ type: 'document', id: msg.id, docId, doc, readMs });
        post({ type: 'progress', id: msg.id, stage: 'build', fraction: 0 });
        const scene = makeScene(doc, '*Model_Space');
        post({ type: 'scene', id: msg.id, docId, space: '*Model_Space', scene }, transferables(scene.list));
        break;
      }
      case 'edit': {
        const doc = docs.get(msg.docId);
        if (doc) applyOps(doc, msg.ops);
        break;
      }
      case 'close':
        docs.delete(msg.docId);
        hiddenByDoc.delete(msg.docId);
        break;
      case 'hide':
        if (msg.handles.length) hiddenByDoc.set(msg.docId, new Set(msg.handles));
        else hiddenByDoc.delete(msg.docId);
        break;
      case 'adopt': {
        const doc = msg.doc;
        const docId = nextDoc++;
        docs.set(docId, doc);
        const usage = collectTextUsage(doc);
        if (usage.needsOutline && lib) {
          try {
            await Promise.all([lib.require(usage.codes), lib.requireLatin(usage.latin)]);
          } catch {
            /* 대체 글꼴로 그린다 */
          }
        }
        post({ type: 'document', id: msg.id, docId, doc, readMs: 0 });
        const scene = makeScene(doc, '*Model_Space');
        post({ type: 'scene', id: msg.id, docId, space: '*Model_Space', scene }, transferables(scene.list));
        break;
      }
      case 'save': {
        const doc = docs.get(msg.docId);
        if (!doc) throw new Error('문서가 없습니다');
        const t0 = performance.now();
        let r: { data: Uint8Array; warnings: { code: string; message: string; count?: number }[] };
        if (msg.format === 'dwg') {
          const { writeDwg } = await import('../io/dwg/index');
          r = writeDwg(doc, { version: msg.version as never });
        } else {
          const { writeDxf } = await import('../io/dxf/writer');
          r = writeDxf(doc, { version: msg.version as never, binary: msg.binary });
        }
        const data = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer;
        post({ type: 'saved', id: msg.id, data, warnings: r.warnings.map((w) => ({ code: w.code, message: w.message, count: w.count })), ms: performance.now() - t0 }, [data]);
        break;
      }
      case 'build': {
        const doc = docs.get(msg.docId);
        if (!doc) throw new Error('문서가 없습니다');
        const scene = makeScene(doc, msg.space, msg.ltFactor, msg.docId, { annoScale: msg.annoScale, annoAllVisible: msg.annoAllVisible });
        post({ type: 'scene', id: msg.id, docId: msg.docId, space: msg.space, scene }, transferables(scene.list));
        break;
      }
    }
  } catch (e) {
    const id = 'id' in msg ? msg.id : 0;
    if (e instanceof CadReadError) post({ type: 'error', id, code: e.code, message: e.message });
    else post({ type: 'error', id, code: 'internal', message: e instanceof Error ? e.message : String(e) });
  }
};
