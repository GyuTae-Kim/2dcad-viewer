/**
 * B-rep(경계 표현) → 삼각형 그물.
 *
 * 입체·껍질·면·고리·모서리를 따라가며, 모서리(EDGE_CURVE)마다 다각선을 한 번만 만들어 이웃 면이 같은 점을 쓰게 한다
 * (꼭짓점은 VERTEX_POINT 좌표 그대로). 허용 오차는 입체 크기에 비례한다.
 * AP242 삼각형 형식(TESSELLATED_SOLID·TESSELLATED_SHELL·TRIANGULATED_FACE·COMPLEX_TRIANGULATED_FACE·
 * TRIANGULATED_SURFACE_SET·COMPLEX_TRIANGULATED_SURFACE_SET)은 있는 삼각형을 그대로 쓴다.
 */
import type { Rgba } from '../../viewer3d/types';
import type { Tol } from './curves';
import type { Geometry } from './geometry';
import { cross, dist, dot, len, sub, type V3 } from './math';
import { bool, list, numList, refId, refList, type StepFile } from './part21';
import { type MeshOut, tessellateFace, tessellatePlanarLoops } from './tessellate';

/** 한 형상 항목(입체·껍질 등)의 그물(형상 항목 좌표·단위 그대로) */
export interface ItemMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** 면마다 색이 다르면 정점 색 rgba */
  colors?: Float32Array;
  /** 전체 색(면 색이 하나뿐이거나 입체 색) */
  color?: Rgba;
  /** 면 경계 모서리 선분 쌍 */
  edges: Float32Array;
  faces: number;
  failedFaces: number;
  triangles: number;
  /** 닫힌 껍질에서 왔는지(물샐틈없음 검사 대상) */
  closed: boolean;
  bbox: [V3, V3] | null;
  /** 면 실패 이유 → 개수 */
  failures: Map<string, number>;
}

export interface MeshOptions {
  /** 크기 대비 현 높이(기본 0.001) */
  relTol: number;
  /** 절대 현 높이(모형 단위, 있으면 relTol 대신) */
  absTol?: number;
  /** 최대 각(라디안) */
  angle: number;
}

interface FaceRef {
  id: number;
  reversed: boolean;
}

const SOLID_TYPES = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'FACETED_BREP_AND_BREP_WITH_VOIDS']);
const SHELL_TYPES = new Set(['CLOSED_SHELL', 'OPEN_SHELL', 'CONNECTED_FACE_SET', 'ORIENTED_CLOSED_SHELL', 'ORIENTED_OPEN_SHELL']);
const FACE_TYPES = new Set(['ADVANCED_FACE', 'FACE_SURFACE', 'FACE', 'ORIENTED_FACE']);
const TESS_TYPES = new Set([
  'TESSELLATED_SOLID',
  'TESSELLATED_SHELL',
  'TRIANGULATED_FACE',
  'COMPLEX_TRIANGULATED_FACE',
  'TRIANGULATED_SURFACE_SET',
  'COMPLEX_TRIANGULATED_SURFACE_SET',
]);
const SURFACE_MODEL_TYPES = new Set(['SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL']);

/** 그물로 만들 수 있는 형상 항목인지 */
export function isMeshableType(t: string): boolean {
  return SOLID_TYPES.has(t) || SHELL_TYPES.has(t) || FACE_TYPES.has(t) || TESS_TYPES.has(t) || SURFACE_MODEL_TYPES.has(t);
}

export function isTessellatedType(t: string): boolean {
  return TESS_TYPES.has(t);
}

class Builder implements MeshOut {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  colors: number[] = [];
  faceColors: (Rgba | undefined)[] = [];
  vertsAtFaceStart: number[] = [];
  startFace(color: Rgba | undefined): void {
    this.faceColors.push(color);
    this.vertsAtFaceStart.push(this.positions.length / 3);
  }
}

export class BrepMesher {
  /** 지원하지 않는 위상 개체 종류 → 개수 */
  readonly unsupported = new Map<string, number>();
  private edgeCache = new Map<number, V3[]>();
  private tol: Tol = { chord: 1, angle: 0.35 };
  private eps = 1e-6;

  constructor(
    readonly f: StepFile,
    readonly g: Geometry,
    readonly colorOf: (id: number) => Rgba | undefined,
    readonly opts: MeshOptions,
  ) {}

  private miss(t: string): void {
    this.unsupported.set(t, (this.unsupported.get(t) ?? 0) + 1);
  }

  /** 형상 항목 하나를 그물로(못 만들면 null) */
  meshItem(itemId: number, onFace?: () => void): ItemMesh | null {
    const e = this.f.get(itemId);
    if (!e) return null;
    if (TESS_TYPES.has(e.type)) return this.meshTessellated(itemId);
    const faces: FaceRef[] = [];
    let closed = false;
    const inherited = new Map<number, Rgba>(); // 면 → 껍질·입체에서 물려받은 색
    const addShell = (sid: number, reversed: boolean, parentColor: Rgba | undefined) => {
      const s = this.f.get(sid);
      if (!s) return;
      if (s.type === 'ORIENTED_CLOSED_SHELL' || s.type === 'ORIENTED_OPEN_SHELL') {
        addShell(refId(s.args[2]), reversed !== !bool(s.args[3], true), this.colorOf(sid) ?? parentColor);
        return;
      }
      if (!SHELL_TYPES.has(s.type)) {
        if (FACE_TYPES.has(s.type)) {
          faces.push({ id: sid, reversed });
          if (parentColor) inherited.set(sid, parentColor);
        } else this.miss(s.type);
        return;
      }
      if (s.type === 'CLOSED_SHELL') closed = true;
      const col = this.colorOf(sid) ?? parentColor;
      for (const fid of refList(s.args[1])) {
        faces.push({ id: fid, reversed });
        if (col) inherited.set(fid, col);
      }
    };
    const solidColor = this.colorOf(itemId);
    if (SOLID_TYPES.has(e.type)) {
      addShell(refId(e.args[1]), false, solidColor);
      if (e.type === 'BREP_WITH_VOIDS' || e.type === 'FACETED_BREP_AND_BREP_WITH_VOIDS') for (const v of refList(e.args[2])) addShell(v, false, solidColor);
    } else if (SHELL_TYPES.has(e.type)) addShell(itemId, false, solidColor);
    else if (e.type === 'SHELL_BASED_SURFACE_MODEL' || e.type === 'FACE_BASED_SURFACE_MODEL') {
      for (const sid of refList(e.args[1])) addShell(sid, false, solidColor);
      closed = false;
    } else if (FACE_TYPES.has(e.type)) faces.push({ id: itemId, reversed: false });
    else return null;
    if (!faces.length) return null;

    // 크기(꼭짓점 상자) → 허용 오차
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    const grow = (p: V3) => {
      for (let k = 0; k < 3; k++) {
        if (p[k]! < lo[k]!) lo[k] = p[k]!;
        if (p[k]! > hi[k]!) hi[k] = p[k]!;
      }
    };
    for (const fr of faces) this.faceVertices(fr.id, grow);
    let diag = Number.isFinite(lo[0]) ? dist(lo, hi) : 0;
    // 꼭짓점이 하나뿐인 닫힌 면(구 전체 등): 곡면 크기로
    let surfSize = 0;
    for (const fr of faces) {
      let fe = this.f.get(fr.id);
      if (fe && fe.type === 'ORIENTED_FACE') fe = this.f.get(refId(fe.args[2]));
      if (!fe || fe.type === 'FACE') continue;
      const sf = this.g.surface(refId(fe.args[2]));
      if (sf) surfSize = Math.max(surfSize, sf.size());
      if (diag > 0 && surfSize > 0) break;
    }
    if (!(diag > surfSize * 1e-3)) diag = Math.max(diag, surfSize);
    if (!(diag > 0)) diag = 1;
    const chord = this.opts.absTol ?? Math.max(diag * this.opts.relTol, 1e-9);
    this.tol = { chord, angle: this.opts.angle };
    this.eps = Math.max(chord * 1e-3, diag * 1e-9);
    this.edgeCache = new Map();
    this.healTJunctions(faces);

    const b = new Builder();
    const edgeUse = new Map<number, number>(); // 모서리 → 쓰인 면 수(이음선 판별은 면 안에서)
    const seams = new Set<number>();
    let failed = 0;
    const failures = new Map<string, number>();
    const fail = (why: string) => {
      failed++;
      failures.set(why, (failures.get(why) ?? 0) + 1);
    };
    for (const fr of faces) {
      onFace?.();
      const col = this.colorOf(fr.id) ?? inherited.get(fr.id);
      b.startFace(col);
      const r = this.meshFace(fr, b, edgeUse, seams);
      if (r) fail(r);
    }
    const nTri = b.indices.length / 3;
    // 모서리 선
    const lines: number[] = [];
    for (const [eid] of edgeUse) {
      if (seams.has(eid)) continue;
      const poly = this.edgeCache.get(eid);
      if (!poly) continue;
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1]!;
        const c = poly[i]!;
        lines.push(a[0], a[1], a[2], c[0], c[1], c[2]);
      }
    }
    // 색: 면 색이 모두 같으면 전체 색, 다르면 정점 색
    let color: Rgba | undefined;
    let colors: Float32Array | undefined;
    const distinct = new Set(b.faceColors.map((c) => (c ? c.join(',') : '')));
    if (distinct.size === 1) color = b.faceColors[0];
    else {
      const nv = b.positions.length / 3;
      colors = new Float32Array(nv * 4);
      const dflt: Rgba = solidColor ?? [0.75, 0.75, 0.78, 1];
      for (let fi = 0; fi < b.faceColors.length; fi++) {
        const c = b.faceColors[fi] ?? dflt;
        const s = b.vertsAtFaceStart[fi]!;
        const t = fi + 1 < b.vertsAtFaceStart.length ? b.vertsAtFaceStart[fi + 1]! : nv;
        for (let v = s; v < t; v++) colors.set(c, v * 4);
      }
    }
    return {
      positions: Float32Array.from(b.positions),
      normals: Float32Array.from(b.normals),
      indices: Uint32Array.from(b.indices),
      colors,
      color,
      edges: Float32Array.from(lines),
      faces: faces.length,
      failedFaces: failed,
      triangles: nTri,
      closed,
      bbox: Number.isFinite(lo[0]) ? [lo, hi] : boxOf(b.positions),
      failures,
    };
  }

  /**
   * 모서리 다각선을 미리 만들고, 다른 모서리의 꼭짓점이 어떤 모서리 토막 위에 놓이면(B-rep의 T자 이음)
   * 그 점을 다각선에 넣는다. 이웃 면이 같은 다각선을 쓰므로 틈 없이 맞물린다.
   */
  private healTJunctions(faces: FaceRef[]): void {
    const edges = new Set<number>();
    for (const fr of faces) {
      let fe = this.f.get(fr.id);
      if (fe && fe.type === 'ORIENTED_FACE') fe = this.f.get(refId(fe.args[2]));
      if (!fe) continue;
      for (const bid of refList(fe.args[1])) {
        const loop = this.f.get(refId(this.f.get(bid)?.args[1]));
        if (!loop || loop.type !== 'EDGE_LOOP') continue;
        for (const oid of refList(loop.args[1])) {
          let eid = refId(this.f.get(oid)?.args[3]);
          let inner = this.f.get(eid);
          while (inner && inner.type === 'ORIENTED_EDGE') {
            eid = refId(inner.args[3]);
            inner = this.f.get(eid);
          }
          if (eid) edges.add(eid);
        }
      }
    }
    if (edges.size > 200_000) return;
    const polys = new Map<number, V3[]>();
    const verts: V3[] = [];
    const seen = new Set<string>();
    for (const eid of edges) {
      const pl = this.edgePolyline(eid);
      if (!pl || pl.length < 2) continue;
      polys.set(eid, pl);
      for (const p of [pl[0]!, pl[pl.length - 1]!]) {
        const k = `${p[0]},${p[1]},${p[2]}`;
        if (!seen.has(k)) {
          seen.add(k);
          verts.push(p);
        }
      }
    }
    if (verts.length < 3) return;
    const tol = Math.max(this.eps * 2, this.tol.chord * 1e-3);
    // 격자 해시
    const cell = Math.max(this.tol.chord * 20, tol * 100);
    const grid = new Map<string, V3[]>();
    const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (const p of verts) {
      const k = key(p[0], p[1], p[2]);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(p);
    }
    for (const [eid, pl] of polys) {
      let changed = false;
      const out: V3[] = [pl[0]!];
      for (let i = 1; i < pl.length; i++) {
        const a = pl[i - 1]!;
        const c = pl[i]!;
        const d = sub(c, a);
        const l2 = dot(d, d);
        const ins: [number, V3][] = [];
        if (l2 > tol * tol) {
          const lo = [Math.min(a[0], c[0]) - tol, Math.min(a[1], c[1]) - tol, Math.min(a[2], c[2]) - tol];
          const hi = [Math.max(a[0], c[0]) + tol, Math.max(a[1], c[1]) + tol, Math.max(a[2], c[2]) + tol];
          const n = [0, 1, 2].map((k) => Math.floor(hi[k]! / cell) - Math.floor(lo[k]! / cell) + 1);
          if (n[0]! * n[1]! * n[2]! <= 4096) {
            for (let gx = Math.floor(lo[0]! / cell); gx <= Math.floor(hi[0]! / cell); gx++)
              for (let gy = Math.floor(lo[1]! / cell); gy <= Math.floor(hi[1]! / cell); gy++)
                for (let gz = Math.floor(lo[2]! / cell); gz <= Math.floor(hi[2]! / cell); gz++) {
                  for (const p of grid.get(`${gx},${gy},${gz}`) ?? []) {
                    const t = dot(sub(p, a), d) / l2;
                    if (t <= 1e-6 || t >= 1 - 1e-6) continue;
                    const q: V3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
                    if (dist(q, p) <= tol && dist(p, a) > tol && dist(p, c) > tol) ins.push([t, p]);
                  }
                }
          }
        }
        if (ins.length) {
          ins.sort((x, y) => x[0] - y[0]);
          for (const [, p] of ins) out.push(p);
          changed = true;
        }
        out.push(c);
      }
      if (changed) this.edgeCache.set(eid, out);
    }
  }

  /** 면의 꼭짓점들을 cb로 */
  private faceVertices(faceId: number, cb: (p: V3) => void): void {
    let fe = this.f.get(faceId);
    if (fe && fe.type === 'ORIENTED_FACE') fe = this.f.get(refId(fe.args[2]));
    if (!fe) return;
    for (const bid of refList(fe.args[1])) {
      const bnd = this.f.get(bid);
      if (!bnd) continue;
      const loop = this.f.get(refId(bnd.args[1]));
      if (!loop) continue;
      if (loop.type === 'EDGE_LOOP') {
        for (const oid of refList(loop.args[1])) {
          const oe = this.f.get(oid);
          const ec = oe ? this.f.get(refId(oe.args[3])) : undefined;
          if (!ec) continue;
          const p = this.g.point(refId(ec.args[1]));
          if (p) cb(p);
        }
      } else if (loop.type === 'POLY_LOOP') {
        for (const pid of refList(loop.args[1])) {
          const p = this.g.point(pid);
          if (p) cb(p);
        }
      } else if (loop.type === 'VERTEX_LOOP') {
        const p = this.g.point(refId(loop.args[1]));
        if (p) cb(p);
      }
    }
  }

  /** 모서리 다각선(시작 꼭짓점 → 끝 꼭짓점) */
  edgePolyline(edgeId: number): V3[] | null {
    const hit = this.edgeCache.get(edgeId);
    if (hit) return hit;
    const e = this.f.get(edgeId);
    if (!e) return null;
    if (e.type === 'ORIENTED_EDGE') {
      const inner = this.edgePolyline(refId(e.args[3]));
      return inner ? (bool(e.args[4], true) ? inner : inner.slice().reverse()) : null;
    }
    if (e.type !== 'EDGE_CURVE' && e.type !== 'SUBEDGE') {
      this.miss(e.type);
      return null;
    }
    const P1 = this.g.point(refId(e.args[1]));
    const P2 = this.g.point(refId(e.args[2]));
    if (!P1 || !P2) return null;
    let poly: V3[];
    const c = e.type === 'EDGE_CURVE' ? this.g.curve(refId(e.args[3]), true) : null;
    if (!c) poly = [P1, P2];
    else if (c.linear) poly = [P1, P2];
    else {
      const same = bool(e.args[4], true);
      const closed = dist(P1, P2) <= this.eps;
      let t1 = c.project(P1);
      let t2 = closed ? t1 : c.project(P2, t1);
      if (c.period > 0) {
        const P = c.period;
        if (same) {
          let d = (((t2 - t1) % P) + P) % P;
          if (closed || d < 1e-12 * P) d = closed ? P : d;
          t2 = t1 + d;
        } else {
          let d = (((t1 - t2) % P) + P) % P;
          if (closed || d < 1e-12 * P) d = closed ? P : d;
          t2 = t1 - d;
        }
      } else if (closed) {
        t1 = same ? c.t0 : c.t1;
        t2 = same ? c.t1 : c.t0;
      }
      const ts: number[] = [];
      if (Number.isFinite(t1) && Number.isFinite(t2) && t1 !== t2) c.sample(t1, t2, this.tol, ts);
      poly = [P1];
      for (const t of ts) poly.push(c.point(t));
      poly.push(P2);
    }
    this.edgeCache.set(edgeId, poly);
    return poly;
  }

  /** 면 하나(실패하면 이유) */
  private meshFace(fr: FaceRef, b: Builder, edgeUse: Map<number, number>, seams: Set<number>): string | null {
    let fe = this.f.get(fr.id);
    let reversed = fr.reversed;
    if (fe && fe.type === 'ORIENTED_FACE') {
      reversed = reversed !== !bool(fe.args[3], true);
      fe = this.f.get(refId(fe.args[2]));
    }
    if (!fe) return '면 개체 없음';
    if (!FACE_TYPES.has(fe.type)) {
      this.miss(fe.type);
      return `지원하지 않는 면 ${fe.type}`;
    }
    const loops: V3[][] = [];
    const inFace = new Map<number, number>();
    let poly = false;
    for (const bid of refList(fe.args[1])) {
      const bnd = this.f.get(bid);
      if (!bnd) continue;
      const loop = this.f.get(refId(bnd.args[1]));
      if (!loop) continue;
      const orient = bool(bnd.args[2], true);
      let pts: V3[] = [];
      if (loop.type === 'EDGE_LOOP') {
        for (const oid of refList(loop.args[1])) {
          const oe = this.f.get(oid);
          if (!oe) continue;
          let eid = refId(oe.args[3]);
          let fwd = bool(oe.args[4], true);
          // 중첩된 ORIENTED_EDGE
          let inner = this.f.get(eid);
          while (inner && inner.type === 'ORIENTED_EDGE') {
            fwd = fwd === bool(inner.args[4], true);
            eid = refId(inner.args[3]);
            inner = this.f.get(eid);
          }
          const pl = this.edgePolyline(eid);
          if (!pl) continue;
          inFace.set(eid, (inFace.get(eid) ?? 0) + 1);
          const seq = fwd ? pl : pl.slice().reverse();
          for (let i = 0; i < seq.length - 1; i++) pts.push(seq[i]!);
        }
      } else if (loop.type === 'POLY_LOOP') {
        poly = true;
        pts = refList(loop.args[1])
          .map((p) => this.g.point(p))
          .filter((p): p is V3 => !!p);
        if (pts.length > 1 && dist(pts[0]!, pts[pts.length - 1]!) === 0) pts.pop();
      } else if (loop.type === 'VERTEX_LOOP') {
        const p = this.g.point(refId(loop.args[1]));
        if (p) pts = [p];
      } else {
        this.miss(loop.type);
        continue;
      }
      if (!orient) pts.reverse();
      loops.push(pts);
    }
    for (const [eid, n] of inFace) {
      edgeUse.set(eid, (edgeUse.get(eid) ?? 0) + 1);
      if (n >= 2) seams.add(eid);
    }
    const surfId = fe.type === 'FACE' ? 0 : refId(fe.args[2]);
    let sameSense = fe.type === 'FACE' ? true : bool(fe.args[3], true);
    const surf = surfId ? this.g.surface(surfId) : null;
    if (reversed) {
      sameSense = !sameSense;
      for (const l of loops) l.reverse();
    }
    if (!surf || poly) {
      // 평면 다각형으로(곡면을 모르거나 다각 고리)
      let hint: V3 | null = null;
      if (surf && surf.planar) hint = surf.normal(0, 0);
      if (hint && !sameSense) hint = [-hint[0], -hint[1], -hint[2]];
      if (!surf && surfId) {
        if (!isPlanar(loops, this.tol.chord)) return `지원하지 않는 곡면 ${this.f.typeOf(surfId)}`;
      }
      const n = tessellatePlanarLoops(loops, hint, b);
      return n ? null : '평면 삼각화 실패';
    }
    const r = tessellateFace(surf, loops, sameSense, this.tol, this.eps, b);
    if (r.error) return r.error;
    if (!r.triangles) return '삼각형 없음';
    return null;
  }

  /** AP242 삼각형 형식 */
  private meshTessellated(itemId: number): ItemMesh | null {
    const b = new Builder();
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    let faces = 0;
    let closed = false;
    const visit = (id: number, depth: number, parentColor: Rgba | undefined) => {
      if (depth > 4) return;
      const e = this.f.get(id);
      if (!e) return;
      const col = this.colorOf(id) ?? parentColor;
      if (e.type === 'TESSELLATED_SOLID' || e.type === 'TESSELLATED_SHELL') {
        if (e.type === 'TESSELLATED_SOLID') closed = true;
        for (const c of refList(e.args[1])) visit(c, depth + 1, col);
        return;
      }
      if (!TESS_TYPES.has(e.type)) {
        this.miss(e.type);
        return;
      }
      faces++;
      b.startFace(col);
      const complex = e.type.startsWith('COMPLEX_');
      const isFace = e.type.endsWith('_FACE');
      // (name, coordinates, pnmax, normals, [geometric_link,] pnindex, triangles | strips, fans)
      const coordsE = this.f.get(refId(e.args[1]));
      const coords = coordsE ? list(coordsE.args[2]).map((c) => numList(c)) : [];
      const normals = list(e.args[3]).map((c) => numList(c));
      const k = isFace ? 5 : 4;
      const pnindex = numList(e.args[k]);
      const tris: number[] = [];
      if (complex) {
        for (const strip of list(e.args[k + 1])) {
          const s = numList(strip);
          for (let i = 0; i + 2 < s.length; i++) {
            if (i % 2 === 0) tris.push(s[i]!, s[i + 1]!, s[i + 2]!);
            else tris.push(s[i + 1]!, s[i]!, s[i + 2]!);
          }
        }
        for (const fan of list(e.args[k + 2])) {
          const s = numList(fan);
          for (let i = 1; i + 1 < s.length; i++) tris.push(s[0]!, s[i]!, s[i + 1]!);
        }
      } else for (const t of list(e.args[k + 1])) tris.push(...numList(t));
      addTriangles(b, coords, normals, pnindex, tris, lo, hi);
    };
    visit(itemId, 0, undefined);
    if (!b.indices.length) return null;
    let color: Rgba | undefined;
    let colors: Float32Array | undefined;
    const distinct = new Set(b.faceColors.map((c) => (c ? c.join(',') : '')));
    if (distinct.size === 1) color = b.faceColors[0];
    else {
      const nv = b.positions.length / 3;
      colors = new Float32Array(nv * 4);
      for (let fi = 0; fi < b.faceColors.length; fi++) {
        const c = b.faceColors[fi] ?? ([0.75, 0.75, 0.78, 1] as Rgba);
        const s = b.vertsAtFaceStart[fi]!;
        const t = fi + 1 < b.vertsAtFaceStart.length ? b.vertsAtFaceStart[fi + 1]! : nv;
        for (let v = s; v < t; v++) colors.set(c, v * 4);
      }
    }
    return {
      positions: Float32Array.from(b.positions),
      normals: Float32Array.from(b.normals),
      indices: Uint32Array.from(b.indices),
      colors,
      color,
      edges: new Float32Array(0),
      faces,
      failedFaces: 0,
      triangles: b.indices.length / 3,
      closed,
      bbox: Number.isFinite(lo[0]) ? [lo, hi] : null,
      failures: new Map(),
    };
  }
}

function addTriangles(b: Builder, coords: number[][], normals: number[][], pnindex: number[], tris: number[], lo: V3, hi: V3): void {
  const base = b.positions.length / 3;
  const map = new Map<number, number>();
  const pos = (k: number): number[] | undefined => {
    const ci = pnindex.length ? pnindex[k - 1] : k;
    return ci === undefined ? undefined : coords[ci - 1];
  };
  const nrm = (k: number): number[] | undefined => (normals.length === 1 ? normals[0] : normals[k - 1]);
  const idx: number[] = [];
  let agree = 0;
  let disagree = 0;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = tris[t]!;
    const c = tris[t + 1]!;
    const d = tris[t + 2]!;
    if (a === c || c === d || d === a) continue;
    const pa = pos(a);
    const pc = pos(c);
    const pd = pos(d);
    if (!pa || !pc || !pd) continue;
    const fn = cross(sub(pc as V3, pa as V3), sub(pd as V3, pa as V3));
    if (len(fn) === 0) continue;
    const na = nrm(a);
    if (na && na.length >= 3) {
      if (dot(fn, na as V3) >= 0) agree++;
      else disagree++;
    }
    idx.push(a, c, d);
  }
  const flip = disagree > agree;
  for (let i = 0; i < idx.length; i += 3) {
    const tri = flip ? [idx[i]!, idx[i + 2]!, idx[i + 1]!] : [idx[i]!, idx[i + 1]!, idx[i + 2]!];
    for (const k of tri) {
      let v = map.get(k);
      if (v === undefined) {
        const p = pos(k)!;
        v = base + map.size;
        map.set(k, v);
        b.positions.push(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
        for (let q = 0; q < 3; q++) {
          if (p[q]! < lo[q]!) lo[q] = p[q]!;
          if (p[q]! > hi[q]!) hi[q] = p[q]!;
        }
        const n = nrm(k);
        if (n && n.length >= 3) b.normals.push(n[0]!, n[1]!, n[2]!);
        else b.normals.push(NaN, NaN, NaN);
      }
      b.indices.push(v);
    }
  }
  // 법선이 없는 정점은 이웃 삼각형 법선 평균
  fillMissingNormals(b, base);
}

function fillMissingNormals(b: Builder, base: number): void {
  const nv = b.positions.length / 3;
  let missing = false;
  for (let v = base; v < nv; v++) if (Number.isNaN(b.normals[v * 3]!)) missing = true;
  if (!missing) return;
  const acc = new Float64Array((nv - base) * 3);
  for (let t = 0; t < b.indices.length; t += 3) {
    const a = b.indices[t]!;
    if (a < base) continue;
    const c = b.indices[t + 1]!;
    const d = b.indices[t + 2]!;
    const P = (i: number): V3 => [b.positions[i * 3]!, b.positions[i * 3 + 1]!, b.positions[i * 3 + 2]!];
    const n = cross(sub(P(c), P(a)), sub(P(d), P(a)));
    for (const i of [a, c, d])
      for (let q = 0; q < 3; q++) acc[(i - base) * 3 + q] = acc[(i - base) * 3 + q]! + n[q]!;
  }
  for (let v = base; v < nv; v++) {
    if (!Number.isNaN(b.normals[v * 3]!)) continue;
    const x = acc[(v - base) * 3]!;
    const y = acc[(v - base) * 3 + 1]!;
    const z = acc[(v - base) * 3 + 2]!;
    const l = Math.hypot(x, y, z) || 1;
    b.normals[v * 3] = x / l;
    b.normals[v * 3 + 1] = y / l;
    b.normals[v * 3 + 2] = z / l;
  }
}

function isPlanar(loops: V3[][], tol: number): boolean {
  const pts = loops.flat();
  if (pts.length < 3) return false;
  let n: V3 = [0, 0, 0];
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i]!;
      const c = l[(i + 1) % l.length]!;
      n = [n[0] + (a[1] - c[1]) * (a[2] + c[2]), n[1] + (a[2] - c[2]) * (a[0] + c[0]), n[2] + (a[0] - c[0]) * (a[1] + c[1])];
    }
  }
  const l = len(n);
  if (!(l > 0)) return false;
  const u: V3 = [n[0] / l, n[1] / l, n[2] / l];
  const d0 = dot(u, pts[0]!);
  return pts.every((p) => Math.abs(dot(u, p) - d0) <= tol * 4);
}

function boxOf(pos: number[]): [V3, V3] | null {
  if (!pos.length) return null;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, pos[i + k]!);
      hi[k] = Math.max(hi[k]!, pos[i + k]!);
    }
  return [lo, hi];
}
