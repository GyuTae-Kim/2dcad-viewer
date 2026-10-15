/**
 * 배열 블록의 항목 참조에서 연관 배열 매개변수를 짐작한다(AutoCAD 기록의 원본 태그가 없을 때 — DWG에서 읽은 배열).
 *  - 경로 곡선(배열 동작의 종속을 반응자로 가진 곡선)이 있으면 경로: 항목 자리를 경로에 투영해 개수·간격·방향·정렬을 구한다.
 *  - 항목이 모두 돌지 않았고 격자에 놓였으면 직사각형, 한 원(또는 같은 중심의 원들) 위에 있으면 원형.
 * 짐작한 매개변수는 항목 맞추기(match.ts)로 다시 확인한다(맞지 않으면 편집할 수 없는 배열로 본다).
 */
import type { BlockDef, CadDocument, InsertEntity, Vec2 } from '../../core/model';
import { tableKey } from '../../core/model';
import { insertAffine } from '../dynblock/build';
import { entityPath } from '../geom/path';
import { pathLength, pathNearest, pathTangent } from '../geom/curve';
import { type Affine, affMul } from '../geom/math';
import type { ArrayParams, PathParams } from './types';

export interface ItemRef {
  handle: string;
  block: string;
  /** 블록 좌표 → 배열 블록 좌표 */
  matrix: Affine;
  z: number;
}

/** 배열 블록 안의 항목 참조(참조가 아닌 객체가 있으면 null) */
export function itemRefs(doc: CadDocument, def: BlockDef): ItemRef[] | null {
  const out: ItemRef[] = [];
  for (const e of def.entities) {
    if (e.type !== 'INSERT') return null;
    const bd = doc.blocks.get(tableKey(e.block));
    if (!bd) return null;
    out.push({ handle: e.handle, block: bd.name, matrix: insertAffine(bd, e), z: e.insert.z - bd.basePoint.z * e.scale.z });
  }
  return out;
}

/** 가장 많이 쓰인 블록(원본) */
export function commonBlock(refs: readonly ItemRef[]): string | null {
  const n = new Map<string, number>();
  for (const r of refs) n.set(r.block, (n.get(r.block) ?? 0) + 1);
  let best: string | null = null;
  let bn = 0;
  for (const [k, v] of n)
    if (v > bn) {
      best = k;
      bn = v;
    }
  return best;
}

const rotOf = (m: Affine) => Math.atan2(m[1], m[0]);
const isPlain = (m: Affine) => Math.abs(m[0] - 1) < 1e-7 && Math.abs(m[1]) < 1e-7 && Math.abs(m[2]) < 1e-7 && Math.abs(m[3] - 1) < 1e-7;

/** 정렬한 값을 공차로 묶는다 */
function clusters(vals: number[], tol: number): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1]! > tol) out.push(v);
  return out;
}

/** 값들이 a + k·d(k 정수)에 놓이는 가장 큰 d(최소 간격) */
function lattice(vals: number[], tol: number): { start: number; step: number; count: number } | null {
  if (vals.length === 1) return { start: vals[0]!, step: 0, count: 1 };
  let step = Infinity;
  for (let i = 1; i < vals.length; i++) step = Math.min(step, vals[i]! - vals[i - 1]!);
  if (!(step > tol)) return null;
  for (const v of vals) {
    const k = (v - vals[0]!) / step;
    if (Math.abs(k - Math.round(k)) * step > tol) return null;
  }
  return { start: vals[0]!, step, count: Math.round((vals[vals.length - 1]! - vals[0]!) / step) + 1 };
}

function tolOf(refs: readonly ItemRef[]): number {
  let m = 1;
  for (const r of refs) m = Math.max(m, Math.abs(r.matrix[4]), Math.abs(r.matrix[5]));
  return m * 1e-7;
}

function inferRect(refs: readonly ItemRef[]): ArrayParams | null {
  if (!refs.every((r) => isPlain(r.matrix))) return null;
  const tol = tolOf(refs);
  const xs = lattice(clusters(refs.map((r) => r.matrix[4]), tol), tol);
  const ys = lattice(clusters(refs.map((r) => r.matrix[5]), tol), tol);
  if (!xs || !ys) return null;
  const zs = clusters(refs.map((r) => r.z), tol);
  const zl = lattice(zs, tol);
  return {
    kind: 'rect',
    base: { x: 0, y: 0 },
    origin: { x: xs.start, y: ys.start },
    columns: xs.count,
    columnSpacing: xs.step || 1,
    rows: ys.count,
    rowSpacing: ys.step || 1,
    axesAngle: Math.PI / 2,
    rowElevation: 0,
    levels: zl ? zl.count : 1,
    levelSpacing: zl?.step || 1,
  };
}

/** 세 점을 지나는 원의 중심 */
function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

function inferPolar(refs: readonly ItemRef[]): ArrayParams | null {
  if (refs.length < 2) return null;
  const tol = tolOf(refs) * 10;
  const pts = refs.map((r) => ({ x: r.matrix[4], y: r.matrix[5] }));
  const rotating = refs.some((r) => !isPlain(r.matrix));
  let center: Vec2 | null = null;
  if (rotating) {
    // 돈 항목 둘: p1 − c = R(Δ)(p0 − c)
    const a = refs.find((r) => isPlain(r.matrix)) ?? refs[0]!;
    const b = refs.find((r) => Math.abs(rotOf(r.matrix) - rotOf(a.matrix)) > 1e-6);
    if (b) {
      const d = rotOf(b.matrix) - rotOf(a.matrix);
      const c = Math.cos(d);
      const s = Math.sin(d);
      // (I − R) c = p1 − R p0
      const p0 = { x: a.matrix[4], y: a.matrix[5] };
      const p1 = { x: b.matrix[4], y: b.matrix[5] };
      const rx = p1.x - (c * p0.x - s * p0.y);
      const ry = p1.y - (s * p0.x + c * p0.y);
      const m00 = 1 - c;
      const m01 = s;
      const m10 = -s;
      const m11 = 1 - c;
      const det = m00 * m11 - m01 * m10;
      if (Math.abs(det) > 1e-12) center = { x: (rx * m11 - m01 * ry) / det, y: (m00 * ry - m10 * rx) / det };
    }
  } else if (pts.length >= 3) {
    for (let i = 2; i < pts.length && !center; i++) center = circumcenter(pts[0]!, pts[1]!, pts[i]!);
  }
  if (!center) return null;
  const c = center;
  const radii = clusters(
    pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)),
    tol,
  );
  const rl = lattice(radii, tol);
  if (!rl || !(rl.start > tol)) return null;
  const TAU = 2 * Math.PI;
  const ang = (r: ItemRef) => {
    const a = Math.atan2(r.matrix[5] - c.y, r.matrix[4] - c.x);
    return a < 0 ? a + TAU : a;
  };
  const inner = refs.filter((r) => Math.abs(Math.hypot(r.matrix[4] - c.x, r.matrix[5] - c.y) - rl.start) <= tol);
  const angs = inner.map(ang).sort((a, b) => a - b);
  // 첫 항목: 돌지 않은 것(항목 회전), 아니면 가장 큰 빈 각 다음의 항목
  const plain = rotating ? inner.find((r) => isPlain(r.matrix)) : undefined;
  let a0: number;
  if (plain) a0 = ang(plain);
  else {
    let gi = angs.length - 1;
    let gap = angs[0]! + TAU - angs[angs.length - 1]!;
    for (let i = 0; i + 1 < angs.length; i++)
      if (angs[i + 1]! - angs[i]! > gap) {
        gap = angs[i + 1]! - angs[i]!;
        gi = i;
      }
    a0 = angs[(gi + 1) % angs.length]!;
  }
  const ccw = angs.map((a) => (((a - a0) % TAU) + TAU) % TAU).map((d) => (d > TAU - 1e-7 ? 0 : d));
  // 방향: 반시계로 잰 펼침과 시계로 잰 펼침 중 작은 쪽(같으면 반시계)
  const spanCcw = Math.max(...ccw);
  const spanCw = Math.max(...ccw.map((d) => (d > 1e-9 ? TAU - d : 0)));
  const cw = spanCw < spanCcw - 1e-7;
  const rel = ccw.map((d) => (cw ? (d > 1e-9 ? TAU - d : 0) : d)).sort((a, b) => a - b);
  let mag = TAU;
  for (let i = 1; i < rel.length; i++) if (rel[i]! - rel[i - 1]! > 1e-7) mag = Math.min(mag, rel[i]! - rel[i - 1]!);
  if (rel.some((d) => Math.abs(d / mag - Math.round(d / mag)) > 1e-5)) return null;
  const n = Math.round(rel[rel.length - 1]! / mag) + 1;
  const step = cw ? -mag : mag;
  const full = Math.abs(mag * n - TAU) < 1e-6;
  return {
    kind: 'polar',
    base: { x: 0, y: 0 },
    center: c,
    items: n,
    itemAngle: step,
    fillAngle: full ? Math.sign(step) * TAU : step * (n - 1),
    startAngle: a0,
    radius: rl.start,
    rotateItems: rotating,
    rows: rl.count,
    rowSpacing: rl.step || 1,
    rowElevation: 0,
    levels: 1,
    levelSpacing: 1,
  };
}

function inferPath(doc: CadDocument, ins: InsertEntity, arrayDef: BlockDef, refs: readonly ItemRef[], pathHandle: string): ArrayParams | null {
  const e = doc.entityIndex.get(pathHandle);
  const path0 = e ? entityPath(e) : null;
  if (!path0) return null;
  const W = insertAffine(arrayDef, ins);
  const L = pathLength(path0);
  if (!(L > 0)) return null;
  const tol = Math.max(1, L) * 1e-6;
  const at = refs.map((r) => {
    const wm = affMul(W, r.matrix);
    const p = { x: wm[4], y: wm[5] };
    const nr = pathNearest(path0, p);
    return { r, s: nr.s, len: pathLength(path0, 0, nr.s), d: nr.d, rot: rotOf(wm), tan: Math.atan2(pathTangent(path0, nr.s).y, pathTangent(path0, nr.s).x) };
  });
  const row0 = at.filter((x) => x.d <= tol * 10);
  if (!row0.length) return null;
  const lens = clusters(
    row0.map((x) => x.len),
    tol,
  );
  const aligned = row0.some((x) => Math.abs(x.rot) > 1e-7);
  // 방향: 정렬이면 시작 쪽 항목의 회전이 접선과 반대이면 거꾸로, 아니면 항목이 끝 쪽에서 시작하면 거꾸로
  let reverse = false;
  const startItem = row0.reduce((m, x) => (x.len < m.len ? x : m));
  if (aligned) reverse = Math.abs(Math.cos(startItem.rot - startItem.tan) + 1) < 1e-6;
  else reverse = lens[0]! > tol && Math.abs(lens[lens.length - 1]! - L) <= tol;
  const st = reverse ? lens.map((l) => L - l).sort((a, b) => a - b) : lens;
  const lat = lattice(st, tol);
  if (!lat) return null;
  const n = lat.count;
  const step = lat.step || L;
  const divide = path0.closed ? Math.abs(step * n - L) <= tol * n : Math.abs(step * (n - 1) - L) <= tol * n;
  const dists = clusters(
    at.map((x) => x.d),
    tol * 10,
  );
  const rl = lattice(dists, tol * 10);
  const p: PathParams = {
    kind: 'path',
    base: { x: 0, y: 0 },
    method: divide ? 'divide' : 'measure',
    items: n,
    spacing: step,
    align: aligned,
    zDir: true,
    reverse,
    path: pathHandle,
    rows: rl ? rl.count : 1,
    rowSpacing: rl?.step || 1,
    rowElevation: 0,
    levels: 1,
    levelSpacing: 1,
  };
  return p;
}

/** 짐작한 매개변수(못 짐작하면 null) */
export function inferParams(doc: CadDocument, ins: InsertEntity, arrayDef: BlockDef, refs: readonly ItemRef[], hint: { kind?: string | null; path?: string | null } = {}): ArrayParams | null {
  if (!refs.length) return null;
  if (hint.path) return inferPath(doc, ins, arrayDef, refs, hint.path);
  if (hint.kind === 'polar') return inferPolar(refs);
  if (hint.kind === 'rect') return inferRect(refs);
  return inferRect(refs) ?? inferPolar(refs);
}

