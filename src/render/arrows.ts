/**
 * 기본 화살촉(치수·지시선). 크기 1, 끝점이 원점, +X 방향을 가리키고 몸통은 -X 쪽이다.
 * 도면에 같은 이름의 블록이 있으면 그 블록을 쓴다.
 */
export interface ArrowShape {
  lines: number[][];
  fills: number[][];
}

const circle = (cx: number, cy: number, r: number, n = 24): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
};

const fan = (ring: number[]): number[] => {
  // 볼록 다각형 → 삼각형
  const out: number[] = [];
  for (let i = 2; i + 3 < ring.length; i += 2) out.push(ring[0]!, ring[1]!, ring[i]!, ring[i + 1]!, ring[i + 2]!, ring[i + 3]!);
  return out;
};

const S = 1 / 6;
const T15 = Math.tan(Math.PI / 12);

const SHAPES: Record<string, ArrowShape> = {
  '': { lines: [], fills: [[0, 0, -1, S, -1, -S]] },
  _CLOSEDFILLED: { lines: [], fills: [[0, 0, -1, S, -1, -S]] },
  _CLOSEDBLANK: { lines: [[0, 0, -1, S, -1, -S, 0, 0]], fills: [] },
  _CLOSED: { lines: [[0, 0, -1, S, -1, -S, 0, 0], [-1, 0, 0, 0]], fills: [] },
  _DOT: { lines: [], fills: [fan(circle(0, 0, 0.25))] },
  _DOTSMALL: { lines: [], fills: [fan(circle(0, 0, 1 / 16))] },
  _SMALL: { lines: [], fills: [fan(circle(0, 0, 1 / 16))] },
  _DOTBLANK: { lines: [circle(0, 0, 0.25)], fills: [] },
  _ORIGIN: { lines: [circle(0, 0, 0.5)], fills: [] },
  _ORIGIN2: { lines: [circle(0, 0, 0.5), circle(0, 0, 0.25)], fills: [] },
  _OPEN: { lines: [[-1, S, 0, 0, -1, -S]], fills: [] },
  _OPEN90: { lines: [[-0.5, 0.5, 0, 0, -0.5, -0.5]], fills: [] },
  _OPEN30: { lines: [[-1, T15, 0, 0, -1, -T15]], fills: [] },
  _OBLIQUE: { lines: [[-0.5, -0.5, 0.5, 0.5]], fills: [] },
  _ARCHTICK: { lines: [], fills: [[-0.5 - 0.05, -0.5 + 0.05, -0.5 + 0.05, -0.5 - 0.05, 0.5 + 0.05, 0.5 - 0.05, -0.5 - 0.05, -0.5 + 0.05, 0.5 + 0.05, 0.5 - 0.05, 0.5 - 0.05, 0.5 + 0.05]] },
  _BOXFILLED: { lines: [], fills: [[-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]] },
  _BOXBLANK: { lines: [[-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5]], fills: [] },
  _DATUMFILLED: { lines: [], fills: [[0, 0.5, 0, -0.5, -1, 0]] },
  _DATUMBLANK: { lines: [[0, 0.5, 0, -0.5, -1, 0, 0, 0.5]], fills: [] },
  _INTEGRAL: {
    lines: [
      (() => {
        const out: number[] = [];
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          out.push(-0.45 + 0.9 * t, Math.sin((t - 0.5) * Math.PI) * 0.45 + Math.sin(t * Math.PI * 2) * 0.1);
        }
        return out;
      })(),
    ],
    fills: [],
  },
  _NONE: { lines: [], fills: [] },
};

export function builtinArrow(name: string): ArrowShape | null {
  const key = name.trim().toUpperCase();
  return SHAPES[key] ?? SHAPES[key.startsWith('_') ? key : '_' + key] ?? null;
}
