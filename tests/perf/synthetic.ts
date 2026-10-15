/** 성능 시험용 합성 도면(scripts/perf/gen-big.ts를 메모리에서 돌린다) */
import type { CadDocument } from '../../src/core/model';
import { generate } from '../../scripts/perf/gen-big';

/** 합성 ASCII DXF(선·폴리선·원·호·문자·여러 줄 문자·해치·블록 참조·속성 섞음) */
export function syntheticDxf(count: number, layers = 40): Uint8Array {
  const parts: string[] = [];
  generate({ count, layers }, (s) => parts.push(s));
  const s = parts.join('');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 쓰기가 지금 시각·난수로 채우는 헤더 값을 고정한다(두 결과를 바이트로 비교하려고) */
export function pinHeader(doc: CadDocument): CadDocument {
  for (const k of ['$TDCREATE', '$TDUPDATE', '$TDUCREATE', '$TDUUPDATE']) if (typeof doc.header.get(k) !== 'number') doc.header.set(k, 2460000.5);
  for (const k of ['$FINGERPRINTGUID', '$VERSIONGUID']) if (typeof doc.header.get(k) !== 'string' || !doc.header.get(k)) doc.header.set(k, '{00000000-0000-0000-0000-000000000000}');
  return doc;
}
