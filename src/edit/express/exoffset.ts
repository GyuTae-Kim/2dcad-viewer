/**
 * EXOFFSET(Express Tools 간격띄우기 확장) 계산(UI 없음).
 * OFFSET과 다른 점:
 * - 여러 객체를 한 번에 고른다. 끝이 닿는(틈 허용 거리 안) 선·호·폴리선은 한 줄로 이어 함께 간격띄운다 —
 *   모서리가 서로 이어진 결과가 된다.
 * - 간격 유형: 보통(모서리를 늘려 만나게), 모깎기(바깥 모서리를 간격띄우기 거리 반지름의 호로),
 *   모따기(바깥 모서리를 원래 꼭짓점에서 간격띄우기 거리만큼 떨어진 직선으로).
 * - 결합: 끄면 이어서 간격띄운 결과를 원래처럼 낱개 선·호로 나눈다(원래 폴리선이던 것은 폴리선으로 둔다).
 */
import type { CadDocument, Entity, LwPolylineEntity, LwVertex, Vec2 } from '../../core/model';
import { type EditResult, explodeEntity, joinEntities, offsetEntity } from '../geom';
import { pathNearest } from '../geom/curve';
import { isNaturalExt } from '../geom/ocs';
import { entityPath } from '../geom/path';
import { lwVertices, packLw } from '../../core/lwpoly';

export type GapType = 'N' | 'F' | 'C';

export const GAP_LABEL: Record<GapType, string> = { N: '보통', F: '모깎기', C: '모따기' };

export interface ExoffsetOptions {
  gap: GapType;
  /** 이어서 간격띄운 결과를 한 폴리선으로 둔다 */
  join: boolean;
  /** 끝점을 이을 때 허용하는 틈(0 = 정확히 닿아야) */
  fuzz?: number;
}

export interface Chain {
  entity: Entity;
  /** 원래 객체 핸들(이어진 것 모두) */
  sources: string[];
  /** 낱개 객체 둘 이상을 이었는지 */
  joined: boolean;
}

/** 고른 객체를 이어진 줄로 묶는다(원래 객체는 바꾸지 않는다) */
export function chainsOf(list: readonly Entity[], fuzz = 0): Chain[] {
  if (list.length < 2) return list.map((e) => ({ entity: e, sources: [e.handle], joined: false }));
  const clones = list.map((e) => structuredClone(e));
  let r: EditResult;
  try {
    r = joinEntities(clones, fuzz > 0 ? { tol: fuzz } : {});
  } catch {
    r = {};
  }
  const removed = new Set(r.remove ?? []);
  const replaced = new Map((r.replace ?? []).map((e) => [e.handle, e] as const));
  const out: Chain[] = [];
  const consumed = new Set<string>();
  for (const e of list) {
    if (removed.has(e.handle)) {
      consumed.add(e.handle);
      continue;
    }
    const rep = replaced.get(e.handle);
    if (rep) out.push({ entity: rep, sources: [e.handle], joined: true });
    else out.push({ entity: e, sources: [e.handle], joined: false });
  }
  // 이어 붙인 결과가 새 객체면(add) 그것도 줄이다
  for (const a of r.add ?? []) out.push({ entity: a, sources: [], joined: true });
  // 지워진 원본은 가장 가까운 이어진 줄에 속한다(표시용)
  for (const h of consumed) {
    const c = out.find((x) => x.joined);
    if (c) c.sources.push(h);
  }
  return out;
}

/** 간격띄우기 결과 폴리선의 바깥 모서리를 모깎기·모따기한다(원래 경로 path에서 d보다 먼 꼭짓점) */
export function applyGap(e: LwPolylineEntity, original: Entity, d: number, gap: GapType): LwPolylineEntity {
  if (gap === 'N' || !isNaturalExt(e.extrusion)) return e;
  const path = entityPath(original);
  if (!path) return e;
  const vs = lwVertices(e);
  const n = vs.length;
  if (n < 3 && !(e.closed && n >= 2)) return e;
  const out: LwVertex[] = [];
  const tol = 1e-7 * Math.max(1, d);
  const at = (i: number) => vs[((i % n) + n) % n]!;
  for (let i = 0; i < n; i++) {
    const v = vs[i]!;
    const hasPrev = e.closed || i > 0;
    const hasNext = e.closed || i < n - 1;
    const prev = at(i - 1);
    // 앞뒤가 모두 곧은 조각인 꼭짓점만
    if (!hasPrev || !hasNext || Math.abs(prev.bulge) > 1e-12 || Math.abs(v.bulge) > 1e-12) {
      out.push({ ...v });
      continue;
    }
    const P = { x: v.x, y: v.y };
    const near = pathNearest(path, P);
    if (!(near.d > d + tol)) {
      out.push({ ...v });
      continue;
    }
    const V = near.p;
    const A = { x: prev.x, y: prev.y };
    const B = { x: at(i + 1).x, y: at(i + 1).y };
    const foot = (a: Vec2, b: Vec2): Vec2 => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = ((V.x - a.x) * dx + (V.y - a.y) * dy) / l2;
      return { x: a.x + dx * t, y: a.y + dy * t };
    };
    const F1 = foot(A, P);
    const F2 = foot(P, B);
    const v1 = { x: F1.x - V.x, y: F1.y - V.y };
    const v2 = { x: F2.x - V.x, y: F2.y - V.y };
    if (gap === 'F') {
      const sweep = Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y);
      out.push({ ...v, x: F1.x, y: F1.y, bulge: Math.tan(sweep / 4) });
      out.push({ ...v, x: F2.x, y: F2.y, bulge: 0 });
      continue;
    }
    // 모따기: 이등분 방향 m에 수직이고 V에서 d 떨어진 직선
    const ml = Math.hypot(v1.x + v2.x, v1.y + v2.y);
    if (!(ml > 1e-12)) {
      out.push({ ...v });
      continue;
    }
    const m = { x: (v1.x + v2.x) / ml, y: (v1.y + v2.y) / ml };
    const cut = (a: Vec2, b: Vec2): Vec2 | null => {
      const dir = { x: b.x - a.x, y: b.y - a.y };
      const den = dir.x * m.x + dir.y * m.y;
      if (Math.abs(den) < 1e-12) return null;
      const t = (d - ((a.x - V.x) * m.x + (a.y - V.y) * m.y)) / den;
      return { x: a.x + dir.x * t, y: a.y + dir.y * t };
    };
    const C1 = cut(A, P);
    const C2 = cut(P, B);
    if (!C1 || !C2) {
      out.push({ ...v });
      continue;
    }
    out.push({ ...v, x: C1.x, y: C1.y, bulge: 0 });
    out.push({ ...v, x: C2.x, y: C2.y, bulge: 0 });
  }
  return { ...e, ...packLw(out) };
}

/** 줄 하나를 side 쪽으로 d만큼 간격띄운다(간격 유형·결합 적용). 결과 객체는 핸들 '' */
export function offsetChain(c: Chain, d: number, side: Vec2, opt: ExoffsetOptions, doc: CadDocument): { add: Entity[]; message?: string } {
  const r = offsetEntity(c.entity, d, side);
  if (!r.add?.length) return { add: [], message: r.message };
  let add = r.add.map((x) => (x.type === 'LWPOLYLINE' ? applyGap(x, c.entity, d, opt.gap) : x));
  if (!opt.join && c.joined) {
    const parts: Entity[] = [];
    for (const x of add) {
      if (x.type !== 'LWPOLYLINE' && x.type !== 'POLYLINE') {
        parts.push(x);
        continue;
      }
      const ex = explodeEntity({ ...x, handle: '' }, doc);
      parts.push(...(ex.add?.length ? ex.add : [x]));
    }
    add = parts;
  }
  for (const x of add) x.handle = '';
  return { add };
}

/** 줄에서 side의 거리(통과점) */
export function chainDistance(c: Chain, side: Vec2): number {
  const path = entityPath(c.entity);
  if (!path) return 0;
  return pathNearest(path, side).d;
}

/** 줄 반대쪽 점(양쪽 간격띄우기): 가장 가까운 점에 대해 side를 뒤집는다 */
export function oppositeSide(c: Chain, side: Vec2): Vec2 | null {
  const path = entityPath(c.entity);
  if (!path) return null;
  const q = pathNearest(path, side).p;
  return { x: 2 * q.x - side.x, y: 2 * q.y - side.y };
}
