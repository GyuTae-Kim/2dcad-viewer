/**
 * PDF 페이지의 벡터 내용 뽑기(PDFIMPORT용). pdf.js(Apache-2.0)의 연산 목록을 따라가며 변환 행렬을 쌓고,
 * 경로(직선·베지에)와 칠하기 방식·색·선 두께, 그리고 문자를 PDF 사용자 좌표(1/72인치, y 위)로 모은다.
 * 이 모듈은 PDF를 가져올 때만 불러온다.
 */
import { OPS } from 'pdfjs-dist';
import type { PdfPageData, PdfSeg, PdfShape, PdfSubpath } from '../edit/pdfimport';
import { openPdf } from './pdfraster';

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
// DrawOPS(pdf.js 경로 자료): moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4
const D_MOVE = 0;
const D_LINE = 1;
const D_CURVE = 2;
const D_QUAD = 3;
const D_CLOSE = 4;

function mul(a: M, b: M): M {
  // a ∘ b: b를 먼저, 그다음 a
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function hex(v: unknown): number {
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v)) return parseInt(v.replace('#', ''), 16);
  return 0;
}

const STROKE = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const FILL = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.rawFillPath]);
const CLOSE = new Set<number>([OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

function decodePath(data: ArrayLike<number>, m: M, closeAll: boolean): PdfSubpath[] {
  const out: PdfSubpath[] = [];
  const T = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  let cur: PdfSubpath | null = null;
  let lx = 0;
  let ly = 0;
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    if (op === D_MOVE) {
      const [x, y] = T(data[i++]!, data[i++]!);
      cur = { x0: x, y0: y, segs: [], closed: false };
      out.push(cur);
      lx = x;
      ly = y;
    } else if (op === D_LINE) {
      const [x, y] = T(data[i++]!, data[i++]!);
      if (!cur) out.push((cur = { x0: lx, y0: ly, segs: [], closed: false }));
      cur.segs.push({ k: 'L', x, y });
      lx = x;
      ly = y;
    } else if (op === D_CURVE) {
      const [x1, y1] = T(data[i++]!, data[i++]!);
      const [x2, y2] = T(data[i++]!, data[i++]!);
      const [x, y] = T(data[i++]!, data[i++]!);
      if (!cur) out.push((cur = { x0: lx, y0: ly, segs: [], closed: false }));
      cur.segs.push({ k: 'C', x1, y1, x2, y2, x, y } as PdfSeg);
      lx = x;
      ly = y;
    } else if (op === D_QUAD) {
      // 2차 → 3차
      const [qx, qy] = T(data[i++]!, data[i++]!);
      const [x, y] = T(data[i++]!, data[i++]!);
      if (!cur) out.push((cur = { x0: lx, y0: ly, segs: [], closed: false }));
      cur.segs.push({ k: 'C', x1: lx + ((qx - lx) * 2) / 3, y1: ly + ((qy - ly) * 2) / 3, x2: x + ((qx - x) * 2) / 3, y2: y + ((qy - y) * 2) / 3, x, y });
      lx = x;
      ly = y;
    } else if (op === D_CLOSE) {
      if (cur) {
        cur.closed = true;
        lx = cur.x0;
        ly = cur.y0;
      }
    } else break;
  }
  if (closeAll) for (const p of out) p.closed = true;
  return out.filter((p) => p.segs.length > 0);
}

/** PDF 파일의 한 쪽(1부터)을 뽑는다. 쪽 수도 돌려준다 */
export async function extractPdfPage(data: Uint8Array, pageNo: number): Promise<{ page: PdfPageData; pages: number }> {
  const { pdf, close } = await openPdf(data);
  try {
    const pages = pdf.numPages;
    const page = await pdf.getPage(Math.min(Math.max(1, pageNo), pages));
    try {
      const view = page.view as number[];
      const ops = await page.getOperatorList();
      const shapes: PdfShape[] = [];
      let st = { m: [...I] as M, stroke: 0, fill: 0, width: 1 };
      const stack: (typeof st)[] = [];
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k]!;
        const args = ops.argsArray[k] as unknown[];
        switch (fn) {
          case OPS.save:
            stack.push({ ...st, m: [...st.m] as M });
            break;
          case OPS.restore:
            st = stack.pop() ?? st;
            break;
          case OPS.transform:
            st.m = mul(st.m, args as unknown as M);
            break;
          case OPS.paintFormXObjectBegin:
            stack.push({ ...st, m: [...st.m] as M });
            if (Array.isArray(args[0]) && args[0].length === 6) st.m = mul(st.m, args[0] as M);
            break;
          case OPS.paintFormXObjectEnd:
            st = stack.pop() ?? st;
            break;
          case OPS.setLineWidth:
            st.width = Number(args[0]) || 0;
            break;
          case OPS.setGState:
            for (const kv of (args[0] as [string, unknown][]) ?? []) if (Array.isArray(kv) && kv[0] === 'LW') st.width = Number(kv[1]) || 0;
            break;
          case OPS.setStrokeRGBColor:
            st.stroke = hex(args[0]);
            break;
          case OPS.setFillRGBColor:
            st.fill = hex(args[0]);
            break;
          case OPS.constructPath: {
            const op = Number(args[0]);
            const stroke = STROKE.has(op);
            const fill = FILL.has(op);
            if (!stroke && !fill) break;
            const raw = (args[1] as unknown[])?.[0];
            if (!raw || typeof (raw as ArrayLike<number>).length !== 'number') break;
            const subpaths = decodePath(raw as ArrayLike<number>, st.m, CLOSE.has(op));
            if (!subpaths.length) break;
            const scale = Math.sqrt(Math.abs(st.m[0] * st.m[3] - st.m[1] * st.m[2])) || 1;
            shapes.push({ stroke, fill, strokeRgb: st.stroke, fillRgb: st.fill, width: st.width * scale, subpaths });
            break;
          }
        }
      }
      const tc = await page.getTextContent();
      const texts = [];
      for (const it of tc.items as { str?: string; transform?: number[]; height?: number }[]) {
        if (!it.str || !it.transform) continue;
        const [a, b, c, d, e, f] = it.transform as M;
        const height = Math.hypot(c, d) || it.height || 0;
        texts.push({ str: it.str, x: e, y: f, height, rotation: Math.atan2(b, a), rgb: 0 });
      }
      return { page: { originX: view[0]!, originY: view[1]!, width: view[2]! - view[0]!, height: view[3]! - view[1]!, shapes, texts }, pages };
    } finally {
      page.cleanup();
    }
  } finally {
    await close();
  }
}

/** 쪽 수만 */
export async function pdfPageCount(data: Uint8Array): Promise<number> {
  const { pdf, close } = await openPdf(data);
  try {
    return pdf.numPages;
  } finally {
    await close();
  }
}
