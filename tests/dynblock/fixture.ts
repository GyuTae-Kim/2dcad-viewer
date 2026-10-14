/**
 * 동적 블록 시험용 최소 DXF(손으로 만든 것 — AutoCAD 파일 내용이 아니다).
 *
 * DYN-TEST: 폭 10 × 높이 5 상자.
 *   선형 "폭"(id 1, 0,0 → 10,0, 값 목록 5·15·20) → 신축(id 10, 오른쪽 변) + 이동(id 50, 속성 정의를 0.5배, 조회 매개변수 점도)
 *   가시성 "모양"(id 20): 동그라미 왼쪽(A) / 오른쪽(B) / 둘 다(Both)
 *   뒤집기 "반전"(id 30, x = 0 선) → 뒤집기 동작(id 31, 모든 객체와 매개변수 1·20·40·60)
 *   조회 "크기"(id 40) ← 조회 동작(id 41): 5·A·Small / 10·A·Medium / 20·B·Large
 *   회전 "각도"(id 60, 2,2.5 → 3.5,2.5) → 회전 동작(id 61, 바늘 선)
 * XY-TEST: 4 × 3 사각형 폴리선, XY "크기"(id 1) → 신축 셋(X만·Y만·첫 점 X).
 * 참조: A(DYN-TEST 직접), B(*U5 = 폭 20·상태 B·Large, 캐시 있음), C(XY-TEST 직접).
 */
import type { CadDocument, GenericObject } from '../../src/core/model';
import { readDxf } from '../../src/io/dxf/reader';

type Tag = [number, string | number];

class Out {
  readonly lines: string[] = [];
  tag(code: number, v: string | number): void {
    this.lines.push(String(code), typeof v === 'number' ? String(v) : v);
  }
  tags(list: readonly Tag[]): void {
    for (const [c, v] of list) this.tag(c, v);
  }
  rec(type: string, list: readonly Tag[]): void {
    this.tag(0, type);
    this.tags(list);
  }
}

const P = (code: number, x: number, y: number, z = 0): Tag[] => [
  [code, x],
  [code + 10, y],
  [code + 20, z],
];

let seq = 0x500;
const H = () => (seq++).toString(16).toUpperCase();

function etag(i: number, h: string): Tag[] {
  return [
    [1001, 'AcDbBlockRepETag'],
    [1070, 1],
    [1071, i],
    [1005, h],
  ];
}

// ---------------------------------------------------------------------------
// 노드 레코드
// ---------------------------------------------------------------------------

interface Node {
  id: number;
  handle: string;
  type: string;
  body: Tag[];
}

function head(id: number, name: string): Tag[] {
  return [
    [100, 'AcDbEvalExpr'],
    [90, id],
    [98, 33],
    [99, 329],
    [100, 'AcDbBlockElement'],
    [300, name],
    [98, 33],
    [99, 329],
    [1071, 0],
  ];
}

const param = (show = 1): Tag[] => [
  [100, 'AcDbBlockParameter'],
  [280, show],
  [281, 0],
];

function onePt(x: number, y: number, grip: number): Tag[] {
  return [[100, 'AcDbBlock1PtParameter'], ...P(1010, x, y), [93, grip], [170, 0], [171, 0]];
}

function twoPt(a: [number, number], b: [number, number], grips: number[], baseLoc = 0): Tag[] {
  const g = [...grips, 0, 0, 0, 0].slice(0, 4);
  return [[100, 'AcDbBlock2PtParameter'], ...P(1010, a[0], a[1]), ...P(1011, b[0], b[1]), [170, 4], ...g.map((x) => [91, x] as Tag), [171, 0], [172, 0], [173, 0], [174, 0], [177, baseLoc]];
}

function glc(id: number, paramId: number, prop: string): Node {
  return {
    id,
    handle: H(),
    type: 'BLOCKGRIPLOCATIONCOMPONENT',
    body: [
      [100, 'AcDbEvalExpr'],
      [90, id],
      [98, 33],
      [99, 329],
      [1, ''],
      [70, 40],
      [140, 1.797693134862314e99],
      [100, 'AcDbBlockGripExpr'],
      [91, paramId],
      [300, prop],
    ],
  };
}

function grip(type: string, sub: string, id: number, xe: number, ye: number, at: [number, number], extra: Tag[] = []): Node {
  return { id, handle: H(), type, body: [...head(id, 'Grip'), [100, 'AcDbBlockGrip'], [91, xe], [92, ye], ...P(1010, at[0], at[1]), [280, 0], [93, -1], [100, sub], ...extra] };
}

function action(id: number, name: string, nodes: number[], ents: string[], at: [number, number]): Tag[] {
  return [...head(id, name), [100, 'AcDbBlockAction'], [70, nodes.length], ...nodes.map((n) => [91, n] as Tag), [71, ents.length], ...ents.map((h) => [330, h] as Tag), ...P(1010, at[0], at[1])];
}

function stretch(
  id: number,
  ents: string[],
  x: [number, string],
  y: [number, string],
  frame: [number, number][],
  bind: [string, number[]][],
  xyType = 0,
  nodes: number[] = [],
  nodePts: [number, number[]][] = [],
): Node {
  const b: Tag[] = [...action(id, 'Stretch', nodes, ents, [0, 0]), [100, 'AcDbBlockStretchAction'], [92, x[0]], [301, x[1]], [93, y[0]], [302, y[1]], [72, frame.length]];
  for (const [fx, fy] of frame) b.push([1011, fx], [1021, fy]);
  b.push([73, bind.length]);
  for (const [h, pts] of bind) b.push([331, h], [74, pts.length], ...pts.map((p) => [94, p] as Tag));
  b.push([75, nodePts.length]);
  for (const [n, pts] of nodePts) b.push([95, n], [76, pts.length], ...pts.map((p) => [94, p] as Tag));
  b.push([140, 1], [141, 0], [280, xyType]);
  return { id, handle: H(), type: 'BLOCKSTRETCHACTION', body: b };
}

function graph(handle: string, owner: string, nodes: Node[], edges: [number, number][]): Tag[] {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const t: Tag[] = [
    [5, handle],
    [102, '{ACAD_REACTORS'],
    [330, owner],
    [102, '}'],
    [330, owner],
    [100, 'AcDbEvalGraph'],
    [96, nodes.length],
    [97, nodes.length],
  ];
  nodes.forEach((n, i) => t.push([91, i], [93, 32], [95, n.id], [360, n.handle], [92, -1], [92, -1], [92, -1], [92, -1]));
  edges.forEach(([a, b], i) => t.push([92, i], [93, 0], [94, 1], [91, index.get(a)!], [91, index.get(b)!], [92, -1], [92, -1], [92, -1], [92, -1], [92, -1]));
  return t;
}

function dict(handle: string, owner: string, entries: [string, string][], reactor = true, hard = 1): Tag[] {
  return [[5, handle], ...(reactor ? ([[102, '{ACAD_REACTORS'], [330, owner], [102, '}']] as Tag[]) : []), [330, owner], [100, 'AcDbDictionary'], [280, hard], [281, 1], ...entries.flatMap(([k, h]) => [[3, k], [360, h]] as Tag[])];
}

function xrec(handle: string, owner: string, data: Tag[]): Tag[] {
  return [[5, handle], [102, '{ACAD_REACTORS'], [330, owner], [102, '}'], [330, owner], [100, 'AcDbXrecord'], [280, 1], ...data];
}

const ent = (h: string, owner: string, sub: string, extra: Tag[] = []): Tag[] => [[5, h], [330, owner], [100, 'AcDbEntity'], [8, '0'], ...extra, [100, sub]];

export interface DynFixture {
  text: string;
  /** 핸들 이름표 */
  h: Record<string, string>;
}

export interface FixtureOptions {
  /** 속성 정의도 가시성 매개변수가 다룬다(상태 A·Both에서 보임) */
  attInVis?: boolean;
  /** 신축 동작에 묶음이 없다(틀만) */
  noBindings?: boolean;
}

/** 시험 DXF 문자열 */
export function dynFixture(opt: FixtureOptions = {}): DynFixture {
  seq = 0x500;
  const h: Record<string, string> = {};
  const name = (k: string) => (h[k] = H());
  // 표·블록 핸들
  ['recDyn', 'beginDyn', 'endDyn', 'xdDyn', 'graphDyn', 'recXY', 'beginXY', 'endXY', 'xdXY', 'graphXY', 'recU', 'beginU', 'endU'].forEach(name);
  const dynEnts = ['b0', 'b1', 'b2', 'b3', 'c4', 'c5', 'att6', 'n7'].map((k) => name(`d_${k}`));
  const uEnts = ['b0', 'b1', 'b2', 'b3', 'c4', 'c5', 'att6', 'n7'].map((k) => name(`u_${k}`));
  const poly = name('xy_poly');
  ['insA', 'attA', 'seqA', 'insB', 'attB', 'seqB', 'insC'].forEach(name);
  ['bx1', 'bx2', 'bx3', 'bx4', 'bx5', 'bx6', 'bx7'].forEach(name);

  // ------------------------------------------------------- DYN-TEST 노드
  const [d0, d1, d2, , d4, d5, d6, d7] = dynEnts as [string, string, string, string, string, string, string, string];
  const nodes: Node[] = [];
  const linear: Node = {
    id: 1,
    handle: H(),
    type: 'BLOCKLINEARPARAMETER',
    body: [...head(1, 'Linear'), ...param(), ...twoPt([0, 0], [10, 0], [2, 5]), [100, 'AcDbBlockLinearParameter'], [305, '폭'], [306, '상자 폭'], [140, 1], [307, ''], [96, 8], [141, 0], [142, 0], [143, 0], [175, 3], [144, 5], [144, 15], [144, 20]],
  };
  nodes.push(linear);
  nodes.push(grip('BLOCKLINEARGRIP', 'AcDbBlockLinearGrip', 2, 3, 4, [0, 0], [[140, -1], [141, 0], [142, 0]]), glc(3, 1, 'UpdatedBaseX'), glc(4, 1, 'UpdatedBaseY'));
  nodes.push(grip('BLOCKLINEARGRIP', 'AcDbBlockLinearGrip', 5, 6, 7, [10, 0], [[140, 1], [141, 0], [142, 0]]), glc(6, 1, 'UpdatedEndX'), glc(7, 1, 'UpdatedEndY'));
  nodes.push(stretch(10, [d0, d1, d2, d5], [1, 'EndXDelta'], [1, 'EndYDelta'], [[9, -1], [11, -1], [11, 6], [9, 6]], opt.noBindings ? [] : [[d0, [1]], [d2, [1]], [d1, [0, 1]]]));
  const visH = H();
  const rotH = H();
  const flipH = H();
  const lookH = H();
  const allNodes = [linear.handle, visH, rotH, flipH, lookH];
  const vis: Node = {
    id: 20,
    handle: visH,
    type: 'BLOCKVISIBILITYPARAMETER',
    body: [
      ...head(20, 'Visibility'),
      ...param(),
      ...onePt(5, -1, 21),
      [100, 'AcDbBlockVisibilityParameter'],
      [281, 1],
      [301, '모양'],
      [302, '동그라미 위치'],
      [91, 0],
      [93, opt.attInVis ? 3 : 2],
      [331, d4],
      [331, d5],
      ...(opt.attInVis ? ([[331, d6]] as Tag[]) : []),
      [92, 3],
      [303, 'A'],
      [94, opt.attInVis ? 2 : 1],
      [332, d4],
      ...(opt.attInVis ? ([[332, d6]] as Tag[]) : []),
      [95, allNodes.length],
      ...allNodes.map((x) => [333, x] as Tag),
      [303, 'B'],
      [94, 1],
      [332, d5],
      [95, allNodes.length - 1],
      ...allNodes.filter((x) => x !== rotH).map((x) => [333, x] as Tag),
      [303, 'Both'],
      [94, opt.attInVis ? 3 : 2],
      [332, d4],
      [332, d5],
      ...(opt.attInVis ? ([[332, d6]] as Tag[]) : []),
      [95, allNodes.length],
      ...allNodes.map((x) => [333, x] as Tag),
    ],
  };
  nodes.push(vis, grip('BLOCKVISIBILITYGRIP', 'AcDbBlockVisibilityGrip', 21, 22, 23, [5, -1]), glc(22, 20, 'UpdatedX'), glc(23, 20, 'UpdatedY'));
  const flip: Node = {
    id: 30,
    handle: flipH,
    type: 'BLOCKFLIPPARAMETER',
    body: [...head(30, 'Flip'), ...param(), ...twoPt([0, 6], [0, -1], [32]), [100, 'AcDbBlockFlipParameter'], [305, '반전'], [306, ''], [307, ''], [308, ''], ...P(1012, 0, 2), [309, ''], [96, 0]],
  };
  nodes.push(flip, grip('BLOCKFLIPGRIP', 'AcDbBlockFlipGrip', 32, 33, 34, [0, 6], [[140, 1], [141, 0], [142, 0], [93, 0]]), glc(33, 30, 'UpdatedBaseX'), glc(34, 30, 'UpdatedBaseY'));
  nodes.push({
    id: 31,
    handle: H(),
    type: 'BLOCKFLIPACTION',
    body: [...action(31, 'Flip', [1, 20, 40, 60], dynEnts, [0, 0]), [100, 'AcDbBlockFlipAction'], [92, 30], [93, 30], [94, 30], [95, 30], [301, 'UpdatedFlip'], [302, 'UpdatedBaseX'], [303, 'UpdatedBaseY'], [304, 'UpdatedEndX']],
  });
  const look: Node = { id: 40, handle: lookH, type: 'BLOCKLOOKUPPARAMETER', body: [...head(40, 'Lookup'), ...param(), ...onePt(5, 8, 42), [100, 'AcDbBlockLookUpParameter'], [303, '크기'], [304, ''], [94, 41]] };
  const rows = [
    ['5', 'A', 'Small'],
    ['10', 'A', 'Medium'],
    ['20', 'B', 'Large'],
  ];
  const cols: [number, number, number, string, string][] = [
    [1, 40, 0, '', 'UpdatedDistance'],
    [20, 1, 0, '', 'VisibilityState'],
    [40, 1, 1, '', 'lookupString'],
  ];
  const lookAct: Node = {
    id: 41,
    handle: H(),
    type: 'BLOCKLOOKUPACTION',
    body: [
      ...action(41, 'Lookup', [], [], [5, 9]),
      [100, 'AcDbBlockLookupAction'],
      [92, rows.length],
      [93, cols.length],
      [301, ''],
      ...rows.flat().map((c) => [302, c] as Tag),
      ...cols.flatMap(([node, vt, lk, un, prop]) => [[303, ''], [94, node], [95, vt], [96, 0], [282, lk], [305, un], [281, 1], [304, prop]] as Tag[]),
      [280, 1],
    ],
  };
  nodes.push(look, grip('BLOCKLOOKUPGRIP', 'AcDbBlockLookupGrip', 42, 43, 44, [5, 8]), glc(43, 40, 'UpdatedX'), glc(44, 40, 'UpdatedY'), lookAct);
  nodes.push({
    id: 50,
    handle: H(),
    type: 'BLOCKMOVEACTION',
    body: [...action(50, 'Move', [40], [d6], [5, 7]), [100, 'AcDbBlockMoveAction'], [92, 1], [301, 'EndXDelta'], [93, 1], [302, 'EndYDelta'], [140, 0.5], [141, 0], [280, 0]],
  });
  const rot: Node = {
    id: 60,
    handle: rotH,
    type: 'BLOCKROTATIONPARAMETER',
    body: [...head(60, 'Rotation'), ...param(), ...twoPt([2, 2.5], [3.5, 2.5], [62]), [100, 'AcDbBlockRotationParameter'], [305, '각도'], [306, ''], ...P(1011, 3.5, 2.5), [140, 0], [307, ''], [96, 0], [141, 0], [142, 0], [143, 0], [175, 0]],
  };
  nodes.push(rot, grip('BLOCKROTATIONGRIP', 'AcDbBlockRotationGrip', 62, 63, 64, [3.5, 2.5]), glc(63, 60, 'UpdatedEndX'), glc(64, 60, 'UpdatedEndY'));
  nodes.push({
    id: 61,
    handle: H(),
    type: 'BLOCKROTATEACTION',
    body: [
      ...action(61, 'Rotate', [], [d7], [2, 2]),
      [100, 'AcDbBlockActionWithBasePt'],
      [92, 60],
      [93, 60],
      [301, 'UpdatedBaseX'],
      [302, 'UpdatedBaseY'],
      ...P(1011, 0, 0),
      [280, 1],
      ...P(1012, 0, 0),
      [100, 'AcDbBlockRotationAction'],
      [94, 60],
      [303, 'UpdatedAngle'],
    ],
  });
  const edges: [number, number][] = [
    [2, 1],
    [5, 1],
    [1, 3],
    [1, 4],
    [1, 6],
    [1, 7],
    [1, 10],
    [1, 50],
    [21, 20],
    [20, 22],
    [20, 23],
    [32, 30],
    [30, 31],
    [30, 33],
    [30, 34],
    [42, 40],
    [40, 41],
    [40, 43],
    [40, 44],
    [62, 60],
    [60, 61],
    [60, 63],
    [60, 64],
  ];

  // ------------------------------------------------------- XY-TEST 노드
  const xyNodes: Node[] = [];
  const xy: Node = {
    id: 1,
    handle: H(),
    type: 'BLOCKXYPARAMETER',
    body: [
      ...head(1, 'XY'),
      ...param(),
      ...twoPt([0, 0], [4, 3], [2, 5]),
      [100, 'AcDbBlockXYParameter'],
      [305, '가로'],
      [306, '세로'],
      [307, ''],
      [308, ''],
      [141, 0],
      [140, 0],
      [309, ''],
      [97, 0],
      [146, 0],
      [147, 0],
      [148, 0],
      [176, 0],
      [410, ''],
      [96, 8],
      [142, 0],
      [143, 0],
      [144, 0],
      [175, 3],
      [145, 2],
      [145, 6],
      [145, 8],
    ],
  };
  xyNodes.push(xy, grip('BLOCKXYGRIP', 'AcDbBlockXYGrip', 2, 3, 4, [4, 3]), glc(3, 1, 'UpdatedEndX'), glc(4, 1, 'UpdatedEndY'));
  xyNodes.push(grip('BLOCKXYGRIP', 'AcDbBlockXYGrip', 5, 6, 7, [0, 3]), glc(6, 1, 'UpdatedBaseX'), glc(7, 1, 'UpdatedEndY'));
  xyNodes.push(stretch(8, [poly], [1, 'EndXDelta'], [1, 'EndYDelta'], [], [[poly, [1, 2]]], 1));
  xyNodes.push(stretch(9, [poly], [1, 'EndXDelta'], [1, 'EndYDelta'], [], [[poly, [2, 3]]], 2));
  xyNodes.push(stretch(10, [poly], [1, 'BaseXDelta'], [1, 'BaseYDelta'], [], [[poly, [0, 3]]], 1));
  const xyEdges: [number, number][] = [
    [2, 1],
    [5, 1],
    [1, 3],
    [1, 4],
    [1, 6],
    [1, 7],
    [1, 8],
    [1, 9],
    [1, 10],
  ];

  // ------------------------------------------------------- 문서
  const o = new Out();
  o.rec('SECTION', [[2, 'HEADER']]);
  o.tags([
    [9, '$ACADVER'],
    [1, 'AC1032'],
    [9, '$INSUNITS'],
    [70, 4],
    [9, '$HANDSEED'],
    [5, 'FFF'],
  ]);
  o.rec('ENDSEC', []);
  o.rec('SECTION', [[2, 'TABLES']]);
  o.rec('TABLE', [[2, 'LAYER'], [5, '2'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 1]]);
  o.rec('LAYER', [[5, '10'], [330, '2'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbLayerTableRecord'], [2, '0'], [70, 0], [62, 7], [6, 'Continuous']]);
  o.rec('ENDTAB', []);
  o.rec('TABLE', [[2, 'BLOCK_RECORD'], [5, '1'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 5]]);
  const br = (hh: string, nm: string, extra: Tag[] = [], xd?: string) =>
    o.rec('BLOCK_RECORD', [[5, hh], ...(xd ? ([[102, '{ACAD_XDICTIONARY'], [360, xd], [102, '}']] as Tag[]) : []), [330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbBlockTableRecord'], [2, nm], [340, '0'], [70, 4], [280, 1], [281, 0], ...extra]);
  br('1F', '*Model_Space');
  br('1B', '*Paper_Space');
  br(h.recDyn!, 'DYN-TEST', [[1001, 'AcDbBlockRepETag'], [1070, 1], [1071, 8], [1001, 'AcDbDynamicBlockTrueName'], [1000, 'DYN-TEST'], [1001, 'AcDbDynamicBlockGUID'], [1000, '{00000000-0000-0000-0000-000000000001}']], h.xdDyn);
  br(h.recXY!, 'XY-TEST', [[1001, 'AcDbDynamicBlockGUID'], [1000, '{00000000-0000-0000-0000-000000000002}']], h.xdXY);
  br(h.recU!, '*U5', [[1001, 'AcDbBlockRepBTag'], [1070, 1], [1005, h.recDyn!]]);
  o.rec('ENDTAB', []);
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'BLOCKS']]);
  const block = (begin: string, end: string, rec: string, nm: string, flags: number) => {
    o.rec('BLOCK', [[5, begin], [330, rec], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockBegin'], [2, nm], [70, flags], ...P(10, 0, 0), [3, nm], [1, '']]);
    return () => o.rec('ENDBLK', [[5, end], [330, rec], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockEnd']]);
  };
  block('20', '21', '1F', '*Model_Space', 0)();
  block('1C', '1D', '1B', '*Paper_Space', 0)();
  const body = (owner: string, hs: string[], w: number, state: 'A' | 'B', attX: number) => {
    const [b0, b1, b2, b3, c4, c5, a6, n7] = hs as [string, string, string, string, string, string, string, string];
    o.rec('LINE', [...ent(b0, owner, 'AcDbLine'), ...P(10, 0, 0), ...P(11, w, 0), ...etag(0, b0)]);
    o.rec('LINE', [...ent(b1, owner, 'AcDbLine'), ...P(10, w, 0), ...P(11, w, 5), ...etag(1, b1)]);
    o.rec('LINE', [...ent(b2, owner, 'AcDbLine'), ...P(10, 0, 5), ...P(11, w, 5), ...etag(2, b2)]);
    o.rec('LINE', [...ent(b3, owner, 'AcDbLine'), ...P(10, 0, 0), ...P(11, 0, 5), ...etag(3, b3)]);
    o.rec('CIRCLE', [...ent(c4, owner, 'AcDbCircle', state === 'A' ? [] : [[60, 1]]), ...P(10, 2, 2.5), [40, 1], ...etag(4, c4)]);
    o.rec('CIRCLE', [...ent(c5, owner, 'AcDbCircle', state === 'B' ? [] : [[60, 1]]), ...P(10, w - 2, 2.5), [40, 1], ...etag(5, c5)]);
    o.rec('ATTDEF', [...ent(a6, owner, 'AcDbText'), ...P(10, attX, 6), [40, 0.5], [1, 'X'], [100, 'AcDbAttributeDefinition'], [280, 0], [3, '태그'], [2, 'TAG'], [70, 0], ...etag(6, '0')]);
    o.rec('LINE', [...ent(n7, owner, 'AcDbLine'), ...P(10, 2, 2.5), ...P(11, 3.5, 2.5), ...etag(7, n7)]);
  };
  let end = block(h.beginDyn!, h.endDyn!, h.recDyn!, 'DYN-TEST', 2);
  body(h.recDyn!, dynEnts, 10, 'A', 5);
  end();
  end = block(h.beginXY!, h.endXY!, h.recXY!, 'XY-TEST', 0);
  o.rec('LWPOLYLINE', [...ent(poly, h.recXY!, 'AcDbPolyline'), [90, 4], [70, 1], [10, 0], [20, 0], [10, 4], [20, 0], [10, 4], [20, 3], [10, 0], [20, 3], ...etag(0, poly)]);
  end();
  end = block(h.beginU!, h.endU!, h.recU!, '*U5', 3);
  body(h.recU!, uEnts, 20, 'B', 10);
  end();
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'ENTITIES']]);
  const insert = (hh: string, nm: string, x: number, y: number, att?: [string, string, number, string], xd?: string) => {
    o.rec('INSERT', [[5, hh], ...(xd ? ([[102, '{ACAD_XDICTIONARY'], [360, xd], [102, '}']] as Tag[]) : []), [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockReference'], ...(att ? ([[66, 1]] as Tag[]) : []), [2, nm], ...P(10, x, y)]);
    if (att) {
      o.rec('ATTRIB', [[5, att[0]], [330, hh], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbText'], ...P(10, x + att[2], y + 6), [40, 0.5], [1, att[3]], [100, 'AcDbAttribute'], [280, 0], [2, 'TAG'], [70, 0]]);
      o.rec('SEQEND', [[5, att[1]], [330, hh], [100, 'AcDbEntity'], [8, '0']]);
    }
  };
  insert(h.insA!, 'DYN-TEST', 0, 0, [h.attA!, h.seqA!, 5, 'A']);
  insert(h.insB!, '*U5', 100, 0, [h.attB!, h.seqB!, 10, 'B'], h.bx1);
  insert(h.insC!, 'XY-TEST', 0, 50);
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'OBJECTS']]);
  o.rec('DICTIONARY', [[5, 'C'], [330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'ACAD_GROUP'], [350, 'D']]);
  o.rec('DICTIONARY', [[5, 'D'], [102, '{ACAD_REACTORS'], [330, 'C'], [102, '}'], [330, 'C'], [100, 'AcDbDictionary'], [281, 1]]);
  o.rec('DICTIONARY', dict(h.xdDyn!, h.recDyn!, [['ACAD_ENHANCEDBLOCK', h.graphDyn!]], false));
  o.rec('ACAD_EVALUATION_GRAPH', graph(h.graphDyn!, h.xdDyn!, nodes, edges));
  for (const n of nodes) o.rec(n.type, [[5, n.handle], [330, h.graphDyn!], ...n.body]);
  o.rec('DICTIONARY', dict(h.xdXY!, h.recXY!, [['ACAD_ENHANCEDBLOCK', h.graphXY!]], false));
  o.rec('ACAD_EVALUATION_GRAPH', graph(h.graphXY!, h.xdXY!, xyNodes, xyEdges));
  for (const n of xyNodes) o.rec(n.type, [[5, n.handle], [330, h.graphXY!], ...n.body]);
  // 참조 B의 캐시(머리 값: 선형·가시성은 공개 표본의 값, 나머지는 시험용 임의 값)
  const [bx1, bx2, bx3, bx4, bx5, bx6, bx7] = [h.bx1!, h.bx2!, h.bx3!, h.bx4!, h.bx5!, h.bx6!, h.bx7!];
  o.rec('DICTIONARY', dict(bx1, h.insB!, [['AcDbBlockRepresentation', bx2]], false));
  o.rec('DICTIONARY', dict(bx2, bx1, [['AcDbRepData', bx3], ['AppDataCache', bx4]]));
  o.rec('ACDB_BLOCKREPRESENTATION_DATA', [[5, bx3], [102, '{ACAD_REACTORS'], [330, bx2], [102, '}'], [330, bx2], [100, 'AcDbBlockRepresentationData'], [70, 1], [340, h.recDyn!]]);
  o.rec('DICTIONARY', dict(bx4, bx2, [['ACAD_ENHANCEDBLOCKDATA', bx5], ['ACAD_ENHANCEDBLOCKHDATA', bx6], ['ACAD_ENHANCEDBLOCKHISTORY', bx7]]));
  const hd = (a: number, b: number): Tag[] => [
    [1071, a],
    [1071, b],
    [70, 25],
    [70, 104],
  ];
  const recs: [number, Tag[]][] = [
    [1, [...hd(18597260, 25303744), ...P(10, 0, 0), ...P(10, 20, 0), ...P(10, 0, 0, -1)]],
    [10, [...hd(9001, 9002), [40, 0]]],
    [20, [...hd(135625452, 184556386), ...P(10, 5, -1), [1, 'B']]],
    [30, [...hd(9003, 9004), ...P(10, 0, 6), ...P(10, 0, -1), ...P(10, 0, 0, -1), [70, 0]]],
    [32, [...hd(9005, 9006), [70, 0], [70, 0]]],
    [40, [...hd(9007, 9008), ...P(10, 10, 8), [1, 'Large']]],
    [50, [...hd(9001, 9002), [40, 0]]],
    [60, [...hd(9009, 9010), ...P(10, 2, 2.5), ...P(10, 3.5, 2.5), ...P(10, 0, 0, -1), ...P(10, 3.5, 2.5)]],
    [61, [...hd(9011, 9012), ...P(10, 2, 2.5)]],
  ];
  const recH = recs.map(() => H());
  o.rec('DICTIONARY', dict(bx5, bx4, recs.map(([id], i) => [String(id), recH[i]!])));
  recs.forEach(([, data], i) => o.rec('XRECORD', xrec(recH[i]!, bx5, data)));
  o.rec('DICTIONARY', [[5, bx6], [102, '{ACAD_REACTORS'], [330, bx4], [102, '}'], [330, bx4], [100, 'AcDbDictionary'], [281, 1]]);
  o.rec('XRECORD', xrec(bx7, bx4, [[1070, 3], [1071, 2], [300, 'GRIPLOC'], ...P(11, 20, 0)]));
  o.rec('ENDSEC', []);
  o.tag(0, 'EOF');
  return { text: o.lines.join('\n') + '\n', h };
}

/**
 * DWG로도 쓸 수 있는 종류만 쓴 작은 동적 블록(손으로 만든 것 — 태그 배치는 ACadSharp 표본 my-dynamic-block과 같은 꼴).
 *
 * DYN-MINI: 반지름 1인 원(ETag 0)과 선(ETag 1).
 *   선형 "지름"(id 1, -1,0 → 1,0, 값 목록 2·4·6) → 축척(id 10, 원, 기준점 = 선형 첫 점)
 *   가시성 "보기"(id 23): 모두(원·선) / 원만 / 숨김
 * 참조 M은 정의를 직접 가리킨다. 블록 레코드 확장 사전에 평가 그래프와 지움 막기 객체가 있다.
 */
export function dynMiniFixture(): DynFixture {
  seq = 0x700;
  const h: Record<string, string> = {};
  for (const k of ['rec', 'begin', 'end', 'xd', 'graph', 'purge', 'circle', 'line', 'insM']) h[k] = H();
  const lin: Node = {
    id: 1,
    handle: H(),
    type: 'BLOCKLINEARPARAMETER',
    body: [...head(1, 'Linear'), ...param(), ...twoPt([-1, 0], [1, 0], [5, 2]), [100, 'AcDbBlockLinearParameter'], [305, '지름'], [306, '원 지름'], [140, 2], [307, ''], [96, 8], [141, 0], [142, 0], [143, 0], [175, 3], [144, 2], [144, 4], [144, 6]],
  };
  const nodes: Node[] = [lin];
  nodes.push(grip('BLOCKLINEARGRIP', 'AcDbBlockLinearGrip', 2, 3, 4, [1, 0], [[140, 2], [141, 0], [142, 0]]), glc(3, 1, 'UpdatedEndX'), glc(4, 1, 'UpdatedEndY'));
  nodes.push(grip('BLOCKLINEARGRIP', 'AcDbBlockLinearGrip', 5, 6, 7, [-1, 0], [[140, -2], [141, 0], [142, 0]]), glc(6, 1, 'UpdatedBaseX'), glc(7, 1, 'UpdatedBaseY'));
  const scale: Node = {
    id: 10,
    handle: H(),
    type: 'BLOCKSCALEACTION',
    body: [
      ...action(10, 'Scale', [], [h.circle!], [0, -2]),
      [100, 'AcDbBlockActionWithBasePt'],
      [92, 1],
      [93, 1],
      [301, 'UpdatedBaseX'],
      [302, 'UpdatedBaseY'],
      ...P(1011, 0, 0),
      [280, 1],
      ...P(1012, 0, 0),
      [100, 'AcDbBlockScaleAction'],
      [94, 1],
      [95, 1],
      [96, 1],
      [303, 'Scale'],
      [304, 'XScale'],
      [305, 'YScale'],
    ],
  };
  nodes.push(scale);
  const all = [lin.handle, scale.handle];
  const vis: Node = {
    id: 23,
    handle: H(),
    type: 'BLOCKVISIBILITYPARAMETER',
    body: [
      ...head(23, 'Visibility State'),
      ...param(),
      ...onePt(2, 1, 24),
      [100, 'AcDbBlockVisibilityParameter'],
      [281, 1],
      [301, '보기'],
      [302, ''],
      [91, 0],
      [93, 2],
      [331, h.circle!],
      [331, h.line!],
      [92, 3],
      [303, '모두'],
      [94, 2],
      [332, h.circle!],
      [332, h.line!],
      [95, all.length],
      ...all.map((x) => [333, x] as Tag),
      [303, '원만'],
      [94, 1],
      [332, h.circle!],
      [95, all.length],
      ...all.map((x) => [333, x] as Tag),
      [303, '숨김'],
      [94, 0],
      [95, 0],
    ],
  };
  nodes.push(vis, grip('BLOCKVISIBILITYGRIP', 'AcDbBlockVisibilityGrip', 24, 25, 26, [2, 1]), glc(25, 23, 'UpdatedX'), glc(26, 23, 'UpdatedY'));
  const edges: [number, number][] = [
    [2, 1],
    [5, 1],
    [1, 3],
    [1, 4],
    [1, 6],
    [1, 7],
    [1, 10],
    [24, 23],
    [23, 25],
    [23, 26],
  ];

  const o = new Out();
  o.rec('SECTION', [[2, 'HEADER']]);
  o.tags([
    [9, '$ACADVER'],
    [1, 'AC1032'],
    [9, '$INSUNITS'],
    [70, 4],
    [9, '$HANDSEED'],
    [5, 'FFF'],
  ]);
  o.rec('ENDSEC', []);
  o.rec('SECTION', [[2, 'TABLES']]);
  o.rec('TABLE', [[2, 'LAYER'], [5, '2'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 1]]);
  o.rec('LAYER', [[5, '10'], [330, '2'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbLayerTableRecord'], [2, '0'], [70, 0], [62, 7], [6, 'Continuous']]);
  o.rec('ENDTAB', []);
  o.rec('TABLE', [[2, 'BLOCK_RECORD'], [5, '1'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 3]]);
  const br = (hh: string, nm: string, extra: Tag[] = [], xd?: string) =>
    o.rec('BLOCK_RECORD', [[5, hh], ...(xd ? ([[102, '{ACAD_XDICTIONARY'], [360, xd], [102, '}']] as Tag[]) : []), [330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbBlockTableRecord'], [2, nm], [340, '0'], [70, 4], [280, 1], [281, 0], ...extra]);
  br('1F', '*Model_Space');
  br('1B', '*Paper_Space');
  br(h.rec!, 'DYN-MINI', [[1001, 'AcDbBlockRepETag'], [1070, 1], [1071, 2], [1001, 'AcDbDynamicBlockTrueName'], [1000, 'DYN-MINI'], [1001, 'AcDbDynamicBlockGUID'], [1000, '{00000000-0000-0000-0000-000000000003}']], h.xd);
  o.rec('ENDTAB', []);
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'BLOCKS']]);
  const block = (begin: string, end: string, rec: string, nm: string, flags: number) => {
    o.rec('BLOCK', [[5, begin], [330, rec], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockBegin'], [2, nm], [70, flags], ...P(10, 0, 0), [3, nm], [1, '']]);
    return () => o.rec('ENDBLK', [[5, end], [330, rec], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockEnd']]);
  };
  block('20', '21', '1F', '*Model_Space', 0)();
  block('1C', '1D', '1B', '*Paper_Space', 0)();
  const end = block(h.begin!, h.end!, h.rec!, 'DYN-MINI', 0);
  o.rec('CIRCLE', [...ent(h.circle!, h.rec!, 'AcDbCircle'), ...P(10, 0, 0), [40, 1], ...etag(0, h.circle!)]);
  o.rec('LINE', [...ent(h.line!, h.rec!, 'AcDbLine'), ...P(10, -1, 0), ...P(11, 1, 0), ...etag(1, h.line!)]);
  end();
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'ENTITIES']]);
  o.rec('INSERT', [[5, h.insM!], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockReference'], [2, 'DYN-MINI'], ...P(10, 10, 5)]);
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'OBJECTS']]);
  o.rec('DICTIONARY', [[5, 'C'], [330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'ACAD_GROUP'], [350, 'D']]);
  o.rec('DICTIONARY', [[5, 'D'], [102, '{ACAD_REACTORS'], [330, 'C'], [102, '}'], [330, 'C'], [100, 'AcDbDictionary'], [281, 1]]);
  o.rec(
    'DICTIONARY',
    dict(h.xd!, h.rec!, [
      ['ACAD_ENHANCEDBLOCK', h.graph!],
      ['AcDbDynamicBlockRoundTripPurgePreventer', h.purge!],
    ]),
  );
  o.rec('ACAD_EVALUATION_GRAPH', graph(h.graph!, h.xd!, nodes, edges));
  for (const n of nodes) o.rec(n.type, [[5, n.handle], [330, h.graph!], ...n.body]);
  o.rec('ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION', [[5, h.purge!], [102, '{ACAD_REACTORS'], [330, h.xd!], [102, '}'], [330, h.xd!], [100, 'AcDbDynamicBlockPurgePreventer'], [70, 1]]);
  o.rec('ENDSEC', []);
  o.tag(0, 'EOF');
  return { text: o.lines.join('\n') + '\n', h };
}

/**
 * 원본 태그를 리더가 남기는 꼴(서브클래스 표지부터, 1001 앞까지)로 채운다.
 * 지금 DXF 리더는 객체 본문의 1000번대 코드(동적 블록 객체의 1071·1010)에서 원본 태그를 끊는다 — 리더를 고치면 필요 없다.
 */
export function withFullRaw(doc: CadDocument, text: string): CadDocument {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const recs: { type: string; tags: [number, string][] }[] = [];
  let cur: { type: string; tags: [number, string][] } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const v = lines[i + 1]!;
    if (code === 0) {
      cur = { type: v.trim(), tags: [] };
      recs.push(cur);
    } else cur?.tags.push([code, v]);
  }
  let inObjects = false;
  for (let k = 0; k < recs.length; k++) {
    const r = recs[k]!;
    if (r.type === 'SECTION') inObjects = r.tags.some(([c, v]) => c === 2 && v.trim() === 'OBJECTS');
    if (!inObjects) continue;
    const hv = r.tags.find(([c]) => c === 5)?.[1];
    if (!hv) continue;
    const o = doc.objects.get(hv.trim().toUpperCase().replace(/^0+(?=.)/, '')) as GenericObject | undefined;
    if (!o || !('raw' in o) || !o.raw) continue;
    const raw: { code: number; value: string }[] = [];
    let sub = '';
    let ownerSeen = false;
    for (let i = 0; i < r.tags.length; i++) {
      const [c, v] = r.tags[i]!;
      if (c === 1001) break;
      if (c === 100) sub = v.trim();
      if (sub === '' && c === 102) {
        const app = v.trim().slice(1).toUpperCase();
        const known = app === 'ACAD_REACTORS' || app === 'ACAD_XDICTIONARY';
        if (!known) raw.push({ code: c, value: v });
        let j = i + 1;
        for (; j < r.tags.length && r.tags[j]![0] !== 102; j++) if (!known) raw.push({ code: r.tags[j]![0], value: r.tags[j]![1] });
        if (!known && j < r.tags.length) raw.push({ code: 102, value: r.tags[j]![1] });
        i = j;
        continue;
      }
      if (sub === '' && c === 5) continue;
      if (sub === '' && c === 330 && !ownerSeen) {
        ownerSeen = true;
        continue;
      }
      raw.push({ code: c, value: v });
    }
    o.raw = raw;
  }
  return doc;
}

/** 시험 DXF를 읽는다(원본 태그 보정 포함) */
export function loadDyn(text: string): CadDocument {
  return withFullRaw(readDxf(new TextEncoder().encode(text)), text);
}
