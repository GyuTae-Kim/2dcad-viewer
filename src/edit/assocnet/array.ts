/**
 * 새 연관 배열을 AutoCAD 연관 객체 망으로 만든다(AutoCAD가 저장한 공개 표본의 배치를 그대로 따른다 — objects.ts 머리말).
 *
 * 만드는 것(판 2 — 저장할 때 파일 버전에 맞게 판을 바꾼다, version.ts):
 *  - 망이 없으면: 루트 사전 "ACAD_ASSOCNETWORK" → 사전 → 최상위 ACDBASSOCNETWORK, 배열을 넣는 공간(블록 레코드)의 확장 사전
 *    "ACAD_ASSOCNETWORK" → 사전 → 그 공간의 ACDBASSOCNETWORK(최상위 망의 동작 목록에 330 참조로).
 *  - ACDBASSOCACTION(공간 망 소유): 종속 — 배열 블록 레코드(쓰기), 원본 블록 레코드(읽기), 배열 참조(읽기·쓰기, 순서 −2³¹),
 *    경로 배열은 경로 곡선(읽기, 맨 앞) — 와 동작 매개변수(BaseNormal·Origin·[RowProfile]·basePoint), 값 매개변수(종류별 이름·
 *    단위·값 꼴은 표본과 같은 차례).
 *  - ACDBASSOCARRAYACTIONBODY: 매개변수 클래스 이름, 항목(i·j·k, 이동 11 또는 행렬 40×16, 항목 참조), 배열 참조 행렬.
 *  - 배열 참조·경로 곡선의 반응자에 그 종속을 더한다(블록 레코드의 반응자는 모델에 자리가 없어 쓰지 않는다).
 * 경로 배열의 곡선 캐시(RowProfile)는 경로 객체의 공간 좌표 곡선이다(src/edit/assocnet/curve.ts pathCurve — 선·원·호·폴리선·
 * 스플라인. 공개 경로 배열 70여 개에서 AutoCAD 캐시와 같고, DWG 배치도 곡선 경로 배열 DWG로 확인했다). 그 밖의 경로는 만들지 않는다.
 */
import type { CadDocument, CadClass, DictionaryObject, Entity, GenericObject, InsertEntity, Vec3 } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import type { Affine } from '../geom/math';
import type { EditOp } from '../session';
import type { ArrayItem, ArrayParams } from '../assocarray/types';
import { ASSOC_APP, ASSOC_CLASS_DEFS, ASSOC_PROXY_FLAGS } from './classes';
import { type CurveData, writeCurve } from './curve';
import { dictEntry, objectOf, rootNetwork } from './network';
import { type ActionHead, type ArrayItemData, type AssocObjectData, type DependencyData, type EvalValue, type ValueParam, parseAssocObject, writeAssocObject } from './objects';

const PARAMS_CLASS = { rect: 'AcDbAssocArrayRectangularParameters', polar: 'AcDbAssocArrayPolarParameters', path: 'AcDbAssocArrayPathParameters' } as const;

/** 표본의 값 매개변수 차례·단위(0 없음, 1 거리, 2 각도)·값 꼴(90 정수, 40 실수) */
const VALUE_LAYOUT: Record<ArrayParams['kind'], readonly (readonly [string, number, 40 | 90])[]> = {
  rect: [
    ['AlignItems', 0, 90],
    ['AxesAngle', 2, 40],
    ['ItemSpacing', 1, 40],
    ['Items', 0, 90],
    ['LevelSpacing', 1, 40],
    ['Levels', 0, 90],
    ['RowElevation', 1, 40],
    ['RowSpacing', 1, 40],
    ['Rows', 0, 90],
  ],
  polar: [
    ['FillAngle', 2, 40],
    ['ItemSpacing', 2, 40],
    ['Items', 0, 90],
    ['LevelSpacing', 1, 40],
    ['Levels', 0, 90],
    ['RowElevation', 1, 40],
    ['RowSpacing', 1, 40],
    ['Rows', 0, 90],
    ['Radius', 1, 40],
    ['StartAngle', 2, 40],
  ],
  path: [
    ['ItemSpacing', 1, 40],
    ['Items', 0, 90],
    ['LevelSpacing', 1, 40],
    ['Levels', 0, 90],
    ['RowElevation', 1, 40],
    ['RowSpacing', 1, 40],
    ['Rows', 0, 90],
    ['AlignItems', 0, 90],
    ['FillPath', 0, 40],
    ['MaintainZ', 0, 40],
    ['Orientation', 0, 90],
    ['TangentOrientationAngle', 0, 40],
    ['Method', 0, 90],
  ],
};

/** 매개변수 → AutoCAD 값(표본의 이름) */
export function acadArrayValues(p: ArrayParams, pathSpacing?: number): Map<string, number> {
  const m = new Map<string, number>([
    ['Rows', p.rows],
    ['RowSpacing', p.rowSpacing],
    ['RowElevation', p.rowElevation],
    ['Levels', p.levels],
    ['LevelSpacing', p.levelSpacing],
  ]);
  if (p.kind === 'rect') {
    m.set('AlignItems', 0);
    m.set('Items', p.columns);
    m.set('ItemSpacing', p.columnSpacing);
    m.set('AxesAngle', p.axesAngle);
  } else if (p.kind === 'polar') {
    m.set('Items', p.items);
    // 각도는 크기만, 시계 방향이면 Direction 0(반시계는 값 매개변수를 두지 않는다 — 표본 대부분)
    m.set('ItemSpacing', Math.abs(p.itemAngle));
    m.set('FillAngle', Math.abs(p.fillAngle));
    m.set('StartAngle', p.startAngle);
    m.set('Radius', p.radius);
    if (p.fillAngle < 0) m.set('Direction', 0);
  } else {
    m.set('Items', p.items);
    m.set('ItemSpacing', pathSpacing ?? p.spacing);
    m.set('Method', p.method === 'divide' ? 0 : 1);
    m.set('AlignItems', p.align ? 1 : 0);
    m.set('MaintainZ', p.zDir ? 1 : 0);
    m.set('FillPath', p.method === 'divide' ? 1 : 0);
    m.set('Orientation', 1);
    m.set('TangentOrientationAngle', 0);
    if (p.reverse) m.set('PathDirection', 0);
  }
  return m;
}

/** 4×4 행 우선 행렬(16) */
export function matrix16(m: Affine, z = 0): number[] {
  return [m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, 1, z, 0, 0, 0, 1];
}

const isTranslation = (m: Affine) => Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12 && Math.abs(m[3] - 1) < 1e-12;

export function itemData(it: ArrayItem, handle: string): ArrayItemData {
  if (isTranslation(it.matrix)) return { version: 0, i: it.index, j: it.row, k: it.level, flags: 8, offset: { x: it.matrix[4], y: it.matrix[5], z: it.z }, entity: handle };
  return { version: 0, i: it.index, j: it.row, k: it.level, flags: 12, matrix: matrix16(it.matrix, it.z), entity: handle };
}

export interface AcadArrayInput {
  params: ArrayParams;
  /** 배열 참조(핸들·블록 이름이 정해진 것) */
  insert: InsertEntity;
  /** 배열 참조가 들어갈 공간(블록 키)과 그 블록 레코드 */
  space: string;
  spaceRecord: string;
  arrayRecord: string;
  sourceRecord: string;
  /** 항목(핸들 포함) */
  items: readonly (ArrayItem & { handle: string })[];
  /** 배열 블록 좌표 → 도면 좌표 */
  insertMatrix: Affine;
  /** 경로 배열: 경로 곡선과 그 곡선 캐시(공간 좌표, curve.ts pathCurve) */
  path?: { entity: Entity; curve: CurveData };
  /** 경로 배열의 실제 항목 간격(등분할이면 계산한 값) */
  pathSpacing?: number;
}

export interface AcadArrayResult {
  ops: EditOp[];
  /** 배열 참조에 더할 반응자 */
  insertReactors: string[];
  /** 경로 곡선을 바꾸는 작업(반응자 더하기)은 ops에 들어 있다 */
  action: string;
}

const dict = (handle: string, owner: string, entries: [string, string][], hardOwner = false): DictionaryObject => ({
  type: 'DICTIONARY',
  handle,
  owner,
  reactors: [owner],
  entries: new Map(entries),
  hardOwner,
  cloning: 1,
});

const generic = (type: string, handle: string, owner: string, d: AssocObjectData, reactors?: string[]): GenericObject => ({
  type,
  handle,
  owner,
  ...(reactors ? { reactors } : {}),
  raw: writeAssocObject(d),
});

const emptyHead = (network: string, index: number): ActionHead => ({ version: 2, status: 0, network, body: '', index, maxDep: 0, deps: [], params: { a: 0, actionParams: [], b: 0, values: [] } });

function dependency(target: string, read: boolean, write: boolean, index: number, order = 0): DependencyData {
  return { version: 2, status: 0, read, write, f3: true, f4: true, order, target, f5: false, prev: '', next: '', body: '', index };
}

/** 문서 클래스 목록에 연관 망 클래스가 없으면 더한다(DXF CLASSES·DWG 클래스 목록에 쓰인다 — 인스턴스가 없어도 AutoCAD처럼 둔다) */
export function ensureAssocClasses(doc: CadDocument, names: readonly string[]): void {
  for (const n of names) {
    const k = n.toUpperCase();
    if (doc.classes.some((c) => c.dxfName.toUpperCase() === k)) continue;
    const def = ASSOC_CLASS_DEFS.find((d) => d[0] === k);
    if (!def) continue;
    const c: CadClass = { dxfName: def[0], cppName: def[1], appName: ASSOC_APP, proxyFlags: ASSOC_PROXY_FLAGS, instanceCount: 0, wasProxy: false, isEntity: false };
    doc.classes.push(c);
  }
}

/**
 * 새 배열의 AutoCAD 연관 객체를 만드는 작업. 만들 수 없으면(경로가 선이 아님, 루트 사전 없음 등) null —
 * 그때는 이 앱 기록(OPENCAD_ARRAY)만으로 둔다.
 */
/**
 * 값 매개변수 하나를 더한 원본 태그(동작 판 2는 동작에, 판 1은 몸체의 AcDbAssocParamBasedActionBody에). 이미 있으면 null.
 * 원형 배열을 시계 방향으로 바꿀 때 Direction이 없던 AutoCAD 배열에 쓴다.
 */
export function withValueParam(type: string, raw: readonly import('../../core/model').RawTag[], name: string, unit: number, ev: EvalValue): import('../../core/model').RawTag[] | null {
  const d = parseAssocObject(type, raw);
  if (!d) return null;
  const add = (lists: import('./objects').ParamLists) => (lists.values.some((v) => v.name === name) ? null : { ...lists, values: [...lists.values, { version: 0, name, unit, values: [ev], input: '', output: '' }] });
  if (d.kind === 'action' && d.head.params) {
    const l = add(d.head.params);
    return l ? writeAssocObject({ ...d, head: { ...d.head, params: l } }) : null;
  }
  if (d.kind === 'arraybody' && d.body.paramBased) {
    const l = add(d.body.paramBased.lists);
    return l ? writeAssocObject({ ...d, body: { ...d.body, paramBased: { ...d.body.paramBased, lists: l } } }) : null;
  }
  return null;
}

export function acadArrayOps(doc: CadDocument, newHandle: () => string, input: AcadArrayInput): AcadArrayResult | null {
  const p = input.params;
  if (p.kind === 'path' && !input.path) return null;
  const rootH = doc.rootDictionary ? normalizeHandle(doc.rootDictionary) : '';
  const root = rootH ? (doc.objects.get(rootH) as DictionaryObject | undefined) : undefined;
  if (!root || (root.type !== 'DICTIONARY' && root.type !== 'ACDBDICTIONARYWDFLT')) return null;
  const rec = [...doc.blockRecords.entries()].find(([, r]) => normalizeHandle(r.handle) === normalizeHandle(input.spaceRecord));
  if (!rec) return null;
  const ops: EditOp[] = [];
  const objs = new Map<string, import('../../core/model').CadObject>();
  const put = (o: import('../../core/model').CadObject) => objs.set(normalizeHandle(o.handle), o);
  const cur = <T extends import('../../core/model').CadObject>(h: string): T | undefined => (objs.get(normalizeHandle(h)) ?? doc.objects.get(normalizeHandle(h))) as T | undefined;

  // 최상위 망
  let rootNet = rootNetwork(doc)?.network;
  if (!rootNet) {
    const dh = newHandle();
    const nh = newHandle();
    put(dict(dh, root.handle, [['ACAD_ASSOCNETWORK', nh]]));
    put(generic('ACDBASSOCNETWORK', nh, dh, { kind: 'network', head: emptyHead('', 0), net: { version: 0, maxIndex: 0, actions: [], tail: [] } }, [dh]));
    const entries = new Map(root.entries);
    entries.set('ACAD_ASSOCNETWORK', dh);
    put({ ...root, entries });
    rootNet = cur<GenericObject>(nh)!;
  }
  // 공간 망(블록 레코드 확장 사전)
  const [recKey, record] = rec;
  let spaceNetH = '';
  let xdict = record.xdict ? cur<DictionaryObject>(record.xdict) : undefined;
  if (xdict && xdict.type !== 'DICTIONARY' && xdict.type !== 'ACDBDICTIONARYWDFLT') return null;
  const netDictH = xdict ? dictEntry(xdict, 'ACAD_ASSOCNETWORK') : undefined;
  const netDict = netDictH ? cur<DictionaryObject>(netDictH) : undefined;
  if (netDict) spaceNetH = dictEntry(netDict, 'ACAD_ASSOCNETWORK') ?? '';
  if (spaceNetH && cur<GenericObject>(spaceNetH)?.type !== 'ACDBASSOCNETWORK') return null;
  if (!spaceNetH) {
    if (!xdict) {
      const xh = newHandle();
      xdict = dict(xh, record.handle, [], true);
      put(xdict);
      ops.push({ kind: 'blockRecord', key: recKey, before: record, after: { ...record, xdict: xh } });
    }
    const dh = netDictH ?? newHandle();
    spaceNetH = newHandle();
    if (!netDict) {
      put(dict(dh, xdict.handle, [['ACAD_ASSOCNETWORK', spaceNetH]]));
      const entries = new Map(xdict.entries);
      entries.set('ACAD_ASSOCNETWORK', dh);
      put({ ...xdict, entries });
    } else {
      const entries = new Map(netDict.entries);
      entries.set('ACAD_ASSOCNETWORK', spaceNetH);
      put({ ...netDict, entries });
    }
    // 최상위 망의 동작 목록에 330 참조로
    const rd = parseAssocObject(rootNet.type, rootNet.raw ?? []);
    if (rd?.kind !== 'network') return null;
    const idx = rd.net.maxIndex + 1;
    put({ ...rootNet, raw: writeAssocObject({ ...rd, net: { ...rd.net, maxIndex: idx, actions: [...rd.net.actions, { h: spaceNetH, owned: false }] } }) } as GenericObject);
    put(generic('ACDBASSOCNETWORK', spaceNetH, dh, { kind: 'network', head: emptyHead(normalizeHandle(rootNet.handle), idx), net: { version: 0, maxIndex: 0, actions: [], tail: [] } }, [dh]));
  }
  const spaceNet = cur<GenericObject>(spaceNetH)!;
  const sd = parseAssocObject(spaceNet.type, spaceNet.raw ?? []);
  if (sd?.kind !== 'network') return null;
  const actionIndex = sd.net.maxIndex + 1;

  // 동작·몸체·종속·매개변수
  const actionH = newHandle();
  const bodyH = newHandle();
  const deps: { h: string; d: DependencyData }[] = [];
  const addDep = (target: string, read: boolean, write: boolean, order = 0) => {
    const h = newHandle();
    deps.push({ h, d: dependency(normalizeHandle(target), read, write, deps.length + 1, order) });
    return h;
  };
  const pathDep = p.kind === 'path' ? addDep(input.path!.entity.handle, true, false) : '';
  addDep(input.arrayRecord, false, true);
  addDep(input.sourceRecord, true, false);
  const insDep = addDep(input.insert.handle, true, true, -2147483648);
  for (const { h, d } of deps) put(generic('ACDBASSOCDEPENDENCY', h, actionH, { kind: 'dependency', dep: d }));
  const vertex = (name: string, point: Vec3) => {
    const h = newHandle();
    put(generic('ACDBASSOCVERTEXACTIONPARAM', h, actionH, { kind: 'vertexparam', param: { version: 1, x: 0, name, single: { x: 0, dep: '' }, vx: 0, point } }));
    return h;
  };
  const actionParams: string[] = [vertex('BaseNormal', { x: 0, y: 0, z: 1 })];
  const origin = p.kind === 'rect' ? p.origin : p.kind === 'polar' ? p.center : { x: 0, y: 0 };
  actionParams.push(vertex('Origin', { x: origin.x, y: origin.y, z: 0 }));
  if (p.kind === 'path') {
    const h = newHandle();
    const curve = writeCurve(input.path!.curve);
    put(generic('ACDBASSOCEDGEACTIONPARAM', h, actionH, { kind: 'edgeparam', param: { version: 1, x: 0, name: 'RowProfile', single: { x: 0, dep: pathDep }, ex: 0, eh: '', hasCurve: true, curve } }));
    actionParams.push(h);
  }
  actionParams.push(vertex('basePoint', { x: p.base.x, y: p.base.y, z: 0 }));
  const want = acadArrayValues(p, input.pathSpacing);
  const values: ValueParam[] = [];
  const layout = [...VALUE_LAYOUT[p.kind]];
  if (p.kind === 'path' && want.has('PathDirection')) layout.splice(layout.length - 2, 0, ['PathDirection', 0, 90]);
  if (p.kind === 'polar' && want.has('Direction')) layout.push(['Direction', 0, 90]);
  for (const [name, unit, code] of layout) {
    const v = want.get(name) ?? 0;
    const ev: EvalValue = code === 90 ? { code: 90, v: Math.round(v) } : { code: 40, v };
    values.push({ version: 0, name, unit, values: [ev], input: '', output: '' });
  }
  const head: ActionHead = {
    version: 2,
    status: 0,
    network: normalizeHandle(spaceNetH),
    body: bodyH,
    index: actionIndex,
    maxDep: deps.length,
    deps: deps.map((x) => x.h),
    params: { a: 0, actionParams, b: 0, values },
  };
  put(generic('ACDBASSOCACTION', actionH, normalizeHandle(spaceNetH), { kind: 'action', head }));
  put(
    generic('ACDBASSOCARRAYACTIONBODY', bodyH, actionH, {
      kind: 'arraybody',
      body: { bodyVersion: 2, version: 1, paramsClass: PARAMS_CLASS[p.kind], x: 0, items: input.items.map((it) => itemData(it, it.handle)), matrix: matrix16(input.insertMatrix, input.insert.insert.z) },
    }),
  );
  put({ ...spaceNet, raw: writeAssocObject({ ...sd, net: { ...sd.net, maxIndex: actionIndex, actions: [...sd.net.actions, { h: actionH, owned: true }] } }) } as GenericObject);
  // 작업: 객체(새 것·바뀐 것)
  for (const [h, o] of objs) ops.push({ kind: 'object', key: h, before: doc.objects.get(h) ?? null, after: o });
  // 경로 곡선의 반응자
  if (p.kind === 'path') {
    const e = input.path!.entity;
    for (const [bk, b] of doc.blocks) {
      const before = b.entities.find((x) => x.handle === e.handle);
      if (before) {
        ops.push({ kind: 'modify', block: bk, before, after: { ...before, reactors: [...(before.reactors ?? []), pathDep] } as Entity });
        break;
      }
    }
  }
  ensureAssocClasses(doc, ['ACDBASSOCNETWORK', 'ACDBASSOCACTION', 'ACDBASSOCARRAYACTIONBODY', 'ACDBASSOCDEPENDENCY', 'ACDBASSOCVERTEXACTIONPARAM', ...(p.kind === 'path' ? ['ACDBASSOCEDGEACTIONPARAM'] : []), PARAMS_CLASS[p.kind].replace(/^AcDb/, 'ACDB').toUpperCase()]);
  void objectOf;
  return { ops, insertReactors: [insDep], action: actionH };
}
