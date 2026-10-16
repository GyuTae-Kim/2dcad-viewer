/**
 * 합성 장면(개발 확인 페이지·시험용): 상자·구 그물, 나선 공구 경로 선분, 점.
 */
import type { LineSet3d, Mesh3d, PointSet3d, Rgba, Scene3d } from './types';

/** 축 나란 상자(정점 8개, 삼각형 12개, 모서리 12개) */
export function boxMesh(id: string, min: readonly number[], max: readonly number[], color: Rgba, group?: string): Mesh3d {
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  // 바깥에서 볼 때 반시계
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const edges = new Float32Array(e.length * 3);
  e.forEach((v, i) => edges.set(positions.subarray(v * 3, v * 3 + 3), i * 3));
  return { id, name: id, positions, indices, color, edges, group };
}

/** 위경도 구(정점 법선, 선택: 정점 색) */
export function sphereMesh(id: string, center: readonly number[], r: number, seg: number, rings: number, color: Rgba, opts: { vertexColors?: boolean; group?: string } = {}): Mesh3d {
  const nv = (seg + 1) * (rings + 1);
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const colors = opts.vertexColors ? new Float32Array(nv * 4) : undefined;
  let k = 0;
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const ph = v * Math.PI;
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const nx = Math.sin(ph) * Math.cos(th), ny = Math.sin(ph) * Math.sin(th), nz = Math.cos(ph);
      positions[k * 3] = center[0]! + r * nx;
      positions[k * 3 + 1] = center[1]! + r * ny;
      positions[k * 3 + 2] = center[2]! + r * nz;
      normals[k * 3] = nx;
      normals[k * 3 + 1] = ny;
      normals[k * 3 + 2] = nz;
      if (colors) {
        colors[k * 4] = 0.35 + 0.6 * v;
        colors[k * 4 + 1] = 0.45 + 0.4 * Math.abs(Math.cos(th));
        colors[k * 4 + 2] = 0.95 - 0.6 * v;
        colors[k * 4 + 3] = 1;
      }
      k++;
    }
  }
  const indices = new Uint32Array(seg * rings * 6);
  let q = 0;
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      indices[q++] = a;
      indices[q++] = c;
      indices[q++] = b;
      indices[q++] = b;
      indices[q++] = c;
      indices[q++] = d;
    }
  return { id, name: id, positions, normals, colors, indices, color, group: opts.group };
}

/**
 * 나선 공구 경로(선분 n개): 반지름이 천천히 바뀌며 내려가는 나선. 정점 색은 높이에 따라 파랑 → 빨강.
 * segmentIds는 10선분마다 한 "줄"로 묶는다(NC 줄 번호 흉내).
 */
export function helixPath(id: string, center: readonly number[], r: number, depth: number, n: number, opts: { group?: string; width?: number; stepDeg?: number } = {}): LineSet3d {
  const positions = new Float32Array(n * 6);
  const colors = new Float32Array(n * 8);
  const segmentIds = new Uint32Array(n);
  const step = ((opts.stepDeg ?? 2) * Math.PI) / 180;
  const turns = (n * step) / (Math.PI * 2);
  const pt = (k: number, o: Float32Array, at: number): number => {
    const th = k * step;
    const f = k / n;
    const rr = r * (0.55 + 0.45 * Math.abs(Math.sin(f * Math.PI * 3)));
    o[at] = center[0]! + rr * Math.cos(th);
    o[at + 1] = center[1]! + rr * Math.sin(th);
    o[at + 2] = center[2]! - (depth * th) / (turns * Math.PI * 2);
    return f;
  };
  for (let i = 0; i < n; i++) {
    const f0 = pt(i, positions, i * 6);
    const f1 = pt(i + 1, positions, i * 6 + 3);
    for (const [f, o] of [
      [f0, i * 8],
      [f1, i * 8 + 4],
    ] as const) {
      colors[o] = 0.2 + 0.8 * f;
      colors[o + 1] = 0.55 + 0.35 * Math.sin(f * Math.PI);
      colors[o + 2] = 1 - 0.8 * f;
      colors[o + 3] = 1;
    }
    segmentIds[i] = Math.floor(i / 10) + 1;
  }
  return { id, name: id, positions, colors, segmentIds, width: opts.width ?? 1, group: opts.group };
}

/** 격자 점 */
export function gridPointSet(id: string, x0: number, y0: number, z: number, nx: number, ny: number, step: number, color: Rgba, group?: string): PointSet3d {
  const positions = new Float32Array(nx * ny * 3);
  let k = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      positions[k++] = x0 + i * step;
      positions[k++] = y0 + j * step;
      positions[k++] = z;
    }
  return { id, name: id, positions, color, size: 7, group };
}

/** 개발 확인용 장면. segments = 나선 선분 수, sphereSeg = 구 경도 칸 수(삼각형 ≈ 2·seg·seg/2) */
export function syntheticScene(opts: { segments?: number; sphereSeg?: number } = {}): Scene3d {
  const segs = opts.segments ?? 300_000;
  const sseg = opts.sphereSeg ?? 128;
  const meshes: Mesh3d[] = [];
  meshes.push(boxMesh('상자', [0, 0, 0], [120, 80, 40], [0.62, 0.68, 0.76, 1], '상자'));
  meshes.push(sphereMesh('구', [190, 40, 35], 35, sseg, Math.max(4, sseg >> 1), [0.8, 0.5, 0.3, 1], { vertexColors: true, group: '구' }));
  // 같은 그물을 행렬로 세 번 놓기(같은 배열은 GPU에 한 번만 올라간다)
  const small = boxMesh('작은 상자', [-6, -6, 0], [6, 6, 12], [0.3, 0.7, 0.55, 1], '작은 상자');
  for (let i = 0; i < 3; i++) {
    const m = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 150 + i * 30, -30, 0, 1]);
    meshes.push({ ...small, id: `작은 상자 ${i + 1}`, name: `작은 상자 ${i + 1}`, matrix: m });
  }
  // 두께 있는 판(반투명)
  const plate = boxMesh('판', [-20, -50, -6], [250, 120, -2], [0.45, 0.65, 0.95, 0.35], '판');
  meshes.push(plate);
  const helix = helixPath('공구 경로', [60, 40, 70], 45, 60, segs, { group: '공구 경로' });
  const rapid: LineSet3d = {
    id: '급속 이송',
    positions: new Float32Array([60, 40, 110, 105, 40, 110, 105, 40, 110, 105, 40, 70, 0, 0, 110, 60, 40, 110]),
    color: [1, 0.35, 0.35, 1],
    dashed: true,
    width: 1.5,
    group: '공구 경로',
  };
  const points = [gridPointSet('구멍', 10, 10, 40, 6, 4, 20, [1, 0.85, 0.2, 1], '구멍')];
  return { name: '합성 장면', units: 'mm', meshes, lines: [helix, rapid], points, warnings: [] };
}
