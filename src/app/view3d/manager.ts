/**
 * 3D 문서 관리: NC·STEP·SKP 파일을 파일 탭에 2D 도면과 나란히 연다.
 *
 * - 3D 탭이 활성이면 App.active는 null(2D 명령은 "3D 문서에서는 쓸 수 없습니다"로 막힌다)이고, 2D 도면 위에
 *   3D 보기 영역(.v3d-host)을 덮는다. Viewer3d는 하나만 만들어 탭마다 장면·카메라·숨긴 묶음·재생 위치를 바꿔 끼운다
 *   (WebGL 문맥 수 한계). 마지막 3D 탭을 닫으면 뷰어를 dispose한다.
 * - 해석은 웹 워커(src/worker/view3d.worker.ts)에서 하고, 진행은 기존 진행 상자(setBusy)로 보인다.
 * - 키: 캔버스에 초점이 있으면 뷰어가 F·1~7·Esc를 직접 받는다. 초점이 다른 곳(리본 등)이면 창 캡처 단계에서
 *   같은 키를 뷰어로 보내 명령행이 가로채지 않게 한다. F7 = 격자, Space = NC 재생/멈춤, Ctrl+Tab = 다음 탭.
 */
import type { App } from '../app';
import type { Mode3dHost, RibbonPanel, RibbonTab, Shell } from '../ui/shell';
import { toast } from '../ui/dom';
import { NARROW_WIDTH } from '../ui/layout';
import { DARK_THEME, LIGHT_THEME, VIEW_LABELS, Viewer3d, type MeasureResult, type Pick3d, type RenderMode, type ViewName } from '../../viewer3d/index';
import { View3dWorkerClient } from './client';
import { createDoc, docLabel, lineMoveList, moveEndPoint, moveSegments, productKeyOf, sceneCounts, stepProducts, unitLabel, type Doc3d } from './doc';
import { view3dFormat } from './formats';
import { advance, playbackAt, pointAlong, totalTime, PLAY_SPEEDS, type PlaySpeed } from './playback';
import { errorText, sceneHasGeometry, type NcOpenOptions } from './protocol';
import { SegmentOverlay } from './overlay';
import { View3dPanel } from './panel';
import { NC_SAMPLE_NAME, ncSampleProgram } from './sample';

const RENDER_MODES: [RenderMode, string][] = [
  ['shaded', '음영'],
  ['shadedEdges', '음영 + 모서리'],
  ['wireframe', '와이어프레임'],
  ['xray', 'X-ray'],
];

const VIEW_KEYS: Record<string, ViewName> = { '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '7': 'seIso' };
const VIEW_MENU: ViewName[] = ['top', 'front', 'right', 'left', 'back', 'bottom', 'seIso', 'swIso', 'neIso', 'nwIso'];
const VIEW_KEY_OF: Partial<Record<ViewName, string>> = { front: '1', back: '2', left: '3', right: '4', top: '5', bottom: '6', seIso: '7' };

/** 3D 문서에서 막는 2D 명령 안내 */
export const BLOCKED_IN_3D = '3D 문서에서는 쓸 수 없습니다. 2D 도면 탭으로 바꾼 뒤 실행하십시오.';

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export class View3dManager implements Mode3dHost {
  readonly docs: Doc3d[] = [];
  private activeDoc: Doc3d | null = null;
  private viewer: Viewer3d | null = null;
  private overlay: SegmentOverlay | null = null;
  private readonly host: HTMLDivElement;
  private readonly client = new View3dWorkerClient();
  readonly panel: View3dPanel;
  private switching = false;
  private panelOpen = window.innerWidth >= NARROW_WIDTH;
  private gridOn = true;
  private cubeOn = true;
  private axesOn = true;
  private playing = false;
  private raf = 0;
  private lastT = 0;
  speed: PlaySpeed = 10;

  constructor(
    readonly app: App,
    private readonly shell: Shell,
  ) {
    this.host = document.createElement('div');
    this.host.className = 'v3d-host';
    this.host.hidden = true;
    shell.drawingHost.append(this.host);
    this.panel = new View3dPanel(this, shell.workspace);
    app.onActivate = () => {
      if (this.switching || !this.activeDoc) return;
      this.leave();
    };
    app.noDocMessage = () => (this.activeDoc ? BLOCKED_IN_3D : null);
    window.addEventListener('keydown', (ev) => this.onKey(ev), true);
    new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ───────────────────────── Mode3dHost ─────────────────────────

  get active(): boolean {
    return !!this.activeDoc;
  }

  get doc(): Doc3d | null {
    return this.activeDoc;
  }

  accepts(name: string): boolean {
    return view3dFormat(name) !== null;
  }

  tabs(): ReturnType<Mode3dHost['tabs']> {
    return this.docs.map((d) => ({
      key: d,
      name: d.name,
      title: `${d.name} (${docLabel(d)})`,
      size: d.size,
      active: d === this.activeDoc,
      activate: () => this.activate(d),
      close: () => this.close(d),
    }));
  }

  statusText(): string {
    const d = this.activeDoc;
    if (!d) return '';
    const u = unitLabel(d.scene.units);
    const parts = [`3D · ${docLabel(d)}`];
    if (u) parts.push(`단위 ${u}`);
    if (d.nc) parts.push(`이동 ${d.nc.moves.count.toLocaleString()}개`);
    else {
      const c = sceneCounts(d.scene);
      if (c.triangles) parts.push(`삼각형 ${c.triangles.toLocaleString()}개`);
      else if (c.segments) parts.push(`선분 ${c.segments.toLocaleString()}개`);
    }
    return parts.join(' · ');
  }

  closeActive(): void {
    if (this.activeDoc) this.close(this.activeDoc);
  }

  async openSample(): Promise<void> {
    const bytes = new TextEncoder().encode(ncSampleProgram());
    await this.open(NC_SAMPLE_NAME, bytes.buffer as ArrayBuffer);
  }

  // ───────────────────────── 열기·닫기 ─────────────────────────

  /** 파일 열기(data는 워커로 이전되어 비워진다). 탭을 열었으면 true */
  async open(name: string, data: ArrayBuffer, nc: NcOpenOptions = {}): Promise<boolean> {
    const format = view3dFormat(name);
    if (!format) return false;
    const size = data.byteLength;
    this.shell.setBusy(`${name} 여는 중…`, 0.02);
    try {
      const res = await this.client.open(name, format, data, { nc }, (f, stage) => this.shell.setBusy(`${stage}…`, f));
      if (!sceneHasGeometry(res.scene)) {
        const why = res.scene.warnings?.[0] ?? '그릴 형상을 찾지 못했습니다.';
        toast(`${name}: ${why}`, 'error', 7000);
        this.app.cmd.print(`${name}: ${why}`, 'err');
        return false;
      }
      const doc = createDoc(name, size, res, nc);
      this.docs.push(doc);
      this.activate(doc);
      this.report(doc);
      return true;
    } catch (e) {
      const msg = `파일을 열지 못했습니다: ${errorText(e)}`;
      toast(`${name}: ${msg}`, 'error', 7000);
      this.app.cmd.print(`${name}: ${msg}`, 'err');
      return false;
    } finally {
      this.shell.setBusy(null);
    }
  }

  private report(d: Doc3d): void {
    const c = sceneCounts(d.scene);
    const what = d.nc
      ? `이동 ${d.nc.moves.count.toLocaleString()}개, 공구 ${d.nc.tools.length}개`
      : `삼각형 ${c.triangles.toLocaleString()}개${c.segments ? `, 선분 ${c.segments.toLocaleString()}개` : ''}`;
    this.app.cmd.print(`${d.name}: ${docLabel(d)}, ${what}, 읽기 ${Math.round(d.ms)}ms`);
    const w = d.scene.warnings ?? [];
    for (const x of w.slice(0, 4)) this.app.cmd.print(`참고: ${x}`);
    if (w.length > 4) this.app.cmd.print(`참고: 그 밖에 ${w.length - 4}개 — 3D 패널의 "정보"에서 모두 볼 수 있습니다.`);
  }

  /** NC 다시 해석(방언·단위를 바꿨을 때) */
  async reparse(d: Doc3d, opts: NcOpenOptions): Promise<void> {
    if (!d.nc && !d.mpr) return;
    const src = d.nc?.source.bytes;
    if (!src) return;
    const copy = src.slice().buffer as ArrayBuffer;
    const unitsChanged = (opts.units ?? 'mm') !== (d.ncOptions.units ?? 'mm');
    this.shell.setBusy(`${d.name} 다시 읽는 중…`, 0.05);
    try {
      const res = await this.client.open(d.name, 'nc', copy, { nc: opts }, (f, stage) => this.shell.setBusy(`${stage}…`, f));
      if (!this.docs.includes(d)) return;
      if (d === this.activeDoc) this.stopPlay();
      d.scene = res.scene;
      d.nc = res.nc ?? null;
      d.mpr = res.mpr ?? null;
      d.ms = res.ms;
      d.ncOptions = { ...opts };
      d.highlight = [];
      d.pick = null;
      d.selLine = -1;
      d.selMoves = [];
      d.playSec = null;
      if (unitsChanged) d.camera = null;
      if (d === this.activeDoc) {
        const v = this.viewer;
        if (v) {
          if (!unitsChanged) d.camera = v.getCamera();
          this.applyDoc(d);
        }
        this.panel.show(d);
        this.shell.mode3dChanged();
      }
      this.report(d);
    } catch (e) {
      toast(`${d.name}: 다시 읽지 못했습니다: ${errorText(e)}`, 'error', 7000);
    } finally {
      this.shell.setBusy(null);
    }
  }

  /** 탭 닫기: 장면·버퍼를 놓고, 이웃 탭(3D 먼저, 없으면 2D 마지막, 없으면 시작)으로 */
  close(d: Doc3d): void {
    const i = this.docs.indexOf(d);
    if (i < 0) return;
    const wasActive = d === this.activeDoc;
    this.docs.splice(i, 1);
    if (wasActive) {
      this.stopPlay();
      this.activeDoc = null;
      this.viewer?.clear();
      this.overlay?.set(null);
    }
    // 장면·형식 배열을 놓아 GC가 가져가게
    d.scene = { name: d.scene.name, units: d.scene.units, meshes: [], lines: [] };
    d.nc = null;
    d.mpr = null;
    if (!this.docs.length) this.disposeViewer();
    if (!wasActive) {
      this.shell.refreshTabs();
      return;
    }
    const next = this.docs[Math.min(i, this.docs.length - 1)];
    if (next) {
      this.activate(next);
      return;
    }
    this.leave();
    this.app.activate(this.app.docs[this.app.docs.length - 1] ?? null);
  }

  // ───────────────────────── 활성화 ─────────────────────────

  activate(d: Doc3d): void {
    if (!this.docs.includes(d)) return;
    if (d === this.activeDoc) {
      this.shell.refreshTabs();
      return;
    }
    this.saveView();
    this.stopPlay();
    this.activeDoc = d;
    // 2D 쪽 정리(명령 취소, 도면 비우기). App.onActivate는 switching이면 무시한다
    this.switching = true;
    try {
      this.app.activate(null);
    } finally {
      this.switching = false;
    }
    this.host.hidden = false;
    const v = this.ensureViewer();
    if (!v) {
      this.activeDoc = null;
      this.host.hidden = true;
      this.docs.splice(this.docs.indexOf(d), 1);
      this.shell.mode3dChanged();
      this.app.activate(this.app.docs[this.app.docs.length - 1] ?? null);
      return;
    }
    this.applyDoc(d);
    this.panel.show(d);
    this.panel.setOpen(this.panelOpen);
    this.shell.mode3dChanged();
    document.title = `${d.name} - OpenCAD 3D 보기`;
  }

  /** 3D 모드에서 나간다(2D 탭·시작 화면으로) */
  private leave(): void {
    this.saveView();
    this.stopPlay();
    this.activeDoc = null;
    this.host.hidden = true;
    this.overlay?.set(null);
    this.overlay?.draw(null);
    this.panel.hide();
    this.shell.mode3dChanged();
  }

  private saveView(): void {
    const d = this.activeDoc;
    const v = this.viewer;
    if (!d || !v) return;
    d.camera = v.getCamera();
    d.renderMode = v.getRenderMode();
  }

  /** 문서의 장면과 보기 상태를 뷰어에 올린다 */
  private applyDoc(d: Doc3d): void {
    const v = this.viewer;
    if (!v) return;
    v.setScene(d.scene, { keepView: !!d.camera });
    if (d.camera) v.setCamera(d.camera);
    v.setRenderMode(d.renderMode);
    for (const g of d.hiddenGroups) v.setGroupVisible(g, false);
    for (const id of d.hiddenItems) v.setItemVisible(id, false);
    v.highlight(d.highlight.length ? d.highlight : null);
    d.measure = null;
    this.applyPlayback(d);
    this.updateOverlay();
  }

  private ensureViewer(): Viewer3d | null {
    if (this.viewer) return this.viewer;
    try {
      const v = new Viewer3d(this.host, { theme: currentTheme(), grid: this.gridOn, viewCube: this.cubeOn, axes: this.axesOn });
      this.viewer = v;
      this.overlay = new SegmentOverlay(this.host);
      this.applyTheme();
      v.onPick((p) => this.onPick(p));
      v.onMeasure((m) => this.onMeasure(m));
      v.onCameraChange((c) => {
        if (!this.overlay?.empty) this.overlay?.draw(c);
      });
      return v;
    } catch (e) {
      toast(errorText(e), 'error', 8000);
      this.app.cmd.print(errorText(e), 'err');
      return null;
    }
  }

  private disposeViewer(): void {
    this.stopPlay();
    this.overlay?.dispose();
    this.overlay = null;
    this.viewer?.dispose();
    this.viewer = null;
  }

  private applyTheme(): void {
    const t = currentTheme();
    this.viewer?.setTheme(t);
    const th = t === 'light' ? LIGHT_THEME : DARK_THEME;
    this.overlay?.setColors(th.highlight, t === 'light' ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.55)');
    this.updateOverlay();
  }

  // ───────────────────────── 고르기·강조 ─────────────────────────

  private onPick(p: Pick3d | null): void {
    const d = this.activeDoc;
    if (!d) return;
    d.pick = p;
    if (!p) {
      this.setHighlight([]);
      d.selKey = null;
      this.selectLine(-1, []);
      this.panel.onPick();
      return;
    }
    if (d.nc && (p.kind === 'line' || p.kind === 'point') && p.id.startsWith('nc-')) {
      // NC 선분·구멍: 원본 번호 = 이동 번호 → 그 줄
      const move = p.index;
      const line = move >= 0 && move < d.nc.moves.count ? d.nc.moves.line[move]! : -1;
      this.setHighlight([]);
      this.selectLine(line, move >= 0 ? [move] : [], true);
    } else if (d.mpr && /^mpr-op-\d+$/.test(p.id)) {
      const op = Number(p.id.slice(7));
      this.selectMprOp(op, true);
      return;
    } else if (d.mpr && p.id === 'mpr-hole-centers') {
      this.selectMprOp(p.index, true);
      return;
    } else {
      this.setHighlight([p.id]);
      d.selKey = d.format === 'step' && p.kind === 'mesh' ? productKeyOf(stepProducts(d.scene), p.id) : null;
      this.selectLine(-1, []);
    }
    this.panel.onPick(true);
  }

  private onMeasure(m: MeasureResult | null): void {
    const d = this.activeDoc;
    if (!d) return;
    d.measure = m;
    this.panel.onMeasure();
  }

  setHighlight(ids: string[]): void {
    const d = this.activeDoc;
    if (!d) return;
    d.highlight = ids;
    this.viewer?.highlight(ids.length ? ids : null);
  }

  /** 코드 줄 고르기: 그 줄의 이동을 덧그림으로 강조(moves를 주면 그것만) */
  selectLine(line: number, moves?: number[], reveal = false): void {
    const d = this.activeDoc;
    if (!d) return;
    d.selLine = line;
    d.selMoves = moves ?? (d.nc && line >= 0 ? lineMoveList(d.nc, line) : []);
    this.updateOverlay();
    this.panel.onSelectLine(reveal);
  }

  /** MPR 가공 고르기 */
  selectMprOp(i: number, reveal = false): void {
    const d = this.activeDoc;
    if (!d) return;
    const id = `mpr-op-${i}`;
    const has = d.scene.meshes.some((m) => m.id === id) || d.scene.lines.some((l) => l.id === id);
    this.setHighlight(has ? [id] : []);
    d.selKey = String(i);
    const ops = (d.scene.meta as { operations?: { line?: number }[] } | undefined)?.operations;
    d.selLine = ops?.[i]?.line ?? -1;
    d.selMoves = [];
    this.updateOverlay();
    this.panel.onPick(reveal);
  }

  private updateOverlay(): void {
    const d = this.activeDoc;
    const o = this.overlay;
    if (!o) return;
    o.set(d && d.selMoves.length ? moveSegments(d.scene, d.selMoves) : null);
    o.draw(this.viewer && d ? this.viewer.getCamera() : null);
  }

  // ───────────────────────── 보기 명령 ─────────────────────────

  fit(): void {
    this.viewer?.fit();
  }

  setView(v: ViewName): void {
    this.viewer?.setView(v);
  }

  setProjection(p: 'perspective' | 'orthographic'): void {
    this.viewer?.setProjection(p);
    this.shell.refreshRibbon();
  }

  get projection(): 'perspective' | 'orthographic' {
    return this.viewer?.getProjection() ?? 'perspective';
  }

  setRenderMode(m: RenderMode): void {
    this.viewer?.setRenderMode(m);
    if (this.activeDoc) this.activeDoc.renderMode = m;
    this.shell.refreshRibbon();
  }

  get renderMode(): RenderMode {
    return this.viewer?.getRenderMode() ?? 'shadedEdges';
  }

  toggleGrid(on = !this.gridOn): void {
    this.gridOn = on;
    this.viewer?.setGridVisible(on);
    this.shell.refreshRibbon();
  }

  toggleCube(on = !this.cubeOn): void {
    this.cubeOn = on;
    this.viewer?.setViewCubeVisible(on);
    this.shell.refreshRibbon();
  }

  toggleAxes(on = !this.axesOn): void {
    this.axesOn = on;
    this.viewer?.setAxesVisible(on);
    this.shell.refreshRibbon();
  }

  get measuring(): boolean {
    return !!this.viewer?.measureMode;
  }

  toggleMeasure(on = !this.measuring): void {
    const v = this.viewer;
    if (!v) return;
    v.setMeasureMode(on);
    if (!on && this.activeDoc) this.activeDoc.measure = null;
    if (on) this.app.cmd.print('3D 측정: 두 점을 누르십시오(꼭짓점·끝점 가까우면 그 점에 붙습니다). Esc = 지우기');
    this.panel.onMeasure();
    this.shell.refreshRibbon();
  }

  get isPanelOpen(): boolean {
    return this.panelOpen;
  }

  togglePanel(on = !this.panelOpen): void {
    this.panelOpen = on;
    this.panel.setOpen(on);
    this.shell.refreshRibbon();
    // 좁은 화면에서는 시트가 3D 보기 높이를 바꾸므로 크기가 정해진 뒤 다시 맞춘다
    if (window.innerWidth < NARROW_WIDTH && this.viewer) requestAnimationFrame(() => requestAnimationFrame(() => this.viewer?.fit(false)));
  }

  setGroupVisible(g: string, on: boolean): void {
    const d = this.activeDoc;
    if (!d) return;
    if (on) d.hiddenGroups.delete(g);
    else d.hiddenGroups.add(g);
    this.viewer?.setGroupVisible(g, on);
  }

  setItemsVisible(ids: readonly string[], on: boolean): void {
    const d = this.activeDoc;
    if (!d) return;
    for (const id of ids) {
      if (on) d.hiddenItems.delete(id);
      else d.hiddenItems.add(id);
      this.viewer?.setItemVisible(id, on);
    }
  }

  groups(): { name: string; visible: boolean; count: number }[] {
    return this.viewer?.groups() ?? [];
  }

  async savePng(): Promise<void> {
    const v = this.viewer;
    const d = this.activeDoc;
    if (!v || !d) return;
    try {
      const b = await v.toBlob('image/png');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `${d.name.replace(/\.[^.]+$/, '')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.app.cmd.print('지금 3D 화면을 PNG로 저장했습니다.');
    } catch (e) {
      toast(`그림을 저장하지 못했습니다: ${errorText(e)}`, 'error');
    }
  }

  // ───────────────────────── NC 재생 ─────────────────────────

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 재생 시각을 정한다(null = 전체 경로) */
  seek(sec: number | null): void {
    const d = this.activeDoc;
    if (!d?.nc) return;
    const total = totalTime(d.nc.timeline);
    d.playSec = sec === null ? null : Math.max(0, Math.min(total, sec));
    this.applyPlayback(d);
    this.panel.onPlayback();
  }

  togglePlay(): void {
    const d = this.activeDoc;
    if (!d?.nc || !d.nc.moves.count) return;
    if (this.playing) {
      this.stopPlay();
      this.panel.onPlayback();
      this.shell.refreshRibbon();
      return;
    }
    const total = totalTime(d.nc.timeline);
    if (d.playSec === null || d.playSec >= total) d.playSec = 0;
    this.playing = true;
    this.lastT = performance.now();
    const tick = (t: number) => {
      this.raf = 0;
      const doc = this.activeDoc;
      if (!this.playing || !doc?.nc || doc.playSec === null) return;
      const r = advance(doc.playSec, Math.min(250, t - this.lastT), this.speed, totalTime(doc.nc.timeline));
      this.lastT = t;
      doc.playSec = r.sec;
      this.applyPlayback(doc);
      this.panel.onPlayback();
      if (r.done) {
        this.playing = false;
        this.shell.refreshRibbon();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.panel.onPlayback();
    this.shell.refreshRibbon();
  }

  setSpeed(s: PlaySpeed): void {
    if (PLAY_SPEEDS.includes(s)) this.speed = s;
    this.panel.onPlayback();
  }

  stopPlay(): void {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** 지금 재생 위치(줄·이동) */
  playbackInfo(): { move: number; frac: number; line: number; sec: number; total: number } | null {
    const d = this.activeDoc;
    if (!d?.nc) return null;
    const total = totalTime(d.nc.timeline);
    if (d.playSec === null) return { move: -1, frac: 0, line: -1, sec: total, total };
    const { move, frac } = playbackAt(d.nc.timeline, d.playSec);
    return { move, frac, line: move >= 0 ? d.nc.moves.line[move]! : -1, sec: d.playSec, total };
  }

  private applyPlayback(d: Doc3d): void {
    const v = this.viewer;
    if (!v) return;
    if (!d.nc || d.playSec === null) {
      v.setDrawLimitBySegmentId(null);
      v.setMarker(null);
      return;
    }
    const { move, frac } = playbackAt(d.nc.timeline, d.playSec);
    if (move < 0) {
      v.setDrawLimitBySegmentId(null);
      v.setMarker(null);
      return;
    }
    const end = v.setDrawLimitBySegmentId(move, { ghost: 0.14 });
    const seg = moveSegments(d.scene, [move], 4096);
    const pos = pointAlong(seg, frac) ?? end ?? moveEndPoint(d.nc, move);
    v.setMarker(pos, 'cone');
  }

  // ───────────────────────── 리본 ─────────────────────────

  ribbonTab(): RibbonTab {
    const d = this.activeDoc;
    const panels: RibbonPanel[] = [
      {
        title: '보기',
        large: [
          { label: '전체 보기', icon: 'extents', tip: '전체 보기 (F)', noDoc: true, run: () => this.fit() },
          {
            label: '표준 뷰',
            icon: 'views',
            tip: '표준 뷰 (1 앞 · 2 뒤 · 3 왼쪽 · 4 오른쪽 · 5 위 · 6 아래 · 7 등각)',
            noDoc: true,
            menu: VIEW_MENU.map((v) => ({ label: `${VIEW_LABELS[v]}${VIEW_KEY_OF[v] ? ` (${VIEW_KEY_OF[v]})` : ''}`, icon: 'views', run: () => this.setView(v) })),
          },
        ],
        cols: [
          [
            { label: '원근 투영', icon: 'eye', noDoc: true, on: () => this.projection === 'perspective', run: () => this.setProjection('perspective') },
            { label: '평행 투영', icon: 'eye', noDoc: true, on: () => this.projection === 'orthographic', run: () => this.setProjection('orthographic') },
          ],
        ],
      },
      {
        title: '표시',
        large: [
          {
            label: '그리기 모드',
            icon: 'sun',
            tip: '음영 · 음영+모서리 · 와이어프레임 · X-ray',
            noDoc: true,
            menu: RENDER_MODES.map(([m, label]) => ({ label, icon: 'sun', on: () => this.renderMode === m, run: () => this.setRenderMode(m) })),
          },
        ],
        cols: [
          [
            { label: '격자', icon: 'grid', tip: '바닥 격자 (F7)', noDoc: true, on: () => this.gridOn, run: () => this.toggleGrid() },
            { label: '뷰 큐브', icon: 'block', noDoc: true, on: () => this.cubeOn, run: () => this.toggleCube() },
            { label: '좌표축', icon: 'coord', noDoc: true, on: () => this.axesOn, run: () => this.toggleAxes() },
          ],
        ],
      },
      {
        title: '도구',
        large: [
          { label: '측정', icon: 'dist', tip: '두 점 거리·dx·dy·dz (Esc로 지우기)', noDoc: true, on: () => this.measuring, run: () => this.toggleMeasure() },
          { label: '그림 저장', icon: 'exportPng', tip: '지금 화면을 PNG로 저장', noDoc: true, run: () => void this.savePng() },
          { label: '패널', icon: 'props', tip: '3D 패널 열기·닫기', noDoc: true, on: () => this.panelOpen, run: () => this.togglePanel() },
        ],
      },
    ];
    if (d?.nc) {
      panels.push({
        title: 'NC 재생',
        large: [{ label: '재생', icon: 'chevron', tip: '재생 / 멈춤 (Space)', noDoc: true, on: () => this.playing, run: () => this.togglePlay() }],
        cols: [
          [
            { label: '처음으로', icon: 'undo', noDoc: true, run: () => this.seek(0) },
            { label: '전체 경로', icon: 'extents', noDoc: true, run: () => (this.stopPlay(), this.seek(null), this.shell.refreshRibbon()) },
            {
              label: '재생 속도',
              icon: 'quick',
              noDoc: true,
              menu: PLAY_SPEEDS.map((s) => ({ label: `×${s}`, icon: 'quick', on: () => this.speed === s, run: () => this.setSpeed(s) })),
            },
          ],
        ],
      });
    }
    panels.push({
      title: '문서',
      large: [{ label: '닫기', icon: 'close', tip: '이 3D 문서 닫기', noDoc: true, run: () => this.closeActive() }],
    });
    return { tab: '3D 보기', panels };
  }

  // ───────────────────────── 키 ─────────────────────────

  private onKey(ev: KeyboardEvent): void {
    const mod = ev.ctrlKey || ev.metaKey;
    // Ctrl+Tab: 2D·3D 탭을 함께 돈다(3D 탭이 있을 때만 가로챈다)
    if (mod && !ev.altKey && ev.key === 'Tab' && this.docs.length) {
      ev.preventDefault();
      ev.stopPropagation();
      this.shell.cycleTabs(ev.shiftKey ? -1 : 1);
      return;
    }
    const v = this.viewer;
    if (!this.activeDoc || !v) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.dialog-back')) return;
    if (mod || ev.altKey) return;
    const onCanvas = t === v.canvas;
    const k = ev.key;
    if (k === 'F7') {
      ev.preventDefault();
      ev.stopPropagation();
      this.toggleGrid();
      return;
    }
    // Space = 재생/멈춤(단추에 초점이 있으면 그 단추를 누르게 둔다)
    if (k === ' ' && this.activeDoc.nc && !(t instanceof HTMLButtonElement)) {
      ev.preventDefault();
      ev.stopPropagation();
      this.togglePlay();
      return;
    }
    // 캔버스에 초점이 있으면 뷰어가 직접 받는다(F·1~7·Esc)
    if (onCanvas) {
      if (k === 'Escape' && !v.measureMode) this.clearSelection();
      return;
    }
    if (k === 'f' || k === 'F') {
      ev.preventDefault();
      ev.stopPropagation();
      v.fit();
      return;
    }
    if (VIEW_KEYS[k]) {
      ev.preventDefault();
      ev.stopPropagation();
      v.setView(VIEW_KEYS[k]!);
      return;
    }
    if (k === 'Escape') {
      // 명령 취소(App)도 그대로 받게 전파는 막지 않는다
      if (v.measureMode) v.clearMeasure();
      else this.clearSelection();
    }
  }

  private clearSelection(): void {
    const d = this.activeDoc;
    if (!d) return;
    d.pick = null;
    d.selKey = null;
    this.setHighlight([]);
    this.selectLine(-1, []);
    this.panel.onPick();
  }
}
