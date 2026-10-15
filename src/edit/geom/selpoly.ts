/**
 * 객체 선택 방식의 기하(화면·DOM 없음): 윈도우 폴리곤(WP)·걸침 폴리곤(CP)·울타리(F).
 * - WP는 다각형 안에 완전히 든 객체, CP는 다각형 안에 들거나 변과 만나는 객체, F는 울타리 선(열린 꺾은선)과 만나는 객체.
 * - 객체 형상은 화면 형상(선분 [x0 y0 x1 y1 …]·채운 삼각형 [x0 y0 x1 y1 x2 y2 …])이고, 형상이 없으면 범위 상자를 쓴다.
 * App의 Picker(src/app/pick.ts)·스크립트 실행기·AutoLISP ssget이 함께 쓴다. 좌표는 WCS 평면.
 */
export interface Pt {
  x: number;
  y: number;
}

/** 화면 형상(선분·채운 삼각형) */
export interface SelGeom {
  segs: number[];
  tris?: number[];
}

/** 다각형의 변이 서로 교차할 때 */
export const SELF_CROSS = '잘못된 점입니다. 폴리곤의 변은 서로 교차할 수 없습니다.';

export interface SelBox {
  handle: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 점이 다각형(닫힌 꼭짓점 목록) 안에 있는가(경계는 안) */
export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (onSeg(x, y, a.x, a.y, b.x, b.y)) return true;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSeg(x: number, y: number, ax: number, ay: number, bx: number, by: number): boolean {
  const eps = 1e-9 * Math.max(1, Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by));
  if (Math.abs(cross(ax, ay, bx, by, x, y)) > eps * Math.max(1, Math.hypot(bx - ax, by - ay))) return false;
  return x >= Math.min(ax, bx) - eps && x <= Math.max(ax, bx) + eps && y >= Math.min(ay, by) - eps && y <= Math.max(ay, by) + eps;
}

/** 두 선분이 만나는가(끝점이 닿아도) */
export function segmentsMeet(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return onSeg(ax, ay, cx, cy, dx, dy) || onSeg(bx, by, cx, cy, dx, dy) || onSeg(cx, cy, ax, ay, bx, by) || onSeg(dx, dy, ax, ay, bx, by);
}

/** 두 선분이 끝점 말고 만나는가(폴리곤 자기 교차 검사) */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c.x, c.y, d.x, d.y, a.x, a.y);
  const d2 = cross(c.x, c.y, d.x, d.y, b.x, b.y);
  const d3 = cross(a.x, a.y, b.x, b.y, c.x, c.y);
  const d4 = cross(a.x, a.y, b.x, b.y, d.x, d.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 꼭짓점 next를 더하면(닫는 변 포함) 폴리곤 변이 서로 교차하는가 */
export function polygonWouldCross(pts: readonly Pt[], next: Pt): boolean {
  const n = pts.length;
  if (n < 2) return false;
  const last = pts[n - 1]!;
  // 새 변(last→next)과 앞의 변들(이웃한 변 제외)
  for (let i = 0; i + 1 < n - 1; i++) if (segmentsCross(pts[i]!, pts[i + 1]!, last, next)) return true;
  // 닫는 변(next→처음)과 가운데 변들
  const first = pts[0]!;
  for (let i = 1; i + 1 < n; i++) if (segmentsCross(pts[i]!, pts[i + 1]!, next, first)) return true;
  return false;
}

function polyBox(poly: readonly Pt[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1, y1];
}

/** 형상의 선분(채운 삼각형의 변 포함)을 차례로 */
function eachSeg(g: SelGeom, b: SelBox, f: (x0: number, y0: number, x1: number, y1: number) => boolean): boolean {
  const s = g.segs;
  const t = g.tris ?? [];
  if (!s.length && !t.length) {
    // 형상이 없으면(점·빈 블록) 범위 상자
    const c = [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY];
    for (let k = 0; k < 4; k++) if (f(c[k * 2]!, c[k * 2 + 1]!, c[((k + 1) % 4) * 2]!, c[((k + 1) % 4) * 2 + 1]!)) return true;
    return false;
  }
  for (let i = 0; i + 3 < s.length; i += 4) if (f(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!)) return true;
  for (let i = 0; i + 5 < t.length; i += 6)
    for (let k = 0; k < 3; k++) {
      const j = i + k * 2;
      const n = i + ((k + 1) % 3) * 2;
      if (f(t[j]!, t[j + 1]!, t[n]!, t[n + 1]!)) return true;
    }
  return false;
}

function inTri(px: number, py: number, t: readonly number[], i: number): boolean {
  const d1 = cross(t[i + 2]!, t[i + 3]!, t[i]!, t[i + 1]!, px, py);
  const d2 = cross(t[i + 4]!, t[i + 5]!, t[i + 2]!, t[i + 3]!, px, py);
  const d3 = cross(t[i]!, t[i + 1]!, t[i + 4]!, t[i + 5]!, px, py);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** 선분이 다각형 경계와 만나는가 */
function segHitsPolygon(x0: number, y0: number, x1: number, y1: number, poly: readonly Pt[], closed: boolean): boolean {
  const n = poly.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (segmentsMeet(x0, y0, x1, y1, a.x, a.y, b.x, b.y)) return true;
  }
  return false;
}

/**
 * 다각형 선택. crossing이면 걸침 폴리곤(안에 들거나 변과 만남), 아니면 윈도우 폴리곤(완전히 안).
 * 다각형은 저절로 닫는다(꼭짓점 3개 미만이면 빈 결과).
 */
export function polygonHits(boxes: Iterable<SelBox>, geometry: (handle: string) => SelGeom, poly: readonly Pt[], crossing: boolean): string[] {
  if (poly.length < 3) return [];
  const [px0, py0, px1, py1] = polyBox(poly);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of boxes) {
    if (seen.has(b.handle)) continue;
    if (b.maxX < px0 || b.minX > px1 || b.maxY < py0 || b.minY > py1) continue;
    const g = geometry(b.handle);
    const boxInside = b.minX >= px0 && b.maxX <= px1 && b.minY >= py0 && b.maxY <= py1;
    // 모든 형상이 안에 있고 경계와 만나지 않으면 완전히 안(오목 다각형도)
    let inside = boxInside;
    if (inside) {
      inside = !eachSeg(g, b, (x0, y0, x1, y1) => !pointInPolygon(x0, y0, poly) || !pointInPolygon(x1, y1, poly) || crossesInterior(x0, y0, x1, y1, poly));
    }
    let hit = inside;
    if (!hit && crossing) {
      hit = eachSeg(g, b, (x0, y0, x1, y1) => pointInPolygon(x0, y0, poly) || pointInPolygon(x1, y1, poly) || segHitsPolygon(x0, y0, x1, y1, poly, true));
      // 다각형이 채운 영역 안에 통째로 들어간 경우
      const t = g.tris ?? [];
      for (let i = 0; !hit && i + 5 < t.length; i += 6) hit = inTri(poly[0]!.x, poly[0]!.y, t, i);
    }
    if (hit) {
      seen.add(b.handle);
      out.push(b.handle);
    }
  }
  return out;
}

/** 두 끝점이 다각형 안인 선분이 경계를 가로질러 밖으로 나가는가(오목 다각형) */
function crossesInterior(x0: number, y0: number, x1: number, y1: number, poly: readonly Pt[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (segmentsCross({ x: x0, y: y0 }, { x: x1, y: y1 }, a, b)) return true;
  }
  // 끝점이 경계 위에 있고 가운데가 밖인 경우
  return !pointInPolygon((x0 + x1) / 2, (y0 + y1) / 2, poly);
}

/** 울타리 선택: 울타리 선(열린 꺾은선)과 만나는 객체(점 2개 미만이면 빈 결과) */
export function fenceHits(boxes: Iterable<SelBox>, geometry: (handle: string) => SelGeom, fence: readonly Pt[]): string[] {
  if (fence.length < 2) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of boxes) {
    if (seen.has(b.handle)) continue;
    let near = false;
    for (let i = 0; i + 1 < fence.length && !near; i++) {
      const a = fence[i]!;
      const c = fence[i + 1]!;
      near = !(Math.max(a.x, c.x) < b.minX || Math.min(a.x, c.x) > b.maxX || Math.max(a.y, c.y) < b.minY || Math.min(a.y, c.y) > b.maxY);
    }
    if (!near) continue;
    const g = geometry(b.handle);
    if (eachSeg(g, b, (x0, y0, x1, y1) => segHitsPolygon(x0, y0, x1, y1, fence, false))) {
      seen.add(b.handle);
      out.push(b.handle);
    }
  }
  return out;
}
