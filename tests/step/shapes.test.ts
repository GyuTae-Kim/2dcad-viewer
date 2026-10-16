import { describe, expect, it } from 'vitest';
import { meshArea, meshVolume, stepToScene, watertightness, type StepMeta } from '../../src/formats/step';
import type { Mesh3d, Scene3d } from '../../src/viewer3d/types';
import { cone, cube, cylinder, plateWithHole, r, sphere, StepText, torus } from './stepText';

function one(w: StepText, items: number[], unit: 'mm' | 'inch' = 'mm', angle: 'rad' | 'deg' = 'rad'): Scene3d {
  const ctx = w.context(unit, angle);
  w.product('part', items, ctx);
  return stepToScene(w.bytes());
}

/** 정점 법선과 삼각형 법선이 같은 쪽인 비율 */
function normalAgreement(m: Mesh3d): number {
  const P = m.positions;
  const N = m.normals!;
  const I = m.indices!;
  let ok = 0;
  let all = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3;
    const b = I[t + 1]! * 3;
    const c = I[t + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) < 1e-12) continue;
    all++;
    if (nx * (N[a]! + N[b]! + N[c]!) + ny * (N[a + 1]! + N[b + 1]! + N[c + 1]!) + nz * (N[a + 2]! + N[b + 2]! + N[c + 2]!) > 0) ok++;
  }
  return ok / all;
}

function checkClosed(m: Mesh3d, area: number, volume: number, rel: number) {
  const wt = watertightness(m.positions, m.indices);
  expect(wt.open).toBe(0);
  expect(wt.bad).toBe(0);
  expect(wt.ratio).toBe(1);
  expect(meshArea(m.positions, m.indices)).toBeCloseTo(area, -Math.log10(area * rel));
  const v = meshVolume(m.positions, m.indices);
  expect(v).toBeGreaterThan(0); // 바깥 법선
  expect(Math.abs(v - volume) / volume).toBeLessThan(rel);
  expect(normalAgreement(m)).toBeGreaterThan(0.999);
  expect(m.doubleSided).toBe(false);
}

describe('STEP 형상 삼각화', () => {
  it('정육면체: 삼각형 12, 범위, 부피, 물샐틈없음', () => {
    const w = new StepText();
    const { solid } = cube(w, 10);
    const sc = one(w, [solid]);
    expect(sc.units).toBe('mm');
    expect(sc.meshes).toHaveLength(1);
    const m = sc.meshes[0]!;
    expect(m.indices!.length / 3).toBe(12);
    expect(sc.bounds!.min).toEqual([0, 0, 0]);
    expect(sc.bounds!.max).toEqual([10, 10, 10]);
    checkClosed(m, 600, 1000, 1e-6);
    // 모서리 선 12개
    expect(m.edges!.length / 6).toBe(12);
    expect(sc.warnings).toEqual([]);
  });

  it('원기둥(이음선, same_sense .F. 바닥): 넓이·부피 근사', () => {
    const w = new StepText();
    const sc = one(w, [cylinder(w, 5, 20)]);
    const m = sc.meshes[0]!;
    checkClosed(m, 2 * Math.PI * 25 + 2 * Math.PI * 5 * 20, Math.PI * 25 * 20, 0.02);
    // 이음선은 모서리 선에서 뺀다: 두 원만
    const ys = new Set<number>();
    for (let i = 2; i < m.edges!.length; i += 3) ys.add(Math.round(m.edges![i]!));
    expect([...ys].sort((a, b) => a - b)).toEqual([0, 20]);
  });

  it('구(극점을 지나는 이음선 한 면)', () => {
    const w = new StepText();
    const sc = one(w, [sphere(w, 10)]);
    const m = sc.meshes[0]!;
    checkClosed(m, 4 * Math.PI * 100, (4 / 3) * Math.PI * 1000, 0.02);
    // 모든 정점이 구 위
    for (let i = 0; i < m.positions.length; i += 3) expect(Math.hypot(m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!)).toBeCloseTo(10, 4);
  });

  it('원뿔(VERTEX_LOOP 꼭짓점, 도 단위 반각)', () => {
    for (const deg of [false, true]) {
      const w = new StepText();
      const sc = one(w, [cone(w, 4, 9, deg)], 'mm', deg ? 'deg' : 'rad');
      const m = sc.meshes[0]!;
      const slant = Math.hypot(4, 9);
      checkClosed(m, Math.PI * 16 + Math.PI * 4 * slant, (Math.PI * 16 * 9) / 3, 0.02);
      expect(sc.bounds!.max[2]).toBeCloseTo(9, 5);
    }
  });

  it('원환(두 이음선 원)', () => {
    const w = new StepText();
    const sc = one(w, [torus(w, 6, 1.5)]);
    const m = sc.meshes[0]!;
    checkClosed(m, 4 * Math.PI * Math.PI * 6 * 1.5, 2 * Math.PI * Math.PI * 6 * 1.5 * 1.5, 0.02);
  });

  it('구멍 뚫린 판: 구멍 벽(same_sense .F. 원기둥)과 위·아래 면의 구멍', () => {
    const w = new StepText();
    const sc = one(w, [plateWithHole(w)]);
    const m = sc.meshes[0]!;
    const area = 2 * (200 - Math.PI * 4) + 2 * (20 * 2 + 10 * 2) + 2 * Math.PI * 2 * 2;
    checkClosed(m, area, 400 - Math.PI * 4 * 2, 0.01);
  });

  it('B-스플라인 면 한 장(열린 껍질, 유리 복합 인스턴스 포함)', () => {
    for (const rational of [false, true]) {
      const w = new StepText();
      const n = 4;
      const ids: number[][] = [];
      for (let i = 0; i < n; i++) {
        const row: number[] = [];
        for (let j = 0; j < n; j++) {
          const inner = i > 0 && i < n - 1 && j > 0 && j < n - 1;
          row.push(w.pt([(i * 10) / (n - 1), (j * 10) / (n - 1), inner ? 4 : 0]));
        }
        ids.push(row);
      }
      const net = `(${ids.map((row) => `(${row.map((x) => `#${x}`).join(',')})`).join(',')})`;
      const surf = rational
        ? w.raw(
            `(BOUNDED_SURFACE() B_SPLINE_SURFACE(3,3,${net},.UNSPECIFIED.,.F.,.F.,.F.) B_SPLINE_SURFACE_WITH_KNOTS((4,4),(4,4),(0.,1.),(0.,1.),.UNSPECIFIED.) GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_SURFACE((${ids
              .map((row) => `(${row.map(() => '1.').join(',')})`)
              .join(',')})) REPRESENTATION_ITEM('') SURFACE())`,
          )
        : w.add('B_SPLINE_SURFACE_WITH_KNOTS', `'',3,3,${net},.UNSPECIFIED.,.F.,.F.,.F.,(4,4),(4,4),(0.,1.),(0.,1.),.UNSPECIFIED.`);
      const c = [w.vertex([0, 0, 0]), w.vertex([10, 0, 0]), w.vertex([10, 10, 0]), w.vertex([0, 10, 0])];
      const cp: [number, number, number][] = [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ];
      const es = [0, 1, 2, 3].map((k) => w.edge(c[k]!, c[(k + 1) % 4]!, w.line(cp[k]!, cp[(k + 1) % 4]!)));
      const face = w.face([w.bound(w.loop(es.map((e) => w.oe(e, true))))], surf);
      const shell = w.add('OPEN_SHELL', `'',(#${face})`);
      const sbsm = w.add('SHELL_BASED_SURFACE_MODEL', `'',(#${shell})`);
      const ctx = w.context();
      w.product('patch', [sbsm], ctx, 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
      const sc = stepToScene(w.bytes());
      expect(sc.warnings).toEqual([]);
      const m = sc.meshes[0]!;
      expect(m.doubleSided).toBe(true);
      const tri = m.indices!.length / 3;
      expect(tri).toBeGreaterThan(20);
      expect(tri).toBeLessThan(5000);
      // 가운데가 솟는다(쌍삼차 곡면 가운데 높이 = 4·(3/4)² ≈ 2.25)
      let zmax = 0;
      for (let i = 2; i < m.positions.length; i += 3) zmax = Math.max(zmax, m.positions[i]!);
      expect(zmax).toBeGreaterThan(2.1);
      expect(zmax).toBeLessThan(2.3);
      // ∂u×∂v 는 +Z 쪽(same_sense .T.)
      let up = 0;
      for (let i = 2; i < m.normals!.length; i += 3) if (m.normals![i]! > 0) up++;
      expect(up / (m.normals!.length / 3)).toBe(1);
      expect(normalAgreement(m)).toBeGreaterThan(0.999);
      // 열린 면: 바깥 테두리 말고는 모두 짝
      const wt = watertightness(m.positions, m.indices);
      expect(wt.bad).toBe(0);
      expect(wt.open).toBeGreaterThanOrEqual(4);
    }
  });

  it('허용 오차를 줄이면 삼각형이 늘고 원에 더 가까워진다', () => {
    const make = (tol: number) => {
      const w = new StepText();
      const ctx = w.context();
      w.product('p', [cylinder(w, 5, 20)], ctx);
      return stepToScene(w.bytes(), { tolerance: tol });
    };
    const coarse = make(0.01).meshes[0]!;
    const fine = make(0.0002).meshes[0]!;
    expect(fine.indices!.length).toBeGreaterThan(coarse.indices!.length * 2);
    const exact = Math.PI * 25 * 20;
    expect(Math.abs(meshVolume(fine.positions, fine.indices) - exact)).toBeLessThan(Math.abs(meshVolume(coarse.positions, coarse.indices) - exact));
  });
});

describe('다면체·삼각형 형식', () => {
  it('FACETED_BREP·POLY_LOOP 사면체', () => {
    const w = new StepText();
    const P: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const pid = P.map((p) => w.pt(p));
    const tris = [
      [0, 2, 1],
      [0, 1, 3],
      [1, 2, 3],
      [2, 0, 3],
    ];
    const faces = tris.map((t) => {
      const pl = w.add('POLY_LOOP', `'',(${t.map((i) => `#${pid[i]}`).join(',')})`);
      return w.add('FACE', `'',(#${w.bound(pl)})`);
    });
    const sh = w.add('CLOSED_SHELL', `'',(${faces.map((x) => `#${x}`).join(',')})`);
    const fb = w.add('FACETED_BREP', `'tet',#${sh}`);
    const ctx = w.context();
    w.product('tet', [fb], ctx, 'FACETED_BREP_SHAPE_REPRESENTATION');
    const sc = stepToScene(w.bytes());
    const m = sc.meshes[0]!;
    expect(m.indices!.length / 3).toBe(4);
    expect(watertightness(m.positions, m.indices).ratio).toBe(1);
    expect(meshVolume(m.positions, m.indices)).toBeCloseTo(1 / 6, 9);
  });

  it('AP242 TESSELLATED_SOLID: TRIANGULATED_FACE + COMPLEX_TRIANGULATED_FACE(띠)', () => {
    const w = new StepText();
    const coords = w.add('COORDINATES_LIST', `'',4,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.))`);
    const f1 = w.add('TRIANGULATED_FACE', `'',#${coords},4,(),$,(),((1,3,2),(1,2,4))`);
    const f2 = w.add('COMPLEX_TRIANGULATED_FACE', `'',#${coords},4,(),$,(),((2,3,4,1)),()`);
    const ts = w.add('TESSELLATED_SOLID', `'tet',(#${f1},#${f2}),$`);
    const ctx = w.context();
    w.product('tess', [ts], ctx, 'TESSELLATED_SHAPE_REPRESENTATION');
    const sc = stepToScene(w.bytes());
    const m = sc.meshes[0]!;
    expect(m.indices!.length / 3).toBe(4);
    expect(watertightness(m.positions, m.indices).ratio).toBe(1);
    expect(meshVolume(m.positions, m.indices)).toBeCloseTo(1 / 6, 9);
    expect(normalAgreement(m)).toBe(1);
  });
});

describe('조립·색·단위·이름', () => {
  it('부품 하나를 두 번 놓는 조립: 같은 그물, 다른 행렬, 제품 나무', () => {
    const w = new StepText();
    const ctx = w.context();
    const { solid } = cube(w, 10);
    const part = w.product('cube', [solid], ctx);
    const p1 = w.ax2([0, 0, 0]);
    const p2 = w.ax2([30, 0, 0], [0, 0, 1], [0, 1, 0]); // Z축 둘레 90° 회전
    const asm = w.product('asm', [p1, p2], ctx, 'SHAPE_REPRESENTATION');
    w.place(asm, part, p1, 'cube-1');
    w.place(asm, part, p2, 'cube-2');
    const sc = stepToScene(w.bytes());
    expect(sc.meshes).toHaveLength(2);
    const [a, b] = sc.meshes as [Mesh3d, Mesh3d];
    expect(a.positions).toBe(b.positions); // 같은 버퍼를 함께 쓴다
    expect(a.matrix).toBeUndefined();
    const M = b.matrix!;
    // (10,0,0) → 회전 후 (0,10,0) + (30,0,0)
    const x = M[0]! * 10 + M[12]!;
    const y = M[1]! * 10 + M[13]!;
    expect(x).toBeCloseTo(30, 9);
    expect(y).toBeCloseTo(10, 9);
    expect(sc.bounds!.min).toEqual([0, 0, 0]);
    expect(sc.bounds!.max[0]).toBeCloseTo(30, 6);
    expect(sc.bounds!.min[0]).toBe(0);
    const meta = sc.meta as unknown as StepMeta;
    expect(meta.products).toHaveLength(1);
    const root = meta.products[0]!;
    expect(root.name).toBe('asm');
    expect(root.children.map((c) => c.instance)).toEqual(['cube-1', 'cube-2']);
    expect(root.children.map((c) => c.name)).toEqual(['cube', 'cube']);
    expect(root.children[1]!.meshIds).toEqual([b.id]);
    expect(meta.productCounts.find((p) => p.name === 'cube')!.instances).toBe(2);
  });

  it('MAPPED_ITEM으로 놓은 표현', () => {
    const w = new StepText();
    const ctx = w.context();
    const { solid } = cube(w, 2);
    const origin = w.ax2([0, 0, 0]);
    const inner = w.add('ADVANCED_BREP_SHAPE_REPRESENTATION', `'inner',(#${solid},#${origin}),#${ctx}`);
    const map = w.add('REPRESENTATION_MAP', `#${origin},#${inner}`);
    const items = [0, 1, 2].map((k) => w.add('MAPPED_ITEM', `'',#${map},#${w.ax2([k * 5, 0, 0])}`));
    w.product('grid', items, ctx, 'SHAPE_REPRESENTATION');
    const sc = stepToScene(w.bytes());
    expect(sc.meshes).toHaveLength(3);
    expect(sc.meshes[2]!.matrix![12]).toBeCloseTo(10, 9);
    expect(sc.bounds!.max[0]).toBeCloseTo(12, 6);
  });

  it('색: 입체 색과 면 하나 덮어쓰기(정점 색), 투명도', () => {
    const w = new StepText();
    const { solid } = cube(w, 1);
    w.color(solid, [1, 0, 0], 0.25);
    const sc0 = one(w, [solid]);
    expect(sc0.meshes[0]!.color).toEqual([1, 0, 0, 0.75]);
    expect(sc0.meshes[0]!.colors).toBeUndefined();

    const w2 = new StepText();
    const c2 = cube(w2, 1);
    w2.color(c2.solid, [1, 0, 0]);
    w2.color(c2.faces[1]!, [0, 1, 0]);
    const sc = one(w2, [c2.solid]);
    const m = sc.meshes[0]!;
    expect(m.colors).toBeDefined();
    let green = 0;
    let red = 0;
    for (let i = 0; i < m.colors!.length; i += 4) {
      if (m.colors![i + 1] === 1) green++;
      if (m.colors![i] === 1) red++;
    }
    expect(green).toBe(4); // 윗면 정점 4
    expect(red).toBe(20);
  });

  it('인치 단위와 인코딩된 제품 이름', () => {
    const w = new StepText();
    const { solid } = cube(w, 1);
    const ctx = w.context('inch');
    w.product('\\X2\\C81CD488\\X0\\ \\X\\E9', [solid], ctx);
    const sc = stepToScene(w.bytes());
    expect(sc.units).toBe('inch');
    expect(sc.bounds!.max).toEqual([1, 1, 1]);
    const meta = sc.meta as unknown as StepMeta;
    expect(meta.products[0]!.name).toBe('제품 é');
    expect(sc.meshes[0]!.group).toBe('제품 é');
  });

  it('지원하지 않는 곡면은 경고로 알린다', () => {
    const w = new StepText();
    const V = w.vertex([0, 0, 0]);
    const C = w.edge(V, V, w.circle([1, 0, 0], 1));
    const s = w.add('MYSTERY_SURFACE', `'',${r(1)}`);
    const f = w.face([w.bound(w.loop([w.oe(C, true)]))], s);
    const sh = w.add('OPEN_SHELL', `'',(#${f})`);
    const sbsm = w.add('SHELL_BASED_SURFACE_MODEL', `'',(#${sh})`);
    const ctx = w.context();
    w.product('x', [sbsm], ctx, 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
    const sc = stepToScene(w.bytes());
    // 평면 고리이므로 평면으로라도 그린다
    expect(sc.meshes.length).toBe(1);
    expect(sc.warnings!.some((x) => x.includes('MYSTERY_SURFACE'))).toBe(true);
  });

  it('진행률 콜백', () => {
    const w = new StepText();
    const ctx = w.context();
    w.product('p', [sphere(w, 3)], ctx);
    const seen: number[] = [];
    stepToScene(w.bytes(), { onProgress: (f) => seen.push(f) });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });
});
