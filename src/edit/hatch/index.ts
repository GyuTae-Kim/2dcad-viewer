/**
 * 해치 만들기 부품: 무늬 목록, 경계 찾기, HATCH 객체 만들기, 연관 해치 다시 만들기.
 */
export { PATTERNS, findPattern } from './patterns';
export type { PatternDef, PatternLineDef } from './patterns';
export { patternLines, userPatternLines, patternUnit } from './lines';
export type { PatternLineOptions } from './lines';
export { detectBoundary, boundaryFromEntities, rebuildAssociative, interiorPoint, pathsFillPoint } from './boundary';
export type { DetectOptions, DetectResult, IslandStyle } from './boundary';
export {
  createHatch,
  estimatePatternLines,
  hatchSources,
  boundaryEntitiesOf,
  reactorLinks,
  reactorUnlinks,
  associatedHatches,
  dissociate,
} from './create';
export type { CreateHatchOptions } from './create';
