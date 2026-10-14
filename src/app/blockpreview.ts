/**
 * 블록 미리보기: 기존 장면 생성기(SceneBuilder)로 블록 정의를 선분·삼각형으로 펼쳐 2D 캔버스에 그린다.
 * 다른 도면(디자인센터에서 고른 파일)의 블록도 그 도면을 기준으로 그린다(중첩 블록·문자 포함, 색은 한 가지).
 */
import type { CadDocument } from '../core/model';
import { tableKey } from '../core/model';
import { SceneBuilder } from '../render/build';
import type { App } from './app';
import { expandDisplayList } from './pick';
import type { OverlayGeom } from './view';

const builders = new WeakMap<CadDocument, SceneBuilder>();
const cache = new WeakMap<CadDocument, Map<string, OverlayGeom | null>>();

/** 큰 블록은 미리보기를 만들지 않는다 */
const MAX_ENTITIES = 20000;

/** 블록 정의의 형상(블록 좌표). 만들 수 없으면 null */
export function blockGeometry(app: App, doc: CadDocument, name: string): OverlayGeom | null {
  const key = tableKey(name);
  let m = cache.get(doc);
  if (!m) {
    m = new Map();
    cache.set(doc, m);
  }
  if (m.has(key)) return m.get(key)!;
  const def = doc.blocks.get(key);
  let g: OverlayGeom | null = null;
  if (def && def.entities.length <= MAX_ENTITIES) {
    try {
      let b = builders.get(doc);
      if (!b) {
        b = new SceneBuilder(doc, { text: app.text });
        builders.set(doc, b);
      }
      b.prepare(def.name);
      g = expandDisplayList(b.buildEntities(def.entities));
      if (!g.segs.length && !(g.tris?.length ?? 0)) g = null;
    } catch {
      g = null;
    }
  }
  if (m.size > 2000) m.clear();
  m.set(key, g);
  return g;
}

/** 형상의 범위 */
export function geometryBounds(g: OverlayGeom): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (a: readonly number[]) => {
    for (let i = 0; i + 1 < a.length; i += 2) {
      const x = a[i]!;
      const y = a[i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  };
  add(g.segs);
  add(g.tris ?? []);
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** 캔버스에 형상을 맞춰 그린다(없으면 "미리보기 없음") */
export function drawGeometry(canvas: HTMLCanvasElement, g: OverlayGeom | null, color: string): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const hgt = canvas.clientHeight || canvas.height;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(hgt * dpr));
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, hgt);
  const b = g ? geometryBounds(g) : null;
  if (!g || !b) {
    c.fillStyle = color;
    c.globalAlpha = 0.45;
    c.font = '11px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('미리보기 없음', w / 2, hgt / 2);
    c.globalAlpha = 1;
    return;
  }
  const pad = 4;
  const bw = Math.max(b[2] - b[0], 1e-9);
  const bh = Math.max(b[3] - b[1], 1e-9);
  const s = Math.min((w - 2 * pad) / bw, (hgt - 2 * pad) / bh);
  const ox = (w - bw * s) / 2 - b[0] * s;
  const oy = (hgt + bh * s) / 2 + b[1] * s;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy - y * s;
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 1;
  const tris = g.tris ?? [];
  if (tris.length) {
    c.globalAlpha = 0.7;
    c.beginPath();
    const n = Math.min(tris.length, 600_000);
    for (let i = 0; i + 5 < n; i += 6) {
      c.moveTo(X(tris[i]!), Y(tris[i + 1]!));
      c.lineTo(X(tris[i + 2]!), Y(tris[i + 3]!));
      c.lineTo(X(tris[i + 4]!), Y(tris[i + 5]!));
      c.closePath();
    }
    c.fill();
    c.globalAlpha = 1;
  }
  c.beginPath();
  const n = Math.min(g.segs.length, 800_000);
  for (let i = 0; i + 3 < n; i += 4) {
    c.moveTo(X(g.segs[i]!), Y(g.segs[i + 1]!));
    c.lineTo(X(g.segs[i + 2]!), Y(g.segs[i + 3]!));
  }
  c.stroke();
}
