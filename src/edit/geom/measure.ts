/**
 * DIVIDE·MEASURE: 곡선 위에 같은 길이 간격으로 놓을 자리(점과 접선 각도).
 * - 등분할: n개 구간 → 안쪽 점 n − 1개(닫힌 곡선도 시작점에는 놓지 않는다 — AutoCAD와 같다).
 * - 길이 분할: 찍은 점에 가까운 끝에서 길이만큼씩. 닫힌 곡선은 시작점에서. 반대쪽 끝에는 놓지 않는다.
 * 원은 0° 방향에서, 닫힌 폴리선은 첫 정점에서 시작한다(경로 시작점).
 */
import type { Vec2 } from '../../core/model';
import { type Path, pathAt, pathLength, pathSAtLength, pathTangent, pathStart, pathEnd } from './curve';
import { dist } from './math';

export interface Station {
  p: Vec2;
  /** 경로 진행 방향의 접선 각도(라디안) */
  angle: number;
  /** 시작에서 잰 길이 */
  at: number;
}

function stationAt(path: Path, L: number): Station {
  const s = pathSAtLength(path, L);
  const p = pathAt(path, s);
  const t = pathTangent(path, s);
  return { p, angle: Math.atan2(t.y, t.x), at: L };
}

/** n개 구간으로 나누는 점(n − 1개) */
export function divideStations(path: Path, n: number): Station[] {
  const total = pathLength(path);
  if (!(total > 0) || n < 2) return [];
  const out: Station[] = [];
  for (let k = 1; k < n; k++) out.push(stationAt(path, (total * k) / n));
  return out;
}

/** 길이 seg 간격의 점. fromEnd면 경로 끝에서 거꾸로 잰다 */
export function measureStations(path: Path, seg: number, fromEnd = false, limit = 100000): Station[] {
  const total = pathLength(path);
  if (!(total > 0) || !(seg > 0)) return [];
  const out: Station[] = [];
  const eps = total * 1e-9;
  for (let k = 1; k * seg < total - eps && out.length < limit; k++) {
    const L = fromEnd && !path.closed ? total - k * seg : k * seg;
    out.push(stationAt(path, L));
  }
  return out;
}

/** 찍은 점이 경로 끝에 더 가까운지(길이 분할의 시작 끝) */
export function nearerToEnd(path: Path, q: Vec2): boolean {
  if (path.closed) return false;
  return dist(pathEnd(path), q) < dist(pathStart(path), q);
}
