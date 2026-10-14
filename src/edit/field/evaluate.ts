/**
 * 필드 평가: 필드 코드가 든 서식 문자(템플릿)를 값 문자로 바꾼다.
 * 평가하지 못한 필드는 AutoCAD처럼 ####, 값이 비어 있으면 ----로 보인다.
 */
import type { CadDocument, Entity, Vec2 } from '../../core/model';
import { entityPath } from '../geom/path';
import { flattenPath, pathLength } from '../geom/curve';
import { type FieldPart, objectHandleOf, objectPropertyOf, splitFields } from './code';
import { formatAngleValue, formatDate, formatFileName, formatNumber, textCase, type NumberFormatContext } from './format';

export interface FieldContext {
  doc: CadDocument;
  /** 도면 파일 이름(경로가 있으면 경로 포함) */
  fileName: string;
  fileSize?: number;
  now: Date;
  /** 객체 찾기(없으면 doc.entityIndex) */
  entity?: (handle: string) => Entity | undefined;
}

export const FIELD_ERROR = '####';
export const FIELD_EMPTY = '----';

/** 율리우스 날짜(현지 시각으로 저장된 값) → 현지 Date */
export function julianToLocal(jd: number): Date | null {
  if (!(Number.isFinite(jd) && jd > 0)) return null;
  const u = new Date(Math.round((jd - 2440587.5) * 86400000));
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
}

function numCtx(doc: CadDocument): NumberFormatContext {
  const n = (k: string, d: number) => {
    const v = doc.header.get(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  return { luprec: n('$LUPREC', 4), lunits: n('$LUNITS', 2) };
}

/** 문서 특성 값(이 모델에는 요약 정보가 없어 헤더 변수가 있으면 그것) */
const DOC_PROPS: Record<string, string> = {
  AUTHOR: '$AUTHOR',
  TITLE: '$TITLE',
  SUBJECT: '$SUBJECT',
  KEYWORDS: '$KEYWORDS',
  COMMENTS: '$COMMENTS',
  LASTSAVEDBY: '$LASTSAVEDBY',
  HYPERLINKBASE: '$HYPERLINKBASE',
};

function shoelace(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** 객체 특성 값(숫자 또는 문자, 모르면 null) */
export function objectProperty(e: Entity, prop: string): { num: number; kind: 'length' | 'area' | 'angle' | 'number' } | { str: string } | null {
  const p = prop.toLowerCase();
  const path = entityPath(e);
  switch (p) {
    case 'length':
    case 'perimeter': {
      if (e.type === 'CIRCLE') return { num: 2 * Math.PI * e.radius, kind: 'length' };
      if (e.type === 'LINE') return { num: Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, e.end.z - e.start.z), kind: 'length' };
      if (!path) return null;
      return { num: pathLength(path), kind: 'length' };
    }
    case 'circumference':
      return e.type === 'CIRCLE' ? { num: 2 * Math.PI * e.radius, kind: 'length' } : null;
    case 'area': {
      if (e.type === 'CIRCLE') return { num: Math.PI * e.radius * e.radius, kind: 'area' };
      if (!path) return null;
      const size = Math.max(1e-9, pathLength(path));
      return { num: shoelace(flattenPath(path, size * 1e-5)), kind: 'area' };
    }
    case 'radius':
      return e.type === 'CIRCLE' || e.type === 'ARC' ? { num: e.radius, kind: 'length' } : null;
    case 'diameter':
      return e.type === 'CIRCLE' || e.type === 'ARC' ? { num: e.radius * 2, kind: 'length' } : null;
    case 'angle':
      if (e.type === 'LINE') return { num: Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x), kind: 'angle' };
      if (e.type === 'ARC') {
        let s = e.endAngle - e.startAngle;
        while (s <= 0) s += Math.PI * 2;
        return { num: s, kind: 'angle' };
      }
      return null;
    case 'rotation':
      return 'rotation' in e && typeof e.rotation === 'number' ? { num: e.rotation, kind: 'angle' } : null;
    case 'height':
      return 'height' in e && typeof e.height === 'number' ? { num: e.height, kind: 'length' } : null;
    case 'layer':
      return { str: e.layer };
    case 'linetype':
      return { str: e.linetype };
    case 'textstring':
    case 'contents':
      return 'text' in e && typeof e.text === 'string' ? { str: e.text } : null;
    case 'name':
      return e.type === 'INSERT' ? { str: e.block } : null;
    default:
      return null;
  }
}

/** 필드 하나의 값(평가하지 못하면 null) */
export function evaluateField(f: FieldPart, ctx: FieldContext): string | null {
  const doc = ctx.doc;
  const nc = numCtx(doc);
  if (f.evaluator === 'AcVar') {
    const name = f.body.trim();
    const key = name.toUpperCase();
    switch (key) {
      case 'DATE':
        return formatDate(ctx.now, f.format);
      case 'CREATEDATE': {
        const d = julianToLocal(Number(doc.header.get('$TDCREATE')));
        return d ? formatDate(d, f.format) : FIELD_EMPTY;
      }
      case 'SAVEDATE': {
        const d = julianToLocal(Number(doc.header.get('$TDUPDATE')));
        return d ? formatDate(d, f.format) : FIELD_EMPTY;
      }
      case 'FILENAME':
        return formatFileName(ctx.fileName, f.format);
      case 'FILESIZE':
        return ctx.fileSize !== undefined ? `${formatNumber(ctx.fileSize / 1024, '%pr0%th', nc)} KB` : FIELD_EMPTY;
    }
    const dp = DOC_PROPS[key];
    if (dp) {
      const v = doc.header.get(dp);
      return typeof v === 'string' && v ? textCase(v, f.format) : FIELD_EMPTY;
    }
    // 시스템 변수
    const v = doc.header.get(`$${key}`);
    if (v === undefined) return null;
    if (typeof v === 'number') return formatNumber(v, f.format, nc);
    if (typeof v === 'string') return textCase(v, f.format);
    return `${formatNumber(v.x, f.format, nc)}, ${formatNumber(v.y, f.format, nc)}`;
  }
  if (f.evaluator === 'AcObjProp') {
    const h = objectHandleOf(f.body);
    const prop = objectPropertyOf(f.body);
    if (!h || !prop) return null;
    const e = ctx.entity ? ctx.entity(h) : doc.entityIndex.get(h);
    if (!e) return null;
    const v = objectProperty(e, prop);
    if (!v) return null;
    if ('str' in v) return textCase(v.str, f.format);
    if (v.kind === 'angle') return formatAngleValue(v.num, f.format, nc);
    return formatNumber(v.num, f.format, nc);
  }
  if (f.evaluator === 'AcDiesel') {
    const m = /^\$\(\s*getvar\s*,\s*([\w$]+)\s*\)$/i.exec(f.body.trim());
    if (!m) return null;
    const v = doc.header.get(`$${m[1]!.replace(/^\$/, '').toUpperCase()}`);
    if (v === undefined) return null;
    return typeof v === 'object' ? `${v.x},${v.y}` : String(v);
  }
  return null;
}

/** 여러 줄 문자 서식 문자로 쓸 값(\ { } 를 이스케이프) */
export function escapeMText(s: string): string {
  return s.replace(/[\\{}]/g, (c) => '\\' + c);
}

export interface EvaluateResult {
  text: string;
  fields: number;
  errors: number;
}

/** 템플릿의 필드를 모두 값으로 바꾼다 */
export function evaluateTemplate(template: string, ctx: FieldContext, opt: { mtext?: boolean } = {}): EvaluateResult {
  let text = '';
  let fields = 0;
  let errors = 0;
  for (const p of splitFields(template)) {
    if (p.kind === 'text') {
      text += p.text;
      continue;
    }
    fields++;
    let v: string | null = null;
    try {
      v = evaluateField(p, ctx);
    } catch {
      v = null;
    }
    if (v === null) {
      errors++;
      v = FIELD_ERROR;
    }
    text += opt.mtext ? escapeMText(v) : v;
  }
  return { text, fields, errors };
}
