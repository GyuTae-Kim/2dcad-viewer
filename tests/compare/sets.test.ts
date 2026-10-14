import { describe, expect, it } from 'vitest';
import { changeSets, cloudArc, cloudOf, compareMargin, setOutlines, unionOutlines } from '../../src/edit/compare/sets';
import type { Box } from '../../src/edit/compare/sets';
import { CLOUD_BULGE, signedArea } from '../../src/edit/geom/markup';

const B = (x0: number, y0: number, x1: number, y1: number): Box => ({ minX: x0, minY: y0, maxX: x1, maxY: y1 });
const EXT = B(0, 0, 1000, 1000);

describe('변경 세트', () => {
  it('가까운 상자는 한 세트, 먼 상자는 따로(위에서 아래 순서)', () => {
    const boxes = [B(10, 10, 20, 20), B(22, 10, 30, 20), B(500, 900, 510, 910), null];
    const sets = changeSets(boxes, EXT, 5);
    expect(sets.length).toBe(2);
    expect(sets[0]!.items).toEqual([2]);
    expect(sets[1]!.items.sort()).toEqual([0, 1]);
    // 세트 범위는 여백만큼 키운 상자들의 합
    expect(sets[1]!.box).toEqual(B(5, 5, 35, 25));
  });

  it('여백이 크면 합쳐진다', () => {
    const boxes = [B(100, 100, 110, 110), B(150, 100, 160, 110)];
    expect(changeSets(boxes, EXT, 2).length).toBe(2);
    expect(changeSets(boxes, EXT, 25).length).toBe(1);
  });

  it('여백과 구름 호 길이', () => {
    expect(compareMargin(1000, 5)).toBe(5);
    expect(compareMargin(1000, 40)).toBe(25);
    expect(cloudArc(1000, 5)).toBe(10);
    expect(cloudArc(1000, 25)).toBe(25);
  });

  it('상자 3만 개도 빠르게', () => {
    const boxes: Box[] = [];
    for (let i = 0; i < 30000; i++) {
      const x = (i % 200) * 5;
      const y = Math.floor(i / 200) * 6;
      boxes.push(B(x, y, x + 1 + (i % 3) * 40, y + 1));
    }
    const t0 = performance.now();
    const sets = changeSets(boxes, EXT, 1);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(sets.reduce((n, s) => n + s.items.length, 0)).toBe(30000);
  });
});

describe('구름 윤곽', () => {
  it('ㄱ자 합집합은 꼭짓점 6개 반시계 고리 하나', () => {
    const loops = unionOutlines([B(0, 0, 10, 2), B(0, 0, 2, 10)]);
    expect(loops.length).toBe(1);
    expect(loops[0]!.length).toBe(6);
    expect(signedArea(loops[0]!)).toBeCloseTo(36);
  });

  it('떨어진 상자는 고리 둘, 가운데가 빈 고리는 바깥만', () => {
    expect(unionOutlines([B(0, 0, 1, 1), B(5, 5, 6, 6)]).length).toBe(2);
    const ring = unionOutlines([B(0, 0, 10, 2), B(0, 8, 10, 10), B(0, 0, 2, 10), B(8, 0, 10, 10)]);
    expect(ring.length).toBe(1);
    expect(signedArea(ring[0]!)).toBeCloseTo(100);
    // 모서리만 닿은 두 상자
    const touch = unionOutlines([B(0, 0, 1, 1), B(1, 1, 2, 2)]);
    expect(touch.length).toBe(2);
  });

  it('직사각형·폴리곤 쉐이프(상자 64개 넘으면 직사각형)', () => {
    const boxes = [B(0, 0, 10, 2), B(0, 0, 2, 10)];
    const set = { box: B(-1, -1, 11, 11), items: [0, 1] };
    expect(setOutlines(set, boxes, 1, 0)[0]!.length).toBe(4);
    expect(setOutlines(set, boxes, 1, 1)[0]!.length).toBe(6);
    const many = Array.from({ length: 70 }, (_, i) => B(i, 0, i + 0.5, 1));
    const big = { box: B(-1, -1, 71, 2), items: many.map((_, i) => i) };
    expect(setOutlines(big, many, 1, 1)[0]!.length).toBe(4);
  });

  it('구름은 110° 호를 바깥으로 볼록하게', () => {
    const vs = cloudOf(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
        { x: 0, y: 50 },
      ],
      10,
    );
    expect(vs.length).toBe(30);
    for (const v of vs) expect(v.bulge).toBeCloseTo(CLOUD_BULGE);
    // 시계 방향 윤곽이면 볼록도 부호가 바뀐다(여전히 바깥으로)
    const cw = cloudOf(
      [
        { x: 0, y: 0 },
        { x: 0, y: 50 },
        { x: 100, y: 50 },
        { x: 100, y: 0 },
      ],
      10,
    );
    expect(cw[0]!.bulge).toBeCloseTo(-CLOUD_BULGE);
  });
});
