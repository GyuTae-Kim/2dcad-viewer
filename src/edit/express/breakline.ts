/**
 * BREAKLINE(Express Tools 끊기선 기호) 계산(UI 없음).
 * 두 점 사이에 폴리선 하나를 그린다: 양 끝은 확장 거리만큼 더 나가고, 끊기 기호 위치(기본 가운데)에
 * 크기 S의 지그재그(선 방향 S, 위아래 S/2씩)가 들어간다.
 *   … ─ A ╱╲╱ B ─ …   A = 기호 가운데 − S/2, 꺾이는 점 = 가운데 ∓ S/4 ± 법선 × S/2
 */
import type { EntityBase, LwPolylineEntity, Vec2 } from '../../core/model';

export interface BreaklineOptions {
  /** 끊기 기호 크기(선 방향 길이) */
  size: number;
  /** 두 점 밖으로 더 그리는 길이 */
  extension: number;
  /** 기호 가운데(선 위로 내린다). 없으면 두 점의 가운데 */
  at?: Vec2;
}

/** 끊기선 점들. 기호가 들어가지 않으면 안내 문구 */
export function breaklinePoints(p1: Vec2, p2: Vec2, opt: BreaklineOptions): Vec2[] | string {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-12)) return '두 점이 같습니다.';
  const s = opt.size;
  if (!(s > 0)) return '기호 크기는 0보다 커야 합니다.';
  const u = { x: dx / L, y: dy / L };
  const n = { x: -u.y, y: u.x };
  const ext = Math.max(0, opt.extension);
  // 기호 가운데(두 점 사이 거리 t)
  let t = L / 2;
  if (opt.at) t = (opt.at.x - p1.x) * u.x + (opt.at.y - p1.y) * u.y;
  const lo = s / 2;
  const hi = L - s / 2;
  if (lo > hi + 1e-12) return '두 점 사이가 끊기 기호보다 짧습니다. 기호 크기(S)를 줄이십시오.';
  t = Math.min(hi, Math.max(lo, t));
  const at = (d: number, k = 0): Vec2 => ({ x: p1.x + u.x * d + n.x * k, y: p1.y + u.y * d + n.y * k });
  const pts = [at(-ext), at(t - s / 2), at(t - s / 4, s / 2), at(t + s / 4, -s / 2), at(t + s / 2), at(L + ext)];
  // 겹친 점(확장 0이고 기호가 끝에 닿을 때)은 뺀다
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 1e-12);
}

/** 끊기선 폴리선(핸들 '') */
export function makeBreakline(props: Omit<EntityBase, 'type'>, p1: Vec2, p2: Vec2, opt: BreaklineOptions, z = 0): LwPolylineEntity | string {
  const pts = breaklinePoints(p1, p2, opt);
  if (typeof pts === 'string') return pts;
  return {
    ...props,
    handle: '',
    type: 'LWPOLYLINE',
    vertices: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0, startWidth: 0, endWidth: 0 })),
    closed: false,
    plinegen: false,
    constantWidth: 0,
    elevation: z,
  };
}
