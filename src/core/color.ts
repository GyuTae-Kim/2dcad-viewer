/** AutoCAD 색 번호(ACI) 표와 색 변환 */
import type { CadColor } from './model';

/** ACI 0~255 → 0xRRGGBB. 0(ByBlock)과 256(ByLayer)은 쓰지 않는다. 7은 배경에 따라 흑백이 바뀐다. */
export const ACI_RGB: Uint32Array = (() => {
  const t = new Uint32Array(256);
  const base = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
  for (let i = 0; i < 10; i++) t[i] = base[i]!;
  // 10~249: 색상환 24단계(15°) × 명도 5단계(255·204·153·127·76), 홀수 번호는 명도 쪽으로 절반 섞은 옅은 색
  // (예: 12 = CC0000, 13 = CC6666, 19 = 4C2626 — AutoCAD가 저장한 트루컬러의 ACI 번호와 맞다)
  const levels = [255, 204, 153, 127, 76];
  for (let i = 10; i < 250; i++) {
    const h = Math.floor((i - 10) / 10);
    const k = (i - 10) % 10;
    const v = levels[k >> 1]!;
    const [fr, fg, fb] = hueFractions(h);
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
  // 250~255: 회색 단계
  const greys = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];
  for (let i = 0; i < 6; i++) t[250 + i] = greys[i]!;
  return t;
})();

/** 색상 단계 h(0~23, 15°씩)의 채널 비율. 60°마다 한 채널이 4단계(0, ¼, ½, ¾)로 오르내린다. */
function hueFractions(h: number): [number, number, number] {
  const seg = Math.floor(h / 4);
  const f = (h % 4) / 4;
  switch (seg) {
    case 0:
      return [1, f, 0];
    case 1:
      return [1 - f, 1, 0];
    case 2:
      return [0, 1, f];
    case 3:
      return [0, 1 - f, 1];
    case 4:
      return [f, 0, 1];
    default:
      return [1, 0, 1 - f];
  }
}

/**
 * MULTILEADER·DWG가 쓰는 원시 색 정수(상위 바이트 = 방식) → CadColor.
 * 0xC0 ByLayer, 0xC1 ByBlock, 0xC2 RGB, 0xC3 ACI(하위 바이트), 0xC8 없음.
 */
export function rawColorToCad(raw: number): CadColor {
  const v = raw >>> 0;
  const method = v >>> 24;
  switch (method) {
    case 0xc0:
      return { aci: 256 };
    case 0xc1:
      return { aci: 0 };
    case 0xc2:
      return { aci: 256, rgb: v & 0xffffff };
    case 0xc3:
      return { aci: v & 0xff };
    case 0xc8:
      return { aci: 257 };
    default:
      return { aci: 256 };
  }
}

/** 화면 색: 배경이 어두우면 ACI 7 = 흰색, 밝으면 검은색 */
export function aciToRgb(aci: number, darkBackground: boolean): number {
  if (aci === 7) return darkBackground ? 0xffffff : 0x000000;
  return ACI_RGB[aci & 255] ?? 0xffffff;
}

export function rgbToCss(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

/** RGB와 가장 가까운 ACI(1~255) */
export function nearestAci(rgb: number): number {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  let best = 7;
  let bestD = Infinity;
  for (let i = 1; i < 256; i++) {
    const c = ACI_RGB[i]!;
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
