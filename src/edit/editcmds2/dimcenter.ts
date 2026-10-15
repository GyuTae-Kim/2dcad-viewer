/**
 * DIMCENTER(옛 중심 표식 명령)의 선(화면·DOM 없음).
 * DIMCEN 값(DIMSCALE을 곱한 크기) m: 양수면 반길이 m의 십자, 음수면 십자 + 원 밖으로 |m|만큼 나가는 중심선
 * (십자와 중심선 사이 틈 |m|, 중심선은 중심에서 2|m|부터 r + |m|까지), 0이면 아무것도 그리지 않는다.
 * 십자 방향은 angle(현재 UCS X축, 라디안)을 따른다. 결과는 LINE 객체로 만든다(연관 없음).
 */
import type { Vec2 } from '../../core/model';

export type Seg = [Vec2, Vec2];

export function dimCenterSegments(c: Vec2, r: number, cen: number, angle = 0): Seg[] {
  if (!cen || !Number.isFinite(cen) || !(r > 0)) return [];
  const a = Math.abs(cen);
  const hx = { x: Math.cos(angle), y: Math.sin(angle) };
  const hy = { x: -hx.y, y: hx.x };
  const at = (u: Vec2, t: number): Vec2 => ({ x: c.x + u.x * t, y: c.y + u.y * t });
  const out: Seg[] = [
    [at(hx, -a), at(hx, a)],
    [at(hy, -a), at(hy, a)],
  ];
  if (cen < 0 && r > a)
    for (const [u, s] of [
      [hx, 1],
      [hx, -1],
      [hy, 1],
      [hy, -1],
    ] as const)
      out.push([at(u, s * 2 * a), at(u, s * (r + a))]);
  return out;
}
