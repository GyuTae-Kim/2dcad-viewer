/**
 * 다른 도면 파일 읽기(디자인센터·도면층 변환기·CAD 표준이 함께 쓴다).
 * 사용자가 고른 DWG·DXF·DWS·DWT 파일만 이 브라우저 안(엔진 워커)에서 읽는다. 파일은 열린 도면이 되지 않고 서버로 가지 않는다.
 * 읽은 도면은 이 세션 동안만 기억한다(디자인센터의 "사용 내역").
 */
import type { CadDocument } from '../core/model';
import type { App } from './app';
import { h } from './ui/dom';

export interface LoadedDrawing {
  /** 파일 이름 */
  name: string;
  size: number;
  doc: CadDocument;
  /** 읽은 순번(같은 이름을 다시 읽으면 바뀐다) */
  serial: number;
}

const history: LoadedDrawing[] = [];
let serial = 0;
const listeners = new Set<() => void>();

/** 이 세션에서 읽은 도면(최근 것이 앞) */
export function loadedDrawings(): readonly LoadedDrawing[] {
  return history;
}

/** 읽은 도면 목록이 바뀌면 알림 */
export function onLoadedDrawingsChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export const DRAWING_ACCEPT = '.dwg,.dxf,.dws,.dwt,.DWG,.DXF,.DWS,.DWT';

/** 파일 고르기(취소하면 빈 배열) */
export function pickFiles(accept = DRAWING_ACCEPT, multiple = true): Promise<File[]> {
  const input = h('input', { type: 'file', accept, multiple, hidden: true }) as HTMLInputElement;
  document.body.append(input);
  return new Promise<File[]>((resolve) => {
    input.addEventListener('change', () => resolve([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  }).finally(() => input.remove());
}

/** 도면 파일 하나를 읽는다(엔진 워커에서 읽고 바로 닫는다) */
export async function readDrawingFile(app: App, file: File): Promise<LoadedDrawing> {
  const res = await app.engine.open(file.name, await file.arrayBuffer(), (stage, f) => app.ui.setBusy(stage === 'read' ? `${file.name} 읽는 중…` : `${file.name} 준비 중…`, stage === 'read' ? f * 0.9 : 0.95));
  app.engine.closeDoc(res.docId);
  const item: LoadedDrawing = { name: file.name, size: file.size, doc: res.doc, serial: ++serial };
  const i = history.findIndex((x) => x.name.toLowerCase() === file.name.toLowerCase());
  if (i >= 0) history.splice(i, 1);
  history.unshift(item);
  if (history.length > 20) history.length = 20;
  for (const f of listeners) f();
  return item;
}

/** 파일을 골라 읽는다. 읽지 못한 파일은 알린다 */
export async function pickAndReadDrawings(app: App, print: (text: string, cls?: 'err') => void, multiple = true): Promise<LoadedDrawing[]> {
  const files = await pickFiles(DRAWING_ACCEPT, multiple);
  const out: LoadedDrawing[] = [];
  try {
    for (const f of files) {
      try {
        out.push(await readDrawingFile(app, f));
      } catch (e) {
        print(`${f.name}을(를) 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'err');
      }
    }
  } finally {
    app.ui.setBusy(null);
  }
  return out;
}
