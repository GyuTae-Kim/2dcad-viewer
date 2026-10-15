/**
 * PDF 페이지를 그림으로(PDF 언더레이용). pdf.js(Apache-2.0)는 PDF를 연결할 때만 불러온다.
 * 배경은 투명하게 그린다: AutoCAD처럼 PDF의 흰 바탕 대신 도면 배경이 보인다.
 */
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** 그림 해상도(인치당 화소) 상한 */
const MAX_DPI = 200;

export interface PdfPageRaster {
  bitmap: ImageBitmap;
  /** 페이지 폭·높이(인치) */
  width: number;
  height: number;
}

/** PDF를 연다. 다 쓰면 close()로 워커 자원을 놓는다 */
export async function openPdf(data: Uint8Array): Promise<{ pdf: PDFDocumentProxy; close: () => Promise<void> }> {
  // pdf.js가 버퍼를 넘겨받으므로 복사본을 준다
  const base = new URL('pdfjs/', document.baseURI).href;
  const task = getDocument({
    data: data.slice(),
    standardFontDataUrl: base + 'standard_fonts/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
  });
  return { pdf: await task.promise, close: () => task.destroy() };
}

/** PDF 도면층(선택 내용 그룹): 식별자·이름·처음 보임 */
export interface PdfLayer {
  id: string;
  name: string;
  visible: boolean;
}

/** PDF의 도면층 목록(선택 내용이 없으면 빈 배열) */
export async function pdfLayers(pdf: PDFDocumentProxy): Promise<PdfLayer[]> {
  const cfg = await pdf.getOptionalContentConfig();
  const out: PdfLayer[] = [];
  for (const [id, g] of cfg as Iterable<[string, { name?: string | null; visible?: boolean }]>) out.push({ id: String(id), name: String(g?.name ?? id), visible: g?.visible !== false });
  return out;
}

/** 페이지(1부터)를 긴 변 maxPx 화소 이하로 그린다. hidden은 끌 PDF 도면층 식별자. 없는 페이지면 null */
export async function rasterPage(pdf: PDFDocumentProxy, pageNo: number, maxPx: number, hidden?: ReadonlySet<string>): Promise<PdfPageRaster | null> {
  if (pageNo < 1 || pageNo > pdf.numPages) return null;
  let optionalContentConfigPromise: ReturnType<PDFDocumentProxy['getOptionalContentConfig']> | undefined;
  if (hidden?.size) {
    const cfg = await pdf.getOptionalContentConfig();
    for (const [id] of cfg as Iterable<[string, unknown]>) cfg.setVisibility(id, !hidden.has(String(id)));
    optionalContentConfigPromise = Promise.resolve(cfg);
  }
  const page = await pdf.getPage(pageNo);
  try {
    const base = page.getViewport({ scale: 1 });
    // pdf.js 축척 1 = PDF 단위(1/72인치)
    const width = base.width / 72;
    const height = base.height / 72;
    const scale = Math.min(MAX_DPI / 72, maxPx / Math.max(base.width, base.height, 1));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    // pdf.js가 만드는 문맥은 알파가 없어 투명 배경이 검게 된다: 알파 있는 문맥을 직접 준다
    const ctx = canvas.getContext('2d', { alpha: true })!;
    await page.render({ canvas: null, canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)', optionalContentConfigPromise }).promise;
    const bitmap = await createImageBitmap(canvas);
    canvas.width = canvas.height = 0;
    return { bitmap, width, height };
  } finally {
    page.cleanup();
  }
}
