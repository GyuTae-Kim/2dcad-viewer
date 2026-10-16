import { describe, expect, it } from 'vitest';
import { type CadDocument, MODEL_SPACE, type XLineEntity } from '../../src/core/model';
import { registerDrawCommands } from '../../src/app/draw';
import { lwVertices } from '../../src/core/lwpoly';
import { bulgeArc } from '../../src/geom/curves';
import { nurbsPoint } from '../../src/edit/geom/nurbs';
import { splineNurbs } from '../../src/edit/geom/path';
import { splinePolyline } from '../../src/edit/geom/pedit';
import { circle, line, poly2d } from '../edit/make';
import { makeHarness, modelEntities } from '../cmds2/harness';
import { perCommandGroups } from './groups';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const xlines = (doc: CadDocument) => doc.blocks.get(MODEL_SPACE)!.entities.filter((e) => e.type === 'XLINE') as XLineEntity[];

function harness() {
  const h = perCommandGroups(makeHarness());
  registerDrawCommands(h.app);
  return h;
}

describe('RECTANG 옵션', () => {
  it('모깎기(F)·폭(W)·고도(E)·두께(T)를 폴리선 값으로 넣는다', async () => {
    const h = harness();
    await h.run('RECTANG', ['F', '1', 'W', '0.5', 'E', '3', 'T', '2', '0,0', '10,5']);
    const [r] = modelEntities(h.doc, 'LWPOLYLINE');
    expect(r).toBeTruthy();
    expect(r!.closed).toBe(true);
    expect(r!.elevation).toBe(3);
    expect(r!.thickness).toBe(2);
    expect(r!.constantWidth).toBe(0.5);
    const vs = lwVertices(r!);
    expect(vs.length).toBe(8);
    // 구석마다 90° 호(볼록 tan(22.5°)), 반시계 감김
    const arcs = vs.filter((v) => Math.abs(v.bulge) > 0);
    expect(arcs.length).toBe(4);
    for (const v of arcs) close(v.bulge, Math.tan(Math.PI / 8));
    expect(h.printed.some((t) => t.startsWith('현재 직사각형 모드:'))).toBe(true);
  });

  it('모따기(C): 구석을 두 거리로 자르고 모깎기를 지운다', async () => {
    const h = harness();
    await h.run('RECTANG', ['C', '1', '2', '0,0', '10,6']);
    const vs = lwVertices(modelEntities(h.doc, 'LWPOLYLINE')[0]!);
    expect(vs.length).toBe(8);
    expect(vs.every((v) => v.bulge === 0)).toBe(true);
    // 첫 구석(0,0): 들어오는 변(Y축 방향)을 2, 나가는 변(X축 방향)을 1만큼
    close(vs[0]!.x, 0);
    close(vs[0]!.y, 2);
    close(vs[1]!.x, 1);
    close(vs[1]!.y, 0);
  });

  it('회전(R)·치수(D): 커서 쪽 사분면에 그 크기로, 회전한 축을 따라', async () => {
    const h = harness();
    await h.run('RECTANG', ['0,0', 'R', '90', 'D', '4', '2', '-1,1']);
    const vs = lwVertices(modelEntities(h.doc, 'LWPOLYLINE')[0]!);
    // 90° 회전: 길이 4는 +Y 방향, 폭 2는 −X 방향(커서 (−1,1)은 길이 +, 폭 +)
    close(vs[1]!.x, 0);
    close(vs[1]!.y, 4);
    close(vs[2]!.x, -2);
    close(vs[2]!.y, 4);
  });

  it('영역(A): 넓이와 길이로 폭을 구한다', async () => {
    const h = harness();
    await h.run('RECTANG', ['0,0', 'A', '50', 'L', '10']);
    const vs = lwVertices(modelEntities(h.doc, 'LWPOLYLINE')[0]!);
    close(vs[2]!.x, 10);
    close(vs[2]!.y, 5);
  });
});

describe('CIRCLE Ttr', () => {
  it('직교하는 두 선에 접하는 반지름 2 원: 고른 점 쪽 사분면', async () => {
    const h = harness();
    const a = h.add(line(0, 0, 10, 0));
    const b = h.add(line(0, 0, 0, 10));
    await h.run('CIRCLE', ['T', { pick: a.handle, at: [5, 0] }, { pick: b.handle, at: [0, 5] }, '2']);
    const [c] = modelEntities(h.doc, 'CIRCLE');
    close(c!.center.x, 2);
    close(c!.center.y, 2);
    close(c!.radius, 2);
  });

  it('선과 원에 접하는 원, 해가 없으면 알린다', async () => {
    const h = harness();
    const a = h.add(line(-10, 0, 10, 0));
    const c0 = h.add(circle(0, 5, 2));
    await h.run('CIRCLE', ['T', { pick: a.handle, at: [3, 0] }, { pick: c0.handle, at: [1.5, 3.7] }, '2']);
    const c = modelEntities(h.doc, 'CIRCLE').find((x) => x.handle !== c0.handle)!;
    close(c.center.y, 2);
    close(c.center.x, Math.sqrt(7));
    close(Math.hypot(c.center.x, c.center.y - 5), 4);
    const h2 = harness();
    const p = h2.add(line(0, 0, 10, 0));
    const q = h2.add(line(0, 5, 10, 5));
    await h2.run('CIRCLE', ['T', { pick: p.handle, at: [1, 0] }, { pick: q.handle, at: [1, 5] }, '1']);
    expect(h2.printed).toContain('원이 존재하지 않습니다.');
  });
});

describe('PLINE 호 옵션', () => {
  it('중심(CE)·반지름(R)·방향(D)·각도(A)로 호 구간을 만든다', async () => {
    const h = harness();
    await h.run('PLINE', ['0,0', 'A', 'CE', '5,0', 'A', '180', 'R', '2', '10,4', 'D', '90', '14,4', 'L', '20,4', '']);
    const [pl] = modelEntities(h.doc, 'LWPOLYLINE');
    const vs = lwVertices(pl!);
    // 중심 (5,0) 반시계 180° → 끝 (10,0), 볼록 tan(45°) = 1
    close(vs[1]!.x, 10);
    close(vs[1]!.y, 0);
    close(vs[0]!.bulge, 1);
    // 반지름 2, 끝점 (10,4): 현 4 = 지름 → 반원
    close(vs[1]!.bulge, 1);
    // 시작 방향 90°, 끝점 (14,4): 시계 방향 반원(볼록 −1)
    close(vs[2]!.bulge, -1);
    expect(bulgeArc(vs[2]!.x, vs[2]!.y, vs[3]!.x, vs[3]!.y, vs[2]!.bulge)).toBeTruthy();
    expect(vs[3]!.bulge).toBe(0);
    expect(vs.length).toBe(5);
  });
});

describe('XLINE 이등분·간격띄우기', () => {
  it('이등분(B): 정점·시작점·끝점 사이 각도의 이등분선', async () => {
    const h = harness();
    await h.run('XLINE', ['B', '0,0', '10,0', '0,10', '']);
    const [x] = xlines(h.doc);
    close(Math.atan2(x!.direction.y, x!.direction.x), Math.PI / 4);
  });

  it('간격띄우기(O): 거리와 면 쪽으로 평행한 구성선', async () => {
    const h = harness();
    const l = h.add(line(0, 0, 10, 0));
    await h.run('XLINE', ['O', '3', { pick: l.handle, at: [5, 0] }, '5,-1', '']);
    const [x] = xlines(h.doc);
    close(x!.base.y, -3);
    close(Math.abs(x!.direction.x), 1);
  });
});

describe('ELLIPSE 호의 매개변수·사이각', () => {
  it('시작 각도와 사이각(I)', async () => {
    const h = harness();
    await h.run('ELLIPSE', ['A', '-10,0', '10,0', '5', '0', 'I', '90']);
    const [e] = modelEntities(h.doc, 'ELLIPSE');
    close(e!.startParam, 0);
    close(e!.endParam, Math.PI / 2);
  });

  it('매개변수(P)로 시작·끝 매개변수를 바로 넣는다', async () => {
    const h = harness();
    await h.run('ELLIPSE', ['A', '-10,0', '10,0', '5', 'P', '30', '120']);
    const [e] = modelEntities(h.doc, 'ELLIPSE');
    close(e!.startParam, Math.PI / 6);
    close(e!.endParam, (2 * Math.PI) / 3);
  });
});

describe('SPLINE 작성 옵션', () => {
  it('맞춤 + 닫기(C) = 맞춤점을 지나는 주기 스플라인', async () => {
    const h = harness();
    await h.run('SPLINE', ['0,0', '10,0', '10,10', '0,10', 'C']);
    const [s] = modelEntities(h.doc, 'SPLINE');
    expect(s!.flags & 1).toBe(1);
    expect(s!.flags & 2).toBe(2);
    expect(s!.fitPoints.length).toBe(4);
  });

  it('CV 메서드·차수(D)·끝 접촉부(T)·공차(L)', async () => {
    const h = harness();
    await h.run('SPLINE', ['M', 'C', 'D', '2', '0,0', '5,5', '10,0', '']);
    const [s] = modelEntities(h.doc, 'SPLINE');
    expect(s!.degree).toBe(2);
    expect(s!.fitPoints.length).toBe(0);
    expect(s!.controlPoints.length).toBe(3);
    const h2 = harness();
    await h2.run('SPLINE', ['0,0', 'L', '0.5', '5,5', 'T', '10,5']);
    const [t] = modelEntities(h2.doc, 'SPLINE');
    expect(t!.fitTolerance).toBe(0.5);
    expect(t!.endTangent).toBeTruthy();
  });

  it('매듭(K) 균일은 현 길이와 다른 곡선을 만든다', async () => {
    const h = harness();
    await h.run('SPLINE', ['K', 'U', '0,0', '1,1', '10,1', '11,0', '12,3', '']);
    const h2 = harness();
    await h2.run('SPLINE', ['K', 'C', '0,0', '1,1', '10,1', '11,0', '12,3', '']);
    const a = modelEntities(h.doc, 'SPLINE')[0]!;
    const b = modelEntities(h2.doc, 'SPLINE')[0]!;
    expect(a.knots).not.toEqual(b.knots);
  });

  it('객체(O): 스플라인 맞춤 폴리선을 같은 곡선의 스플라인으로', async () => {
    const h = harness();
    const pl = h.add(splinePolyline(poly2d([[0, 0], [5, 5], [10, 0], [15, 5]]) as never, 6));
    await h.run('SPLINE', ['O', { sel: [pl.handle] }]);
    expect(modelEntities(h.doc, 'POLYLINE').length).toBe(0);
    const [s] = modelEntities(h.doc, 'SPLINE');
    expect(s!.degree).toBe(3);
    const n = splineNurbs(s!)!;
    const p0 = nurbsPoint(n, n.knots[n.degree]!);
    close(p0.x, 0);
    close(p0.y, 0);
  });
});

describe('UNDO 옵션', () => {
  it('숫자 n, 시작(BE)…끝(E) 묶음, 표식(M)·뒤(B)', async () => {
    const h = harness();
    await h.run('LINE', ['0,0', '1,0', '']);
    await h.run('UNDO', ['M']);
    await h.run('UNDO', ['BE']);
    await h.run('LINE', ['0,1', '1,1', '']);
    await h.run('LINE', ['0,2', '1,2', '']);
    await h.run('UNDO', ['E']);
    await h.run('LINE', ['0,3', '1,3', '']);
    expect(modelEntities(h.doc, 'LINE').length).toBe(4);
    // 2단계: 마지막 선, 그다음 묶음(선 두 개)
    await h.run('UNDO', ['2']);
    expect(modelEntities(h.doc, 'LINE').length).toBe(1);
    h.st.session.redo();
    h.st.session.redo();
    expect(modelEntities(h.doc, 'LINE').length).toBe(4);
    await h.run('UNDO', ['B']);
    expect(modelEntities(h.doc, 'LINE').length).toBe(1);
    expect(h.printed).toContain('표식에 도달했습니다.');
    // 표식이 없으면 모두 취소할지 묻는다
    await h.run('UNDO', ['B', 'Y']);
    expect(modelEntities(h.doc, 'LINE').length).toBe(0);
  });

  it('조정 없음(N)이면 U·UNDO를 거절하고, 전체(A)로 되돌린다', async () => {
    const h = harness();
    await h.run('UNDO', ['C', 'N']);
    await h.run('LINE', ['0,0', '1,0', '']);
    await h.run('U', []);
    expect(modelEntities(h.doc, 'LINE').length).toBe(1);
    await h.run('UNDO', ['C', 'A']);
    await h.run('LINE', ['0,1', '1,1', '']);
    await h.run('U', []);
    expect(modelEntities(h.doc, 'LINE').length).toBe(1);
  });
});
