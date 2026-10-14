import { describe, expect, it } from 'vitest';
import { entityPath } from '../../src/edit/geom/path';
import { pathLength } from '../../src/edit/geom/curve';
import { affApply } from '../../src/edit/geom/math';
import { defaultPathSpacing, isIdentity, maxPathItems, orientPath, pathArrayItems, pathStations, type PathArraySpec } from '../../src/edit/arraypath';
import { registerArrayPathCommand } from '../../src/app/arraypath';
import { arc, circle, line, lw } from '../edit/make';
import { makeHarness, modelEntities } from './harness';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const spec = (o: Partial<PathArraySpec>): PathArraySpec => ({ method: 'divide', count: 3, spacing: 1, rows: 1, rowSpacing: 1, align: true, base: { x: 0, y: 0 }, ...o });

describe('경로 배열 항목 자리', () => {
  it('등분할: 열린 경로는 양 끝 포함, 닫힌 경로는 끝이 시작과 겹치지 않는다', () => {
    expect(pathStations(10, false, 'divide', 3, 0)).toEqual([0, 5, 10]);
    expect(pathStations(12, true, 'divide', 4, 0)).toEqual([0, 3, 6, 9]);
    expect(pathStations(10, false, 'divide', 1, 0)).toEqual([0]);
  });

  it('길이 분할: 최대 항목 수를 넘지 않는다', () => {
    expect(maxPathItems(10, false, 2.5)).toBe(5);
    expect(maxPathItems(10, true, 2.5)).toBe(4);
    expect(maxPathItems(10, false, 3)).toBe(4);
    expect(maxPathItems(10, true, 3)).toBe(4);
    expect(pathStations(10, false, 'measure', 99, 3)).toEqual([0, 3, 6, 9]);
    expect(pathStations(10, false, 'measure', 2, 3)).toEqual([0, 3]);
  });

  it('직선 경로: 기준점(경로 시작)에서 항목이 경로를 따라 옮겨 가고 회전하지 않는다', () => {
    const path = entityPath(line(0, 0, 10, 0))!;
    const items = pathArrayItems(path, spec({ count: 3 }));
    expect(items.map((i) => [i.point.x, i.point.y])).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(items.every((i) => Math.abs(i.angle) < 1e-12)).toBe(true);
    expect(isIdentity(items[0]!.matrix)).toBe(true);
    const q = affApply(items[2]!.matrix, { x: 1, y: 2 });
    close(q.x, 11);
    close(q.y, 2);
  });

  it('호 경로 + 항목 정렬: 접선 방향만큼 돌린다(기준 방향 = 시작 접선)', () => {
    // 중심 (0,0) 반지름 10, 0°→90°(반시계): 시작 접선 +Y
    const path = entityPath(arc(0, 0, 10, 0, 90))!;
    const items = pathArrayItems(path, spec({ count: 3, base: { x: 10, y: 0 } }));
    close(items[1]!.point.x, 10 * Math.cos(Math.PI / 4));
    close(items[1]!.point.y, 10 * Math.sin(Math.PI / 4));
    close(items[1]!.angle, Math.PI / 4);
    close(items[2]!.angle, Math.PI / 2);
    // 기준점 바로 옆 점(11,0)은 항목 2에서 (0,11)로
    const q = affApply(items[2]!.matrix, { x: 11, y: 0 });
    close(q.x, 0);
    close(q.y, 11);
    // 정렬하지 않으면 옮기기만
    const flat = pathArrayItems(path, spec({ count: 3, base: { x: 10, y: 0 }, align: false }));
    expect(flat.every((i) => i.angle === 0)).toBe(true);
    const q2 = affApply(flat[2]!.matrix, { x: 11, y: 0 });
    close(q2.x, 1);
    close(q2.y, 10);
  });

  it('접선 방향 지정: 원본의 기준 방향이 경로 접선을 따른다', () => {
    const path = entityPath(line(0, 0, 10, 0))!;
    // 원본의 +Y 방향이 경로 접선(+X)을 따르게 → 모든 항목이 −90° 돈다
    const items = pathArrayItems(path, spec({ count: 2, tangent: Math.PI / 2 }));
    close(items[0]!.angle, -Math.PI / 2);
    expect(isIdentity(items[0]!.matrix)).toBe(false);
  });

  it('행: 경로 진행 방향의 왼쪽으로 행 간격만큼', () => {
    const path = entityPath(line(0, 0, 10, 0))!;
    const items = pathArrayItems(path, spec({ count: 2, rows: 3, rowSpacing: 4 }));
    expect(items.length).toBe(6);
    expect(items.filter((i) => i.row === 2).map((i) => [i.point.x, i.point.y])).toEqual([
      [0, 8],
      [10, 8],
    ]);
  });

  it('닫힌 원 경로 등분할 4: 90°마다, 정렬하면 90°씩 돈다', () => {
    const path = entityPath(circle(0, 0, 5))!;
    close(pathLength(path), 10 * Math.PI);
    const items = pathArrayItems(path, spec({ count: 4, base: { x: 5, y: 0 } }));
    const angles = items.map((i) => Math.atan2(i.point.y, i.point.x));
    close(angles[1]!, Math.PI / 2);
    close(Math.abs(angles[2]!), Math.PI);
    close(items[1]!.angle, Math.PI / 2);
  });

  it('폴리선 경로(직선 + 볼록 호)와 고른 쪽 끝에서 시작', () => {
    const e = lw([
      [0, 0],
      [10, 0, 1],
      [10, 10],
    ]);
    const p = entityPath(e)!;
    const L = pathLength(p);
    close(L, 10 + Math.PI * 5);
    const rev = orientPath(p, { x: 10.2, y: 9.8 });
    const s = pathArrayItems(rev, spec({ count: 2, base: { x: 10, y: 10 } }));
    close(s[0]!.point.x, 10);
    close(s[0]!.point.y, 10);
    close(s[1]!.point.x, 0);
    close(s[1]!.point.y, 0);
  });

  it('처음 항목 사이 거리는 원본 범위의 1.5배', () => {
    expect(defaultPathSpacing(2, 1, 100)).toBe(3);
    expect(defaultPathSpacing(200, 1, 100)).toBe(25);
  });
});

describe('ARRAYPATH 명령', () => {
  it('길이 분할 기본값과 항목(I)·방법(M)·행(R)·연관(AS) 옵션', async () => {
    const h = makeHarness();
    registerArrayPathCommand(h.app);
    const src = h.add(line(-0.5, 0, 0.5, 0));
    const path = h.add(line(0, 0, 20, 0));
    await h.run('ARRAYPATH', [
      { sel: [src.handle] },
      { pick: path.handle, at: [1, 0] },
      'AS',
      'Y',
      'M',
      'D',
      'I',
      '5',
      'R',
      '2',
      '3',
      '',
    ]);
    expect(h.printed).toContain('유형 = 경로  연관 = 아니오');
    expect(h.printed.some((t) => t.includes('연관 배열을 만들지 않습니다'))).toBe(true);
    const lines = modelEntities(h.doc, 'LINE').filter((l) => l.handle !== path.handle);
    // 5 × 2행 = 10 항목(원본 포함)
    expect(lines.length).toBe(10);
    const mids = lines.map((l) => [(l.start.x + l.end.x) / 2, (l.start.y + l.end.y) / 2]).sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!);
    expect(mids.map((m) => m[0])).toEqual([0, 5, 10, 15, 20, 0, 5, 10, 15, 20]);
    expect(mids.slice(5).every((m) => Math.abs(m[1]! - 3) < 1e-9)).toBe(true);
    expect(h.prompts).toContain('그립을 선택하여 배열을 편집하거나 [연관(AS)/방법(M)/기준점(B)/접선 방향(T)/항목(I)/행(R)/레벨(L)/항목 정렬(A)/Z 방향(Z)/종료(X)] <종료>:');
    expect(h.prompts).toContain('경로 방법 입력 [등분할(D)/길이 분할(M)] <길이 분할>:');
    // 한 번의 명령 취소 단계
    expect(h.st.session.canUndo()).toBe(true);
  });

  it('길이 분할: 항목 사이 거리 → 최대 항목 수 안내 → 전체 경로 채우기, 호 경로 정렬', async () => {
    const h = makeHarness();
    registerArrayPathCommand(h.app);
    const src = h.add(line(10, 0, 11, 0));
    const path = h.add(arc(0, 0, 10, 0, 180));
    await h.run('ARRAYPATH', [{ sel: [src.handle] }, { pick: path.handle, at: [10, 0] }, 'I', '10', 'F', 'X']);
    expect(h.printed).toContain('최대 항목 수 = 4');
    const lines = modelEntities(h.doc, 'LINE');
    expect(lines.length).toBe(4);
    // 정렬: 각 항목은 반지름 방향(원본이 반지름 방향 선분)
    for (const l of lines) {
      const a = Math.atan2(l.start.y, l.start.x);
      const b = Math.atan2(l.end.y - l.start.y, l.end.x - l.start.x);
      close(Math.cos(a - b), 1, 1e-6);
      close(Math.hypot(l.start.x, l.start.y), 10, 1e-6);
    }
  });

  it('기준점(B)을 지정하면 원본이 경로 시작으로 옮겨진다', async () => {
    const h = makeHarness();
    registerArrayPathCommand(h.app);
    const src = h.add(circle(5, 5, 1));
    const path = h.add(line(0, 0, 10, 0));
    await h.run('ARRAYPATH', [{ sel: [src.handle] }, { pick: path.handle, at: [0, 0] }, 'B', '5,5', 'M', 'D', 'I', '2', '']);
    const cs = modelEntities(h.doc, 'CIRCLE').map((c) => [c.center.x, c.center.y]).sort((a, b) => a[0]! - b[0]!);
    expect(cs).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('경로로 쓸 수 없는 객체는 다시 묻는다', async () => {
    const h = makeHarness();
    registerArrayPathCommand(h.app);
    const src = h.add(line(0, 0, 1, 0));
    await h.run('ARRAYPATH', [{ sel: [src.handle] }, { pick: 'FFFF', at: [0, 0] }, '']);
    expect(h.printed.some((t) => t.includes('경로로 사용할 수 없습니다'))).toBe(true);
  });
});
