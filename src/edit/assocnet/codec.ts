/**
 * 파일 읽기·쓰기(src/io)가 쓰는 연관 망 도우미의 모음: 객체 종류, 판 맞추기, 클래스 정의.
 * (해석·쓰기 자체는 objects.ts·cgroup.ts, DWG 비트 배치는 src/io/dwg/assoccodec.ts)
 */
export { ASSOC_OBJECT_TYPES } from './objects';
export { assocDxfRaw, assocDxfWritable, assocRawForVersion, assocVersionFor } from './version';
export { ASSOC_APP, ASSOC_CLASS_DEFS, ASSOC_PROXY_FLAGS } from './classes';
