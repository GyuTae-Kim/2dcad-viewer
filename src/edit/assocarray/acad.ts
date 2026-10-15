/**
 * AutoCAD 연관 배열 기록(원본 태그) 읽기·고쳐 쓰기.
 *
 * 공개 DXF 표본(AutoCAD R2010~R2018 형식으로 저장된 직사각형·원형·경로 연관 배열 30여 개)에서 확인한 구조:
 *  - 배치 블록 레코드의 확장 사전 → "ACAD_ASSOCNETWORK" 사전 → ACDBASSOCNETWORK(배치 망) → ACDBASSOCACTION(배열마다).
 *  - ACDBASSOCACTION(100 AcDbAssocAction): 90 판(1 | 2), 90 상태, 330 망, 360 몸체(ACDBASSOCARRAYACTIONBODY),
 *    90 번호, 90 종속 번호 최대, 90 종속 수 + 360 종속(ACDBASSOCDEPENDENCY)….
 *    판 2(AutoCAD 2013+)는 이어서 90 0, 90 동작 매개변수 수 + 360…, 90 0, 90 값 매개변수 수 + 값 매개변수….
 *    판 1은 같은 매개변수 목록이 몸체의 100 AcDbAssocParamBasedActionBody 아래(90 0 다음)에 있다.
 *  - 값 매개변수: 90 0, 1 이름, 90 단위(0 없음, 1 거리, 2 각도), 90 값 수(1), 값(40 실수 | 90 정수), 330 0, 330 0.
 *    직사각형: Items(열 수)·ItemSpacing(열 간격)·Rows·RowSpacing·RowElevation·Levels·LevelSpacing·AxesAngle·AlignItems,
 *    원형: Items·ItemSpacing(항목 사이 각도)·FillAngle·StartAngle·Radius·Rows…, 경로: Items·ItemSpacing·Method(0 등분할)·
 *    AlignItems·MaintainZ·Orientation·PathDirection(0 = 경로 끝에서, 없으면 시작에서)·FillPath·TangentOrientationAngle·Rows….
 *  - 동작 매개변수: ACDBASSOCVERTEXACTIONPARAM "BaseNormal"·"Origin"(원형 중심, 배열 블록 좌표)·"basePoint"(원본 블록 좌표),
 *    경로는 ACDBASSOCEDGEACTIONPARAM "RowProfile"(330 경로 종속, 290 1, 90 곡선 종류 23 = 선분: 10 시작, 10 방향 벡터).
 *  - 몸체(100 AcDbAssocArrayActionBody): 90 1, 1 매개변수 클래스(AcDbAssocArray…Parameters), 90 0, 90 항목 수,
 *    1 AcDbAssocArrayItem, 항목마다 100 AcDbAssocArrayItem, 90 0, 90 i, 90 j, 90 k, 90 플래그(8 = 이동만: 11/21/31,
 *    12 = 4×4 행렬 40×16, 행 우선), 330 항목 참조(배열 블록 안의 INSERT). 끝에 40×16 배열 참조 행렬.
 *  - 종속(100 AcDbAssocDependency): 90 2, 90 상태, 290 읽기, 290 쓰기, 290, 290, 90 순서, 330 대상 …
 *    대상: 배열 블록 레코드(쓰기), 원본 블록 레코드(읽기), 배열 참조(읽기·쓰기), 경로 곡선(읽기).
 * 표본에 없던 것(지운 항목의 플래그, 대체 항목의 종속, 원형의 항목 회전·방향 값)은 쓰지 않는다:
 *  지운 항목은 목록에서 빼고, 항목 회전은 항목 행렬로만 나타낸다.
 */
import type { CadDocument, GenericObject, InsertEntity, RawTag, Vec2, Vec3 } from '../../core/model';
import { normalizeHandle } from '../../core/model';
import type { Affine } from '../geom/math';
import type { ArrayItem, ArrayKind, ArrayParams, CachedPiece } from './types';

const ITEM_CLASS = 'AcDbAssocArrayItem';
const PARAM_CLASS: Record<string, ArrayKind> = {
  AcDbAssocArrayRectangularParameters: 'rect',
  AcDbAssocArrayPolarParameters: 'polar',
  AcDbAssocArrayPathParameters: 'path',
};

/** 값 매개변수 이름(표본에서 본 것 + ObjectARX 이름) */
const VALUE_NAMES = new Set([
  'Items',
  'ItemSpacing',
  'Rows',
  'RowSpacing',
  'RowElevation',
  'Levels',
  'LevelSpacing',
  'AxesAngle',
  'AlignItems',
  'FillAngle',
  'StartAngle',
  'Radius',
  'Method',
  'MaintainZ',
  'Orientation',
  'PathDirection',
  'FillPath',
  'TangentOrientationAngle',
  'RotateItems',
  'Direction',
]);

const num = (v: string | number | undefined, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : d;
};
const str = (v: string | number | undefined): string => String(v ?? '').trim();
const hnd = (v: string | number | undefined): string => {
  const s = str(v);
  return s && s !== '0' ? normalizeHandle(s) : '';
};

function generic(doc: CadDocument, h: string): GenericObject | undefined {
  return h ? (doc.objects.get(normalizeHandle(h)) as GenericObject | undefined) : undefined;
}

export interface AcadValueParam {
  name: string;
  unit: number;
  /** 값 태그(코드 40 | 90 …) */
  code: number;
  value: number;
  /** 매개변수가 든 객체(동작 또는 몸체)와 그 원본 태그 안의 값 태그 자리 */
  holder: string;
  index: number;
}

export interface AcadDependency {
  handle: string;
  target: string;
  read: boolean;
  write: boolean;
}

export interface AcadItemTag {
  index: number;
  row: number;
  level: number;
  flags: number;
  matrix: Affine;
  z: number;
  handle: string;
}

export interface AcadArray {
  action: string;
  body: string;
  /** 원본 태그가 있는지(DXF에서 읽었는지). DWG에서 읽은 객체는 원본 비트만 있어 매개변수를 모른다 */
  raw: boolean;
  /** 동작의 판(1: 값 매개변수가 몸체에, 2: 동작에) */
  version: number;
  kind: ArrayKind | null;
  values: Map<string, AcadValueParam>;
  vertex: Map<string, { handle: string; point: Vec3 }>;
  edge?: { handle: string; dep: string; curve?: CachedPiece[] };
  deps: AcadDependency[];
  items: AcadItemTag[];
  /** 몸체 끝의 배열 참조 행렬 */
  insertMatrix: Affine | null;
  arrayRecord?: string;
  sourceRecord?: string;
  pathEntity?: string;
}

/** 값 매개변수 목록(원본 태그 안의 자리) */
export function scanValues(holder: string, tags: readonly RawTag[], out: Map<string, AcadValueParam>): void {
  for (let i = 1; i + 3 < tags.length; i++) {
    const t = tags[i]!;
    if (t.code !== 1 || tags[i - 1]!.code !== 90 || tags[i + 1]!.code !== 90 || tags[i + 2]!.code !== 90) continue;
    const name = str(t.value);
    if (!VALUE_NAMES.has(name)) continue;
    const vt = tags[i + 3]!;
    if (vt.code !== 40 && vt.code !== 90 && vt.code !== 70 && vt.code !== 290) continue;
    out.set(name, { name, unit: num(tags[i + 1]!.value), code: vt.code, value: num(vt.value), holder, index: i + 3 });
  }
}

function parseDependency(o: GenericObject): AcadDependency | null {
  const t = o.raw ?? [];
  const at = t.findIndex((x) => x.code === 100 && str(x.value) === 'AcDbAssocDependency');
  if (at < 0) return null;
  const flags: boolean[] = [];
  let target = '';
  for (let i = at + 1; i < t.length; i++) {
    const x = t[i]!;
    if (x.code === 100) break;
    if (x.code === 290 && flags.length < 2) flags.push(num(x.value) !== 0);
    if (x.code === 330 && !target) {
      target = hnd(x.value);
      break;
    }
  }
  return { handle: o.handle, target, read: flags[0] ?? true, write: flags[1] ?? false };
}

function subclassAt(t: readonly RawTag[], name: string): number {
  return t.findIndex((x) => x.code === 100 && str(x.value) === name);
}

/** 동작 매개변수(점·모서리) */
function parseActionParam(doc: CadDocument, o: GenericObject, a: AcadArray): void {
  const t = o.raw ?? [];
  const head = subclassAt(t, 'AcDbAssocActionParam');
  const name = head >= 0 ? str(t.slice(head + 1).find((x) => x.code === 1)?.value) : '';
  if (o.type === 'ACDBASSOCVERTEXACTIONPARAM') {
    const v = subclassAt(t, 'AcDbAssocVertexActionParam');
    if (v < 0) return;
    let p: Vec3 | null = null;
    for (let i = v + 1; i + 2 < t.length; i++)
      if (t[i]!.code === 10 && t[i + 1]!.code === 20 && t[i + 2]!.code === 30) {
        p = { x: num(t[i]!.value), y: num(t[i + 1]!.value), z: num(t[i + 2]!.value) };
        break;
      }
    if (p && name) a.vertex.set(name, { handle: o.handle, point: p });
    return;
  }
  if (o.type === 'ACDBASSOCEDGEACTIONPARAM') {
    const sd = subclassAt(t, 'AcDbAssocSingleDependencyActionParam');
    let dep = '';
    if (sd >= 0) for (let i = sd + 1; i < t.length && t[i]!.code !== 100; i++) if (t[i]!.code === 330) dep = hnd(t[i]!.value);
    const ed = subclassAt(t, 'AcDbAssocEdgeActionParam');
    const edge: AcadArray['edge'] = { handle: o.handle, dep };
    if (ed >= 0) {
      // 90 0, 330 0, 290 곡선 있음, 그다음 곡선(90 종류 …)
      let i = ed + 1;
      while (i < t.length && t[i]!.code !== 290) i++;
      if (t[i]?.code === 290 && num(t[i]!.value) !== 0) {
        const c = readCurve(t, i + 1);
        if (c?.pieces.length) edge.curve = c.pieces;
      }
    }
    a.edge = edge;
    void doc;
  }
}

function pt3(t: readonly RawTag[], i: number): Vec3 | null {
  if (t[i]?.code !== 10 || t[i + 1]?.code !== 20 || t[i + 2]?.code !== 30) return null;
  return { x: num(t[i]!.value), y: num(t[i + 1]!.value), z: num(t[i + 2]!.value) };
}

/**
 * AcGe 곡선 캐시(표본에서 본 종류만): 23 선분(10 시작점, 10 방향 벡터), 11 원호(10 중심, 10 법선, 10 기준 벡터,
 * 40 반지름, 40 시작 각도, 40 끝 각도, 40 …), 42 NURBS(차수·매듭·무게·조정점), 47 복합 곡선(90 개수 + 곡선들). 모르는 종류면 null.
 */
export function readCurve(t: readonly RawTag[], i: number, depth = 0): { pieces: CachedPiece[]; next: number } | null {
  if (t[i]?.code !== 90 || depth > 4) return null;
  const type = num(t[i]!.value);
  if (type === 23) {
    const a = pt3(t, i + 1);
    const v = pt3(t, i + 4);
    if (!a || !v) return null;
    return { pieces: [{ k: 'line', a: { x: a.x, y: a.y }, b: { x: a.x + v.x, y: a.y + v.y } }], next: i + 7 };
  }
  if (type === 11) {
    const c = pt3(t, i + 1);
    const n = pt3(t, i + 4);
    const ref = pt3(t, i + 7);
    if (!c || !n || !ref) return null;
    let j = i + 10;
    const vals: number[] = [];
    while (t[j]?.code === 40) vals.push(num(t[j++]!.value));
    if (vals.length < 3) return null;
    const [r, s0, s1] = vals as [number, number, number];
    const rl = Math.hypot(ref.x, ref.y, ref.z) || 1;
    const u = { x: ref.x / rl, y: ref.y / rl };
    // 법선 × 기준 벡터(평면 안의 둘째 축)
    const w = { x: n.y * ref.z - n.z * ref.y, y: n.z * ref.x - n.x * ref.z };
    const wl = Math.hypot(w.x, w.y) || 1;
    const v = { x: w.x / wl, y: w.y / wl };
    const at = (a: number) => ({ x: c.x + r * (Math.cos(a) * u.x + Math.sin(a) * v.x), y: c.y + r * (Math.cos(a) * u.y + Math.sin(a) * v.y) });
    const p0 = at(s0);
    const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
    const ccw = u.x * v.y - u.y * v.x >= 0;
    return { pieces: [{ k: 'arc', c: { x: c.x, y: c.y }, r, a0, sw: (s1 - s0) * (ccw ? 1 : -1) }], next: j };
  }
  if (type === 42) {
    // NURBS: 70 플래그…, 90 차수, 40 공차…, 매듭 배열(90 개수, 90 용량, 90 증분 + 40…), 무게 배열(같은 꼴), 조정점 배열(10/20/30…)
    let j = i + 1;
    while (t[j]?.code === 70) j++;
    if (t[j]?.code !== 90) return null;
    const degree = num(t[j++]!.value);
    while (t[j]?.code === 40) j++;
    const head = (): number | null => {
      if (t[j]?.code !== 90 || t[j + 1]?.code !== 90 || t[j + 2]?.code !== 90) return null;
      const n = num(t[j]!.value);
      j += 3;
      return n;
    };
    const nk = head();
    if (nk === null) return null;
    const knots: number[] = [];
    for (let k = 0; k < nk; k++) {
      if (t[j]?.code !== 40) return null;
      knots.push(num(t[j++]!.value));
    }
    const nw = head();
    if (nw === null) return null;
    const weights: number[] = [];
    for (let k = 0; k < nw; k++) {
      if (t[j]?.code !== 40) return null;
      weights.push(num(t[j++]!.value));
    }
    const nc = head();
    if (nc === null) return null;
    const ctrl: Vec2[] = [];
    for (let k = 0; k < nc; k++) {
      const q = pt3(t, j);
      if (!q) return null;
      ctrl.push({ x: q.x, y: q.y });
      j += 3;
    }
    if (degree < 1 || knots.length !== ctrl.length + degree + 1 || (weights.length && weights.length !== ctrl.length)) return null;
    return { pieces: [{ k: 'nurbs', degree, knots, ctrl, ...(weights.length ? { weights } : {}) }], next: j };
  }
  if (type === 47) {
    if (t[i + 1]?.code !== 90) return null;
    const n = num(t[i + 1]!.value);
    const pieces: CachedPiece[] = [];
    let j = i + 2;
    for (let k = 0; k < n; k++) {
      const c = readCurve(t, j, depth + 1);
      if (!c) return null;
      pieces.push(...c.pieces);
      j = c.next;
    }
    return { pieces, next: j };
  }
  return null;
}

function matrix16(t: readonly RawTag[], i: number): Affine | null {
  for (let k = 0; k < 16; k++) if (t[i + k]?.code !== 40) return null;
  const m = (k: number) => num(t[i + k]!.value);
  return [m(0), m(4), m(1), m(5), m(3), m(7)];
}

/** 몸체의 항목 목록과 끝 행렬. 자리를 못 찾으면 null */
function bodyLayout(t: readonly RawTag[]): { classAt: number; countAt: number; itemsAt: number; trailAt: number; paramsClass: string; items: AcadItemTag[] } | null {
  const at = subclassAt(t, 'AcDbAssocArrayActionBody');
  if (at < 0) return null;
  const classAt = t.findIndex((x, i) => i > at && x.code === 1 && /^AcDbAssocArray\w*Parameters$/.test(str(x.value)));
  if (classAt < 0) return null;
  const itemClassAt = t.findIndex((x, i) => i > classAt && x.code === 1 && str(x.value) === ITEM_CLASS);
  if (itemClassAt < 0 || t[itemClassAt - 1]?.code !== 90) return null;
  const countAt = itemClassAt - 1;
  const items: AcadItemTag[] = [];
  let i = itemClassAt + 1;
  while (i < t.length && t[i]!.code === 100 && str(t[i]!.value) === ITEM_CLASS) {
    const f = [1, 2, 3, 4, 5].map((k) => t[i + k]);
    if (f.some((x) => x?.code !== 90)) return null;
    const flags = num(f[4]!.value);
    let j = i + 6;
    let m: Affine = [1, 0, 0, 1, 0, 0];
    let z = 0;
    if (t[j]?.code === 11) {
      m = [1, 0, 0, 1, num(t[j]!.value), num(t[j + 1]?.value)];
      z = num(t[j + 2]?.value);
      j += 3;
    } else if (t[j]?.code === 40) {
      const mm = matrix16(t, j);
      if (!mm) return null;
      m = mm;
      z = num(t[j + 11]!.value);
      j += 16;
    }
    let handle = '';
    while (j < t.length && t[j]!.code !== 330 && t[j]!.code !== 100) j++;
    if (t[j]?.code === 330) handle = hnd(t[j++]!.value);
    items.push({ index: num(f[1]!.value), row: num(f[2]!.value), level: num(f[3]!.value), flags, matrix: m, z, handle });
    i = j;
    // 다음 항목까지의 모르는 태그는 건너뛴다(마지막 항목 뒤는 끝 행렬)
    if (items.length < num(t[countAt]!.value)) while (i < t.length && !(t[i]!.code === 100 && str(t[i]!.value) === ITEM_CLASS)) i++;
  }
  return { classAt, countAt, itemsAt: itemClassAt + 1, trailAt: i, paramsClass: str(t[classAt]!.value), items };
}

/** 배열 참조의 AutoCAD 연관 배열 기록(없으면 null) */
export function findAcadArray(doc: CadDocument, ins: InsertEntity): AcadArray | null {
  for (const r of ins.reactors ?? []) {
    const dep = generic(doc, r);
    if (dep?.type !== 'ACDBASSOCDEPENDENCY' || !dep.owner) continue;
    const action = generic(doc, dep.owner);
    if (action?.type !== 'ACDBASSOCACTION') continue;
    const a = parseAction(doc, action);
    if (a) return a;
  }
  return null;
}

/** 동작 하나(배열 동작이 아니면 null) */
export function parseAction(doc: CadDocument, action: GenericObject): AcadArray | null {
  const ah = normalizeHandle(action.handle);
  // 몸체: 동작의 360 중 배열 몸체, 없으면(원본 태그 없음) 소유자가 이 동작인 배열 몸체
  let body: GenericObject | undefined;
  for (const t of action.raw ?? []) {
    if (t.code !== 360) continue;
    const o = generic(doc, hnd(t.value));
    if (o?.type === 'ACDBASSOCARRAYACTIONBODY') body = o;
  }
  if (!body) for (const o of doc.objects.values()) if (o.type === 'ACDBASSOCARRAYACTIONBODY' && o.owner && normalizeHandle(o.owner) === ah) body = o as GenericObject;
  if (!body) return null;
  const a: AcadArray = {
    action: ah,
    body: normalizeHandle(body.handle),
    raw: !!action.raw?.length && !!body.raw?.length,
    version: 1,
    kind: null,
    values: new Map(),
    vertex: new Map(),
    deps: [],
    items: [],
    insertMatrix: null,
  };
  // 종속·동작 매개변수: 동작·몸체의 360, 원본 태그가 없으면 소유자로 찾는다
  const owned: GenericObject[] = [];
  const seen = new Set<string>();
  const take = (o: GenericObject | undefined) => {
    if (!o || seen.has(o.handle)) return;
    seen.add(o.handle);
    owned.push(o);
  };
  for (const src of [action, body]) for (const t of src.raw ?? []) if (t.code === 360) take(generic(doc, hnd(t.value)));
  if (!a.raw) for (const o of doc.objects.values()) if (o.owner && (normalizeHandle(o.owner) === ah || normalizeHandle(o.owner) === a.body)) take(o as GenericObject);
  for (const o of owned) {
    if (o.type === 'ACDBASSOCDEPENDENCY') {
      const d = parseDependency(o);
      if (d) a.deps.push(d);
      else a.deps.push({ handle: normalizeHandle(o.handle), target: '', read: true, write: false });
    } else if (/^ACDBASSOC\w*ACTIONPARAM$/.test(o.type)) parseActionParam(doc, o, a);
  }
  if (a.raw) {
    const av = (action.raw ?? []).find((x, i, t) => x.code === 90 && i > 0 && t[i - 1]!.code === 100 && str(t[i - 1]!.value) === 'AcDbAssocAction');
    a.version = av ? num(av.value, 1) : 1;
    scanValues(ah, action.raw ?? [], a.values);
    scanValues(a.body, body.raw ?? [], a.values);
    const lay = bodyLayout(body.raw ?? []);
    if (lay) {
      a.kind = PARAM_CLASS[lay.paramsClass] ?? null;
      a.items = lay.items;
      a.insertMatrix = matrix16(body.raw ?? [], lay.trailAt);
    }
  }
  // 종속 대상
  for (const d of a.deps) {
    if (!d.target) continue;
    const isRecord = [...doc.blockRecords.values()].some((r) => normalizeHandle(r.handle) === d.target);
    if (isRecord) {
      if (d.write && !d.read) a.arrayRecord = d.target;
      else if (d.read && !d.write) a.sourceRecord = d.target;
    } else {
      const e = doc.entityIndex.get(d.target);
      if (e && e.type !== 'INSERT' && d.read && !d.write) a.pathEntity = d.target;
    }
  }
  if (a.edge?.dep) {
    const d = a.deps.find((x) => x.handle === a.edge!.dep);
    if (d?.target && doc.entityIndex.has(d.target)) a.pathEntity = d.target;
  }
  // 원본 태그가 없으면(DWG) 경로 곡선은 반응자로 찾는다
  if (!a.raw && !a.pathEntity) {
    const depSet = new Set(a.deps.map((d) => d.handle));
    for (const e of doc.entityIndex.values()) {
      if (e.type === 'INSERT' || !e.reactors?.some((r) => depSet.has(normalizeHandle(r)))) continue;
      a.pathEntity = e.handle;
      a.kind = 'path';
      break;
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// 매개변수 ↔ AutoCAD 값
// ---------------------------------------------------------------------------

const val = (a: AcadArray, name: string): number | undefined => a.values.get(name)?.value;

/**
 * AutoCAD 값 → 이 앱의 매개변수(원본 태그가 있고 종류를 알 때). 항목 회전은 항목 행렬로 정한다.
 * 기준점(basePoint)은 원본 블록 좌표, 원점(Origin)은 배열 블록 좌표.
 */
export function paramsFromAcad(a: AcadArray, items: readonly AcadItemTag[]): ArrayParams | null {
  if (!a.kind || !a.raw) return null;
  const bp = a.vertex.get('basePoint')?.point;
  const origin = a.vertex.get('Origin')?.point;
  const common = {
    base: bp ? { x: bp.x, y: bp.y } : { x: 0, y: 0 },
    rows: Math.max(1, Math.round(val(a, 'Rows') ?? 1)),
    rowSpacing: val(a, 'RowSpacing') ?? 1,
    rowElevation: val(a, 'RowElevation') ?? 0,
    levels: Math.max(1, Math.round(val(a, 'Levels') ?? 1)),
    levelSpacing: val(a, 'LevelSpacing') ?? 1,
  };
  if (a.kind === 'rect') {
    return {
      kind: 'rect',
      ...common,
      origin: origin ? { x: origin.x, y: origin.y } : { x: 0, y: 0 },
      columns: Math.max(1, Math.round(val(a, 'Items') ?? 1)),
      columnSpacing: val(a, 'ItemSpacing') ?? 1,
      axesAngle: val(a, 'AxesAngle') ?? Math.PI / 2,
    };
  }
  if (a.kind === 'polar') {
    const n = Math.max(1, Math.round(val(a, 'Items') ?? 1));
    // 항목 회전: 첫 항목이 아닌 항목 가운데 회전이 있는 것이 있으면 예(값 매개변수 RotateItems가 있으면 그것)
    const ri = val(a, 'RotateItems');
    const rotated = items.some((it) => Math.abs(Math.atan2(it.matrix[1], it.matrix[0])) > 1e-9);
    const rotateItems = ri !== undefined ? ri !== 0 : n < 2 || items.length < 2 ? true : rotated;
    return {
      kind: 'polar',
      ...common,
      center: origin ? { x: origin.x, y: origin.y } : { x: 0, y: 0 },
      items: n,
      itemAngle: val(a, 'ItemSpacing') ?? (2 * Math.PI) / n,
      fillAngle: val(a, 'FillAngle') ?? 2 * Math.PI,
      startAngle: val(a, 'StartAngle') ?? 0,
      radius: val(a, 'Radius') ?? 0,
      rotateItems,
    };
  }
  const pd = val(a, 'PathDirection');
  return {
    kind: 'path',
    ...common,
    method: (val(a, 'Method') ?? 0) === 0 ? 'divide' : 'measure',
    items: Math.max(1, Math.round(val(a, 'Items') ?? 1)),
    spacing: val(a, 'ItemSpacing') ?? 1,
    align: (val(a, 'AlignItems') ?? 1) !== 0,
    zDir: (val(a, 'MaintainZ') ?? 1) !== 0,
    reverse: pd !== undefined && pd === 0,
    path: a.pathEntity ?? null,
    ...(a.edge?.curve ? { fallback: a.edge.curve } : {}),
  };
}

/** 이 앱의 매개변수 → AutoCAD 값 매개변수 이름·값 */
export function acadValuesOf(p: ArrayParams, pathSpacing?: number): Map<string, number> {
  const m = new Map<string, number>([
    ['Rows', p.rows],
    ['RowSpacing', p.rowSpacing],
    ['RowElevation', p.rowElevation],
    ['Levels', p.levels],
    ['LevelSpacing', p.levelSpacing],
  ]);
  if (p.kind === 'rect') {
    m.set('Items', p.columns);
    m.set('ItemSpacing', p.columnSpacing);
    m.set('AxesAngle', p.axesAngle);
  } else if (p.kind === 'polar') {
    m.set('Items', p.items);
    m.set('ItemSpacing', p.itemAngle);
    m.set('FillAngle', p.fillAngle);
    m.set('StartAngle', p.startAngle);
    m.set('Radius', p.radius);
    m.set('RotateItems', p.rotateItems ? 1 : 0);
  } else {
    m.set('Items', p.items);
    m.set('ItemSpacing', pathSpacing ?? p.spacing);
    m.set('Method', p.method === 'divide' ? 0 : 1);
    m.set('AlignItems', p.align ? 1 : 0);
    m.set('MaintainZ', p.zDir ? 1 : 0);
    m.set('PathDirection', p.reverse ? 0 : 1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// 고쳐 쓰기
// ---------------------------------------------------------------------------

function fmtTag(code: number, v: number): RawTag {
  if (code === 40) return { code, value: v };
  return { code, value: Math.round(v) };
}

/** 4×4 행 우선 행렬 태그 */
export function matrixTags(m: Affine, z = 0): RawTag[] {
  const vals = [m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, 1, z, 0, 0, 0, 1];
  return vals.map((v) => ({ code: 40, value: v }));
}

const isTranslation = (m: Affine) => Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12 && Math.abs(m[3] - 1) < 1e-12;

/** 항목 하나의 태그 */
export function itemTags(it: { index: number; row: number; level: number; matrix: Affine; z: number }, handle: string): RawTag[] {
  const out: RawTag[] = [{ code: 100, value: ITEM_CLASS }, { code: 90, value: 0 }, { code: 90, value: it.index }, { code: 90, value: it.row }, { code: 90, value: it.level }];
  if (isTranslation(it.matrix)) {
    out.push({ code: 90, value: 8 }, { code: 11, value: it.matrix[4] }, { code: 21, value: it.matrix[5] }, { code: 31, value: it.z });
  } else {
    out.push({ code: 90, value: 12 }, ...matrixTags(it.matrix, it.z));
  }
  out.push({ code: 330, value: handle });
  return out;
}

/** 값 매개변수를 고친 원본 태그(그 객체에 든 것만). 바뀐 것이 없으면 null */
export function patchValues(a: AcadArray, holder: string, tags: readonly RawTag[], values: Map<string, number>): RawTag[] | null {
  let out: RawTag[] | null = null;
  for (const [name, v] of values) {
    const p = a.values.get(name);
    if (!p || p.holder !== holder) continue;
    const cur = tags[p.index];
    if (!cur || cur.code !== p.code) continue;
    const next = fmtTag(p.code, v);
    if (num(cur.value) === num(next.value)) continue;
    out ??= tags.map((t) => ({ ...t }));
    out[p.index] = next;
  }
  return out;
}

/** 점 동작 매개변수의 점을 바꾼 원본 태그(같으면 null) */
export function patchVertex(tags: readonly RawTag[], p: Vec3): RawTag[] | null {
  const v = subclassAt(tags, 'AcDbAssocVertexActionParam');
  if (v < 0) return null;
  for (let i = v + 1; i + 2 < tags.length; i++)
    if (tags[i]!.code === 10 && tags[i + 1]!.code === 20 && tags[i + 2]!.code === 30) {
      if (num(tags[i]!.value) === p.x && num(tags[i + 1]!.value) === p.y && num(tags[i + 2]!.value) === p.z) return null;
      const out = tags.map((t) => ({ ...t }));
      out[i] = { code: 10, value: p.x };
      out[i + 1] = { code: 20, value: p.y };
      out[i + 2] = { code: 30, value: p.z };
      return out;
    }
  return null;
}

/** 몸체의 항목 목록·끝 행렬을 다시 쓴 원본 태그(자리를 못 찾으면 null) */
export function rewriteBody(tags: readonly RawTag[], items: readonly (ArrayItem & { handle: string })[], insertMatrix: Affine, insertZ = 0): RawTag[] | null {
  const lay = bodyLayout(tags);
  if (!lay) return null;
  const out: RawTag[] = tags.slice(0, lay.countAt).map((t) => ({ ...t }));
  out.push({ code: 90, value: items.length }, { code: 1, value: ITEM_CLASS });
  for (const it of items) out.push(...itemTags(it, it.handle));
  const trail = tags.slice(lay.trailAt).map((t) => ({ ...t }));
  if (matrix16(trail, 0)) trail.splice(0, 16, ...matrixTags(insertMatrix, insertZ));
  out.push(...trail);
  return out;
}
