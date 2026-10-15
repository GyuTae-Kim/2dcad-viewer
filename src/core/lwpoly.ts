/**
 * 경량 폴리선(LWPOLYLINE) 정점 평탄 좌표 도우미.
 *
 * 문서는 정점을 객체 배열 대신 수 배열 두 개로 둔다(큰 도면의 문서 메모리·GC를 줄인다).
 * - verts: [x0, y0, 볼록0, x1, y1, 볼록1, …] — 정점 수 = verts.length / 3
 * - widths: [시작 폭0, 끝 폭0, 시작 폭1, 끝 폭1, …] — 모두 +0이면 없다(undefined)
 * 그리기·읽기·쓰기처럼 많이 도는 곳은 배열을 바로 읽고, 편집 계산은 lwVertices로 풀어 쓴 뒤 packLw·setLwVertices로 되돌린다.
 */
import type { LwPolylineEntity, LwVertex, Vec2 } from './model';

/** 평탄 정점 자료(객체 리터럴에 펼쳐 넣는다: `{ ...packLw(vs) }` — widths가 없어도 키를 남겨 앞 값을 덮는다) */
export interface LwPacked {
  verts: number[];
  widths: number[] | undefined;
}

/** 0으로 채운 수 배열(push로 만들어 빈칸 없는 빠른 배열이 되게) */
export function zeros(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(0);
  return a.slice();
}

/**
 * 수 배열 사본(하나씩 push — 빈칸 없는 실수 배열이 된다). 구조화 복제·펼치기(`[...a]`)는 상자에 든 수 배열을 그대로 두므로
 * 복제한 객체의 평탄 좌표를 다시 담을 때 쓴다.
 */
export function numArray(a: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) out.push(a[i]!);
  // push로 키운 배열의 남는 칸을 버린다
  return out.slice();
}

/** 구조화 복제한 경량 폴리선의 평탄 좌표를 원본에서 다시 복사한다(키 순서는 그대로) */
export function unboxLw(copy: LwPolylineEntity, src: LwPolylineEntity): void {
  copy.verts = numArray(src.verts);
  if (src.widths) copy.widths = numArray(src.widths);
}

/** 폭 배열이 필요한지(+0이 아닌 값이 하나라도 있으면) */
function needWidths(w: readonly number[]): boolean {
  for (let i = 0; i < w.length; i++) {
    const v = w[i]!;
    if (v !== 0 || 1 / v < 0) return true;
  }
  return false;
}

/** 폭 배열을 정리한다: 모두 +0이면 undefined */
export function tidyWidths(w: number[] | undefined): number[] | undefined {
  return w && needWidths(w) ? w : undefined;
}

/** 풀어 쓴 정점들을 평탄 자료로 */
export function packLw(vs: readonly LwVertex[]): LwPacked {
  const n = vs.length;
  const verts: number[] = [];
  let widths: number[] | undefined;
  for (let i = 0; i < n; i++) {
    const v = vs[i]!;
    verts.push(v.x, v.y, v.bulge);
    const s = v.startWidth;
    const e = v.endWidth;
    if (!widths && (s !== 0 || e !== 0 || 1 / s < 0 || 1 / e < 0)) widths = zeros(n * 2);
    if (widths) {
      widths[i * 2] = s;
      widths[i * 2 + 1] = e;
    }
  }
  return { verts: verts.slice(), widths };
}

/** 점들(볼록·폭 0)을 평탄 자료로 */
export function packLwPoints(pts: readonly Vec2[]): LwPacked {
  const verts: number[] = [];
  for (const p of pts) verts.push(p.x, p.y, 0);
  return { verts: verts.slice(), widths: undefined };
}

/** 정점 수 */
export function lwCount(e: Pick<LwPolylineEntity, 'verts'>): number {
  return (e.verts.length / 3) | 0;
}

/** 정점 하나를 풀어 쓴다 */
export function lwVertex(e: Pick<LwPolylineEntity, 'verts' | 'widths'>, i: number): LwVertex {
  const v = e.verts;
  const w = e.widths;
  return { x: v[i * 3]!, y: v[i * 3 + 1]!, bulge: v[i * 3 + 2]!, startWidth: w ? w[i * 2]! : 0, endWidth: w ? w[i * 2 + 1]! : 0 };
}

/** 정점들을 풀어 쓴다(새 객체 — 고쳐도 문서는 그대로) */
export function lwVertices(e: Pick<LwPolylineEntity, 'verts' | 'widths'>): LwVertex[] {
  const n = lwCount(e);
  const out = new Array<LwVertex>(n);
  for (let i = 0; i < n; i++) out[i] = lwVertex(e, i);
  return out;
}

/** 정점 위치(OCS) */
export function lwPoint(e: Pick<LwPolylineEntity, 'verts'>, i: number): Vec2 {
  return { x: e.verts[i * 3]!, y: e.verts[i * 3 + 1]! };
}

/** 정점 위치들(OCS) */
export function lwPoints(e: Pick<LwPolylineEntity, 'verts'>): Vec2[] {
  const n = lwCount(e);
  const out = new Array<Vec2>(n);
  for (let i = 0; i < n; i++) out[i] = { x: e.verts[i * 3]!, y: e.verts[i * 3 + 1]! };
  return out;
}

export const lwX = (e: Pick<LwPolylineEntity, 'verts'>, i: number): number => e.verts[i * 3]!;
export const lwY = (e: Pick<LwPolylineEntity, 'verts'>, i: number): number => e.verts[i * 3 + 1]!;
export const lwBulge = (e: Pick<LwPolylineEntity, 'verts'>, i: number): number => e.verts[i * 3 + 2]!;
export const lwStartWidth = (e: Pick<LwPolylineEntity, 'widths'>, i: number): number => (e.widths ? e.widths[i * 2]! : 0);
export const lwEndWidth = (e: Pick<LwPolylineEntity, 'widths'>, i: number): number => (e.widths ? e.widths[i * 2 + 1]! : 0);

/** 정점별 폭이 하나라도 있는지(쓰기에서 40·41을 쓸지) — 예전 `vertices.some((v) => v.startWidth || v.endWidth)`와 같다 */
export function lwHasWidths(e: Pick<LwPolylineEntity, 'widths'>): boolean {
  const w = e.widths;
  if (!w) return false;
  for (let i = 0; i < w.length; i++) if (w[i]) return true;
  return false;
}

/** 볼록이 하나라도 있는지 */
export function lwHasBulge(e: Pick<LwPolylineEntity, 'verts'>): boolean {
  const v = e.verts;
  for (let i = 2; i < v.length; i += 3) if (v[i] !== 0) return true;
  return false;
}

/** 정점들을 바꾼다(그 자리에서) */
export function setLwVertices(e: LwPolylineEntity, vs: readonly LwVertex[]): void {
  const p = packLw(vs);
  e.verts = p.verts;
  e.widths = p.widths;
}

/** 정점 하나를 고친다(그 자리에서 — 문서에 들어 있지 않은 사본에만 쓸 것) */
export function setLwVertex(e: LwPolylineEntity, i: number, v: Partial<LwVertex>): void {
  if (v.x !== undefined) e.verts[i * 3] = v.x;
  if (v.y !== undefined) e.verts[i * 3 + 1] = v.y;
  if (v.bulge !== undefined) e.verts[i * 3 + 2] = v.bulge;
  if (v.startWidth !== undefined || v.endWidth !== undefined) {
    const s = v.startWidth ?? lwStartWidth(e, i);
    const w = v.endWidth ?? lwEndWidth(e, i);
    if (!e.widths) {
      if (s === 0 && w === 0 && 1 / s > 0 && 1 / w > 0) return;
      e.widths = zeros(lwCount(e) * 2);
    }
    e.widths[i * 2] = s;
    e.widths[i * 2 + 1] = w;
    e.widths = tidyWidths(e.widths);
  }
}

/** 정점 배열을 깊이 복사한 사본(정점을 그 자리에서 고치기 전에) */
export function cloneLwArrays<T extends Pick<LwPolylineEntity, 'verts' | 'widths'>>(e: T): T {
  return { ...e, verts: e.verts.slice(), widths: e.widths?.slice() };
}
