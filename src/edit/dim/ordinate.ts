/**
 * 세로좌표 치수(6). 10 원점(UCS), 13 대상점, 14 지시선 끝. 70 비트 64면 X 좌표(지시선은 세로).
 * 지시선 끝이 대상점과 어긋나면 끝에서 2·DIMASZ ~ 4·DIMASZ 구간에서 꺾는다.
 */
import { type Out, type TextPlace, extentAlong, parallel } from './builder';
import { type P, add, dir, dot, madd, mul, perp, sub } from './vec';

export function ordinate(o: Out): void {
  const d = o.dim;
  const v = o.v;
  const xType = (d.dimType & 64) !== 0;
  const origin = o.w(d.defPoint);
  const f = o.w(d.defPoint2);
  const e = o.w(d.defPoint3);
  const ax = dir(o.h0);
  const ay = perp(ax);
  const M = xType ? ax : ay; // 재는 축
  const Lx = xType ? ay : ax; // 지시선 축
  o.measurement = Math.abs(dot(sub(f, origin), M));
  const dv = sub(e, f);
  const s = dot(dv, Lx) < 0 ? -1 : 1;
  const Ld = s < 0 ? mul(Lx, -1) : Lx;
  const dL = Math.abs(dot(dv, Lx));
  const off = dot(dv, M);
  const leaderAng = Math.atan2(Ld.y, Ld.x);
  const text = o.makeText(o.measurement);
  let place: TextPlace | null = null;
  let lineEnd = e;
  if (text) {
    const ta = o.textAngle(leaderAng, v.tih);
    const along = extentAlong(text.box, ta, leaderAng);
    const aligned = parallel(ta, leaderAng);
    let cen: P;
    if (o.userText && v.tmove !== 0) cen = o.o(d.textMid);
    else {
      cen = madd(e, Ld, v.gap + along / 2);
      if (aligned && v.tad !== 0) {
        const up = dir(ta + Math.PI / 2);
        cen = madd(cen, up, (v.tad === 4 ? -1 : 1) * (v.gap + text.box.h / 2));
      }
    }
    place = { center: cen, angle: ta };
    if (aligned && v.tad !== 0) lineEnd = madd(e, Ld, v.gap + along);
  }
  const pr = o.dimLineProps();
  const start = madd(f, Ld, v.exo);
  if (Math.abs(off) > 1e-9) {
    const j1t = Math.max(v.exo, dL - 4 * v.asz);
    const j2t = Math.max(j1t, dL - 2 * v.asz);
    const j1 = madd(f, Ld, j1t);
    const j2 = add(madd(f, Ld, j2t), mul(M, off));
    o.line(start, j1, pr);
    o.line(j1, j2, pr);
    o.line(j2, lineEnd, pr);
  } else o.line(start, lineEnd, pr);
  if (text && place) {
    o.mtext(text, place);
    o.textMid = o.userText ? o.o(d.textMid) : place.center;
  } else o.textMid = e;
  o.point(f);
  o.point(e);
  o.point(origin);
}
