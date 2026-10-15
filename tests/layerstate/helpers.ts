/** 도면층 상태 시험 도우미: 새 도면, 도면층·선종류 추가, 표본 경로, 왕복 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CadDocument } from '../../src/core/model';
import { readCadFile } from '../../src/io/index';
import { writeDxf } from '../../src/io/dxf/writer';
import { writeDwg } from '../../src/io/dwg/writer/index';

export { add, addBlock, addLayer, addLinetype, commit, duplicateHandles, insert, line, newDoc, viewport } from '../layertools/helpers';
export type { TestDoc } from '../layertools/helpers';

export const FIXTURES = process.env.CAD_FIXTURES ?? '/Users/sean/code/prisme-service/.runtime/cad2d-handoff/dwgref';

/** 표본 파일 경로(없으면 null — 시험을 건너뛴다) */
export function fixture(rel: string): string | null {
  const p = join(FIXTURES, rel);
  return existsSync(p) ? p : null;
}

export function readFixture(p: string): CadDocument {
  return readCadFile(new Uint8Array(readFileSync(p)), p);
}

/** DXF·DWG로 써서 다시 읽기 */
export function roundTrip(doc: CadDocument, fmt: 'dxf' | 'dwg', version = 'AC1032'): CadDocument {
  const data = fmt === 'dxf' ? writeDxf(doc, { version: version as never }).data : writeDwg(doc, { version: version as never }).data;
  return readCadFile(data, `rt.${fmt}`);
}
