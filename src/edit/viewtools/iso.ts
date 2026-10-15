/**
 * 등각투영 제도(ISODRAFT·ISOPLANE, SNAPSTYL 1) 계산(DOM 없음).
 *
 * AutoCAD의 등각 제도는 2D 도면에 30°·90°·150° 축을 실제 길이로 그린다.
 * - 등각평면(SNAPISOPAIR): 0 왼쪽(90°·150°), 1 위(30°·150°), 2 오른쪽(30°·90°)
 * - 등각 격자: 수직 간격 s(스냅 Y 간격)의 점이 30°·150°·90° 방향으로 s마다 놓인다
 * - 등각원: 반지름 r인 원을 그 평면에 그린 타원(장축 r·√(3/2), 단축 r/√2, 비율 1/√3)
 *   장축 방향은 위 0°, 왼쪽 120°, 오른쪽 60°
 */

export interface Vec {
  x: number;
  y: number;
}

/** SNAPISOPAIR: 0 왼쪽, 1 위, 2 오른쪽 */
export type IsoPlane = 0 | 1 | 2;

export const ISO_PLANE_NAMES: readonly string[] = ['왼쪽', '위', '오른쪽'];
/** 명령행 키워드(L·T·R) */
export const ISO_PLANE_KEYS: readonly string[] = ['L', 'T', 'R'];

const DEG = Math.PI / 180;

/** 등각평면의 두 축 각도(라디안, 0~π) */
export function isoAxes(plane: IsoPlane): [number, number] {
  if (plane === 0) return [90 * DEG, 150 * DEG];
  if (plane === 1) return [30 * DEG, 150 * DEG];
  return [30 * DEG, 90 * DEG];
}

/** F5·Ctrl+E의 순환: 왼쪽 → 위 → 오른쪽 → 왼쪽 */
export function nextIsoPlane(p: IsoPlane): IsoPlane {
  return ((p + 1) % 3) as IsoPlane;
}

export function toIsoPlane(v: unknown): IsoPlane {
  const n = Math.round(Number(v));
  return n === 0 || n === 2 ? n : 1;
}

/** 등각 극좌표 추적 각도(30°·90°·150°·210°·270°·330°) */
export function isoPolarAngles(): number[] {
  return [30, 90, 150, 210, 270, 330].map((d) => d * DEG);
}

/** 등각 격자의 두 기본 벡터(30°·150° 방향, 길이 s) */
export function isoLattice(s: number): [Vec, Vec] {
  const c = (Math.sqrt(3) / 2) * s;
  return [
    { x: c, y: s / 2 },
    { x: -c, y: s / 2 },
  ];
}

/**
 * 등각 격자 스냅: 가장 가까운 격자점. base는 스냅 기준점, s는 수직 간격(> 0).
 * 격자점 = base + i·a + j·b (a 30°, b 150°). 점이 든 마름모 칸의 네 꼭짓점 중 가장 가까운 것
 * (삼각 격자에서는 점이 든 정삼각형의 꼭짓점 중 하나가 가장 가깝다).
 */
export function isoSnapPoint(p: Vec, base: Vec, s: number): Vec {
  if (!(s > 0) || !Number.isFinite(s)) return { x: p.x, y: p.y };
  const [a, b] = isoLattice(s);
  const x = p.x - base.x;
  const y = p.y - base.y;
  // x = (i - j)·a.x, y = (i + j)·a.y
  const u = x / a.x;
  const v = y / a.y;
  const fi = (u + v) / 2;
  const fj = (v - u) / 2;
  let best: Vec = { x: p.x, y: p.y };
  let bd = Infinity;
  for (const i of [Math.floor(fi), Math.ceil(fi)])
    for (const j of [Math.floor(fj), Math.ceil(fj)]) {
      const q = { x: base.x + i * a.x + j * b.x, y: base.y + i * a.y + j * b.y };
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd - 1e-18) {
        bd = d;
        best = q;
      }
    }
  return best;
}

/**
 * 등각 직교: 기준점에서 커서 쪽으로, 평면의 두 축 중 커서 방향과 가장 가까운 축에 투영한 점.
 */
export function isoOrthoPoint(base: Vec, p: Vec, plane: IsoPlane): Vec {
  const dx = p.x - base.x;
  const dy = p.y - base.y;
  let best = 0;
  let bu: Vec | null = null;
  for (const a of isoAxes(plane)) {
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const t = dx * u.x + dy * u.y;
    if (!bu || Math.abs(t) > Math.abs(best)) {
      best = t;
      bu = u;
    }
  }
  return { x: base.x + bu!.x * best, y: base.y + bu!.y * best };
}

/** 등각원 장축 각도(라디안): 위 0°, 왼쪽 120°, 오른쪽 60° */
export function isoCircleAngle(plane: IsoPlane): number {
  return plane === 1 ? 0 : plane === 0 ? 120 * DEG : 60 * DEG;
}

/** 등각원 = 타원(장축 벡터, 단축/장축 비율). r은 등각 반지름 */
export function isoCircle(r: number, plane: IsoPlane): { majorAxis: Vec; ratio: number } {
  const a = isoCircleAngle(plane);
  const L = r * Math.sqrt(1.5);
  return { majorAxis: { x: Math.cos(a) * L, y: Math.sin(a) * L }, ratio: 1 / Math.sqrt(3) };
}

/** 등각원 위의 점(매개변수 θ: 평면의 첫 축에서 둘째 축 쪽으로). 평면의 두 축에 r만큼 닿는다 */
export function isoCirclePoint(center: Vec, r: number, plane: IsoPlane, t: number): Vec {
  const [a1, a2] = isoAxes(plane);
  return {
    x: center.x + r * (Math.cos(t) * Math.cos(a1) + Math.sin(t) * Math.cos(a2)),
    y: center.y + r * (Math.cos(t) * Math.sin(a1) + Math.sin(t) * Math.sin(a2)),
  };
}

/** 선분 [x0, y0, x1, y1]을 사각형에 자른다(Liang–Barsky). 밖이면 null */
function clipLine(px: number, py: number, dx: number, dy: number, r: readonly [number, number, number, number]): [number, number, number, number] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  const test = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-15) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!test(-dx, px - r[0]) || !test(dx, r[2] - px) || !test(-dy, py - r[1]) || !test(dy, r[3] - py)) return null;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
  return [px + dx * t0, py + dy * t0, px + dx * t1, py + dy * t1];
}

/**
 * 등각 격자선(30°·150°·수직 세 방향, 격자점을 지난다)을 사각형 안에서. major마다 주 격자선.
 * 선이 maxLines보다 많으면 빈 결과(너무 촘촘).
 */
export function isoGridSegments(rect: readonly [number, number, number, number], base: Vec, s: number, major: number, maxLines = 3000): { minor: number[]; major: number[] } {
  const out = { minor: [] as number[], major: [] as number[] };
  if (!(s > 0) || !(rect[2] > rect[0]) || !(rect[3] > rect[1])) return out;
  const [a, b] = isoLattice(s);
  const families: { dir: Vec; step: Vec }[] = [
    { dir: a, step: b },
    { dir: b, step: a },
    { dir: { x: 0, y: 1 }, step: a },
  ];
  const corners: Vec[] = [
    { x: rect[0], y: rect[1] },
    { x: rect[2], y: rect[1] },
    { x: rect[2], y: rect[3] },
    { x: rect[0], y: rect[3] },
  ];
  const M = Math.max(1, Math.round(major));
  let total = 0;
  const plan: { dir: Vec; step: Vec; k0: number; k1: number }[] = [];
  for (const f of families) {
    const l = Math.hypot(f.dir.x, f.dir.y);
    const n = { x: -f.dir.y / l, y: f.dir.x / l };
    let step = f.step;
    let delta = n.x * step.x + n.y * step.y;
    if (delta < 0) {
      step = { x: -step.x, y: -step.y };
      delta = -delta;
    }
    if (!(delta > 1e-15)) continue;
    const c0 = n.x * base.x + n.y * base.y;
    const cs = corners.map((p) => n.x * p.x + n.y * p.y);
    const k0 = Math.ceil((Math.min(...cs) - c0) / delta);
    const k1 = Math.floor((Math.max(...cs) - c0) / delta);
    total += Math.max(0, k1 - k0 + 1);
    plan.push({ dir: f.dir, step, k0, k1 });
  }
  if (total > maxLines) return out;
  for (const f of plan)
    for (let k = f.k0; k <= f.k1; k++) {
      const seg = clipLine(base.x + k * f.step.x, base.y + k * f.step.y, f.dir.x, f.dir.y, rect);
      if (!seg) continue;
      (M > 1 && k % M === 0 ? out.major : out.minor).push(...seg);
    }
  return out;
}

/** 등각 십자선의 두 방향(화면 그리기용, 라디안) */
export function isoCursorAngles(plane: IsoPlane): [number, number] {
  return isoAxes(plane);
}
