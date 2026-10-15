/**
 * 시험용 도면: AutoCAD 연관 배열 기록(원본 태그)을 AutoCAD가 쓰는 배치대로 손으로 만든다.
 * 배치는 공개 DXF 표본에서 본 것(src/edit/assocarray/acad.ts 머리말)이고, 값은 이 시험이 정한 것이다(표본 파일을 옮기지 않는다).
 *  - 판 1(AutoCAD 2010~2012): 값 매개변수가 몸체(AcDbAssocParamBasedActionBody)에
 *  - 판 2(AutoCAD 2013+): 값 매개변수가 동작(AcDbAssocAction)에
 */
import type { BlockDef, BlockRecord, CadDocument, Entity, GenericObject, InsertEntity, RawTag } from '../../src/core/model';
import { MODEL_SPACE, entityDefaults, tableKey } from '../../src/core/model';
import { createNewDocument } from '../../src/core/newdoc';
import { EditSession } from '../../src/edit/session';
import type { Affine } from '../../src/edit/geom/math';

export interface Bench {
  doc: CadDocument;
  s: EditSession;
}

export function bench(): Bench {
  const doc = createNewDocument('metric');
  const s = new EditSession(doc, () => {});
  return { doc, s };
}

export function addBlock(b: Bench, name: string, entities: Entity[]): BlockDef {
  const key = tableKey(name);
  const rec: BlockRecord = { name, handle: b.s.newHandle(), flags: 1, insertUnits: 0, explodable: true, scalable: true };
  const def: BlockDef = { name, handle: b.s.newHandle(), recordHandle: rec.handle, basePoint: { x: 0, y: 0, z: 0 }, flags: 1, entities: [], endHandle: b.s.newHandle() };
  for (const e of entities) {
    if (!e.handle) e.handle = b.s.newHandle();
    e.owner = rec.handle;
  }
  def.entities = entities;
  b.s.commit({ label: 'T', ops: [{ kind: 'blockRecord', key, before: null, after: rec }, { kind: 'blockDef', key, before: null, after: def }] });
  return b.doc.blocks.get(key)!;
}

export function addModel(b: Bench, e: Entity): Entity {
  if (!e.handle) e.handle = b.s.newHandle();
  e.owner = b.doc.blocks.get(MODEL_SPACE)!.recordHandle;
  b.s.commit({ label: 'T', ops: [{ kind: 'add', block: MODEL_SPACE, entity: e }] });
  return b.doc.entityIndex.get(e.handle)!;
}

export function lineE(x0: number, y0: number, x1: number, y1: number): Entity {
  return { ...entityDefaults(), type: 'LINE', handle: '', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } };
}

export function circleE(x: number, y: number, r: number): Entity {
  return { ...entityDefaults(), type: 'CIRCLE', handle: '', center: { x, y, z: 0 }, radius: r };
}

export function insertE(block: string, x: number, y: number, rotation = 0, sx = 1): InsertEntity {
  return {
    ...entityDefaults(),
    type: 'INSERT',
    handle: '',
    block,
    insert: { x, y, z: 0 },
    scale: { x: sx, y: 1, z: 1 },
    rotation,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attribs: [],
  };
}

function addObject(b: Bench, type: string, owner: string, raw: RawTag[], handle = b.s.newHandle()): GenericObject {
  const o: GenericObject = { type, handle, owner, raw };
  b.s.commit({ label: 'T', ops: [{ kind: 'object', key: handle, before: null, after: o }] });
  return o;
}

const T = (code: number, value: string | number): RawTag => ({ code, value });

/** 값 매개변수 태그 */
function valueParams(list: [string, number, number, 40 | 90][]): RawTag[] {
  const out: RawTag[] = [T(90, 0), T(90, list.length)];
  for (const [name, unit, v, code] of list) out.push(T(90, 0), T(1, name), T(90, unit), T(90, 1), T(code, v), T(330, '0'), T(330, '0'));
  return out;
}

function vertexParam(b: Bench, owner: string, name: string, x: number, y: number, z: number, v2: boolean): GenericObject {
  return addObject(b, 'ACDBASSOCVERTEXACTIONPARAM', owner, [
    T(100, 'AcDbAssocActionParam'),
    ...(v2 ? [T(90, 1)] : []),
    T(90, 0),
    T(1, name),
    T(100, 'AcDbAssocSingleDependencyActionParam'),
    T(90, 0),
    T(330, '0'),
    T(100, 'AcDbAssocVertexActionParam'),
    T(90, 0),
    T(10, x),
    T(20, y),
    T(30, z),
  ]);
}

function dependency(b: Bench, owner: string, target: string, read: boolean, write: boolean, id: number, handle: string): GenericObject {
  return addObject(
    b,
    'ACDBASSOCDEPENDENCY',
    owner,
    [
      T(100, 'AcDbAssocDependency'),
      T(90, 2),
      T(90, 0),
      T(290, read ? 1 : 0),
      T(290, write ? 1 : 0),
      T(290, 1),
      T(290, 1),
      T(90, read && write ? -2147483648 : 0),
      T(330, target),
      T(290, 0),
      T(330, '0'),
      T(330, '0'),
      T(360, '0'),
      T(90, id),
    ],
    handle,
  );
}

/** 4×4 행 우선 */
function mat(m: Affine, z = 0): RawTag[] {
  return [m[0], m[2], 0, m[4], m[1], m[3], 0, m[5], 0, 0, 1, z, 0, 0, 0, 1].map((v) => T(40, v));
}

export interface AcadItem {
  i: number;
  j: number;
  m: Affine;
}

export interface AcadArraySpec {
  kind: 'rect' | 'polar' | 'path';
  version: 1 | 2;
  values: [string, number, number, 40 | 90][];
  vertex: { Origin: [number, number]; basePoint?: [number, number] };
  /** 원본 블록 내용 */
  source: Entity[];
  items: AcadItem[];
  /** 배열 참조 자리·회전·X 축척 */
  at?: [number, number, number?, number?];
  /** 경로: 곡선 캐시 태그(90 종류 …) */
  curve?: RawTag[];
}

export interface AcadArray {
  ins: InsertEntity;
  action: string;
  body: string;
  source: string;
  array: string;
}

/** AutoCAD 연관 배열 하나(원본 블록 + 배열 블록 + 배열 참조 + 연관 객체) */
export function addAcadArray(b: Bench, spec: AcadArraySpec): AcadArray {
  const src = addBlock(b, `*U${b.s.newHandle()}`, spec.source);
  const items = spec.items.map((it) => {
    const a = Math.atan2(it.m[1], it.m[0]);
    const e = insertE(src.name, it.m[4], it.m[5], a);
    e.handle = b.s.newHandle();
    return e;
  });
  const arr = addBlock(b, `*U${b.s.newHandle()}`, items);
  const [x, y, rot, sx] = spec.at ?? [0, 0, 0, 1];
  const ins = insertE(arr.name, x, y, rot ?? 0, sx ?? 1);
  const actionH = b.s.newHandle();
  const bodyH = b.s.newHandle();
  const depH = [b.s.newHandle(), b.s.newHandle(), b.s.newHandle()];
  ins.reactors = [depH[2]!];
  addModel(b, ins);
  const v2 = spec.version === 2;
  const vp = [vertexParam(b, v2 ? actionH : bodyH, 'BaseNormal', 0, 0, 1, v2), vertexParam(b, v2 ? actionH : bodyH, 'Origin', spec.vertex.Origin[0], spec.vertex.Origin[1], 0, v2)];
  let edge: GenericObject | null = null;
  if (spec.curve)
    edge = addObject(b, 'ACDBASSOCEDGEACTIONPARAM', v2 ? actionH : bodyH, [
      T(100, 'AcDbAssocActionParam'),
      T(90, 1),
      T(90, 0),
      T(1, 'RowProfile'),
      T(100, 'AcDbAssocSingleDependencyActionParam'),
      T(90, 0),
      T(330, '0'),
      T(100, 'AcDbAssocEdgeActionParam'),
      T(90, 0),
      T(330, '0'),
      T(290, 1),
      ...spec.curve,
    ]);
  const bp = spec.vertex.basePoint ?? [0, 0];
  vp.push(vertexParam(b, v2 ? actionH : bodyH, 'basePoint', bp[0], bp[1], 0, v2));
  const params = [vp[0]!, vp[1]!, ...(edge ? [edge] : []), vp[2]!];
  dependency(b, actionH, arr.recordHandle, false, true, 1, depH[0]!);
  dependency(b, actionH, src.recordHandle, true, false, 2, depH[1]!);
  dependency(b, actionH, ins.handle, true, true, 3, depH[2]!);
  const actionRaw: RawTag[] = [T(100, 'AcDbAssocAction'), T(90, spec.version), T(90, 0), T(330, '0'), T(360, bodyH), T(90, 1), T(90, 3), T(90, 3), ...depH.map((h) => T(360, h))];
  const paramsBlock: RawTag[] = [T(90, params.length), ...params.map((p) => T(360, p.handle))];
  if (v2) actionRaw.push(T(90, 0), ...paramsBlock, ...valueParams(spec.values));
  addObject(b, 'ACDBASSOCACTION', '0', actionRaw, actionH);
  const cls = { rect: 'AcDbAssocArrayRectangularParameters', polar: 'AcDbAssocArrayPolarParameters', path: 'AcDbAssocArrayPathParameters' }[spec.kind];
  const bodyRaw: RawTag[] = [T(100, 'AcDbAssocActionBody'), T(90, spec.version)];
  if (!v2) bodyRaw.push(T(100, 'AcDbAssocParamBasedActionBody'), T(90, 0), T(90, 0), ...paramsBlock, ...valueParams(spec.values));
  bodyRaw.push(T(100, 'AcDbAssocArrayActionBody'), T(90, 1), T(1, cls), T(90, 0), T(90, spec.items.length), T(1, 'AcDbAssocArrayItem'));
  spec.items.forEach((it, k) => {
    const plain = Math.abs(it.m[0] - 1) < 1e-12 && Math.abs(it.m[1]) < 1e-12;
    bodyRaw.push(T(100, 'AcDbAssocArrayItem'), T(90, 0), T(90, it.i), T(90, it.j), T(90, 0));
    if (plain) bodyRaw.push(T(90, 8), T(11, it.m[4]), T(21, it.m[5]), T(31, 0));
    else bodyRaw.push(T(90, 12), ...mat(it.m));
    bodyRaw.push(T(330, items[k]!.handle));
  });
  const c = Math.cos(rot ?? 0);
  const s = Math.sin(rot ?? 0);
  bodyRaw.push(...mat([c * (sx ?? 1), s * (sx ?? 1), -s, c, x, y]));
  addObject(b, 'ACDBASSOCARRAYACTIONBODY', actionH, bodyRaw, bodyH);
  return { ins: b.doc.entityIndex.get(ins.handle) as InsertEntity, action: actionH, body: bodyH, source: src.name, array: arr.name };
}

/** 직사각형 4열 × 2행(열 간격 10, 행 간격 5), 판 1 */
export function rectFixture(b: Bench, at: [number, number] = [100, 50]): AcadArray {
  const items: AcadItem[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) items.push({ i, j, m: [1, 0, 0, 1, i * 10, j * 5] });
  return addAcadArray(b, {
    kind: 'rect',
    version: 1,
    values: [
      ['AlignItems', 0, 0, 90],
      ['AxesAngle', 2, Math.PI / 2, 40],
      ['ItemSpacing', 1, 10, 40],
      ['Items', 0, 4, 90],
      ['LevelSpacing', 1, 1, 40],
      ['Levels', 0, 1, 90],
      ['RowElevation', 1, 0, 40],
      ['RowSpacing', 1, 5, 40],
      ['Rows', 0, 2, 90],
    ],
    vertex: { Origin: [0, 0] },
    source: [lineE(-1, -1, 1, 1), circleE(0, 0, 1)],
    items,
    at: [at[0], at[1]],
  });
}

/** 원형 6개(한 바퀴, 항목 회전), 중심 (20, 30), 반지름 8, 시작 각도 90°, 판 1 */
export function polarFixture(b: Bench): AcadArray {
  const c = { x: 20, y: 30 };
  const items: AcadItem[] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    const r = (i * Math.PI) / 3;
    items.push({ i, j: 0, m: [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), c.x + 8 * Math.cos(a), c.y + 8 * Math.sin(a)] });
  }
  return addAcadArray(b, {
    kind: 'polar',
    version: 1,
    values: [
      ['FillAngle', 2, 2 * Math.PI, 40],
      ['ItemSpacing', 2, Math.PI / 3, 40],
      ['Items', 0, 6, 90],
      ['LevelSpacing', 1, 1, 40],
      ['Levels', 0, 1, 90],
      ['RowElevation', 1, 0, 40],
      ['RowSpacing', 1, 4, 40],
      ['Rows', 0, 1, 90],
      ['Radius', 1, 8, 40],
      ['StartAngle', 2, Math.PI / 2, 40],
    ],
    vertex: { Origin: [c.x, c.y] },
    source: [lineE(-0.5, 0, 0.5, 0)],
    items,
  });
}

/** 경로 캐시: 선분 (0,0)→(10,0), 반원 호(중심 (10,5) 반지름 5, −90°→90°), 선분 (10,10)→(0,10). 판 2, 등분할 5개, 정렬 */
export function pathFixture(b: Bench, at: [number, number, number?, number?] = [0, 0]): AcadArray {
  const curve: RawTag[] = [
    T(90, 47),
    T(90, 3),
    T(90, 23),
    T(10, 0),
    T(20, 0),
    T(30, 0),
    T(10, 10),
    T(20, 0),
    T(30, 0),
    T(90, 11),
    T(10, 10),
    T(20, 5),
    T(30, 0),
    T(10, 0),
    T(20, 0),
    T(30, 1),
    T(10, 1),
    T(20, 0),
    T(30, 0),
    T(40, 5),
    T(40, -Math.PI / 2),
    T(40, Math.PI / 2),
    T(40, 0),
    T(90, 23),
    T(10, 10),
    T(20, 10),
    T(30, 0),
    T(10, -10),
    T(20, 0),
    T(30, 0),
  ];
  // 경로 길이 = 10 + 5π + 10, 5개 등분할
  const L = 20 + 5 * Math.PI;
  const step = L / 4;
  const at3 = (d: number): { x: number; y: number; a: number } => {
    if (d <= 10) return { x: d, y: 0, a: 0 };
    if (d <= 10 + 5 * Math.PI) {
      const t = -Math.PI / 2 + (d - 10) / 5;
      return { x: 10 + 5 * Math.cos(t), y: 5 + 5 * Math.sin(t), a: t + Math.PI / 2 };
    }
    return { x: 10 - (d - 10 - 5 * Math.PI), y: 10, a: Math.PI };
  };
  const items: AcadItem[] = [];
  for (let i = 0; i < 5; i++) {
    const q = at3(Math.min(L, i * step));
    items.push({ i, j: 0, m: [Math.cos(q.a), Math.sin(q.a), -Math.sin(q.a), Math.cos(q.a), q.x, q.y] });
  }
  return addAcadArray(b, {
    kind: 'path',
    version: 2,
    values: [
      ['ItemSpacing', 1, step, 40],
      ['Items', 0, 5, 90],
      ['LevelSpacing', 1, 1, 40],
      ['Levels', 0, 1, 90],
      ['RowElevation', 1, 0, 40],
      ['RowSpacing', 1, 2, 40],
      ['Rows', 0, 1, 90],
      ['AlignItems', 0, 1, 90],
      ['FillPath', 0, 1, 40],
      ['MaintainZ', 0, 1, 40],
      ['Orientation', 0, 1, 90],
      ['PathDirection', 0, 1, 90],
      ['Method', 0, 0, 90],
      ['TangentOrientationAngle', 0, 0, 40],
    ],
    vertex: { Origin: [0, 0] },
    source: [circleE(0, 0, 0.5), lineE(0, 0, 1, 0)],
    items,
    curve,
    at,
  });
}

/** DWG에서 읽은 것처럼 연관 객체의 원본 태그를 지운다(종류·소유자·반응자만 남는다) */
export function stripRaw(doc: CadDocument): void {
  for (const [k, o] of doc.objects) if (/^ACDBASSOC/.test(o.type)) doc.objects.set(k, { ...(o as GenericObject), raw: undefined });
}
