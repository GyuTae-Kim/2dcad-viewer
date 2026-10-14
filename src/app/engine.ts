/** 엔진 워커 클라이언트 */
import type { CadDocument } from '../core/model';
import type { FromWorker, SceneMessage, ToWorker } from '../worker/protocol';
import type { EditOp } from '../edit/session';

export interface OpenResult {
  docId: number;
  doc: CadDocument;
  readMs: number;
  model: SceneMessage;
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
  doc?: { docId: number; doc: CadDocument; readMs: number };
};

export class EngineClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(fontBase: string) {
    this.worker = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    this.post({ type: 'init', fontBase });
  }

  private post(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  private onMessage(m: FromWorker): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    switch (m.type) {
      case 'progress':
        p.onProgress?.(m.stage, m.fraction);
        break;
      case 'document':
        p.doc = { docId: m.docId, doc: m.doc, readMs: m.readMs };
        p.onProgress?.('document', 1);
        break;
      case 'scene':
        this.pending.delete(m.id);
        if (p.doc) p.resolve({ ...p.doc, model: m.scene } satisfies OpenResult);
        else p.resolve(m.scene);
        break;
      case 'error':
        this.pending.delete(m.id);
        p.reject(new EngineError(m.code, m.message));
        break;
    }
  }

  open(name: string, data: ArrayBuffer, onProgress?: (stage: string, f: number) => void): Promise<OpenResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.post({ type: 'open', id, name, data }, [data]);
    });
  }

  /** 메인에서 만든 문서를 워커에 넘기고 모형 장면을 받는다(워커가 돌려준 문서 사본을 쓴다) */
  adopt(name: string, doc: CadDocument): Promise<OpenResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ type: 'adopt', id, name, doc });
    });
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

  build(docId: number, space: string): Promise<SceneMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ type: 'build', id, docId, space });
    });
  }
}
