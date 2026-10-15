/** 고르기: 화면 거리(선분·점)와 광선(그물), BVH 결과 = 모두 훑기 */
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../../src/viewer3d/bvh';
import { type CameraState, VIEW_DIRS, computeFrame, defaultCamera, dirToAngles, fitCamera, projectToScreen, screenRay } from '../../src/viewer3d/camera';
import { boxSphere, sceneBounds } from '../../src/viewer3d/bounds';
import { chooseNearest, pickMeshRay, pickPointSet, pickSegments, pointSegmentDistance2d, segmentScreenPick, snapToNearest } from '../../src/viewer3d/pick';
import { boxMesh, gridPointSet, helixPath } from '../../src/viewer3d/synth';
import type { Scene3d } from '../../src/viewer3d/types';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('후보 고르기', () => {
  it('가장 가까운 것에서 0.75화소 안이면 앞의 것, 차례와 무관', () => {
    const c = [
      { n: 'a', distPx: 0.4, depth: 100 },
      { n: 'b', distPx: 0.9, depth: 90 },
      { n: 'c', distPx: 1.3, depth: 80 },
      { n: 'd', distPx: 3, depth: 1 },
    ];
    expect(chooseNearest(c)!.n).toBe('b');
    expect(chooseNearest([...c].reverse())!.n).toBe('b');
    expect(chooseNearest([c[2]!, c[0]!, c[3]!, c[1]!])!.n).toBe('b');
    expect(chooseNearest([])).toBeNull();
  });
});

describe('2D 거리', () => {
  it('선분 안·밖·점 하나', () => {
    expect(pointSegmentDistance2d(5, 3, 0, 0, 10, 0)).toEqual({ d: 3, s: 0.5 });
    expect(pointSegmentDistance2d(-4, 3, 0, 0, 10, 0)).toEqual({ d: 5, s: 0 });
    expect(pointSegmentDistance2d(13, 4, 0, 0, 10, 0)).toEqual({ d: 5, s: 1 });
    expect(pointSegmentDistance2d(3, 4, 0, 0, 0, 0)).toEqual({ d: 5, s: 0 });
  });
});

const frontOrtho = (): CameraState => {
  const a = dirToAngles(VIEW_DIRS.front);
  return { ...defaultCamera(), yaw: a.yaw, pitch: a.pitch, projection: 'orthographic', target: [0, 0, 0], distance: 10 / Math.tan(defaultCamera().fovY / 2) };
};

describe('선분 화면 거리', () => {
  it('앞 뷰(평행): 화면 거리·3D 매개변수·깊이', () => {
    // 반높이 10 → 400화소 화면에서 1단위 = 20화소
    const f = computeFrame(frontOrtho(), 400, 400, { center: [0, 0, 0], radius: 20 });
    const h = segmentScreenPick(f, -5, 0, 3, 5, 0, 3, 200 + 2 * 20, 200 - 2 * 20)!;
    expect(h.distPx).toBeCloseTo(20, 6);
    expect(h.t).toBeCloseTo(0.7, 9);
    expect(h.point[0]).toBeCloseTo(2, 6);
    expect(h.point[2]).toBeCloseTo(3, 6);
    expect(h.depth).toBeCloseTo(f.eye[1] === 0 ? 0 : -f.eye[1], 6);
  });

  it('원근: 눈 뒤로 넘어간 선분은 가까운 면에서 잘린다', () => {
    const c: CameraState = { ...defaultCamera(), ...dirToAngles(VIEW_DIRS.front), target: [0, 0, 0], distance: 10, projection: 'perspective' };
    const f = computeFrame(c, 500, 500, { center: [0, 0, 0], radius: 5 });
    // 눈은 (0, −10, 0). 선분은 눈 뒤(y = −30)에서 앞(y = 10)까지 x = 1에 놓인다
    const h = segmentScreenPick(f, 1, -30, 0, 1, 10, 0, 250, 250);
    expect(h).not.toBeNull();
    expect(h!.depth).toBeGreaterThan(0);
    expect(h!.point[1]).toBeGreaterThan(-10);
    // 완전히 눈 뒤
    expect(segmentScreenPick(f, 1, -30, 0, 1, -20, 0, 250, 250)).toBeNull();
  });

  it('원근 보정: 화면 가운데에 맞춘 점은 3D에서도 그 점', () => {
    const c: CameraState = { ...defaultCamera(), ...dirToAngles(VIEW_DIRS.seIso), target: [0, 0, 0], distance: 30 };
    const f = computeFrame(c, 640, 480, { center: [0, 0, 0], radius: 20 });
    const a = [-10, 4, -3], b = [12, -6, 7];
    const want = [a[0]! + (b[0]! - a[0]!) * 0.3, a[1]! + (b[1]! - a[1]!) * 0.3, a[2]! + (b[2]! - a[2]!) * 0.3];
    const s = projectToScreen(f, want)!;
    const h = segmentScreenPick(f, a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, s[0], s[1])!;
    expect(h.distPx).toBeLessThan(1e-6);
    expect(h.t).toBeCloseTo(0.3, 6);
  });
});

describe('선분 묶음 고르기', () => {
  const l = helixPath('h', [0, 0, 0], 30, 20, 30000);
  const bvh = buildBvh('segment', l.positions);
  const box = sceneBounds({ name: '', units: 'mm', meshes: [], lines: [l] });
  for (const proj of ['perspective', 'orthographic'] as const)
    it(`${proj}: BVH = 모두 훑기`, () => {
      const c = fitCamera({ ...defaultCamera(), projection: proj }, box, 4 / 3);
      const f = computeFrame(c, 800, 600, boxSphere(box));
      const r = rng(11);
      let hits = 0;
      for (let k = 0; k < 60; k++) {
        const x = 150 + r() * 500, y = 100 + r() * 400;
        const a = pickSegments(f, l.positions, bvh, x, y, 6);
        const b = pickSegments(f, l.positions, null, x, y, 6);
        if (!b) expect(a).toBeNull();
        else {
          hits++;
          expect(a).not.toBeNull();
          expect(a!.distPx).toBeCloseTo(b.distPx, 6);
          expect(a!.depth).toBeCloseTo(b.depth, 6);
        }
      }
      expect(hits).toBeGreaterThan(5);
    });

  it('그리기 범위 밖·가린 깊이 뒤는 고르지 않는다', () => {
    const c = fitCamera({ ...defaultCamera() }, box, 1);
    const f = computeFrame(c, 600, 600, boxSphere(box));
    const i = 25000;
    const o = i * 6;
    const mid = [(l.positions[o]! + l.positions[o + 3]!) / 2, (l.positions[o + 1]! + l.positions[o + 4]!) / 2, (l.positions[o + 2]! + l.positions[o + 5]!) / 2];
    const s = projectToScreen(f, mid)!;
    const all = pickSegments(f, l.positions, bvh, s[0], s[1], 3)!;
    expect(all.distPx).toBeLessThan(1);
    const lim = pickSegments(f, l.positions, bvh, s[0], s[1], 3, { limit: 1000 });
    if (lim) expect(lim.index).toBeLessThan(1000);
    expect(pickSegments(f, l.positions, bvh, s[0], s[1], 3, { maxDepth: f.near })).toBeNull();
  });
});

describe('점·그물 고르기', () => {
  it('점: BVH = 모두 훑기, 허용 거리', () => {
    const p = gridPointSet('p', 0, 0, 0, 20, 20, 5, [1, 1, 1, 1]);
    const bvh = buildBvh('point', p.positions);
    const s: Scene3d = { name: '', units: 'mm', meshes: [], lines: [], points: [p] };
    const box = sceneBounds(s);
    const c = fitCamera({ ...defaultCamera() }, box, 1);
    const f = computeFrame(c, 500, 500, boxSphere(box));
    const t = projectToScreen(f, [25, 30, 0])!;
    const a = pickPointSet(f, p.positions, bvh, t[0] + 2, t[1] - 1, 6)!;
    expect(a.point).toEqual([25, 30, 0]);
    expect(a.index).toBe(6 * 20 + 5);
    expect(pickPointSet(f, p.positions, null, t[0] + 2, t[1] - 1, 6)!.index).toBe(a.index);
    expect(pickPointSet(f, p.positions, bvh, t[0] + 9, t[1], 6)).toBeNull();
  });

  it('그물: 행렬로 옮긴 상자의 맞은 점·법선·꼭짓점 붙잡기', () => {
    const m = boxMesh('b', [0, 0, 0], [10, 10, 10], [1, 1, 1, 1]);
    m.matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]);
    const bvh = buildBvh('triangle', m.positions, m.indices);
    const c: CameraState = { ...defaultCamera(), ...dirToAngles(VIEW_DIRS.top), target: [105, 5, 5], distance: 60, projection: 'orthographic' };
    const f = computeFrame(c, 400, 400, { center: [105, 5, 5], radius: 20 });
    const s = projectToScreen(f, [103, 4, 10])!;
    const h = pickMeshRay(f, screenRay(f, s[0], s[1]), m.positions, m.indices, bvh, m.matrix)!;
    expect(h.point[0]).toBeCloseTo(103, 5);
    expect(h.point[1]).toBeCloseTo(4, 5);
    expect(h.point[2]).toBeCloseTo(10, 5);
    expect(h.normal[2]).toBeCloseTo(1, 9);
    // 꼭짓점 (110, 10, 10) 가까이 누르면 그 점으로 붙는다
    const v = projectToScreen(f, [110, 10, 10])!;
    const h2 = pickMeshRay(f, screenRay(f, v[0] - 3, v[1] + 3), m.positions, m.indices, bvh, m.matrix)!;
    expect(snapToNearest(f, h2.corners, v[0] - 3, v[1] + 3, 10)).toEqual([110, 10, 10]);
    // 빗나감
    expect(pickMeshRay(f, screenRay(f, 5, 5), m.positions, m.indices, bvh, m.matrix)).toBeNull();
  });
});
