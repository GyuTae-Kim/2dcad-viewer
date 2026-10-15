/**
 * AutoCAD 연관 망(ACAD_ASSOCNETWORK): 객체 해석·쓰기(objects·cgroup), 판 맞추기(version), 망 찾기(network),
 * AutoCAD 구속 → 이 앱 구속(constraints), 되쓰기(writeback), 새 연관 배열의 망 만들기(array).
 * DWG 비트 배치는 src/io/dwg/assoccodec.ts.
 */
export { ASSOC_OBJECT_TYPES, parseAssocObject, tryParseAssocObject, writeAssocObject, type AssocObjectData } from './objects';
export { LAYOUTS, parseGroupRest, writeGroupRest, type CGroupData, type CNode } from './cgroup';
export { assocRawForVersion, assocVersionFor } from './version';
export { assocData, groupData, rootNetwork, blockNetwork } from './network';
export { importAcadConstraints, importGroup, type AcadImport, type AcadImportInfo, type GroupImport } from './constraints';
export { acadCommitOps, acadStoreOps, dimText } from './writeback';
export { acadArrayOps, ensureAssocClasses } from './array';
export { ASSOC_CLASS_DEFS } from './classes';
