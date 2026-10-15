/**
 * AutoCAD 연관 망(ACAD_ASSOCNETWORK) 객체의 DXF 원본 태그 해석·쓰기.
 *
 * 공개 명세가 없는 형식이라 공개 도면(AutoCAD가 저장한 DXF 100여 개, 같은 도면의 DWG 짝 포함 — 출처는
 * src/edit/assocnet/README 대신 이 머리말과 구속 그룹 모듈 머리말)에서 확인한 배치만 푼다. 모르는 꼴을 만나면
 * AssocFormatError를 던지고, 부르는 쪽은 그 객체를 해석하지 않은 채 원본 태그 그대로 둔다(저장도 그대로).
 *
 * 판: 동작(AcDbAssocAction)의 첫 90이 1이면 AutoCAD 2010~2012 형식(AC1024 이하로 저장한 파일), 2면 2013+ 형식
 * (AC1027 이상). 같은 AutoCAD가 같은 도면을 판마다 저장한 표본(Constraints R2000~R2013)으로 확인했다.
 *
 * 확인한 배치(모든 값은 서브클래스 표지 다음 순서대로):
 *  - AcDbAssocAction: 90 판, 90 상태, 330 소유 망, 360 몸체, 90 망 안 번호, 90 종속 번호 최대, 90 종속 수 + 360 종속…,
 *    판 2만: 90 0, 90 동작 매개변수 수 + 360…, 90 0, 90 값 매개변수 수 + 값 매개변수….
 *  - 값 매개변수: 90 0, 1 이름, 90 단위(0 없음, 1 거리, 2 각도), 90 값 수(1) + 값(40 | 90 | 1 | 10 점), 330, 330.
 *  - AcDbAssocNetwork: 90 판(0), 90 동작 번호 최대, 90 동작 수 + (360 소유 | 330 참조)…, 90 개수 + (330 | 360)…(늘 0).
 *  - AcDbAssocDependency: 90 판(2), 90 상태, 290 읽기, 290 쓰기, 290, 290, 90 순서, 330 대상, 290, 330 같은 대상의 앞 종속,
 *    330 뒤 종속, 360 종속 몸체, 90 동작 안 번호.
 *  - AcDbAssocGeomDependency: 90 0, 290, 1 하위 객체 ID 클래스(AcDbAssocSingleEdgePersSubentId — 자료 없음,
 *    AcDbAssocEdgePersSubentId — 90 0, 90 꼭짓점 ID, 90 꼭짓점 ID), 290.
 *  - AcDbAssocValueDependency: 90 0, 1 값 이름(빈 글), 값(90 | 40).
 *  - AcDbAssocVariable(동작 다음): 90 판(2), 1 이름, 1 식(참조 구속은 빈 글), 1 계산기("AcDbCalc:1.0"), 1 설명, 값(식이
 *    정수 글이면 90, 아니면 40), 290, 290, 90 0.
 *  - ASSOCDIMDEPENDENCYBODY: 100 AcDbAssocDependencyBody 90 1, 100 AcDbImpAssocDimDependencyBodyBase 90 1, 1 치수 글
 *    ("d1=10" 또는 "10"), 100 AcDbAssocDimDependencyBody 90 1.
 *  - AcDbAssocActionParam: 90 1, 90 0, 1 이름. AcDbAssocSingleDependencyActionParam: 90 0, 330 종속.
 *    AcDbAssocVertexActionParam: 90 0, 10 점. AcDbAssocEdgeActionParam: 90 0, 330, 290 곡선 있음 + 곡선 캐시(90 종류 …,
 *    curve.ts — 23 선분·11 원호·42 NURBS·47 복합, 공간 좌표).
 *  - AcDbAssocActionBody: 90 판(1 | 2). 판 1의 배열 몸체는 100 AcDbAssocParamBasedActionBody 90 0 + 매개변수 목록(동작 판 2와
 *    같은 꼴)이 따로 온다. AcDbAssocArrayActionBody: 90 1, 1 매개변수 클래스, 90 0, 90 항목 수, 1 AcDbAssocArrayItem,
 *    항목마다 100 AcDbAssocArrayItem 90 0, 90 i, 90 j, 90 k, 90 플래그(8: 11/21/31 이동, 12: 40×16 행렬), 330 항목 참조,
 *    끝에 40×16 배열 참조 행렬. 표본(경로 배열 DXF 215개의 항목 8473개 포함)에 다른 플래그(지운 항목 등)는 없었다.
 */
import type { RawTag, Vec3 } from '../../core/model';
import { TagReader, TagWriter, fail, int, num, str } from './tags';

// ---------------------------------------------------------------------------
// 값(AcDbEvalVariant): 태그 코드로 종류를 가린다
// ---------------------------------------------------------------------------

export type EvalValue = { code: 10; v: Vec3 } | { code: number; v: number | string };

export function readValue(r: TagReader): EvalValue {
  const x = r.peek();
  if (!x) return fail('값 자리에 끝');
  if (x.code === 10) return { code: 10, v: r.pt(10) };
  if (x.code === 40 || x.code === 90 || x.code === 70 || x.code === 280 || x.code === 290) return { code: x.code, v: num(r.need(x.code)) };
  if (x.code === 1 || x.code === 300) return { code: x.code, v: str(r.need(x.code)) };
  // 객체 ID 값(중심 표시 동작의 CenterDepId 등)
  if (x.code === 330 || x.code === 340 || x.code === 360) return { code: x.code, v: r.hnd(x.code) };
  return fail(`값 태그 ${x.code}`);
}

export function writeValue(w: TagWriter, v: EvalValue): void {
  if (v.code === 10) w.pt(10, v.v as Vec3);
  else if (v.code === 330 || v.code === 340 || v.code === 360) w.hnd(v.code, String(v.v));
  else w.t(v.code, v.v as number | string);
}

export const valueNumber = (v: EvalValue | undefined): number => (v && typeof v.v === 'number' ? v.v : v && typeof v.v === 'string' ? num(v.v, NaN) : NaN);

/** 수 → AutoCAD가 쓰는 값 꼴(식이 정수 글이면 90, 아니면 40) */
export function valueOf(n: number, expr?: string): EvalValue {
  const intText = expr !== undefined ? /^\s*[+-]?\d+\s*$/.test(expr) : Number.isInteger(n);
  return intText && Number.isInteger(n) && Math.abs(n) < 2 ** 31 ? { code: 90, v: n } : { code: 40, v: n };
}

// ---------------------------------------------------------------------------
// 동작 머리·매개변수 목록
// ---------------------------------------------------------------------------

export interface ValueParam {
  version: number;
  name: string;
  /** 0 없음, 1 거리, 2 각도 */
  unit: number;
  values: EvalValue[];
  input: string;
  output: string;
}

export interface ParamLists {
  a: number;
  actionParams: string[];
  b: number;
  values: ValueParam[];
}

export interface ActionHead {
  version: number;
  status: number;
  network: string;
  body: string;
  index: number;
  maxDep: number;
  deps: string[];
  /** 판 2: 동작이 가진 매개변수 */
  params?: ParamLists;
}

function readParamLists(r: TagReader): ParamLists {
  const a = r.int(90);
  const na = r.int(90);
  if (na < 0 || na > 100000) fail('동작 매개변수 수');
  const actionParams: string[] = [];
  for (let i = 0; i < na; i++) actionParams.push(r.hnd(360));
  const b = r.int(90);
  const nv = r.int(90);
  if (nv < 0 || nv > 100000) fail('값 매개변수 수');
  const values: ValueParam[] = [];
  for (let i = 0; i < nv; i++) {
    const version = r.int(90);
    const name = r.str(1);
    const unit = r.int(90);
    const n = r.int(90);
    if (n < 0 || n > 64) fail('값 수');
    const vs: EvalValue[] = [];
    for (let k = 0; k < n; k++) vs.push(readValue(r));
    const input = r.hnd(330);
    const output = r.hnd(330);
    values.push({ version, name, unit, values: vs, input, output });
  }
  return { a, actionParams, b, values };
}

function writeParamLists(w: TagWriter, p: ParamLists): void {
  w.int(90, p.a).int(90, p.actionParams.length);
  for (const h of p.actionParams) w.hnd(360, h);
  w.int(90, p.b).int(90, p.values.length);
  for (const v of p.values) {
    w.int(90, v.version).str(1, v.name).int(90, v.unit).int(90, v.values.length);
    for (const x of v.values) writeValue(w, x);
    w.hnd(330, v.input).hnd(330, v.output);
  }
}

export function readActionHead(r: TagReader): ActionHead {
  r.sub('AcDbAssocAction');
  const version = r.int(90);
  if (version !== 1 && version !== 2) fail(`동작 판 ${version}`);
  const status = r.int(90);
  const network = r.hnd(330);
  const body = r.hnd(360);
  const index = r.int(90);
  const maxDep = r.int(90);
  const nd = r.int(90);
  if (nd < 0 || nd > 1000000) fail('종속 수');
  const deps: string[] = [];
  for (let i = 0; i < nd; i++) deps.push(r.hnd(360));
  const head: ActionHead = { version, status, network, body, index, maxDep, deps };
  if (version >= 2) head.params = readParamLists(r);
  return head;
}

export function writeActionHead(w: TagWriter, h: ActionHead): void {
  w.sub('AcDbAssocAction').int(90, h.version).int(90, h.status).hnd(330, h.network).hnd(360, h.body).int(90, h.index).int(90, h.maxDep).int(90, h.deps.length);
  for (const d of h.deps) w.hnd(360, d);
  if (h.version >= 2) writeParamLists(w, h.params ?? { a: 0, actionParams: [], b: 0, values: [] });
}

// ---------------------------------------------------------------------------
// 객체 종류별
// ---------------------------------------------------------------------------

export interface NetRef {
  h: string;
  /** 360(소유) | 330(참조) */
  owned: boolean;
}

export interface NetworkData {
  version: number;
  maxIndex: number;
  actions: NetRef[];
  tail: NetRef[];
}

export interface DependencyData {
  version: number;
  status: number;
  read: boolean;
  write: boolean;
  f3: boolean;
  f4: boolean;
  order: number;
  target: string;
  f5: boolean;
  prev: string;
  next: string;
  body: string;
  index: number;
}

export interface GeomDependencyData {
  version: number;
  flag: boolean;
  /** 하위 객체 ID 클래스 */
  subentClass: string;
  /** 그 자료(AcDbAssocEdgePersSubentId: 90 0, 90 ID, 90 ID) */
  subent: RawTag[];
  flag2: boolean;
}

export interface ValueDependencyData {
  version: number;
  name: string;
  value: EvalValue;
}

export interface VariableData {
  version: number;
  name: string;
  expr: string;
  evaluator: string;
  description: string;
  value: EvalValue;
  b1: boolean;
  b2: boolean;
  tail: number;
}

export interface DimBodyData {
  v1: number;
  v2: number;
  text: string;
  v3: number;
}

export interface ArrayItemData {
  version: number;
  i: number;
  j: number;
  k: number;
  flags: number;
  /** 플래그 8: 이동(11/21/31) */
  offset?: Vec3;
  /** 플래그 12: 4×4 행 우선 행렬 */
  matrix?: number[];
  entity: string;
}

export interface ArrayBodyData {
  bodyVersion: number;
  /** 판 1: AcDbAssocParamBasedActionBody */
  paramBased?: { version: number; lists: ParamLists };
  version: number;
  paramsClass: string;
  x: number;
  items: ArrayItemData[];
  /** 끝 행렬(16) */
  matrix: number[];
}

export interface ActionParamData {
  /** 판 2 형식의 첫 90(1). 판 1 형식에는 없다(null) */
  version: number | null;
  x: number;
  name: string;
  /** AcDbAssocSingleDependencyActionParam */
  single?: { x: number; dep: string };
}

export interface VertexParamData extends ActionParamData {
  vx: number;
  point: Vec3;
}

export interface EdgeParamData extends ActionParamData {
  ex: number;
  eh: string;
  hasCurve: boolean;
  /** 곡선 캐시 태그(90 종류 …, src/edit/assocarray/acad.ts readCurve) */
  curve: RawTag[];
}

export type AssocObjectData =
  | { kind: 'network'; head: ActionHead; net: NetworkData }
  | { kind: 'action'; head: ActionHead }
  | { kind: 'cgroup'; head: ActionHead; rest: RawTag[] }
  | { kind: 'variable'; head: ActionHead; variable: VariableData }
  | { kind: 'dependency'; dep: DependencyData }
  | { kind: 'geomdep'; dep: DependencyData; geom: GeomDependencyData }
  | { kind: 'valuedep'; dep: DependencyData; value: ValueDependencyData }
  | { kind: 'dimbody'; body: DimBodyData }
  | { kind: 'arraybody'; body: ArrayBodyData }
  | { kind: 'vertexparam'; param: VertexParamData }
  | { kind: 'edgeparam'; param: EdgeParamData };

/** 이 모듈이 푸는 DXF 형식 이름 */
export const ASSOC_OBJECT_TYPES = new Set([
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

function readDependency(r: TagReader): DependencyData {
  r.sub('AcDbAssocDependency');
  return {
    version: r.int(90),
    status: r.int(90),
    read: r.bool(290),
    write: r.bool(290),
    f3: r.bool(290),
    f4: r.bool(290),
    order: r.int(90),
    target: r.hnd(330),
    f5: r.bool(290),
    prev: r.hnd(330),
    next: r.hnd(330),
    body: r.hnd(360),
    index: r.int(90),
  };
}

function writeDependency(w: TagWriter, d: DependencyData): void {
  w.sub('AcDbAssocDependency').int(90, d.version).int(90, d.status).bool(290, d.read).bool(290, d.write).bool(290, d.f3).bool(290, d.f4).int(90, d.order).hnd(330, d.target).bool(290, d.f5).hnd(330, d.prev).hnd(330, d.next).hnd(360, d.body).int(90, d.index);
}

function readActionParam(r: TagReader): ActionParamData {
  r.sub('AcDbAssocActionParam');
  // 판 2: 90 1, 90 0, 1 이름 / 판 1: 90 0, 1 이름
  const a = r.int(90);
  const p: ActionParamData = r.is(90) ? { version: a, x: r.int(90), name: r.str(1) } : { version: null, x: a, name: r.str(1) };
  if (r.isSub('AcDbAssocSingleDependencyActionParam')) {
    r.sub('AcDbAssocSingleDependencyActionParam');
    p.single = { x: r.int(90), dep: r.hnd(330) };
  }
  return p;
}

function writeActionParam(w: TagWriter, p: ActionParamData): void {
  w.sub('AcDbAssocActionParam');
  if (p.version !== null) w.int(90, p.version);
  w.int(90, p.x).str(1, p.name);
  if (p.single) w.sub('AcDbAssocSingleDependencyActionParam').int(90, p.single.x).hnd(330, p.single.dep);
}

function readItems(r: TagReader): { items: ArrayItemData[]; matrix: number[] } {
  const n = r.int(90);
  if (n < 0 || n > 1000000) fail('항목 수');
  if (r.str(1).trim() !== 'AcDbAssocArrayItem') fail('항목 클래스');
  const items: ArrayItemData[] = [];
  for (let k = 0; k < n; k++) {
    r.sub('AcDbAssocArrayItem');
    const it: ArrayItemData = { version: r.int(90), i: r.int(90), j: r.int(90), k: r.int(90), flags: r.int(90), entity: '' };
    if (r.is(11)) it.offset = r.pt(11);
    else if (r.is(40)) {
      const m: number[] = [];
      for (let q = 0; q < 16; q++) m.push(r.num(40));
      it.matrix = m;
    }
    it.entity = r.hnd(330);
    items.push(it);
  }
  const matrix: number[] = [];
  for (let q = 0; q < 16; q++) matrix.push(r.num(40));
  return { items, matrix };
}

function writeItems(w: TagWriter, items: readonly ArrayItemData[], matrix: readonly number[]): void {
  w.int(90, items.length).str(1, 'AcDbAssocArrayItem');
  for (const it of items) {
    w.sub('AcDbAssocArrayItem').int(90, it.version).int(90, it.i).int(90, it.j).int(90, it.k).int(90, it.flags);
    if (it.offset) w.pt(11, it.offset);
    else if (it.matrix) for (const v of it.matrix) w.num(40, v);
    w.hnd(330, it.entity);
  }
  for (const v of matrix) w.num(40, v);
}

/**
 * 원본 태그 → 해석(이 모듈이 모르는 종류면 null). 배치가 다르면 AssocFormatError.
 * 구속 그룹은 동작 머리까지만 풀고 나머지(rest)는 cgroup.ts가 푼다.
 */
export function parseAssocObject(type: string, raw: readonly RawTag[]): AssocObjectData | null {
  const r = new TagReader(raw);
  const t = type.toUpperCase();
  let out: AssocObjectData;
  switch (t) {
    case 'ACDBASSOCNETWORK': {
      const head = readActionHead(r);
      r.sub('AcDbAssocNetwork');
      const version = r.int(90);
      const maxIndex = r.int(90);
      const refs = (): NetRef[] => {
        const n = r.int(90);
        if (n < 0 || n > 1000000) fail('동작 수');
        const list: NetRef[] = [];
        for (let i = 0; i < n; i++) {
          const x = r.peek();
          if (x?.code === 360) list.push({ h: r.hnd(360), owned: true });
          else list.push({ h: r.hnd(330), owned: false });
        }
        return list;
      };
      const actions = refs();
      const tail = refs();
      out = { kind: 'network', head, net: { version, maxIndex, actions, tail } };
      break;
    }
    case 'ACDBASSOCACTION':
      out = { kind: 'action', head: readActionHead(r) };
      break;
    case 'ACDBASSOC2DCONSTRAINTGROUP': {
      const head = readActionHead(r);
      const rest = raw.slice(r.i).map((x) => ({ ...x }));
      r.i = raw.length;
      out = { kind: 'cgroup', head, rest };
      break;
    }
    case 'ACDBASSOCVARIABLE': {
      const head = readActionHead(r);
      r.sub('AcDbAssocVariable');
      const variable: VariableData = {
        version: r.int(90),
        name: r.str(1),
        expr: r.str(1),
        evaluator: r.str(1),
        description: r.str(1),
        value: readValue(r),
        b1: r.bool(290),
        b2: r.bool(290),
        tail: r.int(90),
      };
      out = { kind: 'variable', head, variable };
      break;
    }
    case 'ACDBASSOCDEPENDENCY':
      out = { kind: 'dependency', dep: readDependency(r) };
      break;
    case 'ACDBASSOCGEOMDEPENDENCY': {
      const dep = readDependency(r);
      r.sub('AcDbAssocGeomDependency');
      const version = r.int(90);
      const flag = r.bool(290);
      const subentClass = r.str(1).trim();
      const subent: RawTag[] = [];
      if (subentClass === 'AcDbAssocEdgePersSubentId') {
        for (let k = 0; k < 3; k++) subent.push({ code: 90, value: r.int(90) });
      } else if (subentClass !== 'AcDbAssocSingleEdgePersSubentId') fail(`하위 객체 ID ${subentClass}`);
      const flag2 = r.bool(290);
      out = { kind: 'geomdep', dep, geom: { version, flag, subentClass, subent, flag2 } };
      break;
    }
    case 'ACDBASSOCVALUEDEPENDENCY': {
      const dep = readDependency(r);
      r.sub('AcDbAssocValueDependency');
      out = { kind: 'valuedep', dep, value: { version: r.int(90), name: r.str(1), value: readValue(r) } };
      break;
    }
    case 'ASSOCDIMDEPENDENCYBODY': {
      r.sub('AcDbAssocDependencyBody');
      const v1 = r.int(90);
      r.sub('AcDbImpAssocDimDependencyBodyBase');
      const v2 = r.int(90);
      const text = r.str(1);
      r.sub('AcDbAssocDimDependencyBody');
      const v3 = r.int(90);
      out = { kind: 'dimbody', body: { v1, v2, text, v3 } };
      break;
    }
    case 'ACDBASSOCARRAYACTIONBODY': {
      r.sub('AcDbAssocActionBody');
      const bodyVersion = r.int(90);
      let paramBased: ArrayBodyData['paramBased'];
      if (r.isSub('AcDbAssocParamBasedActionBody')) {
        r.sub('AcDbAssocParamBasedActionBody');
        paramBased = { version: r.int(90), lists: readParamLists(r) };
      }
      r.sub('AcDbAssocArrayActionBody');
      const version = r.int(90);
      const paramsClass = r.str(1).trim();
      const x = r.int(90);
      const { items, matrix } = readItems(r);
      out = { kind: 'arraybody', body: { bodyVersion, ...(paramBased ? { paramBased } : {}), version, paramsClass, x, items, matrix } };
      break;
    }
    case 'ACDBASSOCVERTEXACTIONPARAM': {
      const p = readActionParam(r);
      r.sub('AcDbAssocVertexActionParam');
      out = { kind: 'vertexparam', param: { ...p, vx: r.int(90), point: r.pt(10) } };
      break;
    }
    case 'ACDBASSOCEDGEACTIONPARAM': {
      const p = readActionParam(r);
      r.sub('AcDbAssocEdgeActionParam');
      const ex = r.int(90);
      const eh = r.hnd(330);
      const hasCurve = r.bool(290);
      const curve = hasCurve ? r.rest().map((x) => ({ ...x })) : [];
      out = { kind: 'edgeparam', param: { ...p, ex, eh, hasCurve, curve } };
      break;
    }
    default:
      return null;
  }
  if (!r.done) fail(`남은 태그 ${raw.length - r.i}개(${raw[r.i]?.code})`);
  return out;
}

/** 해석 → 원본 태그 */
export function writeAssocObject(d: AssocObjectData): RawTag[] {
  const w = new TagWriter();
  switch (d.kind) {
    case 'network': {
      writeActionHead(w, d.head);
      w.sub('AcDbAssocNetwork').int(90, d.net.version).int(90, d.net.maxIndex).int(90, d.net.actions.length);
      for (const a of d.net.actions) w.hnd(a.owned ? 360 : 330, a.h);
      w.int(90, d.net.tail.length);
      for (const a of d.net.tail) w.hnd(a.owned ? 360 : 330, a.h);
      break;
    }
    case 'action':
      writeActionHead(w, d.head);
      break;
    case 'cgroup':
      writeActionHead(w, d.head);
      w.tags(d.rest);
      break;
    case 'variable': {
      writeActionHead(w, d.head);
      const v = d.variable;
      w.sub('AcDbAssocVariable').int(90, v.version).str(1, v.name).str(1, v.expr).str(1, v.evaluator).str(1, v.description);
      writeValue(w, v.value);
      w.bool(290, v.b1).bool(290, v.b2).int(90, v.tail);
      break;
    }
    case 'dependency':
      writeDependency(w, d.dep);
      break;
    case 'geomdep':
      writeDependency(w, d.dep);
      w.sub('AcDbAssocGeomDependency').int(90, d.geom.version).bool(290, d.geom.flag).str(1, d.geom.subentClass).tags(d.geom.subent).bool(290, d.geom.flag2);
      break;
    case 'valuedep':
      writeDependency(w, d.dep);
      w.sub('AcDbAssocValueDependency').int(90, d.value.version).str(1, d.value.name);
      writeValue(w, d.value.value);
      break;
    case 'dimbody':
      w.sub('AcDbAssocDependencyBody').int(90, d.body.v1).sub('AcDbImpAssocDimDependencyBodyBase').int(90, d.body.v2).str(1, d.body.text).sub('AcDbAssocDimDependencyBody').int(90, d.body.v3);
      break;
    case 'arraybody': {
      const b = d.body;
      w.sub('AcDbAssocActionBody').int(90, b.bodyVersion);
      if (b.paramBased) {
        w.sub('AcDbAssocParamBasedActionBody').int(90, b.paramBased.version);
        writeParamLists(w, b.paramBased.lists);
      }
      w.sub('AcDbAssocArrayActionBody').int(90, b.version).str(1, b.paramsClass).int(90, b.x);
      writeItems(w, b.items, b.matrix);
      break;
    }
    case 'vertexparam':
      writeActionParam(w, d.param);
      w.sub('AcDbAssocVertexActionParam').int(90, d.param.vx).pt(10, d.param.point);
      break;
    case 'edgeparam':
      writeActionParam(w, d.param);
      w.sub('AcDbAssocEdgeActionParam').int(90, d.param.ex).hnd(330, d.param.eh).bool(290, d.param.hasCurve).tags(d.param.curve);
      break;
  }
  return w.out;
}

/** 해석을 시도한다(모르는 종류·다른 배치면 null) */
export function tryParseAssocObject(type: string, raw: readonly RawTag[] | undefined): AssocObjectData | null {
  if (!raw?.length) return null;
  try {
    return parseAssocObject(type, raw);
  } catch {
    return null;
  }
}

export { int as intOf, num as numOf };
