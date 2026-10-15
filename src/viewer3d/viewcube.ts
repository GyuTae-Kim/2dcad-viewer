/**
 * 뷰 큐브(오른쪽 위): 지금 카메라 방향으로 평행 투영한 정육면체.
 * 면 가운데를 누르면 그 면의 표준 뷰, 면 가장자리 띠는 모서리 뷰(두 면 사이 45°), 구석은 등각 뷰.
 * 면 글자는 그 면을 정면에서 볼 때 바로 읽히도록 면마다 (u = 화면 오른쪽, v = 화면 위) 축을 둔다.
 */
import type { CameraBasis } from './camera';
import { type V3, add, dot, normalize, scale } from './math';

export type CubeFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export interface CubeFaceDef {
  name: CubeFace;
  /** 바깥 법선 */
  n: V3;
  /** 그 면의 표준 뷰에서 화면 오른쪽 */
  u: V3;
  /** 그 면의 표준 뷰에서 화면 위 */
  v: V3;
  label: string;
}

export const CUBE_FACES: readonly CubeFaceDef[] = [
  { name: 'front', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], label: '앞' },
  { name: 'back', n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1], label: '뒤' },
  { name: 'right', n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: '오른쪽' },
  { name: 'left', n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1], label: '왼쪽' },
  { name: 'top', n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], label: '위' },
  { name: 'bottom', n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0], label: '아래' },
];

/** 면 가장자리 띠 폭(면 한 변 대비) */
export const CUBE_BAND = 0.24;

/** 면 위 (s, t) ∈ [0, 1]² → 구역(−1 | 0 | 1, −1 | 0 | 1) */
export function cubeRegion(s: number, t: number, band = CUBE_BAND): [number, number] {
  const r = (x: number): number => (x < band ? -1 : x > 1 - band ? 1 : 0);
  return [r(s), r(t)];
}

/** 면과 구역 → 눈 방향(단위 벡터) */
export function cubeRegionDir(face: CubeFaceDef, ru: number, rv: number): V3 {
  return normalize(add(add(face.n, scale(face.u, ru)), scale(face.v, rv)));
}

export interface CubeLayout {
  /** 큐브 가운데(캔버스 화소) */
  cx: number;
  cy: number;
  /** 한 변 1인 정육면체의 화소 배율 */
  scale: number;
}

/** 캔버스 한 변 size에 맞는 배치 */
export function cubeLayout(size: number): CubeLayout {
  return { cx: size / 2, cy: size / 2, scale: (size / 2 - 4) / 0.95 };
}

function proj(b: CameraBasis, L: CubeLayout, p: readonly number[]): [number, number] {
  return [L.cx + dot(p, b.right) * L.scale, L.cy - dot(p, b.up) * L.scale];
}

function projLin(b: CameraBasis, L: CubeLayout, p: readonly number[]): [number, number] {
  return [dot(p, b.right) * L.scale, -dot(p, b.up) * L.scale];
}

export interface CubeHit {
  face: CubeFaceDef;
  s: number;
  t: number;
  region: [number, number];
  dir: V3;
}

/** 화면에 보이는 면(앞을 향한 면) */
export function visibleFaces(b: CameraBasis): CubeFaceDef[] {
  return CUBE_FACES.filter((f) => dot(f.n, b.back) > 0.02);
}

/** 큐브 캔버스 위 점(x, y) → 누른 면·구역·눈 방향 */
export function cubeHit(b: CameraBasis, L: CubeLayout, x: number, y: number): CubeHit | null {
  for (const f of visibleFaces(b)) {
    const O = proj(b, L, add(scale(f.n, 0.5), add(scale(f.u, -0.5), scale(f.v, -0.5))));
    const A = projLin(b, L, f.u);
    const B = projLin(b, L, f.v);
    const det = A[0] * B[1] - A[1] * B[0];
    if (Math.abs(det) < 1e-9) continue;
    const px = x - O[0], py = y - O[1];
    const s = (px * B[1] - py * B[0]) / det;
    const t = (A[0] * py - A[1] * px) / det;
    if (s < 0 || s > 1 || t < 0 || t > 1) continue;
    const region = cubeRegion(s, t);
    return { face: f, s, t, region, dir: cubeRegionDir(f, region[0], region[1]) };
  }
  return null;
}

export interface CubeColors {
  face: string;
  edge: string;
  text: string;
  hover: string;
}

/** 큐브 그리기(ctx는 큐브 캔버스, dpr 배율은 부르는 쪽이 setTransform으로 건다) */
export function drawViewCube(ctx: CanvasRenderingContext2D, b: CameraBasis, L: CubeLayout, colors: CubeColors, hoverDir: V3 | null, font: string): void {
  const faces = visibleFaces(b).sort((p, q) => dot(p.n, b.back) - dot(q.n, b.back));
  const bands = [0, CUBE_BAND, 1 - CUBE_BAND, 1];
  for (const f of faces) {
    const at = (s: number, t: number): [number, number] => proj(b, L, add(scale(f.n, 0.5), add(scale(f.u, s - 0.5), scale(f.v, t - 0.5))));
    const facing = dot(f.n, b.back);
    // 면 채우기(정면에 가까울수록 밝게)
    ctx.beginPath();
    const c = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
    ctx.moveTo(c[0]![0], c[0]![1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i]![0], c[i]![1]);
    ctx.closePath();
    ctx.fillStyle = colors.face;
    ctx.globalAlpha = 0.78 + 0.22 * facing;
    ctx.fill();
    ctx.globalAlpha = 1;
    // 가리킨 구역
    if (hoverDir) {
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          const d = cubeRegionDir(f, i - 1, j - 1);
          if (dot(d, hoverDir) < 0.9999) continue;
          const q = [at(bands[i]!, bands[j]!), at(bands[i + 1]!, bands[j]!), at(bands[i + 1]!, bands[j + 1]!), at(bands[i]!, bands[j + 1]!)];
          ctx.beginPath();
          ctx.moveTo(q[0]![0], q[0]![1]);
          for (let k = 1; k < 4; k++) ctx.lineTo(q[k]![0], q[k]![1]);
          ctx.closePath();
          ctx.fillStyle = colors.hover;
          ctx.fill();
        }
    }
    ctx.beginPath();
    ctx.moveTo(c[0]![0], c[0]![1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i]![0], c[i]![1]);
    ctx.closePath();
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    // 글자: 면 좌표(0..100, y 아래)를 화면으로 잇는 아핀 변환
    if (facing > 0.15) {
      const O = at(0, 1);
      const A = projLin(b, L, f.u);
      const B = projLin(b, L, f.v);
      ctx.save();
      ctx.transform(A[0] / 100, A[1] / 100, -B[0] / 100, -B[1] / 100, O[0], O[1]);
      ctx.fillStyle = colors.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font;
      ctx.fillText(f.label, 50, 52, 92);
      ctx.restore();
    }
  }
}
