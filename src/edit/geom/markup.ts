/**
 * 표시 객체 만들기: REVCLOUD(구름형 리비전 — 볼록도가 있는 LWPOLYLINE)와 WIPEOUT(가리기).
 */
import type { Entity, EntityBase, ImageEntity, LwPolylineEntity, LwVertex, Vec2 } from '../../core/model';
import { type Path, flattenPiece, pieceAt, pieceSize } from './curve';
import { dist } from './math';
import { entityPath } from './path';

/** 구름 호의 볼록도(호 110° — tan(110°/4)) */
export const CLOUD_BULGE = Math.tan((110 * Math.PI) / 180 / 4);

export interface CloudOptions {
  minArc: number;
  maxArc: number;
  /** 컬리그래피: 호마다 폭이 0에서 현 길이의 1/10까지 커진다 */
  calligraphy?: boolean;
  /** 호가 안쪽으로 볼록하게(방향 반전) */
  reverse?: boolean;
}

/** 꺾은선의 부호 있는 넓이(반시계 +) */
export function signedArea(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * 윤곽(꺾은선)을 따라 호의 현 끝을 놓는다. 호 길이는 최소·최대를 번갈아 쓰되 전체에 맞춰 늘이거나 줄인다.
 * 닫힌 윤곽의 호는 바깥으로 볼록하다(반전이면 안쪽).
 */
export function cloudVertices(outline: readonly Vec2[], closed: boolean, opt: CloudOptions): LwVertex[] {
  const pts = outline.filter((p, i) => i === 0 || dist(p, outline[i - 1]!) > 1e-12);
  if (closed && pts.length > 2 && dist(pts[0]!, pts[pts.length - 1]!) <= 1e-12) pts.pop();
  if (pts.length < 2) return [];
  const ring = closed ? [...pts, pts[0]!] : pts;
  const cum: number[] = [0];
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1]! + dist(ring[i - 1]!, ring[i]!));
  const total = cum[cum.length - 1]!;
  if (!(total > 0)) return [];
  const lo = Math.max(1e-12, Math.min(opt.minArc, opt.maxArc));
  const hi = Math.max(lo, opt.maxArc);
  const avg = (lo + hi) / 2;
  const n = Math.max(closed ? 3 : 1, Math.round(total / avg));
  // 번갈아 쓰는 길이를 전체에 맞춘다
  const lens: number[] = [];
  for (let i = 0; i < n; i++) lens.push(i % 2 === 0 ? lo : hi);
  const sum = lens.reduce((a, b) => a + b, 0);
  const f = total / sum;
  const at = (s: number): Vec2 => {
    let k = 1;
    while (k < cum.length - 1 && cum[k]! < s) k++;
    const a = ring[k - 1]!;
    const b = ring[k]!;
    const l = cum[k]! - cum[k - 1]!;
    const t = l > 0 ? (s - cum[k - 1]!) / l : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const stations: Vec2[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    stations.push(at(s));
    s += lens[i]! * f;
  }
  if (!closed) stations.push(ring[ring.length - 1]!);
  let sign = 1;
  if (closed) sign = signedArea(pts) >= 0 ? 1 : -1;
  if (opt.reverse) sign = -sign;
  const out: LwVertex[] = [];
  const segs = closed ? stations.length : stations.length - 1;
  for (let i = 0; i < stations.length; i++) {
    const p = stations[i]!;
    const hasSeg = i < segs;
    const q = stations[(i + 1) % stations.length]!;
    const chord = hasSeg ? dist(p, q) : 0;
    out.push({
      x: p.x,
      y: p.y,
      bulge: hasSeg ? sign * CLOUD_BULGE : 0,
      startWidth: 0,
      endWidth: hasSeg && opt.calligraphy ? chord / 10 : 0,
    });
  }
  return out;
}

/** 구름 LWPOLYLINE */
export function cloudPolyline(base: Omit<EntityBase, 'type'>, outline: readonly Vec2[], closed: boolean, opt: CloudOptions): LwPolylineEntity | null {
  const vertices = cloudVertices(outline, closed, opt);
  if (vertices.length < 2) return null;
  return { type: 'LWPOLYLINE', ...base, vertices, closed, plinegen: false, constantWidth: 0, elevation: 0 };
}

/**
 * 곡선 객체의 평면도 꺾은선(호·타원호는 step 각도마다, 스플라인은 크기의 1/1000 공차).
 * 닫힌 경로는 첫 점을 끝에 되풀이하지 않는다.
 */
export function outlineOf(e: Entity, step = (10 * Math.PI) / 180): { pts: Vec2[]; closed: boolean } | null {
  const path: Path | null = entityPath(e);
  if (!path || !path.pieces.length) return null;
  const pts: Vec2[] = [];
  for (const pc of path.pieces) {
    if (pc.k === 'line') pts.push(pieceAt(pc, 0));
    else if (pc.k === 'arc' || pc.k === 'ell') {
      const sw = Math.abs(pc.k === 'arc' ? pc.sw : pc.dt);
      const n = Math.max(1, Math.ceil(sw / step - 1e-9));
      for (let i = 0; i < n; i++) pts.push(pieceAt(pc, i / n));
    } else {
      const f = flattenPiece(pc, pieceSize(pc) * 1e-3);
      for (let i = 0; i + 1 < f.length; i++) pts.push({ x: f[i]!.x, y: f[i]!.y });
    }
  }
  if (!path.closed) pts.push(pieceAt(path.pieces[path.pieces.length - 1]!, 1));
  return { pts, closed: path.closed };
}

/**
 * WIPEOUT: 다각형(평면도)을 덮는 가리기. 삽입점 = 범위 왼쪽 아래, u·v = 범위 폭·높이, 이미지 크기 1×1,
 * 경계 = 단위 사각형 기준 픽셀 좌표(−0.5 … 0.5, 처음 점을 끝에 되풀이). 이미지 픽셀 좌표처럼 원점이 왼쪽 위라
 * y는 아래로 커진다: 점 (x, y) → ((x − x0)/w − 0.5, 0.5 − (y − y0)/h). AutoCAD·ezdxf가 쓰는 값과 같다.
 */
export function makeWipeout(base: Omit<EntityBase, 'type'>, poly: readonly Vec2[], z = 0): ImageEntity | null {
  const pts = poly.filter((p, i) => i === 0 || dist(p, poly[i - 1]!) > 1e-12);
  if (pts.length > 1 && dist(pts[0]!, pts[pts.length - 1]!) <= 1e-12) pts.pop();
  if (pts.length < 3 || Math.abs(signedArea(pts)) <= 1e-18) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0) || !(h > 0)) return null;
  const clip = pts.map((p) => ({ x: (p.x - minX) / w - 0.5, y: 0.5 - (p.y - minY) / h }));
  clip.push({ ...clip[0]! });
  return {
    type: 'WIPEOUT',
    ...base,
    insert: { x: minX, y: minY, z },
    uVector: { x: w, y: 0, z: 0 },
    vVector: { x: 0, y: h, z: 0 },
    imageSize: { x: 1, y: 1 },
    displayFlags: 7,
    clipping: true,
    brightness: 50,
    contrast: 50,
    fade: 0,
    clipBoundaryType: 2,
    clipBoundary: clip,
  };
}

/** WIPEOUT·IMAGE 경계의 평면도 다각형(닫는 점 없이). 픽셀 좌표의 원점은 왼쪽 위다(y 아래로) */
export function wipeoutPolygon(e: ImageEntity): Vec2[] {
  let bnd = e.clipBoundary.map((p) => ({ x: p.x, y: p.y }));
  if (!e.clipping || bnd.length < 2)
    bnd = [
      { x: -0.5, y: -0.5 },
      { x: e.imageSize.x - 0.5, y: -0.5 },
      { x: e.imageSize.x - 0.5, y: e.imageSize.y - 0.5 },
      { x: -0.5, y: e.imageSize.y - 0.5 },
    ];
  else if (bnd.length === 2) {
    const [a, b] = bnd as [Vec2, Vec2];
    bnd = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }
  const H = e.imageSize.y;
  const out = bnd.map((p) => ({ x: e.insert.x + e.uVector.x * (p.x + 0.5) + e.vVector.x * (H - 0.5 - p.y), y: e.insert.y + e.uVector.y * (p.x + 0.5) + e.vVector.y * (H - 0.5 - p.y) }));
  if (out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= 1e-12) out.pop();
  return out;
}

