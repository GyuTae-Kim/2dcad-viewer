/**
 * 동적 블록 참조: 참조가 가리키는 정의, 지금 표현 블록, 지금 값(참조 캐시 또는 정의 기본값).
 *
 * 참조(INSERT)는 정의를 직접 가리키거나(기본값 그대로) 표현 블록 *U<n>을 가리킨다. 표현 블록 레코드의 XDATA
 * AcDbBlockRepBTag(1005)와 참조 확장 사전의 AcDbBlockRepresentation → AcDbRepData(340)가 정의 레코드를 가리킨다.
 * 지금 값은 AcDbBlockRepresentation → AppDataCache → ACAD_ENHANCEDBLOCKDATA의 노드별 XRECORD에 있다.
 */
import type { BlockDef, CadDocument, Entity, GenericObject, InsertEntity, RawTag, Vec3, XRecordObject } from '../../core/model';
import { tableKey } from '../../core/model';
import { BTAG_APP, blockIndices, blockKeyOfRecord, dictEntry, graphHandleOf, readDefinition } from './definition';
import { tagHandle, tagInt, tagNum, tagStr, xdataOf } from './tags';
import type { DynDefinition, DynParam, NodeValue, RefValues, VisibilityParam } from './types';

/** 참조 캐시 객체 위치 */
export interface RefCache {
  /** INSERT 확장 사전 */
  xdict: string;
  /** AcDbBlockRepresentation 사전 */
  rep: string | null;
  repData: string | null;
  appCache: string | null;
  data: string | null;
  hdata: string | null;
  history: string | null;
  /** 노드 id → XRECORD 핸들 */
  records: Map<number, string>;
}

export interface WorkItem {
  /** ETag 색인(정의와 표현 블록이 같은 색인으로 짝을 짓는다) */
  index: number;
  /** 같은 색인의 정의 객체 핸들 */
  defHandle: string | null;
  entity: Entity;
}

export interface DynRef {
  def: DynDefinition;
  defBlock: BlockDef;
  /** 지금 가리키는 블록(정의 또는 표현 블록) */
  block: BlockDef;
  blockKey: string;
  /** 정의를 직접 가리킨다 */
  direct: boolean;
  /** 지금 값(모든 매개변수·동작) */
  values: RefValues;
  cache: RefCache | null;
}

/** 참조가 가리키는 동적 블록 정의의 블록 키(동적 참조가 아니면 null) */
export function definitionKeyOfInsert(doc: CadDocument, ins: InsertEntity): string | null {
  const key = tableKey(ins.block);
  if (graphHandleOf(doc, key)) return key;
  const rec = doc.blockRecords.get(key);
  const bt = xdataOf(rec?.xdata, BTAG_APP)?.find((i) => i.code === 1005)?.value;
  if (bt !== undefined) {
    const k = blockKeyOfRecord(doc, tagHandle(bt as string));
    if (k && graphHandleOf(doc, k)) return k;
  }
  const rd = repDataOf(doc, ins);
  if (rd) {
    const o = doc.objects.get(rd) as GenericObject | undefined;
    const h = o?.raw?.find((t) => t.code === 340)?.value;
    if (h !== undefined) {
      const k = blockKeyOfRecord(doc, tagHandle(h));
      if (k && graphHandleOf(doc, k)) return k;
    }
  }
  return null;
}

function repDataOf(doc: CadDocument, ins: InsertEntity): string | null {
  const rep = dictEntry(doc, ins.xdict, 'AcDbBlockRepresentation');
  return rep ? dictEntry(doc, rep, 'AcDbRepData') : null;
}

export function isDynamicReference(doc: CadDocument, e: Entity | undefined): e is InsertEntity {
  return !!e && e.type === 'INSERT' && definitionKeyOfInsert(doc, e) !== null;
}

/** 캐시 사전들 */
export function readCache(doc: CadDocument, ins: InsertEntity): RefCache | null {
  if (!ins.xdict || !doc.objects.has(ins.xdict.toUpperCase())) return null;
  const xdict = ins.xdict.toUpperCase();
  const rep = dictEntry(doc, xdict, 'AcDbBlockRepresentation');
  const repData = rep ? dictEntry(doc, rep, 'AcDbRepData') : null;
  const appCache = rep ? dictEntry(doc, rep, 'AppDataCache') : null;
  const data = appCache ? dictEntry(doc, appCache, 'ACAD_ENHANCEDBLOCKDATA') : null;
  const hdata = appCache ? dictEntry(doc, appCache, 'ACAD_ENHANCEDBLOCKHDATA') : null;
  const history = appCache ? dictEntry(doc, appCache, 'ACAD_ENHANCEDBLOCKHISTORY') : null;
  const records = new Map<number, string>();
  const d = data ? doc.objects.get(data) : undefined;
  if (d && (d.type === 'DICTIONARY' || d.type === 'ACDBDICTIONARYWDFLT')) {
    for (const [k, h] of (d as { entries: Map<string, string> }).entries) if (/^\d+$/.test(k.trim())) records.set(Number(k.trim()), h.toUpperCase());
  }
  return { xdict, rep, repData, appCache, data, hdata, history, records };
}

/**
 * XRECORD 자료 → 머리(1071, 1071, 70, 70)와 값 태그.
 * DWG 리더는 XRECORD 점을 "x,y,z" 태그 하나로 담는다: DXF처럼 10·20·30 태그로 풀어 둔다(DWG 쓰기는 둘 다 받는다).
 */
export function splitRecord(data: readonly RawTag[]): { header: RawTag[]; body: RawTag[] } {
  const d = unpackPoints(data);
  if (d.length >= 4 && d[0]!.code === 1071 && d[1]!.code === 1071 && d[2]!.code === 70 && d[3]!.code === 70) return { header: d.slice(0, 4), body: d.slice(4) };
  return { header: [], body: d };
}

function unpackPoints(data: readonly RawTag[]): RawTag[] {
  if (!data.some((t) => t.code >= 10 && t.code <= 18 && typeof t.value === 'string' && t.value.includes(','))) return [...data];
  const out: RawTag[] = [];
  for (const t of data) {
    if (t.code >= 10 && t.code <= 18 && typeof t.value === 'string' && t.value.includes(',')) {
      const [x, y, z] = t.value.split(',').map((s) => tagNum(s));
      out.push({ code: t.code, value: x ?? 0 }, { code: t.code + 10, value: y ?? 0 }, { code: t.code + 20, value: z ?? 0 });
    } else out.push(t);
  }
  return out;
}

interface Parsed {
  points: Vec3[];
  strings: string[];
  ints: number[];
  reals: number[];
}

function parseBody(body: readonly RawTag[]): Parsed {
  const out: Parsed = { points: [], strings: [], ints: [], reals: [] };
  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    if (t.code === 10) {
      const y = body[i + 1]?.code === 20 ? tagNum(body[++i]!.value) : 0;
      const z = body[i + 1]?.code === 30 ? tagNum(body[++i]!.value) : 0;
      out.points.push({ x: tagNum(t.value), y, z });
    } else if (t.code === 1) out.strings.push(tagStr(t.value));
    else if (t.code === 70) out.ints.push(tagInt(t.value));
    else if (t.code === 40) out.reals.push(tagNum(t.value));
  }
  return out;
}

const clone3 = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

/** 매개변수의 정의 점 */
export function defaultPoints(p: DynParam): Vec3[] {
  switch (p.kind) {
    case 'visibility':
    case 'lookup':
    case 'point':
    case 'basepoint':
      return [clone3(p.location)];
    case 'alignment':
      return [clone3(p.location), clone3(p.end ?? p.location)];
    case 'rotation':
      return [clone3(p.base), clone3(p.end), clone3(p.baseAngle)];
    default:
      return [clone3(p.base), clone3(p.end)];
  }
}

/** 정의의 기본값 */
export function defaultValues(def: DynDefinition): RefValues {
  const v: RefValues = new Map();
  for (const p of def.params) {
    const nv: NodeValue = { points: defaultPoints(p) };
    if (p.kind === 'flip') nv.flipped = false;
    if (p.kind === 'lookup') nv.value = '';
    if (p.kind === 'visibility') nv.state = p.states[0]?.name ?? '';
    v.set(p.id, nv);
  }
  for (const a of def.actions) {
    if (a.kind === 'move' || a.kind === 'stretch') v.set(a.id, { angle: a.angle });
    else if (a.kind === 'scale' || a.kind === 'rotate') {
      // 종속 기준점: 매개변수의 점(UpdatedBaseX …) + 오프셋
      let base = clone3(a.basePoint);
      if (a.dependent) {
        const x = pointProp(v.get(a.baseX.node)?.points, a.baseX.prop);
        const y = pointProp(v.get(a.baseY.node)?.points, a.baseY.prop);
        if (x !== null && y !== null) base = { x: x + a.offset.x, y: y + a.offset.y, z: 0 };
      }
      v.set(a.id, { base });
    }
  }
  return v;
}

/** 매개변수 점의 좌표 속성(UpdatedBaseX·UpdatedEndY·UpdatedX …) */
export function pointProp(points: readonly Vec3[] | undefined, prop: string): number | null {
  if (!points?.length) return null;
  const k = prop.toLowerCase();
  const p0 = points[0]!;
  const p1 = points[1] ?? p0;
  if (k === 'updatedbasex' || k === 'updatedx' || k === 'basex') return p0.x;
  if (k === 'updatedbasey' || k === 'updatedy' || k === 'basey') return p0.y;
  if (k === 'updatedendx' || k === 'endx') return p1.x;
  if (k === 'updatedendy' || k === 'endy') return p1.y;
  return null;
}

/** 블록 객체와 정의 객체 짝 */
export function workItems(def: DynDefinition, block: BlockDef, direct: boolean): WorkItem[] {
  const idx = blockIndices(block);
  return block.entities.map((e, i) => ({
    index: idx[i]!,
    defHandle: direct ? e.handle.toUpperCase() : (def.handleAt.get(idx[i]!) ?? null),
    entity: e,
  }));
}

/**
 * 보이는 객체로 가시성 상태를 정한다. 같은 객체를 보이는 상태가 여럿이면 캐시의 이름이 그 가운데 있을 때 그것,
 * 아니면 첫 상태. 맞는 상태가 없으면 캐시 이름(정의에 있을 때), 그것도 없으면 첫 상태.
 */
export function visibleState(p: VisibilityParam, items: readonly WorkItem[], cached: string | undefined): string {
  const byDef = new Map<string, WorkItem>();
  for (const it of items) if (it.defHandle) byDef.set(it.defHandle, it);
  const governed = p.entities.filter((h) => byDef.has(h));
  const shown = new Set(governed.filter((h) => !byDef.get(h)!.entity.invisible));
  const matches = p.states.filter((s) => {
    const want = new Set(s.entities.filter((h) => byDef.has(h)));
    if (want.size !== shown.size) return false;
    for (const h of want) if (!shown.has(h)) return false;
    return true;
  });
  const named = (n: string | undefined) => (n !== undefined ? p.states.find((s) => s.name === n) : undefined);
  if (matches.length) return (matches.find((s) => s.name === cached) ?? matches[0]!).name;
  return (named(cached) ?? p.states[0])?.name ?? '';
}

function siblingCache(doc: CadDocument, ins: InsertEntity, blockKey: string): RefCache | null {
  for (const b of doc.blocks.values())
    for (const e of b.entities) {
      if (e.type !== 'INSERT' || e === ins || e.handle === ins.handle || !e.xdict || tableKey(e.block) !== blockKey) continue;
      const c = readCache(doc, e);
      if (c?.records.size) return c;
    }
  return null;
}

/** 참조의 동적 블록 상태. 동적 참조가 아니면 null */
export function readReference(doc: CadDocument, ins: InsertEntity): DynRef | null {
  const key = definitionKeyOfInsert(doc, ins);
  if (!key) return null;
  const def = readDefinition(doc, key);
  const defBlock = doc.blocks.get(key);
  const blockKey = tableKey(ins.block);
  const block = doc.blocks.get(blockKey);
  if (!def || !defBlock || !block) return null;
  const direct = blockKey === key;
  const values = defaultValues(def);
  const cache = readCache(doc, ins);
  const cachedState = new Map<number, string>();
  // 캐시가 없는 표현 블록 참조(캐시 없이 복사된 참조)는 같은 표현 블록을 쓰는 다른 참조의 값
  const src = direct ? null : cache?.records.size ? cache : siblingCache(doc, ins, blockKey);
  if (src) {
    for (const [id, h] of src.records) {
      const x = doc.objects.get(h);
      if (x?.type !== 'XRECORD') continue;
      const { body } = splitRecord((x as XRecordObject).data);
      const nv = values.get(id);
      if (!nv) continue;
      const pr = parseBody(body);
      const type = def.nodeTypes.get(id) ?? '';
      const param = def.params.find((p) => p.id === id);
      if (param) {
        const n = param.kind === 'rotation' ? 2 : param.kind === 'visibility' || param.kind === 'lookup' || param.kind === 'point' || param.kind === 'basepoint' ? 1 : 2;
        if (pr.points.length >= n) {
          const pts = pr.points.slice(0, n).map(clone3);
          if (param.kind === 'rotation') pts.push(pr.points[3] ? clone3(pr.points[3]) : clone3(param.baseAngle));
          nv.points = pts;
        }
        if (param.kind === 'visibility' && pr.strings.length) cachedState.set(id, pr.strings[0]!);
        if (param.kind === 'lookup' && pr.strings.length) nv.value = pr.strings[0]!;
        if (param.kind === 'flip' && pr.ints.length) nv.flipped = pr.ints[pr.ints.length - 1] !== 0;
      } else if (/MOVEACTION|STRETCHACTION/.test(type)) {
        if (pr.reals.length) nv.angle = pr.reals[0]!;
      } else if (/SCALEACTION|ROTATEACTION/.test(type)) {
        if (pr.points.length) nv.base = clone3(pr.points[0]!);
      }
    }
  }
  const items = workItems(def, block, direct);
  for (const p of def.params) if (p.kind === 'visibility') values.get(p.id)!.state = visibleState(p, items, cachedState.get(p.id));
  return { def, defBlock, block, blockKey, direct, values, cache };
}

export function cloneValues(v: RefValues): RefValues {
  const out: RefValues = new Map();
  for (const [k, x] of v) out.set(k, { ...x, points: x.points?.map(clone3), base: x.base ? clone3(x.base) : undefined });
  return out;
}

/** 동적 참조의 보이는 정의 이름 */
export function definitionName(doc: CadDocument, ins: InsertEntity): string | null {
  const key = definitionKeyOfInsert(doc, ins);
  if (!key) return null;
  return readDefinition(doc, key)?.name ?? doc.blocks.get(key)?.name ?? null;
}
