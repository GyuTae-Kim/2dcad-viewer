/**
 * 연관 배열 경로의 곡선 캐시(모서리 동작 매개변수 RowProfile의 AcGe 곡선 태그) 읽기.
 * 공개 DXF 표본에서 본 종류만 푼다(src/edit/assocarray/acad.ts에서 옮겨 왔다 — 동작은 같다).
 */
import type { RawTag, Vec2, Vec3 } from '../../core/model';
import type { CachedPiece } from '../assocarray/types';
import { num } from './tags';

function pt3(t: readonly RawTag[], i: number): Vec3 | null {
  if (t[i]?.code !== 10 || t[i + 1]?.code !== 20 || t[i + 2]?.code !== 30) return null;
  return { x: num(t[i]!.value), y: num(t[i + 1]!.value), z: num(t[i + 2]!.value) };
}

/**
 * AcGe 곡선 캐시(표본에서 본 종류만): 23 선분(10 시작점, 10 방향 벡터), 11 원호(10 중심, 10 법선, 10 기준 벡터,
 * 40 반지름, 40 시작 각도, 40 끝 각도, 40 …), 42 NURBS(차수·매듭·무게·조정점), 47 복합 곡선(90 개수 + 곡선들). 모르는 종류면 null.
 */
export function readCurve(t: readonly RawTag[], i: number, depth = 0): { pieces: CachedPiece[]; next: number } | null {
  if (t[i]?.code !== 90 || depth > 4) return null;
  const type = num(t[i]!.value);
  if (type === 23) {
    const a = pt3(t, i + 1);
    const v = pt3(t, i + 4);
    if (!a || !v) return null;
    return { pieces: [{ k: 'line', a: { x: a.x, y: a.y }, b: { x: a.x + v.x, y: a.y + v.y } }], next: i + 7 };
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
    const [r, s0, s1] = vals as [number, number, number];
    const rl = Math.hypot(ref.x, ref.y, ref.z) || 1;
    const u = { x: ref.x / rl, y: ref.y / rl };
    // 법선 × 기준 벡터(평면 안의 둘째 축)
    const w = { x: n.y * ref.z - n.z * ref.y, y: n.z * ref.x - n.x * ref.z };
    const wl = Math.hypot(w.x, w.y) || 1;
    const v = { x: w.x / wl, y: w.y / wl };
    const at = (a: number) => ({ x: c.x + r * (Math.cos(a) * u.x + Math.sin(a) * v.x), y: c.y + r * (Math.cos(a) * u.y + Math.sin(a) * v.y) });
    const p0 = at(s0);
    const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
    const ccw = u.x * v.y - u.y * v.x >= 0;
    return { pieces: [{ k: 'arc', c: { x: c.x, y: c.y }, r, a0, sw: (s1 - s0) * (ccw ? 1 : -1) }], next: j };
  }
  if (type === 42) {
    // NURBS: 70 플래그…, 90 차수, 40 공차…, 매듭 배열(90 개수, 90 용량, 90 증분 + 40…), 무게 배열(같은 꼴), 조정점 배열(10/20/30…)
    let j = i + 1;
    while (t[j]?.code === 70) j++;
    if (t[j]?.code !== 90) return null;
    const degree = num(t[j++]!.value);
    while (t[j]?.code === 40) j++;
    const head = (): number | null => {
      if (t[j]?.code !== 90 || t[j + 1]?.code !== 90 || t[j + 2]?.code !== 90) return null;
      const n = num(t[j]!.value);
      j += 3;
      return n;
    };
    const nk = head();
    if (nk === null) return null;
    const knots: number[] = [];
    for (let k = 0; k < nk; k++) {
      if (t[j]?.code !== 40) return null;
      knots.push(num(t[j++]!.value));
    }
    const nw = head();
    if (nw === null) return null;
    const weights: number[] = [];
    for (let k = 0; k < nw; k++) {
      if (t[j]?.code !== 40) return null;
      weights.push(num(t[j++]!.value));
    }
    const nc = head();
    if (nc === null) return null;
    const ctrl: Vec2[] = [];
    for (let k = 0; k < nc; k++) {
      const q = pt3(t, j);
      if (!q) return null;
      ctrl.push({ x: q.x, y: q.y });
      j += 3;
    }
    if (degree < 1 || knots.length !== ctrl.length + degree + 1 || (weights.length && weights.length !== ctrl.length)) return null;
    return { pieces: [{ k: 'nurbs', degree, knots, ctrl, ...(weights.length ? { weights } : {}) }], next: j };
  }
  if (type === 47) {
    if (t[i + 1]?.code !== 90) return null;
    const n = num(t[i + 1]!.value);
    const pieces: CachedPiece[] = [];
    let j = i + 2;
    for (let k = 0; k < n; k++) {
      const c = readCurve(t, j, depth + 1);
      if (!c) return null;
      pieces.push(...c.pieces);
      j = c.next;
    }
    return { pieces, next: j };
  }
  return null;
}

