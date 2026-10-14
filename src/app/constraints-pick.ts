/**
 * 구속 명령의 고르기 도우미: 구속점(끝점·중간점·중심·정점)과 구속할 곡선(선·원·호·폴리선 세그먼트) 고르기,
 * 고른 것 강조, 구속 결과 적용(같은 명령 취소 묶음).
 */
import type { Entity, Vec2 } from '../core/model';
import { tableKey } from '../core/model';
import { readStore, storeOps } from '../edit/constraint/store';
import { buildSystem } from '../edit/constraint/system';
import { type Prim, curveOf, isPointPart, pointOf, unsupportedReason } from '../edit/constraint/prims';
import type { RefShape } from '../edit/constraint/equations';
import type { ConstraintStore, GeoRef } from '../edit/constraint/types';
import type { App, CommandContext, Keyword } from './app';
import { commitResults } from './modify';
import type { OverlayGeom, Pt } from './view';

export interface Picked {
  ref: GeoRef;
  /** 누른 자리 */
  at: Pt;
  shape: RefShape;
  /** 점 부분이면 그 좌표 */
  point?: Vec2;
}

export type PickResult = Picked | { keyword: string } | { enter: true };

/** 원하는 곡선 종류 */
export type Want = 'line' | 'circle' | 'curve' | 'lineOrCircle' | 'spline' | 'object';

const WANT_MSG: Record<Want, string> = {
  line: '선을 선택해야 합니다.',
  circle: '호 또는 원을 선택해야 합니다.',
  curve: '선, 호, 원, 타원 또는 폴리선을 선택해야 합니다.',
  lineOrCircle: '선, 호 또는 원을 선택해야 합니다.',
  spline: '스플라인을 선택해야 합니다.',
  object: '객체를 선택해야 합니다.',
};

/** 명령 하나 동안 고른 것을 강조한다 */
export class Highlight {
  private geoms: OverlayGeom[] = [];
  private marks: { p: Pt }[] = [];
  constructor(private readonly app: App) {}

  add(h: string): void {
    const g = this.app.geometryOf(h);
    if (g) this.geoms.push(g);
    this.show();
  }

  mark(p: Pt): void {
    this.marks.push({ p });
    this.show();
  }

  get ghost(): () => OverlayGeom[] {
    return () => this.geoms;
  }

  show(): void {
    const o = this.app.view.overlay;
    o.ghost = this.geoms;
    o.marks = this.marks;
    this.app.view.requestOverlay();
  }

  clear(): void {
    this.geoms = [];
    this.marks = [];
    this.show();
  }
}

function primOf(app: App, h: string): { prim: Prim; x: number[] } | null {
  const st = app.active!;
  const sys = buildSystem((k) => st.doc.entityIndex.get(k), [], [h]);
  const prim = sys.prims.get(h);
  return prim ? { prim, x: sys.vars.x } : null;
}

/** 객체의 점 부분 목록 */
export function pointPartsOf(prim: Prim): string[] {
  switch (prim.k) {
    case 'point':
      return ['I'];
    case 'line':
      return ['S', 'E', 'M'];
    case 'circle':
      return ['C'];
    case 'arc':
      return ['S', 'E', 'M', 'C'];
    case 'ellipse':
      return prim.closed ? ['C'] : ['S', 'E', 'C'];
    case 'spline':
      return ['S', 'E'];
    case 'poly': {
      const out = prim.v.map((_, i) => `V${i}`);
      const segs = prim.closed ? prim.v.length : prim.v.length - 1;
      for (let i = 0; i < segs; i++) {
        out.push(`M${i}`);
        if (prim.b[i]! >= 0) out.push(`C${i}`);
      }
      return out;
    }
  }
}

/** 가장 가까운 점 부분 */
export function nearestPointPart(app: App, h: string, at: Vec2): { part: string; p: Vec2; d: number } | null {
  const pr = primOf(app, h);
  if (!pr) return null;
  let best: { part: string; p: Vec2; d: number } | null = null;
  for (const part of pointPartsOf(pr.prim)) {
    if (!isPointPart(pr.prim, part)) continue;
    const p = pointOf(pr.prim, part, pr.x);
    if (!p) continue;
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (!best || d < best.d) best = { part, p, d };
  }
  return best;
}

/** 점에서 곡선까지 거리 */
function curveDist(cv: NonNullable<ReturnType<typeof curveOf>>, p: Vec2): number {
  if (cv.k === 'line') {
    const dx = cv.b.x - cv.a.x;
    const dy = cv.b.y - cv.a.y;
    const L2 = dx * dx + dy * dy || 1e-300;
    const t = Math.max(0, Math.min(1, ((p.x - cv.a.x) * dx + (p.y - cv.a.y) * dy) / L2));
    return Math.hypot(p.x - cv.a.x - dx * t, p.y - cv.a.y - dy * t);
  }
  if (cv.k === 'circle') return Math.abs(Math.hypot(p.x - cv.c.x, p.y - cv.c.y) - cv.r);
  if (cv.k === 'ellipse') return Math.abs(Math.hypot(p.x - cv.c.x, p.y - cv.c.y) - Math.hypot(cv.u.x, cv.u.y));
  return Infinity;
}

/** 객체의 곡선 부분(폴리선은 누른 자리에서 가장 가까운 세그먼트) */
export function curvePartAt(app: App, h: string, at: Vec2): { part: string; shape: RefShape } | null {
  const pr = primOf(app, h);
  if (!pr) return null;
  const p = pr.prim;
  if (p.k === 'point') return null;
  if (p.k === 'spline') return { part: '', shape: 'spline' };
  if (p.k !== 'poly') {
    const cv = curveOf(p, '', pr.x);
    return cv ? { part: '', shape: cv.k } : null;
  }
  let best: { part: string; shape: RefShape; d: number } | null = null;
  for (let i = 0; i < p.b.length; i++) {
    const cv = curveOf(p, `G${i}`, pr.x);
    if (!cv) continue;
    const d = curveDist(cv, at);
    if (!best || d < best.d) best = { part: `G${i}`, shape: cv.k, d };
  }
  return best ? { part: best.part, shape: best.shape } : null;
}

function wantOk(want: Want, shape: RefShape): boolean {
  switch (want) {
    case 'line':
      return shape === 'line';
    case 'circle':
      return shape === 'circle';
    case 'lineOrCircle':
      return shape === 'line' || shape === 'circle';
    case 'spline':
      return shape === 'spline';
    case 'curve':
      return shape === 'line' || shape === 'circle' || shape === 'ellipse';
    case 'object':
      return true;
  }
}

/** 구속할 객체(곡선) 고르기 */
export async function pickCurve(app: App, ctx: CommandContext, prompt: string, want: Want, hl: Highlight, keywords: Keyword[] = []): Promise<PickResult> {
  for (;;) {
    hl.show();
    const r = await ctx.getEntity(prompt, keywords);
    if (!('handle' in r)) return r;
    const e = app.entity(r.handle);
    if (!e) continue;
    const why = unsupportedReason(e);
    if (why) {
      ctx.print(why, 'err');
      continue;
    }
    if (want === 'object') {
      const pr = primOf(app, r.handle);
      // 점·문자·블록 참조는 삽입점, 폴리선은 누른 세그먼트, 그 밖은 객체 전체
      if (pr?.prim.k === 'point') {
        hl.add(r.handle);
        return { ref: { h: r.handle, part: 'I' }, at: r.point, shape: 'point', point: pointOf(pr.prim, 'I', pr.x) ?? undefined };
      }
      const cp = e.type === 'LWPOLYLINE' || e.type === 'POLYLINE' ? curvePartAt(app, r.handle, r.point) : null;
      hl.add(r.handle);
      return { ref: { h: r.handle, part: cp?.part ?? '' }, at: r.point, shape: cp?.shape ?? null };
    }
    const cp = curvePartAt(app, r.handle, r.point);
    if (!cp || !wantOk(want, cp.shape)) {
      ctx.print(WANT_MSG[want], 'err');
      continue;
    }
    hl.add(r.handle);
    return { ref: { h: r.handle, part: cp.part }, at: r.point, shape: cp.shape };
  }
}

/** 구속점 고르기: 점을 누르면(객체 스냅 적용) 그 근처 객체의 가장 가까운 구속점 */
export async function pickPoint(app: App, ctx: CommandContext, prompt: string, hl: Highlight, keywords: Keyword[] = []): Promise<PickResult> {
  const st = app.active!;
  for (;;) {
    hl.show();
    const r = await ctx.getPoint(prompt, { keywords, ghost: hl.ghost });
    if ('keyword' in r || 'enter' in r) return r;
    if (!('point' in r)) continue;
    const at = r.point;
    const pk = app.picker();
    const tol = Math.max(app.view.overlay.pickbox, 10) * app.view.pixelSize();
    let best: { h: string; part: string; p: Vec2; d: number } | null = null;
    const derived = (x: { h: string; part: string }) => derivedPart(app, x.h, x.part);
    for (const b of pk?.candidates(at.x, at.y, tol) ?? []) {
      const e = st.doc.entityIndex.get(b.handle);
      if (!e || unsupportedReason(e)) continue;
      const l = st.doc.layers.get(tableKey(e.layer));
      if (l && (l.off || l.frozen)) continue;
      const n = nearestPointPart(app, b.handle, at);
      if (!n || n.d > tol) continue;
      // 거의 같은 거리면 변수인 점(선 끝·정점·중심)을 호 끝·중간점처럼 계산되는 점보다 먼저
      const tie = best && Math.abs(n.d - best.d) <= 1e-9 * Math.max(1, tol);
      if (!best || (!tie && n.d < best.d) || (tie && derived(best) && !derivedPart(app, b.handle, n.part))) best = { h: b.handle, ...n };
    }
    if (!best) {
      ctx.print('구속점을 찾지 못했습니다. 객체의 끝점·중간점·중심 가까이를 누르십시오.', 'err');
      continue;
    }
    hl.add(best.h);
    hl.mark(best.p);
    return { ref: { h: best.h, part: best.part }, at, shape: 'point', point: best.p };
  }
}

/** 계산되는 점(호 끝·중간점, 선 중간점, 폴리선 세그먼트 중간·중심)인지 */
function derivedPart(app: App, h: string, part: string): boolean {
  const pr = primOf(app, h);
  if (!pr) return true;
  const k = pr.prim.k;
  if (k === 'arc' || k === 'ellipse') return part !== 'C';
  if (k === 'line') return part === 'M';
  if (k === 'poly') return part[0] !== 'V';
  return false;
}

/** 객체의 가장 가까운 끝(스플라인·선·호·열린 폴리선) */
export function nearestEnd(app: App, h: string, at: Vec2): { part: string; p: Vec2 } | null {
  const pr = primOf(app, h);
  if (!pr) return null;
  const p = pr.prim;
  const ends = p.k === 'poly' ? (p.closed ? [] : ['V0', `V${p.v.length - 1}`]) : p.k === 'line' || p.k === 'arc' || p.k === 'spline' ? ['S', 'E'] : [];
  let best: { part: string; p: Vec2; d: number } | null = null;
  for (const part of ends) {
    const q = pointOf(p, part, pr.x);
    if (!q) continue;
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (!best || d < best.d) best = { part, p: q, d };
  }
  return best;
}

/** 참조(점 부분)의 지금 좌표 */
export function refPoint(app: App, r: GeoRef): Vec2 | null {
  const pr = primOf(app, r.h);
  return pr && isPointPart(pr.prim, r.part) ? pointOf(pr.prim, r.part, pr.x) : null;
}

/** 잠긴 도면층의 객체 */
export function lockedHandles(app: App, handles: Iterable<string>): Set<string> {
  const st = app.active!;
  const out = new Set<string>();
  for (const h of handles) {
    const e = st.doc.entityIndex.get(h);
    if (e && st.doc.layers.get(tableKey(e.layer))?.locked) out.add(h);
  }
  return out;
}

/** 지금 구속 기록에 걸린 모든 객체 가운데 잠긴 것 */
export function lockedInStore(app: App): Set<string> {
  return lockedHandles(app, new Set(readStore(app.active!.doc).constraints.flatMap((c) => c.refs.map((r) => r.h))));
}

/**
 * 풀이 결과 적용: 구속 기록을 먼저 쓰고, 바뀐 객체를 commitResults로(연관 해치·치수도 따라간다). 같은 명령 취소 묶음이다.
 */
export function commitOutcome(app: App, ctx: CommandContext, label: string, out: { entities: ReadonlyMap<string, Entity>; store: ConstraintStore | null }): boolean {
  const st = app.active!;
  if (out.store) {
    const ops = storeOps(st.doc, out.store, () => st.session.newHandle());
    if (ops === null) {
      ctx.print('도면에 이름 있는 객체 사전이 없어 구속조건을 저장할 수 없습니다.', 'err');
      return false;
    }
    if (ops.length) st.session.commit({ label, ops, group: ctx.group });
  }
  if (out.entities.size) commitResults(app, ctx, [{ replace: [...out.entities.values()] }], label, { quiet: true });
  app.view.requestOverlay();
  return true;
}
