/**
 * 뷰포트 최대화: VPMAX·VPMIN, 최대화한 채 이전/다음 뷰포트(VPMAXPREV·VPMAXNEXT).
 *
 * - 배치: 활성 뷰포트(종이 공간이면 하나뿐인 뷰포트 또는 고른 뷰포트)의 모형 공간을 도면 영역 전체로 보인다.
 *   도면 영역 둘레에 빨간 굵은 테두리. 그 뷰포트가 보이던 모형 범위로 시작하고, 최대화한 채 확대·이동·편집할 수 있다.
 *   최대화 중의 확대·이동은 뷰포트의 뷰·축척을 바꾸지 않는다 — VPMIN이면 원래 뷰포트 뷰로 배치에 돌아간다
 *   (MSPACE였으면 그 뷰포트의 모형 공간, 아니면 종이 공간). 뷰포트에서 동결한 도면층(VPLAYER)은 최대화 중에도 숨긴다.
 * - 모형 타일 뷰포트(VPORTS): 현재 타일을 도면 영역 전체로 / 원래 타일 구성으로(뷰는 그대로).
 *
 * 구현: 모형 탭 그리기를 빌린다(view.ts·app.ts는 고치지 않는다). 모형 탭의 카메라·타일 구성은 최대화 동안 따로 두었다가
 * 되돌린다. 최대화 중에 배치 탭을 누르면 최대화가 풀린다(모형 탭 카메라를 되돌린다).
 */
import type { App, CommandContext } from './app';
import type { Camera, DocState, TileSet } from './docstate';
import type { ViewportEntity } from '../core/model';
import { MODEL_SPACE, tableKey } from '../core/model';
import { layoutViewports } from './scene';
import { isDark } from './view';
import { insideViewport, vpModelWindow } from '../edit/viewtools/vpsync';

interface MaxState {
  st: DocState;
  kind: 'layout' | 'tiles';
  /** 배치 공간 키(배치) */
  layout: string;
  /** 최대화한 뷰포트 핸들(배치) */
  vp: string;
  /** 최대화 전에 MSPACE였는지(배치) */
  wasMs: boolean;
  /** 모형 탭의 카메라·이전 카메라(배치 최대화가 빌린다) */
  modelCam: Camera | undefined;
  modelPrev: Camera[] | undefined;
  /** 타일 구성 */
  tiles: TileSet | null;
  /** 뷰포트 동결 도면층(대문자) */
  frozen: Set<string>;
}

const maxed = new Map<DocState, MaxState>();
let overrideInstalled = false;

/** 그 도면의 최대화 상태(없으면 null): 상태 막대가 최대화·복원 단추를 바꿀 때 쓴다 */
export function maximized(st: DocState | null): { kind: 'layout' | 'tiles'; layout: string; vp: string } | null {
  const m = st ? maxed.get(st) : undefined;
  return m && stillShown(m) ? { kind: m.kind, layout: m.layout, vp: m.vp } : null;
}

/** 상태 막대가 보일 문구(최대화 중이 아니면 null) */
export function maximizedLabel(app: App): string | null {
  const m = app.active ? maxed.get(app.active) : null;
  if (!m) return null;
  if (m.kind === 'tiles') return '최대화된 타일 뷰포트';
  const vp = m.st.doc.entityIndex.get(m.vp) as ViewportEntity | undefined;
  return vp ? `최대화된 뷰포트 ${vp.id}` : '최대화된 뷰포트';
}

/** 최대화한 상태가 아직 화면과 맞는지(배치 탭으로 가면 풀린 것으로 본다) */
function stillShown(m: MaxState): boolean {
  if (m.kind === 'tiles') return m.st.space === MODEL_SPACE && !m.st.msVp && !m.st.blockEdit && !m.st.tiles;
  return m.st.space === MODEL_SPACE && !m.st.msVp && !m.st.blockEdit && !!m.st.layoutFor(m.layout);
}

/** 화면에서 이미 풀린 최대화는 카메라·타일만 되돌린다 */
export function syncMaximized(app: App): void {
  for (const m of [...maxed.values()]) {
    if (!app.docs.includes(m.st)) {
      maxed.delete(m.st);
      continue;
    }
    if (!stillShown(m)) {
      restoreModelTab(m);
      maxed.delete(m.st);
      app.view.requestRender();
      app.ui?.refreshStatus();
    }
  }
}

function restoreModelTab(m: MaxState): void {
  const st = m.st;
  if (m.kind === 'tiles') {
    if (!st.tiles) st.tiles = m.tiles;
    return;
  }
  st.tiles = m.tiles;
  if (m.modelCam) st.cameras.set(MODEL_SPACE, m.modelCam);
  else st.cameras.delete(MODEL_SPACE);
  if (m.modelPrev) st.prevCameras.set(MODEL_SPACE, m.modelPrev);
  else st.prevCameras.delete(MODEL_SPACE);
}

/**
 * 뷰포트 동결 도면층을 숨기는 모형 스타일 고리. 처음 최대화할 때 한 번 끼우고(앞 고리를 부른다) 빼지 않는다 —
 * 최대화 중이 아니면 앞 고리 그대로다(도면 비교·참조 편집이 뒤에 끼워도 그들의 앞 고리로 남는다).
 */
function installOverride(app: App): void {
  if (overrideInstalled) return;
  overrideInstalled = true;
  const v = app.view;
  const prev = v.modelStyleOverride;
  v.modelStyleOverride = (s) => {
    const before = prev?.(s) ?? null;
    const m = maxed.get(s);
    if (!m || m.kind !== 'layout' || !m.frozen.size || !stillShown(m)) return before;
    const scene = s.scenes.get(MODEL_SPACE);
    if (!scene) return before;
    const idx = s.sceneLayerIndex(MODEL_SPACE);
    const frozen = new Set<number>();
    for (const n of m.frozen) {
      const i = idx.get(n);
      if (i !== undefined) frozen.add(i);
    }
    return (data) => {
      const dark = isDark(v.modelBg);
      const base = scene.styleData(s.sceneLayers(MODEL_SPACE), 'model', dark, v.modelBg, v.lwDisplay);
      let out = data;
      // 기본 장면의 스타일 표면 같은 열쇠의 동결판, 깊이 확대 세부 장면이면 그 장면의 동결판
      if (data === base) out = scene.styleData(s.sceneLayers(MODEL_SPACE), 'model', dark, v.modelBg, v.lwDisplay, frozen);
      else if (v.detail && v.detail.docId === s.docId) out = v.detail.scene.styleData((k) => s.layers.get(k), dark, v.modelBg, v.lwDisplay, m.frozen);
      return before ? before(out) : out;
    };
  };
}

/** 뷰포트가 보이던 모형 범위로 모형 카메라를 맞춘다 */
function zoomToViewport(app: App, vp: ViewportEntity): void {
  const w = vpModelWindow(vp);
  if (!w) return;
  app.view.zoomRect(w.cx - w.w / 2, w.cy - w.h / 2, w.cx + w.w / 2, w.cy + w.h / 2, false, 0);
}

/** 배치 뷰포트 최대화 */
function maximizeLayout(app: App, st: DocState, layout: string, vp: ViewportEntity): boolean {
  if (vp.twistAngle) {
    app.cmd.print('비틀린 뷰포트는 아직 최대화할 수 없습니다.', 'err');
    return false;
  }
  if (!vpModelWindow(vp)) {
    app.cmd.print('뷰포트의 뷰 높이가 0이라 최대화할 수 없습니다.', 'err');
    return false;
  }
  installOverride(app);
  app.flushViewportView();
  const m: MaxState = {
    st,
    kind: 'layout',
    layout,
    vp: vp.handle,
    wasMs: !!st.msVp,
    modelCam: st.cameras.get(MODEL_SPACE) ? { ...st.cameras.get(MODEL_SPACE)! } : undefined,
    modelPrev: st.prevCameras.get(MODEL_SPACE)?.slice(),
    tiles: st.tiles,
    frozen: new Set(vp.frozenLayers.map(tableKey)),
  };
  st.msVp = null;
  st.space = MODEL_SPACE;
  st.tiles = null;
  st.selection.clear();
  st.prevCameras.set(MODEL_SPACE, []);
  maxed.set(st, m);
  app.view.setState(st);
  zoomToViewport(app, vp);
  // 배치 탭은 그대로 둔다(AutoCAD처럼 배치에 있는 채 최대화). 상태 막대·팔레트만
  app.ui.refreshStatus();
  app.ui.refreshPalette();
  app.refreshSelectionOverlay();
  return true;
}

/** 지금 도면의 뷰포트 최대화. 뷰포트를 골라야 하면 묻는다 */
export async function vpMax(app: App, ctx: CommandContext): Promise<void> {
  const st = app.active!;
  syncMaximized(app);
  if (maxed.has(st)) {
    ctx.print('뷰포트가 이미 최대화되어 있습니다. VPMIN으로 복원하십시오.');
    return;
  }
  if (st.blockEdit) {
    ctx.print('블록 편집기에서는 뷰포트를 최대화할 수 없습니다.', 'err');
    return;
  }
  // 모형 타일
  if (st.isModel && !st.msVp) {
    if (!st.tiles || st.tiles.list.length < 2) {
      ctx.print('최대화할 뷰포트가 없습니다(모형 탭은 VPORTS로 나눈 타일 뷰포트일 때만).', 'err');
      return;
    }
    maxed.set(st, { st, kind: 'tiles', layout: MODEL_SPACE, vp: '', wasMs: false, modelCam: undefined, modelPrev: undefined, tiles: st.tiles, frozen: new Set() });
    st.tiles = null;
    app.view.setState(st);
    app.ui.refreshStatus();
    return;
  }
  const layout = st.msVp?.layout ?? st.space;
  const lay = st.layoutFor(layout);
  if (!lay) return;
  await app.ensureScene(st, MODEL_SPACE);
  const vps = layoutViewports(st.doc, lay);
  if (!vps.length) {
    ctx.print('최대화할 뷰포트가 없습니다.', 'err');
    return;
  }
  let vp: ViewportEntity | undefined;
  if (st.msVp) vp = vps.find((v) => v.handle === st.msVp!.handle);
  else if (vps.length === 1) vp = vps[0];
  else {
    for (;;) {
      const r = await ctx.getPoint('최대화할 뷰포트 선택:');
      if (!('point' in r)) return;
      vp = [...vps].reverse().find((v) => insideViewport(v, r.point));
      if (vp) break;
      ctx.print('뷰포트를 찾을 수 없습니다.', 'err');
    }
  }
  if (!vp) return;
  if (maximizeLayout(app, st, layout, vp)) ctx.print(`뷰포트 ${vp.id}을(를) 최대화했습니다. VPMIN으로 복원합니다.`);
}

/** 최대화 복원(VPMIN). 복원했으면 true */
export async function vpMin(app: App, ctx: CommandContext | null): Promise<boolean> {
  const st = app.active;
  syncMaximized(app);
  const m = st ? maxed.get(st) : null;
  if (!st || !m) {
    ctx?.print('최대화된 뷰포트가 없습니다.');
    return false;
  }
  maxed.delete(st);
  restoreModelTab(m);
  if (m.kind === 'tiles') {
    app.view.setState(st);
    app.ui.refreshStatus();
    return true;
  }
  app.cancel(true);
  st.selection.clear();
  await app.setSpace(m.layout);
  const vp = st.doc.entityIndex.get(m.vp);
  if (m.wasMs && vp?.type === 'VIEWPORT') app.enterViewport(st, vp);
  app.ui.refreshLayouts();
  app.ui.refreshStatus();
  app.view.requestRender();
  return true;
}

/** 최대화한 채 이전/다음 뷰포트로(배치는 그 배치의 뷰포트, 타일은 타일 순서) */
export function vpMaxStep(app: App, ctx: CommandContext, d: number): void {
  const st = app.active;
  syncMaximized(app);
  const m = st ? maxed.get(st) : null;
  if (!st || !m) {
    ctx.print('최대화된 뷰포트가 없습니다.');
    return;
  }
  if (m.kind === 'tiles') {
    const t = m.tiles;
    if (!t || t.list.length < 2) return;
    const next = (((t.active + d) % t.list.length) + t.list.length) % t.list.length;
    // 타일 구성을 잠시 되돌려 카메라를 바꿔 낀다
    st.tiles = t;
    app.view.activateTile(next);
    st.tiles = null;
    app.view.setState(st);
    ctx.print(`타일 뷰포트 ${next + 1}/${t.list.length}`);
    return;
  }
  const lay = st.layoutFor(m.layout);
  if (!lay) return;
  const vps = layoutViewports(st.doc, lay).filter((v) => !v.twistAngle && vpModelWindow(v));
  if (!vps.length) return;
  const i = vps.findIndex((v) => v.handle === m.vp);
  const vp = vps[(((i < 0 ? 0 : i + d) % vps.length) + vps.length) % vps.length]!;
  m.vp = vp.handle;
  m.frozen = new Set(vp.frozenLayers.map(tableKey));
  st.prevCameras.set(MODEL_SPACE, []);
  zoomToViewport(app, vp);
  app.view.requestRender();
  app.ui.refreshStatus();
  ctx.print(`뷰포트 ${vp.id}을(를) 최대화했습니다.`);
}

/** 최대화 표시: 도면 영역 둘레의 빨간 굵은 테두리(덧그림 고리에서 부른다) */
export function drawVpMaxOverlay(app: App, g: CanvasRenderingContext2D): void {
  const st = app.active;
  const m = st ? maxed.get(st) : null;
  if (!m) return;
  if (!stillShown(m)) {
    // 다른 탭으로 갔다: 다음 틀에서 정리
    setTimeout(() => syncMaximized(app));
    return;
  }
  g.save();
  g.strokeStyle = 'rgba(225,40,40,0.95)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, app.view.width - 4, app.view.height - 4);
  g.restore();
}
