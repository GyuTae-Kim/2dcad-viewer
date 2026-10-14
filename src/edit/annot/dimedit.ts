/**
 * 치수 편집 계산: DIMEDIT(홈·새 문자·회전·기울기), DIMTEDIT(왼쪽·오른쪽·중심·홈·각도), DIMSPACE(간격 맞춤).
 * 모두 새 치수 객체를 돌려준다(블록은 부르는 쪽이 다시 만든다).
 */
import type { CadDocument, DimensionEntity, Vec3 } from '../../core/model';
import { dimVars } from '../dim/vars';
import { applyOverrides } from './override';

interface P {
  x: number;
  y: number;
}

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const cross = (a: P, b: P) => a.x * b.y - a.y * b.x;
const len = (a: P) => Math.hypot(a.x, a.y);
const unit = (a: P, f: P = { x: 1, y: 0 }): P => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : f;
};
const perp = (a: P): P => ({ x: -a.y, y: a.x });
const dir = (a: number): P => ({ x: Math.cos(a), y: Math.sin(a) });
const mv = (q: Vec3, d: P, k: number): Vec3 => ({ x: q.x + d.x * k, y: q.y + d.y * k, z: q.z });

/** 선형·정렬 치수인지(호 길이·꺾기 반지름 제외) */
export function isLinearDim(d: DimensionEntity): boolean {
  const k = d.dimType & 7;
  return !d.subtype && (k === 0 || k === 1);
}

/** 각도 치수인지(2선·3점) */
export function isAngularDim(d: DimensionEntity): boolean {
  const k = d.dimType & 7;
  return !d.subtype && (k === 2 || k === 5);
}

/** 선형 치수의 치수선 방향(단위) */
export function linearDir(d: DimensionEntity): P {
  if ((d.dimType & 7) === 1) return unit(sub(d.defPoint3, d.defPoint2), dir(d.rotation || 0));
  return dir(d.rotation || 0);
}

/** 치수보조선 방향(기울기가 있으면 그 각, 없으면 치수선에 수직) */
export function extDir(d: DimensionEntity): P {
  return d.obliqueAngle ? dir(d.obliqueAngle) : perp(linearDir(d));
}

/** 치수선 두 끝(WCS 평면) */
export function linearFeetW(d: DimensionEntity): { d1: P; d2: P } {
  const u = linearDir(d);
  const e = extDir(d);
  const dp = d.defPoint;
  const foot = (q: P): P => {
    const den = cross(u, e);
    if (Math.abs(den) < 1e-14) return { x: dp.x + u.x * dot(sub(q, dp), u), y: dp.y + u.y * dot(sub(q, dp), u) };
    const s = cross(sub(q, dp), e) / den;
    return { x: dp.x + u.x * s, y: dp.y + u.y * s };
  };
  return { d1: foot(d.defPoint2), d2: foot(d.defPoint3) };
}

// ---------------------------------------------------------------------------
// DIMEDIT
// ---------------------------------------------------------------------------

/** 홈: 문자를 기본 위치로(DIMEDIT는 회전도 지운다) */
export function dimHome(d: DimensionEntity, resetRotation: boolean): DimensionEntity {
  const c = structuredClone(d);
  c.dimType &= ~128;
  if (resetRotation) c.textRotation = 0;
  return c;
}

export function dimNewText(d: DimensionEntity, text: string): DimensionEntity {
  const c = structuredClone(d);
  c.text = text === '<>' ? '' : text;
  return c;
}

export function dimRotateText(d: DimensionEntity, angle: number): DimensionEntity {
  const c = structuredClone(d);
  c.textRotation = angle;
  return c;
}

/** 기울기(선형·정렬만). angle = 치수보조선의 절대 각(라디안), 0 = 없음. 치수선과 나란하면 null */
export function dimOblique(d: DimensionEntity, angle: number): DimensionEntity | null {
  if (!isLinearDim(d)) return null;
  const u = linearDir(d);
  if (angle && Math.abs(cross(u, dir(angle))) < 1e-9) return null;
  const c = structuredClone(d);
  // 치수선 위치(10)는 둘째 보조선과 치수선이 만나는 곳: 치수선은 그대로 두고 새 보조선 방향으로 다시 구한다
  const { d2 } = linearFeetW(d);
  c.obliqueAngle = angle;
  const e = angle ? dir(angle) : perp(u);
  const den = cross(u, e);
  const q = c.defPoint3;
  const s = Math.abs(den) < 1e-14 ? 0 : cross(sub(q, d2), e) / den;
  c.defPoint = { x: d2.x + u.x * s, y: d2.y + u.y * s, z: d.defPoint.z };
  return c;
}

// ---------------------------------------------------------------------------
// DIMTEDIT
// ---------------------------------------------------------------------------

/**
 * 왼쪽·오른쪽·중심: DIMJUST 재지정(1 첫째 보조선 옆, 2 둘째 보조선 옆, 0 가운데)으로 두고 사용자 위치를 지운다.
 * 왼쪽·오른쪽은 읽는 방향으로 본 쪽이다. 선형·정렬 치수가 아니면 null.
 */
export function dimJustify(d: DimensionEntity, side: 'L' | 'R' | 'C'): DimensionEntity | null {
  if (!isLinearDim(d)) return null;
  let just = 0;
  if (side !== 'C') {
    const { d1, d2 } = linearFeetW(d);
    let u = unit(sub(d2, d1), linearDir(d));
    // 읽는 방향: (-90°, 90°]
    if (u.x < -1e-9 || (Math.abs(u.x) <= 1e-9 && u.y < 0)) u = { x: -u.x, y: -u.y };
    const firstLeft = dot(sub(d1, d2), u) < 0;
    just = side === 'L' ? (firstLeft ? 1 : 2) : firstLeft ? 2 : 1;
  }
  const c = applyOverrides(d, { 280: just });
  c.dimType &= ~128;
  return c;
}

// ---------------------------------------------------------------------------
// DIMSPACE
// ---------------------------------------------------------------------------

/** 각도 치수의 꼭짓점과 호 위치 점 */
export function angularVertex(d: DimensionEntity): { c: P; arc: P; key: 'defPoint' | 'defPoint5' } | null {
  const k = d.dimType & 7;
  if (k === 5) return { c: d.defPoint4, arc: d.defPoint, key: 'defPoint' };
  if (k !== 2) return null;
  const a = d.defPoint2;
  const u = sub(d.defPoint3, a);
  const b = d.defPoint4;
  const v = sub(d.defPoint, b);
  const den = cross(u, v);
  if (Math.abs(den) < 1e-14) return null;
  const s = cross(sub(b, a), v) / den;
  return { c: { x: a.x + u.x * s, y: a.y + u.y * s }, arc: d.defPoint5, key: 'defPoint5' };
}

/** 자동 간격: 기준 치수 문자 높이의 두 배(AutoCAD) */
export function autoSpacing(doc: CadDocument, base: DimensionEntity): number {
  const v = dimVars(doc, base);
  return 2 * v.txt;
}

/**
 * 기준 치수와 나란한 선형 치수(또는 같은 꼭짓점의 각도 치수)를 spacing 간격으로 놓는다(0이면 기준 치수선에 맞춘다).
 * 기준 쪽마다 가까운 것부터 차례로 놓는다. 바뀐 치수만 돌려준다(맞지 않는 치수는 skipped).
 */
export function spaceDimensions(base: DimensionEntity, others: readonly DimensionEntity[], spacing: number): { changed: DimensionEntity[]; skipped: DimensionEntity[] } {
  const changed: DimensionEntity[] = [];
  const skipped: DimensionEntity[] = [];
  const tol = 1e-6;
  if (isLinearDim(base)) {
    const u = linearDir(base);
    const n = perp(u);
    const sb = dot(base.defPoint, n);
    const items: { d: DimensionEntity; s: number }[] = [];
    for (const d of others) {
      if (d.handle === base.handle) continue;
      if (!isLinearDim(d) || Math.abs(cross(linearDir(d), u)) > tol) {
        skipped.push(d);
        continue;
      }
      items.push({ d, s: dot(d.defPoint, n) });
    }
    for (const sgn of [1, -1]) {
      const side = items.filter((it) => (sgn > 0 ? it.s - sb >= 0 : it.s - sb < 0)).sort((a, b) => Math.abs(a.s - sb) - Math.abs(b.s - sb));
      side.forEach((it, i) => {
        const target = sb + sgn * (i + 1) * spacing;
        const delta = target - it.s;
        if (Math.abs(delta) < 1e-12) return;
        const e = extDir(it.d);
        const k = delta / (dot(e, n) || 1);
        const c = structuredClone(it.d);
        c.defPoint = mv(c.defPoint, e, k);
        if (c.dimType & 128) c.textMid = mv(c.textMid, e, k);
        changed.push(c);
      });
    }
    return { changed, skipped };
  }
  const bv = angularVertex(base);
  if (!bv) return { changed, skipped: [...others] };
  const rb = len(sub(bv.arc, bv.c));
  const scale = Math.max(1, rb);
  const items: { d: DimensionEntity; r: number; v: NonNullable<ReturnType<typeof angularVertex>> }[] = [];
  for (const d of others) {
    if (d.handle === base.handle) continue;
    const v = isAngularDim(d) ? angularVertex(d) : null;
    if (!v || len(sub(v.c, bv.c)) > 1e-6 * scale) {
      skipped.push(d);
      continue;
    }
    items.push({ d, r: len(sub(v.arc, v.c)), v });
  }
  for (const sgn of [1, -1]) {
    const side = items.filter((it) => (sgn > 0 ? it.r - rb >= 0 : it.r - rb < 0)).sort((a, b) => Math.abs(a.r - rb) - Math.abs(b.r - rb));
    side.forEach((it, i) => {
      const target = Math.max(1e-9, rb + sgn * (i + 1) * spacing);
      if (Math.abs(target - it.r) < 1e-12) return;
      const c = structuredClone(it.d);
      const u = unit(sub(it.v.arc, it.v.c));
      const q = c[it.v.key];
      c[it.v.key] = { x: it.v.c.x + u.x * target, y: it.v.c.y + u.y * target, z: q.z };
      if (c.dimType & 128) {
        const t = c.textMid;
        const tu = unit(sub(t, it.v.c), u);
        const tr = len(sub(t, it.v.c)) + (target - it.r);
        c.textMid = { x: it.v.c.x + tu.x * tr, y: it.v.c.y + tu.y * tr, z: t.z };
      }
      changed.push(c);
    });
  }
  return { changed, skipped };
}
