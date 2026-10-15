/**
 * 동적 블록 편집 결과 → 편집 작업(EditOp).
 *
 * - 새 표현 블록 *U<n>: 지금 객체를 같은 순서·같은 ETag 색인으로(새 핸들, ETag 1005 = 새 핸들 — 속성 정의는 0),
 *   블록 플래그 1(이름 없음) | 2(속성 정의), 레코드 XDATA AcDbBlockRepBTag(1070 1, 1005 정의 레코드).
 * - 참조(INSERT): 블록 이름, 속성(보이지 않음·옮긴 속성 정의를 따라간 위치).
 * - 참조 캐시(ACAD_ENHANCEDBLOCKDATA): 있으면 바뀐 노드의 XRECORD만 고치고(머리·배치 그대로), 없으면 AutoCAD 형식으로 만든다.
 *   정의·평가 그래프·노드 객체는 손대지 않는다(파일에는 원본 태그 그대로).
 * - 아무도 쓰지 않게 된 이전 표현 블록은 지운다.
 */
import type { AttribEntity, BlockDef, BlockRecord, CadDocument, DictionaryObject, Entity, GenericObject, InsertEntity, RawTag, Vec3, XData, XRecordObject } from '../../core/model';
import { tableKey } from '../../core/model';
import type { EditOp } from '../session';
import { cloneEntity, ownerBlockKey } from '../session';
import { transformEntity } from '../geom/transform';
import { type Affine, affInv, affMul, affRotate, affScale, affTranslate } from '../geom/math';
import { allocBlockName } from '../geom/types';
import { attribValues, buildAttribs } from '../util/blockutil';
import { BTAG_APP, ETAG_APP, readDefinition } from './definition';
import type { DynEval } from './evaluate';
import { type DynRef, definitionKeyOfInsert, readCache, readReference, splitRecord } from './reference';
import { pointTags, withXData, xdataOf } from './tags';
import type { DynDefinition, DynEditResult, NodeValue } from './types';

/** 참조 행렬(블록 좌표 → 도면 좌표, 2D) */
export function insertAffine(def: BlockDef, ins: Pick<InsertEntity, 'insert' | 'scale' | 'rotation'>): Affine {
  return affMul(affTranslate(ins.insert.x, ins.insert.y), affMul(affRotate(ins.rotation), affMul(affScale(ins.scale.x, ins.scale.y), affTranslate(-def.basePoint.x, -def.basePoint.y))));
}

/**
 * 공개 표본(ACadSharp MIT 표본 DXF, samples/dynamic-blocks 포함)에서 확인한 캐시 머리 값(클래스마다 고정).
 * 정렬 매개변수·정렬 그립·기준점 매개변수는 공개 짝 도면(LibreDWG test-data 2018/Dynblocks, AutoCAD가 저장한 DWG·DXF)의 값.
 */
const KNOWN_HEADERS: Record<string, [number, number]> = {
  BLOCKALIGNMENTPARAMETER: [82446124, 112284408],
  BLOCKALIGNMENTGRIP: [6886097, 9208651],
  BLOCKBASEPOINTPARAMETER: [82437801, 112294725],
  BLOCKLINEARPARAMETER: [18597260, 25303744],
  BLOCKSCALEACTION: [2551693, 3435815],
  BLOCKVISIBILITYPARAMETER: [135625452, 184556386],
  BLOCKFLIPPARAMETER: [6887019, 9372877],
  BLOCKFLIPGRIP: [575085, 763560],
  BLOCKROTATIONPARAMETER: [50242585, 68333042],
  BLOCKROTATEACTION: [4195796, 5656503],
  BLOCKXYPARAMETER: [2550941, 3467982],
  BLOCKPOINTPARAMETER: [11324608, 15407465],
  BLOCKLOOKUPPARAMETER: [18605567, 25317787],
  BLOCKMOVEACTION: [1553528, 2094574],
  BLOCKSTRETCHACTION: [6895636, 9291323],
  BLOCKPOLARPARAMETER: [11323277, 15401870],
  BLOCKPOLARSTRETCHACTION: [82519608, 111249311],
};

/** 캐시 레코드를 두는 노드 종류 */
const CACHED_TYPES = new Set([
  'BLOCKVISIBILITYPARAMETER',
  'BLOCKFLIPPARAMETER',
  'BLOCKLINEARPARAMETER',
  'BLOCKROTATIONPARAMETER',
  'BLOCKXYPARAMETER',
  'BLOCKPOINTPARAMETER',
  'BLOCKBASEPOINTPARAMETER',
  'BLOCKLOOKUPPARAMETER',
  'BLOCKALIGNMENTPARAMETER',
  'BLOCKPOLARPARAMETER',
  'BLOCKMOVEACTION',
  'BLOCKPOLARSTRETCHACTION',
  'BLOCKSTRETCHACTION',
  'BLOCKROTATEACTION',
  'BLOCKSCALEACTION',
  'BLOCKFLIPGRIP',
  'BLOCKALIGNMENTGRIP',
]);

const NORMAL: Vec3 = { x: 0, y: 0, z: -1 };

/** 극좌표 매개변수 캐시의 넷째 점(첫 점 + (10, 0)) */
const polarRef = (p: Vec3): Vec3 => ({ x: p.x + 10, y: p.y, z: p.z });

// ---------------------------------------------------------------------------
// 캐시 레코드 본문
// ---------------------------------------------------------------------------

/** 새로 쓰는 레코드의 값(m = 배치 버전, 71 이상이면 선형·XY에 법선 점) */
function freshBody(type: string, v: NodeValue | undefined, m: number): RawTag[] | null {
  const pts = v?.points ?? [];
  const p = (i: number) => pts[i] ?? pts[0] ?? { x: 0, y: 0, z: 0 };
  switch (type) {
    case 'BLOCKVISIBILITYPARAMETER':
      return [...pointTags(10, p(0)), { code: 1, value: v?.state ?? '' }];
    case 'BLOCKLOOKUPPARAMETER':
      return [...pointTags(10, p(0)), { code: 1, value: v?.value ?? '' }];
    case 'BLOCKPOINTPARAMETER':
    case 'BLOCKBASEPOINTPARAMETER':
      return pointTags(10, p(0));
    case 'BLOCKLINEARPARAMETER':
    case 'BLOCKXYPARAMETER':
      return [...pointTags(10, p(0)), ...pointTags(10, p(1)), ...(m >= 71 ? pointTags(10, NORMAL) : [])];
    case 'BLOCKALIGNMENTPARAMETER':
      return [...pointTags(10, p(0)), ...pointTags(10, p(1)), ...pointTags(10, NORMAL)];
    case 'BLOCKFLIPPARAMETER':
      return [...pointTags(10, p(0)), ...pointTags(10, p(1)), ...pointTags(10, NORMAL), { code: 70, value: v?.flipped ? 1 : 0 }];
    case 'BLOCKROTATIONPARAMETER':
      return [...pointTags(10, p(0)), ...pointTags(10, p(1)), ...pointTags(10, NORMAL), ...pointTags(10, p(2))];
    case 'BLOCKPOLARPARAMETER':
      // 넷째 점은 첫 점 + (10, 0)(공개 표본·예제 도면 모두)
      return [...pointTags(10, p(0)), ...pointTags(10, p(1)), ...pointTags(10, NORMAL), ...pointTags(10, polarRef(p(0)))];
    case 'BLOCKMOVEACTION':
    case 'BLOCKSTRETCHACTION':
    case 'BLOCKPOLARSTRETCHACTION':
      return [{ code: 40, value: v?.angle ?? 0 }];
    case 'BLOCKROTATEACTION':
    case 'BLOCKSCALEACTION':
      return pointTags(10, v?.base ?? { x: 0, y: 0, z: 0 });
    case 'BLOCKFLIPGRIP':
      return [
        { code: 70, value: 0 },
        { code: 70, value: 0 },
      ];
    case 'BLOCKALIGNMENTGRIP':
      return [{ code: 70, value: 0 }];
    default:
      return null;
  }
}

/** 있는 레코드 본문의 값만 바꾼다(배치는 그대로) */
function patchBody(type: string, body: readonly RawTag[], v: NodeValue): RawTag[] {
  const out = body.map((t) => ({ ...t }));
  const isParam = /PARAMETER$/.test(type);
  // 고칠 점 색인 → 새 점
  const pts = new Map<number, Vec3>();
  if (isParam && v.points) {
    if (type === 'BLOCKROTATIONPARAMETER') {
      if (v.points[0]) pts.set(0, v.points[0]);
      if (v.points[1]) pts.set(1, v.points[1]);
      if (v.points[2]) pts.set(3, v.points[2]);
    } else if (type === 'BLOCKPOLARPARAMETER') {
      if (v.points[0]) pts.set(0, v.points[0]).set(3, polarRef(v.points[0]));
      if (v.points[1]) pts.set(1, v.points[1]);
    } else {
      const n = /VISIBILITY|LOOKUP|POINTPARAMETER|BASEPOINT/.test(type) ? 1 : 2;
      for (let i = 0; i < n; i++) if (v.points[i]) pts.set(i, v.points[i]!);
    }
  } else if (v.base) pts.set(0, v.base);
  let pi = 0;
  let si = 0;
  let ri = 0;
  const last70 = out.map((t) => t.code).lastIndexOf(70);
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;
    if (t.code === 10) {
      const q = pts.get(pi++);
      if (q) {
        t.value = q.x;
        if (out[i + 1]?.code === 20) out[i + 1]!.value = q.y;
        if (out[i + 2]?.code === 30) out[i + 2]!.value = q.z;
      }
    } else if (t.code === 1 && si++ === 0) {
      if (type === 'BLOCKVISIBILITYPARAMETER' && v.state !== undefined) t.value = v.state;
      if (type === 'BLOCKLOOKUPPARAMETER' && v.value !== undefined) t.value = v.value;
    } else if (t.code === 40 && ri++ === 0 && v.angle !== undefined && /MOVEACTION|STRETCHACTION/.test(type)) t.value = v.angle;
    else if (t.code === 70 && i === last70 && type === 'BLOCKFLIPPARAMETER' && v.flipped !== undefined) t.value = v.flipped ? 1 : 0;
  }
  return out;
}

/** 도면의 다른 참조 캐시에서 노드 종류별 머리를 모은다(클래스마다 고정 값) */
function headersInDocument(doc: CadDocument): Map<string, RawTag[]> {
  const out = new Map<string, RawTag[]>();
  for (const [type, [a, b]] of Object.entries(KNOWN_HEADERS))
    out.set(type, [
      { code: 1071, value: a },
      { code: 1071, value: b },
      { code: 70, value: 25 },
      { code: 70, value: 104 },
    ]);
  for (const blk of doc.blocks.values()) {
    for (const e of blk.entities) {
      if (e.type !== 'INSERT' || !e.xdict) continue;
      const cache = readCache(doc, e);
      if (!cache?.records.size) continue;
      const key = definitionKeyOfInsert(doc, e);
      const def = key ? readDefinition(doc, key) : null;
      if (!def) continue;
      for (const [id, h] of cache.records) {
        const type = def.nodeTypes.get(id);
        const x = doc.objects.get(h);
        if (!type || out.has(type) || x?.type !== 'XRECORD') continue;
        const { header } = splitRecord((x as XRecordObject).data);
        if (header.length === 4 && Number(header[3]!.value) >= 71) out.set(type, header.map((t) => ({ ...t })));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 사전·객체 만들기
// ---------------------------------------------------------------------------

function dict(handle: string, owner: string, entries: [string, string][], hardOwner = true, reactors = true): DictionaryObject {
  return { type: 'DICTIONARY', handle, owner, reactors: reactors ? [owner] : undefined, entries: new Map(entries), hardOwner, cloning: 1 };
}

function xrecord(handle: string, owner: string, data: RawTag[]): XRecordObject {
  return { type: 'XRECORD', handle, owner, reactors: [owner], cloning: 1, data };
}

/** 사전과 그 아래 객체(사전·XRECORD·표현 자료) 핸들 전부 */
function subtree(doc: CadDocument, h: string, out: string[] = []): string[] {
  const o = doc.objects.get(h.toUpperCase());
  if (!o) return out;
  out.push(o.handle);
  if (o.type === 'DICTIONARY' || o.type === 'ACDBDICTIONARYWDFLT') for (const c of (o as DictionaryObject).entries.values()) if (doc.objects.get(c.toUpperCase())?.owner?.toUpperCase() === o.handle.toUpperCase()) subtree(doc, c, out);
  return out;
}

interface CacheResult {
  ops: EditOp[];
  /** INSERT의 새 확장 사전 핸들(새로 만들었을 때) */
  xdict?: string;
}

/** 참조 캐시를 지금 값으로 맞추는 작업 */
function cacheOps(doc: CadDocument, ins: InsertEntity, ref: DynRef, ev: DynEval, newHandle: () => string): CacheResult {
  const def = ref.def;
  const ops: EditOp[] = [];
  const cache = ref.direct ? null : ref.cache;
  if (cache?.data && cache.records.size) {
    // 있는 캐시: 바뀐 노드만
    let dataDict = doc.objects.get(cache.data) as DictionaryObject | undefined;
    let dictChanged = false;
    let headers: Map<string, RawTag[]> | null = null;
    for (const id of ev.changedNodes) {
      const type = def.nodeTypes.get(id) ?? '';
      const v = ev.values.get(id);
      if (!v) continue;
      const h = cache.records.get(id);
      const x = h ? (doc.objects.get(h) as XRecordObject | undefined) : undefined;
      if (x?.type === 'XRECORD') {
        const { header, body } = splitRecord(x.data);
        const data = [...header.map((t) => ({ ...t })), ...patchBody(type, body, v)];
        if (JSON.stringify(data) !== JSON.stringify(x.data)) ops.push({ kind: 'object', key: x.handle, before: x, after: { ...x, data } });
        continue;
      }
      // 레코드가 없던 노드: 머리를 알면 새로 만든다
      headers ??= headersInDocument(doc);
      const head = headers.get(type);
      const body = head ? freshBody(type, v, Number(head[3]!.value)) : null;
      if (!head || !body || !dataDict) continue;
      const nh = newHandle();
      ops.push({ kind: 'object', key: nh, before: null, after: xrecord(nh, dataDict.handle, [...head.map((t) => ({ ...t })), ...body]) });
      if (!dictChanged) {
        dataDict = { ...dataDict, entries: new Map(dataDict.entries) };
        dictChanged = true;
      }
      dataDict.entries.set(String(id), nh);
    }
    if (dictChanged && dataDict) ops.push({ kind: 'object', key: dataDict.handle, before: doc.objects.get(dataDict.handle)!, after: dataDict });
    // 그립 기록은 버전 태그만 남긴다(이 기록을 되풀이하면 지금 값과 달라진다)
    const hist = cache.history ? (doc.objects.get(cache.history) as XRecordObject | undefined) : undefined;
    if (hist?.type === 'XRECORD' && hist.data.length > 1) {
      const ver = hist.data.find((t) => t.code === 1070);
      ops.push({ kind: 'object', key: hist.handle, before: hist, after: { ...hist, data: ver ? [{ ...ver }] : [] } });
    }
    return { ops };
  }

  // 캐시를 새로 만든다(정의를 직접 가리키던 참조, 표현 자료만 있던 참조)
  const before = cache ?? readCache(doc, ins);
  const out: CacheResult = { ops };
  let xdictH = before?.xdict ?? null;
  if (!xdictH) {
    xdictH = newHandle();
    out.xdict = xdictH;
  }
  // 이전 표현 사전은 통째로 바꾼다
  if (before?.rep) for (const h of subtree(doc, before.rep)) ops.push({ kind: 'object', key: h, before: doc.objects.get(h)!, after: null });
  const repH = newHandle();
  const repDataH = newHandle();
  const repData: GenericObject = {
    type: 'ACDB_BLOCKREPRESENTATION_DATA',
    handle: repDataH,
    owner: repH,
    reactors: [repH],
    raw: [
      { code: 100, value: 'AcDbBlockRepresentationData' },
      { code: 70, value: 1 },
      { code: 340, value: def.recordHandle },
    ],
  };
  const repEntries: [string, string][] = [['AcDbRepData', repDataH]];
  ops.push({ kind: 'object', key: repDataH, before: null, after: repData });
  const full = fullCache(doc, def, ev);
  if (full) {
    const appH = newHandle();
    const dataH = newHandle();
    const hdataH = newHandle();
    const histH = newHandle();
    const recs: [string, string][] = [];
    for (const r of full) {
      const h = newHandle();
      recs.push([String(r.id), h]);
      ops.push({ kind: 'object', key: h, before: null, after: xrecord(h, dataH, r.data) });
    }
    ops.push(
      { kind: 'object', key: dataH, before: null, after: dict(dataH, appH, recs) },
      { kind: 'object', key: hdataH, before: null, after: dict(hdataH, appH, [], false) },
      { kind: 'object', key: histH, before: null, after: xrecord(histH, appH, [{ code: 1070, value: 3 }]) },
      {
        kind: 'object',
        key: appH,
        before: null,
        after: dict(appH, repH, [
          ['ACAD_ENHANCEDBLOCKDATA', dataH],
          ['ACAD_ENHANCEDBLOCKHDATA', hdataH],
          ['ACAD_ENHANCEDBLOCKHISTORY', histH],
        ]),
      },
    );
    repEntries.push(['AppDataCache', appH]);
  }
  ops.push({ kind: 'object', key: repH, before: null, after: dict(repH, xdictH, repEntries) });
  const oldX = doc.objects.get(xdictH) as DictionaryObject | undefined;
  if (oldX && (oldX.type === 'DICTIONARY' || oldX.type === 'ACDBDICTIONARYWDFLT')) {
    const entries = new Map([...oldX.entries].filter(([k]) => k.toUpperCase() !== 'ACDBBLOCKREPRESENTATION'));
    entries.set('AcDbBlockRepresentation', repH);
    ops.push({ kind: 'object', key: xdictH, before: oldX, after: { ...oldX, entries } });
  } else ops.push({ kind: 'object', key: xdictH, before: null, after: { ...dict(xdictH, ins.handle, [['AcDbBlockRepresentation', repH]], true, false) } });
  return out;
}

/**
 * 새로 만드는 캐시의 레코드(노드마다). 머리를 모르는 노드 종류가 있거나 해석하지 못한 노드가 있으면
 * null(표현 자료만 쓴다 — 모양은 표현 블록 그대로, 다시 열면 값은 정의의 값).
 * 뒤집힌 참조도 쓴다(뒤집기 매개변수 70 = 1, 뒤집기 그립은 70 0·70 0 — AutoCAD가 뒤집힌 참조에 쓰는 그립 값은 확인하지 못했다).
 */
function fullCache(doc: CadDocument, def: DynDefinition, ev: DynEval): { id: number; data: RawTag[] }[] | null {
  if (def.undecoded.length) return null;
  const headers = headersInDocument(doc);
  const out: { id: number; data: RawTag[] }[] = [];
  const ids = [...def.nodeTypes.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const type = def.nodeTypes.get(id)!;
    if (!CACHED_TYPES.has(type)) continue;
    const head = headers.get(type);
    if (!head) return null;
    const body = freshBody(type, ev.values.get(id), Number(head[3]!.value));
    if (!body) return null;
    out.push({ id, data: [...head.map((t) => ({ ...t })), ...body] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 표현 블록
// ---------------------------------------------------------------------------

function etag(index: number, handle: string): XData['items'] {
  return [
    { code: 1070, value: 1 },
    { code: 1071, value: index },
    { code: 1005, value: handle },
  ];
}

/** 작업 객체로 새 표현 블록을 만든다(원본 다음에 배열 사본 — 사본은 원본의 ETag 색인, 1005는 제 핸들) */
function representation(doc: CadDocument, ref: DynRef, ev: DynEval, newHandle: () => string): { record: BlockRecord; block: BlockDef } {
  const name = allocBlockName(doc, '*U');
  const recH = newHandle();
  const map = new Map<string, string>();
  const ents: Entity[] = [];
  for (const it of [...ev.items, ...ev.copies]) {
    const e = cloneEntity(it.entity);
    const h = newHandle();
    if (!it.copy) map.set(it.entity.handle.toUpperCase(), h);
    e.handle = h;
    e.owner = recH;
    delete e.xdict;
    delete e.dwgRaw;
    if (e.type === 'INSERT')
      for (const a of e.attribs) {
        a.handle = newHandle();
        a.owner = h;
        delete a.xdict;
        delete a.dwgRaw;
        delete a.reactors;
      }
    e.xdata = withXData(e.xdata, ETAG_APP, etag(it.index, e.type === 'ATTDEF' ? '0' : h));
    if (it.copy) {
      // 사본은 원본의 연결(반응자·해치 경계)을 갖지 않는다
      delete e.reactors;
      if (e.type === 'HATCH' || e.type === 'MPOLYGON') {
        for (const p of e.paths) delete p.sources;
        if (e.type === 'HATCH') e.associative = false;
      }
    }
    ents.push(e);
  }
  // 블록 안 연결(연관 해치 경계·반응자)을 새 핸들로
  for (const e of ents) {
    if (e.reactors) {
      const r = e.reactors.map((h) => map.get(h.toUpperCase())).filter((h): h is string => !!h);
      if (r.length) e.reactors = r;
      else delete e.reactors;
    }
    if (e.type === 'HATCH' || e.type === 'MPOLYGON')
      for (const p of e.paths) if (p.sources) p.sources = p.sources.map((h) => map.get(h.toUpperCase())).filter((h): h is string => !!h);
  }
  const defRec = doc.blockRecords.get(ref.def.key);
  const record: BlockRecord = {
    name,
    handle: recH,
    flags: 0,
    insertUnits: defRec?.insertUnits ?? 0,
    explodable: defRec?.explodable ?? true,
    scalable: defRec?.scalable ?? true,
    xdata: [
      {
        app: BTAG_APP,
        items: [
          { code: 1070, value: 1 },
          { code: 1005, value: ref.def.recordHandle },
        ],
      },
    ],
  };
  const block: BlockDef = {
    name,
    handle: newHandle(),
    recordHandle: recH,
    basePoint: { ...ref.defBlock.basePoint },
    flags: 1 | (ents.some((e) => e.type === 'ATTDEF') ? 2 : 0),
    layer: ref.defBlock.layer ?? '0',
    entities: ents,
    endHandle: newHandle(),
  };
  return { record, block };
}

/** 이전 표현 블록을 아무도 쓰지 않으면 지우는 작업 */
function dropOldRepresentation(doc: CadDocument, ref: DynRef, ins: InsertEntity): EditOp[] {
  if (ref.direct) return [];
  const key = ref.blockKey;
  const rec = doc.blockRecords.get(key);
  if (!ref.block.name.startsWith('*') || !xdataOf(rec?.xdata, BTAG_APP)) return [];
  for (const b of doc.blocks.values()) for (const e of b.entities) if (e.type === 'INSERT' && e.handle !== ins.handle && tableKey(e.block) === key) return [];
  const ops: EditOp[] = [{ kind: 'blockDef', key, before: ref.block, after: null }];
  if (rec) ops.push({ kind: 'blockRecord', key, before: rec, after: null });
  return ops;
}

/** 속성: 가시성 상태가 숨긴 속성 정의의 속성은 보이지 않음, 동작이 옮긴 속성 정의의 속성은 같은 변환을 도면 좌표에서 */
function followAttribs(doc: CadDocument, ins: InsertEntity, ref: DynRef, ev: DynEval): AttribEntity[] {
  const W = insertAffine(ref.defBlock, ins);
  const Wi = affInv(W);
  const byTag = new Map<string, (typeof ev.items)[number]>();
  for (const x of ev.items) if (x.entity.type === 'ATTDEF' && !byTag.has((x.entity as AttribEntity).tag.toUpperCase())) byTag.set((x.entity as AttribEntity).tag.toUpperCase(), x);
  return ins.attribs.map((a0) => {
    const it = byTag.get(a0.tag.toUpperCase());
    if (!it) return a0;
    let a = cloneEntity(a0);
    const m = ev.moved.get(it.index);
    if (m && Wi) {
      const r = transformEntity(a, affMul(W, affMul(m, Wi)), doc);
      const t = (r.replace?.[0] ?? r.add?.[0]) as AttribEntity | undefined;
      if (t) a = { ...t, handle: a0.handle, owner: a0.owner, tag: a0.tag, text: a0.text } as AttribEntity;
    }
    if (it.entity.invisible) a.invisible = true;
    else delete a.invisible;
    delete a.dwgRaw;
    return a;
  });
}

/** 평가 결과로 편집 작업을 만든다 */
export function buildChangeOps(doc: CadDocument, ins: InsertEntity, ev: DynEval, newHandle: () => string): DynEditResult {
  const ref = ev.ref;
  const owner = ownerBlockKey(doc, ins.handle);
  if (!owner) return { ops: [], message: '참조가 들어 있는 블록을 찾지 못했습니다.' };
  const { record, block } = representation(doc, ref, ev, newHandle);
  const key = tableKey(block.name);
  const ops: EditOp[] = [
    { kind: 'blockRecord', key, before: null, after: record },
    { kind: 'blockDef', key, before: null, after: block },
  ];
  const after = cloneEntity(ins);
  after.block = block.name;
  delete after.dwgRaw;
  after.attribs = followAttribs(doc, ins, ref, ev);
  const cache = cacheOps(doc, ins, ref, ev, newHandle);
  if (cache.xdict) after.xdict = cache.xdict;
  ops.push({ kind: 'modify', block: owner, before: ins, after }, ...cache.ops, ...dropOldRepresentation(doc, ref, ins));
  return { ops, block: block.name };
}

/** RESETBLOCK: 정의를 직접 가리키게 하고 표현 자료를 지운다. 속성은 정의의 기본 위치·보이지 않음으로 */
export function buildResetOps(doc: CadDocument, ins: InsertEntity, newHandle: () => string): DynEditResult {
  const ref = readReference(doc, ins);
  if (!ref) return { ops: [], message: '동적 블록 참조가 아닙니다.' };
  const owner = ownerBlockKey(doc, ins.handle);
  if (!owner) return { ops: [], message: '참조가 들어 있는 블록을 찾지 못했습니다.' };
  const cache = readCache(doc, ins);
  if (ref.direct && !cache?.rep) return { ops: [] };
  const ops: EditOp[] = [];
  const after = cloneEntity(ins);
  after.block = ref.defBlock.name;
  delete after.dwgRaw;
  const reuse = new Map<string, string>();
  for (const a of ins.attribs) if (a.handle && !reuse.has(a.tag.toUpperCase())) reuse.set(a.tag.toUpperCase(), a.handle);
  if (ins.attribs.length) {
    const rebuilt = buildAttribs(ref.defBlock, ins, attribValues(ins), newHandle, reuse);
    // 정의에 없는 태그의 속성은 그대로 둔다
    const tags = new Set(rebuilt.map((a) => a.tag.toUpperCase()));
    after.attribs = [...rebuilt, ...ins.attribs.filter((a) => !tags.has(a.tag.toUpperCase())).map((a) => cloneEntity(a))];
  }
  if (cache?.rep) {
    const x = doc.objects.get(cache.xdict) as DictionaryObject;
    const rest = [...x.entries].filter(([k]) => k.toUpperCase() !== 'ACDBBLOCKREPRESENTATION');
    for (const h of subtree(doc, cache.rep)) ops.push({ kind: 'object', key: h, before: doc.objects.get(h)!, after: null });
    if (rest.length) ops.push({ kind: 'object', key: x.handle, before: x, after: { ...x, entries: new Map(rest) } });
    else {
      ops.push({ kind: 'object', key: x.handle, before: x, after: null });
      delete after.xdict;
    }
  }
  ops.unshift({ kind: 'modify', block: owner, before: ins, after });
  ops.push(...dropOldRepresentation(doc, ref, ins));
  return { ops };
}

