/**
 * TCIRCLE(Express Tools 문자 둘레 원·슬롯·사각형) 계산(UI 없음).
 * 간격띄우기 = 비율 × 문자 높이. 크기:
 * - 가변: 문자마다 그 상자에 맞춘다(원은 상자 구석을 지나는 원 + 간격띄우기).
 * - 일정: 원은 받은 반지름, 슬롯·사각형은 고른 문자 중 가장 큰 상자(+ 간격띄우기).
 * 슬롯은 곧은 부분이 문자 폭이고 양 끝이 반원(반지름 = 상자 높이/2 + 간격띄우기)인 닫힌 폴리선이다.
 * 결과는 문자 방향으로 놓이고 문자 고도에 놓인다.
 */
import type { CadDocument, CircleEntity, Entity, EntityBase, LwPolylineEntity, Vec2 } from '../../core/model';
import { type TextBox, hasTextBox, textBox } from './textbox';
import { packLw } from '../../core/lwpoly';

export type EncloseShape = 'circle' | 'slot' | 'rect';

export const SHAPE_LABEL: Record<EncloseShape, string> = { circle: '원', slot: '슬롯', rect: '사각형' };

/** TCIRCLE를 받는 객체 */
export function isEncloseTarget(e: Entity): boolean {
  return hasTextBox(e);
}

export interface EncloseSize {
  /** 일정한 원의 반지름 */
  radius?: number;
  /** 일정한 슬롯·사각형의 폭·높이(문자 상자 크기, 간격띄우기 전) */
  w?: number;
  h?: number;
}

/** 가변 원의 반지름(상자 구석을 지나는 원 + 간격띄우기) */
export function circleRadius(b: Pick<TextBox, 'w' | 'h' | 'height'>, offsetFactor: number): number {
  return Math.hypot(b.w / 2, b.h / 2) + offsetFactor * b.height;
}

/** 고른 문자들 중 가장 큰 상자(일정 크기 기본값) */
export function largestBox(list: readonly Entity[], doc: CadDocument): { w: number; h: number; height: number } | null {
  let w = 0;
  let h = 0;
  let height = 0;
  let any = false;
  for (const e of list) {
    const b = textBox(e, doc);
    if (!b) continue;
    any = true;
    w = Math.max(w, b.w);
    h = Math.max(h, b.h);
    height = Math.max(height, b.height);
  }
  return any ? { w, h, height } : null;
}

function lw(base: Omit<EntityBase, 'type'>, pts: { x: number; y: number; bulge: number }[], z: number): LwPolylineEntity {
  return {
    ...base,
    type: 'LWPOLYLINE',
    ...packLw(pts.map((p) => ({ x: p.x, y: p.y, bulge: p.bulge, startWidth: 0, endWidth: 0 }))),
    closed: true,
    plinegen: false,
    constantWidth: 0,
    elevation: z,
  };
}

/** 문자 하나를 둘러싸는 객체(핸들 ''). 상자가 없으면 null */
export function encloseText(e: Entity, doc: CadDocument, shape: EncloseShape, offsetFactor: number, props: Omit<EntityBase, 'type'>, size: EncloseSize = {}): Entity | null {
  const b = textBox(e, doc);
  if (!b) return null;
  const off = Math.max(0, offsetFactor) * b.height;
  const base = { ...props, handle: '' };
  if (shape === 'circle') {
    const r = size.radius && size.radius > 0 ? size.radius : circleRadius(b, offsetFactor);
    if (!(r > 0)) return null;
    const c: CircleEntity = { ...base, type: 'CIRCLE', center: { x: b.c.x, y: b.c.y, z: b.z }, radius: r };
    return c;
  }
  const w = size.w && size.w > 0 ? size.w : b.w;
  const h = size.h && size.h > 0 ? size.h : b.h;
  // 가운데 기준 지역 좌표(u 방향 s, v 방향 t) → 평면도
  const at = (s: number, t: number): Vec2 => ({ x: b.c.x + b.u.x * s + b.v.x * t, y: b.c.y + b.u.y * s + b.v.y * t });
  if (shape === 'rect') {
    const hx = w / 2 + off;
    const hy = h / 2 + off;
    if (!(hx > 0) || !(hy > 0)) return null;
    return lw(base, [at(-hx, -hy), at(hx, -hy), at(hx, hy), at(-hx, hy)].map((p) => ({ ...p, bulge: 0 })), b.z);
  }
  const R = h / 2 + off;
  const a = w / 2;
  if (!(R > 0)) return null;
  // 상자가 왼손 좌표면(상하 반전된 OCS) 반원 방향을 뒤집는다
  const sgn = b.u.x * b.v.y - b.u.y * b.v.x >= 0 ? 1 : -1;
  if (a <= 1e-12) {
    const c: CircleEntity = { ...base, type: 'CIRCLE', center: { x: b.c.x, y: b.c.y, z: b.z }, radius: R };
    return c;
  }
  return lw(
    base,
    [
      { ...at(-a, -R), bulge: 0 },
      { ...at(a, -R), bulge: sgn },
      { ...at(a, R), bulge: 0 },
      { ...at(-a, R), bulge: sgn },
    ],
    b.z,
  );
}
