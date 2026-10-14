/** 파라메트릭 구속(기하 구속·치수 구속): 자료 형식, 저장, 풀이, 자동 구속, 표시 도형 */
export * from './types';
export { STORE_KEY, cloneStore, decodeStore, encodeStore, foreignConstraintInfo, foreignConstraintNotice, hasConstraints, readStore, storeObject, storeOps, type ForeignConstraintInfo } from './store';
export { MSG_EDIT, MSG_OVER, MSG_UNSOLVED, addConstraints, buildSystem, constraintsOf, dimValueProblem, evaluateStore, followEdit, isSatisfied, linkedComponent, measureConstraint, pruneStore, removeConstraints, resolveParams, type SolveOutcome } from './system';
export { AUTO_DEFAULTS, autoConstrain, type AutoSettings } from './auto';
export { MakeError, prepareDim, prepareGeo } from './make';
export { allParamNames, evaluateParams, isNumberExpr, nextDimName, nextParamName, numberText, paramNameProblem, parseParamExpr, replaceName, usesName } from './params';
export { constraintDisplay, constraintGlyphs, dimLabel, glyphAt, setConstraintDisplay, type ConstraintGlyphs, type GlyphBar, type GlyphText } from './glyphs';
export { unsupportedReason } from './prims';
