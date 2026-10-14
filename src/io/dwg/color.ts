/** DWG 색(CMC·ENC) → CadColor */
import type { CadColor } from '../../core/model';
import type { DwgColor } from './bitstream';

/** 표 레코드 색(CMC). R2004+는 RGB 값의 상위 바이트가 방식이다. */
export function cmcToCad(c: DwgColor): CadColor {
  if (c.rgb === undefined) return { aci: c.index };
  const v = c.rgb >>> 0;
  const method = v >>> 24;
  let out: CadColor;
  switch (method) {
    case 0xc0:
      out = { aci: 256 };
      break;
    case 0xc1:
      out = { aci: 0 };
      break;
    case 0xc2:
      out = { aci: c.index > 0 && c.index < 256 ? c.index : nearestAci(v & 0xffffff), rgb: v & 0xffffff };
      break;
    case 0xc3:
      out = { aci: v & 0xff };
      break;
    case 0xc8:
      out = { aci: 257 };
      break;
    default:
      out = { aci: c.index };
      break;
  }
  if (c.name) out.name = c.book ? `${c.book}$${c.name}` : c.name;
  return out;
}

/** 도형 색(ENC) */
export function encToCad(c: DwgColor): CadColor {
  if (c.rgb === undefined) return { aci: c.index };
  const v = c.rgb >>> 0;
  const method = v >>> 24;
  switch (method) {
    case 0xc2:
      return { aci: c.index > 0 && c.index < 256 ? c.index : nearestAci(v & 0xffffff), rgb: v & 0xffffff };
    case 0xc3:
      return { aci: v & 0xff };
    case 0xc0:
      return { aci: 256 };
    case 0xc1:
      return { aci: 0 };
    default:
      return { aci: c.index };
  }
}

/**
 * AutoCAD ACI 팔레트(1~255). 10~249는 15°씩 24색상 × 명도 5단계(255·204·153·127·76),
 * 홀수 번호는 명도 쪽으로 절반 섞은 색이다. 250~255는 회색.
 * (core/color.ts의 표와 명도 단계가 달라 DWG 쪽은 이 표로 가장 가까운 ACI를 구한다)
 */
const PALETTE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  const base = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
  for (let i = 0; i < 10; i++) t[i] = base[i];
  const levels = [255, 204, 153, 127, 76];
  for (let i = 10; i < 250; i++) {
    const h = Math.floor((i - 10) / 10);
    const k = (i - 10) % 10;
    const v = levels[k >> 1];
    const seg = Math.floor(h / 4);
    const f = (h % 4) / 4;
    const fr = [1, 1 - f, 0, 0, f, 1][seg];
    const fg = [f, 1, 1, 1 - f, 0, 0][seg];
    const fb = [0, 0, f, 1, 1, 1 - f][seg];
    let r = fr * v;
    let g = fg * v;
    let b = fb * v;
    if (k & 1) {
      r += (v - r) * 0.5;
      g += (v - g) * 0.5;
      b += (v - b) * 0.5;
    }
    t[i] = (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b);
  }
  const greys = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];
  for (let i = 0; i < 6; i++) t[250 + i] = greys[i];
  return t;
})();

/** RGB와 가장 가까운 ACI(1~255) */
export function nearestAci(rgb: number): number {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  let best = 7;
  let bestD = Infinity;
  for (let i = 1; i < 256; i++) {
    const c = PALETTE[i];
    const dr = ((c >> 16) & 255) - r;
    const dg = ((c >> 8) & 255) - g;
    const db = (c & 255) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
