/**
 * 3D 해석 워커: NC(G-code·Heidenhain·MPR)·STEP·SketchUp 파일을 화면 밖에서 해석해 Scene3d로 돌려준다.
 * 형식별 해석기는 처음 쓸 때 동적으로 불러온다(STEP만 여는 사람은 NC 해석기를 받지 않는다).
 * 결과의 형식 배열은 이전 가능한 버퍼로 넘긴다(protocol.ts collectTransfers).
 */
/// <reference lib="webworker" />
import { collectTransfers, errorText, ncPayload, type View3dRequest, type View3dResponse, type View3dResult } from '../app/view3d/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: View3dResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

async function open(req: View3dRequest): Promise<View3dResult> {
  const id = req.id;
  let last = 0;
  const progress = (fraction: number, stage: string): void => {
    const now = performance.now();
    if (fraction < 1 && now - last < 60) return;
    last = now;
    post({ id, type: 'progress', fraction: Math.max(0, Math.min(1, fraction)), stage });
  };
  const t0 = performance.now();
  const bytes = new Uint8Array(req.bytes);
  const base = req.name.replace(/^.*[\\/]/, '');
  switch (req.format) {
    case 'nc': {
      progress(0.05, '해석기 불러오는 중');
      const nc = await import('../formats/nc/index');
      progress(0.15, 'NC 프로그램 읽는 중');
      const o = req.nc ?? {};
      const parsed = nc.parseNcFile(base, bytes, { gcode: { dialect: o.dialect ?? 'auto', ...(o.units ? { units: o.units } : {}) } });
      progress(0.7, '공구 경로 만드는 중');
      const scene = nc.ncParsedToScene(parsed);
      const out: View3dResult = { format: 'nc', scene, ms: 0 };
      if (parsed.kind === 'mpr') out.mpr = { lines: parsed.part.lines };
      else out.nc = ncPayload(parsed.program);
      out.ms = performance.now() - t0;
      return out;
    }
    case 'step': {
      progress(0.02, '해석기 불러오는 중');
      // STEP 해석기 진입점은 여기 한 곳에서만 부른다
      const step = await import('../formats/step/index');
      const scene = step.stepToScene(bytes, { name: base, onProgress: (f: number, stage?: string) => progress(0.05 + f * 0.93, stage ? `STEP ${stage}` : 'STEP 읽는 중') });
      return { format: 'step', scene, ms: performance.now() - t0 };
    }
    case 'skp': {
      progress(0.05, '해석기 불러오는 중');
      const skp = await import('../formats/skp/index');
      progress(0.2, 'SketchUp 모형 읽는 중');
      const scene = skp.skpToScene(bytes, { name: base });
      return { format: 'skp', scene, ms: performance.now() - t0 };
    }
    default:
      throw new Error('알 수 없는 형식입니다');
  }
}

ctx.onmessage = (ev: MessageEvent<View3dRequest>) => {
  const req = ev.data;
  if (!req || req.type !== 'open') return;
  open(req).then(
    (result) => {
      let transfer: ArrayBuffer[] = [];
      try {
        transfer = collectTransfers(result);
        post({ id: req.id, type: 'done', result }, transfer);
      } catch {
        // 이전이 막히면(드문 경우) 복사로 보낸다
        post({ id: req.id, type: 'done', result });
      }
    },
    (e) => post({ id: req.id, type: 'error', message: errorText(e) }),
  );
};
