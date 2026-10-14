/** 열린 도면 하나의 상태(메인 스레드) */
import type { CadDocument, Layout } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { type UnitSettings, unitSettings } from '../core/units';
import type { LayerState } from '../render/styles';
import type { SceneMessage } from '../worker/protocol';
import { SpaceScene } from './scene';
import type { GLRenderer } from '../render/webgl';

export interface Camera {
  cx: number;
  cy: number;
  /** 장치 픽셀 / 도면 단위 */
  scale: number;
}

export class DocState {
  /** 도면층 이름(대문자) → 상태(모든 공간이 함께 쓴다) */
  readonly layers = new Map<string, LayerState>();
  readonly scenes = new Map<string, SpaceScene>();
  /** 공간별 장면의 도면층 이름 목록(스타일 표의 도면층 번호 순) */
  private readonly sceneLayerNames = new Map<string, string[]>();
  readonly cameras = new Map<string, Camera>();
  readonly prevCameras = new Map<string, Camera[]>();
  space: string = MODEL_SPACE;
  readonly selection = new Set<string>();
  readonly units: UnitSettings;
  readonly warnings: { code: string; message: string; count?: number }[] = [];
  layerVersion = 0;
  readonly buildPending = new Map<string, Promise<void>>();

  constructor(
    readonly docId: number,
    readonly doc: CadDocument,
    readonly name: string,
    readonly size: number,
    readonly readMs: number,
  ) {
    this.units = unitSettings(doc);
    for (const w of doc.warnings) this.warnings.push(w);
  }

  get layouts(): Layout[] {
    return this.doc.layouts;
  }

  get isModel(): boolean {
    return this.space === MODEL_SPACE;
  }

  layoutFor(space: string): Layout | undefined {
    return this.doc.layouts.find((l) => tableKey(l.blockName) === space);
  }

  addScene(renderer: GLRenderer, msg: SceneMessage, space: string): SpaceScene {
    const key = tableKey(space);
    const old = this.scenes.get(key);
    if (old) old.dispose(renderer);
    const s = new SpaceScene(renderer, msg, key);
    this.scenes.set(key, s);
    const names: string[] = [];
    for (const l of msg.layers) {
      const k = tableKey(l.name);
      names.push(k);
      if (!this.layers.has(k)) this.layers.set(k, { ...l });
    }
    this.sceneLayerNames.set(key, names);
    for (const w of msg.warnings) this.warnings.push({ code: w.code, message: warningText(w.code), count: w.count });
    return s;
  }

  /** 장면의 스타일 표가 쓰는 도면층 상태 배열 */
  sceneLayers(space: string): LayerState[] {
    const names = this.sceneLayerNames.get(tableKey(space)) ?? [];
    return names.map((n) => this.layers.get(n)!);
  }

  /** 장면의 도면층 이름 → 번호 */
  sceneLayerIndex(space: string): Map<string, number> {
    const names = this.sceneLayerNames.get(tableKey(space)) ?? [];
    return new Map(names.map((n, i) => [n, i]));
  }

  touchLayers(): void {
    this.layerVersion++;
    for (const s of this.scenes.values()) s.invalidateStyles();
  }

  dispose(renderer: GLRenderer): void {
    for (const s of this.scenes.values()) s.dispose(renderer);
    this.scenes.clear();
  }
}

export function warningText(code: string): string {
  switch (code) {
    case 'entity.unsupported':
      return '표시하지 않는 객체 종류가 있습니다.';
    case 'entity.not_drawn':
      return '3D 솔리드·영역·사용자 객체는 2D 뷰어에서 그리지 않습니다.';
    case 'entity.failed':
      return '일부 객체를 그리지 못했습니다.';
    case 'block.missing':
      return '정의가 없는 블록 참조가 있습니다.';
    case 'block.recursive':
      return '자기 자신을 참조하거나 너무 깊은 블록을 건너뛰었습니다.';
    case 'xref.not_loaded':
      return '외부 참조 파일은 열지 않았습니다.';
    case 'hatch.pattern_truncated':
      return '무늬가 너무 촘촘한 해치는 무늬를 생략했습니다.';
    case 'shape.unsupported':
      return '쉐이프(SHX) 객체는 아직 그리지 않습니다.';
    case 'dimension.generated':
      return '치수 블록이 없는 치수는 정의점으로 간단히 그렸습니다.';
    case 'font.unavailable':
      return '글꼴을 받지 못해 일부 문자를 대체 글꼴로 그렸습니다.';
    default:
      return code;
  }
}
