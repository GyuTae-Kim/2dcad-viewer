/**
 * XCLIP 자르기 경계 만들기·바꾸기·지우기(UI 없음).
 * AutoCAD와 같은 구조: 블록 참조의 확장 사전 → ACAD_FILTER 사전 → SPATIAL 항목의 SPATIAL_FILTER.
 * 경계는 자를 때의 WCS 점(원점 0, 법선 Z, 클립 변환 = 단위)이고, 블록 참조 변환의 역행렬로 블록 좌표에 묶는다.
 */
import type { CadDocument, DictionaryObject, InsertEntity, SpatialFilterObject, Vec2 } from '../core/model';
import { tableKey } from '../core/model';
import type { EditOp } from './session';

const I12 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function isDict(o: unknown): o is DictionaryObject {
  const t = (o as { type?: string } | undefined)?.type;
  return t === 'DICTIONARY' || t === 'ACDBDICTIONARYWDFLT';
}

function entry(d: DictionaryObject | null, k: string): string | undefined {
  if (!d) return undefined;
  for (const [n, h] of d.entries) if (n.toUpperCase() === k) return h;
  return undefined;
}

/** 블록 참조 → (확장 사전, ACAD_FILTER 사전, SPATIAL_FILTER) */
export function xclipParts(doc: CadDocument, e: InsertEntity): { xdict: DictionaryObject | null; filters: DictionaryObject | null; filter: SpatialFilterObject | null } {
  const xo = e.xdict ? doc.objects.get(e.xdict) : undefined;
  const xdict = isDict(xo) ? xo : null;
  const fh = entry(xdict, 'ACAD_FILTER');
  const fo = fh ? doc.objects.get(fh) : undefined;
  const filters = isDict(fo) ? fo : null;
  const sh = entry(filters, 'SPATIAL');
  const so = sh ? doc.objects.get(sh) : undefined;
  return { xdict, filters, filter: so?.type === 'SPATIAL_FILTER' ? (so as SpatialFilterObject) : null };
}

/** 블록 좌표 → WCS 변환의 역행렬(4×3, 행 우선). 법선이 Z가 아니면 평면 안의 근사 */
export function inverseInsertTransform(doc: CadDocument, e: InsertEntity): number[] {
  const bp = doc.blocks.get(tableKey(e.block))?.basePoint ?? { x: 0, y: 0, z: 0 };
  const sx = e.scale.x || 1;
  const sy = e.scale.y || 1;
  const sz = e.scale.z || 1;
  const c = Math.cos(-e.rotation);
  const s = Math.sin(-e.rotation);
  // p_block = S⁻¹ · R(−rot) · (p − ins) + bp
  const tx = -e.insert.x;
  const ty = -e.insert.y;
  const tz = -e.insert.z;
  return [c / sx, -s / sx, 0, (c * tx - s * ty) / sx + bp.x, s / sy, c / sy, 0, (s * tx + c * ty) / sy + bp.y, 0, 0, 1 / sz, tz / sz + bp.z];
}

/** 자르기 경계를 새로 둔다(있으면 바꾼다). boundary는 WCS 점(직사각형은 두 구석도 됨) */
export function setXclipOps(doc: CadDocument, e: InsertEntity, block: string, boundary: Vec2[], newHandle: () => string): EditOp[] {
  const ops: EditOp[] = [];
  const parts = xclipParts(doc, e);
  let xdict = parts.xdict;
  let ins = e;
  if (!xdict) {
    xdict = { type: 'DICTIONARY', handle: newHandle(), owner: e.handle, entries: new Map(), hardOwner: false, cloning: 1 };
    ins = { ...e, xdict: xdict.handle };
    ops.push({ kind: 'modify', block, before: e, after: ins });
  }
  let filters = parts.filters;
  if (!filters) {
    filters = { type: 'DICTIONARY', handle: newHandle(), owner: xdict.handle, reactors: [xdict.handle], entries: new Map(), hardOwner: false, cloning: 1 };
    const entries = new Map(xdict.entries);
    entries.set('ACAD_FILTER', filters.handle);
    ops.push({ kind: 'object', key: xdict.handle, before: parts.xdict, after: { ...xdict, entries } });
    ops.push({ kind: 'object', key: filters.handle, before: null, after: filters });
  }
  const sf: SpatialFilterObject = {
    type: 'SPATIAL_FILTER',
    handle: parts.filter?.handle ?? newHandle(),
    owner: filters.handle,
    reactors: [filters.handle],
    boundary: boundary.map((p) => ({ x: p.x, y: p.y })),
    normal: { x: 0, y: 0, z: 1 },
    origin: { x: 0, y: 0, z: 0 },
    displayBoundary: true,
    inverseBlockTransform: inverseInsertTransform(doc, ins),
    clipTransform: [...I12],
  };
  if (!parts.filter) {
    const entries = new Map(filters.entries);
    entries.set('SPATIAL', sf.handle);
    ops.push({ kind: 'object', key: filters.handle, before: parts.filters ? filters : null, after: { ...filters, entries } });
  }
  ops.push({ kind: 'object', key: sf.handle, before: parts.filter, after: sf });
  // 같은 키의 object 작업은 마지막 것만 남게 합친다(새로 만든 사전에 항목을 더할 때)
  const merged = new Map<string, EditOp>();
  const out: EditOp[] = [];
  for (const op of ops) {
    if (op.kind === 'object') {
      const prev = merged.get(op.key);
      if (prev && prev.kind === 'object') {
        merged.set(op.key, { ...op, before: prev.before });
        continue;
      }
      merged.set(op.key, op);
    } else out.push(op);
  }
  return [...out, ...merged.values()];
}

/** 자르기 켜기·끄기(SPATIAL_FILTER 71) */
export function enableXclipOps(doc: CadDocument, e: InsertEntity, on: boolean): EditOp[] {
  const f = xclipParts(doc, e).filter;
  if (!f || f.displayBoundary === on) return [];
  const after = { ...f, displayBoundary: on };
  delete after.dwgRaw;
  return [{ kind: 'object', key: f.handle, before: f, after }];
}

/** 자르기 경계 지우기(SPATIAL 항목과 필터 객체) */
export function removeXclipOps(doc: CadDocument, e: InsertEntity): EditOp[] {
  const { filters, filter } = xclipParts(doc, e);
  if (!filters || !filter) return [];
  const entries = new Map([...filters.entries].filter(([k]) => k.toUpperCase() !== 'SPATIAL'));
  return [
    { kind: 'object', key: filters.handle, before: filters, after: { ...filters, entries } },
    { kind: 'object', key: filter.handle, before: filter, after: null },
  ];
}

/** 지금의 자르기 경계(WCS). 블록 참조가 옮겨졌으면 따라간 자리 */
export function xclipBoundaryWorld(doc: CadDocument, e: InsertEntity): Vec2[] | null {
  const f = xclipParts(doc, e).filter;
  if (!f) return null;
  let pts = f.boundary;
  if (pts.length === 2) {
    const [a, b] = pts as [Vec2, Vec2];
    pts = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }
  const ap = (M: number[], x: number, y: number) => (M.length >= 12 ? { x: M[0]! * x + M[1]! * y + M[3]!, y: M[4]! * x + M[5]! * y + M[7]! } : { x, y });
  // 경계 → (클립 변환) → 블록 좌표 → 지금 블록 참조 변환
  const bp = doc.blocks.get(tableKey(e.block))?.basePoint ?? { x: 0, y: 0, z: 0 };
  const c = Math.cos(e.rotation);
  const s = Math.sin(e.rotation);
  return pts.map((p) => {
    const w = ap(f.clipTransform, p.x + f.origin.x, p.y + f.origin.y);
    const b = ap(f.inverseBlockTransform, w.x, w.y);
    const x = (b.x - bp.x) * (e.scale.x || 1);
    const y = (b.y - bp.y) * (e.scale.y || 1);
    return { x: e.insert.x + c * x - s * y, y: e.insert.y + s * x + c * y };
  });
}
