/**
 * 테이블 스타일(TABLESTYLE) 값: DXF 원본 태그 ↔ 모델 값.
 *
 * DXF의 셀 스타일 묶음은 데이터·제목·머리글 순서다(AutoCAD가 저장한 표본과 쓰기의 Standard와 같다).
 * 묶음마다 7 문자 스타일, 140 높이, 170 정렬, 62 문자 색, 63 채우기 색, 283 채우기 사용,
 * (R2007+) 90·91·1 형식, 274~279 테두리 선가중치, 284~289 테두리 표시, 64~69 테두리 색이 온다.
 */
import type { CadColor, CadDocument, DictionaryObject, GenericObject, RawTag } from '../../core/model';
import { tableKey } from '../../core/model';
import { decodeCadEscapes } from '../../core/codepage';

export type CellKind = 'title' | 'header' | 'data';

/** 파일 묶음 순서 */
export const DXF_KIND_ORDER: readonly CellKind[] = ['data', 'title', 'header'];

export const KIND_LABEL: Record<CellKind, string> = { title: '제목', header: '머리글', data: '데이터' };

/** 정렬(1~9 = 위 왼쪽 … 아래 오른쪽, 여러 줄 문자 부착점과 같은 번호) */
export const ALIGN_LABEL: Record<number, string> = {
  1: '맨 위 왼쪽',
  2: '맨 위 중심',
  3: '맨 위 오른쪽',
  4: '중간 왼쪽',
  5: '중간 중심',
  6: '중간 오른쪽',
  7: '맨 아래 왼쪽',
  8: '맨 아래 중심',
  9: '맨 아래 오른쪽',
};

export interface CellStyle {
  textStyle: string;
  height: number;
  align: number;
  /** 문자 색(ACI 0 = ByBlock) */
  color: CadColor;
  /** 채우기 색(없으면 null) */
  fill: CadColor | null;
  /** 테두리 색(모든 테두리) */
  borderColor: CadColor;
}

export interface TableStyle {
  name: string;
  description: string;
  /** 0 아래로, 1 위로 */
  flow: 0 | 1;
  hMargin: number;
  vMargin: number;
  titleSuppressed: boolean;
  headerSuppressed: boolean;
  cells: Record<CellKind, CellStyle>;
}

export function defaultTableStyle(metric: boolean, name = 'Standard'): TableStyle {
  const h = metric ? 4.5 : 0.18;
  const th = metric ? 6 : 0.25;
  const m = metric ? 1.5 : 0.06;
  const cell = (height: number, align: number): CellStyle => ({ textStyle: 'Standard', height, align, color: { aci: 0 }, fill: null, borderColor: { aci: 0 } });
  return {
    name,
    description: '',
    flow: 0,
    hMargin: m,
    vMargin: m,
    titleSuppressed: false,
    headerSuppressed: false,
    cells: { data: cell(h, 2), title: cell(th, 5), header: cell(h, 5) },
  };
}

export function cloneTableStyle(s: TableStyle): TableStyle {
  return structuredClone(s);
}

const num = (v: string | number | undefined, d: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 원본 태그(100 AcDbTableStyle부터)에서 값을 읽는다. 없는 값은 기본값 */
export function parseTableStyleRaw(raw: readonly RawTag[] | undefined, name: string, metric: boolean): TableStyle {
  const s = defaultTableStyle(metric, name);
  if (!raw?.length) return s;
  let i = raw.findIndex((t) => t.code === 100 && String(t.value).trim() === 'AcDbTableStyle');
  if (i < 0) i = -1;
  i++;
  // R2010+: 표지 바로 뒤 280(버전)
  if (raw[i]?.code === 280 && raw[i + 1]?.code === 3) i++;
  let group = -1;
  let fillOn = false;
  let fillColor: CadColor | null = null;
  const finishGroup = () => {
    const k = DXF_KIND_ORDER[group];
    if (k) s.cells[k].fill = fillOn && fillColor ? fillColor : null;
  };
  for (; i < raw.length; i++) {
    const t = raw[i]!;
    if (t.code === 100) break;
    if (group < 0) {
      switch (t.code) {
        case 3:
          s.description = String(t.value);
          break;
        case 70:
          s.flow = num(t.value, 0) === 1 ? 1 : 0;
          break;
        case 40:
          s.hMargin = num(t.value, s.hMargin);
          break;
        case 41:
          s.vMargin = num(t.value, s.vMargin);
          break;
        case 280:
          s.titleSuppressed = num(t.value, 0) !== 0;
          break;
        case 281:
          s.headerSuppressed = num(t.value, 0) !== 0;
          break;
      }
    }
    if (t.code === 7) {
      if (group >= 0) finishGroup();
      group++;
      fillOn = false;
      fillColor = null;
    }
    const k = DXF_KIND_ORDER[group];
    if (!k) continue;
    const c = s.cells[k];
    switch (t.code) {
      case 7:
        c.textStyle = String(t.value) || 'Standard';
        break;
      case 140:
        c.height = num(t.value, c.height);
        break;
      case 170:
        c.align = Math.min(9, Math.max(1, Math.round(num(t.value, c.align))));
        break;
      case 62:
        c.color = { aci: num(t.value, 0) };
        break;
      case 63:
        fillColor = { aci: num(t.value, 7) };
        break;
      case 283:
        fillOn = num(t.value, 0) !== 0;
        break;
      case 64:
        c.borderColor = { aci: num(t.value, 0) };
        break;
    }
  }
  if (group >= 0) finishGroup();
  return s;
}

/** 대상 DXF 버전(1018 = R2004 …)에 맞는 원본 태그 */
export function tableStyleRaw(s: TableStyle, ver: number): RawTag[] {
  const raw: RawTag[] = [{ code: 100, value: 'AcDbTableStyle' }];
  if (ver >= 1024) raw.push({ code: 280, value: 0 });
  raw.push(
    { code: 3, value: s.description || s.name },
    { code: 70, value: s.flow },
    { code: 71, value: 0 },
    { code: 40, value: s.hMargin },
    { code: 41, value: s.vMargin },
    { code: 280, value: s.titleSuppressed ? 1 : 0 },
    { code: 281, value: s.headerSuppressed ? 1 : 0 },
  );
  for (const k of DXF_KIND_ORDER) {
    const c = s.cells[k];
    const aci = (x: CadColor) => (x.aci >= 0 && x.aci <= 257 ? x.aci : 0);
    raw.push(
      { code: 7, value: c.textStyle || 'Standard' },
      { code: 140, value: c.height },
      { code: 170, value: c.align },
      { code: 62, value: aci(c.color) },
      { code: 63, value: c.fill ? aci(c.fill) : 7 },
      { code: 283, value: c.fill ? 1 : 0 },
    );
    if (ver >= 1021) raw.push({ code: 90, value: 512 }, { code: 91, value: 0 }, { code: 1, value: '' });
    for (let i = 0; i < 6; i++) raw.push({ code: 274 + i, value: -2 }, { code: 284 + i, value: 1 }, { code: 64 + i, value: aci(c.borderColor) });
  }
  return raw;
}

/** 문서 버전 문자열(AC1032 …) → 숫자 */
export function docVersionNumber(doc: CadDocument): number {
  const n = Number(String(doc.version || 'AC1032').slice(2));
  return Number.isFinite(n) && n > 0 ? n : 1032;
}

export function isMetric(doc: CadDocument): boolean {
  return Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;
}

export interface TableStyleEntry {
  name: string;
  handle: string;
  obj: GenericObject;
  style: TableStyle;
}

/** 루트 사전의 ACAD_TABLESTYLE 사전 */
export function tableStyleDictionary(doc: CadDocument): DictionaryObject | null {
  const root = doc.rootDictionary ? doc.objects.get(doc.rootDictionary) : undefined;
  const rootDict = root && (root.type === 'DICTIONARY' || root.type === 'ACDBDICTIONARYWDFLT') ? (root as DictionaryObject) : null;
  let h: string | undefined;
  if (rootDict) for (const [k, v] of rootDict.entries) if (k.toUpperCase() === 'ACAD_TABLESTYLE') h = v;
  if (!h) {
    // 루트 사전 핸들을 모르는 문서: 이름 없는 사전 중 Standard 표 스타일을 가진 것
    for (const o of doc.objects.values()) {
      if (o.type !== 'DICTIONARY') continue;
      const d = o as DictionaryObject;
      for (const v of d.entries.values()) if (doc.objects.get(v)?.type === 'TABLESTYLE') return d;
    }
    return null;
  }
  const d = doc.objects.get(h);
  return d && (d.type === 'DICTIONARY' || d.type === 'ACDBDICTIONARYWDFLT') ? (d as DictionaryObject) : null;
}

/** 문서의 테이블 스타일(사전 항목 이름 순서) */
export function listTableStyles(doc: CadDocument): TableStyleEntry[] {
  const metric = isMetric(doc);
  const out: TableStyleEntry[] = [];
  const seen = new Set<string>();
  const dict = tableStyleDictionary(doc);
  if (dict)
    for (const [name, h] of dict.entries) {
      const o = doc.objects.get(h);
      if (!o || o.type !== 'TABLESTYLE') continue;
      seen.add(h);
      const g = o as GenericObject;
      // R2007 이전 DXF의 사전 항목 이름은 \U+XXXX 그대로 읽힌다
      const nm = decodeCadEscapes(name);
      out.push({ name: nm, handle: h, obj: g, style: parseTableStyleRaw(g.raw, nm, metric) });
    }
  for (const o of doc.objects.values()) {
    if (o.type !== 'TABLESTYLE' || seen.has(o.handle)) continue;
    const g = o as GenericObject;
    const st = parseTableStyleRaw(g.raw, 'Standard', metric);
    const name = st.description || `TableStyle_${o.handle}`;
    st.name = name;
    out.push({ name, handle: o.handle, obj: g, style: st });
  }
  return out;
}

export function findTableStyle(doc: CadDocument, nameOrHandle: string | undefined): TableStyleEntry | null {
  if (!nameOrHandle) return null;
  const list = listTableStyles(doc);
  const h = nameOrHandle.toUpperCase();
  return list.find((s) => s.handle === h) ?? list.find((s) => tableKey(s.name) === tableKey(nameOrHandle)) ?? null;
}

/** 지금 테이블 스타일($CTABLESTYLE, 없으면 Standard, 그것도 없으면 첫 스타일) */
export function currentTableStyle(doc: CadDocument): TableStyleEntry | null {
  const cur = doc.header.get('$CTABLESTYLE');
  const list = listTableStyles(doc);
  if (typeof cur === 'string' && cur) {
    const f = list.find((s) => tableKey(s.name) === tableKey(cur)) ?? list.find((s) => s.handle === cur.toUpperCase());
    if (f) return f;
  }
  return list.find((s) => tableKey(s.name) === 'STANDARD') ?? list[0] ?? null;
}

/** 행 높이: 문자 줄 수(줄 간격 = 문자 높이 × 5/3)와 위아래 여백 */
export function rowHeightForLines(lines: number, textHeight: number, vMargin: number): number {
  const n = Math.max(1, Math.floor(lines));
  return textHeight + (n - 1) * textHeight * (5 / 3) + 2 * vMargin;
}
