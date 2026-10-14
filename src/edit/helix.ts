/**
 * 나선(HELIX): 기준 중심·기준 반지름·상단 반지름·회전 수·높이·비틀기 방향으로 AcDbHelix(스플라인 + 나선 정의)를 만든다.
 * 곡선은 4분의 1 바퀴마다 3차 베지어 조각(매듭 겹침 3)이고, 조각 끝의 위치와 접선 방향이 실제 나선과 같다.
 * 접선 길이는 원호 근사 계수(반지름이 같으면 0.5523·r)를 쓴다. 축은 WCS Z, 높이 0이면 평면 나선형이다.
 */
import type { SplineEntity, Vec3 } from '../core/model';

export interface HelixSpec {
  center: Vec3;
  /** 기준 반지름(시작점까지 거리) */
  baseRadius: number;
  topRadius: number;
  /** 시작 각(라디안, 기준 원 위 시작점의 방향) */
  startAngle: number;
  turns: number;
  /** 전체 높이(음수면 아래로) */
  height: number;
  /** 시계 반대 방향 */
  ccw: boolean;
}

/** 4분의 1 바퀴 수(마지막 조각은 남은 만큼) */
function segments(turns: number): number[] {
  const out: number[] = [];
  let t = 0;
  while (t < turns - 1e-9) {
    const n = Math.min(turns, t + 0.25);
    out.push(n);
    t = n;
  }
  return out;
}

/** 매개변수 t(0…turns)의 점과 t에 대한 도함수 */
function at(s: HelixSpec, t: number): { p: Vec3; d: Vec3 } {
  const sg = s.ccw ? 1 : -1;
  const th = s.startAngle + sg * 2 * Math.PI * t;
  const dth = sg * 2 * Math.PI;
  const k = s.turns > 0 ? t / s.turns : 0;
  const r = s.baseRadius + (s.topRadius - s.baseRadius) * k;
  const dr = s.turns > 0 ? (s.topRadius - s.baseRadius) / s.turns : 0;
  const dz = s.turns > 0 ? s.height / s.turns : 0;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  return {
    p: { x: s.center.x + r * c, y: s.center.y + r * sn, z: s.center.z + s.height * k },
    d: { x: dr * c - r * sn * dth, y: dr * sn + r * c * dth, z: dz },
  };
}

/** 조정점·매듭(베지어 조각 잇기) */
export function helixControlPoints(s: HelixSpec): { ctrl: Vec3[]; knots: number[] } {
  const ends = segments(s.turns);
  const ctrl: Vec3[] = [at(s, 0).p];
  const knots = [0, 0, 0, 0];
  let t0 = 0;
  ends.forEach((t1, i) => {
    const a = at(s, t0);
    const b = at(s, t1);
    // 원호 근사 계수: 접선 길이 = (4/3)·tan(Δθ/4) (Δθ/3 대신 — 반지름 오차가 가장 작다)
    const dt = 2 * Math.PI * (t1 - t0);
    const h = dt > 1e-12 ? ((t1 - t0) / 3) * ((4 * Math.tan(dt / 4)) / dt) : (t1 - t0) / 3;
    ctrl.push(
      { x: a.p.x + a.d.x * h, y: a.p.y + a.d.y * h, z: a.p.z + a.d.z * h },
      { x: b.p.x - b.d.x * h, y: b.p.y - b.d.y * h, z: b.p.z - b.d.z * h },
      b.p,
    );
    const last = i === ends.length - 1;
    knots.push(...(last ? [i + 1, i + 1, i + 1, i + 1] : [i + 1, i + 1, i + 1]));
    t0 = t1;
  });
  return { ctrl, knots };
}

/** 나선 객체(공통 특성은 부르는 쪽이 채운다) */
export function helixEntity(s: HelixSpec, props: Omit<SplineEntity, 'type' | 'handle' | 'flags' | 'degree' | 'knots' | 'controlPoints' | 'fitPoints' | 'knotTolerance' | 'controlTolerance' | 'fitTolerance' | 'helix'>): SplineEntity {
  const { ctrl, knots } = helixControlPoints(s);
  const start = at(s, 0).p;
  return {
    ...props,
    type: 'SPLINE',
    handle: '',
    // 높이 0이면 평면
    flags: Math.abs(s.height) < 1e-12 ? 8 : 0,
    degree: 3,
    knots,
    controlPoints: ctrl,
    fitPoints: [],
    knotTolerance: 1e-10,
    controlTolerance: 1e-10,
    fitTolerance: 1e-10,
    helix: {
      axisBase: { ...s.center },
      start,
      axis: { x: 0, y: 0, z: 1 },
      radius: s.baseRadius,
      turns: s.turns,
      turnHeight: s.turns > 0 ? s.height / s.turns : 0,
      ccw: s.ccw,
      // 1 = 회전 수 고정(AutoCAD 기본)
      constrain: 1,
    },
  };
}

/** 미리보기용 평면 투영 꺾은선(x, y 쌍) */
export function helixPreview(s: HelixSpec, perTurn = 48): number[] {
  const n = Math.max(2, Math.ceil(s.turns * perTurn));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const p = at(s, (s.turns * i) / n).p;
    out.push(p.x, p.y);
  }
  return out;
}
