/**
 * 새 꺾기 반지름 치수(DIMJOGGED). 문자 점이 치수선 방향(중심 → 점)과 문자 위치를, 꺾기 점이 꺾기선 가운데를 정한다.
 * 꺾기 점은 어디를 찍든 꺾기선의 가운데로 맞춘다.
 */
import type { CadDocument, DimensionEntity, Vec3 } from '../../core/model';
import { type CreateDimOptions, createRadialDimension, generateDimensionGeometry } from '../dim';
import { jogPoints } from '../dim/jogged';
import { dimVars } from '../dim/vars';

export function createJoggedDimension(
  doc: CadDocument,
  center: Vec3,
  radius: number,
  textPoint: Vec3,
  overrideCenter: Vec3,
  jogPoint: Vec3,
  opt: CreateDimOptions & { jogAngle?: number } = {},
): DimensionEntity {
  const d = createRadialDimension(doc, center, radius, textPoint, opt);
  d.subtype = 'LARGE_RADIAL_DIMENSION';
  d.defPoint2 = { ...overrideCenter, z: center.z };
  d.textMid = { x: textPoint.x, y: textPoint.y, z: center.z };
  d.dimType = 4 | 32 | 128;
  const ja = opt.jogAngle ?? dimVars(doc, d).jogang;
  const m = jogPoints(center, d.defPoint4, overrideCenter, jogPoint, ja).mid;
  d.defPoint3 = { x: m.x, y: m.y, z: center.z };
  const g = generateDimensionGeometry(doc, d);
  d.measurement = g.measurement;
  d.textMid = g.textMid;
  return d;
}
