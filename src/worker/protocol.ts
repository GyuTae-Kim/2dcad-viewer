/** 메인 스레드 ↔ 엔진 워커 메시지 */
import type { CadDocument } from '../core/model';
import type { DisplayList } from '../render/displaylist';
import type { LayerState, StyleSpec } from '../render/styles';
import type { EditOp } from '../edit/session';

export type ToWorker =
  | { type: 'init'; fontBase: string }
  | { type: 'open'; id: number; name: string; data: ArrayBuffer }
  | { type: 'build'; id: number; docId: number; space: string }
  /** 메인에서 적용한 편집을 워커 문서에도 적용한다(응답 없음) */
  | { type: 'edit'; docId: number; ops: EditOp[] }
  | { type: 'close'; docId: number }
  /** 메인에서 만든 문서(새 도면)를 받아 장면을 만든다 */
  | { type: 'adopt'; id: number; name: string; doc: CadDocument }
  /** 사용자가 불러온 SHX 글꼴(문자 그리기에 쓴다). clear면 먼저 모두 지운다 */
  | { type: 'shx'; files: { name: string; data: ArrayBuffer }[]; clear?: boolean };

export interface SceneMessage {
  list: DisplayList;
  styles: StyleSpec[];
  layers: LayerState[];
  layerIndex: [string, number][];
  warnings: { code: string; count: number }[];
  ms: number;
}

export type FromWorker =
  | { type: 'progress'; id: number; stage: 'read' | 'fonts' | 'build'; fraction: number }
  | { type: 'document'; id: number; docId: number; doc: CadDocument; readMs: number }
  | { type: 'scene'; id: number; docId: number; space: string; scene: SceneMessage }
  | { type: 'error'; id: number; code: string; message: string };
