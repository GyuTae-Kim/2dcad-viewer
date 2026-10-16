import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../../src/app/engine';

describe('lazy 2D engine worker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves the start page without a worker, then initializes once before the first file', async () => {
    const postMessage = vi.fn();
    let worker: { onmessage?: (event: { data: unknown }) => void };
    const WorkerMock = vi.fn(function () { worker = { postMessage } as typeof worker; return worker; });
    vi.stubGlobal('Worker', WorkerMock);
    const client = new EngineClient('/fonts/');
    expect(WorkerMock).not.toHaveBeenCalled();

    const bytes = new ArrayBuffer(4);
    const opening = client.open('test.dxf', bytes);
    expect(WorkerMock).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]).toEqual([{ type: 'init', fontBase: '/fonts/' }]);
    expect(postMessage.mock.calls[1]).toEqual([{ type: 'open', id: 1, name: 'test.dxf', data: bytes, view: undefined }, [bytes]]);
    client.images(['image-key']);
    expect(WorkerMock).toHaveBeenCalledTimes(1);
    // Exercise the attached response handler too; no pending promise is left behind.
    const rejected = expect(opening).rejects.toMatchObject({ code: 'BAD_FILE', message: 'invalid fixture' });
    worker!.onmessage!({ data: { type: 'error', id: 1, code: 'BAD_FILE', message: 'invalid fixture' } });
    await rejected;
  });
});
