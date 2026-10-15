/**
 * AutoCAD 2D 구속 그룹(ACDBASSOC2DCONSTRAINTGROUP)의 본문(동작 머리 다음) 해석·쓰기.
 *
 * 공개 도면(AutoCAD 2010~2018이 저장한 DXF 60여 개, 판마다 같은 도면을 저장한 짝 포함)에서 확인한 배치:
 *   (서브클래스 표지 없음) 90 판(2), 70 0, 10 작업 평면 원점, 10 X축, 10 Y축, 360 0, 90 종속 수 + 360 종속…,
 *   90 번호 씨앗, [동작 판 2: 90 0, 90 0, 290 0], 90 노드 수,
 *   [동작 판 2: (1 클래스, 90 번호) × 노드 수],
 *   노드마다 — 판 1: 1 클래스, 330 그룹, 90 번호, 70 플래그, 90 이웃 수 + 90 이웃 번호…, 클래스별 자료
 *              판 2: 90 번호, 90 이웃 수 + 90 이웃 번호…, 70 플래그, 클래스별 자료
 *
 * 노드는 구속 그래프(형상 노드 ↔ 구속 노드)다. 형상 좌표는 작업 평면 좌표다(블록 안 그룹은 원점·축이 블록 좌표와 다를 수 있다).
 * 클래스별 자료(LAYOUTS):
 *   형상(AcConstrainedGeometry): 330 형상 종속(ACDBASSOCGEOMDEPENDENCY, 암시 점은 0), 90 0
 *     - AcConstrainedImplicitPoint: 280 점 종류(0 시작, 1 끝, 2 중간, 3 중심), 90 −1, 90 곡선 노드 번호
 *     - AcConstrainedDatumLine(X·Y 기준선): 10 점, 10 방향
 *     - AcConstrainedBoundedLine: 10 점, 10 방향, 290 0, 10 시작점, 11 끝점
 *     - AcConstrainedCircle: 10 중심, 10 법선, 10 기준 방향, 40 반지름, 40 0, 40 2π, [판 2: 40 0]
 *     - AcConstrainedArc: 원과 같은 꼴 + 10 시작점, 11 끝점
 *   구속(AcGeomConstraint): 90 0, 290 암시(점–곡선 같은 내부 구속은 1), 290 1
 *     - AcHorizontalConstraint·AcVerticalConstraint: + 90 기준선 노드 번호
 *     - AcDistanceConstraint: + 340 값 종속(→ ACDBASSOCVARIABLE), 340 치수 종속(→ 치수 객체), 280 방향 종류, [1이면 10 방향]
 *     - AcRadiusDiameterConstraint: + 340 값 종속, 340 치수 종속, 280 종류(0 반지름, 1 지름)
 *     - 나머지(일치·점–곡선·중심점·중간점·평행·직교·동일선상·동심·접선·같은 길이·고정): 자료 없음
 * 표본에 없던 클래스(각도·대칭·같은 반지름·부드러움·타원·스플라인·점 등)가 하나라도 있으면 그룹 전체를 풀지 않는다.
 */
import type { RawTag, Vec3 } from '../../core/model';
import { AssocFormatError, TagReader, TagWriter, fail } from './tags';

/** 필드 종류(DXF 코드는 따로): 정수·짧은 정수·바이트·불·실수·점·핸들·글 */
export type FieldKind = 'BL' | 'BS' | 'RC' | 'B' | 'BD' | 'P' | 'H' | 'TV';

export interface FieldDef {
  k: FieldKind;
  code: number;
  name: string;
  /** 동작 판 2에만 있다 */
  v2?: boolean;
  /** 앞 필드 값이 이것일 때만 있다 */
  when?: { field: string; eq: number };
}

const GEOM: FieldDef[] = [
  { k: 'H', code: 330, name: 'dep' },
  { k: 'BL', code: 90, name: 'gx' },
];
const LINE: FieldDef[] = [...GEOM, { k: 'P', code: 10, name: 'point' }, { k: 'P', code: 10, name: 'dir' }];
const CIRCLE: FieldDef[] = [
  ...GEOM,
  { k: 'P', code: 10, name: 'center' },
  { k: 'P', code: 10, name: 'normal' },
  { k: 'P', code: 10, name: 'ref' },
  { k: 'BD', code: 40, name: 'radius' },
  { k: 'BD', code: 40, name: 'a0' },
  { k: 'BD', code: 40, name: 'a1' },
  { k: 'BD', code: 40, name: 'cx', v2: true },
];
const CONSTRAINT: FieldDef[] = [
  { k: 'BL', code: 90, name: 'cx' },
  { k: 'B', code: 290, name: 'implied' },
  { k: 'B', code: 290, name: 'enabled' },
];
const EXPLICIT: FieldDef[] = [...CONSTRAINT, { k: 'H', code: 340, name: 'valueDep' }, { k: 'H', code: 340, name: 'dimDep' }];

/** 확인한 클래스의 노드 자료 배치 */
export const LAYOUTS: Readonly<Record<string, readonly FieldDef[]>> = {
  AcConstrainedImplicitPoint: [...GEOM, { k: 'RC', code: 280, name: 'ptype' }, { k: 'BL', code: 90, name: 'index' }, { k: 'BL', code: 90, name: 'curve' }],
  AcConstrainedDatumLine: LINE,
  AcConstrainedBoundedLine: [...LINE, { k: 'B', code: 290, name: 'ray' }, { k: 'P', code: 10, name: 'start' }, { k: 'P', code: 11, name: 'end' }],
  AcConstrainedCircle: CIRCLE,
  AcConstrainedArc: [...CIRCLE, { k: 'P', code: 10, name: 'start' }, { k: 'P', code: 11, name: 'end' }],
  AcPointCoincidenceConstraint: CONSTRAINT,
  AcPointCurveConstraint: CONSTRAINT,
  AcCenterPointConstraint: CONSTRAINT,
  AcMidPointConstraint: CONSTRAINT,
  AcParallelConstraint: CONSTRAINT,
  AcPerpendicularConstraint: CONSTRAINT,
  AcColinearConstraint: CONSTRAINT,
  AcConcentricConstraint: CONSTRAINT,
  AcTangentConstraint: CONSTRAINT,
  AcEqualLengthConstraint: CONSTRAINT,
  AcFixedConstraint: CONSTRAINT,
  AcHorizontalConstraint: [...CONSTRAINT, { k: 'BL', code: 90, name: 'datum' }],
  AcVerticalConstraint: [...CONSTRAINT, { k: 'BL', code: 90, name: 'datum' }],
  AcDistanceConstraint: [...EXPLICIT, { k: 'RC', code: 280, name: 'dirType' }, { k: 'P', code: 10, name: 'dir', when: { field: 'dirType', eq: 1 } }],
  AcRadiusDiameterConstraint: [...EXPLICIT, { k: 'RC', code: 280, name: 'rtype' }],
};

export const GEOMETRY_CLASSES = new Set(['AcConstrainedImplicitPoint', 'AcConstrainedDatumLine', 'AcConstrainedBoundedLine', 'AcConstrainedCircle', 'AcConstrainedArc']);

export type FieldValue = number | string | Vec3;

export interface CNode {
  cls: string;
  id: number;
  /** 판 1의 330(그룹 자신) */
  owner: string;
  flags: number;
  links: number[];
  f: Record<string, FieldValue>;
}

export interface CGroupData {
  /** 동작 머리의 판(1 | 2) */
  version: number;
  gversion: number;
  g70: number;
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  g360: string;
  deps: string[];
  seed: number;
  /** 동작 판 2의 90 0, 90 0, 290 0 */
  v2?: { a: number; b: number; c: boolean };
  nodes: CNode[];
}

/** 이 판에 있는 필드(조건 필드는 값을 보고 정한다) */
export function fieldsOf(cls: string, version: number): readonly FieldDef[] | null {
  const l = LAYOUTS[cls];
  if (!l) return null;
  return l.filter((f) => !f.v2 || version >= 2);
}

function present(f: FieldDef, vals: Record<string, FieldValue>): boolean {
  return !f.when || vals[f.when.field] === f.when.eq;
}

function readField(r: TagReader, f: FieldDef): FieldValue {
  switch (f.k) {
    case 'P':
      return r.pt(f.code);
    case 'H':
      return r.hnd(f.code);
    case 'TV':
      return r.str(f.code);
    case 'BD':
      return r.num(f.code);
    case 'B':
      return r.bool(f.code) ? 1 : 0;
    default:
      return r.int(f.code);
  }
}

function writeField(w: TagWriter, f: FieldDef, v: FieldValue | undefined): void {
  switch (f.k) {
    case 'P':
      w.pt(f.code, (v as Vec3) ?? { x: 0, y: 0, z: 0 });
      return;
    case 'H':
      w.hnd(f.code, (v as string) ?? '');
      return;
    case 'TV':
      w.str(f.code, (v as string) ?? '');
      return;
    case 'BD':
      w.num(f.code, (v as number) ?? 0);
      return;
    default:
      w.int(f.code, (v as number) ?? 0);
  }
}

function readNodeBody(r: TagReader, cls: string, version: number): Record<string, FieldValue> {
  const fs = fieldsOf(cls, version);
  if (!fs) return fail(`구속 노드 클래스 ${cls}`);
  const vals: Record<string, FieldValue> = {};
  for (const f of fs) if (present(f, vals)) vals[f.name] = readField(r, f);
  return vals;
}

function writeNodeBody(w: TagWriter, n: CNode, version: number): void {
  const fs = fieldsOf(n.cls, version);
  if (!fs) fail(`구속 노드 클래스 ${n.cls}`);
  for (const f of fs!) if (present(f, n.f)) writeField(w, f, n.f[f.name]);
}

/** 구속 그룹 본문(동작 머리 다음 태그) → 해석. 배치가 다르면 AssocFormatError */
export function parseGroupRest(version: number, rest: readonly RawTag[]): CGroupData {
  const r = new TagReader(rest);
  const gversion = r.int(90);
  const g70 = r.int(70);
  const origin = r.pt(10);
  const xAxis = r.pt(10);
  const yAxis = r.pt(10);
  const g360 = r.hnd(360);
  const nd = r.int(90);
  if (nd < 0 || nd > 1000000) fail('종속 수');
  const deps: string[] = [];
  for (let i = 0; i < nd; i++) deps.push(r.hnd(360));
  const seed = r.int(90);
  let v2: CGroupData['v2'];
  if (version >= 2) v2 = { a: r.int(90), b: r.int(90), c: r.bool(290) };
  const n = r.int(90);
  if (n < 0 || n > 1000000) fail('노드 수');
  const nodes: CNode[] = [];
  if (version >= 2) {
    const heads: { cls: string; id: number }[] = [];
    for (let i = 0; i < n; i++) heads.push({ cls: r.str(1).trim(), id: r.int(90) });
    for (const h of heads) {
      const id = r.int(90);
      if (id !== h.id) fail(`노드 번호 ${id} ≠ ${h.id}`);
      const nl = r.int(90);
      if (nl < 0 || nl > 100000) fail('이웃 수');
      const links: number[] = [];
      for (let k = 0; k < nl; k++) links.push(r.int(90));
      const flags = r.int(70);
      nodes.push({ cls: h.cls, id, owner: '', flags, links, f: readNodeBody(r, h.cls, version) });
    }
  } else {
    for (let i = 0; i < n; i++) {
      const cls = r.str(1).trim();
      const owner = r.hnd(330);
      const id = r.int(90);
      const flags = r.int(70);
      const nl = r.int(90);
      if (nl < 0 || nl > 100000) fail('이웃 수');
      const links: number[] = [];
      for (let k = 0; k < nl; k++) links.push(r.int(90));
      nodes.push({ cls, id, owner, flags, links, f: readNodeBody(r, cls, version) });
    }
  }
  if (!r.done) fail(`구속 그룹 끝에 남은 태그 ${rest.length - r.i}개`);
  return { version, gversion, g70, origin, xAxis, yAxis, g360, deps, seed, ...(v2 ? { v2 } : {}), nodes };
}

/** 해석 → 구속 그룹 본문 태그(동작 머리 다음) */
export function writeGroupRest(g: CGroupData, groupHandle = ''): RawTag[] {
  const w = new TagWriter();
  w.int(90, g.gversion).int(70, g.g70).pt(10, g.origin).pt(10, g.xAxis).pt(10, g.yAxis).hnd(360, g.g360).int(90, g.deps.length);
  for (const d of g.deps) w.hnd(360, d);
  w.int(90, g.seed);
  if (g.version >= 2) {
    const v2 = g.v2 ?? { a: 0, b: 0, c: false };
    w.int(90, v2.a).int(90, v2.b).bool(290, v2.c);
  }
  w.int(90, g.nodes.length);
  if (g.version >= 2) {
    for (const n of g.nodes) w.str(1, n.cls).int(90, n.id);
    for (const n of g.nodes) {
      w.int(90, n.id).int(90, n.links.length);
      for (const l of n.links) w.int(90, l);
      w.int(70, n.flags);
      writeNodeBody(w, n, g.version);
    }
  } else {
    for (const n of g.nodes) {
      w.str(1, n.cls).hnd(330, n.owner || groupHandle).int(90, n.id).int(70, n.flags).int(90, n.links.length);
      for (const l of n.links) w.int(90, l);
      writeNodeBody(w, n, g.version);
    }
  }
  return w.out;
}

export function tryParseGroupRest(version: number, rest: readonly RawTag[]): CGroupData | null {
  try {
    return parseGroupRest(version, rest);
  } catch (e) {
    if (e instanceof AssocFormatError) return null;
    throw e;
  }
}

/** 구속 그룹 본문에서 모르는 노드 클래스 이름(풀지 못한 까닭 안내용) */
export function unknownNodeClasses(version: number, rest: readonly RawTag[]): string[] {
  const out = new Set<string>();
  for (const t of rest) if (t.code === 1) {
    const s = String(t.value).trim();
    if (/^Ac[A-Z]\w*$/.test(s) && !LAYOUTS[s]) out.add(s);
  }
  void version;
  return [...out];
}
