/**
 * 해치 무늬 정의(직접 설계).
 *
 * 줄 하나 = .pat 형식의 선 묶음: 각도(도), 원점(x, y), 이웃 선까지의 이동(dx = 선 방향, dy = 선에 수직), 대시.
 * 이름은 널리 쓰이는 관례를 따르지만, 정의 값은 겉모습을 보고 여기서 새로 만든 것이다.
 * 대부분은 "격자 + 무늬 조각(motif)" 방식으로 만든다: 격자 한 칸에 그린 선분들을 격자 방향의 선 묶음으로 바꾼다.
 *
 * 단위: ISO 무늬는 mm(펜 폭 1.0 mm 기준), 나머지는 인치. 미터법 도면에서는 인치 무늬를 25.4배 한다.
 */

export interface PatternLineDef {
  /** 도 */
  angle: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  dashes: number[];
}

export interface PatternDef {
  name: string;
  description: string;
  kind: 'ansi' | 'iso' | 'other';
  lines: PatternLineDef[];
}

type Pt = readonly [number, number];
type Seg = readonly [number, number, number, number];

const DEG = Math.PI / 180;

function fam(angle: number, x: number, y: number, dx: number, dy: number, ...dashes: number[]): PatternLineDef {
  return { angle, x, y, dx, dy, dashes };
}

/** 각도 angle인 선을 수직 방향으로 d만큼 옮긴 원점 */
function perp(angle: number, d: number): [number, number] {
  return [-Math.sin(angle * DEG) * d, Math.cos(angle * DEG) * d];
}

function egcd(a: number, b: number): [number, number, number] {
  if (b === 0) return [a, 1, 0];
  const [g, x, y] = egcd(b, a % b);
  return [g, y, x - Math.floor(a / b) * y];
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * 격자(A, B)에 놓인 선분들 → 선 묶음. 선분 방향은 격자 방향(작은 정수 mA + nB)이어야 한다.
 * 선분 하나가 묶음 하나: 대시 주기 = |mA + nB|, 이웃 선 = 그와 짝을 이루는 격자 벡터.
 */
function motif(A: Pt, B: Pt, segs: readonly Seg[]): PatternLineDef[] {
  const det = A[0] * B[1] - A[1] * B[0];
  const out: PatternLineDef[] = [];
  for (const [x0, y0, x1, y1] of segs) {
    const dX = x1 - x0;
    const dY = y1 - y0;
    const L = Math.hypot(dX, dY);
    let m = 1;
    let n = 0;
    if (L > 1e-12) {
      // 격자 좌표의 방향
      const c1 = (dX * B[1] - dY * B[0]) / det;
      const c2 = (A[0] * dY - A[1] * dX) / det;
      let best: [number, number] | null = null;
      let bestLen = Infinity;
      const tol = 1e-7 * (Math.abs(c1) + Math.abs(c2));
      for (let i = -8; i <= 8; i++)
        for (let j = -8; j <= 8; j++) {
          if ((i === 0 && j === 0) || gcd(i, j) !== 1) continue;
          if (Math.abs(i * c2 - j * c1) > tol || i * c1 + j * c2 <= 0) continue;
          const len = Math.hypot(i * A[0] + j * B[0], i * A[1] + j * B[1]);
          if (len < bestLen) {
            bestLen = len;
            best = [i, j];
          }
        }
      if (!best) throw new Error(`무늬 선분 방향이 격자 방향이 아님: ${[x0, y0, x1, y1].join(',')}`);
      [m, n] = best;
    }
    const vx = m * A[0] + n * B[0];
    const vy = m * A[1] + n * B[1];
    const P = Math.hypot(vx, vy);
    const ux = vx / P;
    const uy = vy / P;
    // m·q − n·p = 1 인 (p, q): 격자 기저 짝
    const [g, s, t] = egcd(Math.abs(m), Math.abs(n));
    const qq = (s * Math.sign(m || 1)) / g;
    const pp = (-t * Math.sign(n || 1)) / g;
    let wx = pp * A[0] + qq * B[0];
    let wy = pp * A[1] + qq * B[1];
    let dy = -wx * uy + wy * ux;
    if (dy < 0) {
      wx = -wx;
      wy = -wy;
      dy = -dy;
    }
    let dx = wx * ux + wy * uy;
    dx -= Math.floor(dx / P + 1e-9) * P;
    const dashes = L < 1e-12 ? [0, -P] : L >= P - 1e-9 ? [] : [L, -(P - L)];
    out.push({ angle: Math.atan2(uy, ux) / DEG, x: x0, y: y0, dx: clean(dx), dy: clean(dy), dashes: dashes.map(clean) });
  }
  return out;
}

/** 격자 좌표(u, v)/den → 평면 좌표 */
function lat(A: Pt, B: Pt, den: number, segs: readonly Seg[]): Seg[] {
  const f = (u: number, v: number): [number, number] => [(u * A[0] + v * B[0]) / den, (u * A[1] + v * B[1]) / den];
  return segs.map(([a, b, c, d]) => [...f(a, b), ...f(c, d)] as const);
}

/** 닫힌 다각형 → 선분 */
function ring(pts: readonly Pt[], scale = 1): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    out.push([a[0] * scale, a[1] * scale, b[0] * scale, b[1] * scale]);
  }
  return out;
}

function rotate(lines: PatternLineDef[], deg: number): PatternLineDef[] {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return lines.map((l) => ({ ...l, angle: l.angle + deg, x: clean(l.x * c - l.y * s), y: clean(l.x * s + l.y * c) }));
}

function scale(lines: PatternLineDef[], k: number): PatternLineDef[] {
  return lines.map((l) => ({ ...l, x: l.x * k, y: l.y * k, dx: l.dx * k, dy: l.dy * k, dashes: l.dashes.map((d) => d * k) }));
}

function clean(v: number): number {
  const r = Math.round(v * 1e9) / 1e9;
  return Math.abs(r - v) < 1e-12 ? r : v;
}

const SQ3 = Math.sqrt(3);

/** 평평한 위쪽 육각 타일(변 s): 육각형마다 세 변만 그린다 */
function hexTiling(s: number): PatternLineDef[] {
  const h = (s * SQ3) / 2;
  return motif([1.5 * s, h], [0, 2 * h], [
    [s, 0, s / 2, h],
    [s / 2, h, -s / 2, h],
    [-s / 2, h, -s, 0],
  ]);
}

/** 정삼각형 격자(간격 a) */
function triLattice(a: number): [Pt, Pt] {
  return [
    [a, 0],
    [a / 2, (a * SQ3) / 2],
  ];
}

function iso(code: string, title: string, dashes: number[]): PatternDef {
  return { name: `ISO${code}W100`, description: `ISO ${title}`, kind: 'iso', lines: [fam(0, 0, 0, 0, 5, ...dashes)] };
}

// ISO 128 선 요소(펜 폭 1 mm): 대시 12, 긴 대시 24, 짧은 대시 6, 틈 3, 넓은 틈 18, 점 0.5
const D = 12;
const LD = 24;
const SD = 6;
const G = 3;
const DT = 0.5;

const [TA, TB] = triLattice(0.25);
const [SA, SB] = triLattice(0.3);

export const PATTERNS: PatternDef[] = [
  { name: 'SOLID', description: '단색 채우기', kind: 'other', lines: [] },

  // --- ANSI 단면 무늬(45° 계열) ---
  { name: 'ANSI31', description: 'ANSI 철, 벽돌, 석조', kind: 'ansi', lines: [fam(45, 0, 0, 0, 0.125)] },
  {
    name: 'ANSI32',
    description: 'ANSI 강철',
    kind: 'ansi',
    lines: [fam(45, 0, 0, 0, 0.375), fam(45, ...perp(45, 0.0625), 0, 0.375)],
  },
  {
    name: 'ANSI33',
    description: 'ANSI 청동, 황동, 구리',
    kind: 'ansi',
    lines: [fam(45, 0, 0, 0, 0.25), fam(45, ...perp(45, 0.125), 0.0625, 0.25, 0.125, -0.0625)],
  },
  {
    name: 'ANSI34',
    description: 'ANSI 플라스틱, 고무',
    kind: 'ansi',
    lines: [0, 0.0625, 0.125, 0.1875].map((d) => fam(45, ...perp(45, d), 0, 0.75)),
  },
  {
    name: 'ANSI35',
    description: 'ANSI 내화 벽돌, 내화재',
    kind: 'ansi',
    lines: [fam(45, 0, 0, 0, 0.25), fam(45, ...perp(45, 0.125), 0.125, 0.25, 0.3125, -0.0625, 0, -0.0625)],
  },
  {
    name: 'ANSI36',
    description: 'ANSI 대리석, 슬레이트, 유리',
    kind: 'ansi',
    lines: [fam(45, 0, 0, 0.1875, 0.125, 0.3125, -0.0625, 0, -0.0625)],
  },
  {
    name: 'ANSI37',
    description: 'ANSI 납, 아연, 마그네슘, 차음·단열재',
    kind: 'ansi',
    lines: [fam(45, 0, 0, 0, 0.125), fam(135, 0, 0, 0, 0.125)],
  },
  {
    name: 'ANSI38',
    description: 'ANSI 알루미늄',
    kind: 'ansi',
    lines: [fam(45, 0, 0, 0, 0.125), fam(135, 0, 0, 0.25, 0.125, 0.25, -0.5)],
  },

  // --- ISO 128 선 종류 무늬(가로선 5 mm 간격) ---
  iso('02', '파선', [D, -G]),
  iso('03', '간격 넓은 파선', [D, -18]),
  iso('04', '긴 대시 점선', [LD, -G, DT, -G]),
  iso('05', '긴 대시 이점선', [LD, -G, DT, -G, DT, -G]),
  iso('06', '긴 대시 삼점선', [LD, -G, DT, -G, DT, -G, DT, -G]),
  iso('07', '점선', [DT, -G]),
  iso('08', '긴 대시 짧은 대시', [LD, -G, SD, -G]),
  iso('09', '긴 대시 짧은 대시 둘', [LD, -G, SD, -G, SD, -G]),
  iso('10', '대시 점선', [D, -G, DT, -G]),
  iso('11', '대시 둘 점선', [D, -G, D, -G, DT, -G]),
  iso('12', '대시 이점선', [D, -G, DT, -G, DT, -G]),
  iso('13', '대시 둘 이점선', [D, -G, D, -G, DT, -G, DT, -G]),
  iso('14', '대시 삼점선', [D, -G, DT, -G, DT, -G, DT, -G]),
  iso('15', '대시 둘 삼점선', [D, -G, D, -G, DT, -G, DT, -G, DT, -G]),

  // --- 건축(AR-, 실제 크기 인치) ---
  {
    name: 'AR-B816',
    description: '8x16 블록 입면, 줄눈 엇갈림',
    kind: 'other',
    lines: motif([16, 0], [8, 8], [
      [0, 0, 16, 0],
      [0, 0, 0, 8],
    ]),
  },
  {
    name: 'AR-B816C',
    description: '8x16 블록 입면, 줄눈 포함',
    kind: 'other',
    lines: motif([16, 0], [8, 8], [
      [0, 0, 16, 0],
      [0, 0.375, 16, 0.375],
      [0, 0.375, 0, 8],
      [-0.375, 0.375, -0.375, 8],
    ]),
  },
  {
    name: 'AR-B88',
    description: '8x8 블록 입면, 줄눈 엇갈림',
    kind: 'other',
    lines: motif([8, 0], [4, 8], [
      [0, 0, 8, 0],
      [0, 0, 0, 8],
    ]),
  },
  {
    name: 'AR-BRELM',
    description: '영국식 쌓기 벽돌, 줄눈 포함',
    kind: 'other',
    lines: motif([8, 0], [0, 16 / 3], [
      [0, 0, 8, 0],
      [0, 0.375, 8, 0.375],
      [0, 8 / 3, 8, 8 / 3],
      [0, 8 / 3 + 0.375, 8, 8 / 3 + 0.375],
      [0, 0.375, 0, 8 / 3],
      [0.375, 0.375, 0.375, 8 / 3],
      [2, 8 / 3 + 0.375, 2, 16 / 3],
      [2.375, 8 / 3 + 0.375, 2.375, 16 / 3],
      [6, 8 / 3 + 0.375, 6, 16 / 3],
      [6.375, 8 / 3 + 0.375, 6.375, 16 / 3],
    ]),
  },
  {
    name: 'AR-BRSTD',
    description: '표준 벽돌 입면(8 x 2-2/3)',
    kind: 'other',
    lines: motif([8, 0], [4, 8 / 3], [
      [0, 0, 8, 0],
      [0, 0, 0, 8 / 3],
    ]),
  },
  {
    name: 'AR-CONC',
    description: '콘크리트(골재)',
    kind: 'other',
    lines: (() => {
      const A: Pt = [1.5, 0];
      const B: Pt = [0.55, 1.35];
      return motif(
        A,
        B,
        lat(A, B, 12, [
          ...ring([
            [2, 2],
            [5, 2],
            [3, 5],
          ]).map((s) => s as Seg),
          ...ring([
            [7, 6],
            [9, 9],
            [6, 9],
          ]),
          [8, 1, 10, 2],
          [1, 8, 2, 11],
          [10, 5, 11, 7],
          [5, 8, 5, 8],
          [10, 4, 10, 4],
          [11, 10, 11, 10],
          [3, 10, 3, 10],
          [1, 1, 1, 1],
        ]),
      );
    })(),
  },
  {
    name: 'AR-HBONE',
    description: '헤링본 벽돌 깔기',
    kind: 'other',
    // 2:1 벽돌 헤링본: 가로줄 y = n에서 [n−1, n+2], 세로줄 x = n에서 [n, n+3] (주기 4)
    lines: rotate(
      scale(
        motif([4, 0], [1, 1], [
          [-1, 0, 2, 0],
          [0, 0, 0, 3],
        ]),
        4,
      ),
      45,
    ),
  },
  {
    name: 'AR-PARQ1',
    description: '쪽매 마루(12인치, 2인치 쪽)',
    kind: 'other',
    lines: motif([24, 0], [12, 12], [
      [0, 0, 24, 0],
      [0, 0, 0, 12],
      [12, 0, 12, 12],
      ...[2, 4, 6, 8, 10].map((k) => [0, k, 12, k] as const),
      ...[2, 4, 6, 8, 10].map((k) => [12 + k, 0, 12 + k, 12] as const),
    ]),
  },
  {
    name: 'AR-RROOF',
    description: '지붕 널(가로 줄)',
    kind: 'other',
    lines: [fam(0, 0, 0, 5.5, 6.75, 26, -2.5, 11, -1.5), fam(0, 2.5, 2.25, -8, 6.75, 9, -1, 18, -3), fam(0, 6, 4.5, 13, 6.75, 14, -2, 6, -1.25)],
  },
  {
    name: 'AR-SAND',
    description: '모래, 회반죽(점)',
    kind: 'other',
    lines: (() => {
      const A: Pt = [0.5, 0];
      const B: Pt = [0.2, 0.45];
      return motif(
        A,
        B,
        lat(A, B, 12, [
          [1, 2, 1, 2],
          [4, 7, 4, 7],
          [7, 3, 7, 3],
          [9, 9, 9, 9],
          [10, 1, 10, 1],
          [2, 10, 2, 10],
          [6, 5, 6, 5],
          [11, 6, 11, 6],
          [5, 11, 5, 11],
          [8, 0, 8, 0],
        ]),
      );
    })(),
  },

  // --- 기타 ---
  {
    name: 'ANGLE',
    description: 'ㄱ형강',
    kind: 'other',
    lines: motif([0.3125, 0], [0, 0.3125], [
      [0, 0, 0.1875, 0],
      [0, 0, 0, 0.1875],
    ]),
  },
  {
    name: 'BOX',
    description: '상자형 강재',
    kind: 'other',
    lines: motif([0.5, 0], [0, 0.5], [
      ...ring([
        [0, 0],
        [0.375, 0],
        [0.375, 0.375],
        [0, 0.375],
      ]),
      ...ring([
        [0.125, 0.125],
        [0.25, 0.125],
        [0.25, 0.25],
        [0.125, 0.25],
      ]),
    ]),
  },
  {
    name: 'BRASS',
    description: '황동',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.25), fam(0, 0, 0.125, 0.0625, 0.25, 0.125, -0.0625)],
  },
  {
    name: 'BRICK',
    description: '벽돌, 석조(엇갈림 쌓기)',
    kind: 'other',
    lines: motif([0.5, 0], [0.25, 0.25], [
      [0, 0, 0.5, 0],
      [0, 0, 0, 0.25],
    ]),
  },
  {
    name: 'BRSTONE',
    description: '벽돌과 석재',
    kind: 'other',
    lines: motif([0.5, 0], [0.25, 0.25], [
      [0, 0, 0.5, 0],
      [0, 0, 0, 0.25],
      [0.3, 0.04, 0.46, 0.2],
      [0.34, 0.04, 0.46, 0.16],
    ]),
  },
  {
    name: 'CLAY',
    description: '점토',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.1875), fam(0, 0, 0.03125, 0, 0.1875), fam(0, 0, 0.0625, 0, 0.1875), fam(0, 0, 0.125, 0.0625, 0.1875, 0.1875, -0.125)],
  },
  {
    name: 'CORK',
    description: '코르크',
    kind: 'other',
    lines: [
      fam(0, 0, 0, 0, 0.125),
      ...motif([0.25, 0], [0.125, 0.125], [
        [0.09375, 0.015625, 0.03125, 0.078125],
        [0.15625, 0.015625, 0.09375, 0.078125],
      ]),
    ],
  },
  {
    name: 'CROSS',
    description: '십자 표시',
    kind: 'other',
    lines: motif([0.25, 0], [0.125, 0.25], [
      [-0.0625, 0, 0.0625, 0],
      [0, -0.0625, 0, 0.0625],
    ]),
  },
  { name: 'DASH', description: '파선', kind: 'other', lines: [fam(0, 0, 0, 0.0625, 0.125, 0.125, -0.125)] },
  {
    name: 'DOLMIT',
    description: '백운석 암반',
    kind: 'other',
    lines: [
      fam(0, 0, 0, 0, 0.25),
      ...motif([0.5, 0], [0.25, 0.25], [
        [0.0625, 0.0625, 0.1875, 0.1875],
        [0.3125, 0.1875, 0.4375, 0.0625],
      ]),
    ],
  },
  { name: 'DOTS', description: '점', kind: 'other', lines: [fam(0, 0, 0, 0.03125, 0.0625, 0, -0.0625)] },
  {
    name: 'EARTH',
    description: '흙',
    kind: 'other',
    lines: motif([0.5, 0], [0, 0.5], [
      [0, 0.0625, 0.25, 0.0625],
      [0, 0.125, 0.25, 0.125],
      [0, 0.1875, 0.25, 0.1875],
      [0.3125, 0.25, 0.3125, 0.5],
      [0.375, 0.25, 0.375, 0.5],
      [0.4375, 0.25, 0.4375, 0.5],
    ]),
  },
  {
    name: 'FLEX',
    description: '유연 재료',
    kind: 'other',
    lines: [
      fam(0, 0, 0, 0, 0.25, 0.25, -0.25),
      ...motif([0.5, 0], [0, 0.25], [
        [0.25, 0, 0.3125, 0.0625],
        [0.3125, 0.0625, 0.4375, -0.0625],
        [0.4375, -0.0625, 0.5, 0],
      ]),
    ],
  },
  {
    name: 'GOST_GLASS',
    description: '유리(짧은 빗금 묶음)',
    kind: 'other',
    lines: motif([0.5, 0], [0.25, 0.5], [
      [0, 0, 0.125, 0.125],
      [0.0625, 0, 0.1875, 0.125],
      [0.125, 0, 0.25, 0.125],
    ]),
  },
  {
    name: 'GRASS',
    description: '풀밭',
    kind: 'other',
    lines: motif([0.75, 0], [0.375, 0.75], [
      [0, 0, 0, 0.1875],
      [0, 0, 0.125, 0.125],
      [0, 0, -0.125, 0.125],
      [0.5625, 0.375, 0.5625, 0.5],
      [0.5625, 0.375, 0.625, 0.4375],
      [0.5625, 0.375, 0.5, 0.4375],
    ]),
  },
  {
    name: 'GRATE',
    description: '격자 철망',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.03125), fam(90, 0, 0, 0, 0.125)],
  },
  {
    name: 'GRAVEL',
    description: '자갈',
    kind: 'other',
    lines: motif([0.5, 0], [0, 0.5], [
      ...ring(
        [
          [2, 3],
          [8, 1],
          [10, 5],
          [6, 9],
          [2, 7],
        ],
        0.5 / 24,
      ),
      ...ring(
        [
          [14, 2],
          [20, 4],
          [21, 7],
          [18, 10],
          [14, 10],
          [12, 6],
        ],
        0.5 / 24,
      ),
      ...ring(
        [
          [4, 14],
          [8, 12],
          [12, 16],
          [12, 20],
          [9, 21],
          [5, 19],
          [4, 16],
        ],
        0.5 / 24,
      ),
      ...ring(
        [
          [16, 14],
          [20, 14],
          [22, 16],
          [21, 19],
          [17, 21],
          [15, 19],
          [15, 16],
        ],
        0.5 / 24,
      ),
    ]),
  },
  { name: 'HEX', description: '육각형', kind: 'other', lines: hexTiling(0.125) },
  { name: 'HONEY', description: '벌집', kind: 'other', lines: rotate(hexTiling(0.1), 90) },
  {
    name: 'INSUL',
    description: '단열재',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.375), fam(0, 0, 0.125, 0.0625, 0.375, 0.125, -0.125), fam(0, 0, 0.25, 0.0625, 0.375, 0.125, -0.125)],
  },
  { name: 'LINE', description: '가로 평행선', kind: 'other', lines: [fam(0, 0, 0, 0, 0.125)] },
  {
    name: 'MUDST',
    description: '진흙과 모래',
    kind: 'other',
    lines: [fam(0, 0, 0, 0.125, 0.125, 0.25, -0.0625, 0, -0.0625, 0, -0.0625)],
  },
  { name: 'NET', description: '가로세로 격자', kind: 'other', lines: [fam(0, 0, 0, 0, 0.125), fam(90, 0, 0, 0, 0.125)] },
  {
    name: 'NET3',
    description: '세 방향 격자',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.125), fam(60, 0, 0, 0, 0.125), fam(120, 0, 0, 0, 0.125)],
  },
  {
    name: 'PLAST',
    description: '플라스틱',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.25), fam(0, 0, 0.03125, 0, 0.25), fam(0, 0, 0.0625, 0, 0.25)],
  },
  {
    name: 'PLASTI',
    description: '플라스틱(넷 줄)',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.25), fam(0, 0, 0.03125, 0, 0.25), fam(0, 0, 0.0625, 0, 0.25), fam(0, 0, 0.15625, 0, 0.25)],
  },
  {
    name: 'SACNCR',
    description: '콘크리트(빗금과 점)',
    kind: 'other',
    lines: [fam(45, 0, 0, 0, 0.1875), fam(45, ...perp(45, 0.03125), 0.03125, 0.1875, 0, -0.0625)],
  },
  {
    name: 'SQUARE',
    description: '작은 정사각형',
    kind: 'other',
    lines: motif([0.25, 0], [0, 0.25], ring([
      [0, 0],
      [0.125, 0],
      [0.125, 0.125],
      [0, 0.125],
    ])),
  },
  {
    name: 'STARS',
    description: '여섯 꼭지 별',
    kind: 'other',
    lines: (() => {
      const R = 0.1;
      const p = (a: number): Pt => [R * Math.cos(a * DEG), R * Math.sin(a * DEG)];
      return motif(SA, SB, [...ring([p(90), p(210), p(330)]), ...ring([p(270), p(30), p(150)])]);
    })(),
  },
  {
    name: 'STEEL',
    description: '강재',
    kind: 'other',
    lines: [fam(45, 0, 0, 0, 0.25), fam(45, ...perp(45, 0.0625), 0, 0.25)],
  },
  {
    name: 'SWAMP',
    description: '습지',
    kind: 'other',
    lines: motif([0.75, 0], [0.375, 0.5], [
      [-0.1875, 0, 0.1875, 0],
      [0, 0, 0, 0.125],
      [0, 0, 0.075, 0.1],
      [0, 0, -0.075, 0.1],
    ]),
  },
  {
    name: 'TRANS',
    description: '변압기 철심',
    kind: 'other',
    lines: [fam(0, 0, 0, 0, 0.25), fam(0, 0, 0.125, 0.0625, 0.25, 0.125, -0.125)],
  },
  {
    name: 'TRIANG',
    description: '정삼각형',
    kind: 'other',
    lines: motif(TA, TB, ring([
      [0, 0],
      [0.125, 0],
      [0.0625, 0.0625 * SQ3],
    ])),
  },
  {
    name: 'ZIGZAG',
    description: '지그재그',
    kind: 'other',
    lines: motif([0.25, 0], [0, 0.125], [
      [0, 0, 0.125, 0.0625],
      [0.125, 0.0625, 0.25, 0],
    ]),
  },
];

const byName = new Map(PATTERNS.map((p) => [p.name, p]));

/** 이름으로 무늬 찾기(대소문자 무시, AutoCAD식 ",_O"·",_I" 꼬리 무시) */
export function findPattern(name: string): PatternDef | undefined {
  return byName.get(name.toUpperCase().replace(/,_[OI]$/, '').trim());
}
