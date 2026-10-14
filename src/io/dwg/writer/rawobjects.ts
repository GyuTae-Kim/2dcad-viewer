/**
 * 원본 태그(GenericObject.raw)나 필드 모델 값으로 쓰는 비도형 객체(objects/rawtags.ts·objects/field.ts의 짝):
 * FIELD·FIELDLIST(사양 20.4.76·77), DIMASSOC(표본으로 정한 배치), ACDB_TEXTOBJECTCONTEXTDATA_CLASS(사양 20.4.89·71 + 표본).
 */
import type { FieldObject, FieldValue, GenericObject, RawTag } from '../../../core/model';
import { fieldFromTags, fieldListHandles } from '../../fields';
import { R2004, R2007, R2010 } from '../version';
import type { BitWriter } from './bitwriter';
import type { WCtx } from './context';
import { HARD_OWNER, HARD_PTR, SOFT_PTR } from './objwriter';

const DEG2RAD = Math.PI / 180;
const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 이 종류를 원본 태그·모델 값으로 쓸 수 있는지 */
export function rawObjectOk(o: GenericObject, ver: number): boolean {
  switch (o.type) {
    case 'FIELD':
      return ver >= R2004 && !!(o.field ?? fieldFromTags(o.raw));
    case 'FIELDLIST':
      return ver >= R2004 && !!o.raw?.some((t) => t.code === 100 && String(t.value).trim() === 'AcDbIdSet');
    case 'DIMASSOC':
      return !!parseDimAssoc(o.raw);
    case 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS':
      return ver >= R2010 && !!parseTextContext(o.raw);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// FIELD

function utf16z(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  out.push(0);
  return out;
}

function hexBytes(s: string): number[] {
  const t = s.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) out.push(parseInt(t.substr(i, 2), 16));
  return out;
}

/** 값(사양 20.4.99) */
export function writeFieldValue(d: BitWriter, hd: BitWriter, ctx: WCtx, v: FieldValue): void {
  const ver = ctx.ver;
  const flags = v.flags ?? 0;
  if (ver >= R2007) d.BL(flags);
  d.BL(v.type);
  if (!(ver >= R2007 && flags & 1)) {
    switch (v.type) {
      case 0:
      case 1:
        d.BL(num(v.value));
        break;
      case 2:
        d.BD(num(v.value));
        break;
      case 4: {
        const s = v.value === undefined ? '' : String(v.value);
        if (ver < R2007) d.TV(s);
        else {
          // 자료 흐름에 바이트 수 + UTF-16LE(끝 0 포함)
          const u = utf16z(s);
          d.BL(u.length * 2);
          for (const c of u) d.RS(c);
        }
        break;
      }
      case 64:
        hd.H(SOFT_PTR, ctx.ref(v.value === undefined ? undefined : String(v.value)));
        break;
      case 16:
      case 32: {
        const p = String(v.value ?? '').split(',').map(Number);
        const n = v.type === 16 ? 2 : 3;
        const dv = new DataView(new ArrayBuffer(n * 8));
        for (let i = 0; i < n; i++) dv.setFloat64(i * 8, Number.isFinite(p[i]) ? p[i]! : 0, true);
        d.BL(n * 8);
        for (let i = 0; i < n * 8; i++) d.RC(dv.getUint8(i));
        break;
      }
      default: {
        const b = hexBytes(String(v.value ?? ''));
        d.BL(b.length);
        for (const x of b) d.RC(x);
      }
    }
  }
  if (ver >= R2007) {
    d.BL(v.unit ?? 0);
    d.TV(v.format ?? '');
    d.TV(v.text ?? '');
  }
}

function writeField(d: BitWriter, hd: BitWriter, ctx: WCtx, f: FieldObject): void {
  const ver = ctx.ver;
  d.TV(f.evaluator);
  d.TV(f.code);
  // 자식·객체 핸들은 순번(_FldIdx·_ObjIdx)이 맞도록 쓰지 않는 객체도 자리(0)를 남긴다
  d.BL(f.children.length);
  for (const h of f.children) hd.H(HARD_OWNER, ctx.ref(h));
  d.BL(f.objects.length);
  for (const h of f.objects) hd.H(SOFT_PTR, ctx.ref(h));
  if (ver <= R2004) d.TV(f.format ?? '');
  d.BL(f.evalOptions);
  d.BL(f.filingOptions);
  d.BL(f.state);
  d.BL(f.evalStatus);
  d.BL(f.errorCode);
  d.TV(f.errorMessage);
  writeFieldValue(d, hd, ctx, f.value ?? { type: 0 });
  const vs = f.valueString ?? '';
  d.TV(vs);
  d.BL(vs.length);
  const data = f.data ?? [];
  d.BL(data.length);
  for (const x of data) {
    d.TV(x.key);
    writeFieldValue(d, hd, ctx, x.value);
  }
}

// ---------------------------------------------------------------------------
// DIMASSOC

interface PointRef {
  cls: string;
  osnap: number;
  main: string[];
  subent: number;
  gsMarker: number;
  param: number;
  point: { x: number; y: number; z: number };
  inter: string[];
  interSubent: number;
  interGsMarker: number;
  last: number;
}

interface DimAssocRaw {
  dim: string;
  flags: number;
  transSpace: number;
  rotated: number;
  refs: PointRef[];
}

function afterMarker(raw: readonly RawTag[] | undefined, marker: string): RawTag[] | null {
  if (!raw) return null;
  const i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === marker);
  return i < 0 ? null : raw.slice(i + 1);
}

export function parseDimAssoc(raw: readonly RawTag[] | undefined): DimAssocRaw | null {
  const tags = afterMarker(raw, 'AcDbDimAssoc');
  if (!tags) return null;
  const out: DimAssocRaw = { dim: '', flags: 0, transSpace: 0, rotated: 0, refs: [] };
  let ref: PointRef | null = null;
  for (const t of tags) {
    if (t.code === 100) break;
    if (t.code === 1) {
      ref = { cls: String(t.value), osnap: 0, main: [], subent: 0, gsMarker: 0, param: 0, point: { x: 0, y: 0, z: 0 }, inter: [], interSubent: 0, interGsMarker: 0, last: 0 };
      out.refs.push(ref);
      continue;
    }
    if (!ref) {
      if (t.code === 330 && !out.dim) out.dim = String(t.value);
      else if (t.code === 90) out.flags = num(t.value);
      else if (t.code === 70) out.transSpace = num(t.value);
      else if (t.code === 71) out.rotated = num(t.value);
      continue;
    }
    switch (t.code) {
      case 72:
        ref.osnap = num(t.value);
        break;
      case 331:
        ref.main.push(String(t.value));
        break;
      case 73:
        ref.subent = num(t.value);
        break;
      case 91:
        ref.gsMarker = num(t.value);
        break;
      case 40:
        ref.param = num(t.value);
        break;
      case 10:
        ref.point.x = num(t.value);
        break;
      case 20:
        ref.point.y = num(t.value);
        break;
      case 30:
        ref.point.z = num(t.value);
        break;
      case 332:
        ref.inter.push(String(t.value));
        break;
      case 74:
        ref.interSubent = num(t.value);
        break;
      case 92:
        ref.interGsMarker = num(t.value);
        break;
      case 75:
        ref.last = num(t.value);
        break;
    }
  }
  let n = 0;
  for (let b = out.flags & 0xff; b; b >>= 1) n += b & 1;
  return n === out.refs.length ? out : null;
}

function writeDimAssoc(d: BitWriter, hd: BitWriter, ctx: WCtx, a: DimAssocRaw): void {
  hd.H(SOFT_PTR, ctx.ref(a.dim));
  d.BL(a.flags);
  d.B(a.transSpace ? 1 : 0);
  d.RC(a.rotated & 0xff);
  for (const r of a.refs) {
    d.TV(r.cls);
    d.RC(r.osnap & 0xff);
    d.BL(r.main.length);
    for (const h of r.main) hd.H(SOFT_PTR, ctx.ref(h));
    d.BS(r.subent);
    d.BL(r.gsMarker);
    d.BL(r.inter.length);
    for (const h of r.inter) hd.H(SOFT_PTR, ctx.ref(h));
    if (r.inter.length) {
      d.BS(r.interSubent);
      d.BL(r.interGsMarker);
    }
    d.BD(r.param);
    d.BD3(r.point);
    d.B(r.last ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// 문자 주석 축척 자료

interface TextContext {
  version: number;
  isDefault: number;
  scale: string;
  hmode: number;
  rotation: number;
  insert: { x: number; y: number };
  align: { x: number; y: number };
}

export function parseTextContext(raw: readonly RawTag[] | undefined): TextContext | null {
  const a = afterMarker(raw, 'AcDbObjectContextData');
  const b = afterMarker(raw, 'AcDbAnnotScaleObjectContextData');
  if (!a || !b) return null;
  const first = (tags: RawTag[], code: number) => {
    for (const t of tags) {
      if (t.code === 100) break;
      if (t.code === code) return t.value;
    }
    return undefined;
  };
  return {
    version: num(first(a, 70), 4),
    isDefault: num(first(a, 290)),
    scale: String(first(b, 340) ?? ''),
    hmode: num(first(b, 70)),
    rotation: num(first(b, 50)),
    insert: { x: num(first(b, 10)), y: num(first(b, 20)) },
    align: { x: num(first(b, 11)), y: num(first(b, 21)) },
  };
}

function writeTextContext(d: BitWriter, hd: BitWriter, ctx: WCtx, c: TextContext): void {
  d.BS(c.version);
  d.B(c.isDefault ? 1 : 0);
  hd.H(HARD_PTR, ctx.ref(c.scale));
  d.BS(c.hmode);
  d.BD(c.rotation * DEG2RAD);
  d.RD(c.insert.x);
  d.RD(c.insert.y);
  d.RD(c.align.x);
  d.RD(c.align.y);
}

/** 형식별 본문(공통 자료 다음). rawObjectOk가 참인 객체만 */
export function writeRawObject(d: BitWriter, hd: BitWriter, ctx: WCtx, o: GenericObject): void {
  switch (o.type) {
    case 'FIELD':
      writeField(d, hd, ctx, (o.field ?? fieldFromTags(o.raw))!);
      break;
    case 'FIELDLIST': {
      const flags = num(o.raw?.find((t) => t.code === 90)?.value);
      const hs = fieldListHandles(o.raw).filter((h) => ctx.ref(h));
      d.BL(hs.length);
      d.B(flags ? 1 : 0);
      for (const h of hs) hd.H(SOFT_PTR, ctx.ref(h));
      break;
    }
    case 'DIMASSOC':
      writeDimAssoc(d, hd, ctx, parseDimAssoc(o.raw)!);
      break;
    case 'ACDB_TEXTOBJECTCONTEXTDATA_CLASS':
      writeTextContext(d, hd, ctx, parseTextContext(o.raw)!);
      break;
  }
}
