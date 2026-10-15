/**
 * NC 장면에 쓰는 작은 그물 만들기: 상자(축 나란·회전), 원기둥, 여러 개를 한 그물로 합치기.
 * 정점·법선·번호는 형식 배열로 — 뷰어 계약(Mesh3d)에 바로 넣는다.
 */

/** 그물 조각 모음(합쳐서 한 Mesh3d로) */
export class MeshAccum {
  pos: number[] = [];
  nrm: number[] = [];
  idx: number[] = [];
  edges: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  private quad(p: number[][], n: readonly number[]): void {
    const b = this.vertexCount;
    for (const q of p) {
      this.pos.push(q[0]!, q[1]!, q[2]!);
      this.nrm.push(n[0]!, n[1]!, n[2]!);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  /**
   * 방향 있는 상자: 원점 o(한 모서리), 세 변 벡터 u·v·w(서로 수직, 오른손).
   * 모서리선 12개도 edges에 넣는다.
   */
  box(o: readonly number[], u: readonly number[], v: readonly number[], w: readonly number[], withEdges = true): void {
    const P = (a: number, b: number, c: number): number[] => [
      o[0]! + a * u[0]! + b * v[0]! + c * w[0]!,
      o[1]! + a * u[1]! + b * v[1]! + c * w[1]!,
      o[2]! + a * u[2]! + b * v[2]! + c * w[2]!,
    ];
    const unit = (x: readonly number[], s = 1): number[] => {
      const l = Math.hypot(x[0]!, x[1]!, x[2]!) || 1;
      return [(s * x[0]!) / l, (s * x[1]!) / l, (s * x[2]!) / l];
    };
    // 여섯 면(바깥 법선, 반시계 감기)
    this.quad([P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)], unit(w, -1));
    this.quad([P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)], unit(w));
    this.quad([P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)], unit(v, -1));
    this.quad([P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)], unit(v));
    this.quad([P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)], unit(u, -1));
    this.quad([P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)], unit(u));
    if (withEdges) {
      const c = [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0), P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)];
      const E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
      for (let i = 0; i < E.length; i += 2) this.edges.push(...c[E[i]!]!, ...c[E[i + 1]!]!);
    }
  }

  /** 축 나란한 상자 */
  aabb(min: readonly number[], max: readonly number[], withEdges = true): void {
    this.box(min, [max[0]! - min[0]!, 0, 0], [0, max[1]! - min[1]!, 0], [0, 0, max[2]! - min[2]!], withEdges);
  }

  /**
   * 원기둥: 시작 중심 a에서 방향 d(단위 벡터)로 길이 len, 반지름 r. 양 끝 뚜껑 포함.
   * 둘레 나누기 수 seg. 원 테두리 두 개를 edges에 넣는다.
   */
  cylinder(a: readonly number[], d: readonly number[], len: number, r: number, seg = 16, withEdges = true): void {
    // d에 수직인 두 축
    const t = Math.abs(d[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let e1 = [d[1]! * t[2]! - d[2]! * t[1]!, d[2]! * t[0]! - d[0]! * t[2]!, d[0]! * t[1]! - d[1]! * t[0]!];
    const l1 = Math.hypot(e1[0]!, e1[1]!, e1[2]!) || 1;
    e1 = e1.map((x) => x / l1);
    const e2 = [d[1]! * e1[2]! - d[2]! * e1[1]!, d[2]! * e1[0]! - d[0]! * e1[2]!, d[0]! * e1[1]! - d[1]! * e1[0]!];
    const b = [a[0]! + d[0]! * len, a[1]! + d[1]! * len, a[2]! + d[2]! * len];
    const ring = (c: readonly number[], k: number): number[] => {
      const th = (k / seg) * Math.PI * 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      return [c[0]! + r * (cs * e1[0]! + sn * e2[0]!), c[1]! + r * (cs * e1[1]! + sn * e2[1]!), c[2]! + r * (cs * e1[2]! + sn * e2[2]!)];
    };
    // 옆면
    const base = this.vertexCount;
    for (let k = 0; k <= seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const n = [Math.cos(th) * e1[0]! + Math.sin(th) * e2[0]!, Math.cos(th) * e1[1]! + Math.sin(th) * e2[1]!, Math.cos(th) * e1[2]! + Math.sin(th) * e2[2]!];
      const p0 = ring(a, k);
      const p1 = ring(b, k);
      this.pos.push(...p0, ...p1);
      this.nrm.push(...n, ...n);
    }
    for (let k = 0; k < seg; k++) {
      const i0 = base + k * 2;
      this.idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
    }
    // 뚜껑
    for (const [c, sgn] of [
      [a, -1],
      [b, 1],
    ] as const) {
      const cb = this.vertexCount;
      this.pos.push(c[0]!, c[1]!, c[2]!);
      this.nrm.push(sgn * d[0]!, sgn * d[1]!, sgn * d[2]!);
      for (let k = 0; k < seg; k++) {
        this.pos.push(...ring(c, k));
        this.nrm.push(sgn * d[0]!, sgn * d[1]!, sgn * d[2]!);
      }
      for (let k = 0; k < seg; k++) {
        const i1 = cb + 1 + k;
        const i2 = cb + 1 + ((k + 1) % seg);
        if (sgn > 0) this.idx.push(cb, i1, i2);
        else this.idx.push(cb, i2, i1);
      }
      if (withEdges)
        for (let k = 0; k < seg; k++) {
          this.edges.push(...ring(c, k), ...ring(c, k + 1));
        }
    }
  }

  isEmpty(): boolean {
    return this.idx.length === 0;
  }

  /** 형식 배열로 */
  arrays(): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges?: Float32Array } {
    const out: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges?: Float32Array } = {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      indices: new Uint32Array(this.idx),
    };
    if (this.edges.length) out.edges = new Float32Array(this.edges);
    return out;
  }
}

/** 공구·가공별 색(밝은 배경·어두운 배경 모두에서 보이는 것) */
export const TOOL_COLORS: readonly (readonly [number, number, number, number])[] = [
  [0.12, 0.47, 0.71, 1],
  [0.84, 0.15, 0.16, 1],
  [0.17, 0.63, 0.17, 1],
  [1.0, 0.5, 0.05, 1],
  [0.58, 0.4, 0.74, 1],
  [0.55, 0.34, 0.29, 1],
  [0.89, 0.47, 0.76, 1],
  [0.09, 0.75, 0.81, 1],
  [0.74, 0.74, 0.13, 1],
  [0.0, 0.3, 0.6, 1],
  [0.6, 0.0, 0.3, 1],
  [0.3, 0.55, 0.0, 1],
];

/** 0~1 값을 파랑→초록→빨강으로 */
export function rampColor(t: number): [number, number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.5) {
    const k = x * 2;
    return [0.1, 0.3 + 0.5 * k, 0.9 - 0.6 * k, 1];
  }
  const k = (x - 0.5) * 2;
  return [0.1 + 0.8 * k, 0.8 - 0.6 * k, 0.3 - 0.2 * k, 1];
}
