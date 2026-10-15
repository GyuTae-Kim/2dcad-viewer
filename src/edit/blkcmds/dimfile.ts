/**
 * DIMEX·DIMIM(Express Tools, UI 없음): 치수 스타일을 .dim 파일로 내보내고 가져온다.
 *
 * .dim 파일은 DXF 조각이다: TABLES 구역 하나에 치수 스타일이 쓰는 선종류(LTYPE)·문자 스타일(STYLE)·화살촉 블록 이름
 * (BLOCK_RECORD)과 치수 스타일(DIMSTYLE) 레코드를 담는다. 핸들 변수(DIMTXSTY 340, DIMLDRBLK 341, DIMBLK* 342~344,
 * DIMLTYPE·DIMLTEX* 345~347)는 같은 조각 안 레코드의 핸들을 가리킨다. 읽을 때는 조각 안의 핸들을 이름으로 푼다
 * (온전한 DXF 파일의 TABLES 구역도 같은 방법으로 읽힌다).
 */
import type { BlockDef, BlockRecord, CadDocument, DimStyle, Linetype, TextStyle } from '../../core/model';
import { tableKey } from '../../core/model';
import { DIM_VAR_CODES } from '../../core/dimvars';
import type { EditOp } from '../session';
import { isFixedName } from '../refedit/names';
import { builtinArrowBlock } from '../dim/arrows';

const DEG = Math.PI / 180;

/** 치수 변수 이름 → 쓸 그룹 코드(블록은 핸들 코드만, R13·R14 옛 변수는 뺀다) */
const CODE_OF = new Map<string, number>();
for (const [c, n] of Object.entries(DIM_VAR_CODES)) {
  const code = Number(c);
  // 70은 레코드 플래그와 겹치므로(DIMTFILLCLR) 쓰지 않는다
  if (code === 70 || code === 270 || code === 287 || (code >= 5 && code <= 7)) continue;
  CODE_OF.set(n, code);
}

function kindOf(code: number): 'str' | 'float' | 'int' | 'handle' {
  if (code === 3 || code === 4) return 'str';
  if (code >= 340 && code <= 347) return 'handle';
  if ((code >= 40 && code <= 59) || (code >= 140 && code <= 149)) return 'float';
  return 'int';
}

const BLOCK_VARS = ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK'] as const;
const LT_VARS = ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2'] as const;

function fnum(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  if (Number.isInteger(v)) return `${v}.0`;
  return String(+v.toPrecision(15));
}

export interface DimExportOptions {
  /** 문자 스타일 정의 전체(글꼴·높이·폭 비율)를 쓴다. 거짓이면 이름만 */
  fullTextStyle: boolean;
}

/** 치수 스타일들을 .dim 글로(줄 끝 CRLF). 없는 이름은 뺀다 */
export function writeDimFile(doc: CadDocument, names: readonly string[], opt: DimExportOptions = { fullTextStyle: true }): { text: string; styles: string[] } {
  const styles = names.map((n) => doc.dimStyles.get(tableKey(n))).filter((s): s is DimStyle => !!s);
  let serial = 0x100;
  const nh = () => (serial++).toString(16).toUpperCase();
  const textH = new Map<string, { h: string; s: TextStyle | null; name: string }>();
  const ltH = new Map<string, { h: string; l: Linetype | null; name: string }>();
  const blkH = new Map<string, { h: string; name: string }>();
  for (const s of styles) {
    const v = s.vars;
    const ts = typeof v.DIMTXSTY === 'string' && v.DIMTXSTY ? v.DIMTXSTY : 'Standard';
    const tk = tableKey(ts);
    if (!textH.has(tk)) textH.set(tk, { h: nh(), s: doc.textStyles.get(tk) ?? null, name: doc.textStyles.get(tk)?.name ?? ts });
    for (const n of LT_VARS) {
      const lt = v[n];
      if (typeof lt !== 'string' || !lt) continue;
      const lk = tableKey(lt);
      if (!ltH.has(lk)) ltH.set(lk, { h: nh(), l: doc.linetypes.get(lk) ?? null, name: doc.linetypes.get(lk)?.name ?? lt });
    }
    for (const n of BLOCK_VARS) {
      const b = v[n];
      if (typeof b !== 'string' || !b) continue;
      const bk = tableKey(b);
      if (!blkH.has(bk)) blkH.set(bk, { h: nh(), name: doc.blocks.get(bk)?.name ?? b });
    }
  }
  const out: string[] = [];
  const t = (code: number, v: string | number) => out.push(String(code).padStart(3), typeof v === 'number' ? (kindOf(code) === 'float' ? fnum(v) : String(Math.round(v))) : v);
  const f = (code: number, v: number) => out.push(String(code).padStart(3), fnum(v));
  t(999, 'OpenCAD DIMEX');
  t(0, 'SECTION');
  t(2, 'TABLES');
  // 선종류
  t(0, 'TABLE');
  t(2, 'LTYPE');
  t(70, ltH.size);
  for (const { h, l, name } of ltH.values()) {
    t(0, 'LTYPE');
    t(5, h);
    t(100, 'AcDbSymbolTableRecord');
    t(100, 'AcDbLinetypeTableRecord');
    t(2, name);
    t(70, 0);
    t(3, l?.description ?? '');
    t(72, 65);
    const els = l && !isFixedName('linetype', name) ? l.elements.filter((e) => !e.text && !e.shapeNumber) : [];
    t(73, els.length);
    f(40, els.reduce((a, e) => a + Math.abs(e.length), 0));
    for (const e of els) {
      f(49, e.length);
      t(74, 0);
    }
  }
  t(0, 'ENDTAB');
  // 문자 스타일
  t(0, 'TABLE');
  t(2, 'STYLE');
  t(70, textH.size);
  for (const { h, s, name } of textH.values()) {
    t(0, 'STYLE');
    t(5, h);
    t(100, 'AcDbSymbolTableRecord');
    t(100, 'AcDbTextStyleTableRecord');
    t(2, name);
    t(70, s && opt.fullTextStyle ? s.flags & ~(16 | 32 | 64) : 0);
    if (s && opt.fullTextStyle) {
      f(40, s.height);
      f(41, s.widthFactor);
      f(50, s.oblique / DEG);
      t(71, s.generation);
      f(42, s.lastHeight);
      t(3, s.font);
      t(4, s.bigFont);
      if (s.fontFamily) {
        t(1001, 'ACAD');
        t(1000, s.fontFamily);
        t(1071, s.fontFlags ?? 0);
      }
    }
  }
  t(0, 'ENDTAB');
  // 화살촉 블록 이름
  t(0, 'TABLE');
  t(2, 'BLOCK_RECORD');
  t(70, blkH.size);
  for (const { h, name } of blkH.values()) {
    t(0, 'BLOCK_RECORD');
    t(5, h);
    t(100, 'AcDbSymbolTableRecord');
    t(100, 'AcDbBlockTableRecord');
    t(2, name);
  }
  t(0, 'ENDTAB');
  // 치수 스타일
  t(0, 'TABLE');
  t(2, 'DIMSTYLE');
  t(70, styles.length);
  t(100, 'AcDbSymbolTable');
  t(100, 'AcDbDimStyleTable');
  t(71, 0);
  for (const s of styles) {
    t(0, 'DIMSTYLE');
    t(105, nh());
    t(100, 'AcDbSymbolTableRecord');
    t(100, 'AcDbDimStyleTableRecord');
    t(2, s.name);
    t(70, s.flags & ~(16 | 32 | 64));
    const tags: [number, string | number][] = [];
    for (const [name, value] of Object.entries(s.vars)) {
      const code = CODE_OF.get(name);
      if (code === undefined) continue;
      const k = kindOf(code);
      if (k === 'handle') {
        const nm = String(value ?? '');
        if (!nm) continue;
        const h = code === 340 ? textH.get(tableKey(nm))?.h : code >= 345 ? ltH.get(tableKey(nm))?.h : blkH.get(tableKey(nm))?.h;
        if (h) tags.push([code, h]);
        continue;
      }
      if (k === 'str') tags.push([code, String(value ?? '')]);
      else if (typeof value === 'number' && Number.isFinite(value)) tags.push([code, value]);
      else if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) tags.push([code, Number(value)]);
    }
    // 문자 스타일이 기본값이라 변수에 없으면 Standard를 가리킨다
    if (!tags.some(([c]) => c === 340)) {
      const st = textH.get('STANDARD');
      if (st) tags.push([340, st.h]);
    }
    tags.sort((a, b) => a[0] - b[0]);
    for (const [c, v] of tags) t(c, v);
  }
  t(0, 'ENDTAB');
  t(0, 'ENDSEC');
  t(0, 'EOF');
  return { text: `${out.join('\r\n')}\r\n`, styles: styles.map((s) => s.name) };
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

interface Rec {
  type: string;
  tags: [number, string][];
}

export interface DimFileContent {
  styles: DimStyle[];
  /** 대문자 이름 → 정의(이름만 쓴 파일이면 font가 빈 글) */
  textStyles: Map<string, TextStyle & { nameOnly?: boolean }>;
  linetypes: Map<string, Linetype>;
  errors: string[];
}

/** .dim(또는 DXF) 글에서 치수 스타일과 그것이 쓰는 문자 스타일·선종류를 읽는다 */
export function parseDimFile(text: string): DimFileContent {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const recs: Rec[] = [];
  let section = '';
  let cur: Rec | null = null;
  const errors: string[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    if (!Number.isFinite(code)) {
      errors.push(`${i + 1}번째 줄: 그룹 코드가 아닙니다.`);
      break;
    }
    const v = lines[i + 1]!.replace(/\s+$/, '');
    if (code === 0) {
      if (cur) recs.push(cur);
      cur = null;
      const val = v.trim();
      if (val === 'SECTION') {
        section = '?';
        continue;
      }
      if (val === 'ENDSEC') {
        section = '';
        continue;
      }
      if (val === 'EOF') break;
      if (section === 'TABLES' && ['LTYPE', 'STYLE', 'BLOCK_RECORD', 'DIMSTYLE'].includes(val)) cur = { type: val, tags: [] };
      continue;
    }
    if (code === 2 && section === '?') {
      section = v.trim().toUpperCase();
      continue;
    }
    if (cur) cur.tags.push([code, v]);
  }
  if (cur) recs.push(cur);
  const first = (r: Rec, code: number) => r.tags.find(([c]) => c === code)?.[1];
  const num = (r: Rec, code: number, d = 0) => {
    const s = first(r, code);
    const n = s === undefined ? NaN : Number(s.trim());
    return Number.isFinite(n) ? n : d;
  };
  const hname = new Map<string, string>();
  const textStyles = new Map<string, TextStyle & { nameOnly?: boolean }>();
  const linetypes = new Map<string, Linetype>();
  for (const r of recs) {
    if (r.type === 'DIMSTYLE') continue;
    const name = (first(r, 2) ?? '').trim();
    const h = (first(r, 5) ?? '').trim().toUpperCase();
    if (h && name) hname.set(h, name);
    if (!name) continue;
    if (r.type === 'STYLE') {
      const font = first(r, 3);
      const fam = r.tags.findIndex(([c, v]) => c === 1001 && v.trim() === 'ACAD');
      const s: TextStyle & { nameOnly?: boolean } = {
        name,
        handle: '',
        flags: num(r, 70) & ~(16 | 32 | 64),
        height: num(r, 40),
        widthFactor: num(r, 41, 1) || 1,
        oblique: num(r, 50) * DEG,
        generation: num(r, 71),
        lastHeight: num(r, 42, 2.5),
        font: (font ?? '').trim(),
        bigFont: (first(r, 4) ?? '').trim(),
      };
      if (fam >= 0) {
        const f = r.tags.slice(fam + 1).find(([c]) => c === 1000)?.[1];
        const fl = r.tags.slice(fam + 1).find(([c]) => c === 1071)?.[1];
        if (f) s.fontFamily = f.trim();
        if (fl !== undefined) s.fontFlags = Number(fl) || 0;
      }
      if (font === undefined && fam < 0) s.nameOnly = true;
      textStyles.set(tableKey(name), s);
    } else if (r.type === 'LTYPE') {
      const elements = r.tags.filter(([c]) => c === 49).map(([, v]) => ({ length: Number(v) || 0, flags: 0, scale: 1, rotation: 0, offset: { x: 0, y: 0 } }));
      linetypes.set(tableKey(name), { name, handle: '', flags: 0, description: (first(r, 3) ?? '').trim(), patternLength: num(r, 40) || elements.reduce((a, e) => a + Math.abs(e.length), 0), elements });
    }
  }
  const styles: DimStyle[] = [];
  for (const r of recs) {
    if (r.type !== 'DIMSTYLE') continue;
    const name = (first(r, 2) ?? '').trim();
    if (!name) continue;
    const vars: Record<string, number | string> = {};
    for (const [code, v] of r.tags) {
      if (code === 2 || code === 70 || code === 105 || code === 100) continue;
      const vn = DIM_VAR_CODES[code];
      if (!vn) continue;
      if (code >= 340 && code <= 347) {
        const n = hname.get(v.trim().toUpperCase());
        if (n !== undefined) vars[vn] = n;
        else errors.push(`치수 스타일 ${name}: ${vn}이(가) 가리키는 레코드(${v.trim()})가 파일에 없습니다.`);
      } else if (code >= 3 && code <= 7) {
        if (vars[vn] === undefined) vars[vn] = v;
      } else {
        const n = Number(v.trim());
        if (Number.isFinite(n)) vars[vn] = n;
      }
    }
    styles.push({ name, handle: '', flags: num(r, 70) & ~(16 | 32 | 64), vars });
  }
  if (!styles.length && !errors.length) errors.push('파일에 치수 스타일이 없습니다.');
  return { styles, textStyles, linetypes, errors };
}

export interface DimImportResult {
  ops: EditOp[];
  added: string[];
  replaced: string[];
  skipped: string[];
  /** 함께 만든 문자 스타일·선종류 */
  created: string[];
  notes: string[];
}

/** 읽은 치수 스타일을 도면에 넣는 작업. overwrite면 같은 이름을 바꾸고(핸들은 지킨다), 아니면 건너뛴다 */
export function importDimStylesOps(doc: CadDocument, content: DimFileContent, overwrite: boolean, newHandle: () => string): DimImportResult {
  const res: DimImportResult = { ops: [], added: [], replaced: [], skipped: [], created: [], notes: [] };
  const madeStyle = new Set<string>();
  const madeLt = new Set<string>();
  const textStyle = (n: string, owner: string): string => {
    const k = tableKey(n);
    const have = doc.textStyles.get(k);
    if (have || madeStyle.has(k)) return have?.name ?? n;
    const def = content.textStyles.get(k);
    if (!def || def.nameOnly) {
      res.notes.push(`치수 스타일 ${owner}: 문자 스타일 ${n}이(가) 이 도면에 없어 Standard를 씁니다.`);
      return doc.textStyles.get('STANDARD')?.name ?? 'Standard';
    }
    const after: TextStyle = { ...def, handle: newHandle() };
    delete (after as { nameOnly?: boolean }).nameOnly;
    res.ops.push({ kind: 'textStyle', key: k, before: null, after });
    madeStyle.add(k);
    res.created.push(`문자 스타일 ${def.name}`);
    return def.name;
  };
  const linetype = (n: string, owner: string): string => {
    const k = tableKey(n);
    if (isFixedName('linetype', n)) return n;
    const have = doc.linetypes.get(k);
    if (have || madeLt.has(k)) return have?.name ?? n;
    const def = content.linetypes.get(k);
    if (!def || !def.elements.length) {
      res.notes.push(`치수 스타일 ${owner}: 선종류 ${n}이(가) 이 도면에 없어 ByBlock을 씁니다.`);
      return 'ByBlock';
    }
    res.ops.push({ kind: 'linetype', key: k, before: null, after: { ...def, handle: newHandle() } });
    madeLt.add(k);
    res.created.push(`선종류 ${def.name}`);
    return def.name;
  };
  const madeBlk = new Set<string>();
  const arrow = (n: string, owner: string): string => {
    const k = tableKey(n);
    const have = doc.blocks.get(k);
    if (have || madeBlk.has(k)) return have?.name ?? n;
    if (!n.startsWith('_')) {
      res.notes.push(`치수 스타일 ${owner}: 화살촉 블록 ${n}이(가) 이 도면에 없어 기본 화살촉(닫고 채움)을 씁니다.`);
      return '';
    }
    // AutoCAD 기본 화살촉 블록은 만들어 둔다(저장할 때 치수 스타일이 가리킬 수 있게)
    const rec: BlockRecord = { name: n, handle: newHandle(), flags: 0, insertUnits: 0, explodable: true, scalable: true };
    const ents = builtinArrowBlock(n).map((e) => ({ ...e, handle: newHandle(), owner: rec.handle }));
    const def: BlockDef = { name: n, handle: newHandle(), recordHandle: rec.handle, basePoint: { x: 0, y: 0, z: 0 }, flags: 0, entities: ents, endHandle: newHandle() };
    res.ops.push({ kind: 'blockRecord', key: k, before: null, after: rec }, { kind: 'blockDef', key: k, before: null, after: def });
    madeBlk.add(k);
    res.created.push(`화살촉 블록 ${n}`);
    return n;
  };
  for (const s of content.styles) {
    const k = tableKey(s.name);
    const old = doc.dimStyles.get(k);
    if (old && !overwrite) {
      res.skipped.push(old.name);
      continue;
    }
    const vars = { ...s.vars };
    if (typeof vars.DIMTXSTY === 'string' && vars.DIMTXSTY) vars.DIMTXSTY = textStyle(vars.DIMTXSTY, s.name);
    for (const n of LT_VARS) if (typeof vars[n] === 'string' && vars[n]) vars[n] = linetype(vars[n] as string, s.name);
    for (const n of BLOCK_VARS) if (typeof vars[n] === 'string' && vars[n]) vars[n] = arrow(vars[n] as string, s.name);
    const after: DimStyle = old ? { ...old, vars } : { name: s.name, handle: newHandle(), flags: s.flags, vars };
    res.ops.push({ kind: 'dimStyle', key: k, before: old ?? null, after });
    (old ? res.replaced : res.added).push(after.name);
  }
  return res;
}
