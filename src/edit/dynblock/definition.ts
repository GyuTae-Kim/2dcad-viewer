/**
 * 동적 블록 정의 해석기: 블록 레코드의 확장 사전 → ACAD_ENHANCEDBLOCK(평가 그래프) → 노드(매개변수·그립·그립 위치 식·동작).
 *
 * 태그 배치는 AutoCAD가 쓰는 DXF 레코드(서브클래스 표지 뒤)를 따른다. 해석하지 못한 노드는 undecoded에 이름을 남기고,
 * 그 정의는 편집하지 않는다(파일에는 원본 태그 그대로 남는다).
 */
import type { BlockDef, BlockRecord, CadDocument, DictionaryObject, GenericObject, RawTag, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { TagCursor, subclasses, tagHandle, tagInt, tagNum, tagStr, xdataOf } from './tags';
import type {
  BaseAction,
  Conn,
  DynAction,
  DynDefinition,
  DynGripNode,
  DynParam,
  FlipAction,
  LookupAction,
  LookupColumn,
  MoveAction,
  OtherAction,
  ParamKind,
  ValueSet,
} from './types';

const PARAM_KIND: Record<string, ParamKind> = {
  BLOCKVISIBILITYPARAMETER: 'visibility',
  BLOCKFLIPPARAMETER: 'flip',
  BLOCKLINEARPARAMETER: 'linear',
  BLOCKPOLARPARAMETER: 'polar',
  BLOCKROTATIONPARAMETER: 'rotation',
  BLOCKXYPARAMETER: 'xy',
  BLOCKPOINTPARAMETER: 'point',
  BLOCKLOOKUPPARAMETER: 'lookup',
  BLOCKALIGNMENTPARAMETER: 'alignment',
  BLOCKBASEPOINTPARAMETER: 'basepoint',
  // 구속 기반 정의의 선형 구속 매개변수(공개 DXF architectural_example-imperial): 값만 읽는다(아래 CONSTRAINT_PARAMS)
  BLOCKHORIZONTALCONSTRAINTPARAMETER: 'linear',
  BLOCKVERTICALCONSTRAINTPARAMETER: 'linear',
  BLOCKALIGNEDCONSTRAINTPARAMETER: 'linear',
  BLOCKLINEARCONSTRAINTPARAMETER: 'linear',
};

/**
 * 구속 매개변수: 값은 블록 객체의 기하 구속(연관 망)을 풀어야 바뀐다. 거리·값 집합만 읽고(특성에 읽기 전용으로 보인다)
 * 정의는 고치지 않는다(undecoded에 "구속 매개변수 …"를 남긴다). DWG 배치는 표본이 없어 모른다(원본 비트만 남는다).
 */
const CONSTRAINT_PARAMS = new Set(['BLOCKHORIZONTALCONSTRAINTPARAMETER', 'BLOCKVERTICALCONSTRAINTPARAMETER', 'BLOCKALIGNEDCONSTRAINTPARAMETER', 'BLOCKLINEARCONSTRAINTPARAMETER']);

const ACTION_TYPES = new Set(['BLOCKMOVEACTION', 'BLOCKSTRETCHACTION', 'BLOCKPOLARSTRETCHACTION', 'BLOCKSCALEACTION', 'BLOCKROTATEACTION', 'BLOCKFLIPACTION', 'BLOCKARRAYACTION', 'BLOCKLOOKUPACTION']);

export const ETAG_APP = 'AcDbBlockRepETag';
export const BTAG_APP = 'AcDbBlockRepBTag';
export const TRUENAME_APP = 'AcDbDynamicBlockTrueName';
export const GUID_APP = 'AcDbDynamicBlockGUID';

// ---------------------------------------------------------------------------
// 사전·레코드 찾기
// ---------------------------------------------------------------------------

export function dictEntry(doc: CadDocument, dictHandle: string | undefined, name: string): string | null {
  if (!dictHandle) return null;
  const d = doc.objects.get(dictHandle.toUpperCase());
  if (!d || (d.type !== 'DICTIONARY' && d.type !== 'ACDBDICTIONARYWDFLT')) return null;
  const want = name.toUpperCase();
  for (const [k, h] of (d as DictionaryObject).entries) if (k.toUpperCase() === want) return h.toUpperCase();
  return null;
}

/** 블록 레코드 핸들 → 블록 키 */
export function blockKeyOfRecord(doc: CadDocument, recordHandle: string): string | null {
  const h = recordHandle.toUpperCase();
  for (const [k, r] of doc.blockRecords) if (r.handle.toUpperCase() === h) return k;
  for (const [k, b] of doc.blocks) if (b.recordHandle.toUpperCase() === h) return k;
  return null;
}

/** 블록이 동적 블록 정의면 평가 그래프 핸들 */
export function graphHandleOf(doc: CadDocument, key: string): string | null {
  const rec = doc.blockRecords.get(key);
  if (!rec?.xdict) return null;
  const g = dictEntry(doc, rec.xdict, 'ACAD_ENHANCEDBLOCK');
  if (!g) return null;
  return doc.objects.get(g)?.type === 'ACAD_EVALUATION_GRAPH' ? g : null;
}

export function isDynamicDefinition(doc: CadDocument, key: string): boolean {
  return graphHandleOf(doc, tableKey(key)) !== null;
}

// ---------------------------------------------------------------------------
// ETag 색인
// ---------------------------------------------------------------------------

/** 객체의 ETag 색인(없으면 null) */
export function etagIndex(e: { xdata?: BlockDef['entities'][number]['xdata'] }): number | null {
  const items = xdataOf(e.xdata, ETAG_APP);
  if (!items) return null;
  const it = items.find((i) => i.code === 1071);
  return it ? tagInt(it.value as number | string, -1) : null;
}

/** 블록 객체 → ETag 색인(없으면 위치) */
export function blockIndices(b: BlockDef): number[] {
  const out: number[] = [];
  const used = new Set<number>();
  b.entities.forEach((e, i) => {
    let k = etagIndex(e);
    if (k === null || k < 0 || used.has(k)) k = i;
    while (used.has(k)) k++;
    used.add(k);
    out.push(k);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 노드 해석
// ---------------------------------------------------------------------------

function first(tags: readonly RawTag[] | undefined, code: number): string | number | undefined {
  return tags?.find((t) => t.code === code)?.value;
}

function firstPoint(tags: readonly RawTag[] | undefined, code: number): Vec3 | null {
  if (!tags) return null;
  const i = tags.findIndex((t) => t.code === code);
  if (i < 0) return null;
  const y = tags[i + 1]?.code === code + 10 ? tagNum(tags[i + 1]!.value) : 0;
  const z = tags[i + 2]?.code === code + 20 ? tagNum(tags[i + 2]!.value) : 0;
  return { x: tagNum(tags[i]!.value), y, z };
}

function valueSet(tags: readonly RawTag[] | undefined, typeCode: number, minCode: number, maxCode: number, incCode: number, listCode: number): ValueSet {
  return {
    type: tagInt(first(tags, typeCode)),
    min: tagNum(first(tags, minCode)),
    max: tagNum(first(tags, maxCode)),
    increment: tagNum(first(tags, incCode)),
    list: (tags ?? []).filter((t) => t.code === listCode).map((t) => tagNum(t.value)),
  };
}

function conn(node: string | number | undefined, prop: string | number | undefined): Conn {
  return { node: tagInt(node, 0), prop: tagStr(prop).trim() };
}

class Undecoded extends Error {}

function need(sc: Map<string, RawTag[]>, name: string): RawTag[] {
  const t = sc.get(name);
  if (!t) throw new Undecoded(name);
  return t;
}

function exprId(sc: Map<string, RawTag[]>): number {
  return tagInt(first(need(sc, 'AcDbEvalExpr'), 90), -1);
}

function readParam(type: string, handle: string, sc: Map<string, RawTag[]>): DynParam {
  const kind = PARAM_KIND[type]!;
  const id = exprId(sc);
  const name = tagStr(first(sc.get('AcDbBlockElement'), 300)).trim();
  const pb = need(sc, 'AcDbBlockParameter');
  const base = {
    id,
    handle,
    type,
    name,
    label: name,
    description: '',
    show: tagInt(first(pb, 280), 1) !== 0,
    chain: tagInt(first(pb, 281), 0) !== 0,
    grips: [] as number[],
  };
  const one = sc.get('AcDbBlock1PtParameter');
  const two = sc.get('AcDbBlock2PtParameter');
  let p1: Vec3 = { x: 0, y: 0, z: 0 };
  let p2: Vec3 = { x: 0, y: 0, z: 0 };
  let baseLocation = 0;
  if (one) {
    p1 = firstPoint(one, 1010) ?? p1;
    const g = tagInt(first(one, 93), 0);
    if (g > 0) base.grips.push(g);
  } else if (two) {
    p1 = firstPoint(two, 1010) ?? p1;
    p2 = firstPoint(two, 1011) ?? p2;
    const c = new TagCursor(two);
    if (c.seek(170)) {
      const n = c.int(170);
      for (let k = 0; k < n && c.has(91); k++) {
        const g = c.int(91);
        if (g > 0) base.grips.push(g);
      }
    }
    baseLocation = tagInt(first(two, 177), 0);
  } else throw new Undecoded(type);
  const label = (s: string) => {
    base.label = s.trim() || name;
  };
  switch (kind) {
    case 'visibility': {
      const t = need(sc, 'AcDbBlockVisibilityParameter');
      const c = new TagCursor(t);
      c.int(281);
      label(c.str(301));
      base.description = c.str(302);
      c.int(91);
      const entities: string[] = [];
      const n = c.int(93);
      for (let k = 0; k < n && c.has(331); k++) entities.push(c.handle(331));
      const states: { name: string; entities: string[]; nodes: string[] }[] = [];
      const m = c.int(92);
      for (let k = 0; k < m && c.has(303); k++) {
        const s = { name: c.str(303), entities: [] as string[], nodes: [] as string[] };
        const a = c.int(94);
        for (let j = 0; j < a && c.has(332); j++) s.entities.push(c.handle(332));
        const b = c.int(95);
        for (let j = 0; j < b && c.has(333); j++) s.nodes.push(c.handle(333));
        states.push(s);
      }
      return { ...base, kind, location: p1, entities, states };
    }
    case 'flip': {
      const t = need(sc, 'AcDbBlockFlipParameter');
      label(tagStr(first(t, 305)));
      base.description = tagStr(first(t, 306));
      return { ...base, kind, base: p1, end: p2, baseState: tagStr(first(t, 307)), flippedState: tagStr(first(t, 308)) };
    }
    case 'linear': {
      const t = need(sc, CONSTRAINT_PARAMS.has(type) ? 'AcDbBlockLinearConstraintParameter' : 'AcDbBlockLinearParameter');
      label(tagStr(first(t, 305)));
      base.description = tagStr(first(t, 306));
      return { ...base, kind, base: p1, end: p2, baseLocation, values: valueSet(t, 96, 141, 142, 143, 144) };
    }
    case 'polar': {
      // 305 거리 레이블, 306 거리 설명, 307 각도 레이블, 308 각도 설명(공개 짝 도면·AutoCAD 예제 도면)
      const t = need(sc, 'AcDbBlockPolarParameter');
      label(tagStr(first(t, 305)));
      base.description = tagStr(first(t, 306));
      const al = tagStr(first(t, 307)).trim();
      return {
        ...base,
        kind,
        base: p1,
        end: p2,
        baseLocation,
        angleLabel: al || `${name} 각도`,
        angleDescription: tagStr(first(t, 308)),
        values: valueSet(t, 96, 141, 142, 143, 144),
        angleValues: valueSet(t, 97, 145, 146, 147, 148),
      };
    }
    case 'rotation': {
      const t = need(sc, 'AcDbBlockRotationParameter');
      label(tagStr(first(t, 305)));
      base.description = tagStr(first(t, 306));
      return { ...base, kind, base: p1, end: p2, baseAngle: firstPoint(t, 1011) ?? p2, baseLocation, values: valueSet(t, 96, 141, 142, 143, 144) };
    }
    case 'xy': {
      // AutoCAD는 Y를 먼저 쓴다: 305 Y 레이블, 306 X 레이블, 307 Y 설명, 308 X 설명
      // (AutoCAD 예제 도면의 "높이"·"폭", 공개 짝 도면의 "Y Distance1"·"X Distance1")
      const t = need(sc, 'AcDbBlockXYParameter');
      const ly = tagStr(first(t, 305)).trim();
      const lx = tagStr(first(t, 306)).trim();
      label(lx || name);
      base.description = tagStr(first(t, 308));
      return {
        ...base,
        kind,
        base: p1,
        end: p2,
        labelX: lx || `${name} X`,
        labelY: ly || `${name} Y`,
        descriptionX: tagStr(first(t, 308)),
        descriptionY: tagStr(first(t, 307)),
        valuesX: valueSet(t, 96, 142, 143, 144, 145),
        valuesY: valueSet(t, 97, 146, 147, 148, 149),
      };
    }
    case 'lookup': {
      const t = need(sc, 'AcDbBlockLookUpParameter');
      label(tagStr(first(t, 303)));
      base.description = tagStr(first(t, 304));
      return { ...base, kind, location: p1, action: tagInt(first(t, 94), 0) };
    }
    case 'point': {
      const t = sc.get('AcDbBlockPointParameter');
      label(tagStr(first(t, 303)));
      base.description = tagStr(first(t, 304));
      return { ...base, kind, location: p1 };
    }
    case 'basepoint':
      return { ...base, kind, location: p1 };
    case 'alignment':
      return { ...base, kind, location: p1, end: p2 };
  }
}

function readAction(type: string, handle: string, sc: Map<string, RawTag[]>): DynAction {
  const id = exprId(sc);
  const name = tagStr(first(sc.get('AcDbBlockElement'), 300)).trim();
  const ab = need(sc, 'AcDbBlockAction');
  const c = new TagCursor(ab);
  const nodes: number[] = [];
  const n70 = c.int(70);
  for (let k = 0; k < n70 && c.has(91); k++) nodes.push(c.int(91));
  const entities: string[] = [];
  const n71 = c.int(71);
  for (let k = 0; k < n71 && c.has(330); k++) {
    const h = c.handle(330);
    if (h) entities.push(h);
  }
  const base = { id, handle, type, name, nodes, entities };
  switch (type) {
    case 'BLOCKMOVEACTION':
    case 'BLOCKSTRETCHACTION': {
      const stretch = type === 'BLOCKSTRETCHACTION';
      const t = need(sc, stretch ? 'AcDbBlockStretchAction' : 'AcDbBlockMoveAction');
      const a: MoveAction = {
        ...base,
        kind: stretch ? 'stretch' : 'move',
        x: conn(first(t, 92), first(t, 301)),
        y: conn(first(t, 93), first(t, 302)),
        multiplier: 1,
        angle: 0,
        xyType: 0,
        frame: [],
        bindings: [],
        nodePoints: [],
      };
      const m = new TagCursor(t);
      if (stretch) {
        if (m.seek(72)) {
          const nf = m.int(72);
          for (let k = 0; k < nf && m.has(1011); k++) {
            const p = m.point(1011);
            a.frame.push({ x: p.x, y: p.y });
          }
        }
        if (m.seek(73)) {
          const ne = m.int(73);
          for (let k = 0; k < ne && m.has(331); k++) {
            const h = m.handle(331);
            const np = m.int(74);
            const pts: number[] = [];
            for (let j = 0; j < np && m.has(94); j++) pts.push(m.int(94));
            a.bindings.push({ handle: h, points: pts });
          }
        }
        if (m.seek(75)) {
          const nn = m.int(75);
          for (let k = 0; k < nn && m.has(95); k++) {
            const node = m.int(95);
            const np = m.int(76);
            const pts: number[] = [];
            for (let j = 0; j < np && m.has(94); j++) pts.push(m.int(94));
            a.nodePoints.push({ node, points: pts });
          }
        }
      }
      if (m.seek(140)) a.multiplier = m.num(140, 1);
      if (m.seek(141)) a.angle = m.num(141, 0);
      if (m.seek(280)) a.xyType = m.int(280, 0);
      return a;
    }
    case 'BLOCKSCALEACTION':
    case 'BLOCKROTATEACTION': {
      const w = need(sc, 'AcDbBlockActionWithBasePt');
      const a: BaseAction = {
        ...base,
        kind: type === 'BLOCKSCALEACTION' ? 'scale' : 'rotate',
        baseX: conn(first(w, 92), first(w, 301)),
        baseY: conn(first(w, 93), first(w, 302)),
        offset: firstPoint(w, 1011) ?? { x: 0, y: 0, z: 0 },
        dependent: tagInt(first(w, 280), 0) !== 0,
        basePoint: firstPoint(w, 1012) ?? { x: 0, y: 0, z: 0 },
      };
      if (a.kind === 'scale') {
        const t = need(sc, 'AcDbBlockScaleAction');
        a.scale = conn(first(t, 94), first(t, 303));
        a.scaleX = conn(first(t, 95), first(t, 304));
        a.scaleY = conn(first(t, 96), first(t, 305));
      } else {
        const t = need(sc, 'AcDbBlockRotationAction');
        a.angleConn = conn(first(t, 94), first(t, 303));
      }
      return a;
    }
    case 'BLOCKFLIPACTION': {
      const t = need(sc, 'AcDbBlockFlipAction');
      const a: FlipAction = { ...base, kind: 'flip', conns: [conn(first(t, 92), first(t, 301)), conn(first(t, 93), first(t, 302)), conn(first(t, 94), first(t, 303)), conn(first(t, 95), first(t, 304))] };
      return a;
    }
    case 'BLOCKLOOKUPACTION':
      return readLookup(base, need(sc, 'AcDbBlockLookupAction'));
    default: {
      const array = type === 'BLOCKARRAYACTION';
      const a: OtherAction = { ...base, kind: array ? 'array' : 'polar_stretch', conns: [] };
      const t = sc.get(array ? 'AcDbBlockArrayAction' : 'AcDbBlockPolarStretchAction') ?? [];
      // 배열: 92~95 + 301~304, 극좌표 신축: 92~97 + 301~306
      for (let k = 0; k < (array ? 4 : 6); k++) if (first(t, 92 + k) !== undefined) a.conns.push(conn(first(t, 92 + k), first(t, 301 + k)));
      if (array) {
        a.columnSpacing = tagNum(first(t, 140));
        a.rowSpacing = tagNum(first(t, 141));
        return a;
      }
      // 극좌표 신축: 73 + 틀 점(1011·1021)…, 72 점이 묶인 객체 수, 74 + 332…, 75 + (76, 78)…, 141, 140, 77
      const m = new TagCursor(t);
      a.frame = [];
      a.stretchEntities = [];
      if (m.seek(73)) {
        const nf = m.int(73);
        for (let k = 0; k < nf && m.has(1011); k++) {
          const p = m.point(1011);
          a.frame.push({ x: p.x, y: p.y });
        }
      }
      a.boundCount = m.seek(72) ? m.int(72) : 0;
      if (m.seek(74)) {
        const n = m.int(74);
        for (let k = 0; k < n && m.has(332); k++) a.stretchEntities.push(m.handle(332));
      }
      return a;
    }
  }
}

function readLookup(base: Omit<LookupAction, 'kind' | 'columns' | 'rows'>, t: RawTag[]): LookupAction {
  const c = new TagCursor(t);
  let rows = c.int(92);
  const cols = c.int(93);
  const cells: string[] = [];
  const columns: LookupColumn[] = [];
  // 칸: 첫 303(열 기록) 앞의 302
  while (!c.done && !c.has(303)) {
    if (c.has(302)) cells.push(c.str(302));
    else c.skip();
  }
  while (c.has(303)) {
    c.str(303);
    const col: LookupColumn = { node: 0, prop: '', valueType: 1, lookup: false, unmatched: '', reverse: true };
    // 열 기록의 태그는 다음 303이나 280까지
    while (!c.done && !c.has(303) && !c.has(280)) {
      const code = c.peek()!;
      if (code === 94) col.node = c.int(94);
      else if (code === 95) col.valueType = c.int(95);
      else if (code === 282) col.lookup = c.int(282) !== 0;
      else if (code === 305) col.unmatched = c.str(305);
      else if (code === 281) col.reverse = c.int(281) !== 0;
      else if (code === 304) col.prop = c.str(304).trim();
      else c.skip();
    }
    columns.push(col);
  }
  const ncol = columns.length || cols;
  if (ncol > 0 && cells.length !== rows * ncol && cells.length % ncol === 0) rows = cells.length / ncol;
  const table: string[][] = [];
  if (ncol > 0 && rows > 0 && cells.length >= rows * ncol) {
    // 행 우선이 기본. 실수 열이 수가 아니면 열 우선으로 읽어 본다.
    const rowMajor = (r: number, k: number) => cells[r * ncol + k]!;
    const colMajor = (r: number, k: number) => cells[k * rows + r]!;
    const fits = (at: (r: number, k: number) => string) => {
      for (let k = 0; k < columns.length; k++) {
        if (columns[k]!.valueType !== 40) continue;
        for (let r = 0; r < rows; r++) {
          const s = at(r, k).trim();
          if (s && !Number.isFinite(Number(s))) return false;
        }
      }
      return true;
    };
    const at = fits(rowMajor) || !fits(colMajor) ? rowMajor : colMajor;
    for (let r = 0; r < rows; r++) {
      const row: string[] = [];
      for (let k = 0; k < ncol; k++) row.push(at(r, k));
      table.push(row);
    }
  }
  return { ...base, kind: 'lookup', columns, rows: table };
}

function readGrip(type: string, handle: string, sc: Map<string, RawTag[]>, exprs: Map<number, Conn>): DynGripNode {
  const id = exprId(sc);
  const g = need(sc, 'AcDbBlockGrip');
  const xid = tagInt(first(g, 91), -1);
  const yid = tagInt(first(g, 92), -1);
  const node: DynGripNode = {
    id,
    handle,
    type,
    location: firstPoint(g, 1010) ?? { x: 0, y: 0, z: 0 },
    x: exprs.get(xid) ?? null,
    y: exprs.get(yid) ?? null,
  };
  for (const [k, t] of sc) {
    if (k === 'AcDbBlockGrip' || !/Grip$/.test(k)) continue;
    if (first(t, 140) !== undefined) node.orientation = { x: tagNum(first(t, 140)), y: tagNum(first(t, 141)), z: tagNum(first(t, 142)) };
  }
  return node;
}

// ---------------------------------------------------------------------------
// 그래프
// ---------------------------------------------------------------------------

interface GraphNode {
  index: number;
  id: number;
  handle: string;
}

function readGraph(raw: readonly RawTag[] | undefined): { nodes: GraphNode[]; edges: { from: number; to: number; flags: number }[] } {
  const sc = subclasses(raw);
  const t = sc.get('AcDbEvalGraph') ?? [];
  const c = new TagCursor(t);
  c.int(96);
  c.int(97);
  const nodes: GraphNode[] = [];
  const edges: { from: number; to: number; flags: number }[] = [];
  while (c.has(91)) {
    const index = c.int(91);
    c.int(93);
    const id = c.int(95);
    const handle = c.handle(360);
    for (let k = 0; k < 4 && c.has(92); k++) c.int(92);
    nodes.push({ index, id, handle });
  }
  while (c.has(92)) {
    c.int(92);
    const flags = c.int(93);
    c.int(94);
    const from = c.int(91, -1);
    const to = c.int(91, -1);
    for (let k = 0; k < 5 && c.has(92); k++) c.int(92);
    edges.push({ from, to, flags });
  }
  return { nodes, edges };
}

/** 위상 순서(같으면 노드 색인 순). 조회 동작의 양방향 간선(플래그 4)은 뺀다 */
function topoOrder(nodes: GraphNode[], edges: { from: number; to: number; flags: number }[]): Map<number, number> {
  const byIndex = new Map(nodes.map((n) => [n.index, n]));
  const indeg = new Map<number, number>(nodes.map((n) => [n.index, 0]));
  const out = new Map<number, number[]>();
  for (const e of edges) {
    if (e.flags & 4 || !byIndex.has(e.from) || !byIndex.has(e.to) || e.from === e.to) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const ready = nodes.filter((n) => !indeg.get(n.index)).map((n) => n.index);
  const order = new Map<number, number>();
  let rank = 0;
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const i = ready.shift()!;
    order.set(byIndex.get(i)!.id, rank++);
    for (const j of out.get(i) ?? []) {
      const d = (indeg.get(j) ?? 0) - 1;
      indeg.set(j, d);
      if (d === 0) ready.push(j);
    }
  }
  // 순환이 있으면 남은 노드는 색인 순
  for (const n of [...nodes].sort((a, b) => a.index - b.index)) if (!order.has(n.id)) order.set(n.id, rank++);
  return order;
}

// ---------------------------------------------------------------------------
// 정의
// ---------------------------------------------------------------------------

const cache = new WeakMap<object, WeakMap<BlockDef, DynDefinition>>();

/** 블록 키(대문자)의 동적 블록 정의. 동적 블록이 아니면 null */
export function readDefinition(doc: CadDocument, key: string): DynDefinition | null {
  const k = tableKey(key);
  const graphH = graphHandleOf(doc, k);
  const block = doc.blocks.get(k);
  const rec = doc.blockRecords.get(k);
  if (!graphH || !block || !rec) return null;
  const graph = doc.objects.get(graphH) as GenericObject;
  let byBlock = cache.get(graph);
  const hit = byBlock?.get(block);
  if (hit && hit.recordHandle === rec.handle) return hit;
  const def = parseDefinition(doc, k, block, rec, graphH, graph);
  if (!byBlock) {
    byBlock = new WeakMap();
    cache.set(graph, byBlock);
  }
  byBlock.set(block, def);
  return def;
}

function parseDefinition(doc: CadDocument, key: string, block: BlockDef, rec: BlockRecord, graphH: string, graph: GenericObject): DynDefinition {
  const { nodes, edges } = readGraph(graph.raw);
  const params: DynParam[] = [];
  const actions: DynAction[] = [];
  const grips: DynGripNode[] = [];
  const undecoded: string[] = [];
  const nodeTypes = new Map<number, string>();
  const objs = nodes.map((n) => ({ n, o: doc.objects.get(n.handle) as GenericObject | undefined }));
  // 그립 위치 식 먼저(그립이 가리킨다)
  const exprs = new Map<number, Conn>();
  for (const { n, o } of objs) {
    if (!o) continue;
    nodeTypes.set(n.id, o.type);
    if (o.type !== 'BLOCKGRIPLOCATIONCOMPONENT') continue;
    const t = subclasses(o.raw).get('AcDbBlockGripExpr');
    if (t) exprs.set(n.id, conn(first(t, 91), first(t, 300)));
  }
  for (const { n, o } of objs) {
    if (!o) {
      undecoded.push('(없는 노드)');
      continue;
    }
    const sc = subclasses(o.raw);
    try {
      if (PARAM_KIND[o.type]) {
        params.push(readParam(o.type, n.handle, sc));
        if (CONSTRAINT_PARAMS.has(o.type)) undecoded.push(`구속 매개변수 ${o.type}`);
      }
      else if (ACTION_TYPES.has(o.type)) actions.push(readAction(o.type, n.handle, sc));
      else if (/^BLOCK.*GRIP$/.test(o.type)) grips.push(readGrip(o.type, n.handle, sc, exprs));
      else if (o.type !== 'BLOCKGRIPLOCATIONCOMPONENT') undecoded.push(o.type);
    } catch (e) {
      if (e instanceof Undecoded) undecoded.push(o.type);
      else throw e;
    }
  }
  // 노드 id가 그래프 값과 다르면(해석 실패) 그래프 값을 쓴다
  const idOf = new Map(nodes.map((n) => [n.handle, n.id]));
  for (const p of params) if (p.id < 0) p.id = idOf.get(p.handle) ?? p.id;
  for (const a of actions) if (a.id < 0) a.id = idOf.get(a.handle) ?? a.id;
  for (const g of grips) if (g.id < 0) g.id = idOf.get(g.handle) ?? g.id;
  // 매개변수의 그립: 노드에 적힌 것 + 위치 식이 그 매개변수를 가리키는 그립
  for (const p of params) {
    for (const g of grips) if ((g.x?.node === p.id || g.y?.node === p.id) && !p.grips.includes(g.id)) p.grips.push(g.id);
    p.grips = p.grips.filter((id) => grips.some((g) => g.id === id));
  }
  const indexOf = new Map<string, number>();
  const handleAt = new Map<number, string>();
  const idx = blockIndices(block);
  block.entities.forEach((e, i) => {
    indexOf.set(e.handle.toUpperCase(), idx[i]!);
    handleAt.set(idx[i]!, e.handle.toUpperCase());
  });
  const trueName = xdataOf(rec.xdata, TRUENAME_APP)?.find((i) => i.code === 1000)?.value;
  return {
    key,
    blockName: block.name,
    name: typeof trueName === 'string' && trueName.trim() ? trueName : block.name,
    recordHandle: rec.handle.toUpperCase(),
    graphHandle: graphH,
    params,
    actions,
    grips,
    order: topoOrder(nodes, edges),
    nodeTypes,
    indexOf,
    handleAt,
    undecoded,
  };
}

export function paramById(def: DynDefinition, id: number): DynParam | undefined {
  return def.params.find((p) => p.id === id);
}

/** 매개변수를 이름(레이블·요소 이름, 대소문자 무시)이나 id로 찾는다 */
export function findParam(def: DynDefinition, key: string | number): DynParam | undefined {
  if (typeof key === 'number') return paramById(def, key);
  const k = key.trim().toUpperCase();
  return def.params.find((p) => p.label.toUpperCase() === k) ?? def.params.find((p) => p.name.toUpperCase() === k) ?? (/^\d+$/.test(k) ? paramById(def, Number(k)) : undefined);
}

/** 매개변수에 연결된 동작(평가 순서대로) */
export function actionsOf(def: DynDefinition, paramId: number): DynAction[] {
  const linked = def.actions.filter((a) => {
    switch (a.kind) {
      case 'move':
      case 'stretch':
        return a.x.node === paramId || a.y.node === paramId;
      case 'scale':
        return a.scale?.node === paramId || a.scaleX?.node === paramId || a.scaleY?.node === paramId;
      case 'rotate':
        return a.angleConn?.node === paramId;
      case 'flip':
      case 'array':
      case 'polar_stretch':
        return a.conns.some((c) => c.node === paramId);
      case 'lookup':
        return false;
    }
  });
  return linked.sort((a, b) => (def.order.get(a.id) ?? 0) - (def.order.get(b.id) ?? 0) || a.id - b.id);
}

/** 정의 레코드 핸들이 가리키는 블록 키 */
export function definitionKeyOf(doc: CadDocument, recordHandle: string): string | null {
  const k = blockKeyOfRecord(doc, tagHandle(recordHandle));
  return k && graphHandleOf(doc, k) ? k : null;
}
