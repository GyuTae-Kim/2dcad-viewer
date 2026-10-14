/**
 * 객체 고르기: 범위 격자 색인 + 객체 형상과의 거리.
 * 형상은 메인 스레드에서 객체 하나씩 다시 만들어(장면 빌더) 캐시한다.
 */
import type { CadDocument, Entity } from '../core/model';
import { SceneBuilder } from '../render/build';
import type { DisplayList, EntityBox } from '../render/displaylist';
import { GLYPH_STRIDE, SEG_STRIDE, TRI_STRIDE } from '../render/displaylist';
import type { TextEngine } from '../text/layout';
import type { OverlayGeom, Pt } from './view';

export function expandDisplayList(dl: DisplayList): OverlayGeom {
  const segs: number[] = [];
  const tris: number[] = [];
  for (const c of dl.chunks) {
    for (const [buf, n] of [
      [c.segs, c.segCount],
      [c.tsegs, c.tsegCount],
    ] as const) {
      const f = new Float32Array(buf);
      for (let i = 0; i < n; i++) {
        const o = i * SEG_STRIDE;
        segs.push(f[o]! + c.ox, f[o + 1]! + c.oy, f[o + 2]! + c.ox, f[o + 3]! + c.oy);
      }
    }
    for (const [buf, n] of [
      [c.tris, c.triCount],
      [c.ttris, c.ttriCount],
    ] as const) {
      const f = new Float32Array(buf);
      for (let i = 0; i < n * 3; i++) {
        const o = i * TRI_STRIDE;
        tris.push(f[o]! + c.ox, f[o + 1]! + c.oy);
      }
    }
  }
  const gs = dl.glyphs;
  const inst = new Float32Array(gs.instances);
  for (const r of gs.runs) {
    const g = gs.glyphs[r.glyph]!;
    for (let k = r.start; k < r.start + r.count; k++) {
      const o = k * GLYPH_STRIDE;
      const a = inst[o]!;
      const b = inst[o + 1]!;
      const c = inst[o + 2]!;
      const d = inst[o + 3]!;
      const e = inst[o + 4]! + inst[o + 5]!;
      const f = inst[o + 6]! + inst[o + 7]!;
      if (g.kind === 0) {
        const v = gs.fillVerts;
        for (let i = g.first; i < g.first + g.count; i++) {
          const x = v[i * 2]!;
          const y = v[i * 2 + 1]!;
          tris.push(a * x + c * y + e, b * x + d * y + f);
        }
      } else {
        const v = gs.strokeSegs;
        for (let i = g.first; i < g.first + g.count; i++) {
          const x0 = v[i * 4]!;
          const y0 = v[i * 4 + 1]!;
          const x1 = v[i * 4 + 2]!;
          const y1 = v[i * 4 + 3]!;
          segs.push(a * x0 + c * y0 + e, b * x0 + d * y0 + f, a * x1 + c * y1 + e, b * x1 + d * y1 + f);
        }
      }
    }
  }
  return { segs, tris };
}

function distSeg(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

function inTri(px: number, py: number, t: number[], i: number): boolean {
  const ax = t[i]!;
  const ay = t[i + 1]!;
  const bx = t[i + 2]!;
  const by = t[i + 3]!;
  const cx = t[i + 4]!;
  const cy = t[i + 5]!;
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function segRect(x0: number, y0: number, x1: number, y1: number, r: [number, number, number, number]): boolean {
  // 리앙-바스키 자르기
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, x0 - r[0]) && clip(dx, r[2] - x0) && clip(-dy, y0 - r[1]) && clip(dy, r[3] - y0);
}

export class Picker {
  private grid = new Map<string, number[]>();
  private cell = 1;
  private readonly cache = new Map<string, OverlayGeom>();
  private builder: SceneBuilder;
  /** 핸들 → 그리기 순서 */
  private readonly order = new Map<string, number>();

  constructor(
    private readonly doc: CadDocument,
    readonly boxes: EntityBox[],
    text: TextEngine,
    space: string,
  ) {
    this.builder = new SceneBuilder(doc, { text });
    this.builder.prepare(space);
    boxes.forEach((b, i) => this.order.set(b.handle, i));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    this.cell = span / Math.max(8, Math.min(256, Math.sqrt(boxes.length) * 2));
    boxes.forEach((b, i) => {
      const x0 = Math.floor(b.minX / this.cell);
      const x1 = Math.floor(b.maxX / this.cell);
      const y0 = Math.floor(b.minY / this.cell);
      const y1 = Math.floor(b.maxY / this.cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
        // 아주 큰 객체는 따로
        this.push('big', i);
        return;
      }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.push(`${x},${y}`, i);
    });
  }

  private push(k: string, i: number): void {
    let l = this.grid.get(k);
    if (!l) {
      l = [];
      this.grid.set(k, l);
    }
    l.push(i);
  }

  /** 점 근처(tol 안)의 후보 */
  candidates(x: number, y: number, tol: number): EntityBox[] {
    const out = new Set<number>();
    const x0 = Math.floor((x - tol) / this.cell);
    const x1 = Math.floor((x + tol) / this.cell);
    const y0 = Math.floor((y - tol) / this.cell);
    const y1 = Math.floor((y + tol) / this.cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) {
      this.boxes.forEach((b, i) => {
        if (b.minX - tol <= x && b.maxX + tol >= x && b.minY - tol <= y && b.maxY + tol >= y) out.add(i);
      });
    } else {
      for (let gx = x0; gx <= x1; gx++)
        for (let gy = y0; gy <= y1; gy++)
          for (const i of this.grid.get(`${gx},${gy}`) ?? []) {
            const b = this.boxes[i]!;
            if (b.minX - tol <= x && b.maxX + tol >= x && b.minY - tol <= y && b.maxY + tol >= y) out.add(i);
          }
      for (const i of this.grid.get('big') ?? []) {
        const b = this.boxes[i]!;
        if (b.minX - tol <= x && b.maxX + tol >= x && b.minY - tol <= y && b.maxY + tol >= y) out.add(i);
      }
    }
    return [...out].map((i) => this.boxes[i]!);
  }

  geometry(handle: string): OverlayGeom {
    let g = this.cache.get(handle);
    if (!g) {
      const e = this.doc.entityIndex.get(handle);
      g = e ? expandDisplayList(this.builder.buildEntities([e])) : { segs: [], tris: [] };
      if (this.cache.size > 4000) this.cache.clear();
      this.cache.set(handle, g);
    }
    return g;
  }

  distance(handle: string, x: number, y: number): number {
    const g = this.geometry(handle);
    let best = Infinity;
    const s = g.segs;
    for (let i = 0; i + 3 < s.length; i += 4) {
      const d = distSeg(x, y, s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!);
      if (d < best) best = d;
    }
    const t = g.tris ?? [];
    for (let i = 0; i + 5 < t.length; i += 6) if (inTri(x, y, t, i)) return 0;
    return best;
  }

  /** 가장 가까운 객체 */
  pick(x: number, y: number, tol: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    let bestOrder = -1;
    for (const b of this.candidates(x, y, tol)) {
      const d = this.distance(b.handle, x, y);
      if (d > tol) continue;
      const ord = this.order.get(b.handle) ?? 0;
      if (d < bestD - tol * 0.05 || (Math.abs(d - bestD) <= tol * 0.05 && ord > bestOrder)) {
        best = b.handle;
        bestD = d;
        bestOrder = ord;
      }
    }
    return best;
  }

  /** 창 선택(window = 완전히 안, 아니면 걸침) */
  select(r: [number, number, number, number], crossing: boolean): string[] {
    const out: string[] = [];
    for (const b of this.boxes) {
      if (b.maxX < r[0] || b.minX > r[2] || b.maxY < r[1] || b.minY > r[3]) continue;
      const inside = b.minX >= r[0] && b.maxX <= r[2] && b.minY >= r[1] && b.maxY <= r[3];
      if (inside) {
        out.push(b.handle);
        continue;
      }
      if (!crossing) continue;
      const g = this.geometry(b.handle);
      let hit = false;
      const s = g.segs;
      for (let i = 0; i + 3 < s.length && !hit; i += 4) hit = segRect(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!, r);
      const t = g.tris ?? [];
      for (let i = 0; i + 5 < t.length && !hit; i += 6) {
        for (let k = 0; k < 3 && !hit; k++) {
          const j = i + k * 2;
          const n = i + ((k + 1) % 3) * 2;
          hit = segRect(t[j]!, t[j + 1]!, t[n]!, t[n + 1]!, r);
        }
        if (!hit) hit = inTri(r[0], r[1], t, i);
      }
      if (hit) out.push(b.handle);
    }
    return out;
  }

  entity(handle: string): Entity | undefined {
    return this.doc.entityIndex.get(handle);
  }

  box(handle: string): EntityBox | undefined {
    const i = this.order.get(handle);
    return i === undefined ? undefined : this.boxes[i];
  }

  /** 점 근처 선분들(스냅 교차점·근처점용) */
  segmentsNear(x: number, y: number, tol: number, limit = 4000): number[] {
    const out: number[] = [];
    for (const b of this.candidates(x, y, tol)) {
      const s = this.geometry(b.handle).segs;
      for (let i = 0; i + 3 < s.length; i += 4) {
        if (distSeg(x, y, s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!) <= tol) out.push(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!);
        if (out.length > limit * 4) return out;
      }
    }
    return out;
  }

  /** 선택한 객체의 그립 위치 */
  static pointNear(a: Pt, b: Pt, tol: number): boolean {
    return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  }
}
