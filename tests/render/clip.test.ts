/** 표시 목록 자르기(XCLIP): 선분·삼각형·글자·반전 */
import { describe, expect, it } from 'vitest';
import { DisplayListBuilder, pointInPolygon } from '../../src/render/displaylist';

const square = [0, 0, 10, 0, 10, 10, 0, 10];

function segs(b: DisplayListBuilder): number[][] {
  // 내부 임시 그림을 읽어 확인한다(시험 전용): segX = [x0, y0, x1, y1, depth]×segN
  const { segX: x, segN } = b as unknown as { segX: ArrayLike<number>; segN: number };
  const out: number[][] = [];
  for (let i = 0; i < segN * 5; i += 5) out.push([x[i]!, x[i + 1]!, x[i + 2]!, x[i + 3]!].map((v) => +v.toFixed(6)));
  return out;
}

describe('표시 목록 자르기', () => {
  it('점 포함(홀짝)', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
  });

  it('선분은 경계 안 조각만 남는다', () => {
    const b = new DisplayListBuilder(() => false);
    b.pushClip(square);
    b.segment(-5, 5, 15, 5, 1);
    b.segment(20, 20, 30, 30, 1);
    b.popClip();
    b.segment(20, 20, 30, 30, 1);
    expect(segs(b)).toEqual([
      [0, 5, 10, 5],
      [20, 20, 30, 30],
    ]);
  });

  it('반전 자르기는 경계 밖만 남긴다', () => {
    const b = new DisplayListBuilder(() => false);
    b.pushClip(square, true);
    b.segment(-5, 5, 15, 5, 1);
    expect(segs(b)).toEqual([
      [-5, 5, 0, 5],
      [10, 5, 15, 5],
    ]);
  });

  it('오목한 경계도 교점마다 나눈다', () => {
    // ㄷ자 경계: 가운데 홈(4~6, 5~10)은 밖
    const u = [0, 0, 10, 0, 10, 10, 6, 10, 6, 5, 4, 5, 4, 10, 0, 10];
    const b = new DisplayListBuilder(() => false);
    b.pushClip(u);
    b.segment(-1, 8, 11, 8, 1);
    expect(segs(b)).toEqual([
      [0, 8, 4, 8],
      [6, 8, 10, 8],
    ]);
  });

  it('볼록 경계의 삼각형은 잘라 다시 나눈다', () => {
    // 삼각형 (-10,0)-(10,0)-(10,20)
    const b = new DisplayListBuilder(() => false);
    b.pushClip(square);
    b.triangle(-10, 0, 10, 0, 10, 20, 1);
    const { triX, triN } = b as unknown as { triX: Float64Array; triN: number };
    const t = triX.subarray(0, triN * 9);
    // 빗변 y = x + 10이 경계 위로 지나가므로 경계 안은 정사각형 전체(넓이 100)
    let area = 0;
    for (let i = 0; i + 8 < t.length + 1; i += 9) area += Math.abs((t[i + 3]! - t[i]!) * (t[i + 7]! - t[i + 1]!) - (t[i + 6]! - t[i]!) * (t[i + 4]! - t[i + 1]!)) / 2;
    expect(area).toBeCloseTo(100, 6);
    // 경계 밖으로 나간 꼭짓점이 없다
    for (let i = 0; i < t.length; i += 3) {
      expect(t[i]!).toBeGreaterThanOrEqual(-1e-9);
      expect(t[i + 1]!).toBeLessThanOrEqual(10 + 1e-9);
    }
  });
});
