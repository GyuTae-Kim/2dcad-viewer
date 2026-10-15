/**
 * 연관 망 객체(ACAD_ASSOCNETWORK: 망·동작·구속 그룹·변수·종속·배열 몸체·동작 매개변수)의 DWG 본문 ↔ DXF와 같은 원본 태그.
 *
 * 사양(ODA Open Design Specification)에 없는 객체다. AutoCAD가 같은 도면을 DWG와 DXF로 저장한 공개 짝 도면(같은 핸들 — R2000·
 * R2004·R2007·R2010·R2013 구속 도면 5판, R2013·R2018 배열·구속·변수 도면 13개)으로 배치를 정했다. 순서는 DXF 배치
 * (src/edit/assocnet/objects.ts·cgroup.ts)와 같고, 아래 "DXF와 다른 점"만 다르다. 읽기·쓰기는 같은 배치 함수(io: 읽으면 값을
 * 꺼내고, 쓰면 쓰기 명령으로 남긴다)를 쓴다. 짝 도면의 연관 객체 1011개가 모두 남는 비트 없이 풀리고, 다시 쓴 자료·문자열·핸들
 * 비트(핸들 종류 코드 포함)가 원본과 같다.
 *
 * DXF와 다른 점(짝으로 확인):
 *  - 정수 90 → BL, 290 → B, 280 → RC, 실수 40 → BD, 점 10·11 → 3BD, 글 1 → TV(R2007+는 문자열 흐름),
 *    핸들 330·340·360 → 핸들 흐름(H). 동작의 망 4(소프트 포인터), 몸체·종속·매개변수 3(하드 소유), 구속 노드의 값·치수 종속 5.
 *  - 동작의 종속 목록: 종속마다 자료 흐름에 B 1(소유 — DXF 360)이 온다. 망의 동작 목록도 항목마다 B(1 = 360 소유, 0 = 330 참조).
 *  - 형상 종속의 하위 객체 ID 클래스: R2010(AC1024) 이하는 TV 클래스 이름, AC1027 이상은 B 0 + BL 종류 번호
 *    (1 = AcDbAssocSingleEdgePersSubentId, 3 = AcDbAssocEdgePersSubentId — 그 밖의 번호는 풀지 않는다).
 *  - 값(AcDbEvalVariant): BS 자료 종류(DXF 코드와 같은 수: 40 실수 BD, 90 정수 BL, 1 글 TV, 330 객체 H) + 값.
 *  - 구속 그룹: DXF 70(그룹)은 B, 노드 플래그 70은 RC. 판 1 노드의 DXF 330(그룹 자신)은 DWG에 없다.
 *    판 2의 노드 목록은 (1 클래스, 90 번호) 대신 클래스 이름 표(BL 개수 + TV…, 처음 나온 차례) + 노드마다 (B 0, BL 표 번호(1부터),
 *    BL 노드 번호)다.
 *  - 모서리 동작 매개변수의 곡선 캐시는 BL 종류 + 자료: 23 선분, 11 원호, 42 NURBS(70 → B), 47 복합(BL 개수 + 곡선들).
 * 배치가 맞지 않으면(남는 비트·모르는 종류 등) AssocLayoutError — 부르는 쪽은 원본 비트만 남긴다(같은 버전으로만 되쓴다).
 * 쓰기(assocWriteOps): 원본 태그의 판을 저장 버전에 맞춘 뒤(AC1024 이하 판 1) 쓰고, 쓸 수 없는 구속 그룹이면 그 종속·몸체도
 * 빼며 망의 동작 목록에서도 뺀다.
 */
import type { CadObject, GenericObject, RawTag, Vec3 } from '../../core/model';
import { assocRawForVersion } from '../../edit/assocnet/version';
import { type CurveData, parseCurve, writeCurve } from '../../edit/assocnet/curve';
import { type CGroupData, type CNode, type FieldDef, type FieldValue, fieldsOf, parseGroupRest, writeGroupRest } from '../../edit/assocnet/cgroup';
import {
  type ActionHead,
  type ArrayBodyData,
  type AssocObjectData,
  type DependencyData,
  type EvalValue,
  type ParamLists,
  type ValueParam,
  parseAssocObject,
  writeAssocObject,
} from '../../edit/assocnet/objects';
import type { BitReader } from './bitstream';
import { R2007 } from './version';

export class AssocLayoutError extends Error {}

const fail = (what: string): never => {
  throw new AssocLayoutError(what);
};

/** DWG에서 풀고 다시 쓸 수 있는 종류 */
export const ASSOC_DWG_TYPES = new Set([
  'ACDBASSOCNETWORK',
  'ACDBASSOCACTION',
  'ACDBASSOC2DCONSTRAINTGROUP',
  'ACDBASSOCVARIABLE',
  'ACDBASSOCDEPENDENCY',
  'ACDBASSOCGEOMDEPENDENCY',
  'ACDBASSOCVALUEDEPENDENCY',
  'ASSOCDIMDEPENDENCYBODY',
  'ACDBASSOCARRAYACTIONBODY',
  'ACDBASSOCVERTEXACTIONPARAM',
  'ACDBASSOCEDGEACTIONPARAM',
]);

const SOFT_OWNER = 2;
const HARD_OWNER = 3;
const SOFT_PTR = 4;
const HARD_PTR = 5;

const hexOf = (h: number): string => (h > 0 ? h.toString(16).toUpperCase() : '');

/** 쓰기 명령 */
export type AssocOp =
  | { t: 'B' | 'RC' | 'BS' | 'BL' | 'BD'; v: number }
  | { t: 'TV'; v: string }
  | { t: '3BD'; v: Vec3 }
  | { t: 'H'; code: number; h: string };

/** 읽기·쓰기 공용 배치 도구 */
interface IO {
  readonly ver: number;
  BL(v?: number): number;
  BS(v?: number): number;
  RC(v?: number): number;
  B(v?: boolean | number): boolean;
  BD(v?: number): number;
  TV(v?: string): string;
  P(v?: Vec3): Vec3;
  H(code: number, v?: string): string;
  /** 개수(읽기: 남은 자료 비트로 가능한지 본다) */
  N(v: number | undefined, minBits: number): number;
  /** 핸들 개수(읽기: 남은 핸들 비트로 가능한지 본다, 핸들 하나는 8비트 이상) */
  NH(v: number | undefined): number;
}

class ReadIO implements IO {
  constructor(
    readonly r: BitReader,
    readonly hr: BitReader,
    readonly base: number,
    readonly ver: number,
  ) {}
  BL = () => this.r.BL();
  BS = () => this.r.BS();
  RC = () => this.r.RC();
  B = () => this.r.B() !== 0;
  BD = () => this.r.BD();
  TV = () => this.r.TV();
  P = () => this.r.BD3();
  H = () => hexOf(this.hr.H(this.base));
  N = (_v: number | undefined, minBits: number) => {
    const n = this.r.BL();
    if (n < 0 || n > 1000000) fail(`개수 ${n}`);
    return this.r.checkCount(n, minBits);
  };
  NH = () => {
    const n = this.r.BL();
    if (n < 0 || n > 1000000) fail(`개수 ${n}`);
    return this.hr.checkCount(n, 8);
  };
}

class WriteIO implements IO {
  readonly ops: AssocOp[] = [];
  constructor(readonly ver: number) {}
  private need<T>(v: T | undefined, what: string): T {
    if (v === undefined) fail(`값 없음: ${what}`);
    return v as T;
  }
  BL = (v?: number) => {
    const x = this.need(v, 'BL') | 0;
    this.ops.push({ t: 'BL', v: x });
    return x;
  };
  BS = (v?: number) => {
    const x = this.need(v, 'BS');
    this.ops.push({ t: 'BS', v: x });
    return x;
  };
  RC = (v?: number) => {
    const x = this.need(v, 'RC');
    this.ops.push({ t: 'RC', v: x });
    return x;
  };
  B = (v?: boolean | number) => {
    const x = !!this.need(v, 'B');
    this.ops.push({ t: 'B', v: x ? 1 : 0 });
    return x;
  };
  BD = (v?: number) => {
    const x = this.need(v, 'BD');
    this.ops.push({ t: 'BD', v: Number.isFinite(x) ? x : 0 });
    return x;
  };
  TV = (v?: string) => {
    const x = this.need(v, 'TV');
    this.ops.push({ t: 'TV', v: x });
    return x;
  };
  P = (v?: Vec3) => {
    const x = this.need(v, '3BD');
    this.ops.push({ t: '3BD', v: x });
    return x;
  };
  H = (code: number, v?: string) => {
    const x = v ?? '';
    this.ops.push({ t: 'H', code, h: x });
    return x;
  };
  N = (v: number | undefined) => this.BL(v);
  NH = (v: number | undefined) => this.BL(v);
}

// ---------------------------------------------------------------------------
// 공통 배치
// ---------------------------------------------------------------------------

/**
 * 값(AcDbEvalVariant): DXF 코드에 따라 — 90 정수 BL, 40 실수 BD, 1 글 TV, 330·340·360 객체 ID(H), 10 점 3BD.
 * DWG에서는 값 앞에 BS 자료 종류(DXF 코드와 같은 수)가 온다.
 */
function evalValue(io: IO, v?: EvalValue): EvalValue {
  const code = io.BS(v?.code);
  switch (code) {
    case 40:
      return { code, v: io.BD(v?.v as number) };
    case 90:
    case 70:
    case 280:
    case 290:
      return { code, v: io.BL(v?.v as number) };
    case 1:
    case 300:
      return { code, v: io.TV(v?.v as string) };
    case 10:
      return { code: 10, v: io.P(v?.v as Vec3) };
    case 330:
    case 340:
    case 360:
      return { code, v: io.H(SOFT_PTR, v?.v as string) };
    default:
      return fail(`값 종류 ${code}`);
  }
}

function paramLists(io: IO, p?: ParamLists): ParamLists {
  const a = io.BL(p?.a);
  const na = io.NH(p?.actionParams.length);
  const actionParams: string[] = [];
  for (let i = 0; i < na; i++) actionParams.push(io.H(HARD_OWNER, p?.actionParams[i]));
  const b = io.BL(p?.b);
  const nv = io.N(p?.values.length, 8);
  const values: ValueParam[] = [];
  for (let i = 0; i < nv; i++) {
    const w = p?.values[i];
    const version = io.BL(w?.version);
    const name = io.TV(w?.name);
    const unit = io.BL(w?.unit);
    const n = io.N(w?.values.length, 2);
    const vs: EvalValue[] = [];
    for (let k = 0; k < n; k++) vs.push(evalValue(io, w?.values[k]));
    const input = io.H(SOFT_PTR, w?.input);
    const output = io.H(SOFT_PTR, w?.output);
    values.push({ version, name, unit, values: vs, input, output });
  }
  return { a, actionParams, b, values };
}

function actionHead(io: IO, h?: ActionHead): ActionHead {
  const version = io.BL(h?.version);
  if (version !== 1 && version !== 2) fail(`동작 판 ${version}`);
  const status = io.BL(h?.status);
  const network = io.H(SOFT_PTR, h?.network);
  const body = io.H(HARD_OWNER, h?.body);
  const index = io.BL(h?.index);
  const maxDep = io.BL(h?.maxDep);
  const nd = io.NH(h?.deps.length);
  const deps: string[] = [];
  for (let i = 0; i < nd; i++) {
    // 종속마다 B 1(소유 — DXF 360)이 자료 흐름에 온다(표본은 모두 1)
    if (!io.B(true)) fail('소유하지 않는 종속');
    deps.push(io.H(HARD_OWNER, h?.deps[i]));
  }
  const out: ActionHead = { version, status, network, body, index, maxDep, deps };
  if (version >= 2) out.params = paramLists(io, h?.params);
  return out;
}

function dependency(io: IO, d?: DependencyData): DependencyData {
  return {
    version: io.BL(d?.version),
    status: io.BL(d?.status),
    read: io.B(d?.read),
    write: io.B(d?.write),
    f3: io.B(d?.f3),
    f4: io.B(d?.f4),
    order: io.BL(d?.order),
    target: io.H(SOFT_PTR, d?.target),
    f5: io.B(d?.f5),
    prev: io.H(SOFT_PTR, d?.prev),
    next: io.H(SOFT_PTR, d?.next),
    body: io.H(HARD_OWNER, d?.body),
    index: io.BL(d?.index),
  };
}

/** 하위 객체 ID 클래스 번호(AC1027+) */
const SUBENT_CODE: Record<string, number> = { AcDbAssocSingleEdgePersSubentId: 1, AcDbAssocEdgePersSubentId: 3 };
const SUBENT_NAME: Record<number, string> = { 1: 'AcDbAssocSingleEdgePersSubentId', 3: 'AcDbAssocEdgePersSubentId' };

function subentData(io: IO, cls: string, data?: RawTag[]): RawTag[] {
  if (cls === 'AcDbAssocSingleEdgePersSubentId') return [];
  if (cls === 'AcDbAssocEdgePersSubentId') {
    const out: RawTag[] = [];
    for (let k = 0; k < 3; k++) out.push({ code: 90, value: io.BL(data ? Number(data[k]?.value ?? 0) : undefined) });
    return out;
  }
  return fail(`하위 객체 ID ${cls}`);
}

/**
 * 모서리 동작 매개변수의 곡선 캐시(AcGe 곡선, src/edit/assocnet/curve.ts): BL 종류 + 자료. DXF와 같은 차례로
 * 정수 90 → BL, 실수 40 → BD, 점 10 → 3BD, NURBS의 70 → B. 23 선분은 같은 도면의 DWG·DXF 짝으로, 11 원호·42 NURBS·
 * 47 복합은 곡선 경로 배열 DWG 20개(모서리 매개변수 197개)가 남는 비트 없이 풀리고 값이 경로 객체와 맞는 것으로 확인했다.
 */
function curveData(io: IO, c?: CurveData, depth = 0): CurveData {
  if (depth > 4) fail('곡선 캐시 깊이');
  const type = io.BL(c?.type);
  switch (type) {
    case 23: {
      const x = c?.type === 23 ? c : undefined;
      return { type: 23, a: io.P(x?.a), v: io.P(x?.v) };
    }
    case 11: {
      const x = c?.type === 11 ? c : undefined;
      if (x && x.extra.length !== 1) fail('원호 캐시 꼴');
      return { type: 11, center: io.P(x?.center), normal: io.P(x?.normal), ref: io.P(x?.ref), radius: io.BD(x?.radius), start: io.BD(x?.start), end: io.BD(x?.end), extra: [io.BD(x?.extra[0])] };
    }
    case 42: {
      const x = c?.type === 42 ? c : undefined;
      if (x && (x.flags.length !== 2 || x.tol.length !== 1)) fail('NURBS 캐시 꼴');
      const flags = [io.B(x?.flags[0]) ? 1 : 0, io.B(x?.flags[1]) ? 1 : 0];
      const degree = io.BL(x?.degree);
      const tol = [io.BD(x?.tol[0])];
      const nums = (a?: { cap: number; grow: number; v: number[] }) => {
        const n = io.N(a?.v.length, 2);
        const cap = io.BL(a?.cap);
        const grow = io.BL(a?.grow);
        const v: number[] = [];
        for (let k = 0; k < n; k++) v.push(io.BD(a?.v[k]));
        return { cap, grow, v };
      };
      const knots = nums(x?.knots);
      const weights = nums(x?.weights);
      const n = io.N(x?.ctrl.v.length, 6);
      const cap = io.BL(x?.ctrl.cap);
      const grow = io.BL(x?.ctrl.grow);
      const v: Vec3[] = [];
      for (let k = 0; k < n; k++) v.push(io.P(x?.ctrl.v[k]));
      return { type: 42, flags, degree, tol, knots, weights, ctrl: { cap, grow, v } };
    }
    case 47: {
      const x = c?.type === 47 ? c : undefined;
      const n = io.N(x?.curves.length, 2);
      const curves: CurveData[] = [];
      for (let k = 0; k < n; k++) curves.push(curveData(io, x?.curves[k], depth + 1));
      return { type: 47, curves };
    }
    default:
      return fail(`곡선 캐시 종류 ${type}`);
  }
}

function curveCache(io: IO, tags?: RawTag[]): RawTag[] {
  let c: CurveData | undefined;
  if (tags) {
    const p = parseCurve(tags, 0);
    if (!p || p.next !== tags.length) fail('곡선 캐시 꼴');
    c = p!.curve;
  }
  return writeCurve(curveData(io, c));
}

// ---------------------------------------------------------------------------
// 구속 그룹
// ---------------------------------------------------------------------------

const HCODE: Record<string, number> = { dep: SOFT_PTR, valueDep: HARD_PTR, dimDep: HARD_PTR };

function nodeField(io: IO, f: FieldDef, v: FieldValue | undefined): FieldValue {
  switch (f.k) {
    case 'P':
      return io.P(v as Vec3 | undefined);
    case 'H':
      return io.H(HCODE[f.name] ?? SOFT_PTR, v as string | undefined);
    case 'TV':
      return io.TV(v as string | undefined);
    case 'BD':
      return io.BD(v as number | undefined);
    case 'B':
      return io.B(v as number | undefined) ? 1 : 0;
    case 'BS':
      return io.BS(v as number | undefined);
    case 'RC':
      return io.RC(v as number | undefined);
    default:
      return io.BL(v as number | undefined);
  }
}

function nodeBody(io: IO, cls: string, version: number, n?: CNode): Record<string, FieldValue> {
  const fs = fieldsOf(cls, version);
  if (!fs) return fail(`구속 노드 클래스 ${cls}`);
  const vals: Record<string, FieldValue> = {};
  for (const f of fs) {
    if (f.when && vals[f.when.field] !== f.when.eq) continue;
    vals[f.name] = nodeField(io, f, n?.f[f.name]);
  }
  return vals;
}

function group(io: IO, version: number, g?: CGroupData): CGroupData {
  const gversion = io.BL(g?.gversion);
  const g70 = io.B(g?.g70) ? 1 : 0;
  const origin = io.P(g?.origin);
  const xAxis = io.P(g?.xAxis);
  const yAxis = io.P(g?.yAxis);
  const g360 = io.H(HARD_OWNER, g?.g360);
  const nd = io.NH(g?.deps.length);
  const deps: string[] = [];
  for (let i = 0; i < nd; i++) deps.push(io.H(HARD_OWNER, g?.deps[i]));
  const seed = io.BL(g?.seed);
  let v2: CGroupData['v2'];
  if (version >= 2) v2 = { a: io.BL(g?.v2?.a ?? 0), b: io.BL(g?.v2?.b ?? 0), c: io.B(g?.v2?.c ?? false) };
  const nodes: CNode[] = [];
  if (version >= 2) {
    // 판 2: 클래스 이름 표(처음 나온 차례) + 노드마다 (B 0, BL 클래스 번호(1부터), BL 노드 번호), 그다음 노드 자료
    const names: string[] = [];
    if (g) for (const x of g.nodes) if (!names.includes(x.cls)) names.push(x.cls);
    const nn = io.N(g ? names.length : undefined, 1);
    const table: string[] = [];
    for (let i = 0; i < nn; i++) table.push(io.TV(names[i]).trim());
    const n = io.N(g?.nodes.length, 2);
    const heads: { cls: string; id: number }[] = [];
    for (let i = 0; i < n; i++) {
      const w = g?.nodes[i];
      if (io.B(false)) fail('노드 머리 비트');
      const ci = io.BL(w ? names.indexOf(w.cls) + 1 : undefined);
      const cls = table[ci - 1] ?? fail(`클래스 번호 ${ci}`);
      heads.push({ cls, id: io.BL(w?.id) });
    }
    for (let i = 0; i < n; i++) {
      const w = g?.nodes[i];
      const id = io.BL(w?.id);
      if (id !== heads[i]!.id) fail(`노드 번호 ${id}`);
      const nl = io.N(w?.links.length, 2);
      const links: number[] = [];
      for (let k = 0; k < nl; k++) links.push(io.BL(w?.links[k]));
      const flags = io.RC(w?.flags);
      nodes.push({ cls: heads[i]!.cls, id, owner: '', flags, links, f: nodeBody(io, heads[i]!.cls, version, w) });
    }
  } else {
    const n = io.N(g?.nodes.length, 2);
    for (let i = 0; i < n; i++) {
      const w = g?.nodes[i];
      const cls = io.TV(w?.cls).trim();
      // 판 1의 DXF 330(그룹 자신)은 DWG에 없다
      const owner = '';
      const id = io.BL(w?.id);
      const flags = io.RC(w?.flags);
      const nl = io.N(w?.links.length, 2);
      const links: number[] = [];
      for (let k = 0; k < nl; k++) links.push(io.BL(w?.links[k]));
      nodes.push({ cls, id, owner, flags, links, f: nodeBody(io, cls, version, w) });
    }
  }
  return { version, gversion, g70, origin, xAxis, yAxis, g360, deps, seed, ...(v2 ? { v2 } : {}), nodes };
}

// ---------------------------------------------------------------------------
// 종류별
// ---------------------------------------------------------------------------

function arrayBody(io: IO, b?: ArrayBodyData): ArrayBodyData {
  const bodyVersion = io.BL(b?.bodyVersion);
  let paramBased: ArrayBodyData['paramBased'];
  if (bodyVersion < 2) paramBased = { version: io.BL(b?.paramBased?.version ?? 0), lists: paramLists(io, b?.paramBased?.lists) };
  const version = io.BL(b?.version);
  const paramsClass = io.TV(b?.paramsClass).trim();
  const x = io.BL(b?.x);
  const n = io.N(b?.items.length, 10);
  const itemClass = io.TV(n || b ? 'AcDbAssocArrayItem' : undefined);
  if (itemClass.trim() !== 'AcDbAssocArrayItem') fail('항목 클래스');
  const items: ArrayBodyData['items'] = [];
  for (let i = 0; i < n; i++) {
    const w = b?.items[i];
    const it: ArrayBodyData['items'][number] = { version: io.BL(w?.version), i: io.BL(w?.i), j: io.BL(w?.j), k: io.BL(w?.k), flags: io.BL(w?.flags), entity: '' };
    if (it.flags === 8) it.offset = io.P(w?.offset);
    else if (it.flags === 12) {
      const m: number[] = [];
      for (let q = 0; q < 16; q++) m.push(io.BD(w?.matrix?.[q]));
      it.matrix = m;
    } else fail(`항목 플래그 ${it.flags}`);
    it.entity = io.H(SOFT_PTR, w?.entity);
    items.push(it);
  }
  const matrix: number[] = [];
  for (let q = 0; q < 16; q++) matrix.push(io.BD(b?.matrix[q]));
  return { bodyVersion, ...(paramBased ? { paramBased } : {}), version, paramsClass, x, items, matrix };
}

/** 객체 하나(종류별). d는 쓸 때의 해석 */
function layout(io: IO, type: string, d?: AssocObjectData, self = ''): AssocObjectData {
  switch (type) {
    case 'ACDBASSOCNETWORK': {
      const x = d?.kind === 'network' ? d : undefined;
      const head = actionHead(io, x?.head);
      const version = io.BL(x?.net.version);
      const maxIndex = io.BL(x?.net.maxIndex);
      const refs = (list?: { h: string; owned: boolean }[]) => {
        const n = io.N(list?.length, 1);
        const out: { h: string; owned: boolean }[] = [];
        for (let i = 0; i < n; i++) {
          // 소유(360)인지는 비트로 둔다: B 1 = 소유
          const owned = io.B(list?.[i]?.owned);
          out.push({ owned, h: io.H(owned ? HARD_OWNER : SOFT_PTR, list?.[i]?.h) });
        }
        return out;
      };
      const actions = refs(x?.net.actions);
      const tail = refs(x?.net.tail);
      return { kind: 'network', head, net: { version, maxIndex, actions, tail } };
    }
    case 'ACDBASSOCACTION':
      return { kind: 'action', head: actionHead(io, d && 'head' in d ? d.head : undefined) };
    case 'ACDBASSOC2DCONSTRAINTGROUP': {
      const x = d?.kind === 'cgroup' ? d : undefined;
      const head = actionHead(io, x?.head);
      const g = group(io, head.version, x ? parseGroupRest(x.head.version, x.rest) : undefined);
      return { kind: 'cgroup', head, rest: writeGroupRest(g, self) };
    }
    case 'ACDBASSOCVARIABLE': {
      const x = d?.kind === 'variable' ? d : undefined;
      const head = actionHead(io, x?.head);
      const v = x?.variable;
      return {
        kind: 'variable',
        head,
        variable: {
          version: io.BL(v?.version),
          name: io.TV(v?.name),
          expr: io.TV(v?.expr),
          evaluator: io.TV(v?.evaluator),
          description: io.TV(v?.description),
          value: evalValue(io, v?.value),
          b1: io.B(v?.b1),
          b2: io.B(v?.b2),
          tail: io.BL(v?.tail),
        },
      };
    }
    case 'ACDBASSOCDEPENDENCY':
      return { kind: 'dependency', dep: dependency(io, d && 'dep' in d ? d.dep : undefined) };
    case 'ACDBASSOCGEOMDEPENDENCY': {
      const x = d?.kind === 'geomdep' ? d : undefined;
      const dep = dependency(io, x?.dep);
      const version = io.BL(x?.geom.version);
      const flag = io.B(x?.geom.flag);
      let cls: string;
      if (io.ver >= 1027) {
        if (io.B(false)) fail('하위 객체 ID 글 꼴');
        const code = io.BL(x ? SUBENT_CODE[x.geom.subentClass] ?? fail(`하위 객체 ID ${x.geom.subentClass}`) : undefined);
        cls = SUBENT_NAME[code] ?? fail(`하위 객체 ID 번호 ${code}`);
      } else cls = io.TV(x?.geom.subentClass).trim();
      const subent = subentData(io, cls, x?.geom.subent);
      const flag2 = io.B(x?.geom.flag2);
      return { kind: 'geomdep', dep, geom: { version, flag, subentClass: cls, subent, flag2 } };
    }
    case 'ACDBASSOCVALUEDEPENDENCY': {
      const x = d?.kind === 'valuedep' ? d : undefined;
      const dep = dependency(io, x?.dep);
      return { kind: 'valuedep', dep, value: { version: io.BL(x?.value.version), name: io.TV(x?.value.name), value: evalValue(io, x?.value.value) } };
    }
    case 'ASSOCDIMDEPENDENCYBODY': {
      const x = d?.kind === 'dimbody' ? d : undefined;
      return { kind: 'dimbody', body: { v1: io.BL(x?.body.v1), v2: io.BL(x?.body.v2), text: io.TV(x?.body.text), v3: io.BL(x?.body.v3) } };
    }
    case 'ACDBASSOCARRAYACTIONBODY':
      return { kind: 'arraybody', body: arrayBody(io, d?.kind === 'arraybody' ? d.body : undefined) };
    case 'ACDBASSOCVERTEXACTIONPARAM':
    case 'ACDBASSOCEDGEACTIONPARAM': {
      const x = d?.kind === 'vertexparam' || d?.kind === 'edgeparam' ? d.param : undefined;
      const version: number | null = io.ver >= 1027 ? io.BL(x?.version ?? 1) : null;
      const px = io.BL(x?.x);
      const name = io.TV(x?.name);
      const single = { x: io.BL(x?.single?.x ?? 0), dep: io.H(SOFT_PTR, x?.single?.dep ?? '') };
      if (type === 'ACDBASSOCVERTEXACTIONPARAM') {
        const v = d?.kind === 'vertexparam' ? d.param : undefined;
        return { kind: 'vertexparam', param: { version, x: px, name, single, vx: io.BL(v?.vx), point: io.P(v?.point) } };
      }
      const e = d?.kind === 'edgeparam' ? d.param : undefined;
      const ex = io.BL(e?.ex);
      const eh = io.H(SOFT_PTR, e?.eh);
      const hasCurve = io.B(e?.hasCurve);
      const curve = hasCurve ? curveCache(io, e?.curve) : [];
      return { kind: 'edgeparam', param: { version, x: px, name, single, ex, eh, hasCurve, curve } };
    }
    default:
      return fail(`종류 ${type}`);
  }
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

/** DWG 본문 → 원본 태그(배치가 맞지 않으면 AssocLayoutError) */
export function decodeAssoc(type: string, r: BitReader, hr: BitReader, base: number, ver: number): RawTag[] {
  const d = layout(new ReadIO(r, hr, base, ver), type, undefined, hexOf(base));
  return writeAssocObject(d);
}

/** 원본 태그 → 쓰기 명령(판은 이미 저장 버전에 맞춘 것이어야 한다. 풀 수 없으면 null) */
export function encodeAssoc(type: string, raw: readonly RawTag[] | undefined, ver: number): AssocOp[] | null {
  if (!raw?.length || !ASSOC_DWG_TYPES.has(type)) return null;
  try {
    const d = parseAssocObject(type, raw);
    if (!d) return null;
    const io = new WriteIO(ver);
    layout(io, type, d);
    return io.ops;
  } catch {
    return null;
  }
}

const selfOkCache = new WeakMap<object, Map<number, boolean>>();

/** 태그 자체를 이 버전으로 쓸 수 있는지(객체마다 기억) */
function selfOk(o: GenericObject, ver: number, lookup: (h: string) => CadObject | undefined): boolean {
  let m = selfOkCache.get(o);
  if (!m) selfOkCache.set(o, (m = new Map()));
  let ok = m.get(ver);
  if (ok === undefined) {
    ok = ASSOC_DWG_TYPES.has(o.type) && !!o.raw?.length;
    if (ok) {
      const raw = assocRawForVersion(o, ver, (h) => lookup(h) as GenericObject | undefined);
      ok = !!raw && !!encodeAssoc(o.type, raw, ver);
    }
    m.set(ver, ok);
  }
  return ok;
}

const isAssoc = (o: CadObject | undefined): o is GenericObject => !!o && /^(ACDBASSOC|ASSOCDIM)/i.test(o.type);

/** 이 객체가 소유한(360) 연관 객체 핸들(망의 동작 목록은 빼고 — 망은 쓸 수 없는 동작을 목록에서 뺀다) */
function ownedOf(o: GenericObject): string[] {
  let d: AssocObjectData | null = null;
  try {
    d = parseAssocObject(o.type, o.raw ?? []);
  } catch {
    return [];
  }
  if (!d) return [];
  switch (d.kind) {
    case 'action':
    case 'variable':
      return [d.head.body, ...d.head.deps, ...(d.head.params?.actionParams ?? [])].filter(Boolean);
    case 'cgroup': {
      try {
        return [...d.head.deps, ...parseGroupRest(d.head.version, d.rest).deps].filter(Boolean);
      } catch {
        return d.head.deps;
      }
    }
    case 'dependency':
    case 'geomdep':
    case 'valuedep':
      return d.dep.body ? [d.dep.body] : [];
    case 'arraybody':
      return d.body.paramBased?.lists.actionParams ?? [];
    default:
      return [];
  }
}

/** 값 종속의 대상(변수) */
function valueTargets(o: GenericObject): string[] {
  if (o.type.toUpperCase() !== 'ACDBASSOCVALUEDEPENDENCY') return [];
  try {
    const d = parseAssocObject(o.type, o.raw ?? []);
    return d?.kind === 'valuedep' && d.dep.target ? [d.dep.target] : [];
  } catch {
    return [];
  }
}

/** 같은 버전의 원본 본문이 있어 그대로 되쓸 객체(태그를 풀지 못한 객체도 같은 버전이면 남는다) */
const rawCopy = (o: CadObject, ver: number): boolean => !!o.dwgRaw && o.dwgRaw.version === `AC${ver}`;

/** 소유 나무 전체를 쓸 수 있는지 */
function subtreeOk(o: GenericObject, ver: number, lookup: (h: string) => CadObject | undefined, depth: number): boolean {
  if (depth > 16) return false;
  if (!selfOk(o, ver, lookup) && !rawCopy(o, ver)) return false;
  // 값 종속이 가리키는 변수(망 소유라 소유 나무 밖)도 쓸 수 있어야 한다 — 못 쓰는 변수를 가리키는 그룹을 남기지 않는다
  for (const h of valueTargets(o)) {
    const x = lookup(h.toUpperCase());
    if (isAssoc(x) && !selfOk(x, ver, lookup) && !rawCopy(x, ver)) return false;
  }
  for (const h of ownedOf(o)) {
    const x = lookup(h.toUpperCase());
    if (!x) continue;
    if (!isAssoc(x)) {
      if (!rawCopy(x, ver)) return false;
      continue;
    }
    if (!subtreeOk(x, ver, lookup, depth + 1)) return false;
  }
  return true;
}

/**
 * 객체(원본 태그)를 DWG 버전 ver로 쓸 수 있는지: 그 객체가 속한 동작(구속 그룹·배열 동작·변수 — 망 바로 아래의 연관 객체)의
 * 소유 나무 전체(몸체·종속·종속 몸체·동작 매개변수)가 이 코덱으로 풀리고 판을 바꿀 수 있어야 한다. 하나라도 못 쓰면 그 동작을 통째로
 * 빼서(망의 동작 목록에서도 뺀다) 망이 반쪽이 되지 않게 한다. 망 자체는 자기 태그만 본다.
 */
export function assocWritable(o: GenericObject, ver: number, lookup: (h: string) => CadObject | undefined): boolean {
  if (o.type.toUpperCase() === 'ACDBASSOCNETWORK') return selfOk(o, ver, lookup);
  // 망 바로 아래까지 올라간다
  let top = o;
  for (let i = 0; i < 16; i++) {
    const own = top.owner ? lookup(top.owner.toUpperCase()) : undefined;
    if (!isAssoc(own) || own.type.toUpperCase() === 'ACDBASSOCNETWORK') break;
    top = own;
  }
  return subtreeOk(top, ver, lookup, 0);
}

/** 쓸 쓰기 명령(판 맞추기, 망은 쓰지 못하는 동작을 목록에서 뺀다). 쓸 수 없으면 null */
export function assocWriteOps(o: GenericObject, ver: number, lookup: (h: string) => CadObject | undefined): AssocOp[] | null {
  if (!assocWritable(o, ver, lookup)) return null;
  let raw = assocRawForVersion(o, ver, (h) => lookup(h) as GenericObject | undefined);
  if (!raw) return null;
  if (o.type === 'ACDBASSOCNETWORK') {
    const d = parseAssocObject(o.type, raw);
    if (d?.kind === 'network') {
      const keep = (r: { h: string }) => {
        const x = lookup(r.h) as GenericObject | undefined;
        return !!x && (!/^(ACDBASSOC|ASSOCDIM)/i.test(x.type) || assocWritable(x, ver, lookup));
      };
      const actions = d.net.actions.filter(keep);
      const tail = d.net.tail.filter(keep);
      if (actions.length !== d.net.actions.length || tail.length !== d.net.tail.length) raw = writeAssocObject({ ...d, net: { ...d.net, actions, tail } });
    }
  }
  return encodeAssoc(o.type, raw, ver);
}

/** 쓰기 명령을 자료·핸들 흐름에 쓴다 */
export interface AssocSink {
  B(v: number): void;
  RC(v: number): void;
  BS(v: number): void;
  BL(v: number): void;
  BD(v: number): void;
  TV(v: string): void;
  BD3(v: Vec3): void;
  H(code: number, h: number): void;
}

export function writeAssocOps(d: AssocSink, hd: AssocSink, ops: readonly AssocOp[], ref: (h: string) => number): void {
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
      case 'TV':
        d.TV(op.v);
        break;
      case '3BD':
        d.BD3(op.v);
        break;
      case 'H':
        hd.H(op.code, op.h ? ref(op.h) : 0);
        break;
    }
  }
}

export { R2007, SOFT_OWNER, HARD_PTR };
