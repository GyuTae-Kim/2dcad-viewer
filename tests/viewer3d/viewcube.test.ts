/** 뷰 큐브: 면·모서리·구석 → 표준 뷰 방향, 글자 방향, 화면 위치 → 면 */
import { describe, expect, it } from 'vitest';
import { VIEW_DIRS, basisFromAngles, dirToAngles } from '../../src/viewer3d/camera';
import { normalize } from '../../src/viewer3d/math';
import { CUBE_FACES, cubeHit, cubeLayout, cubeRegion, cubeRegionDir, visibleFaces } from '../../src/viewer3d/viewcube';

const close = (a: readonly number[], b: readonly number[], eps = 1e-9): void => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(eps));
const face = (n: string) => CUBE_FACES.find((f) => f.name === n)!;

describe('뷰 큐브', () => {
  it('구역 띠', () => {
    expect(cubeRegion(0.5, 0.5)).toEqual([0, 0]);
    expect(cubeRegion(0.05, 0.5)).toEqual([-1, 0]);
    expect(cubeRegion(0.95, 0.97)).toEqual([1, 1]);
    expect(cubeRegion(0.5, 0.1)).toEqual([0, -1]);
  });

  it('면 가운데 = 그 면의 표준 뷰', () => {
    for (const f of CUBE_FACES) close(cubeRegionDir(f, 0, 0), normalize(VIEW_DIRS[f.name]));
  });

  it('구석·모서리', () => {
    // 앞 면 오른쪽 위 구석 = 남동 등각
    close(cubeRegionDir(face('front'), 1, 1), normalize(VIEW_DIRS.seIso));
    // 위 면 왼쪽 아래 구석 = 남서 등각, 오른쪽 위 = 북동 등각
    close(cubeRegionDir(face('top'), -1, -1), normalize(VIEW_DIRS.swIso));
    close(cubeRegionDir(face('top'), 1, 1), normalize(VIEW_DIRS.neIso));
    // 오른쪽 면 오른쪽 위 = 북동 등각(오른쪽 면의 화면 오른쪽은 +Y)
    close(cubeRegionDir(face('right'), 1, 1), normalize(VIEW_DIRS.neIso));
    // 앞 면 위 모서리 = 앞과 위 사이 45°
    close(cubeRegionDir(face('front'), 0, 1), normalize([0, -1, 1]));
    // 같은 구석은 어느 면에서 눌러도 같은 방향
    close(cubeRegionDir(face('right'), -1, 1), cubeRegionDir(face('front'), 1, 1));
    close(cubeRegionDir(face('top'), 1, -1), cubeRegionDir(face('front'), 1, 1));
  });

  it('면 글자 축 = 그 면 표준 뷰의 화면 오른쪽·위(글자가 바로 읽힘)', () => {
    for (const f of CUBE_FACES) {
      const a = dirToAngles(f.n);
      const b = basisFromAngles(a.yaw, a.pitch);
      close(b.right, f.u, 1e-12);
      close(b.up, f.v, 1e-12);
    }
  });

  it('앞 뷰에서 한가운데를 누르면 앞, 구석을 누르면 등각', () => {
    const a = dirToAngles(VIEW_DIRS.front);
    const b = basisFromAngles(a.yaw, a.pitch);
    const L = cubeLayout(112);
    expect(visibleFaces(b).map((f) => f.name)).toEqual(['front']);
    const h = cubeHit(b, L, L.cx, L.cy)!;
    expect(h.face.name).toBe('front');
    close(h.dir, normalize(VIEW_DIRS.front));
    // 화면 오른쪽 위 구석 근처(면의 s, t ≈ 0.95)
    const k = L.scale * 0.45;
    const c = cubeHit(b, L, L.cx + k, L.cy - k)!;
    close(c.dir, normalize(VIEW_DIRS.seIso));
    expect(cubeHit(b, L, 1, 1)).toBeNull();
  });

  it('남동 등각에서는 위·앞·오른쪽 세 면이 보이고 각 면 가운데를 맞힌다', () => {
    const a = dirToAngles(VIEW_DIRS.seIso);
    const b = basisFromAngles(a.yaw, a.pitch);
    const L = cubeLayout(112);
    expect(new Set(visibleFaces(b).map((f) => f.name))).toEqual(new Set(['top', 'front', 'right']));
    for (const f of visibleFaces(b)) {
      const c = f.n.map((v) => v * 0.5);
      const x = L.cx + (c[0]! * b.right[0] + c[1]! * b.right[1] + c[2]! * b.right[2]) * L.scale;
      const y = L.cy - (c[0]! * b.up[0] + c[1]! * b.up[1] + c[2]! * b.up[2]) * L.scale;
      expect(cubeHit(b, L, x, y)!.face.name).toBe(f.name);
    }
  });
});
