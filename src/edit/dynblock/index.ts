/** 동적 블록 참조 편집(UI 없음) */
export type { DynChange, DynGrip, DynProperty } from './api';
export { applyDynGrip, definitionName, dynGrips, dynProperties, dynResetOps, dynSetOps, isDynamicReference, previewDynGrip } from './api';
export type { DynAction, DynDefinition, DynEditResult, DynParam, NodeValue, ParamKind, RefValues, ValueSet } from './types';
export { FLIP_NOT, FLIP_YES, LOOKUP_CUSTOM, MSG_NOT_DYNAMIC, MSG_SAME, MSG_UNSUPPORTED } from './types';
export { findParam, isDynamicDefinition, readDefinition } from './definition';
export { definitionKeyOfInsert, readReference } from './reference';
export { DynEval, flipStateName, snapToValueSet, valueChoices } from './evaluate';
export { insertAffine } from './build';
