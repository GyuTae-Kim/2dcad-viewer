/**
 * 구속 기록 저장: 이름 있는 객체 사전의 OPENCAD_CONSTRAINTS 항목이 가리키는 XRECORD 하나에 모든 구속과 매개변수를 둔다.
 * DXF·DWG 쓰기가 XRECORD 원본 태그를 그대로 쓰므로 두 형식 모두 왕복한다.
 *
 * AutoCAD가 만든 구속(연관 망 ACAD_ASSOCNETWORK의 2D 구속 그룹)은 src/edit/assocnet/constraints.ts가 읽어 readStore에
 * 함께 넣는다(acad 연결이 있는 구속·매개변수). 그 구속은 이 XRECORD에 쓰지 않고, storeOps가 바뀐 것을 원본 그룹·변수에
 * 같은 형식으로 고쳐 쓴다(src/edit/assocnet/writeback.ts). 이 앱이 새로 만든 구속도 AutoCAD 그룹으로 쓸 수 있는 종류면
 * storeOps가 그룹에 쓴다(src/edit/assocnet/cwrite.ts — 그 뒤로는 AutoCAD 구속으로 읽힌다). 쓸 수 없는 종류(각도·대칭·
 * 부드러움, 폴리선·타원·스플라인, 다른 매개변수를 쓰는 식 등)와 이 앱 사용자 매개변수만 이 XRECORD에 남아 AutoCAD에서는
 * 보이지 않는다.
 *
 * XRECORD 자료(그룹 코드):
 *   1 "OPENCAD_CONSTRAINTS", 70 형식 판, 90 다음 번호
 *   기하 구속: 1 "GC", 90 번호, 2 종류, 71 참조 수, (330 핸들, 300 부분 — 객체 전체는 "*") × 참조 수, 72 보조 값 수, 40 × 보조 값 수, [41 축 각도]
 *   치수 구속: 1 "DC", 위와 같은 앞부분, 301 이름, 302 식, 42 값, 290 참조, 43 치수선 자리, [291 숨김], [303 설명]
 *   사용자 매개변수: 1 "UP", 301 이름, 302 식, 42 값, [303 설명]
 *   구속 막대 숨김: 1 "HB", 330 핸들
 *   치수 표시를 숨긴 AutoCAD 치수 구속: 1 "AH", 330 구속 그룹, 90 노드 번호
 */
import type { CadDocument, CadObject, DictionaryObject, RawTag, XRecordObject } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import type { EditOp } from '../session';
import { type AcadImport, importAcadConstraints } from '../assocnet/constraints';
import { acadStoreOps } from '../assocnet/writeback';
import { acadWriteOps } from '../assocnet/cwrite';
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

const HEADS = ['GC', 'DC', 'UP', 'HB', 'AH'];

/** XRECORD 자료 → 구속 기록(모르는 태그는 건너뛴다) */
export function decodeStore(tags: readonly RawTag[]): ConstraintStore {
  const s = emptyStore();
  let i = 0;
  const peek = () => tags[i];
  // 머리
  if (peek()?.code === 1 && str(peek()!.value) === STORE_KEY) i++;
  while (i < tags.length && !(tags[i]!.code === 1 && HEADS.includes(str(tags[i]!.value)))) {
    const t = tags[i]!;
    if (t.code === 90) s.nextId = Math.max(1, Math.trunc(num(t.value, 1)));
    i++;
  }
  while (i < tags.length) {
    const head = tags[i]!;
    i++;
    const rec: RawTag[] = [];
    while (i < tags.length && !(tags[i]!.code === 1 && HEADS.includes(str(tags[i]!.value)))) rec.push(tags[i++]!);
    const kind = str(head.value);
    try {
      if (kind === 'HB') {
        for (const t of rec) if (t.code === 330 && str(t.value)) s.hiddenBars.push(normalizeHandle(str(t.value)));
        continue;
      }
      if (kind === 'AH') {
        const g = rec.find((t) => t.code === 330);
        const n = rec.find((t) => t.code === 90);
        if (g && n && str(g.value)) (s.acadHidden ??= []).push(`${normalizeHandle(str(g.value))}:${Math.trunc(num(n.value))}`);
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
  for (const k of s.acadHidden ?? []) {
    const [g, n] = k.split(':');
    out.push({ code: 1, value: 'AH' }, { code: 330, value: g! }, { code: 90, value: Number(n) });
  }
  return out;
}

const cache = new WeakMap<XRecordObject, ConstraintStore>();
const EMPTY = emptyStore();

/** 이 앱 기록(XRECORD)만 */
export function readAppStore(doc: CadDocument): ConstraintStore {
  const o = storeObject(doc);
  if (!o) return EMPTY;
  let s = cache.get(o);
  if (!s) {
    s = decodeStore(o.data);
    cache.set(o, s);
  }
  return s;
}

const merged = new WeakMap<CadDocument, { app: ConstraintStore; acad: AcadImport; store: ConstraintStore }>();
const NO_ACAD: AcadImport = { constraints: [], userParams: [], info: { groups: 0, unreadable: [], imported: 0, skipped: 0, variables: 0, raw: 0 }, groups: [], renames: new Map(), networkOf: new Map() };

/** AutoCAD 구속 읽기(뜻밖의 자료로 실패해도 이 앱 구속은 그대로 쓸 수 있게 빈 결과로) */
function safeImport(doc: CadDocument): AcadImport {
  try {
    return importAcadConstraints(doc);
  } catch {
    return NO_ACAD;
  }
}

/**
 * 도면의 구속 기록(없으면 빈 기록): 이 앱 기록 + AutoCAD 구속(acad 연결). 돌려준 값은 고치지 말고 cloneStore로 복사해 고친다.
 * 이름이 이 앱 매개변수와 겹치는 AutoCAD 사용자 매개변수는 뺀다(이 앱 것이 이긴다).
 */
export function readStore(doc: CadDocument): ConstraintStore {
  const app = readAppStore(doc);
  const acad = safeImport(doc);
  if (!acad.constraints.length && !acad.userParams.length) return app === EMPTY ? emptyStore() : app;
  const hit = merged.get(doc);
  if (hit && hit.app === app && hit.acad === acad) return hit.store;
  const names = new Set(app.userParams.map((u) => u.name.toLowerCase()));
  for (const c of app.constraints) if (c.kind === 'dim') names.add(c.name.toLowerCase());
  const hidden = new Set(app.acadHidden ?? []);
  const imported = hidden.size ? acad.constraints.map((c) => (c.kind === 'dim' && c.acad && hidden.has(`${c.acad.group}:${c.acad.node}`) ? { ...c, hidden: true } : c)) : acad.constraints;
  const store: ConstraintStore = {
    ...app,
    constraints: [...app.constraints, ...imported],
    userParams: [...app.userParams, ...acad.userParams.filter((u) => !names.has(u.name.toLowerCase()))],
  };
  merged.set(doc, { app, acad, store });
  return store;
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
 * AutoCAD 구속(acad 연결)은 XRECORD에 쓰지 않고 원본 그룹·변수를 고치는 작업으로 바꾼다.
 * 루트 사전이 없어 이 앱 기록을 쓸 수 없으면 null.
 */
export function storeOps(doc: CadDocument, s: ConstraintStore, newHandle: () => string): EditOp[] | null {
  let acadOps: EditOp[] = [];
  try {
    acadOps = acadStoreOps(doc, s);
  } catch {
    // AutoCAD 그룹을 고치지 못하면 원본은 그대로 둔다(저장하면 원본 그대로)
  }
  // 이 앱이 새로 만든 구속 중 AutoCAD 그룹으로 쓸 수 있는 것은 그룹에 쓴다(src/edit/assocnet/cwrite.ts)
  let written = new Map<number, { group: string; node: number }>();
  try {
    const w = acadWriteOps(doc, s.constraints, acadOps, newHandle);
    if (w.written.size) {
      acadOps = [...acadOps, ...w.ops];
      written = w.written;
    }
  } catch {
    // 쓰지 못하면 이 앱 기록에 남긴다
  }
  const acadHidden = s.constraints.filter((c) => c.acad && c.kind === 'dim' && c.hidden).map((c) => `${normalizeHandle(c.acad!.group)}:${c.acad!.node}`);
  for (const c of s.constraints) {
    const at = !c.acad && c.kind === 'dim' && c.hidden ? written.get(c.id) : undefined;
    if (at) acadHidden.push(`${at.group}:${at.node}`);
  }
  const own: ConstraintStore = { ...s, constraints: s.constraints.filter((c) => !c.acad && !written.has(c.id)), userParams: s.userParams.filter((u) => !u.acad) };
  if (acadHidden.length) own.acadHidden = acadHidden;
  else delete own.acadHidden;
  const data = encodeStore(own);
  const old = storeObject(doc);
  if (old) {
    if (sameTags(old.data, data)) return acadOps;
    const after: XRecordObject = { ...old, data };
    cache.set(after, structuredClone(own));
    return [{ kind: 'object', key: old.handle, before: old, after }, ...acadOps];
  }
  if (!own.constraints.length && !own.userParams.length && !own.hiddenBars.length && !own.acadHidden?.length) return acadOps;
  const root0 = rootDictionary(doc);
  if (!root0) return acadOps.length ? acadOps : null;
  const h = newHandle();
  const x: XRecordObject = { type: 'XRECORD', handle: h, owner: root0.handle, reactors: [root0.handle], cloning: 1, data };
  cache.set(x, structuredClone(own));
  // 루트 사전: AutoCAD 망을 새로 만들며 이미 고친 것이면 그 작업에 항목을 더한다
  const rootOp = acadOps.find((o): o is Extract<EditOp, { kind: 'object' }> => o.kind === 'object' && normalizeHandle(o.key) === normalizeHandle(root0.handle) && !!o.after);
  if (rootOp) {
    const r = rootOp.after as DictionaryObject;
    const entries = new Map(r.entries);
    entries.set(STORE_KEY, h);
    rootOp.after = { ...r, entries };
    return [{ kind: 'object', key: h, before: null, after: x }, ...acadOps];
  }
  const entries = new Map(root0.entries);
  entries.set(STORE_KEY, h);
  return [
    { kind: 'object', key: h, before: null, after: x },
    { kind: 'object', key: root0.handle, before: root0, after: { ...root0, entries } },
    ...acadOps,
  ];
}

// ---------------------------------------------------------------------------
// AutoCAD가 만든 구속(연관 네트워크) — 개수와 읽은 결과
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
  /** 이 앱 구속으로 읽은 AutoCAD 구속 수 */
  imported: number;
  /** 읽은 사용자 매개변수 수 */
  importedParams: number;
  /** 읽지 못한 구속 그룹 수(모르는 노드 클래스, 또는 DWG 본문을 풀지 못함) */
  unreadGroups: number;
  /** 읽은 그룹 안에서 옮기지 못한 구속 수 */
  skipped: number;
}

/** 도면에 AutoCAD 연관 네트워크(구속·연관 동작)가 있는지 센다. 객체는 건드리지 않는다(원본 태그 그대로 저장된다) */
export function foreignConstraintInfo(doc: CadDocument): ForeignConstraintInfo {
  const imp = safeImport(doc);
  const info: ForeignConstraintInfo = {
    networks: 0,
    groups: 0,
    variables: 0,
    total: 0,
    rootEntry: false,
    imported: imp.info.imported,
    importedParams: imp.info.variables,
    unreadGroups: imp.info.unreadable.length + imp.info.raw,
    skipped: imp.info.skipped,
  };
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
  const out: string[] = [];
  if (i.imported || i.importedParams) {
    const parts: string[] = [];
    if (i.imported) parts.push(`구속 ${i.imported}개`);
    if (i.importedParams) parts.push(`사용자 매개변수 ${i.importedParams}개`);
    out.push(`AutoCAD 구속 그룹의 ${parts.join('와 ')}를 읽었습니다. 구속 막대·PARAMETERS에서 고칠 수 있고, 저장하면 AutoCAD 형식 그대로 갱신됩니다.`);
  }
  if (i.skipped) out.push(`옮기지 못한 구속 ${i.skipped}개는 원본에 남아 있지만 이 앱에서는 보이지 않습니다.`);
  if (i.unreadGroups) out.push(`구속 그룹 ${i.unreadGroups}개는 읽지 못해(지원하지 않는 구속 종류) 원본 그대로 저장됩니다.`);
  if (!out.length) out.push(`이 도면에는 AutoCAD가 만든 구속 정보(구속 그룹 ${i.groups}개)가 있지만 읽을 구속이 없습니다. 원본 그대로 저장됩니다.`);
  return out.join(' ');
}
