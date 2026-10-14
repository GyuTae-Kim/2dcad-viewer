/**
 * 선형 치수(회전·수평·수직 0, 정렬 1).
 * 정의점: 13 첫 치수보조선 원점, 14 둘째 원점, 10 치수선 위 점(둘째 보조선과 만나는 곳), 50 회전, 52 보조선 기울기.
 */
import { type ArrowKind, arrowKind, drawArrow } from './arrows';
import { type Out, type Rect, type TextPlace, cutSegment, extentAlong, textOnLine, textRect, verticalOffset } from './builder';
import { decideFit } from './fit';
import { type P, add, ang, dir, dist, dot, intersect, madd, mid, mul, neg, perp, project, sub, unit } from './vec';

export function linear(o: Out): void {
  const d = o.dim;
  const v = o.v;
  const p1 = o.w(d.defPoint2);
  const p2 = o.w(d.defPoint3);
  const dp = o.w(d.defPoint);
  const aligned = (d.dimType & 7) === 1;
  const theta = aligned ? (dist(p1, p2) > 1e-12 ? ang(sub(p2, p1)) : d.rotation || 0) : d.rotation || 0;
  const u = dir(theta);
  const n = perp(u);
  const e = d.obliqueAngle ? dir(d.obliqueAngle) : n;
  const d2 = intersect(dp, u, p2, e) ?? project(p2, dp, u);
  const d1 = intersect(dp, u, p1, e) ?? project(p1, dp, u);
  o.measurement = aligned ? dist(p1, p2) : Math.abs(dot(sub(p2, p1), u));

  // 치수보조선
  let e1 = sub(d1, p1);
  let e2 = sub(d2, p2);
  const side = unit(add(e1, e2), n);
  e1 = unit(e1, side);
  e2 = unit(e2, side);
  const extLine = (orig: P, at: P, ed: P, i: 1 | 2) => {
    let start = madd(orig, ed, v.exo);
    if (v.fxlon) {
      const natural = dot(sub(at, orig), ed) - v.exo;
      if (natural > v.fxl) start = madd(at, ed, -v.fxl);
    }
    o.line(start, madd(at, ed, v.exe), o.extProps(i));
  };
  if (!v.se1) extLine(p1, d1, e1, 1);
  if (!v.se2) extLine(p2, d2, e2, 2);

  const L = dist(d1, d2);
  const ux = L > 1e-12 ? unit(sub(d2, d1)) : u;
  const lineAng = ang(ux);
  const k1 = arrowKind(o, v.blk1);
  const k2 = arrowKind(o, v.blk2);
  const text = o.makeText(o.measurement);

  // 문자 각도와 맞춤
  const angIn = o.textAngle(lineAng, v.tih);
  const angOut = o.textAngle(lineAng, v.toh);
  const alongIn = text ? extentAlong(text.box, angIn, lineAng) : 0;
  const alongOut = text ? extentAlong(text.box, angOut, lineAng) : 0;
  const fit = decideFit(o, L, text ? alongIn + 2 * v.gap : 0, Math.max(k1.size, k2.size) * 2);

  let place: TextPlace | null = null;
  let textInside = fit.textInside;
  /** 문자 쪽(1 첫 보조선, 2 둘째) — 바깥일 때 */
  let outSide: 1 | 2 = v.just === 1 || v.just === 3 ? 1 : 2;
  let leaderFrom: P | null = null;
  let freeText = false;
  if (text) {
    if (o.userText) {
      const tm = o.o(d.textMid);
      if (v.tmove === 0) {
        const anchor = project(tm, d1, ux);
        const t = dot(sub(anchor, d1), ux);
        textInside = t >= 0 && t <= L;
        if (!textInside) outSide = t < 0 ? 1 : 2;
        const a = textInside ? angIn : angOut;
        place = { center: add(anchor, verticalOffset(o, text.box, a, lineAng, side)), angle: a };
      } else {
        freeText = true;
        textInside = false;
        place = { center: tm, angle: angOut };
        if (v.tmove === 1) leaderFrom = mid(d1, d2);
      }
    } else if (textInside) {
      let base: P;
      const off = 2 * Math.max(k1.size, k2.size) + v.gap + alongIn / 2;
      if (v.just === 1) base = madd(d1, ux, off);
      else if (v.just === 2) base = madd(d2, ux, -off);
      else base = mid(d1, d2);
      if (v.just === 3 || v.just === 4) {
        // 보조선 위: 보조선 방향으로 놓는다
        const at = v.just === 3 ? d1 : d2;
        const ed = v.just === 3 ? e1 : e2;
        const a = o.textAngle(ang(ed), false);
        const along = extentAlong(text.box, a, ang(ed));
        const up = dir(a + Math.PI / 2);
        const c = add(madd(at, ed, v.gap + along / 2), v.tad === 0 ? { x: 0, y: 0 } : mul(up, (dot(up, ux) > 0 ? -1 : 1) * (v.gap + text.box.h / 2)));
        place = { center: c, angle: a };
      } else place = { center: add(base, verticalOffset(o, text.box, angIn, lineAng, side)), angle: angIn };
    } else {
      const sgn = outSide === 2 ? 1 : -1;
      const at = outSide === 2 ? d2 : d1;
      const start = (fit.arrowsInside ? Math.max(k1.size, k2.size) : 2 * Math.max(k1.size, k2.size)) + v.gap;
      const base = madd(at, ux, sgn * (start + alongOut / 2));
      place = { center: add(base, verticalOffset(o, text.box, angOut, lineAng, side)), angle: angOut };
    }
  }

  // 치수선
  const pr = o.dimLineProps();
  const segs: [P, P][] = [];
  const show1 = !v.sd1;
  const show2 = !v.sd2;
  const arrowsIn = fit.arrowsInside;
  const trimIn = (k: ArrowKind, show: boolean) => (fit.arrowsSuppressed || !show ? 0 : k.tick ? -v.dle : k.trim);
  const rect: Rect | null = text && place && !freeText && textInside && textOnLine(o, place.angle, lineAng) ? textRect(place, text.box, v.gap) : null;
  // 바깥 문자까지 늘이는 선의 끝(문자 쪽)
  const textReach = (): number => {
    if (!text || !place || textInside || freeText) return 0;
    const along = extentAlong(text.box, place.angle, lineAng);
    const c = dot(sub(place.center, outSide === 2 ? d2 : d1), outSide === 2 ? ux : neg(ux));
    return textOnLine(o, place.angle, lineAng) ? c - along / 2 - v.gap : c + along / 2;
  };
  if (arrowsIn || fit.arrowsSuppressed) {
    let a = madd(d1, ux, trimIn(k1, show1));
    let b = madd(d2, ux, -trimIn(k2, show2));
    const reach = textReach();
    if (reach > 0) {
      if (outSide === 2) b = madd(d2, ux, Math.max(reach, -trimIn(k2, show2)));
      else a = madd(d1, ux, -Math.max(reach, -trimIn(k1, show1)));
    }
    segs.push(...cutSegment(a, b, rect));
  } else {
    // 화살촉 바깥: 꼬리선
    const tail = (at: P, s: number, k: ArrowKind, isTextSide: boolean) => {
      const from = madd(at, ux, s * k.trim);
      let len = k.size + k.size;
      if (isTextSide) len = Math.max(len, textReach());
      segs.push([from, madd(at, ux, s * len)]);
    };
    if (show1) tail(d1, -1, k1, !textInside && outSide === 1);
    if (show2) tail(d2, 1, k2, !textInside && outSide === 2);
    if (v.tofl) segs.push(...cutSegment(d1, d2, rect));
  }
  // 치수선 반쪽 숨기기
  let lines = segs;
  if (v.sd1 || v.sd2) {
    const split = place && textInside ? dot(sub(project(place.center, d1, ux), d1), ux) : L / 2;
    lines = [];
    for (const [a, b] of segs) {
      const ta = dot(sub(a, d1), ux);
      const tb = dot(sub(b, d1), ux);
      const lo = Math.min(ta, tb);
      const hi = Math.max(ta, tb);
      const keepLo = v.sd1 ? Math.max(lo, split) : lo;
      const keepHi = v.sd2 ? Math.min(hi, split) : hi;
      if (keepHi - keepLo > 1e-12) lines.push(ta <= tb ? [madd(d1, ux, keepLo), madd(d1, ux, keepHi)] : [madd(d1, ux, keepHi), madd(d1, ux, keepLo)]);
    }
  }
  for (const [a, b] of lines) o.line(a, b, pr);
  if (leaderFrom && place && text) leaderTo(o, leaderFrom, place, text.box);

  // 화살촉
  if (!fit.arrowsSuppressed) {
    if (show1) drawArrow(o, k1, d1, arrowsIn ? neg(ux) : ux, perp(ux));
    if (show2) drawArrow(o, k2, d2, arrowsIn ? ux : neg(ux), perp(ux));
  }

  if (text && place) {
    o.mtext(text, place);
    o.textMid = o.userText ? o.o(d.textMid) : place.center;
  } else o.textMid = mid(d1, d2);

  o.point(p1);
  o.point(p2);
  o.point(dp);
}

/** 문자 이동(DIMTMOVE 1): 치수선에서 문자까지 지시선 */
export function leaderTo(o: Out, from: P, place: TextPlace, box: { w: number; h: number }): void {
  const ax = dir(place.angle);
  const s = dot(sub(from, place.center), ax) < 0 ? -1 : 1;
  const edge = madd(place.center, ax, s * (box.w / 2 + o.v.gap));
  const land = madd(edge, ax, s * o.v.asz);
  const pr = o.dimLineProps();
  o.line(from, land, pr);
  o.line(land, edge, pr);
}
