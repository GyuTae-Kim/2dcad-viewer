/**
 * EXTRIM(Express Tools): 절단 모서리 한쪽 면에서 모서리와 교차하는 모든 객체를 자른다.
 * 대상 객체를 모서리와의 교점으로 나눈 조각 가운데 고른 쪽에 있는 조각(교점에 닿은 조각)을 TRIM한다.
 * 닫힌 모서리는 안·밖, 열린 모서리는 진행 방향의 왼쪽·오른쪽으로 쪽을 가린다. 모서리를 연장하지 않는다(EDGEMODE 0).
 */
import type { CadDocument, Entity, Vec2 } from '../../core/model';
import { type Path, pathAt, pathBox, pathNearest } from './curve';
import { boxesOverlap } from './edges';
import { intersectPieces } from './intersect';
import { sideOf } from './offset';
import { entityPath } from './path';
import { trimEntity } from './trim';
import type { EditResult } from './types';

/** 절단 모서리로 쓸 수 있는 객체 */
export function isExtrimEdge(e: Entity): boolean {
  switch (e.type) {
    case 'LINE':
    case 'ARC':
    case 'CIRCLE':
    case 'ELLIPSE':
    case 'LWPOLYLINE':
    case 'SPLINE':
      return true;
    case 'POLYLINE':
      return e.kind === '2d' || e.kind === '3d';
    default:
      return false;
  }
}

/** 대상 경로를 모서리 교점으로 나눈 조각들 가운데 side 쪽 조각의 가운데 점 */
export function trimPicks(target: Path, edge: Path, side: number): Vec2[] {
  const cuts: number[] = [];
  target.pieces.forEach((p, i) => {
    for (const q of edge.pieces) for (const h of intersectPieces(p, q)) cuts.push(i + h.t);
  });
  if (!cuts.length) return [];
  cuts.sort((a, b) => a - b);
  const n = target.pieces.length;
  const ss: number[] = [];
  for (const s of cuts) if (!ss.length || s - ss[ss.length - 1]! > 1e-9) ss.push(s);
  const spans: [number, number][] = [];
  if (target.closed) {
    for (let i = 0; i < ss.length; i++) {
      const a = ss[i]!;
      const b = i + 1 < ss.length ? ss[i + 1]! : ss[0]! + n;
      spans.push([a, b]);
    }
  } else {
    const bounds = [0, ...ss, n];
    for (let i = 0; i + 1 < bounds.length; i++) spans.push([bounds[i]!, bounds[i + 1]!]);
  }
  const out: Vec2[] = [];
  for (const [a, b] of spans) {
    if (b - a <= 1e-9) continue;
    let m = (a + b) / 2;
    if (m >= n) m -= n;
    const p = pathAt(target, m);
    if (sideOf(edge, p) === side) out.push(p);
  }
  return out;
}

/**
 * 절단 모서리 edge의 sidePoint 쪽을 자른다. candidates는 자를 후보(모서리 자신은 건너뛴다).
 * 결과는 TRIM과 같은 replace·add·remove.
 */
export function extrim(edge: Entity, sidePoint: Vec2, candidates: readonly Entity[], doc?: CadDocument): EditResult {
  const ep = entityPath(edge);
  if (!ep || !ep.pieces.length) return { message: '절단 모서리로 쓸 수 없는 객체입니다.' };
  const side = sideOf(ep, sidePoint);
  const eb = pathBox(ep);
  const pad = 1e-9 * Math.max(1, eb.maxX - eb.minX, eb.maxY - eb.minY);
  const out: EditResult = {};
  let count = 0;
  for (const c of candidates) {
    if (c === edge || (c.handle && c.handle === edge.handle)) continue;
    const cp = entityPath(c);
    if (!cp || !cp.pieces.length) continue;
    const infinite = cp.pieces.some((p) => p.k === 'line' && (p.inf0 || p.inf1));
    if (!infinite && !boxesOverlap(pathBox(cp), eb, pad)) continue;
    const picks = trimPicks(cp, ep, side);
    if (!picks.length) continue;
    // 조각마다 차례로 자른다(앞 자르기의 결과 위에서)
    let pieces: Entity[] = [c];
    let changed = false;
    for (const pk of picks) {
      let best = -1;
      let bd = Infinity;
      pieces.forEach((x, i) => {
        const xp = entityPath(x);
        if (!xp) return;
        const d = pathNearest(xp, pk).d;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best < 0) continue;
      const cur = pieces[best]!;
      const r = trimEntity(cur, [edge], pk, { doc });
      if (!r.add?.length && !r.replace?.length && r.remove === undefined) continue;
      changed = true;
      const next = pieces.filter((_, i) => i !== best);
      for (const x of r.replace ?? []) next.push(x);
      for (const x of r.add ?? []) next.push(x);
      pieces = next;
    }
    if (!changed) continue;
    count++;
    const kept = pieces.find((x) => x.handle && x.handle === c.handle && x.type === c.type);
    if (kept) (out.replace ??= []).push(kept);
    else (out.remove ??= []).push(c.handle);
    for (const x of pieces) if (x !== kept) (out.add ??= []).push({ ...x, handle: '' } as Entity);
  }
  if (!count) out.message = '절단 모서리와 교차하는 객체가 없습니다.';
  return out;
}
