/** PLOTSTAMP: 스탬프 문자열, 위치(구석·방향·간격띄우기), 글자 모양 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STAMP, type PlotStampSettings, normalizeStamp, plotStampLines, stampDate, stampGeometry } from '../../src/edit/filecmds/stamp';
import { strokeFace } from '../../src/text/fonts';

const info = { drawing: 'Plan.dwg', layout: '배치1', date: new Date(2026, 9, 15, 9, 5, 7), device: 'DWG To PDF.pc3', paper: 'ISO A3', scale: '1:100' };
const set = (over: Partial<PlotStampSettings>): PlotStampSettings => ({ ...DEFAULT_STAMP, on: true, ...over });
const glyph = (c: number) => strokeFace.glyph(c);

describe('플롯 스탬프 문자열', () => {
  it('날짜 형식', () => {
    expect(stampDate(info.date)).toBe('2026-10-15 09:05:07');
  });

  it('한 줄: 고른 필드를 쉼표로', () => {
    expect(plotStampLines(set({}), info)).toEqual(['Plan.dwg, 배치1, 2026-10-15 09:05:07, DWG To PDF.pc3']);
    expect(plotStampLines(set({ paper: true, scale: true, login: true, loginName: 'kim', custom1: ' 검토용 ' }), info)).toEqual(['Plan.dwg, 배치1, 2026-10-15 09:05:07, kim, DWG To PDF.pc3, ISO A3, 1:100, 검토용']);
  });

  it('두 줄: 도면·배치·날짜 / 장치·용지·축척·사용자 필드', () => {
    expect(plotStampLines(set({ singleLine: false, scale: true }), info)).toEqual(['Plan.dwg, 배치1, 2026-10-15 09:05:07', 'DWG To PDF.pc3, 1:100']);
    expect(plotStampLines(set({ drawing: false, layout: false, date: false, device: false }), info)).toEqual([]);
  });

  it('저장한 값 다듬기', () => {
    const s = normalizeStamp({ on: true, height: -1, location: 'XX', offsetX: 'a', custom1: 'x' });
    expect(s.on).toBe(true);
    expect(s.height).toBe(DEFAULT_STAMP.height);
    expect(s.location).toBe('BL');
    expect(s.offsetX).toBe(DEFAULT_STAMP.offsetX);
    expect(s.custom1).toBe('x');
    expect(normalizeStamp(null)).toEqual(DEFAULT_STAMP);
  });
});

describe('플롯 스탬프 위치', () => {
  const paper = { w: 420, h: 297 };
  const inset: [number, number, number, number] = [5, 6, 7, 8];

  it('왼쪽 아래: 인쇄 가능 영역 + 간격띄우기, 글자는 상자 안', () => {
    const g = stampGeometry(set({ offsetX: 2, offsetY: 3 }), ['AB'], paper, inset, glyph);
    expect(g.box[0]).toBeCloseTo(7);
    expect(g.box[3]).toBeCloseTo(297 - 8 - 3);
    expect(g.segs.length).toBeGreaterThan(0);
    for (let i = 0; i < g.segs.length; i += 2) {
      expect(g.segs[i]!).toBeGreaterThanOrEqual(g.box[0] - 1e-6);
      expect(g.segs[i]!).toBeLessThanOrEqual(g.box[2] + 1e-6);
      expect(g.segs[i + 1]!).toBeGreaterThanOrEqual(g.box[1] - 1e-6);
      expect(g.segs[i + 1]!).toBeLessThanOrEqual(g.box[3] + 1e-6);
    }
  });

  it('오른쪽 위, 용지 경계 기준', () => {
    const g = stampGeometry(set({ location: 'TR', relative: 'border', offsetX: 2, offsetY: 3 }), ['AB'], paper, inset, glyph);
    expect(g.box[2]).toBeCloseTo(418);
    expect(g.box[1]).toBeCloseTo(3);
  });

  it('세로: 아래에서 위로 쓰고, 줄은 오른쪽으로 쌓인다', () => {
    const s = set({ orientation: 'V', relative: 'border', offsetX: 0, offsetY: 0, height: 2 });
    const one = stampGeometry(s, ['HH'], paper, inset, glyph);
    const w = one.box[2] - one.box[0];
    const len = one.box[3] - one.box[1];
    expect(len).toBeGreaterThan(w);
    // 글자 진행 방향이 위(y 감소)
    const ys = one.segs.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(297 + 1e-6);
    const two = stampGeometry(s, ['HH', 'HH'], paper, inset, glyph);
    expect(two.box[2] - two.box[0]).toBeGreaterThan(w);
  });
});
