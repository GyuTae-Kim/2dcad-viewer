/** AcDb:Classes — 사용자 클래스 정의(사양 10장, 5.8) */
import type { CadClass } from '../../core/model';
import { BitReader } from './bitstream';
import { warn, type DwgSections } from './container/types';
import { attachStringStream } from './streams';
import { R2004, R2007, R2010, R2018 } from './version';

export function readClasses(sec: DwgSections, decoder: TextDecoder): CadClass[] {
  const data = sec.classes;
  const out: CadClass[] = [];
  if (!data || data.length < 24) return out;
  const ver = sec.ver;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = dv.getUint32(16, true);
  let start = 20;
  if ((ver >= R2010 && sec.maintVer > 3) || ver >= R2018) start = 24;
  const endByte = Math.min(data.length, start + size);
  const r = new BitReader(data, ver, decoder);
  r.pos = start * 8;
  r.end = endByte * 8;
  let dataEnd = endByte * 8;
  if (ver >= R2007) {
    // 비트 크기 → 문자열 흐름
    const bits = r.RLu();
    const endBit = start * 8 + bits;
    const str = r.fork();
    attachStringStream(r, str, start * 8, endBit);
    // 클래스 자료는 문자열 흐름 앞에서 끝난다.
    dataEnd = str.pos < endBit ? str.pos : endBit - 1;
  }
  if (ver >= R2004) {
    r.BS(); // 최대 클래스 번호
    r.RC();
    r.RC();
    r.B();
  }
  try {
    while (r.pos < dataEnd - 8 && out.length < 8192) {
      const number = r.BS();
      // 클래스 번호는 500부터 이어진다. 벗어나면 자료가 망가진 것으로 보고 멈춘다
      if (number < 500 || number > 0x7fff) break;
      const proxyFlags = r.BS();
      const appName = r.TV();
      const cppName = r.TV();
      const dxfName = r.TV();
      const wasProxy = r.B() === 1;
      const itemClassId = r.BS();
      let instanceCount = 0;
      if (ver >= R2004) {
        instanceCount = r.BL();
        r.BL(); // 만든 DWG 버전
        r.BL(); // 유지보수 버전
        r.BL();
        r.BL();
      }
      if (r.pos > dataEnd) break;
      out.push({ dxfName, cppName, appName, proxyFlags, instanceCount, wasProxy, isEntity: itemClassId === 0x1f2, number });
    }
  } catch (e) {
    warn(sec.warnings, 'dwg.classes_corrupt', '클래스 목록을 끝까지 읽지 못했습니다.', { error: String(e) });
  }
  return out;
}
