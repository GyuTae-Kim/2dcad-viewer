/**
 * 필드 보관: 문자 객체의 내용(text)은 평가한 값이고, 필드 코드가 든 템플릿은 확장 자료 OPENCAD_FIELD에 둔다.
 * AutoCAD는 FIELD 객체(확장 사전)를 쓰지만 이 모델에는 그 구조가 없어, 다른 프로그램에서는 마지막 값이 일반 문자로 보인다.
 */
import type { AttribEntity, Entity, MTextEntity, TextEntity, XData, XDataItem } from '../../core/model';
import { type FieldContext, evaluateTemplate } from './evaluate';
import { countFields } from './code';
import { decodeCadEscapes } from '../../core/codepage';

export const FIELD_APP = 'OPENCAD_FIELD';
const CHUNK = 80;

function chunk(s: string): string[] {
  const cps = Array.from(s);
  const parts: string[] = [];
  for (let i = 0; i < cps.length; i += CHUNK) parts.push(cps.slice(i, i + CHUNK).join(''));
  return parts;
}

/** 템플릿과 마지막으로 평가한 값(객체 내용이 이 값과 다르면 다른 명령이 문자를 고친 것) */
export function encodeFieldXData(template: string, value?: string): XData {
  const parts = chunk(template);
  const items: XDataItem[] = [{ code: 1000, value: 'OPENCAD_FIELD 1' }, { code: 1071, value: parts.length }];
  for (const p of parts) items.push({ code: 1000, value: p });
  if (value !== undefined) {
    const vs = chunk(value);
    items.push({ code: 1071, value: vs.length });
    for (const p of vs) items.push({ code: 1000, value: p });
  }
  return { app: FIELD_APP, items };
}

export interface StoredField {
  template: string;
  value?: string;
}

export function decodeFieldRecord(x: XData | undefined): StoredField | null {
  if (!x || x.app.toUpperCase() !== FIELD_APP) return null;
  const it = x.items;
  if (it[0]?.value !== 'OPENCAD_FIELD 1') return null;
  let i = 1;
  const read = (): string | undefined => {
    if (it[i]?.code !== 1071) return undefined;
    const n = Number(it[i++]?.value) || 0;
    let s = '';
    for (let k = 0; k < n; k++) s += String(it[i++]?.value ?? '');
    return decodeCadEscapes(s);
  };
  const template = read();
  if (template === undefined) return null;
  const value = read();
  return value === undefined ? { template } : { template, value };
}

export function decodeFieldXData(x: XData | undefined): string | null {
  return decodeFieldRecord(x)?.template ?? null;
}

/** 필드를 담을 수 있는 문자 객체 */
export type FieldHost = TextEntity | MTextEntity | AttribEntity;

export function isFieldHost(e: Entity | undefined): e is FieldHost {
  return !!e && (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'ATTRIB' || e.type === 'ATTDEF');
}

function record(e: { xdata?: XData[] }): StoredField | null {
  return decodeFieldRecord(e.xdata?.find((x) => x.app.toUpperCase() === FIELD_APP));
}

export function fieldTemplate(e: { xdata?: XData[] }): string | null {
  return record(e)?.template ?? null;
}

/** 다른 명령(문자 편집 등)이 내용을 바꿔 템플릿이 맞지 않는지 */
export function isFieldStale(e: { xdata?: XData[]; text?: string }): boolean {
  const r = record(e);
  if (!r || r.value === undefined || typeof e.text !== 'string') return false;
  return decodeCadEscapes(e.text) !== r.value;
}

/** 템플릿을 붙인(null이면 뗀) 확장 자료 목록 */
export function withFieldTemplate(xdata: XData[] | undefined, template: string | null, value?: string): XData[] | undefined {
  const rest = (xdata ?? []).filter((x) => x.app.toUpperCase() !== FIELD_APP);
  if (template && countFields(template) > 0) rest.push(encodeFieldXData(template, value));
  return rest.length ? rest : undefined;
}

/** 필드 수(템플릿이 없으면 0) */
export function fieldCount(e: { xdata?: XData[] }): number {
  const t = fieldTemplate(e);
  return t ? countFields(t) : 0;
}

export interface UpdateResult<T> {
  entity: T;
  /** 찾은 필드 수 */
  fields: number;
  /** 값이 바뀌어 객체를 고쳤는지 */
  changed: boolean;
  /** 내용이 바뀌어 필드를 떼어 낸 문자 수 */
  stale: number;
}

/** 문자 객체 하나의 필드를 다시 평가한다(블록 참조는 속성마다). 다른 명령이 내용을 바꾼 문자는 필드를 뗀다 */
export function updateEntityFields<T extends Entity>(e: T, ctx: FieldContext): UpdateResult<T> {
  if (e.type === 'INSERT') {
    let fields = 0;
    let changed = false;
    let stale = 0;
    const attribs = e.attribs.map((a) => {
      const r = updateEntityFields(a as unknown as Entity, ctx);
      fields += r.fields;
      stale += r.stale;
      changed ||= r.changed;
      return r.entity as unknown as AttribEntity;
    });
    return { entity: changed ? ({ ...e, attribs } as T) : e, fields, changed, stale };
  }
  if (!isFieldHost(e)) return { entity: e, fields: 0, changed: false, stale: 0 };
  const tpl = fieldTemplate(e);
  if (!tpl) return { entity: e, fields: 0, changed: false, stale: 0 };
  if (isFieldStale(e)) return { entity: { ...e, xdata: withFieldTemplate(e.xdata, null) } as T, fields: 0, changed: true, stale: 1 };
  const r = evaluateTemplate(tpl, ctx, { mtext: e.type === 'MTEXT' });
  if (r.text === e.text) return { entity: e, fields: r.fields, changed: false, stale: 0 };
  return { entity: { ...e, text: r.text, xdata: withFieldTemplate(e.xdata, tpl, decodeCadEscapes(r.text)) } as T, fields: r.fields, changed: true, stale: 0 };
}

/** 템플릿으로 새 내용과 확장 자료를 만든다 */
export function applyTemplate<T extends FieldHost>(e: T, template: string, ctx: FieldContext): T {
  const r = evaluateTemplate(template, ctx, { mtext: e.type === 'MTEXT' });
  return { ...e, text: r.text, xdata: withFieldTemplate(e.xdata, template, decodeCadEscapes(r.text)) };
}
