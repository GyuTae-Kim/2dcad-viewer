/**
 * 3D 해석 워커 손님: 파일 바이트를 워커로 넘기고(이전), 진행률을 받아 결과 장면을 돌려받는다.
 * 워커는 처음 쓸 때 만들고 하나를 계속 쓴다. 워커가 죽으면 기다리던 요청을 모두 실패로 끝내고 다음에 새로 만든다.
 */
import type { NcOpenOptions, View3dFormat, View3dRequest, View3dResponse, View3dResult } from './protocol';

interface Pending {
  resolve: (r: View3dResult) => void;
  reject: (e: Error) => void;
  progress?: (fraction: number, stage: string) => void;
}

export class View3dWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  /** 파일 해석(data는 이전되어 비워진다) */
  open(name: string, format: View3dFormat, data: ArrayBuffer, opts: { nc?: NcOpenOptions } = {}, progress?: (fraction: number, stage: string) => void): Promise<View3dResult> {
    let w: Worker;
    try {
      w = this.ensure();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    const id = ++this.seq;
    return new Promise<View3dResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      const req: View3dRequest = { id, type: 'open', name, format, bytes: data };
      if (opts.nc) req.nc = opts.nc;
      try {
        w.postMessage(req, [data]);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  dispose(): void {
    this.fail(new Error('3D 해석을 멈췄습니다'));
    this.worker?.terminate();
    this.worker = null;
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../worker/view3d.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<View3dResponse>) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        p.progress?.(m.fraction, m.stage);
        return;
      }
      this.pending.delete(m.id);
      if (m.type === 'done') p.resolve(m.result);
      else p.reject(new Error(m.message));
    };
    w.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      this.fail(new Error(ev.message || '3D 해석 워커가 멈췄습니다(메모리가 모자랄 수 있습니다)'));
      w.terminate();
      if (this.worker === w) this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private fail(e: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(e);
  }
}
