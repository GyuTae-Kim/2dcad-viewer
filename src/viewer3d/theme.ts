/**
 * 뷰어 색: 밝은·어두운 테마. 호스트 요소의 CSS 변수(--v3d-*)가 있으면 그 값을 쓴다.
 */
import type { Rgba } from './types';

export interface Viewer3dTheme {
  /** 배경 */
  background: string;
  /** 큰 칸 격자 */
  grid: string;
  /** 작은 칸 격자 */
  gridMinor: string;
  /** 격자 위 X축·Y축 선 */
  axisX: string;
  axisY: string;
  axisZ: string;
  /** 음영 면 위 윤곽선 */
  edge: string;
  /** 덧그림 글자(측정 등) */
  text: string;
  /** 덧그림 글자 배경 */
  textBg: string;
  /** 강조(고른 것) */
  highlight: string;
  /** 측정선 */
  measure: string;
  /** 공구 표시 */
  marker: string;
  cubeFace: string;
  cubeEdge: string;
  cubeText: string;
  cubeHover: string;
}

export const DARK_THEME: Viewer3dTheme = {
  background: '#212830',
  grid: 'rgba(255,255,255,0.16)',
  gridMinor: 'rgba(255,255,255,0.06)',
  axisX: 'rgba(235,95,95,0.75)',
  axisY: 'rgba(110,205,110,0.75)',
  axisZ: 'rgba(90,150,255,0.85)',
  edge: 'rgba(10,12,16,0.75)',
  text: '#e8ebf0',
  textBg: 'rgba(25,30,38,0.85)',
  highlight: '#ffb44c',
  measure: '#ffd24c',
  marker: '#ff8a3d',
  cubeFace: '#4a5564',
  cubeEdge: '#9aa6b5',
  cubeText: '#e8ebf0',
  cubeHover: 'rgba(61,149,240,0.75)',
};

export const LIGHT_THEME: Viewer3dTheme = {
  background: '#f4f5f7',
  grid: 'rgba(0,0,0,0.18)',
  gridMinor: 'rgba(0,0,0,0.065)',
  axisX: 'rgba(205,50,50,0.75)',
  axisY: 'rgba(40,150,40,0.75)',
  axisZ: 'rgba(40,90,220,0.85)',
  edge: 'rgba(20,24,30,0.7)',
  text: '#1d2530',
  textBg: 'rgba(255,255,255,0.88)',
  highlight: '#e07800',
  measure: '#c25e00',
  marker: '#e0602a',
  cubeFace: '#e2e6ec',
  cubeEdge: '#8a95a3',
  cubeText: '#1d2530',
  cubeHover: 'rgba(31,111,209,0.6)',
};

/** CSS 변수 이름(호스트 요소나 조상에 두면 덮어쓴다) */
export const THEME_CSS_VARS: Record<keyof Viewer3dTheme, string> = {
  background: '--v3d-bg',
  grid: '--v3d-grid',
  gridMinor: '--v3d-grid-minor',
  axisX: '--v3d-axis-x',
  axisY: '--v3d-axis-y',
  axisZ: '--v3d-axis-z',
  edge: '--v3d-edge',
  text: '--v3d-fg',
  textBg: '--v3d-fg-bg',
  highlight: '--v3d-highlight',
  measure: '--v3d-measure',
  marker: '--v3d-marker',
  cubeFace: '--v3d-cube-face',
  cubeEdge: '--v3d-cube-edge',
  cubeText: '--v3d-cube-fg',
  cubeHover: '--v3d-cube-hover',
};

/**
 * CSS 색 → RGBA(0~1). #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba()(쉼표·빈칸·슬래시) 를 읽는다.
 * 못 읽으면 null(브라우저에서는 부르는 쪽이 캔버스로 정규화한 뒤 다시 읽는다).
 */
export function parseColor(s: string): Rgba | null {
  const t = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16) / 255);
      return [v[0]!, v[1]!, v[2]!, v[3] ?? 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v: number[] = [];
      for (let i = 0; i < h.length; i += 2) v.push(parseInt(h.slice(i, i + 2), 16) / 255);
      return [v[0]!, v[1]!, v[2]!, v[3] ?? 1];
    }
    return null;
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string): number => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const r = [ch(parts[0]!) / 255, ch(parts[1]!) / 255, ch(parts[2]!) / 255, a];
    if (r.some((x) => !Number.isFinite(x))) return null;
    return [r[0]!, r[1]!, r[2]!, r[3]!];
  }
  return null;
}
