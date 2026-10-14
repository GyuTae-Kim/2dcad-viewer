/** 경계 찾기(점 선택·객체 선택)와 연관 해치 다시 만들기 */
import { describe, expect, it } from 'vitest';
import type { Entity, HatchEntity, HatchPath, LineEntity } from '../../src/core/model';
import { boundaryFromEntities, createHatch, detectBoundary, pathsFillPoint, rebuildAssociative } from '../../src/edit/hatch';
import { P, add, arc, area, circle, defineBlock, ellipse, insert, insideHatch, line, lw, newDoc, rect, spline } from './helpers';

const PI = Math.PI;
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThan(tol);
const total = (paths: HatchPath[]) => paths.reduce((s, p) => s + area(p), 0);

describe('점 선택: 섬', () => {
  it('사각형 안 원: 바깥 고리 + 섬, 홀짝으로 원 안은 비운다', () => {
    const doc = newDoc();
    const [r, c] = add(doc, rect(0, 0, 10, 10), circle(5, 5, 2));
    const got = detectBoundary(doc, [r!, c!], { x: 1, y: 1 })!;
    expect(got).toBeTruthy();
    expect(got.paths.length).toBe(2);
    const [outer, island] = got.paths;
    near(area(outer!), 100);
    near(area(island!), -4 * PI, 1e-3);
    expect(outer!.flags & 1).toBe(1);
    expect(outer!.flags & 4).toBe(4);
    expect(island!.flags & 16).toBe(16);
    // 폴리선이 원래 경계 → 폴리선 경로, 원 섬은 볼록도 1 두 마디
    expect(outer!.polyline?.vertices.length).toBe(4);
    expect(island!.polyline?.vertices.map((v) => Math.abs(v.bulge))).toEqual([1, 1].map(() => expect.closeTo(1, 12)));
    expect(got.boundaryHandles.sort()).toEqual([r!.handle, c!.handle].sort());
    expect(outer!.sources).toEqual([r!.handle]);
    expect(insideHatch(got.paths, { x: 1, y: 1 })).toBe(true);
    expect(insideHatch(got.paths, { x: 5, y: 5 })).toBe(false);
  });

  it('원 안을 고르면 원만', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 10, 10), circle(5, 5, 2));
    const got = detectBoundary(doc, list, { x: 5.5, y: 5 })!;
    expect(got.paths.length).toBe(1);
    near(area(got.paths[0]!), 4 * PI, 1e-3);
  });

  it('겹 섬: normal은 모두, outer는 첫 겹만, ignore는 없음', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 20, 20), circle(10, 10, 6), circle(10, 10, 3), circle(10, 10, 1));
    const pick = { x: 1, y: 1 };
    const normal = detectBoundary(doc, list, pick)!;
    expect(normal.paths.length).toBe(4);
    expect(normal.paths.map((p) => p.flags & 16)).toEqual([0, 16, 0, 0]);
    // 사각형과 6 사이 → 칠함, 6과 3 사이 → 비움, 3과 1 사이 → 칠함, 1 안 → 비움
    expect(insideHatch(normal.paths, { x: 10, y: 17 })).toBe(true);
    expect(insideHatch(normal.paths, { x: 10, y: 14.5 })).toBe(false);
    expect(insideHatch(normal.paths, { x: 10, y: 12 })).toBe(true);
    expect(insideHatch(normal.paths, { x: 10, y: 10.5 })).toBe(false);
    const outer = detectBoundary(doc, list, pick, { islands: 'outer' })!;
    expect(outer.paths.length).toBe(2);
    expect(insideHatch(outer.paths, { x: 10, y: 12 })).toBe(false);
    const ignore = detectBoundary(doc, list, pick, { islands: 'ignore' })!;
    expect(ignore.paths.length).toBe(1);
    near(area(ignore.paths[0]!), 400);
  });

  it('문자 상자 섬(플래그 24), ignore면 무시', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 20, 10));
    const box = { handle: 'T1', points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 4 }, { x: 2, y: 4 }] };
    const outside = { handle: 'T2', points: [{ x: 18, y: 8 }, { x: 25, y: 8 }, { x: 25, y: 9 }, { x: 18, y: 9 }] };
    const got = detectBoundary(doc, list, { x: 15, y: 5 }, { textBoxes: [box, outside] })!;
    expect(got.paths.length).toBe(2);
    expect(got.paths[1]!.flags).toBe(24);
    expect(got.paths[1]!.edges!.length).toBe(4);
    expect(got.boundaryHandles).toContain('T1');
    expect(got.boundaryHandles).not.toContain('T2');
    near(total(got.paths), 200 - 12);
    expect(detectBoundary(doc, list, { x: 15, y: 5 }, { textBoxes: [box], islands: 'ignore' })!.paths.length).toBe(1);
  });

  it('바깥 경계에 선으로 붙은 섬은 다리를 떼고 섬 고리로', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 10, 10), circle(5, 5, 2), line(0, 5, 3, 5));
    const got = detectBoundary(doc, list, { x: 8, y: 8 })!;
    expect(got.paths.length).toBe(2);
    near(total(got.paths), 100 - 4 * PI, 1e-3);
  });
});

describe('점 선택: 겹친 도형과 곡선', () => {
  it('겹친 사각형: 고른 칸만', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 10, 10), rect(5, 5, 15, 15));
    near(area(detectBoundary(doc, list, { x: 2, y: 2 })!.paths[0]!), 75);
    near(area(detectBoundary(doc, list, { x: 7, y: 7 })!.paths[0]!), 25);
    near(area(detectBoundary(doc, list, { x: 12, y: 14 })!.paths[0]!), 75);
    expect(detectBoundary(doc, list, { x: 7, y: 7 })!.paths.length).toBe(1);
  });

  it('선으로 쪼갠 사각형(선이 밖으로 삐져나와도)', () => {
    const doc = newDoc();
    const list = add(doc, line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0), line(5, -2, 5, 12));
    const got = detectBoundary(doc, list, { x: 2, y: 5 })!;
    near(area(got.paths[0]!), 50);
    expect(got.boundaryHandles.length).toBe(4);
  });

  it('겹친 원: 렌즈 영역은 두 호', () => {
    const doc = newDoc();
    const list = add(doc, circle(0, 0, 5), circle(6, 0, 5));
    const got = detectBoundary(doc, list, { x: 3, y: 0.3 })!;
    const lens = 2 * 25 * Math.acos(0.6) - 3 * 8;
    near(area(got.paths[0]!), lens, 1e-3);
    const vs = got.paths[0]!.polyline!.vertices;
    expect(vs.length).toBe(2);
    for (const v of vs) expect(Math.abs(v.bulge)).toBeGreaterThan(0.1);
    // 초승달 쪽
    near(area(detectBoundary(doc, list, { x: -2, y: 0 })!.paths[0]!), 25 * PI - lens, 1e-3);
  });

  it('호 경계: 반원(볼록도 1)', () => {
    const doc = newDoc();
    const list = add(doc, line(0, 0, 10, 0), arc(5, 0, 5, 0, 180));
    const got = detectBoundary(doc, list, { x: 5, y: 2 })!;
    near(area(got.paths[0]!), 12.5 * PI, 1e-3);
    const b = got.paths[0]!.polyline!.vertices.map((v) => Math.abs(v.bulge)).sort();
    near(b[1]!, 1, 1e-12);
  });

  it('원에 접한 사각형 모서리 영역', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 10, 10), circle(5, 5, 5));
    const got = detectBoundary(doc, list, { x: 0.5, y: 0.5 })!;
    near(area(got.paths[0]!), (100 - 25 * PI) / 4, 1e-3);
    expect(got.paths.length).toBe(1);
  });

  it('타원 경계는 타원 모서리로 남긴다', () => {
    const doc = newDoc();
    const list = add(doc, ellipse(0, 0, 10, 0, 0.5), line(0, -10, 0, 10));
    const got = detectBoundary(doc, list, { x: 5, y: 0.1 })!;
    const p = got.paths[0]!;
    expect(p.polyline).toBeUndefined();
    expect(p.edges!.map((e) => e.type).sort()).toEqual(['ellipse', 'line']);
    near(area(p), (PI * 50) / 2, 1e-2);
  });

  it('회전한 타원 + 원(교점 다듬기)', () => {
    const doc = newDoc();
    const list = add(doc, ellipse(0, 0, 6, 6, 0.4), circle(0, 0, 5));
    const r = detectBoundary(doc, list, { x: 0, y: 0 })!;
    // 가운데 영역 넓이 = 타원과 원의 공통 부분: 표본 적분과 비교
    let inside = 0;
    const N = 400;
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const x = -9 + (18 * (i + 0.5)) / N;
        const y = -9 + (18 * (j + 0.5)) / N;
        const u = (x + y) / Math.SQRT2 / Math.hypot(6, 6);
        const v = (y - x) / Math.SQRT2 / (Math.hypot(6, 6) * 0.4);
        if (u * u + v * v <= 1 && x * x + y * y <= 25) inside++;
      }
    near(total(r.paths), (inside * 18 * 18) / (N * N), 0.3);
  });

  it('스플라인 경계는 스플라인 모서리(부분 곡선)로', () => {
    const doc = newDoc();
    const s = spline([
      [-2, 0],
      [0, 6],
      [10, 6],
      [12, 0],
    ]);
    const list = add(doc, s, line(-2, 1, 12, 1));
    const got = detectBoundary(doc, list, { x: 5, y: 3 })!;
    const p = got.paths[0]!;
    const types = p.edges!.map((e) => e.type);
    expect(types.sort()).toEqual(['line', 'spline']);
    const sp = p.edges!.find((e) => e.type === 'spline')!;
    if (sp.type !== 'spline') throw new Error();
    expect(sp.knots.length).toBe(sp.controlPoints.length + sp.degree + 1);
    // 넓이: 곡선 아래 넓이(y > 1)를 숫자로
    const pts: [number, number][] = [];
    for (let i = 0; i <= 2000; i++) {
      const t = i / 2000;
      const b = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      pts.push([-2 * b[0]! + 0 * b[1]! + 10 * b[2]! + 12 * b[3]!, 6 * b[1]! + 6 * b[2]!]);
    }
    let A = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      A += (x1 - x0) * (Math.max(0, y0 - 1) + Math.max(0, y1 - 1)) / 2;
    }
    near(area(p), A, 0.05);
  });

  it('블록 참조 안 객체(축척·회전 적용), 경계 핸들은 블록 참조', () => {
    const doc = newDoc();
    defineBlock(doc, 'B1', [rect(0, 0, 1, 1), circle(0.5, 0.5, 0.25)]);
    const ins = insert('B1', 10, 10, 4, 4, 30);
    add(doc, ins);
    const got = detectBoundary(doc, [ins], { x: 10.3, y: 10.8 })!;
    expect(got.paths.length).toBe(2);
    near(total(got.paths), 16 - 16 * PI * 0.0625, 1e-3);
    expect(got.boundaryHandles).toEqual([ins.handle]);
    // 비균일 축척이면 원은 타원 경계
    const ins2 = insert('B1', 0, 0, 4, 2, 0);
    add(doc, ins2);
    const g2 = detectBoundary(doc, [ins2], { x: 0.2, y: 0.2 })!;
    expect(g2.paths[1]!.edges!.some((e) => e.type === 'ellipse')).toBe(true);
    near(total(g2.paths), 8 - PI * 1 * 0.5, 1e-3);
  });

  it('OCS가 뒤집힌 원(extrusion −Z)', () => {
    const doc = newDoc();
    const list = add(doc, rect(-10, 0, 0, 10), circle(5, 5, 2, P(0, 0, -1)));
    const got = detectBoundary(doc, list, { x: -9, y: 1 })!;
    expect(got.paths.length).toBe(2);
    near(total(got.paths), 100 - 4 * PI, 1e-3);
  });
});

describe('점 선택: 틈과 열린 영역', () => {
  const gapped = () => {
    const doc = newDoc();
    const list = add(doc, line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0.1));
    return { doc, list };
  };

  it('틈이 있으면 열린 영역 → null', () => {
    const { doc, list } = gapped();
    expect(detectBoundary(doc, list, { x: 5, y: 5 })).toBeNull();
  });

  it('틈 허용이면 이어 붙인다', () => {
    const { doc, list } = gapped();
    const got = detectBoundary(doc, list, { x: 5, y: 5 }, { gapTolerance: 0.2 })!;
    expect(got).toBeTruthy();
    expect(got.bridged).toBe(true);
    near(area(got.paths[0]!), 100, 1e-9);
    // 틈이 없으면 틈 허용을 줘도 이어 붙인 곳이 없다
    const d3 = newDoc();
    expect(detectBoundary(d3, add(d3, rect(0, 0, 4, 4)), { x: 1, y: 1 }, { gapTolerance: 0.5 })!.bridged).toBe(false);
    // 끝점이 선 옆에 못 미친 경우(T자)
    const doc2 = newDoc();
    const l2 = add(doc2, line(0, 0, 10, 0), line(10, -1, 10, 11), line(0, 10, 9.95, 10), line(0, 10, 0, 0));
    expect(detectBoundary(doc2, l2, { x: 5, y: 5 })).toBeNull();
    near(area(detectBoundary(doc2, l2, { x: 5, y: 5 }, { gapTolerance: 0.1 })!.paths[0]!), 100, 1e-9);
  });

  it('바깥이나 U자 안은 null, 경계 위도 null', () => {
    const doc = newDoc();
    const list = add(doc, rect(0, 0, 10, 10), line(20, 0, 20, 10), line(20, 0, 30, 0), line(30, 0, 30, 10));
    expect(detectBoundary(doc, list, { x: -5, y: 5 })).toBeNull();
    expect(detectBoundary(doc, list, { x: 25, y: 5 })).toBeNull();
    expect(detectBoundary(doc, list, { x: 10, y: 5 })).toBeNull();
    expect(detectBoundary(doc, [], { x: 0, y: 0 })).toBeNull();
  });

  it('무한선 네 개로 만든 영역', () => {
    const doc = newDoc();
    const xl = (x: number, y: number, dx: number, dy: number): Entity => ({ ...line(0, 0, 1, 1), type: 'XLINE', base: P(x, y), direction: P(dx, dy) }) as unknown as Entity;
    const list = add(doc, xl(0, 0, 1, 0), xl(0, 4, 1, 0), xl(0, 0, 0, 1), xl(3, 0, 0, 1));
    near(area(detectBoundary(doc, list, { x: 1, y: 1 })!.paths[0]!), 12);
  });
});

describe('객체 선택', () => {
  it('닫힌 객체 → 원래 곡선 종류, 겹 깊이로 플래그', () => {
    const doc = newDoc();
    const [r, c, e] = add(doc, rect(0, 0, 20, 20), circle(5, 5, 2), ellipse(14, 14, 4, 0, 0.5));
    const paths = boundaryFromEntities(doc, [c!, r!, e!]);
    expect(paths.length).toBe(3);
    expect(paths[0]!.flags).toBe(1 | 2);
    expect(paths[0]!.polyline!.vertices.length).toBe(4);
    expect(paths[0]!.sources).toEqual([r!.handle]);
    const circ = paths.find((p) => p.sources![0] === c!.handle)!;
    expect(circ.flags & 16).toBe(16);
    expect(circ.edges).toEqual([expect.objectContaining({ type: 'arc', radius: 2, startAngle: 0, endAngle: 2 * PI })]);
    const ell = paths.find((p) => p.sources![0] === e!.handle)!;
    expect(ell.edges![0]!.type).toBe('ellipse');
    near(total(paths), 400 - 4 * PI - 8 * PI, 1e-3);
  });

  it('선 네 개(열린 객체들)를 이어 고리 하나', () => {
    const doc = newDoc();
    const list = add(doc, line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0));
    const paths = boundaryFromEntities(doc, list);
    expect(paths.length).toBe(1);
    near(area(paths[0]!), 100);
    expect(paths[0]!.sources!.length).toBe(4);
  });

  it('닫힌 스플라인·볼록도 폴리선', () => {
    const doc = newDoc();
    const pl = lw(
      [
        [0, 0, 1],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      true,
    );
    add(doc, pl);
    const [p] = boundaryFromEntities(doc, [pl]);
    near(area(p!), 100 + (PI * 25) / 2, 1e-3); // 아래로 볼록(시계 방향 진행에서 bulge 1 → 바깥쪽)
  });
});

describe('연관 해치 다시 만들기', () => {
  it('경계 선을 옮기면 넓이가 따라간다', () => {
    const doc = newDoc();
    // 모서리에서 조금씩 삐져나온 선 네 개(# 모양)
    const list = add(doc, line(-1, 0, 11, 0), line(10, -1, 10, 11), line(11, 10, -1, 10), line(0, 11, 0, -1), circle(5, 5, 2));
    const got = detectBoundary(doc, list, { x: 1, y: 1 })!;
    const h = createHatch(doc, got.paths, { pattern: 'ANSI31', seedPoints: [{ x: 1, y: 1 }] });
    expect(h.associative).toBe(true);
    // 오른쪽 선을 x = 10.5로, 섬 원을 옮긴다
    const right = list[1] as LineEntity;
    const moved: Entity[] = [{ ...right, start: P(10.5, -1), end: P(10.5, 11) }, { ...(list[4] as Entity), center: P(6, 6, 0) } as Entity];
    const all = list.map((e) => moved.find((m) => m.handle === e.handle) ?? e);
    const r = rebuildAssociative(doc, h, all)!;
    expect(r).toBeTruthy();
    near(total(r.paths), 105 - 4 * PI, 1e-3);
    // 가로선 끝(11)을 넘어가면 영역이 열려 연관이 깨진다
    const broken = list.map((e) => (e.handle === right.handle ? ({ ...right, start: P(12, -1), end: P(12, 11) } as Entity) : e));
    expect(rebuildAssociative(doc, h, broken)).toBeNull();
    expect(r.patternLines).toEqual(h.patternLines);
    expect(r.paths[0]!.sources).toEqual(h.paths[0]!.sources);
    expect(insideHatch(r.paths, { x: 6, y: 6 })).toBe(false);
  });

  it('객체 선택 경계(원)는 그 객체로 다시', () => {
    const doc = newDoc();
    const [c] = add(doc, circle(0, 0, 3));
    const h = createHatch(doc, boundaryFromEntities(doc, [c!]), { pattern: 'SOLID' });
    const r = rebuildAssociative(doc, h, [{ ...(c as Entity), radius: 4 } as Entity])!;
    near(area(r.paths[0]!), 16 * PI, 1e-3);
  });

  it('경계 객체가 없으면 null', () => {
    const doc = newDoc();
    const [c] = add(doc, circle(0, 0, 3));
    const h: HatchEntity = createHatch(doc, boundaryFromEntities(doc, [c!]), { pattern: 'SOLID' });
    doc.entityIndex.delete(c!.handle);
    expect(rebuildAssociative(doc, h, [])).toBeNull();
  });
});

describe('무작위 도형(자기 일관성)', () => {
  it('선택점은 결과 안에 있고, 결과 안 다른 점으로 다시 찾으면 같은 넓이', () => {
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const doc = newDoc();
    let found = 0;
    for (let trial = 0; trial < 12; trial++) {
      const list: Entity[] = [];
      for (let k = 0; k < 10; k++) {
        const x = rnd() * 80;
        const y = rnd() * 80;
        const s = 5 + rnd() * 30;
        const kind = Math.floor(rnd() * 6);
        if (kind === 0) list.push(rect(x, y, x + s, y + s * (0.3 + rnd())));
        else if (kind === 1) list.push(circle(x, y, s / 2));
        else if (kind === 2) list.push(line(x, y, x + s * (rnd() - 0.5) * 3, y + s * (rnd() - 0.5) * 3));
        else if (kind === 3) list.push(arc(x, y, s / 2, rnd() * 360, rnd() * 360));
        else if (kind === 4) list.push(ellipse(x, y, (s / 2) * Math.cos(rnd() * 3), (s / 2) * Math.sin(rnd() * 3), 0.3 + rnd() * 0.6));
        else
          list.push(
            lw(
              [
                [x, y, rnd() - 0.5],
                [x + s, y, 0],
                [x + s, y + s, rnd() - 0.5],
                [x, y + s * 0.6, 0],
              ],
              true,
            ),
          );
      }
      for (let p = 0; p < 10; p++) {
        const pick = { x: rnd() * 100 - 5, y: rnd() * 100 - 5 };
        const r = detectBoundary(doc, list, pick);
        if (!r) continue;
        found++;
        expect(insideHatch(r.paths, pick)).toBe(true);
        const q = pathsFillPoint(r.paths)!;
        expect(q).toBeTruthy();
        const r2 = detectBoundary(doc, list, q)!;
        expect(r2).toBeTruthy();
        near(total(r2.paths), total(r.paths), 1e-3 * Math.max(1, Math.abs(total(r.paths))));
      }
    }
    expect(found).toBeGreaterThan(10);
  });
});
