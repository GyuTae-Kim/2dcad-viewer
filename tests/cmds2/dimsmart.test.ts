import { describe, expect, it } from 'vitest';
import type { DimensionEntity } from '../../src/core/model';
import { createAngularDimension, createLinearDimension, createOrdinateDimension } from '../../src/edit/dim';
import { alignDimensions, defaultSmartKind, distributeEqual, hoverDimLinePoint, linearChoice, parallelLines, smartTarget } from '../../src/edit/dim/smart';
import { DIM_MAIN_PROMPT, registerDimSmartCommand } from '../../src/app/dimsmart';
import { arc, circle, line, lw, newDoc } from '../edit/make';
import { makeHarness, modelEntities } from './harness';

const P = (x: number, y: number) => ({ x, y, z: 0 });
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('DIM 종류 추정', () => {
  it('선 → 선형/정렬, 원 → 지름, 호 → 반지름', () => {
    const t1 = smartTarget(line(0, 0, 10, 0), { x: 5, y: 0 })!;
    expect(t1.kind).toBe('line');
    expect(defaultSmartKind(t1)).toBe('linear');
    expect(defaultSmartKind(smartTarget(circle(0, 0, 5), { x: 5, y: 0 })!)).toBe('diameter');
    expect(defaultSmartKind(smartTarget(arc(0, 0, 5, 0, 90), { x: 5, y: 0 })!)).toBe('radius');
    expect(smartTarget(undefined, { x: 0, y: 0 })).toBeNull();
  });

  it('폴리선: 가까운 세그먼트(직선 → 선, 볼록 → 호)', () => {
    const e = lw([
      [0, 0],
      [10, 0, 1],
      [10, 10],
    ]);
    const a = smartTarget(e, { x: 4, y: 0.1 })!;
    expect(a).toMatchObject({ kind: 'line', segment: 0, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    const b = smartTarget(e, { x: 15.1, y: 5 })!;
    expect(b.kind).toBe('arc');
    if (b.kind === 'arc') {
      close(b.c.x, 10);
      close(b.c.y, 5);
      close(b.r, 5);
      expect(b.segment).toBe(1);
    }
  });

  it('선형/정렬: 수평·수직 선분은 그 방향, 기울어진 선분은 수직 띠 안이면 정렬', () => {
    expect(linearChoice({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 4 })).toEqual({ aligned: false, rotation: 0 });
    expect(linearChoice({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 4, y: 30 })).toEqual({ aligned: false, rotation: Math.PI / 2 });
    expect(linearChoice({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 2, y: 8 })).toEqual({ aligned: true });
    // 띠 밖: X 범위 밖으로 더 벗어나면 수직, Y 범위 밖이면 수평
    expect(linearChoice({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 5 })).toEqual({ aligned: false, rotation: Math.PI / 2 });
    expect(linearChoice({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 20 })).toEqual({ aligned: false, rotation: 0 });
  });

  it('미리보기 치수선은 커서 쪽으로 띄운다', () => {
    expect(hoverDimLinePoint({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: -0.1 }, 2)).toEqual({ x: 5, y: -2 });
    expect(hoverDimLinePoint({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 0.1 }, 2)).toEqual({ x: 5, y: 2 });
    expect(parallelLines({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 5 }, { x: 3, y: 5 })).toBe(true);
  });
});

describe('DIM 정렬(G)·분산(D) 계산', () => {
  const doc = newDoc();
  const lin = (y: number, h: string) => ({ ...createLinearDimension(doc, P(0, 0), P(10, 0), P(5, y), { rotation: 0 }), handle: h });

  it('나란한 선형 치수의 치수선을 기준 치수선에 맞춘다', () => {
    const base = lin(5, 'A');
    const r = alignDimensions(base, [lin(8, 'B'), lin(2, 'C'), { ...createLinearDimension(doc, P(0, 0), P(0, 10), P(5, 5), { rotation: Math.PI / 2 }), handle: 'D' }]);
    expect(r.changed.map((d) => d.handle)).toEqual(['B', 'C']);
    for (const d of r.changed) close(d.defPoint.y, 5);
    expect(r.skipped.map((d) => d.handle)).toEqual(['D']);
  });

  it('같은 꼭짓점의 각도 치수는 호 반지름, 같은 데이텀 세로좌표는 지시선 끝', () => {
    const a1 = { ...createAngularDimension(doc, P(0, 0), P(10, 0), P(0, 10), P(3, 3)), handle: 'A' };
    const a2 = { ...createAngularDimension(doc, P(0, 0), P(10, 0), P(0, 10), P(6, 6)), handle: 'B' };
    const r = alignDimensions(a1, [a2]);
    close(Math.hypot(r.changed[0]!.defPoint.x, r.changed[0]!.defPoint.y), Math.hypot(3, 3));
    const o1 = { ...createOrdinateDimension(doc, P(1, 0), P(1, 5), { xAxis: true }), handle: 'O1' };
    const o2 = { ...createOrdinateDimension(doc, P(4, 0), P(4, 9), { xAxis: true }), handle: 'O2' };
    const o3 = { ...createOrdinateDimension(doc, P(4, 0), P(9, 0), { xAxis: false }), handle: 'O3' };
    const r2 = alignDimensions(o1, [o2, o3]);
    expect(r2.changed[0]!.defPoint3.y).toBe(5);
    expect(r2.skipped.map((d) => d.handle)).toEqual(['O3']);
  });

  it('분산 › 동일: 양 끝 사이에 고르게(3개 이상)', () => {
    const r = distributeEqual([lin(5, 'A'), lin(6, 'B'), lin(20, 'C'), lin(11, 'D')]);
    expect(r.count).toBe(4);
    const ys = r.changed.map((d) => [d.handle, +d.defPoint.y.toFixed(9)]);
    expect(ys).toEqual([
      ['B', 10],
      ['D', 15],
    ]);
    expect(distributeEqual([lin(1, 'A'), lin(2, 'B')]).count).toBe(2);
  });
});

describe('DIM 명령', () => {
  const dims = (h: ReturnType<typeof makeHarness>) => modelEntities(h.doc, 'DIMENSION') as DimensionEntity[];

  it('두 점 → 자동 수평, 문자(T)·문자 각도(N), Enter까지 이어진다', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['0,0', '10,0', 'T', 'ABC', 'N', '30', '5,5', '0,0', '0,8', '6,4', '']);
    const ds = dims(h);
    expect(ds.length).toBe(2);
    expect(ds[0]!.dimType & 7).toBe(0);
    close(ds[0]!.measurement, 10);
    expect(ds[0]!.text).toBe('ABC');
    close(ds[0]!.textRotation, Math.PI / 6);
    close(ds[1]!.rotation, Math.PI / 2);
    close(ds[1]!.measurement, 8);
    expect(h.prompts[0]).toBe(DIM_MAIN_PROMPT);
    expect(h.prompts).toContain('치수선 위치 지정 또는 [여러 줄 문자(M)/문자(T)/문자 각도(N)/명령 취소(U)]:');
  });

  it('선을 고르면 선형/정렬, 다른 선을 누르면 두 선의 각도', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    const l1 = h.add(line(0, 0, 10, 10));
    const l2 = h.add(line(20, 0, 30, 0));
    const l3 = h.add(line(20, 0, 20, 10));
    await h.run('DIM', [{ click: [5, 5] }, { click: [2, 8] }, { click: [25, 0] }, { click: [20, 5] }, { click: [23, 3] }, '']);
    const ds = dims(h);
    expect(ds.length).toBe(2);
    expect(ds[0]!.dimType & 7).toBe(1);
    close(ds[0]!.measurement, Math.hypot(10, 10));
    expect(ds[1]!.dimType & 7).toBe(2);
    close(ds[1]!.measurement, Math.PI / 2);
    // 미리보기: 선 위(객체 + 치수), 빈 곳(치수), 두 번째 선 위(각도)
    expect(h.ghostSizes.every((n) => n > 0)).toBe(true);
    expect(h.prompts).toContain('치수선 위치 지정 또는 각도에 대한 두 번째 선 지정 [여러 줄 문자(M)/문자(T)/문자 각도(N)/명령 취소(U)]:');
    expect(h.prompts).toContain('각도 치수 위치 지정 또는 [여러 줄 문자(M)/문자(T)/문자 각도(N)/명령 취소(U)]:');
    void l1;
    void l2;
    void l3;
  });

  it('끝점 스냅 표지에서 누르면 객체가 아니라 첫 번째 원점', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    h.add(line(0, 0, 10, 0));
    await h.run('DIM', [{ click: [0, 0], snap: 'end' }, '10,0', '5,5', '']);
    // 스냅 표지가 있으면 객체 미리보기를 하지 않는다
    expect(h.ghostSizes[0]).toBe(0);
    const ds = dims(h);
    expect(ds.length).toBe(1);
    close(ds[0]!.measurement, 10);
  });

  it('원은 지름, 반지름(R)으로 바꾸기, 호는 반지름·호 길이(L)', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    h.add(circle(0, 0, 5));
    h.add(arc(30, 0, 10, 0, 90));
    await h.run('DIM', [{ click: [5, 0] }, { click: [8, 3] }, { click: [-5, 0] }, 'R', { click: [-8, 0] }, { click: [40, 0] }, 'L', { click: [45, 10] }, '']);
    const ds = dims(h);
    expect(ds.map((d) => d.dimType & 7)).toEqual([3, 4, 5]);
    close(ds[0]!.measurement, 10);
    close(ds[1]!.measurement, 5);
    expect(ds[2]!.subtype).toBe('ARC_DIMENSION');
    close(ds[2]!.measurement, (Math.PI / 2) * 10);
    expect(h.prompts).toContain('지름 치수 위치 지정 또는 [반지름(R)/꺾기(J)/각도(A)/여러 줄 문자(M)/문자(T)/문자 각도(N)/명령 취소(U)]:');
    expect(h.prompts).toContain('반지름 치수 위치 지정 또는 [지름(D)/꺾기(J)/호 길이(L)/각도(A)/여러 줄 문자(M)/문자(T)/문자 각도(N)/명령 취소(U)]:');
  });

  it('명령 취소(U)는 이 명령에서 만든 마지막 치수를 지운다', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['0,0', '10,0', '5,5', '0,0', '0,10', '5,5', 'U', 'U', 'U', '']);
    expect(dims(h).length).toBe(0);
    expect(h.printed).toContain('명령 취소할 것이 없습니다.');
  });

  it('기준선(B)·계속(C): Enter면 마지막 치수에서', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['0,0', '10,0', '5,5', 'B', '', '20,0', '', 'C', '', '30,0', '', '']);
    const ds = dims(h);
    expect(ds.length).toBe(3);
    // 기준선: 원점 (0,0), 다음 치수선으로 DIMDLI만큼
    expect([ds[1]!.defPoint2.x, ds[1]!.defPoint3.x]).toEqual([0, 20]);
    expect(ds[1]!.defPoint.y).toBeGreaterThan(5);
    // 계속: 마지막 치수(기준선 치수)의 둘째 원점에서
    expect([ds[2]!.defPoint2.x, ds[2]!.defPoint3.x]).toEqual([20, 30]);
    close(ds[2]!.defPoint.y, ds[1]!.defPoint.y);
    expect(h.prompts).toContain('기준선으로 첫 번째 치수보조선 원점 지정 또는 [간격띄우기(O)]:');
    expect(h.prompts).toContain('두 번째 치수보조선 원점 지정 또는 [선택(S)/간격띄우기(O)/명령 취소(U)] <선택>:');
  });

  it('기준선: 고른 치수보조선이 기준이고, 간격띄우기(O)를 바꿀 수 있다', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['0,0', '10,0', '5,5', '']);
    const base = dims(h)[0]!;
    await h.run('DIM', ['B', 'O', '2', { pick: base.handle, at: [10, 3] }, '25,0', '', '']);
    const ds = dims(h);
    expect([ds[1]!.defPoint2.x, ds[1]!.defPoint3.x]).toEqual([10, 25]);
    close(ds[1]!.defPoint.y, 7);
    expect(h.prompts.at(-1)).toBe(DIM_MAIN_PROMPT);
  });

  it('세로좌표(O): 피쳐 위치 → 지시선 끝, 되풀이', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['O', '5,5', '5,12', '8,2', 'X', '8,9', '', '']);
    const ds = dims(h);
    expect(ds.length).toBe(2);
    expect(ds.every((d) => (d.dimType & 7) === 6 && (d.dimType & 64) !== 0)).toBe(true);
    close(ds[0]!.measurement, 5);
    close(ds[1]!.measurement, 8);
  });

  it('정렬(G)·분산(D) 동일', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['0,0', '10,0', '5,5', '0,0', '10,0', '5,9', '0,0', '10,0', '5,20', '']);
    const [a, b, c] = dims(h);
    await h.run('DIM', ['G', { pick: a!.handle, at: [5, 5] }, { sel: [b!.handle] }, '']);
    close((h.doc.entityIndex.get(b!.handle) as DimensionEntity).defPoint.y, 5);
    await h.run('DIM', ['D', 'E', { sel: [a!.handle, c!.handle, b!.handle] }, '']);
    // a(5)·b(5)·c(20): 가운데 하나가 12.5로
    const ys = [a!, b!, c!].map((d) => (h.doc.entityIndex.get(d.handle) as DimensionEntity).defPoint.y).sort((x, y) => x - y);
    close(ys[1]!, 12.5);
  });

  it('도면층(L): 새 치수의 도면층(DIMLAYER), 현재 사용(.)', async () => {
    const h = makeHarness((doc) => doc.layers.set('DIMS', { ...doc.layers.get('0')!, name: 'DIMS', handle: 'B0' }));
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['L', 'DIMS', '0,0', '10,0', '5,5', 'L', '.', '0,0', '10,0', '5,6', '']);
    const ds = dims(h);
    expect(ds[0]!.layer).toBe('DIMS');
    expect(ds[1]!.layer).toBe('0');
    expect(h.prompts).toContain('도면층 이름 입력 또는 도면층 이름을 지정할 객체 선택 또는 [현재 사용(.)] <"DIMS">:');
  });

  it('각도(A) 옵션: 정점 지정', async () => {
    const h = makeHarness();
    registerDimSmartCommand(h.app);
    await h.run('DIM', ['A', '', '0,0', '10,0', '0,10', '3,3', '']);
    const d = dims(h)[0]!;
    expect(d.dimType & 7).toBe(5);
    close(d.measurement, Math.PI / 2);
  });
});
