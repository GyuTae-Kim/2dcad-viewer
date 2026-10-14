/** 파일 형식 판별과 읽기 진입점 */
import type { CadDocument } from '../core/model';
import { CadReadError } from '../core/errors';
import { readDxf } from './dxf/reader';
import { isBinaryDxf } from './dxf/records';
import { isDwg, readDwg } from './dwg/index';
import { restoreArcTexts } from './arctext';

export type CadFormat = 'dxf' | 'dwg';

/** 내용으로 형식을 고른다(확장자는 참고만 한다). */
export function detectFormat(data: Uint8Array): CadFormat | null {
  if (data.length === 0) return null;
  if (isDwg(data)) return 'dwg';
  if (isBinaryDxf(data)) return 'dxf';
  // ASCII DXF: 앞부분에 "0\nSECTION"이 있어야 한다(주석 999나 BOM이 앞에 올 수 있다).
  const head = new TextDecoder('latin1').decode(data.subarray(0, Math.min(4096, data.length)));
  if (/(^|\n)\s*0\s*\r?\n\s*SECTION\s*\r?\n/.test(head) || /^\s*999\s*\r?\n/.test(head)) return 'dxf';
  return null;
}

export interface ReadOptions {
  onProgress?: (fraction: number) => void;
}

export function readCadFile(data: Uint8Array, fileName = '', options: ReadOptions = {}): CadDocument {
  if (data.length === 0) throw new CadReadError('file.empty');
  const fmt = detectFormat(data);
  if (!fmt) throw new CadReadError('file.unrecognized');
  const doc = fmt === 'dwg' ? readDwg(data, { onProgress: options.onProgress }) : readDxf(data, { onProgress: options.onProgress });
  restoreArcTexts(doc);
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext && (ext === 'dxf' || ext === 'dwg') && ext !== fmt) {
    doc.warnings.push({ code: 'file.extension_mismatch', message: `확장자는 .${ext}이지만 내용은 ${fmt.toUpperCase()}입니다.` });
  }
  return doc;
}
