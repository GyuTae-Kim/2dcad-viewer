/**
 * 검사 치수(DIMINSPECT): AutoCAD와 같은 XDATA `ACAD_DSTYLE_DIMINSPECT`
 * = 1070 396, 1000 검사율, [1070 395, 1000 레이블,] 1070 394, 1070 플래그(1 원형·2 각도·4 없음 + 16 레이블 + 32 검사율), 1070 393, 1070 켬(1)·끔(0).
 * 검사율이 없으면 396 쌍과 32 비트가 없다. 프레임은 레이블 · 치수 값 · 검사율 칸과 칸막이이고,
 * 원형은 양 끝 반원, 각도는 양 끝 꼭지, 없음은 문자만이다.
 */
import type { XData } from '../../core/model';
import type { TextBox } from './textbox';

export const INSPECT_APP = 'ACAD_DSTYLE_DIMINSPECT';

export type InspectShape = 'round' | 'angular' | 'none';

export interface Inspect {
  on: boolean;
  shape: InspectShape;
  label: string | null;
  rate: string | null;
}

export function readInspect(e: { xdata?: XData[] }): Inspect | null {
  const x = e.xdata?.find((d) => d.app.toUpperCase() === INSPECT_APP);
  if (!x) return null;
  let rate: string | null = null;
  let label: string | null = null;
  let flags = 1;
  let on = true;
  const it = x.items;
  for (let i = 0; i + 1 < it.length; i++) {
    if (it[i]!.code !== 1070) continue;
    const key = Number(it[i]!.value);
    const v = it[i + 1]!;
    if (key === 396 && v.code === 1000) rate = String(v.value);
    else if (key === 395 && v.code === 1000) label = String(v.value);
    else if (key === 394 && v.code === 1070) flags = Number(v.value);
    else if (key === 393 && v.code === 1070) on = Number(v.value) !== 0;
    else continue;
    i++;
  }
  const shape: InspectShape = flags & 2 ? 'angular' : flags & 4 ? 'none' : 'round';
  return { on, shape, label: flags & 16 ? (label ?? '') : null, rate: flags & 32 ? (rate ?? '100%') : null };
}

export function inspectXData(i: Inspect): XData {
  const flags = (i.shape === 'angular' ? 2 : i.shape === 'none' ? 4 : 1) | (i.label !== null ? 16 : 0) | (i.rate !== null ? 32 : 0);
  const items: XData['items'] = [];
  if (i.rate !== null) items.push({ code: 1070, value: 396 }, { code: 1000, value: i.rate });
  if (i.label !== null) items.push({ code: 1070, value: 395 }, { code: 1000, value: i.label });
  items.push({ code: 1070, value: 394 }, { code: 1070, value: flags }, { code: 1070, value: 393 }, { code: 1070, value: i.on ? 1 : 0 });
  return { app: INSPECT_APP, items };
}

/** 검사 기록을 넣거나(i) 지운(null) 확장 자료 */
export function withInspect(xdata: XData[] | undefined, i: Inspect | null): XData[] | undefined {
  const rest = (xdata ?? []).filter((d) => d.app.toUpperCase() !== INSPECT_APP);
  if (!i) return rest.length ? rest : undefined;
  return [...rest, inspectXData(i)];
}

export interface InspectCell {
  text: string;
  /** 칸 가운데의 프레임 왼쪽 끝에서의 거리 */
  cx: number;
  w: number;
}

export interface InspectLayout {
  shape: InspectShape;
  cells: InspectCell[];
  /** 프레임 전체 폭·높이 */
  W: number;
  H: number;
  /** 양 끝 반원·꼭지의 길이 */
  end: number;
}

/** 칸 배치(문자 높이 h, 여백 gap). valueText는 치수 값 MTEXT */
export function inspectLayout(i: Inspect, valueText: string, valueBox: TextBox, h: number, gap: number, measure: (t: string) => TextBox): InspectLayout {
  const pad = Math.max(gap, h * 0.25);
  const H = h + 2 * pad;
  const end = i.shape === 'none' ? 0 : H / 2;
  const parts: { text: string; w: number }[] = [];
  if (i.label !== null) parts.push({ text: i.label, w: measure(i.label).w });
  parts.push({ text: valueText, w: valueBox.w });
  if (i.rate !== null) parts.push({ text: i.rate, w: measure(i.rate).w });
  const cells: InspectCell[] = [];
  let x = end;
  for (const p of parts) {
    const w = Math.max(p.w, h * 0.5) + 2 * pad;
    cells.push({ text: p.text, cx: x + w / 2, w });
    x += w;
  }
  return { shape: i.shape, cells, W: x + end, H, end };
}

export interface InspectGeometry {
  lines: [number, number, number, number][];
  /** 중심, 반지름, 시작·끝 각도(반시계) */
  arcs: { cx: number; cy: number; r: number; a0: number; a1: number }[];
  texts: { text: string; x: number; y: number }[];
}

/** 프레임 선·호와 칸 문자 자리(가운데 cx, cy, 각도 a 기준) */
export function inspectGeometry(lay: InspectLayout, cx: number, cy: number, a: number): InspectGeometry {
  const c = Math.cos(a);
  const s = Math.sin(a);
  // 지역 좌표: 프레임 왼쪽 끝 x=0, 가운데 높이 y=0
  const P = (x: number, y: number): [number, number] => {
    const lx = x - lay.W / 2;
    return [cx + c * lx - s * y, cy + s * lx + c * y];
  };
  const out: InspectGeometry = { lines: [], arcs: [], texts: [] };
  const L = (x0: number, y0: number, x1: number, y1: number) => {
    const [a0, b0] = P(x0, y0);
    const [a1, b1] = P(x1, y1);
    out.lines.push([a0, b0, a1, b1]);
  };
  const hh = lay.H / 2;
  for (const cell of lay.cells) {
    const [x, y] = P(cell.cx, 0);
    out.texts.push({ text: cell.text, x, y });
  }
  if (lay.shape === 'none') return out;
  const x0 = lay.end;
  const x1 = lay.W - lay.end;
  L(x0, hh, x1, hh);
  L(x0, -hh, x1, -hh);
  // 칸막이
  let x = x0;
  for (let k = 0; k < lay.cells.length; k++) {
    if (k > 0) L(x, hh, x, -hh);
    x += lay.cells[k]!.w;
  }
  if (lay.shape === 'round') {
    const [lx, ly] = P(x0, 0);
    const [rx, ry] = P(x1, 0);
    out.arcs.push({ cx: lx, cy: ly, r: hh, a0: a + Math.PI / 2, a1: a + (3 * Math.PI) / 2 });
    out.arcs.push({ cx: rx, cy: ry, r: hh, a0: a - Math.PI / 2, a1: a + Math.PI / 2 });
  } else {
    L(x0, hh, 0, 0);
    L(0, 0, x0, -hh);
    L(x1, hh, lay.W, 0);
    L(lay.W, 0, x1, -hh);
    L(x0, hh, x0, -hh);
    L(x1, hh, x1, -hh);
  }
  return out;
}
