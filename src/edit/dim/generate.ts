/**
 * 치수(DIMENSION) 그림 만들기 본체: AutoCAD가 치수의 익명 블록(*D…)에 넣는 내용과 같은 기하를 만든다.
 * 블록 안 객체의 핸들은 ''이다. 블록 이름·핸들 붙이기와 DIMENSION.block 연결은 부르는 쪽이 한다.
 */
import type { CadDocument, DimensionEntity, Entity, Vec3 } from '../../core/model';
import { angular, arcLength } from './angular';
import { Out } from './builder';
import { applyDimExtras } from './extras';
import { jogged } from './jogged';
import { linear } from './linear';
import { ordinate } from './ordinate';
import { radial } from './radial';
import { type MeasureText, measureText } from './textbox';
import { dimVars } from './vars';

export interface DimensionGeometry {
  /** 블록 내용(블록 좌표 = 치수 OCS) */
  entities: Entity[];
  /** 문자 중간점(DIMENSION 11, OCS) */
  textMid: Vec3;
  /** 실제 측정값(DIMENSION 42). 각도는 라디안 */
  measurement: number;
  warnings: string[];
  /** 도면에 없어서 새로 만들어야 하는 AutoCAD 기본 화살촉 블록(이름 → 내용, 기준점 0,0) */
  arrowBlocks: { name: string; entities: Entity[] }[];
  /** POINT가 쓰는 정의점 도면층 이름(도면에 없으면 만들어야 한다) */
  defpointsLayer: string;
}

export interface GenerateOptions {
  /** 문자 상자 재기(기본: 내장 글꼴 표) */
  measureText?: MeasureText;
}

/** 치수 하나의 그림(익명 블록 내용)을 만든다. 엔티티 handle은 ''로 두고 부르는 쪽이 붙인다. */
export function generateDimensionGeometry(doc: CadDocument, dim: DimensionEntity, opt: GenerateOptions = {}): DimensionGeometry {
  const v = dimVars(doc, dim);
  const o = new Out(doc, dim, v, opt.measureText ?? measureText);
  if (dim.subtype === 'ARC_DIMENSION') arcLength(o);
  else if (dim.subtype === 'LARGE_RADIAL_DIMENSION') {
    // 재지정 중심·꺾기 점이 없는(모두 0) 기록은 예전처럼 반지름 치수로
    const z = (q: Vec3) => !q.x && !q.y && !q.z;
    if (z(dim.defPoint2) && z(dim.defPoint3)) {
      o.warn('dimension.jogged_radius_simplified');
      radial(o);
    } else jogged(o);
  } else
    switch (dim.dimType & 7) {
      case 0:
      case 1:
        linear(o);
        break;
      case 2:
      case 5:
        angular(o);
        break;
      case 3:
      case 4:
        radial(o);
        break;
      case 6:
        ordinate(o);
        break;
      default:
        o.warn('dimension.unknown_type');
    }
  // 꺾기선·끊기 기록(확장 데이터가 있을 때만)
  applyDimExtras(o);
  const tm = o.textMid ?? { x: dim.textMid.x, y: dim.textMid.y };
  return {
    entities: o.entities,
    textMid: { x: tm.x, y: tm.y, z: dim.textMid?.z ?? 0 },
    measurement: o.measurement,
    warnings: o.warnings,
    arrowBlocks: [...o.arrowBlocks].map(([name, entities]) => ({ name, entities })),
    defpointsLayer: o.defpointsLayer,
  };
}
