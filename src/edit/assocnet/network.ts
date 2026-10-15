/**
 * 도면의 연관 망 찾기와 해석 캐시.
 *
 * 구조(표본으로 확인):
 *  - 이름 있는 객체 사전 → "ACAD_ASSOCNETWORK" 사전 → 최상위 ACDBASSOCNETWORK(동작 목록에 블록 망을 330 참조로 둔다).
 *  - 블록 레코드(모형 공간·블록)의 확장 사전 → "ACAD_ASSOCNETWORK" 사전 → 그 블록의 ACDBASSOCNETWORK
 *    (소유 망 330 = 최상위 망, 동작 목록에 구속 그룹·변수·배열 동작을 360 소유로 둔다).
 * 원본 태그는 바뀔 때마다 새 객체로 바뀌므로(편집 작업은 객체를 바꿔 끼운다) 객체를 열쇠로 해석을 캐시한다.
 */
import type { CadDocument, CadObject, DictionaryObject, GenericObject } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import { type CGroupData, tryParseGroupRest, unknownNodeClasses } from './cgroup';
import { type AssocObjectData, tryParseAssocObject } from './objects';

const parsed = new WeakMap<object, AssocObjectData | null>();
const groups = new WeakMap<object, CGroupData | null>();

export function objectOf(doc: CadDocument, h: string | undefined): GenericObject | undefined {
  if (!h) return undefined;
  return doc.objects.get(normalizeHandle(h)) as GenericObject | undefined;
}

/** 객체의 해석(원본 태그가 없거나 모르는 꼴이면 null) */
export function assocData(o: CadObject | undefined): AssocObjectData | null {
  if (!o) return null;
  const g = o as GenericObject;
  if (!g.raw?.length) return null;
  if (parsed.has(g)) return parsed.get(g)!;
  const d = tryParseAssocObject(o.type, g.raw);
  parsed.set(g, d);
  return d;
}

/** 구속 그룹 객체의 노드 그래프(풀 수 없으면 null) */
export function groupData(o: CadObject | undefined): CGroupData | null {
  if (!o || o.type.toUpperCase() !== 'ACDBASSOC2DCONSTRAINTGROUP') return null;
  if (groups.has(o)) return groups.get(o)!;
  const d = assocData(o);
  const g = d?.kind === 'cgroup' ? tryParseGroupRest(d.head.version, d.rest) : null;
  groups.set(o, g);
  return g;
}

/** 풀지 못한 구속 그룹의 모르는 노드 클래스 */
export function groupUnknownClasses(o: CadObject): string[] {
  const d = assocData(o);
  return d?.kind === 'cgroup' ? unknownNodeClasses(d.head.version, d.rest) : [];
}

function isDict(o: CadObject | undefined): o is DictionaryObject {
  return !!o && (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT');
}

/** 사전에서 이름으로 찾기(대소문자 무시) */
export function dictEntry(d: DictionaryObject | undefined, name: string): string | undefined {
  if (!d) return undefined;
  const k = name.toUpperCase();
  for (const [n, h] of d.entries) if (n.toUpperCase() === k) return normalizeHandle(h);
  return undefined;
}

/** 최상위 망(루트 사전 → ACAD_ASSOCNETWORK → ACAD_ASSOCNETWORK) */
export function rootNetwork(doc: CadDocument): { dict: DictionaryObject; network: GenericObject } | null {
  const root = doc.rootDictionary ? doc.objects.get(normalizeHandle(doc.rootDictionary)) : undefined;
  if (!isDict(root)) return null;
  const dh = dictEntry(root, 'ACAD_ASSOCNETWORK');
  const dict = dh ? doc.objects.get(dh) : undefined;
  if (!isDict(dict)) return null;
  const nh = dictEntry(dict, 'ACAD_ASSOCNETWORK');
  const net = nh ? (doc.objects.get(nh) as GenericObject | undefined) : undefined;
  return net && net.type.toUpperCase() === 'ACDBASSOCNETWORK' ? { dict, network: net } : null;
}

/** 블록 레코드의 망(확장 사전 → ACAD_ASSOCNETWORK → ACAD_ASSOCNETWORK) */
export function blockNetwork(doc: CadDocument, recordHandle: string): { xdict: DictionaryObject; dict: DictionaryObject; network: GenericObject } | null {
  const rh = normalizeHandle(recordHandle);
  let xd: string | undefined;
  for (const r of doc.blockRecords.values()) if (normalizeHandle(r.handle) === rh) xd = r.xdict;
  const xdict = xd ? doc.objects.get(normalizeHandle(xd)) : undefined;
  if (!isDict(xdict)) return null;
  const dh = dictEntry(xdict, 'ACAD_ASSOCNETWORK');
  const dict = dh ? doc.objects.get(dh) : undefined;
  if (!isDict(dict)) return null;
  const nh = dictEntry(dict, 'ACAD_ASSOCNETWORK');
  const net = nh ? (doc.objects.get(nh) as GenericObject | undefined) : undefined;
  return net && net.type.toUpperCase() === 'ACDBASSOCNETWORK' ? { xdict, dict, network: net } : null;
}

/** 형식 이름이 같은 모든 객체(핸들 순) */
export function objectsOfType(doc: CadDocument, type: string): GenericObject[] {
  const t = type.toUpperCase();
  const out: GenericObject[] = [];
  for (const o of doc.objects.values()) if (o.type.toUpperCase() === t) out.push(o as GenericObject);
  return out.sort((a, b) => parseInt(a.handle, 16) - parseInt(b.handle, 16));
}

/** 엔티티를 담은 블록 키(없으면 null) */
export function blockKeyOf(doc: CadDocument, handle: string): string | null {
  const h = normalizeHandle(handle);
  for (const [k, b] of doc.blocks) if (b.entities.some((e) => e.handle === h)) return k;
  return null;
}
