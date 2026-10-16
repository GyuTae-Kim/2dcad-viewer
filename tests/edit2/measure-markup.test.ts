import { describe, expect, it } from 'vitest';
import type { LwPolylineEntity, Vec2 } from '../../src/core/model';
import { entityDefaults } from '../../src/core/model';
import { divideStations, measureStations, nearerToEnd } from '../../src/edit/geom/measure';
import { CLOUD_BULGE, cloudPolyline, cloudVertices, makeWipeout, outlineOf, signedArea, wipeoutPolygon } from '../../src/edit/geom/markup';
import { entityPath } from '../../src/edit/geom/path';
import { V, arc, circle, line, lw, near, newDoc, renders } from '../edit/helpers';
import { lwVertices } from '../../src/core/lwpoly';

describe('DIVIDE·MEASURE', () => {
  it('선을 4등분: 안쪽 점 3개', () => {
    const s = divideStations(entityPath(line(0, 0, 100, 0))!, 4);
    expect(s.length).toBe(3);
    near(s[0]!.p, V(25, 0));
    near(s[2]!.p, V(75, 0));
    expect(s[1]!.angle).toBeCloseTo(0);
  });
  it('원을 4등분: 0°부터 반시계로 90°마다(시작점 제외)', () => {
    const s = divideStations(entityPath(circle(0, 0, 10))!, 4);
    expect(s.length).toBe(3);
    near(s[0]!.p, V(0, 10), 1e-6);
    near(s[1]!.p, V(-10, 0), 1e-6);
    expect(s[0]!.angle).toBeCloseTo(Math.PI);
  });
  it('폴리선 길이 분할: 꺾인 곳을 넘어 길이로 잰다', () => {
    const p = entityPath(
      lw([
        [0, 0],
        [10, 0],
        [10, 10],
      ]),
    )!;
    const s = measureStations(p, 4);
    expect(s.map((x) => x.at)).toEqual([4, 8, 12, 16]);
    near(s[2]!.p, V(10, 2));
  });
  it('길이 분할: 찍은 쪽 끝에서 시작', () => {
    const p = entityPath(line(0, 0, 10, 0))!;
    expect(nearerToEnd(p, V(9, 1))).toBe(true);
    const s = measureStations(p, 3, true);
    near(s[0]!.p, V(7, 0));
    near(s[2]!.p, V(1, 0));
    // 정확히 나누어떨어지면 끝에는 놓지 않는다
    expect(measureStations(p, 2.5).length).toBe(3);
  });
  it('호 등분', () => {
    const s = divideStations(entityPath(arc(0, 0, 10, 0, 90))!, 2);
    near(s[0]!.p, V(10 * Math.SQRT1_2, 10 * Math.SQRT1_2), 1e-9);
  });
});

describe('REVCLOUD', () => {
  const rect: Vec2[] = [V(0, 0), V(100, 0), V(100, 50), V(0, 50)];
  it('닫힌 직사각형: 호 길이에 맞춘 정점, 바깥으로 볼록', () => {
    const vs = cloudVertices(rect, true, { minArc: 10, maxArc: 10 });
    expect(vs.length).toBe(30);
    // 반시계 윤곽 → 진행 방향 오른쪽(바깥)으로 볼록 = 볼록도 +
    for (const v of vs) expect(v.bulge).toBeCloseTo(CLOUD_BULGE);
    const rv = cloudVertices([...rect].reverse(), true, { minArc: 10, maxArc: 10 });
    for (const v of rv) expect(v.bulge).toBeCloseTo(-CLOUD_BULGE);
    const inward = cloudVertices(rect, true, { minArc: 10, maxArc: 10, reverse: true });
    for (const v of inward) expect(v.bulge).toBeCloseTo(-CLOUD_BULGE);
  });
  it('최소·최대 호 길이를 번갈아 쓴다', () => {
    const vs = cloudVertices([V(0, 0), V(90, 0)], false, { minArc: 10, maxArc: 20 });
    const d = vs.slice(1).map((v, i) => Math.hypot(v.x - vs[i]!.x, v.y - vs[i]!.y));
    expect(d[0]).toBeCloseTo(10);
    expect(d[1]).toBeCloseTo(20);
    near(vs[vs.length - 1]!, V(90, 0));
  });
  it('컬리그래피: 끝 폭 = 현의 1/10', () => {
    const vs = cloudVertices(rect, true, { minArc: 10, maxArc: 10, calligraphy: true });
    expect(vs[0]!.startWidth).toBe(0);
    expect(vs[0]!.endWidth).toBeCloseTo(1);
  });
  it('원 객체 → 윤곽 → 구름(그려진다)', () => {
    const o = outlineOf(circle(0, 0, 20))!;
    expect(o.closed).toBe(true);
    expect(o.pts.length).toBe(36);
    const c = cloudPolyline({ ...entityDefaults(), handle: '' }, o.pts, true, { minArc: 5, maxArc: 8 }) as LwPolylineEntity;
    expect(c.closed).toBe(true);
    expect(signedArea(lwVertices(c))).toBeGreaterThan(0);
    renders(newDoc(), [c]);
  });
});

describe('WIPEOUT', () => {
  it('다각형 → 단위 사각형 경계, 되돌리면 같은 다각형', () => {
    const poly = [V(10, 10), V(30, 10), V(20, 40)];
    const w = makeWipeout({ ...entityDefaults(), handle: '' }, poly)!;
    expect(w.type).toBe('WIPEOUT');
    near(w.insert, V(10, 10));
    expect(w.uVector.x).toBeCloseTo(20);
    expect(w.vVector.y).toBeCloseTo(30);
    expect(w.clipBoundary.length).toBe(4);
    // 픽셀 좌표(왼쪽 위 원점, y 아래로) — ezdxf set_masking_area와 같은 값
    near(w.clipBoundary[0]!, V(-0.5, 0.5));
    near(w.clipBoundary[2]!, V(0, -0.5));
    const back = wipeoutPolygon(w);
    expect(back.length).toBe(3);
    back.forEach((p, i) => near(p, poly[i]!, 1e-9));
    renders(newDoc(), [w]);
  });
  it('넓이가 없으면 null', () => {
    expect(makeWipeout({ ...entityDefaults(), handle: '' }, [V(0, 0), V(1, 0), V(2, 0)])).toBeNull();
  });
  it('볼록도 폴리선 → 10°마다 현', () => {
    const o = outlineOf(
      lw(
        [
          [0, 0, 1],
          [10, 0, 0],
        ],
        true,
      ),
    )!;
    // 반원(180°) = 18개 + 직선 1개
    expect(o.pts.length).toBe(19);
  });
});
