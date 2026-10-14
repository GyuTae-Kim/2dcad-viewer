/**
 * 편집 관리자: 편집 세션의 변경을 화면·고르기·워커에 반영한다.
 * - 바뀐 객체의 옛 그림은 기본 장면에서 숨기고, 새 모양은 덧그림 장면으로 바로 그린다.
 * - 편집이 잠시 멈추면 워커가 그 공간을 다시 그려(그리기 순서·메모리 정리) 기본 장면을 바꾼다.
 */
import { plotStyleNames } from '../render/styles';
import type { Entity } from '../core/model';
import { tableKey } from '../core/model';
import { unitSettings } from '../core/units';
import { type ChangeSummary, EditSession, type Transaction } from '../edit/session';
import type { App } from './app';
import type { DocState } from './docstate';
import { OverlayScene } from './scene';
import { expandXrefBounds } from './refs';

const REBUILD_DELAY = 1200;

export class EditManager {
  private timers = new Map<DocState, number>();
  /** 다음 다시 그리기 때 모든 공간을 다시 그릴 문서 */
  private readonly rebuildAll = new Set<DocState>();
  /** 공간별 지운 객체 → 지운 세대(다시 그리기 사이에 지운 것을 가리기 위해) */
  private readonly dead = new WeakMap<DocState, Map<string, Map<string, number>>>();

  constructor(private readonly app: App) {}

  attach(st: DocState): void {
    st.session = new EditSession(st.doc, (tx, sum) => this.onApply(st, tx, sum));
  }

  private deadOf(st: DocState, space: string): Map<string, number> {
    let m = this.dead.get(st);
    if (!m) {
      m = new Map();
      this.dead.set(st, m);
    }
    let d = m.get(space);
    if (!d) {
      d = new Map();
      m.set(space, d);
    }
    return d;
  }

  private onApply(st: DocState, tx: Transaction, sum: ChangeSummary): void {
    const app = this.app;
    st.gen++;
    app.engine.edit(st.docId, tx.ops);
    for (const op of tx.ops) if (op.kind === 'add') app.lastCreated.push(op.entity.handle);
    if (app.lastCreated.length > 50) app.lastCreated.splice(0, app.lastCreated.length - 50);
    const renderer = app.view.renderer;
    for (const [space, ch] of sum.spaces) {
      // 아직 그리지 않은 공간(처음 여는 배치, 열지 않은 블록)은 나중에 워커가 편집된 문서로 그린다
      if (!st.scenes.has(space)) continue;
      const ed = st.spaceEdits(space);
      const base = st.scenes.get(space);
      const dead = this.deadOf(st, space);
      for (const h of ch.removed) {
        if (base && !ed.hidden.has(h)) {
          base.hide(renderer, h);
          ed.hidden.add(h);
        }
        ed.live.delete(h);
        dead.set(h, st.gen);
      }
      for (const e of ch.changed) {
        ed.live.set(e.handle, st.gen);
        dead.delete(e.handle);
      }
      this.rebuildOverlay(st, space, [...ch.removed, ...ch.changed.map((e) => e.handle)]);
    }
    if (sum.tablesChanged || sum.layersChanged) this.syncLayers(st);
    // 타일 뷰포트 구성(VPORTS, 명령 취소 포함)
    if (tx.ops.some((o) => o.kind === 'vports')) app.onVportsChanged?.(st);
    if (sum.layoutsChanged) {
      // 보고 있던 배치가 없어졌으면 모형으로
      if (!st.blockEdit && !st.isModel && !st.layoutFor(st.space)) st.space = tableKey('*Model_Space');
      app.ui.refreshLayouts();
      app.view.setState(st);
    }
    if (tx.ops.some((o) => o.kind === 'header' && /^\$(LUNITS|LUPREC|AUNITS|AUPREC|INSUNITS|ANGBASE|ANGDIR|MEASUREMENT)$/.test(o.name))) st.units = unitSettings(st.doc);
    // 지워진 객체는 선택에서 뺀다
    for (const h of [...st.selection]) if (!st.doc.entityIndex.has(h)) st.selection.delete(h);
    // 그림에 영향을 주는 시스템 변수(선종류 축척, 점 모양, 채우기)는 모든 공간을 다시 그린다
    const drawVars = tx.ops.some(
      (o) =>
        (o.kind === 'header' && /^\$(LTSCALE|PSLTSCALE|PDMODE|PDSIZE|FILLMODE|MIRRTEXT|QTEXTMODE|TEXTFILL|ATTMODE)$/.test(o.name)) ||
        // 이미지·가리기 테두리 설정(IMAGEFRAME·WIPEOUTFRAME)
        (o.kind === 'object' && /^(RASTERVARIABLES|WIPEOUTVARIABLES)$/.test((o.after ?? o.before)?.type ?? '')),
    );
    if (sum.spaces.size || sum.blocksChanged || sum.tablesChanged || drawVars) this.schedule(st, sum.blocksChanged || sum.tablesChanged || drawVars, tx.rebuildNow || drawVars ? 0 : REBUILD_DELAY);
    app.view.requestRender();
    app.scheduleDetail();
    app.refreshSelectionOverlay();
    app.ui.refreshPalette();
    app.ui.refreshStatus();
    app.ui.refreshTabs();
  }

  /** 문서의 도면층 표를 화면 상태(켜기·색)와 맞춘다 */
  syncLayers(st: DocState): void {
    const psn = plotStyleNames(st.doc);
    for (const [k, l] of st.doc.layers) {
      const cur = st.layers.get(k);
      const state = {
        plotStyleName: l.plotStyle ? psn.get(l.plotStyle) : undefined,
        name: l.name,
        rgb: l.color.rgb ?? 0,
        aci: l.color.aci,
        hasRgb: l.color.rgb !== undefined,
        on: !l.off,
        frozen: l.frozen,
        lineweight: l.lineweight,
        transparency: l.transparency,
        plot: l.plot,
      };
      if (cur) Object.assign(cur, state);
      else st.layers.set(k, state);
    }
    st.touchLayers();
  }

  private rebuildOverlay(st: DocState, space: string, changed: string[]): void {
    const app = this.app;
    const ed = st.spaceEdits(space);
    ed.overlay?.dispose(app.view.renderer);
    ed.overlay = null;
    const block = st.doc.blocks.get(space);
    const order = new Map<string, number>();
    block?.entities.forEach((e, i) => order.set(e.handle, i));
    const list = [...ed.live.keys()]
      .map((h) => st.doc.entityIndex.get(h))
      .filter((e): e is Entity => !!e && order.has(e.handle) && !st.hiddenObjects.has(e.handle))
      .sort((a, b) => order.get(a.handle)! - order.get(b.handle)!);
    if (list.length) ed.overlay = new OverlayScene(app.view.renderer, st.doc, list, app.text, space, undefined, app.imageKeys, app.pdfPages);
    app.updatePicker(st, space, changed);
  }

  /** 편집이 멈추면 바뀐 공간을 다시 그린다 */
  private schedule(st: DocState, all: boolean, delay = REBUILD_DELAY): void {
    clearTimeout(this.timers.get(st));
    if (all) this.rebuildAll.add(st);
    this.timers.set(
      st,
      window.setTimeout(() => {
        this.timers.delete(st);
        const everything = this.rebuildAll.delete(st);
        const spaces = everything ? [...st.scenes.keys()] : [...st.edits.entries()].filter(([, e]) => e.live.size || e.hidden.size).map(([k]) => k);
        for (const sp of spaces) void this.rebuild(st, sp);
      }, delay),
    );
  }

  /** 워커가 공간을 다시 그리면 기본 장면을 바꾸고, 그 뒤에 바뀐 객체만 덧그림으로 남긴다 */
  async rebuild(st: DocState, space: string): Promise<void> {
    const app = this.app;
    const key = tableKey(space);
    const reqGen = st.gen;
    let msg;
    try {
      msg = await app.engine.build(st.docId, key);
    } catch {
      return;
    }
    if (!app.docs.includes(st)) return;
    st.addScene(app.view.renderer, msg, key);
    expandXrefBounds(app, st, key);
    const ed = st.spaceEdits(key);
    const base = st.scenes.get(key)!;
    const dead = this.deadOf(st, key);
    ed.hidden = new Set();
    for (const [h, g] of [...ed.live]) if (g <= reqGen) ed.live.delete(h);
    for (const [h, g] of [...dead]) if (g <= reqGen) dead.delete(h);
    for (const h of [...ed.live.keys(), ...dead.keys()]) {
      base.hide(app.view.renderer, h);
      ed.hidden.add(h);
    }
    ed.baseGen = reqGen;
    app.resetPicker(st, key);
    this.rebuildOverlay(st, key, []);
    app.view.requestRender();
    app.refreshSelectionOverlay();
  }

  /** 모든 공간을 곧바로 다시 그린다(글꼴을 새로 불러왔을 때 등) */
  rebuildEverything(st: DocState): void {
    this.schedule(st, true, 0);
  }

  /** 미뤄 둔 다시 그리기를 지금 끝낸다(내보내기·출력 전에) */
  async flush(st: DocState): Promise<void> {
    if (!this.timers.has(st)) return;
    clearTimeout(this.timers.get(st));
    this.timers.delete(st);
    const everything = this.rebuildAll.delete(st);
    const spaces = everything ? [...st.scenes.keys()] : [...st.edits.entries()].filter(([, e]) => e.live.size || e.hidden.size).map(([k]) => k);
    await Promise.all(spaces.map((sp) => this.rebuild(st, sp)));
  }

  /** 문서를 닫을 때 */
  detach(st: DocState): void {
    clearTimeout(this.timers.get(st));
    this.timers.delete(st);
    this.rebuildAll.delete(st);
    this.app.engine.closeDoc(st.docId);
  }
}
