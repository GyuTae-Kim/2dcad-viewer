/** 열린 도면 하나의 상태(메인 스레드) */
import type { LtVariant } from './psltscale';
import type { CadDocument, Layout } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { type UnitSettings, unitSettings } from '../core/units';
import type { LayerState } from '../render/styles';
import type { SceneMessage } from '../worker/protocol';
import { type OverlayScene, SpaceScene } from './scene';
import { EditSession } from '../edit/session';
import type { GLRenderer } from '../render/webgl';

export interface Camera {
  cx: number;
  cy: number;
  /** 장치 픽셀 / 도면 단위 */
  scale: number;
}

/** 공간 하나의 편집 상태(기본 장면을 다시 만들기 전까지) */
export interface SpaceEdits {
  /** 기본 장면에서 숨긴 객체 */
  hidden: Set<string>;
  /** 덧그림에 있는 객체 → 마지막으로 바뀐 세대 */
  live: Map<string, number>;
  overlay: OverlayScene | null;
  /** 기본 장면을 만든 세대 */
  baseGen: number;
}

export class DocState {
  /** 편집 세션(앱이 문서를 열 때 만든다) */
  session!: EditSession;
  /** 편집 세대(트랜잭션마다 1씩) */
  gen = 0;
  readonly edits = new Map<string, SpaceEdits>();
  /** 저장할 때 쓸 파일 이름(바뀔 수 있다) */
  saveName: string;
  /** 도면층 이름(대문자) → 상태(모든 공간이 함께 쓴다) */
  readonly layers = new Map<string, LayerState>();
  readonly scenes = new Map<string, SpaceScene>();
  /** PSLTSCALE: 뷰포트 축척별 모형 장면(선종류 배율 → 장면). 편집하면 버린다 */
  readonly ltVariants = new Map<string, LtVariant>();
  readonly ltPending = new Map<string, Promise<SpaceScene | null>>();
  /** 공간별 장면의 도면층 이름 목록(스타일 표의 도면층 번호 순) */
  private readonly sceneLayerNames = new Map<string, string[]>();
  readonly cameras = new Map<string, Camera>();
  readonly prevCameras = new Map<string, Camera[]>();
  space: string = MODEL_SPACE;
  readonly selection = new Set<string>();
  units: UnitSettings;
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
    this.saveName = name;
  }

  spaceEdits(space: string): SpaceEdits {
    const key = tableKey(space);
    let e = this.edits.get(key);
    if (!e) {
      e = { hidden: new Set(), live: new Map(), overlay: null, baseGen: this.gen };
      this.edits.set(key, e);
    }
    return e;
  }

  get layouts(): Layout[] {
    return this.doc.layouts;
  }

  /** 블록 편집기로 연 블록(그 블록을 공간처럼 보고 고친다) */
  blockEdit: { name: string; key: string; back: string; depth: number } | null = null;

  /** 모형처럼 그리는 공간(모형 공간, 블록 편집기) */
  get isModel(): boolean {
    return this.space === MODEL_SPACE || this.blockEdit !== null;
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

  /** 선종류 배율 장면을 버린다 */
  dropLtVariants(renderer: GLRenderer): void {
    for (const v of this.ltVariants.values()) v.scene.dispose(renderer);
    this.ltVariants.clear();
    this.ltPending.clear();
  }

  dispose(renderer: GLRenderer): void {
    this.dropLtVariants(renderer);
    for (const s of this.scenes.values()) s.dispose(renderer);
    for (const e of this.edits.values()) e.overlay?.dispose(renderer);
    this.scenes.clear();
    this.edits.clear();
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
      return '도형 파일(SHX)이 없어 쉐이프 객체를 그리지 못했습니다. SHXFONTS로 도형 파일을 불러올 수 있습니다.';
    case 'dimension.generated':
      return '치수 블록이 없는 치수는 정의점으로 간단히 그렸습니다.';
    case 'font.unavailable':
      return '글꼴을 받지 못해 일부 문자를 대체 글꼴로 그렸습니다.';
    default:
      return code;
  }
}
