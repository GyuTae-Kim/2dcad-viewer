/**
 * DWG 리더·쓰기(ODA 공개 사양 기반의 독자 구현). 브라우저 작업자와 Node에서 모두 돈다.
 * 읽기: AC1012(R13)·AC1014(R14)·AC1015(R2000)·AC1018(R2004)·AC1021(R2007)·AC1024(R2010)·AC1027(R2013)·AC1032(R2018)
 * 쓰기: AC1015·AC1018·AC1024·AC1027·AC1032(`writeDwg`, writer/index.ts)
 */
import type { CadDocument } from '../../core/model';
import { CadReadError } from '../../core/errors';
import { DwgFormatError } from './bitstream';
import { buildDocument } from './build';
import { readR2000Container } from './container/r2000';
import { readR2004Container } from './container/r2004';
import { readR2007Container } from './container/r2007';
import type { DwgSections } from './container/types';
import { R2000, R2007, SUPPORTED_VERSIONS, versionNumber } from './version';

export interface DwgReadOptions {
  onProgress?: (fraction: number) => void;
  maxEntities?: number;
}

/** 첫 6바이트가 "AC10xx"인지 */
export function isDwg(data: Uint8Array): boolean {
  return dwgVersion(data) !== null;
}

/** "AC1015" 같은 버전 문자열. DWG가 아니면 null */
export function dwgVersion(data: Uint8Array): string | null {
  if (data.length < 6) return null;
  let s = '';
  for (let i = 0; i < 6; i++) s += String.fromCharCode(data[i]);
  return /^AC10\d\d$/.test(s) ? s : null;
}

export function readDwg(data: Uint8Array, options: DwgReadOptions = {}): CadDocument {
  if (data.length === 0) throw new CadReadError('file.empty');
  const v = dwgVersion(data);
  if (!v) throw new CadReadError('file.unrecognized');
  const ver = versionNumber(v);
  if (!SUPPORTED_VERSIONS.includes(ver)) throw new CadReadError('dwg.unsupported_version', { version: v });
  let sec: DwgSections;
  try {
    if (ver <= R2000) sec = readR2000Container(data, ver);
    else if (ver === R2007) sec = readR2007Container(data, ver);
    else sec = readR2004Container(data, ver);
    if (sec.securityFlags && sec.securityFlags & 1) throw new CadReadError('dwg.encrypted', { version: v });
    return buildDocument(sec, options);
  } catch (e) {
    if (e instanceof CadReadError) throw e;
    if (e instanceof DwgFormatError || e instanceof RangeError || e instanceof TypeError) {
      throw new CadReadError('dwg.corrupt', { version: v, error: String(e) });
    }
    throw e;
  }
}


export { writeDwg, type DwgWriteOptions, type DwgWriteResult, type DwgWriteVersion } from './writer';
