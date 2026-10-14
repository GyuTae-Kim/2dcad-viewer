/**
 * 치수 생성기 공개 API.
 * - generateDimensionGeometry: 치수 하나의 익명 블록(*D…) 내용
 * - create…Dimension: 새 DIMENSION 객체
 * - moveDimensionText: 문자 위치 옮기기(사용자 위치 비트 128)
 */
export { generateDimensionGeometry, type DimensionGeometry, type GenerateOptions } from './generate';
export {
  createAlignedDimension,
  createAngular2LineDimension,
  createAngularDimension,
  createArcLengthDimension,
  createDiameterDimension,
  createLinearDimension,
  createOrdinateDimension,
  createRadialDimension,
  moveDimensionText,
  nextDimBlockName,
  type CreateDimOptions,
} from './create';
export { builtinArrowBlock } from './arrows';
export { dimensionText } from './format';
export { measureText, type MeasureText, type TextBox } from './textbox';
export { dimVars, rawDimVars } from './vars';
