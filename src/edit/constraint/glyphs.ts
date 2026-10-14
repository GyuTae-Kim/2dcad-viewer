/**
 * 구속 표시: 구속 막대(아이콘)·일치 표식·동적 치수 구속(치수선·화살촉·"이름=값" 문자·자물쇠)을 월드 좌표 도형으로 만든다.
 * 화면 크기가 일정해야 하는 부분(아이콘·화살촉·문자 높이)은 pixelSize(1픽셀의 월드 길이)로 잰다. 그리기는 호출한 쪽이 한다.
 */
import type { BlockDef, CadDocument, Entity, Vec2 } from '../../core/model';
import { tableKey } from '../../core/model';
import { type UnitSettings, formatLength, unitSettings } from '../../core/units';
import { lineIntersection } from './make';
import { isNumberExpr } from './params';
import { type Curve, type Prim, curveOf, isPointPart, pointOf } from './prims';
import { readStore } from './store';
import { type SysBuild, buildSystem } from './system';
import type { Constraint, ConstraintStore, DimConstraint, GeoRef, GeoType } from './types';
import { constraintHandles, partIndex } from './types';

export interface GlyphText {
  x: number;
  y: number;
  text: string;
  /** 문자 높이(월드) */
  size: number;
  /** 가로 맞춤: 'left'면 (x, y)에서 오른쪽으로(자물쇠 칸 포함), 'right'면 왼쪽으로, 'center'면 가운데 */
  align: 'left' | 'center' | 'right';
  /** 구동 구속(자물쇠 아이콘을 글 앞에 그린다) */
  lock: boolean;
  /** 참조 구속(괄호) */
  reference: boolean;
  /** 구속 번호 */
  id: number;
}

export interface GlyphBar {
  /** 막대 사각형(월드) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  handle: string;
  /** 아이콘 순서대로의 구속 번호·종류 */
  items: { id: number; type: GeoType; x0: number; y0: number; x1: number; y1: number }[];
}

export interface ConstraintGlyphs {
  bars: GlyphBar[];
  /** 막대 안 아이콘 선분(월드 [x0, y0, x1, y1, …]) */
  icons: number[];
  /** 일치 표식 자리 */
  coincident: { p: Vec2; id: number }[];
  /** 치수 구속 선분(치수선·치수보조선·지시선) */
  dims: number[];
  /** 화살촉 삼각형 [x0, y0, x1, y1, x2, y2, …] */
  arrows: number[];
  /** 자물쇠 아이콘 선분(글 폭을 어림한 자리 — 캔버스에 그릴 때는 글 폭을 재서 다시 놓는 편이 정확하다) */
  locks: number[];
  texts: GlyphText[];
}

export interface GlyphOptions {
  /** 구속 막대(기본: 표시 상태 — CONSTRAINTBAR) */
  bars?: boolean;
  /** 동적 치수 구속(기본: 표시 상태 — DCDISPLAY) */
  dims?: boolean;
  units?: UnitSettings;
  /** 구속 기록(없으면 도면에서 읽는다) */
  store?: ConstraintStore;
}

// ---------------------------------------------------------------------------
// 표시 상태(도면마다, 저장하지 않는다)
// ---------------------------------------------------------------------------

const display = new WeakMap<CadDocument, { bars: boolean; dims: boolean }>();

export function constraintDisplay(doc: CadDocument): { bars: boolean; dims: boolean } {
  let d = display.get(doc);
  if (!d) {
    d = { bars: true, dims: true };
    display.set(doc, d);
  }
  return d;
}

export function setConstraintDisplay(doc: CadDocument, patch: Partial<{ bars: boolean; dims: boolean }>): void {
  Object.assign(constraintDisplay(doc), patch);
}

// ---------------------------------------------------------------------------
// 아이콘(단위 칸 0..1, y 위로)
// ---------------------------------------------------------------------------

function circlePts(cx: number, cy: number, r: number, n = 14): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** 꺾은선 목록 */
const ICONS: Record<GeoType, number[][]> = {
  HORIZONTAL: [
    [0.12, 0.5, 0.88, 0.5],
    [0.12, 0.38, 0.12, 0.62],
    [0.88, 0.38, 0.88, 0.62],
  ],
  VERTICAL: [
    [0.5, 0.12, 0.5, 0.88],
    [0.38, 0.12, 0.62, 0.12],
    [0.38, 0.88, 0.62, 0.88],
  ],
  PARALLEL: [
    [0.15, 0.15, 0.55, 0.85],
    [0.45, 0.15, 0.85, 0.85],
  ],
  PERPENDICULAR: [
    [0.12, 0.18, 0.88, 0.18],
    [0.5, 0.18, 0.5, 0.88],
  ],
  TANGENT: [circlePts(0.5, 0.36, 0.26), [0.08, 0.62, 0.92, 0.62]],
  SMOOTH: [[0.1, 0.2, 0.25, 0.22, 0.4, 0.32, 0.5, 0.5, 0.6, 0.68, 0.75, 0.78, 0.9, 0.8]],
  COINCIDENT: [[0.3, 0.3, 0.7, 0.3, 0.7, 0.7, 0.3, 0.7, 0.3, 0.3]],
  COLLINEAR: [
    [0.08, 0.2, 0.42, 0.46],
    [0.58, 0.58, 0.92, 0.84],
  ],
  CONCENTRIC: [circlePts(0.5, 0.5, 0.38), circlePts(0.5, 0.5, 0.16, 10)],
  FIX: [
    [0.22, 0.1, 0.78, 0.1, 0.78, 0.5, 0.22, 0.5, 0.22, 0.1],
    [0.32, 0.5, 0.32, 0.68, 0.38, 0.8, 0.5, 0.86, 0.62, 0.8, 0.68, 0.68, 0.68, 0.5],
  ],
  SYMMETRIC: [
    [0.5, 0.08, 0.5, 0.92],
    [0.36, 0.25, 0.12, 0.5, 0.36, 0.75],
    [0.64, 0.25, 0.88, 0.5, 0.64, 0.75],
  ],
  EQUAL: [
    [0.18, 0.36, 0.82, 0.36],
    [0.18, 0.64, 0.82, 0.64],
  ],
};

const LOCK: number[][] = [
  [0.15, 0.0, 0.85, 0.0, 0.85, 0.5, 0.15, 0.5, 0.15, 0.0],
  [0.28, 0.5, 0.28, 0.7, 0.36, 0.85, 0.5, 0.9, 0.64, 0.85, 0.72, 0.7, 0.72, 0.5],
];

/** 꺾은선 목록을 칸(x, y, 크기)에 펼쳐 선분으로 */
function strokes(out: number[], shapes: number[][], x: number, y: number, size: number): void {
  for (const s of shapes)
    for (let i = 0; i + 3 < s.length; i += 2) out.push(x + s[i]! * size, y + s[i + 1]! * size, x + s[i + 2]! * size, y + s[i + 3]! * size);
}

// ---------------------------------------------------------------------------
// 공간의 객체
// ---------------------------------------------------------------------------

const members = new WeakMap<BlockDef, { n: number; set: Set<string> }>();

function inBlock(doc: CadDocument, block: BlockDef, h: string): boolean {
  const e = doc.entityIndex.get(h);
  if (!e) return false;
  if (e.owner && block.recordHandle) return e.owner.toUpperCase() === block.recordHandle.toUpperCase();
  let m = members.get(block);
  if (!m || m.n !== block.entities.length) {
    m = { n: block.entities.length, set: new Set(block.entities.map((x) => x.handle)) };
    members.set(block, m);
  }
  return m.set.has(h);
}

/** 오버레이는 마우스가 움직일 때마다 다시 그리므로, 같은 기록·같은 객체면 변수 계산을 다시 쓴다 */
const sysCache = new WeakMap<ConstraintStore, { handles: string[]; ents: (Entity | undefined)[]; sys: SysBuild }>();

function cachedSystem(doc: CadDocument, store: ConstraintStore, handles: string[]): SysBuild {
  const c = sysCache.get(store);
  if (c && c.handles.length === handles.length && c.handles.every((h, i) => h === handles[i] && doc.entityIndex.get(h) === c.ents[i])) return c.sys;
  const sys = buildSystem((h) => doc.entityIndex.get(h), [], handles);
  sysCache.set(store, { handles, ents: handles.map((h) => doc.entityIndex.get(h)), sys });
  return sys;
}

// ---------------------------------------------------------------------------
// 만들기
// ---------------------------------------------------------------------------

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const unit = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const rot90 = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;

/** 치수 구속 글: 이름=식(식이 수면 값), 참조는 괄호 */
export function dimLabel(c: DimConstraint, units: UnitSettings): string {
  const val = c.type === 'ANGLE' ? `${Number(c.value.toFixed(Math.max(0, units.auprec)))}°` : formatLength(c.value, units);
  const body = c.reference || isNumberExpr(c.expr) ? `${c.name}=${val}` : `${c.name}=${c.expr}`;
  return c.reference ? `(${body})` : body;
}

/** 객체(또는 폴리선 세그먼트)의 막대 자리와 바깥 방향 */
function barAnchor(pr: Prim, part: string, x: number[]): { p: Vec2; n: Vec2 } | null {
  const seg = pr.k === 'poly' && part[0] === 'G' ? part : pr.k === 'poly' ? 'G0' : '';
  const cv: Curve | null = pr.k === 'point' || pr.k === 'spline' ? null : curveOf(pr, seg, x);
  if (pr.k === 'point') return { p: pointOf(pr, 'I', x)!, n: { x: 0.7071, y: -0.7071 } };
  if (pr.k === 'spline') {
    const i = pr.cp[pr.cp.length >> 1]!;
    return { p: { x: x[i]!, y: x[i + 1]! }, n: { x: 0, y: 1 } };
  }
  if (!cv) return null;
  if (cv.k === 'line') {
    const d = unit(sub(cv.b, cv.a));
    let n = rot90(d);
    if (n.y < 0 || (Math.abs(n.y) < 1e-9 && n.x > 0)) n = mul(n, -1);
    return { p: mul(add(cv.a, cv.b), 0.5), n };
  }
  if (cv.k === 'circle') {
    const a = cv.arc ? (cv.arc.a0 + cv.arc.a1) / 2 : Math.PI / 4;
    const n = { x: Math.cos(a), y: Math.sin(a) };
    return { p: add(cv.c, mul(n, cv.r)), n };
  }
  if (cv.k === 'ellipse') return { p: add(cv.c, cv.u), n: unit(cv.u) };
  return null;
}

/** 막대를 묶는 열쇠(폴리선은 세그먼트마다) */
function barKey(pr: Prim, r: GeoRef): string {
  if (pr.k !== 'poly') return r.h;
  const i = partIndex(r.part);
  if (r.part[0] === 'G' || r.part[0] === 'M' || r.part[0] === 'C') return `${r.h}|G${i}`;
  if (r.part[0] === 'V') return `${r.h}|G${Math.min(i, Math.max(0, (pr.closed ? pr.v.length : pr.v.length - 1) - 1))}`;
  return `${r.h}|G0`;
}

/**
 * 공간 space(블록 키)의 구속 표시 도형. pixelSize는 화면 1픽셀의 월드 길이.
 */
export function constraintGlyphs(doc: CadDocument, space: string, pixelSize: number, opt: GlyphOptions = {}): ConstraintGlyphs {
  const out: ConstraintGlyphs = { bars: [], icons: [], coincident: [], dims: [], arrows: [], locks: [], texts: [] };
  const store = opt.store ?? readStore(doc);
  if (!store.constraints.length || !(pixelSize > 0)) return out;
  const block = doc.blocks.get(tableKey(space));
  if (!block) return out;
  const disp = constraintDisplay(doc);
  const showBars = opt.bars ?? disp.bars;
  const showDims = opt.dims ?? disp.dims;
  const list = store.constraints.filter((c) => c.refs.every((r) => inBlock(doc, block, r.h)));
  if (!list.length) return out;
  const sys = cachedSystem(doc, store, [...new Set(list.flatMap(constraintHandles))]);
  const x = sys.vars.x;
  const px = pixelSize;
  const units = opt.units ?? unitSettings(doc);
  const hidden = new Set(store.hiddenBars);
  // 구속 막대
  if (showBars) {
    const groups = new Map<string, { pr: Prim; part: string; items: { id: number; type: GeoType }[] }>();
    for (const c of list) {
      if (c.kind !== 'geo') continue;
      if (c.type === 'COINCIDENT') {
        const r = c.refs.find((rr) => {
          const pr = sys.prims.get(rr.h);
          return pr && isPointPart(pr, rr.part);
        });
        const pr = r ? sys.prims.get(r.h) : undefined;
        const p = pr && r ? pointOf(pr, r.part, x) : null;
        if (p && !c.refs.every((rr) => hidden.has(rr.h))) out.coincident.push({ p, id: c.id });
        continue;
      }
      const seen = new Set<string>();
      for (const r of c.refs) {
        const pr = sys.prims.get(r.h);
        if (!pr || hidden.has(r.h)) continue;
        const k = barKey(pr, r);
        if (seen.has(k)) continue;
        seen.add(k);
        let g = groups.get(k);
        if (!g) {
          const part = pr.k === 'poly' ? k.split('|')[1]! : '';
          g = { pr, part, items: [] };
          groups.set(k, g);
        }
        g.items.push({ id: c.id, type: c.type });
      }
    }
    const icon = 16 * px;
    for (const [k, g] of groups) {
      const a = barAnchor(g.pr, g.part, x);
      if (!a) continue;
      const w = g.items.length * icon + 4 * px;
      const hgt = icon + 4 * px;
      const c = add(a.p, mul(a.n, 14 * px + hgt / 2));
      const bar: GlyphBar = { x0: c.x - w / 2, y0: c.y - hgt / 2, x1: c.x + w / 2, y1: c.y + hgt / 2, handle: k.split('|')[0]!, items: [] };
      g.items.forEach((it, i) => {
        const ix = bar.x0 + 2 * px + i * icon;
        const iy = bar.y0 + 2 * px;
        strokes(out.icons, ICONS[it.type], ix + 2 * px, iy + 2 * px, icon - 4 * px);
        bar.items.push({ id: it.id, type: it.type, x0: ix, y0: iy, x1: ix + icon, y1: iy + icon });
      });
      out.bars.push(bar);
    }
  }
  // 동적 치수 구속
  if (showDims) {
    const th = 12 * px;
    const arrow = (tip: Vec2, dir: Vec2) => {
      const d = unit(dir);
      const n = rot90(d);
      const b = sub(tip, mul(d, 9 * px));
      out.arrows.push(tip.x, tip.y, b.x + n.x * 2.6 * px, b.y + n.y * 2.6 * px, b.x - n.x * 2.6 * px, b.y - n.y * 2.6 * px);
    };
    const seg = (a: Vec2, b: Vec2) => out.dims.push(a.x, a.y, b.x, b.y);
    /** 글 자리: at에서 dir 쪽으로 붙인다(dir이 거의 수평이면 옆으로 맞춘다) */
    const label = (c: DimConstraint, at: Vec2, dir: Vec2 = { x: 0, y: 1 }) => {
      const text = dimLabel(c, units);
      const align: GlyphText['align'] = dir.x > 0.6 ? 'left' : dir.x < -0.6 ? 'right' : 'center';
      const p = align === 'center' ? add(at, mul(dir, th * 0.9)) : add(at, mul(dir, th * 0.5));
      out.texts.push({ x: p.x, y: p.y, text, size: th, align, lock: !c.reference, reference: c.reference, id: c.id });
      if (!c.reference) {
        const w = text.length * th * 0.55;
        const x0 = align === 'left' ? p.x : align === 'right' ? p.x - w - th * 1.1 : p.x - w / 2 - th * 1.1;
        strokes(out.locks, LOCK, x0, p.y - th * 0.45, th * 0.9);
      }
    };
    /** 두 점 사이 치수선(off: 법선 방향 거리) */
    const linear = (c: DimConstraint, p: Vec2, q: Vec2, pp: Vec2, qq: Vec2) => {
      const ext = (from: Vec2, to: Vec2) => {
        const d = sub(to, from);
        const L = len(d);
        if (L < 1e-12) return;
        const u = mul(d, 1 / L);
        seg(add(from, mul(u, Math.min(2 * px, L))), add(to, mul(u, 4 * px)));
      };
      ext(p, pp);
      ext(q, qq);
      seg(pp, qq);
      const d = sub(qq, pp);
      if (len(d) > 1e-12) {
        arrow(pp, mul(d, -1));
        arrow(qq, d);
      }
      // 글은 측정점에서 치수선 쪽으로 더 나간 자리(바깥)
      let n = rot90(unit(d));
      const away = sub(mul(add(pp, qq), 0.5), mul(add(p, q), 0.5));
      if (len(away) > 1e-12 ? dot(n, away) < 0 : n.y < 0) n = mul(n, -1);
      label(c, mul(add(pp, qq), 0.5), n);
    };
    for (const c of list) {
      if (c.kind !== 'dim' || c.hidden) continue;
      const R = c.refs;
      const P = (r: GeoRef) => {
        const pr = sys.prims.get(r.h);
        return pr ? pointOf(pr, r.part, x) : null;
      };
      const C = (r: GeoRef) => {
        const pr = sys.prims.get(r.h);
        return pr ? curveOf(pr, r.part, x) : null;
      };
      try {
        switch (c.type) {
          case 'DIST':
          case 'HDIST':
          case 'VDIST': {
            const p0 = P(R[0]!);
            const p1 = R[1] ? P(R[1]) : null;
            const ax = { x: Math.cos(c.axis ?? 0), y: Math.sin(c.axis ?? 0) };
            const ay = rot90(ax);
            if (p0 && p1) {
              if (c.type === 'DIST') {
                const n = rot90(unit(sub(p1, p0)));
                linear(c, p0, p1, add(p0, mul(n, c.offset)), add(p1, mul(n, c.offset)));
              } else {
                const m = mul(add(p0, p1), 0.5);
                const dir = c.type === 'HDIST' ? ay : ax;
                const k0 = dot(dir, sub(m, p0)) + c.offset;
                const k1 = dot(dir, sub(m, p1)) + c.offset;
                linear(c, p0, p1, add(p0, mul(dir, k0)), add(p1, mul(dir, k1)));
              }
              break;
            }
            // 점과 선, 두 선: 점(또는 둘째 선의 중간)에서 첫 선까지
            const l = (p0 ? C(R[1]!) : C(R[0]!)) as Curve | null;
            const from = p0 ?? (() => {
              const l2 = C(R[1]!) as { a: Vec2; b: Vec2 } | null;
              return l2 ? mul(add(l2.a, l2.b), 0.5) : null;
            })();
            if (!l || l.k !== 'line' || !from) break;
            const d = unit(sub(l.b, l.a));
            const foot = add(l.a, mul(d, dot(sub(from, l.a), d)));
            linear(c, from, foot, add(from, mul(d, c.offset)), add(foot, mul(d, c.offset)));
            break;
          }
          case 'RADIUS':
          case 'DIAMETER': {
            const cv = C(R[0]!);
            if (!cv || cv.k !== 'circle') break;
            const u = { x: Math.cos(c.offset), y: Math.sin(c.offset) };
            const q = add(cv.c, mul(u, cv.r));
            const s = c.type === 'DIAMETER' ? sub(cv.c, mul(u, cv.r)) : cv.c;
            seg(s, q);
            arrow(q, u);
            if (c.type === 'DIAMETER') arrow(s, mul(u, -1));
            const tip = add(q, mul(u, 14 * px));
            seg(q, tip);
            label(c, tip, u);
            break;
          }
          case 'ANGLE': {
            let o: Vec2 | null = null;
            let u: Vec2 | null = null;
            let w: Vec2 | null = null;
            if (R.length === 1) {
              const cv = C(R[0]!);
              if (!cv || cv.k !== 'circle' || !cv.arc) break;
              o = cv.c;
              u = { x: Math.cos(cv.arc.a0), y: Math.sin(cv.arc.a0) };
              w = { x: Math.cos(cv.arc.a1), y: Math.sin(cv.arc.a1) };
              const r = Math.max(c.offset, 1e-9);
              seg(add(o, mul(u, cv.r)), add(o, mul(u, r + 4 * px)));
              seg(add(o, mul(w, cv.r)), add(o, mul(w, r + 4 * px)));
            } else if (R.length === 3) {
              o = P(R[0]!);
              const a = P(R[1]!);
              const b = P(R[2]!);
              if (!o || !a || !b) break;
              u = unit(sub(a, o));
              w = unit(sub(b, o));
            } else {
              const l1 = C(R[0]!) as { a: Vec2; b: Vec2 } | null;
              const l2 = C(R[1]!) as { a: Vec2; b: Vec2 } | null;
              if (!l1 || !l2) break;
              o = lineIntersection(l1, l2);
              if (!o) break;
              u = mul(unit(sub(l1.b, l1.a)), c.aux?.[0] ?? 1);
              w = mul(unit(sub(l2.b, l2.a)), c.aux?.[1] ?? 1);
            }
            const r = Math.max(c.offset, 8 * px);
            const a0 = Math.atan2(u.y, u.x);
            let sw = Math.atan2(cross(u, w), dot(u, w));
            if (sw < 0) sw += Math.PI * 2;
            const n = Math.max(6, Math.ceil(sw / 0.1));
            let prev = add(o, mul(u, r));
            for (let i = 1; i <= n; i++) {
              const a = a0 + (sw * i) / n;
              const pt = { x: o.x + r * Math.cos(a), y: o.y + r * Math.sin(a) };
              seg(prev, pt);
              prev = pt;
            }
            const s0 = add(o, mul(u, r));
            const s1 = add(o, mul(w, r));
            arrow(s0, mul(rot90(u), -1));
            arrow(s1, rot90(w));
            const am = a0 + sw / 2;
            const um = { x: Math.cos(am), y: Math.sin(am) };
            label(c, add(o, mul(um, r)), um);
            break;
          }
        }
      } catch {
        /* 그릴 수 없는 구속은 건너뛴다 */
      }
    }
  }
  return out;
}

/** 월드 점에서 가장 가까운 구속 막대 아이콘(없으면 null) — 막대 위 클릭·끌기용 */
export function glyphAt(gl: ConstraintGlyphs, p: Vec2): { id: number; type: GeoType; handle: string } | null {
  for (const b of gl.bars) {
    if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) continue;
    for (const it of b.items) if (p.x >= it.x0 && p.x <= it.x1 && p.y >= it.y0 && p.y <= it.y1) return { id: it.id, type: it.type, handle: b.handle };
  }
  return null;
}

/** 구속을 이루는 객체(강조용) */
export function constraintTargets(c: Constraint): string[] {
  return constraintHandles(c);
}
