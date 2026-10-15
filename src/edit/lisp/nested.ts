/**
 * nentsel·nentselp의 블록 안 객체 찾기(화면·DOM 없음): 고른 블록 참조(INSERT) 안에서 점에 가장 가까운 객체를 중첩 블록까지 따라가
 * 그 객체, 바깥으로 이어지는 블록 참조들(안쪽부터), 블록 좌표 → WCS 변환 행렬을 돌려준다.
 * 속성(ATTRIB)을 고르면 속성 자체(행렬 없음). 배열 참조(MINSERT)는 첫 칸으로 본다. 형상은 경로(선·호·곡선)와의 거리, 경로가 없으면 범위 상자.
 */
import type { BlockDef, CadDocument, Entity, InsertEntity, Vec3 } from '../../core/model';
import { tableKey } from '../../core/model';
import { ocsDirToWcs } from '../geom/ocs';
import { entityPath } from '../geom/path';
import { pathNearest } from '../geom/curve';
import { boundsOf } from '../geom/query';

/** 3×4 행 우선 아핀: x' = m0·x + m1·y + m2·z + m3, y' = m4·x … , z' = m8·x … */
export type Mat34 = number[];

export function mul34(a: Mat34, b: Mat34): Mat34 {
  const o: number[] = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]!;
      if (c === 3) v += a[r * 4 + 3]!;
      o[r * 4 + c] = v;
    }
  }
  return o;
}

export function apply34(m: Mat34, p: Vec3): Vec3 {
  return { x: m[0]! * p.x + m[1]! * p.y + m[2]! * p.z + m[3]!, y: m[4]! * p.x + m[5]! * p.y + m[6]! * p.z + m[7]!, z: m[8]! * p.x + m[9]! * p.y + m[10]! * p.z + m[11]! };
}

/** 역행렬(특이하면 null) */
export function inv34(m: Mat34): Mat34 | null {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m as [number, number, number, number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-300)) return null;
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det) as number[];
  const t = [-(r[0]! * tx + r[1]! * ty + r[2]! * tz), -(r[3]! * tx + r[4]! * ty + r[5]! * tz), -(r[6]! * tx + r[7]! * ty + r[8]! * tz)];
  return [r[0]!, r[1]!, r[2]!, t[0]!, r[3]!, r[4]!, r[5]!, t[1]!, r[6]!, r[7]!, r[8]!, t[2]!];
}

/** 블록 참조: 블록 좌표 → 참조가 놓인 좌표(WCS 또는 바깥 블록 좌표) */
export function insertMatrix(def: BlockDef, ins: InsertEntity): Mat34 {
  const c = Math.cos(ins.rotation);
  const s = Math.sin(ins.rotation);
  const { x: sx, y: sy, z: sz } = ins.scale;
  const b = def.basePoint;
  // OCS: 삽입점 + 회전·축척(기준점 기준)
  const ocs: Mat34 = [c * sx, -s * sy, 0, 0, s * sx, c * sy, 0, 0, 0, 0, sz, 0];
  const t = apply34(ocs, { x: -b.x, y: -b.y, z: -b.z });
  ocs[3] = t.x + ins.insert.x;
  ocs[7] = t.y + ins.insert.y;
  ocs[11] = t.z + ins.insert.z;
  const ext = ins.extrusion;
  if (!ext || (Math.abs(ext.x) < 1e-12 && Math.abs(ext.y) < 1e-12 && ext.z > 0)) return ocs;
  const ax = ocsDirToWcs({ x: 1, y: 0, z: 0 }, ext);
  const ay = ocsDirToWcs({ x: 0, y: 1, z: 0 }, ext);
  const az = ocsDirToWcs({ x: 0, y: 0, z: 1 }, ext);
  return mul34([ax.x, ay.x, az.x, 0, ax.y, ay.y, az.y, 0, ax.z, ay.z, az.z, 0], ocs);
}

function distanceTo(doc: CadDocument, e: Entity, p: Vec3): number {
  try {
    const path = entityPath(e);
    if (path && path.pieces.length) return pathNearest(path, p).d;
  } catch {
    // 경로를 만들 수 없는 객체는 범위 상자
  }
  const b = boundsOf([e], doc);
  if (!b) return Infinity;
  return Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minY - p.y, 0, p.y - b.maxY));
}

export interface NestedHit {
  /** 고른 객체 핸들 */
  handle: string;
  /** 블록 좌표 → WCS(속성·맨 위 객체면 null) */
  matrix: Mat34 | null;
  /** 객체를 담은 블록 참조들(안쪽부터 바깥으로) */
  chain: string[];
}

/** 블록 정의 안에서 점(그 블록 좌표)에 가장 가까운 객체. 깊이 한도 32 */
function nearestIn(doc: CadDocument, def: BlockDef, p: Vec3, depth: number): { e: Entity; d: number; path: InsertEntity[] } | null {
  let best: { e: Entity; d: number; path: InsertEntity[] } | null = null;
  for (const e of def.entities) {
    if (!e.handle || e.type === 'ATTDEF' || e.invisible) continue;
    if (e.type === 'INSERT' && depth < 32) {
      const sub = doc.blocks.get(tableKey(e.block));
      const inv = sub ? inv34(insertMatrix(sub, e)) : null;
      if (sub && inv && sub.entities.length) {
        const r = nearestIn(doc, sub, apply34(inv, p), depth + 1);
        if (r) {
          // 안쪽 거리 → 이 블록 단위(축척)
          const k = Math.max(Math.abs(e.scale.x), Math.abs(e.scale.y), 1e-12);
          const d = r.d * k;
          if (!best || d < best.d) best = { e: r.e, d, path: [...r.path, e] };
          continue;
        }
      }
    }
    const d = distanceTo(doc, e, p);
    if (!best || d < best.d) best = { e, d, path: [] };
  }
  return best;
}

/**
 * 맨 위 객체 h를 점 p(WCS)에서 골랐을 때의 nentsel 결과. 블록 참조가 아니면 그 객체(행렬 없음).
 * tol: 고르기 허용 거리(WCS) — 속성은 이 거리 안이면 속성을 고른다
 */
export function nestedPick(doc: CadDocument, h: string, p: Vec3, tol: number): NestedHit {
  const top = doc.entityIndex.get(h);
  if (!top || top.type !== 'INSERT') return { handle: h, matrix: null, chain: [] };
  for (const a of top.attribs) {
    if (!a.handle || a.invisible) continue;
    const b = boundsOf([a], doc);
    if (b && p.x >= b.minX - tol && p.x <= b.maxX + tol && p.y >= b.minY - tol && p.y <= b.maxY + tol) return { handle: a.handle, matrix: null, chain: [] };
  }
  const def = doc.blocks.get(tableKey(top.block));
  const m = def ? insertMatrix(def, top) : null;
  const inv = m ? inv34(m) : null;
  if (!def || !m || !inv) return { handle: h, matrix: null, chain: [] };
  const r = nearestIn(doc, def, apply34(inv, p), 0);
  if (!r) return { handle: h, matrix: null, chain: [] };
  // 행렬: 바깥 참조부터 안쪽 참조까지 곱한다
  let mm = m;
  const inner = [...r.path].reverse();
  for (const ins of inner) {
    const sub = doc.blocks.get(tableKey(ins.block));
    if (sub) mm = mul34(mm, insertMatrix(sub, ins));
  }
  return { handle: r.e.handle, matrix: mm, chain: [...r.path.map((x) => x.handle), top.handle] };
}

