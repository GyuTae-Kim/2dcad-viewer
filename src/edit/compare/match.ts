/**
 * 두 도면의 모형 공간 객체 맞추기(도면 비교).
 *
 * 1. 핸들: 두 파일이 같은 계보(한 도면을 고쳐 저장한 것)면 같은 핸들끼리 먼저 본다. 서명이 같으면 차이 없음.
 * 2. 허용 오차 격자: 남은 객체는 서명 열쇠 → 대표점의 격자 칸(칸 크기 ≥ 허용 오차)으로 나누고, 이웃 칸(3×3)만
 *    확인한다. 그래서 O(n²)가 아니다. 같은 객체를 지우고 다시 그린 것도 여기서 맞는다.
 * 3. 남은 것: 현재 도면에서만 / 비교 도면에서만. 같은 계보이고 같은 핸들이 양쪽에 남았으면 "바뀐 쌍".
 *
 * 블록 참조는 블록 정의의 내용(같은 방법으로 맞춘 객체 묶음과 기준점)까지 같아야 같다. 익명 블록(*U 등)은
 * 이름이 파일마다 달라도 내용이 같으면 같다.
 */
import type { CadDocument, Entity } from '../../core/model';
import { MODEL_SPACE, tableKey } from '../../core/model';
import { type CompareOptions, type Signature, entitySignature, isCompared, near, nearSignature } from './signature';

export interface CompareResult {
  /** 현재 도면에만 있는 객체 핸들(모형 공간 최상위) */
  onlyCurrent: string[];
  /** 비교 도면에만 있는 객체 핸들 */
  onlyCompare: string[];
  /** 차이 없는 객체 쌍 수 */
  common: number;
  /** 필터(문자·해치)로 비교하지 않은 객체 수 */
  filtered: { current: number; compare: number };
  /** 같은 계보에서 같은 핸들이 바뀐 쌍 [현재, 비교] */
  modified: [string, string][];
  /** 같은 계보(핸들을 공유)로 보았는지 */
  sameLineage: boolean;
  /** 핸들로 맞춘 수 */
  byHandle: number;
  /** 걸린 시간(ms) */
  ms: number;
}

interface MatchOut {
  /** a[i]와 짝인 b 번호(-1 = 짝 없음) */
  pairA: Int32Array;
  pairB: Int32Array;
  byHandle: number;
}

/** 서명을 문서별로 기억한다(블록 안 객체는 여러 번 쓰인다) */
class Side {
  readonly sigs = new WeakMap<Entity, Signature>();
  constructor(readonly doc: CadDocument) {}
}

export class DrawingComparer {
  readonly tol: number;
  private readonly a: Side;
  private readonly b: Side;
  private readonly blockMemo = new Map<string, boolean>();
  private readonly busy = new Set<string>();

  constructor(
    current: CadDocument,
    compare: CadDocument,
    readonly opt: CompareOptions,
  ) {
    this.tol = 10 ** -Math.max(0, Math.min(14, Math.round(opt.tolerance)));
    this.a = new Side(current);
    this.b = new Side(compare);
  }

  private sig(side: Side, e: Entity): Signature {
    let s = side.sigs.get(e);
    if (!s) {
      s = entitySignature(e, this.opt, side.doc, this.tol);
      side.sigs.set(e, s);
    }
    return s;
  }

  /** 열쇠가 같은 두 서명이 같은지(블록 내용 포함) */
  private same(x: Signature, y: Signature): boolean {
    if (!nearSignature(x, y, this.tol)) return false;
    if (x.block !== null || y.block !== null) return this.blockEqual(x.block ?? '', y.block ?? '');
    return true;
  }

  /** 현재 도면의 블록 nameA와 비교 도면의 블록 nameB의 정의가 같은지 */
  blockEqual(nameA: string, nameB: string): boolean {
    const k = `${nameA}\u0000${nameB}`;
    const memo = this.blockMemo.get(k);
    if (memo !== undefined) return memo;
    // 자기 참조 블록: 비교 중인 쌍은 같다고 본다
    if (this.busy.has(k)) return true;
    this.busy.add(k);
    let eq: boolean;
    try {
      eq = this.blockEqualNow(nameA, nameB);
    } finally {
      this.busy.delete(k);
    }
    this.blockMemo.set(k, eq);
    return eq;
  }

  private blockEqualNow(nameA: string, nameB: string): boolean {
    const da = this.a.doc.blocks.get(tableKey(nameA));
    const db = this.b.doc.blocks.get(tableKey(nameB));
    if (!da || !db) return !da && !db;
    // 외부 참조는 경로로
    if (da.flags & 4 || db.flags & 4) return !!(da.flags & 4) === !!(db.flags & 4) && (da.xrefPath ?? '').toUpperCase() === (db.xrefPath ?? '').toUpperCase();
    const t = this.tol;
    if (!near(da.basePoint.x, db.basePoint.x, t) || !near(da.basePoint.y, db.basePoint.y, t) || !near(da.basePoint.z ?? 0, db.basePoint.z ?? 0, t)) return false;
    const la = da.entities.filter((e) => isCompared(e, this.opt));
    const lb = db.entities.filter((e) => isCompared(e, this.opt));
    if (la.length !== lb.length) return false;
    const m = this.match(la, lb, true);
    for (let i = 0; i < m.pairA.length; i++) if (m.pairA[i]! < 0) return false;
    return true;
  }

  /** 두 객체 목록을 맞춘다 */
  match(la: readonly Entity[], lb: readonly Entity[], useHandles: boolean): MatchOut {
    const nA = la.length;
    const nB = lb.length;
    const sa = la.map((e) => this.sig(this.a, e));
    const sb = lb.map((e) => this.sig(this.b, e));
    const pairA = new Int32Array(nA).fill(-1);
    const pairB = new Int32Array(nB).fill(-1);
    let byHandle = 0;
    if (useHandles && nA && nB) {
      const idx = new Map<string, number>();
      for (let j = 0; j < nB; j++) {
        const h = lb[j]!.handle;
        if (h) idx.set(h, j);
      }
      for (let i = 0; i < nA; i++) {
        const h = la[i]!.handle;
        if (!h) continue;
        const j = idx.get(h);
        if (j === undefined || pairB[j]! >= 0) continue;
        const x = sa[i]!;
        const y = sb[j]!;
        if (x.key === y.key && this.same(x, y)) {
          pairA[i] = j;
          pairB[j] = i;
          byHandle++;
        }
      }
    }
    if (byHandle < Math.min(nA, nB)) {
      // 허용 오차 격자(칸 크기 ≥ 허용 오차, 좌표가 커도 칸 번호가 정밀도를 잃지 않게)
      let scale = 0;
      for (const s of sa) scale = Math.max(scale, Math.abs(s.ax) || 0, Math.abs(s.ay) || 0);
      for (const s of sb) scale = Math.max(scale, Math.abs(s.ax) || 0, Math.abs(s.ay) || 0);
      if (!Number.isFinite(scale)) scale = 1e300;
      const cell = Math.max(this.tol * 1.000001, scale * 2 ** -40, 1e-300);
      const cellOf = (v: number) => (Number.isFinite(v) ? Math.floor(v / cell) : 0);
      const grid = new Map<string, Map<string, number[]>>();
      for (let j = 0; j < nB; j++) {
        if (pairB[j]! >= 0) continue;
        const s = sb[j]!;
        let g = grid.get(s.key);
        if (!g) {
          g = new Map();
          grid.set(s.key, g);
        }
        const ck = `${cellOf(s.ax)},${cellOf(s.ay)}`;
        const l = g.get(ck);
        if (l) l.push(j);
        else g.set(ck, [j]);
      }
      for (let i = 0; i < nA; i++) {
        if (pairA[i]! >= 0) continue;
        const s = sa[i]!;
        const g = grid.get(s.key);
        if (!g) continue;
        const cx = cellOf(s.ax);
        const cy = cellOf(s.ay);
        let found = -1;
        for (let dx = -1; dx <= 1 && found < 0; dx++)
          for (let dy = -1; dy <= 1 && found < 0; dy++) {
            const l = g.get(`${cx + dx},${cy + dy}`);
            if (!l) continue;
            // 이미 짝이 생긴 항목은 지우면서 훑는다(같은 객체가 많이 겹쳐도 다시 보지 않게)
            for (let q = 0; q < l.length; q++) {
              const j = l[q]!;
              if (pairB[j]! >= 0) {
                l[q] = l[l.length - 1]!;
                l.pop();
                q--;
                continue;
              }
              if (this.same(s, sb[j]!)) {
                found = j;
                l[q] = l[l.length - 1]!;
                l.pop();
                break;
              }
            }
          }
        if (found >= 0) {
          pairA[i] = found;
          pairB[found] = i;
        }
      }
    }
    return { pairA, pairB, byHandle };
  }
}

/** 공간의 최상위 객체(모형 공간이 기본) */
export function spaceEntities(doc: CadDocument, space = MODEL_SPACE): Entity[] {
  return doc.blocks.get(tableKey(space))?.entities ?? [];
}

function fingerprint(doc: CadDocument): string {
  const v = doc.header.get('$FINGERPRINTGUID');
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

/**
 * 두 도면의 모형 공간 비교.
 * current는 지금 도면, compare는 비교할 도면. 두 문서 모두 바꾸지 않는다.
 */
export function compareDrawings(current: CadDocument, compare: CadDocument, opt: CompareOptions, space = MODEL_SPACE): CompareResult {
  const t0 = performance.now();
  const c = new DrawingComparer(current, compare, opt);
  const allA = spaceEntities(current, space);
  const allB = spaceEntities(compare, space);
  const la = allA.filter((e) => e.type !== 'VIEWPORT' && isCompared(e, opt));
  const lb = allB.filter((e) => e.type !== 'VIEWPORT' && isCompared(e, opt));
  const m = c.match(la, lb, true);
  const fa = fingerprint(current);
  const sameLineage = (!!fa && fa === fingerprint(compare)) || (m.byHandle > 0 && m.byHandle >= 0.5 * Math.min(la.length, lb.length));
  const onlyCurrent: string[] = [];
  const onlyCompare: string[] = [];
  let common = 0;
  for (let i = 0; i < la.length; i++) {
    if (m.pairA[i]! >= 0) common++;
    else onlyCurrent.push(la[i]!.handle);
  }
  const leftB = new Map<string, Entity>();
  for (let j = 0; j < lb.length; j++)
    if (m.pairB[j]! < 0) {
      onlyCompare.push(lb[j]!.handle);
      if (lb[j]!.handle) leftB.set(lb[j]!.handle, lb[j]!);
    }
  const modified: [string, string][] = [];
  if (sameLineage)
    for (let i = 0; i < la.length; i++) {
      if (m.pairA[i]! >= 0) continue;
      const e = la[i]!;
      const o = e.handle ? leftB.get(e.handle) : undefined;
      if (o && o.type === e.type) modified.push([e.handle, o.handle]);
    }
  return {
    onlyCurrent,
    onlyCompare,
    common,
    filtered: { current: allA.length - la.length, compare: allB.length - lb.length },
    modified,
    sameLineage,
    byHandle: m.byHandle,
    ms: performance.now() - t0,
  };
}
