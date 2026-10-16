/**
 * 수정 명령 옵션: TRIM·EXTEND 걸치기(C)·울타리(F)·프로젝트(P)·모서리(E), LENGTHEN 동적(DY), CHAMFER 각도 방식의 폴리선(P).
 */
import { describe, expect, it } from 'vitest';
import type { Entity, LineEntity, PolylineEntity } from '../../src/core/model';
import { lwVertices } from '../../src/core/lwpoly';
import { registerModifyCommands } from '../../src/app/modify';
import { registerPeditCommands } from '../../src/app/modify2-pedit';
import { chamferPolylineAngle } from '../../src/edit/geom/fillet';
import { line as line0, lw as lw0 } from '../edit/make';
import { makeHarness, modelEntities } from '../cmds2/harness';
import { perCommandGroups } from './groups';
import { runWith } from './ctx';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const line = (x0: number, y0: number, x1: number, y1: number): Entity => ({ ...line0(x0, y0, x1, y1), handle: '' });

function harness() {
  const h = perCommandGroups(makeHarness());
  registerModifyCommands(h.app);
  return h;
}

/** 가로 절단선 하나와 세로선 셋 */
function comb(h: ReturnType<typeof harness>) {
  const cut = h.add(line(-10, 0, 10, 0));
  const vs = [-2, 0, 2].map((x) => h.add(line(x, -5, x, 5)));
  return { cut, vs };
}

const verticals = (h: ReturnType<typeof harness>, cut: Entity) => modelEntities(h.doc, 'LINE').filter((l) => l.handle !== cut.handle) as LineEntity[];

describe('TRIM·EXTEND 옵션', () => {
  it('표준 모드 울타리(F): 울타리가 지나는 쪽을 자른다, 명령 취소(U) 한 번에 되돌린다', async () => {
    const h = harness();
    const { cut } = comb(h);
    await h.run('TRIM', ['O', 'S', { sel: [cut.handle] }, 'F', '-5,3', '5,3', '', '']);
    const vs = verticals(h, cut);
    expect(vs.length).toBe(3);
    for (const v of vs) close(Math.max(v.start.y, v.end.y), 0);
    expect(h.prompts).toContain('자를 객체 선택 또는 Shift 키를 누른 채 선택하여 연장 또는 [울타리(F)/걸치기(C)/모드(O)/프로젝트(P)/모서리(E)/지우기(R)/명령 취소(U)]:');
    const h2 = harness();
    const c2 = comb(h2).cut;
    await h2.run('TRIM', ['O', 'S', { sel: [c2.handle] }, 'F', '-5,3', '5,3', '', 'U', '']);
    for (const v of verticals(h2, c2)) close(Math.max(v.start.y, v.end.y), 5);
  });

  it('빠른 작업 걸치기(C): 창이 지나는 객체를 자른다', async () => {
    const h = harness();
    const { cut } = comb(h);
    await h.run('TRIM', ['C', '-5,2', '5,4', '']);
    for (const v of verticals(h, cut)) close(Math.max(v.start.y, v.end.y), 0);
  });

  it('프로젝트(P)·모서리(E)는 PROJMODE·EDGEMODE를 바꾼다', async () => {
    const h = harness();
    comb(h);
    await h.run('EXTEND', ['P', 'N', '']);
    expect(h.doc.header.get('$PROJMODE')).toBe(0);
    expect(h.printed).toContain('현재 설정: 투영=없음, 모서리=없음, 모드=빠른 작업');
    const h2 = harness();
    const { cut } = comb(h2);
    await h2.run('EXTEND', ['O', 'S', { sel: [cut.handle] }, 'E', 'E', '']);
    expect(h2.doc.header.get('$EDGEMODE')).toBe(1);
  });

  it('연장 울타리(F): 울타리가 지나는 끝을 경계까지 늘인다', async () => {
    const h = harness();
    const bound = h.add(line(-10, 10, 10, 10));
    const a = h.add(line(-2, 0, -2, 5));
    const b = h.add(line(2, 0, 2, 5));
    await h.run('EXTEND', ['O', 'S', { sel: [bound.handle] }, 'F', '-5,4', '5,4', '', '']);
    for (const x of [a, b]) {
      const l = h.doc.entityIndex.get(x.handle) as LineEntity;
      close(Math.max(l.start.y, l.end.y), 10);
    }
  });
});

describe('TRIM·EXTEND Shift 전환·빈 곳 클릭', () => {
  it('자르기 중 Shift로 고르면 연장, 연장 중 Shift로 고르면 자르기', async () => {
    const h = harness();
    const bound = h.add(line(-10, 10, 10, 10));
    const a = h.add(line(0, 0, 0, 5));
    await runWith(h, 'TRIM', [{ pick: a.handle, at: [0, 4], shift: true }, '']);
    const la = h.doc.entityIndex.get(a.handle) as LineEntity;
    close(Math.max(la.start.y, la.end.y), 10);
    const h2 = harness();
    const { cut } = comb(h2);
    const p = await runWith(h2, 'EXTEND', [{ pick: verticals(h2, cut)[0]!.handle, at: [-2, 3], shift: true }, '']);
    expect(p[0]).toBe('연장할 객체 선택 또는 Shift 키를 누른 채 선택하여 자르기 또는 [경계 모서리(B)/걸치기(C)/모드(O)/프로젝트(P)]:');
    void bound;
    const v = verticals(h2, cut).find((l) => Math.abs(l.start.x + 2) < 1e-9)!;
    close(Math.max(v.start.y, v.end.y), 0);
  });

  it('빠른 작업에서 빈 곳 두 점 = 울타리, 표준에서 빈 곳 = 걸치기 창', async () => {
    const h = harness();
    const { cut } = comb(h);
    await runWith(h, 'TRIM', [{ empty: [-5, 3] }, '5,3', '']);
    for (const v of verticals(h, cut)) close(Math.max(v.start.y, v.end.y), 0);
    const h2 = harness();
    const c2 = comb(h2).cut;
    await runWith(h2, 'TRIM', ['O', 'S', { sel: [c2.handle] }, { empty: [-5, -2] }, '5,-4', '']);
    for (const v of verticals(h2, c2)) close(Math.min(v.start.y, v.end.y), 0);
  });
});

describe('LENGTHEN 동적(DY)', () => {
  it('고른 끝을 끌어 새 끝점까지(선은 방향 위로 투영)', async () => {
    const h = harness();
    const l = h.add(line(0, 0, 10, 0));
    await h.run('LENGTHEN', ['DY', { pick: l.handle, at: [9, 0] }, '15,3', '']);
    const e = h.doc.entityIndex.get(l.handle) as LineEntity;
    close(e.end.x, 15);
    close(e.end.y, 0);
    close(e.start.x, 0);
  });
});

describe('CHAMFER 각도 방식 폴리선(P)', () => {
  it('직각이 아닌 꼭짓점도 꼭짓점마다 사이각으로 두 번째 거리를 구한다', async () => {
    const h = harness();
    const pl = h.add({ ...lw0([[0, 0], [10, 0], [10 + 5, 5 * Math.sqrt(3)]]), handle: '' });
    const expected = chamferPolylineAngle(h.doc.entityIndex.get(pl.handle)!, 1, Math.PI / 6);
    await h.run('CHAMFER', ['A', '1', '30', 'P', { pick: pl.handle, at: [5, 0] }]);
    const got = lwVertices(modelEntities(h.doc, 'LWPOLYLINE')[0]!);
    const want = lwVertices(expected.replace![0] as never);
    expect(got.length).toBe(want.length);
    got.forEach((v, i) => {
      close(v.x, want[i]!.x);
      close(v.y, want[i]!.y);
    });
  });
});

describe('PEDIT 정점 편집 끊기·직선화·접선', () => {
  const pedit = () => {
    const h = perCommandGroups(makeHarness());
    registerPeditCommands(h.app);
    return h;
  };

  it('끊기(B): 표시한 두 정점 사이 세그먼트를 지워 두 폴리선으로', async () => {
    const h = pedit();
    const pl = h.add({ ...lw0([[0, 0], [10, 0], [10, 10], [0, 10]]), handle: '' });
    await h.run('PEDIT', [{ pick: pl.handle, at: [5, 0] }, 'E', 'N', 'B', 'N', 'G', 'X', '']);
    expect(h.prompts).toContain('정점 편집 옵션 입력 [다음(N)/이전(P)/끊기(B)/삽입(I)/이동(M)/재생성(R)/직선화(S)/접선(T)/폭(W)/종료(X)] <N>:');
    const pls = modelEntities(h.doc, 'LWPOLYLINE').map((p) => lwVertices(p).map((v) => [v.x, v.y]));
    expect(pls).toEqual([
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 10],
        [0, 10],
      ],
    ]);
    // 기본값은 마지막 다음·이전
    await h.run('PEDIT', [{ pick: pl.handle, at: [5, 0] }, 'E', 'P', '', 'X', '']);
    expect(h.prompts).toContain('정점 편집 옵션 입력 [다음(N)/이전(P)/끊기(B)/삽입(I)/이동(M)/재생성(R)/직선화(S)/접선(T)/폭(W)/종료(X)] <P>:');
  });

  it('직선화(S): 사이 정점을 지우고 직선으로, 접선(T)은 맞춤(F)에 쓰인다', async () => {
    const h = pedit();
    const pl = h.add({ ...lw0([[0, 0], [10, 0, 1], [20, 0], [30, 0]]), handle: '' });
    await h.run('PEDIT', [{ pick: pl.handle, at: [5, 0] }, 'E', 'N', 'S', 'N', 'N', 'G', 'X', '']);
    const vs = lwVertices(h.doc.entityIndex.get(pl.handle) as never);
    expect(vs.map((v) => [v.x, v.y, v.bulge])).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [30, 0, 0],
    ]);
    await h.run('PEDIT', [{ pick: pl.handle, at: [5, 0] }, 'E', 'T', '90', 'X', 'F', '']);
    const p2 = h.doc.entityIndex.get(pl.handle)!;
    expect(p2.type).toBe('POLYLINE');
    const first = (p2 as PolylineEntity).vertices[0]!;
    expect(first.flags & 2).toBe(2);
    close(first.tangent!, Math.PI / 2);
    // 맞춤: 첫 세그먼트는 위(+Y)로 출발하는 호
    expect(Math.abs(first.bulge)).toBeGreaterThan(0.01);
  });
});
