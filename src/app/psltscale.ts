/**
 * PSLTSCALE: 배치 뷰포트에서 모형의 선종류 무늬(점선 등)를 종이 단위로 맞춘다.
 * 모형에 무늬 선이 있을 때만, 뷰포트 축척별로 선종류 배율(1 / 축척)을 곱해 다시 그린 모형 장면을 워커에서 받아 쓴다.
 * 기본 모형 장면이 바뀌었거나 모형에 아직 다시 그리지 않은 편집이 있으면 변형 장면은 쓰지 않는다.
 */
import { MODEL_SPACE, tableKey } from '../core/model';
import type { App } from './app';
import type { LayerState } from '../render/styles';
import type { DocState } from './docstate';
import { SpaceScene, type ViewportXf, layoutViewports, viewportXf } from './scene';

/** 문서 하나가 둘 수 있는 변형 장면 수 */
const MAX_VARIANTS = 8;
/** 이보다 객체가 많은 모형은 변형을 만들지 않는다(메모리) */
const MAX_ENTITIES = 300_000;

export interface LtVariant {
  scene: SpaceScene;
  /** 이 변형을 만들 때의 기본 모형 장면 */
  base: SpaceScene;
  /** 스타일 표의 도면층 이름 순서 */
  names: string[];
}

export interface ViewportModel {
  scene: SpaceScene;
  layers: LayerState[];
  index: Map<string, number>;
}

/** 실패한 배율(같은 기본 장면에서 다시 청하지 않는다) */
const failed = new WeakMap<SpaceScene, Set<string>>();

/** 뷰포트의 선종류 배율. PSLTSCALE이 0이거나 축척이 1이면 1 */
export function ltFactor(st: DocState, vx: ViewportXf): number {
  const v = st.doc.header.get('$PSLTSCALE');
  if (typeof v === 'number' && v === 0) return 1;
  if (!(vx.k > 0) || !Number.isFinite(vx.k)) return 1;
  const f = 1 / vx.k;
  return Math.abs(f - 1) < 1e-9 ? 1 : f;
}

const keyOf = (f: number): string => f.toPrecision(8);

function modelClean(st: DocState): boolean {
  const ed = st.edits.get(MODEL_SPACE);
  return !ed || (!ed.hidden.size && !ed.live.size);
}

/** 기본 장면이 바뀐 변형을 버린다 */
function dropStale(app: App, st: DocState, base: SpaceScene | undefined): void {
  for (const [k, v] of st.ltVariants) {
    if (v.base === base) continue;
    v.scene.dispose(app.view.renderer);
    st.ltVariants.delete(k);
  }
}

function wanted(st: DocState, base: SpaceScene | undefined): base is SpaceScene {
  return !!base && !!base.source.dashed && base.entities.length <= MAX_ENTITIES && modelClean(st);
}

function baseModel(st: DocState, base: SpaceScene): ViewportModel {
  return { scene: base, layers: st.sceneLayers(MODEL_SPACE), index: st.sceneLayerIndex(MODEL_SPACE) };
}

/**
 * 뷰포트에서 쓸 모형 장면. 알맞은 변형이 없으면(앱이 주어졌을 때) 만들기를 시작하고, 그동안은 기본 장면을 준다.
 */
export function viewportModel(app: App | null, st: DocState, vx: ViewportXf): ViewportModel | null {
  const base = st.scenes.get(MODEL_SPACE);
  if (!base) return null;
  const f = ltFactor(st, vx);
  if (f === 1 || !wanted(st, base)) return baseModel(st, base);
  const v = st.ltVariants.get(keyOf(f));
  if (v && v.base === base) {
    return { scene: v.scene, layers: v.names.map((n) => st.layers.get(n)!), index: new Map(v.names.map((n, i) => [n, i])) };
  }
  if (app) scheduleVariants(app, st);
  return baseModel(st, base);
}

/** 문서별 변형 요청 타이머(확대·이동 중에는 기다렸다가 멈추면 청한다) */
const timers = new WeakMap<DocState, number>();

function scheduleVariants(app: App, st: DocState): void {
  clearTimeout(timers.get(st));
  timers.set(
    st,
    window.setTimeout(() => {
      timers.delete(st);
      if (!app.docs.includes(st)) return;
      // 지금 어느 배치의 뷰포트도 쓰지 않는 배율은 버린다
      const live = new Set<string>();
      for (const lay of st.doc.layouts) for (const vp of layoutViewports(st.doc, lay)) live.add(keyOf(ltFactor(st, viewportXf(st.doc, vp))));
      for (const [k, v] of st.ltVariants)
        if (!live.has(k)) {
          v.scene.dispose(app.view.renderer);
          st.ltVariants.delete(k);
        }
      const lay = st.layoutFor(st.displaySpace);
      if (!lay) return;
      for (const vp of layoutViewports(st.doc, lay)) {
        const f = ltFactor(st, viewportXf(st.doc, vp));
        if (f !== 1) void requestVariant(app, st, f);
      }
    }, 250),
  );
}

/** 배율 f의 변형 장면을 워커에서 그려 온다 */
export function requestVariant(app: App, st: DocState, f: number): Promise<SpaceScene | null> {
  const base = st.scenes.get(MODEL_SPACE);
  if (!wanted(st, base)) return Promise.resolve(null);
  const k = keyOf(f);
  const have = st.ltVariants.get(k);
  if (have && have.base === base) return Promise.resolve(have.scene);
  if (failed.get(base)?.has(k)) return Promise.resolve(null);
  const pending = st.ltPending.get(k);
  if (pending) return pending;
  dropStale(app, st, base);
  if (st.ltVariants.size >= MAX_VARIANTS) return Promise.resolve(null);
  const p = app.engine
    .build(st.docId, MODEL_SPACE, f)
    .then((msg) => {
      if (!app.docs.includes(st) || st.scenes.get(MODEL_SPACE) !== base || !modelClean(st)) return null;
      st.ltVariants.get(k)?.scene.dispose(app.view.renderer);
      const scene = new SpaceScene(app.view.renderer, msg, MODEL_SPACE);
      const names: string[] = [];
      for (const l of msg.layers) {
        const n = tableKey(l.name);
        names.push(n);
        if (!st.layers.has(n)) st.layers.set(n, { ...l });
      }
      st.ltVariants.set(k, { scene, base, names });
      app.view.requestRender();
      return scene;
    })
    .catch(() => {
      let s = failed.get(base);
      if (!s) failed.set(base, (s = new Set()));
      s.add(k);
      return null;
    })
    .finally(() => st.ltPending.delete(k));
  st.ltPending.set(k, p);
  return p;
}

/** 배치의 모든 뷰포트에 쓸 변형 장면을 마련한다(출력·내보내기 전에) */
export async function ensureLayoutVariants(app: App, st: DocState, space: string): Promise<void> {
  const lay = st.layoutFor(tableKey(space));
  if (!lay || !wanted(st, st.scenes.get(MODEL_SPACE))) return;
  const fs = new Set<number>();
  for (const vp of layoutViewports(st.doc, lay)) {
    const f = ltFactor(st, viewportXf(st.doc, vp));
    if (f !== 1) fs.add(f);
  }
  await Promise.all([...fs].map((f) => requestVariant(app, st, f)));
}
