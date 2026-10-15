/**
 * STEP(ISO 10303-21, AP203·AP214·AP242) 읽기와 삼각화. DOM·WebGL 없이 워커에서 돌 수 있다.
 */
export { stepToScene, type StepMeta, type StepOptions, type StepProductNode } from './scene';
export { DERIVED, StepBinary, StepEnum, StepFile, StepRef, StepTyped, decodeStepString, type StepEntity, type StepHeader, type StepValue } from './part21';
export { watertightness, meshArea, meshVolume, type WatertightReport } from './analysis';
