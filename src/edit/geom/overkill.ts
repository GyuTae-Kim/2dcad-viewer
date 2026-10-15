/**
 * OVERKILL: 중복되거나 겹치는 객체 정리.
 * 1. 중복: 종류·(무시하지 않은) 특성·형상이 공차 안에서 같은 객체. 선과 폴리선은 방향이 반대여도 같다. 먼저 고른 것이 남는다.
 * 2. 같은 직선 위의 선: 다른 선(또는 폴리선의 직선 세그먼트)에 덮인 선은 지우고, 부분 겹침·끝과 끝은 옵션에 따라
 *    먼저 고른 선을 늘리고 나머지를 지운다.
 * 3. 같은 원 위의 호: 원이나 다른 호(폴리선의 호 세그먼트)에 덮인 호는 지우고, 겹치거나 닿는 호는 합친다(한 바퀴면 원).
 * 4. 폴리선 최적화: 길이 0 세그먼트, 같은 방향으로 이어지는 일직선 정점, 한 호로 합쳐지는 연속 호 정점을 지운다
 *    (정점마다 폭이 다른 폴리선은 건드리지 않는다).
 */
import type { ArcEntity, CircleEntity, Entity, LineEntity, LwPolylineEntity } from '../../core/model';
import { tableKey } from '../../core/model';
import { lwVertices, packLw } from '../../core/lwpoly';
import type { ArcPiece } from './curve';
import { TAU, bulgeToSweep, ccwFrom, cross, dist, dot, normAngle, sub, sweepToBulge } from './math';
import { bulgePieces, cloneEntity, entityPath, inherit, lwVerts } from './path';
import { planProj } from './ocs';
import { reverseEntity } from './query';
import type { EditResult } from './types';

export type OverkillProp = 'color' | 'layer' | 'linetype' | 'ltscale' | 'lineweight' | 'transparency' | 'plotstyle' | 'thickness' | 'material';

export interface OverkillOptions {
  /** 비교 공차(기본 0.000001) */
  tolerance?: number;
  /** 비교하지 않을 특성 */
  ignore?: Iterable<OverkillProp>;
  /** 폴리선 안의 세그먼트 최적화(기본 참) */
  optimizePolylines?: boolean;
  /** 부분 겹침 결합(기본 참) */
  combineOverlap?: boolean;
  /** 끝과 끝 결합(기본 참) */
  combineEndToEnd?: boolean;
}

export interface OverkillResult {
  result: EditResult;
  duplicates: number;
  overlaps: number;
}

// ---------------------------------------------------------------------------
// 특성·형상 비교
// ---------------------------------------------------------------------------

function propKey(e: Entity, ignore: Set<OverkillProp>): string {
  const k: (string | number)[] = [];
  if (!ignore.has('layer')) k.push(tableKey(e.layer));
  if (!ignore.has('color')) k.push(`${e.color.aci}:${e.color.rgb ?? ''}:${e.color.name ?? ''}`);
  if (!ignore.has('linetype')) k.push(tableKey(e.linetype || 'BYLAYER'));
  if (!ignore.has('ltscale')) k.push(+e.ltscale.toFixed(9));
  if (!ignore.has('lineweight')) k.push(e.lineweight);
  if (!ignore.has('transparency')) k.push(e.transparency);
  if (!ignore.has('plotstyle')) k.push(e.plotStyle ?? '');
  if (!ignore.has('thickness')) k.push(e.thickness ?? 0);
  if (!ignore.has('material')) k.push(e.material ?? '');
  k.push(e.paperSpace ? 1 : 0, e.invisible ? 1 : 0);
  return JSON.stringify(k);
}

/** 어디서나 비교하지 않는 식별 정보(블록 속성의 핸들 포함) */
const ID_KEYS = new Set(['handle', 'owner', 'xdict', 'reactors', 'dwgRaw']);
/** 객체 자신의 특성(따로 propKey로 비교) */
const SKIP = new Set(['layer', 'color', 'linetype', 'lineweight', 'ltscale', 'transparency', 'plotStyle', 'thickness', 'material', 'hyperlink', 'xdata', 'paperSpace', 'invisible']);

type Tok = string | number;

function flatten(v: unknown, out: Tok[], top: boolean): void {
  if (v === undefined || v === null) {
    out.push('~');
    return;
  }
  if (typeof v === 'number') {
    out.push(v);
    return;
  }
  if (typeof v === 'string' || typeof v === 'boolean') {
    out.push(`s${String(v)}`);
    return;
  }
  if (v instanceof Uint8Array) {
    out.push(`b${v.length}`);
    return;
  }
  if (Array.isArray(v)) {
    out.push(`[${v.length}`);
    for (const x of v) flatten(x, out, false);
    return;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
      .filter((k) => !ID_KEYS.has(k) && !(top && SKIP.has(k)) && (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    out.push(`{${keys.join(',')}`);
    for (const k of keys) flatten((v as Record<string, unknown>)[k], out, false);
  }
}

function tokens(e: Entity): Tok[] {
  const out: Tok[] = [];
  flatten(e, out, true);
  return out;
}

/** 방향을 따지지 않는 정규형(선·폴리선은 두 방향 가운데 작은 쪽) */
function canonical(e: Entity): Tok[] {
  if (e.type === 'LINE') {
    const a = e.start;
    const b = e.end;
    const swap = a.x > b.x || (a.x === b.x && (a.y > b.y || (a.y === b.y && a.z > b.z)));
    return tokens(swap ? { ...e, start: b, end: a } : e);
  }
  if (e.type === 'LWPOLYLINE' || (e.type === 'POLYLINE' && (e.kind === '2d' || e.kind === '3d'))) {
    const f = tokens(e);
    const r = reverseEntity(e).replace?.[0];
    if (!r) return f;
    const t = tokens(r);
    return lexLess(t, f) ? t : f;
  }
  return tokens(e);
}

function lexLess(a: Tok[], b: Tok[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y;
    return String(x) < String(y);
  }
  return a.length < b.length;
}

function sameTokens(a: Tok[], b: Tok[], tol: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (typeof x === 'number' && typeof y === 'number') {
      if (!(Math.abs(x - y) <= tol)) return false;
    } else if (x !== y) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

interface Item {
  e: Entity;
  /** 선택 순서 */
  rank: number;
  pk: string;
}

export function overkill(list: readonly Entity[], opt: OverkillOptions = {}): OverkillResult {
  const tol = Math.max(0, opt.tolerance ?? 1e-6) + 1e-12;
  const ignore = new Set(opt.ignore ?? []);
  const combineOverlap = opt.combineOverlap ?? true;
  const combineEnd = opt.combineEndToEnd ?? true;
  const removed = new Set<string>();
  const replaced = new Map<string, Entity>();
  const added: Entity[] = [];
  let duplicates = 0;
  let overlaps = 0;
  const items: Item[] = list.map((e, rank) => ({ e, rank, pk: propKey(e, ignore) }));

  // 1. 중복
  {
    const buckets = new Map<string, { it: Item; tok: Tok[]; first: number }[]>();
    for (const it of items) {
      const tok = canonical(it.e);
      const sig = it.e.type + '|' + it.pk + '|' + tok.length + '|' + tok.filter((t) => typeof t === 'string').join('|');
      const first = (tok.find((t) => typeof t === 'number') as number | undefined) ?? 0;
      let b = buckets.get(sig);
      if (!b) buckets.set(sig, (b = []));
      b.push({ it, tok, first });
    }
    for (const b of buckets.values()) {
      if (b.length < 2) continue;
      b.sort((p, q) => p.first - q.first || p.it.rank - q.it.rank);
      const gone = new Set<number>();
      for (let i = 0; i < b.length; i++) {
        if (gone.has(i)) continue;
        for (let j = i + 1; j < b.length && b[j]!.first - b[i]!.first <= tol; j++) {
          if (gone.has(j)) continue;
          if (!sameTokens(b[i]!.tok, b[j]!.tok, tol)) continue;
          // 먼저 고른 것이 남는다
          const drop = b[i]!.it.rank <= b[j]!.it.rank ? j : i;
          gone.add(drop);
          removed.add(b[drop]!.it.e.handle);
          duplicates++;
          if (drop === i) break;
        }
      }
    }
  }
  const alive = items.filter((it) => !removed.has(it.e.handle));

  // 2. 같은 직선 위의 선
  overlaps += lineOverlaps(alive, tol, combineOverlap, combineEnd, removed, replaced);
  // 3. 같은 원 위의 호
  overlaps += arcOverlaps(
    alive.filter((it) => !removed.has(it.e.handle)),
    tol,
    combineOverlap,
    combineEnd,
    removed,
    replaced,
    added,
  );
  // 4. 폴리선 최적화
  if (opt.optimizePolylines ?? true) {
    for (const it of alive) {
      if (removed.has(it.e.handle) || it.e.type !== 'LWPOLYLINE') continue;
      const r = optimizeLw(it.e, tol);
      if (r) {
        replaced.set(it.e.handle, r.e);
        overlaps += r.removed;
      }
    }
  }
  const result: EditResult = {};
  const rep = [...replaced.values()].filter((e) => !removed.has(e.handle));
  if (rep.length) result.replace = rep;
  if (removed.size) result.remove = [...removed];
  if (added.length) result.add = added;
  result.message = `${duplicates}개의 중복 항목 삭제됨\n${overlaps}개의 겹치는 객체 또는 세그먼트 삭제됨`;
  return { result, duplicates, overlaps };
}

// ---------------------------------------------------------------------------
// 선
// ---------------------------------------------------------------------------

interface Seg {
  it: Item | null;
  /** 폴리선 세그먼트(덮기만 하고 바뀌지 않는다) */
  fixed: boolean;
  a: { x: number; y: number };
  b: { x: number; y: number };
  z: number;
  pk: string;
  rank: number;
  th: number;
  c: number;
}

function segOf(a: { x: number; y: number }, b: { x: number; y: number }): { th: number; c: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (!(l > 0)) return null;
  let ux = dx / l;
  let uy = dy / l;
  let th = Math.atan2(uy, ux);
  if (th < 0) th += Math.PI;
  if (th >= Math.PI - 1e-12) th -= Math.PI;
  if (Math.abs(Math.atan2(uy, ux) - th) > 1e-9) {
    ux = -ux;
    uy = -uy;
  }
  return { th, c: ux * a.y - uy * a.x };
}

function lineOverlaps(items: Item[], tol: number, combineOverlap: boolean, combineEnd: boolean, removed: Set<string>, replaced: Map<string, Entity>): number {
  const segs: Seg[] = [];
  for (const it of items) {
    const e = it.e;
    if (e.type === 'LINE') {
      if (Math.abs(e.start.z - e.end.z) > tol) continue;
      const s = segOf(e.start, e.end);
      if (s) segs.push({ it, fixed: false, a: e.start, b: e.end, z: e.start.z, pk: it.pk, rank: it.rank, ...s });
    } else if (e.type === 'LWPOLYLINE' || (e.type === 'POLYLINE' && e.kind === '2d')) {
      const path = entityPath(e);
      if (!path) continue;
      if (path.pieces.some((p) => (p.w0 ?? 0) > 0 || (p.w1 ?? 0) > 0)) continue;
      for (const p of path.pieces) {
        if (p.k !== 'line') continue;
        const s = segOf(p.a, p.b);
        if (s) segs.push({ it: null, fixed: true, a: p.a, b: p.b, z: path.z, pk: it.pk, rank: it.rank, ...s });
      }
    }
  }
  if (segs.length < 2) return 0;
  // 방향 → 직선 거리로 묶는다
  const byKey = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = s.pk + '|' + Math.round(s.z / Math.max(tol, 1e-12));
    let g = byKey.get(k);
    if (!g) byKey.set(k, (g = []));
    g.push(s);
  }
  let count = 0;
  for (const g of byKey.values()) {
    if (g.length < 2) continue;
    g.sort((p, q) => p.th - q.th);
    let i = 0;
    while (i < g.length) {
      let j = i + 1;
      while (j < g.length && g[j]!.th - g[j - 1]!.th <= 1e-7) j++;
      const band = g.slice(i, j);
      i = j;
      if (band.length < 2) continue;
      band.sort((p, q) => p.c - q.c);
      let k = 0;
      while (k < band.length) {
        let m = k + 1;
        while (m < band.length && band[m]!.c - band[m - 1]!.c <= tol) m++;
        const line = band.slice(k, m);
        k = m;
        if (line.length >= 2 && line.some((s) => !s.fixed)) count += collinear(line, tol, combineOverlap, combineEnd, removed, replaced);
      }
    }
  }
  return count;
}

function collinear(group: Seg[], tol: number, combineOverlap: boolean, combineEnd: boolean, removed: Set<string>, replaced: Map<string, Entity>): number {
  // 기준 직선: 가장 긴 것
  const ref = group.reduce((p, q) => (dist(q.a, q.b) > dist(p.a, p.b) ? q : p));
  const o = ref.a;
  const L = dist(ref.a, ref.b);
  const d = { x: (ref.b.x - ref.a.x) / L, y: (ref.b.y - ref.a.y) / L };
  const on = group.filter((s) => Math.abs(cross(d, sub(s.a, o))) <= tol && Math.abs(cross(d, sub(s.b, o))) <= tol);
  const iv = on.map((s) => {
    const t0 = dot(sub(s.a, o), d);
    const t1 = dot(sub(s.b, o), d);
    return { s, lo: Math.min(t0, t1), hi: Math.max(t0, t1) };
  });
  let count = 0;
  // 덮인 선 지우기
  const gone = new Set<typeof iv[number]>();
  for (const x of iv) {
    if (x.s.fixed) continue;
    for (const y of iv) {
      if (x === y || gone.has(y)) continue;
      if (y.lo <= x.lo + tol && y.hi >= x.hi - tol) {
        // 같은 구간이면 먼저 고른 쪽(또는 폴리선)이 남는다
        const same = Math.abs(y.lo - x.lo) <= tol && Math.abs(y.hi - x.hi) <= tol;
        if (same && !y.s.fixed && y.s.rank > x.s.rank) continue;
        gone.add(x);
        break;
      }
    }
  }
  for (const x of gone) {
    removed.add(x.s.it!.e.handle);
    count++;
  }
  if (!combineOverlap && !combineEnd) return count;
  // 겹치거나 닿는 선 합치기(폴리선 세그먼트는 합치지 않는다)
  const rest = iv.filter((x) => !gone.has(x) && !x.s.fixed).sort((p, q) => p.lo - q.lo);
  let cluster: typeof rest = [];
  let hi = -Infinity;
  const flush = () => {
    if (cluster.length > 1) {
      const keep = cluster.reduce((p, q) => (q.s.rank < p.s.rank ? q : p));
      const lo = Math.min(...cluster.map((c) => c.lo));
      const h = Math.max(...cluster.map((c) => c.hi));
      const e = keep.s.it!.e as LineEntity;
      const t0 = dot(sub(e.start, o), d);
      const forward = t0 <= dot(sub(e.end, o), d);
      const pa = { x: o.x + d.x * lo, y: o.y + d.y * lo };
      const pb = { x: o.x + d.x * h, y: o.y + d.y * h };
      const ne = cloneEntity(e);
      ne.start = { x: (forward ? pa : pb).x, y: (forward ? pa : pb).y, z: e.start.z };
      ne.end = { x: (forward ? pb : pa).x, y: (forward ? pb : pa).y, z: e.end.z };
      replaced.set(e.handle, ne);
      for (const c of cluster)
        if (c !== keep) {
          removed.add(c.s.it!.e.handle);
          count++;
        }
    }
    cluster = [];
  };
  for (const x of rest) {
    if (cluster.length) {
      const overlap = x.lo < hi - tol;
      const touch = Math.abs(x.lo - hi) <= tol;
      if ((overlap && combineOverlap) || (touch && combineEnd)) {
        cluster.push(x);
        hi = Math.max(hi, x.hi);
        continue;
      }
      flush();
    }
    cluster = [x];
    hi = x.hi;
  }
  flush();
  return count;
}

// ---------------------------------------------------------------------------
// 호
// ---------------------------------------------------------------------------

interface ArcItem {
  it: Item | null;
  fixed: boolean;
  full: boolean;
  c: { x: number; y: number };
  r: number;
  a0: number;
  sw: number;
  z: number;
  pk: string;
  rank: number;
}

function planArc(e: ArcEntity | CircleEntity): ArcPiece | null {
  const p = entityPath(e);
  const pc = p?.pieces[0];
  return pc && pc.k === 'arc' ? pc : null;
}

function arcOverlaps(items: Item[], tol: number, combineOverlap: boolean, combineEnd: boolean, removed: Set<string>, replaced: Map<string, Entity>, added: Entity[]): number {
  const arcs: ArcItem[] = [];
  for (const it of items) {
    const e = it.e;
    if (e.type === 'ARC' || e.type === 'CIRCLE') {
      const pc = planArc(e);
      if (!pc) continue;
      const z = entityPath(e)!.z;
      arcs.push({ it, fixed: false, full: e.type === 'CIRCLE', c: pc.c, r: pc.r, a0: normAngle(pc.a0), sw: Math.abs(pc.sw), z, pk: it.pk, rank: it.rank });
    } else if (e.type === 'LWPOLYLINE' && !e.widths?.some((w) => w > 0) && !(e.constantWidth > 0)) {
      for (const p of bulgePieces(lwVerts(e), e.closed, planProj(e.extrusion, e.elevation))) {
        if (p.k !== 'arc') continue;
        const a0 = p.sw >= 0 ? p.a0 : p.a0 + p.sw;
        arcs.push({ it: null, fixed: true, full: false, c: p.c, r: p.r, a0: normAngle(a0), sw: Math.abs(p.sw), z: e.elevation, pk: it.pk, rank: it.rank });
      }
    }
  }
  if (arcs.length < 2) return 0;
  // 같은 원끼리
  const groups: ArcItem[][] = [];
  const sorted = [...arcs].sort((p, q) => p.c.x - q.c.x);
  const used = new Set<ArcItem>();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (used.has(a)) continue;
    const g = [a];
    used.add(a);
    for (let j = i + 1; j < sorted.length && sorted[j]!.c.x - a.c.x <= tol; j++) {
      const b = sorted[j]!;
      if (used.has(b) || b.pk !== a.pk || Math.abs(b.z - a.z) > tol || Math.abs(b.c.y - a.c.y) > tol || Math.abs(b.r - a.r) > tol) continue;
      g.push(b);
      used.add(b);
    }
    if (g.length > 1 && g.some((x) => !x.fixed)) groups.push(g);
  }
  let count = 0;
  for (const g of groups) count += cocircular(g, tol, combineOverlap, combineEnd, removed, replaced, added);
  return count;
}

function covers(y: ArcItem, x: ArcItem, at: number): boolean {
  if (y.full) return true;
  if (x.full) return false;
  return ccwFrom(y.a0, x.a0) + x.sw <= y.sw + at || (ccwFrom(y.a0, x.a0) >= TAU - at && x.sw <= y.sw + at);
}

function cocircular(g: ArcItem[], tol: number, combineOverlap: boolean, combineEnd: boolean, removed: Set<string>, replaced: Map<string, Entity>, added: Entity[]): number {
  const at = tol / Math.max(g[0]!.r, 1e-12);
  let count = 0;
  const gone = new Set<ArcItem>();
  for (const x of g) {
    if (x.fixed) continue;
    for (const y of g) {
      if (x === y || gone.has(y)) continue;
      if (!covers(y, x, at)) continue;
      const same = covers(x, y, at);
      if (same && !y.fixed && y.rank > x.rank) continue;
      gone.add(x);
      break;
    }
  }
  for (const x of gone) {
    removed.add(x.it!.e.handle);
    count++;
  }
  if (!combineOverlap && !combineEnd) return count;
  // 합치기: 먼저 고른 호부터 이어지는 호를 붙인다
  const rest = g.filter((x) => !gone.has(x) && !x.fixed && !x.full).sort((p, q) => p.rank - q.rank);
  const done = new Set<ArcItem>();
  for (const keep of rest) {
    if (done.has(keep)) continue;
    let a0 = keep.a0;
    let sw = keep.sw;
    const members = [keep];
    let grew = true;
    while (grew && sw < TAU - at) {
      grew = false;
      for (const o of rest) {
        if (o === keep || done.has(o) || members.includes(o)) continue;
        const ds = ccwFrom(a0, o.a0); // o의 시작이 지금 호 안(끝)인지
        const de = ccwFrom(o.a0, a0); // 지금 호의 시작이 o 안인지
        let ok = false;
        if (ds <= sw + at) {
          const touch = Math.abs(ds - sw) <= at;
          ok = touch ? combineEnd : combineOverlap;
          if (ok) sw = Math.max(sw, ds + o.sw);
        } else if (de <= o.sw + at) {
          const touch = Math.abs(de - o.sw) <= at;
          ok = touch ? combineEnd : combineOverlap;
          if (ok) {
            sw = Math.max(o.sw, de + sw);
            a0 = o.a0;
          }
        }
        if (ok) {
          members.push(o);
          grew = true;
        }
      }
    }
    if (members.length < 2) continue;
    for (const m of members) done.add(m);
    for (const m of members)
      if (m !== keep) {
        removed.add(m.it!.e.handle);
        count++;
      }
    const e = keep.it!.e as ArcEntity;
    if (sw >= TAU - at) {
      removed.add(e.handle);
      const c: CircleEntity = { type: 'CIRCLE', ...inherit(e), center: { x: keep.c.x, y: keep.c.y, z: keep.z }, radius: keep.r };
      added.push(c);
    } else {
      const ne: ArcEntity = { ...cloneEntity(e), center: { x: keep.c.x, y: keep.c.y, z: keep.z }, startAngle: normAngle(a0), endAngle: normAngle(a0 + sw) };
      delete ne.extrusion;
      replaced.set(e.handle, ne);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// 폴리선 최적화
// ---------------------------------------------------------------------------

function optimizeLw(e: LwPolylineEntity, tol: number): { e: LwPolylineEntity; removed: number } | null {
  const vs = lwVertices(e);
  if (vs.some((v) => Math.abs(v.startWidth - vs[0]!.startWidth) > 1e-12 || Math.abs(v.endWidth - vs[0]!.startWidth) > 1e-12)) return null;
  let removed = 0;
  let changed = true;
  while (changed && vs.length > 2) {
    changed = false;
    const n = vs.length;
    // 길이 0 세그먼트
    for (let i = 0; i < vs.length && vs.length > 2; i++) {
      const j = i + 1 < vs.length ? i + 1 : e.closed ? 0 : -1;
      if (j < 0) continue;
      if (dist(vs[i]!, vs[j]!) <= tol) {
        if (j === 0) {
          vs.pop();
        } else {
          vs[i]!.bulge = vs[j]!.bulge;
          vs.splice(j, 1);
        }
        removed++;
        changed = true;
        break;
      }
    }
    if (changed) continue;
    // 일직선·같은 원 위의 정점
    const segs = e.closed ? n : n - 1;
    for (let i = 1; i < n && segs >= 2; i++) {
      if (!e.closed && i === n - 1) break;
      const prev = vs[i - 1]!;
      const cur = vs[i]!;
      const next = vs[(i + 1) % n]!;
      if (Math.abs(prev.bulge) < 1e-12 && Math.abs(cur.bulge) < 1e-12) {
        // 같은 방향으로 이어지고 가운데 정점이 양 끝을 잇는 직선 위
        const d1 = sub(cur, prev);
        const d2 = sub(next, cur);
        const L = dist(prev, next);
        if (L > 0 && dot(d1, d2) > 0 && Math.abs(cross(sub(next, prev), sub(cur, prev))) / L <= tol) {
          vs.splice(i, 1);
          removed++;
          changed = true;
          break;
        }
      } else if (Math.abs(prev.bulge) >= 1e-12 && Math.abs(cur.bulge) >= 1e-12 && Math.sign(prev.bulge) === Math.sign(cur.bulge)) {
        const s1 = bulgeToSweep(prev.bulge);
        const s2 = bulgeToSweep(cur.bulge);
        if (Math.abs(s1 + s2) >= TAU - 1e-9) continue;
        const c1 = bulgeCenter(prev, cur, prev.bulge);
        const c2 = bulgeCenter(cur, next, cur.bulge);
        if (!c1 || !c2) continue;
        if (dist(c1.c, c2.c) <= tol && Math.abs(c1.r - c2.r) <= tol) {
          prev.bulge = sweepToBulge(s1 + s2);
          vs.splice(i, 1);
          removed++;
          changed = true;
          break;
        }
      }
    }
  }
  if (!removed) return null;
  return { e: { ...cloneEntity(e), ...packLw(vs) }, removed };
}

function bulgeCenter(a: { x: number; y: number }, b: { x: number; y: number }, bulge: number): { c: { x: number; y: number }; r: number } | null {
  const L = dist(a, b);
  if (!(L > 0)) return null;
  const sw = bulgeToSweep(bulge);
  const r = L / (2 * Math.sin(Math.abs(sw) / 2));
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const h = r * Math.cos(Math.abs(sw) / 2);
  const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const n = { x: -d.y, y: d.x };
  const s = sw > 0 ? 1 : -1;
  return { c: { x: m.x + n.x * h * s, y: m.y + n.y * h * s }, r };
}
