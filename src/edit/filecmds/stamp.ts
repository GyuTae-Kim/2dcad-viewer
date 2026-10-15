/**
 * 플롯 스탬프(PLOTSTAMP): 출력한 용지 구석에 도면 이름·배치·날짜·장치·용지·축척·사용자 정의 필드를 적는다.
 * 화면에는 그리지 않고 PDF·SVG 출력에만 넣는다. 여기서는 문자열, 위치, 글자 모양(선분·삼각형, 용지 mm, y 아래로)을 만든다.
 */
import type { GlyphGeom } from '../../text/fonts';

export type StampCorner = 'BL' | 'TL' | 'TR' | 'BR';

export interface PlotStampSettings {
  /** 플롯할 때 스탬프를 넣는다 */
  on: boolean;
  drawing: boolean;
  layout: boolean;
  date: boolean;
  login: boolean;
  device: boolean;
  paper: boolean;
  scale: boolean;
  /** 사용자 정의 필드 두 개(빈 문자열이면 넣지 않는다) */
  custom1: string;
  custom2: string;
  /** 로그인 이름(브라우저는 알 수 없어 직접 넣는다) */
  loginName: string;
  location: StampCorner;
  /** 가로(H) 또는 세로(V, 아래에서 위로 읽는다) */
  orientation: 'H' | 'V';
  /** 간격띄우기(mm) */
  offsetX: number;
  offsetY: number;
  /** 인쇄 가능 영역 기준 또는 용지 경계 기준 */
  relative: 'printable' | 'border';
  /** 문자 높이(mm) */
  height: number;
  /** 한 줄로 */
  singleLine: boolean;
}

export const DEFAULT_STAMP: PlotStampSettings = {
  on: false,
  drawing: true,
  layout: true,
  date: true,
  login: false,
  device: true,
  paper: false,
  scale: false,
  custom1: '',
  custom2: '',
  loginName: '',
  location: 'BL',
  orientation: 'H',
  offsetX: 2.5,
  offsetY: 2.5,
  relative: 'printable',
  height: 2.5,
  singleLine: true,
};

/** 저장해 둔 값(모르는 키·틀린 값은 기본값) */
export function normalizeStamp(raw: unknown): PlotStampSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_STAMP };
  for (const k of Object.keys(DEFAULT_STAMP) as (keyof PlotStampSettings)[]) {
    const v = o[k];
    const d = DEFAULT_STAMP[k];
    if (typeof v === typeof d && (typeof v !== 'number' || Number.isFinite(v))) (out as Record<string, unknown>)[k] = v;
  }
  if (!['BL', 'TL', 'TR', 'BR'].includes(out.location)) out.location = 'BL';
  if (out.orientation !== 'V') out.orientation = 'H';
  if (out.relative !== 'border') out.relative = 'printable';
  if (!(out.height > 0)) out.height = DEFAULT_STAMP.height;
  return out;
}

export interface PlotStampInfo {
  drawing: string;
  layout: string;
  date: Date;
  device: string;
  paper: string;
  scale: string;
}

const two = (n: number) => String(n).padStart(2, '0');

/** 날짜와 시간(YYYY-MM-DD HH:MM:SS) */
export function stampDate(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** 스탬프 문자열(한 줄이면 하나, 아니면 두 줄: 도면·배치·날짜·로그인 / 장치·용지·축척·사용자 필드) */
export function plotStampLines(s: PlotStampSettings, info: PlotStampInfo): string[] {
  const a: string[] = [];
  const b: string[] = [];
  if (s.drawing && info.drawing) a.push(info.drawing);
  if (s.layout && info.layout) a.push(info.layout);
  if (s.date) a.push(stampDate(info.date));
  if (s.login && s.loginName.trim()) a.push(s.loginName.trim());
  if (s.device && info.device) b.push(info.device);
  if (s.paper && info.paper) b.push(info.paper);
  if (s.scale && info.scale) b.push(info.scale);
  for (const c of [s.custom1, s.custom2]) if (c.trim()) b.push(c.trim());
  if (s.singleLine) {
    const all = [...a, ...b];
    return all.length ? [all.join(', ')] : [];
  }
  return [a.join(', '), b.join(', ')].filter((x) => x);
}

export type GlyphSource = (code: number) => GlyphGeom | null;

/** 줄 폭(문자 높이 단위) */
export function lineAdvance(text: string, glyph: GlyphSource): number {
  let w = 0;
  for (const ch of text) w += glyph(ch.codePointAt(0)!)?.advance ?? 0.6;
  return w;
}

export interface StampGeometry {
  /** 선분 [x0, y0, x1, y1, …](용지 mm, y 아래로) */
  segs: number[];
  /** 삼각형 [x0, y0, x1, y1, x2, y2, …] */
  tris: number[];
  /** 차지한 사각형 [왼쪽, 위, 오른쪽, 아래] */
  box: [number, number, number, number];
}

/** 줄 간격(문자 높이의 배수) */
const LINE_STEP = 1.6;

/**
 * 스탬프 글자 모양. paper = 용지 크기(mm), inset = 인쇄 가능 영역 여백 [왼쪽, 위, 오른쪽, 아래](mm).
 * 가로는 왼쪽에서 오른쪽, 세로는 아래에서 위로 쓰고, 고른 구석에서 간격띄우기만큼 안쪽에 둔다.
 */
export function stampGeometry(s: PlotStampSettings, lines: readonly string[], paper: { w: number; h: number }, inset: readonly [number, number, number, number], glyph: GlyphSource): StampGeometry {
  const H = s.height;
  const n = lines.length;
  const widths = lines.map((t) => lineAdvance(t, glyph) * H);
  const long = Math.max(0, ...widths);
  const thick = n ? H * (1 + (n - 1) * LINE_STEP) + H * 0.35 : 0;
  // 상자 크기(용지 방향)
  const bw = s.orientation === 'H' ? long : thick;
  const bh = s.orientation === 'H' ? thick : long;
  const [il, it, ir, ib] = s.relative === 'printable' ? inset : [0, 0, 0, 0];
  const left = s.location === 'BL' || s.location === 'TL' ? il + s.offsetX : paper.w - ir - s.offsetX - bw;
  const top = s.location === 'TL' || s.location === 'TR' ? it + s.offsetY : paper.h - ib - s.offsetY - bh;
  const segs: number[] = [];
  const tris: number[] = [];
  lines.forEach((text, i) => {
    // 글자 좌표(문자 높이 1, y 위로) → 용지: 원점 + gx·H·d + gy·H·u
    let ox: number;
    let oy: number;
    let d: [number, number];
    let u: [number, number];
    if (s.orientation === 'H') {
      ox = left;
      oy = top + H + i * H * LINE_STEP;
      d = [1, 0];
      u = [0, -1];
    } else {
      ox = left + H + i * H * LINE_STEP;
      oy = top + bh;
      d = [0, -1];
      u = [-1, 0];
    }
    const P = (gx: number, gy: number): [number, number] => [ox + (gx * d[0] + gy * u[0]) * H, oy + (gx * d[1] + gy * u[1]) * H];
    let pen = 0;
    for (const ch of text) {
      const g = glyph(ch.codePointAt(0)!);
      if (g?.segs) {
        const v = g.segs;
        for (let k = 0; k + 3 < v.length; k += 4) {
          const a = P(pen + v[k]!, v[k + 1]!);
          const b = P(pen + v[k + 2]!, v[k + 3]!);
          segs.push(a[0], a[1], b[0], b[1]);
        }
      } else if (g?.tris) {
        const v = g.tris;
        for (let k = 0; k + 1 < v.length; k += 2) {
          const a = P(pen + v[k]!, v[k + 1]!);
          tris.push(a[0], a[1]);
        }
      }
      pen += g?.advance ?? 0.6;
    }
  });
  return { segs, tris, box: [left, top, left + bw, top + bh] };
}
