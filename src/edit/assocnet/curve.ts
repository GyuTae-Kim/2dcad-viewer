/**
 * 연관 배열 경로의 곡선 캐시(모서리 동작 매개변수 RowProfile의 AcGe 곡선 태그) 읽기·쓰기.
 *
 * AutoCAD가 저장한 공개 DXF(경로 배열 DXF 215개 — 선분 385, 복합 92, 원호 9, NURBS 4)에서 본 배치:
 *  - 23 선분: 10 시작점, 10 방향 벡터(끝점 − 시작점)
 *  - 11 원호(원 포함): 10 중심, 10 법선, 10 기준 벡터(각도 0 방향), 40 반지름, 40 시작 각도, 40 끝 각도, 40 0
 *    (각도는 기준 벡터에서 법선 둘레로 잰다. 원은 0 ~ 2π)
 *  - 42 NURBS: 70 0, 70 0, 90 차수, 40 공차(1e-9), 매듭 배열, 무게 배열(비유리면 0개), 조정점 배열.
 *    배열마다 90 개수, 90 개수(같은 값), 90 8, 그다음 값(매듭·무게 40, 조정점 10/20/30)
 *  - 47 복합 곡선(폴리선): 90 조각 수 + 조각(23 선분, 11 원호)
 * DWG 비트 배치는 src/io/dwg/assoccodec.ts(같은 종류를 BL 종류 + BD·3BD·BL로 쓴다).
 */
import type { RawTag, Vec2, Vec3 } from '../../core/model';
import type { CachedPiece } from '../assocarray/types';
import { type Affine, affApply, affLin } from '../geom/math';
import { entityPath } from '../geom/path';
import type { Entity } from '../../core/model';
import { num } from './tags';

/** 배열(AcGe 배열): 개수·용량·늘림 단위 + 값 */
export interface CurveArray<T> {
  /** 둘째 90(표본은 개수와 같다) */
  cap: number;
  /** 셋째 90(표본은 8) */
  grow: number;
  v: T[];
}

export type CurveData =
  | { type: 23; a: Vec3; v: Vec3 }
  | { type: 11; center: Vec3; normal: Vec3; ref: Vec3; radius: number; start: number; end: number; /** 넷째 이후 40(표본은 0 하나) */ extra: number[] }
  | { type: 42; flags: number[]; degree: number; tol: number[]; knots: CurveArray<number>; weights: CurveArray<number>; ctrl: CurveArray<Vec3> }
  | { type: 47; curves: CurveData[] };

function pt3(t: readonly RawTag[], i: number, code = 10): Vec3 | null {
  if (t[i]?.code !== code || t[i + 1]?.code !== code + 10 || t[i + 2]?.code !== code + 20) return null;
  return { x: num(t[i]!.value), y: num(t[i + 1]!.value), z: num(t[i + 2]!.value) };
}

/** 태그 → 곡선 자료(모르는 종류·꼴이면 null) */
export function parseCurve(t: readonly RawTag[], i: number, depth = 0): { curve: CurveData; next: number } | null {
  if (t[i]?.code !== 90 || depth > 4) return null;
  const type = num(t[i]!.value);
  if (type === 23) {
    const a = pt3(t, i + 1);
    const v = pt3(t, i + 4);
    if (!a || !v) return null;
    return { curve: { type: 23, a, v }, next: i + 7 };
  }
  if (type === 11) {
    const c = pt3(t, i + 1);
    const n = pt3(t, i + 4);
    const ref = pt3(t, i + 7);
    if (!c || !n || !ref) return null;
    let j = i + 10;
    const vals: number[] = [];
    while (t[j]?.code === 40) vals.push(num(t[j++]!.value));
    if (vals.length < 3) return null;
    const [radius, start, end, ...extra] = vals as [number, number, number, ...number[]];
    return { curve: { type: 11, center: c, normal: n, ref, radius, start, end, extra }, next: j };
  }
  if (type === 42) {
    let j = i + 1;
    const flags: number[] = [];
    while (t[j]?.code === 70) flags.push(num(t[j++]!.value));
    if (t[j]?.code !== 90) return null;
    const degree = num(t[j++]!.value);
    const tol: number[] = [];
    while (t[j]?.code === 40) tol.push(num(t[j++]!.value));
    const head = (): { n: number; cap: number; grow: number } | null => {
      if (t[j]?.code !== 90 || t[j + 1]?.code !== 90 || t[j + 2]?.code !== 90) return null;
      const h = { n: num(t[j]!.value), cap: num(t[j + 1]!.value), grow: num(t[j + 2]!.value) };
      j += 3;
      return h.n >= 0 && h.n < 1e6 ? h : null;
    };
    const nums = (): CurveArray<number> | null => {
      const h = head();
      if (!h) return null;
      const v: number[] = [];
      for (let k = 0; k < h.n; k++) {
        if (t[j]?.code !== 40) return null;
        v.push(num(t[j++]!.value));
      }
      return { cap: h.cap, grow: h.grow, v };
    };
    const knots = nums();
    if (!knots) return null;
    const weights = nums();
    if (!weights) return null;
    const h = head();
    if (!h) return null;
    const pts: Vec3[] = [];
    for (let k = 0; k < h.n; k++) {
      const q = pt3(t, j);
      if (!q) return null;
      pts.push(q);
      j += 3;
    }
    if (degree < 1 || knots.v.length !== pts.length + degree + 1 || (weights.v.length && weights.v.length !== pts.length)) return null;
    return { curve: { type: 42, flags, degree, tol, knots, weights, ctrl: { cap: h.cap, grow: h.grow, v: pts } }, next: j };
  }
  if (type === 47) {
    if (t[i + 1]?.code !== 90) return null;
    const n = num(t[i + 1]!.value);
    if (n < 0 || n > 1e6) return null;
    const curves: CurveData[] = [];
    let j = i + 2;
    for (let k = 0; k < n; k++) {
      const c = parseCurve(t, j, depth + 1);
      if (!c) return null;
      curves.push(c.curve);
      j = c.next;
    }
    return { curve: { type: 47, curves }, next: j };
  }
  return null;
}

/** 곡선 자료 → 태그 */
export function writeCurve(c: CurveData, out: RawTag[] = []): RawTag[] {
  const p = (code: number, v: Vec3) => out.push({ code, value: v.x }, { code: code + 10, value: v.y }, { code: code + 20, value: v.z });
  out.push({ code: 90, value: c.type });
  switch (c.type) {
    case 23:
      p(10, c.a);
      p(10, c.v);
      break;
    case 11:
      p(10, c.center);
      p(10, c.normal);
      p(10, c.ref);
      for (const v of [c.radius, c.start, c.end, ...c.extra]) out.push({ code: 40, value: v });
      break;
    case 42: {
      for (const f of c.flags) out.push({ code: 70, value: f });
      out.push({ code: 90, value: c.degree });
      for (const v of c.tol) out.push({ code: 40, value: v });
      for (const a of [c.knots, c.weights]) {
        out.push({ code: 90, value: a.v.length }, { code: 90, value: a.cap }, { code: 90, value: a.grow });
        for (const v of a.v) out.push({ code: 40, value: v });
      }
      out.push({ code: 90, value: c.ctrl.v.length }, { code: 90, value: c.ctrl.cap }, { code: 90, value: c.ctrl.grow });
      for (const q of c.ctrl.v) p(10, q);
      break;
    }
    case 47:
      out.push({ code: 90, value: c.curves.length });
      for (const x of c.curves) writeCurve(x, out);
      break;
  }
  return out;
}

/** 곡선 자료 → 조각(평면 XY) */
export function curvePieces(c: CurveData): CachedPiece[] {
  switch (c.type) {
    case 23:
      return [{ k: 'line', a: { x: c.a.x, y: c.a.y }, b: { x: c.a.x + c.v.x, y: c.a.y + c.v.y } }];
    case 11: {
      const { center: cc, normal: n, ref, radius: r, start: s0, end: s1 } = c;
      const rl = Math.hypot(ref.x, ref.y, ref.z) || 1;
      const u = { x: ref.x / rl, y: ref.y / rl };
      // 법선 × 기준 벡터(평면 안의 둘째 축)
      const w = { x: n.y * ref.z - n.z * ref.y, y: n.z * ref.x - n.x * ref.z };
      const wl = Math.hypot(w.x, w.y) || 1;
      const v = { x: w.x / wl, y: w.y / wl };
      const at = (a: number) => ({ x: cc.x + r * (Math.cos(a) * u.x + Math.sin(a) * v.x), y: cc.y + r * (Math.cos(a) * u.y + Math.sin(a) * v.y) });
      const p0 = at(s0);
      const a0 = Math.atan2(p0.y - cc.y, p0.x - cc.x);
      const ccw = u.x * v.y - u.y * v.x >= 0;
      return [{ k: 'arc', c: { x: cc.x, y: cc.y }, r, a0, sw: (s1 - s0) * (ccw ? 1 : -1) }];
    }
    case 42: {
      const ctrl: Vec2[] = c.ctrl.v.map((q) => ({ x: q.x, y: q.y }));
      return [{ k: 'nurbs', degree: c.degree, knots: [...c.knots.v], ctrl, ...(c.weights.v.length ? { weights: [...c.weights.v] } : {}) }];
    }
    case 47:
      return c.curves.flatMap(curvePieces);
  }
}

/**
 * AcGe 곡선 캐시(표본에서 본 종류만): 23 선분, 11 원호, 42 NURBS, 47 복합 곡선. 모르는 종류면 null.
 */
export function readCurve(t: readonly RawTag[], i: number, depth = 0): { pieces: CachedPiece[]; next: number } | null {
  const c = parseCurve(t, i, depth);
  return c ? { pieces: curvePieces(c.curve), next: c.next } : null;
}

// ---------------------------------------------------------------------------
// 조각 → 곡선 자료(새 경로 배열을 AutoCAD 형식으로 쓸 때)
// ---------------------------------------------------------------------------

const X: Vec3 = { x: 1, y: 0, z: 0 };

/**
 * 원호 조각 → 11. 표본의 원호 캐시는 기준 벡터가 늘 X축이고, 반시계 호는 법선 +Z, 시계 호는 법선 −Z다(각도는 법선 둘레로 재므로
 * 시계 호의 각도 = −(XY 각도)). 시작 각도 < 끝 각도.
 */
function arcData(c: Vec2, r: number, a0: number, sw: number, z: number): CurveData {
  const tau = 2 * Math.PI;
  const cw = sw < 0;
  const s = (((cw ? -a0 : a0) % tau) + tau) % tau;
  const full = Math.abs(Math.abs(sw) - tau) < 1e-12;
  return { type: 11, center: { x: c.x, y: c.y, z }, normal: { x: 0, y: 0, z: cw ? -1 : 1 }, ref: { ...X }, radius: r, start: full ? 0 : s, end: full ? tau : s + Math.abs(sw), extra: [0] };
}

/**
 * 조각들(선·원호·NURBS) → 곡선 캐시 자료: 하나면 그 종류, 여럿이거나 composite(폴리선 — 조각이 하나여도 표본은 47)면
 * 47 복합(선·원호만 — 표본에서 본 조각).
 */
export function curveFromPieces(pieces: readonly CachedPiece[], z = 0, composite = false): CurveData | null {
  if (!pieces.length) return null;
  const one = (p: CachedPiece): CurveData | null => {
    if (p.k === 'line') return { type: 23, a: { x: p.a.x, y: p.a.y, z }, v: { x: p.b.x - p.a.x, y: p.b.y - p.a.y, z: 0 } };
    if (p.k === 'arc') return arcData(p.c, p.r, p.a0, p.sw, z);
    const n = p.ctrl.length;
    return {
      type: 42,
      flags: [0, 0],
      degree: p.degree,
      tol: [1e-9],
      knots: { cap: p.knots.length, grow: 8, v: [...p.knots] },
      weights: { cap: p.weights?.length ?? 0, grow: 8, v: p.weights ? [...p.weights] : [] },
      ctrl: { cap: n, grow: 8, v: p.ctrl.map((q) => ({ x: q.x, y: q.y, z })) },
    };
  };
  if (pieces.length === 1 && !composite) return one(pieces[0]!);
  const curves: CurveData[] = [];
  for (const p of pieces) {
    if (p.k === 'nurbs') return null;
    const c = one(p);
    if (!c) return null;
    curves.push(c);
  }
  return { type: 47, curves };
}

/** 조각들을 아핀 변환으로 옮긴다(곡선 캐시는 공간 좌표 — 배열 블록 좌표로 바꿀 때 배열 참조 행렬의 역) */
export function transformPieces(pieces: readonly CachedPiece[], m: Affine): CachedPiece[] {
  const det = m[0] * m[3] - m[1] * m[2];
  const sc = Math.sqrt(Math.abs(det));
  return pieces.map((pc): CachedPiece => {
    if (pc.k === 'line') return { k: 'line', a: affApply(m, pc.a), b: affApply(m, pc.b) };
    if (pc.k === 'arc') {
      const d = affLin(m, { x: Math.cos(pc.a0), y: Math.sin(pc.a0) });
      return { k: 'arc', c: affApply(m, pc.c), r: pc.r * sc, a0: Math.atan2(d.y, d.x), sw: det < 0 ? -pc.sw : pc.sw };
    }
    return { ...pc, ctrl: pc.ctrl.map((q) => affApply(m, q)) };
  });
}

/**
 * 경로 객체 → AutoCAD 곡선 캐시(공간 좌표 — 배열 참조가 거울·이동된 공개 DWG에서도 캐시는 경로 객체의 좌표 그대로였다).
 * 선 23, 원·호 11, 폴리선 47(선·원호 조각), 스플라인 42 — 공개 표본의 경로 배열 70여 개에서 이 앱이 만든 캐시가 AutoCAD 캐시와
 * 같았다(src/edit/assocarray 경로 배열 쓰기). 그 밖의 객체(타원·3D 폴리선·나선 등)는 null.
 */
export function pathCurve(e: Entity): CurveData | null {
  if (e.type === 'LINE') return { type: 23, a: { ...e.start }, v: { x: e.end.x - e.start.x, y: e.end.y - e.start.y, z: e.end.z - e.start.z } };
  if (e.type !== 'ARC' && e.type !== 'CIRCLE' && e.type !== 'LWPOLYLINE' && e.type !== 'SPLINE' && !(e.type === 'POLYLINE' && e.kind === '2d')) return null;
  const ex = (e as { extrusion?: Vec3 }).extrusion;
  if (ex && (Math.abs(ex.x) > 1e-12 || Math.abs(ex.y) > 1e-12 || ex.z <= 0)) return null;
  const path = entityPath(e);
  if (!path?.pieces.length) return null;
  const out: CachedPiece[] = [];
  for (const pc of path.pieces) {
    if (pc.k === 'line') {
      if (pc.inf0 || pc.inf1) return null;
      out.push({ k: 'line', a: { x: pc.a.x, y: pc.a.y }, b: { x: pc.b.x, y: pc.b.y } });
    } else if (pc.k === 'arc') out.push({ k: 'arc', c: { x: pc.c.x, y: pc.c.y }, r: pc.r, a0: pc.a0, sw: pc.sw });
    else if (pc.k === 'nurbs') {
      if (Math.abs(pc.u0 - pc.n.knots[pc.n.degree]!) > 1e-12 || Math.abs(pc.u1 - pc.n.knots[pc.n.knots.length - 1 - pc.n.degree]!) > 1e-12) return null;
      out.push({ k: 'nurbs', degree: pc.n.degree, knots: [...pc.n.knots], ctrl: pc.n.ctrl.map((q) => ({ x: q.x, y: q.y })), ...(pc.n.weights ? { weights: [...pc.n.weights] } : {}) });
    } else return null;
  }
  const z = e.type === 'LWPOLYLINE' ? e.elevation : e.type === 'ARC' || e.type === 'CIRCLE' ? e.center.z : 0;
  return curveFromPieces(out, z, e.type === 'LWPOLYLINE' || e.type === 'POLYLINE');
}
