/**
 * JOIN(AutoCAD 2012+ 규칙).
 * 1. 같은 직선 위의 선은 틈이 있어도 선 하나로(첫 선의 핸들).
 * 2. 같은 원 위의 호는 틈이 있어도 호 하나로 — 첫 호(원본)가 든 덩어리의 시작에서 반시계로 가장 먼 끝까지,
 *    한 바퀴가 되면 원. 같은 타원 위의 타원형 호도 같다.
 * 3. 끝과 끝이 닿는 선·호·폴리선·스플라인은 하나로: 스플라인·타원이 끼면 SPLINE, 3D 폴리선이 끼거나 높이가 다르면
 *    3D POLYLINE, 아니면 원본이 2D POLYLINE이면 그 종류, 그 밖은 LWPOLYLINE. 끝이 처음과 만나면 닫힌다.
 * 원(닫힌 곡선)·닫힌 폴리선은 결합하지 않는다.
 */
import type { ArcEntity, CircleEntity, EllipseEntity, Entity, LineEntity } from '../../core/model';
import { type ArcPiece, type EllPiece, type Path, type Piece, pathBox, pieceAt, pieceLength, reversePiece } from './curve';
import { TAU, ccwFrom, ccwSweep, cross, dist, dot, len, norm, sub } from './math';
import { cloneEntity, entityPath, inherit, make3dPolyline, makeArc, makePolyline, makeSpline, piecesNurbs } from './path';
import { keepIdentity } from './trim';
import { type EditResult, MSG } from './types';

interface Item {
  e: Entity;
  /** 결합에 쓸 평면도 경로(바뀌면 원본과 다를 수 있다) */
  path: Path;
  /** 이 항목이 대표하는 원본들(처음 = 핸들을 물려줄 원본) */
  sources: Entity[];
  /** 결과로 바뀌었는지 */
  changed: boolean;
}

function joinable(e: Entity): boolean {
  switch (e.type) {
    case 'LINE':
    case 'ARC':
    case 'ELLIPSE':
    case 'SPLINE':
    case 'LWPOLYLINE':
      return true;
    case 'POLYLINE':
      return e.kind === '2d' || e.kind === '3d';
    default:
      return false;
  }
}

const NAMES: Record<string, string> = { LINE: '선', ARC: '호', CIRCLE: '원', ELLIPSE: '타원형 호', LWPOLYLINE: '폴리선', POLYLINE: '폴리선', SPLINE: '스플라인' };

export function joinEntities(list: Entity[], opts: { tol?: number } = {}): EditResult {
  const cand = list.filter(joinable);
  const items: Item[] = [];
  for (const e of cand) {
    const path = entityPath(e);
    if (!path || !path.pieces.length) continue;
    if (path.closed) continue;
    items.push({ e, path, sources: [e], changed: false });
  }
  if (items.length < 2) return { message: MSG.cannotJoin };
  // 허용 오차: 선택 범위에 비례
  let ext = 0;
  for (const it of items) {
    const b = pathBox(it.path);
    ext = Math.max(ext, Math.abs(b.minX), Math.abs(b.minY), Math.abs(b.maxX), Math.abs(b.maxY), b.maxX - b.minX, b.maxY - b.minY);
  }
  const tol = opts.tol ?? Math.max(1e-9, ext * 1e-9);
  // 겹치거나 닿는 같은 직선·원·타원 위의 객체를 먼저 합치고, 끝과 끝을 잇고, 남은 낱개끼리 틈을 건너 합친다
  let merged = mergeCollinear(items, tol, false);
  merged = mergeCocircular(merged, tol, false);
  merged = mergeCoelliptic(merged, tol, false);
  const first = chain(merged, tol);
  let singles = first.filter((c) => c.items.length === 1).map((c) => c.items[0]!);
  singles = mergeCoelliptic(mergeCocircular(mergeCollinear(singles, tol, true), tol, true), tol, true);
  const chains: Chain[] = [...first.filter((c) => c.items.length > 1), ...singles.map((it) => ({ items: [it], pieces: it.path.pieces, closed: it.path.closed }))];
  const order = new Map(list.map((e, i) => [e, i] as const));
  const rank = (e: Entity) => order.get(e) ?? Infinity;
  const add: Entity[] = [];
  const replace: Entity[] = [];
  const remove: string[] = [];
  let joinedCount = 0;
  let resultCount = 0;
  let lastKind = '';
  for (const ch of chains) {
    const srcs = ch.items.flatMap((it) => it.sources).sort((a, b) => rank(a) - rank(b));
    if (srcs.length < 2) continue;
    const built = buildChain(ch, srcs[0]!);
    if (!built) continue;
    joinedCount += srcs.length;
    resultCount++;
    lastKind = built.type;
    const source = srcs.find((s) => s.type === built.type && !(s.type === 'POLYLINE' && built.type === 'POLYLINE' && s.kind !== (built as typeof s).kind));
    if (built.type === 'LWPOLYLINE' && source !== srcs[0]) Object.assign(built, inherit(srcs[0]!));
    if (source && source.handle) {
      replace.push(keepIdentity(source, built));
      for (const s of srcs) if (s !== source && s.handle) remove.push(s.handle);
    } else {
      add.push(built);
      for (const s of srcs) if (s.handle) remove.push(s.handle);
    }
  }
  if (!joinedCount) return { message: MSG.cannotJoin };
  const out: EditResult = {};
  if (add.length) out.add = add;
  if (replace.length) out.replace = replace;
  if (remove.length) out.remove = remove;
  out.message = resultCount === 1 ? `${joinedCount}개 객체가 1개 ${NAMES[lastKind] ?? '객체'}(으)로 결합되었습니다.` : `${joinedCount}개 객체가 ${resultCount}개 객체로 결합되었습니다.`;
  return out;
}

// ---------------------------------------------------------------------------
// 같은 직선 위의 선
// ---------------------------------------------------------------------------

function isLineItem(it: Item): it is Item & { e: LineEntity } {
  return it.e.type === 'LINE' && !it.changed;
}

function mergeCollinear(items: Item[], tol: number, allowGap: boolean): Item[] {
  const used = new Set<Item>();
  const out: Item[] = [];
  for (const it of items) {
    if (used.has(it)) continue;
    if (!isLineItem(it)) {
      out.push(it);
      continue;
    }
    const a = { x: it.e.start.x, y: it.e.start.y };
    const b = { x: it.e.end.x, y: it.e.end.y };
    const d = norm(sub(b, a));
    if (!(len(sub(b, a)) > tol)) {
      out.push(it);
      continue;
    }
    const z = it.e.start.z;
    const group = [it];
    for (const o of items) {
      if (o === it || used.has(o) || !isLineItem(o)) continue;
      const p = { x: o.e.start.x, y: o.e.start.y };
      const q = { x: o.e.end.x, y: o.e.end.y };
      if (Math.abs(o.e.start.z - z) > tol || Math.abs(o.e.end.z - z) > tol || Math.abs(it.e.end.z - z) > tol) continue;
      if (Math.abs(cross(d, sub(p, a))) > tol || Math.abs(cross(d, sub(q, a))) > tol) continue;
      group.push(o);
    }
    // 첫 선의 방향으로 잰 구간
    const span = (g: Item & { e: LineEntity }): [number, number] => {
      const t0 = dot(sub({ x: g.e.start.x, y: g.e.start.y }, a), d);
      const t1 = dot(sub({ x: g.e.end.x, y: g.e.end.y }, a), d);
      return [Math.min(t0, t1), Math.max(t0, t1)];
    };
    let lo = 0;
    let hi = len(sub(b, a));
    let members = group;
    if (!allowGap) {
      // 첫 선과 겹치거나 닿는 것만(사슬처럼 이어서)
      members = [it];
      let grew = true;
      while (grew) {
        grew = false;
        for (const g of group) {
          if (members.includes(g)) continue;
          const [p0, p1] = span(g as Item & { e: LineEntity });
          if (p0 <= hi + tol && p1 >= lo - tol) {
            members.push(g);
            lo = Math.min(lo, p0);
            hi = Math.max(hi, p1);
            grew = true;
          }
        }
      }
    }
    if (members.length < 2) {
      out.push(it);
      continue;
    }
    for (const g of members) {
      used.add(g);
      const [p0, p1] = span(g as Item & { e: LineEntity });
      lo = Math.min(lo, p0);
      hi = Math.max(hi, p1);
    }
    if (members !== group) {
      group.length = 0;
      group.push(...members);
    }
    const ne = cloneEntity(it.e);
    ne.start = { x: a.x + d.x * lo, y: a.y + d.y * lo, z };
    ne.end = { x: a.x + d.x * hi, y: a.y + d.y * hi, z };
    out.push({ e: ne, path: entityPath(ne)!, sources: group.flatMap((g) => g.sources), changed: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 같은 원·타원 위의 호
// ---------------------------------------------------------------------------

/** 원(타원) 위 구간들을 원본(첫 구간)이 든 덩어리의 시작부터 반시계로 합친다. 한 바퀴면 null */
function unionFrom(intervals: { s: number; sw: number }[], tolA: number, allowGap = true): { s: number; sw: number; full: boolean; members: Set<number> } {
  const s0 = intervals[0]!.s;
  // 원본 시작 기준 오프셋
  const iv = intervals.map((v) => ({ o: ccwFrom(s0, v.s), sw: v.sw }));
  iv[0]!.o = 0;
  // 원본 덩어리: 원본과 겹치거나 닿는 구간을 앞뒤로 잇는다
  let lo = 0;
  let hi = iv[0]!.sw;
  let grew = true;
  const inComp = new Set<number>([0]);
  while (grew) {
    grew = false;
    iv.forEach((v, i) => {
      if (inComp.has(i)) return;
      const a = v.o;
      const b = v.o + v.sw;
      // 그대로, 또는 한 바퀴 앞당겨
      for (const sh of [0, -TAU]) {
        const aa = a + sh;
        const bb = b + sh;
        if (aa <= hi + tolA && bb >= lo - tolA) {
          lo = Math.min(lo, aa);
          hi = Math.max(hi, bb);
          inComp.add(i);
          grew = true;
          break;
        }
      }
    });
  }
  // 반시계로 가장 먼 끝(틈을 건너 합칠 때)
  let end = hi;
  const members = new Set(inComp);
  if (allowGap)
    iv.forEach((v, i) => {
      if (inComp.has(i)) return;
      end = Math.max(end, v.o + v.sw);
      members.add(i);
    });
  return { s: s0 + lo, sw: end - lo, full: end - lo >= TAU - tolA, members };
}

function mergeCocircular(items: Item[], tol: number, allowGap: boolean): Item[] {
  const used = new Set<Item>();
  const out: Item[] = [];
  const arcOf = (it: Item): ArcPiece | null => (it.e.type === 'ARC' && it.path.pieces[0]!.k === 'arc' ? (it.path.pieces[0] as ArcPiece) : null);
  for (const it of items) {
    if (used.has(it)) continue;
    const A = arcOf(it);
    if (!A) {
      out.push(it);
      continue;
    }
    const group = [it];
    for (const o of items) {
      if (o === it || used.has(o)) continue;
      const B = arcOf(o);
      if (!B) continue;
      if (dist(A.c, B.c) > tol || Math.abs(A.r - B.r) > tol || Math.abs(it.path.z - o.path.z) > tol) continue;
      group.push(o);
    }
    if (group.length < 2) {
      out.push(it);
      continue;
    }
    const ivs = group.map((g) => {
      const p = g.path.pieces[0] as ArcPiece;
      return p.sw >= 0 ? { s: p.a0, sw: p.sw } : { s: p.a0 + p.sw, sw: -p.sw };
    });
    const u = unionFrom(ivs, tol / Math.max(A.r, 1e-300), allowGap);
    if (u.members.size < 2) {
      out.push(it);
      continue;
    }
    const mem = group.filter((_, i) => u.members.has(i));
    for (const g of mem) used.add(g);
    group.length = 0;
    group.push(...mem);
    const src = it.e as ArcEntity;
    let ne: ArcEntity | CircleEntity;
    if (u.full) ne = { type: 'CIRCLE', ...inherit(src), center: { x: A.c.x, y: A.c.y, z: it.path.z }, radius: A.r } as CircleEntity;
    else ne = makeArc(src, { k: 'arc', c: A.c, r: A.r, a0: u.s, sw: u.sw }, it.path.z) as ArcEntity;
    out.push({ e: ne, path: entityPath(ne)!, sources: group.flatMap((g) => g.sources), changed: true });
  }
  return out;
}

function mergeCoelliptic(items: Item[], tol: number, allowGap: boolean): Item[] {
  const used = new Set<Item>();
  const out: Item[] = [];
  const ellOf = (it: Item): EllPiece | null => (it.e.type === 'ELLIPSE' && it.path.pieces[0]!.k === 'ell' ? (it.path.pieces[0] as EllPiece) : null);
  for (const it of items) {
    if (used.has(it)) continue;
    const A = ellOf(it);
    if (!A) {
      out.push(it);
      continue;
    }
    const e0 = it.e as EllipseEntity;
    const group = [it];
    for (const o of items) {
      if (o === it || used.has(o)) continue;
      const B = ellOf(o);
      if (!B) continue;
      const e1 = o.e as EllipseEntity;
      if (dist(A.c, B.c) > tol || Math.abs(e0.ratio - e1.ratio) > 1e-9) continue;
      if (Math.hypot(e0.majorAxis.x - e1.majorAxis.x, e0.majorAxis.y - e1.majorAxis.y) > tol) continue;
      if (!!e0.extrusion !== !!e1.extrusion) continue;
      group.push(o);
    }
    if (group.length < 2) {
      out.push(it);
      continue;
    }
    const ivs = group.map((g) => {
      const e = g.e as EllipseEntity;
      return { s: e.startParam, sw: ccwSweep(e.startParam, e.endParam) };
    });
    const u = unionFrom(ivs, 1e-9, allowGap);
    if (u.members.size < 2) {
      out.push(it);
      continue;
    }
    const mem = group.filter((_, i) => u.members.has(i));
    for (const g of mem) used.add(g);
    group.length = 0;
    group.push(...mem);
    const ne = cloneEntity(e0);
    if (u.full) {
      ne.startParam = 0;
      ne.endParam = TAU;
    } else {
      ne.startParam = ((u.s % TAU) + TAU) % TAU;
      ne.endParam = ne.startParam + u.sw;
      if (ne.endParam > TAU + 1e-12) ne.endParam -= TAU;
    }
    out.push({ e: ne, path: entityPath(ne)!, sources: group.flatMap((g) => g.sources), changed: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 끝과 끝 잇기
// ---------------------------------------------------------------------------

interface Chain {
  items: Item[];
  pieces: Piece[];
  closed: boolean;
}

const startOf = (p: Path) => pieceAt(p.pieces[0]!, 0);
const endOf = (p: Path) => pieceAt(p.pieces[p.pieces.length - 1]!, 1);

function reversedPieces(p: Path): Piece[] {
  return [...p.pieces].reverse().map(reversePiece);
}

function chain(items: Item[], tol: number): Chain[] {
  const used = new Set<Item>();
  const out: Chain[] = [];
  for (const it of items) {
    if (used.has(it)) continue;
    if (it.path.closed) {
      used.add(it);
      out.push({ items: [it], pieces: it.path.pieces, closed: true });
      continue;
    }
    used.add(it);
    const list: Item[] = [it];
    let pieces: Piece[] = [...it.path.pieces];
    // 뒤로 잇기, 앞으로 잇기
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? pieceAt(pieces[pieces.length - 1]!, 1) : pieceAt(pieces[0]!, 0);
        let found: { o: Item; rev: boolean } | null = null;
        for (const o of items) {
          if (used.has(o) || o.path.closed) continue;
          const s = startOf(o.path);
          const e = endOf(o.path);
          if (forward) {
            if (dist(s, tip) <= tol) found = { o, rev: false };
            else if (dist(e, tip) <= tol) found = { o, rev: true };
          } else {
            if (dist(e, tip) <= tol) found = { o, rev: false };
            else if (dist(s, tip) <= tol) found = { o, rev: true };
          }
          if (found) break;
        }
        if (!found) break;
        used.add(found.o);
        const add = found.rev ? reversedPieces(found.o.path) : [...found.o.path.pieces];
        if (forward) {
          list.push(found.o);
          pieces = [...pieces, ...add];
        } else {
          list.unshift(found.o);
          pieces = [...add, ...pieces];
        }
        if (dist(pieceAt(pieces[0]!, 0), pieceAt(pieces[pieces.length - 1]!, 1)) <= tol) break;
      }
      if (dist(pieceAt(pieces[0]!, 0), pieceAt(pieces[pieces.length - 1]!, 1)) <= tol && list.length > 1) break;
    }
    const closed = list.length > 1 && dist(pieceAt(pieces[0]!, 0), pieceAt(pieces[pieces.length - 1]!, 1)) <= tol;
    // 원본(목록의 첫 항목)이 앞에 오도록 순서는 그대로 두고, 끝점을 정확히 맞춘다
    out.push({ items: list, pieces: snapEnds(pieces, closed), closed });
  }
  return out;
}

/** 이음매 끝점을 앞 조각 끝에 맞춘다(미세한 틈 제거) */
function snapEnds(pcs: Piece[], closed: boolean): Piece[] {
  const out = pcs.map((p) => ({ ...p }));
  for (let i = 1; i < out.length + (closed ? 1 : 0); i++) {
    const prev = out[i - 1]!;
    const cur = out[i % out.length]!;
    const e = pieceAt(prev, 1);
    if (cur.k === 'line') cur.a = e;
  }
  return out;
}

function buildChain(ch: Chain, source: Entity): Entity | null {
  const srcs = ch.items.flatMap((it) => it.sources);
  if (ch.items.length === 1) {
    // 합친 선·호 하나
    const it = ch.items[0]!;
    return it.changed ? it.e : null;
  }
  const pieces = ch.pieces.filter((p) => pieceLength(p) > 0);
  const z = ch.items[0]!.path.z;
  const anyCurve = pieces.some((p) => p.k === 'ell' || p.k === 'nurbs') || srcs.some((s) => s.type === 'SPLINE' || s.type === 'ELLIPSE');
  if (anyCurve) {
    const n = piecesNurbs(pieces, z);
    if (!n) return null;
    const sp = makeSpline(srcs.find((s) => s.type === 'SPLINE') ?? source, n, ch.closed);
    return sp;
  }
  const zs = ch.items.map((it) => it.path.z);
  const nonPlanar = srcs.some((s) => s.type === 'POLYLINE' && s.kind === '3d') || zs.some((v) => Math.abs(v - z) > 1e-9) || pieces.some((p) => p.za !== undefined && (Math.abs(p.za - z) > 1e-9 || Math.abs((p.zb ?? p.za) - z) > 1e-9));
  if (nonPlanar) {
    if (pieces.every((p) => p.k === 'line')) return make3dPolyline(srcs.find((s) => s.type === 'POLYLINE' && s.kind === '3d') ?? source, pieces, ch.closed);
    const n = piecesNurbs(pieces, z);
    return n ? makeSpline(source, n, ch.closed) : null;
  }
  // 폭: 원본 폴리선이 폭 하나면 전체가 그 폭, 아니면 선·호는 닿은 쪽 폭을 받는다
  const wide = pieces.some((p) => (p.w0 ?? 0) > 0 || (p.w1 ?? 0) > 0);
  let pcs = pieces.map((p) => ({ ...p }));
  if (wide) {
    const srcPoly = source.type === 'LWPOLYLINE' || (source.type === 'POLYLINE' && source.kind === '2d') ? source : null;
    const srcPath = srcPoly ? entityPath(srcPoly) : null;
    const w = srcPath?.pieces[0]?.w0 ?? 0;
    const constant = srcPath && srcPath.pieces.every((p) => Math.abs((p.w0 ?? 0) - w) < 1e-12 && Math.abs((p.w1 ?? 0) - w) < 1e-12);
    if (constant) pcs = pcs.map((p) => ({ ...p, w0: w, w1: w }));
    else {
      for (let i = 0; i < pcs.length; i++) {
        const p = pcs[i]!;
        if (p.w0 !== undefined || p.w1 !== undefined) continue;
        const prev = pcs[i - 1];
        const next = pcs[i + 1];
        const v = prev && prev.w1 !== undefined ? prev.w1 : next && next.w0 !== undefined ? next.w0 : 0;
        p.w0 = v;
        p.w1 = v;
      }
    }
  }
  // 원본이 2D POLYLINE이면 그 종류, 아니면 원본 특성을 잇는 LWPOLYLINE
  return makePolyline(source, pcs, ch.closed, z);
}
