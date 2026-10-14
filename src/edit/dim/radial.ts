/**
 * 반지름(4)·지름(3) 치수.
 * 반지름: 10 중심, 15 호 위 점. 지름: 10 먼 쪽 호 위 점, 15 가까운 쪽 호 위 점(문자 쪽).
 * 문자가 원 밖이면 화살촉은 원 밖에서 안쪽을 가리키고, DIMTOFL이면 원 안에도 치수선을 긋는다.
 */
import { arrowKind, drawArrow } from './arrows';
import { type Out, type TextPlace, extentAlong, parallel, verticalOffset } from './builder';
import { type P, add, dir, dist, dot, madd, mid, neg, perp, sub, unit } from './vec';

export function radial(o: Out): void {
  const d = o.dim;
  const v = o.v;
  const dia = (d.dimType & 7) === 3;
  const pNear = o.w(d.defPoint4);
  const c = dia ? mid(o.w(d.defPoint), pNear) : o.w(d.defPoint);
  const far = dia ? o.w(d.defPoint) : null;
  const r = dist(pNear, c);
  o.measurement = dia ? 2 * r : r;
  const u = unit(sub(pNear, c));
  const uAng = Math.atan2(u.y, u.x);
  const k = arrowKind(o, v.blk2 || v.blk1);
  const kFar = arrowKind(o, v.blk1);
  const text = o.makeText(o.measurement);
  const pr = o.dimLineProps();

  // 문자 위치
  let place: TextPlace | null = null;
  let inside: boolean;
  let anchorT = 0; // 문자 기준점의 u 방향 거리(중심 기준)
  if (o.userText && text) {
    const tm = o.o(d.textMid);
    anchorT = dot(sub(tm, c), u);
    inside = dist(tm, c) < r - 1e-9;
    if (v.tmove === 0) {
      const ta = o.textAngle(uAng, inside ? v.tih : v.toh);
      const anchor = madd(c, u, anchorT);
      place = { center: add(anchor, verticalOffset(o, text.box, ta, uAng)), angle: ta };
    } else {
      place = { center: tm, angle: o.textAngle(uAng, v.toh) };
    }
  } else {
    inside = v.tix;
    if (text) {
      if (inside) {
        const ta = o.textAngle(uAng, v.tih);
        anchorT = dia ? 0 : r / 2;
        place = { center: add(madd(c, u, anchorT), verticalOffset(o, text.box, ta, uAng)), angle: ta };
      } else {
        const ta = o.textAngle(uAng, v.toh);
        const along = extentAlong(text.box, ta, uAng);
        anchorT = r + 2 * k.size + v.gap + along / 2;
        if (parallel(ta, uAng)) place = { center: add(madd(c, u, anchorT), verticalOffset(o, text.box, ta, uAng)), angle: ta };
        else {
          // 수평 문자: 꺾은 착지선 뒤에 놓는다
          const hx = dir(o.h0);
          const s = dot(u, hx) < 0 ? -1 : 1;
          const knee = madd(c, u, r + 2 * k.size);
          const landEnd = madd(knee, hx, s * k.size);
          const cen = madd(landEnd, hx, s * (v.gap + text.box.w / 2));
          place = { center: v.tad === 0 ? cen : madd(cen, dir(ta + Math.PI / 2), v.gap + text.box.h / 2), angle: ta };
        }
      }
    }
  }

  const textOn = text && place && parallel(place.angle, uAng) && v.tad === 0;
  if (inside) {
    // 원 안: 화살촉은 호를 바깥으로 가리킨다
    const base = madd(pNear, u, -k.trim);
    if (text && place) {
      const along = extentAlong(text.box, place.angle, uAng);
      const tc = dot(sub(place.center, c), u);
      const twoSided = dia && !(o.userText && v.upt);
      if (twoSided && far) {
        const baseF = madd(far, u, kFar.trim);
        if (textOn) {
          o.line(madd(c, u, tc - along / 2 - v.gap), baseF, pr);
          o.line(madd(c, u, tc + along / 2 + v.gap), base, pr);
        } else o.line(baseF, base, pr);
      } else {
        const end = textOn ? tc + along / 2 + v.gap : tc - along / 2 - v.gap;
        o.line(madd(c, u, end), base, pr);
      }
      o.mtext(text, place);
      if (twoSided && far) drawArrow(o, kFar, far, neg(u), perp(u));
    } else {
      o.line(dia && far ? madd(far, u, kFar.trim) : c, base, pr);
      if (dia && far) drawArrow(o, kFar, far, neg(u), perp(u));
    }
    drawArrow(o, k, pNear, u, perp(u));
  } else {
    // 원 밖: 화살촉은 바깥에서 안쪽을 가리키고 선은 문자까지
    const base = madd(pNear, u, k.trim);
    if (text && place) {
      if (parallel(place.angle, uAng)) {
        const along = extentAlong(text.box, place.angle, uAng);
        const tc = dot(sub(place.center, c), u);
        const end = v.tad === 0 ? tc - along / 2 - v.gap : tc + along / 2 + v.gap;
        o.line(madd(c, u, end), base, pr);
      } else {
        // 착지선: 문자 가까운 끝 → 꺾임점 → 화살촉
        const hx = dir(place.angle);
        const s = dot(sub(place.center, pNear), hx) < 0 ? -1 : 1;
        const yOff = v.tad === 0 ? 0 : v.gap + text.box.h / 2;
        const lineY = madd(place.center, dir(place.angle + Math.PI / 2), -yOff);
        const nearEdge = madd(lineY, hx, -s * (text.box.w / 2 + v.gap));
        const farEdge = madd(lineY, hx, s * (text.box.w / 2));
        const knee = madd(nearEdge, hx, -s * k.size);
        o.line(v.tad === 0 ? nearEdge : farEdge, knee, pr);
        o.line(knee, base, pr);
      }
      o.mtext(text, place);
    } else o.line(madd(pNear, u, 2 * k.size), base, pr);
    if (v.tofl) {
      if (dia && far) o.line(madd(far, u, kFar.trim), pNear, pr);
      else o.line(c, pNear, pr);
    }
    drawArrow(o, k, pNear, neg(u), perp(u));
    if (dia && far && v.tofl) drawArrow(o, kFar, far, neg(u), perp(u));
    if (!v.tofl) centerMark(o, c, r);
  }
  o.textMid = text && place ? (o.userText ? o.o(d.textMid) : place.center) : madd(c, u, r);
  o.point(pNear);
  o.point(dia ? (far as P) : c);
}

/** 중심 표식(DIMCEN): 양수 십자, 음수 십자 + 중심선 */
export function centerMark(o: Out, c: P, r: number): void {
  const m = o.v.cen;
  if (!m) return;
  const a = Math.abs(m);
  const pr = o.dimLineProps();
  const hx = dir(o.h0);
  const hy = perp(hx);
  o.line(madd(c, hx, -a), madd(c, hx, a), pr);
  o.line(madd(c, hy, -a), madd(c, hy, a), pr);
  if (m < 0 && r > a) {
    for (const ax of [hx, neg(hx), hy, neg(hy)]) o.line(madd(c, ax, 2 * a), madd(c, ax, r + a), pr);
  }
}
