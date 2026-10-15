/**
 * 시험용 가짜 App의 다각형·울타리 선택: 객체 경로를 꺾은선으로 펴서 src/edit/geom/selpoly.ts에 넘긴다(화면 형상 대신).
 */
import type { CadDocument, Entity } from '../../src/core/model';
import { entityPath } from '../../src/edit/geom/path';
import { flattenPiece } from '../../src/edit/geom/curve';
import { boundsOf } from '../../src/edit/geom/query';
import { type SelGeom, fenceHits, polygonHits } from '../../src/edit/geom/selpoly';

type Pt = { x: number; y: number };

function geom(e: Entity): SelGeom {
  const p = entityPath(e);
  const segs: number[] = [];
  for (const pc of p?.pieces ?? []) {
    const f = flattenPiece(pc, 0.01);
    for (let i = 0; i + 1 < f.length; i++) segs.push(f[i]!.x, f[i]!.y, f[i + 1]!.x, f[i + 1]!.y);
  }
  return { segs };
}

export function fakePolySelect(doc: CadDocument, space: () => Entity[]) {
  const boxes = () =>
    space().flatMap((e) => {
      const b = boundsOf([e], doc);
      return b ? [{ handle: e.handle, minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }] : [];
    });
  const g = (h: string): SelGeom => {
    const e = doc.entityIndex.get(h);
    return e ? geom(e) : { segs: [] };
  };
  return {
    selectPolygon: (poly: Pt[], crossing: boolean) => polygonHits(boxes(), g, poly, crossing),
    selectFence: (pts: Pt[]) => fenceHits(boxes(), g, pts),
  };
}
