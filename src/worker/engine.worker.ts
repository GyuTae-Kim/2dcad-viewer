/// <reference lib="webworker" />
/**
 * 엔진 워커: 파일 해석과 장면 만들기를 화면과 다른 스레드에서 한다.
 * 프리즘 서비스에서는 서버 엔진이 하던 일을 브라우저 안에서 한다.
 */
import type { CadDocument } from '../core/model';
import { CadReadError } from '../core/errors';
import { readCadFile } from '../io/index';
import { type PartialScene, type PartialView, SceneBuilder, buildSpace } from '../render/build';
import { planPreview } from '../render/preview';
import { packBoxes, transferables } from '../render/displaylist';
import { OutlineLibrary } from '../text/fonts';
import { TextEngine } from '../text/layout';
import { ShxLibrary } from '../text/shx';
import { collectTextUsage } from '../text/collect';
import type { FromWorker, PreviewView, SceneMessage, ToWorker } from './protocol';
import { applyOps } from '../edit/session';
import { sendDocument } from './doctransfer';
import { unboxLw } from '../core/lwpoly';

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

function makeScene(
  doc: CadDocument,
  space: string,
  ltFactor?: number,
  docId?: number,
  anno?: { annoScale?: string | null; annoAllVisible?: boolean },
  onProgress?: (fraction: number) => void,
  partial?: { view: PartialView; post: (part: PartialScene) => void },
): SceneMessage {
  const t0 = performance.now();
  const s = buildSpace(doc, space, {
    text,
    images: imageKeys,
    pdfPages,
    ltFactor,
    hidden: docId !== undefined ? hiddenByDoc.get(docId) : undefined,
    annoScale: anno?.annoScale,
    annoAllVisible: anno?.annoAllVisible,
    onProgress,
    packBoxes: true,
    onPartial: partial?.post,
    partialView: partial?.view,
  });
  // 객체 상자는 형식 배열로 만들어 옮긴다(상자 객체를 만들지 않는다 — 메인에서 engine.ts가 푼다)
  const boxes = s.list.packed ?? packBoxes(s.list.entities);
  s.list.packed = undefined;
  s.list.entities = [];
  return {
    list: s.list,
    boxes,
    styles: s.styles.specs,
    layers: s.layers,
    layerIndex: [...s.layerIndex.entries()],
    warnings: s.warnings,
    ms: performance.now() - t0,
    annotative: s.annotative ?? 0,
  };
}

/**
 * 문서를 메인으로 보낸다(장면 뒤에 — 장면이 먼저 보이게). 큰 블록의 객체는 묶음으로 부호화해 따로 보낸다(doctransfer).
 */
function postDocument(id: number, docId: number, doc: CadDocument, readMs: number): void {
  sendDocument(
    doc,
    (d, streamed) => post({ type: 'document', id, docId, doc: d, readMs, streamed }),
    (part, transfer) => post({ type: 'docpart', id, part }, transfer),
    (f) => post({ type: 'progress', id, stage: 'document', fraction: f }),
  );
}

/** 장면 메시지에서 옮길 버퍼(표시 목록 + 묶은 상자) */
function sceneTransfer(scene: SceneMessage): Transferable[] {
  const t: Transferable[] = transferables(scene.list);
  if (scene.boxes) t.push(scene.boxes.bounds.buffer as ArrayBuffer, scene.boxes.ranges.buffer as ArrayBuffer, scene.boxes.glyphs.buffer as ArrayBuffer);
  return t;
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
        let bytes: Uint8Array | null = new Uint8Array(msg.data);
        // 파일 버퍼는 읽은 뒤 바로 놓아 준다(큰 파일이 장면 만드는 동안 메모리에 남지 않게)
        (msg as { data: ArrayBuffer | null }).data = null;
        const doc = readCadFile(bytes, msg.name, {
          onProgress: (f) => post({ type: 'progress', id: msg.id, stage: 'read', fraction: f }),
        });
        bytes = null;
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
        post({ type: 'progress', id: msg.id, stage: 'build', fraction: 0 });
        // 점진 빌드: 첫 화면에 보이는 객체를 먼저(도면 일부만 보일 때), 이어서 만드는 동안 조각을 보낸다
        const id = msg.id;
        // view가 없으면(비교·외부 참조처럼 화면에 바로 보이지 않는 열기) 조각을 만들지 않는다
        const v = msg.view;
        const aspect = v && v.height > 0 ? v.width / v.height : 0;
        const plan = v ? planPreview(doc, '*Model_Space', aspect > 0.1 && aspect < 10 ? aspect : undefined) : null;
        const view: PreviewView | null = plan ? { rect: plan.rect, margin: plan.margin } : null;
        // 조각 원점은 첫 화면 가운데, 화면 밖(넉넉히)과 너무 작은 것은 조각에서 뺀다(미리 보기는 움직이지 않는다)
        let pv: PartialView = { origin: [0, 0] };
        if (plan && v) {
          const [x0, y0, x1, y1] = plan.visible;
          const w = x1 - x0;
          const h = y1 - y0;
          pv = { origin: [(x0 + x1) / 2, (y0 + y1) / 2], rect: [x0 - w * 0.5, y0 - h * 0.5, x1 + w * 0.5, y1 + h * 0.5], pxPerUnit: w > 0 ? v.width / w : 0 };
        }
        const postPartial = (part: PartialScene) => post({ type: 'partial', id, part, view }, transferables(part.list));
        if (plan?.only) {
          try {
            postPartial(new SceneBuilder(doc, { text, images: imageKeys, pdfPages }).buildPreview('*Model_Space', plan.only, pv));
          } catch {
            /* 미리 보기는 건너뛴다 */
          }
        }
        const scene = makeScene(doc, '*Model_Space', undefined, undefined, undefined, (f) => post({ type: 'progress', id, stage: 'build', fraction: f }), v ? { view: pv, post: postPartial } : undefined);
        post({ type: 'scene', id: msg.id, docId, space: '*Model_Space', scene }, sceneTransfer(scene));
        postDocument(msg.id, docId, doc, readMs);
        break;
      }
      case 'edit': {
        const doc = docs.get(msg.docId);
        if (!doc) break;
        // postMessage(구조화 복제)는 수 배열의 수를 하나씩 상자에 담는다 — 넣는 폴리선의 평탄 좌표를 다시 담는다
        for (const op of msg.ops) {
          const e = op.kind === 'add' ? op.entity : op.kind === 'modify' ? op.after : null;
          if (e?.type === 'LWPOLYLINE') unboxLw(e, e);
        }
        applyOps(doc, msg.ops);
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
        const scene = makeScene(doc, '*Model_Space');
        post({ type: 'scene', id: msg.id, docId, space: '*Model_Space', scene }, sceneTransfer(scene));
        postDocument(msg.id, docId, doc, 0);
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
        post({ type: 'scene', id: msg.id, docId: msg.docId, space: msg.space, scene }, sceneTransfer(scene));
        break;
      }
    }
  } catch (e) {
    const id = 'id' in msg ? msg.id : 0;
    if (e instanceof CadReadError) post({ type: 'error', id, code: e.code, message: e.message });
    else post({ type: 'error', id, code: 'internal', message: e instanceof Error ? e.message : String(e) });
  }
};
