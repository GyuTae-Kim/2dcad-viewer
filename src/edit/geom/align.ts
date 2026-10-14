/**
 * ALIGN: 근원점·대상점 1~3쌍으로 이동·회전(·축척·뒤집기) 변환을 구한다.
 * - 한 쌍: 이동만.
 * - 두 쌍: 첫 근원점을 첫 대상점으로 옮기고, 근원점 두 점을 잇는 방향을 대상점 두 점을 잇는 방향으로 돌린다.
 *   scale이 참이면 두 거리의 비로 첫 대상점을 기준으로 축척한다.
 * - 세 쌍: 두 쌍과 같이 돌린 뒤, 세 번째 근원점이 대상점 직선의 반대쪽에 오면 그 직선에 대해 뒤집는다(축척 없음).
 */
import type { Vec2 } from '../../core/model';
import { type Affine, affApply, affMirror, affMul, affRotate, affScale, affTranslate, cross, dist, sub } from './math';

export function alignTransform(src: readonly Vec2[], dst: readonly Vec2[], scale = false): Affine | null {
  const n = Math.min(src.length, dst.length);
  if (n < 1) return null;
  const s1 = src[0]!;
  const d1 = dst[0]!;
  let m = affTranslate(d1.x - s1.x, d1.y - s1.y);
  if (n === 1) return m;
  const s2 = src[1]!;
  const d2 = dst[1]!;
  const ls = dist(s1, s2);
  const ld = dist(d1, d2);
  if (!(ls > 1e-12) || !(ld > 1e-12)) return m;
  const a = Math.atan2(d2.y - d1.y, d2.x - d1.x) - Math.atan2(s2.y - s1.y, s2.x - s1.x);
  m = affMul(affRotate(a, d1), m);
  if (n >= 3) {
    // 세 번째 점: 대상 직선의 같은 쪽에 오도록 뒤집는다
    const q = affApply(m, src[2]!);
    const dir = sub(d2, d1);
    const sq = cross(dir, sub(q, d1));
    const sd = cross(dir, sub(dst[2]!, d1));
    if (Math.abs(sq) > 1e-12 * ld * ld && Math.abs(sd) > 1e-12 * ld * ld && sq * sd < 0) m = affMul(affMirror(d1, d2), m);
    return m;
  }
  if (scale) {
    const k = ld / ls;
    m = affMul(affScale(k, k, d1), m);
  }
  return m;
}
