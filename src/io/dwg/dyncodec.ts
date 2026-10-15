/**
 * 동적 블록 객체의 DWG 본문 ↔ DXF와 같은 원본 태그(GenericObject.raw).
 *
 * 사양(ODA Open Design Specification)에 없는 객체다. AutoCAD가 같은 도면을 DWG와 DXF로 저장한 짝(같은 핸들)을 맞춰
 * 배치를 정했다(src/io/dwg/NOTES.md "동적 블록 객체"):
 * - ACadSharp sample_AC1015~AC1032(my-dynamic-block): 그래프·가시성·선형·축척·그립·위치 식·지움 막기·표현 자료.
 * - 공개 도면(ACadSharp samples/dynamic-blocks, R2018 짝 10쌍, 그리고 다른 공개 짝 하나): 뒤집기·XY·회전·조회·점·
 *   기준점·정렬·극좌표 매개변수, 이동·신축·회전·뒤집기·배열·조회·극좌표 신축 동작과 그 그립.
 *
 * - 읽기(decodeDyn): 공통 자료 다음의 자료·문자열·핸들 흐름을 읽어 DXF 순서의 태그를 만든다. 배치가 맞지 않는 값
 *   (모르는 값 종류, DXF 코드를 확인하지 못한 목록 등)을 만나면 DynLayoutError를 던진다 — 부르는 쪽은 원본 비트만 남긴다.
 * - 쓰기(encodeDyn): 태그를 DWG 순서의 쓰기 명령 목록으로 바꾼다. 풀 수 없는 태그면 null.
 *   DXF에 없는 DWG 값(평가식 머리 -1, 값 없음 -9999 등)은 표본의 값으로 채우고, DWG에 없는 DXF 자리 표시(빈 문자열)는 버린다.
 *
 * DWG와 DXF의 순서가 다른 곳이 많아(연결 목록이 그립 번호보다 앞, 동작의 표시 위치가 맨 앞 등) 서브클래스마다
 * 읽기·쓰기 함수를 나란히 둔다. 같은 배치인지는 표본 객체를 풀었다 다시 쓴 비트가 원본과 같은지로 시험한다
 * (tests/dwg/dynblock.test.ts).
 */
import type { RawTag, Vec3 } from '../../core/model';
import type { BitReader } from './bitstream';
import { R2007 } from './version';

/** DWG에서 DXF 태그로 풀고 다시 쓸 수 있는 종류 */
export const DYN_TYPES = new Set([
  'ACDB_BLOCKREPRESENTATION_DATA',
  'ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION',
  'ACAD_EVALUATION_GRAPH',
  'BLOCKGRIPLOCATIONCOMPONENT',
  // 매개변수
  'BLOCKVISIBILITYPARAMETER',
  'BLOCKLINEARPARAMETER',
  'BLOCKFLIPPARAMETER',
  'BLOCKROTATIONPARAMETER',
  'BLOCKXYPARAMETER',
  'BLOCKPOLARPARAMETER',
  'BLOCKPOINTPARAMETER',
  'BLOCKLOOKUPPARAMETER',
  'BLOCKBASEPOINTPARAMETER',
  'BLOCKALIGNMENTPARAMETER',
  // 그립
  'BLOCKVISIBILITYGRIP',
  'BLOCKLINEARGRIP',
  'BLOCKFLIPGRIP',
  'BLOCKROTATIONGRIP',
  'BLOCKXYGRIP',
  'BLOCKPOLARGRIP',
  'BLOCKLOOKUPGRIP',
  'BLOCKALIGNMENTGRIP',
  // 동작
  'BLOCKSCALEACTION',
  'BLOCKMOVEACTION',
  'BLOCKSTRETCHACTION',
  'BLOCKROTATEACTION',
  'BLOCKFLIPACTION',
  'BLOCKARRAYACTION',
  'BLOCKLOOKUPACTION',
  'BLOCKPOLARSTRETCHACTION',
]);

export class DynLayoutError extends Error {}

const fail = (what: string): never => {
  throw new DynLayoutError(what);
};

// ---------------------------------------------------------------------------
// 공용

const HARD_OWNER = 3;
const SOFT_PTR = 4;
const HARD_PTR = 5;

const hexOf = (h: number): string => (h > 0 ? h.toString(16).toUpperCase() : '0');

/** 쓰기 명령 */
export type DynOp =
  | { t: 'B' | 'RC' | 'BS' | 'BL' | 'BD' | 'RD'; v: number }
  | { t: 'TV'; v: string }
  | { t: '3BD'; v: Vec3 }
  | { t: 'H'; code: number; h: string };

/** 읽기: 자료·핸들 흐름(R2007+ 문자열은 dat.strReader) */
class In {
  readonly tags: RawTag[] = [];
  constructor(
    readonly r: BitReader,
    readonly hr: BitReader,
    readonly base: number,
  ) {}
  B = () => this.r.B();
  RC = () => this.r.RC();
  BS = () => this.r.BS();
  BL = () => this.r.BL();
  BD = () => this.r.BD();
  RD = () => this.r.RD();
  TV = () => this.r.TV();
  P = () => this.r.BD3();
  H = () => hexOf(this.hr.H(this.base));
  /** 개수(BL). 남은 자료 비트로 가능한지 본다 */
  N = (min = 1) => this.r.checkCount(this.r.BL(), min);
  /** 핸들 개수(BL). 남은 핸들 비트로 가능한지 본다(핸들 하나는 8비트 이상) */
  NH = () => this.hr.checkCount(this.r.BL(), 8);
  tag(code: number, value: string | number): void {
    this.tags.push({ code, value });
  }
  pt(code: number, p: Vec3): void {
    this.tags.push({ code, value: p.x }, { code: code + 10, value: p.y }, { code: code + 20, value: p.z });
  }
  sub(name: string): void {
    this.tags.push({ code: 100, value: name });
  }
}

/** 쓰기: 명령 목록 */
class Out {
  readonly ops: DynOp[] = [];
  B = (v: number) => this.ops.push({ t: 'B', v: v ? 1 : 0 });
  RC = (v: number) => this.ops.push({ t: 'RC', v });
  BS = (v: number) => this.ops.push({ t: 'BS', v });
  BL = (v: number) => this.ops.push({ t: 'BL', v });
  BD = (v: number) => this.ops.push({ t: 'BD', v });
  RD = (v: number) => this.ops.push({ t: 'RD', v });
  TV = (v: string) => this.ops.push({ t: 'TV', v });
  P = (v: Vec3) => this.ops.push({ t: '3BD', v });
  H = (code: number, h: string) => this.ops.push({ t: 'H', code, h });
}

const num = (v: string | number | undefined, d = 0): number => {
  if (v === undefined) return d;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : d;
};
const int = (v: string | number | undefined, d = 0): number => Math.trunc(num(v, d));
const str = (v: string | number | undefined): string => (v === undefined ? '' : String(v));
const handle = (v: string | number | undefined): string => str(v).trim().toUpperCase();

/** 서브클래스 하나의 태그를 차례로 읽는 커서(쓰기 쪽) */
class Cur {
  i = 0;
  constructor(readonly tags: readonly RawTag[]) {}
  has(code: number): boolean {
    return this.tags[this.i]?.code === code;
  }
  /** 기대한 코드면 값을 꺼낸다. 아니면 기본값(선택 태그) */
  opt(code: number): string | number | undefined {
    const t = this.tags[this.i];
    if (!t || t.code !== code) return undefined;
    this.i++;
    return t.value;
  }
  /** 기대한 코드여야 한다 */
  need(code: number): string | number {
    const v = this.opt(code);
    if (v === undefined) fail(`태그 ${code}`);
    return v!;
  }
  int(code: number): number {
    return int(this.need(code));
  }
  num(code: number): number {
    return num(this.need(code));
  }
  str(code: number): string {
    return str(this.need(code));
  }
  handle(code: number): string {
    return handle(this.need(code));
  }
  pt(code: number): Vec3 {
    const x = num(this.need(code));
    const y = num(this.opt(code + 10));
    const z = num(this.opt(code + 20));
    return { x, y, z };
  }
  /** DXF에만 있는 빈 문자열 자리(DWG에는 없다). 있으면 비어 있어야 한다 */
  blank(code: number): void {
    if (str(this.opt(code)).trim() !== '') fail(`빈 자리 ${code}`);
  }
  /** 남은 태그가 없어야 한다 */
  end(): void {
    if (this.i < this.tags.length) fail(`남은 태그 ${this.tags[this.i]!.code}`);
  }
}

/** 원본 태그를 서브클래스 표지(100, 대문자로)로 나눈다(표지 앞의 태그는 ''). 같은 이름이 둘이면 null.
 *  표지의 대소문자는 가리지 않는다(AutoCAD는 AcDbBlockLookUpGrip, 다른 프로그램은 AcDbBlockLookupGrip로 쓰기도 한다 — DWG에는 표지가 없다) */
function split(raw: readonly RawTag[] | undefined): Map<string, RawTag[]> | null {
  const out = new Map<string, RawTag[]>();
  let cur: RawTag[] | null = null;
  for (const t of raw ?? []) {
    if (t.code === 100) {
      const name = str(t.value).trim().toUpperCase();
      if (out.has(name)) return null;
      cur = [];
      out.set(name, cur);
      continue;
    }
    if (!cur) {
      cur = [];
      out.set('', cur);
    }
    cur.push(t);
  }
  return out;
}

class Subs {
  readonly used = new Set<string>();
  constructor(readonly m: Map<string, RawTag[]>) {}
  cur(name: string): Cur {
    name = name.toUpperCase();
    const t = this.m.get(name);
    if (!t) fail(`서브클래스 ${name}`);
    this.used.add(name);
    return new Cur(t!);
  }
  /** 쓰지 않은 서브클래스(다른 프로그램이 덧붙인 자료 등)가 있으면 DWG에 담을 수 없다 */
  end(): void {
    for (const k of this.m.keys()) if (k !== '' && !this.used.has(k)) fail(`모르는 서브클래스 ${k}`);
  }
}

// ---------------------------------------------------------------------------
// AcDbEvalExpr: DWG BL -1, BL 98, BL 99, BS 70 값 종류(-9999 없음, 40 실수 + BD, 70 정수 + BS), BL 90 노드 번호.
// DXF: 90, 98, 99, (값이 있으면) 1 "", 70 값 종류, 값(40 → 140, 70 → 70).

const NO_VALUE = -9999;

function rEvalExpr(i: In): void {
  if (i.BL() !== -1) fail('평가식 머리');
  const v98 = i.BL();
  const v99 = i.BL();
  const vt = i.BS();
  let value: number | undefined;
  if (vt === 40) value = i.BD();
  else if (vt === 70) value = i.BS();
  else if (vt !== NO_VALUE) fail(`값 종류 ${vt}`);
  const id = i.BL();
  i.sub('AcDbEvalExpr');
  i.tag(90, id);
  i.tag(98, v98);
  i.tag(99, v99);
  if (value !== undefined) {
    i.tag(1, '');
    i.tag(70, vt);
    i.tag(vt === 40 ? 140 : 70, value);
  }
}

function wEvalExpr(o: Out, s: Subs): void {
  const c = s.cur('AcDbEvalExpr');
  const id = c.int(90);
  const v98 = c.int(98);
  const v99 = c.int(99);
  let vt = NO_VALUE;
  let value = 0;
  if (c.has(1) || c.has(70)) {
    if (str(c.opt(1)) !== '') fail('평가식 이름');
    vt = c.int(70);
    if (vt === 40) value = c.num(140);
    else if (vt === 70) value = c.int(70);
    else fail(`값 종류 ${vt}`);
  }
  c.end();
  o.BL(-1);
  o.BL(v98);
  o.BL(v99);
  o.BS(vt);
  if (vt === 40) o.BD(value);
  else if (vt === 70) o.BS(value);
  o.BL(id);
}

// AcDbBlockElement: TV 300 이름, BL 98, BL 99(판), BL 1071.
// 판은 파일 버전을 따른다: AutoCAD는 R2004 이전 DWG·DXF에 25/104, R2007 이후에 저장한 프로그램의 판(33/329 …)을 쓴다.

/** AutoCAD 2018이 R2004 이전 형식에 쓰는 블록 요소 판 */
const ELEMENT_OLD = [25, 104] as const;
/** AutoCAD 2018이 R2007 이후 형식에 쓰는 블록 요소 판 */
const ELEMENT_NEW = [33, 329] as const;

function rElement(i: In): void {
  i.sub('AcDbBlockElement');
  i.tag(300, i.TV());
  i.tag(98, i.BL());
  i.tag(99, i.BL());
  i.tag(1071, i.BL());
}

function wElement(o: Out, s: Subs, ver: number): void {
  const c = s.cur('AcDbBlockElement');
  const name = c.str(300);
  let v98 = c.int(98);
  let v99 = c.int(99);
  const e = c.int(1071);
  c.end();
  // 다른 형식 계열로 쓸 때는 AutoCAD가 그 형식에 쓰는 판으로
  if (ver < R2007 && v98 > ELEMENT_OLD[0]) [v98, v99] = ELEMENT_OLD;
  else if (ver >= R2007 && v98 <= ELEMENT_OLD[0]) [v98, v99] = ELEMENT_NEW;
  o.TV(name);
  o.BL(v98);
  o.BL(v99);
  o.BL(e);
}

/** 평가식 + 블록 요소 */
function rHead(i: In): void {
  rEvalExpr(i);
  rElement(i);
}
function wHead(o: Out, s: Subs, ver: number): void {
  wEvalExpr(o, s);
  wElement(o, s, ver);
}

// AcDbBlockParameter: B 280 특성 보이기, B 281 동작 사슬
function rParam(i: In): void {
  rHead(i);
  i.sub('AcDbBlockParameter');
  i.tag(280, i.B());
  i.tag(281, i.B());
}
function wParam(o: Out, s: Subs, ver: number): void {
  wHead(o, s, ver);
  const c = s.cur('AcDbBlockParameter');
  const show = c.int(280);
  const chain = c.int(281);
  c.end();
  o.B(show);
  o.B(chain);
}

// 연결(노드 번호 + 속성 이름): DWG BL 노드, TV 속성
interface Conn {
  node: number;
  prop: string;
}
const rConn = (i: In): Conn => ({ node: i.BL(), prop: i.TV() });
function wConn(o: Out, c: Conn): void {
  o.BL(c.node);
  o.TV(c.prop);
}
/** 연결 목록: BL 개수, (BL 노드, TV 속성)… */
function rConns(i: In): Conn[] {
  const n = i.N(3);
  const out: Conn[] = [];
  for (let k = 0; k < n; k++) out.push(rConn(i));
  return out;
}
function wConns(o: Out, list: Conn[]): void {
  o.BL(list.length);
  for (const c of list) wConn(o, c);
}
/** DXF 연결 목록(개수 코드 + (노드 코드, 속성 코드)…) 읽기·쓰기 */
function tConns(i: In, list: Conn[], nc: number, node: number, prop: number): void {
  i.tag(nc, list.length);
  for (const c of list) {
    i.tag(node, c.node);
    i.tag(prop, c.prop);
  }
}
function cConns(c: Cur, nc: number, node: number, prop: number): Conn[] {
  const n = c.int(nc);
  const list: Conn[] = [];
  for (let k = 0; k < n; k++) list.push({ node: c.int(node), prop: c.str(prop) });
  return list;
}

// AcDbBlock1PtParameter: 3BD 1010, 연결 목록 둘, BL 93 그립 노드.
// DXF: 1010, 93, 170 + (91 노드, 301 속성)…, 171 + (92 노드, 302 속성)…(점 매개변수 짝 표본).
function r1Pt(i: In): void {
  const p = i.P();
  const a = rConns(i);
  const b = rConns(i);
  const g = i.BL();
  i.sub('AcDbBlock1PtParameter');
  i.pt(1010, p);
  i.tag(93, g);
  tConns(i, a, 170, 91, 301);
  tConns(i, b, 171, 92, 302);
}
function w1Pt(o: Out, s: Subs): void {
  const c = s.cur('AcDbBlock1PtParameter');
  const p = c.pt(1010);
  const g = c.int(93);
  const a = cConns(c, 170, 91, 301);
  const b = cConns(c, 171, 92, 302);
  c.end();
  o.P(p);
  wConns(o, a);
  wConns(o, b);
  o.BL(g);
}

// AcDbBlock2PtParameter: 3BD 1010, 3BD 1011, 연결 목록 넷(DXF 171+92/301, 172+93/302, 173+94/303, 174+95/304),
// BL 그립 노드 넷(DXF 170 = 4 + 91…), BS 177 기준 위치.
const CONN2 = [
  [171, 92, 301],
  [172, 93, 302],
  [173, 94, 303],
  [174, 95, 304],
] as const;

function r2Pt(i: In): void {
  const a = i.P();
  const b = i.P();
  const conns = CONN2.map(() => rConns(i));
  const grips = [i.BL(), i.BL(), i.BL(), i.BL()];
  const loc = i.BS();
  i.sub('AcDbBlock2PtParameter');
  i.pt(1010, a);
  i.pt(1011, b);
  i.tag(170, 4);
  for (const g of grips) i.tag(91, g);
  CONN2.forEach(([nc, node, prop], k) => tConns(i, conns[k]!, nc, node, prop));
  i.tag(177, loc);
}
function w2Pt(o: Out, s: Subs): void {
  const c = s.cur('AcDbBlock2PtParameter');
  const a = c.pt(1010);
  const b = c.pt(1011);
  if (c.int(170) !== 4) fail('2점 매개변수 그립 수');
  const grips = [c.int(91), c.int(91), c.int(91), c.int(91)];
  const conns = CONN2.map(([nc, node, prop]) => cConns(c, nc, node, prop));
  const loc = c.int(177);
  c.end();
  o.P(a);
  o.P(b);
  for (const l of conns) wConns(o, l);
  for (const g of grips) o.BL(g);
  o.BS(loc);
}

/**
 * 값 집합: BL 종류, BD 최소, BD 최대, BD 증분, BS 개수 + BD 값…
 * 목록의 DXF 코드는 선형·회전(144)만 확인했다. list가 null이면 목록이 비어 있어야 푼다.
 */
interface VSCodes {
  type: number;
  min: number;
  max: number;
  inc: number;
  count: number;
  list: number | null;
}
const VS_LINEAR: VSCodes = { type: 96, min: 141, max: 142, inc: 143, count: 175, list: 144 };

function rValueSet(i: In, k: VSCodes): void {
  i.tag(k.type, i.BL());
  i.tag(k.min, i.BD());
  i.tag(k.max, i.BD());
  i.tag(k.inc, i.BD());
  const n = i.r.checkCount(i.BS(), 2);
  if (n && k.list === null) fail('값 목록 코드');
  i.tag(k.count, n);
  for (let j = 0; j < n; j++) i.tag(k.list!, i.BD());
}
function wValueSet(o: Out, c: Cur, k: VSCodes): void {
  o.BL(c.int(k.type));
  o.BD(c.num(k.min));
  o.BD(c.num(k.max));
  o.BD(c.num(k.inc));
  const n = c.int(k.count);
  if (n && k.list === null) fail('값 목록 코드');
  o.BS(n);
  for (let j = 0; j < n; j++) o.BD(c.num(k.list!));
}

// ---------------------------------------------------------------------------
// 매개변수

/** AcDbBlockVisibilityParameter: B 281, TV 301 레이블, TV 302 설명, B 91, BL 93 + H 331…(다루는 객체),
 *  BL 92 상태 수, 상태마다 TV 303 이름, BL 94 + H 332…(보이는 객체), BL 95 + H 333…(노드) */
function rVisibility(i: In): void {
  rParam(i);
  r1Pt(i);
  i.sub('AcDbBlockVisibilityParameter');
  i.tag(281, i.B());
  i.tag(301, i.TV());
  i.tag(302, i.TV());
  i.tag(91, i.B());
  const n = i.NH();
  i.tag(93, n);
  for (let k = 0; k < n; k++) i.tag(331, i.H());
  const m = i.N(4);
  i.tag(92, m);
  for (let k = 0; k < m; k++) {
    i.tag(303, i.TV());
    const a = i.NH();
    i.tag(94, a);
    for (let j = 0; j < a; j++) i.tag(332, i.H());
    const b = i.NH();
    i.tag(95, b);
    for (let j = 0; j < b; j++) i.tag(333, i.H());
  }
}
function wVisibility(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w1Pt(o, s);
  const c = s.cur('AcDbBlockVisibilityParameter');
  o.B(c.int(281));
  o.TV(c.str(301));
  o.TV(c.str(302));
  o.B(c.int(91));
  const n = c.int(93);
  o.BL(n);
  for (let k = 0; k < n; k++) o.H(SOFT_PTR, c.handle(331));
  const m = c.int(92);
  o.BL(m);
  for (let k = 0; k < m; k++) {
    o.TV(c.str(303));
    const a = c.int(94);
    o.BL(a);
    for (let j = 0; j < a; j++) o.H(SOFT_PTR, c.handle(332));
    const b = c.int(95);
    o.BL(b);
    for (let j = 0; j < b; j++) o.H(SOFT_PTR, c.handle(333));
  }
  c.end();
}

/** AcDbBlockLinearParameter: TV 305 레이블, TV 306 설명, BD 140 레이블 거리, 값 집합(96, 141~143, 175 + 144…).
 *  DXF는 140 다음에 307(빈 문자열)을 둔다(DWG에는 없다). */
function rLinear(i: In): void {
  rParam(i);
  r2Pt(i);
  i.sub('AcDbBlockLinearParameter');
  i.tag(305, i.TV());
  i.tag(306, i.TV());
  i.tag(140, i.BD());
  i.tag(307, '');
  rValueSet(i, VS_LINEAR);
}
function wLinear(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w2Pt(o, s);
  const c = s.cur('AcDbBlockLinearParameter');
  o.TV(c.str(305));
  o.TV(c.str(306));
  o.BD(c.num(140));
  c.blank(307);
  wValueSet(o, c, VS_LINEAR);
  c.end();
}

/** AcDbBlockFlipParameter: TV 305 레이블, TV 306 설명, TV 307 기준 상태, TV 308 뒤집힌 상태, 3BD 1012 레이블 위치,
 *  BL 96 + TV 309(연결). DXF 순서: 305~308, 1012, 309, 96. */
function rFlip(i: In): void {
  rParam(i);
  r2Pt(i);
  const t = [i.TV(), i.TV(), i.TV(), i.TV()];
  const at = i.P();
  const c = rConn(i);
  i.sub('AcDbBlockFlipParameter');
  t.forEach((v, k) => i.tag(305 + k, v));
  i.pt(1012, at);
  i.tag(309, c.prop);
  i.tag(96, c.node);
}
function wFlip(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w2Pt(o, s);
  const c = s.cur('AcDbBlockFlipParameter');
  const t = [c.str(305), c.str(306), c.str(307), c.str(308)];
  const at = c.pt(1012);
  const prop = c.str(309);
  const node = c.int(96);
  c.end();
  for (const v of t) o.TV(v);
  o.P(at);
  wConn(o, { node, prop });
}

/** AcDbBlockRotationParameter: TV 305, TV 306, 3BD 1011 기준 각도 점, BD 140 레이블 거리, 값 집합(96, 141~143, 175 + 144…).
 *  DXF는 140 다음에 307(빈 문자열)을 둔다. */
function rRotation(i: In): void {
  rParam(i);
  r2Pt(i);
  i.sub('AcDbBlockRotationParameter');
  i.tag(305, i.TV());
  i.tag(306, i.TV());
  i.pt(1011, i.P());
  i.tag(140, i.BD());
  i.tag(307, '');
  rValueSet(i, VS_LINEAR);
}
function wRotation(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w2Pt(o, s);
  const c = s.cur('AcDbBlockRotationParameter');
  o.TV(c.str(305));
  o.TV(c.str(306));
  o.P(c.pt(1011));
  o.BD(c.num(140));
  c.blank(307);
  wValueSet(o, c, VS_LINEAR);
  c.end();
}

/**
 * AcDbBlockXYParameter: TV 305 Y 레이블, TV 306 X 레이블, TV 307 Y 설명, TV 308 X 설명(예제 도면의 "높이"·"폭"),
 * BD 141, BD 140(레이블 거리), 값 집합 Y(97, 146~148, 176), 값 집합 X(96, 142~144, 175).
 * DXF는 140 다음에 309, 첫 값 집합 다음에 410(빈 문자열)을 둔다. 값 목록의 DXF 코드는 확인하지 못해 목록이 있으면 풀지 않는다.
 */
const VS_XY_Y: VSCodes = { type: 97, min: 146, max: 147, inc: 148, count: 176, list: null };
const VS_XY_X: VSCodes = { type: 96, min: 142, max: 143, inc: 144, count: 175, list: null };
function rXY(i: In): void {
  rParam(i);
  r2Pt(i);
  i.sub('AcDbBlockXYParameter');
  for (let k = 0; k < 4; k++) i.tag(305 + k, i.TV());
  i.tag(141, i.BD());
  i.tag(140, i.BD());
  i.tag(309, '');
  rValueSet(i, VS_XY_Y);
  i.tag(410, '');
  rValueSet(i, VS_XY_X);
}
function wXY(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w2Pt(o, s);
  const c = s.cur('AcDbBlockXYParameter');
  for (let k = 0; k < 4; k++) o.TV(c.str(305 + k));
  o.BD(c.num(141));
  o.BD(c.num(140));
  c.blank(309);
  wValueSet(o, c, VS_XY_Y);
  c.blank(410);
  wValueSet(o, c, VS_XY_X);
  c.end();
}

/**
 * AcDbBlockPolarParameter: TV 305 거리 레이블, TV 306 거리 설명, TV 307 각도 레이블, TV 308 각도 설명, BD 140 레이블 거리,
 * 값 집합 거리(96, 141~143, 175), 값 집합 각도(97, 145~147, 176). DXF는 140 다음에 309, 거리 값 집합 다음에 410(빈 문자열).
 * 값 목록의 DXF 코드는 확인하지 못해 목록이 있으면 풀지 않는다.
 */
const VS_POLAR_D: VSCodes = { type: 96, min: 141, max: 142, inc: 143, count: 175, list: null };
const VS_POLAR_A: VSCodes = { type: 97, min: 145, max: 146, inc: 147, count: 176, list: null };
function rPolar(i: In): void {
  rParam(i);
  r2Pt(i);
  i.sub('AcDbBlockPolarParameter');
  for (let k = 0; k < 4; k++) i.tag(305 + k, i.TV());
  i.tag(140, i.BD());
  i.tag(309, '');
  rValueSet(i, VS_POLAR_D);
  i.tag(410, '');
  rValueSet(i, VS_POLAR_A);
}
function wPolar(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w2Pt(o, s);
  const c = s.cur('AcDbBlockPolarParameter');
  for (let k = 0; k < 4; k++) o.TV(c.str(305 + k));
  o.BD(c.num(140));
  c.blank(309);
  wValueSet(o, c, VS_POLAR_D);
  c.blank(410);
  wValueSet(o, c, VS_POLAR_A);
  c.end();
}

/** AcDbBlockAlignmentParameter: B 280 수직 정렬 */
function rAlignment(i: In): void {
  rParam(i);
  r2Pt(i);
  i.sub('AcDbBlockAlignmentParameter');
  i.tag(280, i.B());
}
function wAlignment(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w2Pt(o, s);
  const c = s.cur('AcDbBlockAlignmentParameter');
  o.B(c.int(280));
  c.end();
}

/** AcDbBlockPointParameter: TV 303 레이블, TV 304 설명, 3BD 1011 레이블 위치 */
function rPoint(i: In): void {
  rParam(i);
  r1Pt(i);
  i.sub('AcDbBlockPointParameter');
  i.tag(303, i.TV());
  i.tag(304, i.TV());
  i.pt(1011, i.P());
}
function wPoint(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w1Pt(o, s);
  const c = s.cur('AcDbBlockPointParameter');
  o.TV(c.str(303));
  o.TV(c.str(304));
  o.P(c.pt(1011));
  c.end();
}

/** AcDbBlockLookUpParameter: TV 303 레이블, TV 304 설명, BL 94 조회 동작 노드 */
function rLookupParam(i: In): void {
  rParam(i);
  r1Pt(i);
  i.sub('AcDbBlockLookUpParameter');
  i.tag(303, i.TV());
  i.tag(304, i.TV());
  i.tag(94, i.BL());
}
function wLookupParam(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w1Pt(o, s);
  const c = s.cur('AcDbBlockLookUpParameter');
  o.TV(c.str(303));
  o.TV(c.str(304));
  o.BL(c.int(94));
  c.end();
}

/** AcDbBlockBasepointParameter: 3BD 1011, 3BD 1012 */
function rBasepoint(i: In): void {
  rParam(i);
  r1Pt(i);
  i.sub('AcDbBlockBasepointParameter');
  i.pt(1011, i.P());
  i.pt(1012, i.P());
}
function wBasepoint(o: Out, s: Subs, ver: number): void {
  wParam(o, s, ver);
  w1Pt(o, s);
  const c = s.cur('AcDbBlockBasepointParameter');
  o.P(c.pt(1011));
  o.P(c.pt(1012));
  c.end();
}

// ---------------------------------------------------------------------------
// 그립: AcDbBlockGrip BL 91·BL 92(위치 식 노드), 3BD 1010, B 280, BL 93

function rGrip(i: In): void {
  rHead(i);
  i.sub('AcDbBlockGrip');
  i.tag(91, i.BL());
  i.tag(92, i.BL());
  i.pt(1010, i.P());
  i.tag(280, i.B());
  i.tag(93, i.BL());
}
function wGrip(o: Out, s: Subs, ver: number): void {
  wHead(o, s, ver);
  const c = s.cur('AcDbBlockGrip');
  o.BL(c.int(91));
  o.BL(c.int(92));
  o.P(c.pt(1010));
  o.B(c.int(280));
  o.BL(c.int(93));
  c.end();
}

/** 방향(3BD, DXF 140·141·142) */
function rDir(i: In): void {
  const p = i.P();
  i.tag(140, p.x);
  i.tag(141, p.y);
  i.tag(142, p.z);
}
const cDir = (c: Cur): Vec3 => ({ x: c.num(140), y: c.num(141), z: c.num(142) });

/** 서브클래스에 자료가 없는 그립(가시성·회전·XY·극좌표·조회) */
function gripOnly(name: string): Codec {
  return [
    (i) => {
      rGrip(i);
      i.sub(name);
    },
    (o, s, ver) => {
      wGrip(o, s, ver);
      s.cur(name).end();
    },
  ];
}

/** 방향 하나만 더 있는 그립(선형·정렬): 3BD 방향(DXF 140·141·142) */
function gripDir(name: string): Codec {
  return [
    (i) => {
      rGrip(i);
      i.sub(name);
      rDir(i);
    },
    (o, s, ver) => {
      wGrip(o, s, ver);
      const c = s.cur(name);
      o.P(cDir(c));
      c.end();
    },
  ];
}

/** AcDbBlockFlipGrip: BL 93 뒤집기 상태 노드, 3BD 방향. DXF 순서 140·141·142, 93 */
function rFlipGrip(i: In): void {
  rGrip(i);
  i.sub('AcDbBlockFlipGrip');
  const n = i.BL();
  rDir(i);
  i.tag(93, n);
}
function wFlipGrip(o: Out, s: Subs, ver: number): void {
  wGrip(o, s, ver);
  const c = s.cur('AcDbBlockFlipGrip');
  const d = cDir(c);
  const n = c.int(93);
  c.end();
  o.BL(n);
  o.P(d);
}

/** BLOCKGRIPLOCATIONCOMPONENT: 평가식 + AcDbBlockGripExpr BL 91 매개변수 노드, TV 300 속성 이름 */
function rGripExpr(i: In): void {
  rEvalExpr(i);
  i.sub('AcDbBlockGripExpr');
  i.tag(91, i.BL());
  i.tag(300, i.TV());
}
function wGripExpr(o: Out, s: Subs): void {
  wEvalExpr(o, s);
  const c = s.cur('AcDbBlockGripExpr');
  o.BL(c.int(91));
  o.TV(c.str(300));
  c.end();
}

// ---------------------------------------------------------------------------
// 동작: AcDbBlockAction 3BD 1010 표시 위치, BL 71 + H 330…(선택 객체), BL 70 + BL 91…(선택 노드)
// DXF 순서: 70 + 91…, 71 + 330…, 1010.

function rAction(i: In): void {
  rHead(i);
  const at = i.P();
  const ne = i.NH();
  const ents: string[] = [];
  for (let k = 0; k < ne; k++) ents.push(i.H());
  const nn = i.N(2);
  const nodes: number[] = [];
  for (let k = 0; k < nn; k++) nodes.push(i.BL());
  i.sub('AcDbBlockAction');
  i.tag(70, nn);
  for (const n of nodes) i.tag(91, n);
  i.tag(71, ne);
  for (const h of ents) i.tag(330, h);
  i.pt(1010, at);
}
function wAction(o: Out, s: Subs, ver: number): void {
  wHead(o, s, ver);
  const c = s.cur('AcDbBlockAction');
  const nn = c.int(70);
  const nodes: number[] = [];
  for (let k = 0; k < nn; k++) nodes.push(c.int(91));
  const ne = c.int(71);
  const ents: string[] = [];
  for (let k = 0; k < ne; k++) ents.push(c.handle(330));
  const at = c.pt(1010);
  c.end();
  o.P(at);
  o.BL(ne);
  for (const h of ents) o.H(SOFT_PTR, h);
  o.BL(nn);
  for (const n of nodes) o.BL(n);
}

/**
 * AcDbBlockActionWithBasePt: 3BD 1011 기준점(오프셋), BL 92 + TV 301, BL 93 + TV 302(기준점 연결), B 280 종속, 3BD 1012.
 * DXF 순서: 92, 93, 301, 302, 1011, 280, 1012. 첫 3BD가 1011인 것은 독립 기준점 회전 동작의 공개 짝 도면으로 확인했다
 * (둘째 3BD는 본 표본 모두 0).
 */
function rActionBase(i: In): void {
  rAction(i);
  const off = i.P();
  const x = rConn(i);
  const y = rConn(i);
  const dep = i.B();
  const bp = i.P();
  i.sub('AcDbBlockActionWithBasePt');
  i.tag(92, x.node);
  i.tag(93, y.node);
  i.tag(301, x.prop);
  i.tag(302, y.prop);
  i.pt(1011, off);
  i.tag(280, dep);
  i.pt(1012, bp);
}
function wActionBase(o: Out, s: Subs, ver: number): void {
  wAction(o, s, ver);
  const c = s.cur('AcDbBlockActionWithBasePt');
  const xn = c.int(92);
  const yn = c.int(93);
  const xp = c.str(301);
  const yp = c.str(302);
  const off = c.pt(1011);
  const dep = c.int(280);
  const bp = c.pt(1012);
  c.end();
  o.P(off);
  wConn(o, { node: xn, prop: xp });
  wConn(o, { node: yn, prop: yp });
  o.B(dep);
  o.P(bp);
}

/** AcDbBlockScaleAction: (BL 94 + TV 303), (BL 95 + TV 304), (BL 96 + TV 305) 연결, 끝에 DXF에 없는 8비트(표본은 모두 0).
 *  DXF 순서: 94, 95, 96, 303, 304, 305. */
function rScale(i: In): void {
  rActionBase(i);
  const a = [0, 1, 2].map(() => rConn(i));
  if (i.RC() !== 0) fail('축척 동작 끝 바이트');
  i.sub('AcDbBlockScaleAction');
  a.forEach((c, k) => i.tag(94 + k, c.node));
  a.forEach((c, k) => i.tag(303 + k, c.prop));
}
function wScale(o: Out, s: Subs, ver: number): void {
  wActionBase(o, s, ver);
  const c = s.cur('AcDbBlockScaleAction');
  const nodes = [c.int(94), c.int(95), c.int(96)];
  const props = [c.str(303), c.str(304), c.str(305)];
  c.end();
  for (let k = 0; k < 3; k++) wConn(o, { node: nodes[k]!, prop: props[k]! });
  o.RC(0);
}

/** AcDbBlockRotationAction: BL 94 + TV 303(각도 연결) */
function rRotate(i: In): void {
  rActionBase(i);
  const a = rConn(i);
  i.sub('AcDbBlockRotationAction');
  i.tag(94, a.node);
  i.tag(303, a.prop);
}
function wRotate(o: Out, s: Subs, ver: number): void {
  wActionBase(o, s, ver);
  const c = s.cur('AcDbBlockRotationAction');
  const node = c.int(94);
  const prop = c.str(303);
  c.end();
  wConn(o, { node, prop });
}

/** 연결 n개(BL + TV). grouped면 DXF가 노드 코드를 먼저 모두, 그다음 속성 코드를 모두 쓴다(92…, 301…) */
function rConnBlock(i: In, n: number, grouped: boolean): void {
  const a: Conn[] = [];
  for (let k = 0; k < n; k++) a.push(rConn(i));
  if (grouped) {
    a.forEach((c, k) => i.tag(92 + k, c.node));
    a.forEach((c, k) => i.tag(301 + k, c.prop));
  } else
    a.forEach((c, k) => {
      i.tag(92 + k, c.node);
      i.tag(301 + k, c.prop);
    });
}
function wConnBlock(o: Out, c: Cur, n: number, grouped: boolean): void {
  const a: Conn[] = [];
  if (grouped) {
    const nodes = Array.from({ length: n }, (_, k) => c.int(92 + k));
    const props = Array.from({ length: n }, (_, k) => c.str(301 + k));
    for (let k = 0; k < n; k++) a.push({ node: nodes[k]!, prop: props[k]! });
  } else for (let k = 0; k < n; k++) a.push({ node: c.int(92 + k), prop: c.str(301 + k) });
  for (const x of a) wConn(o, x);
}

/** AcDbBlockMoveAction: (BL 92 + TV 301), (BL 93 + TV 302), BD 140 배율, BD 141 각도 오프셋, RC 280 XY 종류 */
function rMove(i: In): void {
  rAction(i);
  i.sub('AcDbBlockMoveAction');
  rConnBlock(i, 2, false);
  i.tag(140, i.BD());
  i.tag(141, i.BD());
  i.tag(280, i.RC());
}
function wMove(o: Out, s: Subs, ver: number): void {
  wAction(o, s, ver);
  const c = s.cur('AcDbBlockMoveAction');
  wConnBlock(o, c, 2, false);
  o.BD(c.num(140));
  o.BD(c.num(141));
  o.RC(c.int(280));
  c.end();
}

/**
 * AcDbBlockStretchAction: (BL 92 + TV 301), (BL 93 + TV 302), BL 72 + RD2 틀 점(DXF 1011·1021)…,
 * BL 73 + (H 331 객체, BL 74 + BL 94 신축점…)…, BL 75 + (BL 95 노드, BL 76 + BL 94 점…)…, BD 140, BD 141, RC 280.
 */
function rStretch(i: In): void {
  rAction(i);
  i.sub('AcDbBlockStretchAction');
  rConnBlock(i, 2, false);
  const nf = i.N(128);
  i.tag(72, nf);
  for (let k = 0; k < nf; k++) {
    i.tag(1011, i.RD());
    i.tag(1021, i.RD());
  }
  const ne = i.NH();
  i.tag(73, ne);
  for (let k = 0; k < ne; k++) {
    i.tag(331, i.H());
    const np = i.N(2);
    i.tag(74, np);
    for (let j = 0; j < np; j++) i.tag(94, i.BL());
  }
  const nn = i.N(4);
  i.tag(75, nn);
  for (let k = 0; k < nn; k++) {
    i.tag(95, i.BL());
    const np = i.N(2);
    i.tag(76, np);
    for (let j = 0; j < np; j++) i.tag(94, i.BL());
  }
  i.tag(140, i.BD());
  i.tag(141, i.BD());
  i.tag(280, i.RC());
}
function wStretch(o: Out, s: Subs, ver: number): void {
  wAction(o, s, ver);
  const c = s.cur('AcDbBlockStretchAction');
  wConnBlock(o, c, 2, false);
  const nf = c.int(72);
  o.BL(nf);
  for (let k = 0; k < nf; k++) {
    o.RD(c.num(1011));
    o.RD(c.num(1021));
  }
  const ne = c.int(73);
  o.BL(ne);
  for (let k = 0; k < ne; k++) {
    o.H(SOFT_PTR, c.handle(331));
    const np = c.int(74);
    o.BL(np);
    for (let j = 0; j < np; j++) o.BL(c.int(94));
  }
  const nn = c.int(75);
  o.BL(nn);
  for (let k = 0; k < nn; k++) {
    o.BL(c.int(95));
    const np = c.int(76);
    o.BL(np);
    for (let j = 0; j < np; j++) o.BL(c.int(94));
  }
  o.BD(c.num(140));
  o.BD(c.num(141));
  o.RC(c.int(280));
  c.end();
}

/** AcDbBlockFlipAction: 연결 넷(BL + TV). DXF 순서: 92~95, 301~304 */
function rFlipAction(i: In): void {
  rAction(i);
  i.sub('AcDbBlockFlipAction');
  rConnBlock(i, 4, true);
}
function wFlipAction(o: Out, s: Subs, ver: number): void {
  wAction(o, s, ver);
  const c = s.cur('AcDbBlockFlipAction');
  wConnBlock(o, c, 4, true);
  c.end();
}

/** AcDbBlockArrayAction: 연결 넷(DXF 92~95, 301~304), BD 140 열 간격, BD 141 행 간격 */
function rArray(i: In): void {
  rAction(i);
  i.sub('AcDbBlockArrayAction');
  rConnBlock(i, 4, true);
  i.tag(140, i.BD());
  i.tag(141, i.BD());
}
function wArray(o: Out, s: Subs, ver: number): void {
  wAction(o, s, ver);
  const c = s.cur('AcDbBlockArrayAction');
  wConnBlock(o, c, 4, true);
  o.BD(c.num(140));
  o.BD(c.num(141));
  c.end();
}

/**
 * AcDbBlockLookupAction: BL 92 행 수, BL 93 열 수, TV 칸(행 우선)…, 열마다 BL 94 노드, BL 95 값 종류, BL 96, B 282 조회 열,
 * TV 305 일치하지 않을 때 이름, B 281 역방향 조회, TV 304 속성; 끝에 B 280.
 * DXF는 93 다음에 301, 열 기록 앞마다 303(빈 문자열)을 둔다.
 */
function rLookupAction(i: In): void {
  rAction(i);
  i.sub('AcDbBlockLookupAction');
  const rows = i.N(0);
  const cols = i.N(0);
  i.tag(92, rows);
  i.tag(93, cols);
  i.tag(301, '');
  const sr = i.r.strReader;
  sr.checkCount(rows * cols, sr === i.r ? 2 : 16);
  for (let k = 0; k < rows * cols; k++) i.tag(302, i.TV());
  for (let k = 0; k < cols; k++) {
    i.tag(303, '');
    i.tag(94, i.BL());
    i.tag(95, i.BL());
    i.tag(96, i.BL());
    i.tag(282, i.B());
    i.tag(305, i.TV());
    i.tag(281, i.B());
    i.tag(304, i.TV());
  }
  i.tag(280, i.B());
}
function wLookupAction(o: Out, s: Subs, ver: number): void {
  wAction(o, s, ver);
  const c = s.cur('AcDbBlockLookupAction');
  const rows = c.int(92);
  const cols = c.int(93);
  if (rows < 0 || cols < 0) fail('조회 표 크기');
  o.BL(rows);
  o.BL(cols);
  c.blank(301);
  for (let k = 0; k < rows * cols; k++) o.TV(c.str(302));
  for (let k = 0; k < cols; k++) {
    c.blank(303);
    o.BL(c.int(94));
    o.BL(c.int(95));
    o.BL(c.int(96));
    o.B(c.int(282));
    o.TV(c.str(305));
    o.B(c.int(281));
    o.TV(c.str(304));
  }
  o.B(c.int(280));
  c.end();
}

/**
 * AcDbBlockPolarStretchAction: 연결 여섯(DXF 92+301 … 97+306, 섞어서), BL 73 + RD2 틀 점(1011·1021)…,
 * BL 72 신축 객체 수(DXF 코드를 확인하지 못해 0일 때만), BL 74 + H 332…(회전만 하는 객체), BL 75 + (BL 76, BL 78)…
 * (78이 0일 때만), BD 141, BD 140, BS 77.
 */
function rPolarStretch(i: In): void {
  rAction(i);
  i.sub('AcDbBlockPolarStretchAction');
  rConnBlock(i, 6, false);
  const nf = i.N(128);
  i.tag(73, nf);
  for (let k = 0; k < nf; k++) {
    i.tag(1011, i.RD());
    i.tag(1021, i.RD());
  }
  const ns = i.BL();
  if (ns !== 0) fail('극좌표 신축 객체');
  i.tag(72, 0);
  const nr = i.NH();
  i.tag(74, nr);
  for (let k = 0; k < nr; k++) i.tag(332, i.H());
  const nn = i.N(4);
  i.tag(75, nn);
  for (let k = 0; k < nn; k++) {
    i.tag(76, i.BL());
    if (i.BL() !== 0) fail('극좌표 신축 노드 점');
    i.tag(78, 0);
  }
  i.tag(141, i.BD());
  i.tag(140, i.BD());
  i.tag(77, i.BS());
}
function wPolarStretch(o: Out, s: Subs, ver: number): void {
  wAction(o, s, ver);
  const c = s.cur('AcDbBlockPolarStretchAction');
  wConnBlock(o, c, 6, false);
  const nf = c.int(73);
  o.BL(nf);
  for (let k = 0; k < nf; k++) {
    o.RD(c.num(1011));
    o.RD(c.num(1021));
  }
  if (c.int(72) !== 0) fail('극좌표 신축 객체');
  o.BL(0);
  const nr = c.int(74);
  o.BL(nr);
  for (let k = 0; k < nr; k++) o.H(SOFT_PTR, c.handle(332));
  const nn = c.int(75);
  o.BL(nn);
  for (let k = 0; k < nn; k++) {
    o.BL(c.int(76));
    if (c.int(78) !== 0) fail('극좌표 신축 노드 점');
    o.BL(0);
  }
  o.BD(c.num(141));
  o.BD(c.num(140));
  o.BS(c.int(77));
  c.end();
}

// ---------------------------------------------------------------------------
// 평가 그래프: BL 96, BL 97, BL 노드 수, 노드마다 BL 91 색인, BL 93 플래그, BL 95 노드 번호, H 360(핸들 흐름), BL 92 ×4,
// BL 간선 수, 간선마다 BL 92, BL 93, BL 94, BL 91 ×2, BL 92 ×5. DXF에는 개수가 없다(노드는 91, 간선은 92로 시작).

function rGraph(i: In): void {
  i.sub('AcDbEvalGraph');
  i.tag(96, i.BL());
  i.tag(97, i.BL());
  const n = i.N(8);
  for (let k = 0; k < n; k++) {
    i.tag(91, i.BL());
    i.tag(93, i.BL());
    i.tag(95, i.BL());
    i.tag(360, i.H());
    for (let j = 0; j < 4; j++) i.tag(92, i.BL());
  }
  const m = i.N(10);
  for (let k = 0; k < m; k++) {
    i.tag(92, i.BL());
    i.tag(93, i.BL());
    i.tag(94, i.BL());
    i.tag(91, i.BL());
    i.tag(91, i.BL());
    for (let j = 0; j < 5; j++) i.tag(92, i.BL());
  }
}
function wGraph(o: Out, s: Subs): void {
  const c = s.cur('AcDbEvalGraph');
  o.BL(c.int(96));
  o.BL(c.int(97));
  const nodes: DynOp[][] = [];
  while (c.has(91)) {
    const n = new Out();
    n.BL(c.int(91));
    n.BL(c.int(93));
    n.BL(c.int(95));
    n.H(HARD_OWNER, c.handle(360));
    for (let j = 0; j < 4; j++) n.BL(c.int(92));
    nodes.push(n.ops);
  }
  o.BL(nodes.length);
  for (const n of nodes) o.ops.push(...n);
  const edges: DynOp[][] = [];
  while (c.has(92)) {
    const e = new Out();
    e.BL(c.int(92));
    e.BL(c.int(93));
    e.BL(c.int(94));
    e.BL(c.int(91));
    e.BL(c.int(91));
    for (let j = 0; j < 5; j++) e.BL(c.int(92));
    edges.push(e.ops);
  }
  c.end();
  o.BL(edges.length);
  for (const e of edges) o.ops.push(...e);
}

// ---------------------------------------------------------------------------
// 블록 표현 자료: BS 70, H 340(정의 블록 레코드, 하드 포인터)
// 동적 블록 지움 막기: BS 70, H(블록 레코드, 하드 포인터 — DXF에는 없다: 소유 사전의 소유자)

function rRepData(i: In): void {
  i.sub('AcDbBlockRepresentationData');
  i.tag(70, i.BS());
  i.tag(340, i.H());
}
function wRepData(o: Out, s: Subs): void {
  const c = s.cur('AcDbBlockRepresentationData');
  o.BS(c.int(70));
  o.H(HARD_PTR, c.handle(340));
  c.end();
}

function rPurge(i: In, ctx: DynContext): void {
  i.sub('AcDbDynamicBlockPurgePreventer');
  i.tag(70, i.BS());
  const h = i.H();
  // DXF에 없는 값이라 쓸 때 소유 관계에서 되찾는다: 다르면 풀지 않는다
  if (ctx.block !== undefined && h !== (ctx.block || '0')) fail('지움 막기 블록');
}
function wPurge(o: Out, s: Subs, ctx: DynContext): void {
  const c = s.cur('AcDbDynamicBlockPurgePreventer');
  o.BS(c.int(70));
  c.end();
  if (!ctx.block) fail('지움 막기 블록');
  o.H(HARD_PTR, ctx.block!);
}

// ---------------------------------------------------------------------------

/** 쓰기·읽기에 필요한 문서 쪽 값 */
export interface DynContext {
  /** 지움 막기 객체가 속한 블록 레코드(소유 사전의 소유자) 핸들 */
  block?: string;
}

type Reader = (i: In, ctx: DynContext) => void;
type Writer = (o: Out, s: Subs, ver: number, ctx: DynContext) => void;
type Codec = [Reader, Writer];

const CODECS: Record<string, Codec> = {
  ACDB_BLOCKREPRESENTATION_DATA: [rRepData, (o, s) => wRepData(o, s)],
  ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION: [rPurge, (o, s, _v, ctx) => wPurge(o, s, ctx)],
  ACAD_EVALUATION_GRAPH: [rGraph, (o, s) => wGraph(o, s)],
  BLOCKGRIPLOCATIONCOMPONENT: [rGripExpr, (o, s) => wGripExpr(o, s)],
  BLOCKVISIBILITYPARAMETER: [rVisibility, wVisibility],
  BLOCKLINEARPARAMETER: [rLinear, wLinear],
  BLOCKFLIPPARAMETER: [rFlip, wFlip],
  BLOCKROTATIONPARAMETER: [rRotation, wRotation],
  BLOCKXYPARAMETER: [rXY, wXY],
  BLOCKPOLARPARAMETER: [rPolar, wPolar],
  BLOCKPOINTPARAMETER: [rPoint, wPoint],
  BLOCKLOOKUPPARAMETER: [rLookupParam, wLookupParam],
  BLOCKBASEPOINTPARAMETER: [rBasepoint, wBasepoint],
  BLOCKALIGNMENTPARAMETER: [rAlignment, wAlignment],
  BLOCKVISIBILITYGRIP: gripOnly('AcDbBlockVisibilityGrip'),
  BLOCKLINEARGRIP: gripDir('AcDbBlockLinearGrip'),
  BLOCKFLIPGRIP: [rFlipGrip, wFlipGrip],
  BLOCKROTATIONGRIP: gripOnly('AcDbBlockRotationGrip'),
  BLOCKXYGRIP: gripOnly('AcDbBlockXYGrip'),
  BLOCKPOLARGRIP: gripOnly('AcDbBlockPolarGrip'),
  BLOCKLOOKUPGRIP: gripOnly('AcDbBlockLookUpGrip'),
  BLOCKALIGNMENTGRIP: gripDir('AcDbBlockAlignmentGrip'),
  BLOCKSCALEACTION: [rScale, wScale],
  BLOCKMOVEACTION: [rMove, wMove],
  BLOCKSTRETCHACTION: [rStretch, wStretch],
  BLOCKROTATEACTION: [rRotate, wRotate],
  BLOCKFLIPACTION: [rFlipAction, wFlipAction],
  BLOCKARRAYACTION: [rArray, wArray],
  BLOCKLOOKUPACTION: [rLookupAction, wLookupAction],
  BLOCKPOLARSTRETCHACTION: [rPolarStretch, wPolarStretch],
};

/**
 * 공통 자료 다음 본문을 DXF 태그로 푼다. 배치가 맞지 않으면 DynLayoutError.
 * 다 읽었는지(남은 비트)는 부르는 쪽이 본다.
 */
export function decodeDyn(type: string, dat: BitReader, hdl: BitReader, base: number, ctx: DynContext = {}): RawTag[] {
  const codec = CODECS[type];
  if (!codec) fail(type);
  const i = new In(dat, hdl, base);
  codec![0](i, ctx);
  return i.tags;
}

/** 원본 태그 → DWG 쓰기 명령(공통 자료 다음 본문). 풀 수 없으면 null */
export function encodeDyn(type: string, raw: readonly RawTag[] | undefined, ver: number, ctx: DynContext = {}): DynOp[] | null {
  const codec = CODECS[type];
  if (!codec || !raw?.length) return null;
  const m = split(raw);
  if (!m) return null;
  const s = new Subs(m);
  const o = new Out();
  try {
    codec[1](o, s, ver, ctx);
    s.end();
  } catch (e) {
    if (e instanceof DynLayoutError) return null;
    throw e;
  }
  return o.ops;
}

/** 쓰기 명령을 비트로 */
export interface DynSink {
  B(v: number): void;
  RC(v: number): void;
  BS(v: number): void;
  BL(v: number): void;
  BD(v: number): void;
  RD(v: number): void;
  TV(s: string): void;
  BD3(p: Vec3): void;
  H(code: number, value: number): void;
}

export function writeDynOps(d: DynSink, hd: DynSink, ops: readonly DynOp[], ref: (h: string) => number): void {
  for (const op of ops) {
    switch (op.t) {
      case 'B':
        d.B(op.v);
        break;
      case 'RC':
        d.RC(op.v & 0xff);
        break;
      case 'BS':
        d.BS(op.v & 0xffff);
        break;
      case 'BL':
        d.BL(op.v | 0);
        break;
      case 'BD':
        d.BD(op.v);
        break;
      case 'RD':
        d.RD(op.v);
        break;
      case 'TV':
        d.TV(op.v);
        break;
      case '3BD':
        d.BD3(op.v);
        break;
      case 'H':
        hd.H(op.code, ref(op.h));
        break;
    }
  }
}
