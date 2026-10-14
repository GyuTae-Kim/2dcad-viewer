/**
 * 제도 보조: 극좌표 추적(POLAR), 객체 스냅 추적(OTRACK)
 * 커서가 기준점·획득점에서 나가는 정렬선 가까이(tol 안)에 오면 그 선 위로 붙인다.
 */
import type { Pt } from './view';

export interface TrackLine {
  /** 선이 시작하는 점(기준점·획득점) */
  from: Pt;
  /** 단위 방향 */
  dir: Pt;
}

export interface TrackResult {
  p: Pt;
  lines: TrackLine[];
  tip: string;
}

export interface Acquired {
  p: Pt;
  /** 스냅 종류 이름(끝점·중간점 등) */
  label: string;
}

const deg = (r: number) => {
  let d = (r * 180) / Math.PI;
  d = ((d % 360) + 360) % 360;
  return Math.abs(d - Math.round(d)) < 1e-6 ? String(Math.round(d)) : d.toFixed(1);
};

/** 증분 각도의 배수 방향들(0 ≤ θ < 2π) */
export function polarAngles(inc: number, extra: number[] = []): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.round((2 * Math.PI) / inc));
  for (let i = 0; i < n; i++) out.push(i * inc);
  for (const a of extra) {
    const t = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (!out.some((x) => Math.abs(x - t) < 1e-9)) out.push(t);
  }
  return out;
}

/** 한 점에서 나가는 반직선들 중 커서에 가까운 것 */
function nearestRay(from: Pt, w: Pt, angles: number[], tol: number): { q: Pt; dir: Pt; angle: number; d: number } | null {
  const vx = w.x - from.x;
  const vy = w.y - from.y;
  let best: { q: Pt; dir: Pt; angle: number; d: number } | null = null;
  for (const a of angles) {
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const t = vx * ux + vy * uy;
    if (t <= 0) continue;
    const d = Math.abs(vx * uy - vy * ux);
    if (d <= tol && (!best || d < best.d)) best = { q: { x: from.x + ux * t, y: from.y + uy * t }, dir: { x: ux, y: uy }, angle: a, d };
  }
  return best;
}

/** 극좌표 추적: 기준점에서 증분 각도 방향 */
export function polarTrack(base: Pt, w: Pt, angles: number[], tol: number, fmt: (v: number) => string): TrackResult | null {
  const r = nearestRay(base, w, angles, tol);
  if (!r) return null;
  const len = Math.hypot(r.q.x - base.x, r.q.y - base.y);
  return { p: r.q, lines: [{ from: base, dir: r.dir }], tip: `극좌표: ${fmt(len)} < ${deg(r.angle)}°` };
}

function intersect(a: TrackLine, b: TrackLine): Pt | null {
  const den = a.dir.x * b.dir.y - a.dir.y * b.dir.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b.from.x - a.from.x) * b.dir.y - (b.from.y - a.from.y) * b.dir.x) / den;
  return { x: a.from.x + a.dir.x * t, y: a.from.y + a.dir.y * t };
}

/**
 * 객체 스냅 추적: 획득점(그리고 극좌표가 켜져 있으면 기준점)에서 나가는 정렬선.
 * 두 정렬선이 커서 근처에서 만나면 그 교점.
 */
export function objectTrack(acquired: readonly Acquired[], w: Pt, angles: number[], tol: number, base: Pt | null, baseAngles: number[] | null, fmt: (v: number) => string): TrackResult | null {
  const cands: { line: TrackLine; q: Pt; d: number; label: string; angle: number; from: Pt }[] = [];
  for (const a of acquired) {
    const r = nearestRay(a.p, w, angles, tol);
    if (r) cands.push({ line: { from: a.p, dir: r.dir }, q: r.q, d: r.d, label: a.label, angle: r.angle, from: a.p });
  }
  if (base && baseAngles) {
    const r = nearestRay(base, w, baseAngles, tol);
    if (r) cands.push({ line: { from: base, dir: r.dir }, q: r.q, d: r.d, label: '극좌표', angle: r.angle, from: base });
  }
  if (!cands.length) return null;
  cands.sort((x, y) => x.d - y.d);
  // 두 선의 교점이 커서 근처면 우선
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++) {
      const p = intersect(cands[i]!.line, cands[j]!.line);
      if (p && Math.hypot(p.x - w.x, p.y - w.y) <= tol * 1.5) {
        const A = cands[i]!;
        const B = cands[j]!;
        return { p, lines: [A.line, B.line], tip: `${A.label}: < ${deg(A.angle)}°, ${B.label}: < ${deg(B.angle)}°` };
      }
    }
  const c = cands[0]!;
  const len = Math.hypot(c.q.x - c.from.x, c.q.y - c.from.y);
  return { p: c.q, lines: [c.line], tip: `${c.label}: ${fmt(len)} < ${deg(c.angle)}°` };
}
