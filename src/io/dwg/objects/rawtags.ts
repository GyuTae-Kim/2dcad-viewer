/**
 * 모델이 따로 담지 않는 비도형 객체를 DXF와 같은 그룹 코드·순서의 원본 태그(GenericObject.raw)로 푼다.
 * DXF에서 읽은 도면과 같은 길로 다른 모듈(연관 치수, 주석 축척, 필드)이 쓸 수 있게 한다.
 *
 * - FIELD·FIELDLIST: 사양 20.4.76·20.4.77(objects/field.ts). 태그는 io/fields.ts가 만든다.
 * - DIMASSOC: 사양에 없는 객체다. AutoCAD가 같은 도면을 DWG(R14~R2018)와 DXF(R2000~R2018)로 저장한 표본
 *   (sample_AC10xx)을 같은 핸들끼리 맞춰 배치를 정했다:
 *     H 330 치수(소프트 포인터), BL 90 연관 플래그, B 70 공간 이동, RC 71 회전 치수 종류,
 *     점 참조마다(플래그 비트 수만큼): TV 1 클래스 이름, RC 72 객체 스냅 종류, BL 주 객체 경로 수 + H 331…,
 *     BS 73 하위 객체 종류, BL 91 GS 표지, BL 교차 객체 경로 수 + H 332…(경로가 있으면 BS 74, BL 92 —
 *     표본에 교차 객체가 없어 DXF 순서로 짐작), BD 40 매개변수, 3BD 10 점, B 75 마지막 점 참조 있음.
 *     (DXF는 40·10 다음에 332·74·92가 온다)
 * - 주석 축척 컨텍스트 데이터(ACDB_…OBJECTCONTEXTDATA_CLASS 14종): ../ctxcodec.ts. 치수 레코드의 블록(DXF 2)은
 *   블록 레코드 핸들로 두고 build.ts가 블록을 다 읽은 뒤 이름으로 바꾼다.
 * - 동적 블록 객체(평가 그래프·매개변수·그립·동작·표현 자료 등): 사양에 없다. 배치는 ../dyncodec.ts.
 *
 * 풀다가 자료 비트가 남거나 모자라면(배치가 맞지 않는 파일) null을 돌려 원본 태그 없이 둔다.
 */
import type { FieldObject, RawTag } from '../../../core/model';
import { fieldListTags, fieldTags } from '../../fields';
import { BitReader } from '../bitstream';
import { CTX_TYPES, decodeCtx } from '../ctxcodec';
import { DYN_TYPES, decodeDyn } from '../dyncodec';
import { stringStreamRange } from '../streams';
import { R2007 } from '../version';
import { readField, readFieldList } from './field';
import { hex } from './nonentities';
import type { ObjectReader } from './reader';

export interface DecodedRaw {
  raw: RawTag[];
  field?: FieldObject;
}

/** 풀 수 있는 종류 */
export const RAW_TAG_TYPES = new Set(['FIELD', 'FIELDLIST', 'DIMASSOC', ...CTX_TYPES.keys(), ...DYN_TYPES]);

/** 자료 흐름을 다 읽었는지(R2007+는 끝의 문자열 흐름 표지 비트 하나를 남길 수 있다) */
function consumed(or: ObjectReader): boolean {
  const r = or.dat;
  if (r.overflowed()) return false;
  if (or.ver >= R2007) return r.pos === r.end || r.pos === r.end - 1;
  return r.pos === r.end;
}

/** R2007+ 문자열 흐름을 다 읽었는지(문자열 흐름이 없으면 참) */
function stringsConsumed(or: ObjectReader): boolean {
  if (or.ver < R2007) return true;
  const rg = stringStreamRange(new BitReader(or.buf, or.ver, or.dat.decoder), or.h.startBit, or.h.handleBit);
  return rg ? or.str.pos === rg.end : true;
}

const pt3 = (code: number, p: { x: number; y: number; z: number }, out: RawTag[]) => out.push({ code, value: p.x }, { code: code + 10, value: p.y }, { code: code + 20, value: p.z });

function dimAssoc(or: ObjectReader): RawTag[] {
  const r = or.dat;
  const hr = or.hdl;
  const hb = or.h.handle;
  const out: RawTag[] = [{ code: 100, value: 'AcDbDimAssoc' }];
  out.push({ code: 330, value: hex(hr.H(hb)) || '0' });
  const flags = r.BL();
  out.push({ code: 90, value: flags }, { code: 70, value: r.B() }, { code: 71, value: r.RC() });
  let n = 0;
  for (let b = flags & 0xff; b; b >>= 1) n += b & 1;
  for (let i = 0; i < n; i++) {
    out.push({ code: 1, value: r.TV() });
    out.push({ code: 72, value: r.RC() });
    const nm = r.checkCount(r.BL(), 1);
    for (let k = 0; k < nm; k++) out.push({ code: 331, value: hex(hr.H(hb)) || '0' });
    out.push({ code: 73, value: r.BS() }, { code: 91, value: r.BL() });
    // 교차 객체 경로는 DWG에서 매개변수·점보다 앞이고 DXF에서는 뒤다
    const inter: RawTag[] = [];
    const ni = r.checkCount(r.BL(), 1);
    for (let k = 0; k < ni; k++) inter.push({ code: 332, value: hex(hr.H(hb)) || '0' });
    if (ni > 0) inter.push({ code: 74, value: r.BS() }, { code: 92, value: r.BL() });
    out.push({ code: 40, value: r.BD() });
    pt3(10, r.BD3(), out);
    out.push(...inter);
    out.push({ code: 75, value: r.B() });
  }
  return out;
}

/** 공통 자료까지 읽은 객체의 원본 태그. 풀 수 없으면 null */
export function decodeRawTags(or: ObjectReader, type: string): DecodedRaw | null {
  if (!RAW_TAG_TYPES.has(type)) return null;
  try {
    let res: DecodedRaw;
    switch (type) {
      case 'FIELD': {
        const f = readField(or);
        res = { raw: fieldTags(f, or.ver), field: f };
        break;
      }
      case 'FIELDLIST': {
        const fl = readFieldList(or);
        res = { raw: fieldListTags(fl.handles, fl.flags) };
        break;
      }
      case 'DIMASSOC':
        res = { raw: dimAssoc(or) };
        break;
      default:
        if (CTX_TYPES.has(type)) {
          res = { raw: decodeCtx(type, or.dat, or.hdl, or.h.handle, or.ver) };
          if (!stringsConsumed(or)) return null;
          break;
        }
        if (!DYN_TYPES.has(type)) return null;
        res = { raw: decodeDyn(type, or.dat, or.hdl, or.h.handle) };
        if (!stringsConsumed(or)) return null;
    }
    return consumed(or) ? res : null;
  } catch {
    // 배치가 맞지 않는 객체(DynLayoutError, 개수 오류 등)는 원본 비트만 남긴다
    return null;
  }
}
