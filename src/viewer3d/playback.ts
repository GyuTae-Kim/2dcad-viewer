/**
 * NC 재생 도우미(순수 함수): 선분 원본 번호(segmentIds, 오름차순)로 앞에서 몇 개를 그릴지 정한다.
 * NC 해석기는 급속·공구별로 선분 묶음을 나누므로, 묶음마다 "이동 번호 ≤ 지금" 인 앞쪽 개수를 구한다.
 */

/** ids[0..n) 가운데 limit 이하인 앞쪽 개수(ids는 오름차순이라고 본다) */
export function countIdsUpTo(ids: ArrayLike<number>, n: number, limit: number): number {
  let lo = 0, hi = Math.min(n, ids.length);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid]! <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 원본 번호가 오름차순인지(아니면 앞에서 자르는 재생이 맞지 않는다) */
export function idsAscending(ids: ArrayLike<number>): boolean {
  for (let i = 1; i < ids.length; i++) if (ids[i]! < ids[i - 1]!) return false;
  return true;
}
