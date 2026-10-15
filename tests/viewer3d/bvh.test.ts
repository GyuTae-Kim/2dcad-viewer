/** 범위 나무(BVH)와 광선–삼각형: 모두 훑은 결과와 같은지 */
import { describe, expect, it } from 'vitest';
import { buildBvh, primCount, queryCone, raycastTriangles, rayTriangle } from '../../src/viewer3d/bvh';
import { helixPath, sphereMesh } from '../../src/viewer3d/synth';
import { normalize } from '../../src/viewer3d/math';

/** 결정적 난수 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('광선–삼각형', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0] as const;
  const hit = (o: number[], d: number[]): [number, number, number] | null => rayTriangle(o[0]!, o[1]!, o[2]!, d[0]!, d[1]!, d[2]!, ...tri);

  it('가운데를 위·아래에서(양면)', () => {
    const a = hit([0.25, 0.25, 5], [0, 0, -1])!;
    expect(a[0]).toBeCloseTo(5, 12);
    expect(a[1]).toBeCloseTo(0.25, 12);
    expect(a[2]).toBeCloseTo(0.25, 12);
    const b = hit([0.25, 0.25, -3], [0, 0, 1])!;
    expect(b[0]).toBeCloseTo(3, 12);
  });

  it('밖·뒤쪽·나란함은 빗나감', () => {
    expect(hit([0.8, 0.8, 5], [0, 0, -1])).toBeNull();
    expect(hit([0.25, 0.25, 5], [0, 0, 1])).toBeNull();
    expect(hit([0.25, 0.25, 0.5], [1, 0, 0])).toBeNull();
  });

  it('변 위(꼭짓점 포함)는 맞음', () => {
    expect(hit([0.5, 0, 1], [0, 0, -1])).not.toBeNull();
    expect(hit([0, 0, 1], [0, 0, -1])).not.toBeNull();
  });
});

describe('BVH', () => {
  const sph = sphereMesh('s', [3, -2, 1], 10, 48, 24, [1, 1, 1, 1]);

  it('기본 도형 수와 잎이 모두를 한 번씩 담는다', () => {
    const b = buildBvh('triangle', sph.positions, sph.indices);
    expect(b.count).toBe(primCount('triangle', sph.positions, sph.indices));
    const seen = new Uint8Array(b.count);
    for (let i = 0; i < b.nodeCount; i++) {
      const a = b.node[i * 2]!, n = b.node[i * 2 + 1]!;
      for (let j = a; j < a + n; j++) seen[b.order[j]!]!++;
    }
    expect([...seen].every((v) => v === 1)).toBe(true);
    // 부모 상자는 자식 상자를 감싼다
    for (let i = 0; i < b.nodeCount; i++) {
      if (b.node[i * 2 + 1]! > 0) continue;
      const c = b.node[i * 2]!;
      for (const ch of [c, c + 1])
        for (let k = 0; k < 3; k++) {
          expect(b.box[ch * 6 + k]!).toBeGreaterThanOrEqual(b.box[i * 6 + k]!);
          expect(b.box[ch * 6 + 3 + k]!).toBeLessThanOrEqual(b.box[i * 6 + 3 + k]!);
        }
    }
  });

  it('광선 결과 = 모두 훑기', () => {
    const b = buildBvh('triangle', sph.positions, sph.indices);
    const r = rng(7);
    const P = sph.positions, I = sph.indices!;
    for (let k = 0; k < 300; k++) {
      const o = [3 + (r() - 0.5) * 40, -2 + (r() - 0.5) * 40, 1 + (r() - 0.5) * 40];
      const d = normalize([3 + (r() - 0.5) * 12 - o[0]!, -2 + (r() - 0.5) * 12 - o[1]!, 1 + (r() - 0.5) * 12 - o[2]!]);
      let best = Infinity, bi = -1;
      for (let t = 0; t < I.length / 3; t++) {
        const a = I[t * 3]! * 3, bb = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
        const h = rayTriangle(o[0]!, o[1]!, o[2]!, d[0], d[1], d[2], P[a]!, P[a + 1]!, P[a + 2]!, P[bb]!, P[bb + 1]!, P[bb + 2]!, P[c]!, P[c + 1]!, P[c + 2]!);
        if (h && h[0] < best) {
          best = h[0];
          bi = t;
        }
      }
      const h = raycastTriangles(b, P, I, o, d);
      if (bi < 0) expect(h).toBeNull();
      else {
        expect(h).not.toBeNull();
        expect(h!.t).toBeCloseTo(best, 9);
      }
    }
  });

  it('번호 없는 삼각형 배열', () => {
    const P = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5]);
    const b = buildBvh('triangle', P);
    expect(b.count).toBe(2);
    const h = raycastTriangles(b, P, undefined, [5.2, 5.2, 10], [0, 0, -1])!;
    expect(h.tri).toBe(1);
    expect(h.t).toBeCloseTo(5, 6);
  });

  it('빈 배열·모두 같은 점', () => {
    const e = buildBvh('segment', new Float32Array(0));
    expect(e.count).toBe(0);
    expect(raycastTriangles(buildBvh('triangle', new Float32Array(0)), new Float32Array(0), undefined, [0, 0, 0], [0, 0, 1])).toBeNull();
    let visited = 0;
    queryCone(e, [0, 0, 0], [0, 0, 1], 1, 0, Infinity, () => {
      visited++;
    });
    expect(visited).toBe(0);
    const same = new Float32Array(3000).fill(1);
    const b = buildBvh('point', same);
    expect(b.count).toBe(1000);
    queryCone(b, [1, 1, -5], [0, 0, 1], 0.01, 0, Infinity, () => {
      visited++;
    });
    expect(visited).toBe(1000);
  });

  it('원뿔 질의는 원뿔 안 선분을 빠뜨리지 않는다', () => {
    const l = helixPath('h', [0, 0, 0], 20, 10, 20000);
    const b = buildBvh('segment', l.positions);
    const r = rng(3);
    const P = l.positions;
    for (let k = 0; k < 40; k++) {
      const o = [(r() - 0.5) * 60, (r() - 0.5) * 60, 40];
      const d = normalize([(r() - 0.5) * 0.6, (r() - 0.5) * 0.6, -1]);
      const r0 = 0.3, kk = 0.01;
      const got = new Set<number>();
      queryCone(b, o, d, r0, kk, Infinity, (i) => {
        got.add(i);
      });
      // 선분 위 점 몇 개가 원뿔 안에 들면 반드시 들어 있어야 한다
      for (let i = 0; i < l.positions.length / 6; i++)
        for (const s of [0, 0.5, 1]) {
          const x = P[i * 6]! + (P[i * 6 + 3]! - P[i * 6]!) * s - o[0]!;
          const y = P[i * 6 + 1]! + (P[i * 6 + 4]! - P[i * 6 + 1]!) * s - o[1]!;
          const z = P[i * 6 + 2]! + (P[i * 6 + 5]! - P[i * 6 + 2]!) * s - o[2]!;
          const t = x * d[0] + y * d[1] + z * d[2];
          if (t < 0) continue;
          const px = x - d[0] * t, py = y - d[1] * t, pz = z - d[2] * t;
          if (Math.hypot(px, py, pz) <= r0 + kk * t) expect(got.has(i)).toBe(true);
        }
    }
  });
});
