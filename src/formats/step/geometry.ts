/**
 * STEP 형상 개체 → 곡선·곡면 객체(번호별 캐시).
 * 복합 인스턴스(유리 B-스플라인 등)는 부분별 인자를 모아 같은 모양으로 읽는다.
 */
import {
  CircleCurve,
  CompositeCurve,
  type Curve,
  EllipseCurve,
  HyperbolaCurve,
  LineCurve,
  ParabolaCurve,
  PolylineCurve,
  BSplineCurve,
  SurfaceMappedCurve,
  TrimmedCurve,
} from './curves';
import { type Frame, len, makeFrame, normalize, scale, type V3 } from './math';
import { bezierKnots, expandKnots, NurbsCurve, NurbsSurface, quasiUniformKnots, uniformKnots } from './nurbs';
import { bool, enumOf, list, num, numList, partOf, refId, refList, StepRef, StepTyped, type StepEntity, type StepFile, type StepValue } from './part21';
import {
  BSplineSurface,
  ConeSurface,
  CylinderSurface,
  ExtrusionSurface,
  OffsetSurface,
  PlaneSurface,
  RevolutionSurface,
  SphereSurface,
  type Surface,
  TorusSurface,
} from './surfaces';

const CONICS = new Set(['CIRCLE', 'ELLIPSE', 'PARABOLA', 'HYPERBOLA']);

export class Geometry {
  /** 평면각 단위 → 라디안 배율(원뿔 반각, 원뿔 곡선 잘림 매개변수) */
  angleFactor = 1;
  /** 지원하지 않는 형상 개체 종류 → 개수 */
  readonly unsupported = new Map<string, number>();
  private pts = new Map<number, V3 | null>();
  private curves = new Map<number, Curve | null>();
  private edgeCurves = new Map<number, Curve | null>();
  private surfs = new Map<number, Surface | null>();

  constructor(readonly f: StepFile) {}

  /** 캐시가 커지면 비운다(큰 파일에서 입체 하나를 끝낼 때마다 부른다) */
  trim(limit = 300_000): void {
    if (this.pts.size + this.curves.size + this.edgeCurves.size + this.surfs.size > limit) {
      this.pts.clear();
      this.curves.clear();
      this.edgeCurves.clear();
      this.surfs.clear();
    }
  }

  private miss(type: string): null {
    this.unsupported.set(type, (this.unsupported.get(type) ?? 0) + 1);
    return null;
  }

  point(id: number): V3 | null {
    const hit = this.pts.get(id);
    if (hit !== undefined) return hit;
    const e = this.f.get(id);
    let p: V3 | null = null;
    if (e && e.type === 'CARTESIAN_POINT') {
      const c = numList(e.args[1]);
      p = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
    } else if (e && e.type === 'VERTEX_POINT') p = this.point(refId(e.args[1]));
    this.pts.set(id, p);
    return p;
  }

  direction(id: number): V3 | null {
    const e = this.f.get(id);
    if (!e) return null;
    if (e.type === 'DIRECTION') {
      const c = numList(e.args[1]);
      return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
    }
    if (e.type === 'VECTOR') return this.vector(id);
    return null;
  }

  /** VECTOR: 방향 × 크기 */
  vector(id: number): V3 | null {
    const e = this.f.get(id);
    if (!e) return null;
    if (e.type === 'DIRECTION') return this.direction(id);
    if (e.type !== 'VECTOR') return null;
    const d = this.direction(refId(e.args[1]));
    if (!d) return null;
    return scale(normalize(d), num(e.args[2], 1));
  }

  /** AXIS2_PLACEMENT_3D/2D, AXIS1_PLACEMENT → 좌표계 */
  frame(id: number): Frame | null {
    const e = this.f.get(id);
    if (!e) return null;
    const o = this.point(refId(e.args[1])) ?? [0, 0, 0];
    if (e.type === 'AXIS2_PLACEMENT_3D') {
      const z = e.args[2] instanceof StepRef ? this.direction(refId(e.args[2])) : null;
      const x = e.args[3] instanceof StepRef ? this.direction(refId(e.args[3])) : null;
      return makeFrame(o, z, x);
    }
    if (e.type === 'AXIS2_PLACEMENT_2D') {
      const x = e.args[2] instanceof StepRef ? this.direction(refId(e.args[2])) : null;
      return makeFrame(o, [0, 0, 1], x ? [x[0], x[1], 0] : null);
    }
    if (e.type === 'AXIS1_PLACEMENT') {
      const z = e.args[2] instanceof StepRef ? this.direction(refId(e.args[2])) : null;
      return makeFrame(o, z, null);
    }
    return null;
  }

  /**
   * 곡선. forEdge면 TRIMMED_CURVE를 바탕 곡선으로 돌려준다(모서리는 꼭짓점이 구간을 정한다).
   */
  curve(id: number, forEdge = true): Curve | null {
    const cache = forEdge ? this.edgeCurves : this.curves;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    cache.set(id, null); // 순환 참조 막기
    let c: Curve | null = null;
    try {
      c = this.buildCurve(id, forEdge);
    } catch {
      c = null;
    }
    cache.set(id, c);
    return c;
  }

  private buildCurve(id: number, forEdge: boolean): Curve | null {
    const e = this.f.get(id);
    if (!e) return null;
    const a = e.args;
    switch (e.type) {
      case 'LINE': {
        const p = this.point(refId(a[1]));
        const d = this.vector(refId(a[2]));
        return p && d && len(d) > 0 ? new LineCurve(p, d) : null;
      }
      case 'CIRCLE': {
        const f = this.frame(refId(a[1]));
        return f ? new CircleCurve(f, num(a[2])) : null;
      }
      case 'ELLIPSE': {
        const f = this.frame(refId(a[1]));
        return f ? new EllipseCurve(f, num(a[2]), num(a[3])) : null;
      }
      case 'PARABOLA': {
        const f = this.frame(refId(a[1]));
        return f ? new ParabolaCurve(f, num(a[2])) : null;
      }
      case 'HYPERBOLA': {
        const f = this.frame(refId(a[1]));
        return f ? new HyperbolaCurve(f, num(a[2]), num(a[3])) : null;
      }
      case 'POLYLINE': {
        const pts = refList(a[1])
          .map((r) => this.point(r))
          .filter((p): p is V3 => !!p);
        return pts.length >= 2 ? new PolylineCurve(pts) : null;
      }
      case 'SURFACE_CURVE':
      case 'SEAM_CURVE':
      case 'INTERSECTION_CURVE':
      case 'BOUNDED_SURFACE_CURVE': {
        const c3 = this.curve(refId(a[1]), forEdge);
        if (c3) return c3;
        for (const g of refList(a[2])) {
          const pc = this.curve(g, forEdge);
          if (pc) return pc;
        }
        return null;
      }
      case 'PCURVE':
      case 'BOUNDED_PCURVE': {
        const s = this.surface(refId(a[1]));
        const rep = this.f.get(refId(a[2]));
        const item = rep ? refList(rep.args[1])[0] : undefined;
        const c2 = item ? this.curve(item, false) : null;
        return s && c2 ? new SurfaceMappedCurve(c2, s) : null;
      }
      case 'TRIMMED_CURVE': {
        const basisId = refId(a[1]);
        const basis = this.curve(basisId, true);
        if (!basis) return null;
        if (forEdge) return basis;
        const conic = CONICS.has(this.f.typeOf(basisId));
        const trim = (v: StepValue | undefined): number => {
          let par = NaN;
          let pt: V3 | null = null;
          for (const x of list(v)) {
            if (x instanceof StepRef) pt = this.point(x.id);
            else if (x instanceof StepTyped) par = num(x.value) * (conic ? this.angleFactor : 1);
            else if (typeof x === 'number') par = x * (conic ? this.angleFactor : 1);
          }
          if (pt && (Number.isNaN(par) || enumOf(a[5]) !== 'PARAMETER')) return basis.project(pt);
          return par;
        };
        const t1 = trim(a[2]);
        let t2 = trim(a[3]);
        if (Number.isNaN(t1) || Number.isNaN(t2)) return basis;
        const sense = bool(a[4], true);
        if (basis.period > 0) {
          const P = basis.period;
          if (sense && t2 <= t1) t2 += Math.ceil((t1 - t2) / P + 1e-12) * P;
          if (!sense && t2 >= t1) t2 -= Math.ceil((t2 - t1) / P + 1e-12) * P;
        }
        return new TrimmedCurve(basis, t1, t2);
      }
      case 'COMPOSITE_CURVE':
      case 'COMPOSITE_CURVE_ON_SURFACE':
      case 'BOUNDARY_CURVE':
      case 'OUTER_BOUNDARY_CURVE': {
        const segs: Curve[] = [];
        for (const sid of refList(a[1])) {
          const s = this.f.get(sid);
          if (!s) continue;
          // COMPOSITE_CURVE_SEGMENT(transition, same_sense, parent_curve)
          const pc = this.curve(refId(s.args[2]), false);
          if (!pc || !Number.isFinite(pc.t0) || !Number.isFinite(pc.t1)) return null;
          const same = bool(s.args[1], true);
          segs.push(pc instanceof TrimmedCurve && same ? pc : new TrimmedCurve(pc, same ? pc.t0 : pc.t1, same ? pc.t1 : pc.t0));
        }
        return segs.length ? new CompositeCurve(segs) : null;
      }
      default:
        break;
    }
    if (e.type.includes('B_SPLINE_CURVE') || e.type.includes('BEZIER_CURVE') || e.type.includes('UNIFORM_CURVE') || e.parts) {
      const nc = this.nurbsCurve(e);
      if (nc) return new BSplineCurve(nc);
    }
    return this.miss(e.type);
  }

  private nurbsCurve(e: StepEntity): NurbsCurve | null {
    let degree: number;
    let ctrlIds: number[];
    let mults: number[] | null = null;
    let knots: number[] | null = null;
    let weights: number[] | null = null;
    let kind: 'knots' | 'bezier' | 'uniform' | 'quasi' = 'knots';
    if (e.parts) {
      const b = partOf(e, 'B_SPLINE_CURVE');
      if (!b) return null;
      degree = num(b.args[0]);
      ctrlIds = refList(b.args[1]);
      const wk = partOf(e, 'B_SPLINE_CURVE_WITH_KNOTS');
      if (wk) {
        mults = numList(wk.args[0]);
        knots = numList(wk.args[1]);
      } else if (partOf(e, 'BEZIER_CURVE')) kind = 'bezier';
      else if (partOf(e, 'UNIFORM_CURVE')) kind = 'uniform';
      else if (partOf(e, 'QUASI_UNIFORM_CURVE')) kind = 'quasi';
      else return null;
      const r = partOf(e, 'RATIONAL_B_SPLINE_CURVE');
      if (r) weights = numList(r.args[0]);
    } else {
      degree = num(e.args[1]);
      ctrlIds = refList(e.args[2]);
      if (e.type === 'B_SPLINE_CURVE_WITH_KNOTS') {
        mults = numList(e.args[6]);
        knots = numList(e.args[7]);
      } else if (e.type === 'BEZIER_CURVE') kind = 'bezier';
      else if (e.type === 'UNIFORM_CURVE') kind = 'uniform';
      else if (e.type === 'QUASI_UNIFORM_CURVE') kind = 'quasi';
      else return null;
    }
    const ctrl = ctrlIds.map((i) => this.point(i)).filter((p): p is V3 => !!p);
    if (ctrl.length < 2 || !(degree >= 1)) return null;
    const n = ctrl.length;
    const U =
      kind === 'knots'
        ? expandKnots(mults!, knots!, degree, n)
        : kind === 'bezier'
          ? bezierKnots(degree, n)
          : kind === 'uniform'
            ? uniformKnots(degree, n)
            : quasiUniformKnots(degree, n);
    if (U.length !== n + degree + 1) return null;
    return new NurbsCurve(degree, U, ctrl, weights);
  }

  surface(id: number): Surface | null {
    const hit = this.surfs.get(id);
    if (hit !== undefined) return hit;
    this.surfs.set(id, null);
    let s: Surface | null = null;
    try {
      s = this.buildSurface(id);
    } catch {
      s = null;
    }
    this.surfs.set(id, s);
    return s;
  }

  private buildSurface(id: number): Surface | null {
    const e = this.f.get(id);
    if (!e) return null;
    const a = e.args;
    switch (e.type) {
      case 'PLANE': {
        const f = this.frame(refId(a[1]));
        return f ? new PlaneSurface(f) : null;
      }
      case 'CYLINDRICAL_SURFACE': {
        const f = this.frame(refId(a[1]));
        return f ? new CylinderSurface(f, num(a[2])) : null;
      }
      case 'CONICAL_SURFACE': {
        const f = this.frame(refId(a[1]));
        return f ? new ConeSurface(f, num(a[2]), num(a[3]) * this.angleFactor) : null;
      }
      case 'SPHERICAL_SURFACE': {
        const f = this.frame(refId(a[1]));
        return f ? new SphereSurface(f, num(a[2])) : null;
      }
      case 'TOROIDAL_SURFACE':
      case 'DEGENERATE_TOROIDAL_SURFACE': {
        const f = this.frame(refId(a[1]));
        return f ? new TorusSurface(f, num(a[2]), num(a[3])) : null;
      }
      case 'SURFACE_OF_REVOLUTION': {
        const c = this.curve(refId(a[1]), true);
        const ax = this.f.get(refId(a[2]));
        if (!c || !ax) return null;
        const o = this.point(refId(ax.args[1])) ?? [0, 0, 0];
        const d = ax.args[2] instanceof StepRef ? this.direction(refId(ax.args[2])) : ([0, 0, 1] as V3);
        if (!d || len(d) === 0) return null;
        return new RevolutionSurface(c, o, normalize(d), curveSize(c) * 1e-6 + 1e-12);
      }
      case 'SURFACE_OF_LINEAR_EXTRUSION': {
        const c = this.curve(refId(a[1]), true);
        const v = this.vector(refId(a[2]));
        return c && v && len(v) > 0 ? new ExtrusionSurface(c, v) : null;
      }
      case 'OFFSET_SURFACE': {
        const b = this.surface(refId(a[1]));
        return b ? new OffsetSurface(b, num(a[2], 0)) : null;
      }
      case 'RECTANGULAR_TRIMMED_SURFACE':
      case 'CURVE_BOUNDED_SURFACE':
        return this.surface(refId(a[1]));
      default:
        break;
    }
    if (e.type.includes('B_SPLINE_SURFACE') || e.type.includes('BEZIER_SURFACE') || e.type.includes('UNIFORM_SURFACE') || e.parts) {
      const ns = this.nurbsSurface(e);
      if (ns) {
        let mn = [Infinity, Infinity, Infinity];
        let mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < ns.nu; i++)
          for (let j = 0; j < ns.nv; j++) {
            const p = ns.ctrl(i, j);
            mn = mn.map((m, k) => Math.min(m, p[k]!));
            mx = mx.map((m, k) => Math.max(m, p[k]!));
          }
        const diag = Math.hypot(mx[0]! - mn[0]!, mx[1]! - mn[1]!, mx[2]! - mn[2]!);
        return new BSplineSurface(ns, Math.max(1e-12, diag * 1e-6));
      }
    }
    return this.miss(e.type);
  }

  private nurbsSurface(e: StepEntity): NurbsSurface | null {
    let du: number;
    let dv: number;
    let ctrlV: StepValue | undefined;
    let um: number[] | null = null;
    let vm: number[] | null = null;
    let uk: number[] | null = null;
    let vk: number[] | null = null;
    let w: number[][] | null = null;
    let kind: 'knots' | 'bezier' | 'uniform' | 'quasi' = 'knots';
    if (e.parts) {
      const b = partOf(e, 'B_SPLINE_SURFACE');
      if (!b) return null;
      du = num(b.args[0]);
      dv = num(b.args[1]);
      ctrlV = b.args[2];
      const wk = partOf(e, 'B_SPLINE_SURFACE_WITH_KNOTS');
      if (wk) {
        um = numList(wk.args[0]);
        vm = numList(wk.args[1]);
        uk = numList(wk.args[2]);
        vk = numList(wk.args[3]);
      } else if (partOf(e, 'BEZIER_SURFACE')) kind = 'bezier';
      else if (partOf(e, 'UNIFORM_SURFACE')) kind = 'uniform';
      else if (partOf(e, 'QUASI_UNIFORM_SURFACE')) kind = 'quasi';
      else return null;
      const r = partOf(e, 'RATIONAL_B_SPLINE_SURFACE');
      if (r) w = list(r.args[0]).map((row) => numList(row));
    } else {
      du = num(e.args[1]);
      dv = num(e.args[2]);
      ctrlV = e.args[3];
      if (e.type === 'B_SPLINE_SURFACE_WITH_KNOTS') {
        um = numList(e.args[8]);
        vm = numList(e.args[9]);
        uk = numList(e.args[10]);
        vk = numList(e.args[11]);
      } else if (e.type === 'BEZIER_SURFACE') kind = 'bezier';
      else if (e.type === 'UNIFORM_SURFACE') kind = 'uniform';
      else if (e.type === 'QUASI_UNIFORM_SURFACE') kind = 'quasi';
      else return null;
    }
    const rows = list(ctrlV).map((row) => refList(row).map((i) => this.point(i) ?? ([0, 0, 0] as V3)));
    const nu = rows.length;
    const nv = rows[0]?.length ?? 0;
    if (nu < 2 || nv < 2 || !(du >= 1) || !(dv >= 1) || rows.some((r) => r.length !== nv)) return null;
    const mk = (deg: number, n: number, m: number[] | null, k: number[] | null) =>
      kind === 'knots' ? expandKnots(m!, k!, deg, n) : kind === 'bezier' ? bezierKnots(deg, n) : kind === 'uniform' ? uniformKnots(deg, n) : quasiUniformKnots(deg, n);
    const U = mk(du, nu, um, uk);
    const V = mk(dv, nv, vm, vk);
    if (U.length !== nu + du + 1 || V.length !== nv + dv + 1) return null;
    return new NurbsSurface(du, dv, U, V, rows, w);
  }
}

function curveSize(c: Curve): number {
  const a = Number.isFinite(c.t0) ? c.t0 : -1;
  const b = Number.isFinite(c.t1) ? c.t1 : 1;
  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i <= 8; i++) {
    const p = c.point(a + ((b - a) * i) / 8);
    mn = mn.map((m, k) => Math.min(m, p[k]!));
    mx = mx.map((m, k) => Math.max(m, p[k]!));
  }
  return Math.hypot(mx[0]! - mn[0]!, mx[1]! - mn[1]!, mx[2]! - mn[2]!);
}
