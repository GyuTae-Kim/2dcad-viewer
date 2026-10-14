/**
 * 빠른 지시선(QLEADER): 설정과 지시선(LEADER) 꼭짓점.
 * 여러 줄 문자 주석이고 마지막 세그먼트가 수평에서 15°보다 가파르면 마지막 점 앞에 갈고리선 시작점
 * (마지막 점에서 문자 반대쪽으로 DIMASZ × DIMSCALE)을 넣는다. 걸이 방향(74)은 문자가 오른쪽이면 0, 왼쪽이면 1.
 */

export interface P {
  x: number;
  y: number;
}

export interface QLeaderSettings {
  /** 주석 유형: M 여러 줄 문자, T 공차, B 블록 참조, N 없음 */
  annotation: 'M' | 'T' | 'B' | 'N';
  /** 문자 폭을 묻는다 */
  promptWidth: boolean;
  spline: boolean;
  /** 화살촉 블록 이름('' = 닫고 채움, '_None' = 없음) */
  arrow: string;
  /** 점의 수(0 = 제한 없음) */
  maxPoints: number;
}

export function defaultQLeaderSettings(): QLeaderSettings {
  return { annotation: 'M', promptWidth: true, spline: false, arrow: '', maxPoints: 3 };
}

export function buildLeader(points: readonly P[], opt: { hook: boolean; hookLength: number }): { vertices: P[]; hookDirection: number; hooked: boolean; right: boolean } {
  const vs = points.map((q) => ({ x: q.x, y: q.y }));
  const n = vs.length;
  if (n < 2) return { vertices: vs, hookDirection: 0, hooked: false, right: true };
  const a = vs[n - 2]!;
  const b = vs[n - 1]!;
  const right = b.x >= a.x;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const steep = len > 0 && Math.abs(dx) / len < Math.cos((15 * Math.PI) / 180);
  if (opt.hook && steep && opt.hookLength > 0) {
    const s = right ? -1 : 1;
    vs.splice(n - 1, 0, { x: b.x + s * opt.hookLength, y: b.y });
    return { vertices: vs, hookDirection: right ? 0 : 1, hooked: true, right };
  }
  return { vertices: vs, hookDirection: right ? 0 : 1, hooked: false, right };
}
