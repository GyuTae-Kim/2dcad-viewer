/** 엔진 워커 클라이언트 */
import type { CadDocument } from '../core/model';
import type { FromWorker, PreviewView, SaveFormat, SceneMessage, ToWorker } from '../worker/protocol';
import type { PartialScene } from '../render/build';
import type { EditOp } from '../edit/session';
import { unpackBoxes } from '../render/displaylist';
import { DocAssembler } from '../worker/doctransfer';

export interface OpenResult {
  docId: number;
  doc: CadDocument;
  readMs: number;
  model: SceneMessage;
}

export interface SaveResult {
  data: Uint8Array;
  warnings: { code: string; message: string; count?: number }[];
  ms: number;
}

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (stage: string, f: number) => void;
  /** 점진 빌드의 미리 보기 조각 */
  onPartial?: (part: PartialScene, view: PreviewView | null) => void;
  /** 열기·받기: 문서(껍데기면 assembler가 묶음을 붙인다)와 장면이 모두 오면 끝난다 */
  doc?: { docId: number; doc: CadDocument; readMs: number };
  assembler?: DocAssembler;
  scene?: SceneMessage;
  /** 장면과 문서를 함께 기다리는 요청(open·adopt) */
  wantsDoc?: boolean;
};

export class EngineClient {
  private worker?: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly fontBase: string) {}

  private post(m: ToWorker, transfer: Transferable[] = []): void {
    // The start page and its guide do not need the 2D parsing engine. Queue init
    // before the first real request; subsequent requests reuse the same worker.
    if (!this.worker) {
      const worker = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
      worker.postMessage({ type: 'init', fontBase: this.fontBase } satisfies ToWorker);
      this.worker = worker;
    }
    this.worker.postMessage(m, transfer);
  }

  private onMessage(m: FromWorker): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    switch (m.type) {
      case 'progress':
        p.onProgress?.(m.stage, m.fraction);
        break;
      case 'partial':
        p.onPartial?.(m.part, m.view);
        break;
      case 'document':
        p.doc = { docId: m.docId, doc: m.doc, readMs: m.readMs };
        if (m.streamed.length) p.assembler = new DocAssembler(m.doc, m.streamed);
        this.settle(m.id, p);
        break;
      case 'docpart':
        try {
          p.assembler?.add(m.part);
        } catch (e) {
          this.pending.delete(m.id);
          p.reject(e);
          break;
        }
        this.settle(m.id, p);
        break;
      case 'scene':
        // 워커가 묶어 보낸 객체 상자를 푼다(구조화 복제보다 훨씬 빠르다)
        if (m.scene.boxes) {
          m.scene.list.entities = unpackBoxes(m.scene.boxes);
          m.scene.boxes = undefined;
        }
        if (p.wantsDoc) {
          p.scene = m.scene;
          p.onProgress?.('scene', 1);
          this.settle(m.id, p);
        } else {
          this.pending.delete(m.id);
          p.resolve(m.scene);
        }
        break;
      case 'saved':
        this.pending.delete(m.id);
        p.resolve({ data: new Uint8Array(m.data), warnings: m.warnings, ms: m.ms } satisfies SaveResult);
        break;
      case 'error':
        this.pending.delete(m.id);
        p.reject(new EngineError(m.code, m.message));
        break;
    }
  }

  /** 열기·받기: 장면과 (묶음까지 다 온) 문서가 모두 있으면 끝낸다 */
  private settle(id: number, p: Pending): void {
    if (!p.scene || !p.doc || (p.assembler && !p.assembler.complete)) return;
    this.pending.delete(id);
    p.resolve({ ...p.doc, model: p.scene } satisfies OpenResult);
  }

  /**
   * 파일을 읽어 문서와 모형 장면을 받는다. onPartial: 장면을 만드는 동안 오는 미리 보기 조각(점진 빌드),
   * view: 그림 영역 크기(첫 화면을 정한다)
   */
  open(name: string, data: ArrayBuffer, onProgress?: (stage: string, f: number) => void, onPartial?: (part: PartialScene, view: PreviewView | null) => void, view?: { width: number; height: number }): Promise<OpenResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress, onPartial, wantsDoc: true });
      this.post({ type: 'open', id, name, data, view }, [data]);
    });
  }

  /** 메인에서 만든 문서를 워커에 넘기고 모형 장면을 받는다(워커가 돌려준 문서 사본을 쓴다) */
  adopt(name: string, doc: CadDocument): Promise<OpenResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, wantsDoc: true });
      this.post({ type: 'adopt', id, name, doc });
    });
  }

  /** 파일이 연결된 래스터 이미지 열쇠를 워커에 알린다 */
  /** 숨길 최상위 객체(빈 배열이면 모두 보이기). 다음 장면부터 반영된다 */
  hide(docId: number, handles: string[]): void {
    this.post({ type: 'hide', docId, handles });
  }

  images(keys: string[], pdfPages?: ReadonlyMap<string, readonly [number, number]>): void {
    this.post({ type: 'images', keys, pdfPages: pdfPages ? [...pdfPages].map(([k, [w, h]]) => [k, w, h] as [string, number, number]) : undefined });
  }

  /** SHX 글꼴을 워커 문자 엔진에도 등록한다 */
  shx(files: { name: string; data: Uint8Array }[], clear = false): void {
    this.post({ type: 'shx', clear, files: files.map((f) => ({ name: f.name, data: f.data.slice().buffer as ArrayBuffer })) });
  }

  /** 편집을 워커 문서에도 적용한다 */
  edit(docId: number, ops: EditOp[]): void {
    this.post({ type: 'edit', docId, ops });
  }

  closeDoc(docId: number): void {
    this.post({ type: 'close', docId });
  }

  /** 워커 문서를 DXF·DWG로 쓴다 */
  save(docId: number, format: SaveFormat, version: string, binary = false): Promise<SaveResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ type: 'save', id, docId, format, version, binary });
    });
  }

  /** 공간 장면을 그려 온다. anno: 주석 축척 표현(배치 뷰포트의 모형 장면, 없으면 공간에 맞게) */
  build(docId: number, space: string, ltFactor?: number, anno?: { annoScale?: string | null; annoAllVisible?: boolean }): Promise<SceneMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ type: 'build', id, docId, space, ltFactor, annoScale: anno?.annoScale, annoAllVisible: anno?.annoAllVisible });
    });
  }
}
