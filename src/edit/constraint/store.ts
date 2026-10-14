/**
 * 구속 기록 저장: 이름 있는 객체 사전의 OPENCAD_CONSTRAINTS 항목이 가리키는 XRECORD 하나에 모든 구속과 매개변수를 둔다.
 * DXF·DWG 쓰기가 XRECORD 원본 태그를 그대로 쓰므로 두 형식 모두 왕복한다.
 *
 * 형식 한계: AutoCAD는 구속을 연관 네트워크(ACAD_ASSOCNETWORK)로 둔다. 그 형식은 공개 명세가 없어 쓰지 않는다.
 * 그래서 이 앱이 만든 구속은 AutoCAD에서 보이지 않고(형상만 보인다), AutoCAD가 만든 구속은 읽지 않는다
 * (그 객체들은 원본 그대로 남아 저장된다 — foreignConstraintInfo로 개수만 센다).
 *
 * XRECORD 자료(그룹 코드):
 *   1 "OPENCAD_CONSTRAINTS", 70 형식 판, 90 다음 번호
 *   기하 구속: 1 "GC", 90 번호, 2 종류, 71 참조 수, (330 핸들, 300 부분 — 객체 전체는 "*") × 참조 수, 72 보조 값 수, 40 × 보조 값 수, [41 축 각도]
 *   치수 구속: 1 "DC", 위와 같은 앞부분, 301 이름, 302 식, 42 값, 290 참조, 43 치수선 자리, [291 숨김], [303 설명]
 *   사용자 매개변수: 1 "UP", 301 이름, 302 식, 42 값, [303 설명]
 *   구속 막대 숨김: 1 "HB", 330 핸들
 */
import type { CadDocument, CadObject, DictionaryObject, RawTag, XRecordObject } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import type { EditOp } from '../session';
import { type Constraint, type ConstraintStore, DIM_TYPES, type DimType, GEO_TYPES, type GeoRef, type GeoType, emptyStore } from './types';

export const STORE_KEY = 'OPENCAD_CONSTRAINTS';
const FORMAT = 1;

function isDict(o: CadObject | undefined): o is DictionaryObject {
  return !!o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT');
}

export function rootDictionary(doc: CadDocument): DictionaryObject | null {
  const h = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
  const o = h ? doc.objects.get(h) : undefined;
  return isDict(o) ? o : null;
}

/** 구속 기록 XRECORD(없으면 null) */
export function storeObject(doc: CadDocument): XRecordObject | null {
  const root = rootDictionary(doc);
  if (!root) return null;
  for (const [k, h] of root.entries) {
    if (k.toUpperCase() !== STORE_KEY) continue;
    const o = doc.objects.get(normalizeHandle(h));
    return o?.type === 'XRECORD' ? (o as XRecordObject) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 읽기·쓰기
// ---------------------------------------------------------------------------

const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
/** 글 값(옛 형식이 \U+XXXX로 쓴 비ASCII 문자를 푼다) */
const str = (v: string | number | undefined): string => (v === undefined ? '' : String(v).replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, x: string) => String.fromCharCode(parseInt(x, 16))));

/** XRECORD 자료 → 구속 기록(모르는 태그는 건너뛴다) */
export function decodeStore(tags: readonly RawTag[]): ConstraintStore {
  const s = emptyStore();
  let i = 0;
  const peek = () => tags[i];
  // 머리
  if (peek()?.code === 1 && str(peek()!.value) === STORE_KEY) i++;
  while (i < tags.length && !(tags[i]!.code === 1 && ['GC', 'DC', 'UP', 'HB'].includes(str(tags[i]!.value)))) {
    const t = tags[i]!;
    if (t.code === 90) s.nextId = Math.max(1, Math.trunc(num(t.value, 1)));
    i++;
  }
  while (i < tags.length) {
    const head = tags[i]!;
    i++;
    const rec: RawTag[] = [];
    while (i < tags.length && !(tags[i]!.code === 1 && ['GC', 'DC', 'UP', 'HB'].includes(str(tags[i]!.value)))) rec.push(tags[i++]!);
    const kind = str(head.value);
    try {
      if (kind === 'HB') {
        for (const t of rec) if (t.code === 330 && str(t.value)) s.hiddenBars.push(normalizeHandle(str(t.value)));
        continue;
      }
      if (kind === 'UP') {
        const g = (c: number) => rec.find((t) => t.code === c)?.value;
        const name = str(g(301));
        if (!name) continue;
        const desc = g(303);
        s.userParams.push({ name, expr: str(g(302)) || '0', value: num(g(42)), ...(desc !== undefined && str(desc) ? { description: str(desc) } : {}) });
        continue;
      }
      // 구속: 앞부분은 순서대로
      let k = 0;
      const next = (code: number): RawTag | undefined => {
        while (k < rec.length && rec[k]!.code !== code) k++;
        return k < rec.length ? rec[k++] : undefined;
      };
      const id = Math.trunc(num(next(90)?.value));
      const type = str(next(2)?.value).toUpperCase();
      const nref = Math.trunc(num(next(71)?.value));
      const refs: GeoRef[] = [];
      for (let r = 0; r < nref; r++) {
        const h = str(next(330)?.value);
        const raw = rec[k]?.code === 300 ? str(rec[k++]!.value) : '*';
        const part = raw === '*' ? '' : raw;
        refs.push({ h: h ? normalizeHandle(h) : '', part });
      }
      const nAux = Math.trunc(num(rec.find((t) => t.code === 72)?.value));
      const auxTags = rec.filter((t) => t.code === 40).slice(0, nAux);
      const aux = auxTags.map((t) => num(t.value));
      const axisTag = rec.find((t) => t.code === 41);
      const base = { id, refs, ...(aux.length ? { aux } : {}), ...(axisTag ? { axis: num(axisTag.value) } : {}) };
      if (!refs.length || refs.some((r) => !r.h)) continue;
      if (kind === 'GC') {
        if (!GEO_TYPES.includes(type as GeoType)) continue;
        s.constraints.push({ kind: 'geo', type: type as GeoType, ...base });
      } else if (kind === 'DC') {
        if (!DIM_TYPES.includes(type as DimType)) continue;
        const g = (c: number) => rec.find((t) => t.code === c)?.value;
        const desc = g(303);
        s.constraints.push({
          kind: 'dim',
          type: type as DimType,
          ...base,
          name: str(g(301)) || `d${id}`,
          expr: str(g(302)) || String(num(g(42))),
          value: num(g(42)),
          reference: num(g(290)) !== 0,
          offset: num(g(43)),
          ...(num(g(291)) !== 0 ? { hidden: true } : {}),
          ...(desc !== undefined && str(desc) ? { description: str(desc) } : {}),
        });
      }
    } catch {
      /* 망가진 항목은 건너뛴다 */
    }
  }
  for (const c of s.constraints) s.nextId = Math.max(s.nextId, c.id + 1);
  return s;
}

const fin = (v: number) => (Number.isFinite(v) ? v : 0);

/** 구속 기록 → XRECORD 자료 */
export function encodeStore(s: ConstraintStore): RawTag[] {
  const out: RawTag[] = [
    { code: 1, value: STORE_KEY },
    { code: 70, value: FORMAT },
    { code: 90, value: s.nextId },
  ];
  const head = (c: Constraint) => {
    out.push({ code: 90, value: c.id }, { code: 2, value: c.type }, { code: 71, value: c.refs.length });
    for (const r of c.refs) out.push({ code: 330, value: r.h }, { code: 300, value: r.part || '*' });
    const aux = c.aux ?? [];
    out.push({ code: 72, value: aux.length });
    for (const a of aux) out.push({ code: 40, value: fin(a) });
    if (c.axis !== undefined && c.axis !== 0) out.push({ code: 41, value: fin(c.axis) });
  };
  for (const c of s.constraints) {
    if (c.kind === 'geo') {
      out.push({ code: 1, value: 'GC' });
      head(c);
    } else {
      out.push({ code: 1, value: 'DC' });
      head(c);
      out.push({ code: 301, value: c.name }, { code: 302, value: c.expr }, { code: 42, value: fin(c.value) }, { code: 290, value: c.reference ? 1 : 0 }, { code: 43, value: fin(c.offset) });
      if (c.hidden) out.push({ code: 291, value: 1 });
      if (c.description) out.push({ code: 303, value: c.description });
    }
  }
  for (const u of s.userParams) {
    out.push({ code: 1, value: 'UP' }, { code: 301, value: u.name }, { code: 302, value: u.expr }, { code: 42, value: fin(u.value) });
    if (u.description) out.push({ code: 303, value: u.description });
  }
  if (s.hiddenBars.length) {
    out.push({ code: 1, value: 'HB' });
    for (const h of s.hiddenBars) out.push({ code: 330, value: h });
  }
  return out;
}

const cache = new WeakMap<XRecordObject, ConstraintStore>();

/** 도면의 구속 기록(없으면 빈 기록). 돌려준 값은 고치지 말고 cloneStore로 복사해 고친다 */
export function readStore(doc: CadDocument): ConstraintStore {
  const o = storeObject(doc);
  if (!o) return emptyStore();
  let s = cache.get(o);
  if (!s) {
    s = decodeStore(o.data);
    cache.set(o, s);
  }
  return s;
}

export function cloneStore(s: ConstraintStore): ConstraintStore {
  return structuredClone(s);
}

/** 구속이 하나라도 있는지(빠른 검사) */
export function hasConstraints(doc: CadDocument): boolean {
  return readStore(doc).constraints.length > 0;
}

function sameTags(a: readonly RawTag[], b: readonly RawTag[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.code !== b[i]!.code || String(a[i]!.value) !== String(b[i]!.value)) return false;
  return true;
}

/**
 * 구속 기록을 도면에 쓰는 편집 작업(바뀐 것이 없으면 빈 배열). 처음이면 XRECORD를 만들고 루트 사전에 넣는다.
 * 루트 사전이 없으면 null.
 */
export function storeOps(doc: CadDocument, s: ConstraintStore, newHandle: () => string): EditOp[] | null {
  const data = encodeStore(s);
  const old = storeObject(doc);
  if (old) {
    if (sameTags(old.data, data)) return [];
    const after: XRecordObject = { ...old, data };
    cache.set(after, structuredClone(s));
    return [{ kind: 'object', key: old.handle, before: old, after }];
  }
  if (!s.constraints.length && !s.userParams.length && !s.hiddenBars.length) return [];
  const root = rootDictionary(doc);
  if (!root) return null;
  const h = newHandle();
  const x: XRecordObject = { type: 'XRECORD', handle: h, owner: root.handle, reactors: [root.handle], cloning: 1, data };
  cache.set(x, structuredClone(s));
  const entries = new Map(root.entries);
  entries.set(STORE_KEY, h);
  return [
    { kind: 'object', key: h, before: null, after: x },
    { kind: 'object', key: root.handle, before: root, after: { ...root, entries } },
  ];
}

// ---------------------------------------------------------------------------
// AutoCAD가 만든 구속(연관 네트워크) — 읽지 않고 개수만
// ---------------------------------------------------------------------------

export interface ForeignConstraintInfo {
  /** ACDBASSOCNETWORK 객체 수 */
  networks: number;
  /** 2D 구속 그룹(ACDBASSOC2DCONSTRAINTGROUP) 수 */
  groups: number;
  /** 매개변수(ACDBASSOCVARIABLE) 수 */
  variables: number;
  /** ACDBASSOC로 시작하는 모든 객체 수 */
  total: number;
  /** 루트 사전에 ACAD_ASSOCNETWORK 항목이 있는지 */
  rootEntry: boolean;
}

/** 도면에 AutoCAD 연관 네트워크(구속·연관 동작)가 있는지 센다. 객체는 건드리지 않는다(원본 태그 그대로 저장된다) */
export function foreignConstraintInfo(doc: CadDocument): ForeignConstraintInfo {
  const info: ForeignConstraintInfo = { networks: 0, groups: 0, variables: 0, total: 0, rootEntry: false };
  for (const o of doc.objects.values()) {
    const t = o.type.toUpperCase();
    if (!t.startsWith('ACDBASSOC')) continue;
    info.total++;
    if (t === 'ACDBASSOCNETWORK') info.networks++;
    else if (t === 'ACDBASSOC2DCONSTRAINTGROUP') info.groups++;
    else if (t === 'ACDBASSOCVARIABLE') info.variables++;
  }
  const root = rootDictionary(doc);
  if (root) for (const k of root.entries.keys()) if (k.toUpperCase() === 'ACAD_ASSOCNETWORK') info.rootEntry = true;
  return info;
}

/** AutoCAD 구속 정보 안내 문구(없으면 null) */
export function foreignConstraintNotice(doc: CadDocument): string | null {
  const i = foreignConstraintInfo(doc);
  if (!i.groups && !i.variables) return null;
  const parts: string[] = [];
  if (i.groups) parts.push(`구속 그룹 ${i.groups}개`);
  if (i.variables) parts.push(`매개변수 ${i.variables}개`);
  return `이 도면에는 AutoCAD가 만든 구속 정보(${parts.join(', ')})가 있지만 편집할 수 없습니다. 원본 그대로 저장됩니다.`;
}
