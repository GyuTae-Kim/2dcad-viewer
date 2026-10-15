/**
 * CAD 표준(STANDARDS·CHECKSTANDARDS)의 순수 함수.
 *
 * - 표준 파일(DWS·DWG·DXF)의 도면층·선종류·문자 스타일·치수 스타일과 이 도면의 같은 종류를 비교한다.
 *   - 이름이 표준에 없으면 "비표준 이름" 문제(대체할 표준 객체 목록, 특성이 같은 것을 권장)
 *   - 이름은 같은데 특성이 다르면 "비표준 특성" 문제(표준 값으로 고친다)
 * - 수정: 특성은 표준 값으로 바꾸고, 이름은 고른 표준 객체로 대체한다(객체·스타일·현재 값이 따라가고 비표준 기록은 지운다).
 * - 표준 파일 연결: AutoCAD 형식 — 루트 사전 항목 `AcStStandard`(DICTIONARY) → 항목 "0"·"1"…(연결 순서) → XRECORD(1 표준 파일 경로).
 *   AutoCAD가 저장한 실물(공개 연습 도면의 DWG·DWS)과 Autodesk ADN 블로그(표준 파일을 도면에 잇는 법)로 확인했다.
 *   예전 이 앱 기록(루트 사전 OPENCAD_STANDARDS, XRECORD: 90 형식, 1 파일 이름…)도 읽고, 연결을 쓸 때 AcStStandard로 옮긴다.
 */
import type { CadColor, CadDocument, DictionaryObject, DimStyle, Entity, Layer, Linetype, MLeaderStyleObject, RawTag, TextStyle, XRecordObject } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import { DIM_VAR_DEFAULTS } from '../../core/dimvars';
import type { EditOp } from '../session';
import { DefinitionCopier, rootDictionary } from './clone';

export type StdKind = 'dimStyle' | 'layer' | 'linetype' | 'textStyle';

export const STD_KINDS: readonly StdKind[] = ['dimStyle', 'layer', 'linetype', 'textStyle'];

export const STD_KIND_LABEL: Record<StdKind, string> = { dimStyle: '치수 스타일', layer: '도면층', linetype: '선종류', textStyle: '문자 스타일' };

/** 읽어 둔 표준 파일 */
export interface StdSource {
  name: string;
  doc: CadDocument;
}

export interface PropDiff {
  label: string;
  current: string;
  standard: string;
}

export interface StdCandidate {
  /** 표준 파일 번호(sources 순서) */
  source: number;
  name: string;
}

export interface StdProblem {
  /** `${종류}:${대문자 이름}` */
  id: string;
  kind: StdKind;
  name: string;
  type: 'name' | 'props';
  diffs: PropDiff[];
  /** 대체·수정에 쓸 표준 객체(특성 문제는 같은 이름의 표준 객체 하나) */
  candidates: StdCandidate[];
  /** 권장하는 후보 번호(없으면 -1) */
  recommended: number;
}

// ---------------------------------------------------------------------------
// 값 글
// ---------------------------------------------------------------------------

const ACI_NAMES: Record<number, string> = { 1: '빨간색', 2: '노란색', 3: '초록색', 4: '하늘색', 5: '파란색', 6: '선홍색', 7: '흰색' };

export function colorLabel(c: CadColor): string {
  if (c.rgb !== undefined && c.aci !== 0 && c.aci !== 256) return `${(c.rgb >> 16) & 255},${(c.rgb >> 8) & 255},${c.rgb & 255}`;
  if (c.aci === 256) return 'ByLayer';
  if (c.aci === 0) return 'ByBlock';
  return ACI_NAMES[c.aci] ?? `색상 ${c.aci}`;
}

export function lineweightLabel(lw: number): string {
  if (lw === -1) return 'ByLayer';
  if (lw === -2) return 'ByBlock';
  if (lw < 0) return '기본값';
  return `${(lw / 100).toFixed(2)} mm`;
}

/** 도면층 투명도(0..255 불투명도) → 투명도 % */
export function transparencyLabel(alpha: number): string {
  return String(Math.round((1 - (alpha ?? 255) / 255) * 100));
}

const fmt = (v: number | string | undefined) => (v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : v);

// ---------------------------------------------------------------------------
// 비교
// ---------------------------------------------------------------------------

function sameColor(a: CadColor, b: CadColor): boolean {
  if (a.rgb !== undefined || b.rgb !== undefined) return a.rgb === b.rgb && (a.rgb !== undefined || a.aci === b.aci);
  return a.aci === b.aci;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export function layerDiffs(cur: Layer, std: Layer): PropDiff[] {
  const out: PropDiff[] = [];
  if (!sameColor(cur.color, std.color)) out.push({ label: '색상', current: colorLabel(cur.color), standard: colorLabel(std.color) });
  if (tableKey(cur.linetype || 'Continuous') !== tableKey(std.linetype || 'Continuous')) out.push({ label: '선종류', current: cur.linetype, standard: std.linetype });
  if (cur.lineweight !== std.lineweight) out.push({ label: '선가중치', current: lineweightLabel(cur.lineweight), standard: lineweightLabel(std.lineweight) });
  if ((cur.transparency ?? 255) !== (std.transparency ?? 255)) out.push({ label: '투명도', current: transparencyLabel(cur.transparency), standard: transparencyLabel(std.transparency) });
  if (cur.plot !== std.plot) out.push({ label: '플롯', current: cur.plot ? '예' : '아니오', standard: std.plot ? '예' : '아니오' });
  return out;
}

const pattern = (l: Linetype) => l.elements.map((e) => fmt(e.length) + (e.flags & 2 ? `[${e.text ?? ''}]` : e.flags & 4 ? `[#${e.shapeNumber ?? 0}]` : '')).join(',');

export function linetypeDiffs(cur: Linetype, std: Linetype): PropDiff[] {
  const out: PropDiff[] = [];
  if ((cur.description ?? '') !== (std.description ?? '')) out.push({ label: '설명', current: cur.description ?? '', standard: std.description ?? '' });
  if (pattern(cur) !== pattern(std) || !near(cur.patternLength, std.patternLength)) out.push({ label: '무늬', current: pattern(cur) || '실선', standard: pattern(std) || '실선' });
  return out;
}

export function textStyleDiffs(cur: TextStyle, std: TextStyle): PropDiff[] {
  const out: PropDiff[] = [];
  const s = (v: string | undefined) => (v ?? '').trim();
  if (s(cur.font).toUpperCase() !== s(std.font).toUpperCase()) out.push({ label: '글꼴 파일', current: s(cur.font), standard: s(std.font) });
  if (s(cur.bigFont).toUpperCase() !== s(std.bigFont).toUpperCase()) out.push({ label: '큰 글꼴', current: s(cur.bigFont), standard: s(std.bigFont) });
  if (s(cur.fontFamily).toUpperCase() !== s(std.fontFamily).toUpperCase()) out.push({ label: '글꼴 이름', current: s(cur.fontFamily), standard: s(std.fontFamily) });
  if (!near(cur.height, std.height)) out.push({ label: '높이', current: fmt(cur.height), standard: fmt(std.height) });
  if (!near(cur.widthFactor, std.widthFactor)) out.push({ label: '폭 비율', current: fmt(cur.widthFactor), standard: fmt(std.widthFactor) });
  if (!near(cur.oblique, std.oblique)) out.push({ label: '기울기 각도', current: fmt(cur.oblique), standard: fmt(std.oblique) });
  if ((cur.generation & 6) !== (std.generation & 6)) out.push({ label: '반전', current: String(cur.generation & 6), standard: String(std.generation & 6) });
  return out;
}

function dimValue(s: DimStyle, k: string): number | string | undefined {
  return s.vars[k] ?? DIM_VAR_DEFAULTS[k];
}

export function dimStyleDiffs(cur: DimStyle, std: DimStyle): PropDiff[] {
  const out: PropDiff[] = [];
  const keys = new Set([...Object.keys(cur.vars), ...Object.keys(std.vars)]);
  for (const k of [...keys].sort()) {
    const a = dimValue(cur, k);
    const b = dimValue(std, k);
    if (a === undefined || b === undefined) {
      if (a === b) continue;
      out.push({ label: k, current: fmt(a), standard: fmt(b) });
      continue;
    }
    const same = typeof a === 'number' && typeof b === 'number' ? near(a, b) : String(a).toUpperCase() === String(b).toUpperCase();
    if (!same) out.push({ label: k, current: fmt(a), standard: fmt(b) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 기록 목록
// ---------------------------------------------------------------------------

export type AnyRecord = Layer | Linetype | TextStyle | DimStyle;

function recordsOf(doc: CadDocument, kind: StdKind): AnyRecord[] {
  switch (kind) {
    case 'layer':
      return [...doc.layers.values()];
    case 'linetype':
      return [...doc.linetypes.values()];
    case 'textStyle':
      return [...doc.textStyles.values()].filter((s) => s.name && !(s.flags & 1));
    case 'dimStyle':
      return [...doc.dimStyles.values()];
  }
}

/** 그 이름의 기록 */
export function recordOf(doc: CadDocument, kind: StdKind, name: string): AnyRecord | undefined {
  const k = tableKey(name);
  switch (kind) {
    case 'layer':
      return doc.layers.get(k);
    case 'linetype':
      return doc.linetypes.get(k);
    case 'textStyle':
      return doc.textStyles.get(k);
    case 'dimStyle':
      return doc.dimStyles.get(k);
  }
}

/** 두 기록의 특성 차이 */
export function diffsOf(kind: StdKind, cur: AnyRecord, std: AnyRecord): PropDiff[] {
  switch (kind) {
    case 'layer':
      return layerDiffs(cur as Layer, std as Layer);
    case 'linetype':
      return linetypeDiffs(cur as Linetype, std as Linetype);
    case 'textStyle':
      return textStyleDiffs(cur as TextStyle, std as TextStyle);
    case 'dimStyle':
      return dimStyleDiffs(cur as DimStyle, std as DimStyle);
  }
}

/** 검사하지 않는 기록(외부 참조 종속, ByLayer·ByBlock) */
function exempt(kind: StdKind, name: string): boolean {
  const k = tableKey(name);
  if (k.includes('|')) return true;
  return kind === 'linetype' && (k === 'BYLAYER' || k === 'BYBLOCK');
}

/** 표준에 없어도 문제로 삼지 않는 이름(도면이 늘 갖는 기록) */
function exemptName(kind: StdKind, name: string): boolean {
  const k = tableKey(name);
  if (kind === 'layer') return k === '0' || k === 'DEFPOINTS';
  if (kind === 'linetype') return k === 'CONTINUOUS';
  return false;
}

/** 표준 파일들에서 그 이름의 첫 기록 */
export function findStandard(sources: readonly StdSource[], kind: StdKind, name: string): { source: number; record: AnyRecord } | null {
  for (let i = 0; i < sources.length; i++) {
    const r = recordOf(sources[i]!.doc, kind, name);
    if (r) return { source: i, record: r };
  }
  return null;
}

/** 표준 검사: 문제 목록(종류 → 이름 순). ignored: 무시한 문제 id */
export function checkStandards(doc: CadDocument, sources: readonly StdSource[], kinds: readonly StdKind[] = STD_KINDS, ignored: ReadonlySet<string> = new Set()): StdProblem[] {
  const out: StdProblem[] = [];
  if (!sources.length) return out;
  for (const kind of kinds) {
    // 표준 객체 후보(앞 파일이 이긴다)
    const all: StdCandidate[] = [];
    const seen = new Set<string>();
    sources.forEach((s, i) => {
      for (const r of recordsOf(s.doc, kind)) {
        if (exempt(kind, r.name) || seen.has(tableKey(r.name))) continue;
        seen.add(tableKey(r.name));
        all.push({ source: i, name: r.name });
      }
    });
    all.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const list = recordsOf(doc, kind).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    for (const cur of list) {
      if (exempt(kind, cur.name)) continue;
      const id = `${kind}:${tableKey(cur.name)}`;
      if (ignored.has(id)) continue;
      const std = findStandard(sources, kind, cur.name);
      if (std) {
        const diffs = diffsOf(kind, cur, std.record);
        if (diffs.length) out.push({ id, kind, name: cur.name, type: 'props', diffs, candidates: [{ source: std.source, name: std.record.name }], recommended: 0 });
        continue;
      }
      if (exemptName(kind, cur.name)) continue;
      // 특성이 같은 표준 객체를 권장(하나뿐이면 그것)
      let rec = all.findIndex((c) => diffsOf(kind, cur, recordOf(sources[c.source]!.doc, kind, c.name)!).length === 0);
      if (rec < 0 && all.length === 1) rec = 0;
      out.push({ id, kind, name: cur.name, type: 'name', diffs: [], candidates: all, recommended: rec });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 수정
// ---------------------------------------------------------------------------

/** 비표준 특성을 표준 값으로 바꾸는 작업(필요한 선종류·문자 스타일·화살표 블록을 표준 파일에서 함께 가져온다) */
export function fixPropsOps(doc: CadDocument, p: StdProblem, sources: readonly StdSource[], newHandle: () => string): EditOp[] {
  const std = findStandard(sources, p.kind, p.name);
  const cur = recordOf(doc, p.kind, p.name);
  if (!std || !cur) return [];
  const cp = new DefinitionCopier(sources[std.source]!.doc, doc, newHandle);
  const key = tableKey(cur.name);
  let op: EditOp;
  switch (p.kind) {
    case 'layer': {
      const s = std.record as Layer;
      const before = cur as Layer;
      const after: Layer = { ...structuredClone(before), color: { ...s.color }, linetype: cp.linetype(s.linetype) ?? 'Continuous', lineweight: s.lineweight, transparency: s.transparency, plot: s.plot };
      op = { kind: 'layer', key, before, after };
      break;
    }
    case 'linetype': {
      const s = std.record as Linetype;
      const before = cur as Linetype;
      const elements = structuredClone(s.elements);
      for (const el of elements) {
        if (!el.styleHandle) continue;
        const h = cp.textStyleByHandle(el.styleHandle);
        if (h) el.styleHandle = h;
        else delete el.styleHandle;
      }
      op = { kind: 'linetype', key, before, after: { ...structuredClone(before), description: s.description, patternLength: s.patternLength, elements } };
      break;
    }
    case 'textStyle': {
      const s = std.record as TextStyle;
      const before = cur as TextStyle;
      const after: TextStyle = { ...structuredClone(before), font: s.font, bigFont: s.bigFont, height: s.height, widthFactor: s.widthFactor, oblique: s.oblique, generation: s.generation };
      if (s.fontFamily !== undefined) after.fontFamily = s.fontFamily;
      else delete after.fontFamily;
      if (s.fontFlags !== undefined) after.fontFlags = s.fontFlags;
      else delete after.fontFlags;
      op = { kind: 'textStyle', key, before, after };
      break;
    }
    case 'dimStyle': {
      const s = std.record as DimStyle;
      const before = cur as DimStyle;
      op = { kind: 'dimStyle', key, before, after: { ...structuredClone(before), vars: dimVarsFor(cp, s.vars) } };
      break;
    }
  }
  return [...cp.finish(), op];
}

/** 치수 변수의 이름 참조(문자 스타일·화살표 블록·선종류)를 이 도면에서 쓸 이름으로 */
function dimVarsFor(cp: DefinitionCopier, vars: Record<string, number | string>): Record<string, number | string> {
  const v = structuredClone(vars);
  if (typeof v.DIMTXSTY === 'string' && v.DIMTXSTY) v.DIMTXSTY = cp.textStyle(v.DIMTXSTY);
  for (const k of ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK']) {
    const b = v[k];
    if (typeof b === 'string' && b && cp.src.blocks.has(tableKey(b))) v[k] = cp.block(b) ?? b;
  }
  for (const k of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2']) {
    const l = v[k];
    if (typeof l === 'string' && l) v[k] = cp.linetype(l) ?? l;
  }
  return v;
}

export interface ReplacePlan {
  /** 표준 객체 복사·표 기록·스타일·현재 값 변경(객체 변경보다 먼저) */
  pre: EditOp[];
  /** 바뀌는 객체(같은 핸들) */
  entities: { block: string; before: Entity; after: Entity }[];
  /** 비표준 기록 지우기(객체 변경 뒤) */
  post: EditOp[];
  /** 이 도면에서 쓰는 대체 이름 */
  target: string;
}

const PROTECTED: Record<StdKind, Set<string>> = {
  layer: new Set(['0', 'DEFPOINTS']),
  linetype: new Set(['BYLAYER', 'BYBLOCK', 'CONTINUOUS']),
  textStyle: new Set(['STANDARD']),
  dimStyle: new Set(['STANDARD']),
};

/** 비표준 이름의 기록을 고른 표준 객체로 대체하는 계획 */
export function replacePlan(doc: CadDocument, p: StdProblem, c: StdCandidate, sources: readonly StdSource[], newHandle: () => string): ReplacePlan | null {
  const src = sources[c.source];
  const old = recordOf(doc, p.kind, p.name);
  if (!src || !old) return null;
  const cp = new DefinitionCopier(src.doc, doc, newHandle);
  const oldKey = tableKey(old.name);
  let target: string | null;
  switch (p.kind) {
    case 'layer':
      target = cp.layer(c.name);
      break;
    case 'linetype':
      target = cp.linetype(c.name) ?? null;
      break;
    case 'textStyle':
      target = cp.textStyle(c.name);
      break;
    case 'dimStyle':
      target = cp.dimStyle(c.name);
      break;
  }
  if (!target) return null;
  const pre: EditOp[] = cp.finish();
  const post: EditOp[] = [];
  const entities: ReplacePlan['entities'] = [];
  const tKey = tableKey(target);
  const same = (n: string | undefined) => !!n && tableKey(n) === oldKey;
  // 이 도면의 대체 기록 핸들(복사했으면 새 핸들)
  const oldHandle = old.handle ? normalizeHandle(old.handle) : '';
  const newRecHandle = cp.recordHandle(p.kind, target);
  // 객체
  for (const [bk, b] of doc.blocks) {
    if (b.flags & 4) continue;
    for (const e of b.entities) {
      const after = retarget(e, p.kind, same, target, oldHandle, newRecHandle);
      if (after) entities.push({ block: bk, before: e, after });
    }
  }
  // 표 기록·스타일이 쓰는 참조
  if (p.kind === 'linetype') {
    for (const [k, l] of doc.layers) if (same(l.linetype)) pre.push({ kind: 'layer', key: k, before: l, after: { ...structuredClone(l), linetype: target } });
    for (const [k, d] of doc.dimStyles) {
      const v = d.vars;
      if (!['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2'].some((x) => typeof v[x] === 'string' && same(v[x] as string))) continue;
      const nv = structuredClone(v);
      for (const x of ['DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2']) if (typeof nv[x] === 'string' && same(nv[x] as string)) nv[x] = target;
      pre.push({ kind: 'dimStyle', key: k, before: d, after: { ...structuredClone(d), vars: nv } });
    }
  } else if (p.kind === 'textStyle') {
    for (const [k, d] of doc.dimStyles) if (typeof d.vars.DIMTXSTY === 'string' && same(d.vars.DIMTXSTY)) pre.push({ kind: 'dimStyle', key: k, before: d, after: { ...structuredClone(d), vars: { ...structuredClone(d.vars), DIMTXSTY: target } } });
    if (oldHandle && newRecHandle)
      for (const o of doc.objects.values()) {
        if (o.type !== 'MLEADERSTYLE') continue;
        const m = o as MLeaderStyleObject;
        if (!m.textStyleHandle || normalizeHandle(m.textStyleHandle) !== oldHandle) continue;
        const after: MLeaderStyleObject = { ...structuredClone(m), textStyleHandle: newRecHandle };
        if (after.raw) after.raw = after.raw.map((t: RawTag) => (t.code === 342 && typeof t.value === 'string' && normalizeHandle(t.value) === oldHandle ? { ...t, value: newRecHandle } : t));
        delete after.dwgRaw;
        pre.push({ kind: 'object', key: m.handle, before: m, after });
      }
  }
  // 현재 값
  const hv: Record<StdKind, string> = { layer: '$CLAYER', linetype: '$CELTYPE', textStyle: '$TEXTSTYLE', dimStyle: '$DIMSTYLE' };
  const cur = doc.header.get(hv[p.kind]);
  if (typeof cur === 'string' && same(cur)) pre.push({ kind: 'header', name: hv[p.kind], before: cur, after: target });
  // 비표준 기록 지우기
  if (tKey !== oldKey && !PROTECTED[p.kind].has(oldKey)) {
    switch (p.kind) {
      case 'layer':
        post.push({ kind: 'layer', key: oldKey, before: old as Layer, after: null });
        break;
      case 'linetype':
        post.push({ kind: 'linetype', key: oldKey, before: old as Linetype, after: null });
        break;
      case 'textStyle':
        post.push({ kind: 'textStyle', key: oldKey, before: old as TextStyle, after: null });
        break;
      case 'dimStyle':
        post.push({ kind: 'dimStyle', key: oldKey, before: old as DimStyle, after: null });
        break;
    }
  }
  return { pre, entities, post, target };
}

/** 객체가 그 기록을 쓰면 대체한 사본(아니면 null) */
function retarget(e: Entity, kind: StdKind, same: (n: string | undefined) => boolean, target: string, oldHandle: string, newHandle: string | undefined): Entity | null {
  let out: Entity | null = null;
  const get = (): Entity => (out ??= structuredClone(e) as Entity);
  const fix = (x: Entity) => {
    switch (kind) {
      case 'layer':
        if (same(x.layer)) x.layer = target;
        break;
      case 'linetype':
        if (same(x.linetype)) x.linetype = target;
        break;
      case 'textStyle':
        if ((x.type === 'TEXT' || x.type === 'MTEXT' || x.type === 'ATTDEF' || x.type === 'ATTRIB') && same(x.style)) x.style = target;
        if ((x.type === 'ATTDEF' || x.type === 'ATTRIB') && 'mtext' in x && x.mtext && same(x.mtext.style)) x.mtext.style = target;
        if (x.type === 'MULTILEADER' && newHandle && oldHandle) {
          if (x.textStyleHandle && normalizeHandle(x.textStyleHandle) === oldHandle) x.textStyleHandle = newHandle;
          if (x.context.text?.styleHandle && normalizeHandle(x.context.text.styleHandle) === oldHandle) x.context.text.styleHandle = newHandle;
        }
        break;
      case 'dimStyle':
        if ((x.type === 'DIMENSION' || x.type === 'LEADER' || x.type === 'TOLERANCE') && same(x.dimStyle)) x.dimStyle = target;
        break;
    }
  };
  const uses = (x: Entity): boolean => {
    switch (kind) {
      case 'layer':
        return same(x.layer) || (x.type === 'VIEWPORT' && x.frozenLayers.some((n) => same(n)));
      case 'linetype':
        return same(x.linetype);
      case 'textStyle':
        return (
          ((x.type === 'TEXT' || x.type === 'MTEXT' || x.type === 'ATTDEF' || x.type === 'ATTRIB') && (same(x.style) || ('mtext' in x && !!x.mtext && same(x.mtext.style)))) ||
          (x.type === 'MULTILEADER' && !!oldHandle && [x.textStyleHandle, x.context.text?.styleHandle].some((h) => !!h && normalizeHandle(h) === oldHandle))
        );
      case 'dimStyle':
        return (x.type === 'DIMENSION' || x.type === 'LEADER' || x.type === 'TOLERANCE') && same(x.dimStyle);
    }
  };
  if (uses(e)) {
    const c = get();
    fix(c);
    if (kind === 'layer' && c.type === 'VIEWPORT') {
      const seen = new Set<string>();
      c.frozenLayers = c.frozenLayers
        .map((n) => (same(n) ? target : n))
        .filter((n) => {
          if (seen.has(tableKey(n))) return false;
          seen.add(tableKey(n));
          return true;
        });
    }
  }
  if (e.type === 'INSERT' && e.attribs.some((a) => uses(a))) {
    const c = get() as typeof e;
    for (const a of c.attribs) fix(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 표준 파일 연결(AutoCAD AcStStandard, 예전 이 앱 기록 OPENCAD_STANDARDS도 읽는다)
// ---------------------------------------------------------------------------

/** AutoCAD의 표준 연결 사전(루트 사전 항목) */
export const ACST_STANDARD_KEY = 'AcStStandard';
/** 예전 이 앱 기록(루트 사전 항목, XRECORD) */
export const STANDARDS_KEY = 'OPENCAD_STANDARDS';

function rootEntry(doc: CadDocument, name: string): [string, string] | null {
  const root = rootDictionary(doc);
  if (!root) return null;
  const k = name.toUpperCase();
  for (const [n, h] of root.entries) if (n.toUpperCase() === k) return [n, normalizeHandle(h)];
  return null;
}

function legacyLink(doc: CadDocument): XRecordObject | null {
  const e = rootEntry(doc, STANDARDS_KEY);
  const o = e ? doc.objects.get(e[1]) : undefined;
  return o?.type === 'XRECORD' ? (o as XRecordObject) : null;
}

function acstDict(doc: CadDocument): DictionaryObject | null {
  const e = rootEntry(doc, ACST_STANDARD_KEY);
  const o = e ? doc.objects.get(e[1]) : undefined;
  return o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') ? (o as DictionaryObject) : null;
}

const firstString = (x: XRecordObject | null | undefined): string => {
  const t = x?.data.find((d) => d.code === 1);
  return t ? String(t.value) : '';
};

/** AcStStandard 항목(번호 순): [항목 이름, XRECORD] */
function acstEntries(doc: CadDocument, d: DictionaryObject): [string, XRecordObject][] {
  const out: [string, XRecordObject][] = [];
  for (const [k, h] of d.entries) {
    const o = doc.objects.get(normalizeHandle(h));
    if (o?.type === 'XRECORD') out.push([k, o as XRecordObject]);
  }
  const n = (k: string) => (/^\d+$/.test(k) ? Number(k) : Number.MAX_SAFE_INTEGER);
  return out.sort((a, b) => n(a[0]) - n(b[0]));
}

/** 경로의 파일 이름(\·/ 뒤) */
export function stdFileBase(path: string): string {
  return path.replace(/^.*[\\/]/, '');
}

/** 같은 표준 파일인지(경로를 빼고 대소문자 무시 — AutoCAD는 전체 경로를 적는다) */
export function sameStdFile(a: string, b: string): boolean {
  return stdFileBase(a).toLowerCase() === stdFileBase(b).toLowerCase();
}

/** 이 도면에 연결된 표준 파일(AutoCAD가 적은 경로 그대로, 순서대로). 예전 이 앱 기록의 이름도 뒤에 붙인다 */
export function readStandardsLink(doc: CadDocument): string[] {
  const out: string[] = [];
  const d = acstDict(doc);
  if (d) for (const [, x] of acstEntries(doc, d)) {
    const f = firstString(x);
    if (f && !out.some((o) => sameStdFile(o, f))) out.push(f);
  }
  const old = legacyLink(doc);
  if (old) for (const t of old.data) if (t.code === 1 && typeof t.value === 'string' && t.value && !out.some((o) => sameStdFile(o, String(t.value)))) out.push(String(t.value));
  return out;
}

/**
 * 표준 파일 연결을 쓰는 작업(바뀐 것이 없으면 빈 배열). 루트 사전이 없으면 null.
 * AcStStandard 사전(없으면 만든다)의 "0"…"n-1" 항목을 files 순서로 맞춘다 — 같은 파일을 가리키는 항목은 원래 레코드를 그대로 쓴다.
 * 예전 이 앱 기록(OPENCAD_STANDARDS)은 지운다.
 */
export function standardsLinkOps(doc: CadDocument, files: readonly string[], newHandle: () => string): EditOp[] | null {
  const root = rootDictionary(doc);
  if (!root) return null;
  const old = legacyLink(doc);
  const d0 = acstDict(doc);
  const cur = d0 ? acstEntries(doc, d0) : [];
  const same = !old && cur.length === files.length && cur.every(([k, x], i) => k === String(i) && firstString(x) === files[i]);
  if (same) return [];
  const ops: EditOp[] = [];
  let rootAfter: DictionaryObject | null = null;
  const rootMut = () => (rootAfter ??= { ...root, entries: new Map(root.entries) });
  let d: DictionaryObject;
  if (d0) {
    // XRECORD가 아닌 항목은 그대로 둔다
    d = { ...d0, entries: new Map([...d0.entries].filter(([, h]) => doc.objects.get(normalizeHandle(h))?.type !== 'XRECORD')) };
  }
  else {
    if (!files.length && !old) return [];
    d = { type: 'DICTIONARY', handle: newHandle(), owner: root.handle, reactors: [root.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    rootMut().entries.set(ACST_STANDARD_KEY, d.handle);
  }
  delete d.dwgRaw;
  // 원래 레코드: 파일 이름이 같은 것을 먼저 다시 쓰고, 남는 것은 고쳐 쓰거나 지운다
  const pool = cur.map(([, x]) => x);
  const used = new Set<XRecordObject>();
  const pick = (f: string) => pool.find((x) => !used.has(x) && firstString(x) === f) ?? pool.find((x) => !used.has(x) && sameStdFile(firstString(x), f));
  const recs: (XRecordObject | null)[] = files.map((f) => {
    const x = pick(f);
    if (x) used.add(x);
    return x ?? null;
  });
  files.forEach((f, i) => {
    let x = recs[i];
    if (!x) x = pool.find((y) => !used.has(y)) ?? null;
    if (x) {
      used.add(x);
      if (firstString(x) !== f) {
        let done = false;
        const data = x.data.map((t) => (t.code === 1 && !done ? ((done = true), { code: 1, value: f }) : t));
        const after: XRecordObject = { ...x, data: done ? data : [{ code: 1, value: f }, ...data] };
        delete after.dwgRaw;
        ops.push({ kind: 'object', key: x.handle, before: x, after });
      }
      d.entries.set(String(i), x.handle);
    } else {
      const h = newHandle();
      const nx: XRecordObject = { type: 'XRECORD', handle: h, owner: d.handle, reactors: [d.handle], cloning: 1, data: [{ code: 1, value: f }] };
      ops.push({ kind: 'object', key: h, before: null, after: nx });
      d.entries.set(String(i), h);
    }
  });
  for (const x of pool) if (!used.has(x)) ops.push({ kind: 'object', key: x.handle, before: x, after: null });
  ops.unshift({ kind: 'object', key: d.handle, before: d0, after: d });
  if (old) {
    const e = rootEntry(doc, STANDARDS_KEY)!;
    rootMut().entries.delete(e[0]);
    ops.push({ kind: 'object', key: old.handle, before: old, after: null });
  }
  if (rootAfter) {
    delete (rootAfter as DictionaryObject).dwgRaw;
    ops.unshift({ kind: 'object', key: root.handle, before: root, after: rootAfter });
  }
  return ops;
}
