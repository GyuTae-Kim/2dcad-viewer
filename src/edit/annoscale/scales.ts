/**
 * 주석 축척 리스트(ACAD_SCALELIST)와 SCALE 객체.
 *
 * - 명명된 객체 사전의 ACAD_SCALELIST(DICTIONARY, 하드 소유 아님, 281 = 1) → 키 A0…A9, B0… → SCALE.
 * - SCALE: 70 = 0, 300 이름, 140 용지 단위, 141 도면 단위, 290 단위 축척(1:1만 1).
 * - 리스트가 없는 도면(R12, 새 도면)은 MEASUREMENT에 맞는 AutoCAD 기본 리스트를 핸들 없이 쓴다.
 * 순수 함수만 둔다(화면·명령은 src/app/annoscale*.ts).
 */
import type { CadDocument, CadObject, DictionaryObject, ScaleObject } from '../../core/model';
import type { EditOp } from '../session';

export interface AnnoScale {
  /** SCALE 객체 핸들. 리스트가 없는 도면의 기본 축척과 새로 만들 축척은 없다 */
  handle?: string;
  name: string;
  /** 용지 단위(140) */
  paper: number;
  /** 도면 단위(141) */
  drawing: number;
  /** 290 단위 축척 */
  unit: boolean;
}

/** 한 리스트가 가질 수 있는 축척 수(키 A0 … Z9) */
export const MAX_SCALES = 260;

const METRIC: [string, number, number][] = [
  ['1:1', 1, 1],
  ['1:2', 1, 2],
  ['1:4', 1, 4],
  ['1:5', 1, 5],
  ['1:8', 1, 8],
  ['1:10', 1, 10],
  ['1:16', 1, 16],
  ['1:20', 1, 20],
  ['1:30', 1, 30],
  ['1:40', 1, 40],
  ['1:50', 1, 50],
  ['1:100', 1, 100],
  ['2:1', 2, 1],
  ['4:1', 4, 1],
  ['8:1', 8, 1],
  ['10:1', 10, 1],
  ['100:1', 100, 1],
];

const IMPERIAL: [string, number, number][] = [
  ...METRIC,
  ['1/128" = 1\'-0"', 0.0078125, 12],
  ['1/64" = 1\'-0"', 0.015625, 12],
  ['1/32" = 1\'-0"', 0.03125, 12],
  ['1/16" = 1\'-0"', 0.0625, 12],
  ['3/32" = 1\'-0"', 0.09375, 12],
  ['1/8" = 1\'-0"', 0.125, 12],
  ['3/16" = 1\'-0"', 0.1875, 12],
  ['1/4" = 1\'-0"', 0.25, 12],
  ['3/8" = 1\'-0"', 0.375, 12],
  ['1/2" = 1\'-0"', 0.5, 12],
  ['3/4" = 1\'-0"', 0.75, 12],
  ['1" = 1\'-0"', 1, 12],
  ['1-1/2" = 1\'-0"', 1.5, 12],
  ['3" = 1\'-0"', 3, 12],
  ['6" = 1\'-0"', 6, 12],
  ['1\'-0" = 1\'-0"', 12, 12],
];

/** AutoCAD 기본 축척 리스트(미터법 17개, 영국식 33개) */
export function defaultScales(metric: boolean): AnnoScale[] {
  return (metric ? METRIC : IMPERIAL).map(([name, paper, drawing]) => ({ name, paper, drawing, unit: name === '1:1' }));
}

/** 도면이 미터법인지($MEASUREMENT 1) */
export function isMetric(doc: CadDocument): boolean {
  return doc.header.get('$MEASUREMENT') === 1;
}

/** 도면 단위 ÷ 용지 단위(주석 객체의 모형 크기 = 용지 크기 × 이 값) */
export function factorOf(s: Pick<AnnoScale, 'paper' | 'drawing'>): number {
  return s.drawing / s.paper;
}

/** 용지 ÷ 도면(CANNOSCALEVALUE) */
export function valueOf(s: Pick<AnnoScale, 'paper' | 'drawing'>): number {
  return s.paper / s.drawing;
}

export const upper = (h: string | undefined): string => (h ?? '').trim().toUpperCase().replace(/^0+(?=.)/, '');

export function dictOf(doc: CadDocument, h: string | undefined): DictionaryObject | null {
  const o = h ? doc.objects.get(upper(h)) : undefined;
  return o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') ? (o as DictionaryObject) : null;
}

/** 사전 항목(대소문자 무시) */
export function entryOf(d: DictionaryObject | null, name: string): string | undefined {
  if (!d) return undefined;
  const k = name.toUpperCase();
  for (const [n, h] of d.entries) if (n.toUpperCase() === k) return upper(h);
  return undefined;
}

/** 명명된 객체 사전의 하위 사전 */
export function rootEntry(doc: CadDocument, name: string): DictionaryObject | null {
  return dictOf(doc, entryOf(dictOf(doc, doc.rootDictionary), name));
}

const validUnits = (v: number): boolean => Number.isFinite(v) && v > 0 && v <= 1e9;

/** SCALE 객체를 축척으로(읽을 수 없으면 null) */
export function scaleFromObject(o: CadObject | undefined): AnnoScale | null {
  if (!o || o.type !== 'SCALE') return null;
  const s = o as ScaleObject;
  if (!s.name || !validUnits(s.paperUnits) || !validUnits(s.drawingUnits)) return null;
  return { handle: upper(s.handle), name: s.name, paper: s.paperUnits, drawing: s.drawingUnits, unit: !!s.unitScale };
}

/** 도면의 축척 리스트(사전 순서 — AutoCAD는 키 A0, A1 … 순으로 쓴다). 사전이 없으면 빈 배열 */
export function readScaleList(doc: CadDocument): AnnoScale[] {
  const d = rootEntry(doc, 'ACAD_SCALELIST');
  if (!d) return [];
  const out: AnnoScale[] = [];
  for (const h of d.entries.values()) {
    const s = scaleFromObject(doc.objects.get(upper(h)));
    if (s) out.push(s);
  }
  return out;
}

/** 쓸 축척 리스트: 도면의 것, 없으면 MEASUREMENT의 기본 리스트(핸들 없음) */
export function scaleList(doc: CadDocument): AnnoScale[] {
  const l = readScaleList(doc);
  return l.length ? l : defaultScales(isMetric(doc));
}

/** 이름으로 찾기(대소문자 무시) */
export function findScale(list: readonly AnnoScale[], name: string): AnnoScale | undefined {
  const k = name.trim().toUpperCase();
  return list.find((s) => s.name.toUpperCase() === k);
}

/** 핸들로 찾기 */
export function scaleByHandle(doc: CadDocument, h: string | undefined): AnnoScale | null {
  return h ? scaleFromObject(doc.objects.get(upper(h))) : null;
}

/** 값이 같은 축척(용지 ÷ 도면이 같으면) */
export function sameRatio(a: Pick<AnnoScale, 'paper' | 'drawing'>, b: Pick<AnnoScale, 'paper' | 'drawing'>): boolean {
  return Math.abs(a.paper * b.drawing - b.paper * a.drawing) <= 1e-9 * Math.max(a.paper * b.drawing, b.paper * a.drawing, 1e-12);
}

/** 1:1(단위 축척, 없으면 비율 1인 첫 축척) */
export function unitScale(list: readonly AnnoScale[]): AnnoScale | undefined {
  return list.find((s) => s.unit) ?? list.find((s) => sameRatio(s, { paper: 1, drawing: 1 }));
}

/** 리스트 순서 i의 사전 키(A0 … Z9) */
export function scaleKey(i: number): string {
  return `${String.fromCharCode(65 + Math.floor(i / 10))}${i % 10}`;
}

/** 숫자 보이기(소수 넷째 자리까지, 끝의 0 없음) */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const r = Math.round(v * 1e4) / 1e4;
  return String(r);
}

/** `1 용지 단위 = 50 도면 단위` */
export function ratioText(s: Pick<AnnoScale, 'paper' | 'drawing'>): string {
  return `${fmtNum(s.paper)} 용지 단위 = ${fmtNum(s.drawing)} 도면 단위`;
}

/** 비율 축척 백분율(`50%`) */
export function percentText(s: Pick<AnnoScale, 'paper' | 'drawing'>): string {
  return `${fmtNum((s.paper / s.drawing) * 100)}%`;
}

/**
 * 축척 비율 입력: `1:50`, `1=50`, `1/50`, `1:50xp`, 숫자 하나(= 용지 단위, 도면 단위 1).
 * 읽을 수 없으면 null.
 */
export function parseRatio(text: string): { paper: number; drawing: number } | null {
  const t = text.trim().replace(/xp$/i, '').replace(/\s+/g, '');
  if (!t) return null;
  const m = /^([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)[:=/]([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)$/i.exec(t);
  const out = m ? { paper: Number(m[1]), drawing: Number(m[2]) } : /^[0-9]*\.?[0-9]+(?:e[-+]?\d+)?$/i.test(t) ? { paper: Number(t), drawing: 1 } : null;
  return out && validUnits(out.paper) && validUnits(out.drawing) ? out : null;
}

/** 축척 이름 검사(1–255자, 제어 문자 없음). 문제가 없으면 null */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return '이름을 입력하십시오.';
  if (name.length > 255) return '이름은 255자를 넘을 수 없습니다.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return '이름에 제어 문자를 쓸 수 없습니다.';
  return null;
}

/** 리스트 검사. 문제가 없으면 null */
export function listProblem(list: readonly AnnoScale[]): string | null {
  if (!list.length) return '축척 리스트에는 축척이 하나 이상 있어야 합니다.';
  if (list.length > MAX_SCALES) return `축척은 ${MAX_SCALES}개를 넘을 수 없습니다.`;
  const names = new Set<string>();
  const handles = new Set<string>();
  for (const s of list) {
    const p = nameProblem(s.name);
    if (p) return `${s.name}: ${p}`;
    const k = s.name.toUpperCase();
    if (names.has(k)) return `축척 이름 ${s.name}이(가) 겹칩니다.`;
    names.add(k);
    if (!validUnits(s.paper) || !validUnits(s.drawing)) return `${s.name}: 단위는 0보다 크고 1e9 이하인 수여야 합니다.`;
    if (s.handle) {
      if (handles.has(upper(s.handle))) return `${s.name}: 같은 축척 객체가 두 번 있습니다.`;
      handles.add(upper(s.handle));
    }
  }
  return null;
}

/** 새 사전(하드 소유 아님, 281 = 1) */
export function newDict(handle: string, owner: string, entries: [string, string][] = [], hardOwner = false): DictionaryObject {
  return { type: 'DICTIONARY', handle, owner, reactors: [owner], entries: new Map(entries), hardOwner, cloning: 1 };
}

/** 객체를 바꾼 복사본(DWG 원본 본문은 버린다 — 값이 달라졌다) */
export function changed<T extends CadObject>(o: T, patch: Partial<T>): T {
  const c = { ...o, ...patch } as T;
  delete (c as { dwgRaw?: unknown }).dwgRaw;
  return c;
}

/** 같은 변경(ops)에서 이미 바꾼 객체면 그 결과, 아니면 문서의 것 */
export function pendingObject<T extends CadObject>(doc: CadDocument, ops: readonly EditOp[], handle: string): T | null {
  const h = upper(handle);
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i]!;
    if (o.kind === 'object' && upper(o.key) === h) return (o.after as T | null) ?? null;
  }
  return (doc.objects.get(h) as T | undefined) ?? null;
}

/**
 * 명명된 객체 사전의 하위 사전을 마련한다. 없으면 만들고 루트 항목을 더한다.
 * 같은 변경(ops)에서 이미 만든 사전·바꾼 루트 사전을 이어 쓴다.
 */
export function ensureRootDict(doc: CadDocument, name: string, alloc: () => string, ops: EditOp[]): DictionaryObject | null {
  const rootH = upper(doc.rootDictionary);
  const root = rootH ? pendingObject<DictionaryObject>(doc, ops, rootH) : null;
  if (!root || (root.type !== 'DICTIONARY' && root.type !== 'ACDBDICTIONARYWDFLT')) return null;
  const hh = entryOf(root, name);
  if (hh) return dictOf(doc, hh) ?? pendingObject<DictionaryObject>(doc, ops, hh);
  const h = alloc();
  const d = newDict(h, root.handle);
  ops.push({ kind: 'object', key: h, before: null, after: d });
  ops.push({ kind: 'object', key: rootH, before: root, after: changed(root, { entries: new Map([...root.entries, [name, h]]) }) });
  return d;
}

export interface ScaleListResult {
  ops: EditOp[];
  /** 새 리스트(새로 만든 축척에 핸들이 붙는다) */
  list: AnnoScale[];
  /** 지우려 했지만 무엇이 가리켜 리스트 끝에 남긴 축척 이름 */
  kept: string[];
  /** 옛 이름 → 새 이름(같은 객체) */
  renamed: Map<string, string>;
}

/**
 * 축척 리스트를 이 리스트로 바꾸는 편집.
 * - 기존 SCALE(핸들)은 300·140·141·290만 고친다. 핸들 없는 축척은 새로 만든다(70 0, 소유자·반응자 = 사전).
 * - 빠진 SCALE은 지우되, used가 가리키면 리스트 끝에 남긴다. 읽을 수 없는 항목도 끝에 남긴다.
 * - 키를 A0…로 다시 쓴다(사전 순서 = 리스트 순서).
 */
export function scaleListOps(doc: CadDocument, list: readonly AnnoScale[], alloc: () => string, used: ReadonlySet<string> = new Set()): ScaleListResult {
  const ops: EditOp[] = [];
  const dict = ensureRootDict(doc, 'ACAD_SCALELIST', alloc, ops);
  const out: AnnoScale[] = [];
  const kept: string[] = [];
  const renamed = new Map<string, string>();
  if (!dict) return { ops: [], list: [...list], kept, renamed };
  const entries: [string, string][] = [];
  const wanted = new Set(list.filter((s) => s.handle).map((s) => upper(s.handle)));
  for (const s of list) {
    let h = s.handle ? upper(s.handle) : '';
    const before = h ? doc.objects.get(h) : undefined;
    if (before && before.type === 'SCALE') {
      const b = before as ScaleObject;
      if (b.name !== s.name || b.paperUnits !== s.paper || b.drawingUnits !== s.drawing || !!b.unitScale !== s.unit) {
        if (b.name !== s.name) renamed.set(b.name, s.name);
        ops.push({ kind: 'object', key: h, before: b, after: changed(b, { name: s.name, paperUnits: s.paper, drawingUnits: s.drawing, unitScale: s.unit }) });
      }
    } else {
      h = alloc();
      const so: ScaleObject = { type: 'SCALE', handle: h, owner: dict.handle, reactors: [dict.handle], name: s.name, paperUnits: s.paper, drawingUnits: s.drawing, unitScale: s.unit };
      ops.push({ kind: 'object', key: h, before: null, after: so });
    }
    out.push({ ...s, handle: h });
    entries.push(['', h]);
  }
  // 빠진 항목: 쓰이면 남기고 아니면 지운다. 읽을 수 없는 항목은 그대로 끝에
  for (const hh of dict.entries.values()) {
    const h = upper(hh);
    if (wanted.has(h)) continue;
    const o = doc.objects.get(h);
    const s = scaleFromObject(o);
    if (!s) {
      if (o) entries.push(['', h]);
      continue;
    }
    if (used.has(h)) {
      kept.push(s.name);
      out.push(s);
      entries.push(['', h]);
      continue;
    }
    ops.push({ kind: 'object', key: h, before: o!, after: null });
  }
  const keyed = entries.map(([, h], i) => [scaleKey(i), h] as [string, string]);
  const cur = dict;
  const curEntries = [...cur.entries];
  const same = curEntries.length === keyed.length && keyed.every(([k, h], i) => curEntries[i]![0] === k && upper(curEntries[i]![1]) === h);
  if (!same) setDictEntries(doc, ops, cur, keyed);
  return { ops, list: out, kept, renamed };
}

/** 사전 항목을 바꾼다(같은 변경에서 만든 사전이면 그 작업을 고친다) */
export function setDictEntries(doc: CadDocument, ops: EditOp[], dict: DictionaryObject, entries: [string, string][]): DictionaryObject {
  const h = upper(dict.handle);
  const made = ops.find((o) => o.kind === 'object' && upper(o.key) === h && o.before === null) as Extract<EditOp, { kind: 'object' }> | undefined;
  const base = (made?.after as DictionaryObject | null) ?? pendingObject<DictionaryObject>(doc, ops, h) ?? dict;
  const after = changed(base, { entries: new Map(entries) });
  if (made) made.after = after;
  else ops.push({ kind: 'object', key: h, before: base, after });
  return after;
}
