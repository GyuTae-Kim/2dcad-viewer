/**
 * 이름 있는 플롯 스타일: PLOTSTYLE(객체에 지정), CONVERTPSTYLES(색상 종속 ↔ 이름 있는 플롯 스타일 도면).
 *
 * 이름은 루트 사전의 ACAD_PLOTSTYLENAME 사전(이름 → ACDBPLACEHOLDER 객체)에 있고,
 * 도면층·객체는 그 자리 표시 객체의 핸들(DXF 390)로 가리킨다. 핸들이 없으면 ByLayer다.
 * $PSTYLEMODE: 1 = 색상 종속(CTB), 0 = 이름 있는 플롯 스타일(STB).
 */
import { nearestAci } from '../../core/color';
import type { CadDocument, CadObject, DictionaryObject, Entity, GenericObject, Layer, Layout } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';

/** 이름 있는 플롯 스타일 도면인지 */
export function isNamedPlotStyleDoc(doc: CadDocument): boolean {
  return Number(doc.header.get('$PSTYLEMODE') ?? 1) === 0;
}

const isDict = (o: CadObject | undefined): o is DictionaryObject => !!o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT');

/** ACAD_PLOTSTYLENAME 사전(없으면 null) */
export function plotStyleDictionary(doc: CadDocument): DictionaryObject | null {
  const root = doc.rootDictionary ? doc.objects.get(normalizeHandle(doc.rootDictionary)) : undefined;
  if (!isDict(root)) return null;
  const h = [...root.entries].find(([n]) => n.toUpperCase() === 'ACAD_PLOTSTYLENAME')?.[1];
  const d = h ? doc.objects.get(normalizeHandle(h)) : undefined;
  return isDict(d) ? d : null;
}

/** 사전의 플롯 스타일 이름(원래 대소문자, 사전 순서) */
export function plotStyleNameList(doc: CadDocument): string[] {
  return [...(plotStyleDictionary(doc)?.entries.keys() ?? [])];
}

/** 핸들 → 이름 */
export function plotStyleNameOf(doc: CadDocument, handle: string | undefined): string | null {
  if (!handle) return null;
  const d = plotStyleDictionary(doc);
  if (!d) return null;
  const h = normalizeHandle(handle);
  for (const [n, x] of d.entries) if (normalizeHandle(x) === h) return n;
  return null;
}

/** 색(ACI 1~255, 트루컬러는 가장 가까운 ACI)에 맞는 플롯 스타일 이름(CONVERTCTB가 만드는 이름) */
export function colorPlotStyleName(aci: number, rgb?: number): string {
  const n = rgb !== undefined ? nearestAci(rgb) : Math.abs(aci);
  return `Color_${n >= 1 && n <= 255 ? n : 7}`;
}

/**
 * 이름들의 자리 표시 객체 핸들(대문자 이름 → 핸들). 사전에 없는 이름은 새 ACDBPLACEHOLDER를 만들어 더하는 작업을 ops에 넣는다.
 * 사전이 없는 도면이면 null.
 */
export function ensurePlotStyleNames(doc: CadDocument, names: Iterable<string>, newHandle: () => string, ops: EditOp[]): Map<string, string> | null {
  const d = plotStyleDictionary(doc);
  if (!d) return null;
  const out = new Map<string, string>();
  const have = new Map([...d.entries].map(([n, h]) => [n.toUpperCase(), normalizeHandle(h)]));
  let entries: Map<string, string> | null = null;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toUpperCase();
    if (out.has(key)) continue;
    const h = have.get(key);
    if (h) {
      out.set(key, h);
      continue;
    }
    const nh = newHandle();
    const ph: GenericObject = { type: 'ACDBPLACEHOLDER', handle: nh, owner: d.handle, reactors: [d.handle] };
    ops.push({ kind: 'object', key: nh, before: null, after: ph });
    entries ??= new Map(d.entries);
    entries.set(name, nh);
    have.set(key, nh);
    out.set(key, nh);
  }
  if (entries) ops.push({ kind: 'object', key: d.handle, before: d, after: { ...d, entries } });
  return out;
}

/** 최상위 객체를 담은 블록(외부 참조 블록 제외): [블록 키, 객체] */
function* ownEntities(doc: CadDocument): Generator<[string, Entity]> {
  for (const [key, b] of doc.blocks) {
    if (b.flags & 4 || b.flags & 16) continue;
    for (const e of b.entities) yield [key, e];
  }
}

/**
 * PLOTSTYLE: 고른 객체의 플롯 스타일을 바꾸는 작업. name이 BYLAYER면 핸들을 지운다.
 * 반환: 작업과 바뀐 객체 수(이름 있는 플롯 스타일 사전이 없으면 null)
 */
export function assignPlotStyleOps(doc: CadDocument, handles: readonly string[], name: string, newHandle: () => string, ownerOf: (h: string) => string | null): { ops: EditOp[]; changed: number } | null {
  const ops: EditOp[] = [];
  let target: string | undefined;
  if (name.toUpperCase() !== 'BYLAYER') {
    const m = ensurePlotStyleNames(doc, [name], newHandle, ops);
    if (!m) return null;
    target = m.get(name.toUpperCase());
  }
  let changed = 0;
  for (const h of handles) {
    const e = doc.entityIndex.get(h);
    const block = ownerOf(h);
    if (!e || !block || e.type === 'ATTRIB') continue;
    const cur = e.plotStyle ? normalizeHandle(e.plotStyle) : undefined;
    if (cur === target) continue;
    const after = { ...e } as Entity;
    if (target) after.plotStyle = target;
    else delete after.plotStyle;
    ops.push({ kind: 'modify', block, before: e, after });
    changed++;
  }
  return { ops, changed };
}

export interface ConvertResult {
  ops: EditOp[];
  layers: number;
  entities: number;
  layouts: number;
}

const swapExt = (sheet: string, ext: 'ctb' | 'stb') => (sheet ? sheet.replace(/\.(ctb|stb)$/i, '') + `.${ext}` : '');

/**
 * 색상 종속 → 이름 있는 플롯 스타일. 도면층은 색에 맞는 Color_n, 색을 직접 지정한 객체도 Color_n,
 * ByLayer·ByBlock 색 객체는 ByLayer 플롯 스타일. 배치(모형 포함)의 플롯 스타일 표는 stb(없으면 .ctb를 .stb로)로 바꾼다.
 */
export function convertToNamedOps(doc: CadDocument, newHandle: () => string, stb?: string): ConvertResult | null {
  const ops: EditOp[] = [];
  const want = new Set<string>(['Normal']);
  const layerName = (l: Layer) => colorPlotStyleName(l.color.aci, l.color.rgb);
  const entName = (e: Entity): string | null => {
    const c = e.color;
    if (c.rgb === undefined && (c.aci === 256 || c.aci === 0)) return null;
    return colorPlotStyleName(c.aci, c.rgb);
  };
  for (const l of doc.layers.values()) if (!l.name.includes('|')) want.add(layerName(l));
  for (const [, e] of ownEntities(doc)) {
    const n = entName(e);
    if (n) want.add(n);
  }
  const handles = ensurePlotStyleNames(doc, [...want].sort(byColorName), newHandle, ops);
  if (!handles) return null;
  let layers = 0;
  for (const [key, l] of doc.layers) {
    if (l.name.includes('|')) continue;
    const h = handles.get(layerName(l).toUpperCase());
    if (!h || (l.plotStyle && normalizeHandle(l.plotStyle) === h)) continue;
    ops.push({ kind: 'layer', key, before: l, after: { ...l, plotStyle: h } });
    layers++;
  }
  let entities = 0;
  for (const [block, e] of ownEntities(doc)) {
    const n = entName(e);
    const h = n ? handles.get(n.toUpperCase()) : undefined;
    const cur = e.plotStyle ? normalizeHandle(e.plotStyle) : undefined;
    if (cur === h) continue;
    const after = { ...e } as Entity;
    if (h) after.plotStyle = h;
    else delete after.plotStyle;
    ops.push({ kind: 'modify', block, before: e, after });
    entities++;
  }
  const layouts = layoutSheetOps(doc, ops, (s) => stb || swapExt(s, 'stb'));
  ops.push({ kind: 'header', name: '$PSTYLEMODE', before: doc.header.get('$PSTYLEMODE'), after: 0 });
  return { ops, layers, entities, layouts };
}

/**
 * 이름 있는 플롯 스타일 → 색상 종속. 도면층·객체의 플롯 스타일 이름을 모두 지우고(사전에는 Normal만 남긴다),
 * 배치의 플롯 스타일 표는 ctb(없으면 .stb를 .ctb로)로 바꾼다.
 */
export function convertToColorOps(doc: CadDocument, ctb?: string): ConvertResult {
  const ops: EditOp[] = [];
  const d = plotStyleDictionary(doc);
  const normal = d ? [...d.entries].find(([n]) => n.toUpperCase() === 'NORMAL') : undefined;
  const normalH = normal ? normalizeHandle(normal[1]) : undefined;
  let layers = 0;
  for (const [key, l] of doc.layers) {
    if (!l.plotStyle || normalizeHandle(l.plotStyle) === normalH) continue;
    const after: Layer = { ...l };
    if (normalH) after.plotStyle = normalH;
    else delete after.plotStyle;
    ops.push({ kind: 'layer', key, before: l, after });
    layers++;
  }
  let entities = 0;
  for (const [block, e] of ownEntities(doc)) {
    if (!e.plotStyle) continue;
    const after = { ...e } as Entity;
    delete after.plotStyle;
    ops.push({ kind: 'modify', block, before: e, after });
    entities++;
  }
  if (d) {
    const entries = new Map<string, string>();
    for (const [n, h] of d.entries) {
      if (n.toUpperCase() === 'NORMAL') entries.set(n, h);
      else {
        const o = doc.objects.get(normalizeHandle(h));
        if (o && o.type === 'ACDBPLACEHOLDER') ops.push({ kind: 'object', key: normalizeHandle(h), before: o, after: null });
      }
    }
    if (entries.size !== d.entries.size) ops.push({ kind: 'object', key: d.handle, before: d, after: { ...d, entries } });
  }
  const layouts = layoutSheetOps(doc, ops, (s) => ctb || swapExt(s, 'ctb'));
  ops.push({ kind: 'header', name: '$PSTYLEMODE', before: doc.header.get('$PSTYLEMODE'), after: 1 });
  return { ops, layers, entities, layouts };
}

/** 배치마다 플롯 스타일 표 이름을 바꾸는 작업. 바꾼 배치 수 */
function layoutSheetOps(doc: CadDocument, ops: EditOp[], next: (sheet: string) => string): number {
  let n = 0;
  for (const l of doc.layouts) {
    const s = next(l.plot.styleSheet ?? '');
    if (s === (l.plot.styleSheet ?? '')) continue;
    const after: Layout = { ...l, plot: { ...l.plot, styleSheet: s } };
    ops.push({ kind: 'layout', key: tableKey(l.blockName), before: l, after });
    n++;
  }
  return n;
}

/** Normal이 먼저, Color_n은 번호 순, 나머지는 이름 순 */
function byColorName(a: string, b: string): number {
  const rank = (s: string) => (s.toUpperCase() === 'NORMAL' ? -1 : /^Color_(\d+)$/i.test(s) ? Number(/\d+/.exec(s)![0]) : 1000);
  return rank(a) - rank(b) || a.localeCompare(b);
}
