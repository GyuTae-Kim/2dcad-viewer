import { describe, expect, it } from 'vitest';
import { advance, formatDuration, idRange, moveEndTime, moveStartTime, playbackAt, pointAlong, totalTime } from '../../src/app/view3d/playback';
import { ncTimeline } from '../../src/formats/nc/model';
import { parseGcode } from '../../src/formats/nc/gcode';

// 이동 시간 1, 0(같은 점), 2, 3초 → 끝 시각 1, 1, 3, 6
const TL = new Float64Array([1, 1, 3, 6]);

describe('재생 시간 ↔ 이동 번호', () => {
  it('시작·끝 시각과 전체 시간', () => {
    expect(totalTime(TL)).toBe(6);
    expect(totalTime(new Float64Array())).toBe(0);
    expect(moveStartTime(TL, 0)).toBe(0);
    expect(moveStartTime(TL, 2)).toBe(1);
    expect(moveStartTime(TL, 3)).toBe(3);
    expect(moveEndTime(TL, 3)).toBe(6);
    expect(moveEndTime(TL, 99)).toBe(6);
  });

  it('시각 → 이동과 진행 비율', () => {
    expect(playbackAt(TL, 0)).toEqual({ move: 0, frac: 0 });
    expect(playbackAt(TL, 0.5)).toEqual({ move: 0, frac: 0.5 });
    // 정확히 1초: 이동 0·1이 다 끝났다(1은 시간 0) → 1의 끝
    expect(playbackAt(TL, 1)).toEqual({ move: 1, frac: 1 });
    expect(playbackAt(TL, 2)).toEqual({ move: 2, frac: 0.5 });
    expect(playbackAt(TL, 4.5)).toEqual({ move: 3, frac: 0.5 });
    expect(playbackAt(TL, 6)).toEqual({ move: 3, frac: 1 });
    expect(playbackAt(TL, 99)).toEqual({ move: 3, frac: 1 });
    expect(playbackAt(new Float64Array(), 1)).toEqual({ move: -1, frac: 0 });
  });

  it('맨 앞의 시간 0 이동은 건너뛴다', () => {
    expect(playbackAt(new Float64Array([0, 0, 2]), 0)).toEqual({ move: 2, frac: 0 });
  });

  it('이동 시작 시각으로 가면 그 이동(되돌림)', () => {
    for (let i = 0; i < TL.length; i++) {
      const s = moveStartTime(TL, i);
      const e = moveEndTime(TL, i);
      if (e > s) expect(playbackAt(TL, (s + e) / 2).move).toBe(i);
    }
  });

  it('배속 걸음과 끝', () => {
    expect(advance(0, 500, 10, 60)).toEqual({ sec: 5, done: false });
    expect(advance(58, 1000, 100, 60)).toEqual({ sec: 60, done: true });
    expect(advance(3, -20, 10, 60)).toEqual({ sec: 3, done: false });
  });

  it('실제 G-code 시간표와 맞물린다', () => {
    const p = parseGcode('G21 G90\nG0 X0 Y0 Z0\nG1 X60 F600\nG1 Y60\nG0 Z10\n', { initialPosition: [0, 0, 0] });
    const tl = ncTimeline(p);
    expect(tl.length).toBe(p.moves.count);
    // 60 mm를 600 mm/분 → 6초
    const feedMove = [...p.moves.kind].findIndex((k) => k === 1);
    expect(moveEndTime(tl, feedMove) - moveStartTime(tl, feedMove)).toBeCloseTo(6);
    expect(playbackAt(tl, moveStartTime(tl, feedMove) + 3)).toEqual({ move: feedMove, frac: 0.5 });
  });
});

describe('시간 글·위치', () => {
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0:00.0');
    expect(formatDuration(5.04)).toBe('0:05.0');
    expect(formatDuration(65.25)).toBe('1:05.3');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(-1)).toBe('0:00.0');
    expect(formatDuration(Number.NaN)).toBe('0:00.0');
  });

  it('선분 쌍 위의 길이 비율 위치', () => {
    const seg = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 10, 0]);
    expect(pointAlong(seg, 0)).toEqual([0, 0, 0]);
    expect(pointAlong(seg, 0.25)).toEqual([5, 0, 0]);
    expect(pointAlong(seg, 0.75)).toEqual([10, 5, 0]);
    expect(pointAlong(seg, 1)).toEqual([10, 10, 0]);
    expect(pointAlong(new Float32Array(), 0.5)).toBeNull();
  });

  it('오름차순 번호에서 같은 값 구간', () => {
    const ids = new Uint32Array([0, 1, 1, 1, 4, 7, 7]);
    expect(idRange(ids, 1)).toEqual([1, 4]);
    expect(idRange(ids, 7)).toEqual([5, 7]);
    expect(idRange(ids, 3)).toEqual([4, 4]);
    expect(idRange(ids, 9)).toEqual([7, 7]);
  });
});
