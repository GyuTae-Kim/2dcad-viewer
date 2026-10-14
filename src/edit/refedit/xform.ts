/**
 * 참조 편집(REFEDIT)의 변환(UI 없음).
 * 블록 참조 하나 = 정의 좌표 → 부모 좌표의 평면 아핀(삽입점·회전·축척·기준점, OCS ±Z)과 Z 이동.
 * 내포된 참조는 바깥 것부터 곱한다. AutoCAD처럼 배열 삽입(MINSERT)과 X·Y 축척이 다른 참조는 거절하고,
 * 대칭(음의 균일 축척)은 받는다. 분해(EXPLODE)와 같은 행렬이라 작업 세트가 참조와 같은 자리에 놓인다.
 */
import type { BlockDef, Entity, InsertEntity } from '../../core/model';
import { type Affine, affInv, affMul, affRotate, affScale, affTranslate } from '../geom/math';
import { isPlanarExt, planProj, planZ } from '../geom/ocs';
import { transformEntity } from '../geom/transform';
import type { EditResult } from '../geom/types';

/** 정의 좌표 → 놓인 자리 */
export interface RefXf {
  m: Affine;
  /** Z 이동(평면도 편집이라 Z는 옮기기만 한다) */
  dz: number;
}

export const IDENTITY_XF: Readonly<RefXf> = Object.freeze({ m: [1, 0, 0, 1, 0, 0] as Affine, dz: 0 });

export const MSG_MINSERT = '배열로 삽입된 블록 참조(MINSERT)는 내부에서 편집할 수 없습니다.';
export const MSG_NONUNIFORM = 'X, Y 축척이 서로 다른 참조는 내부에서 편집할 수 없습니다.';
export const MSG_TILTED = 'Z축이 기울어진 참조는 이 2D 뷰어에서 내부 편집할 수 없습니다.';

/** 블록 참조의 변환. 편집할 수 없는 참조면 안내 문구 */
export function insertXf(def: Pick<BlockDef, 'basePoint'>, ins: InsertEntity): RefXf | string {
  if ((ins.columnCount || 1) > 1 || (ins.rowCount || 1) > 1) return MSG_MINSERT;
  const sx = ins.scale.x || 1;
  const sy = ins.scale.y || 1;
  const sz = ins.scale.z || 1;
  if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9 * Math.max(Math.abs(sx), Math.abs(sy))) return MSG_NONUNIFORM;
  if (!isPlanarExt(ins.extrusion)) return MSG_TILTED;
  const bp = def.basePoint ?? { x: 0, y: 0, z: 0 };
  const local = affMul(affTranslate(ins.insert.x, ins.insert.y), affMul(affRotate(ins.rotation), affMul(affScale(sx, sy), affTranslate(-bp.x, -bp.y))));
  const m = affMul(planProj(ins.extrusion, ins.insert.z), local);
  return { m, dz: planZ(ins.extrusion, ins.insert.z) - (bp.z || 0) * sz };
}

/** outer ∘ inner(inner를 먼저) */
export function composeXf(outer: RefXf, inner: RefXf): RefXf {
  return { m: affMul(outer.m, inner.m), dz: outer.dz + inner.dz };
}

export function invertXf(xf: RefXf): RefXf | null {
  const m = affInv(xf.m);
  return m ? { m, dz: -xf.dz } : null;
}

/** 내포된 참조들(바깥 것부터)의 변환 곱. 하나라도 편집할 수 없으면 그 안내 */
export function chainXf(chain: readonly { def: Pick<BlockDef, 'basePoint'>; insert: InsertEntity }[]): RefXf | string {
  let xf: RefXf = { m: [...IDENTITY_XF.m] as Affine, dz: 0 };
  for (const c of chain) {
    const x = insertXf(c.def, c.insert);
    if (typeof x === 'string') return x;
    xf = composeXf(xf, x);
  }
  return xf;
}

/**
 * 객체 하나를 참조 변환으로 옮긴다(분해와 같은 선택: 대칭이면 문자·해치 무늬도 정확히 대칭 — 되돌리면 원래대로).
 * 옮길 수 없는 객체(ACIS 등)는 null.
 */
export function xformEntity(e: Entity, xf: RefXf, doc: Parameters<typeof transformEntity>[2]): { entity: Entity; result: EditResult } | null {
  let r: EditResult;
  try {
    r = transformEntity(e, xf.m, doc, { mirrorText: true, exact: true, mirrorHatch: true, dz: xf.dz });
  } catch {
    return null;
  }
  const out = r.replace?.[0] ?? r.add?.[0];
  if (!out) return null;
  return { entity: out, result: r };
}

/** 균일 축척(넓이 비의 제곱근) */
export function xfScale(xf: RefXf): number {
  return Math.sqrt(Math.abs(xf.m[0] * xf.m[3] - xf.m[1] * xf.m[2]));
}
