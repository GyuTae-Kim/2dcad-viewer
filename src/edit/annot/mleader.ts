/**
 * 다중 지시선 편집 계산: 지시선 추가·제거(MLEADEREDIT), 내용 옮기기·정렬(MLEADERALIGN),
 * 블록 내용 모으기(MLEADERCOLLECT), 지시선 끊기(DIMBREAK) 점 쌍.
 * 다중 지시선 좌표는 WCS다(문맥 자료의 점들).
 */
import type { MLeaderEntity, MLeaderLeader, Vec3 } from '../../core/model';
import type { Piece } from '../geom/curve';
import { intersectAll } from '../geom/intersect';

export interface P {
  x: number;
  y: number;
}

const v3 = (q: P, z = 0): Vec3 => ({ x: q.x, y: q.y, z });
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const mv = (q: Vec3, d: P): Vec3 => ({ x: q.x + d.x, y: q.y + d.y, z: q.z });

/** 지시선 하나의 연결 점(없으면 내용 기준점) */
export function landingOf(e: MLeaderEntity, ld?: MLeaderLeader): P {
  const l = ld ?? e.context.leaders[0];
  return l?.lastLeaderPoint ?? e.context.contentBase;
}

/** 지시선 선의 꼭짓점(화살촉 → … → 연결 점) */
export function leaderPolyline(ld: MLeaderLeader, lineIndex: number): P[] {
  const ln = ld.lines[lineIndex];
  if (!ln) return [];
  const pts: P[] = ln.vertices.map((v) => ({ x: v.x, y: v.y }));
  if (ld.lastLeaderPoint) pts.push({ x: ld.lastLeaderPoint.x, y: ld.lastLeaderPoint.y });
  return pts;
}

function segDist(q: P, a: P, b: P): number {
  const d = sub(b, a);
  const L = dot(d, d);
  const t = L > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / L)) : 0;
  return dist(q, { x: a.x + d.x * t, y: a.y + d.y * t });
}

/** 점에서 가장 가까운 지시선 선 */
export function nearestLeaderLine(e: MLeaderEntity, q: P): { leader: number; line: number; d: number } | null {
  let best: { leader: number; line: number; d: number } | null = null;
  e.context.leaders.forEach((ld, i) =>
    ld.lines.forEach((_, j) => {
      const pts = leaderPolyline(ld, j);
      let d = pts.length === 1 ? dist(q, pts[0]!) : Infinity;
      for (let k = 0; k + 1 < pts.length; k++) d = Math.min(d, segDist(q, pts[k]!, pts[k + 1]!));
      if (!best || d < best.d) best = { leader: i, line: j, d };
    }),
  );
  return best;
}

/** 모든 지시선 선의 수 */
export function lineCount(e: MLeaderEntity): number {
  return e.context.leaders.reduce((n, ld) => n + ld.lines.length, 0);
}

/**
 * 지시선 추가: 화살촉 점이 내용 가운데의 어느 쪽인지 보고 그 쪽을 향하는 지시선에 선을 더한다.
 * 그 쪽 지시선이 없으면 내용 건너편 끝(contentWidth)에 같은 연결선 길이의 새 지시선을 만든다.
 */
export function addLeaderLine(e: MLeaderEntity, arrow: P, contentWidth: number): MLeaderEntity {
  const c = structuredClone(e);
  const ctx = c.context;
  const side = (ld: MLeaderLeader) => (ld.doglegVector && ld.doglegVector.x < 0 ? -1 : 1);
  const first = ctx.leaders[0];
  const gap = ctx.landingGap || 0;
  const w = Math.max(0, contentWidth);
  const base = ctx.contentBase;
  const s0 = first ? side(first) : 1;
  // 내용 왼쪽·오른쪽 끝
  const near = base.x + s0 * gap;
  const left = s0 > 0 ? near : near - w;
  const right = s0 > 0 ? near + w : near;
  const want = arrow.x <= (left + right) / 2 ? 1 : -1;
  const index = Math.max(-1, ...ctx.leaders.flatMap((l) => l.lines.map((x) => x.index))) + 1;
  let ld = ctx.leaders.find((l) => side(l) === want);
  if (!ld) {
    const dl = first?.doglegLength ?? c.doglegLength ?? 0;
    const hasDogleg = first?.hasDogleg ?? c.dogleg;
    const y = first?.lastLeaderPoint?.y ?? base.y;
    const z = first?.lastLeaderPoint?.z ?? base.z;
    const x = want > 0 ? left - gap - (hasDogleg ? dl : 0) : right + gap + (hasDogleg ? dl : 0);
    ld = {
      lastLeaderPoint: { x, y, z },
      doglegVector: { x: want, y: 0, z: 0 },
      doglegLength: hasDogleg ? dl : 0,
      hasLastPoint: true,
      hasDogleg,
      lines: [],
      index: Math.max(-1, ...ctx.leaders.map((l) => l.index)) + 1,
      attachmentDirection: 0,
    };
    ctx.leaders.push(ld);
  }
  ld.lines.push({ vertices: [v3(arrow, ld.lastLeaderPoint?.z ?? 0)], index });
  return c;
}

/** 지시선 제거(마지막 하나는 남긴다). 고른 선이 없으면 null */
export function removeLeaderLine(e: MLeaderEntity, q: P): MLeaderEntity | null {
  if (lineCount(e) <= 1) return null;
  const n = nearestLeaderLine(e, q);
  if (!n) return null;
  const c = structuredClone(e);
  const ld = c.context.leaders[n.leader]!;
  ld.lines.splice(n.line, 1);
  if (!ld.lines.length) c.context.leaders.splice(n.leader, 1);
  return c;
}

/** 내용(문자·블록·연결 점)을 delta만큼 옮긴다. 화살촉과 중간 꼭짓점은 그대로 */
export function translateContent(e: MLeaderEntity, delta: P): MLeaderEntity {
  const c = structuredClone(e);
  const ctx = c.context;
  ctx.contentBase = mv(ctx.contentBase, delta);
  ctx.basePoint = mv(ctx.basePoint, delta);
  if (ctx.text) ctx.text.location = mv(ctx.text.location, delta);
  if (ctx.block) {
    ctx.block.location = mv(ctx.block.location, delta);
    if (ctx.block.matrix && ctx.block.matrix.length === 16) {
      ctx.block.matrix[3] = ctx.block.matrix[3]! + delta.x;
      ctx.block.matrix[7] = ctx.block.matrix[7]! + delta.y;
    }
  }
  for (const ld of ctx.leaders) {
    if (ld.lastLeaderPoint) ld.lastLeaderPoint = mv(ld.lastLeaderPoint, delta);
    for (const ln of ld.lines) delete ln.breaks;
  }
  return c;
}

export type AlignMode = { kind: 'current' } | { kind: 'spacing'; spacing: number } | { kind: 'distribute'; from: P; to: P } | { kind: 'parallel' };

/**
 * 정렬: 기준 다중 지시선의 연결 점을 지나는 방향 dir 직선 위로 다른 지시선의 연결 점을 옮긴다.
 * current = 직선 위 자리만 맞춤(직선 방향 위치 유지), spacing = 기준에서 간격마다, distribute = 두 점 사이 고르게,
 * parallel = 마지막 지시선 세그먼트를 기준과 나란하게(길이 유지).
 */
export function alignMleaders(base: MLeaderEntity, others: readonly MLeaderEntity[], dir: P, mode: AlignMode): MLeaderEntity[] {
  const l = Math.hypot(dir.x, dir.y) || 1;
  const u = { x: dir.x / l, y: dir.y / l };
  const n = { x: -u.y, y: u.x };
  const b = landingOf(base);
  const out: MLeaderEntity[] = [];
  if (mode.kind === 'parallel') {
    const bl = base.context.leaders[0];
    const bp = bl ? leaderPolyline(bl, 0) : [];
    if (bp.length < 2) return [];
    const a = bp[bp.length - 2]!;
    const z = bp[bp.length - 1]!;
    const bd = sub(z, a);
    const bl2 = Math.hypot(bd.x, bd.y) || 1;
    const bu = { x: bd.x / bl2, y: bd.y / bl2 };
    for (const e of others) {
      const ld = e.context.leaders[0];
      const pts = ld ? leaderPolyline(ld, 0) : [];
      if (pts.length < 2) continue;
      const p0 = pts[pts.length - 2]!;
      const p1 = pts[pts.length - 1]!;
      const L = dist(p0, p1);
      const target = { x: p0.x + bu.x * L, y: p0.y + bu.y * L };
      out.push(translateContent(e, sub(target, p1)));
    }
    return out;
  }
  const items = others.map((e) => ({ e, p: landingOf(e) })).sort((x, y) => dot(sub(x.p, b), u) - dot(sub(y.p, b), u));
  if (mode.kind === 'distribute') {
    const all = items;
    const k = all.length;
    all.forEach((it, i) => {
      const t = k === 1 ? 0.5 : i / (k - 1);
      const target = { x: mode.from.x + (mode.to.x - mode.from.x) * t, y: mode.from.y + (mode.to.y - mode.from.y) * t };
      out.push(translateContent(it.e, sub(target, it.p)));
    });
    return out;
  }
  // 기준 앞뒤로 나눠 가까운 것부터
  const ahead = items.filter((it) => dot(sub(it.p, b), u) >= 0);
  const behind = items.filter((it) => dot(sub(it.p, b), u) < 0).reverse();
  for (const [list, sgn] of [
    [ahead, 1],
    [behind, -1],
  ] as const) {
    list.forEach((it, i) => {
      const along = mode.kind === 'spacing' ? sgn * (i + 1) * mode.spacing : dot(sub(it.p, b), u);
      const target = { x: b.x + u.x * along, y: b.y + u.y * along };
      const delta = sub(target, it.p);
      if (Math.hypot(delta.x, delta.y) < 1e-12) return;
      out.push(translateContent(it.e, delta));
    });
  }
  void n;
  return out;
}

/**
 * 끊기 점 쌍: 지시선 선(직선)이 끊는 객체와 만나는 곳마다 양쪽으로 size/2. 화살촉 아래(첫 size)는 끊지 않는다.
 * 돌려주는 값은 선마다 [시작, 끝] 쌍(WCS).
 */
export function mleaderBreakPairs(e: MLeaderEntity, cutters: readonly Piece[], size: number): Map<string, { start: Vec3; end: Vec3 }[]> {
  const out = new Map<string, { start: Vec3; end: Vec3 }[]>();
  e.context.leaders.forEach((ld, i) =>
    ld.lines.forEach((_, j) => {
      const pts = leaderPolyline(ld, j);
      const pairs: { start: Vec3; end: Vec3 }[] = [];
      let acc = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k]!;
        const b = pts[k + 1]!;
        const L = dist(a, b);
        if (!(L > 0)) continue;
        const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
        for (const q of intersectAll([{ k: 'line', a, b }], cutters)) {
          const t = dot(sub(q, a), u);
          if (acc + t < size) continue;
          const t0 = Math.max(0, t - size / 2);
          const t1 = Math.min(L, t + size / 2);
          pairs.push({ start: v3({ x: a.x + u.x * t0, y: a.y + u.y * t0 }), end: v3({ x: a.x + u.x * t1, y: a.y + u.y * t1 }) });
        }
        acc += L;
      }
      if (pairs.length) out.set(`${i}:${j}`, pairs);
    }),
  );
  return out;
}

/** 수동 끊기: q1에 가장 가까운 지시선 선 위에서 두 점의 발 사이 */
export function mleaderManualBreak(e: MLeaderEntity, q1: P, q2: P): { leader: number; line: number; pair: { start: Vec3; end: Vec3 } } | null {
  const n = nearestLeaderLine(e, q1);
  if (!n) return null;
  const pts = leaderPolyline(e.context.leaders[n.leader]!, n.line);
  let best = -1;
  let bd = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const d = segDist(q1, pts[k]!, pts[k + 1]!);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  if (best < 0) return null;
  const a = pts[best]!;
  const b = pts[best + 1]!;
  const L = dist(a, b);
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const t = (q: P) => Math.max(0, Math.min(L, dot(sub(q, a), u)));
  const [t0, t1] = [t(q1), t(q2)].sort((x, y) => x - y) as [number, number];
  if (t1 - t0 < 1e-12) return null;
  return { leader: n.leader, line: n.line, pair: { start: v3({ x: a.x + u.x * t0, y: a.y + u.y * t0 }), end: v3({ x: a.x + u.x * t1, y: a.y + u.y * t1 }) } };
}

/**
 * 끊기를 뺀 지시선 선 토막(그리기용). pts = 화살촉 → … → 연결 점, breaks = 선 위 [시작, 끝] 쌍(WCS).
 * 쌍의 두 점을 꺾은선 위 가장 가까운 자리(처음부터 잰 길이)로 옮겨 그 사이를 뺀다. 끊기가 없으면 [pts].
 */
export function breakRuns(pts: readonly Vec3[], breaks: readonly { start: P; end: P }[] | undefined): Vec3[][] {
  if (pts.length < 2 || !breaks?.length) return [pts.slice()];
  const acc: number[] = [0];
  for (let k = 0; k + 1 < pts.length; k++) acc.push(acc[k]! + dist(pts[k]!, pts[k + 1]!));
  const total = acc[acc.length - 1]!;
  if (!(total > 0)) return [pts.slice()];
  // 점 → 꺾은선 위 길이
  const along = (q: P): number => {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const L = acc[k + 1]! - acc[k]!;
      const t = L > 0 ? Math.max(0, Math.min(L, dot(sub(q, a), sub(b, a)) / L)) : 0;
      const f = L > 0 ? t / L : 0;
      const d = dist(q, { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      if (d < bd) {
        bd = d;
        best = acc[k]! + t;
      }
    }
    return best;
  };
  const at = (s: number): Vec3 => {
    let k = 0;
    while (k + 2 < acc.length && acc[k + 1]! < s) k++;
    const L = acc[k + 1]! - acc[k]!;
    const f = L > 0 ? (s - acc[k]!) / L : 0;
    const a = pts[k]!;
    const b = pts[k + 1]!;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  };
  const cuts = breaks.map((b) => [along(b.start), along(b.end)].sort((x, y) => x - y) as [number, number]).sort((x, y) => x[0] - y[0]);
  const keep: [number, number][] = [];
  let s = 0;
  for (const [a, b] of cuts) {
    if (a > s) keep.push([s, a]);
    s = Math.max(s, b);
  }
  if (s < total) keep.push([s, total]);
  const eps = 1e-9 * Math.max(1, total);
  return keep
    .filter(([a, b]) => b - a > eps)
    .map(([a, b]) => {
      const run = [at(a)];
      for (let k = 1; k + 1 < pts.length; k++) if (acc[k]! > a + eps && acc[k]! < b - eps) run.push({ ...pts[k]! });
      run.push(at(b));
      return run;
    });
}

/** 블록 모으기 배치: 크기 목록을 수평(H)·수직(V)·줄바꿈(W, 폭 또는 개수)으로 늘어놓은 자리(왼쪽 아래 기준) */
export function collectLayout(sizes: readonly { w: number; h: number }[], mode: { kind: 'H' } | { kind: 'V' } | { kind: 'W'; width?: number; count?: number }, gap: number): P[] {
  const out: P[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let inRow = 0;
  for (const s of sizes) {
    if (mode.kind === 'V') {
      out.push({ x: 0, y: -y - s.h });
      y += s.h + gap;
      continue;
    }
    if (mode.kind === 'W') {
      const over = mode.count ? inRow >= mode.count : mode.width ? inRow > 0 && x + s.w > mode.width : false;
      if (over) {
        x = 0;
        y += rowH + gap;
        rowH = 0;
        inRow = 0;
      }
    }
    out.push({ x, y: -y - s.h });
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
    inRow++;
  }
  return out;
}
