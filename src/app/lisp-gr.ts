/**
 * AutoLISP 임시 그림(grdraw·grvecs): 화면 덧그림(extraOverlay)에 벡터를 그린다. 도면에는 남지 않는다.
 * AutoCAD처럼 다시 그리면 사라진다: (redraw)·REDRAW·REGEN, 화면을 확대·이동했을 때, 다른 도면으로 바꿨을 때.
 * 색은 ACI(7은 배경에 따라 흰색·검은색), -1은 반전 색(배경과 대비), 강조(highlight)는 점선.
 */
import { aciToRgb, rgbToCss } from '../core/color';
import type { App } from './app';
import type { Pt } from './view';

export interface GrVector {
  /** WCS */
  a: Pt;
  b: Pt;
  color: number;
  highlight: boolean;
}

interface State {
  vecs: GrVector[];
  /** 그린 때의 화면 변환(바뀌면 지운다) */
  view: string | null;
  doc: unknown;
  chained: boolean;
}

const states = new WeakMap<App, State>();
const wrapped = new WeakSet<object>();

function stateOf(app: App): State {
  let s = states.get(app);
  if (!s) {
    s = { vecs: [], view: null, doc: null, chained: false };
    states.set(app, s);
  }
  return s;
}

/** 지금 그린 임시 벡터(시험용) */
export function grVectors(app: App): readonly GrVector[] {
  return states.get(app)?.vecs ?? [];
}

/** 임시 벡터를 지운다 */
export function grClear(app: App): void {
  const s = states.get(app);
  if (!s || !s.vecs.length) return;
  s.vecs = [];
  app.view?.requestOverlay?.();
}

/** 덧그림 고리와 REDRAW·REGEN 명령에 한 번 잇는다(처음 그릴 때: 다른 모듈이 덧그림을 단 뒤) */
function link(app: App, s: State): void {
  if (s.chained) return;
  s.chained = true;
  const v = app.view as unknown as { extraOverlay?: ((g: CanvasRenderingContext2D, W: (x: number, y: number) => Pt, dark: boolean) => void) | null };
  const prev = v.extraOverlay ?? null;
  v.extraOverlay = (g, W, dark) => {
    prev?.(g, W, dark);
    paint(app, g, W, dark);
  };
  for (const n of ['REDRAW', 'REDRAWALL', 'REGEN', 'REGENALL']) {
    const c = app.commands.get(n);
    if (!c || wrapped.has(c)) continue;
    wrapped.add(c);
    const run = c.run.bind(c);
    c.run = (ctx, arg) => {
      grClear(app);
      return run(ctx, arg);
    };
  }
}

function paint(app: App, g: CanvasRenderingContext2D, W: (x: number, y: number) => Pt, dark: boolean): void {
  const s = states.get(app);
  if (!s || !s.vecs.length) return;
  const o = W(0, 0);
  const x = W(1, 0);
  const key = `${o.x.toFixed(3)},${o.y.toFixed(3)},${x.x.toFixed(3)},${x.y.toFixed(3)}`;
  if (s.view === null) s.view = key;
  else if (s.view !== key || s.doc !== app.active) {
    // 화면이 바뀌면(다시 그리기) 사라진다
    s.vecs = [];
    return;
  }
  g.save();
  g.lineWidth = 1;
  for (const v of s.vecs) {
    const a = W(v.a.x, v.a.y);
    const b = W(v.b.x, v.b.y);
    g.strokeStyle = v.color < 0 || v.color > 255 ? (dark ? '#ffffff' : '#000000') : rgbToCss(aciToRgb(v.color || 7, dark));
    g.setLineDash(v.highlight ? [4, 3] : []);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }
  g.restore();
}

/** 임시 벡터를 더한다(WCS) */
export function grDraw(app: App, vecs: GrVector[]): void {
  const s = stateOf(app);
  link(app, s);
  if (s.doc !== app.active) {
    s.vecs = [];
    s.doc = app.active;
  }
  if (!s.vecs.length) s.view = null;
  s.vecs.push(...vecs);
  app.view?.requestOverlay?.();
}
