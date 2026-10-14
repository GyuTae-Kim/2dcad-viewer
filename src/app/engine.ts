/** 엔진 워커 클라이언트 */
import type { CadDocument } from '../core/model';
import type { FromWorker, SceneMessage, ToWorker } from '../worker/protocol';

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

  build(docId: number, space: string): Promise<SceneMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ type: 'build', id, docId, space });
    });
  }
}
