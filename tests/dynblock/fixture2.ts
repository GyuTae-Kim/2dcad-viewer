/**
 * 동적 블록 시험용 최소 DXF 2(손으로 만든 것 — AutoCAD 파일 내용이 아니다). 태그 배치는 공개 도면에서 확인한 AutoCAD 배치.
 *
 * ARR-TEST: 원 C(0,0 r1, ETag 0), 선 L(0,-0.5 → 0,0.5, ETag 1).
 *   선형 "길이"(id 1, 0,0 → 10,0) → 배열(id 10, 원 C, 141 = 5 열 간격, 140 = 1)
 *   XY "격자"(id 20, 0,0 → 6,4, X 레이블 "가로"·Y 레이블 "세로") → 배열(id 30, 선 L, 141 = 3 열(X), 140 = 2 행(Y))
 *   기본 상태의 BEDIT 미리보기 사본(XDATA AcDbBlockArrayActionBEDITTag): 원 (5,0)(ETag 2), 선 (3,0)·(0,2)·(3,2)(ETag 3~5).
 * ALIGN-TEST: 선 (0,0)–(4,0), 정렬 매개변수(id 1, 0,0 → 4,0, 280 = 1) + 정렬 그립(id 2, 위치 식 3·4).
 * CON-TEST(구속 기반): 선 L1 (0,0)–(10,0), L2 (10,0)–(10,5) + 연관 망(tests/assocnet/fixture.ts의 구속 그룹 꼴: 거리 d1(L1 X 방향)·
 *   수평·일치·직교). 수평 구속 매개변수 "W"(id 1, 0,-1 → 10,-1, 값 목록 5·10·15·20; 330 = 거리 구속의 치수 종속),
 *   대리 노드(id 5), 뒤집기 "반전"(id 6, x = 0 선) → 뒤집기 동작(id 7, L1·L2, 매개변수 1).
 * 참조: R(ARR-TEST 직접, 원점), G(ALIGN-TEST 직접, 100,100), K(CON-TEST 직접, 0,-50), 모형 공간 선 S (0,50)–(100,150).
 */
import type { CadDocument, RawTag } from '../../src/core/model';
import { groupTags } from '../assocnet/fixture';
import { loadDyn } from './fixture';

type Tag = [number, string | number];

class Out {
  readonly lines: string[] = [];
  tag(code: number, v: string | number): void {
    this.lines.push(String(code), typeof v === 'number' ? String(v) : v);
  }
  rec(type: string, list: readonly Tag[]): void {
    this.tag(0, type);
    for (const [c, v] of list) this.tag(c, v);
  }
}

const P = (code: number, x: number, y: number, z = 0): Tag[] => [
  [code, x],
  [code + 10, y],
  [code + 20, z],
];

const etag = (i: number, h: string): Tag[] => [
  [1001, 'AcDbBlockRepETag'],
  [1070, 1],
  [1071, i],
  [1005, h],
];
const bedit: Tag[] = [
  [1001, 'AcDbBlockArrayActionBEDITTag'],
  [1070, 1],
];

interface Node {
  id: number;
  handle: string;
  type: string;
  body: Tag[];
}

const head = (id: number, name: string): Tag[] => [
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
const param: Tag[] = [
  [100, 'AcDbBlockParameter'],
  [280, 1],
  [281, 0],
];
const twoPt = (a: [number, number], b: [number, number], grips: number[]): Tag[] => {
  const g = [...grips, 0, 0, 0, 0].slice(0, 4);
  return [[100, 'AcDbBlock2PtParameter'], ...P(1010, a[0], a[1]), ...P(1011, b[0], b[1]), [170, 4], ...g.map((x): Tag => [91, x]), [171, 0], [172, 0], [173, 0], [174, 0], [177, 0]];
};
const action = (id: number, name: string, nodes: number[], ents: string[]): Tag[] => [
  ...head(id, name),
  [100, 'AcDbBlockAction'],
  [70, nodes.length],
  ...nodes.map((n): Tag => [91, n]),
  [71, ents.length],
  ...ents.map((h): Tag => [330, h]),
  ...P(1010, 0, 0),
];
const glc = (id: number, handle: string, paramId: number, prop: string): Node => ({
  id,
  handle,
  type: 'BLOCKGRIPLOCATIONCOMPONENT',
  body: [[100, 'AcDbEvalExpr'], [90, id], [98, 33], [99, 329], [1, ''], [70, 40], [140, 1.797693134862314e99], [100, 'AcDbBlockGripExpr'], [91, paramId], [300, prop]],
});
const grip = (type: string, sub: string, id: number, handle: string, xe: number, ye: number, at: [number, number], extra: Tag[] = []): Node => ({
  id,
  handle,
  type,
  body: [...head(id, 'Grip'), [100, 'AcDbBlockGrip'], [91, xe], [92, ye], ...P(1010, at[0], at[1]), [280, 1], [93, -1], [100, sub], ...extra],
});

function graph(handle: string, owner: string, nodes: Node[], edges: [number, number][]): Tag[] {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const t: Tag[] = [[5, handle], [102, '{ACAD_REACTORS'], [330, owner], [102, '}'], [330, owner], [100, 'AcDbEvalGraph'], [96, nodes.length], [97, nodes.length]];
  nodes.forEach((n, i) => t.push([91, i], [93, 32], [95, n.id], [360, n.handle], [92, -1], [92, -1], [92, -1], [92, -1]));
  edges.forEach(([a, b], i) => t.push([92, i], [93, 0], [94, 1], [91, index.get(a)!], [91, index.get(b)!], [92, -1], [92, -1], [92, -1], [92, -1], [92, -1]));
  return t;
}

const dict = (handle: string, owner: string, entries: [string, string][], hard = 1): Tag[] => [[5, handle], [102, '{ACAD_REACTORS'], [330, owner], [102, '}'], [330, owner], [100, 'AcDbDictionary'], [280, hard], [281, 1], ...entries.flatMap(([k, h]): Tag[] => [[3, k], [360, h]])];
const ent = (h: string, owner: string, sub: string): Tag[] => [[5, h], [330, owner], [100, 'AcDbEntity'], [8, '0'], [100, sub]];
const line = (h: string, owner: string, a: [number, number], b: [number, number], extra: Tag[] = []): Tag[] => [...ent(h, owner, 'AcDbLine'), ...P(10, a[0], a[1]), ...P(11, b[0], b[1]), ...extra];

export interface Fixture2 {
  text: string;
  h: Record<string, string>;
}

/** 연관 망 동작 머리(판 2, 빈 매개변수 목록 넷) — tests/assocnet/fixture.ts와 같은 꼴 */
const assocHead = (owner: string, body: string, index: number, maxDep: number): Tag[] => [
  [100, 'AcDbAssocAction'],
  [90, 2],
  [90, 0],
  [330, owner],
  [360, body],
  [90, index],
  [90, maxDep],
  [90, 0],
  [90, 0],
  [90, 0],
  [90, 0],
  [90, 0],
];
const dependency = (target: string, read: number, write: number, order: number, body: string, index: number): Tag[] => [
  [100, 'AcDbAssocDependency'],
  [90, 2],
  [90, 0],
  [290, read],
  [290, write],
  [290, 1],
  [290, 1],
  [90, order],
  [330, target],
  [290, 0],
  [330, '0'],
  [330, '0'],
  [360, body],
  [90, index],
];

export function dynFixture2(): Fixture2 {
  let seq = 0x900;
  const H = () => (seq++).toString(16).toUpperCase();
  const h: Record<string, string> = {};
  for (const k of [
    'recA', 'beginA', 'endA', 'xdA', 'graphA', 'c', 'l', 'pc', 'pl1', 'pl2', 'pl3',
    'recG', 'beginG', 'endG', 'xdG', 'graphG', 'gl',
    'recK', 'beginK', 'endK', 'xdK', 'graphK', 'l1', 'l2', 'netDict', 'network', 'group', 'depL1', 'depL2', 'valueDep', 'dimDep', 'dimBody', 'variable',
    'insR', 'insG', 'insK', 'lineS',
  ])
    h[k] = H();

  // ------------------------------------------------------- ARR-TEST
  const arr: Node[] = [];
  arr.push({ id: 1, handle: H(), type: 'BLOCKLINEARPARAMETER', body: [...head(1, 'Linear'), ...param, ...twoPt([0, 0], [10, 0], [2]), [100, 'AcDbBlockLinearParameter'], [305, '길이'], [306, ''], [140, 1], [307, ''], [96, 0], [141, 0], [142, 0], [143, 0], [175, 0]] });
  arr.push(grip('BLOCKLINEARGRIP', 'AcDbBlockLinearGrip', 2, H(), 3, 4, [10, 0], [[140, 1], [141, 0], [142, 0]]), glc(3, H(), 1, 'UpdatedEndX'), glc(4, H(), 1, 'UpdatedEndY'));
  arr.push({ id: 10, handle: H(), type: 'BLOCKARRAYACTION', body: [...action(10, 'Array', [], [h.c!]), [100, 'AcDbBlockArrayAction'], [92, 1], [93, 1], [94, 1], [95, 1], [301, 'Base'], [302, 'End'], [303, 'UpdatedBase'], [304, 'UpdatedEnd'], [140, 1], [141, 5]] });
  arr.push({
    id: 20,
    handle: H(),
    type: 'BLOCKXYPARAMETER',
    body: [...head(20, 'XY'), ...param, ...twoPt([0, 0], [6, 4], [21, 24]), [100, 'AcDbBlockXYParameter'], [305, '세로'], [306, '가로'], [307, ''], [308, ''], [141, 0], [140, 0], [309, ''], [97, 0], [146, 0], [147, 0], [148, 0], [176, 0], [410, ''], [96, 0], [142, 0], [143, 0], [144, 0], [175, 0]],
  });
  arr.push(grip('BLOCKXYGRIP', 'AcDbBlockXYGrip', 21, H(), 22, 23, [6, 4]), glc(22, H(), 20, 'UpdatedEndX'), glc(23, H(), 20, 'UpdatedEndY'));
  arr.push(grip('BLOCKXYGRIP', 'AcDbBlockXYGrip', 24, H(), 25, 26, [0, 0]), glc(25, H(), 20, 'UpdatedBaseX'), glc(26, H(), 20, 'UpdatedBaseY'));
  arr.push({ id: 30, handle: H(), type: 'BLOCKARRAYACTION', body: [...action(30, 'Array1', [], [h.l!]), [100, 'AcDbBlockArrayAction'], [92, 20], [93, 20], [94, 20], [95, 20], [301, 'Base'], [302, 'End'], [303, 'UpdatedBase'], [304, 'UpdatedEnd'], [140, 2], [141, 3]] });
  const arrEdges: [number, number][] = [[2, 1], [1, 3], [1, 4], [1, 10], [21, 20], [24, 20], [20, 22], [20, 23], [20, 25], [20, 26], [20, 30]];

  // ------------------------------------------------------- ALIGN-TEST
  const al: Node[] = [];
  al.push({ id: 1, handle: H(), type: 'BLOCKALIGNMENTPARAMETER', body: [...head(1, 'Alignment'), ...param, ...twoPt([0, 0], [4, 0], [2]), [100, 'AcDbBlockAlignmentParameter'], [280, 1]] });
  al.push(grip('BLOCKALIGNMENTGRIP', 'AcDbBlockAlignmentGrip', 2, H(), 3, 4, [0, 0], [[140, 4], [141, 0], [142, 0]]), glc(3, H(), 1, 'UpdatedBaseX'), glc(4, H(), 1, 'UpdatedBaseY'));
  const alEdges: [number, number][] = [[2, 1], [1, 3], [1, 4]];

  // ------------------------------------------------------- CON-TEST
  const con: Node[] = [];
  const wH = H();
  con.push({
    id: 1,
    handle: wH,
    type: 'BLOCKHORIZONTALCONSTRAINTPARAMETER',
    body: [
      ...head(1, 'W'),
      ...param,
      ...twoPt([0, -1], [10, -1], []),
      [100, 'AcDbBlockConstraintParameter'],
      [330, h.dimDep!],
      [100, 'AcDbBlockLinearConstraintParameter'],
      [305, 'W'],
      [306, ''],
      [140, -3],
      [307, ''],
      [96, 8],
      [141, 0],
      [142, 0],
      [143, 0],
      [175, 4],
      [144, 5],
      [144, 10],
      [144, 15],
      [144, 20],
      [100, 'AcDbBlockHorizontalConstraintParameter'],
    ],
  });
  con.push({ id: 5, handle: H(), type: 'ACDB_DYNAMICBLOCKPROXYNODE', body: [[100, 'AcDbEvalExpr'], [90, 5], [98, 33], [99, 329]] });
  con.push({ id: 6, handle: H(), type: 'BLOCKFLIPPARAMETER', body: [...head(6, 'Flip'), ...param, ...twoPt([0, -3], [0, 3], []), [100, 'AcDbBlockFlipParameter'], [305, '반전'], [306, ''], [307, ''], [308, ''], ...P(1012, 0, 4), [309, ''], [96, 0]] });
  con.push({
    id: 7,
    handle: H(),
    type: 'BLOCKFLIPACTION',
    body: [...action(7, 'Flip', [1], [h.l1!, h.l2!]), [100, 'AcDbBlockFlipAction'], [92, 6], [93, 6], [94, 6], [95, 6], [301, 'Flip'], [302, 'UpdatedFlip'], [303, 'UpdatedBase'], [304, 'UpdatedEnd']],
  });
  const conEdges: [number, number][] = [[6, 7]];

  // ------------------------------------------------------- 문서
  const o = new Out();
  o.rec('SECTION', [[2, 'HEADER']]);
  for (const [c, v] of [[9, '$ACADVER'], [1, 'AC1032'], [9, '$INSUNITS'], [70, 4], [9, '$HANDSEED'], [5, 'FFFF']] as Tag[]) o.tag(c, v);
  o.rec('ENDSEC', []);
  o.rec('SECTION', [[2, 'TABLES']]);
  o.rec('TABLE', [[2, 'LAYER'], [5, '2'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 1]]);
  o.rec('LAYER', [[5, '10'], [330, '2'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbLayerTableRecord'], [2, '0'], [70, 0], [62, 7], [6, 'Continuous']]);
  o.rec('ENDTAB', []);
  o.rec('TABLE', [[2, 'BLOCK_RECORD'], [5, '1'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 5]]);
  const br = (hh: string, nm: string, xd?: string) =>
    o.rec('BLOCK_RECORD', [[5, hh], ...(xd ? ([[102, '{ACAD_XDICTIONARY'], [360, xd], [102, '}']] as Tag[]) : []), [330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbBlockTableRecord'], [2, nm], [340, '0'], [70, 4], [280, 1], [281, 0]]);
  br('1F', '*Model_Space');
  br('1B', '*Paper_Space');
  br(h.recA!, 'ARR-TEST', h.xdA);
  br(h.recG!, 'ALIGN-TEST', h.xdG);
  br(h.recK!, 'CON-TEST', h.xdK);
  o.rec('ENDTAB', []);
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'BLOCKS']]);
  const block = (begin: string, end: string, rec: string, nm: string, body: () => void) => {
    o.rec('BLOCK', [[5, begin], [330, rec], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockBegin'], [2, nm], [70, 0], ...P(10, 0, 0), [3, nm], [1, '']]);
    body();
    o.rec('ENDBLK', [[5, end], [330, rec], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockEnd']]);
  };
  block('20', '21', '1F', '*Model_Space', () => {});
  block('1C', '1D', '1B', '*Paper_Space', () => {});
  block(h.beginA!, h.endA!, h.recA!, 'ARR-TEST', () => {
    o.rec('CIRCLE', [...ent(h.c!, h.recA!, 'AcDbCircle'), ...P(10, 0, 0), [40, 1], ...etag(0, h.c!)]);
    o.rec('LINE', line(h.l!, h.recA!, [0, -0.5], [0, 0.5], etag(1, h.l!)));
    o.rec('CIRCLE', [...ent(h.pc!, h.recA!, 'AcDbCircle'), ...P(10, 5, 0), [40, 1], ...bedit, ...etag(2, h.pc!)]);
    o.rec('LINE', line(h.pl1!, h.recA!, [3, -0.5], [3, 0.5], [...bedit, ...etag(3, h.pl1!)]));
    o.rec('LINE', line(h.pl2!, h.recA!, [0, 1.5], [0, 2.5], [...bedit, ...etag(4, h.pl2!)]));
    o.rec('LINE', line(h.pl3!, h.recA!, [3, 1.5], [3, 2.5], [...bedit, ...etag(5, h.pl3!)]));
  });
  block(h.beginG!, h.endG!, h.recG!, 'ALIGN-TEST', () => o.rec('LINE', line(h.gl!, h.recG!, [0, 0], [4, 0], etag(0, h.gl!))));
  block(h.beginK!, h.endK!, h.recK!, 'CON-TEST', () => {
    o.rec('LINE', line(h.l1!, h.recK!, [0, 0], [10, 0], etag(0, h.l1!)));
    o.rec('LINE', line(h.l2!, h.recK!, [10, 0], [10, 5], etag(1, h.l2!)));
  });
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'ENTITIES']]);
  const insert = (hh: string, nm: string, x: number, y: number) => o.rec('INSERT', [[5, hh], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockReference'], [2, nm], ...P(10, x, y)]);
  insert(h.insR!, 'ARR-TEST', 0, 0);
  insert(h.insG!, 'ALIGN-TEST', 100, 100);
  insert(h.insK!, 'CON-TEST', 0, -50);
  o.rec('LINE', line(h.lineS!, '1F', [0, 50], [100, 150]));
  o.rec('ENDSEC', []);

  o.rec('SECTION', [[2, 'OBJECTS']]);
  o.rec('DICTIONARY', [[5, 'C'], [330, '0'], [100, 'AcDbDictionary'], [281, 1], [3, 'ACAD_GROUP'], [350, 'D']]);
  o.rec('DICTIONARY', [[5, 'D'], [102, '{ACAD_REACTORS'], [330, 'C'], [102, '}'], [330, 'C'], [100, 'AcDbDictionary'], [281, 1]]);
  const defObjects = (xd: string, rec: string, g: string, nodes: Node[], edges: [number, number][], more: [string, string][] = []) => {
    o.rec('DICTIONARY', dict(xd, rec, [['ACAD_ENHANCEDBLOCK', g], ...more], 0));
    o.rec('ACAD_EVALUATION_GRAPH', graph(g, xd, nodes, edges));
    for (const n of nodes) o.rec(n.type, [[5, n.handle], [330, g], ...n.body]);
  };
  defObjects(h.xdA!, h.recA!, h.graphA!, arr, arrEdges);
  defObjects(h.xdG!, h.recG!, h.graphG!, al, alEdges);
  defObjects(h.xdK!, h.recK!, h.graphK!, con, conEdges, [['ACAD_ASSOCNETWORK', h.netDict!]]);
  // 연관 망: 망 → 구속 그룹·변수, 그룹 → 형상 종속 둘·값 종속·치수 종속(몸체 BLOCKPARAMDEPENDENCYBODY, 대상 = 구속 매개변수)
  o.rec('DICTIONARY', dict(h.netDict!, h.xdK!, [['ACAD_ASSOCNETWORK', h.network!]], 1));
  const raw = (t: RawTag[]): Tag[] => t.map((x) => [x.code, x.value]);
  o.rec('ACDBASSOCNETWORK', [[5, h.network!], [330, h.netDict!], ...assocHead('0', '0', 0, 0), [100, 'AcDbAssocNetwork'], [90, 0], [90, 2], [90, 2], [360, h.group!], [360, h.variable!], [90, 0]]);
  const gh = { group: h.group!, depL1: h.depL1!, depL2: h.depL2!, valueDep: h.valueDep!, dimDep: h.dimDep!, dimBody: h.dimBody!, variable: h.variable!, l1: h.l1!, l2: h.l2!, dim: wH };
  o.rec('ACDBASSOC2DCONSTRAINTGROUP', [[5, h.group!], [330, h.network!], ...raw(groupTags(gh, h.network!, 2))]);
  const geomDep = (hh: string, target: string, index: number) => o.rec('ACDBASSOCGEOMDEPENDENCY', [[5, hh], [330, h.group!], ...dependency(target, 1, 1, -10000, '0', index), [100, 'AcDbAssocGeomDependency'], [90, 0], [290, 1], [1, 'AcDbAssocSingleEdgePersSubentId'], [290, 0]]);
  geomDep(h.depL1!, h.l1!, 1);
  geomDep(h.depL2!, h.l2!, 2);
  o.rec('ACDBASSOCVALUEDEPENDENCY', [[5, h.valueDep!], [330, h.group!], ...dependency(h.variable!, 1, 0, 0, '0', 3), [100, 'AcDbAssocValueDependency'], [90, 0], [1, ''], [90, 10]]);
  o.rec('ACDBASSOCDEPENDENCY', [[5, h.dimDep!], [330, h.group!], ...dependency(wH, 0, 1, 0, h.dimBody!, 4)]);
  o.rec('BLOCKPARAMDEPENDENCYBODY', [[5, h.dimBody!], [330, h.dimDep!], [100, 'AcDbAssocDependencyBody'], [90, 1], [100, 'AcDbImpAssocDimDependencyBodyBase'], [90, 1], [1, 'W=10'], [100, 'AcDbBlockParameterDependencyBody'], [90, 0]]);
  o.rec('ACDBASSOCVARIABLE', [[5, h.variable!], [330, h.network!], ...assocHead(h.network!, '0', 2, 0), [100, 'AcDbAssocVariable'], [90, 2], [1, 'W'], [1, ''], [1, 'AcDbCalc:1.0'], [1, ''], [90, 10], [290, 0], [290, 0], [90, 0]]);
  o.rec('ENDSEC', []);
  o.tag(0, 'EOF');
  return { text: o.lines.join('\n') + '\n', h };
}

export function loadFixture2(): { doc: CadDocument; h: Record<string, string> } {
  const f = dynFixture2();
  return { doc: loadDyn(f.text), h: f.h };
}
