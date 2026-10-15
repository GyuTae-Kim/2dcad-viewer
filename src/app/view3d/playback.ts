/**
 * NC 재생 계산(순수 함수): 재생 시각 ↔ 이동 번호, 이동 안에서의 진행 비율, 시간 글.
 * 시간표(timeline)는 ncTimeline이 만든 "이동 i가 끝난 누적 시각(초)" 배열이다.
 */
import { ncMoveAtTime } from '../../formats/nc/model';

export const PLAY_SPEEDS = [1, 10, 100] as const;
export type PlaySpeed = (typeof PLAY_SPEEDS)[number];

/** 전체 시간(초) */
export function totalTime(timeline: Float64Array): number {
  return timeline.length ? timeline[timeline.length - 1]! : 0;
}

/** 이동 i가 시작하는 시각 */
export function moveStartTime(timeline: Float64Array, i: number): number {
  if (i <= 0 || !timeline.length) return 0;
  return timeline[Math.min(i, timeline.length) - 1]!;
}

/** 이동 i가 끝나는 시각 */
export function moveEndTime(timeline: Float64Array, i: number): number {
  if (!timeline.length || i < 0) return 0;
  return timeline[Math.min(i, timeline.length - 1)]!;
}

/**
 * 시각(초) → 하고 있는 이동과 그 안의 진행 비율(0~1).
 * 시간이 0인 이동(급속 속도 0·같은 점)이 이어지면 그 시각에 끝나는 마지막 이동으로 본다.
 */
export function playbackAt(timeline: Float64Array, sec: number): { move: number; frac: number } {
  const n = timeline.length;
  if (!n) return { move: -1, frac: 0 };
  const total = timeline[n - 1]!;
  if (sec >= total) return { move: n - 1, frac: 1 };
  if (sec <= 0) {
    // 맨 앞의 시간 0 이동은 다 끝난 것으로
    let i = 0;
    while (i < n - 1 && timeline[i]! <= 0) i++;
    return { move: i, frac: 0 };
  }
  let i = ncMoveAtTime(timeline, sec);
  // timeline[i] >= sec 인 첫 i. 정확히 끝에 닿았으면 그 이동은 끝난 것
  while (i < n - 1 && timeline[i]! <= sec && timeline[i + 1]! <= sec) i++;
  const s = moveStartTime(timeline, i);
  const e = timeline[i]!;
  const frac = e > s ? Math.max(0, Math.min(1, (sec - s) / (e - s))) : 1;
  return { move: i, frac };
}

/** 재생 한 걸음: 지난 실제 시간(ms) × 배속만큼 나아간 시각. 끝에 닿으면 done */
export function advance(sec: number, dtMs: number, speed: number, total: number): { sec: number; done: boolean } {
  const next = sec + (Math.max(0, dtMs) / 1000) * speed;
  if (next >= total) return { sec: total, done: true };
  return { sec: next, done: false };
}

/** 초 → "1:02:03" / "2:03.4" / "0:05.0" */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
  const ss = s.toFixed(1).padStart(4, '0');
  return `${m}:${ss}`;
}

/** 이동의 점 목록(선분 쌍 xyz…)에서 길이 비율 frac 위치 */
export function pointAlong(seg: ArrayLike<number>, frac: number): [number, number, number] | null {
  const n = Math.floor(seg.length / 6);
  if (!n) return null;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    total += Math.hypot(seg[o + 3]! - seg[o]!, seg[o + 4]! - seg[o + 1]!, seg[o + 5]! - seg[o + 2]!);
  }
  let want = Math.max(0, Math.min(1, frac)) * total;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const len = Math.hypot(seg[o + 3]! - seg[o]!, seg[o + 4]! - seg[o + 1]!, seg[o + 5]! - seg[o + 2]!);
    if (want <= len || i === n - 1) {
      const t = len > 0 ? Math.min(1, want / len) : 1;
      return [seg[o]! + (seg[o + 3]! - seg[o]!) * t, seg[o + 1]! + (seg[o + 4]! - seg[o + 1]!) * t, seg[o + 2]! + (seg[o + 5]! - seg[o + 2]!) * t];
    }
    want -= len;
  }
  return null;
}

/** 오름차순 ids에서 값이 id인 구간 [lo, hi) */
export function idRange(ids: ArrayLike<number>, id: number): [number, number] {
  let lo = 0, hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid]! < id) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  let h2 = ids.length;
  while (end < h2) {
    const mid = (end + h2) >> 1;
    if (ids[mid]! <= id) end = mid + 1;
    else h2 = mid;
  }
  return [lo, end];
}
