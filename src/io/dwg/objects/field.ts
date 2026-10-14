/**
 * FIELD(사양 20.4.76)·FIELDLIST(20.4.77)와 값(20.4.99) 읽기.
 * 값 종류 4(문자열)는 R2007+에서 자료 흐름의 바이트 수(BL) + UTF-16LE 바이트다(표 셀 값과 같다, objects/table.ts).
 * 사양은 값 문자열 길이(98)를 TV로 적었지만 DXF 98은 정수라 BL로 읽는다.
 * AutoCAD가 쓴 FIELD 표본이 없어 이 배치는 사양대로이고 우리 쓰기와의 왕복으로만 확인했다.
 */
import type { FieldObject, FieldValue } from '../../../core/model';
import { DwgFormatError } from '../bitstream';
import { R2004, R2007 } from '../version';
import { hex } from './nonentities';
import type { ObjectReader } from './reader';

const HEX = '0123456789ABCDEF';

function bytesHex(b: number[]): string {
  let s = '';
  for (const x of b) s += HEX[x >> 4]! + HEX[x & 15]!;
  return s;
}

/** 값 하나 */
export function readFieldValue(or: ObjectReader): FieldValue {
  const r = or.dat;
  const ver = or.ver;
  const v: FieldValue = { type: 0 };
  if (ver >= R2007) v.flags = r.BL();
  v.type = r.BL();
  if (!((v.flags ?? 0) & 1)) {
    switch (v.type) {
      case 0:
      case 1:
        v.value = r.BL();
        break;
      case 2:
        v.value = r.BD();
        break;
      case 4:
        if (ver < R2007) v.value = r.TV();
        else {
          const n = r.checkCount(r.BL(), 8);
          const codes: number[] = [];
          for (let i = 0; i + 1 < n; i += 2) codes.push(r.RSu());
          if (n & 1) r.RC();
          let len = codes.length;
          while (len > 0 && codes[len - 1] === 0) len--;
          v.value = String.fromCharCode(...codes.slice(0, len));
        }
        break;
      case 8:
      case 16:
      case 32:
      case 512: {
        const n = r.checkCount(r.BL(), 8);
        const b: number[] = [];
        for (let i = 0; i < n; i++) b.push(r.RC());
        if ((v.type === 16 || v.type === 32) && (n === 16 || n === 24)) {
          const dv = new DataView(new Uint8Array(b).buffer);
          const p: number[] = [];
          for (let i = 0; i < n; i += 8) p.push(dv.getFloat64(i, true));
          v.value = p.join(',');
        } else v.value = bytesHex(b);
        break;
      }
      case 64:
        v.value = hex(or.hdl.H(or.h.handle)) || '0';
        break;
      default:
        throw new DwgFormatError(`필드 값 종류 ${v.type}`);
    }
  }
  if (ver >= R2007) {
    v.unit = r.BL();
    v.format = r.TV();
    v.text = r.TV();
  }
  return v;
}

/** FIELD 본문(공통 자료 다음) */
export function readField(or: ObjectReader): FieldObject {
  const r = or.dat;
  const hr = or.hdl;
  const hb = or.h.handle;
  const ver = or.ver;
  const f: FieldObject = { evaluator: '', code: '', children: [], objects: [], evalOptions: 0, filingOptions: 0, state: 0, evalStatus: 0, errorCode: 0, errorMessage: '' };
  f.evaluator = r.TV();
  f.code = r.TV();
  const nc = r.checkCount(r.BL(), 1);
  for (let i = 0; i < nc; i++) f.children.push(hex(hr.H(hb)));
  const no = r.checkCount(r.BL(), 1);
  for (let i = 0; i < no; i++) f.objects.push(hex(hr.H(hb)));
  if (ver <= R2004) f.format = r.TV();
  f.evalOptions = r.BL();
  f.filingOptions = r.BL();
  f.state = r.BL();
  f.evalStatus = r.BL();
  f.errorCode = r.BL();
  f.errorMessage = r.TV();
  f.value = readFieldValue(or);
  f.valueString = r.TV();
  r.BL(); // 값 문자열 길이
  const nd = r.checkCount(r.BL(), 2);
  if (nd) {
    f.data = [];
    for (let i = 0; i < nd; i++) {
      const key = r.TV();
      f.data.push({ key, value: readFieldValue(or) });
    }
  }
  return f;
}

/** FIELDLIST 본문: 필드 핸들과 알 수 없는 비트(DXF 90) */
export function readFieldList(or: ObjectReader): { handles: string[]; flags: number } {
  const r = or.dat;
  const n = r.checkCount(r.BL(), 1);
  const flags = r.B();
  const handles: string[] = [];
  for (let i = 0; i < n; i++) handles.push(hex(or.hdl.H(or.h.handle)) || '0');
  return { handles, flags };
}
