/**
 * 배치 꾸미기 계산(MVSETUP·LAYOUTWIZARD): 뷰포트 배열, 뷰포트 만들기·축척·정렬, ISO A 시리즈 도면 틀과 제목 블록.
 * 좌표는 종이 공간(y 위로), 길이는 용지 단위(mm 배치는 mm).
 */
import type { AttribEntity, Entity, LineEntity, LwPolylineEntity, TextEntity, Vec2, ViewportEntity } from '../../core/model';
import { entityDefaults } from '../../core/model';
import { packLw } from '../../core/lwpoly';

/** [minX, minY, maxX, maxY] */
export type Rect = [number, number, number, number];

/** 사각형을 cols × rows로 나눈다(사이 간격 gx·gy). 위 줄부터, 왼쪽에서 오른쪽으로 */
export function viewportGrid(r: Rect, cols: number, rows: number, gx = 0, gy = 0): Rect[] {
  const c = Math.max(1, Math.floor(cols));
  const n = Math.max(1, Math.floor(rows));
  const w = (r[2] - r[0] - gx * (c - 1)) / c;
  const h = (r[3] - r[1] - gy * (n - 1)) / n;
  if (!(w > 0) || !(h > 0)) return [];
  const out: Rect[] = [];
  for (let j = 0; j < n; j++) {
    const y1 = r[3] - j * (h + gy);
    for (let i = 0; i < c; i++) {
      const x0 = r[0] + i * (w + gx);
      out.push([x0, y1 - h, x0 + w, y1]);
    }
  }
  return out;
}

export interface NewViewportOptions {
  handle: string;
  owner?: string;
  id: number;
  /** 보여 줄 모형 범위(없으면 원점 중심) */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 축척(용지 단위 / 모형 단위). 없으면 범위에 맞춘다 */
  scale?: number;
}

/** 사각형(종이 좌표)에 놓는 새 뷰포트(평면 뷰) */
export function newViewport(r: Rect, o: NewViewportOptions): ViewportEntity {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const b = o.bounds;
  const vc = b && b.maxX >= b.minX ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
  let vh = h;
  if (o.scale && o.scale > 0) vh = h / o.scale;
  else if (b && b.maxX > b.minX && w > 0 && h > 0) vh = Math.max(b.maxY - b.minY, ((b.maxX - b.minX) * h) / w) * 1.05;
  return {
    ...entityDefaults(),
    type: 'VIEWPORT',
    handle: o.handle,
    owner: o.owner,
    paperSpace: true,
    center: { x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2, z: 0 },
    width: w,
    height: h,
    status: 2,
    id: o.id,
    viewCenter: vc,
    snapBase: { x: 0, y: 0 },
    snapSpacing: { x: 10, y: 10 },
    gridSpacing: { x: 10, y: 10 },
    viewDirection: { x: 0, y: 0, z: 1 },
    viewTarget: { x: 0, y: 0, z: 0 },
    lensLength: 50,
    frontClip: 0,
    backClip: 0,
    viewHeight: vh > 0 ? vh : h,
    snapAngle: 0,
    twistAngle: 0,
    circleSides: 1000,
    flags: 32864,
    frozenLayers: [],
    renderMode: 0,
    ucsPerViewport: true,
  };
}

/** 뷰포트 축척: 용지 단위 paper개 = 모형 단위 model개가 되는 뷰 높이 */
export function scaledViewHeight(vpHeight: number, paper: number, model: number): number {
  return (vpHeight * model) / paper;
}

/** "1:100" 같은 축척 → 용지/모형 비. 맞춤·틀린 값이면 null */
export function parseScale(s: string): number | null {
  const m = /^\s*([\d.]+)\s*[:=]\s*([\d.]+)\s*$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

/** 모형 점이 종이의 어디에 보이는지(비틀림 없는 뷰포트) */
export function modelToPaper(vp: ViewportEntity, p: Vec2): Vec2 {
  const k = vp.height / vp.viewHeight;
  const rx = vp.viewTarget.x + vp.viewCenter.x;
  const ry = vp.viewTarget.y + vp.viewCenter.y;
  return { x: vp.center.x + (p.x - rx) * k, y: vp.center.y + (p.y - ry) * k };
}

/** 종이 점이 가리키는 모형 점(비틀림 없는 뷰포트) */
export function paperToModel(vp: ViewportEntity, p: Vec2): Vec2 {
  const k = vp.height / vp.viewHeight;
  const rx = vp.viewTarget.x + vp.viewCenter.x;
  const ry = vp.viewTarget.y + vp.viewCenter.y;
  return { x: rx + (p.x - vp.center.x) / k, y: ry + (p.y - vp.center.y) / k };
}

/**
 * MVSETUP 정렬: 뷰포트 vp의 모형 점 m이 종이에서 target과 수평(H, 같은 y)·수직(V, 같은 x)으로 놓이게 하는 새 뷰 중심.
 * 비틀린 뷰포트면 null
 */
export function alignedViewCenter(vp: ViewportEntity, m: Vec2, target: Vec2, mode: 'H' | 'V'): Vec2 | null {
  if (Math.abs(vp.twistAngle || 0) > 1e-9 || !(vp.viewHeight > 0)) return null;
  const k = vp.height / vp.viewHeight;
  const vc = { ...vp.viewCenter };
  if (mode === 'H') vc.y = m.y - (target.y - vp.center.y) / k - vp.viewTarget.y;
  else vc.x = m.x - (target.x - vp.center.x) / k - vp.viewTarget.x;
  return vc;
}

/** 점이 든 뷰포트(꺼진 것·전체 용지 뷰포트 제외) */
export function viewportAtPaper(vps: readonly ViewportEntity[], p: Vec2): ViewportEntity | null {
  for (const v of vps) {
    if (v.id === 1 || v.status === 0) continue;
    if (Math.abs(p.x - v.center.x) <= v.width / 2 && Math.abs(p.y - v.center.y) <= v.height / 2) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ISO A 시리즈 도면 틀(ISO 5457: 철하는 왼쪽 20 mm, 나머지 10 mm)과 제목 블록(ISO 7200 꼴, 폭 180 mm)
// ---------------------------------------------------------------------------

export const ISO_SHEETS: { key: string; w: number; h: number }[] = [
  { key: 'A4', w: 210, h: 297 },
  { key: 'A3', w: 297, h: 420 },
  { key: 'A2', w: 420, h: 594 },
  { key: 'A1', w: 594, h: 841 },
  { key: 'A0', w: 841, h: 1189 },
];

export interface IsoSheet {
  key: string;
  /** 용지 크기(mm, 놓인 방향) */
  w: number;
  h: number;
  /** 테두리(도면 틀) */
  frame: Rect;
  /** 제목 블록 */
  title: Rect;
  /** 뷰포트를 놓을 영역(틀 안, 제목 블록 위) */
  area: Rect;
}

const TB_W = 180;
const TB_H = 36;

/** 용지 키(A0~A4)와 방향 → 틀·제목 블록·도면 영역(원점 = 용지 왼쪽 아래) */
export function isoSheet(key: string, landscape: boolean): IsoSheet | null {
  const s = ISO_SHEETS.find((x) => x.key === key.toUpperCase());
  if (!s) return null;
  const w = landscape ? s.h : s.w;
  const h = landscape ? s.w : s.h;
  const frame: Rect = [20, 10, w - 10, h - 10];
  const tw = Math.min(TB_W, frame[2] - frame[0]);
  const title: Rect = [frame[2] - tw, frame[1], frame[2], frame[1] + TB_H];
  const area: Rect = [frame[0] + 5, title[3] + 5, frame[2] - 5, frame[3] - 5];
  return { key: s.key, w, h, frame, title, area };
}

/** 제목 블록 칸: [이름표, 속성 꼬리표, 기본값 열쇠, 칸 사각형(제목 블록 왼쪽 아래 기준)] */
function titleCells(tw: number): [string, string, 'title' | 'drawn' | 'number' | 'scale' | 'date' | 'sheet', Rect][] {
  const half = TB_H / 2;
  const q = tw / 4;
  return [
    ['제목', 'TITLE', 'title', [0, half, tw - 60, TB_H]],
    ['작성', 'DRAWN', 'drawn', [tw - 60, half, tw, TB_H]],
    ['도면 번호', 'DWGNO', 'number', [0, 0, q, half]],
    ['축척', 'SCALE', 'scale', [q, 0, 2 * q, half]],
    ['날짜', 'DATE', 'date', [2 * q, 0, 3 * q, half]],
    ['용지', 'SHEET', 'sheet', [3 * q, 0, tw, half]],
  ];
}

export interface TitleBlockValues {
  title: string;
  drawn: string;
  number: string;
  scale: string;
  date: string;
  sheet: string;
}

/**
 * 도면 틀과 제목 블록 객체(블록 정의용, 원점 = 용지 왼쪽 아래, 핸들은 비워 둔다).
 * 칸의 값은 속성 정의(ATTDEF)라 넣을 때 속성으로 고칠 수 있다.
 */
export function titleBlockEntities(sheet: IsoSheet, values: TitleBlockValues, opt: { layer?: string; style?: string } = {}): Entity[] {
  const base = { ...entityDefaults(), layer: opt.layer ?? '0' };
  const style = opt.style ?? 'Standard';
  const out: Entity[] = [];
  const rect = (r: Rect, width = 0): LwPolylineEntity => ({
    ...base,
    type: 'LWPOLYLINE',
    ...packLw(
      [
        [r[0], r[1]],
        [r[2], r[1]],
        [r[2], r[3]],
        [r[0], r[3]],
      ].map(([x, y]) => ({ x: x!, y: y!, bulge: 0, startWidth: width, endWidth: width })),
    ),
    closed: true,
    plinegen: false,
    constantWidth: width,
    elevation: 0,
  });
  const line = (x0: number, y0: number, x1: number, y1: number): LineEntity => ({ ...base, type: 'LINE', start: { x: x0, y: y0, z: 0 }, end: { x: x1, y: y1, z: 0 } });
  const text = (x: number, y: number, height: number, s: string): TextEntity => ({ ...base, type: 'TEXT', insert: { x, y, z: 0 }, height, text: s, rotation: 0, widthFactor: 1, oblique: 0, style, generation: 0, halign: 0, valign: 0 });
  // 틀(굵은 선)
  out.push(rect(sheet.frame, 0.7));
  // 중심 표시: 용지 가장자리에서 틀까지
  const [fx0, fy0, fx1, fy1] = sheet.frame;
  const mx = sheet.w / 2;
  const my = sheet.h / 2;
  out.push(line(mx, 0, mx, fy0), line(mx, fy1, mx, sheet.h), line(0, my, fx0, my), line(fx1, my, sheet.w, my));
  // 제목 블록
  const t = sheet.title;
  const tw = t[2] - t[0];
  out.push(rect(t, 0.5));
  out.push(line(t[0], t[1] + TB_H / 2, t[2], t[1] + TB_H / 2));
  for (const [label, tag, key, c] of titleCells(tw)) {
    if (c[0] > 0) out.push(line(t[0] + c[0], t[1] + c[1], t[0] + c[0], t[1] + c[3]));
    out.push(text(t[0] + c[0] + 1.5, t[1] + c[3] - 3.5, 2, label));
    const big = key === 'title';
    const att: AttribEntity = {
      ...text(t[0] + c[0] + 2, t[1] + c[1] + (big ? 4 : 3), big ? 5 : 3, values[key]),
      type: 'ATTDEF',
      tag,
      prompt: label,
      attFlags: 0,
    };
    out.push(att);
  }
  return out;
}

/** MVSETUP(모형 공간): 축척한 용지 테두리 [x, y, …](원점 왼쪽 아래) */
export function modelBorder(width: number, height: number, scale: number): number[] {
  const w = width * scale;
  const h = height * scale;
  return [0, 0, w, 0, w, h, 0, h];
}
