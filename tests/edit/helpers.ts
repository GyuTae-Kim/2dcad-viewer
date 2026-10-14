/** 편집 기하 테스트 도우미: 객체 만들기, 경로 비교, 그리기 검사 */
import { expect } from 'vitest';
import type { CadDocument, Entity, Vec2, Vec3 } from '../../src/core/model';
import { MODEL_SPACE } from '../../src/core/model';
import { buildSpace } from '../../src/render/build';
import { TextEngine } from '../../src/text/layout';
import { entityPath } from '../../src/edit/geom/path';
import { flattenPath, pathNearest, pathSize } from '../../src/edit/geom/curve';
import { type Affine, affApply } from '../../src/edit/geom/math';

export * from './make';

/** 경로 점 목록(평면도) */
export function pts(e: Entity, tol = 1e-3): Vec2[] {
  const p = entityPath(e);
  if (!p) throw new Error('경로 없음: ' + e.type);
  return flattenPath(p, tol).map((q) => ({ x: q.x, y: q.y }));
}

/** a의 모든 점이 b 경로 위에 있고 그 반대도 참인지(하우스도르프 거리) */
export function samePath(a: Entity, b: Entity, tol = 1e-6): void {
  const pa = entityPath(a)!;
  const pb = entityPath(b)!;
  expect(pa, 'a 경로').toBeTruthy();
  expect(pb, 'b 경로').toBeTruthy();
  const st = Math.min(pathSize(pa), pathSize(pb)) * 1e-3;
  let worst = 0;
  for (const q of flattenPath(pa, st)) worst = Math.max(worst, pathNearest(pb, q).d);
  for (const q of flattenPath(pb, st)) worst = Math.max(worst, pathNearest(pa, q).d);
  expect(worst).toBeLessThan(tol);
}

/** 변환된 객체 경로 = 원본 경로의 상 */
export function mappedPath(orig: Entity, out: Entity, m: Affine, tol = 1e-6): void {
  const po = entityPath(orig)!;
  const pr = entityPath(out)!;
  expect(pr).toBeTruthy();
  const st = pathSize(po) * 1e-3;
  let worst = 0;
  for (const q of flattenPath(po, st)) worst = Math.max(worst, pathNearest(pr, affApply(m, q)).d);
  expect(worst).toBeLessThan(tol);
}

export function near(a: Vec2 | Vec3, b: Vec2 | Vec3, tol = 1e-9): void {
  expect(Math.hypot(a.x - b.x, a.y - b.y), `(${a.x}, ${a.y}) ≈ (${b.x}, ${b.y})`).toBeLessThan(tol);
}

/** 모형 공간에 넣고 그린다: 그리기 실패 경고가 없어야 한다 */
export function renders(doc: CadDocument, list: Entity[], allowEmpty = false): void {
  const ms = doc.blocks.get(MODEL_SPACE)!;
  const saved = ms.entities;
  ms.entities = list.map((e, i) => ({ ...e, handle: e.handle || `R${i}` }));
  try {
    const s = buildSpace(doc, '*Model_Space', { text: new TextEngine(null), tolerance: 0.01 });
    const failed = s.warnings.find((w) => w.code === 'entity.failed');
    expect(failed, JSON.stringify(s.warnings)).toBeUndefined();
    if (!allowEmpty) expect(s.list.entities.length).toBeGreaterThan(0);
  } finally {
    ms.entities = saved;
  }
}

/** 하나뿐인 결과 객체 */
export function only(r: { add?: Entity[]; replace?: Entity[] }): Entity {
  const all = [...(r.replace ?? []), ...(r.add ?? [])];
  expect(all.length).toBe(1);
  return all[0]!;
}
