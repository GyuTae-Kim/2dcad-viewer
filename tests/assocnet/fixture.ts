/**
 * 시험용 연관 망 자료: AutoCAD가 쓰는 배치(src/edit/assocnet/objects.ts·cgroup.ts 머리말)대로 손으로 만든 원본 태그.
 * 값·핸들은 이 시험이 정한 것이다(공개 도면 파일을 옮기지 않는다).
 */
import type { CadDocument, DictionaryObject, Entity, GenericObject, RawTag } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';

/** [코드, 값] 쌍 → 원본 태그 */
export const T = (...pairs: [number, string | number][]): RawTag[] => pairs.map(([code, value]) => ({ code, value }));
const P = (code: number, x: number, y: number, z = 0): [number, number][] => [
  [code, x],
  [code + 10, y],
  [code + 20, z],
];

// ---------------------------------------------------------------------------
// 종류별 최소 태그(판 1·판 2)
// ---------------------------------------------------------------------------

/** 동작 머리(판 2: 매개변수 목록 4개 빈 것 포함) */
const head2 = (net: string, body: string, index: number, maxDep: number, deps: string[] = []): [number, string | number][] => [
  [100, 'AcDbAssocAction'],
  [90, 2],
  [90, 0],
  [330, net],
  [360, body],
  [90, index],
  [90, maxDep],
  [90, deps.length],
  ...deps.map((d): [number, string] => [360, d]),
];
const head1 = (net: string, body: string, index: number, maxDep: number, deps: string[] = []): [number, string | number][] => {
  const h = head2(net, body, index, maxDep, deps);
  h[1] = [90, 1];
  return h;
};
const EMPTY_LISTS: [number, number][] = [
  [90, 0],
  [90, 0],
  [90, 0],
  [90, 0],
];

export const NETWORK_V2 = T(...head2('0', '0', 0, 0), ...EMPTY_LISTS, [100, 'AcDbAssocNetwork'], [90, 0], [90, 2], [90, 2], [360, '1A'], [330, '1B'], [90, 0]);
export const NETWORK_V1 = T(...head1('0', '0', 0, 0), [100, 'AcDbAssocNetwork'], [90, 0], [90, 2], [90, 2], [360, '1A'], [330, '1B'], [90, 0]);

/** 값 매개변수 하나 */
const value = (name: string, unit: number, code: number, v: number): [number, string | number][] => [
  [90, 0],
  [1, name],
  [90, unit],
  [90, 1],
  [code, v],
  [330, '0'],
  [330, '0'],
];
const RECT_VALUES = [value('Items', 0, 90, 3), value('ItemSpacing', 1, 40, 2.5), value('AxesAngle', 2, 40, Math.PI / 2)];
const LISTS = (params: string[]): [number, string | number][] => [[90, 0], [90, params.length], ...params.map((h): [number, string] => [360, h]), [90, 0], [90, RECT_VALUES.length], ...RECT_VALUES.flat()];

/** 배열 동작(판 2: 매개변수가 동작에) */
export const ACTION_V2 = T(...head2('2A', '2B', 2, 1, ['2C']), ...LISTS(['2D', '2E']));
/** 판 1: 동작에는 매개변수가 없다 */
export const ACTION_V1 = T(...head1('2A', '2B', 2, 1, ['2C']));

const ITEMS: [number, string | number][] = [
  [90, 0],
  [90, 2],
  [1, 'AcDbAssocArrayItem'],
  [100, 'AcDbAssocArrayItem'],
  [90, 0],
  [90, 0],
  [90, 0],
  [90, 0],
  [90, 8],
  ...P(11, 0, 0),
  [330, '31'],
  [100, 'AcDbAssocArrayItem'],
  [90, 0],
  [90, 1],
  [90, 0],
  [90, 0],
  [90, 12],
  ...[0, -1, 0, 2.5, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].map((v): [number, number] => [40, v]),
  [330, '32'],
  ...[1, 0, 0, 4, 0, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 1].map((v): [number, number] => [40, v]),
];
export const BODY_V2 = T([100, 'AcDbAssocActionBody'], [90, 2], [100, 'AcDbAssocArrayActionBody'], [90, 1], [1, 'AcDbAssocArrayRectangularParameters'], ...ITEMS);
export const BODY_V1 = T(
  [100, 'AcDbAssocActionBody'],
  [90, 1],
  [100, 'AcDbAssocParamBasedActionBody'],
  [90, 0],
  ...LISTS(['2D', '2E']),
  [100, 'AcDbAssocArrayActionBody'],
  [90, 1],
  [1, 'AcDbAssocArrayRectangularParameters'],
  ...ITEMS,
);

export const DEPENDENCY = T([100, 'AcDbAssocDependency'], [90, 2], [90, 0], [290, 1], [290, 1], [290, 1], [290, 1], [90, -2147483648], [330, '3A'], [290, 0], [330, '0'], [330, '0'], [360, '0'], [90, 3]);
const dep = (target: string, order: number, index: number, prev = '0', next = '0', body = '0'): [number, string | number][] => [
  [100, 'AcDbAssocDependency'],
  [90, 2],
  [90, 0],
  [290, 1],
  [290, 1],
  [290, 1],
  [290, 1],
  [90, order],
  [330, target],
  [290, 0],
  [330, prev],
  [330, next],
  [360, body],
  [90, index],
];
export const GEOMDEP_SINGLE = T(...dep('3B', -10000, 1), [100, 'AcDbAssocGeomDependency'], [90, 0], [290, 1], [1, 'AcDbAssocSingleEdgePersSubentId'], [290, 0]);
export const GEOMDEP_EDGE = T(...dep('3C', -10000, 2, '0', '3E'), [100, 'AcDbAssocGeomDependency'], [90, 0], [290, 1], [1, 'AcDbAssocEdgePersSubentId'], [90, 0], [90, 1], [90, 2], [290, 0]);
export const VALUEDEP = T(...dep('3D', 0, 3), [100, 'AcDbAssocValueDependency'], [90, 0], [1, ''], [40, 12.5]);
export const DIMBODY = T([100, 'AcDbAssocDependencyBody'], [90, 1], [100, 'AcDbImpAssocDimDependencyBodyBase'], [90, 1], [1, 'd1=12.50'], [100, 'AcDbAssocDimDependencyBody'], [90, 1]);
export const VARIABLE_V2 = T(...head2('4A', '0', 7, 0), ...EMPTY_LISTS, [100, 'AcDbAssocVariable'], [90, 2], [1, 'd1'], [1, '12.50'], [1, 'AcDbCalc:1.0'], [1, ''], [40, 12.5], [290, 0], [290, 0], [90, 0]);
export const VARIABLE_V1 = T(...head1('4A', '0', 7, 0), [100, 'AcDbAssocVariable'], [90, 2], [1, 'd1'], [1, '12.50'], [1, 'AcDbCalc:1.0'], [1, ''], [40, 12.5], [290, 0], [290, 0], [90, 0]);
const actionParam2 = (name: string, depH = '0'): [number, string | number][] => [[100, 'AcDbAssocActionParam'], [90, 1], [90, 0], [1, name], [100, 'AcDbAssocSingleDependencyActionParam'], [90, 0], [330, depH]];
const actionParam1 = (name: string, depH = '0'): [number, string | number][] => [[100, 'AcDbAssocActionParam'], [90, 0], [1, name], [100, 'AcDbAssocSingleDependencyActionParam'], [90, 0], [330, depH]];
export const VERTEX_V2 = T(...actionParam2('Origin'), [100, 'AcDbAssocVertexActionParam'], [90, 0], ...P(10, 3, 4));
export const VERTEX_V1 = T(...actionParam1('Origin'), [100, 'AcDbAssocVertexActionParam'], [90, 0], ...P(10, 3, 4));
export const EDGE_V2 = T(...actionParam2('RowProfile', '2C'), [100, 'AcDbAssocEdgeActionParam'], [90, 0], [330, '0'], [290, 1], [90, 23], ...P(10, 1, 2), ...P(10, 10, 0));
export const EDGE_V1 = T(...actionParam1('RowProfile', '2C'), [100, 'AcDbAssocEdgeActionParam'], [90, 0], [330, '0'], [290, 1], [90, 23], ...P(10, 1, 2), ...P(10, 10, 0));

// ---------------------------------------------------------------------------
// 2D 구속 그룹: 선 L1 (0,0)–(10,0), L2 (10,0)–(10,5)
//   1 L1, 2·4 L1 시작·끝(암시 점), 3·5 점–곡선(암시), 6 일치(L1 끝, L2 시작), 7 수평(L1, 기준선 8), 8 X 기준선,
//   9 거리(L1 시작–끝, X 방향, 변수 d1), 10 L2, 11·13 L2 시작·끝, 12·14 점–곡선, 15 직교(L1, L2)
// ---------------------------------------------------------------------------

export interface GroupHandles {
  group: string;
  depL1: string;
  depL2: string;
  valueDep: string;
  dimDep: string;
  dimBody: string;
  variable: string;
  l1: string;
  l2: string;
  dim: string;
}

type Node = { cls: string; id: number; links: number[]; flags: number; data: [number, string | number][] };

function groupNodes(h: GroupHandles, v: 1 | 2): Node[] {
  const geo = (dep: string): [number, string | number][] => [
    [330, dep],
    [90, 0],
  ];
  const line = (x0: number, y0: number, x1: number, y1: number): [number, string | number][] => {
    const l = Math.hypot(x1 - x0, y1 - y0);
    return [...P(10, x0, y0), ...P(10, (x1 - x0) / l, (y1 - y0) / l), [290, 0], ...P(10, x0, y0), ...P(11, x1, y1)];
  };
  const ip = (type: number, curve: number): [number, string | number][] => [...geo('0'), [280, type], [90, -1], [90, curve]];
  const con = (implied: boolean): [number, string | number][] => [
    [90, 0],
    [290, implied ? 1 : 0],
    [290, 1],
  ];
  void v;
  return [
    { cls: 'AcConstrainedBoundedLine', id: 1, links: [3, 5, 7, 15], flags: 1, data: [...geo(h.depL1), ...line(0, 0, 10, 0)] },
    { cls: 'AcConstrainedImplicitPoint', id: 2, links: [3, 9], flags: 1, data: ip(0, 1) },
    { cls: 'AcPointCurveConstraint', id: 3, links: [2, 1], flags: 0, data: con(true) },
    { cls: 'AcConstrainedImplicitPoint', id: 4, links: [5, 6, 9], flags: 1, data: ip(1, 1) },
    { cls: 'AcPointCurveConstraint', id: 5, links: [4, 1], flags: 0, data: con(true) },
    { cls: 'AcPointCoincidenceConstraint', id: 6, links: [4, 11], flags: 0, data: con(false) },
    { cls: 'AcHorizontalConstraint', id: 7, links: [1], flags: 0, data: [...con(false), [90, 8]] },
    { cls: 'AcConstrainedDatumLine', id: 8, links: [], flags: 0, data: [...geo('0'), ...P(10, 0, 0), ...P(10, 1, 0)] },
    { cls: 'AcDistanceConstraint', id: 9, links: [2, 4], flags: 0, data: [...con(false), [340, h.valueDep], [340, h.dimDep], [280, 1], ...P(10, 1, 0)] },
    { cls: 'AcConstrainedBoundedLine', id: 10, links: [12, 14, 15], flags: 1, data: [...geo(h.depL2), ...line(10, 0, 10, 5)] },
    { cls: 'AcConstrainedImplicitPoint', id: 11, links: [6, 12], flags: 1, data: ip(0, 10) },
    { cls: 'AcPointCurveConstraint', id: 12, links: [11, 10], flags: 0, data: con(true) },
    { cls: 'AcConstrainedImplicitPoint', id: 13, links: [14], flags: 1, data: ip(1, 10) },
    { cls: 'AcPointCurveConstraint', id: 14, links: [13, 10], flags: 0, data: con(true) },
    { cls: 'AcPerpendicularConstraint', id: 15, links: [1, 10], flags: 0, data: con(false) },
  ];
}

/** 구속 그룹의 원본 태그(동작 머리 포함) */
export function groupTags(h: GroupHandles, net: string, v: 1 | 2): RawTag[] {
  const nodes = groupNodes(h, v);
  const out: [number, string | number][] = v === 2 ? [...head2(net, '0', 1, 4), ...EMPTY_LISTS] : head1(net, '0', 1, 4);
  out.push([90, 2], [70, 0], ...P(10, 0, 0), ...P(10, 1, 0), ...P(10, 0, 1), [360, '0'], [90, 4], [360, h.depL1], [360, h.depL2], [360, h.valueDep], [360, h.dimDep], [90, 15]);
  if (v === 2) {
    out.push([90, 0], [90, 0], [290, 0], [90, nodes.length]);
    for (const n of nodes) out.push([1, n.cls], [90, n.id]);
    for (const n of nodes) out.push([90, n.id], [90, n.links.length], ...n.links.map((l): [number, number] => [90, l]), [70, n.flags], ...n.data);
  } else {
    out.push([90, nodes.length]);
    for (const n of nodes) out.push([1, n.cls], [330, h.group], [90, n.id], [70, n.flags], [90, n.links.length], ...n.links.map((l): [number, number] => [90, l]), ...n.data);
  }
  return T(...out);
}

export interface ConstraintFixture {
  doc: CadDocument;
  s: EditSession;
  h: GroupHandles & { xdict: string; netDict: string; network: string };
}

/** 모형 공간에 선 둘과 AutoCAD 구속 그룹(판 v)을 둔 도면 */
export function constraintDoc(v: 1 | 2 = 2): ConstraintFixture {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  const ms = doc.blocks.get(MODEL_SPACE)!;
  const nh = () => s.newHandle();
  const h = { group: nh(), depL1: nh(), depL2: nh(), valueDep: nh(), dimDep: nh(), dimBody: nh(), variable: nh(), l1: nh(), l2: nh(), dim: nh(), xdict: nh(), netDict: nh(), network: nh() };
  const line = (handle: string, x0: number, y0: number, x1: number, y1: number, reactors: string[]): Entity =>
    ({ ...entityDefaults(), type: 'LINE', handle, owner: ms.recordHandle, reactors, start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } }) as Entity;
  // 숨은 치수 구속 표시(AutoCAD는 *ADSK_CONSTRAINTS 도면층의 보이지 않는 DIMENSION으로 둔다)
  const dim = {
    ...entityDefaults(),
    type: 'DIMENSION',
    handle: h.dim,
    owner: ms.recordHandle,
    reactors: [h.dimDep],
    layer: '0',
    invisible: true,
    block: '',
    dimStyle: 'Standard',
    dimType: 128,
    defPoint: { x: 5, y: -3, z: 0 },
    textMid: { x: 5, y: -3, z: 0 },
    defPoint2: { x: 0, y: 0, z: 0 },
    defPoint3: { x: 10, y: 0, z: 0 },
    defPoint4: { x: 0, y: 0, z: 0 },
    defPoint5: { x: 0, y: 0, z: 0 },
    text: 'd1=10',
    measurement: 10,
    rotation: 0,
    obliqueAngle: 0,
    textRotation: 0,
    horizontalDirection: 0,
    attachment: 5,
    leaderLength: 0,
    lineSpacingStyle: 1,
    lineSpacingFactor: 1,
  } as unknown as Entity;
  const ops = [
    { kind: 'add' as const, block: MODEL_SPACE, entity: line(h.l1, 0, 0, 10, 0, [h.depL1]) },
    { kind: 'add' as const, block: MODEL_SPACE, entity: line(h.l2, 10, 0, 10, 5, [h.depL2]) },
    { kind: 'add' as const, block: MODEL_SPACE, entity: dim },
  ];
  const obj = (type: string, handle: string, owner: string, raw: RawTag[], reactors?: string[]): GenericObject => ({ type, handle, owner, raw, ...(reactors ? { reactors } : {}) });
  const dict = (handle: string, owner: string, entries: [string, string][], hardOwner: boolean): DictionaryObject => ({ type: 'DICTIONARY', handle, owner, reactors: [owner], entries: new Map(entries), hardOwner, cloning: 1 });
  const objects = [
    dict(h.xdict, ms.recordHandle, [['ACAD_ASSOCNETWORK', h.netDict]], true),
    dict(h.netDict, h.xdict, [['ACAD_ASSOCNETWORK', h.network]], false),
    obj('ACDBASSOCNETWORK', h.network, h.netDict, v === 2 ? T(...head2('0', '0', 0, 0), ...EMPTY_LISTS, [100, 'AcDbAssocNetwork'], [90, 0], [90, 2], [90, 2], [360, h.group], [360, h.variable], [90, 0]) : T(...head1('0', '0', 0, 0), [100, 'AcDbAssocNetwork'], [90, 0], [90, 2], [90, 2], [360, h.group], [360, h.variable], [90, 0]), [h.netDict]),
    obj('ACDBASSOC2DCONSTRAINTGROUP', h.group, h.network, groupTags(h, h.network, v)),
    obj('ACDBASSOCGEOMDEPENDENCY', h.depL1, h.group, T(...dep(h.l1, -10000, 1), [100, 'AcDbAssocGeomDependency'], [90, 0], [290, 1], [1, 'AcDbAssocSingleEdgePersSubentId'], [290, 0])),
    obj('ACDBASSOCGEOMDEPENDENCY', h.depL2, h.group, T(...dep(h.l2, -10000, 2), [100, 'AcDbAssocGeomDependency'], [90, 0], [290, 1], [1, 'AcDbAssocSingleEdgePersSubentId'], [290, 0])),
    obj('ACDBASSOCVALUEDEPENDENCY', h.valueDep, h.group, T([100, 'AcDbAssocDependency'], [90, 2], [90, 0], [290, 1], [290, 0], [290, 1], [290, 1], [90, 0], [330, h.variable], [290, 0], [330, '0'], [330, '0'], [360, '0'], [90, 3], [100, 'AcDbAssocValueDependency'], [90, 0], [1, ''], [90, 10])),
    obj('ACDBASSOCDEPENDENCY', h.dimDep, h.group, T([100, 'AcDbAssocDependency'], [90, 2], [90, 0], [290, 0], [290, 1], [290, 1], [290, 1], [90, 0], [330, h.dim], [290, 0], [330, '0'], [330, '0'], [360, h.dimBody], [90, 4])),
    obj('ASSOCDIMDEPENDENCYBODY', h.dimBody, h.dimDep, T([100, 'AcDbAssocDependencyBody'], [90, 1], [100, 'AcDbImpAssocDimDependencyBodyBase'], [90, 1], [1, 'd1=10'], [100, 'AcDbAssocDimDependencyBody'], [90, 1])),
    obj(
      'ACDBASSOCVARIABLE',
      h.variable,
      h.network,
      v === 2 ? T(...head2(h.network, '0', 2, 0), ...EMPTY_LISTS, [100, 'AcDbAssocVariable'], [90, 2], [1, 'd1'], [1, '10'], [1, 'AcDbCalc:1.0'], [1, ''], [90, 10], [290, 0], [290, 0], [90, 0]) : T(...head1(h.network, '0', 2, 0), [100, 'AcDbAssocVariable'], [90, 2], [1, 'd1'], [1, '10'], [1, 'AcDbCalc:1.0'], [1, ''], [90, 10], [290, 0], [290, 0], [90, 0]),
      [h.valueDep],
    ),
  ];
  const rec = doc.blockRecords.get(MODEL_SPACE)!;
  s.commit({
    label: 'T',
    ops: [
      ...ops,
      ...objects.map((o) => ({ kind: 'object' as const, key: o.handle, before: null, after: o })),
      { kind: 'blockRecord', key: MODEL_SPACE, before: rec, after: { ...rec, xdict: h.xdict } },
    ],
  });
  return { doc, s, h };
}
