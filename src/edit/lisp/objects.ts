/**
 * AutoLISP 확장 데이터·비도형 객체·표 기록(화면·DOM 없음).
 * - 확장 데이터(-3): entget의 앱 이름 목록으로 읽고, entmod·entmake로 쓴다. 앱 이름은 regapp으로 등록해야 한다.
 *   (-3 ("APP" (1000 . "글") (1002 . "{") (1040 . 1.0) (1002 . "}") (1010 1.0 2.0 0.0) (1005 . "1F") (1070 . 3) (1071 . 70000) (1004 . "0A0B")))
 *   빈 앱 목록 ("APP")은 그 앱의 확장 데이터를 지운다. 객체 하나의 확장 데이터는 16383바이트까지(xdsize·xdroom, DWG EED 크기로 센다).
 * - 사전·XRECORD: namedobjdict, dictsearch, dictnext, dictadd, dictremove, dictrename. entget·entmod로 읽고 바꾸며,
 *   entmakex로 만든 주인 없는 객체는 dictadd로 사전에 넣어야 도면에 남는다(dictremove로 뺀 객체도 같다).
 * - 표 기록: entget(LAYER·LTYPE·STYLE·DIMSTYLE·VIEW·UCS·APPID·VPORT·BLOCK_RECORD, 블록 머리 BLOCK), LAYER의 entmod(색·선종류·
 *   플래그·선가중치·플롯·확장 데이터).
 * 바꾸는 일은 LispDrawing.commit 한 번이 명령 취소 한 단계다(최상위 평가 하나로 다시 묶인다).
 */
import type { BlockDef, CadDocument, CadObject, DictionaryObject, GenericObject, GroupObject, Layer, LayoutObject, RawTag, TableRecordBase, XData, XDataItem, XRecordObject } from '../../core/model';
import { normalizeHandle, tableKey } from '../../core/model';
import type { EditOp } from '../session';
import type { LispDrawing } from './host';
import type { Interp } from './interp';
import { prin1 } from './printer';
import { wcmatch } from './text';
import { Cons, Ename, LispError, Real, fromArray, isNum, numOf, toArray, type Value } from './types';

export type Pair = [number, Value];

const R = (x: number) => new Real(x);
const P3 = (x: number, y: number, z: number) => fromArray([R(x), R(y), R(z)]);

/** 객체 하나의 확장 데이터 한도(바이트) */
export const XD_LIMIT = 16383;

const bad = (v: Value) => new LispError(`잘못된 DXF 그룹: ${prin1(v)}`);

// --------------------------------------------------------------------------- 확장 데이터

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

function fromHex(s: string): Uint8Array | null {
  const t = s.trim();
  if (t.length % 2 || !/^[0-9a-f]*$/i.test(t)) return null;
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 확장 데이터 항목 → (코드 . 값) */
function itemToLisp(item: XDataItem): Value {
  const { code, value: v } = item;
  if (code >= 1010 && code <= 1013 && typeof v === 'object' && !(v instanceof Uint8Array)) return new Cons(code, P3(v.x, v.y, v.z));
  if (v instanceof Uint8Array) return new Cons(code, toHex(v));
  if (code >= 1040 && code <= 1042) return new Cons(code, R(Number(v)));
  if (code === 1070 || code === 1071) return new Cons(code, Math.trunc(Number(v)) | 0);
  return new Cons(code, typeof v === 'string' ? v : String(v));
}

/** 앱 이름 목록(와일드카드)에 맞는 확장 데이터 → (-3 ("APP" …) …). 없으면 null */
export function xdataPair(xs: readonly XData[] | undefined, apps: readonly string[]): Pair | null {
  if (!xs?.length || !apps.length) return null;
  const hit = xs.filter((x) => apps.some((a) => wcmatch(x.app, a, true)));
  if (!hit.length) return null;
  return [-3, fromArray(hit.map((x) => new Cons(x.app, fromArray(x.items.map(itemToLisp)))))];
}

/** entget의 앱 이름 인자: 문자열 목록 */
export function appList(v: Value | undefined): string[] {
  if (v === undefined || v === null) return [];
  const a = toArray(v);
  if (!a || !a.every((x) => typeof x === 'string')) throw new LispError(`잘못된 인수 유형: listp: ${prin1(v)}`);
  return a as string[];
}

/** 등록한 앱 이름(APPID 표)인가 */
export function appRegistered(doc: CadDocument, app: string): boolean {
  return doc.appIds.has(tableKey(app));
}

/** (1000 . "글") 등 하나 → 모델 항목 */
function lispToItem(p: Value): XDataItem {
  if (!(p instanceof Cons) || typeof p.car !== 'number') throw bad(p);
  const code = p.car;
  const v = p.cdr;
  const num = () => {
    if (!isNum(v)) throw bad(p);
    return numOf(v);
  };
  switch (code) {
    case 1000:
    case 1003:
      if (typeof v !== 'string' || new TextEncoder().encode(v).length > 255) throw bad(p);
      return { code, value: v };
    case 1002:
      if (v !== '{' && v !== '}') throw bad(p);
      return { code, value: v };
    case 1004: {
      const b = typeof v === 'string' ? fromHex(v) : null;
      if (!b || b.length > 127) throw bad(p);
      return { code, value: b };
    }
    case 1005: {
      const h = v instanceof Ename ? v.handle : typeof v === 'string' && /^[0-9a-f]{1,16}$/i.test(v.trim()) ? v.trim().toUpperCase() : null;
      if (h === null) throw bad(p);
      return { code, value: h };
    }
    case 1010:
    case 1011:
    case 1012:
    case 1013: {
      const a = toArray(v);
      if (!a || a.length < 2 || a.length > 3 || !a.every(isNum)) throw bad(p);
      return { code, value: { x: numOf(a[0] as number), y: numOf(a[1] as number), z: a.length === 3 ? numOf(a[2] as number) : 0 } };
    }
    case 1040:
    case 1041:
    case 1042:
      return { code, value: num() };
    case 1070: {
      const n = num();
      if (!Number.isInteger(n) || n < -32768 || n > 32767) throw bad(p);
      return { code, value: n };
    }
    case 1071: {
      const n = num();
      if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) throw bad(p);
      return { code, value: n };
    }
    default:
      throw bad(p);
  }
}

/**
 * (-3 ("APP" …) …)의 cdr → 앱별 확장 데이터(앱 이름 순서 그대로). { } 짝이 맞지 않거나 값이 틀리면 오류.
 * 등록하지 않은 앱이면 unregistered에 넣는다(부른 쪽이 실패로 처리한다).
 */
export function readXData(doc: CadDocument, v: Value): { list: XData[]; unregistered: string[] } {
  const apps = toArray(v);
  if (!apps) throw bad(new Cons(-3, v));
  const list: XData[] = [];
  const unregistered: string[] = [];
  for (const a of apps) {
    const items = a instanceof Cons ? toArray(a.cdr) : null;
    if (!(a instanceof Cons) || typeof a.car !== 'string' || !items) throw bad(a);
    const name = a.car;
    if (!appRegistered(doc, name)) unregistered.push(name);
    const out = items.map(lispToItem);
    let depth = 0;
    for (const it of out) {
      if (it.code !== 1002) continue;
      depth += it.value === '{' ? 1 : -1;
      if (depth < 0) throw bad(a);
    }
    if (depth !== 0) throw bad(a);
    const reg = doc.appIds.get(tableKey(name));
    list.push({ app: reg?.name ?? name, items: out });
  }
  return { list, unregistered };
}

/** 앱별로 바꾼다(빈 항목이면 그 앱을 지운다). 결과가 비면 undefined */
export function mergeXData(old: readonly XData[] | undefined, upd: readonly XData[]): XData[] | undefined {
  const out = (old ?? []).map((x) => ({ app: x.app, items: [...x.items] }));
  for (const u of upd) {
    const i = out.findIndex((x) => tableKey(x.app) === tableKey(u.app));
    if (!u.items.length) {
      if (i >= 0) out.splice(i, 1);
    } else if (i >= 0) out[i] = { app: out[i]!.app, items: [...u.items] };
    else out.push({ app: u.app, items: [...u.items] });
  }
  return out.length ? out : undefined;
}

/** 확장 데이터 크기(DWG EED 크기로 센다: 앱마다 머리 4바이트, 항목마다 코드 1바이트 + 값) */
export function xdataSize(xs: readonly XData[]): number {
  let n = 0;
  for (const x of xs) {
    n += 4;
    for (const it of x.items) {
      n += 1;
      const v = it.value;
      switch (true) {
        case it.code === 1000:
          n += 3 + new TextEncoder().encode(String(v)).length;
          break;
        case it.code === 1002:
          n += 1;
          break;
        case it.code === 1003 || it.code === 1005:
          n += 8;
          break;
        case it.code === 1004:
          n += 1 + (v instanceof Uint8Array ? v.length : 0);
          break;
        case it.code >= 1010 && it.code <= 1013:
          n += 24;
          break;
        case it.code >= 1040 && it.code <= 1042:
          n += 8;
          break;
        case it.code === 1070:
          n += 2;
          break;
        case it.code === 1071:
          n += 4;
          break;
        default:
          n += 8;
      }
    }
  }
  return n;
}

/** xdsize 인자: (-3 ("APP" …)), ((-3 …)) 또는 ("APP" …) 꼴 */
export function xdsizeArg(doc: CadDocument, v: Value): XData[] {
  if (v instanceof Cons && v.car === -3) return readXData(doc, v.cdr).list;
  const a = toArray(v);
  if (a && a.length && a[0] instanceof Cons && a[0].car === -3) return readXData(doc, a[0].cdr).list;
  if (v instanceof Cons && typeof v.car === 'string') return readXData(doc, fromArray([v])).list;
  return readXData(doc, v).list;
}

// --------------------------------------------------------------------------- 비도형 객체

/** entmakex로 만들었거나 dictremove로 뺀 객체(도면 밖, 이 세션에만) */
const detachedStore = new WeakMap<object, Map<string, CadObject>>();

function detached(doc: CadDocument): Map<string, CadObject> {
  let m = detachedStore.get(doc);
  if (!m) {
    m = new Map();
    detachedStore.set(doc, m);
  }
  return m;
}

/** 도면(또는 도면 밖)의 비도형 객체 */
export function objectOf(doc: CadDocument, h: string): CadObject | undefined {
  return doc.objects.get(h) ?? doc.objects.get(normalizeHandle(h)) ?? detached(doc).get(normalizeHandle(h));
}

/** 도면 안의 객체인가(도면 밖이면 false) */
function inDoc(doc: CadDocument, h: string): boolean {
  return doc.objects.has(h) || doc.objects.has(normalizeHandle(h));
}

const isDict = (o: CadObject | undefined): o is DictionaryObject => o?.type === 'DICTIONARY' || o?.type === 'ACDBDICTIONARYWDFLT';

/** 사전 항목(이름 순, 대소문자 무시) */
export function dictItems(o: DictionaryObject): [string, string][] {
  return [...o.entries].sort((a, b) => (a[0].toUpperCase() < b[0].toUpperCase() ? -1 : a[0].toUpperCase() > b[0].toUpperCase() ? 1 : 0));
}

function dictFind(o: DictionaryObject, name: string): [string, string] | null {
  for (const [k, h] of o.entries) if (k.toUpperCase() === name.toUpperCase()) return [k, h];
  return null;
}

/** 이름 있는 객체 사전(루트) 핸들 */
export function rootDictHandle(doc: CadDocument): string | null {
  if (!doc.rootDictionary) return null;
  const o = objectOf(doc, doc.rootDictionary);
  return isDict(o) ? o.handle : null;
}

const isPointX = (c: number): boolean => (c >= 10 && c <= 18) || (c >= 110 && c <= 112) || c === 210 || (c >= 1010 && c <= 1013);
const isEnameCode = (c: number): boolean => (c >= 330 && c <= 369) || (c >= 390 && c <= 399) || (c >= 480 && c <= 481);
const isStrCode = (c: number): boolean => (c >= 0 && c <= 9) || c === 100 || c === 102 || c === 105 || (c >= 300 && c <= 309) || (c >= 310 && c <= 329) || (c >= 410 && c <= 419) || (c >= 430 && c <= 439) || (c >= 470 && c <= 479) || c === 999 || (c >= 1000 && c <= 1009);
const isRealCode = (c: number): boolean => (c >= 10 && c <= 59) || (c >= 110 && c <= 149) || (c >= 210 && c <= 239) || (c >= 460 && c <= 469) || (c >= 1010 && c <= 1059);

/** XRECORD 자료 태그 → 목록 쌍(점은 하나로, 객체 핸들은 이름으로) */
function rawToPairs(it: Interp, tags: readonly RawTag[]): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]!;
    const c = t.code;
    if (isPointX(c)) {
      const s = String(t.value);
      if (s.includes(',')) {
        const [x, y, z] = s.split(',').map(Number);
        out.push([c, P3(x || 0, y || 0, z || 0)]);
        continue;
      }
      let y = 0;
      let z = 0;
      if (tags[i + 1]?.code === c + 10) y = Number(tags[++i]!.value) || 0;
      if (tags[i + 1]?.code === c + 20) z = Number(tags[++i]!.value) || 0;
      out.push([c, P3(Number(t.value) || 0, y, z)]);
      continue;
    }
    if (isEnameCode(c)) out.push([c, it.ename(normalizeHandle(String(t.value)))]);
    else if (isStrCode(c)) out.push([c, String(t.value)]);
    else if (isRealCode(c)) out.push([c, R(Number(t.value))]);
    else out.push([c, Math.trunc(Number(t.value)) | 0]);
  }
  return out;
}

/** 목록 쌍 → XRECORD 자료 태그(점은 X·Y·Z 코드로 나눈다) */
function pairsToRaw(pairs: readonly Pair[]): RawTag[] {
  const out: RawTag[] = [];
  for (const [c, v] of pairs) {
    if (v instanceof Ename) out.push({ code: c, value: v.handle });
    else if (typeof v === 'string') out.push({ code: c, value: v });
    else if (isNum(v)) out.push({ code: c, value: numOf(v) });
    else {
      const a = toArray(v);
      if (!a || a.length < 2 || a.length > 3 || !a.every(isNum)) throw bad(new Cons(c, v));
      out.push({ code: c, value: numOf(a[0] as number) }, { code: c + 10, value: numOf(a[1] as number) });
      if (a.length === 3 || isPointX(c)) out.push({ code: c + 20, value: a.length === 3 ? numOf(a[2] as number) : 0 });
    }
  }
  return out;
}

/** 머리 그룹(-1 0 5 102 330) */
function objectHead(it: Interp, o: CadObject | TableRecordBase & { type?: string }, type: string, owner: string | undefined): Pair[] {
  const out: Pair[] = [
    [-1, it.ename(o.handle)],
    [0, type],
    [5, o.handle],
  ];
  const reactors = (o as CadObject).reactors;
  if (reactors?.length) {
    out.push([102, '{ACAD_REACTORS']);
    for (const r of reactors) out.push([330, it.ename(normalizeHandle(r))]);
    out.push([102, '}']);
  }
  if (o.xdict) out.push([102, '{ACAD_XDICTIONARY'], [360, it.ename(normalizeHandle(o.xdict))], [102, '}']);
  if (owner) out.push([330, it.ename(normalizeHandle(owner))]);
  return out;
}

/** 비도형 객체 → 그룹 목록 */
export function objectGroups(it: Interp, doc: CadDocument, h: string): Pair[] | null {
  const o = objectOf(doc, h);
  if (!o) return null;
  const out = objectHead(it, o, o.type, o.owner);
  switch (o.type) {
    case 'DICTIONARY':
    case 'ACDBDICTIONARYWDFLT': {
      const d = o as DictionaryObject;
      out.push([100, 'AcDbDictionary'], [280, d.hardOwner ? 1 : 0], [281, d.cloning]);
      for (const [k, v] of dictItems(d)) out.push([3, k], [d.hardOwner ? 360 : 350, it.ename(normalizeHandle(v))]);
      if (o.type === 'ACDBDICTIONARYWDFLT') {
        out.push([100, 'AcDbDictionaryWithDefault']);
        if (d.defaultHandle) out.push([340, it.ename(normalizeHandle(d.defaultHandle))]);
      }
      break;
    }
    case 'XRECORD': {
      const x = o as XRecordObject;
      out.push([100, 'AcDbXrecord'], [280, x.cloning ?? 1], ...rawToPairs(it, x.data));
      break;
    }
    case 'GROUP': {
      const g = o as GroupObject;
      out.push([100, 'AcDbGroup'], [300, g.description], [70, g.unnamed ? 1 : 0], [71, g.selectable ? 1 : 0]);
      for (const e of g.entities) out.push([340, it.ename(normalizeHandle(e))]);
      break;
    }
    case 'LAYOUT': {
      const l = (o as LayoutObject).layout;
      out.push([100, 'AcDbPlotSettings'], [1, l.plot.pageSetupName], [100, 'AcDbLayout'], [1, l.name], [70, l.flags], [71, l.tabOrder]);
      out.push([10, fromArray([R(l.limitsMin.x), R(l.limitsMin.y)])], [11, fromArray([R(l.limitsMax.x), R(l.limitsMax.y)])]);
      if (l.blockRecord) out.push([330, it.ename(normalizeHandle(l.blockRecord))]);
      break;
    }
    default: {
      // 해석하지 않은 객체는 원본 태그가 있으면 그대로
      const raw = (o as GenericObject).raw;
      if (raw?.length) out.push(...rawToPairs(it, raw));
      break;
    }
  }
  return out;
}

/** 그 사전의 이름 항목 객체 핸들 */
export function dictLookup(doc: CadDocument, dictH: string, name: string): string | null {
  const o = objectOf(doc, dictH);
  if (!isDict(o)) return null;
  const e = dictFind(o, name);
  return e ? normalizeHandle(e[1]) : null;
}

/** 사전 항목 차례(dictnext): 사전 핸들 → 다음 자리 */
export class DictCursor {
  private readonly at = new Map<string, number>();

  next(doc: CadDocument, dictH: string, rewind: boolean): string | null {
    const o = objectOf(doc, dictH);
    if (!isDict(o)) return null;
    const items = dictItems(o);
    const k = normalizeHandle(o.handle);
    const i = rewind ? 0 : (this.at.get(k) ?? 0);
    if (i >= items.length) return null;
    this.at.set(k, i + 1);
    return normalizeHandle(items[i]![1]);
  }

  /** dictsearch의 setnext: 찾은 항목 다음부터 */
  after(doc: CadDocument, dictH: string, name: string): void {
    const o = objectOf(doc, dictH);
    if (!isDict(o)) return;
    const i = dictItems(o).findIndex(([n]) => n.toUpperCase() === name.toUpperCase());
    if (i >= 0) this.at.set(normalizeHandle(o.handle), i + 1);
  }
}

/** 객체와 그 아래(사전이면 항목들) 모두 */
function subtree(doc: CadDocument, h: string, out = new Map<string, CadObject>()): Map<string, CadObject> {
  const o = objectOf(doc, h);
  if (!o || out.has(normalizeHandle(o.handle))) return out;
  out.set(normalizeHandle(o.handle), o);
  if (isDict(o))
    for (const c of o.entries.values()) {
      const child = objectOf(doc, c);
      if (child && child.owner && normalizeHandle(child.owner) === normalizeHandle(o.handle)) subtree(doc, c, out);
    }
  if (o.xdict) subtree(doc, o.xdict, out);
  return out;
}

/** dictadd: 주인 없는 객체를 사전에 넣는다. 넣었으면 true */
export function dictAdd(d: LispDrawing, dictH: string, name: string, objH: string): boolean {
  const doc = d.doc;
  const dict = objectOf(doc, dictH);
  if (!isDict(dict) || !inDoc(doc, dict.handle)) return false;
  if (!name || dictFind(dict, name)) return false;
  const obj = objectOf(doc, objH);
  if (!obj) return false;
  const det = detached(doc);
  const key = normalizeHandle(obj.handle);
  // 도면 안의 객체는 이미 주인이 있다(다른 사전에서 빼고 넣어야 한다)
  if (inDoc(doc, obj.handle)) return false;
  const ops: EditOp[] = [];
  const tree = subtree(doc, key);
  for (const [h, o] of tree) {
    const after = h === key ? { ...o, owner: dict.handle, reactors: [dict.handle] } : o;
    ops.push({ kind: 'object', key: o.handle, before: null, after });
  }
  const entries = new Map(dict.entries);
  entries.set(name, obj.handle);
  ops.push({ kind: 'object', key: dict.handle, before: dict, after: { ...dict, entries } });
  d.commit(ops, 'DICTADD');
  for (const h of tree.keys()) det.delete(h);
  return true;
}

/** dictremove: 항목을 빼고 그 객체를 도면 밖으로. 뺀 객체 핸들(없으면 null) */
export function dictRemove(d: LispDrawing, dictH: string, name: string): string | null {
  const doc = d.doc;
  const dict = objectOf(doc, dictH);
  if (!isDict(dict) || !inDoc(doc, dict.handle)) return null;
  const e = dictFind(dict, name);
  if (!e) return null;
  const entries = new Map(dict.entries);
  entries.delete(e[0]);
  const ops: EditOp[] = [{ kind: 'object', key: dict.handle, before: dict, after: { ...dict, entries } }];
  const objH = normalizeHandle(e[1]);
  const obj = objectOf(doc, objH);
  const owned = obj && obj.owner && normalizeHandle(obj.owner) === normalizeHandle(dict.handle) && inDoc(doc, obj.handle);
  const tree = owned ? subtree(doc, objH) : new Map<string, CadObject>();
  for (const o of tree.values()) ops.push({ kind: 'object', key: o.handle, before: o, after: null });
  d.commit(ops, 'DICTREMOVE');
  const det = detached(doc);
  for (const [h, o] of tree) det.set(h, h === objH ? { ...o, owner: undefined, reactors: undefined } : o);
  return objH;
}

/** dictrename: 항목 이름 바꾸기. 바꿨으면 true */
export function dictRename(d: LispDrawing, dictH: string, oldName: string, newName: string): boolean {
  const doc = d.doc;
  const dict = objectOf(doc, dictH);
  if (!isDict(dict) || !inDoc(doc, dict.handle) || !newName) return false;
  const e = dictFind(dict, oldName);
  if (!e) return false;
  const clash = dictFind(dict, newName);
  if (clash && clash[0] !== e[0]) return false;
  const entries = new Map<string, string>();
  for (const [k, v] of dict.entries) entries.set(k === e[0] ? newName : k, v);
  d.commit([{ kind: 'object', key: dict.handle, before: dict, after: { ...dict, entries } }], 'DICTRENAME');
  return true;
}

/** 목록에서 객체 자료 부분(XRECORD 자료: AcDbXrecord 다음, 280은 복제 플래그) */
function xrecordData(pairs: readonly Pair[]): { cloning: number | undefined; data: Pair[] } {
  const i = pairs.findIndex(([c, v]) => c === 100 && typeof v === 'string' && v.toUpperCase() === 'ACDBXRECORD');
  let rest: Pair[];
  if (i >= 0) rest = pairs.slice(i + 1);
  else {
    // 머리 그룹(-1 0 5 102…102 330)을 빼고 나머지
    rest = [];
    let inGroup = false;
    let ownerSeen = false;
    for (const p of pairs) {
      const [c, v] = p;
      if (c === 102) {
        inGroup = typeof v === 'string' && v.startsWith('{');
        continue;
      }
      if (inGroup || c === -1 || c === 0 || c === 5 || c === 100) continue;
      if (c === 330 && !ownerSeen) {
        ownerSeen = true;
        continue;
      }
      rest.push(p);
    }
  }
  let cloning: number | undefined;
  if (i >= 0 && rest[0]?.[0] === 280 && typeof rest[0][1] === 'number') {
    cloning = rest[0][1];
    rest = rest.slice(1);
  }
  return { cloning, data: rest };
}

/**
 * entmake·entmakex의 비도형 객체(XRECORD·DICTIONARY). 주인 없이 도면 밖에 만든다(dictadd로 넣는다).
 * 만든 객체 핸들(이 종류가 아니면 undefined)
 */
export function makeObject(d: LispDrawing, type: string, pairs: readonly Pair[]): string | undefined {
  const h = d.session.newHandle();
  let o: CadObject;
  if (type === 'XRECORD') {
    const { cloning, data } = xrecordData(pairs);
    o = { type: 'XRECORD', handle: h, cloning: cloning ?? 1, data: pairsToRaw(data) };
  } else if (type === 'DICTIONARY') {
    const hard = pairs.find(([c]) => c === 280)?.[1];
    const clone = pairs.find(([c]) => c === 281)?.[1];
    o = { type: 'DICTIONARY', handle: h, entries: new Map(), hardOwner: hard === 1, cloning: typeof clone === 'number' ? clone : 1 };
  } else return undefined;
  const xd = pairs.find(([c]) => c === -3);
  if (xd) {
    const { list, unregistered } = readXData(d.doc, xd[1]);
    if (unregistered.length) return '';
    o.xdata = mergeXData(undefined, list);
  }
  detached(d.doc).set(normalizeHandle(h), o);
  return h;
}

/** entmod의 비도형 객체: XRECORD 자료·사전 복제 플래그·확장 데이터. 바꿨으면 true, 처리할 수 없으면 false */
export function modObject(d: LispDrawing, h: string, pairs: readonly Pair[]): boolean {
  const doc = d.doc;
  const o = objectOf(doc, h);
  if (!o) return false;
  let after: CadObject;
  if (o.type === 'XRECORD') {
    const { cloning, data } = xrecordData(pairs);
    after = { ...(o as XRecordObject), cloning: cloning ?? (o as XRecordObject).cloning, data: pairsToRaw(data) };
  } else if (isDict(o)) {
    const clone = pairs.find(([c]) => c === 281)?.[1];
    after = { ...o, cloning: typeof clone === 'number' ? clone : o.cloning };
  } else after = { ...o };
  const xd = pairs.find(([c]) => c === -3);
  if (xd) {
    const { list, unregistered } = readXData(doc, xd[1]);
    if (unregistered.length) return false;
    after.xdata = mergeXData(o.xdata, list);
  }
  if (!inDoc(doc, o.handle)) {
    detached(doc).set(normalizeHandle(o.handle), after);
    return true;
  }
  d.commit([{ kind: 'object', key: o.handle, before: o, after }], 'ENTMOD');
  return true;
}

// --------------------------------------------------------------------------- 표 기록

export interface TableEntry {
  name: string;
  handle: string;
  /** (0 . 표) 뒤의 그룹 */
  fields: () => Pair[];
  record: TableRecordBase;
}

const TABLE_CLASS: Record<string, string> = {
  LAYER: 'AcDbLayerTableRecord',
  LTYPE: 'AcDbLinetypeTableRecord',
  STYLE: 'AcDbTextStyleTableRecord',
  DIMSTYLE: 'AcDbDimStyleTableRecord',
  VIEW: 'AcDbViewTableRecord',
  UCS: 'AcDbUCSTableRecord',
  APPID: 'AcDbRegAppTableRecord',
  VPORT: 'AcDbViewportTableRecord',
  BLOCK_RECORD: 'AcDbBlockTableRecord',
};

/** 표 이름 → 기록들(tblsearch·tblnext·entget이 함께 쓴다). 모르는 표면 null */
export function tableEntries(it: Interp, doc: CadDocument, table: string): TableEntry[] | null {
  const pt3 = (v: { x: number; y: number; z?: number }) => P3(v.x, v.y, v.z ?? 0);
  switch (table) {
    case 'LAYER':
      return [...doc.layers.values()].map((l) => ({
        name: l.name,
        handle: l.handle,
        record: l,
        fields: () => [
          [2, l.name],
          [70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0)],
          [62, l.off ? -Math.abs(l.color.aci) : Math.abs(l.color.aci)],
          [6, l.linetype],
          [290, l.plot ? 1 : 0],
          [370, l.lineweight],
        ],
      }));
    case 'LTYPE':
      return [...doc.linetypes.values()].map((l) => ({
        name: l.name,
        handle: l.handle,
        record: l,
        fields: () => [[2, l.name], [70, l.flags], [3, l.description], [72, 65], [73, l.elements.length], [40, R(l.patternLength)], ...l.elements.map((e) => [49, R(e.length)] as Pair)],
      }));
    case 'STYLE':
      return [...doc.textStyles.values()].map((s) => ({
        name: s.name,
        handle: s.handle,
        record: s,
        fields: () => [
          [2, s.name],
          [70, s.flags],
          [40, R(s.height)],
          [41, R(s.widthFactor)],
          [50, R(s.oblique)],
          [71, s.generation],
          [42, R(s.lastHeight)],
          [3, s.font],
          [4, s.bigFont],
        ],
      }));
    case 'BLOCK':
      return [...doc.blocks.values()]
        .filter((b) => !/^\*(MODEL|PAPER)_SPACE/i.test(b.name))
        .map((b) => ({
          name: b.name,
          handle: b.handle,
          record: { name: b.name, handle: b.handle, flags: b.flags },
          fields: () => {
            const first = b.entities.find((e) => e.handle);
            return [[2, b.name], [70, b.flags], [10, pt3(b.basePoint)], ...(first ? [[-2, it.ename(first.handle)] as Pair] : [])];
          },
        }));
    case 'BLOCK_RECORD':
      return [...doc.blockRecords.values()].map((r) => ({
        name: r.name,
        handle: r.handle,
        record: r,
        fields: () => [[2, r.name], ...(r.layout ? [[340, it.ename(normalizeHandle(r.layout))] as Pair] : []), [70, r.insertUnits], [280, r.explodable ? 1 : 0], [281, r.scalable ? 1 : 0]],
      }));
    case 'DIMSTYLE':
    case 'VIEW':
    case 'UCS':
    case 'APPID': {
      const m = table === 'DIMSTYLE' ? doc.dimStyles : table === 'VIEW' ? doc.views : table === 'UCS' ? doc.ucs : doc.appIds;
      return [...m.values()].map((r) => ({
        name: r.name,
        handle: r.handle,
        record: r,
        fields: () => {
          const out: Pair[] = [
            [2, r.name],
            [70, r.flags],
          ];
          if (table === 'VIEW') {
            const v = doc.views.get(tableKey(r.name))!;
            out.push([40, R(v.height)], [10, fromArray([R(v.center.x), R(v.center.y)])], [41, R(v.width)], [11, pt3(v.viewDirection)], [12, pt3(v.viewTarget)], [50, R(v.twist)]);
          } else if (table === 'UCS') {
            const u = doc.ucs.get(tableKey(r.name))!;
            out.push([10, pt3(u.origin)], [11, pt3(u.xAxis)], [12, pt3(u.yAxis)]);
          }
          return out;
        },
      }));
    }
    case 'VPORT':
      return doc.vports.map((r) => ({
        name: r.name,
        handle: r.handle,
        record: r,
        fields: () => [
          [2, r.name],
          [70, r.flags],
          [10, fromArray([R(r.lowerLeft.x), R(r.lowerLeft.y)])],
          [11, fromArray([R(r.upperRight.x), R(r.upperRight.y)])],
          [12, fromArray([R(r.center.x), R(r.center.y)])],
          [40, R(r.height)],
          [41, R(r.aspect)],
        ],
      }));
    default:
      return null;
  }
}

const TABLES = ['LAYER', 'LTYPE', 'STYLE', 'DIMSTYLE', 'VIEW', 'UCS', 'APPID', 'VPORT', 'BLOCK_RECORD', 'BLOCK'];

/** 핸들의 표 기록(표 이름과 기록). 없으면 null */
export function findTableRecord(it: Interp, doc: CadDocument, h: string): { table: string; entry: TableEntry } | null {
  const k = normalizeHandle(h);
  for (const t of TABLES) {
    const e = tableEntries(it, doc, t)!.find((x) => x.handle && normalizeHandle(x.handle) === k);
    if (e) return { table: t, entry: e };
  }
  return null;
}

/** 표 기록(또는 블록 머리) → entget 목록 */
export function tableRecordGroups(it: Interp, doc: CadDocument, h: string): Pair[] | null {
  const hit = findTableRecord(it, doc, h);
  if (!hit) return null;
  const { table, entry } = hit;
  if (table === 'BLOCK') {
    const b = doc.blocks.get(tableKey(entry.name)) as BlockDef;
    const fields = entry.fields();
    const out: Pair[] = [
      [-1, it.ename(entry.handle)],
      [0, 'BLOCK'],
    ];
    if (b.recordHandle) out.push([330, it.ename(normalizeHandle(b.recordHandle))]);
    out.push([5, entry.handle], [100, 'AcDbEntity'], [8, b.layer ?? '0'], [100, 'AcDbBlockBegin'], [70, b.flags], fields.find(([c]) => c === 10)!);
    const first = fields.find(([c]) => c === -2);
    if (first) out.push(first);
    out.push([2, b.name], [1, b.xrefPath ?? '']);
    return out;
  }
  const head = doc.tableHeads?.get(table === 'BLOCK_RECORD' ? 'BLOCK_RECORD' : table)?.handle;
  const out: Pair[] = [
    [-1, it.ename(entry.handle)],
    [0, table],
  ];
  if (head) out.push([330, it.ename(normalizeHandle(head))]);
  out.push([5, entry.handle], [100, 'AcDbSymbolTableRecord'], [100, TABLE_CLASS[table] ?? 'AcDbSymbolTableRecord'], ...entry.fields());
  return out;
}

/** tblobjname: 표 기록 핸들(BLOCK은 블록 머리) */
export function tableObjHandle(it: Interp, doc: CadDocument, table: string, name: string): string | null {
  const list = tableEntries(it, doc, table);
  if (!list) return null;
  return list.find((x) => tableKey(x.name) === tableKey(name))?.handle || null;
}

/** 표 기록의 확장 데이터(entget -3) */
export function recordXData(it: Interp, doc: CadDocument, h: string): XData[] | undefined {
  return findTableRecord(it, doc, h)?.entry.record.xdata;
}

/** entmod의 LAYER 기록. 바꿨으면 true */
export function modLayer(it: Interp, d: LispDrawing, h: string, pairs: readonly Pair[]): boolean {
  const hit = findTableRecord(it, d.doc, h);
  if (!hit || hit.table !== 'LAYER') return false;
  const before = hit.entry.record as Layer;
  const after: Layer = { ...before, color: { ...before.color } };
  for (const [c, v] of pairs) {
    switch (c) {
      case 62: {
        if (typeof v !== 'number' || v === 0 || Math.abs(v) > 255) throw bad(new Cons(c, v));
        after.color = { aci: Math.abs(v) };
        after.off = v < 0;
        break;
      }
      case 6: {
        if (typeof v !== 'string') throw bad(new Cons(c, v));
        if (!/^continuous$/i.test(v) && !d.doc.linetypes.has(tableKey(v))) return false;
        after.linetype = d.doc.linetypes.get(tableKey(v))?.name ?? v;
        break;
      }
      case 70:
        if (typeof v !== 'number') throw bad(new Cons(c, v));
        after.frozen = (v & 1) !== 0;
        after.locked = (v & 4) !== 0;
        break;
      case 370:
        if (typeof v !== 'number') throw bad(new Cons(c, v));
        after.lineweight = v;
        break;
      case 290:
        after.plot = v !== 0;
        break;
      case -3: {
        const { list, unregistered } = readXData(d.doc, v);
        if (unregistered.length) return false;
        after.xdata = mergeXData(before.xdata, list);
        break;
      }
      default:
        break;
    }
  }
  d.commit([{ kind: 'layer', key: tableKey(before.name), before, after }], 'ENTMOD');
  return true;
}

/** regapp: 앱 이름 등록. 새로 등록했으면 true(이미 있거나 이름이 틀리면 false) */
export function regApp(d: LispDrawing, name: string): boolean {
  const n = name.trim();
  if (!n || n.length > 255 || /[<>/\\":;?*|,=`]/.test(n) || appRegistered(d.doc, n)) return false;
  // APPID 표는 편집 기록이 없다: 도면 문서에 바로 넣는다(저장할 때 확장 데이터가 쓰는 앱은 어차피 APPID로 쓴다)
  d.doc.appIds.set(tableKey(n), { name: n, handle: d.session.newHandle(), flags: 0 });
  return true;
}
