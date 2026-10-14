/** 치수 그림용 2D 벡터 도우미 */
import type { Vec3 } from '../../core/model';

export interface P {
  x: number;
  y: number;
}

export const p = (x: number, y: number): P => ({ x, y });
export const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: P, k: number): P => ({ x: a.x * k, y: a.y * k });
/** a + b·k */
export const madd = (a: P, b: P, k: number): P => ({ x: a.x + b.x * k, y: a.y + b.y * k });
export const dot = (a: P, b: P): number => a.x * b.x + a.y * b.y;
export const cross = (a: P, b: P): number => a.x * b.y - a.y * b.x;
export const len = (a: P): number => Math.hypot(a.x, a.y);
export const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dir = (a: number): P => ({ x: Math.cos(a), y: Math.sin(a) });
export const ang = (a: P): number => Math.atan2(a.y, a.x);
/** 왼쪽 법선(반시계 90°) */
export const perp = (a: P): P => ({ x: -a.y, y: a.x });
export const neg = (a: P): P => ({ x: -a.x, y: -a.y });
export const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function unit(a: P, fallback: P = { x: 1, y: 0 }): P {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : fallback;
}

export const TAU = Math.PI * 2;

/** 0..2π */
export function norm2pi(a: number): number {
  const r = a % TAU;
  return (r < 0 ? r + TAU : r) + 0;
}

/** -π..π */
export function normPi(a: number): number {
  let r = norm2pi(a);
  if (r > Math.PI) r -= TAU;
  return r;
}

/** a0에서 반시계로 a1까지의 각(0..2π) */
export function ccw(a0: number, a1: number): number {
  return norm2pi(a1 - a0);
}

/** 두 직선(점 a + s·u, 점 b + t·v)의 교점. 평행이면 null */
export function intersect(a: P, u: P, b: P, v: P): P | null {
  const d = cross(u, v);
  if (Math.abs(d) < 1e-14) return null;
  const s = cross(sub(b, a), v) / d;
  return madd(a, u, s);
}

/** 점을 직선(점 a, 방향 u: 단위)에 투영 */
export function project(q: P, a: P, u: P): P {
  return madd(a, u, dot(sub(q, a), u));
}

export const v3of = (q: P, z = 0): Vec3 => ({ x: q.x, y: q.y, z });
