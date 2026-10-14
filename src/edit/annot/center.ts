/**
 * 중심 표식(CENTERMARK)·중심선(CENTERLINE)의 선.
 * 설정 기본값(AutoCAD acadiso.dwt와 같은 값): CENTERCROSSSIZE 0.1x(지름의 배수, 십자 전체 길이),
 * CENTERCROSSGAP 0.05x, CENTEREXE 3.5(영국식 0.12), CENTERMARKEXE 1, CENTERLTYPE CENTER2, CENTERLTSCALE 1, CENTERLAYER "."(현재 도면층).
 */

export interface P {
  x: number;
  y: number;
}

export interface CenterSettings {
  /** 숫자 = 길이, "0.1x" = 지름의 배수 */
  crossSize: number | string;
  crossGap: number | string;
  exe: number;
  markExe: boolean;
  ltype: string;
  ltscale: number;
  layer: string;
}

export function defaultCenterSettings(metric: boolean): CenterSettings {
  return { crossSize: '0.1x', crossGap: '0.05x', exe: metric ? 3.5 : 0.12, markExe: true, ltype: 'CENTER2', ltscale: 1, layer: '.' };
}

/** "0.1x" → 0.1 × ref, 숫자는 그대로 */
export function lengthOrMultiple(v: number | string, ref: number): number {
  if (typeof v === 'number') return v;
  const t = v.trim();
  const m = /^(-?[\d.]+(?:e-?\d+)?)\s*x$/i.exec(t);
  if (m) return Number(m[1]) * ref;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 중심 표식: 십자 두 선 + 연장선 넷(markExe이고 호가 240° 이상일 때). sweep = 호의 중심각(원은 2π).
 * rotation = 십자 X축 각도.
 */
export function centerMarkLines(c: P, r: number, sweep: number, s: CenterSettings, rotation = 0): [P, P][] {
  const d = 2 * r;
  const half = Math.max(0, lengthOrMultiple(s.crossSize, d)) / 2;
  const gap = Math.max(0, lengthOrMultiple(s.crossGap, d));
  const ux = { x: Math.cos(rotation), y: Math.sin(rotation) };
  const uy = { x: -ux.y, y: ux.x };
  const at = (u: P, k: number): P => ({ x: c.x + u.x * k, y: c.y + u.y * k });
  const out: [P, P][] = [];
  if (half > 0) {
    out.push([at(ux, -half), at(ux, half)], [at(uy, -half), at(uy, half)]);
  }
  if (s.markExe && sweep >= (240 * Math.PI) / 180 - 1e-9) {
    const from = half + gap;
    const to = r + s.exe;
    if (to > from)
      for (const u of [ux, uy, { x: -ux.x, y: -ux.y }, { x: -uy.x, y: -uy.y }]) out.push([at(u, from), at(u, to)]);
  }
  return out;
}

const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const cross = (a: P, b: P) => a.x * b.y - a.y * b.x;
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: P): P => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};

/**
 * 두 선 사이 중심선. 평행하면 가운데 선(첫 선 방향, 두 선의 대응하는 끝의 가운데끼리),
 * 아니면 두 선이 만나는 점에서 선 쪽으로 각의 이등분선: 가까운 끝끼리 이은 선에서 먼 끝끼리 이은 선까지. 양 끝에 exe만큼 연장.
 */
export function centerLineSegment(l1: [P, P], l2: [P, P], exe: number): [P, P] | null {
  const [a1, b1] = l1;
  const [a2, b2] = l2;
  if (dist(a1, b1) < 1e-12 || dist(a2, b2) < 1e-12) return null;
  const u1 = unit(sub(b1, a1));
  const u2 = unit(sub(b2, a2));
  const den = cross(u1, u2);
  if (Math.abs(den) < 1e-9) {
    // 평행: 첫 선 방향 축 위에서 각 선의 구간 끝끼리 가운데
    const t = (q: P) => dot(sub(q, a1), u1);
    const n = { x: -u1.y, y: u1.x };
    const off = dot(sub(a2, a1), n) / 2;
    if (Math.abs(off) < 1e-12) return null;
    const lo = (Math.min(t(a1), t(b1)) + Math.min(t(a2), t(b2))) / 2;
    const hi = (Math.max(t(a1), t(b1)) + Math.max(t(a2), t(b2))) / 2;
    const P0 = (k: number): P => ({ x: a1.x + u1.x * k + n.x * off, y: a1.y + u1.y * k + n.y * off });
    return [P0(lo - exe), P0(hi + exe)];
  }
  // 교점
  const s = cross(sub(a2, a1), u2) / den;
  const X = { x: a1.x + u1.x * s, y: a1.y + u1.y * s };
  const far1 = dist(a1, X) >= dist(b1, X) ? a1 : b1;
  const near1 = far1 === a1 ? b1 : a1;
  const far2 = dist(a2, X) >= dist(b2, X) ? a2 : b2;
  const near2 = far2 === a2 ? b2 : a2;
  const w = unit({ x: unit(sub(far1, X)).x + unit(sub(far2, X)).x, y: unit(sub(far1, X)).y + unit(sub(far2, X)).y });
  // 이등분선(X + w·k)과 선분 p-q의 교점까지의 k
  const hit = (pp: P, qq: P): number | null => {
    const v = sub(qq, pp);
    const d = cross(w, v);
    if (Math.abs(d) < 1e-14) return null;
    return cross(sub(pp, X), v) / d;
  };
  let k0 = hit(near1, near2);
  let k1 = hit(far1, far2);
  if (k0 === null || k1 === null) return null;
  if (k0 > k1) [k0, k1] = [k1, k0];
  const at = (k: number): P => ({ x: X.x + w.x * k, y: X.y + w.y * k });
  return [at(k0 - exe), at(k1 + exe)];
}
