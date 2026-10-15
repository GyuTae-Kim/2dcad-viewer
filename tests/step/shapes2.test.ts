import { describe, expect, it } from 'vitest';
import { meshArea, meshVolume, stepToScene, watertightness } from '../../src/formats/step';
import type { Scene3d } from '../../src/viewer3d/types';
import { cube, r, StepText } from './stepText';

function scene(w: StepText, items: number[]): Scene3d {
  const ctx = w.context();
  w.product('part', items, ctx);
  return stepToScene(w.bytes());
}

function closedVolume(sc: Scene3d): number {
  const m = sc.meshes[0]!;
  const wt = watertightness(m.positions, m.indices);
  expect(wt.open + wt.bad).toBe(0);
  return meshVolume(m.positions, m.indices);
}

describe('주기·극점 처리', () => {
  it('반구: 한 바퀴 도는 적도 고리 하나를 극점까지 닫는다', () => {
    const w = new StepText();
    const R = 7;
    const V = w.vertex([R, 0, 0]);
    const E = w.edge(V, V, w.circle([0, 0, 0], R));
    const cap = w.face([w.bound(w.loop([w.oe(E, true)]))], w.add('SPHERICAL_SURFACE', `'',#${w.ax2([0, 0, 0])},${r(R)}`));
    const disk = w.face([w.bound(w.loop([w.oe(E, false)]))], w.plane([0, 0, 0], [0, 0, -1]));
    const sc = scene(w, [w.solid([cap, disk])]);
    const v = closedVolume(sc);
    expect(Math.abs(v - (2 / 3) * Math.PI * R ** 3) / v).toBeLessThan(0.02);
    expect(sc.bounds!.max[2]).toBeCloseTo(R, 4);
  });

  it('이음선 없는 원기둥 띠(두 원 고리를 이어 붙임)', () => {
    const w = new StepText();
    const V0 = w.vertex([4, 0, 0]);
    const V1 = w.vertex([4, 0, 12]);
    const C0 = w.edge(V0, V0, w.circle([0, 0, 0], 4));
    const C1 = w.edge(V1, V1, w.circle([0, 0, 12], 4));
    const side = w.face(
      [w.bound(w.loop([w.oe(C0, true)])), w.bound(w.loop([w.oe(C1, false)]), false)],
      w.add('CYLINDRICAL_SURFACE', `'',#${w.ax2([0, 0, 0])},4.`),
    );
    const bottom = w.face([w.bound(w.loop([w.oe(C0, false)]))], w.plane([0, 0, 0], [0, 0, -1]));
    const top = w.face([w.bound(w.loop([w.oe(C1, true)]))], w.plane([0, 0, 12]));
    const sc = scene(w, [w.solid([side, bottom, top])]);
    const v = closedVolume(sc);
    expect(Math.abs(v - Math.PI * 16 * 12) / v).toBeLessThan(0.02);
  });

  it('회전 곡면(직선 단면 → 원뿔대)', () => {
    const w = new StepText();
    const V0 = w.vertex([5, 0, 0]);
    const V1 = w.vertex([2, 0, 10]);
    const C0 = w.edge(V0, V0, w.circle([0, 0, 0], 5));
    const C1 = w.edge(V1, V1, w.circle([0, 0, 10], 2));
    const prof = w.line([5, 0, 0], [2, 0, 10]);
    const L = w.edge(V0, V1, prof);
    const axis = w.add('AXIS1_PLACEMENT', `'',#${w.pt([0, 0, 0])},#${w.dir([0, 0, 1])}`);
    const rev = w.add('SURFACE_OF_REVOLUTION', `'',#${prof},#${axis}`);
    const side = w.face([w.bound(w.loop([w.oe(C0, true), w.oe(L, true), w.oe(C1, false), w.oe(L, false)]))], rev);
    const bottom = w.face([w.bound(w.loop([w.oe(C0, false)]))], w.plane([0, 0, 0], [0, 0, -1]));
    const top = w.face([w.bound(w.loop([w.oe(C1, true)]))], w.plane([0, 0, 10]));
    const sc = scene(w, [w.solid([side, bottom, top])]);
    const v = closedVolume(sc);
    const exact = ((Math.PI * 10) / 3) * (25 + 10 + 4);
    expect(Math.abs(v - exact) / exact).toBeLessThan(0.02);
  });

  it('직선 밀기 곡면(원 → 원기둥)', () => {
    const w = new StepText();
    const V0 = w.vertex([3, 0, 0]);
    const V1 = w.vertex([3, 0, 8]);
    const base = w.circle([0, 0, 0], 3);
    const C0 = w.edge(V0, V0, base);
    const C1 = w.edge(V1, V1, w.circle([0, 0, 8], 3));
    const L = w.edge(V0, V1, w.line([3, 0, 0], [3, 0, 8]));
    const vec = w.add('VECTOR', `'',#${w.dir([0, 0, 1])},1.`);
    const ext = w.add('SURFACE_OF_LINEAR_EXTRUSION', `'',#${base},#${vec}`);
    const side = w.face([w.bound(w.loop([w.oe(C0, true), w.oe(L, true), w.oe(C1, false), w.oe(L, false)]))], ext);
    const bottom = w.face([w.bound(w.loop([w.oe(C0, false)]))], w.plane([0, 0, 0], [0, 0, -1]));
    const top = w.face([w.bound(w.loop([w.oe(C1, true)]))], w.plane([0, 0, 8]));
    const sc = scene(w, [w.solid([side, bottom, top])]);
    const v = closedVolume(sc);
    expect(Math.abs(v - Math.PI * 9 * 8) / v).toBeLessThan(0.02);
  });

  it('BREP_WITH_VOIDS: 정육면체 속 구 빈 곳(ORIENTED_CLOSED_SHELL .F.)', () => {
    const w = new StepText();
    const { faces } = cube(w, 20);
    const outer = w.add('CLOSED_SHELL', `'',(${faces.map((x) => `#${x}`).join(',')})`);
    const S = w.vertex([10, 10, 5]);
    const N = w.vertex([10, 10, 15]);
    const E = w.edge(S, N, w.circle([10, 10, 10], 5, [0, -1, 0], [1, 0, 0]));
    const sf = w.face([w.bound(w.loop([w.oe(E, true), w.oe(E, false)]))], w.add('SPHERICAL_SURFACE', `'',#${w.ax2([10, 10, 10])},5.`));
    const sph = w.add('CLOSED_SHELL', `'',(#${sf})`);
    const voidShell = w.add('ORIENTED_CLOSED_SHELL', `'',*,#${sph},.F.`);
    const solid = w.add('BREP_WITH_VOIDS', `'box',#${outer},(#${voidShell})`);
    const sc = scene(w, [solid]);
    const v = closedVolume(sc);
    const exact = 8000 - (4 / 3) * Math.PI * 125;
    expect(Math.abs(v - exact) / exact).toBeLessThan(0.005);
  });

  it('여러 구멍이 한 줄로 늘어선 평면(일직선 경계에서 earcut 퇴화 없이)', () => {
    const w = new StepText();
    // 20×4 판 위면에 정사각 구멍 셋이 같은 y 선에 놓인 열린 면
    const V = (x: number, y: number) => w.vertex([x, y, 0]);
    const mk = (pts: [number, number][]) => {
      const vs = pts.map(([x, y]) => V(x, y));
      const es = pts.map((p, k) => {
        const q = pts[(k + 1) % pts.length]!;
        return w.edge(vs[k]!, vs[(k + 1) % pts.length]!, w.line([p[0], p[1], 0], [q[0], q[1], 0]));
      });
      return w.loop(es.map((e) => w.oe(e, true)));
    };
    const outer = mk(
      [
        [0, 0],
        [20, 0],
        [20, 4],
        [0, 4],
      ],
    );
    const holes = [2, 8, 14].map((x) =>
      mk(
        [
          [x, 1],
          [x, 3],
          [x + 3, 3],
          [x + 3, 1],
        ],
      ),
    );
    const f = w.face([w.bound(outer), ...holes.map((h) => w.bound(h, false))], w.plane([0, 0, 0]));
    const sh = w.add('OPEN_SHELL', `'',(#${f})`);
    const sbsm = w.add('SHELL_BASED_SURFACE_MODEL', `'',(#${sh})`);
    const ctx = w.context();
    w.product('plate', [sbsm], ctx, 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
    const sc = stepToScene(w.bytes());
    const m = sc.meshes[0]!;
    const wt = watertightness(m.positions, m.indices);
    expect(wt.bad).toBe(0);
    // 넓이 = 80 - 3·6
    let area = 0;
    const P = m.positions;
    const I = m.indices!;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3;
      area += ((P[b]! - P[a]!) * (P[c + 1]! - P[a + 1]!) - (P[c]! - P[a]!) * (P[b + 1]! - P[a + 1]!)) / 2;
    }
    expect(area).toBeCloseTo(80 - 18, 9);
  });

  it('구멍만 둘 있는 구 면(닫힌 곡면): 정의역 전체에서 두 구멍을 뺀다', () => {
    const w = new StepText();
    const R = 10;
    const d = 8;
    const rho = 6;
    const V1 = w.vertex([rho, d, 0]);
    const V2 = w.vertex([rho, -d, 0]);
    const h1 = w.edge(V1, V1, w.circle([0, d, 0], rho, [0, 1, 0], [1, 0, 0]));
    const h2 = w.edge(V2, V2, w.circle([0, -d, 0], rho, [0, -1, 0], [1, 0, 0]));
    const f = w.face(
      [w.bound(w.loop([w.oe(h1, false)]), false), w.bound(w.loop([w.oe(h2, false)]), false)],
      w.add('SPHERICAL_SURFACE', `'',#${w.ax2([0, 0, 0])},${r(R)}`),
    );
    const sh = w.add('OPEN_SHELL', `'',(#${f})`);
    const sbsm = w.add('SHELL_BASED_SURFACE_MODEL', `'',(#${sh})`);
    const ctx = w.context();
    w.product('ball', [sbsm], ctx, 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
    const sc = stepToScene(w.bytes());
    const m = sc.meshes[0]!;
    const exact = 4 * Math.PI * R * R - 2 * (2 * Math.PI * R * (R - d));
    expect(Math.abs(meshArea(m.positions, m.indices) - exact) / exact).toBeLessThan(0.02);
    const wt = watertightness(m.positions, m.indices);
    expect(wt.bad).toBe(0);
    // 열린 모서리는 두 구멍 테두리뿐(극점·이음선은 닫혀 있다)
    expect(wt.open).toBeGreaterThan(0);
    let ymax = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i]!, y = m.positions[i + 1]!, z = m.positions[i + 2]!;
      if (Math.hypot(x, z) < 1) ymax = Math.max(ymax, Math.abs(y));
    }
    // 구멍 안쪽(축 근처)에는 정점이 없다
    expect(ymax).toBeLessThan(d + 1e-6);
  });
});
