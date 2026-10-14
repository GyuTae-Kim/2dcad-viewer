/** 스케치(SKETCH): 증분 기록, 점 줄이기, 유형별 객체 */
import { describe, expect, it } from 'vitest';
import { entityDefaults } from '../../src/core/model';
import { type P2, recordPoint, simplify, sketchEntities } from '../../src/edit/sketch';

describe('스케치', () => {
  it('증분보다 가까운 점은 기록하지 않는다', () => {
    const s: P2[] = [];
    expect(recordPoint(s, { x: 0, y: 0 }, 1)).toBe(true);
    expect(recordPoint(s, { x: 0.5, y: 0 }, 1)).toBe(false);
    expect(recordPoint(s, { x: 1.2, y: 0 }, 1)).toBe(true);
    expect(s).toHaveLength(2);
  });

  it('곧은 점열은 두 끝만 남기고, 꺾인 곳은 남긴다', () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0.01 * Math.sin(i) }));
    expect(simplify(line, 0.1)).toHaveLength(2);
    const corner = [...Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0 })), ...Array.from({ length: 10 }, (_, i) => ({ x: 9, y: i + 1 }))];
    const s = simplify(corner, 0.1);
    expect(s).toHaveLength(3);
    expect(s[1]).toEqual({ x: 9, y: 0 });
  });

  it('선은 구간마다, 폴리선·스플라인은 획마다 하나', () => {
    const strokes = [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 1 },
      ],
      [{ x: 5, y: 5 }],
    ];
    const props = entityDefaults();
    expect(sketchEntities(strokes, 'line', props, 0.5).map((e) => e.type)).toEqual(['LINE', 'LINE']);
    const pl = sketchEntities(strokes, 'polyline', props, 0.5);
    expect(pl).toHaveLength(1);
    expect(pl[0]!.type === 'LWPOLYLINE' && pl[0]!.vertices).toHaveLength(3);
    const sp = sketchEntities(strokes, 'spline', props, 0);
    expect(sp[0]!.type === 'SPLINE' && sp[0]!.fitPoints).toHaveLength(3);
  });
});
