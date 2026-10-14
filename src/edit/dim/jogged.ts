/**
 * 꺾기 반지름 치수(LARGE_RADIAL_DIMENSION).
 * 정의점: 10 실제 중심, 15 호 위 점(화살촉), 13 재지정한 중심, 14 꺾기선 가운데, 11 문자.
 * 치수선은 화살촉에서 실제 반지름을 따라 꺾기까지 가고, DIMJOGANG 각도로 가로지른 뒤
 * 반지름과 평행하게 재지정한 중심까지 간다. 문자는 화살촉과 꺾기 사이의 치수선 위에 놓인다.
 */
import { arrowKind, drawArrow } from './arrows';
import { type Out, type TextPlace, cutSegment, extentAlong, textOnLine, textRect, verticalOffset } from './builder';
import { type P, add, ang, dist, dot, madd, mul, perp, sub, unit } from './vec';

const MIN_ANG = (5 * Math.PI) / 180;

/** 꺾기선의 두 꺾임점과 가운데(실제 반지름 쪽 J1, 재지정 중심 쪽 J2) */
export function jogPoints(center: P, chord: P, override: P, jogPick: P, jogAngle: number): { j1: P; j2: P; mid: P } {
  const u = unit(sub(chord, center));
  const n = perp(u);
  const w = dot(sub(override, chord), n);
  const a = Math.max(MIN_ANG, Math.min(Math.PI / 2, Number.isFinite(jogAngle) && jogAngle > 0 ? jogAngle : Math.PI / 4));
  const half = Math.abs(w) / 2 / Math.tan(a);
  // 화살촉에서 중심 쪽이 음수
  const sO = Math.min(0, dot(sub(override, chord), u));
  let s = dot(sub(jogPick, chord), u);
  const lo = sO + half;
  const hi = -half;
  if (lo <= hi) s = Math.max(lo, Math.min(hi, s));
  else s = sO / 2;
  const j1 = madd(chord, u, s + half);
  const j2 = add(madd(chord, u, s - half), mul(n, w));
  return { j1, j2, mid: add(madd(chord, u, s), mul(n, w / 2)) };
}

export function jogged(o: Out): void {
  const d = o.dim;
  const v = o.v;
  const c = o.w(d.defPoint);
  const chord = o.w(d.defPoint4);
  const ovr = o.w(d.defPoint2);
  const r = dist(c, chord);
  o.measurement = r;
  const pr = o.dimLineProps();
  if (!(r > 1e-12)) {
    o.warn('dimension.degenerate');
    o.textMid = chord;
    return;
  }
  const u = unit(sub(chord, c));
  const uAng = ang(u);
  const { j1, j2 } = jogPoints(c, chord, ovr, o.w(d.defPoint3), v.jogang);
  const k = arrowKind(o, v.blk2 || v.blk1);
  const text = o.makeText(o.measurement);

  // 문자: 화살촉과 꺾기 사이(사용자 위치면 그 점을 치수선에 투영)
  const sJ = dot(sub(j1, chord), u);
  const sEnd = -k.trim;
  let place: TextPlace | null = null;
  let outside = false;
  if (text) {
    let s = (sJ + sEnd) / 2;
    if (o.userText) {
      s = dot(sub(o.o(d.textMid), chord), u);
      outside = s > 0;
    }
    const ta = o.textAngle(uAng, outside ? v.toh : v.tih);
    const anchor = madd(chord, u, s);
    place = { center: add(anchor, verticalOffset(o, text.box, ta, uAng, u)), angle: ta };
  }

  // 화살촉 쪽 선(문자가 선 위에 있으면 그만큼 끊는다)
  const rect = text && place && textOnLine(o, place.angle, uAng) ? textRect(place, text.box, v.gap) : null;
  let far = madd(chord, u, sEnd);
  if (outside && text && place) {
    const along = extentAlong(text.box, place.angle, uAng);
    const tc = dot(sub(place.center, chord), u);
    far = madd(chord, u, rect ? tc + along / 2 + v.gap : tc + along / 2);
  }
  for (const [a, b] of cutSegment(j1, far, rect)) o.line(a, b, pr);
  // 가로지르는 선과 재지정 중심까지
  o.line(j1, j2, pr);
  o.line(j2, ovr, pr);
  drawArrow(o, k, chord, u, perp(u));
  if (text && place) {
    o.mtext(text, place);
    o.textMid = o.userText ? o.o(d.textMid) : place.center;
  } else o.textMid = madd(chord, u, (sJ + sEnd) / 2);
  o.point(chord);
  o.point(c);
}
