/**
 * 치수 덧붙임 기록: 선형 꺾기선(DIMJOGLINE)과 치수 끊기(DIMBREAK).
 * 치수 블록을 다시 만들 때마다(generateDimensionGeometry) 기록대로 그림을 고친다. 기록이 없으면 아무것도 하지 않는다.
 *
 * - 꺾기선: AutoCAD와 같은 확장 데이터 ACAD_DSTYLE_DIMJAG_POSITION = 1070 387, 1070 플래그, 1070 389, 1010 점(WCS).
 *   플래그 1 = 꺾기 있음, 2 = 사용자 위치(꺾기를 지우면 2만 남는다). 사용자 위치는 이 앱 기록 OPENCAD_DIMJOG에도
 *   치수 기준 좌표로 둔다(치수를 옮기거나 돌려도 같은 자리에 오게). 높이 = 꺾기 높이 계수 × 문자 높이, 두 꼭지 각 40°.
 * - 끊기: 이 앱 기록 OPENCAD_DIMBREAK. 객체 끊기(1000 "OBJ", 1005 끊는 객체 핸들)는 그릴 때마다 지금 만나는 곳을 다시 구하고,
 *   수동 끊기(1000 "MAN", 1040 × 4 치수 기준 좌표)는 치수와 함께 움직인다. AutoCAD는 끊기를 확장 사전의 BREAKDATA 객체에 둔다.
 * - 끊기 크기: 치수 스타일 확장 데이터 ACAD_DSTYLE_DIMBREAK(1070 391, 1040 크기) × DIMSCALE, 없으면 미터법 3.75·영국식 0.125.
 * - 꺾기 높이 계수: ACAD_DSTYLE_DIMJAG(1070 388, 1040 계수)를 치수 → 스타일 순으로 찾고, 없으면 1.5.
 */
import type { ArcEntity, CadDocument, DimensionEntity, Entity, LineEntity, Vec3, XData } from '../../core/model';
import { tableKey } from '../../core/model';
import type { ArcPiece, LinePiece, Piece } from '../geom/curve';
import { edgePieces } from '../geom/edges';
import { intersectAll } from '../geom/intersect';
import type { Out } from './builder';
import { type P, TAU, add, ang, cross, dir, dist, dot, intersect, madd, mid, mul, norm2pi, p, perp, project, sub, unit } from './vec';

export const JOG_APP = 'ACAD_DSTYLE_DIMJAG_POSITION';
export const JOG_REL_APP = 'OPENCAD_DIMJOG';
export const BREAK_APP = 'OPENCAD_DIMBREAK';

/** 끊는 객체가 될 수 있는 종류(문자·블록 참조·해치는 아니다) */
export const BREAKER_TYPES = new Set(['LINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'LWPOLYLINE', 'POLYLINE', 'SPLINE', 'XLINE', 'RAY', 'DIMENSION', 'LEADER', 'MULTILEADER', 'MLINE']);

type XD = Pick<DimensionEntity, 'xdata'>;

const app = (d: XD, name: string): XData | undefined => d.xdata?.find((x) => x.app.toUpperCase() === name);

/** 다른 앱 기록은 두고 name 앱 기록을 바꾼다(items가 null이면 지운다) */
export function replaceXData(xdata: XData[] | undefined, name: string, items: XData['items'] | null): XData[] | undefined {
  const rest = (xdata ?? []).filter((x) => x.app.toUpperCase() !== name.toUpperCase()).map((x) => ({ app: x.app, items: [...x.items] }));
  if (items && items.length) rest.push({ app: name, items });
  return rest.length ? rest : undefined;
}

// ---------------------------------------------------------------------------
// 치수 기준 좌표: 정의점 둘이 만드는 틀(이동·회전·균일 축척을 따라간다)
// ---------------------------------------------------------------------------

export interface Frame {
  o: P;
  x: P;
}

/** 치수 종류마다 함께 움직이는 정의점 둘로 만든 틀(WCS) */
export function dimFrame(d: DimensionEntity): Frame {
  const P2 = (q: Vec3): P => p(q.x, q.y);
  let o: P;
  let to: P;
  if (d.subtype === 'ARC_DIMENSION') {
    o = P2(d.arc?.center ?? d.defPoint4);
    to = P2(d.defPoint2);
  } else if (d.subtype === 'LARGE_RADIAL_DIMENSION') {
    o = P2(d.defPoint);
    to = P2(d.defPoint4);
  } else
    switch (d.dimType & 7) {
      case 5:
        o = P2(d.defPoint4);
        to = P2(d.defPoint2);
        break;
      case 3:
      case 4:
        o = P2(d.defPoint);
        to = P2(d.defPoint4);
        break;
      default:
        o = P2(d.defPoint2);
        to = P2(d.defPoint3);
    }
  let x = sub(to, o);
  if (Math.hypot(x.x, x.y) < 1e-12) x = p(1, 0);
  return { o, x };
}

export function toFrame(f: Frame, q: P): P {
  const l2 = dot(f.x, f.x);
  const d = sub(q, f.o);
  return p(dot(d, f.x) / l2, dot(d, perp(f.x)) / l2);
}

export function fromFrame(f: Frame, l: P): P {
  return add(add(f.o, mul(f.x, l.x)), mul(perp(f.x), l.y));
}

// ---------------------------------------------------------------------------
// 꺾기선 기록
// ---------------------------------------------------------------------------

export interface JogLine {
  /** 꺾기가 있다 */
  on: boolean;
  /** 사용자가 정한 위치(아니면 첫째 치수보조선과 문자의 가운데) */
  user: boolean;
  /** 꺾기 가운데(WCS). 이 앱 기록이 있으면 그 좌표로 다시 구한 값 */
  point: P | null;
}

export function readJogLine(d: DimensionEntity): JogLine | null {
  const x = app(d, JOG_APP);
  if (!x) return null;
  let flag = 0;
  let point: P | null = null;
  const it = x.items;
  for (let i = 0; i + 1 < it.length; i++) {
    if (it[i]!.code !== 1070) continue;
    const key = Number(it[i]!.value);
    const v = it[i + 1]!;
    if (key === 387 && v.code === 1070) flag = Number(v.value) | 0;
    else if (key === 389 && v.code >= 1010 && v.code <= 1013 && typeof v.value === 'object' && !(v.value instanceof Uint8Array)) point = p(v.value.x, v.value.y);
  }
  const rel = app(d, JOG_REL_APP);
  if (rel) {
    const nums = rel.items.filter((i) => i.code === 1040).map((i) => Number(i.value));
    if (nums.length >= 2 && nums.every(Number.isFinite)) point = fromFrame(dimFrame(d), p(nums[0]!, nums[1]!));
  }
  return { on: (flag & 1) !== 0, user: (flag & 2) !== 0, point };
}

/**
 * 꺾기선 기록을 넣은 새 확장 데이터. point가 없으면 기본 위치(플래그 1), 있으면 사용자 위치(플래그 3).
 * remove면 AutoCAD처럼 플래그 2만 남긴다.
 */
export function writeJogLine(d: DimensionEntity, jog: { point: P | null; defaultPoint: P } | 'remove'): XData[] | undefined {
  if (jog === 'remove') {
    const prev = readJogLine(d);
    if (!prev) return d.xdata;
    const items: XData['items'] = [
      { code: 1070, value: 387 },
      { code: 1070, value: 2 },
      { code: 1070, value: 389 },
      { code: 1010, value: { x: prev.point?.x ?? 0, y: prev.point?.y ?? 0, z: 0 } },
    ];
    return replaceXData(replaceXData(d.xdata, JOG_APP, items), JOG_REL_APP, null);
  }
  const at = jog.point ?? jog.defaultPoint;
  const items: XData['items'] = [
    { code: 1070, value: 387 },
    { code: 1070, value: jog.point ? 3 : 1 },
    { code: 1070, value: 389 },
    { code: 1010, value: { x: at.x, y: at.y, z: d.defPoint.z } },
  ];
  let x = replaceXData(d.xdata, JOG_APP, items);
  if (jog.point) {
    const l = toFrame(dimFrame(d), jog.point);
    x = replaceXData(x, JOG_REL_APP, [
      { code: 1040, value: l.x },
      { code: 1040, value: l.y },
    ]);
  } else x = replaceXData(x, JOG_REL_APP, null);
  return x;
}

// ---------------------------------------------------------------------------
// 끊기 기록
// ---------------------------------------------------------------------------

export type DimBreak = { kind: 'object'; handle: string } | { kind: 'manual'; a: P; b: P };

/** 끊기 목록(수동 끊기의 a·b는 치수 기준 좌표) */
export function readBreaks(d: XD): DimBreak[] {
  const x = app(d, BREAK_APP);
  if (!x) return [];
  const out: DimBreak[] = [];
  const it = x.items;
  for (let i = 0; i < it.length; i++) {
    const k = it[i]!;
    if (k.code !== 1000) continue;
    if (k.value === 'OBJ' && it[i + 1]?.code === 1005) {
      out.push({ kind: 'object', handle: String(it[i + 1]!.value).toUpperCase() });
      i++;
    } else if (k.value === 'MAN') {
      const n = it.slice(i + 1, i + 5);
      if (n.length === 4 && n.every((q) => q.code === 1040 && Number.isFinite(Number(q.value)))) {
        const v = n.map((q) => Number(q.value));
        out.push({ kind: 'manual', a: p(v[0]!, v[1]!), b: p(v[2]!, v[3]!) });
        i += 4;
      }
    }
  }
  return out;
}

export function writeBreaks(d: XD, list: readonly DimBreak[]): XData[] | undefined {
  const items: XData['items'] = [];
  const seen = new Set<string>();
  for (const b of list) {
    if (b.kind === 'object') {
      if (seen.has(b.handle)) continue;
      seen.add(b.handle);
      items.push({ code: 1000, value: 'OBJ' }, { code: 1005, value: b.handle });
    } else
      items.push(
        { code: 1000, value: 'MAN' },
        { code: 1040, value: b.a.x },
        { code: 1040, value: b.a.y },
        { code: 1040, value: b.b.x },
        { code: 1040, value: b.b.y },
      );
  }
  return replaceXData(d.xdata, BREAK_APP, items.length ? items : null);
}

/** 스타일·치수 확장 데이터에서 (1070 key, 1040 값) 찾기 */
function styleXNumber(doc: CadDocument, d: Pick<DimensionEntity, 'dimStyle' | 'xdata'>, appName: string, key: number): number | null {
  const lists = [d.xdata, doc.dimStyles.get(tableKey(d.dimStyle || 'Standard'))?.xdata];
  for (const xd of lists) {
    const x = xd?.find((a) => a.app.toUpperCase() === appName);
    if (!x) continue;
    const i = x.items.findIndex((it) => it.code === 1070 && Number(it.value) === key);
    const v = x.items[i + 1];
    if (i >= 0 && v && v.code === 1040 && Number.isFinite(Number(v.value))) return Number(v.value);
  }
  return null;
}

const metric = (doc: CadDocument) => Number(doc.header.get('$MEASUREMENT') ?? 1) === 1;

/** 끊기 크기(DIMSCALE 곱한 값) */
export function breakSize(doc: CadDocument, d: Pick<DimensionEntity, 'dimStyle' | 'xdata'>, dimScale: number): number {
  const s = styleXNumber(doc, d, 'ACAD_DSTYLE_DIMBREAK', 391);
  return (s !== null && s >= 0 ? s : metric(doc) ? 3.75 : 0.125) * (dimScale > 0 ? dimScale : 1);
}

/** 꺾기 높이 계수(문자 높이의 배수) */
export function jogHeightFactor(doc: CadDocument, d: Pick<DimensionEntity, 'dimStyle' | 'xdata'>): number {
  const s = styleXNumber(doc, d, 'ACAD_DSTYLE_DIMJAG', 388);
  return s !== null && s > 0 ? s : 1.5;
}

// ---------------------------------------------------------------------------
// 블록 그림 고치기
// ---------------------------------------------------------------------------

/** 선형·정렬 치수의 치수선 두 끝(블록 좌표) */
export function linearFeet(o: Pick<Out, 'w'>, d: DimensionEntity): { d1: P; d2: P; ux: P } {
  const p1 = o.w(d.defPoint2);
  const p2 = o.w(d.defPoint3);
  const dp = o.w(d.defPoint);
  const aligned = (d.dimType & 7) === 1;
  const theta = aligned ? (dist(p1, p2) > 1e-12 ? ang(sub(p2, p1)) : d.rotation || 0) : d.rotation || 0;
  const u = dir(theta);
  const e = d.obliqueAngle ? dir(d.obliqueAngle) : perp(u);
  const d2 = intersect(dp, u, p2, e) ?? project(p2, dp, u);
  const d1 = intersect(dp, u, p1, e) ?? project(p1, dp, u);
  return { d1, d2, ux: dist(d1, d2) > 1e-12 ? unit(sub(d2, d1)) : u };
}

/** 꺾기선 기본 위치: 첫째 치수보조선과 문자 가운데의 중간(WCS 블록 좌표가 같을 때) */
export function defaultJogPoint(d1: P, d2: P, ux: P, text: P | null): P {
  if (!text) return madd(d1, ux, dist(d1, d2) / 4);
  return mid(d1, project(text, d1, ux));
}

const isLine = (e: Entity): e is LineEntity => e.type === 'LINE';
const isArc = (e: Entity): e is ArcEntity => e.type === 'ARC';

/** 블록 선·호를 조각으로(블록 좌표 = 치수 OCS) */
function pieceOf(e: LineEntity | ArcEntity): LinePiece | ArcPiece {
  if (e.type === 'LINE') return { k: 'line', a: p(e.start.x, e.start.y), b: p(e.end.x, e.end.y) };
  return { k: 'arc', c: p(e.center.x, e.center.y), r: e.radius, a0: e.startAngle, sw: norm2pi(e.endAngle - e.startAngle) || TAU };
}

/** 점에서 선·호까지 거리와 그 위 매개변수(선: 시작에서 거리, 호: 시작 각에서 반시계 각) */
function nearestOn(e: LineEntity | ArcEntity, q: P): { d: number; t: number } {
  if (e.type === 'LINE') {
    const a = p(e.start.x, e.start.y);
    const b = p(e.end.x, e.end.y);
    const L = dist(a, b);
    const u = L > 0 ? mul(sub(b, a), 1 / L) : p(1, 0);
    const t = Math.max(0, Math.min(L, dot(sub(q, a), u)));
    return { d: dist(q, madd(a, u, t)), t: dot(sub(q, a), u) };
  }
  const c = p(e.center.x, e.center.y);
  const sw = norm2pi(e.endAngle - e.startAngle) || TAU;
  const t = norm2pi(ang(sub(q, c)) - e.startAngle);
  const inside = t <= sw + 1e-12;
  const dr = Math.abs(dist(q, c) - e.radius);
  if (inside) return { d: dr, t };
  const ends = [dir(e.startAngle), dir(e.endAngle)].map((u) => dist(q, madd(c, u, e.radius)));
  // 호 밖: 가까운 끝 쪽 매개변수(시작 앞은 음수)
  return { d: Math.min(ends[0]!, ends[1]!), t: TAU - t < t - sw ? t - TAU : t };
}

/** 구간들을 [0, len]에서 뺀 나머지 */
function keep(len: number, cuts: [number, number][]): [number, number][] {
  const cs = cuts.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of cs) {
    if (b <= at) continue;
    if (a > at) out.push([at, Math.min(a, len)]);
    at = Math.max(at, b);
    if (at >= len) break;
  }
  if (at < len) out.push([at, len]);
  return out.filter(([a, b]) => b - a > 1e-9 * Math.max(1, len));
}

/** 선·호 하나를 남길 구간으로 나눈다 */
function splitEntity(e: LineEntity | ArcEntity, cuts: [number, number][]): Entity[] {
  if (!cuts.length) return [e];
  if (e.type === 'LINE') {
    const a = p(e.start.x, e.start.y);
    const b = p(e.end.x, e.end.y);
    const L = dist(a, b);
    if (!(L > 0)) return [e];
    const u = mul(sub(b, a), 1 / L);
    return keep(L, cuts).map(([t0, t1]) => {
      const s = madd(a, u, t0);
      const t = madd(a, u, t1);
      return { ...e, start: { x: s.x, y: s.y, z: e.start.z }, end: { x: t.x, y: t.y, z: e.end.z } } as LineEntity;
    });
  }
  const sw = norm2pi(e.endAngle - e.startAngle) || TAU;
  return keep(sw, cuts).map(([t0, t1]) => ({ ...e, startAngle: norm2pi(e.startAngle + t0), endAngle: norm2pi(e.startAngle + t1) }) as ArcEntity);
}

/** 끊는 객체의 모서리(블록 좌표가 WCS와 같을 때만) */
export function breakerPieces(doc: CadDocument, e: Entity): Piece[] {
  if (!BREAKER_TYPES.has(e.type)) return [];
  try {
    return edgePieces(e, doc);
  } catch {
    return [];
  }
}

/** 꺾기선 지그재그: 가운데 c, 방향 ux, 높이 h. [시작, 꼭지, 골, 끝] */
export function jogZigzag(c: P, ux: P, h: number): [P, P, P, P] {
  const a = h / 2 / Math.tan((70 * Math.PI) / 180);
  const n = perp(ux);
  return [madd(c, ux, -2 * a), add(madd(c, ux, -a), mul(n, h / 2)), add(madd(c, ux, a), mul(n, -h / 2)), madd(c, ux, 2 * a)];
}

function applyJog(o: Out, jog: JogLine): void {
  const d = o.dim;
  const k = d.dimType & 7;
  if (d.subtype || (k !== 0 && k !== 1)) return;
  const { d1, d2, ux } = linearFeet(o, d);
  const h = jogHeightFactor(o.doc, d) * o.v.txt;
  if (!(h > 0)) return;
  const a = h / 2 / Math.tan((70 * Math.PI) / 180);
  const at = jog.user && jog.point ? project(o.w({ x: jog.point.x, y: jog.point.y, z: 0 }), d1, ux) : defaultJogPoint(d1, d2, ux, o.textMid);
  const tAt = dot(sub(at, d1), ux);
  // 치수선 위의 선(같은 직선)
  const scale = Math.max(1, dist(d1, d2), o.v.txt);
  const on = (q: P) => Math.abs(cross(ux, sub(q, d1))) <= 1e-7 * scale;
  let best: { e: LineEntity; lo: number; hi: number } | null = null;
  let bd = Infinity;
  for (const e of o.entities) {
    if (!isLine(e) || e.layer === o.defpointsLayer) continue;
    const s = p(e.start.x, e.start.y);
    const t = p(e.end.x, e.end.y);
    if (!on(s) || !on(t)) continue;
    const ts = dot(sub(s, d1), ux);
    const te = dot(sub(t, d1), ux);
    const lo = Math.min(ts, te);
    const hi = Math.max(ts, te);
    if (hi - lo < 1e-9 * scale) continue;
    const gap = tAt < lo ? lo - tAt : tAt > hi ? tAt - hi : 0;
    if (gap < bd) {
      bd = gap;
      best = { e, lo, hi };
    }
  }
  if (!best) return;
  const { e, lo, hi } = best;
  const tc = hi - lo >= 4 * a ? Math.max(lo + 2 * a, Math.min(hi - 2 * a, tAt)) : (lo + hi) / 2;
  const c = madd(d1, ux, tc);
  const z = e.start.z;
  const [s, pk, vl, t] = jogZigzag(c, ux, h);
  const mk = (q0: P, q1: P): LineEntity => ({ ...e, start: { x: q0.x, y: q0.y, z }, end: { x: q1.x, y: q1.y, z } });
  const out: LineEntity[] = [];
  if (tc - 2 * a - lo > 1e-9 * scale) out.push(mk(madd(d1, ux, lo), s));
  out.push(mk(s, pk), mk(pk, vl), mk(vl, t));
  if (hi - (tc + 2 * a) > 1e-9 * scale) out.push(mk(t, madd(d1, ux, hi)));
  const i = o.entities.indexOf(e);
  o.entities.splice(i, 1, ...out);
}

function applyBreaks(o: Out, list: DimBreak[]): void {
  const d = o.dim;
  const g = breakSize(o.doc, d, o.v.scale);
  const frame = dimFrame(d);
  const cuts = new Map<Entity, [number, number][]>();
  const add2 = (e: Entity, iv: [number, number]) => {
    const l = cuts.get(e);
    if (l) l.push(iv);
    else cuts.set(e, [iv]);
  };
  const lines = o.entities.filter((e): e is LineEntity | ArcEntity => (isLine(e) || isArc(e)) && e.layer !== o.defpointsLayer);
  const natural = !d.extrusion || (Math.abs(d.extrusion.x) < 1e-12 && Math.abs(d.extrusion.y) < 1e-12 && d.extrusion.z > 0);
  for (const b of list) {
    if (b.kind === 'object') {
      if (!natural || !(g > 0)) continue;
      const other = o.doc.entityIndex.get(b.handle);
      if (!other || other.handle === d.handle) continue;
      const pcs = breakerPieces(o.doc, other);
      if (!pcs.length) continue;
      for (const e of lines) {
        const pc = pieceOf(e);
        for (const q of intersectAll([pc], pcs)) {
          if (e.type === 'LINE') {
            const t = nearestOn(e, q).t;
            add2(e, [t - g / 2, t + g / 2]);
          } else {
            const t = norm2pi(ang(sub(q, p(e.center.x, e.center.y))) - e.startAngle);
            const da = g / 2 / e.radius;
            add2(e, [t - da, t + da]);
          }
        }
      }
    } else {
      const A = o.w({ ...fromFrame(frame, b.a), z: 0 });
      const B = o.w({ ...fromFrame(frame, b.b), z: 0 });
      let best: LineEntity | ArcEntity | null = null;
      let bd = Infinity;
      for (const e of lines) {
        const r = nearestOn(e, A);
        if (r.d < bd) {
          bd = r.d;
          best = e;
        }
      }
      if (!best) continue;
      const ta = nearestOn(best, A).t;
      let tb = nearestOn(best, B).t;
      if (best.type === 'ARC' && Math.abs(tb - ta) > Math.PI) tb += tb < ta ? TAU : -TAU;
      add2(best, [ta, tb]);
    }
  }
  if (!cuts.size) return;
  const out: Entity[] = [];
  for (const e of o.entities) {
    const c = cuts.get(e);
    if (c && (isLine(e) || isArc(e))) out.push(...splitEntity(e, c));
    else out.push(e);
  }
  o.entities.length = 0;
  o.entities.push(...out);
}

/** 치수 그림에 꺾기선·끊기를 넣는다(기록이 없으면 그대로) */
export function applyDimExtras(o: Out): void {
  const d = o.dim;
  if (!d.xdata?.length) return;
  const jog = readJogLine(d);
  if (jog?.on) applyJog(o, jog);
  const br = readBreaks(d);
  if (br.length) applyBreaks(o, br);
}
