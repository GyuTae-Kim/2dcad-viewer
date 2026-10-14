/**
 * 치수 변수 풀기: DIMSTYLE 표 값 + ACAD DSTYLE 재지정(확장 데이터).
 * 핸들 값(340~347)은 이름으로 바꾸고, 크기 변수는 DIMSCALE을 곱해 둔다.
 */
import { DIM_HANDLE_CODES, DIM_VAR_CODES, DIM_VAR_DEFAULTS } from '../../core/dimvars';
import { type CadDocument, type DimensionEntity, type TextStyle, tableKey } from '../../core/model';

export type RawVars = Record<string, number | string>;

/** 핸들 → 이름 */
function byHandle(doc: CadDocument, code: number, h: string): string | null {
  const key = h.trim().toUpperCase().replace(/^0+(?=.)/, '');
  if (!/^[0-9A-F]+$/.test(key)) return null;
  if (code === 340) {
    for (const s of doc.textStyles.values()) if (s.handle === key) return s.name;
  } else if (code >= 345) {
    for (const l of doc.linetypes.values()) if (l.handle === key) return l.name;
  } else {
    for (const r of doc.blockRecords.values()) if (r.handle === key) return r.name;
    for (const b of doc.blocks.values()) if (b.recordHandle === key || b.handle === key) return b.name;
  }
  return null;
}

const num = (v: number | string | undefined, d: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

/** 옛 DIMUNIT(270) → DIMLUNIT·DIMFRAC */
const OLD_UNIT: Record<number, [number, number]> = { 1: [1, 0], 2: [2, 0], 3: [3, 0], 4: [4, 0], 5: [5, 0], 6: [4, 2], 7: [5, 2], 8: [6, 0] };

/**
 * R2007 이전 파일: AutoCAD는 새 치수 변수를 확장 데이터(ACAD_DSTYLE_…)로 남긴다.
 * 선종류(380·381·382 → 핸들)와 문자 채움(376)만 읽는다.
 */
const XDATA_VARS: Record<string, [number, string]> = {
  ACAD_DSTYLE_DIM_LINETYPE: [380, 'DIMLTYPE'],
  ACAD_DSTYLE_DIM_EXT1_LINETYPE: [381, 'DIMLTEX1'],
  ACAD_DSTYLE_DIM_EXT2_LINETYPE: [382, 'DIMLTEX2'],
};

function xdataVars(doc: CadDocument, xdata: { app: string; items: { code: number; value: unknown }[] }[] | undefined, out: RawVars, only: Set<string> | null): void {
  if (!xdata) return;
  for (const x of xdata) {
    const app = x.app.toUpperCase();
    const lt = XDATA_VARS[app];
    if (lt && (!only || only.has(lt[1]))) {
      const h = x.items.find((i) => i.code === 1005);
      if (typeof h?.value === 'string') {
        const name = byHandle(doc, 345, h.value);
        if (name) out[lt[1]] = name;
      }
    } else if (app === 'ACAD_DSTYLE_DIMTEXT_FILL' && (!only || only.has('DIMTFILL'))) {
      const i = x.items.findIndex((it) => it.code === 1070 && it.value === 376);
      const v = x.items[i + 1]?.value;
      if (i >= 0 && typeof v === 'number') out.DIMTFILL = v;
    }
  }
}

/** 치수의 변수 값(스타일 + 재지정). 스타일이 없으면 머리말 $DIM 값을 쓴다. */
export function rawDimVars(doc: CadDocument, d: Pick<DimensionEntity, 'dimStyle' | 'overrides'> & { xdata?: DimensionEntity['xdata'] }): RawVars {
  const out: RawVars = { ...DIM_VAR_DEFAULTS };
  const ds = doc.dimStyles.get(tableKey(d.dimStyle || 'Standard'));
  if (ds) {
    Object.assign(out, ds.vars);
    // R14 이전 스타일: DIMUNIT·DIMFIT만 있다
    if (ds.vars.DIMLUNIT === undefined && ds.vars.DIMUNIT !== undefined) {
      const m = OLD_UNIT[num(ds.vars.DIMUNIT, 2)];
      if (m) {
        out.DIMLUNIT = m[0];
        if (ds.vars.DIMFRAC === undefined) out.DIMFRAC = m[1];
      }
    }
    if (ds.vars.DIMATFIT === undefined && ds.vars.DIMFIT !== undefined) {
      const f = num(ds.vars.DIMFIT, 3);
      out.DIMATFIT = f <= 3 ? f : 3;
      if (ds.vars.DIMTMOVE === undefined) out.DIMTMOVE = f === 4 ? 1 : f === 5 ? 2 : 0;
    }
    const missing = new Set(['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2', 'DIMTFILL'].filter((k) => ds.vars[k] === undefined));
    if (missing.size) xdataVars(doc, ds.xdata, out, missing);
  } else for (const [k, v] of doc.header) if (k.startsWith('$DIM') && (typeof v === 'number' || typeof v === 'string')) out[k.slice(1)] = v;
  xdataVars(doc, d.xdata, out, null);
  if (d.overrides) {
    const ov = d.overrides;
    for (const [codeS, v] of Object.entries(ov)) {
      const code = Number(codeS);
      const name = DIM_VAR_CODES[code];
      if (!name) continue;
      if (DIM_HANDLE_CODES.has(code) && typeof v === 'string') out[name] = byHandle(doc, code, v) ?? v;
      else if (DIM_HANDLE_CODES.has(code) && typeof v === 'number') out[name] = byHandle(doc, code, v.toString(16)) ?? '';
      else out[name] = v;
    }
    if (ov[270] !== undefined && ov[277] === undefined) {
      const m = OLD_UNIT[Number(ov[270])];
      if (m) {
        out.DIMLUNIT = m[0];
        if (ov[276] === undefined) out.DIMFRAC = m[1];
      }
    }
  }
  return out;
}

const str = (v: number | string | undefined): string => (v === undefined || v === null ? '' : String(v));

/** 크기에 DIMSCALE을 곱한 치수 변수 */
export interface DimVars {
  raw: RawVars;
  scale: number;
  asz: number;
  tsz: number;
  exo: number;
  exe: number;
  dle: number;
  dli: number;
  gap: number;
  /** 문자 높이(스타일 고정 높이 우선) */
  txt: number;
  cen: number;
  fxl: number;
  fxlon: boolean;
  tvp: number;
  tfac: number;
  tad: number;
  just: number;
  tih: boolean;
  toh: boolean;
  tix: boolean;
  soxd: boolean;
  tofl: boolean;
  sah: boolean;
  se1: boolean;
  se2: boolean;
  sd1: boolean;
  sd2: boolean;
  atfit: number;
  tmove: number;
  upt: boolean;
  blk1: string;
  blk2: string;
  clrd: number;
  clre: number;
  clrt: number;
  ltype: string;
  ltex1: string;
  ltex2: string;
  lwd: number;
  lwe: number;
  txsty: string;
  textStyle: TextStyle | undefined;
  tfill: number;
  tfillclr: number;
  jogang: number;
  arcsym: number;
  txtdirection: number;
}

export function dimVars(doc: CadDocument, d: Pick<DimensionEntity, 'dimStyle' | 'overrides'> & { xdata?: DimensionEntity['xdata'] }): DimVars {
  const r = rawDimVars(doc, d);
  let scale = num(r.DIMSCALE, 1);
  if (!(scale > 0)) scale = 1;
  const S = (k: string, def: number) => num(r[k], def) * scale;
  const B = (k: string) => num(r[k], 0) !== 0;
  const txsty = str(r.DIMTXSTY) || 'Standard';
  const textStyle = doc.textStyles.get(tableKey(txsty)) ?? doc.textStyles.get('STANDARD');
  let txt = S('DIMTXT', 0.18);
  if (textStyle && textStyle.height > 0) txt = textStyle.height;
  const blk = str(r.DIMBLK);
  const sah = B('DIMSAH');
  return {
    raw: r,
    scale,
    asz: S('DIMASZ', 0.18),
    tsz: S('DIMTSZ', 0),
    exo: S('DIMEXO', 0.0625),
    exe: S('DIMEXE', 0.18),
    dle: S('DIMDLE', 0),
    dli: S('DIMDLI', 0.38),
    gap: S('DIMGAP', 0.09),
    txt,
    cen: S('DIMCEN', 0.09),
    fxl: S('DIMFXL', 1),
    fxlon: B('DIMFXLON'),
    tvp: num(r.DIMTVP, 0),
    tfac: num(r.DIMTFAC, 1) || 1,
    tad: num(r.DIMTAD, 0),
    just: num(r.DIMJUST, 0),
    tih: B('DIMTIH'),
    toh: B('DIMTOH'),
    tix: B('DIMTIX'),
    soxd: B('DIMSOXD'),
    tofl: B('DIMTOFL'),
    sah,
    se1: B('DIMSE1'),
    se2: B('DIMSE2'),
    sd1: B('DIMSD1'),
    sd2: B('DIMSD2'),
    atfit: num(r.DIMATFIT, 3),
    tmove: num(r.DIMTMOVE, 0),
    upt: B('DIMUPT'),
    blk1: sah ? str(r.DIMBLK1) : blk,
    blk2: sah ? str(r.DIMBLK2) : blk,
    clrd: num(r.DIMCLRD, 0),
    clre: num(r.DIMCLRE, 0),
    clrt: num(r.DIMCLRT, 0),
    ltype: str(r.DIMLTYPE),
    ltex1: str(r.DIMLTEX1),
    ltex2: str(r.DIMLTEX2),
    lwd: num(r.DIMLWD, -2),
    lwe: num(r.DIMLWE, -2),
    txsty: textStyle?.name ?? txsty,
    textStyle,
    tfill: num(r.DIMTFILL, 0),
    tfillclr: num(r.DIMTFILLCLR, 0),
    jogang: num(r.DIMJOGANG, Math.PI / 4),
    arcsym: num(r.DIMARCSYM, 0),
    txtdirection: num(r.DIMTXTDIRECTION, 0),
  };
}
