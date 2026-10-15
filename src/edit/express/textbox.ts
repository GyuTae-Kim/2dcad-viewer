/**
 * Express 문자 도구 공통: 문자 상자(평면도, 문자 방향으로 놓인 직사각형)와 문자 방향 각도.
 * 상자는 TEXTALIGN과 같은 규칙(src/edit/textools/textalign.ts textCorners)으로 잰다:
 * 한 줄 문자는 글자 폭 × (하강 ~ 문자 높이), 여러 줄 문자는 배치 범위.
 */
import type { CadDocument, Entity, Vec2 } from '../../core/model';
import { isTextLike, textHeightOf } from '../geom/textjust';
import { affApply, affLin, angleOf, dist, len, norm, rot90, sub } from '../geom/math';
import { isNaturalExt, planProj, planZ } from '../geom/ocs';
import { mtextDir } from '../geom/xtext';
import { textCorners } from '../textools/textalign';

export interface TextBox {
  /** 왼쪽 아래 구석(WCS 평면도) */
  o: Vec2;
  /** 문자 방향(단위) */
  u: Vec2;
  /** 문자 위쪽(단위, u를 반시계로 90°) */
  v: Vec2;
  /** 폭·높이(도면 단위) */
  w: number;
  h: number;
  /** 문자 높이(간격띄우기 비율의 기준) */
  height: number;
  /** 가운데 */
  c: Vec2;
  /** 고도(평면도 Z) */
  z: number;
}

/** 상자를 만들 수 있는 문자 객체 */
export function hasTextBox(e: Entity): boolean {
  return isTextLike(e) || e.type === 'MTEXT';
}

/** 문자 방향(WCS 평면도 각도, 라디안) */
export function textAngle(e: Entity): number | null {
  if (isTextLike(e)) {
    const d = affLin(planProj(e.extrusion, e.insert.z), { x: Math.cos(e.rotation), y: Math.sin(e.rotation) });
    // 정렬·맞춤 문자는 두 점이 방향을 정한다
    if ((e.halign === 3 || e.halign === 5) && e.alignPoint) {
      const a = { x: e.alignPoint.x - e.insert.x, y: e.alignPoint.y - e.insert.y };
      if (len(a) > 1e-12) return angleOf(affLin(planProj(e.extrusion, e.insert.z), a));
    }
    return angleOf(d);
  }
  if (e.type === 'MTEXT') {
    const d = mtextDir(e);
    return Math.atan2(d.y, d.x);
  }
  return null;
}

/** 문자 상자(문자가 아니면 null) */
export function textBox(e: Entity, doc: CadDocument): TextBox | null {
  if (!hasTextBox(e)) return null;
  let k = textCorners(e, doc);
  if (k.length !== 4) return null;
  // 한 줄 문자의 구석은 OCS다(자연 +Z가 아니면 평면도로 옮긴다)
  if (isTextLike(e) && e.extrusion && !isNaturalExt(e.extrusion)) {
    const P = planProj(e.extrusion, 0);
    k = k.map((q) => affApply(P, q));
  }
  const [a, b, , d] = k as [Vec2, Vec2, Vec2, Vec2];
  const w = dist(a, b);
  const h = dist(a, d);
  const ang = textAngle(e) ?? 0;
  const u = w > 1e-12 ? norm(sub(b, a)) : { x: Math.cos(ang), y: Math.sin(ang) };
  const v = h > 1e-12 ? norm(sub(d, a)) : rot90(u);
  const o = a;
  const height = textHeightOf(e, doc) ?? (h > 0 ? h : 1);
  const c = { x: o.x + u.x * (w / 2) + v.x * (h / 2), y: o.y + u.y * (w / 2) + v.y * (h / 2) };
  const z = e.type === 'MTEXT' ? e.insert.z : isTextLike(e) ? planZ(e.extrusion, e.insert.z) : 0;
  return { o, u, v, w, h, height, c, z };
}

/** 상자를 바깥으로 d만큼 넓힌 네 구석(왼쪽 아래부터 반시계) */
export function boxCorners(b: Pick<TextBox, 'o' | 'u' | 'v' | 'w' | 'h'>, d = 0): Vec2[] {
  const p = (s: number, t: number): Vec2 => ({ x: b.o.x + b.u.x * s + b.v.x * t, y: b.o.y + b.u.y * s + b.v.y * t });
  return [p(-d, -d), p(b.w + d, -d), p(b.w + d, b.h + d), p(-d, b.h + d)];
}
