/**
 * AutoCAD 필드(FIELD 객체, AcDbField) — DXF 태그 ↔ 모델 값, 객체의 필드 코드 찾기.
 *
 * AutoCAD는 필드가 든 문자(TEXT·MTEXT·ATTRIB·ATTDEF)의 확장 사전에 ACAD_FIELD 항목을 둔다. 그 항목은 사전
 * (항목 "TEXT" → FIELD)이거나 FIELD 자체다. 맨 위 FIELD는 평가기 "_text"이고 코드는 자리 표시(%<\_FldIdx n>%)가 든
 * 문자이며, n번째 자식 FIELD가 실제 필드 코드(\AcVar Date \f "…")를 가진다. 객체 필드의 객체는 %<\_ObjIdx n>%로
 * 적고 n번째 객체 핸들(331)을 가리킨다. fieldCodesOf()는 이 구조를 풀어 앱의 템플릿 표기
 * (%<\AcVar …>%, Object(%<\_ObjId 핸들>%))로 돌려준다.
 *
 * DXF 태그 순서(AutoCAD DXF 참조): 100 AcDbField, 1 평가기, 2·3 코드(255자 조각), 90 자식 수, 360 자식…, 97 객체 수,
 * 331 객체…, (R2004 이전) 4 형식, 91 평가 시점, 92 저장, 94 상태, 95 평가 결과, 96 오류 코드, 300 오류 메시지,
 * 93 자료 수, (6 키 + 값)…, 7 ACFD_FIELD_VALUE + 값, 301·9 값 문자열(255자 조각), 98 값 문자열 길이.
 * 값(사양 20.4.99): (R2007+) 93 플래그, 90 종류, 값(91 정수·140 실수·1 문자열·330 객체·92 크기 + 310 바이트·
 * 10/11 점), (R2007+) 94 단위, 300 형식, 302 값 문자열, 304 ACVALUE_END.
 */
import type { CadDocument, CadObject, DictionaryObject, FieldObject, FieldValue, GenericObject, RawTag } from '../core/model';
import { decodeCadEscapes } from '../core/codepage';

export const FIELD_VALUE_KEY = 'ACFD_FIELD_VALUE';

const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: string | number | undefined): string => (v === undefined ? '' : String(v));
const handleOf = (v: string | number | undefined): string => str(v).trim().toUpperCase().replace(/^0+(?=.)/, '');

/** 255자 조각(서로게이트 쌍을 자르지 않는다) */
function chunks255(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (cur.length + ch.length > 255) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// DXF 태그 → 모델

class Cursor {
  i = 0;
  constructor(readonly tags: readonly RawTag[]) {}
  peek(): RawTag | undefined {
    return this.tags[this.i];
  }
  next(): RawTag | undefined {
    return this.tags[this.i++];
  }
  /** code이면 읽는다 */
  take(code: number): RawTag | undefined {
    const t = this.tags[this.i];
    if (t && t.code === code) {
      this.i++;
      return t;
    }
    return undefined;
  }
}

/** 값 하나(93/90부터 304 또는 다음 값 표지 앞까지) */
function readValueTags(c: Cursor): FieldValue {
  const v: FieldValue = { type: 0 };
  const f = c.take(93);
  if (f) v.flags = num(f.value);
  const t = c.take(90);
  if (t) v.type = num(t.value);
  let bin = '';
  let text = '';
  let hasText = false;
  for (;;) {
    const x = c.peek();
    if (!x) break;
    // 다음 자료 항목·값·값 문자열이면 끝(R2004 이전 값은 304가 없다)
    if (x.code === 6 || x.code === 7 || x.code === 301 || x.code === 9 || x.code === 98 || x.code === 100) break;
    if (x.code === 93 || (x.code === 90 && v.flags === undefined && t)) break;
    c.next();
    if (x.code === 304) break;
    switch (x.code) {
      case 91:
        if (v.type === 1 || v.type === 0) v.value = num(x.value);
        break;
      case 140:
        v.value = num(x.value);
        break;
      case 1:
      case 2:
      case 3:
        text += str(x.value);
        hasText = true;
        break;
      case 330:
      case 331:
      case 340:
      case 360:
        v.value = handleOf(x.value);
        break;
      case 92:
        break;
      case 310:
        bin += str(x.value);
        break;
      case 10:
      case 11:
        v.value = `${num(x.value)},${num(c.take(x.code + 10)?.value)},${num(c.take(x.code + 20)?.value)}`;
        break;
      case 94:
        v.unit = num(x.value);
        break;
      case 300:
        v.format = str(x.value);
        break;
      case 302:
        v.text = str(x.value);
        break;
    }
  }
  if (hasText) v.value = text;
  else if (bin) v.value = bin.toUpperCase();
  return v;
}

/** FIELD 원본 태그(100 AcDbField부터) → 모델 값. AcDbField가 없으면 null */
export function fieldFromTags(raw: readonly RawTag[] | undefined): FieldObject | null {
  if (!raw) return null;
  const start = raw.findIndex((t) => t.code === 100 && str(t.value).trim() === 'AcDbField');
  if (start < 0) return null;
  const c = new Cursor(raw.slice(start + 1));
  const f: FieldObject = { evaluator: '', code: '', children: [], objects: [], evalOptions: 0, filingOptions: 0, state: 0, evalStatus: 0, errorCode: 0, errorMessage: '' };
  f.evaluator = str(c.take(1)?.value);
  let code = '';
  for (let t = c.peek(); t && (t.code === 2 || t.code === 3); t = c.peek()) code += str(c.next()!.value);
  f.code = code;
  const nc = c.take(90);
  if (nc) for (let k = 0, n = num(nc.value); k < n && c.peek()?.code === 360; k++) f.children.push(handleOf(c.next()!.value));
  const no = c.take(97);
  if (no) for (let k = 0, n = num(no.value); k < n && c.peek()?.code === 331; k++) f.objects.push(handleOf(c.next()!.value));
  const fmt = c.take(4);
  if (fmt) f.format = str(fmt.value);
  f.evalOptions = num(c.take(91)?.value);
  f.filingOptions = num(c.take(92)?.value);
  f.state = num(c.take(94)?.value);
  f.evalStatus = num(c.take(95)?.value);
  f.errorCode = num(c.take(96)?.value);
  f.errorMessage = str(c.take(300)?.value);
  const nd = c.take(93);
  if (nd) {
    const n = num(nd.value);
    const data: { key: string; value: FieldValue }[] = [];
    for (let k = 0; k < n && c.peek()?.code === 6; k++) {
      const key = str(c.next()!.value);
      data.push({ key, value: readValueTags(c) });
    }
    if (data.length) f.data = data;
  }
  if (c.peek()?.code === 7) {
    c.next();
    f.value = readValueTags(c);
  }
  let vs = '';
  let hasVs = false;
  for (let t = c.peek(); t && (t.code === 301 || t.code === 9); t = c.peek()) {
    vs += str(c.next()!.value);
    hasVs = true;
  }
  if (hasVs) f.valueString = vs;
  return f;
}

// ---------------------------------------------------------------------------
// 모델 → DXF 태그

function valueTags(v: FieldValue, ver: number, out: RawTag[]): void {
  const r2007 = ver >= 1021;
  if (r2007) out.push({ code: 93, value: v.flags ?? 0 });
  out.push({ code: 90, value: v.type });
  if (!(r2007 && (v.flags ?? 0) & 1)) {
    switch (v.type) {
      case 0:
      case 1:
        if (v.value !== undefined) out.push({ code: 91, value: num(v.value) });
        break;
      case 2:
        out.push({ code: 140, value: num(v.value) });
        break;
      case 4: {
        const parts = chunks255(str(v.value));
        for (let i = 0; i < parts.length - 1; i++) out.push({ code: 2, value: parts[i]! });
        out.push({ code: 1, value: parts[parts.length - 1]! });
        break;
      }
      case 64:
        out.push({ code: 330, value: str(v.value) || '0' });
        break;
      case 16:
      case 32: {
        const p = str(v.value).split(',').map(Number);
        out.push({ code: 11, value: p[0] || 0 }, { code: 21, value: p[1] || 0 }, { code: 31, value: p[2] || 0 });
        break;
      }
      default: {
        const hexs = str(v.value).replace(/[^0-9a-fA-F]/g, '');
        if (v.type === 0 && !hexs) break;
        out.push({ code: 92, value: hexs.length >> 1 });
        for (let i = 0; i < hexs.length; i += 254) out.push({ code: 310, value: hexs.slice(i, i + 254).toUpperCase() });
      }
    }
  }
  if (r2007) {
    out.push({ code: 94, value: v.unit ?? 0 });
    out.push({ code: 300, value: v.format ?? '' });
    out.push({ code: 302, value: v.text ?? '' });
    out.push({ code: 304, value: 'ACVALUE_END' });
  }
}

/** 모델 값 → FIELD DXF 태그(100 AcDbField부터). ver는 대상 DXF 버전 번호(1018 …) */
export function fieldTags(f: FieldObject, ver: number): RawTag[] {
  const out: RawTag[] = [{ code: 100, value: 'AcDbField' }, { code: 1, value: f.evaluator }];
  const parts = chunks255(f.code);
  out.push({ code: 2, value: parts[0]! });
  for (let i = 1; i < parts.length; i++) out.push({ code: 3, value: parts[i]! });
  out.push({ code: 90, value: f.children.length });
  for (const h of f.children) out.push({ code: 360, value: h });
  out.push({ code: 97, value: f.objects.length });
  for (const h of f.objects) out.push({ code: 331, value: h });
  if (ver < 1021) out.push({ code: 4, value: f.format ?? '' });
  out.push(
    { code: 91, value: f.evalOptions },
    { code: 92, value: f.filingOptions },
    { code: 94, value: f.state },
    { code: 95, value: f.evalStatus },
    { code: 96, value: f.errorCode },
    { code: 300, value: f.errorMessage },
  );
  const data = f.data ?? [];
  out.push({ code: 93, value: data.length });
  for (const d of data) {
    out.push({ code: 6, value: d.key });
    valueTags(d.value, ver, out);
  }
  out.push({ code: 7, value: FIELD_VALUE_KEY });
  valueTags(f.value ?? { type: 0 }, ver, out);
  const vs = f.valueString ?? '';
  const vp = chunks255(vs);
  out.push({ code: 301, value: vp[0]! });
  for (let i = 1; i < vp.length; i++) out.push({ code: 9, value: vp[i]! });
  out.push({ code: 98, value: vs.length });
  return out;
}

/** FIELDLIST 원본 태그의 필드 핸들(330) */
export function fieldListHandles(raw: readonly RawTag[] | undefined): string[] {
  if (!raw) return [];
  return raw.filter((t) => t.code === 330).map((t) => handleOf(t.value)).filter((h) => h && h !== '0');
}

/** 핸들 목록 → FIELDLIST DXF 태그 */
export function fieldListTags(handles: readonly string[], flags = 0): RawTag[] {
  return [{ code: 100, value: 'AcDbIdSet' }, { code: 90, value: flags }, ...handles.map((h) => ({ code: 330, value: h })), { code: 100, value: 'AcDbFieldList' }];
}

// ---------------------------------------------------------------------------
// 객체의 필드 코드

/** FIELD 객체의 모델 값(DWG 리더가 채운 값, 없으면 원본 태그를 푼다) */
export function fieldOf(o: CadObject | undefined): FieldObject | null {
  if (!o || o.type !== 'FIELD') return null;
  const g = o as GenericObject;
  return g.field ?? fieldFromTags(g.raw);
}

export interface EntityFieldCodes {
  /** 필드 코드가 제자리에 든 문자(앱의 OPENCAD_FIELD 템플릿 표기) */
  template: string;
  /** 필드 코드(%<\평가기 …>%)마다 */
  codes: string[];
  /** 맨 위 FIELD 핸들 */
  handle: string;
  /** AutoCAD가 마지막으로 평가한 값 문자열(있으면) */
  value?: string;
}

const wrap = (code: string): string => {
  const c = code.trim();
  return c.startsWith('%<') ? c : `%<${c}>%`;
};

/** 필드 하나의 코드: 자식 자리(_FldIdx)·객체 자리(_ObjIdx)를 채운다 */
function expand(doc: CadDocument, f: FieldObject, depth: number, codes: string[] | null): string {
  let s = f.code.replace(/%<\\_ObjIdx\s+(\d+)\s*>%/g, (m, n: string) => {
    const h = f.objects[Number(n)];
    return h ? `%<\\_ObjId ${h}>%` : m;
  });
  if (depth > 8) return s;
  s = s.replace(/%<\\_FldIdx\s+(\d+)\s*>%/g, (m, n: string) => {
    const ch = fieldOf(doc.objects.get(f.children[Number(n)] ?? ''));
    if (!ch) return m;
    const code = wrap(expand(doc, ch, depth + 1, null));
    codes?.push(code);
    return code;
  });
  return s;
}

/** 확장 사전의 ACAD_FIELD가 가리키는 맨 위 FIELD 핸들 */
function topFieldHandle(doc: CadDocument, xdict: string | undefined): string | null {
  if (!xdict) return null;
  const d = doc.objects.get(xdict.toUpperCase());
  if (!d || (d.type !== 'DICTIONARY' && d.type !== 'ACDBDICTIONARYWDFLT')) return null;
  let h: string | undefined;
  for (const [k, v] of (d as DictionaryObject).entries) if (k.toUpperCase() === 'ACAD_FIELD') h = v;
  if (!h) return null;
  const o = doc.objects.get(h.toUpperCase());
  if (o?.type === 'FIELD') return o.handle || h.toUpperCase();
  if (o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT')) {
    const entries = [...(o as DictionaryObject).entries];
    const pick = entries.find(([k]) => k.toUpperCase() === 'TEXT') ?? entries.find(([, v]) => doc.objects.get(v.toUpperCase())?.type === 'FIELD');
    if (pick && doc.objects.get(pick[1].toUpperCase())?.type === 'FIELD') return pick[1].toUpperCase();
  }
  return null;
}

/**
 * 객체(TEXT·MTEXT·ATTRIB·ATTDEF, 확장 사전이 있는 어떤 객체든)의 AutoCAD 필드 코드.
 * 필드가 없으면 null. template은 필드 코드가 제자리에 든 문자다(앱의 OPENCAD_FIELD 템플릿과 같은 표기).
 */
export function fieldCodesOf(doc: CadDocument, entity: { xdict?: string }): EntityFieldCodes | null {
  const h = topFieldHandle(doc, entity.xdict);
  if (!h) return null;
  const top = fieldOf(doc.objects.get(h));
  if (!top) return null;
  const codes: string[] = [];
  let template: string;
  if (top.evaluator === '_text' || /%<\\_FldIdx/.test(top.code)) template = expand(doc, top, 0, codes);
  else {
    template = wrap(expand(doc, top, 0, null));
    codes.push(template);
  }
  if (!codes.length) return null;
  // R2007 이전 DXF는 비ASCII 문자를 \U+XXXX로 쓰고 리더는 그대로 둔다 → 앱 템플릿처럼 푼다
  const out: EntityFieldCodes = { template: decodeCadEscapes(template), codes: codes.map(decodeCadEscapes), handle: h };
  const v = top.valueString ?? top.value?.text ?? (typeof top.value?.value === 'string' ? top.value.value : undefined);
  if (v !== undefined) out.value = decodeCadEscapes(v);
  return out;
}
