/** 메인 스레드 ↔ 엔진 워커 메시지 */
import type { CadDocument } from '../core/model';
import type { DisplayList } from '../render/displaylist';
import type { LayerState, StyleSpec } from '../render/styles';

export type ToWorker =
  | { type: 'init'; fontBase: string }
  | { type: 'open'; id: number; name: string; data: ArrayBuffer }
  | { type: 'build'; id: number; docId: number; space: string };

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
